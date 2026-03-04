// ==UserScript==
// @name         Video_Control (v178.6.1 - Clean YCbCr USM)
// @namespace    https://github.com/
// @version      178.6.1
// @description  Video Control: Pure YCbCr Sharpness, Dynamic QS, Web Worker Auto Scene. Lightweight & Fast.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://poooo.ml/*
// @exclude      *://tvwiki*.net/*
// @exclude      *://tvmon.site/*
// @exclude      *://tvhot.store/*
// @exclude      *://claude.ai/*
// @exclude      *://arena.ai/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @allFrames    true
// ==/UserScript==

(function () {
'use strict';

function VSC_MAIN() {
  if (location.protocol === 'about:' || location.protocol === 'javascript:') return;
  const VSC_BOOT_KEY = Symbol.for('VSC_BOOT_LOCK');
  if (window[VSC_BOOT_KEY]) return;
  window[VSC_BOOT_KEY] = true;

  const VSC_NS_NEW = Symbol.for('__VSC__');
  const VSC_NS_OLD = Symbol.for('__VSC_171__');
  if (!window[VSC_NS_NEW] && window[VSC_NS_OLD]) window[VSC_NS_NEW] = window[VSC_NS_OLD];
  if (!window[VSC_NS_NEW]) window[VSC_NS_NEW] = {};
  const __vscNs = window[VSC_NS_NEW];
  __vscNs.__version = '178.6.1'; // ✅ 버전 업데이트

  const SYS = Object.freeze({ WFC: 5000, SRD: 220 });
  const TOE_DIVISOR = 12;

  // ✅ FLAGS 상단 배치 및 신규 옵션 추가 (Fix 7, 13, 14, 24)
  const FLAGS = Object.freeze({
    SCHED_ALIGN_TO_VIDEO_FRAMES: false,
    SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO: false,
    AUTO_SCENE_LAZY_ANALYZER: true,
    AUTO_SCENE_ALLOW_MAINTHREAD_FALLBACK: true,
    AUTO_SCENE_RELEASE_ANALYZER_ON_STOP: false,
    AUTO_SCENE_ADAPTIVE_FPS: false,
    FILTER_REAPPLY_NO_FORCED_LAYOUT: true,
    PATCH_ATTACH_SHADOW: true,
    FILTER_SHARP_SAT_COMP: false,
    UI_EXPENSIVE_SHADOW_PROBE: false,     // [Fix 7] 무거운 전체 돔 탐색 기본 OFF
    EXPOSE_API_TO_PAGE: true,             // [Fix 13] 외부 페이지 변조 방지용 플래그
    FILTER_FORCE_OPAQUE_BG: true          // [Fix 14] 투명 배경 강제 덮어쓰기 옵션
  });

  // ✅ [Fix 13] 플래그에 따른 unsafeWindow API 노출 제어
  try {
    if (FLAGS.EXPOSE_API_TO_PAGE) {
      (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__VSC__ = __vscNs;
    }
  } catch (_) {}

  if (__vscNs && __vscNs.__alive) {
    try { __vscNs.App?.destroy?.(); } catch (_) {}
    try { __vscNs.Store?.destroy?.(); } catch (_) {}
    try { __vscNs.AutoScene?.destroy?.(); } catch (_) {}
  }
  __vscNs.__alive = true;

  let __vscUserSignalRev = 0;

  const safe = (fn) => { try { fn(); } catch (_) {} };
  const OPT_P = { passive: true };
  const OPT_PC = { passive: true, capture: true };

  const VSC_SYM = Symbol.for('__VSC__');
  const getNS = () => (window && window[VSC_SYM]) || __vscNs || null;
  const getFLAGS = () => getNS()?.FLAGS || FLAGS;

  function isEditableTarget(t) {
    try {
      if (!t) return false;
      let el = t;
      if (el.nodeType === 3) el = el.parentElement;
      if (!el || el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable || el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')) return true;
      const role = el.getAttribute('role') || el.closest('[role]')?.getAttribute('role');
      if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
      if (el.closest('[data-editor],[data-editable],[aria-multiline="true"]')) return true;
      return false;
    } catch (_) { return false; }
  }

  const __globalHooksAC = new AbortController();
  const __globalSig = __globalHooksAC.signal;

  // ✅ [Fix 2] on() 함수 fallback 경로에서 리스너 누수 방지
  function on(target, type, fn, opts = {}) {
    if (!target?.addEventListener) return;

    const merged = { ...opts };
    const sig = merged.signal || __globalSig;
    const cap = !!merged.capture;

    try {
      target.addEventListener(type, fn, { ...merged, signal: sig });
      return;
    } catch (_) {}

    try {
      const { signal, ...noSig } = merged;
      target.addEventListener(type, fn, noSig);

      // fallback: signal 미지원 환경에서도 abort 시 수동으로 이벤트 제거
      if (sig && typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', () => {
          try { target.removeEventListener(type, fn, noSig); }
          catch (_) { try { target.removeEventListener(type, fn, cap); } catch (__) {} }
        }, { once: true });
      }
      return;
    } catch (_) {}

    try { target.addEventListener(type, fn, cap); } catch (_) {}
  }

  function combineSignals(...signals) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    const ac = new AbortController();
    for (const sig of signals) {
      if (sig.aborted) { ac.abort(sig.reason ?? 'AbortError'); return ac.signal; }
      sig.addEventListener('abort', () => { if (!ac.signal.aborted) ac.abort(sig.reason ?? 'AbortError'); }, { once: true });
    }
    return ac.signal;
  }

  let shadowEmitterInstalled = false;
  const __shadowRootCallbacks = new Set();
  const notifyShadowRoot = (sr) => { for (const cb of __shadowRootCallbacks) safe(() => cb(sr)); };

  function installShadowRootEmitterIfNeeded() {
    if (shadowEmitterInstalled) return;
    shadowEmitterInstalled = true;

    if (getFLAGS().PATCH_ATTACH_SHADOW === false) return;

    const PATCH_MARK = Symbol.for('__VSC_ATTACHSHADOW_PATCH__');
    const proto = Element.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    if (!desc || typeof desc.value !== 'function') return;
    if (desc.value[PATCH_MARK]) return;

    const orig = desc.value;
    if (!__vscNs._origAttachShadow) __vscNs._origAttachShadow = orig;

    const patched = function(init) {
      const sr = orig.call(this, init);
      queueMicrotask(() => notifyShadowRoot(sr));
      return sr;
    };

    Object.defineProperty(patched, PATCH_MARK, { value: true });
    Object.defineProperty(patched, '__vsc_orig', { value: orig });

    try { Object.defineProperty(proto, 'attachShadow', { ...desc, value: patched }); }
    catch (_) { try { proto.attachShadow = patched; } catch (__) {} }

    if (typeof HTMLTemplateElement !== 'undefined') {
      queueMicrotask(() => {
        try {
          const allWithShadow = document.querySelectorAll('[shadowrootmode]');
          for (const el of allWithShadow) { const host = el.parentElement; if (host?.shadowRoot) notifyShadowRoot(host.shadowRoot); }
        } catch (_) {}
      });
    }

    function deferredShadowProbe() {
      const PROBE_SELECTORS = ['video', 'object', 'embed', 'iframe', '[class*=player]', '[class*=Player]', '[class*=video]', '[class*=Video]', '[id*=player]', '[id*=Player]', '[id*=video]', '[id*=Video]', '[data-module]', '.vp_video', '.html5-vpl_w', '[is]'];
      const MAX_DEPTH = 8;
      const visited = new WeakSet();
      function probeShadowRoots(root, depth) {
        if (!root || depth > MAX_DEPTH || visited.has(root)) return;
        visited.add(root);
        let candidates;
        try { candidates = root.querySelectorAll?.(PROBE_SELECTORS.join(',')); } catch (_) { return; }
        if (!candidates) return;
        for (const el of candidates) {
          if (visited.has(el)) continue;
          visited.add(el);
          const sr = el.shadowRoot;
          if (!sr) continue;
          notifyShadowRoot(sr);
          probeShadowRoots(sr, depth + 1);
        }
      }
      const base = document.body || document.documentElement;
      if (base) probeShadowRoots(base, 0);
    }

    const scheduleProbe = () => {
      setTimeout(deferredShadowProbe, 1500);
      setTimeout(deferredShadowProbe, 4000);
      setTimeout(deferredShadowProbe, 10000);
    };
    if (document.readyState === 'complete') scheduleProbe();
    else window.addEventListener('load', scheduleProbe, { once: true });
  }

  __vscNs._restorePatchedGlobals = function() {
    const cur = Element.prototype.attachShadow;
    const PATCH_MARK = Symbol.for('__VSC_ATTACHSHADOW_PATCH__');
    const o = cur && cur.__vsc_orig;
    if (o && cur[PATCH_MARK]) {
      try {
        const d = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
        Object.defineProperty(Element.prototype, 'attachShadow', { ...(d || {}), value: o, configurable: true, writable: true });
      } catch (_) { try { Element.prototype.attachShadow = o; } catch (__) {} }
    }
  };

  function onPageReady(fn) {
    let ran = false; const ac = new AbortController();
    const run = () => { if (ran) return; ran = true; ac.abort(); safe(fn); };
    const check = () => {
      if ((document.readyState === 'interactive' || document.readyState === 'complete') && document.body) {
        run(); return true;
      }
      return false;
    };
    if (check()) return;
    const handler = () => { check(); };
    document.addEventListener('visibilitychange', handler, { passive: true, signal: ac.signal });
    document.addEventListener('DOMContentLoaded', handler, { once: true, signal: ac.signal });
    window.addEventListener('pageshow', handler, { passive: true, signal: ac.signal });
  }

  function detectMobile() {
    const uad = navigator.userAgentData;
    if (uad && typeof uad.mobile === 'boolean') return uad.mobile;
    try { if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true; } catch (_) {}
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  const DEBUG_BY_URL = /[?&]vsc_debug=1\b/.test(location.search);
  const CONFIG = Object.freeze({ IS_MOBILE: detectMobile(), VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""), DEBUG: DEBUG_BY_URL });
  const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));
  const clamp01 = (x) => VSC_CLAMP(x, 0, 1);
  const log = CONFIG.DEBUG ? { error: (...a) => console.error('[VSC]', ...a), warn: (...a) => console.warn('[VSC]', ...a), info: (...a) => console.info('[VSC]', ...a), debug: (...a) => console.debug('[VSC]', ...a) } : { error: (...a) => console.error('[VSC]', ...a), warn: (...a) => console.warn('[VSC]', ...a), info: () => {}, debug: () => {} };

  function tempToRgbGain(temp) {
    const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
    if (Math.abs(t) < 1e-4) return { rs: 1, gs: 1, bs: 1 };
    const r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t);
    const m = Math.max(r, g, b);
    return { rs: r / m, gs: g / m, bs: b / m };
  }

  let __vscLayoutRev = 0;
  const bumpLayoutRev = () => { __vscLayoutRev = (__vscLayoutRev + 1) | 0; };
  on(window, 'scroll', bumpLayoutRev, { passive: true, capture: true });
  on(window, 'resize', bumpLayoutRev, { passive: true });
  try {
    const vv = window.visualViewport;
    if (vv) { on(vv, 'scroll', bumpLayoutRev, { passive: true }); on(vv, 'resize', bumpLayoutRev, { passive: true }); }
  } catch (_) {}

  const videoStateMap = new WeakMap();

  const getVState = (v) => {
    let st = videoStateMap.get(v);
    if (!st) {
      st = {
        visible: false, rect: null, rectT: 0, _rectRev: -1, bound: false,
        applied: false, lastFilterUrl: null, rateState: null, desiredRate: undefined,
        audioFailUntil: 0, _ac: null, _lastSrc: '',
        origFilter: null, origFilterPrio: '',
        origWebkitFilter: null, origWebkitFilterPrio: '',
        filterRev: -1, _filterResRev: -1
      };
      videoStateMap.set(v, st);
    }
    return st;
  };

  const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });

  const PRESETS = Object.freeze({
    detail: { off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, sat: 1.0 }, S: { sharpAdd: 12, sharp2Add: 12, clarityAdd: 24, sat: 1.00 }, M: { sharpAdd: 24, sharp2Add: 24, clarityAdd: 36, sat: 1.00 }, L: { sharpAdd: 36, sharp2Add: 36, clarityAdd: 48, sat: 1.00 }, XL: { sharpAdd: 48, sharp2Add: 48, clarityAdd: 60, sat: 1.00 } },
    grade: { brOFF: { gammaF: 1.00, brightAdd: 0 }, S: { gammaF: 1.03, brightAdd: 2.0 }, M: { gammaF: 1.08, brightAdd: 5.0 }, L: { gammaF: 1.15, brightAdd: 9.0 }, DS: { gammaF: 1.05, brightAdd: 3.5 }, DM: { gammaF: 1.12, brightAdd: 7.5 }, DL: { gammaF: 1.22, brightAdd: 11.0 } }
  });

  const DEFAULTS = {
    video: { presetS: 'off', presetB: 'brOFF', shadowBandMask: 0, brightStepLevel: 0 },
    audio: { enabled: false, boost: 0, multiband: true, lufs: true, dialogue: false },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false }
  };

  const P = Object.freeze({
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced',
    V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel',
    A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  });

  const APP_SCHEMA = [ { type: 'bool', path: P.APP_ACT }, { type: 'bool', path: P.APP_UI }, { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV } ];
  const VIDEO_SCHEMA = [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 }, { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 } ];
  const AUDIO_PLAYBACK_SCHEMA = [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => 0 }, { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ];
  const ALL_SCHEMA = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];
  const ALL_KEYS = ALL_SCHEMA.map(s => s.path);

  const TOUCHED = { videos: new Set(), rateVideos: new Set() };
  const TOUCHED_MAX = 140;

  function touchedAdd(set, el) {
    if (!el) return;
    if (set.has(el)) set.delete(el);
    set.add(el);
    if (set.size > TOUCHED_MAX) {
      let checked = 0;
      for (const old of set) {
        if (checked++ > 20) break;
        if (!old.isConnected) {
          set.delete(old);
          if (set === TOUCHED.videos) __vscNs.Adapter?.clear(old);
          try { const rSt = getRateState(old); if (rSt && rSt.orig != null) { old.playbackRate = rSt.orig > 0 ? rSt.orig : 1.0; rSt.orig = null; } } catch (_) {}
          if (set.size <= TOUCHED_MAX) break;
        }
      }
      while (set.size > TOUCHED_MAX) {
        const old = set.keys().next().value;
        set.delete(old);
        if (set === TOUCHED.videos) __vscNs.Adapter?.clear(old);
        try { const rSt = getRateState(old); if (rSt && rSt.orig != null) { old.playbackRate = rSt.orig > 0 ? rSt.orig : 1.0; rSt.orig = null; } } catch (_) {}
      }
    }
  }

  function getRectCached(v, now, maxAgeMs = 800) {
    const st = getVState(v);
    let r = st.rect;
    if (r && st._rectRev === __vscLayoutRev) return r;
    const t0 = st.rectT || 0;
    if (!r || (now - t0) > maxAgeMs || st._rectRev !== __vscLayoutRev) {
      r = v.getBoundingClientRect();
      st.rect = r;
      st.rectT = now;
      st._rectRev = __vscLayoutRev;
    }
    return r;
  }

  function getViewportSnapshot() {
    const vv = window.visualViewport;
    if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 };
    return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
  }

  function createDebounced(fn, ms = 250) {
    let t = 0;
    const debounced = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    debounced.cancel = () => clearTimeout(t);
    return debounced;
  }

  // ✅ [Fix 8] SPA 전환 훅의 원복 로직 추가
  function initSpaUrlDetector(onChanged) {
    if (window[Symbol.for('__VSC_SPA_PATCHED__')]) return;
    window[Symbol.for('__VSC_SPA_PATCHED__')] = true;

    if (!__vscNs._origHistoryFns) {
      __vscNs._origHistoryFns = { pushState: history.pushState, replaceState: history.replaceState };
    }

    let lastHref = location.href;
    const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
    if (window.navigation && typeof window.navigation.addEventListener === 'function') { window.navigation.addEventListener('navigatesuccess', emitIfChanged); on(window, 'popstate', emitIfChanged, OPT_P); return; }

    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      if (orig.__vsc_wrapped) return;

      const wrapped = function (...args) {
        const ret = Reflect.apply(orig, this, args);
        queueMicrotask(emitIfChanged);
        return ret;
      };
      wrapped.__vsc_wrapped = true;
      wrapped.__vsc_orig = orig;

      try { Object.defineProperty(history, name, { value: wrapped, configurable: true, writable: true, enumerable: true }); }
      catch (_) { try { history[name] = wrapped; } catch (__) {} }
    };

    wrap('pushState'); wrap('replaceState');
    on(window, 'popstate', emitIfChanged, OPT_P);

    __vscNs._restoreHistory = () => {
      const o = __vscNs._origHistoryFns;
      if (!o) return;
      try { history.pushState = o.pushState; } catch (_) {}
      try { history.replaceState = o.replaceState; } catch (_) {}
    };
  }

  function createUtils() {
    const SVG_TAGS = new Set(['svg','defs','filter','feColorMatrix','feComponentTransfer','feFuncR','feFuncG','feFuncB','feGaussianBlur','feComposite']);
    return {
      clamp: VSC_CLAMP,
      h: (tag, props = {}, ...children) => {
        const isSvg = SVG_TAGS.has(tag) || props.ns === 'svg';
        const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
          else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
          else if (k === 'class') { el.className = v; }
          else if (v !== false && v != null && k !== 'ns') { el.setAttribute(k, v); }
        }
        children.flat().forEach(c => { if (c != null) el.append(c); });
        return el;
      }
    };
  }

  function createScheduler(minIntervalMs = 32) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
    let rvfcId = 0, rvfcTok = 0, rvfcVideo = null, getRvfcVideo = null;

    function cancelRvfc() {
      rvfcTok++;
      if (rvfcId && rvfcVideo && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
        try { rvfcVideo.cancelVideoFrameCallback(rvfcId); } catch (_) {}
      }
      rvfcId = 0; rvfcVideo = null;
    }

    function clearPending() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      cancelRvfc();
    }

    function run() {
      rafId = 0; queued = false;
      const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun;
      if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; }
      lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} }
    }

    function timerCb() { timer = 0; run(); }
    function queueRaf() { if (!rafId) rafId = requestAnimationFrame(run); }

    function queueRvfc() {
      const align = getFLAGS().SCHED_ALIGN_TO_VIDEO_FRAMES || !!getNS()?._schedAlignRvfc;
      if (!align || rvfcId) return false;

      const v = getRvfcVideo?.();
      if (!v || v.paused || v.ended || typeof v.requestVideoFrameCallback !== 'function') return false;

      const tok = ++rvfcTok;
      rvfcVideo = v;
      rvfcId = v.requestVideoFrameCallback(() => {
        if (tok !== rvfcTok) return;
        rvfcId = 0; rvfcVideo = null;
        run();
      });
      return true;
    }

    const request = (immediate = false) => {
      if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; }
      if (queued) return;
      queued = true; clearPending();
      if (!queueRvfc()) queueRaf();
    };

    return {
      registerApply: (fn) => { applyFn = fn; },
      request,
      setRvfcSource: (fn) => { getRvfcVideo = fn; },
      destroy: () => { clearPending(); applyFn = null; }
    };
  }

  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };

  function createLocalStore(defaults, scheduler, Utils) {
    const state = (typeof structuredClone === 'function') ? structuredClone(defaults) : JSON.parse(JSON.stringify(defaults));
    let rev = 0; const listeners = new Map();
    const storeAC = new AbortController();
    const storeSig = combineSignals(storeAC.signal, __globalSig);
    const PREF_KEY = 'vsc_prefs_' + location.hostname;

    function loadPrefs() {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(PREF_KEY, null); if (v) return v; } } catch (_) {}
      try { return localStorage.getItem(PREF_KEY); } catch (_) {}
      return null;
    }

    function savePrefsRaw(json) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(PREF_KEY, json); return true; } } catch (_) {}
      try { localStorage.setItem(PREF_KEY, json); return true; } catch (_) {}
      return false;
    }

    try {
      const saved = loadPrefs();
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.video) Object.assign(state.video, parsed.video);
        if (parsed.audio) Object.assign(state.audio, parsed.audio);
        if (parsed.playback) Object.assign(state.playback, parsed.playback);
        if (parsed.app) Object.assign(state.app, parsed.app);
      }
    } catch (_) {}

    let _saveFailCount = 0; let _lastSavedJson = ''; const MAX_SAVE_RETRIES = 5;

    function _doSave() {
      if (_saveFailCount >= MAX_SAVE_RETRIES) return;
      try {
        const json = JSON.stringify(state);
        if (json === _lastSavedJson) return;
        if (json.length > 8192) { log.warn('Settings too large, skipping save'); return; }
        if (!savePrefsRaw(json)) { _saveFailCount++; return; }
        _lastSavedJson = json; _saveFailCount = 0;
      } catch (e) {
        _saveFailCount++; if (_saveFailCount >= MAX_SAVE_RETRIES) log.warn('Settings save disabled');
      }
    }

    const savePrefs = createDebounced(() => { _doSave(); }, 1000);
    const onHiddenFlush = () => { if (document.visibilityState === 'hidden') { savePrefs.cancel(); _doSave(); } };

    on(document, 'visibilitychange', onHiddenFlush, { passive: true, signal: storeSig });
    on(window, 'beforeunload', () => { savePrefs.cancel(); _doSave(); }, { once: true, signal: storeSig });

    const emit = (path, val) => {
      const cbs = listeners.get(path); if (cbs) { for (const cb of cbs) safe(() => cb(val)); }
      const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) { for (const cb of cbsStar) safe(() => cb(val)); } }
    };
    const notifyChange = (path, val) => { rev++; emit(path, val); savePrefs(); scheduler.request(false); };

    return {
      state, rev: () => rev, getCatRef: (cat) => state[cat],
      get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; },
      set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); },
      batch: (cat, obj) => { let changed = false; for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); } } if (changed) { rev++; savePrefs(); scheduler.request(false); } },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); },
      destroy: () => { storeAC.abort(); savePrefs.cancel(); listeners.clear(); }
    };
  }

  function normalizeBySchema(sm, schema) {
    let changed = false;
    const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
    for (const { type, path, values, fallback, min, max, round } of schema) {
      switch (type) {
        case 'bool': set(path, !!sm.get(path)); break;
        case 'enum': { const cur = sm.get(path); if (!values.includes(cur)) set(path, fallback()); break; }
        case 'num': { let n = Number(sm.get(path)); if (!Number.isFinite(n)) n = fallback(); if (round) n = Math.round(n); set(path, Math.max(min, Math.min(max, n))); break; }
      }
    }
    return changed;
  }

  const PiPState = {
    window: null, video: null, placeholder: null, origParent: null, origCss: '', _ac: null, _watcherId: null,
    reset() {
      if (this._ac) { this._ac.abort(); this._ac = null; }
      if (this._watcherId) { clearInterval(this._watcherId); this._watcherId = null; }
      Object.assign(this, { window: null, video: null, placeholder: null, origParent: null, origCss: '', _ac: null, _watcherId: null });
    }
  };

  function checkAndCleanupClosedPiP() {
    if (PiPState.window && PiPState.window.closed && PiPState.video) {
      restoreFromDocumentPiP(PiPState.video);
    }
  }

  function startPiPWatcher() {
    if (PiPState._watcherId) return;
    PiPState._watcherId = setInterval(() => {
      if (!PiPState.window) { clearInterval(PiPState._watcherId); PiPState._watcherId = null; return; }
      checkAndCleanupClosedPiP();
    }, 1000);
  }

  function getActivePiPVideo() {
    if (PiPState.video && PiPState.window && !PiPState.window.closed) return PiPState.video;
    const el = document.pictureInPictureElement;
    return (el instanceof HTMLVideoElement) ? el : null;
  }

  function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

  async function enterDocumentPiP(video) {
    if (!video || video.readyState < 2) throw new Error('Video not ready');
    const wasPlaying = !video.paused;
    const nativeW = video.videoWidth || 0, nativeH = video.videoHeight || 0;
    const displayW = video.clientWidth || 0, displayH = video.clientHeight || 0;
    const targetW = nativeW > 0 ? Math.round(nativeW / 2) : (displayW > 0 ? displayW : 640);
    const targetH = nativeH > 0 ? Math.round(nativeH / 2) : (displayH > 0 ? displayH : 360);
    const maxW = Math.round(screen.availWidth * 0.5), maxH = Math.round(screen.availHeight * 0.5);
    const w = Math.max(320, Math.min(targetW, maxW)), h = Math.max(180, Math.min(targetH, maxH));

    const pipWindow = await window.documentPictureInPicture.requestWindow({ width: w, height: h });
    PiPState.window = pipWindow; PiPState.video = video; PiPState.origParent = video.parentNode; PiPState.origCss = video.style.cssText;
    PiPState.placeholder = document.createElement('div');

    const rect = video.getBoundingClientRect();
    const pw = rect.width || video.clientWidth || video.offsetWidth || 640;
    const ph = rect.height || video.clientHeight || video.offsetHeight || 360;

    Object.assign(PiPState.placeholder.style, {
      width: `${pw}px`, height: `${ph}px`, background: '#000',
      display: getComputedStyle(video).display || 'block', boxSizing: 'border-box'
    });
    PiPState.origParent?.insertBefore(PiPState.placeholder, video);

    try {
      const pipStyle = pipWindow.document.createElement('style');
      pipStyle.textContent = `*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; } body { background: #000; display: flex; justify-content: center; align-items: center; width: 100vw; height: 100vh; overflow: hidden; } video { width: 100%; height: 100%; object-fit: contain; }`;
      pipWindow.document.head.appendChild(pipStyle);
    } catch (_) {}

    Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain' });
    pipWindow.document.body.append(video);
    if (wasPlaying && video.paused) video.play().catch(() => {});

    const pipAC = new AbortController();
    pipWindow.addEventListener('click', () => { video.paused ? video.play()?.catch?.(() => {}) : video.pause(); }, { signal: pipAC.signal });
    pipWindow.addEventListener('pagehide', () => { pipAC.abort(); restoreFromDocumentPiP(video); }, { once: true });

    PiPState._ac = pipAC;
    startPiPWatcher();
    return true;
  }

  function restoreFromDocumentPiP(video) {
    if (!video) { PiPState.reset(); return; }
    if (PiPState.video !== video) return;
    const wasPlaying = !video.paused;
    let restored = false;

    try {
      video.style.cssText = PiPState.origCss || '';
      if (PiPState.placeholder?.parentNode?.isConnected) {
        PiPState.placeholder.parentNode.insertBefore(video, PiPState.placeholder);
        PiPState.placeholder.remove();
        restored = true;
      } else if (PiPState.origParent?.isConnected) {
        PiPState.origParent.appendChild(video);
        restored = true;
      } else {
        const selectors = '[class*=player],[class*=Player],[id*=player],[class*=video-container],[data-player]';
        const containers = document.querySelectorAll(selectors);
        for (const c of containers) {
          if (c.isConnected && !c.querySelector('video')) { c.appendChild(video); restored = true; break; }
        }
      }

      if (!restored) {
        log.warn('PiP restore: no suitable container — hiding video');
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
        (document.body || document.documentElement)?.appendChild(video);
        restored = true;

        const selectors = '[class*=player],[class*=Player],[id*=player],[class*=video-container],[data-player]';
        let retryId = 0;
        let retryCount = 0;
        const stopRetry = () => { if (retryId) { clearInterval(retryId); retryId = 0; } };

        const retryRestore = () => {
          try {
            const containers = document.querySelectorAll(selectors);
            for (const c of containers) {
              if (c.isConnected && !c.querySelector('video')) {
                video.style.cssText = PiPState.origCss || '';
                c.appendChild(video);
                stopRetry();
                safe(() => __vscNs.ApplyReq?.hard());
                return true;
              }
            }
          } catch (_) {}
          return false;
        };
        retryId = setInterval(() => { if (++retryCount > 10) { stopRetry(); return; } retryRestore(); }, 500);
      }
      if (restored && wasPlaying && video.paused) video.play().catch(() => {});
    } catch (e) {
      log.warn('PiP restore failed:', e);
    } finally {
      PiPState.reset();
      safe(() => __vscNs.ApplyReq?.hard());
    }
  }

  async function enterPiP(video) {
    if (!video || video.readyState < 2 || video.error || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE || video.disablePictureInPicture) return false;
    if (window.documentPictureInPicture?.requestWindow) {
      if (PiPState.window && !PiPState.window.closed) return true;
      try { return await enterDocumentPiP(video); } catch (e) { log.debug('Document PiP failed:', e.message); }
    }
    if (document.pictureInPictureElement === video) return true;
    if (typeof video.requestPictureInPicture === 'function') {
      try { await video.requestPictureInPicture(); return true; } catch (e) { log.debug('Legacy PiP failed:', e.message); }
    }
    return false;
  }

  async function exitPiP(preferredVideo = null) {
    if (PiPState.window) {
      const video = PiPState.video; const wasOpen = !PiPState.window.closed;
      if (video) restoreFromDocumentPiP(video);
      if (wasOpen && PiPState.window && !PiPState.window.closed) { try { PiPState.window.close(); } catch (_) {} }
      if (PiPState.window) PiPState.reset();
      return true;
    }
    if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); return true; } catch (_) {} }
    return false;
  }

  let _pipToggleLock = false;
  async function togglePiPFor(video) {
    if (!video || video.readyState < 2 || _pipToggleLock) return false;
    _pipToggleLock = true;
    try {
      const isInDocPiP = PiPState.window && !PiPState.window.closed && PiPState.video === video;
      const isInLegacyPiP = document.pictureInPictureElement === video;
      if (isInDocPiP || isInLegacyPiP) return await exitPiP(video);

      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} }
      if (PiPState.window && !PiPState.window.closed) {
        const prevVideo = PiPState.video;
        if (!PiPState.window.closed) PiPState.window.close();
        if (prevVideo) restoreFromDocumentPiP(prevVideo);
      }
      return await enterPiP(video);
    } finally { _pipToggleLock = false; }
  }

  function createZoomManager() {
    const stateMap = new WeakMap();
    let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    let touchListenersAttached = false;
    const zoomAC = new AbortController();

    const getSt = (v) => {
      let st = stateMap.get(v);
      if (!st) {
        st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '', origComputedPosition: '', _cachedPosition: null, _lastTransition: null };
        stateMap.set(v, st);
      }
      return st;
    };

    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active;
        if (st.scale <= 1) {
          if (st.zoomed) {
            v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = '';
            v.style.zIndex = st.origZIndex; v.style.position = st.origPosition;
            v.style.transition = ''; st.zoomed = false; st.origComputedPosition = '';
          }
          st.scale = 1; st.tx = 0; st.ty = 0;
        } else {
          if (!st.zoomed) {
            st.origZIndex = v.style.zIndex; st.origPosition = v.style.position;
            if (!st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
            st.origComputedPosition = st._cachedPosition; st.zoomed = true;
            if (st.origComputedPosition === 'static') v.style.position = 'relative';
          }
          const wantTransition = panning ? 'none' : 'transform 0.1s ease-out';
          if (st._lastTransition !== wantTransition) { v.style.transition = wantTransition; st._lastTransition = wantTransition; }
          v.style.transformOrigin = '0 0';
          v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
          v.style.cursor = panning ? 'grabbing' : 'grab';
          v.style.zIndex = '2147483646';
        }
      });
    };

    function clampPan(v, st) {
      const rect = getRectCached(v, performance.now(), 300);
      const scaledW = rect.width * st.scale, scaledH = rect.height * st.scale;
      const minVisibleFraction = 0.25;
      const minVisW = rect.width * minVisibleFraction, minVisH = rect.height * minVisibleFraction;
      const maxTx = rect.width - minVisW, minTx = -(scaledW - minVisW - rect.width);
      const maxTy = rect.height - minVisH, minTy = -(scaledH - minVisH - rect.height);
      st.tx = Math.max(Math.min(st.tx, maxTx), minTx);
      st.ty = Math.max(Math.min(st.ty, maxTy), minTy);
    }

    const zoomTo = (v, newScale, clientX, clientY) => {
      const st = getSt(v);
      if (!st.zoomed && !st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
      const rect = getRectCached(v, performance.now(), 150);
      const ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale;
      st.tx = clientX - (rect.left - st.tx) - ix * newScale;
      st.ty = clientY - (rect.top - st.ty) - iy * newScale;
      st.scale = newScale;
      update(v);
    };

    const resetZoom = (v) => { if (v) { const st = getSt(v); st.scale = 1; st._cachedPosition = null; st._lastTransition = null; update(v); } };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    function getTargetVideo(e) {
      if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
      const touch = e.touches?.[0];
      const cx = Number.isFinite(e.clientX) ? e.clientX : (touch && Number.isFinite(touch.clientX) ? touch.clientX : null);
      const cy = Number.isFinite(e.clientY) ? e.clientY : (touch && Number.isFinite(touch.clientY) ? touch.clientY : null);
      if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; }
      return __vscNs.App?.getActiveVideo() || null;
    }

    on(window, 'wheel', e => {
      const ns = window[Symbol.for('__VSC__')];
      if (!ns?.Store?.get(P.APP_ZOOM_EN)) return;
      if (!(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return;

      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v);
      let newScale = Math.min(Math.max(1, st.scale * delta), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true });

    on(window, 'mousedown', e => {
      if (!e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (st.scale > 1) {
        e.preventDefault(); e.stopPropagation();
        activeVideo = v; isPanning = true; st.hasPanned = false;
        startX = e.clientX - st.tx; startY = e.clientY - st.ty;
        update(v);
      }
    }, { capture: true });

    on(window, 'mousemove', e => {
      if (!isPanning || !activeVideo) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(activeVideo);
      const dx = e.clientX - startX - st.tx, dy = e.clientY - startY - st.ty;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
      st.tx = e.clientX - startX; st.ty = e.clientY - startY;
      clampPan(activeVideo, st); update(activeVideo);
    }, { capture: true });

    on(window, 'mouseup', e => {
      if (isPanning) {
        if (activeVideo) {
          const st = getSt(activeVideo);
          if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
          update(activeVideo);
        }
        isPanning = false; activeVideo = null;
      }
    }, { capture: true });

    on(window, 'dblclick', e => {
      if (!e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true });

    const touchstartHandler = (e) => {
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
      } else if (e.touches.length === 1 && st.scale > 1) {
        activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
      }
    };

    const touchmoveHandler = (e) => {
      if (!activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
        let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; isPanning = false; activeVideo = null; }
        else {
          zoomTo(activeVideo, newScale, center.x, center.y);
          st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
          clampPan(activeVideo, st); update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      } else if (isPanning && e.touches.length === 1) {
        if (e.cancelable) e.preventDefault();
        const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
        st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY;
        clampPan(activeVideo, st); update(activeVideo);
      }
    };

    const touchendHandler = (e) => {
      if (!activeVideo) return;
      if (e.touches.length < 2) pinchState.active = false;
      if (e.touches.length === 0) {
        if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) e.preventDefault();
        isPanning = false; update(activeVideo); activeVideo = null;
      }
    };

    const attachTouchListeners = () => {
      if (touchListenersAttached) return; touchListenersAttached = true;
      const sig = combineSignals(zoomAC.signal, __globalSig);
      on(window, 'touchstart', touchstartHandler, { passive: false, capture: true, signal: sig });
      on(window, 'touchmove', touchmoveHandler, { passive: false, capture: true, signal: sig });
      on(window, 'touchend', touchendHandler, { passive: false, capture: true, signal: sig });
    };

    const setEnabled = (en) => { if (en) attachTouchListeners(); };
    if (CONFIG.IS_MOBILE) { if (__vscNs.Store && __vscNs.Store.get(P.APP_ZOOM_EN)) attachTouchListeners(); } else { attachTouchListeners(); }

    return {
      resetZoom, zoomTo, isZoomed, setEnabled,
      destroy: () => {
        zoomAC.abort(); touchListenersAttached = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (activeVideo) {
          const st = getSt(activeVideo);
          if (st.zoomed) { activeVideo.style.transform = ''; activeVideo.style.transformOrigin = ''; activeVideo.style.cursor = ''; activeVideo.style.zIndex = st.origZIndex; activeVideo.style.position = st.origPosition; activeVideo.style.transition = ''; st.zoomed = false; }
        }
        isPanning = false; pinchState.active = false; activeVideo = null;
      }
    };
  }

  function createTargeting() {
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      const now = performance.now(); const vp = getViewportSnapshot();
      let best = null, bestScore = -Infinity;

      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;

        const r = getRectCached(v, now, 800);
        const area = (r?.width || 0) * (r?.height || 0);
        const pip = isPiPActiveVideo(v);
        const hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);

        if (!pip && !hasDecoded && area < 160 * 120) return;

        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;
        if (v.currentTime > 0.2) s += 2.0;
        s += Math.log2(1 + area / 20000) * 1.1;

        const ptAge = Math.max(0, now - (lastUserPt.t || 0)); const userBias = Math.exp(-ptAge / 1800);
        const dx = cx - lastUserPt.x, dy = cy - lastUserPt.y; s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500);
        const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);

        const isLikelyAd = (vid) => { const parent = vid.closest('[class*=ad],[class*=Ad],[id*=ad],[data-ad]'); if (parent) return true; if (r.width <= 400 && r.height <= 300 && vid.duration < 60) return true; return false; };
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
        if (isLikelyAd(v)) s -= 5.0; if (!v.controls && !v.closest('[class*=player]')) s -= 1.0;
        if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
        if (pip) s += 3.0;

        if (s > bestScore) { bestScore = s; best = v; }
      };

      for (const v of videos) evalScore(v);
      const activePip = getActivePiPVideo(); if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);

      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
        if (best && stickyTarget !== best && (bestScore < stickyScore + hysteresis)) { return { target: stickyTarget }; }
      }
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000;
      return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  function createRegistry(scheduler) {
    const videos = new Set(), visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    let __refreshQueued = false;

    function requestRefreshCoalesced() {
      if (__refreshQueued) return;
      __refreshQueued = true;
      requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); });
    }

    // ✅ [Fix 12] IntersectionObserver margin 상수화
    const IO_MARGIN_PX = 200;
    const ioMargin = `${IO_MARGIN_PX}px`;
    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el);
        st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now;
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
        st.rectT = now; dirty.videos.add(el); changed = true;
      }
      if (changed) requestRefreshCoalesced();
    }) : null;

    const MAX_SHADOW_OBS = 40;
    const observerMap = new Map();

    function untrackVideo(v) {
      if (!v || v.tagName !== 'VIDEO') return;
      if (videos.has(v)) videos.delete(v);
      visible.videos.delete(v);
      dirtyA.videos.delete(v);
      dirtyB.videos.delete(v);
      dirty.videos.add(v);
      safe(() => { io?.unobserve(v); ro?.unobserve(v); });
    }

    const connectObserver = (root) => {
      if (!root || observerMap.has(root)) return;
      if (root !== document && root.host && !root.host.isConnected) return;

      if (observerMap.size >= MAX_SHADOW_OBS) {
        const oldest = observerMap.keys().next().value;
        const moOld = observerMap.get(oldest);
        try { moOld.disconnect(); } catch (_) {}
        observerMap.delete(oldest);
      }

      const mo = new MutationObserver((muts) => {
        if (root !== document && root.host && !root.host.isConnected) { mo.disconnect(); observerMap.delete(root); return; }
        let touchedVideoTree = false;
        for (const m of muts) {
          if (m.addedNodes && m.addedNodes.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); } }
          if (m.removedNodes && m.removedNodes.length) {
            let changed = false;
            for (const n of m.removedNodes) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'VIDEO') { untrackVideo(n); changed = true; continue; }
              const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null;
              if (list && list.length) { for (let i = 0; i < list.length; i++) untrackVideo(list[i]); changed = true; }
            }
            if (changed) touchedVideoTree = true;
          }
        }
        if (touchedVideoTree) requestRefreshCoalesced();
      });
      mo.observe(root, { childList: true, subtree: true }); observerMap.set(root, mo); WorkQ.enqueue(root);
    };

    function lazyScanAncestorShadowRoots(videoEl) {
      let node = videoEl; let depth = 0;
      while (node && depth++ < 30) { const root = node.getRootNode?.(); if (root && root !== document && root.host) { connectObserver(root); node = root.host; } else { break; } }
    }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0); videos.add(el);
      if (wasEmpty) { queueMicrotask(() => { safe(() => __vscNs.UIEnsure?.()); }); }
      if (io) io.observe(el); else { const st = getVState(el); st.visible = true; if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } }
      if (ro) safe(() => ro.observe(el)); lazyScanAncestorShadowRoots(el);
    };

    const WorkQ = (() => {
      let active = [], pending = [], scheduled = false; const activeSet = new Set();
      function drainRunnerIdle(dl) { drain(dl); } function drainRunnerRaf() { drain(); }
      const schedule = () => {
        if (scheduled) return; scheduled = true;
        const postTask = globalThis.scheduler?.postTask;
        if (typeof postTask === 'function') {
          postTask(() => drain(), { priority: 'background' }).catch(() => {
            if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 });
            else requestAnimationFrame(drainRunnerRaf);
          });
          return;
        }
        if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 });
        else requestAnimationFrame(drainRunnerRaf);
      };
      const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; if (activeSet.has(n)) return; activeSet.add(n); pending.push(n); schedule(); };
      const scanNode = (n) => {
        if (!n) return;
        if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; }
        if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
      };
      const drain = (dl) => {
        scheduled = false; activeSet.clear(); [active, pending] = [pending, active]; pending.length = 0;
        const start = performance.now(); const isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling); let checkCount = 0;
        const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 && (++checkCount % 8 !== 0 || !(isInputPending?.())) : () => (performance.now() - start) < 6 && (++checkCount % 8 !== 0 || !(isInputPending?.()));
        for (let i = 0; i < active.length; i++) {
          if (!budget()) { for (let j = i; j < active.length; j++) { pending.push(active[j]); activeSet.add(active[j]); } active.length = 0; schedule(); return; }
          scanNode(active[i]);
        }
        active.length = 0;
      };
      return Object.freeze({ enqueue });
    })();

    const refreshObservers = () => { for (const mo of observerMap.values()) mo.disconnect(); observerMap.clear(); const root = document.body || document.documentElement; if (root) { WorkQ.enqueue(root); connectObserver(root); } };
    refreshObservers();
    __shadowRootCallbacks.add((sr) => { if (sr && (sr instanceof ShadowRoot || sr.nodeType === 11)) { connectObserver(sr); } });

    function pruneDisconnected(set, visibleSet, dirtySet, unobserveFn) {
      let removed = 0;
      for (const el of set) { if (!el?.isConnected) { set.delete(el); visibleSet.delete(el); dirtySet.delete(el); safe(() => unobserveFn(el)); safe(() => ro?.unobserve(el)); removed++; } }
      return removed;
    }

    return {
      videos, visible, rev: () => rev, refreshObservers,
      prune: () => {
        for (const [root, mo] of observerMap) {
          if (root === document) continue; const host = root.host;
          if (!host || !host.isConnected) {
            mo.disconnect(); observerMap.delete(root);
            for (const v of videos) { try { if (v.getRootNode() === root) { untrackVideo(v); } } catch (_) {} }
          }
        }
        const removed = pruneDisconnected(videos, visible.videos, dirtyA.videos, (el) => { if (io) io.unobserve(el); }); pruneDisconnected(videos, visible.videos, dirtyB.videos, () => {}); if (removed) rev++;
      },
      consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
      rescanAll: () => {
        const task = () => {
          try {
            const base = document.documentElement || document.body; if (!base) return;
            function* walkRoots(rootBase) { if (!rootBase) return; const stack = [rootBase]; while (stack.length > 0) { const r = stack.pop(); yield r; const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT); let node = walker.nextNode(); let depth = 0; while (node && depth++ < 50) { if (node.shadowRoot) stack.push(node.shadowRoot); node = walker.nextNode(); } } }
            for (const r of walkRoots(base)) WorkQ.enqueue(r);
          } catch (_) {}
        };
        setTimeout(task, 0);
      },
      destroy: () => { for (const mo of observerMap.values()) { try { mo.disconnect(); } catch (_) {} } observerMap.clear(); if (io) { try { io.disconnect(); } catch (_) {} } if (ro) { try { ro.disconnect(); } catch (_) {} } videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear(); }
    };
  }

  // --- PART 1 END ---
// --- PART 1 END ---
  let _softClipCurve = null;
  function getSoftClipCurve() {
    if (_softClipCurve) return _softClipCurve;
    const n = 1024, knee = 0.88, drive = 3.5, tanhD = Math.tanh(drive); const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x); curve[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh(drive * (ax - knee) / Math.max(1e-6, 1 - knee)) / tanhD); }
    _softClipCurve = curve; return curve;
  }
  function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); }
  const globalSrcMap = new WeakMap();

  function createAudio(sm) {
    let ctx, target = null, currentSrc = null, inputGain, dryGain, wetGain, masterOut, wetInGain, limiter, hpf, currentNodes = null;
    let makeupDbEma = 0, switchTimer = 0, switchTok = 0, gestureHooked = false, loopTok = 0, audioLoopTimerId = 0;

    // ✅ [PATCH 3-A] AudioContext visibility resume hook
    let _visResumeHooked = false;
    const _audioAC = new AbortController();
    const _audioSig = combineSignals(_audioAC.signal, __globalSig);

    function ensureVisibilityResumeHook() {
      if (_visResumeHooked) return;
      _visResumeHooked = true;

      on(document, 'visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!ctx) return;

        const st = ctx.state;
        if (st === 'suspended' || st === 'interrupted') {
          ctx.resume().catch(() => {});
        }
      }, { passive: true, signal: _audioSig });
    }

    const clamp = VSC_CLAMP;

    const stt = (param, val, t, tc = 0.08) => { if(param) { try { param.setTargetAtTime(val, t, tc); } catch (_) { param.value = val; } } };
    const mkBQ = (actx, type, freq, Q, gain) => { const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if(Q !== undefined) f.Q.value = Q; if(gain !== undefined) f.gain.value = gain; return f; };
    const mkComp = (actx, thr, knee, ratio, atk, rel) => { const c = actx.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel; return c; };

    const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') await ctx.resume(); if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
    const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; on(window, 'pointerdown', onGesture, OPT_PC); on(window, 'keydown', onGesture, OPT_PC); };

    function createDynamicCinemaEQ(actx) {
      const bands = { sub: mkBQ(actx, 'lowshelf', 80, 0.8, 0), impact: mkBQ(actx, 'peaking', 55, 1.2, 0), cut: mkBQ(actx, 'peaking', 300, 0.8, 0), voice: mkBQ(actx, 'peaking', 3200, 1.2, 0), air: mkBQ(actx, 'highshelf', 10000, 0.7, 0) };
      const input = actx.createGain(), output = actx.createGain(); chain(input, bands.sub, bands.impact, bands.cut, bands.voice, bands.air, output);
      const BASE_CINEMA = { sub: 3.0, impact: 2.0, cut: -2.0, voice: 2.0, air: -0.5 };
      const PROFILES = Object.freeze({ cinema: BASE_CINEMA, cinemaWithMultiband: Object.freeze({ sub: 1.5, impact: 1.0, cut: -2.0, voice: 1.5, air: -0.25 }), neutral: Object.freeze({ sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }) });
      let activeProfile = 'cinema', staticDialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 };
      const applyGains = () => { const profile = PROFILES[activeProfile] || PROFILES.neutral, t = actx.currentTime; for (const name of Object.keys(bands)) { const gain = VSC_CLAMP((profile[name] || 0) + (staticDialogueOffset[name] || 0), -12, 12); stt(bands[name].gain, gain, t, 0.08); } };
      return { input, output, bands, setProfile: (name) => { activeProfile = name; applyGains(); }, setDialogueOffset: (offset) => { if (staticDialogueOffset.voice === offset.voice) return; staticDialogueOffset = offset; applyGains(); }, setProfileAndDialogue: (profileName, dialogueOffset) => { let changed = activeProfile !== profileName; if (changed) activeProfile = profileName; if (staticDialogueOffset.sub !== dialogueOffset.sub || staticDialogueOffset.impact !== dialogueOffset.impact || staticDialogueOffset.cut !== dialogueOffset.cut || staticDialogueOffset.voice !== dialogueOffset.voice || staticDialogueOffset.air !== dialogueOffset.air) { staticDialogueOffset = dialogueOffset; changed = true; } if (changed) applyGains(); } };
    }

    function buildMultibandDynamics(actx) {
      const CROSSOVER_LOW = 200, CROSSOVER_HIGH = 3200;
      const createLR4 = (freq, type) => { const f1 = mkBQ(actx, type, freq, Math.SQRT1_2); const f2 = mkBQ(actx, type, freq, Math.SQRT1_2); f1.connect(f2); return { input: f1, output: f2 }; };
      const input = actx.createGain(), lpLow = createLR4(CROSSOVER_LOW, 'lowpass'), hpLow = createLR4(CROSSOVER_LOW, 'highpass'), lpMid = createLR4(CROSSOVER_HIGH, 'lowpass'), hpHigh = createLR4(CROSSOVER_HIGH, 'highpass');
      input.connect(lpLow.input); input.connect(hpLow.input); hpLow.output.connect(lpMid.input); hpLow.output.connect(hpHigh.input);
      const CROSSOVER_MAKEUP = Math.pow(10, 0.5 / 20);
      const compLow  = mkComp(actx, -22, 10, 2.5, 0.030, 0.50), compMid  = mkComp(actx, -18, 10, 2.0, 0.015, 0.18), compHigh = mkComp(actx, -14,  8, 1.8, 0.005, 0.10);
      const gainLow = actx.createGain();  gainLow.gain.value = CROSSOVER_MAKEUP; const gainMid = actx.createGain();  gainMid.gain.value = CROSSOVER_MAKEUP; const gainHigh = actx.createGain(); gainHigh.gain.value = CROSSOVER_MAKEUP;
      chain(lpLow.output, compLow, gainLow); chain(lpMid.output, compMid, gainMid); chain(hpHigh.output, compHigh, gainHigh);
      const output = actx.createGain(); gainLow.connect(output); gainMid.connect(output); gainHigh.connect(output);
      return { input, output, bands: { low: { comp: compLow, gain: gainLow }, mid: { comp: compMid, gain: gainMid }, high: { comp: compHigh, gain: gainHigh } } };
    }

    function createLUFSMeter(actx) {
      const preFilter = mkBQ(actx, 'highshelf', 1681, 0.7071, 4.0), hpf = mkBQ(actx, 'highpass', 38, 0.5), meterAnalyser = actx.createAnalyser();
      meterAnalyser.fftSize = 2048; // ✅ [Fix 17] 연산량 최적화 (4096 -> 2048)
      meterAnalyser.smoothingTimeConstant = 0;
      chain(preFilter, hpf, meterAnalyser);
      const buffer = new Float32Array(meterAnalyser.fftSize);
      const M_N = 20, S_N = 150; const mMean = new Float32Array(M_N), mDt = new Float32Array(M_N); const sMean = new Float32Array(S_N), sDt = new Float32Array(S_N);
      const state = { mIdx: 0, mFill: 0, mSumW: 0, mSumDt: 0, sIdx: 0, sFill: 0, sSumW: 0, sSumDt: 0, integratedSum: 0, integratedCount: 0, momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };

      function pushRing(meanSq, dt) {
        { const i = state.mIdx; const oldW = mMean[i] * mDt[i]; state.mSumW -= oldW; state.mSumDt -= mDt[i]; mMean[i] = meanSq; mDt[i] = dt; state.mSumW += meanSq * dt; state.mSumDt += dt; state.mIdx = (i + 1) % M_N; state.mFill = Math.min(M_N, state.mFill + 1); }
        { const i = state.sIdx; const oldW = sMean[i] * sDt[i]; state.sSumW -= oldW; state.sSumDt -= sDt[i]; sMean[i] = meanSq; sDt[i] = dt; state.sSumW += meanSq * dt; state.sSumDt += dt; state.sIdx = (i + 1) % S_N; state.sFill = Math.min(S_N, state.sFill + 1); }
      }

      function measure() {
        const dt = meterAnalyser.fftSize / (actx.sampleRate || 48000); meterAnalyser.getFloatTimeDomainData(buffer);
        let sumSq = 0; for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i]; const meanSq = sumSq / buffer.length;
        pushRing(meanSq, dt);
        const mMeanSq = state.mSumDt > 0 ? state.mSumW / state.mSumDt : 0; const sMeanSq = state.sSumDt > 0 ? state.sSumW / state.sSumDt : 0;
        state.momentaryLUFS = mMeanSq > 1e-10 ? -0.691 + 10 * Math.log10(mMeanSq) : -70; state.shortTermLUFS = sMeanSq > 1e-10 ? -0.691 + 10 * Math.log10(sMeanSq) : -70;
        if (state.momentaryLUFS > -70 && state.momentaryLUFS > state.integratedLUFS - 10) { state.integratedSum += meanSq; state.integratedCount++; const intMean = state.integratedSum / state.integratedCount; state.integratedLUFS = intMean > 1e-10 ? -0.691 + 10 * Math.log10(intMean) : -70; }
      }

      return {
        input: preFilter, measure,
        reset: () => { mMean.fill(0); mDt.fill(0); sMean.fill(0); sDt.fill(0); Object.assign(state, { mIdx:0, mFill:0, mSumW:0, mSumDt:0, sIdx:0, sFill:0, sSumW:0, sSumDt:0, integratedSum:0, integratedCount:0, momentaryLUFS:-70, shortTermLUFS:-70, integratedLUFS:-70 }); },
        getState: (out) => { if (!out) return { momentaryLUFS: state.momentaryLUFS, shortTermLUFS: state.shortTermLUFS, integratedLUFS: state.integratedLUFS }; out.momentaryLUFS = state.momentaryLUFS; out.shortTermLUFS = state.shortTermLUFS; out.integratedLUFS = state.integratedLUFS; return out; }
      };
    }

    function createLoudnessNormalizer(actx, lufsMeter) {
      const TARGET_LUFS = -14, MAX_GAIN_DB = 6, MIN_GAIN_DB = -6, SMOOTHING = 0.05, SETTLE_FRAMES = 30;
      const gainNode = actx.createGain(); gainNode.gain.value = 1.0; let frameCount = 0, currentGainDb = 0; const _tmp = { momentaryLUFS:-70, shortTermLUFS:-70, integratedLUFS:-70 };
      function update() {
        const lufs = lufsMeter.getState(_tmp); frameCount++; if (frameCount < SETTLE_FRAMES) return;
        const measured = lufs.shortTermLUFS; if (measured <= -60) return;
        const targetGainDb = VSC_CLAMP(TARGET_LUFS - measured, MIN_GAIN_DB, MAX_GAIN_DB);
        const alpha = targetGainDb < currentGainDb ? 0.12 : 0.04; currentGainDb += (targetGainDb - currentGainDb) * alpha;
        const linearGain = Math.pow(10, currentGainDb / 20); stt(gainNode.gain, linearGain, actx.currentTime, SMOOTHING);
      }
      return { node: gainNode, update, reset: () => { frameCount = 0; currentGainDb = 0; gainNode.gain.value = 1.0; lufsMeter.reset(); } };
    }

    function createDialogueBoostProfile() {
      const PROFILES = Object.freeze({ off: { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }, dialogueBoost: { sub: -1.5, impact: -0.5, cut: -2.0, voice: 1.5, air: 0.5 } });
      return { getProfile(enabled) { return enabled ? PROFILES.dialogueBoost : PROFILES.off; } };
    }

    function buildAudioGraph(audioCtx) {
      const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), hpf: mkBQ(audioCtx, 'highpass', 35, 0.707), limiter: mkComp(audioCtx, -1.0, 0.0, 20.0, 0.001, 0.08), clipper: audioCtx.createWaveShaper() };
      n.clipper.curve = getSoftClipCurve(); try { n.clipper.oversample = '2x'; } catch (_) {}
      const dynamicEQ = createDynamicCinemaEQ(audioCtx), multiband = buildMultibandDynamics(audioCtx), lufsMeter = createLUFSMeter(audioCtx), loudnessNorm = createLoudnessNormalizer(audioCtx, lufsMeter);
      n._dialogueProfile = createDialogueBoostProfile(); n.wetInGain = loudnessNorm.node;
      n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
      chain(n.inputGain, n.hpf, dynamicEQ.input); chain(dynamicEQ.output, multiband.input); multiband.output.connect(lufsMeter.input);
      chain(multiband.output, n.wetInGain); chain(n.wetInGain, n.clipper, n.limiter); chain(n.limiter, n.wetGain, n.masterOut);
      n.masterOut.connect(audioCtx.destination);
      n._dynamicEQ = dynamicEQ; n._multiband = multiband; n._lufsMeter = lufsMeter; n._loudnessNorm = loudnessNorm; return n;
    }

    const ensureCtx = () => {
      if (ctx && ctx.state !== 'closed') return true;
      if (ctx) { ctx = null; currentSrc = null; target = null; }
      const AC = window.AudioContext; if (!AC) return false;
      // ✅ [Fix 18] 기기 기본 샘플레이트를 우선하여 리샘플링 비용 방지
      try { ctx = new AC({ latencyHint: 'balanced' }); } catch (_) { try { ctx = new AC(); } catch (__) { return false; } }
      currentSrc = null; target = null; ensureGestureResumeHook();
      ensureVisibilityResumeHook(); // ✅ [PATCH 3-B] Hook 호출부 적용
      const nodes = buildAudioGraph(ctx); inputGain = nodes.inputGain; dryGain = nodes.dryGain; wetGain = nodes.wetGain; masterOut = nodes.masterOut; wetInGain = nodes.wetInGain; limiter = nodes.limiter; hpf = nodes.hpf; currentNodes = nodes; return true;
    };

    const fadeOutThen = (fn) => {
      if (!ctx) { fn(); return; }
      const tok = ++switchTok; clearTimeout(switchTimer); const t = ctx.currentTime; const fadeMs = 50;
      try { masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + fadeMs / 1000); } catch (_) { masterOut.gain.value = 0; }
      switchTimer = setTimeout(() => {
        if (tok !== switchTok) return; makeupDbEma = 0; safe(fn);
        if (ctx) { const t2 = ctx.currentTime; try { masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + fadeMs / 1000); } catch (_) { masterOut.gain.value = 1; } }
      }, fadeMs + 20);
    };

    const disconnectAll = () => { if (currentSrc) { safe(() => currentSrc.disconnect()); if (target) globalSrcMap.delete(target); } currentSrc = null; target = null; };

    const _lufsTmp = { momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };

    function runAudioLoop(tok) {
      audioLoopTimerId = 0; if (tok !== loopTok || !ctx) return;
      const dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); if (!dynAct) return;
      const actuallyEnabled = dynAct && currentSrc;

      if (currentSrc && currentNodes) {
        const lufsSt = currentNodes._lufsMeter.getState(_lufsTmp);
        const db = lufsSt.momentaryLUFS > -70 ? lufsSt.momentaryLUFS : -100;
        const mbActive = !!sm.get(P.A_MULTIBAND);

        if (currentNodes._dynamicEQ && currentNodes._multiband) {
          const dialogueOn = !!sm.get(P.A_DIALOGUE); const profile = currentNodes._dialogueProfile.getProfile(dialogueOn); const t = ctx.currentTime;
          currentNodes._dynamicEQ.setProfileAndDialogue(mbActive ? 'cinemaWithMultiband' : 'cinema', profile);
          const mb = currentNodes._multiband.bands;
          if (dialogueOn) { stt(mb.mid.gain.gain, 1.15, t, 0.08); stt(mb.low.gain.gain, 0.92, t, 0.08); stt(mb.high.gain.gain, 1.05, t, 0.08); } else { stt(mb.low.gain.gain, 1.0, t, 0.15); stt(mb.mid.gain.gain, 1.0, t, 0.15); stt(mb.high.gain.gain, 1.0, t, 0.15); }
        } else if (currentNodes._dynamicEQ) { currentNodes._dynamicEQ.setProfile(mbActive ? 'cinemaWithMultiband' : 'cinema'); }

        if (currentNodes._loudnessNorm && !!sm.get(P.A_LUFS) && actuallyEnabled) { currentNodes._lufsMeter.measure(); currentNodes._loudnessNorm.update(); }

        if (actuallyEnabled) {
          let redDb = 0;
          if (mbActive && currentNodes._multiband) {
            const rl = Math.abs(Number(currentNodes._multiband.bands.low.comp.reduction) || 0), rm = Math.abs(Number(currentNodes._multiband.bands.mid.comp.reduction) || 0), rh = Math.abs(Number(currentNodes._multiband.bands.high.comp.reduction) || 0);
            redDb = -(rl * 0.25 + rm * 0.50 + rh * 0.25);
          } else if (currentNodes.limiter) { const r = currentNodes.limiter.reduction; redDb = (typeof r === 'number') ? r : (r?.value ?? 0); }
          if (!Number.isFinite(redDb)) redDb = 0;
          const redPos = clamp(-redDb, 0, 15);
          const stLufs = lufsSt.shortTermLUFS, intLufs = lufsSt.integratedLUFS;
          let gateMult = 1.0; if (intLufs <= -65) gateMult = 0.0; else if (stLufs < -50) gateMult = 0.0; else if (stLufs < -40) gateMult = clamp((stLufs + 50) / 10.0, 0, 1);
          const makeupDbTarget = clamp(redPos * 0.30, 0, 3.5) * gateMult;
          const alpha = makeupDbTarget > makeupDbEma ? 0.08 : 0.15; makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
        } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
      }
      const userBoost = Math.pow(10, Number(sm.get(P.A_BST) || 0) / 20), makeup = Math.pow(10, makeupDbEma / 20);
      if (wetInGain) { const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0; stt(wetInGain.gain, finalGain, ctx.currentTime, 0.02); }

      const isPaused = target && (target.paused || target.ended);
      if (document.hidden) { audioLoopTimerId = setTimeout(() => runAudioLoop(tok), 500); }
      else if (isPaused) {
        if (target && !target.ended) {
          const resume = () => { target.removeEventListener('play', resume); target.removeEventListener('seeked', resume); if (tok === loopTok) runAudioLoop(tok); };
          target.addEventListener('play', resume, { once: true }); target.addEventListener('seeked', resume, { once: true });
          audioLoopTimerId = setTimeout(() => { target.removeEventListener('play', resume); target.removeEventListener('seeked', resume); if (tok === loopTok) runAudioLoop(tok); }, 30000);
        }
      } else {
        // ✅ [Fix 16] LUFS 등 빠른 분석 불필요 시 루프 주기를 늦춰 CPU 점유율 감소
        const needFast = !!sm.get(P.A_LUFS) || !!sm.get(P.A_MULTIBAND) || !!sm.get(P.A_DIALOGUE);
        const targetInterval = needFast ? 0.10 : 0.25;
        const nextTime = ctx.currentTime + targetInterval;
        const check = () => { if (tok !== loopTok) return; if (ctx.currentTime >= nextTime) { runAudioLoop(tok); } else { audioLoopTimerId = setTimeout(check, Math.max(16, (nextTime - ctx.currentTime) * 1000 - 10)); } };
        audioLoopTimerId = setTimeout(check, 80);
      }
    }

    const updateMix = () => {
      if (!ctx) return; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
      const tok = ++loopTok, dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)), isHooked = !!currentSrc;
      const wetTarget = (dynAct && isHooked) ? 1 : 0, dryTarget = 1 - wetTarget;
      stt(dryGain.gain, dryTarget, ctx.currentTime, 0.005); stt(wetGain.gain, wetTarget, ctx.currentTime, 0.005);
      if (currentNodes) {
        const mbEnabled = dynAct && !!sm.get(P.A_MULTIBAND);
        if (currentNodes._multiband) { const mb = currentNodes._multiband.bands, t = ctx.currentTime; stt(mb.low.comp.ratio, mbEnabled ? 2.5 : 1.0, t, 0.02); stt(mb.mid.comp.ratio, mbEnabled ? 2.2 : 1.0, t, 0.02); stt(mb.high.comp.ratio, mbEnabled ? 1.8 : 1.0, t, 0.02); }
        if (currentNodes._loudnessNorm && (!sm.get(P.A_LUFS) || !dynAct)) { stt(currentNodes._loudnessNorm.node.gain, 1.0, ctx.currentTime, 0.05); currentNodes._loudnessNorm.reset(); }
      }
      if (dynAct && isHooked) runAudioLoop(tok);
    };

    async function destroy() {
      try { _audioAC.abort(); } catch (_) {} // ✅ [PATCH 3-C] Abort Signal 정리
      _visResumeHooked = false; // ✅ [PATCH 3-C]
      loopTok++; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
      if (ctx) { if (target && globalSrcMap.has(target)) { const src = globalSrcMap.get(target); if (src) safe(() => src.disconnect()); globalSrcMap.delete(target); } }
      if (currentSrc) { safe(() => currentSrc.disconnect()); if (target) globalSrcMap.delete(target); currentSrc = null; }
      target = null; safe(() => { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } });
      try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
      ctx = null; currentNodes = null; limiter = null; wetInGain = null; inputGain = null; dryGain = null; wetGain = null; masterOut = null; hpf = null; makeupDbEma = 0; switchTok++;
    }

    return {
      warmup: () => { if (!ensureCtx()) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
      setTarget: (v) => {
        const intentToken = ++switchTok; const st = v ? getVState(v) : null;
        if (st && st.audioFailUntil > performance.now()) { if (v !== target) { target = v; } updateMix(); return; }
        if (!ensureCtx()) return;
        if (v === target) { updateMix(); return; }

        if (target !== null && v !== null && target !== v) {
          fadeOutThen(() => {
            disconnectAll(); if (intentToken !== switchTok) return; target = v; if (!v) { updateMix(); return; }
            let s = globalSrcMap.get(v), reusable = false;
            if (s) { try { reusable = (s.context === ctx && s.context.state !== 'closed'); } catch (_) { reusable = false; } if (!reusable) { try { s.disconnect(); } catch (_) {} globalSrcMap.delete(v); s = null; } }
            if (!s) { try { s = ctx.createMediaElementSource(v); globalSrcMap.set(v, s); } catch (e) { log.warn('createMediaElementSource failed:', e.message); if (st) st.audioFailUntil = performance.now() + SYS.WFC; disconnectAll(); updateMix(); return; } }
            s.connect(inputGain); currentSrc = s; updateMix();
          });
        } else if (v !== null && !currentSrc) {
          target = v; let s = globalSrcMap.get(v), reusable = false;
          if (s) { try { reusable = (s.context === ctx && s.context.state !== 'closed'); } catch (_) { reusable = false; } if (!reusable) { try { s.disconnect(); } catch (_) {} globalSrcMap.delete(v); s = null; } }
          if (!s) { try { s = ctx.createMediaElementSource(v); globalSrcMap.set(v, s); } catch (e) { log.warn('createMediaElementSource failed:', e.message); if (st) st.audioFailUntil = performance.now() + SYS.WFC; disconnectAll(); updateMix(); return; } }
          s.connect(inputGain); currentSrc = s; updateMix();
        } else if (v === null) { fadeOutThen(() => { disconnectAll(); updateMix(); }); }
      },
      update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy
    };
  }

  function createAutoSceneManager(Store, P, Scheduler) {
    const AUTO = { running: false, canvasW: 80, canvasH: 45, cur: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }, tgt: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }, lastSig: null, cutScoreEma: 0.10, cutScoreBaseline: 0.05, motionEma: 0, motionAlpha: 0.30, motionThresh: 0.012, motionFrames: 0, motionMinFrames: 5, statsEma: null, statsAlpha: 0.18, drmBlocked: false, blockUntilMs: 0, _drmSuccessCount: 0, _drmBackoffCount: 0, _permanentlyDisabled: false, _lastVideoRef: null, _lastVideoSrc: '', _firstUpdateDone: false, _playHooked: new WeakMap(), _ac: null, _timer: 0, minFps: 4, maxFps: 12, curFps: 4,
      stillFrames: 0, // ✅ [PATCH 2-A]
      stillUntilMs: 0 // ✅ [PATCH 2-A]
    };

    // ✅ [PATCH 2-B] Still-frame low duty cycle (power saver)
    const STILL = Object.freeze({
      MOTION_THR: 0.0025,   // sigRaw.motion이 이보다 작으면 거의 스틸
      SCORE_THR:  0.06,     // 밝기/대비 변화 score도 작으면 스틸
      ENTER_FRAMES: 12,     // 연속 12회(대략 2~3초) 스틸이면 발동
      HOLD_MS: 2500,        // 발동 후 최소 유지 시간
      DELAY_MS: 1500        // 스틸이면 분석 주기 1.5초(원하면 2000으로)
    });

    const _lastAnalyzedTime = new WeakMap();

    let worker = null;
    let workerBusy = false;
    let fallback = null;

    // ✅ [Fix 4] Worker Busy Watchdog 완화 및 요청 토큰 기반으로 수정
    const WORKER_HANG_MS = 3500;
    let inflightTok = 0;
    let hangTimer = 0;

    function beginWorkerRequest() {
      workerBusy = true;
      const tok = ++inflightTok;
      clearTimeout(hangTimer);
      hangTimer = setTimeout(() => {
        if (tok !== inflightTok) return;
        workerBusy = false;
        safe(() => worker?.terminate?.());
        worker = null;
      }, WORKER_HANG_MS);
      return tok;
    }

    function endWorkerRequest(tok) {
      if (tok !== inflightTok) return;
      clearTimeout(hangTimer);
      hangTimer = 0;
      workerBusy = false;
    }

    function clearWorkerBusy() {
      workerBusy = false;
      clearTimeout(hangTimer);
      hangTimer = 0;
    }

    function tryCreateWorker() {
      const workerCode = `
        let ctx2d = null; let _lumaA = null, _lumaB = null, _lumaFlip = 0, _hadFirstFrame = false; let isSetup = false;
        function initCtx(w, h) {
          try {
            const cvs = new OffscreenCanvas(w, h); ctx2d = cvs.getContext('2d', { willReadFrequently: true });
            if (!ctx2d) return false;
            _lumaA = new Uint8Array(w * h); _lumaB = new Uint8Array(w * h); isSetup = true; return true;
          } catch(e) { return false; }
        }
        function resetState() { _lumaFlip = 0; _hadFirstFrame = false; }
        function processPixels(data, w, h) {
          const stepPx = 3; const cur = (_lumaFlip === 0) ? _lumaA : _lumaB; const prev = (_lumaFlip === 0) ? _lumaB : _lumaA;
          const isFirst = (_lumaFlip === 0 && !_hadFirstFrame);
          let sum = 0, sum2 = 0, sumEdge = 0, edgeCount = 0, diffSum = 0, p = 0; const rowStride = w * 4, pixStride = stepPx * 4;
          for (let y = 0; y < h; y += stepPx) {
            const rowOff = y * rowStride;
            for (let x = 0; x < w; x += stepPx) {
              const idx = rowOff + x * 4; const l = (data[idx] * 54 + data[idx + 1] * 183 + data[idx + 2] * 19) >> 8;
              cur[p] = l; sum += l; sum2 += l * l;
              if (x + stepPx < w) {
                const idx2 = idx + pixStride; const l2 = (data[idx2] * 54 + data[idx2 + 1] * 183 + data[idx2 + 2] * 19) >> 8;
                let d = l2 - l; if (d < 0) d = -d; sumEdge += d; edgeCount++;
              }
              if (!isFirst) { let d = l - prev[p]; if (d < 0) d = -d; diffSum += d; }
              p++;
            }
          }
          _lumaFlip ^= 1; const samples = Math.max(1, p); const mean = sum / samples; const var_ = (sum2 / samples) - mean * mean;
          if (isFirst) { _hadFirstFrame = true; return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: 0 }; }
          return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: diffSum / samples };
        }
        self.onmessage = (e) => {
          const d = e.data || {};
          const action = d.action;
          if (action === 'reset') { resetState(); self.postMessage({ action: 'reset_ok' }); return; }
          if (action === 'analyze') {
            const bmp = d.bmp, w = d.w, h = d.h;
            try {
              if (!isSetup && !initCtx(w, h)) { try { bmp && bmp.close && bmp.close(); } catch(_) {} self.postMessage({ action: 'error' }); return; }
              ctx2d.drawImage(bmp, 0, 0, w, h);
              try { bmp && bmp.close && bmp.close(); } catch(_) {}
              const outData = ctx2d.getImageData(0, 0, w, h).data;
              const stats = processPixels(outData, w, h);
              self.postMessage({ action: 'result', stats });
            } catch (err) {
              try { bmp && bmp.close && bmp.close(); } catch(_) {}
              self.postMessage({ action: 'error', reason: String(err && (err.message || err)) });
            }
          }
        };
      `;
      try {
        const url = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
        const w = new Worker(url);
        // ✅ [Fix 11] Worker Blob URL revoke 타이밍 지연으로 호환성 확보
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 0);
        w.onmessage = handleWorkerMessage;
        w.onerror = () => { clearWorkerBusy(); safe(() => w.terminate()); worker = null; };
        w.onmessageerror = () => { clearWorkerBusy(); safe(() => w.terminate()); worker = null; };
        return w;
      } catch (e) {
        return null;
      }
    }

    function runFallbackProcessPixels(data, w, h, fb) {
      const stepPx = 3; const cur = (fb.flip === 0) ? fb.lumaA : fb.lumaB; const prev = (fb.flip === 0) ? fb.lumaB : fb.lumaA;
      const isFirst = (fb.flip === 0 && !fb.hadFirst); let sum = 0, sum2 = 0, sumEdge = 0, edgeCount = 0, diffSum = 0, p = 0; const rowStride = w * 4, pixStride = stepPx * 4;
      for (let y = 0; y < h; y += stepPx) {
        const rowOff = y * rowStride;
        for (let x = 0; x < w; x += stepPx) {
          const idx = rowOff + x * 4; const l = (data[idx] * 54 + data[idx + 1] * 183 + data[idx + 2] * 19) >> 8;
          cur[p] = l; sum += l; sum2 += l * l;
          if (x + stepPx < w) {
            const idx2 = idx + pixStride; const l2 = (data[idx2] * 54 + data[idx2 + 1] * 183 + data[idx2 + 2] * 19) >> 8;
            let d = l2 - l; if (d < 0) d = -d; sumEdge += d; edgeCount++;
          }
          if (!isFirst) { let d = l - prev[p]; if (d < 0) d = -d; diffSum += d; } p++;
        }
      }
      fb.flip ^= 1; const samples = Math.max(1, p); const mean = sum / samples; const var_ = (sum2 / samples) - mean * mean;
      if (isFirst) { fb.hadFirst = true; return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: 0 }; }
      return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: diffSum / samples };
    }

    function isFallback() { return !worker && !!fallback; }

    function ensureAnalyzer(w, h) {
      if (worker || fallback) return true;
      worker = tryCreateWorker();
      if (worker) return true;

      const getFLAGS = () => (window[Symbol.for('__VSC__')] || __vscNs)?.FLAGS;
      if (!getFLAGS()?.AUTO_SCENE_ALLOW_MAINTHREAD_FALLBACK) return false;

      try {
        const cvs = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        fallback = { ctx, w, h, lumaA: new Uint8Array(w*h), lumaB: new Uint8Array(w*h), flip: 0, hadFirst: false };
        return true;
      } catch (_) { return false; }
    }

    function handleAnalyzerResult(sigRaw) {
      AUTO.motionEma = (AUTO.motionEma * (1 - AUTO.motionAlpha)) + (sigRaw.motion * AUTO.motionAlpha); AUTO.motionFrames = (AUTO.motionEma >= AUTO.motionThresh) ? (AUTO.motionFrames + 1) : 0;
      const dY = Math.abs(sigRaw.bright - (AUTO.lastSig?.bright||0)), dCt = Math.abs(sigRaw.contrast - (AUTO.lastSig?.contrast||0)), score = (dY * 1.1) + (dCt * 0.9);
      AUTO.cutScoreBaseline = (AUTO.cutScoreBaseline || 0.05) * 0.97 + score * 0.03; const thr = Math.max(0.10, Math.min(0.25, AUTO.cutScoreBaseline * 2.5)), isCut = score > thr; AUTO.lastSig = sigRaw;

      // ✅ [PATCH 2-D] Still detection: "움직임/장면전환 거의 없음"이면 분석 주기 늘리기
      const stillLike = !isCut && (sigRaw.motion < STILL.MOTION_THR) && (score < STILL.SCORE_THR);
      AUTO.stillFrames = stillLike ? (AUTO.stillFrames + 1) : 0;
      if (AUTO.stillFrames >= STILL.ENTER_FRAMES) {
        AUTO.stillUntilMs = performance.now() + STILL.HOLD_MS;
      }

      if (!AUTO.statsEma) { AUTO.statsEma = { ...sigRaw }; } else { const e = AUTO.statsEma, a = AUTO.statsAlpha; e.bright = e.bright*(1-a) + sigRaw.bright*a; e.contrast = e.contrast*(1-a) + sigRaw.contrast*a; e.edge = e.edge*(1-a) + sigRaw.edge*a; }
      const sig = AUTO.statsEma;

      const allowUpdate = isCut || (AUTO.motionFrames >= AUTO.motionMinFrames) || (!AUTO._firstUpdateDone);
      if (allowUpdate) {
        AUTO._firstUpdateDone = true; let gainT = 1.0, ctT = 1.0, satT = 1.0, sharpScaleT = 1.0;
        if (sig.bright < 0.25) { const darkIntentionality = 1.0 - VSC_CLAMP(sig.edge / 6, 0, 0.5); gainT = 1.0 + ((0.25 - sig.bright) / 0.25) * 0.20 * darkIntentionality; } else if (sig.bright > 0.75) gainT = 1.0 - ((sig.bright - 0.75) / 0.25) * 0.05;
        if (sig.contrast < 0.12) ctT = 1.0 + ((0.12 - sig.contrast) / 0.12) * 0.10;
        const edgeVal = Number(sig.edge || 0); if (edgeVal > 12) { sharpScaleT = 1.0 - VSC_CLAMP((edgeVal - 12) / 13, 0, 1) * 0.40; } else if (edgeVal < 4) { sharpScaleT = 1.0 + VSC_CLAMP((4 - edgeVal) / 4, 0, 1) * 0.15; }
        const appDZ = (t, dz) => { const d = Math.abs(t - 1.0); return d < dz ? 1.0 : (t > 1.0 ? 1.0 + (d - dz) : 1.0 - (d - dz)); };
        AUTO.tgt.br = VSC_CLAMP(appDZ(gainT, 0.03), 0.95, 1.20); AUTO.tgt.ct = VSC_CLAMP(appDZ(ctT, 0.02), 0.95, 1.12); AUTO.tgt.sat = VSC_CLAMP(appDZ(satT, 0.03), 0.92, 1.12); AUTO.tgt.sharpScale = VSC_CLAMP(sharpScaleT, 0.75, 1.15);
        const asym = (c, t, au, ad) => Math.abs(t-c) < 0.002 ? t : c + (t-c) * (t>c?au:ad);
        AUTO.cur.br = asym(AUTO.cur.br, AUTO.tgt.br, isCut ? 0.40 : 0.12, isCut ? 0.45 : 0.18); AUTO.cur.ct = asym(AUTO.cur.ct, AUTO.tgt.ct, isCut ? 0.38 : 0.12, isCut ? 0.38 : 0.12); AUTO.cur.sat = asym(AUTO.cur.sat, AUTO.tgt.sat, isCut ? 0.32 : 0.08, isCut ? 0.40 : 0.14); AUTO.cur.sharpScale = asym(AUTO.cur.sharpScale, AUTO.tgt.sharpScale, isCut ? 0.35 : 0.08, isCut ? 0.40 : 0.14);
        if (Math.abs(AUTO.cur.br - AUTO.tgt.br) > 0.001 || Math.abs(AUTO.cur.ct - AUTO.tgt.ct) > 0.001) Scheduler.request(true);
      }
    }

    function handleWorkerMessage(e) {
      const d = e.data || {};
      if (d.action === 'result') { endWorkerRequest(inflightTok); handleAnalyzerResult(d.stats); }
      else if (d.action === 'error') { endWorkerRequest(inflightTok); }
      else if (d.action === 'reset_ok') { /* no-op */ }
    }

    // ✅ [Fix 1] AutoScene RVFC 중복 호출 제어 및 단일 취소 구조화
    let __asRvfcId = 0;
    let __asRvfcVideo = null;

    function cancelRvfc() {
      if (__asRvfcId && __asRvfcVideo && typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') {
        try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
      }
      __asRvfcId = 0;
      __asRvfcVideo = null;
    }

    function clearTimer() {
      if (AUTO._timer) { clearTimeout(AUTO._timer); AUTO._timer = 0; }
      cancelRvfc();
    }

    function attachPlayOnce(v) {
      if (!v) return;
      if (AUTO._playHooked.get(v)) return;
      AUTO._playHooked.set(v, true);
      const onPlay = () => { AUTO._playHooked.delete(v); if (AUTO.running) loop(); };
      try { v.addEventListener('play', onPlay, { once: true, signal: AUTO._ac?.signal }); }
      catch (_) { v.addEventListener('play', onPlay, { once: true }); }
    }

    function scheduleNext(v, delayMs) {
      if (!AUTO.running) return;
      clearTimer();
      if (v?.paused || v?.ended) { attachPlayOnce(v); return; }

      const canRvfc = v && typeof v.requestVideoFrameCallback === 'function' && delayMs <= 100;
      if (canRvfc) {
        __asRvfcVideo = v;
        __asRvfcId = v.requestVideoFrameCallback(() => {
          __asRvfcId = 0; __asRvfcVideo = null;
          loop();
        });
      }
      else {
        AUTO._timer = setTimeout(loop, Math.max(16, delayMs | 0));
      }
    }

    function resetAutoSceneState() {
      AUTO.drmBlocked = false; AUTO.blockUntilMs = 0; AUTO._drmBackoffCount = 0; AUTO._drmSuccessCount = 0; AUTO._permanentlyDisabled = false; AUTO._hadFirstFrame = false; AUTO._firstUpdateDone = false; AUTO.statsEma = null;
      AUTO.stillFrames = 0;  // ✅ [PATCH 2-C]
      AUTO.stillUntilMs = 0; // ✅ [PATCH 2-C]
    }

    function computeNextDelayMs() {
      const m = VSC_CLAMP(AUTO.motionEma || 0, 0, 0.05) / 0.05;
      const fps = AUTO.minFps + (AUTO.maxFps - AUTO.minFps) * m;
      AUTO.curFps = fps;
      return Math.round(1000 / fps);
    }

    function loop() {
      if (!AUTO.running) return;
      const now = performance.now(), en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
      const ns = (__vscNs && typeof __vscNs === 'object') ? __vscNs : window[Symbol.for('__VSC__')];
      const getFLAGS = () => ns?.FLAGS;
      const v = ns?.App?.getActiveVideo?.();

      if (v) {
        const srcChanged = v.currentSrc !== (AUTO._lastVideoSrc || '');
        if (AUTO._lastVideoRef !== v || srcChanged) {
          AUTO._lastVideoRef = v;
          AUTO._lastVideoSrc = v.currentSrc || '';
          resetAutoSceneState();
          _lastAnalyzedTime.delete(v);
          try { worker?.postMessage?.({ action: 'reset' }); } catch (_) {}
          if (fallback) { fallback.flip = 0; fallback.hadFirst = false; try { fallback.lumaA.fill(0); fallback.lumaB.fill(0); } catch (_) {} }
        }
      }

      if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; stopLoop({ releaseAnalyzer: !!getFLAGS()?.AUTO_SCENE_RELEASE_ANALYZER_ON_STOP }); Scheduler.request(true); return; }
      if (!v || v.paused || v.readyState < 2) { scheduleNext(v, 200); return; }
      if (workerBusy || document.hidden || (AUTO.drmBlocked && now < AUTO.blockUntilMs)) { scheduleNext(v, 100); return; }

      // ✅ [Fix 15] 라이브 스트림 등 오차가 있는 영상에서 프레임 넘김 최적화
      const lastT = _lastAnalyzedTime.get(v);
      const curT = v.currentTime;
      if (Number.isFinite(lastT) && Math.abs(curT - lastT) < 0.001 && !v.seeking) { scheduleNext(v, 100); return; }
      _lastAnalyzedTime.set(v, curT);

      createImageBitmap(v, { resizeWidth: AUTO.canvasW, resizeHeight: AUTO.canvasH, resizeQuality: 'low' }).then(bmp => {
        AUTO.drmBlocked = false; AUTO._drmSuccessCount = (AUTO._drmSuccessCount || 0) + 1; if (AUTO._drmSuccessCount > 10) AUTO._drmBackoffCount = 0;

        if (worker) {
          const tok = beginWorkerRequest();
          worker.postMessage({ action: 'analyze', bmp, w: AUTO.canvasW, h: AUTO.canvasH }, [bmp]);
        }
        else if (fallback) {
          fallback.ctx.drawImage(bmp, 0, 0, fallback.w, fallback.h); bmp.close();
          const outData = fallback.ctx.getImageData(0, 0, fallback.w, fallback.h).data;
          const stats = runFallbackProcessPixels(outData, fallback.w, fallback.h, fallback);
          handleAnalyzerResult(stats);
        }

        // ✅ [Fix 10] 메인스레드 폴백 시 FPS 상한을 낮춰 프레임 드랍 예방
        if (isFallback()) {
          AUTO.minFps = 2;
          AUTO.maxFps = 6;
        } else {
          AUTO.minFps = 4;
          AUTO.maxFps = 12;
        }

        // ✅ [PATCH 2-E] Still-mode: 스틸 구간이면 1~2초로 크게 늘려 전력 절감
        let delay = (document.hidden || !getFLAGS()?.AUTO_SCENE_ADAPTIVE_FPS) ? 150 : computeNextDelayMs();
        if (isFallback()) delay = Math.max(delay, 250); // Fallback 추가 하한

        const n2 = performance.now();
        if (AUTO.stillUntilMs && n2 < AUTO.stillUntilMs) {
          delay = Math.max(delay, STILL.DELAY_MS);
        }
        scheduleNext(v, delay);

      }).catch(err => {
        AUTO.drmBlocked = true; AUTO._drmSuccessCount = 0; AUTO._drmBackoffCount = (AUTO._drmBackoffCount || 0) + 1;
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, Math.min(AUTO._drmBackoffCount, 8)));
        AUTO.blockUntilMs = now + backoffMs; scheduleNext(v, backoffMs);
      });
    }

    function destroyAutoScene() {
      AUTO.running = false;
      cancelRvfc();
      if (worker) { try { worker.terminate(); } catch (_) {} worker = null; }
      fallback = null; workerBusy = false;
    }

    // ✅ [Fix 5] AutoScene Stop 시 잔여 워커 타이머/RVFC 확실히 정리
    function stopLoop({ releaseAnalyzer = false } = {}) {
      AUTO.running = false;
      clearTimer();
      clearWorkerBusy();
      if (AUTO._ac) { AUTO._ac.abort(); AUTO._ac = null; }
      if (releaseAnalyzer) destroyAutoScene();
    }

    Store.sub(P.APP_AUTO_SCENE, (en) => {
      const getFLAGS = () => (window[Symbol.for('__VSC__')] || __vscNs)?.FLAGS;
      if (en && !AUTO.running) {
        AUTO._ac = new AbortController();
        const ok = ensureAnalyzer(AUTO.canvasW, AUTO.canvasH);
        if (!ok) { Store.set(P.APP_AUTO_SCENE, false); return; }
        AUTO.running = true; loop();
      }
      else if (!en && AUTO.running) {
        AUTO.tgt = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 };
        stopLoop({ releaseAnalyzer: !!getFLAGS()?.AUTO_SCENE_RELEASE_ANALYZER_ON_STOP });
        Scheduler.request(true);
      }
    });

    return { getMods: () => AUTO.cur, start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) { AUTO._ac = new AbortController(); const ok = ensureAnalyzer(AUTO.canvasW, AUTO.canvasH); if(ok){AUTO.running = true; loop();} else{Store.set(P.APP_AUTO_SCENE, false);} } }, stop: stopLoop, destroy: destroyAutoScene };
  }

  // --- PART 2 END ---
// --- PART 2 END ---
  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp } = Utils;
    const clamp01 = (x) => (x < 0 ? 0 : (x > 1 ? 1 : x));

    function createLRU(max = 192) {
      const m = new Map();
      return {
        get(k) { return m.get(k); },
        set(k, v) {
          m.delete(k);
          m.set(k, v);
          if (m.size > max) {
            const first = m.keys().next().value;
            m.delete(first);
          }
        }
      };
    }

    const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(192);
    const _attrCache = new WeakMap();

    const __vscBgMemo = new WeakMap();

    // ✅ [Fix 14] 강제 검정 배경 플래그 기반 처리
    function ensureOpaqueBg(video) {
      if (!video || __vscBgMemo.has(video) || !getFLAGS()?.FILTER_FORCE_OPAQUE_BG) return;
      try {
        const cs = getComputedStyle(video).backgroundColor;
        if (cs === 'transparent' || cs === 'rgba(0, 0, 0, 0)' || cs === 'rgba(0,0,0,0)') {
          __vscBgMemo.set(video, video.style.backgroundColor || '');
          video.style.backgroundColor = '#000';
        } else {
          __vscBgMemo.set(video, null);
        }
      } catch (_) {}
    }

    function restoreOpaqueBg(video) {
      if (!video) return;
      const prev = __vscBgMemo.get(video);
      if (prev === undefined) return;
      __vscBgMemo.delete(video);
      if (prev !== null) video.style.backgroundColor = prev;
    }

    function setAttr(node, attr, val) {
      if (!node) return;
      const strVal = val == null ? '' : String(val);
      let cache = _attrCache.get(node);
      if (!cache) { cache = Object.create(null); _attrCache.set(node, cache); }
      if (cache[attr] === strVal) return;
      cache[attr] = strVal;
      node.setAttribute(attr, strVal);
    }

    const applyLumaSharpening = (sharpDetail, strength, qs = 1) => {
      if (!sharpDetail) return;
      const s = Math.min(1, Math.max(0, strength));
      const q = Math.sqrt(Math.max(0.50, Math.min(1, qs)));

      const amountRaw = (s * 1.90) * q;
      const amount = Math.min(1.7, amountRaw);
      const std = s > 0 ? (0.45 + s * 0.35).toFixed(2) : '0';

      if (sharpDetail.blurF) setAttr(sharpDetail.blurF, 'stdDeviation', std);
      if (sharpDetail.ySharp) {
        setAttr(sharpDetail.ySharp, 'k2', '1');
        setAttr(sharpDetail.ySharp, 'k3', amount.toFixed(3));
        setAttr(sharpDetail.ySharp, 'k4', '0');
      }
    };

    const makeKeyBase = (s) => [
      Math.round(s.gain / 0.04), Math.round(s.gamma / 0.01), Math.round(s.contrast / 0.01),
      Math.round(s.bright / 0.2), Math.round(s.satF / 0.01), Math.round(s.mid / 0.02),
      Math.round(s.toe / 0.2), Math.round(s.shoulder / 0.2), Math.round(s.temp / 0.2),
      Math.round(s.sharp), Math.round(s.sharp2), Math.round(s.clarity)
    ].join('|');

    function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
      const key = `${steps}|${toeN}|${shoulderN}|${midN}|${gain}`;
      const hit = toneCache.get(key);
      if (hit) return hit;

      if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) {
        const res0 = '0 1';
        toneCache.set(key, res0);
        return res0;
      }

      const arr = new Array(steps);
      const g = Math.log2(Math.max(1e-6, gain)) * 0.90;
      const denom = Math.abs(g) > 1e-6 ? (1 - Math.exp(-g)) : 0;
      const useExp = Math.abs(denom) > 1e-6;

      const toeEnd = 0.34 + Math.abs(toeN) * 0.06;
      const toeAmt = Math.abs(toeN);
      const toeSign = toeN >= 0 ? 1 : -1;
      const shoulderStart = 0.90 - shoulderN * 0.10;
      const shAmt = Math.abs(shoulderN);
      let prev = 0;

      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1);
        let x = useExp ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
        if (toeAmt > 1e-6) {
          const u = Utils.clamp((x - 0) / Math.max(1e-6, (toeEnd - 0)), 0, 1);
          const smooth = u * u * (3 - 2 * u);
          const w = 1 - smooth;
          x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1);
        }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart));
          const kk = Math.max(0.7, 1.2 + shAmt * 6.5);
          const shDen = (1 - Math.exp(-kk));
          const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        if (x <= prev) {
          const eps = Math.min(1e-5, (1.0 - prev) * 0.5);
          x = eps > 0 ? prev + eps : prev;
        }
        x = Math.min(x, 1.0);
        prev = x;
        const y = Math.round(x * 100000) / 100000;
        arr[i] = y === 1 ? '1' : (y === 0 ? '0' : String(y));
      }
      const res = arr.join(' ');
      toneCache.set(key, res);
      return res;
    }

    function calcFilterRes(vw, vh, maxPix) {
      vw = vw | 0; vh = vh | 0;
      if (vw <= 0 || vh <= 0 || maxPix <= 0) return '';
      const px = vw * vh;
      if (px <= maxPix) return `${vw} ${vh}`;
      const s = Math.sqrt(maxPix / px);
      return `${Math.max(1, Math.round(vw * s))} ${Math.max(1, Math.round(vh * s))}`;
    }

    function buildSvg(root) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
      const defs = h('defs', { ns: 'svg' });
      svg.append(defs);

      const fidLite = `vsc-lite-${config.VSC_ID}`;
      const fidSharp = `vsc-sharp-${config.VSC_ID}`;

      const mkTempTransfer = (prefix, inN) => {
        const r = h('feFuncR', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const g = h('feFuncG', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const b = h('feFuncB', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const tm = h('feComponentTransfer', { ns: 'svg', in: inN, result: `${prefix}_tm` }, r, g, b);
        return { tm, r, g, b };
      };

      const mkFuncRGB = (attrs) => ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', ...attrs }));

      const mkC = (p) => {
        const t = h('feComponentTransfer', { ns: 'svg', result: `${p}_t` }, mkFuncRGB({ type: 'table', tableValues: '0 1' }));
        const b = h('feComponentTransfer', { ns: 'svg', in: `${p}_t`, result: `${p}_b` }, mkFuncRGB({ type: 'linear', slope: '1', intercept: '0' }));
        const g = h('feComponentTransfer', { ns: 'svg', in: `${p}_b`, result: `${p}_g` }, mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' }));
        return { t, b, g };
      };

      const mkP = (p, inN) => {
        const tmp = mkTempTransfer(p, inN);
        const s = h('feColorMatrix', { ns: 'svg', in: `${p}_tm`, type: 'saturate', values: '1', result: `${p}_s` });
        return { tmp, s };
      };

      const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '-3%', y: '-3%', width: '106%', height: '106%' });
      const cL = mkC('l');
      const pL = mkP('l', 'l_g');
      lite.append(cL.t, cL.b, cL.g, pL.tmp.tm, pL.s);

      const sharp = h('filter', { ns: 'svg', id: fidSharp, x: '-3%', y: '-3%', width: '106%', height: '106%' });
      const cS = mkC('s');
      const pS = mkP('s', 's_out');

      sharp.setAttribute('color-interpolation-filters', 'sRGB');

      const Y_ONLY_LUMA = '0.2126 0.7152 0.0722 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0';
      const RGB_TO_CbCr_GB = '0 0 0 0 0 -0.1146 -0.3854 0.5 0 0.5 0.5 -0.4542 -0.0458 0 0.5 0 0 0 1 0';
      const YCbCr_TO_RGB = '1 0 1.5748 0 -0.7874 1 -0.1873 -0.4681 0 0.3277 1 1.8556 0 0 -0.9278 0 0 0 1 0';

      const sYR = h('feColorMatrix', { ns: 'svg', in: 's_g', type: 'matrix', values: Y_ONLY_LUMA, result: 's_yR' });
      const sUV = h('feColorMatrix', { ns: 'svg', in: 's_g', type: 'matrix', values: RGB_TO_CbCr_GB, result: 's_uvGB' });
      const yBlur = h('feGaussianBlur', { ns: 'svg', in: 's_yR', stdDeviation: '0', result: 's_yb1' });
      const yDiff = h('feComposite', { ns: 'svg', in: 's_yR', in2: 's_yb1', operator: 'arithmetic', k1: '0', k2: '1', k3: '-1', k4: '0', result: 's_yd1' });
      const ySharp = h('feComposite', { ns: 'svg', in: 's_yR', in2: 's_yd1', operator: 'arithmetic', k1: '0', k2: '1', k3: '0.5', k4: '0', result: 's_ySharpR' });
      const yuv = h('feComposite', { ns: 'svg', in: 's_ySharpR', in2: 's_uvGB', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0', result: 's_yuv' });
      const toRgb = h('feColorMatrix', { ns: 'svg', in: 's_yuv', type: 'matrix', values: YCbCr_TO_RGB, result: 's_out' });

      sharp.append(cS.t, cS.b, cS.g, sYR, sUV, yBlur, yDiff, ySharp, yuv, toRgb, pS.tmp.tm, pS.s);
      let sharpDetail = { mode: 'basic', blurF: yBlur, ySharp: ySharp };

      defs.append(lite, sharp);

      const tryAppend = () => {
        const target = root.body || root.documentElement || root;
        if (target && target.appendChild) { target.appendChild(svg); return true; }
        return false;
      }

      if (!tryAppend()) {
        const mo = new MutationObserver(() => { if (tryAppend()) mo.disconnect(); });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        setTimeout(() => mo.disconnect(), 5000);
      }

      const commonByTier = {
        lite: { toneFuncs: Array.from(cL.t.children), bcLinFuncs: Array.from(cL.b.children), gamFuncs: Array.from(cL.g.children), tmp: pL.tmp, sats: [pL.s] },
        sharp: { toneFuncs: Array.from(cS.t.children), bcLinFuncs: Array.from(cS.b.children), gamFuncs: Array.from(cS.g.children), tmp: pS.tmp, sats: [pS.s] }
      };

      return { fidLite, fidSharp, filters: { lite, sharp }, commonByTier, sharpDetail, st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', commonTier: { lite: { toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '' }, sharp: { toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '' } }, sharpKey: '', __filterRes: '', rev: 0 } };
    }

    function prepare(video, s) {
      const root = video.ownerDocument || document;
      let dc = urlCache.get(root);
      if (!dc) { dc = { key: '', url: '' }; urlCache.set(root, dc); }

      ensureOpaqueBg(video);

      const qSharp = Math.round(Number(s.sharp || 0));
      const qSharp2 = Math.round(Number(s.sharp2 || 0));
      const qClarity = Math.round(Number(s.clarity || 0));
      const sharpTotal = (qSharp + qSharp2 + qClarity);
      const tier = sharpTotal > 0 ? 'sharp' : 'lite';

      let combinedStrength = 0;
      if (tier === 'sharp') {
        const n1 = qSharp / 52, n2 = qSharp2 / 74, n3 = qClarity / 64;
        combinedStrength = clamp01(n1 * 0.40 + n2 * 0.40 + n3 * 0.20);
      }

      const stableKey = `${tier}|${makeKeyBase(s)}`;
      const qsRaw = Number(s._qs !== undefined ? s._qs : 1);
      const qs = Math.round(qsRaw * 20) / 20;

      let nodes = ctxMap.get(root);
      if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }

      const needReapply = (dc.key !== stableKey);

      if (nodes.st.lastKey !== stableKey) {
        nodes.st.lastKey = stableKey;
        nodes.st.rev = (nodes.st.rev + 1) | 0;

        const st = nodes.st;
        const steps = 128;
        const gainQ = (s.gain || 1) < 1.4 ? 0.06 : 0.08;

        const toeQ = Math.round(clamp((s.toe || 0) / TOE_DIVISOR, -1, 1) / 0.02) * 0.02;
        const shQ = Math.round(clamp((s.shoulder || 0) / 16, -1, 1) / 0.02) * 0.02;
        const midQ = Math.round(clamp(s.mid || 0, -1, 1) / 0.02) * 0.02;
        const gainQ2 = Math.round((s.gain || 1) / gainQ) * gainQ;

        const tk = `${steps}|${toeQ}|${shQ}|${midQ}|${gainQ2}`;
        const cst = st.commonTier[tier] || st;
        const table = (cst.toneKey !== tk) ? getToneTableCached(steps, toeQ, shQ, midQ, gainQ2) : cst.toneTable;

        const con = clamp(s.contrast || 1, 0.1, 5.0);
        const brightOffset = clamp((s.bright || 0) / 250, -0.5, 0.5);
        const intercept = clamp(0.5 * (1 - con) + brightOffset, -5, 5);

        const conStr = con.toFixed(3);
        const interceptStr = intercept.toFixed(4);
        const bcLinKey = `${conStr}|${interceptStr}`;
        const gk = (1 / clamp(s.gamma || 1, 0.1, 5.0)).toFixed(4);

        const getFLAGS = () => (__vscNs)?.FLAGS;
        const satBase = clamp(s.satF ?? 1, 0, 5.0);

        let satAdj = satBase;
        if (getFLAGS()?.FILTER_SHARP_SAT_COMP && tier === 'sharp') {
          const t = Math.max(0, combinedStrength - 0.22) / (1 - 0.22);
          const userReduce = satBase < 1 ? 0.35 : 1.0;
          const boost = userReduce * (t * 0.18);
          satAdj = clamp(Math.min(satBase * (1 + boost), satBase + 0.25), 0, 5.0);
        }
        const satVal = satAdj.toFixed(2);

        const rsStr = s._rs.toFixed(3);
        const gsStr = s._gs.toFixed(3);
        const bsStr = s._bs.toFixed(3);
        const tmk = `${rsStr}|${gsStr}|${bsStr}`;

        const common = nodes.commonByTier[tier];

        if (cst.toneKey !== tk) { cst.toneKey = tk; cst.toneTable = table; if (common.toneFuncs) for (const fn of common.toneFuncs) setAttr(fn, 'tableValues', table); }
        if (cst.bcLinKey !== bcLinKey) { cst.bcLinKey = bcLinKey; if (common.bcLinFuncs) for (const fn of common.bcLinFuncs) { setAttr(fn, 'slope', conStr); setAttr(fn, 'intercept', interceptStr); } }
        if (cst.gammaKey !== gk) { cst.gammaKey = gk; if (common.gamFuncs) for (const fn of common.gamFuncs) setAttr(fn, 'exponent', gk); }
        if (cst.satKey !== satVal) { cst.satKey = satVal; if (common.sats) for (const satNode of common.sats) setAttr(satNode, 'values', satVal); }
        if (cst.tempKey !== tmk) { cst.tempKey = tmk; if (common.tmp) { setAttr(common.tmp.r, 'slope', rsStr); setAttr(common.tmp.g, 'slope', gsStr); setAttr(common.tmp.b, 'slope', bsStr); } }
      }

      if (tier === 'sharp') {
        const quantizedStrength = Math.round(combinedStrength * 50) / 50;
        const sharpKeyNext = `${quantizedStrength.toFixed(3)}|${qs.toFixed(2)}`;

        if (nodes.st.sharpKey !== sharpKeyNext) {
          nodes.st.sharpKey = sharpKeyNext;
          nodes.st.rev = (nodes.st.rev + 1) | 0;
          applyLumaSharpening(nodes.sharpDetail, quantizedStrength, qs);
        }
      }

      const activeFilterEl = (tier === 'sharp') ? nodes.filters.sharp : nodes.filters.lite;
      const inactiveFilterEl = (tier === 'sharp') ? nodes.filters.lite : nodes.filters.sharp;

      if (inactiveFilterEl.hasAttribute('filterRes')) inactiveFilterEl.removeAttribute('filterRes');

      const dpr = Math.max(1, window.devicePixelRatio || 1);

      // ✅ [Fix 3] applySet 기준 통합 최대 해상도 힌트 적용
      let vwDisp = 0, vhDisp = 0;
      if (s && Number.isFinite(s._frW) && Number.isFinite(s._frH) && s._frW > 0 && s._frH > 0) {
        vwDisp = s._frW | 0;
        vhDisp = s._frH | 0;
      } else {
        vwDisp = video.videoWidth || 0;
        vhDisp = video.videoHeight || 0;
        const vst = getVState(video);
        const r0 = vst.rect;
        if (r0 && r0.width > 0 && r0.height > 0) { vwDisp = Math.round(r0.width * dpr); vhDisp = Math.round(r0.height * dpr); }
        else { if (vst._filterResRev !== __vscLayoutRev) { vst._filterResRev = __vscLayoutRev; try { const r = video.getBoundingClientRect(); if (r && r.width > 0 && r.height > 0) { vwDisp = Math.round(r.width * dpr); vhDisp = Math.round(r.height * dpr); } } catch(_) {} } }
      }

      const baseMaxPix = config.SVG_MAX_PIX_FAST ?? (3840 * 2160);
      const dynMaxPix = Math.round(baseMaxPix * Math.pow(0.55 + 0.45 * qs, 2));
      const fr = calcFilterRes(vwDisp, vhDisp, dynMaxPix);

      if (fr && nodes.st.__filterRes !== fr) {
        nodes.st.__filterRes = fr;
        activeFilterEl.setAttribute('filterRes', fr);
        nodes.st.rev = (nodes.st.rev + 1) | 0;
      } else if (!fr && nodes.st.__filterRes !== '') {
        nodes.st.__filterRes = '';
        activeFilterEl.removeAttribute('filterRes');
        nodes.st.rev = (nodes.st.rev + 1) | 0;
      }

      const url = `url(#${tier === 'lite' ? nodes.fidLite : nodes.fidSharp})`;
      dc.key = stableKey; dc.url = url;

      return { url, changed: needReapply, rev: nodes.st.rev };
    }

    return {
      invalidateCache: (video) => {
        try {
          const root = video.ownerDocument || document;
          const nodes = ctxMap.get(root);
          if (nodes) {
            nodes.st.lastKey = ''; nodes.st.sharpKey = ''; nodes.st.__filterRes = ''; nodes.st.rev = (nodes.st.rev + 1) | 0;
            for (const tierKey of ['lite', 'sharp']) { const cst = nodes.st.commonTier[tierKey]; if (cst) { cst.toneKey = ''; cst.toneTable = ''; cst.bcLinKey = ''; cst.gammaKey = ''; cst.tempKey = ''; cst.satKey = ''; } }
          }
          const dc = urlCache.get(root);
          if (dc) { dc.key = ''; dc.url = ''; }
        } catch (_) {}
      },
      prepareCached: (video, s) => {
        try { return prepare(video, s); }
        catch (e) { log.warn('filter prepare failed:', e); return { url: null, changed: false, rev: -1 }; }
      },
      applyUrl: (el, urlObj) => {
        if (!el) return;
        const url = typeof urlObj === 'string' ? urlObj : urlObj?.url;
        const st = getVState(el);

        if (!url) {
          restoreOpaqueBg(el);
          if (st.applied) {
            if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || '');
            else el.style.removeProperty('filter');
            if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || '');
            else el.style.removeProperty('-webkit-filter');
            st.applied = false; st.lastFilterUrl = null; st.filterRev = -1; st.origFilter = st.origWebkitFilter = null; st.origFilterPrio = st.origWebkitFilterPrio = '';
          }
          return;
        }

        if (!st.applied) {
          st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || '';
          st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || '';
        }

        const nextRev = (typeof urlObj === 'object' && typeof urlObj.rev === 'number') ? urlObj.rev : -1;
        const revChanged = (nextRev >= 0 && st.filterRev !== nextRev);
        const forceReapply = !!urlObj?.changed || revChanged;

        if (st.lastFilterUrl === url && !forceReapply) return;

        const getFLAGS = () => (__vscNs)?.FLAGS;
        const noLayout = !!getFLAGS()?.FILTER_REAPPLY_NO_FORCED_LAYOUT;

        if (st.lastFilterUrl === url && forceReapply) {
          if (!noLayout) {
            el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); void el.offsetWidth;
          } else {
            // ✅ [Fix 6] 요소별 재적용 토큰 도입으로 누적 rAF 병목 방지
            const tok = (st._reapplyTok = (st._reapplyTok | 0) + 1);
            el.style.setProperty('filter', 'none', 'important'); el.style.setProperty('-webkit-filter', 'none', 'important');
            requestAnimationFrame(() => {
              if (!el.isConnected || st._reapplyTok !== tok) return;
              requestAnimationFrame(() => {
                if (!el.isConnected || st._reapplyTok !== tok) return;
                el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important');
              });
            });
          }
        } else { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }
        st.applied = true; st.lastFilterUrl = url; st.filterRev = nextRev;
      },
      clear: (el) => {
        if (!el) return;
        const st = getVState(el);
        restoreOpaqueBg(el);
        if (!st.applied) return;
        if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || '');
        else el.style.removeProperty('filter');
        if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || '');
        else el.style.removeProperty('-webkit-filter');
        st.applied = false; st.lastFilterUrl = null; st.filterRev = -1; st.origFilter = st.origWebkitFilter = null; st.origFilterPrio = st.origWebkitFilterPrio = '';
      }
    };
  }

  function createBackendAdapter(Filters) {
    const _backendChangeListeners = new Set();
    return {
      onBackendChange(fn) { _backendChangeListeners.add(fn); return () => _backendChangeListeners.delete(fn); },
      _notifyBackendChange(video, mode) { for (const fn of _backendChangeListeners) safe(() => fn(video, mode)); },
      apply(video, vVals) {
        const svgResult = Filters.prepareCached(video, vVals);
        Filters.applyUrl(video, svgResult);
        const st = getVState(video);
        const nextBackend = st.applied ? 'svg' : null;
        if (st.fxBackend !== nextBackend) {
          st.fxBackend = nextBackend;
          this._notifyBackendChange(video, nextBackend);
        }
      },
      clear(video) {
        const st = getVState(video);
        if (st.applied || st.fxBackend === 'svg') Filters.clear(video);
        st.fxBackend = null;
        this._notifyBackendChange(video, null);
      }
    };
  }

  function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); };
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointermove', move, { passive: false, signal: ac.signal });
    on(el, 'pointerup', up, { signal: ac.signal });
    on(el, 'pointercancel', up, { signal: ac.signal });
    return () => { ac.abort(); };
  }

  function createUI(sm, registry, ApplyReq, Utils) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null; let hasUserDraggedUI = false;
    const uiWakeCtrl = new AbortController(); const uiUnsubs = [];
    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };

    let _allowCache = { v: false, t: 0, lastVideoCount: -1 };
    const ALLOW_TTL = 1200;

    const allowUiInThisDoc = () => {
      const now = performance.now();
      const vc = registry.videos.size;
      if (vc === _allowCache.lastVideoCount && (now - _allowCache.t) < ALLOW_TTL) return _allowCache.v;

      let ok = false;
      if (vc > 0) ok = true;
      else {
        try {
          ok = !!document.querySelector('video, object, embed, [class*=player], [id*=player], [data-player]');
          // ✅ [Fix 7] 무거운 전체 DOM 스캔 대신 TreeWalker로 옵션 제한 탐색
          if (!ok && getFLAGS()?.UI_EXPENSIVE_SHADOW_PROBE) {
            let seen = 0;
            const walker = document.createTreeWalker(document.documentElement || document.body, NodeFilter.SHOW_ELEMENT);
            let node = walker.nextNode();
            while (node && seen++ < 400) {
              const sr = node.shadowRoot;
              if (sr && sr.querySelector?.('video')) { ok = true; break; }
              node = walker.nextNode();
            }
          }
        } catch (_) { ok = false; }
      }

      _allowCache = { v: ok, t: now, lastVideoCount: vc };
      return ok;
    };

    safe(() => {
      if (typeof CSS === 'undefined' || !CSS.registerProperty) return;
      for (const prop of [ { name: '--__vsc171-vv-top', syntax: '<length>', inherits: true, initialValue: '0px' }, { name: '--__vsc171-vv-h', syntax: '<length>', inherits: true, initialValue: '100vh' } ]) { try { CSS.registerProperty(prop); } catch (_) {} }
    });

    function setAndHint(path, value) { const prev = sm.get(path); const changed = !Object.is(prev, value); if (changed) sm.set(path, value); (changed ? ApplyReq.hard() : ApplyReq.soft()); }
    const getUiRoot = () => { const fs = document.fullscreenElement || null; if (fs) { if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body; return fs; } return document.body || document.documentElement; };

    function bindReactive(btn, paths, apply, sm, sub) {
      const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false;
      const sync = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); }); };
      pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); return sync;
    }

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false, isBitmask = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      for (const it of items) {
        const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text);
        b.onclick = (e) => {
          e.stopPropagation();
          if (isBitmask) {
            sm.set(key, ((Number(sm.get(key)) | 0) ^ it.value) & 7);
          } else {
            const cur = sm.get(key);
            if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
            else setAndHint(key, it.value);
          }
          ApplyReq.hard();
        };
        bindReactive(b, [key], (el, v) => el.classList.toggle('active', isBitmask ? (((Number(v) | 0) & it.value) !== 0) : v === it.value), sm, sub); row.append(b);
      }
      const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
      offBtn.onclick = (e) => { e.stopPropagation(); sm.set(key, isBitmask ? 0 : offValue); ApplyReq.hard(); };
      bindReactive(offBtn, [key], (el, v) => el.classList.toggle('active', isBitmask ? (Number(v)|0) === 0 : v === offValue), sm, sub);
      if (isBitmask || offValue != null) row.append(offBtn); return row;
    }

    const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));
    const clampPanelIntoViewport = () => {
      try {
        if (!container) return; const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI) { mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = ''; queueMicrotask(() => { const r = mainPanel.getBoundingClientRect(); if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) { mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; mainPanel.style.transform = 'translateY(-50%)'; } }); return; }
        const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
        const vv = window.visualViewport, vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0), vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
        const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0, offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
        if (!vw || !vh) return;
        const w = r.width || 300, panH = r.height || 400;
        const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8)), top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        requestAnimationFrame(() => { mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`; });
      } catch (_) {}
    };

    const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root) return; if (!vv) { root.style.setProperty('--__vsc171-vv-top', '0px'); root.style.setProperty('--__vsc171-vv-h', `${window.innerHeight}px`); return; } root.style.setProperty('--__vsc171-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--__vsc171-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
    syncVVVars(); try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); } } catch (_) {}
    const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport);
    on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(document, 'fullscreenchange', () => { setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });

    const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

    const __vscSheetCache = new Map();
    function attachShadowStyles(shadowRoot, cssText) {
      try {
        if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') {
          let sheet = __vscSheetCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __vscSheetCache.set(cssText, sheet);
          }
          shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
          return;
        }
      } catch (_) {}
      const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl);
    }

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${getNS()?.CONFIG?.VSC_ID || 'core'}`, 'data-vsc-ui': '1', 'data-vsc-id': getNS()?.CONFIG?.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' });
      const style = `
        @property --__vsc171-vv-top { syntax: "<length>"; inherits: true; initial-value: 0px; }
        @property --__vsc171-vv-h { syntax: "<length>"; inherits: true; initial-value: 100vh; }
        :host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--__vsc171-vv-top,0px) + (var(--__vsc171-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:50%!important;right:70px!important;left:auto!important;transform:translateY(-50%)!important;width:260px!important;max-height:70vh!important;padding:10px;border-radius:12px;overflow-y:auto}.main::-webkit-scrollbar{width:3px}.main::-webkit-scrollbar-thumb{background:#666;border-radius:10px}.prow{gap:3px;flex-wrap:nowrap;justify-content:center}.btn,.pbtn{min-height:34px;font-size:10.5px;padding:4px 1px;letter-spacing:-0.8px;white-space:nowrap}.header{font-size:12px;padding-bottom:5px}} .header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}
      `;
      attachShadowStyles(shadow, style);

      const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

      const autoSceneBtn = h('button', { class: 'btn', style: 'flex: 1.2;' }, '✨ 자동 씬'); bindReactive(autoSceneBtn, [P.APP_AUTO_SCENE], (el, v) => el.classList.toggle('active', !!v), sm, sub); autoSceneBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); };
      const pipBtn = h('button', { class: 'btn', style: 'flex: 0.9;', onclick: async (e) => { e.stopPropagation(); const v = getNS()?.App?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');
      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 0.9;' }, '🔍 줌'); zoomBtn.onclick = (e) => { e.stopPropagation(); const zm = getNS()?.ZoomManager; const v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return; if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); } }; bindReactive(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);
      const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.5;' }, '🔊 Brickwall (EQ+Dyn)'); boostBtn.onclick = (e) => { e.stopPropagation(); if (getNS()?.AudioWarmup) getNS().AudioWarmup(); setAndHint(P.A_EN, !sm.get(P.A_EN)); }; bindReactive(boostBtn, [P.A_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);
      const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 강조'); dialogueBtn.onclick = (e) => { e.stopPropagation(); if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE)); }; bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN], (el, v, aEn) => { el.classList.toggle('active', !!(v && aEn)); el.style.opacity = aEn ? '1' : '0.35'; el.style.cursor = aEn ? 'pointer' : 'not-allowed'; }, sm, sub);
      const pwrBtn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power'); bindReactive(pwrBtn, [P.APP_ACT], (el, v) => el.style.color = v ? '#2ecc71' : '#e74c3c', sm, sub);
      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기'); advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); }; bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
        renderButtonRow({ label: '블랙', key: P.V_SHADOW_MASK, isBitmask: true, items: [ { text: '외암', value: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' }, { text: '중암', value: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' }, { text: '심암', value: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' } ] }),
        renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
        renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }), h('hr')
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

      const bodyMain = h('div', { id: 'p-main' }, [
        h('div', { class: 'prow' }, [ autoSceneBtn, pipBtn, zoomBtn ]), h('div', { class: 'prow' }, [ boostBtn, dialogueBtn ]),
        h('div', { class: 'prow' }, [ h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'), pwrBtn, h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard(); } }, '↺ 리셋') ]),
        renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
        advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = (e) => { e.stopPropagation(); setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }; bindReactive(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => { el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01); }, sm, sub); return b; })),
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [
          { text: '◀ 30s', action: 'seek', val: -30 },
          { text: '◀ 10s', action: 'seek', val: -10 },
          { text: '⏸ 정지', action: 'pause' },
          { text: '▶ 재생', action: 'play' },
          { text: '10s ▶', action: 'seek', val: 10 },
          { text: '30s ▶', action: 'seek', val: 30 }
        ].map(cfg => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text);
          b.onclick = (e) => {
            e.stopPropagation(); const v = getNS()?.App?.getActiveVideo(); if (!v) return;
            if (cfg.action === 'play') { v.play().catch(() => {}); }
            else if (cfg.action === 'pause') { v.pause(); }
            else if (cfg.action === 'seek') {
              const isLive = !Number.isFinite(v.duration); let minT = 0, maxT = v.duration;
              if (isLive || v.duration === Infinity) { const sr = v.seekable; if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
              let target = v.currentTime + cfg.val; if (cfg.val > 0 && target >= maxT) target = maxT - 0.1;
              target = Math.max(minT, Math.min(maxT, target)); try { v.currentTime = target; } catch (_) {}
              const onSeeked = () => { v.removeEventListener('seeked', onSeeked); clearTimeout(fallbackTimer); if (Math.abs(v.currentTime - target) > 5.0) { try { v.currentTime = target; } catch (_) {} } };
              v.addEventListener('seeked', onSeeked, { once: true }); const fallbackTimer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); }, 3000);
            }
          };
          return b;
        }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]); shadow.append(mainPanel);
      let stopDrag = null;
      const startPanelDrag = (e) => {
        const pt = (e && e.touches && e.touches[0]) ? e.touches[0] : e; if (!pt) return; if (e.target && e.target.tagName === 'BUTTON') return; if (e.cancelable) e.preventDefault(); stopDrag?.(); hasUserDraggedUI = true; let startX = pt.clientX, startY = pt.clientY; const rect = mainPanel.getBoundingClientRect();
        mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`; try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(dragHandle, (ev) => { const mv = (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev; if (!mv) return; const dx = mv.clientX - startX, dy = mv.clientY - startY, panelRect = mainPanel.getBoundingClientRect(); let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx)); let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy)); mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`; }, () => { stopDrag = null; });
      };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
      if (gearHost) { gearHost.style.display = 'block'; return; }
      gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${getNS()?.CONFIG?.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
      attachShadowStyles(shadow, style);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '⚙'); shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);
      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY; const rect = gearBtn.getBoundingClientRect(); try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(gearBtn, (ev) => {
          const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
          if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); }
          if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
        }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
      };
      on(gearBtn, 'pointerdown', handleGearDrag); let lastToggle = 0, lastTouchAt = 0;
      const onGearActivate = (e) => { if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; } const now = performance.now(); if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; } lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI)); };
      on(gearBtn, 'touchend', (e) => { lastTouchAt = performance.now(); safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); onGearActivate(e); }, { passive: false });
      on(gearBtn, 'click', (e) => { const now = performance.now(); if (now - lastTouchAt < 800) { safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); return; } onGearActivate(e); }, { passive: false });
      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; const gearTarget = document.fullscreenElement || document.body || document.documentElement; try { if (gearHost && gearHost.parentNode !== gearTarget) gearTarget.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== gearTarget) gearTarget.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); const mainPanel = getMainPanel(); if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible'); } mount(); safe(() => wakeGear?.()); };
    onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });
    if (getNS()) getNS().UIEnsure = ensure;
    return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
  }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) {
      st.rateState = {
        orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0,
        _backoffLv: 0, _lastBackoffAt: 0
      };
    }
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  const restoreRateOne = (el) => { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate; } catch (_) {} };
  function ensureMobileInlinePlaybackHints(video) { if (!video || !getNS()?.CONFIG?.IS_MOBILE) return; safe(() => { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); }); }
  const onEvictRateVideo = (v) => { safe(() => restoreRateOne(v)); };
  const onEvictVideo = (v) => { if (getNS()?.Adapter) getNS().Adapter.clear(v); restoreRateOne(v); };

  const cleanupTouched = (TOUCHED) => {
    const vids = [...TOUCHED.videos]; const rateVids = [...TOUCHED.rateVideos]; TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
    const immediate = vids.filter(v => v.isConnected && getVState(v).visible); const deferred = vids.filter(v => !immediate.includes(v));
    for (const v of immediate) onEvictVideo(v); for (const v of rateVids) onEvictRateVideo(v);
    if (deferred.length > 0) {
      const cleanup = (deadline) => { while (deferred.length > 0) { if (deadline?.timeRemaining && deadline.timeRemaining() < 2) { if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 200 }); else setTimeout(cleanup, 16); return; } const v = deferred.pop(); if (!v.isConnected) onEvictVideo(v); } };
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 500 }); else setTimeout(() => { for (const v of deferred) onEvictVideo(v); }, 0);
    }
  };

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
    const softResetTransientFlags = () => {
      st.audioFailUntil = 0; st.rect = null; st.rectT = 0; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; }
      if (st.rateState) {
        st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; st.rateState._firstAttemptT = 0;
        st.rateState._backoffLv = 0; st.rateState._lastBackoffAt = 0;
      }
      ApplyReq.hard();
    };
    const combinedSignal = combineSignals(st._ac.signal, __globalSig); const opts = { passive: true, signal: combinedSignal };
    const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return; const st = getVState(v); const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return; const store = getNS()?.Store; if (!store) return; const activeVideo = getNS()?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); } }]];
    for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
  };

  let __lastApplyTarget = null;
  function clearVideoRuntimeState(el, Adapter, ApplyReq) { const st = getVState(el); Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); if (st._ac) { st._ac.abort(); st._ac = null; } st.bound = false; bindVideoOnce(el, ApplyReq); }

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el);
    const now = performance.now();

    if (now < (rSt.suppressSyncUntil || 0)) return;

    if (rSt.orig == null) rSt.orig = el.playbackRate;

    const rateMatches = Math.abs(el.playbackRate - desiredRate) < 0.01;

    if (Object.is(st.desiredRate, desiredRate) && rateMatches) {
      if ((rSt._backoffLv | 0) > 0 && (now - (rSt._lastBackoffAt || 0)) > 1200) {
        rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
      touchedAdd(TOUCHED.rateVideos, el);
      return;
    }

    if (!rSt._firstAttemptT || (now - rSt._firstAttemptT) > 2500) {
      rSt._firstAttemptT = now;
      rSt._setAttempts = 0;
    }

    rSt._setAttempts++;

    if (rSt._setAttempts > 6) {
      const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
      rSt._backoffLv = lv;
      rSt._lastBackoffAt = now;

      const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
      rSt.suppressSyncUntil = now + backoffMs + ((Math.random() * 220) | 0);

      rSt._setAttempts = 0;
      return;
    }

    st.desiredRate = desiredRate;
    markInternalRateChange(el, 250);

    try { el.playbackRate = desiredRate; } catch (_) {}

    requestAnimationFrame(() => {
      if (!el.isConnected) return;

      if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
        markInternalRateChange(el, 250);
        try { el.playbackRate = desiredRate; } catch (_) {}

        requestAnimationFrame(() => {
          if (!el.isConnected) return;

          if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
            const n2 = performance.now();
            const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
            rSt._backoffLv = lv;
            rSt._lastBackoffAt = n2;

            const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
            const until = n2 + backoffMs + ((Math.random() * 220) | 0);

            rSt.suppressSyncUntil = Math.max(rSt.suppressSyncUntil || 0, until);
            rSt._setAttempts = 0;
          } else {
            if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
          }
        });
      } else {
        if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
    });

    touchedAdd(TOUCHED.rateVideos, el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, scratch }) {
    const candidates = scratch;
    candidates.clear();
    for (const set of [dirtyVideos, TOUCHED.videos, TOUCHED.rateVideos, applySet]) {
      for (const v of set) if (v?.tagName === 'VIDEO') candidates.add(v);
    }
    for (const el of candidates) {
      if (!el.isConnected) {
        Adapter.clear(el);
        restoreRateOne(el);
        TOUCHED.videos.delete(el);
        TOUCHED.rateVideos.delete(el);
        continue;
      }

      const st = getVState(el);
      const visible = (st.visible !== false);
      const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));

      if (!shouldApply) {
        if (!st.applied && !st.fxBackend && st.desiredRate === undefined) continue;
        clearVideoRuntimeState(el, Adapter, ApplyReq);
        continue;
      }

      if (videoFxOn) {
        Adapter.apply(el, vVals);
        touchedAdd(TOUCHED.videos, el);
      } else {
        Adapter.clear(el);
        TOUCHED.videos.delete(el);
      }

      if (pbActive) {
        applyPlaybackRate(el, desiredRate);
      } else {
        st.desiredRate = undefined;
        restoreRateOne(el);
        TOUCHED.rateVideos.delete(el);
      }
      bindVideoOnce(el, ApplyReq);
    }
  }

  function createVideoParamsMemo(Store, P) {
    const getDetailLevel = (presetKey) => { const k = String(presetKey || 'off').toUpperCase().trim(); if (k === 'XL') return 'xl'; if (k === 'L') return 'l'; if (k === 'M') return 'm'; if (k === 'S') return 's'; return 'off'; };
    const SHADOW_PARAMS = new Map([[SHADOW_BAND.DEEP, { toe: 2.8, gamma: -0.03, mid: 0 }], [SHADOW_BAND.MID, { toe: 1.6, gamma: 0, mid: -0.06 }], [SHADOW_BAND.OUTER, { toe: 0, gamma: -0.02, mid: -0.12 }]]);
    return {
      get(vfUser, activeVideo) {
        const detailP = PRESETS.detail[vfUser.presetS || 'off']; const gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'];
        const out = { sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0, satF: detailP.sat || 1.0, gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, temp: 0, gain: 1.0, mid: 0, toe: 0, shoulder: 0 };
        const sMask = vfUser.shadowBandMask || 0;
        if (sMask > 0) {
          let toeSum = 0, gammaSum = 0, midSum = 0; for (const [bit, params] of SHADOW_PARAMS) { if (sMask & bit) { toeSum += params.toe; gammaSum += params.gamma; midSum += params.mid; } }
          const bandCount = ((sMask & 1) + ((sMask >> 1) & 1) + ((sMask >> 2) & 1)); const combinedAttenuation = bandCount > 1 ? Math.pow(0.82, bandCount - 1) : 1.0;
          out.toe = VSC_CLAMP(toeSum * combinedAttenuation, 0, 3.0); out.gamma += gammaSum * combinedAttenuation; out.mid += midSum * combinedAttenuation;
        }
        out.mid = VSC_CLAMP(out.mid, -0.20, 0); const brStep = vfUser.brightStepLevel || 0;
        if (brStep > 0) { out.bright += brStep * 3.5; out.toe = Math.max(0, out.toe * (1.0 - brStep * 0.18)); out.gamma *= (1.0 + brStep * 0.025); }
        const { rs, gs, bs } = tempToRgbGain(out.temp); out._rs = rs; out._gs = gs; out._bs = bs; out.__detailLevel = getDetailLevel(vfUser.presetS); return out;
      }
    };
  }

  function isNeutralVideoParams(p) {
    const near = (a, b, eps = 1e-4) => Math.abs((a || 0) - b) <= eps;
    return (
      (p.sharp|0) === 0 && (p.sharp2|0) === 0 && (p.clarity|0) === 0 &&
      near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) &&
      near(p.satF, 1.0) && near(p.temp, 0.0) && near(p.gain, 1.0) &&
      near(p.mid, 0.0) && near(p.toe, 0.0) && near(p.shoulder, 0.0)
    );
  }

  function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
    UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });
    let __activeTarget = null, __lastAudioTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
    const videoParamsMemo = createVideoParamsMemo(Store, P);

    const _applySet = new Set();
    const _scratchCandidates = new Set();

    function updateQualityScale(v) {
      if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale; const now = performance.now(); if (now - lastQCheck < 2000) return qualityScale; lastQCheck = now;
      try {
        const q = v.getVideoPlaybackQuality(); const dropped = Number(q.droppedVideoFrames || 0), total = Number(q.totalVideoFrames || 0);
        const dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0)), dTotal = Math.max(0, total - (__lastQSample.total || 0)); __lastQSample = { dropped, total };
        if (dTotal < 30 || total < 300) return qualityScale;
        const ratio = dDropped / dTotal, target = ratio > 0.20 ? 0.65 : (ratio > 0.12 ? 0.85 : 1.0), alpha = target < qualityScale ? 0.15 : 0.12; qualityScale = qualityScale * (1 - alpha) + target * alpha;
      } catch (_) {} return qualityScale;
    }

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active; if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }
        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        let pick = Targeting.pickFastActiveOnly(visible.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);

        if (!pick?.target) {
          pick = Targeting.pickFastActiveOnly(Registry.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        }

        if (!pick?.target) {
          let domV = null;
          try {
            const list = Array.from(document.querySelectorAll('video'));
            domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) ||
                   list.find(v => v && v.readyState >= 2) ||
                   null;
          } catch (_) {}
          pick = { target: domV };
        }

        let nextTarget = pick.target;

        if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; } if (nextTarget !== __activeTarget) __activeTarget = nextTarget;
        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now();
        // ✅ [Fix 21] vidsDirty가 40개를 넘어가면 2초 대기 없이 즉시 Prune 처리하여 성능 저하 방지
        const dirtySize = vidsDirty.size;
        if (dirtySize > 40 || (now - lastPrune > 2000)) {
          Registry.prune();
          lastPrune = now;
        }

        const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
        if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; } Audio.update();

        const vf0 = Store.getCatRef('video'); let vValsEffective = videoParamsMemo.get(vf0, __activeTarget);
        const autoScene = getNS()?.AutoScene; const qs = updateQualityScale(__activeTarget);

        vValsEffective._qs = qs;

        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);

        // ✅ [Fix 3] applySet 기준 통합 최대 해상도를 힌트로 전달하여 filterRes 안정화
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        let maxW = 0, maxH = 0;
        if (applyToAllVisibleVideos) {
          for (const v of visible.videos) {
            const stv = getVState(v);
            const r = stv.rect;
            if (r && r.width > 0 && r.height > 0) {
              maxW = Math.max(maxW, Math.round(r.width * dpr));
              maxH = Math.max(maxH, Math.round(r.height * dpr));
            }
          }
        } else if (__activeTarget) {
          const r = getRectCached(__activeTarget, performance.now(), 500);
          if (r && r.width > 0 && r.height > 0) {
            maxW = Math.round(r.width * dpr);
            maxH = Math.round(r.height * dpr);
          }
        }

        if (maxW > 0 && maxH > 0) {
          vValsEffective._frW = maxW;
          vValsEffective._frH = maxH;
        } else {
          delete vValsEffective._frW;
          delete vValsEffective._frH;
        }

        const autoSceneVVals = {};
        if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
          const mods = autoScene.getMods();
          if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
            Object.assign(autoSceneVVals, vValsEffective); const uBr = autoSceneVVals.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
            autoSceneVVals.gain = uBr * (1.0 + (mods.br - 1.0) * aSF); autoSceneVVals.contrast = (autoSceneVVals.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF); autoSceneVVals.satF = (autoSceneVVals.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
            const userSharpTotal = (autoSceneVVals.sharp || 0) + (autoSceneVVals.sharp2 || 0) + (autoSceneVVals.clarity || 0), sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5);
            const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF);
            autoSceneVVals.sharp = (autoSceneVVals.sharp || 0) * combinedSharpScale; autoSceneVVals.sharp2 = (autoSceneVVals.sharp2 || 0) * combinedSharpScale; autoSceneVVals.clarity = (autoSceneVVals.clarity || 0) * combinedSharpScale; vValsEffective = autoSceneVVals;
          }
        }

        const videoFxOn = !isNeutralVideoParams(vValsEffective);

        _applySet.clear();
        if (applyToAllVisibleVideos) { for (const v of visible.videos) _applySet.add(v); }
        else if (__activeTarget) _applySet.add(__activeTarget);

        const desiredRate = Store.get(P.PB_RATE);
        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates });

        UI.ensure();
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisibilityHandler = null;
    const startTick = () => {
      stopTick(); tickVisibilityHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) { Scheduler.request(false); } };
      document.addEventListener('visibilitychange', tickVisibilityHandler, { passive: true });
      tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000);
    };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; if (tickVisibilityHandler) { document.removeEventListener('visibilitychange', tickVisibilityHandler); tickVisibilityHandler = null; } };

    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();

    return Object.freeze({
      getActiveVideo() {
        if (__activeTarget && __activeTarget.isConnected) return __activeTarget;
        let domV = null;
        try {
          const list = Array.from(document.querySelectorAll('video'));
          domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) ||
                 list.find(v => v && v.readyState >= 2) ||
                 null;
        } catch (_) {}
        if (domV) { __activeTarget = domV; Scheduler.request(true); }
        return domV;
      },
      getQualityScale() { return qualityScale; },
      destroy() {
        stopTick();
        safe(() => UI.destroy?.());
        safe(() => { Audio.setTarget(null); Audio.destroy?.(); });
        safe(() => getNS()?.AutoScene?.destroy?.());
        safe(() => Registry.destroy?.());
        safe(() => __globalHooksAC.abort());
        safe(() => getNS()?._restorePatchedGlobals?.());
        safe(() => getNS()?._restoreHistory?.()); // ✅ [Fix 8]
        safe(() => { (getNS()?._timers || []).forEach(clearTimeout); getNS()._timers = []; }); // ✅ [Fix 9]
        safe(() => { try { __shadowRootCallbacks.clear(); } catch (_) {} }); // ✅ [Fix 19]
      }
    });
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(32);
  const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  function bindNormalizer(keys, schema) { const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); }; keys.forEach(k => Store.sub(k, run)); run(); }
  bindNormalizer(ALL_KEYS, ALL_SCHEMA);

  const Registry = createRegistry(Scheduler);
  const Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();

    // ✅ [Fix 9] lateRescan 타이머 아이디 보관 (destroy 누수 방지)
    __vscNs._timers = __vscNs._timers || [];
    const lateRescanDelays = [3000, 5000, 10000, 20000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => { safe(() => { Registry.rescanAll(); Scheduler.request(true); safe(() => getNS()?.UIEnsure?.()); }); }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();
    const AutoScene = createAutoSceneManager(Store, P, Scheduler); __vscNs.AutoScene = AutoScene;

    __vscNs.CONFIG = CONFIG;
    __vscNs.FLAGS = Object.freeze({ ...FLAGS });

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter;

    const Audio = createAudio(Store); __vscNs.AudioWarmup = Audio.warmup;
    let ZoomManager = createZoomManager(); __vscNs.ZoomManager = ZoomManager;
    const UI = createUI(Store, Registry, ApplyReq, Utils);

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT< 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false)); }
    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
      on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
    }
    const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
    __vscNs.App = __VSC_APP__;

    if (getFLAGS().SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) {
      const can = typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      if (can) __vscNs._schedAlignRvfc = true;
    }
    Scheduler.setRvfcSource(() => __VSC_APP__.getActiveVideo() || null);

    AutoScene.start();

    on(window, 'keydown', async (e) => {
      if (isEditableTarget(e.target)) return;
      if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); safe(() => { const st = getNS()?.Store; if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); } }); return; }
      if (e.altKey && e.shiftKey && e.code === 'KeyP') { const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v); }
    }, { capture: true });

    on(document, 'visibilitychange', () => { safe(() => checkAndCleanupClosedPiP()); safe(() => { if (document.visibilityState === 'visible') getNS()?.ApplyReq?.hard(); }); }, OPT_P);
    window.addEventListener('beforeunload', () => { safe(() => __VSC_APP__?.destroy()); }, { once: true });
  });

} // VSC_MAIN 함수의 닫는 중괄호
VSC_MAIN();
})();
