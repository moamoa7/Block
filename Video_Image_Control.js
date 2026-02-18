// ==UserScript==
// @name        Video_Image_Control (v132.0.93-SecureUI)
// @namespace   https://github.com/
// @version     132.0.93.0
// @description Base: v132 + SecureSync + FullscreenUIFix + AE Quality
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

    // 1. Boot Guard
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com')) return;
    const VSC_BOOT_KEY = '__VSC_BOOT_LOCK__';
    if (window[VSC_BOOT_KEY]) return;
    try { Object.defineProperty(window, VSC_BOOT_KEY, { value: true, writable: false }); } catch (e) { window[VSC_BOOT_KEY] = true; }

    const IS_TOP = window === window.top;
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const VSC_ID = Math.random().toString(36).slice(2);
    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_LOW_END = DEVICE_RAM < 4;

    // [Config] AE Parameters
    const MIN_AE = {
        STRENGTH: IS_MOBILE ? 0.24 : 0.28,
        P98_CLIP: 0.985,
        CLIP_FRAC_LIMIT: 0.004,
        MAX_UP_EV: IS_MOBILE ? 0.14 : 0.18,
        MAX_UP_EV_EXTRA: IS_MOBILE ? 0.28 : 0.35,
        MAX_DOWN_EV: -0.10,
        DEAD_OUT: IS_MOBILE ? 0.12 : 0.10,
        DEAD_IN: 0.04,
        LOWKEY_STDDEV: IS_MOBILE ? 0.20 : 0.24,
        TAU_UP: 950,
        TAU_DOWN: 900,
        TAU_AGGRESSIVE: 200,
        TARGET_MID_BASE: IS_MOBILE ? 0.26 : 0.30,
        SAT_MIN: 0.95,
        SAT_MAX: 1.05,
        V91_AECON_MIN: 0.85,
        V91_AECON_MAX: 1.35,
        V91_AEGAM_MIN: 0.5,
        V91_AEGAM_MAX: 2.5,
        TONE_BASE_SOFTEN: 1.0,
        DT_CAP_MS: 220,
        PLAYING_MAX_SKIP: 3
    };

    const DEFAULTS = {
        video: {
            gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
            temp: 0, sharp: 0, sharp2: 0, dither: 0, clarity: 0,
            ae: false, presetS: 'off', presetB: 'brOFF'
        },
        image: { level: 15, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const P = Object.freeze({
        APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_TAB: 'app.tab',
        V_AE: 'video.ae',
        V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright',
        V_SAT: 'video.sat', V_SHARP: 'video.sharp', V_SHARP2: 'video.sharp2',
        V_CLARITY: 'video.clarity', V_TEMP: 'video.temp', V_DITHER: 'video.dither',
        V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB',
        A_EN: 'audio.enabled', A_BST: 'audio.boost',
        PB_RATE: 'playback.rate',
        I_LVL: 'image.level', I_TMP: 'image.temp'
    });

    const TOUCHED = { videos: new Set(), images: new Set() };

    // ==========================================
    // MODULES
    // ==========================================

    const createUtils = () => ({
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        h: (tag, props = {}, ...children) => {
            const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
            for (const [k, v] of Object.entries(props)) {
                if (k.startsWith('on')) {
                    el.addEventListener(k.slice(2).toLowerCase(), (e) => {
                        if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation();
                        v(e);
                    });
                } else if (k === 'style') {
                    if (typeof v === 'string') el.style.cssText = v;
                    else Object.assign(el.style, v);
                } else if (k === 'class') el.className = v;
                else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
            }
            children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
            return el;
        }
    });

    const createScheduler = () => {
        let queued = false;
        let force = false;
        let applyFn = null;
        const request = (immediate = false) => {
            if (immediate === true) force = true;
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                const doForce = force;
                force = false;
                if (applyFn) { try { applyFn(doForce); } catch (e) { } }
            });
        };
        return { registerApply: (fn) => { applyFn = fn; }, request };
    };

    // [Secure] Sync Store with Handshake Token
    const createSyncStore = (defaults, scheduler, config) => {
        let state = JSON.parse(JSON.stringify(defaults));
        let rev = 0;
        const listeners = new Map();
        const IS_TOP = config.IS_TOP;
        let frameWins = [];

        // Security Constants
        const SYNC_HELLO = 'VSC_HELLO';
        const SYNC_ACK = 'VSC_ACK';
        const SYNC_TYPE = 'VSC_SYNC';
        const TOP_TOKEN = IS_TOP ? (Math.random().toString(36).slice(2) + Date.now().toString(36)) : null;
        let SYNC_TOKEN = null;

        // [Optimized] Debounced Frame Refresh
        let rfQueued = false;
        let rfTimer = 0;
        const refreshFrames = () => {
            try {
                frameWins = Array.from(document.querySelectorAll('iframe'))
                    .map(f => { try { return f.contentWindow; } catch (e) { return null; } })
                    .filter(Boolean);
            } catch (_) { frameWins = []; }
        };
        const requestRefreshFrames = () => {
            if (rfQueued) return;
            rfQueued = true;
            clearTimeout(rfTimer);
            rfTimer = setTimeout(() => { rfQueued = false; refreshFrames(); }, 200);
        };

        if (IS_TOP) {
            refreshFrames();
            new MutationObserver(() => requestRefreshFrames())
                .observe(document.documentElement, { childList: true, subtree: true });
        }

        const emit = (key, val) => {
            const a = listeners.get(key); if (a) for (const cb of a) cb(val);
            const cat = key.split('.')[0];
            const b = listeners.get(cat + '.*'); if (b) for (const cb of b) cb(val);
        };

        const broadcastRaw = (msg, excludeSource = null) => {
            try {
                if (IS_TOP) {
                    const next = [];
                    for (const w of frameWins) {
                        if (!w || w === excludeSource) { if (w) next.push(w); continue; }
                        try { w.postMessage(msg, '*'); next.push(w); } catch (e) { }
                    }
                    frameWins = next;
                } else {
                    window.top?.postMessage(msg, '*');
                }
            } catch (e) { }
        };

        const broadcast = (path, val, excludeSource = null) => {
            const msg = { type: SYNC_TYPE, token: SYNC_TOKEN || TOP_TOKEN, path, val, fromTop: IS_TOP };
            broadcastRaw(msg, excludeSource);
        };

        // Handshake Init
        if (IS_TOP) {
            const helloMsg = { type: SYNC_HELLO, token: TOP_TOKEN };
            setTimeout(() => broadcastRaw(helloMsg), 50);
            setTimeout(() => broadcastRaw(helloMsg), 250);
            setTimeout(() => broadcastRaw(helloMsg), 800);
        } else {
            try { window.top?.postMessage({ type: SYNC_HELLO, ask: 1 }, '*'); } catch (e) { }
        }

        window.addEventListener('message', (e) => {
            const d = e.data;
            if (!d || !d.type) return;

            // 1. Handshake
            if (d.type === SYNC_HELLO) {
                if (IS_TOP && d.ask) { // If iframe asks, reply with token
                    try { e.source?.postMessage({ type: SYNC_HELLO, token: TOP_TOKEN }, '*'); } catch (_) { }
                } else if (!IS_TOP && d.token) { // If top sends token, save it
                    SYNC_TOKEN = d.token;
                    try { window.top?.postMessage({ type: SYNC_ACK, token: SYNC_TOKEN }, '*'); } catch (_) { }
                }
                return;
            }

            // 2. Sync with Token Validation
            if (d.type === SYNC_TYPE) {
                const tokenOk = (IS_TOP ? (d.token === TOP_TOKEN) : (d.token && d.token === SYNC_TOKEN));
                if (!tokenOk) return;

                const [cat, key] = d.path.split('.');
                state[cat] ||= {};
                if (state[cat][key] === d.val) return;

                state[cat][key] = d.val;
                rev++;
                emit(d.path, d.val);
                scheduler.request(false);

                if (IS_TOP) broadcast(d.path, d.val, e.source);
            }
        });

        return {
            rev: () => rev,
            get: (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), state),
            set: (path, val) => {
                const [cat, key] = path.split('.');
                state[cat] ||= {};
                if (state[cat][key] === val) return;
                state[cat][key] = val; rev++;
                emit(path, val);
                broadcast(path, val);
            },
            batch: (cat, obj) => {
                state[cat] ||= {};
                let has = false;
                for (const [k, v] of Object.entries(obj)) {
                    if (state[cat][k] !== v) {
                        state[cat][k] = v;
                        emit(`${cat}.${k}`, v);
                        broadcast(`${cat}.${k}`, v);
                        has = true;
                    }
                }
                if (has) rev++;
            },
            sub: (k, f) => {
                const a = listeners.get(k) || [];
                a.push(f); listeners.set(k, a);
            }
        };
    };

    const createRegistry = (scheduler, featureCheck) => {
        const videos = new Set();
        const images = new Set();
        const seenElements = new WeakSet();
        const visible = { videos: new Set(), images: new Set() };
        const dirty = { videos: new Set(), images: new Set() };
        let rev = 0;

        const origAttachShadow = Element.prototype.attachShadow;
        if (origAttachShadow) {
            Element.prototype.attachShadow = function (init) {
                const shadow = origAttachShadow.call(this, init);
                if (shadow) observeRoot(shadow);
                return shadow;
            };
        }

        const io = new IntersectionObserver((entries) => {
            let changed = false;
            for (const e of entries) {
                const el = e.target;
                const isVis = e.isIntersecting || e.intersectionRatio > 0;
                el.__vsc_visible = isVis;
                if (el.tagName === 'VIDEO') {
                    if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
                    else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
                } else if (el.tagName === 'IMG') {
                    if (isVis) { if (!visible.images.has(el)) { visible.images.add(el); dirty.images.add(el); changed = true; } }
                    else { if (visible.images.has(el)) { visible.images.delete(el); dirty.images.add(el); changed = true; } }
                }
            }
            if (changed) { rev++; scheduler.request(false); }
        }, { root: null, threshold: 0.01, rootMargin: '300px' });

        // [Fix] UI Check crossing Shadow DOM
        const isInVscUI = (node) => {
            if (!node || node.nodeType !== 1) return false;
            if (node.closest?.('[data-vsc-ui="1"]')) return true;
            const root = node.getRootNode?.();
            const host = root && root.host;
            if (host && host.closest?.('[data-vsc-ui="1"]')) return true;
            return false;
        };

        const safeQSA = (root, sel) => {
            try { return root?.querySelectorAll ? root.querySelectorAll(sel) : []; } catch (_) { return []; }
        };

        const observeMediaEl = (el) => {
            if (!el || seenElements.has(el) || isInVscUI(el)) return;
            if (el.tagName === 'VIDEO') {
                videos.add(el); seenElements.add(el); io.observe(el);
            } else if (featureCheck.images() && el.tagName === 'IMG') {
                images.add(el); seenElements.add(el); io.observe(el);
            }
        };

        const processNode = (node) => {
            if (!node) return;
            if (node.nodeType === 11) { // ShadowRoot
                safeQSA(node, 'video').forEach(observeMediaEl);
                if (featureCheck.images()) safeQSA(node, 'img').forEach(observeMediaEl);
                return;
            }
            if (node.nodeType !== 1) return;
            if (isInVscUI(node)) { seenElements.add(node); return; }
            if (node.tagName === 'VIDEO' || node.tagName === 'IMG') observeMediaEl(node);
            safeQSA(node, 'video').forEach(observeMediaEl);
            if (featureCheck.images()) safeQSA(node, 'img').forEach(observeMediaEl);
        };

        const observeRoot = (root) => {
            if (!root) return;
            processNode(root);
            new MutationObserver((mutations) => {
                for (const m of mutations) for (const n of m.addedNodes) processNode(n);
            }).observe(root, { childList: true, subtree: true });
        };

        const start = () => {
            if (document.body) observeRoot(document.body);
            else setTimeout(start, 100);
        };
        start();

        return {
            videos, images, visible,
            rev: () => rev,
            prune: () => {
                let pruned = false;
                for (const v of videos) if (!v.isConnected) { videos.delete(v); visible.videos.delete(v); io.unobserve(v); pruned = true; }
                for (const i of images) if (!i.isConnected) { images.delete(i); visible.images.delete(i); io.unobserve(i); pruned = true; }
                if (pruned) rev++;
            },
            consumeDirty: () => {
                const out = { videos: new Set(dirty.videos), images: new Set(dirty.images) };
                dirty.videos.clear(); dirty.images.clear();
                return out;
            },
            rescanAll: () => { if (document.body) processNode(document.body); },
            setWantImages: (want) => {
                if (want) return;
                for (const i of images) try { io.unobserve(i); } catch (e) { }
                images.clear(); visible.images.clear(); dirty.images.clear(); rev++;
            }
        };
    };

    const createAudio = (sm) => {
        let ctx, compressor, dry, wet;
        let hadUserGesture = false;
        const srcMap = new WeakMap();

        window.addEventListener('pointerdown', () => { hadUserGesture = true; }, { once: true, passive: true });
        window.addEventListener('keydown', () => { hadUserGesture = true; }, { once: true, passive: true });

        const ensureCtx = () => {
            if (ctx) return true;
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            ctx = new AC();
            compressor = ctx.createDynamicsCompressor();
            dry = ctx.createGain(); dry.connect(ctx.destination);
            wet = ctx.createGain(); compressor.connect(wet); wet.connect(ctx.destination);
            return true;
        };

        const updateMix = () => {
            if (!ctx) return;
            const enabled = sm.get(P.A_EN);
            const boostDb = sm.get(P.A_BST);
            if (ctx.state === 'suspended' && hadUserGesture) ctx.resume();
            const t = ctx.currentTime;
            dry.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.05);
            const boostLinear = Math.pow(10, boostDb / 20);
            wet.gain.setTargetAtTime(enabled ? boostLinear : 0, t, 0.05);
        };

        return {
            attach: (v) => {
                if (!v || v.tagName !== 'VIDEO' || srcMap.has(v) || v.__vsc_audio_fail) return;
                if (!hadUserGesture || !sm.get(P.A_EN)) return;
                if (!ensureCtx()) return;
                try {
                    const src = ctx.createMediaElementSource(v);
                    src.connect(dry);
                    src.connect(compressor);
                    srcMap.set(v, src);
                    updateMix();
                } catch (e) { v.__vsc_audio_fail = true; }
            },
            detachIfDead: (v) => {
                if (!v || v.isConnected) return;
                const src = srcMap.get(v);
                if (src) { try { src.disconnect(); } catch (e) { } srcMap.delete(v); }
            },
            update: updateMix
        };
    };

    const createFilters = (Utils, config) => {
        const { h, clamp } = Utils;
        const ctxMap = new WeakMap();
        const toneCache = new Map();

        const getToneTableCached = (sh, hi, br, con, gain) => {
            const k = `${sh}|${hi}|${br}|${con}|${gain}`;
            if (toneCache.has(k)) return toneCache.get(k);
            const steps = 96;
            const out = new Array(steps);
            const shN = clamp(sh, -1, 1), hiN = clamp(hi, -1, 1), b = clamp(br, -1, 1) * 0.10;
            const g = clamp(gain || 1.0, 0.7, 1.8), c = clamp(con || 1.0, 0.85, 1.35);
            const toe = clamp(0.18 + shN * 0.08, 0.06, 0.30), shoulder = clamp(0.86 - hiN * 0.06, 0.72, 0.95);
            const smoothstep = (t) => t * t * (3 - 2 * t);

            for (let i = 0; i < steps; i++) {
                let x = clamp(i / (steps - 1) * g, 0, 1);
                let y = (x - 0.5) * c + 0.5 + b;
                if (y < toe) {
                    const t = clamp(y / Math.max(1e-6, toe), 0, 1), s = smoothstep(t);
                    y = toe * (s * t + (1 - s) * (t * (1 + 0.9 * shN)));
                }
                if (y > shoulder) {
                    const t = clamp((y - shoulder) / Math.max(1e-6, (1 - shoulder)), 0, 1), s = smoothstep(t);
                    const kk = (Math.abs(hiN) < 1e-6) ? 0 : (0.55 + 0.35 * hiN);
                    y = shoulder + (1 - shoulder) * (t - s * t * kk);
                }
                out[i] = clamp(y, 0, 1).toFixed(3);
            }
            const res = out.join(' ');
            toneCache.set(k, res);
            if (toneCache.size > 64) toneCache.delete(toneCache.keys().next().value);
            return res;
        };

        function buildSvg(doc) {
            const baseId = `vsc-f-${config.VSC_ID}`;
            const svg = h('svg', { ns: 'svg', width: '0', height: '0', style: 'position:absolute;left:-9999px;' });
            const defs = h('defs', { ns: 'svg' });
            svg.append(defs);

            const createFilter = (suffix, withNoise) => {
                const fid = `${baseId}-${suffix}`;
                const filter = h('filter', { ns: 'svg', id: fid, x: '-20%', y: '-20%', width: '140%', height: '140%', 'color-interpolation-filters': 'sRGB' });
                const sat = h('feColorMatrix', { ns: 'svg', type: 'saturate', values: '1', 'in': 'tmp', 'result': 'sat' });
                const lin = h('feComponentTransfer', { ns: 'svg', result: 'lin' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
                const gam = h('feComponentTransfer', { ns: 'svg', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', exponent: '1' })));
                const tmp = h('feComponentTransfer', { ns: 'svg', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1' })));
                const b1 = h('feGaussianBlur', { ns: 'svg', in: 'sat', stdDeviation: '0', result: 'b1' });
                const sh1 = h('feComposite', { ns: 'svg', in: 'sat', in2: 'b1', operator: 'arithmetic', k2: '1', result: 'sh1' });
                const b2 = h('feGaussianBlur', { ns: 'svg', in: 'sh1', stdDeviation: '0', result: 'b2' });
                const sh2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'b2', operator: 'arithmetic', k2: '1', result: 'sh2', });
                const bc = h('feGaussianBlur', { ns: 'svg', in: 'sh2', stdDeviation: '0', result: 'bc' });
                const cl = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'bc', operator: 'arithmetic', k2: '1', result: 'cl' });
                filter.append(lin, gam, tmp, sat, b1, sh1, b2, sh2, bc, cl);
                let gr = null;
                if (withNoise) {
                    const turb = h('feTurbulence', { ns: 'svg', type: 'fractalNoise', baseFrequency: '0.85', result: 'noise' });
                    gr = h('feComposite', { ns: 'svg', in: 'cl', in2: 'noise', operator: 'arithmetic', k2: '1', k3: '0' });
                    filter.append(turb, gr);
                }
                defs.append(filter);
                return { fid, sat, lin, gam, tmp, b1, sh1, b2, sh2, bc, cl, gr };
            };
            const vN = createFilter('vN', true), v0 = createFilter('v0', false);
            const iN = createFilter('iN', true), i0 = createFilter('i0', false);
            (doc.body || doc.documentElement).appendChild(svg);
            return { svg, video: { N: vN, O: v0 }, image: { N: iN, O: i0 } };
        }

        const q = (v, st) => Math.round((Number(v) || 0) / st) * st;

        return {
            prepare: (doc, s, kind) => {
                let ctx = ctxMap.get(doc);
                if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
                const nodes = kind === 'video' ? (s.dither > 0 ? ctx.video.N : ctx.video.O) : (s.dither > 0 ? ctx.image.N : ctx.image.O);
                const key = [
                    q(s.gain, 0.01), q(s.gamma, 0.01), q(s.contrast, 0.01), q(s.bright, 0.2),
                    q(s.sat, 1), q(s.sharp, 1), q(s.sharp2, 1), q(s.clarity, 1), q(s.dither, 5), q(s.temp, 1),
                    q(s.aeGamma, 0.01), q(s.aeCon, 0.01), q(s.aeSat, 0.01), q(s.aeSh, 0.25), q(s.aeHi, 0.25), q(s.aeBr, 0.1)
                ].join('|');
                if (nodes.lastKey === key) return `url(#${nodes.fid})`;
                nodes.lastKey = key;

                const qs = (el, k, v) => el.setAttribute(k, v);
                const qall = (list, k, v) => Array.from(list.children).forEach(c => c.setAttribute(k, v));

                qs(nodes.sat, 'values', ((s.sat / 100) * (s.aeSat || 1.0)).toFixed(2));

                const table = getToneTableCached(Utils.clamp((s.aeSh || 0) / 14, -1, 1), Utils.clamp((s.aeHi || 0) / 12, -1, 1), ((s.bright || 0) + (s.aeBr || 0)) / 100, (s.contrast || 1.0) * (s.aeCon || 1.0), s.gain || 1.0);
                qall(nodes.lin, 'tableValues', table);

                const combinedGamma = (s.gamma || 1.0) * (s.aeGamma || 1.0);
                qall(nodes.gam, 'exponent', (1 / Utils.clamp(combinedGamma, 0.2, 3.0)).toFixed(3));

                const t = Utils.clamp(s.temp || 0, -25, 25);
                let rs = 1, gs = 1, bs = 1;
                if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.010; }
                else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.010; }
                nodes.tmp.children[0].setAttribute('slope', rs.toFixed(3));
                nodes.tmp.children[1].setAttribute('slope', gs.toFixed(3));
                nodes.tmp.children[2].setAttribute('slope', bs.toFixed(3));

                const sCurve = (x) => x * x * (3 - 2 * x);
                const v1 = (s.sharp || 0) / 50;
                const kC = sCurve(Math.min(1, v1)) * 2.0;
                qs(nodes.b1, 'stdDeviation', v1 > 0 ? (1.5 - (sCurve(Math.min(1, v1)) * 0.8)).toFixed(2) : '0');
                qs(nodes.sh1, 'k2', (1 + kC).toFixed(3)); qs(nodes.sh1, 'k3', (-kC).toFixed(3));

                const v2 = (s.sharp2 || 0) / 50;
                const kF = sCurve(Math.min(1, v2)) * 3.5;
                qs(nodes.b2, 'stdDeviation', v2 > 0 ? (0.5 - (sCurve(Math.min(1, v2)) * 0.3)).toFixed(2) : '0');
                qs(nodes.sh2, 'k2', (1 + kF).toFixed(3)); qs(nodes.sh2, 'k3', (-kF).toFixed(3));

                const clVal = (s.clarity || 0) / 50;
                qs(nodes.bc, 'stdDeviation', clVal > 0 ? '2.2' : '0');
                qs(nodes.cl, 'k2', (1 + clVal).toFixed(3)); qs(nodes.cl, 'k3', (-clVal).toFixed(3));
                if (nodes.gr) qs(nodes.gr, 'k3', ((s.dither || 0) / 100 * 0.22).toFixed(3));

                return `url(#${nodes.fid})`;
            },
            applyUrl: (el, url) => {
                if (el.style.filter !== url) {
                    el.style.setProperty('filter', url, 'important');
                    el.style.setProperty('-webkit-filter', url, 'important');
                }
            },
            clear: (el) => {
                el.style.removeProperty('filter');
                el.style.removeProperty('-webkit-filter');
            }
        };
    };

    const createAE = (sm, scheduler, { IS_MOBILE, MIN_AE, Utils }, onAE) => {
        let worker, canvas, ctx2d;
        let activeVideo = null;
        let isRunning = false;
        let workerBusy = false;
        let fId = 0;
        let targetToken = 0;
        let lastFidApplied = 0;

        const { clamp } = Utils;
        let curGain = 1.0;
        let aeActive = false;
        let lastStats = { p10: -1, p50: -1, p90: -1, cf: 0.5, std: 0.0, rd: 0.0 };
        let lastApplyT = 0, lastEmaT = 0, lastLuma = -1;
        let lowMotionFrames = 0, dynamicSkipThreshold = 0, frameSkipCounter = 0, evAggressiveUntil = 0;
        let lastSampleT = 0;

        let clipStreak = 0, suspendUntil = 0, lastAggressiveAt = 0;
        let useRVFC = false;
        let rvfcToken = 0;
        let __prevFrame = null;
        let __motion01 = 1;

        const WORKER_CODE = `
            const hist = new Uint16Array(256);
            const histM = new Uint16Array(256);
            self.onmessage = function(e) {
                const { fid, buf, width, height, step, token } = e.data;
                const data = new Uint8Array(buf);
                hist.fill(0); histM.fill(0);
                const w = width, h = height;
                let validCount=0, sumLuma=0, sumLumaSq=0, sumMaxMin=0;
                const y0 = Math.floor(h * 0.10), y1 = Math.ceil(h * 0.90);
                const x0 = Math.floor(w * 0.05), x1 = Math.ceil(w * 0.95);
                const bottomStart = h - Math.floor(h * 0.20);
                let botClipCount = 0, botTotalCount = 0;
                let botSum=0, botSumSq=0, botValid=0;
                let sumRedDom=0;

                for (let y = 0; y < h; y+=step) {
                    const isBottom = y >= bottomStart;
                    for (let x = 0; x < w; x+=step) {
                        const i = (y * w + x) * 4;
                        const r = data[i], g = data[i+1], b = data[i+2];
                        const luma = (r*54 + g*183 + b*19) >> 8;
                        let max = r; if(g>max) max=g; if(b>max) max=b;
                        let min = r; if(g<min) min=g; if(b<min) min=b;
                        if (isBottom) {
                            botTotalCount++;
                            if (luma >= 253) botClipCount++;
                            botSum += luma; botSumSq += luma*luma; botValid++;
                        }
                        if (y < y0 || y > y1 || x < x0 || x > x1) continue;
                        hist[luma]++; histM[max]++;
                        validCount++;
                        sumLuma += luma; sumLumaSq += luma * luma; sumMaxMin += (max - min);
                        const redDom = Math.max(0, r - ((g + b) >> 1));
                        sumRedDom += redDom;
                    }
                }
                let p10=-1, p50=-1, p90=-1, p98=-1, p98m=-1;
                let clipFrac=0, clipFracBottom=0;
                let avgLuma=0, stdDev=0, avgSat=0, redDominance=0;
                let botAvg=0, botStd=0;
                if (validCount > 0) {
                    const inv = 1 / validCount;
                    avgLuma = (sumLuma * inv) / 255;
                    avgSat = (sumMaxMin * inv) / 255;
                    redDominance = (sumRedDom * inv) / 255;
                    const meanSq = (sumLumaSq * inv) / (255*255);
                    stdDev = Math.sqrt(Math.max(0, meanSq - (avgLuma * avgLuma)));
                    clipFrac = (hist[253] + hist[254] + hist[255]) * inv;
                    if (botTotalCount > 0) clipFracBottom = botClipCount / botTotalCount;
                    if (botValid > 0) {
                        const invb = 1/botValid;
                        botAvg = (botSum*invb)/255;
                        const meanSqb = (botSumSq*invb)/(255*255);
                        botStd = Math.sqrt(Math.max(0, meanSqb - botAvg*botAvg));
                    }
                    let sum = 0;
                    const t10=validCount*0.1, t50=validCount*0.5, t90=validCount*0.9, t98=validCount*0.98;
                    for(let i=0; i<256; i++) {
                        sum += hist[i];
                        if(p10<0 && sum>=t10) p10=i/255;
                        if(p50<0 && sum>=t50) p50=i/255;
                        if(p90<0 && sum>=t90) p90=i/255;
                        if(p98<0 && sum>=t98) p98=i/255;
                    }
                    let sumM = 0;
                    for(let i=0; i<256; i++) {
                        sumM += histM[i];
                        if(sumM >= t98) { p98m = i/255; break; }
                    }
                }
                if(p10<0) p10=0.1; if(p50<0) p50=0.5; if(p90<0) p90=0.9; if(p98<0) p98=0.98; if(p98m<0) p98m=p98;
                self.postMessage({ fid, token, p10, p50, p90, p98, p98m, stdDev, clipFrac, clipFracBottom, avgSat, avgLuma, botAvg, botStd, redDominance });
            };
        `;

        function _motionFromFrame(u8) {
            if (!u8 || u8.length < 64) { __motion01 = 1; return __motion01; }
            if (!__prevFrame || __prevFrame.length !== u8.length) {
                __prevFrame = new Uint8Array(u8.length);
                __prevFrame.set(u8);
                __motion01 = 1;
                return __motion01;
            }
            let sum = 0, cnt = 0;
            for (let i = 0; i < u8.length; i += 16) {
                sum += Math.abs(u8[i] - __prevFrame[i]);
                sum += Math.abs(u8[i + 1] - __prevFrame[i + 1]);
                sum += Math.abs(u8[i + 2] - __prevFrame[i + 2]);
                cnt++;
            }
            __prevFrame.set(u8);
            __motion01 = sum / (cnt * 255 * 3);
            return __motion01;
        }

        const disableAEHard = () => {
            worker = null; workerBusy = false; isRunning = false;
            try { sm.set(P.V_AE, false); } catch (e) { }
        };

        const init = () => {
            if (worker || init._tried) return;
            init._tried = true;
            try {
                const blob = new Blob([WORKER_CODE], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                worker = new Worker(url);
                setTimeout(() => URL.revokeObjectURL(url), 0);
                worker.onmessage = (e) => { workerBusy = false; processResult(e.data); };
                worker.onerror = () => disableAEHard();
            } catch (e) { disableAEHard(); }
            window.addEventListener('pagehide', () => { try { worker?.terminate(); } catch (e) { } worker = null; }, { once: true });
        };

        const computeTargetEV = (stats) => {
            const p50 = clamp(stats.p50, 0.01, 0.99);
            const p98 = clamp(stats.p98, 0.01, 0.999);
            const p98m = clamp(stats.p98m ?? p98, 0.01, 0.999);
            const stdDev = clamp(stats.stdDev, 0, 1);
            const darkStart = IS_MOBILE ? 0.22 : 0.26;
            const darkFull = IS_MOBILE ? 0.12 : 0.16;
            const contrast = clamp((stats.p90 - stats.p10), 0, 1);
            const lowKey = (stdDev > MIN_AE.LOWKEY_STDDEV) && (p50 < 0.22) && (contrast > 0.35);

            let targetMid = MIN_AE.TARGET_MID_BASE;
            if (lowKey) targetMid = clamp(targetMid - 0.07, 0.17, 0.28);
            if (p50 < darkFull) targetMid = clamp(targetMid + 0.04, 0.22, 0.36);
            const hiGuard = clamp((clamp(stats.p90, 0, 1) - 0.82) / 0.14, 0, 1);
            targetMid = clamp(targetMid * (1 - hiGuard * 0.08), 0.18, 0.40);

            const dark01 = clamp((darkStart - p50) / (darkStart - darkFull), 0, 1);
            let ev = Math.log2(targetMid / p50) * (MIN_AE.STRENGTH * (0.55 + 0.45 * dark01));

            let maxUp = MIN_AE.MAX_UP_EV;
            if (p50 < 0.10) maxUp = Math.min(MIN_AE.MAX_UP_EV_EXTRA, maxUp * 1.5);
            ev = clamp(ev, MIN_AE.MAX_DOWN_EV, maxUp);

            const maxSafeGainL = 0.99 / p98;
            const maxSafeGainM = 0.99 / p98m;
            const maxSafeGain = Math.min(maxSafeGainL, maxSafeGainM);
            const maxSafeEV = Math.log2(Math.max(1.0, maxSafeGain));
            if (ev > maxSafeEV) ev = maxSafeEV;

            return ev;
        };

        const _computeAeTuningV2 = (totalGain, stats) => {
            const smooth01 = (t) => t * t * (3 - 2 * t);
            const tg = Math.max(1.0, totalGain || 1.0);
            const ev = Math.log2(tg);
            const ev01 = clamp(ev / 1.6, 0, 1);
            const p90 = clamp(stats.p90 || 0, 0, 1);
            const p50 = clamp(stats.p50 || 0, 0, 1);
            const p10 = clamp(stats.p10 || 0, 0, 1);
            const cf = clamp(stats.cf || 0.5, 0, 1);
            const rd = clamp(stats.rd || 0.0, 0, 1);

            const gainGate = smooth01(clamp((tg - 1.0) / 0.35, 0, 1));
            const hiRisk = smooth01(clamp((p90 - 0.86) / 0.10, 0, 1));
            const targetP50 = 0.58 - 0.05 * ev01;
            const midErr = clamp(targetP50 - p50, -0.25, 0.25);
            const darkNeed = smooth01(clamp((0.16 - p10) / 0.14, 0, 1));
            const lowColor = smooth01(clamp((0.34 - cf) / 0.20, 0, 1));
            // [Quality] Red Skin Protection
            const redRisk = smooth01(clamp((rd - 0.06) / 0.10, 0, 1));

            const kB = IS_MOBILE ? 10.0 : 12.5;
            const kS = IS_MOBILE ? 10.0 : 14.0;
            const kH = IS_MOBILE ? 6.0 : 7.5;
            const kC = IS_MOBILE ? 0.035 : 0.050;
            const kG = IS_MOBILE ? 0.035 : 0.050;
            const kSat = IS_MOBILE ? 1.0 : 1.35;

            const brightness = gainGate * ev01 * kB * midErr * (1 - hiRisk * 0.65);
            const shadowLift = gainGate * ev01 * kS * darkNeed * (1 - hiRisk * 0.35);
            const highlightRecover = gainGate * ev01 * kH * hiRisk;
            const contrastBoost = gainGate * ev01 * kC * (1 - hiRisk) * clamp((p50 - 0.55) / 0.20, -1, 1);
            const gammaPull = gainGate * ev01 * kG * clamp(midErr / 0.20, -1, 1) * (1 - hiRisk * 0.7);
            const satBoost = gainGate * kSat * lowColor * (1 - hiRisk * 0.6) * (1 - redRisk * 0.85);

            return { brightness, shadowLift, highlightRecover, contrastBoost, gammaPull, satBoost };
        };

        const updateEma = (stats) => {
            const now = performance.now();
            const dt = Math.max(1, now - (lastEmaT || now));
            lastEmaT = now;
            const tau = 220;
            const a = 1 - Math.exp(-dt / tau);
            const s = lastStats;
            s.p90 = (s.p90 < 0) ? stats.p90 : (stats.p90 * a + s.p90 * (1 - a));
            s.p50 = (s.p50 < 0) ? stats.p50 : (stats.p50 * a + s.p50 * (1 - a));
            s.p10 = (s.p10 < 0) ? stats.p10 : (stats.p10 * a + s.p10 * (1 - a));
            s.cf = (s.cf < 0) ? stats.avgSat : (stats.avgSat * a + s.cf * (1 - a));
            s.std = (stats.stdDev * a + (s.std || 0) * (1 - a));
            s.rd = (stats.redDominance * a + (s.rd || 0) * (1 - a));
            return s;
        };

        const processResult = (data) => {
            if (!data) return;
            if ((data.token ?? -1) !== targetToken) return;
            if (data.fid && data.fid < lastFidApplied) return;
            if (data.fid) lastFidApplied = data.fid;

            const { p10, p50, p90, p98, p98m, stdDev, clipFrac, clipFracBottom, avgSat, avgLuma, botAvg, botStd, redDominance } = data;
            const now = performance.now();

            if (lastLuma >= 0) {
                const delta = Math.abs(avgLuma - lastLuma);
                if (delta > 0.10) {
                    if (now - lastAggressiveAt > 600) {
                        evAggressiveUntil = now + 800;
                        lastAggressiveAt = now;
                    }
                }
            }
            lastLuma = avgLuma;

            const m = __motion01;
            if (m < 0.020) lowMotionFrames++; else lowMotionFrames = 0;

            if (!aeActive && Math.abs(curGain - 1.0) < 0.01 && lowMotionFrames > 30) {
                dynamicSkipThreshold = Math.min(30, dynamicSkipThreshold + 1);
            } else {
                dynamicSkipThreshold = Math.max(0, dynamicSkipThreshold - 2);
            }

            const clipLimit = MIN_AE.CLIP_FRAC_LIMIT;
            const highlightSmall = clipFrac < clipLimit * 0.7;
            const uiBarLikely = (botAvg > 0.20 && botStd < 0.08);
            const subtitleLikely = (clipFracBottom > clipLimit * 1.5) && (p98 > 0.96) && (p50 < 0.22) && (stdDev > 0.06) && !uiBarLikely;
            const clipRisk = ((p98 >= MIN_AE.P98_CLIP && !highlightSmall) || (clipFrac > clipLimit)) && !subtitleLikely;

            if (clipRisk) { clipStreak++; } else { clipStreak = 0; }
            if (clipStreak >= 3) suspendUntil = now + 1200;
            const suspended = now < suspendUntil;

            // [Quality] EMA for Stability
            const statsE = updateEma({ p90, p50, p10, avgSat, stdDev, redDominance });

            let targetEV = 0;
            if (suspended) {
                targetEV = 0;
                aeActive = false;
            } else {
                targetEV = computeTargetEV({
                    p10: statsE.p10, p50: statsE.p50, p90: statsE.p90,
                    p98, p98m, stdDev: statsE.std
                });
                if (subtitleLikely && targetEV > 0) targetEV *= 0.55;
                const th = aeActive ? MIN_AE.DEAD_IN : MIN_AE.DEAD_OUT;
                if (Math.abs(targetEV) < th) { targetEV = 0; aeActive = false; }
                else aeActive = true;
            }

            if (!suspended) {
                const tooBright = (p50 > 0.60 && p98 > 0.985 && stdDev > 0.08);
                if (tooBright) {
                    const down = clamp(Math.log2(0.58 / Math.max(0.01, p50)) * 0.33, MIN_AE.MAX_DOWN_EV, 0);
                    targetEV = Math.min(targetEV, down);
                }
            }

            const targetGain = Math.pow(2, targetEV);
            const dtRaw = now - lastApplyT;
            lastApplyT = now;
            const dt = Math.min(dtRaw, MIN_AE.DT_CAP_MS || 220);

            const currentEV = Math.log2(curGain);
            const diff = Math.log2(targetGain) - currentEV;
            let tau = (diff > 0) ? MIN_AE.TAU_UP : MIN_AE.TAU_DOWN;
            if (evAggressiveUntil && now < evAggressiveUntil) tau = MIN_AE.TAU_AGGRESSIVE;

            const alpha = 1 - Math.exp(-dt / tau);
            curGain = Math.pow(2, currentEV + diff * alpha);
            if (Math.abs(curGain - 1.0) < 0.01) curGain = 1.0;

            const midPct = Math.round(statsE.p50 * 100);

            if (suspended) {
                try { onAE?.({ gain: 1, aeGamma: 1, aeCon: 1, aeSat: 1, aeSh: 0, aeHi: 0, aeBr: 0, luma: midPct }); } catch (e) { }
                return;
            }

            const tg = Math.max(1.0, curGain);
            const ev01 = clamp(Math.log2(tg) / 1.6, 0, 1);
            const exposureGate = clamp((tg - 1.01) / 0.18, 0, 1);
            const hiRisk01 = clamp((statsE.p90 - 0.84) / 0.12, 0, 1);
            const toeCtrlRaw = clamp((IS_MOBILE ? 10 : 12) * exposureGate * ev01 * (1 - hiRisk01 * 0.55), 0, 14);
            const shoulderCtrlRaw = clamp((IS_MOBILE ? 12 : 15) * Math.max(0.25, exposureGate) * hiRisk01, 0, 14);
            const soften = clamp(MIN_AE.TONE_BASE_SOFTEN ?? 1.0, 0.6, 1.0);

            const q05 = (x) => Math.round(x * 2) / 2;
            let aeShOut = q05(toeCtrlRaw * soften);
            let aeHiOut = q05(shoulderCtrlRaw * soften);

            const tuning = _computeAeTuningV2(tg, statsE);

            let aeBr = clamp(tuning.brightness, -10, 12);
            let aeCon = clamp(1 + tuning.contrastBoost, MIN_AE.V91_AECON_MIN, MIN_AE.V91_AECON_MAX);
            let aeGamma = clamp(1 + tuning.gammaPull, MIN_AE.V91_AEGAM_MIN, MIN_AE.V91_AEGAM_MAX);
            let aeSat = clamp(1 + tuning.satBoost, MIN_AE.SAT_MIN, MIN_AE.SAT_MAX);

            aeShOut = q05(clamp(aeShOut + tuning.shadowLift, 0, 14));
            aeHiOut = q05(clamp(aeHiOut + tuning.highlightRecover, 0, 14));

            const res = { gain: curGain, aeGamma, aeCon, aeSat, aeSh: aeShOut, aeHi: aeHiOut, aeBr, luma: midPct };
            try { onAE?.(res); } catch (e) { }
        };

        const sampleFrame = (v) => {
            if (!worker || !v || v.__vsc_tainted) return;
            if (document.hidden || v.readyState < 2) return;
            if (v.__vsc_visible === false) return;

            const now = performance.now();
            if (v.paused) { if (now - lastSampleT < 600) return; }
            else { if (now - lastSampleT < 90) return; }
            lastSampleT = now;

            const playing = (!v.paused && !v.ended);
            const maxSkip = playing ? (MIN_AE.PLAYING_MAX_SKIP ?? 3) : 30;
            const dyn = Math.min(dynamicSkipThreshold, maxSkip);

            if (frameSkipCounter < dyn) { frameSkipCounter++; return; }
            frameSkipCounter = 0;

            if (workerBusy) return;

            try {
                if (!canvas) {
                    canvas = document.createElement('canvas');
                    let size = (IS_LOW_END) ? 24 : 32;
                    canvas.width = size; canvas.height = size;
                    ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
                    if (!ctx2d) { v.__vsc_tainted = true; return; }
                }
                const size = canvas.width;
                ctx2d.drawImage(v, 0, 0, size, size);
                const d = ctx2d.getImageData(0, 0, size, size);
                _motionFromFrame(d.data);

                workerBusy = true;
                const step = (size <= 24) ? 1 : 2;
                worker.postMessage({ buf: d.data.buffer, width: size, height: size, fid: ++fId, step, token: targetToken }, [d.data.buffer]);
            } catch (e) {
                workerBusy = false; v.__vsc_tainted = true;
            }
        };

        let timerId = 0;
        const schedule = (ms) => { clearTimeout(timerId); timerId = setTimeout(tick, ms); };

        const tick = () => {
            if (!isRunning) return;
            const active = sm.get(P.APP_ACT) && sm.get(P.V_AE);
            if (!active || !activeVideo || !activeVideo.isConnected) {
                // [Optimization] Fallback timer even if RVFC is active
                schedule(800);
                return;
            }
            sampleFrame(activeVideo);
            if (!useRVFC) {
                let interval = 90;
                if (dynamicSkipThreshold >= 12) interval = 160;
                if (IS_LOW_END) interval = Math.max(interval, 200);
                schedule(interval);
            }
        };

        const rvfcLoop = (token) => {
            if (!isRunning) return;
            if (token !== rvfcToken) return;
            const v = activeVideo;
            if (!v || !useRVFC) return;
            tick();
            try { v.requestVideoFrameCallback(() => rvfcLoop(token)); } catch (e) { }
        };

        return {
            setTarget: (v) => {
                if (v !== activeVideo) {
                    activeVideo = v;
                    targetToken++;
                    workerBusy = false;
                    evAggressiveUntil = performance.now() + 800;
                    dynamicSkipThreshold = 0;
                    frameSkipCounter = 0;
                    lowMotionFrames = 0;
                    lastLuma = -1;
                    __prevFrame = null;
                    __motion01 = 1;
                    useRVFC = !!v?.requestVideoFrameCallback;
                    if (useRVFC && v) {
                        rvfcToken++;
                        const token = rvfcToken;
                        try { v.requestVideoFrameCallback(() => rvfcLoop(token)); } catch (e) { }
                    }
                }
            },
            start: () => { init(); if (!isRunning) { isRunning = true; } if (!useRVFC) schedule(0); },
            stop: () => {
                isRunning = false; workerBusy = false; activeVideo = null;
                rvfcToken++; useRVFC = false; clearTimeout(timerId);
                curGain = 1.0; aeActive = false;
            },
            wake: () => { evAggressiveUntil = performance.now() + 1000; dynamicSkipThreshold = 0; },
            userTweak: () => {
                const now = performance.now();
                lastStats = { p10: -1, p50: -1, p90: -1, cf: 0.5, std: 0.0, rd: 0.0 };
                lastEmaT = 0; lastSampleT = 0; lowMotionFrames = 0;
                dynamicSkipThreshold = 0; frameSkipCounter = 0;
                clipStreak = 0; suspendUntil = 0;
                evAggressiveUntil = now + 1200;
                __prevFrame = null; __motion01 = 1;
            }
        };
    };

    const createUI = (Utils, sm, scheduler, defaults, config, registry) => {
        const { h } = Utils;
        let container, monitorEl, gearTrigger;

        const SLIDERS = [
            { l: '감마', k: P.V_GAMMA, min: 0.5, max: 2.5, s: 0.05, f: v => v.toFixed(2) },
            { l: '대비', k: P.V_CONTR, min: 0.5, max: 2.0, s: 0.05, f: v => v.toFixed(2) },
            { l: '밝기', k: P.V_BRIGHT, min: -50, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '채도', k: P.V_SAT, min: 0, max: 200, s: 5, f: v => v.toFixed(0) },
            { l: '윤곽', k: P.V_SHARP, min: 0, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '디테일', k: P.V_SHARP2, min: 0, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '명료', k: P.V_CLARITY, min: 0, max: 50, s: 5, f: v => v.toFixed(0) },
            { l: '색온도', k: P.V_TEMP, min: -25, max: 25, s: 1, f: v => v.toFixed(0) },
            { l: '그레인', k: P.V_DITHER, min: 0, max: 100, s: 5, f: v => v.toFixed(0) },
            { l: '오디오', k: P.A_BST, min: 0, max: 12, s: 1, f: v => `+${v}dB` }
        ];

        // [Fix] UI Root Finder for Video Fullscreen
        const getUiRoot = () => {
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) {
                // Video tags cannot have children; use parent or host
                if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode().host || document.body;
                return fs;
            }
            return document.body || document.documentElement;
        };

        const promoteFullscreenContainerIfVideo = async () => {
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (!fs || fs.tagName !== 'VIDEO') return;
            const parent = fs.parentElement;
            if (!parent || parent === fs) return;
            try {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } catch (e) { }
            requestAnimationFrame(() => {
                try { parent.requestFullscreen?.(); } catch (e) { try { parent.webkitRequestFullscreen?.(); } catch (e2) { } }
            });
        };

        const build = () => {
            if (container) return;
            const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' });
            const shadow = host.attachShadow({ mode: 'open' });
            const $ = (s) => shadow.querySelector(s);

            const style = `
                .main { position: fixed; top: 10%; right: 50px; width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; }
                .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 2px solid #444; position: sticky; top: -15px; background: #191919; z-index: 2; padding-top: 5px; }
                .tab { flex: 1; padding: 12px; background: #222; border: 0; color: #999; cursor: pointer; border-radius: 10px 10px 0 0; font-weight: bold; font-size: 13px; }
                .tab.active { background: #333; color: #3498db; border-bottom: 3px solid #3498db; }
                .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; }
                .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; }
                .btn.active { background: #3498db; color: white; border-color: #2980b9; }
                .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; }
                .pbtn.active { background: #e67e22; color: white; border-color: #d35400; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12px; row-gap: 8px; margin-top: 8px; }
                .slider { display: flex; flex-direction: column; gap: 4px; color: #ccc; }
                .slider label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 500; }
                input[type=range] { width: 100%; accent-color: #3498db; cursor: pointer; height: 24px; margin: 4px 0; }
                .monitor { font-size: 12px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 8px; margin-top: 12px; }
                hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }
            `;

            const renderSlider = (cfg) => {
                const valEl = h('span', { style: 'color:#3498db' }, '0');
                const inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
                const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, update);
                update(sm.get(cfg.k));

                let rafId = 0, pending = null;
                const flush = () => { rafId = 0; if (pending == null) return; sm.set(cfg.k, pending); pending = null; };
                inp.addEventListener('input', () => { const v = Number(inp.value); valEl.textContent = cfg.f(v); pending = v; if (!rafId) rafId = requestAnimationFrame(flush); }, { passive: true });
                inp.addEventListener('pointerup', () => { document.dispatchEvent(new CustomEvent('vsc-user-tweak')); }, { passive: true });

                return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp);
            };

            const renderPresetRow = (label, items, key, onSelect, offBatch) => {
                const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
                items.forEach(it => {
                    const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.l || it.txt);
                    b.onclick = () => { sm.set(key, it.l || it.txt); onSelect(it); document.dispatchEvent(new CustomEvent('vsc-user-tweak')); };
                    sm.sub(key, v => b.classList.toggle('active', v === (it.l || it.txt)));
                    r.append(b);
                });
                const off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF');
                off.onclick = () => { sm.set(key, 'off'); sm.batch('video', offBatch); document.dispatchEvent(new CustomEvent('vsc-user-tweak')); };
                sm.sub(key, v => off.classList.toggle('active', v === 'off'));
                r.append(off);
                return r;
            };

            const bodyV = h('div', { id: 'p-v' }, [
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
                    h('button', {
                        id: 'ae-btn',
                        class: 'btn',
                        onclick: () => {
                            const nextState = !sm.get(P.V_AE);
                            sm.set(P.V_AE, nextState);
                            if (nextState && config.IS_TOP) {
                                const videos = Array.from(registry.videos);
                                if (videos.length === 0) {
                                    if (monitorEl) {
                                        monitorEl.textContent = "⚠️ 탑 프레임: 영상 없음 (하위 프레임 제어 중)";
                                        monitorEl.style.color = "#e67e22";
                                    }
                                } else if (!videos.some(v => !v.__vsc_tainted)) {
                                    if (monitorEl) {
                                        monitorEl.textContent = "🚫 탑 프레임: 보안(CORS) 제한으로 제어 불가";
                                        monitorEl.style.color = "#e74c3c";
                                    }
                                }
                            }
                        }
                    }, '🤖 자동'),
                    h('button', { id: 'boost-btn', class: 'btn', onclick: () => sm.set(P.A_EN, !sm.get(P.A_EN)) }, '🔊 부스트')
                ),
                h('div', { class: 'prow' },
                    h('button', {
                        class: 'btn', onclick: () => {
                            sm.batch('video', { ...defaults.video, presetS: sm.get('video.presetS'), presetB: sm.get('video.presetB') });
                            sm.batch('audio', defaults.audio);
                            document.dispatchEvent(new CustomEvent('vsc-user-tweak'));
                        }
                    }, '↺ 리셋'),
                    h('button', { id: 'pwr-btn', class: 'btn', onclick: () => sm.set(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power')
                ),
                renderPresetRow('샤프', [{ l: 'S', v1: 8, v2: 3 }, { l: 'M', v1: 15, v2: 6 }, { l: 'L', v1: 25, v2: 10 }, { l: 'XL', v1: 35, v2: 15 }], 'video.presetS',
                    (it) => sm.batch('video', { sharp: it.v1, sharp2: it.v2 }), { sharp: 0, sharp2: 0 }),
                renderPresetRow('밝기', [
                    { txt: 'S', g: 1.00, b: 2, c: 1.00, s: 100 },
                    { txt: 'M', g: 1.08, b: 4, c: 1.00, s: 100 },
                    { txt: 'L', g: 1.16, b: 6, c: 1.00, s: 100 },
                    { txt: 'DS', g: 1.00, b: 3.6, c: 1.00, s: 100 },
                    { txt: 'DM', g: 1.10, b: 7.2, c: 1.00, s: 100 },
                    { txt: 'DL', g: 1.22, b: 10.8, c: 1.00, s: 100 }
                ], 'video.presetB', (it) => sm.batch('video', { gamma: it.g, bright: it.b, contrast: it.c, sat: it.s }), { gamma: 1.0, bright: 0, contrast: 1.0, sat: 100 }),
                h('hr'),
                h('div', { class: 'grid' }, SLIDERS.map(renderSlider)),
                h('hr'),
                h('div', { class: 'prow', style: 'justify-content:center;gap:4px;' },
                    [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
                        const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
                        b.onclick = () => sm.set(P.PB_RATE, s);
                        sm.sub(P.PB_RATE, v => b.classList.toggle('active', Math.abs(v - s) < 0.01));
                        return b;
                    })
                )
            ]);

            const bodyI = h('div', { id: 'p-i', style: 'display:none' }, [
                h('div', { class: 'grid' }, [
                    renderSlider({ l: '이미지 윤곽', k: P.I_LVL, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }),
                    renderSlider({ l: '이미지 색온도', k: P.I_TMP, min: -20, max: 20, s: 1, f: v => v.toFixed(0) })
                ])
            ]);

            shadow.append(h('style', {}, style), h('div', { class: 'main' }, [
                h('div', { class: 'tabs' }, [
                    h('button', { id: 't-v', class: 'tab active', onclick: () => sm.set(P.APP_TAB, 'video') }, 'VIDEO'),
                    h('button', { id: 't-i', class: 'tab', onclick: () => sm.set(P.APP_TAB, 'image') }, 'IMAGE')
                ]),
                bodyV, bodyI, monitorEl = h('div', { class: 'monitor' }, 'Ready (v132.0.93 Secure)')
            ]));

            sm.sub(P.APP_TAB, v => {
                $('#t-v').classList.toggle('active', v === 'video');
                $('#t-i').classList.toggle('active', v === 'image');
                $('#p-v').style.display = v === 'video' ? 'block' : 'none';
                $('#p-i').style.display = v === 'image' ? 'block' : 'none';
            });
            sm.sub(P.V_AE, v => $('#ae-btn').classList.toggle('active', !!v));
            sm.sub(P.A_EN, v => $('#boost-btn').classList.toggle('active', !!v));
            sm.sub(P.APP_ACT, v => $('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');

            container = host;
            getUiRoot().appendChild(container);
        };

        gearTrigger = h('div', {
            'data-vsc-ui': '1',
            style: 'position:fixed;top:45%;right:0;width:44px;height:44px;background:rgba(0,0,0,0.7);z-index:2147483647;cursor:pointer;display:none;align-items:center;justify-content:center;border-radius:12px 0 0 12px;color:#fff;font-size:22px;',
            onclick: async () => {
                build();
                await promoteFullscreenContainerIfVideo();
                sm.set(P.APP_UI, !sm.get(P.APP_UI));
                requestUISync();
            }
        }, '⚙️');

        let uiQueued = false;
        const requestUISync = () => {
            if (uiQueued) return;
            uiQueued = true;
            requestAnimationFrame(() => {
                uiQueued = false;
                const root = getUiRoot();
                if (gearTrigger.parentElement !== root) root.appendChild(gearTrigger);
                if (container && container.parentElement !== root) root.appendChild(container);
                // [Fix] Always show gear if I am the active frame (Top or Fullscreen Frame)
                gearTrigger.style.display = (config.IS_TOP || document.fullscreenElement) ? 'flex' : 'none';
            });
        };
        ['fullscreenchange', 'webkitfullscreenchange', 'resize', 'scroll'].forEach(ev => window.addEventListener(ev, requestUISync, { passive: true }));
        requestUISync();

        if (document.body) getUiRoot().appendChild(gearTrigger);
        else document.addEventListener('DOMContentLoaded', () => getUiRoot().appendChild(gearTrigger));

        sm.sub(P.APP_UI, v => {
            if (container) container.style.display = v ? 'block' : 'none';
            requestUISync();
        });

        return {
            update: (m, act) => {
                if (monitorEl && container?.style.display !== 'none') {
                    monitorEl.textContent = m;
                    monitorEl.style.color = act ? '#4cd137' : '#aaa';
                }
            }
        };
    };

    // ==========================================
    // MAIN ENTRY
    // ==========================================
    const Utils = createUtils();
    const Scheduler = createScheduler();
    const Store = createSyncStore(DEFAULTS, Scheduler, { IS_TOP });

    const FEATURES = {
        images: () => {
            if (!Store.get(P.APP_ACT)) return false;
            if (Store.get(P.APP_TAB) === 'image') return true;
            return Store.get(P.I_LVL) !== DEFAULTS.image.level || Store.get(P.I_TMP) !== DEFAULTS.image.temp;
        },
        ae: () => Store.get(P.APP_ACT) && Store.get(P.V_AE),
        audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN)
    };
    const Registry = createRegistry(Scheduler, FEATURES);
    const Filters = createFilters(Utils, { VSC_ID });
    const Audio = createAudio(Store);

    let currentAE = { gain: 1.0, aeGamma: 1.0, aeCon: 1.0, aeSat: 1.0, aeSh: 0, aeHi: 0, aeBr: 0, luma: 0 };
    let aeRev = 0;

    const AE = createAE(Store, Scheduler, { IS_MOBILE, MIN_AE, Utils }, (ae) => {
        currentAE = ae;
        aeRev++;
        Scheduler.request(false);
    });

    const UI = createUI(Utils, Store, Scheduler, DEFAULTS, { IS_TOP }, Registry);

    document.addEventListener('vsc-user-tweak', () => { if (FEATURES.ae()) AE.userTweak(); });

    let lastSRev = -1, lastRRev = -1, lastAeRev = -1;
    let lastPrune = 0;
    let lastWantImages = false;
    let lastPickedVideo = null;

    const syncImageScan = () => {
        const want = FEATURES.images();
        if (want && !lastWantImages) Registry.rescanAll();
        if (!want && lastWantImages) Registry.setWantImages(false);
        lastWantImages = want;
    };
    Store.sub(P.APP_TAB, syncImageScan);
    Store.sub(P.I_LVL, syncImageScan);
    Store.sub(P.I_TMP, syncImageScan);

    Store.sub(P.V_AE, (v) => { if (!v) AE.stop?.(); });

    const pickBestVideo = (videos) => {
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs) {
            const v = (fs.tagName === 'VIDEO') ? fs : fs.querySelector?.('video');
            if (v && videos.has(v) && v.isConnected && v.readyState >= 2) { lastPickedVideo = v; return v; }
        }
        if (document.pictureInPictureElement && videos.has(document.pictureInPictureElement)) { lastPickedVideo = document.pictureInPictureElement; return document.pictureInPictureElement; }

        const cx = window.innerWidth * 0.5;
        const cy = window.innerHeight * 0.5;
        let best = null;
        let bestScore = -1;

        for (const v of videos) {
            if (!v || !v.isConnected || v.readyState < 2) continue;
            const cs = getComputedStyle(v);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const op = Number(cs.opacity || '1');
            if (op < 0.06) continue;

            const r = v.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < 12000) continue;
            const inViewport = !(r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth);
            if (!inViewport) continue;

            const playing = (!v.paused && !v.ended) ? 1 : 0;
            const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
            const dist = Math.hypot((r.left + r.width * 0.5) - cx, (r.top + r.height * 0.5) - cy);
            const distScore = 1 / (1 + dist / 850);
            const bgPenalty = (v.muted && !v.controls && playing) ? 1.2 : 0;
            const fullBgPenalty = (area > innerWidth * innerHeight * 0.75 && !hasTime && !v.controls) ? 2.2 : 0;

            const score = (playing * 6) + (hasTime * 2.5) + (area / 120000) + (distScore * 3.2) + (v.controls ? 0.4 : 0) - bgPenalty - fullBgPenalty;
            if (score > bestScore) { bestScore = score; best = v; }
        }
        lastPickedVideo = best || lastPickedVideo;
        return best;
    };

    const applyVideoFilters = (visibleVideos, vVals, active) => {
        let lastDoc = null;
        let url = null;
        for (const el of visibleVideos) {
            const isVis = (el.__vsc_visible !== false);
            if (!active || !isVis) { Filters.clear(el); continue; }
            const doc = el.ownerDocument || document;
            if (doc !== lastDoc) { lastDoc = doc; url = Filters.prepare(doc, vVals, 'video'); }
            Filters.applyUrl(el, url);
            TOUCHED.videos.add(el);
            if (!el.__vsc_bound) {
                el.__vsc_bound = true;
                el.addEventListener('seeking', () => AE.wake(), { passive: true });
                el.addEventListener('play', () => AE.wake(), { passive: true });
            }
        }
    };

    const applyImageFilters = (visibleImages, iVals, active) => {
        let lastDoc = null;
        let url = null;
        for (const el of visibleImages) {
            const isVis = (el.__vsc_visible !== false);
            if (!active || !isVis) { Filters.clear(el); continue; }
            const w = el.naturalWidth || el.width;
            const h = el.naturalHeight || el.height;
            if (w > 50 && h > 50) {
                const doc = el.ownerDocument || document;
                if (doc !== lastDoc) { lastDoc = doc; url = Filters.prepare(doc, iVals, 'image'); }
                Filters.applyUrl(el, url);
                TOUCHED.images.add(el);
            }
        }
    };

    const applyPlaybackRate = (visibleVideos, desiredRate, active) => {
        for (const el of visibleVideos) {
            const isVis = (el.__vsc_visible !== false);
            if (!active || !isVis) {
                if (el.__vsc_origRate != null) try { el.playbackRate = el.__vsc_origRate; } catch (e) { }
                el.__vsc_origRate = null;
                continue;
            }
            if (el.__vsc_origRate == null) el.__vsc_origRate = el.playbackRate;
            if (Math.abs(el.playbackRate - desiredRate) > 0.01) el.playbackRate = desiredRate;
        }
    };

    const cleanupAllTouched = () => {
        for (const v of TOUCHED.videos) {
            try { Filters.clear(v); } catch (e) { }
            try { if (v.__vsc_origRate != null) v.playbackRate = v.__vsc_origRate; v.__vsc_origRate = null; } catch (e) { }
        }
        for (const i of TOUCHED.images) try { Filters.clear(i); } catch (e) { }
        TOUCHED.videos.clear(); TOUCHED.images.clear();
    };

    Scheduler.registerApply((force) => {
        try {
            const active = Store.get(P.APP_ACT);
            if (!active) { cleanupAllTouched(); Audio.update(); AE.stop?.(); return; }

            const sRev = Store.rev();
            const rRev = Registry.rev();
            const onlyVisChange = (!force && sRev === lastSRev && rRev !== lastRRev && aeRev === lastAeRev);
            if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev) return;

            lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev;
            const now = performance.now();
            if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }

            const vf = Store.get('video');
            const img = Store.get('image');
            const wantImages = FEATURES.images();
            const wantAE = FEATURES.ae();
            const wantAudio = FEATURES.audio();

            if (!wantAE) AE.stop?.();

            let aeGain = 1.0, aeSh = 0, aeHi = 0, aeGamma = 1.0, aeCon = 1.0, aeSat = 1.0, aeBr = 0;
            if (wantAE) {
                aeGain = currentAE.gain;
                aeSh = currentAE.aeSh;
                aeHi = currentAE.aeHi;
                aeGamma = currentAE.aeGamma;
                aeCon = currentAE.aeCon;
                aeSat = currentAE.aeSat;
                aeBr = currentAE.aeBr;
            }

            const hasPreset = (vf.presetB !== 'brOFF' || vf.presetS !== 'off');
            const userStrong = Math.abs(vf.bright) > 10 || Math.abs(vf.gamma - 1) > 0.1 || Math.abs(vf.contrast - 1) > 0.1 || Math.abs(vf.sat - 100) > 25;
            const styleMix = (hasPreset || userStrong) ? 0.55 : 1.0;

            let effAeSh = aeSh * styleMix;
            let effAeHi = aeHi * styleMix;

            let sharpMul = 1.0;
            if (wantAE) {
                const gUp = Math.max(0, aeGain - 1.0);
                sharpMul *= 1 / (1 + gUp * 1.6);
                sharpMul = Math.max(0.55, sharpMul);
            }

            const vVals = {
                gain: aeGain, gamma: vf.gamma, contrast: vf.contrast, bright: vf.bright, sat: vf.sat,
                aeGamma, aeCon, aeSat, aeSh: effAeSh, aeHi: effAeHi, aeBr,
                sharp: Math.round(vf.sharp * sharpMul), sharp2: Math.round(vf.sharp2 * sharpMul),
                clarity: Math.round(vf.clarity * sharpMul), dither: vf.dither, temp: vf.temp
            };

            const iVals = {
                gain: 1.0, gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
                sharp: img.level, sharp2: 0, clarity: 0, dither: 0, temp: img.temp
            };

            if (wantAE && Store.get(P.APP_UI)) {
                UI.update(`AE: ${aeGain.toFixed(2)}x (In: ${currentAE.luma || 0}%)`, true);
            }

            const { visible } = Registry;
            const dirty = onlyVisChange ? Registry.consumeDirty() : null;
            const vidsToProcess = onlyVisChange ? dirty.videos : visible.videos;
            const imgsToProcess = wantImages ? (onlyVisChange ? dirty.images : visible.images) : null;

            const target = pickBestVideo(visible.videos);
            if (wantAE) { AE.setTarget(target); AE.start(); }

            if (wantAudio) for (const el of visible.videos) Audio.attach(el);
            for (const el of visible.videos) { if (!el.isConnected) Audio.detachIfDead(el); }
            Audio.update();

            applyVideoFilters(vidsToProcess, vVals, active);
            if (imgsToProcess) applyImageFilters(imgsToProcess, iVals, active);
            applyPlaybackRate(vidsToProcess, Store.get(P.PB_RATE), active);
        } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch (_) { } }
    });

    Store.sub(P.APP_ACT, () => Scheduler.request(true));
    Store.sub('video.*', () => Scheduler.request(false));
    Store.sub('image.*', () => Scheduler.request(false));
    Store.sub('audio.*', () => Scheduler.request(false));
    Store.sub(P.PB_RATE, () => Scheduler.request(false));

    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => {
        window.addEventListener(ev, () => Scheduler.request(true), { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) Scheduler.request(true);
    }, { passive: true });

    setInterval(() => {
        if (!Store.get(P.APP_ACT)) return;
        if (document.hidden) return;
        Scheduler.request(false);
    }, 12000);
})();
