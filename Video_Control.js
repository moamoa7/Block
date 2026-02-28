// ==UserScript==
// @name         Video_Control (v170.59.0 - Ultimate Cinema EQ & Sharpness)
// @namespace    https://github.com/
// @version      170.59.0
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
// @allFrames    true
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

    const safe = (fn) => { try { fn(); } catch (_) {} };
    const OPT_P = { passive: true };
    const OPT_PC = { passive: true, capture: true };

    const SYS = Object.freeze({
      WFC: 5000, WFT: 3, AFC: 5000, SRD: 220, SLM: 24, MAX_CTX: 8
    });

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

    function on(target, type, fn, opts = {}) {
      const merged = { ...opts };
      if (!merged.signal) merged.signal = __globalSig;
      try { target.addEventListener(type, fn, merged); } catch (_) {}
    }

    let shadowEmitterInstalled = false;
    function installShadowRootEmitterIfNeeded() {
      if (shadowEmitterInstalled) return;
      if (document.querySelectorAll('video').length > 0) return;
      shadowEmitterInstalled = true;

      const proto = Element.prototype, orig = proto.attachShadow;
      if (typeof orig !== 'function') return;
      const patchedAttachShadow = function(init) {
        const sr = orig.call(this, init);
        safe(() => document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: sr })));
        return sr;
      };
      try { Object.defineProperty(proto, 'attachShadow', { value: patchedAttachShadow, configurable: true, writable: true }); } catch (_) {
        try { proto.attachShadow = patchedAttachShadow; } catch (__) {}
      }
      queueMicrotask(() => {
        try {
          const base = document.documentElement || document.body;
          if (!base) return;
          const tw = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
          let n = tw.currentNode, seen = 0;
          while ((n = tw.nextNode()) && seen < 2500) {
            seen++;
            const sr = n.shadowRoot;
            if (sr) safe(() => document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: sr })));
          }
        } catch (_) {}
      });
    }

    function onPageReady(fn) {
      let ran = false;
      const ac = new AbortController();
      const run = () => {
        if (ran) return;
        ran = true;
        ac.abort();
        try { fn(); } catch (e) { console.error('[VSC]', e); }
      };
      const check = () => {
        if (document.visibilityState === 'visible' && (document.readyState === 'interactive' || document.readyState === 'complete')) {
          run();
          return true;
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
      try {
        if (navigator.userAgentData?.mobile === true) return true;
        if ((navigator.maxTouchPoints || 0) >= 2 && matchMedia('(pointer: coarse)').matches) return true;
        return /Mobi|Android|iPhone/i.test(navigator.userAgent);
      } catch (_) { return false; }
    }

    const DEBUG_BY_URL = /[?&]vsc_debug=1\b/.test(location.search);
    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""),
      DEBUG: DEBUG_BY_URL
    });

    const VSC_VERSION = '170.59.0';
    const VSC_SYNC_TOKEN = `VSC_SYNC_${VSC_VERSION}_${CONFIG.VSC_ID}`;
    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    const log = CONFIG.DEBUG ? {
      error: (...a) => console.error('[VSC]', ...a),
      warn: (...a) => console.warn('[VSC]', ...a),
      info: (...a) => console.info('[VSC]', ...a),
      debug: (...a) => console.debug('[VSC]', ...a)
    } : {
      error: (...a) => console.error('[VSC]', ...a),
      warn: (...a) => console.warn('[VSC]', ...a),
      info: () => {}, debug: () => {}
    };

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      if (Math.abs(t) < 1e-4) return { rs: 1, gs: 1, bs: 1 };
      const r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t);
      const m = t > 0 ? r : b;
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    function smoothstep(a, b, x) {
      const t = VSC_CLAMP((x - a) / Math.max(1e-6, (b - a)), 0, 1);
      return t * t * (3 - 2 * t);
    }

    function computeToneCurve(steps, toeN, midN, shoulderN, gain) {
      const clamp = VSC_CLAMP;
      const g = Math.log2(Math.max(1e-6, gain)) * 0.90;
      const denom = Math.abs(g) > 1e-6 ? (1 - Math.exp(-g)) : 0;
      const useExp = Math.abs(denom) > 1e-6;
      const toeEnd = 0.34 + Math.abs(toeN) * 0.06;
      const toeAmt = Math.abs(toeN), toeSign = toeN >= 0 ? 1 : -1;
      const shoulderStart = 0.90 - shoulderN * 0.10, shAmt = Math.abs(shoulderN);

      const out = new Float32Array(steps);
      let prev = 0;
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1);
        let x = useExp ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
        if (toeAmt > 1e-6) {
          const w = 1 - smoothstep(0, toeEnd, x);
          x = clamp(x + toeSign * toeAmt * 0.55 * ((toeEnd - x) * w * w), 0, 1);
        }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart));
          const kk = Math.max(0.7, 1.2 + shAmt * 6.5);
          const shDen = (1 - Math.exp(-kk));
          const shMap = (Math.abs(shDen) > 1e-6) ? ((1 - Math.exp(-kk * tt)) / shDen) : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        if (x < prev + 1e-6 / steps) x = prev + 1e-6;
        prev = x;
        out[i] = x;
      }
      return out;
    }

    const VSC_MEDIA = {
      get isHdr() {
        try { return matchMedia('(dynamic-range: high)').matches; } catch { return false; }
      }
    };

    const HIDE_AMBIENT_KEY = 'vsc.hideAmbientGlow';
    function setHideAmbientGlow(enable) {
      try {
        const isYouTube = /youtube\.com|youtu\.be/.test(location.hostname);
        if (!isYouTube) return;
        const id = 'vsc-hide-ambient-style';
        let style = document.getElementById(id);
        if (enable) {
          if (!style) {
            style = document.createElement('style');
            style.id = id;
            style.textContent = `#cinematics, .ytp-glow-effect, .ytp-glow-canvas-container, [id^="ambient-"] { display: none !important; contain: strict !important; }`;
            (document.head || document.documentElement).appendChild(style);
          }
        } else {
          style?.remove?.();
        }
        safe(() => localStorage.setItem(HIDE_AMBIENT_KEY, enable ? '1' : '0'));
      } catch (_) {}
    }

    setHideAmbientGlow((() => {
      try {
        const v = localStorage.getItem(HIDE_AMBIENT_KEY);
        if (v === '1') return true;
        if (v === '0') return false;
      } catch (_) {}
      return true;
    })());

    const videoStateMap = new WeakMap();
    const getVState = (v) => {
      let st = videoStateMap.get(v);
      if (!st) {
        st = { visible: false, rect: null, rectT: 0, bound: false, applied: false, fxBackend: null, lastFilterUrl: null, rateState: null, desiredRate: undefined, audioFailUntil: 0, _ac: null, _lastSrc: '' };
        videoStateMap.set(v, st);
      }
      return st;
    };

    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({
      has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; },
      toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); }
    });

    const PRESETS = Object.freeze({
      detail: {
        off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 },
        S: { sharpAdd: 14, sharp2Add: 2, clarityAdd: 4 },
        M: { sharpAdd: 16, sharp2Add: 10, clarityAdd: 10 },
        L: { sharpAdd: 14, sharp2Add: 26, clarityAdd: 12 },
        XL: { sharpAdd: 18, sharp2Add: 16, clarityAdd: 24 }
      },
      grade: {
        brOFF: { gammaF: 1.00, brightAdd: 0 },
        S: { gammaF: 1.02, brightAdd: 1.8 },
        M: { gammaF: 1.07, brightAdd: 4.4 },
        L: { gammaF: 1.15, brightAdd: 9 },
        DS: { gammaF: 1.05, brightAdd: 3.6 },
        DM: { gammaF: 1.10, brightAdd: 7.2 },
        DL: { gammaF: 1.20, brightAdd: 10.8 }
      }
    });

    const DEFAULTS = {
      video: { presetS: 'off', presetB: 'brOFF', shadowBandMask: 0, brightStepLevel: 0 },
      audio: { enabled: false, boost: 0, multiband: true, lufs: true, dialogue: false },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, renderMode: 'svg', zoomEn: false, autoScene: false, advanced: false, hdrToneMap: false }
    };

    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll',
      APP_RENDER_MODE: 'app.renderMode', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', APP_HDR_TONEMAP: 'app.hdrToneMap',
      V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel',
      A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    const APP_SCHEMA = [
      { type: 'enum', path: P.APP_RENDER_MODE, values: ['svg', 'webgl'], fallback: () => 'svg' },
      { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_HDR_TONEMAP }
    ];
    const VIDEO_SCHEMA = [
      { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS },
      { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB },
      { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 }
    ];
    const AUDIO_PLAYBACK_SCHEMA = [
      { type: 'bool', path: P.A_EN },
      { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => 0 },
      { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE },
      { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate }
    ];

    const TOUCHED = { videos: new Set(), rateVideos: new Set() };
    function touchedAddLimited(set, el, onEvict) {
      if (!el) return;
      set.add(el);
      if (set.size > CONFIG.TOUCHED_MAX) {
        for (const v of set) {
          if (!v.isConnected) {
            set.delete(v);
            safe(() => onEvict?.(v));
          }
        }
      }
    }

    function getRectCached(v, now, maxAgeMs = 800) {
      const st = getVState(v);
      const t0 = st.rectT || 0;
      let r = st.rect;
      if (!r || (now - t0) > maxAgeMs) {
        r = v.getBoundingClientRect();
        st.rect = r;
        st.rectT = now;
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

    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return;
      window.__VSC_SPA_PATCHED__ = true;
      let lastHref = location.href;
      const emitIfChanged = () => {
        const next = location.href;
        if (next === lastHref) return;
        lastHref = next; onChanged();
      };
      const wrap = (name) => {
        const orig = history[name];
        if (typeof orig !== 'function') return;
        history[name] = function (...args) {
          const ret = Reflect.apply(orig, this, args);
          queueMicrotask(emitIfChanged);
          return ret;
        };
      };
      wrap('pushState'); wrap('replaceState');
      on(window, 'popstate', emitIfChanged, OPT_P);
    }

    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigCss = '';

    function resetPiPState() {
      __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigCss = "";
    }

    function checkAndCleanupClosedPiP() {
      if (__activeDocumentPiPWindow && __activeDocumentPiPWindow.closed && __activeDocumentPiPVideo) {
        restoreFromDocumentPiP(__activeDocumentPiPVideo);
      }
    }

    function getActivePiPVideo() {
      if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
      if (__activeDocumentPiPWindow && __activeDocumentPiPVideo && !__activeDocumentPiPWindow.closed) {
        return __activeDocumentPiPVideo;
      }
      return null;
    }

    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

    async function enterDocumentPiP(video) {
      const wasPlaying = !video.paused;
      const pipWindow = await window.documentPictureInPicture.requestWindow({
        width: Math.max(video.videoWidth / 2, 400),
        height: Math.max(video.videoHeight / 2, 225)
      });
      __activeDocumentPiPWindow = pipWindow;
      __activeDocumentPiPVideo = video;
      __pipOrigParent = video.parentNode;
      __pipOrigCss = video.style.cssText;
      __pipPlaceholder = document.createElement('div');
      Object.assign(__pipPlaceholder.style, { width: video.clientWidth + 'px', height: video.clientHeight + 'px', background: 'black' });
      __pipOrigParent?.insertBefore(__pipPlaceholder, video);
      Object.assign(pipWindow.document.body.style, { margin: '0', display: 'flex', justifyContent: 'center', alignItems: 'center', background: 'black' });
      Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'contain' });
      pipWindow.document.body.append(video);
      if (wasPlaying && video.paused) {
        video.play().catch(() => {});
      }
      const onClick = () => { video.paused ? video.play()?.catch?.(() => {}) : video.pause(); };
      pipWindow.addEventListener('click', onClick);
      pipWindow.addEventListener('pagehide', () => {
        pipWindow.removeEventListener('click', onClick);
        restoreFromDocumentPiP(video);
      });
      return true;
    }

    function restoreFromDocumentPiP(video) {
      if (!video) { resetPiPState(); return; }
      try {
        video.style.cssText = __pipOrigCss || '';
        if (__pipPlaceholder?.parentNode?.isConnected) {
          __pipPlaceholder.parentNode.insertBefore(video, __pipPlaceholder);
          __pipPlaceholder.remove();
        } else if (__pipOrigParent?.isConnected) {
          __pipOrigParent.appendChild(video);
        } else {
          (document.body || document.documentElement)?.appendChild(video);
        }
      } catch (e) {
        log.warn('PiP restore failed:', e);
      } finally {
        resetPiPState();
        safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard());
      }
    }

    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      if (window.documentPictureInPicture?.requestWindow) {
        if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed) return true;
        try { return await enterDocumentPiP(video); } catch (e) { log.debug('Document PiP failed', e); }
      }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        try { await video.requestPictureInPicture(); return true; } catch (_) {}
      }
      return false;
    }

    async function exitPiP(preferredVideo = null) {
      if (__activeDocumentPiPWindow) {
        const video = __activeDocumentPiPVideo;
        if (!__activeDocumentPiPWindow.closed) __activeDocumentPiPWindow.close();
        if (video && __activeDocumentPiPVideo === video) restoreFromDocumentPiP(video);
        return true;
      }
      if (document.pictureInPictureElement && document.exitPictureInPicture) {
        try { await document.exitPictureInPicture(); return true; } catch (_) {}
      }
      return false;
    }

    async function togglePiPFor(video) {
      if (!video || video.readyState < 2) return false;
      if ((__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed) || document.pictureInPictureElement === video) return exitPiP(video);
      if (document.pictureInPictureElement && document.exitPictureInPicture) {
        try { await document.exitPictureInPicture(); } catch (_) {}
      }
      return enterPiP(video);
    }

    function createZoomManager() {
      const stateMap = new WeakMap();
      let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
      let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };

      const getSt = (v) => {
        let st = stateMap.get(v);
        if (!st) {
          st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '', origComputedPosition: '' };
          stateMap.set(v, st);
        }
        return st;
      };

      const update = (v) => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const st = getSt(v);
          v.style.transition = isPanning || pinchState.active ? 'none' : 'transform 0.1s ease-out';
          if (st.scale <= 1) {
            st.scale = 1; st.tx = 0; st.ty = 0;
            v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = '';
            if (st.zoomed) {
              v.style.zIndex = st.origZIndex; v.style.position = st.origPosition; st.zoomed = false; st.origComputedPosition = '';
            }
          } else {
            if (!st.zoomed) {
              st.origZIndex = v.style.zIndex; st.origPosition = v.style.position; st.origComputedPosition = '';
              try { st.origComputedPosition = window.getComputedStyle(v).position; } catch (_) {}
              st.zoomed = true;
              if (st.origComputedPosition === 'static') v.style.position = 'relative';
            }
            v.style.transformOrigin = '0 0';
            v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
            v.style.cursor = isPanning ? 'grabbing' : 'grab';
            v.style.zIndex = '2147483646';
          }
        });
      };

      const zoomTo = (v, newScale, clientX, clientY) => {
        const st = getSt(v);
        const rect = v.getBoundingClientRect();
        const ix = (clientX - rect.left) / st.scale;
        const iy = (clientY - rect.top) / st.scale;
        st.tx = clientX - (rect.left - st.tx) - ix * newScale;
        st.ty = clientY - (rect.top - st.ty) - iy * newScale;
        st.scale = newScale;
        update(v);
      };

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
        if (!v && window.__VSC_INTERNAL__?.App) v = window.__VSC_INTERNAL__.App.getActiveVideo();
        return v;
      }

      on(window, 'wheel', e => {
        if (!e.altKey) return;
        const v = getTargetVideo(e);
        if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const st = getSt(v);
        let newScale = Math.min(Math.max(1, st.scale * delta), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
      }, { passive: false, capture: true });

      on(window, 'mousedown', e => {
        if (!e.altKey) return;
        const v = getTargetVideo(e);
        if (!v) return;
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
        update(activeVideo);
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
        const v = getTargetVideo(e);
        if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
      }, { capture: true });

      on(window, 'touchstart', e => {
        if (CONFIG.IS_MOBILE && !isZoomEnabled()) return;
        const v = getTargetVideo(e);
        if (!v) return;
        const st = getSt(v);
        if (e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          activeVideo = v; pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches);
          pinchState.initialScale = st.scale;
          const c = getTouchCenter(e.touches);
          pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        } else if (e.touches.length === 1 && st.scale > 1) {
          activeVideo = v; isPanning = true; st.hasPanned = false;
          startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
        }
      }, { passive: false, capture: true });

      on(window, 'touchmove', e => {
        if (!activeVideo) return;
        const st = getSt(activeVideo);
        if (pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
          let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist));
          newScale = Math.min(Math.max(1, newScale), 10);
          if (newScale < 1.05) {
            resetZoom(activeVideo); pinchState.active = false;
          } else {
            zoomTo(activeVideo, newScale, center.x, center.y);
            st.tx += center.x - pinchState.lastCx;
            st.ty += center.y - pinchState.lastCy;
            update(activeVideo);
          }
          pinchState.lastCx = center.x; pinchState.lastCy = center.y;
        } else if (isPanning && e.touches.length === 1) {
          if (e.cancelable) e.preventDefault();
          const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
          st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY;
          update(activeVideo);
        }
      }, { passive: false, capture: true });

      on(window, 'touchend', e => {
        if (!activeVideo) return;
        if (e.touches.length < 2) pinchState.active = false;
        if (e.touches.length === 0) {
          if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) e.preventDefault();
          isPanning = false; update(activeVideo); activeVideo = null;
        }
      }, { passive: false, capture: true });

      return { resetZoom, zoomTo, isZoomed };
    }
function createTargeting() {
      let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now();
        const vp = getViewportSnapshot();
        let best = null, bestScore = -Infinity;

        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, now, 800);
          const area = r.width * r.height;
          const pip = isPiPActiveVideo(v);
          if (area < 160 * 120 && !pip) return;

          const cx = r.left + r.width * 0.5;
          const cy = r.top + r.height * 0.5;
          let s = 0;

          if (!v.paused && !v.ended) s += 6.0;
          else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;

          if (v.currentTime > 0.2) s += 2.0;
          s += Math.log2(1 + area / 20000) * 1.1;

          const ptAge = Math.max(0, now - (lastUserPt.t || 0));
          const userBias = Math.exp(-ptAge / 1800);
          const dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
          s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500);

          const cdx = cx - vp.cx, cdy = cy - vp.cy;
          s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);

          const isLikelyAd = (vid) => {
            const parent = vid.closest('[class*=ad],[class*=Ad],[id*=ad],[data-ad]');
            if (parent) return true;
            if (r.width <= 400 && r.height <= 300 && vid.duration < 60) return true;
            return false;
          };

          if (v.muted || v.volume < 0.01) s -= 1.5;
          if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
          if (isLikelyAd(v)) s -= 5.0;
          if (!v.controls && !v.closest('[class*=player]')) s -= 1.0;
          if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
          if (pip) s += 3.0;

          if (s > bestScore) { bestScore = s; best = v; }
        };

        for (const v of videos) evalScore(v);
        const activePip = getActivePiPVideo();
        if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);

        const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
        if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
          if (best && stickyTarget !== best && (bestScore < stickyScore + hysteresis)) {
            return { target: stickyTarget };
          }
        }

        stickyTarget = best;
        stickyScore = bestScore;
        stickyUntil = now + 1000;
        return { target: best };
      }
      return Object.freeze({ pickFastActiveOnly });
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
      function clearPending() {
        if (timer) { clearTimeout(timer); timer = 0; }
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      }
      function queueRaf() {
        if (rafId) return;
        rafId = requestAnimationFrame(run);
      }
      function timerCb() { timer = 0; queueRaf(); }
      function run() {
        rafId = 0; queued = false;
        const now = performance.now();
        const doForce = force;
        force = false;
        const dt = now - lastRun;

        if (!doForce && dt < minIntervalMs) {
          const wait = Math.max(0, minIntervalMs - dt);
          if (!timer) timer = setTimeout(timerCb, wait);
          return;
        }

        lastRun = now;
        if (applyFn) { safe(() => applyFn(doForce)); }
      }
      const request = (immediate = false) => {
        if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; }
        if (queued) return;
        queued = true; clearPending(); queueRaf();
      };
      return { registerApply: (fn) => { applyFn = fn; }, request };
    }

    const parsePath = (p) => {
      const dot = p.indexOf('.');
      return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)];
    };

    function createLocalStore(defaults, scheduler, Utils) {
      const state = structuredClone(defaults);
      let rev = 0;
      const listeners = new Map();

      try {
        const saved = localStorage.getItem('vsc_user_prefs_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.video) Object.assign(state.video, parsed.video);
          if (parsed.audio) Object.assign(state.audio, parsed.audio);
          if (parsed.playback) Object.assign(state.playback, parsed.playback);
          if (parsed.app) Object.assign(state.app, parsed.app);
        }
      } catch (_) {}

      const savePrefs = createDebounced(() => {
        safe(() => localStorage.setItem('vsc_user_prefs_v1', JSON.stringify(state)));
      }, 1000);

      const emit = (path, val) => {
        const cbs = listeners.get(path);
        if (cbs) { for (const cb of cbs) safe(() => cb(val)); }
        const dot = path.indexOf('.');
        if (dot > 0) {
          const catStar = path.slice(0, dot) + '.*';
          const cbsStar = listeners.get(catStar);
          if (cbsStar) { for (const cb of cbsStar) safe(() => cb(val)); }
        }
      };

      const notifyChange = (path, val) => {
        rev++;
        emit(path, val);
        savePrefs();
        scheduler.request(false);
      };

      return {
        state, rev: () => rev, getCatRef: (cat) => state[cat],
        get: (p) => {
          const [cat, key] = parsePath(p);
          return key ? state[cat]?.[key] : state[cat];
        },
        set: (p, val) => {
          const [cat, key] = parsePath(p);
          const target = key ? state[cat] : state;
          const prop = key || cat;
          if (Object.is(target[prop], val)) return;
          target[prop] = val;
          notifyChange(p, val);
        },
        batch: (cat, obj) => {
          let changed = false;
          for (const [k, v] of Object.entries(obj)) {
            if (state[cat][k] !== v) {
              state[cat][k] = v;
              changed = true;
              emit(`${cat}.${k}`, v);
            }
          }
          if (changed) { rev++; savePrefs(); scheduler.request(false); }
        },
        sub: (k, f) => {
          let s = listeners.get(k);
          if (!s) { s = new Set(); listeners.set(k, s); }
          s.add(f);
          return () => listeners.get(k)?.delete(f);
        }
      };
    }

    function normalizeBySchema(sm, schema) {
      let changed = false;
      const set = (path, val) => {
        if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; }
      };
      for (const { type, path, values, fallback, min, max, round } of schema) {
        switch (type) {
          case 'bool': set(path, !!sm.get(path)); break;
          case 'enum': { const cur = sm.get(path); if (!values.includes(cur)) set(path, fallback()); break; }
          case 'num': {
            let n = Number(sm.get(path));
            if (!Number.isFinite(n)) n = fallback();
            if (round) n = Math.round(n);
            set(path, Math.max(min, Math.min(max, n)));
            break;
          }
        }
      }
      return changed;
    }

    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() };
      let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
      const shadowRootsLRU = [];
      const observedShadowHosts = new WeakSet();
      let __refreshQueued = false;

      function requestRefreshCoalesced() {
        if (__refreshQueued) return;
        __refreshQueued = true;
        requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); });
      }

      const ioMargin = `${Math.min(200, Math.round((window.innerHeight || 1080) * 0.2))}px`;
      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
        let changed = false;
        const now = performance.now();
        for (const e of entries) {
          const el = e.target;
          const isVis = e.isIntersecting || e.intersectionRatio > 0;
          const st = getVState(el);
          st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now;

          if (isVis) {
            if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; }
          } else {
            if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; }
          }
        }
        if (changed) { rev++; requestRefreshCoalesced(); }
      }, { root: null, threshold: 0.01, rootMargin: ioMargin }) : null;

      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

      const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
        let changed = false; const now = performance.now();
        for (const e of entries) {
          const el = e.target;
          if (!el || el.tagName !== 'VIDEO') continue;
          const st = getVState(el);
          if (e.contentBoxSize?.[0]) {
            const s = e.contentBoxSize[0];
            st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize };
          } else {
            st.rect = e.contentRect ? el.getBoundingClientRect() : null;
          }
          st.rectT = now; dirty.videos.add(el); changed = true;
        }
        if (changed) requestRefreshCoalesced();
      }) : null;

      const observeVideo = (el) => {
        if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
        videos.add(el);
        if (io) io.observe(el);
        else {
          const st = getVState(el); st.visible = true;
          if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); }
        }
        if (ro) safe(() => ro.observe(el));
      };

      const WorkQ = (() => {
        let active = [], pending = [], scheduled = false;
        const activeSet = new Set();
        function drainRunnerIdle(dl) { drain(dl); }
        function drainRunnerRaf() { drain(); }

        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 });
          else requestAnimationFrame(drainRunnerRaf);
        };

        const enqueue = (n) => {
          if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
          if (activeSet.has(n)) return;
          activeSet.add(n);
          pending.push(n);
          schedule();
        };

        const scanNode = (n) => {
          if (!n) return;
          if (n.nodeType === 1) {
            if (n.tagName === 'VIDEO') { observeVideo(n); return; }
            try {
              const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null;
              if (!vs || vs.length === 0) return;
              for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
            } catch (_) {}
            return;
          }
          if (n.nodeType === 11) {
            try {
              const vs = n.querySelectorAll ? n.querySelectorAll('video') : null;
              if (!vs || vs.length === 0) return;
              for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
            } catch (_) {}
          }
        };

        const drain = (dl) => {
          scheduled = false;
          activeSet.clear();
          [active, pending] = [pending, active];
          pending.length = 0;
          const start = performance.now();
          const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6;

          for (let i = 0; i < active.length; i++) {
            if (!budget()) {
              for (let j = i; j < active.length; j++) {
                pending.push(active[j]);
                activeSet.add(active[j]);
              }
              active.length = 0; schedule(); return;
            }
            scanNode(active[i]);
          }
          active.length = 0;
        };
        return Object.freeze({ enqueue });
      })();

      function nodeMayContainVideo(n) {
        if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false;
        if (n.nodeType === 1) {
          if (n.tagName === 'VIDEO') return true;
          if ((n.childElementCount || 0) === 0) return false;
          try {
            const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null;
            return !!(list && list.length);
          } catch (_) {
            try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; }
          }
        }
        try {
          const list = n.querySelectorAll ? n.querySelectorAll('video') : null;
          return !!(list && list.length);
        } catch (_) { return false; }
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
            if (m.removedNodes && m.removedNodes.length) {
              for (const n of m.removedNodes) {
                if (!n || n.nodeType !== 1) continue;
                if (n.tagName === 'VIDEO') {
                  if (videos.has(n)) {
                    videos.delete(n); visible.videos.delete(n);
                    safe(() => { io?.unobserve(n); ro?.unobserve(n); });
                    dirty.videos.add(n);
                  }
                  touchedVideoTree = true; break;
                }
                if ((n.childElementCount || 0) > 0) {
                  try {
                    const list = n.getElementsByTagName?.('video');
                    if (list && list.length) { touchedVideoTree = true; break; }
                  } catch (_) {}
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

      const refreshObservers = () => {
        for (const o of observers) o.disconnect();
        observers.clear();
        for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); }
        const root = document.body || document.documentElement;
        if (root) { WorkQ.enqueue(root); connectObserver(root); }
      };

      document.addEventListener('vsc-shadow-root', (e) => {
        try {
          const sr = e.detail, host = sr?.host;
          if (!sr || !host || observedShadowHosts.has(host)) return;
          observedShadowHosts.add(host);
          shadowRootsLRU.push({ host, root: sr });
          if (shadowRootsLRU.length > SYS.SLM) shadowRootsLRU.shift();
          connectObserver(sr);
        } catch (_) {}
      });
      refreshObservers();

      function pruneDisconnected(set, visibleSet, dirtySet, unobserveFn) {
        let removed = 0;
        for (const el of set) {
          if (!el?.isConnected) {
            set.delete(el); visibleSet.delete(el); dirtySet.delete(el);
            safe(() => unobserveFn(el));
            safe(() => ro?.unobserve(el));
            removed++;
          }
        }
        return removed;
      }

      return {
        videos, visible, rev: () => rev, refreshObservers,
        prune: () => {
          const removed = pruneDisconnected(videos, visible.videos, dirty.videos, (el) => { if (io) io.unobserve(el); });
          if (removed) rev++;
        },
        consumeDirty: () => {
          const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out;
        },
        rescanAll: () => {
          const task = () => {
            try {
              const base = document.documentElement || document.body;
              if (!base) return;
              function* walkRoots(rootBase) {
                if (!rootBase) return;
                const stack = [rootBase];
                while (stack.length > 0) {
                  const r = stack.pop();
                  yield r;
                  const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
                  let node = walker.nextNode();
                  while (node) {
                    if (node.shadowRoot) stack.push(node.shadowRoot);
                    node = walker.nextNode();
                  }
                }
              }
              for (const r of walkRoots(base)) WorkQ.enqueue(r);
            } catch (_) {}
          };
          setTimeout(task, 0);
        }
      };
    }

    let _softClipCurve = null;
    function getSoftClipCurve() {
      if (_softClipCurve) return _softClipCurve;
      const n = 4096, knee = 0.92, drive = 4.0, tanhD = Math.tanh(drive);
      _softClipCurve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
        _softClipCurve[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh(drive * (ax - knee) / Math.max(1e-6, 1 - knee)) / tanhD);
      }
      return _softClipCurve;
    }

    function chain(...nodes) {
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      return { input: nodes[0], output: nodes[nodes.length - 1] };
    }

    function createAudio(sm) {
      let ctx, target = null, currentSrc = null, inputGain, dryGain, wetGain, masterOut, wetInGain, limiter, hpf, analyser, dataArray;
      let srcMap = new WeakMap(), makeupDbEma = 0, switchTimer = 0, switchTok = 0, gestureHooked = false, loopTok = 0, audioLoopTimerId = 0, currentNodes = null;
      const clamp = VSC_CLAMP;

      const stt = (param, val, t, tc = 0.08) => { if(param) { try { param.setTargetAtTime(val, t, tc); } catch (_) { param.value = val; } } };
      const mkBQ = (actx, type, freq, Q, gain) => { const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if(Q !== undefined) f.Q.value = Q; if(gain !== undefined) f.gain.value = gain; return f; };
      const mkComp = (actx, thr, knee, ratio, atk, rel) => { const c = actx.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel; return c; };

      const onGesture = async () => {
        try {
          if (ctx && ctx.state === 'suspended') await ctx.resume();
          if (ctx && ctx.state === 'running' && gestureHooked) {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
            gestureHooked = false;
          }
        } catch (_) {}
      };

      const ensureGestureResumeHook = () => {
        if (gestureHooked) return;
        gestureHooked = true;
        on(window, 'pointerdown', onGesture, OPT_PC);
        on(window, 'keydown', onGesture, OPT_PC);
      };

      function createDynamicCinemaEQ(actx) {
        const bands = {
          sub: mkBQ(actx, 'lowshelf', 80, 0.8, 0), impact: mkBQ(actx, 'peaking', 55, 1.2, 0), cut: mkBQ(actx, 'peaking', 300, 0.8, 0),
          voice: mkBQ(actx, 'peaking', 3200, 1.2, 0), air: mkBQ(actx, 'highshelf', 10000, 0.7, 0)
        };
        const input = actx.createGain(), output = actx.createGain();
        chain(input, bands.sub, bands.impact, bands.cut, bands.voice, bands.air, output);

        const BASE_CINEMA = { sub: 3.0, impact: 2.0, cut: -2.0, voice: 2.0, air: -0.5 };
        const PROFILES = {
          cinema: BASE_CINEMA,
          cinemaWithMultiband: Object.fromEntries(
            Object.entries(BASE_CINEMA).map(([k, v]) => [k, k === 'cut' ? v : v * 0.5 + (k === 'voice' ? 0.5 : 0)])
          ),
          neutral: { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }
        };

        let activeProfile = 'cinema', dialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 };

        const applyGains = () => {
          const profile = PROFILES[activeProfile] || PROFILES.neutral, t = actx.currentTime;
          for (const name of Object.keys(bands)) {
            const gain = VSC_CLAMP((profile[name] || 0) + (dialogueOffset[name] || 0), -12, 12);
            stt(bands[name].gain, gain, t, 0.08);
          }
        };

        return {
          input, output, bands,
          setProfile: (name) => { activeProfile = name; applyGains(); },
          setDialogueState: (isDialogue, ratio) => {
            if (isDialogue && ratio > 0.5) {
              const str = VSC_CLAMP((ratio - 0.5) * 2, 0, 1);
              dialogueOffset = { sub: -1.0 * str, impact: -0.5 * str, cut: -1.0 * str, voice: 1.5 * str, air: 0.8 * str };
            } else { dialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }; }
            applyGains();
          }
        };
      }

      function buildMultibandDynamics(actx) {
        const CROSSOVER_LOW = 120, CROSSOVER_HIGH = 3200;
        const createLR4 = (freq, type) => {
          const f1 = mkBQ(actx, type, freq, Math.SQRT1_2);
          const f2 = mkBQ(actx, type, freq, Math.SQRT1_2);
          f1.connect(f2);
          return { input: f1, output: f2 };
        };
        const input = actx.createGain(), lpLow = createLR4(CROSSOVER_LOW, 'lowpass'), hpLow = createLR4(CROSSOVER_LOW, 'highpass'), lpMid = createLR4(CROSSOVER_HIGH, 'lowpass'), hpHigh = createLR4(CROSSOVER_HIGH, 'highpass');
        input.connect(lpLow.input); input.connect(hpLow.input); hpLow.output.connect(lpMid.input); hpLow.output.connect(hpHigh.input);

        const compLow  = mkComp(actx, -22, 10, 2.5, 0.030, 0.50);
        const compMid  = mkComp(actx, -16,  8, 2.2, 0.008, 0.20);
        const compHigh = mkComp(actx, -14,  8, 1.8, 0.005, 0.10);
        const gainLow = actx.createGain(), gainMid = actx.createGain(), gainHigh = actx.createGain();

        chain(lpLow.output, compLow, gainLow); chain(lpMid.output, compMid, gainMid); chain(hpHigh.output, compHigh, gainHigh);
        const output = actx.createGain(); gainLow.connect(output); gainMid.connect(output); gainHigh.connect(output);

        return { input, output, bands: { low: { comp: compLow, gain: gainLow }, mid: { comp: compMid, gain: gainMid }, high: { comp: compHigh, gain: gainHigh } } };
      }

      function updateRingBuffer(buf, idx, full, value) {
        buf[idx] = value;
        const nextIdx = (idx + 1) % buf.length;
        const nextFull = full || nextIdx === 0;
        const count = nextFull ? buf.length : nextIdx;
        let sum = 0; for (let i = 0; i < count; i++) sum += buf[i];
        const mean = sum / count;
        return { idx: nextIdx, full: nextFull, lufs: mean > 1e-10 ? -0.691 + 10 * Math.log10(mean) : -70 };
      }

      function createLUFSMeter(actx) {
        const preFilter = mkBQ(actx, 'highshelf', 1681, undefined, 4.0);
        const hpf = mkBQ(actx, 'highpass', 38, 0.5);
        const meterAnalyser = actx.createAnalyser(); meterAnalyser.fftSize = 2048; meterAnalyser.smoothingTimeConstant = 0;
        chain(preFilter, hpf, meterAnalyser);

        const buffer = new Float32Array(meterAnalyser.fftSize);
        const state = { momentaryBuf: new Float64Array(20), momentaryIdx: 0, momentaryFull: false, shortTermBuf: new Float64Array(150), shortTermIdx: 0, shortTermFull: false, integratedSum: 0, integratedCount: 0, momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };

        function measure() {
          meterAnalyser.getFloatTimeDomainData(buffer);
          let sumSq = 0; for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i]; const meanSq = sumSq / buffer.length;
          const mRes = updateRingBuffer(state.momentaryBuf, state.momentaryIdx, state.momentaryFull, meanSq);
          state.momentaryIdx = mRes.idx; state.momentaryFull = mRes.full; state.momentaryLUFS = mRes.lufs;
          const sRes = updateRingBuffer(state.shortTermBuf, state.shortTermIdx, state.shortTermFull, meanSq);
          state.shortTermIdx = sRes.idx; state.shortTermFull = sRes.full; state.shortTermLUFS = sRes.lufs;

          if (state.momentaryLUFS > -70 && state.momentaryLUFS > state.integratedLUFS - 10) {
            state.integratedSum += meanSq; state.integratedCount++;
            const intMean = state.integratedSum / state.integratedCount;
            state.integratedLUFS = intMean > 1e-10 ? -0.691 + 10 * Math.log10(intMean) : -70;
          }
        }

        return { input: preFilter, measure, reset: () => { state.momentaryBuf.fill(0); state.shortTermBuf.fill(0); state.momentaryIdx = 0; state.shortTermIdx = 0; state.momentaryFull = false; state.shortTermFull = false; state.integratedSum = 0; state.integratedCount = 0; state.momentaryLUFS = -70; state.shortTermLUFS = -70; state.integratedLUFS = -70; }, getState: () => state };
      }

      function createLoudnessNormalizer(actx, lufsMeter) {
        const TARGET_LUFS = -14, MAX_GAIN_DB = 9, MIN_GAIN_DB = -6, SMOOTHING = 0.03, SETTLE_FRAMES = 75;
        const gainNode = actx.createGain(); gainNode.gain.value = 1.0; let frameCount = 0, currentGainDb = 0;

        function update() {
          const lufs = lufsMeter.getState(); frameCount++; if (frameCount < SETTLE_FRAMES) return;
          const measured = lufs.shortTermLUFS; if (measured <= -60) return;
          const targetGainDb = VSC_CLAMP(TARGET_LUFS - measured, MIN_GAIN_DB, MAX_GAIN_DB);
          currentGainDb += (targetGainDb - currentGainDb) * 0.08;
          const linearGain = Math.pow(10, currentGainDb / 20);
          stt(gainNode.gain, linearGain, actx.currentTime, SMOOTHING);
        }
        return { node: gainNode, update, reset: () => { frameCount = 0; currentGainDb = 0; gainNode.gain.value = 1.0; lufsMeter.reset(); } };
      }

      function createDialogueDetector(actx, analyserNode) {
        const freqD = new Uint8Array(analyserNode.frequencyBinCount);
        const sr = actx.sampleRate, binHz = sr / analyserNode.fftSize;
        const DIALOGUE_LOW_BIN = Math.round(300 / binHz), DIALOGUE_HIGH_BIN = Math.round(3500 / binHz);
        const state = { dialogueRatio: 0, isDialogue: false, confidence: 0, _ema: 0, _histCount: 0, _histDialogue: 0 };

        function detect() {
          analyserNode.getByteFrequencyData(freqD);
          let logSum = 0, linSum = 0, count = 0;
          for (let i = DIALOGUE_LOW_BIN; i <= DIALOGUE_HIGH_BIN; i++) {
            const v = Math.max(1, freqD[i]);
            logSum += Math.log(v);
            linSum += v;
            count++;
          }
          const geoMean = Math.exp(logSum / count);
          const ariMean = linSum / count;
          const flatness = geoMean / Math.max(1, ariMean);

          let score = 0;
          if (flatness < 0.35) score += 0.5;
          if (flatness < 0.25) score += 0.5;

          state._ema = state._ema * 0.85 + score * 0.15; state.dialogueRatio = state._ema; state.isDialogue = state._ema > 0.45; state._histCount++;
          if (state.isDialogue) state._histDialogue++; state.confidence = state._histCount > 50 ? state._histDialogue / state._histCount : 0; return state;
        }
        return { detect, reset: () => { state.dialogueRatio = 0; state.isDialogue = false; state.confidence = 0; state._ema = 0; state._histCount = 0; state._histDialogue = 0; }, getState: () => state };
      }

      function buildAudioGraph(audioCtx) {
        const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), hpf: mkBQ(audioCtx, 'highpass', 20, 0.707), limiter: mkComp(audioCtx, -1.0, 0.0, 20.0, 0.003, 0.12), analyser: audioCtx.createAnalyser(), rawAnalyser: audioCtx.createAnalyser(), clipper: audioCtx.createWaveShaper() };
        n.clipper.curve = getSoftClipCurve(); try { n.clipper.oversample = '4x'; } catch (_) {}
        n.analyser.fftSize = 2048; n.rawAnalyser.fftSize = 2048;
        const dynamicEQ = createDynamicCinemaEQ(audioCtx), multiband = buildMultibandDynamics(audioCtx), lufsMeter = createLUFSMeter(audioCtx), loudnessNorm = createLoudnessNormalizer(audioCtx, lufsMeter), dialogueDetector = createDialogueDetector(audioCtx, n.rawAnalyser);
        n.wetInGain = loudnessNorm.node;

        n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
        n.inputGain.connect(n.rawAnalyser);

        chain(n.inputGain, n.hpf, dynamicEQ.input);
        chain(dynamicEQ.output, multiband.input);
        chain(multiband.output, n.wetInGain, n.clipper);
        n.clipper.connect(lufsMeter.input);
        chain(n.clipper, n.limiter, n.analyser, n.wetGain, n.masterOut);

        n.masterOut.connect(audioCtx.destination);

        n._dynamicEQ = dynamicEQ; n._multiband = multiband; n._lufsMeter = lufsMeter; n._loudnessNorm = loudnessNorm; n._dialogueDetector = dialogueDetector;
        return n;
      }

      const ensureCtx = () => {
        if (ctx && ctx.state !== 'closed') return true;
        if (ctx) { ctx = null; srcMap = new WeakMap(); }
        const AC = window.AudioContext; if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { try { ctx = new AC(); } catch (__) { return false; } }
        currentSrc = null; target = null; ensureGestureResumeHook();
        const nodes = buildAudioGraph(ctx);
        inputGain = nodes.inputGain; dryGain = nodes.dryGain; wetGain = nodes.wetGain; masterOut = nodes.masterOut; wetInGain = nodes.wetInGain; limiter = nodes.limiter; hpf = nodes.hpf; analyser = nodes.analyser; currentNodes = nodes; dataArray = new Float32Array(analyser.fftSize);
        return true;
      };

      const fadeOutThen = (fn) => {
        if (!ctx) { fn(); return; }
        const tok = ++switchTok; clearTimeout(switchTimer); const t = ctx.currentTime;
        const fadeMs = 50;
        try { masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + fadeMs / 1000); } catch (_) { masterOut.gain.value = 0; }
        switchTimer = setTimeout(() => {
          if (tok !== switchTok) return; makeupDbEma = 0;
          safe(fn);
          if (ctx) {
            const t2 = ctx.currentTime;
            try { masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + fadeMs / 1000); } catch (_) { masterOut.gain.value = 1; }
          }
        }, fadeMs + 20);
      };
      const disconnectAll = () => { if (currentSrc) safe(() => currentSrc.disconnect()); currentSrc = null; target = null; };

      function runAudioLoop(tok) {
        audioLoopTimerId = 0; if (tok !== loopTok || !ctx || !dataArray) return;
        const dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); if (!dynAct) return;
        const actuallyEnabled = dynAct && currentSrc;

        if (analyser && currentSrc && currentNodes) {
          analyser.getFloatTimeDomainData(dataArray);
          let sumSquare = 0; for (let i = 0; i < dataArray.length; i++) sumSquare += dataArray[i] * dataArray[i];
          const rms = Math.sqrt(sumSquare / dataArray.length), db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
          const mbActive = !!sm.get(P.A_MULTIBAND);
          if (currentNodes._dynamicEQ) currentNodes._dynamicEQ.setProfile(mbActive ? 'cinemaWithMultiband' : 'cinema');

          if (currentNodes._dialogueDetector && actuallyEnabled) {
            const dState = currentNodes._dialogueDetector.detect(); const t = ctx.currentTime;
            if (currentNodes._dynamicEQ) currentNodes._dynamicEQ.setDialogueState(dState.isDialogue, dState.dialogueRatio);
            if (currentNodes._multiband) {
              const mb = currentNodes._multiband.bands;
              if (!!sm.get(P.A_DIALOGUE) && dState.isDialogue && dState.dialogueRatio > 0.5) {
                const boost = clamp((dState.dialogueRatio - 0.5) * 2 * 1.5, 0, 2.0);
                stt(mb.mid.gain.gain, 1.0 + boost * 0.15, t, 0.08); stt(mb.low.gain.gain, 1.0 - boost * 0.08, t, 0.08); stt(mb.high.gain.gain, 1.0 + boost * 0.05, t, 0.08);
              } else {
                stt(mb.mid.gain.gain, 1.0, t, 0.15); stt(mb.low.gain.gain, 1.0, t, 0.15); stt(mb.high.gain.gain, 1.0, t, 0.15);
              }
            }
          }
          if (currentNodes._loudnessNorm && !!sm.get(P.A_LUFS) && actuallyEnabled) { currentNodes._lufsMeter.measure(); currentNodes._loudnessNorm.update(); }

          if (actuallyEnabled) {
            let redDb = 0;
            if (mbActive && currentNodes._multiband) {
              const rl = Math.abs(Number(currentNodes._multiband.bands.low.comp.reduction) || 0), rm = Math.abs(Number(currentNodes._multiband.bands.mid.comp.reduction) || 0), rh = Math.abs(Number(currentNodes._multiband.bands.high.comp.reduction) || 0);
              redDb = -Math.max(rl, rm, rh);
            } else if (currentNodes.limiter) {
              const r = currentNodes.limiter.reduction; redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0;
            }
            if (!Number.isFinite(redDb)) redDb = 0;
            const redPos = clamp(-redDb, 0, 18); let gateMult = 1.0;
            if (db < -45) gateMult = 0.0; else if (db < -40) gateMult = (db - (-45)) / 5.0;
            const makeupDbTarget = clamp(Math.max(0, redPos - 2.0) * 0.22, 0, 2.8) * gateMult;
            makeupDbEma += (makeupDbTarget - makeupDbEma) * (makeupDbTarget > makeupDbEma ? 0.35 : 0.015);
          } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
        }
        const userBoost = Math.pow(10, Number(sm.get(P.A_BST) || 0) / 20), makeup = Math.pow(10, makeupDbEma / 20);
        if (wetInGain) { const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0; stt(wetInGain.gain, finalGain, ctx.currentTime, 0.02); }

        const loopInterval = document.hidden ? 500 : 100;
        audioLoopTimerId = setTimeout(() => runAudioLoop(tok), loopInterval);
      }

      const updateMix = () => {
        if (!ctx) return;
        if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
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
        loopTok++; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
        safe(() => fadeOutThen(() => disconnectAll()));
        safe(() => { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } });
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        ctx = null; currentNodes = null; limiter = null; wetInGain = null; inputGain = null; dryGain = null; wetGain = null; masterOut = null; hpf = null; currentSrc = null; target = null; analyser = null; dataArray = null; makeupDbEma = 0; switchTok++; srcMap = new WeakMap();
      }

      return {
        warmup: () => { if (!ensureCtx()) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
        setTarget: (v) => {
          const st = v ? getVState(v) : null;
          if (st && st.audioFailUntil > performance.now()) {
            if (v !== target) { target = v; }
            updateMix(); return;
          }
          if (!ensureCtx()) return;
          if (v === target) { updateMix(); return; }

          if (target !== null && v !== null && target !== v) {
            fadeOutThen(() => {
              disconnectAll(); target = v; if (!v) { updateMix(); return; }
              try {
                let s = srcMap.get(v);
                if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); }
                s.connect(inputGain); currentSrc = s;
              } catch (_) {
                if (st) st.audioFailUntil = performance.now() + SYS.AFC;
                disconnectAll();
              }
              updateMix();
            });
          } else if (v !== null && !currentSrc) {
            target = v;
            try {
              let s = srcMap.get(v);
              if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); }
              s.connect(inputGain); currentSrc = s;
            } catch (_) {
              if (st) st.audioFailUntil = performance.now() + SYS.AFC;
              disconnectAll();
            }
            updateMix();
          } else if (v === null) {
            fadeOutThen(() => { disconnectAll(); updateMix(); });
          }
        },
        update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy
      };
    }

    const appAsym = (c, t, au, ad, fps = 5) => {
      const d = t - c;
      if (Math.abs(d) < 0.002) return t;
      const fpsCompensation = Math.min(3, 10 / Math.max(1, fps));
      const alpha = (d > 0 ? au : ad) * fpsCompensation;
      return c + d * Math.min(alpha, 0.5);
    };

    function createAutoSceneManager(Store, P, Scheduler) {
      const AUTO = {
        running: false, canvasW: 160, canvasH: 90, cur: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }, tgt: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 },
        lastSig: null, cutScoreEma: 0.10, cutScoreBaseline: 0.05, motionEma: 0, motionAlpha: 0.30, motionThresh: 0.012, motionFrames: 0, motionMinFrames: 5,
        statsEma: null, statsAlpha: 0.18, drmBlocked: false, blockUntilMs: 0, _drmSuccessCount: 0, _drmBackoffCount: 0,
        tBoostUntil: 0, tBoostStart: 0, boostMs: 600, minBoostEarlyMs: 500, changeEma: 0, minFps: 4, maxFps: 15, curFps: 4,
        _lumaN: 0, _lumaA: null, _lumaB: null, _lumaFlip: 0, statsBuf: [], _hadFirstFrame: false, _firstUpdateDone: false
      };

      const c = document.createElement('canvas'); c.width = AUTO.canvasW; c.height = AUTO.canvasH;
      let ctx = null;
      try { ctx = c.getContext('2d', { willReadFrequently: true, desynchronized: true, alpha: false, colorSpace: 'srgb' }); } catch (_) { try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch (__) {} }

      function ensureLumaBuffers(AUTO, n) {
        if (AUTO._lumaN !== n) {
          AUTO._lumaN = n; AUTO._lumaA = new Uint8Array(n); AUTO._lumaB = new Uint8Array(n); AUTO._lumaFlip = 0; AUTO._hadFirstFrame = false;
          AUTO.statsBuf.length = 0; AUTO.statsEma = null;
        }
      }

      function medianOf(arr, key) {
        if (!arr.length) return 0;
        const vals = arr.map(a => a[key]).sort((a, b) => a - b);
        const mid = vals.length >> 1;
        return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) * 0.5;
      }

      function computeStatsAndMotion(AUTO, img, sw, sh) {
        const data32 = new Uint32Array(img.data.buffer), stepPx = 2, sampW = Math.ceil(sw / stepPx), sampH = Math.ceil(sh / stepPx), n = sampW * sampH; ensureLumaBuffers(AUTO, n);
        const cur = (AUTO._lumaFlip === 0) ? AUTO._lumaA : AUTO._lumaB, prev = (AUTO._lumaFlip === 0) ? AUTO._lumaB : AUTO._lumaA;
        const isFirstFrame = (AUTO._lumaFlip === 0 && !AUTO._hadFirstFrame);
        let sum = 0, sum2 = 0, sumEdge = 0, edgeCount = 0, diffSum = 0, sumChroma = 0, p = 0;
        const cx = sw / 2, cy = sh / 2, maxDist2 = cx * cx + cy * cy;

        for (let y = 0; y < sh; y += stepPx) {
          const rowOff = y * sw;
          for (let x = 0; x < sw; x += stepPx) {
            const pixel = data32[rowOff + x], r = pixel & 0xFF, g = (pixel >> 8) & 0xFF, b = (pixel >> 16) & 0xFF, l = (r * 54 + g * 183 + b * 19) >> 8, max3 = r > g ? (r > b ? r : b) : (g > b ? g : b), min3 = r < g ? (r < b ? r : b) : (g < b ? g : b);
            const dist2 = (x - cx) * (x - cx) + (y - cy) * (y - cy), weight = 1.0 - 0.15 * (dist2 / maxDist2);
            sumChroma += (max3 - min3); cur[p] = l; sum += l * weight; sum2 += (l * weight) * (l * weight);

            if (x + stepPx < sw) { const p2 = data32[rowOff + x + stepPx], l2 = ((p2 & 0xFF) * 54 + ((p2 >> 8) & 0xFF) * 183 + ((p2 >> 16) & 0xFF) * 19) >> 8; sumEdge += (l2 > l ? l2 - l : l - l2); edgeCount++; }
            if (!isFirstFrame) diffSum += Math.abs(l - prev[p]);
            p++;
          }
        }
        AUTO._lumaFlip ^= 1; const samples = Math.max(1, n), mean = sum / samples, var_ = (sum2 / samples) - mean * mean;
        if (isFirstFrame) { AUTO._hadFirstFrame = true; return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, chroma: (sumChroma / samples) / 255, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: 0 }; }
        return { bright: mean / 255, contrast: Math.sqrt(Math.max(0, var_)) / 64, chroma: (sumChroma / samples) / 255, edge: edgeCount > 0 ? sumEdge / edgeCount : 0, motion: diffSum / samples };
      }

      function detectCut(sig) {
        if (!AUTO.lastSig) return false; const dY = Math.abs(sig.bright - AUTO.lastSig.bright), dCt = Math.abs(sig.contrast - AUTO.lastSig.contrast), score = (dY * 1.1) + (dCt * 0.9);
        AUTO.cutScoreBaseline = (AUTO.cutScoreBaseline || 0.05) * 0.97 + score * 0.03;
        AUTO.cutScoreEma = AUTO.cutScoreEma * 0.85 + score * 0.15;
        const thr = Math.max(0.10, Math.min(0.25, AUTO.cutScoreBaseline * 2.5)); sig.__cutScore = score; return score > thr;
      }

      function calculateAdaptiveFps(changeScore) {
        AUTO.changeEma = (AUTO.changeEma || 0) * 0.7 + changeScore * 0.3;
        const avg = AUTO.changeEma;
        let targetFps; if (avg < 0.1) targetFps = 3 + (avg / 0.1) * 2; else if (avg < 0.3) targetFps = 5 + ((avg - 0.1) / 0.2) * 3; else targetFps = 8 + (Math.min(avg - 0.3, 0.7) / 0.7) * 2;
        const clamped = VSC_CLAMP(targetFps, AUTO.minFps, AUTO.maxFps); AUTO.curFps += VSC_CLAMP(Math.round(clamped * 2) / 2 - AUTO.curFps, -1, 1); return AUTO.curFps;
      }

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
        if (!v || !ctx || v.paused || v.seeking || v.readyState < 2) { safe(() => Scheduler.request(true)); scheduleNext(v, 120); return; }
        try {
          ctx.drawImage(v, 0, 0, AUTO.canvasW, AUTO.canvasH); const img = ctx.getImageData(0, 0, AUTO.canvasW, AUTO.canvasH);
          AUTO.drmBlocked = false; AUTO._drmSuccessCount = (AUTO._drmSuccessCount || 0) + 1;
          if (AUTO._drmSuccessCount > 10) AUTO._drmBackoffCount = 0;
          const sigRaw = computeStatsAndMotion(AUTO, img, AUTO.canvasW, AUTO.canvasH); AUTO.motionEma = (AUTO.motionEma * (1 - AUTO.motionAlpha)) + (sigRaw.motion * AUTO.motionAlpha); AUTO.motionFrames = (AUTO.motionEma >= AUTO.motionThresh) ? (AUTO.motionFrames + 1) : 0;
          const isCut = detectCut(sigRaw); AUTO.lastSig = sigRaw;
          AUTO.statsBuf.push({ ...sigRaw }); if (AUTO.statsBuf.length > 5) AUTO.statsBuf.shift();
          const filteredStats = { bright: medianOf(AUTO.statsBuf, 'bright'), contrast: medianOf(AUTO.statsBuf, 'contrast'), chroma: medianOf(AUTO.statsBuf, 'chroma'), edge: medianOf(AUTO.statsBuf, 'edge'), motion: sigRaw.motion };
          if (!AUTO.statsEma) { AUTO.statsEma = { ...filteredStats }; } else { const e = AUTO.statsEma, a = AUTO.statsAlpha; e.bright = e.bright*(1-a) + filteredStats.bright*a; e.contrast = e.contrast*(1-a) + filteredStats.contrast*a; e.edge = e.edge*(1-a) + filteredStats.edge*a; }
          const sig = AUTO.statsEma; if (isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; }
          const allowUpdate = isCut || (AUTO.motionFrames >= AUTO.motionMinFrames) || (!AUTO._firstUpdateDone); let fps = AUTO.curFps;
          if (allowUpdate) {
            AUTO._firstUpdateDone = true;
            fps = calculateAdaptiveFps(VSC_CLAMP(sigRaw.motion||0,0,1)); if (now < AUTO.tBoostUntil) fps = Math.max(fps, (now - AUTO.tBoostStart < AUTO.minBoostEarlyMs) ? 10 : 8);
            let gainT = 1.0, ctT = 1.0, satT = 1.0, sharpScaleT = 1.0;
            if (sig.bright < 0.25) { const darkIntentionality = 1.0 - VSC_CLAMP(sig.edge / 6, 0, 0.5); gainT = 1.0 + ((0.25 - sig.bright) / 0.25) * 0.20 * darkIntentionality; } else if (sig.bright > 0.75) gainT = 1.0 - ((sig.bright - 0.75) / 0.25) * 0.05;
            if (sig.contrast < 0.12) ctT = 1.0 + ((0.12 - sig.contrast) / 0.12) * 0.10;
            const cCh = Number(sig.chroma || 0); if (cCh < 0.08) satT = 1.0 + ((0.08 - cCh) / 0.08) * 0.12; else if (cCh > 0.35) satT = 1.0 - Math.min((cCh - 0.35) / 0.35, 1.0) * 0.08;
            const edgeVal = Number(sig.edge || 0); if (edgeVal > 12) { sharpScaleT = 1.0 - VSC_CLAMP((edgeVal - 12) / 13, 0, 1) * 0.40; } else if (edgeVal < 4) { sharpScaleT = 1.0 + VSC_CLAMP((4 - edgeVal) / 4, 0, 1) * 0.15; }
            const appDZ = (t, dz) => { const d = Math.abs(t - 1.0); return d < dz ? 1.0 : (t > 1.0 ? 1.0 + (d - dz) : 1.0 - (d - dz)); };
            AUTO.tgt.br = VSC_CLAMP(appDZ(gainT, 0.03), 0.95, 1.20); AUTO.tgt.ct = VSC_CLAMP(appDZ(ctT, 0.02), 0.95, 1.12); AUTO.tgt.sat = VSC_CLAMP(appDZ(satT, 0.03), 0.92, 1.12); AUTO.tgt.sharpScale = VSC_CLAMP(sharpScaleT, 0.75, 1.15);

            const currentFps = AUTO.curFps || 5;
            AUTO.cur.br = appAsym(AUTO.cur.br, AUTO.tgt.br, isCut ? 0.20 : 0.12, isCut ? 0.25 : 0.18, currentFps);
            AUTO.cur.ct = appAsym(AUTO.cur.ct, AUTO.tgt.ct, isCut ? 0.18 : 0.12, isCut ? 0.18 : 0.12, currentFps);
            AUTO.cur.sat = appAsym(AUTO.cur.sat, AUTO.tgt.sat, isCut ? 0.12 : 0.08, isCut ? 0.20 : 0.14, currentFps);
            AUTO.cur.sharpScale = appAsym(AUTO.cur.sharpScale, AUTO.tgt.sharpScale, isCut ? 0.15 : 0.08, isCut ? 0.20 : 0.14, currentFps);

            if (Math.abs(AUTO.cur.br - AUTO.tgt.br) > 0.001 || Math.abs(AUTO.cur.ct - AUTO.tgt.ct) > 0.001 || Math.abs(AUTO.cur.sat - AUTO.tgt.sat) > 0.001 || Math.abs(AUTO.cur.sharpScale - AUTO.tgt.sharpScale) > 0.001) Scheduler.request(true);
          }
          scheduleNext(v, Math.max(80, Math.round(1000 / Math.max(1, fps))));
        } catch (e) {
          AUTO.drmBlocked = true; AUTO._drmSuccessCount = 0; AUTO._drmBackoffCount = (AUTO._drmBackoffCount || 0) + 1; const backoffMs = Math.min(5000, 1000 * Math.pow(1.5, AUTO._drmBackoffCount)); AUTO.blockUntilMs = performance.now() + backoffMs; scheduleNext(v, 1000);
        }
      }
      Store.sub(P.APP_AUTO_SCENE, (en) => {
        if (en && !AUTO.running) {
          if (ctx) { AUTO.running = true; loop(); }
        } else if (!en && AUTO.running) {
          AUTO.running = false;
          AUTO.tgt = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 };
          let fadeFrames = 8;
          const fadeBack = () => {
            if (fadeFrames-- <= 0 || AUTO.running) return;
            AUTO.cur.br += (1.0 - AUTO.cur.br) * 0.3;
            AUTO.cur.ct += (1.0 - AUTO.cur.ct) * 0.3;
            AUTO.cur.sat += (1.0 - AUTO.cur.sat) * 0.3;
            AUTO.cur.sharpScale += (1.0 - AUTO.cur.sharpScale) * 0.3;
            const done = Math.abs(AUTO.cur.br - 1) < 0.003 && Math.abs(AUTO.cur.ct - 1) < 0.003;
            if (done) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; }
            Scheduler.request(true);
            if (!done) requestAnimationFrame(fadeBack);
          };
          requestAnimationFrame(fadeBack);
        }
      });
      Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running && ctx) { AUTO.running = true; loop(); } });
      return { getMods: () => AUTO.cur, start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running && ctx) { AUTO.running = true; loop(); } }, stop: () => { AUTO.running = false; } };
    }
function createFiltersVideoOnly(Utils, config) {
      const { h, clamp } = Utils;
      function createLRU(max = 384) {
        const m = new Map();
        return {
          get(k) {
            if (!m.has(k)) return undefined;
            const v = m.get(k);
            m.delete(k); m.set(k, v);
            return v;
          },
          set(k, v) {
            if (m.has(k)) m.delete(k);
            m.set(k, v);
            if (m.size > max) {
              const first = m.keys().next();
              if (!first.done) m.delete(first.value);
            }
          }
        };
      }
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createLRU(720);
      const LUMA_MATRIX = '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0';
      function setAttr(node, attr, val) { if (!node) return; node.setAttribute(attr, val == null ? '' : String(val)); }
      const sCurve = (x) => x * x * (3 - 2 * x);
      const softClip = (x, knee = 1.0, max = 2.0) => { x = Math.max(0, x); if (x <= knee) return x; const t = (x - knee) / Math.max(1e-6, (max - knee)); return knee + (max - knee) * (1 - Math.exp(-t)); };
      const applyLumaWeight = (bNode, sumNode, v, kMul, stdBase, stdDrop, isK3 = false) => { const vn = softClip(v, 1.0, 2.0), scVal = sCurve(Math.min(1, vn)), extra = Math.max(0, vn - 1), w = (scVal + extra) * kMul; setAttr(bNode, 'stdDeviation', v > 0 ? (stdBase - sCurve(Math.min(1, v)) * stdDrop).toFixed(2) : '0'); setAttr(sumNode, isK3 ? 'k3' : 'k2', w.toFixed(3)); };
      const makeKeyBase = (s) => [ Math.round(s.gain / 0.04), Math.round(s.gamma / 0.01), Math.round(s.contrast / 0.01), Math.round(s.bright / 0.2), Math.round(s.satF / 0.01), Math.round(s.mid / 0.02), Math.round(s.toe / 0.2), Math.round(s.shoulder / 0.2), Math.round(s.temp / 0.2), Math.round(s.sharp / 0.2), Math.round(s.sharp2 / 0.2), Math.round(s.clarity / 0.2) ].join('|');

      const _toneStrBuf = new Array(64);
      function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
        const key = `${steps}|${toeN}|${shoulderN}|${midN}|${gain}`; const hit = toneCache.get(key); if (hit) return hit;
        if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) { const res0 = '0 1'; toneCache.set(key, res0); return res0; }
        const curve = computeToneCurve(steps, toeN, midN, shoulderN, gain);
        for (let i = 0; i < steps; i++) {
          const y = Math.round(curve[i] * 100000) / 100000;
          _toneStrBuf[i] = y === 1 ? '1' : y === 0 ? '0' : String(y);
        }
        const res = _toneStrBuf.join(' '); toneCache.set(key, res); return res;
      }
      const SVG_MAX_PIX_FULL = config.SVG_MAX_PIX_FULL ?? (3840 * 2160), SVG_MAX_PIX_FAST = config.SVG_MAX_PIX_FAST ?? (3840 * 2160);
      function calcFilterRes(vw, vh, maxPix) { vw = vw | 0; vh = vh | 0; if (vw <= 0 || vh <= 0 || maxPix <= 0) return ''; const px = vw * vh; if (px <= maxPix) return `${vw} ${vh}`; const s = Math.sqrt(maxPix / px); return `${Math.max(1, Math.round(vw * s))} ${Math.max(1, Math.round(vh * s))}`; }

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const fidLite = `vsc-lite-${config.VSC_ID}`, fidFast = `vsc-fast-${config.VSC_ID}`, fidFullLight = `vsc-full-light-${config.VSC_ID}`, fidFull = `vsc-full-${config.VSC_ID}`;
        const mkTempTransfer = (prefix, inN) => { const r = h('feFuncR', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }); const g = h('feFuncG', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }); const b = h('feFuncB', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }); const tm = h('feComponentTransfer', { ns: 'svg', in: inN, result: `${prefix}_tm` }, r, g, b); return { tm, r, g, b }; };
        const mkFuncRGB = (attrs) => ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', ...attrs }));
        const mkC = (p) => { const t = h('feComponentTransfer', { ns: 'svg', result: `${p}_t` }, mkFuncRGB({ type: 'table', tableValues: '0 1' })); const b = h('feComponentTransfer', { ns: 'svg', in: `${p}_t`, result: `${p}_b` }, mkFuncRGB({ type: 'linear', slope: '1', intercept: '0' })); const g = h('feComponentTransfer', { ns: 'svg', in: `${p}_b`, result: `${p}_g` }, mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })); return {t, b, g}; };
        const mkP = (p, inN) => { const tmp = mkTempTransfer(p, inN); const s = h('feColorMatrix', { ns: 'svg', in: `${p}_tm`, type: 'saturate', values: '1', result: `${p}_s` }); return { tmp, s }; };
        const mkBlurDiff = (prefix, inN, blurN, diffN, k2='1', k3='-1') => [h('feGaussianBlur', { ns: 'svg', in: inN, stdDeviation: '0', result: blurN }), h('feComposite', { ns: 'svg', in: inN, in2: blurN, operator: 'arithmetic', k2, k3, result: diffN })];

        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' }); const cL = mkC('l'), pL = mkP('l', 'l_g'); lite.append(cL.t, cL.b, cL.g, pL.tmp.tm, pL.s);
        const fast = h('filter', { ns: 'svg', id: fidFast, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' }); const cF = mkC('f');
        const fLuma = h('feColorMatrix', { ns: 'svg', in: 'f_g', type: 'matrix', values: LUMA_MATRIX, result: 'f_luma' }), [fB1, fD1] = mkBlurDiff('f', 'f_luma', 'f_b1', 'f_d1'), [fB2, fD2] = mkBlurDiff('f', 'f_luma', 'f_b2', 'f_d2'), fSum = h('feComposite',    { ns: 'svg', in: 'f_d1', in2: 'f_d2', operator: 'arithmetic', k2: '0', k3: '0', result: 'f_sum' }), fOut = h('feComposite',    { ns: 'svg', in: 'f_g', in2: 'f_sum', operator: 'arithmetic', k2: '1', k3: '1', result: 'f_out' }), pF = mkP('f', 'f_out');
        fast.append(cF.t, cF.b, cF.g, fLuma, fB1, fD1, fB2, fD2, fSum, fOut, pF.tmp.tm, pF.s);
        const fullLight = h('filter', { ns: 'svg', id: fidFullLight, 'color-interpolation-filters': 'sRGB', x: '-10%', y: '-10%', width: '120%', height: '120%' }); const cUL = mkC('ul');
        const ulLuma = h('feColorMatrix', { ns: 'svg', in: 'ul_g', type: 'matrix', values: LUMA_MATRIX, result: 'ul_luma' }), [ulB1, ulD1] = mkBlurDiff('ul', 'ul_luma', 'ul_b1', 'ul_d1'), [ulBc, ulDc] = mkBlurDiff('ul', 'ul_luma', 'ul_bc', 'ul_dc'), ulSum = h('feComposite',    { ns: 'svg', in: 'ul_d1', in2: 'ul_dc', operator: 'arithmetic', k2: '0', k3: '0', result: 'ul_sum' }), ulOut = h('feComposite',    { ns: 'svg', in: 'ul_g', in2: 'ul_sum', operator: 'arithmetic', k2: '1', k3: '1', result: 'ul_out' }), pUL = mkP('ul', 'ul_out');
        fullLight.append(cUL.t, cUL.b, cUL.g, ulLuma, ulB1, ulD1, ulBc, ulDc, ulSum, ulOut, pUL.tmp.tm, pUL.s);
        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '-10%', y: '-10%', width: '120%', height: '120%' }); const cU = mkC('u');
        const uLuma = h('feColorMatrix', { ns: 'svg', in: 'u_g', type: 'matrix', values: LUMA_MATRIX, result: 'u_luma' }), [uB1, uD1]  = mkBlurDiff('u', 'u_luma', 'u_b1', 'u_d1'), [uB2, uD2]  = mkBlurDiff('u', 'u_luma', 'u_b2', 'u_d2'), [uBc, uDc]  = mkBlurDiff('u', 'u_luma', 'u_bc', 'u_dc'), uSum12 = h('feComposite',  { ns: 'svg', in: 'u_d1', in2: 'u_d2', operator: 'arithmetic', k2: '0', k3: '0', result: 'u_sum12' }), uSumAll = h('feComposite', { ns: 'svg', in: 'u_sum12', in2: 'u_dc', operator: 'arithmetic', k2: '1', k3: '0', result: 'u_sumAll' }), uOut = h('feComposite',    { ns: 'svg', in: 'u_g', in2: 'u_sumAll', operator: 'arithmetic', k2: '1', k3: '1', result: 'u_out' }), pU = mkP('u', 'u_out');
        full.append(cU.t, cU.b, cU.g, uLuma, uB1, uD1, uB2, uD2, uBc, uDc, uSum12, uSumAll, uOut, pU.tmp.tm, pU.s);
        defs.append(lite, fast, fullLight, full);

        const tryAppend = () => { const target = root.body || root.documentElement || root; if (target && target.appendChild) { target.appendChild(svg); return true; } return false; };
        if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }

        const commonByTier = { lite: { toneFuncs: Array.from(cL.t.children), bcLinFuncs: Array.from(cL.b.children), gamFuncs: Array.from(cL.g.children), tmp: pL.tmp, sats: [pL.s] }, fast: { toneFuncs: Array.from(cF.t.children), bcLinFuncs: Array.from(cF.b.children), gamFuncs: Array.from(cF.g.children), tmp: pF.tmp, sats: [pF.s] }, 'full-light': { toneFuncs: Array.from(cUL.t.children), bcLinFuncs: Array.from(cUL.b.children), gamFuncs: Array.from(cUL.g.children), tmp: pUL.tmp, sats: [pUL.s] }, full: { toneFuncs: Array.from(cU.t.children), bcLinFuncs: Array.from(cU.b.children), gamFuncs: Array.from(cU.g.children), tmp: pU.tmp, sats: [pU.s] } };
        return { fidLite, fidFast, fidFullLight, fidFull, filters: { lite, fast, fullLight, full }, commonByTier, fastDetail: { b1: fB1, b2: fB2, sum: fSum }, fullLightDetail: { b1: ulB1, bc: ulBc, sum: ulSum }, fullDetail: { b1: uB1, b2: uB2, bc: uBc, sum12: uSum12, sumAll: uSumAll }, st: { lastKey: '', toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '', commonTier: { lite: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, fast: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, 'full-light': { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' }, full: { toneKey:'', toneTable:'', bcLinKey:'', gammaKey:'', tempKey:'', satKey:'' } }, detailKey: '', fastKey: '', fullLightKey: '', fullKey: '', __filterRes: '' } };
      }

      const _pendingStyleUpdates = []; let _styleFlushScheduled = false;
      function scheduleStyleFlush() { if (_styleFlushScheduled) return; _styleFlushScheduled = true; queueMicrotask(() => { _styleFlushScheduled = false; for (const fn of _pendingStyleUpdates) fn(); _pendingStyleUpdates.length = 0; }); }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { key:'', url:'' }; urlCache.set(root, dc); }
        const vwKey = video.videoWidth || 0, vhKey = video.videoHeight || 0; let tier = 'lite'; const sharpTotal = (Number(s.sharp || 0) + Number(s.sharp2 || 0) + Number(s.clarity || 0)), px = vwKey * vhKey;
        if (sharpTotal > 0) {
          const complexityScore = (s.sharp > 0 ? 1 : 0) + (s.sharp2 > 0 ? 1 : 0) + (s.clarity > 0 ? 1 : 0);
          if (px > 2560 * 1440) { tier = 'fast'; }
          else if (px > 1920 * 1080) { tier = complexityScore >= 2 ? 'full-light' : 'fast'; }
          else { tier = complexityScore >= 3 ? 'full' : (complexityScore >= 2 ? 'full-light' : 'fast'); }
        }
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

          updateKey(cst, 'toneKey', tk, () => { if (cst.toneTable !== table) { cst.toneTable = table; if (common.toneFuncs) for (const fn of common.toneFuncs) setAttr(fn, 'tableValues', table); } });
          updateKey(cst, 'bcLinKey', bcLinKey, () => { if (common.bcLinFuncs) for (const fn of common.bcLinFuncs) { setAttr(fn, 'slope', conStr); setAttr(fn, 'intercept', interceptStr); } });
          updateKey(cst, 'gammaKey', gk, () => { if (common.gamFuncs) for (const fn of common.gamFuncs) setAttr(fn, 'exponent', gk); });
          updateKey(cst, 'satKey', satVal, () => { if (common.sats) for (const satNode of common.sats) setAttr(satNode, 'values', satVal); });
          updateKey(cst, 'tempKey', tmk, () => { if (common.tmp) { setAttr(common.tmp.r, 'slope', rsStr); setAttr(common.tmp.g, 'slope', gsStr); setAttr(common.tmp.b, 'slope', bsStr); } });

          if (tier === 'fast') {
            const lvl = (s.__detailLevel || 'off'), fastKeyNext = `${dk}|${lvl}`;
            if (st.fastKey !== fastKeyNext) {
              st.fastKey = fastKeyNext; const v1Base = (s.sharp || 0) / 50; let v1Mul = 1.00, rad = 2.20, thr = 0.65, halo = 0.20;
              if (lvl === 's') { v1Mul = 1.05; rad = 2.25; thr = 0.66; halo = 0.20; } else if (lvl === 'm') { v1Mul = 1.12; rad = 2.30; thr = 0.65; halo = 0.21; } else if (lvl === 'l') { v1Mul = 1.22; rad = 2.35; thr = 0.64; halo = 0.22; } else if (lvl === 'xl'){ v1Mul = 1.55; rad = 2.90; thr = 0.62; halo = 0.28; }
              applyLumaWeight(nodes.fastDetail.b1, nodes.fastDetail.sum, v1Base * v1Mul, rad, thr, halo, false);
              const v2 = (s.sharp2 || 0) / 50, cl = (s.clarity || 0) / 50; let wV2 = 1.10, wCl = 0.60, microMul = 1.00, kMMul = 1.60, std2 = '0.20';
              if (lvl === 's') { wV2 = 1.05; wCl = 0.55; microMul = 0.98; kMMul = 1.45; std2 = '0.21'; } else if (lvl === 'm') { wV2 = 1.15; wCl = 0.65; microMul = 1.02; kMMul = 1.70; std2 = '0.20'; } else if (lvl === 'l') { wV2 = 1.25; wCl = 0.75; microMul = 1.06; kMMul = 2.00; std2 = '0.18'; } else if (lvl === 'xl'){ wV2 = 1.35; wCl = 0.85; microMul = 1.20; kMMul = 2.70; std2 = '0.16'; }
              const microBase = (v2 * wV2) + (cl * wCl), micro = Math.min(1, microBase * microMul), kM = sCurve(micro) * kMMul;
              setAttr(nodes.fastDetail.b2, 'stdDeviation', micro > 0 ? std2 : '0'); setAttr(nodes.fastDetail.sum, 'k3', kM.toFixed(3));
            }
          } else if (tier === 'full-light') {
            if (st.fullLightKey !== dk) {
              st.fullLightKey = dk; applyLumaWeight(nodes.fullLightDetail.b1, nodes.fullLightDetail.sum, (s.sharp || 0) / 50, 2.2, 0.65, 0.2, false);
              const clVal = (s.clarity || 0) / 50; setAttr(nodes.fullLightDetail.bc, 'stdDeviation', clVal > 0 ? (0.75 + hiResN * 0.35).toFixed(2) : '0'); setAttr(nodes.fullLightDetail.sum, 'k3', (clVal * (1.05 + hiResN * 0.35)).toFixed(3));
            }
          } else if (tier === 'full') {
            if (st.fullKey !== dk) {
              st.fullKey = dk; applyLumaWeight(nodes.fullDetail.b1, nodes.fullDetail.sum12, (s.sharp || 0) / 50, 2.2, 0.65, 0.2, false);
              const v2 = (s.sharp2 || 0) / 50, kF = Math.min(sCurve(Math.min(1, v2)) * 4.8, 3.5); setAttr(nodes.fullDetail.b2, 'stdDeviation', v2 > 0 ? '0.25' : '0'); setAttr(nodes.fullDetail.sum12, 'k3', kF.toFixed(3));
              const clVal = (s.clarity || 0) / 50; setAttr(nodes.fullDetail.bc, 'stdDeviation', clVal > 0 ? (0.85 + hiResN * 0.55).toFixed(2) : '0'); setAttr(nodes.fullDetail.sumAll, 'k3', (clVal * (1.15 + hiResN * 0.55)).toFixed(3));
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
        prepareCached: (video, s) => {
          try {
            const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
            let nodes = ctxMap.get(root);
            const prevKey = nodes ? nodes.st.lastKey : '';
            const url = prepare(video, s);
            nodes = ctxMap.get(root);
            return { url, changed: nodes ? nodes.st.lastKey !== prevKey : true };
          } catch (e) { log.warn('filter prepare failed:', e); return { url: null, changed: false }; }
        },
        applyUrl: (el, urlObj) => {
          if (!el) return;
          const url = typeof urlObj === 'string' ? urlObj : urlObj?.url;
          const forceReapply = urlObj?.changed;
          const st = getVState(el);
          if (!url) { if (st.applied) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; } return; }
          if (st.lastFilterUrl === url && !forceReapply) return;
          if (st.lastFilterUrl === url && forceReapply) {
            _pendingStyleUpdates.push(() => {
              el.style.setProperty('filter', 'none', 'important');
              queueMicrotask(() => {
                el.style.setProperty('filter', url, 'important');
                el.style.setProperty('-webkit-filter', url, 'important');
              });
            });
          } else {
            _pendingStyleUpdates.push(() => {
              el.style.setProperty('filter', url, 'important');
              el.style.setProperty('-webkit-filter', url, 'important');
            });
          }
          scheduleStyleFlush(); st.applied = true; st.lastFilterUrl = url;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied) return;
          _pendingStyleUpdates.push(() => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); });
          scheduleStyleFlush(); st.applied = false; st.lastFilterUrl = null;
        }
      };
    }

    function createFiltersWebGL(Utils) {
      const pipelines = new WeakMap();
      const tq = (v, st) => Math.round(v / st) * st;
      function compileShaderChecked(gl, type, source) { const shader = gl.createShader(type); if (!shader) throw new Error('gl.createShader failed'); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const info = gl.getShaderInfoLog(shader) || 'unknown error'; gl.deleteShader(shader); throw new Error(`Shader compile failed (${type}): ${info}`); } return shader; }
      function linkProgramChecked(gl, vs, fs) { const program = gl.createProgram(); if (!program) throw new Error('gl.createProgram failed'); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const info = gl.getProgramInfoLog(program) || 'unknown error'; gl.deleteProgram(program); throw new Error(`Program link failed: ${info}`); } return program; }

      function buildToneLUT256(toe, mid, shoulder, gain = 1.0) {
        const curve = computeToneCurve(256, VSC_CLAMP(toe / 14, -1, 1), VSC_CLAMP(mid, -1, 1), VSC_CLAMP(shoulder / 16, -1, 1), gain);
        const out = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) { const v = (curve[i] * 255 + 0.5) | 0, o = i * 4; out[o] = out[o+1] = out[o+2] = v; out[o+3] = 255; } return out;
      }

      const GL2_HDR = `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n`;
      const GL1_HDR = `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`;
      const UNI_BLOCK = `uniform sampler2D uVideoTex;uniform sampler2D uToneTex;uniform vec4 uParams;uniform vec4 uParams2;uniform vec3 uRGBGain;uniform float uHDRToneMap;\n`;
      const hdr = (gl2) => (gl2 ? GL2_HDR : GL1_HDR) + UNI_BLOCK;

      const glslHDR = `
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
const mat3 M709to2020 = mat3(0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.0880, 0.8956);
vec3 reinhardToneMap(vec3 c, float wp) { return c * (1.0 + c / (wp * wp)) / (1.0 + c); }
vec3 linearToPQ(vec3 c) {
  vec3 Ym = pow(clamp(c / 10000.0, 0.0, 1.0), vec3(0.1593017578125));
  return pow((0.8359375 + 18.8515625 * Ym) / (1.0 + 18.6875 * Ym), vec3(78.84375));
}
vec3 applyHDRToneMap(vec3 color, float hdrEn) {
  if (hdrEn < 0.5) return color;
  return linearToPQ(reinhardToneMap(M709to2020 * srgbToLinear(color) * 200.0, 400.0));
}`;

      const glslCommon = `
const vec3 LUMA=vec3(0.2126,0.7152,0.0722);
float tone1(float y){return TEX(uToneTex,vec2(y*(255./256.)+(.5/256.),.5)).r;}
vec3 softClip(vec3 c,float knee){vec3 x=max(c-1.,vec3(0.));return c-(x*x)/(x+vec3(knee));}
vec3 applyGrading(vec3 color){
float y=dot(color,LUMA),y2=tone1(clamp(y,0.,1.)),ratio=y2/max(1e-4,y);color*=ratio;
color=(color-.5)*uParams.y+.5;
color=color*uParams.x+(uParams2.x/1000.);
if(uParams.w!=1.)color=pow(max(color,vec3(0.)),vec3(1./uParams.w));
float luma=dot(color,LUMA),hiLuma=clamp((luma-.72)/.28,0.,1.),satReduce=hiLuma*hiLuma*(3.-2.*hiLuma),currentSat=uParams.z*(1.-.05*satReduce);
color=luma+(color-luma)*currentSat;
color*=uRGBGain;
return clamp(softClip(color,.18),0.,1.);
}`;

      function buildFsColorOnly({ gl2 }) { return hdr(gl2) + glslHDR + glslCommon + `void main(){vec3 color=TEX(uVideoTex,vTexCoord).rgb;vec3 graded=applyGrading(color);outColor=vec4(applyHDRToneMap(graded,uHDRToneMap),1.);}`; }
      function buildFsSharpen({ gl2 }) { return hdr(gl2) + `uniform vec2 uResolution;uniform vec3 uSharpParams;\n` + glslHDR + glslCommon + `vec3 satMix(vec3 c,float sat){float l=dot(c,LUMA);return vec3(l)+(c-vec3(l))*sat;}vec3 rcasSharpen(sampler2D tex,vec2 uv,vec2 texel,float sharpAmount){vec3 b=TEX(tex,uv+vec2(0.,-texel.y)).rgb,d=TEX(tex,uv+vec2(-texel.x,0.)).rgb,e=TEX(tex,uv).rgb,f=TEX(tex,uv+vec2(texel.x,0.)).rgb,h=TEX(tex,uv+vec2(0.,texel.y)).rgb;vec3 mn=min(b,min(d,min(e,min(f,h)))),mx=max(b,max(d,max(e,max(f,h))));if(uParams2.z<.5){vec3 a=TEX(tex,uv+vec2(-texel.x,-texel.y)).rgb,c=TEX(tex,uv+vec2(texel.x,-texel.y)).rgb,g=TEX(tex,uv+vec2(-texel.x,texel.y)).rgb,i=TEX(tex,uv+vec2(texel.x,texel.y)).rgb;mn=min(mn,min(a,min(c,min(g,i))));mx=max(mx,max(a,max(c,max(g,i))));}float aAmt=clamp(sharpAmount,0.,1.),peak=-1./mix(9.,3.6,aAmt);vec3 hitMin=mn/(4.*mx+1e-4),hitMax=(peak-mx)/(4.*mn+peak);float lobe=max(-.1875,min(max(max(hitMin.r,hitMax.r),max(max(hitMin.g,hitMax.g),max(hitMin.b,hitMax.b))),0.));float edgeLuma=abs(dot(b-e,LUMA))+abs(dot(d-e,LUMA))+abs(dot(f-e,LUMA))+abs(dot(h-e,LUMA)),edgeDamp=1.-smoothstep(.05,.25,edgeLuma*.25);lobe*=mix(1.,edgeDamp,clamp(uSharpParams.z,0.,1.));return(lobe*(b+d+f+h)+e)/(4.*lobe+1.);}void main(){vec2 texel=1./uResolution;vec3 color=TEX(uVideoTex,vTexCoord).rgb;float sharpAmount=uParams2.y;if(sharpAmount>0.){color=rcasSharpen(uVideoTex,vTexCoord,texel,sharpAmount);vec3 d0=satMix(color,uSharpParams.x);color=mix(color,d0,uSharpParams.y);}vec3 graded=applyGrading(color);outColor=vec4(applyHDRToneMap(graded,uHDRToneMap),1.);}`; }
      function buildShaderSources(gl) { const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext); return { vs: isGL2 ? `#version 300 es\nin vec2 aPosition;\nin vec2 aTexCoord;\nout vec2 vTexCoord;\nvoid main(){\n gl_Position=vec4(aPosition,0.,1.);\n vTexCoord=aTexCoord;\n}` : `attribute vec2 aPosition;attribute vec2 aTexCoord;varying vec2 vTexCoord;void main(){gl_Position=vec4(aPosition,0.,1.);vTexCoord=aTexCoord;}`, fsColorOnly: buildFsColorOnly({ gl2: isGL2 }), fsSharpen: buildFsSharpen({ gl2: isGL2 }) }; }

      function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
      function getSharpProfile(vVals, rawW, rawH, isHdr) {
        const s1 = Number(vVals.sharp || 0), s2 = Number(vVals.sharp2 || 0), cl = Number(vVals.clarity || 0); if (s1 <= 0.01 && s2 <= 0.01 && cl <= 0.01) return { amount: 0.0, tapMode: 1.0, desatSat: 1.0, biasMix: 0.0, edgeDampMix: 0.4 };
        let level = 'S'; const isXL = (s1 >= 18 && s2 >= 16 && cl >= 24); if (isXL) level = 'XL'; else if (s1 >= 14 && (s2 >= 10 || cl >= 14)) level = 'L'; else if (s1 >= 10 && (s2 >= 6  || cl >= 8 )) level = 'M';
        const rawPx = rawW * rawH, pxScale = Math.sqrt(Math.max(1, rawPx) / (1280 * 720)), hiResN = clamp01((pxScale - 1.0) / 1.7), n1 = clamp01(s1 / 18.0), n2 = clamp01(s2 / 16.0), n3 = clamp01(cl / 24.0); let base = clamp01((0.58 * n1) + (0.28 * n2) + (0.24 * n3));
        let scale = 1.0, cap = 1.0, desatSat = 0.88, biasMix = 0.40, edgeDampMix = 0.33;
        if (level === 'S') { scale = 0.78; cap = 0.55; desatSat = 0.90; biasMix = 0.30; edgeDampMix = 0.38; } else if (level === 'M') { scale = 0.92; cap = 0.68; desatSat = 0.88; biasMix = 0.38; edgeDampMix = 0.33; } else if (level === 'L') { scale = 1.08; cap = 0.80; desatSat = 0.86; biasMix = 0.46; edgeDampMix = 0.28; } else { scale = 1.26; cap = 0.92; desatSat = 0.84; biasMix = 0.60; edgeDampMix = 0.22; }
        let amount = clamp01(base * scale); if (amount > cap) amount = cap; amount *= (1.0 - 0.25 * hiResN); if (rawPx >= 3840 * 2160) amount *= 0.80; if (isHdr) amount *= 0.92;
        return { amount, tapMode: ((rawPx >= (2560 * 1440) && amount < 0.80) || (amount < 0.12)) ? 1.0 : 0.0, desatSat, biasMix, edgeDampMix };
      }

      class WebGLPipeline {
        constructor() {
          this.canvas = null; this.gl = null; this.activeProgramKind = ''; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this._videoHidden = false; this._prevVideoOpacity = ''; this._prevVideoVisibility = ''; this.disabledUntil = 0; this._texW = 0; this._texH = 0; this._loopToken = 0; this._loopRunning = false; this._isGL2 = false; this._qMon = { lastT: 0, lastDropped: 0, dropRateEma: 0 }; this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0; this._initialStyleSynced = false; this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; this.toneTexture = null; this._toneKey = ''; this._outputReady = false; this._timerId = 0; this._rvfcId = 0; this._rafId = 0; this._lastRawW = 0; this._lastRawH = 0; this._contextLostCount = 0; this._suspended = false; this._lastRenderT = 0; this._idleCheckTimer = 0;
          this._onContextLost = (e) => { e.preventDefault(); const now = performance.now(); this._contextLostCount = (this._contextLostCount || 0) + 1; this.disabledUntil = now + Math.min(30000, 3000 * Math.pow(1.5, this._contextLostCount)); this.active = false; this._loopToken++; this._loopRunning = false; if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; } try { if (this.canvas) this.canvas.style.opacity = '0'; } catch (_) {} try { const st = this.video ? getVState(this.video) : null; if (st) st.webglDisabledUntil = now + SYS.WFC; } catch (_) {} safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); };
          this._onContextRestored = () => { try { this._loopToken++; this._loopRunning = false; if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; } if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; } if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') { try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {} this._rvfcId = 0; } this.disposeGLResources({ keepCanvasListeners: true }); if (this.initGLResourcesOnExistingCanvas()) { if (this.video) { this.active = true; this._outputReady = false; this.canvas.style.opacity = '0'; this.startRenderLoop(); } } else { this.disabledUntil = performance.now() + 5000; } } catch (_) { this.disabledUntil = performance.now() + 5000; } };
        }
        ensureCanvas() { if (this.canvas) return; this.canvas = document.createElement('canvas'); this.canvas.style.cssText = `position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;display:block!important;pointer-events:none!important;margin:0!important;padding:0!important;contain:strict!important;will-change:transform,opacity!important;opacity:0!important;`; this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false }); this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, OPT_P); }
        _bindProgramHandles(program, key) { const gl = this.gl; gl.useProgram(program); const handles = { program, uResolution: gl.getUniformLocation(program, 'uResolution'), uVideoTex: gl.getUniformLocation(program, 'uVideoTex'), uToneTex: gl.getUniformLocation(program, 'uToneTex'), uParams: gl.getUniformLocation(program, 'uParams'), uParams2: gl.getUniformLocation(program, 'uParams2'), uRGBGain: gl.getUniformLocation(program, 'uRGBGain'), uSharpParams: gl.getUniformLocation(program, 'uSharpParams'), uHDRToneMap: gl.getUniformLocation(program, 'uHDRToneMap'), aPosition: gl.getAttribLocation(program, 'aPosition'), aTexCoord: gl.getAttribLocation(program, 'aTexCoord') }; if (handles.uVideoTex) gl.uniform1i(handles.uVideoTex, 0); if (handles.uToneTex) gl.uniform1i(handles.uToneTex, 1); this[`handles_${key}`] = handles; }
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
            this._toneKey = '';
            return true;
          } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
        }
        suspendContext() {
          if (!this.gl) return;
          this._loopToken++; this._loopRunning = false;
          if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; }
          if (this.canvas) this.canvas.style.opacity = '0';
          this.disposeGLResources({ keepCanvasListeners: true });
          this._suspended = true; log.debug('WebGL context suspended for idle video');
        }
        resumeContext() {
          if (!this._suspended) return true;
          this._suspended = false;
          if (!this.initGLResourcesOnExistingCanvas()) { this.disabledUntil = performance.now() + 5000; return false; }
          this._outputReady = false; this.canvas.style.opacity = '0'; this.startRenderLoop();
          return true;
        }
        startIdleWatch() {
          if (this._idleCheckTimer) return;
          this._idleCheckTimer = setInterval(() => {
            if (!this.active) { this.stopIdleWatch(); return; }
            if (performance.now() - this._lastRenderT > 10000) this.suspendContext();
          }, 5000);
        }
        stopIdleWatch() { if (this._idleCheckTimer) { clearInterval(this._idleCheckTimer); this._idleCheckTimer = 0; } }
        init() { return this.initGLResourcesOnExistingCanvas(); }
        attachToVideo(video) {
          if (this._suspended) { this.video = video; if (!this.resumeContext()) return false; }
          else if (!this.active && !this.init()) return false;
          this.video = video; this.originalParent = video.parentNode; this._videoHidden = false; this._outputReady = false; this.canvas.style.opacity = '0';
          if (this.originalParent) { const cs = window.getComputedStyle(this.originalParent); if (cs.position === 'static') { this._parentPrevPosition = this.originalParent.style.position || ''; this.originalParent.style.position = 'relative'; this._parentStylePatched = true; this._patchedParent = this.originalParent; } if (video.nextSibling) this.originalParent.insertBefore(this.canvas, video.nextSibling); else this.originalParent.appendChild(this.canvas); }
          if (this._styleObs) this._styleObs.disconnect(); this._styleObs = new MutationObserver(() => { this._styleDirty = true; }); try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
          try { video.addEventListener('transitionend', () => { this._styleDirty = true; }, OPT_P); } catch (_) {}
          this._styleDirty = true; this.active = true; this.startRenderLoop(); this.startIdleWatch(); return true;
        }
        updateParams(vVals) { this.vVals = vVals; }
        syncCanvasPresentationFromVideo(video, now) {
          if (!this.canvas || !video) return;
          if (!this._styleDirty) return;
          if ((now - this._lastStyleSyncT) < 500) return;
          this._styleDirty = false;
          this._lastStyleSyncT = now;
          const vs = window.getComputedStyle(video), cs = this.canvas.style;
          if (cs.objectFit !== vs.objectFit) cs.objectFit = vs.objectFit || 'contain';
          if (cs.objectPosition !== vs.objectPosition) cs.objectPosition = vs.objectPosition;
          const tr = vs.transform, nextTr = (tr && tr !== 'none') ? tr : '';
          if (cs.transform !== nextTr) { cs.transform = nextTr; cs.transformOrigin = vs.transformOrigin || ''; }
          if (!this._initialStyleSynced) {
            this._initialStyleSynced = true;
            cs.borderRadius = vs.borderRadius || ''; cs.clipPath = vs.clipPath || ''; cs.webkitClipPath = vs.webkitClipPath || ''; cs.mixBlendMode = vs.mixBlendMode || ''; cs.isolation = vs.isolation || '';
          }
          const vz = vs.zIndex; let zi = '1'; if (vz && vz !== 'auto') { const n = parseInt(vz, 10); if (Number.isFinite(n)) { zi = String(Math.min(n + 1, 2147483646)); } } if (cs.zIndex !== zi) cs.zIndex = zi;
        }
        _updatePlaybackQuality(now) {
          const v = this.video; if (!v || typeof v.getVideoPlaybackQuality !== 'function') return; if (now - this._qMon.lastT < 1000) return;
          try { const q = v.getVideoPlaybackQuality(), dropped = q.droppedVideoFrames || 0; if (this._qMon.lastT > 0) { const dd = Math.max(0, dropped - this._qMon.lastDropped); this._qMon.dropRateEma = this._qMon.dropRateEma ? (this._qMon.dropRateEma * 0.8 + dd * 0.2) : dd; } this._qMon.lastDropped = dropped; this._qMon.lastT = now; if (this._qMon.dropRateEma > 1.5) { const st = getVState(v); if (st) st.webglDisabledUntil = now + 8000; safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); } } catch (_) {}
        }
        render() {
          if (!this.active || !this.gl || !this.video || !this.vVals) return; const gl = this.gl, video = this.video, now = performance.now(); if (now < this.disabledUntil) return;
          const st = getVState(video); if (st.webglDisabledUntil && now < st.webglDisabledUntil) return; if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
          this._lastRenderT = now;
          if (this.canvas.parentNode !== video.parentNode && video.parentNode) { this.originalParent = video.parentNode; const p = video.parentNode; if (video.nextSibling) p.insertBefore(this.canvas, video.nextSibling); else p.appendChild(this.canvas); }
          this.syncCanvasPresentationFromVideo(video, now); this._updatePlaybackQuality(now);
          let rawW = video.videoWidth, rawH = video.videoHeight; const dpr = Math.min(window.devicePixelRatio || 1, 2), displayW = video.clientWidth * dpr, displayH = video.clientHeight * dpr;
          const qs = window.__VSC_INTERNAL__?.App?.getQualityScale?.() || 1.0; const gpuTier = (qs > 0.9) ? 2160 : (qs > 0.7) ? 1440 : 1080;
          const MAX_W = Math.min(3840, Math.max(displayW, 640)), MAX_H = Math.min(gpuTier, Math.max(displayH, 360));
          let w = rawW, h = rawH; if (w > MAX_W || h > MAX_H) { const scale = Math.min(MAX_W / w, MAX_H / h); w = Math.round(w * scale); h = Math.round(h * scale); }
          const isHdr = VSC_MEDIA.isHdr, prof = getSharpProfile(this.vVals, rawW, rawH, isHdr), useSharpen = prof.amount > 0.0, kind = useSharpen ? 'sharp' : 'color', H = useSharpen ? this.handles_sharp : this.handles_color;
          let programChanged = false; if (this.activeProgramKind !== kind) { this.activeProgramKind = kind; programChanged = true; gl.useProgram(H.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.enableVertexAttribArray(H.aPosition); gl.vertexAttribPointer(H.aPosition, 2, gl.FLOAT, false, 0, 0); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.enableVertexAttribArray(H.aTexCoord); gl.vertexAttribPointer(H.aTexCoord, 2, gl.FLOAT, false, 0, 0); }
          const resized = (this.canvas.width !== w || this.canvas.height !== h); if (resized) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
          if ((resized || programChanged || this._lastRawW !== rawW || this._lastRawH !== rawH) && H.uResolution) { gl.uniform2f(H.uResolution, rawW, rawH); this._lastRawW = rawW; this._lastRawH = rawH; }
          const rs = this.vVals._rs ?? 1, gs = this.vVals._gs ?? 1, bs = this.vVals._bs ?? 1; if (H.uParams) gl.uniform4f(H.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);
          const hiReduce = isHdr ? 0.82 : 0.88; if (H.uParams2) gl.uniform4f(H.uParams2, this.vVals.bright || 0.0, useSharpen ? prof.amount : 0.0, prof.tapMode, hiReduce);
          if (H.uRGBGain) gl.uniform3f(H.uRGBGain, rs, gs, bs); if (useSharpen && H.uSharpParams) gl.uniform3f(H.uSharpParams, prof.desatSat, prof.biasMix, prof.edgeDampMix);
          const hdrToneMap = (this.vVals._hdrToneMap && isHdr) ? 1.0 : 0.0; if (H.uHDRToneMap !== undefined && H.uHDRToneMap !== null) gl.uniform1f(H.uHDRToneMap, hdrToneMap);
          const toe = this.vVals.toe || 0, mid = this.vVals.mid || 0, shoulder = this.vVals.shoulder || 0, toneKey = `${tq(toe, 0.2)}|${tq(mid, 0.02)}|${tq(shoulder, 0.2)}|${tq(this.vVals.gain || 1, 0.06)}`;
          if (this._toneKey !== toneKey && this.toneTexture) { this._toneKey = toneKey; const lut = buildToneLUT256(toe, mid, shoulder, this.vVals.gain || 1.0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut); }
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
          try {
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            try {
              if (this._isGL2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
              else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            } catch (_) {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); st.webglFailCount = 0;
            if (!this._outputReady) { this._outputReady = true; this.canvas.style.opacity = '1'; if (!this._videoHidden) { this._prevVideoOpacity = video.style.opacity; this._prevVideoVisibility = video.style.visibility; video.style.setProperty('opacity', '0.001', 'important'); this._videoHidden = true; } }
          } catch (err) {
            st.webglFailCount = (st.webglFailCount || 0) + 1; if (CONFIG.DEBUG) log.warn('WebGL render failure:', err);
            const msg = String(err?.message || err || ''), looksTaint = /SecurityError|cross.origin|cross-origin|taint|insecure|Tainted|origin/i.test(msg);
            if (st.webglFailCount >= SYS.WFT) { st.webglFailCount = 0; if (looksTaint) { st.webglTainted = true; log.warn('WebGL tainted/CORS-like failure → fallback to SVG'); } else { if (st) st.webglDisabledUntil = now + SYS.WFC; log.warn('WebGL transient failure → cooldown then retry'); } safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); }
          }
        }
        startRenderLoop() { if (this._loopRunning) return; this._loopRunning = true; const token = ++this._loopToken; const loopFn = (now, meta) => { if (token !== this._loopToken || !this.active || !this.video) { this._loopRunning = false; return; } this.render(); this.scheduleNextFrame(loopFn); }; this.scheduleNextFrame(loopFn); }
        scheduleNextFrame(loopFn) {
          const pausedOrHidden = !!(document.hidden || this.video?.paused); if (pausedOrHidden) { this._timerId = setTimeout(() => { this._timerId = 0; loopFn(performance.now(), null); }, 220); return; }
          if (this.video && typeof this.video.requestVideoFrameCallback === 'function') { this._rvfcId = this.video.requestVideoFrameCallback(loopFn); return; }
          this._rafId = requestAnimationFrame(loopFn);
        }
        disposeGLResources(opts = {}) {
          const { keepCanvasListeners = false } = opts; const gl = this.gl;
          if (gl) { try { if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; } if (this.toneTexture) { gl.deleteTexture(this.toneTexture); this.toneTexture = null; } if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; } if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; } if (this.handles_color?.program) gl.deleteProgram(this.handles_color.program); if (this.handles_sharp?.program) gl.deleteProgram(this.handles_sharp.program); } catch (_) {} }
          if (!keepCanvasListeners && this.canvas) { try { this.canvas.removeEventListener('webglcontextlost', this._onContextLost); this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored); } catch (_) {} }
          this.gl = null; this._texW = 0; this._texH = 0; this.activeProgramKind = '';
        }
        shutdown() {
          this.stopIdleWatch();
          this.active = false; this._loopToken++; this._loopRunning = false; if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; } if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
          if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') { try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {} this._rvfcId = 0; }
          if (this._styleObs) { this._styleObs.disconnect(); this._styleObs = null; }
          const videoRef = this.video; const prevOpacity = this._prevVideoOpacity; const prevVisibility = this._prevVideoVisibility; const wasHidden = this._videoHidden;
          this._videoHidden = false;
          try { if (this.canvas && this.canvas.parentNode) { this.canvas.remove(); } } catch (_) {}
          if (this._parentStylePatched && this._patchedParent) { try { this._patchedParent.style.position = this._parentPrevPosition; } catch (_) {} this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; }
          this.disposeGLResources();
          if (wasHidden && videoRef) { queueMicrotask(() => { queueMicrotask(() => { videoRef.style.opacity = prevOpacity; videoRef.style.visibility = prevVisibility; }); }); }
        }
      }
      return { apply: (el, vVals) => { let pipe = pipelines.get(el); if (!pipe) { pipe = new WebGLPipeline(); pipelines.set(el, pipe); } if (!pipe.active || pipe.video !== el || !pipe.gl) { if (!pipe.attachToVideo(el)) { pipelines.delete(el); return false; } } pipe.updateParams(vVals); return true; }, clear: (el) => { const pipe = pipelines.get(el); if (pipe) { pipe.shutdown(); pipelines.delete(el); } } };
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
      const uiWakeCtrl = new AbortController();
      const sub = (k, fn) => { const cb = fn; sm.sub(k, cb); return cb; };
      const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
      const allowUiInThisDoc = () => { if (registry.videos.size > 0) return true; return !!document.querySelector('video, object, embed'); };

      function setAndHint(path, value) {
        const prev = sm.get(path);
        const changed = !Object.is(prev, value);
        if (changed) sm.set(path, value);
        (changed ? ApplyReq.hard() : ApplyReq.soft());
      }

      const getUiRoot = () => {
        const fs = document.fullscreenElement || null;
        if (fs) {
          if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body;
          if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs;
          return fs;
        }
        return document.documentElement || document.body;
      }

      function bindReactive(btn, paths, apply, sm, sub) {
        const pathArr = Array.isArray(paths) ? paths : [paths];
        const sync = () => { if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); };
        pathArr.forEach(p => sub(p, sync)); sync(); return sync;
      }

      function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false, isBitmask = false }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
        for (const it of items) {
          const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text);
          b.onclick = (e) => {
            e.stopPropagation();
            if (isBitmask) {
              sm.set(key, ShadowMask.toggle(sm.get(key), it.value));
            } else {
              const cur = sm.get(key);
              if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
              else setAndHint(key, it.value);
            }
            ApplyReq.hard();
          };
          bindReactive(b, [key], (el, v) => el.classList.toggle('active', isBitmask ? ShadowMask.has(v, it.value) : v === it.value), sm, sub);
          row.append(b);
        }
        const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
        offBtn.onclick = (e) => { e.stopPropagation(); sm.set(key, isBitmask ? 0 : offValue); ApplyReq.hard(); };
        bindReactive(offBtn, [key], (el, v) => el.classList.toggle('active', isBitmask ? (Number(v)|0) === 0 : v === offValue), sm, sub);
        if (isBitmask || offValue != null) row.append(offBtn);
        return row;
      }

      const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));

      const clampPanelIntoViewport = () => {
        try {
          if (!container) return;
          const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main');
          if (!mainPanel || mainPanel.style.display === 'none') return;
          if (!hasUserDraggedUI) {
            mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = '';
            queueMicrotask(() => {
              const r = mainPanel.getBoundingClientRect();
              if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) {
                mainPanel.style.right = '70px';
                mainPanel.style.top = '50%';
                mainPanel.style.transform = 'translateY(-50%)';
              }
            });
            return;
          }
          const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
          const vv = window.visualViewport;
          const vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0);
          const vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
          const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0;
          const offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
          if (!vw || !vh) return;
          const w = r.width || 300, panH = r.height || 400;
          const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8));
          const top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
          if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
          requestAnimationFrame(() => {
            mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
          });
        } catch (_) {}
      };

      const syncVVVars = () => {
        try {
          const root = document.documentElement, vv = window.visualViewport;
          if (!root || !vv) return;
          root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`);
          root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`);
        } catch (_) {}
      };

      syncVVVars();
      try {
        const vv = window.visualViewport;
        if (vv) {
          on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal });
          on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal });
        }
      } catch (_) {}

      const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport);
      on(window, 'resize', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });
      on(window, 'orientationchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });
      on(document, 'fullscreenchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });

      const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

      const build = () => {
        if (container) return;
        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
        const style = `:host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:auto;bottom:max(12px,calc(env(safe-area-inset-bottom,0px) + 12px));right:max(12px,calc(env(safe-area-inset-right,0px) + 12px));left:max(12px,calc(env(safe-area-inset-left,0px) + 12px));transform:none;width:auto;max-height:70vh;padding:12px;border-radius:14px}.prow{flex-wrap:wrap}.btn,.pbtn{min-height:38px;font-size:12px}}.header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active{background:var(--ac);border-color:var(--ac)}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.pbtn.active{background:var(--ac);border-color:var(--ac)}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);

        const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

        const rmBtn = h('button', { id: 'rm-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_RENDER_MODE, sm.get(P.APP_RENDER_MODE) === 'webgl' ? 'svg' : 'webgl'); } });
        bindReactive(rmBtn, [P.APP_RENDER_MODE], (el, v) => { el.textContent = `🎨 ${v === 'webgl' ? 'WebGL' : 'SVG'}`; el.style.color = v === 'webgl' ? '#ffaa00' : '#88ccff'; el.style.borderColor = v === 'webgl' ? '#ffaa00' : '#88ccff'; }, sm, sub);

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn' }, '🔊 Brickwall (EQ+Dyn)');
        boostBtn.onclick = (e) => {
          e.stopPropagation();
          if (window.__VSC_INTERNAL__?.AudioWarmup) window.__VSC_INTERNAL__.AudioWarmup();
          setAndHint(P.A_EN, !sm.get(P.A_EN));
        };
        bindReactive(boostBtn, [P.A_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const pipBtn = h('button', { class: 'btn', onclick: async (e) => { e.stopPropagation(); const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');
        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn' }, '🔍 줌 제어');
        zoomBtn.onclick = (e) => {
          e.stopPropagation();
          const zm = window.__VSC_INTERNAL__.ZoomManager;
          const v = window.__VSC_APP__?.getActiveVideo();
          if (!zm || !v) return;
          if (zm.isZoomed(v)) {
            zm.resetZoom(v);
            setAndHint(P.APP_ZOOM_EN, false);
          } else {
            const rect = v.getBoundingClientRect();
            zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
            setAndHint(P.APP_ZOOM_EN, true);
          }
        };
        bindReactive(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const autoSceneBtn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); } }, '✨ Auto Scene');
        bindReactive(autoSceneBtn, [P.APP_AUTO_SCENE], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const pwrBtn = h('button', { id: 'pwr-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
        bindReactive(pwrBtn, [P.APP_ACT], (el, v) => el.style.color = v ? '#2ecc71' : '#e74c3c', sm, sub);

        const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
        advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
        bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

        const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
          renderButtonRow({
            label: '블랙', key: P.V_SHADOW_MASK, isBitmask: true,
            items: [
              { text: '외암', value: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' },
              { text: '중암', value: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' },
              { text: '심암', value: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' }
            ]
          }),
          renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
          renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }),
          h('hr'),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, 'HDR'));
            const hdrBtn = h('button', { class: 'pbtn', style: 'flex:1' }, '🎬 Rec.2020 톤맵');
            hdrBtn.onclick = (e) => {
              e.stopPropagation();
              if (!VSC_MEDIA.isHdr) {
                hdrBtn.textContent = '⚠️ HDR 미감지';
                setTimeout(() => { hdrBtn.textContent = '🎬 Rec.2020 톤맵'; }, 2000);
                return;
              }
              setAndHint(P.APP_HDR_TONEMAP, !sm.get(P.APP_HDR_TONEMAP));
            };
            bindReactive(hdrBtn, [P.APP_HDR_TONEMAP], (el, v) => {
              el.classList.toggle('active', !!v);
              el.style.opacity = VSC_MEDIA.isHdr ? '1' : '0.5';
            }, sm, sub);
            r.append(hdrBtn);
            return r;
          })(),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '오디오'));
            const mb = h('button', { class: 'pbtn', style: 'flex:1' }, '🎚️ 멀티밴드');
            mb.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_MULTIBAND, !sm.get(P.A_MULTIBAND)); };
            bindReactive(mb, [P.A_MULTIBAND], (el, v) => el.classList.toggle('active', !!v), sm, sub);
            const lf = h('button', { class: 'pbtn', style: 'flex:1' }, '📊 LUFS 정규화');
            lf.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_LUFS, !sm.get(P.A_LUFS)); };
            bindReactive(lf, [P.A_LUFS], (el, v) => el.classList.toggle('active', !!v), sm, sub);
            r.append(mb, lf);
            return r;
          })(),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'width:35px;' }, ''));
            const dl = h('button', { class: 'pbtn', style: 'flex:1' }, '🗣️ 대화 감지(AI)');
            dl.onclick = (e) => { e.stopPropagation(); setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE)); };
            bindReactive(dl, [P.A_DIALOGUE], (el, v) => el.classList.toggle('active', !!v), sm, sub);
            r.append(dl);
            return r;
          })()
        ]);

        bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, autoSceneBtn ]),
          h('div', { class: 'prow' }, [ pipBtn, zoomBtn ]),
          h('div', { class: 'prow' }, [ boostBtn ]),
          h('div', { class: 'prow' }, [
            h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
            pwrBtn,
            h('button', { class: 'btn', onclick: (e) => {
              e.stopPropagation();
              sm.batch('video', DEFAULTS.video);
              sm.batch('audio', DEFAULTS.audio);
              sm.batch('playback', DEFAULTS.playback);
              sm.set(P.APP_AUTO_SCENE, false);
              ApplyReq.hard();
            } }, '↺ 리셋')
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
          const pt = (e && e.touches && e.touches[0]) ? e.touches[0] : e;
          if (!pt) return;
          if (e.target && e.target.tagName === 'BUTTON') return;
          if (e.cancelable) e.preventDefault();
          stopDrag?.();
          hasUserDraggedUI = true;
          let startX = pt.clientX, startY = pt.clientY;
          const rect = mainPanel.getBoundingClientRect();

          mainPanel.style.transform = 'none';
          mainPanel.style.top = `${rect.top}px`;
          mainPanel.style.right = 'auto';
          mainPanel.style.left = `${rect.left}px`;

          try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}

          stopDrag = bindElementDrag(dragHandle, (ev) => {
            const mv = (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
            if (!mv) return;
            const dx = mv.clientX - startX, dy = mv.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx));
            let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
            mainPanel.style.left = `${nextLeft}px`;
            mainPanel.style.top = `${nextTop}px`;
          }, () => {
            stopDrag = null;
          });
        };

        on(dragHandle, 'pointerdown', startPanelDrag);
        on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });

        container = host;
        getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) {
          if (gearHost) gearHost.style.display = 'none';
          return;
        }
        if (gearHost) {
          gearHost.style.display = 'block';
          return;
        }

        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${CONFIG.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);

        let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear' }, '⚙');
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));

        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1';
          clearTimeout(fadeTimer);
          const inFs = !!document.fullscreenElement;
          if (inFs || CONFIG.IS_MOBILE) return;
          fadeTimer = setTimeout(() => {
            if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) {
              gearBtn.style.opacity = '0.15';
            }
          }, 2500);
        };
        wakeGear = wake;

        on(window, 'mousemove', wake, { passive: true, signal: uiWakeCtrl.signal });
        on(window, 'touchstart', wake, { passive: true, signal: uiWakeCtrl.signal });
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
              if (!dragThresholdMet) {
                dragThresholdMet = true;
                gearBtn.style.transition = 'none';
                gearBtn.style.transform = 'none';
                gearBtn.style.top = `${rect.top}px`;
              }
              if (ev.cancelable) ev.preventDefault();
            }
            if (dragThresholdMet) {
              let newTop = rect.top + (currentY - startY);
              newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));
              gearBtn.style.top = `${newTop}px`;
            }
          }, () => {
            gearBtn.style.transition = '';
            setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100);
          });
        };
        on(gearBtn, 'pointerdown', handleGearDrag);

        let lastToggle = 0, lastTouchAt = 0;
        const onGearActivate = (e) => {
          if (dragThresholdMet) {
            safe(() => { if (e && e.cancelable) e.preventDefault(); });
            return;
          }
          const now = performance.now();
          if (now - lastToggle < 300) {
            safe(() => { if (e && e.cancelable) e.preventDefault(); });
            return;
          }
          lastToggle = now;
          setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        };

        on(gearBtn, 'touchend', (e) => {
          lastTouchAt = performance.now();
          safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); });
          onGearActivate(e);
        }, { passive: false });

        on(gearBtn, 'click', (e) => {
          const now = performance.now();
          if (now - lastTouchAt < 800) {
            safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); });
            return;
          }
          onGearActivate(e);
        }, { passive: false });

        const syncGear = () => {
          if (!gearBtn) return;
          gearBtn.classList.toggle('open', !!sm.get(P.APP_UI));
          gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT));
          wake();
        };
        sub(P.APP_ACT, syncGear);
        sub(P.APP_UI, syncGear);
        syncGear();
      };

      const mount = () => {
        const root = getUiRoot();
        if (!root) return;
        try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {}
        try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {}
      };

      const ensure = () => {
        if (!allowUiInThisDoc()) {
          detachNodesHard();
          return;
        }
        ensureGear();
        if (sm.get(P.APP_UI)) {
          build();
          const mainPanel = getMainPanel();
          if (mainPanel && !mainPanel.classList.contains('visible')) {
            mainPanel.classList.add('visible');
            queueMicrotask(clampPanelIntoViewport);
          }
        } else {
          const mainPanel = getMainPanel();
          if (mainPanel) mainPanel.classList.remove('visible');
        }
        mount();
        safe(() => wakeGear?.());
      };

      onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });

      window.__VSC_UI_Ensure = ensure;
      if (CONFIG.DEBUG) window.__VSC_UI_Ensure_DEBUG = ensure;

      return { ensure, destroy: () => { safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
    }

    function getRateState(v) {
      const st = getVState(v);
      if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0 };
      return st.rateState;
    }

    function markInternalRateChange(v, ms = 300) {
      const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
    }

    const restoreRateOne = (el) => {
      try {
        const st = getRateState(el);
        if (!st || st.orig == null) return;
        const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
        st.orig = null;
        markInternalRateChange(el, 220);
        el.playbackRate = nextRate;
      } catch (_) {}
    };

    function createBackendAdapter(Filters, FiltersGL) {
      let activeContextCount = 0;
      return {
        apply(video, mode, vVals) {
          const st = getVState(video);
          const now = performance.now();
          const webglAllowed = (mode === 'webgl' && !st.webglTainted && !(st.webglDisabledUntil && now < st.webglDisabledUntil));
          const contextLimitReached = webglAllowed && activeContextCount >= SYS.MAX_CTX;
          const effectiveMode = (webglAllowed && !contextLimitReached) ? 'webgl' : 'svg';

          if (st.fxBackend === 'webgl' && effectiveMode !== 'webgl') {
            FiltersGL.clear(video);
            activeContextCount = Math.max(0, activeContextCount - 1);
            st.fxBackend = null;
          }

          if (effectiveMode === 'webgl') {
              if (st.fxBackend !== 'webgl') activeContextCount++;
              if (st.fxBackend === 'svg') Filters.clear(video);
              if (!FiltersGL.apply(video, vVals)) {
                activeContextCount = Math.max(0, activeContextCount - 1);
                st.webglDisabledUntil = now + SYS.WFC;
                FiltersGL.clear(video);
                Filters.applyUrl(video, Filters.prepareCached(video, vVals));
                st.fxBackend = 'svg';
                return;
              }
              st.fxBackend = 'webgl';
          } else {
              if (st.fxBackend === 'webgl') {
                FiltersGL.clear(video);
                activeContextCount = Math.max(0, activeContextCount - 1);
              }
              Filters.applyUrl(video, Filters.prepareCached(video, vVals));
              st.fxBackend = 'svg';
          }
        },
        clear(video) {
          const st = getVState(video);
          if (st.fxBackend === 'webgl') activeContextCount = Math.max(0, activeContextCount - 1);
          if (st.fxBackend === 'svg') Filters.clear(video);
          else if (st.fxBackend === 'webgl') FiltersGL.clear(video);
          st.fxBackend = null;
        }
      };
    }

    function ensureMobileInlinePlaybackHints(video) {
      if (!video || !CONFIG.IS_MOBILE) return;
      safe(() => { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); });
    }

    const onEvictRateVideo = (v) => { safe(() => restoreRateOne(v)); };
    const onEvictVideo = (v) => { if (window.__VSC_INTERNAL__.Adapter) window.__VSC_INTERNAL__.Adapter.clear(v); restoreRateOne(v); };

    const cleanupTouched = (TOUCHED) => {
      const vids = [...TOUCHED.videos];
      const rateVids = [...TOUCHED.rateVideos];
      TOUCHED.videos.clear();
      TOUCHED.rateVideos.clear();

      const immediate = vids.filter(v => v.isConnected && getVState(v).visible);
      const deferred = vids.filter(v => !immediate.includes(v));

      for (const v of immediate) onEvictVideo(v);
      for (const v of rateVids) onEvictRateVideo(v);

      if (deferred.length > 0) {
        const cleanup = (deadline) => {
          while (deferred.length > 0) {
            if (deadline?.timeRemaining && deadline.timeRemaining() < 2) {
              if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 200 });
              else setTimeout(cleanup, 16);
              return;
            }
            onEvictVideo(deferred.pop());
          }
        };
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 500 });
        else setTimeout(() => { for (const v of deferred) onEvictVideo(v); }, 0);
      }
    };

    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v);
      if (st.bound) return;
      st.bound = true;
      st._ac = new AbortController();
      ensureMobileInlinePlaybackHints(v);

      const softResetTransientFlags = () => {
        st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.webglFailCount = 0; st.webglDisabledUntil = 0;
        if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; st.webglTainted = false; }
        if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; }
        ApplyReq.hard();
      };

      const combinedSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function')
        ? AbortSignal.any([st._ac.signal, __globalSig])
        : (() => {
            const ac = new AbortController();
            const abort = () => ac.abort();
            st._ac.signal.addEventListener('abort', abort);
            __globalSig.addEventListener('abort', abort);
            return ac.signal;
          })();

      const opts = { passive: true, signal: combinedSignal };

      const videoEvents = [
        ['loadstart', softResetTransientFlags],
        ['loadedmetadata', softResetTransientFlags],
        ['emptied', softResetTransientFlags],
        ['seeking', () => ApplyReq.hard()],
        ['play', () => ApplyReq.hard()],
        ['ratechange', () => {
          const rSt = getRateState(v);
          const now = performance.now();
          if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return;
          const refs = window.__VSC_INTERNAL__, app = refs?.App, store = refs?.Store;
          if (!store) return;
          const desired = st.desiredRate;
          if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return;
          const activeVideo = app?.getActiveVideo?.();
          if (!activeVideo || v !== activeVideo) return;
          const cur = v.playbackRate;
          if (Number.isFinite(cur) && cur > 0) {
            store.batch('playback', { rate: cur, enabled: true });
          }
        }]
      ];

      for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
    };

    let __lastApplyTarget = null, __lastApplyRMode = '', __lastApplyPbActive = false;
    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el);
      Adapter.clear(el);
      TOUCHED.videos.delete(el);
      st.desiredRate = undefined;
      restoreRateOne(el);
      TOUCHED.rateVideos.delete(el);
      if (st._ac) { st._ac.abort(); st._ac = null; }
      st.bound = false;
      bindVideoOnce(el, ApplyReq);
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el), rSt = getRateState(el);
      if (rSt.orig == null) rSt.orig = el.playbackRate;

      if (!Object.is(st.desiredRate, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        const now = performance.now();
        rSt._setAttempts = (rSt._setAttempts || 0) + 1;

        if (rSt._setAttempts === 1) {
          rSt._firstAttemptT = now;
        } else if (rSt._setAttempts > 5) {
          if (now - (rSt._firstAttemptT || 0) < 2000) return;
          rSt._setAttempts = 1;
          rSt._firstAttemptT = now;
        }

        st.desiredRate = desiredRate;
        markInternalRateChange(el, 160);
        try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }

    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq }) {
      const candidates = new Set();
      const addIfVideo = (v) => { if (v?.tagName === 'VIDEO') candidates.add(v); };
      for (const v of dirtyVideos) addIfVideo(v);
      for (const v of TOUCHED.videos) addIfVideo(v);
      for (const v of TOUCHED.rateVideos) addIfVideo(v);
      for (const v of applySet) addIfVideo(v);

      for (const el of candidates) {
        if (!el.isConnected) {
          TOUCHED.videos.delete(el);
          TOUCHED.rateVideos.delete(el);
          continue;
        }
        const st = getVState(el);
        const visible = (st.visible !== false);
        const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));

        if (!shouldApply) {
          clearVideoRuntimeState(el, Adapter, ApplyReq);
          continue;
        }
        if (videoFxOn) {
          Adapter.apply(el, rMode, vVals);
          touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
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
      const getDetailLevel = (presetKey) => {
        const k = String(presetKey || 'off').toUpperCase().trim();
        if (k === 'XL') return 'xl';
        if (k === 'L') return 'l';
        if (k === 'M') return 'm';
        if (k === 'S') return 's';
        return 'off';
      };

      const SHADOW_PARAMS = new Map([
        [SHADOW_BAND.DEEP,  { toe: 3.5, gamma: -0.04, mid: 0 }],
        [SHADOW_BAND.MID,   { toe: 2.0, gamma: 0, mid: -0.08 }],
        [SHADOW_BAND.OUTER, { toe: 0, gamma: -0.02, mid: -0.15 }]
      ]);

      return {
        get(vfUser, rMode, activeVideo) {
          const detailP = PRESETS.detail[vfUser.presetS || 'off'];
          const gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'];
          const out = {
            sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0,
            gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, satF: 1.0, temp: 0,
            gain: 1.0, mid: 0, toe: 0, shoulder: 0, __qos: 'full', _hdrToneMap: !!Store.get(P.APP_HDR_TONEMAP)
          };
          const sMask = vfUser.shadowBandMask || 0;

          if (sMask > 0) {
            let toeSum = 0;
            for (const [bit, params] of SHADOW_PARAMS) {
              if (sMask & bit) {
                toeSum += params.toe;
                out.gamma += params.gamma;
                out.mid += params.mid;
              }
            }
            out.toe = VSC_CLAMP(toeSum * (1 - 0.1 * Math.max(0, toeSum - 3)), 0, 5.0);
          }

          out.mid = VSC_CLAMP(out.mid, -0.20, 0);

          const brStep = vfUser.brightStepLevel || 0;
          if (brStep > 0) {
            out.bright += brStep * 4.0;
            out.toe = Math.max(0, out.toe - brStep * 0.5);
            out.gamma *= (1.0 + brStep * 0.03);
          }

          const { rs, gs, bs } = tempToRgbGain(out.temp);
          out._rs = rs; out._gs = gs; out._bs = bs;
          out.__detailLevel = getDetailLevel(vfUser.presetS);
          return out;
        }
      };
    }

    function isNeutralVideoParams(p) {
      return (p.sharp === 0 && p.sharp2 === 0 && p.clarity === 0 && p.gamma === 1.0 && p.bright === 0 && p.contrast === 1.0 && p.satF === 1.0 && p.temp === 0 && p.gain === 1.0 && p.mid === 0 && p.toe === 0 && p.shoulder === 0);
    }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure();
      Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
      Store.sub(P.APP_ACT, (on) => {
        if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); });
      });

      let __activeTarget = null, __lastAudioTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
      const videoParamsMemo = createVideoParamsMemo(Store, P);

      function updateQualityScale(v) {
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale;
        const now = performance.now();
        if (now - lastQCheck < 1000) return qualityScale;
        lastQCheck = now;

        try {
          const q = v.getVideoPlaybackQuality();
          const dropped = Number(q.droppedVideoFrames || 0), total = Number(q.totalVideoFrames || 0);
          const dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0)), dTotal = Math.max(0, total - (__lastQSample.total || 0));
          __lastQSample = { dropped, total };
          const denom = (dTotal > 0) ? dTotal : total, numer = (dTotal > 0) ? dDropped : dropped;
          const ratio = denom > 0 ? (numer / denom) : 0;
          const target = ratio > 0.12 ? 0.70 : (ratio > 0.06 ? 0.85 : 1.0);
          const alpha = target < qualityScale ? 0.35 : 0.25;
          qualityScale = qualityScale * (1 - alpha) + target * alpha;
        } catch (_) {}
        return qualityScale;
      }

      Scheduler.registerApply((force) => {
        try {
          const active = !!Store.getCatRef('app').active;
          if (!active) {
            cleanupTouched(TOUCHED);
            Audio.update();
            return;
          }

          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
          const wantAudioNow = !!(Store.get(P.A_EN) && active), rMode = Store.get(P.APP_RENDER_MODE) || 'svg';
          const pbActive = active && !!Store.get(P.PB_EN);

          const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__lastUserPt, wantAudioNow);

          let nextTarget = pick.target;
          if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
          if (nextTarget !== __activeTarget) __activeTarget = nextTarget;

          const targetChanged = __activeTarget !== __lastApplyTarget;
          const configChanged = rMode !== __lastApplyRMode || pbActive !== __lastApplyPbActive;

          if (!force && vidsDirty.size === 0 && !targetChanged && !configChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev;
          __lastApplyTarget = __activeTarget; __lastApplyRMode = rMode; __lastApplyPbActive = pbActive;

          const now = performance.now();
          if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }

          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget) {
            Audio.setTarget(nextAudioTarget);
            __lastAudioTarget = nextAudioTarget;
          }
          Audio.update();

          const vf0 = Store.getCatRef('video');
          let vValsEffective = videoParamsMemo.get(vf0, rMode, __activeTarget);
          const autoScene = window.__VSC_INTERNAL__?.AutoScene;

          const qs = updateQualityScale(__activeTarget);
          if (qs < 0.95) vValsEffective.__qos = 'fast';
          else vValsEffective.__qos = 'full';

          if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
            const mods = autoScene.getMods();
            if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
              vValsEffective = { ...vValsEffective };
              const uBr = vValsEffective.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
              vValsEffective.gain = uBr * (1.0 + (mods.br - 1.0) * aSF);
              vValsEffective.contrast = (vValsEffective.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF);
              vValsEffective.satF = (vValsEffective.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);

              const userSharpTotal = (vValsEffective.sharp || 0) + (vValsEffective.sharp2 || 0) + (vValsEffective.clarity || 0);
              const sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5);
              const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF) * (qs < 0.95 ? Math.sqrt(qs) : 1.0);

              vValsEffective.sharp = (vValsEffective.sharp || 0) * combinedSharpScale;
              vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * combinedSharpScale;
              vValsEffective.clarity = (vValsEffective.clarity || 0) * combinedSharpScale;
            }
          } else if (qs < 0.95) {
            vValsEffective = { ...vValsEffective };
            const qSharp = Math.sqrt(qs);
            vValsEffective.sharp = (vValsEffective.sharp || 0) * qSharp;
            vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * qSharp;
            vValsEffective.clarity = (vValsEffective.clarity || 0) * qSharp;
          }

          const videoFxOn = !isNeutralVideoParams(vValsEffective);
          const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), applySet = new Set();
          if (applyToAllVisibleVideos) {
            for (const v of visible.videos) applySet.add(v);
          } else if (__activeTarget) {
            applySet.add(__activeTarget);
          }

          const desiredRate = Store.get(P.PB_RATE);

          reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, rMode, ApplyReq });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) {
          log.warn('apply crashed:', e);
        }
      });

      let tickTimer = 0;
      const startTick = () => {
        if (tickTimer) return;
        tickTimer = setInterval(() => {
          if (!Store.get(P.APP_ACT) || document.hidden) return;
          Scheduler.request(false);
        }, 12000);
      };
      const stopTick = () => {
        if (!tickTimer) return;
        clearInterval(tickTimer);
        tickTimer = 0;
      };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick();
      Scheduler.request(true);

      return Object.freeze({
        getActiveVideo() { return __activeTarget || null; },
        getQualityScale() { return qualityScale; },
        destroy() {
          stopTick();
          safe(() => UI.destroy?.());
          safe(() => { Audio.setTarget(null); Audio.destroy?.(); });
          safe(() => __globalHooksAC.abort());
        }
      });
    }

    const Utils = createUtils();
    const Scheduler = createScheduler(32);
    const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
    const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });

    window.__VSC_INTERNAL__.Store = Store;
    window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    window.addEventListener('message', (e) => {
      if (!e.data || !e.data.__vsc_sync || e.data.token !== VSC_SYNC_TOKEN) return;
      try {
        const isTop = (window.self === window.top);
        if (!isTop && e.origin !== location.origin && e.origin !== 'null') return;
      } catch (_) {}
      if (e.data.batch) {
        for (const item of e.data.batch) {
          if (Object.values(P).includes(item.p) && Store.get(item.p) !== item.val) Store.set(item.p, item.val);
        }
      } else if (e.data.p) {
        if (e.data.p === P.APP_UI) return;
        if (Object.values(P).includes(e.data.p) && Store.get(e.data.p) !== e.data.val) Store.set(e.data.p, e.data.val);
      }
    });

    function bindNormalizer(keys, schema) {
      const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); };
      keys.forEach(k => Store.sub(k, run)); run();
    }
    bindNormalizer([P.APP_RENDER_MODE, P.APP_APPLY_ALL, P.APP_ZOOM_EN, P.APP_AUTO_SCENE, P.APP_ADV, P.APP_HDR_TONEMAP], APP_SCHEMA);
    bindNormalizer([P.V_PRE_S, P.V_PRE_B, P.V_SHADOW_MASK, P.V_BRIGHT_STEP], VIDEO_SCHEMA);
    bindNormalizer([P.A_EN, P.A_BST, P.A_MULTIBAND, P.A_LUFS, P.A_DIALOGUE, P.PB_EN, P.PB_RATE], AUDIO_PLAYBACK_SCHEMA);

    const Registry = createRegistry(Scheduler);
    const Targeting = createTargeting();
    initSpaUrlDetector(createDebounced(() => {
      safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); });
    }, SYS.SRD));

    onPageReady(() => {
      installShadowRootEmitterIfNeeded();
      (function ensureRegistryAfterBodyReady() {
        let ran = false;
        const runOnce = () => {
          if (ran) return;
          ran = true;
          safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); });
        };
        if (document.body) { runOnce(); return; }
        const mo = new MutationObserver(() => {
          if (document.body) { mo.disconnect(); runOnce(); }
        });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
        on(document, 'DOMContentLoaded', runOnce, { once: true });
      })();

      const AutoScene = createAutoSceneManager(Store, P, Scheduler);
      window.__VSC_INTERNAL__.AutoScene = AutoScene;

      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FULL: 3840 * 2160, SVG_MAX_PIX_FAST: 3840 * 2160 });
      const FiltersGL = createFiltersWebGL(Utils);
      const Adapter = createBackendAdapter(Filters, FiltersGL);
      window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store);
      window.__VSC_INTERNAL__.AudioWarmup = Audio.warmup;
      let ZoomManager = createZoomManager();
      window.__VSC_INTERNAL__.ZoomManager = ZoomManager;
      const UI = createUI(Store, Registry, ApplyReq, Utils);

      if (typeof GM_registerMenuCommand === 'function') {
        try {
          GM_registerMenuCommand('전체 비디오 적용 토글 (ON/OFF)', () => { Store.set(P.APP_APPLY_ALL, !Store.get(P.APP_APPLY_ALL)); ApplyReq.hard(); });
          GM_registerMenuCommand('Ambient Glow 숨김 토글 (선택/방어)', () => { setHideAmbientGlow(!document.getElementById('vsc-hide-ambient-style')); });
        } catch (_) {}
      }

      let __vscLastUserSignalT = 0;
      window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
      function signalUserInteractionForRetarget() {
        const now = performance.now();
        if (now - __vscLastUserSignalT < 24) return;
        __vscLastUserSignalT = now;
        __vscUserSignalRev = (__vscUserSignalRev + 1) | 0;
        safe(() => Scheduler.request(false));
      }

      for (const [evt, getPt] of [
        ['pointerdown', e => [e.clientX, e.clientY]],
        ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]],
        ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]],
        ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]
      ]) {
        on(window, evt, (e) => {
          if (evt === 'resize') {
            const now = performance.now();
            if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now);
          } else {
            updateLastUserPt(...getPt(e), performance.now());
          }
          signalUserInteractionForRetarget();
        }, evt === 'keydown' ? undefined : OPT_P);
      }

      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__;
      window.__VSC_INTERNAL__.App = __VSC_APP__;
      AutoScene.start();

      on(window, 'keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (e.altKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault(); e.stopPropagation();
          safe(() => { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); });
          return;
        }
        if (e.altKey && e.shiftKey && e.code === 'KeyP') {
          const v = __VSC_APP__?.getActiveVideo();
          if (v) await togglePiPFor(v);
        }
      }, { capture: true });

      on(document, 'visibilitychange', () => {
        safe(() => checkAndCleanupClosedPiP());
        safe(() => { if (document.visibilityState === 'visible') window.__VSC_INTERNAL__?.ApplyReq?.hard(); });
      }, OPT_P);
    });
  }

  VSC_MAIN();
})();
