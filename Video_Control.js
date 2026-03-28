// ==UserScript==
// @name         Video_Control (v28.9.4)
// @namespace    https://github.com/
// @version      28.9.4
// @description  v28.9.4: AutoScene Clarity/HighRoll 곡선 재설계 및 S커브 강도(2.8) 확대 적용
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
  if (window.__vsc_booted) return;
  window.__vsc_booted = true;

  const __internal = window.__vsc_internal || (window.__vsc_internal = {});
  const IS_MOBILE = navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);
  const IS_FIREFOX = navigator.userAgent.includes('Firefox');
  const VSC_ID = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  const VSC_VERSION = '28.9.4';

  const log = {
    info: (...a) => console.info('[VSC]', ...a),
    warn: (...a) => console.warn('[VSC]', ...a),
    error: (...a) => console.error('[VSC]', ...a)
  };

  function normalizeHostname(h) {
    const parts = h.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) return h;
    let norm = parts;
    if (norm[0] === 'www') norm = norm.slice(1);
    if (norm.length > 2 && /^\d{1,3}$/.test(norm[0])) return norm.slice(1).join('.');
    return norm.join('.');
  }
  const STORAGE_KEY = 'vsc_v2_' + normalizeHostname(location.hostname) + (location.pathname.startsWith('/shorts') ? '_shorts' : '');
  const CLAMP = (v, min, max) => v < min ? min : v > max ? max : v;
  const SHARP_CAP = 0.15;

  function onFsChange(fn) {
    document.addEventListener('fullscreenchange', fn);
    document.addEventListener('webkitfullscreenchange', fn);
  }

  function checkNeedsSvg(s) {
    if (IS_FIREFOX) return false;
    const hasSharp = Math.abs(s.sharp || 0) > 0.005;
    const hasTone = (Math.abs(s.toe || 0) > 0.005 || Math.abs(s.mid || 0) > 0.005 || Math.abs(s.shoulder || 0) > 0.005 || Math.abs((s.gain || 1) - 1) > 0.005 || Math.abs((s.gamma || 1) - 1) > 0.005 || Math.abs((s.contrast || 1) - 1) > 0.005);
    const hasHighRoll = Math.abs(s.highRoll || 0) > 0.005;
    const hasClarity = Math.abs(s.clarity || 0) > 0.005;
    return hasSharp || hasTone || hasHighRoll || hasClarity || Math.abs(s.temp || 0) > 0.5 || Math.abs(s.tint || 0) > 0.5;
  }

  function applyFilterStyles(el, filterStr) {
    if (!el?.style) return;
    el.style.setProperty('filter', filterStr, 'important');
    el.style.setProperty('-webkit-filter', filterStr, 'important');
  }
  function clearFilterStyles(el) {
    if (!el?.style) return;
    el.style.removeProperty('filter');
    el.style.removeProperty('-webkit-filter');
  }

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

  function tempTintToRgbGain(temp, tint) {
    const t = CLAMP((Number(temp) || 0) * 0.02, -1, 1);
    const n = CLAMP((Number(tint) || 0) * 0.02, -1, 1);
    if (Math.abs(t) < 0.001 && Math.abs(n) < 0.001) return { rs: 1, gs: 1, bs: 1 };
    let r = 1 + 0.14 * t + 0.06 * n;
    let g = 1 - 0.005 * Math.abs(t) - 0.14 * n;
    let b = 1 - 0.14 * t + 0.06 * n;
    const maxCh = Math.max(r, g, b);
    return { rs: r / maxCh, gs: g / maxCh, bs: b / maxCh };
  }

  const MANUAL_PRESETS = [
    { n: 'OFF',        v: [0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0] },
    { n: '또렷',        v: [8,  20,   0,   0,   0,   5,   0,   8,   2,   0,   0] },
    { n: '피부톤',      v: [8,  15,   8,  12,   3,   0,  -4,   4,   2,   0,   0] },
    { n: '선명강조',    v: [15, 22,   5,   0,   0,   8,   0,  10,   3,   0,   0] },
    { n: '웹캠보정',    v: [20, 25,  10,   0,   5,   8,  -4,   6,   6,   0,   0] },
    { n: '밝은영상',    v: [0,   8,   0,   0,   0,   8,  -2,  10,   0,  22,  15] },
    { n: '태블릿풍',    v: [6,  12,   5,   0,   0,  10,  -2,   8,   2,  16,  10] },
    { n: '사용자10',   v: [11,  9,   5,   0,   0,   0,  -1,   0,   1,   0,   0] },
    { n: '사용자20',   v: [16, 12,   6,   0,   0,  -1,  -1,   0,   3,   0,   0] },
    { n: '사용자30',   v: [20, 15,   8,   0,   0,  -1,  -1,   0,   4,   0,   0] },
    { n: '사용자40',   v: [24, 17,  10,   0,   0,  -1,  -1,   0,   5,   0,   0] },
    { n: '사용자50',   v: [29, 19,  11,   0,   0,  -2,  -2,   0,   6,   0,   0] },
    { n: '사용자60',   v: [33, 21,  13,   0,   0,  -2,  -2,   0,   7,   0,   0] },
    { n: '사용자70',   v: [37, 24,  15,   0,   0,  -3,  -3,   0,   8,   0,   0] },
    { n: '사용자80',   v: [41, 26,  17,   0,   0,  -3,  -3,   0,   9,   0,   0] },
    { n: '사용자90',   v: [46, 28,  18,   0,   0,  -4,  -4,   0,  10,   0,   0] },
    { n: '사용자100',  v: [50, 30,  20,   0,   0,  -4,  -4,   0,  11,   0,   0] },
  ];

  const DEFAULTS = {
    video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0, manualTint: 0, manualSat: 0, manualGamma: 0, manualContrast: 0, manualGain: 0, manualClarity: 0, manualHighRoll: 0, autoScene: false },
    audio: { enabled: false, strength: 50 },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false }
  };
  const P = {
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible',
    V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
    V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery',
    V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp',
    V_MAN_TINT: 'video.manualTint', V_MAN_SAT: 'video.manualSat',
    V_MAN_GAMMA: 'video.manualGamma', V_MAN_CON: 'video.manualContrast',
    V_MAN_GAIN: 'video.manualGain',
    V_MAN_CLARITY: 'video.manualClarity',
    V_MAN_HIGHROLL: 'video.manualHighRoll',
    V_AUTO_SCENE: 'video.autoScene',
    A_EN: 'audio.enabled', A_STR: 'audio.strength',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  };

  const MANUAL_PATHS = [P.V_MAN_SHAD, P.V_MAN_REC, P.V_MAN_BRT, P.V_MAN_TEMP, P.V_MAN_TINT, P.V_MAN_SAT, P.V_MAN_GAMMA, P.V_MAN_CON, P.V_MAN_GAIN, P.V_MAN_CLARITY, P.V_MAN_HIGHROLL];
  const MANUAL_KEYS = MANUAL_PATHS.map(p => p.split('.')[1]);

  function createLocalStore(defaults, scheduler) {
    let rev = 0;
    const _kc = {};
    const listeners = new Map();
    const state = JSON.parse(JSON.stringify(defaults));
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const fn of a) try { fn(val); } catch (_) {} };
    return {
      state, rev: () => rev,
      get: (p) => { let pts = _kc[p] || (_kc[p] = p.split('.')); return pts.length > 1 ? state[pts[0]]?.[pts[1]] : state[pts[0]]; },
      set: (p, val) => {
        if (typeof val === 'number' && Number.isNaN(val)) return;
        const [c, k] = p.split('.');
        if (k != null) { if (Object.is(state[c]?.[k], val)) return; state[c][k] = val; rev++; emit(p, val); scheduler.request(); }
      },
      batch: (cat, obj) => { let changed = false; for (const [k, v] of Object.entries(obj)) { if (typeof v === 'number' && Number.isNaN(v)) continue; if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); } } if (changed) { rev++; scheduler.request(); } },
      sub: (k, f) => {
        if (!listeners.has(k)) listeners.set(k, new Set());
        listeners.get(k).add(f);
        return () => listeners.get(k).delete(f);
      },
      load: (data) => { if (!data) return; for (const c of Object.keys(defaults)) { if (data[c] != null && typeof data[c] === 'object') Object.assign(state[c], data[c]); } rev++; }
    };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg','defs','filter','feComponentTransfer','feFuncR','feFuncG','feFuncB','feFuncA','feConvolveMatrix','feColorMatrix','feGaussianBlur','feMerge','feMergeNode','feComposite','feBlend','g','path','circle','rect','line','text','polyline','polygon']);

  function h(tag, props = {}, ...children) {
    const isSvg = props.ns === 'svg' || SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'ns') continue;
      if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function createScheduler(minIntervalMs = 16) {
    let queued = false, applyFn = null, lastRun = 0;
    let immediateRequested = false;
    const signalFns = [];
    return {
      registerApply: fn => { applyFn = fn; },
      onSignal: fn => { signalFns.push(fn); return () => { const idx = signalFns.indexOf(fn); if (idx > -1) signalFns.splice(idx, 1); }; },
      request: (immediate = false) => {
        if (immediate) immediateRequested = true;
        if (queued) return; queued = true;
        requestAnimationFrame(() => {
          queued = false; const isImmediate = immediateRequested; immediateRequested = false;
          const now = performance.now();
          if (!isImmediate && now - lastRun < minIntervalMs) return; lastRun = now;
          if (applyFn) try { applyFn(); } catch (_) {}
          for (const fn of signalFns) try { fn(); } catch (_) {}
        });
      }
    };
  }

  function createRegistry(scheduler) {
    const videos = new Set();
    const shadowRootsLRU = [];
    const observedShadowHosts = new WeakSet();
    const SHADOW_MAX = 16;
    const observers = new Set();
    const videoListeners = new WeakMap();
    let refreshRafId = 0;
    function requestRefresh() { if (refreshRafId) return; refreshRafId = requestAnimationFrame(() => { refreshRafId = 0; scheduler.request(); }); }
    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting || e.intersectionRatio > 0) { requestRefresh(); return; } } }, { root: null, threshold: [0, 0.05, 0.5], rootMargin: '150px' }) : null;
    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => { for (const e of entries) { if (e.target.tagName === 'VIDEO') { requestRefresh(); return; } } }) : null;
    const isVscNode = (n) => { if (!n || n.nodeType !== 1) return false; return !!(n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host' || n.id === 'vsc-osd'); };
    function observeVideo(el) {
      if (!el || el.tagName !== 'VIDEO' || videos.has(el)) return; videos.add(el);
      el.addEventListener('encrypted', () => { el.dataset.vscDrm = "1"; scheduler.request(); });
      el.addEventListener('waitingforkey', () => { el.dataset.vscDrm = "1"; scheduler.request(); });
      if (io) io.observe(el); if (ro) ro.observe(el);
      const req = () => { scheduler.request(); }; let lastT = 0;
      const onTimeUpdate = () => { const now = performance.now(); if (now - lastT > 500) { lastT = now; req(); } };
      const listenerDefs = [['loadedmetadata', req], ['resize', req], ['playing', req], ['timeupdate', onTimeUpdate], ['seeked', () => { scheduler.request(true); }], ['loadstart', () => { delete el.dataset.vscDrm; delete el.dataset.vscCorsFail; req(); }]];
      for (const [evt, fn] of listenerDefs) el.addEventListener(evt, fn, { passive: true });
      videoListeners.set(el, listenerDefs); req();
    }
    function addShadowRoot(host) {
      if (!host?.shadowRoot || observedShadowHosts.has(host)) return false; observedShadowHosts.add(host);
      if (shadowRootsLRU.length >= SHADOW_MAX) { const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected); if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift(); }
      shadowRootsLRU.push({ host, root: host.shadowRoot }); connectObserver(host.shadowRoot); return true;
    }
    function scanNode(n) {
      if (!n) return;
      if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } if (n.shadowRoot && addShadowRoot(n)) scanNode(n.shadowRoot); if (!n.childElementCount) return; try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
      else if (n.nodeType === 11) { try { const vs = n.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
    }
    const workQ = []; let workScheduled = false; let workDepth = 0; const MAX_WORK_DEPTH = 8;
    function scheduleWork() { if (workScheduled) return; workScheduled = true; const doWork = () => { workScheduled = false; if (workDepth >= MAX_WORK_DEPTH) { workQ.length = 0; workDepth = 0; return; } workDepth++; const batch = workQ.splice(0, 20); for (const n of batch) scanNode(n); workDepth--; if (workQ.length > 0) scheduleWork(); }; if (typeof requestIdleCallback === 'function') requestIdleCallback(doWork, { timeout: 120 }); else setTimeout(doWork, 0); }
    function enqueue(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; if (workQ.length > 500) workQ.length = 0; workQ.push(n); scheduleWork(); }
    function connectObserver(root) {
      if (!root) return;
      const mo = new MutationObserver((muts) => { let touchedVideo = false; for (const m of muts) { if (m.addedNodes?.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; if (n.nodeType === 1 && isVscNode(n)) continue; enqueue(n); if (!touchedVideo && n.nodeType === 1) { if (n.tagName === 'VIDEO') touchedVideo = true; else if (n.childElementCount) { try { const l = n.getElementsByTagName('video'); if (l?.length) touchedVideo = true; } catch (_) {} } } } } if (!touchedVideo && m.removedNodes?.length) { for (const n of m.removedNodes) { if (n?.nodeType === 1 && (n.tagName === 'VIDEO' || n.querySelector?.('video'))) { touchedVideo = true; break; } } } } if (touchedVideo) requestRefresh(); });
      mo.observe(root, { childList: true, subtree: true }); observers.add(mo); enqueue(root);
    }
    const root = document.body || document.documentElement; if (root) { connectObserver(root); }
    function scanShadowRoots() { try { const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, { acceptNode: function(node) { return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } }); let el; while (el = walker.nextNode()) { if (addShadowRoot(el)) scanNode(el.shadowRoot); } } catch (_) {} }
    let _purgeCallback = null; function setPurgeCallback(fn) { _purgeCallback = fn; }
    function cleanup() { let removed = 0; for (const el of videos) { if (!el?.isConnected) { videos.delete(el); clearFilterStyles(el); if (io) try { io.unobserve(el); } catch (_) {} if (ro) try { ro.unobserve(el); } catch (_) {} const ls = videoListeners.get(el); if (ls) { for (const [evt, fn] of ls) el.removeEventListener(evt, fn); videoListeners.delete(el); } removed++; } } for (let i = shadowRootsLRU.length - 1; i >= 0; i--) { const entry = shadowRootsLRU[i]; if (!entry.host?.isConnected) { if (_purgeCallback && entry.root) try { _purgeCallback(entry.root); } catch (_) {} shadowRootsLRU.splice(i, 1); } } if (removed) requestRefresh(); }
    return { videos, shadowRootsLRU, rescanAll: () => scanNode(document.body || document.documentElement), cleanup, scanShadowRoots, setPurgeCallback };
  }

  function createTargeting() {
    return { pick: (videos) => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) { if (fsEl.tagName === 'VIDEO' && videos.has(fsEl)) return fsEl; for (const v of videos) { if (v.isConnected && fsEl.contains(v)) return v; } }
      let best = null, bestScore = -Infinity;
      for (const v of videos) { if (!v.isConnected) continue; const dW = v.clientWidth || 0, dH = v.clientHeight || 0, area = dW * dH; if (area === 0 && v.readyState === 0 && v.paused) continue; let s = Math.log2(1 + Math.max(0, area)); if (!v.paused && !v.ended) s += 25; if (v.currentTime > 0) s += 5; if (!v.muted && v.volume > 0.01) s += 5; if (s > bestScore) { bestScore = s; best = v; } }
      return best;
    }};
  }

  function createAudio(store, scheduler) {
    if (IS_FIREFOX) return { setTarget() {}, update() {}, hasCtx: () => false, isHooked: () => false, isBypassed: () => true };
    let ctx = null, comp = null, limiter = null, makeupGain = null, masterOut = null, dryPath = null;
    let currentSrc = null, targetVideo = null, currentMode = 'none';
    const mesMap = new WeakMap(); const streamMap = new WeakMap();
    let bypassMode = false, generation = 0;
    function detectJWPlayer(video) { if (!video) return false; if (typeof window.jwplayer === 'function') { try { if (window.jwplayer()?.getContainer?.()) return true; } catch (_) {} } let el = video.parentElement, depth = 0; while (el && depth < 10) { if (el.classList?.contains('jwplayer') || el.id?.startsWith('jwplayer') || el.classList?.contains('jw-wrapper') || el.querySelector?.(':scope > .jw-media, :scope > .jw-controls')) return true; el = el.parentElement; depth++; } if (video.src?.startsWith('blob:')) { if (document.querySelector('script[src*="jwplayer"]') || document.querySelector('[class*="jw-"]')) return true; } return false; }
    function canConnect(video) { if (!video) return false; if (video.dataset.vscPermBypass === "1") return false; if (detectJWPlayer(video) && video.dataset.vscCorsFail === "1") return false; if (video.dataset.vscMesFail === "1" && video.dataset.vscCorsFail === "1") return false; return true; }
    function initCtx() { if (ctx) return true; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { return false; } comp = ctx.createDynamicsCompressor(); makeupGain = ctx.createGain(); makeupGain.gain.value = 1; limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3.0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08; limiter.knee.value = 0; masterOut = ctx.createGain(); masterOut.gain.value = 1; comp.connect(makeupGain); makeupGain.connect(limiter); limiter.connect(masterOut); masterOut.connect(ctx.destination); dryPath = ctx.createGain(); dryPath.gain.value = 1; dryPath.connect(ctx.destination); applyStrength(Number(store.get(P.A_STR)) || 50); return true; }
    function applyStrength(strength) { if (!comp || !makeupGain || !ctx) return; const s = CLAMP(strength, 0, 100) / 100; comp.threshold.value = -10 - s * 22; comp.ratio.value = 2 + s * 10; comp.knee.value = 12 - s * 8; comp.attack.value = 0.003 + (1 - s) * 0.012; comp.release.value = 0.10 + (1 - s) * 0.15; const threshAbs = Math.abs(comp.threshold.value); const makeupDb = threshAbs * (1 - 1 / comp.ratio.value) * 0.4; const gain = Math.pow(10, makeupDb / 20); try { makeupGain.gain.setTargetAtTime(CLAMP(gain, 1, 4), ctx.currentTime, 0.05); } catch (_) { makeupGain.gain.value = CLAMP(gain, 1, 4); } }
    function enterBypass(video, reason) { if (bypassMode) return; bypassMode = true; currentMode = 'bypass'; if (video && ctx && currentSrc) { try { currentSrc.disconnect(); } catch (_) {} if (currentSrc.__vsc_isCaptureStream) { if (video.muted && currentSrc.__vsc_originalMuted === false) try { video.muted = false; } catch (_) {} if (currentSrc.__vsc_originalVolume != null) try { video.volume = currentSrc.__vsc_originalVolume; } catch (_) {} const stream = currentSrc.__vsc_captureStream; if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); } else { try { currentSrc.connect(ctx.destination); } catch (_) {} } } currentSrc = null; }
    function exitBypass() { if (!bypassMode) return; bypassMode = false; }
    function connectViaCaptureStream(video) { if (!ctx || video.dataset.vscCorsFail === "1") return null; let s = streamMap.get(video); if (s) { if (s.context === ctx) return s; if (currentSrc === s) { currentSrc = null; currentMode = 'none'; } try { s.disconnect(); } catch (_) {} if (s.__vsc_captureStream) { s.__vsc_captureStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); } streamMap.delete(video); } const captureFn = video.captureStream || video.mozCaptureStream; if (typeof captureFn !== 'function') return null; const originalMuted = video.muted, originalVolume = video.volume; let stream; try { stream = captureFn.call(video); } catch (e) { if (e.name === 'SecurityError' || e.message?.includes('cross-origin')) { video.dataset.vscCorsFail = "1"; return null; } return null; } if (stream.getAudioTracks().length === 0) { setTimeout(() => { if (stream.getAudioTracks().length > 0) scheduler.request(); }, 500); return null; } try { const source = ctx.createMediaStreamSource(stream); source.__vsc_isCaptureStream = true; source.__vsc_captureStream = stream; source.__vsc_originalMuted = originalMuted; source.__vsc_originalVolume = originalVolume; video.muted = true; streamMap.set(video, source); return source; } catch (e) { stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); return null; } }
    function connectViaMES(video) { if (!ctx || video.dataset.vscMesFail === "1") return null; let s = mesMap.get(video); if (s) { if (s.context === ctx) return s; mesMap.delete(video); return null; } try { s = ctx.createMediaElementSource(video); mesMap.set(video, s); return s; } catch (e) { return null; } }
    function connectSource(video) { if (!video || !ctx) return false; if (!canConnect(video)) { enterBypass(video, 'pre-check'); return false; } const isJW = detectJWPlayer(video); let source = null; if (isJW) { source = connectViaCaptureStream(video); if (!source) { video.dataset.vscPermBypass = "1"; enterBypass(video, 'JW fail'); return false; } } else { source = connectViaMES(video); if (!source) { video.dataset.vscMesFail = "1"; source = connectViaCaptureStream(video); if (!source) { enterBypass(video, 'all fail'); return false; } } } try { source.disconnect(); } catch (_) {} const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT)); source.connect(enabled ? comp : dryPath); currentSrc = source; currentMode = source.__vsc_isCaptureStream ? 'stream' : 'mes'; exitBypass(); return true; }
    function fadeOutThen(gen, fn) { if (!ctx || !masterOut || ctx.state === 'closed') { if (gen === generation) try { fn(); } catch (_) {} return; } try { const t = ctx.currentTime; masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + 0.04); } catch (_) { try { masterOut.gain.value = 0; } catch (__) {} } setTimeout(() => { if (gen !== generation) return; try { fn(); } catch (_) {} if (ctx && masterOut && ctx.state !== 'closed') { try { const t2 = ctx.currentTime; masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04); } catch (_) { try { masterOut.gain.value = 1; } catch (__) {} } } }, 60); }
    function disconnectCurrent(vid) { if (!currentSrc) return; const target = vid || targetVideo; if (currentSrc.__vsc_isCaptureStream && target) { if (target.muted && currentSrc.__vsc_originalMuted === false) try { target.muted = false; } catch (_) {} if (currentSrc.__vsc_originalVolume != null) try { target.volume = currentSrc.__vsc_originalVolume; } catch (_) {} const stream = currentSrc.__vsc_captureStream; if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); streamMap.delete(target); } try { currentSrc.disconnect(); } catch (_) {} if (!currentSrc.__vsc_isCaptureStream && ctx && ctx.state !== 'closed') { try { currentSrc.connect(ctx.destination); } catch (_) {} } currentSrc = null; currentMode = 'none'; }
    function updateMix() { if (!ctx || bypassMode) return; const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT)); if (enabled && currentSrc) { try { currentSrc.disconnect(); } catch (_) {} currentSrc.connect(comp); applyStrength(Number(store.get(P.A_STR)) || 50); } else if (currentSrc) { try { currentSrc.disconnect(); } catch (_) {} currentSrc.connect(dryPath); } }
    function setTarget(video) { if (video === targetVideo) { if (bypassMode) { if (!canConnect(video)) return; exitBypass(); if (connectSource(video)) { updateMix(); return; } return; } if (currentSrc) { updateMix(); return; } if (canConnect(video)) { if (!initCtx()) return; if (connectSource(video)) updateMix(); } return; } const gen = ++generation; const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT)); if (!enabled) { const oldTarget = targetVideo; if (currentSrc || targetVideo) { fadeOutThen(gen, () => { disconnectCurrent(oldTarget); targetVideo = video; if (bypassMode) { bypassMode = false; currentMode = 'none'; } }); } else { targetVideo = video; if (bypassMode) { bypassMode = false; currentMode = 'none'; } } return; } if (!initCtx()) { targetVideo = video; return; } if (video && !canConnect(video)) { const oldTarget = targetVideo; fadeOutThen(gen, () => { disconnectCurrent(oldTarget); targetVideo = video; if (!bypassMode) { bypassMode = true; currentMode = 'bypass'; } }); return; } const oldTarget = targetVideo; fadeOutThen(gen, () => { disconnectCurrent(oldTarget); if (bypassMode) { bypassMode = false; currentMode = 'none'; } targetVideo = video; if (!video) { updateMix(); return; } connectSource(video); updateMix(); }); }
    let gestureHooked = false; const onGesture = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); if (ctx?.state === 'running' && gestureHooked) { for (const evt of ['pointerdown','keydown','click']) window.removeEventListener(evt, onGesture, true); gestureHooked = false; } }; function ensureGestureHook() { if (gestureHooked) return; gestureHooked = true; for (const evt of ['pointerdown','keydown','click']) window.addEventListener(evt, onGesture, { passive: true, capture: true }); } ensureGestureHook(); document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx?.state === 'suspended') ctx.resume().catch(() => {}); }, { passive: true });
    return { setTarget, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!(currentSrc || bypassMode), isBypassed: () => bypassMode };
  }

  function createFilters() {
    const ctxMap = new WeakMap();
    const toneCache = new Map();
    const appliedFilter = new WeakMap();
    const TONE_CACHE_MAX = 32;

    /* ── [v28.9.4] Clarity 효과 범위 및 강도 최적화 적용 ── */
    function getToneTable(steps, gain, contrast, gamma, toe, mid, shoulder, highRoll, clarity) {
      const hr = highRoll || 0;
      const cl = clarity || 0;
      const key = `${steps}|${Math.round(gain*100)}|${Math.round(contrast*100)}|${Math.round(gamma*100)}|t${Math.round(toe*1000)}|m${Math.round(mid*1000)}|s${Math.round(shoulder*1000)}|h${Math.round(hr*1000)}|c${Math.round(cl*1000)}`;
      if (toneCache.has(key)) { const val = toneCache.get(key); toneCache.delete(key); toneCache.set(key, val); return val; }
      const ev = Math.log2(Math.max(1e-6, gain));
      const g = ev * 0.90; const useFilmicCurve = Math.abs(g) > 0.01; const denom = useFilmicCurve ? (1 - Math.exp(-g)) : 1;
      const out = new Array(steps); let prev = 0; const intercept = 0.5 * (1 - contrast);
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1);
        let x = useFilmicCurve ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = x * contrast + intercept; x = CLAMP(x, 0, 1);
        if (toe > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toe * (1 - t) * (t * t) * (1 - x); }
        if (mid > 0.001) {
          const mc = 0.45, sig = 0.18;
          const mw = Math.exp(-((x0 - mc) ** 2) / (2 * sig * sig));
          const delta = (x0 - mc) * mid * mw * 1.5;
          const appliedDelta = delta > 0 ? delta : delta * 0.15;
          x = CLAMP(x + appliedDelta, 0, 1);
        }
        if (shoulder > 0.001) { const hw = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = CLAMP(x + shoulder * 0.6 * x0 + shoulder * hw * hw * 0.5 * (1 - x), 0, 1); }

        if (hr > 0.001 && x0 > 0.55) {
          const rollStart = 0.55;
          const t = (x0 - rollStart) / (1.0 - rollStart);
          const rollAmount = hr * t * t * 0.35;
          x = CLAMP(x - rollAmount * x, 0, 1);
        }

        /* ── v28.9.4: S커브 작용 범위(cSigma: 0.25) 및 강도(2.8) 확대 ── */
        if (cl > 0.001) {
          const cCenter = 0.50;
          const cSigma = 0.25;
          const cw = Math.exp(-((x0 - cCenter) ** 2) / (2 * cSigma * cSigma));
          const deviation = (x0 - cCenter);
          const sDelta = cl * deviation * cw * 2.8;
          x = CLAMP(x + sDelta, 0, 1);
        }

        if (Math.abs(gamma - 1) > 0.001) x = Math.pow(x, gamma);
        if (x < prev) x = prev; prev = x; out[i] = (x).toFixed(4);
      }
      const res = out.join(' ');
      if (toneCache.size >= TONE_CACHE_MAX) { const first = toneCache.keys().next(); if (!first.done) toneCache.delete(first.value); }
      toneCache.set(key, res); return res;
    }

    function mkXfer(attrs, funcDefaults, withAlpha = false) {
      const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs });
      const channels = ['R', 'G', 'B']; if (withAlpha) channels.push('A');
      for (const ch of channels) { const fa = { ns: 'svg' }; if (ch === 'A') fa.type = 'identity'; else { for (const [k, v] of Object.entries(funcDefaults)) fa[k] = v; } xfer.append(h(`feFunc${ch}`, fa)); }
      return xfer;
    }

    function buildSvg(root) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
      const defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const fid = `vsc-f-${VSC_ID}`;
      const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
      const fTone = mkXfer({ in: 'SourceGraphic', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
      const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' }, true);
      const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'tmp', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
      const fSat = h('feColorMatrix', { ns: 'svg', in: 'conv', type: 'saturate', values: '1.0', result: 'final' });
      filter.append(fTone, fTemp, fConv, fSat); defs.append(filter);
      const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
      if (target?.appendChild) target.appendChild(svg);
      const toneFuncR = fTone.querySelector('feFuncR'), toneFuncG = fTone.querySelector('feFuncG'), toneFuncB = fTone.querySelector('feFuncB');
      return { fid, svg, fConv, toneFuncsRGB: [toneFuncR, toneFuncG, toneFuncB].filter(Boolean), tempFuncR: fTemp.querySelector('feFuncR'), tempFuncG: fTemp.querySelector('feFuncG'), tempFuncB: fTemp.querySelector('feFuncB'), fSat, st: { lastKey: '', toneKey: '', sharpKey: '', tempKey: '' } };
    }

    function purge(root) { const ctx = ctxMap.get(root); if (ctx) { try { ctx.svg.remove(); } catch (_) {} ctxMap.delete(root); } }

    function prepare(video, s) {
      if (!s._needsSvg) {
        if (video) { const root = (video.getRootNode?.() instanceof ShadowRoot) ? video.getRootNode() : (video.ownerDocument || document); if (ctxMap.has(root)) purge(root); }
        const parts = [];
        if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
        if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
        if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
        return parts.length > 0 ? parts.join(' ') : 'none';
      }
      const root = (video.getRootNode?.() instanceof ShadowRoot) ? video.getRootNode() : (video.ownerDocument || document);
      let ctx = ctxMap.get(root);
      if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
      else if (!ctx.svg.isConnected) { const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root); if (target?.appendChild) target.appendChild(ctx.svg); }
      const st = ctx.st;
      const svgHash = `${(s.sharp||0).toFixed(3)}|${(s.toe||0).toFixed(3)}|${(s.mid||0).toFixed(3)}|${(s.shoulder||0).toFixed(3)}|${(s.gain||1).toFixed(3)}|${(s.gamma||1).toFixed(3)}|${(s.contrast||1).toFixed(3)}|${s.temp||0}|${s.tint||0}|${(s._cssSat||1).toFixed(3)}|${(s.highRoll||0).toFixed(3)}|${(s.clarity||0).toFixed(3)}`;

      if (st.lastKey !== svgHash) {
        st.lastKey = svgHash;
        const toneTable = getToneTable(256, s.gain || 1, s.contrast || 1, 1 / CLAMP(s.gamma || 1, 0.1, 5), s.toe || 0, s.mid || 0, s.shoulder || 0, s.highRoll || 0, s.clarity || 0);
        if (st.toneKey !== toneTable) { st.toneKey = toneTable; for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable); }
        const colorGain = tempTintToRgbGain(s.temp, s.tint);
        const tempTintKey = `${s.temp}|${s.tint}`;
        if (st.tempKey !== tempTintKey) { st.tempKey = tempTintKey; ctx.tempFuncR.setAttribute('slope', colorGain.rs); ctx.tempFuncG.setAttribute('slope', colorGain.gs); ctx.tempFuncB.setAttribute('slope', colorGain.bs); }

        let desatMul = 1;
        if (!IS_FIREFOX) {
          const totalS = CLAMP(Number(s.sharp || 0), 0, SHARP_CAP);
          let kernelStr = '0,0,0, 0,1,0, 0,0,0';
          if (totalS >= 0.005) { const edge = -totalS; const diag = edge * 0.707; const center = 1 - 4 * edge - 4 * diag; kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`; }
          if (st.sharpKey !== kernelStr) { st.sharpKey = kernelStr; ctx.fConv.setAttribute('kernelMatrix', kernelStr); ctx.fConv.setAttribute('divisor', '1'); }
          desatMul = totalS > 0.008 ? CLAMP(1 - totalS * 0.1, 0.90, 1) : 1;
        }
        const satVal = CLAMP(s._cssSat * desatMul, 0.4, 1.8).toFixed(3);
        ctx.fSat.setAttribute('values', satVal);
      }
      return `url(#${ctx.fid})`;
    }

    return {
      prepare,
      apply: (el, filterStr) => { if (!el) return; if (filterStr === 'none') { if (appliedFilter.get(el) === 'none') return; clearFilterStyles(el); appliedFilter.set(el, 'none'); return; } if (appliedFilter.get(el) === filterStr) return; applyFilterStyles(el, filterStr); appliedFilter.set(el, filterStr); },
      clear: (el) => { clearFilterStyles(el); appliedFilter.delete(el); },
      purge
    };
  }

  function createVideoParams(Store) {
    const cache = new WeakMap();
    function computeSharpMul(video) {
      const nW = video.videoWidth | 0; let dW = video.clientWidth, dH = video.clientHeight;
      if (!dW || !dH) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };
      const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);
      if (dW < 16) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };
      const nH = video.videoHeight | 0; const ratioW = (dW * dpr) / nW; const ratioH = (nH > 16 && dH > 16) ? (dH * dpr) / nH : ratioW; const ratio = Math.min(ratioW, ratioH);
      let mul = ratio <= 0.30 ? 0.40 : ratio <= 0.60 ? 0.40 + (ratio - 0.30) / 0.30 * 0.30 : ratio <= 1.00 ? 0.70 + (ratio - 0.60) / 0.40 * 0.30 : ratio <= 1.80 ? 1.00 : ratio <= 4.00 ? 1.00 - (ratio - 1.80) / 2.20 * 0.30 : 0.65;
      let rawAutoBase = nW <= 640 ? 0.18 : nW <= 960 ? 0.14 : nW <= 1280 ? 0.13 : nW <= 1920 ? 0.12 : 0.07;
      if (IS_MOBILE) mul = Math.max(mul, 0.60);
      return { mul: CLAMP(mul, 0, 1), autoBase: CLAMP(rawAutoBase * mul, 0, 0.18), rawAutoBase };
    }
    return {
      get: (video) => {
        const storeRev = Store.rev(); const nW = video ? (video.videoWidth | 0) : 0; const dW = video ? (video.clientWidth || 0) : 0; const dH = video ? (video.clientHeight || 0) : 0; const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);
        if (video && nW >= 16) { const cached = cache.get(video); if (cached && cached.rev === storeRev && cached.nW === nW && cached.dW === dW && cached.dH === dH && cached.dpr === dpr) return cached.out; }
        const out = { gain: 1, gamma: 1, contrast: 1, toe: 0, mid: 0, shoulder: 0, temp: 0, tint: 0, sharp: 0, highRoll: 0, clarity: 0, _cssBr: 1, _cssCt: 1, _cssSat: 1, _needsSvg: false };
        const presetS = Store.get(P.V_PRE_S); const mix = CLAMP(Number(Store.get(P.V_PRE_MIX)) || 1, 0, 1);
        const { mul, autoBase, rawAutoBase } = video ? computeSharpMul(video) : { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };
        const platformScale = IS_MOBILE ? 0.65 : 1.0; const finalMul = ((mul === 0 && presetS !== 'off') ? 0.50 : mul) * platformScale;
        if (presetS === 'off') { out.sharp = autoBase * platformScale; }
        else if (presetS !== 'none') { const resFactor = CLAMP(rawAutoBase / 0.12, 0.58, 1.50); out.sharp = (_PRESET_SHARP_LUT[presetS] || 0) * mix * finalMul * resFactor; }
        out.sharp = CLAMP(out.sharp, 0, SHARP_CAP); if (IS_FIREFOX) out.sharp = 0;

        const mShad = CLAMP(Number(Store.get(P.V_MAN_SHAD) ?? 0), 0, 100);
        const mRec = CLAMP(Number(Store.get(P.V_MAN_REC) ?? 0), 0, 100);
        const mBrt = CLAMP(Number(Store.get(P.V_MAN_BRT) ?? 0), 0, 100);
        const mTemp = CLAMP(Number(Store.get(P.V_MAN_TEMP) ?? 0), -50, 50);
        const mTint = CLAMP(Number(Store.get(P.V_MAN_TINT) ?? 0), -50, 50);
        const mSat = CLAMP(Number(Store.get(P.V_MAN_SAT) ?? 0), -50, 50);
        const mGamma = CLAMP(Number(Store.get(P.V_MAN_GAMMA) ?? 0), -30, 30);
        const mCon = CLAMP(Number(Store.get(P.V_MAN_CON) ?? 0), -30, 30);
        const mGain = CLAMP(Number(Store.get(P.V_MAN_GAIN) ?? 0), -30, 30);
        const mClarity = CLAMP(Number(Store.get(P.V_MAN_CLARITY) ?? 0), 0, 50);
        const mHighRoll = CLAMP(Number(Store.get(P.V_MAN_HIGHROLL) ?? 0), 0, 50);

        out.toe = mShad * 0.0040; out.mid = mRec * 0.0035; out.shoulder = mBrt * 0.0045;
        out.temp = mTemp; out.tint = mTint;
        out.gamma = 1 + mGamma * (-0.008); out.contrast = 1 + mCon * 0.008;
        out.gain = Math.pow(2, mGain * 0.03);
        out.clarity = mClarity * 0.02;
        out.highRoll = mHighRoll * 0.02;

        out._needsSvg = checkNeedsSvg(out);
        if (out._needsSvg) { out._cssBr = 1.0; out._cssCt = 1.0; }
        else { out._cssBr = 1 + (mBrt * 0.003); out._cssCt = 1 + (mRec * 0.003); }
        out._cssSat = CLAMP(1 + mSat * 0.012, 0.4, 1.8);
        if (video && nW >= 16) cache.set(video, { rev: storeRev, nW, dW, dH, dpr, out });
        return out;
      }
    };
  }

  function createOSD() {
    let el = null, timerId = 0;
    return { show: (text, ms = 1200) => { if (!document.body) return; const root = document.fullscreenElement || document.documentElement || document.body; if (!el || el.parentNode !== root) { el?.remove(); el = document.createElement('div'); el.id = 'vsc-osd'; el.setAttribute('data-vsc-ui', '1'); el.style.cssText = 'position:fixed!important;top:48px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(12,12,18,0.85)!important;backdrop-filter:blur(24px) saturate(200%)!important;color:rgba(255,255,255,0.95)!important;padding:10px 28px!important;border-radius:14px!important;border:1px solid rgba(0,229,255,0.15)!important;font:600 13px/1.4 system-ui,sans-serif!important;z-index:2147483647!important;pointer-events:none!important;opacity:0!important;transition:opacity 0.2s,transform 0.3s!important;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.08)!important;text-align:center!important;'; root.appendChild(el); } el.textContent = text; requestAnimationFrame(() => { el.style.setProperty('opacity', '1', 'important'); }); clearTimeout(timerId); timerId = setTimeout(() => { if (el) el.style.setProperty('opacity', '0', 'important'); }, ms); } };
  }

  function createAutoScene(store, scheduler) {
    let lastCheck = 0, currentBrightness = -1;
    let currentLabel = '분석 대기중', currentValues = new Array(MANUAL_KEYS.length).fill(0);
    let currentPresetS = null, currentMode = 'wait', _internalBatch = false;
    let lastAppliedBrightness = -999;
    const CHECK_INTERVAL = 500; const STALE_THRESHOLD = 10000;
    const canvas = document.createElement('canvas'); const canvasCtx = canvas.getContext('2d', { willReadFrequently: true }); canvas.width = 16; canvas.height = 16;
    const brightHistory = []; let _brightSum = 0; const HISTORY_SIZE = 8;
    const _videoAnalyzeState = new WeakMap();
    function getAnalyzeState(v) { if (!_videoAnalyzeState.has(v)) _videoAnalyzeState.set(v, { blackCount: 0, drmRetry: 0, lastNonBlackTime: 0 }); return _videoAnalyzeState.get(v); }
    let _lastTickVideo = null;

    const BASE     = [ 20, 15,  8,  0, 0, -1, -1,  0,  4,   0,   0 ];
    const DARK_V   = [ 50, 30, 20,  0, 0, -4, -4,  0, 11,   0,   0 ];
    const BRIGHT_V = [ 10, 10,  5,  0, 0,  0, -2,  0,  2,  20,  15 ];
    const VERTICAL = [ 15, 13,  0,  0, 0, -1, -1,  0,  3,   0,   0 ];
    const DRM_BASE = [ 20, 15,  8,  0, 0, -1, -1,  0,  4,   0,   0 ];
    const DARK_BOOST = DARK_V.map((v, i) => v - BASE[i]);
    const BRIGHT_CUT = BRIGHT_V.map((v, i) => v - BASE[i]);
    const BRIGHT_ATTENUATE_IDX = new Set([2, 7, 8]); const ATTENUATE_MID = 128; const ATTENUATE_CEIL = 220;
    const VAL_NAMES = ['암부','복원','노출','색온도','틴트','채도','감마','콘트','게인','선명도','하이롤'];
    const SCENE_CONFIG = { dark: { max: 30, label: '어두운 장면' }, bright: { min: 220, label: '눈부신 장면' }, normal: { label: '일반 영상' }, drm: { label: '보안 영상 ◉ DRM' }, gamma: 2.2, useSmoothstep: true };

    function smoothstep(edge0, edge1, x) { const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); }

    function classifyBrightness(brightness, cfg) { let darkRaw = 0, brightRaw = 0; if (brightness < cfg.dark.max) { darkRaw = cfg.useSmoothstep ? 1 - smoothstep(0, cfg.dark.max, brightness) : 1 - brightness / cfg.dark.max; } if (brightness > cfg.bright.min) { brightRaw = cfg.useSmoothstep ? smoothstep(cfg.bright.min, 255, brightness) : (brightness - cfg.bright.min) / (255 - cfg.bright.min); } const darkFactor = darkRaw > 0 ? Math.pow(darkRaw, 1 / cfg.gamma) : 0; const brightFactor = brightRaw > 0 ? Math.pow(brightRaw, 1 / cfg.gamma) : 0; let label; if (darkFactor > 0) label = `${cfg.dark.label} ◉ 밝기 ${Math.round(brightness)}`; else if (brightFactor > 0) label = `${cfg.bright.label} ◉ 밝기 ${Math.round(brightness)}`; else label = `${cfg.normal.label} ◉ 밝기 ${Math.round(brightness)}`; return { label, darkFactor, brightFactor }; }

    function getBrightnessThreshold(b) { return b < 60 ? 6 : b > 180 ? 8 : 10; }

    /* ── [v28.9.4] 구간 확장된 자동 Clarity & HighRoll 로직 ── */
    function getAutoClarity(frameBrightness) {
      if (frameBrightness <= 80)  return 0;
      if (frameBrightness <= 120) return Math.round((frameBrightness - 80) / 40 * 18);
      if (frameBrightness <= 180) return Math.round(18 + (frameBrightness - 120) / 60 * 14);
      if (frameBrightness <= 220) return Math.round(32 + (frameBrightness - 180) / 40 * 8);
      return Math.round(40 + Math.min(frameBrightness - 220, 35) / 35 * 10);
    }

    function getAutoHighRoll(frameBrightness) {
      if (frameBrightness <= 120) return 0;
      if (frameBrightness <= 180) return Math.round((frameBrightness - 120) / 60 * 15);
      if (frameBrightness <= 220) return Math.round(15 + (frameBrightness - 180) / 40 * 10);
      return Math.round(25 + Math.min(frameBrightness - 220, 35) / 35 * 10);
    }

    function interpolate(darkFactor, brightFactor, brightness) {
      const mapped = BASE.map((base, i) => {
        if (darkFactor > 0) return Math.round(base + DARK_BOOST[i] * darkFactor);
        if (brightFactor > 0) return Math.round(base + BRIGHT_CUT[i] * brightFactor);
        if (BRIGHT_ATTENUATE_IDX.has(i) && brightness > ATTENUATE_MID) {
          const t = (brightness - ATTENUATE_MID) / (ATTENUATE_CEIL - ATTENUATE_MID);
          const scale = Math.max(0.3, 1.0 - CLAMP(t, 0, 1) * 0.7);
          return Math.round(base * scale);
        }
        return base;
      });

      mapped[9] = Math.max(mapped[9], getAutoClarity(brightness));
      mapped[10] = Math.max(mapped[10], getAutoHighRoll(brightness));

      return mapped;
    }

    function getPresetSByFactors(darkFactor, brightFactor) { if (darkFactor > 0.5) return 'M'; if (darkFactor > 0.1) return 'S'; if (brightFactor > 0.3) return 'none'; if (brightFactor > 0) return 'off'; return 'off'; }
    function pushBrightness(raw) { if (brightHistory.length >= HISTORY_SIZE) _brightSum -= brightHistory.shift(); brightHistory.push(raw); _brightSum += raw; return _brightSum / brightHistory.length; }
    function analyzeFrame(video) { if (!video || video.readyState < 2 || video.dataset.vscCorsFail === "1") return -1; const vs = getAnalyzeState(video); if (video.dataset.vscDrm === "1") { vs.drmRetry++; if (vs.drmRetry < 10) return -1; vs.drmRetry = 0; } try { canvasCtx.drawImage(video, 0, 0, 16, 16); const data = canvasCtx.getImageData(0, 0, 16, 16).data; let r = 0, g = 0, b = 0, totalWeight = 0, isAllZero = true; for (let i = 0; i < data.length; i += 4) { const row = (i >> 2) >> 4; const yWeight = row >= 13 ? 0.3 : 1.0; r += data[i] * yWeight; g += data[i+1] * yWeight; b += data[i+2] * yWeight; totalWeight += yWeight; if (data[i] > 0 || data[i+1] > 0 || data[i+2] > 0) isAllZero = false; } if (isAllZero) { vs.blackCount++; const timeProgressing = video.currentTime > 0 && !video.paused && !video.ended; const recentlyHadContent = (performance.now() - vs.lastNonBlackTime) < 15000; if (vs.blackCount >= 12 && !(timeProgressing && recentlyHadContent)) { video.dataset.vscDrm = "1"; } return -1; } vs.blackCount = 0; vs.lastNonBlackTime = performance.now(); if (video.dataset.vscDrm === "1") { delete video.dataset.vscDrm; vs.drmRetry = 0; log.info('[AutoScene] DRM 플래그 해제'); } return (r/totalWeight)*0.2126 + (g/totalWeight)*0.7152 + (b/totalWeight)*0.0722; } catch (e) { video.dataset.vscCorsFail = "1"; return -1; } }
    function buildDetailText() { const active = currentValues.map((val, i) => val !== 0 ? `${VAL_NAMES[i]}${val > 0 ? '+' : ''}${val}` : null).filter(Boolean); const sharpLabel = currentPresetS != null ? (currentPresetS === 'none' ? '샤프닝:OFF' : currentPresetS === 'off' ? '샤프닝:AUTO' : `샤프닝:${PRESETS.detail[currentPresetS]?.label || currentPresetS}`) : ''; const parts = []; if (sharpLabel) parts.push(sharpLabel); if (active.length > 0) parts.push(active.join(' · ')); return parts.join(' │ ') || '보정 없음'; }
    function applyValues(values, presetS) { _internalBatch = true; const obj = {}; for (let i = 0; i < MANUAL_KEYS.length; i++) obj[MANUAL_KEYS[i]] = values[i]; if (presetS != null) obj.presetS = presetS; store.batch('video', obj); _internalBatch = false; currentValues = values; currentPresetS = presetS; }
    function applyZeroValues() { _internalBatch = true; const zeros = {}; for (const k of MANUAL_KEYS) zeros[k] = 0; zeros.presetS = 'off'; store.batch('video', zeros); _internalBatch = false; currentValues = new Array(MANUAL_KEYS.length).fill(0); currentPresetS = 'off'; }
    function onManualChange() { if (_internalBatch) return; if (!store.get(P.V_AUTO_SCENE)) return; store.set(P.V_AUTO_SCENE, false); deactivate(false); log.info('[AutoScene] 수동 조작 감지 → OFF'); }
    const _subCleanups = []; for (const path of MANUAL_PATHS) _subCleanups.push(store.sub(path, onManualChange));

    function tick(video) {
      if (!store.get(P.V_AUTO_SCENE)) return; if (!video?.isConnected) return;
      if (video !== _lastTickVideo) { _lastTickVideo = video; brightHistory.length = 0; _brightSum = 0; lastAppliedBrightness = -999; currentMode = 'wait'; }
      const now = performance.now(); if (now - lastCheck < CHECK_INTERVAL) return;
      if (now - lastCheck > STALE_THRESHOLD) { brightHistory.length = 0; _brightSum = 0; lastAppliedBrightness = -999; }
      lastCheck = now; if (video.paused || video.ended) return;
      const _vw = video.videoWidth || 0, _vh = video.videoHeight || 0;
      if (_vw > 0 && _vh > 0 && (_vw / _vh) < 0.75) { if (currentMode !== 'vertical') { currentMode = 'vertical'; currentBrightness = -1; lastAppliedBrightness = -999; currentLabel = '세로형 영상'; applyValues(VERTICAL, 'S'); } return; }
      const rawBrt = analyzeFrame(video);
      if (rawBrt < 0) { if (currentMode !== 'drm') { currentMode = 'drm'; currentBrightness = -1; lastAppliedBrightness = -999; currentLabel = SCENE_CONFIG.drm.label; applyValues(DRM_BASE, 'M'); } return; }
      if (currentMode === 'drm') { currentMode = 'wait'; lastAppliedBrightness = -999; brightHistory.length = 0; _brightSum = 0; }
      const smoothed = pushBrightness(rawBrt); currentBrightness = smoothed;
      const smoothScene = classifyBrightness(smoothed, SCENE_CONFIG); currentLabel = smoothScene.label;
      const threshold = getBrightnessThreshold(smoothed); const delta = Math.abs(smoothed - lastAppliedBrightness);
      if (currentMode === 'interpolate' && delta < threshold) return;
      currentMode = 'interpolate';
      const values = interpolate(smoothScene.darkFactor, smoothScene.brightFactor, smoothed);
      const presetS = getPresetSByFactors(smoothScene.darkFactor, smoothScene.brightFactor);
      const changed = values.some((v, i) => v !== currentValues[i]) || presetS !== currentPresetS;
      if (changed) { applyValues(values, presetS); lastAppliedBrightness = smoothed; } else { lastAppliedBrightness = smoothed; }
    }

    function resetAutoState() { currentMode = 'wait'; currentBrightness = -1; currentLabel = '분석 대기중'; brightHistory.length = 0; _brightSum = 0; lastAppliedBrightness = -999; _lastTickVideo = null; }
    function activate() { resetAutoState(); currentValues = new Array(MANUAL_KEYS.length).fill(0); currentPresetS = null; lastCheck = performance.now() - CHECK_INTERVAL - 1; scheduler.request(true); }
    function deactivate(resetValues = true) { resetAutoState(); if (resetValues) applyZeroValues(); }
    function destroy() { for (const unsub of _subCleanups) unsub(); _subCleanups.length = 0; }
    return { tick, activate, deactivate, destroy, getLabel: () => currentLabel, getDetail: () => buildDetailText(), getBrightness: () => currentBrightness, getMode: () => currentMode };
  }

  /* ══ createUI ══ */
  function createUI(Store, Audio, Registry, Scheduler, OSD, AutoScene, Filters) {
    let panelHost = null, panelEl = null, quickBarHost = null;
    let activeTab = 'video', panelOpen = false;
    let _shadow = null, _qbarShadow = null;
    const tabFns = []; const tabSignalCleanups = []; const globalSignalCleanups = [];
    const TAB_ICONS = { video: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, h('rect', { ns: 'svg', x: 2, y: 4, width: 16, height: 16, rx: 2 }), h('path', { ns: 'svg', d: 'M22 7l-6 4 6 4z' })), audio: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, h('path', { ns: 'svg', d: 'M11 5L6 9H2v6h4l5 4V5z' }), h('path', { ns: 'svg', d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })), playback: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, h('circle', { ns: 'svg', cx: '12', cy: '12', r: '10' }), h('polygon', { ns: 'svg', points: '10 8 16 12 10 16' })) };
    const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생' };
    const CSS_VARS = `:host { position: fixed !important; contain: none !important; overflow: visible !important; isolation: isolate; z-index: 2147483647 !important; --vsc-glass: rgba(12, 12, 18, 0.72); --vsc-glass-blur: blur(24px) saturate(200%); --vsc-glass-border: rgba(255, 255, 255, 0.06); --vsc-neon: #00e5ff; --vsc-neon-glow: 0 0 12px rgba(0, 229, 255, 0.35), 0 0 40px rgba(0, 229, 255, 0.08); --vsc-neon-soft: rgba(0, 229, 255, 0.15); --vsc-neon-border: rgba(0, 229, 255, 0.25); --vsc-neon-dim: rgba(0, 229, 255, 0.08); --vsc-purple: #b47aff; --vsc-amber: #ffbe46; --vsc-green: #4cff8e; --vsc-text: rgba(255, 255, 255, 0.92); --vsc-text-dim: rgba(255, 255, 255, 0.50); --vsc-text-muted: rgba(255, 255, 255, 0.28); --vsc-shadow-panel: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset; --vsc-shadow-fab: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04); --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px; --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace; --vsc-font-sm: 11px; --vsc-font-md: 13px; --vsc-font-xxl: 32px; --vsc-touch-min: ${IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${IS_MOBILE ? '6px' : '10px'}; --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); font-family: var(--vsc-font) !important; font-size: var(--vsc-font-md) !important; color: var(--vsc-text) !important; -webkit-font-smoothing: antialiased; }`;
    const PANEL_CSS = `${CSS_VARS} *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; } .panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px) !important; top: 50% !important; width: var(--vsc-panel-width) !important; max-height: var(--vsc-panel-max-h) !important; background: var(--vsc-glass) !important; border: 1px solid var(--vsc-glass-border) !important; border-radius: var(--vsc-radius-xl) !important; backdrop-filter: var(--vsc-glass-blur) !important; -webkit-backdrop-filter: var(--vsc-glass-blur) !important; box-shadow: var(--vsc-shadow-panel) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; user-select: none !important; opacity: 0 !important; transform: translate(16px, -50%) scale(0.92) !important; filter: blur(4px) !important; transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring), filter 0.3s var(--vsc-ease-out) !important; overscroll-behavior: none !important; } .panel.open { opacity: 1 !important; transform: translate(0, -50%) scale(1) !important; filter: blur(0) !important; pointer-events: auto !important; } .panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; } .hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 10px; } .hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; } .tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.04); position: relative; padding: 0 4px; } .tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); } .tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; text-transform: uppercase; } .tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; stroke: currentColor; } .tab:hover { opacity: 0.65; } .tab.on { opacity: 1; color: var(--vsc-neon); } .tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0,229,255,0.4)); stroke: var(--vsc-neon); } .body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0,229,255,0.15) transparent; text-align: left; overscroll-behavior: none; -webkit-overflow-scrolling: touch; } .body::-webkit-scrollbar { width: 4px; } .body::-webkit-scrollbar-thumb { background: rgba(0,229,255,0.2); border-radius: 2px; } .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); } .row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; } .row .ctrl { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: flex-end; } input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; margin: 0; } input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255,255,255,0.08) var(--fill, 50%)); } input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0,0,0,0.3); box-shadow: 0 0 8px rgba(0,229,255,0.4); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); } .val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); } .tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255,255,255,0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.06); } .tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0,229,255,0.2); } .tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255,255,255,0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; } .tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.6); } .btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-weight: 500; } .btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.12); } .chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; } .chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: 11px; font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255,255,255,0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; } .chip:hover { background: rgba(255,255,255,0.07); } .chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.1); } .sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 8px 0; } .rate-display { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xxl); font-weight: 800; text-align: center; padding: 8px 0; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0,229,255,0.2)); } .fine-row { display: flex; gap: 4px; justify-content: center; padding: 4px 0; } .fine-btn { padding: 2px 4px; min-height: 24px; min-width: 32px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); } .fine-btn:hover { background: rgba(255,255,255,0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); } .fine-btn.active { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); } .info-bar { font-family: var(--vsc-font-mono); font-size: 12px; opacity: 0.8; padding: 4px 0 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: var(--vsc-neon); text-align: left; } .section-label { font-size: 11px; opacity: 0.5; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; padding: 6px 0 2px; } .preset-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; } .preset-grid .fine-btn { flex: 0 0 calc(20% - 3.2px); min-width: 0; text-align: center; justify-content: center; display: inline-flex; align-items: center; padding: 4px 2px; font-size: 10px; } .as-box { display: flex; flex-direction: column; padding: 8px 10px; border-radius: var(--vsc-radius-md); background: rgba(76,255,142,0.04); border: 1px solid rgba(76,255,142,0.12); margin-bottom: 6px; gap: 4px; } .as-box.off { background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.06); } .as-top { display: flex; align-items: center; gap: 8px; width: 100%; } .as-top .asl { font-size: 11px; font-weight: 600; color: var(--vsc-green); } .as-box.off .as-top .asl { color: var(--vsc-text-dim); } .as-tag { font-family: var(--vsc-font-mono); font-size: 10px; padding: 2px 8px; border-radius: var(--vsc-radius-sm); background: rgba(76,255,142,0.1); color: var(--vsc-green); border: 1px solid rgba(76,255,142,0.2); white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; } .as-box.off .as-tag { background: rgba(255,255,255,0.04); color: var(--vsc-text-muted); border-color: rgba(255,255,255,0.06); } .as-detail { font-family: var(--vsc-font-mono); font-size: 10px; line-height: 1.5; opacity: 0.65; color: var(--vsc-green); word-break: break-all; } .as-box.off .as-detail { color: var(--vsc-text-muted); } .hint { font-size: 10px; opacity: 0.5; padding: 4px 0; text-align: left; line-height: 1.5; } .hint.warn { opacity: 0.7; color: var(--vsc-amber); } .hint.dim { opacity: 0.4; color: var(--vsc-amber); } @media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } } @media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } }`;

    function getMountTarget() { const fs = document.fullscreenElement || document.webkitFullscreenElement; if (fs) return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs; return document.documentElement || document.body; }
    const HOST_STYLE_BASE = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
    const HOST_STYLE_NORMAL = HOST_STYLE_BASE + 'width:0!important;height:0!important;';
    const HOST_STYLE_FS = HOST_STYLE_BASE + 'right:0!important;bottom:0!important;width:100%!important;height:100%!important;';
    let _lastMount = null, _qbarHasVideo = false, _lastIsFs = null;
    function reparent() { if (!quickBarHost) return; const target = getMountTarget(); if (!target) return; const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement); if (target !== _lastMount) { _lastMount = target; if (quickBarHost.parentNode !== target) try { target.appendChild(quickBarHost); } catch (_) {} if (panelHost && panelHost.parentNode !== target) try { target.appendChild(panelHost); } catch (_) {} } if (_lastIsFs !== isFs) { _lastIsFs = isFs; const style = isFs ? HOST_STYLE_FS : HOST_STYLE_NORMAL; quickBarHost.style.cssText = style; if (panelHost) panelHost.style.cssText = style; if (!_qbarHasVideo) quickBarHost.style.setProperty('display', 'none', 'important'); } if (panelHost && panelOpen && panelEl) panelEl.style.pointerEvents = 'auto'; }
    function onFullscreenChange() { reparent(); setTimeout(reparent, 80); setTimeout(reparent, 400); if (!document.fullscreenElement && !document.webkitFullscreenElement) { _lastMount = null; _lastIsFs = null; setTimeout(() => { const root = document.documentElement || document.body; if (quickBarHost?.parentNode !== root) try { root.appendChild(quickBarHost); } catch (_) {} if (panelHost?.parentNode !== root) try { root.appendChild(panelHost); } catch (_) {} reparent(); }, 100); } }
    function updateQuickBarVisibility() { if (!quickBarHost) return; let has = Registry.videos.size > 0; if (!has) try { has = !!document.querySelector('video'); } catch (_) {} if (!has && Registry.shadowRootsLRU) { for (const it of Registry.shadowRootsLRU) { if (it.host?.isConnected && it.root) { try { if (it.root.querySelector('video')) { has = true; break; } } catch (_) {} } } } if (has && !_qbarHasVideo) { _qbarHasVideo = true; quickBarHost.style.removeProperty('display'); } else if (!has && _qbarHasVideo) { _qbarHasVideo = false; quickBarHost.style.setProperty('display', 'none', 'important'); if (panelOpen) togglePanel(false); } }
    function updateTabIndicator(tabBar, tabName) { if (!tabBar) return; const tabs = tabBar.querySelectorAll('.tab'); const idx = ['video','audio','playback'].indexOf(tabName); if (idx < 0) return; const tabEl = tabs[idx]; if (!tabEl) return; requestAnimationFrame(() => { const barRect = tabBar.getBoundingClientRect(); const tabRect = tabEl.getBoundingClientRect(); tabBar.style.setProperty('--tab-indicator-left', `${tabRect.left - barRect.left}px`); tabBar.style.setProperty('--tab-indicator-width', `${tabRect.width}px`); tabs.forEach(t => t.classList.toggle('on', t.dataset.t === tabName)); }); }
    function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
    function mkSep() { return h('div', { class: 'sep' }); }
    function mkSlider(path, min, max, step) { const s = step || ((max - min) / 100); const digits = s >= 1 ? 0 : 2; const inp = h('input', { type: 'range', min, max, step: s }); const valEl = h('span', { class: 'val' }); function updateUI(v) { inp.value = String(v); valEl.textContent = Number(v).toFixed(digits); inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`); } inp.addEventListener('input', () => { const v = parseFloat(inp.value); Store.set(path, v); updateUI(v); }); const sync = () => updateUI(Number(Store.get(path) ?? min)); tabFns.push(sync); sync(); return [inp, valEl]; }
    function mkToggle(path, onChange) { const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' }); function sync() { const on = !!Store.get(path); el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); } el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); else Scheduler.request(); }); tabFns.push(sync); sync(); return el; }
    function mkSliderWithFine(label, path, min, max, step, fineStep) { const [slider, valEl] = mkSlider(path, min, max, step); const mkFine = (d, t) => { const b = h('button', { class: 'fine-btn', style: 'font-size:11px' }, t); b.addEventListener('click', () => { Store.set(path, CLAMP(Math.round((Number(Store.get(path) || 0) + d) * 100) / 100, min, max)); }); return b; }; const resetBtn = h('button', { class: 'fine-btn', style: 'min-width:24px;font-size:10px;opacity:.6' }, '0'); resetBtn.addEventListener('click', () => { Store.set(path, 0); }); return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn))); }
    function mkChipRow(label, path, chips, onSelectOverride) { const wrap = h('div', {}); if (label) wrap.append(h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label)); const row = h('div', { class: 'chips' }); for (const ch of chips) row.appendChild(h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l)); row.addEventListener('click', e => { const chip = e.target.closest('.chip'); if (!chip) return; const val = chip.dataset.v; const parsed = isNaN(Number(val)) ? val : Number(val); if (onSelectOverride) { onSelectOverride(parsed); if (String(Store.get(path)) !== String(parsed)) Store.set(path, parsed); } else { Store.set(path, val); } requestAnimationFrame(() => { for (const c of row.children) c.classList.toggle('on', c.dataset.v === val); }); Scheduler.request(); }); const sync = () => { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); }; wrap.appendChild(row); tabFns.push(sync); sync(); return wrap; }
    function mkFineButtons(path, steps, min, max) { const row = h('div', { class: 'fine-row' }); for (const d of steps) { const btn = h('button', { class: 'fine-btn' }, `${d > 0 ? '+' : ''}${d}`); btn.addEventListener('click', () => { Store.set(path, CLAMP((Number(Store.get(path)) || 1) + d, min, max)); Store.set(P.PB_EN, true); Scheduler.request(); }); row.appendChild(btn); } return row; }
    function buildInfoBar() { const el = h('div', { class: 'info-bar' }); const update = () => { const v = __internal._activeVideo; const p = Store.get(P.V_PRE_S); const lbl = p === 'none' ? 'OFF' : p === 'off' ? 'AUTO' : PRESETS.detail[p]?.label || p; if (!v?.isConnected) { el.textContent = `영상 없음 │ 샤프닝: ${lbl}`; return; } const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0; el.textContent = nW ? `원본 ${nW}×${nH} → 출력 ${dW}×${dH} │ 샤프닝: ${lbl}` : `로딩 대기중... │ 샤프닝: ${lbl}`; }; tabSignalCleanups.push(Scheduler.onSignal(() => { if (panelOpen) update(); })); tabSignalCleanups.push(Store.sub(P.V_PRE_S, () => { if (panelOpen) update(); })); tabFns.push(update); return el; }
    function buildAutoSceneBox() { const box = h('div', { class: 'as-box off' }); const tag = h('span', { class: 'as-tag' }, '—'); const detail = h('div', { class: 'as-detail' }, ''); const tgl = mkToggle(P.V_AUTO_SCENE, (on) => { if (on) { AutoScene.activate(); OSD.show('자동 장면 ON', 800); } else { AutoScene.deactivate(); OSD.show('자동 장면 OFF', 800); } Scheduler.request(); }); box.append(h('div', { class: 'as-top' }, h('span', { class: 'asl' }, '자동 장면'), tag, h('div', { style: 'flex:1' }), tgl), detail); const sync = () => { const on = !!Store.get(P.V_AUTO_SCENE); box.classList.toggle('off', !on); if (!on) { tag.textContent = 'OFF'; detail.textContent = ''; return; } tag.textContent = AutoScene.getLabel(); detail.textContent = AutoScene.getDetail(); }; tabFns.push(sync); tabSignalCleanups.push(Scheduler.onSignal(() => { if (panelOpen) sync(); })); return box; }
    function buildPresetGrid() { const wrap = h('div', {}); wrap.append(h('label', { style: 'font-size:12px;opacity:.8;font-weight:600;display:block;padding:4px 0 2px' }, '수동 보정')); const grid = h('div', { class: 'preset-grid' }); const buttons = MANUAL_PRESETS.map(p => { const btn = h('button', { class: 'fine-btn' }, p.n); btn.addEventListener('click', () => { if (Store.get(P.V_AUTO_SCENE)) { Store.set(P.V_AUTO_SCENE, false); AutoScene.deactivate(false); OSD.show('자동 장면 OFF (수동 프리셋 선택)', 1000); } const obj = { presetS: 'off' }; for (let i = 0; i < MANUAL_KEYS.length; i++) obj[MANUAL_KEYS[i]] = p.v[i]; Store.batch('video', obj); Scheduler.request(); }); grid.appendChild(btn); return { btn, values: p.v }; }); const syncGrid = () => { const current = MANUAL_PATHS.map(p => Store.get(p)); for (const { btn, values } of buttons) { const match = values.every((v, i) => current[i] === v); btn.classList.toggle('active', match); } }; tabFns.push(syncGrid); wrap.append(grid); return wrap; }
    function buildRateDisplay() { const el = h('div', { class: 'rate-display' }); const sync = () => { el.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }; tabFns.push(sync); sync(); return el; }
    function buildAudioStatus() { const el = h('div', { class: 'hint' }, '상태: 대기'); tabSignalCleanups.push(Scheduler.onSignal(() => { if (!panelOpen) return; const hooked = Audio.isHooked(), bypassed = Audio.isBypassed(); el.textContent = !Audio.hasCtx() ? '상태: 대기' : (hooked && !bypassed) ? '상태: 활성 (평준화 처리 중)' : bypassed ? '상태: 바이패스 (원본 출력)' : '상태: 준비 (연결 대기)'; })); return el; }

    const TAB_SCHEMA = {
      video: [
        { type: 'widget', build: buildInfoBar },
        { type: 'widget', build: buildAutoSceneBox },
        { type: 'sep' },
        ...(IS_FIREFOX ? [{ type: 'hint', cls: 'warn', text: '⚠️ Firefox에서는 SVG 기반 샤프닝 및 수동 톤 보정이 지원되지 않습니다.' }] : []),
        { type: 'chips', label: '디테일 프리셋', path: P.V_PRE_S, items: Object.keys(PRESETS.detail).map(k => ({ v: k, l: PRESETS.detail[k].label || k })) },
        { type: 'slider', label: '강도 믹스', path: P.V_PRE_MIX, min: 0, max: 1, step: 0.01 },
        { type: 'sep' },
        { type: 'widget', build: buildPresetGrid },
        { type: 'sep' },
        { type: 'sectionLabel', text: '톤 보정' },
        { type: 'fineSlider', label: '암부 부스트', path: P.V_MAN_SHAD, min: 0, max: 100, step: 1, fine: 5 },
        { type: 'fineSlider', label: '디테일 복원', path: P.V_MAN_REC, min: 0, max: 100, step: 1, fine: 5 },
        { type: 'fineSlider', label: '노출 보정', path: P.V_MAN_BRT, min: 0, max: 100, step: 1, fine: 5 },
        { type: 'fineSlider', label: '노출 게인', path: P.V_MAN_GAIN, min: -30, max: 30, step: 1, fine: 3 },
        { type: 'fineSlider', label: '감마', path: P.V_MAN_GAMMA, min: -30, max: 30, step: 1, fine: 3 },
        { type: 'fineSlider', label: '콘트라스트', path: P.V_MAN_CON, min: -30, max: 30, step: 1, fine: 3 },
        { type: 'sep' },
        { type: 'sectionLabel', text: '밝은 영상 보정' },
        { type: 'hint', text: '선명도: 중간톤 S커브 대비로 밋밋한 밝은 영상에 입체감을 줍니다. 하이라이트 롤오프: 밝은 부분을 눌러 중간톤이 살아납니다.' },
        { type: 'fineSlider', label: '선명도 (Clarity)', path: P.V_MAN_CLARITY, min: 0, max: 50, step: 1, fine: 5 },
        { type: 'fineSlider', label: '하이라이트 롤오프', path: P.V_MAN_HIGHROLL, min: 0, max: 50, step: 1, fine: 5 },
        { type: 'sep' },
        { type: 'sectionLabel', text: '색상 보정' },
        { type: 'fineSlider', label: '색온도', path: P.V_MAN_TEMP, min: -50, max: 50, step: 1, fine: 5 },
        { type: 'fineSlider', label: '틴트', path: P.V_MAN_TINT, min: -50, max: 50, step: 1, fine: 5 },
        { type: 'fineSlider', label: '채도', path: P.V_MAN_SAT, min: -50, max: 50, step: 1, fine: 5 },
      ],
      audio: [
        { type: 'toggle', label: '오디오 평준화', path: P.A_EN, onChange: () => Audio.setTarget(__internal._activeVideo) },
        { type: 'slider', label: '평준화 강도', path: P.A_STR, min: 0, max: 100, step: 1 },
        { type: 'sep' },
        { type: 'hint', text: '큰 소리는 줄이고 작은 소리는 키워서 볼륨 편차를 줄입니다.' },
        { type: 'widget', build: buildAudioStatus },
        ...(IS_FIREFOX ? [{ type: 'hint', cls: 'dim', text: 'Firefox에서는 오디오 평준화가 지원되지 않습니다.' }] : []),
      ],
      playback: [
        { type: 'toggle', label: '속도 제어', path: P.PB_EN, onChange: () => Scheduler.request() },
        { type: 'widget', build: buildRateDisplay },
        { type: 'chips', path: P.PB_RATE, onSelect: v => { Store.set(P.PB_RATE, v); Store.set(P.PB_EN, true); }, items: [0.25,0.5,1.0,1.25,1.5,2.0,3.0,5.0].map(p => ({ v: p, l: `${p}×` })) },
        { type: 'fineButtons', path: P.PB_RATE, steps: [-0.25,-0.05,0.05,0.25], min: 0.07, max: 5 },
        { type: 'slider', label: '속도 슬라이더', path: P.PB_RATE, min: 0.07, max: 5, step: 0.01 },
      ]
    };

    function renderSchema(schema, container) { for (const item of schema) { switch (item.type) { case 'sep': container.append(mkSep()); break; case 'sectionLabel': container.append(h('div', { class: 'section-label' }, item.text)); break; case 'hint': container.append(h('div', { class: `hint${item.cls ? ' ' + item.cls : ''}` }, item.text)); break; case 'slider': container.append(mkRow(item.label, ...mkSlider(item.path, item.min, item.max, item.step))); break; case 'fineSlider': container.append(mkSliderWithFine(item.label, item.path, item.min, item.max, item.step, item.fine)); break; case 'toggle': container.append(mkRow(item.label, mkToggle(item.path, item.onChange))); break; case 'chips': container.append(mkChipRow(item.label || '', item.path, item.items, item.onSelect)); break; case 'fineButtons': container.append(mkFineButtons(item.path, item.steps, item.min, item.max)); break; case 'widget': container.append(item.build()); break; } } }
    function buildQuickBar() { if (quickBarHost) return; quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: HOST_STYLE_NORMAL }); quickBarHost.style.setProperty('display', 'none', 'important'); _qbarShadow = quickBarHost.attachShadow({ mode: 'closed' }); const qStyle = document.createElement('style'); qStyle.textContent = `${CSS_VARS} .qbar { pointer-events:none; position:fixed!important; top:50%!important; right:var(--vsc-qbar-right)!important; transform:translateY(-50%)!important; display:flex!important; align-items:center!important; z-index:2147483647!important; } .qbar .qb-main { pointer-events:auto; width:46px; height:46px; border-radius:50%; background:var(--vsc-glass); border:1px solid rgba(255,255,255,0.08); opacity:${IS_MOBILE ? '0' : '0.1'}; transition:all 0.3s var(--vsc-ease-out); box-shadow:var(--vsc-shadow-fab); display:flex; align-items:center; justify-content:center; cursor:pointer; backdrop-filter:blur(16px) saturate(180%); -webkit-tap-highlight-color:transparent; } @media (hover: hover) and (pointer: fine) { .qbar:hover .qb-main { opacity:1; transform:scale(1.08); border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); } .qbar:hover .qb-main svg { stroke:var(--vsc-neon)!important; } } .qbar .qb-main.touch-reveal { opacity:0.85!important; border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); } .qbar .qb-main.touch-reveal svg { stroke:var(--vsc-neon)!important; } .qbar svg { width:22px; height:22px; fill:none; stroke:#fff!important; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; display:block!important; pointer-events:none!important; }`; _qbarShadow.appendChild(qStyle); const bar = h('div', { class: 'qbar' }); const mainBtn = h('div', { class: 'qb qb-main' }); mainBtn.appendChild(h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('circle', { ns: 'svg', cx: '12', cy: '12', r: '3' }), h('path', { ns: 'svg', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }))); mainBtn.addEventListener('click', e => { e.preventDefault(); togglePanel(); }); bar.append(mainBtn); _qbarShadow.appendChild(bar); getMountTarget().appendChild(quickBarHost); if (IS_MOBILE) { let touchRevealTimer = 0; const revealGear = () => { mainBtn.classList.add('touch-reveal'); clearTimeout(touchRevealTimer); touchRevealTimer = setTimeout(() => { mainBtn.classList.remove('touch-reveal'); }, 2500); }; document.addEventListener('touchstart', revealGear, { passive: true }); mainBtn.addEventListener('touchstart', () => { mainBtn.classList.add('touch-reveal'); clearTimeout(touchRevealTimer); }, { passive: true }); } }
    function buildPanel() { if (panelHost) return; panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host', style: HOST_STYLE_NORMAL }); _shadow = panelHost.attachShadow({ mode: 'closed' }); _shadow.appendChild(h('style', {}, PANEL_CSS)); panelEl = h('div', { class: 'panel' }); panelEl.addEventListener('wheel', e => e.stopPropagation(), { passive: true }); panelEl.style.overscrollBehavior = 'none'; const closeBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '✕'); closeBtn.addEventListener('click', () => togglePanel(false)); panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), closeBtn)); const tabBar = h('div', { class: 'tabs' }); ['video','audio','playback'].forEach(t => { const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t }); tab.append(TAB_ICONS[t]?.() || '', h('span', {}, TAB_LABELS[t])); tab.addEventListener('click', () => { activeTab = t; renderTab(); }); tabBar.appendChild(tab); }); panelEl.appendChild(tabBar); const bodyEl = h('div', { class: 'body' }); bodyEl.style.overscrollBehavior = 'none'; panelEl.appendChild(bodyEl); _shadow.appendChild(panelEl); renderTab(); getMountTarget().appendChild(panelHost); }
    function renderTab() { const body = _shadow?.querySelector('.body'); if (!body) return; body.textContent = ''; tabSignalCleanups.forEach(c => c()); tabSignalCleanups.length = 0; tabFns.length = 0; const schema = TAB_SCHEMA[activeTab]; if (schema) renderSchema(schema, body); tabFns.forEach(f => f()); updateTabIndicator(_shadow.querySelector('.tabs'), activeTab); tabSignalCleanups.push(Scheduler.onSignal(() => { if (panelOpen) tabFns.forEach(f => f()); })); }
    function togglePanel(force) { buildPanel(); panelOpen = force !== undefined ? force : !panelOpen; if (panelOpen) { panelEl.classList.add('open'); panelEl.style.pointerEvents = 'auto'; renderTab(); } else { panelEl.classList.remove('open'); tabSignalCleanups.forEach(c => c()); tabSignalCleanups.length = 0; tabFns.length = 0; setTimeout(() => { if (!panelOpen) panelEl.style.pointerEvents = 'none'; }, 300); } }
    buildQuickBar(); updateQuickBarVisibility();
    globalSignalCleanups.push(Scheduler.onSignal(updateQuickBarVisibility));
    setInterval(() => { updateQuickBarVisibility(); if (quickBarHost?.parentNode !== getMountTarget()) reparent(); }, 2000);
    setInterval(() => { if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { Registry.scanShadowRoots(); Registry.cleanup(); }, { timeout: 500 }); else { Registry.scanShadowRoots(); Registry.cleanup(); } }, 5000);
    onFsChange(onFullscreenChange);
    return { togglePanel, syncAll: () => tabFns.forEach(f => f()) };
  }

  /* ══ Bootstrap ══ */
  function bootstrap() {
    const Scheduler = createScheduler();
    const Store = createLocalStore(DEFAULTS, Scheduler);
    try { const saved = GM_getValue(STORAGE_KEY); if (saved) Store.load(JSON.parse(saved)); } catch (_) {}
    let saveTimer = 0;
    const save = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = 0; try { GM_setValue(STORAGE_KEY, JSON.stringify(Store.state)); } catch (_) {} }, 300); };
    for (const path of Object.values(P)) Store.sub(path, save);
    const Registry = createRegistry(Scheduler); const Targeting = createTargeting(); const Audio = createAudio(Store, Scheduler); const OSD = createOSD(); const Params = createVideoParams(Store); const Filters = createFilters(); const AutoScene = createAutoScene(Store, Scheduler);
    Registry.setPurgeCallback((root) => Filters.purge(root));
    let _cleanupTick = 0;
    const apply = () => {
      if (++_cleanupTick % 300 === 0) Registry.cleanup();
      if (!Store.get('app.active')) { for (const v of Registry.videos) Filters.clear(v); Audio.setTarget(null); return; }
      const target = Targeting.pick(Registry.videos);
      if (target) { __internal._activeVideo = target; Audio.setTarget(target); AutoScene.tick(target); if (Store.get(P.PB_EN)) { const rate = CLAMP(Number(Store.get(P.PB_RATE)) || 1, 0.07, 5); if (Math.abs(target.playbackRate - rate) > 0.001) { let isDRM = target.dataset.vscDrm === "1"; try { isDRM = isDRM || !!target.mediaKeys; } catch (_) {} if (!isDRM) { try { target.playbackRate = rate; } catch (_) {} } } } }
      for (const v of Registry.videos) { if (!v.isConnected) continue; const dW = v.clientWidth || 0, dH = v.clientHeight || 0; if (dW < 80 || dH < 45) { Filters.clear(v); continue; } const params = Params.get(v); const filterStr = Filters.prepare(v, params); Filters.apply(v, filterStr); }
    };
    Scheduler.registerApply(apply);
    Store.sub(P.PB_EN, (enabled) => { if (!enabled && __internal._activeVideo?.isConnected) try { __internal._activeVideo.playbackRate = 1.0; } catch (_) {} });
    onFsChange(() => Scheduler.request(true));
    createUI(Store, Audio, Registry, Scheduler, OSD, AutoScene, Filters);
    __internal.Store = Store; __internal._activeVideo = null;
    try { GM_registerMenuCommand('VSC ON/OFF 토글', () => { const current = Store.get(P.APP_ACT); Store.set(P.APP_ACT, !current); OSD.show(Store.get(P.APP_ACT) ? 'VSC ON' : 'VSC OFF', 1000); Scheduler.request(true); }); } catch (_) {}
    if (Store.get(P.V_AUTO_SCENE)) { AutoScene.activate(); }
    Registry.rescanAll(); apply();
    log.info(`[VSC] v${VSC_VERSION} booted.`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
