// ==UserScript==
// @name        Video_Image_Control (v132.0.99.23-FinalPerfect)
// @namespace   https://github.com/
// @version     132.0.99.23
// @description Base: v99.5.1 + Fixed AE Init + All Optimizations + AE Retune
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
    const VERSION_STR = "v132.0.99.23";

    const VSCX = Object.freeze({
        visible: Symbol('vsc.visible'),
        rect: Symbol('vsc.rect'),
        ir: Symbol('vsc.ir'),
        bound: Symbol('vsc.bound'),
        rateState: Symbol('vsc.rateState'),
        tainted: Symbol('vsc.tainted'),
        audioFail: Symbol('vsc.audioFail')
    });

    // ==============================
    // CONFIG CONSTANTS
    // ==============================
    const AE_COMMON = Object.freeze({
        P98_CLIP: 0.982, CLIP_FRAC_LIMIT: 0.0032,
        DEAD_OUT: 0.08, DEAD_IN: 0.035,
        LOWKEY_STDDEV: 0.22,
        TAU_UP: 1050, TAU_DOWN: 980, TAU_AGGRESSIVE: 220,
        SAT_MIN: 0.94, SAT_MAX: 1.06,
        V91_AECON_MIN: 0.88, V91_AECON_MAX: 1.30,
        V91_AEGAM_MIN: 0.55, V91_AEGAM_MAX: 2.30,
        TONE_BASE_SOFTEN: 1.0, DT_CAP_MS: 220, PLAYING_MAX_SKIP: 3,
        MAX_UP_EV_EXTRA: 0.32
    });

    const AE_DEVICE = Object.freeze({
        pc: { STRENGTH: 0.30, MAX_UP_EV: 0.20, MAX_DOWN_EV: -0.12, TARGET_MID_BASE: 0.29 },
        mobile: { STRENGTH: 0.24, MAX_UP_EV: 0.17, MAX_DOWN_EV: -0.11, TARGET_MID_BASE: 0.26 }
    });

    const AE_PROFILE_DELTA = Object.freeze({
        balanced: {},
        cinematic: {
            STRENGTH: -0.06, TARGET_MID_BASE: -0.03, MAX_UP_EV: -0.05, MAX_DOWN_EV: -0.02,
            TAU_UP: +260, TAU_DOWN: +240, TAU_AGGRESSIVE: +40,
            SAT_MAX: -0.03, SAT_MIN: +0.01, V91_AECON_MAX: -0.05, V91_AEGAM_MAX: -0.20
        },
        bright: {
            STRENGTH: +0.07, TARGET_MID_BASE: +0.04, MAX_UP_EV: +0.08, MAX_DOWN_EV: +0.03,
            TAU_UP: -260, TAU_DOWN: -160, TAU_AGGRESSIVE: -30,
            SAT_MAX: +0.04, SAT_MIN: -0.01, V91_AECON_MAX: +0.05, V91_AEGAM_MAX: +0.15
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

    const lerp = (a, b, t) => a + (b - a) * t;

    const TONE_PRESET = Object.freeze({
        neutral: { toe: 0.0, shoulder: 0.0, con: 1.00, sat: 1.00, gam: 1.00, br: 0.0, tmp: 0.0 },
        redSkin: { toe: 1.4, shoulder: 0.6, con: 1.03, sat: 1.05, gam: 1.02, br: 0.8, tmp: +2.0 },
        highlight: { toe: 0.4, shoulder: 2.6, con: 0.99, sat: 0.98, gam: 0.98, br: -0.2, tmp: -1.0 },
    });

    const WORKER_CODE = `
        const hist=new Uint32Array(256);
        self.onmessage=function(e){
            const {buf,width,height,step,token}=e.data||{};
            if(!buf||!width||!height)return;
            const data=new Uint8ClampedArray(buf);
            hist.fill(0);
            let sum=0,sumSq=0,n=0,clip=0,clipBottom=0,botSum=0,botSumSq=0,botN=0,rSum=0,gSum=0,bSum=0;
            const botY0=Math.floor(height*0.78), stride=width*4;
            for(let y=0;y<height;y+=step){
                const row=y*stride;
                for(let x=0;x<width;x+=step){
                    const i=row+x*4, r=data[i], g=data[i+1], b=data[i+2];
                    const Y=(0.2126*r+0.7152*g+0.0722*b)|0;
                    hist[Y]++; sum+=Y; sumSq+=Y*Y; n++;
                    rSum+=r; gSum+=g; bSum+=b;
                    if(Y>=251){ clip++; if(y>=botY0) clipBottom++; }
                    if(y>=botY0){ botSum+=Y; botSumSq+=Y*Y; botN++; }
                }
            }
            const avg=n?(sum/n):0, varv=n?(sumSq/n-avg*avg):0, stdDev=Math.sqrt(Math.max(0,varv))/255;
            const botAvg=botN?(botSum/botN)/255:0, botVar=botN?(botSumSq/botN-(botSum/botN)**2):0, botStd=Math.sqrt(Math.max(0,botVar))/255;
            const cf=Math.min(1,stdDev/0.22);
            const rgbSum=(rSum+gSum+bSum)||1, redDominance=Math.max(0,Math.min(1,(rSum/rgbSum)-0.28));
            const pct=(p)=>{ const t=n*p; let acc=0; for(let i=0;i<256;i++){ acc+=hist[i]; if(acc>=t) return i/255; } return 1; };
            const p10=pct(0.1), p35=pct(0.35), p50=pct(0.5), p60=pct(0.6), p90=pct(0.9), p95=pct(0.95), p98=pct(0.98);
            self.postMessage({
                token, p10, p35, p50, p60, p90, p95, p98, p98m:p98,
                avgLuma:avg/255, stdDev, cf, redDominance, clipFrac:n?(clip/n):0, clipFracBottom:botN?(clipBottom/botN):0, botAvg, botStd,
                p10T:p10, p50T:p50, p90T:p90, p95T:p95, p98T:p98, p98mT:p98, stdDevT:stdDev
            });
        };
    `;

    function getAeCfg(isMobile, profileName) {
        const dev = isMobile ? AE_DEVICE.mobile : AE_DEVICE.pc;
        const delta = AE_PROFILE_DELTA[profileName] || AE_PROFILE_DELTA.balanced;
        const out = { ...AE_COMMON, ...dev };
        const addRel = (k) => { if (delta[k] != null) out[k] = (out[k] ?? 0) + delta[k]; };

        ['STRENGTH', 'TARGET_MID_BASE', 'MAX_UP_EV', 'MAX_DOWN_EV', 'TAU_UP', 'TAU_DOWN', 'TAU_AGGRESSIVE', 'SAT_MIN', 'SAT_MAX', 'V91_AECON_MAX', 'V91_AEGAM_MAX'].forEach(addRel);

        out.STRENGTH = Math.max(0.12, Math.min(0.40, out.STRENGTH));
        out.TARGET_MID_BASE = Math.max(0.20, Math.min(0.38, out.TARGET_MID_BASE));
        out.MAX_UP_EV = Math.max(0.08, Math.min(0.32, out.MAX_UP_EV));
        out.MAX_DOWN_EV = Math.max(-0.22, Math.min(-0.04, out.MAX_DOWN_EV));
        out.SAT_MIN = Math.max(0.90, Math.min(1.00, out.SAT_MIN));
        out.SAT_MAX = Math.max(1.00, Math.min(1.18, out.SAT_MAX));
        out.TAU_UP = Math.max(180, Math.min(1400, out.TAU_UP));
        out.TAU_DOWN = Math.max(180, Math.min(1400, out.TAU_DOWN));
        out.TAU_AGGRESSIVE = Math.max(120, Math.min(600, out.TAU_AGGRESSIVE));
        out.V91_AECON_MAX = Math.max(1.15, Math.min(1.45, out.V91_AECON_MAX));
        out.V91_AEGAM_MAX = Math.max(1.80, Math.min(3.00, out.V91_AEGAM_MAX));
        return Object.freeze(out);
    }

    const DEFAULTS = {
        video: {
            gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
            temp: 0, sharp: 0, sharp2: 0, dither: 0, clarity: 0,
            ae: false, presetS: 'off', presetB: 'brOFF',
            presetMix: 1.0, aeProfile: null, tonePreset: null, toneStrength: 1.0
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
        V_GAMMA: 'video.gamma', V_CONTR: 'video.contrast', V_BRIGHT: 'video.bright',
        V_SAT: 'video.sat', V_SHARP: 'video.sharp', V_SHARP2: 'video.sharp2',
        V_CLARITY: 'video.clarity', V_TEMP: 'video.temp', V_DITHER: 'video.dither',
        V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix',
        A_EN: 'audio.enabled', A_BST: 'audio.boost',
        PB_RATE: 'playback.rate',
        I_LVL: 'image.level', I_TMP: 'image.temp'
    });

    const TOUCHED = { videos: new Set(), images: new Set() };

    // ==========================================
    // MODULES & CORE
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
    };

    const split2 = (p) => {
        const i = p.indexOf('.');
        return (i > 0) ? [p.slice(0, i), p.slice(i + 1)] : [p, ''];
    };

    const createSyncStore = (defaults, scheduler, config) => {
        let state = (typeof structuredClone === 'function') ? structuredClone(defaults) : JSON.parse(JSON.stringify(defaults));
        let rev = 0;
        const listeners = new Map();
        const IS_TOP = config.IS_TOP;
        const SYNC_HELLO = 'VSC_HELLO', SYNC_TYPE = 'VSC_SYNC';
        let SYNC_TOKEN = null;
        const peerTokens = IS_TOP ? new WeakMap() : null; // { tok, origin }
        const peers = IS_TOP ? new Set() : null;
        const isValidToken = (t) => (typeof t === 'string' && t.length >= 16);

        const PSL_CC_2LD = Object.freeze({
            kr: new Set(['co','or','go','ac','re','pe','ne']),
            jp: new Set(['co','or','ne','go','ac','ed','gr','lg']),
            uk: new Set(['co','org','gov','ac','net','sch']),
            nz: new Set(['co','org','gov','ac','net','geek']),
            au: new Set(['com','net','org','edu','gov','asn','id']),
            tw: new Set(['com','net','org','edu','gov','id']),
            cn: new Set(['com','net','org','gov','edu']),
        });
        const PSL_2LD = new Set(['co','com','net','org','gov','ac','edu']);
        const siteKey = (host) => {
            const p = String(host || '').toLowerCase().split('.').filter(Boolean);
            if (p.length <= 2) return p.join('.');
            const tld = p[p.length - 1], sld = p[p.length - 2];
            if (tld.length === 2) {
                const ccSet = PSL_CC_2LD[tld];
                const is2LD = ccSet ? ccSet.has(sld) : PSL_2LD.has(sld);
                if (is2LD && p.length >= 3) return p.slice(-3).join('.');
                return p.slice(-2).join('.');
            }
            return p.slice(-2).join('.');
        };
        const isSameSite = (origin) => {
            try {
                if (!origin || origin === 'null') return false;
                return siteKey(new URL(origin).hostname) === siteKey(location.hostname);
            } catch (_) { return false; }
        };

        const emit = (key, val) => {
            const a = listeners.get(key); if (a) for (const cb of a) cb(val);
            const cat = key.split('.')[0];
            const b = listeners.get(cat + '.*'); if (b) for (const cb of b) cb(val);
        };

        const safePost = (w, msg, targetOrigin = '*') => { try { w.postMessage(msg, targetOrigin); return true; } catch (_) { return false; } };

        const broadcastToPeers = (path, val, excludeSource = null) => {
            if (!IS_TOP) {
                if (!isValidToken(SYNC_TOKEN)) return;
                safePost(window.top, { type: SYNC_TYPE, token: SYNC_TOKEN, path, val }, '*');
                return;
            }
            const next = [];
            for (const w of peers) {
                if (!w || w === excludeSource) { if (w) next.push(w); continue; }
                const entry = peerTokens.get(w);
                const tok = entry?.tok;
                if (!isValidToken(tok)) continue;
                const org = entry?.origin || '*';
                if (safePost(w, { type: SYNC_TYPE, token: tok, path, val }, org)) next.push(w);
            }
            peers.clear();
            for (const w of next) peers.add(w);
        };

        if (!IS_TOP) safePost(window.top, { type: SYNC_HELLO, ask: 1 }, '*');

        window.addEventListener('message', (e) => {
            if (!isSameSite(e.origin)) return;
            const d = e.data;
            if (!d || !d.type) return;

            if (d.type === SYNC_HELLO) {
                if (IS_TOP && d.ask) {
                    const src = e.source;
                    if (!src || src === window) return;
                    let entry = peerTokens.get(src);
                    let tok = entry?.tok;
                    if (!isValidToken(tok)) {
                        tok = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
                        peerTokens.set(src, { tok, origin: e.origin });
                    } else if (!entry?.origin) {
                        peerTokens.set(src, { tok, origin: e.origin });
                    }
                    peers.add(src);
                    safePost(src, { type: SYNC_HELLO, token: tok }, e.origin);
                } else if (!IS_TOP && isValidToken(d.token)) {
                    if (e.source !== window.top) return;
                    SYNC_TOKEN = d.token;
                }
                return;
            }

            if (d.type === SYNC_TYPE) {
                const tokenOk = IS_TOP
                    ? (e.source && e.source !== window && peerTokens.get(e.source)?.tok === d.token)
                    : (e.source === window.top && d.token === SYNC_TOKEN);
                if (!tokenOk) return;
                if (typeof d.path !== 'string' || !d.path.includes('.')) return;

                const [cat, key] = split2(d.path);
                state[cat] ||= {};
                if (state[cat][key] === d.val) return;

                state[cat][key] = d.val;
                rev++;
                emit(d.path, d.val);
                scheduler.request(false);
                if (IS_TOP) broadcastToPeers(d.path, d.val, e.source);
            }
        });

        return {
            rev: () => rev,
            getCat: (cat) => (state[cat] ||= {}),
            get: (p) => { const [c,k] = split2(p); return state[c]?.[k]; },
            set: (path, val) => {
                const [cat, key] = split2(path);
                if(!key) return;
                state[cat] ||= {};
                if (state[cat][key] === val) return;
                state[cat][key] = val; rev++;
                emit(path, val);
                broadcastToPeers(path, val);
                scheduler.request(false);
            },
            batch: (cat, obj) => {
                state[cat] ||= {};
                let has = false;
                for (const [k, v] of Object.entries(obj)) {
                    if (state[cat][k] !== v) {
                        state[cat][k] = v;
                        emit(`${cat}.${k}`, v);
                        broadcastToPeers(`${cat}.${k}`, v);
                        has = true;
                    }
                }
                if (has) { rev++; scheduler.request(false); }
            },
            sub: (k, f) => {
                const a = listeners.get(k) || [];
                a.push(f); listeners.set(k, a);
                return () => {
                    const cur = listeners.get(k);
                    if (!cur) return;
                    const i = cur.indexOf(f);
                    if (i >= 0) cur.splice(i, 1);
                };
            }
        };
    };

    const createScanQueue = (processNode) => {
        const q = [];
        let head = 0, scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            const runner = (deadline) => {
                scheduled = false;
                const start = performance.now();
                const hasBudget = deadline?.timeRemaining ? () => deadline.timeRemaining() > 2 : () => (performance.now() - start) < 6;
                while (head < q.length && hasBudget()) { try { processNode(q[head++]); } catch (_) { } }
                if (head > 256 && head * 2 > q.length) { q.splice(0, head); head = 0; }
                if (head < q.length) schedule();
            };
            if (typeof requestIdleCallback === 'function') requestIdleCallback(runner, { timeout: 120 });
            else requestAnimationFrame(() => runner(null));
        };
        return { push(node) { if (!node) return; q.push(node); schedule(); } };
    };

    const createRegistry = (scheduler, featureCheck, { IS_LOW_END }) => {
        const videos = new Set(), images = new Set();
        const visible = { videos: new Set(), images: new Set() };
        const dirty = { videos: new Set(), images: new Set() };
        let rev = 0;
        const MAX_SHADOW_OBSERVERS = IS_LOW_END ? 8 : 24;
        let shadowObsCount = 0;

        const io = new IntersectionObserver((entries) => {
            let changed = false;
            for (const e of entries) {
                const el = e.target;
                const isVis = e.isIntersecting || e.intersectionRatio > 0;
                el[VSCX.visible] = isVis;
                el[VSCX.ir] = e.intersectionRatio || 0;
                el[VSCX.rect] = e.boundingClientRect;
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

        const scanQ = (function() {
            const q = []; let head = 0, scheduled = false;
            const run = (dl) => {
                scheduled = false; const start = performance.now();
                const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6;
                while (head < q.length && budget()) { try { const n = q[head++]; if (n.nodeType === 11) n.querySelectorAll('video,img').forEach(observeMediaEl); else if (n.nodeType === 1) { if (n.tagName === 'VIDEO' || n.tagName === 'IMG') observeMediaEl(n); n.querySelectorAll('video,img').forEach(observeMediaEl); } } catch (_) {} }
                if (head > 256) { q.splice(0, head); head = 0; }
                if (head < q.length) schedule();
            };
            const schedule = () => { if (!scheduled) { scheduled = true; if (window.requestIdleCallback) requestIdleCallback(run); else requestAnimationFrame(() => run()); } };
            return { push: (n) => { q.push(n); schedule(); } };
        })();

        const observers = new Set();
        const connectObserver = (root, isShadow = false) => {
            if (!root || (isShadow && shadowObsCount >= MAX_SHADOW_OBSERVERS)) return;
            if (isShadow) shadowObsCount++;
            const mo = new MutationObserver((muts) => { if (featureCheck.active()) for (const m of muts) for (const n of m.addedNodes) scanQ.push(n); });
            mo.observe(root, { childList: true, subtree: true }); observers.add(mo);
        };
        const refreshObservers = () => {
            for (const o of observers) o.disconnect(); observers.clear(); shadowObsCount = 0;
            const root = document.body || document.documentElement; if (root) { scanQ.push(root); connectObserver(root); }
        };

        const origAttachShadow = Element.prototype.attachShadow;
        if (origAttachShadow) {
            Element.prototype.attachShadow = function(init) {
                const shadow = origAttachShadow.call(this, init);
                try { if (shadow) connectObserver(shadow, true); } catch (_) {}
                return shadow;
            };
        }
        refreshObservers();

        return {
            videos, images, visible, rev: () => rev, refreshObservers,
            prune: () => {
                for (const v of videos) if (!v.isConnected) { videos.delete(v); visible.videos.delete(v); dirty.videos.delete(v); TOUCHED.videos.delete(v); io.unobserve(v); }
                for (const i of images) if (!i.isConnected) { images.delete(i); visible.images.delete(i); dirty.images.delete(i); TOUCHED.images.delete(i); io.unobserve(i); }
                rev++;
            },
            consumeDirty: () => { const out = { videos: new Set(dirty.videos), images: new Set(dirty.images) }; dirty.videos.clear(); dirty.images.clear(); return out; },
            rescanAll: () => { if (document.body) scanQ.push(document.body); },
            setWantImages: (want) => {
                if (want) return [];
                const removed = Array.from(images); images.clear(); visible.images.clear(); dirty.images.clear(); rev++;
                for (const i of removed) io.unobserve(i); return removed;
            }
        };
    };

    const createAudio = (sm) => {
        let ctx, compressor, dry, wet, target = null, currentSrc = null;
        const srcMap = new WeakMap();
        const onGesture = () => { try { if (ctx?.state === 'suspended') ctx.resume(); } catch (_) {} };
        window.addEventListener('pointerdown', onGesture, { once: true, passive: true });
        const ensureCtx = () => {
            if (ctx) return true;
            const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
            ctx = new AC(); compressor = ctx.createDynamicsCompressor();
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
        const disconnect = () => { if (currentSrc) { try { currentSrc.disconnect(); } catch (_) {} currentSrc = null; target = null; } };

        const getOrCreateSrc = (v) => {
            let s = srcMap.get(v); if (s) return s;
            s = ctx.createMediaElementSource(v); srcMap.set(v, s); return s;
        };

        const attach = (v) => {
             if (!v || v.tagName !== 'VIDEO' || v[VSCX.audioFail]) return;
             if (!ensureCtx()) return;
             try {
                const s = getOrCreateSrc(v);
                s.connect(dry); s.connect(compressor);
                currentSrc = s; target = v; updateMix();
             } catch(e) { v[VSCX.audioFail]=true; disconnect(); }
        };

        return {
            setTarget: (v) => {
                if (!(sm.get(P.A_EN) && sm.get(P.APP_ACT))) { disconnect(); return; }
                if (v === target) { updateMix(); return; }
                disconnect(); if(v) attach(v);
            },
            update: updateMix
        };
    };

    const createFilters = (Utils, config) => {
        const { h, clamp } = Utils; const ctxMap = new WeakMap(); const toneCache = new Map();
        const getToneTableCached = (sh, hi, br, con, gain, gamma, isLowEnd) => {
            const steps = isLowEnd ? 64 : 96;
            const i = (x, s) => Math.round(x * s);
            const k = [steps, i(sh,1000), i(hi,1000), i(br,10000), i(con,10000), i(gain,10000), i(1/gamma,10000)].join('|');
            if (toneCache.has(k)) return toneCache.get(k);
            const out = new Array(steps);
            const shN = clamp(sh,-1,1), hiN = clamp(hi,-1,1), b = clamp(br,-1,1)*0.1, g = clamp(gain||1,0.7,1.8), c = clamp(con||1,0.85,1.35), invG = 1/clamp(gamma||1,0.2,3);
            const toe = clamp(0.18+shN*0.08,0.06,0.3), sho = clamp(0.86-hiN*0.06,0.72,0.95);
            for (let idx=0; idx<steps; idx++) {
                let x = clamp(idx/(steps-1)*g,0,1), y = (x-0.5)*c+0.5+b;
                if (y<toe) { const t=clamp(y/Math.max(1e-6,toe),0,1); y=toe*(t*t*(3-2*t)*t+(1-t*t*(3-2*t))*(t*(1+0.9*shN))); }
                if (y>sho) { const t=clamp((y-sho)/Math.max(1e-6,1-sho),0,1); y=sho+(1-sho)*(t-t*t*(3-2*t)*t*(0.55+0.35*hiN)); }
                out[idx] = Math.pow(clamp(y,0,1), invG).toFixed(3);
            }
            const res = out.join(' '); toneCache.set(k, res); return res;
        };
        const buildSvg = (doc) => {
            const svg = h('svg', { ns:'svg', style:'position:absolute;left:-9999px;width:0;height:0;' });
            const defs = h('defs', { ns:'svg' }); svg.append(defs);
            const createFilter = (suffix, withNoise) => {
                const fid = `vsc-f-${config.VSC_ID}-${suffix}`;
                const filter = h('filter', { ns:'svg', id:fid, 'color-interpolation-filters':'sRGB' });
                // [Part 4-1] Tone -> Temp -> Sat
                const lin = h('feComponentTransfer', { ns:'svg', result:'lin' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'table', tableValues:'0 1' })));
                const tmp = h('feComponentTransfer', { ns:'svg', in:'lin', result:'tmp' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'linear', slope:'1' })));
                const sat = h('feColorMatrix', { ns:'svg', in:'tmp', type:'saturate', values:'1', result:'sat' });
                const b1 = h('feGaussianBlur', { ns:'svg', in:'sat', stdDeviation:'0', result:'b1' });
                const sh1 = h('feComposite', { ns:'svg', in:'sat', in2:'b1', operator:'arithmetic', k2:'1', k3:'0', result:'sh1' });
                const b2 = h('feGaussianBlur', { ns:'svg', in:'sh1', stdDeviation:'0', result:'b2' });
                const sh2 = h('feComposite', { ns:'svg', in:'sh1', in2:'b2', operator:'arithmetic', k2:'1', k3:'0', result:'sh2' });
                const bc = h('feGaussianBlur', { ns:'svg', in:'sh2', stdDeviation:'0', result:'bc' });
                const cl = h('feComposite', { ns:'svg', in:'sh2', in2:'bc', operator:'arithmetic', k2:'1', result:'cl' });
                filter.append(lin, tmp, sat, b1, sh1, b2, sh2, bc, cl);
                let gr=null; if(withNoise){ const turb=h('feTurbulence',{ns:'svg',type:'fractalNoise',baseFrequency:'0.85',result:'noise'}); gr=h('feComposite',{ns:'svg',in:'cl',in2:'noise',operator:'arithmetic',k2:'1',k3:'0'}); filter.append(turb,gr); }
                defs.append(filter);
                return { fid, sat, linFuncs:Array.from(lin.children), tmpFuncs:Array.from(tmp.children), b1, sh1, b2, sh2, bc, cl, gr };
            };
            const vN=createFilter('vN',true), v0=createFilter('v0',false), iN=createFilter('iN',true), i0=createFilter('i0',false);
            const root = doc.documentElement || doc.body;
            if (root) root.appendChild(svg);
            else { const t = setInterval(() => { const r = doc.documentElement || doc.body; if (r) { clearInterval(t); try { r.appendChild(svg); } catch (_) {} } }, 25); }
            return { video:{N:vN, O:v0}, image:{N:iN, O:i0} };
        };
        return {
            prepare: (doc, s, kind) => {
                let ctx = ctxMap.get(doc); if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
                const nodes = kind==='video' ? (s.dither>0?ctx.video.N:ctx.video.O) : (s.dither>0?ctx.image.N:ctx.image.O);
                const table = getToneTableCached(s.toe/14, s.shoulder/12, s.bright/100, s.contrast, s.gain, s.gamma, IS_LOW_END);
                for(const fn of nodes.linFuncs) fn.setAttribute('tableValues', table);
                nodes.sat.setAttribute('values', clamp(s.satF,0,2.5).toFixed(2));
                const t=clamp(s.temp,-25,25); let rs=1,gs=1,bs=1; if(t>0){rs=1+t*0.012;gs=1+t*0.003;bs=1-t*0.01;} else {const k=-t;bs=1+k*0.012;gs=1+k*0.003;rs=1-k*0.01;}
                nodes.tmpFuncs[0].setAttribute('slope', rs.toFixed(3)); nodes.tmpFuncs[1].setAttribute('slope', gs.toFixed(3)); nodes.tmpFuncs[2].setAttribute('slope', bs.toFixed(3));
                const sc=(x)=>x*x*(3-2*x), v1=s.sharp/50, kC=sc(Math.min(1,v1))*2;
                nodes.b1.setAttribute('stdDeviation', v1>0?(1.5-sc(Math.min(1,v1))*0.8).toFixed(2):'0');
                nodes.sh1.setAttribute('k2', (1+kC).toFixed(3)); nodes.sh1.setAttribute('k3', (-kC).toFixed(3));
                const v2=s.sharp2/50, kF=sc(Math.min(1,v2))*3.5;
                nodes.b2.setAttribute('stdDeviation', v2>0?(0.5-sc(Math.min(1,v2))*0.3).toFixed(2):'0');
                nodes.sh2.setAttribute('k2', (1+kF).toFixed(3)); nodes.sh2.setAttribute('k3', (-kF).toFixed(3));
                const clVal=s.clarity/50; nodes.bc.setAttribute('stdDeviation', clVal>0?'2.2':'0');
                nodes.cl.setAttribute('k2', (1+clVal).toFixed(3)); nodes.cl.setAttribute('k3', (-clVal).toFixed(3));
                if(nodes.gr) nodes.gr.setAttribute('k3', (s.dither/100*0.22).toFixed(3));
                return `url(#${nodes.fid})`;
            },
            applyUrl: (el, url) => { if(el.style.filter!==url){ el.style.setProperty('filter',url,'important'); el.style.setProperty('-webkit-filter',url,'important'); } },
            clear: (el) => { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); }
        };
    };

    const createAE = (sm, { IS_MOBILE, Utils }, onAE) => {
        let worker, canvas, ctx2d, activeVideo = null, isRunning = false, workerBusy = false, targetToken = 0;
        let lastStats = { p10:-1,p35:-1,p50:-1,p60:-1,p90:-1,p95:-1,p98:-1,p98m:-1,clipFrac:0,cf:0.5,std:0,rd:0 }; // [Part 4-3]
        let lastApplyT = 0, lastEmaT = 0, lastLuma = -1, lastSampleT = 0, curGain = 1.0, aeActive = false;
        let dynamicSkipThreshold = 0, frameSkipCounter = 0, clipStreak = 0, suspendUntil = 0, evAggressiveUntil = 0, useRVFC = false, rvfcToken = 0, __prevFrame = null, __motion01 = 1;
        const { clamp } = Utils; const getCfg = () => getAeCfg(IS_MOBILE, sm.get(P.V_AE_PROFILE));

        const computeTargetEV = (stats, cfg) => {
            const p35=clamp(stats.p35??stats.p50,0.01,0.99), p50=clamp(stats.p50,0.01,0.99), p60=clamp(stats.p60??stats.p50,0.01,0.99), p98=clamp(stats.p98,0.01,0.999), p98m=clamp(stats.p98m??p98,0.01,0.999), p95=clamp(stats.p95??stats.p90,0.01,0.999);
            const skinBias = clamp(((stats.rd||0)-0.05)/0.08,0,1);
            const key = clamp(p50*(0.6-0.12*skinBias)+p35*(0.3+0.1*skinBias)+p60*(0.1+0.02*skinBias),0.01,0.99);
            let targetMid = cfg.TARGET_MID_BASE; if(p50<0.12) targetMid+=0.04;
            let ev = Math.log2(targetMid/key)*cfg.STRENGTH;
            const hiRisk = clamp((clamp(stats.p90,0,1)-0.84)/0.12,0,1);
            const maxSafeEV = Math.log2(Math.max(1, Math.min(0.985/p98, 0.985/p98m, 0.98/p95))) - (0.08*hiRisk);
            const clipPenalty = clamp(((stats.clipFrac??0)-cfg.CLIP_FRAC_LIMIT)/cfg.CLIP_FRAC_LIMIT,0,1)*0.18;
            return Math.min(clamp(ev, cfg.MAX_DOWN_EV, cfg.MAX_UP_EV), maxSafeEV - clipPenalty);
        };

        const processResult = (data) => {
            if(!data || data.token!==targetToken) return;
            const cfg = getCfg(); const now = performance.now();
            const uiBar = (data.botAvg>0.2 && data.botStd<0.06) || (data.clipFracBottom>(cfg.CLIP_FRAC_LIMIT*4) && data.botStd<0.04);
            const subLikely = (data.clipFracBottom>cfg.CLIP_FRAC_LIMIT*2) && data.p98>0.97 && data.p50<0.22 && data.stdDev>0.06 && data.botStd>0.045 && !uiBar;
            const stats0 = subLikely ? data : data; // Simplify stats mapping logic
            const stats = {
                p10: subLikely?data.p10T:data.p10, p35:data.p35, p50:subLikely?data.p50T:data.p50, p60:data.p60,
                p90:subLikely?data.p90T:data.p90, p95:subLikely?data.p95T:data.p95, p98:subLikely?data.p98T:data.p98, p98m:data.p98m,
                clipFrac:data.clipFrac, cf:data.cf, std: subLikely?data.stdDevT:data.stdDev, rd:data.redDominance
            };

            const dt = Math.min(now - lastEmaT, 500); lastEmaT = now;
            const tau = clamp((activeVideo?.paused?360:cfg.DT_CAP_MS) + (1-__motion01)*180, 180, 650);
            const a = 1 - Math.exp(-dt/tau);

            for(const k of Object.keys(lastStats)) {
                const v = stats[k];
                if(Number.isFinite(v)) lastStats[k] = lastStats[k]<0 ? v : v*a + lastStats[k]*(1-a);
            }

            if(lastLuma>=0 && Math.abs(data.avgLuma-lastLuma)>(0.1*((__motion01<0.05)?1:0.35))) evAggressiveUntil = now + (__motion01<0.05?900:450);
            lastLuma = data.avgLuma;

            let targetEV = computeTargetEV(lastStats, cfg); if(subLikely) targetEV*=0.85;
            if(Math.abs(targetEV)<(aeActive?cfg.DEAD_IN:cfg.DEAD_OUT)) targetEV=0; else aeActive=true;

            const dtA = Math.min(now-lastApplyT, cfg.DT_CAP_MS); lastApplyT=now;
            const alphaA = 1 - Math.exp(-dtA/(now<evAggressiveUntil?cfg.TAU_AGGRESSIVE:(targetEV>Math.log2(curGain)?cfg.TAU_UP:cfg.TAU_DOWN)));
            curGain = Math.pow(2, Math.log2(curGain) + (targetEV-Math.log2(curGain))*alphaA);

            const tuning = (function(tg, s, c){
                const sm=(t)=>t*t*(3-2*t), ev01=clamp(Math.log2(tg)/1.6,0,1), sceneContrast=clamp(s.p90-s.p10,0,1), flat01=sm(clamp((0.42-sceneContrast)/0.22,0,1)), hiR=sm(clamp((s.p90-0.86)/0.1,0,1));
                return { br:ev01*12.5*clamp(0.58-s.p50,-0.25,0.25), con:1+ev01*0.05*flat01*(1-hiR*0.6), sat:1+sm(clamp((0.26-s.cf)/0.16,0,1))*0.6*(1-hiR*0.6), hiR };
            })(curGain, lastStats, cfg);

            const res = { gain:curGain, gammaF:1, conF:tuning.con, satF:tuning.sat, toe:clamp(12*clamp((curGain-1.01)/0.18,0,1)*clamp(Math.log2(curGain)/1.6,0,1)*(1-tuning.hiR*0.55),0,14), shoulder:clamp(15*tuning.hiR,0,14), brightAdd:tuning.br, tempAdd:0, hiRisk:tuning.hiR, cf:lastStats.cf };
            onAE?.(res);
        };

        const _motionFromFrame = (rgba) => {
            const step = IS_LOW_END ? 32 : 16;
            if (!__prevFrame) {
                __prevFrame = new Uint8Array(Math.ceil(rgba.length / (4*step)));
                let j = 0; for (let i = 0; i < rgba.length; i += 4*step) { const y = (0.2126*rgba[i] + 0.7152*rgba[i+1] + 0.0722*rgba[i+2]) | 0; __prevFrame[j++] = y; }
                __motion01 = 1; return;
            }
            let diff = 0, cnt = 0, j = 0;
            for (let i = 0; i < rgba.length && j < __prevFrame.length; i += 4*step) {
                const y = (0.2126*rgba[i] + 0.7152*rgba[i+1] + 0.0722*rgba[i+2]) | 0;
                diff += Math.abs(y - __prevFrame[j]); __prevFrame[j++] = y; cnt++;
            }
            const d = cnt ? (diff / cnt) : 0; __motion01 = Math.max(0, Math.min(1, d / 28));
        };

        const disableAEHard = () => {
            try { worker?.terminate(); } catch (_) { }
            worker = null; workerBusy = false; isRunning = false; targetToken++;
            try { sm.set(P.V_AE, false); } catch (e) { }
        };

        let workerUrl = null;
        const ensureWorker = () => {
             if (worker) return worker;
             if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
             worker = new Worker(workerUrl);
             worker.onmessage = (e) => { workerBusy = false; processResult(e.data); };
             worker.onerror = () => { workerBusy = false; disableAEHard(); };
             return worker;
        };

        const sample = (v) => {
            if(!isRunning || !v || v[VSCX.tainted] || document.hidden || v.readyState<2 || v[VSCX.visible]===false) return;
            const now = performance.now(); if(now-lastSampleT < (v.paused?600:90)) return; lastSampleT=now;
            if(workerBusy) return;
            try {
                if(!canvas){ canvas=document.createElement('canvas'); canvas.width=canvas.height=IS_LOW_END?24:32; ctx2d=canvas.getContext('2d',{willReadFrequently:true,alpha:false}); }
                ctx2d.drawImage(v,0,0,canvas.width,canvas.height); const d=ctx2d.getImageData(0,0,canvas.width,canvas.height);
                _motionFromFrame(d.data); workerBusy=true;
                ensureWorker().postMessage({buf:d.data.buffer,width:canvas.width,height:canvas.height,step:canvas.width<=24?1:2,token:targetToken},[d.data.buffer]);
            } catch(_){ workerBusy=false; v[VSCX.tainted]=true; }
        };

        const tick = () => {
            if(!isRunning) return;
            const active = sm.get(P.APP_ACT) && sm.get(P.V_AE);
            if(!active || !activeVideo || !activeVideo.isConnected) { if(!useRVFC) setTimeout(tick, 800); return; }
            sample(activeVideo);
            if(!useRVFC) setTimeout(tick, 90 + (dynamicSkipThreshold>=12?70:0));
        };

        const rvfcLoop = (token) => {
            if (!isRunning || token !== rvfcToken) return;
            const v = activeVideo;
            if (!v || !useRVFC) return;
            const now = performance.now();
            const minInterval = (v.paused ? 600 : 90);
            if (now - lastSampleT >= minInterval) sample(v);
            try { v.requestVideoFrameCallback(() => rvfcLoop(token)); } catch (e) { }
        };

        return {
            setTarget: (v) => { if(v!==activeVideo){ activeVideo=v; targetToken++; workerBusy=false; __prevFrame=null; useRVFC=!!v?.requestVideoFrameCallback; if(useRVFC) v.requestVideoFrameCallback(function loop(){ if(activeVideo===v && isRunning){ rvfcLoop(targetToken); } }); } },
            // [Fix] Call ensureWorker instead of init
            start: () => { ensureWorker(); if (!isRunning) { isRunning = true; if(!useRVFC) tick(); } },
            stop: () => { isRunning=false; worker?.terminate(); worker=null; activeVideo=null; curGain=1; aeActive=false; },
            wake: () => { evAggressiveUntil=performance.now()+1000; },
            userTweak: () => { lastStats={p10:-1,p35:-1,p50:-1,p60:-1,p90:-1,p95:-1,p98:-1,p98m:-1,clipFrac:0,cf:0.5,std:0,rd:0}; lastEmaT=0; curGain=1; evAggressiveUntil=performance.now()+1200; }
        };
    };

    const createUI = (Utils, sm, defaults, config, registry, scheduler) => {
        const { h } = Utils;
        let container, monitorEl, gearHost, gearBtn;
        const isFsHere = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
        const allowUiInThisDoc = () => config.IS_TOP || isFsHere();
        const detachNodesHard = () => {
            try { if (container?.isConnected) container.remove(); } catch (_) { }
            try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) { }
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

        const renderChoiceRow = (label, items, key) => {
            const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
            items.forEach(it => {
                const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.t);
                b.onclick = () => {
                    const cur = sm.get(key);
                    const def = (key === 'video.aeProfile') ? 'balanced' : 'neutral';
                    const next = (cur === it.v) ? def : it.v;
                    sm.set(key, next);
                    if (key === P.V_AE_PROFILE && next) {
                        const rec = (next === 'cinematic') ? 'highlight' : (next === 'bright' ? 'redSkin' : 'neutral');
                        if (!sm.get(P.V_TONE_PRE)) sm.set(P.V_TONE_PRE, rec);
                        document.dispatchEvent(new CustomEvent('vsc-ae-wake'));
                    }
                    document.dispatchEvent(new CustomEvent('vsc-user-tweak'));
                    scheduler.request(true);
                };
                sm.sub(key, v => b.classList.toggle('active', v === it.v));
                r.append(b);
            });
            return r;
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
            const renderSlider = (cfg) => {
                const valEl = h('span', { style: 'color:#3498db' }, '0');
                const inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
                const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, update); update(sm.get(cfg.k));
                inp.oninput = () => { valEl.textContent = cfg.f(Number(inp.value)); sm.set(cfg.k, Number(inp.value)); };
                return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp);
            };
            const renderPresetRow = (label, items, key) => {
                const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
                items.forEach(it => {
                    const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.l || it.txt);
                    b.onclick = () => { sm.set(key, it.l || it.txt); document.dispatchEvent(new CustomEvent('vsc-user-tweak')); scheduler.request(true); };
                    sm.sub(key, v => b.classList.toggle('active', v === (it.l || it.txt)));
                    r.append(b);
                });
                const off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF');
                off.onclick = () => { sm.set(key, key === P.V_PRE_B ? 'brOFF' : 'off'); document.dispatchEvent(new CustomEvent('vsc-user-tweak')); scheduler.request(true); };
                sm.sub(key, v => off.classList.toggle('active', v === 'off' || v === 'brOFF'));
                return r.append(off), r;
            };

            const bodyV = h('div', { id: 'p-v' }, [
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => sm.set(P.APP_UI, false) }, '✕ 닫기'),
                    // [Clean] Removed FS button
                    h('button', { id: 'ae-btn', class: 'btn', onclick: () => { const n = !sm.get(P.V_AE); sm.set(P.V_AE, n); if (n) { if (!sm.get(P.V_AE_PROFILE)) sm.set(P.V_AE_PROFILE, 'balanced'); if (!sm.get(P.V_TONE_PRE)) sm.set(P.V_TONE_PRE, 'neutral'); } else { sm.set(P.V_AE_PROFILE, null); sm.set(P.V_TONE_PRE, null); } document.dispatchEvent(new CustomEvent('vsc-user-tweak')); } }, '🤖 자동'),
                    h('button', { id: 'boost-btn', class: 'btn', onclick: () => sm.set(P.A_EN, !sm.get(P.A_EN)) }, '🔊 부스트')
                ),
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => { sm.batch('video', { ...defaults.video }); sm.batch('audio', defaults.audio); document.dispatchEvent(new CustomEvent('vsc-user-tweak')); } }, '↺ 리셋'),
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
                .gear{position:fixed;top:50%;right:10px;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,0.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.18);color:#fff;font:700 20px/46px sans-serif;text-align:center;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,0.55);user-select:none;transition:transform .12s ease,opacity .12s ease,box-shadow .12s ease;}
                .gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,0.65);}
                .gear:active{transform:translateY(-50%) scale(0.98);}
                .gear.open { outline: 2px solid rgba(52,152,219,0.85); }
                .gear.inactive { opacity: 0.45; }
                .hint { position: fixed; right: 74px; bottom: 24px; padding: 6px 10px; border-radius: 10px; background: rgba(25,25,25,0.88); border: 1px solid rgba(255,255,255,0.14); color: rgba(255,255,255,0.82); font: 600 11px/1.2 sans-serif; white-space: nowrap; z-index: 2147483647; opacity: 0; transform: translateY(6px); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
                .gear:hover + .hint { opacity: 1; transform: translateY(0); }
            `;
            gearBtn = h('button', { class: 'gear', onclick: () => sm.set(P.APP_UI, !sm.get(P.APP_UI)) }, '⚙');
            shadow.append(h('style', {}, style), gearBtn, h('div', { class: 'hint' }, '설정 (Alt+Shift+V)'));
            const syncGear = () => {
                if (!gearBtn) return;
                const showHere = allowUiInThisDoc();
                gearBtn.classList.toggle('open', !!sm.get(P.APP_UI));
                gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT));
                gearBtn.style.display = showHere ? 'block' : 'none';
                if (!showHere) detachNodesHard();
            };
            sm.sub(P.APP_ACT, syncGear); sm.sub(P.APP_UI, syncGear); syncGear();
        };

        const mount = () => {
            if (!allowUiInThisDoc()) { detachNodesHard(); return; }
            const root = getUiRoot();
            if (!root) return;
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
            destroy: () => { if (config.IS_TOP) { if (container) container.style.display = 'none'; } else detachNodesHard(); }
        };
    };

    // [Restored] Apply Tone Preset Helper
    function applyTonePreset(base, presetName, strength, Utils) {
        const { clamp } = Utils;
        const p = TONE_PRESET[presetName] || TONE_PRESET.neutral;
        const t = clamp(strength ?? 1.0, 0, 1);
        return {
            ...base,
            gamma: clamp(base.gamma * (1 + (p.gam - 1) * t), 0.5, 2.5),
            contrast: clamp(base.contrast * (1 + (p.con - 1) * t), 0.5, 2.0),
            satF: clamp(base.satF * (1 + (p.sat - 1) * t), 0.0, 2.0),
            bright: clamp(base.bright + (p.br * t), -50, 50),
            temp: clamp(base.temp + (p.tmp * t), -25, 25),
            toe: clamp(base.toe + (p.toe * t), 0, 14),
            shoulder: clamp(base.shoulder + (p.shoulder * t), 0, 14),
        };
    }

    function composeVideoParams(vUser, ae, defaultsVideo, Utils) {
        const clamp = Utils.clamp;
        const mix = clamp(vUser.presetMix ?? 1.0, 0, 1);
        const pS = PRESET.sharp[vUser.presetS] || PRESET.sharp.off;
        const pB = PRESET.grade[vUser.presetB] || PRESET.grade.brOFF;
        const preGammaF = lerp(1.0, pB.gammaF, mix), preConF = lerp(1.0, pB.conF, mix), preSatF = lerp(1.0, pB.satF, mix);
        const preBright = (pB.brightAdd || 0) * mix, preTemp = (pB.tempAdd || 0) * mix;
        const preSharp = (pS.sharpAdd || 0) * mix, preSharp2 = (pS.sharp2Add || 0) * mix;
        const A = ae || { gain: 1, gammaF: 1, conF: 1, satF: 1, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, hiRisk: 0, cf: 0.5 };

        let gamma = (vUser.gamma || 1.0) * preGammaF * (A.gammaF || 1.0);
        let contrast = (vUser.contrast || 1.0) * preConF * (A.conF || 1.0);
        let satF = ((vUser.sat || 100) / 100) * preSatF * (A.satF || 1.0);
        let bright = (vUser.bright || 0) + preBright + (A.brightAdd || 0);
        let temp = (vUser.temp || 0) + preTemp + (A.tempAdd || 0);

        const gain = clamp(A.gain || 1.0, 1.0, 8.0);
        let sharpMul = Math.max(0.55, 1 / (1 + (gain - 1.0) * 1.6));
        sharpMul *= (1 - Math.min(0.35, (A.hiRisk || 0) * 0.35));

        const cf = (A.cf != null) ? A.cf : 0.5;
        const cfGate = Math.max(0, Math.min(1, (cf - 0.10) / 0.22));
        sharpMul *= (0.72 + 0.28 * cfGate);

        let sharp = ((vUser.sharp || 0) + preSharp) * sharpMul, sharp2 = ((vUser.sharp2 || 0) + preSharp2) * sharpMul, clarity = (vUser.clarity || 0) * sharpMul;
        const styleMix = ((vUser.presetB !== 'brOFF' || vUser.presetS !== 'off') || (Math.abs(vUser.bright || 0) > 10 || Math.abs((vUser.gamma || 1) - 1) > 0.1 || Math.abs((vUser.contrast || 1) - 1) > 0.1 || Math.abs((vUser.sat || 100) - 100) > 25)) ? 0.55 : 1.0;

        let out = {
            gain, gamma: clamp(gamma, 0.5, 2.5), contrast: clamp(contrast, 0.5, 2.0), bright: clamp(bright, -50, 50),
            satF: clamp(satF, 0.0, 2.0), sharp: clamp(sharp, 0, 50), sharp2: clamp(sharp2, 0, 50), clarity: clamp(clarity, 0, 50),
            dither: vUser.dither || 0, temp: clamp(temp, -25, 25), toe: (A.toe || 0) * styleMix, shoulder: (A.shoulder || 0) * styleMix
        };

        const toneName = vUser.tonePreset;
        const toneStr = vUser.toneStrength;
        if (toneName) out = applyTonePreset(out, toneName, toneStr, Utils);
        return out;
    }

    const isNeutralVideoParams = (v) => (
        Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 && Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
        Math.abs((v.bright ?? 0)) < 0.01 && Math.abs((v.satF ?? 1) - 1) < 0.001 &&
        (v.sharp | 0) === 0 && (v.sharp2 | 0) === 0 && (v.clarity | 0) === 0 && (v.dither | 0) === 0 && (v.temp | 0) === 0 &&
        (v.toe | 0) === 0 && (v.shoulder | 0) === 0
    );

    // ==========================================
    // MAIN ENGINE
    // ==========================================
    const Utils = createUtils();
    const Scheduler = createScheduler();
    const Store = createSyncStore(DEFAULTS, Scheduler, { IS_TOP });

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
    const Filters = createFilters(Utils, { VSC_ID });
    const Audio = createAudio(Store);

    let currentAE = { gain: 1.0, gammaF: 1.0, conF: 1.0, satF: 1.0, toe: 0, shoulder: 0, brightAdd: 0, tempAdd: 0, luma: 0, hiRisk: 0, cf: 0.5 };
    let aeRev = 0;

    const AE = createAE(Store, { IS_MOBILE, Utils }, (ae) => {
        const prev = currentAE;
        const changed = Math.abs((ae.gain ?? 1) - (prev.gain ?? 1)) > 0.015 || Math.abs((ae.brightAdd ?? 0) - (prev.brightAdd ?? 0)) > 0.35 || Math.abs((ae.tempAdd ?? 0) - (prev.tempAdd ?? 0)) > 0.35 || Math.abs((ae.gammaF ?? 1) - (prev.gammaF ?? 1)) > 0.012 || Math.abs((ae.conF ?? 1) - (prev.conF ?? 1)) > 0.012 || Math.abs((ae.satF ?? 1) - (prev.satF ?? 1)) > 0.010 || Math.abs((ae.toe ?? 0) - (prev.toe ?? 0)) > 0.5 || Math.abs((ae.shoulder ?? 0) - (prev.shoulder ?? 0)) > 0.5;
        currentAE = ae;
        if (changed) { aeRev++; Scheduler.request(false); }
    });

    const UI = createUI(Utils, Store, DEFAULTS, { IS_TOP }, Registry, Scheduler);
    UI.ensure();
    Store.sub(P.APP_UI, (v) => { if (v) UI.ensure(); else UI.destroy(); Scheduler.request(true); });

    document.addEventListener('vsc-user-tweak', () => { if (FEATURES.ae()) AE.userTweak(); });
    document.addEventListener('vsc-audio-gesture', () => Scheduler.request(true));
    document.addEventListener('vsc-ae-wake', () => { if (FEATURES.ae()) AE.wake(); });

    let lastSRev = -1, lastRRev = -1, lastAeRev = -1;
    let lastPrune = 0, lastWantImages = false;
    let __pickCacheV = null, __pickCacheT = 0, __currentTarget = null, __currentScore = -1, __currentSince = 0;
    let __lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: 0 };
    let __lastClickedVideo = null;

    const markUserIntent = (x, y) => { __lastUserPt = { x, y, t: performance.now() }; };
    window.addEventListener('pointerdown', (e) => {
        markUserIntent(e.clientX, e.clientY);
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const v = el?.closest?.('video');
        if (v) __lastClickedVideo = v;
    }, { passive: true });
    window.addEventListener('wheel', () => markUserIntent(innerWidth * 0.5, innerHeight * 0.5), { passive: true });
    window.addEventListener('keydown', () => markUserIntent(innerWidth * 0.5, innerHeight * 0.5), { passive: true });

    const getRateState = (v) => {
        let st = v[VSCX.rateState];
        if (!st) st = v[VSCX.rateState] = { orig: null, lastSetAt: 0 };
        return st;
    };
    const bindVideoOnce = (v) => {
        if (v[VSCX.bound]) return;
        v[VSCX.bound] = true;
        v.addEventListener('seeking', () => AE.wake(), { passive: true });
        v.addEventListener('play', () => AE.wake(), { passive: true });
        v.addEventListener('ratechange', () => {
            const st = getRateState(v);
            const now = performance.now();
            if (now - st.lastSetAt < 90) return;
            const cur = v.playbackRate;
            if (Number.isFinite(cur) && cur > 0) Store.set(P.PB_RATE, cur);
        }, { passive: true });
    };

    const clearVideoOne = (el) => { try { Filters.clear(el); } catch (_) { } TOUCHED.videos.delete(el); };
    const clearImageOne = (el) => { try { Filters.clear(el); } catch (_) { } TOUCHED.images.delete(el); };
    const restoreRateOne = (el) => { try { const st = el[VSCX.rateState]; if (st?.orig != null) el.playbackRate = st.orig; } catch (_) { } if (el[VSCX.rateState]) el[VSCX.rateState].orig = null; el[VSCX.origRate] = null; };

    const docFilterKey = new WeakMap();

    const applyVideoFilters = (visibleVideos, dirtyVideos, vVals, activeFx) => {
        for (const el of dirtyVideos) { if (!el || el.tagName !== 'VIDEO') continue; if (!activeFx || el[VSCX.visible] === false) clearVideoOne(el); }
        if (!activeFx) return;
        let lastDoc = null, url = null;
        for (const el of visibleVideos) {
            if (!el || el.tagName !== 'VIDEO') continue; if (el[VSCX.visible] === false) continue;
            const doc = el.ownerDocument || document;
            if (doc !== lastDoc) {
                lastDoc = doc;
                const key = `${vVals.satF}|${vVals.gain}|${vVals.gamma}|${vVals.contrast}|${vVals.bright}|${vVals.sharp}|${vVals.sharp2}|${vVals.clarity}|${vVals.dither}|${vVals.temp}|${vVals.toe}|${vVals.shoulder}`;
                if (docFilterKey.get(doc) !== key) { docFilterKey.set(doc, key); url = Filters.prepare(doc, vVals, 'video'); }
                if (!url) url = Filters.prepare(doc, vVals, 'video');
            }
            Filters.applyUrl(el, url);
            TOUCHED.videos.add(el);
            bindVideoOnce(el);
        }
    };

    const applyImageFilters = (visibleImages, dirtyImages, iVals, activeFx) => {
        for (const el of dirtyImages) { if (!el || el.tagName !== 'IMG') continue; if (!activeFx || el[VSCX.visible] === false) clearImageOne(el); }
        if (!activeFx) return;
        let lastDoc = null, url = null;
        for (const el of visibleImages) {
            if (!el || el.tagName !== 'IMG') continue; if (el[VSCX.visible] === false) continue;
            const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
            if (w <= 50 || h <= 50) continue;
            const doc = el.ownerDocument || document;
            if (doc !== lastDoc) { lastDoc = doc; url = Filters.prepare(doc, iVals, 'image'); }
            Filters.applyUrl(el, url);
            TOUCHED.images.add(el);
        }
    };

    const applyPlaybackRate = (visibleVideos, dirtyVideos, desiredRate, active) => {
        for (const el of dirtyVideos) { if (!el || el.tagName !== 'VIDEO') continue; if (!active || el[VSCX.visible] === false) restoreRateOne(el); }
        if (!active) return;
        for (const el of visibleVideos) {
            if (!el || el.tagName !== 'VIDEO') continue; if (el[VSCX.visible] === false) continue;
            const st = getRateState(el);
            if (st.orig == null) st.orig = el.playbackRate;
            if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
                st.lastSetAt = performance.now();
                try { el.playbackRate = desiredRate; } catch (_) { }
            }
            bindVideoOnce(el);
        }
    };

    const cleanupAllTouched = () => {
        for (const v of TOUCHED.videos) { try { Filters.clear(v); } catch (e) { } try { const st = v[VSCX.rateState]; if (st?.orig != null) v.playbackRate = st.orig; } catch (e) { } }
        for (const i of TOUCHED.images) try { Filters.clear(i); } catch (e) { }
        TOUCHED.videos.clear(); TOUCHED.images.clear();
    };

    const syncImageScan = () => {
        const want = FEATURES.images();
        if (want && !lastWantImages) Registry.rescanAll();
        if (!want && lastWantImages) {
            const removed = Registry.setWantImages(false);
            for (const el of removed) { try { Filters.clear(el); } catch (e) { } TOUCHED.images.delete(el); }
            Scheduler.request(true);
        }
        lastWantImages = want;
    };
    Store.sub(P.APP_TAB, syncImageScan);
    Store.sub(P.I_LVL, syncImageScan);
    Store.sub(P.I_TMP, syncImageScan);
    Store.sub(P.V_AE, (v) => { if (!v) AE.stop?.(); });

    const scoreVideo = (v, audioBoostOn, now) => {
        if (!v || !v.isConnected || v.readyState < 2) return -Infinity;
        const r = v[VSCX.rect] || v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < 12000) return -Infinity;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return -Infinity;
        const playing = (!v.paused && !v.ended) ? 1 : 0;
        const hasTime = (v.currentTime > 0.2 && (v.duration === Infinity || v.duration > 1)) ? 1 : 0;
        const dist = Math.hypot((r.left + r.width * 0.5) - __lastUserPt.x, (r.top + r.height * 0.5) - __lastUserPt.y);
        const distScore = 1 / (1 + dist / 850);
        const userRecent01 = Math.max(0, 1 - (now - __lastUserPt.t) / 2500);
        const userBoost = userRecent01 * (1 / (1 + dist / 500)) * 3.2;
        const ir = (v[VSCX.ir] == null) ? 0.01 : v[VSCX.ir];
        const irScore = Math.min(1, ir) * 3.8;
        const bgLike = (v.muted && !v.controls && playing) ? 1 : 0;
        const bgPenalty = bgLike ? (1.8 + (area > innerWidth * innerHeight * 0.70 ? 1.0 : 0)) : 0;
        const audible = (!v.muted && (v.volume == null || v.volume > 0.01)) ? 1 : 0;
        const audioScore = audioBoostOn ? (audible * 2.2) : 0;
        return (playing * 6.2) + (hasTime * 2.6) + (area / 120000) + (distScore * 3.0) + userBoost + irScore + (v.controls ? 0.6 : 0) + audioScore - bgPenalty;
    };

    const pickBestVideo = (videos) => {
        const now = performance.now();
        if (__lastClickedVideo && videos.has(__lastClickedVideo) && __lastClickedVideo.isConnected && __lastClickedVideo.readyState >= 2) {
            if (now - __lastUserPt.t < 900) {
                __currentTarget = __lastClickedVideo; __currentScore = Infinity; __currentSince = now;
                return __lastClickedVideo;
            }
        }
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs) {
            const v = (fs.tagName === 'VIDEO') ? fs : fs.querySelector?.('video');
            if (v && videos.has(v) && v.isConnected && v.readyState >= 2) { __currentTarget = v; __currentScore = Infinity; __currentSince = now; return v; }
        }
        if (document.pictureInPictureElement && videos.has(document.pictureInPictureElement)) { __currentTarget = document.pictureInPictureElement; __currentScore = Infinity; __currentSince = now; return document.pictureInPictureElement; }

        const audioBoostOn = Store.get(P.A_EN) && Store.get(P.APP_ACT);
        const curScore = (__currentTarget && videos.has(__currentTarget)) ? scoreVideo(__currentTarget, audioBoostOn, now) : -Infinity;
        let best = __currentTarget, bestScore = curScore;

        for (const v of videos) {
            const s = scoreVideo(v, audioBoostOn, now);
            if (s > bestScore) { bestScore = s; best = v; }
        }

        if ((__currentTarget && (now - __currentSince) < 900) && best !== __currentTarget && bestScore < curScore + 1.35) return __currentTarget;
        if (best !== __currentTarget) { __currentTarget = best; __currentScore = bestScore; __currentSince = now; }
        return __currentTarget;
    };

    Scheduler.registerApply((force) => {
        try {
            const app = Store.getCat('app');
            const active = !!app.active;
            if (!active) { cleanupAllTouched(); Audio.update(); AE.stop?.(); return; }

            const sRev = Store.rev(), rRev = Registry.rev();
            if (!force && sRev === lastSRev && rRev === lastRRev && aeRev === lastAeRev) return;
            lastSRev = sRev; lastRRev = rRev; lastAeRev = aeRev;

            const now = performance.now();
            if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }

            const vf = Store.getCat('video'), img = Store.getCat('image');
            const wantImages = FEATURES.images(), wantAE = FEATURES.ae(), wantAudio = FEATURES.audio();

            if (!wantAE) AE.stop?.();
            const aeOut = wantAE ? currentAE : null;
            const vVals = composeVideoParams(vf, aeOut, DEFAULTS.video, Utils);
            const iVals = {
                satF: 1.0, gain: 1.0, gamma: 1.0, contrast: 1.0, bright: 0,
                sharp: img.level, sharp2: 0, clarity: 0, dither: 0, temp: img.temp, toe: 0, shoulder: 0
            };

            const videoFxOn = active && !isNeutralVideoParams(vVals);

            if (app.uiVisible) {
                if (wantAE) UI.update(`AE: ${vVals.gain.toFixed(2)}x (In: ${currentAE.luma || 0}%)`, true);
                else UI.update(`Ready (${VERSION_STR})`, false);
            }

            const { visible } = Registry;
            const dirty = Registry.consumeDirty();
            const vidsVisible = visible.videos, vidsDirty = dirty.videos;
            const imgsVisible = visible.images, imgsDirty = dirty.images;

            const target = pickBestVideo(visible.videos);

            if (wantAE) { AE.setTarget(target); AE.start(); }
            if (wantAudio) Audio.setTarget(target); else Audio.setTarget(null);
            Audio.update();

            applyVideoFilters(vidsVisible, vidsDirty, vVals, videoFxOn);
            if (wantImages) applyImageFilters(imgsVisible, imgsDirty, iVals, active);
            else applyImageFilters(new Set(), imgsDirty, iVals, false);
            applyPlaybackRate(vidsVisible, vidsDirty, Store.get(P.PB_RATE), active);

        } catch (e) { try { console.warn('[VSC] apply crashed:', e); } catch (_) { } }
    });

    Store.sub(P.APP_ACT, () => { try { Registry.refreshObservers?.(); } catch (_) { } Scheduler.request(true); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => { window.addEventListener(ev, () => { try { UI.ensure(); } catch (_) { } Scheduler.request(true); }, { passive: true }); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) Scheduler.request(true); }, { passive: true });

    let tickTimer = 0;
    const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT)) return; if (document.hidden) return; Scheduler.request(false); }, 12000); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
    const refreshTick = () => { if (FEATURES.ae() || FEATURES.audio()) startTick(); else stopTick(); };
    Store.sub(P.V_AE, refreshTick); Store.sub(P.A_EN, refreshTick); Store.sub(P.APP_ACT, refreshTick);
    refreshTick();

    // Kick initial apply
    Scheduler.request(true);
})();
