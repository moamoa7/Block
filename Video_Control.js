// ==UserScript==
// @name         Video_Control (v159.9.12 - Ultimate Uncapped + Adaptive SVG)
// @namespace    https://github.com/
// @version      159.9.12
// @description  Video Control: High-End PC version. No frame skips, direct parameters, plus advanced CAS-like morphology edge-gating for SVG mode.
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
// @grant        none
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
    function vscSignal(payload) { try { window.__VSC_INTERNAL__?.Bus?.signal?.(payload); } catch (_) {} }
    function isEditableTarget(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); }

    const __globalHooksAC = new AbortController(), __globalSig = __globalHooksAC.signal;
    function on(target, type, fn, opts = {}) { target.addEventListener(type, fn, { ...opts, signal: __globalSig }); }
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
    
    // 저사양 판단 로직 삭제: 항상 고사양(High-End)으로 작동하도록 강제
    const CONFIG = Object.freeze({ IS_MOBILE: detectMobile(), IS_LOW_END: false, TOUCHED_MAX: 140, VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: false });

    const FEATURE_FLAGS = Object.freeze({
      trackShadowRoots: true,
      iframeInjection: true,
      zoomFeature: true
    });

    const PERF_POLICY = Object.freeze({
      registry: { shadowLRUMax: 12, spaRescanDebounceMs: 220 }
    });

    const RUNTIME_GUARD = Object.freeze({
      webgl: { failCooldownMs: 5000, failThreshold: 3 },
      audio: { createSourceCooldownMs: 5000 },
      targeting: { hysteresisMs: 650, hysteresisMargin: 0.8 }
    });

    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
    const log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

    const VIDEO_STATE_TEMPLATE = Object.freeze({
      visible: false,
      rect: null,
      ir: 0,
      bound: false,
      rateState: null,
      audioFailUntil: 0,
      applied: false,
      fxBackend: null,
      desiredRate: undefined,
      lastFilterUrl: null,
      rectT: 0,
      rectEpoch: -1,
      fsPatched: false,
      webglFailCount: 0,
      webglDisabledUntil: 0,
      tainted: false
    });

    const videoStateMap = new WeakMap();
    function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = { ...VIDEO_STATE_TEMPLATE }; videoStateMap.set(v, st); } return st; }

    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({
      has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; },
      toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); }
    });

    const PRESETS = Object.freeze({
      detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 7, sharp2Add: 5, clarityAdd: 6 }, M: { sharpAdd: 14, sharp2Add: 10, clarityAdd: 12 }, L: { sharpAdd: 21, sharp2Add: 15, clarityAdd: 18 }, XL: { sharpAdd: 28, sharp2Add: 20, clarityAdd: 24 } },
      grade: {
        brOFF: { gammaF: 1.00, brightAdd: 0 },
        S:     { gammaF: 1.02, brightAdd: 1.8 },
        M:     { gammaF: 1.07, brightAdd: 4.4 },
        L:     { gammaF: 1.15, brightAdd: 9 },
        DS:    { gammaF: 1.05, brightAdd: 3.6 },
        DM:    { gammaF: 1.10, brightAdd: 7.2 },
        DL:    { gammaF: 1.20, brightAdd: 10.8 }
      }
    });

    const DEFAULTS = {
      video: {
        presetS: 'off',
        presetB: 'brOFF',
        presetMix: 1.0,
        shadowBandMask: 0,
        brightStepLevel: 0
      },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, renderMode: 'svg', zoomEn: false }
    };

    const P = Object.freeze({
      APP_ACT: 'app.active',
      APP_UI: 'app.uiVisible',
      APP_APPLY_ALL: 'app.applyAll',
      APP_RENDER_MODE: 'app.renderMode',
      APP_ZOOM_EN: 'app.zoomEn',
      V_PRE_S: 'video.presetS',
      V_PRE_B: 'video.presetB',
      V_PRE_MIX: 'video.presetMix',
      V_SHADOW_MASK: 'video.shadowBandMask',
      V_BRIGHT_STEP: 'video.brightStepLevel',
      A_EN: 'audio.enabled',
      A_BST: 'audio.boost',
      PB_RATE: 'playback.rate',
      PB_EN: 'playback.enabled'
    });

    const APP_SCHEMA = [
      { type: 'enum', path: P.APP_RENDER_MODE, values: ['svg', 'webgl'], fallback: () => 'svg' },
      { type: 'bool', path: P.APP_APPLY_ALL },
      { type: 'bool', path: P.APP_ZOOM_EN }
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
            s.text = __VSC_INJECT_SOURCE;
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
    function patchFullscreenRequest(video) { const st = getVState(video); if (!video || st.fsPatched) return; st.fsPatched = true; if (typeof video.webkitEnterFullscreen === 'function') return; const origReq = video.requestFullscreen || video.webkitRequestFullscreen || video.msRequestFullscreen; if (!origReq) return; const runWrappedFs = () => { const wrap = ensureFsWrapper(video); const cleanupIfNotFullscreen = () => { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video); }; if (wrap) { const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen; if (typeof req === 'function') { try { const ret = req.call(wrap); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } } } try { const ret = origReq.call(video); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } }; if (video.requestFullscreen) patchMethodSafe(video, 'requestFullscreen', function () { return runWrappedFs(); }); if (video.webkitRequestFullscreen) patchMethodSafe(video, 'webkitRequestFullscreen', function () { return runWrappedFs(); }); if (video.msRequestFullscreen) patchMethodSafe(video, 'msRequestFullscreen', function () { return runWrappedFs(); }); }
    function onFsChange() { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl) document.querySelectorAll('video').forEach(v => { if (fsWraps.has(v)) restoreFromFsWrapper(v); }); if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure(); }
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
    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
    function getActivePiPVideo() { const wk = findWebkitPiPVideo(); if (wk) return wk; if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement; if (__activeDocumentPiPWindow && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo; return null; }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

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
      function getTargetVideo(e) { const path = typeof e.composedPath === 'function' ? e.composedPath() : null; if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } } const el = document.elementFromPoint(e.clientX || (e.touches && e.touches[0]?.clientX), e.clientY || (e.touches && e.touches[0]?.clientY)); let v = el?.tagName === 'VIDEO' ? el : el?.closest?.('video') || null; if (!v && window.__VSC_INTERNAL__?.App) { v = window.__VSC_INTERNAL__.App.getActiveVideo(); } return v; }

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

          if (!v.muted && (v.volume == null || v.volume > 0.01)) s += (audioBoostOn ? 2.2 : 1.2);
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
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
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

    const __tempGainCache = new Map();
    function tempToRgbGain(temp) {
      const t = Math.max(-25, Math.min(25, Number(temp) || 0)); const key = Math.round(t * 10) / 10;
      if (__tempGainCache.has(key)) return __tempGainCache.get(key);
      let rs = 1, gs = 1, bs = 1; if (key > 0) { rs = 1 + key * 0.012; gs = 1 + key * 0.003; bs = 1 - key * 0.010; } else { const k = -key; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.010; }
      const out = { rs, gs, bs }; if (__tempGainCache.size > 1024) __tempGainCache.clear(); __tempGainCache.set(key, out); return out;
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

    // 완전히 해제된 직접 매핑 (보정치/가드 삭제)
    function composeBaseVideoParams(out, vUser, Utils) {
      const clamp = Utils.clamp; const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);
      const pD = PRESETS.detail[vUser.presetS] || PRESETS.detail.off, pB = PRESETS.grade[vUser.presetB] || PRESETS.grade.brOFF;
      const preGammaF = lerp(1.0, pB.gammaF ?? 1.0, mix), preBright = (pB.brightAdd || 0) * mix;
      const preSharp = (pD.sharpAdd || 0) * mix, preSharp2 = (pD.sharp2Add || 0) * mix, preClarity = (pD.clarityAdd || 0) * mix;

      out.gain = 1.0; 
      out.gamma = clamp(preGammaF, 0.1, 5.0); 
      out.contrast = clamp(1.0, 0.1, 5.0); 
      out.satF = clamp(1.0, 0.0, 5.0); 
      out.bright = clamp(preBright, -100, 100); 
      out.temp = 0; 
      out.mid = 0; 
      out.toe = 0; 
      out.shoulder = 0;
      out.sharp = clamp(preSharp, 0, 100); 
      out.sharp2 = clamp(preSharp2, 0, 100); 
      out.clarity = clamp(preClarity, 0, 100);
      return out;
    }

    function applyShadowBandStack(out, shadowBandMask, Utils) {
      const clamp = Utils.clamp;
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

      out.toe = clamp((out.toe || 0) + toeAdd, -50, 50);
      out.mid = clamp((out.mid || 0) + midAdd, -5, 5);
      out.bright = clamp((out.bright || 0) + brightAdd, -100, 100);
      out.gamma = clamp((out.gamma || 1) * gammaMul, 0.1, 5.0);
      out.contrast = clamp((out.contrast || 1) * contrastMul, 0.1, 5.0);
      out.satF = clamp((out.satF || 1) * satMul, 0.0, 5.0);

      return out;
    }

    function applyBrightStepStack(out, brightStepLevel, Utils) {
      const clamp = Utils.clamp;
      const lvl = Math.max(0, Math.min(3, Math.round(Number(brightStepLevel) || 0)));
      if (!lvl) return out;

      const table = {
        1: { brightAdd: 1.8, gammaMul: 1.02, contrastMul: 0.995 },
        2: { brightAdd: 3.8, gammaMul: 1.05, contrastMul: 0.990 },
        3: { brightAdd: 6.0, gammaMul: 1.08, contrastMul: 0.985 }
      };
      const s = table[lvl];

      out.bright   = clamp((out.bright || 0) + s.brightAdd, -100, 100);
      out.gamma    = clamp((out.gamma || 1) * s.gammaMul, 0.1, 5.0);
      out.contrast = clamp((out.contrast || 1) * s.contrastMul, 0.1, 5.0);
      return out;
    }

    function composeVideoParamsInto(out, vUser, Utils) {
      composeBaseVideoParams(out, vUser, Utils);
      applyShadowBandStack(out, vUser.shadowBandMask, Utils);
      applyBrightStepStack(out, vUser.brightStepLevel, Utils);
      return out;
    }

    // WebGL 매핑 단순화 (가중치 감쇄 완전 삭제)
    function projectVValsForWebGL(vVals) {
      const out = { ...vVals };
      const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

      const sharp = Number(out.sharp || 0), sharp2 = Number(out.sharp2 || 0), clarity = Number(out.clarity || 0);
      out.sharp = clamp(sharp + sharp2 + clarity, 0, 100);

      out.bright   = clamp(Number(out.bright || 0), -100, 100);
      out.contrast = clamp(Number(out.contrast || 1), 0.1, 5.0);
      out.gamma    = clamp(Number(out.gamma || 1), 0.1, 5.0);

      out.sharp2 = 0; out.clarity = 0; out.toe = 0; out.shoulder = 0; out.mid = 0;
      return out;
    }

    const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

    function createVideoParamsMemo(Store, P, Utils) {
        let lastKey = '';
        let lastSvg = null;
        let lastWebgl = null;
        return {
            get(vfUser, rMode, activeTarget) {
                const w = activeTarget ? (activeTarget.videoWidth || 0) : 0;
                const h = activeTarget ? (activeTarget.videoHeight || 0) : 0;
                let hdr = 0; try { hdr = (window.matchMedia && matchMedia('(dynamic-range: high)').matches) ? 1 : 0; } catch (_) {}
                const key = `${Store.rev()}|${rMode}|${w}x${h}|hdr:${hdr}`;

                if (key === lastKey && lastSvg && lastWebgl) {
                    return rMode === 'webgl' ? lastWebgl : lastSvg;
                }
                const base = {};
                composeVideoParamsInto(base, vfUser, Utils);

                lastSvg = base;
                lastWebgl = projectVValsForWebGL(base);
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
          const msg = { __vsc_sync: true, token: 'VSC_SYNC_MSG_v159', p: key, val };
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
      
      const io = new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.ir = e.intersectionRatio || 0; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.01, rootMargin: '300px' });
      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
      const ro = new ResizeObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); st.rect = e.contentRect ? el.getBoundingClientRect() : null; st.rectT = now; st.rectEpoch = -1; dirty.videos.add(el); changed = true; } if (changed) requestRefreshCoalesced(); });
      const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; patchFullscreenRequest(el); videos.add(el); io.observe(el); try { ro.observe(el); } catch (_) {} };
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
      let pruneIterVideos = null; function pruneBatchRoundRobinNoAlloc(set, visibleSet, dirtySet, unobserveFn, batch = 200) { let removed = 0; let scanned = 0; if (!pruneIterVideos) pruneIterVideos = set.values(); while (scanned < batch) { let n = pruneIterVideos.next(); if (n.done) { pruneIterVideos = set.values(); n = pruneIterVideos.next(); if (n.done) break; } const el = n.value; if (el && !el.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} try { ro.unobserve(el); } catch (_) {} removed++; } scanned++; } return removed; }
      
      return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneBatchRoundRobinNoAlloc(videos, visible.videos, dirty.videos, io.unobserve.bind(io), 220); if(removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { for (const r of walkRoots(document.body || document.documentElement)) { WorkQ.enqueue(r); } } };
    }

    function createAudio(sm) {
      let ctx, compressor, dry, wet, target = null, currentSrc = null, wetConnected = false; let srcMap = new WeakMap(); let lastDryOn = null; let lastWetGain = null; let gestureHooked = false;
      const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') { await ctx.resume(); } if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
      const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; onWin('pointerdown', onGesture, { passive: true, capture: true }); onWin('keydown', onGesture, { passive: true, capture: true }); };
      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') { ctx = null; compressor = null; dry = null; wet = null; currentSrc = null; wetConnected = false; srcMap = new WeakMap(); }
        if (ctx) return true;
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { ctx = new AC(); } ensureGestureResumeHook();
        compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.knee.value = 24; compressor.ratio.value = 4; compressor.attack.value = 0.005; compressor.release.value = 0.20;
        dry = ctx.createGain(); wet = ctx.createGain(); dry.connect(ctx.destination); wet.connect(ctx.destination); compressor.connect(wet); return true;
      };
      const updateMix = () => { if (!ctx) return; const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)), boost = Math.pow(10, sm.get(P.A_BST) / 20), dryTarget = en ? 0 : 1, wetTarget = en ? boost : 0, t = ctx.currentTime; if (lastDryOn !== dryTarget) { try { dry.gain.cancelScheduledValues(t); dry.gain.setTargetAtTime(dryTarget, t, 0.015); } catch(e) { dry.gain.value = dryTarget; } lastDryOn = dryTarget; } if (lastWetGain == null || Math.abs(lastWetGain - wetTarget) > 1e-4) { try { wet.gain.cancelScheduledValues(t); wet.gain.setTargetAtTime(wetTarget, t, 0.015); } catch(e) { wet.gain.value = wetTarget; } lastWetGain = wetTarget; } if (currentSrc) { if (en && !wetConnected) { try { currentSrc.connect(compressor); wetConnected = true; } catch (_) {} } else if (!en && wetConnected) { try { currentSrc.disconnect(compressor); wetConnected = false; } catch (_) {} } } };
      const disconnectAll = () => { if (currentSrc) { if (wetConnected) { try { currentSrc.disconnect(compressor); } catch (_) {} } try { currentSrc.disconnect(dry); } catch (_) {} } currentSrc = null; target = null; wetConnected = false; };
      async function destroy() { try { disconnectAll(); } catch (_) {} try { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} try { if (ctx && ctx.state !== 'closed') { await ctx.close(); } } catch (_) {} ctx = null; compressor = null; dry = null; wet = null; currentSrc = null; target = null; wetConnected = false; lastDryOn = null; lastWetGain = null; srcMap = new WeakMap(); }
      return { setTarget: (v) => { const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); const st = v ? getVState(v) : null; if (st && st.audioFailUntil > performance.now()) { if (v !== target) { disconnectAll(); target = v; } updateMix(); return; } if (v !== target) { disconnectAll(); target = v; } if (!v) { updateMix(); return; } if (!enabled && !currentSrc) { updateMix(); return; } if (!ensureCtx()) return; if (!currentSrc) { try { let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); } s.connect(dry); currentSrc = s; } catch (_) { st.audioFailUntil = performance.now() + RUNTIME_GUARD.audio.createSourceCooldownMs; disconnectAll(); } } updateMix(); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
    }

    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(720);
      const qInt = (v, step) => Math.round(v / step), setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; node.setAttribute(attr, val); } }, smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };
      
      function wantsDetailPass(s) {
        return (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)) > 0; 
      }
      const makeKeyBase = (s) => [ qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2) ].join('|');

      function getToneTableCached(steps, toeN, shoulderN, midN, gain) { const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(gain,0.06)}`; const hit = toneCache.get(key); if (hit) return hit; if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; } const toeEnd = 0.34 + Math.abs(toeN) * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1, shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN), ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g); const out = new Array(steps); let prev = 0; for (let i = 0; i < steps; i++) { const x0 = i / (steps - 1); let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0; x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1); if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); } if (shAmt > 1e-6 && x > shoulderStart) { const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)); const kk = Math.max(0.7, 1.2 + shAmt * 6.5); const shDen = (1 - Math.exp(-kk)); const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt; x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1); } let y = x; if (y < prev) y = prev; prev = y; const yy = Math.round(y * 100000) / 100000; out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy)); } const res = out.join(' '); toneCache.set(key, res); return res; }

      function makeSoftKneeTable(steps, th, knee, gammaPow = 1.0, floor = 0.0, ceil = 1.0) {
        const out = new Array(steps);
        const a = Math.max(0, th - knee);
        const b = Math.min(1, th + knee);
        for (let i = 0; i < steps; i++) {
          const x = i / (steps - 1);
          let y = smoothstep(a, b, x);
          y = Math.pow(y, gammaPow);
          y = floor + (ceil - floor) * y;
          y = Math.max(0, Math.min(1, y));
          out[i] = String(Math.round(y * 100000) / 100000);
        }
        return out.join(' ');
      }

      function makeHighlightKeepTable(steps, start = 0.68, end = 0.92, reduce = 0.45) {
        const out = new Array(steps);
        for (let i = 0; i < steps; i++) {
          const x = i / (steps - 1);
          const hi = smoothstep(start, end, x);
          const keep = 1 - hi * reduce;
          out[i] = String(Math.round(Math.max(0, Math.min(1, keep)) * 100000) / 100000);
        }
        return out.join(' ');
      }

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const fidLite = `vsc-lite-${config.VSC_ID}`, fidFull = `vsc-full-${config.VSC_ID}`;

        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' });
        const toneLite = h('feComponentTransfer', { ns: 'svg', result: 'tone' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
        const bcLinLite = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'bcLin' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
        const gamLite = h('feComponentTransfer', { ns: 'svg', in: 'bcLin', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })));
        const tmpLite = h('feComponentTransfer', { ns: 'svg', in: 'gam', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
        const satLite = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
        lite.append(toneLite, bcLinLite, gamLite, tmpLite, satLite);

        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '-15%', y: '-15%', width: '130%', height: '130%' });
        
        // Base Tone & Gamma
        const tone = h('feComponentTransfer', { ns: 'svg', result: 'tone' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
        const bcLin = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'bcLin' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
        const gam = h('feComponentTransfer', { ns: 'svg', in: 'bcLin', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })));
        
        // Morphology CAS-like Gate Construction
        const lumBase = h('feColorMatrix', { ns: 'svg', in: 'gam', type: 'matrix', values: '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0', result: 'lumBase' });
        const rngMax = h('feMorphology', { ns: 'svg', in: 'lumBase', operator: 'dilate', radius: '1', result: 'rngMax' });
        const rngMin = h('feMorphology', { ns: 'svg', in: 'lumBase', operator: 'erode', radius: '1', result: 'rngMin' });
        const rng = h('feComposite', { ns: 'svg', in: 'rngMax', in2: 'rngMin', operator: 'arithmetic', k2: '1', k3: '-1', result: 'rng' });
        const rngBlur = h('feGaussianBlur', { ns: 'svg', in: 'rng', stdDeviation: '0.6', result: 'rngBlur' });
        
        const edgeGate = h('feComponentTransfer', { ns: 'svg', in: 'rngBlur', result: 'edgeGate' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
        const hlKeep = h('feComponentTransfer', { ns: 'svg', in: 'lumBase', result: 'hlKeep' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '1 1' })));
        const gate = h('feBlend', { ns: 'svg', in: 'edgeGate', in2: 'hlKeep', mode: 'multiply', result: 'gate' });
        const gateInv = h('feComponentTransfer', { ns: 'svg', in: 'gate', result: 'gateInv' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '-1', intercept: '1' })));

        // Base Sharpening (Unsharp Mask)
        const b1 = h('feGaussianBlur', { ns: 'svg', in: 'gam', stdDeviation: '0', result: 'b1' }), sh1 = h('feComposite', { ns: 'svg', in: 'gam', in2: 'b1', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh1' });
        const b2 = h('feGaussianBlur', { ns: 'svg', in: 'sh1', stdDeviation: '0', result: 'b2' }), sh2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'b2', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh2' });
        const bc = h('feGaussianBlur', { ns: 'svg', in: 'sh2', stdDeviation: '0', result: 'bc' }), cl = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'bc', operator: 'arithmetic', k2: '1', result: 'cl' });

        // Luma-Biased Sharp Result & Gate Application
        const sharpDesat = h('feColorMatrix', { ns: 'svg', in: 'cl', type: 'saturate', values: '0.55', result: 'sharpDesat' });
        const sharpBiased = h('feComposite', { ns: 'svg', in: 'cl', in2: 'sharpDesat', operator: 'arithmetic', k2: '0.25', k3: '0.75', result: 'sharpBiased' });
        const origMasked = h('feBlend', { ns: 'svg', in: 'gam', in2: 'gateInv', mode: 'multiply', result: 'origMasked' });
        const sharpMasked = h('feBlend', { ns: 'svg', in: 'sharpBiased', in2: 'gate', mode: 'multiply', result: 'sharpMasked' });
        const mixedSharp = h('feComposite', { ns: 'svg', in: 'origMasked', in2: 'sharpMasked', operator: 'arithmetic', k2: '1', k3: '1', result: 'mixedSharp' });

        // Final Temp & Sat
        const tmp = h('feComponentTransfer', { ns: 'svg', in: 'mixedSharp', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
        const sat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
        
        full.append(tone, bcLin, gam, lumBase, rngMax, rngMin, rng, rngBlur, edgeGate, hlKeep, gate, gateInv, b1, sh1, b2, sh2, bc, cl, sharpDesat, sharpBiased, origMasked, sharpMasked, mixedSharp, tmp, sat); defs.append(lite, full);

        const tryAppend = () => {
          const target = root.body || root.documentElement || root;
          if (target && target.appendChild) { target.appendChild(svg); return true; }
          return false;
        };
        if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }

        return {
          fidLite, fidFull,
          common: { toneFuncs: [...Array.from(toneLite.children), ...Array.from(tone.children)], bcLinFuncs: [...Array.from(bcLinLite.children), ...Array.from(bcLin.children)], gamFuncs: [...Array.from(gamLite.children), ...Array.from(gam.children)], tmpFuncs: [...Array.from(tmpLite.children), ...Array.from(tmp.children)], sats: [satLite, sat] },
          detail: { b1, sh1, b2, sh2, bc, cl },
          casLike: { rngMax, rngMin, rngBlur, edgeGateFuncs: Array.from(edgeGate.children), hlKeepFuncs: Array.from(hlKeep.children), sharpDesat, sharpBiased },
          st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', detailKey: '', __b1: '', __sh1k2: '', __sh1k3: '', __b2: '', __sh2k2: '', __sh2k3: '', __bc: '', __clk2: '', __clk3: '', edgeGateKey: '', edgeGateTable: '', hlKeepKey: '', hlKeepTable: '', morphKey: '', __rngR: '', __rngBlur: '', __sharpDesatSat: '', __sharpBiasK2: '', __sharpBiasK3: '' }
        };
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key:'', url:'' }; urlCache.set(root, dc); }
        const detailOn = wantsDetailPass(s); const key = `${detailOn ? 'F' : 'L'}|${makeKeyBase(s)}`; if (dc.key === key) return dc.url;
        let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }
        if (nodes.st.lastKey !== key) {
          nodes.st.lastKey = key; const st = nodes.st, steps = 128;
          const gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08; const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(clamp(s.mid||0,-1,1),0.02)}|${qInt(s.gain||1,gainQ)}`;
          const table = (st.toneKey !== tk) ? getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.gain||1,gainQ)*gainQ) : st.toneTable;
          const con = clamp(s.contrast || 1, 0.1, 5.0), brightOffset = clamp((s.bright || 0) / 1000, -0.5, 0.5), intercept = clamp(0.5 * (1 - con) + brightOffset, -5, 5), bcLinKey = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
          const gk = (1/clamp(s.gamma||1,0.1,5.0)).toFixed(4); const satVal = clamp(s.satF ?? 1, 0, 5.0).toFixed(2);
          const { rs, gs, bs } = tempToRgbGain(s.temp); const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`;
          const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
          
          // CAS-like Parameters Calculation
          const sharpTotal = (s.sharp || 0) + (s.sharp2 || 0) + (s.clarity || 0);
          const sharpN = Math.max(0, Math.min(1, sharpTotal / 120));
          const morphRadius = 1;
          const rngBlurStd = 0.6 + sharpN * 0.35;
          const th = 0.030 - sharpN * 0.014;
          const knee = 0.018 + sharpN * 0.020;
          const gateGamma = 1.15 - sharpN * 0.25;
          const edgeGateTable = makeSoftKneeTable(64, th, knee, gateGamma, 0.0, 1.0);
          const brightNorm = Math.max(-1, Math.min(1, (s.bright || 0) / 20));
          const hlStart = 0.70 - Math.max(0, brightNorm) * 0.06;
          const hlEnd = 0.93;
          const hlReduce = 0.35 + sharpN * 0.20;
          const hlKeepTable = makeHighlightKeepTable(64, hlStart, hlEnd, hlReduce);
          const desatSat = 0.45 + (1 - sharpN) * 0.20;
          const chromaKeep = 0.18 + (1 - sharpN) * 0.12;

          st._pending = { tk, table, bcLinKey, con, intercept, gk, satVal, tmk, rs, gs, bs, dk, s, detailOn, edgeGateTable, hlKeepTable, morphRadius, rngBlurStd, desatSat, chromaKeep };
          if (!st._svgUpdatePending) {
            st._svgUpdatePending = true;
            queueMicrotask(() => {
              st._svgUpdatePending = false; const p = st._pending; if (!p) return;
              if (st.toneKey !== p.tk) { st.toneKey = p.tk; if (st.toneTable !== p.table) { st.toneTable = p.table; for (const fn of nodes.common.toneFuncs) fn.setAttribute('tableValues', p.table); } }
              if (st.bcLinKey !== p.bcLinKey) { st.bcLinKey = p.bcLinKey; for (const fn of nodes.common.bcLinFuncs) { fn.setAttribute('slope', p.con.toFixed(3)); fn.setAttribute('intercept', p.intercept.toFixed(4)); } }
              if (st.gammaKey !== p.gk) { st.gammaKey = p.gk; for (const fn of nodes.common.gamFuncs) fn.setAttribute('exponent', p.gk); }
              if (st.satKey !== p.satVal) { st.satKey = p.satVal; for (const satNode of nodes.common.sats) satNode.setAttribute('values', p.satVal); }
              if (st.tempKey !== p.tmk) { st.tempKey = p.tmk; for(let i=0; i<nodes.common.tmpFuncs.length; i+=3) { nodes.common.tmpFuncs[i].setAttribute('slope', p.rs.toFixed(3)); nodes.common.tmpFuncs[i+1].setAttribute('slope', p.gs.toFixed(3)); nodes.common.tmpFuncs[i+2].setAttribute('slope', p.bs.toFixed(3)); } }
              if (p.detailOn && st.detailKey !== p.dk) {
                st.detailKey = p.dk; const sc = (x) => x * x * (3 - 2 * x);
                const v1 = (p.s.sharp || 0) / 50, kC = sc(Math.min(1, v1)) * 2.2; setAttr(nodes.detail.b1, 'stdDeviation', v1 > 0 ? (0.65 - sc(Math.min(1, v1)) * 0.2).toFixed(2) : '0', st, '__b1'); setAttr(nodes.detail.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2'); setAttr(nodes.detail.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3');
                const v2 = (p.s.sharp2 || 0) / 50, kF = sc(Math.min(1, v2)) * 4.8; setAttr(nodes.detail.b2, 'stdDeviation', v2 > 0 ? '0.25' : '0', st, '__b2'); setAttr(nodes.detail.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2'); setAttr(nodes.detail.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3');
                const clVal = (p.s.clarity || 0) / 50; setAttr(nodes.detail.bc, 'stdDeviation', clVal > 0 ? '1.1' : '0', st, '__bc'); setAttr(nodes.detail.cl, 'k2', (1 + clVal * 1.5).toFixed(3), st, '__clk2'); setAttr(nodes.detail.cl, 'k3', (-clVal * 1.5).toFixed(3), st, '__clk3');
                
                // CAS-like Updates
                const morphKey = `${p.morphRadius}`;
                if (st.morphKey !== morphKey) { st.morphKey = morphKey; setAttr(nodes.casLike.rngMax, 'radius', String(p.morphRadius), st, '__rngR'); setAttr(nodes.casLike.rngMin, 'radius', String(p.morphRadius), st, '__rngR'); }
                const rngBlurKey = p.rngBlurStd.toFixed(2);
                if (st.__rngBlur !== rngBlurKey) { st.__rngBlur = rngBlurKey; nodes.casLike.rngBlur.setAttribute('stdDeviation', rngBlurKey); }
                const edgeGateKey = p.edgeGateTable;
                if (st.edgeGateTable !== edgeGateKey) { st.edgeGateTable = edgeGateKey; for (const fn of nodes.casLike.edgeGateFuncs) fn.setAttribute('tableValues', p.edgeGateTable); }
                const hlKeepKey = p.hlKeepTable;
                if (st.hlKeepTable !== hlKeepKey) { st.hlKeepTable = hlKeepKey; for (const fn of nodes.casLike.hlKeepFuncs) fn.setAttribute('tableValues', p.hlKeepTable); }
                const ds = p.desatSat.toFixed(2);
                if (st.__sharpDesatSat !== ds) { st.__sharpDesatSat = ds; nodes.casLike.sharpDesat.setAttribute('values', ds); }
                const k2 = p.chromaKeep.toFixed(3); const k3 = (1 - p.chromaKeep).toFixed(3);
                if (st.__sharpBiasK2 !== k2) { st.__sharpBiasK2 = k2; nodes.casLike.sharpBiased.setAttribute('k2', k2); }
                if (st.__sharpBiasK3 !== k3) { st.__sharpBiasK3 = k3; nodes.casLike.sharpBiased.setAttribute('k3', k3); }
              }
            });
          }
        }
        const url = `url(#${detailOn ? nodes.fidFull : nodes.fidLite})`; dc.key = key; dc.url = url; return url;
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

      function buildShaderSources(gl) {
        const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (isGL2) {
          return {
            vs: `#version 300 es\nin vec2 aPosition;\nin vec2 aTexCoord;\nout vec2 vTexCoord;\nvoid main() {\n  gl_Position = vec4(aPosition, 0.0, 1.0);\n  vTexCoord = aTexCoord;\n}`,
            fsColorOnly: `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\nuniform sampler2D uVideoTex;\nuniform vec4 uParams;\nuniform vec4 uParams2;\nuniform vec3 uRGBGain;\nconst vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);\nvec3 softClip(vec3 c, float knee) {\n  vec3 x = max(c - 1.0, vec3(0.0));\n  return c - (x * x) / (x + vec3(knee));\n}\nvoid main() {\n  vec3 color = texture(uVideoTex, vTexCoord).rgb;\n  color *= uRGBGain;\n  color += (uParams2.x / 1000.0);\n  color = (color - 0.5) * uParams.y + 0.5;\n  float luma = dot(color, LUMA);\n  float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0);\n  float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma);\n  float currentSat = uParams.z * (1.0 - 0.05 * satReduce);\n  color = luma + (color - luma) * currentSat;\n  color *= uParams.x;\n  if (uParams.w != 1.0) color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w));\n  color = softClip(color, 0.18);\n  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);\n}`,
            fsSharpen: `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\nuniform sampler2D uVideoTex;\nuniform vec2 uResolution;\nuniform vec4 uParams;\nuniform vec4 uParams2;\nuniform vec3 uRGBGain;\nconst vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);\nvec3 softClip(vec3 c, float knee) {\n  vec3 x = max(c - 1.0, vec3(0.0));\n  return c - (x * x) / (x + vec3(knee));\n}\nvec3 casLiteSharpen(sampler2D tex, vec2 uv, vec2 texel, float strength) {\n  vec3 c = texture(tex, uv).rgb;\n  vec3 n = texture(tex, uv + vec2(0.0, -texel.y)).rgb;\n  vec3 s = texture(tex, uv + vec2(0.0, texel.y)).rgb;\n  vec3 w = texture(tex, uv + vec2(-texel.x, 0.0)).rgb;\n  vec3 e = texture(tex, uv + vec2(texel.x, 0.0)).rgb;\n  float lC = dot(c, LUMA); float lN = dot(n, LUMA); float lS = dot(s, LUMA);\n  float lW = dot(w, LUMA); float lE = dot(e, LUMA);\n  float lMin = min(lC, min(min(lN, lS), min(lW, lE)));\n  float lMax = max(lC, max(max(lN, lS), max(lW, lE)));\n  float range = max(1e-4, lMax - lMin);\n  float edgeGate = smoothstep(0.02, 0.18, range);\n  float gain = strength * edgeGate;\n  vec3 avg4 = (n + s + w + e) * 0.25;\n  vec3 hp = c - avg4;\n  vec3 lo = min(c, min(min(n, s), min(w, e)));\n  vec3 hi = max(c, max(max(n, s), max(w, e)));\n  vec3 outC = c + hp * (gain * 2.2);\n  return clamp(outC, lo - range * 0.10, hi + range * 0.10);\n}\nvoid main() {\n  vec2 texel = 1.0 / uResolution;\n  vec3 color = texture(uVideoTex, vTexCoord).rgb;\n  if (uParams2.y > 0.0) color = casLiteSharpen(uVideoTex, vTexCoord, texel, uParams2.y);\n  color *= uRGBGain;\n  color += (uParams2.x / 1000.0);\n  color = (color - 0.5) * uParams.y + 0.5;\n  float luma = dot(color, LUMA);\n  float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0);\n  float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma);\n  float currentSat = uParams.z * (1.0 - 0.05 * satReduce);\n  color = luma + (color - luma) * currentSat;\n  color *= uParams.x;\n  if (uParams.w != 1.0) color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w));\n  color = softClip(color, 0.18);\n  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);\n}`
          };
        }
        return {
          vs: `attribute vec2 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vTexCoord = aTexCoord; }`,
          fsColorOnly: `precision highp float; varying vec2 vTexCoord; uniform sampler2D uVideoTex; uniform vec4 uParams; uniform vec4 uParams2; uniform vec3 uRGBGain; const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722); vec3 softClip(vec3 c, float knee) { vec3 x = max(c - 1.0, vec3(0.0)); return c - (x * x) / (x + vec3(knee)); } void main() { vec3 color = texture2D(uVideoTex, vTexCoord).rgb; color *= uRGBGain; color += (uParams2.x / 1000.0); color = (color - 0.5) * uParams.y + 0.5; float luma = dot(color, LUMA); float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0); float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma); float currentSat = uParams.z * (1.0 - 0.05 * satReduce); color = luma + (color - luma) * currentSat; color *= uParams.x; if (uParams.w != 1.0) { color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w)); } color = softClip(color, 0.18); gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0); }`,
          fsSharpen: `precision highp float; varying vec2 vTexCoord; uniform sampler2D uVideoTex; uniform vec2 uResolution; uniform vec4 uParams; uniform vec4 uParams2; uniform vec3 uRGBGain; const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722); vec3 softClip(vec3 c, float knee) { vec3 x = max(c - 1.0, vec3(0.0)); return c - (x * x) / (x + vec3(knee)); } vec3 casLiteSharpen(sampler2D tex, vec2 uv, vec2 texel, float strength) { vec3 c = texture2D(tex, uv).rgb; vec3 n = texture2D(tex, uv + vec2(0.0, -texel.y)).rgb; vec3 s = texture2D(tex, uv + vec2(0.0, texel.y)).rgb; vec3 w = texture2D(tex, uv + vec2(-texel.x, 0.0)).rgb; vec3 e = texture2D(tex, uv + vec2(texel.x, 0.0)).rgb; float lC = dot(c, LUMA); float lN = dot(n, LUMA); float lS = dot(s, LUMA); float lW = dot(w, LUMA); float lE = dot(e, LUMA); float lMin = min(lC, min(min(lN, lS), min(lW, lE))); float lMax = max(lC, max(max(lN, lS), max(lW, lE))); float range = max(1e-4, lMax - lMin); float edgeGate = smoothstep(0.02, 0.18, range); float gain = strength * edgeGate; vec3 avg4 = (n + s + w + e) * 0.25; vec3 hp = c - avg4; vec3 lo = min(c, min(min(n, s), min(w, e))); vec3 hi = max(c, max(max(n, s), max(w, e))); vec3 outC = c + hp * (gain * 2.2); return clamp(outC, lo - range * 0.10, hi + range * 0.10); } void main() { vec2 texel = 1.0 / uResolution; vec3 color = texture2D(uVideoTex, vTexCoord).rgb; if (uParams2.y > 0.0) color = casLiteSharpen(uVideoTex, vTexCoord, texel, uParams2.y); color *= uRGBGain; color += (uParams2.x / 1000.0); color = (color - 0.5) * uParams.y + 0.5; float luma = dot(color, LUMA); float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0); float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma); float currentSat = uParams.z * (1.0 - 0.05 * satReduce); color = luma + (color - luma) * currentSat; color *= uParams.x; if (uParams.w != 1.0) { color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w)); } color = softClip(color, 0.18); gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0); }`
        };
      }

      class WebGLPipeline {
        constructor() {
          this.canvas = null; this.gl = null; this.activeProgramKind = ''; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this.restoreVideoStyle = null; this.renderDriver = createFrameDriver(); this.disabledUntil = 0;
          this._texW = 0; this._texH = 0; this._loopToken = 0; this._loopRunning = false;
          this._qMon = { lastT: 0, lastDropped: 0, dropRateEma: 0 };
          this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0;
          this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null;
          this._onContextLost = (e) => { e.preventDefault(); this.disabledUntil = performance.now() + 3000; this.active = false; this._loopToken++; this._loopRunning = false; };
          this._onContextRestored = () => { try { this.disposeGLResources({ keepCanvasListeners: true }); if (this.initGLResourcesOnExistingCanvas()) { if (this.video) { this.active = true; this.startRenderLoop(); } } else { this.disabledUntil = performance.now() + 5000; } } catch (_) { this.disabledUntil = performance.now() + 5000; } };
        }
        ensureCanvas() {
          if (this.canvas) return;
          this.canvas = document.createElement('canvas');
          this.canvas.style.cssText = `position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; object-fit: contain !important; display: block !important; pointer-events: none !important; margin: 0 !important; padding: 0 !important;`;
          this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false });
          this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, { passive: true });
        }
        _bindProgramHandles(program, key) {
          const gl = this.gl; gl.useProgram(program);
          const handles = { program, uResolution: gl.getUniformLocation(program, 'uResolution'), uVideoTex: gl.getUniformLocation(program, 'uVideoTex'), uParams: gl.getUniformLocation(program, 'uParams'), uParams2: gl.getUniformLocation(program, 'uParams2'), uRGBGain: gl.getUniformLocation(program, 'uRGBGain'), aPosition: gl.getAttribLocation(program, 'aPosition'), aTexCoord: gl.getAttribLocation(program, 'aTexCoord') };
          if (handles.uVideoTex) gl.uniform1i(handles.uVideoTex, 0);
          this[`handles_${key}`] = handles;
        }
        initGLResourcesOnExistingCanvas() {
          this.ensureCanvas();
          let gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true });
          if (!gl) gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true });
          if (!gl) return false; this.gl = gl;
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
            return true;
          } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
        }
        init() { return this.initGLResourcesOnExistingCanvas(); }
        attachToVideo(video) {
          if (!this.active && !this.init()) return false;
          this.video = video; this.originalParent = video.parentNode;
          this.restoreVideoStyle = patchInlineStyleImportant(video, { opacity: '0.001' });

          if (this.originalParent) {
            const cs = window.getComputedStyle(this.originalParent);
            if (cs.position === 'static') { this._parentPrevPosition = this.originalParent.style.position || ''; this.originalParent.style.position = 'relative'; this._parentStylePatched = true; this._patchedParent = this.originalParent; }
            this.originalParent.insertBefore(this.canvas, video);
          }
          if (this._styleObs) this._styleObs.disconnect();
          this._styleObs = new MutationObserver(() => { this._styleDirty = true; });
          try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
          this._styleDirty = true; this.active = true; this.startRenderLoop(); return true;
        }
        updateParams(vVals) { this.vVals = vVals; }
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

          this._styleDirty = false; this._lastStyleSyncT = now;
        }
        _updatePlaybackQuality(now) {
          const v = this.video; if (!v || typeof v.getVideoPlaybackQuality !== 'function') return;
          if (now - this._qMon.lastT < 1000) return;
          try {
            const q = v.getVideoPlaybackQuality(), dropped = q.droppedVideoFrames || 0;
            if (this._qMon.lastT > 0) { const dd = Math.max(0, dropped - this._qMon.lastDropped); this._qMon.dropRateEma = this._qMon.dropRateEma ? (this._qMon.dropRateEma * 0.8 + dd * 0.2) : dd; }
            this._qMon.lastDropped = dropped; this._qMon.lastT = now;
          } catch (_) {}
        }
        render() {
          if (!this.active || !this.gl || !this.video || !this.vVals) return; const gl = this.gl, video = this.video; const now = performance.now(); if (now < this.disabledUntil) return;
          const st = getVState(video); if (st.webglDisabledUntil && now < st.webglDisabledUntil) return;
          if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
          if (this.canvas.parentNode !== video.parentNode && video.parentNode) { this.originalParent = video.parentNode; video.parentNode.insertBefore(this.canvas, video); }
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
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.enableVertexAttribArray(H.aPosition); gl.vertexAttribPointer(H.aPosition, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.enableVertexAttribArray(H.aTexCoord); gl.vertexAttribPointer(H.aTexCoord, 2, gl.FLOAT, false, 0, 0);
          }

          const resized = (this.canvas.width !== w || this.canvas.height !== h);
          if (resized) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
          if ((resized || programChanged) && H.uResolution) { gl.uniform2f(H.uResolution, w, h); }

          const { rs, gs, bs } = tempToRgbGain(this.vVals.temp);
          if (H.uParams) gl.uniform4f(H.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);
          if (H.uParams2) gl.uniform4f(H.uParams2, this.vVals.bright || 0.0, useSharpen ? sharpNorm : 0.0, 0.0, 0.0);
          if (H.uRGBGain) gl.uniform3f(H.uRGBGain, rs, gs, bs);

          try {
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            if (this._texW !== w || this._texH !== h) { this._texW = w; this._texH = h; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            st.webglFailCount = 0;
          } catch (err) {
            st.webglFailCount = (st.webglFailCount || 0) + 1;
            if (CONFIG.DEBUG) log.warn('WebGL render failure:', err);
            if (st.webglFailCount >= RUNTIME_GUARD.webgl.failThreshold) {
              st.tainted = true;
              st.webglDisabledUntil = now + RUNTIME_GUARD.webgl.failCooldownMs;
              st.webglFailCount = 0;
              log.warn('WebGL repeated failure on video, cooling down');
              window.__VSC_INTERNAL__?.ApplyReq?.hard();
            }
          }
        }
        
        startRenderLoop() {
          if (this._loopRunning) return; this._loopRunning = true; const token = ++this._loopToken;
          const loopFn = (now, meta) => {
            if (token !== this._loopToken || !this.active || !this.video) { this._loopRunning = false; return; }
            this.render(); 
            this.scheduleNextFrame(loopFn);
          };
          this.scheduleNextFrame(loopFn);
        }
        
        scheduleNextFrame(loopFn) {
          const pausedOrHidden = !!(document.hidden || this.video?.paused);
          this.renderDriver.scheduleVideoFrame(this.video, loopFn, pausedOrHidden ? 'timeout' : 'raf', pausedOrHidden ? 220 : 90);
        }
        disposeGLResources(opts = {}) {
          const { keepCanvasListeners = false } = opts; const gl = this.gl;
          if (gl) { try { if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; } if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; } if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; } if (this.handles_color?.program) gl.deleteProgram(this.handles_color.program); if (this.handles_sharp?.program) gl.deleteProgram(this.handles_sharp.program); } catch (_) {} }
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
      return { apply: (el, vVals) => { let pipe = pipelines.get(el); if (!pipe) { pipe = new WebGLPipeline(); if (!pipe.attachToVideo(el)) return; pipelines.set(el, pipe); } pipe.updateParams(vVals); }, clear: (el) => { const pipe = pipelines.get(el); if (pipe) { pipe.shutdown(); pipelines.delete(el); } } };
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
      const marker = 'data-vsc-style'; if (!shadow.querySelector(`style[${marker}="1"]`)) { shadow.append(h('style', { [marker]: '1' }, cssText)); }
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

      function setAndHint(path, value) { const prev = sm.get(path), changed = !Object.is(prev, value); if (changed) sm.set(path, value); ApplyReq.hard(); }
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
        const dragHandle = h('div', { class: 'header' }, 'VSC 렌더링 제어 (Adaptive Uncapped)');

        const rmBtn = h('button', { id: 'rm-btn', class: 'btn', onclick: () => setAndHint(P.APP_RENDER_MODE, sm.get(P.APP_RENDER_MODE) === 'webgl' ? 'svg' : 'webgl') });
        bindStyle(rmBtn, P.APP_RENDER_MODE, (el, v) => { el.textContent = `🎨 ${v === 'webgl' ? 'WebGL' : 'SVG'}`; el.style.color = v === 'webgl' ? '#ffaa00' : '#88ccff'; el.style.borderColor = v === 'webgl' ? '#ffaa00' : '#88ccff'; });

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn', onclick: () => setAndHint(P.A_EN, !sm.get(P.A_EN)) }, '🔊 오디오업');
        bindClassToggle(boostBtn, P.A_EN, v => !!v);

        const pipBtn = h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');

        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', onclick: () => { const nextEn = !sm.get(P.APP_ZOOM_EN); setAndHint(P.APP_ZOOM_EN, nextEn); const zm = window.__VSC_INTERNAL__.ZoomManager; const v = window.__VSC_APP__?.getActiveVideo(); if (zm && v) { if (zm.isZoomed(v)) { zm.resetZoom(v); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); } } } }, '🔍 줌 제어');
        bindClassToggle(zoomBtn, P.APP_ZOOM_EN, v => !!v);

        const pwrBtn = h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power');
        bindStyle(pwrBtn, P.APP_ACT, (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; });

        const applyAllBtn = h('button', { class: 'btn', onclick: () => setAndHint(P.APP_APPLY_ALL, !sm.get(P.APP_APPLY_ALL)) }, '전체 적용');
        bindClassToggle(applyAllBtn, P.APP_APPLY_ALL, v => !!v);

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, applyAllBtn, boostBtn ]),
          h('div', { class: 'prow' }, [ pipBtn, zoomBtn, pwrBtn ]),
          h('div', { class: 'prow' }, [ h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'), h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); ApplyReq.hard(); } }, '↺ 리셋') ]),
          renderShadowBandMaskRow({ label: '블랙', key: P.V_SHADOW_MASK }),
          renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
          renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k=>k!=='off').map(k => ({ text: k, value: k })) }),
          renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(k => ({ text: k, value: k })) }),
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
        apply(video, mode, vVals, svgUrlCache) {
          const st = getVState(video);
          const effectiveMode = (mode === 'webgl' && !st.tainted) ? 'webgl' : 'svg';

          if (effectiveMode === 'webgl') {
              if (st.fxBackend === 'svg') Filters.clear(video);
              FiltersGL.apply(video, vVals);
              st.fxBackend = 'webgl';
          } else {
              if (st.fxBackend === 'webgl') FiltersGL.clear(video);
              let url = svgUrlCache?.get(video);
              if (url === undefined) { url = Filters.prepareCached(video, vVals); svgUrlCache?.set(video, url); }
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
      const softResetTransientFlags = () => { st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.rectEpoch = -1; if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; } ApplyReq.hard(); };
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

      const svgUrlCache = new WeakMap();
      for (const el of candidates) {
        if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el); const visible = (st.visible !== false), shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));

        if (!shouldApply) { clearVideoRuntimeState(el, Adapter, ApplyReq); continue; }

        if (videoFxOn) { Adapter.apply(el, rMode, vVals, svgUrlCache); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
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

      Scheduler.registerApply((force) => {
        try {
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

          const vValsEffective = videoParamsMemo.get(vf0, rMode, __activeTarget);
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

      let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
      const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick(); Scheduler.request(true);
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { Audio.setTarget(null); Audio.destroy?.(); } catch (_) {} try { __globalHooksAC.abort(); } catch (_) {} } });
    }

    const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
    const ApplyReq = createApplyRequester(Bus, Scheduler);
    window.__VSC_INTERNAL__.Bus = Bus; window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    Bus.on('signal', (s) => { if (s.forceApply) Scheduler.request(true); });

    const VALID_SYNC_KEYS = Object.values(P);
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__vsc_sync && e.data.token === 'VSC_SYNC_MSG_v159') {
        const { p, val } = e.data;
        if (p === P.APP_UI) return;
        if (VALID_SYNC_KEYS.includes(p)) {
          if (Store.get(p) !== val) Store.set(p, val);
        }
      }
    });

    const normalizeAllApp = () => { if (normalizeBySchema(Store, APP_SCHEMA)) ApplyReq.hard(); };
    [ P.APP_RENDER_MODE, P.APP_APPLY_ALL, P.APP_ZOOM_EN ].forEach(k => Store.sub(k, normalizeAllApp)); normalizeAllApp();

    const normalizeAllVideo = () => { if (normalizeBySchema(Store, VIDEO_SCHEMA)) ApplyReq.hard(); };
    [ P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_SHADOW_MASK, P.V_BRIGHT_STEP ].forEach(k => Store.sub(k, normalizeAllVideo)); normalizeAllVideo();

    const normalizeAllAudioPlayback = () => { if (normalizeBySchema(Store, AUDIO_PLAYBACK_SCHEMA)) ApplyReq.hard(); };
    [P.A_EN, P.A_BST, P.PB_EN, P.PB_RATE].forEach(k => Store.sub(k, normalizeAllAudioPlayback)); normalizeAllAudioPlayback();

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

      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, IS_LOW_END: CONFIG.IS_LOW_END });
      const FiltersGL = createFiltersWebGL(Utils);
      const Adapter = createBackendAdapter(Filters, FiltersGL);
      window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store);

      let ZoomManager = null;
      if (FEATURE_FLAGS.zoomFeature) { ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager; }

      const UI = createUI(Store, Registry, ApplyReq, Utils);

      window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
      function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} } let __vscLastUserSignalT = 0;

      onWin('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); });
      onWin('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true });

      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__;

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
  } // End of VSC_MAIN

  VSC_MAIN();
})();
