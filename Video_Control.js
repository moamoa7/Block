// ==UserScript==
// @name         Video_Control (v180.0.0 - Patched with v200 logic)
// @namespace    https://github.com/
// @version      180.0.0-patched
// @description  v179 base + review patch + v200 rate guard, shadow dom, combineSignals, mobile zoom
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

    const setRecurring = (fn, ms) => {
      if (__globalSig.aborted) return 0;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _activeIntervals.delete(id); return; }
        try { fn(); } catch (_) {}
      }, ms);
      _activeIntervals.add(id);
      return id;
    };
    const clearRecurring = (id) => { if (!id) return; clearInterval(id); _activeIntervals.delete(id); };

    /* [이식 1] combineSignals 개선 (v200 로직) */
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
      if (o.signal?.aborted) {
        if (CONFIG.DEBUG) log.debug(`on() skipped: signal already aborted for "${type}"`);
        return;
      }
      target.addEventListener(type, fn, o);
    }
    const onWin = (type, fn, opts) => on(window, type, fn, opts);
    const onDoc = (type, fn, opts) => on(document, type, fn, opts);

    const onAll = (el, events, fn, opts) => {
      for (const ev of events) on(el, ev, fn, opts);
    };

    const __blockedElements = new WeakSet();
    const BLOCK_EVENTS_PASSIVE = Object.freeze(['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu']);
    function blockInterference(el) {
      if (!el || __blockedElements.has(el)) return;
      __blockedElements.add(el);
      const stop = (e) => e.stopPropagation();
      for (const evt of BLOCK_EVENTS_PASSIVE) {
        on(el, evt, stop, { passive: true });
      }
      on(el, 'wheel', (e) => {
        if (e.altKey) return;
        e.stopPropagation();
      }, { passive: true });
    }

    function waitForVisibility() {
      if (document.visibilityState === 'visible') return Promise.resolve();
      return new Promise(resolve => { const onVis = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVis); resolve(); } }; document.addEventListener('visibilitychange', onVis); });
    }

    function detectMobile() { try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {} return /Mobi|Android|iPhone/i.test(navigator.userAgent); }

    const CONFIG = Object.freeze({ IS_MOBILE: detectMobile(), TOUCHED_MAX: 140, VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: false });
    const VSC_VERSION = '180.0.0';

    const STORAGE_KEY = 'vsc_v2_' + location.hostname;

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      const r = 1 + 0.10 * t, g = 1 - 0.04 * Math.abs(t), b = 1 - 0.10 * t;
      const m = Math.max(r, g, b); return { rs: r / m, gs: g / m, bs: b / m };
    }

    const VSC_DEFENSE = Object.freeze({ audioCooldown: true, autoSceneDrmBackoff: true });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true });
    const SHADOW_ROOT_LRU_MAX = 12; const SPA_RESCAN_DEBOUNCE_MS = 220;
    const GUARD = Object.freeze({ AUDIO_SRC_COOLDOWN: 5000, TARGET_HYSTERESIS_MS: 400, TARGET_HYSTERESIS_MARGIN: 0.5 });

    const RATE_BLOCKED_HOSTS = Object.freeze(['netflix.com','disneyplus.com','primevideo.com','amazon.com/gp/video','hulu.com','max.com','peacocktv.com','paramountplus.com','crunchyroll.com']);
    function isRateBlockedHost() { const h = location.hostname; return RATE_BLOCKED_HOSTS.some(d => h === d || h.endsWith('.' + d)); }
    const __rateBlockedSite = isRateBlockedHost();

    const LITE_FORCED_HOSTS = Object.freeze(['ok.ru', 'mail.ru', 'vk.com', 'dzen.ru', 'rutube.ru']);
    const __liteForced = (() => { const h = location.hostname; return LITE_FORCED_HOSTS.some(d => h === d || h.endsWith('.' + d)); })();

    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1; const log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

    function createVideoState() {
      return {
        visible: false, rect: null, bound: false, rateState: null, audioFailUntil: 0, applied: false, desiredRate: undefined, lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false, _resizeDirty: false, _ac: null,
        _inPiP: false,
        resetTransient() {
          this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
          if (this.rateState) {
            this.rateState.orig = null; this.rateState.lastSetAt = 0;
            this.rateState.retryCount = 0; this.rateState.permanentlyBlocked = false;
            this.rateState.suppressSyncUntil = 0;
            this.rateState._externalMtQueued = false;
            this.rateState._rateRetryWindow = 0;
            this.rateState._rateRetryCount = 0;
          }
          this.desiredRate = undefined;
        }
      };
    }
    const videoStateMap = new WeakMap(); function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = createVideoState(); videoStateMap.set(v, st); } return st; }

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

    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({ has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; }, toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); } });

    const PRESETS = Object.freeze({
      detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 14, sharp2Add: 2, clarityAdd: 4 }, M: { sharpAdd: 16, sharp2Add: 10, clarityAdd: 10 }, L: { sharpAdd: 14, sharp2Add: 26, clarityAdd: 12 }, XL: { sharpAdd: 18, sharp2Add: 16, clarityAdd: 24 } },
      grade: { off: { gammaF: 1.00, brightAdd: 0 }, S: { gammaF: 1.02, brightAdd: 1.8 }, M: { gammaF: 1.07, brightAdd: 4.4 }, L: { gammaF: 1.15, brightAdd: 9 }, DS: { gammaF: 1.05, brightAdd: 3.6 }, DM: { gammaF: 1.10, brightAdd: 7.2 }, DL: { gammaF: 1.20, brightAdd: 10.8 } }
    });

    const PRESET_LABELS = Object.freeze({
      detail: { off: 'OFF', S: '소프트', M: '미디엄', L: '라지', XL: '엑스트라' },
      grade: { off: 'OFF', S: '밝게S', M: '밝게M', L: '밝게L', DS: '다크S', DM: '다크M', DL: '다크L' }
    });

    const DEFAULTS = { video: { presetS: 'off', presetB: 'off', presetMix: 1.0, shadowBandMask: 0, brightStepLevel: 0 }, audio: { enabled: false, boost: 6 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false } };
    const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });

    const APP_SCHEMA = [ { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV } ];
    const VIDEO_SCHEMA = [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB }, { type: 'num', path: P.V_PRE_MIX, min: 0, max: 1, fallback: () => DEFAULTS.video.presetMix }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 }, { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 } ];
    const AUDIO_PLAYBACK_SCHEMA = [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => DEFAULTS.audio.boost }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ];

    /* [이식 2] Shadow DOM 최적화 (v200 로직 - 발신부) */
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
            try {
              if (shadow && typeof init === 'object' && init !== null) {
                let mode;
                try { mode = init.mode; } catch (_) { return shadow; }
                if (mode === 'open') {
                  const onShadow = window.__VSC_INTERNAL__?._onShadow;
                  if (onShadow && !__globalSig.aborted) {
                    queueMicrotask(() => onShadow(this, shadow));
                  }
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

    const TOUCHED = { videos: new Set(), rateVideos: new Set() };
    function touchedAddLimited(set, el, onEvict) {
      if (!el) return;
      if (set.has(el)) { set.delete(el); set.add(el); return; }
      set.add(el);
      if (set.size <= CONFIG.TOUCHED_MAX) return;
      const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25);
      let dropped = 0;
      for (const v of set) {
        if (dropped >= dropN) break;
        if (v === el) continue;
        if (v.isConnected && (!v.paused || isPiPActiveVideo(v)) && !v.ended) continue;
        set.delete(v);
        try { onEvict?.(v); } catch (_) {}
        dropped++;
      }
      if (dropped === 0 && set.size > CONFIG.TOUCHED_MAX) {
        for (const v of set) {
          if (v === el) continue;
          set.delete(v);
          try { onEvict?.(v); } catch (_) {}
          break;
        }
      }
    }
let __vscRectEpoch = 0, __vscRectEpochQueued = false; function bumpRectEpoch() { if (__vscRectEpochQueued) return; __vscRectEpochQueued = true; requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; }); }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true }); onWin('resize', bumpRectEpoch, { passive: true }); onWin('orientationchange', bumpRectEpoch, { passive: true });
    try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', bumpRectEpoch, { passive: true }); on(vv, 'scroll', bumpRectEpoch, { passive: true }); } } catch (_) {}

    function getRectCached(v, now, maxAgeMs = 400) { const st = getVState(v); if (!st.rect || (now - (st.rectT || 0)) > maxAgeMs || (st.rectEpoch || 0) !== __vscRectEpoch || st._resizeDirty) { st.rect = v.getBoundingClientRect(); st.rectT = now; st.rectEpoch = __vscRectEpoch; st._resizeDirty = false; } return st.rect; }
    const __vpSnap = { w: 0, h: 0, cx: 0, cy: 0 };
    function getViewportSnapshot() {
      const vv = window.visualViewport;
      if (vv) { __vpSnap.w = vv.width; __vpSnap.h = vv.height; __vpSnap.cx = vv.offsetLeft + vv.width * 0.5; __vpSnap.cy = vv.offsetTop + vv.height * 0.5; }
      else { __vpSnap.w = innerWidth; __vpSnap.h = innerHeight; __vpSnap.cx = innerWidth * 0.5; __vpSnap.cy = innerHeight * 0.5; }
      return __vpSnap;
    }

    function createDebounced(fn, ms = 250) { let t = 0; return (...args) => { clearTimer(t); t = setTimer(() => fn(...args), ms); }; }

    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return;
      window.__VSC_SPA_PATCHED__ = true;
      let lastHref = location.href;
      const origHistory = {};
      const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
      const wrap = (name) => {
        const orig = history[name];
        if (typeof orig !== 'function') return;
        origHistory[name] = orig;
        window.__VSC_INTERNAL__[`_orig_${name}`] = orig;
        const patched = function (...args) {
          const ret = Reflect.apply(orig, this, args);
          if (!__globalSig.aborted) queueMicrotask(emitIfChanged);
          return ret;
        };
        patched.__vsc_patched = true;
        patched.__vsc_original = orig;
        history[name] = patched;
      };
      wrap('pushState'); wrap('replaceState');
      onWin('popstate', emitIfChanged, { passive: true });
      window.__VSC_INTERNAL__._spaOrigHistory = origHistory;
    }

    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    function watchIframes() {
      const canAccess = (ifr) => { try { const w = ifr.contentWindow; if (!w) return false; void w.location.href; return true; } catch (_) { return false; } };
      const inject = (ifr) => {
        if (!ifr || !canAccess(ifr)) return;
        const tryInject = () => { try { const win = ifr.contentWindow; const doc = ifr.contentDocument || win?.document; if (!win || !doc) return; if (win.__VSC_BOOT_LOCK__) return; const host = doc.head || doc.documentElement; if (!host) return; const s = doc.createElement('script'); s.textContent = __VSC_INJECT_SOURCE; host.appendChild(s); s.remove?.(); } catch (_) {} };
        tryInject();
        if (!ifr.__vscLoadHooked) {
          ifr.__vscLoadHooked = true;
          let failCount = 0;
          ifr.addEventListener('load', () => {
            if (failCount >= 3) return;
            if (canAccess(ifr)) { tryInject(); failCount = 0; }
            else { failCount++; }
          }, { passive: true });
        }
      };
      document.querySelectorAll("iframe").forEach(inject);
      const mo = new MutationObserver((muts) => {
        if (__globalSig.aborted) { mo.disconnect(); return; }
        for (const m of muts) { if (m.addedNodes) { m.addedNodes.forEach(n => { if (n.tagName === 'IFRAME') inject(n); else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(inject); }); } }
      });
      const observeRoot = document.documentElement || document.body;
      if (observeRoot) {
        mo.observe(observeRoot, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (__globalSig.aborted) return;
          const r = document.documentElement || document.body;
          if (r) mo.observe(r, { childList: true, subtree: true });
        }, { once: true, signal: __globalSig });
      }
      __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
    }

    const fsWraps = new WeakMap();
    function ensureFsWrapper(video) {
      if (fsWraps.has(video)) return fsWraps.get(video);
      if (!video || !video.parentNode) return null;
      const parent = video.parentNode;
      try {
        const rootNode = video.getRootNode();
        if (rootNode instanceof ShadowRoot && video.assignedSlot) {
          log.debug('Cannot wrap slotted video in shadow DOM');
          return null;
        }
      } catch (_) {}
      const wrap = document.createElement('div');
      wrap.className = 'vsc-fs-wrap';
      wrap.style.cssText = `position: relative; display: inline-block; width: 100%; height: 100%; max-width: 100%; background: black;`;
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
        if (video.readyState > 0 && video.src) {
          try {
            const target = document.body || document.documentElement;
            if (target) {
              video.style.setProperty('position', 'fixed', 'important');
              video.style.setProperty('top', '0', 'important');
              video.style.setProperty('left', '0', 'important');
              video.style.setProperty('width', '100vw', 'important');
              video.style.setProperty('height', '100vh', 'important');
              video.style.setProperty('z-index', '2147483647', 'important');
              video.style.setProperty('background', '#000', 'important');
              target.appendChild(video);
              log.warn('Video restored to body as emergency fallback');
              showOSD('비디오 복원됨 (비상 모드)', 3000);
            }
          } catch (_) {}
        } else {
          log.debug('Skipping body restore for inactive video');
        }
      }
      try { if (ph?.parentNode) ph.remove(); } catch (_) {}
      try { if (wrap.parentNode) wrap.remove(); } catch (_) {}
      fsWraps.delete(video);
      const st = getVState(video);
      st.fsPatched = false;
    }

    function patchMethodSafe(obj, name, wrappedFn) {
      try { obj[name] = wrappedFn; return true; } catch (_) { return false; }
    }

    function patchFullscreenRequest(video) {
      const st = getVState(video); if (!video || st.fsPatched) return; st.fsPatched = true;
      const origReq = video.requestFullscreen || video.webkitRequestFullscreen; if (!origReq) return;
      const runWrappedFs = function (...args) { const wrap = ensureFsWrapper(video); const cleanupIfNotFullscreen = () => { const fsEl = document.fullscreenElement || document.webkitFullscreenElement; if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video); }; if (wrap) { const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen; if (typeof req === 'function') { try { const ret = req.apply(wrap, args); if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } } } try { const ret = origReq.apply(video, args); if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } };
      if (video.requestFullscreen) patchMethodSafe(video, 'requestFullscreen', function (...args) {
        if (this !== video) return origReq.apply(this, args);
        return runWrappedFs.call(this, ...args);
      });
      if (video.webkitRequestFullscreen) patchMethodSafe(video, 'webkitRequestFullscreen', function (...args) {
        if (this !== video) return origReq.apply(this, args);
        return runWrappedFs.call(this, ...args);
      });
    }

    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl) {
        for (const v of TOUCHED.videos) { if (fsWraps.has(v)) restoreFromFsWrapper(v); }
        try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
      }
      if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure();
    }
    onDoc('fullscreenchange', onFsChange); onDoc('webkitfullscreenchange', onFsChange);

    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
    function getActivePiPVideo() { if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement; if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo; return null; }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      try { window.__VSC_INTERNAL__?.Adapter?.clear(video); } catch (_) {}
      const st = getVState(video);
      st._inPiP = true;
      st.applied = false;
      st.lastFilterUrl = null;
      if ('documentPictureInPicture' in window && window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        if (__activeDocumentPiPWindow) {
          if (__activeDocumentPiPWindow.closed) { resetPiPState(); }
          else { return true; }
        }
        try {
          const pipWindow = await window.documentPictureInPicture.requestWindow({ width: Math.max(video.videoWidth / 2, 400), height: Math.max(video.videoHeight / 2, 225) });
          if (!video.isConnected || !video.parentNode) {
            try { pipWindow.close(); } catch (_) {}
            st._inPiP = false;
            return false;
          }
          __activeDocumentPiPWindow = pipWindow; __activeDocumentPiPVideo = video; __pipOrigParent = video.parentNode; __pipOrigNext = video.nextSibling; __pipOrigCss = video.style.cssText;
          __pipPlaceholder = document.createElement('div'); __pipPlaceholder.style.width = video.clientWidth + 'px'; __pipPlaceholder.style.height = video.clientHeight + 'px'; __pipPlaceholder.style.background = 'black';
          if (__pipOrigParent) __pipOrigParent.insertBefore(__pipPlaceholder, video);
          pipWindow.document.body.style.margin = '0'; pipWindow.document.body.style.display = 'flex'; pipWindow.document.body.style.justifyContent = 'center'; pipWindow.document.body.style.alignItems = 'center'; pipWindow.document.body.style.background = 'black';
          video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
          const adopted = pipWindow.document.adoptNode(video);
          pipWindow.document.body.append(adopted);
          pipWindow.addEventListener('click', () => { if (video.paused) { const p = video.play(); if (p && typeof p.catch === 'function') { p.catch(() => { video.muted = true; video.play().catch(() => {}); }); } } else { video.pause(); } });
          pipWindow.addEventListener('pagehide', () => {
            try {
              video.style.cssText = __pipOrigCss;
              const restored = document.adoptNode(video);
              if (__pipPlaceholder?.parentNode?.isConnected) { __pipPlaceholder.parentNode.insertBefore(restored, __pipPlaceholder); __pipPlaceholder.remove(); }
              else if (__pipOrigParent?.isConnected) { if (__pipOrigNext && __pipOrigNext.parentNode === __pipOrigParent) { __pipOrigParent.insertBefore(restored, __pipOrigNext); } else { __pipOrigParent.appendChild(restored); } }
            } finally {
              resetPiPState();
              st._inPiP = false;
              st.applied = false;
              st.lastFilterUrl = null;
              const oldAc = st._ac;
              st._ac = null;
              st.bound = false;
              if (oldAc) { try { oldAc.abort(); } catch (_) {} }
              queueMicrotask(() => {
                try {
                  const ApplyReq = window.__VSC_INTERNAL__?.ApplyReq;
                  if (!ApplyReq) return;
                  if (video.isConnected && !st.bound) {
                    if (typeof bindVideoOnce === 'function') bindVideoOnce(video, ApplyReq);
                  }
                  ApplyReq.hard();
                } catch (_) {}
              });
            }
          });
          return true;
        } catch (e) { log.debug('Document PiP failed, fallback to video PiP', e); }
      }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') { try { await video.requestPictureInPicture(); return true; } catch (e) { return false; } }
      return false;
    }

    async function exitPiP(preferredVideo = null) {
      if (__activeDocumentPiPWindow) {
        if (!__activeDocumentPiPWindow.closed) __activeDocumentPiPWindow.close();
        else resetPiPState();
        return true;
      }
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); return true; } catch (_) {} }
      return false;
    }

    async function togglePiPFor(video) { if (!video || video.readyState < 2) return false; if ((__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed) || document.pictureInPictureElement === video) return exitPiP(video); if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} } return enterPiP(video); }

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

    /* [이식 4] 줌(Zoom) 기능 - v200 모바일 1손가락 패닝 및 CSS setProperty 개선 로직 적용 */
    function createZoomManager() {
      const stateMap = new WeakMap();
      let activeVideo = null, isPanning = false, startX = 0, startY = 0;
      let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      const zoomedVideos = new Set();
      let activePointerId = null;

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
          zoomedVideos.delete(v);
          return;
        }
        if (!st.zoomed) {
          st._savedPosition = v.style.getPropertyValue('position');
          st._savedZIndex = v.style.getPropertyValue('z-index');
          st.zoomed = true;
        }
        v.style.setProperty('will-change', 'transform', 'important');
        v.style.setProperty('contain', 'paint', 'important');
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
        pendingUpdates.add(v);
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const batch = [...pendingUpdates];
          pendingUpdates.clear();
          for (const video of batch) {
            if (!video.isConnected) continue;
            applyZoomStyle(video);
          }
        });
      };

      function clampPan(v, st) { const r = v.getBoundingClientRect(); if (!r || r.width <= 1 || r.height <= 1) return; const sw = r.width * st.scale, sh = r.height * st.scale; st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75); st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75); }

      const zoomTo = (v, newScale, clientX, clientY) => {
        const st = getSt(v), rect = v.getBoundingClientRect();
        if (!rect || rect.width <= 1) return;
        const ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale;
        st.tx = clientX - (rect.left - st.tx) - ix * newScale;
        st.ty = clientY - (rect.top - st.ty) - iy * newScale;
        st.scale = newScale;
        update(v);
      };

      const resetZoom = (v) => {
        if (!v) return;
        const st = getSt(v);
        st.scale = 1;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        pendingUpdates.delete(v);
        update(v);
      };

      const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
      const isZoomEnabled = () => !!window.__VSC_INTERNAL__?.Store?.get(P.APP_ZOOM_EN);
      const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

      function getTargetVideo(e) {
        if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
        const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null);
        if (cx != null && cy != null) { const els = document.elementsFromPoint(cx, cy); for (const el of els) { if (el?.tagName === 'VIDEO') return el; } }
        return window.__VSC_INTERNAL__?.App?.getActiveVideo() || null;
      }

      onWin('wheel', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
      }, { passive: false, capture: true });

      onWin('pointerdown', e => {
        if (!e.altKey || !isZoomEnabled() || e.pointerType === 'touch') return;
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
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
      }, { capture: true });

      onWin('touchstart', e => {
        if (CONFIG.IS_MOBILE && !isZoomEnabled()) return;
        const v = getTargetVideo(e); if (!v) return;
        if (e.touches.length === 2) {
          isPanning = false;
          if (e.cancelable) e.preventDefault();
          const st = getSt(v);
          activeVideo = v;
          pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches);
          pinchState.initialScale = st.scale;
          const c = getTouchCenter(e.touches);
          pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        } else if (e.touches.length === 1) {
          const st = getSt(v);
          if (st.scale > 1) {
            if (e.cancelable) e.preventDefault();
            activeVideo = v;
            isPanning = true;
            st.hasPanned = false;
            startX = e.touches[0].clientX - st.tx;
            startY = e.touches[0].clientY - st.ty;
          }
        }
      }, { passive: false, capture: true });

      onWin('touchmove', e => {
        if (!activeVideo) return;
        const st = getSt(activeVideo);
        if (pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
          let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist));
          newScale = Math.min(Math.max(1, newScale), 10);
          if (newScale < 1.05) {
            resetZoom(activeVideo);
            pinchState.active = false;
            isPanning = false;
            activeVideo = null;
          } else {
            zoomTo(activeVideo, newScale, center.x, center.y);
            st.tx += center.x - pinchState.lastCx;
            st.ty += center.y - pinchState.lastCy;
            clampPan(activeVideo, st);
            update(activeVideo);
          }
          pinchState.lastCx = center.x; pinchState.lastCy = center.y;
        } else if (isPanning && e.touches.length === 1 && st.scale > 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0];
          const nextTx = t.clientX - startX, nextTy = t.clientY - startY;
          if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
          st.tx = nextTx; st.ty = nextTy;
          clampPan(activeVideo, st);
          update(activeVideo);
        }
      }, { passive: false, capture: true });

      onWin('touchend', e => {
        if (!activeVideo) return;
        if (e.touches.length < 2) pinchState.active = false;
        if (e.touches.length === 1 && getSt(activeVideo).scale > 1) {
          isPanning = true;
          const st = getSt(activeVideo);
          st.hasPanned = false;
          startX = e.touches[0].clientX - st.tx;
          startY = e.touches[0].clientY - st.ty;
        } else if (e.touches.length === 0) {
          isPanning = false;
          update(activeVideo);
          activeVideo = null;
        }
      }, { passive: false, capture: true });

      return {
        resetZoom, zoomTo, isZoomed,
        pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } },
        destroy: () => {
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
          zoomedVideos.clear();
          isPanning = false; pinchState.active = false;
          activeVideo = null; activePointerId = null;
        }
      };
    }
function createTargeting() {
      let stickyTarget = null; let stickyScore = -Infinity; let stickyUntil = 0;
      const SCORE = Object.freeze({
        PLAYING: 6.0, HAS_PROGRESS: 2.0, AREA_SCALE: 1.1, AREA_DIVISOR: 20000,
        USER_PROX_MAX: 2.0, USER_PROX_DECAY: 1800, USER_PROX_RAD_SQ: 722500,
        CENTER_BIAS: 0.7, CENTER_RAD_SQ: 810000,
        AUDIO_BASE: 1.2, AUDIO_BOOST_EXTRA: 1.0, PIP_BONUS: 3.0,
        MIN_AREA: 160 * 120
      });
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now(); const vp = getViewportSnapshot(); let best = null, bestScore = -Infinity;
        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, now, 400); const area = r.width * r.height;
          const pip = isPiPActiveVideo(v);
          if (area < SCORE.MIN_AREA && !pip) return;
          const cx = r.left + r.width * 0.5; const cy = r.top + r.height * 0.5;
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
        for (const v of videos) { evalScore(v); }
        const activePip = getActivePiPVideo();
        if (activePip && activePip.isConnected && !videos.has(activePip)) { evalScore(activePip); }
        if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
          if (!stickyTarget.paused && !stickyTarget.ended && best && stickyTarget !== best && (bestScore < stickyScore + GUARD.TARGET_HYSTERESIS_MARGIN)) { return { target: stickyTarget }; }
        }
        stickyTarget = best; stickyScore = bestScore; stickyUntil = now + GUARD.TARGET_HYSTERESIS_MS;
        return { target: best };
      }
      return Object.freeze({ pickFastActiveOnly });
    }

    function createEventBus() { const subs = new Map(); const on = (name, fn) => { let s = subs.get(name); if (!s) { s = new Set(); subs.set(name, s); } s.add(fn); return () => s.delete(fn); }; const emit = (name, payload) => { const s = subs.get(name); if (!s) return; for (const fn of s) { try { fn(payload); } catch (_) {} } }; let queued = false, flushTimer = 0, forceApplyAgg = false; function flush() { queued = false; if (flushTimer) { clearTimer(flushTimer); flushTimer = 0; } const payload = { forceApply: forceApplyAgg }; emit('signal', payload); forceApplyAgg = false; } const signal = (p) => { if (p) { if (p.forceApply) forceApplyAgg = true; } if (!queued) { queued = true; if (document.visibilityState === 'hidden') { flushTimer = setTimer(flush, 0); } else { requestAnimationFrame(flush); } } }; return Object.freeze({ on, signal }); }
    function createApplyRequester(Bus, Scheduler) { return Object.freeze({ soft() { try { Bus.signal(); } catch (_) { try { Scheduler.request(false); } catch (_) {} } }, hard() { try { Bus.signal({ forceApply: true }); } catch (_) { try { Scheduler.request(true); } catch (_) {} } } }); }

    function createUtils() {
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => { const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), (e) => { if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation(); v(e); }); } else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); } else if (k === 'class') el.className = v; else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v); } children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); }); return el; },
        deepClone: structuredClone,
        createCappedMap: (max = 64) => {
          const m = new Map();
          return {
            get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
            set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }
          };
        }
      };
    }

    function createScheduler(minIntervalMs = 16) {
      let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
      function clearPending() { if (timer) { clearTimer(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      function queueRaf() { if (rafId) return; rafId = requestAnimationFrame(run); }
      function timerCb() { timer = 0; queueRaf(); }
      function run() {
        const currentRafId = rafId;
        rafId = 0;
        if (currentRafId === 0) return;
        queued = false;
        const now = performance.now(), doForce = force;
        force = false;
        const dt = now - lastRun;
        if (!doForce && dt < minIntervalMs) {
          const wait = Math.max(0, minIntervalMs - dt);
          if (!timer) timer = setTimer(timerCb, wait);
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

    function createLocalStore(defaults, scheduler, Utils) { let rev = 0; const listeners = new Map(); const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch (_) {} } const dot = key.indexOf('.'); if (dot > 0) { const catStar = key.slice(0, dot) + '.*'; const b = listeners.get(catStar); if (b) for (const cb of b) { try { cb(val); } catch (_) {} } } }; const state = Utils.deepClone(defaults); const proxyCache = Object.create(null); const pathCache = Utils.createCappedMap(256); let batchDepth = 0, batchChanged = false; const batchEmits = new Map(); const parsePath = (p) => { let hit = pathCache.get(p); if (hit) return hit; const dot = p.indexOf('.'); hit = (dot < 0) ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; pathCache.set(p, hit); return hit; }; function invalidateProxyBranch(path) { if (!path) return; delete proxyCache[path]; const prefix = path + '.'; for (const k in proxyCache) { if (k.startsWith(prefix)) delete proxyCache[k]; } } function flushBatch() { if (!batchChanged) return; const emitsSnapshot = new Map(batchEmits); batchEmits.clear(); batchChanged = false; rev++; for (const [key, val] of emitsSnapshot) { emit(key, val); } scheduler.request(false); } function notifyChange(fullPath, val) { if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; } rev++; emit(fullPath, val); scheduler.request(false); } function createProxyDeep(obj, pathPrefix) { return new Proxy(obj, { get(target, prop) { const value = target[prop]; if (typeof value === 'object' && value !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(value, cacheKey); return proxyCache[cacheKey]; } return value; }, set(target, prop, val) { if (Object.is(target[prop], val)) return true; const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if ((typeof target[prop] === 'object' && target[prop] !== null) || (typeof val === 'object' && val !== null)) { invalidateProxyBranch(fullPath); } target[prop] = val; notifyChange(fullPath, val); return true; } }); } const proxyState = createProxyDeep(state, ''); return { state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat], get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; }, set: (p, val) => { const [c, k] = parsePath(p); if (k == null) { if (typeof state[c] === 'object' && state[c] !== null && typeof val === 'object' && val !== null) { for (const [subK, subV] of Object.entries(val)) proxyState[c][subK] = subV; } else { proxyState[c] = val; } return; } proxyState[c][k] = val; }, batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } catch (e) { log.warn('batch partial error:', e); } finally { batchDepth--; if (batchDepth === 0) { flushBatch(); } } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); } }; }

    function normalizeBySchema(sm, schema) { let changed = false; const setIfDiff = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } }; for (const rule of schema) { const type = rule.type; const path = rule.path; if (type === 'bool') { setIfDiff(path, !!sm.get(path)); continue; } if (type === 'enum') { const cur = sm.get(path); if (!rule.values.includes(cur)) { setIfDiff(path, rule.fallback()); } continue; } if (type === 'num') { let n = Number(sm.get(path)); if (!Number.isFinite(n)) n = rule.fallback(); if (rule.round) n = Math.round(n); n = Math.max(rule.min, Math.min(rule.max, n)); setIfDiff(path, n); continue; } } return changed; }

    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0; const shadowRootsLRU = []; const observedShadowHosts = new WeakSet(); let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }
      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.01, rootMargin: '300px' }) : null;
      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
      const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); st.rect = e.contentRect ? el.getBoundingClientRect() : null; st.rectT = now; st.rectEpoch = -1; st._resizeDirty = true; dirty.videos.add(el); changed = true; } if (changed) requestRefreshCoalesced(); }) : null;
      const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; patchFullscreenRequest(el); videos.add(el); if (io) { io.observe(el); } else { const st = getVState(el); st.visible = true; if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } } if (ro) ro.observe(el); };
      const WorkQ = (() => { const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap(); function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); } const postTaskBg = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function') ? (fn) => globalThis.scheduler.postTask(fn, { priority: 'background' }) : null; const schedule = () => { if (scheduled) return; scheduled = true; if (postTaskBg) { postTaskBg(drainRunnerRaf).catch(() => { if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }); return; } if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }; const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); }; const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} } }; const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; let bigProcessed = 0; while (bigHead < bigQ.length && budget()) { scanNode(bigQ[bigHead++]); if (++bigProcessed >= 2) break; } while (head < q.length && budget()) { scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); }; return Object.freeze({ enqueue }); })();
      function nodeMayContainVideo(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') return true; if ((n.childElementCount || 0) === 0) return false; try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } } } try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; } }
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
                if ((n.childElementCount || 0) > 0) { try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {} }
              }
            }
          }
          if (touchedVideoTree) requestRefreshCoalesced();
        });
        mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root);
      };
      const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); if (!FEATURE_FLAGS.trackShadowRoots) { const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } return; } for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };

      /* [이식 2] Shadow DOM 최적화 (v200 로직 - 수신부 직접 할당) */
      if (FEATURE_FLAGS.trackShadowRoots) {
        window.__VSC_INTERNAL__._onShadow = (host, sr) => {
          try {
            if (!sr || !host || observedShadowHosts.has(host)) return;
            observedShadowHosts.add(host);
            if (shadowRootsLRU.length >= SHADOW_ROOT_LRU_MAX) {
              const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
              if (idx >= 0) shadowRootsLRU.splice(idx, 1);
              else shadowRootsLRU.shift();
            }
            shadowRootsLRU.push({ host, root: sr });
            connectObserver(sr);
          } catch (_) {}
        };
      }

      refreshObservers();
      function pruneBatch(set, visibleSet, dirtySet, limit = 200) {
        let removed = 0, scanned = 0;
        for (const el of set) {
          if (++scanned > limit) break;
          if (!el || !el.isConnected) {
            set.delete(el); visibleSet.delete(el); dirtySet.delete(el);
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
          for (const it of shadowRootsLRU) {
            if (it.host?.isConnected) WorkQ.enqueue(it.root);
          }
        }
      };
    }

    function createAudio(sm) {
      let ctx, compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, clipper, analyser, dataArray, target = null, currentSrc = null; let srcMap = new WeakMap(); let makeupDbEma = 0; let switchTimer = 0, switchTok = 0; let gestureHooked = false; let loopTok = 0; let __audioLoopTimer = 0; const VSC_AUD_HPF_HZ = 45; const VSC_AUD_HPF_Q = 0.707; const VSC_AUD_CLIP_KNEE = 0.985; const VSC_AUD_CLIP_DRIVE = 6.0; let __vscClipCurve = null;
      function getSoftClipCurve() { if (__vscClipCurve) return __vscClipCurve; const n = 2048; const knee = VSC_AUD_CLIP_KNEE; const drive = VSC_AUD_CLIP_DRIVE; const curve = new Float32Array(n); const tanhD = Math.tanh(drive); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; const ax = Math.abs(x); let y; if (ax <= knee) { y = x; } else { const t = (ax - knee) / Math.max(1e-6, (1 - knee)); const s = Math.tanh(drive * t) / tanhD; y = Math.sign(x) * (knee + (1 - knee) * s); } curve[i] = y; } __vscClipCurve = curve; return curve; }
      const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') { await ctx.resume(); } if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); window.removeEventListener('touchstart', onGesture, true); window.removeEventListener('click', onGesture, true); gestureHooked = false; } } catch (_) {} };
      const ensureGestureResumeHook = () => {
        if (gestureHooked) return;
        gestureHooked = true;
        const resumeEvents = ['pointerdown', 'keydown', 'touchstart', 'click'];
        for (const evt of resumeEvents) {
          onWin(evt, onGesture, { passive: true, capture: true });
        }
      };
      const clamp = VSC_CLAMP; const VSC_AUDIO_AUTO_MAKEUP = true;
      function runAudioLoop(tok) {
        if (tok !== loopTok || !ctx) return;
        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const actuallyEnabled = en && currentSrc;
        if (!actuallyEnabled) {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
          if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
          return;
        }
        if (VSC_AUDIO_AUTO_MAKEUP && analyser) {
          analyser.getFloatTimeDomainData(dataArray); let sumSquare = 0; for (let i = 0; i < dataArray.length; i++) { sumSquare += dataArray[i] * dataArray[i]; } const rms = Math.sqrt(sumSquare / dataArray.length); const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100; let redDb = 0; try { const r = compressor?.reduction; redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0; } catch (_) {} if (!Number.isFinite(redDb)) redDb = 0; const redPos = clamp(-redDb, 0, 18); let gateMult = 1.0; if (db < -45) { gateMult = 0.0; } else if (db < -40) { gateMult = (db - (-45)) / 5.0; } const makeupDbTarget = clamp(Math.max(0, redPos - 1.5) * 0.40, 0, 4.5) * gateMult; const isAttack = makeupDbTarget < makeupDbEma; const alpha = isAttack ? 0.35 : 0.015; makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
        } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
        const boostDb = Number(sm.get(P.A_BST) || 0);
        const userBoost = Math.pow(10, boostDb / 20);
        const makeup = Math.pow(10, makeupDbEma / 20);
        if (wetInGain) { const finalGain = userBoost * makeup; try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; } }
        const delay = document.hidden ? 500 : 70;
        clearTimer(__audioLoopTimer);
        __audioLoopTimer = setTimer(() => { __audioLoopTimer = 0; runAudioLoop(tok); }, delay);
      }
      const resetCtx = () => { ctx = null; compressor = null; limiter = null; wetInGain = null; dryOut = null; wetOut = null; masterOut = null; hpf = null; clipper = null; analyser = null; dataArray = null; currentSrc = null; target = null; };
      const buildAudioGraph = () => { compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 3.0; compressor.attack.value = 0.008; compressor.release.value = 0.15; limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -1.5; limiter.knee.value = 1.0; limiter.ratio.value = 20.0; limiter.attack.value = 0.0015; limiter.release.value = 0.09; hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = VSC_AUD_HPF_HZ; hpf.Q.value = VSC_AUD_HPF_Q; clipper = ctx.createWaveShaper(); clipper.curve = getSoftClipCurve(); try { clipper.oversample = '2x'; } catch (_) {} analyser = ctx.createAnalyser(); analyser.fftSize = 2048; dataArray = new Float32Array(analyser.fftSize); dryOut = ctx.createGain(); wetOut = ctx.createGain(); wetInGain = ctx.createGain(); masterOut = ctx.createGain(); dryOut.connect(masterOut); wetOut.connect(masterOut); hpf.connect(compressor); hpf.connect(analyser); compressor.connect(wetInGain); wetInGain.connect(limiter); limiter.connect(clipper); clipper.connect(wetOut); masterOut.connect(ctx.destination); };
      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') {
          srcMap = new WeakMap();
          if (target) { const tst = getVState(target); tst.audioFailUntil = 0; }
          resetCtx();
        }
        if (ctx) return true;
        srcMap = new WeakMap();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { ctx = new AC(); }
        ensureGestureResumeHook(); buildAudioGraph(); return true;
      };
      const rampGainsSafe = (dryTarget, wetTarget, tc = 0.015) => { if (!ctx) return; const t = ctx.currentTime; try { dryOut.gain.cancelScheduledValues(t); wetOut.gain.cancelScheduledValues(t); dryOut.gain.setTargetAtTime(dryTarget, t, tc); wetOut.gain.setTargetAtTime(wetTarget, t, tc); } catch (_) { dryOut.gain.value = dryTarget; wetOut.gain.value = wetTarget; } };
      const fadeOutThen = (fn) => { if (!ctx) { fn(); return; } const tok = ++switchTok; clearTimer(switchTimer); const t = ctx.currentTime; try { masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + 0.04); } catch (_) { masterOut.gain.value = 0; } switchTimer = setTimer(() => { if (tok !== switchTok) return; makeupDbEma = 0; try { fn(); } catch (_) {} if (ctx) { const t2 = ctx.currentTime; try { masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04); } catch (_) { masterOut.gain.value = 1; } } }, 60); };
      const disconnectAll = () => { if (currentSrc) { try { currentSrc.disconnect(); } catch (_) {} } currentSrc = null; target = null; };
      const updateMix = () => { if (!ctx) return; const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); const isHooked = !!currentSrc; const actuallyEnabled = en && isHooked; const dryTarget = actuallyEnabled ? 0 : 1; const wetTarget = actuallyEnabled ? 1 : 0; rampGainsSafe(dryTarget, wetTarget, 0.015); loopTok++; clearTimer(__audioLoopTimer); __audioLoopTimer = 0; if (actuallyEnabled) { runAudioLoop(loopTok); } };
      async function destroy() {
        loopTok++;
        clearTimer(__audioLoopTimer);
        __audioLoopTimer = 0;
        try {
          if (gestureHooked) {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
            window.removeEventListener('touchstart', onGesture, true);
            window.removeEventListener('click', onGesture, true);
            gestureHooked = false;
          }
        } catch (_) {}
        clearTimer(switchTimer);
        switchTok++;
        disconnectAll();
        srcMap = new WeakMap();
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        resetCtx();
        makeupDbEma = 0;
      }
      return { setTarget: (v) => { const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); const st = v ? getVState(v) : null; if (st && st.audioFailUntil > performance.now()) { if (v !== target) { fadeOutThen(() => { disconnectAll(); target = v; }); } updateMix(); return; } if (!ensureCtx()) return; if (v && ctx?.state === 'suspended' && !v.paused) { ctx.resume().catch(() => {}); } if (v === target) { updateMix(); return; } fadeOutThen(() => { disconnectAll(); target = v; if (!v) { updateMix(); return; } try { let s = srcMap.get(v); if (!s) { try { s = ctx.createMediaElementSource(v); } catch (e) { if (e.name === 'InvalidStateError') { log.debug('MediaElementSource already exists for this element, marking cooldown'); if (st && VSC_DEFENSE.audioCooldown) { st.audioFailUntil = performance.now() + GUARD.AUDIO_SRC_COOLDOWN; } disconnectAll(); updateMix(); return; } throw e; } srcMap.set(v, s); } if (s.context !== ctx) { srcMap.delete(v); if (st && VSC_DEFENSE.audioCooldown) { st.audioFailUntil = performance.now() + GUARD.AUDIO_SRC_COOLDOWN; } disconnectAll(); updateMix(); return; } s.connect(dryOut); s.connect(hpf || compressor); currentSrc = s; } catch (e) { log.warn('Audio source connection failed:', e); if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + GUARD.AUDIO_SRC_COOLDOWN; disconnectAll(); } updateMix(); }); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
    }

    function createAutoSceneManager(Store, P, Scheduler) {
      const clamp = VSC_CLAMP; const approach = (cur, tgt, a, dead=0.002) => { const d = tgt - cur; return Math.abs(d) < dead ? tgt : cur + d * a; };
      const AUTO = { running: false, canvasW: 48, canvasH: 27, cur: { br: 1.0, ct: 1.0, sat: 1.0 }, tgt: { br: 1.0, ct: 1.0, sat: 1.0 }, lastSig: null, cutHist: [], motionEma: 0, motionAlpha: 0.30, motionThresh: 0.0075, motionFrames: 0, motionMinFrames: 5, statsEma: null, statsAlpha: 0.12, drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0, boostMs: 800, minBoostEarlyMs: 700, fpsHist: [], minFps: 1, maxFps: 6, curFps: 1, _lastMean: 0 };
      let drmRetryCount = 0;
      const MAX_DRM_RETRIES = 5;
      const c = document.createElement('canvas'); c.width = AUTO.canvasW; c.height = AUTO.canvasH; let ctx = null; try { ctx = c.getContext('2d', { willReadFrequently: true, desynchronized: true, alpha: false, colorSpace: 'srgb' }); } catch (_) { try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch (__) {} }

      function computeStatsAndMotion(AUTO, img, sw, sh) {
        const data = img.data; const step = 2; let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0;
        for (let y = 0; y < sh; y += step) { let idx = (y * sw) * 4; for (let x = 0; x < sw; x += step) { const r = data[idx], g = data[idx + 1], b = data[idx + 2]; const l = (r * 0.2126 + g * 0.7152 + b * 0.0722) | 0; const max = r > g ? (r > b ? r : b) : (g > b ? g : b); const min = r < g ? (r < b ? r : b) : (g < b ? g : b); sumChroma += (max - min); sum += l; sum2 += l * l; count++; if (x + step < sw && idx + 10 < data.length) { const l2 = (data[idx + 8] * 0.2126 + data[idx + 9] * 0.7152 + data[idx + 10] * 0.0722) | 0; sumEdge += Math.abs(l2 - l); } idx += step * 4; } }
        const samples = Math.max(1, count); const mean = sum / samples; const std = Math.sqrt(Math.max(0, (sum2 / samples) - mean * mean)); const motion = Math.abs(mean - (AUTO._lastMean || mean)) / 255; AUTO._lastMean = mean;
        return { bright: mean / 255, contrast: std / 64, chroma: (sumChroma / samples) / 255, edge: sumEdge / samples, motion };
      }
      function detectCut(stats) { if (!AUTO.lastSig) return false; const score = (Math.abs(stats.bright - AUTO.lastSig.bright) * 1.1) + (Math.abs(stats.contrast - AUTO.lastSig.contrast) * 0.9); AUTO.cutHist.push(score); if (AUTO.cutHist.length > 20) AUTO.cutHist.shift(); const sorted = AUTO.cutHist.slice().sort((a,b)=>a-b); const q80 = sorted[Math.floor(sorted.length * 0.80)] || 0.14; const thr = Math.max(0.10, Math.min(0.22, q80 * 1.05)); return score > thr; }
      function calculateAdaptiveFps(changeScore) { AUTO.fpsHist.push(changeScore); if (AUTO.fpsHist.length > 5) AUTO.fpsHist.shift(); const avgChange = AUTO.fpsHist.reduce((a, b) => a + b, 0) / AUTO.fpsHist.length; const targetFps = (avgChange < 0.1 ? 2 + (avgChange/0.1)*2 : 0) + (avgChange >= 0.1 && avgChange < 0.3 ? 4 + ((avgChange-0.1)/0.2)*3 : 0) + (avgChange >= 0.3 ? 7 + (Math.min(avgChange-0.3,0.7)/0.7)*3 : 0); const clamped = clamp(targetFps, AUTO.minFps, AUTO.maxFps); const rounded = Math.round(clamped * 2) / 2; AUTO.curFps += clamp(rounded - AUTO.curFps, -1, 1); return AUTO.curFps; }
      let __asRvfcId = 0; function scheduleNext(v, delayMs) { if (!AUTO.running) return; if (v && !v.paused && typeof v.requestVideoFrameCallback === 'function') { const target = performance.now() + Math.max(0, delayMs|0); try { if (__asRvfcId && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(__asRvfcId); } catch (_) {} __asRvfcId = v.requestVideoFrameCallback(() => { __asRvfcId = 0; const remain = target - performance.now(); if (remain > 6) { scheduleNext(v, remain); return; } loop(); }); return; } setTimer(loop, Math.max(16, delayMs|0)); }
      function loop() { if (!AUTO.running) return; const now = performance.now(); const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT); const v = window.__VSC_APP__?.getActiveVideo?.(); if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0 }; scheduleNext(v, 500); return; } if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; } if (document.hidden) { scheduleNext(v, 2000); return; } if (!v || !ctx || v.paused || v.seeking || v.readyState < 2) { try { Scheduler.request(true); } catch (_) {} scheduleNext(v, 300); return; } const useW = 48, useH = 27; try { if (c.width !== useW || c.height !== useH) { c.width = useW; c.height = useH; AUTO.canvasW = useW; AUTO.canvasH = useH; } ctx.drawImage(v, 0, 0, useW, useH); const img = ctx.getImageData(0, 0, useW, useH); AUTO.drmBlocked = false; drmRetryCount = 0; const stats = computeStatsAndMotion(AUTO, img, useW, useH); AUTO.motionEma = (AUTO.motionEma * (1 - AUTO.motionAlpha)) + (stats.motion * AUTO.motionAlpha); AUTO.motionFrames = (AUTO.motionEma >= AUTO.motionThresh) ? (AUTO.motionFrames + 1) : 0; const isCut = detectCut(stats); AUTO.lastSig = stats; if (!AUTO.statsEma) AUTO.statsEma = { ...stats }; else { const e = AUTO.statsEma, a = AUTO.statsAlpha; e.bright = e.bright*(1-a) + stats.bright*a; e.contrast = e.contrast*(1-a) + stats.contrast*a; e.edge = e.edge*(1-a) + stats.edge*a; e.chroma = (e.chroma ?? stats.chroma)*(1-a) + stats.chroma*a; } const sig = AUTO.statsEma; if (isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; } const allowUpdate = isCut || (AUTO.motionFrames >= AUTO.motionMinFrames); let fps = AUTO.curFps; if (allowUpdate) { fps = calculateAdaptiveFps(clamp(stats.motion||0,0,1)); fps = Math.min(fps, 6); if (now < AUTO.tBoostUntil) fps = Math.max(fps, (now - AUTO.tBoostStart < AUTO.minBoostEarlyMs) ? 6 : 4); const errY = clamp(0.50 - sig.bright, -0.22, 0.22); const errSd = clamp(0.23 - sig.contrast, -0.18, 0.18); AUTO.tgt.br = clamp(1.12 + errY * 0.98, 0.92, 1.35); AUTO.tgt.ct = clamp(1.0 + (-errSd) * 0.85, 0.82, 1.30); const curCh = Number(sig.chroma || 0); const errCh = clamp(0.18 - curCh, -0.18, 0.18); AUTO.tgt.sat = clamp(1.08 + errCh * 1.10, 0.85, 1.50); const smoothA = isCut ? 0.16 : 0.05; const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat; AUTO.cur.br = approach(AUTO.cur.br, AUTO.tgt.br, smoothA); AUTO.cur.ct = approach(AUTO.cur.ct, AUTO.tgt.ct, smoothA); AUTO.cur.sat = approach(AUTO.cur.sat, AUTO.tgt.sat, smoothA); if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001) { Scheduler.request(true); } } scheduleNext(v, Math.max(150, Math.round(1000 / Math.max(1, fps)))); } catch (e) {
        const isDrmLike = (e.name === 'SecurityError' || e.message?.includes('tainted'));
        if (VSC_DEFENSE.autoSceneDrmBackoff && isDrmLike) {
          drmRetryCount++;
          AUTO.drmBlocked = true;
          if (drmRetryCount >= MAX_DRM_RETRIES) {
            AUTO.running = false;
            AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0 };
            Store.set(P.APP_AUTO_SCENE, false);
            showOSD('Auto Scene: 보안 제한으로 비활성화됨', 3000);
            Scheduler.request(true);
            return;
          }
          const backoffMs = Math.min(30000, 5000 * Math.pow(1.5, drmRetryCount - 1));
          AUTO.blockUntilMs = performance.now() + backoffMs;
          scheduleNext(v, backoffMs);
        } else {
          log.debug('AutoScene error (non-DRM):', e);
          scheduleNext(v, 1000);
        }
      } }
      Store.sub(P.APP_AUTO_SCENE, (en) => { if (en && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } else if (!en) { AUTO.running = false; AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0 }; Scheduler.request(true); } });
      Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } });
      return { getMods: () => AUTO.cur, start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } }, stop: () => { AUTO.running = false; } };
    }
function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(64);
      const qInt = (v, step) => Math.round(v / step);
      const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };

      function wantsDetailPass(s) { return (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)) > 0; }
      const makeKeyBase = (s) => qInt(s.gain,0.04) + '|' + qInt(s.gamma,0.01) + '|' + qInt(s.contrast,0.01) + '|' + qInt(s.bright,0.2) + '|' + qInt(s.satF,0.01) + '|' + qInt(s.mid,0.02) + '|' + qInt(s.toe,0.2) + '|' + qInt(s.shoulder,0.2) + '|' + qInt(s.temp,0.2) + '|' + qInt(s.sharp,0.2) + '|' + qInt(s.sharp2,0.2) + '|' + qInt(s.clarity,0.2);

      function getToneTableCached(steps, toeN, shoulderN, midN, gain, contrast, brightOffset, gamma) {
        const key = `${steps}|${Math.round(toeN*1000)}|${Math.round(shoulderN*1000)}|${Math.round(midN*1000)}|${Math.round(gain*1000)}|${Math.round(contrast*1000)}|${Math.round(brightOffset*10000)}|${Math.round(gamma*1000)}`;
        const hit = toneCache.get(key); if (hit) return hit;
        const toeEnd = 0.34 + Math.abs(toeN) * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1;
        const shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN);
        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const kk = Math.max(0.7, 1.2 + shAmt * 6.5); const shDen = (1 - Math.exp(-kk));
        const out = new Array(steps); let prev = 0;
        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = Number(gamma);
        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1);
          let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
          if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); }
          if (shAmt > 1e-6 && x > shoulderStart) { const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)); const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt; x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1); }
          x = x * contrast + intercept; x = clamp(x, 0, 1);
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;
          const yy = Math.round(x * 10000) / 10000; out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      const mkXfer = (attrs, childAttrs, forceOpaqueAlpha = false) => {
        const children = ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', ...childAttrs }));
        if (forceOpaqueAlpha) { children.push(h('feFuncA', { ns: 'svg', type: 'table', tableValues: '1 1' })); }
        return h('feComponentTransfer', { ns: 'svg', ...attrs }, ...children);
      };

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);

        const fidLite = `vsc-lite-${config.VSC_ID}`;
        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const liteConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'lSharp' });
        const liteTone = mkXfer({ in: 'lSharp', result: 'lBase' }, { type: 'table', tableValues: '0 1' });
        const liteTmp = mkXfer({ in: 'lBase', result: 'lTmp' }, { type: 'linear', slope: '1' });
        const liteSat = h('feColorMatrix', { ns: 'svg', in: 'lTmp', type: 'saturate', values: '1', result: 'lSat' });
        lite.append(liteConv, liteTone, liteTmp, liteSat);
        defs.append(lite);

        const fidFull = `vsc-full-${config.VSC_ID}`;
        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });

        const fConv = h('feConvolveMatrix', { ns: 'svg',
          in: 'SourceGraphic', order: '3',
          kernelMatrix: '0,0,0, 0,1,0, 0,0,0',
          divisor: '1', bias: '0',
          targetX: '1', targetY: '1',
          edgeMode: 'duplicate',
          preserveAlpha: 'true',
          result: 'conv'
        });

        const fBlur = h('feGaussianBlur', { ns: 'svg', in: 'conv', stdDeviation: '2.5', result: 'blr' });

        const fUsm = h('feComposite', { ns: 'svg',
          in: 'conv', in2: 'blr',
          operator: 'arithmetic',
          k1: '0', k2: '1.0', k3: '0', k4: '0',
          result: 'usm'
        });

        const fTone = mkXfer({ in: 'usm', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);

        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });

        const fSat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });

        const fFinal = h('feColorMatrix', { ns: 'svg', in: 'sat', type: 'saturate', values: '0.97', result: 'final' });

        full.append(fConv, fBlur, fUsm, fTone, fTemp, fSat, fFinal);
        defs.append(full);

        const tryAppend = () => {
          const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
          if (!target?.appendChild) return false;
          try {
            const escapedFull = fidFull.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const existing = target.querySelector(`filter[id="${escapedFull}"]`);
            if (existing) {
              const oldSvg = existing.closest('svg');
              if (oldSvg && oldSvg !== svg) oldSvg.remove();
            }
          } catch (_) {}
          target.appendChild(svg);
          return true;
        };
        if (!tryAppend()) { const t = setRecurring(() => { if (tryAppend()) clearRecurring(t); }, 50); setTimer(() => clearRecurring(t), 3000); }

        return {
          fidLite, fidFull,
          liteConv,
          liteToneFuncs: Array.from(liteTone.children),
          liteTmpFuncs: Array.from(liteTmp.children),
          liteSat,
          fConv, fBlur, fUsm,
          fullToneFuncs: Array.from(fTone.children),
          fullTempFuncs: Array.from(fTemp.children),
          fullSat: fSat,
          fFinal,
          st: {
            lastKey: '',
            liteToneKey: '', liteToneTable: '', liteTempKey: '', liteSatKey: '', liteConvKey: '',
            fullToneKey: '', fullToneTable: '', fullTempKey: '', fullSatKey: '', fullSharpKey: '', fullDesatKey: ''
          }
        };
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key:'', url:'' }; urlCache.set(root, dc); }

        const detailOn = wantsDetailPass(s) && !__liteForced;
        const useFull = detailOn;

        const vwKey = video.videoWidth || 0, vhKey = video.videoHeight || 0;
        const modeTag = useFull ? 'FULL' : 'LITE';
        const key = modeTag + '|' + vwKey + 'x' + vhKey + '|' + makeKeyBase(s);
        if (dc.key === key) return dc.url;

        let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== key) {
          st.lastKey = key;
          const steps = 256;
          const con = clamp(s.contrast || 1, 0.1, 5.0), brOff = clamp((s.bright || 0) / 1000, -0.5, 0.5), gamma = 1/clamp(s.gamma||1, 0.1, 5.0);
          const toeQ  = qInt(clamp((s.toe||0)/14, -1, 1), 0.02) * 0.02;
          const shQ   = qInt(clamp((s.shoulder||0)/16, -1, 1), 0.02) * 0.02;
          const midQ  = qInt(clamp(s.mid||0, -1, 1), 0.02) * 0.02;
          const gainQ = qInt(s.gain||1, 0.06) * 0.06;
          const tk = `${steps}|${Math.round(toeQ*1000)}|${Math.round(shQ*1000)}|${Math.round(midQ*1000)}|${Math.round(gainQ*1000)}|${Math.round(con*1000)}|${Math.round(brOff*10000)}|${Math.round(gamma*1000)}`;
          const satVal = clamp(s.satF ?? 1, 0, 5.0).toFixed(2);
          const { rs, gs, bs } = tempToRgbGain(s.temp); const tmk = rs.toFixed(3) + '|' + gs.toFixed(3) + '|' + bs.toFixed(3);

          if (useFull) {
            if (st.fullToneKey !== tk) {
              st.fullToneKey = tk;
              st.fullToneTable = getToneTableCached(steps, toeQ, shQ, midQ, gainQ, con, brOff, gamma);
              for (const fn of ctx.fullToneFuncs) {
                if (fn.tagName === 'feFuncA') continue;
                fn.setAttribute('tableValues', st.fullToneTable);
              }
            }
            if (st.fullSatKey !== satVal) { st.fullSatKey = satVal; ctx.fullSat.setAttribute('values', satVal); }
            if (st.fullTempKey !== tmk) {
              st.fullTempKey = tmk;
              ctx.fullTempFuncs[0].setAttribute('slope', rs);
              ctx.fullTempFuncs[1].setAttribute('slope', gs);
              ctx.fullTempFuncs[2].setAttribute('slope', bs);
            }

            const sharpAmt = Number(s.sharp || 0);
            const sharp2Amt = Number(s.sharp2 || 0);
            const clarityAmt = Number(s.clarity || 0);
            const sharpKey = sharpAmt + '|' + sharp2Amt + '|' + clarityAmt + '|' + vhKey;
            if (st.fullSharpKey !== sharpKey) {
              st.fullSharpKey = sharpKey;
              const refH = 1080;
              const pxScale = clamp((vhKey || refH) / refH, 0.5, 2.0);

              const rawE = (sharpAmt / 50 + sharp2Amt / 80) * pxScale;
              const e = clamp(rawE, 0, 0.5);
              const center = (1 + 4 * e);
              if (e > 0.005) {
                ctx.fConv.setAttribute('kernelMatrix',
                  `0,${(-e).toFixed(4)},0, ${(-e).toFixed(4)},${center.toFixed(4)},${(-e).toFixed(4)}, 0,${(-e).toFixed(4)},0`);
              } else {
                ctx.fConv.setAttribute('kernelMatrix', '0,0,0, 0,1,0, 0,0,0');
              }

              const cAmt = clamp(clarityAmt / 50 * pxScale, 0, 0.35);
              ctx.fUsm.setAttribute('k2', (1 + cAmt).toFixed(4));
              ctx.fUsm.setAttribute('k3', (-cAmt).toFixed(4));
              ctx.fBlur.setAttribute('stdDeviation', (2.5 * pxScale).toFixed(2));

              const totalSharp = e + cAmt;
              const desatVal = clamp(1.0 - totalSharp * 0.08, 0.88, 1.0).toFixed(3);
              if (st.fullDesatKey !== desatVal) {
                st.fullDesatKey = desatVal;
                ctx.fFinal.setAttribute('values', desatVal);
              }
            }
          } else {
            if (st.liteToneKey !== tk) {
              st.liteToneKey = tk;
              st.liteToneTable = getToneTableCached(steps, toeQ, shQ, midQ, gainQ, con, brOff, gamma);
              for (const fn of ctx.liteToneFuncs) fn.setAttribute('tableValues', st.liteToneTable);
            }
            if (st.liteSatKey !== satVal) { st.liteSatKey = satVal; ctx.liteSat.setAttribute('values', satVal); }
            if (st.liteTempKey !== tmk) {
              st.liteTempKey = tmk;
              ctx.liteTmpFuncs[0].setAttribute('slope', rs);
              ctx.liteTmpFuncs[1].setAttribute('slope', gs);
              ctx.liteTmpFuncs[2].setAttribute('slope', bs);
            }
            const liteSharpOn = wantsDetailPass(s);
            const mk = liteSharpOn ? (s.sharp + '|' + s.sharp2 + '|' + s.clarity + '|' + vhKey) : 'off';
            if (st.liteConvKey !== mk) {
              st.liteConvKey = mk;
              if (liteSharpOn) {
                const refH = 1080;
                const pxScale = clamp((vhKey || refH) / refH, 0.5, 2.0);
                const midSharpMul = config.IS_MOBILE ? 0.32 : 0.30;
                const rawS = ((s.sharp || 0) + (s.sharp2 || 0) * 0.55 + (s.clarity || 0) * 0.35) / 50.0;
                const totalS = Math.min(0.60, rawS * midSharpMul * pxScale);
                if (totalS > 0.008) {
                  const center = 1.0 + 4.0 * totalS; const edge = -totalS;
                  ctx.liteConv.setAttribute('kernelMatrix', `0,${edge.toFixed(4)},0, ${edge.toFixed(4)},${center.toFixed(4)},${edge.toFixed(4)}, 0,${edge.toFixed(4)},0`);
                } else {
                  ctx.liteConv.setAttribute('kernelMatrix', '0,0,0, 0,1,0, 0,0,0');
                }
              } else {
                ctx.liteConv.setAttribute('kernelMatrix', '0,0,0, 0,1,0, 0,0,0');
              }
            }
          }
        }

        const fid = useFull ? ctx.fidFull : ctx.fidLite;
        const url = `url(#${fid})`;
        dc.key = key; dc.url = url; return url;
      }

      return {
        prepareCached: (video, s) => {
          try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; }
        },
        applyUrl: (el, url) => {
          if (!el) return;
          const st = getVState(el);
          if (st._inPiP) return;
          if (!url) {
            if (st.applied) {
              el.style.removeProperty('transition'); el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color');
              st.applied = false; st.lastFilterUrl = null;
            }
            return;
          }
          if (st.lastFilterUrl === url && st.applied) return;
          el.style.removeProperty('transition');
          el.style.setProperty('background-color', '#000', 'important');
          el.style.setProperty('filter', url, 'important');
          el.style.setProperty('-webkit-filter', url, 'important');
          st.applied = true; st.lastFilterUrl = url;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied) return;
          el.style.removeProperty('transition'); el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color');
          st.applied = false; st.lastFilterUrl = null;
        }
      };
    }

    const _SHADOW_PRECOMPUTED = (() => {
      const base = [
        { bit: SHADOW_BAND.OUTER, toe: -1.0, mid: -0.010, bright: -0.5, gammaMul: 0.990, contrastMul: 1.015, satMul: 1.005 },
        { bit: SHADOW_BAND.MID,   toe: -1.8, mid: -0.015, bright: -1.0, gammaMul: 0.980, contrastMul: 1.025, satMul: 1.010 },
        { bit: SHADOW_BAND.DEEP,  toe: -3.0, mid: -0.005, bright: -0.5, gammaMul: 0.985, contrastMul: 1.020, satMul: 1.000 }
      ];
      const table = new Array(8);
      for (let mask = 0; mask < 8; mask++) {
        let toeAdd = 0, midAdd = 0, brightAdd = 0, gammaMul = 1, contrastMul = 1, satMul = 1;
        for (const b of base) {
          if ((mask & b.bit) === 0) continue;
          toeAdd += b.toe; midAdd += b.mid; brightAdd += b.bright;
          gammaMul *= b.gammaMul; contrastMul *= b.contrastMul; satMul *= b.satMul;
        }
        table[mask] = { toeAdd, midAdd, brightAdd, gammaMul, contrastMul, satMul };
      }
      return table;
    })();

    const _BRIGHT_STEP = [
      null,
      { brightAdd: 1.8, gammaMul: 1.02, contrastMul: 0.995 },
      { brightAdd: 3.8, gammaMul: 1.05, contrastMul: 0.990 },
      { brightAdd: 6.0, gammaMul: 1.08, contrastMul: 0.985 }
    ];

    function applyShadowBandStack(out, shadowBandMask) {
      const mask = (Number(shadowBandMask) | 0) & 7;
      if (!mask) return out;
      const p = _SHADOW_PRECOMPUTED[mask];
      out.toe = (out.toe || 0) + p.toeAdd;
      out.mid = (out.mid || 0) + p.midAdd;
      out.bright = (out.bright || 0) + p.brightAdd;
      out.gamma = (out.gamma || 1) * p.gammaMul;
      out.contrast = (out.contrast || 1) * p.contrastMul;
      out.satF = (out.satF || 1) * p.satMul;
      return out;
    }

    function applyBrightStepStack(out, brightStepLevel) {
      const lvl = Math.max(0, Math.min(3, Math.round(Number(brightStepLevel) || 0)));
      if (!lvl) return out;
      const s = _BRIGHT_STEP[lvl];
      out.bright = (out.bright || 0) + s.brightAdd;
      out.gamma = (out.gamma || 1) * s.gammaMul;
      out.contrast = (out.contrast || 1) * s.contrastMul;
      return out;
    }

    function composeBaseVideoParams(out, vUser) {
      const dPreset = PRESETS.detail[vUser.presetS] || PRESETS.detail.off;
      const gPreset = PRESETS.grade[vUser.presetB] || PRESETS.grade.off;
      const mix = VSC_CLAMP(Number(vUser.presetMix) || 1, 0, 1);
      const sharpAdd   = (dPreset.sharpAdd  || 0) * mix;
      const sharp2Add  = (dPreset.sharp2Add || 0) * mix;
      const clarityAdd = (dPreset.clarityAdd || 0) * mix;
      const gammaF     = 1 + ((gPreset.gammaF || 1) - 1) * mix;
      const brightAdd  = (gPreset.brightAdd || 0) * mix;
      out.gain     = 1.0;
      out.gamma    = gammaF;
      out.contrast = 1.0;
      out.bright   = brightAdd;
      out.satF     = 1.0;
      out.mid      = 0;
      out.toe      = 0;
      out.shoulder = 0;
      out.temp     = 0;
      out.sharp    = sharpAdd;
      out.sharp2   = sharp2Add;
      out.clarity  = clarityAdd;
      return out;
    }

    function composeVideoParamsInto(out, vUser, autoMods) {
      composeBaseVideoParams(out, vUser);
      applyShadowBandStack(out, vUser.shadowBandMask);
      applyBrightStepStack(out, vUser.brightStepLevel);
      out.gain = (out.gain || 1.0) * autoMods.br;
      out.contrast = (out.contrast || 1.0) * autoMods.ct;
      out.satF = (out.satF || 1.0) * autoMods.sat;
      return out;
    }

    const isNeutralVideoParams = (v) => (
      Math.abs((v.gain ?? 1) - 1) < 0.001 &&
      Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
      Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
      Math.abs((v.bright ?? 0)) < 0.01 &&
      Math.abs((v.satF ?? 1) - 1) < 0.001 &&
      Math.abs((v.mid ?? 0)) < 0.001 &&
      Math.abs((v.sharp ?? 0)) < 0.01 &&
      Math.abs((v.sharp2 ?? 0)) < 0.01 &&
      Math.abs((v.clarity ?? 0)) < 0.01 &&
      Math.abs((v.temp ?? 0)) < 0.01 &&
      Math.abs((v.toe ?? 0)) < 0.01 &&
      Math.abs((v.shoulder ?? 0)) < 0.01
    );

    function createVideoParamsMemo(Store, P, Utils) {
      let lastKey = ''; let lastResult = null;
      const sigVideo = (vf) => [
        vf.presetS, vf.presetB, Number(vf.presetMix).toFixed(3),
        (vf.shadowBandMask|0), (vf.brightStepLevel|0),
      ].join('|');
      return {
        get(vfUser, activeTarget) {
          const w = activeTarget ? (activeTarget.videoWidth || 0) : 0;
          const ht = activeTarget ? (activeTarget.videoHeight || 0) : 0;
          const autoMods = window.__VSC_INTERNAL__?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
          const autoKey = `${autoMods.br.toFixed(3)}|${autoMods.ct.toFixed(3)}|${autoMods.sat.toFixed(3)}`;
          const key = `${sigVideo(vfUser)}|${w}x${ht}|auto:${autoKey}`;
          if (key === lastKey && lastResult) {
            return lastResult;
          }
          const base = {};
          composeVideoParamsInto(base, vfUser, autoMods);
          const svgBase = { ...base };
          svgBase.sharp = Math.min(Number(svgBase.sharp || 0), 36);
          lastResult = svgBase;
          lastKey = key;
          return lastResult;
        }
      };
    }

    const __styleCache = new Map();
    function applyShadowStyle(shadow, cssText, h) { try { if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) { let sheet = __styleCache.get(cssText); if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); __styleCache.set(cssText, sheet); } const cur = shadow.adoptedStyleSheets || []; if (!cur.includes(sheet)) { shadow.adoptedStyleSheets = [...cur, sheet]; } return; } } catch (_) {} const marker = 'data-vsc-style'; let stEl = shadow.querySelector(`style[${marker}="1"]`); if (!stEl) { stEl = h('style', { [marker]: '1' }, cssText); shadow.append(stEl); } else if (stEl.textContent !== cssText) { stEl.textContent = cssText; } }

    function createDisposerBag() { const fns = []; return { add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; }, flush() { for (const fn of fns) { try { fn(); } catch (_) {} } fns.length = 0; } }; }

    function bindWindowDrag(onMove, onEnd) { const ac = new AbortController(); const sig = ac.signal; window.addEventListener('mousemove', onMove, { passive: false, signal: sig }); window.addEventListener('mouseup', end, { signal: sig }); window.addEventListener('touchmove', onMove, { passive: false, signal: sig }); window.addEventListener('touchend', end, { signal: sig }); window.addEventListener('blur', end, { signal: sig }); function end(ev) { try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} } } return () => { try { ac.abort(); } catch (_) {} }; }

    const VSC_ICONS = Object.freeze({
      gear: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
      speaker: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`,
      monitor: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
      zap: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
      pip: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1"/></svg>`,
      zoom: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
      camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
      sparkles: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z"/></svg>`,
      palette: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`
    });

    function svgIcon(name) {
      const span = document.createElement('span');
      span.className = 'icon';
      span.innerHTML = VSC_ICONS[name] || '';
      return span;
    }

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
          if (__osdEl?.isConnected) { try { __osdEl.remove(); } catch (_) {} }
          __osdEl = document.createElement('div'); __osdEl.id = 'vsc-osd';
          __osdEl.style.cssText = `position: fixed; top: 48px; left: 50%; transform: translateX(-50%); background: rgba(18,18,22,0.90); backdrop-filter: blur(20px) saturate(180%); color: rgba(255,255,255,0.92); padding: 10px 24px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.18s ease; box-shadow: 0 8px 32px rgba(0,0,0,0.35); letter-spacing: 0.3px; white-space: pre-line;`;
          try { root.appendChild(__osdEl); } catch (_) { return; }
        }
        __osdEl.textContent = text; __osdEl.style.opacity = '1';
        clearTimeout(__osdEl._timer);
        __osdEl._timer = setTimeout(() => { if (__osdEl) __osdEl.style.opacity = '0'; }, durationMs);
      } catch (_) {}
    }

    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0; const uiWakeCtrl = new AbortController(), bag = createDisposerBag(), sub = (k, fn) => bag.add(sm.sub(k, fn)); const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
      const allowUiInThisDoc = () => { if (registry.videos.size > 0) return true; const hasVideoElements = !!document.querySelector('video, object, embed'); if (hasVideoElements) return true; return false; };
      function setAndHint(path, value) { const prev = sm.get(path); const changed = !Object.is(prev, value); if (changed) sm.set(path, value); (changed ? ApplyReq.hard() : ApplyReq.soft()); }
      function getFullscreenElementSafe() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
      const getUiRoot = () => { const fs = getFullscreenElementSafe(); if (fs) { if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement; return fs; } return document.body || document.documentElement; };
      function bindClassToggle(btn, path, isActive) { const sync = () => { if (btn) btn.classList.toggle('active', isActive(sm.get(path))); }; sub(path, sync); sync(); return sync; }
      function bindStyle(btn, path, apply) { const sync = () => { if (btn) apply(btn, sm.get(path)); }; sub(path, sync); sync(); return sync; }
      function bindRateButtonActive(b, speed, sm, sub, P) { const sync = () => { const isEn = !!sm.get(P.PB_EN); const v = Number(sm.get(P.PB_RATE) || 1); b.classList.toggle('active', isEn && Math.abs(v - speed) < 0.01); }; sub(P.PB_RATE, sync); sub(P.PB_EN, sync); sync(); }
      function renderPresetRow({ items, key, offValue = null, toggleActiveToOff = false }) { const row = h('div', { class: 'row' }); const addBtn = (text, value) => { const b = h('button', { class: 'preset-btn' }, text); b.onclick = () => { const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) { setAndHint(key, offValue); } else { setAndHint(key, value); } }; bindClassToggle(b, key, v => v === value); row.append(b); }; for (const it of items) addBtn(it.text, it.value); if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) { const off = h('button', { class: 'preset-btn', style: 'flex:0.7' }, 'OFF'); off.onclick = () => setAndHint(key, offValue); bindClassToggle(off, key, v => v === offValue); row.append(off); } return row; }
      function renderShadowBandMaskRow({ key = P.V_SHADOW_MASK }) { const row = h('div', { class: 'row' }); const items = [ { text: '외암', bit: SHADOW_BAND.OUTER, title: '옅은 암부 진하게' }, { text: '중암', bit: SHADOW_BAND.MID, title: '가운데 암부 진하게' }, { text: '심암', bit: SHADOW_BAND.DEEP, title: '가장 진한 블랙' } ]; for (const it of items) { const b = h('button', { class: 'preset-btn', title: it.title }, it.text); b.onclick = () => { sm.set(key, ShadowMask.toggle(sm.get(key), it.bit)); ApplyReq.hard(); }; bindClassToggle(b, key, v => ShadowMask.has(v, it.bit)); row.append(b); } const off = h('button', { class: 'preset-btn', style: 'flex:0.7' }, 'OFF'); off.onclick = () => { sm.set(key, 0); ApplyReq.hard(); }; bindClassToggle(off, key, v => (Number(v) | 0) === 0); row.append(off); return row; }

      const build = () => {
        if (container) return;
        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }); const shadow = host.attachShadow({ mode: 'open' });
        const style = `:host{all:initial}*{box-sizing:border-box}.panel{position:fixed;top:50%;right:70px;transform:translateY(-50%);width:300px;background:rgba(18,18,22,0.97);backdrop-filter:blur(16px) saturate(180%);color:#e8e8ec;padding:0;border-radius:14px;z-index:2147483647;border:1px solid rgba(255,255,255,0.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.05) inset;overflow:hidden;max-height:90vh;display:flex;flex-direction:column}.header{padding:14px 16px 12px;cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;gap:8px}.header-title{font-size:13px;font-weight:700;letter-spacing:0.5px;color:rgba(255,255,255,0.9)}.header-info{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500;font-variant-numeric:tabular-nums;flex:1;text-align:center}.header-ver{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500}.tab-bar{display:flex;border-bottom:1px solid rgba(255,255,255,0.06);padding:0 8px}.tab{flex:1;padding:10px 4px 8px;text-align:center;cursor:pointer;border-bottom:2px solid transparent;font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);transition:all 0.15s;user-select:none}.tab:hover{color:rgba(255,255,255,0.6)}.tab.active{color:#60a5fa;border-bottom-color:#3b82f6}.tab-icon{display:block;font-size:16px;margin-bottom:2px}.tab-icon svg{display:inline-block;vertical-align:middle}.tab-content{display:none;padding:10px 12px;overflow-y:auto;flex:1}.tab-content.active{display:block}.drag-indicator{display:none;width:36px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin:8px auto 4px}.section{margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.04)}.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.35);margin-bottom:8px}.row{display:flex;gap:4px;margin-bottom:4px;align-items:center}.row:last-child{margin-bottom:0}.btn{flex:1;height:36px;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.82);cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s ease;display:flex;align-items:center;justify-content:center;gap:4px}.btn:hover{background:rgba(255,255,255,0.12)}.btn:active{transform:scale(0.97)}.btn.active{background:rgba(59,130,246,0.25);border-color:rgba(59,130,246,0.5);color:#60a5fa}.btn.danger{color:#f87171;border-color:rgba(248,113,113,0.3)}.btn.danger:hover{background:rgba(248,113,113,0.15)}.btn.success{color:#4ade80;border-color:rgba(74,222,128,0.3)}.btn-sm{height:30px;font-size:11px}.preset-btn{flex:1;height:32px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.65);cursor:pointer;font-size:11px;font-weight:700;transition:all 0.12s ease}.preset-btn:hover{background:rgba(255,255,255,0.10)}.preset-btn.active{background:rgba(245,158,11,0.20);border-color:rgba(245,158,11,0.5);color:#fbbf24}.speed-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.divider{height:1px;background:rgba(255,255,255,0.04);margin:6px 0}.footer{padding:8px 12px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:4px}.icon{font-size:14px;line-height:1;display:inline-flex;align-items:center}.icon svg{display:block}input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;outline:none;cursor:pointer}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}.speed-display{flex:1;text-align:center;font-size:14px;font-weight:700;color:#e8e8ec;line-height:30px;font-variant-numeric:tabular-nums}@media(max-width:480px){.panel{position:fixed!important;top:auto!important;bottom:0!important;left:0!important;right:auto!important;width:100%!important;max-height:70vh!important;border-radius:14px 14px 0 0!important;transform:none!important;transition:transform 0.3s cubic-bezier(0.32,0.72,0,1)!important}.drag-indicator{display:block}}`;
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
        sub(P.APP_UI, (visible) => { clearInterval(infoTimer); if (visible) { updateVideoInfo(); infoTimer = setInterval(updateVideoInfo, 2000); } });

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
            h('div', { class: 'section-label' }, '블랙 밴드'),
            renderShadowBandMaskRow({ key: P.V_SHADOW_MASK }),
            h('div', { class: 'divider' }),
            h('div', { class: 'section-label' }, '밝기 복구'),
            renderPresetRow({ key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
            h('div', { class: 'divider' }),
            h('div', { class: 'section-label' }, '밝기 등급'),
            renderPresetRow({ key: P.V_PRE_B, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'off').map(k => ({ text: k, value: k })) })
          )
        );
        bindStyle(advContainer, P.APP_ADV, (el, v) => { el.style.display = v ? 'block' : 'none'; });

        const videoSection = h('div', {},
          h('div', { class: 'section' },
            h('div', { class: 'section-label' }, '비디오 효과'),
            renderPresetRow({ key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
            h('div', { class: 'row', style: 'margin-top:6px' },
              (() => { const autoBtn = h('button', { class: 'btn' }); autoBtn.append(svgIcon('sparkles'), document.createTextNode(' Auto')); autoBtn.onclick = () => setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); bindClassToggle(autoBtn, P.APP_AUTO_SCENE, v => !!v); return autoBtn; })()
            )
          ),
          advToggleBtn,
          advContainer
        );

        const audioSection = h('div', {},
          h('div', { class: 'section' },
            h('div', { class: 'section-label' }, '오디오'),
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
            h('div', { class: 'section-label' }, '재생 속도'),
            h('div', { class: 'speed-grid' },
              ...[0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'preset-btn' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }; bindRateButtonActive(b, s, sm, sub, P); return b; })
            ),
            h('div', { class: 'row', style: 'margin-top:6px' },
              (() => { const minusBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.8' }, '\u22120.1'); minusBtn.onclick = () => { const cur = Number(sm.get(P.PB_RATE) || 1); const next = Math.round(VSC_CLAMP(cur - 0.1, 0.1, 16) * 10) / 10; setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }; return minusBtn; })(),
              (() => { const display = h('span', { class: 'speed-display' }); const sync = () => { const rate = sm.get(P.PB_EN) ? Number(sm.get(P.PB_RATE) || 1) : 1; display.textContent = rate.toFixed(1) + 'x'; }; sub(P.PB_RATE, sync); sub(P.PB_EN, sync); sync(); return display; })(),
              (() => { const plusBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.8' }, '+0.1'); plusBtn.onclick = () => { const cur = Number(sm.get(P.PB_RATE) || 1); const next = Math.round(VSC_CLAMP(cur + 0.1, 0.1, 16) * 10) / 10; setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }; return plusBtn; })(),
              (() => { const resetBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.7' }, '1x'); resetBtn.onclick = () => { setAndHint(P.PB_RATE, 1.0); setAndHint(P.PB_EN, false); }; return resetBtn; })()
            )
          )
        );

        const toolsSection = h('div', {},
          h('div', { class: 'section' },
            h('div', { class: 'section-label' }, '도구'),
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v); } }, svgIcon('pip'), ' PiP'),
              (() => {
                const zoomBtn = h('button', { class: 'btn' });
                zoomBtn.append(svgIcon('zoom'), document.createTextNode(' 줌'));
                zoomBtn.onclick = () => {
                  const zm = window.__VSC_INTERNAL__?.ZoomManager;
                  const v = window.__VSC_APP__?.getActiveVideo();
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
            )
          )
        );

        tabContents.video = h('div', { class: `tab-content${activeTabId === 'video' ? ' active' : ''}` }, videoSection);
        tabContents.audio = h('div', { class: `tab-content${activeTabId === 'audio' ? ' active' : ''}` }, audioSection);
        tabContents.speed = h('div', { class: `tab-content${activeTabId === 'speed' ? ' active' : ''}` }, speedSection);
        tabContents.tools = h('div', { class: `tab-content${activeTabId === 'tools' ? ' active' : ''}` }, toolsSection);

        const contentArea = h('div', { style: 'flex:1;overflow-y:auto;' });
        for (const [id, el] of Object.entries(tabContents)) contentArea.append(el);

        const footer = h('div', { class: 'footer' },
          h('button', { class: 'btn btn-sm', onclick: () => sm.set(P.APP_UI, false) }, '\u2715 닫기'),
          (() => { const pwrBtn = h('button', { class: 'btn btn-sm' }); pwrBtn.onclick = () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); bindStyle(pwrBtn, P.APP_ACT, (el, v) => { el.className = 'btn btn-sm ' + (v ? 'success' : 'danger'); el.innerHTML = ''; el.append(svgIcon('zap'), document.createTextNode(v ? ' ON' : ' OFF')); }); return pwrBtn; })(),
          h('button', { class: 'btn btn-sm', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard(); } }, '\u21BA 리셋')
        );

        const mainPanel = h('div', { class: 'panel' }, dragIndicator, dragHandle, tabBar, contentArea, footer);
        blockInterference(mainPanel);

        if (CONFIG.IS_MOBILE) {
          let sheetStartY = 0, sheetDragging = false;
          dragIndicator.addEventListener('touchstart', (e) => { sheetStartY = e.touches[0].clientY; sheetDragging = true; mainPanel.style.transition = 'none'; }, { passive: true });
          window.addEventListener('touchmove', (e) => { if (!sheetDragging) return; const dy = e.touches[0].clientY - sheetStartY; if (dy > 0) mainPanel.style.transform = `translateY(${dy}px)`; }, { passive: true, signal: __globalSig });
          window.addEventListener('touchend', () => { if (!sheetDragging) return; sheetDragging = false; mainPanel.style.transition = ''; const current = parseFloat(mainPanel.style.transform.replace(/[^0-9.\-]/g, '')) || 0; if (current > 100) sm.set(P.APP_UI, false); mainPanel.style.transform = ''; }, { passive: true, signal: __globalSig });
        }

        shadow.append(mainPanel);
        let stopDrag = null;
        dragHandle.addEventListener('mousedown', (e) => { e.preventDefault(); stopDrag?.(); let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect(); mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`; stopDrag = bindWindowDrag((ev) => { const panelRect = mainPanel.getBoundingClientRect(); let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + (ev.clientX - startX))); let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + (ev.clientY - startY))); mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`; }, () => { stopDrag = null; }); });
        container = host; getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) return; if (gearHost) return;
        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:12px;transform:translateY(-50%);width:44px;height:44px;border-radius:12px;background:rgba(18,18,22,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.10);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.4);user-select:none;transition:all 0.15s ease;-webkit-tap-highlight-color:transparent}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.05);background:rgba(30,30,38,0.95)}}.gear:active{transform:translateY(-50%) scale(0.95)}.gear.open{border-color:rgba(59,130,246,0.5);box-shadow:0 0 0 2px rgba(59,130,246,0.2),0 8px 32px rgba(0,0,0,0.4)}.gear.inactive{opacity:0.35}.status-dot{position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:#4ade80;transition:background 0.2s}.gear.inactive .status-dot{background:#f87171}.hint{position:fixed;right:70px;top:50%;transform:translateY(-50%);padding:6px 10px;border-radius:8px;background:rgba(18,18,22,0.92);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transition:opacity 0.15s,transform 0.15s;pointer-events:none}.gear:hover+.hint{opacity:1}${CONFIG.IS_MOBILE ? '.hint{display:none!important;}' : ''}@media(max-width:480px){.gear{right:8px!important;bottom:16px!important;top:auto!important;transform:none!important}}`;
        applyShadowStyle(shadow, style, h); let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear', onclick: (e) => { if (dragThresholdMet) { e.preventDefault(); e.stopPropagation(); return; } setAndHint(P.APP_UI, !sm.get(P.APP_UI)); } });
        gearBtn.innerHTML = VSC_ICONS.gear;
        gearBtn.append(h('div', { class: 'status-dot' }));
        blockInterference(gearBtn);
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.4'; }, 3500); };
        window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal }); window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal }); bootWakeTimer = setTimeout(wake, 2000);
        const handleGearDrag = (e) => { if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY; const rect = gearBtn.getBoundingClientRect(); stopDrag = bindWindowDrag((ev) => { const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY; if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; } }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); }); };
        gearBtn.addEventListener('mousedown', handleGearDrag); gearBtn.addEventListener('touchstart', handleGearDrag, { passive: false });
        const syncGear = () => { if (!gearBtn) return; const showHere = allowUiInThisDoc(); gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); gearBtn.style.display = showHere ? 'block' : 'none'; if (!showHere) detachNodesHard(); else wake(); };
        sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
      };
      const mount = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
      const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; } else { if (container) container.style.display = 'none'; } mount(); };
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => { try { ensure(); ApplyReq.hard(); } catch (_) {} }, { once: true, signal: __globalSig }); }
      if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;
      return { ensure, destroy: () => { try { uiWakeCtrl.abort(); } catch {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); bag.flush(); detachNodesHard(); } };
    }

    function markInternalRateChange(v) { const st = getRateState(v); st.lastSetAt = performance.now(); }
    const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el); el.playbackRate = nextRate; st.orig = null; st.retryCount = 0; st.permanentlyBlocked = false; st.suppressSyncUntil = 0; } catch (_) {} };

    function createBackendAdapter(Filters) {
      return {
        apply(video, vVals) {
          const st = getVState(video);
          if (st._inPiP) return;
          const url = Filters.prepareCached(video, vVals);
          Filters.applyUrl(video, url);
          st.fxBackend = 'svg';
        },
        clear(video) {
          const st = getVState(video);
          Filters.clear(video);
          st.fxBackend = null;
        }
      };
    }

    function ensureMobileInlinePlaybackHints(video) { if (!video) return; try { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', ''); } catch (_) {} }
    const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
    const onEvictVideo = (v) => { try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {} restoreRateOne(v); TOUCHED.rateVideos.delete(v); };
    const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };
    function pruneTouchedDisconnected() { let count = 0; for (const v of TOUCHED.videos) { if (++count > 20) break; if (!v || !v.isConnected) TOUCHED.videos.delete(v); } count = 0; for (const v of TOUCHED.rateVideos) { if (++count > 20) break; if (!v || !v.isConnected) TOUCHED.rateVideos.delete(v); } }

    /* [이식 1] 재생 속도 가드 (Rate Guard) - v200 로직 (재귀 방지 강화) */
    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v); if (st.bound) return; st.bound = true;
      if (CONFIG.IS_MOBILE) ensureMobileInlinePlaybackHints(v);
      const ac = new AbortController();
      st._ac = ac;
      const sig = ac.signal;
      const softResetTransientFlags = () => { st.resetTransient(); ApplyReq.hard(); };
      onAll(v, ['loadstart', 'loadedmetadata', 'emptied'], softResetTransientFlags, { passive: true, signal: sig });
      onAll(v, ['seeking', 'play'], () => { ApplyReq.hard(); }, { passive: true, signal: sig });

      v.addEventListener('enterpictureinpicture', () => {
        st._inPiP = true;
        try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {}
      }, { passive: true, signal: sig });

      v.addEventListener('leavepictureinpicture', () => {
        st._inPiP = false;
        setTimeout(() => { try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, 200);
      }, { passive: true, signal: sig });

      v.addEventListener('ratechange', () => {
        const rSt = getRateState(v);
        const now = performance.now();

        if (now < (rSt.suppressSyncUntil || 0) || (now - (rSt.lastSetAt || 0)) < 500) return;
        if (rSt.permanentlyBlocked) return;
        if (__rateBlockedSite) { rSt.permanentlyBlocked = true; return; }

        const refs = window.__VSC_INTERNAL__;
        const store = refs?.Store;
        if (!store || !store.get(P.PB_EN)) return;

        const desired = st.desiredRate || store.get(P.PB_RATE);
        if (!Number.isFinite(v.playbackRate) || v.playbackRate < 0.07) return;
        if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return;

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
    };

    function createLightSigTracker() {
      let lastTarget = null, lastPb = false, lastRate = 1, lastFx = false;
      return (activeTarget, pbActive, desiredRate, videoFxOn) => {
        if (activeTarget !== lastTarget || pbActive !== lastPb || desiredRate !== lastRate || videoFxOn !== lastFx) {
          lastTarget = activeTarget; lastPb = pbActive; lastRate = desiredRate; lastFx = videoFxOn;
          return true;
        }
        return false;
      };
    }

    const __reconcileCandidates = new Set();
    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el);
      if (st._ac) { try { st._ac.abort(); } catch (_) {} st._ac = null; }
      Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el);
      st.bound = false;
      bindVideoOnce(el, ApplyReq);
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el); const rSt = getRateState(el);
      if (rSt.permanentlyBlocked) return;
      if (__rateBlockedSite) { rSt.permanentlyBlocked = true; return; }
      if (rSt.orig == null) rSt.orig = el.playbackRate;
      const lastDesired = st.desiredRate;
      if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) { st.desiredRate = desiredRate; markInternalRateChange(el); try { el.playbackRate = desiredRate; } catch (_) {} }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }

    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, mainTarget }) {
      const candidates = __reconcileCandidates; candidates.clear();
      for (const v of dirtyVideos) if (v) candidates.add(v);
      for (const v of TOUCHED.videos) if (v) candidates.add(v);
      for (const v of TOUCHED.rateVideos) if (v) candidates.add(v);
      for (const v of applySet) if (v) candidates.add(v);
      for (const el of candidates) {
        if (!el || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el); const visible = (st.visible !== false);
        const isMainTarget = (el === mainTarget);
        const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el) || isMainTarget);
        if (!shouldApply) { clearVideoRuntimeState(el, Adapter, ApplyReq); continue; }
        if (videoFxOn) { Adapter.apply(el, vVals); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
        if (pbActive) applyPlaybackRate(el, desiredRate); else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
        bindVideoOnce(el, ApplyReq);
      }
      candidates.clear();
    }

    function createThrottled(fn, ms = 120) { let last = 0, timer = 0; return (...args) => { const now = performance.now(); if (now - last >= ms) { last = now; fn(...args); return; } if (!timer) { timer = setTimeout(() => { timer = 0; last = performance.now(); fn(...args); }, ms); } }; }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
      Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });
      let __activeTarget = null, __lastAudioTarget = null, __lastAudioWant = null;
      const __applySet = new Set();
      let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;
      const videoParamsMemo = createVideoParamsMemo(Store, P, Utils); const audioUpdateThrottled = createThrottled(() => Audio.update(), 120);
      const lightSigChanged = createLightSigTracker();
      Scheduler.registerApply((force) => {
        try {
          if (document.hidden && !force) return;
          const active = !!Store.getCatRef('app').active;
          if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }
          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
          if (!force && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev;
          const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); pruneTouchedDisconnected(); lastPrune = now; }
          const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
          const wantAudioNow = !!(Store.get(P.A_EN) && active);
          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__lastUserPt, wantAudioNow);
          let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
          if (nextTarget !== __activeTarget) { __activeTarget = nextTarget; }
          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget || wantAudioNow !== __lastAudioWant) { Audio.setTarget(nextAudioTarget); Audio.update(); __lastAudioTarget = nextAudioTarget; __lastAudioWant = wantAudioNow; } else { audioUpdateThrottled(); }
          const vCat = Store.state.video;
          const vfUser = { presetS: vCat.presetS, presetB: vCat.presetB, presetMix: vCat.presetMix, shadowBandMask: vCat.shadowBandMask, brightStepLevel: vCat.brightStepLevel };
          const vValsEffective = videoParamsMemo.get(vfUser, __activeTarget);
          if (CONFIG.DEBUG) { const w = __activeTarget?.videoWidth || 0, ht = __activeTarget?.videoHeight || 0; console.debug('[VSC][ToneCheck]', { shadowBandMask: vfUser.shadowBandMask, brightStepLevel: vfUser.brightStepLevel, size: `${w}x${ht}`, contrast: vValsEffective.contrast, satF: vValsEffective.satF, bright: vValsEffective.bright, gamma: vValsEffective.gamma, sharp: vValsEffective.sharp, temp: vValsEffective.temp }); }
          const videoFxOn = !isNeutralVideoParams(vValsEffective); const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);
          __applySet.clear(); if (applyToAllVisibleVideos) { for (const v of visible.videos) __applySet.add(v); } else if (__activeTarget) { __applySet.add(__activeTarget); }
          const desiredRate = Store.get(P.PB_RATE), pbActive = active && !!Store.get(P.PB_EN);
          if (!force && vidsDirty.size === 0 && !lightSigChanged(__activeTarget, pbActive, desiredRate, videoFxOn)) return;
          reconcileVideoEffects({ applySet: __applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, mainTarget: __activeTarget });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) { log.warn('apply crashed:', e); }
      });
      let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT)) return; if (document.hidden) return; Scheduler.request(false); }, 12000); };
      const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick(); Scheduler.request(true);
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, async destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { Audio.setTarget(null); await Audio.destroy?.(); } catch (_) {} try { __globalHooksAC.abort(); } catch (_) {} } });
    }

    const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
    const ApplyReq = createApplyRequester(Bus, Scheduler); window.__VSC_INTERNAL__.Bus = Bus; window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;
    
    Bus.on('signal', (s) => { if (s && s.forceApply) Scheduler.request(true); });

    const __hasGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
    const __hasGMDelete = (typeof GM_deleteValue === 'function');

    function mergeKnown(target, source) {
      if (!source || typeof source !== 'object') return;
      for (const k of Object.keys(target)) {
        if (k in source && source[k] != null) {
          if (typeof target[k] === 'object' && typeof source[k] === 'object' && !Array.isArray(target[k])) {
            mergeKnown(target[k], source[k]);
          } else {
            target[k] = source[k];
          }
        }
      }
    }

    function buildSaveData(Store, P) {
      return {
        active: Store.get(P.APP_ACT), applyAll: Store.get(P.APP_APPLY_ALL),
        advanced: Store.get(P.APP_ADV),
        presetS: Store.get(P.V_PRE_S), presetB: Store.get(P.V_PRE_B),
        presetMix: Store.get(P.V_PRE_MIX), shadowBandMask: Store.get(P.V_SHADOW_MASK),
        brightStepLevel: Store.get(P.V_BRIGHT_STEP),
        audioEnabled: Store.get(P.A_EN), audioBoost: Store.get(P.A_BST),
        autoScene: Store.get(P.APP_AUTO_SCENE), zoomEn: Store.get(P.APP_ZOOM_EN),
        playbackRate: Store.get(P.PB_RATE), playbackEnabled: Store.get(P.PB_EN)
      };
    }

    function applyDataToStore(data, Store, P) {
      if (!data || typeof data !== 'object') return;
      const safeSet = (path, val) => { try { if (val != null) Store.set(path, val); } catch (_) {} };
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
      safeSet(P.PB_RATE, data.playbackRate);
      safeSet(P.PB_EN, data.playbackEnabled);
    }

    function saveSettings(Store, P) {
      try {
        const data = buildSaveData(Store, P);
        const json = JSON.stringify(data);
        if (__hasGM) {
          try { GM_setValue(STORAGE_KEY, json); } catch (_) {}
        }
        try { localStorage.setItem(STORAGE_KEY, json); } catch (_) {}
      } catch (_) {}
    }

    function loadSettings(Store, P) {
      let data = null;
      if (__hasGM) {
        try {
          const raw = GM_getValue(STORAGE_KEY, null);
          if (raw) {
            try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (_) {}
          }
        } catch (_) {}
      }
      if (!data) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            try { data = JSON.parse(raw); } catch (_) {}
          }
        } catch (_) {}
      }
      if (data && typeof data === 'object') {
        applyDataToStore(data, Store, P);
      }
    }

    function bindNormalizer(keys, schema) { const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); }; keys.forEach(k => Store.sub(k, run)); run(); }

    loadSettings(Store, P);
    normalizeBySchema(Store, APP_SCHEMA);
    normalizeBySchema(Store, VIDEO_SCHEMA);
    normalizeBySchema(Store, AUDIO_PLAYBACK_SCHEMA);

    bindNormalizer([P.APP_APPLY_ALL, P.APP_ZOOM_EN, P.APP_AUTO_SCENE, P.APP_ADV], APP_SCHEMA);
    bindNormalizer([P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_SHADOW_MASK, P.V_BRIGHT_STEP], VIDEO_SCHEMA);
    bindNormalizer([P.A_EN, P.A_BST, P.PB_EN, P.PB_RATE], AUDIO_PLAYBACK_SCHEMA);

    const __saveImpl = () => saveSettings(Store, P);
    const __postTaskBgSave = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function')
      ? () => { globalThis.scheduler.postTask(__saveImpl, { priority: 'background' }).catch(__saveImpl); }
      : __saveImpl;
    const saveDebounced = createDebounced(__postTaskBgSave, 500);
    Store.sub('video.*', saveDebounced); Store.sub('app.*', saveDebounced); Store.sub('audio.*', saveDebounced); Store.sub('playback.*', saveDebounced);

    Store.sub(P.V_PRE_S, (v) => showOSD('샤프닝: ' + (PRESET_LABELS.detail[v] || v)));
    Store.sub(P.V_PRE_B, (v) => showOSD('밝기등급: ' + (PRESET_LABELS.grade[v] || v)));
    Store.sub(P.A_EN, (v) => showOSD('오디오 부스트: ' + (v ? 'ON' : 'OFF')));
    Store.sub(P.PB_RATE, (v) => { if (Store.get(P.PB_EN)) showOSD('재생속도: ' + Number(v).toFixed(1) + 'x'); });
    Store.sub(P.PB_EN, (v) => { if (!v) showOSD('재생속도: 기본'); });

    const Registry = createRegistry(Scheduler), Targeting = createTargeting();
    const rescanDebounced = createDebounced(() => {
      try {
        Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true);
        try { window.__VSC_INTERNAL__?.ZoomManager?.pruneDisconnected(); } catch (_) {}
      } catch (_) {}
    }, SPA_RESCAN_DEBOUNCE_MS);
    initSpaUrlDetector(rescanDebounced);

    waitForVisibility().then(() => {
      (function ensureRegistryAfterBodyReady() {
        let ran = false; const runOnce = () => { if (ran) return; ran = true; try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} };
        if (document.body) { runOnce(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
        document.addEventListener('DOMContentLoaded', runOnce, { once: true, signal: __globalSig });
      })();

      const AutoScene = createAutoSceneManager(Store, P, Scheduler); window.__VSC_INTERNAL__.AutoScene = AutoScene;

      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, IS_MOBILE: CONFIG.IS_MOBILE });
      const Adapter = createBackendAdapter(Filters); window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store);
      let ZoomManager = null; if (FEATURE_FLAGS.zoomFeature) { ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager; }
      const UI = createUI(Store, Registry, ApplyReq, Utils);

      let __gmMenuId = null; const updateGmMenu = () => { if (typeof GM_unregisterMenuCommand === 'function' && __gmMenuId !== null) { try { GM_unregisterMenuCommand(__gmMenuId); } catch (_) {} } if (typeof GM_registerMenuCommand === 'function') { const isAll = !!Store.get(P.APP_APPLY_ALL); try { __gmMenuId = GM_registerMenuCommand('전체 비디오에 적용 : ' + (isAll ? 'ON 🟢' : 'OFF 🔴'), () => { Store.set(P.APP_APPLY_ALL, !isAll); ApplyReq.hard(); }); } catch (_) {} } };
      Store.sub(P.APP_APPLY_ALL, updateGmMenu); updateGmMenu();

      window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }

      function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 50) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} } let __vscLastUserSignalT = 0;

      onWin('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); });
      onWin('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true });

      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__; AutoScene.start();

      Store.sub(P.PB_RATE, (rate) => {
        if (!Store.get(P.PB_EN)) return;
        try {
          if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
            const v = window.__VSC_APP__?.getActiveVideo();
            if (v && Number.isFinite(v.duration) && v.duration > 0) {
              navigator.mediaSession.setPositionState({ duration: v.duration, playbackRate: rate, position: Math.min(v.currentTime, v.duration) });
            }
          }
        } catch (_) {}
      });

      onWin('keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); try { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); } catch (_) {} return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyP') { const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v); return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); const keys = Object.keys(PRESETS.detail); const cur = Store.get(P.V_PRE_S); const idx = keys.indexOf(cur); Store.set(P.V_PRE_S, keys[(idx + 1) % keys.length]); ApplyReq.hard(); return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyC') { e.preventDefault(); const v = __VSC_APP__?.getActiveVideo(); if (v) captureVideoFrame(v); return; }

        /* [보너스] 1프레임 이동 단축키 추가 */
        if (e.altKey && e.shiftKey && e.code === 'Comma') { e.preventDefault(); const v = __VSC_APP__?.getActiveVideo(); if(v){ v.pause(); v.currentTime = Math.max(0, v.currentTime - 1/30); showOSD('◀ 1프레임'); } return; }
        if (e.altKey && e.shiftKey && e.code === 'Period') { e.preventDefault(); const v = __VSC_APP__?.getActiveVideo(); if(v){ v.pause(); v.currentTime = Math.min(v.duration||0, v.currentTime + 1/30); showOSD('1프레임 ▶'); } return; }

        if (e.altKey && e.shiftKey && e.code === 'Slash') { e.preventDefault(); showOSD('Alt+Shift+V: UI | S: 샤프 | A: 오디오 | P: PiP | C: 캡처 | I: 정보 | < >: 1프레임', 3500); return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyI') { e.preventDefault(); const v = __VSC_APP__?.getActiveVideo(); if (!v) { showOSD('활성 비디오 없음'); return; } const w = v.videoWidth, ht = v.videoHeight; const fps = v.getVideoPlaybackQuality?.()?.totalVideoFrames ? Math.round(v.getVideoPlaybackQuality().totalVideoFrames / Math.max(0.1, v.currentTime)) : '?'; const dropped = v.getVideoPlaybackQuality?.()?.droppedVideoFrames ?? '?'; const mode = __liteForced ? 'LITE' : 'FULL'; showOSD(`${w}\u00D7${ht} | ~${fps}fps | drop:${dropped} | ${mode}`, 3000); return; }
        if (e.altKey && e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) { e.preventDefault(); const delta = e.code === 'ArrowUp' ? 0.1 : -0.1; const cur = Number(Store.get(P.PB_RATE) || 1); const next = Math.round(VSC_CLAMP(cur + delta, 0.1, 16) * 10) / 10; Store.set(P.PB_RATE, next); Store.set(P.PB_EN, true); ApplyReq.hard(); showOSD(`속도: ${next.toFixed(1)}x`); return; }
      }, { capture: true });

      (function addPageLifecycleHooks() {
        onWin('freeze', () => { try { window.__VSC_INTERNAL__?.App?.getActiveVideo() && window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { capture: true });
        onWin('pageshow', () => {
          try {
            Registry.refreshObservers();
            Registry.rescanAll();
            window.__VSC_INTERNAL__?.ApplyReq?.hard();
          } catch (_) {}
        }, { capture: true });
        onDoc('visibilitychange', () => {
          try {
            if (document.visibilityState === 'visible') {
              Registry.rescanAll();
              window.__VSC_INTERNAL__?.ApplyReq?.hard();
            }
          } catch (_) {}
        }, { passive: true });
        onWin('resume', () => {
          try {
            Registry.refreshObservers();
            Registry.rescanAll();
            window.__VSC_INTERNAL__?.ApplyReq?.hard();
          } catch (_) {}
        }, { capture: true });
      })();

      if (FEATURE_FLAGS.iframeInjection) { watchIframes(); }
    });
  }

  VSC_MAIN();
})();
