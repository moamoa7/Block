// ==UserScript==
// @name        Video_Image_Control (Local_Indep_v146_ToneFix)
// @namespace   https://github.com/
// @version     146.0.0.0
// @description Video Control: Sharp-Only-Neutral, Lazy-Filter, AE-Mix-V3, Auto-Cleanup
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

    // 1-1. Safe attachShadow Patch
    const VSC_PATCH = Symbol.for('vsc.patch.attachShadow');
    (function patchAttachShadowOnce() {
        const proto = Element.prototype;
        if (!proto.attachShadow || proto[VSC_PATCH]) return;
        const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
        const orig = desc?.value;
        if (typeof orig !== 'function') return;
        Object.defineProperty(proto, VSC_PATCH, { value: true });
        Object.defineProperty(proto, 'attachShadow', {
            ...desc,
            value: function (init) {
                const shadow = orig.call(this, init);
                try { if (shadow) document.dispatchEvent(new CustomEvent('vsc-shadow-root', { detail: shadow })); } catch (_) { }
                return shadow;
            }
        });
    })();

    const IS_TOP = window === window.top;
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_LOW_END = (navigator.deviceMemory || 4) < 4;
    const VERSION_STR = "v146.ToneFix";
    const VSC_ID = Math.random().toString(36).slice(2);

    const VSCX = Object.freeze({
        visible: Symbol('vsc.visible'),
        rect: Symbol('vsc.rect'),
        ir: Symbol('vsc.ir'),
        bound: Symbol('vsc.bound'),
        rateState: Symbol('vsc.rateState'),
        tainted: Symbol('vsc.tainted'),
        audioFail: Symbol('vsc.audioFail')
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
        pc: { STRENGTH: 0.62, MAX_UP_EV: 0.55, MAX_DOWN_EV: -0.36, TARGET_MID_BASE: 0.28 },
        mobile: { STRENGTH: 0.52, MAX_UP_EV: 0.50, MAX_DOWN_EV: -0.32, TARGET_MID_BASE: 0.27 }
    });

    const AE_PROFILES = Object.freeze({
        balanced: {
            delta: {
                STRENGTH: -0.06, TARGET_MID_BASE: -0.015, MAX_UP_EV: -0.08,
                TAU_UP: +120, TAU_DOWN: +120, SAT_MAX: -0.02
            },
            look: { brMul: 0.98, satMul: 0.98, conAdd: -0.008, midMul: 0.98, toeMul: 1.08, shMul: 1.00 }
        },
        cinematic: {
            delta: {
                STRENGTH: -0.22, TARGET_MID_BASE: -0.045, MAX_UP_EV: -0.28, MAX_DOWN_EV: -0.10,
                TAU_UP: +220, TAU_DOWN: +260, TAU_AGGRESSIVE: +60, SAT_MAX: -0.10, SAT_MIN: +0.02
            },
            look: { brMul: 0.88, satMul: 0.90, conAdd: -0.020, midMul: 0.92, toeMul: 1.30, shMul: 1.05 }
        },
        bright: {
            delta: {
                STRENGTH: +0.18, TARGET_MID_BASE: +0.050, MAX_UP_EV: +0.22, MAX_DOWN_EV: +0.06,
                TAU_UP: -160, TAU_DOWN: -120, TAU_AGGRESSIVE: -40, SAT_MAX: +0.14, SAT_MIN: +0.02
            },
            look: { brMul: 1.12, satMul: 1.10, conAdd: +0.010, midMul: 1.08, toeMul: 0.92, shMul: 0.92 }
        }
    });

    const PRESET = Object.freeze({
        sharp: {
            off: { sharpAdd: 0, sharp2Add: 0 },
            S: { sharpAdd: 8, sharp2Add: 3 },
            M: { sharpAdd: 15, sharp2Add: 6 },
            L: { sharpAdd: 25, sharp2Add: 10 },
            XL: { sharpAdd: 35, sharp2Add: 15 }
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
            gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
            temp: 0, sharp: 0, sharp2: 0, dither: 0, clarity: 0,
            ae: false, presetS: 'off', presetB: 'brOFF',
            presetMix: 1.0, aeProfile: null, tonePreset: null, toneStrength: 1.0,
            toneLocked: false
        },
        image: { level: 15, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const P = Object.freeze({
        APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_TAB: 'app.tab',
        V_AE: 'video.ae', V_AE_PROFILE: 'video.aeProfile',
        V_TONE_PRE: 'video.tonePreset', V_TONE_STR: 'video.toneStrength',
        V_TONE_LOCK: 'video.toneLocked',
        V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright',
        V_SAT: 'video.sat', V_SHARP: 'video.sharp', V_SHARP2: 'video.sharp2',
        V_CLARITY: 'video.clarity', V_TEMP: 'video.temp', V_DITHER: 'video.dither',
        V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix',
        A_EN: 'audio.enabled', A_BST: 'audio.boost',
        PB_RATE: 'playback.rate',
        I_LVL: 'image.level', I_TMP: 'image.temp'
    });

    const TOUCHED = { videos: new Set(), images: new Set() };
    const TOUCHED_MAX = IS_LOW_END ? 60 : 140;
    const CFG = { applyToAllVisibleVideos: false, extraBigVideos: 1 };

    function touchedAddLimited(set, el) {
        if (!el) return;
        if (set.has(el)) return;
        set.add(el);
        if (set.size <= TOUCHED_MAX) return;
        const it = set.values();
        for (let i = 0; i < Math.ceil(TOUCHED_MAX * 0.25); i++) {
            const v = it.next().value;
            if (v == null) break;
            set.delete(v);
            try { Filters.clear(v); } catch (_) { }
        }
    }

    // ==========================================
    // HELPERS & MIX LOGIC
    // ==========================================

    function split2(p) {
        const i = p.indexOf('.');
        return (i > 0) ? [p.slice(0, i), p.slice(i + 1)] : [p, ''];
    }

    const lerp = (a, b, t) => a + (b - a) * t;

    function getRectCached(v, now, maxAgeMs = 250) {
        const t0 = v.__vscRectT || 0;
        let r = v[VSCX.rect];
        if (!r || (now - t0) > maxAgeMs) {
            r = v.getBoundingClientRect();
            v[VSCX.rect] = r;
            v.__vscRectT = now;
        }
        return r;
    }

    function isActuallyVisibleFast(el, now) {
        if (!el || !el.isConnected) return null;
        if (el[VSCX.visible] === false) return null;
        const r = getRectCached(el, now, 250);
        if (r.width < 80 || r.height < 60) return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return r;
    }

    function scoreVideo(v, audioBoostOn, now) {
        if (!v || v.readyState < 2) return -Infinity;
        const r = isActuallyVisibleFast(v, now);
        if (!r) return -Infinity;

        const area = r.width * r.height;
        const areaScore = Math.log2(1 + area / 20000);
        const playing = (!v.paused && !v.ended) ? 1 : 0;
        const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
        const dist = Math.hypot((r.left + r.width * 0.5) - __lastUserPt.x, (r.top + r.height * 0.5) - __lastUserPt.y);
        const distScore = 1 / (1 + dist / 850);
        const userRecent01 = Math.max(0, 1 - (now - __lastUserPt.t) / 2500);

        const userBoostRaw = userRecent01 * (1 / (1 + dist / 500)) * 2.0;
        const userBoost = Math.min(1.3, userBoostRaw);

        const ir = (v[VSCX.ir] == null) ? 0.01 : v[VSCX.ir];
        const irScore = Math.min(1, ir) * 3.2;
        const bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
        const big01 = Math.min(1, area / (900 * 500));
        const bgPenalty = bgLike ? (1.6 * (1 - 0.65 * big01)) : 0;
        const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0;
        const audibleBase = audible * 1.35;
        const audioScore = audioBoostOn ? (audible * 1.2) : 0;
        return (playing * 6.0) + (hasTime * 2.4) + (areaScore * 1.2) + (distScore * 3.0) + userBoost + irScore + audibleBase + audioScore - bgPenalty;
    }

    function pickBestVideo(videos) {
        const now = performance.now();
        if (!videos || videos.size === 0) { __currentTarget = null; __currentScore = -1; __currentSince = now; return null; }
        if (__lastClickedVideo && videos.has(__lastClickedVideo) && __lastClickedVideo.isConnected && __lastClickedVideo.readyState >= 2) {
            if (now - __lastUserPt.t < 900) { __currentTarget = __lastClickedVideo; __currentScore = Infinity; __currentSince = now; return __lastClickedVideo; }
        }
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs) {
            const v = (fs.tagName === 'VIDEO') ? fs : fs.querySelector?.('video');
            if (v && videos.has(v) && v.isConnected && v.readyState >= 2) { __currentTarget = v; __currentScore = Infinity; __currentSince = now; return v; }
        }
        if (document.pictureInPictureElement && videos.has(document.pictureInPictureElement)) { __currentTarget = document.pictureInPictureElement; __currentScore = Infinity; __currentSince = now; return document.pictureInPictureElement; }

        const audioBoostOn = Store.get(P.A_EN) && Store.get(P.APP_ACT);
        const limited = [];
        const pushTopK = (v) => {
            const ir = (v[VSCX.ir] == null) ? 0 : v[VSCX.ir];
            const r = getRectCached(v, now, 350);
            const area = r.width * r.height;
            if (ir < 0.01 && area < 160 * 120) return;
            const item = { ir, area, v };
            let i = 0;
            while (i < limited.length) {
                const a = limited[i];
                if (item.ir > a.ir || (item.ir === a.ir && item.area > a.area)) break;
                i++;
            }
            limited.splice(i, 0, item);
            if (limited.length > 10) limited.length = 10;
        };
        for (const v of videos) pushTopK(v);

        const curScore = (__currentTarget && videos.has(__currentTarget)) ? scoreVideo(__currentTarget, audioBoostOn, now) : -Infinity;
        let best = __currentTarget, bestScore = curScore;
        for (const it of limited) {
            const v = it.v;
            const s = scoreVideo(v, audioBoostOn, now);
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
        if (best !== __currentTarget) { __currentTarget = best; __currentScore = bestScore; __currentSince = now; }
        return __currentTarget;
    }

    function buildApplySet(visibleVideos, target) {
        if (CFG.applyToAllVisibleVideos) return visibleVideos;
        const set = new Set();
        if (target) set.add(target);
        const top = [];
        const N = Math.max(0, CFG.extraBigVideos | 0);
        if (N > 0) {
            const pushTop = (area, v) => {
                let i = 0;
                while (i < top.length && top[i].area >= area) i++;
                top.splice(i, 0, { area, v });
                if (top.length > N) top.length = N;
            };
            const now = performance.now();
            for (const v of visibleVideos) {
                if (!v || v === target) continue;
                const r = getRectCached(v, now, 350);
                pushTop(r.width * r.height, v);
            }
            for (const it of top) set.add(it.v);
        }
        return set;
    }

    function computeQualityTier({ IS_LOW_END, visibleCount, applyAll }) {
        let tier = IS_LOW_END ? 1 : 0;
        if (applyAll && visibleCount >= 2) tier = Math.max(tier, 1);
        if (visibleCount >= 4) tier = Math.max(tier, 1);
        if (visibleCount >= 7) tier = Math.max(tier, 2);
        return tier;
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
        let agg = { affectsAE: false, wakeAE: false, forceApply: false };
        const signal = (p) => {
            if (p) {
                if (p.affectsAE) agg.affectsAE = true;
                if (p.wakeAE) agg.wakeAE = true;
                if (p.forceApply) agg.forceApply = true;
            }
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                const out = agg;
                agg = { affectsAE: false, wakeAE: false, forceApply: false };
                emit('signal', out);
            });
        };
        return Object.freeze({ on, emit, signal });
    }

    function computeAeMix2(vf, Utils) {
        const { clamp } = Utils;
        const mix = clamp(vf.presetMix ?? 1.0, 0, 1);
        const pB = PRESET.grade[vf.presetB] || PRESET.grade.brOFF;

        const manualExp =
            Math.abs(vf.bright || 0) / 50 +
            Math.abs((vf.gamma || 1) - 1) / 0.65 +
            Math.abs((vf.contrast || 1) - 1) / 0.55;

        const manualCol =
            Math.abs((vf.sat || 100) - 100) / 110 +
            Math.abs(vf.temp || 0) / 18;

        const presetExp =
            Math.abs((pB.brightAdd || 0) * mix) / 50 +
            Math.abs(((pB.gammaF || 1) - 1) * mix) / 0.28 +
            Math.abs(((pB.conF || 1) - 1) * mix) / 0.22;

        const presetCol =
            Math.abs(((pB.satF || 1) - 1) * mix) / 0.25 +
            Math.abs((pB.tempAdd || 0) * mix) / 10;

        const toneOn = !!vf.tonePreset;
        const toneStr = toneOn ? clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;

        const expIntent = clamp(manualExp + presetExp + toneStr * 0.20, 0, 3.0);
        const toneIntent = clamp((manualExp * 0.55) + manualCol + presetCol + (toneStr * 0.95), 0, 3.5);

        let expMix = 1 - (0.58 * clamp(expIntent / 1.35, 0, 1));
        let toneMix = 1 - (0.72 * clamp(toneIntent / 1.35, 0, 1));

        expMix = clamp(expMix, 0.18, 1.00);
        toneMix = clamp(toneMix, 0.06, 1.00);

        if (toneOn && vf.tonePreset === 'highlight') {
            toneMix *= (1 - 0.12 * toneStr);
            expMix *= (1 - 0.05 * toneStr);
        }
        if (toneOn && vf.tonePreset === 'redSkin') {
            toneMix *= (1 - 0.10 * toneStr);
        }

        return { expMix, toneMix };
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
                };
            }
        };
    }

    const makeNoiseDataURL = (size = 64, seed = 1337) => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const ctx = c.getContext('2d', { alpha: false });
        const img = ctx.createImageData(size, size);
        let a = seed >>> 0;
        const rnd = () => {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let i = 0; i < img.data.length; i += 4) {
            const n = Math.floor(128 + (rnd() - 0.5) * 90);
            img.data[i] = img.data[i + 1] = img.data[i + 2] = n; img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
    };
    let NOISE_URL = null;
    const getNoiseUrl = () => (NOISE_URL ||= makeNoiseDataURL(64, 133));

    function getAePack(isMobile, profileName) {
        const dev = isMobile ? AE_DEVICE_BASE.mobile : AE_DEVICE_BASE.pc;
        const prof = AE_PROFILES[profileName] || AE_PROFILES.balanced;
        const delta = prof.delta || {};
        const out = { ...AE_COMMON, ...dev };
        const addRel = (k) => { if (delta[k] != null) out[k] = (out[k] ?? 0) + delta[k]; };
        ['STRENGTH', 'TARGET_MID_BASE', 'MAX_UP_EV', 'MAX_DOWN_EV', 'TAU_UP', 'TAU_DOWN', 'TAU_AGGRESSIVE', 'SAT_MIN', 'SAT_MAX'].forEach(addRel);
        return Object.freeze({
            cfg: Object.freeze(out),
            look: Object.freeze(prof.look || AE_PROFILES.balanced.look)
        });
    }

    function applyTonePreset2(base, presetName, strength, aeProfileName, Utils) {
        const { clamp } = Utils;
        const p0 = TONE_PRESET2[presetName] || TONE_PRESET2.neutral;
        const t0 = clamp(strength ?? 1.0, 0, 1);
        let p = { ...p0 }, t = t0;

        if (presetName === 'highlight') {
            if (aeProfileName === 'bright') { p.shoulder *= 0.65; p.br *= 0.65; t *= 0.90; }
            else if (aeProfileName === 'cinematic') { p.br *= 0.75; p.con = 1.00; t *= 0.95; }
        }
        if (presetName === 'redSkin') {
            if (aeProfileName === 'bright') { p.sat = 1.03; p.br *= 0.70; t *= 0.92; }
            else if (aeProfileName === 'cinematic') { p.sat = 1.03; p.tmp *= 0.80; }
        }

        return {
            ...base,
            mid: clamp((base.mid || 0) + (p.mid * t), -1, 1),
            contrast: clamp(base.contrast * (1 + (p.con - 1) * t), 0.5, 2.0),
            satF: clamp(base.satF * (1 + (p.sat - 1) * t), 0.0, 2.0),
            bright: clamp(base.bright + (p.br * t), -50, 50),
            temp: clamp(base.temp + (p.tmp * t), -25, 25),
            toe: clamp(base.toe + (p.toe * t), -14, 14),
            shoulder: clamp(base.shoulder + (p.shoulder * t), -14, 14),
        };
    }

    // [Refined] Split-Sharpness Logic for Better Retention
    function composeVideoParams(vUser, ae, defaultsVideo, Utils) {
        const clamp = Utils.clamp;
        const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);
        const pS = PRESET.sharp[vUser.presetS] || PRESET.sharp.off;
        const pB = PRESET.grade[vUser.presetB] || PRESET.grade.brOFF;

        const preGammaF = lerp(1.0, pB.gammaF, mix);
        const preConF = lerp(1.0, pB.conF, mix);
        const preSatF = lerp(1.0, pB.satF, mix);
        const preBright = (pB.brightAdd || 0) * mix;
        const preTemp = (pB.tempAdd || 0) * mix;
        const preSharp = (pS.sharpAdd || 0) * mix;
        const preSharp2 = (pS.sharp2Add || 0) * mix;

        const A = ae || { gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, hiRisk: 0, cf: 0.5, mid: 0 };

        let gamma = (vUser.gamma || 1.0) * preGammaF * (A.gammaF || 1.0);
        let contrast = (vUser.contrast || 1.0) * preConF * (A.conF || 1.0);
        let satF = ((vUser.sat || 100) / 100) * preSatF * (A.satF || 1.0);
        let bright = (vUser.bright || 0) + preBright + (A.brightAdd || 0);
        let temp = (vUser.temp || 0) + preTemp + (A.tempAdd || 0);

        const gain = clamp(A.gain || 1.0, 1.0, 8.0);
        const hiRisk01 = clamp(A.hiRisk || 0, 0, 1);
        const userSharp01 = clamp((((vUser.sharp || 0) + preSharp) / 50), 0, 1);

        // [Fix] Split Sharpness: Base is protected less, HF protected more
        let sharpMulBase = Math.max(0.62, 1 / (1 + (gain - 1.0) * 1.25));
        let sharpMulHF = Math.max(0.50, 1 / (1 + (gain - 1.0) * 1.80));

        sharpMulBase *= (1 - 0.18 * hiRisk01);
        sharpMulHF *= (1 - 0.42 * hiRisk01);

        const cf = (A.cf != null) ? A.cf : 0.5;
        const cfGate = Math.max(0, Math.min(1, (cf - 0.10) / 0.22));
        sharpMulBase *= (0.82 + 0.18 * cfGate);
        sharpMulHF *= (0.65 + 0.35 * cfGate);

        const satVal = clamp(satF, 0, 2.0);
        const satStress = Math.min(1, Math.abs(satVal - 1) / 0.55);
        const tempStress = Math.min(1, Math.abs(temp) / 25);
        const cf01 = clamp(cf, 0, 1);
        const chromaStress = (satStress * 0.85) + (tempStress * 0.65);
        const riskStress = (hiRisk01 * 0.70) + ((1 - cf01) * 0.45);
        const guard = 1 / (1 + chromaStress * 1.05 + riskStress * 0.85);
        const hfGuard = 1 / (1 + chromaStress * 1.45 + riskStress * 1.10);

        // Allow user intent to override protection slightly
        const relaxBase = 0.55 * userSharp01;
        const relaxHF = 0.40 * userSharp01;
        sharpMulBase *= lerp((0.78 + 0.22 * guard), 1.0, relaxBase);
        sharpMulHF *= lerp((0.55 + 0.45 * hfGuard), 1.0, relaxHF);

        let sharp = ((vUser.sharp || 0) + preSharp) * sharpMulBase;
        let sharp2 = ((vUser.sharp2 || 0) + preSharp2) * sharpMulHF;
        let clarity = (vUser.clarity || 0) * sharpMulHF;

        const manualStyle = (Math.abs(vUser.bright || 0) > 10) || (Math.abs((vUser.gamma || 1) - 1) > 0.10) || (Math.abs((vUser.contrast || 1) - 1) > 0.10) || (Math.abs((vUser.sat || 100) - 100) > 25);
        const styleMix = manualStyle ? 0.80 : 1.00;

        let out = {
            gain, gamma: clamp(gamma, 0.5, 2.5), contrast: clamp(contrast, 0.5, 2.0),
            bright: clamp(bright, -50, 50), satF: clamp(satF, 0.0, 2.0),
            mid: clamp((A.mid || 0) * styleMix, -1, 1),
            sharp: clamp(sharp, 0, 50), sharp2: clamp(sharp2, 0, 50), clarity: clamp(clarity, 0, 50),
            dither: vUser.dither || 0, temp: clamp(temp, -25, 25),
            toe: (A.toe || 0) * styleMix, shoulder: (A.shoulder || 0) * styleMix
        };

        const toneName = vUser.tonePreset;
        const toneStr = vUser.toneStrength;
        if (toneName) out = applyTonePreset2(out, toneName, toneStr, vUser.aeProfile, Utils);
        return out;
    }

    const isNeutralVideoParams = (v) => (
        Math.abs((v.gain ?? 1) - 1) < 0.001 &&
        Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
        Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
        Math.abs((v.bright ?? 0)) < 0.01 &&
        Math.abs((v.satF ?? 1) - 1) < 0.001 &&
        Math.abs((v.mid ?? 0)) < 0.001 &&
        (v.sharp | 0) === 0 && (v.sharp2 | 0) === 0 && (v.clarity | 0) === 0 &&
        (v.dither | 0) === 0 && (v.temp | 0) === 0 &&
        (v.toe | 0) === 0 && (v.shoulder | 0) === 0
    );

    function createScheduler() {
        let queued = false, force = false, applyFn = null;
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
    }

    function createLocalStore(defaults, scheduler, Utils) {
        let state = Utils.deepClone(defaults);
        let rev = 0;
        const listeners = new Map();
        const emit = (key, val) => {
            const a = listeners.get(key); if (a) for (const cb of a) cb(val);
            const cat = key.split('.')[0];
            const b = listeners.get(cat + '.*'); if (b) for (const cb of b) cb(val);
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
                const a = listeners.get(k) || [];
                a.push(f); listeners.set(k, a);
                return () => { const cur = listeners.get(k); if (!cur) return; const i = cur.indexOf(f); if (i >= 0) cur.splice(i, 1); };
            }
        };
    }

    function createRegistry(scheduler, featureCheck, { IS_LOW_END }) {
        const videos = new Set(), images = new Set();
        const visible = { videos: new Set(), images: new Set() };
        const dirty = { videos: new Set(), images: new Set() };
        let rev = 0;

        const observedShadowHosts = new WeakSet();
        const shadowRootsLRU = [];
        const SHADOW_LRU_MAX = IS_LOW_END ? 8 : 24;

        const io = new IntersectionObserver((entries) => {
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
        }, { root: null, threshold: 0.01, rootMargin: IS_LOW_END ? '120px' : '300px' });

        const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
        const observeMediaEl = (el) => {
            if (!featureCheck.active() || !el || isInVscUI(el)) return;
            if (el.tagName === 'VIDEO') { if (videos.has(el)) return; videos.add(el); io.observe(el); }
            else if (el.tagName === 'IMG') { if (!featureCheck.images() || images.has(el)) return; images.add(el); io.observe(el); }
        };

        const WorkQ = (() => {
            const q = []; let head = 0; let scheduled = false;
            let epoch = 1; const mark = new WeakMap();
            const schedule = () => { if (scheduled) return; scheduled = true; const runner = (dl) => drain(dl); if (window.requestIdleCallback) requestIdleCallback(runner); else requestAnimationFrame(() => runner()); };
            const enqueue = (n) => { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return; const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch); q.push(n); schedule(); };
            const scanNode = (n) => {
                if (!n) return;
                if (n.nodeType === 1) {
                    const tag = n.tagName;
                    if (tag === 'VIDEO' || tag === 'IMG') { observeMediaEl(n); return; }

                    // [Perf] If huge subtree, defer (avoid immediate deep query)
                    const childCnt = n.childElementCount || 0;
                    if (childCnt > 1200) {
                        requestAnimationFrame(() => {
                            try { n.querySelectorAll?.('video,img')?.forEach(observeMediaEl); } catch (_) { }
                        });
                        return;
                    }

                    if (n.querySelectorAll) n.querySelectorAll('video,img').forEach(observeMediaEl);
                    return;
                }
                if (n.nodeType === 11) { if (n.querySelectorAll) n.querySelectorAll('video,img').forEach(observeMediaEl); }
            };
            const drain = (dl) => {
                scheduled = false; const start = performance.now();
                const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6;
                while (head < q.length && budget()) { const n = q[head++]; try { scanNode(n); } catch (_) { } }
                if (head >= q.length) { q.length = 0; head = 0; epoch++; return; }
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
            const arr = Array.from(set);
            for (let i = 0; i < Math.min(batch, arr.length); i++) {
                const el = arr[i];
                if (!el || !el.isConnected) {
                    set.delete(el); visibleSet.delete(el); dirtySet.delete(el); touchedSet.delete(el);
                    try { unobserveFn(el); } catch (_) { }
                }
            }
        }

        return {
            videos, images, visible, rev: () => rev, refreshObservers,
            prune: () => {
                pruneBatch(videos, visible.videos, dirty.videos, TOUCHED.videos, io.unobserve.bind(io), IS_LOW_END ? 120 : 220);
                pruneBatch(images, visible.images, dirty.images, TOUCHED.images, io.unobserve.bind(io), IS_LOW_END ? 120 : 220);
                rev++;
            },
            consumeDirty: () => { const out = { videos: new Set(dirty.videos), images: new Set(dirty.images) }; dirty.videos.clear(); dirty.images.clear(); return out; },
            setWantImages: (want) => {
                if (want) return [];
                const removed = Array.from(images); images.clear(); visible.images.clear(); dirty.images.clear(); rev++;
                for (const i of removed) io.unobserve(i); return removed;
            },
            rescanAll: () => { WorkQ.enqueue(document.body || document.documentElement); }
        };
    }

    function createAudio(sm) {
        let ctx, compressor, dry, wet, target = null, currentSrc = null;
        const srcMap = new WeakMap();
        const onGesture = () => { try { if (ctx?.state === 'suspended') ctx.resume(); } catch (_) { } };
        window.addEventListener('pointerdown', onGesture, { once: true, passive: true });

        const ensureCtx = () => {
            if (ctx) return true;
            const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
            ctx = new AC(); compressor = ctx.createDynamicsCompressor();
            compressor.threshold.value = -24; compressor.knee.value = 24; compressor.ratio.value = 4;
            compressor.attack.value = 0.005; compressor.release.value = 0.20;
            dry = ctx.createGain(); dry.connect(ctx.destination);
            wet = ctx.createGain(); compressor.connect(wet); wet.connect(ctx.destination);
            return true;
        };
        const updateMix = () => {
            if (!ctx) return;
            const en = sm.get(P.A_EN) && sm.get(P.APP_ACT);
            const boost = Math.pow(10, sm.get(P.A_BST) / 20);
            dry.gain.setTargetAtTime(en ? 0 : 1, ctx.currentTime, 0.05);
            wet.gain.setTargetAtTime(en ? boost : 0, ctx.currentTime, 0.05);
        };
        const disconnect = () => { if (currentSrc) { try { currentSrc.disconnect(); } catch (_) { } currentSrc = null; target = null; } };

        return {
            setTarget: (v) => {
                if (v !== target) { if (currentSrc) disconnect(); target = v; }
                const enabled = sm.get(P.A_EN) && sm.get(P.APP_ACT);
                const shouldUseGraph = enabled || (!!currentSrc && !!ctx);
                if (v && !currentSrc && shouldUseGraph) {
                    if (ensureCtx()) {
                        try {
                            let s = srcMap.get(v); if (!s) { s = ctx.createMediaElementSource(v); srcMap.set(v, s); }
                            s.connect(dry); s.connect(compressor); currentSrc = s;
                        } catch (_) { v[VSCX.audioFail] = true; disconnect(); }
                    }
                }
                updateMix();
            },
            update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc
        };
    }

    // [New] Fully Refactored Filters: Lazy Creation & Expanded Bounds
    function createFilters(Utils, config) {
        const { h, clamp, createLRU } = Utils;
        const ctxMap = new WeakMap();
        const toneCache = createLRU(IS_LOW_END ? 256 : 512);
        const prepCache = new WeakMap();

        const getPrepLRU = (doc, kind) => {
            let e = prepCache.get(doc);
            if (!e) { e = { v: createLRU(IS_LOW_END ? 16 : 48), i: createLRU(IS_LOW_END ? 12 : 32) }; prepCache.set(doc, e); }
            return (kind === 'video') ? e.v : e.i;
        };

        const setAttr = (node, attr, val, st, key) => { if (!node) return; if (st[key] === val) return; st[key] = val; node.setAttribute(attr, val); };
        const qInt = (v, step) => Math.round(v / step);
        const makePrepKey = (kind, s, tier) => [
            tier, qInt(s.gain, 0.02), qInt(s.gamma, 0.01), qInt(s.contrast, 0.01), qInt(s.bright, 0.2),
            qInt(s.satF, 0.01), qInt(s.mid, 0.02), qInt(s.toe, 0.2), qInt(s.shoulder, 0.2),
            qInt(s.temp, 0.2), qInt(s.sharp, 0.2), qInt(s.sharp2, 0.2), qInt(s.clarity, 0.2), qInt(s.dither, 1)
        ].join(',');

        const smoothstep = (a, b, x) => {
            const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-6, (b - a))));
            return t * t * (3 - 2 * t);
        };

        // [Fix] Corrected Tone Table Logic: Exact Identity at Neutral
        function getToneTableCached3(steps, toeN, shoulderN, midN, bright, contrast, gain) {
            toeN = qInt(clamp(toeN, -1, 1), 0.02) * 0.02;
            shoulderN = qInt(clamp(shoulderN, -1, 1), 0.02) * 0.02;
            midN = qInt(clamp(midN, -1, 1), 0.02) * 0.02;
            contrast = qInt(clamp(contrast, 0.5, 2.0), 0.01) * 0.01;
            bright = qInt(clamp(bright, -50, 50), 0.2) * 0.2;
            gain = qInt(clamp(gain, 0.7, 8.0), 0.02) * 0.02;

            const key = `${steps}|${toeN}|${shoulderN}|${midN}|${bright}|${contrast}|${gain}`;
            const hit = toneCache.get(key);
            if (hit) return hit;

            // [New] If everything is strictly neutral, return flat identity
            if (toeN === 0 && shoulderN === 0 && midN === 0 && bright === 0 && contrast === 1 && Math.abs(gain - 1) < 0.01) {
                const res0 = '0 1';
                toneCache.set(key, res0);
                return res0;
            }

            const br = (bright / 1000);
            const con = contrast;
            const toeEnd = 0.34 + toeN * 0.06;
            const toeAmt = Math.abs(toeN);
            const toeSign = toeN >= 0 ? 1 : -1;
            const shoulderStart = 0.90 - shoulderN * 0.10;
            const shAmt = Math.abs(shoulderN);

            // [New] Log-based Gain Curve to ensure Gain=1.0 is linear
            const ev = Math.log2(Math.max(1e-6, gain));
            const g = ev * 0.90;
            const denom = 1 - Math.exp(-g);

            const out = new Array(steps);
            let prev = 0;

            for (let i = 0; i < steps; i++) {
                const x0 = i / (steps - 1);

                // Gain Curve
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
                const clipStart = 0.92;
                if (y > clipStart) {
                    const tt = (y - clipStart) / (1 - clipStart);
                    const ww = tt * tt * (3 - 2 * tt);
                    const k = (0.45 + 0.55 * shAmt); // Highlight Compression
                    y = clamp(clipStart + (y - clipStart) * (1 - ww * k), 0, 1);
                }
                if (y < prev) y = prev;
                prev = y;
                const yy = Math.round(y * 100000) / 100000;
                out[i] = (yy === 1 ? '1' : yy === 0 ? '0' : String(yy));
            }
            const res = out.join(' ');
            toneCache.set(key, res);
            return res;
        }

        const pickToneSteps = (tier, ditherOn) => (tier >= 2) ? (ditherOn ? 64 : 96) : (tier === 1 ? (ditherOn ? 96 : 128) : (ditherOn ? 128 : 192));
        const downgradeForTier = (s, kind, tier) => {
            if (tier <= 0) return s;
            const out = { ...s };
            if (kind === 'video') {
                if (tier >= 1) { out.sharp2 *= 0.35; out.clarity *= 0.50; out.dither *= 0.75; }
                if (tier >= 2) {
                    out.sharp2 = 0; out.clarity = 0; out.dither = 0;
                    // [Refined] Don't kill base sharpness too much
                    out.sharp *= 0.92;
                }
            } else {
                if (tier >= 1) out.sharp *= 0.75; if (tier >= 2) out.sharp *= 0.55;
            }
            return out;
        };

        const buildSvg = (doc) => {
            const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
            const defs = h('defs', { ns: 'svg' }); svg.append(defs);

            const mkFilter = (suffix, withNoise, withDetail) => {
                const fid = `vsc-f-${config.VSC_ID}-${suffix}`;
                // [Fix] Expand bounds to prevent clipping at edges
                const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '-15%', y: '-15%', width: '130%', height: '130%' });
                const tone = h('feComponentTransfer', { ns: 'svg', result: 'tone' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'table', tableValues: '0 1' })));
                const gam = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'gam' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'gamma', amplitude: '1', exponent: '1', offset: '0' })));
                const tmp = h('feComponentTransfer', { ns: 'svg', in: 'gam', result: 'tmp' }, ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', type: 'linear', slope: '1', intercept: '0' })));
                filter.append(tone, gam, tmp);

                let last = 'tmp';
                const sat = h('feColorMatrix', { ns: 'svg', in: last, type: 'saturate', values: '1', result: 'sat' });
                filter.append(sat);
                last = 'sat';

                let lum, lumB1, lumHP1, shAdd1, lumB2, lumHP2, shAdd2, lumBC, lumHPC, clAdd;
                if (withDetail) {
                    lum = h('feColorMatrix', {
                        ns: 'svg', in: last, type: 'matrix',
                        values: '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0', result: 'lum'
                    });
                    // Stage 1
                    lumB1 = h('feGaussianBlur', { ns: 'svg', in: 'lum', stdDeviation: '0', result: 'lumB1' });
                    lumHP1 = h('feComposite', { ns: 'svg', in: 'lum', in2: 'lumB1', operator: 'arithmetic', k2: '1', k3: '-1', k4: '0', result: 'lumHP1' });
                    shAdd1 = h('feComposite', { ns: 'svg', in: last, in2: 'lumHP1', operator: 'arithmetic', k2: '1', k3: '0', k4: '0', result: 'sh1' });
                    // Stage 2
                    lumB2 = h('feGaussianBlur', { ns: 'svg', in: 'lum', stdDeviation: '0', result: 'lumB2' });
                    lumHP2 = h('feComposite', { ns: 'svg', in: 'lum', in2: 'lumB2', operator: 'arithmetic', k2: '1', k3: '-1', k4: '0', result: 'lumHP2' });
                    shAdd2 = h('feComposite', { ns: 'svg', in: 'sh1', in2: 'lumHP2', operator: 'arithmetic', k2: '1', k3: '0', k4: '0', result: 'sh2' });
                    // Stage 3
                    lumBC = h('feGaussianBlur', { ns: 'svg', in: 'lum', stdDeviation: '0', result: 'lumBC' });
                    lumHPC = h('feComposite', { ns: 'svg', in: 'lum', in2: 'lumBC', operator: 'arithmetic', k2: '1', k3: '-1', k4: '0', result: 'lumHPC' });
                    clAdd = h('feComposite', { ns: 'svg', in: 'sh2', in2: 'lumHPC', operator: 'arithmetic', k2: '1', k3: '0', k4: '0', result: 'cl' });

                    filter.append(lum, lumB1, lumHP1, shAdd1, lumB2, lumHP2, shAdd2, lumBC, lumHPC, clAdd);
                    last = 'cl';
                }

                let feComp = null;
                if (withNoise) {
                    const feImg = h('feImage', { ns: 'svg', href: getNoiseUrl(), preserveAspectRatio: 'none', result: 'noiseImg' });
                    const feTile = h('feTile', { ns: 'svg', in: 'noiseImg', result: 'noise' });
                    feComp = h('feComposite', { ns: 'svg', in: last, in2: 'noise', operator: 'arithmetic', k1: '0', k2: '1', k3: '0.02', k4: '-0.01', result: 'grain' });
                    filter.append(feImg, feTile, feComp);
                }
                defs.append(filter);
                return {
                    fid, withDetail, withNoise: !!withNoise,
                    toneFuncs: Array.from(tone.children), gamFuncs: Array.from(gam.children), tmpFuncs: Array.from(tmp.children),
                    sat, lum, lumB1, lumHP1, shAdd1, lumB2, lumHP2, shAdd2, lumBC, lumHPC, clAdd, feComp,
                    st: { toneKey: '', toneTable: '', gammaKey: '', tempKey: '', satKey: '', detailKey: '', noiseKey: '', __b1: '', __b2: '', __bc: '', __kSharp: '', __kSharp2: '', __kClar: '' }
                };
            };

            // [Lazy] Container for lazy creation
            const ctx = {
                defs,
                video: { B: { O: null, N: null }, D: { O: null, N: null } },
                image: { B: { O: null, N: null }, D: { O: null, N: null } }
            };

            const ensureNodes = (kind, needDetail, ditherOn) => {
                const g = ctx[kind][needDetail ? 'D' : 'B'];
                const key = ditherOn ? 'N' : 'O';
                if (g[key]) return g[key];
                const suffix = `${kind[0]}-${needDetail ? 'd' : 'b'}-${ditherOn ? 'N' : '0'}`;
                g[key] = mkFilter(suffix, ditherOn, needDetail);
                return g[key];
            };

            const tryAppend = () => { const r = doc.documentElement || doc.body; if (r) { r.appendChild(svg); return true; } return false; };
            if (!tryAppend()) { const t = setInterval(() => { if (tryAppend()) clearInterval(t); }, 50); setTimeout(() => clearInterval(t), 3000); }
            return { ensureNodes };
        };

        const updateTone = (nodes, sEff, tier) => {
            const st = nodes.st;
            const toeN = clamp((sEff.toe || 0) / 14, -1, 1);
            const shN = clamp((sEff.shoulder || 0) / 16, -1, 1);
            const midN = clamp((sEff.mid || 0), -1, 1);
            const ditherOn = (sEff.dither || 0) > 0;
            const steps = pickToneSteps(tier, ditherOn);
            const toneKey = `${steps}|${toeN.toFixed(3)}|${shN.toFixed(3)}|${midN.toFixed(3)}|${(sEff.bright || 0).toFixed(2)}|${(sEff.contrast || 1).toFixed(3)}|${(sEff.gain || 1).toFixed(3)}`;
            if (st.toneKey !== toneKey) {
                st.toneKey = toneKey;
                const table = getToneTableCached3(steps, toeN, shN, midN, sEff.bright || 0, sEff.contrast || 1, sEff.gain || 1);
                if (st.toneTable !== table) { st.toneTable = table; for (const fn of nodes.toneFuncs) fn.setAttribute('tableValues', table); }
            }
        };

        const updateDetail = (nodes, sEff) => {
            if (!nodes.withDetail) return;
            const st = nodes.st;

            // [Refined] Split Base/HF Protection
            const g = clamp(sEff.gain || 1, 1, 8);
            const sh = clamp((sEff.shoulder || 0) / 16, 0, 1);
            const hiProtect = clamp((g - 1) / 3.8 + sh * 0.75, 0, 1);

            const scaleBase = 1 - hiProtect * 0.28;
            const scaleHF = 1 - hiProtect * 0.60;

            const sharpAdj = (sEff.sharp || 0) * scaleBase;
            const sharp2Adj = (sEff.sharp2 || 0) * scaleHF;
            const clarAdj = (sEff.clarity || 0) * (1 - hiProtect * 0.45);

            const detailKey = `${sharpAdj.toFixed(2)}|${sharp2Adj.toFixed(2)}|${clarAdj.toFixed(2)}`;
            if (st.detailKey === detailKey) return;
            st.detailKey = detailKey;

            const r1 = sharpAdj > 0 ? (1.10 + (sharpAdj / 50) * 0.60) : 0;
            const r2 = sharp2Adj > 0 ? (0.60 + (sharp2Adj / 50) * 0.40) : 0;
            const rc = clarAdj > 0 ? (2.20 + (clarAdj / 50) * 1.00) : 0;

            const k1 = sharpAdj > 0 ? (sharpAdj / 50) * 1.50 : 0;
            const k2 = sharp2Adj > 0 ? (sharp2Adj / 50) * 1.20 : 0;

            // [Fix] ReferenceError: clarity is not defined -> Use clarAdj
            const kc = clarAdj > 0 ? (clarAdj / 50) * 0.50 : 0;

            setAttr(nodes.lumB1, 'stdDeviation', r1 ? r1.toFixed(2) : '0', st, '__b1');
            setAttr(nodes.shAdd1, 'k3', k1 ? k1.toFixed(3) : '0', st, '__kSharp');
            setAttr(nodes.lumB2, 'stdDeviation', r2 ? r2.toFixed(2) : '0', st, '__b2');
            setAttr(nodes.shAdd2, 'k3', k2 ? k2.toFixed(3) : '0', st, '__kSharp2');
            setAttr(nodes.lumBC, 'stdDeviation', rc ? rc.toFixed(2) : '0', st, '__bc');
            setAttr(nodes.clAdd, 'k3', kc ? kc.toFixed(3) : '0', st, '__kClar');
        };

        const updateOthers = (nodes, sEff) => {
            const st = nodes.st;
            const invG = 1 / clamp(sEff.gamma || 1, 0.2, 3);
            const gk = invG.toFixed(4);
            if (st.gammaKey !== gk) { st.gammaKey = gk; for (const fn of nodes.gamFuncs) fn.setAttribute('exponent', gk); }
            setAttr(nodes.sat, 'values', clamp(sEff.satF ?? 1, 0, 2.5).toFixed(2), st, 'satKey');
            const t = clamp(sEff.temp || 0, -25, 25);
            let rs = 1, gs = 1, bs = 1;
            if (t > 0) { rs = 1 + t * 0.012; gs = 1 + t * 0.003; bs = 1 - t * 0.01; }
            else { const k = -t; bs = 1 + k * 0.012; gs = 1 + k * 0.003; rs = 1 - k * 0.01; }
            const tk = `${rs.toFixed(3)}|${gs.toFixed(3)}|${bs.toFixed(3)}`;
            if (st.tempKey !== tk) { st.tempKey = tk; nodes.tmpFuncs[0].setAttribute('slope', rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', bs.toFixed(3)); }
            if (nodes.withNoise && nodes.feComp) {
                const amt = clamp((sEff.dither || 0) / 100, 0, 1);
                const k3 = (amt * 0.04).toFixed(4);
                const k4 = (-0.5 * amt * 0.04).toFixed(4);
                const nk = `${k3}|${k4}`;
                if (st.noiseKey !== nk) { st.noiseKey = nk; nodes.feComp.setAttribute('k3', k3); nodes.feComp.setAttribute('k4', k4); }
            }
        };

        function prepare(doc, s, kind, tier = 0) {
            let ctx = ctxMap.get(doc);
            if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
            const sEff = downgradeForTier(s, kind, tier);
            const ditherOn = (sEff.dither || 0) > 0;
            const needDetail = (sEff.sharp > 0.001) || (sEff.sharp2 > 0.001) || (sEff.clarity > 0.001);
            // [Lazy] Generate node on demand
            const nodes = ctx.ensureNodes(kind, needDetail, ditherOn);
            updateTone(nodes, sEff, tier);
            updateDetail(nodes, sEff);
            updateOthers(nodes, sEff);
            return `url(#${nodes.fid})`;
        }

        const prepareCached = (doc, s, kind, tier = 0) => {
            const lru = getPrepLRU(doc, kind);
            const key = makePrepKey(kind, s, tier);
            const hit = lru.get(key);
            if (hit) return hit;
            let url = '';
            try { url = prepare(doc, s, kind, tier); } catch (_) { url = ''; }
            lru.set(key, url);
            return url;
        };

        return {
            prepare, prepareCached,
            applyUrl: (el, url) => { if (el.style.filter !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); } },
            clear: (el) => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); }
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
            self.postMessage({
                token,
                p10: pctFromHist(histAll, nAll, 0.10), p35: pctFromHist(histAll, nAll, 0.35), p50: pctFromHist(histAll, nAll, 0.50), p60: pctFromHist(histAll, nAll, 0.60), p90: pctFromHist(histAll, nAll, 0.90), p95: pctFromHist(histAll, nAll, 0.95), p98: pctFromHist(histAll, nAll, 0.98),
                avgLuma: avgAll/255, stdDev: stdAll, cf: cfAll, clipFrac: nAll ? (clipAll/nAll) : 0,
                p10T: pctFromHist(histTop, nTop || 1, 0.10), p35T: pctFromHist(histTop, nTop || 1, 0.35), p50T: pctFromHist(histTop, nTop || 1, 0.50), p60T: pctFromHist(histTop, nTop || 1, 0.60), p90T: pctFromHist(histTop, nTop || 1, 0.90), p95T: pctFromHist(histTop, nTop || 1, 0.95), p98T: pctFromHist(histTop, nTop || 1, 0.98),
                stdDevT: stdTop, cfT: cfTop, clipFracBottom: botN ? (clipBottom/botN) : 0, botAvg, botStd, redDominance
            });
        };
    `;

    function createAE(sm, { IS_MOBILE, Utils }, onAE) {
        let worker, canvas, ctx2d, activeVideo = null, isRunning = false, workerBusy = false, targetToken = 0;
        let lastStats = { p10: -1, p35: -1, p50: -1, p60: -1, p90: -1, p95: -1, p98: -1, clipFrac: 0, cf: 0.5, std: 0, rd: 0 };
        let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0, curGain = 1.0;
        let evAggressiveUntil = 0, useRVFC = false, rvfcToken = 0, __prevFrame = null, __motion01 = 1;
        let pausedTimer = 0;
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

        const computeTargetEV = (stats, cfg) => {
            const p35 = clamp(stats.p35 ?? stats.p50, 0.01, 0.99), p50 = clamp(stats.p50, 0.01, 0.99), p60 = clamp(stats.p60 ?? stats.p50, 0.01, 0.99), p98 = clamp(stats.p98, 0.01, 0.999), p95 = clamp(stats.p95 ?? stats.p90, 0.01, 0.999);
            const skinBias = clamp(((stats.rd || 0) - 0.05) / 0.10, 0, 1);
            const key = clamp(p50 * (0.6 - 0.12 * skinBias) + p35 * (0.3 + 0.1 * skinBias) + p60 * (0.1 + 0.02 * skinBias), 0.01, 0.99);

            let targetMid = cfg.TARGET_MID_BASE; if (p50 < 0.12) targetMid += 0.04;

            // [New] highlight-aware targetMid (reduce white veil)
            const hiR0 = clamp((stats.p95 - 0.88) / 0.10, 0, 1);
            const hiR1 = clamp((stats.p98 - 0.96) / 0.03, 0, 1);
            const clip0 = clamp((stats.clipFrac ?? 0) / (cfg.CLIP_FRAC_LIMIT * 3.5), 0, 1);
            targetMid -= 0.020 * hiR0;
            targetMid -= 0.015 * hiR1;
            targetMid -= 0.015 * clip0;
            targetMid = clamp(targetMid, 0.20, 0.34);

            let ev = Math.log2(targetMid / key) * cfg.STRENGTH;
            const hiRisk = clamp((clamp(stats.p90, 0, 1) - 0.84) / 0.12, 0, 1);
            const maxSafeEV = Math.log2(Math.max(1, Math.min(0.985 / p98, 0.98 / p95))) - (0.08 * hiRisk);
            const clip = clamp((stats.clipFrac ?? 0) / (cfg.CLIP_FRAC_LIMIT * 2.5), 0, 1);
            const upCapExtra = (1 - clip) * 1.0;
            const upCap = cfg.MAX_UP_EV * (0.55 + 0.45 * upCapExtra);
            ev = clamp(ev, cfg.MAX_DOWN_EV, upCap);
            return Math.min(ev, maxSafeEV);
        };

        const processResult = (data) => {
            if (!data || data.token !== targetToken) return;
            const cfg = getCfg(); const now = performance.now();
            const uiBar = (data.botAvg > 0.2 && data.botStd < 0.06) || (data.clipFracBottom > (cfg.CLIP_FRAC_LIMIT * 4) && data.botStd < 0.04);
            const subLikely = (data.clipFracBottom > cfg.CLIP_FRAC_LIMIT * 2) && data.p98 > 0.97 && data.p50 < 0.22 && data.stdDev > 0.06 && data.botStd > 0.045 && !uiBar;
            const stats = {
                p10: subLikely ? data.p10T : data.p10, p35: subLikely ? data.p35T : data.p35, p50: subLikely ? data.p50T : data.p50, p60: subLikely ? data.p60T : data.p60,
                p90: subLikely ? data.p90T : data.p90, p95: subLikely ? data.p95T : data.p95, p98: subLikely ? data.p98T : data.p98,
                clipFrac: data.clipFrac, cf: subLikely ? (data.cfT ?? data.cf) : data.cf, std: subLikely ? data.stdDevT : data.stdDev, rd: data.redDominance
            };

            const dt = Math.min(now - lastEmaT, 500); lastEmaT = now;
            const tauStats = clamp((activeVideo?.paused ? 360 : cfg.DT_CAP_MS) + (1 - __motion01) * 180, 180, 650);
            const a = 1 - Math.exp(-dt / tauStats);
            for (const k of Object.keys(lastStats)) { const v = stats[k]; if (Number.isFinite(v)) lastStats[k] = lastStats[k] < 0 ? v : v * a + lastStats[k] * (1 - a); }

            if (lastLuma >= 0) {
                const dl = Math.abs(data.avgLuma - lastLuma);
                const cf = clamp(lastStats.cf || 0.5, 0, 1);
                const thr = (0.055 - 0.020 * (1 - cf)) * (__motion01 < 0.08 ? 1.0 : 0.55);
                if (dl > thr) evAggressiveUntil = now + (__motion01 < 0.08 ? 900 : 450);
            }
            lastLuma = data.avgLuma;

            let targetEV = computeTargetEV(lastStats, cfg); if (subLikely) targetEV *= 0.85;
            if (Math.abs(targetEV) < cfg.DEAD_IN) targetEV = 0;

            const clip01 = clamp((lastStats.clipFrac - cfg.CLIP_FRAC_LIMIT) / (cfg.CLIP_FRAC_LIMIT * 4.0), 0, 1);
            const clipHard = clamp((lastStats.clipFrac - cfg.CLIP_FRAC_LIMIT) / (cfg.CLIP_FRAC_LIMIT * 3.0), 0, 1);

            const hiR = clamp(Math.max((lastStats.p95 - 0.88) / 0.10, (lastStats.p90 - 0.86) / 0.10), 0, 1);
            if (hiR > 0.5 || clipHard > 0.5) targetEV *= (1 - 0.20 * hiR) * (1 - 0.18 * clipHard);

            const dtA = Math.min(now - lastApplyT, cfg.DT_CAP_MS); lastApplyT = now;
            const baseTau = (now < evAggressiveUntil) ? cfg.TAU_AGGRESSIVE : (targetEV > Math.log2(curGain) ? cfg.TAU_UP : cfg.TAU_DOWN);
            const tauClip = baseTau * (1 + clip01 * 0.9);
            const alphaA = 1 - Math.exp(-dtA / tauClip);
            curGain = Math.pow(2, Math.log2(curGain) + (targetEV - Math.log2(curGain)) * alphaA);

            const smth = (t) => t * t * (3 - 2 * t);
            const ev01 = clamp(Math.log2(curGain) / 1.55, 0, 1);
            const p50 = clamp(lastStats.p50, 0, 1), p10 = clamp(lastStats.p10, 0, 1), p90 = clamp(lastStats.p90, 0, 1);
            const skin01 = clamp(((lastStats.rd || 0) - 0.05) / 0.08, 0, 1);
            const sceneContrast = clamp(p90 - p10, 0, 1);
            const flat01 = smth(clamp((0.44 - sceneContrast) / 0.24, 0, 1));
            const lowKey01 = smth(clamp((0.22 - p50) / 0.14, 0, 1));
            const animeLike = (flat01 > 0.62 && lastStats.cf > 0.55 && hiR < 0.55);

            let br = ev01 * 6.0 * clamp(0.52 - p50, -0.20, 0.20);
            br *= (1 - clip01 * 0.85); br += skin01 * lowKey01 * 0.8; br = clamp(br, -8.0, 8.0);

            let conF = 1 + ev01 * 0.035 * flat01 * (1 - hiR * 0.75) * (1 - skin01 * 0.18);
            conF = clamp(conF, 0.92, 1.10);

            let satBoost01 = smth(clamp((0.26 - (lastStats.cf || 0.5)) / 0.18, 0, 1));
            let satF = 1 + satBoost01 * 0.38 * (1 - hiR * 0.70) * (1 - skin01 * 0.30);
            const skinLowKey = skin01 * lowKey01;
            satF *= (1 - skinLowKey * 0.10);
            satF = clamp(satF, cfg.SAT_MIN, cfg.SAT_MAX);

            const midBias = clamp((0.50 - p50) / 0.22, -1, 1);
            let mid = (ev01 * 0.65) * midBias;
            mid += skin01 * 0.22 * (1 - hiR); mid -= clip01 * 0.18; mid = clamp(mid, -0.85, 0.85);

            let toe = (4.0 + 7.0 * ev01) * lowKey01;
            toe *= (1 - hiR * 0.65); toe *= (1 - clip01 * 0.45); toe *= (0.80 + 0.35 * skin01); toe = clamp(toe, 0, 9.0);

            let shoulder = (6.0 + 7.0 * ev01) * hiR;
            shoulder += 3.0 * clip01; shoulder *= (1 - skin01 * 0.10); shoulder = clamp(shoulder, 0, 12.0);

            const L = getLook();
            br *= L.brMul; satF = 1 + ((satF - 1) * L.satMul); conF = clamp(conF + L.conAdd, 0.90, 1.12);
            mid *= L.midMul; toe *= L.toeMul; shoulder *= L.shMul;

            const profile = sm.get(P.V_AE_PROFILE) || 'balanced';
            const tonePreset = sm.get(P.V_TONE_PRE) || null;
            const toneStr = tonePreset ? clamp(sm.get(P.V_TONE_STR) ?? 1.0, 0, 1) : 0;

            if (profile === 'bright') {
                const k = 0.22 + 0.28 * hiR + 0.20 * clipHard;
                br *= (1 - k);
                shoulder *= (1 - (0.24 + 0.32 * clipHard) * (0.6 + 0.4 * hiR));
            }
            if (tonePreset === 'highlight' && toneStr > 0) {
                const k = (0.18 + 0.22 * hiR + 0.18 * clipHard) * toneStr;
                br *= (1 - k);
                shoulder *= (1 - (0.28 + 0.30 * clipHard) * toneStr);
                conF = clamp(conF - 0.010 * toneStr, 0.90, 1.10);
            }
            if (tonePreset === 'redSkin' && toneStr > 0) {
                const skinSatCap = 1.00 + 0.07 * (1 - toneStr);
                if (skin01 > 0.45) satF = Math.min(satF, skinSatCap);
                if (profile !== 'cinematic' && skin01 > 0.35 && hiR < 0.45) br *= (1 - 0.10 * toneStr);
            }
            if (animeLike) {
                satF = Math.min(satF, profile === 'bright' ? 1.08 : 1.06);
                conF = clamp(conF, 0.95, 1.07);
            }

            shoulder *= (1 - 0.30 * hiR) * (1 - 0.22 * clip01);

            br = clamp(br, -14.0, 14.0);
            satF = clamp(satF, cfg.SAT_MIN, cfg.SAT_MAX);
            mid = clamp(mid, -0.95, 0.95);
            toe = clamp(toe, 0, 14.0);
            shoulder = clamp(shoulder, 0, 16.0);

            onAE?.({ gain: curGain, gammaF: 1, conF, satF, mid, toe, shoulder, brightAdd: br, tempAdd: 0, hiRisk: hiR, cf: lastStats.cf, luma: data.avgLuma * 100, clipFrac: lastStats.clipFrac, rd: lastStats.rd });
        };

        const _motionFromFrame = (rgba) => {
            const step = IS_LOW_END ? 32 : 16;
            if (!__prevFrame) {
                __prevFrame = new Uint8Array(Math.ceil(rgba.length / (4 * step)));
                let j = 0; for (let i = 0; i < rgba.length; i += 4 * step) { const y = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0; __prevFrame[j++] = y; }
                __motion01 = 1; return;
            }
            let diff = 0, cnt = 0, j = 0;
            for (let i = 0; i < rgba.length && j < __prevFrame.length; i += 4 * step) {
                const y = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) | 0;
                diff += Math.abs(y - __prevFrame[j]); __prevFrame[j++] = y; cnt++;
            }
            const d = cnt ? (diff / cnt) : 0; __motion01 = Math.max(0, Math.min(1, d / 28));
        };

        const disableAEHard = () => { try { worker?.terminate(); } catch (_) { } worker = null; workerBusy = false; isRunning = false; targetToken++; if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (_) { } workerUrl = null; } try { sm.set(P.V_AE, false); } catch (e) { } };
        let workerUrl = null;
        const ensureWorker = () => {
            if (worker) return worker;
            if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
            worker = new Worker(workerUrl);
            worker.onmessage = (e) => { workerBusy = false; processResult(e.data); };
            worker.onerror = () => { workerBusy = false; disableAEHard(); };
            return worker;
        };

        const rvfcLoop = (token) => {
            if (!isRunning || token !== rvfcToken) return;
            const v = activeVideo;
            if (!v || !useRVFC) return;
            const now = performance.now();
            const minInterval = (v.paused ? 600 : (IS_LOW_END ? 120 : 90)) + (1 - __motion01) * 80;
            if (now - lastSampleT >= minInterval) sample(v);
            try { v.requestVideoFrameCallback(() => rvfcLoop(token)); } catch (e) { }
        };

        const sample = (v) => {
            if (!isRunning || !v || v[VSCX.tainted] || document.hidden) return;
            if (v.readyState < 2 || v[VSCX.visible] === false) return;
            const now = performance.now();
            const minInterval = (v.paused ? 600 : (IS_LOW_END ? 120 : 90)) + (1 - __motion01) * 80;
            if (now - lastSampleT < minInterval) return;
            lastSampleT = now;
            if (workerBusy) return;
            try {
                if (!canvas) { canvas = document.createElement('canvas'); canvas.width = canvas.height = IS_LOW_END ? 24 : 32; ctx2d = canvas.getContext('2d', { willReadFrequently: true, alpha: false }); }
                ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height);
                const d = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
                _motionFromFrame(d.data); workerBusy = true;
                ensureWorker().postMessage({ buf: d.data.buffer, width: canvas.width, height: canvas.height, step: canvas.width <= 24 ? 1 : 2, token: targetToken }, [d.data.buffer]);
            } catch (_) { workerBusy = false; v[VSCX.tainted] = true; }
        };

        const startPausedTimer = () => {
            if (pausedTimer) return;
            pausedTimer = setInterval(() => { if (!isRunning) return; const v = activeVideo; if (!v) return; if (v.paused) sample(v); }, 650);
        };
        const stopPausedTimer = () => { if (!pausedTimer) return; clearInterval(pausedTimer); pausedTimer = 0; };
        const tick = () => {
            if (!isRunning) return;
            const active = sm.get(P.APP_ACT) && sm.get(P.V_AE);
            if (!active || !activeVideo || !activeVideo.isConnected) { if (!useRVFC) setTimeout(tick, 800); return; }
            sample(activeVideo);
            if (!useRVFC) setTimeout(tick, 90);
        };

        return {
            setTarget: (v) => {
                if (v !== activeVideo) {
                    activeVideo = v; targetToken++; rvfcToken = targetToken;
                    workerBusy = false; __prevFrame = null; useRVFC = !!v?.requestVideoFrameCallback;
                    lastSampleT = 0;
                    if (isRunning && useRVFC && v) try { v.requestVideoFrameCallback(() => rvfcLoop(rvfcToken)); } catch (_) { }
                }
            },
            start: () => {
                ensureWorker();
                if (!isRunning) {
                    isRunning = true;
                    const now = performance.now();
                    lastApplyT = now; lastEmaT = now; lastSampleT = 0;
                    startPausedTimer();
                    if (useRVFC && activeVideo) try { activeVideo.requestVideoFrameCallback(() => rvfcLoop(rvfcToken)); } catch (_) { }
                    else tick();
                }
            },
            stop: () => {
                isRunning = false; stopPausedTimer();
                try { worker?.terminate(); } catch (_) { } worker = null;
                if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
                activeVideo = null; curGain = 1;
            },
            wake: () => { evAggressiveUntil = performance.now() + 1000; },
            userTweak: () => { lastStats = { p10: -1, p35: -1, p50: -1, p60: -1, p90: -1, p95: -1, p98: -1, clipFrac: 0, cf: 0.5, std: 0, rd: 0 }; lastEmaT = performance.now(); evAggressiveUntil = performance.now() + 700; }
        };
    }

    function createUI(sm, defaults, config, registry, scheduler, bus) {
        const { h } = Utils;
        let container, monitorEl, gearHost, gearBtn;
        let fadeTimer = 0;
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
            { l: '윤곽', k: P.V_SHARP, min: 0, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '디테일', k: P.V_SHARP2, min: 0, max: 50, s: 1, f: v => v.toFixed(0) },
            { l: '명료', k: P.V_CLARITY, min: 0, max: 50, s: 5, f: v => v.toFixed(0) },
            { l: '색온도', k: P.V_TEMP, min: -25, max: 25, s: 1, f: v => v.toFixed(0) },
            { l: '그레인', k: P.V_DITHER, min: 0, max: 100, s: 5, f: v => v.toFixed(0) },
            { l: '오디오', k: P.A_BST, min: 0, max: 12, s: 1, f: v => `+${v}dB` },
            { l: '톤 강도', k: P.V_TONE_STR, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) },
            { l: '프리셋 믹스', k: P.V_PRE_MIX, min: 0, max: 1, s: 0.05, f: v => v.toFixed(2) }
        ];

        const getUiRoot = () => {
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) {
                if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement;
                return fs;
            }
            return document.body || document.documentElement;
        };

        const fire = (affectsAE, wakeAE, forceApply = true) => { bus.signal({ affectsAE: !!affectsAE, wakeAE: !!wakeAE, forceApply: !!forceApply }); };

        const renderChoiceRow = (label, items, key) => {
            const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
            items.forEach(it => {
                const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.t);
                b.onclick = () => {
                    const cur = sm.get(key);
                    const def = (key === 'video.aeProfile') ? 'balanced' : 'neutral';
                    const next = (cur === it.v) ? def : it.v;
                    sm.set(key, next);
                    if (key === P.V_AE_PROFILE) { if (!sm.get(P.V_AE)) sm.set(P.V_AE, true); }
                    if (key === P.V_AE_PROFILE && next) {
                        const locked = !!sm.get(P.V_TONE_LOCK);
                        if (!locked) {
                            if (!sm.get(P.V_TONE_PRE)) {
                                const rec = (next === 'cinematic') ? 'highlight' : (next === 'bright' ? 'redSkin' : 'neutral');
                                sm.set(P.V_TONE_PRE, rec);
                            }
                            const curStr = sm.get(P.V_TONE_STR);
                            if (curStr == null || Math.abs(curStr - DEFAULTS.video.toneStrength) < 0.001) {
                                const s = (next === 'cinematic') ? 0.75 : (next === 'bright' ? 0.78 : 0.85);
                                sm.set(P.V_TONE_STR, s);
                            }
                        }
                    }
                    const isAeProfile = (key === P.V_AE_PROFILE);
                    const isTone = (key === P.V_TONE_PRE);
                    if (isAeProfile) fire(true, true, true);
                    else if (isTone) fire(true, true, true);
                    else fire(false, false, true);
                };
                sm.sub(key, v => b.classList.toggle('active', v === it.v));
                r.append(b);
            });
            return r;
        };

        const renderPresetRow = (label, items, key) => {
            const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
            items.forEach(it => {
                const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.l || it.txt);
                b.onclick = () => {
                    sm.set(key, it.l || it.txt);
                    if (key === P.V_TONE_PRE) sm.set(P.V_TONE_LOCK, true);
                    const affectsAE = (key === P.V_PRE_B);
                    fire(affectsAE, affectsAE, true);
                };
                sm.sub(key, v => b.classList.toggle('active', v === (it.l || it.txt)));
                r.append(b);
            });
            const off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF');
            off.onclick = () => {
                sm.set(key, key === P.V_PRE_B ? 'brOFF' : 'off');
                if (key === P.V_TONE_PRE) sm.set(P.V_TONE_LOCK, true);
                const affectsAE = (key === P.V_PRE_B);
                fire(affectsAE, affectsAE, true);
            };
            sm.sub(key, v => off.classList.toggle('active', v === 'off' || v === 'brOFF'));
            return r.append(off), r;
        };

        const renderSlider = (cfg) => {
            const valEl = h('span', { style: 'color:#3498db' }, '0');
            const inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
            const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
            sm.sub(cfg.k, update); update(sm.get(cfg.k));
            inp.oninput = () => { valEl.textContent = cfg.f(Number(inp.value)); sm.set(cfg.k, Number(inp.value)); };
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
                    h('button', { id: 'ae-btn', class: 'btn', onclick: () => { const n = !sm.get(P.V_AE); sm.set(P.V_AE, n); if (n) { if (!sm.get(P.V_AE_PROFILE)) sm.set(P.V_AE_PROFILE, 'balanced'); if (!sm.get(P.V_TONE_PRE)) sm.set(P.V_TONE_PRE, 'neutral'); } else { sm.set(P.V_AE_PROFILE, null); sm.set(P.V_TONE_PRE, null); } fire(true, true, true); } }, '🤖 자동'),
                    h('button', { id: 'boost-btn', class: 'btn', onclick: () => sm.set(P.A_EN, !sm.get(P.A_EN)) }, '🔊 부스트')
                ),
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => { sm.batch('video', { ...defaults.video, toneLocked: false }); sm.batch('audio', defaults.audio); fire(true, true, true); } }, '↺ 리셋'),
                    h('button', { id: 'pwr-btn', class: 'btn', onclick: () => sm.set(P.APP_ACT, !sm.get(P.APP_ACT)) }, '⚡ Power')
                ),
                renderChoiceRow('AE', [{ t: '표준', v: 'balanced' }, { t: '영화', v: 'cinematic' }, { t: '밝게', v: 'bright' }], P.V_AE_PROFILE),
                renderChoiceRow('톤', [{ t: '기본', v: 'neutral' }, { t: '피부', v: 'redSkin' }, { t: '조명', v: 'highlight' }], P.V_TONE_PRE),
                renderPresetRow('샤프', [{ l: 'S' }, { l: 'M' }, { l: 'L' }, { l: 'XL' }], P.V_PRE_S),
                renderPresetRow('밝기', [{ txt: 'S' }, { txt: 'M' }, { txt: 'L' }, { txt: 'DS' }, { txt: 'DM' }, { txt: 'DL' }], P.V_PRE_B),
                h('hr'), h('div', { class: 'grid' }, SLIDERS.map(renderSlider)), h('hr'),
                h('div', { class: 'prow', style: 'justify-content:center;gap:4px;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = () => sm.set(P.PB_RATE, s); sm.sub(P.PB_RATE, v => b.classList.toggle('active', Math.abs(v - s) < 0.01)); return b; }))
            ]);
            const bodyI = h('div', { id: 'p-i', style: 'display:none' }, [h('div', { class: 'grid' }, [renderSlider({ l: '이미지 윤곽', k: P.I_LVL, min: 0, max: 50, s: 1, f: v => v.toFixed(0) }), renderSlider({ l: '이미지 색온도', k: P.I_TMP, min: -20, max: 20, s: 1, f: v => v.toFixed(0) })])]);
            shadow.append(h('style', {}, style), h('div', { class: 'main' }, [h('div', { class: 'tabs' }, [h('button', { id: 't-v', class: 'tab active', onclick: () => sm.set(P.APP_TAB, 'video') }, 'VIDEO'), h('button', { id: 't-i', class: 'tab', onclick: () => sm.set(P.APP_TAB, 'image') }, 'IMAGE')]), bodyV, bodyI, monitorEl = h('div', { class: 'monitor' }, `Ready (${VERSION_STR})`)]));
            sm.sub(P.APP_TAB, v => { shadow.querySelector('#t-v').classList.toggle('active', v === 'video'); shadow.querySelector('#t-i').classList.toggle('active', v === 'image'); shadow.querySelector('#p-v').style.display = v === 'video' ? 'block' : 'none'; shadow.querySelector('#p-i').style.display = v === 'image' ? 'block' : 'none'; });
            sm.sub(P.V_AE, v => shadow.querySelector('#ae-btn').classList.toggle('active', !!v));
            sm.sub(P.A_EN, v => shadow.querySelector('#boost-btn').classList.toggle('active', !!v));
            sm.sub(P.APP_ACT, v => shadow.querySelector('#pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
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
                ${IS_MOBILE ? '.hint { display: none !important; }' : ''}
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
            sm.sub(P.APP_ACT, syncGear); sm.sub(P.APP_UI, syncGear); syncGear();
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

        // [Fix] Ensure UI mount after body exists (document-start safe)
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
            destroy: () => { detachNodesHard(); }
        };
    }

    // --- Main Execution ---
    const Utils = createUtils();
    const Scheduler = createScheduler();
    const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
    const Bus = createEventBus();

    const FEATURES = {
        active: () => Store.get(P.APP_ACT),
        images: () => {
            if (!Store.get(P.APP_ACT)) return false;
            if (Store.get(P.APP_TAB) === 'image') return true;
            return Store.get(P.I_LVL) !== DEFAULTS.image.level || Store.get(P.I_TMP) !== DEFAULTS.image.temp;
        },
        ae: () => Store.get(P.APP_ACT) && Store.get(P.V_AE),
        audio: () => Store.get(P.APP_ACT) && Store.get(P.A_EN)
    };

    const Registry = createRegistry(Scheduler, FEATURES, { IS_LOW_END });

    // [Fix] document-start body race: ensure observers once body exists
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

    const Filters = createFilters(Utils, { VSC_ID });
    const Audio = createAudio(Store);
    const UI = createUI(Store, DEFAULTS, { IS_TOP }, Registry, Scheduler, Bus);

    UI.ensure();
    Store.sub(P.APP_UI, (v) => { UI.ensure(); Scheduler.request(true); });

    let currentAE = { gain: 1.0, gammaF: 1.0, conF: 1.0, satF: 1.0, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5 };
    let aeRev = 0;

    const AE = createAE(Store, { IS_MOBILE, Utils }, (ae) => {
        const prev = currentAE;
        const changed = Math.abs((ae.gain ?? 1) - (prev.gain ?? 1)) > 0.015 || Math.abs((ae.brightAdd ?? 0) - (prev.brightAdd ?? 0)) > 0.35 || Math.abs((ae.tempAdd ?? 0) - (prev.tempAdd ?? 0)) > 0.35 || Math.abs((ae.gammaF ?? 1) - (prev.gammaF ?? 1)) > 0.012 || Math.abs((ae.conF ?? 1) - (prev.conF ?? 1)) > 0.012 || Math.abs((ae.satF ?? 1) - (prev.satF ?? 1)) > 0.010 || Math.abs((ae.toe ?? 0) - (prev.toe ?? 0)) > 0.5 || Math.abs((ae.shoulder ?? 0) - (prev.shoulder ?? 0)) > 0.5;
        currentAE = ae;
        if (changed) { aeRev++; Scheduler.request(false); }
    });

    Bus.on('signal', (s) => {
        if (s.affectsAE && FEATURES.ae()) AE.userTweak();
        if (s.wakeAE && FEATURES.ae()) AE.wake();
        if (s.forceApply) Scheduler.request(true);
    });

    let lastSRev = -1, lastRRev = -1, lastAeRev = -1;
    let lastPrune = 0;
    let __currentTarget = null, __currentScore = -1, __currentSince = 0;
    let __lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 };
    let __lastClickedVideo = null;
    let lastUiEnsureT = 0;

    window.addEventListener('pointerdown', (e) => {
        __lastUserPt = { x: e.clientX, y: e.clientY, t: performance.now() };
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const v = el?.closest?.('video');
        if (v) __lastClickedVideo = v;
    }, { passive: true });
    window.addEventListener('wheel', () => __lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }, { passive: true });
    window.addEventListener('keydown', (e) => { __lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }; }, { passive: true });

    // Helpers utilizing closure state
    const getRateState = (v) => { let st = v[VSCX.rateState]; if (!st) st = v[VSCX.rateState] = { orig: null, lastSetAt: 0 }; return st; };
    const restoreRateOne = (el) => { try { const st = el[VSCX.rateState]; if (st?.orig != null) el.playbackRate = st.orig; } catch (_) { } if (el[VSCX.rateState]) el[VSCX.rateState].orig = null; };
    const bindVideoOnce = (v) => {
        if (v[VSCX.bound]) return; v[VSCX.bound] = true;
        v.addEventListener('seeking', () => Bus.signal({ wakeAE: true }), { passive: true });
        v.addEventListener('play', () => Bus.signal({ wakeAE: true }), { passive: true });
        v.addEventListener('ratechange', () => {
            const st = getRateState(v); const now = performance.now();
            if (now - st.lastSetAt < 90) return;
            const cur = v.playbackRate;
            if (Number.isFinite(cur) && cur > 0) Store.set(P.PB_RATE, cur);
        }, { passive: true });
    };

    const applyVideoFilters = (visibleVideos, dirtyVideos, vVals, activeFx, tier) => {
        for (const el of dirtyVideos) { if (!el || el.tagName !== 'VIDEO') continue; if (!activeFx || el[VSCX.visible] === false) try { Filters.clear(el); } catch (_) { } }
        if (!activeFx) return;
        let lastDoc = null, url = null;
        for (const el of visibleVideos) {
            if (!el || el.tagName !== 'VIDEO') continue; if (el[VSCX.visible] === false) continue;
            const doc = el.ownerDocument || document;
            if (doc !== lastDoc) {
                lastDoc = doc;
                url = Filters.prepareCached(doc, vVals, 'video', tier);
            }
            Filters.applyUrl(el, url);
            touchedAddLimited(TOUCHED.videos, el);
            bindVideoOnce(el);
        }
    };

    const applyImageFilters = (visibleImages, dirtyImages, iVals, activeFx) => {
        for (const el of dirtyImages) { if (!el || el.tagName !== 'IMG') continue; if (!activeFx || el[VSCX.visible] === false) try { Filters.clear(el); } catch (_) { } }
        if (!activeFx) return;
        let lastDoc = null, url = null;
        for (const el of visibleImages) {
            if (!el || el.tagName !== 'IMG') continue; if (el[VSCX.visible] === false) continue;
            const doc = el.ownerDocument || document;
            if (doc !== lastDoc) {
                lastDoc = doc;
                url = Filters.prepareCached(doc, iVals, 'image', 0);
            }
            Filters.applyUrl(el, url);
            touchedAddLimited(TOUCHED.images, el);
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

    const cleanupAllTouched = () => {
        for (const v of TOUCHED.videos) { try { Filters.clear(v); } catch (e) { } try { const st = v[VSCX.rateState]; if (st?.orig != null) v.playbackRate = st.orig; } catch (e) { } }
        for (const i of TOUCHED.images) try { Filters.clear(i); } catch (e) { }
        TOUCHED.videos.clear(); TOUCHED.images.clear();
    };

    Scheduler.registerApply((force) => {
        try {
            const app = Store.getCat('app');
            const active = !!app.active;
            if (!active) { cleanupAllTouched(); Audio.update(); AE.stop?.(); return; }

            const sRev = Store.rev(), rRev = Registry.rev();
            const prevRRev = lastRRev;
            if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev) return;
            lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev;

            const now = performance.now();
            if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }

            const vf = Store.getCat('video'), img = Store.getCat('image');
            const wantImages = FEATURES.images(), wantAE = FEATURES.ae(), wantAudio = FEATURES.audio();
            const { visible } = Registry;
            const dirty = Registry.consumeDirty();
            const vidsDirty = dirty.videos;
            const imgsVisible = visible.images, imgsDirty = dirty.images;

            const target = pickBestVideo(visible.videos);
            if (!target) {
                if (wantAE) AE.stop?.();
                Audio.setTarget(null);
            } else {
                if (wantAE) { AE.setTarget(target); AE.start(); }
                const keepBypass = Audio.hasCtx?.() || Audio.isHooked?.();
                if (wantAudio || keepBypass) Audio.setTarget(target); else Audio.setTarget(null);
            }
            Audio.update();

            const aeOutRaw = wantAE ? currentAE : null;
            const { expMix, toneMix } = computeAeMix2(vf, Utils);
            const mixLog2 = (g, t) => Math.pow(2, Math.log2(Math.max(1e-6, g)) * t);

            let aeOut = aeOutRaw ? {
                ...aeOutRaw,
                gain: mixLog2(aeOutRaw.gain ?? 1, expMix),
                brightAdd: (aeOutRaw.brightAdd ?? 0) * expMix,
                conF: 1 + ((aeOutRaw.conF ?? 1) - 1) * toneMix,
                satF: 1 + ((aeOutRaw.satF ?? 1) - 1) * toneMix,
                mid: (aeOutRaw.mid ?? 0) * toneMix,
                toe: (aeOutRaw.toe ?? 0) * toneMix,
                shoulder: (aeOutRaw.shoulder ?? 0) * toneMix,
            } : null;

            const toneStr = vf.tonePreset ? Utils.clamp(vf.toneStrength ?? 1.0, 0, 1) : 0;
            if (aeOut && vf.tonePreset === 'highlight') {
                aeOut.shoulder *= (1 - 0.28 * toneStr);
                aeOut.brightAdd *= (1 - 0.18 * toneStr);
            }
            if (aeOut && vf.tonePreset === 'redSkin') {
                aeOut.satF = 1 + (aeOut.satF - 1) * (1 - 0.35 * toneStr);
            }

            const vVals = composeVideoParams(vf, aeOut, DEFAULTS.video, Utils);
            const iVals = {
                satF: 1.0, gain: 1.0, gamma: 1.0, contrast: 1.0, bright: 0,
                sharp: img.level, sharp2: 0, clarity: 0, dither: 0, temp: img.temp, toe: 0, shoulder: 0, mid: 0
            };

            const videoFxOn = active && !isNeutralVideoParams(vVals);

            if (app.uiVisible) {
                if (now - lastUiEnsureT > 450) { UI.ensure(); lastUiEnsureT = now; }
                if (wantAE) UI.update(`AE: ${vVals.gain.toFixed(2)}x L:${Math.round(currentAE.luma || 0)}% C:${((currentAE.clipFrac || 0) * 100).toFixed(1)}%`, true);
                else UI.update(`Ready (${VERSION_STR})`, false);
            }

            const applySet = buildApplySet(visible.videos, target);
            const tier = computeQualityTier({ IS_LOW_END, visibleCount: applySet.size, applyAll: CFG.applyToAllVisibleVideos });

            applyVideoFilters(applySet, vidsDirty, vVals, videoFxOn, tier);

            for (const v of Array.from(TOUCHED.videos)) {
                if (!v || !v.isConnected) { TOUCHED.videos.delete(v); continue; }
                const shouldHave = videoFxOn && applySet.has(v) && v[VSCX.visible] !== false;
                if (!shouldHave) { try { Filters.clear(v); } catch (_) { } TOUCHED.videos.delete(v); }
            }

            if (wantImages) applyImageFilters(imgsVisible, imgsDirty, iVals, active);
            else {
                for (const imgEl of Array.from(TOUCHED.images)) {
                    if (!imgEl || !imgEl.isConnected) { TOUCHED.images.delete(imgEl); continue; }
                    try { Filters.clear(imgEl); } catch (_) { }
                    TOUCHED.images.delete(imgEl);
                }
                applyImageFilters(new Set(), imgsDirty, iVals, false);
            }

            applyPlaybackRate(applySet, vidsDirty, Store.get(P.PB_RATE), active);

            if (force || rRev !== prevRRev || dirty.videos.size > 0 || dirty.images.size > 0) UI.ensure();
        } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch (_) { } }
    });

    let tickTimer = 0;
    const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT)) return; if (document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    const refreshTick = () => { if (FEATURES.ae() || FEATURES.audio()) startTick(); else stopTick(); };
    Store.sub(P.V_AE, refreshTick); Store.sub(P.A_EN, refreshTick); Store.sub(P.APP_ACT, refreshTick);
    refreshTick();

    Scheduler.request(true);
})();
