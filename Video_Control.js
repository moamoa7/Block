// ==UserScript==
// @name        Video_Control (v159.4.0.3_NextGen)
// @namespace   https://github.com/
// @version     159.4.0.3
// @description Video Control: Adaptive Sampling, Subtitle/Skin AI, OffscreenCanvas AE, Document PiP, Proxy Store, Zero-Alloc
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

  const EXPERIMENTAL = Object.freeze({
    APPLY_ALL_VISIBLE_VIDEOS: false,
    EXTRA_APPLY_TOPK: 2,
    AUTO_PIP_ON_TAB_HIDE: true
  });

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
    } catch (e) { try { console.warn('[VSC] attachShadow patch failed:', e); } catch(_) {} }
  })();

  const CONFIG = Object.freeze({
    VERSION: "v159.4.0.3_NextGen",
    IS_MOBILE: /Mobi|Android|iPhone/i.test(navigator.userAgent),
    IS_LOW_END: (navigator.deviceMemory || 4) < 4,
    TOUCHED_MAX: ((navigator.deviceMemory || 4) < 4) ? 60 : 140,
    VSC_ID: Math.random().toString(36).slice(2),
    DEBUG: false
  });

  const ENABLE_UI = true;
  const VSCX = Object.freeze({ visible: Symbol('vsc.visible'), rect: Symbol('vsc.rect'), ir: Symbol('vsc.ir'), bound: Symbol('vsc.bound'), rateState: Symbol('vsc.rateState'), tainted: Symbol('vsc.tainted'), audioFail: Symbol('vsc.audioFail'), applied: Symbol('vsc.applied'), desiredRate: Symbol('vsc.desiredRate'), lastFilterUrl: Symbol('vsc.lastFilterUrl') });

  const AE_COMMON = Object.freeze({ CLIP_FRAC_LIMIT: 0.0032, DEAD_IN: 0.035, TAU_UP: 820, TAU_DOWN: 760, TAU_AGGRESSIVE: 220, SAT_MIN: 0.88, SAT_MAX: 1.16, DT_CAP_MS: 220 });

  const AE_DEVICE_BASE = Object.freeze({
    pc:     { STRENGTH: 0.62, MAX_UP_EV: 0.50, MAX_DOWN_EV: -0.36, TARGET_MID_BASE: 0.30 },
    mobile: { STRENGTH: 0.52, MAX_UP_EV: 0.48, MAX_DOWN_EV: -0.32, TARGET_MID_BASE: 0.30 }
  });

  const AE_PROFILES = Object.freeze({
    standard:  { STRENGTH: 0.56, TARGET_MID_BASE: 0.30, MAX_UP_EV: 0.40, MAX_DOWN_EV: -0.34, TONE_BIAS: 0.0, TEMP_BIAS: 0, LOOK: { brMul: 0.98, satMul: 0.98, conMul: 1.00 } },
    bright:    { STRENGTH: 0.70, TARGET_MID_BASE: 0.33, MAX_UP_EV: 0.62, MAX_DOWN_EV: -0.26, TONE_BIAS: +0.55, TEMP_BIAS: +1.0, LOOK: { brMul: 1.08, satMul: 1.06, conMul: 1.01 } },
    cinemaHdr: { STRENGTH: 0.42, TARGET_MID_BASE: 0.28, MAX_UP_EV: 0.22, MAX_DOWN_EV: -0.52, TONE_BIAS: -0.35, TEMP_BIAS: 0, LOOK: { brMul: 0.92, satMul: 0.93, conMul: 0.99 } },
    auto: {}
  });

  const PRESETS = Object.freeze({
    aeProfiles: { auto: { label: '자동' }, standard: { label: '표준' }, bright: { label: '밝게' }, cinemaHdr: { label: '영화/HDR' } },
    tone: {
      neutral: { label: '기본', toe: 0.0, shoulder: 0.0, mid: 0.0, con: 1.00, sat: 1.00, br: 0.0, tmp: 0.0 },
      highlight: { label: '조명', toe: 0.4, shoulder: 2.6, mid: -0.15, con: 0.99, sat: 0.98, br: -0.2, tmp: -1.0 },
      redSkin: { label: '피부', toe: 1.4, shoulder: 0.6, mid: 0.35, con: 1.03, sat: 1.05, br: 0.8, tmp: +2.0 }
    },
    detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 }, S: { sharpAdd: 5, sharp2Add: 6, clarityAdd: 5 }, M: { sharpAdd: 10, sharp2Add: 12, clarityAdd: 8 }, L: { sharpAdd: 18, sharp2Add: 22, clarityAdd: 12 }, XL: { sharpAdd: 25, sharp2Add: 35, clarityAdd: 15 } },
    grade: { brOFF: { gammaF: 1.00, brightAdd: 0, conF: 1.00, satF: 1.00, tempAdd: 0 }, S: { gammaF: 1.00, brightAdd: 2, conF: 1.00, satF: 1.00, tempAdd: 0 }, M: { gammaF: 1.08, brightAdd: 4, conF: 1.00, satF: 1.00, tempAdd: 0 }, L: { gammaF: 1.16, brightAdd: 6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DS: { gammaF: 1.00, brightAdd: 3.6, conF: 1.00, satF: 1.00, tempAdd: 0 }, DM: { gammaF: 1.10, brightAdd: 7.2, conF: 1.00, satF: 1.00, tempAdd: 0 }, DL: { gammaF: 1.22, brightAdd: 10.8, conF: 1.00, satF: 1.00, tempAdd: 0 } }
  });

  const DEFAULTS = { video: { gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, temp: 0, sharp: 0, sharp2: 0, clarity: 0, dither: 0, ae: false, presetS: 'off', presetB: 'brOFF', presetMix: 1.0, aeProfile: 'auto', tonePreset: 'off', toneStrength: 1.0, aeStrength: 1.0 }, audio: { enabled: false, boost: 6 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, tab: 'main', applyAll: EXPERIMENTAL.APPLY_ALL_VISIBLE_VIDEOS, extraTopK: EXPERIMENTAL.EXTRA_APPLY_TOPK } };
  const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_TAB: 'app.tab', APP_APPLY_ALL: 'app.applyAll', APP_EXTRA_TOPK: 'app.extraTopK', V_AE: 'video.ae', V_AE_PROFILE: 'video.aeProfile', V_AE_STR: 'video.aeStrength', V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength', V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright', V_SAT: 'video.sat', V_SHARP: 'video.sharp', V_SHARP2: 'video.sharp2', V_CLARITY: 'video.clarity', V_TEMP: 'video.temp', V_DITHER: 'video.dither', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });

  const TOUCHED = { videos: new Set(), rateVideos: new Set() };
  function touchedAddLimited(set, el, onEvict) { if (!el) return; if (set.has(el)) { set.delete(el); set.add(el); return; } set.add(el); if (set.size <= CONFIG.TOUCHED_MAX) return; const it = set.values(); const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25); for (let i = 0; i < dropN; i++) { const v = it.next().value; if (v == null) break; set.delete(v); try { onEvict && onEvict(v); } catch (_) {} } }
  const insertTopN = (arr, item, N) => { let i = 0; while (i < arr.length && arr[i].s >= item.s) i++; if (i >= N) return; arr.splice(i, 0, item); if (arr.length > N) arr.length = N; };
  function split2(p) { const i = p.indexOf('.'); return (i > 0) ? [p.slice(0, i), p.slice(i + 1)] : [p, '']; }
  const lerp = (a, b, t) => a + (b - a) * t;

  let __vscRectEpoch = 0;
  let __vscRectEpochQueued = false;
  function bumpRectEpoch() { if (__vscRectEpochQueued) return; __vscRectEpochQueued = true; requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; }); }
  window.addEventListener('scroll', bumpRectEpoch, { passive: true, capture: true });
  window.addEventListener('resize', bumpRectEpoch, { passive: true });
  window.addEventListener('orientationchange', bumpRectEpoch, { passive: true });

  function getRectCached(v, now, maxAgeMs = 420) {
    const t0 = v.__vscRectT || 0; let r = v[VSCX.rect]; const epoch = v.__vscRectEpoch || 0;
    if (!r || (now - t0) > maxAgeMs || epoch !== __vscRectEpoch) { r = v.getBoundingClientRect(); v[VSCX.rect] = r; v.__vscRectT = now; v.__vscRectEpoch = __vscRectEpoch; } return r;
  }

  // ====== Stable ID 생성기 (해시용) ======
  const __vscElemIds = new WeakMap();
  let __vscElemIdSeq = 1;
  function getElemId(el) {
    if (!el) return 0;
    let id = __vscElemIds.get(el);
    if (!id) { id = __vscElemIdSeq++; __vscElemIds.set(el, id); }
    return id;
  }
  function hashApplySet(set) {
    let sum = 0;
    for (const el of set) sum += getElemId(el);
    return sum;
  }

  // ====== 1. IFRAME INJECTION ======
  function getSelfCode() {
    try { if (document.currentScript && document.currentScript.textContent) { const t = document.currentScript.textContent.trim(); if (t.length > 200) return t; } } catch (_) { }
    try { if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.source) return String(GM_info.script.source || ''); } catch (_) { }
    return null;
  }
  function injectIntoIframe(iframe, code) {
    try {
      const doc = iframe.contentDocument; const win = iframe.contentWindow;
      if (!doc || !win || win[VSC_BOOT_KEY] || !code) return;
      const s = doc.createElement('script'); s.type = 'text/javascript'; s.textContent = code;
      (doc.head || doc.documentElement).appendChild(s); s.remove();
    } catch (_) { }
  }

  function watchIframes() {
    const code = getSelfCode();
    if (!code) return;

    const scan = () => {
      try {
        document.querySelectorAll("iframe").forEach((ifr) => injectIntoIframe(ifr, code));
      } catch (_) {}
    };

    const attach = () => {
      const root = document.documentElement;
      if (!root) return false;

      document.addEventListener("load", (e) => {
        const t = e.target;
        if (t && t.tagName && t.tagName.toLowerCase() === "iframe") {
          injectIntoIframe(t, code);
        }
      }, true);

      new MutationObserver(scan).observe(root, { childList: true, subtree: true });
      scan();
      return true;
    };

    if (attach()) return;

    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    try {
      mo.observe(document, { childList: true, subtree: true });
    } catch (_) {}
    document.addEventListener("DOMContentLoaded", () => {
      try { attach(); } catch (_) {}
      try { mo.disconnect(); } catch (_) {}
    }, { once: true });
  }

  // ====== 2. FULLSCREEN WRAPPER ======
  const fsWraps = new WeakMap();
  function ensureFsWrapper(video) {
    if (fsWraps.has(video)) return fsWraps.get(video);
    if (!video || !video.parentNode) return null;
    const parent = video.parentNode;
    const wrap = document.createElement('div');
    wrap.className = 'vsc-fs-wrap';
    wrap.style.cssText = `position: relative; display: inline-block; width: 100%; height: 100%; max-width: 100%; background: black;`;
    const ph = document.createComment('vsc-video-placeholder');
    parent.insertBefore(ph, video);
    parent.insertBefore(wrap, video);
    wrap.appendChild(video);
    wrap.__vscPlaceholder = ph;
    fsWraps.set(video, wrap);
    return wrap;
  }
  function restoreFromFsWrapper(video) {
    const wrap = fsWraps.get(video); if (!wrap) return;
    const ph = wrap.__vscPlaceholder;
    if (ph && ph.parentNode) { ph.parentNode.insertBefore(video, ph); ph.parentNode.removeChild(ph); }
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    fsWraps.delete(video);
  }
  function patchMethodSafe(obj, name, wrappedFn) {
    try {
      const ownDesc = Object.getOwnPropertyDescriptor(obj, name);
      if (ownDesc && ownDesc.writable === false && ownDesc.configurable === false) return false;
      obj[name] = wrappedFn;
      if (obj[name] === wrappedFn) return true;
    } catch (_) {}
    try {
      Object.defineProperty(obj, name, { configurable: true, writable: true, value: wrappedFn });
      return true;
    } catch (_) {}
    return false;
  }
  function patchFullscreenRequest(video) {
    if (!video || video.__vscFsPatched) return;
    video.__vscFsPatched = true;

    if (typeof video.webkitEnterFullscreen === 'function') return;

    const origReq = video.requestFullscreen || video.webkitRequestFullscreen || video.msRequestFullscreen;
    if (!origReq) return;

    const runWrappedFs = () => {
      const wrap = ensureFsWrapper(video);

      const cleanupIfNotFullscreen = () => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
        if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video);
      };

      if (wrap) {
        const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen;
        if (typeof req === 'function') {
          try {
            const ret = req.call(wrap);
            if (ret && typeof ret.then === 'function') {
              return ret.catch((err) => {
                cleanupIfNotFullscreen();
                throw err;
              });
            }
            return ret;
          } catch (err) {
            cleanupIfNotFullscreen();
            throw err;
          }
        }
      }

      try {
        const ret = origReq.call(video);
        if (ret && typeof ret.then === 'function') {
          return ret.catch((err) => {
            cleanupIfNotFullscreen();
            throw err;
          });
        }
        return ret;
      } catch (err) {
        cleanupIfNotFullscreen();
        throw err;
      }
    };

    if (video.requestFullscreen) { patchMethodSafe(video, 'requestFullscreen', function () { return runWrappedFs(); }); }
    if (video.webkitRequestFullscreen) { patchMethodSafe(video, 'webkitRequestFullscreen', function () { return runWrappedFs(); }); }
    if (video.msRequestFullscreen) { patchMethodSafe(video, 'msRequestFullscreen', function () { return runWrappedFs(); }); }
  }
  function onFsChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    if (!fsEl) { document.querySelectorAll('video').forEach(v => { if (fsWraps.has(v)) restoreFromFsWrapper(v); }); }
    if (window.__VSC_UI_Ensure) window.__VSC_UI_Ensure();
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // ====== 3. WEBKIT PIP & NEXT-GEN DOCUMENT PIP ======
  function findWebkitPiPVideo() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) { try { if (typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture') return v; } catch (_) {} }
    return null;
  }
  let __vscAutoEnteredPiP = false;
  let __activeDocumentPiPWindow = null;
  let __pipPlaceholder = null;
  let __pipOrigParent = null;
  let __pipOrigNext = null;
  let __pipOrigCss = '';

  function resetPiPState() {
    __activeDocumentPiPWindow = null;
    __pipPlaceholder = null;
    __pipOrigParent = null;
    __pipOrigNext = null;
    __pipOrigCss = "";
  }

  async function enterPiP(video) {
    if (!video || video.readyState < 2) return false;

    if ('documentPictureInPicture' in window) {
      if (__activeDocumentPiPWindow) return true;
      try {
        const pipWindow = await window.documentPictureInPicture.requestWindow({
          width: Math.max(video.videoWidth / 2, 400),
          height: Math.max(video.videoHeight / 2, 225)
        });

        __activeDocumentPiPWindow = pipWindow;
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

        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';

        pipWindow.document.body.append(video);

        pipWindow.addEventListener('click', () => {
          if (video.paused) {
            const p = video.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
          } else {
            video.pause();
          }
        });

        pipWindow.addEventListener('pagehide', () => {
          try {
            video.style.cssText = __pipOrigCss;
            if (__pipPlaceholder && __pipPlaceholder.parentNode) {
              __pipPlaceholder.parentNode.insertBefore(video, __pipPlaceholder);
              __pipPlaceholder.remove();
            } else if (__pipOrigParent) {
              __pipOrigParent.insertBefore(video, __pipOrigNext);
            }
          } finally {
            resetPiPState();
          }
        });
        return true;
      } catch (e) {
        console.warn('[VSC] Document PiP failed, fallback to standard', e);
      }
    }

    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
      if (document.pictureInPictureElement === video) return true;
      try { await video.requestPictureInPicture(); return true; } catch (e) { return false; }
    }
    if (typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture')) {
      try { video.webkitSetPresentationMode('picture-in-picture'); return true; } catch (e) { return false; }
    }
    return false;
  }
  async function exitPiP(preferredVideo = null) {
    if (__activeDocumentPiPWindow) {
      __activeDocumentPiPWindow.close();
      __activeDocumentPiPWindow = null;
      return true;
    }
    if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); return true; } catch (_) {} }
    const candidates = []; if (preferredVideo) candidates.push(preferredVideo);
    const wk = findWebkitPiPVideo(); if (wk) candidates.push(wk);
    for (const v of candidates) {
      try { if (v && typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture' && typeof v.webkitSetPresentationMode === 'function') { v.webkitSetPresentationMode('inline'); return true; } } catch (_) {}
    }
    return false;
  }
  async function togglePiPFor(video) {
    if (!video || video.readyState < 2) return false;
    __vscAutoEnteredPiP = false;
    if (__activeDocumentPiPWindow || document.pictureInPictureElement === video) return exitPiP(video);
    if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} }
    return enterPiP(video);
  }

  // ====== TARGETING WEIGHTS ======
  const TARGETING_WEIGHTS = Object.freeze({
    playing: 6.0, hasTime: 2.4, area: 1.2, dist: 3.0, audible: 1.35, audibleAudioBoostBonus: 1.2,
    pipBoostVisible: 2.4, pipBoostHidden: 3.8, clickedBoost: 2.0,
    bgPenaltyMutedAutoplayNoControls: 1.1, bgPenaltyEdge: 0.9, bgPenaltyTiny: 0.8, bgPenaltyLoop: 0.35
  });

  function createTargeting({ Utils }) {
    const __applySetReuse = new Set(), __topBuf = [], __limitedBuf = [];
    const __lastTopCandidates = [];
    const __pickRes = { target: null, bestScore: -Infinity, curScore: -Infinity, delta: 0, secondScore: -Infinity, now: 0, topCandidates: __lastTopCandidates };

    function buildCandidateFeature(v, now) {
      if (!v || v.readyState < 2) return null;
      const r = getRectCached(v, now, 420);
      const visibleGeom = !(r.width < 80 || r.height < 60 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth);
      const pip = (__activeDocumentPiPWindow) || (document.pictureInPictureElement === v);
      if (!visibleGeom && !pip) return null;

      const area = r.width * r.height;
      const ir = (v[VSCX.ir] == null) ? 0.01 : v[VSCX.ir];
      if (!pip && (ir < 0.01 && area < 160 * 120)) return null;

      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;

      return { v, r, area, ir, cx, cy, pip };
    }

    function invDistScoreSq(dx, dy, scale) {
      const d2 = dx * dx + dy * dy;
      return 1 / (1 + d2 / (scale * scale));
    }

    function scoreVideoPrepared(f, audioBoostOn, now, lastUserPt, vp) {
      const v = f.v;
      const areaScore = Math.log2(1 + f.area / 20000);
      const playing = (!v.paused && !v.ended) ? 1 : 0;
      const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;

      const dx = f.cx - lastUserPt.x;
      const dy = f.cy - lastUserPt.y;
      const distScore = invDistScoreSq(dx, dy, 850);

      const cdx = f.cx - vp.cx;
      const cdy = f.cy - vp.cy;
      const centerScore = invDistScoreSq(cdx, cdy, 900);

      const userRecent01 = Math.max(0, 1 - (now - lastUserPt.t) / 2500);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const userBoost = Math.min(0.9, userRecent01 * (1 / (1 + dist / 500)) * 1.15);

      const irScore = Math.min(1, f.ir) * 3.2;
      const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0;
      const bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
      const big01 = Math.min(1, f.area / (900 * 500)); let bgPenalty = 0;
      const autoplay = v.autoplay || v.hasAttribute?.('autoplay'), loop = v.loop || v.hasAttribute?.('loop'), noControls = !v.controls;

      const r = f.r;
      const edgeLike = (r.top < 40 || (vp.h - r.bottom) < 40 || r.left < 20 || (vp.w - r.right) < 20), tiny = f.area < (260 * 160);

      const W = TARGETING_WEIGHTS;
      if (v.muted && autoplay && noControls) { bgPenalty += W.bgPenaltyMutedAutoplayNoControls * (1 - 0.60 * big01); if (edgeLike) bgPenalty += W.bgPenaltyEdge * (1 - 0.70 * big01); if (tiny) bgPenalty += W.bgPenaltyTiny; if (loop) bgPenalty += W.bgPenaltyLoop * (1 - 0.50 * big01); } else if (bgLike && !audible) { bgPenalty = (1.6 * (1 - 0.65 * big01)); if (userRecent01 > 0.15) bgPenalty *= 0.55; }

      const pipBoost = f.pip ? (document.visibilityState === 'hidden' ? W.pipBoostHidden : W.pipBoostVisible) : 0;
      const clickedBoost = (v === window.__lastClickedVideo && (now - (window.__lastClickT || 0)) < 1800 && f.area > (220 * 140)) ? W.clickedBoost : 0;

      return (playing * W.playing) + (hasTime * W.hasTime) + (areaScore * W.area) + (distScore * (W.dist * 0.72)) + (centerScore * 0.75) + userBoost + irScore + (audible * W.audible) + (audioBoostOn ? audible * W.audibleAudioBoostBonus : 0) + pipBoost + clickedBoost - bgPenalty;
    }

    function preScoreCandidate(f) {
      const v = f.v;
      const irTerm = Math.min(1, f.ir) * 3.0;
      const areaTerm = Math.log2(1 + f.area / 20000) * 1.2;
      const playingTerm = (!v.paused && !v.ended) ? 1.2 : 0;
      const hasTimeTerm = (v.currentTime > 0.2) ? 0.4 : 0;
      const audibleTerm = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 0.7 : 0;
      const pipTerm = f.pip ? 3.5 : 0;
      return irTerm + areaTerm + playingTerm + hasTimeTerm + audibleTerm + pipTerm;
    }

    function pushCandidateForced(buf, f, N) {
      if (!f) return;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i].f?.v === f.v) return;
      }
      insertTopN(buf, { f, s: Infinity }, N);
    }

    const pickDetailed = (videos, lastUserPt, audioBoostOn) => {
      const now = performance.now();
      const vp = { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
      if (!videos || videos.size === 0) {
        __pickRes.target = null; __pickRes.bestScore = -Infinity; __pickRes.curScore = -Infinity; __pickRes.delta = 0; __pickRes.secondScore = -Infinity; __pickRes.now = now;
        return __pickRes;
      }

      const MAX_CAND_PRE = 14;
      __limitedBuf.length = 0;
      for (const v of videos) {
        const f = buildCandidateFeature(v, now);
        if (!f) continue;
        insertTopN(__limitedBuf, { f, s: preScoreCandidate(f) }, MAX_CAND_PRE);
      }

      const activeVideo = window.__VSC_INTERNAL__.App?.getActiveVideo();
      if (activeVideo && videos.has(activeVideo)) {
        pushCandidateForced(__limitedBuf, buildCandidateFeature(activeVideo, now), MAX_CAND_PRE);
      }

      const pipEl = document.pictureInPictureElement;
      if (pipEl && videos.has(pipEl)) {
        pushCandidateForced(__limitedBuf, buildCandidateFeature(pipEl, now), MAX_CAND_PRE);
      }

      let best = activeVideo, bestScore = -Infinity, secondScore = -Infinity;
      let curScore = -Infinity;

      if (activeVideo && videos.has(activeVideo)) {
        const fCur = buildCandidateFeature(activeVideo, now);
        if (fCur) curScore = scoreVideoPrepared(fCur, audioBoostOn, now, lastUserPt, vp);
        best = activeVideo;
        bestScore = curScore;
      }

      __lastTopCandidates.length = 0;
      for (const it of __limitedBuf) {
        const s = scoreVideoPrepared(it.f, audioBoostOn, now, lastUserPt, vp);
        if (Number.isFinite(s)) insertTopN(__lastTopCandidates, { v: it.f.v, s }, 6);

        if (s > bestScore) { secondScore = bestScore; bestScore = s; best = it.f.v; }
        else if (s > secondScore) { secondScore = s; }
      }

      if (!Number.isFinite(bestScore) || bestScore === -Infinity) {
        __pickRes.target = null; __pickRes.bestScore = -Infinity; __pickRes.curScore = curScore; __pickRes.delta = 0; __pickRes.secondScore = secondScore; __pickRes.now = now;
        return __pickRes;
      }

      let delta = bestScore - curScore;
      __pickRes.target = best; __pickRes.bestScore = bestScore; __pickRes.curScore = curScore; __pickRes.delta = delta; __pickRes.secondScore = secondScore; __pickRes.now = now;
      return __pickRes;
    };

    const buildApplySetReuse = (visibleVideos, target, extraApplyTopK, applyToAllVisibleVideos, lastUserPt, audioBoostOn, topCandidates) => {
      __applySetReuse.clear();
      if (applyToAllVisibleVideos) { for (const v of visibleVideos) __applySetReuse.add(v); return __applySetReuse; }
      if (target) __applySetReuse.add(target);
      const N = Math.max(0, extraApplyTopK | 0); if (N <= 0) return __applySetReuse;

      if (topCandidates && topCandidates.length) {
        for (const it of topCandidates) {
          if (it.v !== target) __applySetReuse.add(it.v);
          if (__applySetReuse.size >= (target ? N + 1 : N)) break;
        }
        return __applySetReuse;
      }

      const now = performance.now(); const vp = { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; __topBuf.length = 0;
      for (const v of visibleVideos) {
        if (!v || v === target) continue;
        const f = buildCandidateFeature(v, now);
        const s = f ? scoreVideoPrepared(f, audioBoostOn, now, lastUserPt, vp) : -Infinity;
        if (s > -1e8) insertTopN(__topBuf, { v, s }, N);
      }
      for (let i = 0; i < __topBuf.length; i++) __applySetReuse.add(__topBuf[i].v);
      return __applySetReuse;
    };
    return Object.freeze({ pickDetailed, buildApplySetReuse });
  }

  function createEventBus() {
    const subs = new Map();
    const on = (name, fn) => { let s = subs.get(name); if (!s) { s = new Set(); subs.set(name, s); } s.add(fn); return () => s.delete(fn); };
    const emit = (name, payload) => { const s = subs.get(name); if (!s) return; for (const fn of s) { try { fn(payload); } catch (_) {} } };
    let queued = false, aeLevelAgg = 0, forceApplyAgg = false, lockMsAgg = 0, lockAmpAgg = 0, profileChangedAgg = false;
    const sigPayload = { aeLevel: 0, forceApply: false, userLockMs: 0, userLockAmp: 0, profileChanged: false };
    function flush() { queued = false; sigPayload.aeLevel = aeLevelAgg; sigPayload.forceApply = forceApplyAgg; sigPayload.userLockMs = lockMsAgg; sigPayload.userLockAmp = lockAmpAgg; sigPayload.profileChanged = profileChangedAgg; emit('signal', sigPayload); aeLevelAgg = 0; forceApplyAgg = false; lockMsAgg = 0; lockAmpAgg = 0; profileChangedAgg = false; }
    const signal = (p) => { if (p) { if (p.affectsAE) aeLevelAgg = Math.max(aeLevelAgg, 2); if (p.wakeAE) aeLevelAgg = Math.max(aeLevelAgg, 1); if (p.aeLevel != null) aeLevelAgg = Math.max(aeLevelAgg, (p.aeLevel | 0)); if (p.forceApply) forceApplyAgg = true; if (p.userLockMs) lockMsAgg = Math.max(lockMsAgg, (p.userLockMs | 0)); if (p.userLockAmp != null) lockAmpAgg = Math.max(lockAmpAgg, +p.userLockAmp); if (p.profileChanged) profileChangedAgg = true; } if (!queued) { queued = true; requestAnimationFrame(flush); } };
    return Object.freeze({ on, emit, signal });
  }

  function computeAeMix3Into(outMix, vf, aeMeta, Utils, userLock01) {
    const { clamp } = Utils; const mix = clamp(vf.presetMix ?? 1.0, 0, 1);
    const pB = PRESETS.grade[vf.presetB] || PRESETS.grade.brOFF;

    const manualExp = Math.abs(vf.bright || 0) / 55 + Math.abs((vf.gamma || 1) - 1) / 0.75 + Math.abs((vf.contrast || 1) - 1) / 0.65;
    const manualCol = Math.abs((vf.sat || 100) - 100) / 120 + Math.abs(vf.temp || 0) / 20;

    const presetExp = Math.abs((pB.brightAdd || 0) * mix) / 55 + Math.abs(((pB.gammaF || 1) - 1) * mix) / 0.32 + Math.abs(((pB.conF || 1) - 1) * mix) / 0.26;
    const presetCol = Math.abs(((pB.satF || 1) - 1) * mix) / 0.30 + Math.abs((pB.tempAdd || 0) * mix) / 12;

    const toneStr = (!!vf.tonePreset && vf.tonePreset !== 'off' && vf.tonePreset !== 'neutral') ? clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;

    const sharpIntent = Math.abs(vf.sharp || 0) / 50;
    const sharp2Intent = Math.abs(vf.sharp2 || 0) / 50;
    const clarityIntent = Math.abs(vf.clarity || 0) / 50;

    const expIntent = clamp(manualExp + presetExp + toneStr * 0.18, 0, 3.0);
    const toneIntent = clamp((manualExp * 0.55) + manualCol + presetCol + toneStr * 0.55 + (clarityIntent * 0.95) + (sharpIntent * 0.15) + (sharp2Intent * 0.22), 0, 3.5);
    const colorIntent = clamp((manualCol * 1.25) + (presetCol * 1.15) + toneStr * 0.20 + (sharpIntent * 0.10) + (sharp2Intent * 0.15), 0, 3.0);

    let expMix = clamp(1 - 0.60 * clamp(expIntent / 1.45, 0, 1), 0.20, 1.00);
    let toneMix = clamp(1 - 0.75 * clamp(toneIntent / 1.45, 0, 1), 0.08, 1.00);
    let colorMix = clamp(1 - 0.82 * clamp(colorIntent / 1.30, 0, 1), 0.05, 1.00);

    const prof = (aeMeta && aeMeta.profileResolved) ? aeMeta.profileResolved : (vf.aeProfile || 'auto');
    const tune = AE_MIX_TUNE[prof] || AE_MIX_TUNE.standard;
    const bias = AE_AUTO_MIX_BIAS[prof] || AE_AUTO_MIX_BIAS.standard;

    const conf01 = clamp(
      (manualExp * 0.80 + manualCol * 1.10 + presetExp * 0.50 + presetCol * 0.70 + sharpIntent * 0.75 + sharp2Intent * 0.95 + clarityIntent * 0.85 + toneStr * 0.55) / 2.35,
      0, 1
    );

    expMix *= tune.expBase * bias.exp * (1 - conf01 * (0.34 * tune.conflictK));
    toneMix *= tune.toneBase * bias.tone * (1 - conf01 * (0.58 * tune.conflictK));
    colorMix *= (0.96 + 0.04 * bias.tone) * (1 - conf01 * (0.64 * tune.conflictK));

    const hi = clamp(aeMeta?.hiRisk ?? 0, 0, 1);
    if (hi > 0.02) {
      expMix *= (1 - 0.10 * hi);
      toneMix *= (1 - 0.26 * hi);
      colorMix *= (1 - 0.20 * hi);
    }

    const aeBrightLikely = clamp(Math.abs(aeMeta?.luma ?? 0) / 100, 0, 1) * 0.20 + clamp(Math.abs(aeMeta?.clipFrac ?? 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 4), 0, 1) * 0.35 + clamp(aeMeta?.hiRisk ?? 0, 0, 1) * 0.45;
    const userBrightIntent = clamp(Math.abs(vf.bright || 0) / 25 + Math.abs((vf.gamma || 1) - 1) / 0.20 + Math.abs((vf.contrast || 1) - 1) / 0.20, 0, 2.0) / 2.0;
    expMix *= (1 - 0.18 * userBrightIntent * (0.5 + 0.5 * aeBrightLikely));

    const colorHeavy01 = clamp((manualCol * 1.2 + presetCol * 0.8 + toneStr * 0.4) / 1.8, 0, 1);
    expMix *= (1 - 0.14 * colorHeavy01);

    const lock = clamp(userLock01 || 0, 0, 1);
    expMix *= (1 - 0.80 * lock);
    toneMix *= (1 - 0.90 * lock);
    colorMix *= (1 - 0.92 * lock);

    const expFloor = (conf01 > 0.75) ? 0.02 : 0.10;
    const toneFloor = (conf01 > 0.75) ? 0.00 : 0.05;
    const colorFloor = (conf01 > 0.75) ? 0.00 : 0.04;

    outMix.expMix = Math.round(clamp(expMix, expFloor, 1.00) / 0.02) * 0.02;
    outMix.toneMix = Math.round(clamp(toneMix, toneFloor, 1.00) / 0.02) * 0.02;
    outMix.colorMix = Math.round(clamp(colorMix, colorFloor, 1.00) / 0.02) * 0.02;
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

  function getAePack(isMobile, profileName) {
    const dev = isMobile ? AE_DEVICE_BASE.mobile : AE_DEVICE_BASE.pc;
    const prof = AE_PROFILES[profileName] || AE_PROFILES.standard;
    const cfg = { ...AE_COMMON, STRENGTH: prof.STRENGTH ?? dev.STRENGTH, TARGET_MID_BASE: prof.TARGET_MID_BASE ?? dev.TARGET_MID_BASE, MAX_UP_EV: prof.MAX_UP_EV ?? dev.MAX_UP_EV, MAX_DOWN_EV: prof.MAX_DOWN_EV ?? dev.MAX_DOWN_EV, TONE_BIAS: (prof.TONE_BIAS ?? 0), TEMP_BIAS: (prof.TEMP_BIAS ?? 0) };
    return Object.freeze({ cfg: Object.freeze(cfg), look: Object.freeze(prof.LOOK || { brMul: 1.0, satMul: 1.0, conMul: 1.0 }) });
  }

  function applyTonePreset2Inline(out, presetName, strength, aeProfileName, Utils) {
    if (!presetName || presetName === 'off' || presetName === 'neutral') return out;
    const p0 = PRESETS.tone[presetName] || PRESETS.tone.neutral; let t = Utils.clamp(strength ?? 1.0, 0, 1);
    let toe = p0.toe, shoulder = p0.shoulder, mid = p0.mid, con = p0.con, sat = p0.sat, br = p0.br, tmp = p0.tmp;
    if (presetName === 'highlight') { if (aeProfileName === 'bright') { shoulder *= 0.65; br *= 0.65; t *= 0.90; } else if (aeProfileName === 'cinemaHdr') { br *= 0.75; con = 1.00; t *= 0.95; } }
    else if (presetName === 'redSkin') { if (aeProfileName === 'bright') { sat = 1.03; br *= 0.70; t *= 0.92; } else if (aeProfileName === 'cinemaHdr') { sat = 1.03; tmp *= 0.80; } }
    out.mid = Utils.clamp((out.mid || 0) + (mid * t), -1, 1); out.contrast = Utils.clamp((out.contrast || 1) * (1 + (con - 1) * t), 0.5, 2.0); out.satF = Utils.clamp((out.satF || 1) * (1 + (sat - 1) * t), 0.0, 2.0); out.bright = Utils.clamp((out.bright || 0) + (br * t), -50, 50); out.temp = Utils.clamp((out.temp || 0) + (tmp * t), -25, 25); out.toe = Utils.clamp((out.toe || 0) + (toe * t), -14, 14); out.shoulder = Utils.clamp((out.shoulder || 0) + (shoulder * t), -14, 14);
    return out;
  }

  function composeVideoParamsInto(out, vUser, ae, Utils, resolvedAeProfileName) {
    const clamp = Utils.clamp; const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);
    const pD = PRESETS.detail[vUser.presetS] || PRESETS.detail.off; const pB = PRESETS.grade[vUser.presetB] || PRESETS.grade.brOFF;
    const preGammaF = lerp(1.0, pB.gammaF, mix), preConF = lerp(1.0, pB.conF, mix), preSatF = lerp(1.0, pB.satF, mix), preBright = (pB.brightAdd || 0) * mix, preTemp = (pB.tempAdd || 0) * mix;
    const preSharp = (pD.sharpAdd || 0) * mix, preSharp2 = (pD.sharp2Add || 0) * mix, preClarity = (pD.clarityAdd || 0) * mix;
    const A = ae || AE_ZERO;
    let gamma = (vUser.gamma || 1.0) * preGammaF;
    let contrast = (vUser.contrast || 1.0) * preConF * (A.conF || 1.0), satF = ((vUser.sat || 100) / 100) * preSatF * (A.satF || 1.0), bright = (vUser.bright || 0) + preBright + (A.brightAdd || 0), temp = (vUser.temp || 0) + preTemp + (A.tempAdd || 0);
    const gain = clamp(A.gain ?? 1.0, 0.60, 8.0);
    let sharpMul = Math.max(0.88, 1 / (1 + (gain - 1.0) * 0.4)) * (1 - Math.min(0.08, (A.hiRisk || 0) * 0.1)) * (0.92 + 0.08 * Math.max(0, Math.min(1, ((A.cf != null ? A.cf : 0.5) - 0.10) / 0.22)));
    const chromaStress = (Math.min(1, Math.abs(satF - 1) / 0.55) * 0.85) + (Math.min(1, Math.abs(temp) / 25) * 0.65);
    const riskStress = (clamp(A.hiRisk || 0, 0, 1) * 0.70) + ((1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1)) * 0.45);
    const guard = 1 / (1 + chromaStress * 0.15 + riskStress * 0.15);
    sharpMul *= (0.92 + 0.08 * guard);
    const hiRisk01 = clamp(A.hiRisk || 0, 0, 1); const clip01 = clamp((A.clipFrac || 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1); const flat01 = 1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1);
    const aeDetailGuard = 1 - (hiRisk01 * 0.10 + clip01 * 0.06 + flat01 * 0.04);
    sharpMul *= clamp(aeDetailGuard, 0.82, 1.0);

    let sharp = ((vUser.sharp || 0) + preSharp) * sharpMul;
    let sharp2 = ((vUser.sharp2 || 0) + preSharp2) * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2)));
    let clarity = ((vUser.clarity || 0) + preClarity) * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2)));

    const clarityRiskDamp = 1 - (hiRisk01 * 0.18 + clip01 * 0.10);
    clarity *= clamp(clarityRiskDamp, 0.72, 1.0);

    const skin01 = clamp(A.skinScore || 0, 0, 1); sharp *= (1 - 0.05 * skin01); sharp2 *= (1 - 0.10 * skin01);
    const manualIntent = Math.abs(vUser.bright || 0) / 22 + Math.abs((vUser.gamma || 1) - 1) / 0.14 + Math.abs((vUser.contrast || 1) - 1) / 0.14 + Math.abs((vUser.sat || 100) - 100) / 35 + Math.abs(vUser.temp || 0) / 9 + Math.abs(vUser.sharp || 0) / 35 + Math.abs(vUser.sharp2 || 0) / 35 + Math.abs(vUser.clarity || 0) / 30;
    const manualIntent01 = clamp(manualIntent / 2.2, 0, 1);
    const styleMix = 1.00 - 0.18 * manualIntent01;
    out.gain = gain; out.gamma = clamp(gamma, 0.5, 2.5); out.contrast = clamp(contrast, 0.5, 2.0); out.bright = clamp(bright, -50, 50); out.mid = clamp(((A.mid || 0) * styleMix), -1, 1); out.sharp = clamp(sharp, 0, 50); out.sharp2 = clamp(sharp2, 0, 50); out.clarity = clamp(clarity, 0, 50); out.dither = vUser.dither || 0; out.temp = clamp(temp, -25, 25); out.toe = (A.toe || 0) * styleMix; out.shoulder = (A.shoulder || 0) * styleMix;

    const tempStress01 = clamp(Math.abs(out.temp || 0) / 18, 0, 1);
    if (tempStress01 > 0) {
        const satCap = 1.18 - 0.10 * tempStress01;
        out.satF = clamp(satF, 0.0, satCap);
    } else {
        out.satF = clamp(satF, 0.0, 2.0);
    }

    if (vUser.tonePreset && vUser.tonePreset !== 'off' && vUser.tonePreset !== 'neutral') {
        const toneAeProfileName = vUser.ae ? (resolvedAeProfileName || vUser.aeProfile || 'auto') : null;
        applyTonePreset2Inline(out, vUser.tonePreset, vUser.toneStrength, toneAeProfileName, Utils);

        out.temp = clamp(out.temp || 0, -25, 25);
        const tempStress01b = clamp(Math.abs(out.temp || 0) / 18, 0, 1);
        if (tempStress01b > 0) {
          const satCap2 = 1.18 - 0.10 * tempStress01b;
          out.satF = clamp(out.satF, 0.0, satCap2);
        } else {
          out.satF = clamp(out.satF, 0.0, 2.0);
        }
        out.contrast = clamp(out.contrast, 0.5, 2.0);
        out.bright   = clamp(out.bright, -50, 50);
    }
    return out;
  }

  const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.dither ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0;
    function timerCb() { timer = 0; requestAnimationFrame(run); }
    const run = () => { queued = false; const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun; if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) { timer = setTimeout(timerCb, wait); } return; } lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} } };
    const request = (immediate = false) => {
      if (immediate) {
        force = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        if (!queued) queued = true;
        requestAnimationFrame(run);
        return;
      }
      if (queued) return;
      queued = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      requestAnimationFrame(run);
    };
    return { registerApply: (fn) => { applyFn = fn; }, request };
  }

  function createLocalStore(defaults, scheduler, Utils) {
    let rev = 0;
    const listeners = new Map();
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch(_) {} } const [cat] = key.split('.'); const b = listeners.get(cat + '.*'); if (b) for (const cb of b) { try { cb(val); } catch(_) {} } };

    const state = Utils.deepClone(defaults);
    const proxyCache = {};

    function createProxyDeep(obj, pathPrefix) {
      return new Proxy(obj, {
        get(target, prop) {
          if (typeof target[prop] === 'object' && target[prop] !== null) {
            const cacheKey = pathPrefix ? `${pathPrefix}.${prop}` : prop;
            if (!proxyCache[cacheKey]) {
              proxyCache[cacheKey] = createProxyDeep(target[prop], cacheKey);
            }
            return proxyCache[cacheKey];
          }
          return target[prop];
        },
        set(target, prop, val) {
          if (!Object.is(target[prop], val)) {
            target[prop] = val;
            rev++;
            const fullPath = pathPrefix ? `${pathPrefix}.${prop}` : prop;
            emit(fullPath, val);
            scheduler.request(false);
          }
          return true;
        }
      });
    }

    const proxyState = createProxyDeep(state, '');

    return {
      state: proxyState,
      rev: () => rev,
      getCatRef: (cat) => proxyState[cat],
      get: (p) => { const [c, k] = p.split('.'); return state[c]?.[k]; },
      set: (p, val) => { const [c, k] = p.split('.'); if (k) proxyState[c][k] = val; },
      batch: (cat, obj) => { for (const [k, v] of Object.entries(obj)) { proxyState[cat][k] = v; } },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => { const cur = listeners.get(k); if (cur) cur.delete(f); }; }
    };
  }

  function createRegistry(scheduler, featureCheck) {
    const videos = new Set(); const visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    const shadowRootsLRU = []; const SHADOW_LRU_MAX = CONFIG.IS_LOW_END ? 8 : 24; const observedShadowHosts = new WeakSet();

    let __refreshQueued = false;
    function requestRefreshCoalesced() {
      if (__refreshQueued) return;
      __refreshQueued = true;
      requestAnimationFrame(() => {
        __refreshQueued = false;
        if (featureCheck.active()) scheduler.request(false);
      });
    }

    const io = new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; el[VSCX.visible] = isVis; el[VSCX.ir] = e.intersectionRatio || 0; el[VSCX.rect] = e.boundingClientRect; el.__vscRectT = now;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
      }
      if (changed) { rev++; requestRefreshCoalesced(); }
    }, { root: null, threshold: 0.01, rootMargin: CONFIG.IS_LOW_END ? '120px' : '300px' });
    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

    const observeVideo = (el) => { if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; patchFullscreenRequest(el); videos.add(el); io.observe(el); };

    const WorkQ = (() => {
      const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap();
      function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); }
      const schedule = () => { if (scheduled) return; scheduled = true; if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle); else requestAnimationFrame(drainRunnerRaf); };
      const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); };
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
      const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; while (bigHead < bigQ.length && budget()) { scanNode(bigQ[bigHead++]); break; } while (head < q.length && budget()) { scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); };
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
    const connectObserver = (root) => {
      if (!root) return;
      const mo = new MutationObserver((muts) => {
        let touchedVideoTree = false;
        for (const m of muts) {
          if (m.addedNodes && m.addedNodes.length) {
            for (const n of m.addedNodes) {
              if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
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

    const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
    document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail; const host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} });
    refreshObservers();

    let pruneIterVideos = null;
    function pruneBatchRoundRobinNoAlloc(set, visibleSet, dirtySet, unobserveFn, batch = 200) {
      let removed = 0; let scanned = 0;
      if (!pruneIterVideos) pruneIterVideos = set.values();
      while (scanned < batch) {
        let n = pruneIterVideos.next();
        if (n.done) { pruneIterVideos = set.values(); n = pruneIterVideos.next(); if (n.done) break; }
        const el = n.value;
        if (el && !el.isConnected) {
          set.delete(el); visibleSet.delete(el); dirtySet.delete(el);
          try { unobserveFn(el); } catch (_) {} removed++;
        }
        scanned++;
      }
      return removed;
    }
    return { videos, visible, rev: () => rev, refreshObservers, prune: () => { const removed = pruneBatchRoundRobinNoAlloc(videos, visible.videos, dirty.videos, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220); if(removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { WorkQ.enqueue(document.body || document.documentElement); } };
  }

  function createAudio(sm) {
    let ctx, compressor, dry, wet, target = null, currentSrc = null, wetConnected = false; const srcMap = new WeakMap();
    let lastDryOn = null; let lastWetGain = null; let gestureHooked = false;
    const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') { await ctx.resume(); } if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
    const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; window.addEventListener('pointerdown', onGesture, { passive: true, capture: true }); window.addEventListener('keydown', onGesture, { passive: true, capture: true }); };
    const ensureCtx = () => { if (ctx) return true; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); ensureGestureResumeHook(); compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.knee.value = 24; compressor.ratio.value = 4; compressor.attack.value = 0.005; compressor.release.value = 0.20; dry = ctx.createGain(); wet = ctx.createGain(); dry.connect(ctx.destination); wet.connect(ctx.destination); compressor.connect(wet); return true; };
    const updateMix = () => {
      if (!ctx) return;
      const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
      const boost = Math.pow(10, sm.get(P.A_BST) / 20);
      const dryTarget = en ? 0 : 1;
      const wetTarget = en ? boost : 0;
      const t = ctx.currentTime;
      if (lastDryOn !== dryTarget) {
        try { dry.gain.cancelScheduledValues(t); dry.gain.setTargetAtTime(dryTarget, t, 0.015); } catch(e) { dry.gain.value = dryTarget; }
        lastDryOn = dryTarget;
      }
      if (lastWetGain == null || Math.abs(lastWetGain - wetTarget) > 1e-4) {
        try { wet.gain.cancelScheduledValues(t); wet.gain.setTargetAtTime(wetTarget, t, 0.015); } catch(e) { wet.gain.value = wetTarget; }
        lastWetGain = wetTarget;
      }
      if (currentSrc) { if (en && !wetConnected) { try { currentSrc.connect(compressor); wetConnected = true; } catch (_) {} } else if (!en && wetConnected) { try { currentSrc.disconnect(compressor); wetConnected = false; } catch (_) {} } }
    };
    const disconnectAll = () => { if (currentSrc) { try { if (wetConnected) currentSrc.disconnect(compressor); currentSrc.disconnect(dry); } catch (_) {} } currentSrc = null; target = null; wetConnected = false; };
    return { setTarget: (v) => { const enabled = sm.get(P.A_EN) && sm.get(P.APP_ACT); if (v && v[VSCX.audioFail]) { if (v !== target) { disconnectAll(); target = v; } updateMix(); return; } if (v !== target) { disconnectAll(); target = v; } if (!v) { updateMix(); return; } if (!ensureCtx()) return; if (!currentSrc && (enabled || (ctx && sm.get(P.APP_ACT)))) { try { let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); } s.connect(dry); currentSrc = s; } catch (_) { v[VSCX.audioFail] = true; disconnectAll(); } } updateMix(); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc };
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(CONFIG.IS_LOW_END ? 320 : 720);
    const getNoiseUrl = (() => { let u = null; return () => { if (!u) { const c = document.createElement('canvas'); c.width = c.height = 64; const cx = c.getContext('2d', { alpha: false }), img = cx.createImageData(64, 64); let a = 1337 >>> 0; const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; for (let i = 0; i < img.data.length; i += 4) { const n = Math.floor(128 + (r() - 0.5) * 90); img.data[i] = img.data[i + 1] = img.data[i + 2] = n; img.data[i + 3] = 255; } cx.putImageData(img, 0, 0); u = c.toDataURL('image/png'); } return u; }; })();
    const qInt = (v, step) => Math.round(v / step), setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; node.setAttribute(attr, val); } }, smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };

    const makeKey = (s) => ['video', qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2), qInt(s.dither, 1)].join('|');

    function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
      const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(gain,0.06)}`; const hit = toneCache.get(key); if (hit) return hit;
      if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; }
      const toeEnd = 0.34 + toeN * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1, shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN), ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g), pivot = clamp(0.50 + midN * 0.06, 0.44, 0.56);
      const out = new Array(steps); let prev = 0;
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1); let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0; x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
        if (toeAmt > 1e-6) { const w = 1 - smoothstep(0, toeEnd, x); x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1); }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart));
          const kk = Math.max(0.7, 1.2 + shAmt * 6.5);
          const shDen = (1 - Math.exp(-kk));
          const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        let y = x;
        if (y < prev) y = prev; prev = y;
        const yy = Math.round(y * 100000) / 100000; out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
      }
      const res = out.join(' '); toneCache.set(key, res); return res;
    }

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

      const feImg = h('feImage', { ns: 'svg', href: getNoiseUrl(), preserveAspectRatio: 'none', result: 'noiseImg' }); try { feImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', getNoiseUrl()); } catch(_) {}
      const feTile = h('feTile', { ns: 'svg', in: 'noiseImg', result: 'noise' }), feComp = h('feComposite', { ns: 'svg', in: 'sat', in2: 'noise', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'out' });

      filter.append(tone, bcLin, gam, b1, sh1, b2, sh2, bc, cl, tmp, sat, feImg, feTile, feComp); defs.append(filter);
      const tryAppend = () => { const r = doc.documentElement || doc.body; if (r) { r.appendChild(svg); return true; } return false; };
      if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }
      return { fid, toneFuncs: Array.from(tone.children), bcLinFuncs: Array.from(bcLin.children), gamFuncs: Array.from(gam.children), tmpFuncs: Array.from(tmp.children), sat, b1, sh1, b2, sh2, bc, cl, feComp, st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', detailKey: '', noiseKey: '', __b1: '', __sh1k2: '', __sh1k3: '', __b2: '', __sh2k2: '', __sh2k3: '', __bc: '', __clk2: '', __clk3: '' } };
    }

    function prepare(doc, s) {
      let dc = urlCache.get(doc); if (!dc) { dc = { key:'', url:'' }; urlCache.set(doc, dc); }
      const key = makeKey(s); if (dc.key === key) return dc.url;
      let nodes = ctxMap.get(doc); if (!nodes) { nodes = buildSvg(doc); ctxMap.set(doc, nodes); }
      if (nodes.st.lastKey !== key) {
        nodes.st.lastKey = key; const st = nodes.st, ditherOn = (s.dither || 0) > 0, steps = ditherOn ? (CONFIG.IS_LOW_END ? 64 : 96) : (CONFIG.IS_LOW_END ? 96 : 128);
        const gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08;
        const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(clamp(s.mid||0,-1,1),0.02)}|${qInt(s.gain||1,gainQ)}`;
        if (st.toneKey !== tk) { st.toneKey = tk; const table = getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.gain||1,gainQ)*gainQ); if (st.toneTable !== table) { st.toneTable = table; for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', table); } }

        const con = clamp(s.contrast || 1, 0.5, 2.0);
        const brightOffset = clamp((s.bright || 0) / 1000, -0.2, 0.2);
        const intercept = clamp(0.5 * (1 - con) + brightOffset, -1, 1);
        const bcLinKey = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
        if (st.bcLinKey !== bcLinKey) { st.bcLinKey = bcLinKey; for (const fn of nodes.bcLinFuncs) { fn.setAttribute('slope', con.toFixed(3)); fn.setAttribute('intercept', intercept.toFixed(4)); } }

        const gk = (1/clamp(s.gamma||1,0.2,3)).toFixed(4); if (st.gammaKey !== gk) { st.gammaKey = gk; for (const fn of nodes.gamFuncs) fn.setAttribute('exponent', gk); }
        setAttr(nodes.sat, 'values', clamp(s.satF ?? 1, 0, 2.5).toFixed(2), st, 'satKey');
        const t = clamp(s.temp || 0, -25, 25); let rs = 1, gs = 1, bs = 1; if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.01; } else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.01; } const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`; if (st.tempKey !== tmk) { st.tempKey = tmk; nodes.tmpFuncs[0].setAttribute('slope', rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', bs.toFixed(3)); }
        const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
        if (st.detailKey !== dk) { st.detailKey = dk; const sc = (x) => x * x * (3 - 2 * x), v1 = (s.sharp || 0) / 50, kC = sc(Math.min(1, v1)) * 1.8; setAttr(nodes.b1, 'stdDeviation', v1 > 0 ? (0.85 - sc(Math.min(1, v1)) * 0.3).toFixed(2) : '0', st, '__b1'); setAttr(nodes.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2'); setAttr(nodes.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3'); const v2 = (s.sharp2 || 0) / 50, kF = sc(Math.min(1, v2)) * 3.8; setAttr(nodes.b2, 'stdDeviation', v2 > 0 ? '0.32' : '0', st, '__b2'); setAttr(nodes.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2'); setAttr(nodes.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3'); const clVal = (s.clarity || 0) / 50; setAttr(nodes.bc, 'stdDeviation', clVal > 0 ? '1.2' : '0', st, '__bc'); setAttr(nodes.cl, 'k2', (1 + clVal).toFixed(3), st, '__clk2'); setAttr(nodes.cl, 'k3', (-clVal).toFixed(3), st, '__clk3'); }
        const amt = clamp((s.dither || 0) / 100, 0, 1), nk = `${(amt * 0.04).toFixed(4)}|${(-0.5 * amt * 0.04).toFixed(4)}`; if (st.noiseKey !== nk) { st.noiseKey = nk; nodes.feComp.setAttribute('k3', (amt * 0.04).toFixed(4)); nodes.feComp.setAttribute('k4', (-0.5 * amt * 0.04).toFixed(4)); }
      }
      const url = `url(#${nodes.fid})`; dc.key = key; dc.url = url; return url;
    }

    return {
      prepareCached: (doc, s) => { try { return prepare(doc, s); } catch (e) { try { console.warn('[VSC] filter prepare failed:', e); } catch(_) {} return null; } },
      applyUrl: (el, url) => {
        if (!el) return;
        if (!url) {
          if (el[VSCX.applied]) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el[VSCX.applied] = false; el[VSCX.lastFilterUrl] = null; }
          return;
        }
        if (el[VSCX.lastFilterUrl] === url) return;
        el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important');
        el[VSCX.applied] = true;
        el[VSCX.lastFilterUrl] = url;
      },
      clear: (el) => {
        if (!el || !el[VSCX.applied]) return;
        el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter');
        el[VSCX.applied] = false;
        el[VSCX.lastFilterUrl] = null;
      }
    };
  }

  const WORKER_CODE = `
    const histAll = new Uint32Array(256), histTop = new Uint32Array(256), histBot = new Uint32Array(256), histMid = new Uint32Array(256);
    let prevFrame = null;
    let offCanvas = null;
    let offCtx = null;
    function pctFromHist(h, n, p) { const t = n * p; let a = 0; for(let i=0;i<256;i++){ a += h[i]; if(a >= t) return i/255; } return 1; }
    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
    function skinLikeYCbCr(r, g, b, y8) {
      if (y8 < 35 || y8 > 235) return 0;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (cb < 77 || cb > 127 || cr < 133 || cr > 173) return 0;
      const cbD = Math.abs(cb - 102) / 25;
      const crD = Math.abs(cr - 153) / 20;
      const chromaScore = clamp01(1 - (cbD * 0.55 + crD * 0.70));
      const bf = b / 255, rf = r / 255, gf = g / 255;
      const antiBlue = clamp01(1 - Math.max(0, (bf - rf) * 1.8));
      const rgBalance = clamp01(1 - Math.abs((rf - gf) - 0.08) * 2.8);
      return chromaScore * (0.65 + 0.35 * antiBlue) * (0.60 + 0.40 * rgBalance);
    }

    self.onmessage = function(e) {
      const {buf, bitmap, width, height, step, token} = e.data || {};
      if(!width || !height) return;

      let data;
      if (bitmap) {
        if (!offCanvas) {
          offCanvas = new OffscreenCanvas(width, height);
          offCtx = offCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
        } else if (offCanvas.width !== width || offCanvas.height !== height) {
          offCanvas.width = width; offCanvas.height = height;
        }
        offCtx.drawImage(bitmap, 0, 0, width, height);
        data = offCtx.getImageData(0, 0, width, height).data;
        bitmap.close();
      } else if (buf) {
        data = new Uint8ClampedArray(buf);
      } else {
        return;
      }

      let diff = 0, mCnt = 0, j = 0;
      const stepM = step;
      const pLen = Math.ceil(data.length / (4 * stepM));

      if (!prevFrame || prevFrame.length !== pLen) {
        prevFrame = new Uint8Array(pLen);
        for (let i = 0; i < data.length; i += 4 * stepM) {
          prevFrame[j++] = (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]) | 0;
        }
        diff = 0;
      } else {
        for (let i = 0; i < data.length && j < prevFrame.length; i += 4 * stepM) {
          const y = (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]) | 0;
          diff += Math.abs(y - prevFrame[j]);
          prevFrame[j++] = y;
          mCnt++;
        }
      }
      const motion01 = mCnt ? Math.min(1, Math.max(0, (diff / mCnt) / 28)) : 1;

      histAll.fill(0); histTop.fill(0); histBot.fill(0); histMid.fill(0);
      let sumAll=0, sumSqAll=0, nAll=0;
      let sumTop=0, sumSqTop=0, nTop=0;
      let sumMid=0, sumSqMid=0, nMid=0;
      let clipAll=0, clipBottom=0, clipTop=0, clipLowAll=0;
      let botSum=0, botSumSq=0, botN=0;
      let botBrightRows=0, botRowCount=0;
      let botWhitePix=0, botPix=0, botEdgePix=0, botEdgePairs=0, botTextLikePix=0;
      let rSum=0, gSum=0, bSum=0, skinCnt=0, skinAcc=0;

      const botY0 = Math.floor(height * 0.78);
      const midY0 = Math.floor(height * 0.18);
      const midY1 = Math.floor(height * 0.82);
      const stride = width * 4;

      for(let y=0; y<height; y+=step){
        const row = y*stride;
        const isTop = (y < botY0);
        const isBottom = !isTop;
        const isMid = (y >= midY0 && y < midY1);
        let rowSum=0, rowSumSq=0, rowCnt=0;
        let prevRowY = -1;

        for(let x=0; x<width; x+=step){
          const i = row + x*4;
          const r = data[i], g = data[i+1], b = data[i+2];
          const Y = (0.2126*r + 0.7152*g + 0.0722*b) | 0;

          histAll[Y]++; sumAll += Y; sumSqAll += Y*Y; nAll++;
          rSum += r; gSum += g; bSum += b;

          if(isTop) { histTop[Y]++; sumTop += Y; sumSqTop += Y*Y; nTop++; }
          else { histBot[Y]++; botSum += Y; botSumSq += Y*Y; botN++; }

          if(isMid) { histMid[Y]++; sumMid += Y; sumSqMid += Y*Y; nMid++; }

          if(Y >= 251){ clipAll++; if(isBottom) clipBottom++; if(isTop) clipTop++; }
          if(Y <= 4){ clipLowAll++; }

          if(isBottom){
            botPix++; rowSum += Y; rowSumSq += Y*Y; rowCnt++;
            if (Y > 228) botWhitePix++;
            if (prevRowY >= 0) {
              const dY = Math.abs(Y - prevRowY);
              botEdgePairs++;
              if (dY > 24) botEdgePix++;
              if (Y > 205 && dY > 18) botTextLikePix++;
            }
            prevRowY = Y;
          }

          const s = skinLikeYCbCr(r, g, b, Y);
          if (s > 0) {
            const nx = (x / Math.max(1, width - 1)) * 2 - 1;
            const ny = (y / Math.max(1, height - 1)) * 2 - 1;
            const centerW = clamp01(1 - (Math.abs(nx) * 0.55 + Math.abs(ny) * 0.35));
            skinAcc += s * (0.70 + 0.30 * centerW);
            skinCnt++;
          }
        }
        if (isBottom && rowCnt > 0){
          botRowCount++;
          const avg = rowSum / rowCnt, varr = (rowSumSq / rowCnt) - avg*avg, std = Math.sqrt(Math.max(0,varr));
          if (avg > 236 && std < 8.5) botBrightRows++;
        }
      }

      const avgAll = nAll ? (sumAll/nAll) : 0, varAll = nAll ? (sumSqAll/nAll - avgAll*avgAll) : 0, stdAll = Math.sqrt(Math.max(0,varAll))/255;
      const avgTop = nTop ? (sumTop/nTop) : avgAll, varTop = nTop ? (sumSqTop/nTop - avgTop*avgTop) : varAll, stdTop = Math.sqrt(Math.max(0,varTop))/255;
      const avgMid = nMid ? (sumMid/nMid) : avgAll, varMid = nMid ? (sumSqMid/nMid - avgMid*avgMid) : varAll, stdMid = Math.sqrt(Math.max(0,varMid))/255;
      const botAvg = botN ? (botSum/botN)/255 : 0, botVar = botN ? (botSumSq/botN - (botSum/botN)**2) : 0, botStd = Math.sqrt(Math.max(0,botVar))/255;

      const cfAll = Math.min(1, stdAll/0.22), cfTop = Math.min(1, stdTop/0.22), cfMid = Math.min(1, stdMid/0.22);
      const rgbSum = (rSum+gSum+bSum) || 1, redDominance = Math.max(0, Math.min(1, (rSum/rgbSum) - 0.28)), skinScore = skinCnt ? Math.min(1, (skinAcc/skinCnt) * 1.22) : 0;

      const botWhiteFrac = botPix ? (botWhitePix / botPix) : 0;
      const botEdgeFrac = botEdgePairs ? (botEdgePix / botEdgePairs) : 0;
      const botTextLike = botPix ? (botTextLikePix / botPix) : 0;

      self.postMessage({
        token, motion01,
        p05: pctFromHist(histAll, nAll, 0.05), p10: pctFromHist(histAll, nAll, 0.10), p35: pctFromHist(histAll, nAll, 0.35), p50: pctFromHist(histAll, nAll, 0.50), p90: pctFromHist(histAll, nAll, 0.90), p95: pctFromHist(histAll, nAll, 0.95), p98: pctFromHist(histAll, nAll, 0.98),
        avgLuma: avgAll/255, stdDev: stdAll, cf: cfAll, clipFrac: nAll ? (clipAll/nAll) : 0, clipFracTop: nTop ? (clipTop/nTop) : 0, clipLowFrac: nAll ? (clipLowAll/nAll) : 0,
        p10T: pctFromHist(histTop, nTop || 1, 0.10), p35T: pctFromHist(histTop, nTop || 1, 0.35), p50T: pctFromHist(histTop, nTop || 1, 0.50), p90T: pctFromHist(histTop, nTop || 1, 0.90), p95T: pctFromHist(histTop, nTop || 1, 0.95), p98T: pctFromHist(histTop, nTop || 1, 0.98), stdDevT: stdTop, cfT: cfTop,
        p10M: pctFromHist(histMid, nMid || 1, 0.10), p35M: pctFromHist(histMid, nMid || 1, 0.35), p50M: pctFromHist(histMid, nMid || 1, 0.50), p90M: pctFromHist(histMid, nMid || 1, 0.90), p95M: pctFromHist(histMid, nMid || 1, 0.95), p98M: pctFromHist(histMid, nMid || 1, 0.98), stdDevM: stdMid, cfM: cfMid,
        clipFracBottom: botN ? (clipBottom/botN) : 0, botAvg, botStd, botP95: pctFromHist(histBot, botN || 1, 0.95), botBrightRows, botRowCount,
        botWhiteFrac, botEdgeFrac, botTextLike,
        redDominance, skinScore
      });
    };
  `;

  function createAE(sm, { IS_MOBILE, Utils }, onAE) {
    let worker = null, workerUrl = null, canvas = null, ctx2d = null, activeVideo = null, isRunning = false, workerBusy = false, targetToken = 0;
    let __userLock01 = 0; const setUserLock01 = (v) => { __userLock01 = Utils.clamp(v || 0, 0, 1); };

    let loopToken = 0;
    const scheduleNextLoop = (token, v) => { const cb = (now, meta) => loop(token, meta); if (v && v.requestVideoFrameCallback && !v.paused) { try { v.requestVideoFrameCallback(cb); return; } catch (_) {} } setTimeout(() => cb(performance.now(), null), 90); };
    let lastStats = { p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 };
    let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0, curGain = 1.0, __prevFrame = null, __motion01 = 1, sampleCount = 0, lastLoopT = 0;
    let __autoProfile = 'standard', __autoHoldUntil = 0, __lastMeta = { hiRisk: 0, luma: 0, clipFrac: 0, cf: 0.5, skinScore: 0, profileResolved: 'standard', subLikely: false, p50: 0, p95: 0, p98: 0, motion01: 0 };
    let __subLikelyHoldUntil = 0;
    let __subCandidateStreak = 0;
    let __lastSampleCheckGain = 1.0;
    let __lastSampleMediaTime = -1;
    let __sameFrameSkipStreak = 0;
    let __autoProfileVotes = [];

    let __sceneChange01 = 1;
    let __aeBurstUntil = 0;
    let __workerStallStreak = 0;
    let __skinEma = 0;
    let __subConfEma = 0;
    let __prevSceneStats = null;

    const { clamp } = Utils; let __packKey = '', __pack = null;
    let __unavailable = false;
    let workerPolicy = null;
    const AE_STAT_KEYS = Object.freeze(['p05', 'p10', 'p35', 'p50', 'p90', 'p95', 'p98', 'clipFrac', 'clipLowFrac', 'cf', 'rd']);
    const getResolvedProfile = () => { const sel = sm.get(P.V_AE_PROFILE) || 'standard'; return (sel === 'auto') ? (__autoProfile || 'standard') : sel; };
    const getPack = () => { const name = getResolvedProfile(), key = (IS_MOBILE ? 'm|' : 'p|') + name; if (key !== __packKey) { __packKey = key; __pack = getAePack(IS_MOBILE, name); } return __pack; };
    const riskFrom = (p95, p98, clipFrac, clipLimit) => clamp(Math.max(clamp((p95 - 0.885) / 0.095, 0, 1) * 0.70 + clamp((p98 - 0.968) / 0.028, 0, 1) * 0.90, clamp((clipFrac - clipLimit) / (clipLimit * 4.0), 0, 1)), 0, 1);

    const smoothstep01 = (x) => {
      x = clamp(x, 0, 1);
      return x * x * (3 - 2 * x);
    };

    function computeAdaptiveSampleIntervalMs(v, now) {
      const paused = !!v?.paused;
      const rate = (v && Number.isFinite(v.playbackRate) && v.playbackRate > 0) ? v.playbackRate : 1;
      const risk01 = clamp(__lastMeta?.hiRisk ?? 0, 0, 1);
      const subLikely = !!(__lastMeta?.subLikely);
      const cf01 = clamp(lastStats.cf ?? 0.5, 0, 1);
      const stableScene = (__motion01 < 0.10) && (cf01 > 0.22);
      const sameTargetAndStable = stableScene && risk01 < 0.25;
      const gainDeltaEv = Math.abs(Math.log2(Math.max(1e-6, curGain)) - Math.log2(Math.max(1e-6, __lastSampleCheckGain)));
      const gainStable = gainDeltaEv < 0.03;

      let ms = paused ? 520 : (CONFIG.IS_LOW_END ? 112 : 82);
      ms += (1 - __motion01) * 72;
      ms -= risk01 * 20;
      if (now < __aeBurstUntil) ms *= 0.58;
      if (subLikely) ms *= 0.82;
      if (sameTargetAndStable) ms *= gainStable ? 1.85 : 1.20;
      const warmup01 = clamp(sampleCount / 4, 0, 1);
      ms *= (1.00 - (1 - warmup01) * 0.28);
      ms *= (1 + __userLock01 * 2.8);
      ms *= (1 + Math.min(4, __workerStallStreak) * 0.16);
      ms /= Math.min(2.4, Math.max(0.65, rate));

      if (paused) return clamp(ms, 180, 1200);
      return clamp(ms, CONFIG.IS_LOW_END ? 38 : 28, CONFIG.IS_LOW_END ? 240 : 190);
    }

    function sceneChangeFromStats(avgLumaNow, avgLumaPrev, motion01, cf01, prevStats, currStats, clamp) {
      if (avgLumaPrev < 0 || !prevStats) return 1;
      const avgDelta = Math.abs(avgLumaNow - avgLumaPrev);
      const p50Delta = Math.abs((currStats.p50 ?? 0) - (prevStats.p50 ?? 0));
      const p95Delta = Math.abs((currStats.p95 ?? 0) - (prevStats.p95 ?? 0));
      const cfDelta  = Math.abs((currStats.cf ?? 0.5) - (prevStats.cf ?? 0.5));
      const luminanceTerm = avgDelta / (0.040 + 0.020 * (1 - clamp(cf01, 0, 1)) + 0.015 * (1 - clamp(motion01, 0, 1)));
      const histTerm = (p50Delta / 0.06) * 0.8 + (p95Delta / 0.05) * 0.9 + (cfDelta / 0.10) * 0.4;
      return clamp(Math.max(luminanceTerm, histTerm), 0, 1);
    }
    const mixv = (a, b, w) => (a * (1 - w) + b * w);

    let __lookEma = { conF: 1, satF: 1, mid: 0, toe: 0, shoulder: 0, brightAdd: 0 };
    let __lookEmaInit = false;
    function smoothLook(look, dtMs, motion01, risk01) {
      const dt = Math.min(220, dtMs);
      const tauBright = 140 + (1 - motion01) * 80 + risk01 * 40;
      const tauMid    = 160 + (1 - motion01) * 100 + risk01 * 50;
      const tauCon    = 190 + (1 - motion01) * 120 + risk01 * 60;
      const tauSat    = 230 + (1 - motion01) * 140 + risk01 * 80;
      const tauToe    = 260 + (1 - motion01) * 150 + risk01 * 100;
      const tauSh     = 280 + (1 - motion01) * 160 + risk01 * 120;

      const aBright = 1 - Math.exp(-dt / Math.max(80, tauBright));
      const aMid    = 1 - Math.exp(-dt / Math.max(90, tauMid));
      const aCon    = 1 - Math.exp(-dt / Math.max(100, tauCon));
      const aSat    = 1 - Math.exp(-dt / Math.max(110, tauSat));
      const aToe    = 1 - Math.exp(-dt / Math.max(120, tauToe));
      const aSh     = 1 - Math.exp(-dt / Math.max(130, tauSh));

      if (!__lookEmaInit) { __lookEma = { ...look }; __lookEmaInit = true; return look; }

      __lookEma.conF      += (look.conF      - __lookEma.conF)      * aCon;
      __lookEma.satF      += (look.satF      - __lookEma.satF)      * aSat;
      __lookEma.mid       += (look.mid       - __lookEma.mid)       * aMid;
      __lookEma.toe       += (look.toe       - __lookEma.toe)       * aToe;
      __lookEma.shoulder  += (look.shoulder  - __lookEma.shoulder)  * aSh;
      __lookEma.brightAdd += (look.brightAdd - __lookEma.brightAdd) * aBright;

      return __lookEma;
    }

    const computeTargetEV = (s, cfg) => {
      const p50 = clamp(s.p50, 0.01, 0.99), risk01 = riskFrom(s.p95 ?? s.p90, s.p98 ?? s.p95, Math.max(0, s.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);
      let ev = Math.log2(clamp(cfg.TARGET_MID_BASE + clamp((0.17 - p50) / 0.11, 0, 1) * 0.050 - risk01 * 0.030, 0.20, 0.34) / clamp(p50 * 0.72 + clamp(s.p35 ?? s.p50, 0.01, 0.99) * 0.28, 0.01, 0.99)) * cfg.STRENGTH;
      ev = clamp(ev, cfg.MAX_DOWN_EV, cfg.MAX_UP_EV * (1 - 0.35 * risk01));
      if (risk01 > 0.58) ev = Math.min(ev, 0);
      ev = Math.min(ev, Math.log2(Math.max(1, Math.min(0.985 / clamp(s.p98 ?? s.p95, 0.01, 0.999), 0.980 / clamp(s.p95 ?? s.p90, 0.01, 0.999)))) - (0.06 * risk01));

      const deadUp = cfg.DEAD_IN; const deadDown = cfg.DEAD_IN * 0.65;
      if (ev >= 0 && ev < deadUp) return 0;
      if (ev < 0 && -ev < deadDown) return 0;
      return ev;
    };

    const computeLook = (ev, s, risk01, cfg, lookMul) => {
      const p50 = clamp(s.p50 ?? 0.5, 0, 1), up01 = clamp(clamp(ev / 1.55, -1, 1), 0, 1), upE = up01 * up01 * (3 - 2 * up01), lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1);
      let brightAdd = (up01 * 7.0) * clamp(0.52 - p50, -0.22, 0.22), mid = (up01 * 0.55) * clamp((0.50 - p50) / 0.22, -1, 1), toe = (3.6 + 5.6 * upE) * lowKey01 * (1 - 0.55 * risk01), shoulder = (4.8 + 5.2 * upE) * (risk01 * 0.85 + 0.15) * (1 - 0.25 * lowKey01), conF = 1 + (up01 * 0.050) * clamp((0.46 - clamp((clamp(s.p90 ?? 0.9, 0, 1) - clamp(s.p10 ?? 0.1, 0, 1)), 0, 1)) / 0.26, 0, 1) - (0.012 * risk01), satF = 1 + (1 - clamp(s.cf ?? 0.5, 0, 1)) * 0.22 * (1 - risk01 * 0.65);
      brightAdd *= (1 - 0.85 * risk01); shoulder *= (1 - 0.60 * risk01);
      const dn01 = clamp((-ev) / 1.10, 0, 1); const dnE = dn01 * dn01 * (3 - 2 * dn01);
      if (dn01 > 0) { satF *= (1 - 0.05 * dn01 * (0.5 + 0.5 * risk01)); conF = 1 + (conF - 1) * (1 - 0.20 * dn01); shoulder += 1.1 * dnE * (0.4 + 0.6 * risk01); brightAdd -= 1.2 * dnE * risk01; mid -= 0.10 * dnE * (0.6 + 0.4 * risk01); toe *= (1 - 0.18 * dn01); }
      const bias = clamp(cfg.TONE_BIAS ?? 0, -1, 1); brightAdd *= (1 + 0.10 * bias); satF *= (1 + 0.08 * bias); conF *= (1 + 0.02 * bias); shoulder *= (1 - 0.12 * bias); toe *= (1 + 0.08 * (-bias));
      const skinProtect = clamp(s.rd ?? 0, 0, 1) * 0.35; satF = satF * (1 - skinProtect * 0.35); conF = 1 + (conF - 1) * (1 - skinProtect * 0.25); shoulder *= (1 - skinProtect * 0.20 * risk01);
      const crush01 = clamp((0.045 - clamp(s.p05 ?? 0.05, 0, 1)) / 0.030, 0, 1) * 0.65 + clamp((clamp(s.clipLowFrac ?? 0, 0, 1) - 0.010) / 0.030, 0, 1) * 0.75;
      toe *= (1 - 0.55 * crush01); conF = 1 + (conF - 1) * (1 - 0.35 * crush01);
      let outConF = conF * (lookMul.conMul ?? 1); let outSatF = satF * (lookMul.satMul ?? 1); let outBrightAdd = brightAdd * (lookMul.brMul ?? 1);
      outConF = clamp(outConF, 0.90, 1.12); outSatF = clamp(outSatF, cfg.SAT_MIN, Math.min(cfg.SAT_MAX, 1.16 - 0.10 * risk01)); outBrightAdd = clamp(outBrightAdd, -14, 14);
      return { conF: outConF, satF: outSatF, mid: clamp(mid, -0.95, 0.95), toe: clamp(toe, 0, 14), shoulder: clamp(shoulder, 0, 16), brightAdd: outBrightAdd };
    };

    const disableAEHard = () => { try { worker?.terminate(); } catch (_) {} worker = null; workerBusy = false; isRunning = false; loopToken++; targetToken++; if (workerUrl) { try { URL.revokeObjectURL(String(workerUrl)); } catch (_) {} workerUrl = null; } __unavailable = true; };
    const ensureWorker = () => {
      if (__unavailable) return null;
      if (worker) return worker;
      if (location.protocol === 'about:' || location.href === 'about:blank') { disableAEHard(); return null; }
      try {
        if (!workerUrl) {
          let rawUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
          if (window.trustedTypes && window.trustedTypes.createPolicy) {
            try {
              if (!workerPolicy) workerPolicy = window.trustedTypes.createPolicy('vsc-tw-policy', { createScriptURL: s => s });
              workerUrl = workerPolicy.createScriptURL(rawUrl);
            } catch (_) { workerUrl = rawUrl; }
          } else {
            workerUrl = rawUrl;
          }
        }
        worker = new Worker(workerUrl);
        worker.onmessage = (e) => { workerBusy = false; processResult(e.data); };
        worker.onerror = () => { workerBusy = false; disableAEHard(); };
        return worker;
      } catch (e) {
        try { console.warn('[VSC] AE worker blocked by CSP/TrustedTypes. AE unavailable.'); } catch (_) {}
        disableAEHard();
        return null;
      }
    };

    function chooseAutoProfileScored(s, risk01, prev, subLikely = false) {
      const p50 = clamp(s.p50 ?? 0.5, 0, 1), cf = clamp(s.cf ?? 0.5, 0, 1), clipLow = clamp(s.clipLowFrac ?? 0, 0, 1), rd = clamp(s.rd ?? 0, 0, 1);
      const dyn = clamp((clamp(s.p90 ?? 0.9, 0, 1) - clamp(s.p10 ?? 0.1, 0, 1)), 0, 1), flat01 = clamp((0.46 - dyn) / 0.26, 0, 1), lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1);
      const score = { standard: 0.35 + (1 - Math.abs(p50 - 0.28) / 0.28) * 0.25 + (1 - risk01) * 0.10, bright: 0.10 + lowKey01 * 0.45 + cf * 0.15 + (1 - Math.min(1, clipLow / 0.04)) * 0.15 - risk01 * 0.15, cinemaHdr: 0.10 + flat01 * 0.25 + risk01 * 0.45 + rd * 0.10 };
      if (subLikely) { score.bright -= 0.10; score.standard += 0.04; score.cinemaHdr += 0.03; }
      if (prev && score[prev] != null) score[prev] += 0.08;
      const entries = Object.entries(score).sort((a, b) => b[1] - a[1]);
      const [bestName, bestScore] = entries[0]; const secondScore = entries[1]?.[1] ?? -Infinity;
      return { next: bestName, margin: bestScore - secondScore };
    }

    function chooseAutoProfileStable(s, risk01, prev, subLikely = false) {
      const picked = chooseAutoProfileScored(s, risk01, prev, subLikely);
      __autoProfileVotes.push(picked.next);
      if (__autoProfileVotes.length > 5) __autoProfileVotes.shift();
      const cnt = { standard: 0, bright: 0, cinemaHdr: 0 };
      for (const p of __autoProfileVotes) if (cnt[p] != null) cnt[p]++;
      let voted = prev || 'standard';
      let bestN = -1;
      for (const [k, n] of Object.entries(cnt)) { if (n > bestN) { bestN = n; voted = k; } }
      return { next: voted, margin: picked.margin };
    }

    function getAutoHoldMs(prev, next, changed) { if (!changed) return 1100; if ((prev === 'bright' && next === 'cinemaHdr') || (prev === 'cinemaHdr' && next === 'bright')) return 4800; return 3000; }

    function shadowRiskFrom(s, clamp) {
      const p05 = clamp(s.p05 ?? 0.05, 0, 1);
      const clipLow = clamp(s.clipLowFrac ?? 0, 0, 1);
      const lowClip = clamp((clipLow - 0.010) / 0.030, 0, 1);
      const deepBlack = clamp((0.040 - p05) / 0.025, 0, 1);
      return clamp(lowClip * 0.7 + deepBlack * 0.8, 0, 1);
    }

    let __lastLookSent = null;
    function aeLookAlmostSame(a, b) {
      if (!a || !b) return false;
      return (
        Math.abs((a.gain ?? 1) - (b.gain ?? 1)) < 0.015 &&
        Math.abs((a.conF ?? 1) - (b.conF ?? 1)) < 0.006 &&
        Math.abs((a.satF ?? 1) - (b.satF ?? 1)) < 0.006 &&
        Math.abs((a.mid ?? 0) - (b.mid ?? 0)) < 0.02 &&
        Math.abs((a.toe ?? 0) - (b.toe ?? 0)) < 0.10 &&
        Math.abs((a.shoulder ?? 0) - (b.shoulder ?? 0)) < 0.10 &&
        Math.abs((a.brightAdd ?? 0) - (b.brightAdd ?? 0)) < 0.12 &&
        Math.abs((a.tempAdd ?? 0) - (b.tempAdd ?? 0)) < 0.08
      );
    }

    const processResult = (data) => {
      if (!data || data.token !== targetToken) return;
      let pack = getPack(), cfg = pack.cfg;
      const now = performance.now(); sampleCount++;
      __motion01 = data.motion01 !== undefined ? data.motion01 : __motion01;

      const barRowRatio = (data.botRowCount > 0) ? (data.botBrightRows / data.botRowCount) : 0;

      const uiBarScore = clamp(
        (barRowRatio > 0.55 ? 0.55 : 0) +
        clamp(((data.botAvg ?? 0) - 0.22) / 0.16, 0, 1) * 0.20 +
        clamp((0.060 - (data.botStd ?? 0)) / 0.035, 0, 1) * 0.20 +
        clamp((0.18 - (data.botEdgeFrac ?? 0)) / 0.12, 0, 1) * 0.15 +
        clamp(((data.botWhiteFrac ?? 0) - 0.35) / 0.25, 0, 1) * 0.10,
        0, 1
      );

      const subTextScore = clamp(
        clamp(((data.botTextLike ?? 0) - 0.04) / 0.20, 0, 1) * 0.45 +
        clamp(((data.botEdgeFrac ?? 0) - 0.10) / 0.30, 0, 1) * 0.25 +
        clamp(((data.botP95 ?? 0) - 0.90) / 0.08, 0, 1) * 0.15 +
        clamp((0.28 - (data.p50 ?? 0.5)) / 0.12, 0, 1) * 0.15,
        0, 1
      );

      const subBandPrior = (barRowRatio > 0.10 && barRowRatio < 0.58) ? 0.12 : 0.0;
      let subConf = clamp(subTextScore + subBandPrior - uiBarScore * 0.85, 0, 1);
      if ((data.stdDev ?? 0) < 0.040 && (data.botStd ?? 0) < 0.030) subConf *= 0.55;

      __subConfEma = (__subConfEma <= 0) ? subConf : (subConf * 0.28 + __subConfEma * 0.72);

      const subOnTh = 0.58;
      const subKeepTh = 0.34;
      if (__subConfEma > subOnTh) {
        __subLikelyHoldUntil = now + 850;
      } else if (__subConfEma > subKeepTh && now < __subLikelyHoldUntil) {
        __subLikelyHoldUntil = now + 220;
      }

      const subLikely = (__subConfEma > subOnTh) || (now < __subLikelyHoldUntil);

      let subW = 0;
      if (subLikely) {
        subW = smoothstep01((__subConfEma - 0.30) / 0.50);
        subW *= (0.82 + 0.18 * clamp(((data.botTextLike ?? 0) - 0.03) / 0.18, 0, 1));
        subW = clamp(subW, 0, 0.92);
      }

      const rawSkinScore = (data.skinScore != null) ? data.skinScore : (data.redDominance ?? 0);
      __skinEma = (__skinEma <= 0) ? rawSkinScore : mixv(__skinEma, rawSkinScore, 0.18);
      const skinScore = __skinEma;

      const refP10 = mixv(data.p10T ?? data.p10, data.p10M ?? data.p10, 0.60);
      const refP35 = mixv(data.p35T ?? data.p35, data.p35M ?? data.p35, 0.60);
      const refP50 = mixv(data.p50T ?? data.p50, data.p50M ?? data.p50, 0.60);
      const refP90 = mixv(data.p90T ?? data.p90, data.p90M ?? data.p90, 0.60);
      const refP95 = mixv(data.p95T ?? data.p95, data.p95M ?? data.p95, 0.60);
      const refP98 = mixv(data.p98T ?? data.p98, data.p98M ?? data.p98, 0.60);
      const refCf = mixv(data.cfT ?? data.cf, data.cfM ?? data.cf, 0.60);

      const clipFracEff = (subW > 0.01)
        ? mixv(data.clipFrac, Math.min(data.clipFrac, Math.min((data.clipFracTop ?? data.clipFrac) * 1.12, data.clipFrac)), subW)
        : data.clipFrac;

      const stats = {
        p05: data.p05,
        p10: mixv(data.p10, refP10, subW),
        p35: mixv(data.p35, refP35, subW),
        p50: mixv(data.p50, refP50, subW),
        p90: mixv(data.p90, refP90, subW),
        p95: mixv(data.p95, refP95, subW),
        p98: mixv(data.p98, refP98, subW),
        clipFrac: clipFracEff,
        clipLowFrac: data.clipLowFrac,
        cf: mixv(data.cf, refCf, subW),
        rd: skinScore
      };

      const dt = Math.min(now - lastEmaT, 500); lastEmaT = now; const a = 1 - Math.exp(-dt / clamp((activeVideo?.paused ? 380 : cfg.DT_CAP_MS) + (1 - __motion01) * 160, 180, 650));
      for (let i=0; i < AE_STAT_KEYS.length; i++) { const k = AE_STAT_KEYS[i]; const v = stats[k]; if (Number.isFinite(v)) lastStats[k] = (lastStats[k] < 0) ? v : (v * a + lastStats[k] * (1 - a)); }
      const risk01 = riskFrom(Math.max(0, lastStats.p95), Math.max(0, lastStats.p98), Math.max(0, lastStats.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);

      const currSceneStats = { p50: lastStats.p50, p95: lastStats.p95, cf: lastStats.cf };
      const sc01 = sceneChangeFromStats(data.avgLuma, lastLuma, __motion01, clamp(lastStats.cf ?? 0.5, 0, 1), __prevSceneStats, currSceneStats, clamp);
      __prevSceneStats = { ...currSceneStats };
      lastLuma = data.avgLuma;

      __sceneChange01 = sc01;
      if (sc01 > 0.72) {
        __aeBurstUntil = now + (activeVideo?.paused ? 0 : 420);
      }
      __workerStallStreak = 0;

      if (sm.get(P.V_AE_PROFILE) === 'auto' && now >= __autoHoldUntil) {
        const prev = __autoProfile; const picked = chooseAutoProfileStable(lastStats, risk01, prev, subLikely);
        const sceneStable = sc01 < 0.60; const enoughSamples = sampleCount >= 4;
        const marginNeed = (prev === 'bright' && picked.next === 'cinemaHdr') || (prev === 'cinemaHdr' && picked.next === 'bright') ? 0.12 : 0.08;
        const shouldSwitch = sceneStable && enoughSamples && (picked.next !== prev) && (picked.margin > marginNeed);
        if (shouldSwitch) __autoProfile = picked.next;
        __autoHoldUntil = now + getAutoHoldMs(prev, __autoProfile, shouldSwitch);
        pack = getPack(); cfg = pack.cfg;
      }

      let targetEV = computeTargetEV(lastStats, cfg) * Math.min(1, sampleCount / 3);

      const shadowRisk01 = shadowRiskFrom(lastStats, clamp);
      const lowKeyIntent01 = clamp((0.24 - (lastStats.p50 ?? 0.5)) / 0.12, 0, 1) * (0.6 + 0.4 * clamp(lastStats.cf ?? 0.5, 0, 1));
      if (targetEV > 0) {
        let damp = 1 - (0.18 * shadowRisk01 + 0.20 * lowKeyIntent01);
        if (subLikely) damp *= 1 - (0.20 + 0.35 * subW);
        targetEV *= clamp(damp, 0.45, 1.0);
      }
      if (risk01 > 0.75) targetEV = Math.min(targetEV, 0);

      const curEV = Math.log2(curGain), dtA = Math.min(now - lastApplyT, cfg.DT_CAP_MS); lastApplyT = now;
      const lock01 = clamp(__userLock01, 0, 1), nextEV = curEV + (targetEV - curEV) * ((1 - Math.exp(-dtA / (((sc01 > 0.55) ? cfg.TAU_AGGRESSIVE : ((targetEV > curEV && risk01 <= 0.70) ? cfg.TAU_UP : cfg.TAU_DOWN)) * (1 + risk01 * 1.10) * (1 + lock01 * 2.2)))) * (1 - ((lock01 > 0.70) ? clamp((lock01 - 0.70) / 0.30, 0, 1) : 0)));
      curGain = Math.pow(2, nextEV);
      const rawLook = computeLook(nextEV, lastStats, risk01, cfg, pack.look);
      const look = smoothLook(rawLook, dtA, __motion01, risk01);

      __lastMeta.hiRisk = risk01;
      __lastMeta.cf = clamp(lastStats.cf ?? 0.5, 0, 1);
      __lastMeta.luma = data.avgLuma * 100;
      __lastMeta.clipFrac = lastStats.clipFrac;
      __lastMeta.skinScore = skinScore;
      __lastMeta.profileResolved = getResolvedProfile();
      __lastMeta.subLikely = !!subLikely;
      __lastMeta.gainApplied = curGain;
      __lastMeta.p50 = lastStats.p50;
      __lastMeta.p95 = lastStats.p95;
      __lastMeta.p98 = lastStats.p98;
      __lastMeta.motion01 = __motion01;

      const aeLook = { gain: curGain, conF: look.conF, satF: look.satF, mid: look.mid, toe: look.toe, shoulder: look.shoulder, brightAdd: look.brightAdd, tempAdd: clamp(cfg.TEMP_BIAS ?? 0, -6, 6) };

      if (!aeLookAlmostSame(aeLook, __lastLookSent)) {
        __lastLookSent = { ...aeLook };
        onAE && onAE({ ...aeLook, ...__lastMeta });
      }
    };

    const sample = (v, rvfcMeta = null) => {
      if (!isRunning || !v || document.hidden || v[VSCX.tainted] || v.readyState < 2 || v[VSCX.visible] === false || (v.videoWidth|0) === 0 || (v.videoHeight|0) === 0) return;

      const mediaT = Number.isFinite(rvfcMeta?.mediaTime) ? rvfcMeta.mediaTime : (Number.isFinite(v.currentTime) ? v.currentTime : -1);
      if (mediaT >= 0) {
        if (Math.abs(mediaT - __lastSampleMediaTime) < 1e-4 && !v.paused) {
          __sameFrameSkipStreak++;
          if (__sameFrameSkipStreak < 2) return;
        } else {
          __sameFrameSkipStreak = 0;
          __lastSampleMediaTime = mediaT;
        }
      }

      const now = performance.now();
      const intervalMs = computeAdaptiveSampleIntervalMs(v, now);

      if (now - lastSampleT < intervalMs) return;

      if (workerBusy) {
        __workerStallStreak++;
        lastSampleT = now - Math.min(intervalMs * 0.75, 40);
        return;
      }

      try {
        const wk = ensureWorker();
        if (!wk) return;
        const w = CONFIG.IS_LOW_END ? 24 : 32; const h = w;

        lastSampleT = now;
        __lastSampleCheckGain = curGain;

        if (window.createImageBitmap && window.OffscreenCanvas) {
          workerBusy = true;
          createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'pixelated' })
            .then(bitmap => {
              if (!isRunning) { bitmap.close(); workerBusy = false; return; }
              wk.postMessage({ bitmap, width: w, height: h, step: w<=24?1:2, token: targetToken }, [bitmap]);
            })
            .catch(err => {
              workerBusy = false;
              v[VSCX.tainted] = true;
            });
        } else {
          if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
            if (!ctx2d) { v[VSCX.tainted] = true; return; }
          }
          ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height); const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
          workerBusy = true;
          wk.postMessage({ buf: d.data.buffer, width: canvas.width, height: canvas.height, step: canvas.width <= 24 ? 1 : 2, token: targetToken }, [d.data.buffer]);
        }
      } catch (_) { workerBusy = false; v[VSCX.tainted] = true; }
    };

    const loop = (token, rvfcMeta = null) => {
      if (!isRunning || token !== loopToken) return;
      const v = activeVideo, now = performance.now();
      if (sm.get(P.APP_ACT) && sm.get(P.V_AE) && v && v.isConnected && !document.hidden && now - lastLoopT > (v.paused ? 280 : (CONFIG.IS_LOW_END ? 110 : 85))) { lastLoopT = now; sample(v, rvfcMeta); }
      scheduleNextLoop(token, v);
    };

    const invalidatePendingSample = () => { targetToken++; workerBusy = false; };
    const resetAutoClassifierState = () => { __autoProfileVotes.length = 0; __subLikelyHoldUntil = 0; __subCandidateStreak = 0; __autoHoldUntil = 0; __prevSceneStats = null; };
    const hardResetStats = () => { invalidatePendingSample(); __lastSampleMediaTime = -1; __sameFrameSkipStreak = 0; lastSampleT = 0; lastLuma = -1; sampleCount = 0; lastStats = { p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 }; lastEmaT = performance.now(); lastApplyT = performance.now(); __lookEmaInit = false; __lookEma = { conF: 1, satF: 1, mid: 0, toe: 0, shoulder: 0, brightAdd: 0 }; __lastLookSent = null; __subConfEma = 0; __sceneChange01 = 1; __aeBurstUntil = 0; __workerStallStreak = 0; __skinEma = 0; __prevSceneStats = null; resetAutoClassifierState(); };
    const softResetStats = () => { invalidatePendingSample(); __lastSampleMediaTime = -1; __sameFrameSkipStreak = 0; lastSampleT = 0; sampleCount = Math.min(sampleCount, 1); lastEmaT = performance.now(); lastApplyT = performance.now(); __subCandidateStreak = 0; __subLikelyHoldUntil = 0; __lastLookSent = null; };
    const stopSoft = () => { isRunning = false; loopToken++; activeVideo = null; };
    const stopHard = () => { isRunning = false; loopToken++; try { worker?.terminate(); } catch (_) {} worker = null; workerBusy = false; if (workerUrl) { try { URL.revokeObjectURL(String(workerUrl)); } catch (_) {} workerUrl = null; } activeVideo = null; curGain = 1.0; lastLuma = -1; targetToken++; __unavailable = true; };

    return {
      isUnavailable: () => __unavailable,
      getResolvedProfile, getMeta: () => ({ ...__lastMeta, profileResolved: getResolvedProfile() }),
      setTarget: (v, opts = {}) => { if (v === activeVideo) return; activeVideo = v; curGain = opts.keepGain ? clamp(curGain, 0.60, 6.0) : 1.0; resetAutoClassifierState(); if (opts.softReset) softResetStats(); else hardResetStats(); },
      start: () => { const wk = ensureWorker(); if (!wk) { isRunning = false; return; } if (!isRunning) { isRunning = true; loopToken++; lastLoopT = 0; lastApplyT = lastEmaT = performance.now(); lastSampleT = 0; loop(loopToken); } },
      stop: stopSoft, stopHard: stopHard, wake: () => { lastSampleT = 0; lastLoopT = 0; }, userTweak: () => { hardResetStats(); lastSampleT = 0; lastLoopT = 0; }, __setOnAE: (fn) => { onAE = fn; }, setUserLock01, hintProfileChanged: () => { resetAutoClassifierState(); hardResetStats(); }
    };
  }

  function createNoopUI() { return Object.freeze({ ensure() {}, update() {}, destroy() {} }); }

  function createUI(sm, registry, scheduler, bus, Utils) {
    const { h } = Utils; let container, monitorEl, gearHost, gearBtn, fadeTimer = 0; const unsubs = [];
    const sub = (k, fn) => { const off = sm.sub(k, fn); unsubs.push(off); return off; };
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
    const allowUiInThisDoc = () => { return registry.videos.size > 0; };
    const TRIGGERS = Object.freeze({ [P.V_GAMMA]: { aeLevel: 2, lockMs: 2600, lockAmp: 1.00 }, [P.V_CONTR]: { aeLevel: 2, lockMs: 2600, lockAmp: 1.00 }, [P.V_BRIGHT]: { aeLevel: 2, lockMs: 2400, lockAmp: 1.00 }, [P.V_PRE_MIX]: { aeLevel: 2, lockMs: 2200, lockAmp: 0.90 }, [P.V_SAT]: { aeLevel: 1, lockMs: 1800, lockAmp: 0.85 }, [P.V_TEMP]: { aeLevel: 1, lockMs: 1800, lockAmp: 0.85 }, [P.V_SHARP]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_SHARP2]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_CLARITY]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_DITHER]: { aeLevel: 1, lockMs: 1400, lockAmp: 0.70 }, [P.V_TONE_STR]: { aeLevel: 1, lockMs: 1600, lockAmp: 0.80 }, [P.V_AE_STR]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.55 }, [P.V_AE_PROFILE]: { aeLevel: 2, lockMs: 900, lockAmp: 0.35, profileChanged: true }, [P.V_TONE_PRE]: { aeLevel: 1, lockMs: 900, lockAmp: 0.45 }, [P.V_PRE_S]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.80 }, [P.V_PRE_B]: { aeLevel: 2, lockMs: 1800, lockAmp: 0.90 } });

    function setAndHint(path, value, forceApply = true) {
      const prev = sm.get(path);
      const changed = !Object.is(prev, value);
      if (changed) sm.set(path, value);

      const t = TRIGGERS[path];
      if (!t) {
        if (forceApply) bus.signal({ aeLevel: 0, forceApply: true });
        return;
      }
      if (changed) {
        bus.signal({ aeLevel: (t.aeLevel | 0), forceApply: !!forceApply, userLockMs: t.lockMs | 0, userLockAmp: (t.lockAmp == null ? 0 : +t.lockAmp), profileChanged: !!t.profileChanged });
        return;
      }
      if (forceApply) bus.signal({ aeLevel: 0, forceApply: true });
    }

    const SLIDERS = [ { l: '감마', k: P.V_GAMMA, min: 0.5, max: 2.5, s: 0.05, f: v => v.toFixed(2) }, { l: '대비', k: P.V_CONTR, min: 0.5, max: 2.0, s: 0.05, f: v => v.toFixed(2) }, { l: '밝기', k: P.V_BRIGHT, min: -50, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '채도', k: P.V_SAT, min: 0, max: 200, s: 5, f: v => v.toFixed(0) }, { l: '샤프 윤곽', k: P.V_SHARP, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '샤프 디테일', k: P.V_SHARP2, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '명료', k: P.V_CLARITY, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '색온도', k: P.V_TEMP, min: -25, max: 25, s: 1, f: v => v.toFixed(0) }, { l: '그레인', k: P.V_DITHER, min: 0, max: 100, s: 5, f: v => v.toFixed(0) }, { l: '오디오', k: P.A_BST, min: 0, max: 12, s: 1, f: v => `+${v}dB` }, { l: '톤 강도', k: P.V_TONE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) }, { l: 'AE 강도', k: P.V_AE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) } ];
    const getUiRoot = () => { const fs = document.fullscreenElement || document.webkitFullscreenElement; if (fs) { if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs; if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement; return fs; } return document.body || document.documentElement; };

    const renderChoiceRow = (label, items, key) => {
      const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      items.forEach(it => {
        const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.t);
        if (key === P.V_TONE_PRE) {
          b.onclick = () => {
            const cur = sm.get(P.V_TONE_PRE);
            if (cur === it.v) {
              setAndHint(P.V_TONE_PRE, 'off', true);
            } else {
              setAndHint(P.V_TONE_PRE, it.v, true);
            }
          };
          const updateToneState = () => { b.classList.toggle('active', sm.get(P.V_TONE_PRE) === it.v); };
          sub(P.V_TONE_PRE, updateToneState); updateToneState();
        } else if (key === P.V_AE_PROFILE) {
          b.onclick = () => {
            const curProf = sm.get(P.V_AE_PROFILE);
            const isAeOn = sm.get(P.V_AE);
            if (isAeOn && curProf === it.v) {
              setAndHint(P.V_AE, false, true);
            } else {
              if (!isAeOn) setAndHint(P.V_AE, true, false);
              setAndHint(P.V_AE_PROFILE, it.v, true);
            }
          };
          const updateAeState = () => { b.classList.toggle('active', !!sm.get(P.V_AE) && sm.get(P.V_AE_PROFILE) === it.v); };
          sub(P.V_AE, updateAeState); sub(P.V_AE_PROFILE, updateAeState); updateAeState();
        } else {
          b.onclick = () => setAndHint(key, it.v, true);
          sub(key, v => b.classList.toggle('active', v === it.v));
          b.classList.toggle('active', sm.get(key) === it.v);
        }
        r.append(b);
      });
      return r;
    };

    const renderPresetRow = (label, items, key) => { const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label)); items.forEach(it => { const val = (it.l || it.txt), b = h('button', { class: 'pbtn', style: 'flex:1' }, val); b.onclick = () => setAndHint(key, val, true); sub(key, v => b.classList.toggle('active', v === val)); b.classList.toggle('active', sm.get(key) === val); r.append(b); }); const offVal = (key === P.V_PRE_B) ? 'brOFF' : 'off', off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF'); off.onclick = () => setAndHint(key, offVal, true); sub(key, v => off.classList.toggle('active', v === 'off' || v === 'brOFF')); off.classList.toggle('active', sm.get(key) === 'off' || sm.get(key) === 'brOFF'); r.append(off); return r; };

    function makeRafCoalescedSetter(commitFn) {
      let raf = 0; let pending;
      return (v) => { pending = v; if (raf) return; raf = requestAnimationFrame(() => { raf = 0; commitFn(pending); }); };
    }

    const renderSlider = (cfg) => {
      const valEl = h('span', { style: 'color:#3498db' }, '0'), inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
      const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
      sub(cfg.k, update); update(sm.get(cfg.k));

      const setCoalesced = makeRafCoalescedSetter((nv) => {
        sm.set(cfg.k, nv);
        const trig = TRIGGERS[cfg.k];
        if (trig) {
          bus.signal({ aeLevel: (trig.aeLevel | 0), forceApply: true, userLockMs: trig.lockMs | 0, userLockAmp: (trig.lockAmp == null ? 0 : +trig.lockAmp) });
        } else {
          bus.signal({ aeLevel: 0, forceApply: true });
        }
      });

      inp.oninput = () => { const nv = Number(inp.value); valEl.textContent = cfg.f(nv); setCoalesced(nv); };
      inp.onchange = () => { setAndHint(cfg.k, Number(inp.value), true); };
      return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp);
    };

    let __lastMonitorText = '';
    let __lastMonitorIsAE = false;

    const build = () => {
      if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
      const style = `.main { position: fixed; top: 50%; right: 70px; transform: translateY(-50%); width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; } .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 2px solid #444; position: sticky; top: -15px; background: #191919; z-index: 2; padding-top: 5px; } .tab { flex: 1; padding: 12px; background: #222; border: 0; color: #999; cursor: pointer; border-radius: 10px 10px 0 0; font-weight: bold; font-size: 13px; } .tab.active { background: #333; color: #3498db; border-bottom: 3px solid #3498db; } .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; } .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; } .btn.active { background: #3498db; color: white; border-color: #2980b9; } .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; } .pbtn.active { background: #e67e22; color: white; border-color: #d35400; } .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12px; row-gap: 8px; margin-top: 8px; } .slider { display: flex; flex-direction: column; gap: 4px; color: #ccc; } .slider label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 500; } input[type=range] { width: 100%; accent-color: #3498db; cursor: pointer; height: 24px; margin: 4px 0; } .monitor { font-size: 12px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 8px; margin-top: 12px; } hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }`;

      const bodyMain = h('div', { id: 'p-main' }, [
        h('div', { class: 'prow' }, [
           h('button', { id: 'ae-btn', class: 'btn', onclick: () => {
             const isAeOn = sm.get(P.V_AE);
             if (isAeOn) { setAndHint(P.V_AE, false, true); }
             else { setAndHint(P.V_AE, true, true); setAndHint(P.V_AE_PROFILE, 'auto', true); }
           } }, '🤖 자동'),
           h('button', { id: 'boost-btn', class: 'btn', onclick: () => setAndHint(P.A_EN, !sm.get(P.A_EN), true) }, '🔊 부스트'),
           h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP')
        ]),
        h('div', { class: 'prow' }, [
           h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
           h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); bus.signal({ aeLevel:2, forceApply:true, userLockMs:800, userLockAmp:0.35 }); } }, '↺ 리셋'),
           h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT), true) }, '⚡ Power')
        ]),
        renderChoiceRow('AE', [ { t: PRESETS.aeProfiles.auto.label, v: 'auto' }, { t: PRESETS.aeProfiles.standard.label, v: 'standard' }, { t: PRESETS.aeProfiles.bright.label, v: 'bright' }, { t: PRESETS.aeProfiles.cinemaHdr.label, v: 'cinemaHdr' } ], P.V_AE_PROFILE),
        renderChoiceRow('톤', Object.entries(PRESETS.tone).map(([id, o]) => ({ t:o.label, v:id })), P.V_TONE_PRE),
        renderPresetRow('샤프', Object.keys(PRESETS.detail).filter(k=>k!=='off').map(l => ({ l })), P.V_PRE_S), renderPresetRow('밝기', Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(txt => ({ txt })), P.V_PRE_B), h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s, false); setAndHint(P.PB_EN, true, true); }; sub(P.PB_RATE, v => { const isEn = sm.get(P.PB_EN); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); sub(P.PB_EN, isEn => { const v = sm.get(P.PB_RATE); b.classList.toggle('active', isEn && Math.abs(v - s) < 0.01); }); b.classList.toggle('active', sm.get(P.PB_EN) && Math.abs((sm.get(P.PB_RATE) || 1) - s) < 0.01); return b; }))
      ]);
      const bodyDetail = h('div', { id: 'p-detail', style: 'display:none' }, [ h('div', { class: 'grid' }, SLIDERS.map(renderSlider)) ]);
      shadow.append(h('style', {}, style), h('div', { class: 'main' }, [ h('div', { class: 'tabs' }, [ h('button', { id: 't-main', class: 'tab active', onclick: () => sm.set(P.APP_TAB, 'main') }, '메인'), h('button', { id: 't-detail', class: 'tab', onclick: () => sm.set(P.APP_TAB, 'detail') }, '상세조정') ]), bodyMain, bodyDetail, monitorEl = h('div', { class: 'monitor' }, `Ready (${CONFIG.VERSION})`) ]));
      sub(P.APP_TAB, v => { shadow.querySelector('#t-main').classList.toggle('active', v === 'main'); shadow.querySelector('#t-detail').classList.toggle('active', v === 'detail'); shadow.querySelector('#p-main').style.display = v === 'main' ? 'block' : 'none'; shadow.querySelector('#p-detail').style.display = v === 'detail' ? 'block' : 'none'; });
      sub(P.V_AE, v => shadow.querySelector('#ae-btn').classList.toggle('active', !!v)); sub(P.A_EN, v => shadow.querySelector('#boost-btn').classList.toggle('active', !!v)); sub(P.APP_ACT, v => shadow.querySelector('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
      container = host; getUiRoot().appendChild(container);
    };
    const ensureGear = () => {
      if (!allowUiInThisDoc()) return; if (gearHost) return;
      gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%; background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff; display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer; pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none; transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;} @media (hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}} .gear:active{transform:translateY(-50%) scale(0.98);} .gear.open{outline:2px solid rgba(52,152,219,0.85);opacity:1 !important;} .gear.inactive{opacity:0.45;} .hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,0.88); border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.82);font:600 11px/1.2 sans-serif;white-space:nowrap; z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none;} .gear:hover + .hint{opacity:1;transform:translateY(0);} ${CONFIG.IS_MOBILE ? '.hint{display:none !important;}' : ''}`;
      gearBtn = h('button', { class: 'gear', onclick: () => setAndHint(P.APP_UI, !sm.get(P.APP_UI), true) }, '⚙'); shadow.append(h('style', {}, style), gearBtn, h('div', { class: 'hint' }, '설정 (Alt+Shift+V)'));
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open')) gearBtn.style.opacity = '0.15'; }, 2500); };
      gearHost.addEventListener('mousemove', wake, { passive: true }); gearHost.addEventListener('touchstart', wake, { passive: true }); setTimeout(wake, 2000);
      const syncGear = () => { if (!gearBtn) return; const showHere = allowUiInThisDoc(); gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); gearBtn.style.display = showHere ? 'block' : 'none'; if (!showHere) detachNodesHard(); else wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };
    const mount = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {} try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {} };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; } else { if (container) container.style.display = 'none'; } mount(); };
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => { try { ensure(); scheduler.request(true); } catch (_) {} }, { once: true }); }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => { window.addEventListener(ev, () => { try { ensure(); } catch (_) {} }, { passive: true }); });
    window.addEventListener('keydown', (e) => { if (!(e && e.altKey && e.shiftKey && e.code === 'KeyV')) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; if (!allowUiInThisDoc()) return; setAndHint(P.APP_UI, !sm.get(P.APP_UI), true); ensure(); scheduler.request(true); });

    if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;

    return {
      ensure,
      update: (text, isAE) => {
        if (!monitorEl || !sm.get(P.APP_UI)) return;
        if (text === __lastMonitorText && isAE === __lastMonitorIsAE) return;
        __lastMonitorText = text; __lastMonitorIsAE = isAE;
        monitorEl.textContent = text;
        monitorEl.style.color = isAE ? "#2ecc71" : "#aaa";
      },
      destroy: () => { for (const off of unsubs) { try { off(); } catch(_){} } unsubs.length = 0; detachNodesHard(); }
    };
  }

  function createUIFactory(enableUI) { return enableUI ? ((sm, registry, scheduler, bus, Utils) => createUI(sm, registry, scheduler, bus, Utils)) : createNoopUI; }

  function getRateState(v) { let st = v[VSCX.rateState]; if (!st) { st = v[VSCX.rateState] = { orig: null, lastSetAt: 0, suppressSyncUntil: 0 }; } return st; }
  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  const restoreRateOne = (el) => { try { const st = el[VSCX.rateState]; if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; markInternalRateChange(el, 220); el.playbackRate = nextRate; st.orig = null; } catch (_) {} };
  const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
  const onEvictVideo = (v) => {
    if (__vscClearVideoFilter) try { __vscClearVideoFilter(v); } catch (_) {}
    restoreRateOne(v);
  };
  const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); for (const v of TOUCHED.rateVideos) onEvictRateVideo(v); TOUCHED.rateVideos.clear(); };

  function pruneTouchedDisconnected() {
    for (const v of TOUCHED.videos) { if (!v || !v.isConnected) TOUCHED.videos.delete(v); }
    for (const v of TOUCHED.rateVideos) { if (!v || !v.isConnected) TOUCHED.rateVideos.delete(v); }
  }

  const bindVideoOnce = (v) => {
    if (v[VSCX.bound]) return;
    v[VSCX.bound] = true;

    const softResetTransientFlags = () => {
      v[VSCX.tainted] = false;
      v[VSCX.audioFail] = false;
      v[VSCX.rect] = null;
      v.__vscRectT = 0;
      v.__vscRectEpoch = -1;
      const st = v[VSCX.rateState];
      if (st) { st.orig = null; st.lastSetAt = 0; st.suppressSyncUntil = 0; }
      try { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 2, forceApply: true }); } catch (_) {}
    };

    v.addEventListener('loadstart', softResetTransientFlags, { passive: true });
    v.addEventListener('loadedmetadata', softResetTransientFlags, { passive: true });
    v.addEventListener('emptied', softResetTransientFlags, { passive: true });

    v.addEventListener('seeking', () => { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 1 }); }, { passive: true });
    v.addEventListener('play', () => { window.__VSC_INTERNAL__?.Bus?.signal?.({ aeLevel: 1 }); }, { passive: true });
    v.addEventListener('ratechange', () => {
      const st = getRateState(v);
      const now = performance.now();
      if ((now - (st.lastSetAt || 0)) < 180) return;
      if (now < (st.suppressSyncUntil || 0)) return;

      const refs = window.__VSC_INTERNAL__;
      const app = refs?.App;
      const store = refs?.Store;
      if (!store) return;

      const desired = v[VSCX.desiredRate];
      if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.01) return;

      const activeVideo = app?.getActiveVideo?.() || null;
      const applyAll = !!store.get?.(P.APP_APPLY_ALL);

      if (!applyAll) {
        if (!activeVideo || v !== activeVideo) return;
      }
      const cur = v.playbackRate;
      if (Number.isFinite(cur) && cur > 0) {
        store.set(P.PB_RATE, cur);
        if (store.get?.(P.PB_EN) !== false) store.set(P.PB_EN, true);
      }
    }, { passive: true });
  };

  const __urlByDocVideo = new Map();
  const __reconcileCandidates = new Set();
  let __lastReconcileSig = '';

  function makeReconcileSig(applySet, vVals, desiredRate, pbActive, videoFxOn, activeTarget) {
    return [
      videoFxOn ? 1 : 0, pbActive ? 1 : 0, desiredRate ?? 1, applySet.size, hashApplySet(applySet), getElemId(activeTarget),
      vVals.gain?.toFixed(2), vVals.gamma?.toFixed(2), vVals.contrast?.toFixed(2),
      vVals.bright?.toFixed(1), vVals.satF?.toFixed(2), vVals.temp?.toFixed(1),
      vVals.sharp?.toFixed(1), vVals.sharp2?.toFixed(1), vVals.clarity?.toFixed(1),
      vVals.toe?.toFixed(1), vVals.shoulder?.toFixed(1)
    ].join('|');
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Filters }) {
    const candidates = __reconcileCandidates;
    candidates.clear();

    for (const v of dirtyVideos) if (v?.tagName === 'VIDEO') candidates.add(v);
    for (const v of TOUCHED.videos) if (v?.tagName === 'VIDEO') candidates.add(v);
    for (const v of TOUCHED.rateVideos) if (v?.tagName === 'VIDEO') candidates.add(v);
    for (const v of applySet) if (v?.tagName === 'VIDEO') candidates.add(v);

    __urlByDocVideo.clear();
    for (const el of candidates) {
      if (!el || el.tagName !== 'VIDEO' || !el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
      const visible = (el[VSCX.visible] !== false);
      const shouldApply = visible && applySet.has(el);

      if (!shouldApply) {
        Filters.clear(el);
        TOUCHED.videos.delete(el);
        el[VSCX.desiredRate] = undefined;
        restoreRateOne(el);
        TOUCHED.rateVideos.delete(el);
        bindVideoOnce(el);
        continue;
      }

      if (videoFxOn) {
        const doc = el.ownerDocument || document; let url = __urlByDocVideo.get(doc);
        if (url === undefined) { url = Filters.prepareCached(doc, vVals); __urlByDocVideo.set(doc, url); }
        Filters.applyUrl(el, url); touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
      } else { Filters.clear(el); TOUCHED.videos.delete(el); }

      if (pbActive) {
        const st = getRateState(el); if (st.orig == null) st.orig = el.playbackRate;
        const lastDesired = el[VSCX.desiredRate];
        if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
          el[VSCX.desiredRate] = desiredRate;
          markInternalRateChange(el, 160);
          try { el.playbackRate = desiredRate; } catch (_) {}
        }
        touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
      } else {
        el[VSCX.desiredRate] = undefined;
        restoreRateOne(el);
        TOUCHED.rateVideos.delete(el);
      }

      bindVideoOnce(el);
    }
    candidates.clear();
  }

  function createAppController({ Store, Registry, Scheduler, Bus, Filters, Audio, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting, enableUI }) {
    if (CONFIG.DEBUG) { window.__VSC_Filters_Ref = Filters; window.__VSC_Bus_Ref = Bus; window.__VSC_Store_Ref = Store; }
    if (enableUI) { UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); }); }

    Store.sub(P.APP_ACT, (on) => { if (on) { try { Registry.refreshObservers?.(); Registry.rescanAll?.(); Scheduler.request(true); } catch (_) {} } });

    let __lockStart = 0, __lockDur = 0, __lockAmp = 0;
    function bumpUserLock(now, ms, amp) { if (!ms || ms <= 0 || !amp || amp <= 0) return; const a = Utils.clamp(+amp, 0, 1), d = Math.max(0, ms | 0); if (__lockDur <= 0 || (now - __lockStart) > __lockDur) { __lockStart = now; __lockDur = d; __lockAmp = a; } else { const left = (__lockStart + __lockDur) - now; __lockStart = now; __lockDur = Math.max(left * 0.35 + d, d); __lockAmp = Math.max(__lockAmp * 0.65, a); } }
    function getUserLock01(now) { if (__lockDur <= 0) return 0; return Utils.clamp(1 - (now - __lockStart) / __lockDur, 0, 1) * __lockAmp; }
    Bus.on('signal', (s) => { const wantAE = FEATURES.ae(), now = performance.now(); if (s.userLockMs) bumpUserLock(now, s.userLockMs, s.userLockAmp); if (s.profileChanged) AE?.hintProfileChanged?.(); if (wantAE) { if ((s.aeLevel | 0) >= 2) AE.userTweak?.(); if ((s.aeLevel | 0) >= 1) AE.wake?.(); } if (s.forceApply) Scheduler.request(true); });

    const __aeMix = { expMix: 1, toneMix: 1, colorMix: 1 };
    const __aeMixEma = { expMix: 1, toneMix: 1, colorMix: 1 };
    let __aeMixLastT = 0;

    function smoothAeMix(now, target, out) {
      const dt = Math.min(200, Math.max(0, now - (__aeMixLastT || now)));
      __aeMixLastT = now;
      const tau = 120;
      const a = 1 - Math.exp(-dt / tau);

      __aeMixEma.expMix   += (target.expMix   - __aeMixEma.expMix)   * a;
      __aeMixEma.toneMix  += (target.toneMix  - __aeMixEma.toneMix)  * a;
      __aeMixEma.colorMix += (target.colorMix - __aeMixEma.colorMix) * a;

      out.expMix = __aeMixEma.expMix;
      out.toneMix = __aeMixEma.toneMix;
      out.colorMix = __aeMixEma.colorMix;
    }

    const __aeMixCache = new Map();
    function q(v, step) { return Math.round((+v || 0) / step); }
    function computeAeMix3Cached(outMix, vf, aeMeta, Utils, userLock01) {
      const key = [
        q(vf.gamma, 0.02), q(vf.contrast, 0.02), q(vf.bright, 1), q(vf.sat, 2), q(vf.temp, 1),
        q(vf.sharp, 1), q(vf.sharp2, 1), q(vf.clarity, 1), q(vf.toneStrength, 0.05),
        vf.tonePreset || 'off', vf.presetB || 'brOFF', vf.presetS || 'off', q(vf.presetMix ?? 1, 0.05),
        vf.aeProfile || 'auto', q(vf.aeStrength ?? 1, 0.05),
        q(aeMeta?.hiRisk ?? 0, 0.02), q(aeMeta?.luma ?? 1), q(aeMeta?.clipFrac ?? 0, 0.0005),
        q(aeMeta?.cf ?? 0.5, 0.02), q(aeMeta?.skinScore ?? 0, 0.02),
        q(userLock01 ?? 0, 0.05)
      ].join('|');
      const hit = __aeMixCache.get(key);
      if (hit) {
        outMix.expMix = hit.expMix; outMix.toneMix = hit.toneMix; outMix.colorMix = hit.colorMix;
        return;
      }
      computeAeMix3Into(outMix, vf, aeMeta, Utils, userLock01);
      __aeMixCache.set(key, { expMix: outMix.expMix, toneMix: outMix.toneMix, colorMix: outMix.colorMix });
      if (__aeMixCache.size > 256) __aeMixCache.delete(__aeMixCache.keys().next().value);
    }

    const RETARGET_CFG = Object.freeze({ HOLD_MS: 900, MIN_DELTA: 0.75, MIN_DELTA_BOTH_PLAYING: 1.10, CLICK_OVERRIDE_MS: 1400 });
    let __retargetHoldUntil = 0;

    const __vfEff = { ...DEFAULTS.video }, __aeOut = { gain: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5, mid: 0, clipFrac: 0, skinScore: 0 }, __vVals = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, mid: 0, sharp: 0, sharp2: 0, clarity: 0, dither: 0, temp: 0, toe: 0, shoulder: 0 };
    let lastSRev = -1, lastRRev = -1, lastAeRev = -1, lastUserSigRev = -1, lastPrune = 0, aeRev = 0, currentAE = { ...__aeOut };
    const onAE = (ae) => { currentAE = ae; aeRev++; Scheduler.request(false); }; if (AE && AE.__setOnAE) AE.__setOnAE(onAE);

    let __activeTarget = null, __lastHadAnyT = 0;

    let applySet = null;

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;
        if (!active) { cleanupTouched(TOUCHED); Audio.update(); AE.stop?.(); if (enableUI) UI.update('OFF', false); return; }
        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev; lastUserSigRev = userSigRev;

        const now = performance.now();
        if (now - lastPrune > 2000) {
          Registry.prune();
          pruneTouchedDisconnected();
          lastPrune = now;
        }
        const userLock01 = getUserLock01(now); AE.setUserLock01?.(userLock01);
        const vf0 = Store.getCatRef('video'), wantAE = FEATURES.ae(), wantAudio = FEATURES.audio(), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
        const pick = Targeting.pickDetailed(visible.videos, window.__lastUserPt, wantAudio);

        let nextTarget = pick.target;
        if (!nextTarget) {
          if (__activeTarget && (now - __lastHadAnyT) < 700) nextTarget = __activeTarget;
        } else {
          __lastHadAnyT = now;
        }

        if (!force && __activeTarget && nextTarget && nextTarget !== __activeTarget) {
          const cur = __activeTarget;
          const bothPlaying = (!cur.paused && !cur.ended) && (!nextTarget.paused && !nextTarget.ended);
          const minDelta = bothPlaying ? RETARGET_CFG.MIN_DELTA_BOTH_PLAYING : RETARGET_CFG.MIN_DELTA;
          const recentClickOverride = (nextTarget === window.__lastClickedVideo) && ((now - (window.__lastClickT || 0)) < RETARGET_CFG.CLICK_OVERRIDE_MS);
          const withinHold = now < __retargetHoldUntil;

          if (!recentClickOverride && (withinHold || !(pick.delta > minDelta))) {
            nextTarget = __activeTarget;
          }
        }

        if (nextTarget !== __activeTarget) {
          __retargetHoldUntil = now + RETARGET_CFG.HOLD_MS;
          const hadPrev = !!__activeTarget;
          __activeTarget = nextTarget;
          if (wantAE && __activeTarget) {
            AE.setTarget(__activeTarget, { keepGain: hadPrev, softReset: hadPrev });
          }
        }

        const aeUnavailable = AE.isUnavailable ? AE.isUnavailable() : false;
        const aeShouldRun = !!(__activeTarget && wantAE && !aeUnavailable);

        if (aeShouldRun) { AE.start(); } else { AE.stop?.(); }
        if (wantAudio || Audio.hasCtx?.() || Audio.isHooked?.()) Audio.setTarget(__activeTarget || null); else Audio.setTarget(null);
        Audio.update();

        const aeMeta = (wantAE && !aeUnavailable && AE.getMeta) ? AE.getMeta() : { profileResolved: (Store.get(P.V_AE_PROFILE) || 'standard'), hiRisk: 0, subLikely: false, clipFrac: 0, cf: 0.5, skinScore: 0 };

        let vfEff = vf0; if (vf0.tonePreset && vf0.tonePreset !== 'off' && vf0.tonePreset !== 'neutral') { const tEff = computeToneStrengthEff(vf0, aeMeta, Utils); for (const k in __vfEff) __vfEff[k] = vf0[k]; __vfEff.toneStrength = tEff; vfEff = __vfEff; }

        computeAeMix3Cached(__aeMix, vfEff, aeMeta, Utils, userLock01);
        smoothAeMix(now, __aeMix, __aeMix);

        const aeStr = Utils.clamp(vfEff.aeStrength ?? 1.0, 0, 1);
        let expMix = __aeMix.expMix * aeStr;
        let toneMix = __aeMix.toneMix * aeStr;
        let colorMix = __aeMix.colorMix * aeStr;

        let aeOut = null;
        if (aeShouldRun && currentAE) {
          const raw = currentAE;
          __aeOut.gain = Math.pow(2, Math.log2(Math.max(1e-6, raw.gain ?? 1)) * expMix);
          __aeOut.brightAdd = (raw.brightAdd ?? 0) * expMix;
          __aeOut.tempAdd = (raw.tempAdd ?? 0) * colorMix;
          __aeOut.conF = 1 + ((raw.conF ?? 1) - 1) * toneMix;
          __aeOut.satF = 1 + ((raw.satF ?? 1) - 1) * colorMix;
          __aeOut.mid = (raw.mid ?? 0) * toneMix;
          __aeOut.toe = (raw.toe ?? 0) * toneMix;
          __aeOut.shoulder = (raw.shoulder ?? 0) * toneMix;
          __aeOut.hiRisk = aeMeta.hiRisk ?? __aeOut.hiRisk;
          __aeOut.cf = aeMeta.cf ?? __aeOut.cf;
          __aeOut.luma = aeMeta.luma ?? __aeOut.luma;
          __aeOut.clipFrac = aeMeta.clipFrac ?? __aeOut.clipFrac;
          __aeOut.skinScore = aeMeta.skinScore ?? __aeOut.skinScore;
          aeOut = __aeOut;
        }
        composeVideoParamsInto(__vVals, vfEff, aeOut, Utils, aeMeta?.profileResolved || null);
        const videoFxOn = !isNeutralVideoParams(__vVals);

        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);
        const extraApplyTopK = Store.get(P.APP_EXTRA_TOPK) | 0;

        applySet = Targeting.buildApplySetReuse(visible.videos, __activeTarget, extraApplyTopK, applyToAllVisibleVideos, window.__lastUserPt, wantAudio, pick.topCandidates);

        const desiredRate = Store.get(P.PB_RATE);
        const pbActive = active && !!Store.get(P.PB_EN);

        const doUIUpdate = () => {
          if (enableUI && Store.getCatRef('app').uiVisible) {
            if (wantAE) {
              UI.update(`AE(${aeMeta.profileResolved}) G:${__vVals.gain.toFixed(2)}x L:${Math.round(currentAE.luma || 0)}% P50:${Math.round((aeMeta.p50||0)*100)} P95:${Math.round((aeMeta.p95||0)*100)}${aeMeta.subLikely ? ' [SUB]' : ''}`, true);
            } else {
              UI.update(`Ready (${CONFIG.VERSION})`, false);
            }
          }
        };

        const reconcileSig = makeReconcileSig(applySet, __vVals, desiredRate, pbActive, videoFxOn, __activeTarget);
        if (!force && vidsDirty.size === 0 && reconcileSig === __lastReconcileSig) {
           doUIUpdate();
           return;
        }
        __lastReconcileSig = reconcileSig;
        doUIUpdate();

        reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: __vVals, videoFxOn, desiredRate, pbActive, Filters });
        if (enableUI && (force || vidsDirty.size)) UI.ensure();
      } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch(_) {} }
    });
    let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    const refreshTick = () => { (FEATURES.ae() || FEATURES.audio()) ? startTick() : stopTick(); };
    Store.sub(P.V_AE, refreshTick); Store.sub(P.A_EN, refreshTick); Store.sub(P.APP_ACT, refreshTick); refreshTick();
    Scheduler.request(true);
    return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { AE.stopHard?.(); } catch (_) {} try { Audio.setTarget(null); } catch (_) {} } });
  }

  const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
  window.__VSC_INTERNAL__.Bus = Bus;
  window.__VSC_INTERNAL__.Store = Store;

  function normalizeAeProfile(sm) { if (sm.get(P.V_AE)) { const prof = sm.get(P.V_AE_PROFILE); if (!prof || prof === '') sm.set(P.V_AE_PROFILE, 'auto'); if (prof && prof !== 'auto' && prof !== 'standard' && prof !== 'bright' && prof !== 'cinemaHdr') { sm.set(P.V_AE_PROFILE, 'standard'); } } }
  Store.sub(P.V_AE, () => normalizeAeProfile(Store)); Store.sub(P.V_AE_PROFILE, () => normalizeAeProfile(Store));
  const FEATURES = { active: () => Store.get(P.APP_ACT), ae: () => { if (!(Store.get(P.APP_ACT) && Store.get(P.V_AE))) return false; return Utils.clamp(Store.get(P.V_AE_STR) ?? 1.0, 0, 1) > 0.02; }, audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN) };
  const Registry = createRegistry(Scheduler, FEATURES), Targeting = createTargeting({ Utils });
  (function ensureRegistryAfterBodyReady() { const run = () => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} }; if (document.body) { run(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); run(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} document.addEventListener('DOMContentLoaded', () => run(), { once: true }); })();

  const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID }), Audio = createAudio(Store), AE = createAE(Store, { IS_MOBILE: CONFIG.IS_MOBILE, Utils }, null);
  __vscClearVideoFilter = (v) => Filters.clear(v);
  const makeUI = createUIFactory(ENABLE_UI), UI = makeUI(Store, Registry, Scheduler, Bus, Utils);

  window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 };
  window.__lastClickedVideo = null; window.__lastClickT = 0;
  function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }

  function signalUserInteractionForRetarget() {
    const now = performance.now();
    if (now - __vscLastUserSignalT < 24) return;
    __vscLastUserSignalT = now;
    __vscUserSignalRev = (__vscUserSignalRev + 1) | 0;
    try { Scheduler.request(false); } catch (_) {}
  }
  let __vscLastUserSignalT = 0;

  function findVideoFromPointerEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    if (path) { for (const n of path) { if (n && n.tagName === 'VIDEO') return n; } }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el?.tagName === 'VIDEO') return el;
    return el?.closest?.('video') || null;
  }

  window.addEventListener('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); window.__lastClickT = now; const v = findVideoFromPointerEvent(e); if (v) window.__lastClickedVideo = v; signalUserInteractionForRetarget(); }, { passive: true });
  window.addEventListener('wheel', (e) => { const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5; const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5; updateLastUserPt(x, y, performance.now()); signalUserInteractionForRetarget(); }, { passive: true });
  window.addEventListener('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); signalUserInteractionForRetarget(); });
  window.addEventListener('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); signalUserInteractionForRetarget(); }, { passive: true });

  const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Bus, Filters, Audio, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting, enableUI: ENABLE_UI });
  window.__VSC_APP__ = __VSC_APP__;
  window.__VSC_INTERNAL__.App = __VSC_APP__;

  window.addEventListener('keydown', async (e) => {
    if (!(e.altKey && e.shiftKey && e.code === 'KeyP')) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const v = __VSC_APP__?.getActiveVideo(); if (!v) return;
    await togglePiPFor(v);
  }, true);

  let __vscLastUserGestureAt = 0;
  let __vscAutoPiPEnabled = EXPERIMENTAL.AUTO_PIP_ON_TAB_HIDE;
  let __vscAutoPiPCooldownUntil = 0;
  ['pointerdown', 'keydown'].forEach(type => {
    window.addEventListener(type, () => { __vscLastUserGestureAt = performance.now(); }, { passive: true, capture: true });
  });

  document.addEventListener('visibilitychange', async () => {
    const now = performance.now();
    const v = __VSC_APP__?.getActiveVideo();

    if (document.visibilityState === 'hidden') {
      if (!__vscAutoPiPEnabled || now < __vscAutoPiPCooldownUntil) return;
      if (!v || v.paused || v.ended) return;
      if (document.pictureInPictureElement === v) return;
      if (v.disablePictureInPicture === true) return;

      const recentGesture = (now - __vscLastUserGestureAt) < 3000;
      if (!recentGesture) return;

      try {
        const ok = await enterPiP(v);
        if(ok) __vscAutoEnteredPiP = true;
        else __vscAutoPiPCooldownUntil = performance.now() + 15000;
      } catch (_) {
        __vscAutoPiPCooldownUntil = performance.now() + 15000;
      }
    } else if (document.visibilityState === 'visible') {
      if (!__vscAutoEnteredPiP) return;
      const pipEl = document.pictureInPictureElement;

      const wk = findWebkitPiPVideo();
      if (pipEl || wk) {
        try {
          await exitPiP(v || pipEl || wk);
        } catch (e) {
          console.warn('[VSC] Auto exit PiP failed:', e);
        } finally {
          __vscAutoEnteredPiP = false;
        }
      } else {
        __vscAutoEnteredPiP = false;
      }
    }
  }, true);

  watchIframes();

})();
