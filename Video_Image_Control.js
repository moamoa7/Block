// ==UserScript==
// @name        Video_Image_Control (Local_Indep_v158_AELiteCore)
// @namespace   https://github.com/
// @version     158.0.0.0
// @description Video Control: Zero-Alloc, Single-pass Lite SVG, Detail Unified, Optimized AE Core
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

    // 1-1. Safe attachShadow Patch (Anti-Detection)
    (function patchAttachShadowOnce() {
        try {
            const proto = Element.prototype;
            if (!proto.attachShadow) return;

            const VSC_PATCH = Symbol.for('vsc.patch.attachShadow');
            if (proto[VSC_PATCH]) return;

            const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
            const orig = desc && desc.value;
            if (typeof orig !== 'function') return;

            try { Object.defineProperty(proto, VSC_PATCH, { value: true }); }
            catch (_) { proto[VSC_PATCH] = true; }

            function wrappedAttachShadow(init) {
                const shadow = orig.call(this, init);
                try {
                    const mode = init && init.mode;
                    if (shadow && mode === 'open') {
                        document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: shadow }));
                    }
                } catch (_) {}
                return shadow;
            }

            try {
                Object.defineProperty(wrappedAttachShadow, 'toString', {
                    value: Function.prototype.toString.bind(orig),
                    configurable: true
                });
            } catch (_) {}

            if (desc && desc.configurable === false && desc.writable === false) return;

            Object.defineProperty(proto, 'attachShadow', {
                ...desc,
                value: wrappedAttachShadow
            });

        } catch (e) {
            try { console.warn('[VSC] attachShadow patch failed:', e); } catch(_) {}
        }
    })();

    const CONFIG = Object.freeze({
        VERSION: "v158.AELiteCore",
        IS_TOP: window === window.top,
        IS_MOBILE: /Mobi|Android|iPhone/i.test(navigator.userAgent),
        IS_LOW_END: (navigator.deviceMemory || 4) < 4,
        TOUCHED_MAX: ((navigator.deviceMemory || 4) < 4) ? 60 : 140,
        VSC_ID: Math.random().toString(36).slice(2)
    });

    const ENABLE_UI = true;

    const VSCX = Object.freeze({
        visible: Symbol('vsc.visible'),
        rect: Symbol('vsc.rect'),
        ir: Symbol('vsc.ir'),
        bound: Symbol('vsc.bound'),
        rateState: Symbol('vsc.rateState'),
        tainted: Symbol('vsc.tainted'),
        audioFail: Symbol('vsc.audioFail'),
        applied: Symbol('vsc.applied')
    });

    const MODEL = Object.freeze({
        aeProfiles: [
            { id: 'balanced', label: '표준' },
            { id: 'cinematic', label: '영화' },
            { id: 'bright', label: '밝게' }
        ],
        tonePresets: [
            { id: 'neutral', label: '기본' },
            { id: 'highlight', label: '조명' },
            { id: 'redSkin', label: '피부' }
        ],
        detailPresets: ['S', 'M', 'L', 'XL'],
        brightPresets: ['S', 'M', 'L', 'DS', 'DM', 'DL']
    });

    // === AE CONSTANTS (Unified) ===
    const AE_COMMON = Object.freeze({
        CLIP_FRAC_LIMIT: 0.0032,
        DEAD_IN: 0.035,
        TAU_UP: 820, TAU_DOWN: 760, TAU_AGGRESSIVE: 220,
        SAT_MIN: 0.88, SAT_MAX: 1.16,
        DT_CAP_MS: 220,
    });

    const AE_DEVICE_BASE = Object.freeze({
        pc:     { STRENGTH: 0.62, MAX_UP_EV: 0.50, MAX_DOWN_EV: -0.36, TARGET_MID_BASE: 0.265 },
        mobile: { STRENGTH: 0.52, MAX_UP_EV: 0.48, MAX_DOWN_EV: -0.32, TARGET_MID_BASE: 0.260 }
    });

    const AE_PROFILES = Object.freeze({
        balanced: {
            STRENGTH: 0.56, TARGET_MID_BASE: 0.245, MAX_UP_EV: 0.40, MAX_DOWN_EV: -0.34, TONE_BIAS: 0.0,
            LOOK: { brMul: 0.98, satMul: 0.98, conMul: 1.00 }
        },
        cinematic: {
            STRENGTH: 0.44, TARGET_MID_BASE: 0.220, MAX_UP_EV: 0.24, MAX_DOWN_EV: -0.42, TONE_BIAS: -0.65,
            LOOK: { brMul: 0.90, satMul: 0.92, conMul: 0.99 }
        },
        bright: {
            STRENGTH: 0.70, TARGET_MID_BASE: 0.285, MAX_UP_EV: 0.62, MAX_DOWN_EV: -0.26, TONE_BIAS: +0.65,
            LOOK: { brMul: 1.08, satMul: 1.06, conMul: 1.01 }
        }
    });

    const PRESET = Object.freeze({
        detail: { 
            off: { detailAdd: 0 },
            S:   { detailAdd: 10 },
            M:   { detailAdd: 18 },
            L:   { detailAdd: 28 },
            XL:  { detailAdd: 38 }
        },
        grade: {
            brOFF: { gammaF: 1.00, brightAdd: 0, conF: 1.00, satF: 1.00, tempAdd: 0 },
            S: { gammaF: 1.00, brightAdd: 2, conF: 1.00, satF: 1.00, tempAdd: 0 },
            M: { gammaF: 1.08, brightAdd: 4, conF: 1.00, satF: 1.00, tempAdd: 0 },
            L: { gammaF: 1.16, brightAdd: 6, conF: 1.00, satF: 1.00, tempAdd: 0 },
            DS: { gammaF: 1.00, brightAdd: 3.6, conF: 1.00, satF: 1.00, tempAdd: 0 },
            DM: { gammaF: 1.10, brightAdd: 7.2, conF: 1.00, satF: 1.00, tempAdd: 0 },
            DL: { gammaF: 1.22, brightAdd: 10.8, conF: 1.00, satF: 1.00, tempAdd: 0 }
        }
    });

    const TONE_PRESET2 = Object.freeze({
        neutral: { toe: 0.0, shoulder: 0.0, mid: 0.0, con: 1.00, sat: 1.00, br: 0.0, tmp: 0.0 },
        redSkin: { toe: 1.4, shoulder: 0.6, mid: 0.35, con: 1.03, sat: 1.05, br: 0.8, tmp: +2.0 },
        highlight: { toe: 0.4, shoulder: 2.6, mid: -0.15, con: 0.99, sat: 0.98, br: -0.2, tmp: -1.0 },
    });

    const DEFAULTS = {
        video: {
            gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, temp: 0, detail: 0, dither: 0,
            ae: false, presetS: 'off', presetB: 'brOFF',
            presetMix: 1.0, aeProfile: null, tonePreset: null, toneStrength: 1.0, aeStrength: 1.0
        },
        image: { level: 15, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const P = Object.freeze({
        APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_TAB: 'app.tab',
        V_AE: 'video.ae', V_AE_PROFILE: 'video.aeProfile', V_AE_STR: 'video.aeStrength',
        V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength',
        V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright',
        V_SAT: 'video.sat', V_DETAIL: 'video.detail',
        V_TEMP: 'video.temp', V_DITHER: 'video.dither',
        V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix',
        A_EN: 'audio.enabled', A_BST: 'audio.boost',
        PB_RATE: 'playback.rate',
        I_LVL: 'image.level', I_TMP: 'image.temp'
    });

    const TOUCHED = { videos: new Set(), images: new Set() };
    const CFG = { applyToAllVisibleVideos: false, extraApplyTopK: 2 };

    function touchedAddLimited(set, el, onEvict) {
        if (!el) return;
        if (set.has(el)) {
            set.delete(el); set.add(el); return;
        }
        set.add(el);
        if (set.size <= CONFIG.TOUCHED_MAX) return;
        
        const it = set.values();
        const dropN = Math.ceil(CONFIG.TOUCHED_MAX * 0.25);
        for (let i = 0; i < dropN; i++) {
            const v = it.next().value;
            if (v == null) break;
            set.delete(v);
            try { onEvict && onEvict(v); } catch (_) {}
        }
    }

    const insertTopN = (arr, item, N) => {
        let i = 0;
        while (i < arr.length && arr[i].s >= item.s) i++;
        if (i >= N) return;
        arr.splice(i, 0, item);
        if (arr.length > N) arr.length = N;
    };

    // === Shared Helpers ===
    function split2(p) { const i = p.indexOf('.'); return (i > 0) ? [p.slice(0, i), p.slice(i + 1)] : [p, '']; }
    const lerp = (a, b, t) => a + (b - a) * t;

    function getRectCached(v, now, maxAgeMs = 420) {
        const t0 = v.__vscRectT || 0;
        let r = v[VSCX.rect];
        if (!r || (now - t0) > maxAgeMs) {
            r = v.getBoundingClientRect();
            v[VSCX.rect] = r; v.__vscRectT = now;
        }
        return r;
    }

    function createTargeting({ Utils }) {
        let __currentTarget = null, __currentSince = 0;
        const __applySetReuse = new Set();
        const __topBuf = [];
        const __scoreCache = new WeakMap();
        
        function isActuallyVisibleFast(el, now, maxAgeMs = 420) {
            if (!el || !el.isConnected) return null;
            if (el[VSCX.visible] === false) return null;
            const r = getRectCached(el, now, maxAgeMs);
            if (r.width < 80 || r.height < 60) return null;
            if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
            return r;
        }
        
        function scoreVideo(v, audioBoostOn, now, lastUserPt) {
            if (!v || v.readyState < 2) return -Infinity;
            const r = isActuallyVisibleFast(v, now, 800); 
            if (!r) return -Infinity;
        
            const area = r.width * r.height;
            const areaScore = Math.log2(1 + area / 20000);
            const playing = (!v.paused && !v.ended) ? 1 : 0;
            const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
            const dist = Math.hypot((r.left + r.width * 0.5) - lastUserPt.x, (r.top + r.height * 0.5) - lastUserPt.y);
            const distScore = 1 / (1 + dist / 850);
            const userRecent01 = Math.max(0, 1 - (now - lastUserPt.t) / 2500);
        
            const userBoostRaw = userRecent01 * (1 / (1 + dist / 500)) * 2.0;
            const userBoost = Math.min(1.3, userBoostRaw);
        
            const ir = (v[VSCX.ir] == null) ? 0.01 : v[VSCX.ir];
            const irScore = Math.min(1, ir) * 3.2;
            
            const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0;
            const bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
            const big01 = Math.min(1, area / (900 * 500));
            let bgPenalty = 0;
        
            const autoplay = v.autoplay || v.hasAttribute?.('autoplay');
            const loop = v.loop || v.hasAttribute?.('loop');
            const noControls = !v.controls;
            const edgeLike = (r.top < 40 || (innerHeight - r.bottom) < 40 || r.left < 20 || (innerWidth - r.right) < 20);
            const tiny = area < (260 * 160);
        
            if (v.muted && autoplay && noControls) {
                bgPenalty += 1.1;
                if (edgeLike) bgPenalty += 0.9;
                if (tiny) bgPenalty += 0.8;
                if (loop) bgPenalty += 0.35;
            } else if (bgLike && !audible) {
                bgPenalty = (1.6 * (1 - 0.65 * big01));
                if (userRecent01 > 0.15) bgPenalty *= 0.55;
            }
            
            const audibleBase = audible * 1.35;
            const audioScore = audioBoostOn ? (audible * 1.2) : 0;
            return (playing * 6.0) + (hasTime * 2.4) + (areaScore * 1.2) + (distScore * 3.0) + userBoost + irScore + audibleBase + audioScore - bgPenalty;
        }

        const scoreVideoCached = (v, audioBoostOn, now, lastUserPt) => {
            const c = __scoreCache.get(v);
            if (c && (now - c.t) < 60) return c.s;
            const s = scoreVideo(v, audioBoostOn, now, lastUserPt);
            __scoreCache.set(v, { t: now, s });
            return s;
        };

        const pick = (videos, lastClicked, lastUserPt, audioBoostOn) => {
            const now = performance.now();
            if (!videos || videos.size === 0) { __currentTarget = null; __currentSince = now; return null; }
            
            if (lastClicked && videos.has(lastClicked) && lastClicked.isConnected && lastClicked.readyState >= 2) {
                if (now - lastUserPt.t < 900) { __currentTarget = lastClicked; __currentSince = now; return lastClicked; }
            }
            
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) {
                const v = (fs.tagName === 'VIDEO') ? fs : fs.querySelector?.('video');
                if (v && videos.has(v) && v.isConnected && v.readyState >= 2) { __currentTarget = v; __currentSince = now; return v; }
            }
            
            if (document.pictureInPictureElement && videos.has(document.pictureInPictureElement)) { 
                __currentTarget = document.pictureInPictureElement; __currentSince = now; return document.pictureInPictureElement; 
            }
    
            const limited = [];
            const pushTopK = (v) => {
                const ir = (v[VSCX.ir] == null) ? 0 : v[VSCX.ir];
                const r = getRectCached(v, now, 420);
                const area = r.width * r.height;
                if (ir < 0.01 && area < 160 * 120) return;
                insertTopN(limited, { ir, area, v }, 10);
            };
            for (const v of videos) pushTopK(v);
    
            const curScore = (__currentTarget && videos.has(__currentTarget)) ? scoreVideoCached(__currentTarget, audioBoostOn, now, lastUserPt) : -Infinity;
            let best = __currentTarget, bestScore = curScore;
            
            for (const it of limited) {
                const v = it.v;
                const s = scoreVideoCached(v, audioBoostOn, now, lastUserPt);
                if (s > bestScore) { bestScore = s; best = v; }
            }
    
            const MIN_HOLD_MS = 1400;
            const MIN_SWITCH_DELTA = 1.15;
    
            if ((__currentTarget && (now - __currentSince) < MIN_HOLD_MS)) {
                if (best !== __currentTarget) {
                    const delta = bestScore - curScore;
                    if (delta < MIN_SWITCH_DELTA) return __currentTarget;
                }
            }
            if (best !== __currentTarget) { __currentTarget = best; __currentSince = now; }
            return __currentTarget;
        };

        const buildApplySetReuse = (visibleVideos, target, extraApplyTopK, applyToAllVisibleVideos, lastUserPt, audioBoostOn) => {
            __applySetReuse.clear();
            if (applyToAllVisibleVideos) {
                for (const v of visibleVideos) __applySetReuse.add(v);
                return __applySetReuse;
            }
            if (target) __applySetReuse.add(target);
            
            const N = Math.max(0, extraApplyTopK | 0);
            if (N <= 0) return __applySetReuse;
            
            const now = performance.now();
            __topBuf.length = 0; 
            
            for (const v of visibleVideos) {
                if (!v || v === target) continue;
                const s = scoreVideoCached(v, audioBoostOn, now, lastUserPt);
                if (!Number.isFinite(s) || s <= -1e8) continue;
                insertTopN(__topBuf, { v, s }, N);
            }
            
            for (let i = 0; i < __topBuf.length; i++) {
                __applySetReuse.add(__topBuf[i].v);
            }
            return __applySetReuse;
        };

        return Object.freeze({ pick, buildApplySetReuse });
    }

    function createEventBus() {
        const subs = new Map();
        const on = (name, fn) => {
            let s = subs.get(name);
            if (!s) { s = new Set(); subs.set(name, s); }
            s.add(fn);
            return () => s.delete(fn);
        };
        const emit = (name, payload) => {
            const s = subs.get(name);
            if (!s) return;
            for (const fn of s) { try { fn(payload); } catch (_) { } }
        };
        let queued = false;
        let agg = { aeLevel: 0, forceApply: false };
        const signal = (p) => {
            if (p) {
                if (p.affectsAE) agg.aeLevel = Math.max(agg.aeLevel, 2);
                if (p.wakeAE) agg.aeLevel = Math.max(agg.aeLevel, 1);
                if (p.aeLevel != null) agg.aeLevel = Math.max(agg.aeLevel, (p.aeLevel | 0));
                if (p.forceApply) agg.forceApply = true;
            }
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                const out = agg;
                agg = { aeLevel: 0, forceApply: false };
                emit('signal', out);
            });
        };
        return Object.freeze({ on, emit, signal });
    }

    function computeAeMix3Into(out, vf, Utils) {
        const { clamp } = Utils;
        const mix = clamp(vf.presetMix ?? 1.0, 0, 1);
        const pB = PRESET.grade[vf.presetB] || PRESET.grade.brOFF;

        const manualExp = Math.abs(vf.bright || 0) / 55 + Math.abs((vf.gamma || 1) - 1) / 0.75 + Math.abs((vf.contrast || 1) - 1) / 0.65;
        const manualCol = Math.abs((vf.sat || 100) - 100) / 120 + Math.abs(vf.temp || 0) / 20;

        const presetExp = Math.abs((pB.brightAdd || 0) * mix) / 55 + Math.abs(((pB.gammaF || 1) - 1) * mix) / 0.32 + Math.abs(((pB.conF || 1) - 1) * mix) / 0.26;
        const presetCol = Math.abs(((pB.satF || 1) - 1) * mix) / 0.30 + Math.abs((pB.tempAdd || 0) * mix) / 12;

        const toneOn = !!vf.tonePreset && vf.tonePreset !== 'neutral';
        const toneStr = toneOn ? clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;
        const detailIntent = Math.abs(vf.detail || 0) / 50;

        const expIntent  = clamp(manualExp + presetExp + toneStr * 0.18, 0, 3.0);
        const toneIntent = clamp((manualExp * 0.55) + manualCol + presetCol + toneStr * 0.95 + detailIntent * 0.25, 0, 3.5);

        let expMix  = 1 - 0.60 * clamp(expIntent / 1.45, 0, 1);
        let toneMix = 1 - 0.75 * clamp(toneIntent / 1.45, 0, 1);

        expMix  = clamp(expMix, 0.20, 1.00);
        toneMix = clamp(toneMix, 0.08, 1.00);

        const snap = (x) => Math.round(x / 0.02) * 0.02;
        out.expMix = snap(expMix);
        out.toneMix = snap(toneMix);
    }

    function computeToneStrengthEff(vf, ae, Utils) {
        const { clamp } = Utils;
        const tonePreset = vf?.tonePreset || null;
        if (!tonePreset || tonePreset === 'neutral') return 0;

        const t0 = clamp(vf.toneStrength ?? 1.0, 0, 1);
        if (!ae) return t0;

        const hi = clamp(ae.hiRisk ?? 0, 0, 1);
        const clip01 = clamp((ae.clipFrac ?? 0) / (AE_COMMON.CLIP_FRAC_LIMIT * 3.0), 0, 1);
        const cf = clamp(ae.cf ?? 0.5, 0, 1);
        const skin01 = clamp(((ae.rd ?? 0) - 0.06) / 0.09, 0, 1);

        let damp = 1.0;
        damp *= (1 - 0.30 * hi);
        damp *= (1 - 0.24 * clip01);
        damp *= (0.86 + 0.14 * cf);

        if (tonePreset === 'highlight') damp *= (1 - 0.22 * hi - 0.18 * clip01);
        if (tonePreset === 'redSkin') damp *= (1 - 0.22 * skin01);

        return clamp(t0 * damp, 0, 1);
    }

    function createUtils() {
        return {
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
            },
            deepClone: (x) => {
                if (window.structuredClone) return structuredClone(x);
                return JSON.parse(JSON.stringify(x));
            },
            createLRU: (max = 384) => {
                const m = new Map();
                return {
                    get(k) {
                        if (!m.has(k)) return undefined;
                        const v = m.get(k); m.delete(k); m.set(k, v); return v;
                    },
                    set(k, v) {
                        if (m.has(k)) m.delete(k);
                        m.set(k, v);
                        if (m.size > max) m.delete(m.keys().next().value);
                    }
                }
            }
        };
    }

    function getAePack(isMobile, profileName) {
        const dev = isMobile ? AE_DEVICE_BASE.mobile : AE_DEVICE_BASE.pc;
        const prof = AE_PROFILES[profileName] || AE_PROFILES.balanced;

        const cfg = {
            ...AE_COMMON,
            STRENGTH:        prof.STRENGTH ?? dev.STRENGTH,
            TARGET_MID_BASE: prof.TARGET_MID_BASE ?? dev.TARGET_MID_BASE,
            MAX_UP_EV:       prof.MAX_UP_EV ?? dev.MAX_UP_EV,
            MAX_DOWN_EV:     prof.MAX_DOWN_EV ?? dev.MAX_DOWN_EV,
            TONE_BIAS:       (prof.TONE_BIAS ?? 0),

            TAU_UP: AE_COMMON.TAU_UP,
            TAU_DOWN: AE_COMMON.TAU_DOWN,
            TAU_AGGRESSIVE: AE_COMMON.TAU_AGGRESSIVE,
            SAT_MIN: AE_COMMON.SAT_MIN,
            SAT_MAX: AE_COMMON.SAT_MAX
        };
        const look = prof.LOOK || { brMul: 1.0, satMul: 1.0, conMul: 1.0 };
        return Object.freeze({ cfg: Object.freeze(cfg), look: Object.freeze(look) });
    }

    function applyTonePreset2Inline(out, presetName, strength, aeProfileName, Utils) {
        const { clamp } = Utils;
        if (!presetName || presetName === 'neutral') return out;
        
        const p0 = TONE_PRESET2[presetName] || TONE_PRESET2.neutral;
        let t = clamp(strength ?? 1.0, 0, 1);
        
        let toe = p0.toe, shoulder = p0.shoulder, mid = p0.mid, con = p0.con, sat = p0.sat, br = p0.br, tmp = p0.tmp;
        
        if (presetName === 'highlight') {
          if (aeProfileName === 'bright') { shoulder *= 0.65; br *= 0.65; t *= 0.90; }
          else if (aeProfileName === 'cinematic') { br *= 0.75; con = 1.00; t *= 0.95; }
        } else if (presetName === 'redSkin') {
          if (aeProfileName === 'bright') { sat = 1.03; br *= 0.70; t *= 0.92; }
          else if (aeProfileName === 'cinematic') { sat = 1.03; tmp *= 0.80; }
        }
        
        out.mid = clamp((out.mid || 0) + (mid * t), -1, 1);
        out.contrast = clamp((out.contrast || 1) * (1 + (con - 1) * t), 0.5, 2.0);
        out.satF = clamp((out.satF || 1) * (1 + (sat - 1) * t), 0.0, 2.0);
        out.bright = clamp((out.bright || 0) + (br * t), -50, 50);
        out.temp = clamp((out.temp || 0) + (tmp * t), -25, 25);
        out.toe = clamp((out.toe || 0) + (toe * t), -14, 14);
        out.shoulder = clamp((out.shoulder || 0) + (shoulder * t), -14, 14);
        
        return out;
    }

    function composeVideoParamsInto(out, vUser, ae, defaultsVideo, Utils) {
        const clamp = Utils.clamp;
        const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);

        const pD = PRESET.detail[vUser.presetS] || PRESET.detail.off;
        const pB = PRESET.grade[vUser.presetB] || PRESET.grade.brOFF;

        const preGammaF  = lerp(1.0, pB.gammaF, mix);
        const preConF    = lerp(1.0, pB.conF,   mix);
        const preSatF    = lerp(1.0, pB.satF,   mix);
        const preBright  = (pB.brightAdd || 0) * mix;
        const preTemp    = (pB.tempAdd   || 0) * mix;
        const preDetail  = (pD.detailAdd || 0) * mix;

        const A = ae || { gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, hiRisk: 0, cf: 0.5, mid: 0 };

        let gamma    = (vUser.gamma || 1.0) * preGammaF * (A.gammaF || 1.0);
        let contrast = (vUser.contrast || 1.0) * preConF * (A.conF || 1.0);
        let satF     = ((vUser.sat || 100) / 100) * preSatF * (A.satF || 1.0);
        let bright   = (vUser.bright || 0) + preBright + (A.brightAdd || 0);
        let temp     = (vUser.temp || 0)   + preTemp   + (A.tempAdd || 0);

        const gain = clamp(A.gain || 1.0, 1.0, 8.0);
        const hiRisk01 = clamp(A.hiRisk || 0, 0, 1);

        const userDetail = (vUser.detail || 0) + preDetail;
        const detail01 = clamp(userDetail / 50, 0, 1);

        const protect = clamp((gain - 1.0) / 4.0 + (A.shoulder || 0) / 18 + hiRisk01 * 0.7, 0, 1);
        const detailMul = lerp(1.0, 0.55, protect);
        const detail = clamp(userDetail * detailMul, 0, 50);

        const manualStyle =
            (Math.abs(vUser.bright || 0) > 10) ||
            (Math.abs((vUser.gamma || 1) - 1) > 0.10) ||
            (Math.abs((vUser.contrast || 1) - 1) > 0.10) ||
            (Math.abs((vUser.sat || 100) - 100) > 25) ||
            (Math.abs((vUser.temp || 0)) > 8) ||
            (detail01 > 0.6);

        const styleMix = manualStyle ? 0.82 : 1.00;

        out.gain     = gain;
        out.gamma    = clamp(gamma, 0.5, 2.5);
        out.contrast = clamp(contrast, 0.5, 2.0);
        out.bright   = clamp(bright, -50, 50);
        out.satF     = clamp(satF, 0.0, 2.0);
        out.mid      = clamp((A.mid || 0) * styleMix, -1, 1);
        out.detail   = detail;
        out.dither   = vUser.dither || 0;
        out.temp     = clamp(temp, -25, 25);
        out.toe      = (A.toe || 0) * styleMix;
        out.shoulder = (A.shoulder || 0) * styleMix;

        const toneName = vUser.tonePreset;
        if (toneName && toneName !== 'neutral') {
            const aeProfileForTone = (vUser.ae && vUser.aeProfile) ? vUser.aeProfile : null;
            applyTonePreset2Inline(out, toneName, vUser.toneStrength, aeProfileForTone, Utils);
        }
        return out;
    }

    const isNeutralVideoParams = (v) => (
        Math.abs((v.gain ?? 1) - 1) < 0.001 &&
        Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
        Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
        Math.abs((v.bright ?? 0)) < 0.01 &&
        Math.abs((v.satF ?? 1) - 1) < 0.001 &&
        Math.abs((v.mid ?? 0)) < 0.001 &&
        Math.abs((v.detail ?? 0)) < 0.01 &&
        Math.abs((v.dither ?? 0)) < 0.01 &&
        Math.abs((v.temp ?? 0)) < 0.01 &&
        Math.abs((v.toe ?? 0)) < 0.01 &&
        Math.abs((v.shoulder ?? 0)) < 0.01
    );

    function createScheduler(minIntervalMs = 16) {
        let queued = false, force = false, applyFn = null;
        let lastRun = 0;
        let timer = 0;
        
        const run = () => {
          queued = false;
          const now = performance.now();
          const doForce = force;
          force = false;
          const dt = now - lastRun;
          if (!doForce && dt < minIntervalMs) {
            const wait = Math.max(0, minIntervalMs - dt);
            if (!timer) { timer = setTimeout(() => { timer = 0; requestAnimationFrame(run); }, wait); }
            return;
          }
          lastRun = now;
          if (applyFn) { try { applyFn(doForce); } catch (_) {} }
        };
        
        const request = (immediate = false) => {
          if (immediate) force = true;
          if (queued) return;
          queued = true;
          if (timer) { clearTimeout(timer); timer = 0; }
          requestAnimationFrame(run);
        };
        return { registerApply: (fn) => { applyFn = fn; }, request };
    }

    function createLocalStore(defaults, scheduler, Utils) {
        let state = Utils.deepClone(defaults);
        let rev = 0;
        const listeners = new Map();

        const emit = (key, val) => {
            const a = listeners.get(key);
            if (a) for (const cb of a) { try { cb(val); } catch(_) {} }
            const cat = key.split('.')[0];
            const b = listeners.get(cat + '.*');
            if (b) for (const cb of b) { try { cb(val); } catch(_) {} }
        };

        return {
            rev: () => rev,
            getCat: (cat) => (state[cat] ||= {}),
            get: (p) => { const [c, k] = split2(p); return state[c]?.[k]; },
            set: (path, val) => {
                const [cat, key] = split2(path);
                if (!key) return;
                state[cat] ||= {};
                if (state[cat][key] === val) return;
                state[cat][key] = val;
                rev++;
                emit(path, val);
                scheduler.request(false);
            },
            batch: (cat, obj) => {
                state[cat] ||= {};
                let has = false;
                for (const [k, v] of Object.entries(obj)) {
                    if (state[cat][k] !== v) {
                        state[cat][k] = v;
                        emit(`${cat}.${k}`, v);
                        has = true;
                    }
                }
                if (has) { rev++; scheduler.request(false); }
            },
            sub: (k, f) => {
                let s = listeners.get(k);
                if (!s) { s = new Set(); listeners.set(k, s); }
                s.add(f);
                return () => { const cur = listeners.get(k); if (cur) cur.delete(f); };
            }
        };
    }

    function createRegistry(scheduler, featureCheck) {
        const videos = new Set(), images = new Set();
        const visible = { videos: new Set(), images: new Set() };
        let dirty = { videos: new Set(), images: new Set() };
        let rev = 0;
        let observingImages = false;

        const observedShadowHosts = new WeakSet();
        const shadowRootsLRU = [];
        const SHADOW_LRU_MAX = CONFIG.IS_LOW_END ? 8 : 24;

        const io = new IntersectionObserver((entries) => {
            if (!featureCheck.active()) return; 
            let changed = false;
            const now = performance.now();
            for (const e of entries) {
                const el = e.target;
                const isVis = e.isIntersecting || e.intersectionRatio > 0;
                el[VSCX.visible] = isVis;
                el[VSCX.ir] = e.intersectionRatio || 0;
                el[VSCX.rect] = e.boundingClientRect;
                el.__vscRectT = now;
                if (el.tagName === 'VIDEO') {
                    if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
                    else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
                } else if (el.tagName === 'IMG') {
                    if (isVis) { if (!visible.images.has(el)) { visible.images.add(el); dirty.images.add(el); changed = true; } }
                    else { if (visible.images.has(el)) { visible.images.delete(el); dirty.images.add(el); changed = true; } }
                }
            }
            if (changed) { rev++; scheduler.request(false); }
        }, { root: null, threshold: 0.01, rootMargin: CONFIG.IS_LOW_END ? '120px' : '300px' });

        const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
        const observeMediaEl = (el) => {
            if (!featureCheck.active() || !el || isInVscUI(el)) return;
            if (el.tagName === 'VIDEO') { if (videos.has(el)) return; videos.add(el); io.observe(el); }
            else if (el.tagName === 'IMG') { if (!featureCheck.images() || images.has(el)) return; images.add(el); io.observe(el); }
        };

        const WorkQ = (() => {
            const q = [], bigQ = [];
            let head = 0, bigHead = 0;
            let scheduled = false;
            let epoch = 1; const mark = new WeakMap();
            
            const schedule = () => { 
                if (scheduled) return; 
                scheduled = true; 
                const runner = (dl) => drain(dl); 
                if (window.requestIdleCallback) requestIdleCallback(runner); else requestAnimationFrame(() => runner()); 
            };
            
            const enqueue = (n) => { 
                if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; 
                const m = mark.get(n); if (m === epoch) return; 
                mark.set(n, epoch); 
                const isBig = (n.nodeType === 1 && (n.childElementCount || 0) > 1600);
                (isBig ? bigQ : q).push(n); 
                schedule(); 
            };
            
            const scanNode = (n) => {
                if (!n) return;
                const wantImg = featureCheck.images();
              
                if (n.nodeType === 1) {
                  const tag = n.tagName;
                  if (tag === 'VIDEO' || (wantImg && tag === 'IMG')) { observeMediaEl(n); return; }
              
                  try {
                    const vs = n.getElementsByTagName('video');
                    for (let i = 0; i < vs.length; i++) observeMediaEl(vs[i]);
              
                    if (wantImg) {
                      const ims = n.getElementsByTagName('img');
                      for (let i = 0; i < ims.length; i++) observeMediaEl(ims[i]);
                    }
                  } catch (_) {}
                  return;
                }
              
                if (n.nodeType === 11) {
                  try {
                    const sel = wantImg ? 'video,img' : 'video';
                    n.querySelectorAll?.(sel)?.forEach(observeMediaEl);
                  } catch (_) {}
                }
            };
            
            const drain = (dl) => {
                scheduled = false; const start = performance.now();
                const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6;
                
                while (bigHead < bigQ.length && budget()) { 
                    const n = bigQ[bigHead++]; 
                    try { scanNode(n); } catch (_) { } 
                    break; 
                }
                while (head < q.length && budget()) { 
                    const n = q[head++]; 
                    try { scanNode(n); } catch (_) { } 
                }
                
                if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; }
                schedule();
            };
            return Object.freeze({ enqueue });
        })();

        const observers = new Set();
        const connectObserver = (root, isShadow = false) => {
            if (!root) return;
            const mo = new MutationObserver((muts) => {
                if (!featureCheck.active()) return;
                for (const m of muts) {
                    if (!m.addedNodes || m.addedNodes.length === 0) continue;
                    for (const n of m.addedNodes) {
                        if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
                        if (n.nodeType === 1) { const tag = n.tagName; if (tag === 'VIDEO' || tag === 'IMG') { WorkQ.enqueue(n); continue; } }
                        WorkQ.enqueue(n);
                    }
                }
            });
            mo.observe(root, { childList: true, subtree: true }); observers.add(mo);
            WorkQ.enqueue(root);
        };

        const refreshObservers = () => {
            for (const o of observers) o.disconnect(); observers.clear();
            for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root, true); }
            const root = document.body || document.documentElement;
            if (root) { WorkQ.enqueue(root); connectObserver(root); }
        };

        document.addEventListener('vsc-shadow-root', (e) => {
            try {
                const sr = e.detail; const host = sr?.host;
                if (!sr || !host) return;
                if (observedShadowHosts.has(host)) return;
                observedShadowHosts.add(host);
                shadowRootsLRU.push({ host, root: sr });
                if (shadowRootsLRU.length > SHADOW_LRU_MAX) shadowRootsLRU.shift();
                connectObserver(sr, true);
            } catch (_) { }
        });

        refreshObservers();

        function pruneBatch(set, visibleSet, dirtySet, touchedSet, unobserveFn, batch = 200) {
            const it = set.values();
            for (let i = 0; i < batch; i++) {
                const el = it.next().value;
                if (!el) break;
                if (!el.isConnected) {
                    set.delete(el); visibleSet.delete(el); dirtySet.delete(el); touchedSet.delete(el);
                    try { unobserveFn(el); } catch (_) { }
                }
            }
        }

        function syncImageObservation() {
            const want = featureCheck.images();
            if (want === observingImages) return;
            observingImages = want;
          
            if (!want) {
              for (const img of images) { try { io.unobserve(img); } catch (_) {} }
              images.clear();
              visible.images.clear();
              dirty.images.clear();
              rev++;
              scheduler.request(false);
            } else {
              WorkQ.enqueue(document.body || document.documentElement);
            }
        }

        return {
            videos, images, visible, rev: () => rev, refreshObservers,
            syncImageObservation,
            prune: () => {
                pruneBatch(videos, visible.videos, dirty.videos, TOUCHED.videos, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220);
                pruneBatch(images, visible.images, dirty.images, TOUCHED.images, io.unobserve.bind(io), CONFIG.IS_LOW_END ? 120 : 220);
                rev++;
            },
            consumeDirty: () => {
                const out = dirty;
                dirty = { videos: new Set(), images: new Set() };
                return out;
            },
            rescanAll: () => { WorkQ.enqueue(document.body || document.documentElement); }
        };
    }

    function createAudio(sm) {
        let ctx, compressor, dry, wet, target = null, currentSrc = null;
        let wetConnected = false;
        const srcMap = new WeakMap();
      
        const onGesture = () => { try { if (ctx?.state === 'suspended') ctx.resume(); } catch (_) {} };
        window.addEventListener('pointerdown', onGesture, { once: true, passive: true });
      
        const ensureCtx = () => {
          if (ctx) return true;
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return false;
          ctx = new AC();
          compressor = ctx.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 24;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.005;
          compressor.release.value = 0.20;
      
          dry = ctx.createGain();
          wet = ctx.createGain();
      
          dry.connect(ctx.destination);
          wet.connect(ctx.destination);
          compressor.connect(wet);
      
          return true;
        };
      
        const connectWet = (srcNode) => {
          if (!srcNode || wetConnected) return;
          try { srcNode.connect(compressor); wetConnected = true; } catch (_) { wetConnected = false; }
        };
      
        const disconnectWet = (srcNode) => {
          if (!srcNode || !wetConnected) return;
          try { srcNode.disconnect(compressor); } catch (_) {}
          wetConnected = false;
        };
      
        const updateMix = () => {
          if (!ctx) return;
          const en = sm.get(P.A_EN) && sm.get(P.APP_ACT);
          const boost = Math.pow(10, sm.get(P.A_BST) / 20);
      
          dry.gain.setTargetAtTime(en ? 0 : 1, ctx.currentTime, 0.05);
          wet.gain.setTargetAtTime(en ? boost : 0, ctx.currentTime, 0.05);
      
          if (currentSrc) {
            if (en) connectWet(currentSrc);
            else disconnectWet(currentSrc);
          }
        };
      
        const disconnectAll = () => {
          if (currentSrc) {
            try {
              disconnectWet(currentSrc);
              currentSrc.disconnect(dry);
            } catch (_) {}
          }
          currentSrc = null; target = null;
        };
      
        return {
          setTarget: (v) => {
            const enabled = sm.get(P.A_EN) && sm.get(P.APP_ACT);
            
            if (v && v[VSCX.audioFail]) {
                if (v !== target) { disconnectAll(); target = v; }
                updateMix();
                return;
            }

            if (v !== target) { disconnectAll(); target = v; }
      
            if (!v) { updateMix(); return; }
            if (!ensureCtx()) return;
      
            if (!currentSrc && (enabled || (ctx && sm.get(P.APP_ACT)))) {
              try {
                let s = srcMap.get(v);
                if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); }
                s.connect(dry);
                currentSrc = s;
              } catch (_) { v[VSCX.audioFail] = true; disconnectAll(); }
            }
            updateMix();
          },
          update: updateMix,
          hasCtx: () => !!ctx,
          isHooked: () => !!currentSrc
        };
    }

    function createFiltersUnified(Utils, config) {
        const { h, clamp, createLRU } = Utils;
        const urlCache = new WeakMap();
        const ctxMap = new WeakMap(); // ✅ Added: doc -> {svg/defs/video/image ctx}
        const toneCache = createLRU(CONFIG.IS_LOW_END ? 320 : 720);
        const colorCache = createLRU(CONFIG.IS_LOW_END ? 256 : 512);
        
        const makeNoiseDataURL = (size = 64, seed = 1337) => {
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const ctx2 = c.getContext('2d', { alpha: false });
            const img = ctx2.createImageData(size, size);
            let a = seed >>> 0;
            const rnd = () => {
                a |= 0; a = (a + 0x6D2B79F5) | 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            for (let i = 0; i < img.data.length; i += 4) {
                const n = Math.floor(128 + (rnd() - 0.5) * 90);
                img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
                img.data[i + 3] = 255;
            }
            ctx2.putImageData(img, 0, 0);
            return c.toDataURL('image/png');
        };
        
        let NOISE_URL = null;
        const getNoiseUrl = () => (NOISE_URL ||= makeNoiseDataURL(64, 133));
        
        const qInt = (v, step) => Math.round(v / step);
        const setAttr = (node, attr, val, st, key) => {
            if (!node) return;
            if (st[key] === val) return;
            st[key] = val; node.setAttribute(attr, val);
        };
        
        const makeKey = (kind, s) => [
            kind,
            qInt(s.gain, 0.04), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2), qInt(s.satF, 0.01),
            qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2), qInt(s.temp, 0.2), qInt(s.detail, 0.2), qInt(s.dither, 1)
        ].join('|');
        
        const smoothstep = (a, b, x) => {
            const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a))));
            return t * t * (3 - 2 * t);
        };
        
        function getToneTableCached(steps, toeN, shoulderN, midN, bright, contrast, gain, gamma) {
            const key = `${steps}|${qInt(toeN,0.02)}|${qInt(shoulderN,0.02)}|${qInt(midN,0.02)}|${qInt(bright,0.2)}|${qInt(contrast,0.01)}|${qInt(gain,0.04)}|${qInt(gamma,0.01)}`;
            const hit = toneCache.get(key);
            if (hit) return hit;
        
            if (toeN === 0 && shoulderN === 0 && midN === 0 && bright === 0 && contrast === 1 && Math.abs(gain - 1) < 0.01 && Math.abs(gamma - 1) < 0.01) {
                const res0 = '0 1'; toneCache.set(key, res0); return res0;
            }
        
            const invG = 1 / clamp(gamma || 1, 0.2, 3);
            const br = (bright / 1000);
            const con = contrast;
            const toeEnd = 0.34 + toeN * 0.06;
            const toeAmt = Math.abs(toeN);
            const toeSign = toeN >= 0 ? 1 : -1;
            const shoulderStart = 0.90 - shoulderN * 0.10;
            const shAmt = Math.abs(shoulderN);
            const ev = Math.log2(Math.max(1e-6, gain));
            const g = ev * 0.90;
            const denom = 1 - Math.exp(-g);
        
            const out = new Array(steps);
            let prev = 0;
            for (let i = 0; i < steps; i++) {
                const x0 = i / (steps - 1);
                let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
                const midShape = 4 * x * (1 - x);
                x = clamp(x + midN * 0.06 * midShape, 0, 1);
        
                if (toeAmt > 1e-6) {
                    const w = 1 - smoothstep(0, toeEnd, x);
                    const delta = (toeEnd - x) * w * w;
                    x = clamp(x + toeSign * toeAmt * 0.55 * delta, 0, 1);
                }
                if (shAmt > 1e-6 && x > shoulderStart) {
                    const t = (x - shoulderStart) / Math.max(1e-6, (1 - shoulderStart));
                    const k = Math.max(0.7, 1.2 + shAmt * 6.5);
                    const n = 1 - Math.exp(-k * t);
                    const d = 1 - Math.exp(-k);
                    const rolled = d > 1e-6 ? (n / d) : t;
                    x = clamp(shoulderStart + (1 - shoulderStart) * rolled, 0, 1);
                }
        
                let y = clamp((x - 0.5) * con + 0.5 + br, 0, 1);
                const g01 = clamp((gain - 1.0) / 2.2, 0, 1);
                const clipStart = 0.92 - 0.018 * g01;
                if (y > clipStart) {
                    const tt = (y - clipStart) / (1 - clipStart);
                    const ww = tt * tt * (3 - 2 * tt);
                    const kk = (0.45 + 0.55 * shAmt) * (1.0 + 0.35 * g01);
                    y = clamp(clipStart + (y - clipStart) * (1 - ww * kk), 0, 1);
                }
                if (Math.abs(invG - 1) > 0.001) y = Math.pow(y, invG);
                if (y < prev) y = prev;
                prev = y;
                const yy = Math.round(y * 100000) / 100000;
                out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
            }
        
            const res = out.join(' ');
            toneCache.set(key, res);
            return res;
        }
        
        function buildColorMatrixCached(temp, satF) {
            const sat = clamp(satF ?? 1, 0, 2.5);
            const t = clamp(temp ?? 0, -25, 25);
            const kt = Math.round(t / 0.2) * 0.2;
            const ks = Math.round(sat / 0.01) * 0.01;
            const key = `${kt.toFixed(1)}|${ks.toFixed(2)}`;
            const hit = colorCache.get(key);
            if (hit) return hit;
        
            let rs = 1, gs = 1, bs = 1;
            if (kt > 0) { rs = 1 + kt * 0.012; gs = 1 + kt * 0.003; bs = 1 - kt * 0.010; }
            else { const k = -kt; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.010; }
        
            const s = ks;
            const ir = 0.213, ig = 0.715, ib = 0.072;
            const a = (1 - s) * ir + s, b = (1 - s) * ir, c = (1 - s) * ir;
            const d = (1 - s) * ig, e = (1 - s) * ig + s, f = (1 - s) * ig;
            const g = (1 - s) * ib, h = (1 - s) * ib, i = (1 - s) * ib + s;
        
            const round5 = (x) => (Math.round(x * 100000) / 100000);
            const v0 = (rs * a), v1 = (rs * d), v2 = (rs * g);
            const v5 = (gs * b), v6 = (gs * e), v7 = (gs * h);
            const v10 = (bs * c), v11 = (bs * f), v12 = (bs * i);
        
            const values =
                `${round5(v0)} ${round5(v1)} ${round5(v2)} 0 0  ` +
                `${round5(v5)} ${round5(v6)} ${round5(v7)} 0 0  ` +
                `${round5(v10)} ${round5(v11)} ${round5(v12)} 0 0  ` +
                `0 0 0 1 0`;
        
            const out = { key, values };
            colorCache.set(key, out);
            return out;
        }
        
        function buildSvg(doc) {
            const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
            const defs = h('defs', { ns: 'svg' });
            svg.append(defs);
        
            function mkUnifiedFilter(kind, lite=false) {
                const fid = `vsc-${kind}-${config.VSC_ID}`;
                const filter = h('filter', {
                    ns: 'svg', id: fid,
                    'color-interpolation-filters': 'sRGB',
                    x: '-15%', y: '-15%', width: '130%', height: '130%'
                });
        
                const tone = h('feComponentTransfer', { ns: 'svg', result: 'tone' },
                    ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' }))
                );
                const col = h('feColorMatrix', {
                    ns: 'svg', in: 'tone', type: 'matrix',
                    values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0',
                    result: 'col'
                });
                filter.append(tone, col);

                let lum, lumB, lumHP, det, feImg, feTile, feComp;
                if (!lite) {
                    lum = h('feColorMatrix', {
                        ns: 'svg', in: 'col', type: 'matrix',
                        values: '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0',
                        result: 'lum'
                    });
                    lumB = h('feGaussianBlur', { ns: 'svg', in: 'lum', stdDeviation: '0', result: 'lumB' });
                    lumHP = h('feComposite', { ns: 'svg', in: 'lum', in2: 'lumB', operator: 'arithmetic', k2: '1', k3: '-1', k4: '0', result: 'hp' });
                    det = h('feComposite', { ns: 'svg', in: 'col', in2: 'hp', operator: 'arithmetic', k2: '1', k3: '0', k4: '0', result: 'det' });
            
                    feImg = h('feImage', { ns: 'svg', href: getNoiseUrl(), preserveAspectRatio: 'none', result: 'noiseImg' });
                    try { feImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', getNoiseUrl()); } catch(_) {}
                    feTile = h('feTile', { ns: 'svg', in: 'noiseImg', result: 'noise' });
                    feComp = h('feComposite', { ns: 'svg', in: 'det', in2: 'noise', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'out' });
            
                    filter.append(lum, lumB, lumHP, det, feImg, feTile, feComp);
                } else {
                    filter.append(h('feComposite', { ns:'svg', in:'col', operator:'over', result:'out' }));
                }
                defs.append(filter);
        
                return {
                    fid, toneFuncs: Array.from(tone.children), col,
                    lumB, det, feComp,
                    st: { lastKey: '', toneKey: '', toneTable: '', colKey: '', detailKey: '', noiseKey: '', __b: '', __k: '' }
                };
            }
        
            const ctx = { svg, defs, video: mkUnifiedFilter('video', false), image: mkUnifiedFilter('image', true) };
        
            const tryAppend = () => {
                const r = doc.documentElement || doc.body;
                if (r) { r.appendChild(svg); return true; }
                return false;
            };
            if (!tryAppend()) {
                const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50);
                setTimeout(() => clearInterval(t), 3000);
            }
            return ctx;
        }
        
        function updateTone(nodes, sEff) {
            const st = nodes.st;
            const toeN = clamp((sEff.toe || 0) / 14, -1, 1);
            const shN  = clamp((sEff.shoulder || 0) / 16, -1, 1);
            const midN = clamp((sEff.mid || 0), -1, 1);
            const ditherOn = (sEff.dither || 0) > 0;
            const steps = ditherOn ? (CONFIG.IS_LOW_END ? 64 : 96) : (CONFIG.IS_LOW_END ? 96 : 128);
            const kToe = qInt(toeN, 0.02), kSh  = qInt(shN, 0.02), kMid = qInt(midN, 0.02);
            const kBr  = qInt(sEff.bright || 0, 0.2), kCon = qInt(sEff.contrast || 1, 0.01);
            const kGain = qInt(sEff.gain || 1, 0.04), kGam  = qInt(sEff.gamma || 1, 0.01);
            const toneKey = `${steps}|${kToe}|${kSh}|${kMid}|${kBr}|${kCon}|${kGain}|${kGam}`;
            if (st.toneKey !== toneKey) {
                st.toneKey = toneKey;
                const table = getToneTableCached(steps, kToe * 0.02, kSh * 0.02, kMid * 0.02, kBr * 0.2, kCon * 0.01, kGain * 0.04, kGam * 0.01);
                if (st.toneTable !== table) {
                    st.toneTable = table;
                    for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', table);
                }
            }
        }
        
        function updateColor(nodes, sEff) {
            const st = nodes.st;
            const cm = buildColorMatrixCached(sEff.temp || 0, sEff.satF ?? 1);
            if (st.colKey !== cm.key) {
                st.colKey = cm.key;
                nodes.col.setAttribute('values', cm.values);
            }
        }
        
        function updateDetail(nodes, sEff) {
            if (!nodes.lumB) return;
            const st = nodes.st;
            const g = clamp(sEff.gain || 1, 1, 8);
            const hiProtect = clamp((g - 1) / 4.0 + Math.max(0, (sEff.shoulder || 0)) / 18, 0, 1);
            const d01 = clamp((sEff.detail || 0) / 50, 0, 1);
            let r = 0.70 + 2.60 * d01;
            r *= (1 - hiProtect * 0.55);
            if (r < 0.01) r = 0;
            let k = 1.55 * d01;
            k *= (1 - hiProtect * 0.50);
            const detailKey = `${r.toFixed(2)}|${k.toFixed(3)}`;
            if (st.detailKey === detailKey) return;
            st.detailKey = detailKey;
            setAttr(nodes.lumB, 'stdDeviation', r ? r.toFixed(2) : '0', st, '__b');
            setAttr(nodes.det,  'k3',          k ? k.toFixed(3) : '0', st, '__k');
        }
        
        function updateNoise(nodes, sEff) {
            if (!nodes.feComp) return;
            const st = nodes.st;
            const amt = clamp((sEff.dither || 0) / 100, 0, 1);
            const k3 = (amt * 0.04).toFixed(4);
            const k4 = (-0.5 * amt * 0.04).toFixed(4);
            const nk = `${k3}|${k4}`;
            if (st.noiseKey !== nk) {
                st.noiseKey = nk;
                nodes.feComp.setAttribute('k3', k3);
                nodes.feComp.setAttribute('k4', k4);
            }
        }
        
        function prepare(doc, s, kind) {
            let dc = urlCache.get(doc);
            if (!dc) { dc = { video: { key:'', url:'' }, image: { key:'', url:'' } }; urlCache.set(doc, dc); }
            const slot = dc[kind];
            const key = makeKey(kind, s);
            
            if (slot.key === key) return slot.url;

            let ctx = ctxMap.get(doc);
            if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
            const nodes = (kind === 'video') ? ctx.video : ctx.image;
        
            if (nodes.st.lastKey !== key) {
                nodes.st.lastKey = key;
                updateTone(nodes, s);
                updateColor(nodes, s);
                updateDetail(nodes, s);
                updateNoise(nodes, s);
            }
        
            const url = `url(#${nodes.fid})`;
            slot.key = key;
            slot.url = url;
            return url;
        }
        
        return {
            prepare,
            prepareCached: (doc, s, kind) => {
                // ✅ Added: Console log on error instead of silently swallowing it
                try { return prepare(doc, s, kind); } catch (e) { try { console.warn('[VSC] filter prepare failed:', e); } catch(_){} return null; }
            },
            applyUrl: (el, url) => {
                if (!el) return;
                if (!url) {
                    if (el[VSCX.applied]) {
                        el.style.removeProperty('filter');
                        el.style.removeProperty('-webkit-filter');
                        el[VSCX.applied] = false;
                    }
                    return;
                }
                if (el.style.filter !== url) {
                    el.style.setProperty('filter', url, 'important');
                    el.style.setProperty('-webkit-filter', url, 'important');
                    el[VSCX.applied] = true;
                }
            },
            clear: (el) => {
                if (!el) return;
                if (!el[VSCX.applied]) return;
                el.style.removeProperty('filter');
                el.style.removeProperty('-webkit-filter');
                el[VSCX.applied] = false;
            }
        };
    }

    const WORKER_CODE = `
        const histAll = new Uint32Array(256), histTop = new Uint32Array(256);
        function pctFromHist(hist, n, p){
            const t = n * p; let acc = 0;
            for(let i=0;i<256;i++){ acc += hist[i]; if(acc >= t) return i/255; }
            return 1;
        }
        self.onmessage = function(e){
            const {buf, width, height, step, token} = e.data || {};
            if(!buf || !width || !height) return;
            const data = new Uint8ClampedArray(buf);
            histAll.fill(0); histTop.fill(0);
            let sumAll=0, sumSqAll=0, nAll=0, sumTop=0, sumSqTop=0, nTop=0;
            let clipAll=0, clipBottom=0, botSum=0, botSumSq=0, botN=0;
            let rSum=0, gSum=0, bSum=0;
            let skinCnt=0, skinAcc=0;
            const botY0 = Math.floor(height * 0.78), stride = width * 4;
            for(let y=0; y<height; y+=step){
                const row = y*stride; const isTop = (y < botY0); const isBottom = !isTop;
                for(let x=0; x<width; x+=step){
                    const i = row + x*4; const r = data[i], g = data[i+1], b = data[i+2];
                    const Y = (0.2126*r + 0.7152*g + 0.0722*b) | 0;
                    histAll[Y]++; sumAll += Y; sumSqAll += Y*Y; nAll++;
                    rSum += r; gSum += g; bSum += b;
                    if(isTop) { histTop[Y]++; sumTop += Y; sumSqTop += Y*Y; nTop++; }
                    if(Y >= 251){ clipAll++; if(isBottom) clipBottom++; }
                    if(isBottom){ botSum += Y; botSumSq += Y*Y; botN++; }

                    const Yf = Y / 255;
                    const rf = r/255, gf = g/255, bf = b/255;
                    if (Yf > 0.20 && Yf < 0.78) {
                        const redish = Math.max(0, Math.min(1, (rf - gf) * 1.8 + (rf - bf) * 1.2));
                        const notTooSatBlue = Math.max(0, 1 - (bf - rf) * 2.0);
                        const s = redish * notTooSatBlue;
                        if (s > 0.10) { skinAcc += s; skinCnt++; }
                    }
                }
            }
            const avgAll = nAll ? (sumAll/nAll) : 0;
            const varAll = nAll ? (sumSqAll/nAll - avgAll*avgAll) : 0;
            const stdAll = Math.sqrt(Math.max(0,varAll))/255;
            const avgTop = nTop ? (sumTop/nTop) : avgAll;
            const varTop = nTop ? (sumSqTop/nTop - avgTop*avgTop) : varAll;
            const stdTop = Math.sqrt(Math.max(0,varTop))/255;
            const botAvg = botN ? (botSum/botN)/255 : 0;
            const botVar = botN ? (botSumSq/botN - (botSum/botN)**2) : 0;
            const botStd = Math.sqrt(Math.max(0,botVar))/255;
            const cfAll = Math.min(1, stdAll/0.22); const cfTop = Math.min(1, stdTop/0.22);
            const rgbSum = (rSum+gSum+bSum) || 1;
            const redDominance = Math.max(0, Math.min(1, (rSum/rgbSum) - 0.28));
            const skinScore = skinCnt ? Math.min(1, (skinAcc/skinCnt) * 1.25) : 0;

            self.postMessage({
                token,
                p10: pctFromHist(histAll, nAll, 0.10), p35: pctFromHist(histAll, nAll, 0.35), p50: pctFromHist(histAll, nAll, 0.50), p60: pctFromHist(histAll, nAll, 0.60), p90: pctFromHist(histAll, nAll, 0.90), p95: pctFromHist(histAll, nAll, 0.95), p98: pctFromHist(histAll, nAll, 0.98),
                avgLuma: avgAll/255, stdDev: stdAll, cf: cfAll, clipFrac: nAll ? (clipAll/nAll) : 0,
                p10T: pctFromHist(histTop, nTop || 1, 0.10), p35T: pctFromHist(histTop, nTop || 1, 0.35), p50T: pctFromHist(histTop, nTop || 1, 0.50), p60T: pctFromHist(histTop, nTop || 1, 0.60), p90T: pctFromHist(histTop, nTop || 1, 0.90), p95T: pctFromHist(histTop, nTop || 1, 0.95), p98T: pctFromHist(histTop, nTop || 1, 0.98),
                stdDevT: stdTop, cfT: cfTop, clipFracBottom: botN ? (clipBottom/botN) : 0, botAvg, botStd, redDominance, skinScore
            });
        };
    `;

    function createAE(sm, { IS_MOBILE, Utils }, onAE) {
        let worker, canvas, ctx2d, activeVideo = null;
        let isRunning = false, workerBusy = false, targetToken = 0;
        
        let lastStats = { p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, cf: -1, rd: -1 };
        let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0;
        
        let curGain = 1.0;
        let __prevFrame = null, __motion01 = 1;
        
        let loopToken = 0;
        let lastLoopT = 0;
        let sampleCount = 0;
        
        const { clamp } = Utils;
        
        let __packKey = '', __pack = null;
        const getPack = () => {
          const name = sm.get(P.V_AE_PROFILE) || 'balanced';
          const key = (IS_MOBILE ? 'm|' : 'p|') + name;
          if (key !== __packKey) { __packKey = key; __pack = getAePack(IS_MOBILE, name); }
          return __pack;
        };
        const getCfg = () => getPack().cfg;
        const getLook = () => getPack().look;
        
        const riskFrom = (p95, p98, clipFrac, clipLimit) => {
          const hi95 = clamp((p95 - 0.885) / 0.095, 0, 1);
          const hi98 = clamp((p98 - 0.968) / 0.028, 0, 1);
          const clp  = clamp((clipFrac - clipLimit) / (clipLimit * 4.0), 0, 1);
          return clamp(Math.max(hi95 * 0.70 + hi98 * 0.90, clp), 0, 1);
        };
        
        const sceneChangeFrom = (avgLumaNow, avgLumaPrev, motion01, cf01) => {
          if (avgLumaPrev < 0) return 1;
          const dl = Math.abs(avgLumaNow - avgLumaPrev);
          const m = clamp(motion01, 0, 1);
          const c = clamp(cf01, 0, 1);
          const denom = (0.040 + 0.020 * (1 - c) + 0.015 * (1 - m));
          return clamp(dl / denom, 0, 1);
        };
        
        const targetMidFrom = (base, p50, risk01) => {
          const darkBoost = clamp((0.17 - p50) / 0.11, 0, 1) * 0.050;
          const riskCut   = risk01 * 0.030;
          return clamp(base + darkBoost - riskCut, 0.20, 0.34);
        };
        
        const computeTargetEV = (s, cfg) => {
          const p35 = clamp(s.p35 ?? s.p50, 0.01, 0.99);
          const p50 = clamp(s.p50, 0.01, 0.99);
          const key = clamp(p50 * 0.72 + p35 * 0.28, 0.01, 0.99);
          const risk01 = riskFrom(s.p95 ?? s.p90, s.p98 ?? s.p95, Math.max(0, s.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);
          const targetMid = targetMidFrom(cfg.TARGET_MID_BASE, p50, risk01);
          let ev = Math.log2(targetMid / key) * cfg.STRENGTH;
        
          ev = clamp(ev, cfg.MAX_DOWN_EV, cfg.MAX_UP_EV * (1 - 0.35 * risk01));
          if (risk01 > 0.58) ev = Math.min(ev, 0);
        
          const p95 = clamp(s.p95 ?? s.p90, 0.01, 0.999);
          const p98 = clamp(s.p98 ?? s.p95, 0.01, 0.999);
          const safeCap = Math.log2(Math.max(1, Math.min(0.985 / p98, 0.980 / p95))) - (0.06 * risk01);
          ev = Math.min(ev, safeCap);
        
          if (Math.abs(ev) < cfg.DEAD_IN) ev = 0;
          return ev;
        };
        
        const computeLook = (ev, s, risk01, cfg, lookMul) => {
          const p50 = clamp(s.p50 ?? 0.5, 0, 1);
          const p10 = clamp(s.p10 ?? 0.1, 0, 1);
          const p90 = clamp(s.p90 ?? 0.9, 0, 1);
          const cf01 = clamp(s.cf ?? 0.5, 0, 1);
          const sceneContrast = clamp(p90 - p10, 0, 1);
          const flat01 = clamp((0.46 - sceneContrast) / 0.26, 0, 1);
          const lowKey01 = clamp((0.23 - p50) / 0.14, 0, 1);
          const evNorm = clamp(ev / 1.55, -1, 1);
          const up01 = clamp(evNorm, 0, 1);
        
          let brightAdd = (up01 * 7.0) * clamp(0.52 - p50, -0.22, 0.22);
          let mid = (up01 * 0.55) * clamp((0.50 - p50) / 0.22, -1, 1);
          let toe = (4.2 + 7.2 * up01) * lowKey01;
          let shoulder = (5.8 + 7.2 * up01) * risk01;
          let conF = 1 + (up01 * 0.050) * flat01 - (0.012 * risk01);
          let satF = 1 + (1 - cf01) * 0.22 * (1 - risk01 * 0.65);
          
          brightAdd *= (1 - 0.85 * risk01);
          shoulder  *= (1 - 0.60 * risk01);
          
          const bias = clamp(cfg.TONE_BIAS ?? 0, -1, 1);
          brightAdd *= (1 + 0.10 * bias);
          satF      *= (1 + 0.08 * bias);
          conF      *= (1 + 0.02 * bias);
          shoulder  *= (1 - 0.12 * bias);
          toe       *= (1 + 0.08 * (-bias));

          const skin01 = clamp(s.rd ?? 0, 0, 1);
          const skinProtect = skin01 * 0.35;
          satF = satF * (1 - skinProtect * 0.35);
          conF = 1 + (conF - 1) * (1 - skinProtect * 0.25);
          shoulder *= (1 - skinProtect * 0.20 * risk01);

          satF = clamp(satF, cfg.SAT_MIN, Math.min(cfg.SAT_MAX, 1.16 - 0.10 * risk01));
          conF = clamp(conF, 0.90, 1.12);
          brightAdd = clamp(brightAdd, -14, 14);
          toe = clamp(toe, 0, 14);
          shoulder = clamp(shoulder, 0, 16);
          mid = clamp(mid, -0.95, 0.95);

          if (lookMul) {
              brightAdd *= (lookMul.brMul ?? 1);
              satF      *= (lookMul.satMul ?? 1);
              conF      *= (lookMul.conMul ?? 1);
          }
        
          return { conF, satF, mid, toe, shoulder, brightAdd };
        };
        
        const disableAEHard = () => {
          try { worker?.terminate(); } catch (_) {}
          worker = null;
          workerBusy = false;
          isRunning = false;
          targetToken++;
          if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) {} workerUrl = null; }
          try { sm.set(P.V_AE, false); } catch (_) {}
        };
        
        let workerUrl = null;
        const ensureWorker = () => {
          if (worker) return worker;
          try {
            if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
            worker = new Worker(workerUrl);
            worker.onmessage = (e) => { workerBusy = false; processResult(e.data); };
            worker.onerror = () => { workerBusy = false; disableAEHard(); };
            return worker;
          } catch (e) {
            try { console.warn('[VSC] worker blocked, AE disabled:', e); } catch (_) {}
            disableAEHard();
            return null;
          }
        };
        
        const _motionFromFrame = (rgba) => {
          const step = CONFIG.IS_LOW_END ? 32 : 16;
          if (!__prevFrame) {
            __prevFrame = new Uint8Array(Math.ceil(rgba.length / (4 * step)));
            let j = 0;
            for (let i = 0; i < rgba.length; i += 4 * step) {
              const y = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0;
              __prevFrame[j++] = y;
            }
            __motion01 = 1;
            return;
          }
          let diff = 0, cnt = 0, j = 0;
          for (let i = 0; i < rgba.length && j < __prevFrame.length; i += 4 * step) {
            const y = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0;
            diff += Math.abs(y - __prevFrame[j]);
            __prevFrame[j++] = y;
            cnt++;
          }
          const d = cnt ? (diff / cnt) : 0;
          __motion01 = clamp(d / 28, 0, 1);
        };
        
        const processResult = (data) => {
          if (!data || data.token !== targetToken) return;
          const pack = getPack();
          const cfg = pack.cfg;
          const now = performance.now();
          sampleCount++;
        
          const uiBar = (data.botAvg > 0.2 && data.botStd < 0.06) || (data.clipFracBottom > (cfg.CLIP_FRAC_LIMIT * 4) && data.botStd < 0.04);
          const subLikely = (data.clipFracBottom > cfg.CLIP_FRAC_LIMIT * 2) && data.p98 > 0.97 && data.p50 < 0.22 && data.stdDev > 0.06 && data.botStd > 0.045 && !uiBar;
        
          const stats = {
            p10: subLikely ? data.p10T : data.p10,
            p35: subLikely ? data.p35T : data.p35,
            p50: subLikely ? data.p50T : data.p50,
            p90: subLikely ? data.p90T : data.p90,
            p95: subLikely ? data.p95T : data.p95,
            p98: subLikely ? data.p98T : data.p98,
            clipFrac: data.clipFrac,
            cf: subLikely ? (data.cfT ?? data.cf) : data.cf,
            rd: (data.skinScore != null) ? data.skinScore : data.redDominance
          };
        
          const dt = Math.min(now - lastEmaT, 500);
          lastEmaT = now;
          const tauStats = clamp((activeVideo?.paused ? 380 : cfg.DT_CAP_MS) + (1 - __motion01) * 160, 180, 650);
          const a = 1 - Math.exp(-dt / tauStats);
        
          for (const k of Object.keys(lastStats)) {
            const v = stats[k];
            if (!Number.isFinite(v)) continue;
            lastStats[k] = (lastStats[k] < 0) ? v : (v * a + lastStats[k] * (1 - a));
          }
        
          const cf01 = clamp(lastStats.cf ?? 0.5, 0, 1);
          const risk01 = riskFrom(Math.max(0, lastStats.p95), Math.max(0, lastStats.p98), Math.max(0, lastStats.clipFrac ?? 0), cfg.CLIP_FRAC_LIMIT);
        
          const sc01 = sceneChangeFrom(data.avgLuma, lastLuma, __motion01, cf01);
          lastLuma = data.avgLuma;
        
          const warm = Math.min(1, sampleCount / 3);
          const targetEV0 = computeTargetEV(lastStats, cfg);
          const targetEV = targetEV0 * warm;
        
          const curEV = Math.log2(curGain);
          const wantUp = targetEV > curEV;
          const tauBase = (sc01 > 0.55) ? cfg.TAU_AGGRESSIVE : (wantUp ? cfg.TAU_UP : cfg.TAU_DOWN);
          const tau = tauBase * (1 + risk01 * 1.10);
        
          const dtA = Math.min(now - lastApplyT, cfg.DT_CAP_MS);
          lastApplyT = now;
        
          const alphaA = 1 - Math.exp(-dtA / tau);
          const nextEV = curEV + (targetEV - curEV) * alphaA;
          curGain = Math.pow(2, nextEV);
        
          const look = computeLook(nextEV, lastStats, risk01, cfg, pack.look);
        
          if (onAE) {
            onAE({
              gain: curGain, gammaF: 1, conF: look.conF, satF: look.satF, mid: look.mid,
              toe: look.toe, shoulder: look.shoulder, brightAdd: look.brightAdd, tempAdd: 0,
              hiRisk: risk01, cf: cf01, luma: data.avgLuma * 100, clipFrac: lastStats.clipFrac, rd: lastStats.rd
            });
          }
        };
        
        const sample = (v) => {
          if (!isRunning || !v) return;
          if (document.hidden) return;
          if (v[VSCX.tainted]) return;
          if (v.readyState < 2) return;
          if (v[VSCX.visible] === false) return;
          if ((v.videoWidth|0) === 0 || (v.videoHeight|0) === 0) return;
        
          const now = performance.now();
          const base = (v.paused ? 600 : (CONFIG.IS_LOW_END ? 120 : 90));
          const minInterval = base + (1 - __motion01) * 80;
        
          if (now - lastSampleT < minInterval) return;
          lastSampleT = now;
        
          if (workerBusy) return;
        
          try {
            if (!canvas) {
              canvas = document.createElement('canvas');
              canvas.width = canvas.height = CONFIG.IS_LOW_END ? 24 : 32;
              ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
            }
            ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height);
            const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
        
            _motionFromFrame(d.data);
            workerBusy = true;
            const wk = ensureWorker();
            if (wk) wk.postMessage({ buf: d.data.buffer, width: canvas.width, height: canvas.height, step: canvas.width <= 24 ? 1 : 2, token: targetToken }, [d.data.buffer]);
            else workerBusy = false;
          } catch (_) {
            workerBusy = false; v[VSCX.tainted] = true;
          }
        };
        
        const loop = (token) => {
            if (!isRunning || token !== loopToken) return;
            const v = activeVideo;
            const now = performance.now();
            const active = sm.get(P.APP_ACT) && sm.get(P.V_AE);
            
            if (active && v && v.isConnected && !document.hidden) {
                const interval = v.paused ? 280 : (CONFIG.IS_LOW_END ? 110 : 85);
                if (now - lastLoopT > interval) {
                    lastLoopT = now;
                    sample(v);
                }
            }
            if (v && v.requestVideoFrameCallback && !v.paused) {
                try { v.requestVideoFrameCallback(() => loop(token)); return; } catch (_) {}
            }
            setTimeout(() => loop(token), 90);
        };

        return {
          setTarget: (v) => {
            if (v !== activeVideo) {
              activeVideo = v;
              targetToken++;
              workerBusy = false;
              __prevFrame = null;
              lastSampleT = 0;
              lastLuma = -1;
              sampleCount = 0;
              lastStats = { p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, cf: -1, rd: -1 };
            }
          },
          start: () => {
            ensureWorker();
            if (!isRunning) {
              isRunning = true;
              loopToken++;
              lastLoopT = 0;
              const now = performance.now();
              lastApplyT = now; lastEmaT = now; lastSampleT = 0;
              loop(loopToken);
            }
          },
          stop: () => {
            isRunning = false;
            loopToken++;
            try { worker?.terminate(); } catch (_) {}
            worker = null;
            if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) {} workerUrl = null; }
            activeVideo = null;
            curGain = 1;
            lastLuma = -1;
            __prevFrame = null;
          },
          wake: () => {},
          userTweak: () => {
            lastStats = { p10: -1, p35: -1, p50: -1, p90: -1, p95: -1, p98: -1, clipFrac: -1, cf: -1, rd: -1 };
            lastEmaT = performance.now();
          },
          __setOnAE: (fn) => { onAE = fn; }
        };
    }

    function createNoopUI() {
        return Object.freeze({
          ensure() {}, update() {}, destroy() {}
        });
    }

    function createUI(sm, defaults, config, registry, scheduler, bus) {
        const { h } = Utils;
        let container, monitorEl, gearHost, gearBtn;
        let fadeTimer = 0;
        const unsubs = [];
        
        const sub = (k, fn) => {
            const off = sm.sub(k, fn);
            unsubs.push(off);
            return off;
        };

        const AE_INPUT_WAKE_KEYS = new Set([P.V_GAMMA, P.V_CONTR, P.V_BRIGHT, P.V_SAT, P.V_TEMP, P.V_PRE_MIX, P.V_TONE_STR, P.V_AE_STR, P.V_DETAIL]);
        const AE_CHANGE_HARD_KEYS = new Set([P.V_GAMMA, P.V_CONTR, P.V_BRIGHT, P.V_PRE_MIX]);
        
        const detachNodesHard = () => {
            try { if (container?.isConnected) container.remove(); } catch (_) { }
            try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) { }
        };

        const __allowCache = { t: 0, v: false, rRev: -1, fs: null };
        const allowUiInThisDoc = () => {
            if (config.IS_TOP) return true;
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) { __allowCache.t = performance.now(); __allowCache.v = true; __allowCache.rRev = registry.rev(); __allowCache.fs = fs; return true; }
            const now = performance.now();
            const rRev = registry.rev();
            if ((now - __allowCache.t) < 650 && __allowCache.rRev === rRev && __allowCache.fs == null) return __allowCache.v;
            let ok = false;
            for (const v of registry.visible.videos) { const r = getRectCached(v, now, 350); if (r.width > 140 && r.height > 100) { ok = true; break; } }
            if (!ok) { const v = document.querySelector('video'); if (v) { const r = getRectCached(v, now, 350); ok = (r.width > 140 && r.height > 100); } }
            __allowCache.t = now; __allowCache.v = ok; __allowCache.rRev = rRev; __allowCache.fs = null;
            return ok;
        };

        const SLIDERS = [
            { l: '감마', k: P.V_GAMMA, min: 0.5, max: 2.5, s: 0.05, f: v => v.toFixed(2) },
            { l: '대비', k: P.V_CONTR, min: 0.5, max: 2.0, s: 0.05, f: v => v.toFixed(2) },
            { l: '밝기', k: P.V_BRIGHT, min: -50, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '채도', k: P.V_SAT, min: 0, max: 200, s: 5, f: v => v.toFixed(0) },
            { l: 'DETAIL', k: P.V_DETAIL, min: 0, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '색온도', k: P.V_TEMP, min: -25, max: 25, s: 1, f: v => v.toFixed(0) },
            { l: '그레인', k: P.V_DITHER, min: 0, max: 100, s: 5, f: v => v.toFixed(0) },
            { l: '오디오', k: P.A_BST, min: 0, max: 12, s: 1, f: v => `+${v}dB` },
            { l: '톤 강도', k: P.V_TONE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) },
            { l: 'AE 강도', k: P.V_AE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) }
        ];

        const getUiRoot = () => {
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) {
                if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement;
                return fs;
            }
            return document.body || document.documentElement;
        };

        const fireAE = (level, forceApply = true) => bus.signal({ aeLevel: level, forceApply: !!forceApply });
        const fireApplyOnly = (forceApply = true) => bus.signal({ aeLevel: 0, forceApply: !!forceApply });

        const renderChoiceRow = (label, items, key) => {
            const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
            items.forEach(it => {
                const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.t);
                b.onclick = () => {
                    const cur = sm.get(key);
                    if (key === P.V_AE_PROFILE) {
                        if (!sm.get(P.V_AE)) sm.set(P.V_AE, true);
                        if (it.v === 'balanced') sm.set(P.V_AE_PROFILE, 'balanced');
                        else sm.set(P.V_AE_PROFILE, (cur === it.v) ? 'balanced' : it.v);
                        fireAE(2, true);
                        return;
                    }
                    if (key === P.V_TONE_PRE) {
                        sm.set(P.V_TONE_PRE, (cur === it.v) ? null : it.v);
                        fireAE(1, true);
                        return;
                    }
                };

                if (key === P.V_AE_PROFILE) {
                    const updateAeState = () => {
                        const isAeOn = sm.get(P.V_AE);
                        const currentProfile = sm.get(P.V_AE_PROFILE);
                        b.classList.toggle('active', !!isAeOn && currentProfile === it.v);
                    };
                    sub(P.V_AE, updateAeState);
                    sub(P.V_AE_PROFILE, updateAeState);
                    updateAeState();
                } else {
                    sub(key, v => b.classList.toggle('active', v === it.v));
                    b.classList.toggle('active', sm.get(key) === it.v);
                }
                r.append(b);
            });
            return r;
        };

        const renderPresetRow = (label, items, key) => {
            const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
            const syncBtn = (btn, expected) => {
                const v = sm.get(key);
                btn.classList.toggle('active', v === expected);
            };

            items.forEach(it => {
                const val = (it.l || it.txt);
                const b = h('button', { class: 'pbtn', style: 'flex:1' }, val);
                b.onclick = () => {
                    sm.set(key, val);
                    const affectsAE = (key === P.V_PRE_B);
                    if (affectsAE) fireAE(2, true); else fireApplyOnly(true);
                };
                sub(key, v => b.classList.toggle('active', v === val));
                syncBtn(b, val);
                r.append(b);
            });

            const offVal = (key === P.V_PRE_B) ? 'brOFF' : 'off';
            const off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF');
            off.onclick = () => {
                sm.set(key, offVal);
                const affectsAE = (key === P.V_PRE_B);
                if (affectsAE) fireAE(2, true); else fireApplyOnly(true);
            };
            sub(key, v => off.classList.toggle('active', v === 'off' || v === 'brOFF'));
            off.classList.toggle('active', sm.get(key) === 'off' || sm.get(key) === 'brOFF');

            return r.append(off), r;
        };

        const renderSlider = (cfg) => {
            const valEl = h('span', { style: 'color:#3498db' }, '0');
            const inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
            const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
            sub(cfg.k, update); update(sm.get(cfg.k));

            inp.oninput = () => {
                const nv = Number(inp.value);
                valEl.textContent = cfg.f(nv);
                sm.set(cfg.k, nv);
                if (AE_INPUT_WAKE_KEYS.has(cfg.k)) fireAE(1, true); else fireApplyOnly(true);
            };
            inp.onchange = () => {
                if (AE_CHANGE_HARD_KEYS.has(cfg.k)) fireAE(2, true);
                else if (AE_INPUT_WAKE_KEYS.has(cfg.k)) fireAE(1, true);
            };
            return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp);
        };

        const build = () => {
            if (container) return;
            const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' });
            const shadow = host.attachShadow({ mode: 'open' });
            const style = `
                .main { position: fixed; top: 10%; right: 70px; width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); overflow-y: auto; max-height: 85vh; }
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
            const bodyV = h('div', { id: 'p-v' }, [
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
                    h('button', { id: 'ae-btn', class: 'btn', onclick: () => {
                        const on = !!sm.get(P.V_AE);
                        if (on) { sm.set(P.V_AE, false); }
                        else { sm.set(P.V_AE, true); sm.set(P.V_AE_PROFILE, 'balanced'); }
                        fireAE(2, true);
                    } }, '🤖 자동'),
                    h('button', { id: 'boost-btn', class: 'btn', onclick: () => sm.set(P.A_EN, !sm.get(P.A_EN)) }, '🔊 부스트')
                ),
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => { sm.batch('video', defaults.video); sm.batch('audio', defaults.audio); fireAE(2, true); } }, '↺ 리셋'),
                    h('button', { id: 'pwr-btn', class: 'btn', onclick: () => sm.set(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power')
                ),
                renderChoiceRow('AE', MODEL.aeProfiles.map(x => ({ t:x.label, v:x.id })), P.V_AE_PROFILE),
                renderChoiceRow('톤', MODEL.tonePresets.map(x => ({ t:x.label, v:x.id })), P.V_TONE_PRE),
                renderPresetRow('DET', MODEL.detailPresets.map(l => ({ l })), P.V_PRE_S),
                renderPresetRow('밝기', MODEL.brightPresets.map(txt => ({ txt })), P.V_PRE_B),
                h('hr'), h('div', { class: 'grid' }, SLIDERS.map(renderSlider)), h('hr'),
                h('div', { class: 'prow', style: 'justify-content:center;gap:4px;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => sm.set(P.PB_RATE, s); sub(P.PB_RATE, v => b.classList.toggle('active', Math.abs(v - s) < 0.01)); return b; }))
            ]);
            const bodyI = h('div', { id: 'p-i', style: 'display:none' }, [h('div', { class: 'grid' }, [renderSlider({ l: '이미지 윤곽', k: P.I_LVL, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }), renderSlider({ l: '이미지 색온도', k: P.I_TMP, min: -20, max: 20, s: 1, f: v => v.toFixed(0) })])]);
            shadow.append(h('style', {}, style), h('div', { class: 'main' }, [h('div', { class: 'tabs' }, [h('button', { id: 't-v', class: 'tab active', onclick: () => sm.set(P.APP_TAB, 'video') }, 'VIDEO'), h('button', { id: 't-i', class: 'tab', onclick: () => sm.set(P.APP_TAB, 'image') }, 'IMAGE')]), bodyV, bodyI, monitorEl = h('div', { class: 'monitor' }, `Ready (${CONFIG.VERSION})`)]));
            sub(P.APP_TAB, v => { shadow.querySelector('#t-v').classList.toggle('active', v === 'video'); shadow.querySelector('#t-i').classList.toggle('active', v === 'image'); shadow.querySelector('#p-v').style.display = v === 'video' ? 'block' : 'none'; shadow.querySelector('#p-i').style.display = v === 'image' ? 'block' : 'none'; });
            sub(P.V_AE, v => shadow.querySelector('#ae-btn').classList.toggle('active', !!v));
            sub(P.A_EN, v => shadow.querySelector('#boost-btn').classList.toggle('active', !!v));
            sub(P.APP_ACT, v => shadow.querySelector('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
            container = host; getUiRoot().appendChild(container);
        };

        const ensureGear = () => {
            if (!allowUiInThisDoc()) return;
            if (gearHost) return;
            gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
            const shadow = gearHost.attachShadow({ mode: 'open' });
            const style = `
                .gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0; margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity: 1;-webkit-tap-highlight-color: transparent;}
                @media (hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}}
                .gear:active{transform:translateY(-50%) scale(0.98);}
                .gear.open { outline: 2px solid rgba(52,152,219,0.85); opacity: 1 !important; }
                .gear.inactive { opacity: 0.45; }
                .hint { position: fixed; right: 74px; bottom: 24px; padding: 6px 10px; border-radius: 10px; background: rgba(25,25,25,0.88); border: 1px solid rgba(255,255,255,0.14); color: rgba(255,255,255,0.82); font: 600 11px/1.2 sans-serif; white-space: nowrap; z-index: 2147483647; opacity: 0; transform: translateY(6px); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
                .gear:hover + .hint { opacity: 1; transform: translateY(0); }
                ${CONFIG.IS_MOBILE ? '.hint { display: none !important; }' : ''}
            `;
            gearBtn = h('button', { class: 'gear', onclick: () => sm.set(P.APP_UI, !sm.get(P.APP_UI)) }, '⚙');
            shadow.append(h('style', {}, style), gearBtn, h('div', { class: 'hint' }, '설정 (Alt+Shift+V)'));
            const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open')) gearBtn.style.opacity = '0.15'; }, 2500); };
            gearHost.addEventListener('mousemove', wake, { passive: true });
            gearHost.addEventListener('touchstart', wake, { passive: true });
            setTimeout(wake, 2000);
            const syncGear = () => {
                if (!gearBtn) return;
                const showHere = allowUiInThisDoc();
                gearBtn.classList.toggle('open', !!sm.get(P.APP_UI));
                gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT));
                gearBtn.style.display = showHere ? 'block' : 'none';
                if (!showHere) detachNodesHard(); else wake();
            };
            sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
        };

        const mount = () => {
            if (!allowUiInThisDoc()) { detachNodesHard(); return; }
            const root = getUiRoot(); if (!root) return;
            try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) { }
            try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) { }
        };

        const ensure = () => {
            if (!allowUiInThisDoc()) { detachNodesHard(); return; }
            ensureGear();
            if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; }
            else { if (container) container.style.display = 'none'; }
            mount();
        };

        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => {
                try { ensure(); scheduler.request(true); } catch (_) { }
            }, { once: true });
        }

        ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => { window.addEventListener(ev, () => { try { ensure(); } catch (_) { } }, { passive: true }); });
        window.addEventListener('keydown', (e) => {
            if (!(e && e.altKey && e.shiftKey && e.code === 'KeyV')) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (!allowUiInThisDoc()) return;
            sm.set(P.APP_UI, !sm.get(P.APP_UI)); ensure(); scheduler.request(true);
        }, true);

        return {
            ensure,
            update: (text, isAE) => { if (monitorEl && sm.get(P.APP_UI)) { monitorEl.textContent = text; monitorEl.style.color = isAE ? "#2ecc71" : "#aaa"; } },
            destroy: () => { 
                for (const off of unsubs) { try { off(); } catch(_){} }
                unsubs.length = 0;
                detachNodesHard(); 
            }
        };
    }

    function createUIFactory(enableUI) {
        if (!enableUI) return () => createNoopUI();
        return (sm, defaults, config, registry, scheduler, bus) =>
          createUI(sm, defaults, config, registry, scheduler, bus);
    }

    // --- Controller / Runner ---
    function createAppController({ Store, Registry, Scheduler, Bus, Filters, Audio, AE, UI, DEFAULTS, FEATURES, Utils, P, Targeting, enableUI }) {
        if (enableUI) {
            UI.ensure();
            Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
        }
        
        const syncImg = () => { try { Registry.syncImageObservation?.(); } catch (_) {} };
        Store.sub(P.APP_ACT, syncImg);
        Store.sub(P.APP_TAB, syncImg);
        Store.sub(P.I_LVL, syncImg);
        Store.sub(P.I_TMP, syncImg);
        syncImg();
        
        Bus.on('signal', (s) => {
            const aeOn = FEATURES.ae();
            if (aeOn) {
                if ((s.aeLevel | 0) >= 2) AE.userTweak?.();
                if ((s.aeLevel | 0) >= 1) AE.wake?.();
            }
            if (s.forceApply) Scheduler.request(true);
        });
        
        const __vfEff = { ...DEFAULTS.video };
        const __aeOut = { gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5, mid: 0, clipFrac: 0, rd: 0 };
        const __vVals = { gain: 1, gamma: 1, contrast: 1, bright: 0, satF: 1, mid: 0, detail: 0, dither: 0, temp: 0, toe: 0, shoulder: 0 };
        const __iVals = { satF: 1, gain: 1, gamma: 1, contrast: 1, bright: 0, detail: 0, dither: 0, temp: 0, toe: 0, shoulder: 0, mid: 0 };
        
        let lastSRev = -1, lastRRev = -1, lastAeRev = -1;
        let lastPrune = 0;
        let aeRev = 0;
        let currentAE = { ...__aeOut };
        
        const onAE = (ae) => { currentAE = ae; aeRev++; Scheduler.request(false); };
        if (AE && AE.__setOnAE) AE.__setOnAE(onAE); 

        const restoreRateOne = (el) => { 
            try { 
                const st = el[VSCX.rateState]; 
                if (st?.orig != null) el.playbackRate = st.orig; 
                if (st) st.orig = null;
            } catch (_) { } 
        };
        
        const onEvictVideo = (v) => {
            try { Filters.clear(v); } catch (_) {}
            try { restoreRateOne(v); } catch (_) {}
        };
        const onEvictImage = (img) => {
            try { Filters.clear(img); } catch (_) {}
        };
        
        const cleanupTouched = (TOUCHED) => {
            for (const v of TOUCHED.videos) { onEvictVideo(v); }
            for (const i of TOUCHED.images) { onEvictImage(i); }
            TOUCHED.videos.clear(); TOUCHED.images.clear();
        };

        const getRateState = (v) => { 
            let st = v[VSCX.rateState]; 
            if (!st) st = v[VSCX.rateState] = { orig: null, lastSetAt: 0 }; 
            return st; 
        };
        const bindVideoOnce = (v) => {
            if (v[VSCX.bound]) return; v[VSCX.bound] = true;
            v.addEventListener('seeking', () => Bus.signal({ aeLevel: 1 }), { passive: true });
            v.addEventListener('play', () => Bus.signal({ aeLevel: 1 }), { passive: true });
            v.addEventListener('ratechange', () => {
                const st = getRateState(v); const now = performance.now();
                if (now - st.lastSetAt < 90) return;
                const cur = v.playbackRate;
                if (Number.isFinite(cur) && cur > 0) Store.set(P.PB_RATE, cur);
            }, { passive: true });
        };
        
        const applyVideoFilters = (applySet, dirtyVideos, vVals, activeFx) => {
            for (const el of dirtyVideos) { 
                if (!el || el.tagName !== 'VIDEO') continue; 
                if (!activeFx || el[VSCX.visible] === false) { try { Filters.clear(el); } catch (_) { } }
            }
            if (!activeFx) return;

            for (const el of applySet) {
                if (!el || el.tagName !== 'VIDEO') continue; 
                if (el[VSCX.visible] === false) continue;
                const doc = el.ownerDocument || document;
                const url = Filters.prepareCached(doc, vVals, 'video');
                Filters.applyUrl(el, url);
                touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
                bindVideoOnce(el);
            }
        };

        const applyImageFilters = (visibleImages, dirtyImages, iVals, activeFx) => {
            for (const el of dirtyImages) { 
                if (!el || el.tagName !== 'IMG') continue; 
                if (!activeFx || el[VSCX.visible] === false) { try { Filters.clear(el); } catch (_) { } }
            }
            if (!activeFx) return;

            for (const el of visibleImages) {
                if (!el || el.tagName !== 'IMG') continue; 
                if (el[VSCX.visible] === false) continue;
                const doc = el.ownerDocument || document;
                const url = Filters.prepareCached(doc, iVals, 'image');
                Filters.applyUrl(el, url);
                touchedAddLimited(TOUCHED.images, el, onEvictImage);
            }
        };

        const applyPlaybackRate = (applySet, dirtyVideos, desiredRate, active) => {
            for (const v of TOUCHED.videos) {
                if (!v || v.tagName !== 'VIDEO') continue;
                const shouldHave = active && applySet.has(v) && v[VSCX.visible] !== false;
                if (!shouldHave) restoreRateOne(v);
            }
            for (const el of dirtyVideos) {
                if (!el || el.tagName !== 'VIDEO') continue;
                if (!active || el[VSCX.visible] === false) restoreRateOne(el);
            }
            if (!active) return;
            for (const v of applySet) {
                if (!v || v.tagName !== 'VIDEO') continue;
                if (v[VSCX.visible] === false) continue;
                const st = getRateState(v);
                if (st.orig == null) st.orig = v.playbackRate;
                if (Math.abs(v.playbackRate - desiredRate) > 0.01) {
                    st.lastSetAt = performance.now();
                    try { v.playbackRate = desiredRate; } catch (_) { }
                }
                bindVideoOnce(v);
            }
        };
        
        Scheduler.registerApply((force) => {
            try {
                const app = Store.getCat('app');
                const active = !!app.active;
        
                if (!active) {
                    cleanupTouched(TOUCHED);
                    Audio.update();
                    AE.stop?.();
                    if (enableUI) UI.update('OFF', false);
                    return;
                }
        
                const sRev = Store.rev();
                const rRev = Registry.rev();
                if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev) return;
                lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev;
        
                const now = performance.now();
                if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }
        
                const vf0 = Store.getCat('video');
                const img = Store.getCat('image');
        
                const wantImages = FEATURES.images();
                const wantAE = FEATURES.ae();
                const wantAudio = FEATURES.audio();
        
                const { visible } = Registry;
                const dirty = Registry.consumeDirty();
                const vidsDirty = dirty.videos;
                const imgsDirty = dirty.images;
        
                const target = Targeting.pick(visible.videos, window.__lastClickedVideo, window.__lastUserPt, wantAudio);
        
                if (!target) {
                    if (wantAE) AE.stop?.();
                    Audio.setTarget(null);
                } else {
                    if (wantAE) { AE.setTarget(target); AE.start(); }
                    const keepBypass = Audio.hasCtx?.() || Audio.isHooked?.();
                    if (wantAudio || keepBypass) Audio.setTarget(target);
                    else Audio.setTarget(null);
                }
                Audio.update();
        
                let vfEff = vf0;
                if (vf0.tonePreset && vf0.tonePreset !== 'neutral') {
                    const tEff = computeToneStrengthEff(vf0, wantAE ? currentAE : null, Utils);
                    for (const k in __vfEff) __vfEff[k] = vf0[k];
                    __vfEff.toneStrength = tEff;
                    vfEff = __vfEff;
                }
        
                computeAeMix3Into(__vVals, vfEff, Utils);
                let expMix = __vVals.expMix;
                let toneMix = __vVals.toneMix;
        
                const aeStr = Utils.clamp(vfEff.aeStrength ?? 1.0, 0, 1);
                expMix *= aeStr;
                toneMix *= aeStr;
        
                const mixLog2 = (g, t) => Math.pow(2, Math.log2(Math.max(1e-6, g)) * t);
                const aeRaw = wantAE ? currentAE : null;
                
                let aeOut = null;
                if (aeRaw) {
                    __aeOut.gain = mixLog2(aeRaw.gain ?? 1, expMix);
                    __aeOut.gammaF = 1;
                    __aeOut.brightAdd = (aeRaw.brightAdd ?? 0) * expMix;
                    __aeOut.tempAdd = 0;
            
                    __aeOut.conF = 1 + ((aeRaw.conF ?? 1) - 1) * toneMix;
                    __aeOut.satF = 1 + ((aeRaw.satF ?? 1) - 1) * toneMix;
                    __aeOut.mid  = (aeRaw.mid ?? 0) * toneMix;
                    __aeOut.toe  = (aeRaw.toe ?? 0) * toneMix;
                    __aeOut.shoulder = (aeRaw.shoulder ?? 0) * toneMix;
            
                    __aeOut.hiRisk = aeRaw.hiRisk ?? 0;
                    __aeOut.cf = aeRaw.cf ?? 0.5;
                    __aeOut.luma = aeRaw.luma ?? 0;
                    __aeOut.clipFrac = aeRaw.clipFrac ?? 0;
                    __aeOut.rd = aeRaw.rd ?? 0;
            
                    aeOut = __aeOut;
                }
        
                composeVideoParamsInto(__vVals, vfEff, aeOut, DEFAULTS.video, Utils);
        
                __iVals.satF = 1.0;
                __iVals.gain = 1.0;
                __iVals.gamma = 1.0;
                __iVals.contrast = 1.0;
                __iVals.bright = 0;
                __iVals.detail = img.level;
                __iVals.dither = 0;
                __iVals.temp = img.temp;
                __iVals.toe = 0;
                __iVals.shoulder = 0;
                __iVals.mid = 0;
        
                const videoFxOn = !isNeutralVideoParams(__vVals);
        
                if (enableUI && app.uiVisible) {
                    if (wantAE) UI.update(`AE: ${__vVals.gain.toFixed(2)}x L:${Math.round(currentAE.luma || 0)}%`, true);
                    else UI.update(`Ready (${CONFIG.VERSION})`, false);
                }
        
                const applySet = Targeting.buildApplySetReuse(visible.videos, target, CFG.extraApplyTopK, CFG.applyToAllVisibleVideos, window.__lastUserPt, wantAudio);
        
                applyVideoFilters(applySet, vidsDirty, __vVals, videoFxOn);

                for (const v of TOUCHED.videos) {
                    if (!v || !v.isConnected) { TOUCHED.videos.delete(v); continue; }
                    const shouldHave = videoFxOn && applySet.has(v) && v[VSCX.visible] !== false;
                    if (!shouldHave) { 
                        try { Filters.clear(v); } catch (_) { } 
                        TOUCHED.videos.delete(v); 
                    }
                }
        
                if (wantImages) applyImageFilters(visible.images, imgsDirty, __iVals, true);
                else {
                    for (const imgEl of TOUCHED.images) {
                        if (!imgEl || !imgEl.isConnected) { TOUCHED.images.delete(imgEl); continue; }
                        try { Filters.clear(imgEl); } catch (_) { }
                        TOUCHED.images.delete(imgEl);
                    }
                    applyImageFilters(new Set(), imgsDirty, __iVals, false);
                }
        
                const desiredRate = Store.get(P.PB_RATE);
                const pbActive = active && Math.abs((desiredRate || 1) - 1.0) > 0.01;
                applyPlaybackRate(applySet, vidsDirty, desiredRate, pbActive);
        
                if (enableUI && (force || vidsDirty.size || imgsDirty.size)) UI.ensure();
        
            } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch(_) {} }
        });
        
        let tickTimer = 0;
        const startTick = () => {
            if (tickTimer) return;
            tickTimer = setInterval(() => {
                if (!Store.get(P.APP_ACT)) return;
                if (document.hidden) return;
                Scheduler.request(false);
            }, 12000);
        };
        const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
        const refreshTick = () => { (FEATURES.ae() || FEATURES.audio()) ? startTick() : stopTick(); };
        
        Store.sub(P.V_AE, refreshTick);
        Store.sub(P.A_EN, refreshTick);
        Store.sub(P.APP_ACT, refreshTick);
        refreshTick();
        
        Scheduler.request(true);
        
        return Object.freeze({
            destroy() {
                stopTick();
                try { UI.destroy?.(); } catch (_) {}
                try { AE.stop?.(); } catch (_) {}
                try { Audio.setTarget(null); } catch (_) {}
            }
        });
    }

    // --- Main Execution ---
    const Utils = createUtils();
    const Scheduler = createScheduler(16);
    const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
    const Bus = createEventBus();

    function normalizeAeProfile(sm) {
        if (sm.get(P.V_AE)) {
            const prof = sm.get(P.V_AE_PROFILE);
            if (!prof) sm.set(P.V_AE_PROFILE, 'balanced');
        }
    }
    Store.sub(P.V_AE, () => normalizeAeProfile(Store));
    Store.sub(P.V_AE_PROFILE, () => normalizeAeProfile(Store));

    const FEATURES = {
        active: () => Store.get(P.APP_ACT),
        images: () => {
            if (!Store.get(P.APP_ACT)) return false;
            if (Store.get(P.APP_TAB) === 'image') return true;
            return Store.get(P.I_LVL) !== DEFAULTS.image.level || Store.get(P.I_TMP) !== DEFAULTS.image.temp;
        },
        ae: () => {
            if (!(Store.get(P.APP_ACT) && Store.get(P.V_AE))) return false;
            const s = Utils.clamp(Store.get(P.V_AE_STR) ?? 1.0, 0, 1);
            return s > 0.02;
        },
        audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN)
    };

    const Registry = createRegistry(Scheduler, FEATURES);
    const Targeting = createTargeting({ Utils });

    (function ensureRegistryAfterBodyReady() {
        const run = () => {
            try { Registry.refreshObservers(); } catch (_) { }
            try { Registry.rescanAll(); } catch (_) { }
            try { Scheduler.request(true); } catch (_) { }
        };
        if (document.body) { run(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); run(); } });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) { }
        document.addEventListener('DOMContentLoaded', () => run(), { once: true });
    })();

    const Filters = createFiltersUnified(Utils, { VSC_ID: CONFIG.VSC_ID });
    const Audio = createAudio(Store);
    const AE = createAE(Store, { IS_MOBILE: CONFIG.IS_MOBILE, Utils }, null);
    
    const makeUI = createUIFactory(ENABLE_UI);
    const UI = makeUI(Store, DEFAULTS, { IS_TOP: CONFIG.IS_TOP }, Registry, Scheduler, Bus);

    window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 };
    window.__lastClickedVideo = null;

    window.addEventListener('pointerdown', (e) => {
        window.__lastUserPt = { x: e.clientX, y: e.clientY, t: performance.now() };
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const v = el?.closest?.('video');
        if (v) window.__lastClickedVideo = v;
    }, { passive: true });
    window.addEventListener('wheel', () => window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }, { passive: true });
    window.addEventListener('keydown', (e) => { window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }; }, { passive: true });

    createAppController({
        Store, Registry, Scheduler, Bus,
        Filters, Audio, AE,
        UI, DEFAULTS, FEATURES,
        Utils, P, Targeting,
        enableUI: ENABLE_UI
    });

})();
