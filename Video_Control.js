// ==UserScript==
// @name        Video_Control (v159.4.2.14_UltraSlim)
// @namespace   https://github.com/
// @version     159.4.2.14
// @description Video Control: UltraSlim Edition. SVG Rendering, Standard AE AI, Document PiP, Zero-Alloc, WeakMap State
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

  window.__VSC_INTERNAL__ ||= {};
  let __vscClearVideoFilter = null;
  let __vscUserSignalRev = 0;

  function vscSignal(payload) {
    try { window.__VSC_INTERNAL__?.Bus?.signal?.(payload); } catch (_) {}
  }

  function isEditableTarget(t) {
    return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  }

  const __globalHooksAC = new AbortController();
  const __globalSig = __globalHooksAC.signal;

  const EXPERIMENTAL = Object.freeze({ APPLY_ALL_VISIBLE_VIDEOS: false, EXTRA_APPLY_TOPK: 2 });
  const AE_ZERO = Object.freeze({ gain: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, hiRisk: 0, cf: 0.5, mid: 0, rd: 0, skinScore: 0, luma: 0, clipFrac: 0 });

  const AE_MIX_TUNE = Object.freeze({
    standard:  Object.freeze({ expBase: 1.00, toneBase: 1.00, conflictK: 1.00 }),
    bright:    Object.freeze({ expBase: 1.05, toneBase: 1.02, conflictK: 0.95 }),
    cinemaHdr: Object.freeze({ expBase: 0.88, toneBase: 0.90, conflictK: 1.25 })
  });
  const AE_AUTO_MIX_BIAS = Object.freeze({
    standard:  Object.freeze({ exp: 1.00, tone: 1.00 }),
    bright:    Object.freeze({ exp: 1.05, tone: 0.96 }),
    cinemaHdr: Object.freeze({ exp: 0.82, tone: 0.86 })
  });

  function detectMobile() {
    try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {}
    return /Mobi|Android|iPhone/i.test(navigator.userAgent);
  }
  function detectLowEnd() {
    const mem = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : 4;
    const cores = Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
    const saveData = !!navigator.connection?.saveData;
    return mem < 4 || cores <= 4 || saveData;
  }

  const __IS_LOW_END = detectLowEnd();
  const CONFIG = Object.freeze({
    VERSION: "v159.4.2.14_UltraSlim", IS_MOBILE: detectMobile(), IS_LOW_END: __IS_LOW_END, TOUCHED_MAX: __IS_LOW_END ? 60 : 140,
    VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: false
  });

  const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
  const log = {
    error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args),
    warn:  (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args),
    info:  (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args),
    debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args),
  };

  const videoStateMap = new WeakMap();
  function getVState(v) {
    let st = videoStateMap.get(v);
    if (!st) {
      st = {
        visible: false, rect: null, ir: 0, bound: false, rateState: null,
        tainted: false, applied: false, desiredRate: undefined,
        lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false
      };
      videoStateMap.set(v, st);
    }
    return st;
  }

  const ENABLE_UI = true;
  const AE_COMMON = Object.freeze({ CLIP_FRAC_LIMIT: 0.0032, DEAD_IN: 0.035, TAU_UP: 820, TAU_DOWN: 760, TAU_AGGRESSIVE: 220, SAT_MIN: 0.88, SAT_MAX: 1.16, DT_CAP_MS: 220 });

  const AE_STANDARD_PROFILE = Object.freeze({
    STRENGTH: CONFIG.IS_MOBILE ? 0.52 : 0.62, TARGET_MID_BASE: 0.30, MAX_UP_EV: CONFIG.IS_MOBILE ? 0.48 : 0.50, MAX_DOWN_EV: CONFIG.IS_MOBILE ? -0.32 : -0.36, TONE_BIAS: 0.0, TEMP_BIAS: 0, LOOK: { brMul: 0.98, satMul: 0.98, conMul: 1.00 }
  });

  const PRESETS = Object.freeze({
    tone: {
      off: null,
      neutral: { label: '기본', toe: 0.0, shoulder: 0.0, mid: 0.0, con: 1.00, sat: 1.00, br: 0.0, tmp: 0.0 },
      redSkin: { label: '피부', toe: 1.4, shoulder: 0.6, mid: 0.35, con: 1.03, sat: 1.05, br: 0.8, tmp: +2.0 },
      gvfFilm: { label: '필름', toe: 0.2, shoulder: 0.3, mid: 0.0, con: 1.08, sat: 1.08, br: 1.0, tmp: 2.0 },
      gvfAnime: { label: '애니', toe: 0.0, shoulder: 0.0, mid: 0.1, con: 1.10, sat: 1.16, br: 3.0, tmp: 0.0 },
      gvfGaming: { label: '게이밍', toe: 0.0, shoulder: 0.0, mid: 0.0, con: 1.12, sat: 1.06, br: 1.0, tmp: 0.0 },
      gvfVibrant: { label: '생동감', toe: 0.0, shoulder: 0.0, mid: 0.0, con: 1.05, sat: 1.35, br: 0.0, tmp: 0.0 },
    },
    detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 5, sharp2Add: 6, clarityAdd: 5 }, M: { sharpAdd: 10, sharp2Add: 12, clarityAdd: 8 }, L: { sharpAdd: 18, sharp2Add: 22, clarityAdd: 12 }, XL: { sharpAdd: 25, sharp2Add: 35, clarityAdd: 15 } },
    grade: { brOFF: { gammaF: 1.00, brightAdd: 0, conF: 1.00, satF: 1.00, tempAdd: 0 }, S: { gammaF: 1.00, brightAdd: 2, conF: 1.00, satF: 1.00, tempAdd: 0 }, M: { gammaF: 1.08, brightAdd: 4, conF: 1.00, satF: 1.00, tempAdd: 0 }, L: { gammaF: 1.16, brightAdd: 6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DS: { gammaF: 1.00, brightAdd: 3.6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DM: { gammaF: 1.10, brightAdd: 7.2, conF: 1.00, satF: 1.00, tempAdd: 0 }, DL: { gammaF: 1.22, brightAdd: 10.8, conF: 1.00, satF: 1.00, tempAdd: 0 } }
  });

  const DEFAULTS = { video: { ae: false, presetS: 'off', presetB: 'brOFF', presetMix: 1.0, tonePreset: 'off', toneStrength: 1.0, aeStrength: 1.0 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: EXPERIMENTAL.APPLY_ALL_VISIBLE_VIDEOS, extraTopK: EXPERIMENTAL.EXTRA_APPLY_TOPK } };
  const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_EXTRA_TOPK: 'app.extraTopK', V_AE: 'video.ae', V_AE_STR: 'video.aeStrength', V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });

  (function patchAttachShadowOnce() {
    try {
      const proto = Element.prototype;
      if (!proto.attachShadow) return;
      const VSC_PATCH = Symbol.for('vsc.patch.attachShadow');
      if (proto[VSC_PATCH]) return;
      const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
      const orig = desc && desc.value;
      if (typeof orig !== 'function') return;
      try { Object.defineProperty(proto, VSC_PATCH, { value: true }); } catch (_) { proto[VSC_PATCH] = true; }
      function wrappedAttachShadow(init) {
        const shadow = orig.call(this, init);
        try { if (shadow && init && init.mode === 'open') { document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: shadow })); } } catch (_) {}
        return shadow;
      }
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
  window.addEventListener('scroll', bumpRectEpoch, { passive: true, capture: true, signal: __globalSig });
  window.addEventListener('resize', bumpRectEpoch, { passive: true, signal: __globalSig });
  window.addEventListener('orientationchange', bumpRectEpoch, { passive: true, signal: __globalSig });

  function getRectCached(v, now, maxAgeMs = 420) {
    const st = getVState(v);
    const t0 = st.rectT || 0; let r = st.rect; const epoch = st.rectEpoch || 0;
    if (!r || (now - t0) > maxAgeMs || epoch !== __vscRectEpoch) { r = v.getBoundingClientRect(); st.rect = r; st.rectT = now; st.rectEpoch = __vscRectEpoch; } return r;
  }

  const __vscElemIds = new WeakMap(); let __vscElemIdSeq = 1;
  function getElemId(el) { if (!el) return 0; let id = __vscElemIds.get(el); if (!id) { id = __vscElemIdSeq++; __vscElemIds.set(el, id); } return id; }
  function hashApplySet(set) { let sum = 0 >>> 0, sumSq = 0 >>> 0, xor = 0 >>> 0, n = 0; for (const el of set) { const id = (getElemId(el) | 0) >>> 0; n++; sum = (sum + id) >>> 0; sumSq = (sumSq + Math.imul(id, id)) >>> 0; xor ^= (id + 0x9e3779b9 + ((xor << 6) >>> 0) + (xor >>> 2)) >>> 0; } return `${n}:${sum.toString(36)}:${sumSq.toString(36)}:${xor.toString(36)}`; }

  function* walkRoots(root) {
    if (!root) return;
    yield root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) yield* walkRoots(node.shadowRoot);
      node = walker.nextNode();
    }
  }

  function initSpaUrlDetector(onChanged) {
    let lastUrl = location.href;
    const check = () => {
      const next = location.href;
      if (next !== lastUrl) { lastUrl = next; onChanged(next); }
    };
    const wrap = (fn) => function (...args) {
      const ret = fn.apply(this, args);
      queueMicrotask(check);
      return ret;
    };
    if (typeof history.pushState === 'function') history.pushState = wrap(history.pushState);
    if (typeof history.replaceState === 'function') history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', check, { passive: true, signal: __globalSig });
  }

  function getSelfCode() { try { if (document.currentScript && document.currentScript.textContent) { const t = document.currentScript.textContent.trim(); if (t.length > 200) return t; } } catch (_) { } try { if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.source) return String(GM_info.script.source || ''); } catch (_) { } return null; }
  function injectIntoIframe(iframe, code) { try { const doc = iframe.contentDocument; const win = iframe.contentWindow; if (!doc || !win || win[VSC_BOOT_KEY] || !code) return; const s = doc.createElement('script'); s.type = 'text/javascript'; s.textContent = code; (doc.head || doc.documentElement).appendChild(s); s.remove(); } catch (_) { } }
  function watchIframes() { const code = getSelfCode(); if (!code) return; const scan = () => { try { document.querySelectorAll("iframe").forEach((ifr) => injectIntoIframe(ifr, code)); } catch (_) {} }; const attach = () => { const root = document.documentElement; if (!root) return false; document.addEventListener("load", (e) => { const t = e.target; if (t && t.tagName && t.tagName.toLowerCase() === "iframe") injectIntoIframe(t, code); }, true); new MutationObserver(scan).observe(root, { childList: true, subtree: true }); scan(); return true; }; if (attach()) return; const mo = new MutationObserver(() => { if (attach()) mo.disconnect(); }); try { mo.observe(document, { childList: true, subtree: true }); } catch (_) {} document.addEventListener("DOMContentLoaded", () => { try { attach(); mo.disconnect(); } catch (_) {} }, { once: true }); }

  const fsWraps = new WeakMap();
  function ensureFsWrapper(video) { if (fsWraps.has(video)) return fsWraps.get(video); if (!video || !video.parentNode) return null; const parent = video.parentNode; const wrap = document.createElement('div'); wrap.className = 'vsc-fs-wrap'; wrap.style.cssText = `position: relative; display: inline-block; width: 100%; height: 100%; max-width: 100%; background: black;`; const ph = document.createComment('vsc-video-placeholder'); parent.insertBefore(ph, video); parent.insertBefore(wrap, video); wrap.appendChild(video); wrap.__vscPlaceholder = ph; fsWraps.set(video, wrap); return wrap; }
  function restoreFromFsWrapper(video) { const wrap = fsWraps.get(video); if (!wrap) return; const ph = wrap.__vscPlaceholder; if (ph && ph.parentNode) { ph.parentNode.insertBefore(video, ph); ph.parentNode.removeChild(ph); } if (wrap.parentNode) wrap.parentNode.removeChild(wrap); fsWraps.delete(video); }
  function patchMethodSafe(obj, name, wrappedFn) { try { const ownDesc = Object.getOwnPropertyDescriptor(obj, name); if (ownDesc && ownDesc.writable === false && ownDesc.configurable === false) return false; obj[name] = wrappedFn; if (obj[name] === wrappedFn) return true; } catch (_) {} try { Object.defineProperty(obj, name, { configurable: true, writable: true, value: wrappedFn }); return true; } catch (_) {} return false; }
  function patchFullscreenRequest(video) { const st = getVState(video); if (!video || st.fsPatched) return; st.fsPatched = true; if (typeof video.webkitEnterFullscreen === 'function') return; const origReq = video.requestFullscreen || video.webkitRequestFullscreen || video.msRequestFullscreen; if (!origReq) return; const runWrappedFs = () => { const wrap = ensureFsWrapper(video); const cleanupIfNotFullscreen = () => { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video); }; if (wrap) { const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen; if (typeof req === 'function') { try { const ret = req.call(wrap); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } } } try { const ret = origReq.call(video); if (ret && typeof ret.then === 'function') return ret.catch((err) => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; } }; if (video.requestFullscreen) patchMethodSafe(video, 'requestFullscreen', function () { return runWrappedFs(); }); if (video.webkitRequestFullscreen) patchMethodSafe(video, 'webkitRequestFullscreen', function () { return runWrappedFs(); }); if (video.msRequestFullscreen) patchMethodSafe(video, 'msRequestFullscreen', function () { return runWrappedFs(); }); }
  function onFsChange() { const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; if (!fsEl) document.querySelectorAll('video').forEach(v => { if (fsWraps.has(v)) restoreFromFsWrapper(v); }); if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure(); }
  document.addEventListener('fullscreenchange', onFsChange, { signal: __globalSig });
  document.addEventListener('webkitfullscreenchange', onFsChange, { signal: __globalSig });

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

  const TARGETING_WEIGHTS = Object.freeze({ playing: 6.0, hasTime: 2.4, area: 1.2, dist: 3.0, audible: 1.35, pipBoostVisible: 2.4, pipBoostHidden: 3.8, clickedBoost: 2.0, bgPenaltyMutedAutoplayNoControls: 1.1, bgPenaltyEdge: 0.9, bgPenaltyTiny: 0.8, bgPenaltyLoop: 0.35 });

  function createTargeting({ Utils }) {
    const __applySetReuse = new Set(), __topBuf = [], __limitedBuf = []; const __lastTopCandidates = [];
    const __pickRes = { target: null, bestScore: -Infinity, curScore: -Infinity, delta: 0, secondScore: -Infinity, now: 0, topCandidates: __lastTopCandidates };
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
    function scoreVideoPrepared(f, now, lastUserPt, vp) {
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
      return (playing * W.playing) + (hasTime * W.hasTime) + (areaScore * W.area) + (distScore * (W.dist * 0.72)) + (centerScore * 0.75) + userBoost + irScore + (audible * W.audible) + pipBoost + clickedBoost - bgPenalty;
    }
    function preScoreCandidate(f) { const v = f.v, irTerm = Math.min(1, f.ir) * 3.0, areaTerm = Math.log2(1 + f.area / 20000) * 1.2, playingTerm = (!v.paused && !v.ended) ? 1.2 : 0, hasTimeTerm = (v.currentTime > 0.2) ? 0.4 : 0, audibleTerm = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 0.7 : 0, pipTerm = f.pip ? 3.5 : 0; return irTerm + areaTerm + playingTerm + hasTimeTerm + audibleTerm + pipTerm; }
    function pushCandidateForced(buf, f, N) { if (!f) return; for (let i = 0; i < buf.length; i++) { if (buf[i].f?.v === f.v) return; } insertTopN(buf, { f, s: Infinity }, N); }
    const pickDetailed = (videos, lastUserPt) => {
      const now = performance.now(), vv = window.visualViewport, vp = vv ? { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 } : { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
      if (!videos || videos.size === 0) { __pickRes.target = null; __pickRes.bestScore = -Infinity; __pickRes.curScore = -Infinity; __pickRes.delta = 0; __pickRes.secondScore = -Infinity; __pickRes.now = now; return __pickRes; }
      const MAX_CAND_PRE = 14; __limitedBuf.length = 0;
      for (const v of videos) { const f = buildCandidateFeature(v, now); if (!f) continue; insertTopN(__limitedBuf, { f, s: preScoreCandidate(f) }, MAX_CAND_PRE); }
      const activeVideo = window.__VSC_INTERNAL__.App?.getActiveVideo();
      if (activeVideo && videos.has(activeVideo)) { pushCandidateForced(__limitedBuf, buildCandidateFeature(activeVideo, now), MAX_CAND_PRE); }
      const pipEl = document.pictureInPictureElement;
      if (pipEl && videos.has(pipEl)) { pushCandidateForced(__limitedBuf, buildCandidateFeature(pipEl, now), MAX_CAND_PRE); }
      let best = activeVideo, bestScore = -Infinity, secondScore = -Infinity, curScore = -Infinity;
      if (activeVideo && videos.has(activeVideo)) { const fCur = buildCandidateFeature(activeVideo, now); if (fCur) curScore = scoreVideoPrepared(fCur, now, lastUserPt, vp); best = activeVideo; bestScore = curScore; }
      __lastTopCandidates.length = 0;
      for (const it of __limitedBuf) { const s = scoreVideoPrepared(it.f, now, lastUserPt, vp); if (Number.isFinite(s)) insertTopN(__lastTopCandidates, { v: it.f.v, s }, 6); if (s > bestScore) { secondScore = bestScore; bestScore = s; best = it.f.v; } else if (s > secondScore) { secondScore = s; } }
      if (!Number.isFinite(bestScore) || bestScore === -Infinity) { __pickRes.target = null; __pickRes.bestScore = -Infinity; __pickRes.curScore = curScore; __pickRes.delta = 0; __pickRes.secondScore = secondScore; __pickRes.now = now; return __pickRes; }
      let delta = bestScore - curScore; __pickRes.target = best; __pickRes.bestScore = bestScore; __pickRes.curScore = curScore; __pickRes.delta = delta; __pickRes.secondScore = secondScore; __pickRes.now = now;
      return __pickRes;
    };
    const buildApplySetReuse = (visibleVideos, target, extraApplyTopK, applyToAllVisibleVideos, lastUserPt, topCandidates) => {
      __applySetReuse.clear();
      if (applyToAllVisibleVideos) { for (const v of visibleVideos) __applySetReuse.add(v); return __applySetReuse; }
      if (target) __applySetReuse.add(target);
      const N = Math.max(0, extraApplyTopK | 0); if (N <= 0) return __applySetReuse;
      if (topCandidates && topCandidates.length) { for (const it of topCandidates) { if (it.v !== target) __applySetReuse.add(it.v); if (__applySetReuse.size >= (target ? N + 1 : N)) break; } return __applySetReuse; }
      const now = performance.now(), vv = window.visualViewport, vp = vv ? { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 } : { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
      __topBuf.length = 0;
      for (const v of visibleVideos) { if (!v || v === target) continue; const f = buildCandidateFeature(v, now); const s = f ? scoreVideoPrepared(f, now, lastUserPt, vp) : -Infinity; if (s > -1e8) insertTopN(__topBuf, { v, s }, N); }
      for (let i = 0; i < __topBuf.length; i++) __applySetReuse.add(__topBuf[i].v);
      return __applySetReuse;
    };
    return Object.freeze({ pickDetailed, buildApplySetReuse });
  }

  function createEventBus() {
    const subs = new Map();
    const on = (name, fn) => { let s = subs.get(name); if (!s) { s = new Set(); subs.set(name, s); } s.add(fn); return () => s.delete(fn); };
    const emit = (name, payload) => { const s = subs.get(name); if (!s) return; for (const fn of s) { try { fn(payload); } catch (_) {} } };
    let queued = false, flushTimer = 0, aeLevelAgg = 0, forceApplyAgg = false, lockMsAgg = 0, lockAmpAgg = 0;
    function flush() { queued = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; } const payload = { aeLevel: aeLevelAgg, forceApply: forceApplyAgg, userLockMs: lockMsAgg, userLockAmp: lockAmpAgg }; emit('signal', payload); aeLevelAgg = 0; forceApplyAgg = false; lockMsAgg = 0; lockAmpAgg = 0; }
    const signal = (p) => { if (p) { if (p.affectsAE) aeLevelAgg = Math.max(aeLevelAgg, 2); if (p.wakeAE) aeLevelAgg = Math.max(aeLevelAgg, 1); if (p.aeLevel != null) aeLevelAgg = Math.max(aeLevelAgg, (p.aeLevel | 0)); if (p.forceApply) forceApplyAgg = true; if (p.userLockMs) lockMsAgg = Math.max(lockMsAgg, (p.userLockMs | 0)); if (p.userLockAmp != null) lockAmpAgg = Math.max(lockAmpAgg, +p.userLockAmp); } if (!queued) { queued = true; if (document.visibilityState === 'hidden') { flushTimer = setTimeout(flush, 0); } else { requestAnimationFrame(flush); } } };
    return Object.freeze({ on, emit, signal });
  }

  function createABFilter({ alpha = 0.24, beta = 0.06, init = 0 }) {
    let x = init, v = 0, inited = false;
    return { reset(next = 0) { x = next; v = 0; inited = true; }, update(measured, dtSec = 1 / 30) { if (!inited) { x = measured; v = 0; inited = true; return x; } const xp = x + v * dtSec, r = measured - xp; x = xp + alpha * r; v = v + (beta * r) / Math.max(1e-4, dtSec); return x; }, value() { return x; } };
  }

  function computeAeMix3Into(outMix, vf, aeMeta, Utils, userLock01) {
    const { clamp } = Utils; const mix = clamp(vf.presetMix ?? 1.0, 0, 1); const pB = PRESETS.grade[vf.presetB] || PRESETS.grade.brOFF;
    const presetExp = Math.abs((pB.brightAdd || 0) * mix) / 55 + Math.abs(((pB.gammaF || 1) - 1) * mix) / 0.32 + Math.abs(((pB.conF || 1) - 1) * mix) / 0.26;
    const presetCol = Math.abs(((pB.satF || 1) - 1) * mix) / 0.30 + Math.abs((pB.tempAdd || 0) * mix) / 12;
    const toneStr = (!!vf.tonePreset && vf.tonePreset !== 'off' && vf.tonePreset !== 'neutral') ? clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;

    const expIntent = clamp(presetExp + toneStr * 0.18, 0, 3.0), toneIntent = clamp(presetCol + toneStr * 0.55, 0, 3.5), colorIntent = clamp((presetCol * 1.15) + toneStr * 0.20, 0, 3.0);
    let expMix = clamp(1 - 0.60 * clamp(expIntent / 1.45, 0, 1), 0.20, 1.00), toneMix = clamp(1 - 0.75 * clamp(toneIntent / 1.45, 0, 1), 0.08, 1.00), colorMix = clamp(1 - 0.82 * clamp(colorIntent / 1.30, 0, 1), 0.05, 1.00);

    const tune = AE_MIX_TUNE.standard, bias = AE_AUTO_MIX_BIAS.standard;
    const conf01 = clamp((presetExp * 0.50 + presetCol * 0.70 + toneStr * 0.55) / 2.35, 0, 1);
    expMix *= tune.expBase * bias.exp * (1 - conf01 * (0.34 * tune.conflictK)); toneMix *= tune.toneBase * bias.tone * (1 - conf01 * (0.58 * tune.conflictK)); colorMix *= (0.96 + 0.04 * bias.tone) * (1 - conf01 * (0.64 * tune.conflictK));

    const hi = clamp(aeMeta?.hiRisk ?? 0, 0, 1); if (hi > 0.02) { expMix *= (1 - 0.10 * hi); toneMix *= (1 - 0.26 * hi); colorMix *= (1 - 0.20 * hi); }
    const colorHeavy01 = clamp((presetCol * 0.8 + toneStr * 0.4) / 1.8, 0, 1); expMix *= (1 - 0.14 * colorHeavy01);

    const lock = clamp(userLock01 || 0, 0, 1); expMix *= (1 - 0.80 * lock); toneMix *= (1 - 0.90 * lock); colorMix *= (1 - 0.92 * lock);
    const expFloor = (conf01 > 0.75) ? 0.02 : 0.10, toneFloor = (conf01 > 0.75) ? 0.00 : 0.05, colorFloor = (conf01 > 0.75) ? 0.00 : 0.04;
    outMix.expMix = Math.round(clamp(expMix, expFloor, 1.00) / 0.02) * 0.02; outMix.toneMix = Math.round(clamp(toneMix, toneFloor, 1.00) / 0.02) * 0.02; outMix.colorMix = Math.round(clamp(colorMix, colorFloor, 1.00) / 0.02) * 0.02;
  }

  function computeToneStrengthEff(vf, ae, Utils) {
    if (!vf?.tonePreset || vf.tonePreset === 'off' || vf.tonePreset === 'neutral') return 0;
    const t0 = Utils.clamp(vf.toneStrength ?? 1.0, 0, 1); if (!ae) return t0;
    let damp = 1.0 * (1 - 0.22 * Utils.clamp(ae.hiRisk ?? 0, 0, 1)) * (1 - 0.18 * Utils.clamp((ae.clipFrac ?? 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1)) * (0.90 + 0.10 * Utils.clamp(ae.cf ?? 0.5, 0, 1));
    if (vf.tonePreset === 'highlight') damp *= (1 - 0.16 * Utils.clamp(ae.hiRisk ?? 0, 0, 1));
    if (vf.tonePreset === 'redSkin') damp *= (1 - 0.18 * Utils.clamp(((ae.skinScore ?? 0) - 0.06) / 0.09, 0, 1));
    return Utils.clamp(t0 * damp, 0, 1);
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
        children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
        return el;
      },
      deepClone: (x) => (window.structuredClone ? structuredClone(x) : JSON.parse(JSON.stringify(x))),
      createLRU: (max = 384) => { const m = new Map(); return { get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); } }; }
    };
  }

  function tempToRgbGain(temp) {
    const t = Math.max(-25, Math.min(25, Number(temp) || 0));
    let rs = 1, gs = 1, bs = 1;
    if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.010; }
    else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.010; }
    return { rs, gs, bs };
  }

  function createFrameDriver() {
    let rafId = 0, timerId = 0, rvfcId = 0, lastVideo = null;
    function clear() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (timerId) { clearTimeout(timerId); timerId = 0; }
      if (lastVideo && rvfcId && typeof lastVideo.cancelVideoFrameCallback === 'function') {
        try { lastVideo.cancelVideoFrameCallback(rvfcId); } catch (_) {}
      }
      rvfcId = 0;
    }
    function scheduleVideoFrame(nextVideo, cb, fallback = 'raf', fallbackMs = 90) {
      clear(); lastVideo = nextVideo || null;
      if (lastVideo && !lastVideo.paused && typeof lastVideo.requestVideoFrameCallback === 'function') {
        try { rvfcId = lastVideo.requestVideoFrameCallback((now, meta) => { rvfcId = 0; cb(now, meta); }); return; } catch (_) {}
      }
      if (fallback === 'timeout') { timerId = setTimeout(() => { timerId = 0; cb(performance.now(), null); }, fallbackMs); }
      else { rafId = requestAnimationFrame((t) => { rafId = 0; cb(t, null); }); }
    }
    return Object.freeze({ clear, scheduleVideoFrame });
  }

  function applyTonePreset2Inline(out, presetName, strength, Utils) {
    if (!presetName || presetName === 'off') return out; const p0 = PRESETS.tone[presetName]; if(!p0) return out;
    let t = Utils.clamp(strength ?? 1.0, 0, 1), toe = p0.toe, shoulder = p0.shoulder, mid = p0.mid, con = p0.con, sat = p0.sat, br = p0.br, tmp = p0.tmp;
    out.mid = Utils.clamp((out.mid || 0) + (mid * t), -1, 1); out.contrast = Utils.clamp((out.contrast || 1) * (1 + (con - 1) * t), 0.5, 2.0); out.satF = Utils.clamp((out.satF || 1) * (1 + (sat - 1) * t), 0.0, 2.0); out.bright = Utils.clamp((out.bright || 0) + (br * t), -50, 50); out.temp = Utils.clamp((out.temp || 0) + (tmp * t), -25, 25); out.toe = Utils.clamp((out.toe || 0) + (toe * t), -14, 14); out.shoulder = Utils.clamp((out.shoulder || 0) + (shoulder * t), -14, 14);
    return out;
  }

  function applyTempSatCap(out, clamp) {
    out.temp = clamp(out.temp || 0, -25, 25); const tempStress01 = clamp(Math.abs(out.temp || 0) / 18, 0, 1);
    if (tempStress01 > 0) { const satCap = 1.18 - 0.10 * tempStress01; out.satF = clamp(out.satF, 0.0, satCap); } else { out.satF = clamp(out.satF, 0.0, 2.0); }
  }

  function composeVideoParamsInto(out, vUser, ae, Utils) {
    const clamp = Utils.clamp; const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);
    const GVF_BASE_CON = 1.10, GVF_BASE_SAT = 1.15, GVF_BASE_TOE = 0.65;
    const pD = PRESETS.detail[vUser.presetS] || PRESETS.detail.off, pB = PRESETS.grade[vUser.presetB] || PRESETS.grade.brOFF;
    const preGammaF = lerp(1.0, pB.gammaF, mix), preConF = lerp(1.0, pB.conF, mix), preSatF = lerp(1.0, pB.satF, mix), preBright = (pB.brightAdd || 0) * mix, preTemp = (pB.tempAdd || 0) * mix;
    const preSharp = (pD.sharpAdd || 0) * mix, preSharp2 = (pD.sharp2Add || 0) * mix, preClarity = (pD.clarityAdd || 0) * mix;
    const A = ae || AE_ZERO;
    let gamma = preGammaF, contrast = preConF * (A.conF || 1.0) * GVF_BASE_CON, satF = preSatF * (A.satF || 1.0) * GVF_BASE_SAT, bright = preBright + (A.brightAdd || 0), temp = preTemp + (A.tempAdd || 0);
    const gain = clamp(A.gain ?? 1.0, 0.60, 8.0);
    let sharpMul = Math.max(0.88, 1 / (1 + (gain - 1.0) * 0.4)) * (1 - Math.min(0.08, (A.hiRisk || 0) * 0.1)) * (0.92 + 0.08 * Math.max(0, Math.min(1, ((A.cf != null ? A.cf : 0.5) - 0.10) / 0.22)));
    const chromaStress = (Math.min(1, Math.abs(satF - 1) / 0.55) * 0.85) + (Math.min(1, Math.abs(temp) / 25) * 0.65);
    const riskStress = (clamp(A.hiRisk || 0, 0, 1) * 0.70) + ((1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1)) * 0.45);
    const guard = 1 / (1 + chromaStress * 0.15 + riskStress * 0.15); sharpMul *= (0.92 + 0.08 * guard);
    const hiRisk01 = clamp(A.hiRisk || 0, 0, 1); const clip01 = clamp((A.clipFrac || 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1); const flat01 = 1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1);
    const aeDetailGuard = 1 - (hiRisk01 * 0.10 + clip01 * 0.06 + flat01 * 0.04); sharpMul *= clamp(aeDetailGuard, 0.82, 1.0);
    let sharp = preSharp * sharpMul, sharp2 = preSharp2 * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2))), clarity = preClarity * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2)));
    const clarityRiskDamp = 1 - (hiRisk01 * 0.18 + clip01 * 0.10); clarity *= clamp(clarityRiskDamp, 0.72, 1.0);
    const skin01 = clamp(A.skinScore || 0, 0, 1); sharp *= (1 - 0.05 * skin01); sharp2 *= (1 - 0.10 * skin01);
    out.gain = gain; out.gamma = clamp(gamma, 0.5, 2.5); out.contrast = clamp(contrast, 0.5, 2.3); out.bright = clamp(bright, -50, 50); out.mid = clamp(A.mid || 0, -1, 1); out.sharp = clamp(sharp, 0, 50); out.sharp2 = clamp(sharp2, 0, 50); out.clarity = clamp(clarity, 0, 50); out.dither = 0; out.temp = clamp(temp, -25, 25);
    out.toe = clamp((A.toe || 0) + GVF_BASE_TOE, 0, 15); out.shoulder = A.shoulder || 0;
    applyTempSatCap(out, clamp);
    if (vUser.tonePreset && vUser.tonePreset !== 'off' && vUser.tonePreset !== 'neutral') { applyTonePreset2Inline(out, vUser.tonePreset, vUser.toneStrength, Utils); applyTempSatCap(out, clamp); out.contrast = clamp(out.contrast, 0.5, 2.3); out.bright   = clamp(out.bright, -50, 50); }
    return out;
  }

  const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

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
    const state = Utils.deepClone(defaults); const proxyCache = {}; let batchDepth = 0, batchChanged = false; const batchEmits = new Map();
    function flushBatch() { if (!batchChanged) return; rev++; for (const [key, val] of batchEmits) { emit(key, val); } batchEmits.clear(); batchChanged = false; scheduler.request(false); }
    function notifyChange(fullPath, val) { if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; } rev++; emit(fullPath, val); scheduler.request(false); }
    function createProxyDeep(obj, pathPrefix) { return new Proxy(obj, { get(target, prop) { if (typeof target[prop] === 'object' && target[prop] !== null) { const cacheKey = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); if (!proxyCache[cacheKey]) proxyCache[cacheKey] = createProxyDeep(target[prop], cacheKey); return proxyCache[cacheKey]; } return target[prop]; }, set(target, prop, val) { if (!Object.is(target[prop], val)) { target[prop] = val; const fullPath = pathPrefix ? `${pathPrefix}.${String(prop)}` : String(prop); notifyChange(fullPath, val); } return true; } }); }
    const proxyState = createProxyDeep(state, '');
    return { state: proxyState, rev: () => rev, getCatRef: (cat) => proxyState[cat], get: (p) => { const [c, k] = p.split('.'); return state[c]?.[k]; }, set: (p, val) => { const [c, k] = p.split('.'); if (k) proxyState[c][k] = val; }, batch: (cat, obj) => { batchDepth++; try { for (const [k, v] of Object.entries(obj)) proxyState[cat][k] = v; } finally { batchDepth--; if (batchDepth === 0) flushBatch(); } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => { const cur = listeners.get(k); if (cur) cur.delete(f); }; } };
  }

  function normalizeNumberPath(sm, path, fallback, min = -Infinity, max = Infinity, isInt = false) { let v = +sm.get(path); if (!Number.isFinite(v)) v = fallback; if (isInt) v = Math.round(v); v = Math.min(max, Math.max(min, v)); if (!Object.is(sm.get(path), v)) sm.set(path, v); return v; }

  function normalizeVideoState(sm, PRESETS, P, Utils) {
    const tone = sm.get(P.V_TONE_PRE); if (tone !== 'off' && !(tone in PRESETS.tone)) sm.set(P.V_TONE_PRE, 'off');
    const pS = sm.get(P.V_PRE_S); if (!(pS in PRESETS.detail)) sm.set(P.V_PRE_S, 'off');
    const pB = sm.get(P.V_PRE_B); if (!(pB in PRESETS.grade)) sm.set(P.V_PRE_B, 'brOFF');
    normalizeNumberPath(sm, P.V_PRE_MIX, 1.0, 0, 1); normalizeNumberPath(sm, P.V_AE_STR, 1.0, 0, 1); normalizeNumberPath(sm, P.V_TONE_STR, 1.0, 0, 1);
  }

  function normalizeAudioPlaybackState(sm, P) {
    const pbEn = !!sm.get(P.PB_EN); if (sm.get(P.PB_EN) !== pbEn) sm.set(P.PB_EN, pbEn);
    normalizeNumberPath(sm, P.PB_RATE, 1.0, 0.07, 16);
  }

  function createRegistry(scheduler) {
    const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    const shadowRootsLRU = []; const SHADOW_LRU_MAX = CONFIG.IS_LOW_END ? 8 : 24; const observedShadowHosts = new WeakSet();
    let __refreshQueued = false; function requestRefreshCoalesced() { if (__refreshQueued) return; __refreshQueued = true; requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); }); }
    const io = new IntersectionObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el); st.visible = isVis; st.ir = e.intersectionRatio || 0; st.rect = e.boundingClientRect; st.rectT = now; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, { root: null, threshold: 0.01, rootMargin: CONFIG.IS_LOW_END ? '120px' : '300px' });
    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
    const ro = new ResizeObserver((entries) => { let changed = false; const now = performance.now(); for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); st.rect = e.contentRect ? el.getBoundingClientRect() : null; st.rectT = now; st.rectEpoch = -1; dirty.videos.add(el); changed = true; } if (changed) requestRefreshCoalesced(); });
    const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; patchFullscreenRequest(el); videos.add(el); io.observe(el); try { ro.observe(el); } catch (_) {} };
    const WorkQ = (() => { const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap(); const isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling); function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); } const schedule = () => { if (scheduled) return; scheduled = true; if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }; const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); }; const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} } }; const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; const shouldYieldForInput = () => { try { return !!isInputPending?.({ includeContinuous: true }); } catch (_) { return false; } }; while (bigHead < bigQ.length && budget()) { if (shouldYieldForInput()) break; scanNode(bigQ[bigHead++]); break; } while (head < q.length && budget()) { if (shouldYieldForInput()) break; scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); }; return Object.freeze({ enqueue }); })();
    function nodeMayContainVideo(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') return true; if ((n.childElementCount || 0) === 0) return false; try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } } } try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; } }
    const observers = new Set(); const connectObserver = (root) => { if (!root) return; const mo = new MutationObserver((muts) => { let touchedVideoTree = false; for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); if (!touchedVideoTree && nodeMayContainVideo(n)) touchedVideoTree = true; } } if (!touchedVideoTree && m.removedNodes && m.removedNodes.length) { for (const n of m.removedNodes) { if (!n || n.nodeType !== 1) continue; if (n.tagName === 'VIDEO') { touchedVideoTree = true; break; } if ((n.childElementCount || 0) > 0) { try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {} } } } } if (touchedVideoTree) requestRefreshCoalesced(); }); mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root); };
    const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
    document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail; const host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} }); refreshObservers();
    let pruneIterVideos = null; function pruneBatchRoundRobinNoAlloc(set, visibleSet, dirtySet, unobserveFn, batch = 200) { let removed = 0; let scanned = 0; if (!pruneIterVideos) pruneIterVideos = set.values(); while (scanned < batch) { let n = pruneIterVideos.next(); if (n.done) { pruneIterVideos = set.values(); n = pruneIterVideos.next(); if (n.done) break; } const el = n.value; if (el && !el.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} try { ro.unobserve(el); } catch (_) {} removed++; } scanned++; } return removed; }
    return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneBatchRoundRobinNoAlloc(videos, visible.videos, dirty.videos, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220); if(removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { for (const r of walkRoots(document.body || document.documentElement)) { WorkQ.enqueue(r); } } };
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(CONFIG.IS_LOW_END ? 320 : 720);
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
        nodes.st.lastKey = key; const st = nodes.st, steps = CONFIG.IS_LOW_END ? 96 : 128;
        const gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08; const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(clamp(s.mid||0,-1,1),0.02)}|${qInt(s.gain||1,gainQ)}`;
        if (st.toneKey !== tk) { st.toneKey = tk; const table = getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.gain||1,gainQ)*gainQ); if (st.toneTable !== table) { st.toneTable = table; for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', table); } }
        const con = clamp(s.contrast || 1, 0.5, 2.0), brightOffset = clamp((s.bright || 0) / 1000, -0.2, 0.2), intercept = clamp(0.5 * (1 - con) + brightOffset, -1, 1), bcLinKey = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
        if (st.bcLinKey !== bcLinKey) { st.bcLinKey = bcLinKey; for (const fn of nodes.bcLinFuncs) { fn.setAttribute('slope', con.toFixed(3)); fn.setAttribute('intercept', intercept.toFixed(4)); } }
        const gk = (1/clamp(s.gamma||1,0.2,3)).toFixed(4); if (st.gammaKey !== gk) { st.gammaKey = gk; for (const fn of nodes.gamFuncs) fn.setAttribute('exponent', gk); }
        setAttr(nodes.sat, 'values', clamp(s.satF ?? 1, 0, 2.5).toFixed(2), st, 'satKey');
        const { rs, gs, bs } = tempToRgbGain(s.temp);
        const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`; if (st.tempKey !== tmk) { st.tempKey = tmk; nodes.tmpFuncs[0].setAttribute('slope', rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', bs.toFixed(3)); }
        const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
        if (st.detailKey !== dk) { st.detailKey = dk; const sc = (x) => x * x * (3 - 2 * x), v1 = (s.sharp || 0) / 50, kC = sc(Math.min(1, v1)) * 1.8; setAttr(nodes.b1, 'stdDeviation', v1 > 0 ? (0.75 - sc(Math.min(1, v1)) * 0.3).toFixed(2) : '0', st, '__b1'); setAttr(nodes.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2'); setAttr(nodes.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3'); const v2 = (s.sharp2 || 0) / 50, kF = sc(Math.min(1, v2)) * 3.8; setAttr(nodes.b2, 'stdDeviation', v2 > 0 ? '0.28' : '0', st, '__b2'); setAttr(nodes.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2'); setAttr(nodes.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3'); const clVal = (s.clarity || 0) / 50; setAttr(nodes.bc, 'stdDeviation', clVal > 0 ? '1.2' : '0', st, '__bc'); setAttr(nodes.cl, 'k2', (1 + clVal).toFixed(3), st, '__clk2'); setAttr(nodes.cl, 'k3', (-clVal).toFixed(3), st, '__clk3'); }
      }
      const url = `url(#${nodes.fid})`; dc.key = key; dc.url = url; return url;
    }
    return {
      prepareCached: (doc, s) => { try { return prepare(doc, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
      applyUrl: (el, url) => {
        if (!el) return; const st = getVState(el);
        if (!url) { if (st.applied) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; } return; }
        if (st.lastFilterUrl === url) return; el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); st.applied = true; st.lastFilterUrl = url;
      },
      clear: (el) => {
        if (!el) return; const st = getVState(el); if (!st.applied) return;
        el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null;
      }
    };
  }

  const WORKER_CODE = `const histAll = new Uint32Array(256), histTop = new Uint32Array(256), histBot = new Uint32Array(256), histMid = new Uint32Array(256); let prevFrame = null, offCanvas = null, offCtx = null; function pctFromHist(h, n, p) { const t = n * p; let a = 0; for(let i=0;i<256;i++){ a += h[i]; if(a >= t) return i/255; } return 1; } function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); } function skinLikeYCbCr(r, g, b, y8) { if (y8 < 35 || y8 > 235) return 0; const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b; const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b; if (cb < 77 || cb > 127 || cr < 133 || cr > 173) return 0; const cbD = Math.abs(cb - 102) / 25; const crD = Math.abs(cr - 153) / 20; const chromaScore = clamp01(1 - (cbD * 0.55 + crD * 0.70)); const bf = b / 255, rf = r / 255, gf = g / 255; const antiBlue = clamp01(1 - Math.max(0, (bf - rf) * 1.8)); const rgBalance = clamp01(1 - Math.abs((rf - gf) - 0.08) * 2.8); return chromaScore * (0.65 + 0.35 * antiBlue) * (0.60 + 0.40 * rgBalance); } self.onmessage = function(e) { const {buf, bitmap, width, height, step, token, seq, epoch, mediaTime} = e.data || {}; if(!width || !height) return; let data; if (bitmap) { if (!offCanvas) { offCanvas = new OffscreenCanvas(width, height); offCtx = offCanvas.getContext('2d', { willReadFrequently: true, alpha: false }); } else if (offCanvas.width !== width || offCanvas.height !== height) { offCanvas.width = width; offCanvas.height = height; } offCtx.drawImage(bitmap, 0, 0, width, height); data = offCtx.getImageData(0, 0, width, height).data; bitmap.close(); } else if (buf) { data = new Uint8ClampedArray(buf); } else { return; } let diff = 0, mCnt = 0, j = 0; const stepM = step; const pLen = Math.ceil(data.length / (4 * stepM)); if (!prevFrame || prevFrame.length !== pLen) { prevFrame = new Uint8Array(pLen); for (let i = 0; i < data.length; i += 4 * stepM) { prevFrame[j++] = (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]) | 0; } diff = 0; } else { for (let i = 0; i < data.length && j < prevFrame.length; i += 4 * stepM) { const y = (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]) | 0; diff += Math.abs(y - prevFrame[j]); prevFrame[j++] = y; mCnt++; } } const motion01 = mCnt ? Math.min(1, Math.max(0, (diff / mCnt) / 28)) : 1; histAll.fill(0); histTop.fill(0); histBot.fill(0); histMid.fill(0); let sumAll=0, sumSqAll=0, nAll=0; let sumTop=0, sumSqTop=0, nTop=0; let sumMid=0, sumSqMid=0, nMid=0; let clipAll=0, clipBottom=0, clipTop=0, clipLowAll=0; let botSum=0, botSumSq=0, botN=0; let botBrightRows=0, botRowCount=0; let botWhitePix=0, botPix=0, botEdgePix=0, botEdgePairs=0, botTextLikePix=0; let rSum=0, gSum=0, bSum=0, skinCnt=0, skinAcc=0; const botY0 = Math.floor(height * 0.78); const midY0 = Math.floor(height * 0.18); const midY1 = Math.floor(height * 0.82); const stride = width * 4; for(let y=0; y<height; y+=step){ const row = y*stride; const isUpperBand = (y < botY0); const isBottomBand = !isUpperBand; const isMid = (y >= midY0 && y < midY1); let rowSum=0, rowSumSq=0, rowCnt=0; let prevRowY = -1; for(let x=0; x<width; x+=step){ const i = row + x*4; const r = data[i], g = data[i+1], b = data[i+2]; const Y = (0.2126*r + 0.7152*g + 0.0722*b) | 0; histAll[Y]++; sumAll += Y; sumSqAll += Y*Y; nAll++; rSum += r; gSum += g; bSum += b; if(isUpperBand) { histTop[Y]++; sumTop += Y; sumSqTop += Y*Y; nTop++; } else { histBot[Y]++; botSum += Y; botSumSq += Y*Y; botN++; } if(isMid) { histMid[Y]++; sumMid += Y; sumSqMid += Y*Y; nMid++; } if(Y >= 251){ clipAll++; if(isBottomBand) clipBottom++; if(isUpperBand) clipTop++; } if(Y <= 4){ clipLowAll++; } if(isBottomBand){ botPix++; rowSum += Y; rowSumSq += Y*Y; rowCnt++; if (Y > 228) botWhitePix++; if (prevRowY >= 0) { const dY = Math.abs(Y - prevRowY); botEdgePairs++; if (dY > 24) botEdgePix++; if (Y > 205 && dY > 18) botTextLikePix++; } prevRowY = Y; } const s = skinLikeYCbCr(r, g, b, Y); if (s > 0) { const nx = (x / Math.max(1, width - 1)) * 2 - 1; const ny = (y / Math.max(1, height - 1)) * 2 - 1; const centerW = clamp01(1 - (Math.abs(nx) * 0.55 + Math.abs(ny) * 0.35)); skinAcc += s * (0.70 + 0.30 * centerW); skinCnt++; } } if (isBottomBand && rowCnt > 0){ botRowCount++; const avg = rowSum / rowCnt, varr = (rowSumSq / rowCnt) - avg*avg, std = Math.sqrt(Math.max(0,varr)); if (avg > 236 && std < 8.5) botBrightRows++; } } const avgAll = nAll ? (sumAll/nAll) : 0, varAll = nAll ? (sumSqAll/nAll - avgAll*avgAll) : 0, stdAll = Math.sqrt(Math.max(0,varAll))/255; const avgTop = nTop ? (sumTop/nTop) : avgAll, varTop = nTop ? (sumSqTop/nTop - avgTop*avgTop) : varAll, stdTop = Math.sqrt(Math.max(0,varTop))/255; const avgMid = nMid ? (sumMid/nMid) : avgAll, varMid = nMid ? (sumSqMid/nMid - avgMid*avgMid) : varAll, stdMid = Math.sqrt(Math.max(0,varMid))/255; const botAvg = botN ? (botSum/botN)/255 : 0, botVar = botN ? (botSumSq/botN - (botSum/botN)**2) : 0, botStd = Math.sqrt(Math.max(0,botVar))/255; const cfAll = Math.min(1, stdAll/0.22), cfTop = Math.min(1, stdTop/0.22), cfMid = Math.min(1, stdMid/0.22); const rgbSum = (rSum+gSum+bSum) || 1, redDominance = Math.max(0, Math.min(1, (rSum/rgbSum) - 0.28)), skinScore = skinCnt ? Math.min(1, (skinAcc/skinCnt) * 1.22) : 0; const botWhiteFrac = botPix ? (botWhitePix / botPix) : 0; const botEdgeFrac = botEdgePairs ? (botEdgePix / botEdgePairs) : 0; const botTextLike = botPix ? (botTextLikePix / botPix) : 0; self.postMessage({ token, seq, epoch, mediaTime, motion01, p05: pctFromHist(histAll, nAll, 0.05), p10: pctFromHist(histAll, nAll, 0.10), p35: pctFromHist(histAll, nAll, 0.35), p50: pctFromHist(histAll, nAll, 0.50), p90: pctFromHist(histAll, nAll, 0.90), p95: pctFromHist(histAll, nAll, 0.95), p98: pctFromHist(histAll, nAll, 0.98), avgLuma: avgAll/255, stdDev: stdAll, cf: cfAll, clipFrac: nAll ? (clipAll/nAll) : 0, clipFracTop: nTop ? (clipTop/nTop) : 0, clipLowFrac: nAll ? (clipLowAll/nAll) : 0, p10T: pctFromHist(histTop, nTop || 1, 0.10), p35T: pctFromHist(histTop, nTop || 1, 0.35), p50T: pctFromHist(histTop, nTop || 1, 0.50), p90T: pctFromHist(histTop, nTop || 1, 0.90), p95T: pctFromHist(histTop, nTop || 1, 0.95), p98T: pctFromHist(histTop, nTop || 1, 0.98), stdDevT: stdTop, cfT: cfTop, p10M: pctFromHist(histMid, nMid || 1, 0.10), p35M: pctFromHist(histMid, nMid || 1, 0.35), p50M: pctFromHist(histMid, nMid || 1, 0.50), p90M: pctFromHist(histMid, nMid || 1, 0.90), p95M: pctFromHist(histMid, nMid || 1, 0.95), p98M: pctFromHist(histMid, nMid || 1, 0.98), stdDevM: stdMid, cfM: cfMid, clipFracBottom: botN ? (clipBottom/botN) : 0, botAvg, botStd, botP95: pctFromHist(histBot, botN || 1, 0.95), botBrightRows, botRowCount, botWhiteFrac, botEdgeFrac, botTextLike, redDominance, skinScore }); };`;

  function createAE(sm, { Utils }, onAE) {
    let worker = null, workerUrl = null, canvas = null, ctx2d = null, activeVideo = null, isRunning = false, targetToken = 0;
    let __userLock01 = 0; const setUserLock01 = (v) => { __userLock01 = Utils.clamp(v || 0, 1); };

    const loopDriver = createFrameDriver();
    let loopToken = 0;
    const scheduleNextLoop = (token, v) => {
      loopDriver.scheduleVideoFrame(v, (now, meta) => loop(token, meta), 'raf', 90);
    };

    let lastStats = { p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 };
    let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0, curGain = 1.0, __motion01 = 1, sampleCount = 0, lastLoopT = 0;
    let __lastMeta = { hiRisk: 0, luma: 0, clipFrac: 0, cf: 0.5, skinScore: 0, subLikely: false, p50: 0, p95: 0, p98: 0, motion01: 0 };
    let __subLikelyHoldUntil = 0, __lastSampleCheckGain = 1.0, __lastSampleMediaTime = -1, __sameFrameSkipStreak = 0, bitmapFailStreak = 0;
    let __sceneChange01 = 1, __aeBurstUntil = 0, __workerStallStreak = 0, __skinEma = 0, __subConfEma = 0, __prevSceneStats = null;
    let __aeEpoch = 1, __sampleSeq = 0, __lastAcceptedSeq = 0, __lastAcceptedMediaTime = -1, __inFlight = 0, __workerBusySince = 0, __pendingWorkerJob = null, __lastPresentedFrames = -1;
    let __lastAppliedLook = null, __lastApplyCommitT = 0;
    const gainAB = createABFilter({ alpha: 0.20, beta: 0.04, init: 1.0 });
    const { clamp } = Utils; let __unavailable = false, workerPolicy = null;
    const AE_STAT_KEYS = Object.freeze(['p05', 'p10', 'p35', 'p50', 'p90', 'p95', 'p98', 'clipFrac', 'clipLowFrac', 'cf', 'rd']);

    const cfg = Object.freeze({ ...AE_COMMON, ...AE_STANDARD_PROFILE });
    const getResolvedProfile = () => 'standard';

    const riskFrom = (p95, p98, clipFrac, clipLimit) => clamp(Math.max(clamp((p95 - 0.885) / 0.095, 0, 1) * 0.70 + clamp((p98 - 0.968) / 0.028, 0, 1) * 0.90, clamp((clipFrac - clipLimit) / (clipLimit * 4.0), 0, 1)), 0, 1);
    const smoothstep01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
    const isWorkerBusy = () => (__inFlight > 0);

    function recycleWorkerJob(job) { if (!job) return; try { if (typeof job.recycle === 'function') { job.recycle(); return; } } catch (_) {} try { const bmp = job.msg?.bitmap; if (bmp && typeof bmp.close === 'function') bmp.close(); } catch (_) {} }
    function clearPendingWorkerJob() { recycleWorkerJob(__pendingWorkerJob); __pendingWorkerJob = null; }
    function bumpAeEpoch() { __aeEpoch = ((__aeEpoch + 1) | 0) || 1; __lastAcceptedSeq = 0; __lastAcceptedMediaTime = -1; clearPendingWorkerJob(); __inFlight = 0; __workerBusySince = 0; __lastPresentedFrames = -1; }
    function isDuplicatePresentedFrame(rvfcMeta, mediaTime) { const pf = rvfcMeta && Number.isFinite(rvfcMeta.presentedFrames) ? (rvfcMeta.presentedFrames | 0) : -1; if (pf >= 0) { if (pf === __lastPresentedFrames) return true; __lastPresentedFrames = pf; return false; } if (__lastSampleMediaTime >= 0 && Math.abs((mediaTime || 0) - __lastSampleMediaTime) < 1e-4) { return true; } return false; }
    const MAX_WORKER_INFLIGHT = 1;
    function postToWorkerNow(job) { if (!worker) return false; try { __inFlight++; if (!__workerBusySince) __workerBusySince = performance.now(); if (job.transfer && job.transfer.length) worker.postMessage(job.msg, job.transfer); else worker.postMessage(job.msg); return true; } catch (_) { __inFlight = Math.max(0, __inFlight - 1); recycleWorkerJob(job); return false; } }
    function enqueueWorkerJobLatestWins(job) { if (!worker) { recycleWorkerJob(job); return false; } if (__inFlight < MAX_WORKER_INFLIGHT) return postToWorkerNow(job); if (__pendingWorkerJob) recycleWorkerJob(__pendingWorkerJob); __pendingWorkerJob = job; return true; }
    function flushPendingWorkerJob() { if (!worker) return; if (__inFlight >= MAX_WORKER_INFLIGHT) return; const job = __pendingWorkerJob; if (!job) return; __pendingWorkerJob = null; postToWorkerNow(job); }
    function makeWorkerJobBase({ width, height, seq, mediaTime }) { return { width, height, step: width <= 24 ? 1 : 2, token: targetToken, seq, epoch: __aeEpoch, mediaTime }; }
    function enqueueBitmapJob(bitmap, w, h, seq, mediaTime) { return enqueueWorkerJobLatestWins({ msg: { bitmap, ...makeWorkerJobBase({ width: w, height: h, seq, mediaTime }) }, transfer: [bitmap], recycle() { try { bitmap.close(); } catch (_) {} } }); }
    function enqueueBufferJob(buf, w, h, seq, mediaTime) { return enqueueWorkerJobLatestWins({ msg: { buf, ...makeWorkerJobBase({ width: w, height: h, seq, mediaTime }) }, transfer: [buf] }); }

    function createDecodeStressTracker() { const stMap = new WeakMap(); return { getStress01(v) { try { if (!v) return 0; const q = v.getVideoPlaybackQuality?.(); let st = stMap.get(v); if (!st) { st = { lastTotal: 0, lastDropped: 0, ema: 0 }; stMap.set(v, st); } if (!q) return st.ema; const total = q.totalVideoFrames || 0; const dropped = q.droppedVideoFrames || 0; if (total < st.lastTotal || dropped < st.lastDropped) { st.lastTotal = total; st.lastDropped = dropped; st.ema = 0; return st.ema; } const dTotal = Math.max(0, total - st.lastTotal); const dDrop = Math.max(0, dropped - st.lastDropped); st.lastTotal = total; st.lastDropped = dropped; const ratio = dTotal > 0 ? (dDrop / dTotal) : 0; const s = Math.max(0, Math.min(1, ratio / 0.12)); st.ema = st.ema <= 0 ? s : (st.ema * 0.82 + s * 0.18); return st.ema; } catch (_) { return 0; } }, reset(v) { if (v) stMap.delete(v); } }; }
    const decodeStress = createDecodeStressTracker();
    function computeAdaptiveSampleIntervalMs(v, now) { const paused = !!v?.paused; const rate = (v && Number.isFinite(v.playbackRate) && v.playbackRate > 0) ? v.playbackRate : 1; const risk01 = clamp(__lastMeta?.hiRisk ?? 0, 0, 1); const subLikely = !!(__lastMeta?.subLikely); const cf01 = clamp(lastStats.cf ?? 0.5, 0, 1); const stableScene = (__motion01 < 0.10) && (cf01 > 0.22); const sameTargetAndStable = stableScene && risk01 < 0.25; const gainDeltaEv = Math.abs(Math.log2(Math.max(1e-6, curGain)) - Math.log2(Math.max(1e-6, __lastSampleCheckGain))); const gainStable = gainDeltaEv < 0.03; let ms = paused ? 520 : (CONFIG.IS_LOW_END ? 112 : 82); ms += (1 - __motion01) * 72; ms -= risk01 * 20; if (now < __aeBurstUntil) ms *= 0.58; if (subLikely) ms *= 0.82; if (sameTargetAndStable) ms *= gainStable ? 1.85 : 1.20; const warmup01 = clamp(sampleCount / 4, 0, 1); ms *= (1.00 - (1 - warmup01) * 0.28); ms *= (1 + __userLock01 * 2.8); ms *= (1 + Math.min(4, __workerStallStreak) * 0.16); ms /= Math.min(2.4, Math.max(0.65, rate)); const decodeStress01 = decodeStress.getStress01(v); if (decodeStress01 > 0.05) ms *= (1 + decodeStress01 * 1.1); if (paused) return clamp(ms, 180, 1200); return clamp(ms, CONFIG.IS_LOW_END ? 38 : 28, CONFIG.IS_LOW_END ? 240 : 190); }
    function sceneChangeFromStats(avgLumaNow, avgLumaPrev, motion01, cf01, prevStats, currStats, clamp) { if (avgLumaPrev < 0 || !prevStats) return 1; const avgDelta = Math.abs(avgLumaNow - avgLumaPrev); const p50Delta = Math.abs((currStats.p50 ?? 0) - (prevStats.p50 ?? 0)); const p95Delta = Math.abs((currStats.p95 ?? 0) - (prevStats.p95 ?? 0)); const cfDelta  = Math.abs((currStats.cf ?? 0.5) - (prevStats.cf ?? 0.5)); const luminanceTerm = avgDelta / (0.040 + 0.020 * (1 - clamp(cf01, 0, 1)) + 0.015 * (1 - clamp(motion01, 0, 1))); const histTerm = (p50Delta / 0.06) * 0.8 + (p95Delta / 0.05) * 0.9 + (cfDelta / 0.10) * 0.4; return clamp(Math.max(luminanceTerm, histTerm), 0, 1); }
    const mixv = (a, b, w) => (a * (1 - w) + b * w);
    let __lookEma = { conF: 1, satF: 1, mid: 0, toe: 0, shoulder: 0, brightAdd: 0 }; let __lookEmaInit = false;
    function smoothLook(look, dtMs, motion01, risk01) { const dt = Math.min(220, dtMs); const tauBright = 140 + (1 - motion01) * 80 + risk01 * 40; const tauMid = 160 + (1 - motion01) * 100 + risk01 * 50; const tauCon = 190 + (1 - motion01) * 120 + risk01 * 60; const tauSat = 230 + (1 - motion01) * 140 + risk01 * 80; const tauToe = 260 + (1 - motion01) * 150 + risk01 * 100; const tauSh = 280 + (1 - motion01) * 160 + risk01 * 120; const aBright = 1 - Math.exp(-dt / Math.max(80, tauBright)); const aMid = 1 - Math.exp(-dt / Math.max(90, tauMid)); const aCon = 1 - Math.exp(-dt / Math.max(100, tauCon)); const aSat = 1 - Math.exp(-dt / Math.max(110, tauSat)); const aToe = 1 - Math.exp(-dt / Math.max(120, tauToe)); const aSh = 1 - Math.exp(-dt / Math.max(130, tauSh)); if (!__lookEmaInit) { __lookEma = { ...look }; __lookEmaInit = true; return look; } __lookEma.conF += (look.conF - __lookEma.conF) * aCon; __lookEma.satF += (look.satF - __lookEma.satF) * aSat; __lookEma.mid += (look.mid - __lookEma.mid) * aMid; __lookEma.toe += (look.toe - __lookEma.toe) * aToe; __lookEma.shoulder += (look.shoulder - __lookEma.shoulder) * aSh; __lookEma.brightAdd += (look.brightAdd - __lookEma.brightAdd) * aBright; return __lookEma; }

    const computeTargetEV = (s, c) => { const p50 = clamp(s.p50, 0.01, 0.99), risk01 = riskFrom(s.p95 ?? s.p90, s.p98 ?? s.p95, Math.max(0, s.clipFrac ?? 0), c.CLIP_FRAC_LIMIT); let ev = Math.log2(clamp(c.TARGET_MID_BASE + clamp((0.17 - p50) / 0.11, 0, 1) * 0.050 - risk01 * 0.030, 0.20, 0.34) / clamp(p50 * 0.72 + clamp(s.p35 ?? s.p50, 0.01, 0.99) * 0.28, 0.01, 0.99)) * c.STRENGTH; ev = clamp(ev, c.MAX_DOWN_EV, c.MAX_UP_EV * (1 - 0.35 * risk01)); if (risk01 > 0.58) ev = Math.min(ev, 0); ev = Math.min(ev, Math.log2(Math.max(1, Math.min(0.985 / clamp(s.p98 ?? s.p95, 0.01, 0.999), 0.980 / clamp(s.p95 ?? s.p90, 0.01, 0.999)))) - (0.06 * risk01)); const deadUp = c.DEAD_IN; const deadDown = c.DEAD_IN * 0.65; if (ev >= 0 && ev < deadUp) return 0; if (ev < 0 && -ev < deadDown) return 0; return ev; };
    const computeLook = (ev, s, risk01, c) => { const p50 = clamp(s.p50 ?? 0.5, 0, 1), up01 = clamp(clamp(ev / 1.55, -1, 1), 0, 1), upE = up01 * up01 * (3 - 2 * up01), lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1); let brightAdd = (up01 * 7.0) * clamp(0.52 - p50, -0.22, 0.22), mid = (up01 * 0.55) * clamp((0.50 - p50) / 0.22, -1, 1), toe = (3.6 + 5.6 * upE) * lowKey01 * (1 - 0.55 * risk01), shoulder = (4.8 + 5.2 * upE) * (risk01 * 0.85 + 0.15) * (1 - 0.25 * lowKey01), conF = 1 + (up01 * 0.050) * clamp((0.46 - clamp((clamp(s.p90 ?? 0.9, 0, 1) - clamp(s.p10 ?? 0.1, 0, 1)), 0, 1)) / 0.26, 0, 1) - (0.012 * risk01), satF = 1 + (1 - clamp(s.cf ?? 0.5, 0, 1)) * 0.22 * (1 - risk01 * 0.65); brightAdd *= (1 - 0.85 * risk01); shoulder *= (1 - 0.60 * risk01); const dn01 = clamp((-ev) / 1.10, 0, 1); const dnE = dn01 * dn01 * (3 - 2 * dn01); if (dn01 > 0) { satF *= (1 - 0.05 * dn01 * (0.5 + 0.5 * risk01)); conF = 1 + (conF - 1) * (1 - 0.20 * dn01); shoulder += 1.1 * dnE * (0.4 + 0.6 * risk01); brightAdd -= 1.2 * dnE * risk01; mid -= 0.10 * dnE * (0.6 + 0.4 * risk01); toe *= (1 - 0.18 * dn01); } const skinProtect = clamp(s.rd ?? 0, 0, 1) * 0.35; satF = satF * (1 - skinProtect * 0.35); conF = 1 + (conF - 1) * (1 - skinProtect * 0.25); shoulder *= (1 - skinProtect * 0.20 * risk01); const crush01 = clamp((0.045 - clamp(s.p05 ?? 0.05, 0, 1)) / 0.030, 0, 1) * 0.65 + clamp((clamp(s.clipLowFrac ?? 0, 0, 1) - 0.010) / 0.030, 0, 1) * 0.75; toe *= (1 - 0.55 * crush01); conF = 1 + (conF - 1) * (1 - 0.35 * crush01); let outConF = clamp(conF, 0.90, 1.12); let outSatF = clamp(satF, c.SAT_MIN, Math.min(c.SAT_MAX, 1.16 - 0.10 * risk01)); let outBrightAdd = clamp(brightAdd, -14, 14); return { conF: outConF, satF: outSatF, mid: clamp(mid, -0.95, 0.95), toe: clamp(toe, 0, 14), shoulder: clamp(shoulder, 0, 16), brightAdd: outBrightAdd }; };
    const disableAEHard = () => { try { worker?.terminate(); } catch (_) {} worker = null; isRunning = false; loopToken++; loopDriver.clear(); targetToken++; if (workerUrl) { try { URL.revokeObjectURL(String(workerUrl)); } catch (_) {} workerUrl = null; } __unavailable = true; };
    const ensureWorker = () => { if (__unavailable) return null; if (worker) return worker; if (location.protocol === 'about:' || location.href === 'about:blank') { disableAEHard(); return null; } try { if (!workerUrl) { let rawUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' })); if (window.trustedTypes && window.trustedTypes.createPolicy) { try { if (!workerPolicy) workerPolicy = window.trustedTypes.createPolicy('vsc-tw-policy', { createScriptURL: s => s }); workerUrl = workerPolicy.createScriptURL(rawUrl); } catch (_) { workerUrl = rawUrl; } } else { workerUrl = rawUrl; } } worker = new Worker(workerUrl); worker.onmessage = (e) => { const d = e.data || {}; __inFlight = Math.max(0, __inFlight - 1); if (__inFlight === 0) __workerBusySince = 0; const finishWorkerTurnAndMaybeFlush = () => { flushPendingWorkerJob(); }; if (d.epoch != null && d.epoch !== __aeEpoch) return finishWorkerTurnAndMaybeFlush(); if (d.seq != null && d.seq <= __lastAcceptedSeq) return finishWorkerTurnAndMaybeFlush(); if (Number.isFinite(d.mediaTime)) { if (__lastAcceptedMediaTime >= 0 && d.mediaTime + 1e-4 < __lastAcceptedMediaTime) return finishWorkerTurnAndMaybeFlush(); __lastAcceptedMediaTime = d.mediaTime; } if (d.seq != null) __lastAcceptedSeq = d.seq; processResult(d); flushPendingWorkerJob(); }; worker.onerror = () => { disableAEHard(); }; return worker; } catch (e) { log.warn('AE worker blocked. AE unavailable.'); disableAEHard(); return null; } };
    function shadowRiskFrom(s, clamp) { const p05 = clamp(s.p05 ?? 0.05, 0, 1); const clipLow = clamp(s.clipLowFrac ?? 0, 0, 1); const lowClip = clamp((clipLow - 0.010) / 0.030, 0, 1); const deepBlack = clamp((0.040 - p05) / 0.025, 0, 1); return clamp(lowClip * 0.7 + deepBlack * 0.8, 0, 1); }
    let __lastLookSent = null;
    function aeLookAlmostSame(a, b) { if (!a || !b) return false; return ( Math.abs((a.gain ?? 1) - (b.gain ?? 1)) < 0.015 && Math.abs((a.conF ?? 1) - (b.conF ?? 1)) < 0.006 && Math.abs((a.satF ?? 1) - (b.satF ?? 1)) < 0.006 && Math.abs((a.mid ?? 0) - (b.mid ?? 0)) < 0.02 && Math.abs((a.toe ?? 0) - (b.toe ?? 0)) < 0.10 && Math.abs((a.shoulder ?? 0) - (b.shoulder ?? 0)) < 0.10 && Math.abs((a.brightAdd ?? 0) - (b.brightAdd ?? 0)) < 0.12 && Math.abs((a.tempAdd ?? 0) - (b.tempAdd ?? 0)) < 0.08 ); }
    function shouldCommitLook(nextLook, now) { const MIN_APPLY_MS = 28; if ((now - __lastApplyCommitT) < MIN_APPLY_MS) return false; const prev = __lastAppliedLook; if (!prev) return true; const dCon = Math.abs((nextLook.conF || 0) - (prev.conF || 0)); const dSat = Math.abs((nextLook.satF || 0) - (prev.satF || 0)); const dMid = Math.abs((nextLook.mid || 0) - (prev.mid || 0)); const dToe = Math.abs((nextLook.toe || 0) - (prev.toe || 0)); const dSho = Math.abs((nextLook.shoulder || 0) - (prev.shoulder || 0)); const dBri = Math.abs((nextLook.brightAdd || 0) - (prev.brightAdd || 0)); return (dCon > 0.012 || dSat > 0.012 || dMid > 0.008 || dToe > 0.008 || dSho > 0.008 || dBri > 0.006); }
    function markLookCommitted(nextLook, now) { __lastAppliedLook = { conF: +nextLook.conF || 0, satF: +nextLook.satF || 0, mid: +nextLook.mid || 0, toe: +nextLook.toe || 0, shoulder: +nextLook.shoulder || 0, brightAdd: +nextLook.brightAdd || 0 }; __lastApplyCommitT = now; }

    const processResult = (data) => {
      if (!data || data.token !== targetToken) return;
      const now = performance.now(); sampleCount++;
      __motion01 = data.motion01 !== undefined ? data.motion01 : __motion01;
      const barRowRatio = (data.botRowCount > 0) ? (data.botBrightRows / data.botRowCount) : 0;
      const uiBarScore = clamp( (barRowRatio > 0.55 ? 0.55 : 0) + clamp(((data.botAvg ?? 0) - 0.22) / 0.16, 0, 1) * 0.20 + clamp((0.060 - (data.botStd ?? 0)) / 0.035, 0, 1) * 0.20 + clamp((0.18 - (data.botEdgeFrac ?? 0)) / 0.12, 0, 1) * 0.15 + clamp(((data.botWhiteFrac ?? 0) - 0.35) / 0.25, 0, 1) * 0.10, 0, 1 );
      const subTextScore = clamp( clamp(((data.botTextLike ?? 0) - 0.04) / 0.20, 0, 1) * 0.45 + clamp(((data.botEdgeFrac ?? 0) - 0.10) / 0.30, 0, 1) * 0.25 + clamp(((data.botP95 ?? 0) - 0.90) / 0.08, 0, 1) * 0.15 + clamp((0.28 - (data.p50 ?? 0.5)) / 0.12, 0, 1) * 0.15, 0, 1 );
      const subBandPrior = (barRowRatio > 0.10 && barRowRatio < 0.58) ? 0.12 : 0.0;
      let subConf = clamp(subTextScore + subBandPrior - uiBarScore * 0.85, 0, 1);
      if ((data.stdDev ?? 0) < 0.040 && (data.botStd ?? 0) < 0.030) subConf *= 0.55;
      __subConfEma = (__subConfEma <= 0) ? subConf : (subConf * 0.28 + __subConfEma * 0.72);
      const subOnTh = 0.58; const subKeepTh = 0.34;
      if (__subConfEma > subOnTh) { __subLikelyHoldUntil = now + 850; } else if (__subConfEma > subKeepTh && now < __subLikelyHoldUntil) { __subLikelyHoldUntil = now + 220; }
      const subLikely = (__subConfEma > subOnTh) || (now < __subLikelyHoldUntil);
      let subW = 0; if (subLikely) { subW = smoothstep01((__subConfEma - 0.30) / 0.50); subW *= (0.82 + 0.18 * clamp(((data.botTextLike ?? 0) - 0.03) / 0.18, 0, 1)); subW = clamp(subW, 0, 0.92); }
      const rawSkinScore = (data.skinScore != null) ? data.skinScore : (data.redDominance ?? 0);
      __skinEma = (__skinEma <= 0) ? rawSkinScore : mixv(__skinEma, rawSkinScore, 0.18); const skinScore = __skinEma;
      const refP10 = mixv(data.p10T ?? data.p10, data.p10M ?? data.p10, 0.60); const refP35 = mixv(data.p35T ?? data.p35, data.p35M ?? data.p35, 0.60); const refP50 = mixv(data.p50T ?? data.p50, data.p50M ?? data.p50, 0.60); const refP90 = mixv(data.p90T ?? data.p90, data.p90M ?? data.p90, 0.60); const refP95 = mixv(data.p95T ?? data.p95, data.p95M ?? data.p95, 0.60); const refP98 = mixv(data.p98T ?? data.p98, data.p98M ?? data.p98, 0.60); const refCf = mixv(data.cfT ?? data.cf, data.cfM ?? data.cf, 0.60);
      const clipFracEff = (subW > 0.01) ? mixv(data.clipFrac, Math.min(data.clipFrac, Math.min((data.clipFracTop ?? data.clipFrac) * 1.12, data.clipFrac)), subW) : data.clipFrac;
      const stats = { p05: data.p05, p10: mixv(data.p10, refP10, subW), p35: mixv(data.p35, refP35, subW), p50: mixv(data.p50, refP50, subW), p90: mixv(data.p90, refP90, subW), p95: mixv(data.p95, refP95, subW), p98: mixv(data.p98, refP98, subW), clipFrac: clipFracEff, clipLowFrac: data.clipLowFrac, cf: mixv(data.cf, refCf, subW), rd: skinScore };
      const dt = Math.min(now - lastEmaT, 500); lastEmaT = now; const a = 1 - Math.exp(-dt / clamp((activeVideo?.paused ? 380 : cfg.DT_CAP_MS) + (1 - __motion01) * 160, 180, 650));
      for (let i=0; i < AE_STAT_KEYS.length; i++) { const k = AE_STAT_KEYS[i]; const v = stats[k]; if (Number.isFinite(v)) lastStats[k] = (lastStats[k] < 0) ? v : (v * a + lastStats[k] * (1 - a)); }
      const risk01 = riskFrom(Math.max(0, lastStats.p95), Math.max(0, lastStats.p98), Math.max(0, lastStats.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);
      const currSceneStats = { p50: lastStats.p50, p95: lastStats.p95, cf: lastStats.cf };
      const sc01 = sceneChangeFromStats(data.avgLuma, lastLuma, __motion01, clamp(lastStats.cf ?? 0.5, 0, 1), __prevSceneStats, currSceneStats, clamp);
      __prevSceneStats = { ...currSceneStats }; lastLuma = data.avgLuma; __sceneChange01 = sc01;
      if (sc01 > 0.72) { __aeBurstUntil = Math.max(__aeBurstUntil, now + (activeVideo?.paused ? 0 : 450)); } else if (sc01 > 0.45) { __aeBurstUntil = Math.max(__aeBurstUntil, now + (activeVideo?.paused ? 0 : 220)); }
      __workerStallStreak = 0;

      let targetEV = computeTargetEV(lastStats, cfg) * Math.min(1, sampleCount / 3);
      const shadowRisk01 = shadowRiskFrom(lastStats, clamp); const lowKeyIntent01 = clamp((0.24 - (lastStats.p50 ?? 0.5)) / 0.12, 0, 1) * (0.6 + 0.4 * clamp(lastStats.cf ?? 0.5, 0, 1));
      if (targetEV > 0) { let damp = 1 - (0.18 * shadowRisk01 + 0.20 * lowKeyIntent01); if (subLikely) damp *= 1 - (0.20 + 0.35 * subW); targetEV *= clamp(damp, 0.45, 1.0); }
      if (risk01 > 0.75) targetEV = Math.min(targetEV, 0);
      const curEV = Math.log2(curGain), dtA = Math.min(now - lastApplyT, cfg.DT_CAP_MS); lastApplyT = now;
      const lock01 = clamp(__userLock01, 0, 1), nextEV = curEV + (targetEV - curEV) * ((1 - Math.exp(-dtA / (((sc01 > 0.55) ? cfg.TAU_AGGRESSIVE : ((targetEV > curEV && risk01 <= 0.70) ? cfg.TAU_UP : cfg.TAU_DOWN)) * (1 + risk01 * 1.10) * (1 + lock01 * 2.2)))) * (1 - ((lock01 > 0.70) ? clamp((lock01 - 0.70) / 0.30, 0, 1) : 0)));
      const dtSec = Math.max(1/120, Math.min(0.25, dtA / 1000)); const gainRaw = Utils.clamp(Math.pow(2, nextEV), 0.5, 2.0); curGain = Utils.clamp(gainAB.update(gainRaw, dtSec), 0.5, 2.0);
      const look = smoothLook(computeLook(Math.log2(curGain), lastStats, risk01, cfg), dtA, __motion01, risk01);

      __lastMeta.hiRisk = risk01; __lastMeta.cf = clamp(lastStats.cf ?? 0.5, 0, 1); __lastMeta.luma = data.avgLuma * 100; __lastMeta.clipFrac = lastStats.clipFrac; __lastMeta.skinScore = skinScore; __lastMeta.subLikely = !!subLikely; __lastMeta.gainApplied = curGain; __lastMeta.p50 = lastStats.p50; __lastMeta.p95 = lastStats.p95; __lastMeta.p98 = lastStats.p98; __lastMeta.motion01 = __motion01;
      const aeLook = { gain: curGain, conF: look.conF, satF: look.satF, mid: look.mid, toe: look.toe, shoulder: look.shoulder, brightAdd: look.brightAdd, tempAdd: clamp(cfg.TEMP_BIAS ?? 0, -6, 6) };
      if (!aeLookAlmostSame(aeLook, __lastLookSent)) { if (shouldCommitLook(aeLook, now)) { __lastLookSent = { ...aeLook }; markLookCommitted(aeLook, now); onAE && onAE({ ...aeLook, ...__lastMeta }); } }
    };

    const sample = async (v, rvfcMeta = null) => {
      const st = getVState(v);
      if (!isRunning || !v || document.hidden || st.tainted || v.readyState < 2 || st.visible === false || (v.videoWidth|0) === 0 || (v.videoHeight|0) === 0) return;
      const mediaTime = v.currentTime || 0; if (isDuplicatePresentedFrame(rvfcMeta, mediaTime)) { __sameFrameSkipStreak = Math.min(__sameFrameSkipStreak + 1, 255); return; } __sameFrameSkipStreak = 0;
      const now = performance.now(); let intervalMs = computeAdaptiveSampleIntervalMs(v, now); const inBurst = now < __aeBurstUntil; intervalMs += (inBurst ? -40 : +10); if (inBurst) intervalMs = Math.max(16, intervalMs);
      if (now - lastSampleT < intervalMs) return;
      if (__inFlight >= MAX_WORKER_INFLIGHT || isWorkerBusy()) { __workerStallStreak++; lastSampleT = now - Math.min(intervalMs * 0.75, 40); return; }
      try {
        const wk = ensureWorker(); if (!wk) return; const w = CONFIG.IS_LOW_END ? 24 : 32; const h = w; lastSampleT = now; __lastSampleCheckGain = curGain; const seq = (++__sampleSeq) | 0;
        if (window.createImageBitmap && window.OffscreenCanvas) {
          try {
            const bitmap = await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'pixelated' }); if (!isRunning) { bitmap.close(); return; } bitmapFailStreak = 0; if (!enqueueBitmapJob(bitmap, w, h, seq, mediaTime)) return;
          } catch (err) {
            bitmapFailStreak++;
            if (bitmapFailStreak < 3) { try { if (!canvas) { canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false }); } ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height); const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height); if (!enqueueBufferJob(d.data.buffer, canvas.width, canvas.height, seq, mediaTime)) return; return; } catch (_) {} }
            st.tainted = true; vscSignal({ aeLevel: 2, forceApply: true });
          }
        } else {
          if (!canvas) { canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false }); if (!ctx2d) { st.tainted = true; return; } }
          ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height); const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height); if (!enqueueBufferJob(d.data.buffer, canvas.width, canvas.height, seq, mediaTime)) return;
        }
      } catch (_) { st.tainted = true; }
    };

    const loop = (token, rvfcMeta = null) => { if (!isRunning || token !== loopToken) return; const v = activeVideo, now = performance.now(); if (sm.get(P.APP_ACT) && sm.get(P.V_AE) && v && v.isConnected && !document.hidden && now - lastLoopT > (v.paused ? 280 : (CONFIG.IS_LOW_END ? 110 : 85))) { lastLoopT = now; sample(v, rvfcMeta); } scheduleNextLoop(token, v); };
    const invalidatePendingSample = () => { targetToken++; loopDriver.clear(); clearPendingWorkerJob(); __inFlight = 0; __workerBusySince = 0; __lastPresentedFrames = -1; };
    const hardResetStats = () => { invalidatePendingSample(); bumpAeEpoch(); __lastSampleMediaTime = -1; __sameFrameSkipStreak = 0; lastSampleT = 0; lastLuma = -1; sampleCount = 0; lastStats = { p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 }; lastEmaT = performance.now(); lastApplyT = performance.now(); __lookEmaInit = false; __lookEma = { conF: 1, satF: 1, mid: 0, toe: 0, shoulder: 0, brightAdd: 0 }; __lastLookSent = null; __subConfEma = 0; __sceneChange01 = 1; __aeBurstUntil = 0; __workerStallStreak = 0; __skinEma = 0; __subLikelyHoldUntil = 0; __prevSceneStats = null; gainAB.reset(1.0); };
    const softResetStats = () => { invalidatePendingSample(); bumpAeEpoch(); __lastSampleMediaTime = -1; __sameFrameSkipStreak = 0; lastSampleT = 0; sampleCount = Math.min(sampleCount, 1); lastEmaT = performance.now(); lastApplyT = performance.now(); __subLikelyHoldUntil = 0; __lastLookSent = null; gainAB.reset(curGain); };
    const stopSoft = () => { isRunning = false; loopToken++; activeVideo = null; loopDriver.clear(); };
    const stopHard = () => { isRunning = false; loopToken++; loopDriver.clear(); try { worker?.terminate(); } catch (_) {} worker = null; if (workerUrl) { try { URL.revokeObjectURL(String(workerUrl)); } catch (_) {} workerUrl = null; } activeVideo = null; curGain = 1.0; lastLuma = -1; targetToken++; __unavailable = true; bumpAeEpoch(); };

    return { isUnavailable: () => __unavailable, getResolvedProfile, getMeta: () => ({ ...__lastMeta, profileResolved: getResolvedProfile() }), setTarget: (v, opts = {}) => { if (v === activeVideo) return; const prev = activeVideo; activeVideo = v; if (prev && prev !== v) { try { decodeStress.reset(prev); } catch (_) {} } curGain = opts.keepGain ? clamp(curGain, 0.60, 2.0) : 1.0; if (opts.softReset) softResetStats(); else hardResetStats(); }, start: () => { const wk = ensureWorker(); if (!wk) { isRunning = false; return; } if (!isRunning) { isRunning = true; loopToken++; lastLoopT = 0; lastApplyT = lastEmaT = performance.now(); lastSampleT = 0; loop(loopToken); } }, stop: stopSoft, stopHard: stopHard, wake: () => { lastSampleT = 0; lastLoopT = 0; }, userTweak: () => { hardResetStats(); lastSampleT = 0; lastLoopT = 0; }, __setOnAE: (fn) => { onAE = fn; }, setUserLock01, hintProfileChanged: () => { bumpAeEpoch(); hardResetStats(); } };
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
    if (!shadow.querySelector(`style[${marker}="1"]`)) {
      shadow.append(h('style', { [marker]: '1' }, cssText));
    }
  }

  function createDisposerBag() { const fns = []; return { add(fn) { if (typeof fn === 'function') fns.push(fn); return fn; }, flush() { for (let i = fns.length - 1; i >= 0; i--) { try { fns[i](); } catch (_) {} } fns.length = 0; } }; }

  function createUI(sm, registry, scheduler, bus, Utils) {
    const { h } = Utils; let container, monitorEl, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0;
    const uiWakeCtrl = new AbortController(), bag = createDisposerBag(), sub = (k, fn) => bag.add(sm.sub(k, fn));
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
    const allowUiInThisDoc = () => { return registry.videos.size > 0; };
    const TRIGGERS = Object.freeze({ [P.V_PRE_MIX]: { aeLevel: 2, lockMs: 2200, lockAmp: 0.90 }, [P.V_TONE_STR]: { aeLevel: 1, lockMs: 1600, lockAmp: 0.80 }, [P.V_AE_STR]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.55 }, [P.V_TONE_PRE]: { aeLevel: 1, lockMs: 900, lockAmp: 0.45 }, [P.V_PRE_S]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.80 }, [P.V_PRE_B]: { aeLevel: 2, lockMs: 1800, lockAmp: 0.90 } });
    function setAndHint(path, value, forceApply = true) { const prev = sm.get(path), changed = !Object.is(prev, value); if (changed) sm.set(path, value); const t = TRIGGERS[path]; if (!t) { if (forceApply) bus.signal({ aeLevel: 0, forceApply: true }); return; } if (changed) { bus.signal({ aeLevel: (t.aeLevel | 0), forceApply: !!forceApply, userLockMs: t.lockMs | 0, userLockAmp: (t.lockAmp == null ? 0 : +t.lockAmp) }); return; } if (forceApply) bus.signal({ aeLevel: 0, forceApply: true }); }
    const getUiRoot = () => { const fs = document.fullscreenElement || document.webkitFullscreenElement; if (fs) { if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement; return fs; } return document.body || document.documentElement; };
    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      const addBtn = (text, value) => { const b = h('button', { class: 'pbtn', style: 'flex:1' }, text); b.onclick = () => { const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) { setAndHint(key, offValue, true); } else { setAndHint(key, value, true); } }; const sync = () => { b.classList.toggle('active', sm.get(key) === value); }; sub(key, sync); sync(); row.append(b); };
      for (const it of items) addBtn(it.text, it.value); if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) addBtn('OFF', offValue); return row;
    }

    let __lastMonitorText = '', __lastMonitorIsAE = false;
    const build = () => {
      if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
      const style = `.main { position: fixed; top: 50%; right: 70px; transform: translateY(-50%); width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; } .header { display: flex; justify-content: center; margin-bottom: 12px; cursor: move; border-bottom: 2px solid #444; padding-bottom: 8px; font-weight: bold; font-size: 14px; color: #ccc;} .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; } .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; } .btn.active { background: #3498db; color: white; border-color: #2980b9; } .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; } .pbtn.active { background: #e67e22; color: white; border-color: #d35400; } .monitor { font-size: 12px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 8px; margin-top: 12px; } hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }`;
      applyShadowStyle(shadow, style, h);
      const dragHandle = h('div', { class: 'header' }, 'VSC 렌더링 제어');
      const bodyMain = h('div', { id: 'p-main' }, [
        h('div', { class: 'prow' }, [
          h('button', { id: 'ae-btn', class: 'btn', onclick: () => setAndHint(P.V_AE, !sm.get(P.V_AE), true) }, '🤖 AE 보정'),
          h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP'),
          h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT), true) }, '⚡ Power')
        ]),
        h('div', { class: 'prow' }, [ h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'), h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('playback', DEFAULTS.playback); bus.signal({ aeLevel:2, forceApply:true, userLockMs:800, userLockAmp:0.35 }); } }, '↺ 리셋') ]),
        renderButtonRow({ label: '톤', key: P.V_TONE_PRE, offValue: null, toggleActiveToOff: true, items: Object.keys(PRESETS.tone).filter(k=>k!=='off').map(k => ({ text: PRESETS.tone[k].label, value: k })) }),
        renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k=>k!=='off').map(k => ({ text: k, value: k })) }),
        renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(k => ({ text: k, value: k })) }),
        h('hr'), h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s, false); setAndHint(P.PB_EN, true, true); }; sub(P.PB_RATE, v => { const isEn = sm.get(P.PB_EN); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); sub(P.PB_EN, isEn => { const v = sm.get(P.PB_RATE); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); b.classList.toggle('active', sm.get(P.PB_EN) && Math.abs((sm.get(P.PB_RATE) || 1) - s) < 0.01); return b; }))
      ]);
      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain, monitorEl = h('div', { class: 'monitor' }, `Ready (${CONFIG.VERSION})`) ]); shadow.append(mainPanel);
      dragHandle.addEventListener('mousedown', (e) => { e.preventDefault(); let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect(); mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`; function onMove(ev) { mainPanel.style.top = `${rect.top + (ev.clientY - startY)}px`; mainPanel.style.left = `${rect.left + (ev.clientX - startX)}px`; } function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); } window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); });
      sub(P.V_AE, v => shadow.querySelector('#ae-btn').classList.toggle('active', !!v)); sub(P.APP_ACT, v => shadow.querySelector('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (!allowUiInThisDoc()) return; if (gearHost) return;
      gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%; background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff; display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer; pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none; transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;} @media (hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}} .gear:active{transform:translateY(-50%) scale(0.98);} .gear.open{outline:2px solid rgba(52,152,219,0.85);opacity:1 !important;} .gear.inactive{opacity:0.45;} .hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,0.88); border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.82);font:600 11px/1.2 sans-serif;white-space:nowrap; z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none;} .gear:hover+.hint{opacity:1;transform:translateY(0);} ${CONFIG.IS_MOBILE ? '.hint{display:none !important;}' : ''}`;
      applyShadowStyle(shadow, style, h); let dragThresholdMet = false;
      gearBtn = h('button', { class: 'gear', onclick: (e) => { if (dragThresholdMet) { e.preventDefault(); e.stopPropagation(); return; } setAndHint(P.APP_UI, !sm.get(P.APP_UI), true); } }, '⚙');
      shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.15'; }, 2500); };
      window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal }); window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal }); bootWakeTimer = setTimeout(wake, 2000);
      const handleGearDrag = (e) => { if (e.target !== gearBtn) return; dragThresholdMet = false; const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY; const rect = gearBtn.getBoundingClientRect(); gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; const onMove = (ev) => { const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY; if (Math.abs(currentY - startY) > 10) { dragThresholdMet = true; if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; } }; const onUp = () => { setTimeout(() => { dragThresholdMet = false; }, 100); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onUp); }; window.addEventListener('mousemove', onMove, { passive: false }); window.addEventListener('mouseup', onUp); window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp); };
      gearBtn.addEventListener('mousedown', handleGearDrag); gearBtn.addEventListener('touchstart', handleGearDrag, { passive: false });
      const syncGear = () => { if (!gearBtn) return; const showHere = allowUiInThisDoc(); gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); gearBtn.style.display = showHere ? 'block' : 'none'; if (!showHere) detachNodesHard(); else wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };
    const mount = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; } else { if (container) container.style.display = 'none'; } mount(); };
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => { try { ensure(); scheduler.request(true); } catch (_) {} }, { once: true, signal: __globalSig }); }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => { window.addEventListener(ev, () => { try { ensure(); } catch (_) {} }, { passive: true, signal: __globalSig }); });
    window.addEventListener('keydown', (e) => { if (!(e && e.altKey && e.shiftKey && e.code === 'KeyV')) return; if (isEditableTarget(e.target)) return; if (!allowUiInThisDoc()) return; setAndHint(P.APP_UI, !sm.get(P.APP_UI), true); ensure(); scheduler.request(true); }, { signal: __globalSig });
    if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;
    return { ensure, update: (text, isAE) => { if (!monitorEl || !sm.get(P.APP_UI)) return; if (text === __lastMonitorText && isAE === __lastMonitorIsAE) return; __lastMonitorText = text; __lastMonitorIsAE = isAE; monitorEl.textContent = text; monitorEl.style.color = isAE ? "#2ecc71" : "#aaa"; }, destroy: () => { try { uiWakeCtrl.abort(); } catch {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); bag.flush(); detachNodesHard(); } };
  }

  function createNoopUI() { return Object.freeze({ ensure() {}, update() {}, destroy() {} }); }
  function createUIFactory(enableUI) { return enableUI ? ((sm, registry, scheduler, bus, Utils) => createUI(sm, registry, scheduler, bus, Utils)) : createNoopUI; }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) { st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0 }; }
    return st.rateState;
  }
  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el, 220); el.playbackRate = nextRate; st.orig = null; } catch (_) {} };
  const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
  const onEvictVideo = (v) => { if (__vscClearVideoFilter) try { __vscClearVideoFilter(v); } catch (_) {} restoreRateOne(v); };
  const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };
  function pruneTouchedDisconnected() { for (const v of TOUCHED.videos) { if (!v || !v.isConnected) TOUCHED.videos.delete(v); } for (const v of TOUCHED.rateVideos) { if (!v || !v.isConnected) TOUCHED.rateVideos.delete(v); } }

  const bindVideoOnce = (v) => {
    const st = getVState(v);
    if (st.bound) return; st.bound = true;
    const softResetTransientFlags = () => {
      st.tainted = false; st.rect = null; st.rectT = 0; st.rectEpoch = -1;
      if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; }
      vscSignal({ aeLevel: 2, forceApply: true });
    };
    v.addEventListener('loadstart', softResetTransientFlags, { passive: true }); v.addEventListener('loadedmetadata', softResetTransientFlags, { passive: true }); v.addEventListener('emptied', softResetTransientFlags, { passive: true });
    v.addEventListener('seeking', () => { vscSignal({ aeLevel: 1 }); }, { passive: true }); v.addEventListener('play', () => { vscSignal({ aeLevel: 1 }); }, { passive: true });
    v.addEventListener('ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180) return; if (now < (rSt.suppressSyncUntil || 0)) return; const refs = window.__VSC_INTERNAL__; const app = refs?.App; const store = refs?.Store; if (!store) return; const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return; const activeVideo = app?.getActiveVideo?.() || null; const applyAll = !!store.get?.(P.APP_APPLY_ALL); if (!applyAll) { if (!activeVideo || v !== activeVideo) return; } const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.set(P.PB_RATE, cur); if (store.get?.(P.PB_EN) !== false) store.set(P.PB_EN, true); } }, { passive: true });
  };

  const __urlByDocVideo = new Map(), __reconcileCandidates = new Set(); let __lastReconcileSig = '';
  function makeReconcileSig(applySet, vVals, desiredRate, pbActive, videoFxOn, activeTarget) { return [ videoFxOn ? 1 : 0, pbActive ? 1 : 0, desiredRate ?? 1, hashApplySet(applySet), getElemId(activeTarget), vVals.gain?.toFixed(2), vVals.gamma?.toFixed(2), vVals.contrast?.toFixed(2), vVals.bright?.toFixed(1), vVals.satF?.toFixed(2), vVals.temp?.toFixed(1), vVals.sharp?.toFixed(1), vVals.sharp2?.toFixed(1), vVals.clarity?.toFixed(1), vVals.mid?.toFixed(3), vVals.toe?.toFixed(1), vVals.shoulder?.toFixed(1) ].join('|'); }

  function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Filters }) {
    const candidates = __reconcileCandidates; candidates.clear();
    for (const v of dirtyVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.videos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of TOUCHED.rateVideos) if (v?.tagName === 'VIDEO') candidates.add(v); for (const v of applySet) if (v?.tagName === 'VIDEO') candidates.add(v);
    __urlByDocVideo.clear();
    for (const el of candidates) {
      if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
      const st = getVState(el);
      const visible = (st.visible !== false), shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));
      if (!shouldApply) { Filters.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); bindVideoOnce(el); continue; }
      if (videoFxOn) { const doc = el.ownerDocument || document; let url = __urlByDocVideo.get(doc); if (url === undefined) { url = Filters.prepareCached(doc, vVals); __urlByDocVideo.set(doc, url); } Filters.applyUrl(el, url); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Filters.clear(el); TOUCHED.videos.delete(el); }
      if (pbActive) { const rSt = getRateState(el); if (rSt.orig == null) rSt.orig = el.playbackRate; const lastDesired = st.desiredRate; if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) { st.desiredRate = desiredRate; markInternalRateChange(el, 160); try { el.playbackRate = desiredRate; } catch (_) {} } touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo); } else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
      bindVideoOnce(el);
    }
    candidates.clear();
  }

  function createAppController({ Store, Registry, Scheduler, Bus, Filters, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting }) {
    if (CONFIG.DEBUG) { window.__VSC_Filters_Ref = Filters; window.__VSC_Bus_Ref = Bus; window.__VSC_Store_Ref = Store; }
    if (ENABLE_UI) { UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); }); }
    Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });
    let __lockStart = 0, __lockDur = 0, __lockAmp = 0; function bumpUserLock(now, ms, amp) { if (!ms || ms <= 0 || !amp || amp <= 0) return; const a = Utils.clamp(+amp, 0, 1), d = Math.max(0, ms | 0); if (__lockDur <= 0 || (now - __lockStart) > __lockDur) { __lockStart = now; __lockDur = d; __lockAmp = a; } else { const left = (__lockStart + __lockDur) - now; __lockStart = now; __lockDur = Math.max(left * 0.35 + d, d); __lockAmp = Math.max(__lockAmp * 0.65, a); } } function getUserLock01(now) { if (__lockDur <= 0) return 0; return Utils.clamp(1 - (now - __lockStart) / __lockDur, 0, 1) * __lockAmp; }
    Bus.on('signal', (s) => { const wantAE = FEATURES.ae(), now = performance.now(); if (s.userLockMs) bumpUserLock(now, s.userLockMs, s.userLockAmp); if (s.profileChanged) AE?.hintProfileChanged?.(); if (wantAE) { if ((s.aeLevel | 0) >= 2) AE.userTweak?.(); if ((s.aeLevel | 0) >= 1) AE.wake?.(); } if (s.forceApply) Scheduler.request(true); });
    const __aeMix = { expMix: 1, toneMix: 1, colorMix: 1 }, __aeMixEma = { expMix: 1, toneMix: 1, colorMix: 1 }; let __aeMixLastT = 0;
    function smoothAeMix(now, target, out) { const dt = Math.min(200, Math.max(0, now - (__aeMixLastT || now))); __aeMixLastT = now; const tau = 120, a = 1 - Math.exp(-dt / tau); __aeMixEma.expMix += (target.expMix - __aeMixEma.expMix) * a; __aeMixEma.toneMix += (target.toneMix - __aeMixEma.toneMix) * a; __aeMixEma.colorMix += (target.colorMix - __aeMixEma.colorMix) * a; out.expMix = __aeMixEma.expMix; out.toneMix = __aeMixEma.toneMix; out.colorMix = __aeMixEma.colorMix; }
    const __aeMixCache = new Map(); function q(v, step) { return Math.round((+v || 0) / step); }
    function computeAeMix3Cached(outMix, vf, aeMeta, Utils, userLock01) { const key = [ q(vf.toneStrength, 0.05), vf.tonePreset || 'off', vf.presetB || 'brOFF', vf.presetS || 'off', q(vf.presetMix ?? 1, 0.05), q(vf.aeStrength ?? 1, 0.05), q(aeMeta?.hiRisk ?? 0, 0.02), q(aeMeta?.luma ?? 1), q(aeMeta?.clipFrac ?? 0, 0.0005), q(aeMeta?.cf ?? 0.5, 0.02), q(aeMeta?.skinScore ?? 0, 0.02), q(userLock01 ?? 0, 0.05) ].join('|'); const hit = __aeMixCache.get(key); if (hit) { outMix.expMix = hit.expMix; outMix.toneMix = hit.toneMix; outMix.colorMix = hit.colorMix; return; } computeAeMix3Into(outMix, vf, aeMeta, Utils, userLock01); __aeMixCache.set(key, { expMix: outMix.expMix, toneMix: outMix.toneMix, colorMix: outMix.colorMix }); if (__aeMixCache.size > 256) __aeMixCache.delete(__aeMixCache.keys().next().value); }

    let __activeTarget = null, applySet = null;
    const __vfEff = { ...DEFAULTS.video }, __aeOut = { gain: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5, mid: 0, clipFrac: 0, skinScore: 0 }, __vVals = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, mid: 0, sharp: 0, sharp2: 0, clarity: 0, temp: 0, toe: 0, shoulder: 0 };
    let lastSRev = -1, lastRRev = -1, lastAeRev = -1, lastUserSigRev = -1, lastPrune = 0, aeRev = 0, currentAE = { ...__aeOut };
    const onAE = (ae) => { currentAE = ae; aeRev++; Scheduler.request(false); }; if (AE && AE.__setOnAE) AE.__setOnAE(onAE);

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active; if (!active) { cleanupTouched(TOUCHED); AE.stop?.(); if (ENABLE_UI) UI.update('OFF', false); return; }
        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev; if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev; lastUserSigRev = userSigRev; const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); pruneTouchedDisconnected(); lastPrune = now; }
        const userLock01 = getUserLock01(now); AE.setUserLock01?.(userLock01); const vf0 = Store.getCatRef('video'), wantAE = FEATURES.ae(), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
        const pick = Targeting.pickDetailed(visible.videos, window.__lastUserPt); let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
        if (nextTarget !== __activeTarget) { const hadPrev = !!__activeTarget; __activeTarget = nextTarget; if (wantAE && __activeTarget) { AE.setTarget(__activeTarget, { keepGain: hadPrev, softReset: hadPrev }); } }
        const aeUnavailable = AE.isUnavailable ? AE.isUnavailable() : false, aeShouldRun = !!(__activeTarget && wantAE && !aeUnavailable);
        if (aeShouldRun) { AE.start(); } else { AE.stop?.(); }
        const aeMeta = (wantAE && !aeUnavailable && AE.getMeta) ? AE.getMeta() : { profileResolved: 'standard', hiRisk: 0, subLikely: false, clipFrac: 0, cf: 0.5, skinScore: 0 };
        let vfEff = vf0; if (vf0.tonePreset && vf0.tonePreset !== 'off' && vf0.tonePreset !== 'neutral') { const tEff = computeToneStrengthEff(vf0, aeMeta, Utils); for (const k in __vfEff) __vfEff[k] = vf0[k]; __vfEff.toneStrength = tEff; vfEff = __vfEff; }
        computeAeMix3Cached(__aeMix, vfEff, aeMeta, Utils, userLock01); smoothAeMix(now, __aeMix, __aeMix);
        const aeStr = Utils.clamp(vfEff.aeStrength ?? 1.0, 0, 1); let expMix = __aeMix.expMix * aeStr, toneMix = __aeMix.toneMix * aeStr, colorMix = __aeMix.colorMix * aeStr, aeOut = null;
        if (aeShouldRun && currentAE) { const raw = currentAE; __aeOut.gain = Math.pow(2, Math.log2(Math.max(1e-6, raw.gain ?? 1)) * expMix); __aeOut.brightAdd = (raw.brightAdd ?? 0) * expMix; __aeOut.tempAdd = (raw.tempAdd ?? 0) * colorMix; __aeOut.conF = 1 + ((raw.conF ?? 1) - 1) * toneMix; __aeOut.satF = 1 + ((raw.satF ?? 1) - 1) * colorMix; __aeOut.mid = (raw.mid ?? 0) * toneMix; __aeOut.toe = (raw.toe ?? 0) * toneMix; __aeOut.shoulder = (raw.shoulder ?? 0) * toneMix; __aeOut.hiRisk = aeMeta.hiRisk ?? __aeOut.hiRisk; __aeOut.cf = aeMeta.cf ?? __aeOut.cf; __aeOut.luma = aeMeta.luma ?? __aeOut.luma; __aeOut.clipFrac = aeMeta.clipFrac ?? __aeOut.clipFrac; __aeOut.skinScore = aeMeta.skinScore ?? __aeOut.skinScore; aeOut = __aeOut; }
        composeVideoParamsInto(__vVals, vfEff, aeOut, Utils); const videoFxOn = !isNeutralVideoParams(__vVals), applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), extraApplyTopK = Store.get(P.APP_EXTRA_TOPK) | 0;
        applySet = Targeting.buildApplySetReuse(visible.videos, __activeTarget, extraApplyTopK, applyToAllVisibleVideos, window.__lastUserPt, pick.topCandidates);
        const desiredRate = Store.get(P.PB_RATE), pbActive = active && !!Store.get(P.PB_EN);
        const doUIUpdate = () => { if (ENABLE_UI && Store.getCatRef('app').uiVisible) { if (wantAE) { UI.update(`AE(Standard) G:${__vVals.gain.toFixed(2)}x L:${Math.round(currentAE.luma || 0)}% P50:${Math.round((aeMeta.p50||0)*100)} P95:${Math.round((aeMeta.p95||0)*100)}${aeMeta.subLikely ? ' [SUB]' : ''}`, true); } else { UI.update(`Ready (${CONFIG.VERSION})`, false); } } };
        const reconcileSig = makeReconcileSig(applySet, __vVals, desiredRate, pbActive, videoFxOn, __activeTarget);
        if (!force && vidsDirty.size === 0 && reconcileSig === __lastReconcileSig) { doUIUpdate(); return; } __lastReconcileSig = reconcileSig; doUIUpdate();
        reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: __vVals, videoFxOn, desiredRate, pbActive, Filters });
        if (ENABLE_UI && (force || vidsDirty.size)) UI.ensure();
      } catch (e) { log.warn('apply crashed:', e); }
    });
    let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    const refreshTick = () => { FEATURES.ae() ? startTick() : stopTick(); };
    Store.sub(P.V_AE, refreshTick); Store.sub(P.APP_ACT, refreshTick); refreshTick(); Scheduler.request(true);
    return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { AE.stopHard?.(); } catch (_) {} } });
  }

  const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
  window.__VSC_INTERNAL__.Bus = Bus; window.__VSC_INTERNAL__.Store = Store;
  const normalizeAllVideo = () => normalizeVideoState(Store, PRESETS, P, Utils);
  [ P.V_TONE_PRE, P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_AE_STR, P.V_TONE_STR, P.V_AE ].forEach(k => Store.sub(k, normalizeAllVideo)); normalizeAllVideo();
  const normalizeAllAudioPlayback = () => normalizeAudioPlaybackState(Store, P);
  [P.PB_EN, P.PB_RATE].forEach(k => Store.sub(k, normalizeAllAudioPlayback)); normalizeAllAudioPlayback();

  const FEATURES = { ae: () => { if (!(Store.get(P.APP_ACT) && Store.get(P.V_AE))) return false; return Utils.clamp(Store.get(P.V_AE_STR) ?? 1.0, 0, 1) > 0.02; } };
  const Registry = createRegistry(Scheduler), Targeting = createTargeting({ Utils });

  initSpaUrlDetector((nextUrl) => {
    log.info('SPA URL changed, rescanning...', nextUrl);
    try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {}
  });

  (function ensureRegistryAfterBodyReady() { const run = () => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} }; if (document.body) { run(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); run(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} document.addEventListener('DOMContentLoaded', () => run(), { once: true, signal: __globalSig }); })();

  const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID });
  const AE = createAE(Store, { Utils }, null);
  __vscClearVideoFilter = (v) => Filters.clear(v);
  const makeUI = createUIFactory(ENABLE_UI), UI = makeUI(Store, Registry, Scheduler, Bus, Utils);

  window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 }; window.__lastClickedVideo = null; window.__lastClickT = 0;
  function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
  function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; try { Scheduler.request(false); } catch (_) {} } let __vscLastUserSignalT = 0;
  function findVideoFromPointerEvent(e) { const path = typeof e.composedPath === 'function' ? e.composedPath() : null; if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } } const el = document.elementFromPoint(e.clientX, e.clientY); if (el?.tagName === 'VIDEO') return el; return el?.closest?.('video') || null; }

  window.addEventListener('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); window.__lastClickT = now; const v = findVideoFromPointerEvent(e); if (v) window.__lastClickedVideo = v; signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });
  window.addEventListener('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });
  window.addEventListener('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); }, { signal: __globalSig });
  window.addEventListener('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true, signal: __globalSig });

  const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Bus, Filters, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting });
  window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__;

  window.addEventListener('keydown', async (e) => { if (!(e.altKey && e.shiftKey && e.code === 'KeyP')) return; if (isEditableTarget(e.target)) return; const v = __VSC_APP__?.getActiveVideo(); if (!v) return; await togglePiPFor(v); }, { capture: true, signal: __globalSig });

  (function addPageLifecycleHooks() {
    window.addEventListener('freeze', () => { try { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 0 }); } catch (_) {} try { window.__VSC_INTERNAL__?.App?.getActiveVideo() && window.__VSC_INTERNAL__?.Bus?.signal?.({ forceApply: true }); } catch (_) {} }, { capture: true, signal: __globalSig });
    window.addEventListener('pageshow', () => { try { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 2, forceApply: true }); } catch (_) {} }, { capture: true, signal: __globalSig });
    window.addEventListener('pagehide', () => { try { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 0 }); } catch (_) {} }, { capture: true, signal: __globalSig });
  })();

  watchIframes();

})();
