// ==UserScript==
// @name         Video_Control (v170.7.0 - Zero-Idle WebGL & Adaptive SVG)
// @namespace    https://github.com/
// @version      170.7.0
// @description  Video Control: Modern Framework + GPU 100% Opt (Event-Driven WebGL Zero-Idle, Selective Tier Update)
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
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
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

    function on(target, type, fn, opts = {}) {
      const merged = { ...opts };
      try {
        merged.signal = __globalSig;
        target.addEventListener(type, fn, merged);
      } catch (_) {
        try { target.addEventListener(type, fn, opts); } catch (__) {}
      }
    }
    const onWin = (type, fn, opts) => on(window, type, fn, opts);
    const onDoc = (type, fn, opts) => on(document, type, fn, opts);

    function waitForVisibility() {
      if (document.visibilityState === 'visible') return Promise.resolve();
      return new Promise(resolve => {
        const onVisibility = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisibility); resolve(); } };
        document.addEventListener('visibilitychange', onVisibility);
      });
    }

    function detectMobile() { try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {} return /Mobi|Android|iPhone/i.test(navigator.userAgent); }

    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      IS_LOW_END: false,
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""),
      DEBUG: false
    });

    const VSC_VERSION = '170.7.0';
    const VSC_SYNC_TOKEN = `VSC_SYNC_${VSC_VERSION}_${CONFIG.VSC_ID}`;

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const clamp = VSC_CLAMP;
      const t = clamp((Number(temp) || 0) / 50, -1, 1);
      let r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t);
      const m = Math.max(r, g, b);
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    const VSC_MEDIA = (() => {
      let hdr = 0;
      try {
        if (window.matchMedia) {
          const mql = matchMedia('(dynamic-range: high)');
          hdr = mql.matches ? 1 : 0;
          mql.addEventListener('change', (e) => { hdr = e.matches ? 1 : 0; }, { passive: true });
        }
      } catch (_) {}
      return Object.freeze({ isHdr: () => hdr === 1 });
    })();

    const DEFENSE_PRESET = 'safe'; // 'safe' | 'simple'
    const VSC_DEFENSE = Object.freeze(
      DEFENSE_PRESET === 'simple'
        ? { webglCooldown: false, audioCooldown: false, autoSceneDrmBackoff: false, hideAmbientGlow: false }
        : { webglCooldown: true,  audioCooldown: true,  autoSceneDrmBackoff: true,  hideAmbientGlow: true  }
    );

    if (VSC_DEFENSE.hideAmbientGlow) {
      const style = document.createElement('style');
      style.textContent = `#cinematics, .ytp-glow-effect, .ytp-glow-canvas-container, [id^="ambient-"] { display: none !important; contain: strict !important; }`;
      (document.head || document.documentElement).appendChild(style);
    }

    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true });
    const PERF_POLICY = Object.freeze({ registry: { shadowLRUMax: 12, spaRescanDebounceMs: 220 } });
    const RUNTIME_GUARD = Object.freeze({ webgl: { failCooldownMs: 5000, failThreshold: 3 }, audio: { createSourceCooldownMs: 5000 }, targeting: { hysteresisMs: 650, hysteresisMargin: 0.8 } });

    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
    const log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

    function createVideoState() {
      return { visible: false, rect: null, ir: 0, bound: false, rateState: null, audioFailUntil: 0, applied: false, fxBackend: null, desiredRate: undefined, lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false, webglFailCount: 0, webglDisabledUntil: 0, webglTainted: false };
    }

    const videoStateMap = new WeakMap();
    function getVState(v) {
      let st = videoStateMap.get(v);
      if (!st) { st = createVideoState(); videoStateMap.set(v, st); }
      return st;
    }

    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({
      has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; },
      toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); }
    });

    const PRESETS = Object.freeze({
      detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 14, sharp2Add: 2, clarityAdd: 4 }, M: { sharpAdd: 16, sharp2Add: 10, clarityAdd: 10 }, L: { sharpAdd: 14, sharp2Add: 26, clarityAdd: 12}, XL: { sharpAdd: 18, sharp2Add: 16, clarityAdd: 24 } },
      grade: { brOFF: { gammaF: 1.00, brightAdd: 0 }, S: { gammaF: 1.02, brightAdd: 1.8 }, M: { gammaF: 1.07, brightAdd: 4.4 }, L: { gammaF: 1.15, brightAdd: 9 }, DS: { gammaF: 1.05, brightAdd: 3.6 }, DM: { gammaF: 1.10, brightAdd: 7.2 }, DL: { gammaF: 1.20, brightAdd: 10.8 } }
    });

    const DEFAULTS = {
      video: { presetS: 'off', presetB: 'brOFF', presetMix: 1.0, shadowBandMask: 0, brightStepLevel: 0 },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, renderMode: 'svg', zoomEn: false, autoScene: false, advanced: false }
    };

    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_RENDER_MODE: 'app.renderMode',
      APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced',
      V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel',
      A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    const APP_SCHEMA = [
      { type: 'enum', path: P.APP_RENDER_MODE, values: ['svg', 'webgl'], fallback: () => 'svg' },
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

    if (FEATURE_FLAGS.trackShadowRoots) {
      (function patchAttachShadowOnce() {
        try {
          const proto = Element.prototype; if (!proto.attachShadow) return;
          const VSC_PATCH = Symbol.for('vsc.patch.attachShadow'); if (proto[VSC_PATCH]) return;
          const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow'), orig = desc && desc.value; if (typeof orig !== 'function') return;
          try { Object.defineProperty(proto, VSC_PATCH, { value: true }); } catch (_) { proto[VSC_PATCH] = true; }
          function wrappedAttachShadow(init) { const shadow = orig.call(this, init); try { if (shadow && init && init.mode === 'open') { document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: shadow })); } } catch (_) {} return shadow; }
          try { Object.defineProperty(wrappedAttachShadow, 'toString', { value: Function.prototype.toString.bind(orig), configurable: true }); } catch (_) {}
          if (desc && desc.configurable === false && desc.writable === false) return;
          Object.defineProperty(proto, 'attachShadow', { ...desc, value: wrappedAttachShadow });
        } catch (e) { log.warn('attachShadow patch failed:', e); }
      })();
    }

    const TOUCHED = { videos: new Set(), rateVideos: new Set() };
    function touchedAddLimited(set, el, onEvict) { if (!el) return; if (set.has(el)) { set.delete(el); set.add(el); return; } set.add(el); if (set.size <= CONFIG.TOUCHED_MAX) return; const it = set.values(); const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25); for (let i = 0; i < dropN; i++) { const v = it.next().value; if (v == null) break; set.delete(v); try { onEvict && onEvict(v); } catch (_) {} } }
    const lerp = (a, b, t) => a + (b - a) * t;

    let __vscRectEpoch = 0, __vscRectEpochQueued = false;
    function bumpRectEpoch() { if (__vscRectEpochQueued) return; __vscRectEpochQueued = true; requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; }); }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true });
    onWin('resize', bumpRectEpoch, { passive: true });
    onWin('orientationchange', bumpRectEpoch, { passive: true });
    try {
      const vv = window.visualViewport;
      if (vv) {
        vv.addEventListener('resize', bumpRectEpoch, { passive: true, signal: __globalSig });
        vv.addEventListener('scroll', bumpRectEpoch, { passive: true, signal: __globalSig });
      }
    } catch (_) {}

    function getRectCached(v, now, maxAgeMs = 420) {
      const st = getVState(v); const t0 = st.rectT || 0; let r = st.rect; const epoch = st.rectEpoch || 0;
      if (!r || (now - t0) > maxAgeMs || epoch !== __vscRectEpoch) { r = v.getBoundingClientRect(); st.rect = r; st.rectT = now; st.rectEpoch = __vscRectEpoch; } return r;
    }
    function getViewportSnapshot() { const vv = window.visualViewport; if (vv) { return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; } return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }
    const __vscElemIds = new WeakMap(); let __vscElemIdSeq = 1;
    function getElemId(el) { if (!el) return 0; let id = __vscElemIds.get(el); if (!id) { id = __vscElemIdSeq++; __vscElemIds.set(el, id); } return id; }

    function* walkRoots(root) { if (!root) return; yield root; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let node = walker.currentNode; while (node) { if (node.shadowRoot) yield* walkRoots(node.shadowRoot); node = walker.nextNode(); } }

    function createDebounced(fn, ms = 250) {
      let t = 0; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return; window.__VSC_SPA_PATCHED__ = true; let lastHref = location.href;
      const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
      const wrap = (name) => { const orig = history[name]; if (typeof orig !== 'function') return; history[name] = function (...args) { const ret = Reflect.apply(orig, this, args); queueMicrotask(emitIfChanged); return ret; }; };
      wrap('pushState'); wrap('replaceState'); onWin('popstate', emitIfChanged, { passive: true });
    }

    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    function watchIframes() {
      const inject = (ifr) => {
        if (!ifr) return;
        const tryInject = () => {
          try {
            const win = ifr.contentWindow;
            const doc = ifr.contentDocument || win?.document;
            if (!win || !doc) return;
            if (win.__VSC_BOOT_LOCK__) return;
            const host = doc.head || doc.documentElement;
            if (!host) return;

            const s = doc.createElement('script');
            s.textContent = __VSC_INJECT_SOURCE;
            host.appendChild(s);
            s.remove?.();
          } catch (_) {}
        };
        tryInject();
        if (!ifr.__vscLoadHooked) {
          ifr.__vscLoadHooked = true;
          ifr.addEventListener('load', tryInject, { passive: true });
        }
      };

      document.querySelectorAll("iframe").forEach(inject);
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.addedNodes) {
            m.addedNodes.forEach(n => {
              if (n.tagName === 'IFRAME') inject(n);
              else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(inject);
            });
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    const fsWraps = new WeakMap();
    function ensureFsWrapper(video) { if (fsWraps.has(video)) return fsWraps.get(video); if (!video || !video.parentNode) return null; const parent = video.parentNode; const wrap = document.createElement('div'); wrap.className = 'vsc-fs-wrap'; wrap.style.cssText = `position: relative; display: inline-block; width: 100%; height: 100%; max-width: 100%; background: black;`; const ph = document.createComment('vsc-video-placeholder'); parent.insertBefore(ph, video); parent.insertBefore(wrap, video); wrap.appendChild(video); wrap.__vscPlaceholder = ph; fsWraps.set(video, wrap); return wrap; }
    function restoreFromFsWrapper(video) { const wrap = fsWraps.get(video); if (!wrap) return; const ph = wrap.__vscPlaceholder; if (ph && ph.parentNode) { ph.parentNode.insertBefore(video, ph); ph.parentNode.removeChild(ph); } if (wrap.parentNode) wrap.parentNode.removeChild(wrap); fsWraps.delete(video); }
    function patchMethodSafe(obj, name, wrappedFn) { try { const ownDesc = Object.getOwnPropertyDescriptor(obj, name); if (ownDesc && ownDesc.writable === false && ownDesc.configurable === false) return false; obj[name] = wrappedFn; if (obj[name] === wrappedFn) return true; } catch (_) {} try { Object.defineProperty(obj, name, { configurable: true, writable: true, value: wrappedFn }); return true; } catch (_) {} return false; }

    function patchFullscreenRequest(video) {
      const st = getVState(video);
      if (!video || st.fsPatched) return;
      st.fsPatched = true;

      const origReq = video.requestFullscreen || video.webkitRequestFullscreen || video.msRequestFullscreen;
      if (!origReq) return;

      const runWrappedFs = (...args) => {
        const wrap = ensureFsWrapper(video);
        const cleanupIfNotFullscreen = () => {
          const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
          if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video);
        };

        if (wrap) {
          const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen;
          if (typeof req === 'function') {
            try {
              const ret = req.apply(wrap, args);
              if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; });
              return ret;
            } catch (err) { cleanupIfNotFullscreen(); throw err; }
          }
        }

        try {
          const ret = origReq.apply(video, args);
          if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; });
          return ret;
        } catch (err) { cleanupIfNotFullscreen(); throw err; }
      };

      if (video.requestFullscreen) patchMethodSafe(video, 'requestFullscreen', function (...args) { return runWrappedFs(...args); });
      if (video.webkitRequestFullscreen) patchMethodSafe(video, 'webkitRequestFullscreen', function (...args) { return runWrappedFs(...args); });
      if (video.msRequestFullscreen) patchMethodSafe(video, 'msRequestFullscreen', function (...args) { return runWrappedFs(...args); });
    }

    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
      if (!fsEl) {
        const rootBase = document.documentElement || document.body || document;
        for (const root of walkRoots(rootBase)) {
          const vids = root.querySelectorAll?.('video');
          if (!vids) continue;
          vids.forEach(v => { if (fsWraps.has(v)) restoreFromFsWrapper(v); });
        }
      }
      if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure();
    }
    onDoc('fullscreenchange', onFsChange); onDoc('webkitfullscreenchange', onFsChange);

    function findWebkitPiPVideo() {
      const rootBase = document.documentElement || document.body || document;
      for (const root of walkRoots(rootBase)) {
        const vids = root.querySelectorAll?.('video');
        if (!vids) continue;
        for (const v of vids) {
          try {
            if (typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture') return v;
          } catch (_) {}
        }
      }
      return null;
    }

    let __vscPiPCacheT = 0;
    let __vscPiPCacheV = null;
    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';

    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }

    function getActivePiPVideoSlow() {
      if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
      if (__activeDocumentPiPWindow && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo;
      try {
        if (typeof HTMLVideoElement !== 'undefined' && ('webkitPresentationMode' in HTMLVideoElement.prototype)) {
          const wk = findWebkitPiPVideo();
          if (wk) return wk;
        }
      } catch (_) {}
      return null;
    }

    function getActivePiPVideoCached() {
      const now = performance.now();
      if ((now - __vscPiPCacheT) < 200) return __vscPiPCacheV;
      __vscPiPCacheT = now;
      __vscPiPCacheV = getActivePiPVideoSlow();
      return __vscPiPCacheV;
    }

    function getActivePiPVideo() { return getActivePiPVideoCached(); }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideoCached()); }

    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      if ('documentPictureInPicture' in window && window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        if (__activeDocumentPiPWindow) return true;
        try {
          const pipWindow = await window.documentPictureInPicture.requestWindow({ width: Math.max(video.videoWidth / 2, 400), height: Math.max(video.videoHeight / 2, 225) });
          __activeDocumentPiPWindow = pipWindow; __activeDocumentPiPVideo = video; __pipOrigParent = video.parentNode; __pipOrigNext = video.nextSibling; __pipOrigCss = video.style.cssText;
          __pipPlaceholder = document.createElement('div'); __pipPlaceholder.style.width = video.clientWidth + 'px'; __pipPlaceholder.style.height = video.clientHeight + 'px'; __pipPlaceholder.style.background = 'black';
          if (__pipOrigParent) __pipOrigParent.insertBefore(__pipPlaceholder, video);
          pipWindow.document.body.style.margin = '0'; pipWindow.document.body.style.display = 'flex'; pipWindow.document.body.style.justifyContent = 'center'; pipWindow.document.body.style.alignItems = 'center'; pipWindow.document.body.style.background = 'black';
          video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
          pipWindow.document.body.append(video);
          pipWindow.addEventListener('click', () => { if (video.paused) { const p = video.play(); if (p && typeof p.catch === "function") p.catch(() => {}); } else { video.pause(); } });
          pipWindow.addEventListener('pagehide', () => {
            try {
              video.style.cssText = __pipOrigCss;
              if (__pipPlaceholder && __pipPlaceholder.parentNode) {
                __pipPlaceholder.parentNode.insertBefore(video, __pipPlaceholder); __pipPlaceholder.remove();
              } else if (__pipOrigParent) {
                if (__pipOrigNext && __pipOrigNext.parentNode === __pipOrigParent) { __pipOrigParent.insertBefore(video, __pipOrigNext); } else { __pipOrigParent.appendChild(video); }
              }
            } finally { resetPiPState(); }
          });
          return true;
        } catch (e) { log.debug('Document PiP failed, fallback to video PiP', e); }
      }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') { try { await video.requestPictureInPicture(); return true; } catch (e) { return false; } }
      if (typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture')) { try { video.webkitSetPresentationMode('picture-in-picture'); return true; } catch (e) { return false; } }
      return false;
    }
    async function exitPiP(preferredVideo = null) {
      if (__activeDocumentPiPWindow) { __activeDocumentPiPWindow.close(); return true; }
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); return true; } catch (_) {} }
      const candidates = []; if (preferredVideo) candidates.push(preferredVideo); const wk = findWebkitPiPVideo(); if (wk) candidates.push(wk);
      for (const v of candidates) { try { if (v && typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture' && typeof v.webkitSetPresentationMode === 'function') { v.webkitSetPresentationMode('inline'); return true; } } catch (_) {} }
      return false;
    }
    async function togglePiPFor(video) {
      if (!video || video.readyState < 2) return false;
      if (__activeDocumentPiPWindow || document.pictureInPictureElement === video) return exitPiP(video);
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} }
      return enterPiP(video);
    }

    function createZoomManager() {
      const stateMap = new WeakMap(); let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
      let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '' }; stateMap.set(v, st); } return st; };
      const update = (v) => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = null; const st = getSt(v); v.style.transition = isPanning || pinchState.active ? 'none' : 'transform 0.1s ease-out';
          if (st.scale <= 1) {
            st.scale = 1; st.tx = 0; st.ty = 0; v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = '';
            if (st.zoomed) { v.style.zIndex = st.origZIndex; v.style.position = st.origPosition; st.zoomed = false; }
          } else {
            if (!st.zoomed) { st.origZIndex = v.style.zIndex; st.origPosition = v.style.position; st.zoomed = true; }
            v.style.transformOrigin = '0 0'; v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`; v.style.cursor = isPanning ? 'grabbing' : 'grab'; v.style.zIndex = '2147483646';
            if (window.getComputedStyle(v).position === 'static') { v.style.position = 'relative'; }
          }
        });
      };
      const zoomTo = (v, newScale, clientX, clientY) => { const st = getSt(v), rect = v.getBoundingClientRect(), ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale; st.tx = clientX - (rect.left - st.tx) - ix * newScale; st.ty = clientY - (rect.top - st.ty) - iy * newScale; st.scale = newScale; update(v); };
      const resetZoom = (v) => { if (v) { const st = getSt(v); st.scale = 1; update(v); } };
      const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
      const isZoomEnabled = () => !!window.__VSC_INTERNAL__?.Store?.get(P.APP_ZOOM_EN);
      const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

      function getTargetVideo(e) {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
        if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } }
        const cx = Number.isFinite(e.clientX) ? e.clientX : (e.touches && Number.isFinite(e.touches[0]?.clientX) ? e.touches[0].clientX : innerWidth * 0.5);
        const cy = Number.isFinite(e.clientY) ? e.clientY : (e.touches && Number.isFinite(e.touches[0]?.clientY) ? e.touches[0].clientY : innerHeight * 0.5);
        const el = document.elementFromPoint(cx, cy);
        let v = el?.tagName === 'VIDEO' ? el : el?.closest?.('video') || null;
        if (!v && window.__VSC_INTERNAL__?.App) { v = window.__VSC_INTERNAL__.App.getActiveVideo(); }
        return v;
      }

      onWin('wheel', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const delta = e.deltaY > 0 ? 0.9 : 1.1, st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * delta), 10); if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY); }, { passive: false, capture: true });
      onWin('mousedown', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale > 1) { e.preventDefault(); e.stopPropagation(); activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty; update(v); } }, { capture: true });
      onWin('mousemove', e => { if (!isPanning || !activeVideo) return; e.preventDefault(); e.stopPropagation(); const st = getSt(activeVideo), dx = e.clientX - startX - st.tx, dy = e.clientY - startY - st.ty; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true; st.tx = e.clientX - startX; st.ty = e.clientY - startY; update(activeVideo); }, { capture: true });
      onWin('mouseup', e => { if (isPanning) { if (activeVideo) { const st = getSt(activeVideo); if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); } update(activeVideo); } isPanning = false; activeVideo = null; } }, { capture: true });
      onWin('dblclick', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v); }, { capture: true });
      onWin('touchstart', e => { if (CONFIG.IS_MOBILE && !isZoomEnabled()) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y; } else if (e.touches.length === 1 && st.scale > 1) { activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty; } }, { passive: false, capture: true });
      onWin('touchmove', e => { if (!activeVideo) return; const st = getSt(activeVideo); if (pinchState.active && e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches); let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10); if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; } else { zoomTo(activeVideo, newScale, center.x, center.y); st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy; update(activeVideo); } pinchState.lastCx = center.x; pinchState.lastCy = center.y; } else if (isPanning && e.touches.length === 1) { if (e.cancelable) e.preventDefault(); const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true; st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY; update(activeVideo); } }, { passive: false, capture: true });
      onWin('touchend', e => { if (!activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) { e.preventDefault(); } isPanning = false; update(activeVideo); activeVideo = null; } }, { passive: false, capture: true });
      return { resetZoom, zoomTo, isZoomed };
    }

    function createTargeting() {
      let stickyTarget = null;
      let stickyScore = -Infinity;
      let stickyUntil = 0;

      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now();
        const vp = getViewportSnapshot();
        let best = null, bestScore = -Infinity;

        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, now, 420);
          const area = r.width * r.height;
          const pip = isPiPActiveVideo(v);
          if (area < 160 * 120 && !pip) return;

          const cx = r.left + r.width * 0.5;
          const cy = r.top + r.height * 0.5;

          let s = 0;
          if (!v.paused && !v.ended) s += 6.0;
          if (v.currentTime > 0.2) s += 2.0;
          s += Math.log2(1 + area / 20000) * 1.1;

          const ptAge = Math.max(0, now - (lastUserPt.t || 0));
          const userBias = Math.exp(-ptAge / 1800);
          const dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
          s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500);

          const cdx = cx - vp.cx, cdy = cy - vp.cy;
          s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);

          if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
          if (pip) s += 3.0;

          if (s > bestScore) { bestScore = s; best = v; }
        };

        for (const v of videos) {
          evalScore(v);
        }

        const activePip = getActivePiPVideo();
        if (activePip && activePip.isConnected && !videos.has(activePip)) {
          evalScore(activePip);
        }

        if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
          if (best && stickyTarget !== best && (bestScore < stickyScore + RUNTIME_GUARD.targeting.hysteresisMargin)) {
            return { target: stickyTarget };
          }
        }

        stickyTarget = best;
        stickyScore = bestScore;
        stickyUntil = now + RUNTIME_GUARD.targeting.hysteresisMs;
        return { target: best };
      }
      return Object.freeze({ pickFastActiveOnly });
    }

    function createEventBus() {
      const subs = new Map();
      const on = (name, fn) => { let s = subs.get(name); if (!s) { s = new Set(); subs.set(name, s); } s.add(fn); return () => s.delete(fn); };
      const emit = (name, payload) => { const s = subs.get(name); if (!s) return; for (const fn of s) { try { fn(payload); } catch (_) {} } };
      let queued = false, flushTimer = 0, forceApplyAgg = false;
      function flush() { queued = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; } const payload = { forceApply: forceApplyAgg }; emit('signal', payload); forceApplyAgg = false; }
      const signal = (p) => { if (p) { if (p.forceApply) forceApplyAgg = true; } if (!queued) { queued = true; if (document.visibilityState === 'hidden') { flushTimer = setTimeout(flush, 0); } else { requestAnimationFrame(flush); } } };
      return Object.freeze({ on, signal });
    }

    function createApplyRequester(Bus, Scheduler) {
      return Object.freeze({
        soft() { try { Bus.signal(); } catch (_) { try { Scheduler.request(false); } catch (_) {} } },
        hard() { try { Bus.signal({ forceApply: true }); } catch (_) { try { Scheduler.request(true); } catch (_) {} } }
      });
    }

    function createUtils() {
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
          for (const [k, v] of Object.entries(props)) {
            if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), (e) => { if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation(); v(e); }); }
            else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
            else if (k === 'class') el.className = v; else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
          }
          children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); }); return el;
        },
        deepClone: (x) => (window.structuredClone ? structuredClone(x) : JSON.parse(JSON.stringify(x))),
        createLRU: (max = 384) => { const m = new Map(); return { get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); } } }
      };
    }

    function createFrameDriver() {
      let rafId = 0, timerId = 0, rvfcId = 0, lastVideo = null;
      function clear() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } if (timerId) { clearTimeout(timerId); timerId = 0; } if (lastVideo && rvfcId && typeof lastVideo.cancelVideoFrameCallback === 'function') { try { lastVideo.cancelVideoFrameCallback(rvfcId); } catch (_) {} } rvfcId = 0; }
      function scheduleVideoFrame(nextVideo, cb, fallback = 'raf', fallbackMs = 90) {
        clear(); lastVideo = nextVideo || null;
        if (lastVideo && !lastVideo.paused && typeof lastVideo.requestVideoFrameCallback === 'function') { try { rvfcId = lastVideo.requestVideoFrameCallback((now, meta) => { rvfcId = 0; cb(now, meta); }); return; } catch (_) {} }
        if (fallback === 'timeout') { timerId = setTimeout(() => { timerId = 0; cb(performance.now(), null); }, fallbackMs); } else { rafId = requestAnimationFrame((t) => { rafId = 0; cb(t, null); }); }
      }
      return Object.freeze({ clear, scheduleVideoFrame });
    }

    function patchInlineStyleImportant(el, patchObj) {
      const prev = new Map();
      for (const [prop, value] of Object.entries(patchObj)) { prev.set(prop, { val: el.style.getPropertyValue(prop), prio: el.style.getPropertyPriority(prop) }); el.style.setProperty(prop, value, 'important'); }
      return function restore() { for (const [prop, info] of prev.entries()) { if (info.val) el.style.setProperty(prop, info.val, info.prio || ''); else el.style.removeProperty(prop); } };
    }

    function composeBaseVideoParams(out, vUser) {
      const mix = VSC_CLAMP(vUser.presetMix ?? 1.0, 0, 1);
      const pD = PRESETS.detail[vUser.presetS] || PRESETS.detail.off;
      const pB = PRESETS.grade[vUser.presetB] || PRESETS.grade.brOFF;
      const preGammaF = lerp(1.0, pB.gammaF ?? 1.0, mix);
      const preBright = (pB.brightAdd || 0) * mix;
      let preSharp = (pD.sharpAdd || 0) * mix;
      let preSharp2 = (pD.sharp2Add || 0) * mix;
      let preClarity = (pD.clarityAdd || 0) * mix;

      out.gain = 1.0;
      out.gamma = preGammaF;
      out.contrast = 1.0;
      out.satF = 1.0;
      out.bright = preBright;
      out.temp = 0;
      out.mid = 0;
      out.toe = 0;
      out.shoulder = 0;
      out.sharp = Math.min(preSharp, 150);
      out.sharp2 = Math.min(preSharp2, 150);
      out.clarity = Math.min(preClarity, 150);
      return out;
    }

    function applyShadowBandStack(out, shadowBandMask) {
      const mask = (Number(shadowBandMask) | 0) & 7;
      if (!mask) return out;

      const bandTable = [
        { bit: SHADOW_BAND.OUTER, add: { toe: -1.0, mid: -0.010, bright: -0.5, gammaMul: 0.990, contrastMul: 1.015, satMul: 1.005 } },
        { bit: SHADOW_BAND.MID, add: { toe: -1.8, mid: -0.015, bright: -1.0, gammaMul: 0.980, contrastMul: 1.025, satMul: 1.010 } },
        { bit: SHADOW_BAND.DEEP, add: { toe: -3.0, mid: -0.005, bright: -0.5, gammaMul: 0.985, contrastMul: 1.020, satMul: 1.000 } }
      ];

      let toeAdd = 0, midAdd = 0, brightAdd = 0;
      let gammaMul = 1, contrastMul = 1, satMul = 1;

      for (const band of bandTable) {
        if (!ShadowMask.has(mask, band.bit)) continue;
        toeAdd += band.add.toe;
        midAdd += band.add.mid;
        brightAdd += band.add.bright;
        gammaMul *= band.add.gammaMul;
        contrastMul *= band.add.contrastMul;
        satMul *= band.add.satMul;
      }

      out.toe = (out.toe || 0) + toeAdd;
      out.mid = (out.mid || 0) + midAdd;
      out.bright = (out.bright || 0) + brightAdd;
      out.gamma = (out.gamma || 1) * gammaMul;
      out.contrast = (out.contrast || 1) * contrastMul;
      out.satF = (out.satF || 1) * satMul;

      return out;
    }

    function applyBrightStepStack(out, brightStepLevel) {
      const lvl = Math.max(0, Math.min(3, Math.round(Number(brightStepLevel) || 0)));
      if (!lvl) return out;

      const table = {
        1: { brightAdd: 1.8, gammaMul: 1.02, contrastMul: 0.995 },
        2: { brightAdd: 3.8, gammaMul: 1.05, contrastMul: 0.990 },
        3: { brightAdd: 6.0, gammaMul: 1.08, contrastMul: 0.985 }
      };
      const s = table[lvl];

      out.bright   = (out.bright || 0) + s.brightAdd;
      out.gamma    = (out.gamma || 1) * s.gammaMul;
      out.contrast = (out.contrast || 1) * s.contrastMul;
      return out;
    }

    function composeVideoParamsInto(out, vUser, isHdr) {
      composeBaseVideoParams(out, vUser);
      applyShadowBandStack(out, vUser.shadowBandMask);
      applyBrightStepStack(out, vUser.brightStepLevel);

      const autoMods = window.__VSC_INTERNAL__?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
      if (autoMods) {
        out.gain = (out.gain || 1.0) * autoMods.br;
        out.contrast = (out.contrast || 1.0) * autoMods.ct;
        out.satF = (out.satF || 1.0) * autoMods.sat;
      }

      if (isHdr) {
        out.bright = (out.bright || 0) * 0.65;
        out.contrast = 1.0 + ((out.contrast || 1.0) - 1.0) * 0.75;
        out.satF = 1.0 + ((out.satF || 1.0) - 1.0) * 0.85;
      }

      return out;
    }

    function projectVValsForWebGL(vVals) {
      const out = { ...vVals };
      const clamp = VSC_CLAMP;

      const sharp = Number(out.sharp || 0), sharp2 = Number(out.sharp2 || 0), clarity = Number(out.clarity || 0);
      let totalSharp = sharp + sharp2 * 0.40 + clarity * 0.18;
      out.sharp = clamp(totalSharp, 0, 150);

      out.bright   = Number(out.bright || 0);
      out.contrast = Number(out.contrast || 1);
      out.gamma    = Number(out.gamma || 1);

      out.sharp2 = 0;
      out.clarity = 0;

      out.toe = Number(out.toe || 0);
      out.mid = Number(out.mid || 0);
      out.shoulder = Number(out.shoulder || 0);

      return out;
    }

    const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

    function createVideoParamsMemo(Store, P, Utils) {
        let lastKey = '';
        let lastSvg = null;
        let lastWebgl = null;

        const sigVideo = (vf) => [
          vf.presetS, vf.presetB,
          Number(vf.presetMix).toFixed(3),
          (vf.shadowBandMask|0),
          (vf.brightStepLevel|0),
        ].join('|');

        return {
            get(vfUser, rMode, activeTarget) {
                const w = activeTarget ? (activeTarget.videoWidth || 0) : 0;
                const h = activeTarget ? (activeTarget.videoHeight || 0) : 0;
                const hdr = VSC_MEDIA.isHdr() ? 1 : 0;

                const autoMods = window.__VSC_INTERNAL__?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
                const autoKey = `${autoMods.br.toFixed(3)}|${autoMods.ct.toFixed(3)}|${autoMods.sat.toFixed(3)}`;

                const key = `${sigVideo(vfUser)}|${rMode}|${w}x${h}|hdr:${hdr}|auto:${autoKey}`;

                if (key === lastKey && lastSvg && lastWebgl) {
                    return rMode === 'webgl' ? lastWebgl : lastSvg;
                }
                const base = {};
                composeVideoParamsInto(base, vfUser, hdr === 1);

                base.sharp = Math.min(Number(base.sharp || 0), 36);

                const webgl = projectVValsForWebGL(base);

                lastSvg = base;
                lastWebgl = webgl;
                lastKey = key;

                return rMode === 'webgl' ? lastWebgl : lastSvg;
            }
        };
    }

    function createScheduler(minIntervalMs = 16) {
      let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
      function clearPending() { if (timer) { clearTimeout(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      function queueRaf() { if (rafId) return; rafId = requestAnimationFrame(run); }
      function timerCb() { timer = 0; queueRaf(); }
      function run() { rafId = 0; queued = false; const now = performance.now(), doForce = force; force = false; const dt = now - lastRun; if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; } lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} } }
      const request = (immediate = false) => { if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; } if (queued) return; queued = true; clearPending(); queueRaf(); };
      return { registerApply: (fn) => { applyFn = fn; }, request };
    }

    function createLocalStore(defaults, scheduler, Utils) {
      let rev = 0; const listeners = new Map();
      const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch (_) {} } const dot = key.indexOf('.'); if (dot > 0) { const catStar = key.slice(0, dot) + '.*'; const b = listeners.get(catStar); if (b) for (const cb of b) { try { cb(val); } catch (_) {} } } };
      const state = Utils.deepClone(defaults); const proxyCache = {}; const pathCache = Utils.createLRU(256); let batchDepth = 0, batchChanged = false; const batchEmits = new Map();
      const parsePath = (p) => { let hit = pathCache.get(p); if (hit) return hit; const dot = p.indexOf('.'); hit = (dot < 0) ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; pathCache.set(p, hit); return hit; };
      function invalidateProxyBranch(path) { if (!path) return; delete proxyCache[path]; const prefix = path + '.'; for (const k in proxyCache) { if (k.startsWith(prefix)) delete proxyCache[k]; } }

      function broadcastState(key, val) {
        if (key === P.APP_UI) return;
        try {
          const msg = { __vsc_sync: true, token: VSC_SYNC_TOKEN, p: key, val };
          if (window.top && window.top !== window.self) window.top.postMessage(msg, '*');
          const iframes = document.getElementsByTagName('iframe');
          for (let i = 0; i < iframes.length; i++) {
            try { iframes[i].contentWindow.postMessage(msg, '*'); } catch(_) {}
          }
        } catch (_) {}
      }

      function flushBatch() {
        if (!batchChanged) return; rev++;
        for (const [key, val] of batchEmits) { emit(key, val); broadcastState(key, val); }
        batchEmits.clear(); batchChanged = false; scheduler.request(false);
      }
      function notifyChange(fullPath, val) {
        if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; }
        rev++; emit(fullPath, val); scheduler.request(false);
        broadcastState(fullPath, val);
      }

      function createProxyDeep(obj, pathPrefix) { return new Proxy(obj, { get(target, prop) { const value = target[prop]; if (typeof value === 'object' && value !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(value, cacheKey); return proxyCache[cacheKey]; } return value; }, set(target, prop, val) { if (Object.is(target[prop], val)) return true; const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if ((typeof target[prop] === 'object' && target[prop] !== null) || (typeof val === 'object' && val !== null)) { invalidateProxyBranch(fullPath); } target[prop] = val; notifyChange(fullPath, val); return true; } }); }
      const proxyState = createProxyDeep(state, '');
      return { state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat], get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; }, set: (p, val) => { const [c, k] = parsePath(p); if (k == null) { proxyState[c] = val; return; } proxyState[c][k] = val; }, batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } finally { batchDepth--; if (batchDepth === 0) flushBatch(); } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); } };
    }

    function normalizeBySchema(sm, schema) {
      let changed = false;
      const setIfDiff = (path, val) => {
        if (!Object.is(sm.get(path), val)) {
          sm.set(path, val);
          changed = true;
        }
      };

      for (const rule of schema) {
        const type = rule.type;
        const path = rule.path;

        if (type === 'bool') {
          setIfDiff(path, !!sm.get(path));
          continue;
        }

        if (type === 'enum') {
          const cur = sm.get(path);
          if (!rule.values.includes(cur)) {
            setIfDiff(path, rule.fallback());
          }
          continue;
        }

        if (type === 'num') {
          let n = Number(sm.get(path));
          if (!Number.isFinite(n)) n = rule.fallback();
          if (rule.round) n = Math.round(n);
          n = Math.max(rule.min, Math.min(rule.max, n));
          setIfDiff(path, n);
          continue;
        }
      }

      return changed;
    }

    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
      const shadowRootsLRU = []; const SHADOW_LRU_MAX = PERF_POLICY.registry.shadowLRUMax; const observedShadowHosts = new WeakSet();
      let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }

      const io = (typeof IntersectionObserver === 'function')
        ? new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.ir = e.intersectionRatio || 0; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.01, rootMargin: '300px' })
        : null;

      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

      const ro = (typeof ResizeObserver === 'function')
        ? new ResizeObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); st.rect = e.contentRect ? el.getBoundingClientRect() : null; st.rectT = now; st.rectEpoch = -1; dirty.videos.add(el); changed = true; } if (changed) requestRefreshCoalesced(); })
        : null;

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
                visible.videos.add(el);
                dirty.videos.add(el);
                requestRefreshCoalesced();
            }
        }
        if (ro) { try { ro.observe(el); } catch (_) {} }
      };

      const WorkQ = (() => { const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap(); const isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling); function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); } const postTaskBg = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function') ? (fn) => globalThis.scheduler.postTask(fn, { priority: 'background' }) : null; const schedule = () => { if (scheduled) return; scheduled = true; if (postTaskBg) { postTaskBg(drainRunnerRaf).catch(() => { if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }); return; } if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }; const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); }; const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} } }; const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; const shouldYieldForInput = () => { try { return !!isInputPending?.({ includeContinuous: true }); } catch (_) { return false; } }; while (bigHead < bigQ.length && budget()) { if (shouldYieldForInput()) break; scanNode(bigQ[bigHead++]); break; } while (head < q.length && budget()) { if (shouldYieldForInput()) break; scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); }; return Object.freeze({ enqueue }); })();
      function nodeMayContainVideo(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') return true; if ((n.childElementCount || 0) === 0) return false; try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } } } try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; } }

      const observers = new Set();
      const connectObserver = (root) => { if (!root) return; const mo = new MutationObserver((muts) => { let touchedVideoTree = false; for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); if (!touchedVideoTree && nodeMayContainVideo(n)) touchedVideoTree = true; } } if (!touchedVideoTree && m.removedNodes && m.removedNodes.length) { for (const n of m.removedNodes) { if (!n || n.nodeType !== 1) continue; if (n.tagName === 'VIDEO') { touchedVideoTree = true; break; } if ((n.childElementCount || 0) > 0) { try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {} } } } } if (touchedVideoTree) requestRefreshCoalesced(); }); mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root); };
      const refreshObservers = () => {
          for (const o of observers) o.disconnect(); observers.clear();
          if (!FEATURE_FLAGS.trackShadowRoots) { const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } return; }
          for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); }
          const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); }
      };
      if (FEATURE_FLAGS.trackShadowRoots) { document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail; const host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} }); }
      refreshObservers();
      let pruneIterVideos = null; function pruneBatchRoundRobinNoAlloc(set, visibleSet, dirtySet, unobserveFn, batch = 200) { let removed = 0; let scanned = 0; if (!pruneIterVideos) pruneIterVideos = set.values(); while (scanned < batch) { let n = pruneIterVideos.next(); if (n.done) { pruneIterVideos = set.values(); n = pruneIterVideos.next(); if (n.done) break; } const el = n.value; if (el && !el.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} if (ro) { try { ro.unobserve(el); } catch (_) {} } removed++; } scanned++; } return removed; }

      return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneBatchRoundRobinNoAlloc(videos, visible.videos, dirty.videos, (el) => { if (io) io.unobserve(el); }, 220); if(removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { for (const r of walkRoots(document.body || document.documentElement)) { WorkQ.enqueue(r); } } };
    }

    function createAudio(sm) {
      let ctx, compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, clipper, target = null, currentSrc = null;
      let kWeightShelf, kWeightPass, analyser;
      let dataArray;
      let srcMap = new WeakMap();
      let makeupDbEma = 0;
      let switchTimer = 0, switchTok = 0;
      let gestureHooked = false;
      let loopTok = 0;

      const VSC_AUD_HPF_HZ = 28;
      const VSC_AUD_HPF_Q  = 0.707;

      const VSC_AUD_CLIP_KNEE  = 0.985;
      const VSC_AUD_CLIP_DRIVE = 6.0;

      let __vscClipCurve = null;
      function getSoftClipCurve() {
        if (__vscClipCurve) return __vscClipCurve;
        const n = 65536;
        const knee  = VSC_AUD_CLIP_KNEE;
        const drive = VSC_AUD_CLIP_DRIVE;
        const curve = new Float32Array(n);
        const tanhD = Math.tanh(drive);

        for (let i = 0; i < n; i++) {
          const x  = (i / (n - 1)) * 2 - 1;
          const ax = Math.abs(x);
          let y;
          if (ax <= knee) {
            y = x;
          } else {
            const t = (ax - knee) / Math.max(1e-6, (1 - knee));
            const s = Math.tanh(drive * t) / tanhD;
            y = Math.sign(x) * (knee + (1 - knee) * s);
          }
          curve[i] = y;
        }
        __vscClipCurve = curve;
        return curve;
      }

      const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') { await ctx.resume(); } if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
      const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; onWin('pointerdown', onGesture, { passive: true, capture: true }); onWin('keydown', onGesture, { passive: true, capture: true }); };

      const clamp = VSC_CLAMP;

      const VSC_AUDIO_AUTO_MAKEUP = true;

      function runAudioLoop(tok) {
        if (tok !== loopTok || !ctx) return;

        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const actuallyEnabled = en && currentSrc;

        if (VSC_AUDIO_AUTO_MAKEUP && actuallyEnabled && analyser) {
          analyser.getFloatTimeDomainData(dataArray);
          let sumSquare = 0;
          for(let i = 0; i < dataArray.length; i++) {
            sumSquare += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sumSquare / dataArray.length);
          const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;

          let redDb = 0;
          try {
            const r = compressor?.reduction;
            redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0;
          } catch (_) {}
          if (!Number.isFinite(redDb)) redDb = 0;
          const redPos = clamp(-redDb, 0, 18);

          let gateMult = 1.0;
          if (db < -45) {
            gateMult = 0.0;
          } else if (db < -40) {
            gateMult = (db - (-45)) / 5.0;
          }

          const makeupDbTarget = clamp(Math.max(0, redPos - 2.0) * 0.22, 0, 2.8) * gateMult;

          const isAttack = makeupDbTarget < makeupDbEma;
          const alpha = isAttack ? 0.35 : 0.015;
          makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;

        } else {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
        }

        const boostDb = Number(sm.get(P.A_BST) || 0);
        const userBoost = Math.pow(10, boostDb / 20);
        const makeup = Math.pow(10, makeupDbEma / 20);

        if (wetInGain) {
            const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0;
            try {
                wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05);
            } catch (_) {
                wetInGain.gain.value = finalGain;
            }
        }

        setTimeout(() => runAudioLoop(tok), 40);
      }

      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') {
          ctx = null; compressor = null; limiter = null; wetInGain = null;
          dryOut = null; wetOut = null; masterOut = null; hpf = null; clipper = null; currentSrc = null; target = null;
          kWeightShelf = null; kWeightPass = null; analyser = null; dataArray = null;
          srcMap = new WeakMap();
        }
        if (ctx) return true;

        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;

        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { ctx = new AC(); }
        ensureGestureResumeHook();

        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -22;
        compressor.knee.value = 24;
        compressor.ratio.value = 2.6;
        compressor.attack.value = 0.012;
        compressor.release.value = 0.25;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.2;
        limiter.knee.value = 0.0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0015;
        limiter.release.value = 0.09;

        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = VSC_AUD_HPF_HZ;
        hpf.Q.value = VSC_AUD_HPF_Q;

        clipper = ctx.createWaveShaper();
        clipper.curve = getSoftClipCurve();
        try { clipper.oversample = '4x'; } catch (_) {}

        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.fftSize);

        kWeightShelf = ctx.createBiquadFilter();
        kWeightShelf.type = 'highshelf';
        kWeightShelf.frequency.value = 1500;
        kWeightShelf.gain.value = 4.0;

        kWeightPass = ctx.createBiquadFilter();
        kWeightPass.type = 'highpass';
        kWeightPass.frequency.value = 38;
        kWeightPass.Q.value = 0.5;

        dryOut = ctx.createGain();
        wetOut = ctx.createGain();
        wetInGain = ctx.createGain();
        masterOut = ctx.createGain();

        masterOut.connect(ctx.destination);
        dryOut.connect(masterOut);
        wetOut.connect(masterOut);

        hpf.connect(compressor);
        compressor.connect(wetInGain);
        wetInGain.connect(limiter);
        limiter.connect(clipper);
        clipper.connect(wetOut);

        kWeightShelf.connect(kWeightPass);
        kWeightPass.connect(analyser);

        return true;
      };

      const rampGainsSafe = (dryTarget, wetTarget, tc = 0.015) => {
        if (!ctx) return;
        const t = ctx.currentTime;
        try {
          dryOut.gain.cancelScheduledValues(t);
          wetOut.gain.cancelScheduledValues(t);
          dryOut.gain.setTargetAtTime(dryTarget, t, tc);
          wetOut.gain.setTargetAtTime(wetTarget, t, tc);
        } catch (_) {
          dryOut.gain.value = dryTarget;
          wetOut.gain.value = wetTarget;
        }
      };

      const fadeOutThen = (fn) => {
        if (!ctx) { fn(); return; }
        const tok = ++switchTok;
        clearTimeout(switchTimer);

        const t = ctx.currentTime;
        try {
          masterOut.gain.cancelScheduledValues(t);
          masterOut.gain.setValueAtTime(masterOut.gain.value, t);
          masterOut.gain.linearRampToValueAtTime(0, t + 0.04);
        } catch (_) { masterOut.gain.value = 0; }

        switchTimer = setTimeout(() => {
          if (tok !== switchTok) return;
          makeupDbEma = 0;
          try { fn(); } catch (_) {}
          if (ctx) {
            const t2 = ctx.currentTime;
            try {
              masterOut.gain.cancelScheduledValues(t2);
              masterOut.gain.setValueAtTime(0, t2);
              masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04);
            } catch (_) { masterOut.gain.value = 1; }
          }
        }, 60);
      };

      const disconnectAll = () => {
        if (currentSrc) {
          try { currentSrc.disconnect(); } catch (_) {}
        }
        currentSrc = null;
        target = null;
      };

      const updateMix = () => {
        if (!ctx) return;

        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const isHooked = !!currentSrc;
        const actuallyEnabled = en && isHooked;

        const dryTarget = actuallyEnabled ? 0 : 1;
        const wetTarget = actuallyEnabled ? 1 : 0;

        rampGainsSafe(dryTarget, wetTarget, 0.015);

        loopTok++;
        if (actuallyEnabled) {
            runAudioLoop(loopTok);
        }
      };

      async function destroy() {
        try { fadeOutThen(() => disconnectAll()); } catch (_) {}
        try {
          if (gestureHooked) {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
            gestureHooked = false;
          }
        } catch (_) {}

        loopTok++;
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        ctx = null; compressor = null; limiter = null; wetInGain = null;
        dryOut = null; wetOut = null; masterOut = null; hpf = null; clipper = null; currentSrc = null; target = null;
        kWeightShelf = null; kWeightPass = null; analyser = null; dataArray = null;
        makeupDbEma = 0; switchTok++;
        srcMap = new WeakMap();
      }

      return {
        setTarget: (v) => {
          const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
          const st = v ? getVState(v) : null;

          if (st && st.audioFailUntil > performance.now()) {
            if (v !== target) {
              fadeOutThen(() => { disconnectAll(); target = v; });
            }
            updateMix();
            return;
          }

          if (!ensureCtx()) return;

          if (v === target) {
            updateMix();
            return;
          }

          fadeOutThen(() => {
            disconnectAll();
            target = v;

            if (!v) { updateMix(); return; }

            try {
              let s = srcMap.get(v);
              if (!s) {
                s = ctx.createMediaElementSource(v);
                srcMap.set(v, s);
              }

              s.connect(dryOut);
              s.connect(hpf || compressor);
              if (kWeightShelf) s.connect(kWeightShelf);

              currentSrc = s;
            } catch (_) {
              if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + RUNTIME_GUARD.audio.createSourceCooldownMs;
              disconnectAll();
            }

            updateMix();
          });
        },
        update: updateMix,
        hasCtx: () => !!ctx,
        isHooked: () => !!currentSrc,
        destroy
      };
    }
function createAutoSceneManager(Store, P, Scheduler) {
      const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };
      const clamp = VSC_CLAMP;
      const approach = (cur, tgt, a, dead=0.002) => { const d = tgt - cur; return Math.abs(d) < dead ? tgt : cur + d * a; };

      const AUTO = {
        running: false,
        canvasW: 64, canvasH: 36,
        cur: { br: 1.0, ct: 1.0, sat: 1.0 },
        tgt: { br: 1.0, ct: 1.0, sat: 1.0 },
        lastSig: null,
        cutHist: [],
        motionEma: 0, motionAlpha: 0.30, motionThresh: 0.0075, motionFrames: 0, motionMinFrames: 5,
        statsEma: null, statsAlpha: 0.12,
        drmBlocked: false, blockUntilMs: 0,
        tBoostUntil: 0, tBoostStart: 0, boostMs: 800, minBoostEarlyMs: 700,
        fpsHist: [], minFps: 1, maxFps: 6, curFps: 1,
        _lumaN: 0, _lumaA: null, _lumaB: null, _lumaFlip: 0
      };

      const c = document.createElement('canvas');
      c.width = AUTO.canvasW; c.height = AUTO.canvasH;
      let ctx = null;
      try { ctx = c.getContext('2d', { willReadFrequently: true, desynchronized: true, alpha: false, colorSpace: 'srgb' }); } catch (_) {
        try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch (__) {}
      }

      function ensureLumaBuffers(AUTO, n) {
        if (AUTO._lumaN !== n) {
          AUTO._lumaN = n;
          AUTO._lumaA = new Uint8Array(n);
          AUTO._lumaB = new Uint8Array(n);
          AUTO._lumaFlip = 0;
        }
      }

      function computeStatsAndMotion(AUTO, img, sw, sh) {
        const data = img.data;
        const n = sw * sh;
        ensureLumaBuffers(AUTO, n);

        const cur = (AUTO._lumaFlip === 0) ? AUTO._lumaA : AUTO._lumaB;
        const prev = (AUTO._lumaFlip === 0) ? AUTO._lumaB : AUTO._lumaA;

        let sum = 0, sum2 = 0, sumEdge = 0;
        let diffSum = 0;
        let sumChroma = 0;

        for (let y = 0; y < sh; y += 2) {
          let row = y * sw;
          let idx = (y * sw) * 4;
          for (let x = 0; x < sw; x += 2) {
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            const l = (r * 0.2126 + g * 0.7152 + b * 0.0722) | 0;

            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
            sumChroma += (max - min);

            const p = row + x;
            cur[p] = l;

            sum += l;
            sum2 += l * l;

            if (x + 2 < sw) {
              const r2 = data[idx + 8], g2 = data[idx + 9], b2 = data[idx + 10];
              const l2 = (r2 * 0.2126 + g2 * 0.7152 + b2 * 0.0722) | 0;
              sumEdge += Math.abs(l2 - l);
            }
            if (y + 2 < sh) {
              const idxD = idx + (sw * 2 * 4);
              const r3 = data[idxD], g3 = data[idxD + 1], b3 = data[idxD + 2];
              const l3 = (r3 * 0.2126 + g3 * 0.7152 + b3 * 0.0722) | 0;
              sumEdge += Math.abs(l3 - l);
            }

            diffSum += Math.abs(l - prev[p]);
            idx += 8;
          }
        }

        AUTO._lumaFlip ^= 1;

        const samples = Math.max(1, ((sw + 1) >> 1) * ((sh + 1) >> 1));
        const mean = sum / samples;
        const var_ = (sum2 / samples) - mean * mean;
        const std = Math.sqrt(Math.max(0, var_));

        const edge = sumEdge / samples;
        const motion = diffSum / samples;

        const bright = mean / 255;
        const contrast = std / 64;
        const chroma = (sumChroma / samples) / 255;

        return { bright, contrast, chroma, edge, motion };
      }

      function detectCut(stats) {
        if (!AUTO.lastSig) return false;

        const score = (Math.abs(stats.bright - AUTO.lastSig.bright) * 1.1) + (Math.abs(stats.contrast - AUTO.lastSig.contrast) * 0.9);
        AUTO.cutHist.push(score);
        if (AUTO.cutHist.length > 20) AUTO.cutHist.shift();
        const sorted = AUTO.cutHist.slice().sort((a,b)=>a-b);
        const q80 = sorted[Math.floor(sorted.length * 0.80)] || 0.14;
        const thr = Math.max(0.10, Math.min(0.22, q80 * 1.05));
        return score > thr;
      }

      function calculateAdaptiveFps(changeScore) {
        AUTO.fpsHist.push(changeScore);
        if (AUTO.fpsHist.length > 5) AUTO.fpsHist.shift();
        const avgChange = AUTO.fpsHist.reduce((a, b) => a + b, 0) / AUTO.fpsHist.length;
        const targetFps = (avgChange < 0.1 ? 2 + (avgChange/0.1)*2 : 0) + (avgChange >= 0.1 && avgChange < 0.3 ? 4 + ((avgChange-0.1)/0.2)*3 : 0) + (avgChange >= 0.3 ? 7 + (Math.min(avgChange-0.3,0.7)/0.7)*3 : 0);
        const clamped = clamp(targetFps, AUTO.minFps, AUTO.maxFps);
        const rounded = Math.round(clamped * 2) / 2;
        AUTO.curFps += clamp(rounded - AUTO.curFps, -1, 1);
        return AUTO.curFps;
      }

      let __asRvfcId = 0;
      function scheduleNext(v, delayMs) {
        if (!AUTO.running) return;
        if (v && !v.paused && typeof v.requestVideoFrameCallback === 'function') {
          const target = performance.now() + Math.max(0, delayMs|0);
          try { if (__asRvfcId && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
          __asRvfcId = v.requestVideoFrameCallback(() => {
            __asRvfcId = 0;
            const remain = target - performance.now();
            if (remain > 6) { scheduleNext(v, remain); return; }
            loop();
          });
          return;
        }
        setTimeout(loop, Math.max(16, delayMs|0));
      }

      function loop() {
        if (!AUTO.running) return;
        const now = performance.now();
        const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);

        const v = window.__VSC_APP__?.getActiveVideo?.();

        if (!en) {
          AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0 };
          scheduleNext(v, 500);
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

        if (!v || !ctx || v.paused || v.seeking || v.readyState < 2) {
          try { Scheduler.request(true); } catch (_) {}
          scheduleNext(v, 300);
          return;
        }

        const useW = 64, useH = 36;

        try {
          if (c.width !== useW || c.height !== useH) {
            c.width = useW; c.height = useH;
            AUTO.canvasW = useW; AUTO.canvasH = useH;
          }

          ctx.drawImage(v, 0, 0, useW, useH);
          const img = ctx.getImageData(0, 0, useW, useH);
          AUTO.drmBlocked = false;

          const stats = computeStatsAndMotion(AUTO, img, useW, useH);

          AUTO.motionEma = (AUTO.motionEma * (1 - AUTO.motionAlpha)) + (stats.motion * AUTO.motionAlpha);
          AUTO.motionFrames = (AUTO.motionEma >= AUTO.motionThresh) ? (AUTO.motionFrames + 1) : 0;

          const isCut = detectCut(stats);
          AUTO.lastSig = stats;

          if (!AUTO.statsEma) AUTO.statsEma = { ...stats };
          else {
            const e = AUTO.statsEma, a = AUTO.statsAlpha;
            e.bright = e.bright*(1-a) + stats.bright*a; e.contrast = e.contrast*(1-a) + stats.contrast*a; e.edge = e.edge*(1-a) + stats.edge*a;
          }
          const sig = AUTO.statsEma;

          if (isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; }

          const allowUpdate = isCut || (AUTO.motionFrames >= AUTO.motionMinFrames);
          let fps = AUTO.curFps;

          if (allowUpdate) {
            fps = calculateAdaptiveFps(clamp(stats.motion||0,0,1));
            fps = Math.min(fps, 6);
            if (now < AUTO.tBoostUntil) fps = Math.max(fps, (now - AUTO.tBoostStart < AUTO.minBoostEarlyMs) ? 6 : 4);

            const errY = clamp(0.50 - sig.bright, -0.22, 0.22);
            const errSd = clamp(0.23 - sig.contrast, -0.18, 0.18);

            AUTO.tgt.br = clamp(1.12 + errY * 0.98, 0.92, 1.35);
            AUTO.tgt.ct = clamp(1.0 + (-errSd) * 0.85, 0.82, 1.30);

            const curCh = Number(sig.chroma || 0);
            const errCh = clamp(0.18 - curCh, -0.18, 0.18);
            AUTO.tgt.sat = clamp(1.08 + errCh * 1.10, 0.85, 1.50);

            const smoothA = isCut ? 0.16 : 0.05;
            const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat;

            AUTO.cur.br = approach(AUTO.cur.br, AUTO.tgt.br, smoothA);
            AUTO.cur.ct = approach(AUTO.cur.ct, AUTO.tgt.ct, smoothA);
            AUTO.cur.sat = approach(AUTO.cur.sat, AUTO.tgt.sat, smoothA);

            if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001) {
              Scheduler.request(true);
            }
          }

          scheduleNext(v, Math.max(150, Math.round(1000 / Math.max(1, fps))));
        } catch (e) {
          if (VSC_DEFENSE.autoSceneDrmBackoff) {
            AUTO.drmBlocked = true;
            AUTO.blockUntilMs = performance.now() + 5000;
            scheduleNext(v, 1000);
          } else {
            scheduleNext(v, 500);
          }
        }
      }

      Store.sub(P.APP_AUTO_SCENE, (en) => {
        if (en && !AUTO.running) { AUTO.running = true; loop(); }
        else if (!en) { AUTO.running = false; AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0 }; Scheduler.request(true); }
      });
      Store.sub(P.APP_ACT, (en) => {
        if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { AUTO.running = true; loop(); }
      });

      return {
        getMods: () => AUTO.cur,
        start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { AUTO.running = true; loop(); } },
        stop: () => { AUTO.running = false; }
      };
    }

    // ⭐ v170.7.0 엔진: 수학적 정밀도가 복구된 LUT 병합 및 타겟팅 업데이트 + CAS Full-Bypass 최적화
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createLRU } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(720);
      const qInt = (v, step) => Math.round(v / step);
      const setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; node.setAttribute(attr, val); } };
      const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };

      function wantsDetailPass(s) { return (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)) > 0; }
      const makeKeyBase = (s) => [ qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2) ].join('|');

      function getToneTableCached(steps, toeN, shoulderN, midN, gain, contrast, brightOffset, gamma) {
        const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(gain,0.06)}|${contrast.toFixed(2)}|${brightOffset.toFixed(2)}|${gamma.toFixed(2)}`;
        const hit = toneCache.get(key); if (hit) return hit;

        const toeEnd = 0.34 + Math.abs(toeN) * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1;
        const shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN);
        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const out = new Array(steps); let prev = 0;

        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = 1.0 / Math.max(0.1, gamma);

        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1);
          let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
          if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); }
          if (shAmt > 1e-6 && x > shoulderStart) { const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)); const kk = Math.max(0.7, 1.2 + shAmt * 6.5); const shDen = (1 - Math.exp(-kk)); const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt; x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1); }

          x = x * contrast + intercept;
          x = clamp(x, 0, 1);
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);

          if (x < prev) x = prev; prev = x;
          const yy = Math.round(x * 10000) / 10000;
          out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      function makeSoftKneeTable(steps, th, knee, gammaPow = 1.0, floor = 0.0, ceil = 1.0) { const out = new Array(steps); const a = Math.max(0, th - knee); const b = Math.min(1, th + knee); for (let i = 0; i < steps; i++) { const x = i / (steps - 1); let y = smoothstep(a, b, x); y = Math.pow(y, gammaPow); y = floor + (ceil - floor) * y; y = Math.max(0, Math.min(1, y)); out[i] = String(Math.round(y * 100000) / 100000); } return out.join(' '); }
      function makeHighlightKeepTable(steps, start = 0.68, end = 0.92, reduce = 0.45) { const out = new Array(steps); for (let i = 0; i < steps; i++) { const x = i / (steps - 1); const hi = smoothstep(start, end, x); const keep = 1 - hi * reduce; out[i] = String(Math.round(Math.max(0, Math.min(1, keep)) * 100000) / 100000); } return out.join(' '); }

      const mkXfer = (attrs, childAttrs) => h('feComponentTransfer', { ns: 'svg', ...attrs }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', ...childAttrs })));

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const fidLite = `vsc-lite-${config.VSC_ID}`, fidMid  = `vsc-mid-${config.VSC_ID}`, fidFull = `vsc-full-${config.VSC_ID}`;

        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' });
        const toneLite  = mkXfer({ result: 'base' }, { type: 'table', tableValues: '0 1' });
        const tmpLite   = mkXfer({ in: 'base', result: 'tmp' }, { type: 'linear', slope: '1' });
        const satLite   = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
        lite.append(toneLite, tmpLite, satLite);

        const mid = h('filter', { ns: 'svg', id: fidMid, 'color-interpolation-filters': 'sRGB', x: '-2%', y: '-2%', width: '104%', height: '104%' });
        const toneMid = mkXfer({ result: 'base' }, { type: 'table', tableValues: '0 1' });
        const convMid = h('feConvolveMatrix', { ns: 'svg', in: 'base', order: '3', kernelMatrix: '0 0 0  0 1 0  0 0 0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'sharp' });
        const tmpMid = mkXfer({ in: 'sharp', result: 'tmp' }, { type: 'linear', slope: '1' });
        const satMid = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
        mid.append(toneMid, convMid, tmpMid, satMid);

        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '-15%', y: '-15%', width: '130%', height: '130%' });
        const tone  = mkXfer({ result: 'base' }, { type: 'table', tableValues: '0 1' });

        const lumBase = h('feColorMatrix', { ns: 'svg', in: 'base', type: 'matrix', values: '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0', result: 'lumBase' });
        const rngMax = h('feMorphology', { ns: 'svg', in: 'lumBase', operator: 'dilate', radius: '0', result: 'rngMax' });
        const rngMin = h('feMorphology', { ns: 'svg', in: 'lumBase', operator: 'erode', radius: '0', result: 'rngMin' });
        const rng = h('feComposite', { ns: 'svg', in: 'rngMax', in2: 'rngMin', operator: 'arithmetic', k2: '1', k3: '-1', result: 'rng' });
        const rngBlur = h('feGaussianBlur', { ns: 'svg', in: 'rng', stdDeviation: '0', result: 'rngBlur' });

        const edgeGate = mkXfer({ in: 'rngBlur', result: 'edgeGate' }, { type: 'table', tableValues: '0 1' });
        const hlKeep   = mkXfer({ in: 'lumBase', result: 'hlKeep' }, { type: 'table', tableValues: '1 1' });
        const gate = h('feBlend', { ns: 'svg', in: 'edgeGate', in2: 'hlKeep', mode: 'multiply', result: 'gate' });

        const b1  = h('feGaussianBlur', { ns: 'svg', in: 'base', stdDeviation: '0', result: 'b1' });
        const sh1 = h('feComposite', { ns: 'svg', in: 'base', in2: 'b1', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh1' });
        const b2  = h('feGaussianBlur', { ns: 'svg', in: 'sh1', stdDeviation: '0', result: 'b2' });
        const sh2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'b2', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh2' });
        const bc  = h('feGaussianBlur', { ns: 'svg', in: 'sh2', stdDeviation: '0', result: 'bc' });
        const cl  = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'bc', operator: 'arithmetic', k2: '1', result: 'cl' });

        const sharpDesat = h('feColorMatrix', { ns: 'svg', in: 'cl', type: 'saturate', values: '0.55', result: 'sharpDesat' });
        const sharpBiased = h('feComposite', { ns: 'svg', in: 'cl', in2: 'sharpDesat', operator: 'arithmetic', k2: '0.25', k3: '0.75', result: 'sharpBiased' });

        const invGate = mkXfer({ in: 'gate', result: 'invGate' }, { type: 'table', tableValues: '1 0' });
        const gamMasked   = h('feComposite', { ns: 'svg', in: 'base', in2: 'invGate', operator: 'arithmetic', k1: '1', result: 'gamMasked' });
        const sharpMasked = h('feComposite', { ns: 'svg', in: 'sharpBiased', in2: 'gate', operator: 'arithmetic', k1: '1', result: 'sharpMasked' });
        const mixedSharpSum = h('feComposite', { ns: 'svg', in: 'gamMasked', in2: 'sharpMasked', operator: 'arithmetic', k2: '1', k3: '1', result: 'mixedSharpSum' });

        const tmp = mkXfer({ in: 'mixedSharpSum', result: 'tmp' }, { type: 'linear', slope: '1', intercept: '0' });
        const sat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });

        full.append(tone, lumBase, rngMax, rngMin, rng, rngBlur, edgeGate, hlKeep, gate, b1, sh1, b2, sh2, bc, cl, sharpDesat, sharpBiased, invGate, gamMasked, sharpMasked, mixedSharpSum, tmp, sat);
        defs.append(lite, mid, full);

        const tryAppend = () => { const target = root.body || root.documentElement || root; if (target && target.appendChild) { target.appendChild(svg); return true; } return false; };
        if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }

        return {
          fidLite, fidMid, fidFull,
          lite: { toneFuncs: Array.from(toneLite.children), tmpFuncs: Array.from(tmpLite.children), sat: satLite },
          mid: { toneFuncs: Array.from(toneMid.children), tmpFuncs: Array.from(tmpMid.children), sat: satMid, convMid },
          full: { toneFuncs: Array.from(tone.children), tmpFuncs: Array.from(tmp.children), sat, detail: { b1, sh1, b2, sh2, bc, cl }, casLike: { rngMax, rngMin, rngBlur, edgeGateFuncs: Array.from(edgeGate.children), hlKeepFuncs: Array.from(hlKeep.children), sharpDesat, sharpBiased } },
          st: { lastKey: '', toneKey: '', tempKey: '', satKey: '', detailKey: '', midConvKey: '', casKey: '', morphKey: '', edgeGateTable: '', hlKeepTable: '', __b1: '', __sh1k2: '', __sh1k3: '', __b2: '', __sh2k2: '', __sh2k3: '', __bc: '', __clk2: '', __clk3: '', __rngMaxR: '', __rngMinR: '', __rngBlur: '', __sharpDesatSat: '', __sharpBiasK2: '', __sharpBiasK3: '' }
        };
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key:'', url:'' }; urlCache.set(root, dc); }
        const detailOn = wantsDetailPass(s);
        const vwKey = video.videoWidth || 0, vhKey = video.videoHeight || 0;
        const pixels = Math.max(1, vwKey * vhKey), isHighRes = pixels > 1280 * 720, isUltraRes = pixels > 1920 * 1080;

        let filterGrade = 'L';
        if (detailOn) { if (isUltraRes || config.IS_LOW_END) filterGrade = 'M'; else if (isHighRes) filterGrade = 'M'; else filterGrade = 'F'; }

        const key = `${filterGrade}|${vwKey}x${vhKey}|${makeKeyBase(s)}`;
        if (dc.key === key) return dc.url;
        let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }

        if (ctx.st.lastKey !== key) {
          ctx.st.lastKey = key; const st = ctx.st, steps = 128;

          const con = clamp(s.contrast || 1, 0.1, 5.0), brOff = clamp((s.bright || 0) / 1000, -0.5, 0.5), gamma = 1/clamp(s.gamma||1, 0.1, 5.0);
          const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(s.gain||1,0.06)}|${con.toFixed(2)}|${brOff.toFixed(2)}|${gamma.toFixed(2)}`;
          const table = (st.toneKey !== tk) ? getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.gain||1,0.06)*0.06, con, brOff, gamma) : st.toneTable;

          const satVal = clamp(s.satF ?? 1, 0, 5.0).toFixed(2);
          const { rs, gs, bs } = tempToRgbGain(s.temp); const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`;

          const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
          let sharpTotal = Math.max(0, Math.min((s.sharp || 0) + (s.sharp2 || 0) + (s.clarity || 0), 150));
          const vw = video.videoWidth || 0, vh = video.videoHeight || 0, pxScale = Math.sqrt((Math.max(1, vw * vh)) / (1280 * 720));
          const sharpN = Math.max(0, Math.min(1, sharpTotal / 110)), hiResN = Math.max(0, Math.min(1, (pxScale - 1.0) / 1.7));
          const brightLiftN = Math.max(0, Math.min(1, (s.bright || 0) / 12)), gammaLiftN = Math.max(0, Math.min(1, ((s.gamma || 1) - 1.0) / 0.18)), contrastN = Math.max(0, Math.min(1, ((s.contrast || 1) - 1.0) / 0.35)), liftRiskN = Math.max(brightLiftN, gammaLiftN * 0.9);

          let morphRadius = 0; if (filterGrade === 'F' && sharpN > 0.45 && pxScale < 1.3) morphRadius = 1;
          const rngBlurStd = morphRadius > 0 ? Math.max(0.35, Math.min(0.60, 0.40 + sharpN * 0.10)) : 0;
          const th = Math.max(0.010, Math.min(0.034, 0.020 - sharpN * 0.010 + liftRiskN * 0.010 + (1 - contrastN) * 0.002)), knee = Math.max(0.016, Math.min(0.060, 0.024 + sharpN * 0.018 + liftRiskN * 0.010 + hiResN * 0.006)), gateGamma = Math.max(0.78, Math.min(1.08, 1.02 - sharpN * 0.22 + liftRiskN * 0.08)), gateFloor = Math.max(0.006, Math.min(0.028, 0.010 + sharpN * 0.010 + liftRiskN * 0.006 + (1 - hiResN) * 0.004)), gateCeil = 1.0;
          const edgeGateTable = makeSoftKneeTable(64, th, knee, gateGamma, gateFloor, gateCeil);

          let hlStart = Math.max(0.56, Math.min(0.84, 0.70 - brightLiftN * 0.08 - gammaLiftN * 0.07 - sharpN * 0.03)), hlEnd = Math.max(hlStart + 0.10, Math.min(0.97, 0.92 - brightLiftN * 0.02 + hiResN * 0.01));
          const hlKeepTable = makeHighlightKeepTable(64, hlStart, hlEnd, 0.15);
          const desatSat = Math.max(0.55, Math.min(0.82, 0.62 + (1 - sharpN) * 0.12 + liftRiskN * 0.04)), chromaKeep = Math.max(0.24, Math.min(0.42, 0.30 + (1 - sharpN) * 0.08 - liftRiskN * 0.02));
          const ck = [ sharpTotal.toFixed(2), (s.bright || 0).toFixed(2), (s.gamma || 1).toFixed(3), (s.contrast || 1).toFixed(3), vw, vh ].join('|');

          queueMicrotask(() => {
            const activeNodes = filterGrade === 'F' ? ctx.full : filterGrade === 'M' ? ctx.mid : ctx.lite;

            if (st.toneKey !== tk) { st.toneKey = tk; st.toneTable = table; for (const fn of activeNodes.toneFuncs) fn.setAttribute('tableValues', table); }
            if (st.satKey !== satVal) { st.satKey = satVal; activeNodes.sat.setAttribute('values', satVal); }
            if (st.tempKey !== tmk) { st.tempKey = tmk; activeNodes.tmpFuncs[0].setAttribute('slope', rs); activeNodes.tmpFuncs[1].setAttribute('slope', gs); activeNodes.tmpFuncs[2].setAttribute('slope', bs); }

            if (filterGrade === 'M' && detailOn) {
              const mk = `${s.sharp}|${s.sharp2}|${s.clarity}`;
              if (st.midConvKey !== mk) {
                st.midConvKey = mk;

                // WebGL rcasDirectionalSharpen의 실효 강도와 매칭
                const rawS = ((s.sharp || 0) + (s.sharp2 || 0) * 0.40 + (s.clarity || 0) * 0.18) / 50.0;
                const totalS = Math.min(0.65, rawS * 0.30);

                if (totalS > 0.008) {
                  const center = 1.0 + 4.0 * totalS;
                  const edge = -totalS;
                  ctx.mid.convMid.setAttribute('kernelMatrix',
                    `0 ${edge.toFixed(4)} 0  ${edge.toFixed(4)} ${center.toFixed(4)} ${edge.toFixed(4)}  0 ${edge.toFixed(4)} 0`);
                } else {
                  ctx.mid.convMid.setAttribute('kernelMatrix', '0 0 0  0 1 0  0 0 0');
                }
              }
            }

            if (filterGrade === 'F' && detailOn) {
              const fn = ctx.full;
              if (st.detailKey !== dk) {
                st.detailKey = dk;
                const sc = (x) => x * x * (3 - 2 * x);

                // ✨ WebGL 매칭: 기존 대비 0.55 감쇠
                const v1 = (s.sharp || 0) / 50 * 0.55;
                const kC = sc(Math.min(1, v1)) * 2.2;
                setAttr(fn.detail.b1, 'stdDeviation', v1 > 0 ? (0.65 - sc(Math.min(1, v1)) * 0.2).toFixed(2) : '0', st, '__b1');
                setAttr(fn.detail.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2');
                setAttr(fn.detail.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3');

                const v2 = (s.sharp2 || 0) / 50 * 0.55;
                const kF = sc(Math.min(1, v2)) * 4.8;
                setAttr(fn.detail.b2, 'stdDeviation', v2 > 0 ? '0.25' : '0', st, '__b2');
                setAttr(fn.detail.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2');
                setAttr(fn.detail.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3');

                const clVal = (s.clarity || 0) / 50 * 0.55;
                const clStd = clVal > 0 ? (0.85 + hiResN * 0.55).toFixed(2) : '0';
                const clGain = (1 + clVal * (1.15 + hiResN * 0.55));
                setAttr(fn.detail.bc, 'stdDeviation', clStd, st, '__bc');
                setAttr(fn.detail.cl, 'k2', clGain.toFixed(3), st, '__clk2');
                setAttr(fn.detail.cl, 'k3', (-(clGain - 1)).toFixed(3), st, '__clk3');
              }

              if (st.casKey !== ck) {
                st.casKey = ck;

                // ✨ Full-Bypass 로직: morphRadius가 0일 때 하류 노드까지 완전히 항등 연산(Identity) 처리
                if (morphRadius === 0) {
                  const morphKey = '0';
                  if (st.morphKey !== morphKey) {
                    st.morphKey = morphKey;
                    setAttr(fn.casLike.rngMax, 'radius', '0', st, '__rngMaxR');
                    setAttr(fn.casLike.rngMin, 'radius', '0', st, '__rngMinR');
                  }
                  if (st.__rngBlur !== '0') {
                    st.__rngBlur = '0';
                    fn.casLike.rngBlur.setAttribute('stdDeviation', '0');
                  }

                  // sharpBiased의 기여를 0으로 만들어 혼합(Composite) 연산을 완전 무력화
                  if (st.__sharpBiasK2 !== '0' || st.__sharpBiasK3 !== '0') {
                    st.__sharpBiasK2 = '0';
                    st.__sharpBiasK3 = '0';
                    fn.casLike.sharpBiased.setAttribute('k2', '0');
                    fn.casLike.sharpBiased.setAttribute('k3', '0');
                  }

                  // gate 계열 전부 0으로 차단
                  if (st.edgeGateTable !== '0 0') {
                    st.edgeGateTable = '0 0';
                    for (const f of fn.casLike.edgeGateFuncs) f.setAttribute('tableValues', '0 0');
                  }
                  // hlKeep 역시 항등 변환
                  if (st.hlKeepTable !== '1 1') {
                    st.hlKeepTable = '1 1';
                    for (const f of fn.casLike.hlKeepFuncs) f.setAttribute('tableValues', '1 1');
                  }
                  // desatSat 항등(중립) 변환
                  if (st.__sharpDesatSat !== '1') {
                    st.__sharpDesatSat = '1';
                    fn.casLike.sharpDesat.setAttribute('values', '1');
                  }
                } else {
                  // ✨ 정상 연산 로직 (morphRadius > 0)
                  const morphKey = String(morphRadius);
                  if (st.morphKey !== morphKey) {
                    st.morphKey = morphKey;
                    setAttr(fn.casLike.rngMax, 'radius', morphKey, st, '__rngMaxR');
                    setAttr(fn.casLike.rngMin, 'radius', morphKey, st, '__rngMinR');
                  }

                  const rbk = rngBlurStd.toFixed(2);
                  if (st.__rngBlur !== rbk) {
                    st.__rngBlur = rbk;
                    fn.casLike.rngBlur.setAttribute('stdDeviation', rbk);
                  }

                  if (st.edgeGateTable !== edgeGateTable) {
                    st.edgeGateTable = edgeGateTable;
                    for (const f of fn.casLike.edgeGateFuncs) f.setAttribute('tableValues', edgeGateTable);
                  }

                  if (st.hlKeepTable !== hlKeepTable) {
                    st.hlKeepTable = hlKeepTable;
                    for (const f of fn.casLike.hlKeepFuncs) f.setAttribute('tableValues', hlKeepTable);
                  }

                  const ds = desatSat.toFixed(2);
                  if (st.__sharpDesatSat !== ds) {
                    st.__sharpDesatSat = ds;
                    fn.casLike.sharpDesat.setAttribute('values', ds);
                  }

                  const k2 = chromaKeep.toFixed(3), k3 = (1 - chromaKeep).toFixed(3);
                  if (st.__sharpBiasK2 !== k2 || st.__sharpBiasK3 !== k3) {
                    st.__sharpBiasK2 = k2;
                    st.__sharpBiasK3 = k3;
                    fn.casLike.sharpBiased.setAttribute('k2', k2);
                    fn.casLike.sharpBiased.setAttribute('k3', k3);
                  }
                }
              }
            }
          });
        }

        let fid = filterGrade === 'F' ? ctx.fidFull : filterGrade === 'M' ? ctx.fidMid : ctx.fidLite;
        const url = `url(#${fid})`; dc.key = key; dc.url = url; return url;
      }

      return {
        prepareCached: (video, s) => { try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
        applyUrl: (el, url) => {
          if (!el) return; const st = getVState(el);
          if (!url) { if (st.applied) { queueMicrotask(() => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); }); st.applied = false; st.lastFilterUrl = null; } return; }
          if (st.lastFilterUrl === url) return; queueMicrotask(() => { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }); st.applied = true; st.lastFilterUrl = url;
        },
        clear: (el) => {
          if (!el) return; const st = getVState(el); if (!st.applied) return;
          queueMicrotask(() => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); }); st.applied = false; st.lastFilterUrl = null;
        }
      };
    }

    function createFiltersWebGL(Utils) {
      const pipelines = new WeakMap();
      function compileShaderChecked(gl, type, source) { const shader = gl.createShader(type); if (!shader) throw new Error('gl.createShader failed'); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const info = gl.getShaderInfoLog(shader) || 'unknown error'; gl.deleteShader(shader); throw new Error(`Shader compile failed (${type}): ${info}`); } return shader; }
      function linkProgramChecked(gl, vs, fs) { const program = gl.createProgram(); if (!program) throw new Error('gl.createProgram failed'); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const info = gl.getProgramInfoLog(program) || 'unknown error'; gl.deleteProgram(program); throw new Error(`Program link failed: ${info}`); } return program; }

      function buildToneLUT256(toe, mid, shoulder) {
        const clamp = VSC_CLAMP;
        const steps = 256;
        const out = new Uint8Array(steps * 4);

        const t = clamp(toe / 14, -1, 1);
        const s = clamp(shoulder / 16, -1, 1);
        const m = clamp(mid, -1, 1);

        const smoothstep = (a,b,x)=>{ x = clamp((x-a)/(b-a),0,1); return x*x*(3-2*x); };

        let prev = 0;
        for (let i = 0; i < steps; i++) {
          let x = i / 255;
          x = clamp(x + m * 0.06 * (4 * x * (1 - x)), 0, 1);
          if (t !== 0) {
            const w = smoothstep(0.0, 0.35, x);
            x = clamp(x + t * 0.08 * (1 - w), 0, 1);
          }
          if (s !== 0) {
            const w = smoothstep(0.85, 1.0, x);
            x = clamp(x - s * 0.08 * w, 0, 1);
          }
          if (x < prev) x = prev;
          prev = x;

          const v = (x * 255 + 0.5) | 0;
          const o = i * 4;
          out[o] = out[o+1] = out[o+2] = v;
          out[o+3] = 255;
        }
        return out;
      }

      function buildFsColorOnly({ gl2 }) {
        const head = gl2
          ? `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n`
          : `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`;
        return head + `
uniform sampler2D uVideoTex;
uniform sampler2D uToneTex;
uniform vec4 uParams;
uniform vec4 uParams2;
uniform vec3 uRGBGain;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float tone1(float y){
  float tx = y * (255.0/256.0) + (0.5/256.0);
  return TEX(uToneTex, vec2(tx, 0.5)).r;
}

vec3 softClip(vec3 c, float knee) {
  vec3 x = max(c - 1.0, vec3(0.0));
  return c - (x * x) / (x + vec3(knee));
}

void main() {
  vec3 color = TEX(uVideoTex, vTexCoord).rgb;
  color *= uRGBGain;
  color += (uParams2.x / 1000.0);
  color = (color - 0.5) * uParams.y + 0.5;

  color *= uParams.x;

  float y = dot(color, LUMA);
  float y2 = tone1(clamp(y, 0.0, 1.0));
  float ratio = y2 / max(1e-4, y);
  color *= ratio;

  float luma = dot(color, LUMA);
  float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0);
  float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma);
  float currentSat = uParams.z * (1.0 - 0.05 * satReduce);
  color = luma + (color - luma) * currentSat;

  if (uParams.w != 1.0) color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w));
  color = softClip(color, 0.18);

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
      }

      function buildFsSharpen({ gl2 }) {
        const head = gl2
          ? `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n`
          : `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`;
        return head + `
uniform sampler2D uVideoTex;
uniform sampler2D uToneTex;
uniform vec2 uResolution;
uniform vec4 uParams;
uniform vec4 uParams2;
uniform vec3 uRGBGain;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float tone1(float y){
  float tx = y * (255.0/256.0) + (0.5/256.0);
  return TEX(uToneTex, vec2(tx, 0.5)).r;
}

vec3 softClip(vec3 c, float knee) {
  vec3 x = max(c - 1.0, vec3(0.0));
  return c - (x * x) / (x + vec3(knee));
}

vec3 rcasDirectionalSharpen(sampler2D tex, vec2 uv, vec2 texel, float strength) {
  vec3 c  = TEX(tex, uv).rgb;
  vec3 n  = TEX(tex, uv + vec2(0.0, -texel.y)).rgb;
  vec3 s  = TEX(tex, uv + vec2(0.0,  texel.y)).rgb;
  vec3 w  = TEX(tex, uv + vec2(-texel.x, 0.0)).rgb;
  vec3 e  = TEX(tex, uv + vec2( texel.x, 0.0)).rgb;

  float lc = dot(c, LUMA);
  float ln = dot(n, LUMA);
  float ls = dot(s, LUMA);
  float lw = dot(w, LUMA);
  float le = dot(e, LUMA);

  float gX = abs(le - lw);
  float gY = abs(ls - ln);

  float wX = gX * gX;
  float wY = gY * gY;

  vec3 avg;

  if (uParams2.z > 0.5) {
    float sumW = wX + wY + 1e-6;
    avg = (wX * (0.5 * (n + s)) + wY * (0.5 * (w + e))) / sumW;
  } else {
    vec3 nw = TEX(tex, uv + vec2(-texel.x, -texel.y)).rgb;
    vec3 ne = TEX(tex, uv + vec2( texel.x, -texel.y)).rgb;
    vec3 sw = TEX(tex, uv + vec2(-texel.x,  texel.y)).rgb;
    vec3 se = TEX(tex, uv + vec2( texel.x,  texel.y)).rgb;

    float lnw = dot(nw, LUMA);
    float lne = dot(ne, LUMA);
    float lsw = dot(sw, LUMA);
    float lse = dot(se, LUMA);

    float gD1 = abs(lne - lsw);
    float gD2 = abs(lnw - lse);

    float wD1 = gD1 * gD1;
    float wD2 = gD2 * gD2;

    float sumW = wX + wY + wD1 + wD2 + 1e-6;
    avg = (wX * (0.5 * (n + s)) +
           wY * (0.5 * (w + e)) +
           wD1 * (0.5 * (ne + sw)) +
           wD2 * (0.5 * (nw + se))) / sumW;
  }

  vec3 sharpened = c + (c - avg) * strength;

  vec3 mn = min(c, min(min(n,s), min(w,e)));
  vec3 mx = max(c, max(max(n,s), max(w,e)));
  vec3 span = mx - mn;
  sharpened = clamp(sharpened, mn - span * 0.05, mx + span * 0.05);

  return sharpened;
}

void main() {
  vec2 texel = 1.0 / uResolution;
  vec3 color = TEX(uVideoTex, vTexCoord).rgb;
  float strength = uParams2.y;

  if (strength > 0.0) {
    color = rcasDirectionalSharpen(uVideoTex, vTexCoord, texel, strength);
  }

  color *= uRGBGain;
  color += (uParams2.x / 1000.0);
  color = (color - 0.5) * uParams.y + 0.5;
  color *= uParams.x;

  float y = dot(color, LUMA);
  float y2 = tone1(clamp(y, 0.0, 1.0));
  float ratio = y2 / max(1e-4, y);
  color *= ratio;

  float luma = dot(color, LUMA);
  float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0);
  float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma);
  float currentSat = uParams.z * (1.0 - 0.05 * satReduce);
  color = luma + (color - luma) * currentSat;

  if (uParams.w != 1.0) color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w));
  color = softClip(color, 0.18);

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
      }

      function buildShaderSources(gl) {
        const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        const vs = isGL2
          ? `#version 300 es\nin vec2 aPosition;\nin vec2 aTexCoord;\nout vec2 vTexCoord;\nvoid main() {\n  gl_Position = vec4(aPosition, 0.0, 1.0);\n  vTexCoord = aTexCoord;\n}`
          : `attribute vec2 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vTexCoord = aTexCoord; }`;
        return {
          vs,
          fsColorOnly: buildFsColorOnly({ gl2: isGL2 }),
          fsSharpen: buildFsSharpen({ gl2: isGL2 })
        };
      }

      class WebGLPipeline {
        constructor() {
          this.canvas = null; this.gl = null; this.activeProgramKind = ''; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this.restoreVideoStyle = null; this.renderDriver = createFrameDriver(); this.disabledUntil = 0;
          this._texW = 0; this._texH = 0; this._loopToken = 0; this._loopRunning = false;
          this._isGL2 = false;
          this._qMon = { lastT: 0, lastDropped: 0, dropRateEma: 0 };
          this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0;
          this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null;
          this.toneTexture = null; this._toneKey = '';
          this._outputReady = false;
          this._onContextLost = (e) => {
            e.preventDefault();
            const now = performance.now();
            this.disabledUntil = now + 3000;
            this.active = false;
            this._loopToken++; this._loopRunning = false;

            try { this.restoreVideoStyle?.(); } catch (_) {}
            this.restoreVideoStyle = null;
            try { if (this.canvas) this.canvas.style.opacity = '0'; } catch (_) {}

            try { const st = this.video ? getVState(this.video) : null; if (st && VSC_DEFENSE.webglCooldown) st.webglDisabledUntil = now + 5000; } catch (_) {}
            try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
          };
          this._onContextRestored = () => { try { this.disposeGLResources({ keepCanvasListeners: true }); if (this.initGLResourcesOnExistingCanvas()) { if (this.video) { this.active = true; this.startRenderLoop(); } } else { this.disabledUntil = performance.now() + 5000; } } catch (_) { this.disabledUntil = performance.now() + 5000; } };
          this._lastRenderedTime = -1;
          this._paramsDirty = true;
        }
        ensureCanvas() {
          if (this.canvas) return;
          this.canvas = document.createElement('canvas');
          this.canvas.style.cssText = `position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; object-fit: contain !important; display: block !important; pointer-events: none !important; margin: 0 !important; padding: 0 !important; contain: strict !important; will-change: transform, opacity !important; opacity: 0 !important;`;
          this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false });
          this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, { passive: true });
        }
        _bindProgramHandles(program, key) {
          const gl = this.gl; gl.useProgram(program);
          const handles = { program, uResolution: gl.getUniformLocation(program, 'uResolution'), uVideoTex: gl.getUniformLocation(program, 'uVideoTex'), uToneTex: gl.getUniformLocation(program, 'uToneTex'), uParams: gl.getUniformLocation(program, 'uParams'), uParams2: gl.getUniformLocation(program, 'uParams2'), uRGBGain: gl.getUniformLocation(program, 'uRGBGain'), aPosition: gl.getAttribLocation(program, 'aPosition'), aTexCoord: gl.getAttribLocation(program, 'aTexCoord') };
          if (handles.uVideoTex) gl.uniform1i(handles.uVideoTex, 0);
          if (handles.uToneTex) gl.uniform1i(handles.uToneTex, 1);
          this[`handles_${key}`] = handles;
        }
        initGLResourcesOnExistingCanvas() {
          this.ensureCanvas();
          let gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true });
          this._isGL2 = !!gl;
          if (!gl) gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true });
          if (!gl) return false; this.gl = gl;

          try {
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          } catch (_) {}

          const src = buildShaderSources(gl);
          try {
            const vs = compileShaderChecked(gl, gl.VERTEX_SHADER, src.vs), fsColor = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsColorOnly), fsSharp = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsSharpen);
            const programColor = linkProgramChecked(gl, vs, fsColor), programSharp = linkProgramChecked(gl, vs, fsSharp);
            gl.deleteShader(vs); gl.deleteShader(fsColor); gl.deleteShader(fsSharp);
            this._bindProgramHandles(programColor, 'color'); this._bindProgramHandles(programSharp, 'sharp');
            this.activeProgramKind = '';

            const vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); const tCoords = new Float32Array([0,0, 1,0, 0,1, 1,1]);
            this.vBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
            this.tBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.bufferData(gl.ARRAY_BUFFER, tCoords, gl.STATIC_DRAW);

            this.videoTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            this.toneTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            const id = new Uint8Array(256 * 4);
            for (let i=0;i<256;i++){ const o=i*4; id[o]=id[o+1]=id[o+2]=i; id[o+3]=255; }
            const toneInternalFormat = this._isGL2 ? gl.RGBA8 : gl.RGBA;
            gl.texImage2D(gl.TEXTURE_2D, 0, toneInternalFormat, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, id);

            return true;
          } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
        }
        init() { return this.initGLResourcesOnExistingCanvas(); }
        attachToVideo(video) {
          if (!this.active && !this.init()) return false;
          this.video = video; this.originalParent = video.parentNode;
          this.restoreVideoStyle = null;
          this._outputReady = false;
          this.canvas.style.opacity = '0';

          if (this.originalParent) {
            const cs = window.getComputedStyle(this.originalParent);
            if (cs.position === 'static') { this._parentPrevPosition = this.originalParent.style.position || ''; this.originalParent.style.position = 'relative'; this._parentStylePatched = true; this._patchedParent = this.originalParent; }
            if (video.nextSibling) this.originalParent.insertBefore(this.canvas, video.nextSibling);
            else this.originalParent.appendChild(this.canvas);
          }
          if (this._styleObs) this._styleObs.disconnect();
          this._styleObs = new MutationObserver(() => { this._styleDirty = true; });
          try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
          this._styleDirty = true; this.active = true; this.startRenderLoop(); return true;
        }
        updateParams(vVals) {
          if (this.vVals !== vVals) {
            this._paramsDirty = true;
          }
          this.vVals = vVals;
        }
        syncCanvasPresentationFromVideo(video, now) {
          if (!this.canvas || !video) return;
          if (!this._styleDirty && (now - this._lastStyleSyncT) < 250) return;
          const vs = window.getComputedStyle(video), cs = this.canvas.style;
          if (cs.objectFit !== vs.objectFit) cs.objectFit = vs.objectFit || 'contain';
          if (cs.objectPosition !== vs.objectPosition) cs.objectPosition = vs.objectPosition;

          const tr = vs.transform, tro = vs.transformOrigin;
          const nextTr = (tr && tr !== 'none') ? tr : '';
          if (cs.transform !== nextTr) cs.transform = nextTr;
          if (cs.transformOrigin !== tro) cs.transformOrigin = tro;

          if (cs.borderRadius !== vs.borderRadius) cs.borderRadius = vs.borderRadius || '';
          if (cs.clipPath !== vs.clipPath) cs.clipPath = vs.clipPath || '';
          if (cs.webkitClipPath !== vs.webkitClipPath) cs.webkitClipPath = vs.webkitClipPath || '';
          if (cs.mixBlendMode !== vs.mixBlendMode) cs.mixBlendMode = vs.mixBlendMode || '';
          if (cs.isolation !== vs.isolation) cs.isolation = vs.isolation || '';

          const vz = vs.zIndex;
          let zi = '1';
          if (vz && vz !== 'auto') {
            const n = parseInt(vz, 10);
            zi = Number.isFinite(n) ? String(n + 1) : '1';
          }
          if (cs.zIndex !== zi) cs.zIndex = zi;

          this._styleDirty = false; this._lastStyleSyncT = now;
        }

        _updatePlaybackQuality(now) {
          const v = this.video; if (!v || typeof v.getVideoPlaybackQuality !== 'function') return;
          if (now - this._qMon.lastT < 1000) return;
          try {
            const q = v.getVideoPlaybackQuality(), dropped = q.droppedVideoFrames || 0;
            if (this._qMon.lastT > 0) {
              const dd = Math.max(0, dropped - this._qMon.lastDropped);
              this._qMon.dropRateEma = this._qMon.dropRateEma ? (this._qMon.dropRateEma * 0.8 + dd * 0.2) : dd;
            }
            this._qMon.lastDropped = dropped; this._qMon.lastT = now;

            if (this._qMon.dropRateEma > 2.5) {
              const st = getVState(v);
              if (VSC_DEFENSE.webglCooldown) st.webglDisabledUntil = now + 8000;
              try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
            }
          } catch (_) {}
        }

        // ✨ v170.7.0 - Zero-Idle Render Loop Implementation
        render() {
          if (!this.active || !this.gl || !this.video || !this.vVals) return;
          const gl = this.gl, video = this.video;
          const now = performance.now();

          if (now < this.disabledUntil) return;
          const st = getVState(video);
          if (st.webglDisabledUntil && now < st.webglDisabledUntil) return;
          if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

          // ✨ 동일 프레임(또는 중복 이벤트) 스킵
          const ct = video.currentTime;
          if (this._lastRenderedTime === ct && !this._paramsDirty) return;
          this._lastRenderedTime = ct;
          this._paramsDirty = false;

          if (this.canvas.parentNode !== video.parentNode && video.parentNode) {
            this.originalParent = video.parentNode;
            const p = video.parentNode;
            if (video.nextSibling) p.insertBefore(this.canvas, video.nextSibling);
            else p.appendChild(this.canvas);
          }
          this.syncCanvasPresentationFromVideo(video, now);
          this._updatePlaybackQuality(now);

          const w = video.videoWidth, h = video.videoHeight;
          const sharpNorm = (this.vVals.sharp || 0) / 50.0;
          const useSharpen = sharpNorm > 0;
          const kind = useSharpen ? 'sharp' : 'color';
          const H = useSharpen ? this.handles_sharp : this.handles_color;

          let programChanged = false;
          if (this.activeProgramKind !== kind) {
            this.activeProgramKind = kind;
            programChanged = true;
            gl.useProgram(H.program);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf);
            gl.enableVertexAttribArray(H.aPosition);
            gl.vertexAttribPointer(H.aPosition, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf);
            gl.enableVertexAttribArray(H.aTexCoord);
            gl.vertexAttribPointer(H.aTexCoord, 2, gl.FLOAT, false, 0, 0);
          }

          const resized = (this.canvas.width !== w || this.canvas.height !== h);
          if (resized) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
          if ((resized || programChanged) && H.uResolution) gl.uniform2f(H.uResolution, w, h);

          const { rs, gs, bs } = tempToRgbGain(this.vVals.temp);
          if (H.uParams) gl.uniform4f(H.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);

          const isHdr = VSC_MEDIA.isHdr();
          const hiReduce = isHdr ? 0.82 : 0.88;
          if (H.uParams2) gl.uniform4f(H.uParams2, this.vVals.bright || 0.0, useSharpen ? sharpNorm : 0.0, 0.0, hiReduce);
          if (H.uRGBGain) gl.uniform3f(H.uRGBGain, rs, gs, bs);

          const toe = this.vVals.toe || 0;
          const mid = this.vVals.mid || 0;
          const shoulder = this.vVals.shoulder || 0;
          const tq = (n, q) => (Math.round(n / q) * q).toFixed(3);
          const toneKey = `${tq(toe,0.2)}|${tq(mid,0.02)}|${tq(shoulder,0.2)}`;

          if (this._toneKey !== toneKey && this.toneTexture) {
            this._toneKey = toneKey;
            const lut = buildToneLUT256(toe, mid, shoulder);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut);
          }

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);

          try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            if (this._texW !== w || this._texH !== h) {
              this._texW = w; this._texH = h;
              const internalFormat = this._isGL2 ? gl.RGBA8 : gl.RGBA;
              gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            st.webglFailCount = 0;

            if (!this._outputReady) {
              this._outputReady = true;
              this.canvas.style.opacity = '1';
              if (!this.restoreVideoStyle)
                this.restoreVideoStyle = patchInlineStyleImportant(video, { opacity: '0.001' });
            }
          } catch (err) {
            st.webglFailCount = (st.webglFailCount || 0) + 1;
            if (CONFIG.DEBUG) log.warn('WebGL render failure:', err);
            const msg = String(err?.message || err || '');
            const looksTaint = /SecurityError|cross.origin|cross-origin|taint|insecure|Tainted|origin/i.test(msg);

            if (st.webglFailCount >= RUNTIME_GUARD.webgl.failThreshold) {
              st.webglFailCount = 0;
              if (looksTaint) {
                st.webglTainted = true;
                log.warn('WebGL tainted/CORS-like failure → fallback to SVG');
              } else {
                if (VSC_DEFENSE.webglCooldown) st.webglDisabledUntil = now + RUNTIME_GUARD.webgl.failCooldownMs;
                log.warn('WebGL transient failure → cooldown then retry');
              }
              try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
            }
          }
        }

        startRenderLoop() {
          if (this._loopRunning) return;
          this._loopRunning = true;
          const token = ++this._loopToken;

          const loopFn = (now, meta) => {
            if (token !== this._loopToken || !this.active || !this.video) {
              this._loopRunning = false;
              return;
            }
            this.render();
            this.scheduleNextFrame(loopFn);
          };
          this.scheduleNextFrame(loopFn);
        }

        // ✨ v170.7.0 - Zero-Idle Throttle
        scheduleNextFrame(loopFn) {
          if (document.hidden) {
            // 탭 숨김: 루프 완전 파괴. visibilitychange 이벤트에서 ApplyReq.hard()로 재시작됨.
            this._loopRunning = false;
            return;
          }
          if (this.video?.paused) {
            // 일시정지: 루프 파괴. play/seek 이벤트에서 ApplyReq.hard()로 재시작됨.
            this._loopRunning = false;
            return;
          }
          // 재생 중일 때만 RequestVideoFrameCallback 구동
          this.renderDriver.scheduleVideoFrame(this.video, loopFn, 'raf', 90);
        }

        disposeGLResources(opts = {}) {
          const { keepCanvasListeners = false } = opts; const gl = this.gl;
          if (gl) { try { if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; } if (this.toneTexture) { gl.deleteTexture(this.toneTexture); this.toneTexture = null; } if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; } if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; } if (this.handles_color?.program) gl.deleteProgram(this.handles_color.program); if (this.handles_sharp?.program) gl.deleteProgram(this.handles_sharp.program); } catch (_) {} }
          if (!keepCanvasListeners && this.canvas) { try { this.canvas.removeEventListener('webglcontextlost', this._onContextLost); this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored); } catch (_) {} }
          this.gl = null; this._texW = 0; this._texH = 0; this.activeProgramKind = '';
        }
        shutdown() {
          this.active = false; this._loopToken++; this._loopRunning = false; this.renderDriver.clear(); if (this._styleObs) { this._styleObs.disconnect(); this._styleObs = null; }
          try { this.restoreVideoStyle?.(); } catch (_) {} this.restoreVideoStyle = null;
          try { if (this.canvas && this.canvas.parentNode) { this.canvas.remove(); } } catch (_) {}
          if (this._parentStylePatched && this._patchedParent) {
            try { this._patchedParent.style.position = this._parentPrevPosition; } catch (_) {}
            this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null;
          }
          this.disposeGLResources();
        }
      }
      return {
        apply: (el, vVals) => {
          let pipe = pipelines.get(el);
          if (!pipe) { pipe = new WebGLPipeline(); pipelines.set(el, pipe); }
          if (!pipe.active || pipe.video !== el || !pipe.gl) {
            if (!pipe.attachToVideo(el)) { pipelines.delete(el); return false; }
          }
          pipe.updateParams(vVals);
          // 파이프라인이 살아있지만 루프가 멈췄다면 재시동
          if (!pipe._loopRunning && !el.paused && !document.hidden) {
              pipe.startRenderLoop();
          }
          return true;
        },
        clear: (el) => {
          const pipe = pipelines.get(el); if (pipe) { pipe.shutdown(); pipelines.delete(el); }
        }
      };
    }
const __styleCache = new Map();
    function applyShadowStyle(shadow, cssText, h) {
      try {
        if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) {
          let sheet = __styleCache.get(cssText);
          if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); __styleCache.set(cssText, sheet); }
          const cur = shadow.adoptedStyleSheets || []; if (!cur.includes(sheet)) { shadow.adoptedStyleSheets = [...cur, sheet]; } return;
        }
      } catch (_) {}
      const marker = 'data-vsc-style';
      let stEl = shadow.querySelector(`style[${marker}="1"]`);
      if (!stEl) {
        stEl = h('style', { [marker]: '1' }, cssText);
        shadow.append(stEl);
      } else if (stEl.textContent !== cssText) {
        stEl.textContent = cssText;
      }
    }

    function createDisposerBag() { const fns = []; return { add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; }, flush() { for (let i = fns.length - 1; i >= 0; i--) { try { fns[i](); } catch (_) {} } fns.length = 0; } }; }

    function bindWindowDrag(onMove, onEnd) {
      const ac = new AbortController(); const sig = ac.signal;
      window.addEventListener('mousemove', onMove, { passive: false, signal: sig }); window.addEventListener('mouseup', end, { signal: sig }); window.addEventListener('touchmove', onMove, { passive: false, signal: sig }); window.addEventListener('touchend', end, { signal: sig }); window.addEventListener('blur', end, { signal: sig });
      function end(ev) { try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} } } return () => { try { ac.abort(); } catch (_) {} };
    }

    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0;
      const uiWakeCtrl = new AbortController(), bag = createDisposerBag(), sub = (k, fn) => bag.add(sm.sub(k, fn));
      const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };

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

      function getFullscreenElementSafe() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
      const getUiRoot = () => { const fs = getFullscreenElementSafe(); if (fs) { if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement; return fs; } return document.body || document.documentElement; };

      function bindClassToggle(btn, path, isActive) { const sync = () => { if (btn) btn.classList.toggle('active', isActive(sm.get(path))); }; sub(path, sync); sync(); return sync; }
      function bindStyle(btn, path, apply) { const sync = () => { if (btn) apply(btn, sm.get(path)); }; sub(path, sync); sync(); return sync; }
      function bindRateButtonActive(b, speed, sm, sub, P) { const sync = () => { const isEn = !!sm.get(P.PB_EN); const v = Number(sm.get(P.PB_RATE) || 1); b.classList.toggle('active', isEn && Math.abs(v - speed) < 0.01); }; sub(P.PB_RATE, sync); sub(P.PB_EN, sync); sync(); }

      function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
        const addBtn = (text, value) => { const b = h('button', { class: 'pbtn', style: 'flex:1' }, text); b.onclick = () => { const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) { setAndHint(key, offValue); } else { setAndHint(key, value); } }; bindClassToggle(b, key, v => v === value); row.append(b); };
        for (const it of items) addBtn(it.text, it.value); if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) addBtn('OFF', offValue); return row;
      }

      function renderShadowBandMaskRow({ label = '블랙', key = P.V_SHADOW_MASK }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label) );
        const items = [ { text: '외암', bit: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' }, { text: '중암', bit: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' }, { text: '심암', bit: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' } ];
        for (const it of items) {
          const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title }, it.text);
          b.onclick = () => { sm.set(key, ShadowMask.toggle(sm.get(key), it.bit)); ApplyReq.hard(); };
          bindClassToggle(b, key, v => ShadowMask.has(v, it.bit)); row.append(b);
        }
        const off = h('button', { class: 'pbtn', style: 'flex:0.9' }, 'OFF');
        off.onclick = () => { sm.set(key, 0); ApplyReq.hard(); };
        bindClassToggle(off, key, v => (Number(v) | 0) === 0); row.append(off); return row;
      }

      const build = () => {
        if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
        const style = `.main { position: fixed; top: 50%; right: 70px; transform: translateY(-50%); width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; } .header { display: flex; justify-content: center; margin-bottom: 12px; cursor: move; border-bottom: 2px solid #444; padding-bottom: 8px; font-weight: bold; font-size: 14px; color: #ccc;} .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; } .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; } .btn.active { background: #3498db; color: white; border-color: #2980b9; } .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; } .pbtn.active { background: #e67e22; color: white; border-color: #d35400; } hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }`;
        applyShadowStyle(shadow, style, h);
        const dragHandle = h('div', { class: 'header' }, 'VSC 렌더링 제어');

        const rmBtn = h('button', { id: 'rm-btn', class: 'btn', onclick: () => setAndHint(P.APP_RENDER_MODE, sm.get(P.APP_RENDER_MODE) === 'webgl' ? 'svg' : 'webgl') });
        bindStyle(rmBtn, P.APP_RENDER_MODE, (el, v) => { el.textContent = `🎨 ${v === 'webgl' ? 'WebGL' : 'SVG'}`; el.style.color = v === 'webgl' ? '#ffaa00' : '#88ccff'; el.style.borderColor = v === 'webgl' ? '#ffaa00' : '#88ccff'; });

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn', onclick: () => setAndHint(P.A_EN, !sm.get(P.A_EN)) }, '🔊 Brickwall');
        bindClassToggle(boostBtn, P.A_EN, v => !!v);

        const pipBtn = h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');

        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', onclick: () => { const nextEn = !sm.get(P.APP_ZOOM_EN); setAndHint(P.APP_ZOOM_EN, nextEn); const zm = window.__VSC_INTERNAL__.ZoomManager; const v = window.__VSC_APP__?.getActiveVideo(); if (zm && v) { if (zm.isZoomed(v)) { zm.resetZoom(v); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); } } } }, '🔍 줌 제어');
        bindClassToggle(zoomBtn, P.APP_ZOOM_EN, v => !!v);

        const autoSceneBtn = h('button', { class: 'btn', onclick: () => setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)) }, '✨ Auto');
        bindClassToggle(autoSceneBtn, P.APP_AUTO_SCENE, v => !!v);

        const pwrBtn = h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power');
        bindStyle(pwrBtn, P.APP_ACT, (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; });

        const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
        advToggleBtn.onclick = () => setAndHint(P.APP_ADV, !sm.get(P.APP_ADV));
        bindStyle(advToggleBtn, P.APP_ADV, (el, v) => {
            el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기';
            el.style.background = v ? '#34495e' : '#2c3e50';
        });

        const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
            renderShadowBandMaskRow({ label: '블랙', key: P.V_SHADOW_MASK }),
            renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
            renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(k => ({ text: k, value: k })) })
        ]);
        bindStyle(advContainer, P.APP_ADV, (el, v) => { el.style.display = v ? 'flex' : 'none'; });

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, autoSceneBtn ]),
          h('div', { class: 'prow' }, [ pipBtn, zoomBtn, boostBtn ]),
          h('div', { class: 'prow' }, [ h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'), pwrBtn, h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard(); } }, '↺ 리셋') ]),
          renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k=>k!=='off').map(k => ({ text: k, value: k })) }),
          advToggleBtn,
          advContainer,
          h('hr'), h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }; bindRateButtonActive(b, s, sm, sub, P); return b; }))
        ]);
        const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]); shadow.append(mainPanel);
        let stopDrag = null;
        dragHandle.addEventListener('mousedown', (e) => {
          e.preventDefault(); stopDrag?.();
          let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect();
          mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`;
          stopDrag = bindWindowDrag((ev) => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx)), nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
            mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`;
          }, () => { stopDrag = null; });
        });

        container = host; getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) return; if (gearHost) return;
        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%; background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff; display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer; pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none; transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;} @media (hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}} .gear:active{transform:translateY(-50%) scale(0.98);} .gear.open{outline:2px solid rgba(52,152,219,0.85);opacity:1 !important;} .gear.inactive{opacity:0.45;} .hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,0.88); border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.82);font:600 11px/1.2 sans-serif;white-space:nowrap; z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none;} .gear:hover+.hint{opacity:1;transform:translateY(0);} ${CONFIG.IS_MOBILE ? '.hint{display:none !important;}' : ''}`;
        applyShadowStyle(shadow, style, h); let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear', onclick: (e) => { if (dragThresholdMet) { e.preventDefault(); e.stopPropagation(); return; } setAndHint(P.APP_UI, !sm.get(P.APP_UI)); } }, '⚙');
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.15'; }, 2500); };
        window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal }); window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal }); bootWakeTimer = setTimeout(wake, 2000);

        const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY; const rect = gearBtn.getBoundingClientRect();
          stopDrag = bindWindowDrag((ev) => {
              const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
              if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); }
              if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
        };
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

    function getRateState(v) { const st = getVState(v); if (!st.rateState) { st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0 }; } return st.rateState; }
    function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
    const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el, 220); el.playbackRate = nextRate; st.orig = null; } catch (_) {} };

    function createBackendAdapter(Filters, FiltersGL) {
      return {
        apply(video, mode, vVals) {
          const st = getVState(video);
          const now = performance.now();
          const webglAllowed = (mode === 'webgl' && !st.webglTainted && !(st.webglDisabledUntil && now < st.webglDisabledUntil));
          const effectiveMode = webglAllowed ? 'webgl' : 'svg';

          if (st.webglTainted && st.fxBackend === 'webgl') {
            FiltersGL.clear(video);
            st.fxBackend = null;
          }

          if (effectiveMode === 'webgl') {
              if (st.fxBackend === 'svg') Filters.clear(video);
              const ok = FiltersGL.apply(video, vVals);
              if (!ok) {
                  if (VSC_DEFENSE.webglCooldown) st.webglDisabledUntil = performance.now() + RUNTIME_GUARD.webgl.failCooldownMs;
                  FiltersGL.clear(video);
                  const url = Filters.prepareCached(video, vVals);
                  Filters.applyUrl(video, url);
                  st.fxBackend = 'svg';
                  return;
              }
              st.fxBackend = 'webgl';
          } else {
              if (st.fxBackend === 'webgl') FiltersGL.clear(video);
              let url = Filters.prepareCached(video, vVals);
              Filters.applyUrl(video, url);
              st.fxBackend = 'svg';
          }
        },
        clear(video) {
          const st = getVState(video);
          if (st.fxBackend === 'svg') Filters.clear(video);
          else if (st.fxBackend === 'webgl') FiltersGL.clear(video);
          st.fxBackend = null;
        }
      };
    }

    function ensureMobileInlinePlaybackHints(video) {
      if (!video) return;
      try {
        if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
        if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
      } catch (_) {}
    }

    const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
    const onEvictVideo = (v) => { if (window.__VSC_INTERNAL__.Adapter) window.__VSC_INTERNAL__.Adapter.clear(v); restoreRateOne(v); };
    const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };
    function pruneTouchedDisconnected() { for (const v of TOUCHED.videos) { if (!v || !v.isConnected) TOUCHED.videos.delete(v); } for (const v of TOUCHED.rateVideos) { if (!v || !v.isConnected) TOUCHED.rateVideos.delete(v); } }

    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v); if (st.bound) return; st.bound = true;
      ensureMobileInlinePlaybackHints(v);
      const softResetTransientFlags = () => {
        st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.rectEpoch = -1;
        st.webglFailCount = 0; st.webglDisabledUntil = 0; st.webglTainted = false;
        if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; }
        // 🚀 일시정지나 탭 숨김으로 WebGL 루프가 중단되었다가,
        // 다시 재생/탐색/메타데이터 로드될 때 ApplyReq를 호출하여 렌더 루프를 부활시킵니다.
        ApplyReq.hard();
      };
      ['loadstart', 'loadedmetadata', 'emptied'].forEach(ev => v.addEventListener(ev, softResetTransientFlags, { passive: true }));
      ['seeking', 'play'].forEach(ev => v.addEventListener(ev, () => { ApplyReq.hard(); }, { passive: true }));
      v.addEventListener('ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180) return; if (now < (rSt.suppressSyncUntil || 0)) return; const refs = window.__VSC_INTERNAL__; const app = refs?.App; const store = refs?.Store; if (!store) return; const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return; const activeVideo = app?.getActiveVideo?.() || null; const applyAll = !!store.get?.(P.APP_APPLY_ALL); if (!applyAll) { if (!activeVideo || v !== activeVideo) return; } const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.set(P.PB_RATE, cur); if (store.get?.(P.PB_EN) !== false) store.set(P.PB_EN, true); } }, { passive: true });
    };

    const __reconcileCandidates = new Set(); let __lastLightSig = '';
    function makeLightSig({ activeTarget, rMode, pbActive, desiredRate, videoFxOn, storeRev }) { return [ storeRev, getElemId(activeTarget), rMode, pbActive ? 1 : 0, desiredRate ?? 1, videoFxOn ? 1 : 0 ].join('|'); }

    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el);
      Adapter.clear(el);
      TOUCHED.videos.delete(el);
      st.desiredRate = undefined;
      restoreRateOne(el);
      TOUCHED.rateVideos.delete(el);
      bindVideoOnce(el, ApplyReq);
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el);
      const rSt = getRateState(el);
      if (rSt.orig == null) rSt.orig = el.playbackRate;
      const lastDesired = st.desiredRate;
      if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        st.desiredRate = desiredRate;
        markInternalRateChange(el, 160);
        try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }

    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq }) {
      const candidates = __reconcileCandidates; candidates.clear();
      for (const v of dirtyVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.videos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.rateVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of applySet) if (v?.tagName === 'VIDEO') candidates.add(v);

      for (const el of candidates) {
        if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el); const visible = (st.visible !== false), shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));

        if (!shouldApply) { clearVideoRuntimeState(el, Adapter, ApplyReq); continue; }

        if (videoFxOn) { Adapter.apply(el, rMode, vVals); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
        if (pbActive) applyPlaybackRate(el, desiredRate); else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
        bindVideoOnce(el, ApplyReq);
      }
      candidates.clear();
    }

    function createThrottled(fn, ms = 120) {
      let last = 0, timer = 0;
      return (...args) => { const now = performance.now(); if (now - last >= ms) { last = now; fn(...args); return; } if (!timer) { timer = setTimeout(() => { timer = 0; last = performance.now(); fn(...args); }, ms); } };
    }

    function debugLogEffectiveVVals(vVals, vfUser, activeTarget, rMode) {
      if (!CONFIG.DEBUG) return; const w = activeTarget?.videoWidth || 0, h = activeTarget?.videoHeight || 0; console.debug('[VSC][ToneCheck]', { shadowBandMask: vfUser.shadowBandMask, brightStepLevel: vfUser.brightStepLevel, mode: rMode, size: `${w}x${h}`, contrast: vVals.contrast, satF: vVals.satF, bright: vVals.bright, gamma: vVals.gamma, sharp: vVals.sharp, temp: vVals.temp });
    }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
      Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });

      let __activeTarget = null, applySet = null, __lastAudioTarget = null, __lastAudioWant = null;
      let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

      const videoParamsMemo = createVideoParamsMemo(Store, P, Utils);
      const audioUpdateThrottled = createThrottled(() => Audio.update(), 120);

      let qualityScale = 1.0;
      let lastQCheck = 0;

      function updateQualityScale(v) {
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale;
        const now = performance.now();
        if (now - lastQCheck < 2000) return qualityScale;
        lastQCheck = now;
        try {
          const q = v.getVideoPlaybackQuality();
          const dropped = Number(q.droppedVideoFrames || 0);
          const total   = Number(q.totalVideoFrames || 0);
          const ratio = total > 0 ? (dropped / total) : 0;
          qualityScale = ratio > 0.08 ? 0.65 : ratio > 0.04 ? 0.80 : 1.0;
        } catch (_) {}
        return qualityScale;
      }

      Scheduler.registerApply((force) => {
        try {
          if (document.hidden && !force) return;

          const active = !!Store.getCatRef('app').active;
          if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }

          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev; if (!force && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); pruneTouchedDisconnected(); lastPrune = now; }

          const vf0 = Store.getCatRef('video'), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
          const wantAudioNow = !!(Store.get(P.A_EN) && active);
          const rMode = Store.get(P.APP_RENDER_MODE) || 'svg';

          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__lastUserPt, wantAudioNow);
          let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
          if (nextTarget !== __activeTarget) { __activeTarget = nextTarget; }

          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget || wantAudioNow !== __lastAudioWant) { Audio.setTarget(nextAudioTarget); Audio.update(); __lastAudioTarget = nextAudioTarget; __lastAudioWant = wantAudioNow; } else { audioUpdateThrottled(); }

          let vValsEffective = videoParamsMemo.get(vf0, rMode, __activeTarget);

          const qs = updateQualityScale(__activeTarget);
          if (qs !== 1.0) {
            vValsEffective = { ...vValsEffective };
            vValsEffective.sharp = (vValsEffective.sharp || 0) * qs;
            vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * qs;
            vValsEffective.clarity = (vValsEffective.clarity || 0) * qs;
          }

          debugLogEffectiveVVals(vValsEffective, vf0, __activeTarget, rMode);

          const videoFxOn = !isNeutralVideoParams(vValsEffective);
          const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);

          applySet = new Set();
          if (applyToAllVisibleVideos) { for (const v of visible.videos) applySet.add(v); }
          else if (__activeTarget) { applySet.add(__activeTarget); }

          const desiredRate = Store.get(P.PB_RATE), pbActive = active && !!Store.get(P.PB_EN);
          const lightSig = makeLightSig({ activeTarget: __activeTarget, rMode, pbActive, desiredRate, videoFxOn, storeRev: sRev });

          if (!force && vidsDirty.size === 0 && lightSig === __lastLightSig) return;
          __lastLightSig = lightSig;

          reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) { log.warn('apply crashed:', e); }
      });

      let tickTimer = 0;
      const startTick = () => {
        if (tickTimer) return;
        tickTimer = setInterval(() => {
          if (!Store.get(P.APP_ACT)) return;
          if (document.hidden) return;
          Scheduler.request(false);
        }, 12000);
      };
      const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick(); Scheduler.request(true);
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { Audio.setTarget(null); Audio.destroy?.(); } catch (_) {} try { __globalHooksAC.abort(); } catch (_) {} } });
    }

    const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
    const ApplyReq = createApplyRequester(Bus, Scheduler);
    window.__VSC_INTERNAL__.Bus = Bus; window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    Bus.on('signal', (s) => { if (s.forceApply) Scheduler.request(true); });

    window.addEventListener('message', (e) => {
      if (e.data && e.data.__vsc_sync && e.data.token === VSC_SYNC_TOKEN) {
        const { p, val } = e.data;
        if (p === P.APP_UI) return;
        if (Object.values(P).includes(p)) {
          if (Store.get(p) !== val) Store.set(p, val);
        }
      }
    });

    function bindNormalizer(keys, schema) {
      const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); };
      keys.forEach(k => Store.sub(k, run));
      run();
    }
    bindNormalizer([P.APP_RENDER_MODE, P.APP_APPLY_ALL, P.APP_ZOOM_EN, P.APP_AUTO_SCENE, P.APP_ADV], APP_SCHEMA);
    bindNormalizer([P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_SHADOW_MASK, P.V_BRIGHT_STEP], VIDEO_SCHEMA);
    bindNormalizer([P.A_EN, P.A_BST, P.PB_EN, P.PB_RATE], AUDIO_PLAYBACK_SCHEMA);

    const Registry = createRegistry(Scheduler), Targeting = createTargeting();

    const rescanDebounced = createDebounced(() => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} }, PERF_POLICY.registry.spaRescanDebounceMs);
    initSpaUrlDetector(rescanDebounced);

    waitForVisibility().then(() => {
      (function ensureRegistryAfterBodyReady() {
        let ran = false; const runOnce = () => { if (ran) return; ran = true; try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} };
        if (document.body) { runOnce(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
        document.addEventListener('DOMContentLoaded', runOnce, { once: true, signal: __globalSig });
      })();

      const AutoScene = createAutoSceneManager(Store, P, Scheduler);
      window.__VSC_INTERNAL__.AutoScene = AutoScene;

      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, IS_LOW_END: CONFIG.IS_LOW_END });
      const FiltersGL = createFiltersWebGL(Utils);
      const Adapter = createBackendAdapter(Filters, FiltersGL);
      window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store);

      let ZoomManager = null;
      if (FEATURE_FLAGS.zoomFeature) { ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager; }

      const UI = createUI(Store, Registry, ApplyReq, Utils);

      let __gmMenuId = null;
      const updateGmMenu = () => {
        if (typeof GM_unregisterMenuCommand === 'function' && __gmMenuId !== null) {
          try { GM_unregisterMenuCommand(__gmMenuId); } catch (_) {}
        }
        if (typeof GM_registerMenuCommand === 'function') {
          const isAll = !!Store.get(P.APP_APPLY_ALL);
          try {
            __gmMenuId = GM_registerMenuCommand(`전체 비디오에 적용 : ${isAll ? 'ON 🟢' : 'OFF 🔴'}`, () => {
              Store.set(P.APP_APPLY_ALL, !isAll);
              ApplyReq.hard();
            });
          } catch (_) {}
        }
      };
      Store.sub(P.APP_APPLY_ALL, updateGmMenu);
      updateGmMenu();

      window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
      function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} } let __vscLastUserSignalT = 0;

      onWin('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); });
      onWin('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true });

      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__;
      AutoScene.start();

      onWin('keydown', async (e) => {
          if (isEditableTarget(e.target)) return;
          if (e.altKey && e.shiftKey && e.code === 'KeyV') {
              e.preventDefault(); e.stopPropagation();
              try { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); } catch (_) {}
              return;
          }
          if (!(e.altKey && e.shiftKey && e.code === 'KeyP')) return;
          const v = __VSC_APP__?.getActiveVideo(); if (!v) return; await togglePiPFor(v);
      }, { capture: true });

      (function addPageLifecycleHooks() {
        onWin('freeze', () => { try { window.__VSC_INTERNAL__?.App?.getActiveVideo() && window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { capture: true });
        onWin('pageshow', () => { try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { capture: true });
        onDoc('visibilitychange', () => { try { if (document.visibilityState === 'visible') window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { passive: true });
        onWin('resume', () => { try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { capture: true });
      })();

      if (FEATURE_FLAGS.iframeInjection) {
        watchIframes();
      }
    });
  }

  VSC_MAIN();
})();
