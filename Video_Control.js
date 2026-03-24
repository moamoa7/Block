// ==UserScript==
// @name         Video_Control (v219.1.0 - Reviewed & Optimized)
// @namespace    https://github.com/
// @version      219.1.0
// @description  v219.1.0: Full review — SVG/audio param fix, filter chain reorder, bug fixes, perf improvements
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

  if (location.href.includes('/cdn-cgi/') || location.protocol === 'about:' || location.href === 'about:blank') return;

  /* ══ Boot lock ══ */
  if (window.__vsc_booted) return;
  window.__vsc_booted = true;

  const __internal = window.__vsc_internal || (window.__vsc_internal = {});

  /* ══ Mobile & Browser detection ══ */
  const IS_MOBILE = navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);
  const IS_FIREFOX = navigator.userAgent.includes('Firefox');

  const VSC_ID = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  const VSC_VERSION = '219.1.0';

  const log = {
    info: (...a) => console.info('[VSC]', ...a),
    warn: (...a) => console.warn('[VSC]', ...a),
    error: (...a) => console.error('[VSC]', ...a)
  };

  /* ══ Storage key ══ */
  function normalizeHostname(h) {
    const parts = h.split('.');
    if (parts.length > 2 && /^\d{1,3}$/.test(parts[0])) return parts.slice(1).join('.');
    return h;
  }
  const STORAGE_KEY = 'vsc_v2_' + normalizeHostname(location.hostname) + (location.pathname.startsWith('/shorts') ? '_shorts' : '');

  const CLAMP = (v, min, max) => v < min ? min : v > max ? max : v;
  const SHARP_CAP = 0.60;

  /* ══ attachShadow Patch ══ */
  const _origAttach = Element.prototype.attachShadow;
  if (typeof _origAttach === 'function' && !_origAttach.__vsc) {
    const patched = function (init) {
      const sr = _origAttach.call(this, init);
      if (__internal._onShadow) {
        queueMicrotask(() => __internal._onShadow(this, sr));
      }
      return sr;
    };
    patched.__vsc = true;
    patched.__vsc_original = _origAttach;
    Element.prototype.attachShadow = patched;
  }

  /* ══ Style helpers ══ */
  // [FIX 3-2] contain: style (not content), no background-color forcing
  function applyFilterStyles(el, filterStr) {
    if (!el?.style) return;
    el.style.setProperty('transition', 'none', 'important');
    el.style.setProperty('contain', 'style', 'important');
    el.style.setProperty('will-change', 'filter', 'important');
    el.style.setProperty('filter', filterStr, 'important');
    el.style.setProperty('-webkit-filter', filterStr, 'important');
    el.style.setProperty('backface-visibility', 'hidden', 'important');
  }

  function clearFilterStyles(el) {
    if (!el?.style) return;
    for (const p of ['filter', '-webkit-filter', 'will-change', 'contain', 'backface-visibility', 'transition']) {
      el.style.removeProperty(p);
    }
  }

  /* ══ Presets & LUTs ══ */
  const PRESETS = Object.freeze({
    detail: {
      none: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'OFF' },
      off:  { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'AUTO' },
      S:    { sharpAdd: 16, sharp2Add: 4, clarityAdd: 5, label: '1단' },
      M:    { sharpAdd: 22, sharp2Add: 12, clarityAdd: 12, label: '2단' },
      L:    { sharpAdd: 26, sharp2Add: 24, clarityAdd: 20, label: '3단' },
      XL:   { sharpAdd: 32, sharp2Add: 22, clarityAdd: 26, label: '4단' }
    }
  });

  const _PRESET_SHARP_LUT = {};
  for (const [key, d] of Object.entries(PRESETS.detail)) {
    _PRESET_SHARP_LUT[key] = (d.sharpAdd + d.sharp2Add * 0.6 + d.clarityAdd * 0.4) * 0.01;
  }

  // [FIX 1-4] Green channel minimal adjustment
  function tempToRgbGain(temp) {
    const t = CLAMP((Number(temp) || 0) * 0.02, -1, 1);
    if (t > -0.001 && t < 0.001) return { rs: 1, gs: 1, bs: 1 };
    const r = 1 + 0.14 * t;
    const g = 1 - 0.005 * Math.abs(t);
    const b = 1 - 0.14 * t;
    const maxCh = Math.max(r, g, b);
    return { rs: r / maxCh, gs: g / maxCh, bs: b / maxCh };
  }

  /* ══ Defaults & Paths ══ */
  const DEFAULTS = {
    video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0 },
    audio: { enabled: false, boost: 6 },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false, screenBright: 0 }
  };
  const P = {
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_SCREEN_BRT: 'app.screenBright',
    V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
    V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery',
    V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp',
    A_EN: 'audio.enabled', A_BST: 'audio.boost',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  };

  /* ══ Local Store ══ */
  function createLocalStore(defaults, scheduler) {
    let rev = 0;
    const listeners = new Map();
    const state = JSON.parse(JSON.stringify(defaults));

    const emit = (key, val) => {
      const a = listeners.get(key);
      if (a) for (const fn of a) try { fn(val); } catch (_) {}
    };

    return {
      state, rev: () => rev,
      get: (p) => {
        const parts = p.split('.');
        return parts.length > 1 ? state[parts[0]]?.[parts[1]] : state[parts[0]];
      },
      set: (p, val) => {
        const [c, k] = p.split('.');
        if (k != null) {
          if (Object.is(state[c]?.[k], val)) return;
          state[c][k] = val; rev++; emit(p, val); scheduler.request();
        }
      },
      batch: (cat, obj) => {
        let changed = false;
        for (const [k, v] of Object.entries(obj)) {
          if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); }
        }
        if (changed) { rev++; scheduler.request(); }
      },
      sub: (k, f) => {
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(f);
      },
      load: (data) => {
        if (!data) return;
        for (const c of ['video', 'audio', 'playback', 'app']) {
          if (data[c]) Object.assign(state[c], data[c]);
        }
        rev++;
      }
    };
  }

  /* ══ Utils ══ */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'defs', 'filter', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'feConvolveMatrix', 'feColorMatrix', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feComposite', 'feBlend', 'g', 'path', 'circle', 'rect', 'line', 'text', 'polyline', 'polygon']);

  function h(tag, props = {}, ...children) {
    const isSvg = props.ns === 'svg' || SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'ns') continue;
      if (k.startsWith('on')) {
        el.addEventListener(k.slice(2).toLowerCase(), (e) => {
          if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation();
          v(e);
        });
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v);
      } else if (k === 'class') {
        if (isSvg) el.setAttribute('class', v); else el.className = v;
      } else if (v !== false && v != null) el.setAttribute(k, v);
    }
    children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function _s(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) { if (v != null && v !== false) el.setAttribute(k, String(v)); }
    children.flat().forEach(c => { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  /* ══ Event Bus ══ */
  function createEventBus() {
    const subs = new Map();
    return {
      on: (name, fn) => { if (!subs.has(name)) subs.set(name, []); subs.get(name).push(fn); },
      emit: (name, data) => { const a = subs.get(name); if (a) a.forEach(fn => { try { fn(data); } catch (_) {} }); },
      signal: () => { const a = subs.get('signal'); if (a) a.forEach(fn => { try { fn(); } catch (_) {} }); }
    };
  }

  /* ══ Scheduler ══ */
  function createScheduler(minIntervalMs = 16) {
    let queued = false, applyFn = null, lastRun = 0;
    return {
      registerApply: fn => { applyFn = fn; },
      request: (immediate = false) => {
        if (queued && !immediate) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          const now = performance.now();
          if (!immediate && now - lastRun < minIntervalMs) return;
          lastRun = now;
          if (applyFn) try { applyFn(); } catch (_) {}
        });
      }
    };
  }

  /* ══ Registry ══ */
  function createRegistry(scheduler, bus) {
    const videos = new Set();
    const shadowRootsLRU = [];
    const observedShadowHosts = new WeakSet();
    const SHADOW_MAX = 16;
    const observers = new Set();
    // [FIX 3-3] Store listeners for cleanup
    const videoListeners = new WeakMap();

    let refreshRafId = 0;
    function requestRefresh() {
      if (refreshRafId) return;
      refreshRafId = requestAnimationFrame(() => { refreshRafId = 0; scheduler.request(); bus.signal(); });
    }

    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting || e.intersectionRatio > 0) { requestRefresh(); return; } }
    }, { root: null, threshold: [0, 0.05, 0.5], rootMargin: '150px' }) : null;

    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
      for (const e of entries) { if (e.target.tagName === 'VIDEO') { requestRefresh(); return; } }
    }) : null;

    const isVscNode = (n) => {
      if (!n || n.nodeType !== 1) return false;
      return !!(n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host' || n.id === 'vsc-osd');
    };

    function observeVideo(el) {
      if (!el || el.tagName !== 'VIDEO' || videos.has(el)) return;
      videos.add(el);
      if (io) io.observe(el);
      if (ro) ro.observe(el);

      const req = () => { scheduler.request(); bus.signal(); };
      let lastT = 0;
      const onTimeUpdate = () => {
        const now = performance.now();
        if (now - lastT > 1000) { lastT = now; req(); }
      };

      const listenerDefs = [
        ['loadedmetadata', req],
        ['resize', req],
        ['playing', req],
        ['timeupdate', onTimeUpdate]
      ];
      for (const [evt, fn] of listenerDefs) {
        el.addEventListener(evt, fn, { passive: true });
      }
      videoListeners.set(el, listenerDefs);
      req();
    }

    function scanNode(n) {
      if (!n) return;
      if (n.nodeType === 1) {
        if (n.tagName === 'VIDEO') { observeVideo(n); return; }
        if (n.shadowRoot && !observedShadowHosts.has(n)) {
          observedShadowHosts.add(n);
          if (shadowRootsLRU.length >= SHADOW_MAX) {
            const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
            if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift();
          }
          shadowRootsLRU.push({ host: n, root: n.shadowRoot });
          connectObserver(n.shadowRoot);
          scanNode(n.shadowRoot);
        }
        if (!n.childElementCount) return;
        try {
          const vs = n.getElementsByTagName('video');
          for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
        } catch (_) {}
      } else if (n.nodeType === 11) {
        try {
          const vs = n.querySelectorAll('video');
          for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
        } catch (_) {}
      }
    }

    const workQ = [];
    let workScheduled = false;

    function scheduleWork() {
      if (workScheduled) return;
      workScheduled = true;
      const doWork = () => {
        workScheduled = false;
        const batch = workQ.splice(0, 20);
        for (const n of batch) scanNode(n);
        if (workQ.length > 0) scheduleWork();
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(doWork, { timeout: 120 });
      else setTimeout(doWork, 0);
    }

    function enqueue(n) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
      // [FIX 3-10] More efficient overflow handling
      if (workQ.length > 500) {
        const keep = workQ.slice(workQ.length >> 1);
        workQ.length = 0;
        workQ.push(...keep);
      }
      workQ.push(n);
      scheduleWork();
    }

    function connectObserver(root) {
      if (!root) return;
      const mo = new MutationObserver((muts) => {
        let touchedVideo = false;
        for (const m of muts) {
          if (m.addedNodes?.length) {
            for (const n of m.addedNodes) {
              if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
              if (n.nodeType === 1 && isVscNode(n)) continue;
              enqueue(n);
              if (!touchedVideo && n.nodeType === 1) {
                if (n.tagName === 'VIDEO') touchedVideo = true;
                else if (n.childElementCount) {
                  try { const l = n.getElementsByTagName('video'); if (l?.length) touchedVideo = true; } catch (_) {}
                }
              }
            }
          }
          if (!touchedVideo && m.removedNodes?.length) {
            for (const n of m.removedNodes) {
              if (n?.nodeType === 1 && (n.tagName === 'VIDEO' || n.querySelector?.('video'))) { touchedVideo = true; break; }
            }
          }
        }
        if (touchedVideo) requestRefresh();
      });
      mo.observe(root, { childList: true, subtree: true });
      observers.add(mo);
      enqueue(root);
    }

    __internal._onShadow = (host, sr) => {
      if (!sr || !host || observedShadowHosts.has(host)) return;
      observedShadowHosts.add(host);
      if (shadowRootsLRU.length >= SHADOW_MAX) {
        const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
        if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift();
      }
      shadowRootsLRU.push({ host, root: sr });
      connectObserver(sr);
    };

    const root = document.body || document.documentElement;
    if (root) { enqueue(root); connectObserver(root); }

    // [FIX 3-3] Cleanup with listener removal
    setInterval(() => {
      let removed = 0;
      for (const el of videos) {
        if (!el?.isConnected) {
          videos.delete(el);
          clearFilterStyles(el);
          if (io) try { io.unobserve(el); } catch (_) {}
          if (ro) try { ro.unobserve(el); } catch (_) {}
          const ls = videoListeners.get(el);
          if (ls) {
            for (const [evt, fn] of ls) el.removeEventListener(evt, fn);
            videoListeners.delete(el);
          }
          removed++;
        }
      }
      if (removed) requestRefresh();
    }, 5000);

    return {
      videos,
      shadowRootsLRU,
      rescanAll: () => scanNode(document.body || document.documentElement)
    };
  }

  /* ══ Targeting ══ */
  // [FIX 3-6] Fullscreen video priority
  function createTargeting() {
    return {
      pick: (videos) => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) {
          if (fsEl.tagName === 'VIDEO' && videos.has(fsEl)) return fsEl;
          for (const v of videos) {
            if (v.isConnected && fsEl.contains(v)) return v;
          }
        }

        let best = null, bestScore = -Infinity;
        for (const v of videos) {
          if (!v.isConnected) continue;
          const r = v.getBoundingClientRect();
          const area = r.width * r.height;
          if (area === 0 && v.readyState === 0 && v.paused) continue;
          let s = Math.log2(1 + Math.max(0, area));
          if (!v.paused && !v.ended) s += 25;
          if (v.currentTime > 0) s += 5;
          if (!v.muted && v.volume > 0.01) s += 5;
          if (s > bestScore) { bestScore = s; best = v; }
        }
        return best;
      }
    };
  }

  function createAudio(store) {
  if (IS_FIREFOX) return { setTarget() {}, update() {}, hasCtx: () => false, isHooked: () => false, isBypassed: () => true };

  let ctx = null, comp = null, limiter = null, boostGain = null, masterOut = null, dryPath = null;
  let currentSrc = null, targetVideo = null;
  let currentMode = 'none';
  const srcMap = new WeakMap();

  let bypassMode = false;

  const corsFailedVideos = new WeakSet();
  const mesFailedVideos = new WeakSet();
  const audioFailUntil = new WeakMap();

  let analyser = null, analyserData = null;
  let corsSilenceMs = 0;
  let audioLoopTimer = 0;
  let loopToken = 0;
  const SILENCE_THRESHOLD_MS = 3000;

  /* ── JWPlayer 감지 ── */
  function detectJWPlayer(video) {
    if (!video) return false;
    if (typeof window.jwplayer === 'function') {
      try { if (window.jwplayer()?.getContainer?.()) return true; } catch (_) {}
    }
    let el = video.parentElement, depth = 0;
    while (el && depth < 10) {
      if (el.classList?.contains('jwplayer') ||
          el.id?.startsWith('jwplayer') ||
          el.classList?.contains('jw-wrapper') ||
          el.querySelector?.(':scope > .jw-media, :scope > .jw-controls')) {
        return true;
      }
      el = el.parentElement;
      depth++;
    }
    if (video.src?.startsWith('blob:')) {
      if (document.querySelector('script[src*="jwplayer"]') ||
          document.querySelector('[class*="jw-"]')) {
        return true;
      }
    }
    return false;
  }

  /* ── AudioContext 초기화 ── */
  function initCtx() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { return false; }

    boostGain = ctx.createGain();
    boostGain.gain.value = 1;

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    masterOut = ctx.createGain();
    masterOut.gain.value = 1;

    boostGain.connect(comp);
    comp.connect(limiter);
    limiter.connect(masterOut);
    masterOut.connect(ctx.destination);

    dryPath = ctx.createGain();
    dryPath.gain.value = 1;
    dryPath.connect(ctx.destination);

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyserData = new Float32Array(analyser.fftSize);
    masterOut.connect(analyser);

    return true;
  }

  /* ══ 바이패스 모드 ══ */
  function enterBypass(video, reason) {
  if (bypassMode) return;
  bypassMode = true;
  currentMode = 'bypass';
  log.info(`[Audio] Entering bypass — ${reason || 'restoring original audio'}`);

  // 확실한 오디오 복원을 위한 강제 음소거 해제 안전장치
  if (video && video.muted && (!currentSrc || reason?.includes('JWPlayer'))) {
    try { video.muted = false; } catch (_) {}
  }

  if (video && ctx && currentSrc) {
      try { currentSrc.disconnect(); } catch (_) {}

      if (currentSrc.__vsc_isCaptureStream) {
        // captureStream: 원본 오디오 복원
        if (video.muted && currentSrc.__vsc_originalMuted === false) {
          try { video.muted = false; } catch (_) {}
        }
        if (currentSrc.__vsc_originalVolume != null) {
          try { video.volume = currentSrc.__vsc_originalVolume; } catch (_) {}
        }
        const stream = currentSrc.__vsc_captureStream;
        if (stream) {
          stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        }
      } else {
        // MES: destination에 직접 연결해서 소리 복원
        try { currentSrc.connect(ctx.destination); } catch (_) {}
      }
    }
    currentSrc = null;
  }

  function exitBypass() {
    if (!bypassMode) return;
    bypassMode = false;
    log.info('[Audio] Exiting bypass mode');
  }

  /* ── RMS 측정 ── */
  function getRmsDb() {
    if (!analyser || !analyserData) return -100;
    analyser.getFloatTimeDomainData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) sum += analyserData[i] * analyserData[i];
    const rms = Math.sqrt(sum / analyserData.length);
    return rms > 1e-6 ? 20 * Math.log10(rms) : -100;
  }

  /* ══ 오디오 모니터링 루프 ══ */
  function scheduleAudioLoop(tok) {
    const delay = document.hidden ? 500 : 80;
    if (audioLoopTimer) clearTimeout(audioLoopTimer);
    audioLoopTimer = setTimeout(() => {
      audioLoopTimer = 0;
      if (tok !== loopToken) return;
      runAudioLoop(tok);
    }, delay);
  }

  function runAudioLoop(tok) {
    if (tok !== loopToken || !ctx) return;
    if (ctx.state === 'suspended') { scheduleAudioLoop(tok); return; }
    if (bypassMode) { scheduleAudioLoop(tok); return; }

    const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
    const actuallyEnabled = enabled && !!currentSrc;
    const delay = document.hidden ? 500 : 80;

    // ── 무음 감지 (모든 모드) ──
    if (actuallyEnabled && targetVideo &&
        !targetVideo.paused && targetVideo.readyState >= 3) {

      // captureStream 모드: video가 muted 상태이므로 volume/muted 체크 불필요
      // MES 모드: video.volume > 0 && !video.muted 체크
      const shouldCheck = currentMode === 'stream' ||
        (currentMode === 'mes' && targetVideo.volume > 0 && !targetVideo.muted);

      if (shouldCheck) {
        const rmsDb = getRmsDb();
        if (rmsDb <= -96) {
          corsSilenceMs += delay;
          if (corsSilenceMs > SILENCE_THRESHOLD_MS) {
            log.warn(`[Audio] ${SILENCE_THRESHOLD_MS}ms continuous silence detected (mode: ${currentMode}). Auto-bypassing.`);
            if (currentMode === 'stream') corsFailedVideos.add(targetVideo);
            if (currentMode === 'mes') mesFailedVideos.add(targetVideo);
            audioFailUntil.set(targetVideo, performance.now() + 60000); // 1분 쿨다운
            enterBypass(targetVideo, `silence detected in ${currentMode} mode`);
            corsSilenceMs = 0;
            scheduleAudioLoop(tok);
            return;
          }
        } else {
          corsSilenceMs = 0;
        }
      }
    } else {
      corsSilenceMs = 0;
    }

    // ── 부스트 게인 업데이트 ──
    if (actuallyEnabled && boostGain) {
      const boostDb = CLAMP(Number(store.get(P.A_BST) || 0), 0, 15);
      const finalGain = Math.pow(10, boostDb / 20);
      try { boostGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); }
      catch (_) { boostGain.gain.value = finalGain; }
    }

    scheduleAudioLoop(tok);
  }

  /* ── captureStream 연결 ── */
  function connectViaCaptureStream(video) {
    if (!ctx) return null;

    if (corsFailedVideos.has(video)) {
      return null;
    }

    const captureFn = video.captureStream || video.mozCaptureStream;
    if (typeof captureFn !== 'function') {
      return null;
    }

    let stream;
    try {
      stream = captureFn.call(video);
    } catch (e) {
      if (e.name === 'SecurityError' || e.message?.includes('cross-origin')) {
        log.warn('[Audio] captureStream blocked by CORS');
        corsFailedVideos.add(video);
        return null;
      }
      log.error('[Audio] captureStream() failed:', e);
      return null;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      log.info('[Audio] No audio tracks in stream yet, polling...');
      let pollCount = 0;
      const pollId = setInterval(() => {
        if (stream.getAudioTracks().length > 0 || ++pollCount > 30) {
          clearInterval(pollId);
          if (stream.getAudioTracks().length > 0 && video === targetVideo && bypassMode) {
            log.info('[Audio] Audio track appeared, reconnecting...');
            exitBypass();
            if (connectSource(video)) updateMix();
          }
        }
      }, 300);
      return null;
    }

    try {
      const source = ctx.createMediaStreamSource(stream);
      source.__vsc_isCaptureStream = true;
      source.__vsc_captureStream = stream;
      source.__vsc_originalMuted = video.muted;
      source.__vsc_originalVolume = video.volume;

      video.muted = true;

      return source;
    } catch (e) {
      log.error('[Audio] createMediaStreamSource failed:', e);
      return null;
    }
  }

  /* ── MES 연결 ── */
  function connectViaMES(video) {
    if (!ctx) return null;

    // MES도 이전에 무음이 확인된 비디오는 건너뜀
    if (mesFailedVideos.has(video)) {
      return null;
    }

    let s = srcMap.get(video);
    if (s) {
      if (s.context === ctx) return s;
      if (s.context.state === 'closed') { srcMap.delete(video); s = null; }
      else {
        return null;
      }
    }
    if (!s) {
      try {
        s = ctx.createMediaElementSource(video);
        srcMap.set(video, s);
      } catch (e) {
        if (e.name === 'InvalidStateError') {
          return null;
        }
        log.error('[Audio] MES creation failed:', e);
        return null;
      }
    }
    return s;
  }

  /* ══ 통합 소스 연결 ══
     핵심 변경: JWPlayer + CORS 실패 시 MES도 시도하지 않고 즉시 바이패스
  */
  function connectSource(video) {
    if (!video || !ctx) return false;

    const failUntil = audioFailUntil.get(video) || 0;
    if (failUntil > performance.now()) {
      enterBypass(video, 'cooldown period');
      return false;
    }

    const isJW = detectJWPlayer(video);
    let source = null;

    if (isJW) {
      log.info('[Audio] JWPlayer detected');

      // JWPlayer: captureStream만 시도
      // CORS로 captureStream 불가능하면 MES도 쓰면 안 됨
      // (MES가 오디오를 가로채면 JWPlayer 내부 경로가 끊김)
      if (corsFailedVideos.has(video)) {
        log.info('[Audio] JWPlayer + CORS failed → immediate bypass (MES unsafe)');
        enterBypass(video, 'JWPlayer + CORS: MES would break audio');
        return false;
      }

      source = connectViaCaptureStream(video);

      if (!source) {
        // captureStream 실패 (트랙 미도착 등) — MES 시도하지 않음
        log.info('[Audio] JWPlayer captureStream unavailable → bypass');
        enterBypass(video, 'JWPlayer: captureStream failed, MES skipped');
        return false;
      }
    } else {
      // 일반 비디오: MES 먼저, 실패 시 captureStream
      source = connectViaMES(video);
      if (!source) {
        source = connectViaCaptureStream(video);
      }
    }

    if (!source) {
      enterBypass(video, 'all connection methods failed');
      return false;
    }

    srcMap.set(video, source);
    try { source.disconnect(); } catch (_) {}
    const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
    source.connect(enabled ? boostGain : dryPath);

    currentSrc = source;
    currentMode = source.__vsc_isCaptureStream ? 'stream' : 'mes';
    exitBypass();
    log.info(`[Audio] Connected via ${currentMode}`);
    return true;
  }

  /* ── 팝 노이즈 방지 전환 ── */
  function fadeOutThen(fn) {
    if (!ctx || !masterOut || ctx.state === 'closed') {
      try { fn(); } catch (_) {}
      return;
    }

    try {
      const t = ctx.currentTime;
      masterOut.gain.cancelScheduledValues(t);
      masterOut.gain.setValueAtTime(masterOut.gain.value, t);
      masterOut.gain.linearRampToValueAtTime(0, t + 0.04);
    } catch (_) { try { masterOut.gain.value = 0; } catch (__) {} }

    setTimeout(() => {
      try { fn(); } catch (_) {}
      if (ctx && masterOut && ctx.state !== 'closed') {
        try {
          const t2 = ctx.currentTime;
          masterOut.gain.cancelScheduledValues(t2);
          masterOut.gain.setValueAtTime(0, t2);
          masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04);
        } catch (_) { try { masterOut.gain.value = 1; } catch (__) {} }
      }
    }, 60);
  }

  /* ── 연결 해제 ── */
  function disconnectCurrent() {
    if (!currentSrc) return;

    if (currentSrc.__vsc_isCaptureStream && targetVideo) {
      if (targetVideo.muted && currentSrc.__vsc_originalMuted === false) {
        try { targetVideo.muted = false; } catch (_) {}
      }
      if (currentSrc.__vsc_originalVolume != null) {
        try { targetVideo.volume = currentSrc.__vsc_originalVolume; } catch (_) {}
      }
      const stream = currentSrc.__vsc_captureStream;
      if (stream) {
        stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      }
    }

    try { currentSrc.disconnect(); } catch (_) {}

    if (!currentSrc.__vsc_isCaptureStream && ctx && ctx.state !== 'closed') {
      try { currentSrc.connect(ctx.destination); } catch (_) {}
    }

    currentSrc = null;
    currentMode = 'none';
  }

  /* ── 믹스 업데이트 ── */
  function updateMix() {
    if (!ctx || bypassMode) return;

    const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
    const isHooked = !!currentSrc;

    if (enabled && isHooked && currentSrc) {
      try { currentSrc.disconnect(); } catch (_) {}
      currentSrc.connect(boostGain);

      const boostDb = CLAMP(Number(store.get(P.A_BST) || 0), 0, 15);
      const finalGain = Math.pow(10, boostDb / 20);
      try { boostGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); }
      catch (_) { boostGain.gain.value = finalGain; }
    } else if (currentSrc) {
      try { currentSrc.disconnect(); } catch (_) {}
      currentSrc.connect(dryPath);
    }

    loopToken++;
    if (audioLoopTimer) { clearTimeout(audioLoopTimer); audioLoopTimer = 0; }
    corsSilenceMs = 0;
    if (enabled && isHooked) scheduleAudioLoop(loopToken);
  }

  /* ── 타겟 설정 ── */
  function setTarget(video) {
    if (video === targetVideo && (currentSrc || bypassMode)) {
      if (bypassMode && video?.isConnected) {
        const failUntil = video ? (audioFailUntil.get(video) || 0) : 0;
        if (failUntil > performance.now()) {
          return; // 쿨다운 중 — updateMix도 불필요
        }
        // CORS 확정 + JWPlayer면 재시도 불가
        if (corsFailedVideos.has(video) && detectJWPlayer(video)) {
          return;
        }
        exitBypass();
        if (connectSource(video)) { updateMix(); return; }
      }
      updateMix();
      return;
    }

    const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
    if (!enabled) {
      if (currentSrc || targetVideo) {
        fadeOutThen(() => { disconnectCurrent(); });
      }
      targetVideo = video;
      return;
    }

    if (!initCtx()) { targetVideo = video; return; }

    fadeOutThen(() => {
      disconnectCurrent();
      exitBypass();
      targetVideo = video;
      if (!video) { updateMix(); return; }

      if (!connectSource(video)) {
        // CORS+JW 확정이면 재시도 불필요
        if (corsFailedVideos.has(video) && detectJWPlayer(video)) {
          return;
        }
        setTimeout(() => {
          if (!video.isConnected || targetVideo !== video) return;
          if (corsFailedVideos.has(video) && detectJWPlayer(video)) return;
          const failUntil = audioFailUntil.get(video) || 0;
          if (failUntil > performance.now()) return;
          exitBypass();
          if (connectSource(video)) updateMix();
        }, 800);
      }
      updateMix();
    });
  }

  /* ── 바이패스 자동 재시도 ── */
  setInterval(() => {
    if (!bypassMode || !targetVideo?.isConnected || !ctx || ctx.state === 'closed') return;
    if (!store.get(P.A_EN) || !store.get(P.APP_ACT)) return;

    // CORS+JWPlayer 확정이면 영구 바이패스
    if (corsFailedVideos.has(targetVideo) && detectJWPlayer(targetVideo)) return;
    // MES도 실패한 일반 비디오면 영구 바이패스
    if (mesFailedVideos.has(targetVideo) && corsFailedVideos.has(targetVideo)) return;

    const failUntil = audioFailUntil.get(targetVideo) || 0;
    if (failUntil > performance.now()) return;

    exitBypass();
    if (connectSource(targetVideo)) {
      updateMix();
      log.info('[Audio] Bypass retry succeeded');
    }
  }, 30000);

  /* ── AudioContext resume ── */
  let gestureHooked = false;
  const onGesture = () => {
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (ctx?.state === 'running' && gestureHooked) {
      for (const evt of ['pointerdown', 'keydown', 'click']) {
        window.removeEventListener(evt, onGesture, true);
      }
      gestureHooked = false;
    }
  };
  function ensureGestureHook() {
    if (gestureHooked) return;
    gestureHooked = true;
    for (const evt of ['pointerdown', 'keydown', 'click']) {
      window.addEventListener(evt, onGesture, { passive: true, capture: true });
    }
  }
  ensureGestureHook();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx?.state === 'suspended') ctx.resume().catch(() => {});
  }, { passive: true });

  return {
    setTarget,
    update: updateMix,
    hasCtx: () => !!ctx,
    isHooked: () => !!(currentSrc || bypassMode),
    isBypassed: () => bypassMode
  };
}

  /* ══ SVG Filter Engine ══ */
  function createFilters() {
    const ctxMap = new WeakMap();
    const toneCache = new Map();
    const TONE_CACHE_MAX = 32;

    // [FIX 1-2] Stable tone table near gain=1
    function getToneTable(steps, gain, contrast, brightOffset, gamma, toe, mid, shoulder) {
      const key = `${steps}|${(gain*100+.5)|0}|${(contrast*100+.5)|0}|${(brightOffset*1000+.5)|0}|${(gamma*100+.5)|0}|t${(toe*1000+.5)|0}|m${(mid*1000+.5)|0}|s${(shoulder*1000+.5)|0}`;
      if (toneCache.has(key)) return toneCache.get(key);

      const ev = Math.log2(Math.max(1e-6, gain));
      const g = ev * 0.90;
      const absG = Math.abs(g);
      const useFilmicCurve = absG > 0.01;
      const denom = useFilmicCurve ? (1 - Math.exp(-g)) : 1;

      const out = new Array(steps);
      let prev = 0;
      const intercept = 0.5 * (1 - contrast) + brightOffset;

      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1);
        let x = useFilmicCurve ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = x * contrast + intercept;
        x = CLAMP(x, 0, 1);
        if (toe > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toe * (1 - t) * (t * t) * (1 - x); }
        if (mid > 0.001) { const mc = 0.45, sig = 0.18; const mw = Math.exp(-((x0 - mc) ** 2) / (2 * sig * sig)); x = CLAMP(x + (x0 - mc) * mid * mw * 1.5, 0, 1); }
        if (shoulder > 0.001) { const hw = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = CLAMP(x + shoulder * 0.6 * x0 + shoulder * hw * hw * 0.5 * (1 - x), 0, 1); }
        if (Math.abs(gamma - 1) > 0.001) x = Math.pow(x, gamma);
        if (x < prev) x = prev;
        prev = x;
        out[i] = (x).toFixed(4);
      }

      const res = out.join(' ');
      if (toneCache.size >= TONE_CACHE_MAX) {
        const firstKey = toneCache.keys().next().value;
        toneCache.delete(firstKey);
      }
      toneCache.set(key, res);
      return res;
    }

    function mkXfer(attrs, funcDefaults, withAlpha = false) {
      const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs });
      const channels = ['R', 'G', 'B'];
      if (withAlpha) channels.push('A');
      for (const ch of channels) {
        const fa = { ns: 'svg' };
        if (ch === 'A') fa.type = 'identity';
        else { for (const [k, v] of Object.entries(funcDefaults)) fa[k] = v; }
        xfer.append(h(`feFunc${ch}`, fa));
      }
      return xfer;
    }

    // [FIX 2-1] Filter chain reorder: tone → temp → sharpen → saturate
    // [FIX 2-2] withAlpha on temp transfer
    function buildSvg(root) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
      const defs = h('defs', { ns: 'svg' });
      svg.append(defs);
      const fid = `vsc-f-${VSC_ID}`;
      const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });

      const fTone = mkXfer({ in: 'SourceGraphic', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
      const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' }, true);
      const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'tmp', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
      const fSat = h('feColorMatrix', { ns: 'svg', in: 'conv', type: 'saturate', values: '1.0', result: 'final' });

      filter.append(fTone, fTemp, fConv, fSat);
      defs.append(filter);

      const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
      if (target?.appendChild) target.appendChild(svg);

      const toneFuncR = fTone.querySelector('feFuncR');
      const toneFuncG = fTone.querySelector('feFuncG');
      const toneFuncB = fTone.querySelector('feFuncB');
      const tempChildren = Array.from(fTemp.children);
      return {
        fid, svg, fConv,
        toneFuncsRGB: [toneFuncR, toneFuncG, toneFuncB].filter(Boolean),
        tempFuncR: tempChildren.find(f => f.tagName.includes('R')),
        tempFuncG: tempChildren.find(f => f.tagName.includes('G')),
        tempFuncB: tempChildren.find(f => f.tagName.includes('B')),
        fSat,
        st: { lastKey: '', toneKey: '', sharpKey: '', tempKey: '' }
      };
    }

    // [FIX 2-5] Firefox: allow SVG for tone/temp, skip feConvolveMatrix
    function needsSvg(s) {
      const hasSharp = !IS_FIREFOX && Math.abs(s.sharp || 0) > 0.005;
      const hasTone = (
        Math.abs(s.toe || 0) > 0.005 ||
        Math.abs(s.mid || 0) > 0.005 ||
        Math.abs(s.shoulder || 0) > 0.005 ||
        Math.abs((s.gain || 1) - 1) > 0.005 ||
        Math.abs((s.gamma || 1) - 1) > 0.005 ||
        Math.abs(s.bright || 0) > 0.5
      );
      const hasTemp = Math.abs(s.temp || 0) > 0.5;
      return hasSharp || hasTone || hasTemp;
    }

    // [FIX 3-4] No nested rAF — direct attribute updates
    // [FIX 1-3] Isotropic 8-neighbor kernel option
    function prepare(video, s) {
      if (!needsSvg(s)) {
        const parts = [];
        if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
        if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
        if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
        return parts.length > 0 ? parts.join(' ') : 'none';
      }

      const root = (video.getRootNode?.() instanceof ShadowRoot) ? video.getRootNode() : (video.ownerDocument || document);
      let ctx = ctxMap.get(root);
      if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
      const st = ctx.st;

      const svgHash = `${(s.sharp||0).toFixed(3)}|${(s.toe||0).toFixed(3)}|${(s.mid||0).toFixed(3)}|${(s.shoulder||0).toFixed(3)}|${(s.gain||1).toFixed(3)}|${(s.gamma||1).toFixed(3)}|${(s.bright||0).toFixed(2)}|${(s.contrast||1).toFixed(3)}|${s.temp||0}`;

      if (st.lastKey !== svgHash) {
        st.lastKey = svgHash;

        const toneTable = getToneTable(
          256, s.gain || 1, s.contrast || 1, (s.bright || 0) * 0.004,
          1 / CLAMP(s.gamma || 1, 0.1, 5), s.toe || 0, s.mid || 0, s.shoulder || 0
        );
        if (st.toneKey !== toneTable) {
          st.toneKey = toneTable;
          for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable);
        }

        const userTemp = tempToRgbGain(s.temp);
        if (st.tempKey !== s.temp) {
          st.tempKey = s.temp;
          ctx.tempFuncR.setAttribute('slope', userTemp.rs);
          ctx.tempFuncG.setAttribute('slope', userTemp.gs);
          ctx.tempFuncB.setAttribute('slope', userTemp.bs);
        }

        if (!IS_FIREFOX) {
          const totalS = CLAMP(Number(s.sharp || 0), 0, SHARP_CAP);
          let kernelStr = '0,0,0, 0,1,0, 0,0,0';
          if (totalS >= 0.005) {
            const edge = -totalS;
            const diag = edge * 0.707;
            const center = 1 - 4 * edge - 4 * diag;
            kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`;
          }

          if (st.sharpKey !== kernelStr) {
            st.sharpKey = kernelStr;
            const desatVal = totalS > 0.008 ? CLAMP(1 - totalS * 0.1, 0.90, 1).toFixed(3) : '1.000';
            ctx.fConv.setAttribute('kernelMatrix', kernelStr);
            // Update divisor to match kernel sum
            const kernelSum = 4 * (-totalS) + 4 * (-totalS * 0.707) + (1 - 4 * (-totalS) - 4 * (-totalS * 0.707));
            ctx.fConv.setAttribute('divisor', kernelSum.toFixed(5));
            ctx.fSat.setAttribute('values', desatVal);
          }
        }
      }

      const parts = [`url(#${ctx.fid})`];
      if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
      return parts.join(' ');
    }

    return {
      prepare,
      apply: (el, filterStr) => {
        if (!el) return;
        if (filterStr === 'none') { clearFilterStyles(el); return; }
        applyFilterStyles(el, filterStr);
      },
      clear: clearFilterStyles,
      // [FIX 3-9] Cleanup orphaned SVGs
      cleanup: () => {
        // ctxMap uses WeakMap so entries auto-clean when root is GC'd
        // but for explicit fullscreen transitions we force re-eval
      }
    };
  }

  /* ══ VideoParams ══ */
  // [FIX 1-1] Pass bright/contrast to SVG tone curve
  function createVideoParams(Store) {
    const cache = new WeakMap();

    function computeSharpMul(video) {
      const nW = video.videoWidth | 0;
      if (nW < 16) return { mul: 0.5, autoBase: 0.10 };

      const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);
      let dW, dH;
      try {
        const rect = video.getBoundingClientRect();
        dW = rect.width || video.clientWidth || nW;
        dH = rect.height || video.clientHeight || (video.videoHeight | 0);
      } catch (_) {
        dW = video.clientWidth || nW;
        dH = video.clientHeight || (video.videoHeight | 0);
      }
      if (dW < 16) return { mul: 0.5, autoBase: 0.10 };

      const nH = video.videoHeight | 0;
      const ratioW = (dW * dpr) / nW;
      const ratioH = (nH > 16 && dH > 16) ? (dH * dpr) / nH : ratioW;
      const ratio = Math.min(ratioW, ratioH);

      let mul = ratio <= 0.30 ? 0.40 :
                ratio <= 0.60 ? 0.40 + (ratio - 0.30) / 0.30 * 0.30 :
                ratio <= 1.00 ? 0.70 + (ratio - 0.60) / 0.40 * 0.30 :
                ratio <= 1.80 ? 1.00 :
                ratio <= 4.00 ? 1.00 - (ratio - 1.80) / 2.20 * 0.30 : 0.65;

      let autoBase = nW <= 640 ? 0.18 : nW <= 960 ? 0.14 : nW <= 1280 ? 0.13 : nW <= 1920 ? 0.12 : 0.07;
      if (IS_MOBILE) mul = Math.max(mul, 0.72);

      return { mul: CLAMP(mul, 0, 1), autoBase: CLAMP(autoBase * mul, 0, 0.18) };
    }

    return {
      get: (video) => {
        const storeRev = Store.rev();
        const nW = video ? (video.videoWidth | 0) : 0;
        const dW = video ? (video.clientWidth || video.offsetWidth || 0) : 0;
        const dH = video ? (video.clientHeight || video.offsetHeight || 0) : 0;

        if (video && nW >= 16) {
          const cached = cache.get(video);
          if (cached && cached.rev === storeRev && cached.nW === nW && cached.dW === dW && cached.dH === dH) {
            return cached.out;
          }
        }

        const out = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, toe: 0, mid: 0, shoulder: 0, temp: 0, sharp: 0, _cssBr: 1, _cssCt: 1, _cssSat: 1 };
        const presetS = Store.get(P.V_PRE_S);
        const mix = CLAMP(Number(Store.get(P.V_PRE_MIX)) || 1, 0, 1);
        const { mul, autoBase } = video ? computeSharpMul(video) : { mul: 0.5, autoBase: 0.10 };
        const finalMul = (mul === 0 && presetS !== 'off') ? 0.50 : mul;

        if (presetS === 'off') out.sharp = autoBase;
        else if (presetS !== 'none') out.sharp = (_PRESET_SHARP_LUT[presetS] || 0) * mix * finalMul;

        out.sharp = CLAMP(out.sharp, 0, SHARP_CAP);
        out.toe = CLAMP(Number(Store.get(P.V_MAN_SHAD)) || 0, 0, 100) * 0.0035;
        out.mid = CLAMP(Number(Store.get(P.V_MAN_REC)) || 0, 0, 100) * 0.0030;
        out.shoulder = CLAMP(Number(Store.get(P.V_MAN_BRT)) || 0, 0, 100) * 0.0040;
        out.temp = CLAMP(Number(Store.get(P.V_MAN_TEMP)) || 0, -50, 50);

        // [FIX 1-1] Feed bright/contrast into SVG tone curve
        out.bright = CLAMP(Number(Store.get(P.V_MAN_BRT)) || 0, 0, 100);
        out.contrast = 1 + (Number(Store.get(P.V_MAN_REC)) || 0) * 0.005;

        out._cssBr = 1 + (Number(Store.get(P.V_MAN_BRT)) || 0) * 0.005;
        out._cssCt = 1 + (Number(Store.get(P.V_MAN_REC)) || 0) * 0.005;
        out._cssSat = CLAMP(out.satF, 0.5, 2.0);

        if (video && nW >= 16) {
          cache.set(video, { rev: storeRev, nW, dW, dH, out });
        }
        return out;
      }
    };
  }

  /* ══ OSD ══ */
  function createOSD() {
    let el = null, timerId = 0;
    return {
      show: (text, ms = 1200) => {
        if (!document.body) return;
        const root = document.fullscreenElement || document.documentElement || document.body;
        if (!el || el.parentNode !== root) {
          el?.remove();
          el = document.createElement('div');
          el.id = 'vsc-osd';
          el.setAttribute('data-vsc-ui', '1');
          el.style.cssText = 'position:fixed!important;top:48px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(12,12,18,0.85)!important;backdrop-filter:blur(24px) saturate(200%)!important;color:rgba(255,255,255,0.95)!important;padding:10px 28px!important;border-radius:14px!important;border:1px solid rgba(0,229,255,0.15)!important;font:600 13px/1.4 system-ui,sans-serif!important;z-index:2147483647!important;pointer-events:none!important;opacity:0!important;transition:opacity 0.2s,transform 0.3s!important;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.08)!important;text-align:center!important;';
          root.appendChild(el);
        }
        el.textContent = text;
        requestAnimationFrame(() => { el.style.setProperty('opacity', '1', 'important'); });
        clearTimeout(timerId);
        timerId = setTimeout(() => { if (el) el.style.setProperty('opacity', '0', 'important'); }, ms);
      }
    };
  }

  /* ══ UI ══ */
  function createUI(Store, Bus, Audio, Registry, Scheduler, OSD) {
    let panelHost = null, panelEl = null, quickBarHost = null;
    let activeTab = 'video', panelOpen = false;
    let _shadow = null, _qbarShadow = null;
    const tabFns = [];
    let __scrBrtOverlay = null;

    const TAB_ICONS = {
      video: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('rect', { x: 2, y: 4, width: 16, height: 16, rx: 2 }), _s('path', { d: 'M22 7l-6 4 6 4z' })),
      audio: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('path', { d: 'M11 5L6 9H2v6h4l5 4V5z' }), _s('path', { d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
      playback: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('circle', { cx: 12, cy: 12, r: 10 }), _s('polygon', { points: '10 8 16 12 10 16' }))
    };
    const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생' };

    const SCR_BRT_LEVELS = [0, 0.05, 0.10, 0.15, 0.20, 0.25];
    const SCR_BRT_LABELS = ['리셋(OFF)', '1단', '2단', '3단', '4단', '5단'];

    function ensureScrBrtOverlay() {
      const targetRoot = document.fullscreenElement || document.webkitFullscreenElement || document.documentElement || document.body;
      if (__scrBrtOverlay?.isConnected && __scrBrtOverlay.parentNode === targetRoot) return __scrBrtOverlay;
      if (!__scrBrtOverlay) {
        __scrBrtOverlay = document.createElement('div');
        __scrBrtOverlay.id = 'vsc-scr-brt';
        __scrBrtOverlay.setAttribute('data-vsc-ui', '1');
        __scrBrtOverlay.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:white!important;mix-blend-mode:soft-light!important;pointer-events:none!important;z-index:2147483645!important;opacity:0!important;transition:opacity 0.3s ease!important;display:none!important;';
      }
      try { targetRoot.appendChild(__scrBrtOverlay); } catch (_) {}
      return __scrBrtOverlay;
    }

    function applyScrBrt(level) {
      const idx = CLAMP(Math.round(level), 0, SCR_BRT_LEVELS.length - 1);
      const val = SCR_BRT_LEVELS[idx];
      if (val <= 0) {
        if (__scrBrtOverlay) {
          __scrBrtOverlay.style.setProperty('opacity', '0', 'important');
          setTimeout(() => { if (__scrBrtOverlay?.style.opacity === '0') __scrBrtOverlay.style.setProperty('display', 'none', 'important'); }, 350);
        }
        return;
      }
      const ov = ensureScrBrtOverlay();
      ov.style.removeProperty('display');
      requestAnimationFrame(() => { ov.style.setProperty('opacity', String(val), 'important'); });
    }

    Store.sub(P.APP_SCREEN_BRT, v => applyScrBrt(Number(v) || 0));
    setTimeout(() => { const saved = Number(Store.get(P.APP_SCREEN_BRT)) || 0; if (saved > 0) applyScrBrt(saved); }, 500);

    const CSS_VARS = `
    :host {
      position: fixed !important; contain: none !important; overflow: visible !important; isolation: isolate; z-index: 2147483647 !important;
      --vsc-glass: rgba(12, 12, 18, 0.72); --vsc-glass-hover: rgba(30, 30, 44, 0.78); --vsc-glass-active: rgba(40, 40, 58, 0.82); --vsc-glass-blur: blur(24px) saturate(200%); --vsc-glass-border: rgba(255, 255, 255, 0.06);
      --vsc-neon: #00e5ff; --vsc-neon-glow: 0 0 12px rgba(0, 229, 255, 0.35), 0 0 40px rgba(0, 229, 255, 0.08); --vsc-neon-soft: rgba(0, 229, 255, 0.15); --vsc-neon-border: rgba(0, 229, 255, 0.25); --vsc-neon-dim: rgba(0, 229, 255, 0.08);
      --vsc-green: #4cff8d; --vsc-amber: #ffbe46; --vsc-red: #ff4d6a; --vsc-purple: #b47aff;
      --vsc-text: rgba(255, 255, 255, 0.92); --vsc-text-dim: rgba(255, 255, 255, 0.50); --vsc-text-muted: rgba(255, 255, 255, 0.28);
      --vsc-shadow-panel: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset; --vsc-shadow-btn: 0 2px 8px rgba(0, 0, 0, 0.3); --vsc-shadow-fab: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
      --vsc-space-xs: 4px; --vsc-space-sm: 6px; --vsc-space-md: 10px;
      --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-lg: 14px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px;
      --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      --vsc-font-xs: 10px; --vsc-font-sm: 11px; --vsc-font-md: 13px; --vsc-font-lg: 15px; --vsc-font-xl: 24px; --vsc-font-xxl: 32px;
      --vsc-touch-min: ${IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${IS_MOBILE ? '6px' : '10px'};
      --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      font-family: var(--vsc-font) !important; font-size: var(--vsc-font-md) !important; color: var(--vsc-text) !important; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }`;

    const PANEL_CSS = `
    ${CSS_VARS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; }
    .panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px) !important; top: 50% !important; width: var(--vsc-panel-width) !important; max-height: var(--vsc-panel-max-h) !important; background: var(--vsc-glass) !important; border: 1px solid var(--vsc-glass-border) !important; border-radius: var(--vsc-radius-xl) !important; backdrop-filter: var(--vsc-glass-blur) !important; -webkit-backdrop-filter: var(--vsc-glass-blur) !important; box-shadow: var(--vsc-shadow-panel) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; user-select: none !important; contain: none !important; opacity: 0 !important; transform: translate(16px, -50%) scale(0.92) !important; filter: blur(4px) !important; transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring), filter 0.3s var(--vsc-ease-out) !important; color: var(--vsc-text) !important; font-family: var(--vsc-font) !important; }
    .panel.open { opacity: 1 !important; transform: translate(0, -50%) scale(1) !important; filter: blur(0) !important; pointer-events: auto !important; }
    .panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
    .hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); gap: 10px; }
    .hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .tabs { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.04); position: relative; padding: 0 4px; }
    .tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); }
    .tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; text-transform: uppercase; color: var(--vsc-text); }
    .tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; transition: opacity 0.2s, filter 0.2s; stroke: currentColor; }
    .tab:hover { opacity: 0.65; }
    .tab.on { opacity: 1; color: var(--vsc-neon); }
    .tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.4)); stroke: var(--vsc-neon); }
    .body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0, 229, 255, 0.15) transparent; text-align: left; }
    .body::-webkit-scrollbar { width: 4px; } .body::-webkit-scrollbar-track { background: transparent; } .body::-webkit-scrollbar-thumb { background: rgba(0, 229, 255, 0.2); border-radius: 2px; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); }
    .row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; }
    .row .ctrl { display: flex; align-items: center; gap: var(--vsc-space-sm); flex: 1; justify-content: flex-end; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; margin: 0; }
    input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255, 255, 255, 0.08) var(--fill, 50%)); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0, 0, 0, 0.3); box-shadow: 0 0 8px rgba(0, 229, 255, 0.4); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); transition: box-shadow 0.2s, transform 0.15s var(--vsc-ease-spring); }
    input[type=range]:active::-webkit-slider-thumb { transform: scale(1.25); box-shadow: 0 0 16px rgba(0, 229, 255, 0.6); }
    .val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); }
    .tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255, 255, 255, 0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; flex-shrink: 0; border: 1px solid rgba(255, 255, 255, 0.06); }
    .tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0, 229, 255, 0.2); }
    .tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255, 255, 255, 0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; }
    .tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.6); }
    .btn { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-family: var(--vsc-font); font-weight: 500; }
    .btn:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.12); transform: translateY(-1px); }
    .chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; }
    .chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: 11px; font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; color: var(--vsc-text); }
    .chip:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.10); }
    .chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.1); }
    .sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.06), transparent); margin: 8px 0; }
    .metrics-footer { font-family: var(--vsc-font-mono); font-size: 11px; opacity: 0.6; padding: 6px 16px 8px; border-top: 1px solid rgba(255, 255, 255, 0.03); line-height: 1.6; display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--vsc-text); }
    .rate-display { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xxl); font-weight: 800; text-align: center; padding: 8px 0; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0, 229, 255, 0.2)); }
    .fine-row { display: flex; gap: var(--vsc-space-xs); justify-content: center; padding: 4px 0; }
    .fine-btn { padding: 2px 4px; min-height: 24px; min-width: 32px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255, 255, 255, 0.06); background: rgba(255, 255, 255, 0.03); color: rgba(255, 255, 255, 0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); }
    .fine-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
    .fine-btn:active { transform: scale(0.95); }
    .info-bar { font-family: var(--vsc-font-mono); font-size: 12px; opacity: 0.8; padding: 4px 0 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: var(--vsc-neon); text-align: left; }
    @media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } }
    @media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } }
    `;

    function getMountTarget() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs) return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs;
      return document.documentElement || document.body;
    }

    const HOST_STYLE_NORMAL = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
    const HOST_STYLE_FS = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
    let _lastMount = null, _qbarHasVideo = false;

    function reparent() {
      if (!quickBarHost) return;
      const target = getMountTarget();
      if (!target) return;

      // [수정] 스크롤 튕김 방지: 실제 부모 노드가 다를 때만 DOM을 이동하도록 조건 강화
      let moved = false;
      if (quickBarHost.parentNode !== target) {
        try { target.appendChild(quickBarHost); moved = true; } catch (_) {}
      }
      if (panelHost && panelHost.parentNode !== target) {
        try { target.appendChild(panelHost); moved = true; } catch (_) {}
      }
      if (moved) _lastMount = target;

      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const style = isFs ? HOST_STYLE_FS : HOST_STYLE_NORMAL;
      quickBarHost.style.cssText = style;
      if (panelHost) panelHost.style.cssText = style;
      if (!_qbarHasVideo) quickBarHost.style.setProperty('display', 'none', 'important');
      if (panelHost && panelOpen && panelEl) panelEl.style.pointerEvents = 'auto';
    }

    function onFullscreenChange() {
      reparent();
      setTimeout(reparent, 80);
      setTimeout(reparent, 400);
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        _lastMount = null;
        setTimeout(() => {
          const root = document.documentElement || document.body;
          if (quickBarHost?.parentNode !== root) try { root.appendChild(quickBarHost); } catch (_) {}
          if (panelHost?.parentNode !== root) try { root.appendChild(panelHost); } catch (_) {}
          reparent();
        }, 100);
      }
    }

    function updateQuickBarVisibility() {
      if (!quickBarHost) return;
      let has = Registry.videos.size > 0;
      if (!has) try { has = !!document.querySelector('video'); } catch (_) {}
      if (!has && Registry.shadowRootsLRU) {
        for (const it of Registry.shadowRootsLRU) {
          if (it.host?.isConnected && it.root) {
            try { if (it.root.querySelector('video')) { has = true; break; } } catch (_) {}
          }
        }
      }
      if (has && !_qbarHasVideo) { _qbarHasVideo = true; quickBarHost.style.removeProperty('display'); }
      else if (!has && _qbarHasVideo) { _qbarHasVideo = false; quickBarHost.style.setProperty('display', 'none', 'important'); if (panelOpen) togglePanel(false); }
      if (_qbarHasVideo) reparent();
    }

    function updateTabIndicator(tabBar, tabName) {
      if (!tabBar) return;
      const tabs = tabBar.querySelectorAll('.tab');
      const idx = ['video', 'audio', 'playback'].indexOf(tabName);
      if (idx < 0) return;
      const tabEl = tabs[idx];
      if (!tabEl) return;
      requestAnimationFrame(() => {
        const barRect = tabBar.getBoundingClientRect();
        const tabRect = tabEl.getBoundingClientRect();
        tabBar.style.setProperty('--tab-indicator-left', `${tabRect.left - barRect.left}px`);
        tabBar.style.setProperty('--tab-indicator-width', `${tabRect.width}px`);
        tabs.forEach(t => t.classList.toggle('on', t.dataset.t === tabName));
      });
    }

    function createSmartMetrics() {
      const footer = h('div', { class: 'metrics-footer' });
      const elRes = h('span', {}, '—'), elRate = h('span', {}, '—');
      footer.append(elRes, elRate);
      Bus.on('signal', () => {
        if (!panelOpen) return;
        const v = __internal._activeVideo;
        if (v?.isConnected) { elRes.textContent = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'; elRate.textContent = `${v.playbackRate.toFixed(2)}×`; }
        else { elRes.textContent = '—'; elRate.textContent = '—'; }
      });
      return footer;
    }

    function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
    function mkSep() { return h('div', { class: 'sep' }); }

    function mkSlider(path, min, max, step) {
      const s = step || ((max - min) / 100);
      const digits = s >= 1 ? 0 : 2;
      const inp = h('input', { type: 'range', min, max, step: s });
      const valEl = h('span', { class: 'val' });
      function updateUI(v) { inp.value = String(v); valEl.textContent = Number(v).toFixed(digits); inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`); }
      inp.addEventListener('input', () => { Store.set(path, parseFloat(inp.value)); updateUI(parseFloat(inp.value)); Scheduler.request(); });
      const sync = () => updateUI(Number(Store.get(path)) || min);
      tabFns.push(sync); sync();
      return [inp, valEl];
    }

    function mkToggle(path, onChange) {
      const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' });
      function sync() { const on = !!Store.get(path); el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); }
      el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); else Scheduler.request(); });
      tabFns.push(sync); sync();
      return el;
    }

    function chipRow(label, path, chips) {
      const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label));
      const row = h('div', { class: 'chips' });
      for (const ch of chips) row.appendChild(h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l));
      row.addEventListener('click', e => {
        const chip = e.target.closest('.chip'); if (!chip) return;
        Store.set(path, chip.dataset.v);
        requestAnimationFrame(() => { for (const c of row.children) c.classList.toggle('on', c.dataset.v === chip.dataset.v); });
        Scheduler.request();
      });
      const sync = () => { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); };
      wrap.appendChild(row); tabFns.push(sync); sync();
      return wrap;
    }

    function buildVideoTab() {
      const w = h('div', {});
      const infoBar = h('div', { class: 'info-bar' });
      const updateInfo = () => {
        const v = __internal._activeVideo;
        const p = Store.get(P.V_PRE_S);
        const lbl = p === 'none' ? 'OFF' : p === 'off' ? 'AUTO' : PRESETS.detail[p]?.label || p;
        if (!v?.isConnected) { infoBar.textContent = `영상 없음 │ 샤프닝: ${lbl}`; return; }
        const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0;
        infoBar.textContent = nW ? `원본 ${nW}×${nH} → 출력 ${dW}×${dH} │ 샤프닝: ${lbl}` : `비디오 정보 로딩 대기중... │ 샤프닝: ${lbl}`;
      };
      Bus.on('signal', updateInfo); Store.sub(P.V_PRE_S, updateInfo); tabFns.push(updateInfo);
      w.append(infoBar, mkSep());

      w.append(
        chipRow('디테일 프리셋', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: PRESETS.detail[k].label || k }))),
        mkRow('강도 믹스', ...mkSlider(P.V_PRE_MIX, 0, 1, 0.01)),
        mkSep()
      );

      const manualHeader = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
        h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '수동 보정'),
        h('div', { style: 'display:flex;gap:4px' },
          ...[
            { n: 'OFF',  v: [0,0,0,0] },
            { n: '선명', v: [36,0,0,0] },
            { n: '영화', v: [13,23,14,-22] },
            { n: '복원', v: [32,49,7,0] },
            { n: '심야', v: [54,37,0,-12] },
            { n: '아트', v: [0,41,11,-19] }
          ].map(p => {
            const btn = h('button', { class: 'fine-btn' }, p.n);
            btn.onclick = () => {
              Store.batch('video', { manualShadow: p.v[0], manualRecovery: p.v[1], manualBright: p.v[2], manualTemp: p.v[3] });
              Scheduler.request(); tabFns.forEach(f => f());
            };
            const syncBtn = () => {
              const match = [Store.get(P.V_MAN_SHAD), Store.get(P.V_MAN_REC), Store.get(P.V_MAN_BRT), Store.get(P.V_MAN_TEMP)].every((val, i) => val === p.v[i]);
              btn.style.background = match ? 'var(--vsc-neon-dim)' : 'rgba(255,255,255,0.03)';
              btn.style.color = match ? 'var(--vsc-neon)' : 'rgba(255,255,255,0.6)';
              btn.style.borderColor = match ? 'var(--vsc-neon-border)' : 'rgba(255,255,255,0.06)';
            };
            tabFns.push(syncBtn); syncBtn();
            return btn;
          })
        )
      );
      w.append(manualHeader);

      function mkSliderWithFine(label, path, min, max, step, fineStep) {
        const [slider, valEl] = mkSlider(path, min, max, step);
        const mkFine = (delta, text) => {
          const btn = h('button', { class: 'fine-btn', style: 'font-size:11px' }, text);
          btn.addEventListener('click', () => { Store.set(path, CLAMP(Math.round((Number(Store.get(path)) || 0) + delta), min, max)); Scheduler.request(); tabFns.forEach(f => f()); });
          return btn;
        };
        const resetBtn = h('button', { class: 'fine-btn', style: 'min-width:24px;font-size:10px;opacity:.6' }, '0');
        resetBtn.addEventListener('click', () => { Store.set(path, 0); Scheduler.request(); tabFns.forEach(f => f()); });
        return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn)));
      }

      w.append(
        mkSliderWithFine('암부 부스트', P.V_MAN_SHAD, 0, 100, 1, 5),
        mkSliderWithFine('디테일 복원', P.V_MAN_REC, 0, 100, 1, 5),
        mkSliderWithFine('노출 보정', P.V_MAN_BRT, 0, 100, 1, 5),
        mkSliderWithFine('색온도', P.V_MAN_TEMP, -50, 50, 1, 5),
        mkSep()
      );

      const brtBtns = [];
      const brtChips = h('div', { class: 'chips' });
      SCR_BRT_LABELS.forEach((label, idx) => {
        if (idx === 0) return;
        const chip = h('span', { class: 'chip', 'data-v': String(idx) }, '☀ ' + idx);
        chip.addEventListener('click', () => cycleScrBrtTo(idx));
        brtBtns.push(chip); brtChips.appendChild(chip);
      });
      const brtResetBtn = h('button', { class: 'chip', style: 'margin-left:auto;flex:none;width:70px;font-size:10px;border-color:var(--vsc-text-muted);color:#fff!important;' }, '리셋(OFF)');
      brtResetBtn.addEventListener('click', () => cycleScrBrtTo(0));
      const brtValLabel = h('span', { style: 'font-size:11px;color:var(--vsc-neon);margin-left:6px' }, '');

      function cycleScrBrtTo(idx) { Store.set(P.APP_SCREEN_BRT, idx); applyScrBrt(idx); syncBrt(); }
      function syncBrt() {
        const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0;
        brtBtns.forEach(btn => btn.classList.toggle('on', btn.dataset.v === String(cur)));
        brtResetBtn.classList.toggle('on', cur === 0);
        brtValLabel.textContent = SCR_BRT_LABELS[cur];
      }
      tabFns.push(syncBrt); syncBrt();

      w.append(
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
          h('div', { style: 'display:flex;align-items:center' }, h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '화면 조도 (Dimmer)'), brtValLabel),
          brtResetBtn
        ),
        brtChips
      );
      return w;
    }

    function buildAudioTab() {
      const w = h('div', {});
      w.append(
        mkRow('오디오 부스트', mkToggle(P.A_EN, () => Audio.setTarget(__internal._activeVideo))),
        mkRow('부스트 (dB)', ...mkSlider(P.A_BST, 0, 15, 0.5))
      );
      const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0;text-align:left;' }, '오디오: 대기');
Bus.on('signal', () => {
  if (!panelOpen) return;
  const hooked = Audio.isHooked(), bypassed = Audio.isBypassed();
  status.textContent = !Audio.hasCtx() ? '상태: 대기' :
                       (hooked && !bypassed) ? '상태: 활성 (DSP 처리 중)' :
                       bypassed ? '상태: 바이패스 (원본 출력)' : '상태: 준비 (연결 대기)';
});
      w.append(mkSep(), status);
      if (IS_FIREFOX) {
        w.append(h('div', { style: 'font-size:10px;opacity:.4;padding:4px 0;color:var(--vsc-amber)' }, 'Firefox에서는 오디오 부스트가 지원되지 않습니다.'));
      }
      return w;
    }

    function buildPlaybackTab() {
      const w = h('div', {});
      w.append(mkRow('속도 제어', mkToggle(P.PB_EN, () => Scheduler.request())));
      const rateDisplay = h('div', { class: 'rate-display' });
      function syncRate() { rateDisplay.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }
      tabFns.push(syncRate); syncRate();
      w.append(rateDisplay);

      const chipRow2 = h('div', { class: 'chips' });
      function syncChips() { const cur = Number(Store.get(P.PB_RATE)) || 1; for (const c of chipRow2.children) c.classList.toggle('on', Math.abs(cur - parseFloat(c.dataset.v)) < 0.01); }
      [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0].forEach(p => {
        const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`);
        el.addEventListener('click', () => { Store.set(P.PB_RATE, p); Store.set(P.PB_EN, true); Scheduler.request(); tabFns.forEach(f => f()); });
        chipRow2.appendChild(el);
      });
      tabFns.push(syncChips); syncChips();
      w.append(chipRow2);

      const fineRow = h('div', { class: 'fine-row' });
      [{ l: '−0.25', d: -0.25 }, { l: '−0.05', d: -0.05 }, { l: '+0.05', d: +0.05 }, { l: '+0.25', d: +0.25 }].forEach(fs => {
        const btn = h('button', { class: 'fine-btn' }, fs.l);
        btn.addEventListener('click', () => { Store.set(P.PB_RATE, CLAMP((Number(Store.get(P.PB_RATE)) || 1) + fs.d, 0.07, 16)); Store.set(P.PB_EN, true); Scheduler.request(); tabFns.forEach(f => f()); });
        fineRow.appendChild(btn);
      });
      w.append(fineRow, mkRow('속도 슬라이더', ...mkSlider(P.PB_RATE, 0.07, 4, 0.01)));
      return w;
    }

    function buildQuickBar() {
      if (quickBarHost) return;
      quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: HOST_STYLE_NORMAL });
      quickBarHost.style.setProperty('display', 'none', 'important');
      _qbarShadow = quickBarHost.attachShadow({ mode: 'closed' });

      const qStyle = document.createElement('style');
      qStyle.textContent = `
        ${CSS_VARS}
        .qbar { pointer-events:none; position:fixed!important; top:50%!important; right:var(--vsc-qbar-right)!important; transform:translateY(-50%)!important; display:flex!important; align-items:center!important; contain:none!important; z-index:2147483647!important; }
        .qbar .qb-main { pointer-events:auto; width:46px;height:46px; border-radius:50%; background:var(--vsc-glass); border:1px solid rgba(255,255,255,0.08); opacity:0.4; transition:all 0.3s var(--vsc-ease-out); box-shadow:var(--vsc-shadow-fab); display:flex;align-items:center;justify-content:center; cursor:pointer; backdrop-filter:blur(16px) saturate(180%); }
        .qbar:hover .qb-main { opacity:1; transform:scale(1.08); border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); }
        .qbar svg { width:22px;height:22px; fill:none; stroke:#fff!important; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4)); transition:stroke 0.2s; display:block!important; pointer-events:none!important; }
        .qbar:hover .qb-main svg { stroke:var(--vsc-neon)!important; }
      `;
      _qbarShadow.appendChild(qStyle);

      const bar = h('div', { class: 'qbar' });
      const mainBtn = h('div', { class: 'qb qb-main' });
      mainBtn.appendChild(_s('svg', { viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        _s('circle', { cx: '12', cy: '12', r: '3' }),
        _s('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })
      ));
      mainBtn.addEventListener('click', e => { e.preventDefault(); togglePanel(); });
      bar.append(mainBtn);
      _qbarShadow.appendChild(bar);
      getMountTarget().appendChild(quickBarHost);
    }

    function buildPanel() {
      if (panelHost) return;
      panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host', style: HOST_STYLE_NORMAL });
      _shadow = panelHost.attachShadow({ mode: 'closed' });
      _shadow.appendChild(h('style', {}, PANEL_CSS));
      panelEl = h('div', { class: 'panel' });

      const closeBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '✕');
      closeBtn.addEventListener('click', () => togglePanel(false));
      panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), closeBtn));

      const tabBar = h('div', { class: 'tabs' });
      ['video', 'audio', 'playback'].forEach(t => {
        const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t });
        tab.append(TAB_ICONS[t]?.() || '', h('span', {}, TAB_LABELS[t]));
        tab.addEventListener('click', () => { activeTab = t; renderTab(); });
        tabBar.appendChild(tab);
      });
      panelEl.appendChild(tabBar);
      panelEl.appendChild(h('div', { class: 'body' }));
      panelEl.appendChild(createSmartMetrics());
      _shadow.appendChild(panelEl);
      renderTab();
      getMountTarget().appendChild(panelHost);
    }

    function renderTab() {
      const body = _shadow?.querySelector('.body'); if (!body) return;
      body.textContent = ''; tabFns.length = 0;
      const w = h('div', {});
      if (activeTab === 'video') w.appendChild(buildVideoTab());
      else if (activeTab === 'audio') w.appendChild(buildAudioTab());
      else if (activeTab === 'playback') w.appendChild(buildPlaybackTab());
      body.appendChild(w);
      tabFns.forEach(f => f());
      _shadow.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.t === activeTab));
      updateTabIndicator(_shadow.querySelector('.tabs'), activeTab);
    }

    function togglePanel(force) {
      buildPanel();
      panelOpen = force !== undefined ? force : !panelOpen;
      if (panelOpen) { panelEl.classList.add('open'); panelEl.style.pointerEvents = 'auto'; renderTab(); }
      else { panelEl.classList.remove('open'); setTimeout(() => { if (!panelOpen) panelEl.style.pointerEvents = 'none'; }, 300); }
    }

    buildQuickBar();
    updateQuickBarVisibility();
    Bus.on('signal', updateQuickBarVisibility);
    setInterval(updateQuickBarVisibility, 2000);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    setInterval(() => { if (quickBarHost?.parentNode !== getMountTarget()) reparent(); }, 2000);

    return { togglePanel, syncAll: () => tabFns.forEach(f => f()) };
  }

  /* ══ Mobile Gestures ══ */
  function createGestures(Store, Scheduler, OSD) {
    if (!IS_MOBILE) return; // 모바일 환경에서만 활성화

    let touchStartX = 0, touchStartY = 0;
    let lastTapTime = 0;
    let isSwiping = false;
    let swipeType = ''; // 'h'(가로-탐색), 'vL'(세로좌측-밝기/배속), 'vR'(세로우측-볼륨)
    let initialVal = 0;
    let seekInitialTime = 0;
    let elSeekOverlay = null;
    let __touchBriOverlay = null;

    const SWIPE_THRESHOLD = 15;
    const SEEK_SENSITIVITY = 0.08; // 전체 화면 너비 스와이프 시 이동할 영상 길이 비율

    // 타겟이 비디오인지 확인하는 유틸 (이벤트 위임 최적화)
    const isValidTarget = (e) => {
      const v = __internal._activeVideo;
      if (!v || !v.isConnected) return false;
      if (e.target.tagName === 'VIDEO' || (e.target.closest && e.target.closest('video, .html5-video-player, .jwplayer'))) return v;
      return false;
    };

    function isInFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    }

    /* ── OSD 시간 포맷 유틸 ── */
    function formatTime(sec) {
      if (!Number.isFinite(sec) || sec < 0) sec = 0;
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
      const p = v => String(v).padStart(2, '0');
      return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
    }

    function formatDelta(sec) {
      const sign = sec < 0 ? '−' : '+';
      const abs = Math.floor(Math.abs(sec));
      const h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60), s = abs % 60;
      const p = v => String(v).padStart(2, '0');
      return h > 0 ? `${sign}${p(h)}:${p(m)}:${p(s)}` : `${sign}${p(m)}:${p(s)}`;
    }

    /* ── 탐색 전용 중앙 OSD 오버레이 (v214.3.0 디자인 이식) ── */
    function getOverlayParent() {
      return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
    }

    function ensureSeekOverlay() {
      const parent = getOverlayParent();
      if (elSeekOverlay?.isConnected && elSeekOverlay.parentNode === parent) return elSeekOverlay;
      elSeekOverlay?.remove();
      elSeekOverlay = document.createElement('div');
      elSeekOverlay.className = 'vsc-seek-overlay';
      elSeekOverlay.setAttribute('data-vsc-ui', '1');
      parent.appendChild(elSeekOverlay);
      return elSeekOverlay;
    }

    function updateSeekUI(currentTime, delta) {
      const ov = ensureSeekOverlay();
      const directionText = delta >= 0 ? "오른쪽 스와이프 중" : "왼쪽 스와이프 중";
      const deltaText = formatDelta(delta);
      const deltaColor = delta >= 0 ? "#8effa9" : "#ff8e8e";

      ov.textContent = '';
      const dirEl = document.createElement('div'); dirEl.className = 'vsc-seek-direction'; dirEl.textContent = directionText;
      const mainEl = document.createElement('div'); mainEl.className = 'vsc-seek-main'; mainEl.textContent = `(${formatTime(currentTime)})`;
      const deltaEl = document.createElement('div'); deltaEl.className = 'vsc-seek-delta'; deltaEl.style.color = deltaColor; deltaEl.textContent = `(${deltaText})`;

      ov.appendChild(dirEl); ov.appendChild(mainEl); ov.appendChild(deltaEl);
      ov.style.display = 'flex';
      ov.classList.add('show');
    }

    function hideSeekOverlaySmooth() {
      if (elSeekOverlay && elSeekOverlay.classList.contains('show')) {
        elSeekOverlay.style.opacity = '0';
        setTimeout(() => {
          if (elSeekOverlay && elSeekOverlay.style.opacity === '0') {
            elSeekOverlay.classList.remove('show');
            elSeekOverlay.style.display = 'none';
          }
        }, 150);
      }
    }

    /* ── 화면 밝기(Dimmer) 터치 조절 전용 오버레이 ── */
    function ensureBriOverlay(video) {
      const parent = video.parentElement || getOverlayParent();
      if (__touchBriOverlay?.isConnected && __touchBriOverlay.parentNode === parent) return __touchBriOverlay;
      __touchBriOverlay?.remove(); __touchBriOverlay = document.createElement('div'); __touchBriOverlay.setAttribute('data-vsc-ui', '1');
      __touchBriOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:black;opacity:0;pointer-events:none;z-index:1;transition:opacity 0.08s linear;';
      parent.appendChild(__touchBriOverlay);
      const pos = getComputedStyle(parent).position; if (pos === 'static') parent.style.position = 'relative';
      return __touchBriOverlay;
    }

    function applyTouchBrightness(video, brightness01) {
      const clamped = CLAMP(brightness01, 0.05, 1.0);
      const overlay = ensureBriOverlay(video);
      overlay.style.opacity = String(1 - clamped);
    }

    function removeTouchBrightness() {
      if (__touchBriOverlay?.isConnected) {
        __touchBriOverlay.style.opacity = '0';
        const ov = __touchBriOverlay;
        setTimeout(() => { ov?.remove(); }, 300);
        __touchBriOverlay = null;
      }
    }


    /* ── 이벤트 리스너 ── */
    window.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const v = isValidTarget(e);
      if (!v) return;

      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      isSwiping = false;
      swipeType = '';
      seekInitialTime = v.currentTime;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const v = isValidTarget(e);
      if (!v) return;

      const t = e.touches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // 스와이프 시작 판정
      if (!isSwiping && (absDx > SWIPE_THRESHOLD || absDy > SWIPE_THRESHOLD)) {
        if (absDx > absDy) {
          // 가로: 탐색
          swipeType = 'h';
          isSwiping = true;
        } else {
          // 세로: 밝기/볼륨 조절 (단, 전체화면일 때만 허용)
          if (isInFullscreen()) {
            isSwiping = true;
            const rect = v.getBoundingClientRect();
            swipeType = (touchStartX < rect.left + rect.width / 2) ? 'vL' : 'vR';
            initialVal = swipeType === 'vL' ? 1.0 : v.volume; // vL은 밝기(1.0)를 기본값으로
          } else {
            // 전체화면이 아닐 때는 세로 스크롤을 위해 스와이프 판정을 포기합니다.
            swipeType = '';
            isSwiping = false;
            return;
          }
        }
      }

      if (isSwiping) {
        if (e.cancelable) e.preventDefault(); // 기본 스크롤/액션 방지

        if (swipeType === 'h') {
          const duration = v.duration;
          if (!Number.isFinite(duration) || duration <= 0) return;
          const vRect = v.getBoundingClientRect();
          const normalizedDx = dx / Math.max(1, vRect.width);
          const timeChange = normalizedDx * duration * SEEK_SENSITIVITY;
          const newTime = CLAMP(seekInitialTime + timeChange, 0, duration);

          v.currentTime = newTime;
          updateSeekUI(newTime, newTime - seekInitialTime);
        } else if (swipeType === 'vR') {
          // 우측 세로: 볼륨
          const volDelta = -(dy / window.innerHeight) * 2.0;
          let newVal = CLAMP(initialVal + volDelta, 0, 1);
          v.volume = newVal;
          if (newVal > 0 && v.muted) v.muted = false;
          OSD.show(`볼륨: ${Math.round(newVal * 100)}%`, 500);
        } else if (swipeType === 'vL') {
          // 좌측 세로: 밝기 조절 (Dimmer)
          const briDelta = -(dy / window.innerHeight) * 2.0;
          let newBri = CLAMP(initialVal + briDelta, 0.05, 1.0);
          applyTouchBrightness(v, newBri);
          OSD.show(`밝기: ${Math.round(newBri * 100)}%`, 500);
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      const v = isValidTarget(e);
      if (!v) return;

      if (!isSwiping) {
        // 제자리 더블 탭 판정 (300ms 이내)
        const now = Date.now();
        if (now - lastTapTime < 300) {
          const rect = v.getBoundingClientRect();
          const w = rect.width;
          const x = e.changedTouches[0].clientX - rect.left;

          if (x < w * 0.3) {
            v.currentTime = Math.max(0, v.currentTime - 10);
            OSD.show('⏪ -10초');
          } else if (x > w * 0.7) {
            v.currentTime += 10;
            OSD.show('+10초 ⏩');
          } else {
            // 가운데 더블 탭: 전체화면 및 가로모드 전환
            const isFs = isInFullscreen();
            const targetEl = v.closest('.html5-video-player, .jwplayer, .video-js') || v;

            if (!isFs) {
              const reqFs = targetEl.requestFullscreen || targetEl.webkitRequestFullscreen;
              if (reqFs) {
                reqFs.call(targetEl).then(() => {
                  setTimeout(() => {
                    if (screen.orientation && screen.orientation.lock) {
                      screen.orientation.lock('landscape').catch(() => {});
                    }
                  }, 400);
                }).catch(() => {
                  if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
                  else if (v.requestFullscreen) v.requestFullscreen();
                });
                OSD.show('🔲 전체화면');
              } else if (v.webkitEnterFullscreen) {
                v.webkitEnterFullscreen();
                OSD.show('🔲 전체화면 (iOS)');
              }
            } else {
              const extFs = document.exitFullscreen || document.webkitExitFullscreen;
              if (extFs) {
                if (screen.orientation && screen.orientation.unlock) {
                  screen.orientation.unlock();
                }
                extFs.call(document);
                OSD.show('✖ 화면 복구');
              }
            }
          }
          lastTapTime = 0;
          if (e.cancelable) e.preventDefault();
        } else {
          lastTapTime = now;
        }
      } else {
        // 스와이프 종료 시 OSD 정리
        if (swipeType === 'h') {
          hideSeekOverlaySmooth();
          const delta = v.currentTime - seekInitialTime;
          if (Math.abs(delta) > 0.5) OSD.show(`${formatDelta(delta)}  →  ${formatTime(v.currentTime)}`, 1200);
        } else if (swipeType === 'vL') {
          removeTouchBrightness();
        }
        isSwiping = false;
      }
    }, { passive: false });

    window.addEventListener('touchcancel', () => {
      isSwiping = false;
      hideSeekOverlaySmooth();
      removeTouchBrightness();
    });
  }

  /* ══ Bootstrap ══ */
  function bootstrap() {
    const Scheduler = createScheduler();
    const Bus = createEventBus();
    const Store = createLocalStore(DEFAULTS, Scheduler);

    try { const saved = GM_getValue(STORAGE_KEY); if (saved) Store.load(JSON.parse(saved)); } catch (_) {}

    // [FIX 3-1, 3-5] Debounced save on all paths
    let saveTimer = 0;
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = 0;
        try { GM_setValue(STORAGE_KEY, JSON.stringify(Store.state)); } catch (_) {}
      }, 300);
    };
    for (const path of Object.values(P)) {
      Store.sub(path, save);
    }

    const Registry = createRegistry(Scheduler, Bus);
    const Targeting = createTargeting();
    const Audio = createAudio(Store);
    const OSD = createOSD();
    const Params = createVideoParams(Store);
    const Filters = createFilters();
    const Gestures = createGestures(Store, Scheduler, OSD);

    // [FIX 3-7, 3-8] apply with size filter and playback rate
    const apply = () => {
      if (!Store.get('app.active')) {
        for (const v of Registry.videos) Filters.clear(v);
        Audio.setTarget(null);
        return;
      }
      const target = Targeting.pick(Registry.videos);
      if (target) {
        __internal._activeVideo = target;
        Audio.setTarget(target);

        // [FIX 3-8] Playback rate
        if (Store.get(P.PB_EN)) {
          const rate = CLAMP(Number(Store.get(P.PB_RATE)) || 1, 0.07, 16);
          if (Math.abs(target.playbackRate - rate) > 0.001) {
            try { target.playbackRate = rate; } catch (_) {}
          }
        }
      }

      for (const v of Registry.videos) {
        if (!v.isConnected) continue;
        // [FIX 3-7] Skip tiny videos
        const rect = v.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 45) {
          Filters.clear(v);
          continue;
        }
        const params = Params.get(v);
        const filterStr = Filters.prepare(v, params);
        Filters.apply(v, filterStr);
      }
    };
    Scheduler.registerApply(apply);

    // [FIX 3-8] Restore rate on disable
    Store.sub(P.PB_EN, (enabled) => {
      if (!enabled && __internal._activeVideo?.isConnected) {
        try { __internal._activeVideo.playbackRate = 1.0; } catch (_) {}
      }
    });

    // [FIX 3-9] Cleanup on fullscreen change
    document.addEventListener('fullscreenchange', () => {
      Filters.cleanup?.();
      Scheduler.request(true);
    });

    createUI(Store, Bus, Audio, Registry, Scheduler, OSD);
    __internal.Store = Store;
    __internal._activeVideo = null;

    // [FIX 3-11] GM menu command for ON/OFF toggle
    try {
      GM_registerMenuCommand('VSC ON/OFF 토글', () => {
        const current = Store.get(P.APP_ACT);
        Store.set(P.APP_ACT, !current);
        OSD.show(Store.get(P.APP_ACT) ? 'VSC ON' : 'VSC OFF', 1000);
        Scheduler.request(true);
      });
    } catch (_) {}

    Registry.rescanAll();
    apply();
    log.info(`[VSC] v${VSC_VERSION} booted.`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();

})();
