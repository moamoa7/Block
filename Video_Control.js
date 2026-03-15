// ==UserScript==
// @name         Video_Control (v185.0.0)
// @namespace    https://github.com/
// @version      185.0.0
// @description  v184 + param-opt: audio comp/limiter/clip tuning, auto-scene thresholds/tone-params/fps, skin-tone range, preset rebalance, SVG sharp limits, targeting scores, timing adj, mobile zoom UI-guard, tone-curve smooth, color-cast boost, mobile blue-bias
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
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 50;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _activeIntervals.delete(id); return; }
        try { fn(); consecutiveErrors = 0; } catch (_) {
          if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            clearInterval(id); _activeIntervals.delete(id);
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
    /* [v185] 버전 업데이트 */
    const VSC_VERSION = '185.0.0';

    /* [v185] 색보정 강도 상향 (0.20 → 0.25) */
    const COLOR_CAST_CORRECTION = 0.25;

    /* [v185] 모바일 블루 바이어스 보정 (b: 1.00 → 0.97) */
    const MOBILE_COLOR_BIAS = { r: 1.00, g: 1.00, b: 0.97 };

    const STORAGE_KEY = 'vsc_v2_' + location.hostname;

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    /* [v185] 색온도 계수 확대 (0.10 → 0.12) */
    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      const r = 1 + 0.12 * t, g = 1 - 0.04 * Math.abs(t), b = 1 - 0.12 * t;
      const m = Math.max(r, g, b); return { rs: r / m, gs: g / m, bs: b / m };
    }

    const VSC_DEFENSE = Object.freeze({ audioCooldown: true, autoSceneDrmBackoff: true });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true });
    const SHADOW_ROOT_LRU_MAX = 12;
    /* [v185] SPA 리스캔 디바운스 확대 (220 → 280) */
    const SPA_RESCAN_DEBOUNCE_MS = 280;
    /* [v185] 타겟 히스테리시스 확대 (400 → 500) */
    const GUARD = Object.freeze({ AUDIO_SRC_COOLDOWN: 3000, AUDIO_SRC_COOLDOWN_DRM: 8000, TARGET_HYSTERESIS_MS: 500, TARGET_HYSTERESIS_MARGIN: 0.5 });

    const RATE_BLOCKED_HOSTS = Object.freeze(['netflix.com','disneyplus.com','primevideo.com','hulu.com','max.com','peacocktv.com','paramountplus.com','crunchyroll.com']);
    const RATE_BLOCKED_PATHS = Object.freeze([
      { host: 'amazon.com', pathPrefix: '/gp/video' }
    ]);
    function isRateBlockedHost() {
      const h = location.hostname;
      if (RATE_BLOCKED_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
      for (const rule of RATE_BLOCKED_PATHS) {
        if ((h === rule.host || h.endsWith('.' + rule.host)) && location.pathname.startsWith(rule.pathPrefix)) return true;
      }
      return false;
    }
    const __rateBlockedSite = isRateBlockedHost();

    const LITE_FORCED_HOSTS = Object.freeze(['ok.ru', 'mail.ru', 'vk.com', 'dzen.ru', 'rutube.ru']);
    const __liteForced = (() => { const h = location.hostname; return LITE_FORCED_HOSTS.some(d => h === d || h.endsWith('.' + d)); })();

    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1; const log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

    const RATE_TRANSIENT_DEFAULTS = Object.freeze({
      orig: null, lastSetAt: 0, retryCount: 0,
      permanentlyBlocked: false, suppressSyncUntil: 0,
      _externalMtQueued: false, _rateRetryWindow: 0, _rateRetryCount: 0
    });

    function createVideoState() {
      return {
        visible: false, rect: null, bound: false, rateState: null, audioFailUntil: 0, applied: false, desiredRate: undefined, lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false, _resizeDirty: false, _ac: null,
        _inPiP: false,
        lastCssFilterStr: null,
        _transitionCleared: false,
        resetTransient() {
          this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
          if (this.rateState) Object.assign(this.rateState, RATE_TRANSIENT_DEFAULTS);
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

    /* [v185] 프리셋 리밸런스 — detail: 링잉/할로 방지, grade: 클리핑 방지 */
    const PRESETS = Object.freeze({
      detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 12, sharp2Add: 2, clarityAdd: 3 }, M: { sharpAdd: 15, sharp2Add: 8, clarityAdd: 8 }, L: { sharpAdd: 16, sharp2Add: 18, clarityAdd: 14 }, XL: { sharpAdd: 20, sharp2Add: 14, clarityAdd: 18 } },
      grade: { off: { gammaF: 1.00, brightAdd: 0 }, S: { gammaF: 1.02, brightAdd: 1.5 }, M: { gammaF: 1.06, brightAdd: 3.8 }, L: { gammaF: 1.13, brightAdd: 8 }, DS: { gammaF: 1.04, brightAdd: 3.0 }, DM: { gammaF: 1.08, brightAdd: 6.0 }, DL: { gammaF: 1.16, brightAdd: 9.5 } }
    });

    const PRESET_LABELS = Object.freeze({
      detail: { off: 'OFF', S: '1080p', M: '720p', L: '480p', XL: '360p' },
      grade: { off: 'OFF', S: '밝게S', M: '밝게M', L: '밝게L', DS: '암부S', DM: '암부M', DL: '암부L' }
    });

    const DEFAULTS = { video: { presetS: 'off', presetB: 'off', presetMix: 1.0, shadowBandMask: 0, brightStepLevel: 0 }, audio: { enabled: false, boost: 6 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false, autoPreset: false } };
    const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', APP_AUTO_PRESET: 'app.autoPreset', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });

    const APP_SCHEMA = [ { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_AUTO_PRESET } ];
    const VIDEO_SCHEMA = [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB }, { type: 'num', path: P.V_PRE_MIX, min: 0, max: 1, fallback: () => DEFAULTS.video.presetMix }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 }, { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 } ];
    const AUDIO_PLAYBACK_SCHEMA = [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => DEFAULTS.audio.boost }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ];

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
          __globalSig.addEventListener('abort', () => {
            try {
              if (orig && proto.attachShadow === wrappedAttachShadow) {
                Object.defineProperty(proto, 'attachShadow', { ...desc, value: orig });
              }
            } catch (_) {}
          }, { once: true });
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
        if (orig.__vsc_patched) return;
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
      __globalSig.addEventListener('abort', () => {
        for (const name of Object.keys(origHistory)) {
          try {
            if (history[name]?.__vsc_patched && origHistory[name]) {
              history[name] = origHistory[name];
            }
          } catch (_) {}
        }
      }, { once: true });
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
          }, { passive: true, signal: __globalSig });
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
      if (!parent.isConnected || parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        log.debug('Cannot wrap video: parent is fragment or disconnected');
        return null;
      }
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

    /* [v185] restoreFromFsWrapper — 비상 스타일 정리 타이머 3초로 단축 */
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
              const emergencyProps = ['position', 'top', 'left', 'width', 'height', 'z-index', 'background'];
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
              /* [v185] 3초 후 비상 스타일 제거 (was 5000) */
              setTimer(() => {
                if (!video.isConnected) return;
                for (const prop of emergencyProps) {
                  video.style.removeProperty(prop);
                }
              }, 3000);
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
      const origStd = video.requestFullscreen;
      const origWebkit = video.webkitRequestFullscreen;
      if (!origStd && !origWebkit) return;
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
      if (origStd) patchMethodSafe(video, 'requestFullscreen', function (...args) {
        if (this !== video) return origStd.apply(this, args);
        return runWrappedFs.call(this, origStd, ...args);
      });
      if (origWebkit) patchMethodSafe(video, 'webkitRequestFullscreen', function (...args) {
        if (this !== video) return origWebkit.apply(this, args);
        return runWrappedFs.call(this, origWebkit, ...args);
      });
    }

    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl) {
        requestAnimationFrame(() => {
          for (const v of TOUCHED.videos) {
            if (fsWraps.has(v) && v.isConnected) restoreFromFsWrapper(v);
          }
          try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
        });
      }
      if (window.__VSC_UI_Ensure) requestAnimationFrame(() => { try { window.__VSC_UI_Ensure(); } catch (_) {} });
    }
    onDoc('fullscreenchange', onFsChange); onDoc('webkitfullscreenchange', onFsChange);

    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
    function getActivePiPVideo() { if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement; if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo; return null; }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

    function cleanupPipDocumentSvg(pipDoc) {
      try {
        if (!pipDoc) return;
        const svgs = pipDoc.querySelectorAll('svg');
        for (const svg of svgs) {
          if (svg.querySelector('[id^="vsc-"]')) {
            try { svg.remove(); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    /* [v185] enterPiP — Document PiP 필터 재적용 타이머 200ms (was 150) */
    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      try { window.__VSC_INTERNAL__?.Adapter?.clear(video); } catch (_) {}
      const st = getVState(video);
      st.applied = false;
      st.lastFilterUrl = null;
      st.lastCssFilterStr = null;
      if ('documentPictureInPicture' in window && window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        if (__activeDocumentPiPWindow) {
          if (__activeDocumentPiPWindow.closed) {
            resetPiPState();
          } else if (__activeDocumentPiPVideo === video) {
            return true;
          } else {
            try { __activeDocumentPiPWindow.close(); } catch (_) {}
            resetPiPState();
          }
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
            cleanupPipDocumentSvg(pipWindow.document);
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
              st.lastCssFilterStr = null;
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
          setTimer(() => {
            try {
              st.lastFilterUrl = null;
              st.lastCssFilterStr = null;
              st.applied = false;
              window.__VSC_INTERNAL__?.ApplyReq?.hard();
            } catch (_) {}
          }, 200);
          return true;
        } catch (e) { log.debug('Document PiP failed, fallback to video PiP', e); }
      }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') { try { st._inPiP = true; await video.requestPictureInPicture(); return true; } catch (e) { st._inPiP = false; return false; } }
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

    /* [v185] createZoomManager — isVscUiEvent 가드 추가 (모바일 줌 복원 버그 수정) */
    function createZoomManager() {
      const stateMap = new WeakMap();
      let activeVideo = null, isPanning = false, startX = 0, startY = 0;
      let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      const zoomedVideos = new Set();
      let activePointerId = null;
      let destroyed = false;

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
        if (destroyed) return;
        pendingUpdates.add(v);
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (destroyed) return;
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

      /* [v185] isVscUiEvent — VSC UI 요소 위 이벤트 판별 (모바일 줌 복원 핵심 수정) */
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
        if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
        const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null);
        if (cx != null && cy != null) { const els = document.elementsFromPoint(cx, cy); for (const el of els) { if (el?.tagName === 'VIDEO') return el; } }
        return window.__VSC_INTERNAL__?.App?.getActiveVideo() || null;
      }

      /* [v185] wheel — isVscUiEvent 가드 추가 */
      onWin('wheel', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
      }, { passive: false, capture: true });

      /* [v185] pointerdown — isVscUiEvent 가드 추가 */
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

      /* [v185] dblclick — isVscUiEvent 가드 추가 */
      onWin('dblclick', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
      }, { capture: true });

      /* [v185] touchstart — isVscUiEvent 가드 추가 (모바일 줌 복원 핵심) */
      onWin('touchstart', e => {
        if (CONFIG.IS_MOBILE && !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
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
        if (!activeVideo.isConnected) {
          isPanning = false;
          pinchState.active = false;
          activeVideo = null;
          return;
        }
        if (e.touches.length < 2) pinchState.active = false;
        if (e.touches.length === 1 && activeVideo?.isConnected && getSt(activeVideo).scale > 1) {
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
          zoomedVideos.clear();
          isPanning = false; pinchState.active = false;
          activeVideo = null; activePointerId = null;
        }
      };
    }
// ▼▼▼ PART 2에서 이어짐 (createTargeting ~ createAutoSceneManager) ▼▼▼
// ▲▲▲ PART 1에서 이어짐 ▲▲▲
    /* [v185] createTargeting — 타겟팅 점수 최적화 */
    function createTargeting() {
      let stickyTarget = null; let stickyScore = -Infinity; let stickyUntil = 0;
      const SCORE = Object.freeze({
        PLAYING: 6.0, HAS_PROGRESS: 2.0, AREA_SCALE: 1.1,
        AREA_DIVISOR: 15000,
        USER_PROX_MAX: 2.0,
        USER_PROX_DECAY: 2500,
        USER_PROX_RAD_SQ: 722500,
        CENTER_BIAS: 0.7, CENTER_RAD_SQ: 810000,
        AUDIO_BASE: 1.2, AUDIO_BOOST_EXTRA: 1.0,
        PIP_BONUS: 4.0,
        MIN_AREA: 25600
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

    function createLocalStore(defaults, scheduler, Utils) { let rev = 0; const listeners = new Map(); const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch (_) {} } const dot = key.indexOf('.'); if (dot > 0) { const catStar = key.slice(0, dot) + '.*'; const b = listeners.get(catStar); if (b) for (const cb of b) { try { cb(val); } catch (_) {} } } }; const state = Utils.deepClone(defaults); const proxyCache = Object.create(null); const pathCache = Utils.createCappedMap(256); let batchDepth = 0, batchChanged = false; const batchEmits = new Map(); const parsePath = (p) => { let hit = pathCache.get(p); if (hit) return hit; const dot = p.indexOf('.'); hit = (dot < 0) ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; pathCache.set(p, hit); return hit; }; function invalidateProxyBranch(path) { if (!path) return; delete proxyCache[path]; } function flushBatch() { if (!batchChanged) return; const emitsSnapshot = new Map(batchEmits); batchEmits.clear(); batchChanged = false; rev++; for (const [key, val] of emitsSnapshot) { emit(key, val); } scheduler.request(false); } function notifyChange(fullPath, val) { if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; } rev++; emit(fullPath, val); scheduler.request(false); } function createProxyDeep(obj, pathPrefix) { return new Proxy(obj, { get(target, prop) { const value = target[prop]; if (typeof value === 'object' && value !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(value, cacheKey); return proxyCache[cacheKey]; } return value; }, set(target, prop, val) { if (Object.is(target[prop], val)) return true; const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if ((typeof target[prop] === 'object' && target[prop] !== null) || (typeof val === 'object' && val !== null)) { invalidateProxyBranch(fullPath); } target[prop] = val; notifyChange(fullPath, val); return true; } }); } const proxyState = createProxyDeep(state, ''); return { state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat], get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; }, set: (p, val) => { const [c, k] = parsePath(p); if (k == null) { if (typeof state[c] === 'object' && state[c] !== null && typeof val === 'object' && val !== null) { for (const [subK, subV] of Object.entries(val)) proxyState[c][subK] = subV; } else { proxyState[c] = val; } return; } proxyState[c][k] = val; }, batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } catch (e) { log.warn('batch partial error:', e); } finally { batchDepth--; if (batchDepth === 0) { flushBatch(); } } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); } }; }

    function normalizeBySchema(sm, schema) { let changed = false; const setIfDiff = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } }; for (const rule of schema) { const type = rule.type; const path = rule.path; if (type === 'bool') { setIfDiff(path, !!sm.get(path)); continue; } if (type === 'enum') { const cur = sm.get(path); if (!rule.values.includes(cur)) { setIfDiff(path, rule.fallback()); } continue; } if (type === 'num') { let n = Number(sm.get(path)); if (!Number.isFinite(n)) n = rule.fallback(); if (rule.round) n = Math.round(n); n = Math.max(rule.min, Math.min(rule.max, n)); setIfDiff(path, n); continue; } } return changed; }

    /* [v185] createRegistry — IO threshold 0.02, rootMargin 200px */
    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0; const shadowRootsLRU = []; const observedShadowHosts = new WeakSet(); let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }
      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.02, rootMargin: '200px' }) : null;
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

    /* ═══════════════════════════════════════════════════════════
       [v185] createAudio
       — v184 패치 유지 (disconnectAllKnownSources, runAudioLoop halt, visibilitychange)
       — 컴프레서/리미터/클리퍼/메이크업 파라미터 최적화
       ═══════════════════════════════════════════════════════════ */
    function createAudio(sm) {
      let ctx, compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, clipper, analyser, dataArray, target = null, currentSrc = null; let srcMap = new WeakMap(); let makeupDbEma = 0; let switchTimer = 0, switchTok = 0; let gestureHooked = false; let loopTok = 0; let __audioLoopTimer = 0;
      const VSC_AUD_HPF_HZ = 45;
      const VSC_AUD_HPF_Q = 0.707;
      /* [v185] 클리퍼 파라미터 최적화 */
      const VSC_AUD_CLIP_KNEE = 0.92;
      const VSC_AUD_CLIP_DRIVE = 3.5;
      let __vscClipCurve = null;
      function getSoftClipCurve() { if (__vscClipCurve) return __vscClipCurve; const n = 2048; const knee = VSC_AUD_CLIP_KNEE; const drive = VSC_AUD_CLIP_DRIVE; const curve = new Float32Array(n); const tanhD = Math.tanh(drive); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; const ax = Math.abs(x); let y; if (ax <= knee) { y = x; } else { const t = (ax - knee) / Math.max(1e-6, (1 - knee)); const s = Math.tanh(drive * t) / tanhD; y = Math.sign(x) * (knee + (1 - knee) * s); } curve[i] = y; } __vscClipCurve = curve; return curve; }
      const onGesture = async () => {
        try {
          if (ctx && ctx.state === 'suspended') {
            await ctx.resume();
            if (ctx && ctx.state === 'running') {
              updateMix();
            }
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
        const resumeEvents = ['pointerdown', 'keydown', 'touchstart', 'click'];
        for (const evt of resumeEvents) {
          onWin(evt, onGesture, { passive: true, capture: true });
        }
      };
      const clamp = VSC_CLAMP; const VSC_AUDIO_AUTO_MAKEUP = true;

      /* [v185] runAudioLoop — 메이크업 게인 파라미터 최적화 */
      function runAudioLoop(tok) {
        if (tok !== loopTok || !ctx) return;
        if (ctx.state === 'suspended') {
          makeupDbEma = 0;
          return;
        }
        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const actuallyEnabled = en && currentSrc;

        if (document.hidden && !actuallyEnabled) {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
          if (wetInGain) {
            try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); }
            catch (_) { wetInGain.gain.value = 1.0; }
          }
          return;
        }

        if (!actuallyEnabled) {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
          if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
          /* [v185] 루프 간격 최적화 (fg: 80ms) */
          const delay = document.hidden ? 500 : 80;
          clearTimer(__audioLoopTimer);
          __audioLoopTimer = setTimer(() => { __audioLoopTimer = 0; runAudioLoop(tok); }, delay);
          return;
        }
        if (VSC_AUDIO_AUTO_MAKEUP && analyser) {
          analyser.getFloatTimeDomainData(dataArray); let sumSquare = 0; for (let i = 0; i < dataArray.length; i++) { sumSquare += dataArray[i] * dataArray[i]; } const rms = Math.sqrt(sumSquare / dataArray.length); const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100; let redDb = 0; try { const r = compressor?.reduction; redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0; } catch (_) {} if (!Number.isFinite(redDb)) redDb = 0; const redPos = clamp(-redDb, 0, 18);
          /* [v185] 게이트 임계값 최적화 (-50/-44 dB), makeup max 3.5, reduction mul 0.35, attack alpha 0.25 */
          let gateMult = 1.0;
          if (db < -50) { gateMult = 0.0; }
          else if (db < -44) { gateMult = (db - (-50)) / 6.0; }
          const makeupDbTarget = clamp(Math.max(0, redPos - 1.5) * 0.35, 0, 3.5) * gateMult;
          const isAttack = makeupDbTarget < makeupDbEma;
          const alpha = isAttack ? 0.25 : 0.015;
          makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
        } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
        const boostDb = Number(sm.get(P.A_BST) || 0);
        const userBoost = Math.pow(10, boostDb / 20);
        const makeup = Math.pow(10, makeupDbEma / 20);
        if (wetInGain) { const finalGain = userBoost * makeup; try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; } }
        const delay = document.hidden ? 500 : 80;
        clearTimer(__audioLoopTimer);
        __audioLoopTimer = setTimer(() => { __audioLoopTimer = 0; runAudioLoop(tok); }, delay);
      }
      const resetCtx = () => { ctx = null; compressor = null; limiter = null; wetInGain = null; dryOut = null; wetOut = null; masterOut = null; hpf = null; clipper = null; analyser = null; dataArray = null; currentSrc = null; target = null; };
      /* [v185] buildAudioGraph — 컴프레서/리미터 파라미터 최적화 */
      const buildAudioGraph = () => {
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 8;
        compressor.ratio.value = 4.0;
        compressor.attack.value = 0.012;
        compressor.release.value = 0.20;
        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2.0;
        limiter.knee.value = 1.0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0015;
        limiter.release.value = 0.12;
        hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = VSC_AUD_HPF_HZ; hpf.Q.value = VSC_AUD_HPF_Q;
        clipper = ctx.createWaveShaper(); clipper.curve = getSoftClipCurve(); try { clipper.oversample = '2x'; } catch (_) {}
        analyser = ctx.createAnalyser(); analyser.fftSize = 2048; dataArray = new Float32Array(analyser.fftSize);
        dryOut = ctx.createGain(); wetOut = ctx.createGain(); wetInGain = ctx.createGain(); masterOut = ctx.createGain();
        dryOut.connect(masterOut); wetOut.connect(masterOut);
        hpf.connect(compressor); hpf.connect(analyser);
        compressor.connect(wetInGain); wetInGain.connect(limiter); limiter.connect(clipper); clipper.connect(wetOut);
        masterOut.connect(ctx.destination);
      };

      const disconnectAllKnownSources = () => {
        for (const v of TOUCHED.videos) {
          try { const s = srcMap.get(v); if (s) { s.disconnect(); srcMap.delete(v); } } catch (_) {}
        }
        for (const v of TOUCHED.rateVideos) {
          try { const s = srcMap.get(v); if (s) { s.disconnect(); srcMap.delete(v); } } catch (_) {}
        }
      };

      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') {
          disconnectAllKnownSources();
          srcMap = new WeakMap();
          if (target) { const tst = getVState(target); tst.audioFailUntil = 0; }
          for (const v of TOUCHED.videos) {
            const vst = videoStateMap.get(v);
            if (vst) vst.audioFailUntil = 0;
          }
          resetCtx();
        }
        if (ctx) return true;
        disconnectAllKnownSources();
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

      onDoc('visibilitychange', () => {
        if (document.visibilityState === 'visible' && ctx && ctx.state === 'running' && currentSrc) {
          loopTok++;
          runAudioLoop(loopTok);
        }
      }, { passive: true });

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
        disconnectAllKnownSources();
        srcMap = new WeakMap();
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        resetCtx();
        makeupDbEma = 0;
      }
      return { setTarget: (v) => { const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); const st = v ? getVState(v) : null; if (st && st.audioFailUntil > performance.now()) { if (v !== target) { fadeOutThen(() => { disconnectAll(); target = v; }); } updateMix(); return; } if (!ensureCtx()) return; if (v && ctx?.state === 'suspended' && !v.paused) { ctx.resume().catch(() => {}); } if (v === target) { updateMix(); return; } fadeOutThen(() => { disconnectAll(); target = v; if (!v) { updateMix(); return; } try { let s = srcMap.get(v); if (!s) { try { s = ctx.createMediaElementSource(v); } catch (e) { if (e.name === 'InvalidStateError') { log.debug('MediaElementSource already exists for this element, marking cooldown'); const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN; if (st && VSC_DEFENSE.audioCooldown) { st.audioFailUntil = performance.now() + cooldown; } disconnectAll(); updateMix(); return; } throw e; } srcMap.set(v, s); } if (s.context !== ctx) { srcMap.delete(v); const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN; if (st && VSC_DEFENSE.audioCooldown) { st.audioFailUntil = performance.now() + cooldown; } disconnectAll(); updateMix(); return; } s.connect(dryOut); s.connect(hpf || compressor); currentSrc = s; } catch (e) { log.warn('Audio source connection failed:', e); const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN; if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + cooldown; disconnectAll(); } updateMix(); }); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
    }

    // === AUTO SCENE V3 ===
    /* ═══════════════════════════════════════════════════════════
       [v185] createAutoSceneManager
       — v184 패치 유지 (RVFC ref, globalSig abort, cleanupScheduler)
       — 캔버스 80×45, isSkinTone 범위 확대, classifyScene 임계값 조정
       — SCENE_TONE_PARAMS 전면 재조정, temporal/FPS 최적화
       — buildAdaptiveToneCurve shadow/highlight/midtone + 3-point smoothing
       — computeChannelBalance rMul/clamp 조정
       — DRM 재시도 3회, backoff 8초
       ═══════════════════════════════════════════════════════════ */

function createAutoSceneManager(Store, P, Scheduler) {
  const clamp = VSC_CLAMP;
  const approach = (cur, tgt, a, dead = 0.001) => {
    const d = tgt - cur;
    return Math.abs(d) < dead ? tgt : cur + d * a;
  };

  const HIST_BINS = 256;
  const TONE_STEPS = 256;
  /* [v185] 캔버스 해상도 확대 (64×36 → 80×45) */
  const CANVAS_W = 80, CANVAS_H = 45;
  const ZONE_COLS = 3, ZONE_ROWS = 3, ZONE_COUNT = 9;

  const ST = Object.freeze({
    NORMAL: 0, LOW_KEY: 1, HIGH_KEY: 2, HIGH_CONTRAST: 3,
    LOW_SAT: 4, SKIN: 5, BACKLIT: 6
  });
  const ST_NAMES = ['NORMAL','LOW_KEY','HIGH_KEY','HI_CONT','LOW_SAT','SKIN','BACKLIT'];

  /* [v185] isSkinTone — 다크 스킨 감지 범위 확대 */
  function isSkinTone(r, g, b) {
    if (r <= g || r <= b) return false;
    if (r < 80) return false;
    if (g < 35) return false;
    if (b < 20) return false;
    return (r - g) > 12;
  }

  /* [v185] buildAdaptiveToneCurve — shadow/highlight 범위 확대, midtone sigma 확대, 3-point smoothing 추가 */
  function buildAdaptiveToneCurve(hist, totalSamples, params) {
    const {
      clipLimit = 2.5,
      shadowProtect = 0.4,
      highlightProtect = 0.3,
      midtoneBoost = 0.0,
      targetMean = 0.45,
      strength = 0.35,
    } = params;

    const n = Math.max(1, totalSamples);
    const bins = HIST_BINS;

    const clipped = new Float64Array(bins);
    const limit = (n / bins) * clipLimit;
    let excess = 0;
    for (let i = 0; i < bins; i++) {
      if (hist[i] > limit) {
        excess += hist[i] - limit;
        clipped[i] = limit;
      } else {
        clipped[i] = hist[i];
      }
    }
    const perBin = excess / bins;
    for (let i = 0; i < bins; i++) clipped[i] += perBin;

    const cdf = new Float64Array(bins);
    cdf[0] = clipped[0];
    for (let i = 1; i < bins; i++) cdf[i] = cdf[i - 1] + clipped[i];
    const cdfMin = cdf[0];
    const cdfRange = Math.max(1, cdf[bins - 1] - cdfMin);

    const equalized = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      equalized[i] = (cdf[i] - cdfMin) / cdfRange;
    }

    const identity = new Float64Array(bins);
    for (let i = 0; i < bins; i++) identity[i] = i / (bins - 1);

    const raw = new Float64Array(TONE_STEPS);
    for (let i = 0; i < TONE_STEPS; i++) {
      const x = i / (TONE_STEPS - 1);
      const bin = Math.min(bins - 1, (x * (bins - 1)) | 0);
      const eq = equalized[bin];
      const id = identity[bin];

      let regionWeight = 1.0;
      /* [v185] shadow 0.18, highlight 0.82 */
      if (x < 0.18) {
        const t = x / 0.18;
        regionWeight = 1.0 - shadowProtect * (1 - t * t);
      } else if (x > 0.82) {
        const t = (x - 0.82) / 0.18;
        regionWeight = 1.0 - highlightProtect * (t * t);
      }

      let midBoost = 0;
      if (Math.abs(midtoneBoost) > 0.001) {
        /* [v185] midtone sigma 0.14 */
        const midW = Math.exp(-((x - 0.5) * (x - 0.5)) / (2 * 0.14 * 0.14));
        midBoost = midtoneBoost * midW * 0.15;
      }

      const effectiveStrength = strength * regionWeight;
      let y = id * (1 - effectiveStrength) + eq * effectiveStrength + midBoost;

      raw[i] = clamp(y, 0, 1);
    }

    /* [v185] 3-point smoothing 후 단조성 강제 — 계단 아티팩트 제거 */
    const curve = new Float64Array(TONE_STEPS);
    curve[0] = raw[0];
    curve[TONE_STEPS - 1] = raw[TONE_STEPS - 1];
    for (let i = 1; i < TONE_STEPS - 1; i++) {
      curve[i] = raw[i] * 0.6 + (raw[i - 1] + raw[i + 1]) * 0.2;
    }

    for (let i = 1; i < TONE_STEPS; i++) {
      if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1];
    }

    return curve;
  }

  /* [v185] computeChannelBalance — rMul 0.45, rGain clamp [0.90, 1.10] */
  function computeChannelBalance(rHist, gHist, bHist, totalSamples, skinRatio) {
    const n = Math.max(1, totalSamples);
    let rMean = 0, gMean = 0, bMean = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      const v = i / (HIST_BINS - 1);
      rMean += v * rHist[i];
      gMean += v * gHist[i];
      bMean += v * bHist[i];
    }
    rMean /= n; gMean /= n; bMean /= n;

    const avgMean = (rMean + gMean + bMean) / 3;
    if (avgMean < 0.01) return { rGain: 1, gGain: 1, bGain: 1 };

    const correctionStrength = typeof COLOR_CAST_CORRECTION !== 'undefined' ? COLOR_CAST_CORRECTION : 0.25;

    const skinDampen = VSC_CLAMP(skinRatio || 0, 0, 0.4) / 0.4;
    const rMul = 0.45 * (1 - skinDampen * 0.6);

    const rGain = 1 + (avgMean / Math.max(0.01, rMean) - 1) * (correctionStrength * rMul);
    const gGain = 1 + (avgMean / Math.max(0.01, gMean) - 1) * (correctionStrength * 0.80);
    const bGain = 1 + (avgMean / Math.max(0.01, bMean) - 1) * correctionStrength;

    let finalRG = VSC_CLAMP(rGain, 0.90, 1.10);
    let finalGG = VSC_CLAMP(gGain, 0.94, 1.06);
    let finalBG = VSC_CLAMP(bGain, 0.85, 1.15);

    if (CONFIG.IS_MOBILE && typeof MOBILE_COLOR_BIAS !== 'undefined') {
      finalRG *= MOBILE_COLOR_BIAS.r;
      finalGG *= MOBILE_COLOR_BIAS.g;
      finalBG *= MOBILE_COLOR_BIAS.b;

      finalRG = VSC_CLAMP(finalRG, 0.85, 1.15);
      finalBG = VSC_CLAMP(finalBG, 0.85, 1.20);
    }

    return {
      rGain: finalRG,
      gGain: finalGG,
      bGain: finalBG
    };
  }

  /* [v185] classifyScene — 임계값 전면 재조정 */
  function classifyScene(stats, zoneStats) {
    if (zoneStats) {
      const centerBr = zoneStats.centerBright;
      const edgeBr = zoneStats.edgeAvgBright;
      if (edgeBr > 0.48 && centerBr < 0.38 && (edgeBr - centerBr) > 0.14) {
        return ST.BACKLIT;
      }
    }
    if (stats.skinRatio > 0.08) return ST.SKIN;
    if (stats.bright < 0.25 && stats.contrast < 0.18) return ST.LOW_KEY;
    if (stats.bright > 0.68) return ST.HIGH_KEY;
    if (stats.contrast > 0.32) return ST.HIGH_CONTRAST;
    if (stats.chroma < 0.06) return ST.LOW_SAT;
    return ST.NORMAL;
  }

  /* [v185] SCENE_TONE_PARAMS — 장면별 파라미터 전면 재조정 */
  const SCENE_TONE_PARAMS = Object.freeze({
    [ST.NORMAL]:        { clipLimit: 2.5, shadowProtect: 0.35, highlightProtect: 0.30, midtoneBoost: 0.03, strength: 0.22, satTarget: 1.04 },
    [ST.LOW_KEY]:       { clipLimit: 3.0, shadowProtect: 0.45, highlightProtect: 0.20, midtoneBoost: 0.08, strength: 0.32, satTarget: 1.03 },
    [ST.HIGH_KEY]:      { clipLimit: 2.0, shadowProtect: 0.25, highlightProtect: 0.60, midtoneBoost: -0.03, strength: 0.20, satTarget: 1.04 },
    [ST.HIGH_CONTRAST]: { clipLimit: 1.8, shadowProtect: 0.45, highlightProtect: 0.45, midtoneBoost: 0.0, strength: 0.18, satTarget: 1.02 },
    [ST.LOW_SAT]:       { clipLimit: 2.5, shadowProtect: 0.35, highlightProtect: 0.30, midtoneBoost: 0.03, strength: 0.28, satTarget: 1.12 },
    [ST.SKIN]:          { clipLimit: 2.0, shadowProtect: 0.45, highlightProtect: 0.40, midtoneBoost: 0.01, strength: 0.14, satTarget: 1.02 },
    [ST.BACKLIT]:       { clipLimit: 3.5, shadowProtect: 0.15, highlightProtect: 0.55, midtoneBoost: 0.10, strength: 0.35, satTarget: 1.05 },
  });

  let prevToneCurve = null;
  let prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 };
  let prevSatMul = 1.0;

  function interpolateCurves(prev, next, alpha) {
    if (!prev) return next;
    const out = new Float64Array(TONE_STEPS);
    for (let i = 0; i < TONE_STEPS; i++) {
      out[i] = prev[i] + (next[i] - prev[i]) * alpha;
    }
    return out;
  }

  function interpolateGains(prev, next, alpha) {
    return {
      rGain: prev.rGain + (next.rGain - prev.rGain) * alpha,
      gGain: prev.gGain + (next.gGain - prev.gGain) * alpha,
      bGain: prev.bGain + (next.bGain - prev.bGain) * alpha,
    };
  }

  /* [v185] CUT_HIST_LEN 20 */
  const CUT_HIST_LEN = 20;
  const cutScores = [];
  const gradualScores = [];

  /* [v185] detectTransition — cutThr min 0.10, multiplier 1.25, gradual 3.5 */
  function detectTransition(stats, prev) {
    if (!prev) return { isCut: false, isFade: false };
    const score =
      Math.abs(stats.bright - prev.bright) * 1.3 +
      Math.abs(stats.contrast - prev.contrast) * 0.7 +
      Math.abs(stats.chroma - prev.chroma) * 0.5 +
      Math.abs(stats.edge - prev.edge) * 0.3;

    cutScores.push(score);
    if (cutScores.length > CUT_HIST_LEN) cutScores.shift();

    const sorted = cutScores.slice().sort((a, b) => a - b);
    const q90 = sorted[Math.floor(sorted.length * 0.90)] || 0.15;
    const cutThr = Math.max(0.10, Math.min(0.28, q90 * 1.25));
    const isCut = score > cutThr;

    gradualScores.push(score);
    if (gradualScores.length > 10) gradualScores.shift();
    const gradualSum = gradualScores.reduce((a, b) => a + b, 0);
    const isFade = !isCut && gradualSum > cutThr * 3.5 && gradualScores.length >= 6;

    return { isCut, isFade, score };
  }

  let flickerCount = 0, lastCurveDir = 0;
  /* [v185] getTemporalAlpha — cut 0.40, normal 0.05 */
  function getTemporalAlpha(isCut, isFade) {
    const base = isCut ? 0.40 : (isFade ? 0.10 : 0.05);
    const dampen = 1 / (1 + flickerCount * 0.4);
    return base * dampen;
  }

  function computeFullAnalysis(data, sw, sh) {
    const step = 2;
    let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0, skinCount = 0;

    const lumHist = new Uint32Array(HIST_BINS);
    const rHist = new Uint32Array(HIST_BINS);
    const gHist = new Uint32Array(HIST_BINS);
    const bHist = new Uint32Array(HIST_BINS);

    const zoneW = Math.floor(sw / ZONE_COLS);
    const zoneH = Math.floor(sh / ZONE_ROWS);
    const zones = new Array(ZONE_COUNT);
    for (let z = 0; z < ZONE_COUNT; z++) zones[z] = { sum: 0, count: 0 };

    for (let y = 0; y < sh; y += step) {
      const row = y * sw;
      for (let x = 0; x < sw; x += step) {
        const idx = (row + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const l = (r * 0.2126 + g * 0.7152 + b * 0.0722) | 0;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);

        sumChroma += (mx - mn);
        sum += l; sum2 += l * l; count++;

        const lBin = Math.min(255, l);
        lumHist[lBin]++;
        rHist[Math.min(255, r)]++;
        gHist[Math.min(255, g)]++;
        bHist[Math.min(255, b)]++;

        if (x + step < sw) {
          const ni = idx + step * 4;
          if (ni + 2 < data.length) {
            const l2 = (data[ni] * 0.2126 + data[ni + 1] * 0.7152 + data[ni + 2] * 0.0722) | 0;
            sumEdge += Math.abs(l2 - l);
          }
        }

        if (isSkinTone(r, g, b)) skinCount++;

        const zx = Math.min(ZONE_COLS - 1, (x / zoneW) | 0);
        const zy = Math.min(ZONE_ROWS - 1, (y / zoneH) | 0);
        const zi = zy * ZONE_COLS + zx;
        zones[zi].sum += l; zones[zi].count++;
      }
    }

    const n = Math.max(1, count);
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, (sum2 / n) - mean * mean));

    const centerZone = zones[4];
    const centerBright = centerZone.count > 0 ? centerZone.sum / centerZone.count / 255 : mean / 255;

    let edgeSum = 0, edgeCount = 0;
    for (let z = 0; z < ZONE_COUNT; z++) {
      if (z === 4) continue;
      if (zones[z].count > 0) {
        edgeSum += zones[z].sum / zones[z].count;
        edgeCount++;
      }
    }
    const edgeAvgBright = edgeCount > 0 ? edgeSum / edgeCount / 255 : mean / 255;

    return {
      bright: mean / 255,
      contrast: std / 64,
      chroma: sumChroma / n / 255,
      edge: sumEdge / n,
      motion: 0,
      skinRatio: skinCount / n,
      centerBright,
      edgeAvgBright,
      lumHist, rHist, gHist, bHist,
      totalSamples: count,
      zoneStats: { zones, centerBright, edgeAvgBright }
    };
  }

  /* [v185] curveToApproxParams — clamp 범위 재조정 */
  function curveToApproxParams(curve, satMul, channelGains) {
    const mid = curve[128];
    let gamma = 1.0;
    if (mid > 0.01 && mid < 0.99) {
      gamma = Math.log(mid) / Math.log(0.5);
      gamma = clamp(gamma, 0.65, 1.6);
    }

    const slope = (curve[160] - curve[96]) / ((160 - 96) / 255);
    const contrast = clamp(slope, 0.75, 1.35);

    let brightDiff = 0;
    for (let i = 0; i < 256; i++) {
      brightDiff += curve[i] - (i / 255);
    }
    brightDiff /= 256;
    const bright = clamp(brightDiff * 45, -12, 12);

    const tempEstimate = (channelGains.rGain - channelGains.bGain) * 50;
    const temp = clamp(tempEstimate, -30, 30);

    return {
      br: clamp(1.0 + bright * 0.008, 0.90, 1.30),
      ct: clamp(contrast, 0.80, 1.30),
      sat: clamp(satMul, 0.85, 1.45),
      _gamma: gamma,
      _bright: bright,
      _temp: temp,
      _channelGains: channelGains,
      _toneCurve: curve
    };
  }

  /* [v185] AUTO — canvasW/H 80/45, statsAlpha 0.08, minFps 1.0, maxFps 6, boostMs 700 */
  const AUTO = {
    running: false, canvasW: CANVAS_W, canvasH: CANVAS_H,
    cur: { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null },
    lastStats: null, statsEma: null, statsAlpha: 0.08,
    motionEma: 0, motionAlpha: 0.25, motionThresh: 0.005, motionFrames: 0,
    drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0,
    boostMs: 700, fpsHist: [], minFps: 1.0, maxFps: 6, curFps: 2,
    _sceneType: ST.NORMAL, _sceneStable: 0, _sceneTypeEma: ST.NORMAL,
    _lastMean: 0,
  };

  /* [v185] DRM 최대 재시도 3회 */
  let drmRetryCount = 0;
  const MAX_DRM_RETRIES = 3;

  const cv = document.createElement('canvas');
  cv.width = CANVAS_W; cv.height = CANVAS_H;
  let ctx = null;
  try { ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false }); }
  catch (_) { try { ctx = cv.getContext('2d', { willReadFrequently: true }); } catch (__) {} }

  let __asRvfcId = 0;
  let __asRvfcVideo = null;
  let __asTimeoutId = 0;

  function scheduleNext(v, delayMs) {
    if (!AUTO.running || __globalSig.aborted) return;

    if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; }

    if (__asRvfcId && __asRvfcVideo &&
        typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') {
      try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
      __asRvfcId = 0;
      __asRvfcVideo = null;
    }

    const useRvfc = v && !v.paused &&
                    typeof v.requestVideoFrameCallback === 'function';
    const RVFC_THRESHOLD = 200;

    if (delayMs > RVFC_THRESHOLD) {
      const waitMs = delayMs - (useRvfc ? 80 : 0);
      __asTimeoutId = setTimer(() => {
        __asTimeoutId = 0;
        if (!AUTO.running || __globalSig.aborted) return;
        if (useRvfc) {
          __asRvfcVideo = v;
          __asRvfcId = v.requestVideoFrameCallback(() => {
            __asRvfcId = 0;
            __asRvfcVideo = null;
            loop();
          });
        } else {
          loop();
        }
      }, Math.max(16, waitMs));
      return;
    }

    if (useRvfc) {
      const target = performance.now() + Math.max(0, delayMs | 0);
      __asRvfcVideo = v;
      __asRvfcId = v.requestVideoFrameCallback(() => {
        __asRvfcId = 0;
        __asRvfcVideo = null;
        const remain = target - performance.now();
        if (remain > 6) { scheduleNext(v, remain); return; }
        loop();
      });
      return;
    }

    __asTimeoutId = setTimer(loop, Math.max(16, delayMs | 0));
  }

  function adaptiveFps(changeScore, isCut, isFade) {
    AUTO.fpsHist.push(changeScore);
    if (AUTO.fpsHist.length > 6) AUTO.fpsHist.shift();
    const avg = AUTO.fpsHist.reduce((a, b) => a + b, 0) / AUTO.fpsHist.length;
    let target = avg < 0.05 ? 2 : (avg < 0.15 ? 3 + avg / 0.15 * 2 : 5 + Math.min((avg - 0.15) / 0.3, 1) * 3);
    if (isCut) target = AUTO.maxFps;
    else if (isFade) target = Math.max(target, 5);
    AUTO.curFps += clamp(target - AUTO.curFps, -1.5, 1.5);
    return clamp(AUTO.curFps, AUTO.minFps, AUTO.maxFps);
  }

  function loop() {
    if (!AUTO.running || __globalSig.aborted) return;
    const now = performance.now();
    const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
    const v = window.__VSC_APP__?.getActiveVideo?.();

    if (!en) {
      AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
      prevToneCurve = null;
      scheduleNext(v, 500);
      return;
    }
    if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; }
    if (document.hidden) { scheduleNext(v, 2000); return; }
    if (!v || !ctx || v.paused || v.seeking || v.readyState < 2) {
      try { Scheduler.request(true); } catch (_) {}
      scheduleNext(v, 300);
      return;
    }

    try {
      if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }
      ctx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H);
      const img = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      AUTO.drmBlocked = false;
      drmRetryCount = 0;

      const stats = computeFullAnalysis(img.data, CANVAS_W, CANVAS_H);
      stats.motion = Math.abs(stats.bright - (AUTO._lastMean || stats.bright));
      AUTO._lastMean = stats.bright;

      AUTO.motionEma = AUTO.motionEma * (1 - AUTO.motionAlpha) + stats.motion * AUTO.motionAlpha;
      AUTO.motionFrames = AUTO.motionEma >= AUTO.motionThresh ? AUTO.motionFrames + 1 : 0;

      const transition = detectTransition(stats, AUTO.lastStats);
      AUTO.lastStats = stats;

      if (!AUTO.statsEma) AUTO.statsEma = { ...stats };
      else {
        const a = transition.isCut ? 0.40 : AUTO.statsAlpha;
        const e = AUTO.statsEma;
        for (const k of ['bright','contrast','chroma','edge','skinRatio','centerBright','edgeAvgBright']) {
          e[k] = (e[k] ?? stats[k]) * (1 - a) + stats[k] * a;
        }
      }

      const newScene = classifyScene(AUTO.statsEma, stats.zoneStats);
      if (newScene === AUTO._sceneType) AUTO._sceneStable++;
      else AUTO._sceneStable = 0;
      AUTO._sceneType = newScene;
      /* [v185] sceneStable 임계값 4 */
      if (AUTO._sceneStable >= 4) AUTO._sceneTypeEma = newScene;

      if (transition.isCut) {
        AUTO.tBoostStart = now;
        AUTO.tBoostUntil = now + AUTO.boostMs;
        flickerCount = Math.max(0, flickerCount - 2);
      }

      const allowUpdate = transition.isCut || transition.isFade || AUTO.motionFrames >= 4;

      let fps = AUTO.curFps;
      if (allowUpdate) {
        fps = adaptiveFps(stats.motion, transition.isCut, transition.isFade);
        if (now < AUTO.tBoostUntil) fps = Math.max(fps, transition.isCut ? AUTO.maxFps : 5);

        const sceneType = AUTO._sceneTypeEma;
        const toneParams = { ...SCENE_TONE_PARAMS[sceneType] };

        const rawCurve = buildAdaptiveToneCurve(
          stats.lumHist, stats.totalSamples, toneParams
        );

        const rawGains = computeChannelBalance(
          stats.rHist, stats.gHist, stats.bHist, stats.totalSamples, stats.skinRatio
        );

        const rawSat = toneParams.satTarget;

        const alpha = getTemporalAlpha(transition.isCut, transition.isFade);

        const newMid = rawCurve[128];
        const oldMid = prevToneCurve ? prevToneCurve[128] : 0.5;
        const dir = newMid > oldMid ? 1 : (newMid < oldMid ? -1 : 0);
        if (dir !== 0 && dir !== lastCurveDir && lastCurveDir !== 0) {
          flickerCount = Math.min(flickerCount + 1, 8);
        } else if (dir !== 0) {
          flickerCount = Math.max(0, flickerCount - 0.3);
        }
        lastCurveDir = dir || lastCurveDir;

        const smoothedCurve = interpolateCurves(prevToneCurve, rawCurve, alpha);
        const smoothedGains = interpolateGains(prevChannelGains, rawGains, alpha);
        const smoothedSat = prevSatMul + (rawSat - prevSatMul) * alpha;

        prevToneCurve = smoothedCurve;
        prevChannelGains = smoothedGains;
        prevSatMul = smoothedSat;

        const result = curveToApproxParams(smoothedCurve, smoothedSat, smoothedGains);

        const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat;
        AUTO.cur.br = result.br;
        AUTO.cur.ct = result.ct;
        AUTO.cur.sat = result.sat;
        AUTO.cur._toneCurve = smoothedCurve;
        AUTO.cur._channelGains = smoothedGains;
        AUTO.cur._gamma = result._gamma;
        AUTO.cur._bright = result._bright;
        AUTO.cur._temp = result._temp;

        if (Math.abs(prevBr - AUTO.cur.br) > 0.001 ||
            Math.abs(prevCt - AUTO.cur.ct) > 0.001 ||
            Math.abs(prevSat - AUTO.cur.sat) > 0.001) {
          Scheduler.request(true);
        }
      }

      scheduleNext(v, Math.max(100, Math.round(1000 / Math.max(1, fps))));

    } catch (e) {
      const isDrm = (e.name === 'SecurityError' || e.message?.includes('tainted'));
      if (VSC_DEFENSE.autoSceneDrmBackoff && isDrm) {
        drmRetryCount++;
        AUTO.drmBlocked = true;
        if (drmRetryCount >= MAX_DRM_RETRIES) {
          AUTO.running = false;
          AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
          Store.set(P.APP_AUTO_SCENE, false);
          showOSD('Auto Scene: DRM 제한으로 비활성화됨', 3000);
          Scheduler.request(true);
          return;
        }
        /* [v185] DRM backoff 기본 8초 */
        scheduleNext(v, Math.min(30000, 8000 * Math.pow(1.5, drmRetryCount - 1)));
      } else {
        scheduleNext(v, 1000);
      }
    }
  }

  function resetAllModuleState() {
    AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
    AUTO.statsEma = null;
    AUTO.lastStats = null;
    AUTO._lastMean = 0;
    AUTO._sceneStable = 0;
    AUTO._sceneTypeEma = ST.NORMAL;
    AUTO._sceneType = ST.NORMAL;
    AUTO.motionEma = 0;
    AUTO.motionFrames = 0;
    AUTO.fpsHist.length = 0;
    AUTO.curFps = 2;
    prevToneCurve = null;
    prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 };
    prevSatMul = 1.0;
    cutScores.length = 0;
    gradualScores.length = 0;
    flickerCount = 0;
    lastCurveDir = 0;
  }

  function cleanupScheduler() {
    if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; }
    if (__asRvfcId && __asRvfcVideo &&
        typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') {
      try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
      __asRvfcId = 0;
      __asRvfcVideo = null;
    }
  }

  __globalSig.addEventListener('abort', () => {
    AUTO.running = false;
    cleanupScheduler();
  }, { once: true });

  Store.sub(P.APP_AUTO_SCENE, (en) => {
    if (en && !AUTO.running) {
      drmRetryCount = 0; AUTO.running = true;
      resetAllModuleState();
      loop();
    } else if (!en) {
      AUTO.running = false;
      cleanupScheduler();
      resetAllModuleState();
      Scheduler.request(true);
    }
  });

  Store.sub(P.APP_ACT, (en) => {
    if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) {
      drmRetryCount = 0; AUTO.running = true; loop();
    }
  });

  return {
    getMods: () => AUTO.cur,
    getSceneType: () => AUTO._sceneType,
    getSceneTypeName: () => ST_NAMES[AUTO._sceneType] || 'UNKNOWN',
    hasToneCurve: () => !!AUTO.cur._toneCurve,
    start: () => {
      if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) {
        drmRetryCount = 0; AUTO.running = true; loop();
      }
    },
    stop: () => {
      AUTO.running = false;
      cleanupScheduler();
      resetAllModuleState();
    }
  };
}
// ▼▼▼ PART 3에서 이어짐 (createFiltersVideoOnly ~ createUI) ▼▼▼
// ▲▲▲ PART 2에서 이어짐 ▲▲▲

    /* ═══════════════════════════════════════════════════════════
       [v185] createFiltersVideoOnly
       — v184 패치 유지 (_toneStrTable, makeKeyBase, fingerprint 16, assembleCssFilter memo)
       — SVG sharp rawE max 0.40, USM blur 2.0, desat min 0.90
       — Lite midSharpMul mobile 0.28, totalS max 0.45
       — toeAmt scale 0.48
       ═══════════════════════════════════════════════════════════ */
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(64);
      const qInt = (v, step) => Math.round(v / step);
      const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };

      function wantsDetailPass(s) { return (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)) > 0; }

      const _toneStrTable = new Array(10001);
      for (let i = 0; i <= 10000; i++) {
        _toneStrTable[i] = (i / 10000).toString();
      }
      _toneStrTable[0] = '0';
      _toneStrTable[10000] = '1';

      const makeKeyBase = (s) => {
        let autoKey = '0';
        if (s._autoToneCurve && s._autoToneCurve.length === 256) {
          const c = s._autoToneCurve;
          autoKey = ((c[16] * 10000 + 0.5) | 0) + ',' +
                    ((c[48] * 10000 + 0.5) | 0) + ',' +
                    ((c[80] * 10000 + 0.5) | 0) + ',' +
                    ((c[112] * 10000 + 0.5) | 0) + ',' +
                    ((c[144] * 10000 + 0.5) | 0) + ',' +
                    ((c[176] * 10000 + 0.5) | 0) + ',' +
                    ((c[208] * 10000 + 0.5) | 0) + ',' +
                    ((c[240] * 10000 + 0.5) | 0);
        }
        let chGainKey = '0';
        if (s._autoChannelGains) {
          const g = s._autoChannelGains;
          chGainKey = ((g.rGain * 1000 + 0.5) | 0) + '|' +
                      ((g.gGain * 1000 + 0.5) | 0) + '|' +
                      ((g.bGain * 1000 + 0.5) | 0);
        }
        return qInt(s.gain, 0.04) + '|' + qInt(s.gamma, 0.01) + '|'
          + qInt(s.mid, 0.02) + '|'
          + qInt(s.toe, 0.2) + '|' + qInt(s.shoulder, 0.2) + '|' + qInt(s.temp, 0.2) + '|'
          + qInt(s.sharp, 0.2) + '|' + qInt(s.sharp2, 0.2) + '|' + qInt(s.clarity, 0.2) + '|'
          + 'ac:' + autoKey + '|cg:' + chGainKey;
      };

      /* [v185] getToneTableCached — toeAmt scale 0.48 */
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
          if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.48 * ((toeEnd - x) * w * w), 0, 1); }
          if (shAmt > 1e-6 && x > shoulderStart) { const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)); const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt; x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1); }
          x = x * contrast + intercept; x = clamp(x, 0, 1);
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;
          const idx = Math.min(10000, Math.max(0, Math.round(x * 10000)));
          out[i] = _toneStrTable[idx];
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      let __lastAutoCurveFingerprint = '';
      let __lastAutoCurveGamma = 0;
      let __lastAutoCurveResult = '';
      function buildToneTableFromAutoCurve(autoCurve, userGammaRaw) {
        const gExp = 1 / clamp(userGammaRaw || 1, 0.1, 5.0);
        const fp = ((autoCurve[0] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[16] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[32] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[48] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[64] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[80] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[96] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[112] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[128] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[144] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[160] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[176] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[192] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[208] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[224] * 65536 + 0.5) | 0).toString(36) + ',' +
                   ((autoCurve[240] * 65536 + 0.5) | 0).toString(36) + '|' +
                   ((gExp * 65536 + 0.5) | 0).toString(36);
        if (fp === __lastAutoCurveFingerprint && __lastAutoCurveResult) {
          return __lastAutoCurveResult;
        }
        const applyGamma = Math.abs(gExp - 1.0) > 0.001;
        const parts = new Array(256);
        let prev = 0;
        for (let i = 0; i < 256; i++) {
          let y = autoCurve[i];
          if (applyGamma) y = Math.pow(clamp(y, 0, 1), gExp);
          y = clamp(y, 0, 1);
          if (y < prev) y = prev;
          prev = y;
          const idx = Math.min(10000, Math.max(0, Math.round(y * 10000)));
          parts[i] = _toneStrTable[idx];
        }
        const result = parts.join(' ');
        __lastAutoCurveFingerprint = fp;
        __lastAutoCurveGamma = gExp;
        __lastAutoCurveResult = result;
        return result;
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
        const liteTmp = mkXfer({ in: 'lBase', result: 'lOut' }, { type: 'linear', slope: '1' });
        lite.append(liteConv, liteTone, liteTmp);
        defs.append(lite);

        const fidFull = `vsc-full-${config.VSC_ID}`;
        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
        const fBlur = h('feGaussianBlur', { ns: 'svg', in: 'conv', stdDeviation: '2.5', result: 'blr' });
        const fUsm = h('feComposite', { ns: 'svg', in: 'conv', in2: 'blr', operator: 'arithmetic', k1: '0', k2: '1.0', k3: '0', k4: '0', result: 'usm' });
        const fTone = mkXfer({ in: 'usm', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
        const fFinal = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '0.97', result: 'final' });
        full.append(fConv, fBlur, fUsm, fTone, fTemp, fFinal);
        defs.append(full);

        const tryAppend = () => {
          const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
          if (!target?.appendChild) return false;
          try {
            const escapedFull = fidFull.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const existing = target.querySelector(`filter[id="${escapedFull}"]`);
            if (existing) { const oldSvg = existing.closest('svg'); if (oldSvg && oldSvg !== svg) oldSvg.remove(); }
          } catch (_) {}
          target.appendChild(svg);
          return true;
        };
        if (!tryAppend()) { const t = setRecurring(() => { if (tryAppend()) clearRecurring(t); }, 50); setTimer(() => clearRecurring(t), 3000); }

        return {
          fidLite, fidFull, liteConv,
          liteToneFuncs: Array.from(liteTone.children),
          liteTmpFuncs: Array.from(liteTmp.children),
          fConv, fBlur, fUsm,
          fullToneFuncs: Array.from(fTone.children),
          fullTempFuncs: Array.from(fTemp.children),
          fFinal,
          st: {
            lastKey: '',
            liteToneKey: '', liteToneTable: '', liteTempKey: '', liteConvKey: '',
            fullToneKey: '', fullToneTable: '', fullTempKey: '', fullSharpKey: '', fullDesatKey: ''
          }
        };
      }

      const round4 = (n) => Math.round(n * 10000) / 10000;

      let __lastAssembleArgs = '';
      let __lastAssembleResult = 'none';
      function assembleCssFilterStr(svgUrl, cssBr, cssCt, cssSat) {
        const argsKey = (svgUrl || '') + '|' +
                        ((cssBr * 10000 + 0.5) | 0) + '|' +
                        ((cssCt * 10000 + 0.5) | 0) + '|' +
                        ((cssSat * 10000 + 0.5) | 0);
        if (argsKey === __lastAssembleArgs) return __lastAssembleResult;
        const parts = [];
        if (svgUrl) parts.push(svgUrl);
        if (Math.abs(cssBr - 1) > 0.001) parts.push(`brightness(${round4(cssBr)})`);
        if (Math.abs(cssCt - 1) > 0.001) parts.push(`contrast(${round4(cssCt)})`);
        if (Math.abs(cssSat - 1) > 0.001) parts.push(`saturate(${round4(cssSat)})`);
        __lastAssembleResult = parts.length ? parts.join(' ') : 'none';
        __lastAssembleArgs = argsKey;
        return __lastAssembleResult;
      }

      /* [v185] prepare — Full: rawE max 0.40, USM blur 2.0, desat min 0.90 / Lite: mobile 0.28, max 0.45 */
      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key: '', url: '', cssBr: 1, cssCt: 1, cssSat: 1, filterStr: 'none' }; urlCache.set(root, dc); }

        const detailOn = wantsDetailPass(s) && !__liteForced;
        const useFull = detailOn;
        const vwKey = video.videoWidth || 0, vhKey = video.videoHeight || 0;
        const modeTag = useFull ? 'FULL' : 'LITE';

        const svgKey = modeTag + '|' + vwKey + 'x' + vhKey + '|' + makeKeyBase(s);
        const cssBr = s._cssBr ?? 1;
        const cssCt = s._cssCt ?? 1;
        const cssSat = s._cssSat ?? 1;

        const fullKey = svgKey + '|css:' + cssBr.toFixed(3) + '|' + cssCt.toFixed(3) + '|' + cssSat.toFixed(3);
        if (dc.key === fullKey) return { svgUrl: dc.url, cssBr: dc.cssBr, cssCt: dc.cssCt, cssSat: dc.cssSat, filterStr: dc.filterStr };

        let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== svgKey) {
          st.lastKey = svgKey;
          const steps = 256;

          const con = 1.0;
          const brOff = 0;
          const gamma = 1 / clamp(s.gamma || 1, 0.1, 5.0);
          const toeQ = qInt(clamp((s.toe || 0) / 14, -1, 1), 0.02) * 0.02;
          const shQ = qInt(clamp((s.shoulder || 0) / 16, -1, 1), 0.02) * 0.02;
          const midQ = qInt(clamp(s.mid || 0, -1, 1), 0.02) * 0.02;
          const gainQ = qInt(s.gain || 1, 0.06) * 0.06;

          const hasAutoCurve = !!(s._autoToneCurve && s._autoToneCurve.length === 256);
          let toneTable;
          if (hasAutoCurve) {
            toneTable = buildToneTableFromAutoCurve(s._autoToneCurve, s.gamma || 1);
          } else {
            toneTable = getToneTableCached(steps, toeQ, shQ, midQ, gainQ, con, brOff, gamma);
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

          const tkPrefix = hasAutoCurve ? 'AC|' : '';
          const tk = tkPrefix + `${steps}|${Math.round(toeQ*1000)}|${Math.round(shQ*1000)}|${Math.round(midQ*1000)}|${Math.round(gainQ*1000)}|${Math.round(con*1000)}|${Math.round(brOff*10000)}|${Math.round(gamma*1000)}`;
          const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);

          if (useFull) {
            if (st.fullToneKey !== tk || (hasAutoCurve && st.fullToneTable !== toneTable)) {
              st.fullToneKey = tk;
              st.fullToneTable = toneTable;
              for (const fn of ctx.fullToneFuncs) {
                if (fn.tagName === 'feFuncA') continue;
                fn.setAttribute('tableValues', toneTable);
              }
            }
            if (st.fullTempKey !== tmk) {
              st.fullTempKey = tmk;
              ctx.fullTempFuncs[0].setAttribute('slope', finalRs);
              ctx.fullTempFuncs[1].setAttribute('slope', finalGs);
              ctx.fullTempFuncs[2].setAttribute('slope', finalBs);
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
              /* [v185] rawE max 0.40 */
              const e = clamp(rawE, 0, 0.40);
              const center = (1 + 4 * e);
              if (e > 0.005) {
                ctx.fConv.setAttribute('kernelMatrix', `0,${(-e).toFixed(4)},0, ${(-e).toFixed(4)},${center.toFixed(4)},${(-e).toFixed(4)}, 0,${(-e).toFixed(4)},0`);
              } else {
                ctx.fConv.setAttribute('kernelMatrix', '0,0,0, 0,1,0, 0,0,0');
              }
              const cAmt = clamp(clarityAmt / 50 * pxScale, 0, 0.35);
              ctx.fUsm.setAttribute('k2', (1 + cAmt).toFixed(4));
              ctx.fUsm.setAttribute('k3', (-cAmt).toFixed(4));
              /* [v185] USM blur σ 2.0 */
              ctx.fBlur.setAttribute('stdDeviation', (2.0 * pxScale).toFixed(2));
              const totalSharp = e + cAmt;
              /* [v185] desat min 0.90 */
              const desatVal = clamp(1.0 - totalSharp * 0.08, 0.90, 1.0).toFixed(3);
              if (st.fullDesatKey !== desatVal) {
                st.fullDesatKey = desatVal;
                ctx.fFinal.setAttribute('values', desatVal);
              }
            }
          } else {
            if (st.liteToneKey !== tk || (hasAutoCurve && st.liteToneTable !== toneTable)) {
              st.liteToneKey = tk;
              st.liteToneTable = toneTable;
              for (const fn of ctx.liteToneFuncs) fn.setAttribute('tableValues', toneTable);
            }
            if (st.liteTempKey !== tmk) {
              st.liteTempKey = tmk;
              ctx.liteTmpFuncs[0].setAttribute('slope', finalRs);
              ctx.liteTmpFuncs[1].setAttribute('slope', finalGs);
              ctx.liteTmpFuncs[2].setAttribute('slope', finalBs);
            }
            const liteSharpOn = wantsDetailPass(s);
            const mk = liteSharpOn ? (s.sharp + '|' + s.sharp2 + '|' + s.clarity + '|' + vhKey) : 'off';
            if (st.liteConvKey !== mk) {
              st.liteConvKey = mk;
              if (liteSharpOn) {
                const refH = 1080;
                const pxScale = clamp((vhKey || refH) / refH, 0.5, 2.0);
                /* [v185] Lite midSharpMul mobile 0.28, totalS max 0.45 */
                const midSharpMul = config.IS_MOBILE ? 0.28 : 0.30;
                const rawS = ((s.sharp || 0) + (s.sharp2 || 0) * 0.55 + (s.clarity || 0) * 0.35) / 50.0;
                const totalS = Math.min(0.45, rawS * midSharpMul * pxScale);
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
        const filterStr = assembleCssFilterStr(url, cssBr, cssCt, cssSat);
        dc.key = fullKey; dc.url = url; dc.cssBr = cssBr; dc.cssCt = cssCt; dc.cssSat = cssSat; dc.filterStr = filterStr;
        return { svgUrl: url, cssBr, cssCt, cssSat, filterStr };
      }

      return {
        prepareCached: (video, s) => {
          try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; }
        },
        applyFilter: (el, filterResult) => {
          if (!el) return;
          const st = getVState(el);
          if (st._inPiP) return;
          if (!filterResult) {
            if (st.applied) {
              if (!st._transitionCleared) el.style.removeProperty('transition');
              el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color');
              st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null;
              st._transitionCleared = false;
            }
            return;
          }
          const filterStr = filterResult.filterStr;
          if (st.lastCssFilterStr === filterStr && st.applied) return;
          if (!st._transitionCleared) {
            el.style.removeProperty('transition');
            st._transitionCleared = true;
          }
          el.style.setProperty('background-color', '#000', 'important');
          el.style.setProperty('filter', filterStr, 'important');
          el.style.setProperty('-webkit-filter', filterStr, 'important');
          st.applied = true;
          st.lastFilterUrl = filterResult.svgUrl;
          st.lastCssFilterStr = filterStr;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied) return;
          el.style.removeProperty('transition'); el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color');
          st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null;
          st._transitionCleared = false;
        }
      };
    }

    /* [v185] _SHADOW_PRECOMPUTED — MID toe -1.5, DEEP toe -2.5 */
    const _SHADOW_PRECOMPUTED = (() => {
      const base = [
        { bit: SHADOW_BAND.OUTER, toe: -1.0, mid: -0.010, bright: -0.5, gammaMul: 0.990, contrastMul: 1.015, satMul: 1.005 },
        { bit: SHADOW_BAND.MID,   toe: -1.5, mid: -0.012, bright: -0.8, gammaMul: 0.982, contrastMul: 1.020, satMul: 1.008 },
        { bit: SHADOW_BAND.DEEP,  toe: -2.5, mid: -0.005, bright: -0.5, gammaMul: 0.985, contrastMul: 1.020, satMul: 1.000 }
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

    /* [v185] _BRIGHT_STEP — 1: 1.5, 2: 3.2/1.04, 3: 5.0/1.07 */
    const _BRIGHT_STEP = [
      null,
      { brightAdd: 1.5, gammaMul: 1.02, contrastMul: 0.995 },
      { brightAdd: 3.2, gammaMul: 1.04, contrastMul: 0.990 },
      { brightAdd: 5.0, gammaMul: 1.07, contrastMul: 0.985 }
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

      if (autoMods._toneCurve) {
        out.satF = (out.satF || 1.0) * autoMods.sat;
        out._autoToneCurve = autoMods._toneCurve;
        out._autoChannelGains = autoMods._channelGains || null;
      } else {
        out.gain = (out.gain || 1.0) * autoMods.br;
        out.contrast = (out.contrast || 1.0) * autoMods.ct;
        out.satF = (out.satF || 1.0) * autoMods.sat;
      }

      const brightVal = Number(out.bright || 0);
      out._cssBr = VSC_CLAMP(1.0 + brightVal * 0.008, 0.5, 2.0);
      out._cssCt = VSC_CLAMP(out.contrast || 1, 0.5, 2.0);
      out._cssSat = VSC_CLAMP(out.satF || 1, 0, 3.0);

      return out;
    }

    const isNeutralVideoParams = (v) => (
      !v._autoToneCurve &&
      !v._autoChannelGains &&
      Math.abs((v.gain ?? 1) - 1) < 0.001 &&
      Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
      Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
      Math.abs((v.bright ?? 0)) < 0.01 &&
      Math.abs((v.mid ?? 0)) < 0.001 &&
      Math.abs((v.sharp ?? 0)) < 0.01 &&
      Math.abs((v.sharp2 ?? 0)) < 0.01 &&
      Math.abs((v.clarity ?? 0)) < 0.01 &&
      Math.abs((v.temp ?? 0)) < 0.01 &&
      Math.abs((v.toe ?? 0)) < 0.01 &&
      Math.abs((v.shoulder ?? 0)) < 0.01 &&
      Math.abs((v._cssBr ?? 1) - 1) < 0.001 &&
      Math.abs((v._cssCt ?? 1) - 1) < 0.001 &&
      Math.abs((v._cssSat ?? 1) - 1) < 0.001
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
          let curveKey = '0';
          if (autoMods._toneCurve) {
            const c = autoMods._toneCurve;
            curveKey = ((c[32]*10000)|0) + ',' + ((c[64]*10000)|0) + ',' +
                       ((c[96]*10000)|0) + ',' + ((c[128]*10000)|0) + ',' +
                       ((c[160]*10000)|0) + ',' + ((c[192]*10000)|0) + ',' +
                       ((c[224]*10000)|0);
          }
          let chKey = '0';
          if (autoMods._channelGains) {
            const g = autoMods._channelGains;
            chKey = `${(g.rGain*1000)|0}|${(g.gGain*1000)|0}|${(g.bGain*1000)|0}`;
          }
          const autoKey = `${autoMods.br.toFixed(3)}|${autoMods.ct.toFixed(3)}|${autoMods.sat.toFixed(3)}|tc:${curveKey}|cg:${chKey}`;
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
          if (__osdEl) {
            clearTimeout(__osdEl._timer);
            if (__osdEl.isConnected) { try { __osdEl.remove(); } catch (_) {} }
          }
          __osdEl = document.createElement('div'); __osdEl.id = 'vsc-osd';
          __osdEl.style.cssText = `position: fixed; top: 48px; left: 50%; transform: translateX(-50%); background: rgba(18,18,22,0.90); backdrop-filter: blur(20px) saturate(180%); color: rgba(255,255,255,0.92); padding: 10px 24px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.18s ease; box-shadow: 0 8px 32px rgba(0,0,0,0.35); letter-spacing: 0.3px; white-space: pre-line;`;
          try { root.appendChild(__osdEl); } catch (_) { return; }
        }
        __osdEl.textContent = text; __osdEl.style.opacity = '1';
        clearTimeout(__osdEl._timer);
        __osdEl._timer = setTimeout(() => { if (__osdEl) __osdEl.style.opacity = '0'; }, durationMs);
      } catch (_) {}
    }

    function getAutoPresetForResolution(videoHeight) {
      const h = videoHeight || 0;
      if (h <= 480) return 'L';
      if (h <= 720) return 'M';
      if (h <= 1080) return 'S';
      return 'off';
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

        const style = `:host{all:initial}*{box-sizing:border-box}.panel{position:fixed;top:50%;right:70px;transform:translateY(-50%);width:min(320px, calc(100vw - 40px));background:rgba(18,18,22,0.97);backdrop-filter:blur(16px) saturate(180%);color:#e8e8ec;padding:0;border-radius:14px;z-index:2147483647;border:1px solid rgba(255,255,255,0.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.05) inset;overflow:hidden;max-height:90vh;display:flex;flex-direction:column}@media(min-width:1200px){.panel{width:340px}}.header{padding:14px 16px 12px;cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;gap:8px}.header-title{font-size:13px;font-weight:700;letter-spacing:0.5px;color:rgba(255,255,255,0.9)}.header-info{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500;font-variant-numeric:tabular-nums;flex:1;text-align:center}.header-ver{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500}.tab-bar{display:flex;border-bottom:1px solid rgba(255,255,255,0.06);padding:0 8px}.tab{flex:1;padding:10px 4px 8px;text-align:center;cursor:pointer;border-bottom:2px solid transparent;font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);transition:all 0.15s;user-select:none}.tab:hover{color:rgba(255,255,255,0.6)}.tab.active{color:#60a5fa;border-bottom-color:#3b82f6}.tab-icon{display:flex;align-items:center;justify-content:center;width:18px;height:18px;margin:0 auto 3px}.tab-icon svg{width:16px;height:16px;display:block}.tab-content{display:none;padding:10px 12px;overflow-y:auto;flex:1}.tab-content.active{display:block}.tab-content[data-tab="video"] .section{border-left:2px solid rgba(96,165,250,0.3)}.tab-content[data-tab="audio"] .section{border-left:2px solid rgba(251,191,36,0.3)}.tab-content[data-tab="speed"] .section{border-left:2px solid rgba(74,222,128,0.3)}.tab-content[data-tab="tools"] .section{border-left:2px solid rgba(167,139,250,0.3)}.drag-indicator{display:none;width:36px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin:8px auto 4px}.section{margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.04)}.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.35);margin-bottom:8px}.row{display:flex;gap:4px;margin-bottom:4px;align-items:center}.row:last-child{margin-bottom:0}.btn{flex:1;height:36px;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.82);cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s ease;display:flex;align-items:center;justify-content:center;gap:4px}.btn:hover{background:rgba(255,255,255,0.12)}.btn:active{transform:scale(0.97)}.btn.active{background:rgba(59,130,246,0.25);border-color:rgba(59,130,246,0.5);color:#60a5fa}.btn.danger{color:#f87171;border-color:rgba(248,113,113,0.3)}.btn.danger:hover{background:rgba(248,113,113,0.15)}.btn.success{color:#4ade80;border-color:rgba(74,222,128,0.3)}.btn-sm{height:30px;font-size:11px}.preset-btn{flex:1;height:32px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.65);cursor:pointer;font-size:11px;font-weight:700;transition:all 0.12s ease}.preset-btn:hover{background:rgba(255,255,255,0.10)}.preset-btn.active{background:rgba(245,158,11,0.20);border-color:rgba(245,158,11,0.5);color:#fbbf24}.speed-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.divider{height:1px;background:rgba(255,255,255,0.04);margin:6px 0}.footer{padding:8px 12px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:4px}.icon{font-size:14px;line-height:1;display:inline-flex;align-items:center}.icon svg{display:block}input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;outline:none;cursor:pointer}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}.speed-display{flex:1;text-align:center;font-size:14px;font-weight:700;color:#e8e8ec;line-height:30px;font-variant-numeric:tabular-nums}.custom-speed-input{flex:1;height:28px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#e8e8ec;padding:0 8px;font-size:12px;font-weight:600;text-align:center;outline:none;font-variant-numeric:tabular-nums;-moz-appearance:textfield}.custom-speed-input::-webkit-inner-spin-button,.custom-speed-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}@media(max-width:480px){.panel{position:fixed!important;top:auto!important;bottom:0!important;left:0!important;right:auto!important;width:100%!important;max-height:70vh!important;border-radius:14px 14px 0 0!important;transform:none!important;transition:transform 0.3s cubic-bezier(0.32,0.72,0,1)!important}.drag-indicator{display:block}}`;
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
            renderPresetRow({ key: P.V_PRE_B, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'off').map(k => ({ text: PRESET_LABELS.grade[k] || k, value: k })) })
          )
        );
        bindStyle(advContainer, P.APP_ADV, (el, v) => { el.style.display = v ? 'block' : 'none'; });

        const videoSection = h('div', {},
          h('div', { class: 'section' },
            h('div', { class: 'section-label' }, '비디오 효과'),
            renderPresetRow({ key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: PRESET_LABELS.detail[k] || k, value: k })) }),
            h('div', { class: 'row', style: 'margin-top:6px' },
              (() => { const autoBtn = h('button', { class: 'btn' }); autoBtn.append(svgIcon('sparkles'), document.createTextNode(' Auto Scene')); autoBtn.onclick = () => setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); bindClassToggle(autoBtn, P.APP_AUTO_SCENE, v => !!v); return autoBtn; })(),
              (() => { const apBtn = h('button', { class: 'btn' }); apBtn.append(svgIcon('wand'), document.createTextNode(' 자동')); apBtn.onclick = () => setAndHint(P.APP_AUTO_PRESET, !sm.get(P.APP_AUTO_PRESET)); bindClassToggle(apBtn, P.APP_AUTO_PRESET, v => !!v); return apBtn; })()
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
            ),
            h('div', { class: 'divider' }),
            h('div', { class: 'section-label' }, '설정 관리'),
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
          h('button', { class: 'btn btn-sm', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); sm.set(P.APP_AUTO_PRESET, false); ApplyReq.hard(); } }, '\u21BA 리셋')
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
        const syncGearTitle = () => {
          if (!gearBtn) return;
          const parts = [];
          if (sm.get(P.APP_ACT)) {
            const ps = sm.get(P.V_PRE_S);
            if (ps !== 'off') parts.push('샤프: ' + (PRESET_LABELS.detail[ps] || ps));
            if (sm.get(P.A_EN)) parts.push('오디오 부스트');
            if (sm.get(P.PB_EN)) parts.push(Number(sm.get(P.PB_RATE)).toFixed(1) + 'x');
            if (sm.get(P.APP_AUTO_SCENE)) parts.push('Auto');
            if (sm.get(P.APP_AUTO_PRESET)) parts.push('자동프리셋');
          }
          gearBtn.title = parts.length ? parts.join(' \u00B7 ') : (sm.get(P.APP_ACT) ? '설정 없음' : 'OFF');
        };
        sub(P.APP_ACT, syncGearTitle); sub(P.V_PRE_S, syncGearTitle); sub(P.A_EN, syncGearTitle); sub(P.PB_EN, syncGearTitle); sub(P.PB_RATE, syncGearTitle); sub(P.APP_AUTO_SCENE, syncGearTitle); sub(P.APP_AUTO_PRESET, syncGearTitle);
        syncGearTitle();
        const syncGear = () => { if (!gearBtn) return; const showHere = allowUiInThisDoc(); gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); gearBtn.style.display = showHere ? 'block' : 'none'; if (!showHere) detachNodesHard(); else wake(); };
        sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
      };
      const mount = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
      const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; } else { if (container) container.style.display = 'none'; } mount(); };
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => { try { ensure(); ApplyReq.hard(); } catch (_) {} }, { once: true, signal: __globalSig }); }
      if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;
      return { ensure, destroy: () => { try { uiWakeCtrl.abort(); } catch {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); bag.flush(); detachNodesHard(); } };
    }
// ▼▼▼ PART 4에서 이어짐 (bindVideoOnce ~ VSC_MAIN 호출) ▼▼▼
// ═══════════════════════════════════════════════════════════
//  PART 4 — createController · SPA bootstrap · main()
// ═══════════════════════════════════════════════════════════

function createController(video, host, gearHost) {
  const state = {
    video,
    host,
    gearHost,
    speed: video.playbackRate || 1,
    savedSpeed: null,
    filters: null,
    audio: null,
    zoom: null,
    scene: null,
    autoScene: false,
    pip: false,
    loop: { active: false, a: null, b: null },
    destroyed: false
  };

  /* ---------- helpers ---------- */
  function clampSpeed(v) { return Math.round(Math.max(0.1, Math.min(16, v)) * 100) / 100; }

  function applySpeed(s) {
    s = clampSpeed(s);
    state.speed = s;
    try { video.playbackRate = s; } catch (_) {}
    updateUI();
    return s;
  }

  const RATE_SUPPRESS_MS = 600;
  let rateSuppressUntil = 0;

  function onRateChange() {
    if (state.destroyed) return;
    if (Date.now() < rateSuppressUntil) { try { video.playbackRate = state.speed; } catch (_) {} return; }
    const cur = video.playbackRate;
    if (Math.abs(cur - state.speed) > 0.005) { state.speed = cur; updateUI(); }
  }
  video.addEventListener('ratechange', onRateChange);

  function suppressRate() { rateSuppressUntil = Date.now() + RATE_SUPPRESS_MS; }

  /* ---------- speed ---------- */
  function setSpeed(s) { suppressRate(); return applySpeed(s); }
  function changeSpeed(delta) { return setSpeed(state.speed + delta); }
  function toggleRewind() {
    if (state.savedSpeed !== null) { setSpeed(state.savedSpeed); state.savedSpeed = null; }
    else { state.savedSpeed = state.speed; setSpeed(-1); }
    updateUI();
  }

  /* ---------- volume ---------- */
  function changeVolume(delta) {
    video.volume = Math.round(Math.max(0, Math.min(1, video.volume + delta)) * 100) / 100;
    updateUI();
  }

  /* ---------- seek ---------- */
  function seek(sec) {
    if (isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
  }

  /* ---------- loop ---------- */
  function setLoopA() { state.loop.a = video.currentTime; updateUI(); }
  function setLoopB() {
    if (state.loop.a === null) return;
    state.loop.b = video.currentTime;
    state.loop.active = true;
    updateUI();
  }
  function clearLoop() { state.loop = { active: false, a: null, b: null }; updateUI(); }

  function loopTick() {
    if (!state.loop.active || state.loop.a === null || state.loop.b === null) return;
    const a = Math.min(state.loop.a, state.loop.b);
    const b = Math.max(state.loop.a, state.loop.b);
    if (video.currentTime >= b || video.currentTime < a) video.currentTime = a;
  }
  video.addEventListener('timeupdate', loopTick);

  /* ---------- PiP ---------- */
  const PIP_REAPPLY_MS = 200;
  async function togglePip() {
    try {
      if (document.pictureInPictureElement === video) { await document.exitPictureInPicture(); state.pip = false; }
      else {
        await video.requestPictureInPicture();
        state.pip = true;
        setTimeout(() => { if (state.filters) state.filters.reapply(); }, PIP_REAPPLY_MS);
      }
    } catch (_) {}
    updateUI();
  }

  /* ---------- filters ---------- */
  function ensureFilters() {
    if (!state.filters && !state.destroyed) {
      state.filters = createFiltersVideoOnly(video);
    }
    return state.filters;
  }

  function setPreset(name) {
    const f = ensureFilters(); if (!f) return;
    f.setPreset(name);
    updateUI();
  }

  function adjustFilter(prop, delta) {
    const f = ensureFilters(); if (!f) return;
    f.adjust(prop, delta);
    updateUI();
  }

  function resetFilters() {
    if (state.filters) { state.filters.reset(); updateUI(); }
  }

  /* ---------- audio ---------- */
  function ensureAudio() {
    if (!state.audio && !state.destroyed) {
      state.audio = createAudio(video);
    }
    return state.audio;
  }

  function toggleAudioEnhance() {
    const a = ensureAudio(); if (!a) return;
    a.toggle();
    updateUI();
  }

  function setAudioPreset(name) {
    const a = ensureAudio(); if (!a) return;
    a.setPreset(name);
    updateUI();
  }

  /* ---------- zoom ---------- */
  function ensureZoom() {
    if (!state.zoom && !state.destroyed) {
      state.zoom = createZoomManager(video);
    }
    return state.zoom;
  }

  function toggleZoom() {
    const z = ensureZoom(); if (!z) return;
    z.toggle();
    updateUI();
  }

  function resetZoom() {
    if (state.zoom) { state.zoom.reset(); updateUI(); }
  }

  /* ---------- auto scene ---------- */
  function ensureScene() {
    if (!state.scene && !state.destroyed) {
      state.scene = createAutoSceneManager(video, {
        onApply(params) {
          const f = ensureFilters(); if (!f) return;
          f.applySceneParams(params);
        }
      });
    }
    return state.scene;
  }

  function toggleAutoScene() {
    const s = ensureScene(); if (!s) return;
    state.autoScene = !state.autoScene;
    if (state.autoScene) s.start(); else s.stop();
    updateUI();
  }

  /* ---------- UI ---------- */
  const SAVE_DEBOUNCE_MS = 800;
  let saveTimer = null;

  function updateUI() {
    if (state.destroyed) return;
    try { buildUI(state, api); } catch (_) {}
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { saveSettings(state); } catch (_) {} }, SAVE_DEBOUNCE_MS);
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (state.destroyed) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.target?.isContentEditable) return;
    const k = e.key?.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    let handled = true;

    switch (true) {
      /* speed */
      case k === 'd' && !ctrl && !alt: changeSpeed(0.1); break;
      case k === 's' && !ctrl && !alt: changeSpeed(-0.1); break;
      case k === 'r' && !ctrl && !alt: setSpeed(1); break;
      case k === 'g' && !ctrl && !alt: setSpeed(2); break;
      case k === 'z' && !ctrl && !alt: toggleRewind(); break;

      /* seek */
      case k === 'arrowleft' && shift: seek(-1); break;
      case k === 'arrowright' && shift: seek(1); break;
      case k === 'arrowleft' && ctrl: seek(-10); break;
      case k === 'arrowright' && ctrl: seek(10); break;

      /* volume */
      case k === 'arrowup' && shift: changeVolume(0.05); break;
      case k === 'arrowdown' && shift: changeVolume(-0.05); break;

      /* filter presets */
      case k === '1' && alt: setPreset('S'); break;
      case k === '2' && alt: setPreset('M'); break;
      case k === '3' && alt: setPreset('L'); break;
      case k === '4' && alt: setPreset('XL'); break;
      case k === '0' && alt: resetFilters(); break;

      /* filter adjust */
      case k === 'b' && shift && !ctrl: adjustFilter('brightness', 0.02); break;
      case k === 'b' && !shift && !ctrl: adjustFilter('brightness', -0.02); break;
      case k === 'c' && shift && !ctrl: adjustFilter('contrast', 0.02); break;
      case k === 'c' && !shift && !ctrl: adjustFilter('contrast', -0.02); break;
      case k === 'a' && shift && !ctrl: adjustFilter('saturation', 0.05); break;
      case k === 'a' && !shift && !ctrl: adjustFilter('saturation', -0.05); break;

      /* features */
      case k === 'p' && !ctrl && !alt: togglePip(); break;
      case k === 'l' && !ctrl && !alt && !shift: setLoopA(); break;
      case k === 'l' && shift && !ctrl && !alt: setLoopB(); break;
      case k === 'l' && ctrl && !alt: clearLoop(); break;
      case k === 'e' && !ctrl && !alt: toggleAudioEnhance(); break;
      case k === 'v' && alt && !ctrl: toggleAutoScene(); break;
      case k === 'x' && !ctrl && !alt: toggleZoom(); break;
      case k === 'escape': resetZoom(); clearLoop(); break;

      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('keydown', onKey, true);

  /* ---------- tick (maintenance) ---------- */
  const TICK_INTERVAL_MS = 15000;
  const tickId = setInterval(() => {
    if (state.destroyed) return;
    try {
      if (video.paused || video.ended) return;
      if (state.filters) state.filters.tick?.();
      if (state.audio) state.audio.tick?.();
    } catch (_) {}
  }, TICK_INTERVAL_MS);

  /* ---------- restore settings ---------- */
  function restoreSettings() {
    try {
      const saved = loadSettings(video);
      if (!saved) return;
      if (saved.speed) setSpeed(saved.speed);
      if (saved.preset) setPreset(saved.preset);
      if (saved.audioPreset) setAudioPreset(saved.audioPreset);
      if (saved.audioEnabled) toggleAudioEnhance();
      if (saved.autoScene) toggleAutoScene();
      if (saved.filters) {
        const f = ensureFilters();
        if (f && saved.filters) f.restoreState(saved.filters);
      }
    } catch (_) {}
  }

  /* ---------- destroy ---------- */
  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('timeupdate', loopTick);
    document.removeEventListener('keydown', onKey, true);
    clearInterval(tickId);
    if (saveTimer) clearTimeout(saveTimer);
    try { if (state.filters) state.filters.destroy(); } catch (_) {}
    try { if (state.audio) state.audio.destroy(); } catch (_) {}
    try { if (state.zoom) state.zoom.destroy(); } catch (_) {}
    try { if (state.scene) state.scene.destroy(); } catch (_) {}
    try { if (host?.parentNode) host.remove(); } catch (_) {}
    try { if (gearHost?.parentNode) gearHost.remove(); } catch (_) {}
  }

  /* ---------- public API ---------- */
  const api = {
    get state() { return state; },
    setSpeed, changeSpeed, toggleRewind,
    changeVolume, seek,
    setLoopA, setLoopB, clearLoop,
    togglePip,
    setPreset, adjustFilter, resetFilters,
    toggleAudioEnhance, setAudioPreset,
    toggleZoom, resetZoom,
    toggleAutoScene,
    updateUI, restoreSettings, destroy
  };

  restoreSettings();
  updateUI();
  return api;
}

// ─────────────────────────────────────────────────────────
//  Settings persistence (GM_getValue / GM_setValue)
// ─────────────────────────────────────────────────────────
function settingsKey(video) {
  try {
    const loc = video.ownerDocument?.defaultView?.location;
    const host = loc?.hostname || 'unknown';
    const path = loc?.pathname?.replace(/\/$/, '') || '';
    return `vsc_${host}${path}`;
  } catch (_) { return 'vsc_default'; }
}

function saveSettings(state) {
  try {
    const key = settingsKey(state.video);
    const data = {
      speed: state.speed,
      preset: state.filters?.currentPreset || null,
      audioPreset: state.audio?.currentPreset || null,
      audioEnabled: !!state.audio?.enabled,
      autoScene: state.autoScene,
      filters: state.filters?.getState?.() || null,
      ts: Date.now()
    };
    GM_setValue(key, JSON.stringify(data));
  } catch (_) {}
}

function loadSettings(video) {
  try {
    const key = settingsKey(video);
    const raw = GM_getValue(key, null);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data.ts || 0) > 30 * 24 * 3600 * 1000) { GM_deleteValue(key); return null; }
    return data;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────
//  buildUI — Shadow DOM toolbar
// ─────────────────────────────────────────────────────────
function buildUI(state, ctrl) {
  const host = state.host; if (!host) return;
  let shadow = host.shadowRoot;
  if (!shadow) {
    shadow = host.attachShadow({ mode: 'open' });
    host.setAttribute('data-vsc-ui', '');
  }
  const v = state.video;
  const speed = state.speed.toFixed(2);
  const vol = Math.round((v.volume || 0) * 100);
  const loopInfo = state.loop.active
    ? `A:${state.loop.a?.toFixed(1)}s B:${state.loop.b?.toFixed(1)}s`
    : state.loop.a !== null ? `A:${state.loop.a?.toFixed(1)}s` : '';
  const presetLabel = state.filters?.currentPreset || 'OFF';
  const audioLabel = state.audio?.enabled ? (state.audio.currentPreset || 'ON') : 'OFF';
  const sceneLabel = state.autoScene ? 'ON' : 'OFF';
  const zoomLabel = state.zoom?.isZoomed?.() ? 'ON' : 'OFF';
  const pipLabel = state.pip ? 'ON' : 'OFF';

  shadow.innerHTML = `
<style>
:host{position:fixed;top:8px;left:8px;z-index:2147483647;font:12px/1.4 monospace;pointer-events:none}
.bar{display:flex;gap:3px;flex-wrap:wrap;pointer-events:auto;background:rgba(0,0,0,.75);border-radius:6px;padding:4px 6px;color:#eee;align-items:center;max-width:96vw;user-select:none;-webkit-user-select:none}
.bar button{all:unset;cursor:pointer;padding:2px 7px;border-radius:4px;font:inherit;color:#ddd;background:rgba(255,255,255,.08);white-space:nowrap;transition:background .15s}
.bar button:hover{background:rgba(255,255,255,.22)}
.bar button.on{background:rgba(80,180,255,.35);color:#fff}
.bar .sep{width:1px;height:16px;background:rgba(255,255,255,.2);margin:0 2px}
.bar .lbl{color:#aaa;font-size:11px}
</style>
<div class="bar">
  <span class="lbl">VSC v${VSC_VERSION}</span><div class="sep"></div>
  <button id="slower">−</button>
  <span class="lbl">${speed}x</span>
  <button id="faster">+</button>
  <button id="reset1x">1x</button>
  <button id="rewind" class="${state.savedSpeed !== null ? 'on' : ''}">⏪</button>
  <div class="sep"></div>
  <span class="lbl">Vol ${vol}%</span>
  <div class="sep"></div>
  <button id="pS">S</button><button id="pM">M</button><button id="pL">L</button><button id="pXL">XL</button>
  <button id="pOff">Off</button>
  <span class="lbl">F:${presetLabel}</span>
  <div class="sep"></div>
  <button id="audio" class="${audioLabel !== 'OFF' ? 'on' : ''}">Audio:${audioLabel}</button>
  <button id="scene" class="${sceneLabel !== 'OFF' ? 'on' : ''}">Scene:${sceneLabel}</button>
  <button id="zoom" class="${zoomLabel !== 'OFF' ? 'on' : ''}">Zoom:${zoomLabel}</button>
  <button id="pip" class="${pipLabel !== 'OFF' ? 'on' : ''}">PiP:${pipLabel}</button>
  ${loopInfo ? `<div class="sep"></div><span class="lbl">Loop ${loopInfo}</span>` : ''}
</div>`;

  const $ = id => shadow.getElementById(id);
  $('slower')?.addEventListener('click', () => ctrl.changeSpeed(-0.1));
  $('faster')?.addEventListener('click', () => ctrl.changeSpeed(0.1));
  $('reset1x')?.addEventListener('click', () => ctrl.setSpeed(1));
  $('rewind')?.addEventListener('click', () => ctrl.toggleRewind());
  $('pS')?.addEventListener('click', () => ctrl.setPreset('S'));
  $('pM')?.addEventListener('click', () => ctrl.setPreset('M'));
  $('pL')?.addEventListener('click', () => ctrl.setPreset('L'));
  $('pXL')?.addEventListener('click', () => ctrl.setPreset('XL'));
  $('pOff')?.addEventListener('click', () => ctrl.resetFilters());
  $('audio')?.addEventListener('click', () => ctrl.toggleAudioEnhance());
  $('scene')?.addEventListener('click', () => ctrl.toggleAutoScene());
  $('zoom')?.addEventListener('click', () => ctrl.toggleZoom());
  $('pip')?.addEventListener('click', () => ctrl.togglePip());
}

// ─────────────────────────────────────────────────────────
//  Gear icon host (persistent mini toggle)
// ─────────────────────────────────────────────────────────
function buildGearIcon(gearHost, toggleFn) {
  if (!gearHost) return;
  let shadow = gearHost.shadowRoot;
  if (!shadow) {
    shadow = gearHost.attachShadow({ mode: 'open' });
    gearHost.setAttribute('data-vsc-ui', '');
    gearHost.id = 'vsc-gear-host';
  }
  shadow.innerHTML = `
<style>
:host{position:fixed;bottom:12px;right:12px;z-index:2147483647;pointer-events:auto}
.gear{width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:#ccc;user-select:none;-webkit-user-select:none;transition:background .2s}
.gear:hover{background:rgba(0,0,0,.8)}
</style>
<div class="gear" title="Video Control Settings">⚙</div>`;
  shadow.querySelector('.gear')?.addEventListener('click', toggleFn);
}

// ─────────────────────────────────────────────────────────
//  createRegistry integration bridge
// ─────────────────────────────────────────────────────────
function attachController(video) {
  if (video._vscAttached) return null;
  video._vscAttached = true;

  const host = document.createElement('div');
  host.id = 'vsc-host';
  host.setAttribute('data-vsc-ui', '');
  host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;display:none';
  document.body.appendChild(host);

  const gearHost = document.createElement('div');
  document.body.appendChild(gearHost);

  let visible = false;
  function toggleBar() {
    visible = !visible;
    host.style.display = visible ? '' : 'none';
  }
  buildGearIcon(gearHost, toggleBar);

  const ctrl = createController(video, host, gearHost);
  return ctrl;
}

// ─────────────────────────────────────────────────────────
//  SPA navigation handling
// ─────────────────────────────────────────────────────────
const SPA_RESCAN_DEBOUNCE_MS = 280;
let spaRescanTimer = null;
let currentControllers = new Map();

function rescanVideos() {
  const videos = document.querySelectorAll('video');
  const found = new Set();

  videos.forEach(v => {
    found.add(v);
    if (!currentControllers.has(v)) {
      const ctrl = attachController(v);
      if (ctrl) currentControllers.set(v, ctrl);
    }
  });

  for (const [v, ctrl] of currentControllers) {
    if (!found.has(v) || !v.isConnected) {
      ctrl.destroy();
      currentControllers.delete(v);
      v._vscAttached = false;
    }
  }
}

function scheduleSpaRescan() {
  if (spaRescanTimer) clearTimeout(spaRescanTimer);
  spaRescanTimer = setTimeout(rescanVideos, SPA_RESCAN_DEBOUNCE_MS);
}

const PRUNE_INTERVAL_MS = 3000;
setInterval(() => {
  for (const [v, ctrl] of currentControllers) {
    if (!v.isConnected) { ctrl.destroy(); currentControllers.delete(v); v._vscAttached = false; }
  }
}, PRUNE_INTERVAL_MS);

/* --- Intercept SPA navigation --- */
function hookSpaNavigation() {
  const orig = history.pushState;
  history.pushState = function () {
    orig.apply(this, arguments);
    scheduleSpaRescan();
  };
  const origReplace = history.replaceState;
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    scheduleSpaRescan();
  };
  window.addEventListener('popstate', scheduleSpaRescan);
  window.addEventListener('hashchange', scheduleSpaRescan);
}

/* --- MutationObserver for dynamic video insertion --- */
function hookMutationObserver() {
  const observer = new MutationObserver(mutations => {
    let hasVideo = false;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeName === 'VIDEO' || (n.nodeType === 1 && n.querySelector?.('video'))) { hasVideo = true; break; }
      }
      if (hasVideo) break;
    }
    if (hasVideo) scheduleSpaRescan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/* --- Page resume (visibility change, focus) --- */
const PAGE_RESUME_DEBOUNCE_MS = 150;
let pageResumeTimer = null;

function onPageResume() {
  if (pageResumeTimer) clearTimeout(pageResumeTimer);
  pageResumeTimer = setTimeout(() => {
    for (const [, ctrl] of currentControllers) {
      try { ctrl.updateUI(); } catch (_) {}
    }
  }, PAGE_RESUME_DEBOUNCE_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) onPageResume(); });
window.addEventListener('focus', onPageResume);

// ─────────────────────────────────────────────────────────
//  Emergency style cleanup
// ─────────────────────────────────────────────────────────
const EMERGENCY_CLEANUP_MS = 3000;
setInterval(() => {
  try {
    const orphans = document.querySelectorAll('[data-vsc-ui]');
    orphans.forEach(el => {
      if (el.id === 'vsc-host' || el.id === 'vsc-gear-host') return;
      if (!el.isConnected || !el.shadowRoot) el.remove();
    });
  } catch (_) {}
}, EMERGENCY_CLEANUP_MS);

// ─────────────────────────────────────────────────────────
//  MAIN ENTRY
// ─────────────────────────────────────────────────────────
function main() {
  log(`Video_Control v${VSC_VERSION} initialized`);
  hookSpaNavigation();
  hookMutationObserver();
  rescanVideos();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

})();
