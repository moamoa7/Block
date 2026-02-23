// ==UserScript==
// @name        Video_Control (v159.7.1_Quality_Refined)
// @namespace   https://github.com/
// @version     159.7.1
// @description Video Control: WebGL/SVG High-Quality Filters. Added Threshold Gating, Adaptive Saturation, and Safe Tone Clamping.
// @match       *://*/*
// @exclude     *://*.google.com/recaptcha/*
// @exclude     *://*.hcaptcha.com/*
// @exclude     *://*.arkoselabs.com/*
// @exclude     *://accounts.google.com/*
// @exclude     *://*.stripe.com/*
// @exclude     *://*.paypal.com/*
// @exclude     *://challenges.cloudflare.com/*
// @exclude     *://*.cloudflare.com/cdn-cgi/*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com') || location.protocol === 'about:' || location.href === 'about:blank') return;
  const VSC_BOOT_KEY = '__VSC_BOOT_LOCK__';
  if (window[VSC_BOOT_KEY]) return;
  try { Object.defineProperty(window, VSC_BOOT_KEY, { value: true, writable: false }); } catch (e) { window[VSC_BOOT_KEY] = true; }

  let VSC_POLICY = null;
  try {
    VSC_POLICY = window.trustedTypes?.createPolicy?.('VSC_Trusted_Policy', {
      createHTML: s => s, createScript: s => s, createScriptURL: s => s
    }) || null;
  } catch (_) {
    VSC_POLICY = null;
  }

  window.__VSC_INTERNAL__ ||= {};
  let __vscClearVideoFilter = null, __vscClearVideoFilterGL = null, __vscUserSignalRev = 0;
  function vscSignal(payload) { try { window.__VSC_INTERNAL__?.Bus?.signal?.(payload); } catch (_) {} }
  function isEditableTarget(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); }

  const __globalHooksAC = new AbortController(), __globalSig = __globalHooksAC.signal;
  function waitForVisibility() {
    if (document.visibilityState === 'visible') return Promise.resolve();
    return new Promise(resolve => {
      const onVisibility = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisibility); resolve(); } };
      document.addEventListener('visibilitychange', onVisibility);
    });
  }

  const EXPERIMENTAL = Object.freeze({ APPLY_ALL_VISIBLE_VIDEOS: false, EXTRA_APPLY_TOPK: 2 });

  function detectMobile() { try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {} return /Mobi|Android|iPhone/i.test(navigator.userAgent); }
  function detectLowEnd() { const mem = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : 4; const cores = Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4; const saveData = !!navigator.connection?.saveData; return mem < 4 || cores <= 4 || saveData; }

  const __IS_LOW_END = detectLowEnd();
  const CONFIG = Object.freeze({ VERSION: "v159.7.1", IS_MOBILE: detectMobile(), IS_LOW_END: __IS_LOW_END, TOUCHED_MAX: __IS_LOW_END ? 60 : 140, VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: false });

  const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
  const log = { error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args), warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args), info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args), debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args) };

  const videoStateMap = new WeakMap();
  function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = { visible: false, rect: null, ir: 0, bound: false, rateState: null, tainted: false, audioFail: false, applied: false, desiredRate: undefined, lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false, webglFailCount: 0, webglDisabledUntil: 0 }; videoStateMap.set(v, st); } return st; }

  const ENABLE_UI = true;

  const PRESETS = Object.freeze({
    tone: { redSkin: { label: '피부', toe: 0.80, shoulder: 0.42, mid: 0.22, con: 1.04, sat: 1.05, br: 0.55, tmp: 0.85 }, gvfFilm: { label: '필름', toe: 0.26, shoulder: 0.33, mid: 0.04, con: 1.07, sat: 1.06, br: 0.55, tmp: 1.10 }, gvfAnime: { label: '애니', toe: 0.0, shoulder: 0.10, mid: 0.10, con: 1.10, sat: 1.15, br: 1.55, tmp: 0.0 }, gvfGaming: { label: '게임', toe: 0.0, shoulder: 0.06, mid: 0.02, con: 1.10, sat: 1.07, br: 0.70, tmp: 0.0 }, gvfVibrant: { label: '활력', toe: 0.0, shoulder: 0.06, mid: 0.02, con: 1.04, sat: 1.24, br: 0.10, tmp: 0.0 } },
    detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 5, sharp2Add: 3, clarityAdd: 4 }, M: { sharpAdd: 9, sharp2Add: 6, clarityAdd: 7 }, L: { sharpAdd: 15, sharp2Add: 10, clarityAdd: 10 }, XL: { sharpAdd: 21, sharp2Add: 16, clarityAdd: 12 } },
    grade: { brOFF: { gammaF: 1.00, brightAdd: 0, conF: 1.00, satF: 1.00, tempAdd: 0 }, S: { gammaF: 1.00, brightAdd: 2, conF: 1.00, satF: 1.00, tempAdd: 0 }, M: { gammaF: 1.08, brightAdd: 4, conF: 1.00, satF: 1.00, tempAdd: 0 }, L: { gammaF: 1.16, brightAdd: 6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DS: { gammaF: 1.00, brightAdd: 3.6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DM: { gammaF: 1.10, brightAdd: 7.2, conF: 1.00, satF: 1.00, tempAdd: 0 }, DL: { gammaF: 1.22, brightAdd: 10.8, conF: 1.00, satF: 1.00, tempAdd: 0 } }
  });

  const DEFAULTS = { video: { presetS: 'off', presetB: 'brOFF', presetMix: 0.90, tonePreset: 'off', toneStrength: 0.80, dither: 0, temp: -15 }, audio: { enabled: false, boost: 6 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: EXPERIMENTAL.APPLY_ALL_VISIBLE_VIDEOS, extraTopK: EXPERIMENTAL.EXTRA_APPLY_TOPK, renderMode: 'svg' } };
  const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_EXTRA_TOPK: 'app.extraTopK', APP_RENDER_MODE: 'app.renderMode', V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', V_DITHER: 'video.dither', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });

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

  const TOUCHED = { videos: new Set(), rateVideos: new Set() };
  function touchedAddLimited(set, el, onEvict) { if (!el) return; if (set.has(el)) { set.delete(el); set.add(el); return; } set.add(el); if (set.size <= CONFIG.TOUCHED_MAX) return; const it = set.values(); const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25); for (let i = 0; i < dropN; i++) { const v = it.next().value; if (v == null) break; set.delete(v); try { onEvict && onEvict(v); } catch (_) {} } }
  const insertTopN = (arr, item, N) => { let i = 0; while (i < arr.length && arr[i].s >= item.s) i++; if (i >= N) return; arr.splice(i, 0, item); if (arr.length > N) arr.length = N; };
  const lerp = (a, b, t) => a + (b - a) * t;

  let __vscRectEpoch = 0, __vscRectEpochQueued = false;
  function bumpRectEpoch() { if (__vscRectEpochQueued) return; __vscRectEpochQueued = true; requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; }); }
  window.addEventListener('scroll', bumpRectEpoch, { passive: true, capture: true, signal: __globalSig }); window.addEventListener('resize', bumpRectEpoch, { passive: true, signal: __globalSig }); window.addEventListener('orientationchange', bumpRectEpoch, { passive: true, signal: __globalSig });

  function getRectCached(v, now, maxAgeMs = 420) {
    const st = getVState(v); const t0 = st.rectT || 0; let r = st.rect; const epoch = st.rectEpoch || 0;
    if (!r || (now - t0) > maxAgeMs || epoch !== __vscRectEpoch) { r = v.getBoundingClientRect(); st.rect = r; st.rectT = now; st.rectEpoch = __vscRectEpoch; } return r;
  }
  function getViewportSnapshot() { const vv = window.visualViewport; if (vv) { return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; } return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }
  const __vscElemIds = new WeakMap(); let __vscElemIdSeq = 1;
  function getElemId(el) { if (!el) return 0; let id = __vscElemIds.get(el); if (!id) { id = __vscElemIdSeq++; __vscElemIds.set(el, id); } return id; }
  function hashApplySet(set) { let sum = 0 >>> 0, sumSq = 0 >>> 0, xor = 0 >>> 0, n = 0; for (const el of set) { const id = (getElemId(el) | 0) >>> 0; n++; sum = (sum + id) >>> 0; sumSq = (sumSq + Math.imul(id, id)) >>> 0; xor ^= (id + 0x9e3779b9 + ((xor << 6) >>> 0) + (xor >>> 2)) >>> 0; } return `${n}:${sum.toString(36)}:${sumSq.toString(36)}:${xor.toString(36)}`; }
  function* walkRoots(root) { if (!root) return; yield root; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let node = walker.currentNode; while (node) { if (node.shadowRoot) yield* walkRoots(node.shadowRoot); node = walker.nextNode(); } }

  function initSpaUrlDetector(onChanged) {
    if (window.__VSC_SPA_PATCHED__) return; window.__VSC_SPA_PATCHED__ = true; let lastHref = location.href;
    const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(next); };
    const wrap = (name) => { const orig = history[name]; if (typeof orig !== 'function') return; history[name] = function (...args) { const ret = Reflect.apply(orig, this, args); queueMicrotask(emitIfChanged); return ret; }; };
    wrap('pushState'); wrap('replaceState'); window.addEventListener('popstate', emitIfChanged, { passive: true, signal: __globalSig });
  }

  function getSelfCode() { try { if (document.currentScript && document.currentScript.textContent) { const t = document.currentScript.textContent.trim(); if (t.length > 200) return t; } } catch (_) { } try { if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.source) return String(GM_info.script.source || ''); } catch (_) { } return null; }
  function injectIntoIframe(iframe, code) { try { const doc = iframe.contentDocument; const win = iframe.contentWindow; if (!doc || !win || win[VSC_BOOT_KEY] || !code) return; const s = doc.createElement('script'); s.type = 'text/javascript'; s.text = VSC_POLICY ? VSC_POLICY.createScript(code) : code; (doc.head || doc.documentElement).appendChild(s); s.remove(); } catch (_) { } }
  function watchIframes() { const code = getSelfCode(); if (!code) return; const scan = () => { try { document.querySelectorAll("iframe").forEach((ifr) => injectIntoIframe(ifr, code)); } catch (_) {} }; const attach = () => { const root = document.documentElement; if (!root) return false; document.addEventListener("load", (e) => { const t = e.target; if (t && t.tagName && t.tagName.toLowerCase() === "iframe") injectIntoIframe(t, code); }, true); new MutationObserver(scan).observe(root, { childList: true, subtree: true }); scan(); return true; }; if (attach()) return; const mo = new MutationObserver(() => { if (attach()) mo.disconnect(); }); try { mo.observe(document, { childList: true, subtree: true }); } catch (_) {} document.addEventListener("DOMContentLoaded", () => { try { attach(); mo.disconnect(); } catch (_) {} }, { once: true }); }

  const fsWraps = new WeakMap();
  function ensureFsWrapper(video) { if (fsWraps.has(video)) return fsWraps.get(video); if (!video || !video.parentNode) return null; const parent = video.parentNode; const wrap = document.createElement('div'); wrap.className = 'vsc-fs-wrap'; wrap.style.cssText = `position: relative; display: inline-block; width: 100%; height: 100%; max-width: 100%; background: black;`; const ph = document.createComment('vsc-video-placeholder'); parent.insertBefore(ph, video); parent.insertBefore(wrap, video); wrap.appendChild(video); wrap.__vscPlaceholder = ph; fsWraps.set(video, wrap); return wrap; }
  function restoreFromFsWrapper(video) { const wrap = fsWraps.get(video); if (!wrap) return; const ph = wrap.__vscPlaceholder; if (ph && ph.parentNode) { ph.parentNode.insertBefore(video, ph); ph.parentNode.removeChild(ph); } if (wrap.parentNode) wrap.parentNode.removeChild(wrap); fsWraps.delete(video); }
  function patchMethodSafe(obj, name, wrappedFn) { try { const ownDesc = Object.getOwnPropertyDescriptor(obj, name); if (ownDesc && ownDesc.writable === false && ownDesc.configurable === false) return false; obj[name] = wrappedFn; if (obj[name] === wrappedFn) return true; } catch (_) {} try { Object.defineProperty(obj, name, { configurable: true, writable: true, value: wrappedFn }); return true; } catch (_) {} return false; }
  function patchFullscreenRequest(video) { const st = getVState(video); if (!video || st.fsPatched) return; st.fsPatched = true; if (typeof video.webkitEnterFullscreen === 'function') return; const origReq = video.requestFullscreen || video.webkitRequestFullscreen || video.msRequestFullscreen; if (!origReq) return; const runWrappedFs = () => { const wrap = ensureFsWrapper(video); const cleanupIfNotFullscreen = () => { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video); }; if (wrap) { const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen; if (typeof req === 'function') { try { const ret = req.call(wrap); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } } } try { const ret = origReq.call(video); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } }; if (video.requestFullscreen) patchMethodSafe(video, 'requestFullscreen', function () { return runWrappedFs(); }); if (video.webkitRequestFullscreen) patchMethodSafe(video, 'webkitRequestFullscreen', function () { return runWrappedFs(); }); if (video.msRequestFullscreen) patchMethodSafe(video, 'msRequestFullscreen', function () { return runWrappedFs(); }); }
  function onFsChange() { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl) document.querySelectorAll('video').forEach(v => { if (fsWraps.has(v)) restoreFromFsWrapper(v); }); if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure(); }
  document.addEventListener('fullscreenchange', onFsChange, { signal: __globalSig }); document.addEventListener('webkitfullscreenchange', onFsChange, { signal: __globalSig });

  function findWebkitPiPVideo() { const vids = document.querySelectorAll('video'); for (const v of vids) { try { if (typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture') return v; } catch (_) {} } return null; }
  let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
  function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
  function getActivePiPVideo() { const wk = findWebkitPiPVideo(); if (wk) return wk; if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement; if (__activeDocumentPiPWindow && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo; return null; }
  function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

  async function enterPiP(video) {
    if (!video || video.readyState < 2) return false;
    if ('documentPictureInPicture' in window) {
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
        pipWindow.addEventListener('pagehide', () => { try { video.style.cssText = __pipOrigCss; if (__pipPlaceholder && __pipPlaceholder.parentNode) { __pipPlaceholder.parentNode.insertBefore(video, __pipPlaceholder); __pipPlaceholder.remove(); } else if (__pipOrigParent) { __pipOrigParent.insertBefore(video, __pipOrigNext); } } finally { resetPiPState(); } });
        return true;
      } catch (e) { log.warn('Document PiP failed, fallback to standard', e); }
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
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    function getTargetVideo(e) { const path = typeof e.composedPath === 'function' ? e.composedPath() : null; if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } } const el = document.elementFromPoint(e.clientX || (e.touches && e.touches[0]?.clientX), e.clientY || (e.touches && e.touches[0]?.clientY)); let v = el?.tagName === 'VIDEO' ? el : el?.closest?.('video') || null; if (!v && window.__VSC_INTERNAL__?.App) { v = window.__VSC_INTERNAL__.App.getActiveVideo(); } return v; }
    window.addEventListener('wheel', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const delta = e.deltaY > 0 ? 0.9 : 1.1, st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * delta), 10); if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY); }, { passive: false, capture: true });
    window.addEventListener('mousedown', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale > 1) { e.preventDefault(); e.stopPropagation(); activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty; update(v); } }, { capture: true });
    window.addEventListener('mousemove', e => { if (!isPanning || !activeVideo) return; e.preventDefault(); e.stopPropagation(); const st = getSt(activeVideo), dx = e.clientX - startX - st.tx, dy = e.clientY - startY - st.ty; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true; st.tx = e.clientX - startX; st.ty = e.clientY - startY; update(activeVideo); }, { capture: true });
    window.addEventListener('mouseup', e => { if (isPanning) { if (activeVideo) { const st = getSt(activeVideo); if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); } update(activeVideo); } isPanning = false; activeVideo = null; } }, { capture: true });
    window.addEventListener('dblclick', e => { if (!e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v); }, { capture: true });
    window.addEventListener('touchstart', e => { const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y; } else if (e.touches.length === 1 && st.scale > 1) { activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty; } }, { passive: false, capture: true });
    window.addEventListener('touchmove', e => { if (!activeVideo) return; const st = getSt(activeVideo); if (pinchState.active && e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches); let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10); if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; } else { zoomTo(activeVideo, newScale, center.x, center.y); st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy; update(activeVideo); } pinchState.lastCx = center.x; pinchState.lastCy = center.y; } else if (isPanning && e.touches.length === 1) { if (e.cancelable) e.preventDefault(); const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true; st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY; update(activeVideo); } }, { passive: false, capture: true });
    window.addEventListener('touchend', e => { if (!activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) { e.preventDefault(); } isPanning = false; update(activeVideo); activeVideo = null; } }, { passive: false, capture: true });
    return { resetZoom, zoomTo, isZoomed };
  }

  const TARGETING_WEIGHTS = Object.freeze({ playing: 6.0, hasTime: 2.4, area: 1.2, dist: 3.0, audible: 1.35, audibleAudioBoostBonus: 1.2, pipBoostVisible: 2.4, pipBoostHidden: 3.8, clickedBoost: 2.0, bgPenaltyMutedAutoplayNoControls: 1.1, bgPenaltyEdge: 0.9, bgPenaltyTiny: 0.8, bgPenaltyLoop: 0.35 });

  function createTargeting() {
    const __applySetReuse = new Set(), __topBuf = [], __limitedBuf = []; const __lastTopCandidates = [];
    const __pickRes = { target: null, topCandidates: __lastTopCandidates };
    function buildCandidateFeature(v, now) {
      if (!v || v.readyState < 2) return null;
      const r = getRectCached(v, now, 420); const visibleGeom = !(r.width < 80 || r.height < 60 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth);
      const pip = isPiPActiveVideo(v); if (!visibleGeom && !pip) return null;
      const area = r.width * r.height; const st = getVState(v); const ir = (st.ir == null) ? 0.01 : st.ir;
      if (!pip && (ir < 0.01 && area < 160 * 120)) return null;
      const cx = r.left + r.width * 0.5; const cy = r.top + r.height * 0.5;
      return { v, r, area, ir, cx, cy, pip };
    }
    function invDistScoreSq(dx, dy, scale) { const d2 = dx * dx + dy * dy; return 1 / (1 + d2 / (scale * scale)); }
    function scoreVideoPrepared(f, audioBoostOn, now, lastUserPt, vp) {
      const v = f.v, areaScore = Math.log2(1 + f.area / 20000), playing = (!v.paused && !v.ended) ? 1 : 0, hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
      const dx = f.cx - lastUserPt.x, dy = f.cy - lastUserPt.y, distScore = invDistScoreSq(dx, dy, 850), cdx = f.cx - vp.cx, cdy = f.cy - vp.cy, centerScore = invDistScoreSq(cdx, cdy, 900);
      const userRecent01 = Math.max(0, 1 - (now - lastUserPt.t) / 2500), dist = Math.sqrt(dx * dx + dy * dy), userBoost = Math.min(0.9, userRecent01 * (1 / (1 + dist / 500)) * 1.15), irScore = Math.min(1, f.ir) * 3.2;
      const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0, bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
      const big01 = Math.min(1, f.area / (900 * 500)); let bgPenalty = 0; const autoplay = v.autoplay || v.hasAttribute?.('autoplay'), loop = v.loop || v.hasAttribute?.('loop'), noControls = !v.controls, r = f.r;
      const edgeLike = (r.top < 40 || (vp.h - r.bottom) < 40 || r.left < 20 || (vp.w - r.right) < 20), tiny = f.area < (260 * 160);
      const W = TARGETING_WEIGHTS;
      if (v.muted && autoplay && noControls) { bgPenalty += W.bgPenaltyMutedAutoplayNoControls * (1 - 0.60 * big01); if (edgeLike) bgPenalty += W.bgPenaltyEdge * (1 - 0.70 * big01); if (tiny) bgPenalty += W.bgPenaltyTiny; if (loop) bgPenalty += W.bgPenaltyLoop * (1 - 0.50 * big01); } else if (bgLike && !audible) { bgPenalty = (1.6 * (1 - 0.65 * big01)); if (userRecent01 > 0.15) bgPenalty *= 0.55; }
      const pipBoost = f.pip ? (document.visibilityState === 'hidden' ? W.pipBoostHidden : W.pipBoostVisible) : 0;
      const clickedBoost = (v === window.__lastClickedVideo && (now - (window.__lastClickT || 0)) < 1800 && f.area > (220 * 140)) ? W.clickedBoost : 0;
      return (playing * W.playing) + (hasTime * W.hasTime) + (areaScore * W.area) + (distScore * (W.dist * 0.72)) + (centerScore * 0.75) + userBoost + irScore + (audible * W.audible) + (audioBoostOn ? audible * W.audibleAudioBoostBonus : 0) + pipBoost + clickedBoost - bgPenalty;
    }
    function preScoreCandidate(f) { const v = f.v, irTerm = Math.min(1, f.ir) * 3.0, areaTerm = Math.log2(1 + f.area / 20000) * 1.2, playingTerm = (!v.paused && !v.ended) ? 1.2 : 0, hasTimeTerm = (v.currentTime > 0.2) ? 0.4 : 0, audibleTerm = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 0.7 : 0, pipTerm = f.pip ? 3.5 : 0; return irTerm + areaTerm + playingTerm + hasTimeTerm + audibleTerm + pipTerm; }
    function pushCandidateForced(buf, f, N) { if (!f) return; for (let i = 0; i < buf.length; i++) { if (buf[i].f?.v === f.v) return; } insertTopN(buf, { f, s: Infinity }, N); }
    const pickDetailed = (videos, lastUserPt, audioBoostOn) => {
      const now = performance.now(), vp = getViewportSnapshot();
      if (!videos || videos.size === 0) { __pickRes.target = null; return __pickRes; }
      const MAX_CAND_PRE = 14; __limitedBuf.length = 0;
      for (const v of videos) { const f = buildCandidateFeature(v, now); if (!f) continue; insertTopN(__limitedBuf, { f, s: preScoreCandidate(f) }, MAX_CAND_PRE); }
      const activeVideo = window.__VSC_INTERNAL__.App?.getActiveVideo();
      if (activeVideo && videos.has(activeVideo)) { pushCandidateForced(__limitedBuf, buildCandidateFeature(activeVideo, now), MAX_CAND_PRE); }
      const pipEl = document.pictureInPictureElement;
      if (pipEl && videos.has(pipEl)) { pushCandidateForced(__limitedBuf, buildCandidateFeature(pipEl, now), MAX_CAND_PRE); }
      let best = activeVideo, bestScore = -Infinity, secondScore = -Infinity, curScore = -Infinity;
      if (activeVideo && videos.has(activeVideo)) { const fCur = buildCandidateFeature(activeVideo, now); if (fCur) curScore = scoreVideoPrepared(fCur, audioBoostOn, now, lastUserPt, vp); best = activeVideo; bestScore = curScore; }
      __lastTopCandidates.length = 0;
      for (const it of __limitedBuf) { const s = scoreVideoPrepared(it.f, audioBoostOn, now, lastUserPt, vp); if (Number.isFinite(s)) insertTopN(__lastTopCandidates, { v: it.f.v, s }, 6); if (s > bestScore) { secondScore = bestScore; bestScore = s; best = it.f.v; } else if (s > secondScore) { secondScore = s; } }
      if (!Number.isFinite(bestScore) || bestScore === -Infinity) { __pickRes.target = null; return __pickRes; }
      __pickRes.target = best; return __pickRes;
    };
    const buildApplySetReuse = (visibleVideos, target, extraApplyTopK, applyToAllVisibleVideos, lastUserPt, audioBoostOn, topCandidates) => {
      __applySetReuse.clear();
      if (applyToAllVisibleVideos) { for (const v of visibleVideos) __applySetReuse.add(v); return __applySetReuse; }
      if (target) __applySetReuse.add(target);
      const N = Math.max(0, extraApplyTopK | 0); if (N <= 0) return __applySetReuse;
      if (topCandidates && topCandidates.length) { for (const it of topCandidates) { if (it.v !== target) __applySetReuse.add(it.v); if (__applySetReuse.size >= (target ? N + 1 : N)) break; } return __applySetReuse; }
      const now = performance.now(), vp = getViewportSnapshot();
      __topBuf.length = 0;
      for (const v of visibleVideos) { if (!v || v === target) continue; const f = buildCandidateFeature(v, now); const s = f ? scoreVideoPrepared(f, audioBoostOn, now, lastUserPt, vp) : -Infinity; if (s > -1e8) insertTopN(__topBuf, { v, s }, N); }
      for (let i = 0; i < __topBuf.length; i++) __applySetReuse.add(__topBuf[i].v);
      return __applySetReuse;
    };
    return Object.freeze({ pickDetailed, buildApplySetReuse });
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

  function computeToneStrengthEff(vf, Utils) {
    if (!vf?.tonePreset || vf.tonePreset === 'off' || vf.tonePreset === 'neutral') return 0;
    return Utils.clamp(vf.toneStrength ?? 1.0, 0, 1);
  }

  function createUtils() {
    return {
      clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
      num: (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; },
      numClamped: (v, min, max, fallback = min) => { const n = Number(v); const x = Number.isFinite(n) ? n : fallback; return Math.min(max, Math.max(min, x)); },
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

  function tempToRgbGain(temp) {
    const t = Math.max(-25, Math.min(25, Number(temp) || 0)); let rs = 1, gs = 1, bs = 1;
    if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.010; } else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.010; } return { rs, gs, bs };
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

  function clampTonePreset(p) {
    return {
      ...p,
      toe: Math.max(0, Math.min(1.0, p.toe ?? 0)),
      shoulder: Math.max(0, Math.min(1.0, p.shoulder ?? 0)),
      mid: Math.max(-0.5, Math.min(0.5, p.mid ?? 0)),
      con: Math.max(0.8, Math.min(1.2, p.con ?? 1)),
      sat: Math.max(0.8, Math.min(1.55, p.sat ?? 1)),
      br: Math.max(-2.0, Math.min(5.0, p.br ?? 0)),
      tmp: Math.max(-2.0, Math.min(2.0, p.tmp ?? 0))
    };
  }

  function applyTonePreset2Inline(out, presetName, strength, Utils) {
    if (!presetName || presetName === 'off') return out; const pRaw = PRESETS.tone[presetName]; if(!pRaw) return out;
    const p0 = clampTonePreset(pRaw);
    let t = Utils.clamp(strength ?? 1.0, 0, 1), toe = p0.toe, shoulder = p0.shoulder, mid = p0.mid, con = p0.con, sat = p0.sat, br = p0.br, tmp = p0.tmp;
    out.mid = Utils.clamp((out.mid || 0) + (mid * t), -1, 1); out.contrast = Utils.clamp((out.contrast || 1) * (1 + (con - 1) * t), 0.5, 2.0); out.satF = Utils.clamp((out.satF || 1) * (1 + (sat - 1) * t), 0.0, 2.0); out.bright = Utils.clamp((out.bright || 0) + (br * t), -50, 50); out.temp = Utils.clamp((out.temp || 0) + (tmp * t), -25, 25); out.toe = Utils.clamp((out.toe || 0) + (toe * t), -14, 14); out.shoulder = Utils.clamp((out.shoulder || 0) + (shoulder * t), -14, 14); return out;
  }

  function applyTempSatCap(out, clamp) {
    out.temp = clamp(out.temp || 0, -25, 25); const tempStress01 = clamp(Math.abs(out.temp || 0) / 18, 0, 1);
    if (tempStress01 > 0) { const satCap = 1.18 - 0.10 * tempStress01; out.satF = clamp(out.satF, 0.0, satCap); } else { out.satF = clamp(out.satF, 0.0, 2.0); }
  }

  function composeVideoParamsInto(out, vUser, Utils) {
    const clamp = Utils.clamp; const mix = clamp(vUser.presetMix ?? 1.0, 0, 1); const GVF_BASE_CON = 1.05, GVF_BASE_SAT = 1.02, GVF_BASE_TOE = 0.65;
    const pD = PRESETS.detail[vUser.presetS] || PRESETS.detail.off, pB = PRESETS.grade[vUser.presetB] || PRESETS.grade.brOFF;
    const preGammaF = lerp(1.0, pB.gammaF, mix), preConF = lerp(1.0, pB.conF, mix), preSatF = lerp(1.0, pB.satF, mix), preBright = (pB.brightAdd || 0) * mix, preTemp = (pB.tempAdd || 0) * mix;
    const preSharp = (pD.sharpAdd || 0) * mix, preSharp2 = (pD.sharp2Add || 0) * mix, preClarity = (pD.clarityAdd || 0) * mix;
    let gamma = preGammaF, contrast = preConF * GVF_BASE_CON, satF = preSatF * GVF_BASE_SAT, bright = preBright, temp = preTemp;
    const gain = 1.0;
    const chromaStress = (Math.min(1, Math.abs(satF - 1) / 0.55) * 0.85) + (Math.min(1, Math.abs(temp) / 25) * 0.65);
    const guard = 1 / (1 + chromaStress * 0.15); const sharpMul = (0.92 + 0.08 * guard);
    let sharp = preSharp * sharpMul, sharp2 = preSharp2 * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2))), clarity = preClarity * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2)));

    out.gain = gain; out.gamma = clamp(gamma, 0.5, 2.5); out.contrast = clamp(contrast, 0.5, 2.3); out.satF = clamp(satF, 0.0, 2.0); out.bright = clamp(bright, -50, 50); out.mid = 0; out.sharp = clamp(sharp, 0, 50); out.sharp2 = clamp(sharp2, 0, 50); out.clarity = clamp(clarity, 0, 50); out.dither = vUser.dither || 0; out.temp = clamp(temp, -25, 25); out.toe = clamp(GVF_BASE_TOE, 0, 15); out.shoulder = 0;
    applyTempSatCap(out, clamp);
    if (vUser.tonePreset && vUser.tonePreset !== 'off' && vUser.tonePreset !== 'neutral') { applyTonePreset2Inline(out, vUser.tonePreset, vUser.toneStrength, Utils); applyTempSatCap(out, clamp); out.contrast = clamp(out.contrast, 0.5, 2.3); out.bright = clamp(out.bright, -50, 50); }
    return out;
  }

  const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.dither ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
    function queueRaf() { if (rafId) return; rafId = requestAnimationFrame(run); }
    function timerCb() { timer = 0; queueRaf(); }
    function run() { rafId = 0; queued = false; const now = performance.now(), doForce = force; force = false; const dt = now - lastRun; if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; } lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} } }
    const request = (immediate = false) => { if (immediate) { force = true; if (timer) { clearTimeout(timer); timer = 0; } if (!queued) { queued = true; queueRaf(); } return; } if (queued) return; queued = true; if (timer) { clearTimeout(timer); timer = 0; } queueRaf(); };
    return { registerApply: (fn) => { applyFn = fn; }, request };
  }

  function createLocalStore(defaults, scheduler, Utils) {
    let rev = 0; const listeners = new Map();
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch (_) {} } const dot = key.indexOf('.'); if (dot > 0) { const catStar = key.slice(0, dot) + '.*'; const b = listeners.get(catStar); if (b) for (const cb of b) { try { cb(val); } catch (_) {} } } };
    const state = Utils.deepClone(defaults); const proxyCache = {}; const pathCache = Utils.createLRU(256); let batchDepth = 0, batchChanged = false; const batchEmits = new Map();
    const parsePath = (p) => { let hit = pathCache.get(p); if (hit) return hit; const dot = p.indexOf('.'); hit = (dot < 0) ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; pathCache.set(p, hit); return hit; };
    function invalidateProxyBranch(path) { if (!path) return; delete proxyCache[path]; const prefix = path + '.'; for (const k in proxyCache) { if (k.startsWith(prefix)) delete proxyCache[k]; } }
    function flushBatch() { if (!batchChanged) return; rev++; for (const [key, val] of batchEmits) emit(key, val); batchEmits.clear(); batchChanged = false; scheduler.request(false); }
    function notifyChange(fullPath, val) { if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; } rev++; emit(fullPath, val); scheduler.request(false); }
    function createProxyDeep(obj, pathPrefix) { return new Proxy(obj, { get(target, prop) { const value = target[prop]; if (typeof value === 'object' && value !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(value, cacheKey); return proxyCache[cacheKey]; } return value; }, set(target, prop, val) { if (Object.is(target[prop], val)) return true; const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if ((typeof target[prop] === 'object' && target[prop] !== null) || (typeof val === 'object' && val !== null)) { invalidateProxyBranch(fullPath); } target[prop] = val; notifyChange(fullPath, val); return true; } }); }
    const proxyState = createProxyDeep(state, '');
    return { state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat], get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; }, set: (p, val) => { const [c, k] = parsePath(p); if (k == null) { proxyState[c] = val; return; } proxyState[c][k] = val; }, batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } finally { batchDepth--; if (batchDepth === 0) flushBatch(); } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); } };
  }

  function normalizeNumberPath(sm, path, fallback, min = -Infinity, max = Infinity, isInt = false) { let v = +sm.get(path); if (!Number.isFinite(v)) v = fallback; if (isInt) v = Math.round(v); v = Math.min(max, Math.max(min, v)); if (!Object.is(sm.get(path), v)) sm.set(path, v); return v; }
  function normalizeVideoState(sm, PRESETS, P) { const tone = sm.get(P.V_TONE_PRE); if (tone !== 'off' && !(tone in PRESETS.tone)) sm.set(P.V_TONE_PRE, 'off'); const pS = sm.get(P.V_PRE_S); if (!(pS in PRESETS.detail)) sm.set(P.V_PRE_S, 'off'); const pB = sm.get(P.V_PRE_B); if (!(pB in PRESETS.grade)) sm.set(P.V_PRE_B, 'brOFF'); normalizeNumberPath(sm, P.V_PRE_MIX, 1.0, 0, 1); normalizeNumberPath(sm, P.V_TONE_STR, 1.0, 0, 1); }
  function normalizeAudioPlaybackState(sm, P) { const aEn = !!sm.get(P.A_EN); if (sm.get(P.A_EN) !== aEn) sm.set(P.A_EN, aEn); normalizeNumberPath(sm, P.A_BST, 6, 0, 12); const pbEn = !!sm.get(P.PB_EN); if (sm.get(P.PB_EN) !== pbEn) sm.set(P.PB_EN, pbEn); normalizeNumberPath(sm, P.PB_RATE, 1.0, 0.07, 16); }

  function createRegistry(scheduler) {
    const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    const shadowRootsLRU = []; const SHADOW_LRU_MAX = CONFIG.IS_LOW_END ? 8 : 24; const observedShadowHosts = new WeakSet();
    let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }
    const io = new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.ir = e.intersectionRatio || 0; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.01, rootMargin: CONFIG.IS_LOW_END ? '120px' : '300px' });
    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
    const ro = new ResizeObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); st.rect = e.contentRect ? el.getBoundingClientRect() : null; st.rectT = now; st.rectEpoch = -1; dirty.videos.add(el); changed = true; } if (changed) requestRefreshCoalesced(); });
    const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; patchFullscreenRequest(el); videos.add(el); io.observe(el); try { ro.observe(el); } catch (_) {} };
    const WorkQ = (() => { const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap(); const isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling); function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); } const postTaskBg = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function') ? (fn) => globalThis.scheduler.postTask(fn, { priority: 'background' }) : null; const schedule = () => { if (scheduled) return; scheduled = true; if (postTaskBg) { postTaskBg(drainRunnerRaf).catch(() => { if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }); return; } if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }; const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); }; const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} } }; const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; const shouldYieldForInput = () => { try { return !!isInputPending?.({ includeContinuous: true }); } catch (_) { return false; } }; while (bigHead < bigQ.length && budget()) { if (shouldYieldForInput()) break; scanNode(bigQ[bigHead++]); break; } while (head < q.length && budget()) { if (shouldYieldForInput()) break; scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); }; return Object.freeze({ enqueue }); })();
    function nodeMayContainVideo(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') return true; if ((n.childElementCount || 0) === 0) return false; try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } } } try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; } }
    const observers = new Set(); const connectObserver = (root) => { if (!root) return; const mo = new MutationObserver((muts) => { let touchedVideoTree = false; for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); if (!touchedVideoTree && nodeMayContainVideo(n)) touchedVideoTree = true; } } if (!touchedVideoTree && m.removedNodes && m.removedNodes.length) { for (const n of m.removedNodes) { if (!n || n.nodeType !== 1) continue; if (n.tagName === 'VIDEO') { touchedVideoTree = true; break; } if ((n.childElementCount || 0) > 0) { try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {} } } } } if (touchedVideoTree) requestRefreshCoalesced(); }); mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root); };
    const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
    document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail; const host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} }); refreshObservers();
    let pruneIterVideos = null; function pruneBatchRoundRobinNoAlloc(set, visibleSet, dirtySet, unobserveFn, batch = 200) { let removed = 0; let scanned = 0; if (!pruneIterVideos) pruneIterVideos = set.values(); while (scanned < batch) { let n = pruneIterVideos.next(); if (n.done) { pruneIterVideos = set.values(); n = pruneIterVideos.next(); if (n.done) break; } const el = n.value; if (el && !el.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} try { ro.unobserve(el); } catch (_) {} removed++; } scanned++; } return removed; }
    return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneBatchRoundRobinNoAlloc(videos, visible.videos, dirty.videos, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220); if(removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { for (const r of walkRoots(document.body || document.documentElement)) { WorkQ.enqueue(r); } } };
  }

  function createAudio(sm) {
    let ctx, compressor, dry, wet, target = null, currentSrc = null, wetConnected = false; const srcMap = new WeakMap(); let lastDryOn = null; let lastWetGain = null; let gestureHooked = false;
    const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') { await ctx.resume(); } if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
    const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; window.addEventListener('pointerdown', onGesture, { passive: true, capture: true, signal: __globalSig }); window.addEventListener('keydown', onGesture, { passive: true, capture: true, signal: __globalSig }); };
    const ensureCtx = () => { if (ctx) return true; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { ctx = new AC(); } ensureGestureResumeHook(); compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.knee.value = 24; compressor.ratio.value = 4; compressor.attack.value = 0.005; compressor.release.value = 0.20; dry = ctx.createGain(); wet = ctx.createGain(); dry.connect(ctx.destination); wet.connect(ctx.destination); compressor.connect(wet); return true; };
    const updateMix = () => { if (!ctx) return; const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)), boost = Math.pow(10, sm.get(P.A_BST) / 20), dryTarget = en ? 0 : 1, wetTarget = en ? boost : 0, t = ctx.currentTime; if (lastDryOn !== dryTarget) { try { dry.gain.cancelScheduledValues(t); dry.gain.setTargetAtTime(dryTarget, t, 0.015); } catch(e) { dry.gain.value = dryTarget; } lastDryOn = dryTarget; } if (lastWetGain == null || Math.abs(lastWetGain - wetTarget) > 1e-4) { try { wet.gain.cancelScheduledValues(t); wet.gain.setTargetAtTime(wetTarget, t, 0.015); } catch(e) { wet.gain.value = wetTarget; } lastWetGain = wetTarget; } if (currentSrc) { if (en && !wetConnected) { try { currentSrc.connect(compressor); wetConnected = true; } catch (_) {} } else if (!en && wetConnected) { try { currentSrc.disconnect(compressor); wetConnected = false; } catch (_) {} } } };
    const disconnectAll = () => { if (currentSrc) { if (wetConnected) { try { currentSrc.disconnect(compressor); } catch (_) {} } try { currentSrc.disconnect(dry); } catch (_) {} } currentSrc = null; target = null; wetConnected = false; };
    async function destroy() { try { disconnectAll(); } catch (_) {} try { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} try { if (ctx && ctx.state !== 'closed') { await ctx.close(); } } catch (_) {} ctx = null; compressor = null; dry = null; wet = null; currentSrc = null; target = null; wetConnected = false; lastDryOn = null; lastWetGain = null; }
    return { setTarget: (v) => { const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); if (v && getVState(v).audioFail) { if (v !== target) { disconnectAll(); target = v; } updateMix(); return; } if (v !== target) { disconnectAll(); target = v; } if (!v) { updateMix(); return; } if (!enabled && !currentSrc) { updateMix(); return; } if (!ensureCtx()) return; if (!currentSrc) { try { let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); } s.connect(dry); currentSrc = s; } catch (_) { getVState(v).audioFail = true; disconnectAll(); } } updateMix(); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(config.IS_LOW_END ? 320 : 720);
    const qInt = (v, step) => Math.round(v / step), setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; node.setAttribute(attr, val); } }, smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };
    const makeKey = (s) => ['video', qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2), qInt(s.dither, 1)].join('|');
    function getToneTableCached(steps, toeN, shoulderN, midN, gain) { const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(gain,0.06)}`; const hit = toneCache.get(key); if (hit) return hit; if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; } const toeEnd = 0.34 + toeN * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1, shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN), ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g); const out = new Array(steps); let prev = 0; for (let i = 0; i < steps; i++) { const x0 = i / (steps - 1); let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0; x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1); if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); } if (shAmt > 1e-6 && x > shoulderStart) { const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart)); const kk = Math.max(0.7, 1.2 + shAmt * 6.5); const shDen = (1 - Math.exp(-kk)); const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt; x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1); } let y = x; if (y < prev) y = prev; prev = y; const yy = Math.round(y * 100000) / 100000; out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy)); } const res = out.join(' '); toneCache.set(key, res); return res; }
    function buildSvg(doc) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const fid = `vsc-video-${config.VSC_ID}`, filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '-15%', y: '-15%', width: '130%', height: '130%' });
      const tone = h('feComponentTransfer', { ns: 'svg', result: 'tone' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
      const bcLin = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'bcLin' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
      const gam = h('feComponentTransfer', { ns: 'svg', in: 'bcLin', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })));
      const b1 = h('feGaussianBlur', { ns: 'svg', in: 'gam', stdDeviation: '0', result: 'b1' }), sh1 = h('feComposite', { ns: 'svg', in: 'gam', in2: 'b1', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh1' });
      const b2 = h('feGaussianBlur', { ns: 'svg', in: 'sh1', stdDeviation: '0', result: 'b2' }), sh2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'b2', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh2' });
      const bc = h('feGaussianBlur', { ns: 'svg', in: 'sh2', stdDeviation: '0', result: 'bc' }), cl = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'bc', operator: 'arithmetic', k2: '1', result: 'cl' });
      const tmp = h('feComponentTransfer', { ns: 'svg', in: 'cl', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
      const sat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
      filter.append(tone, bcLin, gam, b1, sh1, b2, sh2, bc, cl, tmp, sat); defs.append(filter);
      const tryAppend = () => { const r = doc.documentElement || doc.body; if (r) { r.appendChild(svg); return true; } return false; }; if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }
      return { fid, toneFuncs: Array.from(tone.children), bcLinFuncs: Array.from(bcLin.children), gamFuncs: Array.from(gam.children), tmpFuncs: Array.from(tmp.children), sat, b1, sh1, b2, sh2, bc, cl, st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', detailKey: '', __b1: '', __sh1k2: '', __sh1k3: '', __b2: '', __sh2k2: '', __sh2k3: '', __bc: '', __clk2: '', __clk3: '' } };
    }
    function prepare(doc, s) {
      let dc = urlCache.get(doc); if (!dc) { dc = { key:'', url:'' }; urlCache.set(doc, dc); }
      const key = makeKey(s); if (dc.key === key) return dc.url;
      let nodes = ctxMap.get(doc); if (!nodes) { nodes = buildSvg(doc); ctxMap.set(doc, nodes); }
      if (nodes.st.lastKey !== key) {
        nodes.st.lastKey = key; const st = nodes.st, steps = config.IS_LOW_END ? 96 : 128;
        const gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08; const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(clamp(s.mid||0,-1,1),0.02)}|${qInt(s.gain||1,gainQ)}`;
        const table = (st.toneKey !== tk) ? getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.gain||1,gainQ)*gainQ) : st.toneTable;
        const con = clamp(s.contrast || 1, 0.5, 2.0), brightOffset = clamp((s.bright || 0) / 1000, -0.2, 0.2), intercept = clamp(0.5 * (1 - con) + brightOffset, -1, 1), bcLinKey = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
        const gk = (1/clamp(s.gamma||1,0.2,3)).toFixed(4);
        const satVal = clamp(s.satF ?? 1, 0, 2.5).toFixed(2);
        const { rs, gs, bs } = tempToRgbGain(s.temp);
        const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`;
        const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;

        st._pending = { tk, table, bcLinKey, con, intercept, gk, satVal, tmk, rs, gs, bs, dk, s };

        if (!st._svgUpdatePending) {
          st._svgUpdatePending = true;
          queueMicrotask(() => {
            st._svgUpdatePending = false;
            const p = st._pending;
            if (!p) return;
            if (st.toneKey !== p.tk) { st.toneKey = p.tk; if (st.toneTable !== p.table) { st.toneTable = p.table; for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', p.table); } }
            if (st.bcLinKey !== p.bcLinKey) { st.bcLinKey = p.bcLinKey; for (const fn of nodes.bcLinFuncs) { fn.setAttribute('slope', p.con.toFixed(3)); fn.setAttribute('intercept', p.intercept.toFixed(4)); } }
            if (st.gammaKey !== p.gk) { st.gammaKey = p.gk; for (const fn of nodes.gamFuncs) fn.setAttribute('exponent', p.gk); }
            setAttr(nodes.sat, 'values', p.satVal, st, 'satKey');
            if (st.tempKey !== p.tmk) { st.tempKey = p.tmk; nodes.tmpFuncs[0].setAttribute('slope', p.rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', p.gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', p.bs.toFixed(3)); }
            if (st.detailKey !== p.dk) {
  st.detailKey = p.dk;
  const sc = (x) => x * x * (3 - 2 * x);

  // 1차 샤프: 기본 윤곽 (v1)
  const v1 = (p.s.sharp || 0) / 50, kC = sc(Math.min(1, v1)) * 2.2; // 게인 1.8 -> 2.2 상향
  setAttr(nodes.b1, 'stdDeviation', v1 > 0 ? (0.65 - sc(Math.min(1, v1)) * 0.2).toFixed(2) : '0', st, '__b1');
  setAttr(nodes.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2');
  setAttr(nodes.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3');

  // 2차 샤프: 미세 질감 및 날카로운 선 (v2) - 여기가 핵심 수정 포인트
  const v2 = (p.s.sharp2 || 0) / 50, kF = sc(Math.min(1, v2)) * 4.8; // 게인 4.5 -> 4.8 강화
  // 반경을 가변형에서 0.25 고정형으로 변경 (선이 아주 얇고 날카로워짐)
  const b2std = v2 > 0 ? '0.25' : '0';
  setAttr(nodes.b2, 'stdDeviation', b2std, st, '__b2');
  setAttr(nodes.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2');
  setAttr(nodes.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3');

  // 클라리티: 대비 강조
  const clVal = (p.s.clarity || 0) / 50;
  setAttr(nodes.bc, 'stdDeviation', clVal > 0 ? '1.1' : '0', st, '__bc');
  setAttr(nodes.cl, 'k2', (1 + clVal * 1.5).toFixed(3), st, '__clk2'); // 클라리티 강도 보정
  setAttr(nodes.cl, 'k3', (-clVal * 1.5).toFixed(3), st, '__clk3');
}
          });
        }
      }
      const url = `url(#${nodes.fid})`; dc.key = key; dc.url = url; return url;
    }
    return {
      prepareCached: (doc, s) => { try { return prepare(doc, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
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
          fs: `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\nuniform sampler2D uVideoTex;\nuniform vec2 uResolution;\nuniform vec4 uParams;\nuniform vec4 uParams2;\nuniform vec3 uRGBGain;\nconst vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);\nvoid main() {\n  vec2 texel = 1.0 / uResolution;\n  vec3 color = texture(uVideoTex, vTexCoord).rgb;\n  if (uParams2.y > 0.0) {\n    vec3 cU = texture(uVideoTex, vTexCoord + vec2(0.0, -texel.y)).rgb;\n    vec3 cD = texture(uVideoTex, vTexCoord + vec2(0.0,  texel.y)).rgb;\n    vec3 cL = texture(uVideoTex, vTexCoord + vec2(-texel.x, 0.0)).rgb;\n    vec3 cR = texture(uVideoTex, vTexCoord + vec2( texel.x, 0.0)).rgb;\n    vec3 blur = (color + cU + cD + cL + cR) * 0.2;\n    vec3 hp = color - blur;\n    float e = abs(dot(hp, LUMA));\n    float x = clamp((e - 0.005) / 0.020, 0.0, 1.0);\n    float gate = x * x * (3.0 - 2.0 * x);\n    float luma0 = dot(color, LUMA);\n    float hi = clamp((luma0 - 0.78) / 0.22, 0.0, 1.0);\n    float hiReduce = 1.0 - 0.20 * (hi * hi * (3.0 - 2.0 * hi));\n    color = clamp(color + hp * (uParams2.y * 5.5) * gate * hiReduce, 0.0, 1.0);\n  }\n  color *= uRGBGain;\n  color += (uParams2.x / 1000.0);\n  color = (color - 0.5) * uParams.y + 0.5;\n  float luma = dot(color, LUMA);\n  float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0);\n  float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma);\n  float currentSat = uParams.z * (1.0 - 0.05 * satReduce);\n  color = luma + (color - luma) * currentSat;\n  color *= uParams.x;\n  if (uParams.w != 1.0) color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w));\n  if (uParams2.z > 0.0) {\n    float noise = fract(sin(dot(vTexCoord, vec2(12.9898, 78.233))) * 43758.5453);\n    color += (noise - 0.5) * (uParams2.z / 100.0);\n  }\n  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);\n}`
        };
      }
      return {
        vs: `attribute vec2 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vTexCoord = aTexCoord; }`,
        fs: `precision highp float; varying vec2 vTexCoord; uniform sampler2D uVideoTex; uniform vec2 uResolution; uniform vec4 uParams; uniform vec4 uParams2; uniform vec3 uRGBGain; const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722); void main() { vec2 texel = 1.0 / uResolution; vec3 color = texture2D(uVideoTex, vTexCoord).rgb; if (uParams2.y > 0.0) { vec3 cU = texture2D(uVideoTex, vTexCoord + vec2(0.0, -texel.y)).rgb; vec3 cD = texture2D(uVideoTex, vTexCoord + vec2(0.0, texel.y)).rgb; vec3 cL = texture2D(uVideoTex, vTexCoord + vec2(-texel.x, 0.0)).rgb; vec3 cR = texture2D(uVideoTex, vTexCoord + vec2(texel.x, 0.0)).rgb; vec3 blur = (color + cU + cD + cL + cR) * 0.2; vec3 hp = color - blur; float e = abs(dot(hp, LUMA)); float x = clamp((e - 0.005) / 0.020, 0.0, 1.0); float gate = x * x * (3.0 - 2.0 * x); float luma0 = dot(color, LUMA); float hi = clamp((luma0 - 0.78) / 0.22, 0.0, 1.0); float hiReduce = 1.0 - 0.20 * (hi * hi * (3.0 - 2.0 * hi)); color = clamp(color + hp * (uParams2.y * 5.5) * gate * hiReduce, 0.0, 1.0); } color *= uRGBGain; color += (uParams2.x / 1000.0); color = (color - 0.5) * uParams.y + 0.5; float luma = dot(color, LUMA); float hiLuma = clamp((luma - 0.72) / 0.28, 0.0, 1.0); float satReduce = hiLuma * hiLuma * (3.0 - 2.0 * hiLuma); float currentSat = uParams.z * (1.0 - 0.05 * satReduce); color = luma + (color - luma) * currentSat; color *= uParams.x; if (uParams.w != 1.0) { color = pow(max(color, vec3(0.0)), vec3(1.0 / uParams.w)); } if (uParams2.z > 0.0) { float noise = fract(sin(dot(vTexCoord, vec2(12.9898, 78.233))) * 43758.5453); color += (noise - 0.5) * (uParams2.z / 100.0); } gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0); }`
      };
    }

    class WebGLPipeline {
      constructor() {
        this.canvas = null; this.gl = null; this.program = null; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this.originalNextSibling = null; this.restoreVideoStyle = null; this.renderDriver = createFrameDriver(); this.disabledUntil = 0;
        this._texW = 0; this._texH = 0;
        this._loopToken = 0; this._loopRunning = false;
        this._perf = { procMsEma: 0, frameSkip: 1, frameNo: 0 };
        this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0;
        this._onContextLost = (e) => { e.preventDefault(); this.disabledUntil = performance.now() + 3000; this.active = false; this._loopToken++; this._loopRunning = false; };
        this._onContextRestored = () => {
          try {
            this.disposeGLResources({ keepCanvasListeners: true });
            if (this.initGLResourcesOnExistingCanvas()) { if (this.video) { this.active = true; this.startRenderLoop(); } } else { this.disabledUntil = performance.now() + 5000; }
          } catch (_) { this.disabledUntil = performance.now() + 5000; }
        };
      }
      ensureCanvas() {
        if (this.canvas) return;
        this.canvas = document.createElement('canvas'); this.canvas.style.width = '100%'; this.canvas.style.height = '100%'; this.canvas.style.objectFit = 'contain'; this.canvas.style.display = 'block'; this.canvas.style.pointerEvents = 'none';
        this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false }); this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, { passive: true });
      }
      initGLResourcesOnExistingCanvas() {
        this.ensureCanvas();
        let gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        if (!gl) gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        if (!gl) return false; this.gl = gl;
        const { vs: vsSource, fs: fsSource } = buildShaderSources(gl);
        try {
          const vs = compileShaderChecked(gl, gl.VERTEX_SHADER, vsSource), fs = compileShaderChecked(gl, gl.FRAGMENT_SHADER, fsSource); this.program = linkProgramChecked(gl, vs, fs); gl.useProgram(this.program); gl.deleteShader(vs); gl.deleteShader(fs);
          this.uResolution = gl.getUniformLocation(this.program, 'uResolution'); this.uVideoTex = gl.getUniformLocation(this.program, 'uVideoTex'); this.uParams = gl.getUniformLocation(this.program, 'uParams'); this.uParams2 = gl.getUniformLocation(this.program, 'uParams2'); this.uRGBGain = gl.getUniformLocation(this.program, 'uRGBGain');
          const aPosition = gl.getAttribLocation(this.program, 'aPosition'), aTexCoord = gl.getAttribLocation(this.program, 'aTexCoord'), vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); const tCoords = new Float32Array([0,0, 1,0, 0,1, 1,1]);
          this.vBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); gl.enableVertexAttribArray(aPosition); gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
          this.tBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.bufferData(gl.ARRAY_BUFFER, tCoords, gl.STATIC_DRAW); gl.enableVertexAttribArray(aTexCoord); gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
          this.videoTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          return true;
        } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
      }
      init() { return this.initGLResourcesOnExistingCanvas(); }
      attachToVideo(video) {
        if (!this.active && !this.init()) return false; this.video = video; this.originalParent = video.parentNode; this.originalNextSibling = video.nextSibling;
        this.restoreVideoStyle = patchInlineStyleImportant(video, { opacity: '0.001' });
        if (this.originalParent) {
            if (window.getComputedStyle(this.originalParent).position === 'static') this.originalParent.style.position = 'relative';
            this.canvas.style.position = 'absolute'; this.canvas.style.top = '0'; this.canvas.style.left = '0';
            this.originalParent.insertBefore(this.canvas, video);
        }
        if (this._styleObs) this._styleObs.disconnect();
        this._styleObs = new MutationObserver(() => { this._styleDirty = true; });
        try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
        this._styleDirty = true;
        this.active = true; this.startRenderLoop(); return true;
      }
      updateParams(vVals) { this.vVals = vVals; }
      syncCanvasPresentationFromVideo(video, now) {
        if (!this.canvas || !video) return;
        if (!this._styleDirty && (now - this._lastStyleSyncT) < 250) return;
        const vs = window.getComputedStyle(video), cs = this.canvas.style;
        if (cs.objectFit !== vs.objectFit) cs.objectFit = vs.objectFit || 'contain';
        if (cs.objectPosition !== vs.objectPosition) cs.objectPosition = vs.objectPosition;
        if (cs.transform !== video.style.transform) cs.transform = video.style.transform;
        if (cs.transformOrigin !== video.style.transformOrigin) cs.transformOrigin = video.style.transformOrigin;
        this._styleDirty = false; this._lastStyleSyncT = now;
      }
      render() {
        if (!this.active || !this.gl || !this.video || !this.vVals) return; const gl = this.gl, video = this.video; const now = performance.now(); if (now < this.disabledUntil) return;
        const st = getVState(video); if (st.webglDisabledUntil && now < st.webglDisabledUntil) return;
        if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
        if (this.canvas.parentNode !== video.parentNode && video.parentNode) { this.originalParent = video.parentNode; this.originalNextSibling = video.nextSibling; video.parentNode.insertBefore(this.canvas, video); }
        this.syncCanvasPresentationFromVideo(video, now);
        const w = video.videoWidth, h = video.videoHeight;
        if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); gl.uniform2f(this.uResolution, w, h); }
        const perfScale = (this._perf.procMsEma > 14) ? 0.55 : (this._perf.procMsEma > 10 ? 0.8 : 1.0);
        const sharpNorm = ((this.vVals.sharp || 0) / 50.0) * perfScale;
        const ditherVal = (this.vVals.dither || 0.0) * (perfScale < 1 ? 0.4 : 1.0);
        const { rs, gs, bs } = tempToRgbGain(this.vVals.temp);
        gl.uniform4f(this.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);
        gl.uniform4f(this.uParams2, this.vVals.bright || 0.0, sharpNorm, ditherVal, 0.0);
        gl.uniform3f(this.uRGBGain, rs, gs, bs);
        try {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
          if (this._texW !== w || this._texH !== h) {
            this._texW = w; this._texH = h;
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          st.webglFailCount = 0;
        } catch (_) {
          st.webglFailCount = (st.webglFailCount || 0) + 1;
          if (st.webglFailCount >= 3) {
            st.webglDisabledUntil = now + 10000; st.webglFailCount = 0;
            log.warn('WebGL repeated failure on video, cooling down');
          }
        }
      }
      startRenderLoop() {
        if (this._loopRunning) return; this._loopRunning = true; const token = ++this._loopToken;
        const loopFn = (_now, meta) => {
          if (token !== this._loopToken || !this.active || !this.video) { this._loopRunning = false; return; }
          if (meta && Number.isFinite(meta.processingDuration)) {
            const x = meta.processingDuration * 1000;
            this._perf.procMsEma = this._perf.procMsEma ? (this._perf.procMsEma * 0.85 + x * 0.15) : x;
            if (this._perf.procMsEma > 14) this._perf.frameSkip = 2;
            else if (this._perf.procMsEma > 9) this._perf.frameSkip = 1;
            else this._perf.frameSkip = 0;
          }
          this._perf.frameNo++;
          if (this._perf.frameSkip > 0 && (this._perf.frameNo % (this._perf.frameSkip + 1)) !== 0) { this.scheduleNextFrame(loopFn); return; }
          this.render(); this.scheduleNextFrame(loopFn);
        };
        this.scheduleNextFrame(loopFn);
      }
      scheduleNextFrame(loopFn) {
        const pausedOrHidden = !!(document.hidden || this.video?.paused);
        this.renderDriver.scheduleVideoFrame(this.video, loopFn, pausedOrHidden ? 'timeout' : 'raf', pausedOrHidden ? 220 : 90);
      }
      disposeGLResources(opts = {}) {
        const { keepCanvasListeners = false } = opts; const gl = this.gl;
        if (gl) {
          try {
            if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; }
            if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; }
            if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; }
            if (this.program) { gl.deleteProgram(this.program); this.program = null; }
          } catch (_) {}
        }
        if (!keepCanvasListeners && this.canvas) { try { this.canvas.removeEventListener('webglcontextlost', this._onContextLost); this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored); } catch (_) {} }
        this.gl = null; this._texW = 0; this._texH = 0;
      }
      shutdown() {
        this.active = false; this._loopToken++; this._loopRunning = false; this.renderDriver.clear(); if (this._styleObs) { this._styleObs.disconnect(); this._styleObs = null; }
        try { this.restoreVideoStyle?.(); } catch (_) {} this.restoreVideoStyle = null;
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas); this.disposeGLResources();
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
        const cur = shadow.adoptedStyleSheets || [];
        if (!cur.includes(sheet)) { shadow.adoptedStyleSheets = [...cur, sheet]; }
        return;
      }
    } catch (_) {}
    const marker = 'data-vsc-style';
    if (!shadow.querySelector(`style[${marker}="1"]`)) { shadow.append(h('style', { [marker]: '1' }, cssText)); }
  }

  function createDisposerBag() { const fns = []; return { add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; }, flush() { for (let i = fns.length - 1; i >= 0; i--) { try { fns[i](); } catch (_) {} } fns.length = 0; } }; }

  function bindWindowDrag(onMove, onEnd) {
    const ac = new AbortController();
    const sig = ac.signal;
    window.addEventListener('mousemove', onMove, { passive: false, signal: sig });
    window.addEventListener('mouseup', end, { signal: sig });
    window.addEventListener('touchmove', onMove, { passive: false, signal: sig });
    window.addEventListener('touchend', end, { signal: sig });
    window.addEventListener('blur', end, { signal: sig });
    function end(ev) { try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} } }
    return () => { try { ac.abort(); } catch (_) {} };
  }

  function createUI(sm, registry, scheduler, bus, Utils) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0;
    const uiWakeCtrl = new AbortController(), bag = createDisposerBag(), sub = (k, fn) => bag.add(sm.sub(k, fn));
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
    const allowUiInThisDoc = () => { return registry.videos.size > 0; };

    function setAndHint(path, value) {
      const prev = sm.get(path), changed = !Object.is(prev, value);
      if (changed) sm.set(path, value);
      bus.signal({ forceApply: true });
    }

    function getFullscreenElementSafe() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
    const getUiRoot = () => { const fs = getFullscreenElementSafe(); if (fs) { if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement; return fs; } return document.body || document.documentElement; };

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      const addBtn = (text, value) => { const b = h('button', { class: 'pbtn', style: 'flex:1' }, text); b.onclick = () => { const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) { setAndHint(key, offValue); } else { setAndHint(key, value); } }; const sync = () => { b.classList.toggle('active', sm.get(key) === value); }; sub(key, sync); sync(); row.append(b); };
      for (const it of items) addBtn(it.text, it.value); if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) addBtn('OFF', offValue); return row;
    }

    const build = () => {
      if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
      const style = `.main { position: fixed; top: 50%; right: 70px; transform: translateY(-50%); width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; } .header { display: flex; justify-content: center; margin-bottom: 12px; cursor: move; border-bottom: 2px solid #444; padding-bottom: 8px; font-weight: bold; font-size: 14px; color: #ccc;} .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; } .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; } .btn.active { background: #3498db; color: white; border-color: #2980b9; } .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; } .pbtn.active { background: #e67e22; color: white; border-color: #d35400; } hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }`;
      applyShadowStyle(shadow, style, h);
      const isWebGL = sm.get(P.APP_RENDER_MODE) === 'webgl';
      const dragHandle = h('div', { class: 'header' }, 'VSC 렌더링 제어');

      const bodyMain = h('div', { id: 'p-main' }, [
        h('div', { class: 'prow' }, [
          h('button', { id: 'rm-btn', class: 'btn', style: `color: ${isWebGL ? '#ffaa00' : '#88ccff'}; border-color: ${isWebGL ? '#ffaa00' : '#88ccff'};`, onclick: () => setAndHint(P.APP_RENDER_MODE, sm.get(P.APP_RENDER_MODE) === 'webgl' ? 'svg' : 'webgl') }, `🎨 ${isWebGL ? 'WebGL' : 'SVG'}`),
          h('button', { id: 'boost-btn', class: 'btn', onclick: () => setAndHint(P.A_EN, !sm.get(P.A_EN)) }, '🔊 오디오업')]),
        h('div', { class: 'prow' },[
          h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP'),
          h('button', { id: 'zoom-btn', class: 'btn', onclick: () => {
            const v = window.__VSC_APP__?.getActiveVideo();
            if(v) {
              const zm = window.__VSC_INTERNAL__.ZoomManager;
              if (zm.isZoomed(v)) { zm.resetZoom(v); } else {
                const rect = v.getBoundingClientRect();
                zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
              }
            }
          } }, '🔍 줌 제어'),
          h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power')
        ]),
        h('div', { class: 'prow' }, [
            h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
            h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); bus.signal({ forceApply:true }); } }, '↺ 리셋')
        ]),
        renderButtonRow({ label: '톤', key: P.V_TONE_PRE, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.tone).filter(k=>k!=='off').map(k => ({ text: PRESETS.tone[k].label, value: k })) }),
        renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k=>k!=='off').map(k => ({ text: k, value: k })) }),
        renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(k => ({ text: k, value: k })) }),
        h('hr'), h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }; sub(P.PB_RATE, v => { const isEn = sm.get(P.PB_EN); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); sub(P.PB_EN, isEn => { const v = sm.get(P.PB_RATE); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); b.classList.toggle('active', sm.get(P.PB_EN) && Math.abs((sm.get(P.PB_RATE) || 1) - s) < 0.01); return b; }))
      ]);
      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]); shadow.append(mainPanel);
      dragHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        let startX = e.clientX, startY = e.clientY;
        const rect = mainPanel.getBoundingClientRect();
        mainPanel.style.transform = 'none';
        mainPanel.style.top = `${rect.top}px`;
        mainPanel.style.right = 'auto';
        mainPanel.style.left = `${rect.left}px`;
        bindWindowDrag(
          (ev) => {
            mainPanel.style.top = `${rect.top + (ev.clientY - startY)}px`;
            mainPanel.style.left = `${rect.left + (ev.clientX - startX)}px`;
          }
        );
      });
      sub(P.A_EN, v => shadow.querySelector('#boost-btn').classList.toggle('active', !!v));
      sub(P.APP_ACT, v => shadow.querySelector('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
      sub(P.APP_RENDER_MODE, v => { const btn = shadow.querySelector('#rm-btn'); if(btn) { btn.textContent = `🎨 ${v === 'webgl' ? 'WebGL' : 'SVG'}`; btn.style.color = v === 'webgl' ? '#ffaa00' : '#88ccff'; btn.style.borderColor = v === 'webgl' ? '#ffaa00' : '#88ccff'; } });

      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (!allowUiInThisDoc()) return; if (gearHost) return;
      gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%; background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff; display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer; pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none; transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;} @media (hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}} .gear:active{transform:translateY(-50%) scale(0.98);} .gear.open{outline:2px solid rgba(52,152,219,0.85);opacity:1 !important;} .gear.inactive{opacity:0.45;} .hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,0.88); border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.82);font:600 11px/1.2 sans-serif;white-space:nowrap; z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none;} .gear:hover+.hint{opacity:1;transform:translateY(0);} ${CONFIG.IS_MOBILE ? '.hint{display:none !important;}' : ''}`;
      applyShadowStyle(shadow, style, h); let dragThresholdMet = false;
      gearBtn = h('button', { class: 'gear', onclick: (e) => { if (dragThresholdMet) { e.preventDefault(); e.stopPropagation(); return; } setAndHint(P.APP_UI, !sm.get(P.APP_UI)); } }, '⚙');
      shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.15'; }, 2500); };
      window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal }); window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return;
          dragThresholdMet = false;
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          const onMove = (ev) => {
              const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
              if (Math.abs(currentY - startY) > 10) {
                  if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; }
                  if (ev.cancelable) ev.preventDefault();
              }
              if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
          };
          const onUp = () => {
              gearBtn.style.transition = '';
              setTimeout(() => { dragThresholdMet = false; }, 100);
          };
          bindWindowDrag(onMove, onUp);
      };
      gearBtn.addEventListener('mousedown', handleGearDrag); gearBtn.addEventListener('touchstart', handleGearDrag, { passive: false });
      const syncGear = () => { if (!gearBtn) return; const showHere = allowUiInThisDoc(); gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); gearBtn.style.display = showHere ? 'block' : 'none'; if (!showHere) detachNodesHard(); else wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };
    const mount = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; } else { if (container) container.style.display = 'none'; } mount(); };
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => { try { ensure(); scheduler.request(true); } catch (_) {} }, { once: true, signal: __globalSig }); }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => { window.addEventListener(ev, () => { try { ensure(); } catch (_) {} }, { passive: true, signal: __globalSig }); });
    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e.target)) return;
        if (!(e && e.altKey && e.shiftKey && e.code === 'KeyV')) return;
        if (!allowUiInThisDoc()) return; setAndHint(P.APP_UI, !sm.get(P.APP_UI)); ensure(); scheduler.request(true);
    }, { signal: __globalSig });
    if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;
    return { ensure, destroy: () => { try { uiWakeCtrl.abort(); } catch {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); bag.flush(); detachNodesHard(); } };
  }

  function createNoopUI() { return Object.freeze({ ensure() {}, destroy() {} }); }
  function createUIFactory(enableUI) { return enableUI ? ((sm, registry, scheduler, bus, Utils) => createUI(sm, registry, scheduler, bus, Utils)) : createNoopUI; }

  function getRateState(v) { const st = getVState(v); if (!st.rateState) { st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0 }; } return st.rateState; }
  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el, 220); el.playbackRate = nextRate; st.orig = null; } catch (_) {} };
  const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
  const onEvictVideo = (v) => { if (__vscClearVideoFilter) try { __vscClearVideoFilter(v); } catch (_) {} if (__vscClearVideoFilterGL) try { __vscClearVideoFilterGL(v); } catch (_) {} restoreRateOne(v); };
  const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };
  function pruneTouchedDisconnected() { for (const v of TOUCHED.videos) { if (!v || !v.isConnected) TOUCHED.videos.delete(v); } for (const v of TOUCHED.rateVideos) { if (!v || !v.isConnected) TOUCHED.rateVideos.delete(v); } }

  const bindVideoOnce = (v) => {
    const st = getVState(v);
    if (st.bound) return; st.bound = true;
    const softResetTransientFlags = () => {
      st.tainted = false; st.audioFail = false; st.rect = null; st.rectT = 0; st.rectEpoch = -1;
      if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; }
      vscSignal({ forceApply: true });
    };
    ['loadstart', 'loadedmetadata', 'emptied'].forEach(ev => v.addEventListener(ev, softResetTransientFlags, { passive: true }));
    ['seeking', 'play'].forEach(ev => v.addEventListener(ev, () => { vscSignal({ forceApply: true }); }, { passive: true }));
    v.addEventListener('ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180) return; if (now < (rSt.suppressSyncUntil || 0)) return; const refs = window.__VSC_INTERNAL__; const app = refs?.App; const store = refs?.Store; if (!store) return; const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return; const activeVideo = app?.getActiveVideo?.() || null; const applyAll = !!store.get?.(P.APP_APPLY_ALL); if (!applyAll) { if (!activeVideo || v !== activeVideo) return; } const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.set(P.PB_RATE, cur); if (store.get?.(P.PB_EN) !== false) store.set(P.PB_EN, true); } }, { passive: true });
  };

  const __urlByDocVideo = new Map(), __reconcileCandidates = new Set(); let __lastReconcileSig = '';
  function makeReconcileSig(applySet, vVals, desiredRate, pbActive, videoFxOn, activeTarget, rMode) { return [ videoFxOn ? 1 : 0, pbActive ? 1 : 0, desiredRate ?? 1, hashApplySet(applySet), getElemId(activeTarget), rMode, vVals.gain?.toFixed(2), vVals.gamma?.toFixed(2), vVals.contrast?.toFixed(2), vVals.bright?.toFixed(1), vVals.satF?.toFixed(2), vVals.temp?.toFixed(1), vVals.sharp?.toFixed(1), vVals.sharp2?.toFixed(1), vVals.clarity?.toFixed(1), vVals.mid?.toFixed(3), vVals.dither?.toFixed(0), vVals.toe?.toFixed(1), vVals.shoulder?.toFixed(1) ].join('|'); }

  function clearAllVideoFx(el, Filters, FiltersGL) {
    Filters.clear(el);
    FiltersGL.clear(el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Filters, FiltersGL, rMode }) {
    const candidates = __reconcileCandidates; candidates.clear();
    for (const v of dirtyVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.videos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.rateVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of applySet) if (v?.tagName === 'VIDEO') candidates.add(v);
    __urlByDocVideo.clear();
    for (const el of candidates) {
      if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
      const st = getVState(el);
      const visible = (st.visible !== false), shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));
      if (!shouldApply) { clearAllVideoFx(el, Filters, FiltersGL); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); bindVideoOnce(el); continue; }

      if (videoFxOn) {
          if (rMode === 'webgl') {
              Filters.clear(el); FiltersGL.apply(el, vVals); touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
          } else {
              FiltersGL.clear(el); const doc = el.ownerDocument || document; let url = __urlByDocVideo.get(doc); if (url === undefined) { url = Filters.prepareCached(doc, vVals); __urlByDocVideo.set(doc, url); } Filters.applyUrl(el, url); touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
          }
      } else { clearAllVideoFx(el, Filters, FiltersGL); TOUCHED.videos.delete(el); }

      if (pbActive) { const rSt = getRateState(el); if (rSt.orig == null) rSt.orig = el.playbackRate; const lastDesired = st.desiredRate; if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) { st.desiredRate = desiredRate; markInternalRateChange(el, 160); try { el.playbackRate = desiredRate; } catch (_) {} } touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo); } else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
      bindVideoOnce(el);
    }
    candidates.clear();
  }

  function getDropRatioSafe(v) { try { const q = v?.getVideoPlaybackQuality?.(); if (!q || !q.totalVideoFrames || q.totalVideoFrames < 60) return 0; return (q.droppedVideoFrames || 0) / q.totalVideoFrames; } catch (_) { return 0; } }

  function createAppController({ Store, Registry, Scheduler, Bus, Filters, FiltersGL, Audio, UI, DEFAULTS, FEATURES, Utils, P, Targeting }) {
    if (CONFIG.DEBUG) { window.__VSC_Filters_Ref = Filters; window.__VSC_Bus_Ref = Bus; window.__VSC_Store_Ref = Store; }
    if (ENABLE_UI) { UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); }); }
    Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });

    Bus.on('signal', (s) => { if (s.forceApply) Scheduler.request(true); });

    let __activeTarget = null, applySet = null;
    const __vfEff = { ...DEFAULTS.video }, __vVals = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, mid: 0, sharp: 0, sharp2: 0, clarity: 0, temp: 0, toe: 0, shoulder: 0, dither: 0 };
    let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;
        if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }

        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev; if (!force && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); pruneTouchedDisconnected(); lastPrune = now; }

        const vf0 = Store.getCatRef('video'), wantAudio = FEATURES.audio(), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        const pick = Targeting.pickDetailed(visible.videos, window.__lastUserPt, wantAudio); let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
        if (nextTarget !== __activeTarget) { __activeTarget = nextTarget; }

        if (wantAudio || Audio.hasCtx?.() || Audio.isHooked?.()) Audio.setTarget(__activeTarget || null); else Audio.setTarget(null); Audio.update();

        let vfEff = vf0; if (vf0.tonePreset && vf0.tonePreset !== 'off' && vf0.tonePreset !== 'neutral') { const tEff = computeToneStrengthEff(vf0, Utils); for (const k in __vfEff) __vfEff[k] = vf0[k]; __vfEff.toneStrength = tEff; vfEff = __vfEff; }

        composeVideoParamsInto(__vVals, vfEff, Utils);

        if (__activeTarget) { const dropRatio = getDropRatioSafe(__activeTarget); if (dropRatio > 0.03) { const stress = Math.min(1, (dropRatio - 0.03) / 0.10); const damp = 1 - 0.45 * stress; __vVals.sharp *= damp; __vVals.sharp2 *= (1 - 0.55 * stress); __vVals.clarity *= (1 - 0.50 * stress); } }

        const videoFxOn = !isNeutralVideoParams(__vVals), applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), extraApplyTopK = Store.get(P.APP_EXTRA_TOPK) | 0;
        applySet = Targeting.buildApplySetReuse(visible.videos, __activeTarget, extraApplyTopK, applyToAllVisibleVideos, window.__lastUserPt, wantAudio, pick.topCandidates);
        const desiredRate = Store.get(P.PB_RATE), pbActive = active && !!Store.get(P.PB_EN), rMode = Store.get(P.APP_RENDER_MODE) || 'svg';

        const reconcileSig = makeReconcileSig(applySet, __vVals, desiredRate, pbActive, videoFxOn, __activeTarget, rMode);

        if (!force && vidsDirty.size === 0 && reconcileSig === __lastReconcileSig) return;
        __lastReconcileSig = reconcileSig;

        reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: __vVals, videoFxOn, desiredRate, pbActive, Filters, FiltersGL, rMode });
        if (ENABLE_UI && (force || vidsDirty.size)) UI.ensure();
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
    if (Store.get(P.APP_ACT)) startTick();
    Scheduler.request(true);
    return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { Audio.setTarget(null); } catch (_) {} try { Audio.destroy?.(); } catch (_) {} try { __globalHooksAC.abort(); } catch (_) {} } });
  }

  const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
  window.__VSC_INTERNAL__.Bus = Bus; window.__VSC_INTERNAL__.Store = Store;
  const normalizeAllVideo = () => normalizeVideoState(Store, PRESETS, P);
  [ P.V_TONE_PRE, P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_TONE_STR ].forEach(k => Store.sub(k, normalizeAllVideo)); normalizeAllVideo();

  const normalizeAllAudioPlayback = () => normalizeAudioPlaybackState(Store, P);
  [P.A_EN, P.A_BST, P.PB_EN, P.PB_RATE].forEach(k => Store.sub(k, normalizeAllAudioPlayback)); normalizeAllAudioPlayback();

  const FEATURES = { audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN) };
  const Registry = createRegistry(Scheduler), Targeting = createTargeting();

  initSpaUrlDetector((nextUrl) => {
    log.info('SPA URL changed, rescanning...', nextUrl);
    waitForVisibility().then(() => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} });
  });

  waitForVisibility().then(() => {
    (function ensureRegistryAfterBodyReady() {
      let ran = false;
      const runOnce = () => {
        if (ran) return; ran = true;
        try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {}
      };
      if (document.body) { runOnce(); return; }
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
      document.addEventListener('DOMContentLoaded', runOnce, { once: true, signal: __globalSig });
    })();

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, IS_LOW_END: CONFIG.IS_LOW_END });
    const FiltersGL = createFiltersWebGL(Utils);
    const Audio = createAudio(Store);

    __vscClearVideoFilter = (v) => Filters.clear(v);
    __vscClearVideoFilterGL = (v) => FiltersGL.clear(v);

    const ZoomManager = createZoomManager();
    window.__VSC_INTERNAL__.ZoomManager = ZoomManager;

    const makeUI = createUIFactory(ENABLE_UI), UI = makeUI(Store, Registry, Scheduler, Bus, Utils);

    window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 }; window.__lastClickedVideo = null; window.__lastClickT = 0;
    function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} } let __vscLastUserSignalT = 0;
    function findVideoFromPointerEvent(e) { const path = typeof e.composedPath === 'function' ? e.composedPath() : null; if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } } const el = document.elementFromPoint(e.clientX, e.clientY); if (el?.tagName === 'VIDEO') return el; return el?.closest?.('video') || null; }

    window.addEventListener('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); window.__lastClickT = now; const v = findVideoFromPointerEvent(e); if (v) window.__lastClickedVideo = v; signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });
    window.addEventListener('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });
    window.addEventListener('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); }, { signal: __globalSig });
    window.addEventListener('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });

    const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Bus, Filters, FiltersGL, Audio, UI, DEFAULTS, FEATURES, Utils, P, Targeting });
    window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__;

    window.addEventListener('keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (!(e.altKey && e.shiftKey && e.code === 'KeyP')) return;
        const v = __VSC_APP__?.getActiveVideo(); if (!v) return; await togglePiPFor(v);
    }, { capture: true, signal: __globalSig });

    (function addPageLifecycleHooks() {
      window.addEventListener('freeze', () => { try { window.__VSC_INTERNAL__?.App?.getActiveVideo() && window.__VSC_INTERNAL__?.Bus?.signal?.({ forceApply: true }); } catch (_) {} }, { capture: true, signal: __globalSig });
      window.addEventListener('pageshow', () => { try { window.__VSC_INTERNAL__?.Bus?.signal?.({ forceApply: true }); } catch (_) {} }, { capture: true, signal: __globalSig });
      document.addEventListener('visibilitychange', () => { try { const bus = window.__VSC_INTERNAL__?.Bus; if (!bus) return; if (document.visibilityState === 'visible') bus.signal({ forceApply: true }); } catch (_) {} }, { passive: true, signal: __globalSig });
      window.addEventListener('resume', () => { try { window.__VSC_INTERNAL__?.Bus?.signal?.({ forceApply: true }); } catch (_) {} }, { capture: true, signal: __globalSig });
    })();

    watchIframes();
  });

})();
