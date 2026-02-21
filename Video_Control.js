// ==UserScript==
// @name        Video_Control (v159.3.0.12_Final_PiP_Toggle)
// @namespace   https://github.com/
// @version     159.3.0.12
// @description Video Control: Zero-Alloc, Brightness 0.30, AE Fix, Smooth Tone, PiP Toggle Button Layout
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

  // --- Boot Guard ---
  if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com')) return;
  const VSC_BOOT_KEY = '__VSC_BOOT_LOCK__';
  if (window[VSC_BOOT_KEY]) return;
  try { Object.defineProperty(window, VSC_BOOT_KEY, { value: true, writable: false }); } catch (e) { window[VSC_BOOT_KEY] = true; }

  const AE_ZERO = Object.freeze({ gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, hiRisk: 0, cf: 0.5, mid: 0, rd: 0, luma: 0, clipFrac: 0 });

  // --- Safe attachShadow Patch ---
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
    VERSION: "v159.3.0.12_Final",
    IS_TOP: window === window.top,
    IS_MOBILE: /Mobi|Android|iPhone/i.test(navigator.userAgent),
    IS_LOW_END: (navigator.deviceMemory || 4) < 4,
    TOUCHED_MAX: ((navigator.deviceMemory || 4) < 4) ? 60 : 140,
    VSC_ID: Math.random().toString(36).slice(2)
  });

  const ENABLE_UI = true;
  const VSCX = Object.freeze({ visible: Symbol('vsc.visible'), rect: Symbol('vsc.rect'), ir: Symbol('vsc.ir'), bound: Symbol('vsc.bound'), rateState: Symbol('vsc.rateState'), tainted: Symbol('vsc.tainted'), audioFail: Symbol('vsc.audioFail'), applied: Symbol('vsc.applied'), aeUnavailable: Symbol('vsc.aeUnavailable') });

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

  const DEFAULTS = { video: { gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, temp: 0, sharp: 0, sharp2: 0, clarity: 0, dither: 0, ae: false, presetS: 'off', presetB: 'brOFF', presetMix: 1.0, aeProfile: 'auto', tonePreset: null, toneStrength: 1.0, aeStrength: 1.0 }, audio: { enabled: false, boost: 6 }, playback: { rate: 1.0 }, app: { active: true, uiVisible: false, tab: 'main', applyAll: false, extraTopK: 2 } };
  const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_TAB: 'app.tab', APP_APPLY_ALL: 'app.applyAll', APP_EXTRA_TOPK: 'app.extraTopK', V_AE: 'video.ae', V_AE_PROFILE: 'video.aeProfile', V_AE_STR: 'video.aeStrength', V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength', V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright', V_SAT: 'video.sat', V_SHARP: 'video.sharp', V_SHARP2: 'video.sharp2', V_CLARITY: 'video.clarity', V_TEMP: 'video.temp', V_DITHER: 'video.dither', V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate' });

  const TOUCHED = { videos: new Set() };
  function touchedAddLimited(set, el, onEvict) { if (!el) return; if (set.has(el)) { set.delete(el); set.add(el); return; } set.add(el); if (set.size <= CONFIG.TOUCHED_MAX) return; const it = set.values(); const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25); for (let i = 0; i < dropN; i++) { const v = it.next().value; if (v == null) break; set.delete(v); try { onEvict && onEvict(v); } catch (_) {} } }
  const insertTopN = (arr, item, N) => { let i = 0; while (i < arr.length && arr[i].s >= item.s) i++; if (i >= N) return; arr.splice(i, 0, item); if (arr.length > N) arr.length = N; };
  function split2(p) { const i = p.indexOf('.'); return (i > 0) ? [p.slice(0, i), p.slice(i + 1)] : [p, '']; }
  const lerp = (a, b, t) => a + (b - a) * t;

  function getRectCached(v, now, maxAgeMs = 420) {
    const t0 = v.__vscRectT || 0; let r = v[VSCX.rect];
    if (!r || (now - t0) > maxAgeMs) { r = v.getBoundingClientRect(); v[VSCX.rect] = r; v.__vscRectT = now; } return r;
  }

  // ====== PIP UTILS ======
  async function enterPiP(video) {
    if (!video || video.readyState < 2) return false;
    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
      if (document.pictureInPictureElement === video) return true;
      try { await video.requestPictureInPicture(); return true; } catch (e) { return false; }
    }
    if (typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture')) {
      try { video.webkitSetPresentationMode('picture-in-picture'); return true; } catch (e) { return false; }
    }
    return false;
  }

  async function exitPiP() {
    if (document.pictureInPictureElement && document.exitPictureInPicture) {
      try { await document.exitPictureInPicture(); return true; } catch (_) {}
    }
    const v = document.querySelector('video');
    if (v && typeof v.webkitPresentationMode === 'string' && v.webkitPresentationMode === 'picture-in-picture' && typeof v.webkitSetPresentationMode === 'function') {
      try { v.webkitSetPresentationMode('inline'); return true; } catch (_) {}
    }
    return false;
  }

  function createTargeting({ Utils }) {
    let __currentTarget = null, __currentSince = 0;
    const __applySetReuse = new Set(), __topBuf = [], __limitedBuf = [], __scoreCache = new WeakMap();
    const __pickRes = { target: null, bestScore: -Infinity, curScore: -Infinity, delta: 0, secondScore: -Infinity, now: 0 };

    function isActuallyVisibleFast(el, now, maxAgeMs = 420) {
      if (!el || !el.isConnected || el[VSCX.visible] === false) return null;
      const r = getRectCached(el, now, maxAgeMs);
      if (r.width < 80 || r.height < 60 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
      return r;
    }

    function scoreVideo(v, audioBoostOn, now, lastUserPt) {
      if (!v || v.readyState < 2) return -Infinity;
      const r = isActuallyVisibleFast(v, now, 800); if (!r) return -Infinity;
      const area = r.width * r.height; const areaScore = Math.log2(1 + area / 20000);
      const playing = (!v.paused && !v.ended) ? 1 : 0; const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
      const dist = Math.hypot((r.left + r.width * 0.5) - lastUserPt.x, (r.top + r.height * 0.5) - lastUserPt.y);
      const distScore = 1 / (1 + dist / 850);
      const userRecent01 = Math.max(0, 1 - (now - lastUserPt.t) / 2500);
      const userBoost = Math.min(1.3, userRecent01 * (1 / (1 + dist / 500)) * 2.0);
      const ir = (v[VSCX.ir] == null) ? 0.01 : v[VSCX.ir]; const irScore = Math.min(1, ir) * 3.2;
      const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0;
      const bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
      const big01 = Math.min(1, area / (900 * 500)); let bgPenalty = 0;
      const autoplay = v.autoplay || v.hasAttribute?.('autoplay'), loop = v.loop || v.hasAttribute?.('loop'), noControls = !v.controls;
      const edgeLike = (r.top < 40 || (innerHeight - r.bottom) < 40 || r.left < 20 || (innerWidth - r.right) < 20), tiny = area < (260 * 160);
      if (v.muted && autoplay && noControls) { bgPenalty += 1.1 * (1 - 0.60 * big01); if (edgeLike) bgPenalty += 0.9 * (1 - 0.70 * big01); if (tiny) bgPenalty += 0.8; if (loop) bgPenalty += 0.35 * (1 - 0.50 * big01); } else if (bgLike && !audible) { bgPenalty = (1.6 * (1 - 0.65 * big01)); if (userRecent01 > 0.15) bgPenalty *= 0.55; }
      return (playing * 6.0) + (hasTime * 2.4) + (areaScore * 1.2) + (distScore * 3.0) + userBoost + irScore + (audible * 1.35) + (audioBoostOn ? audible * 1.2 : 0) - bgPenalty;
    }

    const scoreVideoCached = (v, audioBoostOn, now, lastUserPt) => {
      const userT = (lastUserPt && Number.isFinite(lastUserPt.t)) ? lastUserPt.t : 0;
      const aFlag = audioBoostOn ? 1 : 0;
      let c = __scoreCache.get(v); 
      if (c && (now - c[0]) < 60 && c[2] === aFlag && c[3] === userT) return c[1];
      const s = scoreVideo(v, audioBoostOn, now, lastUserPt);
      if (!c) { c = [now, s, aFlag, userT]; __scoreCache.set(v, c); } 
      else { c[0] = now; c[1] = s; c[2] = aFlag; c[3] = userT; } 
      return s;
    };

    const pickDetailed = (videos, lastUserPt, audioBoostOn) => {
      const now = performance.now();
      if (!videos || videos.size === 0) { 
        __currentTarget = null; __currentSince = now; 
        __pickRes.target = null; __pickRes.bestScore = -Infinity; __pickRes.curScore = -Infinity; __pickRes.delta = 0; __pickRes.secondScore = -Infinity; __pickRes.now = now;
        return __pickRes; 
      }
      __limitedBuf.length = 0;
      for (const v of videos) {
        if (!v || v.readyState < 2 || v[VSCX.visible] === false) continue;
        const ir = (v[VSCX.ir] == null) ? 0 : v[VSCX.ir]; const r = getRectCached(v, now, 420); const area = r.width * r.height;
        if (r.width < 80 || r.height < 60 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || (ir < 0.01 && area < 160 * 120)) continue;
        insertTopN(__limitedBuf, { v, s: (Math.min(1, ir) * 3.0) + (Math.log2(1 + area / 20000) * 1.2) }, 10);
      }
      const curScore = (__currentTarget && videos.has(__currentTarget)) ? scoreVideoCached(__currentTarget, audioBoostOn, now, lastUserPt) : -Infinity;
      let best = __currentTarget, bestScore = curScore, secondScore = -Infinity;
      for (const it of __limitedBuf) {
        const s = scoreVideoCached(it.v, audioBoostOn, now, lastUserPt);
        if (s > bestScore) { secondScore = bestScore; bestScore = s; best = it.v; } else if (s > secondScore) { secondScore = s; }
      }
      
      let delta = bestScore - curScore;
      if (__currentTarget && (now - __currentSince) < 1400 && best !== __currentTarget && delta < 1.15) {
         __pickRes.target = __currentTarget; __pickRes.bestScore = curScore; __pickRes.curScore = curScore; __pickRes.delta = 0; __pickRes.secondScore = secondScore; __pickRes.now = now;
         return __pickRes;
      }
      if (best !== __currentTarget) { __currentTarget = best; __currentSince = now; }
      
      __pickRes.target = __currentTarget; __pickRes.bestScore = bestScore; __pickRes.curScore = curScore; __pickRes.delta = delta; __pickRes.secondScore = secondScore; __pickRes.now = now;
      return __pickRes;
    };

    const buildApplySetReuse = (visibleVideos, target, extraApplyTopK, applyToAllVisibleVideos, lastUserPt, audioBoostOn) => {
      __applySetReuse.clear();
      if (applyToAllVisibleVideos) { for (const v of visibleVideos) __applySetReuse.add(v); return __applySetReuse; }
      if (target) __applySetReuse.add(target);
      const N = Math.max(0, extraApplyTopK | 0); if (N <= 0) return __applySetReuse;
      const now = performance.now(); __topBuf.length = 0;
      for (const v of visibleVideos) {
        if (!v || v === target) continue;
        const s = scoreVideoCached(v, audioBoostOn, now, lastUserPt);
        if (Number.isFinite(s) && s > -1e8) insertTopN(__topBuf, { v, s }, N);
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
    const toneStr = (!!vf.tonePreset && vf.tonePreset !== 'neutral') ? clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;
    const sharpIntent = Math.abs(vf.sharp || 0) / 50, sharp2Intent = Math.abs(vf.sharp2 || 0) / 50, clarityIntent = Math.abs(vf.clarity || 0) / 50;
    const expIntent = clamp(manualExp + presetExp + toneStr * 0.18, 0, 3.0);
    const toneIntent = clamp((manualExp * 0.55) + manualCol + presetCol + toneStr * 0.55 + (clarityIntent * 0.95) + (sharpIntent * 0.15) + (sharp2Intent * 0.22), 0, 3.5);
    let expMix = clamp(1 - 0.60 * clamp(expIntent / 1.45, 0, 1), 0.20, 1.00);
    let toneMix = clamp(1 - 0.75 * clamp(toneIntent / 1.45, 0, 1), 0.08, 1.00);
    const prof = (aeMeta && aeMeta.profileResolved) ? aeMeta.profileResolved : (vf.aeProfile || 'standard');
    const AE_MIX_TUNE = { standard: { expBase: 1.00, toneBase: 1.00, conflictK: 1.00 }, bright: { expBase: 1.05, toneBase: 1.02, conflictK: 0.95 }, cinemaHdr: { expBase: 0.88, toneBase: 0.90, conflictK: 1.25 } };
    const AE_AUTO_MIX_BIAS = { standard: { exp: 1.00, tone: 1.00 }, bright: { exp: 1.05, tone: 0.96 }, cinemaHdr: { exp: 0.82, tone: 0.86 } };
    const t = AE_MIX_TUNE[prof] || AE_MIX_TUNE.standard;
    const conf01 = clamp((manualExp * 0.80 + manualCol * 1.10 + presetExp * 0.50 + presetCol * 0.70 + sharpIntent * 0.75 + sharp2Intent * 0.95 + clarityIntent * 0.85 + toneStr * 0.55) / 2.35, 0, 1);
    expMix *= t.expBase * (AE_AUTO_MIX_BIAS[prof] || AE_AUTO_MIX_BIAS.standard).exp * (1 - conf01 * (0.34 * t.conflictK));
    toneMix *= t.toneBase * (AE_AUTO_MIX_BIAS[prof] || AE_AUTO_MIX_BIAS.standard).tone * (1 - conf01 * (0.58 * t.conflictK)) * (1 - 0.20 * clamp(clarityIntent / 0.80, 0, 1)) * (1 - 0.16 * clamp((sharpIntent + sharp2Intent) / 1.20, 0, 1));
    const hi = clamp(aeMeta?.hiRisk ?? 0, 0, 1); if (hi > 0.02) { expMix *= (1 - 0.10 * hi); toneMix *= (1 - 0.26 * hi); }
    const lock = clamp(userLock01 || 0, 0, 1); expMix *= (1 - 0.80 * lock); toneMix *= (1 - 0.90 * lock);
    outMix.expMix = Math.round(clamp(expMix, 0.10, 1.00) / 0.02) * 0.02; outMix.toneMix = Math.round(clamp(toneMix, 0.05, 1.00) / 0.02) * 0.02;
  }

  function computeToneStrengthEff(vf, ae, Utils, userLock01) {
    if (!vf?.tonePreset || vf.tonePreset === 'neutral') return 0;
    const t0 = Utils.clamp(vf.toneStrength ?? 1.0, 0, 1); if (!ae) return t0;
    let damp = 1.0 * (1 - 0.30 * Utils.clamp(ae.hiRisk ?? 0, 0, 1)) * (1 - 0.24 * Utils.clamp((ae.clipFrac ?? 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1)) * (0.86 + 0.14 * Utils.clamp(ae.cf ?? 0.5, 0, 1));
    if (vf.tonePreset === 'highlight') damp *= (1 - 0.22 * Utils.clamp(ae.hiRisk ?? 0, 0, 1) - 0.18 * Utils.clamp((ae.clipFrac ?? 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1));
    if (vf.tonePreset === 'redSkin') damp *= (1 - 0.22 * Utils.clamp(((ae.rd ?? 0) - 0.06) / 0.09, 0, 1));
    damp *= (1 - 0.55 * Utils.clamp(userLock01 || 0, 0, 1)); return Utils.clamp(t0 * damp, 0, 1);
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
    if (!presetName || presetName === 'neutral') return out;
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
    let gamma = (vUser.gamma || 1.0) * preGammaF * (A.gammaF || 1.0), contrast = (vUser.contrast || 1.0) * preConF * (A.conF || 1.0), satF = ((vUser.sat || 100) / 100) * preSatF * (A.satF || 1.0), bright = (vUser.bright || 0) + preBright + (A.brightAdd || 0), temp = (vUser.temp || 0) + preTemp + (A.tempAdd || 0);
    const gain = clamp(A.gain || 1.0, 1.0, 8.0);
    let sharpMul = Math.max(0.88, 1 / (1 + (gain - 1.0) * 0.4)) * (1 - Math.min(0.08, (A.hiRisk || 0) * 0.1)) * (0.92 + 0.08 * Math.max(0, Math.min(1, ((A.cf != null ? A.cf : 0.5) - 0.10) / 0.22)));
    const chromaStress = (Math.min(1, Math.abs(satF - 1) / 0.55) * 0.85) + (Math.min(1, Math.abs(temp) / 25) * 0.65);
    const riskStress = (clamp(A.hiRisk || 0, 0, 1) * 0.70) + ((1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1)) * 0.45);
    const guard = 1 / (1 + chromaStress * 0.15 + riskStress * 0.15);
    sharpMul *= (0.92 + 0.08 * guard);
    const hiRisk01 = clamp(A.hiRisk || 0, 0, 1); const clip01 = clamp((A.clipFrac || 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1); const flat01 = 1 - clamp(A.cf != null ? A.cf : 0.5, 0, 1);
    const aeDetailGuard = 1 - (hiRisk01 * 0.10 + clip01 * 0.06 + flat01 * 0.04);
    sharpMul *= clamp(aeDetailGuard, 0.82, 1.0);
    let sharp = ((vUser.sharp || 0) + preSharp) * sharpMul, sharp2 = ((vUser.sharp2 || 0) + preSharp2) * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2))), clarity = ((vUser.clarity || 0) + preClarity) * sharpMul * (0.85 + 0.15 * (1 / (1 + chromaStress * 0.2 + riskStress * 0.2)));
    const skin01 = clamp(A.rd || 0, 0, 1); sharp *= (1 - 0.05 * skin01); sharp2 *= (1 - 0.10 * skin01);
    const manualIntent = Math.abs(vUser.bright || 0) / 22 + Math.abs((vUser.gamma || 1) - 1) / 0.14 + Math.abs((vUser.contrast || 1) - 1) / 0.14 + Math.abs((vUser.sat || 100) - 100) / 35 + Math.abs(vUser.temp || 0) / 9 + Math.abs(vUser.sharp || 0) / 35 + Math.abs(vUser.sharp2 || 0) / 35 + Math.abs(vUser.clarity || 0) / 30;
    const manualIntent01 = clamp(manualIntent / 2.2, 0, 1);
    const styleMix = 1.00 - 0.18 * manualIntent01;
    out.gain = gain; out.gamma = clamp(gamma, 0.5, 2.5); out.contrast = clamp(contrast, 0.5, 2.0); out.bright = clamp(bright, -50, 50); out.satF = clamp(satF, 0.0, 2.0); out.mid = clamp(((A.mid || 0) * styleMix), -1, 1); out.sharp = clamp(sharp, 0, 50); out.sharp2 = clamp(sharp2, 0, 50); out.clarity = clamp(clarity, 0, 50); out.dither = vUser.dither || 0; out.temp = clamp(temp, -25, 25); out.toe = (A.toe || 0) * styleMix; out.shoulder = (A.shoulder || 0) * styleMix;
    if (vUser.tonePreset && vUser.tonePreset !== 'neutral') { const toneAeProfileName = vUser.ae ? (resolvedAeProfileName || vUser.aeProfile || 'standard') : null; applyTonePreset2Inline(out, vUser.tonePreset, vUser.toneStrength, toneAeProfileName, Utils); }
    return out;
  }

  const isNeutralVideoParams = (v) => ( Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 && Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 && Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 && Math.abs((v.dither ?? 0)) < 0.01 && Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 && Math.abs((v.shoulder ?? 0)) < 0.01 );

  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0;
    function timerCb() { timer = 0; requestAnimationFrame(run); }
    const run = () => { queued = false; const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun; if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) { timer = setTimeout(timerCb, wait); } return; } lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} } };
    const request = (immediate = false) => { if (immediate) force = true; if (queued) return; queued = true; if (timer) { clearTimeout(timer); timer = 0; } requestAnimationFrame(run); };
    return { registerApply: (fn) => { applyFn = fn; }, request };
  }

  function createLocalStore(defaults, scheduler, Utils) {
    let state = Utils.deepClone(defaults), rev = 0; const listeners = new Map();
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const cb of a) { try { cb(val); } catch(_) {} } const [cat] = split2(key); const b = listeners.get(cat + '.*'); if (b) for (const cb of b) { try { cb(val); } catch(_) {} } };
    return { rev: () => rev, getCat: (cat) => (state[cat] ||= {}), get: (p) => { const [c, k] = split2(p); return state[c]?.[k]; }, set: (path, val) => { const [cat, key] = split2(path); if (!key) return; state[cat] ||= {}; if (state[cat][key] === val) return; state[cat][key] = val; rev++; emit(path, val); scheduler.request(false); }, batch: (cat, obj) => { state[cat] ||= {}; let has = false; for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; emit(`${cat}.${k}`, v); has = true; } } if (has) { rev++; scheduler.request(false); } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => { const cur = listeners.get(k); if (cur) cur.delete(f); }; } };
  }

  function createRegistry(scheduler, featureCheck) {
    const videos = new Set(); const visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    const shadowRootsLRU = []; const SHADOW_LRU_MAX = CONFIG.IS_LOW_END ? 8 : 24; const observedShadowHosts = new WeakSet();
    const io = new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; el[VSCX.visible] = isVis; el[VSCX.ir] = e.intersectionRatio || 0; el[VSCX.rect] = e.boundingClientRect; el.__vscRectT = now;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
      }
      if (changed) { rev++; if(featureCheck.active()) scheduler.request(false); }
    }, { root: null, threshold: 0.01, rootMargin: CONFIG.IS_LOW_END ? '120px' : '300px' });
    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
    const observeVideo = (el) => { if (!featureCheck.active() || !el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return; videos.add(el); io.observe(el); };
    const WorkQ = (() => {
      const q = [], bigQ = []; let head = 0, bigHead = 0, scheduled = false, epoch = 1; const mark = new WeakMap();
      function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); }
      const schedule = () => { if (scheduled) return; scheduled = true; if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle); else requestAnimationFrame(drainRunnerRaf); };
      const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n); schedule(); };
      const scanNode = (n) => { if (!n) return; if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } if (!n.querySelector?.('video')) return; try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; } if (n.nodeType === 11) { try { n.querySelectorAll?.('video')?.forEach(observeVideo); } catch (_) {} } };
      const drain = (dl) => { scheduled = false; const start = performance.now(); const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6; while (bigHead < bigQ.length && budget()) { scanNode(bigQ[bigHead++]); break; } while (head < q.length && budget()) { scanNode(q[head++]); } if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; } schedule(); };
      return Object.freeze({ enqueue });
    })();
    const observers = new Set();
    const connectObserver = (root) => { if (!root) return; const mo = new MutationObserver((muts) => { for (const m of muts) { if (!m.addedNodes || m.addedNodes.length === 0) continue; for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); } } if(featureCheck.active()) scheduler.request(false); }); mo.observe(root, { childList: true, subtree: true }); observers.add(mo); WorkQ.enqueue(root); };
    const refreshObservers = () => { for (const o of observers) o.disconnect(); observers.clear(); for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); } const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
    document.addEventListener('vsc-shadow-root', (e) => { try { const sr = e.detail; const host = sr?.host; if (!sr || !host || observedShadowHosts.has(host)) return; observedShadowHosts.add(host); shadowRootsLRU.push({ host, root: sr }); if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift(); connectObserver(sr); } catch (_) {} });
    refreshObservers();
    function pruneBatch(set, visibleSet, dirtySet, unobserveFn, batch = 200) { let removed = 0; const it = set.values(); for (let i = 0; i < batch; i++) { const el = it.next().value; if (!el) break; if (!el.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); try { unobserveFn(el); } catch (_) {} removed++; } } return removed; }
    return { videos, visible, rev: () => rev, refreshObservers, prune: () => { if (pruneBatch(videos, visible.videos, dirty.videos, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220)) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; }, rescanAll: () => { WorkQ.enqueue(document.body || document.documentElement); } };
  }

  function createAudio(sm) {
    let ctx, compressor, dry, wet, target = null, currentSrc = null, wetConnected = false; const srcMap = new WeakMap();
    let lastDryOn = null; let lastWetGain = null;
    const onGesture = () => { try { if (ctx?.state === 'suspended') ctx.resume(); } catch (_) {} }; window.addEventListener('pointerdown', onGesture, { once: true, passive: true });
    const ensureCtx = () => { if (ctx) return true; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.knee.value = 24; compressor.ratio.value = 4; compressor.attack.value = 0.005; compressor.release.value = 0.20; dry = ctx.createGain(); wet = ctx.createGain(); dry.connect(ctx.destination); wet.connect(ctx.destination); compressor.connect(wet); return true; };
    const updateMix = () => { if (!ctx) return; const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); const boost = Math.pow(10, sm.get(P.A_BST) / 20); const dryTarget = en ? 0 : 1; const wetTarget = en ? boost : 0; if (lastDryOn !== dryTarget) { dry.gain.setTargetAtTime(dryTarget, ctx.currentTime, 0.05); lastDryOn = dryTarget; } if (lastWetGain == null || Math.abs(lastWetGain - wetTarget) > 1e-4) { wet.gain.setTargetAtTime(wetTarget, ctx.currentTime, 0.05); lastWetGain = wetTarget; } if (currentSrc) { if (en && !wetConnected) { try { currentSrc.connect(compressor); wetConnected = true; } catch (_) {} } else if (!en && wetConnected) { try { currentSrc.disconnect(compressor); wetConnected = false; } catch (_) {} } } };
    const disconnectAll = () => { if (currentSrc) { try { if (wetConnected) currentSrc.disconnect(compressor); currentSrc.disconnect(dry); } catch (_) {} } currentSrc = null; target = null; wetConnected = false; };
    return { setTarget: (v) => { const enabled = sm.get(P.A_EN) && sm.get(P.APP_ACT); if (v && v[VSCX.audioFail]) { if (v !== target) { disconnectAll(); target = v; } updateMix(); return; } if (v !== target) { disconnectAll(); target = v; } if (!v) { updateMix(); return; } if (!ensureCtx()) return; if (!currentSrc && (enabled || (ctx && sm.get(P.APP_ACT)))) { try { let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); } s.connect(dry); currentSrc = s; } catch (_) { v[VSCX.audioFail] = true; disconnectAll(); } } updateMix(); }, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc };
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp, createLRU } = Utils; const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(CONFIG.IS_LOW_END ? 320 : 720);
    const getNoiseUrl = (() => { let u = null; return () => { if (!u) { const c = document.createElement('canvas'); c.width = c.height = 64; const cx = c.getContext('2d', { alpha: false }), img = cx.createImageData(64, 64); let a = 1337 >>> 0; const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; for (let i = 0; i < img.data.length; i += 4) { const n = Math.floor(128 + (r() - 0.5) * 90); img.data[i] = img.data[i + 1] = img.data[i + 2] = n; img.data[i + 3] = 255; } cx.putImageData(img, 0, 0); u = c.toDataURL('image/png'); } return u; }; })();
    const qInt = (v, step) => Math.round(v / step), setAttr = (node, attr, val, st, key) => { if (node && st[key] !== val) { st[key] = val; node.setAttribute(attr, val); } }, smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a)))); return t * t * (3 - 2 * t); };
    const makeKey = (s) => ['video', qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2), qInt(s.dither, 1)].join('|');

    function getToneTableCached(steps, toeN, shoulderN, midN, bright, contrast, gain) {
      const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(bright,0.2)}|${qInt(contrast,0.01)}|${qInt(gain,0.04)}`; const hit = toneCache.get(key); if (hit) return hit;
      if (toeN === 0 && shoulderN === 0 && midN === 0 && bright === 0 && contrast === 1 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; }
      const br = (bright / 1000), con = contrast, toeEnd = 0.34 + toeN * 0.06, toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1, shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN), ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g), pivot = clamp(0.50 + midN * 0.06, 0.44, 0.56);
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
        let y = (x - pivot) * con + pivot + br; if (y < 0.08) { const t = clamp(y / 0.08, 0, 1); y = 0.08 * (t * t * (3 - 2 * t)); } y = clamp(y, 0, 1);
        const g01 = clamp((gain - 1.0) / 2.2, 0, 1), clipStart = 0.92 - 0.018 * g01; if (y > clipStart) { const t2 = (y - clipStart) / (1 - clipStart), w2 = t2 * t2 * (3 - 2 * t2), k2 = (0.45 + 0.55 * shAmt) * (1.0 + 0.35 * g01); y = clamp(clipStart + (y - clipStart) * (1 - w2 * k2), 0, 1); }
        if (y < prev) y = prev; prev = y;
        const yy = Math.round(y * 100000) / 100000; out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
      }
      const res = out.join(' '); toneCache.set(key, res); return res;
    }

    function buildSvg(doc) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const fid = `vsc-video-${config.VSC_ID}`, filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '-15%', y: '-15%', width: '130%', height: '130%' });
      const tone = h('feComponentTransfer', { ns: 'svg', result: 'tone' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
      const gam = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })));
      const tmp = h('feComponentTransfer', { ns: 'svg', in: 'gam', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
      const sat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1', result: 'sat' });
      const b1 = h('feGaussianBlur', { ns: 'svg', in: 'sat', stdDeviation: '0', result: 'b1' }), sh1 = h('feComposite', { ns: 'svg', in: 'sat', in2: 'b1', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh1' });
      const b2 = h('feGaussianBlur', { ns: 'svg', in: 'sh1', stdDeviation: '0', result: 'b2' }), sh2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'b2', operator: 'arithmetic', k2: '1', k3: '0', result: 'sh2' });
      const bc = h('feGaussianBlur', { ns: 'svg', in: 'sh2', stdDeviation: '0', result: 'bc' }), cl = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'bc', operator: 'arithmetic', k2: '1', result: 'cl' });
      const feImg = h('feImage', { ns: 'svg', href: getNoiseUrl(), preserveAspectRatio: 'none', result: 'noiseImg' }); try { feImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', getNoiseUrl()); } catch(_) {}
      const feTile = h('feTile', { ns: 'svg', in: 'noiseImg', result: 'noise' }), feComp = h('feComposite', { ns: 'svg', in: 'cl', in2: 'noise', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'out' });
      filter.append(tone, gam, tmp, sat, b1, sh1, b2, sh2, bc, cl, feImg, feTile, feComp); defs.append(filter);
      const tryAppend = () => { const r = doc.documentElement || doc.body; if (r) { r.appendChild(svg); return true; } return false; };
      if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }
      return { fid, toneFuncs: Array.from(tone.children), gamFuncs: Array.from(gam.children), tmpFuncs: Array.from(tmp.children), sat, b1, sh1, b2, sh2, bc, cl, feComp, st: { lastKey: '', toneKey: '', toneTable: '', gammaKey: '', tempKey: '', satKey: '', detailKey: '', noiseKey: '', __b1: '', __sh1k2: '', __sh1k3: '', __b2: '', __sh2k2: '', __sh2k3: '', __bc: '', __clk2: '', __clk3: '' } };
    }

    function prepare(doc, s) {
      let dc = urlCache.get(doc); if (!dc) { dc = { key:'', url:'' }; urlCache.set(doc, dc); }
      const key = makeKey(s); if (dc.key === key) return dc.url;
      let nodes = ctxMap.get(doc); if (!nodes) { nodes = buildSvg(doc); ctxMap.set(doc, nodes); }
      if (nodes.st.lastKey !== key) {
        nodes.st.lastKey = key; const st = nodes.st, ditherOn = (s.dither || 0) > 0, steps = ditherOn ? (CONFIG.IS_LOW_END ? 64 : 96) : (CONFIG.IS_LOW_END ? 96 : 128);
        const tk = `${steps}|${qInt(clamp((s.toe||0)/14,-1,1),0.02)}|${qInt(clamp((s.shoulder||0)/16,-1,1),0.02)}|${qInt(clamp(s.mid||0,-1,1),0.02)}|${qInt(s.bright||0,0.2)}|${qInt(s.contrast||1,0.01)}|${qInt(s.gain||1,0.04)}`;
        if (st.toneKey !== tk) { st.toneKey = tk; const table = getToneTableCached(steps, qInt(clamp((s.toe||0)/14,-1,1),0.02)*0.02, qInt(clamp((s.shoulder||0)/16,-1,1),0.02)*0.02, qInt(clamp(s.mid||0,-1,1),0.02)*0.02, qInt(s.bright||0,0.2)*0.2, qInt(s.contrast||1,0.01)*0.01, qInt(s.gain||1,0.04)*0.04); if (st.toneTable !== table) { st.toneTable = table; for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', table); } }
        const gk = (1/clamp(s.gamma||1,0.2,3)).toFixed(4); if (st.gammaKey !== gk) { st.gammaKey = gk; for (const fn of nodes.gamFuncs) fn.setAttribute('exponent', gk); }
        setAttr(nodes.sat, 'values', clamp(s.satF ?? 1, 0, 2.5).toFixed(2), st, 'satKey');
        const t = clamp(s.temp || 0, -25, 25); let rs = 1, gs = 1, bs = 1; if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.01; } else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.01; } const tmk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`; if (st.tempKey !== tmk) { st.tempKey = tmk; nodes.tmpFuncs[0].setAttribute('slope', rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', bs.toFixed(3)); }
        const dk = `${(s.sharp || 0).toFixed(2)}|${(s.sharp2 || 0).toFixed(2)}|${(s.clarity || 0).toFixed(2)}`;
        if (st.detailKey !== dk) { st.detailKey = dk; const sc = (x) => x * x * (3 - 2 * x), v1 = (s.sharp || 0) / 50, kC = sc(Math.min(1, v1)) * 1.8; setAttr(nodes.b1, 'stdDeviation', v1 > 0 ? (1.1 - sc(Math.min(1, v1)) * 0.4).toFixed(2) : '0', st, '__b1'); setAttr(nodes.sh1, 'k2', (1 + kC).toFixed(3), st, '__sh1k2'); setAttr(nodes.sh1, 'k3', (-kC).toFixed(3), st, '__sh1k3'); const v2 = (s.sharp2 || 0) / 50, kF = sc(Math.min(1, v2)) * 3.8; setAttr(nodes.b2, 'stdDeviation', v2 > 0 ? '0.38' : '0', st, '__b2'); setAttr(nodes.sh2, 'k2', (1 + kF).toFixed(3), st, '__sh2k2'); setAttr(nodes.sh2, 'k3', (-kF).toFixed(3), st, '__sh2k3'); const clVal = (s.clarity || 0) / 50; setAttr(nodes.bc, 'stdDeviation', clVal > 0 ? '1.2' : '0', st, '__bc'); setAttr(nodes.cl, 'k2', (1 + clVal).toFixed(3), st, '__clk2'); setAttr(nodes.cl, 'k3', (-clVal).toFixed(3), st, '__clk3'); }
        const amt = clamp((s.dither || 0) / 100, 0, 1), nk = `${(amt * 0.04).toFixed(4)}|${(-0.5 * amt * 0.04).toFixed(4)}`; if (st.noiseKey !== nk) { st.noiseKey = nk; nodes.feComp.setAttribute('k3', (amt * 0.04).toFixed(4)); nodes.feComp.setAttribute('k4', (-0.5 * amt * 0.04).toFixed(4)); }
      }
      const url = `url(#${nodes.fid})`; dc.key = key; dc.url = url; return url;
    }

    return { prepareCached: (doc, s) => { try { return prepare(doc, s); } catch (e) { try { console.warn('[VSC] filter prepare failed:', e); } catch(_) {} return null; } }, applyUrl: (el, url) => { if (!el) return; if (!url) { if (el[VSCX.applied]) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el[VSCX.applied] = false; } return; } if (el.style.filter !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); el[VSCX.applied] = true; } }, clear: (el) => { if (!el || !el[VSCX.applied]) return; el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el[VSCX.applied] = false; } };
  }

  const WORKER_CODE = `const histAll = new Uint32Array(256), histTop = new Uint32Array(256), histBot = new Uint32Array(256); function pctFromHist(h, n, p){ const t = n * p; let a = 0; for(let i=0;i<256;i++){ a += h[i]; if(a >= t) return i/255; } return 1; } self.onmessage = function(e){ const {buf, width, height, step, token} = e.data || {}; if(!buf || !width || !height) return; const data = new Uint8ClampedArray(buf); histAll.fill(0); histTop.fill(0); histBot.fill(0); let sumAll=0, sumSqAll=0, nAll=0, sumTop=0, sumSqTop=0, nTop=0, clipAll=0, clipBottom=0, clipLowAll=0, botSum=0, botSumSq=0, botN=0, rSum=0, gSum=0, bSum=0, skinCnt=0, skinAcc=0; const botY0 = Math.floor(height * 0.78), stride = width * 4; let botBrightRows = 0, botRowCount = 0; for(let y=0; y<height; y+=step){ const row = y*stride; const isTop = (y < botY0); const isBottom = !isTop; let rowSum=0, rowSumSq=0, rowCnt=0; for(let x=0; x<width; x+=step){ const i = row + x*4; const r = data[i], g = data[i+1], b = data[i+2]; const Y = (0.2126*r + 0.7152*g + 0.0722*b) | 0; histAll[Y]++; sumAll += Y; sumSqAll += Y*Y; nAll++; rSum += r; gSum += g; bSum += b; if(isTop) { histTop[Y]++; sumTop += Y; sumSqTop += Y*Y; nTop++; } else { histBot[Y]++; botSum += Y; botSumSq += Y*Y; botN++; } if(Y >= 251){ clipAll++; if(isBottom) clipBottom++; } if(Y <= 4){ clipLowAll++; } if(isBottom){ rowSum += Y; rowSumSq += Y*Y; rowCnt++; } const Yf = Y / 255, rf = r/255, gf = g/255, bf = b/255; if (Yf > 0.20 && Yf < 0.78) { const redish = Math.max(0, Math.min(1, (rf - gf) * 1.8 + (rf - bf) * 1.2)); const notTooSatBlue = Math.max(0, 1 - (bf - rf) * 2.0); const s = redish * notTooSatBlue; if (s > 0.10) { skinAcc += s; skinCnt++; } } } if (isBottom && rowCnt > 0){ botRowCount++; const avg = rowSum / rowCnt, varr = (rowSumSq / rowCnt) - avg*avg, std = Math.sqrt(Math.max(0,varr)); if (avg > 238 && std < 7.0) botBrightRows++; } } const avgAll = nAll ? (sumAll/nAll) : 0, varAll = nAll ? (sumSqAll/nAll - avgAll*avgAll) : 0, stdAll = Math.sqrt(Math.max(0,varAll))/255, avgTop = nTop ? (sumTop/nTop) : avgAll, varTop = nTop ? (sumSqTop/nTop - avgTop*avgTop) : varAll, stdTop = Math.sqrt(Math.max(0,varTop))/255, botAvg = botN ? (botSum/botN)/255 : 0, botVar = botN ? (botSumSq/botN - (botSum/botN)**2) : 0, botStd = Math.sqrt(Math.max(0,botVar))/255, cfAll = Math.min(1, stdAll/0.22), cfTop = Math.min(1, stdTop/0.22), rgbSum = (rSum+gSum+bSum) || 1, redDominance = Math.max(0, Math.min(1, (rSum/rgbSum) - 0.28)), skinScore = skinCnt ? Math.min(1, (skinAcc/skinCnt) * 1.25) : 0; self.postMessage({ token, p02: pctFromHist(histAll, nAll, 0.02), p05: pctFromHist(histAll, nAll, 0.05), p10: pctFromHist(histAll, nAll, 0.10), p35: pctFromHist(histAll, nAll, 0.35), p50: pctFromHist(histAll, nAll, 0.50), p60: pctFromHist(histAll, nAll, 0.60), p90: pctFromHist(histAll, nAll, 0.90), p95: pctFromHist(histAll, nAll, 0.95), p98: pctFromHist(histAll, nAll, 0.98), avgLuma: avgAll/255, stdDev: stdAll, cf: cfAll, clipFrac: nAll ? (clipAll/nAll) : 0, clipLowFrac: nAll ? (clipLowAll/nAll) : 0, p10T: pctFromHist(histTop, nTop || 1, 0.10), p35T: pctFromHist(histTop, nTop || 1, 0.35), p50T: pctFromHist(histTop, nTop || 1, 0.50), p60T: pctFromHist(histTop, nTop || 1, 0.60), p90T: pctFromHist(histTop, nTop || 1, 0.90), p95T: pctFromHist(histTop, nTop || 1, 0.95), p98T: pctFromHist(histTop, nTop || 1, 0.98), stdDevT: stdTop, cfT: cfTop, clipFracBottom: botN ? (clipBottom/botN) : 0, botAvg, botStd, botP95: pctFromHist(histBot, botN || 1, 0.95), botBrightRows, botRowCount, redDominance, skinScore }); };`;

  function createAE(sm, { IS_MOBILE, Utils }, onAE) {
    let worker = null, workerUrl = null, canvas = null, ctx2d = null, activeVideo = null, isRunning = false, workerBusy = false, targetToken = 0;
    let __userLock01 = 0; const setUserLock01 = (v) => { __userLock01 = Utils.clamp(v || 0, 0, 1); };
    let loopToken = 0; function __loopCb() { loop(loopToken); }
    let lastStats = { p02: -1, p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 };
    let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0, curGain = 1.0, __prevFrame = null, __motion01 = 1, sampleCount = 0, lastLoopT = 0;
    let __autoProfile = 'standard', __autoHoldUntil = 0, __lastMeta = { hiRisk: 0, luma: 0, clipFrac: 0, cf: 0.5, rd: 0, profileResolved: 'standard' };
    const { clamp } = Utils; let __packKey = '', __pack = null;
    const AE_STAT_KEYS = Object.freeze(['p02', 'p05', 'p10', 'p35', 'p50', 'p90', 'p95', 'p98', 'clipFrac', 'clipLowFrac', 'cf', 'rd']);
    const getResolvedProfile = () => { const sel = sm.get(P.V_AE_PROFILE) || 'standard'; return (sel === 'auto') ? (__autoProfile || 'standard') : sel; };
    const getPack = () => { const name = getResolvedProfile(), key = (IS_MOBILE ? 'm|' : 'p|') + name; if (key !== __packKey) { __packKey = key; __pack = getAePack(IS_MOBILE, name); } return __pack; };
    const riskFrom = (p95, p98, clipFrac, clipLimit) => clamp(Math.max(clamp((p95 - 0.885) / 0.095, 0, 1) * 0.70 + clamp((p98 - 0.968) / 0.028, 0, 1) * 0.90, clamp((clipFrac - clipLimit) / (clipLimit * 4.0), 0, 1)), 0, 1);
    const sceneChangeFrom = (avgLumaNow, avgLumaPrev, motion01, cf01) => { if (avgLumaPrev < 0) return 1; return clamp(Math.abs(avgLumaNow - avgLumaPrev) / (0.040 + 0.020 * (1 - clamp(cf01, 0, 1)) + 0.015 * (1 - clamp(motion01, 0, 1))), 0, 1); };
    const computeTargetEV = (s, cfg) => { const p50 = clamp(s.p50, 0.01, 0.99), risk01 = riskFrom(s.p95 ?? s.p90, s.p98 ?? s.p95, Math.max(0, s.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT); let ev = Math.log2(clamp(cfg.TARGET_MID_BASE + clamp((0.17 - p50) / 0.11, 0, 1) * 0.050 - risk01 * 0.030, 0.20, 0.34) / clamp(p50 * 0.72 + clamp(s.p35 ?? s.p50, 0.01, 0.99) * 0.28, 0.01, 0.99)) * cfg.STRENGTH; ev = clamp(ev, cfg.MAX_DOWN_EV, cfg.MAX_UP_EV * (1 - 0.35 * risk01)); if (risk01 > 0.58) ev = Math.min(ev, 0); ev = Math.min(ev, Math.log2(Math.max(1, Math.min(0.985 / clamp(s.p98 ?? s.p95, 0.01, 0.999), 0.980 / clamp(s.p95 ?? s.p90, 0.01, 0.999)))) - (0.06 * risk01)); return Math.abs(ev) < cfg.DEAD_IN ? 0 : ev; };
    const computeLook = (ev, s, risk01, cfg, lookMul) => { 
      const p50 = clamp(s.p50 ?? 0.5, 0, 1), up01 = clamp(clamp(ev / 1.55, -1, 1), 0, 1), upE = up01 * up01 * (3 - 2 * up01), lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1); 
      let brightAdd = (up01 * 7.0) * clamp(0.52 - p50, -0.22, 0.22), mid = (up01 * 0.55) * clamp((0.50 - p50) / 0.22, -1, 1), toe = (3.6 + 5.6 * upE) * lowKey01 * (1 - 0.55 * risk01), shoulder = (4.8 + 5.2 * upE) * (risk01 * 0.85 + 0.15) * (1 - 0.25 * lowKey01), conF = 1 + (up01 * 0.050) * clamp((0.46 - clamp((clamp(s.p90 ?? 0.9, 0, 1) - clamp(s.p10 ?? 0.1, 0, 1)), 0, 1)) / 0.26, 0, 1) - (0.012 * risk01), satF = 1 + (1 - clamp(s.cf ?? 0.5, 0, 1)) * 0.22 * (1 - risk01 * 0.65); 
      brightAdd *= (1 - 0.85 * risk01); shoulder *= (1 - 0.60 * risk01); 
      const dn01 = clamp((-ev) / 1.10, 0, 1); const dnE = dn01 * dn01 * (3 - 2 * dn01);
      if (dn01 > 0) { satF *= (1 - 0.05 * dn01 * (0.5 + 0.5 * risk01)); conF = 1 + (conF - 1) * (1 - 0.20 * dn01); shoulder += 1.1 * dnE * (0.4 + 0.6 * risk01); brightAdd -= 1.2 * dnE * risk01; }
      const bias = clamp(cfg.TONE_BIAS ?? 0, -1, 1); brightAdd *= (1 + 0.10 * bias); satF *= (1 + 0.08 * bias); conF *= (1 + 0.02 * bias); shoulder *= (1 - 0.12 * bias); toe *= (1 + 0.08 * (-bias)); 
      const skinProtect = clamp(s.rd ?? 0, 0, 1) * 0.35; satF = satF * (1 - skinProtect * 0.35); conF = 1 + (conF - 1) * (1 - skinProtect * 0.25); shoulder *= (1 - skinProtect * 0.20 * risk01); 
      const crush01 = clamp((0.045 - clamp(s.p05 ?? 0.05, 0, 1)) / 0.030, 0, 1) * 0.65 + clamp((clamp(s.clipLowFrac ?? 0, 0, 1) - 0.010) / 0.030, 0, 1) * 0.75; 
      toe *= (1 - 0.55 * crush01); conF = 1 + (conF - 1) * (1 - 0.35 * crush01); 
      let outConF = conF * (lookMul.conMul ?? 1); let outSatF = satF * (lookMul.satMul ?? 1); let outBrightAdd = brightAdd * (lookMul.brMul ?? 1);
      outConF = clamp(outConF, 0.90, 1.12); outSatF = clamp(outSatF, cfg.SAT_MIN, Math.min(cfg.SAT_MAX, 1.16 - 0.10 * risk01)); outBrightAdd = clamp(outBrightAdd, -14, 14);
      return { conF: outConF, satF: outSatF, mid: clamp(mid, -0.95, 0.95), toe: clamp(toe, 0, 14), shoulder: clamp(shoulder, 0, 16), brightAdd: outBrightAdd }; 
    };
    const disableAEHard = () => { try { worker?.terminate(); } catch (_) {} worker = null; workerBusy = false; isRunning = false; loopToken++; targetToken++; if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) {} workerUrl = null; } try { const cat = sm.getCat('video'); if(cat) cat[VSCX.aeUnavailable] = true; } catch(_) {} };
    const ensureWorker = () => { if (worker) return worker; try { if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' })); worker = new Worker(workerUrl); worker.onmessage = (e) => { workerBusy = false; processResult(e.data); }; worker.onerror = () => { workerBusy = false; disableAEHard(); }; return worker; } catch (e) { try { console.warn('[VSC] worker blocked, AE engine unavailable:', e); } catch (_) {} disableAEHard(); return null; } };
    const _motionFromFrame = (rgba) => { const step = CONFIG.IS_LOW_END ? 32 : 16; if (!__prevFrame) { __prevFrame = new Uint8Array(Math.ceil(rgba.length / (4 * step))); let j = 0; for (let i = 0; i < rgba.length; i += 4 * step) { __prevFrame[j++] = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0; } __motion01 = 1; return; } let diff = 0, cnt = 0, j = 0; for (let i = 0; i < rgba.length && j < __prevFrame.length; i += 4 * step) { const y = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0; diff += Math.abs(y - __prevFrame[j]); __prevFrame[j++] = y; cnt++; } __motion01 = clamp((cnt ? (diff / cnt) : 0) / 28, 0, 1); };
    function chooseAutoProfileScored(s, risk01, prev) {
      const p50 = clamp(s.p50 ?? 0.5, 0, 1), cf = clamp(s.cf ?? 0.5, 0, 1), clipLow = clamp(s.clipLowFrac ?? 0, 0, 1), rd = clamp(s.rd ?? 0, 0, 1);
      const dyn = clamp((clamp(s.p90 ?? 0.9, 0, 1) - clamp(s.p10 ?? 0.1, 0, 1)), 0, 1), flat01 = clamp((0.46 - dyn) / 0.26, 0, 1), lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1);
      const score = { standard: 0.35 + (1 - Math.abs(p50 - 0.28) / 0.28) * 0.25 + (1 - risk01) * 0.10, bright: 0.10 + lowKey01 * 0.45 + cf * 0.15 + (1 - Math.min(1, clipLow / 0.04)) * 0.15 - risk01 * 0.15, cinemaHdr: 0.10 + flat01 * 0.25 + risk01 * 0.45 + rd * 0.10 };
      if (prev && score[prev] != null) score[prev] += 0.08;
      const entries = Object.entries(score).sort((a, b) => b[1] - a[1]);
      const [bestName, bestScore] = entries[0]; const secondScore = entries[1]?.[1] ?? -Infinity;
      return { next: bestName, margin: bestScore - secondScore };
    }
    function getAutoHoldMs(prev, next, changed) { if (!changed) return 1100; if ((prev === 'bright' && next === 'cinemaHdr') || (prev === 'cinemaHdr' && next === 'bright')) return 4800; return 3000; }
    const processResult = (data) => {
      if (!data || data.token !== targetToken) return;
      const pack = getPack(), cfg = pack.cfg, now = performance.now(); sampleCount++;
      const barRowRatio = (data.botRowCount > 0) ? (data.botBrightRows / data.botRowCount) : 0, uiBar = (barRowRatio > 0.55) || ((data.botAvg > 0.22 && data.botStd < 0.055) || (data.clipFracBottom > (cfg.CLIP_FRAC_LIMIT * 4) && data.botStd < 0.045)), subLikely = !uiBar && (barRowRatio > 0.12 && barRowRatio < 0.55) && (data.botP95 > 0.92) && (data.p50 < 0.24) && (data.stdDev > 0.055) && (data.botStd > 0.040);
      const stats = { p02: data.p02, p05: data.p05, p10: subLikely ? data.p10T : data.p10, p35: subLikely ? data.p35T : data.p35, p50: subLikely ? data.p50T : data.p50, p90: subLikely ? data.p90T : data.p90, p95: subLikely ? data.p95T : data.p95, p98: subLikely ? data.p98T : data.p98, clipFrac: data.clipFrac, clipLowFrac: data.clipLowFrac, cf: subLikely ? (data.cfT ?? data.cf) : data.cf, rd: (data.skinScore != null) ? data.skinScore : data.redDominance };
      const dt = Math.min(now - lastEmaT, 500); lastEmaT = now; const a = 1 - Math.exp(-dt / clamp((activeVideo?.paused ? 380 : cfg.DT_CAP_MS) + (1 - __motion01) * 160, 180, 650));
      for (let i=0; i < AE_STAT_KEYS.length; i++) { const k = AE_STAT_KEYS[i]; const v = stats[k]; if (Number.isFinite(v)) lastStats[k] = (lastStats[k] < 0) ? v : (v * a + lastStats[k] * (1 - a)); }
      const risk01 = riskFrom(Math.max(0, lastStats.p95), Math.max(0, lastStats.p98), Math.max(0, lastStats.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);
      if (sm.get(P.V_AE_PROFILE) === 'auto' && now >= __autoHoldUntil) { const prev = __autoProfile; const picked = chooseAutoProfileScored(lastStats, risk01, prev); const shouldSwitch = (picked.next !== prev) && (picked.margin > 0.06); if (shouldSwitch) __autoProfile = picked.next; __autoHoldUntil = now + getAutoHoldMs(prev, __autoProfile, shouldSwitch); }
      const sc01 = sceneChangeFrom(data.avgLuma, lastLuma, __motion01, clamp(lastStats.cf ?? 0.5, 0, 1)); lastLuma = data.avgLuma;
      let targetEV = computeTargetEV(lastStats, cfg) * Math.min(1, sampleCount / 3); if (risk01 > 0.75) targetEV = Math.min(targetEV, 0);
      const curEV = Math.log2(curGain), dtA = Math.min(now - lastApplyT, cfg.DT_CAP_MS); lastApplyT = now;
      const lock01 = clamp(__userLock01, 0, 1), nextEV = curEV + (targetEV - curEV) * ((1 - Math.exp(-dtA / (((sc01 > 0.55) ? cfg.TAU_AGGRESSIVE : ((targetEV > curEV && risk01 <= 0.70) ? cfg.TAU_UP : cfg.TAU_DOWN)) * (1 + risk01 * 1.10) * (1 + lock01 * 2.2)))) * (1 - ((lock01 > 0.70) ? clamp((lock01 - 0.70) / 0.30, 0, 1) : 0)));
      curGain = Math.pow(2, nextEV); const look = computeLook(nextEV, lastStats, risk01, cfg, pack.look);
      if (onAE) { __lastMeta.hiRisk = risk01; __lastMeta.cf = clamp(lastStats.cf ?? 0.5, 0, 1); __lastMeta.luma = data.avgLuma * 100; __lastMeta.clipFrac = lastStats.clipFrac; __lastMeta.rd = lastStats.rd; __lastMeta.profileResolved = getResolvedProfile(); onAE({ gain: curGain, gammaF: 1, conF: look.conF, satF: look.satF, mid: look.mid, toe: look.toe, shoulder: look.shoulder, brightAdd: look.brightAdd, tempAdd: clamp(cfg.TEMP_BIAS ?? 0, -6, 6), hiRisk: risk01, cf: __lastMeta.cf, luma: __lastMeta.luma, clipFrac: lastStats.clipFrac, rd: lastStats.rd }); }
    };
    const sample = (v) => {
      if (!isRunning || !v || document.hidden || v[VSCX.tainted] || v.readyState < 2 || v[VSCX.visible] === false || (v.videoWidth|0) === 0 || (v.videoHeight|0) === 0) return;
      const now = performance.now(); if (now - lastSampleT < ((v.paused ? 600 : (CONFIG.IS_LOW_END ? 120 : 90)) + (1 - __motion01) * 80) * (1 + __userLock01 * 3.5)) return;
      lastSampleT = now; if (workerBusy) return;
      try {
        if (!canvas) { canvas = document.createElement('canvas'); canvas.width = canvas.height = CONFIG.IS_LOW_END ? 24 : 32; ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false }); }
        ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height); const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
        _motionFromFrame(d.data); workerBusy = true; const wk = ensureWorker();
        if (wk) wk.postMessage({ buf: d.data.buffer, width: canvas.width, height: canvas.height, step: canvas.width <= 24 ? 1 : 2, token: targetToken }, [d.data.buffer]); else workerBusy = false;
      } catch (_) { workerBusy = false; v[VSCX.tainted] = true; }
    };
    const loop = (token) => { if (!isRunning || token !== loopToken) return; const v = activeVideo, now = performance.now(); if (sm.get(P.APP_ACT) && sm.get(P.V_AE) && v && v.isConnected && !document.hidden && now - lastLoopT > (v.paused ? 280 : (CONFIG.IS_LOW_END ? 110 : 85))) { lastLoopT = now; sample(v); } if (v && v.requestVideoFrameCallback && !v.paused) { try { v.requestVideoFrameCallback(__loopCb); return; } catch (_) {} } setTimeout(__loopCb, 90); };
    const hardResetStats = () => { workerBusy = false; __prevFrame = null; lastSampleT = 0; lastLuma = -1; sampleCount = 0; lastStats = { p02: -1, p05: -1, p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, clipLowFrac: -1, cf: -1, rd: -1 }; lastEmaT = performance.now(); lastApplyT = performance.now(); };
    return {
      getResolvedProfile, getMeta: () => ({ ...__lastMeta, profileResolved: getResolvedProfile() }),
      setTarget: (v, opts = {}) => { if (v === activeVideo) return; activeVideo = v; targetToken++; curGain = opts.keepGain ? clamp(curGain, 1.0, 6.0) : 1.0; hardResetStats(); },
      start: () => { const wk = ensureWorker(); if (!wk) { isRunning = false; return; } if (!isRunning) { isRunning = true; loopToken++; lastLoopT = 0; lastApplyT = lastEmaT = performance.now(); lastSampleT = 0; loop(loopToken); } },
      stop: () => { isRunning = false; loopToken++; try { worker?.terminate(); } catch (_) {} worker = null; if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) {} workerUrl = null; } activeVideo = null; curGain = 1.0; lastLuma = -1; __prevFrame = null; },
      wake: () => { lastSampleT = 0; lastLoopT = 0; },
      userTweak: () => { hardResetStats(); lastSampleT = 0; lastLoopT = 0; },
      __setOnAE: (fn) => { onAE = fn; }, setUserLock01, hintProfileChanged: () => { __autoHoldUntil = 0; hardResetStats(); }
    };
  }

  function createUI(sm, defaults, config, registry, scheduler, bus) {
    const { h } = Utils; let container, monitorEl, gearHost, gearBtn, fadeTimer = 0; const unsubs = [];
    const sub = (k, fn) => { const off = sm.sub(k, fn); unsubs.push(off); return off; };
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
    const allowUiInThisDoc = () => { return registry.videos.size > 0; };
    const TRIGGERS = Object.freeze({ [P.V_GAMMA]: { aeLevel: 2, lockMs: 2600, lockAmp: 1.00 }, [P.V_CONTR]: { aeLevel: 2, lockMs: 2600, lockAmp: 1.00 }, [P.V_BRIGHT]: { aeLevel: 2, lockMs: 2400, lockAmp: 1.00 }, [P.V_PRE_MIX]: { aeLevel: 2, lockMs: 2200, lockAmp: 0.90 }, [P.V_SAT]: { aeLevel: 1, lockMs: 1800, lockAmp: 0.85 }, [P.V_TEMP]: { aeLevel: 1, lockMs: 1800, lockAmp: 0.85 }, [P.V_SHARP]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_SHARP2]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_CLARITY]: { aeLevel: 1, lockMs: 2000, lockAmp: 0.90 }, [P.V_DITHER]: { aeLevel: 1, lockMs: 1400, lockAmp: 0.70 }, [P.V_TONE_STR]: { aeLevel: 1, lockMs: 1600, lockAmp: 0.80 }, [P.V_AE_STR]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.55 }, [P.V_AE_PROFILE]: { aeLevel: 2, lockMs: 900, lockAmp: 0.35, profileChanged: true }, [P.V_TONE_PRE]: { aeLevel: 1, lockMs: 900, lockAmp: 0.45 }, [P.V_PRE_S]: { aeLevel: 1, lockMs: 1200, lockAmp: 0.80 }, [P.V_PRE_B]: { aeLevel: 2, lockMs: 1800, lockAmp: 0.90 } });
    function setAndHint(path, value, forceApply = true) { sm.set(path, value); const t = TRIGGERS[path]; if (!t) { bus.signal({ aeLevel: 0, forceApply: !!forceApply }); return; } bus.signal({ aeLevel: (t.aeLevel | 0), forceApply: !!forceApply, userLockMs: t.lockMs | 0, userLockAmp: (t.lockAmp == null ? 0 : +t.lockAmp), profileChanged: !!t.profileChanged }); }
    const SLIDERS = [ { l: '감마', k: P.V_GAMMA, min: 0.5, max: 2.5, s: 0.05, f: v => v.toFixed(2) }, { l: '대비', k: P.V_CONTR, min: 0.5, max: 2.0, s: 0.05, f: v => v.toFixed(2) }, { l: '밝기', k: P.V_BRIGHT, min: -50, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '채도', k: P.V_SAT, min: 0, max: 200, s: 5, f: v => v.toFixed(0) }, { l: '샤프 윤곽', k: P.V_SHARP, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '샤프 디테일', k: P.V_SHARP2, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '명료', k: P.V_CLARITY, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }, { l: '색온도', k: P.V_TEMP, min: -25, max: 25, s: 1, f: v => v.toFixed(0) }, { l: '그레인', k: P.V_DITHER, min: 0, max: 100, s: 5, f: v => v.toFixed(0) }, { l: '오디오', k: P.A_BST, min: 0, max: 12, s: 1, f: v => `+${v}dB` }, { l: '톤 강도', k: P.V_TONE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) }, { l: 'AE 강도', k: P.V_AE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) } ];
    const getUiRoot = () => { const fs = document.fullscreenElement || document.webkitFullscreenElement; return fs ? (fs.tagName === 'VIDEO' ? (fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement) : fs) : (document.body || document.documentElement); };
    const renderChoiceRow = (label, items, key) => { const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label)); items.forEach(it => { const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.t); b.onclick = () => { const cur = sm.get(key); if (key === P.V_AE_PROFILE) { if (!sm.get(P.V_AE)) setAndHint(P.V_AE, true, true); setAndHint(P.V_AE_PROFILE, it.v === 'auto' ? 'auto' : (cur === it.v ? 'standard' : it.v), true); return; } if (key === P.V_TONE_PRE) { setAndHint(P.V_TONE_PRE, (cur === it.v) ? null : it.v, true); return; } }; if (key === P.V_AE_PROFILE) { const updateAeState = () => { b.classList.toggle('active', !!sm.get(P.V_AE) && sm.get(P.V_AE_PROFILE) === it.v); }; sub(P.V_AE, updateAeState); sub(P.V_AE_PROFILE, updateAeState); updateAeState(); } else { sub(key, v => b.classList.toggle('active', v === it.v)); b.classList.toggle('active', sm.get(key) === it.v); } r.append(b); }); return r; };
    const renderPresetRow = (label, items, key) => { const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label)); items.forEach(it => { const val = (it.l || it.txt), b = h('button', { class: 'pbtn', style: 'flex:1' }, val); b.onclick = () => setAndHint(key, val, true); sub(key, v => b.classList.toggle('active', v === val)); b.classList.toggle('active', sm.get(key) === val); r.append(b); }); const offVal = (key === P.V_PRE_B) ? 'brOFF' : 'off', off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF'); off.onclick = () => setAndHint(key, offVal, true); sub(key, v => off.classList.toggle('active', v === 'off' || v === 'brOFF')); off.classList.toggle('active', sm.get(key) === 'off' || sm.get(key) === 'brOFF'); r.append(off); return r; };
    const renderSlider = (cfg) => { const valEl = h('span', { style: 'color:#3498db' }, '0'), inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s }); const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; }; sub(cfg.k, update); update(sm.get(cfg.k)); inp.oninput = () => { const nv = Number(inp.value); valEl.textContent = cfg.f(nv); setAndHint(cfg.k, nv, true); }; return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp); };
    
    const build = () => {
      if (container) return; const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
      // ✅ Removed .pip-btn CSS coloring rule
      const style = `.main { position: fixed; top: 50%; right: 70px; transform: translateY(-50%); width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; } .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 2px solid #444; position: sticky; top: -15px; background: #191919; z-index: 2; padding-top: 5px; } .tab { flex: 1; padding: 12px; background: #222; border: 0; color: #999; cursor: pointer; border-radius: 10px 10px 0 0; font-weight: bold; font-size: 13px; } .tab.active { background: #333; color: #3498db; border-bottom: 3px solid #3498db; } .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; } .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; } .btn.active { background: #3498db; color: white; border-color: #2980b9; } .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; } .pbtn.active { background: #e67e22; color: white; border-color: #d35400; } .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12px; row-gap: 8px; margin-top: 8px; } .slider { display: flex; flex-direction: column; gap: 4px; color: #ccc; } .slider label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 500; } input[type=range] { width: 100%; accent-color: #3498db; cursor: pointer; height: 24px; margin: 4px 0; } .monitor { font-size: 12px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 8px; margin-top: 12px; } hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }`;
      
      const bodyMain = h('div', { id: 'p-main' }, [
        // ✅ Layout updated as requested, PiP uses normal class
        h('div', { class: 'prow' }, [
           h('button', { id: 'ae-btn', class: 'btn', onclick: () => { if (sm.get(P.V_AE)) { setAndHint(P.V_AE, false, true); } else { setAndHint(P.V_AE, true, true); if(!sm.get(P.V_AE_PROFILE)) setAndHint(P.V_AE_PROFILE, 'auto', true); } } }, '🤖 자동'),
           h('button', { id: 'boost-btn', class: 'btn', onclick: () => setAndHint(P.A_EN, !sm.get(P.A_EN), true) }, '🔊 부스트')
        ]),
        h('div', { class: 'prow' }, [
           h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if(!v) return; if(document.pictureInPictureElement){ await exitPiP(); }else{ await enterPiP(v); } } }, '📺 PiP 모드'),
           h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
           h('button', { id: 'pwr-btn', class: 'btn', onclick: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT), true) }, '⚡ Power')
        ]),
        renderChoiceRow('AE', [ { t: PRESETS.aeProfiles.auto.label, v: 'auto' }, { t: PRESETS.aeProfiles.standard.label, v: 'standard' }, { t: PRESETS.aeProfiles.bright.label, v: 'bright' }, { t: PRESETS.aeProfiles.cinemaHdr.label, v: 'cinemaHdr' } ], P.V_AE_PROFILE),
        renderChoiceRow('톤', Object.entries(PRESETS.tone).map(([id, o]) => ({ t:o.label, v:id })), P.V_TONE_PRE),
        renderPresetRow('샤프', Object.keys(PRESETS.detail).filter(k=>k!=='off').map(l => ({ l })), P.V_PRE_S), renderPresetRow('밝기', Object.keys(PRESETS.grade).filter(k=>k!=='brOFF').map(txt => ({ txt })), P.V_PRE_B), h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => setAndHint(P.PB_RATE, s, true); sub(P.PB_RATE, v => b.classList.toggle('active', Math.abs(v - s) < 0.01)); b.classList.toggle('active', Math.abs((sm.get(P.PB_RATE) || 1) - s) < 0.01); return b; }))
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
    window.addEventListener('keydown', (e) => { if (!(e && e.altKey && e.shiftKey && e.code === 'KeyV')) return; const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; if (!allowUiInThisDoc()) return; setAndHint(P.APP_UI, !sm.get(P.APP_UI), true); ensure(); scheduler.request(true); }, true);
    return { ensure, update: (text, isAE) => { if (monitorEl && sm.get(P.APP_UI)) { monitorEl.textContent = text; monitorEl.style.color = isAE ? "#2ecc71" : "#aaa"; } }, destroy: () => { for (const off of unsubs) { try { off(); } catch(_){} } unsubs.length = 0; detachNodesHard(); } };
  }

  function createUIFactory(enableUI) { return enableUI ? ((sm, defaults, config, registry, scheduler, bus) => createUI(sm, defaults, config, registry, scheduler, bus)) : createNoopUI; }

  function createAppController({ Store, Registry, Scheduler, Bus, Filters, Audio, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting, enableUI }) {
    if (enableUI) { UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); }); }
    let __lockStart = 0, __lockDur = 0, __lockAmp = 0;
    function bumpUserLock(now, ms, amp) { if (!ms || ms <= 0 || !amp || amp <= 0) return; const a = Utils.clamp(+amp, 0, 1), d = Math.max(0, ms | 0); if (__lockDur <= 0 || (now - __lockStart) > __lockDur) { __lockStart = now; __lockDur = d; __lockAmp = a; } else { const left = (__lockStart + __lockDur) - now; __lockStart = now; __lockDur = Math.max(left * 0.35 + d, d); __lockAmp = Math.max(__lockAmp * 0.65, a); } }
    function getUserLock01(now) { if (__lockDur <= 0) return 0; return Utils.clamp(1 - (now - __lockStart) / __lockDur, 0, 1) * __lockAmp; }
    Bus.on('signal', (s) => { const wantAE = FEATURES.ae(), aeUnavailable = !!(Store.getCat('video')?.[VSCX.aeUnavailable]), now = performance.now(); if (s.userLockMs) bumpUserLock(now, s.userLockMs, s.userLockAmp); if (s.profileChanged) AE?.hintProfileChanged?.(); if (wantAE && !aeUnavailable) { if ((s.aeLevel | 0) >= 2) AE.userTweak?.(); if ((s.aeLevel | 0) >= 1) AE.wake?.(); } if (s.forceApply) Scheduler.request(true); });
    const __aeMix = { expMix: 1, toneMix: 1 };
    const __vfEff = { ...DEFAULTS.video }, __aeOut = { gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5, mid: 0, clipFrac: 0, rd: 0 }, __vVals = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, mid: 0, sharp: 0, sharp2: 0, clarity: 0, dither: 0, temp: 0, toe: 0, shoulder: 0 };
    let lastSRev = -1, lastRRev = -1, lastAeRev = -1, lastPrune = 0, aeRev = 0, currentAE = { ...__aeOut };
    const onAE = (ae) => { currentAE = ae; aeRev++; Scheduler.request(false); }; if (AE && AE.__setOnAE) AE.__setOnAE(onAE);
    const restoreRateOne = (el) => { try { const st = el[VSCX.rateState]; if (st?.orig != null) el.playbackRate = st.orig; if (st) st.orig = null; } catch (_) {} };
    const onEvictVideo = (v) => { try { Filters.clear(v); restoreRateOne(v); } catch (_) {} };
    const cleanupTouched = (TOUCHED) => { for (const v of TOUCHED.videos) onEvictVideo(v); TOUCHED.videos.clear(); };
    const getRateState = (v) => { let st = v[VSCX.rateState]; if (!st) st = v[VSCX.rateState] = { orig: null, lastSetAt: 0 }; return st; };
    const bindVideoOnce = (v) => { if (v[VSCX.bound]) return; v[VSCX.bound] = true; v.addEventListener('seeking', () => Bus.signal({ aeLevel: 1 }), { passive: true }); v.addEventListener('play', () => Bus.signal({ aeLevel: 1 }), { passive: true }); v.addEventListener('ratechange', () => { const st = getRateState(v), now = performance.now(); if (now - st.lastSetAt < 90) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) Store.set(P.PB_RATE, cur); }, { passive: true }); };
    const __urlByDocVideo = new Map();
    const applyVideoFilters = (applySet, dirtyVideos, vVals, activeFx) => { for (const el of dirtyVideos) { if (!el || el.tagName !== 'VIDEO') continue; if (!activeFx || el[VSCX.visible] === false) { try { Filters.clear(el); } catch (_) {} } } if (!activeFx) return; __urlByDocVideo.clear(); for (const el of applySet) { if (!el || el.tagName !== 'VIDEO' || el[VSCX.visible] === false) continue; const doc = el.ownerDocument || document; let url = __urlByDocVideo.get(doc); if (url === undefined) { url = Filters.prepareCached(doc, vVals); __urlByDocVideo.set(doc, url); } Filters.applyUrl(el, url); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); bindVideoOnce(el); } };
    const applyPlaybackRate = (applySet, dirtyVideos, desiredRate, active) => { for (const v of TOUCHED.videos) { if (!v || v.tagName !== 'VIDEO') continue; if (!(active && applySet.has(v) && v[VSCX.visible] !== false)) restoreRateOne(v); } for (const el of dirtyVideos) { if (!el || el.tagName !== 'VIDEO') continue; if (!active || el[VSCX.visible] === false) restoreRateOne(el); } if (!active) return; for (const v of applySet) { if (!v || v.tagName !== 'VIDEO' || v[VSCX.visible] === false) continue; const st = getRateState(v); if (st.orig == null) st.orig = v.playbackRate; if (Math.abs(v.playbackRate - desiredRate) > 0.01) { st.lastSetAt = performance.now(); try { v.playbackRate = desiredRate; } catch (_) {} } bindVideoOnce(v); } };
    let __activeTarget = null, __pendingTarget = null, __pendingSince = 0, __lastSwitchT = 0, __lastHadAnyT = 0;
    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCat('app').active;
        if (!active) { cleanupTouched(TOUCHED); Audio.update(); AE.stop?.(); if (enableUI) UI.update('OFF', false); return; }
        const sRev = Store.rev(), rRev = Registry.rev();
        if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev) return;
        lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev;
        const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }
        const userLock01 = getUserLock01(now); AE.setUserLock01?.(userLock01);
        const vf0 = Store.getCat('video'), wantAE = FEATURES.ae(), aeUnavailable = !!(Store.getCat('video')?.[VSCX.aeUnavailable]), wantAudio = FEATURES.audio(), { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
        const pick = Targeting.pickDetailed(visible.videos, window.__lastUserPt, wantAudio); let cand = pick.target; const clickT = (window.__lastClickT != null) ? window.__lastClickT : (window.__lastUserPt?.t || 0), userForced = !!(cand && cand === window.__lastClickedVideo && (now - clickT) < 1800);
        if (!cand) { if (__activeTarget && (now - __lastHadAnyT) < 1100) cand = __activeTarget; } else { __lastHadAnyT = now; }
        const switchTo = (next) => { __activeTarget = next; __pendingTarget = null; __pendingSince = 0; __lastSwitchT = now; };
        if (cand !== __activeTarget) {
          const coolOk = (now - __lastSwitchT) > 900, strong = (pick.delta != null) && (pick.delta > 1.80);
          if (userForced || (strong && coolOk)) { switchTo(cand); if (wantAE && !aeUnavailable && __activeTarget) AE.setTarget(__activeTarget, { keepGain: true, softReset: true }); }
          else { if (__pendingTarget !== cand) { __pendingTarget = cand; __pendingSince = now; } if ((now - __pendingSince) > 720 && coolOk) { switchTo(cand); if (wantAE && !aeUnavailable && __activeTarget) AE.setTarget(__activeTarget, { keepGain: true, softReset: true }); } else { cand = __activeTarget; } }
        } else { __pendingTarget = null; __pendingSince = 0; }
        const aeShouldRun = !!(__activeTarget && wantAE && !aeUnavailable);
        if (aeShouldRun) { AE.setTarget(__activeTarget, { keepGain: true, softReset: false }); AE.start(); } else { AE.stop?.(); }
        if (wantAudio || Audio.hasCtx?.() || Audio.isHooked?.()) Audio.setTarget(__activeTarget || null); else Audio.setTarget(null);
        Audio.update();
        let vfEff = vf0; if (vf0.tonePreset && vf0.tonePreset !== 'neutral') { const tEff = computeToneStrengthEff(vf0, wantAE ? currentAE : null, Utils, userLock01); for (const k in __vfEff) __vfEff[k] = vf0[k]; __vfEff.toneStrength = tEff; vfEff = __vfEff; }
        const aeMeta = (wantAE && !aeUnavailable && AE.getMeta) ? AE.getMeta() : { profileResolved: (Store.get(P.V_AE_PROFILE) || 'standard'), hiRisk: 0 };
        computeAeMix3Into(__aeMix, vfEff, aeMeta, Utils, userLock01);
        const aeStr = Utils.clamp(vfEff.aeStrength ?? 1.0, 0, 1); let expMix = __aeMix.expMix * aeStr, toneMix = __aeMix.toneMix * aeStr;
        let aeOut = null; if ((wantAE && !aeUnavailable) ? currentAE : null) { const raw = currentAE; __aeOut.gain = Math.pow(2, Math.log2(Math.max(1e-6, raw.gain ?? 1)) * expMix); __aeOut.gammaF = 1; __aeOut.brightAdd = (raw.brightAdd ?? 0) * expMix; __aeOut.tempAdd = raw.tempAdd ?? 0; __aeOut.conF = 1 + ((raw.conF ?? 1) - 1) * toneMix; __aeOut.satF = 1 + ((raw.satF ?? 1) - 1) * toneMix; __aeOut.mid = (raw.mid ?? 0) * toneMix; __aeOut.toe = (raw.toe ?? 0) * toneMix; __aeOut.shoulder = (raw.shoulder ?? 0) * toneMix; __aeOut.hiRisk = raw.hiRisk ?? 0; __aeOut.cf = raw.cf ?? 0.5; __aeOut.luma = raw.luma ?? 0; __aeOut.clipFrac = raw.clipFrac ?? 0; __aeOut.rd = raw.rd ?? 0; aeOut = __aeOut; }
        composeVideoParamsInto(__vVals, vfEff, aeOut, Utils, aeMeta?.profileResolved || null);
        const videoFxOn = !isNeutralVideoParams(__vVals);
        if (enableUI && Store.getCat('app').uiVisible) { if (wantAE && !aeUnavailable) UI.update(`AE(${aeMeta.profileResolved}): ${__vVals.gain.toFixed(2)}x L:${Math.round(currentAE.luma || 0)}%`, true); else UI.update(`Ready (${CONFIG.VERSION})`, false); }
        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL); const extraApplyTopK = Store.get(P.APP_EXTRA_TOPK) | 0;
        const applySet = Targeting.buildApplySetReuse(visible.videos, __activeTarget, extraApplyTopK, applyToAllVisibleVideos, window.__lastUserPt, wantAudio);
        applyVideoFilters(applySet, vidsDirty, __vVals, videoFxOn);
        for (const v of TOUCHED.videos) { if (!v || !v.isConnected) { TOUCHED.videos.delete(v); continue; } const shouldHave = videoFxOn && applySet.has(v) && v[VSCX.visible] !== false; if (!shouldHave) { try { Filters.clear(v); } catch (_) {} TOUCHED.videos.delete(v); } }
        const desiredRate = Store.get(P.PB_RATE), pbActive = active && Math.abs((desiredRate || 1) - 1.0) > 0.01;
        applyPlaybackRate(applySet, vidsDirty, desiredRate, pbActive);
        if (enableUI && (force || vidsDirty.size)) UI.ensure();
      } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch(_) {} }
    });
    let tickTimer = 0; const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    const refreshTick = () => { (FEATURES.ae() || FEATURES.audio()) ? startTick() : stopTick(); };
    Store.sub(P.V_AE, refreshTick); Store.sub(P.A_EN, refreshTick); Store.sub(P.APP_ACT, refreshTick); refreshTick();
    Scheduler.request(true);
    return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, destroy() { stopTick(); try { UI.destroy?.(); } catch (_) {} try { AE.stop?.(); } catch (_) {} try { Audio.setTarget(null); } catch (_) {} } });
  }

  const Utils = createUtils(), Scheduler = createScheduler(16), Store = createLocalStore(DEFAULTS, Scheduler, Utils), Bus = createEventBus();
  function normalizeAeProfile(sm) { if (sm.get(P.V_AE)) { const prof = sm.get(P.V_AE_PROFILE); if (!prof || prof === '') sm.set(P.V_AE_PROFILE, 'auto'); if (prof && prof !== 'auto' && prof !== 'standard' && prof !== 'bright' && prof !== 'cinemaHdr') { sm.set(P.V_AE_PROFILE, 'standard'); } } }
  Store.sub(P.V_AE, () => normalizeAeProfile(Store)); Store.sub(P.V_AE_PROFILE, () => normalizeAeProfile(Store));
  const FEATURES = { active: () => Store.get(P.APP_ACT), ae: () => { if (!(Store.get(P.APP_ACT) && Store.get(P.V_AE))) return false; return Utils.clamp(Store.get(P.V_AE_STR) ?? 1.0, 0, 1) > 0.02; }, audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN) };
  const Registry = createRegistry(Scheduler, FEATURES), Targeting = createTargeting({ Utils });
  (function ensureRegistryAfterBodyReady() { const run = () => { try { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } catch (_) {} }; if (document.body) { run(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); run(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} document.addEventListener('DOMContentLoaded', () => run(), { once: true }); })();
  
  const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID }), Audio = createAudio(Store), AE = createAE(Store, { IS_MOBILE: CONFIG.IS_MOBILE, Utils }, null);
  const makeUI = createUIFactory(ENABLE_UI), UI = makeUI(Store, DEFAULTS, { IS_TOP: CONFIG.IS_TOP }, Registry, Scheduler, Bus);

  window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 }; 
  window.__lastClickedVideo = null; window.__lastClickT = 0;
  function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
  window.addEventListener('pointerdown', (e) => { const now = performance.now(); updateLastUserPt(e.clientX, e.clientY, now); window.__lastClickT = now; const el = document.elementFromPoint(e.clientX, e.clientY); const v = el?.closest?.('video'); if (v) window.__lastClickedVideo = v; }, { passive: true });
  window.addEventListener('wheel', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); }, { passive: true });
  window.addEventListener('keydown', () => { updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now()); }, { passive: true });
  window.addEventListener('resize', () => { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now); }, { passive: true });

  const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Bus, Filters, Audio, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting, enableUI: ENABLE_UI });
  window.__VSC_APP__ = __VSC_APP__;

  window.addEventListener('keydown', async (e) => {
    if (!(e.altKey && e.shiftKey && e.code === 'KeyP')) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const v = window.__VSC_APP__?.getActiveVideo(); if (!v) return;
    if (document.pictureInPictureElement === v) { await exitPiP(); return; }
    await enterPiP(v);
  }, true);

  let __vscLastUserGestureAt = 0;
  let __vscAutoPiPEnabled = true;
  ['pointerdown', 'keydown'].forEach(type => {
    window.addEventListener(type, () => { __vscLastUserGestureAt = performance.now(); }, { passive: true, capture: true });
  });

  document.addEventListener('visibilitychange', async () => {
    if (!__vscAutoPiPEnabled) return;
    if (document.visibilityState !== 'hidden') return;
    const v = window.__VSC_APP__?.getActiveVideo();
    if (!v || v.paused || v.ended) return; 
    if (document.pictureInPictureElement === v) return;
    const recentGesture = (performance.now() - __vscLastUserGestureAt) < 10000;
    if (!recentGesture) return;
    try { await enterPiP(v); } catch (_) {}
  }, true);

})();
