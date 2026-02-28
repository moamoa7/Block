// ==UserScript==
// @name         Video_Control (v170.42.0 - Ultimate Cinema EQ & Sharpness)
// @namespace    https://github.com/
// @version      170.42.0
// @description  Video Control: High-End PC. True Luma Sharpening, Auto Scene Neutrality, Multiband Dynamics & LUFS.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  function VSC_MAIN() {
    if (location.protocol === 'about:' || location.protocol === 'javascript:') return;
    const VSC_BOOT_KEY = Symbol.for('__VSC_BOOT_LOCK__');
    if (window[VSC_BOOT_KEY]) return;
    window[VSC_BOOT_KEY] = true;

    window.__VSC_INTERNAL__ ||= {};
    let __vscUserSignalRev = 0;

    function isEditableTarget(t) {
      try {
        if (!t) return false; let el = t; if (el.nodeType === 3) el = el.parentElement; if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable || el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')) return true;
        const role = el.getAttribute('role') || el.closest('[role]')?.getAttribute('role');
        if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
        if (el.closest('[data-editor],[data-editable],[aria-multiline="true"]')) return true;
        return false;
      } catch (_) { return false; }
    }

    const __globalHooksAC = new AbortController(), __globalSig = __globalHooksAC.signal;
    function on(target, type, fn, opts = {}) {
      const merged = { ...opts };
      if (!merged.signal) merged.signal = __globalSig;
      try { target.addEventListener(type, fn, merged); } catch (_) {}
    }
    const onWin = (type, fn, opts) => on(window, type, fn, opts), onDoc = (type, fn, opts) => on(document, type, fn, opts);

    function onPageReady(fn) {
      let ran = false; const ac = new AbortController();
      const run = () => { if (ran) return; ran = true; ac.abort(); try { fn(); } catch (e) { console.error('[VSC]', e); } };
      const check = () => { if (document.visibilityState === 'visible' && (document.readyState === 'interactive' || document.readyState === 'complete')) { run(); return true; } return false; };
      if (check()) return;
      const handler = () => { check(); };
      document.addEventListener('visibilitychange', handler, { passive: true, signal: ac.signal });
      document.addEventListener('DOMContentLoaded', handler, { once: true, signal: ac.signal });
      window.addEventListener('pageshow', handler, { passive: true, signal: ac.signal });
    }

    function detectMobile() {
      try {
        if (navigator.userAgentData?.mobile === true) return true;
        if ((navigator.maxTouchPoints || 0) >= 2 && matchMedia('(pointer: coarse)').matches) return true;
        return /Mobi|Android|iPhone/i.test(navigator.userAgent);
      } catch (_) { return false; }
    }

    const DEBUG_BY_URL = /[?&]vsc_debug=1\b/.test(location.search);
    const CONFIG = Object.freeze({ IS_MOBILE: detectMobile(), TOUCHED_MAX: 140, VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: DEBUG_BY_URL });
    const VSC_VERSION = '170.42.0', VSC_SYNC_TOKEN = `VSC_SYNC_${VSC_VERSION}_${CONFIG.VSC_ID}`;
    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1), r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t), m = Math.max(r, g, b);
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    function computeToneCurve(steps, toeN, midN, shoulderN, gain) {
      const clamp = VSC_CLAMP, g = Math.log2(Math.max(1e-6, gain)) * 0.90, denom = Math.abs(g) > 1e-6 ? (1 - Math.exp(-g)) : 0, useExp = Math.abs(denom) > 1e-6;
      const toeEnd = 0.34 + Math.abs(toeN) * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1;
      const shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN);
      const smoothstep = (a, b, x) => { const t = clamp((x - a) / Math.max(1e-6, (b - a)), 0, 1); return t * t * (3 - 2 * t); };
      const out = new Float64Array(steps); let prev = 0;
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1); let x = useExp ? (1 - Math.exp(-g * x0)) / denom : x0; x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
        if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)), kk = Math.max(0.7, 1.2 + shAmt * 6.5), shDen = (1 - Math.exp(-kk)), shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        if (x < prev) x = prev; prev = x; out[i] = x;
      }
      return out;
    }

    const VSC_MEDIA = (() => {
      let hdr = 0;
      try {
        if (window.matchMedia) {
          const mql = matchMedia('(dynamic-range: high)'); hdr = mql.matches ? 1 : 0; const handler = (e) => { hdr = e.matches ? 1 : 0; };
          mql.addEventListener('change', handler);
        }
      } catch (_) {}
      return Object.freeze({ isHdr: () => hdr === 1 });
    })();

    const DEFENSE_KEYS = Object.freeze({ hideAmbientGlow: 'vsc.hideAmbientGlow' });
    function setHideAmbientGlow(enable) {
      try {
        const id = 'vsc-hide-ambient-style'; let style = document.getElementById(id);
        if (enable) {
          if (!style) { style = document.createElement('style'); style.id = id; style.textContent = `#cinematics, .ytp-glow-effect, .ytp-glow-canvas-container, [id^="ambient-"] { display: none !important; contain: strict !important; }`; (document.head || document.documentElement).appendChild(style); }
        } else { style?.remove?.(); }
        try { localStorage.setItem(DEFENSE_KEYS.hideAmbientGlow, enable ? '1' : '0'); } catch (_) {}
      } catch (_) {}
    }
    const HIDE_AMBIENT_GLOW = (() => { try { const v = localStorage.getItem(DEFENSE_KEYS.hideAmbientGlow); if (v === '1') return true; if (v === '0') return false; } catch (_) {} return true; })();
    setHideAmbientGlow(HIDE_AMBIENT_GLOW);

    function installShadowRootEmitter() {
      if (window.__VSC_SHADOW_EMITTER_INSTALLED__) return;
      window.__VSC_SHADOW_EMITTER_INSTALLED__ = true;
      const proto = Element.prototype, orig = proto.attachShadow; if (typeof orig !== 'function') return;
      const patchedAttachShadow = function(init) { const sr = orig.call(this, init); try { document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: sr })); } catch (_) {} return sr; };
      try { Object.defineProperty(proto, 'attachShadow', { value: patchedAttachShadow, configurable: true, writable: true }); } catch (_) { try { proto.attachShadow = patchedAttachShadow; } catch (__) {} }
      queueMicrotask(() => {
        try {
          const base = document.documentElement || document.body; if (!base) return;
          const tw = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT); let n = tw.currentNode, seen = 0;
          while ((n = tw.nextNode()) && seen < 2500) { seen++; const sr = n.shadowRoot; if (sr) { try { document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: sr })); } catch (_) {} } }
        } catch (_) {}
      });
    }
    installShadowRootEmitter();

    const PERF_POLICY = Object.freeze({ registry: { shadowLRUMax: 24, spaRescanDebounceMs: 220 } });
    const RUNTIME_GUARD = Object.freeze({ webgl: { failCooldownMs: 5000, failThreshold: 3 }, audio: { createSourceCooldownMs: 5000 } });
    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1, log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

    function createVideoState() { return { visible: false, rect: null, ir: 0, rectT: 0, rectEpoch: -1, bound: false, applied: false, fxBackend: null, lastFilterUrl: null, rateState: null, desiredRate: undefined, audioFailUntil: 0, webglFailCount: 0, webglDisabledUntil: 0, webglTainted: false }; }
    const videoStateMap = new WeakMap(); function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = createVideoState(); videoStateMap.set(v, st); } return st; }

    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({ has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; }, toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); } });
    const PRESETS = Object.freeze({ detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 14, sharp2Add: 2, clarityAdd: 4 }, M: { sharpAdd: 16, sharp2Add: 10, clarityAdd: 10 }, L: { sharpAdd: 14, sharp2Add: 26, clarityAdd: 12}, XL: { sharpAdd: 18, sharp2Add: 16, clarityAdd: 24 } }, grade: { brOFF: { gammaF: 1.00, brightAdd: 0 }, S: { gammaF: 1.02, brightAdd: 1.8 }, M: { gammaF: 1.07, brightAdd: 4.4 }, L: { gammaF: 1.15, brightAdd: 9 }, DS: { gammaF: 1.05, brightAdd: 3.6 }, DM: { gammaF: 1.10, brightAdd: 7.2 }, DL: { gammaF: 1.20, brightAdd: 10.8 } } });
    const DEFAULTS = { video: { presetS: 'off', presetB: 'brOFF', shadowBandMask: 0, brightStepLevel: 0 }, audio: { enabled: false, boost: 6, multiband: true, lufs: true, dialogue: false }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: false, renderMode: 'svg', zoomEn: false, autoScene: false, advanced: false } };
    const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_RENDER_MODE: 'app.renderMode', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel', A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });
    const APP_SCHEMA = [ { type: 'enum', path: P.APP_RENDER_MODE, values: ['svg', 'webgl'], fallback: () => 'svg' }, { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV } ];
    const VIDEO_SCHEMA = [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 }, { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 } ];
    const AUDIO_PLAYBACK_SCHEMA = [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => DEFAULTS.audio.boost }, { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ];

    const TOUCHED = { videos: new Set(), rateVideos: new Set() };
    function touchedAddLimited(set, el, onEvict) { if (!el) return; if (set.has(el)) { set.delete(el); set.add(el); return; } set.add(el); if (set.size <= CONFIG.TOUCHED_MAX) return; const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25); let dropped = 0; for (const v of set) { if (dropped >= dropN) break; set.delete(v); try { onEvict?.(v); } catch (_) {} dropped++; } }

    let __vscRectEpoch = 0, __vscRectEpochQueued = false;
    function bumpRectEpoch() { if (__vscRectEpochQueued) return; __vscRectEpochQueued = true; requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; }); }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true }); onWin('resize', bumpRectEpoch, { passive: true }); onWin('orientationchange', bumpRectEpoch, { passive: true });
    try { const vv = window.visualViewport; if (vv) { vv.addEventListener('resize', bumpRectEpoch, { passive: true, signal: __globalSig }); vv.addEventListener('scroll', bumpRectEpoch, { passive: true, signal: __globalSig }); } } catch (_) {}

    function getRectCached(v, now, maxAgeMs = 800) { const st = getVState(v), t0 = st.rectT || 0; let r = st.rect; const epoch = st.rectEpoch || 0; if (!r || (now - t0) > maxAgeMs || epoch !== __vscRectEpoch) { r = v.getBoundingClientRect(); st.rect = r; st.rectT = now; st.rectEpoch = __vscRectEpoch; } return r; }
    function getViewportSnapshot() { const vv = window.visualViewport; if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }
    const __vscElemIds = new WeakMap(); let __vscElemIdSeq = 1; function getElemId(el) { if (!el) return 0; let id = __vscElemIds.get(el); if (!id) { id = __vscElemIdSeq++; __vscElemIds.set(el, id); } return id; }

    function* walkRoots(rootBase) { if (!rootBase) return; const stack = [rootBase]; while (stack.length > 0) { const r = stack.pop(); yield r; const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT); let node = walker.nextNode(); while (node) { if (node.shadowRoot) stack.push(node.shadowRoot); node = walker.nextNode(); } } }
    function createDebounced(fn, ms = 250) { let t = 0; const debounced = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; debounced.cancel = () => clearTimeout(t); return debounced; }

    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return; window.__VSC_SPA_PATCHED__ = true; let lastHref = location.href;
      const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); }, wrap = (name) => { const orig = history[name]; if (typeof orig !== 'function') return; history[name] = function (...args) { const ret = Reflect.apply(orig, this, args); queueMicrotask(emitIfChanged); return ret; }; };
      wrap('pushState'); wrap('replaceState'); onWin('popstate', emitIfChanged, { passive: true });
    }

    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    function watchIframes() {
      const inject = (ifr) => {
        if (!ifr) return;
        const tryInject = () => { try { const win = ifr.contentWindow, doc = ifr.contentDocument || win?.document; if (!win || !doc || win.__VSC_BOOT_LOCK__) return; const host = doc.head || doc.documentElement; if (!host) return; const s = doc.createElement('script'); s.textContent = __VSC_INJECT_SOURCE; host.appendChild(s); s.remove?.(); } catch (_) {} };
        tryInject(); if (!ifr.__vscLoadHooked) { ifr.__vscLoadHooked = true; ifr.addEventListener('load', tryInject, { passive: true }); }
      };
      document.querySelectorAll("iframe").forEach(inject);
      const mo = new MutationObserver((muts) => { for (const m of muts) if (m.addedNodes) m.addedNodes.forEach(n => { if (n.tagName === 'IFRAME') inject(n); else if (n.nodeType === 1 && n.querySelector?.('iframe')) { for (const ifr of n.getElementsByTagName('iframe')) inject(ifr); } }); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    function onFsChange() { try { window.__VSC_UI_Ensure?.(); window.__VSC_INTERNAL__?.ApplyReq?.hard?.(); } catch (_) {} }
    onDoc('fullscreenchange', onFsChange);

    function findWebkitPiPVideo() { const rootBase = document.documentElement || document.body || document; for (const root of walkRoots(rootBase)) { const vids = root.querySelectorAll?.('video'); if (!vids) continue; for (const v of vids) { try { if (typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture') return v; } catch (_) {} } } return null; }

    let __vscPiPCacheT = 0, __vscPiPCacheRef = null, __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
    function getActivePiPVideoSlow() { if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement; if (__activeDocumentPiPWindow && __activeDocumentPiPVideo) return __activeDocumentPiPVideo; try { if (typeof HTMLVideoElement !== 'undefined' && ('webkitPresentationMode' in HTMLVideoElement.prototype)) return findWebkitPiPVideo(); } catch (_) {} return null; }
    function getActivePiPVideo() { const now = performance.now(); if ((now - __vscPiPCacheT) < 200 && __vscPiPCacheRef) { const v = __vscPiPCacheRef.deref(); if (v) return v; } __vscPiPCacheT = now; const v = getActivePiPVideoSlow(); __vscPiPCacheRef = v ? new WeakRef(v) : null; return v; }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

    async function enterDocumentPiP(video) {
        const pipWindow = await window.documentPictureInPicture.requestWindow({ width: Math.max(video.videoWidth / 2, 400), height: Math.max(video.videoHeight / 2, 225) });
        __activeDocumentPiPWindow = pipWindow; __activeDocumentPiPVideo = video; __pipOrigParent = video.parentNode; __pipOrigNext = video.nextSibling; __pipOrigCss = video.style.cssText;
        __pipPlaceholder = document.createElement('div'); Object.assign(__pipPlaceholder.style, { width: video.clientWidth + 'px', height: video.clientHeight + 'px', background: 'black' }); __pipOrigParent?.insertBefore(__pipPlaceholder, video);
        Object.assign(pipWindow.document.body.style, { margin: '0', display: 'flex', justifyContent: 'center', alignItems: 'center', background: 'black' }); Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain' });
        pipWindow.document.body.append(video); pipWindow.addEventListener('click', () => { video.paused ? video.play()?.catch?.(() => {}) : video.pause(); }); pipWindow.addEventListener('pagehide', () => restoreFromDocumentPiP(video));
        return true;
    }
    function restoreFromDocumentPiP(video) {
      try {
        video.style.cssText = __pipOrigCss;
        if (__pipPlaceholder?.parentNode?.isConnected) {
          __pipPlaceholder.parentNode.insertBefore(video, __pipPlaceholder); __pipPlaceholder.remove();
        } else if (__pipOrigParent?.isConnected) {
          __pipOrigParent.appendChild(video);
        } else {
          (document.body || document.documentElement).appendChild(video);
        }
      } finally { resetPiPState(); }
    }

    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      if (window.documentPictureInPicture?.requestWindow) { if (__activeDocumentPiPWindow) return true; try { return await enterDocumentPiP(video); } catch (e) { log.debug('Document PiP failed', e); } }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) { try { await video.requestPictureInPicture(); return true; } catch (_) {} }
      if (video.webkitSupportsPresentationMode?.('picture-in-picture')) { try { video.webkitSetPresentationMode('picture-in-picture'); return true; } catch (_) {} }
      return false;
    }
    const exitWebkitPiP = (v) => { try { if (v?.webkitPresentationMode === 'picture-in-picture') { v.webkitSetPresentationMode('inline'); return true; } } catch (_) {} return false; }
    async function exitPiP(preferredVideo = null) {
      if (__activeDocumentPiPWindow) { __activeDocumentPiPWindow.close(); return true; }
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); return true; } catch (_) {} }
      const candidates = []; if (preferredVideo) candidates.push(preferredVideo); const wk = findWebkitPiPVideo(); if (wk) candidates.push(wk);
      for (const v of candidates) { if (exitWebkitPiP(v)) return true; } return false;
    }
    async function togglePiPFor(video) {
      if (!video || video.readyState < 2) return false;
      if (__activeDocumentPiPWindow || document.pictureInPictureElement === video) return exitPiP(video);
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} } return enterPiP(video);
    }

    function createZoomManager() {
      const stateMap = new WeakMap(); let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0, pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '', origComputedPosition: '' }; stateMap.set(v, st); } return st; };
      const update = (v) => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = null; const st = getSt(v); v.style.transition = isPanning || pinchState.active ? 'none' : 'transform 0.1s ease-out';
          if (st.scale <= 1) { st.scale = 1; st.tx = 0; st.ty = 0; v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = ''; if (st.zoomed) { v.style.zIndex = st.origZIndex; v.style.position = st.origPosition; st.zoomed = false; st.origComputedPosition = ''; } }
          else { if (!st.zoomed) { st.origZIndex = v.style.zIndex; st.origPosition = v.style.position; st.origComputedPosition = ''; try { st.origComputedPosition = window.getComputedStyle(v).position; } catch (_) {} st.zoomed = true; if (st.origComputedPosition === 'static') v.style.position = 'relative'; } v.style.transformOrigin = '0 0'; v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`; v.style.cursor = isPanning ? 'grabbing' : 'grab'; v.style.zIndex = '2147483646'; }
        });
      };
      const zoomTo = (v, newScale, clientX, clientY) => { const st = getSt(v), rect = v.getBoundingClientRect(), ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale; st.tx = clientX - (rect.left - st.tx) - ix * newScale; st.ty = clientY - (rect.top - st.ty) - iy * newScale; st.scale = newScale; update(v); };
      const resetZoom = (v) => { if (v) { const st = getSt(v); st.scale = 1; update(v); } }, isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; }, isZoomEnabled = () => !!window.__VSC_INTERNAL__?.Store?.get(P.APP_ZOOM_EN), getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
      function getTargetVideo(e) { const path = typeof e.composedPath === 'function' ? e.composedPath() : null; if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } } const cx = Number.isFinite(e.clientX) ? e.clientX : (e.touches && Number.isFinite(e.touches[0]?.clientX) ? e.touches[0].clientX : innerWidth * 0.5), cy = Number.isFinite(e.clientY) ? e.clientY : (e.touches && Number.isFinite(e.touches[0]?.clientY) ? e.touches[0].clientY : innerHeight * 0.5), el = document.elementFromPoint(cx, cy); let v = el?.tagName === 'VIDEO' ? el : el?.closest?.('video') || null; if (!v && window.__VSC_INTERNAL__?.App) { v = window.__VSC_INTERNAL__.App.getActiveVideo(); } return v; }
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
      let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now(), vp = getViewportSnapshot(); let best = null, bestScore = -Infinity;
        const evalScore = (v) => {
          if (!v || v.readyState < 2) return; const r = getRectCached(v, now, 800), area = r.width * r.height, pip = isPiPActiveVideo(v);
          if (area < 160 * 120 && !pip) return; const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
          if (!v.paused && !v.ended) s += 6.0; if (v.currentTime > 0.2) s += 2.0; s += Math.log2(1 + area / 20000) * 1.1;
          const ptAge = Math.max(0, now - (lastUserPt.t || 0)), userBias = Math.exp(-ptAge / 1800), dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
          s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500); const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);
          if (v.muted || v.volume < 0.01) s -= 1.5;
          if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
          if (!v.controls && !v.closest('[class*=player]')) s -= 1.0;
          if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2); if (pip) s += 3.0;
          if (s > bestScore) { bestScore = s; best = v; }
        };
        for (const v of videos) evalScore(v); const activePip = getActivePiPVideo(); if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);
        if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) { if (best && stickyTarget !== best && (bestScore < stickyScore + 0.8)) return { target: stickyTarget }; }
        stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 650; return { target: best };
      }
      return Object.freeze({ pickFastActiveOnly });
    }

    function createUtils() {
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
          for (const [k, v] of Object.entries(props)) {
            if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
            else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
            else if (k === 'class') el.className = v;
            else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
          }
          children.flat().forEach(c => { if (c != null) el.append(c); });
          return el;
        },
        deepClone: (x) => {
          const r = {};
          for (const [k, v] of Object.entries(x)) r[k] = (typeof v === 'object' && v !== null) ? { ...v } : v;
          return r;
        },
        createLRU: (max = 384) => {
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
      function clearPending() { if (timer) { clearTimeout(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      function queueRaf() { if (rafId) return; rafId = requestAnimationFrame(run); }
      function timerCb() { timer = 0; queueRaf(); }
      function run() {
        rafId = 0; queued = false; const now = performance.now(), doForce = force; force = false; const dt = now - lastRun;
        if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; }
        lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} }
      }
      const request = (immediate = false) => { if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; } if (queued) return; queued = true; clearPending(); queueRaf(); };
      return { registerApply: (fn) => { applyFn = fn; }, request };
    }

    function createLocalStore(defaults, scheduler, Utils) {
      let rev = 0; const listeners = new Map();
      const broadcastState = (() => {
        let pending = null, scheduled = false;
        const flush = () => {
          scheduled = false; if (!pending) return; const entries = pending; pending = null; const msg = { __vsc_sync: true, token: VSC_SYNC_TOKEN, batch: entries };
          try { const isTop = (window.self === window.top); if (!isTop) window.top.postMessage(msg, '*'); } catch (_) {}
          const iframes = document.getElementsByTagName('iframe'); for (let i = 0; i < iframes.length; i++) { try { iframes[i].contentWindow.postMessage(msg, '*'); } catch (_) {} }
        };
        return (key, val) => { if (key === P.APP_UI) return; if (!pending) pending = []; pending.push({ p: key, val }); if (!scheduled) { scheduled = true; queueMicrotask(flush); } };
      })();
      let emitDepth = 0;
      const emit = (key, val) => {
        if (emitDepth > 3) { log.warn('emit recursion limit'); return; }
        emitDepth++;
        try {
          const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch (_) {} }
          const dot = key.indexOf('.'); if (dot > 0) { const catStar = key.slice(0, dot) + '.*'; const b = listeners.get(catStar); if (b) for (const cb of b) { try { cb(val); } catch (_) {} } }
          broadcastState(key, val);
        } finally { emitDepth--; }
      };
      const state = Utils.deepClone(defaults); const proxyCache = {}; let batchDepth = 0, batchChanged = false; const batchEmits = new Map();
      const pathCache = Object.create(null);
      const parsePath = (p) => { if (pathCache[p]) return pathCache[p]; const dot = p.indexOf('.'); pathCache[p] = dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; return pathCache[p]; };
      function invalidateProxyBranch(path) {
        if (!path) return;
        const prefix = path + '.';
        for (const key of Object.keys(proxyCache)) { if (key === path || key.startsWith(prefix)) delete proxyCache[key]; }
      }
      function flushBatch() { if (!batchChanged) return; rev++; for (const [key, val] of batchEmits) { emit(key, val); } batchEmits.clear(); batchChanged = false; scheduler.request(false); }
      function notifyChange(fullPath, val) { if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; } rev++; emit(fullPath, val); scheduler.request(false); }
      function createProxyDeep(obj, pathPrefix) {
        return new Proxy(obj, {
          get(target, prop) {
            const value = target[prop];
            if (typeof value === 'object' && value !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(value, cacheKey); return proxyCache[cacheKey]; }
            return value;
          },
          set(target, prop, val) {
            if (Object.is(target[prop], val)) return true;
            const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop);
            if ((typeof target[prop] === 'object' && target[prop] !== null) || (typeof val === 'object' && val !== null)) { invalidateProxyBranch(fullPath); }
            target[prop] = val; notifyChange(fullPath, val); return true;
          }
        });
      }
      const proxyState = createProxyDeep(state, '');
      return {
        state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat],
        get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; },
        set: (p, val) => { const [c, k] = parsePath(p); if (k == null) { proxyState[c] = val; return; } proxyState[c][k] = val; },
        batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } finally { batchDepth--; if (batchDepth === 0) flushBatch(); } },
        sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); }
      };
    }

    function normalizeBySchema(sm, schema) {
      let changed = false; const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
      for (const { type, path, values, fallback, min, max, round } of schema) {
        switch (type) {
          case 'bool': set(path, !!sm.get(path)); break;
          case 'enum': { const cur = sm.get(path); if (!values.includes(cur)) set(path, fallback()); break; }
          case 'num': { let n = Number(sm.get(path)); if (!Number.isFinite(n)) n = fallback(); if (round) n = Math.round(n); set(path, Math.max(min, Math.min(max, n))); break; }
        }
      }
      return changed;
    }

    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
      const shadowRootsLRU = []; const SHADOW_LRU_MAX = 24; const observedShadowHosts = new WeakSet();
      let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }
      const ioMargin = `${Math.min(500, Math.round((window.innerHeight || 1080) * 0.4))}px`;
      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
        let changed = false; const now = performance.now();
        for (const e of entries) {
          const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el);
          st.visible = isVis; st.ir = e.intersectionRatio || 0; st.rect = e.boundingClientRect; st.rectT = now; st.rectEpoch = __vscRectEpoch;
          if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
          else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
        }
        if (changed) { rev++; requestRefreshCoalesced(); }
      }, { root: null, threshold: 0.01, rootMargin: ioMargin }) : null;
      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
      const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
        let changed = false; const now = performance.now();
        for (const e of entries) {
          const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el);
          if (e.contentBoxSize?.[0]) { const s = e.contentBoxSize[0]; st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize }; }
          else { st.rect = e.contentRect ? el.getBoundingClientRect() : null; }
          st.rectT = now; st.rectEpoch = -1; dirty.videos.add(el); changed = true;
        }
        if (changed) requestRefreshCoalesced();
      }) : null;
      const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; videos.add(el); if (io) io.observe(el); else { const st = getVState(el); st.visible = true; if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } } if (ro) try { ro.observe(el); } catch (_) {} };
      const WorkQ = (() => {
        let qA = [], qB = [], active = qA, pending = qB, scheduled = false, epochV = 1;
        const mark = new WeakMap(), isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling);
        function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); }
        const schedule = () => {
          if (scheduled) return; scheduled = true;
          if (globalThis.scheduler?.postTask) globalThis.scheduler.postTask(() => drain(null), { priority: 'background' }).catch(() => requestAnimationFrame(drainRunnerRaf));
          else if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 });
          else requestAnimationFrame(drainRunnerRaf);
        };
        const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epochV) return; mark.set(n, epochV); pending.push(n); schedule(); };
        const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} } };
        const drain = (dl) => { scheduled = false; [active, pending] = [pending, active]; pending.length = 0; const start = performance.now(), budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6, shouldYieldForInput = () => { try { return !!isInputPending?.({ includeContinuous: true }); } catch (_) { return false; } }; for (let i = 0; i < active.length; i++) { if (!budget() || shouldYieldForInput()) { for (let j = i; j < active.length; j++) pending.push(active[j]); active.length = 0; schedule(); return; } scanNode(active[i]); } active.length = 0; epochV++; };
        return Object.freeze({ enqueue });
      })();
      function nodeMayContainVideo(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') return true; if ((n.childElementCount || 0) === 0) return false; try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } } } try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; } }
      const observers = new Set();
      const connectObserver = (root) => {
        if (!root) return;
        const mo = new MutationObserver((muts) => {
          let touchedVideoTree = false;
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); if (!touchedVideoTree && nodeMayContainVideo(n)) touchedVideoTree = true; }
            }
            if (m.removedNodes && m.removedNodes.length) {
              for (const n of m.removedNodes) {
                if (!n || n.nodeType !== 1) continue;
                if (n.tagName === 'VIDEO') {
                  if (videos.has(n)) { videos.delete(n); visible.videos.delete(n); try { io?.unobserve(n); ro?.unobserve(n); } catch (_) {} dirty.videos.add(n); }
                  touchedVideoTree = true; break;
                }
                if ((n.childElementCount || 0) > 0) { try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {} }
              }
            }
          }
          if (touchedVideoTree) requestRefreshCoalesced();
        });
        mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root);
      };
      const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
      document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail, host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} });
      refreshObservers();
      function pruneDisconnected(set, visibleSet, dirtySet, unobserveFn) { let removed = 0; for (const el of set) { if (!el?.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} try { ro?.unobserve(el); } catch (_) {} removed++; } } return removed; }
      return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneDisconnected(videos, visible.videos, dirty.videos, (el) => { if (io) io.unobserve(el); }); if (removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { try { const base = document.documentElement || document.body; if (!base) return; for (const r of walkRoots(base)) WorkQ.enqueue(r); } catch (_) {} } };
    }

    const SOFT_CLIP_CURVE = (() => { const n = 8192, knee = 0.92, drive = 4.0, tanhD = Math.tanh(drive), curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x); curve[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh(drive * (ax - knee) / Math.max(1e-6, 1 - knee)) / tanhD); } return curve; })();

    function createAudio(sm) {
      let ctx, target = null, currentSrc = null, inputGain, dryGain, wetGain, masterOut, wetInGain, limiter, clipper, hpf, analyser, dataArray, srcMap = new WeakMap(), makeupDbEma = 0, switchTimer = 0, switchTok = 0, gestureHooked = false, loopTok = 0, audioLoopTimerId = 0, currentNodes = null;
      const VSC_AUD_HPF_Q = 0.707, clamp = VSC_CLAMP;
      const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') await ctx.resume(); if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
      const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; onWin('pointerdown', onGesture, { passive: true, capture: true }); onWin('keydown', onGesture, { passive: true, capture: true }); };

      function createDynamicCinemaEQ(actx) {
        const createBand = (type, freq, Q) => { const filter = actx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = Q; filter.gain.value = 0; return { filter, freq, type }; };
        const bands = { sub: createBand('lowshelf', 80, 0.8), impact: createBand('peaking', 55, 1.2), cut: createBand('peaking', 300, 0.8), voice: createBand('peaking', 3200, 1.2), air: createBand('highshelf', 10000, 0.7) };
        const input = actx.createGain(), output = actx.createGain(), chain = [bands.sub, bands.impact, bands.cut, bands.voice, bands.air];
        input.connect(chain[0].filter); for (let i = 0; i < chain.length - 1; i++) chain[i].filter.connect(chain[i + 1].filter); chain[chain.length - 1].filter.connect(output);
        const PROFILES = { cinema: { sub: 3.0, impact: 2.0, cut: -2.0, voice: 2.0, air: -0.5 }, cinemaWithMultiband: { sub: 1.5, impact: 1.0, cut: -2.0, voice: 1.5, air: -0.5 }, neutral: { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 } };
        let activeProfile = 'cinema', dialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 };
        const applyGains = () => {
          const profile = PROFILES[activeProfile] || PROFILES.neutral, t = actx.currentTime;
          for (const [name, band] of Object.entries(bands)) { const finalGain = VSC_CLAMP((profile[name] || 0) + (dialogueOffset[name] || 0), -12, 12); try { band.filter.gain.setTargetAtTime(finalGain, t, 0.08); } catch (_) { band.filter.gain.value = finalGain; } }
        };
        return { input, output, bands, setProfile: (name) => { activeProfile = name; applyGains(); }, setDialogueState: (isDialogue, ratio) => { if (isDialogue && ratio > 0.5) { const str = VSC_CLAMP((ratio - 0.5) * 2, 0, 1); dialogueOffset = { sub: -1.0 * str, impact: -0.5 * str, cut: -1.0 * str, voice: 1.5 * str, air: 0.8 * str }; } else { dialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }; } applyGains(); } };
      }

      function buildMultibandDynamics(actx) {
        const CROSSOVER_LOW = 150, CROSSOVER_HIGH = 3500;
        const createLR4 = (freq, type) => { const f1 = actx.createBiquadFilter(), f2 = actx.createBiquadFilter(); f1.type = type; f2.type = type; f1.frequency.value = freq; f2.frequency.value = freq; f1.Q.value = 0.707; f2.Q.value = 0.707; f1.connect(f2); return { input: f1, output: f2 }; };
        const input = actx.createGain(), lpLow = createLR4(CROSSOVER_LOW, 'lowpass'), hpLow = createLR4(CROSSOVER_LOW, 'highpass'), lpMid = createLR4(CROSSOVER_HIGH, 'lowpass'), hpHigh = createLR4(CROSSOVER_HIGH, 'highpass');
        input.connect(lpLow.input); input.connect(hpLow.input); hpLow.output.connect(lpMid.input); hpLow.output.connect(hpHigh.input);
        const compLow = actx.createDynamicsCompressor(); compLow.threshold.value = -20; compLow.knee.value = 8; compLow.ratio.value = 3.0; compLow.attack.value = 0.012; compLow.release.value = 0.40;
        const compMid = actx.createDynamicsCompressor(); compMid.threshold.value = -14; compMid.knee.value = 10; compMid.ratio.value = 2.5; compMid.attack.value = 0.006; compMid.release.value = 0.18;
        const compHigh = actx.createDynamicsCompressor(); compHigh.threshold.value = -12; compHigh.knee.value = 6; compHigh.ratio.value = 2.0; compHigh.attack.value = 0.003; compHigh.release.value = 0.12;
        const gainLow = actx.createGain(), gainMid = actx.createGain(), gainHigh = actx.createGain();
        lpLow.output.connect(compLow); compLow.connect(gainLow); lpMid.output.connect(compMid); compMid.connect(gainMid); hpHigh.output.connect(compHigh); compHigh.connect(gainHigh);
        const output = actx.createGain(); gainLow.connect(output); gainMid.connect(output); gainHigh.connect(output);
        return { input, output, bands: { low: { comp: compLow, gain: gainLow }, mid: { comp: compMid, gain: gainMid }, high: { comp: compHigh, gain: gainHigh } } };
      }

      function createLUFSMeter(actx) {
        const preFilter = actx.createBiquadFilter(); preFilter.type = 'highshelf'; preFilter.frequency.value = 1681; preFilter.gain.value = 4.0;
        const rlbFilter = actx.createBiquadFilter(); rlbFilter.type = 'highpass'; rlbFilter.frequency.value = 38; rlbFilter.Q.value = 0.5;
        preFilter.connect(rlbFilter); const meterAnalyser = actx.createAnalyser(); meterAnalyser.fftSize = 2048; meterAnalyser.smoothingTimeConstant = 0; rlbFilter.connect(meterAnalyser);
        const buffer = new Float32Array(meterAnalyser.fftSize), state = { momentaryBuf: new Float64Array(20), momentaryIdx: 0, momentaryFull: false, shortTermBuf: new Float64Array(150), shortTermIdx: 0, shortTermFull: false, integratedSum: 0, integratedCount: 0, momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };
        function measure() {
          meterAnalyser.getFloatTimeDomainData(buffer); let sumSq = 0; for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i]; const meanSq = sumSq / buffer.length;
          state.momentaryBuf[state.momentaryIdx] = meanSq; state.momentaryIdx = (state.momentaryIdx + 1) % state.momentaryBuf.length; if (state.momentaryIdx === 0) state.momentaryFull = true;
          const mCount = state.momentaryFull ? state.momentaryBuf.length : state.momentaryIdx; if (mCount > 0) { let mSum = 0; for (let i = 0; i < mCount; i++) mSum += state.momentaryBuf[i]; const mMean = mSum / mCount; state.momentaryLUFS = mMean > 1e-10 ? -0.691 + 10 * Math.log10(mMean) : -70; }
          state.shortTermBuf[state.shortTermIdx] = meanSq; state.shortTermIdx = (state.shortTermIdx + 1) % state.shortTermBuf.length; if (state.shortTermIdx === 0) state.shortTermFull = true;
          const sCount = state.shortTermFull ? state.shortTermBuf.length : state.shortTermIdx; if (sCount > 0) { let sSum = 0; for (let i = 0; i < sCount; i++) sSum += state.shortTermBuf[i]; const sMean = sSum / sCount; state.shortTermLUFS = sMean > 1e-10 ? -0.691 + 10 * Math.log10(sMean) : -70; }
          if (state.momentaryLUFS > -70 && state.momentaryLUFS > state.integratedLUFS - 10) { state.integratedSum += meanSq; state.integratedCount++; const intMean = state.integratedSum / state.integratedCount; state.integratedLUFS = intMean > 1e-10 ? -0.691 + 10 * Math.log10(intMean) : -70; }
        }
        return { input: preFilter, measure, reset: () => { state.momentaryBuf.fill(0); state.shortTermBuf.fill(0); state.momentaryIdx = 0; state.shortTermIdx = 0; state.momentaryFull = false; state.shortTermFull = false; state.integratedSum = 0; state.integratedCount = 0; state.momentaryLUFS = -70; state.shortTermLUFS = -70; state.integratedLUFS = -70; }, getState: () => state };
      }

      function createLoudnessNormalizer(actx, lufsMeter) {
        const TARGET_LUFS = -14, MAX_GAIN_DB = 9, MIN_GAIN_DB = -6, SMOOTHING = 0.03, SETTLE_FRAMES = 75;
        const gainNode = actx.createGain(); gainNode.gain.value = 1.0; let frameCount = 0, currentGainDb = 0;
        function update() {
          const lufs = lufsMeter.getState(); frameCount++; if (frameCount < SETTLE_FRAMES) return;
          const measured = lufs.shortTermLUFS; if (measured <= -60) return;
          const targetGainDb = VSC_CLAMP(TARGET_LUFS - measured, MIN_GAIN_DB, MAX_GAIN_DB); currentGainDb += (targetGainDb - currentGainDb) * 0.08; const linearGain = Math.pow(10, currentGainDb / 20);
          try { gainNode.gain.setTargetAtTime(linearGain, actx.currentTime, SMOOTHING); } catch (_) { gainNode.gain.value = linearGain; }
        }
        return { node: gainNode, update, reset: () => { frameCount = 0; currentGainDb = 0; gainNode.gain.value = 1.0; lufsMeter.reset(); } };
      }

      function createDialogueDetector(actx, analyserNode) {
        const FFT_SIZE = 2048, sr = actx.sampleRate, binHz = sr / FFT_SIZE, DIALOGUE_LOW_BIN = Math.round(300 / binHz), DIALOGUE_HIGH_BIN = Math.round(3500 / binHz), MUSIC_LOW_BIN = Math.round(40 / binHz), MUSIC_HIGH_BIN = Math.round(250 / binHz), freqD = new Uint8Array(FFT_SIZE / 2);
        const state = { dialogueRatio: 0, isDialogue: false, confidence: 0, _ema: 0, _histCount: 0, _histDialogue: 0 };
        function detect() {
          analyserNode.getByteFrequencyData(freqD); let dialogueEnergy = 0, musicEnergy = 0, totalEnergy = 0;
          for (let i = MUSIC_LOW_BIN; i <= MUSIC_HIGH_BIN; i++) musicEnergy += freqD[i] * freqD[i];
          for (let i = DIALOGUE_LOW_BIN; i <= DIALOGUE_HIGH_BIN; i++) dialogueEnergy += freqD[i] * freqD[i];
          for (let i = 1; i < freqD.length; i++) totalEnergy += freqD[i] * freqD[i];
          if (totalEnergy < 100) { state.dialogueRatio *= 0.95; state.isDialogue = false; return state; }
          const rawRatio = dialogueEnergy / Math.max(1, totalEnergy), dialogueVsMusic = dialogueEnergy / Math.max(1, musicEnergy);
          let logSum = 0, linSum = 0, count = 0;
          for (let i = DIALOGUE_LOW_BIN; i <= DIALOGUE_HIGH_BIN; i++) { const val = Math.max(1e-6, freqD[i]); logSum += Math.log(val); linSum += val; count++; }
          const geoMean = Math.exp(logSum / count), ariMean = linSum / count, specFlatness = geoMean / Math.max(1e-6, ariMean);
          let score = 0; if (rawRatio > 0.35) score += 0.4; if (dialogueVsMusic > 2.0) score += 0.3; if (specFlatness < 0.60) score += 0.3;
          state._ema = state._ema * 0.85 + score * 0.15; state.dialogueRatio = state._ema; state.isDialogue = state._ema > 0.45; state._histCount++; if (state.isDialogue) state._histDialogue++; state.confidence = state._histCount > 50 ? state._histDialogue / state._histCount : 0; return state;
        }
        return { detect, reset: () => { state.dialogueRatio = 0; state.isDialogue = false; state.confidence = 0; state._ema = 0; state._histCount = 0; state._histDialogue = 0; }, getState: () => state };
      }

      function buildAudioGraph(audioCtx) {
        const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), wetInGain: audioCtx.createGain(), hpf: audioCtx.createBiquadFilter(), limiter: audioCtx.createDynamicsCompressor(), clipper: audioCtx.createWaveShaper(), analyser: audioCtx.createAnalyser() };
        n.hpf.type = 'highpass'; n.hpf.frequency.value = 20; n.hpf.Q.value = VSC_AUD_HPF_Q;
        n.limiter.threshold.value = -1.2; n.limiter.knee.value = 0.0; n.limiter.ratio.value = 20.0; n.limiter.attack.value = 0.0015; n.limiter.release.value = 0.09;
        n.clipper.curve = SOFT_CLIP_CURVE; try { n.clipper.oversample = '4x'; } catch (_) {} n.analyser.fftSize = 2048;
        const dynamicEQ = createDynamicCinemaEQ(audioCtx), multiband = buildMultibandDynamics(audioCtx), lufsMeter = createLUFSMeter(audioCtx), loudnessNorm = createLoudnessNormalizer(audioCtx, lufsMeter), dialogueDetector = createDialogueDetector(audioCtx, n.analyser);
        n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
        n.inputGain.connect(dynamicEQ.input); dynamicEQ.output.connect(n.hpf);
        n.hpf.connect(n.analyser); n.hpf.connect(lufsMeter.input); n.hpf.connect(multiband.input);
        multiband.output.connect(loudnessNorm.node); loudnessNorm.node.connect(n.wetInGain); n.wetInGain.connect(n.limiter); n.limiter.connect(n.clipper); n.clipper.connect(n.wetGain); n.wetGain.connect(n.masterOut);
        n.masterOut.connect(audioCtx.destination);
        n._dynamicEQ = dynamicEQ; n._multiband = multiband; n._lufsMeter = lufsMeter; n._loudnessNorm = loudnessNorm; n._dialogueDetector = dialogueDetector;
        return n;
      }

      const ensureCtx = () => {
        if (ctx && ctx.state !== 'closed') return true; if (ctx) { ctx = null; srcMap = new WeakMap(); } const AC = window.AudioContext; if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { try { ctx = new AC(); } catch (__) { return false; } } currentSrc = null; target = null; ensureGestureResumeHook();
        const nodes = buildAudioGraph(ctx);
        inputGain = nodes.inputGain; dryGain = nodes.dryGain; wetGain = nodes.wetGain; masterOut = nodes.masterOut; wetInGain = nodes.wetInGain; limiter = nodes.limiter; clipper = nodes.clipper; hpf = nodes.hpf; analyser = nodes.analyser; currentNodes = nodes; dataArray = new Float32Array(analyser.fftSize); return true;
      };

      const rampGainsSafe = (node, targetVal, tc = 0.015) => { if (!ctx || !node) return; const t = ctx.currentTime; try { node.gain.cancelScheduledValues(t); node.gain.setTargetAtTime(targetVal, t, tc); } catch (_) { node.gain.value = targetVal; } };
      const fadeOutThen = (fn) => { if (!ctx) { fn(); return; } const tok = ++switchTok; clearTimeout(switchTimer); const t = ctx.currentTime; try { masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + 0.04); } catch (_) { masterOut.gain.value = 0; } switchTimer = setTimeout(() => { if (tok !== switchTok) return; makeupDbEma = 0; try { fn(); } catch (_) {} if (ctx) { const t2 = ctx.currentTime; try { masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04); } catch (_) { masterOut.gain.value = 1; } } }, 60); };
      const disconnectAll = () => { if (currentSrc) try { currentSrc.disconnect(); } catch (_) {} currentSrc = null; target = null; };

      function runAudioLoop(tok) {
        audioLoopTimerId = 0; if (tok !== loopTok || !ctx) return;
        const dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); if (!dynAct) return;
        const actuallyEnabled = dynAct && currentSrc;
        if (analyser && currentSrc && currentNodes) {
          analyser.getFloatTimeDomainData(dataArray); let sumSquare = 0; for (let i = 0; i < dataArray.length; i++) sumSquare += dataArray[i] * dataArray[i];
          const rms = Math.sqrt(sumSquare / dataArray.length), db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
          const mbActive = !!sm.get(P.A_MULTIBAND);
          if (currentNodes._dynamicEQ) currentNodes._dynamicEQ.setProfile(mbActive ? 'cinemaWithMultiband' : 'cinema');
          if (currentNodes._dialogueDetector && actuallyEnabled) {
            const dState = currentNodes._dialogueDetector.detect(); const t = ctx.currentTime;
            if (currentNodes._dynamicEQ) currentNodes._dynamicEQ.setDialogueState(dState.isDialogue, dState.dialogueRatio);
            if (currentNodes._multiband && !!sm.get(P.A_DIALOGUE)) {
              const mb = currentNodes._multiband.bands;
              if (dState.isDialogue && dState.dialogueRatio > 0.5) {
                const boost = clamp((dState.dialogueRatio - 0.5) * 2 * 1.5, 0, 2.0);
                try { mb.mid.gain.gain.setTargetAtTime(1.0 + boost * 0.15, t, 0.08); mb.low.gain.gain.setTargetAtTime(1.0 - boost * 0.08, t, 0.08); mb.high.gain.gain.setTargetAtTime(1.0 + boost * 0.05, t, 0.08); } catch (_) {}
              } else { try { mb.mid.gain.gain.setTargetAtTime(1.0, t, 0.15); mb.low.gain.gain.setTargetAtTime(1.0, t, 0.15); mb.high.gain.gain.setTargetAtTime(1.0, t, 0.15); } catch (_) {} }
            }
          }
          if (currentNodes._loudnessNorm && !!sm.get(P.A_LUFS) && actuallyEnabled) { currentNodes._lufsMeter.measure(); currentNodes._loudnessNorm.update(); }
          if (actuallyEnabled) {
            let redDb = 0;
            if (mbActive && currentNodes._multiband) { const rl = Math.abs(Number(currentNodes._multiband.bands.low.comp.reduction) || 0), rm = Math.abs(Number(currentNodes._multiband.bands.mid.comp.reduction) || 0), rh = Math.abs(Number(currentNodes._multiband.bands.high.comp.reduction) || 0); redDb = -Math.max(rl, rm, rh); } else if (currentNodes.limiter) { const r = currentNodes.limiter.reduction; redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0; }
            if (!Number.isFinite(redDb)) redDb = 0; const redPos = clamp(-redDb, 0, 18); let gateMult = 1.0; if (db < -45) gateMult = 0.0; else if (db < -40) gateMult = (db - (-45)) / 5.0;
            const makeupDbTarget = clamp(Math.max(0, redPos - 2.0) * 0.22, 0, 2.8) * gateMult; makeupDbEma += (makeupDbTarget - makeupDbEma) * (makeupDbTarget > makeupDbEma ? 0.35 : 0.015);
          } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
        }
        const userBoost = Math.pow(10, Number(sm.get(P.A_BST) || 0) / 20), makeup = Math.pow(10, makeupDbEma / 20);
        if (wetInGain) { const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0; try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; } }
        audioLoopTimerId = setTimeout(() => runAudioLoop(tok), 40);
      }
      const updateMix = () => {
        if (!ctx) return; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
        const tok = ++loopTok, dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)), isHooked = !!currentSrc;
        const wetTarget = (dynAct && isHooked) ? 1 : 0, dryTarget = 1 - wetTarget;
        rampGainsSafe(dryGain, dryTarget); rampGainsSafe(wetGain, wetTarget);
        if (currentNodes) {
          const mbEnabled = dynAct && !!sm.get(P.A_MULTIBAND);
          if (currentNodes._multiband) { const mb = currentNodes._multiband.bands, t = ctx.currentTime; try { mb.low.comp.ratio.setTargetAtTime(mbEnabled ? 3.0 : 1.0, t, 0.02); mb.mid.comp.ratio.setTargetAtTime(mbEnabled ? 2.5 : 1.0, t, 0.02); mb.high.comp.ratio.setTargetAtTime(mbEnabled ? 2.0 : 1.0, t, 0.02); } catch (_) {} }
          if (currentNodes._loudnessNorm && (!sm.get(P.A_LUFS) || !dynAct)) { try { currentNodes._loudnessNorm.node.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) {} currentNodes._loudnessNorm.reset(); }
        }
        if (dynAct && isHooked) runAudioLoop(tok);
      };
      async function destroy() { loopTok++; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; } try { fadeOutThen(() => disconnectAll()); } catch (_) {} try { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {} ctx = null; currentNodes = null; limiter = null; wetInGain = null; inputGain = null; dryGain = null; wetGain = null; masterOut = null; hpf = null; clipper = null; currentSrc = null; target = null; analyser = null; dataArray = null; makeupDbEma = 0; switchTok++; srcMap = new WeakMap(); }
      return { setTarget: (v) => { const st = v ? getVState(v) : null; if (st && st.audioFailUntil > performance.now()) { if (v !== target) fadeOutThen(() => { disconnectAll(); target = v; }); updateMix(); return; } if (!ensureCtx()) return; if (v === target) { updateMix(); return; } fadeOutThen(() => { disconnectAll(); target = v; if (!v) { updateMix(); return; } try { let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); } s.connect(inputGain); currentSrc = s; } catch (_) { if (st) st.audioFailUntil = performance.now() + RUNTIME_GUARD.audio.createSourceCooldownMs; disconnectAll(); } updateMix(); }); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
    }

    const appAsym = (c, t, au, ad) => { const d = t - c; return Math.abs(d) < 0.002 ? t : c + d * (d > 0 ? au : ad); };
    function createAutoSceneManager(Store, P, Scheduler) {
      const AUTO = { running: false, canvasW: 96, canvasH: 54, cur: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }, tgt: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }, lastSig: null, cutScoreEma: 0.10, motionEma: 0, motionAlpha: 0.30, motionThresh: 0.012, motionFrames: 0, motionMinFrames: 5, statsEma: null, statsAlpha: 0.18, drmBlocked: false, blockUntilMs: 0, _drmSuccessCount: 0, tBoostUntil: 0, tBoostStart: 0, boostMs: 800, minBoostEarlyMs: 700, fpsHist: [], minFps: 2, maxFps: 10, curFps: 2, _lumaN: 0, _lumaA: null, _lumaB: null, _lumaFlip: 0, statsBuf: [] };
      const c = document.createElement('canvas'); c.width = AUTO.canvasW; c.height = AUTO.canvasH; let ctx = null; try { ctx = c.getContext('2d', { willReadFrequently: true, desynchronized: true, alpha: false, colorSpace: 'srgb' }); } catch (_) { try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch (__) {} }
      function ensureLumaBuffers(AUTO, n) { if (AUTO._lumaN !== n) { AUTO._lumaN = n; AUTO._lumaA = new Uint8Array(n); AUTO._lumaB = new Uint8Array(n); AUTO._lumaFlip = 0; } }
      function computeStatsAndMotion(AUTO, img, sw, sh) {
        const data32 = new Uint32Array(img.data.buffer), stepPx = 2, sampW = Math.ceil(sw / stepPx), sampH = Math.ceil(sh / stepPx), n = sampW * sampH; ensureLumaBuffers(AUTO, n);
        const cur = (AUTO._lumaFlip === 0) ? AUTO._lumaA : AUTO._lumaB, prev = (AUTO._lumaFlip === 0) ? AUTO._lumaB : AUTO._lumaA;
        let sum = 0, sum2 = 0, sumEdge = 0, diffSum = 0, sumChroma = 0, p = 0;
        const cx = sw / 2, cy = sh / 2, maxDist = Math.sqrt(cx * cx + cy * cy);
        for (let y = 0; y < sh; y += stepPx) {
            const rowOff = y * sw;
            for (let x = 0; x < sw; x += stepPx) {
                const pixel = data32[rowOff + x], r = pixel & 0xFF, g = (pixel >> 8) & 0xFF, b = (pixel >> 16) & 0xFF, l = (r * 54 + g * 183 + b * 19) >> 8, max3 = r > g ? (r > b ? r : b) : (g > b ? g : b), min3 = r < g ? (r < b ? r : b) : (g < b ? g : b);
                const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2), weight = 1.0 - 0.3 * (dist / maxDist);
                sumChroma += (max3 - min3); cur[p] = l; sum += l * weight; sum2 += (l * weight) * (l * weight);
                if (x + stepPx < sw) { const p2 = data32[rowOff + x + stepPx], l2 = ((p2 & 0xFF) * 54 + ((p2 >> 8) & 0xFF) * 183 + ((p2 >> 16) & 0xFF) * 19) >> 8; sumEdge += (l2 > l ? l2 - l : l - l2); }
                if (y + stepPx < sh) { const p3 = data32[(y + stepPx) * sw + x], l3 = ((p3 & 0xFF) * 54 + ((p3 >> 8) & 0xFF) * 183 + ((p3 >> 16) & 0xFF) * 19) >> 8; sumEdge += (l3 > l ? l3 - l : l - l3); }
                diffSum += (l > prev[p] ? l - prev[p] : prev[p] - l); p++;
            }
        }
        AUTO._lumaFlip ^= 1; const samples = Math.max(1, n), mean = sum / samples, var_ = (sum2 / samples) - mean * mean;
        return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, chroma: (sumChroma / samples) / 255, edge: sumEdge / samples, motion: diffSum / samples };
      }
      function detectCut(sig) {
        if (!AUTO.lastSig) return false; const dY = Math.abs(sig.bright - AUTO.lastSig.bright), dCt = Math.abs(sig.contrast - AUTO.lastSig.contrast), score = (dY * 1.1) + (dCt * 0.9);
        if (!AUTO.cutScoreEma) AUTO.cutScoreEma = 0.10; AUTO.cutScoreEma = AUTO.cutScoreEma * 0.92 + score * 0.08;
        const thr = Math.max(0.10, Math.min(0.22, AUTO.cutScoreEma * 1.3)); sig.__cutScore = score; return score > thr;
      }
      function calculateAdaptiveFps(changeScore, now) {
        AUTO.fpsHist.push({ score: changeScore, t: now });
        while (AUTO.fpsHist.length > 0 && now - AUTO.fpsHist[0].t > 1000) AUTO.fpsHist.shift();
        const avgChange = AUTO.fpsHist.reduce((a, b) => a + b.score, 0) / Math.max(1, AUTO.fpsHist.length);
        let targetFps; if (avgChange < 0.1) targetFps = 2 + (avgChange / 0.1) * 2; else if (avgChange < 0.3) targetFps = 4 + ((avgChange - 0.1) / 0.2) * 3; else targetFps = 7 + (Math.min(avgChange - 0.3, 0.7) / 0.7) * 3;
        const clamped = VSC_CLAMP(targetFps, AUTO.minFps, AUTO.maxFps); AUTO.curFps += VSC_CLAMP(Math.round(clamped * 2) / 2 - AUTO.curFps, -1, 1); return AUTO.curFps;
      }
      function medianOf(arr, key) { if (!arr.length) return 0; const vals = arr.map(s => s[key]).sort((a, b) => a - b), mid = vals.length >> 1; return vals.length === 1 ? vals[0] : vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) * 0.5; }
      let __asRvfcId = 0;
      function scheduleNext(v, delayMs) {
        if (!AUTO.running) return;
        if (v?.paused || v?.ended) { const resumeLoop = () => { v.removeEventListener('play', resumeLoop); if (AUTO.running) loop(); }; v.addEventListener('play', resumeLoop, { once: true }); return; }
        if (v && typeof v.requestVideoFrameCallback === 'function') { const target = performance.now() + Math.max(0, delayMs|0); try { if (__asRvfcId && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(__asRvfcId); } catch (_) {} __asRvfcId = v.requestVideoFrameCallback(() => { __asRvfcId = 0; const remain = target - performance.now(); if (remain > 6) { scheduleNext(v, remain); return; } loop(); }); return; }
        setTimeout(loop, Math.max(16, delayMs|0));
      }
      function loop() {
        if (!AUTO.running) return;
        const now = performance.now(), en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT), v = window.__VSC_APP__?.getActiveVideo?.();
        if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; AUTO.running = false; Scheduler.request(true); return; }
        if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; }
        if (!v || !ctx || v.paused || v.seeking || v.readyState < 2) { try { Scheduler.request(true); } catch (_) {} scheduleNext(v, 120); return; }
        try {
          ctx.drawImage(v, 0, 0, AUTO.canvasW, AUTO.canvasH); const img = ctx.getImageData(0, 0, AUTO.canvasW, AUTO.canvasH);
          AUTO.drmBlocked = false; AUTO._drmSuccessCount = (AUTO._drmSuccessCount || 0) + 1;
          if (AUTO._drmSuccessCount > 10) AUTO._drmBackoffCount = 0;
          const sigRaw = computeStatsAndMotion(AUTO, img, AUTO.canvasW, AUTO.canvasH); AUTO.motionEma = (AUTO.motionEma * (1 - AUTO.motionAlpha)) + (sigRaw.motion * AUTO.motionAlpha); AUTO.motionFrames = (AUTO.motionEma >= AUTO.motionThresh) ? (AUTO.motionFrames + 1) : 0;
          const isCut = detectCut(sigRaw); AUTO.lastSig = sigRaw;
          AUTO.statsBuf.push({ ...sigRaw }); if (AUTO.statsBuf.length > 5) AUTO.statsBuf.shift();
          const filteredStats = { bright: medianOf(AUTO.statsBuf, 'bright'), contrast: medianOf(AUTO.statsBuf, 'contrast'), chroma: medianOf(AUTO.statsBuf, 'chroma'), edge: medianOf(AUTO.statsBuf, 'edge'), motion: sigRaw.motion };
          if (!AUTO.statsEma) AUTO.statsEma = { ...filteredStats }; else { const e = AUTO.statsEma, a = AUTO.statsAlpha; e.bright = e.bright*(1-a) + filteredStats.bright*a; e.contrast = e.contrast*(1-a) + filteredStats.contrast*a; e.edge = e.edge*(1-a) + filteredStats.edge*a; }
          const sig = AUTO.statsEma; if (isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; }
          const allowUpdate = isCut || (AUTO.motionFrames >= AUTO.motionMinFrames); let fps = AUTO.curFps;
          if (allowUpdate) {
            fps = calculateAdaptiveFps(VSC_CLAMP(sigRaw.motion||0,0,1), now); if (now < AUTO.tBoostUntil) fps = Math.max(fps, (now - AUTO.tBoostStart < AUTO.minBoostEarlyMs) ? 10 : 8);
            let gainT = 1.0, ctT = 1.0, satT = 1.0, sharpScaleT = 1.0;
            if (sig.bright < 0.25) gainT = 1.0 + ((0.25 - sig.bright) / 0.25) * 0.15; else if (sig.bright > 0.75) gainT = 1.0 - ((sig.bright - 0.75) / 0.25) * 0.05;
            if (sig.contrast < 0.12) ctT = 1.0 + ((0.12 - sig.contrast) / 0.12) * 0.10;
            const cCh = Number(sig.chroma || 0); if (cCh < 0.08) satT = 1.0 + ((0.08 - cCh) / 0.08) * 0.12; else if (cCh > 0.35) satT = 1.0 - Math.min((cCh - 0.35) / 0.35, 1.0) * 0.08;
            const edgeVal = Number(sig.edge || 0); if (edgeVal > 12) { sharpScaleT = 1.0 - VSC_CLAMP((edgeVal - 12) / 13, 0, 1) * 0.40; } else if (edgeVal < 4) { sharpScaleT = 1.0 + VSC_CLAMP((4 - edgeVal) / 4, 0, 1) * 0.15; }
            const appDZ = (t, dz) => { const d = Math.abs(t - 1.0); return d < dz ? 1.0 : (t > 1.0 ? 1.0 + (d - dz) : 1.0 - (d - dz)); };
            AUTO.tgt.br = VSC_CLAMP(appDZ(gainT, 0.03), 0.95, 1.15); AUTO.tgt.ct = VSC_CLAMP(appDZ(ctT, 0.02), 0.95, 1.12); AUTO.tgt.sat = VSC_CLAMP(appDZ(satT, 0.03), 0.92, 1.12); AUTO.tgt.sharpScale = VSC_CLAMP(sharpScaleT, 0.60, 1.15);
            const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat, prevSh = AUTO.cur.sharpScale;
            AUTO.cur.br = appAsym(AUTO.cur.br, AUTO.tgt.br, isCut ? 0.20 : 0.06, isCut ? 0.25 : 0.10); AUTO.cur.ct = appAsym(AUTO.cur.ct, AUTO.tgt.ct, isCut ? 0.18 : 0.06, isCut ? 0.18 : 0.06); AUTO.cur.sat = appAsym(AUTO.cur.sat, AUTO.tgt.sat, isCut ? 0.12 : 0.04, isCut ? 0.20 : 0.08); AUTO.cur.sharpScale = appAsym(AUTO.cur.sharpScale, AUTO.tgt.sharpScale, isCut ? 0.15 : 0.04, isCut ? 0.20 : 0.08);
            if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001 || Math.abs(prevSh - AUTO.cur.sharpScale) > 0.001) Scheduler.request(true);
          }
          scheduleNext(v, Math.max(80, Math.round(1000 / Math.max(1, fps))));
        } catch (e) {
          AUTO.drmBlocked = true; AUTO._drmSuccessCount = 0; AUTO._drmBackoffCount = (AUTO._drmBackoffCount || 0) + 1; const backoffMs = Math.min(5000, 1000 * Math.pow(1.5, AUTO._drmBackoffCount)); AUTO.blockUntilMs = performance.now() + backoffMs; scheduleNext(v, 1000);
        }
      }
      Store.sub(P.APP_AUTO_SCENE, (en) => { if (en && !AUTO.running) { AUTO.running = true; loop(); } else if (!en) { AUTO.running = false; AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; Scheduler.request(true); } }); Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { AUTO.running = true; loop(); } });
      return { getMods: () => AUTO.cur, start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { AUTO.running = true; loop(); } }, stop: () => { AUTO.running = false; } };
    }

    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(720);
      const LUMA_MATRIX = '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0';
      const __attrCache = new WeakMap();
      const setAttrCached = (node, attr, val) => { if (!node) return; const s = (val === undefined || val === null) ? '' : String(val); let rec = __attrCache.get(node); if (!rec) { rec = Object.create(null); __attrCache.set(node, rec); } if (rec[attr] === s) return; rec[attr] = s; node.setAttribute(attr, s); };
      const setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; setAttrCached(node, attr, val); } }, sCurve = (x) => x * x * (3 - 2 * x);
      const softCap = (x, knee = 1.0, max = 2.0) => { x = Math.max(0, x); if (x <= knee) return x; const t = (x - knee) / Math.max(1e-6, (max - knee)); return knee + (max - knee) * (1 - Math.exp(-t)); };
      const applyLumaWeight = (bNode, sumNode, st, keyB, keyW, v, kMul, stdBase, stdDrop, isK3 = false) => { const vn = softCap(v, 1.0, 2.0), scVal = sCurve(Math.min(1, vn)), extra = Math.max(0, vn - 1), w = (scVal + extra) * kMul; setAttr(bNode, 'stdDeviation', v > 0 ? (stdBase - sCurve(Math.min(1, v)) * stdDrop).toFixed(2) : '0', st, keyB); setAttr(sumNode, isK3 ? 'k3' : 'k2', w.toFixed(3), st, keyW); };
      const makeKeyBase = (s) => [ Math.round(s.gain / 0.04), Math.round(s.gamma / 0.01), Math.round(s.contrast / 0.01), Math.round(s.bright / 0.2), Math.round(s.satF / 0.01), Math.round(s.mid / 0.02), Math.round(s.toe / 0.2), Math.round(s.shoulder / 0.2), Math.round(s.temp / 0.2), Math.round(s.sharp / 0.2), Math.round(s.sharp2 / 0.2), Math.round(s.clarity / 0.2) ].join('|');
      function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
        const key = `${steps}|${toeN}|${shoulderN}|${midN}|${gain}`; const hit = toneCache.get(key); if (hit) return hit;
        if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; }
        const curve = computeToneCurve(steps, toeN, midN, shoulderN, gain), res = Array.from(curve).map(yy => { const y = Math.round(yy * 100000) / 100000; return (y === 1 ? '1' : y === 0 ? '0' : String(y)); }).join(' '); toneCache.set(key, res); return res;
      }
      const SVG_MAX_PIX_FULL = config.SVG_MAX_PIX_FULL ?? (3840 * 2160), SVG_MAX_PIX_FAST = config.SVG_MAX_PIX_FAST ?? (3840 * 2160);
      function calcFilterRes(vw, vh, maxPix) { vw = vw | 0; vh = vh | 0; if (vw <= 0 || vh <= 0 || maxPix <= 0) return ''; const px = vw * vh; if (px <= maxPix) return `${vw} ${vh}`; const s = Math.sqrt(maxPix / px); return `${Math.max(1, Math.round(vw * s))} ${Math.max(1, Math.round(vh * s))}`; }

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const fidLite = `vsc-lite-${config.VSC_ID}`, fidFast = `vsc-fast-${config.VSC_ID}`, fidFullLight = `vsc-full-light-${config.VSC_ID}`, fidFull = `vsc-full-${config.VSC_ID}`;
        const mkC = (p) => { const t = h('feComponentTransfer', { ns: 'svg', result: `${p}_t` }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' }))); const b = h('feComponentTransfer', { ns: 'svg', in: `${p}_t`, result: `${p}_b` }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }))); const g = h('feComponentTransfer', { ns: 'svg', in: `${p}_b`, result: `${p}_g` }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' }))); return {t, b, g}; };
        const mkP = (p, inN) => { const tm = h('feComponentTransfer', { ns: 'svg', in: inN, result: `${p}_tm` }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }))); const s = h('feColorMatrix', { ns: 'svg', in: `${p}_tm`, type: 'saturate', values: '1', result: `${p}_s` }); return {tm, s}; };
        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' }); const cL = mkC('l'), pL = mkP('l', 'l_g'); lite.append(cL.t, cL.b, cL.g, pL.tm, pL.s);
        const fast = h('filter', { ns: 'svg', id: fidFast, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' }); const cF = mkC('f');
        const fLuma = h('feColorMatrix', { ns: 'svg', in: 'f_g', type: 'matrix', values: LUMA_MATRIX, result: 'f_luma' }), fB1 = h('feGaussianBlur',  { ns: 'svg', in: 'f_luma', stdDeviation: '0', result: 'f_b1' }), fD1 = h('feComposite',     { ns: 'svg', in: 'f_luma', in2: 'f_b1', operator: 'arithmetic', k2: '1', k3: '-1', result: 'f_d1' }), fB2 = h('feGaussianBlur',  { ns: 'svg', in: 'f_luma', stdDeviation: '0', result: 'f_b2' }), fD2 = h('feComposite',     { ns: 'svg', in: 'f_luma', in2: 'f_b2', operator: 'arithmetic', k2: '1', k3: '-1', result: 'f_d2' }), fSum = h('feComposite',    { ns: 'svg', in: 'f_d1', in2: 'f_d2', operator: 'arithmetic', k2: '0', k3: '0', result: 'f_sum' }), fOut = h('feComposite',    { ns: 'svg', in: 'f_g', in2: 'f_sum', operator: 'arithmetic', k2: '1', k3: '1', result: 'f_out' }), pF = mkP('f', 'f_out');
        fast.append(cF.t, cF.b, cF.g, fLuma, fB1, fD1, fB2, fD2, fSum, fOut, pF.tm, pF.s);
        const fullLight = h('filter', { ns: 'svg', id: fidFullLight, 'color-interpolation-filters': 'sRGB', x: '-10%', y: '-10%', width: '120%', height: '120%' }); const cUL = mkC('ul');
        const ulLuma = h('feColorMatrix', { ns: 'svg', in: 'ul_g', type: 'matrix', values: LUMA_MATRIX, result: 'ul_luma' }), ulB1 = h('feGaussianBlur',  { ns: 'svg', in: 'ul_luma', stdDeviation: '0', result: 'ul_b1' }), ulD1 = h('feComposite',     { ns: 'svg', in: 'ul_luma', in2: 'ul_b1', operator: 'arithmetic', k2: '1', k3: '-1', result: 'ul_d1' }), ulBc = h('feGaussianBlur',  { ns: 'svg', in: 'ul_luma', stdDeviation: '0', result: 'ul_bc' }), ulDc = h('feComposite',     { ns: 'svg', in: 'ul_luma', in2: 'ul_bc', operator: 'arithmetic', k2: '1', k3: '-1', result: 'ul_dc' }), ulSum = h('feComposite',    { ns: 'svg', in: 'ul_d1', in2: 'ul_dc', operator: 'arithmetic', k2: '0', k3: '0', result: 'ul_sum' }), ulOut = h('feComposite',    { ns: 'svg', in: 'ul_g', in2: 'ul_sum', operator: 'arithmetic', k2: '1', k3: '1', result: 'ul_out' }), pUL = mkP('ul', 'ul_out');
        fullLight.append(cUL.t, cUL.b, cUL.g, ulLuma, ulB1, ulD1, ulBc, ulDc, ulSum, ulOut, pUL.tm, pUL.s);
        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '-10%', y: '-10%', width: '120%', height: '120%' }); const cU = mkC('u');
        const uLuma = h('feColorMatrix', { ns: 'svg', in: 'u_g', type: 'matrix', values: LUMA_MATRIX, result: 'u_luma' }), uB1  = h('feGaussianBlur', { ns: 'svg', in: 'u_luma', stdDeviation: '0', result: 'u_b1' }), uD1  = h('feComposite',    { ns: 'svg', in: 'u_luma', in2: 'u_b1', operator: 'arithmetic', k2: '1', k3: '-1', result: 'u_d1' }), uB2  = h('feGaussianBlur', { ns: 'svg', in: 'u_luma', stdDeviation: '0', result: 'u_b2' }), uD2  = h('feComposite',    { ns: 'svg', in: 'u_luma', in2: 'u_b2', operator: 'arithmetic', k2: '1', k3: '-1', result: 'u_d2' }), uBc  = h('feGaussianBlur', { ns: 'svg', in: 'u_luma', stdDeviation: '0', result: 'u_bc' }), uDc  = h('feComposite',    { ns: 'svg', in: 'u_luma', in2: 'u_bc', operator: 'arithmetic', k2: '1', k3: '-1', result: 'u_dc' }), uSum12 = h('feComposite',  { ns: 'svg', in: 'u_d1', in2: 'u_d2', operator: 'arithmetic', k2: '0', k3: '0', result: 'u_sum12' }), uSumAll = h('feComposite', { ns: 'svg', in: 'u_sum12', in2: 'u_dc', operator: 'arithmetic', k2: '1', k3: '0', result: 'u_sumAll' }), uOut = h('feComposite',    { ns: 'svg', in: 'u_g', in2: 'u_sumAll', operator: 'arithmetic', k2: '1', k3: '1', result: 'u_out' }), pU = mkP('u', 'u_out');
        full.append(cU.t, cU.b, cU.g, uLuma, uB1, uD1, uB2, uD2, uBc, uDc, uSum12, uSumAll, uOut, pU.tm, pU.s);
        defs.append(lite, fast, fullLight, full); const tryAppend = () => { const target = root.body || root.documentElement || root; if (target && target.appendChild) { target.appendChild(svg); return true; } return false; }; if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }
        const commonByTier = { lite: { toneFuncs: Array.from(cL.t.children), bcLinFuncs: Array.from(cL.b.children), gamFuncs: Array.from(cL.g.children), tmpFuncs: Array.from(pL.tm.children), sats: [pL.s] }, fast: { toneFuncs: Array.from(cF.t.children), bcLinFuncs: Array.from(cF.b.children), gamFuncs: Array.from(cF.g.children), tmpFuncs: Array.from(pF.tm.children), sats: [pF.s] }, 'full-light': { toneFuncs: Array.from(cUL.t.children), bcLinFuncs: Array.from(cUL.b.children), gamFuncs: Array.from(cUL.g.children), tmpFuncs: Array.from(pUL.tm.children), sats: [pUL.s] }, full: { toneFuncs: Array.from(cU.t.children), bcLinFuncs: Array.from(cU.b.children), gamFuncs: Array.from(cU.g.children), tmpFuncs: Array.from(pU.tm.children), sats: [pU.s] } };
        return { fidLite, fidFast, fidFullLight, fidFull, filters: { lite, fast, fullLight, full }, commonByTier, fastDetail: { b1: fB1, b2: fB2, sum: fSum }, fullLightDetail: { b1: ulB1, bc: ulBc, sum: ulSum }, fullDetail: { b1: uB1, b2: uB2, bc: uBc, sum12: uSum12, sumAll: uSumAll }, st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', commonTier: { lite: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, fast: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, 'full-light': { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, full: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' } }, detailKey: '', fastKey: '', fullLightKey: '', fullKey: '', __fB1: '', __fB2: '', __fSumK2: '', __fSumK3: '', __ulB1: '', __ulBc: '', __ulSumK2: '', __ulSumK3: '', __uB1: '', __uB2: '', __uBc: '', __uSum12K2: '', __uSum12K3: '', __uSumAllK3: '', __filterRes: '' } };
      }

      const _pendingStyleUpdates = []; let _styleFlushScheduled = false;
      function scheduleStyleFlush() { if (_styleFlushScheduled) return; _styleFlushScheduled = true; queueMicrotask(() => { _styleFlushScheduled = false; for (const fn of _pendingStyleUpdates) fn(); _pendingStyleUpdates.length = 0; }); }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key:'', url:'' }; urlCache.set(root, dc); }
        const vwKey = video.videoWidth || 0, vhKey = video.videoHeight || 0; let tier = 'lite'; const sharpTotal = (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)), px = vwKey * vhKey, isHiRes = px >= (1920 * 1080), isMidRes = px > (1280 * 720) && px < (1920 * 1080), isLoRes = px > 0 && px <= (1280 * 720);
        if (sharpTotal > 0) { if (s.__qos === 'fast' || isHiRes || isMidRes) tier = 'fast'; else if (isLoRes && !(Number(s.sharp2 || 0) > 0)) tier = 'full-light'; else tier = 'full'; }
        const key = `${tier}|${vwKey}x${vhKey}|${makeKeyBase(s)}`; if (dc.key === key) return dc.url;
        let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }

        if (nodes.st.lastKey !== key) {
          nodes.st.lastKey = key; const st = nodes.st, steps = 64, gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08;
          const toeQ = Math.round(clamp((s.toe||0)/14,-1,1)/0.02)*0.02, shQ = Math.round(clamp((s.shoulder||0)/16,-1,1)/0.02)*0.02, midQ = Math.round(clamp(s.mid||0,-1,1)/0.02)*0.02, gainQ2 = Math.round((s.gain||1)/gainQ)*gainQ;
          const tk = `${steps}|${toeQ}|${shQ}|${midQ}|${gainQ2}`, cst = st.commonTier[tier] || st, table = (cst.toneKey !== tk) ? getToneTableCached(steps, toeQ, shQ, midQ, gainQ2) : cst.toneTable;
          const con = clamp(s.contrast || 1, 0.1, 5.0), brightOffset = clamp((s.bright || 0) / 1000, -0.5, 0.5), intercept = clamp(0.5 * (1 - con) + brightOffset, -5, 5), conStr = con.toFixed(3), interceptStr = intercept.toFixed(4), bcLinKey = `${conStr}|${interceptStr}`, gk = (1/clamp(s.gamma||1,0.1,5.0)).toFixed(4), satVal = clamp(s.satF ?? 1, 0, 5.0).toFixed(2), rsStr = s._rs.toFixed(3), gsStr = s._gs.toFixed(3), bsStr = s._bs.toFixed(3), tmk = `${rsStr}|${gsStr}|${bsStr}`;
          const pxScale = Math.sqrt((Math.max(1, vwKey * vhKey)) / (1280 * 720)), hiResN  = Math.max(0, Math.min(1, (pxScale - 1.0) / 1.7)), dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
          const common = nodes.commonByTier[tier];
          function updateKey(obj, key, next, apply) { if (obj[key] === next) return false; obj[key] = next; apply(); return true; }
          updateKey(cst, 'toneKey', tk, () => { if (cst.toneTable !== table) { cst.toneTable = table; if (common.toneFuncs) for (const fn of common.toneFuncs) setAttrCached(fn, 'tableValues', table); } });
          updateKey(cst, 'bcLinKey', bcLinKey, () => { if (common.bcLinFuncs) for (const fn of common.bcLinFuncs) { setAttrCached(fn, 'slope', conStr); setAttrCached(fn, 'intercept', interceptStr); } });
          updateKey(cst, 'gammaKey', gk, () => { if (common.gamFuncs) for (const fn of common.gamFuncs) setAttrCached(fn, 'exponent', gk); });
          updateKey(cst, 'satKey', satVal, () => { if (common.sats) for (const satNode of common.sats) setAttrCached(satNode, 'values', satVal); });
          updateKey(cst, 'tempKey', tmk, () => { if (common.tmpFuncs) for (let i=0; i<common.tmpFuncs.length; i+=3) { setAttrCached(common.tmpFuncs[i], 'slope', rsStr); setAttrCached(common.tmpFuncs[i+1], 'slope', gsStr); setAttrCached(common.tmpFuncs[i+2], 'slope', bsStr); } });

          if (tier === 'fast') {
            const lvl = (s.__detailLevel || 'off'), fastKeyNext = `${dk}|${lvl}`;
            if (st.fastKey !== fastKeyNext) {
              st.fastKey = fastKeyNext; const v1Base = (s.sharp || 0) / 50; let v1Mul = 1.00, rad = 2.20, thr = 0.65, halo = 0.20;
              if (lvl === 's') { v1Mul = 1.05; rad = 2.25; thr = 0.66; halo = 0.20; } else if (lvl === 'm') { v1Mul = 1.12; rad = 2.30; thr = 0.65; halo = 0.21; } else if (lvl === 'l') { v1Mul = 1.22; rad = 2.35; thr = 0.64; halo = 0.22; } else if (lvl === 'xl'){ v1Mul = 1.55; rad = 2.90; thr = 0.62; halo = 0.28; }
              applyLumaWeight(nodes.fastDetail.b1, nodes.fastDetail.sum, st, '__fB1', '__fSumK2', v1Base * v1Mul, rad, thr, halo, false);
              const v2 = (s.sharp2 || 0) / 50, cl = (s.clarity || 0) / 50; let wV2 = 1.10, wCl = 0.60, microMul = 1.00, kMMul = 1.60, std2 = '0.20';
              if (lvl === 's') { wV2 = 1.05; wCl = 0.55; microMul = 0.98; kMMul = 1.45; std2 = '0.21'; } else if (lvl === 'm') { wV2 = 1.15; wCl = 0.65; microMul = 1.02; kMMul = 1.70; std2 = '0.20'; } else if (lvl === 'l') { wV2 = 1.25; wCl = 0.75; microMul = 1.06; kMMul = 2.00; std2 = '0.18'; } else if (lvl === 'xl'){ wV2 = 1.35; wCl = 0.85; microMul = 1.20; kMMul = 2.70; std2 = '0.16'; }
              const microBase = (v2 * wV2) + (cl * wCl), micro = Math.min(1, microBase * microMul), kM = sCurve(micro) * kMMul;
              setAttr(nodes.fastDetail.b2, 'stdDeviation', micro > 0 ? std2 : '0', st, '__fB2'); setAttr(nodes.fastDetail.sum, 'k3', kM.toFixed(3), st, '__fSumK3');
            }
          } else if (tier === 'full-light') {
            if (st.fullLightKey !== dk) {
              st.fullLightKey = dk; applyLumaWeight(nodes.fullLightDetail.b1, nodes.fullLightDetail.sum, st, '__ulB1', '__ulSumK2', (s.sharp || 0) / 50, 2.2, 0.65, 0.2, false);
              const clVal = (s.clarity || 0) / 50; setAttr(nodes.fullLightDetail.bc, 'stdDeviation', clVal > 0 ? (0.75 + hiResN * 0.35).toFixed(2) : '0', st, '__ulBc'); setAttr(nodes.fullLightDetail.sum, 'k3', (clVal * (1.05 + hiResN * 0.35)).toFixed(3), st, '__ulSumK3');
            }
          } else if (tier === 'full') {
            if (st.fullKey !== dk) {
              st.fullKey = dk; applyLumaWeight(nodes.fullDetail.b1, nodes.fullDetail.sum12, st, '__uB1', '__uSum12K2', (s.sharp || 0) / 50, 2.2, 0.65, 0.2, false);
              const v2 = (s.sharp2 || 0) / 50, kF = Math.min(sCurve(Math.min(1, v2)) * 4.8, 3.5); setAttr(nodes.fullDetail.b2, 'stdDeviation', v2 > 0 ? '0.25' : '0', st, '__uB2'); setAttr(nodes.fullDetail.sum12, 'k3', kF.toFixed(3), st, '__uSum12K3');
              const clVal = (s.clarity || 0) / 50; setAttr(nodes.fullDetail.bc, 'stdDeviation', clVal > 0 ? (0.85 + hiResN * 0.55).toFixed(2) : '0', st, '__uBc'); setAttr(nodes.fullDetail.sumAll, 'k3', (clVal * (1.15 + hiResN * 0.55)).toFixed(3), st, '__uSumAllK3');
            }
          }
          const fr = (tier === 'full' || tier === 'full-light') ? calcFilterRes(vwKey, vhKey, SVG_MAX_PIX_FULL) : (tier === 'fast') ? calcFilterRes(vwKey, vhKey, SVG_MAX_PIX_FAST) : '';
          const allFilterEls = [nodes.filters.lite, nodes.filters.fast, nodes.filters.fullLight, nodes.filters.full];
          const activeFilterEl = (tier === 'full') ? nodes.filters.full : (tier === 'full-light') ? nodes.filters.fullLight : (tier === 'fast') ? nodes.filters.fast : nodes.filters.lite;
          for (const f of allFilterEls) { if (f !== activeFilterEl && f.hasAttribute('filterRes')) f.removeAttribute('filterRes'); }
          if (typeof fr === 'string' && fr !== '') { if (st.__filterRes !== fr) { st.__filterRes = fr; activeFilterEl.setAttribute('filterRes', fr); } }
          else if (st.__filterRes !== '') { st.__filterRes = ''; activeFilterEl.removeAttribute('filterRes'); }
        }
        const targetFid = tier === 'lite' ? nodes.fidLite : (tier === 'fast' ? nodes.fidFast : (tier === 'full-light' ? nodes.fidFullLight : nodes.fidFull));
        const url = `url(#${targetFid})`; dc.key = key; dc.url = url; return url;
      }

      return {
        prepareCached: (video, s) => { try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
        applyUrl: (el, url) => { if (!el) return; const st = getVState(el); if (!url) { if (st.applied) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; } return; } if (st.lastFilterUrl === url) return; _pendingStyleUpdates.push(() => { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }); scheduleStyleFlush(); st.applied = true; st.lastFilterUrl = url; },
        clear: (el) => { if (!el) return; const st = getVState(el); if (!st.applied) return; _pendingStyleUpdates.push(() => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); }); scheduleStyleFlush(); st.applied = false; st.lastFilterUrl = null; }
      };
    }

    function createFiltersWebGL(Utils) {
      const pipelines = new WeakMap();
      const tq = (v, st) => Math.round(v / st) * st;
      function compileShaderChecked(gl, type, source) { const shader = gl.createShader(type); if (!shader) throw new Error('gl.createShader failed'); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const info = gl.getShaderInfoLog(shader) || 'unknown error'; gl.deleteShader(shader); throw new Error(`Shader compile failed (${type}): ${info}`); } return shader; }
      function linkProgramChecked(gl, vs, fs) { const program = gl.createProgram(); if (!program) throw new Error('gl.createProgram failed'); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const info = gl.getProgramInfoLog(program) || 'unknown error'; gl.deleteProgram(program); throw new Error(`Program link failed: ${info}`); } return program; }

      function buildToneLUT256(toe, mid, shoulder, gain = 1.0) {
        const curve = computeToneCurve(256, VSC_CLAMP(toe / 14, -1, 1), VSC_CLAMP(mid, -1, 1), VSC_CLAMP(shoulder / 16, -1, 1), gain), out = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) { const v = (curve[i] * 255 + 0.5) | 0, o = i * 4; out[o] = out[o+1] = out[o+2] = v; out[o+3] = 255; } return out;
      }

      const glslCommon = `const vec3 LUMA=vec3(0.2126,0.7152,0.0722);float tone1(float y){return TEX(uToneTex,vec2(y*(255./256.)+(.5/256.),.5)).r;}vec3 softClip(vec3 c,float knee){vec3 x=max(c-1.,vec3(0.));return c-(x*x)/(x+vec3(knee));}vec3 applyGrading(vec3 color){color*=uRGBGain;color+=(uParams2.x/1000.);color=(color-.5)*uParams.y+.5;color*=uParams.x;float y=dot(color,LUMA),y2=tone1(clamp(y,0.,1.)),ratio=y2/max(1e-4,y);color*=ratio;float luma=dot(color,LUMA),hiLuma=clamp((luma-.72)/.28,0.,1.),satReduce=hiLuma*hiLuma*(3.-2.*hiLuma),currentSat=uParams.z*(1.-.05*satReduce);color=luma+(color-luma)*currentSat;if(uParams.w!=1.)color=pow(max(color,vec3(0.)),vec3(1./uParams.w));return clamp(softClip(color,.18),0.,1.);}`;
      function buildFsColorOnly({ gl2 }) { return (gl2 ? `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n` : `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`) + `uniform sampler2D uVideoTex;uniform sampler2D uToneTex;uniform vec4 uParams;uniform vec4 uParams2;uniform vec3 uRGBGain;\n${glslCommon}\nvoid main(){vec3 color=TEX(uVideoTex,vTexCoord).rgb;outColor=vec4(applyGrading(color),1.);}`; }
      function buildFsSharpen({ gl2 }) { return (gl2 ? `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n` : `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`) + `uniform sampler2D uVideoTex;uniform sampler2D uToneTex;uniform vec2 uResolution;uniform vec4 uParams;uniform vec4 uParams2;uniform vec3 uRGBGain;uniform vec3 uSharpParams;\n${glslCommon}\nvec3 satMix(vec3 c,float sat){float l=dot(c,LUMA);return vec3(l)+(c-vec3(l))*sat;}vec3 rcasSharpen(sampler2D tex,vec2 uv,vec2 texel,float sharpAmount){vec3 b=TEX(tex,uv+vec2(0.,-texel.y)).rgb,d=TEX(tex,uv+vec2(-texel.x,0.)).rgb,e=TEX(tex,uv).rgb,f=TEX(tex,uv+vec2(texel.x,0.)).rgb,h=TEX(tex,uv+vec2(0.,texel.y)).rgb;vec3 mn=min(b,min(d,min(e,min(f,h)))),mx=max(b,max(d,max(e,max(f,h))));if(uParams2.z<.5){vec3 a=TEX(tex,uv+vec2(-texel.x,-texel.y)).rgb,c=TEX(tex,uv+vec2(texel.x,-texel.y)).rgb,g=TEX(tex,uv+vec2(-texel.x,texel.y)).rgb,i=TEX(tex,uv+vec2(texel.x,texel.y)).rgb;mn=min(mn,min(a,min(c,min(g,i))));mx=max(mx,max(a,max(c,max(g,i))));}float aAmt=clamp(sharpAmount,0.,1.),peak=-1./mix(9.,3.6,aAmt);vec3 hitMin=mn/(4.*mx+1e-4),hitMax=(peak-mx)/(4.*mn+peak),lobeRGB=max(-hitMin,hitMax);float lobe=max(-.1875,min(max(max(hitMin.r,hitMax.r),max(max(hitMin.g,hitMax.g),max(hitMin.b,hitMax.b))),0.));float edgeLuma=abs(dot(b-e,LUMA))+abs(dot(d-e,LUMA))+abs(dot(f-e,LUMA))+abs(dot(h-e,LUMA)),edgeDamp=1.-smoothstep(.05,.25,edgeLuma*.25);lobe*=mix(1.,edgeDamp,clamp(uSharpParams.z,0.,1.));return(lobe*(b+d+f+h)+e)/(4.*lobe+1.);}void main(){vec2 texel=1./uResolution;vec3 color=TEX(uVideoTex,vTexCoord).rgb;float sharpAmount=uParams2.y;if(sharpAmount>0.){color=rcasSharpen(uVideoTex,vTexCoord,texel,sharpAmount);vec3 d0=satMix(color,uSharpParams.x);color=mix(color,d0,uSharpParams.y);}outColor=vec4(applyGrading(color),1.);}`; }
      function buildShaderSources(gl) { const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext); return { vs: isGL2 ? `#version 300 es\nin vec2 aPosition;\nin vec2 aTexCoord;\nout vec2 vTexCoord;\nvoid main(){\n gl_Position=vec4(aPosition,0.,1.);\n vTexCoord=aTexCoord;\n}` : `attribute vec2 aPosition;attribute vec2 aTexCoord;varying vec2 vTexCoord;void main(){gl_Position=vec4(aPosition,0.,1.);vTexCoord=aTexCoord;}`, fsColorOnly: buildFsColorOnly({ gl2: isGL2 }), fsSharpen: buildFsSharpen({ gl2: isGL2 }) }; }

      function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
      function getSharpProfile(vVals, rawW, rawH, isHdr) {
        const s1 = Number(vVals.sharp || 0), s2 = Number(vVals.sharp2 || 0), cl = Number(vVals.clarity || 0); if (s1 <= 0.01 && s2 <= 0.01 && cl <= 0.01) return { amount: 0.0, tapMode: 1.0, desatSat: 1.0, biasMix: 0.0, edgeDampMix: 0.4 };
        let level = 'S'; const isXL = (s1 >= 18 && s2 >= 16 && cl >= 24); if (isXL) level = 'XL'; else if (s1 >= 14 && (s2 >= 10 || cl >= 14)) level = 'L'; else if (s1 >= 10 && (s2 >= 6  || cl >= 8 )) level = 'M';
        const rawPx = rawW * rawH, pxScale = Math.sqrt(Math.max(1, rawPx) / (1280 * 720)), hiResN = clamp01((pxScale - 1.0) / 1.7), n1 = clamp01(s1 / 18.0), n2 = clamp01(s2 / 16.0), n3 = clamp01(cl / 24.0); let base = clamp01((0.58 * n1) + (0.28 * n2) + (0.24 * n3));
        let scale = 1.0, cap = 1.0, desatSat = 0.88, biasMix = 0.40, edgeDampMix = 0.33;
        if (level === 'S') { scale = 0.78; cap = 0.55; desatSat = 0.90; biasMix = 0.30; edgeDampMix = 0.38; } else if (level === 'M') { scale = 0.96; cap = 0.70; desatSat = 0.88; biasMix = 0.38; edgeDampMix = 0.33; } else if (level === 'L') { scale = 1.10; cap = 0.82; desatSat = 0.86; biasMix = 0.46; edgeDampMix = 0.28; } else { scale = 1.38; cap = 0.98; desatSat = 0.84; biasMix = 0.60; edgeDampMix = 0.22; }
        let amount = clamp01(base * scale); if (amount > cap) amount = cap; amount *= (1.0 - 0.25 * hiResN); if (rawPx >= 3840 * 2160) amount *= 0.80; if (isHdr) amount *= 0.92;
        return { amount, tapMode: ((rawPx >= (2560 * 1440) && amount < 0.80) || (amount < 0.12)) ? 1.0 : 0.0, desatSat, biasMix, edgeDampMix };
      }

      class WebGLPipeline {
        constructor() {
          this.canvas = null; this.gl = null; this.activeProgramKind = ''; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this._videoHidden = false; this._prevVideoOpacity = ''; this._prevVideoVisibility = ''; this.disabledUntil = 0; this._texW = 0; this._texH = 0; this._loopToken = 0; this._loopRunning = false; this._isGL2 = false; this._qMon = { lastT: 0, lastDropped: 0, dropRateEma: 0 }; this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0; this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; this.toneTexture = null; this._toneKey = ''; this._outputReady = false; this._timerId = 0; this._rvfcId = 0; this._rafId = 0; this._lastRawW = 0; this._lastRawH = 0; this._contextLostCount = 0;
          this._onContextLost = (e) => { e.preventDefault(); const now = performance.now(); this._contextLostCount = (this._contextLostCount || 0) + 1; this.disabledUntil = now + Math.min(30000, 3000 * Math.pow(1.5, this._contextLostCount)); this.active = false; this._loopToken++; this._loopRunning = false; if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; } try { if (this.canvas) this.canvas.style.opacity = '0'; } catch (_) {} try { const st = this.video ? getVState(this.video) : null; if (st && RUNTIME_GUARD.webglCooldown) st.webglDisabledUntil = now + 5000; } catch (_) {} try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} };
          this._onContextRestored = () => { try { this._loopToken++; this._loopRunning = false; if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; } if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; } if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') { try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {} this._rvfcId = 0; } if (this._postTaskAC) { this._postTaskAC.abort(); this._postTaskAC = null; } this.disposeGLResources({ keepCanvasListeners: true }); if (this.initGLResourcesOnExistingCanvas()) { if (this.video) { this.active = true; this._outputReady = false; this.canvas.style.opacity = '0'; this.startRenderLoop(); } } else { this.disabledUntil = performance.now() + 5000; } } catch (_) { this.disabledUntil = performance.now() + 5000; } };
        }
        ensureCanvas() { if (this.canvas) return; this.canvas = document.createElement('canvas'); this.canvas.style.cssText = `position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;display:block!important;pointer-events:none!important;margin:0!important;padding:0!important;contain:strict!important;will-change:transform,opacity!important;opacity:0!important;`; this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false }); this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, { passive: true }); }
        _bindProgramHandles(program, key) { const gl = this.gl; gl.useProgram(program); const handles = { program, uResolution: gl.getUniformLocation(program, 'uResolution'), uVideoTex: gl.getUniformLocation(program, 'uVideoTex'), uToneTex: gl.getUniformLocation(program, 'uToneTex'), uParams: gl.getUniformLocation(program, 'uParams'), uParams2: gl.getUniformLocation(program, 'uParams2'), uRGBGain: gl.getUniformLocation(program, 'uRGBGain'), uSharpParams: gl.getUniformLocation(program, 'uSharpParams'), aPosition: gl.getAttribLocation(program, 'aPosition'), aTexCoord: gl.getAttribLocation(program, 'aTexCoord') }; if (handles.uVideoTex) gl.uniform1i(handles.uVideoTex, 0); if (handles.uToneTex) gl.uniform1i(handles.uToneTex, 1); this[`handles_${key}`] = handles; }
        initGLResourcesOnExistingCanvas() {
          this.ensureCanvas(); let gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }); this._isGL2 = !!gl; if (!gl) gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }); if (!gl) return false; this.gl = gl;
          try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); } catch (_) {}
          const src = buildShaderSources(gl);
          try {
            const vs = compileShaderChecked(gl, gl.VERTEX_SHADER, src.vs), fsColor = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsColorOnly), fsSharp = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsSharpen);
            const programColor = linkProgramChecked(gl, vs, fsColor), programSharp = linkProgramChecked(gl, vs, fsSharp); gl.deleteShader(vs); gl.deleteShader(fsColor); gl.deleteShader(fsSharp);
            this._bindProgramHandles(programColor, 'color'); this._bindProgramHandles(programSharp, 'sharp'); this.activeProgramKind = '';
            const vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); const tCoords = new Float32Array([0,0, 1,0, 0,1, 1,1]);
            this.vBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); this.tBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.bufferData(gl.ARRAY_BUFFER, tCoords, gl.STATIC_DRAW);
            this.videoTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            this.toneTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            const id = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { const o = i * 4; id[o] = id[o+1] = id[o+2] = i; id[o+3] = 255; } gl.texImage2D(gl.TEXTURE_2D, 0, this._isGL2 ? gl.RGBA8 : gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, id);
            return true;
          } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
        }
        init() { return this.initGLResourcesOnExistingCanvas(); }
        attachToVideo(video) {
          if (!this.active && !this.init()) return false;
          this.video = video; this.originalParent = video.parentNode; this._videoHidden = false; this._outputReady = false; this.canvas.style.opacity = '0';
          if (this.originalParent) { const cs = window.getComputedStyle(this.originalParent); if (cs.position === 'static') { this._parentPrevPosition = this.originalParent.style.position || ''; this.originalParent.style.position = 'relative'; this._parentStylePatched = true; this._patchedParent = this.originalParent; } if (video.nextSibling) this.originalParent.insertBefore(this.canvas, video.nextSibling); else this.originalParent.appendChild(this.canvas); }
          if (this._styleObs) this._styleObs.disconnect(); this._styleObs = new MutationObserver(() => { this._styleDirty = true; }); try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
          try { video.addEventListener('transitionend', () => { this._styleDirty = true; }, { passive: true }); } catch (_) {}
          this._styleDirty = true; this.active = true; this.startRenderLoop(); return true;
        }
        updateParams(vVals) { this.vVals = vVals; }
        syncCanvasPresentationFromVideo(video, now) {
          if (!this.canvas || !video) return; if (!this._styleDirty && (now - this._lastStyleSyncT) < 250) return;
          const vs = window.getComputedStyle(video), cs = this.canvas.style;
          if (cs.objectFit !== vs.objectFit) cs.objectFit = vs.objectFit || 'contain'; if (cs.objectPosition !== vs.objectPosition) cs.objectPosition = vs.objectPosition;
          const tr = vs.transform, tro = vs.transformOrigin, nextTr = (tr && tr !== 'none') ? tr : ''; if (cs.transform !== nextTr) cs.transform = nextTr; if (cs.transformOrigin !== tro) cs.transformOrigin = tro;
          if (cs.borderRadius !== vs.borderRadius) cs.borderRadius = vs.borderRadius || ''; if (cs.clipPath !== vs.clipPath) cs.clipPath = vs.clipPath || ''; if (cs.webkitClipPath !== vs.webkitClipPath) cs.webkitClipPath = vs.webkitClipPath || ''; if (cs.mixBlendMode !== vs.mixBlendMode) cs.mixBlendMode = vs.mixBlendMode || ''; if (cs.isolation !== vs.isolation) cs.isolation = vs.isolation || '';
          const vz = vs.zIndex; let zi = '1'; if (vz && vz !== 'auto') { const n = parseInt(vz, 10); if (Number.isFinite(n)) { zi = String(Math.min(n + 1, 2147483646)); } } if (cs.zIndex !== zi) cs.zIndex = zi; this._styleDirty = false; this._lastStyleSyncT = now;
        }
        _updatePlaybackQuality(now) {
          const v = this.video; if (!v || typeof v.getVideoPlaybackQuality !== 'function') return; if (now - this._qMon.lastT < 1000) return;
          try { const q = v.getVideoPlaybackQuality(), dropped = q.droppedVideoFrames || 0; if (this._qMon.lastT > 0) { const dd = Math.max(0, dropped - this._qMon.lastDropped); this._qMon.dropRateEma = this._qMon.dropRateEma ? (this._qMon.dropRateEma * 0.8 + dd * 0.2) : dd; } this._qMon.lastDropped = dropped; this._qMon.lastT = now; if (this._qMon.dropRateEma > 2.5) { const st = getVState(v); if (st && RUNTIME_GUARD.webglCooldown) st.webglDisabledUntil = now + 8000; try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} } } catch (_) {}
        }
        render() {
          if (!this.active || !this.gl || !this.video || !this.vVals) return; const gl = this.gl, video = this.video, now = performance.now(); if (now < this.disabledUntil) return;
          const st = getVState(video); if (st.webglDisabledUntil && now < st.webglDisabledUntil) return; if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
          if (this.canvas.parentNode !== video.parentNode && video.parentNode) { this.originalParent = video.parentNode; const p = video.parentNode; if (video.nextSibling) p.insertBefore(this.canvas, video.nextSibling); else p.appendChild(this.canvas); }
          this.syncCanvasPresentationFromVideo(video, now); this._updatePlaybackQuality(now);
          let rawW = video.videoWidth, rawH = video.videoHeight; const dpr = Math.min(window.devicePixelRatio || 1, 2), displayW = video.clientWidth * dpr, displayH = video.clientHeight * dpr;
          const qs = window.__VSC_INTERNAL__?.App?.getQualityScale?.() || 1.0; const gpuTier = (qs > 0.9) ? 2160 : (qs > 0.7) ? 1440 : 1080;
          const MAX_W = Math.min(3840, Math.max(displayW, 640)), MAX_H = Math.min(gpuTier, Math.max(displayH, 360));
          let w = rawW, h = rawH; if (w > MAX_W || h > MAX_H) { const scale = Math.min(MAX_W / w, MAX_H / h); w = Math.round(w * scale); h = Math.round(h * scale); }
          const isHdr = VSC_MEDIA.isHdr(), prof = getSharpProfile(this.vVals, rawW, rawH, isHdr), useSharpen = prof.amount > 0.0, kind = useSharpen ? 'sharp' : 'color', H = useSharpen ? this.handles_sharp : this.handles_color;
          let programChanged = false; if (this.activeProgramKind !== kind) { this.activeProgramKind = kind; programChanged = true; gl.useProgram(H.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.enableVertexAttribArray(H.aPosition); gl.vertexAttribPointer(H.aPosition, 2, gl.FLOAT, false, 0, 0); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.enableVertexAttribArray(H.aTexCoord); gl.vertexAttribPointer(H.aTexCoord, 2, gl.FLOAT, false, 0, 0); }
          const resized = (this.canvas.width !== w || this.canvas.height !== h); if (resized) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
          if ((resized || programChanged || this._lastRawW !== rawW || this._lastRawH !== rawH) && H.uResolution) { gl.uniform2f(H.uResolution, rawW, rawH); this._lastRawW = rawW; this._lastRawH = rawH; }
          const rs = this.vVals._rs ?? 1, gs = this.vVals._gs ?? 1, bs = this.vVals._bs ?? 1; if (H.uParams) gl.uniform4f(H.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);
          const hiReduce = isHdr ? 0.82 : 0.88; if (H.uParams2) gl.uniform4f(H.uParams2, this.vVals.bright || 0.0, useSharpen ? prof.amount : 0.0, prof.tapMode, hiReduce);
          if (H.uRGBGain) gl.uniform3f(H.uRGBGain, rs, gs, bs); if (useSharpen && H.uSharpParams) gl.uniform3f(H.uSharpParams, prof.desatSat, prof.biasMix, prof.edgeDampMix);
          const toe = this.vVals.toe || 0, mid = this.vVals.mid || 0, shoulder = this.vVals.shoulder || 0, toneKey = `${tq(toe, 0.2)}|${tq(mid, 0.02)}|${tq(shoulder, 0.2)}|${tq(this.vVals.gain || 1, 0.06)}`;
          if (this._toneKey !== toneKey && this.toneTexture) { this._toneKey = toneKey; const lut = buildToneLUT256(toe, mid, shoulder, this.vVals.gain || 1.0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut); }
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
          try {
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            if (this._isGL2) {
              if (this._texW !== rawW || this._texH !== rawH) { this._texW = rawW; this._texH = rawH; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rawW, rawH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rawW, rawH, gl.RGBA, gl.UNSIGNED_BYTE, video);
            } else {
              if (this._texW !== rawW || this._texH !== rawH) {
                this._texW = rawW; this._texH = rawH; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
              } else {
                try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (_) { this._texW = rawW; this._texH = rawH; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); }
              }
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); st.webglFailCount = 0;
            if (!this._outputReady) { this._outputReady = true; this.canvas.style.opacity = '1'; if (!this._videoHidden) { this._prevVideoOpacity = video.style.opacity; this._prevVideoVisibility = video.style.visibility; video.style.setProperty('opacity', '0.001', 'important'); this._videoHidden = true; } }
          } catch (err) {
            st.webglFailCount = (st.webglFailCount || 0) + 1; if (CONFIG.DEBUG) log.warn('WebGL render failure:', err);
            const msg = String(err?.message || err || ''), looksTaint = /SecurityError|cross.origin|cross-origin|taint|insecure|Tainted|origin/i.test(msg);
            if (st.webglFailCount >= RUNTIME_GUARD.webgl.failThreshold) { st.webglFailCount = 0; if (looksTaint) { st.webglTainted = true; log.warn('WebGL tainted/CORS-like failure → fallback to SVG'); } else { if (st) st.webglDisabledUntil = now + RUNTIME_GUARD.webgl.failCooldownMs; log.warn('WebGL transient failure → cooldown then retry'); } try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }
          }
        }
        startRenderLoop() { if (this._loopRunning) return; this._loopRunning = true; const token = ++this._loopToken; const loopFn = (now, meta) => { if (token !== this._loopToken || !this.active || !this.video) { this._loopRunning = false; return; } this.render(); this.scheduleNextFrame(loopFn); }; this.scheduleNextFrame(loopFn); }
        scheduleNextFrame(loopFn) {
          const pausedOrHidden = !!(document.hidden || this.video?.paused); if (pausedOrHidden) { this._timerId = setTimeout(() => { this._timerId = 0; loopFn(performance.now(), null); }, 220); return; }
          if (this.video && typeof this.video.requestVideoFrameCallback === 'function') { this._rvfcId = this.video.requestVideoFrameCallback(loopFn); return; }
          if (globalThis.scheduler?.postTask) { if (!this._postTaskAC) this._postTaskAC = new AbortController(); globalThis.scheduler.postTask(() => loopFn(performance.now(), null), { priority: 'user-visible', signal: this._postTaskAC.signal }).catch(() => { this._rafId = requestAnimationFrame(loopFn); }); return; }
          this._rafId = requestAnimationFrame(loopFn);
        }
        disposeGLResources(opts = {}) {
          const { keepCanvasListeners = false } = opts; const gl = this.gl;
          if (gl) { try { if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; } if (this.toneTexture) { gl.deleteTexture(this.toneTexture); this.toneTexture = null; } if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; } if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; } if (this.handles_color?.program) gl.deleteProgram(this.handles_color.program); if (this.handles_sharp?.program) gl.deleteProgram(this.handles_sharp.program); } catch (_) {} }
          if (!keepCanvasListeners && this.canvas) { try { this.canvas.removeEventListener('webglcontextlost', this._onContextLost); this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored); } catch (_) {} }
          this.gl = null; this._texW = 0; this._texH = 0; this.activeProgramKind = '';
        }
        shutdown() {
          this.active = false; this._loopToken++; this._loopRunning = false; if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; } if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
          if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') { try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {} this._rvfcId = 0; }
          if (this._postTaskAC) { this._postTaskAC.abort(); this._postTaskAC = null; } if (this._styleObs) { this._styleObs.disconnect(); this._styleObs = null; }
          if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; }
          try { if (this.canvas && this.canvas.parentNode) { this.canvas.remove(); } } catch (_) {}
          if (this._parentStylePatched && this._patchedParent) { try { this._patchedParent.style.position = this._parentPrevPosition; } catch (_) {} this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; }
          this.disposeGLResources();
        }
      }
      return { apply: (el, vVals) => { let pipe = pipelines.get(el); if (!pipe) { pipe = new WebGLPipeline(); pipelines.set(el, pipe); } if (!pipe.active || pipe.video !== el || !pipe.gl) { if (!pipe.attachToVideo(el)) { pipelines.delete(el); return false; } } pipe.updateParams(vVals); return true; }, clear: (el) => { const pipe = pipelines.get(el); if (pipe) { pipe.shutdown(); pipelines.delete(el); } } };
    }

    function bindElementDrag(el, onMove, onEnd) { const ac = new AbortController(); const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); }; const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); }; el.addEventListener('pointermove', move, { passive: false, signal: ac.signal }); el.addEventListener('pointerup', up, { signal: ac.signal }); el.addEventListener('pointercancel', up, { signal: ac.signal }); return () => { ac.abort(); }; }

    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null; let hasUserDraggedUI = false;
      const uiWakeCtrl = new AbortController(), sub = (k, fn) => { const cb = fn; sm.sub(k, cb); return cb; };
      const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
      const allowUiInThisDoc = () => { if (registry.videos.size > 0) return true; return !!document.querySelector('video, object, embed'); };
      function setAndHint(path, value) { const prev = sm.get(path), changed = !Object.is(prev, value); if (changed) sm.set(path, value); (changed ? ApplyReq.hard() : ApplyReq.soft()); }
      const getUiRoot = () => { const fs = document.fullscreenElement || null; if (fs) { if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body; if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; return fs; } return document.documentElement || document.body; };
      function bindReactive(btn, paths, apply, sm, sub) { const pathArr = Array.isArray(paths) ? paths : [paths]; const sync = () => { if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); }; pathArr.forEach(p => sub(p, sync)); sync(); return sync; }
      function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
        const addBtn = (text, value) => { const b = h('button', { class: 'pbtn', style: 'flex:1' }, text); b.onclick = (e) => { e.stopPropagation(); const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) setAndHint(key, offValue); else setAndHint(key, value); }; bindReactive(b, key, (el, v) => el.classList.toggle('active', v === value), sm, sub); row.append(b); };
        for (const it of items) addBtn(it.text, it.value); if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) addBtn('OFF', offValue); return row;
      }
      function renderShadowBandMaskRow({ label = '블랙', key = P.V_SHADOW_MASK }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label) ), items = [ { text: '외암', bit: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' }, { text: '중암', bit: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' }, { text: '심암', bit: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' } ];
        for (const it of items) { const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title }, it.text); b.onclick = (e) => { e.stopPropagation(); sm.set(key, ShadowMask.toggle(sm.get(key), it.bit)); ApplyReq.hard(); }; bindReactive(b, key, (el, v) => el.classList.toggle('active', ShadowMask.has(v, it.bit)), sm, sub); row.append(b); }
        const off = h('button', { class: 'pbtn', style: 'flex:0.9' }, 'OFF'); off.onclick = (e) => { e.stopPropagation(); sm.set(key, 0); ApplyReq.hard(); }; bindReactive(off, key, (el, v) => el.classList.toggle('active', (Number(v) | 0) === 0), sm, sub); row.append(off); return row;
      }
      const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));
      const clampPanelIntoViewport = () => {
        try {
          if (!container) return; const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
          if (!hasUserDraggedUI) { mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = ''; return; }
          const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
          const vv = window.visualViewport, vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0), vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
          const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0, offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0; if (!vw || !vh) return;
          const w = r.width || 300, panH = r.height || 400, left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8)), top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
          mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
        } catch (_) {}
      };
      const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root || !vv) return; root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
      syncVVVars(); try { const vv = window.visualViewport; if (vv) { vv.addEventListener('resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal }); vv.addEventListener('scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal }); } } catch (_) {}
      const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport); window.addEventListener('resize', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal }); window.addEventListener('orientationchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal }); document.addEventListener('fullscreenchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });
      const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');
      const build = () => {
        if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
        const style = `*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:rgba(25,25,25,.96);backdrop-filter:blur(12px);color:#eee;padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:auto;bottom:max(12px,calc(env(safe-area-inset-bottom,0px) + 12px));right:max(12px,calc(env(safe-area-inset-right,0px) + 12px));left:max(12px,calc(env(safe-area-inset-left,0px) + 12px));transform:none;width:auto;max-height:70vh;padding:12px;border-radius:14px}.prow{flex-wrap:wrap}.btn,.pbtn{min-height:38px;font-size:12px}}.header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:1px solid #666;background:#222;color:#eee;padding:10px 0;border-radius:12px;cursor:pointer;font-weight:700}.btn.active{background:#3498db;border-color:#3498db}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:1px solid #666;background:#222;color:#eee;padding:10px 6px;border-radius:12px;cursor:pointer;font-weight:700}.pbtn.active{background:#3498db;border-color:#3498db}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
        const styleEl = document.createElement('style'); styleEl.textContent = style; shadow.appendChild(styleEl);
        const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');
        const rmBtn = h('button', { id: 'rm-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_RENDER_MODE, sm.get(P.APP_RENDER_MODE) === 'webgl' ? 'svg' : 'webgl'); } });
        bindReactive(rmBtn, P.APP_RENDER_MODE, (el, v) => { el.textContent = `🎨 ${v === 'webgl' ? 'WebGL' : 'SVG'}`; el.style.color = v === 'webgl' ? '#ffaa00' : '#88ccff'; el.style.borderColor = v === 'webgl' ? '#ffaa00' : '#88ccff'; }, sm, sub);

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.A_EN, !sm.get(P.A_EN)); } }, '🔊 Brickwall (EQ+Dyn)');
        bindReactive(boostBtn, P.A_EN, (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const pipBtn = h('button', { class: 'btn', onclick: async (e) => { e.stopPropagation(); const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');
        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); const nextEn = !sm.get(P.APP_ZOOM_EN); setAndHint(P.APP_ZOOM_EN, nextEn); const zm = window.__VSC_INTERNAL__.ZoomManager; const v = window.__VSC_APP__?.getActiveVideo(); if (zm && v) { if (zm.isZoomed(v)) { zm.resetZoom(v); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); } } } }, '🔍 줌 제어');
        bindReactive(zoomBtn, P.APP_ZOOM_EN, (el, v) => el.classList.toggle('active', !!v), sm, sub);
        const autoSceneBtn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); } }, '✨ Auto Scene');
        bindReactive(autoSceneBtn, P.APP_AUTO_SCENE, (el, v) => el.classList.toggle('active', !!v), sm, sub);
        const pwrBtn = h('button', { id: 'pwr-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
        bindReactive(pwrBtn, P.APP_ACT, (el, v) => el.style.color = v ? '#2ecc71' : '#e74c3c', sm, sub);

        const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
        advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
        bindReactive(advToggleBtn, P.APP_ADV, (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

        const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
          renderShadowBandMaskRow({ label: '블랙', key: P.V_SHADOW_MASK }),
          renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
          renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }),
          h('hr'),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '오디오'));
            const mb = h('button', { class: 'pbtn', style: 'flex:1' }, '🎚️ 멀티밴드');
            mb.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_MULTIBAND, !sm.get(P.A_MULTIBAND)); };
            bindReactive(mb, P.A_MULTIBAND, (el, v) => el.classList.toggle('active', !!v), sm, sub);
            const lf = h('button', { class: 'pbtn', style: 'flex:1' }, '📊 LUFS 정규화');
            lf.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_LUFS, !sm.get(P.A_LUFS)); };
            bindReactive(lf, P.A_LUFS, (el, v) => el.classList.toggle('active', !!v), sm, sub);
            r.append(mb, lf);
            return r;
          })(),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'width:35px;' }, ''));
            const dl = h('button', { class: 'pbtn', style: 'flex:1' }, '🗣️ 대화 감지(AI)');
            dl.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE)); };
            bindReactive(dl, P.A_DIALOGUE, (el, v) => el.classList.toggle('active', !!v), sm, sub);
            r.append(dl);
            return r;
          })()
        ]);

        bindReactive(advContainer, P.APP_ADV, (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, autoSceneBtn ]),
          h('div', { class: 'prow' }, [ pipBtn, zoomBtn ]),
          h('div', { class: 'prow' }, [ boostBtn ]),
          h('div', { class: 'prow' }, [
            h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
            pwrBtn,
            h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard(); } }, '↺ 리셋')
          ]),
          renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
          advToggleBtn,
          advContainer,
          h('hr'),
          h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
            const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
            b.onclick = (e) => { e.stopPropagation(); setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); };
            bindReactive(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => { el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01); }, sm, sub);
            return b;
          }))
        ]);

        const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]);
        shadow.append(mainPanel);
        let stopDrag = null;
        const startPanelDrag = (e) => {
          const pt = (e && e.touches && e.touches[0]) ? e.touches[0] : e; if (!pt) return;
          if (e.target && e.target.tagName === 'BUTTON') return;
          if (e.cancelable) e.preventDefault();
          stopDrag?.();
          hasUserDraggedUI = true;
          let startX = pt.clientX, startY = pt.clientY;
          const rect = mainPanel.getBoundingClientRect();
          mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`;
          try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}
          stopDrag = bindElementDrag(dragHandle, (ev) => {
            const mv = (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev; if (!mv) return;
            const dx = mv.clientX - startX, dy = mv.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx)), nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
            mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`;
          }, () => { stopDrag = null; });
        };
        dragHandle.addEventListener('pointerdown', startPanelDrag);
        dragHandle.addEventListener('dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
        container = host;
        getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
        if (gearHost) { gearHost.style.display = 'block'; return; }
        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${CONFIG.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
        const styleEl = document.createElement('style'); styleEl.textContent = style; shadow.appendChild(styleEl);
        let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear' }, '⚙');
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer);
          const inFs = !!document.fullscreenElement; if (inFs || CONFIG.IS_MOBILE) return;
          fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.15'; }, 2500);
        };
        wakeGear = wake;
        window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal });
        window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal });
        bootWakeTimer = setTimeout(wake, 2000);
        const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return;
          dragThresholdMet = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
          stopDrag = bindElementDrag(gearBtn, (ev) => {
            const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
            if (Math.abs(currentY - startY) > 10) {
              if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; }
              if (ev.cancelable) ev.preventDefault();
            }
            if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
        };
        gearBtn.addEventListener('pointerdown', handleGearDrag);
        let lastToggle = 0, lastTouchAt = 0;
        const onGearActivate = (e) => {
          if (dragThresholdMet) { try { if (e && e.cancelable) e.preventDefault(); } catch (_) {} return; }
          const now = performance.now();
          if (now - lastToggle < 300) { try { if (e && e.cancelable) e.preventDefault(); } catch (_) {} return; }
          lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        };
        gearBtn.addEventListener('touchend', (e) => { lastTouchAt = performance.now(); try { if (e && e.cancelable) e.preventDefault(); } catch (_) {} try { e.stopPropagation?.(); } catch (_) {} onGearActivate(e); }, { passive: false });
        gearBtn.addEventListener('click', (e) => { const now = performance.now(); if (now - lastTouchAt < 800) { try { if (e && e.cancelable) e.preventDefault(); } catch (_) {} try { e.stopPropagation?.(); } catch (_) {} return; } onGearActivate(e); }, { passive: false });
        const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
        sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
      };

      const mount = () => { const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
      const ensure = () => {
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        ensureGear();
        if (sm.get(P.APP_UI)) {
          build(); const mainPanel = getMainPanel();
          if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); }
        } else {
          const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible');
        }
        mount(); try { wakeGear?.(); } catch (_) {}
      };
      onPageReady(() => { try { ensure(); ApplyReq.hard(); } catch (_) {} });
      window.__VSC_UI_Ensure = ensure; if (CONFIG.DEBUG) window.__VSC_UI_Ensure_DEBUG = ensure;
      return { ensure, destroy: () => { try { uiWakeCtrl.abort(); } catch (_) {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
    }

    function getRateState(v) { const st = getVState(v); if (!st.rateState) { st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0 }; } return st.rateState; }
    function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
    const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el, 220); el.playbackRate = nextRate; st.orig = null; } catch (_) {} };

    function createBackendAdapter(Filters, FiltersGL) {
      return {
        apply(video, mode, vVals) {
          const st = getVState(video), now = performance.now(), webglAllowed = (mode === 'webgl' && !st.webglTainted && !(st.webglDisabledUntil && now < st.webglDisabledUntil)), effectiveMode = webglAllowed ? 'webgl' : 'svg';
          if (st.webglTainted && st.fxBackend === 'webgl') { FiltersGL.clear(video); st.fxBackend = null; }
          if (effectiveMode === 'webgl') {
              if (st.fxBackend === 'svg') Filters.clear(video);
              if (!FiltersGL.apply(video, vVals)) { if (st) st.webglDisabledUntil = performance.now() + RUNTIME_GUARD.webgl.failCooldownMs; FiltersGL.clear(video); Filters.applyUrl(video, Filters.prepareCached(video, vVals)); st.fxBackend = 'svg'; return; }
              st.fxBackend = 'webgl';
          } else {
              if (st.fxBackend === 'webgl') FiltersGL.clear(video);
              Filters.applyUrl(video, Filters.prepareCached(video, vVals)); st.fxBackend = 'svg';
          }
        },
        clear(video) { const st = getVState(video); if (st.fxBackend === 'svg') Filters.clear(video); else if (st.fxBackend === 'webgl') FiltersGL.clear(video); st.fxBackend = null; }
      };
    }

    function ensureMobileInlinePlaybackHints(video) { if (!video || !CONFIG.IS_MOBILE) return; try { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); } catch (_) {} }
    const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} }; const onEvictVideo = (v) => { if (window.__VSC_INTERNAL__.Adapter) window.__VSC_INTERNAL__.Adapter.clear(v); restoreRateOne(v); };
    const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };

    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v); if (st.bound) return; st.bound = true; ensureMobileInlinePlaybackHints(v);
      const softResetTransientFlags = () => { st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.rectEpoch = -1; st.webglFailCount = 0; st.webglDisabledUntil = 0; st.webglTainted = false; if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; } ApplyReq.hard(); };
      const videoEvents = [ ['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return; const refs = window.__VSC_INTERNAL__, app = refs?.App, store = refs?.Store; if (!store) return; const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return; const activeVideo = app?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); } }] ];
      for (const [ev, fn] of videoEvents) on(v, ev, fn, { passive: true });
    };

    let __lastApplySig = '';
    function clearVideoRuntimeState(el, Adapter, ApplyReq) { const st = getVState(el); Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); bindVideoOnce(el, ApplyReq); }
    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el), rSt = getRateState(el); if (rSt.orig == null) rSt.orig = el.playbackRate;
      if (!Object.is(st.desiredRate, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        rSt._setAttempts = (rSt._setAttempts || 0) + 1;
        if (rSt._setAttempts > 5) {
          const elapsed = performance.now() - (rSt._firstAttemptT || 0);
          if (elapsed < 2000) { log.debug('Rate override blocked by site player'); return; }
          rSt._setAttempts = 0; rSt._firstAttemptT = performance.now();
        }
        if (rSt._setAttempts === 1) rSt._firstAttemptT = performance.now();
        st.desiredRate = desiredRate; markInternalRateChange(el, 160); try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }
    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq }) {
      const candidates = new Set(); for (const v of dirtyVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.videos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.rateVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of applySet) if (v?.tagName === 'VIDEO') candidates.add(v);
      for (const el of candidates) {
        if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el), visible = (st.visible !== false), shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));
        if (!shouldApply) { clearVideoRuntimeState(el, Adapter, ApplyReq); continue; }
        if (videoFxOn) { Adapter.apply(el, rMode, vVals); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
        if (pbActive) applyPlaybackRate(el, desiredRate); else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
        bindVideoOnce(el, ApplyReq);
      }
    }

    function createVideoParamsMemo(Store, P) {
      const getDetailLevel = (presetKey) => { const k = String(presetKey || 'off').toUpperCase().trim(); if (k === 'XL') return 'xl'; if (k === 'L') return 'l'; if (k === 'M') return 'm'; if (k === 'S') return 's'; return 'off'; };
      return {
        get(vfUser, rMode, activeVideo) {
          const detailP = PRESETS.detail[vfUser.presetS || 'off'], gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'], out = { sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0, gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, satF: 1.0, temp: 0, gain: 1.0, mid: 0, toe: 0, shoulder: 0, __qos: 'full' }, sMask = vfUser.shadowBandMask || 0;
          if (sMask > 0) { if ((sMask & SHADOW_BAND.DEEP) !== 0) { out.toe += 3.5; out.gamma -= 0.04; } if ((sMask & SHADOW_BAND.MID) !== 0) { out.toe += 2.0; out.mid -= 0.08; } if ((sMask & SHADOW_BAND.OUTER) !== 0) { out.mid -= 0.15; out.gamma -= 0.02; } }
          const brStep = vfUser.brightStepLevel || 0; if (brStep > 0) { out.bright += brStep * 4.0; out.mid += brStep * 0.12; out.gamma *= (1.0 + brStep * 0.03); }
          const { rs, gs, bs } = tempToRgbGain(out.temp); out._rs = rs; out._gs = gs; out._bs = bs; out.__detailLevel = getDetailLevel(vfUser.presetS); return out;
        }
      };
    }
    function isNeutralVideoParams(p) { return (p.sharp === 0 && p.sharp2 === 0 && p.clarity === 0 && p.gamma === 1.0 && p.bright === 0 && p.contrast === 1.0 && p.satF === 1.0 && p.temp === 0 && p.gain === 1.0 && p.mid === 0 && p.toe === 0 && p.shoulder === 0); }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); }); Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });
      let __activeTarget = null, __lastAudioTarget = null, __lastAudioWant = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
      const videoParamsMemo = createVideoParamsMemo(Store, P), audioUpdateThrottled = createDebounced(() => Audio.update(), 120);

      if (typeof PerformanceObserver !== 'undefined') { try { const po = new PerformanceObserver((list) => { for (const entry of list.getEntries()) { if (entry.duration > 100) { qualityScale = Math.max(0.5, qualityScale - 0.15); Scheduler.request(false); } } }); po.observe({ entryTypes: ['longtask'] }); __globalSig.addEventListener('abort', () => po.disconnect(), { once: true }); } catch (_) {} }
      function updateQualityScale(v) {
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale; const now = performance.now(); if (now - lastQCheck < 2000) return qualityScale; lastQCheck = now;
        try { const q = v.getVideoPlaybackQuality(), dropped = Number(q.droppedVideoFrames || 0), total = Number(q.totalVideoFrames || 0), dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0)), dTotal = Math.max(0, total - (__lastQSample.total || 0)); __lastQSample = { dropped, total }; const denom = (dTotal > 0) ? dTotal : total, numer = (dTotal > 0) ? dDropped : dropped, ratio = denom > 0 ? (numer / denom) : 0; qualityScale = qualityScale * 0.8 + (ratio > 0.12 ? 0.70 : (ratio > 0.06 ? 0.85 : 1.0)) * 0.2; } catch (_) {} return qualityScale;
      }

      Scheduler.registerApply((force) => {
        try {
          const active = !!Store.getCatRef('app').active; if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }
          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev; if (!force && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }
          const vf0 = Store.getCatRef('video'), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos, wantAudioNow = !!(Store.get(P.A_EN) && active), rMode = Store.get(P.APP_RENDER_MODE) || 'svg';
          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__lastUserPt, wantAudioNow); let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; } if (nextTarget !== __activeTarget) __activeTarget = nextTarget;
          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null; if (nextAudioTarget !== __lastAudioTarget || wantAudioNow !== __lastAudioWant) { Audio.setTarget(nextAudioTarget); Audio.update(); __lastAudioTarget = nextAudioTarget; __lastAudioWant = wantAudioNow; } else audioUpdateThrottled();

          let vValsEffective = videoParamsMemo.get(vf0, rMode, __activeTarget);
          const autoScene = window.__VSC_INTERNAL__?.AutoScene;
          if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
            const mods = autoScene.getMods();
            if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
              vValsEffective = { ...vValsEffective };
              const uBr = vValsEffective.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
              vValsEffective.gain = uBr * (1.0 + (mods.br - 1.0) * aSF); vValsEffective.contrast = (vValsEffective.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF); vValsEffective.satF = (vValsEffective.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
              const userSharpTotal = (vValsEffective.sharp || 0) + (vValsEffective.sharp2 || 0) + (vValsEffective.clarity || 0), sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5), effectiveSharpScale = 1.0 + (mods.sharpScale - 1.0) * sharpASF;
              vValsEffective.sharp = (vValsEffective.sharp || 0) * effectiveSharpScale; vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * effectiveSharpScale; vValsEffective.clarity = (vValsEffective.clarity || 0) * effectiveSharpScale;
            }
          }
          const qs = updateQualityScale(__activeTarget);
          if (qs < 0.95) { vValsEffective = { ...vValsEffective }; const qSharp = Math.sqrt(qs); vValsEffective.sharp = (vValsEffective.sharp || 0) * qSharp; vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * qSharp; vValsEffective.clarity = (vValsEffective.clarity || 0) * qSharp; vValsEffective.__qos = 'fast'; } else vValsEffective.__qos = 'full';

          const videoFxOn = !isNeutralVideoParams(vValsEffective), applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), applySet = new Set();
          if (applyToAllVisibleVideos) { for (const v of visible.videos) applySet.add(v); } else if (__activeTarget) applySet.add(__activeTarget);
          const desiredRate = Store.get(P.PB_RATE), pbActive = active && !!Store.get(P.PB_EN), sig = `${sRev}|${getElemId(__activeTarget)}|${rMode}|${pbActive ? 1 : 0}`;
          if (!force && vidsDirty.size === 0 && sig === __lastApplySig) return; __lastApplySig = sig;
          reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) { log.warn('apply crashed:', e); }
      });

      let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
      const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; }; Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick(); Scheduler.request(true);
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, getQualityScale() { return qualityScale; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { Audio.setTarget(null); Audio.destroy?.(); } catch (_) {} try { __globalHooksAC.abort(); } catch (_) {} } });
    }

    const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
    window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    window.addEventListener('message', (e) => {
      if (!e.data || !e.data.__vsc_sync || e.data.token !== VSC_SYNC_TOKEN) return;
      try { const isTop = (window.self === window.top); if (!isTop && e.origin !== location.origin && e.origin !== 'null') return; } catch (_) {}
      if (e.data.batch) { for (const item of e.data.batch) { if (Object.values(P).includes(item.p) && Store.get(item.p) !== item.val) Store.set(item.p, item.val); } } else if (e.data.p) { if (e.data.p === P.APP_UI) return; if (Object.values(P).includes(e.data.p) && Store.get(e.data.p) !== e.data.val) Store.set(e.data.p, e.data.val); }
    });

    function bindNormalizer(keys, schema) { const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); }; keys.forEach(k => Store.sub(k, run)); run(); }
    bindNormalizer([P.APP_RENDER_MODE, P.APP_APPLY_ALL, P.APP_ZOOM_EN, P.APP_AUTO_SCENE, P.APP_ADV], APP_SCHEMA); bindNormalizer([P.V_PRE_S, P.V_PRE_B, P.V_SHADOW_MASK, P.V_BRIGHT_STEP], VIDEO_SCHEMA); bindNormalizer([P.A_EN, P.A_BST, P.A_MULTIBAND, P.A_LUFS, P.A_DIALOGUE, P.PB_EN, P.PB_RATE], AUDIO_PLAYBACK_SCHEMA);

    const Registry = createRegistry(Scheduler), Targeting = createTargeting();
    initSpaUrlDetector(createDebounced(() => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} }, PERF_POLICY.registry.spaRescanDebounceMs));

    onPageReady(() => {
      (function ensureRegistryAfterBodyReady() {
        let ran = false; const runOnce = () => { if (ran) return; ran = true; try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} };
        if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} onDoc('DOMContentLoaded', runOnce, { once: true });
      })();

      const AutoScene = createAutoSceneManager(Store, P, Scheduler); window.__VSC_INTERNAL__.AutoScene = AutoScene;
      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FULL: 3840 * 2160, SVG_MAX_PIX_FAST: 3840 * 2160 }), FiltersGL = createFiltersWebGL(Utils), Adapter = createBackendAdapter(Filters, FiltersGL); window.__VSC_INTERNAL__.Adapter = Adapter;
      const Audio = createAudio(Store); let ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager;
      const UI = createUI(Store, Registry, ApplyReq, Utils);

      if (typeof GM_registerMenuCommand === 'function') {
        try {
          GM_registerMenuCommand('전체 비디오 적용 토글 (ON/OFF)', () => { Store.set(P.APP_APPLY_ALL, !Store.get(P.APP_APPLY_ALL)); ApplyReq.hard(); });
          GM_registerMenuCommand('Ambient Glow 숨김 토글 (선택/방어)', () => { setHideAmbientGlow(!document.getElementById('vsc-hide-ambient-style')); });
        } catch (_) {}
      }

      let __vscLastUserSignalT = 0; window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
      function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} }
      onWin('pointerdown', (e) => { updateLastUserPt(e.clientX, e.clientY, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('wheel', (e) => { updateLastUserPt(Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
      onWin('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); });
      onWin('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true });

      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__; AutoScene.start();

      onWin('keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); try { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); } catch (_) {} return; }
        if (e.altKey && e.shiftKey && e.code === 'KeyP') { const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v); }
      }, { capture: true });

      onDoc('visibilitychange', () => { try { if (document.visibilityState === 'visible') window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {} }, { passive: true });
      watchIframes();
    });
  }

  VSC_MAIN();
})();
