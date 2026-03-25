// ==UserScript==
// @name         Video_Control (v222.0.3)
// @namespace    https://github.com/
// @version      222.0.3
// @description  v222.0.3: streamMap Context 유효성 검사 추가 및 전역/탭 시그널 생명주기 분리 (안정성 극대화)
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.cloudflare.com/cdn-cgi/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://*.primevideo.com/*
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
  const VSC_VERSION = '222.0.3';

  const log = {
    info: (...a) => console.info('[VSC]', ...a),
    warn: (...a) => console.warn('[VSC]', ...a),
    error: (...a) => console.error('[VSC]', ...a)
  };

  function normalizeHostname(h) {
    let parts = h.split('.');
    if (parts[0] === 'www') parts = parts.slice(1);
    if (parts.length > 2 && /^\d{1,3}$/.test(parts[0])) return parts.slice(1).join('.');
    return parts.join('.');
  }
  const STORAGE_KEY = 'vsc_v2_' + normalizeHostname(location.hostname) + (location.pathname.startsWith('/shorts') ? '_shorts' : '');
  const CLAMP = (v, min, max) => v < min ? min : v > max ? max : v;
  const SHARP_CAP = 0.60;

  /* ══ Style helpers ══ */
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

  function tempToRgbGain(temp) {
    const t = CLAMP((Number(temp) || 0) * 0.02, -1, 1);
    if (t > -0.001 && t < 0.001) return { rs: 1, gs: 1, bs: 1 };
    const r = 1 + 0.14 * t, g = 1 - 0.005 * Math.abs(t), b = 1 - 0.14 * t;
    const maxCh = Math.max(r, g, b);
    return { rs: r / maxCh, gs: g / maxCh, bs: b / maxCh };
  }

  /* ══ Defaults & Paths ══ */
  const DEFAULTS = {
    video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0 },
    audio: { enabled: false, strength: 50 },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false, screenBright: 0 }
  };
  const P = {
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_SCREEN_BRT: 'app.screenBright',
    V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
    V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery',
    V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp',
    A_EN: 'audio.enabled', A_STR: 'audio.strength',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  };

  /* ══ Local Store ══ */
  function createLocalStore(defaults, scheduler) {
    let rev = 0;
    const listeners = new Map();
    const state = JSON.parse(JSON.stringify(defaults));
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const fn of a) try { fn(val); } catch (_) {} };
    return {
      state, rev: () => rev,
      get: (p) => { const parts = p.split('.'); return parts.length > 1 ? state[parts[0]]?.[parts[1]] : state[parts[0]]; },
      set: (p, val) => { const [c, k] = p.split('.'); if (k != null) { if (Object.is(state[c]?.[k], val)) return; state[c][k] = val; rev++; emit(p, val); scheduler.request(); } },
      batch: (cat, obj) => { let changed = false; for (const [k, v] of Object.entries(obj)) { if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); } } if (changed) { rev++; scheduler.request(); } },
      sub: (k, f) => { if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(f); },
      load: (data) => { if (!data) return; for (const c of ['video', 'audio', 'playback', 'app']) { if (data[c]) Object.assign(state[c], data[c]); } rev++; }
    };
  }

  /* ══ Utils ══ */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg','defs','filter','feComponentTransfer','feFuncR','feFuncG','feFuncB','feFuncA','feConvolveMatrix','feColorMatrix','feGaussianBlur','feMerge','feMergeNode','feComposite','feBlend','g','path','circle','rect','line','text','polyline','polygon']);

  function h(tag, props = {}, ...children) {
    const isSvg = props.ns === 'svg' || SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'ns') continue;
      if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), (e) => { if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation(); v(e); }); }
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
      else if (v !== false && v != null) el.setAttribute(k, v);
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

  /* ══ Scheduler ══ */
  function createScheduler(minIntervalMs = 16) {
    let queued = false, applyFn = null, lastRun = 0;
    const signalFns = [];
    return {
      registerApply: fn => { applyFn = fn; },
      onSignal: fn => { 
        signalFns.push(fn); 
        return () => { const idx = signalFns.indexOf(fn); if (idx > -1) signalFns.splice(idx, 1); }; 
      },
      request: (immediate = false) => {
        if (queued && !immediate) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          const now = performance.now();
          if (!immediate && now - lastRun < minIntervalMs) return;
          lastRun = now;
          if (applyFn) try { applyFn(); } catch (_) {}
          for (const fn of signalFns) try { fn(); } catch (_) {}
        });
      }
    };
  }

  /* ══ Registry ══ */
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
      if (!el || el.tagName !== 'VIDEO' || videos.has(el)) return;
      videos.add(el);

      el.addEventListener('encrypted', () => { el.dataset.vscDrm = "1"; scheduler.request(); });
      el.addEventListener('waitingforkey', () => { el.dataset.vscDrm = "1"; scheduler.request(); });

      if (io) io.observe(el);
      if (ro) ro.observe(el);
      const req = () => { scheduler.request(); };
      let lastT = 0;
      const onTimeUpdate = () => { const now = performance.now(); if (now - lastT > 1000) { lastT = now; req(); } };
      const listenerDefs = [['loadedmetadata', req], ['resize', req], ['playing', req], ['timeupdate', onTimeUpdate]];
      for (const [evt, fn] of listenerDefs) el.addEventListener(evt, fn, { passive: true });
      videoListeners.set(el, listenerDefs);
      req();
    }

    function scanNode(n) {
      if (!n) return;
      if (n.nodeType === 1) {
        if (n.tagName === 'VIDEO') { observeVideo(n); return; }
        if (n.shadowRoot && !observedShadowHosts.has(n)) {
          observedShadowHosts.add(n);
          if (shadowRootsLRU.length >= SHADOW_MAX) { const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected); if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift(); }
          shadowRootsLRU.push({ host: n, root: n.shadowRoot });
          connectObserver(n.shadowRoot); scanNode(n.shadowRoot);
        }
        if (!n.childElementCount) return;
        try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {}
      } else if (n.nodeType === 11) { try { const vs = n.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
    }

    const workQ = []; let workScheduled = false;
    function scheduleWork() { if (workScheduled) return; workScheduled = true; const doWork = () => { workScheduled = false; const batch = workQ.splice(0, 20); for (const n of batch) scanNode(n); if (workQ.length > 0) scheduleWork(); }; if (typeof requestIdleCallback === 'function') requestIdleCallback(doWork, { timeout: 120 }); else setTimeout(doWork, 0); }
    function enqueue(n) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; if (workQ.length > 500) { const keep = workQ.slice(workQ.length >> 1); workQ.length = 0; workQ.push(...keep); } workQ.push(n); scheduleWork(); }

    function connectObserver(root) {
      if (!root) return;
      const mo = new MutationObserver((muts) => {
        let touchedVideo = false;
        for (const m of muts) {
          if (m.addedNodes?.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; if (n.nodeType === 1 && isVscNode(n)) continue; enqueue(n); if (!touchedVideo && n.nodeType === 1) { if (n.tagName === 'VIDEO') touchedVideo = true; else if (n.childElementCount) { try { const l = n.getElementsByTagName('video'); if (l?.length) touchedVideo = true; } catch (_) {} } } } }
          if (!touchedVideo && m.removedNodes?.length) { for (const n of m.removedNodes) { if (n?.nodeType === 1 && (n.tagName === 'VIDEO' || n.querySelector?.('video'))) { touchedVideo = true; break; } } }
        }
        if (touchedVideo) requestRefresh();
      });
      mo.observe(root, { childList: true, subtree: true }); observers.add(mo); enqueue(root);
    }

    const root = document.body || document.documentElement;
    if (root) { enqueue(root); connectObserver(root); }

    setInterval(() => { 
      try { 
        const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, {
          acceptNode: function(node) {
            return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
        });
        let el;
        while(el = walker.nextNode()) {
          if (!observedShadowHosts.has(el)) {
            observedShadowHosts.add(el); 
            if (shadowRootsLRU.length >= SHADOW_MAX) { const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected); if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift(); } 
            shadowRootsLRU.push({ host: el, root: el.shadowRoot }); 
            connectObserver(el.shadowRoot); 
            scanNode(el.shadowRoot); 
          }
        }
      } catch (_) {} 
    }, 3000);

    setInterval(() => { let removed = 0; for (const el of videos) { if (!el?.isConnected) { videos.delete(el); clearFilterStyles(el); if (io) try { io.unobserve(el); } catch (_) {} if (ro) try { ro.unobserve(el); } catch (_) {} const ls = videoListeners.get(el); if (ls) { for (const [evt, fn] of ls) el.removeEventListener(evt, fn); videoListeners.delete(el); } removed++; } } if (removed) requestRefresh(); }, 5000);

    return { videos, shadowRootsLRU, rescanAll: () => scanNode(document.body || document.documentElement) };
  }

  /* ══ Targeting ══ */
  function createTargeting() {
    return {
      pick: (videos) => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) { if (fsEl.tagName === 'VIDEO' && videos.has(fsEl)) return fsEl; for (const v of videos) { if (v.isConnected && fsEl.contains(v)) return v; } }
        let best = null, bestScore = -Infinity;
        for (const v of videos) { if (!v.isConnected) continue; const r = v.getBoundingClientRect(); const area = r.width * r.height; if (area === 0 && v.readyState === 0 && v.paused) continue; let s = Math.log2(1 + Math.max(0, area)); if (!v.paused && !v.ended) s += 25; if (v.currentTime > 0) s += 5; if (!v.muted && v.volume > 0.01) s += 5; if (s > bestScore) { bestScore = s; best = v; } }
        return best;
      }
    };
  }

  /* ══ Audio ══ */
  function createAudio(store, scheduler) {
    if (IS_FIREFOX) return { setTarget() {}, update() {}, hasCtx: () => false, isHooked: () => false, isBypassed: () => true };

    let ctx = null, comp = null, limiter = null, makeupGain = null, masterOut = null, dryPath = null;
    let currentSrc = null, targetVideo = null;
    let currentMode = 'none';
    const mesMap = new WeakMap();     
    const streamMap = new WeakMap();  
    let bypassMode = false;

    const corsFailedVideos = new WeakSet();
    const mesFailedVideos = new WeakSet();
    const permanentBypassVideos = new WeakSet();

    function detectJWPlayer(video) {
      if (!video) return false;
      if (typeof window.jwplayer === 'function') { try { if (window.jwplayer()?.getContainer?.()) return true; } catch (_) {} }
      let el = video.parentElement, depth = 0;
      while (el && depth < 10) {
        if (el.classList?.contains('jwplayer') || el.id?.startsWith('jwplayer') || el.classList?.contains('jw-wrapper') || el.querySelector?.(':scope > .jw-media, :scope > .jw-controls')) return true;
        el = el.parentElement; depth++;
      }
      if (video.src?.startsWith('blob:')) { if (document.querySelector('script[src*="jwplayer"]') || document.querySelector('[class*="jw-"]')) return true; }
      return false;
    }

    function canConnect(video) {
      if (!video) return false;
      if (permanentBypassVideos.has(video)) return false;
      if (detectJWPlayer(video) && corsFailedVideos.has(video)) return false;
      if (mesFailedVideos.has(video) && corsFailedVideos.has(video)) return false;
      return true;
    }

    function initCtx() {
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { return false; }

      comp = ctx.createDynamicsCompressor();
      makeupGain = ctx.createGain();
      makeupGain.gain.value = 1;

      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.08;
      limiter.knee.value = 0;

      masterOut = ctx.createGain();
      masterOut.gain.value = 1;

      comp.connect(makeupGain);
      makeupGain.connect(limiter);
      limiter.connect(masterOut);
      masterOut.connect(ctx.destination);

      dryPath = ctx.createGain();
      dryPath.gain.value = 1;
      dryPath.connect(ctx.destination);

      applyStrength(Number(store.get(P.A_STR)) || 50);
      return true;
    }

    function applyStrength(strength) {
      if (!comp || !makeupGain || !ctx) return;
      const s = CLAMP(strength, 0, 100) / 100;
      comp.threshold.value = -10 - s * 22;
      comp.ratio.value = 2 + s * 10;
      comp.knee.value = 12 - s * 8;
      comp.attack.value = 0.003 + (1 - s) * 0.012;
      comp.release.value = 0.10 + (1 - s) * 0.15;

      const threshAbs = Math.abs(comp.threshold.value);
      const makeupDb = threshAbs * (1 - 1 / comp.ratio.value) * 0.4;
      const gain = Math.pow(10, makeupDb / 20);
      try { makeupGain.gain.setTargetAtTime(CLAMP(gain, 1, 4), ctx.currentTime, 0.05); }
      catch (_) { makeupGain.gain.value = CLAMP(gain, 1, 4); }
    }

    function enterBypass(video, reason) {
      if (bypassMode) return;
      bypassMode = true;
      currentMode = 'bypass';
      log.info(`[Audio] Bypass — ${reason || ''}`);

      if (video && ctx && currentSrc) {
        try { currentSrc.disconnect(); } catch (_) {}
        if (currentSrc.__vsc_isCaptureStream) {
          if (video.muted && currentSrc.__vsc_originalMuted === false) try { video.muted = false; } catch (_) {}
          if (currentSrc.__vsc_originalVolume != null) try { video.volume = currentSrc.__vsc_originalVolume; } catch (_) {}
          const stream = currentSrc.__vsc_captureStream;
          if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        } else {
          try { currentSrc.connect(ctx.destination); } catch (_) {}
        }
      }
      currentSrc = null;
    }

    function exitBypass() { if (!bypassMode) return; bypassMode = false; }

    function connectViaCaptureStream(video) {
      if (!ctx || corsFailedVideos.has(video)) return null;
      let s = streamMap.get(video);
      if (s) {
        if (s.context === ctx) return s;
        // AudioContext가 변경된 경우 기존 소스 정리 (방어적 코드)
        try { s.disconnect(); } catch (_) {}
        if (s.__vsc_captureStream) {
          s.__vsc_captureStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        }
        streamMap.delete(video);
      }

      const captureFn = video.captureStream || video.mozCaptureStream;
      if (typeof captureFn !== 'function') return null;

      const originalMuted = video.muted;
      const originalVolume = video.volume;

      let stream;
      try { stream = captureFn.call(video); }
      catch (e) {
        if (e.name === 'SecurityError' || e.message?.includes('cross-origin')) { corsFailedVideos.add(video); return null; }
        return null;
      }

      if (stream.getAudioTracks().length === 0) {
        setTimeout(() => { if (stream.getAudioTracks().length > 0) scheduler.request(); }, 500);
        return null;
      }

      try {
        const source = ctx.createMediaStreamSource(stream);
        source.__vsc_isCaptureStream = true;
        source.__vsc_captureStream = stream;
        source.__vsc_originalMuted = originalMuted;
        source.__vsc_originalVolume = originalVolume;

        video.muted = true;
        streamMap.set(video, source);
        return source;
      } catch (e) { 
        stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        return null; 
      }
    }

    function connectViaMES(video) {
      if (!ctx || mesFailedVideos.has(video)) return null;
      let s = mesMap.get(video);
      if (s) { if (s.context === ctx) return s; if (s.context.state === 'closed') { mesMap.delete(video); s = null; } else return null; }
      try { s = ctx.createMediaElementSource(video); mesMap.set(video, s); return s; }
      catch (e) { if (e.name === 'InvalidStateError') return null; log.error('[Audio] MES failed:', e); return null; }
    }

    function connectSource(video) {
      if (!video || !ctx) return false;
      if (!canConnect(video)) { enterBypass(video, 'pre-check: not connectable'); return false; }

      const isJW = detectJWPlayer(video);
      let source = null;

      if (isJW) {
        source = connectViaCaptureStream(video);
        if (!source) {
          permanentBypassVideos.add(video);
          enterBypass(video, 'JWPlayer: captureStream failed → permanent bypass');
          return false;
        }
      } else {
        source = connectViaMES(video);
        if (!source) source = connectViaCaptureStream(video);
      }

      if (!source) {
        if (!isJW) { mesFailedVideos.add(video); corsFailedVideos.add(video); }
        enterBypass(video, 'all methods failed');
        return false;
      }

      try { source.disconnect(); } catch (_) {}
      const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
      source.connect(enabled ? comp : dryPath);
      currentSrc = source;
      currentMode = source.__vsc_isCaptureStream ? 'stream' : 'mes';
      exitBypass();
      log.info(`[Audio] Connected via ${currentMode}${isJW ? ' (JWPlayer)' : ''}`);
      return true;
    }

    function fadeOutThen(fn) {
      if (!ctx || !masterOut || ctx.state === 'closed') { try { fn(); } catch (_) {} return; }
      try { const t = ctx.currentTime; masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + 0.04); } catch (_) { try { masterOut.gain.value = 0; } catch (__) {} }
      setTimeout(() => {
        try { fn(); } catch (_) {}
        if (ctx && masterOut && ctx.state !== 'closed') { try { const t2 = ctx.currentTime; masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(0, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04); } catch (_) { try { masterOut.gain.value = 1; } catch (__) {} } }
      }, 60);
    }

    function disconnectCurrent(vid) {
      if (!currentSrc) return;
      const target = vid || targetVideo; 

      if (currentSrc.__vsc_isCaptureStream && target) {
        if (target.muted && currentSrc.__vsc_originalMuted === false) try { target.muted = false; } catch (_) {}
        if (currentSrc.__vsc_originalVolume != null) try { target.volume = currentSrc.__vsc_originalVolume; } catch (_) {}
        const stream = currentSrc.__vsc_captureStream;
        if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        streamMap.delete(target);
      }
      try { currentSrc.disconnect(); } catch (_) {}
      if (!currentSrc.__vsc_isCaptureStream && ctx && ctx.state !== 'closed') { try { currentSrc.connect(ctx.destination); } catch (_) {} }
      currentSrc = null; currentMode = 'none';
    }

    function updateMix() {
      if (!ctx || bypassMode) return;
      const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
      if (enabled && currentSrc) {
        try { currentSrc.disconnect(); } catch (_) {}
        currentSrc.connect(comp);
        applyStrength(Number(store.get(P.A_STR)) || 50);
      } else if (currentSrc) {
        try { currentSrc.disconnect(); } catch (_) {}
        currentSrc.connect(dryPath);
      }
    }

    function setTarget(video) {
      if (video === targetVideo) {
        if (bypassMode) {
          if (!canConnect(video)) return;
          exitBypass();
          if (connectSource(video)) { updateMix(); return; }
          return;
        }
        if (currentSrc) { updateMix(); return; }
        if (canConnect(video)) { if (!initCtx()) return; if (connectSource(video)) updateMix(); }
        return;
      }

      const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
      if (!enabled) {
        const oldTarget = targetVideo;
        if (currentSrc || targetVideo) {
          fadeOutThen(() => { 
            disconnectCurrent(oldTarget); 
            targetVideo = video; 
          });
        } else {
          targetVideo = video;
        }
        if (bypassMode) { bypassMode = false; currentMode = 'none'; }
        return;
      }
      if (!initCtx()) { targetVideo = video; return; }

      if (video && !canConnect(video)) {
        const oldTarget = targetVideo;
        fadeOutThen(() => { 
          disconnectCurrent(oldTarget); 
          targetVideo = video; 
          if (!bypassMode) { bypassMode = true; currentMode = 'bypass'; } 
        });
        return;
      }

      const oldTarget = targetVideo;
      fadeOutThen(() => {
        disconnectCurrent(oldTarget);
        if (bypassMode) { bypassMode = false; currentMode = 'none'; }
        targetVideo = video;
        if (!video) { updateMix(); return; }
        connectSource(video);
        updateMix();
      });
    }

    let gestureHooked = false;
    const onGesture = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); if (ctx?.state === 'running' && gestureHooked) { for (const evt of ['pointerdown','keydown','click']) window.removeEventListener(evt, onGesture, true); gestureHooked = false; } };
    function ensureGestureHook() { if (gestureHooked) return; gestureHooked = true; for (const evt of ['pointerdown','keydown','click']) window.addEventListener(evt, onGesture, { passive: true, capture: true }); }
    ensureGestureHook();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx?.state === 'suspended') ctx.resume().catch(() => {}); }, { passive: true });

    return { setTarget, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!(currentSrc || bypassMode), isBypassed: () => bypassMode };
  }

  /* ══ SVG Filter Engine ══ */
  function createFilters() {
    const ctxMap = new WeakMap();
    const toneCache = new Map();
    const TONE_CACHE_MAX = 32;

    function getToneTable(steps, gain, contrast, brightOffset, gamma, toe, mid, shoulder) {
      const key = `${steps}|${(gain*100+.5)|0}|${(contrast*100+.5)|0}|${(brightOffset*1000+.5)|0}|${(gamma*100+.5)|0}|t${(toe*1000+.5)|0}|m${(mid*1000+.5)|0}|s${(shoulder*1000+.5)|0}`;
      if (toneCache.has(key)) {
        const val = toneCache.get(key);
        toneCache.delete(key);
        toneCache.set(key, val);
        return val;
      }
      const ev = Math.log2(Math.max(1e-6, gain));
      const g = ev * 0.90; const absG = Math.abs(g); const useFilmicCurve = absG > 0.01; const denom = useFilmicCurve ? (1 - Math.exp(-g)) : 1;
      const out = new Array(steps); let prev = 0; const intercept = 0.5 * (1 - contrast) + brightOffset;
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1); let x = useFilmicCurve ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = x * contrast + intercept; x = CLAMP(x, 0, 1);
        if (toe > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toe * (1 - t) * (t * t) * (1 - x); }
        if (mid > 0.001) { const mc = 0.45, sig = 0.18; const mw = Math.exp(-((x0 - mc) ** 2) / (2 * sig * sig)); x = CLAMP(x + (x0 - mc) * mid * mw * 1.5, 0, 1); }
        if (shoulder > 0.001) { const hw = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = CLAMP(x + shoulder * 0.6 * x0 + shoulder * hw * hw * 0.5 * (1 - x), 0, 1); }
        if (Math.abs(gamma - 1) > 0.001) x = Math.pow(x, gamma);
        if (x < prev) x = prev; prev = x; out[i] = (x).toFixed(4);
      }
      const res = out.join(' ');

      if (toneCache.size >= TONE_CACHE_MAX) {
        const first = toneCache.keys().next();
        if (!first.done) toneCache.delete(first.value);
      }
      toneCache.set(key, res);
      return res;
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
      const tempChildren = Array.from(fTemp.children);
      return { fid, svg, fConv, toneFuncsRGB: [toneFuncR, toneFuncG, toneFuncB].filter(Boolean), tempFuncR: tempChildren.find(f => f.tagName.includes('R')), tempFuncG: tempChildren.find(f => f.tagName.includes('G')), tempFuncB: tempChildren.find(f => f.tagName.includes('B')), fSat, st: { lastKey: '', toneKey: '', sharpKey: '', tempKey: '' } };
    }

    function needsSvg(s) {
      if (IS_FIREFOX) return false;
      const hasSharp = Math.abs(s.sharp || 0) > 0.005;
      const hasTone = (Math.abs(s.toe || 0) > 0.005 || Math.abs(s.mid || 0) > 0.005 || Math.abs(s.shoulder || 0) > 0.005 || Math.abs((s.gain || 1) - 1) > 0.005 || Math.abs((s.gamma || 1) - 1) > 0.005 || Math.abs(s.bright || 0) > 0.5);
      return hasSharp || hasTone || Math.abs(s.temp || 0) > 0.5;
    }

    function prepare(video, s) {
      if (!needsSvg(s)) {
        const parts = [];
        if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
        if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
        if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
        return parts.length > 0 ? parts.join(' ') : 'none';
      }
      const root = (video.getRootNode?.() instanceof ShadowRoot) ? video.getRootNode() : (video.ownerDocument || document);
      let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
      const st = ctx.st;
      const svgHash = `${(s.sharp||0).toFixed(3)}|${(s.toe||0).toFixed(3)}|${(s.mid||0).toFixed(3)}|${(s.shoulder||0).toFixed(3)}|${(s.gain||1).toFixed(3)}|${(s.gamma||1).toFixed(3)}|${(s.bright||0).toFixed(2)}|${(s.contrast||1).toFixed(3)}|${s.temp||0}`;

      if (st.lastKey !== svgHash) {
        st.lastKey = svgHash;
        const toneTable = getToneTable(256, s.gain || 1, s.contrast || 1, (s.bright || 0) * 0.004, 1 / CLAMP(s.gamma || 1, 0.1, 5), s.toe || 0, s.mid || 0, s.shoulder || 0);
        if (st.toneKey !== toneTable) { st.toneKey = toneTable; for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable); }
        const userTemp = tempToRgbGain(s.temp);
        if (st.tempKey !== s.temp) { st.tempKey = s.temp; ctx.tempFuncR.setAttribute('slope', userTemp.rs); ctx.tempFuncG.setAttribute('slope', userTemp.gs); ctx.tempFuncB.setAttribute('slope', userTemp.bs); }
        if (!IS_FIREFOX) {
          const totalS = CLAMP(Number(s.sharp || 0), 0, SHARP_CAP);
          let kernelStr = '0,0,0, 0,1,0, 0,0,0';
          if (totalS >= 0.005) { const edge = -totalS; const diag = edge * 0.707; const center = 1 - 4 * edge - 4 * diag; kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`; }
          if (st.sharpKey !== kernelStr) { st.sharpKey = kernelStr; const desatVal = totalS > 0.008 ? CLAMP(1 - totalS * 0.1, 0.90, 1).toFixed(3) : '1.000'; ctx.fConv.setAttribute('kernelMatrix', kernelStr); const kernelSum = 4 * (-totalS) + 4 * (-totalS * 0.707) + (1 - 4 * (-totalS) - 4 * (-totalS * 0.707)); ctx.fConv.setAttribute('divisor', kernelSum.toFixed(5)); ctx.fSat.setAttribute('values', desatVal); }
        }
      }
      const parts = [`url(#${ctx.fid})`]; if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
      return parts.join(' ');
    }

    return { prepare, apply: (el, filterStr) => {
      if (!el) return;
      if (filterStr === 'none') { clearFilterStyles(el); return; }
      if (el.style.getPropertyValue('filter') === filterStr) return;
      applyFilterStyles(el, filterStr);
    }, clear: clearFilterStyles };
  }

  /* ══ VideoParams ══ */
  function createVideoParams(Store) {
    const cache = new WeakMap();

    function wouldUseSvg(out) {
      if (IS_FIREFOX) return false;
      const hasSharp = Math.abs(out.sharp || 0) > 0.005;
      const hasTone = (
        Math.abs(out.toe || 0) > 0.005 ||
        Math.abs(out.mid || 0) > 0.005 ||
        Math.abs(out.shoulder || 0) > 0.005 ||
        Math.abs((out.gain || 1) - 1) > 0.005 ||
        Math.abs((out.gamma || 1) - 1) > 0.005 ||
        Math.abs(out.bright || 0) > 0.5
      );
      return hasSharp || hasTone || Math.abs(out.temp || 0) > 0.5;
    }

    function computeSharpMul(video) {
      const nW = video.videoWidth | 0;
      if (nW < 16) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };

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

      if (dW < 16) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };
      const nH = video.videoHeight | 0;
      const ratioW = (dW * dpr) / nW;
      const ratioH = (nH > 16 && dH > 16) ? (dH * dpr) / nH : ratioW;
      const ratio = Math.min(ratioW, ratioH);

      let mul = ratio <= 0.30 ? 0.40 : ratio <= 0.60 ? 0.40 + (ratio - 0.30) / 0.30 * 0.30 : ratio <= 1.00 ? 0.70 + (ratio - 0.60) / 0.40 * 0.30 : ratio <= 1.80 ? 1.00 : ratio <= 4.00 ? 1.00 - (ratio - 1.80) / 2.20 * 0.30 : 0.65;
      let rawAutoBase = nW <= 640 ? 0.18 : nW <= 960 ? 0.14 : nW <= 1280 ? 0.13 : nW <= 1920 ? 0.12 : 0.07;

      if (IS_MOBILE) mul = Math.max(mul, 0.60);

      return { mul: CLAMP(mul, 0, 1), autoBase: CLAMP(rawAutoBase * mul, 0, 0.18), rawAutoBase };
    }

    return {
      get: (video) => {
        const storeRev = Store.rev();
        const nW = video ? (video.videoWidth | 0) : 0;
        const dW = video ? (video.clientWidth || video.offsetWidth || 0) : 0;
        const dH = video ? (video.clientHeight || video.offsetHeight || 0) : 0;

        if (video && nW >= 16) {
          const cached = cache.get(video);
          if (cached && cached.rev === storeRev && cached.nW === nW && cached.dW === dW && cached.dH === dH) return cached.out;
        }

        const out = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, toe: 0, mid: 0, shoulder: 0, temp: 0, sharp: 0, _cssBr: 1, _cssCt: 1, _cssSat: 1 };
        const presetS = Store.get(P.V_PRE_S);
        const mix = CLAMP(Number(Store.get(P.V_PRE_MIX)) || 1, 0, 1);

        const { mul, autoBase, rawAutoBase } = video ? computeSharpMul(video) : { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12 };

        const mobileThrottle = IS_MOBILE ? 0.60 : 0.40;
        const finalMul = ((mul === 0 && presetS !== 'off') ? 0.50 : mul) * mobileThrottle;

        if (presetS === 'off') {
          out.sharp = autoBase * mobileThrottle;
        } else if (presetS !== 'none') {
          const resFactor = CLAMP(rawAutoBase / 0.12, 0.58, 1.50);
          out.sharp = (_PRESET_SHARP_LUT[presetS] || 0) * mix * finalMul * resFactor;
        }
        out.sharp = CLAMP(out.sharp, 0, SHARP_CAP);

        const mShad = CLAMP(Number(Store.get(P.V_MAN_SHAD) ?? 0), 0, 100);
        const mRec  = CLAMP(Number(Store.get(P.V_MAN_REC) ?? 0), 0, 100);
        const mBrt  = CLAMP(Number(Store.get(P.V_MAN_BRT) ?? 0), 0, 100);
        const mTemp = CLAMP(Number(Store.get(P.V_MAN_TEMP) ?? 0), -50, 50);

        out.toe      = mShad * 0.0040;
        out.mid      = mRec  * 0.0035;
        out.shoulder = mBrt  * 0.0045;
        out.temp     = mTemp;

        if (wouldUseSvg(out)) {
          out._cssBr = 1.0;
          out._cssCt = 1.0;
        } else {
          out._cssBr = 1 + (mBrt * 0.003);
          out._cssCt = 1 + (mRec * 0.003);
        }

        out._cssSat = CLAMP(out.satF, 0.5, 2.0);

        if (video && nW >= 16) cache.set(video, { rev: storeRev, nW, dW, dH, out });
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
        if (!el || el.parentNode !== root) { el?.remove(); el = document.createElement('div'); el.id = 'vsc-osd'; el.setAttribute('data-vsc-ui', '1'); el.style.cssText = 'position:fixed!important;top:48px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(12,12,18,0.85)!important;backdrop-filter:blur(24px) saturate(200%)!important;color:rgba(255,255,255,0.95)!important;padding:10px 28px!important;border-radius:14px!important;border:1px solid rgba(0,229,255,0.15)!important;font:600 13px/1.4 system-ui,sans-serif!important;z-index:2147483647!important;pointer-events:none!important;opacity:0!important;transition:opacity 0.2s,transform 0.3s!important;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.08)!important;text-align:center!important;'; root.appendChild(el); }
        el.textContent = text;
        requestAnimationFrame(() => { el.style.setProperty('opacity', '1', 'important'); });
        clearTimeout(timerId);
        timerId = setTimeout(() => { if (el) el.style.setProperty('opacity', '0', 'important'); }, ms);
      }
    };
  }

  /* ══ UI ══ */
  function createUI(Store, Audio, Registry, Scheduler, OSD) {
    let panelHost = null, panelEl = null, quickBarHost = null;
    let activeTab = 'video', panelOpen = false;
    let _shadow = null, _qbarShadow = null;
    const tabFns = [];
    const tabSignalCleanups = []; 
    const globalSignalCleanups = []; 
    let __scrBrtOverlay = null;

    const TAB_ICONS = {
      video: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('rect', { x: 2, y: 4, width: 16, height: 16, rx: 2 }), _s('path', { d: 'M22 7l-6 4 6 4z' })),
      audio: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('path', { d: 'M11 5L6 9H2v6h4l5 4V5z' }), _s('path', { d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
      playback: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('circle', { cx: 12, cy: 12, r: 10 }), _s('polygon', { points: '10 8 16 12 10 16' }))
    };
    const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생' };

    const SCR_BRT_LEVELS = [0, 0.05, 0.10, 0.15, 0.20, 0.25];
    const SCR_BRT_LABELS = ['OFF', '1단', '2단', '3단', '4단', '5단'];

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
          setTimeout(() => {
            if (__scrBrtOverlay?.style.opacity === '0') __scrBrtOverlay.style.setProperty('display', 'none', 'important');
          }, 350);
        }
        return;
      }
      const ov = ensureScrBrtOverlay();
      ov.style.removeProperty('display');
      requestAnimationFrame(() => { ov.style.setProperty('opacity', String(val), 'important'); });
    }

    Store.sub(P.APP_SCREEN_BRT, v => applyScrBrt(Number(v) || 0));
    setTimeout(() => { const saved = Number(Store.get(P.APP_SCREEN_BRT)) || 0; if (saved > 0) applyScrBrt(saved); }, 500);

    document.addEventListener('fullscreenchange', () => applyScrBrt(Number(Store.get(P.APP_SCREEN_BRT)) || 0));
    document.addEventListener('webkitfullscreenchange', () => applyScrBrt(Number(Store.get(P.APP_SCREEN_BRT)) || 0));

    const CSS_VARS = `
    :host { position: fixed !important; contain: none !important; overflow: visible !important; isolation: isolate; z-index: 2147483647 !important;
      --vsc-glass: rgba(12, 12, 18, 0.72); --vsc-glass-blur: blur(24px) saturate(200%); --vsc-glass-border: rgba(255, 255, 255, 0.06);
      --vsc-neon: #00e5ff; --vsc-neon-glow: 0 0 12px rgba(0, 229, 255, 0.35), 0 0 40px rgba(0, 229, 255, 0.08); --vsc-neon-soft: rgba(0, 229, 255, 0.15); --vsc-neon-border: rgba(0, 229, 255, 0.25); --vsc-neon-dim: rgba(0, 229, 255, 0.08);
      --vsc-purple: #b47aff; --vsc-amber: #ffbe46;
      --vsc-text: rgba(255, 255, 255, 0.92); --vsc-text-dim: rgba(255, 255, 255, 0.50); --vsc-text-muted: rgba(255, 255, 255, 0.28);
      --vsc-shadow-panel: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset; --vsc-shadow-fab: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
      --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px;
      --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      --vsc-font-sm: 11px; --vsc-font-md: 13px; --vsc-font-xxl: 32px;
      --vsc-touch-min: ${IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${IS_MOBILE ? '6px' : '10px'};
      --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      font-family: var(--vsc-font) !important; font-size: var(--vsc-font-md) !important; color: var(--vsc-text) !important; -webkit-font-smoothing: antialiased; }`;

    const PANEL_CSS = `${CSS_VARS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; }
    .panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px) !important; top: 50% !important; width: var(--vsc-panel-width) !important; max-height: var(--vsc-panel-max-h) !important; background: var(--vsc-glass) !important; border: 1px solid var(--vsc-glass-border) !important; border-radius: var(--vsc-radius-xl) !important; backdrop-filter: var(--vsc-glass-blur) !important; -webkit-backdrop-filter: var(--vsc-glass-blur) !important; box-shadow: var(--vsc-shadow-panel) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; user-select: none !important; opacity: 0 !important; transform: translate(16px, -50%) scale(0.92) !important; filter: blur(4px) !important; transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring), filter 0.3s var(--vsc-ease-out) !important; overscroll-behavior: none !important; }
    .panel.open { opacity: 1 !important; transform: translate(0, -50%) scale(1) !important; filter: blur(0) !important; pointer-events: auto !important; }
    .panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
    .hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 10px; }
    .hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.04); position: relative; padding: 0 4px; }
    .tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); }
    .tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; text-transform: uppercase; }
    .tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; stroke: currentColor; }
    .tab:hover { opacity: 0.65; }
    .tab.on { opacity: 1; color: var(--vsc-neon); }
    .tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0,229,255,0.4)); stroke: var(--vsc-neon); }
    .body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0,229,255,0.15) transparent; text-align: left; overscroll-behavior: none; -webkit-overflow-scrolling: touch; }
    .body::-webkit-scrollbar { width: 4px; } .body::-webkit-scrollbar-thumb { background: rgba(0,229,255,0.2); border-radius: 2px; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); }
    .row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; }
    .row .ctrl { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: flex-end; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; margin: 0; }
    input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255,255,255,0.08) var(--fill, 50%)); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0,0,0,0.3); box-shadow: 0 0 8px rgba(0,229,255,0.4); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); }
    .val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); }
    .tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255,255,255,0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.06); }
    .tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0,229,255,0.2); }
    .tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255,255,255,0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; }
    .tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.6); }
    .btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-weight: 500; }
    .btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.12); }
    .chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; }
    .chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: 11px; font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255,255,255,0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; }
    .chip:hover { background: rgba(255,255,255,0.07); }
    .chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.1); }
    .sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 8px 0; }
    .rate-display { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xxl); font-weight: 800; text-align: center; padding: 8px 0; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0,229,255,0.2)); }
    .fine-row { display: flex; gap: 4px; justify-content: center; padding: 4px 0; }
    .fine-btn { padding: 2px 4px; min-height: 24px; min-width: 32px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); }
    .fine-btn:hover { background: rgba(255,255,255,0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
    .info-bar { font-family: var(--vsc-font-mono); font-size: 12px; opacity: 0.8; padding: 4px 0 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: var(--vsc-neon); text-align: left; }
    @media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } }
    @media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } }`;

    function getMountTarget() { const fs = document.fullscreenElement || document.webkitFullscreenElement; if (fs) return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs; return document.documentElement || document.body; }
    const HOST_STYLE_NORMAL = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
    const HOST_STYLE_FS = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';

    let _lastMount = null, _qbarHasVideo = false, _lastIsFs = null;

    function reparent() {
      if (!quickBarHost) return;
      const target = getMountTarget();
      if (!target) return;
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);

      if (target !== _lastMount) {
        _lastMount = target;
        if (quickBarHost.parentNode !== target) try { target.appendChild(quickBarHost); } catch (_) {}
        if (panelHost && panelHost.parentNode !== target) try { target.appendChild(panelHost); } catch (_) {}
      }

      if (_lastIsFs !== isFs) {
        _lastIsFs = isFs;
        const style = isFs ? HOST_STYLE_FS : HOST_STYLE_NORMAL;
        quickBarHost.style.cssText = style;
        if (panelHost) panelHost.style.cssText = style;
        if (!_qbarHasVideo) quickBarHost.style.setProperty('display', 'none', 'important');
      }

      if (panelHost && panelOpen && panelEl) panelEl.style.pointerEvents = 'auto';
    }

    function onFullscreenChange() {
      reparent();
      setTimeout(reparent, 80);
      setTimeout(reparent, 400);
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        _lastMount = null;
        _lastIsFs = null;
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
      if (has && !_qbarHasVideo) {
        _qbarHasVideo = true;
        quickBarHost.style.removeProperty('display');
      } else if (!has && _qbarHasVideo) {
        _qbarHasVideo = false;
        quickBarHost.style.setProperty('display', 'none', 'important');
        if (panelOpen) togglePanel(false);
      }
    }

    function updateTabIndicator(tabBar, tabName) { if (!tabBar) return; const tabs = tabBar.querySelectorAll('.tab'); const idx = ['video','audio','playback'].indexOf(tabName); if (idx < 0) return; const tabEl = tabs[idx]; if (!tabEl) return; requestAnimationFrame(() => { const barRect = tabBar.getBoundingClientRect(); const tabRect = tabEl.getBoundingClientRect(); tabBar.style.setProperty('--tab-indicator-left', `${tabRect.left - barRect.left}px`); tabBar.style.setProperty('--tab-indicator-width', `${tabRect.width}px`); tabs.forEach(t => t.classList.toggle('on', t.dataset.t === tabName)); }); }

    function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
    function mkSep() { return h('div', { class: 'sep' }); }

    function mkSlider(path, min, max, step) { const s = step || ((max - min) / 100); const digits = s >= 1 ? 0 : 2; const inp = h('input', { type: 'range', min, max, step: s }); const valEl = h('span', { class: 'val' }); function updateUI(v) { inp.value = String(v); valEl.textContent = Number(v).toFixed(digits); inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`); } inp.addEventListener('input', () => { Store.set(path, parseFloat(inp.value)); updateUI(parseFloat(inp.value)); Scheduler.request(); }); const sync = () => updateUI(Number(Store.get(path) ?? min)); tabFns.push(sync); sync(); return [inp, valEl]; }

    function mkToggle(path, onChange) { const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' }); function sync() { const on = !!Store.get(path); el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); } el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); else Scheduler.request(); }); tabFns.push(sync); sync(); return el; }

    function chipRow(label, path, chips) { const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label)); const row = h('div', { class: 'chips' }); for (const ch of chips) row.appendChild(h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l)); row.addEventListener('click', e => { const chip = e.target.closest('.chip'); if (!chip) return; Store.set(path, chip.dataset.v); requestAnimationFrame(() => { for (const c of row.children) c.classList.toggle('on', c.dataset.v === chip.dataset.v); }); Scheduler.request(); }); const sync = () => { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); }; wrap.appendChild(row); tabFns.push(sync); sync(); return wrap; }

    function buildVideoTab() {
      const w = h('div', {});
      const infoBar = h('div', { class: 'info-bar' });
      const updateInfo = () => { const v = __internal._activeVideo; const p = Store.get(P.V_PRE_S); const lbl = p === 'none' ? 'OFF' : p === 'off' ? 'AUTO' : PRESETS.detail[p]?.label || p; if (!v?.isConnected) { infoBar.textContent = `영상 없음 │ 샤프닝: ${lbl}`; return; } const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0; infoBar.textContent = nW ? `원본 ${nW}×${nH} → 출력 ${dW}×${dH} │ 샤프닝: ${lbl}` : `로딩 대기중... │ 샤프닝: ${lbl}`; };
      
      tabSignalCleanups.push(Scheduler.onSignal(updateInfo)); 
      Store.sub(P.V_PRE_S, updateInfo); tabFns.push(updateInfo);
      w.append(infoBar, mkSep());

      if (IS_FIREFOX) {
        w.append(h('div', { style: 'font-size:10px;opacity:.7;padding-bottom:8px;color:var(--vsc-amber)' }, '⚠️ Firefox에서는 SVG 기반 수동 톤 보정이 지원되지 않습니다.'));
      }

      w.append(chipRow('디테일 프리셋', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: PRESETS.detail[k].label || k }))), mkRow('강도 믹스', ...mkSlider(P.V_PRE_MIX, 0, 1, 0.01)), mkSep());

      const MANUAL_PRESETS = [ { n: 'OFF', v: [0,0,0,0] }, { n: '선명', v: [0,15,0,0] }, { n: '영화', v: [20,15,10,-18] }, { n: '복원', v: [45,50,5,0] }, { n: '심야', v: [60,20,0,15] }, { n: '아트', v: [5,45,15,-25] } ];
      const manualHeader = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' }, h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '수동 보정'), h('div', { style: 'display:flex;gap:4px' }, ...MANUAL_PRESETS.map(p => { const btn = h('button', { class: 'fine-btn' }, p.n); btn.onclick = () => { Store.batch('video', { manualShadow: p.v[0], manualRecovery: p.v[1], manualBright: p.v[2], manualTemp: p.v[3] }); Scheduler.request(); tabFns.forEach(f => f()); }; const syncBtn = () => { const match = [Store.get(P.V_MAN_SHAD), Store.get(P.V_MAN_REC), Store.get(P.V_MAN_BRT), Store.get(P.V_MAN_TEMP)].every((val, i) => val === p.v[i]); btn.style.background = match ? 'var(--vsc-neon-dim)' : 'rgba(255,255,255,0.03)'; btn.style.color = match ? 'var(--vsc-neon)' : 'rgba(255,255,255,0.6)'; btn.style.borderColor = match ? 'var(--vsc-neon-border)' : 'rgba(255,255,255,0.06)'; }; tabFns.push(syncBtn); syncBtn(); return btn; })));
      w.append(manualHeader);

      function mkSliderWithFine(label, path, min, max, step, fineStep) { const [slider, valEl] = mkSlider(path, min, max, step); const mkFine = (delta, text) => { const btn = h('button', { class: 'fine-btn', style: 'font-size:11px' }, text); btn.addEventListener('click', () => { Store.set(path, CLAMP(Math.round((Number(Store.get(path)) || 0) + delta), min, max)); Scheduler.request(); tabFns.forEach(f => f()); }); return btn; }; const resetBtn = h('button', { class: 'fine-btn', style: 'min-width:24px;font-size:10px;opacity:.6' }, '0'); resetBtn.addEventListener('click', () => { Store.set(path, 0); Scheduler.request(); tabFns.forEach(f => f()); }); return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn))); }

      w.append(mkSliderWithFine('암부 부스트', P.V_MAN_SHAD, 0, 100, 1, 5), mkSliderWithFine('디테일 복원', P.V_MAN_REC, 0, 100, 1, 5), mkSliderWithFine('노출 보정', P.V_MAN_BRT, 0, 100, 1, 5), mkSliderWithFine('색온도', P.V_MAN_TEMP, -50, 50, 1, 5), mkSep());

      const brtBtns = [], brtChips = h('div', { class: 'chips' });
      SCR_BRT_LABELS.forEach((label, idx) => {
        if (idx === 0) return;
        const chip = h('span', { class: 'chip', 'data-v': String(idx) }, '☀ ' + label);
        chip.addEventListener('click', () => cycleScrBrtTo(idx));
        brtBtns.push(chip);
        brtChips.appendChild(chip);
      });
      const brtResetBtn = h('button', { class: 'chip', style: 'margin-left:auto;flex:none;width:70px;font-size:10px;border-color:var(--vsc-text-muted);color:#fff!important;' }, '리셋(OFF)');
      brtResetBtn.addEventListener('click', () => cycleScrBrtTo(0));
      const brtValLabel = h('span', { style: 'font-size:11px;color:var(--vsc-neon);margin-left:6px' }, '');
      function cycleScrBrtTo(idx) { Store.set(P.APP_SCREEN_BRT, idx); applyScrBrt(idx); syncBrt(); }
      function syncBrt() { const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0; brtBtns.forEach(btn => btn.classList.toggle('on', btn.dataset.v === String(cur))); brtResetBtn.classList.toggle('on', cur === 0); brtValLabel.textContent = SCR_BRT_LABELS[cur]; }
      tabFns.push(syncBrt); syncBrt();
      w.append(h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' }, h('div', { style: 'display:flex;align-items:center' }, h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '화면 조도'), brtValLabel), brtResetBtn), brtChips);
      return w;
    }

    function buildAudioTab() {
      const w = h('div', {});
      w.append(mkRow('오디오 평준화', mkToggle(P.A_EN, () => Audio.setTarget(__internal._activeVideo))), mkRow('평준화 강도', ...mkSlider(P.A_STR, 0, 100, 1)), mkSep());
      w.append(h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0;text-align:left;line-height:1.5' }, '큰 소리는 줄이고 작은 소리는 키워서 볼륨 편차를 줄입니다. 광고/폭발음 등 갑작스런 큰 소리를 방지합니다.'));
      const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0;text-align:left;' }, '상태: 대기');
      
      tabSignalCleanups.push(Scheduler.onSignal(() => { if (!panelOpen) return; const hooked = Audio.isHooked(), bypassed = Audio.isBypassed(); status.textContent = !Audio.hasCtx() ? '상태: 대기' : (hooked && !bypassed) ? '상태: 활성 (평준화 처리 중)' : bypassed ? '상태: 바이패스 (원본 출력)' : '상태: 준비 (연결 대기)'; }));
      w.append(status);
      if (IS_FIREFOX) w.append(h('div', { style: 'font-size:10px;opacity:.4;padding:4px 0;color:var(--vsc-amber)' }, 'Firefox에서는 오디오 평준화가 지원되지 않습니다.'));
      return w;
    }

    function buildPlaybackTab() {
      const w = h('div', {});
      w.append(mkRow('속도 제어', mkToggle(P.PB_EN, () => Scheduler.request())));

      const rateDisplay = h('div', { class: 'rate-display' });
      function syncRate() { rateDisplay.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }
      tabFns.push(syncRate); syncRate(); w.append(rateDisplay);

      const chipRow2 = h('div', { class: 'chips' });
      function syncChips() {
        const cur = Number(Store.get(P.PB_RATE)) || 1;
        for (const c of chipRow2.children) c.classList.toggle('on', Math.abs(cur - parseFloat(c.dataset.v)) < 0.01);
      }

      [0.25, 0.5, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0].forEach(p => {
        const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`);
        el.addEventListener('click', () => {
          Store.set(P.PB_RATE, p);
          Store.set(P.PB_EN, true);
          Scheduler.request();
          tabFns.forEach(f => f());
        });
        chipRow2.appendChild(el);
      });

      tabFns.push(syncChips); syncChips(); w.append(chipRow2);

      const fineRow = h('div', { class: 'fine-row' });
      [{ l: '−0.25', d: -0.25 }, { l: '−0.05', d: -0.05 }, { l: '+0.05', d: +0.05 }, { l: '+0.25', d: +0.25 }].forEach(fs => {
        const btn = h('button', { class: 'fine-btn' }, fs.l);
        btn.addEventListener('click', () => {
          Store.set(P.PB_RATE, CLAMP((Number(Store.get(P.PB_RATE)) || 1) + fs.d, 0.07, 5));
          Store.set(P.PB_EN, true);
          Scheduler.request();
          tabFns.forEach(f => f());
        });
        fineRow.appendChild(btn);
      });

      w.append(fineRow, mkRow('속도 슬라이더', ...mkSlider(P.PB_RATE, 0.07, 5, 0.01)));
      return w;
    }

    function buildQuickBar() {
      if (quickBarHost) return;
      quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: HOST_STYLE_NORMAL }); quickBarHost.style.setProperty('display', 'none', 'important');
      _qbarShadow = quickBarHost.attachShadow({ mode: 'closed' });
      const qStyle = document.createElement('style');
      qStyle.textContent = `${CSS_VARS} .qbar { pointer-events:none; position:fixed!important; top:50%!important; right:var(--vsc-qbar-right)!important; transform:translateY(-50%)!important; display:flex!important; align-items:center!important; z-index:2147483647!important; } .qbar .qb-main { pointer-events:auto; width:46px;height:46px; border-radius:50%; background:var(--vsc-glass); border:1px solid rgba(255,255,255,0.08); opacity:0.4; transition:all 0.3s var(--vsc-ease-out); box-shadow:var(--vsc-shadow-fab); display:flex;align-items:center;justify-content:center; cursor:pointer; backdrop-filter:blur(16px) saturate(180%); } .qbar:hover .qb-main { opacity:1; transform:scale(1.08); border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); } .qbar svg { width:22px;height:22px; fill:none; stroke:#fff!important; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; display:block!important; pointer-events:none!important; } .qbar:hover .qb-main svg { stroke:var(--vsc-neon)!important; }`;
      _qbarShadow.appendChild(qStyle);
      const bar = h('div', { class: 'qbar' }); const mainBtn = h('div', { class: 'qb qb-main' });
      mainBtn.appendChild(_s('svg', { viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, _s('circle', { cx: '12', cy: '12', r: '3' }), _s('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })));
      mainBtn.addEventListener('click', e => { e.preventDefault(); togglePanel(); }); bar.append(mainBtn); _qbarShadow.appendChild(bar); getMountTarget().appendChild(quickBarHost);
    }

    function buildPanel() {
      if (panelHost) return;
      panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host', style: HOST_STYLE_NORMAL });
      _shadow = panelHost.attachShadow({ mode: 'closed' });
      _shadow.appendChild(h('style', {}, PANEL_CSS));

      panelEl = h('div', { class: 'panel' });
      panelEl.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
      panelEl.style.overscrollBehavior = 'none';

      const closeBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '✕');
      closeBtn.addEventListener('click', () => togglePanel(false));
      panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), closeBtn));

      const tabBar = h('div', { class: 'tabs' });
      ['video','audio','playback'].forEach(t => {
        const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t });
        tab.append(TAB_ICONS[t]?.() || '', h('span', {}, TAB_LABELS[t]));
        tab.addEventListener('click', () => { activeTab = t; renderTab(); });
        tabBar.appendChild(tab);
      });
      panelEl.appendChild(tabBar);

      const bodyEl = h('div', { class: 'body' });
      bodyEl.style.overscrollBehavior = 'none';
      panelEl.appendChild(bodyEl);

      _shadow.appendChild(panelEl);
      renderTab();
      getMountTarget().appendChild(panelHost);
    }

    function renderTab() { 
      const body = _shadow?.querySelector('.body'); 
      if (!body) return; 
      body.textContent = ''; 
      
      // 탭 전용 리스너만 클린업
      tabSignalCleanups.forEach(cleanup => cleanup());
      tabSignalCleanups.length = 0;
      tabFns.length = 0; 
      
      const w = h('div', {}); 
      if (activeTab === 'video') w.appendChild(buildVideoTab()); 
      else if (activeTab === 'audio') w.appendChild(buildAudioTab()); 
      else if (activeTab === 'playback') w.appendChild(buildPlaybackTab()); 
      body.appendChild(w); 
      
      tabFns.forEach(f => f()); 
      _shadow.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.t === activeTab)); 
      updateTabIndicator(_shadow.querySelector('.tabs'), activeTab); 
    }

    function togglePanel(force) { buildPanel(); panelOpen = force !== undefined ? force : !panelOpen; if (panelOpen) { panelEl.classList.add('open'); panelEl.style.pointerEvents = 'auto'; renderTab(); } else { panelEl.classList.remove('open'); setTimeout(() => { if (!panelOpen) panelEl.style.pointerEvents = 'none'; }, 300); } }

    buildQuickBar(); updateQuickBarVisibility();
    globalSignalCleanups.push(Scheduler.onSignal(updateQuickBarVisibility)); 
    setInterval(updateQuickBarVisibility, 2000);
    document.addEventListener('fullscreenchange', onFullscreenChange); document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    setInterval(() => { if (quickBarHost?.parentNode !== getMountTarget()) reparent(); }, 2000);
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

    const Registry = createRegistry(Scheduler);
    const Targeting = createTargeting();
    const Audio = createAudio(Store, Scheduler);
    const OSD = createOSD();
    const Params = createVideoParams(Store);
    const Filters = createFilters();

    const apply = () => {
      if (!Store.get('app.active')) { for (const v of Registry.videos) Filters.clear(v); Audio.setTarget(null); return; }
      const target = Targeting.pick(Registry.videos);
      if (target) {
        __internal._activeVideo = target;
        Audio.setTarget(target);
        if (Store.get(P.PB_EN)) {
          const rate = CLAMP(Number(Store.get(P.PB_RATE)) || 1, 0.07, 5);
          if (Math.abs(target.playbackRate - rate) > 0.001) {
            let isDRM = target.dataset.vscDrm === "1";
            try { isDRM = isDRM || !!target.mediaKeys; } catch (_) {}

            if (!isDRM) {
              try { target.playbackRate = rate; } catch (_) {}
            } else if (target.playbackRate !== 1.0) {
              try { target.playbackRate = 1.0; } catch (_) {}
            }
          }
        }
      }
      for (const v of Registry.videos) { if (!v.isConnected) continue; const rect = v.getBoundingClientRect(); if (rect.width < 80 || rect.height < 45) { Filters.clear(v); continue; } const params = Params.get(v); const filterStr = Filters.prepare(v, params); Filters.apply(v, filterStr); }
    };
    Scheduler.registerApply(apply);
    Store.sub(P.PB_EN, (enabled) => { if (!enabled && __internal._activeVideo?.isConnected) try { __internal._activeVideo.playbackRate = 1.0; } catch (_) {} });
    document.addEventListener('fullscreenchange', () => Scheduler.request(true));

    createUI(Store, Audio, Registry, Scheduler, OSD);
    __internal.Store = Store; __internal._activeVideo = null;
    try { GM_registerMenuCommand('VSC ON/OFF 토글', () => { const current = Store.get(P.APP_ACT); Store.set(P.APP_ACT, !current); OSD.show(Store.get(P.APP_ACT) ? 'VSC ON' : 'VSC OFF', 1000); Scheduler.request(true); }); } catch (_) {}

    Registry.rescanAll(); apply();
    log.info(`[VSC] v${VSC_VERSION} booted.`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
