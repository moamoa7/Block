// ==UserScript==
// @name         Video_Control (v211.7.0)
// @namespace    https://github.com/
// @version      211.7.0
// @description  v211.7.0: CF Turnstile fix + comprehensive perf optimizations & core bug fixes
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
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com') || location.host.includes('hcaptcha.com') || location.host.includes('arkoselabs.com') || location.protocol === 'about:' || location.href === 'about:blank') return;

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

    /* ══ Cloudflare / CAPTCHA interference guard (WeakSet-cached O(1)) ══ */
    const __cfPositive = new WeakSet();
    const __cfNegative = new WeakSet();

    function isCloudflareElement(el) {
      if (!el || el.nodeType !== 1) return false;
      if (__cfPositive.has(el)) return true;
      if (__cfNegative.has(el)) return false;
      let hit = false;
      const tag = el.tagName;
      if (tag === 'IFRAME') {
        const src = el.src || '';
        hit = src.includes('challenges.cloudflare.com') || src.includes('cloudflare.com/cdn-cgi') || src.includes('hcaptcha.com') || src.includes('recaptcha');
      }
      if (!hit) {
        const cls = el.className?.toString?.() || '';
        hit = cls.includes('cf-turnstile') || cls.includes('cf-challenge') || cls.includes('g-recaptcha') || cls.includes('h-captcha');
      }
      if (!hit) {
        hit = !!(el.hasAttribute?.('data-sitekey'));
      }
      if (hit) __cfPositive.add(el); else __cfNegative.add(el);
      return hit;
    }

    function isInsideCloudflareWidget(el) {
      if (!el) return false;
      let node = el;
      for (let d = 0; node && d < 10; d++) {
        if (__cfPositive.has(node)) return true;
        if (isCloudflareElement(node)) return true;
        node = node.parentElement;
      }
      return false;
    }

    /* ══ Global AbortController ══ */
    const __globalHooksAC = new AbortController();
    const __globalSig = __globalHooksAC.signal;

    /* ══ Timer management ══ */
    const _timers = new Map();
    __globalSig.addEventListener('abort', () => {
      for (const [id, t] of _timers) (t === 'T' ? clearTimeout : clearInterval)(id);
      _timers.clear();
    }, { once: true });

    const setTimer = (fn, ms) => {
      if (__globalSig.aborted) return 0;
      const id = setTimeout(() => { _timers.delete(id); fn(); }, ms);
      _timers.set(id, 'T'); return id;
    };
    const clearTimer = id => { if (!id) return; clearTimeout(id); _timers.delete(id); };

    const setRecurring = (fn, ms, { maxErrors = 50, onKill } = {}) => {
      if (__globalSig.aborted) return 0;
      let errs = 0;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _timers.delete(id); return; }
        try { fn(); errs = 0; }
        catch (_) { if (++errs >= maxErrors) { clearInterval(id); _timers.delete(id); onKill?.(); } }
      }, ms);
      _timers.set(id, 'I'); return id;
    };
    const clearRecurring = id => { if (!id) return; clearInterval(id); _timers.delete(id); };

    /* ══ Signal combinators & Event binding (Patch H / #14 Applied) ══ */
    const _combinedSignalCache = new WeakMap();
    const _hasSignalAny = typeof AbortSignal.any === 'function';

    function getCombinedSignal(local) {
      if (!local || local === __globalSig) return __globalSig;
      if (!_hasSignalAny) return __globalSig;
      let cached = _combinedSignalCache.get(local);
      if (cached) return cached;
      cached = AbortSignal.any([local, __globalSig]);
      _combinedSignalCache.set(local, cached);
      return cached;
    }

    const _GLOBAL_OPTS = Object.freeze(
      Array.from({ length: 8 }, (_, idx) => Object.freeze({
        passive: !!(idx & 4), capture: !!(idx & 2), once: !!(idx & 1), signal: __globalSig
      }))
    );

    const _signalOptsCache = new WeakMap();

    function on(target, type, fn, opts) {
      if (!target?.addEventListener || __globalSig.aborted) return;
      if (!opts) { target.addEventListener(type, fn, _GLOBAL_OPTS[0]); return; }
      const sig = getCombinedSignal(opts.signal);
      if (sig.aborted) return;
      const idx = (opts.passive ? 4 : 0) | (opts.capture ? 2 : 0) | (opts.once ? 1 : 0);

      if (sig === __globalSig) {
        target.addEventListener(type, fn, _GLOBAL_OPTS[idx]);
      } else {
        let sigCache = _signalOptsCache.get(sig);
        if (!sigCache) { sigCache = new Array(8); _signalOptsCache.set(sig, sigCache); }
        let cached = sigCache[idx];
        if (!cached) {
          cached = Object.freeze({ passive: !!(idx & 4), capture: !!(idx & 2), once: !!(idx & 1), signal: sig });
          sigCache[idx] = cached;
        }
        target.addEventListener(type, fn, cached);
      }
    }
    const mkOn = tgt => (type, fn, opts) => on(tgt, type, fn, opts);
    const onWin = mkOn(window), onDoc = mkOn(document);

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

    /* ══ Mobile & Browser detection ══ */
    const detectMobile = () => navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_FIREFOX = navigator.userAgent.includes('Firefox');

    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      IS_FIREFOX: IS_FIREFOX,
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ''),
      DEBUG: false
    });
    const VSC_VERSION = '211.7.0';

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

    /* ══ tempToRgbGain ══ */
    const _TEMP_RGB_LUT = (() => {
      const lut = new Array(101);
      for (let i = 0; i <= 100; i++) {
        const temp = i - 50;
        const t = VSC_CLAMP(temp * 0.02, -1, 1);
        if (t > -0.001 && t < 0.001) {
          lut[i] = { rs: 1, gs: 1, bs: 1 };
        } else {
          const r = 1 + 0.14 * t, g = 1 - 0.02 * (t < 0 ? -t : t), b = 1 - 0.14 * t;
          const inv = 1 / Math.max(r, b);
          lut[i] = { rs: r * inv, gs: g * inv, bs: b * inv };
        }
      }
      return lut;
    })();

    function tempToRgbGain(temp) {
      const clamped = VSC_CLAMP(Math.round(Number(temp) || 0), -50, 50);
      return _TEMP_RGB_LUT[clamped + 50];
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

    let _hostBlockedCache = '', _hostBlockedResult = false;
    function isHostBlocked(hostname) {
      if (hostname === _hostBlockedCache) return _hostBlockedResult;
      _hostBlockedCache = hostname;
      if (RATE_BLOCKED_HOST_SET.has(hostname)) return (_hostBlockedResult = true);
      const dot = hostname.indexOf('.');
      if (dot > 0) {
        const parent = hostname.slice(dot + 1);
        if (RATE_BLOCKED_HOST_SET.has(parent)) return (_hostBlockedResult = true);
        const dot2 = parent.indexOf('.');
        if (dot2 > 0 && RATE_BLOCKED_HOST_SET.has(parent.slice(dot2 + 1))) return (_hostBlockedResult = true);
      }
      return (_hostBlockedResult = false);
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

    /* ══ StyleGuard (Patch #4 Applied) ══ */
    function vscSetStyle(el, prop, value, priority = 'important') {
      if (!el?.style) return;
      let managed = el[VSC_MANAGED_PROPS];
      if (!managed) { managed = Object.create(null); el[VSC_MANAGED_PROPS] = managed; }
      if (!(prop in managed)) managed[prop] = el.style.getPropertyValue(prop) || '';
      el.style.setProperty(prop, value, priority);
    }

    // Patch 6 Applied: Removed attributeStyleMap branch, unified CSS setProperty
    function vscApplyFilterStyles(el, filterStr, isZoomed) {
      if (!el?.style) return;
      let managed = el[VSC_MANAGED_PROPS];
      if (!managed) { managed = Object.create(null); el[VSC_MANAGED_PROPS] = managed; }

      const props = ['filter', '-webkit-filter', 'will-change', 'contain', 'background-color', 'backface-visibility', 'transition'];
      const style = el.style;
      for (const p of props) {
        if (!(p in managed)) managed[p] = style.getPropertyValue(p) || '';
      }

      const wc = isZoomed ? 'filter, transform' : 'filter';

      style.setProperty('transition', 'none', 'important');
      style.setProperty('contain', 'content', 'important');
      style.setProperty('will-change', wc, 'important');
      style.setProperty('filter', filterStr, 'important');
      style.setProperty('-webkit-filter', filterStr, 'important');
      style.setProperty('background-color', '#000', 'important');
      style.setProperty('backface-visibility', 'hidden', 'important');
    }

    function vscRemoveStyle(el, prop) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed || !(prop in managed)) return;
      const saved = managed[prop];
      delete managed[prop];
      if (saved) el.style.setProperty(prop, saved);
      else el.style.removeProperty(prop);
    }

    function vscClearAllStyles(el) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed) return;
      const keys = Object.keys(managed);
      if (keys.length === 0) return;

      for (const prop of ['will-change', 'contain']) {
        if (prop in managed) {
          const saved = managed[prop];
          if (saved) el.style.setProperty(prop, saved);
          else el.style.removeProperty(prop);
          delete managed[prop];
        }
      }

      for (const prop in managed) {
        const saved = managed[prop];
        if (saved) el.style.setProperty(prop, saved);
        else el.style.removeProperty(prop);
        delete managed[prop];
      }
    }

    function vscHasManagedStyles(el) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed) return false;
      for (const _ in managed) return true;
      return false;
    }

    /* ══ Video State ══ */
    const mkRateState = () => ({ orig: null, suppressSyncUntil: 0, permanentlyBlocked: false, _rateRetryCount: 0, _totalRetries: 0, _settingRate: false, _lastRateChangeT: 0, _lastRateSetTime: 0 });
    const mkVideoState = () => ({
      visible: false, rect: null, bound: false, audioFailUntil: 0,
      applied: false, desiredRate: undefined, lastFilterUrl: null,
      rectT: 0, rectEpoch: -1, fsPatched: false, _resizeDirty: false,
      _ac: null, _inPiP: false, _pipPending: false, lastCssFilterStr: null, _transitionCleared: false, _lastFilterHash: 0,
      _lastSvgHash: 0, // ✅ 신규: SVG 해시 추적용 변수 추가
      __abCompare: false, __pipOrigComputed: null, __pipHadFilter: false, __pipSavedFilterStr: null,
      rateState: mkRateState(),
      resetTransient() {
        this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
        this.desiredRate = undefined; this._pipPending = false; Object.assign(this.rateState, mkRateState());
      }
    });

    const videoStateMap = new WeakMap();
    const getVState = v => videoStateMap.get(v) ?? (videoStateMap.set(v, mkVideoState()), videoStateMap.get(v));
    const getRateState = v => getVState(v).rateState;

    /* ══ Presets (Patch I / #13 Applied via _PRESET_SHARP_LUT in compose) ══ */
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

    const _PRESET_SHARP_LUT = (() => {
      const lut = {};
      for (const [key, d] of Object.entries(PRESETS.detail)) {
        lut[key] = (d.sharpAdd + d.sharp2Add * 0.6 + d.clarityAdd * 0.4) * 0.01;
      }
      return lut;
    })();

    /* ══ Defaults & Paths ══ */
    const DEFAULTS = {
      video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0 },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false, slots: [null, null, null], gpuEn: false, screenBright: 0, videoRotation: 0, videoFit: 'contain' }
    };
    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll',
      APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', APP_GPU_EN: 'app.gpuEn',
      APP_SCREEN_BRT: 'app.screenBright', APP_VID_ROT: 'app.videoRotation', APP_VID_FIT: 'app.videoFit',
      V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
      V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery',
      V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp',
      A_EN: 'audio.enabled', A_BST: 'audio.boost',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    /* ══ Schemas ══ */
    const APP_SCHEMA = [
      { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_GPU_EN },
      { type: 'num', path: P.APP_VID_ROT, min: 0, max: 270, round: true, fallback: () => 0 },
      { type: 'enum', path: P.APP_VID_FIT, values: ['contain', 'cover', 'fill'], fallback: () => 'contain' }
    ];
    const VIDEO_SCHEMA = [
      { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS },
      { type: 'num', path: P.V_PRE_MIX, min: 0, max: 1, fallback: () => DEFAULTS.video.presetMix },
      { type: 'num', path: P.V_MAN_SHAD, min: 0, max: 100, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_MAN_REC, min: 0, max: 100, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_MAN_BRT, min: 0, max: 100, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_MAN_TEMP, min: -50, max: 50, round: true, fallback: () => 0 }
    ];
    const AUDIO_PLAYBACK_SCHEMA = [
      { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 15, fallback: () => DEFAULTS.audio.boost },
      { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate }
    ];
    const ALL_SCHEMAS = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];

    /* ══ Schema Normalizer ══ */
    function compileSchemaValidators(schema) {
      return schema.map(r => {
        if (r.type === 'bool') {
          return (sm) => {
            const c = sm.get(r.path), nv = !!c;
            if (Object.is(c, nv)) return false;
            sm.set(r.path, nv); return true;
          };
        }
        if (r.type === 'enum') {
          const vals = r.values, fb = r.fallback;
          return (sm) => {
            const c = sm.get(r.path), nv = vals.includes(c) ? c : fb();
            if (Object.is(c, nv)) return false;
            sm.set(r.path, nv); return true;
          };
        }
        const {min, max, round, fallback: fb} = r;
        return (sm) => {
          const c = sm.get(r.path);
          const raw = Number.isFinite(+c) ? +c : fb();
          const clamped = raw < min ? min : (raw > max ? max : raw);
          const nv = round ? Math.round(clamped) : clamped;
          if (Object.is(c, nv)) return false;
          sm.set(r.path, nv); return true;
        };
      });
    }

    const _COMPILED_ALL = compileSchemaValidators(ALL_SCHEMAS);

    function normalizeBySchema(sm, schema) {
      if (schema === ALL_SCHEMAS) {
        let changed = false;
        for (let i = 0, len = _COMPILED_ALL.length; i < len; i++) {
          if (_COMPILED_ALL[i](sm)) changed = true;
        }
        return changed;
      }
      let changed = false;
      for (const r of schema) {
        const cur = sm.get(r.path);
        const nv = r.type === 'bool' ? !!cur
          : r.type === 'enum' ? (r.values.includes(cur) ? cur : r.fallback())
          : (n => { const v = n < r.min ? r.min : (n > r.max ? r.max : n); return r.round ? Math.round(v) : v; })(Number.isFinite(+cur) ? +cur : r.fallback());
        if (!Object.is(cur, nv)) { sm.set(r.path, nv); changed = true; }
      }
      return changed;
    }

    /* ══ attachShadow patch ══ */
    if (FEATURE_FLAGS.trackShadowRoots) {
      __internal._onShadow = null;
      const _origAttach = Element.prototype.attachShadow;
      if (typeof _origAttach === 'function' && !_origAttach[VSC_SYM]) {
        const patchedAttach = function (init) {
          const sr = _origAttach.call(this, init);
          const internalRef = window[VSC_INTERNAL_SYM];
          if (internalRef?._onShadow && !__globalSig.aborted) {
            if (init && init.mode === 'open' && !isInsideCloudflareWidget(this)) queueMicrotask(() => internalRef._onShadow(this, sr));
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

    /* ══ TOUCHED sets & eviction (Patch 5 Applied: GC Compact Fix) ══ */
    function createTrackedSet(maxSize, onEvict) {
      const fastLookup = new WeakSet();
      const refs = [];
      let _compactNeeded = false;
      let _deadCount = 0;

      const registry = new FinalizationRegistry((heldRef) => {
        fastLookup.delete(heldRef);
        _deadCount++;
        if (_deadCount > (refs.length >> 2)) _compactNeeded = true;
      });

      function compactIfNeeded() {
        if (!_compactNeeded) return;
        _compactNeeded = false;
        _deadCount = 0;
        let write = 0;
        for (let i = 0; i < refs.length; i++) {
          const v = refs[i].deref();
          if (v) { refs[write++] = refs[i]; }
        }
        refs.length = write;
      }

      return {
        add(el) {
          if (!el || fastLookup.has(el)) return;

          if (refs.length >= maxSize) {
            compactIfNeeded();
            if (refs.length >= maxSize) {
              let evictIdx = -1;
              for (let i = 0; i < refs.length; i++) {
                const v = refs[i].deref();
                if (!v) { refs.splice(i, 1); i--; continue; }
                if (!v.isConnected || v.ended || (v.paused && !isPiPActiveVideo(v))) {
                  evictIdx = i; break;
                }
              }
              if (evictIdx >= 0) {
                const evicted = refs[evictIdx].deref();
                refs.splice(evictIdx, 1);
                if (evicted) {
                  fastLookup.delete(evicted);
                  registry.unregister(evicted);
                  if (onEvict) queueMicrotask(() => { try { onEvict(evicted); } catch(_) {} });
                }
              }
            }
          }

          fastLookup.add(el);
          const wr = new WeakRef(el);
          refs.push(wr);
          registry.register(el, wr, el);
        },
        has(el) { return fastLookup.has(el); },
        delete(el) {
          if (!fastLookup.has(el)) return false;
          fastLookup.delete(el);
          registry.unregister(el);
          _deadCount++;
          if (_deadCount > (refs.length >> 2)) _compactNeeded = true;
          return true;
        },
        *[Symbol.iterator]() {
          compactIfNeeded();
          for (let i = refs.length - 1; i >= 0; i--) {
            const v = refs[i].deref();
            if (v) yield v;
          }
        },
        get size() { compactIfNeeded(); return refs.length; }
      };
    }

    const TOUCHED = {
      videos: createTrackedSet(CONFIG.TOUCHED_MAX, (evicted) => {
        const vst = videoStateMap.get(evicted);
        if (vst?._ac) { vst._ac.abort(); vst._ac = null; vst.bound = false; }
        vscClearAllStyles(evicted);
        if (vst) {
          vst.applied = false;
          vst.lastFilterUrl = null;
          vst.lastCssFilterStr = null;
          vst._lastFilterHash = 0;
          vst._lastSvgHash = 0;
          vst._transitionCleared = false;
        }
      }),
      rateVideos: createTrackedSet(CONFIG.TOUCHED_MAX)
    };
    function touchedAddLimited(set, el) { set.add(el); }

    /* ══ Rect caching & viewport ══ */
    let __vscRectEpoch = 0, __vscRectEpochQueued = false;
    const __vpSnap = { w: 0, h: 0, cx: 0, cy: 0, _dirty: true };
    const __cachedVV = window.visualViewport || null;
    function bumpRectEpoch() {
      __vpSnap._dirty = true;
      if (__vscRectEpochQueued) return;
      __vscRectEpochQueued = true;
      requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; });
    }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true });
    onWin('resize', bumpRectEpoch, { passive: true });
    onWin('orientationchange', bumpRectEpoch, { passive: true });
    try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', bumpRectEpoch, { passive: true }); on(vv, 'scroll', bumpRectEpoch, { passive: true }); } } catch (_) {}

    let __frameNow = performance.now();
    const _frameNowUpdate = (ts) => { __frameNow = ts; requestAnimationFrame(_frameNowUpdate); };
    requestAnimationFrame(_frameNowUpdate);

    let __adaptiveRectTTL = 350;
    function getRectCached(v, maxAgeMs) {
      const ttl = maxAgeMs ?? __adaptiveRectTTL;
      const st = getVState(v);
      if (st.rect && !st._resizeDirty && st.rectEpoch === __vscRectEpoch) {
        if ((__frameNow - st.rectT) <= ttl) return st.rect;
      }
      st.rect = v.getBoundingClientRect();
      st.rectT = __frameNow;
      st.rectEpoch = __vscRectEpoch;
      st._resizeDirty = false;
      return st.rect;
    }
    function updateAdaptiveRectTTL(motionSAD) {
      __adaptiveRectTTL = motionSAD > 0.06 ? 150 : (motionSAD > 0.02 ? 350 : 700);
    }

    function _refreshVpSnap() { const vv = __cachedVV; if (vv) { __vpSnap.w = vv.width; __vpSnap.h = vv.height; __vpSnap.cx = vv.offsetLeft + vv.width * 0.5; __vpSnap.cy = vv.offsetTop + vv.height * 0.5; } else { __vpSnap.w = innerWidth; __vpSnap.h = innerHeight; __vpSnap.cx = innerWidth * 0.5; __vpSnap.cy = innerHeight * 0.5; } __vpSnap._dirty = false; }
    function getViewportSnapshot() { if (__vpSnap._dirty) _refreshVpSnap(); return __vpSnap; }

    function createDebounced(fn, ms = 250) { let t = 0; return (...args) => { clearTimer(t); t = setTimer(() => fn(...args), ms); }; }

    /* ══ CircularBuffer (Patch G / #8 Applied) ══ */
    class CircularBuffer {
      constructor(maxLen) {
        this._buf = new Float64Array(maxLen);
        this._head = 0;
        this._size = 0;
        this._max = maxLen;
        this._sortCache = new Float64Array(maxLen);
        this._sortDirty = true;
      }
      push(val) {
        this._buf[this._head] = val;
        this._head = (this._head + 1) % this._max;
        if (this._size < this._max) this._size++;
        this._sortDirty = true;
      }
      reduce(fn, init) {
        let acc = init; const start = (this._head - this._size + this._max) % this._max;
        for (let i = 0; i < this._size; i++) acc = fn(acc, this._buf[(start + i) % this._max]);
        return acc;
      }
      get length() { return this._size; }
      toSorted() { return this.getSorted().slice(); }
      getSorted() {
        if (!this._sortDirty) return this._sortCache.subarray(0, this._size);
        const n = this._size, out = this._sortCache;
        const start = (this._head - n + this._max) % this._max;
        for (let i = 0; i < n; i++) out[i] = this._buf[(start + i) % this._max];

        let sorted = true;
        for (let i = 1; i < n; i++) {
          if (out[i] < out[i - 1]) { sorted = false; break; }
        }

        if (!sorted) {
          if (n > 24) {
            out.subarray(0, n).sort();
          } else {
            for (let i = 1; i < n; i++) {
              const key = out[i]; let j = i - 1;
              while (j >= 0 && out[j] > key) { out[j + 1] = out[j]; j--; }
              out[j + 1] = key;
            }
          }
        }
        this._sortDirty = false;
        return out.subarray(0, n);
      }
      clear() { this._head = 0; this._size = 0; this._sortDirty = true; }
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
        if (isCloudflareElement(ifr)) return;
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
            if (n.tagName === 'IFRAME') { if (!isCloudflareElement(n)) inject(n); }
            else if (n.getElementsByTagName) { const iframes = n.getElementsByTagName('iframe'); for (let i = 0; i < iframes.length; i++) { if (!isCloudflareElement(iframes[i])) inject(iframes[i]); } }
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
          log.debug('[FsWrapper] Video in ShadowRoot, skipping wrapper (filter applied via CSS)');
          return null;
        }
      } catch (_) { return null; }

      try {
        const testComment = document.createComment('');
        parent.insertBefore(testComment, video);
        testComment.remove();
      } catch (_) { return null; }

      const wrap = document.createElement('div');
      wrap.className = 'vsc-fs-wrap';
      wrap.style.cssText = 'position:relative;display:inline-block;width:100%;height:100%;max-width:100%;background:black;';

      const nextSibling = video.nextSibling;
      const ph = document.createComment('vsc-video-placeholder');

      const origParent = parent;
      const origNextSibling = nextSibling;

      let step = 0;
      try {
        parent.insertBefore(ph, video); step = 1;
        parent.insertBefore(wrap, ph);  step = 2;
        wrap.appendChild(video);        step = 3;
      } catch (e) {
        log.warn('[FsWrapper] DOM manipulation failed at step', step, e.message);
        switch (step) {
          case 2:
            try { if (wrap.parentNode) wrap.remove(); } catch (_) {}
            try { if (ph.parentNode) ph.remove(); } catch (_) {}
            break;
          case 1:
            try { if (ph.parentNode) ph.remove(); } catch (_) {}
            break;
          case 3:
            try { if (wrap.contains(video)) wrap.removeChild(video); } catch (_) {}
            try {
              if (ph.parentNode === origParent) origParent.insertBefore(video, ph);
              else if (origNextSibling?.parentNode === origParent) origParent.insertBefore(video, origNextSibling);
              else if (origParent.isConnected) origParent.appendChild(video);
            } catch (_) {}
            try { if (wrap.parentNode) wrap.remove(); } catch (_) {}
            try { if (ph.parentNode) ph.remove(); } catch (_) {}
            break;
        }
        if (!video.isConnected) {
          log.error('[FsWrapper] CRITICAL: Video lost from DOM after rollback');
          const lastResort = document.body || document.documentElement;
          if (lastResort) {
            try { lastResort.appendChild(video); log.warn('[FsWrapper] Emergency restored'); }
            catch (_) { log.error('[FsWrapper] Emergency restore also failed'); }
          }
        }
        return null;
      }

      wrap.__vscPlaceholder = ph;
      wrap.__vscOrigNextSibling = nextSibling;
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

    // Bug 5 Applied: Force CSS-only filter path when entering fullscreen from ShadowRoot
    function patchFullscreenRequest(video) {
      const st = getVState(video);
      if (!video || st.fsPatched) return;

      let inShadow = false;
      try { inShadow = video.getRootNode() instanceof ShadowRoot; } catch (_) {}

      if (!inShadow) {
        try {
          const parent = video.parentNode;
          if (!parent || !parent.isConnected) return;
          const testComment = document.createComment('');
          parent.insertBefore(testComment, video);
          testComment.remove();
        } catch (_) { return; }
      }

      st.fsPatched = true;
      const origStd = video.requestFullscreen;
      const origWebkit = video.webkitRequestFullscreen;
      if (!origStd && !origWebkit) return;
      if (origStd) video.__vsc_orig_requestFullscreen = origStd;
      if (origWebkit) video.__vsc_orig_webkitRequestFullscreen = origWebkit;

      const runWrappedFs = function (origFn, ...args) {
        if (inShadow) {
          const result = origFn.apply(video, args);
          const reapply = () => {
            if (!__globalSig.aborted) {
              try { window[VSC_INTERNAL_SYM].ApplyReq?.hard(); } catch (_) {}
            }
          };
          if (result && typeof result.then === 'function') {
            result.then(reapply).catch(() => {});
          } else {
            requestAnimationFrame(reapply);
          }
          return result;
        }
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

    /* ══ onFsChange ══ */
    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl) {
        const cands = [...TOUCHED.videos].filter(v => fsWraps.has(v));
        if (!cands.length) return;
        requestAnimationFrame(() => {
          const cur = document.fullscreenElement || document.webkitFullscreenElement;
          cands.filter(v => v.isConnected && fsWraps.get(v) !== cur).forEach(restoreFromFsWrapper);
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

    async function enterPiP(video) {
      if (!video || !video.isConnected) return false;
      const st = getVState(video); if (st._inPiP) return true;
      if (st._pipPending) return false; st._pipPending = true;
      try {
        if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
          try {
            const rect = video.getBoundingClientRect();
            const pipWin = await window.documentPictureInPicture.requestWindow({ width: Math.max(320, video.clientWidth || rect.width || 640), height: Math.max(180, video.clientHeight || rect.height || 360) });
            __pipOrigParent = video.parentNode; __pipOrigNext = video.nextSibling; __pipOrigCss = video.style.cssText;
            const computedStyle = getComputedStyle(video);
            st.__pipOrigComputed = { width: computedStyle.width, height: computedStyle.height, objectFit: computedStyle.objectFit, objectPosition: computedStyle.objectPosition, maxWidth: computedStyle.maxWidth, maxHeight: computedStyle.maxHeight };
            const ph = document.createElement('div'); ph.style.cssText = `width:${rect.width}px;height:${rect.height}px;background:#000;display:inline-block;`; ph.dataset.vscPipPh = '1'; __pipPlaceholder = ph;
            video.parentNode.insertBefore(ph, video);
            st.__pipHadFilter = st.applied; st.__pipSavedFilterStr = st.lastCssFilterStr;
            if (st.applied) { vscRemoveStyle(video, 'filter'); vscRemoveStyle(video, '-webkit-filter'); vscRemoveStyle(video, 'will-change'); vscRemoveStyle(video, 'contain'); vscRemoveStyle(video, 'backface-visibility'); vscRemoveStyle(video, 'background-color'); vscRemoveStyle(video, 'transition'); st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false; st._lastFilterHash = 0; }
            pipWin.document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden;'; pipWin.document.body.appendChild(video); video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
            void video.offsetHeight;
            if (video.paused && video.readyState >= 2) { try { const currentTime = video.currentTime; video.currentTime = currentTime + 0.001; await new Promise(r => setTimeout(r, 50)); video.currentTime = currentTime; } catch (_) {} }
            __activeDocumentPiPWindow = pipWin; __activeDocumentPiPVideo = video; st._inPiP = true;
            pipWin.addEventListener('pagehide', () => { exitPiP(video); }, { once: true }); pipWin.addEventListener('unload', () => { if (__activeDocumentPiPWindow === pipWin) exitPiP(video); }, { once: true });
            return true;
          } catch (e) { log.debug('Document PiP failed, falling back:', e.message); }
        }
        if (typeof video.requestPictureInPicture === 'function') {
          try {
            await video.requestPictureInPicture(); st._inPiP = true;
            const onLeavePiP = () => { st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; try { __internal.ApplyReq?.hard(); } catch (_) {} };
            video.addEventListener('leavepictureinpicture', onLeavePiP, { once: true, signal: st._ac?.signal || __globalSig }); return true;
          } catch (e) { log.debug('Native PiP failed:', e.message); }
        }
        return false;
      } finally {
        st._pipPending = false;
      }
    }

    let __pipExitPromise = null;

    // Bug 2 Applied: Safe DOM restore logic to prevent video loss
    async function exitPiP(video) {
      if (__pipExitPromise) {
        try { await __pipExitPromise; } catch (_) {}
        if (!video) return;
        const st = getVState(video);
        if (!st._inPiP) return;
        if (!video.isConnected) {
          const fb = document.body || document.documentElement;
          if (fb) try { fb.appendChild(video); } catch (_) {}
          st._inPiP = false; st.applied = false;
          try { __internal.ApplyReq?.hard(); } catch (_) {}
        }
        return;
      }

      let resolve;
      __pipExitPromise = new Promise(r => { resolve = r; });

      try {
        if (!video) { resetPiPState(); return; }

        const st = getVState(video);
        const snapPipWin = __activeDocumentPiPWindow;
        const snapOrigParent = __pipOrigParent;
        const snapOrigNext = __pipOrigNext;
        const snapPlaceholder = __pipPlaceholder;
        const snapOrigCss = __pipOrigCss;
        const savedComputed = st.__pipOrigComputed;

        if (!snapPipWin && !snapOrigParent && st._inPiP) {
          log.warn('[PiP] State references lost, emergency restore');
          if (!video.isConnected) {
            const fb = document.body || document.documentElement;
            if (fb) try { fb.appendChild(video); } catch (_) {}
          }
          st._inPiP = false; st.applied = false; resetPiPState();
          try { __internal.ApplyReq?.hard(); } catch (_) {}
          return;
        }

        if (snapPipWin && !snapPipWin.closed) {
          try {
            const pipDoc = snapPipWin.document;
            let restored = false;

            if (snapOrigParent?.isConnected) {
              try {
                if (snapPlaceholder?.parentNode === snapOrigParent) {
                  snapOrigParent.insertBefore(video, snapPlaceholder);
                  snapPlaceholder.remove(); restored = true;
                } else if (snapOrigNext?.parentNode === snapOrigParent) {
                  snapOrigParent.insertBefore(video, snapOrigNext); restored = true;
                } else {
                  snapOrigParent.appendChild(video); restored = true;
                }
              } catch (domErr) {
                log.warn('[PiP] DOM restore failed:', domErr.message);
                restored = false;
              }
            }

            if (!restored) {
              try {
                if (video.parentNode && video.ownerDocument !== document) {
                  video.parentNode.removeChild(video);
                }
              } catch (_) {}
              if (!video.isConnected) {
                const fallback = document.body || document.documentElement;
                if (fallback) {
                  try {
                    fallback.appendChild(video);
                    log.warn('[PiP] Video restored to body as fallback');
                    restored = true;
                  } catch (_) {
                    log.error('[PiP] CRITICAL: Cannot restore video to any DOM location');
                  }
                }
              }
            }

            if (snapPlaceholder?.parentNode) try { snapPlaceholder.remove(); } catch (_) {}
            if (snapOrigCss !== undefined) video.style.cssText = snapOrigCss;
            void video.offsetHeight;

            if (video.readyState >= 2) {
              if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => {});
              try { const ct = video.currentTime; if (ct > 0.01) { video.currentTime = ct - 0.001; setTimeout(() => { if (video.isConnected && Math.abs(video.currentTime - (ct - 0.001)) < 0.01) video.currentTime = ct; }, 100); } } catch (_) {}
            }
            cleanupPipDocumentSvg(pipDoc); snapPipWin.close();
          } catch (e) { log.warn('PiP exit error:', e); try { snapPipWin.close(); } catch (_) {} }

          resetPiPState();

          if (st) {
            st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false; st._lastFilterHash = 0; st.__pipOrigComputed = null; st.__pipHadFilter = false; st.__pipSavedFilterStr = null;
            if (savedComputed && video.isConnected) {
              requestAnimationFrame(() => {
                try {
                  const current = getComputedStyle(video);
                  if (parseInt(current.width) < 10 || parseInt(current.height) < 10) {
                    if (savedComputed.width) video.style.setProperty('width', savedComputed.width);
                    if (savedComputed.height) video.style.setProperty('height', savedComputed.height);
                  }
                } catch (_) {}
              });
            }
          }
          try { __internal.ApplyReq?.hard(); } catch (_) {}
          return;
        }

        if (document.pictureInPictureElement === video) { try { await document.exitPictureInPicture(); } catch (_) {} }
        if (st) { st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._lastFilterHash = 0; }
        try { __internal.ApplyReq?.hard(); } catch (_) {}
      } finally {
        __pipExitPromise = null;
        resolve();
      }
    }

    setRecurring(() => {
      if (__activeDocumentPiPWindow) {
        if (__activeDocumentPiPWindow.closed) {
          const video = __activeDocumentPiPVideo;
          if (video) exitPiP(video);
          else resetPiPState();
        } else if (__activeDocumentPiPVideo && !__activeDocumentPiPVideo.isConnected) {
          try { __activeDocumentPiPWindow.close(); } catch (_) {}
          resetPiPState();
        }
      }
    }, 2000);

    async function togglePiPFor(video) {
      if (!video) return; const st = getVState(video);
      const isActive = st._inPiP || document.pictureInPictureElement === video || (__activeDocumentPiPVideo === video && __activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed);
      if (isActive) await exitPiP(video); else await enterPiP(video);
    }

    /* ══ Video Transform ══ */
    const VID_FIT_MODES = ['contain', 'cover', 'fill'];
    const VID_FIT_LABELS = { contain: 'Fit (기본)', cover: 'Fill (채움)', fill: 'Stretch (늘림)' };

    function buildCombinedTransform(video, store) {
      const zoomSt = window[VSC_INTERNAL_SYM]?.ZoomManager;
      const rotation = Number(store.get(P.APP_VID_ROT)) || 0;

      let scale = 1, tx = 0, ty = 0;
      if (zoomSt) {
        const zs = zoomSt._getState?.(video);
        if (zs && zs.scale > 1) { scale = zs.scale; tx = zs.tx; ty = zs.ty; }
      }

      if (scale <= 1 && rotation === 0) return '';
      if (scale <= 1) return `rotate(${rotation}deg)`;
      if (rotation === 0) return `scale(${scale}) translate(${tx}px,${ty}px)`;

      const rad = rotation * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const rtx = cos * tx + sin * ty;
      const rty = -sin * tx + cos * ty;
      return `scale(${scale}) translate(${rtx.toFixed(2)}px,${rty.toFixed(2)}px) rotate(${rotation}deg)`;
    }

    function applyVideoTransform(video, store) {
      if (!video?.isConnected) return;
      const fitMode = store.get(P.APP_VID_FIT) || 'contain';

      if (fitMode !== 'contain') vscSetStyle(video, 'object-fit', fitMode, 'important');
      else vscRemoveStyle(video, 'object-fit');

      const combined = buildCombinedTransform(video, store);
      if (combined) {
        vscSetStyle(video, 'transform', combined, 'important');
        vscSetStyle(video, 'transform-origin', 'center center', 'important');
      } else {
        vscRemoveStyle(video, 'transform');
        vscRemoveStyle(video, 'transform-origin');
      }
    }

    function clearVideoTransform(video) {
      if (!video) return;
      vscRemoveStyle(video, 'object-fit');
      vscRemoveStyle(video, 'transform');
      vscRemoveStyle(video, 'transform-origin');
    }

    function cycleVideoFit(store) {
      const cur = store.get(P.APP_VID_FIT) || 'contain';
      const idx = VID_FIT_MODES.indexOf(cur);
      const next = VID_FIT_MODES[(idx + 1) % VID_FIT_MODES.length];
      store.set(P.APP_VID_FIT, next);
      const v = window[VSC_INTERNAL_SYM]?._activeVideo;
      if (v) applyVideoTransform(v, store);
      showOSD(`화면 비율: ${VID_FIT_LABELS[next]}`, 1000);
      persistNow();
    }

    function rotateVideo90(store) {
      const cur = Number(store.get(P.APP_VID_ROT)) || 0;
      const next = (cur + 90) % 360;
      store.set(P.APP_VID_ROT, next);
      const v = window[VSC_INTERNAL_SYM]?._activeVideo;
      if (v) applyVideoTransform(v, store);
      showOSD(`회전: ${next}°`, 1000);
      persistNow();
    }

    function resetVideoTransform(store) {
      store.set(P.APP_VID_ROT, 0);
      store.set(P.APP_VID_FIT, 'contain');
      const v = window[VSC_INTERNAL_SYM]?._activeVideo;
      if (v) clearVideoTransform(v);
      showOSD('비디오 변환 초기화', 1000);
      persistNow();
    }

    /* ══ captureVideoFrame ══ */
    function captureVideoFrame(video) {
      if (!video || video.readyState < 2) { showOSD('비디오 준비 안됨', 1000); return; }
      try {
        const w = video.videoWidth, h = video.videoHeight;
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
        if (c.width !== w) c.width = w; if (c.height !== h) c.height = h;
        const ctx = c.getContext('2d', { alpha: false, desynchronized: true });

        const triggerDownload = async (canvas) => {
          try {
            const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(r => canvas.toBlob(r, 'image/png'));
            if (!blob) { showOSD('캡처 실패', 1000); return; }
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `vsc-capture-${Date.now()}.png`; document.body.appendChild(a); a.click(); a.remove();
            setTimer(() => URL.revokeObjectURL(url), 3000); showOSD('프레임 저장됨', 1200);
          } catch (e) { showOSD('캡처 저장 실패', 1000); }
        };

        if (typeof VideoFrame === 'function') {
          let frame;
          try {
            frame = new VideoFrame(video, { timestamp: (video.currentTime * 1e6) | 0 });
            ctx.drawImage(frame, 0, 0, w, h);
            triggerDownload(c);
            return;
          } catch (_) {
          } finally {
            frame?.close();
          }
        }
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(video).then(bmp => { ctx.drawImage(bmp, 0, 0, w, h); bmp.close(); triggerDownload(c); }).catch(() => { ctx.drawImage(video, 0, 0, w, h); triggerDownload(c); });
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        triggerDownload(c);
      } catch (_) { showOSD('캡처 실패 (DRM?)', 1500); }
    }

    /* ══════════════════════════════════════════════════════════════════
       createZoomManager
       ══════════════════════════════════════════════════════════════════ */
    function createZoomManager() {
      const zoomStates = new WeakMap();
      const zoomedVideos = new Set();
      let activeVideo = null, activePointerId = null;
      let startX = 0, startY = 0;
      const pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0, elemCx: 0, elemCy: 0 };
      let rafId = null, destroyed = false;
      const pendingUpdates = new Set();
      const ZOOM_PROPS = ['transform', 'transform-origin', 'will-change', 'z-index', 'position', 'contain', 'isolation'];

      const TS = Object.freeze({ IDLE: 0, WAIT_PAN: 1, PANNING: 2, PINCHING: 3, PINCH_RELEASED: 4 });
      let touchState = TS.IDLE;
      let settleTimerId = 0;
      const TOUCH_SETTLE_MS = 120;
      const PAN_THRESHOLD_PX = 8;
      const PAN_THRESHOLD_SQ = PAN_THRESHOLD_PX * PAN_THRESHOLD_PX;
      let touchOriginX = 0, touchOriginY = 0;

      function setTouchState(next) { touchState = next; }
      function startSettleTimer(cb) { clearSettleTimer(); settleTimerId = setTimer(() => { settleTimerId = 0; cb(); }, TOUCH_SETTLE_MS); }
      function clearSettleTimer() { if (settleTimerId) { clearTimer(settleTimerId); settleTimerId = 0; } }

      const _savedTouchActions = new WeakMap();

      function walkParents(el, maxDepth, fn) {
        let p = el.parentElement, d = 0;
        while (p && p !== document.body && p !== document.documentElement && d < maxDepth) {
          fn(p, d); p = p.parentElement; d++;
        }
      }

      function setTouchActionBlocking(v, enable) {
        if (!v) return;
        if (enable) {
          if (!_savedTouchActions.has(v)) _savedTouchActions.set(v, v.style.getPropertyValue('touch-action'));
          vscSetStyle(v, 'touch-action', 'none', 'important');
          vscSetStyle(v, '-webkit-tap-highlight-color', 'transparent', 'important');
          __touchBlocked.add(v);
          walkParents(v, 3, p => {
            if (!_savedTouchActions.has(p)) _savedTouchActions.set(p, p.style.getPropertyValue('touch-action'));
            vscSetStyle(p, 'touch-action', 'none', 'important');
            vscSetStyle(p, '-webkit-tap-highlight-color', 'transparent', 'important');
            p.dataset.vscTouchBlocked = '1';
          });
        } else {
          restoreTouchAction(v); __touchBlocked.delete(v);
          walkParents(v, 3, p => {
            if (p.dataset?.vscTouchBlocked) { restoreTouchAction(p); delete p.dataset.vscTouchBlocked; }
          });
        }
      }

      function restoreTouchAction(el) {
        if (!el) return;
        const saved = _savedTouchActions.get(el);
        if (saved !== undefined) { if (saved) el.style.setProperty('touch-action', saved); else el.style.removeProperty('touch-action'); _savedTouchActions.delete(el); }
        else el.style.removeProperty('touch-action');
        el.style.removeProperty('-webkit-tap-highlight-color');
      }

      function cleanupAllTouchBlocking() {
        try {
          for (const el of document.querySelectorAll('[data-vsc-touch-blocked]')) { restoreTouchAction(el); delete el.dataset.vscTouchBlocked; }
          const allVideos = new Set([...document.querySelectorAll('video'), ...TOUCHED.videos]);
          for (const v of allVideos) { if (!v?.isConnected) continue; restoreTouchAction(v); vscRemoveStyle(v, 'isolation'); __touchBlocked.delete(v); }
        } catch (_) {}
      }

      const isZoomEnabled = () => !!window[VSC_INTERNAL_SYM]?.Store?.get(P.APP_ZOOM_EN);

      function getSt(v) {
        let s = zoomStates.get(v);
        if (!s) { s = { scale: 1, tx: 0, ty: 0, zoomed: false, hasPanned: false, _savedPosition: '', _savedZIndex: '' }; zoomStates.set(v, s); }
        return s;
      }

      function clampPan(v, st) {
        try {
          const r = v.getBoundingClientRect();
          const maxTx = Math.max(0, (r.width * st.scale - r.width) / 2 / st.scale);
          const maxTy = Math.max(0, (r.height * st.scale - r.height) / 2 / st.scale);
          st.tx = VSC_CLAMP(st.tx, -maxTx, maxTx); st.ty = VSC_CLAMP(st.ty, -maxTy, maxTy);
        } catch (_) {}
      }

      function update(v) {
        if (destroyed) return; pendingUpdates.add(v);
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          for (const vid of pendingUpdates) {
            if (!vid.isConnected) continue;
            const st = getSt(vid);
            if (st.scale <= 1 && st.zoomed) { resetZoom(vid); continue; }
            if (st.scale > 1) {
              const store = window[VSC_INTERNAL_SYM]?.Store;
              if (store) {
                applyVideoTransform(vid, store);
              } else {
                vscSetStyle(vid, 'transform', `scale(${st.scale}) translate(${st.tx}px,${st.ty}px)`, 'important');
                vscSetStyle(vid, 'transform-origin', 'center center', 'important');
              }
              if (!st.zoomed) {
                st._savedPosition = vid.style.getPropertyValue('position'); st._savedZIndex = vid.style.getPropertyValue('z-index');
                vscSetStyle(vid, 'position', 'relative', 'important'); vscSetStyle(vid, 'z-index', '999999', 'important');
                st.zoomed = true; zoomedVideos.add(vid);
              }
              const wc = getVState(vid).applied ? 'filter, transform' : 'transform';
              vscSetStyle(vid, 'will-change', wc, 'important');
            }
          }
          pendingUpdates.clear();
        });
      }

      function zoomTo(v, scale) { const st = getSt(v); st.scale = scale; clampPan(v, st); update(v); }

      function resetZoom(v) {
        const st = getSt(v);
        for (const prop of ZOOM_PROPS) vscRemoveStyle(v, prop);
        vscRemoveStyle(v, 'will-change'); vscRemoveStyle(v, 'contain'); vscRemoveStyle(v, 'isolation'); vscRemoveStyle(v, '-webkit-tap-highlight-color');
        if (st._savedPosition) v.style.setProperty('position', st._savedPosition); else vscRemoveStyle(v, 'position');
        if (st._savedZIndex) v.style.setProperty('z-index', st._savedZIndex); else vscRemoveStyle(v, 'z-index');
        st.scale = 1; st.tx = 0; st.ty = 0; st.zoomed = false; st.hasPanned = false; st._savedPosition = ''; st._savedZIndex = '';
        zoomedVideos.delete(v); __touchBlocked.delete(v); restoreTouchAction(v); void v.offsetHeight;
        requestAnimationFrame(() => walkParents(v, 3, p => {
          if (p.dataset?.vscTouchBlocked) { restoreTouchAction(p); delete p.dataset.vscTouchBlocked; }
        }));
        if (activeVideo === v) { setTouchState(TS.IDLE); clearSettleTimer(); activeVideo = null; }
      }

      function isZoomed(v) { return !!(zoomStates.get(v)?.zoomed); }

      function isVscUiEvent(e) {
        try { const path = e.composedPath?.() || []; for (let i = 0, len = Math.min(path.length, 8); i < len; i++) { const n = path[i]; if (n?.hasAttribute?.('data-vsc-ui') || n?.id === 'vsc-host' || n?.id === 'vsc-gear-host') return true; } } catch (_) {}
        return false;
      }

      function getTargetVideo(e) {
        const points = [];
        if (e.touches && e.touches.length > 0) { for (let i = 0; i < e.touches.length; i++) points.push({ x: e.touches[i].clientX, y: e.touches[i].clientY }); }
        else if (typeof e.clientX === 'number') points.push({ x: e.clientX, y: e.clientY });
        if (points.length > 0) {
          const px = points[0].x, py = points[0].y; let bestVideo = null, bestArea = 0;
          for (const v of TOUCHED.videos) {
            if (!v?.isConnected) continue;
            try { const r = v.getBoundingClientRect(); if (r.width < 10 || r.height < 10) continue; if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) { const area = r.width * r.height; if (area > bestArea) { bestArea = area; bestVideo = v; } } } catch (_) {}
          }
          if (bestVideo) return bestVideo;
        }
        for (const pt of points) {
          try {
            const els = document.elementsFromPoint(pt.x, pt.y);
            for (const el of els) { if (el?.tagName === 'VIDEO') return el; }
            for (const el of els) {
              if (!el || el.nodeType !== 1) continue;
              const vid = el.querySelector?.('video'); if (vid) return vid;
              if (el.shadowRoot) { const svid = el.shadowRoot.querySelector('video'); if (svid) return svid; }
              const ct = el.closest?.('[class*="player"],[class*="video"],[data-player],[data-testid*="video"]');
              if (ct) { const v2 = ct.querySelector('video'); if (v2) return v2; if (ct.shadowRoot) { const sv2 = ct.shadowRoot.querySelector('video'); if (sv2) return sv2; } }
            }
          } catch (_) {}
        }
        const active = window[VSC_INTERNAL_SYM]?._activeVideo; if (active?.isConnected) return active;
        return null;
      }

      function getTouchDist(ts) { const dx = ts[0].clientX - ts[1].clientX; const dy = ts[0].clientY - ts[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
      function getTouchCenter(ts) { return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 }; }

      const __touchBlocked = new WeakSet();
      let __zoomModeWatcherUnsub = null;
      function watchZoomModeToggle() {
        const store = window[VSC_INTERNAL_SYM]?.Store;
        if (!store || __zoomModeWatcherUnsub) return;
        __zoomModeWatcherUnsub = store.sub(P.APP_ZOOM_EN, (enabled) => {
          if (enabled) { for (const v of TOUCHED.videos) { if (v?.isConnected) setTouchActionBlocking(v, true); } }
          else {
            for (const v of [...zoomedVideos]) { resetZoom(v); setTouchActionBlocking(v, false); }
            cleanupAllTouchBlocking(); activeVideo = null; setTouchState(TS.IDLE); clearSettleTimer(); pinchState.active = false; activePointerId = null;
          }
        });
      }

      const __tryWatchInterval = setRecurring(() => { if (window[VSC_INTERNAL_SYM]?.Store) { watchZoomModeToggle(); clearRecurring(__tryWatchInterval); } }, 200);
      function onNewVideoForZoom(v) { if (!v || !isZoomEnabled()) return; if (!__touchBlocked.has(v)) setTouchActionBlocking(v, true); }

      /* Mouse wheel zoom */
      onWin('wheel', e => {
        if (!e.altKey || !isZoomEnabled()) return; if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v); const newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale);
      }, { passive: false, capture: true });

      /* Mouse pointer pan */
      let isPanning = false;
      onWin('pointerdown', e => {
        if (!e.altKey || !isZoomEnabled() || e.pointerType === 'touch') return; if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        const st = getSt(v); if (st.scale <= 1) return;
        e.preventDefault(); e.stopPropagation();
        activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false;
        startX = e.clientX - st.tx; startY = e.clientY - st.ty;
        try { v.setPointerCapture?.(e.pointerId); } catch (_) {} update(v);
      }, { capture: true, passive: false });

      onWin('pointermove', e => {
        if (!isPanning || !activeVideo || e.pointerId !== activePointerId) return;
        if (!activeVideo.isConnected) { isPanning = false; try { activeVideo.releasePointerCapture?.(e.pointerId); } catch (_) {} activePointerId = null; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
        const nextTx = e.clientX - startX, nextTy = e.clientY - startY;
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

      /* Double-click zoom toggle */
      onWin('dblclick', e => {
        if (!e.altKey || !isZoomEnabled()) return; if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5); else resetZoom(v);
      }, { capture: true });

      /* Touch state machine */
      onWin('touchstart', e => {
        if (!isZoomEnabled() || isVscUiEvent(e)) return;
        if (e.touches.length === 2) {
          clearSettleTimer(); const v = getTargetVideo(e); isPanning = false;
          if (e.cancelable) e.preventDefault();
          if (!v) { setTouchState(TS.IDLE); pinchState.active = false; activeVideo = null; return; }
          setTouchActionBlocking(v, true); activeVideo = v; pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = getSt(v).scale;
          const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;

          const _st = getSt(v);
          const _rect = v.getBoundingClientRect();
          pinchState.elemCx = _rect.left + _rect.width / 2 - _st.scale * _st.tx;
          pinchState.elemCy = _rect.top + _rect.height / 2 - _st.scale * _st.ty;
          setTouchState(TS.PINCHING);
        } else if (e.touches.length === 1) {
          clearSettleTimer(); const v = getTargetVideo(e); if (!v) return;
          const st = getSt(v);
          if (st.scale > 1) {
            if (e.cancelable) e.preventDefault();
            activeVideo = v; st.hasPanned = false;
            touchOriginX = e.touches[0].clientX; touchOriginY = e.touches[0].clientY;
            startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
            setTouchState(TS.WAIT_PAN);
          }
        }
      }, { passive: false, capture: true });

      onWin('touchmove', e => {
        if (touchState !== TS.PINCHING && !pinchState.active && e.touches.length === 2 && isZoomEnabled()) {
          clearSettleTimer(); if (e.cancelable) e.preventDefault();
          const v = getTargetVideo(e);
          if (v) {
            setTouchActionBlocking(v, true); activeVideo = v; pinchState.active = true;
            pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = getSt(v).scale;
            const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;

            const _st = getSt(v);
            const _rect = v.getBoundingClientRect();
            pinchState.elemCx = _rect.left + _rect.width / 2 - _st.scale * _st.tx;
            pinchState.elemCy = _rect.top + _rect.height / 2 - _st.scale * _st.ty;
            setTouchState(TS.PINCHING);
          }
          return;
        }
        if (!activeVideo) return;
        const st = getSt(activeVideo);
        if (touchState === TS.PINCHING && pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches); const center = getTouchCenter(e.touches);
          let ns = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); ns = Math.min(Math.max(1, ns), 10);
          if (ns < 1.05) {
            const st = getSt(activeVideo);

            if (st.zoomed) {
              resetZoom(activeVideo);
              showOSD('줌 1× (핀치로 다시 확대)', 800);
            }

            pinchState.initialDist = getTouchDist(e.touches);
            pinchState.initialScale = 1.0;
            st.scale = 1;
            st.tx = 0;
            st.ty = 0;
          } else {
            const prevScale = st.scale;
            const Cx = pinchState.elemCx, Cy = pinchState.elemCy;
            st.tx = (center.x - Cx) / ns - (pinchState.lastCx - Cx) / prevScale + st.tx;
            st.ty = (center.y - Cy) / ns - (pinchState.lastCy - Cy) / prevScale + st.ty;
            st.scale = ns;
            clampPan(activeVideo, st);
            if (!st.zoomed) {
              st._savedPosition = activeVideo.style.getPropertyValue('position');
              st._savedZIndex = activeVideo.style.getPropertyValue('z-index');
              vscSetStyle(activeVideo, 'position', 'relative', 'important');
              vscSetStyle(activeVideo, 'z-index', '999999', 'important');
              st.zoomed = true; zoomedVideos.add(activeVideo);
            }
            update(activeVideo);
          }
          pinchState.lastCx = center.x; pinchState.lastCy = center.y; return;
        }
        /* Normal Pan */
        if (touchState === TS.WAIT_PAN && e.touches.length === 1 && st.scale > 1) {
          const dx = e.touches[0].clientX - touchOriginX; const dy = e.touches[0].clientY - touchOriginY;
          if (dx * dx + dy * dy >= PAN_THRESHOLD_SQ) { if (e.cancelable) e.preventDefault(); isPanning = true; setTouchState(TS.PANNING); } else return;
        }
        if (touchState === TS.PANNING && isPanning && e.touches.length === 1 && st.scale > 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0]; const nextTx = t.clientX - startX, nextTy = t.clientY - startY;
          if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
          st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo);
        }
      }, { passive: false, capture: true });

      onWin('touchend', e => {
        if (!activeVideo) return;
        if (touchState === TS.PINCHING && e.touches.length < 2) {
          pinchState.active = false;
          setTouchState(TS.PINCH_RELEASED);

          const currentScale = activeVideo ? getSt(activeVideo).scale : 1;

          if (e.touches.length === 1 && activeVideo?.isConnected && currentScale > 1) {
            startSettleTimer(() => setTouchState(TS.IDLE));
          } else if (e.touches.length === 0) {
            startSettleTimer(() => {
              setTouchState(TS.IDLE);
              const v = activeVideo;
              isPanning = false;
              if (v && getSt(v).scale <= 1 && getSt(v).zoomed) {
                resetZoom(v);
              } else if (v) {
                update(v);
              }
              activeVideo = null;
            });
          }
          return;
        }
        if (touchState === TS.PINCH_RELEASED || touchState === TS.IDLE) {
          if (e.touches.length === 0) { clearSettleTimer(); const v = activeVideo; isPanning = false; setTouchState(TS.IDLE); update(v); activeVideo = null; }
          return;
        }
        if (e.touches.length === 1 && activeVideo?.isConnected && getSt(activeVideo).scale > 1) {
          const st = getSt(activeVideo); st.hasPanned = false;
          touchOriginX = e.touches[0].clientX; touchOriginY = e.touches[0].clientY;
          startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
          setTouchState(TS.WAIT_PAN);
        } else if (e.touches.length === 0) {
          clearSettleTimer(); const v = activeVideo; isPanning = false; setTouchState(TS.IDLE); update(v); activeVideo = null;
        }
      }, { passive: false, capture: true });

      onWin('touchcancel', () => {
        if (!activeVideo) return; clearSettleTimer();
        const v = activeVideo; isPanning = false; pinchState.active = false; setTouchState(TS.IDLE); activeVideo = null; update(v);
      }, { passive: true, capture: true });

      return Object.freeze({
        resetZoom(v) { resetZoom(v); if (!isZoomEnabled()) setTouchActionBlocking(v, false); },
        zoomTo, isZoomed, onNewVideoForZoom, _getState: getSt,
        pruneDisconnected() { for (const v of [...zoomedVideos]) { if (!v?.isConnected) { resetZoom(v); setTouchActionBlocking(v, false); } } },
        destroy() {
          destroyed = true; clearSettleTimer();
          if (rafId != null && rafId !== -1) { cancelAnimationFrame(rafId); rafId = null; }
          pendingUpdates.clear();
          for (const v of [...zoomedVideos]) { const st = getSt(v); if (st.zoomed) { for (const prop of ZOOM_PROPS) vscRemoveStyle(v, prop); } st.scale = 1; st.zoomed = false; setTouchActionBlocking(v, false); }
          zoomedVideos.clear(); isPanning = false; pinchState.active = false; setTouchState(TS.IDLE);
          activeVideo = null; activePointerId = null; cleanupAllTouchBlocking();
          if (__zoomModeWatcherUnsub) { __zoomModeWatcherUnsub(); __zoomModeWatcherUnsub = null; }
          try { clearRecurring(__tryWatchInterval); } catch (_) {}
        }
      });
    }

    /* ══ VSC v211 Optimization Helpers ══ */
    function createDOMBatcher() {
      let _reads=[],_writes=[],_scheduled=false;
      function flush(){_scheduled=false;const reads=_reads.splice(0);for(let i=0;i<reads.length;i++)reads[i]();const writes=_writes.splice(0);for(let i=0;i<writes.length;i++)writes[i]();}
      function schedule(){if(!_scheduled){_scheduled=true;requestAnimationFrame(flush);}}
      return{read(fn){_reads.push(fn);schedule();},write(fn){_writes.push(fn);schedule();},immediate(fn){fn();}};
    }
    const domBatcher = createDOMBatcher();

    function createSparkline(width=280,height=40,maxPoints=120) {
      const dpr = Math.min(window.devicePixelRatio||1,2), canvas=document.createElement('canvas');
      canvas.className='sparkline-canvas'; canvas.width=width*dpr; canvas.height=height*dpr;
      canvas.style.width=`${width}px`; canvas.style.height=`${height}px`;
      const ctx=canvas.getContext('2d',{alpha:true,desynchronized:true}); ctx.scale(dpr,dpr);
      const data=new Float32Array(maxPoints); let head=0,count=0,_rafId=0,_dirty=false;
      const grad=ctx.createLinearGradient(0,0,0,height), strokeGrad=ctx.createLinearGradient(0,0,width,0);
      grad.addColorStop(0,'rgba(0, 229, 255, 0.25)'); grad.addColorStop(1,'rgba(0, 229, 255, 0.00)');
      strokeGrad.addColorStop(0,'rgba(0, 229, 255, 0.2)'); strokeGrad.addColorStop(0.5,'rgba(0, 229, 255, 0.8)'); strokeGrad.addColorStop(1,'rgba(0, 229, 255, 1.0)');
      function push(value){data[head]=value;head=(head+1)%maxPoints;if(count<maxPoints)count++;if(!_dirty){_dirty=true;_rafId=requestAnimationFrame(render);}}
      function render(){
        _dirty=false; if(count<2)return; ctx.clearRect(0,0,width,height);
        let min=Infinity,max=-Infinity; const start=(head-count+maxPoints)%maxPoints;
        for(let i=0;i<count;i++){const v=data[(start+i)%maxPoints]; if(v<min)min=v; if(v>max)max=v;}
        const range=max-min||1,padTop=4,padBot=4,drawH=height-padTop-padBot; ctx.beginPath();
        for(let i=0;i<count;i++){const v=data[(start+i)%maxPoints],x=(i/(count-1))*width,y=padTop+drawH*(1-(v-min)/range); if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
        ctx.strokeStyle=strokeGrad; ctx.lineWidth=1.5; ctx.lineJoin='round'; ctx.stroke();
        ctx.lineTo(width,height); ctx.lineTo(0,height); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
        const lastV=data[(head-1+maxPoints)%maxPoints],lastY=padTop+drawH*(1-(lastV-min)/range);
        ctx.beginPath(); ctx.arc(width-1,lastY,3,0,Math.PI*2); ctx.fillStyle='#00e5ff'; ctx.fill();
        ctx.beginPath(); ctx.arc(width-1,lastY,6,0,Math.PI*2); ctx.fillStyle='rgba(0, 229, 255, 0.15)'; ctx.fill();
      }
      return{canvas,push,destroy(){if(_rafId)cancelAnimationFrame(_rafId);}};
    }

    function createVisibilityGate() {
      let _paused=false,_pendingCallbacks=[];
      document.addEventListener('visibilitychange',()=>{_paused=document.hidden;if(!_paused&&_pendingCallbacks.length>0){const cbs=_pendingCallbacks.splice(0);requestAnimationFrame(()=>{for(const cb of cbs)cb();});}});
      return{isPaused:()=>_paused,runOrDefer(fn){if(_paused)_pendingCallbacks.push(fn);else fn();}};
    }

// ═══ PART 2 START ═══
// ═══ PART 2 START (v211.7.0) — GPU Analyzer, Audio Engine, Foundation Modules ═══

    /* ══════════════════════════════════════════════════════════════════
       WebGPU Scene Analysis Compute Shader
       ══════════════════════════════════════════════════════════════════ */
    const VSC_GPU_WGSL = /* wgsl */ `
struct Params { width : u32, height : u32, step : u32, _pad : u32, };
@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read> pixels : array<u32>;
@group(0) @binding(2) var<storage, read> prevLum : array<u32>;
@group(0) @binding(3) var<storage, read_write> lumHist : array<atomic<u32>, 256>;
@group(0) @binding(4) var<storage, read_write> rHist    : array<atomic<u32>, 256>;
@group(0) @binding(5) var<storage, read_write> gHist    : array<atomic<u32>, 256>;
@group(0) @binding(6) var<storage, read_write> bHist    : array<atomic<u32>, 256>;
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

    /* ── WebGPU Analyzer Module ── */
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

          const adapterLimits = adapter.limits;
          const requiredLimits = {
            maxStorageBuffersPerShaderStage: Math.max(12, Math.min(adapterLimits.maxStorageBuffersPerShaderStage || 8, 16)),
            maxStorageBufferBindingSize: Math.min(adapterLimits.maxStorageBufferBindingSize || 134217728, 134217728),
            maxBufferSize: Math.min(adapterLimits.maxBufferSize || 268435456, 268435456)
          };

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

          const mappedBuffers = [];
          try {
            await Promise.all([readbackAccumBuf.mapAsync(GPUMapMode.READ), readbackHistBuf.mapAsync(GPUMapMode.READ), readbackZoneBuf.mapAsync(GPUMapMode.READ), readbackZoneHistBuf.mapAsync(GPUMapMode.READ)]);
            mappedBuffers.push(readbackAccumBuf, readbackHistBuf, readbackZoneBuf, readbackZoneHistBuf);

            const accumData = new Uint32Array(readbackAccumBuf.getMappedRange().slice(0));
            const histData = new Uint32Array(readbackHistBuf.getMappedRange().slice(0));
            const zoneData = new Uint32Array(readbackZoneBuf.getMappedRange().slice(0));
            const zoneHistData = new Uint32Array(readbackZoneHistBuf.getMappedRange().slice(0));
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
          } finally {
            for (const buf of mappedBuffers) { try { buf.unmap(); } catch (_) {} }
          }
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
       AudioWorklet DSP Processor Source
       ══════════════════════════════════════════════════════════════════ */
    const VSC_AUDIO_WORKLET_SOURCE = `
class Biquad {
 constructor(){this.x1=0;this.x2=0;this.y1=0;this.y2=0;this.b0=1;this.b1=0;this.b2=0;this.a1=0;this.a2=0;}
 setLowShelf(Fs,f0,Q,gainDb){const A=Math.pow(10,gainDb/40),w0=2*Math.PI*f0/Fs,alpha=Math.sin(w0)/2*Math.sqrt((A+1/A)*(1/Q-1)+2),a0=(A+1)+(A-1)*Math.cos(w0)+2*Math.sqrt(A)*alpha;this.b0=(A*((A+1)-(A-1)*Math.cos(w0)+2*Math.sqrt(A)*alpha))/a0;this.b1=(2*A*((A-1)-(A+1)*Math.cos(w0)))/a0;this.b2=(A*((A+1)-(A-1)*Math.cos(w0)-2*Math.sqrt(A)*alpha))/a0;this.a1=(-2*((A-1)+(A+1)*Math.cos(w0)))/a0;this.a2=((A+1)+(A-1)*Math.cos(w0)-2*Math.sqrt(A)*alpha)/a0;}
 setPeak(Fs,f0,Q,gainDb){const A=Math.pow(10,gainDb/40),w0=2*Math.PI*f0/Fs,alpha=Math.sin(w0)/(2*Q),a0=1+alpha/A;this.b0=(1+alpha*A)/a0;this.b1=(-2*Math.cos(w0))/a0;this.b2=(1-alpha*A)/a0;this.a1=(-2*Math.cos(w0))/a0;this.a2=(1-alpha/A)/a0;}
 process(x){const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y;}
}
class VSCDSPProcessor extends AudioWorkletProcessor {
 constructor(options) {
   super(); const pd = (options && options.processorOptions) || {};
   this.sampleRate = pd.sampleRate || 48000; this.enabled = false; this.boostLinear = 1.0; this.wetMix = 0.0; this.dryMix = 1.0;
   this._hpfState = [{ x1:0,x2:0,y1:0,y2:0 },{ x1:0,x2:0,y1:0,y2:0 }];
   this._computeHPFCoeffs(40, 0.707);
   this.bassDb=0; this.voiceDb=0;
   this.eq=[{b:new Biquad(),v:new Biquad()},{b:new Biquad(),v:new Biquad()}];
   this._updateEQ();
   this._compEnvDb = -100;
   this._compThreshDb = -24;
   this._compRatio = 3.8;
   this._compKneeDb = 6;
   this._compAttack = 0.003;
   this._compRelease = 0.18;
   this._limEnvDb = -100;
   this._limThreshDb = -1.5;
   this._limRatio = 20;
   this._limAttack = 0.0003;
   this._limRelease = 0.09;
   this._clipKnee = 0.72;
   this._clipDrive = 2.5;
   this._clipTanhD = Math.tanh(this._clipDrive);
   this._makeupDbEma = 0; this._rmsDb = -100; this._compReductionDb = 0; this._targetWet = 0; this._targetDry = 1; this._rampRate = 0.001;
   this.port.onmessage = (e) => {
     const d = e.data; if (!d) return;
     if (d.type === 'init_sab') {
       try {
         this._metricsView = new Int32Array(d.sab);
         Atomics.store(this._metricsView, 0, -10000);
         Atomics.store(this._metricsView, 1, 0);
         Atomics.store(this._metricsView, 2, 0);
         Atomics.store(this._metricsView, 3, 0);
       } catch (_) { this._metricsView = null; }
       return;
     }
     if (d.type === 'params') {
       if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
       if (typeof d.boostDb === 'number') this.boostLinear = Math.pow(10, d.boostDb / 20);
       let eqChanged = false;
       if (typeof d.bassDb === 'number' && d.bassDb !== this.bassDb) { this.bassDb = d.bassDb; eqChanged = true; }
       if (typeof d.voiceDb === 'number' && d.voiceDb !== this.voiceDb) { this.voiceDb = d.voiceDb; eqChanged = true; }
       if (eqChanged) this._updateEQ();
       this._updateMixTargets();
     }
     if (d.type === 'getMetrics') {
       if (!this._metricsView) {
         this.port.postMessage({ type: 'metrics', rmsDb: this._rmsDb, compReduction: this._compReductionDb, makeupDb: this._makeupDbEma });
       }
     }
   };
 }
 _updateEQ() {
   for(let i=0;i<2;i++) {
     this.eq[i].b.setLowShelf(this.sampleRate, 120, 0.707, this.bassDb);
     this.eq[i].v.setPeak(this.sampleRate, 3000, 1.6, this.voiceDb);
   }
 }
 _updateMixTargets() { if (this.enabled) { this._targetWet = 1; this._targetDry = 0; } else { this._targetWet = 0; this._targetDry = 1; } }
 _computeHPFCoeffs(freq, Q) { const w0 = 2 * Math.PI * freq / this.sampleRate; const cosW0 = Math.cos(w0); const sinW0 = Math.sin(w0); const alpha = sinW0 / (2 * Q); const a0 = 1 + alpha; this._hpfB0 = ((1 + cosW0) / 2) / a0; this._hpfB1 = (-(1 + cosW0)) / a0; this._hpfB2 = ((1 + cosW0) / 2) / a0; this._hpfA1 = (-2 * cosW0) / a0; this._hpfA2 = (1 - alpha) / a0; }
 _applyHPF(sample, chState) { const y = this._hpfB0 * sample + this._hpfB1 * chState.x1 + this._hpfB2 * chState.x2 - this._hpfA1 * chState.y1 - this._hpfA2 * chState.y2; chState.x2 = chState.x1; chState.x1 = sample; chState.y2 = chState.y1; chState.y1 = y; return y; }
 _compressDb(inputDb, threshDb, ratio, kneeDb) { const halfKnee = kneeDb / 2; if (inputDb < threshDb - halfKnee) return inputDb; if (inputDb > threshDb + halfKnee) { return threshDb + (inputDb - threshDb) / ratio; } const x = inputDb - threshDb + halfKnee; return inputDb + ((1 / ratio) - 1) * x * x / (2 * kneeDb); }
 _envFollow(envDb, inputDb, attack, release) { const coeff = inputDb > envDb ? 1 - Math.exp(-1 / (this.sampleRate * attack)) : 1 - Math.exp(-1 / (this.sampleRate * release)); return envDb + coeff * (inputDb - envDb); }
 _softClip(x) { const ax = Math.abs(x); if (ax <= this._clipKnee) return x; const t = (ax - this._clipKnee) / Math.max(1e-6, 1 - this._clipKnee); const s = Math.tanh(this._clipDrive * t) / this._clipTanhD; return Math.sign(x) * (this._clipKnee + (1 - this._clipKnee) * s); }
 process(inputs, outputs, parameters) {
   const input = inputs[0]; const output = outputs[0]; if (!input || !input.length || !output || !output.length) return true;
   const numChannels = Math.min(input.length, output.length, 2); const blockSize = input[0].length;
   this.wetMix += (this._targetWet - this.wetMix) * Math.min(1, this._rampRate * blockSize); this.dryMix += (this._targetDry - this.dryMix) * Math.min(1, this._rampRate * blockSize);
   const doProcess = this.wetMix > 0.001;
   if (!doProcess) { for (let ch = 0; ch < numChannels; ch++) { const inp = input[ch]; const out = output[ch]; for (let i = 0; i < blockSize; i++) out[i] = inp[i] * this.dryMix; } for (let ch = numChannels; ch < output.length; ch++) output[ch].fill(0); return true; }
   let sumSq = 0; let peakCompReduction = 0;
   for (let i = 0; i < blockSize; i++) {
     let monoIn = 0; for (let ch = 0; ch < numChannels; ch++) monoIn += input[ch][i]; monoIn /= numChannels;
     let filtered = 0; for (let ch = 0; ch < numChannels; ch++) { let s = this._applyHPF(input[ch][i], this._hpfState[ch]); s = this.eq[ch].b.process(s); s = this.eq[ch].v.process(s); filtered += s; } filtered /= numChannels;
     const inAbs = Math.abs(filtered); const inDb = inAbs > 1e-8 ? 20 * Math.log10(inAbs) : -160;
     this._compEnvDb = this._envFollow(this._compEnvDb, inDb, this._compAttack, this._compRelease);
     const compOutDb = this._compressDb(this._compEnvDb, this._compThreshDb, this._compRatio, this._compKneeDb);
     const compGainDb = compOutDb - this._compEnvDb; const compReduction = -compGainDb; if (compReduction > peakCompReduction) peakCompReduction = compReduction;
     const compGainLinear = Math.pow(10, compGainDb / 20);
     let gateMult = 1.0;
     if (this._compEnvDb < -60) gateMult = 0.0;
     else if (this._compEnvDb < -50) gateMult = (this._compEnvDb + 60) / 10.0;
     const makeupDbTarget = Math.min(6, Math.max(0, compReduction - 2) * 0.38) * gateMult;
     const isAttack = makeupDbTarget < this._makeupDbEma; const alpha = isAttack ? 0.20 : 0.005; this._makeupDbEma += (makeupDbTarget - this._makeupDbEma) * alpha;
     const makeupLinear = Math.pow(10, this._makeupDbEma / 20); const totalGain = compGainLinear * this.boostLinear * makeupLinear;
     for (let ch = 0; ch < numChannels; ch++) {
       let wet = this._applyHPF(input[ch][i], this._hpfState[ch]);
       wet = this.eq[ch].b.process(wet); wet = this.eq[ch].v.process(wet);
       wet *= totalGain;
       const wetAbs = Math.abs(wet); const wetDb = wetAbs > 1e-8 ? 20 * Math.log10(wetAbs) : -160;
       this._limEnvDb = this._envFollow(this._limEnvDb, wetDb, this._limAttack, this._limRelease);
       const limOutDb = this._compressDb(this._limEnvDb, this._limThreshDb, this._limRatio, 0); const limGainDb = limOutDb - this._limEnvDb; const limGainLinear = Math.pow(10, limGainDb / 20);
       wet *= limGainLinear; wet = this._softClip(wet); const dry = input[ch][i]; output[ch][i] = dry * this.dryMix + wet * this.wetMix;
     }
     const outSample = output[0][i]; sumSq += outSample * outSample;
   }
   for (let ch = numChannels; ch < output.length; ch++) output[ch].fill(0);
   const rms = Math.sqrt(sumSq / blockSize); this._rmsDb = rms > 1e-8 ? 20 * Math.log10(rms) : -100; this._compReductionDb = peakCompReduction;
   if (this._metricsView) {
     const view = this._metricsView; const gen = Atomics.load(view, 3);
     Atomics.store(view, 3, gen + 1);
     Atomics.store(view, 0, (this._rmsDb * 100 + 0.5) | 0);
     Atomics.store(view, 1, (peakCompReduction * 100 + 0.5) | 0);
     Atomics.store(view, 2, (this._makeupDbEma * 100 + 0.5) | 0);
     Atomics.store(view, 3, gen + 2);
   }
   return true;
 }
 static get parameterDescriptors() { return []; }
}
registerProcessor('vsc-dsp-processor', VSCDSPProcessor);
`;

    /* ── AudioWorklet registration helper ── */
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

    /* ══ defineFeature — Declarative Module System ══ */
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
        const ac = new AbortController(); const moduleSignal = getCombinedSignal(ac.signal);
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

    /* ══ Targeting ══ */
    function createTargeting() {
      let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
      const SCORE = Object.freeze({
        PLAYING: 5.0, HAS_PROGRESS: 1.5, AREA_SCALE: 1.5, AREA_DIVISOR: 12000,
        USER_PROX_MAX: 2.5, USER_PROX_DECAY: 1500, USER_PROX_RAD_SQ: 722500,
        CENTER_BIAS: 0.5, CENTER_RAD_SQ: 810000, AUDIO_BASE: 1.5,
        AUDIO_BOOST_EXTRA: 0.8, PIP_BONUS: 6.0
      });
      const _result = { target: null };
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now(); const vp = getViewportSnapshot();
        let best = null, bestScore = -Infinity;
        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, 350); const area = r.width * r.height;
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
          if (!stickyTarget.paused && !stickyTarget.ended && best && stickyTarget !== best && (bestScore < stickyScore + GUARD.TARGET_HYSTERESIS_MARGIN)) {
            _result.target = stickyTarget; return _result;
          }
        }
        stickyTarget = best; stickyScore = bestScore; stickyUntil = now + GUARD.TARGET_HYSTERESIS_MS;
        _result.target = best; return _result;
      }
      return Object.freeze({ pickFastActiveOnly });
    }

    /* ══ Event Bus (Patch F / #11 Applied) ══ */
    function createEventBus() {
      const subs = new Map();
      let _signalSubs = null;
      let _signalLen = 0;

      const on = (name, fn) => {
        if (name === 'signal') {
          (_signalSubs ??= []).push(fn);
          _signalLen++;
          return () => {
            const i = _signalSubs.indexOf(fn);
            if (i >= 0) { _signalSubs.splice(i, 1); _signalLen--; }
          };
        }
        (subs.get(name) ?? (subs.set(name, []), subs.get(name))).push(fn);
        return () => { const a = subs.get(name); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
      };

      const emit = (name, data) => {
        if (name === 'signal') {
          if (_signalSubs) for (let i = 0; i < _signalLen; i++) { try { _signalSubs[i](data); } catch (_) {} }
          return;
        }
        const a = subs.get(name);
        if (a) for (let i = 0, len = a.length; i < len; i++) { try { a[i](data); } catch (_) {} }
      };

      let queued = false, forceAgg = false;
      const _resolved = Promise.resolve();

      const flush = () => {
        queued = false;
        const f = forceAgg;
        forceAgg = false;
        if (_signalSubs) {
          const d = { forceApply: f };
          for (let i = 0; i < _signalLen; i++) {
            try { _signalSubs[i](d); } catch (_) {}
          }
        }
      };

      const signal = p => {
        if (p?.forceApply) forceAgg = true;
        if (queued) return;
        queued = true;
        _resolved.then(flush);
      };

      return Object.freeze({ on, emit, signal });
    }

    function createApplyRequester(Bus, Scheduler) {
      return Object.freeze({
        soft() { try { Bus.signal(); } catch (_) { try { Scheduler.request(false); } catch (_) {} } },
        hard() { try { Bus.signal({ forceApply: true }); } catch (_) { try { Scheduler.request(true); } catch (_) {} } }
      });
    }

    /* ══ Utils ══ */
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

    /* ══ Scheduler (Patch D / #7 Applied) ══ */
    function createScheduler(minIntervalMs = 14) {
      let queued = false, force = false, applyFn = null, lastRun = 0;
      let epoch = 0;

      const _schedHi = typeof globalThis.scheduler?.postTask === 'function'
        ? fn => globalThis.scheduler.postTask(fn, { priority: 'user-blocking' }).catch(() => requestAnimationFrame(fn))
        : fn => requestAnimationFrame(fn);

      const _schedLo = typeof globalThis.scheduler?.postTask === 'function'
        ? fn => globalThis.scheduler.postTask(fn, { priority: 'background' }).catch(() =>
            typeof requestIdleCallback === 'function'
              ? requestIdleCallback(fn, { timeout: 200 })
              : requestAnimationFrame(fn))
        : typeof requestIdleCallback === 'function'
          ? fn => requestIdleCallback(fn, { timeout: 200 })
          : fn => requestAnimationFrame(fn);

      function execute() {
        queued = false;
        const now = performance.now(), doForce = force;
        force = false;
        if (!doForce && (now - lastRun) < minIntervalMs) {
          const delay = minIntervalMs - (now - lastRun);
          const throttleEpoch = ++epoch;
          setTimeout(() => {
            if (throttleEpoch !== epoch) return;
            queued = false; force = false;
            lastRun = performance.now();
            if (applyFn) try { applyFn(doForce); } catch (_) {}
          }, delay);
          return;
        }
        lastRun = now;
        if (applyFn) try { applyFn(doForce); } catch (_) {}
      }

      function request(immediate = false) {
        if (immediate) force = true;
        if (queued && !immediate) return;
        queued = true;
        const myEpoch = ++epoch;
        (immediate ? _schedHi : _schedLo)(() => { if (myEpoch === epoch) execute(); });
      }

      return { registerApply: fn => { applyFn = fn; }, request };
    }

    /* ══ Local Store (Patch #2 & Patch 3 Applied: Inline optimization & wildcard fast-path) ══ */
    function createLocalStore(defaults, scheduler, Utils, onSignal) {
      let rev = 0;
      const listeners = new Map();
      const state = Utils.deepClone(defaults);
      const pathCache = Object.create(null);
      let _emittingDepth = 0;
      const _pendingRemovals = [];
      let _wildcardCount = 0;

      const DIRTY_BITS = Object.freeze({ VIDEO: 0b0001, AUDIO: 0b0010, PLAYBACK: 0b0100, APP: 0b1000 });
      const CAT_TO_BIT = { video: 0b0001, audio: 0b0010, playback: 0b0100, app: 0b1000 };
      let dirtyMask = 0;

      function _processPendingRemovals() {
        for (let i = 0; i < _pendingRemovals.length; i++) {
          const { key, fn } = _pendingRemovals[i];
          const arr = listeners.get(key);
          if (!arr) continue;
          const idx = arr.indexOf(fn);
          if (idx >= 0) {
            const last = arr.length - 1;
            if (idx !== last) arr[idx] = arr[last];
            arr.pop();
            if (key.endsWith('.*')) _wildcardCount--;
          }
        }
        _pendingRemovals.length = 0;
      }

      const parsePath = p => pathCache[p] ??= (i => i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)])(p.indexOf('.'));

      const _catStarMap = new Map();
      function ensureCatStar(key) {
        if (_catStarMap.has(key)) return _catStarMap.get(key);
        const dot = key.indexOf('.');
        const c = dot > 0 ? key.slice(0, dot) + '.*' : '';
        _catStarMap.set(key, c);
        return c;
      }

      const emit = (key, val) => {
        const a = listeners.get(key);
        const aLen = a ? a.length : 0;

        let b, bLen = 0;
        if (_wildcardCount > 0) {
          const catStar = ensureCatStar(key);
          b = catStar ? listeners.get(catStar) : undefined;
          bLen = b ? b.length : 0;
        }

        if (aLen === 0 && bLen === 0) return;

        _emittingDepth++;
        let i = 0;
        try {
          for (; i < aLen; i++) a[i](val);
          for (i = 0; i < bLen; i++) b[i](val);
        } catch (_) {
          if (i < aLen) {
            for (let j = i + 1; j < aLen; j++) { try { a[j](val); } catch (_) {} }
            for (i = 0; i < bLen; i++) { try { b[i](val); } catch (_) {} }
          } else {
            for (let j = i + 1; j < bLen; j++) { try { b[j](val); } catch (_) {} }
          }
        } finally {
          _emittingDepth--;
        }

        if (_emittingDepth === 0 && _pendingRemovals.length > 0) {
          _processPendingRemovals();
        }
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
          if (k != null) {
            if (Object.is(state[c]?.[k], val)) return;
            state[c][k] = val; rev++; dirtyMask |= CAT_TO_BIT[c] || 0; emit(p, val);
            scheduler.request(false); onSignal?.();
            return;
          }
          if (typeof state[c] === 'object' && state[c] !== null && typeof val === 'object' && val !== null) {
            let changed = false;
            for (const [subK, subV] of Object.entries(val)) {
              if (!Object.is(state[c][subK], subV)) {
                state[c][subK] = subV; changed = true;
                emit(`${c}.${subK}`, subV);
              }
            }
            if (changed) {
              rev++; dirtyMask |= CAT_TO_BIT[c] || 0;
              if (_wildcardCount > 0) {
                const b = listeners.get(`${c}.*`);
                if (b) {
                  _emittingDepth++;
                  try {
                    const len = b.length;
                    for (let i = 0; i < len; i++) { const fn = b[i]; if (fn) { try { fn(undefined); } catch (_) {} } }
                  } finally {
                    _emittingDepth--;
                  }
                  if (_emittingDepth === 0 && _pendingRemovals.length > 0) _processPendingRemovals();
                }
              }
              scheduler.request(false); onSignal?.();
            }
          } else {
            if (Object.is(state[c], val)) return;
            state[c] = val; rev++; dirtyMask |= CAT_TO_BIT[c] || 0; emit(c, val);
            scheduler.request(false); onSignal?.();
          }
        },
        batch: (cat, obj) => {
          let changed = false;
          const changedKeys = [];
          for (const [k, v] of Object.entries(obj)) {
            if (!Object.is(state[cat]?.[k], v)) {
              state[cat][k] = v; changed = true; changedKeys.push(k);
            }
          }
          if (changed) {
            rev++; dirtyMask |= CAT_TO_BIT[cat] || 0;
            _emittingDepth++;
            try {
              for (const k of changedKeys) {
                const a = listeners.get(`${cat}.${k}`);
                if (a) {
                  const len = a.length;
                  for (let i = 0; i < len; i++) { const fn = a[i]; if (fn) { try { fn(state[cat][k]); } catch (_) {} } }
                }
              }
              if (_wildcardCount > 0) {
                const b = listeners.get(`${cat}.*`);
                if (b) {
                  const len = b.length;
                  for (let i = 0; i < len; i++) { const fn = b[i]; if (fn) { try { fn(undefined); } catch (_) {} } }
                }
              }
            } finally {
              _emittingDepth--;
            }
            if (_emittingDepth === 0 && _pendingRemovals.length > 0) _processPendingRemovals();
            scheduler.request(false); onSignal?.();
          }
        },
        sub: (k, f) => {
          let s = listeners.get(k);
          if (!s) { s = []; listeners.set(k, s); }
          s.push(f);
          if (k.endsWith('.*')) _wildcardCount++;
          return () => {
            if (_emittingDepth > 0) {
              _pendingRemovals.push({ key: k, fn: f });
              return;
            }
            const arr = listeners.get(k);
            if (!arr) return;
            const idx = arr.indexOf(f);
            if (idx >= 0) {
              const last = arr.length - 1;
              if (idx !== last) arr[idx] = arr[last];
              arr.pop();
              if (k.endsWith('.*')) _wildcardCount--;
            }
          };
        },
        consumeDirty() { const m = dirtyMask; dirtyMask = 0; return m; },
        isDirty(bit) { return !!(dirtyMask & bit); }
      };
    }

    /* ══ Registry ══ */
    const _observerCleanupRegistry = new FinalizationRegistry(({ mo, observers }) => {
      try { mo.disconnect(); observers.delete(mo); } catch (_) {}
    });

    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() };
      let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
      const shadowRootsLRU = [];
      const observedShadowHosts = new WeakSet();
      let __refreshRafId = 0;

      function requestRefreshCoalesced() {
        if (__refreshRafId) return;
        __refreshRafId = requestAnimationFrame(() => { __refreshRafId = 0; scheduler.request(false); });
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
            if (!__refreshRafId) {
              __refreshRafId = requestAnimationFrame(() => { __refreshRafId = 0; scheduler.request(true); });
            }
          }
        }
        if (ro) ro.observe(el);
      };

      /* ── WorkQ (Patch #12 Applied: Adaptive drain) ── */
      const WorkQ = (() => {
        const MAX = 500, q = []; let head = 0, epoch = 1, scheduled = false;
        const mark = new WeakMap();

        const mc = new MessageChannel();
        const hasPostTask = typeof globalThis.scheduler?.postTask === 'function';
        const hasRIC = typeof requestIdleCallback === 'function';

        let idleCb = null;
        mc.port1.onmessage = () => { if (idleCb) { const cb = idleCb; idleCb = null; cb(); } };

        const schedIdle = (fn) => {
          if (hasPostTask) {
            globalThis.scheduler.postTask(fn, { priority: 'background' }).catch(() => {
              idleCb = fn; mc.port2.postMessage(null);
            });
          } else if (hasRIC) {
            requestIdleCallback(fn, { timeout: 120 });
          } else {
            idleCb = fn; mc.port2.postMessage(null);
          }
        };

        const scanNode = n => {
          if (!n) return;
          if (n.nodeType === 1) {
            if (__cfPositive.has(n)) return;
            if (n.tagName === 'VIDEO') { observeVideo(n); return; }
            if (!n.childElementCount) return;
            try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch(_) {}
          } else if (n.nodeType === 11) {
            try { const vs = n.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch(_) {}
          }
        };

        let BATCH_SIZE = 12;
        const drain = () => {
          scheduled = false;
          const t0 = performance.now();
          let count = 0;
          while (count < BATCH_SIZE && head < q.length) { scanNode(q[head++]); count++; }
          const elapsed = performance.now() - t0;

          if (elapsed < 1 && BATCH_SIZE < 48) BATCH_SIZE = Math.min(48, BATCH_SIZE + 4);
          else if (elapsed > 4 && BATCH_SIZE > 4) BATCH_SIZE = Math.max(4, BATCH_SIZE - 4);

          if (head >= q.length) { q.length = 0; head = 0; epoch++; }
          else { scheduled = true; schedIdle(drain); }
        };

        return Object.freeze({
          enqueue(n) {
            if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
            if (q.length - head >= MAX) { q.splice(0, head + (q.length >> 1)); head = 0; epoch++; }
            if (mark.get(n) === epoch) return;
            mark.set(n, epoch); q.push(n);
            if (!scheduled) { scheduled = true; schedIdle(drain); }
          }
        });
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
      }

      const connectObserver = (root) => {
        if (!root) return;
        const hostRef = (root instanceof ShadowRoot && root.host) ? new WeakRef(root.host) : null;

        const mo = new MutationObserver((muts) => {
          if (__globalSig.aborted) { mo.disconnect(); observers.delete(mo); return; }

          if (hostRef) {
            const host = hostRef.deref();
            if (!host || !host.isConnected) {
              mo.disconnect();
              observers.delete(mo);
              return;
            }
          } else if (root !== document && root !== document.body && root !== document.documentElement) {
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
                if (n.nodeType === 1 && (isVscOwnNode(n) || isCloudflareElement(n))) continue;
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

        if (hostRef) {
          const host = hostRef.deref();
          if (host) _observerCleanupRegistry.register(host, { mo, observers });
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
            if (vst) {
              vst.applied = false;
              vst.lastFilterUrl = null;
              vst.lastCssFilterStr = null;
              vst._lastFilterHash = 0;
              vst._lastSvgHash = 0;
              vst._transitionCleared = false;
            }
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

    /* ══ Audio Engine (Bug 3 Applied: srcMap pollution fix) ══ */
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

      const _SAB_FLOATS = 3, _SAB_SLOTS = _SAB_FLOATS + 1;
      const _hasSAB = typeof SharedArrayBuffer === 'function' && (() => { try { new SharedArrayBuffer(4); return true; } catch(_) { return false; } })();
      let __metricsSAB = null, __metricsView = null;
      if (_hasSAB) {
        __metricsSAB = new SharedArrayBuffer(_SAB_SLOTS * 4);
        __metricsView = new Int32Array(__metricsSAB);
        Atomics.store(__metricsView, 0, -10000);
        Atomics.store(__metricsView, 1, 0);
        Atomics.store(__metricsView, 2, 0);
        Atomics.store(__metricsView, 3, 0);
      }

      let compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, bassFilter, voiceFilter, clipper, analyser, dataArray;

      const clamp = VSC_CLAMP;
      const VSC_AUDIO_AUTO_MAKEUP = true;

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

          if (_hasSAB && __metricsSAB && __workletNode) {
            __workletNode.port.postMessage({ type: 'init_sab', sab: __metricsSAB });
          }

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
        compressor.threshold.value = -24.0;
        compressor.knee.value = 6.0;
        compressor.ratio.value = 3.5;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.18;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.5;
        limiter.knee.value = 0.0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0005;
        limiter.release.value = 0.09;

        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 40;
        hpf.Q.value = 0.707;

        bassFilter = ctx.createBiquadFilter();
        bassFilter.type = 'lowshelf';
        bassFilter.frequency.value = 120;

        voiceFilter = ctx.createBiquadFilter();
        voiceFilter.type = 'peaking';
        voiceFilter.frequency.value = 3000;
        voiceFilter.Q.value = 1.6;

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
        hpf.connect(bassFilter);
        bassFilter.connect(voiceFilter);
        voiceFilter.connect(compressor);
        voiceFilter.connect(analyser);
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

        let targetBassDb = 0, targetVoiceDb = 0;
        const autoSceneEnabled = sm.get(P.APP_AUTO_SCENE) && sm.get(P.APP_ACT);
        if (autoSceneEnabled) {
          const internalRef = window[Symbol.for('__VSC_INTERNAL__')];
          if (internalRef?.AutoScene) {
            const st = internalRef.AutoScene.getSceneType?.() || 0;
            const eqMap = [[0,0], [4,0], [0,3], [2,2], [1,1], [-1,4], [2,1]];
            targetBassDb = eqMap[st] ? eqMap[st][0] : 0;
            targetVoiceDb = eqMap[st] ? eqMap[st][1] : 0;
          }
        }

        if (__useWorklet) {
          if (__workletNode) {
            __workletNode.port.postMessage({ type: 'params', enabled: actuallyEnabled, boostDb, bassDb: targetBassDb, voiceDb: targetVoiceDb });
            if (actuallyEnabled) __workletNode.port.postMessage({ type: 'getMetrics' });
          }
          makeupDbEma = actuallyEnabled ? __workletMetrics.makeupDb : makeupDbEma + (0 - makeupDbEma) * 0.1;
        } else {
          if (!actuallyEnabled || document.hidden) {
            makeupDbEma += (0 - makeupDbEma) * 0.1;
            if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
            if (bassFilter) { try { bassFilter.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch(_) { bassFilter.gain.value = 0; } }
            if (voiceFilter) { try { voiceFilter.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch(_) { voiceFilter.gain.value = 0; } }
          } else {
            if (bassFilter) { try { bassFilter.gain.setTargetAtTime(targetBassDb, ctx.currentTime, 0.1); } catch(_) { bassFilter.gain.value = targetBassDb; } }
            if (voiceFilter) { try { voiceFilter.gain.setTargetAtTime(targetVoiceDb, ctx.currentTime, 0.1); } catch(_) { voiceFilter.gain.value = targetVoiceDb; } }

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
              if (db < -60) gateMult = 0.0;
              else if (db < -50) gateMult = (db + 60) / 10.0;
              const makeupDbTarget = clamp(Math.max(0, redPos - 2.0) * 0.38, 0, 6.0) * gateMult;
              const isAttack = makeupDbTarget < makeupDbEma;
              const alpha = isAttack ? 0.20 : 0.005;
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
        try { bassFilter?.disconnect(); } catch (_) {}
        try { voiceFilter?.disconnect(); } catch (_) {}
        try { clipper?.disconnect(); } catch (_) {}
        try { wetInGain?.disconnect(); } catch (_) {}
        try { dryOut?.disconnect(); } catch (_) {}
        try { wetOut?.disconnect(); } catch (_) {}
        try { masterOut?.disconnect(); } catch (_) {}
        try { analyser?.disconnect(); } catch (_) {}
        compressor = null; limiter = null; wetInGain = null;
        dryOut = null; wetOut = null; masterOut = null; hpf = null;
        bassFilter = null; voiceFilter = null;
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
      }

      const resetAllAudioFailUntil = () => {
        for (const v of TOUCHED.videos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
        for (const v of TOUCHED.rateVideos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
      };

      const ensureCtx = async () => {
        if (__ctxPermanentBlock) return false;

        if (ctx && ctx.state === 'closed') {
          const oldSrcMap = srcMap;
          const allVideos = new Set([...TOUCHED.videos, ...TOUCHED.rateVideos]);
          for (const v of allVideos) {
            try {
              const s = oldSrcMap.get(v);
              if (s) { try { s.disconnect(); } catch (_) {} }
            } catch (_) {}
          }
          resetCtx();
          srcMap = new WeakMap();
          resetAllAudioFailUntil();
          __ctxCreateCount++;
        }

        if (ctx) return true;
        const now = performance.now();
        if (now < __ctxBlockUntil) return false;
        if (__ctxBlockUntil > 0 && now >= __ctxBlockUntil) {
          __ctxCreateCount = 0; __ctxBlockUntil = 0;
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

        if (!ctx) {
          const existingSrcMap = srcMap;
          for (const v of new Set([...TOUCHED.videos, ...TOUCHED.rateVideos])) {
            try {
              const s = existingSrcMap.get(v);
              if (s && s.context && s.context.state !== 'closed') {
                try { s.disconnect(); } catch (_) {}
                try { s.connect(s.context.destination); } catch (_) {}
              }
            } catch (_) {}
          }
          srcMap = new WeakMap();
          resetAllAudioFailUntil();
        }

        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); }
        catch (_) { try { ctx = new AC(); } catch (__) { return false; } }
        __ctxCreateCount++;
        ensureGestureResumeHook();

        if (FEATURE_FLAGS.audioWorklet) {
          const workletOk = await buildWorkletGraph();
          if (!workletOk) buildLegacyGraph();
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

        if (target && target.isConnected) {
          const connected = connectSource(target);
          if (connected) updateMix();
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
        const prevTarget = target;
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
            if (prevSrc.__vsc_isCaptureStream) {
              try { prevSrc.disconnect(); } catch (_) {}
              const stream = prevSrc.__vsc_captureStream;
              if (stream) {
                stream.getAudioTracks().forEach(track => {
                  try { track.stop(); } catch (_) {}
                });
              }
              if (prevTarget && prevTarget.muted && prevSrc.__vsc_originalMuted === false) {
                try {
                  prevTarget.muted = false;
                  prevTarget.volume = prevSrc.__vsc_originalVolume ?? 1;
                } catch (_) {}
              }
            } else {
              try { prevSrc.disconnect(); } catch (_) {}
              try { prevSrc.connect(savedCtx.destination); } catch (_) {}
            }
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
          if (currentSrc.__vsc_isCaptureStream && target) {
            if (target.muted && currentSrc.__vsc_originalMuted === false) {
              target.muted = false;
              target.volume = currentSrc.__vsc_originalVolume ?? 1;
            }
            const stream = currentSrc.__vsc_captureStream;
            if (stream) {
              stream.getAudioTracks().forEach(track => {
                try { track.stop(); } catch (_) {}
              });
            }
          }
          try { currentSrc.disconnect(); } catch (_) {}
          if (!currentSrc.__vsc_isCaptureStream) {
            try { currentSrc.connect(ctx.destination); } catch (_) {}
          }
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

        if (currentSrc?.__vsc_isCaptureStream && target) {
          if (actuallyEnabled) {
            if (!target.muted) {
              currentSrc.__vsc_originalMuted = target.muted;
              currentSrc.__vsc_originalVolume = target.volume;
              target.muted = true;
            }
          } else {
            if (target.muted && currentSrc.__vsc_originalMuted === false) {
              target.muted = false;
              target.volume = currentSrc.__vsc_originalVolume ?? 1;
            }
          }
        }

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

      function detectJwPlayer(video) {
        if (!video) return false;
        if (window.jwplayer) return true;
        let el = video.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          if (el.classList) {
            for (const cls of el.classList) {
              if (cls.startsWith('jw') || cls.includes('jwplayer')) return true;
            }
          }
          if (el.id && (el.id.startsWith('jw') || el.id.includes('jwplayer'))) return true;
          el = el.parentElement;
        }
        if (video.src?.startsWith('blob:')) {
          if (document.querySelector('script[src*="jwplayer"]') ||
              document.querySelector('[class*="jw-"]')) {
            return true;
          }
        }
        return false;
      }

      function connectViaCaptureStream(video) {
        if (!ctx) return null;
        const stream = video.captureStream();
        if (!stream || stream.getAudioTracks().length === 0) {
          log.debug('[Audio] captureStream returned no audio tracks');
          return null;
        }
        const source = ctx.createMediaStreamSource(stream);
        source.__vsc_captureStream = stream;
        source.__vsc_isCaptureStream = true;
        source.__vsc_originalMuted = video.muted;
        source.__vsc_originalVolume = video.volume;
        return source;
      }

      function connectSource(v) {
        const st = v ? getVState(v) : null;
        try {
          if (CONFIG.IS_FIREFOX && !v.crossOrigin) v.crossOrigin = "anonymous";
          let s = srcMap.get(v);

          if (s) {
            if (s.context === ctx) {
              try { s.disconnect(); } catch (_) {}
            } else if (s.context.state === 'closed') {
              srcMap.delete(v);
              s = null;
            } else {
              log.debug('Source belongs to different live AudioContext — entering bypass');
              enterBypass(v);
              return false;
            }
          }

          if (!s) {
            const isJwPlayer = detectJwPlayer(v);
            if (isJwPlayer && typeof v.captureStream === 'function') {
              try {
                s = connectViaCaptureStream(v);
                if (s) {
                  srcMap.set(v, s);
                  log.info('[Audio] JWPlayer detected — using captureStream() path');
                }
              } catch (e) {
                log.debug('[Audio] captureStream failed for JWPlayer:', e.message);
                s = null;
              }
            }
            if (!s) {
              try {
                s = ctx.createMediaElementSource(v);
              } catch (e) {
                log.warn('createMediaElementSource failed:', e.name, e.message);
                if (e.name === 'InvalidStateError') {
                  if (typeof v.captureStream === 'function') {
                    try {
                      s = connectViaCaptureStream(v);
                      if (s) {
                        srcMap.set(v, s);
                        log.info('[Audio] Fallback to captureStream() after InvalidStateError');
                      }
                    } catch (e2) {
                      log.debug('[Audio] captureStream fallback also failed:', e2.message);
                    }
                  }
                }
                if (!s) {
                  if (st) st.audioFailUntil = performance.now() + (e.name === 'InvalidStateError' ? 30000 : 10000);
                  enterBypass(v);
                  return false;
                }
              }
              if (s && !srcMap.has(v)) srcMap.set(v, s);
            }
          }

          try { s.disconnect(); } catch (_) {}

          if (__useWorklet) {
            if (!__workletNode) { log.warn('AudioWorklet node not ready — entering bypass'); enterBypass(v); return false; }
            s.connect(__workletNode);
          } else {
            if (!dryOut || !hpf) { log.warn('Legacy audio graph not ready — entering bypass'); enterBypass(v); return false; }
            s.connect(dryOut);
            s.connect(hpf);
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

        const currentSrcMap = srcMap;
        const allVideos = new Set([...TOUCHED.videos, ...TOUCHED.rateVideos]);
        for (const v of allVideos) {
          try {
            const s = currentSrcMap.get(v);
            if (s && ctx && s.context === ctx && ctx.state !== 'closed') {
              try { s.disconnect(); } catch (_) {}
              try { s.connect(ctx.destination); } catch (_) {}
            }
          } catch (_) {}
        }

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
        getWorkletMetrics: () => {
          if (!__useWorklet) return null;
          if (__metricsView) {
            let gen1, gen2, attempts = 0;
            do {
              gen1 = Atomics.load(__metricsView, 3);
              const rmsDb = Atomics.load(__metricsView, 0) / 100;
              const compReduction = Atomics.load(__metricsView, 1) / 100;
              const makeupDb = Atomics.load(__metricsView, 2) / 100;
              gen2 = Atomics.load(__metricsView, 3);
              if (gen1 === gen2) return { rmsDb, compReduction, makeupDb };
            } while (++attempts < 4);
          }
          return { ...__workletMetrics };
        },
        destroy
      };
    }

// ═══ END OF PART 2 (v211.7.0) ═══
// ═══ PART 3 START (v211.7.0) — Auto Scene Manager, Apply Loop ═══

    /* ══════════════════════════════════════════════════════════════════
       Auto Scene Manager (Patch C, Patch #10 Applied)
       ══════════════════════════════════════════════════════════════════ */
    function createAutoSceneManager(Store, P, Scheduler) {
      const clamp = VSC_CLAMP;
      const HIST_BINS = 256; const TONE_STEPS = 256;
      const CANVAS_W = CONFIG.IS_MOBILE ? 80 : 112; const CANVAS_H = CONFIG.IS_MOBILE ? 63 : 63;
      const ZONE_COLS = 4, ZONE_ROWS = 4, ZONE_COUNT = 16;
      const CENTER_ZONE_MASK = (1 << 5) | (1 << 6) | (1 << 9) | (1 << 10);

      // Patch 1: Store revision tracker for AutoScene
      let _autoSceneRev = 0;

      // ── 메인 스레드용 풀 배열 및 버퍼 선언 ──────────────
      const _pool_lumHist       = new Uint32Array(HIST_BINS);
      const _pool_rHist         = new Uint32Array(HIST_BINS);
      const _pool_gHist         = new Uint32Array(HIST_BINS);
      const _pool_bHist         = new Uint32Array(HIST_BINS);
      const _pool_zoneCounts    = new Uint32Array(ZONE_COUNT);
      const _pool_zoneBrightSum = new Float32Array(ZONE_COUNT);
      const _pool_zoneHists     = Array.from({ length: ZONE_COUNT }, () => new Uint32Array(HIST_BINS));
      let __curLumBuf     = null;
      let __curLumBufSize = 0;
      let __prevLumBuf    = null;
      let __zoneLutCache  = null;

      function getZoneLuts(sw, sh) {
        if (__zoneLutCache?.w === sw && __zoneLutCache.h === sh) return __zoneLutCache;
        const maxZx = ZONE_COLS - 1, maxZy = ZONE_ROWS - 1;
        const invW = 1 / Math.max(1, (sw / ZONE_COLS) | 0);
        const invH = 1 / Math.max(1, (sh / ZONE_ROWS) | 0);
        const zxLut = new Uint8Array(sw);
        const zyLut = new Uint8Array(sh);
        for (let x = 0; x < sw; x++) zxLut[x] = Math.min(maxZx, (x * invW) | 0);
        for (let y = 0; y < sh; y++) zyLut[y] = Math.min(maxZy, (y * invH) | 0);
        return (__zoneLutCache = { w: sw, h: sh, zxLut, zyLut });
      }

      const _ZONE_WEIGHTS = Float32Array.from({ length: ZONE_COUNT }, (_, zi) => {
        const zx = zi % ZONE_COLS, zy = (zi / ZONE_COLS) | 0;
        const cx = (zx + 0.5) / ZONE_COLS, cy = (zy + 0.5) / ZONE_ROWS;
        const dx = 0.5 - cx, dy = 0.5 - cy;
        return 1.0 / (0.1 + Math.sqrt(dx * dx + dy * dy));
      });

      const ST = Object.freeze({ NORMAL: 0, LOW_KEY: 1, HIGH_KEY: 2, HIGH_CONTRAST: 3, LOW_SAT: 4, SKIN: 5, BACKLIT: 6 });
      const ST_NAMES = ['NORMAL', 'LOW_KEY', 'HIGH_KEY', 'HI_CONT', 'LOW_SAT', 'SKIN', 'BACKLIT'];
      const ST_COUNT = ST_NAMES.length;

      /* ══ Analysis Worker Pool (Patch 7 Applied: VideoFrame.copyTo) ══ */
      const ANALYSIS_WORKER_SRC = (() => {
        const workerFn = function() {
          const HIST_BINS = 256, ZONE_COLS = 4, ZONE_ROWS = 4, ZONE_COUNT = 16;
          const CENTER_ZONE_MASK = (1<<5)|(1<<6)|(1<<9)|(1<<10);
          let __zoneLutCache = null, __prevLumBuf = null, __curLumBuf = null, __curLumBufSize = 0;
          const _pool_lumHist = new Uint32Array(HIST_BINS), _pool_rHist = new Uint32Array(HIST_BINS);
          const _pool_gHist = new Uint32Array(HIST_BINS), _pool_bHist = new Uint32Array(HIST_BINS);
          const _pool_zoneCounts = new Uint32Array(ZONE_COUNT);
          const _pool_zoneHists = Array.from({length:ZONE_COUNT}, ()=>new Uint32Array(HIST_BINS));
          const _pool_zoneBrightSum = new Float32Array(ZONE_COUNT);

          function getZoneLuts(sw, sh) {
            if (__zoneLutCache?.w===sw && __zoneLutCache.h===sh) return __zoneLutCache;
            const maxZx=ZONE_COLS-1, maxZy=ZONE_ROWS-1;
            const invW=1/Math.max(1,(sw/ZONE_COLS)|0), invH=1/Math.max(1,(sh/ZONE_ROWS)|0);
            const zxLut=new Uint8Array(sw), zyLut=new Uint8Array(sh);
            for(let x=0;x<sw;x++) zxLut[x]=Math.min(maxZx,(x*invW)|0);
            for(let y=0;y<sh;y++) zyLut[y]=Math.min(maxZy,(y*invH)|0);
            return (__zoneLutCache={w:sw,h:sh,zxLut,zyLut});
          }

          function analyze(data, sw, sh) {
            const step=2;
            const iabs = (x) => (x ^ (x >> 31)) - (x >> 31);
            let sum=0,sum2=0,sumEdge=0,sumChroma=0,count=0,skinCount=0,edgePairCount=0;
            const lumHist=_pool_lumHist; lumHist.fill(0);
            const rHist=_pool_rHist; rHist.fill(0);
            const gHist=_pool_gHist; gHist.fill(0);
            const bHist=_pool_bHist; bHist.fill(0);
            const zoneCounts=_pool_zoneCounts; zoneCounts.fill(0);
            const zoneHists=_pool_zoneHists; for(let z=0;z<ZONE_COUNT;z++) zoneHists[z].fill(0);
            const zoneBrightSum=_pool_zoneBrightSum; zoneBrightSum.fill(0);
            const pixelCount=sw*sh;
            if(!__curLumBuf||__curLumBufSize!==pixelCount){__curLumBuf=new Uint8Array(pixelCount);__curLumBufSize=pixelCount;}
            const curLum=__curLumBuf;
            let hiLumaRSum=0,hiLumaBSum=0,hiLumaCount=0;
            const {zxLut,zyLut}=getZoneLuts(sw,sh);
            const u32=new Uint32Array(data.buffer,data.byteOffset,data.byteLength>>>2);
            const maxX=sw-step;

            for(let y=0;y<sh;y+=step){
              const rowOff=y*sw; const zyBase=zyLut[y]<<2;
              const xEnd=(maxX-3*step)|0;
              let x=0;
              for(;x<=xEnd;x+=step*4){
                const px0=u32[rowOff+x], px1=u32[rowOff+x+step], px2=u32[rowOff+x+step*2], px3=u32[rowOff+x+step*3];
                const r0=px0&0xFF,g0=(px0>>>8)&0xFF,b0=(px0>>>16)&0xFF;
                const r1=px1&0xFF,g1=(px1>>>8)&0xFF,b1=(px1>>>16)&0xFF;
                const r2=px2&0xFF,g2=(px2>>>8)&0xFF,b2=(px2>>>16)&0xFF;
                const r3=px3&0xFF,g3=(px3>>>8)&0xFF,b3=(px3>>>16)&0xFF;
                const l0=(r0*54+g0*183+b0*18+128)>>8, l1=(r1*54+g1*183+b1*18+128)>>8;
                const l2=(r2*54+g2*183+b2*18+128)>>8, l3=(r3*54+g3*183+b3*18+128)>>8;
                lumHist[l0]++;lumHist[l1]++;lumHist[l2]++;lumHist[l3]++;
                rHist[r0]++;rHist[r1]++;rHist[r2]++;rHist[r3]++;
                gHist[g0]++;gHist[g1]++;gHist[g2]++;gHist[g3]++;
                bHist[b0]++;bHist[b1]++;bHist[b2]++;bHist[b3]++;
                sum+=l0+l1+l2+l3; sum2+=l0*l0+l1*l1+l2*l2+l3*l3; count+=4;
                sumEdge += iabs(l0 - l1) + iabs(l1 - l2) + iabs(l2 - l3); edgePairCount+=3;
                const pi0=rowOff+x; curLum[pi0]=l0; curLum[pi0+step]=l1; curLum[pi0+step*2]=l2; curLum[pi0+step*3]=l3;

                // Patch #10: Branchless Chroma via Sort Network (3-element)
                let a0 = r0, b0_ = g0, c0 = b0; if (a0 > b0_) { const t = a0; a0 = b0_; b0_ = t; } if (a0 > c0) { const t = a0; a0 = c0; c0 = t; } if (b0_ > c0) { const t = b0_; b0_ = c0; c0 = t; }
                let a1 = r1, b1_ = g1, c1 = b1; if (a1 > b1_) { const t = a1; a1 = b1_; b1_ = t; } if (a1 > c1) { const t = a1; a1 = c1; c1 = t; } if (b1_ > c1) { const t = b1_; b1_ = c1; c1 = t; }
                let a2 = r2, b2_ = g2, c2 = b2; if (a2 > b2_) { const t = a2; a2 = b2_; b2_ = t; } if (a2 > c2) { const t = a2; a2 = c2; c2 = t; } if (b2_ > c2) { const t = b2_; b2_ = c2; c2 = t; }
                let a3 = r3, b3_ = g3, c3 = b3; if (a3 > b3_) { const t = a3; a3 = b3_; b3_ = t; } if (a3 > c3) { const t = a3; a3 = c3; c3 = t; } if (b3_ > c3) { const t = b3_; b3_ = c3; c3 = t; }
                sumChroma += (c0 - a0) + (c1 - a1) + (c2 - a2) + (c3 - a3);

                const zi0=zyBase+zxLut[x], zi1=zyBase+zxLut[x+step], zi2=zyBase+zxLut[x+step*2], zi3=zyBase+zxLut[x+step*3];
                zoneHists[zi0][l0]++;zoneCounts[zi0]++;zoneBrightSum[zi0]+=l0;
                zoneHists[zi1][l1]++;zoneCounts[zi1]++;zoneBrightSum[zi1]+=l1;
                zoneHists[zi2][l2]++;zoneCounts[zi2]++;zoneBrightSum[zi2]+=l2;
                zoneHists[zi3][l3]++;zoneCounts[zi3]++;zoneBrightSum[zi3]+=l3;
                if(l0>=180&&b0>10){hiLumaRSum+=r0;hiLumaBSum+=b0;hiLumaCount++;}
                if(l1>=180&&b1>10){hiLumaRSum+=r1;hiLumaBSum+=b1;hiLumaCount++;}
                if(l2>=180&&b2>10){hiLumaRSum+=r2;hiLumaBSum+=b2;hiLumaCount++;}
                if(l3>=180&&b3>10){hiLumaRSum+=r3;hiLumaBSum+=b3;hiLumaCount++;}

                skinCount += ((r0 - g0 > 12) & (r0 >= 80) & (g0 >= 35) & (b0 >= 20) & (r0 > b0))
                           + ((r1 - g1 > 12) & (r1 >= 80) & (g1 >= 35) & (b1 >= 20) & (r1 > b1))
                           + ((r2 - g2 > 12) & (r2 >= 80) & (g2 >= 35) & (b2 >= 20) & (r2 > b2))
                           + ((r3 - g3 > 12) & (r3 >= 80) & (g3 >= 35) & (b3 >= 20) & (r3 > b3));
              }
              for(;x<=maxX;x+=step){
                const pi=rowOff+x; const px=u32[pi];
                const r=px&0xFF,g=(px>>>8)&0xFF,b=(px>>>16)&0xFF;
                const l=(r*54+g*183+b*18+128)>>8;

                // Patch #10: Branchless Chroma
                let a = r, b_ = g, c = b; if (a > b_) { const t = a; a = b_; b_ = t; } if (a > c) { const t = a; a = c; c = t; } if (b_ > c) { const t = b_; b_ = c; c = t; }
                sumChroma += (c - a);

                curLum[pi]=l; sum+=l; sum2+=l*l; count++;
                lumHist[l]++; rHist[r]++; gHist[g]++; bHist[b]++;
                const nx=x+step;
                if(nx<sw){const npx=u32[rowOff+nx];const nl=((npx&0xFF)*54+((npx>>>8)&0xFF)*183+((npx>>>16)&0xFF)*18+128)>>8; sumEdge+=iabs(l-nl); edgePairCount++;}

                skinCount += ((r - g > 12) & (r >= 80) & (g >= 35) & (b >= 20) & (r > b)) | 0;

                const zi=zyBase+zxLut[x];
                zoneHists[zi][l]++; zoneCounts[zi]++; zoneBrightSum[zi]+=l;
                if(l>=180&&b>10){hiLumaRSum+=r;hiLumaBSum+=b;hiLumaCount++;}
              }
            }

            let motionSAD=0;
            if(__prevLumBuf&&__prevLumBuf.length===pixelCount){
              let sadSum=0,sadCount=0;
              for(let by=0;by+8<=sh;by+=8) for(let bx=0;bx+8<=sw;bx+=8){
                let bs=0;
                for(let dy=0;dy<8;dy+=step) for(let dx=0;dx<8;dx+=step){
                  const pi=(by+dy)*sw+(bx+dx);
                  const d = curLum[pi]-__prevLumBuf[pi];
                  bs += (d ^ (d >> 31)) - (d >> 31);
                }
                sadSum+=bs; sadCount++;
              }
              motionSAD=sadCount>0?(sadSum/sadCount)/255:0;
            }
            if(!__prevLumBuf||__prevLumBuf.length!==pixelCount) __prevLumBuf=new Uint8Array(pixelCount);
            __prevLumBuf.set(curLum);

            const n=Math.max(1,count), mean=sum/n, std=Math.sqrt(Math.max(0,(sum2/n)-mean*mean));
            let centerSum=0,centerCnt=0;
            for(let mask=CENTER_ZONE_MASK;mask;mask&=mask-1){
              const ci=31-Math.clz32(mask);
              if(zoneCounts[ci]>0){centerSum+=zoneBrightSum[ci]/zoneCounts[ci];centerCnt++;}
            }
            const centerBright=centerCnt>0?centerSum/centerCnt/255:mean/255;
            let edgeSum=0,edgeCount=0;
            for(let z=0;z<ZONE_COUNT;z++){
              if((CENTER_ZONE_MASK>>z)&1) continue;
              if(zoneCounts[z]>0){edgeSum+=zoneBrightSum[z]/zoneCounts[z];edgeCount++;}
            }
            const edgeAvgBright=edgeCount>0?edgeSum/edgeCount/255:mean/255;
            const hiLumaRBratio=hiLumaCount>=10?hiLumaRSum/Math.max(1,hiLumaBSum):NaN;

            return {
              bright:mean/255, contrast:std/64, chroma:sumChroma/n/255,
              edge:edgePairCount>0?sumEdge/edgePairCount:0, motionSAD,
              skinRatio:skinCount/n, centerBright, edgeAvgBright, hiLumaRBratio,
              lumHist:Array.from(lumHist), rHist:Array.from(rHist),
              gHist:Array.from(gHist), bHist:Array.from(bHist),
              totalSamples:count,
              zoneHists:zoneHists.map(h=>Array.from(h)),
              zoneCounts:Array.from(zoneCounts),
              zoneStats:{centerBright,edgeAvgBright}, _gpuPath:false
            };
          }

          self.onmessage = async function({ data }) {
            try {
              let result;
              if (data.type === 'frame') {
                const { frame, sw, sh } = data;
                if (typeof frame.copyTo === 'function' && frame.format) {
                  try {
                    const bufSize = frame.allocationSize({ rect: { x: 0, y: 0, width: sw, height: sh } });
                    const buf = new ArrayBuffer(bufSize);
                    await frame.copyTo(buf, { rect: { x: 0, y: 0, width: sw, height: sh } });
                    frame.close();
                    const pixelData = new Uint8ClampedArray(buf, 0, sw * sh * 4);
                    result = analyze(pixelData, sw, sh);
                  } catch (_) {
                    const cv = new OffscreenCanvas(sw, sh);
                    const ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
                    ctx.drawImage(frame, 0, 0, sw, sh);
                    frame.close();
                    result = analyze(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
                  }
                } else {
                  const cv = new OffscreenCanvas(sw, sh);
                  const ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
                  ctx.drawImage(frame, 0, 0, sw, sh);
                  frame.close();
                  result = analyze(ctx.getImageData(0, 0, sw, sh).data, sw, sh);
                }
              } else if (data.type === 'bitmap') {
                const { bitmap, sw, sh } = data;
                const cv = new OffscreenCanvas(sw, sh);
                const ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
                ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                const imgData = ctx.getImageData(0, 0, sw, sh);
                result = analyze(imgData.data, sw, sh);
              } else {
                const { buf, sw, sh, byteOffset, byteLength } = data;
                const pixelData = new Uint8ClampedArray(buf, byteOffset || 0, byteLength || buf.byteLength);
                result = analyze(pixelData, sw, sh);
              }
              const s = new Float64Array([ result.bright, result.contrast, result.chroma, result.edge, result.motionSAD, result.skinRatio, result.centerBright, result.edgeAvgBright, result.hiLumaRBratio, result.totalSamples ]);
              const hp = new Uint32Array(1040 + 16 * 256);
              hp.set(result.lumHist, 0); hp.set(result.rHist, 256); hp.set(result.gHist, 512); hp.set(result.bHist, 768); hp.set(result.zoneCounts, 1024);
              for (let z = 0; z < 16; z++) hp.set(result.zoneHists[z], 1040 + z * 256);
              self.postMessage({ id: data.id, scalars: s, histPack: hp, _gpuPath: false }, [s.buffer, hp.buffer]);
            } catch(e) {
              self.postMessage({ error: e.message, id: data.id });
            }
          };
        };
        return `(${workerFn.toString()})();`;
      })();

      const _WORKER_POOL_SIZE = Math.min(2, navigator.hardwareConcurrency > 4 ? 2 : 1);
      let _analysisWorkers = null, _workerIdx = -1;
      const _workerPending = new Map();
      const _workerMsgOwner = new Map();
      let _workerMsgId = 0;
      let WORKER_MSG_TIMEOUT_MS = 8000;

      function nextWorkerId() {
        _workerMsgId++;
        if (_workerMsgId > 2147483640) _workerMsgId = 1;
        return _workerMsgId;
      }

      function getAnalysisWorker() {
        if (_analysisWorkers) {
          for (let attempt = 0; attempt < _WORKER_POOL_SIZE; attempt++) {
            _workerIdx = (_workerIdx + 1) & 0x7FFFFFFF;
            const w = _analysisWorkers[_workerIdx % _WORKER_POOL_SIZE];
            if (w) return w;
          }
          return null;
        }

        let blobUrl;
        try {
          const blob = new Blob([ANALYSIS_WORKER_SRC], { type: 'text/javascript' });
          blobUrl = URL.createObjectURL(blob);
        } catch (_) { return null; }

        _analysisWorkers = Array.from({ length: _WORKER_POOL_SIZE }, (_, workerIndex) => {
          const createWorker = () => {
            const w = new Worker(blobUrl);

            w.onmessage = ({ data: { id, scalars, histPack, error } }) => {
              const p = _workerPending.get(id);
              if (!p) return;

              const expectedOwner = _workerMsgOwner.get(id);
              if (expectedOwner !== undefined && expectedOwner !== workerIndex) {
                log.debug(`[Worker ${workerIndex}] Received response for id ${id} owned by worker ${expectedOwner}, ignoring`);
                return;
              }

              _workerPending.delete(id);
              _workerMsgOwner.delete(id);
              if (error) { p.reject(new Error(error)); return; }
              const s = scalars;
              const result = {
                bright: s[0], contrast: s[1], chroma: s[2], edge: s[3], motionSAD: s[4], skinRatio: s[5], centerBright: s[6], edgeAvgBright: s[7], hiLumaRBratio: s[8], totalSamples: s[9],
                lumHist: histPack.subarray(0, 256), rHist: histPack.subarray(256, 512), gHist: histPack.subarray(512, 768), bHist: histPack.subarray(768, 1024), zoneCounts: histPack.subarray(1024, 1040),
                zoneHists: Array.from({length:16}, (_,z) => histPack.subarray(1040+z*256, 1040+(z+1)*256)),
                zoneStats: { centerBright: s[6], edgeAvgBright: s[7] }, _gpuPath: false
              };
              p.resolve(result);
              const elapsed = performance.now() - (p._startTime || 0);
              if (elapsed > 0 && elapsed < WORKER_MSG_TIMEOUT_MS) {
                WORKER_MSG_TIMEOUT_MS = Math.max(2000, Math.min(WORKER_MSG_TIMEOUT_MS, elapsed * 3));
              }
            };

            // Bug 2 Applied: Removed direct double-decrement of _pendingAnalysisCount
            w.onerror = (e) => {
              const toReject = [];
              for (const [id, p] of _workerPending) {
                const owner = _workerMsgOwner.get(id);
                if (owner === workerIndex || owner === undefined) {
                  toReject.push([id, p]);
                }
              }
              for (const [id, p] of toReject) {
                _workerPending.delete(id);
                _workerMsgOwner.delete(id);
                if (p._timeoutId) clearTimeout(p._timeoutId);
                p.reject(new Error(e?.message || 'Worker error'));
              }
              log.warn(`[Worker ${workerIndex}] crashed, recreating`);
              try {
                _analysisWorkers[workerIndex] = createWorker();
              } catch (_) {
                _analysisWorkers[workerIndex] = null;
                log.error(`[Worker ${workerIndex}] recreation failed`);
              }
            };

            return w;
          };

          return createWorker();
        });

        __globalSig.addEventListener('abort', () => {
          _analysisWorkers?.forEach(w => { try { w?.terminate(); } catch (_) {} });
          _analysisWorkers = null;
          try { URL.revokeObjectURL(blobUrl); } catch (_) {}
          for (const [, p] of _workerPending) {
            if (p._timeoutId) clearTimeout(p._timeoutId);
            p.reject(new Error('aborted'));
          }
          _workerPending.clear(); _workerMsgOwner.clear();
        }, { once: true });

        _workerIdx = -1;
        return _analysisWorkers[0];
      }

      async function analyzeImageDataWorker(input, sw, sh) {
        const worker = getAnalysisWorker();
        if (!worker) {
          if (input.type === 'frame') { input.frame.close(); return null; }
          if (input.type === 'bitmap') { input.bitmap.close(); return null; }
          return computeFullAnalysis(input.data, sw, sh);
        }

        const id = nextWorkerId();
        const currentWorkerIndex = _workerIdx % _WORKER_POOL_SIZE;

        _workerMsgOwner.set(id, currentWorkerIndex);

        return new Promise((resolve, reject) => {
          let settled = false;

          const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            _workerPending.delete(id);
            _workerMsgOwner.delete(id);
            reject(new Error('Worker timeout'));
          }, WORKER_MSG_TIMEOUT_MS);

          _workerPending.set(id, {
            resolve: (res) => {
              if (settled) return; settled = true;
              clearTimeout(timeoutId); resolve(res);
            },
            reject: (err) => {
              if (settled) return; settled = true;
              clearTimeout(timeoutId); reject(err);
            },
            _timeoutId: timeoutId,
            _startTime: performance.now()
          });

          try {
            if (input.type === 'frame') {
              worker.postMessage({ type: 'frame', frame: input.frame, sw, sh, id }, [input.frame]);
            } else if (input.type === 'bitmap') {
              worker.postMessage({ type: 'bitmap', bitmap: input.bitmap, sw, sh, id }, [input.bitmap]);
            } else {
              const rawBuf = input.data.buffer;
              const byteOff = input.data.byteOffset;
              const byteLen = input.data.byteLength;
              worker.postMessage(
                { type: 'buffer', buf: rawBuf, byteOffset: byteOff, byteLength: byteLen, sw, sh, id },
                [rawBuf]
              );
            }
          } catch (e) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              _workerPending.delete(id);
              _workerMsgOwner.delete(id);
              reject(e);
            }
          }
        });
      }

      let gpuAnalyzer = null; let gpuInitAttempted = false;
      async function ensureGPUAnalyzer() {
        if (gpuInitAttempted) return gpuAnalyzer?.isReady() || false;
        gpuInitAttempted = true;
        if (!FEATURE_FLAGS.gpuAnalysis) return false;
        try { gpuAnalyzer = createWebGPUAnalyzer(); const ok = await gpuAnalyzer.initGPU(); if (ok) { log.info('[AutoScene] WebGPU analyzer ready — GPU offload active'); return true; } log.info('[AutoScene] WebGPU unavailable — using CPU analysis'); return false; }
        catch (e) { log.warn('[AutoScene] GPU init error:', e.message); return false; }
      }

      let __gpuConsecutiveFailures = 0;
      const GPU_MAX_CONSECUTIVE_FAILURES = 5;
      let _pendingAnalysisCount = 0;
      const MAX_PENDING_ANALYSES = 2;

      async function analyzeImageData(input, sw, sh) {
        if (_pendingAnalysisCount >= MAX_PENDING_ANALYSES) {
          if (input.type === 'frame') { try { input.frame.close(); } catch (_) {} }
          if (input.type === 'bitmap') { try { input.bitmap.close(); } catch (_) {} }
          return null;
        }
        _pendingAnalysisCount++;
        try {
          if (input.type === 'frame' || input.type === 'bitmap') return await analyzeImageDataWorker(input, sw, sh);

          if (AUTO._gpuActive && gpuAnalyzer?.isReady()) {
            try {
              const result = await gpuAnalyzer.analyzeFrame(input.data, sw, sh);
              if (result) { __gpuConsecutiveFailures = 0; return result; }
              __gpuConsecutiveFailures++;
              if (__gpuConsecutiveFailures >= GPU_MAX_CONSECUTIVE_FAILURES) { AUTO._gpuActive = false; log.warn('[AutoScene] GPU path disabled after repeated failures'); }
            } catch (e) {
              __gpuConsecutiveFailures++;
              if (__gpuConsecutiveFailures >= GPU_MAX_CONSECUTIVE_FAILURES) { AUTO._gpuActive = false; }
              log.warn('[AutoScene] GPU analyzeFrame error:', e.message);
            }
          }
          if (_analysisWorkers !== null || typeof Worker !== 'undefined') {
            try { return await analyzeImageDataWorker(input, sw, sh); }
            catch (e) { log.warn('[AutoScene] Worker 분석 실패, CPU fallback:', e.message); }
          }
          return computeFullAnalysis(input.data, sw, sh);
        } finally {
          _pendingAnalysisCount--;
        }
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
          const bin = Math.min(bins - 1, ((i / (TONE_STEPS - 1)) * (bins - 1)) | 0); let totalWeight = 0, totalVal = 0;
          for (let zi = 0; zi < ZONE_COUNT; zi++) {
            if (zoneCounts[zi] < 4) continue;
            const w = _ZONE_WEIGHTS[zi];
            totalVal += _claheZoneCDFPool[zi][bin] * w; totalWeight += w;
          }
          curve[i] = totalWeight > 0 ? totalVal / totalWeight : i / (TONE_STEPS - 1);
        }
        for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
        return curve.slice();
      }

      function buildAdaptiveToneCurve(lumHist, totalSamples, params, zoneHists, zoneCounts) {
        const { clipLimit = 2.5, shadowProtect = 0.4, highlightProtect = 0.3, midtoneBoost = 0.0, strength = 0.35, userMods = {} } = params;
        const recMod = userMods.recovery || 0; const shadMod = userMods.shadow || 0; const brtMod = userMods.brightness || 0;
        const finalClipLimit = clipLimit + (recMod * 0.8); const equalized = buildZonalCLAHE(zoneHists, zoneCounts, finalClipLimit);
        const identity = new Float32Array(TONE_STEPS); for (let i = 0; i < TONE_STEPS; i++) identity[i] = i / (TONE_STEPS - 1); const raw = new Float32Array(TONE_STEPS);
        const finalShadowProtect = Math.max(0, shadowProtect - (shadMod * 0.18)); const finalHighlightProtect = Math.max(0, highlightProtect - (brtMod * 0.14)); const shadowLift = shadMod * 0.055;
        for (let i = 0; i < TONE_STEPS; i++) {
          const x = i / (TONE_STEPS - 1); const eq = equalized[i], id = identity[i]; let regionWeight = 1.0;
          if (x < 0.18) { const t = x / 0.18; regionWeight = 1.0 - finalShadowProtect * (1 - t * t); }
          else if (x > 0.82) { const t = (x - 0.82) / 0.18; regionWeight = 1.0 - finalHighlightProtect * (t * t); }
          let midBoost = 0; if (Math.abs(midtoneBoost) > 0.001) { const midW = Math.exp(-((x - 0.5) * (x - 0.5)) / (2 * 0.14 * 0.14)); midBoost = midtoneBoost * midW * 0.15; }
          const effectiveStrength = strength * regionWeight; const lowEndLift = (x < 0.3) ? shadowLift * (1 - x / 0.3) : 0;
          raw[i] = clamp(id * (1 - effectiveStrength) + eq * effectiveStrength + midBoost + lowEndLift, 0, 1);
        }
        const curve = new Float32Array(TONE_STEPS); curve[0] = raw[0]; curve[TONE_STEPS - 1] = raw[TONE_STEPS - 1];
        for (let i = 1; i < TONE_STEPS - 1; i++) curve[i] = raw[i] * 0.6 + (raw[i - 1] + raw[i + 1]) * 0.2;
        for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }

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
          for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
        }

        return curve;
      }

      function computeChannelBalance(rHist, gHist, bHist, totalSamples, skinRatio, hiLumaRBratio) {
        const correctionStrength = 0.12;
        const n = Math.max(1, totalSamples);

        let rMean = 0, gMean = 0, bMean = 0;
        for (let i = 0; i < HIST_BINS; i++) {
          const v = i / (HIST_BINS - 1);
          rMean += v * rHist[i]; gMean += v * gHist[i]; bMean += v * bHist[i];
        }
        rMean /= n; gMean /= n; bMean /= n;
        const avgMean = (rMean + gMean + bMean) / 3;
        if (avgMean < 0.01) return { rGain: 1, gGain: 1, bGain: 1 };

        let rHiMean = 0, gHiMean = 0, bHiMean = 0, hiCount = 0;
        for (let i = 180; i < HIST_BINS; i++) {
          const v = i / (HIST_BINS - 1);
          rHiMean += v * rHist[i]; gHiMean += v * gHist[i]; bHiMean += v * bHist[i];
          hiCount += (rHist[i] + gHist[i] + bHist[i]) / 3;
        }
        const hasHighlights = hiCount > n * 0.02;
        if (hasHighlights && hiCount > 0) {
          rHiMean /= hiCount; gHiMean /= hiCount; bHiMean /= hiCount;
        }

        const skinDampen = clamp(skinRatio || 0, 0, 0.4) / 0.4;
        const rMul = 0.45 * (1 - skinDampen * 0.70);
        const bMul = 0.55;

        let rGain = 1 + (avgMean / Math.max(0.01, rMean) - 1) * (correctionStrength * rMul);
        let gGain = 1 + (avgMean / Math.max(0.01, gMean) - 1) * (correctionStrength * 0.75);
        let bGain = 1 + (avgMean / Math.max(0.01, bMean) - 1) * (correctionStrength * bMul);

        if (Number.isFinite(hiLumaRBratio) && hiLumaRBratio > 0) {
          const deviation = clamp(hiLumaRBratio - 1.0, -0.3, 0.3);
          const tempCorr = deviation * 0.18;
          rGain -= tempCorr * 0.5;
          bGain += tempCorr * 0.5;
        }

        if (hasHighlights) {
          const hiAvg = (rHiMean + gHiMean + bHiMean) / 3;
          if (hiAvg > 0.01) {
            const hiRBratio = rHiMean / Math.max(0.01, bHiMean);
            const hiNeutrality = 1.0 - clamp(Math.abs(hiRBratio - 1.0) * 5, 0, 0.8);
            const dampFactor = hiNeutrality * 0.45;
            rGain = rGain + (1.0 - rGain) * dampFactor;
            bGain = bGain + (1.0 - bGain) * dampFactor;
          }
        }

        return { rGain: clamp(rGain, 0.92, 1.08), gGain: clamp(gGain, 0.94, 1.06), bGain: clamp(bGain, 0.90, 1.10) };
      }

      const __fuzzyScores = new Float64Array(ST_COUNT); const __fuzzyEma = new Float64Array(ST_COUNT); let __fuzzyInited = false;
      let __fuzzyLastVideoId = null;

      function classifySceneFuzzy(stats, zoneStats, currentVideo) {
        const scores = __fuzzyScores; scores.fill(0); const br = stats.bright, ct = stats.contrast, ch = stats.chroma, sk = stats.skinRatio;
        scores[ST.NORMAL] = 1.0;
        if (br < 0.32) scores[ST.LOW_KEY] += (0.32 - br) / 0.32 * 3.0;
        if (ct < 0.18) scores[ST.LOW_KEY] += (0.18 - ct) / 0.18 * 1.5;
        if (br > 0.65) scores[ST.HIGH_KEY] += (br - 0.65) / 0.35 * 2.8;
        if (ct > 0.28) scores[ST.HIGH_CONTRAST] += (ct - 0.28) / 0.28 * 2.4;
        if (ch < 0.10) scores[ST.LOW_SAT] += (0.10 - ch) / 0.10 * 2.2;
        if (sk > 0.05) scores[ST.SKIN] += (sk - 0.05) / 0.10 * 2.4;
        if (zoneStats) { const centerBr = zoneStats.centerBright, edgeBr = zoneStats.edgeAvgBright; if (edgeBr > 0.42 && centerBr < 0.40) { const gap = edgeBr - centerBr; if (gap > 0.12) scores[ST.BACKLIT] += gap / 0.20 * 3.5; } }

        const videoChanged = currentVideo !== __fuzzyLastVideoId;
        if (videoChanged) { __fuzzyLastVideoId = currentVideo; __fuzzyInited = false; }
        const emaAlpha = videoChanged ? 1.0 : (stats._isCut ? 0.42 : 0.11);

        if (!__fuzzyInited) { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] = scores[i]; __fuzzyInited = true; } else { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] += (scores[i] - __fuzzyEma[i]) * emaAlpha; }
        let bestIdx = 0, bestVal = __fuzzyEma[0]; for (let i = 1; i < ST_COUNT; i++) { if (__fuzzyEma[i] > bestVal) { bestVal = __fuzzyEma[i]; bestIdx = i; } } return bestIdx;
      }

      const SCENE_TONE_PARAMS = Object.freeze({
        [ST.NORMAL]:        { clipLimit: 2.8, shadowProtect: 0.30, highlightProtect: 0.28, midtoneBoost: 0.06, strength: 0.30, satTarget: 1.08 },
        [ST.LOW_KEY]:       { clipLimit: 3.8, shadowProtect: 0.22, highlightProtect: 0.12, midtoneBoost: 0.18, strength: 0.46, satTarget: 1.15 },
        [ST.HIGH_KEY]:      { clipLimit: 2.2, shadowProtect: 0.15, highlightProtect: 0.50, midtoneBoost: -0.10, strength: 0.22, satTarget: 1.06 },
        [ST.HIGH_CONTRAST]: { clipLimit: 2.2, shadowProtect: 0.42, highlightProtect: 0.42, midtoneBoost: 0.0,  strength: 0.18, satTarget: 1.05 },
        [ST.LOW_SAT]:       { clipLimit: 3.4, shadowProtect: 0.26, highlightProtect: 0.22, midtoneBoost: 0.10, strength: 0.44, satTarget: 1.32 },
        [ST.SKIN]:          { clipLimit: 2.4, shadowProtect: 0.40, highlightProtect: 0.34, midtoneBoost: 0.04, strength: 0.20, satTarget: 1.06 },
        [ST.BACKLIT]:       { clipLimit: 4.2, shadowProtect: 0.08, highlightProtect: 0.52, midtoneBoost: 0.22, strength: 0.54, satTarget: 1.16 }
      });

      let prevToneCurve = null; let prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; let prevSatMul = 1.0;
      const _interpBufA = new Float32Array(TONE_STEPS); const _interpBufB = new Float32Array(TONE_STEPS); let _interpActive = 0;
      function interpolateCurves(prev, next, alpha) { if (!prev) { const out = _interpActive === 0 ? _interpBufA : _interpBufB; out.set(next); _interpActive ^= 1; return out; } const out = _interpActive === 0 ? _interpBufA : _interpBufB; for (let i = 0; i < TONE_STEPS; i++) out[i] = prev[i] + (next[i] - prev[i]) * alpha; _interpActive ^= 1; return out; }
      function interpolateGains(prev, next, alpha) {
        const rDelta = Math.abs(next.rGain - prev.rGain);
        const bDelta = Math.abs(next.bGain - prev.bGain);
        const maxDelta = Math.max(rDelta, bDelta);
        let effectiveAlpha = alpha;
        if (maxDelta > 0.03) effectiveAlpha *= clamp(0.03 / maxDelta, 0.3, 1.0);
        return { rGain: prev.rGain + (next.rGain - prev.rGain) * effectiveAlpha, gGain: prev.gGain + (next.gGain - prev.gGain) * effectiveAlpha, bGain: prev.bGain + (next.bGain - prev.bGain) * effectiveAlpha };
      }

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
      function getTemporalAlpha(isCut, isFade) { const base = isCut ? 0.44 : (isFade ? 0.18 : 0.10); return base / (1 + flickerCount * 0.7); }

      function computeFullAnalysis(data, sw, sh) {
        const step = 2; let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0, skinCount = 0, edgePairCount = 0;
        const iabs = (x) => (x ^ (x >> 31)) - (x >> 31);
        const lumHist = _pool_lumHist; lumHist.fill(0); const rHist = _pool_rHist; rHist.fill(0); const gHist = _pool_gHist; gHist.fill(0); const bHist = _pool_bHist; bHist.fill(0);
        const zoneCounts = _pool_zoneCounts; zoneCounts.fill(0); const zoneHists = _pool_zoneHists; for (let z = 0; z < ZONE_COUNT; z++) zoneHists[z].fill(0);
        const zoneBrightSum = _pool_zoneBrightSum; zoneBrightSum.fill(0);
        const pixelCount = sw * sh; if (!__curLumBuf || __curLumBufSize !== pixelCount) { __curLumBuf = new Uint8Array(pixelCount); __curLumBufSize = pixelCount; }
        const curLum = __curLumBuf; let hiLumaRSum = 0, hiLumaBSum = 0, hiLumaCount = 0; const HI_LUMA_THR = 180;
        const { zxLut, zyLut } = getZoneLuts(sw, sh);

        const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
        const maxX = sw - step;

        for (let y = 0; y < sh; y += step) {
          const rowOff = y * sw; const zyBase = zyLut[y] << 2;
          const xEnd = (maxX - 3 * step) | 0;
          let x = 0;

          for (; x <= xEnd; x += step * 4) {
            const px0 = u32[rowOff + x], px1 = u32[rowOff + x + step];
            const px2 = u32[rowOff + x + step * 2], px3 = u32[rowOff + x + step * 3];

            const r0 = px0 & 0xFF, g0 = (px0 >>> 8) & 0xFF, b0 = (px0 >>> 16) & 0xFF;
            const r1 = px1 & 0xFF, g1 = (px1 >>> 8) & 0xFF, b1 = (px1 >>> 16) & 0xFF;
            const r2 = px2 & 0xFF, g2 = (px2 >>> 8) & 0xFF, b2 = (px2 >>> 16) & 0xFF;
            const r3 = px3 & 0xFF, g3 = (px3 >>> 8) & 0xFF, b3 = (px3 >>> 16) & 0xFF;

            const l0 = (r0 * 54 + g0 * 183 + b0 * 18 + 128) >> 8;
            const l1 = (r1 * 54 + g1 * 183 + b1 * 18 + 128) >> 8;
            const l2 = (r2 * 54 + g2 * 183 + b2 * 18 + 128) >> 8;
            const l3 = (r3 * 54 + g3 * 183 + b3 * 18 + 128) >> 8;

            lumHist[l0]++; lumHist[l1]++; lumHist[l2]++; lumHist[l3]++;
            rHist[r0]++; rHist[r1]++; rHist[r2]++; rHist[r3]++;
            gHist[g0]++; gHist[g1]++; gHist[g2]++; gHist[g3]++;
            bHist[b0]++; bHist[b1]++; bHist[b2]++; bHist[b3]++;

            sum += l0 + l1 + l2 + l3;
            sum2 += l0 * l0 + l1 * l1 + l2 * l2 + l3 * l3;
            count += 4;

            sumEdge += iabs(l0 - l1) + iabs(l1 - l2) + iabs(l2 - l3);
            edgePairCount += 3;

            const pi0 = rowOff + x;
            curLum[pi0] = l0; curLum[pi0 + step] = l1;
            curLum[pi0 + step * 2] = l2; curLum[pi0 + step * 3] = l3;

            let a0 = r0, b0_ = g0, c0 = b0; if (a0 > b0_) { const t = a0; a0 = b0_; b0_ = t; } if (a0 > c0) { const t = a0; a0 = c0; c0 = t; } if (b0_ > c0) { const t = b0_; b0_ = c0; c0 = t; }
            let a1 = r1, b1_ = g1, c1 = b1; if (a1 > b1_) { const t = a1; a1 = b1_; b1_ = t; } if (a1 > c1) { const t = a1; a1 = c1; c1 = t; } if (b1_ > c1) { const t = b1_; b1_ = c1; c1 = t; }
            let a2 = r2, b2_ = g2, c2 = b2; if (a2 > b2_) { const t = a2; a2 = b2_; b2_ = t; } if (a2 > c2) { const t = a2; a2 = c2; c2 = t; } if (b2_ > c2) { const t = b2_; b2_ = c2; c2 = t; }
            let a3 = r3, b3_ = g3, c3 = b3; if (a3 > b3_) { const t = a3; a3 = b3_; b3_ = t; } if (a3 > c3) { const t = a3; a3 = c3; c3 = t; } if (b3_ > c3) { const t = b3_; b3_ = c3; c3 = t; }
            sumChroma += (c0 - a0) + (c1 - a1) + (c2 - a2) + (c3 - a3);

            const zi0 = zyBase + zxLut[x], zi1 = zyBase + zxLut[x + step];
            const zi2 = zyBase + zxLut[x + step * 2], zi3 = zyBase + zxLut[x + step * 3];
            zoneHists[zi0][l0]++; zoneCounts[zi0]++; zoneBrightSum[zi0] += l0;
            zoneHists[zi1][l1]++; zoneCounts[zi1]++; zoneBrightSum[zi1] += l1;
            zoneHists[zi2][l2]++; zoneCounts[zi2]++; zoneBrightSum[zi2] += l2;
            zoneHists[zi3][l3]++; zoneCounts[zi3]++; zoneBrightSum[zi3] += l3;

            if (l0 >= HI_LUMA_THR && b0 > 10) { hiLumaRSum += r0; hiLumaBSum += b0; hiLumaCount++; }
            if (l1 >= HI_LUMA_THR && b1 > 10) { hiLumaRSum += r1; hiLumaBSum += b1; hiLumaCount++; }
            if (l2 >= HI_LUMA_THR && b2 > 10) { hiLumaRSum += r2; hiLumaBSum += b2; hiLumaCount++; }
            if (l3 >= HI_LUMA_THR && b3 > 10) { hiLumaRSum += r3; hiLumaBSum += b3; hiLumaCount++; }

            skinCount += ((r0 - g0 > 12) & (r0 >= 80) & (g0 >= 35) & (b0 >= 20) & (r0 > b0))
                       + ((r1 - g1 > 12) & (r1 >= 80) & (g1 >= 35) & (b1 >= 20) & (r1 > b1))
                       + ((r2 - g2 > 12) & (r2 >= 80) & (g2 >= 35) & (b2 >= 20) & (r2 > b2))
                       + ((r3 - g3 > 12) & (r3 >= 80) & (g3 >= 35) & (b3 >= 20) & (r3 > b3));
          }

          for (; x <= maxX; x += step) {
            const pi = rowOff + x; const px = u32[pi];
            const r = px & 0xFF, g = (px >>> 8) & 0xFF, b = (px >>> 16) & 0xFF;
            const l = (r * 54 + g * 183 + b * 18 + 128) >> 8;

            let a = r, b_ = g, c = b; if (a > b_) { const t = a; a = b_; b_ = t; } if (a > c) { const t = a; a = c; c = t; } if (b_ > c) { const t = b_; b_ = c; c = t; }
            sumChroma += (c - a);

            curLum[pi] = l; sum += l; sum2 += l * l; count++;
            lumHist[l]++; rHist[r]++; gHist[g]++; bHist[b]++;

            if (x + step < sw) {
              const npx = u32[rowOff + x + step];
              const nl = ((npx & 0xFF) * 54 + ((npx >>> 8) & 0xFF) * 183 + ((npx >>> 16) & 0xFF) * 18 + 128) >> 8;
              sumEdge += iabs(l - nl); edgePairCount++;
            }

            skinCount += ((r - g > 12) & (r >= 80) & (g >= 35) & (b >= 20) & (r > b)) | 0;

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
              for (let dy = 0; dy < bh; dy += step) {
                for (let dx = 0; dx < bw; dx += step) {
                  const pi = (by + dy) * sw + (bx + dx);
                  const d = curLum[pi] - __prevLumBuf[pi];
                  blockSad += (d ^ (d >> 31)) - (d >> 31);
                }
              }
              sadSum += blockSad; sadCount++;
            }
          }
          motionSAD = sadCount > 0 ? (sadSum / sadCount) / 255 : 0;
        }
        if (!__prevLumBuf || __prevLumBuf.length !== pixelCount) __prevLumBuf = new Uint8Array(pixelCount);
        __prevLumBuf.set(curLum);

        const n = Math.max(1, count); const mean = sum / n, std = Math.sqrt(Math.max(0, (sum2 / n) - mean * mean));

        let centerSum = 0, centerCnt = 0;
        for (let mask = CENTER_ZONE_MASK; mask; mask &= mask - 1) {
          const ci = 31 - Math.clz32(mask);
          if (zoneCounts[ci] > 0) { centerSum += zoneBrightSum[ci] / zoneCounts[ci]; centerCnt++; }
        }
        const centerBright = centerCnt > 0 ? centerSum / centerCnt / 255 : mean / 255;

        let edgeSum = 0, edgeCount = 0;
        for (let z = 0; z < ZONE_COUNT; z++) {
          if ((CENTER_ZONE_MASK >> z) & 1) continue;
          if (zoneCounts[z] > 0) { edgeSum += zoneBrightSum[z] / zoneCounts[z]; edgeCount++; }
        }
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
        drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0, boostMs: 700, minFps: 1.0, maxFps: CONFIG.IS_MOBILE ? 5 : 9, curFps: 2,
        _sceneType: ST.NORMAL, _sceneStable: 0, _sceneTypeEma: ST.NORMAL, _lastMean: 0, _framesSinceUpdate: 0, _gpuActive: false,
        _lastCurrentTime: -1
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
        const alpha = _fpsHistBuf.length >= 6 ? 0.16667 : (1 / _fpsHistBuf.length);
        _fpsMotionAvg = _fpsMotionAvg * (1 - alpha) + motionSAD * alpha;
        let target;
        if      (_fpsMotionAvg < 0.02) target = 2;
        else if (_fpsMotionAvg < 0.08) target = 3 + _fpsMotionAvg / 0.08 * 2;
        else                           target = 5 + Math.min((_fpsMotionAvg - 0.08) / 0.25, 1) * 3;
        if (isCut)       target = AUTO.maxFps;
        else if (isFade) target = Math.max(target, 5);
        AUTO.curFps += clamp(target - AUTO.curFps, -1.5, 1.5);
        return clamp(AUTO.curFps, AUTO.minFps, AUTO.maxFps);
      }

      async function captureSceneFrame(v) {
        if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }

        if (typeof VideoFrame === 'function' && _analysisWorkers) {
          try {
            const frame = new VideoFrame(v, { timestamp: (v.currentTime * 1e6) | 0 });
            return { type: 'frame', frame };
          } catch (_) {}
        }

        if (typeof createImageBitmap === 'function') {
          try {
            const bmp = await createImageBitmap(v, {
              resizeWidth: CANVAS_W, resizeHeight: CANVAS_H, resizeQuality: 'pixelated'
            });
            if (_analysisWorkers) return { type: 'bitmap', bitmap: bmp };
            cvCtx.drawImage(bmp, 0, 0);
            bmp.close();
            return { type: 'buffer', data: cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H).data };
          } catch (_) {}
        }

        try {
          cvCtx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H);
          return { type: 'buffer', data: cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H).data };
        } catch (_) { return null; }
      }

      const STATIC_SCENE_FORCE_INTERVAL = 20;

      let __letterboxState = { detected: false, ratio: 0, lastCheck: 0, notified: false };
      const LETTERBOX_CHECK_INTERVAL = 5000;
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
        const isLetterbox = topBlackRatio > 0.90 && bottomBlackRatio > 0.90 && middleBlackRatio < 0.50;

        if (isLetterbox && !__letterboxState.detected) {
          __letterboxState.detected = true; __letterboxState.ratio = 2.35;
          if (!__letterboxState.notified) {
            __letterboxState.notified = true;
            try { if (typeof showOSD === 'function') showOSD('레터박스 감지됨 — Alt+Z로 줌 활성화 후 Alt+Wheel로 조절', 3000); } catch(_) {}
          }
        } else if (!isLetterbox && __letterboxState.detected) {
          __letterboxState.detected = false; __letterboxState.notified = false;
        }
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

        const ct = v.currentTime;
        const isStaticFrame = Math.abs(ct - AUTO._lastCurrentTime) < 0.001;
        const forceByStatic = AUTO._framesSinceUpdate >= STATIC_SCENE_FORCE_INTERVAL;

        if (isStaticFrame && !forceByStatic) {
          scheduleNext(v, Math.max(200, Math.round(1000 / Math.max(1, AUTO.curFps))));
          return;
        }
        AUTO._lastCurrentTime = ct;

        if (!gpuInitAttempted && FEATURE_FLAGS.gpuAnalysis) {
          const gpuOk = await ensureGPUAnalyzer();
          AUTO._gpuActive = gpuOk;
          if (gpuOk) log.info('[AutoScene] GPU analysis path activated');
        }

        try {
          const input = await captureSceneFrame(v);
          if (!AUTO.running || __globalSig.aborted) return;
          if (!v.isConnected || v.paused || v.readyState < 2) { scheduleNext(v, 300); return; }
          if (!input) { scheduleNext(v, 500); return; }

          AUTO.drmBlocked = false; drmRetryCount = 0;
          const stats = await analyzeImageData(input, CANVAS_W, CANVAS_H);
          if (!AUTO.running || __globalSig.aborted) return;

          AUTO.motionEma = AUTO.motionEma * (1 - AUTO.motionAlpha) + stats.motionSAD * AUTO.motionAlpha; AUTO.motionFrames = AUTO.motionEma >= AUTO.motionThresh ? AUTO.motionFrames + 1 : 0; if (typeof updateAdaptiveRectTTL === 'function') updateAdaptiveRectTTL(AUTO.motionEma);
          const transition = detectTransition(stats, AUTO.lastStats); AUTO.lastStats = stats;
          if (!AUTO.statsEma) AUTO.statsEma = { ...stats }; else { const a = transition.isCut ? 0.55 : 0.14; const e = AUTO.statsEma; for (const k of ['bright', 'contrast', 'chroma', 'edge', 'skinRatio', 'centerBright', 'edgeAvgBright']) e[k] = (e[k] ?? stats[k]) * (1 - a) + stats[k] * a; }

          const newScene = classifySceneFuzzy(AUTO.statsEma, stats.zoneStats, v); if (newScene !== AUTO._sceneType) AUTO._sceneStable = 0; else AUTO._sceneStable++;
          AUTO._sceneType = newScene; if (AUTO._sceneStable >= 4) AUTO._sceneTypeEma = newScene;
          if (transition.isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; flickerCount = Math.max(0, flickerCount - 2); }

          AUTO._framesSinceUpdate++; const allowUpdate = transition.isCut || transition.isFade || AUTO.motionFrames >= 4 || forceByStatic;
          let fps = AUTO.curFps;
          if (allowUpdate) {
            AUTO._framesSinceUpdate = 0; fps = adaptiveFps(stats.motionSAD, transition.isCut, transition.isFade); if (now < AUTO.tBoostUntil) fps = Math.max(fps, transition.isCut ? AUTO.maxFps : 5);
            const sceneType = AUTO._sceneTypeEma;
            const toneParams = { ...SCENE_TONE_PARAMS[sceneType], userMods: {} };
            const rawCurve = buildAdaptiveToneCurve(stats.lumHist, stats.totalSamples, toneParams, stats.zoneHists, stats.zoneCounts);
            const rawGains = computeChannelBalance(stats.rHist, stats.gHist, stats.bHist, stats.totalSamples, stats.skinRatio, stats.hiLumaRBratio);
            const rawSat = toneParams.satTarget;

            const alphaTone = getTemporalAlpha(transition.isCut, transition.isFade);
            const alphaColor = transition.isCut ? 0.55 : (transition.isFade ? 0.15 : 0.05);
            const alphaSat = transition.isCut ? 0.65 : (transition.isFade ? 0.20 : 0.08);

            const newMid = rawCurve[128], oldMid = prevToneCurve ? prevToneCurve[128] : 0.5; const dir = newMid > oldMid ? 1 : (newMid < oldMid ? -1 : 0);
            if (dir !== 0 && dir !== lastCurveDir && lastCurveDir !== 0) flickerCount = Math.min(flickerCount + 1, FLICKER_MAX); else if (dir !== 0) flickerCount = Math.max(0, flickerCount - FLICKER_DECAY); lastCurveDir = dir || lastCurveDir;

            const smoothedCurve = interpolateCurves(prevToneCurve, rawCurve, alphaTone);
            const smoothedGains = interpolateGains(prevChannelGains, rawGains, alphaColor);
            const smoothedSat = prevSatMul + (rawSat - prevSatMul) * alphaSat;

            if (!prevToneCurve) prevToneCurve = new Float32Array(TONE_STEPS); prevToneCurve.set(smoothedCurve); prevChannelGains = smoothedGains; prevSatMul = smoothedSat;

            const result = curveToApproxParams(smoothedCurve, smoothedSat, smoothedGains);
            result.br = clamp(result.br, 0.88, 1.45);

            const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat;
            AUTO.cur.br = result.br; AUTO.cur.ct = result.ct; AUTO.cur.sat = result.sat; AUTO.cur._toneCurve = smoothedCurve; AUTO.cur._channelGains = smoothedGains; AUTO.cur._gamma = result._gamma; AUTO.cur._bright = result._bright; AUTO.cur._temp = result._temp;
            if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001) {
              _autoSceneRev++;
              Scheduler.request(true);
            }
          }

          if (stats.zoneHists && stats.zoneCounts) detectLetterbox(stats.lumHist, stats.zoneHists, stats.zoneCounts);

          scheduleNext(v, Math.max(100, Math.round(1000 / Math.max(1, fps))));
        } catch (e) {
          if (!AUTO.running || __globalSig.aborted) return;

          const isDrm = (e.name === 'SecurityError' || e.message?.includes('tainted'));
          if (VSC_DEFENSE.autoSceneDrmBackoff && isDrm) {
            drmRetryCount++; AUTO.drmBlocked = true; if (AUTO._gpuActive) { AUTO._gpuActive = false; log.info('[AutoScene] GPU path disabled due to DRM taint'); }
            if (drmRetryCount >= MAX_DRM_RETRIES) { AUTO.running = false; updateManual(); Store.set(P.APP_AUTO_SCENE, false); try{ if (typeof showOSD === 'function') showOSD('자동 장면: DRM 제한으로 비활성화됨', 3000); }catch(_){} Scheduler.request(true); return; }
            scheduleNext(v, Math.min(30000, 8000 * Math.pow(1.5, drmRetryCount - 1)));
          } else scheduleNext(v, 1000);
        }
      }

      function resetAllModuleState() {
        AUTO.statsEma = null; AUTO.lastStats = null; AUTO._lastMean = 0; AUTO._sceneStable = 0; AUTO._sceneTypeEma = ST.NORMAL; AUTO._sceneType = ST.NORMAL;
        AUTO.motionEma = 0; AUTO.motionFrames = 0; AUTO.curFps = 2; AUTO._framesSinceUpdate = 0; _fpsHistBuf.clear(); prevToneCurve = null; prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; prevSatMul = 1.0;
        cutScores.clear(); gradualScores.clear(); flickerCount = 0; lastCurveDir = 0; __prevLumBuf = null; __curLumBuf = null; __curLumBufSize = 0; __fuzzyInited = false; __fuzzyEma.fill(0); _interpActive = 0;
        _fpsMotionAvg = 0; AUTO._lastCurrentTime = -1; __fuzzyLastVideoId = null;
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
          AUTO.running = false;
          cleanupScheduler();
          resetAllModuleState();
          updateManual();
        }
      });
      Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } });

      return {
        getMods: () => AUTO.cur,
        getAutoSceneRev: () => _autoSceneRev,
        getSceneType: () => AUTO._sceneType,
        getSceneTypeName: () => ST_NAMES[AUTO._sceneType] || 'UNKNOWN',
        hasToneCurve: () => !!AUTO.cur._toneCurve,
        isGpuActive: () => AUTO._gpuActive,
        getLastMotionSAD: () => AUTO.motionEma,
        start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } },
        stop: () => { AUTO.running = false; cleanupScheduler(); resetAllModuleState(); updateManual(); },
        diagnoseSubtitleTint() {
          const mods = AUTO.cur;
          if (!mods._channelGains) return { status: 'no_auto', tint: 'none' };

          const ag = mods._channelGains;
          const userTemp = tempToRgbGain(Store?.get(P.V_MAN_TEMP) || 0);

          let fR = userTemp.rs * ag.rGain;
          let fG = userTemp.gs * ag.gGain;
          let fB = userTemp.bs * ag.bGain;

          const lumAvg = fR * 0.2126 + fG * 0.7152 + fB * 0.0722;
          if (lumAvg > 0.01) {
            const scale = 1.0 / lumAvg;
            fR *= scale; fG *= scale; fB *= scale;
          }

          const deltaRB = ((fR - fB) * 255).toFixed(1);
          const tint = fR > fB + 0.005 ? 'warm(붉은끼)' :
                       fB > fR + 0.005 ? 'cool(푸른끼)' : 'neutral';

          return {
            channelGains: { r: ag.rGain.toFixed(4), g: ag.gGain.toFixed(4), b: ag.bGain.toFixed(4) },
            finalSlopes:  { r: fR.toFixed(4), g: fG.toFixed(4), b: fB.toFixed(4) },
            whiteSubtitleDeltaRB: deltaRB,
            tint,
            scene: AUTO._sceneTypeEma !== undefined ? ST_NAMES[AUTO._sceneTypeEma] : 'unknown'
          };
        }
      };
    }

    /* ══ curveToApproxParams ══ */
    function curveToApproxParams(curve, satMul, channelGains) {
      const clamp = VSC_CLAMP; const N = 32; const curveLen = curve.length; const step = (curveLen - 1) / (N - 1);
      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
      for (let i = 0; i < N; i++) { const ci = Math.min(curveLen - 1, Math.round(step * i)); const x = ci / (curveLen - 1), y = curve[ci], x2 = x * x; S0 += 1; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; T0 += y; T1 += x * y; T2 += x2 * y; }
      const D = S4 * (S2 * S0 - S1 * S1) - S3 * (S3 * S0 - S1 * S2) + S2 * (S3 * S1 - S2 * S2); let a2, a1, a0;
      if (Math.abs(D) < 1e-12) { a2 = 0; a1 = 1; a0 = 0; } else { const invD = 1 / D; a2 = (T2 * (S2 * S0 - S1 * S1) - S3 * (T1 * S0 - S1 * T0) + S2 * (T1 * S1 - S2 * T0)) * invD; a1 = (S4 * (T1 * S0 - S1 * T0) - T2 * (S3 * S0 - S1 * S2) + S2 * (S3 * T0 - T1 * S2)) * invD; a0 = (S4 * (S2 * T0 - S1 * T1) - S3 * (S3 * T0 - T1 * S2) + T2 * (S3 * S1 - S2 * S2)) * invD; }
      if (!Number.isFinite(a2)) a2 = 0; if (!Number.isFinite(a1)) a1 = 1; if (!Number.isFinite(a0)) a0 = 0;
      const mid = clamp(a2 * 0.25 + a1 * 0.5 + a0, 0.01, 0.99); let gamma = 1.0; if (mid > 0.01 && mid < 0.99) { gamma = Math.log(mid) / Math.log(0.5); gamma = clamp(gamma, 0.65, 1.6); }
      const slopeAtMid = 2 * a2 * 0.5 + a1; const contrast = clamp(slopeAtMid, 0.75, 1.35); const curveIntegral = a2 / 3 + a1 / 2 + a0; const brightDiff = curveIntegral - 0.5; const bright = clamp(brightDiff * 45, -12, 12); const tempEstimate = (channelGains.rGain - channelGains.bGain) * 50; const temp = clamp(tempEstimate, -20, 20);
      return { br: clamp(1.0 + bright * 0.010, 0.88, 1.45), ct: clamp(contrast, 0.78, 1.35), sat: clamp(satMul, 0.82, 1.50), _gamma: gamma, _bright: bright, _temp: temp, _channelGains: channelGains, _toneCurve: curve };
    }

    /* ══════════════════════════════════════════════════════════════════
       createVideoMaximizer
       ══════════════════════════════════════════════════════════════════ */
    function createVideoMaximizer(Store, ApplyReq) {
      const MAX_CLASS = 'vsc-vmax-max'; const HIDE_CLASS = 'vsc-vmax-hide'; const ANCESTOR_CLASS = 'vsc-vmax-ancestor'; const IFRAME_MAX_CLASS = 'vsc-vmax-iframe';
      let active = false, targetVideo = null, targetIframe = null;
      const savedStylesSet = new Set(); const savedStylesList = []; let hiddenSiblings = []; let savedScrollX = 0, savedScrollY = 0;
      let classMO = null, isIframeMode = false; let delegatedToTop = false, innerMaxActive = false; const innerSavedStylesSet = new Set(); const innerSavedStylesList = [];

      function isInIframe() { try { return window !== window.top; } catch (_) { return true; } }

      function pickBestVideo() {
        const explicit = window[VSC_INTERNAL_SYM]?._activeVideo;
        if (explicit?.isConnected && explicit.readyState >= 2 && !explicit.ended) return explicit;
        let best = null, bestScore = -1;
        for (const v of document.querySelectorAll('video')) {
          if (!v.isConnected || v.readyState < 1) continue;
          let s = 0; const r = v.getBoundingClientRect(); const area = r.width * r.height;
          if (!v.paused && !v.ended) s += 10; if (!v.muted && v.volume > 0.01) s += 3;
          s += Math.log2(1 + area / 10000); if (v.currentTime > 0.5) s += 2;
          if (s > bestScore) { bestScore = s; best = v; }
        }
        return best;
      }

      function findIframeForWindow(childWin) {
        try { const iframes = document.querySelectorAll('iframe'); for (const ifr of iframes) { try { if (ifr.contentWindow === childWin) return ifr; } catch (_) {} } } catch (_) {}
        return null;
      }

      function backupAndApplyStyle(el, css, isInner = false) {
        const sSet = isInner ? innerSavedStylesSet : savedStylesSet;
        const sList = isInner ? innerSavedStylesList : savedStylesList;
        if (!sSet.has(el)) { sSet.add(el); sList.push(el); }
        for (const [prop, val] of Object.entries(css)) vscSetStyle(el, prop, val, 'important');
      }
      function restoreSavedStyle(el) { if (el) vscClearAllStyles(el); }

      function hideSiblings(el) {
        if (!el.parentNode) return;
        for (const sib of el.parentNode.children) {
          if (sib === el || sib.nodeType !== 1) continue;
          if (sib.tagName === 'SCRIPT' || sib.tagName === 'LINK' || sib.tagName === 'STYLE') continue;
          if (sib.hasAttribute?.('data-vsc-ui') || sib.id === 'vsc-host' || sib.id === 'vsc-gear-host' || sib.id === 'vsc-osd') continue;
          const prevDisplay = sib.style.getPropertyValue('display'), prevDisplayPrio = sib.style.getPropertyPriority('display');
          sib.classList.add(HIDE_CLASS); sib.style.setProperty('display', 'none', 'important');
          hiddenSiblings.push({ el: sib, prevDisplay, prevDisplayPrio });
        }
      }

      let styleInjected = false;
      function injectStyle() {
        if (styleInjected) return; styleInjected = true;
        const s = document.createElement('style'); s.dataset.vscMaximizer = '1';
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
        while (cur && cur !== document.body && cur !== document.documentElement) { classMO.observe(cur, { attributes: true, attributeFilter: ['class'] }); cur = cur.parentElement; }
      }
      function stopClassGuard() { if (classMO) { classMO.disconnect(); classMO = null; } }

      function clearAncestorChain(startEl, isInner = false) {
        let ancestor = startEl.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          ancestor.dataset.vscMaxAncestor = '1';
          backupAndApplyStyle(ancestor, { overflow: 'visible', position: 'static', transform: 'none', clip: 'auto', 'clip-path': 'none', contain: 'none' }, isInner);
          ancestor.classList.add(ANCESTOR_CLASS); hideSiblings(ancestor);
          ancestor = ancestor.parentElement;
        }
      }
      function lockBody(isInner = false) { backupAndApplyStyle(document.body, { overflow: 'hidden', margin: '0', padding: '0' }, isInner); if (document.documentElement) backupAndApplyStyle(document.documentElement, { overflow: 'hidden' }, isInner); }

      function doMaximizeDirect(video) {
        injectStyle(); targetVideo = video; isIframeMode = false; savedScrollX = window.scrollX; savedScrollY = window.scrollY;
        clearAncestorChain(video); lockBody(); backupAndApplyStyle(video, {});
        video.classList.add(MAX_CLASS); hideSiblings(video); window.scrollTo(0, 0);
        startClassGuard(video); active = true; ApplyReq.hard(); try { if (typeof showOSD === 'function') showOSD('최대화 ON (ESC 또는 Alt+M 해제)', 1800); } catch(_) {}
      }

      function doMaximizeIframe(iframeEl) {
        injectStyle(); targetIframe = iframeEl; isIframeMode = true; savedScrollX = window.scrollX; savedScrollY = window.scrollY;
        clearAncestorChain(iframeEl); lockBody(); backupAndApplyStyle(iframeEl, {});
        iframeEl.classList.add(IFRAME_MAX_CLASS); hideSiblings(iframeEl); window.scrollTo(0, 0);
        startClassGuard(iframeEl); active = true; ApplyReq.hard(); try { if (typeof showOSD === 'function') showOSD('최대화 ON — iframe (ESC 또는 Alt+M 해제)', 1800); } catch(_) {}
        try { iframeEl.contentWindow.postMessage({ __vsc_max: 'apply_inner' }, '*'); } catch (_) {}
      }

      function applyInnerMaximize() {
        if (innerMaxActive) return; const video = pickBestVideo(); if (!video) return; innerMaxActive = true;
        backupAndApplyStyle(video, { width: '100vw', height: '100vh', 'object-fit': 'contain', position: 'fixed', top: '0', left: '0', 'z-index': '2147483646', background: '#000', margin: '0', padding: '0', border: 'none' }, true);
        clearAncestorChain(video, true); lockBody(true);
      }
      function undoInnerMaximize() {
        if (!innerMaxActive) return;
        for (let i = innerSavedStylesList.length - 1; i >= 0; i--) { restoreSavedStyle(innerSavedStylesList[i]); }
        innerSavedStylesList.length = 0; innerSavedStylesSet.clear(); innerMaxActive = false;
      }

      function undoMaximize() {
        if (!active) return; stopClassGuard();
        if (isIframeMode && targetIframe) { try { targetIframe.contentWindow.postMessage({ __vsc_max: 'undo_inner' }, '*'); } catch (_) {} try { targetIframe.contentWindow.postMessage({ __vsc_max: 'state_off' }, '*'); } catch (_) {} }
        for (const { el, prevDisplay, prevDisplayPrio } of hiddenSiblings) { try { el.classList.remove(HIDE_CLASS); if (prevDisplay) { el.style.setProperty('display', prevDisplay, prevDisplayPrio || ''); } else { el.style.removeProperty('display'); } } catch (_) {} }
        hiddenSiblings = [];
        for (let i = savedStylesList.length - 1; i >= 0; i--) { const el = savedStylesList[i]; restoreSavedStyle(el); try { el.classList.remove(MAX_CLASS, IFRAME_MAX_CLASS, ANCESTOR_CLASS); delete el.dataset.vscMaxAncestor; } catch (_) {} }
        savedStylesList.length = 0; savedStylesSet.clear(); window.scrollTo(savedScrollX, savedScrollY);
        active = false; targetVideo = null; targetIframe = null; isIframeMode = false;
        ApplyReq.hard(); try { if (typeof showOSD === 'function') showOSD('최대화 OFF', 1200); } catch(_) {}
      }

      function toggle() {
        if (isInIframe()) {
          if (delegatedToTop) { try { window.top.postMessage({ __vsc_max: 'undo' }, '*'); } catch (_) {} delegatedToTop = false; return; }
          try { window.top.postMessage({ __vsc_max: 'request' }, '*'); delegatedToTop = true; } catch (_) { const video = pickBestVideo(); if (video) doMaximizeDirect(video); else { try { if (typeof showOSD === 'function') showOSD('최대화할 비디오를 찾을 수 없음', 1500); } catch(_) {} } }
          return;
        }
        if (active) { undoMaximize(); return; }
        const video = pickBestVideo(); if (video) { doMaximizeDirect(video); return; }
        const iframes = document.querySelectorAll('iframe'); let bestIframe = null, bestArea = 0;
        for (const ifr of iframes) {
          if (!ifr.isConnected) continue; const r = ifr.getBoundingClientRect(); const area = r.width * r.height; if (area < 10000) continue;
          try { const doc = ifr.contentDocument || ifr.contentWindow?.document; if (doc?.querySelector('video')) { if (area > bestArea) { bestArea = area; bestIframe = ifr; } } } catch (_) { if (area > bestArea) { bestArea = area; bestIframe = ifr; } }
        }
        if (bestIframe) { doMaximizeIframe(bestIframe); return; }
        try { if (typeof showOSD === 'function') showOSD('최대화할 비디오를 찾을 수 없음', 1500); } catch(_) {}
      }

      function onMessage(e) {
        if (!e.data || typeof e.data !== 'object' || !e.data.__vsc_max) return;
        const cmd = e.data.__vsc_max;
        if (!isInIframe()) {
          if (cmd === 'request') { const iframeEl = findIframeForWindow(e.source); if (iframeEl) { if (active) undoMaximize(); doMaximizeIframe(iframeEl); try { e.source.postMessage({ __vsc_max: 'state_on' }, '*'); } catch (_) {} } return; }
          if (cmd === 'undo') { if (active) undoMaximize(); return; } return;
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

    /* ── isNeutralVideoParams (Bug 4 Applied) ── */
    const isNeutralVideoParams = (() => {
      let _lastHash = 0;
      let _lastResult = true;

      return function isNeutralCached(v) {
        if (v._autoToneCurve !== null || v._autoChannelGains !== null) return false;

        const h = ((v._cssBr * 1000) | 0) ^
                  (((v._cssCt * 1000) | 0) << 10) ^
                  (((v._cssSat ?? 1) * 1000) | 0) << 20 ^
                  (((v.sharp || 0) * 1000) | 0);

        if (h === _lastHash) return _lastResult;

        _lastHash = h;

        const cssBr = v._cssBr ?? 1, cssCt = v._cssCt ?? 1, cssSat = v._cssSat ?? 1;
        if (cssBr < 0.99 || cssBr > 1.01 || cssCt < 0.99 || cssCt > 1.01 || cssSat < 0.99 || cssSat > 1.01) { _lastResult = false; return false; }

        const sharp = v.sharp ?? 0;
        if (sharp > 0.01 || sharp < -0.01) { _lastResult = false; return false; }

        const T = 0.01;
        _lastResult = Math.abs(v.toe ?? 0) < T && Math.abs(v.mid ?? 0) < T && Math.abs(v.shoulder ?? 0) < T
            && Math.abs((v.gain ?? 1) - 1) < T && Math.abs((v.gamma ?? 1) - 1) < T
            && Math.abs((v.contrast ?? 1) - 1) < T && Math.abs(v.bright ?? 0) < T && Math.abs(v.temp ?? 0) < T;

        return _lastResult;
      };
    })();

    /* ══════════════════════════════════════════════════════════════════
       createApplyLoop
       ══════════════════════════════════════════════════════════════════ */
    function createApplyLoop(Store, Scheduler, Registry, TargetingMod, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq) {
      const __lastUserPt = { x: 0, y: 0, t: 0 };
      onWin('pointermove', e => { __lastUserPt.x = e.clientX; __lastUserPt.y = e.clientY; __lastUserPt.t = performance.now(); }, { passive: true });
      onWin('touchstart', e => { if (e.touches.length > 0) { __lastUserPt.x = e.touches[0].clientX; __lastUserPt.y = e.touches[0].clientY; __lastUserPt.t = performance.now(); } }, { passive: true });

      let prevTarget = null;
      const _targets = new Set();

      setRecurring(() => { if (Registry.videos.size === 0 && TOUCHED.videos.size === 0 && TOUCHED.rateVideos.size === 0) return; Registry.prune(); for (const key of ['videos', 'rateVideos']) { for (const v of TOUCHED[key]) { if (!v.isConnected) TOUCHED[key].delete(v); } } }, 5000, { maxErrors: 50 });

      function restoreRate(video) { const rs = getRateState(video); if (rs.orig != null && Math.abs(video.playbackRate - (rs.orig || 1)) > 0.002) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig || 1; } catch (_) {} } rs.orig = null; rs._rateRetryCount = 0; rs._totalRetries = 0; rs.permanentlyBlocked = false; }

      function apply(forceApply) {
        if (__globalSig.aborted) return;

        const dirtyMask = Store.consumeDirty?.() || 0xFFFF;
        const applyAll = !!Store.get(P.APP_APPLY_ALL);

        if (!Store.get(P.APP_ACT)) {
          if (prevTarget) { FiltersVO.clear(prevTarget); prevTarget = null; }
          window[VSC_INTERNAL_SYM]._activeVideo = null;
          Audio.setTarget(null);
          for (const v of TOUCHED.rateVideos) { if (v.isConnected) restoreRate(v); }
          return;
        }

        const audioBoostOn = !!Store.get(P.A_EN);
        const { target } = TargetingMod.pickFastActiveOnly(Registry.visible.videos, __lastUserPt, audioBoostOn);

        if (!target && !applyAll) {
          if (prevTarget !== null) {
            FiltersVO.clear(prevTarget);
            prevTarget = null;
            window[VSC_INTERNAL_SYM]._activeVideo = null;
            Audio.setTarget(null);
          }
          return;
        }

        if (target !== prevTarget || forceApply) { if (prevTarget && prevTarget !== target) FiltersVO.clear(prevTarget); prevTarget = target; window[VSC_INTERNAL_SYM]._activeVideo = target; Audio.setTarget(target); }

        const vfUser = Store.getCatRef('video'); const pbEn = !!Store.get(P.PB_EN); const pbRate = Number(Store.get(P.PB_RATE));

        _targets.clear();
        if (target) _targets.add(target);
        if (applyAll) {
          for (const v of Registry.visible.videos) { if (v.isConnected) _targets.add(v); }
        }

        for (const v of TOUCHED.videos) {
          if (!v.isConnected || _targets.has(v)) continue;
          const vst = getVState(v); if (vst.applied) FiltersVO.clear(v);
        }

        if (dirtyMask & 0b0100 || forceApply || target !== prevTarget) {
          if (pbEn) {
            for (const v of TOUCHED.rateVideos) {
              if (!v.isConnected || _targets.has(v)) continue;
              restoreRate(v);
            }
          }
        }

        for (const v of _targets) {
          if (dirtyMask & 0b0100 || forceApply || target !== prevTarget) {
            if (pbEn && Number.isFinite(pbRate) && pbRate > 0) {
              const rs = getRateState(v);
              if (!rs.permanentlyBlocked) {
                if (rs.orig == null) rs.orig = v.playbackRate;
                if (Math.abs(v.playbackRate - pbRate) > 0.002) {
                  if (rs._totalRetries >= RATE_SESSION_MAX) rs.permanentlyBlocked = true;
                  else if (isVideoEncrypted(v)) { rs.permanentlyBlocked = true; if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { v.playbackRate = rs.orig; } catch (_) {} } }
                  else { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { v.playbackRate = pbRate; rs._rateRetryCount = 0; } catch (_) { rs._rateRetryCount++; rs._totalRetries++; rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; } }
                  touchedAddLimited(TOUCHED.rateVideos, v);
                }
              }
            } else restoreRate(v);
          }

          const vst = getVState(v);

          if (vst.__abCompare) {
            FiltersVO.clear(v);
            if (dirtyMask & 0b1000 || forceApply || target !== prevTarget) {
              const rot = Number(Store.get(P.APP_VID_ROT)) || 0;
              const fit = Store.get(P.APP_VID_FIT) || 'contain';
              if (rot !== 0 || fit !== 'contain') applyVideoTransform(v, Store);
            }
            touchedAddLimited(TOUCHED.videos, v);
            continue;
          }

          const params = ParamsMemo.get(vfUser, v);
          if (!params || isNeutralVideoParams(params)) FiltersVO.clear(v);
          else {
            const filterResult = FiltersVO.prepareCached(v, params);
            FiltersVO.applyFilter(v, filterResult);
          }

          if (dirtyMask & 0b1000 || forceApply || target !== prevTarget) {
            const rot = Number(Store.get(P.APP_VID_ROT)) || 0;
            const fit = Store.get(P.APP_VID_FIT) || 'contain';
            if (rot !== 0 || fit !== 'contain') applyVideoTransform(v, Store);
          }

          touchedAddLimited(TOUCHED.videos, v);
        }
      }
      Scheduler.registerApply(apply); return { apply };
    }

// ═══ END OF PART 3 (v211.7.0) ═══
// ═══ PART 4 START (v211.7.0) — Filters, UI, Gestures & Bootstrap ═══

    /* ── 화면 밝기 공통 상수 ── */
    const SCR_BRT_LEVELS = [0, 0.05, 0.10, 0.15, 0.20, 0.25];
    const SCR_BRT_LABELS = ['리셋(OFF)', '1단', '2단', '3단', '4단', '5단'];

    /* ══════════════════════════════════════════════════════════════════
       SVG Filter Engine (Patch 2, Patch 3, Patch 4, Fix B, Bug 5 Applied)
       ══════════════════════════════════════════════════════════════════ */
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(32);

      const _toneStrLut = new Array(10001); let _toneStrLutReady = false;
      function ensureToneStrLut() { if (_toneStrLutReady) return; for (let i = 0; i <= 10000; i++) _toneStrLut[i] = (i / 10000).toFixed(4); _toneStrLutReady = true; }

      // Patch 3: GC 압력 제거를 위한 고정 버퍼 재사용
      const _SVG_TABLE_BUF = new Array(256);
      let _svgTableBufLen = 256;

      function float32ArrayToSvgTable(arr) {
        ensureToneStrLut();
        const len = arr.length;
        const lut  = _toneStrLut;

        const out = (len <= 256) ? _SVG_TABLE_BUF : new Array(len);

        for (let i = 0; i < len; i++) {
          const raw = (arr[i] * 10000 + 0.5) | 0;
          out[i] = lut[raw < 0 ? 0 : (raw > 10000 ? 10000 : raw)];
        }
        return (len === 256) ? out.join(' ') : out.splice(0, len).join(' ');
      }

      function mkXfer(attrs, funcDefaults, withAlpha = false) {
        const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs });
        const channels = ['R', 'G', 'B']; if (withAlpha) channels.push('A');
        for (const ch of channels) {
          const funcAttrs = { ns: 'svg' };
          if (ch === 'A') funcAttrs.type = 'identity'; else { for (const [k, v] of Object.entries(funcDefaults)) funcAttrs[k] = v; }
          xfer.append(h(`feFunc${ch}`, funcAttrs));
        }
        return xfer;
      }

      function hashMix(h, v) {
        h = (h ^ ((v * 10000 + 0.5) | 0)) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        return h;
      }

      function makeKeyHash(s) {
        let h = 0x811c9dc5;
        h = hashMix(h, s.gain || 1);
        h = hashMix(h, s.gamma || 1);
        h = hashMix(h, s.temp || 0);
        h = hashMix(h, s.sharp || 0);
        h = hashMix(h, s.toe || 0);
        h = hashMix(h, s.mid || 0);
        h = hashMix(h, s.shoulder || 0);
        h = hashMix(h, s.contrast || 1);
        h = hashMix(h, s.bright || 0);
        if (s._autoToneCurve?.length >= 256) {
          const c = s._autoToneCurve;
          h = hashMix(h, c[0]); h = hashMix(h, c[32]); h = hashMix(h, c[64]);
          h = hashMix(h, c[128]); h = hashMix(h, c[192]); h = hashMix(h, c[255]);
        }
        if (s._autoChannelGains) {
          const g = s._autoChannelGains;
          h = hashMix(h, g.rGain); h = hashMix(h, g.gGain); h = hashMix(h, g.bGain);
        }
        return h;
      }

      function getToneTableCached(steps, gain, contrast, brightOffset, gamma, toe, mid, shoulder) {
        const key = `${steps}|${(gain*100+.5)|0}|${(contrast*100+.5)|0}|${(gamma*100+.5)|0}|t${(toe*1000+.5)|0}|m${(mid*1000+.5)|0}|s${(shoulder*1000+.5)|0}`;
        const hit = toneCache.get(key); if (hit) return hit;
        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const out = new Array(steps); let prev = 0;
        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = Number(gamma); const toeFactor = Number(toe) || 0; const midFactor = Number(mid) || 0; const shoulderFactor = Number(shoulder) || 0;
        ensureToneStrLut();

        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1); let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = x * contrast + intercept; x = clamp(x, 0, 1);
          if (toeFactor > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toeFactor * (1.0 - t) * (t * t) * (1.0 - x); }
          if (midFactor > 0.001) { const midCenter = 0.45, sigma = 0.18; const midWeight = Math.exp(-((x0 - midCenter) * (x0 - midCenter)) / (2 * sigma * sigma)); x = clamp(x + (x0 - midCenter) * midFactor * midWeight * 1.5, 0, 1); }
          if (shoulderFactor > 0.001) { const hiWeight = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = clamp(x + shoulderFactor * 0.6 * x0 + shoulderFactor * hiWeight * hiWeight * 0.5 * (1.0 - x), 0, 1); }
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;
          out[i] = _toneStrLut[Math.min(10000, Math.max(0, Math.round(x * 10000)))];
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      const __createdSvgs = new Set();
      const _svgFR = new FinalizationRegistry(ref => __createdSvgs.delete(ref));
      __globalSig.addEventListener('abort', () => { for (const ref of __createdSvgs) { const svg = ref.deref(); try { if (svg?.parentNode) svg.remove(); } catch (_) {} } __createdSvgs.clear(); }, { once: true });

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
        const defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const ref = new WeakRef(svg); _svgFR.register(svg, ref, ref); __createdSvgs.add(ref);
        const fid = `vsc-f-${config.VSC_ID}`;
        const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
        const fTone = mkXfer({ in: 'conv', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
        const fSat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1.0', result: 'final' });
        filter.append(fConv, fTone, fTemp, fSat); defs.append(filter);
        const tryAppend = () => {
          const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
          if (!target?.appendChild) return false;
          try { const escapedFid = fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const existing = target.querySelector(`filter[id="${escapedFid}"]`); if (existing) { const oldSvg = existing.closest('svg'); if (oldSvg && oldSvg !== svg) oldSvg.remove(); } } catch (_) {}
          target.appendChild(svg); return true;
        };
        if (!tryAppend()) { let retryCount = 0; const t = setRecurring(() => { if (++retryCount > 40 || tryAppend()) clearRecurring(t); }, 50); setTimer(() => clearRecurring(t), 3000); }
        const toneFuncR = fTone.querySelector('feFuncR'), toneFuncG = fTone.querySelector('feFuncG'), toneFuncB = fTone.querySelector('feFuncB');
        const tempChildren = Array.from(fTemp.children);
        return { fid, fConv, toneFuncsRGB: [toneFuncR, toneFuncG, toneFuncB].filter(Boolean), tempFuncR: tempChildren.find(f => f.tagName.includes('R')), tempFuncG: tempChildren.find(f => f.tagName.includes('G')), tempFuncB: tempChildren.find(f => f.tagName.includes('B')), fSat, st: { lastKey: '', toneKey: '', toneHash: 0, sharpKey: '', desatKey: '', tempKey: '' } };
      }

      function needsSvgFilter(s) {
        if (config.IS_FIREFOX) return false;
        return (Math.abs(s.sharp || 0) > 0.005 || Math.abs(s.toe || 0) > 0.005 || Math.abs(s.mid || 0) > 0.005 || Math.abs(s.shoulder || 0) > 0.005 || !!s._autoToneCurve || !!s._autoChannelGains || Math.abs((s.gain || 1) - 1) > 0.005 || Math.abs((s.gamma || 1) - 1) > 0.005 || Math.abs(s.temp || 0) > 0.5);
      }

      const _filterInternMap = new Map();
      let _filterInternSeq = 0;
      const INTERN_MAX = 48;
      let _icLastStr = '', _icLastId = 0;

      function internFilter(str) {
        if (str === _icLastStr) return _icLastId;
        let id = _filterInternMap.get(str);
        if (id === undefined) {
          if (_filterInternMap.size >= INTERN_MAX) _filterInternMap.delete(_filterInternMap.keys().next().value);
          id = ++_filterInternSeq;
          _filterInternMap.set(str, id);
        }
        _icLastStr = str; _icLastId = id; return id;
      }

      // Patch 4: MessageChannel로 DOM 플러시 최적화
      const _svgMC = new MessageChannel();
      let __svgUpdateQueued = false;
      let __svgPendingUpdates  = [];
      let __svgPendingPool     = [];
      let _svgMCReady = false;

      _svgMC.port1.onmessage = () => {
        __svgUpdateQueued = false;
        const batch = __svgPendingUpdates;
        __svgPendingUpdates = __svgPendingPool;
        __svgPendingPool    = batch;
        for (let i = 0; i < batch.length; i++) batch[i]();
        batch.length = 0;
      };
      _svgMCReady = true;

      function queueSvgUpdate(fn) {
        __svgPendingUpdates.push(fn);
        if (__svgUpdateQueued) return;
        __svgUpdateQueued = true;

        if (_svgMCReady) {
          _svgMC.port2.postMessage(null);
        } else {
          requestAnimationFrame(() => {
            __svgUpdateQueued = false;
            const batch = __svgPendingUpdates;
            __svgPendingUpdates = __svgPendingPool;
            __svgPendingPool    = batch;
            for (let i = 0; i < batch.length; i++) batch[i]();
            batch.length = 0;
          });
        }
      }

      __globalSig.addEventListener('abort', () => {
        _svgMC.port1.onmessage = null;
        __svgPendingUpdates.length = 0;
        __svgPendingPool.length    = 0;
      }, { once: true });

      const _FILTER_PARTS = [];

      function prepare(video, s) {
        const videoRoot = video.getRootNode?.();
        const inShadow = videoRoot instanceof ShadowRoot;

        const inFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const forceCssOnly = inShadow || (inFullscreen && video === (document.fullscreenElement || document.webkitFullscreenElement));

        const root = inShadow ? videoRoot : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { keyHash: 0, url: '', filterStr: 'none', cssOnly: false }; urlCache.set(root, dc); }

        const svgHash = makeKeyHash(s) ^ ((video.videoWidth || 0) * 0x10001);
        const fullHash = svgHash ^ hashMix(0, s._cssBr) ^ hashMix(0x100, s._cssCt) ^ hashMix(0x200, s._cssSat) ^ (inShadow ? 0xDEAD : 0) ^ (forceCssOnly ? 0xBEEF : 0);

        if (dc.keyHash === fullHash) return { svgUrl: dc.url, filterStr: dc.filterStr, cssOnly: dc.cssOnly };

        if (forceCssOnly || !needsSvgFilter(s)) {
          const parts = [];

          if (forceCssOnly && needsSvgFilter(s)) {
            if (s._autoToneCurve && s._autoToneCurve.length >= 256) {
              const curve = s._autoToneCurve;
              const midOut = curve[128]; const shadowOut = curve[32]; const highlightOut = curve[224];
              const avgLift = (midOut - 0.5) * 2; const cssBright = 1.0 + avgLift * 0.3;
              if (Math.abs(cssBright - 1) > 0.005) parts.push(`brightness(${clamp(cssBright, 0.7, 1.5).toFixed(4)})`);
              const slope = (highlightOut - shadowOut) / (224 / 255 - 32 / 255);
              const cssContrast = clamp(slope, 0.7, 1.4);
              if (Math.abs(cssContrast - 1) > 0.005) parts.push(`contrast(${cssContrast.toFixed(4)})`);

              if (s._autoChannelGains) {
                const ag = s._autoChannelGains;
                const tempEstimate = (ag.rGain - ag.bGain) * 50;
                if (Math.abs(tempEstimate) > 2) parts.push(`hue-rotate(${clamp(tempEstimate * 0.3, -15, 15).toFixed(1)}deg)`);
              }
            } else {
              const approxBright = Math.pow(s.gain || 1, 0.9) * Math.pow(1 / (s.gamma || 1), 0.5);
              if (Math.abs(approxBright - 1) > 0.005) parts.push(`brightness(${approxBright.toFixed(4)})`);
              if (Math.abs((s.contrast || 1) - 1) > 0.005) parts.push(`contrast(${(s.contrast || 1).toFixed(4)})`);
              if (Math.abs(s.temp || 0) > 1) parts.push(`hue-rotate(${((s.temp || 0) * 0.3).toFixed(1)}deg)`);
            }
          }

          if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
          if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
          if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);

          const filterStrCss = parts.length > 0 ? parts.join(' ') : 'none';
          dc.keyHash = fullHash; dc.url = ''; dc.filterStr = filterStrCss; dc.cssOnly = true;
          return { svgUrl: '', filterStr: filterStrCss, cssOnly: true, _svgHash: 0 };
        }

        let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== svgHash) {
          st.lastKey = svgHash; const steps = 256; const gamma = 1 / clamp(s.gamma || 1, 0.1, 5.0);
          let toneTable;

          if (s._autoToneCurve) {
            const c = s._autoToneCurve;
            const fastHash = ((c[0]*65536)|0) ^ ((c[64]*65536)|0) ^ ((c[128]*65536)|0) ^ ((c[192]*65536)|0) ^ ((c[255]*65536)|0);
            const combinedHash = fastHash ^ ((Number(s.toe) * 10000) | 0) ^ ((Number(s.mid) * 10000) | 0) ^ ((Number(s.shoulder) * 10000) | 0);

            if (st.toneHash !== combinedHash) {
              let finalCurve;
              if (Number(s.toe) > 0.001 || Number(s.mid) > 0.001 || Number(s.shoulder) > 0.001) {
                finalCurve = new Float32Array(c.length);
                for (let i = 0; i < c.length; i++) {
                  const x0 = i / (c.length - 1); let val = c[i];
                  if (Number(s.toe) > 0.001 && x0 < 0.40) val = val + Number(s.toe) * (1.0 - x0 / 0.40) * ((x0 / 0.40) * (x0 / 0.40)) * (1.0 - val);
                  if (Number(s.mid) > 0.001) { const mw = Math.exp(-((x0 - 0.45) * (x0 - 0.45)) / (2 * 0.18 * 0.18)); val = clamp(val + (x0 - 0.45) * Number(s.mid) * mw * 1.5, 0, 1); }
                  if (Number(s.shoulder) > 0.001) { const hw = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; val = clamp(val + Number(s.shoulder) * 0.6 * x0 + Number(s.shoulder) * hw * hw * 0.5 * (1.0 - val), 0, 1); }
                  finalCurve[i] = Math.max(i > 0 ? finalCurve[i - 1] : 0, val);
                }
                toneTable = float32ArrayToSvgTable(finalCurve);
              } else { toneTable = float32ArrayToSvgTable(c); }
              st.toneHash = combinedHash; st.toneKey = toneTable;
              queueSvgUpdate(() => {
                for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable);
              });
            } else { toneTable = st.toneKey; }
          } else {
            toneTable = getToneTableCached(steps, s.gain || 1, s.contrast || 1, s.bright * 0.004 || 0, gamma, s.toe || 0, s.mid || 0, s.shoulder || 0);
            const toneHash = fnv1a(toneTable);
            if (st.toneHash !== toneHash) {
              st.toneHash = toneHash; st.toneKey = toneTable;
              queueSvgUpdate(() => {
                for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable);
              });
            }
          }

          const SHARP_CAP = config.IS_MOBILE ? 0.60 : 0.60;
          const totalS = clamp(Number(s.sharp || 0), 0, SHARP_CAP);
          let kernelStr;
          if (totalS < 0.005) { kernelStr = '0,0,0, 0,1,0, 0,0,0'; }
          else { const diag = -totalS * 0.5; const edge = -totalS; const center = 1.0 - 4 * edge - 4 * diag; kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`; }

          const userTemp = tempToRgbGain(s.temp); let finalRs = userTemp.rs, finalGs = userTemp.gs, finalBs = userTemp.bs;

          if (s._autoChannelGains) {
            const ag = s._autoChannelGains;
            finalRs = userTemp.rs * clamp(ag.rGain, 0.80, 1.20);
            finalGs = userTemp.gs * clamp(ag.gGain, 0.90, 1.10);
            finalBs = userTemp.bs * clamp(ag.bGain, 0.80, 1.20);

            const lumWeightedAvg = finalRs * 0.2126 + finalGs * 0.7152 + finalBs * 0.0722;
            if (lumWeightedAvg > 0.01) {
              const scale = 1.0 / lumWeightedAvg;
              finalRs *= scale; finalGs *= scale; finalBs *= scale;
              const maxG = Math.max(finalRs, finalGs, finalBs);
              if (maxG > 1.20) {
                const clampScale = 1.20 / maxG;
                finalRs *= clampScale; finalGs *= clampScale; finalBs *= clampScale;
              }
            }
          }

          const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);
          if (st.tempKey !== tmk) {
            st.tempKey = tmk;
            queueSvgUpdate(() => {
              ctx.tempFuncR.setAttribute('slope', finalRs);
              ctx.tempFuncG.setAttribute('slope', finalGs);
              ctx.tempFuncB.setAttribute('slope', finalBs);
            });
          }
          if (st.sharpKey !== kernelStr) {
            st.sharpKey = kernelStr;
            const desatVal = totalS > 0.008 ? clamp(1.0 - totalS * 0.1, 0.90, 1.0).toFixed(3) : '1.000';
            queueSvgUpdate(() => {
              ctx.fConv.setAttribute('kernelMatrix', kernelStr);
              if (st.desatKey !== desatVal) { st.desatKey = desatVal; ctx.fSat.setAttribute('values', desatVal); }
            });
          }
        }

        const url = `url(#${ctx.fid})`; _FILTER_PARTS.length = 0; _FILTER_PARTS.push(url);
        if (Math.abs(s._cssBr - 1) > 0.001) _FILTER_PARTS.push(`brightness(${s._cssBr.toFixed(4)})`);
        if (Math.abs(s._cssCt - 1) > 0.001) _FILTER_PARTS.push(`contrast(${s._cssCt.toFixed(4)})`);
        if (Math.abs(s._cssSat - 1) > 0.001) _FILTER_PARTS.push(`saturate(${s._cssSat.toFixed(4)})`);
        const filterStr = _FILTER_PARTS.length === 1 ? url : _FILTER_PARTS.join(' ');

        dc.keyHash = fullHash; dc.url = url; dc.filterStr = filterStr; dc.cssOnly = false;
        return { svgUrl: url, filterStr, cssOnly: false, _svgHash: svgHash };
      }

      function fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0, len = str.length; i < len; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
      }

      return {
        prepareCached: (video, s) => { try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
        applyFilter: (el, filterResult) => {
          if (!el) return;
          const st = getVState(el);
          if (st._inPiP) return;
          if (!st.visible && !isPiPActiveVideo(el)) {
            if (st.applied) { vscRemoveStyle(el, 'will-change'); vscRemoveStyle(el, 'contain'); }
            return;
          }
          if (!filterResult) {
            if (st.applied) {
              vscClearAllStyles(el);
              st.applied = false; st.lastFilterUrl = null;
              st.lastCssFilterStr = null; st._transitionCleared = false;
              st._lastFilterHash = 0;
              st._lastSvgHash = 0;
            }
            return;
          }

          const filterStr = filterResult.filterStr;
          const cssHash = internFilter(filterStr);
          const svgHash = filterResult._svgHash || 0;

          if (st._lastFilterHash === cssHash && st._lastSvgHash === svgHash && st.applied) return;

          const isZoomed = !!window[VSC_INTERNAL_SYM]?.ZoomManager?.isZoomed(el);
          const svgChanged = st._lastSvgHash !== svgHash && st.applied;

          if (!st.applied) {
            vscApplyFilterStyles(el, filterStr, isZoomed);
            st.applied = true;
            st._transitionCleared = true;
          } else if (svgChanged && cssHash === st._lastFilterHash) {
            el.style.removeProperty('filter');
            el.style.removeProperty('-webkit-filter');
            void el.offsetWidth;
            el.style.setProperty('filter', filterStr, 'important');
            el.style.setProperty('-webkit-filter', filterStr, 'important');
          } else {
            el.style.setProperty('filter', filterStr, 'important');
            el.style.setProperty('-webkit-filter', filterStr, 'important');
          }

          st.lastFilterUrl = filterResult.svgUrl;
          st.lastCssFilterStr = filterStr;
          st._lastFilterHash = cssHash;
          st._lastSvgHash = svgHash;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied && !vscHasManagedStyles(el)) return;
          vscClearAllStyles(el);
          st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null;
          st._transitionCleared = false; st._lastFilterHash = 0;
          st._lastSvgHash = 0;
        }
      };
    }

    // Patch 2: computeResolutionSharpMul 성능 최적화
    const _sharpMulCache = new WeakMap();

    function computeResolutionSharpMul(video) {
      const nW = video.videoWidth  | 0;
      const nH = video.videoHeight | 0;
      const dW = (video.clientWidth  || video.offsetWidth  || 0) | 0;
      const dH = (video.clientHeight || video.offsetHeight || 0) | 0;
      const dpr = Math.min(Math.max(1, window.devicePixelRatio | 0), 4);

      const c = _sharpMulCache.get(video);
      if (c !== undefined && c.nW === nW && c.nH === nH && c.dW === dW && c.dH === dH && c.dp === dpr) {
        return c.r;
      }

      if (nW < 16 || dW < 16) {
        const r = { mul: 0.0, autoBase: 0.0 };
        _sharpMulCache.set(video, { nW, nH, dW, dH, dp: dpr, r });
        return r;
      }

      const physW = dW * dpr;
      const physH = dH * dpr;
      const ratio = Math.max(physW / nW, physH / Math.max(1, nH));

      let mul;
      if      (ratio <= 0.30) mul = 0.40;
      else if (ratio <= 0.60) mul = 0.40 + (ratio - 0.30) / 0.30 * 0.30;
      else if (ratio <= 1.00) mul = 0.70 + (ratio - 0.60) / 0.40 * 0.30;
      else if (ratio <= 1.80) mul = 1.00;
      else if (ratio <= 4.00) mul = 1.00 - (ratio - 1.80) / 2.20 * 0.30;
      else                    mul = 0.65;

      let autoBase;
      if      (nW <= 640)  { mul *= 0.70; autoBase = 0.18; }
      else if (nW <= 960)  { mul *= 0.80; autoBase = 0.14; }
      else if (nW <= 1280) { autoBase = 0.13; }
      else if (nW <= 1920) { autoBase = 0.12; }
      else                 { autoBase = 0.07; }

      if (CONFIG.IS_MOBILE) mul = Math.max(mul, 0.72);

      mul      = VSC_CLAMP(mul, 0.0, 1.0);
      autoBase = VSC_CLAMP(autoBase * mul, 0.0, 0.18);

      const result = { mul, autoBase };
      _sharpMulCache.set(video, { nW, nH, dW, dH, dp: dpr, r: result });
      return result;
    }

    function composeVideoParamsInto(out, vUser, autoMods, sharpMul = 1.0, autoSharpBase = 0.0, motionSAD = 0) {
      out.gain = 1; out.gamma = 1; out.contrast = 1; out.bright = 0;
      out.satF = 1; out.toe = 0; out.mid = 0; out.shoulder = 0;
      out.temp = 0; out.sharp = 0;
      out._autoToneCurve = null; out._autoChannelGains = null;
      out._cssBr = 1; out._cssCt = 1; out._cssSat = 1;
      out._gamma = undefined; out._bright = undefined; out._temp = undefined;

      const presetS = vUser.presetS;
      const mix = VSC_CLAMP(+vUser.presetMix || 1, 0, 1);

      if (presetS === 'off') {
        out.sharp = autoSharpBase;
      } else if (presetS !== 'none') {
        const base = _PRESET_SHARP_LUT[presetS];
        if (base > 0) out.sharp = base * mix * sharpMul;
      }

      if (motionSAD > 0.04 && out.sharp > 0.005) {
        const motionReduction = VSC_CLAMP((motionSAD - 0.04) * 4, 0, 0.40);
        out.sharp *= (1.0 - motionReduction);
        if (CONFIG.IS_MOBILE) {
          const mobileFloor = 0.08;
          if (out.sharp < mobileFloor && out.sharp > 0) out.sharp = mobileFloor;
        }
      }

      const mS = VSC_CLAMP(+vUser.manualShadow || 0, 0, 100);
      const mR = VSC_CLAMP(+vUser.manualRecovery || 0, 0, 100);
      const mB = VSC_CLAMP(+vUser.manualBright || 0, 0, 100);
      out.toe = mS * 0.0035; out.mid = mR * 0.0030; out.shoulder = mB * 0.0040;
      out.temp = VSC_CLAMP(+vUser.manualTemp || 0, -50, 50);

      const hasToneCurve = !!autoMods._toneCurve;
      out.satF *= autoMods.sat;
      out._cssSat = VSC_CLAMP(out.satF, 0, 3.0);

      if (hasToneCurve) {
        out._autoToneCurve = autoMods._toneCurve;
        out._autoChannelGains = autoMods._channelGains || null;
      } else {
        out.gain *= autoMods.br;
        out.contrast *= autoMods.ct;
        out._cssCt = VSC_CLAMP(out.contrast, 0.5, 2.0);
      }
      return out;
    }

    // Patch 1: createVideoParamsMemo 객체 문자열 해싱 개선
    function createVideoParamsMemo(Store, P, Utils) {
      const cache = new WeakMap();

      function init() {}

      return {
        init,
        get(vfUser, activeTarget) {
          const storeRev = Store.rev();
          const sceneRev = window[VSC_INTERNAL_SYM]?.AutoScene?.getAutoSceneRev?.() ?? 0;
          const w  = (activeTarget?.videoWidth  | 0) || 0;
          const ht = (activeTarget?.videoHeight | 0) || 0;

          if (activeTarget) {
            const c = cache.get(activeTarget);
            if (c !== undefined && c.sr === storeRev && c.ar === sceneRev && c.w  === w && c.h  === ht) {
              return c.result;
            }
          }

          const autoMods = window[VSC_INTERNAL_SYM]?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
          const motionSAD = window[VSC_INTERNAL_SYM]?.AutoScene?.getLastMotionSAD?.() || 0;
          const { mul, autoBase } = activeTarget ? computeResolutionSharpMul(activeTarget) : { mul: 0.0, autoBase: 0.0 };
          const finalMul = (mul === 0.0 && vfUser.presetS !== 'off') ? 0.50 : mul;

          const base = {};
          composeVideoParamsInto(base, vfUser, autoMods, finalMul, autoBase, motionSAD);
          const svgBase = { ...base };
          svgBase.sharp = Math.min(Number(svgBase.sharp || 0), 28);

          if (activeTarget) {
            cache.set(activeTarget, { sr: storeRev, ar: sceneRev, w, h: ht, result: svgBase });
          }
          return svgBase;
        },
        invalidate() {}
      };
    }

    const __styleCacheMaxSize = 16; const __styleCache = new Map();
    __globalSig.addEventListener('abort', () => { __styleCache.clear(); }, { once: true });
    function applyShadowStyle(shadow, cssText, h) {
      try {
        if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) {
          const cur = shadow.adoptedStyleSheets || []; let sheet = __styleCache.get(cssText);
          if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); __styleCache.set(cssText, sheet); if (__styleCache.size > __styleCacheMaxSize) __styleCache.delete(__styleCache.keys().next().value); }
          if (!cur.includes(sheet)) { const filtered = cur.filter(s => { try { const r = s.cssRules; if (r.length > 0 && r[0].cssText?.includes('.panel')) return false; } catch (_) {} return true; }); shadow.adoptedStyleSheets = [...filtered, sheet]; }
          return;
        }
      } catch (_) {}
      const marker = 'data-vsc-style'; let stEl = shadow.querySelector(`style[${marker}="1"]`);
      if (!stEl) { stEl = h('style', { [marker]: '1' }, cssText); shadow.append(stEl); } else if (stEl.textContent !== cssText) stEl.textContent = cssText;
    }

    function bindWindowDrag(onMove, onEnd) {
      const ac = new AbortController(); const sig = ac.signal;
      window.addEventListener('mousemove', onMove, { passive: false, signal: sig }); window.addEventListener('mouseup', end, { signal: sig }); window.addEventListener('touchmove', onMove, { passive: false, signal: sig }); window.addEventListener('touchend', end, { signal: sig }); window.addEventListener('blur', end, { signal: sig });
      let ended = false; function end(ev) { if (ended) return; ended = true; try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} } }
      return () => { if (!ended) { ended = true; try { ac.abort(); } catch (_) {} } };
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    function createSvgElement(tag, attrs = {}, ...children) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) { if (v != null && v !== false) el.setAttribute(k, String(v)); }
      for (const child of children.flat()) { if (child != null) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); }
      return el;
    }
    const _s = createSvgElement;
    const _ICON_DATA = {
      gear:     [20, 'M12,9a3,3,0,1,0,3,3A3,3,0,0,0,12,9Z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
      pip:      [14, 'M2,5a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2V17a2,2,0,0,1-2,2H4a2,2,0,0,1-2-2Z', 'M12,10a1,1,0,0,1,1-1h6a1,1,0,0,1,1,1v4a1,1,0,0,1-1,1H13a1,1,0,0,1-1-1Z'],
      maximize: [14, 'M15,3L21,3L21,9 M9,21L3,21L3,15 M21,3L14,10 M3,21L10,14'],
      zoom:     [14, 'M11,3a8,8,0,1,0,8,8A8,8,0,0,0,11,3Z M21,21L16.65,16.65 M11,8V14 M8,11H14'],
      camera:   [14, 'M23,19a2,2,0,0,1-2,2H3a2,2,0,0,1-2-2V8A2,2,0,0,1,3,6H7L9,3h6l2,3h4a2,2,0,0,1,2,2Z', 'M12,9a4,4,0,1,0,4,4A4,4,0,0,0,12,9Z']
    };
    function svgIcon(name, sizeOverride) {
      const d = _ICON_DATA[name]; if (!d) return document.createTextNode('');
      const size = sizeOverride || d[0];
      const svg = _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      for (let i = 1; i < d.length; i++) svg.appendChild(_s('path', { d: d[i] }));
      return svg;
    }
    const VSC_ICON_BUILDERS = new Proxy({}, { get: (_, name) => (size) => svgIcon(name, size) });

    const CSS_VARS = `
:host {
  position: fixed !important; contain: none !important; overflow: visible !important; isolation: isolate;
  --vsc-glass: rgba(12, 12, 18, 0.72); --vsc-glass-hover: rgba(30, 30, 44, 0.78); --vsc-glass-active: rgba(40, 40, 58, 0.82); --vsc-glass-blur: blur(24px) saturate(200%); --vsc-glass-border: rgba(255, 255, 255, 0.06);
  --vsc-neon: #00e5ff; --vsc-neon-glow: 0 0 12px rgba(0, 229, 255, 0.35), 0 0 40px rgba(0, 229, 255, 0.08); --vsc-neon-soft: rgba(0, 229, 255, 0.15); --vsc-neon-border: rgba(0, 229, 255, 0.25); --vsc-neon-dim: rgba(0, 229, 255, 0.08);
  --vsc-green: #4cff8d; --vsc-amber: #ffbe46; --vsc-red: #ff4d6a; --vsc-purple: #b47aff;
  --vsc-text: rgba(255, 255, 255, 0.92); --vsc-text-dim: rgba(255, 255, 255, 0.50); --vsc-text-muted: rgba(255, 255, 255, 0.28);
  --vsc-shadow-panel: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset; --vsc-shadow-btn: 0 2px 8px rgba(0, 0, 0, 0.3); --vsc-shadow-fab: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
  --vsc-space-xs: 4px; --vsc-space-sm: 6px; --vsc-space-md: 10px; --vsc-space-lg: 14px; --vsc-space-xl: 20px;
  --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-lg: 14px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px;
  --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  --vsc-font-xs: 10px; --vsc-font-sm: 11px; --vsc-font-md: 13px; --vsc-font-lg: 15px; --vsc-font-xl: 24px; --vsc-font-xxl: 32px;
  --vsc-touch-min: ${CONFIG.IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${CONFIG.IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${CONFIG.IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${CONFIG.IS_MOBILE ? '6px' : '10px'};
  --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --vsc-t-fast: 0.15s var(--vsc-ease-out); --vsc-t-normal: 0.25s var(--vsc-ease-out); --vsc-t-slow: 0.4s var(--vsc-ease-out);
}`;

    const PANEL_CSS = `
${CSS_VARS}
:host { all: initial; position: fixed !important; z-index: 2147483647; font-family: var(--vsc-font); font-size: var(--vsc-font-md); color: var(--vsc-text); pointer-events: none; contain: none !important; overflow: visible !important; isolation: isolate; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; }
.panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px); top: 50%; width: var(--vsc-panel-width); max-height: var(--vsc-panel-max-h); background: var(--vsc-glass); border: 1px solid var(--vsc-glass-border); border-radius: var(--vsc-radius-xl); backdrop-filter: var(--vsc-glass-blur); -webkit-backdrop-filter: var(--vsc-glass-blur); box-shadow: var(--vsc-shadow-panel); display: flex; flex-direction: column; overflow: hidden; user-select: none; contain: none !important; opacity: 0; transform: translate(16px, -50%) scale(0.92); filter: blur(4px); transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring), filter 0.3s var(--vsc-ease-out); }
.panel.open { opacity: 1; transform: translate(0, -50%) scale(1); filter: blur(0); pointer-events: auto; }
.panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
.hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); gap: 10px; position: relative; }
.hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-shadow: none; }
.hdr .ver { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xs); opacity: 0.30; margin-left: auto; letter-spacing: 0.5px; }
.hdr-status { display: flex; gap: 8px; align-items: center; margin-left: 4px; }
.hdr-dot { width: 7px; height: 7px; border-radius: 50%; position: relative; cursor: help; transition: box-shadow 0.3s; }
.hdr-dot.green  { background: var(--vsc-green);  box-shadow: 0 0 8px rgba(76, 255, 141, 0.5); }
.hdr-dot.amber  { background: var(--vsc-amber);  box-shadow: 0 0 8px rgba(255, 190, 70, 0.5); }
.hdr-dot.red    { background: var(--vsc-red);    box-shadow: 0 0 8px rgba(255, 77, 106, 0.5); }
.hdr-dot.gray   { background: rgba(255, 255, 255, 0.15); }
.hdr-dot::after { content: attr(data-label); position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%) translateY(4px); font-size: 9px; white-space: nowrap; opacity: 0; transition: all 0.2s var(--vsc-ease-out); pointer-events: none; color: #fff; background: rgba(0, 0, 0, 0.85); padding: 3px 8px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255, 255, 255, 0.08); z-index: 10; backdrop-filter: blur(8px); }
.hdr-dot:hover::after { opacity: 1; transform: translateX(-50%) translateY(0); }
.tabs { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.04); position: relative; padding: 0 4px; }
.tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); }
.tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; border-bottom: 2px solid transparent; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; position: relative; text-transform: uppercase; }
.tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; transition: opacity 0.2s, filter 0.2s; }
.tab:hover { opacity: 0.65; }
.tab.on { opacity: 1; color: var(--vsc-neon); }
.tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.4)); }
.body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0, 229, 255, 0.15) transparent; }
.body::-webkit-scrollbar { width: 4px; }
.body::-webkit-scrollbar-track { background: transparent; }
.body::-webkit-scrollbar-thumb { background: rgba(0, 229, 255, 0.2); border-radius: 2px; }
.body::-webkit-scrollbar-thumb:hover { background: rgba(0, 229, 255, 0.35); }
.row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); }
.row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; }
.row .ctrl { display: flex; align-items: center; gap: var(--vsc-space-sm); flex: 1; justify-content: flex-end; }
input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; position: relative; margin: 0; }
input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255, 255, 255, 0.08) var(--fill, 50%)); box-shadow: inset 0 0 4px rgba(0, 229, 255, 0.15); }
input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); border: none; }
input[type=range]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--vsc-neon); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0, 0, 0, 0.3); box-shadow: 0 0 8px rgba(0, 229, 255, 0.4), 0 0 2px rgba(0, 229, 255, 0.8); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); transition: box-shadow 0.2s, transform 0.15s var(--vsc-ease-spring); }
input[type=range]:active::-webkit-slider-thumb { transform: scale(1.25); box-shadow: 0 0 16px rgba(0, 229, 255, 0.6), 0 0 4px rgba(0, 229, 255, 1); }
input[type=range]::-moz-range-thumb { width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0, 0, 0, 0.3); box-shadow: 0 0 8px rgba(0, 229, 255, 0.4); }
.val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); }
.tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255, 255, 255, 0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; overflow: visible; flex-shrink: 0; border: 1px solid rgba(255, 255, 255, 0.06); }
.tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0, 229, 255, 0.2); }
.tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255, 255, 255, 0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; }
.tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.6); }
.tgl::before { content: ''; position: absolute; right: 7px; top: 50%; transform: translateY(-50%); font-size: 7px; font-weight: 700; opacity: 0; letter-spacing: 0.5px; }
.tgl.on::before { content: ''; left: 7px; right: auto; }
.btn { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: var(--vsc-space-xs) var(--vsc-space-md); font-size: var(--vsc-font-sm); cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-family: var(--vsc-font); font-weight: 500; position: relative; overflow: hidden; }
.btn::after { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at var(--ripple-x, 50%) var(--ripple-y, 50%), rgba(0, 229, 255, 0.2), transparent 70%); opacity: 0; transition: opacity 0.4s; }
.btn:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.12); transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn:active::after { opacity: 1; }
.btn.pr { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); }
.btn.pr:hover { background: var(--vsc-neon-soft); box-shadow: 0 0 12px rgba(0, 229, 255, 0.15); }
.chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; }
.chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: var(--vsc-font-sm); font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; -webkit-tap-highlight-color: transparent; position: relative; }
.chip:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.10); }
.chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.1); }
.chip.on::before { content: ''; position: absolute; top: -1px; left: 20%; right: 20%; height: 1px; background: var(--vsc-neon); opacity: 0.5; }
.sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.06), transparent); margin: 8px 0; }
.metrics-footer { font-family: var(--vsc-font-mono); font-size: 9px; opacity: 0.35; padding: 6px 16px 8px; border-top: 1px solid rgba(255, 255, 255, 0.03); line-height: 1.6; font-variant-numeric: tabular-nums; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.shortcut-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; font-size: var(--vsc-font-xs); line-height: 1.7; padding: var(--vsc-space-xs) 0; }
.shortcut-grid .sk { font-family: var(--vsc-font-mono); font-weight: 600; color: var(--vsc-neon); white-space: nowrap; font-size: 10px; }
.shortcut-grid .sd { opacity: 0.6; }
.rate-display { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xxl); font-weight: 800; text-align: center; padding: 8px 0; font-variant-numeric: tabular-nums; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0, 229, 255, 0.2)); }
.fine-row { display: flex; gap: var(--vsc-space-xs); justify-content: center; padding: 4px 0; }
.fine-btn { padding: 5px 10px; min-height: var(--vsc-touch-min); min-width: 44px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255, 255, 255, 0.06); background: rgba(255, 255, 255, 0.03); color: rgba(255, 255, 255, 0.6); font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); cursor: pointer; transition: all 0.15s var(--vsc-ease-out); font-variant-numeric: tabular-nums; -webkit-tap-highlight-color: transparent; }
.fine-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
.fine-btn:active { transform: scale(0.95); }
.adv-hd { display: flex; align-items: center; gap: 6px; padding: 6px 0; cursor: pointer; font-size: var(--vsc-font-sm); opacity: 0.45; transition: opacity 0.15s; font-weight: 500; }
.adv-hd:hover { opacity: 0.8; }
.adv-hd .arr { transition: transform 0.3s var(--vsc-ease-spring); font-size: 9px; display: inline-block; }
.adv-hd .arr.open { transform: rotate(90deg); }
.adv-bd { overflow: hidden; max-height: 0; transition: max-height 0.4s var(--vsc-ease-out); }
.adv-bd.open { max-height: 800px; }
.info-bar { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xs); opacity: 0.40; padding: 4px 0 6px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.sparkline-canvas { width: 100%; height: 40px; border-radius: var(--vsc-radius-sm); background: rgba(255, 255, 255, 0.02); display: block; margin: 4px 0; }
.qbar { pointer-events: none; position: fixed !important; top: 50%; right: var(--vsc-qbar-right); transform: translateY(-50%); display: flex; flex-direction: row-reverse; align-items: center; gap: 8px; contain: none !important; }
.qbar .qb-main { pointer-events: auto; width: 46px; height: 46px; border-radius: 50%; background: var(--vsc-glass); border: 1px solid rgba(255, 255, 255, 0.08); z-index: 2; opacity: 0.20; transition: all 0.3s var(--vsc-ease-out); box-shadow: var(--vsc-shadow-fab); display: flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; margin-right: env(safe-area-inset-right, 0px); backdrop-filter: blur(16px) saturate(180%); }
.qbar:hover .qb-main, .qbar.expanded .qb-main { opacity: 1; transform: scale(1.08); border-color: var(--vsc-neon-border); box-shadow: var(--vsc-shadow-fab), var(--vsc-neon-glow); }
.qbar .qb-sub { width: 38px; height: 38px; border-radius: 50%; background: var(--vsc-glass); border: 1px solid rgba(255, 255, 255, 0.06); opacity: 0; transform: scale(0.3) translateX(20px); transition: all 0.25s var(--vsc-ease-spring); pointer-events: none; visibility: hidden; z-index: 1; box-shadow: var(--vsc-shadow-btn); display: flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; backdrop-filter: blur(12px); }
.qbar.expanded .qb-sub { opacity: 1; transform: scale(1) translateX(0); pointer-events: auto; visibility: visible; }
${Array.from({length: 8}, (_, i) => `.qbar.expanded .qb-sub:nth-child(${i + 2}) { transition-delay: ${(i * 0.04).toFixed(2)}s; }`).join('\n')}
.qbar .qb-sub:hover { background: var(--vsc-glass-hover); border-color: var(--vsc-neon-border); transform: scale(1.12); box-shadow: 0 0 12px rgba(0, 229, 255, 0.15); }
.qbar svg { width: 22px; height: 22px; fill: none; stroke: #fff; stroke-width: 2; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4)); transition: stroke 0.2s; }
.qbar .qb-sub svg { width: 18px; height: 18px; }
.qbar .qb-sub:hover svg { stroke: var(--vsc-neon); }
.qb:focus-visible, .chip:focus-visible, .btn:focus-visible, .fine-btn:focus-visible { outline: 2px solid var(--vsc-neon); outline-offset: 2px; }
:host-context(:fullscreen) .qbar { opacity: 0; transition: opacity 0.3s; pointer-events: none; }
:host-context(:fullscreen) .qbar:hover, :host-context(:fullscreen) .qbar:active { opacity: 1; pointer-events: auto; }
:host-context(:fullscreen) .qbar .qb-main { pointer-events: auto; }
@media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } }
@media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } .chips { gap: 6px; } .fine-row { gap: 6px; } }
@media (max-width: 350px) { .tab span { display: none; } .tab svg { width: 18px; height: 18px; opacity: 1; } }
@media (orientation: landscape) and (max-height: 500px) { .panel { max-height: 88vh; } .body { max-height: calc(88vh - 80px); } }
@supports (padding: env(safe-area-inset-right)) { .qbar { right: calc(var(--vsc-qbar-right) + env(safe-area-inset-right)); } .panel { right: calc(var(--vsc-panel-right) + 12px + env(safe-area-inset-right)); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
@media (prefers-contrast: high) { :host { --vsc-glass: rgba(0, 0, 0, 0.96); --vsc-glass-border: rgba(255, 255, 255, 0.25); --vsc-text: #fff; } }
@media (pointer: coarse) { .qbar .qb-main { width: 50px; height: 50px; } .qbar .qb-sub  { width: 44px; height: 44px; } }
@keyframes vsc-row-in { from { opacity: 0; transform: translateY(6px); } to    { opacity: 1; transform: translateY(0); } }
.body > * { animation: vsc-row-in 0.25s var(--vsc-ease-out) both; }
${Array.from({length: 20}, (_, i) => `.body > *:nth-child(${i + 1}) { animation-delay: ${(i * 0.03).toFixed(2)}s; }`).join('\n')}
`;

    // Bug 1: Correctly declared OSD timer variables and state
    let __osdReady = false;
    let __osdEl = null, __osdTimerId = 0;

    onWin('pointerdown', () => { __osdReady = true; }, { passive: true, once: true });
    onWin('keydown', () => { __osdReady = true; }, { passive: true, once: true });

    const _osdOpt = createOptimizedOSD();
    function showOSD(text, durationMs = 1200) { _osdOpt.show(text, durationMs); }

    function createOptimizedOSD() {
      function show(text, durationMs = 1200) {
        if (!__osdReady || !document.body) return;
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const root = fsEl || document.body;
        if (!__osdEl || !__osdEl.isConnected || __osdEl.parentNode !== root) {
          __osdEl?.remove();
          __osdEl = document.createElement('div');
          __osdEl.id = 'vsc-osd';
          __osdEl.setAttribute('role', 'status');
          __osdEl.setAttribute('aria-live', 'polite');
          __osdEl.style.cssText = [
            'position:fixed', 'top:48px', 'left:50%', 'transform:translateX(-50%) translateY(0)',
            'background:rgba(12, 12, 18, 0.85)', 'backdrop-filter:blur(24px) saturate(200%)',
            'color:rgba(255, 255, 255, 0.95)', 'padding:10px 28px', 'border-radius:14px',
            'border:1px solid rgba(0, 229, 255, 0.15)', 'font:600 13px/1.4 system-ui, -apple-system, sans-serif',
            'z-index:2147483647', 'pointer-events:none', 'opacity:0', 'will-change:opacity, transform',
            'transition:opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
            'box-shadow:0 8px 32px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 229, 255, 0.08)',
            'letter-spacing:0.3px', 'white-space:pre-line', 'max-width:90vw', 'text-align:center', 'word-break:keep-all'
          ].join(';');
          root.appendChild(__osdEl);
        }
        __osdEl.textContent = text;
        requestAnimationFrame(() => {
          if (!__osdEl) return;
          __osdEl.style.opacity = '1';
          __osdEl.style.transform = 'translateX(-50%) translateY(0)';
        });
        clearTimeout(__osdTimerId);
        __osdTimerId = setTimeout(() => {
          if (__osdEl) {
            __osdEl.style.opacity = '0';
            __osdEl.style.transform = 'translateX(-50%) translateY(-8px)';
          }
        }, durationMs);
      }
      return { show };
    }

    // Patch 15: Batched UI Synchronization to prevent double-RAF overlap
    function createBatchedSyncAll() {
      const permanentFns = [];
      const tabFns = [];
      let _scheduled = false;
      let _rafId = 0;

      function run() {
        _scheduled = false;
        _rafId = 0;
        for (let i = 0; i < permanentFns.length; i++) { try { permanentFns[i](); } catch (_) {} }
        for (let i = 0; i < tabFns.length; i++) { try { tabFns[i](); } catch (_) {} }
      }

      return {
        permanentFns,
        tabFns,
        syncAll() {
          if (_scheduled) return;
          _scheduled = true;
          _rafId = requestAnimationFrame(run);
        },
        syncNow() {
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
          _scheduled = false;
          run();
        }
      };
    }

    function initStoreSubscriptions(Store, syncAllDebounced) {
      const cats = ['video.*', 'audio.*', 'playback.*', 'app.*'];
      const unsubs = [];
      for (const cat of cats) {
        unsubs.push(Store.sub(cat, syncAllDebounced));
      }
      return () => unsubs.forEach(u => u());
    }

    function createUI(Store, Bus, Utils, Audio, AutoScene, ZoomMgr, Targeting, Maximizer, FiltersVO, Registry, Scheduler, ApplyReq) {
      const { h, clamp } = Utils;
      const uiAC = new AbortController(); const sig = getCombinedSignal(uiAC.signal);

      let panelHost = null, panelEl = null, quickBarHost = null;
      let activeTab = 'video', advancedOpen = false, panelOpen = false;
      const panelOpenRef = { get value() { return panelOpen; } };

      const batchedSync = createBatchedSyncAll();
      const { permanentFns, tabFns, syncAll, syncNow } = batchedSync;

      let _shadow = null, _qbarShadow = null; let qbarVisible = false;

      let __scrBrtOverlay = null;

      function ensureScrBrtOverlay() {
        const targetRoot = document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
        if (__scrBrtOverlay?.isConnected && __scrBrtOverlay.parentNode === targetRoot) {
          return __scrBrtOverlay;
        }
        if (!__scrBrtOverlay) {
          __scrBrtOverlay = document.createElement('div');
          __scrBrtOverlay.id = 'vsc-scr-brt';
          __scrBrtOverlay.setAttribute('data-vsc-ui', '1');
          __scrBrtOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:white;mix-blend-mode:soft-light;pointer-events:none;z-index:2147483645;opacity:0;transition:opacity 0.3s ease;display:none;';
        }
        try { targetRoot.appendChild(__scrBrtOverlay); } catch (_) {}
        return __scrBrtOverlay;
      }

      function applyScrBrt(level) {
        const idx = VSC_CLAMP(Math.round(level), 0, SCR_BRT_LEVELS.length - 1);
        const val = SCR_BRT_LEVELS[idx];
        if (val <= 0) {
          if (__scrBrtOverlay) {
            __scrBrtOverlay.style.opacity = '0';
            setTimer(() => { if (__scrBrtOverlay && __scrBrtOverlay.style.opacity === '0') __scrBrtOverlay.style.display = 'none'; }, 350);
          }
          return;
        }
        const ov = ensureScrBrtOverlay();
        ov.style.display = '';
        requestAnimationFrame(() => { ov.style.opacity = String(val); });
      }

      function cycleScrBrt() {
        const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0;
        const next = (cur + 1) % SCR_BRT_LEVELS.length;
        Store.set(P.APP_SCREEN_BRT, next);
        applyScrBrt(next);
        showOSD('화면 조도: ' + SCR_BRT_LABELS[next], 1000);
        persistNow();
      }

      onDoc('fullscreenchange', () => applyScrBrt(Number(Store.get?.(P.APP_SCREEN_BRT)) || 0));
      onDoc('webkitfullscreenchange', () => applyScrBrt(Number(Store.get?.(P.APP_SCREEN_BRT)) || 0));

      Store.sub(P.APP_SCREEN_BRT, v => applyScrBrt(Number(v) || 0));
      setTimer(() => { const saved = Number(Store.get(P.APP_SCREEN_BRT)) || 0; if (saved > 0) applyScrBrt(saved); }, 500);

      function getGpuStatus() {
        if (!Store.get(P.APP_GPU_EN)) return 'off';
        return AutoScene.isGpuActive() ? 'active' : 'fallback';
      }
      function getDspStatus() {
        if (!Audio || !Audio.hasCtx() || Audio.isBypassed()) return 'off';
        return Audio.isWorklet() ? 'worklet' : 'legacy';
      }
      function isDrmDetected() {
        const v = window[VSC_INTERNAL_SYM]?._activeVideo;
        return v ? isVideoEncrypted(v) : false;
      }

      const TAB_ICONS = {
        video: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('rect', { x: 2, y: 4, width: 16, height: 16, rx: 2 }), _s('path', { d: 'M22 7l-6 4 6 4z' })),
        audio: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('path', { d: 'M11 5L6 9H2v6h4l5 4V5z' }), _s('path', { d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
        playback: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('circle', { cx: 12, cy: 12, r: 10 }), _s('polygon', { points: '10 8 16 12 10 16' })),
        app: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('circle', { cx: 12, cy: 12, r: 3 }), _s('path', { d: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.2.57.77.99 1.39 1.02H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z' }))
      };
      const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생', app: '설정' };

      function updateTabIndicator(tabBar, tabName) {
        if (!tabBar) return;
        const tabs = tabBar.querySelectorAll('.tab');
        const tabNames = ['video', 'audio', 'playback', 'app'];
        const idx = tabNames.indexOf(tabName);
        if (idx < 0) return;
        const tabEl = tabs[idx];
        if (!tabEl) return;
        domBatcher.read(() => {
          const barRect = tabBar.getBoundingClientRect();
          const tabRect = tabEl.getBoundingClientRect();
          const left = tabRect.left - barRect.left;
          const width = tabRect.width;
          domBatcher.write(() => {
            tabBar.style.setProperty('--tab-indicator-left', `${left}px`);
            tabBar.style.setProperty('--tab-indicator-width', `${width}px`);
            for (const t of tabs) t.classList.toggle('on', t.dataset.t === tabName);
          });
        });
      }

      function togglePanelOptimized(panelEl, show, onComplete) {
        if (!panelEl) return;
        if (show) {
          panelEl.style.willChange = 'opacity, transform, filter';
          requestAnimationFrame(() => {
            panelEl.classList.add('open');
            panelEl.addEventListener('transitionend', function cleanup(e) {
              if (e.propertyName !== 'opacity') return;
              panelEl.removeEventListener('transitionend', cleanup);
              panelEl.style.willChange = '';
              onComplete?.();
            }, { once: false });
          });
        } else {
          panelEl.style.willChange = 'opacity, transform, filter';
          panelEl.classList.remove('open');
          panelEl.addEventListener('transitionend', function cleanup(e) {
            if (e.propertyName !== 'opacity') return;
            panelEl.removeEventListener('transitionend', cleanup);
            panelEl.style.willChange = '';
            onComplete?.();
          }, { once: false });
        }
      }

      function createSmartMetrics() {
        const footer = h('div', { class: 'metrics-footer' });
        const elRes = h('span', {}, '—');
        const elRate = h('span', {}, '—');
        const elScene = h('span', {}, '');
        footer.append(elRes, elRate, elScene);

        let _lastUpdate = 0;
        const MIN_INTERVAL = 1500;

        function update() {
          const now = performance.now();
          if (now - _lastUpdate < MIN_INTERVAL) return;
          if (!panelOpenRef.value) return;
          _lastUpdate = now;

          const v = window[Symbol.for('__VSC_INTERNAL__')]?._activeVideo;
          if (v && v.isConnected) {
            const nW = v.videoWidth || 0, nH = v.videoHeight || 0;
            elRes.textContent = nW ? `${nW}×${nH}` : '—';
            elRate.textContent = `${v.playbackRate.toFixed(2)}×`;
          } else {
            elRes.textContent = '—';
            elRate.textContent = '—';
          }

          const autoScene = window[Symbol.for('__VSC_INTERNAL__')]?.AutoScene;
          if (autoScene) {
            elScene.textContent = autoScene.getSceneTypeName?.() || '';
          }
        }
        Bus.on('signal', update);
        return footer;
      }

      function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
      function mkSep() { return h('div', { class: 'sep' }); }

      function mkOptimizedSlider(path, min, max, step) {
        const s = step || ((max - min) / 100);
        const digits = (s >= 1) ? 0 : 2;
        const range = max - min;
        const inp = h('input', { type: 'range', min, max, step: s });
        const valEl = h('span', { class: 'val' });

        let _rafQueued = false;
        let _pendingValue = null;

        function updateUI(v) {
          inp.value = String(v);
          valEl.textContent = Number(v).toFixed(digits);
          inp.style.setProperty('--fill', `${((v - min) / range) * 100}%`);
        }

        inp.addEventListener('input', () => {
          _pendingValue = parseFloat(inp.value);
          if (!_rafQueued) {
            _rafQueued = true;
            requestAnimationFrame(() => {
              _rafQueued = false;
              if (_pendingValue !== null) {
                Store.set(path, _pendingValue);
                updateUI(_pendingValue);
                ApplyReq.soft();
                _pendingValue = null;
              }
            });
          }
        }, { signal: sig, passive: true });

        inp.addEventListener('change', () => {
          const nv = parseFloat(inp.value);
          Store.set(path, nv);
          updateUI(nv);
          ApplyReq.soft();
        }, { signal: sig });

        function sync() { updateUI(Number(Store.get(path)) || min); }
        tabFns.push(sync); sync();
        return [inp, valEl];
      }

      function mkOptimizedToggle(path, onChange) {
        const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' });
        function sync() {
          const on = !!Store.get(path);
          el.classList.toggle('on', on);
          el.setAttribute('aria-checked', String(on));
        }

        el.addEventListener('click', () => {
          const nv = !Store.get(path);
          Store.set(path, nv);
          sync();
          if (navigator.vibrate && CONFIG.IS_MOBILE) navigator.vibrate(8);
          if (onChange) onChange(nv);
          else ApplyReq.soft();
        }, { signal: sig });

        el.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); el.click(); }
        }, { signal: sig });

        tabFns.push(sync); sync();
        return el;
      }

      function delegatedChipRow(label, path, chips, onSelect) {
        const wrap = h('div', {},
          h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label)
        );
        const row = h('div', { class: 'chips' });

        for (const ch of chips) {
          row.appendChild(
            h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l)
          );
        }

        row.addEventListener('click', (e) => {
          const chip = e.target.closest('.chip');
          if (!chip) return;
          const val = chip.dataset.v;
          Store.set(path, val);
          domBatcher.write(() => {
            for (const c of row.children) {
              c.classList.toggle('on', c.dataset.v === val);
            }
          });
          if (onSelect) onSelect(val);
          else ApplyReq.soft();
        }, { signal: sig });

        function sync() {
          const cur = String(Store.get(path));
          for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur);
        }

        wrap.appendChild(row); tabFns.push(sync); sync();
        return wrap;
      }

      function buildVideoTab() {
        const w = h('div', {}); const infoBar = h('div', { class: 'info-bar' });
        function updateInfo() {
          const active = window[VSC_INTERNAL_SYM]._activeVideo;
          const video = (active && active.isConnected) ? active : (() => { try { return document.querySelector('video'); } catch (_) { return null; } })();
          if (!video || !video.isConnected) { infoBar.textContent = '영상 없음'; return; }
          const nW = video.videoWidth || 0, nH = video.videoHeight || 0, dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0;
          if (nW === 0 || nH === 0) { infoBar.textContent = '로딩 중...'; return; }
          const { autoBase } = computeResolutionSharpMul(video); const presetS = Store.get(P.V_PRE_S);
          let sharpLabel = presetS === 'none' ? '꺼짐(OFF)' : (presetS === 'off' ? `자동(${autoBase.toFixed(3)})` : `${getPresetLabel('detail', presetS)} (수동)`);
          infoBar.textContent = `원본 ${nW}×${nH} → 출력 ${dW}×${dH}  │  샤프닝: ${sharpLabel}`;
        }
        Bus.on('signal', updateInfo); tabFns.push(updateInfo); updateInfo();

        const motionSpark = createSparkline(280, 36, 100);
        const sparkWrap = h('div', { style: 'padding:4px 0' },
          h('label', { style: 'font-size:10px;opacity:.4;display:block;margin-bottom:2px' }, 'Motion SAD'),
          motionSpark.canvas
        );
        Bus.on('signal', () => {
          const sad = AutoScene.getLastMotionSAD?.() || 0;
          motionSpark.push(sad);
        });
        sig.addEventListener('abort', () => motionSpark.destroy(), { once: true });

        w.append(infoBar, sparkWrap, mkSep());

        if (CONFIG.IS_FIREFOX) {
          w.append(
            h('div', { style: 'padding:10px;background:rgba(255,100,100,0.1);border-radius:8px;font-size:11px;color:#ff8888;margin-bottom:10px;line-height:1.4' },
              "ℹ️ 파이어폭스 브라우저 제약으로 선명도 및 고급 암부 보정이 비활성화되었습니다. (재생속도/오디오/기본 밝기 사용 가능)"
            ),
            mkRow('노출 보정 (CSS)', ...mkOptimizedSlider(P.V_MAN_BRT, 0, 100, 1)),
            mkSep()
          );
        } else {
          w.append(
            delegatedChipRow('디테일 프리셋', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: getPresetLabel('detail', k) })), () => ApplyReq.hard()),
            mkRow('강도 믹스', ...mkOptimizedSlider(P.V_PRE_MIX, 0, 1, 0.01)),
            mkSep()
          );

          const manualHeader = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
            h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '수동 보정'),
            h('div', { style: 'display:flex;gap:4px' },
              ...[
                { n: 'OFF',  v: [0,  0,  0,  0  ] },
                { n: '선명', v: [32, 17,  0,  0  ] },
                { n: '복원', v: [32, 49,  7,  0  ] },
                { n: '영화', v: [13, 23, 14, -22 ] },
                { n: '심야', v: [54, 37,  0, -12  ] },
                { n: '아트', v: [0,  41, 11, -19 ] },
              ].map(p => {
                const btn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:36px;font-size:10px;background:rgba(110,168,254,0.1)' }, p.n);
                btn.onclick = () => {
                  Store.batch('video', {
                    manualShadow: p.v[0],
                    manualRecovery: p.v[1],
                    manualBright: p.v[2],
                    manualTemp: p.v[3]
                  });
                  ApplyReq.hard(); persistNow(); syncAll();
                  showOSD(`추천 프리셋 [${p.n}] 적용됨`, 1000);
                };
                return btn;
              })
            )
          );
          w.append(manualHeader);

          function mkSliderWithFine(label, path, min, max, step, fineStep) {
            const [slider, valEl] = mkOptimizedSlider(path, min, max, step);
            const syncSliderUI = () => {
              const v = Number(Store.get(path)) || 0; slider.value = String(v); valEl.textContent = String(Math.round(v));
              const pct = ((v - min) / (max - min)) * 100; slider.style.setProperty('--fill', `${pct}%`);
            };
            const mkFine = (delta, text) => {
              const btn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:32px;min-height:28px;font-size:11px' }, text);
              btn.addEventListener('click', () => {
                const cur = Number(Store.get(path)) || 0; const nv = VSC_CLAMP(Math.round(cur + delta), min, max);
                Store.set(path, nv); ApplyReq.hard(); persistNow(); syncSliderUI();
              }, { signal: sig });
              return btn;
            };
            const resetBtn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:24px;min-height:28px;font-size:10px;opacity:.6' }, '0');
            resetBtn.addEventListener('click', () => { Store.set(path, 0); ApplyReq.hard(); persistNow(); syncSliderUI(); }, { signal: sig });
            const fineRow = h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn);
            tabFns.push(syncSliderUI);
            return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, fineRow));
          }

          w.append(
            mkSliderWithFine('암부 부스트', P.V_MAN_SHAD, 0, 100, 1, 5),
            mkSliderWithFine('디테일 복원', P.V_MAN_REC, 0, 100, 1, 5),
            mkSliderWithFine('노출 보정', P.V_MAN_BRT, 0, 100, 1, 5),
            mkSliderWithFine('색온도', P.V_MAN_TEMP, -50, 50, 1, 5),
            mkSep()
          );

          const sceneBadge = h('span', { class: 'badge', style: 'display:none' }, '');
          function updateSceneBadge() {
            const isOn = !!Store.get(P.APP_AUTO_SCENE);
            if (isOn) { sceneBadge.style.display = ''; sceneBadge.textContent = AutoScene.getSceneTypeName?.() || ''; }
            else { sceneBadge.style.display = 'none'; sceneBadge.textContent = ''; }
          }
          w.append(h('div', { class: 'row' },
            h('label', {}, '자동 보정 (AutoScene) ', sceneBadge),
            mkOptimizedToggle(P.APP_AUTO_SCENE, v => {
              if (v) AutoScene.start(); else AutoScene.stop();
              updateSceneBadge(); ApplyReq.hard();
            })
          ));
          Bus.on('signal', updateSceneBadge); tabFns.push(updateSceneBadge); updateSceneBadge();

          const gpuToggle = mkOptimizedToggle(P.APP_GPU_EN, (nv) => {
            window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !!nv;
            if (nv) { showOSD('GPU 장면분석 활성화 시도…', 1200); try { window[VSC_INTERNAL_SYM]?._gpuSceneInit?.(); } catch (_) {} }
            else { showOSD('GPU 장면분석 OFF → CPU fallback', 1200); try { window[VSC_INTERNAL_SYM]?._gpuSceneDestroy?.(); } catch (_) {} }
            ApplyReq.soft();
          });
          w.append(h('div', { class: 'row' }, h('label', {}, 'GPU 하드웨어 가속'), gpuToggle), mkSep());
        }

        /* ── 비디오 변환 섹션 ── */
        const transformSep = mkSep();
        const transformLabel = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
          h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '비디오 변환'),
          (() => {
            const resetBtn = h('button', { class: 'fine-btn', style: 'padding:2px 8px;min-width:40px;font-size:10px;color:#ff8888;border-color:rgba(255,136,136,0.3)' }, '리셋');
            resetBtn.onclick = () => { resetVideoTransform(Store); syncTransformUI(); };
            return resetBtn;
          })()
        );

        const fitChips = h('div', { class: 'chips' });
        VID_FIT_MODES.forEach(mode => {
          const chip = h('span', { class: 'chip', 'data-v': mode }, VID_FIT_LABELS[mode]);
          chip.addEventListener('click', () => {
            Store.set(P.APP_VID_FIT, mode);
            const v = window[VSC_INTERNAL_SYM]?._activeVideo;
            if (v) applyVideoTransform(v, Store);
            syncTransformUI();
            persistNow();
            showOSD(`화면 비율: ${VID_FIT_LABELS[mode]}`, 1000);
          }, { signal: sig });
          fitChips.appendChild(chip);
        });

        const rotRow = h('div', { style: 'display:flex;gap:4px;padding:4px 0;align-items:center' });
        const rotLabel = h('span', { style: 'font-size:11px;opacity:.7;flex:1' }, '회전');
        const rotValLabel = h('span', { style: 'font-size:11px;color:var(--vsc-neon);min-width:30px;text-align:center' }, '0°');
        const rotBtns = [0, 90, 180, 270].map(deg => {
          const btn = h('button', { class: 'fine-btn', style: 'padding:3px 8px;min-width:36px;font-size:11px', 'data-v': String(deg) }, `${deg}°`);
          btn.addEventListener('click', () => {
            Store.set(P.APP_VID_ROT, deg);
            const v = window[VSC_INTERNAL_SYM]?._activeVideo;
            if (v) applyVideoTransform(v, Store);
            syncTransformUI();
            persistNow();
            showOSD(`회전: ${deg}°`, 1000);
          }, { signal: sig });
          return btn;
        });
        rotRow.append(rotLabel, ...rotBtns, rotValLabel);

        function syncTransformUI() {
          const curFit = Store.get(P.APP_VID_FIT) || 'contain';
          for (const c of fitChips.children) c.classList.toggle('on', c.dataset.v === curFit);
          const curRot = Number(Store.get(P.APP_VID_ROT)) || 0;
          rotValLabel.textContent = `${curRot}°`;
          for (const btn of rotBtns) btn.classList.toggle('on', btn.dataset.v === String(curRot));
        }
        tabFns.push(syncTransformUI);
        syncTransformUI();

        w.append(transformSep, transformLabel,
          h('div', { style: 'padding:2px 0' },
            h('label', { style: 'font-size:11px;opacity:.7;display:block;margin-bottom:2px' }, '화면 비율'),
            fitChips
          ),
          rotRow,
          h('div', { style: 'font-size:10px;opacity:.35;padding:2px 0;line-height:1.4' }, '단축키: Alt+F (비율 순환) │ Alt+T (90° 회전)')
        );

        const arrSpan = h('span', { class: 'arr' }, '▶');
        const advHd = h('div', { class: 'adv-hd' }, arrSpan, ' 고급 설정');
        const advBd = h('div', { class: 'adv-bd' });
        advHd.addEventListener('click', () => {
          advancedOpen = !advancedOpen;
          arrSpan.classList.toggle('open', advancedOpen);
          advBd.classList.toggle('open', advancedOpen);
        }, { signal: sig });
        w.append(advHd, advBd);

        w.append(mkSep());

        const brtBtns = [];
        const brtChips = h('div', { class: 'chips' });

        SCR_BRT_LABELS.forEach((label, idx) => {
          if (idx === 0) return;
          const chip = h('span', { class: 'chip', 'data-v': String(idx) }, label === '기본' ? '☀ 기본' : '☀ ' + (idx - 0));
          chip.addEventListener('click', () => {
            Store.set(P.APP_SCREEN_BRT, idx); applyScrBrt(idx); persistNow(); syncBrt();
            showOSD('화면 조도: ' + label, 1000);
          }, { signal: sig });
          brtBtns.push(chip); brtChips.appendChild(chip);
        });

        const brtResetBtn = h('button', {
          class: 'chip',
          style: 'margin-left:auto; flex:none; width:70px; font-size:10px; border-color:var(--vsc-text-muted); color: #fff !important;'}, '리셋(OFF)');
        brtResetBtn.addEventListener('click', () => {
          Store.set(P.APP_SCREEN_BRT, 0); applyScrBrt(0); persistNow(); syncBrt();
          showOSD('화면 조도: ' + SCR_BRT_LABELS[0], 1000);
        }, { signal: sig });

        const brtValLabel = h('span', { style: 'font-size:11px;color:var(--vsc-neon);margin-left:6px' }, '');

        function syncBrt() {
          const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0;
          brtBtns.forEach((btn) => { btn.classList.toggle('on', btn.dataset.v === String(cur)); });
          brtResetBtn.classList.toggle('on', cur === 0);
          brtValLabel.textContent = SCR_BRT_LABELS[cur];
        }
        tabFns.push(syncBrt); syncBrt();

        w.append(
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
            h('div', { style: 'display:flex;align-items:center' },
              h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '화면 조도 (Dimmer)'),
              brtValLabel
            ),
            brtResetBtn
          ),
          brtChips,
          h('div', { style: 'font-size:10px;opacity:.35;padding:4px 0 0;line-height:1.4' }, '단축키: Alt+L  │  영상 외 전체 화면의 조도를 줄여줍니다')
        );

        return w;
      }

      function buildAudioTab() {
        const w = h('div', {});
        w.append(mkRow('오디오 부스트', mkOptimizedToggle(P.A_EN, () => ApplyReq.soft())), mkRow('부스트 (dB)', ...mkOptimizedSlider(P.A_BST, 0, 15, 0.5)));
        const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0' }, '오디오: 대기');
        Bus.on('signal', () => { const ctxReady = Audio.hasCtx(), hooked = Audio.isHooked(); status.textContent = `상태: ${ctxReady ? (hooked ? '활성' : '준비') : '대기'}`; });
        w.append(mkSep(), status); return w;
      }

      function buildPlaybackTab() {
        const w = h('div', {}); w.append(mkRow('속도 제어', mkOptimizedToggle(P.PB_EN, () => ApplyReq.hard())));
        const rateDisplay = h('div', { class: 'rate-display' }); function syncRateDisplay() { const r = Number(Store.get(P.PB_RATE)) || 1; rateDisplay.textContent = `${r.toFixed(2)}×`; }
        tabFns.push(syncRateDisplay); syncRateDisplay(); w.append(rateDisplay);
        const chipRow = h('div', { class: 'chips' }); function syncChips() { const cur = Number(Store.get(P.PB_RATE)) || 1; for (const c of chipRow.children) { const cv = parseFloat(c.dataset.v); c.classList.toggle('on', Math.abs(cur - cv) < 0.01); } }
        for (const p of [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]) { const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`); el.addEventListener('click', () => { Store.set(P.PB_RATE, p); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); syncRateDisplay(); syncChips(); }, { signal: sig }); chipRow.appendChild(el); }
        tabFns.push(syncChips); syncChips(); w.append(chipRow);
        const fineRow = h('div', { class: 'fine-row' });
        const adjustRate = (delta) => { const cur = Number(Store.get(P.PB_RATE)) || 1; const nv = VSC_CLAMP(cur + delta, 0.07, 16); Store.set(P.PB_RATE, nv); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); syncRateDisplay(); syncChips(); };
        for (const fs of [{ label: '−0.25', delta: -0.25 }, { label: '−0.05', delta: -0.05 }, { label: '+0.05', delta: +0.05 }, { label: '+0.25', delta: +0.25 }]) { const btn = h('button', { class: 'fine-btn' }, fs.label); btn.addEventListener('click', () => adjustRate(fs.delta), { signal: sig }); fineRow.appendChild(btn); }
        w.append(fineRow, mkRow('속도 슬라이더', ...mkOptimizedSlider(P.PB_RATE, 0.07, 4, 0.01)), h('div', { style: 'font-size:10px;opacity:.4;text-align:center;padding:4px 0' }, '단축키: [ ] 속도 ±0.1'));
        Store.sub(P.PB_RATE, () => { syncRateDisplay(); syncChips(); }); return w;
      }

      function buildAppTab() {
        const w = h('div', {});
        w.append(mkRow('모든 영상 적용', mkOptimizedToggle(P.APP_APPLY_ALL, () => ApplyReq.hard())), mkSep(), h('label', { style: 'font-size:12px;opacity:.8;display:block;padding:4px 0' }, '프리셋 슬롯'));
        const slotsRow = h('div', { style: 'display:flex;gap:6px;padding:4px 0' });
        for (let i = 0; i < 3; i++) {
          const saveBtn = h('button', { class: 'btn', style: 'font-size:10px;padding:3px 8px' }, `저장 ${i + 1}`), loadBtn = h('button', { class: 'btn pr', style: 'font-size:10px;padding:3px 8px' }, `적용 ${i + 1}`);
          saveBtn.addEventListener('click', () => saveSlot(i), { signal: sig }); loadBtn.addEventListener('click', () => { loadSlot(i); syncAll(); }, { signal: sig });
          slotsRow.append(h('div', { style: 'display:flex;flex-direction:column;gap:3px' }, saveBtn, loadBtn));
        }
        w.append(slotsRow, mkSep());
        const expBtn = h('button', { class: 'btn' }, '내보내기'), impBtn = h('button', { class: 'btn' }, '가져오기'), rstBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '전체 초기화');
        expBtn.addEventListener('click', doExport, { signal: sig }); impBtn.addEventListener('click', doImport, { signal: sig }); rstBtn.addEventListener('click', () => { resetDefaults(); syncAll(); ApplyReq.hard(); persistNow(); showOSD('설정이 초기화되었습니다', 1500); }, { signal: sig });
        w.append(h('div', { style: 'display:flex;gap:6px;padding:4px 0' }, expBtn, impBtn, rstBtn), mkSep());

        const shortcutArrSpan = h('span', { class: 'arr' }, '▶'), shortcutHd = h('div', { class: 'adv-hd' }, shortcutArrSpan, ' 단축키 안내'), shortcutBd = h('div', { class: 'adv-bd' });
        let shortcutOpen = false; shortcutHd.addEventListener('click', () => { shortcutOpen = !shortcutOpen; shortcutArrSpan.classList.toggle('open', shortcutOpen); shortcutBd.classList.toggle('open', shortcutOpen); }, { signal: sig });
        const shortcuts = [
          ['Alt + V', '설정 패널 열기/닫기'],
          ['Alt + F', '화면 비율 (Fit/Fill) 순환'],
          ['Alt + T', '화면 90° 회전'],
          ['Alt + L', '화면 조도 단계 순환'],
          ['Alt + P', 'PiP 전환'],
          ['Alt + M', '최대화 토글'],
          ['Alt + Z', '줌 ON/OFF 토글'],
          ['Alt + A', '자동 보정 ON/OFF'],
          ['Alt + S', '프레임 캡처'],
          ['Alt + G', 'GPU 장면분석 토글'],
          ['Alt + B', 'A/B 원본 비교 토글'],
          ['Alt + 0', '줌 리셋'],
          ['Alt + 1~3', '프리셋 슬롯 불러오기'],
          ['Shift + Alt + 1~3', '프리셋 슬롯 저장'],
          ['Alt + R', '전체 초기화'],
          ['[ / ]', '재생 속도 ±0.1'],
          ['Esc', '패널 닫기 / 최대화 해제'],
          ['Alt + Wheel', '줌 확대/축소'],
          ['Alt + 드래그', '줌 팬 이동'],
          ['Alt + 더블클릭', '줌 2.5× / 리셋']
        ];
        const grid = h('div', { class: 'shortcut-grid' }); for (const [key, desc] of shortcuts) { grid.append(h('span', { class: 'sk' }, key), h('span', { class: 'sd' }, desc)); }
        shortcutBd.appendChild(grid); w.append(shortcutHd, shortcutBd, mkSep(), h('div', { style: 'font-size:10px;opacity:.35;padding:2px 0' }, `Video_Control v${VSC_VERSION}`));
        return w;
      }

      function renderTab() {
        const body = _shadow?.querySelector('.body'); if (!body) return;
        body.innerHTML = '';
        tabFns.length = 0;
        switch (activeTab) { case 'video': body.appendChild(buildVideoTab()); break; case 'audio': body.appendChild(buildAudioTab()); break; case 'playback': body.appendChild(buildPlaybackTab()); break; case 'app': body.appendChild(buildAppTab()); break; }
        const tabBar = _shadow.querySelector('.tabs');
        if (tabBar) updateTabIndicator(tabBar, activeTab);
      }

      function switchTab(t) {
        activeTab = t;
        if (_shadow) {
          const tabBar = _shadow.querySelector('.tabs');
          updateTabIndicator(tabBar, t);
        }
        renderTab();
      }

      function hasAnyVideo() { if (Registry.videos.size > 0) return true; try { return document.querySelector('video') !== null; } catch (_) { return false; } }
      function updateQuickBarVisibility() { if (!quickBarHost) return; const has = hasAnyVideo(); if (has && !qbarVisible) { quickBarHost.style.display = ''; qbarVisible = true; } else if (!has && qbarVisible) { quickBarHost.style.display = 'none'; qbarVisible = false; if (panelOpen) togglePanel(false); } }

      function getMountTarget() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) {
          let target = fsEl;
          while (target && target !== document.documentElement) {
            const s = getComputedStyle(target);
            if (s.overflow === 'hidden' || s.contain === 'strict' || s.contain === 'content') break;
            target = target.parentElement;
          }
          return target || fsEl;
        }
        return document.documentElement || document.body;
      }

      function ensureJwPlayerUnclip(mountTarget) {
        if (!mountTarget) return;
        let el = mountTarget;
        while (el && el !== document.documentElement) {
          const s = getComputedStyle(el);
          const isJwContainer = el.classList?.toString().includes('jw') || el.id?.includes('jw') || el.querySelector?.('.jwplayer');
          if (isJwContainer && (s.overflow === 'hidden' || s.contain !== 'none')) { }
          el = el.parentElement;
        }
        if (quickBarHost) {
          quickBarHost.style.setProperty('position', 'fixed', 'important');
          quickBarHost.style.setProperty('contain', 'none', 'important');
          quickBarHost.style.setProperty('overflow', 'visible', 'important');
        }
        if (panelHost) {
          panelHost.style.setProperty('position', 'fixed', 'important');
          panelHost.style.setProperty('contain', 'none', 'important');
          panelHost.style.setProperty('overflow', 'visible', 'important');
        }
      }

      function reparentForFullscreen() {
        if (!quickBarHost) return;
        const targetParent = getMountTarget();
        if (!targetParent) return;
        if (quickBarHost.parentNode !== targetParent) { try { targetParent.appendChild(quickBarHost); } catch (_) {} }
        if (panelHost && panelHost.parentNode !== targetParent) { try { targetParent.appendChild(panelHost); } catch (_) {} }
        ensureJwPlayerUnclip(targetParent);
      }

      function buildPanel() {
        if (panelHost) return;
        panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host' }); _shadow = panelHost.attachShadow({ mode: 'closed' }); _shadow.appendChild(h('style', {}, PANEL_CSS)); panelEl = h('div', { class: 'panel' });
        const closeBtn = h('button', { class: 'btn', style: 'padding:2px 8px;font-size:12px;margin-left:8px' }, '✕'); closeBtn.addEventListener('click', () => togglePanel(false), { signal: sig });

        const statusDots = h('div', { class: 'hdr-status', title: '상태 인디케이터' });
        const gpuDot = h('span', { class: 'hdr-dot gray', 'data-label': 'GPU' }), dspDot = h('span', { class: 'hdr-dot gray', 'data-label': 'DSP' }), drmDot = h('span', { class: 'hdr-dot gray', style: 'display:none', 'data-label': 'DRM' });
        statusDots.append(gpuDot, dspDot, drmDot);

        function syncStatusDots() {
          const gpuSt = getGpuStatus(); gpuDot.className = `hdr-dot ${gpuSt === 'active' ? 'green' : (gpuSt === 'fallback' ? 'amber' : 'gray')}`;
          const dspSt = getDspStatus(); dspDot.className = `hdr-dot ${dspSt === 'worklet' ? 'green' : (dspSt === 'legacy' ? 'amber' : 'gray')}`;
          if (isDrmDetected()) { drmDot.style.display = ''; drmDot.className = 'hdr-dot red'; } else { drmDot.style.display = 'none'; }
        }
        Bus.on('signal', syncStatusDots); permanentFns.push(syncStatusDots); syncStatusDots();

        panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), statusDots, h('span', { class: 'ver' }, `v${VSC_VERSION}`), closeBtn));
        const tabBar = h('div', { class: 'tabs' });
        for (const t of ['video', 'audio', 'playback', 'app']) {
          const iconEl = TAB_ICONS[t]?.();
          const labelSpan = h('span', {}, TAB_LABELS[t]);
          const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t });
          if (iconEl) tab.appendChild(iconEl);
          tab.appendChild(labelSpan);
          tab.addEventListener('click', () => switchTab(t), { signal: sig });
          tabBar.appendChild(tab);
        }
        panelEl.appendChild(tabBar); panelEl.appendChild(h('div', { class: 'body' })); panelEl.appendChild(createSmartMetrics());
        _shadow.appendChild(panelEl); renderTab();

        const mountTarget = getMountTarget();
        mountTarget.appendChild(panelHost);
        blockInterference(panelHost);
        ensureJwPlayerUnclip(mountTarget);
      }

      function buildQuickBar() {
        if (quickBarHost) return;
        quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: 'all:initial; position:fixed !important; top:0; left:0; width:0; height:0; z-index:2147483647 !important; pointer-events:none; display:none; contain:none !important; overflow:visible !important;' });
        qbarVisible = false; const sh = quickBarHost.attachShadow({ mode: 'closed' }); _qbarShadow = sh; sh.appendChild(h('style', {}, PANEL_CSS));

        const bar = h('div', { class: 'qbar' }); let expanded = false; let expandTimer = 0;
        const makeIcon = (name) => { const svg = svgIcon(name, 18); svg.style.display = 'block'; svg.style.pointerEvents = 'none'; return svg; };

        function resetExpandTimer() {
          if (expandTimer) clearTimer(expandTimer);
          if (expanded) expandTimer = setTimer(() => {
            if (expanded && !panelOpen) {
              expanded = false; bar.classList.remove('expanded');
              for (const sub of bar.querySelectorAll('.qb-sub')) {
                sub.style.pointerEvents = 'none';
                sub.style.visibility = 'hidden';
              }
            }
          }, 4500);
        }

        const mainBtn = h('div', { class: 'qb qb-main', title: '메뉴 열기' }); mainBtn.appendChild(makeIcon('gear'));
        mainBtn.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation(); expanded = !expanded; bar.classList.toggle('expanded', expanded);
          if (!expanded) {
            for (const sub of bar.querySelectorAll('.qb-sub')) {
              sub.style.pointerEvents = 'none';
              sub.style.visibility = 'hidden';
            }
          } else {
            for (const sub of bar.querySelectorAll('.qb-sub')) {
              sub.style.pointerEvents = '';
              sub.style.visibility = '';
            }
          }
          resetExpandTimer();
        }, { signal: sig });

        const subBtns = [
          { icon: 'gear', title: '설정 패널', fn: () => { togglePanel(); expanded = false; bar.classList.remove('expanded'); } },
          { icon: 'pip', title: 'PiP 전환', fn: () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) togglePiPFor(v); resetExpandTimer(); } },
          { icon: 'maximize', title: '최대화', fn: () => { Maximizer.toggle(); resetExpandTimer(); } },
          { icon: 'camera', title: '프레임 캡처', fn: () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) captureVideoFrame(v); resetExpandTimer(); } }
        ].map(cfg => {
          const btn = h('div', { class: 'qb qb-sub', title: cfg.title }); btn.appendChild(makeIcon(cfg.icon));
          btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); cfg.fn(); }, { signal: sig });
          return btn;
        });

        const fitBtn = h('div', { class: 'qb qb-sub', title: '화면 비율 전환 (Alt+F)' });
        fitBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><rect x="6" y="6" width="12" height="12" rx="1" opacity="0.4"/></svg>';
        fitBtn.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          cycleVideoFit(Store); resetExpandTimer();
        }, { signal: sig });
        subBtns.push(fitBtn);

        if (ZoomMgr) {
          const zoomBtn = h('div', { class: 'qb qb-sub', title: '줌 ON/OFF (Alt+Z)' }); zoomBtn.appendChild(makeIcon('zoom'));
          const syncZoomStyle = () => { const en = !!Store.get(P.APP_ZOOM_EN); zoomBtn.style.background = en ? 'rgba(110,168,254,.35)' : ''; zoomBtn.style.borderColor = en ? 'rgba(110,168,254,.5)' : ''; };
          zoomBtn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const wasOn = !!Store.get(P.APP_ZOOM_EN);
            if (wasOn) { Store.set(P.APP_ZOOM_EN, false); const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) ZoomMgr.resetZoom(v); showOSD('줌 OFF', 900); }
            else { Store.set(P.APP_ZOOM_EN, true); showOSD('줌 ON', 1500); }
            syncZoomStyle(); ApplyReq.soft(); persistNow(); resetExpandTimer();
          }, { signal: sig });
          Store.sub(P.APP_ZOOM_EN, syncZoomStyle); syncZoomStyle(); subBtns.push(zoomBtn);
        }

        bar.append(mainBtn, ...subBtns); sh.appendChild(bar);
        const mount = () => {
          const target = getMountTarget();
          target.appendChild(quickBarHost);
          ensureJwPlayerUnclip(target);
        };
        if (document.body) mount(); else window.addEventListener('DOMContentLoaded', mount, { once: true });
      }

      function togglePanel(force) {
        const show = (force !== undefined) ? force : !panelOpen;
        if (show) {
          buildPanel(); reparentForFullscreen();
          if (panelHost) panelHost.style.pointerEvents = '';
          togglePanelOptimized(panelEl, true);
        } else {
          togglePanelOptimized(panelEl, false, () => {
            if (!panelOpen && panelHost) panelHost.style.pointerEvents = 'none';
          });
        }
        panelOpen = show; Store.set(P.APP_UI, show);
      }

      function init() {
        buildQuickBar();
        initStoreSubscriptions(Store, syncAll);
        setRecurring(updateQuickBarVisibility, 1500, { maxErrors: 50 });
        Bus.on('signal', updateQuickBarVisibility);
        onDoc('fullscreenchange', reparentForFullscreen);
        onDoc('webkitfullscreenchange', reparentForFullscreen);
        updateQuickBarVisibility();
        window[VSC_INTERNAL_SYM]._uiEnsure = () => {
          updateQuickBarVisibility();
          reparentForFullscreen();
          syncAll();
        };
      }

      function destroy() {
        uiAC.abort();
        panelHost?.remove(); quickBarHost?.remove();
        panelHost = null; panelEl = null; quickBarHost = null;
        _shadow = null; _qbarShadow = null;
        tabFns.length = 0; permanentFns.length = 0;
        qbarVisible = false;
        if (window[VSC_INTERNAL_SYM]._uiEnsure) { window[VSC_INTERNAL_SYM]._uiEnsure = () => {}; }
      }

      return Object.freeze({ init, destroy, togglePanel, syncAll, switchTab });
    }

    /* ══════════════════════════════════════════════════════════════════
       Save / Restore / Reset / Import / Export
       ══════════════════════════════════════════════════════════════════ */
    const _SAVE_CATS = ['video', 'audio', 'playback', 'app'];

    const buildSaveDataFrom = sm => ({
      version: VSC_VERSION,
      ...Object.fromEntries(_SAVE_CATS.map(c => [c, {...sm.getCatRef(c)}]))
    });

    const restoreData = (sm, data) => {
      if (!data) return;
      for (const c of _SAVE_CATS) {
        if (!data[c]) continue;
        if (c === 'app') {
          const {slots, ...rest} = data[c];
          sm.batch(c, rest);
          if (Array.isArray(slots)) sm.set('app.slots', slots);
        } else {
          const merged = { ...DEFAULTS[c], ...data[c] };
          sm.batch(c, merged);
        }
      }
      normalizeBySchema(sm, ALL_SCHEMAS);
    };

    let __Store = null, __ApplyReq = null;
    function resetDefaults() {
      if (!__Store) return;
      const d = typeof structuredClone === 'function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS));
      for (const [cat, vals] of Object.entries(d)) __Store.batch(cat, vals);
      const v = window[VSC_INTERNAL_SYM]?._activeVideo;
      if (v) clearVideoTransform(v);

      try {
        const ov = document.getElementById('vsc-scr-brt');
        if (ov) {
          ov.style.opacity = '0';
          setTimeout(() => { if (ov.style.opacity === '0') ov.style.display = 'none'; }, 350);
        }
      } catch (_) {}
    }

    function slotAction(idx, save) {
      if (!__Store) return;
      if (save) {
        const slots = [...(__Store.getCatRef('app').slots || [null, null, null])];
        slots[idx] = buildSaveDataFrom(__Store);
        __Store.set('app.slots', slots); persistNow();
        showOSD(`슬롯 ${idx + 1} 저장됨`, 1200);
      } else {
        const data = (__Store.getCatRef('app').slots || [])[idx];
        if (!data) { showOSD(`슬롯 ${idx + 1} 비어있음`, 1000); return; }
        restoreData(__Store, data); __ApplyReq?.hard(); persistNow();
        showOSD(`슬롯 ${idx + 1} 불러옴`, 1200);
      }
    }
    const saveSlot = i => slotAction(i, true);
    const loadSlot = i => slotAction(i, false);

    function doExport() { if (!__Store) return; const json = JSON.stringify(buildSaveDataFrom(__Store), null, 2); const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `vsc-settings-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimer(() => URL.revokeObjectURL(url), 3000); showOSD('설정 내보내기 완료', 1200); }
    function doImport() {
      if (!__Store) return;
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'; inp.style.display = 'none';
      inp.addEventListener('change', () => { const f = inp.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const data = JSON.parse(rd.result); restoreData(__Store, data); __ApplyReq?.hard(); persistNow(); showOSD('설정 가져오기 완료', 1200); } catch (e) { showOSD('가져오기 실패', 1500); log.warn('Import error', e); } }; rd.readAsText(f); });
      document.body.appendChild(inp); inp.click(); inp.remove();
    }

    let __persistTimer = 0;
    function persistNow() { if (!__Store) return; clearTimer(__persistTimer); __persistTimer = setTimer(() => { try { GM_setValue(STORAGE_KEY, JSON.stringify(buildSaveDataFrom(__Store))); log.debug('[Persist] saved', STORAGE_KEY); } catch (e) { log.warn('[Persist] save error', e); } }, 600); }
    function loadPersisted(sm) {
      try {
        let raw = GM_getValue(STORAGE_KEY, null);
        if (!raw && location.hostname.endsWith('youtube.com')) {
          const isShorts = location.pathname.startsWith('/shorts'), isWatch = location.pathname.startsWith('/watch');
          if (isShorts || isWatch) {
            const oldKey = STORAGE_KEY_BASE + (isShorts ? '__shorts' : '__watch');
            const legacyData = GM_getValue(oldKey, null);
            if (legacyData) { raw = legacyData; GM_setValue(STORAGE_KEY, raw); log.info('[Persist] Legacy YouTube settings migrated from:', oldKey); }
          }
        }
        if (!raw) return;
        const data = (typeof raw === 'string') ? JSON.parse(raw) : raw; restoreData(sm, data);
        log.info('[Persist] successfully loaded from', STORAGE_KEY);
      } catch (e) { log.warn('[Persist] load error', e); }
    }

    /* ══════════════════════════════════════════════════════════════════
       bindVideoOnce
       ══════════════════════════════════════════════════════════════════ */
    function bindVideoFrameSync(video, applyFn) {
      if (typeof video.requestVideoFrameCallback !== 'function') return null;
      let active = true;
      let lastPresentedFrames = -1;
      function onFrame(now, metadata) {
        if (!active || !video.isConnected) return;
        if (metadata.presentedFrames !== lastPresentedFrames) {
          lastPresentedFrames = metadata.presentedFrames;
          applyFn(video, false);
        }
        video.requestVideoFrameCallback(onFrame);
      }
      video.requestVideoFrameCallback(onFrame);
      return () => { active = false; };
    }

    function bindVideoOnce(video, Store, Registry, AutoScene, ApplyReq, ZoomMgr) {
      const st = getVState(video); if (st.bound) return; st.bound = true;
      const videoAC = new AbortController(); const videoSig = getCombinedSignal(videoAC.signal); st._ac = videoAC;
      touchedAddLimited(TOUCHED.videos, video, (evicted) => {
        const evictedState = getVState(evicted);
        const evictedAC = evictedState._ac;
        queueMicrotask(() => {
          if (evictedState._ac !== evictedAC) return;
          if (!evictedState.bound) return;
          if (evictedAC) { evictedAC.abort(); evictedState._ac = null; evictedState.bound = false; }
          vscClearAllStyles(evicted);
        });
      });
      on(video, 'resize', () => { st._resizeDirty = true; _sharpMulCache.delete(video); }, { signal: videoSig });
      const onVideoReady = () => { st._resizeDirty = true; ApplyReq.hard(); };
      on(video, 'loadedmetadata', onVideoReady, { signal: videoSig }); on(video, 'loadeddata', onVideoReady, { signal: videoSig });
      if (video.readyState >= 1) setTimer(() => { if (!videoSig.aborted) ApplyReq.hard(); }, 80);

      on(video, 'encrypted', () => {
        if (__encryptedVideos.has(video)) return;
        __encryptedVideos.add(video); const rs = getRateState(video);
        if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig; } catch (_) {} }
        rs.permanentlyBlocked = true; log.info('[DRM] encrypted event detected, rate control blocked for this video');
      }, { signal: videoSig });

      on(video, 'waitingforkey', () => { __encryptedVideos.add(video); const rs = getRateState(video); if (!rs.permanentlyBlocked) { rs.permanentlyBlocked = true; if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig; } catch (_) {} } log.info('[DRM] waitingforkey detected, rate control blocked'); } }, { signal: videoSig });

      function safeSetRate(v, s, rate) {
        s.rateState._settingRate = true;
        s.rateState.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
        try { v.playbackRate = rate; } catch (_) {}
        s.rateState._lastRateSetTime = performance.now();
        queueMicrotask(() => { s.rateState._settingRate = false; });
      }

      on(video, 'ratechange', () => {
        if (st.rateState._settingRate) return;
        const now = performance.now();
        if (now - (st.rateState._lastRateChangeT || 0) < 80) return;
        st.rateState._lastRateChangeT = now;

        if (!Store.get(P.PB_EN)) return;
        if (st.rateState.permanentlyBlocked) return;

        const expected = Number(Store.get(P.PB_RATE));
        if (!Number.isFinite(expected)) return;

        if (Math.abs(video.playbackRate - expected) < 0.002) {
          st.rateState._rateRetryCount = 0;
          return;
        }

        if (now < st.rateState.suppressSyncUntil) return;
        if (now - st.rateState._lastRateSetTime < 150) return;

        st.rateState._rateRetryCount++;

        if (st.rateState._rateRetryCount > RATE_MAX_RETRY) {
          st.rateState.permanentlyBlocked = true;
          if (st.rateState.orig != null) {
            st.rateState.suppressSyncUntil = now + RATE_SUPPRESS_MS;
            try { video.playbackRate = st.rateState.orig; } catch (_) {}
          }
          log.info('[RateGuard] Site is fighting back, rate control disabled');
          return;
        }

        if (__rateBlockedSite || isVideoEncrypted(video)) {
          st.rateState.permanentlyBlocked = true;
          if (st.rateState.orig != null) {
            safeSetRate(video, st, st.rateState.orig);
          }
          return;
        }

        const delay = Math.min(RATE_BACKOFF_BASE * (1 << (st.rateState._rateRetryCount - 1)), RATE_BACKOFF_MAX);
        setTimer(() => {
          if (!video.isConnected || st.rateState.permanentlyBlocked || videoSig.aborted) return;
          if (isVideoEncrypted(video)) { st.rateState.permanentlyBlocked = true; return; }
          st.rateState._totalRetries++;
          if (st.rateState._totalRetries > RATE_SESSION_MAX) {
            st.rateState.permanentlyBlocked = true;
            showOSD('속도 제어: 이 사이트에서 차단됨', 2000);
            return;
          }
          safeSetRate(video, st, expected);
        }, delay);
      }, { signal: videoSig });

      const cancelRvfc = bindVideoFrameSync(video, () => { ApplyReq.soft(); });

      if (ZoomMgr) ZoomMgr.onNewVideoForZoom(video); patchFullscreenRequest(video);
      videoSig.addEventListener('abort', () => { cancelRvfc?.(); st.bound = false; st.resetTransient(); vscClearAllStyles(video); log.debug('[bindVideo] unbound', video.src?.slice(0, 40) || '(blob)'); }, { once: true });
    }

    /* ══════════════════════════════════════════════════════════════════
       createKeyboard
       ══════════════════════════════════════════════════════════════════ */
    function createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr, FiltersVO) {
      const _KB_ALT = {
        v: () => UI?.togglePanel(),
        p: () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) togglePiPFor(v); },
        m: () => Maximizer?.toggle(),
        a: () => {
          const nv = !Store.get(P.APP_AUTO_SCENE); Store.set(P.APP_AUTO_SCENE, nv);
          nv ? AutoScene.start() : AutoScene.stop();
          ApplyReq.hard(); persistNow(); showOSD(`자동 보정: ${nv ? '켜짐' : '꺼짐'}`, 1000);
        },
        g: () => {
          const nv = !Store.get(P.APP_GPU_EN); Store.set(P.APP_GPU_EN, nv);
          window[VSC_INTERNAL_SYM]._gpuSceneEnabled = nv;
          showOSD(`GPU 장면분석 ${nv ? 'ON' : 'OFF → CPU fallback'}`, 1200);
          try { nv ? window[VSC_INTERNAL_SYM]._gpuSceneInit?.() : window[VSC_INTERNAL_SYM]._gpuSceneDestroy?.(); } catch(_) {}
          ApplyReq.soft(); UI?.syncAll(); persistNow();
        },
        s: () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) captureVideoFrame(v); },
        b: () => {
          const v = window[VSC_INTERNAL_SYM]._activeVideo; if (!v) return;
          const st = getVState(v); st.__abCompare = !st.__abCompare;
          st.__abCompare ? (FiltersVO.clear(v), showOSD('원본 비교 중… (Alt+B 해제)', 1500)) : (ApplyReq.hard(), showOSD('필터 적용됨', 800));
        },
        '0': () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v && ZoomMgr) ZoomMgr.resetZoom(v); },
        z: () => {
          if (!ZoomMgr) return;
          const nv = !Store.get(P.APP_ZOOM_EN); Store.set(P.APP_ZOOM_EN, nv);
          if (!nv) { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) ZoomMgr.resetZoom(v); }
          showOSD(`줌 ${nv ? 'ON' : 'OFF'}`, 900); ApplyReq.soft(); persistNow(); UI?.syncAll();
        },
        r: () => { resetDefaults(); ApplyReq.hard(); persistNow(); UI?.syncAll(); showOSD('초기화 완료', 1000); },
        f: () => { cycleVideoFit(Store); UI?.syncAll(); },
        t: () => { rotateVideo90(Store); UI?.syncAll(); },
        l: () => {
          const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0;
          const next = (cur + 1) % SCR_BRT_LEVELS.length;
          Store.set(P.APP_SCREEN_BRT, next);
          showOSD('화면 조도: ' + SCR_BRT_LABELS[next], 1000);
          persistNow();
        }
      };

      onDoc('keydown', e => {
        if (isEditableTarget(e.target)) return;
        const k = e.key, alt = e.altKey, shift = e.shiftKey;

        if (k === 'Escape') { UI?.togglePanel(false); Maximizer?.isActive() && Maximizer.undoMaximize(); return; }

        if (alt) {
          const lk = k.toLowerCase();
          if (k >= '1' && k <= '3') { const idx = parseInt(k) - 1; shift ? saveSlot(idx) : loadSlot(idx); UI?.syncAll(); e.preventDefault(); return; }
          const handler = _KB_ALT[lk] || _KB_ALT[k];
          if (handler) { handler(); e.preventDefault(); return; }
        }

        if (k === '[' || k === ']') {
          const cur = Number(Store.get(P.PB_RATE)) || 1;
          const nv = VSC_CLAMP(cur + (k === ']' ? 0.1 : -0.1), 0.07, 16);
          Store.set(P.PB_RATE, nv);
          if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true);
          ApplyReq.hard(); persistNow(); UI?.syncAll(); showOSD(`속도: ${nv.toFixed(2)}×`, 900);
          e.preventDefault();
        }
      }, { signal: __globalSig, capture: true });
    }

    /* ══════════════════════════════════════════════════════════════════
       createTouchGestureManager
       ══════════════════════════════════════════════════════════════════ */
    function injectTouchGestureCSS() {
      if (document.getElementById('vsc-touch-gesture-css')) return;
      const style = document.createElement('style');
      style.id = 'vsc-touch-gesture-css';
      style.textContent = `
        .vsc-swipe-indicator { position: fixed; top: 50%; transform: translateY(-50%); z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 0.15s ease; display: flex; flex-direction: column; align-items: center; gap: 6px; font-family: system-ui, -apple-system, sans-serif; color: rgba(255,255,255,0.95); text-shadow: 0 2px 8px rgba(0,0,0,0.7); }
        .vsc-swipe-indicator.left  { left: 12%; }
        .vsc-swipe-indicator.right { right: 12%; }
        .vsc-swipe-indicator.show  { opacity: 1; }
        .vsc-swipe-icon { width: 40px; height: 40px; background: rgba(0,0,0,0.45); border-radius: 50%; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.15); }
        .vsc-swipe-icon svg { width: 22px; height: 22px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .vsc-swipe-track { width: 4px; height: 80px; background: rgba(255,255,255,0.15); border-radius: 2px; overflow: hidden; position: relative; }
        .vsc-swipe-fill { position: absolute; bottom: 0; left: 0; width: 100%; background: rgba(110,168,254,0.85); border-radius: 2px; transition: height 0.08s linear; box-shadow: 0 0 6px rgba(110,168,254,0.5); }
        .vsc-swipe-label { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }

        .vsc-seek-ripple { position: fixed; top: 50%; transform: translateY(-50%); z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 0.15s ease-out; display: flex; flex-direction: row; align-items: center; gap: 6px; font-family: system-ui, -apple-system, sans-serif; color: rgba(255,255,255,0.95); text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.5); white-space: nowrap; }
        .vsc-seek-ripple.left  { left: 15%; }
        .vsc-seek-ripple.right { right: 15%; }
        .vsc-seek-ripple.show  { opacity: 1; }
        .vsc-seek-arrows { display: flex; align-items: center; font-size: 22px; font-weight: 400; line-height: 1; }
        .vsc-seek-arrows span { display: block; line-height: 1; }
        .vsc-seek-text { font-size: 15px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
        .vsc-seek-pop { animation: vsc-seek-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes vsc-seek-pop { 0%  { transform: scale(1); } 40% { transform: scale(1.35); } 100%{ transform: scale(1); } }
        .vsc-arrow-slide-r { animation: vsc-arrow-r 0.6s infinite; }
        @keyframes vsc-arrow-r { 0%  { transform: translateX(-4px); opacity: 0; } 40% { opacity: 1; } 100%{ transform: translateX(4px); opacity: 0; } }
        .vsc-arrow-slide-l { animation: vsc-arrow-l 0.6s infinite; }
        @keyframes vsc-arrow-l { 0%  { transform: translateX(4px); opacity: 0; } 40% { opacity: 1; } 100%{ transform: translateX(-4px); opacity: 0; } }

        .vsc-longpress-badge { position: fixed; top: 8%; left: 50%; transform: translateX(-50%); z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 0.15s ease; background: rgba(0,0,0,0.55); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 6px 16px; font: 700 13px/1.4 system-ui, -apple-system, sans-serif; color: rgba(255,255,255,0.95); display: flex; align-items: center; gap: 6px; text-shadow: 0 1px 3px rgba(0,0,0,0.5); }
        .vsc-longpress-badge.show { opacity: 1; }
        .vsc-longpress-badge .vsc-lp-icon { width: 16px; height: 16px; animation: vsc-lp-pulse 0.8s infinite alternate; }
        @keyframes vsc-lp-pulse { 0%  { opacity: 0.5; transform: scale(0.9); } 100%{ opacity: 1.0; transform: scale(1.1); } }

        .vsc-seek-overlay { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.15s ease; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(15px); color: white; padding: 16px 28px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.15); font-family: system-ui, sans-serif; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: none; }
        .vsc-seek-overlay.show { display: block; opacity: 1; }
        .vsc-seek-direction { font-size: 13px; font-weight: 600; opacity: 0.8; margin-bottom: 4px; }
        .vsc-seek-main { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }
        .vsc-seek-delta { font-size: 15px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }

        .ytp-spinner, .vjs-loading-spinner, .loading-indicator, .mvp-spinner, video::-webkit-media-controls-loading-indicator { display: none !important; visibility: hidden !important; opacity: 0 !important; }
        @media (prefers-reduced-motion: reduce) { .vsc-seek-pop, .vsc-arrow-slide-r, .vsc-arrow-slide-l, .vsc-longpress-badge .vsc-lp-icon { animation: none !important; } }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function createTouchGestureManager(Store, P, ApplyReq) {
      function safePlay(video) {
        if (!video || video.readyState < 2) return;
        try {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }

      function isInFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
      }

      function isNativePlayerControl(e) {
        let path;
        try { path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target]; }
        catch (_) { path = [e.target]; }

        for (let i = 0, len = Math.min(path.length, 15); i < len; i++) {
          const node = path[i];
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName === 'VIDEO') return false;

          const tag = node.tagName;
          if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' ||
              tag === 'SELECT' || tag === 'TEXTAREA') return true;

          const role = node.getAttribute?.('role');
          if (role === 'button' || role === 'slider' || role === 'menuitem' ||
              role === 'tab' || role === 'link') return true;

          const cls = node.className?.toString?.() || '';
          if (cls.includes('ytp-') &&
              !cls.includes('ytp-cued-thumbnail-overlay') &&
              !cls.includes('ytp-iv-player-content')) return true;
          if (cls.includes('jw-icon') || cls.includes('jw-slider') ||
              cls.includes('jw-button') || cls.includes('jw-controlbar')) return true;
          if (cls.includes('vjs-control') || cls.includes('vjs-button') ||
              cls.includes('vjs-slider')) return true;
          if (cls.includes('plyr__control') || cls.includes('plyr__menu')) return true;
          if (cls.includes('seek-bar') || cls.includes('progress-bar') ||
              cls.includes('time-slider') || cls.includes('volume-slider')) return true;

          const testid = node.getAttribute?.('data-testid') || '';
          if (testid && (testid.includes('seek') || testid.includes('progress') ||
              testid.includes('volume'))) return true;

          const aria = node.getAttribute?.('aria-label')?.toLowerCase?.() || '';
          if (aria && (aria.includes('seek') || aria.includes('forward') ||
              aria.includes('rewind') || aria.includes('skip') ||
              aria.includes('앞으로') || aria.includes('뒤로'))) return true;
        }
        return false;
      }

      const SWIPE_THRESHOLD = 12;
      const LONG_PRESS_MS = 450;
      const DOUBLE_TAP_MS = 300;
      const SEEK_STEP = 5;
      const SEEK_SESSION_MS = 800;
      const LONG_PRESS_RATE = 2.0;
      const SENSITIVITY_VOL = 1.2;
      const SENSITIVITY_BRI = 1.2;
      const SEEK_SENSITIVITY = 0.05;

      const GS = Object.freeze({ IDLE: 0, WAIT: 1, SWIPE_VOL: 2, SWIPE_BRI: 3, LONG_PRESS: 4, BLOCKED: 5, SWIPE_SEEK: 6 });
      let gesture = GS.IDLE;
      let startX = 0, startY = 0, seekInitialTime = 0;
      let initVol = 1, initBri = 1, savedRate = 1;
      let touchVideo = null, lpTimerId = 0, destroyed = false;
      let lastTapTime = 0, lastTapX = 0, seekSide = null, seekAccum = 0, seekTimerId = 0;
      let elSwipeLeft = null, elSwipeRight = null, elSeekLeft = null, elSeekRight = null, elLpBadge = null, elSeekOverlay = null;
      let __touchBriOverlay = null;

      function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        const p = v => String(v).padStart(2, '0');
        return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
      }

      function formatDelta(sec) {
        const sign = sec < 0 ? '−' : '+';
        const abs = Math.floor(Math.abs(sec));
        const h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60), s = abs % 60;
        const p = v => String(v).padStart(2, '0');
        return h > 0 ? `${sign}${p(h)}:${p(m)}:${p(s)}` : `${sign}${p(m)}:${p(s)}`;
      }

      function shouldHandle() { if (destroyed) return false; if (!CONFIG.IS_MOBILE) return false; if (Store.get(P.APP_ZOOM_EN)) return false; if (!Store.get(P.APP_ACT)) return false; return true; }
      function isVscUi(e) { try { const path = typeof e.composedPath === 'function' ? e.composedPath() : []; for (let i = 0, len = Math.min(path.length, 8); i < len; i++) { const n = path[i]; if (n?.hasAttribute?.('data-vsc-ui') || n?.id === 'vsc-host' || n?.id === 'vsc-gear-host') return true; } } catch (_) {} return false; }

      function findVideoInRect(tx, ty) {
        const active = window[VSC_INTERNAL_SYM]?._activeVideo;
        if (active?.isConnected) {
          try {
            const r = active.getBoundingClientRect();
            if (r.width >= 40 && r.height >= 40 &&
                tx >= r.left && tx <= r.right && ty >= r.top && ty <= r.bottom) return active;
          } catch (_) {}
        }

        let bestVideo = null, bestArea = 0;
        for (const v of TOUCHED.videos) {
          if (!v?.isConnected) continue;
          try {
            const r = v.getBoundingClientRect();
            if (r.width < 40 || r.height < 40) continue;
            if (tx >= r.left && tx <= r.right && ty >= r.top && ty <= r.bottom) {
              const area = r.width * r.height;
              if (area > bestArea) { bestArea = area; bestVideo = v; }
            }
          } catch (_) {}
        }
        if (bestVideo) return bestVideo;

        try {
          const els = document.elementsFromPoint(tx, ty);
          for (const el of els) { if (el?.tagName === 'VIDEO' && el.isConnected) return el; }
        } catch (_) {}

        return null;
      }

      function getOverlayParent() { return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement; }

      function ensureSeekOverlay() {
        const parent = getOverlayParent();
        if (elSeekOverlay?.isConnected && elSeekOverlay.parentNode === parent) return elSeekOverlay;
        elSeekOverlay?.remove();
        elSeekOverlay = document.createElement('div');
        elSeekOverlay.className = 'vsc-seek-overlay';
        elSeekOverlay.setAttribute('data-vsc-ui', '1');
        parent.appendChild(elSeekOverlay);
        return elSeekOverlay;
      }

      function updateSeekUI(currentTime, delta) {
        const ov = ensureSeekOverlay();
        const directionText = delta >= 0 ? "오른쪽 스와이프 중" : "왼쪽 스와이프 중";
        const deltaText = formatDelta(delta);
        const deltaColor = delta >= 0 ? "#8effa9" : "#ff8e8e";
        ov.innerHTML = `
          <div class="vsc-seek-direction">${directionText}</div>
          <div class="vsc-seek-main">(${formatTime(currentTime)})</div>
          <div class="vsc-seek-delta" style="color: ${deltaColor}">(${deltaText})</div>
        `;
        ov.style.display = '';
        ov.classList.add('show');
      }

      function hideSeekOverlaySmooth() {
        if (!elSeekOverlay) return;
        elSeekOverlay.classList.remove('show');
        setTimer(() => { if (elSeekOverlay && !elSeekOverlay.classList.contains('show')) elSeekOverlay.style.display = 'none'; }, 200);
      }

      function ensureSwipeIndicators() {
        const parent = getOverlayParent();
        if (!elSwipeLeft || !elSwipeLeft.isConnected || elSwipeLeft.parentNode !== parent) {
          elSwipeLeft?.remove(); elSwipeLeft = document.createElement('div'); elSwipeLeft.className = 'vsc-swipe-indicator left'; elSwipeLeft.setAttribute('data-vsc-ui', '1');
          elSwipeLeft.innerHTML = `<div class="vsc-swipe-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></div><div class="vsc-swipe-track"><div class="vsc-swipe-fill" style="height:50%"></div></div><div class="vsc-swipe-label">100%</div>`;
          parent.appendChild(elSwipeLeft);
        }
        if (!elSwipeRight || !elSwipeRight.isConnected || elSwipeRight.parentNode !== parent) {
          elSwipeRight?.remove(); elSwipeRight = document.createElement('div'); elSwipeRight.className = 'vsc-swipe-indicator right'; elSwipeRight.setAttribute('data-vsc-ui', '1');
          elSwipeRight.innerHTML = `<div class="vsc-swipe-icon"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></div><div class="vsc-swipe-track"><div class="vsc-swipe-fill" style="height:50%"></div></div><div class="vsc-swipe-label">100%</div>`;
          parent.appendChild(elSwipeRight);
        }
      }

      function ensureSeekRipples() {
        const parent = getOverlayParent();
        if (!elSeekLeft || !elSeekLeft.isConnected || elSeekLeft.parentNode !== parent) { elSeekLeft?.remove(); elSeekLeft = document.createElement('div'); elSeekLeft.className = 'vsc-seek-ripple left'; elSeekLeft.setAttribute('data-vsc-ui', '1'); parent.appendChild(elSeekLeft); }
        if (!elSeekRight || !elSeekRight.isConnected || elSeekRight.parentNode !== parent) { elSeekRight?.remove(); elSeekRight = document.createElement('div'); elSeekRight.className = 'vsc-seek-ripple right'; elSeekRight.setAttribute('data-vsc-ui', '1'); parent.appendChild(elSeekRight); }
      }

      function ensureLpBadge() {
        const parent = getOverlayParent();
        if (!elLpBadge || !elLpBadge.isConnected || elLpBadge.parentNode !== parent) {
          elLpBadge?.remove(); elLpBadge = document.createElement('div'); elLpBadge.className = 'vsc-longpress-badge'; elLpBadge.setAttribute('data-vsc-ui', '1');
          elLpBadge.innerHTML = `<svg class="vsc-lp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span class="vsc-lp-text">${LONG_PRESS_RATE}× 재생 중</span>`;
          parent.appendChild(elLpBadge);
        }
      }

      function updateSwipeUI(type, value) {
        ensureSwipeIndicators(); const el = type === 'bri' ? elSwipeLeft : elSwipeRight; const other = type === 'bri' ? elSwipeRight : elSwipeLeft;
        other.classList.remove('show'); el.classList.add('show');
        const pct = Math.round(value * 100); const fill = el.querySelector('.vsc-swipe-fill'); const label = el.querySelector('.vsc-swipe-label');
        if (fill) fill.style.height = `${VSC_CLAMP(pct, 0, 100)}%`; if (label) label.textContent = `${pct}%`;
      }
      function hideSwipeUI() { elSwipeLeft?.classList.remove('show'); elSwipeRight?.classList.remove('show'); }

      function showSeekRipple(side, totalSec) {
        ensureSeekRipples(); const el = side === 'left' ? elSeekLeft : elSeekRight; const other = side === 'left' ? elSeekRight : elSeekLeft;
        other.classList.remove('show');
        if (side === 'left') { el.innerHTML = `<div class="vsc-seek-arrows"><span>‹</span><span class="vsc-arrow-slide-l">‹</span></div><span class="vsc-seek-text vsc-seek-pop">−${totalSec}s</span>`; }
        else { el.innerHTML = `<span class="vsc-seek-text vsc-seek-pop">+${totalSec}s</span><div class="vsc-seek-arrows"><span class="vsc-arrow-slide-r">›</span><span>›</span></div>`; }
        el.classList.add('show');
      }
      function hideSeekRipple(side) { const el = side === 'left' ? elSeekLeft : elSeekRight; el?.classList.remove('show'); }
      function hideAllSeekRipples() { elSeekLeft?.classList.remove('show'); elSeekRight?.classList.remove('show'); }

      function doSeek(video, side) {
        if (!video || !Number.isFinite(video.duration)) return;
        seekSide = side; seekAccum += SEEK_STEP;
        if (side === 'left') { video.currentTime = Math.max(0, video.currentTime - SEEK_STEP); } else { video.currentTime = Math.min(video.duration, video.currentTime + SEEK_STEP); }
        if (video.paused && video.readyState >= 2) { safePlay(video); }
        showSeekRipple(side, seekAccum);
        clearTimer(seekTimerId);
        seekTimerId = setTimer(() => { hideSeekRipple(side); seekSide = null; seekAccum = 0; seekTimerId = 0; }, SEEK_SESSION_MS);
      }

      function startLongPress(video) {
        if (!video || gesture === GS.LONG_PRESS) return;
        gesture = GS.LONG_PRESS; savedRate = video.playbackRate; video.playbackRate = LONG_PRESS_RATE;
        ensureLpBadge(); const textEl = elLpBadge?.querySelector('.vsc-lp-text'); if (textEl) textEl.textContent = `${LONG_PRESS_RATE}× 재생 중`;
        elLpBadge?.classList.add('show');
      }
      function endLongPress(video) { if (gesture !== GS.LONG_PRESS) return; if (video?.isConnected) { video.playbackRate = savedRate; } elLpBadge?.classList.remove('show'); }

      function ensureBriOverlay(video) {
        const parent = video.parentElement || getOverlayParent();
        if (__touchBriOverlay?.isConnected && __touchBriOverlay.parentNode === parent) return __touchBriOverlay;
        __touchBriOverlay?.remove(); __touchBriOverlay = document.createElement('div'); __touchBriOverlay.setAttribute('data-vsc-ui', '1');
        __touchBriOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:black;opacity:0;pointer-events:none;z-index:1;transition:opacity 0.08s linear;';
        parent.appendChild(__touchBriOverlay);
        const pos = getComputedStyle(parent).position; if (pos === 'static') parent.style.position = 'relative';
        return __touchBriOverlay;
      }
      function applyTouchBrightness(video, brightness01) { const clamped = VSC_CLAMP(brightness01, 0.05, 1.0); const overlay = ensureBriOverlay(video); overlay.style.opacity = String(1 - clamped); }
      function removeTouchBrightness() { if (__touchBriOverlay?.isConnected) { __touchBriOverlay.style.opacity = '0'; const ov = __touchBriOverlay; setTimer(() => { ov?.remove(); }, 300); __touchBriOverlay = null; } }

      function onTouchStart(e) {
        if (!shouldHandle()) return;
        if (e.touches.length !== 1) { cancelGesture(); return; }
        if (isVscUi(e) || isEditableTarget(e.target)) return;
        if (isInsideCloudflareWidget(e.target)) return;

        const tx = e.touches[0].clientX, ty = e.touches[0].clientY;
        const video = findVideoInRect(tx, ty);
        if (!video) return;

        if (isNativePlayerControl(e)) return;

        if (e.cancelable) e.preventDefault();

        touchVideo = video;
        startX = tx; startY = ty;
        initVol = video.volume;
        initBri = 1.0;
        seekInitialTime = video.currentTime;
        gesture = GS.WAIT;

        clearTimer(lpTimerId);
        lpTimerId = setTimer(() => {
          lpTimerId = 0;
          if (gesture === GS.WAIT && touchVideo) startLongPress(touchVideo);
        }, LONG_PRESS_MS);
      }

      function onTouchMove(e) {
        if (gesture === GS.IDLE || gesture === GS.BLOCKED || !touchVideo) return;
        const tx = e.touches[0]?.clientX ?? startX, ty = e.touches[0]?.clientY ?? startY, dx = tx - startX, dy = startY - ty;

        if (gesture === GS.LONG_PRESS) {
          if (Math.abs(dx) > SWIPE_THRESHOLD || Math.abs(dy) > SWIPE_THRESHOLD) {
            endLongPress(touchVideo);
            gesture = GS.BLOCKED;
          }
          if (e.cancelable) e.preventDefault(); return;
        }

        if (gesture === GS.WAIT) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < SWIPE_THRESHOLD) return;
          clearTimer(lpTimerId);

          if (Math.abs(dx) > Math.abs(dy)) {
            gesture = GS.SWIPE_SEEK;
            seekInitialTime = touchVideo.currentTime;
            if (e.cancelable) e.preventDefault();
            return;
          } else {
            if (!isInFullscreen()) {
              gesture = GS.BLOCKED;
              touchVideo = null;
              return;
            }
            const vRect = touchVideo.getBoundingClientRect(), midX = vRect.left + vRect.width / 2;
            if (startX < midX) gesture = GS.SWIPE_BRI; else gesture = GS.SWIPE_VOL;
          }
        }

        if (e.cancelable) e.preventDefault();

        if (gesture === GS.SWIPE_SEEK) {
          const duration = touchVideo.duration;
          if (!Number.isFinite(duration) || duration <= 0) return;
          const vRect = touchVideo.getBoundingClientRect();
          const normalizedDx = (tx - startX) / Math.max(1, vRect.width);
          const timeChange = normalizedDx * duration * SEEK_SENSITIVITY;
          const newTime = VSC_CLAMP(seekInitialTime + timeChange, 0, duration);
          touchVideo.currentTime = newTime;
          updateSeekUI(newTime, newTime - seekInitialTime);
          return;
        }

        const vRect = touchVideo.getBoundingClientRect(), normalizedDy = dy / Math.max(1, vRect.height);
        if (gesture === GS.SWIPE_VOL) { const newVol = VSC_CLAMP(initVol + normalizedDy * SENSITIVITY_VOL, 0, 1); touchVideo.volume = newVol; try { touchVideo.muted = false; } catch (_) {} updateSwipeUI('vol', newVol); }
        if (gesture === GS.SWIPE_BRI) { const newBri = VSC_CLAMP(initBri + normalizedDy * SENSITIVITY_BRI, 0.05, 1.0); applyTouchBrightness(touchVideo, newBri); updateSwipeUI('bri', newBri); }
      }

      function onTouchEnd(e) {
        if (gesture === GS.IDLE || !touchVideo) { cancelGesture(); return; }
        const video = touchVideo;

        if (gesture === GS.LONG_PRESS) { endLongPress(video); cancelGesture(); return; }
        if (gesture === GS.SWIPE_VOL || gesture === GS.SWIPE_BRI) {
          if (gesture === GS.SWIPE_BRI) removeTouchBrightness();
          hideSwipeUI(); cancelGesture(); return;
        }

        if (gesture === GS.SWIPE_SEEK) {
          hideSeekOverlaySmooth();
          const delta = video.currentTime - seekInitialTime;
          if (Math.abs(delta) > 0.5 && typeof showOSD === 'function') {
            showOSD(`${formatDelta(delta)}  →  ${formatTime(video.currentTime)}`, 1200);
          }
          cancelGesture(); return;
        }

        if (gesture === GS.WAIT) {
          clearTimer(lpTimerId);
          if (isNativePlayerControl(e)) {
            lastTapTime = 0;
            cancelGesture();
            return;
          }
          const now = performance.now(), tapX = e.changedTouches?.[0]?.clientX ?? startX, vRect = video.getBoundingClientRect(), relX = (tapX - vRect.left) / Math.max(1, vRect.width);
          if (now - lastTapTime < DOUBLE_TAP_MS) {
            if (seekSide && relX < 0.35 && seekSide === 'left') { doSeek(video, 'left'); }
            else if (seekSide && relX > 0.65 && seekSide === 'right') { doSeek(video, 'right'); }
            else if (relX < 0.35) { doSeek(video, 'left'); } else if (relX > 0.65) { doSeek(video, 'right'); }
            else {
            if (video.paused && video.readyState >= 2) {
              safePlay(video);
            } else if (!video.paused) {
              video.pause();
              }
            }
            lastTapTime = 0;
          } else {
            lastTapTime = now; lastTapX = tapX;
            if (seekSide) { if (seekSide === 'left' && relX < 0.35) { doSeek(video, 'left'); lastTapTime = 0; } else if (seekSide === 'right' && relX > 0.65) { doSeek(video, 'right'); lastTapTime = 0; } }
          }
          cancelGesture(); return;
        }
        cancelGesture();
      }

      function onTouchCancel() { if (gesture === GS.LONG_PRESS && touchVideo) { endLongPress(touchVideo); } hideSwipeUI(); hideSeekOverlaySmooth(); removeTouchBrightness(); cancelGesture(); }
      function cancelGesture() { clearTimer(lpTimerId); lpTimerId = 0; gesture = GS.IDLE; touchVideo = null; }

      function init() {
        if (!CONFIG.IS_MOBILE) return;
        injectTouchGestureCSS();
        window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
        window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
        document.addEventListener('fullscreenchange', () => { if (elLpBadge?.classList.contains('show')) ensureLpBadge(); });
        log.info('[TouchGesture] Mobile touch gesture module initialized (with seek/rect-check)');
      }

      function destroy() {
        destroyed = true; cancelGesture(); hideSwipeUI(); hideAllSeekRipples(); hideSeekOverlaySmooth(); elLpBadge?.classList.remove('show'); removeTouchBrightness();
        elSwipeLeft?.remove(); elSwipeRight?.remove(); elSeekLeft?.remove(); elSeekRight?.remove(); elLpBadge?.remove(); elSeekOverlay?.remove();
        const css = document.getElementById('vsc-touch-gesture-css'); css?.remove();
        window.removeEventListener('touchstart', onTouchStart, { capture: true });
        window.removeEventListener('touchmove', onTouchMove, { capture: true });
        window.removeEventListener('touchend', onTouchEnd, { capture: true });
        window.removeEventListener('touchcancel', onTouchCancel, { capture: true });
      }

      return Object.freeze({ init, destroy });
    }

    /* ══════════════════════════════════════════════════════════════════
       BOOTSTRAP
       ══════════════════════════════════════════════════════════════════ */
    function bootstrap() {
      const VSC_VERSION_ID = '211.7.0';
      log.info(`[VSC] v${VSC_VERSION_ID} booting on ${location.hostname}`);

      window[VSC_INTERNAL_SYM]._gpuSceneActive = false;
      window[VSC_INTERNAL_SYM]._gpuSceneEnabled = false;
      window[VSC_INTERNAL_SYM]._gpuSceneInit = null;
      window[VSC_INTERNAL_SYM]._gpuSceneDestroy = null;

      const MS = createModuleSystem(__globalSig);
      MS.defineFeature('Utils', { init: () => createUtils() });
      MS.defineFeature('Scheduler', { init: () => createScheduler() });
      MS.defineFeature('Bus', { init: () => createEventBus() });
      MS.defineFeature('Store', { deps: ['Utils', 'Scheduler', 'Bus'], init: ({ Utils, Scheduler, Bus }) => { const store = createLocalStore(DEFAULTS, Scheduler, Utils, () => Bus.signal()); loadPersisted(store); return store; } });
      MS.defineFeature('ApplyReq', { deps: ['Bus', 'Scheduler'], init: ({ Bus, Scheduler }) => createApplyRequester(Bus, Scheduler) });
      MS.defineFeature('Registry', { deps: ['Scheduler'], priority: 10, init: ({ Scheduler }) => createRegistry(Scheduler), update: (inst) => { inst.prune(); } });
      MS.defineFeature('Targeting', { init: () => createTargeting() });
      MS.defineFeature('Audio', { deps: ['Store'], init: ({ Store }) => createAudio(Store), destroy: (inst) => { inst.destroy(); } });
      MS.defineFeature('AutoScene', { deps: ['Store', 'Scheduler'], init: ({ Store, Scheduler }) => createAutoSceneManager(Store, P, Scheduler), destroy: (inst) => { inst.stop(); } });
      MS.defineFeature('ParamsMemo', { deps: ['Store', 'Utils'], init: ({ Store, Utils }) => {
        const memo = createVideoParamsMemo(Store, P, Utils);
        memo.init();
        return memo;
      }});
      MS.defineFeature('FiltersVO', { deps: ['Utils'], init: ({ Utils }) => createFiltersVideoOnly(Utils, CONFIG) });
      MS.defineFeature('Maximizer', { deps: ['Store', 'ApplyReq'], init: ({ Store, ApplyReq }) => createVideoMaximizer(Store, ApplyReq) });
      MS.defineFeature('ZoomMgr', { init: () => FEATURE_FLAGS.zoomFeature ? createZoomManager() : null, destroy: (inst) => { if (inst) inst.destroy(); } });
      MS.defineFeature('TouchGesture', {
        deps: ['Store', 'ApplyReq'],
        init: ({ Store, ApplyReq }) => {
          const tg = createTouchGestureManager(Store, P, ApplyReq);
          tg.init();
          return tg;
        },
        destroy: (inst) => { inst.destroy(); }
      });

      const moduleNames = ['Utils', 'Scheduler', 'Bus', 'Store', 'ApplyReq', 'Registry', 'Targeting', 'Audio', 'AutoScene', 'ParamsMemo', 'FiltersVO', 'Maximizer', 'ZoomMgr', 'TouchGesture'];
      MS.resolveAll(moduleNames);

      const Store = MS.get('Store'), Scheduler = MS.get('Scheduler'), Bus = MS.get('Bus'), ApplyReq = MS.get('ApplyReq'), Registry = MS.get('Registry'), Targeting = MS.get('Targeting'), Audio = MS.get('Audio'), AutoScene = MS.get('AutoScene'), ParamsMemo = MS.get('ParamsMemo'), FiltersVO = MS.get('FiltersVO'), Maximizer = MS.get('Maximizer'), ZoomMgr = MS.get('ZoomMgr'), TouchGesture = MS.get('TouchGesture');

      window[VSC_INTERNAL_SYM].Store = Store;
      window[VSC_INTERNAL_SYM].ApplyReq = ApplyReq;
      window[VSC_INTERNAL_SYM].AutoScene = AutoScene;
      window[VSC_INTERNAL_SYM].ZoomManager = ZoomMgr;
      window[VSC_INTERNAL_SYM].Audio = Audio;
      window[VSC_INTERNAL_SYM].TouchGesture = TouchGesture;
      __Store = Store;
      __ApplyReq = ApplyReq;

      window[VSC_INTERNAL_SYM].getActiveVideo = () => window[VSC_INTERNAL_SYM]._activeVideo;

      window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !!Store.get(P.APP_GPU_EN);

      Bus.on('signal', (p) => Scheduler.request(!!p?.forceApply));
      for (const cat of ['video.*', 'audio.*', 'playback.*', 'app.*']) Store.sub(cat, () => persistNow());

      Store.sub(P.APP_VID_ROT, () => { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) applyVideoTransform(v, Store); });
      Store.sub(P.APP_VID_FIT, () => { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) applyVideoTransform(v, Store); });

      createApplyLoop(Store, Scheduler, Registry, Targeting, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq);

      Store.sub(P.PB_RATE, () => { for (const v of TOUCHED.rateVideos) { const rs = getRateState(v); if (!isVideoEncrypted(v)) { rs.permanentlyBlocked = false; rs._rateRetryCount = 0; rs._totalRetries = 0; } } });
      Store.sub(P.PB_EN, (enabled) => { if (!enabled) { for (const v of TOUCHED.rateVideos) { const rs = getRateState(v); if (rs.orig != null && v.isConnected) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { v.playbackRate = rs.orig; } catch (_) {} } rs.orig = null; rs.permanentlyBlocked = false; rs._rateRetryCount = 0; rs._totalRetries = 0; } } });

      const processVideo = (v) => bindVideoOnce(v, Store, Registry, AutoScene, ApplyReq, ZoomMgr);

      const scanAll = () => {
        let count = 0;
        document.querySelectorAll('video').forEach(v => {
          if (Registry.videos.has(v)) return;
          processVideo(v);
          count++;
        });

        document.querySelectorAll('iframe').forEach(ifr => {
          try {
            const doc = ifr.contentDocument || ifr.contentWindow?.document;
            if (doc) {
              doc.querySelectorAll('video').forEach(v => {
                if (Registry.videos.has(v)) return;
                processVideo(v);
                count++;
              });
            }
          } catch (e) {}
        });
        return count;
      };

      const setupDynamicIframeMonitoring = () => {
        const processedIframes = new WeakSet();
        const checkIframes = () => {
          document.querySelectorAll('iframe').forEach(ifr => {
            if (processedIframes.has(ifr)) return;
            processedIframes.add(ifr);

            ifr.addEventListener('load', () => {
              setTimer(() => scanAll(), 500);
            }, { signal: __globalSig });

            try {
              const doc = ifr.contentDocument || ifr.contentWindow?.document;
              if (doc && doc.readyState === 'complete') scanAll();
            } catch (e) {}
          });
        };

        const mo = new MutationObserver(checkIframes);
        const root = document.body || document.documentElement;
        if (root) mo.observe(root, { childList: true, subtree: true });
        checkIframes();
      };

      const runAdvancedScanner = () => {
        const isJW = !!(window.jwplayer || document.querySelector('.jwplayer, [data-jwplayer], [class*="jw-"]'));
        scanAll();

        if (isJW) {
          log.info('[VSC] JWPlayer detected — activating aggressive video scanner');
          const jwScanDelays = [500, 1000, 2000, 4000, 8000];
          for (const delay of jwScanDelays) {
            setTimer(() => {
              if (__globalSig.aborted) return;
              const found = scanAll();
              if (found > 0) {
                log.info(`[VSC] JWPlayer: found ${found} new video(s) after ${delay}ms`);
                ApplyReq.hard();
              }
              document.querySelectorAll('video').forEach(v => {
                if (!v.__vsc_jw_watched) {
                  v.__vsc_jw_watched = true;
                  const srcObserver = new MutationObserver(() => {
                    if (__globalSig.aborted) { srcObserver.disconnect(); return; }
                    const st = getVState(v);
                    st.audioFailUntil = 0;
                    if (st.rateState) {
                      st.rateState.permanentlyBlocked = false;
                      st.rateState._rateRetryCount = 0;
                    }
                    ApplyReq.hard();
                  });
                  srcObserver.observe(v, { attributes: true, attributeFilter: ['src', 'currentSrc'] });
                  on(v, 'loadedmetadata', () => {
                    if (__globalSig.aborted) return;
                    const found = scanAll();
                    if (found > 0) ApplyReq.hard();
                  });
                }
              });
            }, delay);
          }
          if (window.jwplayer) {
            try {
              const players = document.querySelectorAll('[id^="jwplayer"], .jwplayer');
              players.forEach(container => {
                try {
                  const playerId = container.id;
                  if (playerId && window.jwplayer(playerId)) {
                    const player = window.jwplayer(playerId);
                    player.on('ready', () => { setTimer(() => { scanAll(); ApplyReq.hard(); }, 300); });
                    player.on('playlistItem', () => {
                      setTimer(() => {
                        scanAll();
                        for (const v of TOUCHED.videos) { const st = getVState(v); st.audioFailUntil = 0; }
                        ApplyReq.hard();
                      }, 500);
                    });
                    log.info('[VSC] JWPlayer API events hooked for:', playerId);
                  }
                } catch (_) {}
              });
            } catch (_) {}
          }
        } else {
          setTimer(() => {
            const found = scanAll();
            if (found === 0) setTimer(() => scanAll(), 2000);
          }, 1500);
        }
      };

      const rescanDebounced = createDebounced(() => {
        scanAll(); Registry.rescanAll(); ApplyReq.hard();
        const wasBlocked = __rateBlockedSite; __rateBlockedSite = isRateBlockedContext();
        if (wasBlocked && !__rateBlockedSite) { for (const v of TOUCHED.rateVideos) { const rs = getRateState(v); if (rs.permanentlyBlocked && !isVideoEncrypted(v)) { rs.permanentlyBlocked = false; rs._rateRetryCount = 0; rs._totalRetries = 0; } } }
      }, SPA_RESCAN_DEBOUNCE_MS);

      initSpaUrlDetector(rescanDebounced);
      setRecurring(() => { for (const v of Registry.videos) { if (v.isConnected && !getVState(v).bound) processVideo(v); } }, 800, { maxErrors: 50 });

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setupDynamicIframeMonitoring();
          runAdvancedScanner();
          Scheduler.request(true);
        }, { once: true, signal: __globalSig });
      } else {
        setupDynamicIframeMonitoring();
        runAdvancedScanner();
        Scheduler.request(true);
      }

      setTimer(() => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) AutoScene.start(); }, 300);

      const UtilsModule = MS.get('Utils');
      const UI = createUI(Store, Bus, UtilsModule, Audio, AutoScene, ZoomMgr, Targeting, Maximizer, FiltersVO, Registry, Scheduler, ApplyReq);

      const waitForBody = () => {
        if (document.body) { UI.init(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); UI.init(); } });
        mo.observe(document.documentElement || document, { childList: true });
      };
      waitForBody();

      createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr, FiltersVO);
      if (FEATURE_FLAGS.iframeInjection) watchIframes();

      window[VSC_APP_SYM] = Object.freeze({
        getActiveVideo: () => window[VSC_INTERNAL_SYM]._activeVideo,
        getGpuStatus: () => window[VSC_INTERNAL_SYM]._gpuSceneActive,
        getDspMode: () => {
           if (!Audio || !Audio.hasCtx() || Audio.isBypassed()) return 'off';
           return Audio.isWorklet() ? 'worklet' : 'legacy';
        },
        version: VSC_VERSION_ID
      });

      if (ZoomMgr) setRecurring(() => ZoomMgr.pruneDisconnected(), 5000, { maxErrors: 50 });
      onDoc('visibilitychange', () => { if (!document.hidden) ApplyReq.soft(); }, { passive: true });
      onDoc('fullscreenchange', () => { if (!document.fullscreenElement && __osdEl) { if (!__osdEl.isConnected) { clearTimer(__osdTimerId); __osdTimerId = 0; __osdEl = null; } } ApplyReq.soft(); UI.syncAll(); });

      __globalSig.addEventListener('abort', () => {
        MS.destroyAll();
        for (const v of TOUCHED.videos) {
          if (fsWraps.has(v)) {
            try { restoreFromFsWrapper(v); } catch (_) {}
          }
          FiltersVO.clear(v);
          vscClearAllStyles(v);
          try { clearVideoTransform(v); } catch (_) {}
        }
        for (const v of TOUCHED.rateVideos) { const rs = getRateState(v); if (rs.orig != null && v.isConnected) { try { v.playbackRate = rs.orig; } catch (_) {} } }
        try {
          const scrBrt = document.getElementById('vsc-scr-brt');
          if (scrBrt) scrBrt.remove();
        } catch (_) {}
        clearTimer(__osdTimerId); __osdTimerId = 0; if (__osdEl?.isConnected) { try { __osdEl.remove(); } catch (_) {} } __osdEl = null; log.info('[VSC] destroyed');
      }, { once: true });

      try {
        GM_registerMenuCommand('VSC 패널 열기/닫기', () => UI.togglePanel());
        GM_registerMenuCommand('VSC 설정 초기화', () => { resetDefaults(); ApplyReq.hard(); persistNow(); UI.syncAll(); showOSD('초기화 완료', 1000); });
      } catch (_) {}

      const gpuAvail = typeof navigator.gpu !== 'undefined' ? 'WebGPU available' : 'WebGPU N/A';
      const workletAvail = typeof AudioWorkletNode !== 'undefined' ? 'AudioWorklet available' : 'AudioWorklet N/A';
      log.info(`[VSC] v${VSC_VERSION_ID} ready — ${Registry.videos.size} video(s) | ${gpuAvail} | ${workletAvail}`);
    }

    /* ════════════════════════════════════════════════
       ENTRY POINT
       ════════════════════════════════════════════════ */
    try { bootstrap(); } catch (e) { console.error('[VSC] bootstrap error', e); }

  } // ← closes function VSC_MAIN()

  VSC_MAIN();
})();
