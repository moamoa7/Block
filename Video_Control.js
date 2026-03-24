// ==UserScript==
// @name         Video_Control (v216.7.0 - Ultimate Core)
// @namespace    https://github.com/
// @version      216.7.0
// @description  v216.7.0: Fixed double-application, cache key, defensive clamp, CSS cleanup
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

  function VSC_MAIN() {
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com') || location.protocol === 'about:' || location.href === 'about:blank') return;

    /* ══ Symbol-based boot lock & namespace ══ */
    const VSC_SYM = Symbol.for('__VSC__');
    const VSC_BOOT_SYM = Symbol.for('__VSC_BOOT_LOCK__');
    const VSC_INTERNAL_SYM = Symbol.for('__VSC_INTERNAL__');
    const VSC_MANAGED_PROPS = Symbol.for('__VSC_MANAGED_PROPS__');

    if (window[VSC_BOOT_SYM]) return;
    try { Object.defineProperty(window, VSC_BOOT_SYM, { value: true, writable: false, configurable: false, enumerable: false }); }
    catch (e) { window[VSC_BOOT_SYM] = true; }

    if (!window[VSC_INTERNAL_SYM]) {
      try { Object.defineProperty(window, VSC_INTERNAL_SYM, { value: {}, writable: false, configurable: false, enumerable: false }); }
      catch (e) { window[VSC_INTERNAL_SYM] = {}; }
    }
    const __internal = window[VSC_INTERNAL_SYM];

    /* ══ Global Timers & AbortController ══ */
    const __globalHooksAC = new AbortController();
    const __globalSig = __globalHooksAC.signal;
    const _timers = new Map();

    __globalSig.addEventListener('abort', () => {
      for (const [id, t] of _timers) (t === 'T' ? clearTimeout : clearInterval)(id);
      _timers.clear();
    }, { once: true });

    const setTimer = (fn, ms) => {
      if (__globalSig.aborted) return 0;
      const id = setTimeout(() => { _timers.delete(id); fn(); }, ms);
      _timers.set(id, 'T'); return id;
    };
    const clearTimer = id => { if (id) { clearTimeout(id); _timers.delete(id); } };
    const setRecurring = (fn, ms, { maxErrors = 50 } = {}) => {
      if (__globalSig.aborted) return 0;
      let errs = 0;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _timers.delete(id); return; }
        try { fn(); errs = 0; }
        catch (_) { if (++errs >= maxErrors) { clearInterval(id); _timers.delete(id); } }
      }, ms);
      _timers.set(id, 'I'); return id;
    };

    /* ══ Cloudflare Guard ══ */
    const __cfPositive = new WeakSet();
    const __cfNegative = new WeakSet();
    function isCloudflareElement(el) {
      if (!el || el.nodeType !== 1) return false;
      if (__cfPositive.has(el)) return true;
      if (__cfNegative.has(el)) return false;
      let hit = false;
      const tag = el.tagName;
      if (tag === 'IFRAME') {
        const src = el.src || '';
        hit = src.includes('challenges.cloudflare.com') || src.includes('cloudflare.com/cdn-cgi') || src.includes('hcaptcha.com') || src.includes('recaptcha');
      }
      if (!hit) {
        const cls = el.className?.toString?.() || '';
        hit = cls.includes('cf-turnstile') || cls.includes('cf-challenge') || cls.includes('g-recaptcha') || cls.includes('h-captcha');
      }
      if (!hit) hit = !!(el.hasAttribute?.('data-sitekey'));
      if (hit) __cfPositive.add(el); else __cfNegative.add(el);
      return hit;
    }
    function isInsideCloudflareWidget(el) {
      if (!el) return false;
      let node = el;
      for (let d = 0; node && d < 10; d++) {
        if (__cfPositive.has(node)) return true;
        if (isCloudflareElement(node)) return true;
        node = node.parentElement;
      }
      return false;
    }

    /* ══ Mobile & Browser detection ══ */
    const detectMobile = () => navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_FIREFOX = navigator.userAgent.includes('Firefox');

    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      IS_FIREFOX: IS_FIREFOX,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '')
    });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true });
    const VSC_VERSION = '216.7.0';

    const log = {
      info: (...args) => console.info('[VSC]', ...args),
      warn: (...args) => console.warn('[VSC]', ...args),
      error: (...args) => console.error('[VSC]', ...args)
    };

    /* ══ Storage keys ══ */
    function normalizeHostnameForStorage(h) {
      const parts = h.split('.');
      if (parts.length > 2 && /^\d{1,3}$/.test(parts[0])) return parts.slice(1).join('.');
      return h;
    }
    const STORAGE_KEY = 'vsc_v2_' + normalizeHostnameForStorage(location.hostname) + (location.pathname.startsWith('/shorts') ? '_shorts' : '');

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));
    const SHARP_CAP = 0.60; // ★ 전역 상수로 승격

    /* ══ attachShadow Patch ══ */
    if (FEATURE_FLAGS.trackShadowRoots) {
      __internal._onShadow = null;
      const _origAttach = Element.prototype.attachShadow;
      if (typeof _origAttach === 'function' && !_origAttach[VSC_SYM]) {
        const patchedAttach = function (init) {
          const sr = _origAttach.call(this, init);
          const internalRef = window[VSC_INTERNAL_SYM];
          if (internalRef?._onShadow && !__globalSig.aborted) {
            if (!isInsideCloudflareWidget(this)) queueMicrotask(() => internalRef._onShadow(this, sr));
          }
          return sr;
        };
        patchedAttach[VSC_SYM] = true;
        patchedAttach.__vsc_original = _origAttach;
        Element.prototype.attachShadow = patchedAttach;
        __globalSig.addEventListener('abort', () => {
          try { if (Element.prototype.attachShadow === patchedAttach) Element.prototype.attachShadow = _origAttach; } catch (_) {}
        }, { once: true });
      }
    }

    /* ══ StyleGuard ══ */
    function vscSetStyle(el, prop, value, priority = 'important') {
      if (!el?.style) return;
      let managed = el[VSC_MANAGED_PROPS];
      if (!managed) { managed = Object.create(null); el[VSC_MANAGED_PROPS] = managed; }
      if (!(prop in managed)) managed[prop] = el.style.getPropertyValue(prop) || '';
      el.style.setProperty(prop, value, priority);
    }

    function vscApplyFilterStyles(el, filterStr, isZoomed) {
      if (!el?.style) return;
      let managed = el[VSC_MANAGED_PROPS];
      if (!managed) { managed = Object.create(null); el[VSC_MANAGED_PROPS] = managed; }

      const props = ['filter', '-webkit-filter', 'will-change', 'contain', 'background-color', 'backface-visibility', 'transition'];
      for (const p of props) if (!(p in managed)) managed[p] = el.style.getPropertyValue(p) || '';

      const wc = isZoomed ? 'filter, transform' : 'filter';
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('contain', 'content', 'important');
      el.style.setProperty('will-change', wc, 'important');
      el.style.setProperty('filter', filterStr, 'important');
      el.style.setProperty('-webkit-filter', filterStr, 'important');
      el.style.setProperty('background-color', '#000', 'important');
      el.style.setProperty('backface-visibility', 'hidden', 'important');
    }

    function vscClearAllStyles(el) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed) return;
      for (const prop in managed) {
        const saved = managed[prop];
        if (saved) el.style.setProperty(prop, saved);
        else el.style.removeProperty(prop);
      }
      delete el[VSC_MANAGED_PROPS];
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

    const _PRESET_SHARP_LUT = (() => {
      const lut = {};
      for (const [key, d] of Object.entries(PRESETS.detail)) lut[key] = (d.sharpAdd + d.sharp2Add * 0.6 + d.clarityAdd * 0.4) * 0.01;
      return lut;
    })();

    const _TEMP_RGB_LUT = (() => {
      const lut = new Array(101);
      for (let i = 0; i <= 100; i++) {
        const t = VSC_CLAMP((i - 50) * 0.02, -1, 1);
        if (t > -0.001 && t < 0.001) { lut[i] = { rs: 1, gs: 1, bs: 1 }; }
        else {
          const r = 1 + 0.14 * t, g = 1 - 0.02 * (t < 0 ? -t : t), b = 1 - 0.14 * t;
          const inv = 1 / Math.max(r, b);
          lut[i] = { rs: r * inv, gs: g * inv, bs: b * inv };
        }
      }
      return lut;
    })();
    function tempToRgbGain(temp) { return _TEMP_RGB_LUT[VSC_CLAMP(Math.round(Number(temp) || 0) + 50, 0, 100)]; }

    /* ══ Defaults & Paths ══ */
    const DEFAULTS = {
      video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0 },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, screenBright: 0 }
    };
    const P = { APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_SCREEN_BRT: 'app.screenBright', V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix', V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery', V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' };

    /* ══ Local Store ══ */
    function createLocalStore(defaults, scheduler, Utils) {
      let rev = 0;
      const listeners = new Map();
      const state = Utils.deepClone(defaults);

      const emit = (key, val) => { const a = listeners.get(key); if (a) { for (let i = 0; i < a.length; i++) try { a[i](val); } catch (_) {} } };

      return {
        state, rev: () => rev,
        getCatRef: (cat) => state[cat],
        get: (p) => { const parts = p.split('.'); return parts.length > 1 ? state[parts[0]]?.[parts[1]] : state[parts[0]]; },
        set: (p, val) => {
          const parts = p.split('.'); const c = parts[0], k = parts[1];
          if (k != null) {
            if (Object.is(state[c]?.[k], val)) return;
            state[c][k] = val; rev++; emit(p, val); scheduler.request();
          } else {
            if (Object.is(state[c], val)) return;
            state[c] = val; rev++; emit(c, val); scheduler.request();
          }
        },
        batch: (cat, obj) => {
          let changed = false;
          for (const [k, v] of Object.entries(obj)) { if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); } }
          if (changed) { rev++; scheduler.request(); }
        },
        sub: (k, f) => { if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(f); },
        load: (data) => {
          if (!data) return;
          for (const c of ['video', 'audio', 'playback', 'app']) { if (data[c]) Object.assign(state[c], data[c]); }
          rev++;
        }
      };
    }

    /* ══ Utils ══ */
    function createUtils() {
      const _SVG_NS = 'http://www.w3.org/2000/svg';
      const _SVG_TAGS = new Set(['svg', 'defs', 'filter', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'feConvolveMatrix', 'feColorMatrix', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feComposite', 'feBlend', 'g', 'path', 'circle', 'rect', 'line', 'text', 'polyline']);
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const isSvgEl = props.ns === 'svg' || _SVG_TAGS.has(tag);
          const el = isSvgEl ? document.createElementNS(_SVG_NS, tag) : document.createElement(tag);
          for (const [k, v] of Object.entries(props)) {
            if (k === 'ns') continue;
            if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), (e) => { if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation(); v(e); }); }
            else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
            else if (k === 'class') { if (isSvgEl) el.setAttribute('class', v); else el.className = v; }
            else if (v !== false && v != null) el.setAttribute(k, v);
          }
          children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
          return el;
        },
        deepClone: (obj) => JSON.parse(JSON.stringify(obj)),
        createCappedMap: (max = 64) => {
          const m = new Map();
          return {
            get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
            set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }
          };
        }
      };
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

    /* ══ Registry (Ultimate Core: WorkQ + Shadow DOM tracking) ══ */
    function createRegistry(scheduler, bus) {
      const videos = new Set();
      const shadowRootsLRU = [];
      const observedShadowHosts = new WeakSet();
      const SHADOW_ROOT_LRU_MAX = 16;

      let __refreshRafId = 0;
      function requestRefreshCoalesced() {
        if (__refreshRafId) return;
        __refreshRafId = requestAnimationFrame(() => { __refreshRafId = 0; scheduler.request(); bus.signal(); });
      }

      const _observerCleanupRegistry = new FinalizationRegistry(({ mo, observers }) => {
        try { mo.disconnect(); observers.delete(mo); } catch (_) {}
      });

      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          if (e.isIntersecting || e.intersectionRatio > 0) changed = true;
        }
        if (changed) requestRefreshCoalesced();
      }, { root: null, threshold: [0, 0.05, 0.5], rootMargin: '150px' }) : null;

      const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          if (e.target.tagName === 'VIDEO') changed = true;
        }
        if (changed) requestRefreshCoalesced();
      }) : null;

      const observeVideo = (el) => {
        if (!el || el.tagName !== 'VIDEO' || videos.has(el)) return;
        videos.add(el);
        if (io) io.observe(el);
        if (ro) ro.observe(el);

        const req = () => { scheduler.request(); bus.signal(); };
        el.addEventListener('loadedmetadata', req, { passive: true });
        el.addEventListener('resize', req, { passive: true });
        el.addEventListener('playing', req, { passive: true });

        let lastT = 0;
        el.addEventListener('timeupdate', () => {
          const now = performance.now();
          if (now - lastT > 1000) { lastT = now; req(); }
        }, { passive: true });

        req();
      };

      const scanNode = n => {
        if (!n) return;
        if (n.nodeType === 1) {
          if (__cfPositive.has(n)) return;
          if (n.tagName === 'VIDEO') { observeVideo(n); return; }
          if (n.shadowRoot) {
            if (!observedShadowHosts.has(n)) {
               observedShadowHosts.add(n);
               if (shadowRootsLRU.length >= SHADOW_ROOT_LRU_MAX) {
                 const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
                 if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift();
               }
               shadowRootsLRU.push({ host: n, root: n.shadowRoot });
               connectObserver(n.shadowRoot);
            }
            WorkQ.enqueue(n.shadowRoot);
          }
          if (!n.childElementCount) return;
          try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch(_) {}
        } else if (n.nodeType === 11) {
          try { const vs = n.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch(_) {}
        }
      };

      const WorkQ = (() => {
        const MAX = 500, q = []; let head = 0, epoch = 1, scheduled = false;
        const mark = new WeakMap();
        const mc = new MessageChannel();
        let idleCb = null;
        mc.port1.onmessage = () => { if (idleCb) { const cb = idleCb; idleCb = null; cb(); } };

        const schedIdle = (fn) => {
          if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 120 });
          else { idleCb = fn; mc.port2.postMessage(null); }
        };

        let BATCH_SIZE = 12;
        const drain = () => {
          scheduled = false;
          const t0 = performance.now();
          let count = 0;
          while (count < BATCH_SIZE && head < q.length) { scanNode(q[head++]); count++; }
          const elapsed = performance.now() - t0;

          if (elapsed < 1 && BATCH_SIZE < 48) BATCH_SIZE = Math.min(48, BATCH_SIZE + 4);
          else if (elapsed > 4 && BATCH_SIZE > 4) BATCH_SIZE = Math.max(4, BATCH_SIZE - 4);

          if (head >= q.length) { q.length = 0; head = 0; epoch++; }
          else { scheduled = true; schedIdle(drain); }
        };

        return Object.freeze({
          enqueue(n) {
            if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
            if (q.length - head >= MAX) { q.splice(0, head + (q.length >> 1)); head = 0; epoch++; }
            if (mark.get(n) === epoch) return;
            mark.set(n, epoch); q.push(n);
            if (!scheduled) { scheduled = true; schedIdle(drain); }
          }
        });
      })();

      function nodeMayContainVideo(n) {
        if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false;
        if (n.nodeType === 1) {
          if (n.tagName === 'VIDEO') return true;
          if ((n.childElementCount || 0) === 0) return false;
          try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { return false; }
        }
        try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; }
      }

      const observers = new Set();
      const isVscOwnNode = (n) => {
        if (!n || n.nodeType !== 1) return false;
        if (n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host' || n.id === 'vsc-osd') return true;
        const tag = n.tagName;
        if ((tag === 'svg' || tag === 'SVG') && n.querySelector?.('[id^="vsc-"]')) return true;
        return false;
      };

      const connectObserver = (root) => {
        if (!root) return;
        const hostRef = (root instanceof ShadowRoot && root.host) ? new WeakRef(root.host) : null;

        const mo = new MutationObserver((muts) => {
          if (__globalSig.aborted) { mo.disconnect(); observers.delete(mo); return; }
          if (hostRef) {
            const host = hostRef.deref();
            if (!host || !host.isConnected) { mo.disconnect(); observers.delete(mo); return; }
          } else if (root !== document && root !== document.body && root !== document.documentElement) {
            const host = root.host || root;
            if (host && typeof host.isConnected === 'boolean' && !host.isConnected) { mo.disconnect(); observers.delete(mo); return; }
          }

          let touchedVideoTree = false;
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              for (const n of m.addedNodes) {
                if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
                if (n.nodeType === 1 && (isVscOwnNode(n) || isCloudflareElement(n))) continue;
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
        if (hostRef) {
          const host = hostRef.deref();
          if (host) _observerCleanupRegistry.register(host, { mo, observers });
        }
        WorkQ.enqueue(root);
      };

      const refreshObservers = () => {
        for (const o of observers) o.disconnect(); observers.clear();
        for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); }
        const root = document.body || document.documentElement;
        if (root) { WorkQ.enqueue(root); connectObserver(root); }
      };

      __internal._onShadow = (host, sr) => {
        try {
          if (!sr || !host || observedShadowHosts.has(host)) return;
          observedShadowHosts.add(host);
          if (shadowRootsLRU.length >= SHADOW_ROOT_LRU_MAX) {
            const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
            if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift();
          }
          shadowRootsLRU.push({ host, root: sr });
          connectObserver(sr);
        } catch (_) {}
      };

      refreshObservers();

      __globalSig.addEventListener('abort', () => {
        for (const o of observers) { try { o.disconnect(); } catch (_) {} }
        observers.clear();
        if (io) { try { io.disconnect(); } catch (_) {} }
        if (ro) { try { ro.disconnect(); } catch (_) {} }
      }, { once: true });

      setInterval(() => {
        let removed = 0;
        for (const el of videos) {
          if (!el || !el.isConnected) {
            videos.delete(el);
            vscClearAllStyles(el);
            if (io) { try { io.unobserve(el); } catch (_) {} }
            if (ro) { try { ro.unobserve(el); } catch (_) {} }
            removed++;
          }
        }
        if (removed) requestRefreshCoalesced();
      }, 5000);

      // ★ shadowRootsLRU를 외부에 노출하여 updateQuickBarVisibility에서 활용
      return { videos, shadowRootsLRU, rescanAll: () => scanNode(document.body || document.documentElement) };
    }

    /* ══ Targeting ══ */
    function createTargeting() {
      return {
        pickFastActiveOnly: (videos) => {
          let best = null, bestScore = -Infinity;
          for (const v of videos) {
            if (!v.isConnected) continue;
            const r = v.getBoundingClientRect();
            const area = r.width * r.height;

            if (area === 0 && v.readyState === 0 && v.paused) continue;

            let s = Math.log2(1 + Math.max(0, area));
            if (!v.paused && !v.ended) s += 25.0;
            if (v.currentTime > 0) s += 5.0;
            if (!v.muted && v.volume > 0.01) s += 5.0;

            if (s > bestScore) { bestScore = s; best = v; }
          }
          return { target: best };
        }
      };
    }

    /* ══ Audio Engine (Native Web Audio) ══ */
    function createAudio(store) {
      let ctx = null, comp = null, limiter = null, bassFilter = null, voiceFilter = null, wetInGain = null, masterOut = null;
      let currentSrc = null, targetVideo = null, bypassMode = false;
      const srcMap = new WeakMap();
      let makeupDbEma = 0;

      function initCtx() {
        if (ctx) return true;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { return false; }

        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -24; comp.knee.value = 6; comp.ratio.value = 3.5;
        comp.attack.value = 0.003; comp.release.value = 0.18;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.5; limiter.ratio.value = 20;
        limiter.attack.value = 0.0005; limiter.release.value = 0.09;

        bassFilter = ctx.createBiquadFilter(); bassFilter.type = 'lowshelf'; bassFilter.frequency.value = 120;
        voiceFilter = ctx.createBiquadFilter(); voiceFilter.type = 'peaking'; voiceFilter.frequency.value = 3000; voiceFilter.Q.value = 1.6;

        wetInGain = ctx.createGain(); masterOut = ctx.createGain();
        bassFilter.connect(voiceFilter); voiceFilter.connect(comp); comp.connect(wetInGain); wetInGain.connect(limiter); limiter.connect(masterOut); masterOut.connect(ctx.destination);
        return true;
      }

      function connectViaCaptureStream(video) {
        if (!ctx) return null;
        let stream = video.__vsc_cached_stream;
        if (!stream) {
          try { stream = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null); } catch (_) {}
          if (stream) video.__vsc_cached_stream = stream;
        }
        if (!stream || stream.getAudioTracks().length === 0) return null;
        try { const source = ctx.createMediaStreamSource(stream); source.__vsc_isCaptureStream = true; source.__vsc_origMuted = video.muted; video.muted = true; return source; } catch (_) { return null; }
      }

      function connectSource(video) {
        if (!initCtx()) return false;
        let s = srcMap.get(video);
        if (!s) { try { s = ctx.createMediaElementSource(video); } catch (_) { s = connectViaCaptureStream(video); } if (s) srcMap.set(video, s); }
        if (!s) { bypassMode = true; return false; }
        try { s.disconnect(); } catch (_) {}
        s.connect(bassFilter); currentSrc = s; bypassMode = false; return true;
      }

      function disconnectCurrent() {
        if (!currentSrc) return;
        if (currentSrc.__vsc_isCaptureStream && targetVideo) { if (targetVideo.muted && currentSrc.__vsc_origMuted === false) targetVideo.muted = false; }
        try { currentSrc.disconnect(); } catch (_) {}
        if (!currentSrc.__vsc_isCaptureStream && ctx) { try { currentSrc.connect(ctx.destination); } catch (_) {} }
        currentSrc = null;
      }

      function updateMix() {
        if (!ctx || bypassMode) return;
        const enabled = !!(store.get(P.A_EN) && store.get(P.APP_ACT));
        const boostDb = Number(store.get(P.A_BST) || 0);

        if (enabled && currentSrc) {
          let redDb = 0;
          try { const r = comp?.reduction; redDb = (typeof r === 'number') ? r : (r?.value ?? 0); } catch (_) {}
          const makeupDbTarget = Math.max(0, -redDb - 2) * 0.38;
          makeupDbEma += (makeupDbTarget - makeupDbEma) * 0.05;
          const finalGain = Math.pow(10, boostDb / 20) * Math.pow(10, makeupDbEma / 20);
          try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; }
        } else {
          try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; }
        }
      }

      function setTarget(video) {
        if (CONFIG.IS_FIREFOX) return;
        if (video === targetVideo) { updateMix(); return; }
        disconnectCurrent(); targetVideo = video;
        if (video) { if (connectSource(video)) updateMix(); }
      }

      window.addEventListener('pointerdown', () => { if (ctx && ctx.state === 'suspended') ctx.resume(); }, { passive: true, once: true });
      return { setTarget, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, isBypassed: () => bypassMode };
    }

    /* ══ SVG Filter Engine ══ */
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(32);

      const _toneStrLut = new Array(10001); let _toneStrLutReady = false;
      function ensureToneStrLut() { if (_toneStrLutReady) return; for (let i = 0; i <= 10000; i++) _toneStrLut[i] = (i / 10000).toFixed(4); _toneStrLutReady = true; }

      function getToneTableCached(steps, gain, contrast, brightOffset, gamma, toe, mid, shoulder) {
        const key = `${steps}|${(gain*100+.5)|0}|${(contrast*100+.5)|0}|${(gamma*100+.5)|0}|t${(toe*1000+.5)|0}|m${(mid*1000+.5)|0}|s${(shoulder*1000+.5)|0}`;
        const hit = toneCache.get(key); if (hit) return hit;
        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const out = new Array(steps); let prev = 0;
        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = Number(gamma); const toeFactor = Number(toe) || 0; const midFactor = Number(mid) || 0; const shoulderFactor = Number(shoulder) || 0;
        ensureToneStrLut();

        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1); let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = x * contrast + intercept; x = clamp(x, 0, 1);
          if (toeFactor > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toeFactor * (1.0 - t) * (t * t) * (1.0 - x); }
          if (midFactor > 0.001) { const midCenter = 0.45, sigma = 0.18; const midWeight = Math.exp(-((x0 - midCenter) * (x0 - midCenter)) / (2 * sigma * sigma)); x = clamp(x + (x0 - midCenter) * midFactor * midWeight * 1.5, 0, 1); }
          if (shoulderFactor > 0.001) { const hiWeight = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = clamp(x + shoulderFactor * 0.6 * x0 + shoulderFactor * hiWeight * hiWeight * 0.5 * (1.0 - x), 0, 1); }
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;
          out[i] = _toneStrLut[Math.min(10000, Math.max(0, Math.round(x * 10000)))];
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      function mkXfer(attrs, funcDefaults, withAlpha = false) {
        const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs });
        const channels = ['R', 'G', 'B']; if (withAlpha) channels.push('A');
        for (const ch of channels) {
          const funcAttrs = { ns: 'svg' };
          if (ch === 'A') funcAttrs.type = 'identity'; else { for (const [k, v] of Object.entries(funcDefaults)) funcAttrs[k] = v; }
          xfer.append(h(`feFunc${ch}`, funcAttrs));
        }
        return xfer;
      }

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
        const defs = h('defs', { ns: 'svg' }); svg.append(defs);
        const fid = `vsc-f-${config.VSC_ID}`;
        const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
        const fTone = mkXfer({ in: 'conv', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
        const fSat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1.0', result: 'final' });
        filter.append(fConv, fTone, fTemp, fSat); defs.append(filter);

        const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
        if (target?.appendChild) target.appendChild(svg);

        const toneFuncR = fTone.querySelector('feFuncR'), toneFuncG = fTone.querySelector('feFuncG'), toneFuncB = fTone.querySelector('feFuncB');
        const tempChildren = Array.from(fTemp.children);
        return { fid, fConv, toneFuncsRGB: [toneFuncR, toneFuncG, toneFuncB].filter(Boolean), tempFuncR: tempChildren.find(f => f.tagName.includes('R')), tempFuncG: tempChildren.find(f => f.tagName.includes('G')), tempFuncB: tempChildren.find(f => f.tagName.includes('B')), fSat, st: { lastKey: '', toneKey: '', toneHash: 0, sharpKey: '', desatKey: '', tempKey: '' } };
      }

      function needsSvgFilter(s) {
        if (config.IS_FIREFOX) return false;
        return (Math.abs(s.sharp || 0) > 0.005 || Math.abs(s.toe || 0) > 0.005 || Math.abs(s.mid || 0) > 0.005 || Math.abs(s.shoulder || 0) > 0.005 || Math.abs((s.gain || 1) - 1) > 0.005 || Math.abs((s.gamma || 1) - 1) > 0.005 || Math.abs(s.temp || 0) > 0.5);
      }

      function prepare(video, s) {
        const root = (video.getRootNode?.() instanceof ShadowRoot) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root); if (!dc) { dc = { keyHash: 0, url: '', filterStr: 'none' }; urlCache.set(root, dc); }

        const useSvg = needsSvgFilter(s);

        // ★★★ 수정 1: SVG 경로일 때 CSS brightness/contrast 중복 적용 방지 ★★★
        if (!useSvg) {
          let parts = [];
          if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
          if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
          if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
          return { filterStr: parts.length > 0 ? parts.join(' ') : 'none' };
        }

        let ctx = ctxMap.get(root); if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        const svgHash = (s.sharp || 0) * 1000 + (s.toe || 0) * 100 + (s.temp || 0) * 10 + (s.mid || 0) * 50 + (s.shoulder || 0) * 30;

        if (st.lastKey !== svgHash) {
          st.lastKey = svgHash;
          const toneTable = getToneTableCached(256, s.gain || 1, s.contrast || 1, s.bright * 0.004 || 0, 1 / clamp(s.gamma || 1, 0.1, 5.0), s.toe || 0, s.mid || 0, s.shoulder || 0);
          if (st.toneKey !== toneTable) {
            st.toneKey = toneTable;
            requestAnimationFrame(() => { for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable); });
          }

          const totalS = clamp(Number(s.sharp || 0), 0, SHARP_CAP);
          let kernelStr = '0,0,0, 0,1,0, 0,0,0';
          if (totalS >= 0.005) { const diag = -totalS * 0.5; const edge = -totalS; const center = 1.0 - 4 * edge - 4 * diag; kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`; }
                    const userTemp = tempToRgbGain(s.temp);
          if (st.tempKey !== s.temp) {
            st.tempKey = s.temp;
            requestAnimationFrame(() => {
              ctx.tempFuncR.setAttribute('slope', userTemp.rs);
              ctx.tempFuncG.setAttribute('slope', userTemp.gs);
              ctx.tempFuncB.setAttribute('slope', userTemp.bs);
            });
          }

          if (st.sharpKey !== kernelStr) {
            st.sharpKey = kernelStr;
            const desatVal = totalS > 0.008 ? clamp(1.0 - totalS * 0.1, 0.90, 1.0).toFixed(3) : '1.000';
            requestAnimationFrame(() => {
              ctx.fConv.setAttribute('kernelMatrix', kernelStr);
              ctx.fSat.setAttribute('values', desatVal);
            });
          }
        }

        const url = `url(#${ctx.fid})`;
        // ★★★ 수정 1 (계속): SVG 경로에서는 CSS brightness/contrast를 추가하지 않음 ★★★
        // toe/mid/shoulder가 이미 톤 커브로 처리하므로 _cssBr/_cssCt 중복 배제
        const parts = [url];
        if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
        return { filterStr: parts.join(' ') };
      }

      return {
        prepareCached: (video, s) => prepare(video, s),
        applyFilter: (el, filterResult) => {
          if (!el || !filterResult) return;
          vscApplyFilterStyles(el, filterResult.filterStr, false);
          if (!el[VSC_MANAGED_PROPS]) el[VSC_MANAGED_PROPS] = {};
          el[VSC_MANAGED_PROPS].applied = true;
        },
        clear: (el) => {
          if (!el || !el[VSC_MANAGED_PROPS]?.applied) return;
          vscClearAllStyles(el);
          el[VSC_MANAGED_PROPS].applied = false;
        }
      };
    }

    /* ══ VideoParamsMemo (Smart Cache restored) ══ */
    function createVideoParamsMemo(Store) {
      const cache = new WeakMap();

      function computeResolutionSharpMul(video) {
        const nW = video.videoWidth | 0;
        const nH = video.videoHeight | 0;
        if (nW < 16) return { mul: 0.5, autoBase: 0.10 };

        const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);

        let dW, dH;
        try {
          const rect = video.getBoundingClientRect();
          dW = rect.width || video.clientWidth || video.offsetWidth || nW;
          dH = rect.height || video.clientHeight || video.offsetHeight || nH;
        } catch (_) {
          dW = video.clientWidth || video.offsetWidth || nW;
          dH = video.clientHeight || video.offsetHeight || nH;
        }

        if (dW < 16) return { mul: 0.5, autoBase: 0.10 };

        const ratioW = (dW * dpr) / nW;
        const ratioH = (nH > 16 && dH > 16) ? (dH * dpr) / nH : ratioW;
        const ratio = Math.min(ratioW, ratioH);

        let mul =
          ratio <= 0.30 ? 0.40 :
          ratio <= 0.60 ? 0.40 + (ratio - 0.30) / 0.30 * 0.30 :
          ratio <= 1.00 ? 0.70 + (ratio - 0.60) / 0.40 * 0.30 :
          ratio <= 1.80 ? 1.00 :
          ratio <= 4.00 ? 1.00 - (ratio - 1.80) / 2.20 * 0.30 :
          0.65;

        let autoBase = nW <= 640 ? 0.18 : nW <= 960 ? 0.14 :
                       nW <= 1280 ? 0.13 : nW <= 1920 ? 0.12 : 0.07;

        if (CONFIG.IS_MOBILE) mul = Math.max(mul, 0.72);

        return {
          mul: VSC_CLAMP(mul, 0, 1),
          autoBase: VSC_CLAMP(autoBase * mul, 0, 0.18)
        };
      }

      return {
        get: (video) => {
          const storeRev = Store.rev();
          const nW = video ? (video.videoWidth | 0) : 0;
          const dW = video ? (video.clientWidth || video.offsetWidth || 0) : 0;
          // ★★★ 수정 2: 캐시 키에 dH 추가 ★★★
          const dH = video ? (video.clientHeight || video.offsetHeight || 0) : 0;

          if (video && nW >= 16) {
            const cached = cache.get(video);
            if (cached && cached.rev === storeRev && cached.nW === nW && cached.dW === dW && cached.dH === dH) {
              return cached.out;
            }
          }

          const out = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, toe: 0, mid: 0, shoulder: 0, temp: 0, sharp: 0, _cssBr: 1, _cssCt: 1, _cssSat: 1 };
          const presetS = Store.get(P.V_PRE_S);
          const mix = VSC_CLAMP(Number(Store.get(P.V_PRE_MIX)) || 1, 0, 1);
          const { mul, autoBase } = video ? computeResolutionSharpMul(video) : { mul: 0.5, autoBase: 0.10 };
          const finalMul = (mul === 0.0 && presetS !== 'off') ? 0.50 : mul;

          if (presetS === 'off') out.sharp = autoBase;
          else if (presetS !== 'none') out.sharp = (_PRESET_SHARP_LUT[presetS] || 0) * mix * finalMul;

          // ★★★ 수정 3: sharp에 방어적 SHARP_CAP 클램프 추가 ★★★
          out.sharp = VSC_CLAMP(out.sharp, 0, SHARP_CAP);

          out.toe = VSC_CLAMP(Number(Store.get(P.V_MAN_SHAD)) || 0, 0, 100) * 0.0035;
          out.mid = VSC_CLAMP(Number(Store.get(P.V_MAN_REC)) || 0, 0, 100) * 0.0030;
          out.shoulder = VSC_CLAMP(Number(Store.get(P.V_MAN_BRT)) || 0, 0, 100) * 0.0040;
          out.temp = VSC_CLAMP(Number(Store.get(P.V_MAN_TEMP)) || 0, -50, 50);

          // ★★★ 수정 4: CSS fallback 값은 SVG가 비활성일 때만 의미 있음
          //       Firefox 등 SVG 미지원 경로에서만 사용됨 ★★★
          out._cssBr = 1 + (Number(Store.get(P.V_MAN_BRT)) || 0) * 0.005;
          out._cssCt = 1 + (Number(Store.get(P.V_MAN_REC)) || 0) * 0.005;

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
            el?.remove(); el = document.createElement('div'); el.id = 'vsc-osd'; el.setAttribute('data-vsc-ui', '1');
            el.style.cssText = 'position:fixed!important;top:48px!important;left:50%!important;transform:translateX(-50%) translateY(0)!important;background:rgba(12,12,18,0.85)!important;backdrop-filter:blur(24px) saturate(200%)!important;color:rgba(255,255,255,0.95)!important;padding:10px 28px!important;border-radius:14px!important;border:1px solid rgba(0,229,255,0.15)!important;font:600 13px/1.4 system-ui,sans-serif!important;z-index:2147483647!important;pointer-events:none!important;opacity:0!important;transition:opacity 0.2s, transform 0.3s!important;box-shadow:0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(0,229,255,0.08)!important;text-align:center!important;';
            root.appendChild(el);
          }
          el.textContent = text;
          requestAnimationFrame(() => {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('transform', 'translateX(-50%) translateY(0)', 'important');
          });
          clearTimeout(timerId);
          timerId = setTimeout(() => {
            if (el) {
              el.style.setProperty('opacity', '0', 'important');
              el.style.setProperty('transform', 'translateX(-50%) translateY(-8px)', 'important');
            }
          }, ms);
        }
      };
    }

    /* ══ UI Panel & Single Direct Button ══ */
    function createUI(Store, Bus, Utils, Audio, Registry, Scheduler, OSD) {
      const { h, clamp } = Utils;
      let panelHost = null, panelEl = null, quickBarHost = null;
      let activeTab = 'video', panelOpen = false;
      let _shadow = null, _qbarShadow = null;
      const tabFns = [];
      let __scrBrtOverlay = null;

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const _s = (tag, attrs = {}, ...children) => {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) { if (v != null && v !== false) el.setAttribute(k, String(v)); }
        children.flat().forEach(child => { if (child != null) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
        return el;
      };

      const TAB_ICONS = {
        video: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('rect', { x: 2, y: 4, width: 16, height: 16, rx: 2 }), _s('path', { d: 'M22 7l-6 4 6 4z' })),
        audio: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('path', { d: 'M11 5L6 9H2v6h4l5 4V5z' }), _s('path', { d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
        playback: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }, _s('circle', { cx: 12, cy: 12, r: 10 }), _s('polygon', { points: '10 8 16 12 10 16' }))
      };
      const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생' };

      /* ── Dimmer (Stable UI) ── */
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
        const idx = VSC_CLAMP(Math.round(level), 0, SCR_BRT_LEVELS.length - 1);
        const val = SCR_BRT_LEVELS[idx];
        if (val <= 0) {
          if (__scrBrtOverlay) {
            __scrBrtOverlay.style.setProperty('opacity', '0', 'important');
            setTimeout(() => { if (__scrBrtOverlay && __scrBrtOverlay.style.opacity === '0') __scrBrtOverlay.style.setProperty('display', 'none', 'important'); }, 350);
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
        --vsc-space-xs: 4px; --vsc-space-sm: 6px; --vsc-space-md: 10px; --vsc-space-lg: 14px; --vsc-space-xl: 20px;
        --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-lg: 14px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px;
        --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
        --vsc-font-xs: 10px; --vsc-font-sm: 11px; --vsc-font-md: 13px; --vsc-font-lg: 15px; --vsc-font-xl: 24px; --vsc-font-xxl: 32px;
        --vsc-touch-min: ${CONFIG.IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${CONFIG.IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${CONFIG.IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${CONFIG.IS_MOBILE ? '6px' : '10px'};
        --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
        font-family: var(--vsc-font) !important; font-size: var(--vsc-font-md) !important; color: var(--vsc-text) !important; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      }`;

      // ★★★ 수정 5: PANEL_CSS에서 .qbar 관련 중복 규칙 제거 ★★★
      const PANEL_CSS = `
      ${CSS_VARS}
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; }
      .panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px) !important; top: 50% !important; width: var(--vsc-panel-width) !important; max-height: var(--vsc-panel-max-h) !important; background: var(--vsc-glass) !important; border: 1px solid var(--vsc-glass-border) !important; border-radius: var(--vsc-radius-xl) !important; backdrop-filter: var(--vsc-glass-blur) !important; -webkit-backdrop-filter: var(--vsc-glass-blur) !important; box-shadow: var(--vsc-shadow-panel) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; user-select: none !important; contain: none !important; opacity: 0 !important; transform: translate(16px, -50%) scale(0.92) !important; filter: blur(4px) !important; transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring), filter 0.3s var(--vsc-ease-out) !important; color: var(--vsc-text) !important; font-family: var(--vsc-font) !important; }
      .panel.open { opacity: 1 !important; transform: translate(0, -50%) scale(1) !important; filter: blur(0) !important; pointer-events: auto !important; }
      .panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
      .hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); gap: 10px; position: relative; }
      .hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-shadow: none; }
      .tabs { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.04); position: relative; padding: 0 4px; }
      .tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); }
      .tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; border-bottom: 2px solid transparent; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; position: relative; text-transform: uppercase; color: var(--vsc-text); }
      .tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; transition: opacity 0.2s, filter 0.2s; stroke: currentColor; }
      .tab:hover { opacity: 0.65; }
      .tab.on { opacity: 1; color: var(--vsc-neon); }
      .tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.4)); stroke: var(--vsc-neon); }
      .body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0, 229, 255, 0.15) transparent; text-align: left; }
      .body::-webkit-scrollbar { width: 4px; }
      .body::-webkit-scrollbar-track { background: transparent; }
      .body::-webkit-scrollbar-thumb { background: rgba(0, 229, 255, 0.2); border-radius: 2px; }
      .body::-webkit-scrollbar-thumb:hover { background: rgba(0, 229, 255, 0.35); }
      .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); }
      .row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; color: var(--vsc-text); }
      .row .ctrl { display: flex; align-items: center; gap: var(--vsc-space-sm); flex: 1; justify-content: flex-end; }
      input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; position: relative; margin: 0; }
      input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255, 255, 255, 0.08) var(--fill, 50%)); box-shadow: inset 0 0 4px rgba(0, 229, 255, 0.15); }
      input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0, 0, 0, 0.3); box-shadow: 0 0 8px rgba(0, 229, 255, 0.4), 0 0 2px rgba(0, 229, 255, 0.8); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); transition: box-shadow 0.2s, transform 0.15s var(--vsc-ease-spring); }
      input[type=range]:active::-webkit-slider-thumb { transform: scale(1.25); box-shadow: 0 0 16px rgba(0, 229, 255, 0.6), 0 0 4px rgba(0, 229, 255, 1); }
      .val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); }
      .tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255, 255, 255, 0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; overflow: visible; flex-shrink: 0; border: 1px solid rgba(255, 255, 255, 0.06); }
      .tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0, 229, 255, 0.2); }
      .tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255, 255, 255, 0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; }
      .tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.6); }
      .btn { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-family: var(--vsc-font); font-weight: 500; }
      .btn:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.12); transform: translateY(-1px); }
      .btn:active { transform: translateY(0); }
      .chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; }
      .chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: 11px; font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; color: var(--vsc-text); }
      .chip:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.10); }
      .chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0, 229, 255, 0.1); }
      .sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.06), transparent); margin: 8px 0; }
      .metrics-footer { font-family: var(--vsc-font-mono); font-size: 11px; opacity: 0.6; padding: 6px 16px 8px; border-top: 1px solid rgba(255, 255, 255, 0.03); line-height: 1.6; display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--vsc-text); justify-content: flex-start; }
      .rate-display { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-xxl); font-weight: 800; text-align: center; padding: 8px 0; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0, 229, 255, 0.2)); }
      .fine-row { display: flex; gap: var(--vsc-space-xs); justify-content: center; padding: 4px 0; }
      .fine-btn { padding: 2px 4px; min-height: 24px; min-width: 32px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255, 255, 255, 0.06); background: rgba(255, 255, 255, 0.03); color: rgba(255, 255, 255, 0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); }
      .fine-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
      .fine-btn:active { transform: scale(0.95); }
      .info-bar { font-family: var(--vsc-font-mono); font-size: 12px; opacity: 0.8; padding: 4px 0 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: var(--vsc-neon); text-align: left; }

      @media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } }
      @media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } .chips { gap: 6px; } .fine-row { gap: 6px; } }
      `;

      function getMountTarget() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) {
          if (fsEl.tagName === 'VIDEO') return fsEl.parentElement || document.documentElement;
          return fsEl;
        }
        return document.documentElement || document.body;
      }

      const HOST_STYLE_NORMAL = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
      const HOST_STYLE_FS = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
      let _lastMountTarget = null;
      let _qbarHasVideo = false;

      // ★★★ 수정 6: reparentForFullscreen에서 panelHost 상태도 복원 ★★★
      function reparentForFullscreen() {
        if (!quickBarHost) return;
        const targetParent = getMountTarget();
        if (!targetParent) return;

        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const needsMove = targetParent !== _lastMountTarget;

        const wasHidden = !_qbarHasVideo;
        const wasPanelOpen = panelOpen;

        if (needsMove || isFs) {
          _lastMountTarget = targetParent;
          try { targetParent.appendChild(quickBarHost); } catch (_) {}
          if (panelHost) { try { targetParent.appendChild(panelHost); } catch (_) {} }
        }

        const style = isFs ? HOST_STYLE_FS : HOST_STYLE_NORMAL;
        quickBarHost.style.cssText = style;
        if (panelHost) panelHost.style.cssText = style;

        if (wasHidden) {
          quickBarHost.style.setProperty('display', 'none', 'important');
        }

        // ★ panelHost의 pointer-events 복원
        if (panelHost && wasPanelOpen && panelEl) {
          panelEl.style.pointerEvents = 'auto';
        }
      }

      function onFullscreenChange() {
        reparentForFullscreen();
        setTimer(reparentForFullscreen, 80);
        setTimer(reparentForFullscreen, 400);

        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
          _lastMountTarget = null;
          setTimer(() => {
            const root = document.documentElement || document.body;
            if (quickBarHost && quickBarHost.parentNode !== root) {
              try { root.appendChild(quickBarHost); } catch(_) {}
            }
            if (panelHost && panelHost.parentNode !== root) {
              try { root.appendChild(panelHost); } catch(_) {}
            }
            reparentForFullscreen();
          }, 100);
        }
      }

      // ★★★ 수정 7: updateQuickBarVisibility — Registry.shadowRootsLRU 활용 ★★★
      function updateQuickBarVisibility() {
        if (!quickBarHost) return;

        let has = Registry.videos.size > 0;

        if (!has) {
          try { has = document.querySelector('video') !== null; } catch (_) {}
        }

        // Registry가 이미 추적 중인 shadow root만 확인 (전체 DOM 순회 회피)
        if (!has && Registry.shadowRootsLRU) {
          for (let i = 0; i < Registry.shadowRootsLRU.length && !has; i++) {
            const it = Registry.shadowRootsLRU[i];
            if (it.host?.isConnected && it.root) {
              try { has = it.root.querySelector('video') !== null; } catch (_) {}
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

        if (_qbarHasVideo) {
          reparentForFullscreen();
        }
      }

      function updateTabIndicator(tabBar, tabName) {
        if (!tabBar) return;
        const tabs = tabBar.querySelectorAll('.tab');
        const tabNames = ['video', 'audio', 'playback'];
        const idx = tabNames.indexOf(tabName);
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
        const elRes = h('span', {}, '—');
        const elRate = h('span', {}, '—');
        footer.append(elRes, elRate);
        Bus.on('signal', () => {
          if (!panelOpen) return;
          const v = window[Symbol.for('__VSC_INTERNAL__')]?._activeVideo;
          if (v && v.isConnected) {
            elRes.textContent = (v.videoWidth || 0) ? `${v.videoWidth}×${v.videoHeight}` : '—';
            elRate.textContent = `${v.playbackRate.toFixed(2)}×`;
          } else {
            elRes.textContent = '—'; elRate.textContent = '—';
          }
        });
        return footer;
      }

      function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
      function mkSep() { return h('div', { class: 'sep' }); }

      function mkOptimizedSlider(path, min, max, step) {
        const s = step || ((max - min) / 100);
        const digits = (s >= 1) ? 0 : 2;
        const inp = h('input', { type: 'range', min, max, step: s });
        const valEl = h('span', { class: 'val' });
        function updateUI(v) { inp.value = String(v); valEl.textContent = Number(v).toFixed(digits); inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`); }
        inp.addEventListener('input', () => { Store.set(path, parseFloat(inp.value)); updateUI(parseFloat(inp.value)); Scheduler.request(); });
        const sync = () => { updateUI(Number(Store.get(path)) || min); };
        tabFns.push(sync); sync();
        return [inp, valEl];
      }

      function mkOptimizedToggle(path, onChange) {
        const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' });
        function sync() {
          const on = !!Store.get(path);
          el.classList.toggle('on', on);
          el.setAttribute('aria-checked', String(on));
        }
        el.addEventListener('click', () => {
          const nv = !Store.get(path);
          Store.set(path, nv); sync();
          if (onChange) onChange(nv);
          else Scheduler.request();
        });
        tabFns.push(sync); sync();
        return el;
      }

      function delegatedChipRow(label, path, chips, onSelect) {
        const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label));
        const row = h('div', { class: 'chips' });
        for (const ch of chips) row.appendChild(h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l));
        row.addEventListener('click', (e) => {
          const chip = e.target.closest('.chip'); if (!chip) return;
          const val = chip.dataset.v; Store.set(path, val);
          requestAnimationFrame(() => { for (const c of row.children) c.classList.toggle('on', c.dataset.v === val); });
          Scheduler.request();
          if (onSelect) onSelect();
        });
        const sync = () => { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); };
        wrap.appendChild(row); tabFns.push(sync); sync();
        return wrap;
      }

      function buildVideoTab() {
        const w = h('div', {});
        const infoBar = h('div', { class: 'info-bar' });

        const updateInfo = () => {
          const v = window[Symbol.for('__VSC_INTERNAL__')]?._activeVideo;
          const p = Store.get(P.V_PRE_S);
          const presetLbl = p === 'none' ? 'OFF' : p === 'off' ? 'AUTO' : PRESETS.detail[p]?.label || p;

          if (!v || !v.isConnected) { infoBar.textContent = `영상 없음 │ 샤프닝: ${presetLbl}`; return; }
          const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0;
          if (nW === 0) { infoBar.textContent = `비디오 정보 로딩 대기중... │ 샤프닝: ${presetLbl}`; return; }
          infoBar.textContent = `원본 ${nW}×${nH} → 출력 ${dW}×${dH} │ 샤프닝: ${presetLbl}`;
        };
        Bus.on('signal', updateInfo);
        Store.sub(P.V_PRE_S, updateInfo);
        tabFns.push(updateInfo);

        w.append(infoBar, mkSep());

        w.append(
          delegatedChipRow('디테일 프리셋', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: PRESETS.detail[k].label || k })), updateInfo),
          mkRow('강도 믹스', ...mkOptimizedSlider(P.V_PRE_MIX, 0, 1, 0.01)),
          mkSep()
        );

        const manualHeader = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
          h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '수동 보정'),
          h('div', { style: 'display:flex;gap:4px' },
            ...[
              { n: 'OFF',  v: [0,  0,  0,  0  ] },
              { n: '선명', v: [36,  0,  0,  0  ] },
              { n: '영화', v: [13, 23, 14, -22 ] },
              { n: '복원', v: [32, 49,  7,  0  ] },
              { n: '심야', v: [54, 37,  0, -12 ] },
              { n: '아트', v: [0,  41, 11, -19 ] }
            ].map(p => {
              const btn = h('button', { class: 'fine-btn', style: 'background:rgba(110,168,254,0.1)' }, p.n);
              btn.onclick = () => {
                Store.batch('video', { manualShadow: p.v[0], manualRecovery: p.v[1], manualBright: p.v[2], manualTemp: p.v[3] });
                Scheduler.request(); tabFns.forEach(f => f());
              };
              const syncBtn = () => {
                const isMatch = [Store.get(P.V_MAN_SHAD), Store.get(P.V_MAN_REC), Store.get(P.V_MAN_BRT), Store.get(P.V_MAN_TEMP)].every((val, i) => val === p.v[i]);
                if (isMatch) { btn.style.background = 'var(--vsc-neon-dim)'; btn.style.color = 'var(--vsc-neon)'; btn.style.borderColor = 'var(--vsc-neon-border)'; }
                else { btn.style.background = 'rgba(255,255,255,0.03)'; btn.style.color = 'rgba(255,255,255,0.6)'; btn.style.borderColor = 'rgba(255,255,255,0.06)'; }
              };
              tabFns.push(syncBtn); syncBtn();
              return btn;
            })
          )
        );
        w.append(manualHeader);

        function mkSliderWithFine(label, path, min, max, step, fineStep) {
          const [slider, valEl] = mkOptimizedSlider(path, min, max, step);
          const mkFine = (delta, text) => {
            const btn = h('button', { class: 'fine-btn', style: 'font-size:11px' }, text);
            btn.addEventListener('click', () => { Store.set(path, VSC_CLAMP(Math.round((Number(Store.get(path)) || 0) + delta), min, max)); Scheduler.request(); tabFns.forEach(f => f()); });
            return btn;
          };
          const resetBtn = h('button', { class: 'fine-btn', style: 'min-width:24px;font-size:10px;opacity:.6' }, '0');
          resetBtn.addEventListener('click', () => { Store.set(path, 0); Scheduler.request(); tabFns.forEach(f => f()); });
          const fineRow = h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn);
          return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, fineRow));
        }

        w.append(
          mkSliderWithFine('암부 부스트', P.V_MAN_SHAD, 0, 100, 1, 5),
          mkSliderWithFine('디테일 복원', P.V_MAN_REC, 0, 100, 1, 5),
          mkSliderWithFine('노출 보정', P.V_MAN_BRT, 0, 100, 1, 5),
          mkSliderWithFine('색온도', P.V_MAN_TEMP, -50, 50, 1, 5),
          mkSep()
        );

        /* Dimmer */
        const brtBtns = [];
        const brtChips = h('div', { class: 'chips' });
        SCR_BRT_LABELS.forEach((label, idx) => {
          if (idx === 0) return;
          const chip = h('span', { class: 'chip', 'data-v': String(idx) }, '☀ ' + idx);
          chip.addEventListener('click', () => { cycleScrBrtTo(idx); });
          brtBtns.push(chip); brtChips.appendChild(chip);
        });

        const brtResetBtn = h('button', {
          class: 'chip',
          style: 'margin-left:auto; flex:none; width:70px; font-size:10px; border-color:var(--vsc-text-muted); color: #fff !important;'
        }, '리셋(OFF)');
        brtResetBtn.addEventListener('click', () => { cycleScrBrtTo(0); });

        const brtValLabel = h('span', { style: 'font-size:11px;color:var(--vsc-neon);margin-left:6px' }, '');

        function cycleScrBrtTo(idx) {
          Store.set(P.APP_SCREEN_BRT, idx); applyScrBrt(idx); syncBrt();
        }

        function syncBrt() {
          const cur = Number(Store.get(P.APP_SCREEN_BRT)) || 0;
          brtBtns.forEach((btn) => { btn.classList.toggle('on', btn.dataset.v === String(cur)); });
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
          mkRow('오디오 부스트', mkOptimizedToggle(P.A_EN, () => Audio.setTarget(window[Symbol.for('__VSC_INTERNAL__')]._activeVideo))),
          mkRow('부스트 (dB)', ...mkOptimizedSlider(P.A_BST, 0, 15, 0.5))
        );
        const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0;text-align:left;' }, '오디오: 대기');
        Bus.on('signal', () => {
          if (!panelOpen) return;
          const ctxReady = Audio.hasCtx(), hooked = Audio.isHooked(), bypassed = Audio.isBypassed();
          status.textContent = !ctxReady ? '상태: 대기' : (hooked && !bypassed ? '상태: 활성 (DSP 처리 중)' : (bypassed ? '상태: 바이패스 (원본 출력)' : '상태: 준비 (연결 대기)'));
        });
        w.append(mkSep(), status); return w;
      }

      function buildPlaybackTab() {
        const w = h('div', {}); w.append(mkRow('속도 제어', mkOptimizedToggle(P.PB_EN, () => Scheduler.request())));
        const rateDisplay = h('div', { class: 'rate-display' }); function syncRateDisplay() { rateDisplay.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }
        tabFns.push(syncRateDisplay); syncRateDisplay(); w.append(rateDisplay);
        const chipRow = h('div', { class: 'chips' }); function syncChips() { const cur = Number(Store.get(P.PB_RATE)) || 1; for (const c of chipRow.children) c.classList.toggle('on', Math.abs(cur - parseFloat(c.dataset.v)) < 0.01); }
        [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0].forEach(p => { const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`); el.addEventListener('click', () => { Store.set(P.PB_RATE, p); Store.set(P.PB_EN, true); Scheduler.request(); tabFns.forEach(f => f()); }); chipRow.appendChild(el); });
        tabFns.push(syncChips); syncChips(); w.append(chipRow);
        const fineRow = h('div', { class: 'fine-row' });
        [{ label: '−0.25', delta: -0.25 }, { label: '−0.05', delta: -0.05 }, { label: '+0.05', delta: +0.05 }, { label: '+0.25', delta: +0.25 }].forEach(fs => { const btn = h('button', { class: 'fine-btn' }, fs.label); btn.addEventListener('click', () => { Store.set(P.PB_RATE, VSC_CLAMP((Number(Store.get(P.PB_RATE)) || 1) + fs.delta, 0.07, 16)); Store.set(P.PB_EN, true); Scheduler.request(); tabFns.forEach(f => f()); }); fineRow.appendChild(btn); });
        w.append(fineRow, mkRow('속도 슬라이더', ...mkOptimizedSlider(P.PB_RATE, 0.07, 4, 0.01)));
        return w;
      }

      function buildQuickBar() {
        if (quickBarHost) return;
        quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: HOST_STYLE_NORMAL });
        quickBarHost.style.setProperty('display', 'none', 'important');
        _qbarShadow = quickBarHost.attachShadow({ mode: 'closed' });

        const qbarStyleEl = document.createElement('style');
        qbarStyleEl.textContent = `
          ${CSS_VARS}
          .qbar {
            pointer-events: none;
            position: fixed !important;
            top: 50% !important;
            right: var(--vsc-qbar-right) !important;
            transform: translateY(-50%) !important;
            display: flex !important;
            align-items: center !important;
            contain: none !important;
            z-index: 2147483647 !important;
          }
          .qbar .qb-main {
            pointer-events: auto;
            width: 46px; height: 46px;
            border-radius: 50%;
            background: var(--vsc-glass);
            border: 1px solid rgba(255, 255, 255, 0.08);
            opacity: 0.4;
            transition: all 0.3s var(--vsc-ease-out);
            box-shadow: var(--vsc-shadow-fab);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            backdrop-filter: blur(16px) saturate(180%);
          }
          .qbar:hover .qb-main {
            opacity: 1;
            transform: scale(1.08);
            border-color: var(--vsc-neon-border);
            box-shadow: var(--vsc-shadow-fab), var(--vsc-neon-glow);
          }
          .qbar svg {
            width: 22px; height: 22px;
            fill: none;
            stroke: #fff !important;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
            transition: stroke 0.2s;
            display: block !important;
            pointer-events: none !important;
          }
          .qbar:hover .qb-main svg {
            stroke: var(--vsc-neon) !important;
          }
        `;
        _qbarShadow.appendChild(qbarStyleEl);

        const bar = h('div', { class: 'qbar' });
        const mainBtn = h('div', { class: 'qb qb-main' });

        const gearSvg = _s('svg', { viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          _s('circle', { cx: '12', cy: '12', r: '3' }),
          _s('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })
        );
        mainBtn.appendChild(gearSvg);
        mainBtn.addEventListener('click', e => { e.preventDefault(); togglePanel(); });

        bar.append(mainBtn);
        _qbarShadow.appendChild(bar);
        getMountTarget().appendChild(quickBarHost);
      }

      function buildPanel() {
        if (panelHost) return;
        panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host', style: HOST_STYLE_NORMAL });
        _shadow = panelHost.attachShadow({ mode: 'closed' }); _shadow.appendChild(h('style', {}, PANEL_CSS));
        panelEl = h('div', { class: 'panel' });

        const closeBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '✕');
        closeBtn.addEventListener('click', () => togglePanel(false));
        panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC Lite'), closeBtn));

        const tabBar = h('div', { class: 'tabs' });
        ['video', 'audio', 'playback'].forEach(t => {
          const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t });
          tab.append(TAB_ICONS[t]?.() || '', h('span', {}, TAB_LABELS[t]));
          tab.addEventListener('click', () => { activeTab = t; renderTab(); });
          tabBar.appendChild(tab);
        });
        panelEl.appendChild(tabBar); panelEl.appendChild(h('div', { class: 'body' }));
        panelEl.appendChild(createSmartMetrics());
        _shadow.appendChild(panelEl); renderTab();
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

        const tabs = _shadow.querySelectorAll('.tab');
        tabs.forEach(t => t.classList.toggle('on', t.dataset.t === activeTab));
        updateTabIndicator(_shadow.querySelector('.tabs'), activeTab);
      }

      function togglePanel(force) {
        buildPanel();
        panelOpen = force !== undefined ? force : !panelOpen;
        if (panelOpen) {
          panelEl.classList.add('open');
          panelEl.style.pointerEvents = 'auto';
          renderTab();
        } else {
          panelEl.classList.remove('open');
          setTimeout(() => { if (!panelOpen) panelEl.style.pointerEvents = 'none'; }, 300);
        }
      }

      buildQuickBar();
      updateQuickBarVisibility();

      Bus.on('signal', updateQuickBarVisibility);
      setRecurring(updateQuickBarVisibility, 2000);

      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);

      setRecurring(() => {
        const expectedTarget = getMountTarget();
        if (quickBarHost && quickBarHost.parentNode !== expectedTarget) {
          reparentForFullscreen();
        }
      }, 2000);

      return { togglePanel, syncAll: () => tabFns.forEach(f => f()) };
    }

    /* ══ Bootstrap & Init ══ */
    function bootstrap() {
      const internal = window[Symbol.for('__VSC_INTERNAL__')];
      const Utils = createUtils();
      const Scheduler = createScheduler();
      const Bus = createEventBus();
      const Store = createLocalStore(DEFAULTS, Scheduler, Utils);

      try { const saved = GM_getValue(STORAGE_KEY); if (saved) Store.load(JSON.parse(saved)); } catch (_) {}
      const saveState = () => GM_setValue(STORAGE_KEY, JSON.stringify(Store.state));
      Store.sub('video', saveState); Store.sub('audio', saveState); Store.sub('playback', saveState); Store.sub('app', saveState);

      const Registry = createRegistry(Scheduler, Bus);
      const Targeting = createTargeting();
      const Audio = createAudio(Store);
      const OSD = createOSD();

      const ParamsMemo = createVideoParamsMemo(Store);
      const FiltersVO = createFiltersVideoOnly(Utils, CONFIG);

      const ApplyLoop = { apply: () => {
        if (!Store.get('app.active')) { Audio.setTarget(null); return; }

        const target = Targeting.pickFastActiveOnly(Registry.videos).target;
        if (target) {
          internal._activeVideo = target;
          Audio.setTarget(target);
        }

        Registry.videos.forEach(v => {
          const params = ParamsMemo.get(v);
          const result = FiltersVO.prepareCached(v, params);
          FiltersVO.applyFilter(v, result);
        });
      }};
      Scheduler.registerApply(ApplyLoop.apply);

      createUI(Store, Bus, Utils, Audio, Registry, Scheduler, OSD);

      internal.Store = Store;
      internal._activeVideo = null;

      Registry.rescanAll();
      ApplyLoop.apply();

      log.info(`[VSC] v${VSC_VERSION} (Ultimate Core Final) booted successfully.`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    else bootstrap();

  } // ← closes function VSC_MAIN()

  VSC_MAIN();
})();
