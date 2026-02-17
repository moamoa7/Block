// ==UserScript==
// @name        Video_Image_Control (v132.0.106 Stable-Core)
// @namespace   https://github.com/
// @version     132.0.106
// @description v132.106: Shadow Interceptor, Separated Filters(V/I), Perfect Sync
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

    // 1. Boot Guard & Shadow Interceptor
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com')) return;
    const VSC_KEY = '__VSC_LOCK__'; if (window[VSC_KEY]) return; window[VSC_KEY] = true;

    // [v91 Core] Shadow DOM Interceptor (Captures closed shadows)
    const _shadows = new Set();
    try {
        const origAttach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const sr = origAttach.call(this, init);
            _shadows.add(sr);
            return sr;
        };
    } catch (e) {}

    const IS_TOP = (window === window.top);
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_LOW_END = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || IS_MOBILE || (navigator.deviceMemory || 4) < 4;
    const VSC_ID = Math.random().toString(36).slice(2);

    const CONST = {
        AE: { STR: 0.28, MAX_UP: 0.18, CLIP_LIMIT: 0.004 },
        UI: { MAX_Z: 2147483647 }
    };

    const DEFAULTS = {
        video: {
            gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
            shadows: 0, highlights: 0, temp: 0,
            sharp: 0, sharp2: 0, dither: 0, clarity: 0,
            ae: false, gain: 1.0,
            presetS: 'off', presetB: 'off'
        },
        image: { level: 0, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const M = {}; const def = (k, fn) => M[k] = fn(); const use = (k) => M[k];

    // 2. Utils (Improved getRoots)
    def('Utils', () => {
        const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
        const smooth01 = (t) => t * t * (3 - 2 * t);
        const throttle = (fn, ms) => { let w = false; return (...a) => { if (!w) { fn(...a); w = true; setTimeout(() => w = false, ms); } }; };
        const h = (tag, props = {}, ...children) => {
            const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
            if (props.ns) delete props.ns;
            for (const [k, v] of Object.entries(props)) {
                if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
                else if (k === 'style') { if(typeof v==='string') el.style.cssText=v; else Object.assign(el.style, v); }
                else if (k === 'class') el.className = v;
                else if (v !== false && v != null) el.setAttribute(k, v);
            }
            children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
            return el;
        };

        // Robust Scanner
        const getRoots = () => {
            const set = new Set([document]);
            _shadows.forEach(sr => set.add(sr)); // Hooked shadows
            const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
                const sr = walker.currentNode.shadowRoot;
                if (sr) set.add(sr);
            }
            return [...set];
        };
        return { clamp, smooth01, throttle, h, getRoots };
    });

    // 3. Store (Multi-hop Sync + Local Lock)
    def('Store', () => {
        let state = JSON.parse(JSON.stringify(DEFAULTS));
        const listeners = new Map();
        const LOCAL_ONLY = new Set(['app.uiVisible', 'app.tab']);
        const SEEN = new Set();

        const seenKey = (id) => {
            if (SEEN.has(id)) return true;
            SEEN.add(id); if (SEEN.size > 500) SEEN.clear();
            return false;
        };

        const emit = (key, val) => {
            listeners.get(key)?.forEach(cb => cb(val));
            const cat = key.split('.')[0]; listeners.get(cat + '.*')?.forEach(cb => cb(val));
        };

        const stripLocal = (payload) => {
            const out = {};
            for (const [cat, data] of Object.entries(payload || {})) {
                for (const [k, v] of Object.entries(data || {})) {
                    if (LOCAL_ONLY.has(`${cat}.${k}`)) continue;
                    (out[cat] ||= {})[k] = v;
                }
            }
            return out;
        };

        const postToChildFrames = (msg) => {
            const frames = document.getElementsByTagName('iframe');
            for (let i = 0; i < frames.length; i++) try { frames[i].contentWindow?.postMessage(msg, '*'); } catch(e) {}
        };

        const applyUpdate = (payload, fromRemote = false) => {
            for (const [cat, data] of Object.entries(payload || {})) {
                for (const [key, val] of Object.entries(data || {})) {
                    const path = `${cat}.${key}`;
                    if (!IS_TOP && fromRemote && LOCAL_ONLY.has(path)) continue;
                    state[cat][key] = val;
                    emit(path, val);
                }
            }
        };

        window.addEventListener('message', (e) => {
            if (e.data?.ch !== 'vsc-sync' || e.data.type !== 'state') return;
            const mid = e.data.mid;
            if (mid && seenKey(mid)) return;

            applyUpdate(e.data.payload, true);

            // Relay
            const msg = { ch:'vsc-sync', type:'state', payload: stripLocal(e.data.payload), mid: mid || `${VSC_ID}:${Date.now()}` };
            postToChildFrames(msg);
        });

        const set = (path, val) => {
            const [cat, key] = path.split('.');
            if (state[cat][key] === val) return;
            state[cat][key] = val;
            emit(path, val);

            if (LOCAL_ONLY.has(path)) return;

            const payload = { [cat]: { [key]: val } };
            const msg = { ch:'vsc-sync', type:'state', payload, mid: `${VSC_ID}:${Date.now()}:${Math.random()}` };

            if (!IS_TOP) try { window.parent?.postMessage(msg, '*'); } catch(e) {}
            postToChildFrames({ ...msg, payload: stripLocal(payload) });
        };

        return {
            get: (path) => path.split('.').reduce((o, k) => o?.[k], state),
            set,
            batch: (cat, obj) => {
                const patch = {};
                for (const [k, v] of Object.entries(obj)) {
                    const path = `${cat}.${k}`;
                    state[cat][k] = v; emit(path, v);
                    if (!LOCAL_ONLY.has(path)) (patch[cat] ||= {})[k] = v;
                }
                const msg = { ch:'vsc-sync', type:'state', payload: patch, mid: `${VSC_ID}:${Date.now()}` };
                if (!IS_TOP) try { window.parent?.postMessage(msg, '*'); } catch(e) {}
                postToChildFrames(msg);
            },
            sub: (key, fn) => { if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
            state
        };
    });

    // 4. Worker
    const WORKER_SRC = `
    const hist = new Uint16Array(256);
    self.onmessage = function(e) {
        const { buf, width: w, height: h, step } = e.data;
        const data = new Uint8ClampedArray(buf); hist.fill(0);
        let sumL=0, sumSq=0, count=0, clip=0;
        const botStart = h - Math.floor(h*0.2);
        for(let y=0; y<h; y+=step) {
            const isBot = y >= botStart;
            for(let x=0; x<w; x+=step) {
                const i = (y*w+x)*4;
                const l = (data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8;
                hist[l]++; count++; sumL+=l; sumSq+=l*l;
                if (isBot && l >= 253) clip++;
            }
        }
        if (count===0) return;
        const inv = 1/count; const avg = (sumL*inv)/255;
        const std = Math.sqrt(Math.max(0, (sumSq*inv)/(255*255)-(avg*avg)));
        const clipFrac = clip/count;
        let p10=-1, p50=-1, p90=-1, p98=-1, sum=0;
        const t10=count*0.1, t50=count*0.5, t90=count*0.9, t98=count*0.98;
        for(let i=0; i<256; i++) {
            sum+=hist[i];
            if(p10<0 && sum>=t10) p10=i/255; if(p50<0 && sum>=t50) p50=i/255;
            if(p90<0 && sum>=t90) p90=i/255; if(p98<0 && sum>=t98) p98=i/255;
        }
        self.postMessage({ fid: e.data.fid, p10, p50, p90, p98, std, clipFrac });
    };`;

    // 5. AE Logic
    def('AE', () => {
        const { clamp, smooth01 } = use('Utils');
        const gate = (v, lo, hi) => smooth01(clamp((v - lo) / (hi - lo), 0, 1));
        const computeBase = (vf, auto) => {
            const ae = !!vf.ae;
            return {
                sharp: vf.sharp, sharp2: vf.sharp2, temp: vf.temp, clarity: vf.clarity, dither: vf.dither,
                gain: ae ? (auto.gain || 1.0) : 1.0,
                gamma: clamp(vf.gamma * (ae ? (auto.gamma || 1.0) : 1.0), 0.5, 2.5),
                bright: vf.bright + (ae ? (auto.bright || 0) : 0),
                shadows: vf.shadows + (ae ? (auto.shadows || 0) : 0),
                highlights: vf.highlights + (ae ? (auto.highlights || 0) : 0),
                contrast: vf.contrast, sat: vf.sat
            };
        };
        const tune = (base, m) => {
            if (base.gain <= 1.0) return base;
            const ev = clamp(Math.log2(base.gain) / 1.6, 0, 1);
            const p90 = clamp(m.p90 || 0, 0, 1); const p50 = clamp(m.p50 ?? (p90 - 0.3), 0, 1); const p10 = clamp(m.p10 || 0, 0, 1);
            const hiG = gate(p90, 0.84, 0.96); const midG = gate(p50, 0.60, 0.75); const darkG = gate(0.18 - p10, 0.0, 0.15);
            return {
                ...base,
                contrast: base.contrast + (ev * 0.04 * (1 - hiG)),
                shadows: base.shadows + (ev * (IS_MOBILE?10:14) * darkG * (1 - hiG * 0.4)),
                highlights: base.highlights + (ev * (IS_MOBILE?6:8) * hiG),
                bright: base.bright + (ev * (IS_MOBILE?10:12) * (1 - hiG * 0.7)),
                gamma: base.gamma * (1 - (ev * 0.04 * (1 - midG * 0.7)))
            };
        };
        const finalize = (s, vf) => ({
            ...s, contrast: clamp(s.contrast, 0.85, 1.35), sat: clamp(s.sat, 85, 135),
            highlights: clamp(s.highlights, -40, 40), shadows: clamp(s.shadows, -40, 40),
            bright: clamp(s.bright, -30, 30), gamma: clamp(s.gamma, 0.6, 2.0),
            dither: (IS_MOBILE && s.gain > 1.35) ? Math.min(vf.dither, 50) : vf.dither
        });
        return { computeBase, tune, finalize };
    });

    // 6. Filters (SEPARATED Video/Image Contexts)
    def('Filters', () => {
        const { h, clamp } = use('Utils');
        const INSTANCE = VSC_ID;
        const ctxMap = new WeakMap();

        const tables = {
            clarity: (v) => { const s = (v||0)/50; return Array.from({length:64}, (_,i)=>{ const x=i/63; return (x*(1-s) + (x*x*(3-2*x))*s).toFixed(4); }).join(' '); },
            gamma: (g, b) => { const gg=(g>0?g:1), bb=(b||0); const e=1/gg; return Array.from({length:64}, (_,i)=>{ let x=i/63; x=Math.pow(x,e)+(bb/100); return clamp(x,0,1).toFixed(3); }).join(' '); }
        };

        const buildVideoSvg = (doc, id) => {
            const chain = [
                h('feComponentTransfer', { ns:'svg', in:'SourceGraphic', result:'clarity' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':'clarity' }))),
                h('feGaussianBlur', { ns:'svg', in:'clarity', stdDeviation:'0', result:'blurFine', 'data-id':'blurFine' }),
                h('feComposite', { ns:'svg', in:'clarity', in2:'blurFine', operator:'arithmetic', k2:'1', k3:'0', result:'sharpFine', 'data-id':'compFine' }),
                h('feGaussianBlur', { ns:'svg', in:'sharpFine', stdDeviation:'0', result:'blurCoarse', 'data-id':'blurCoarse' }),
                h('feComposite', { ns:'svg', in:'sharpFine', in2:'blurCoarse', operator:'arithmetic', k2:'1', k3:'0', result:'sharpFinal', 'data-id':'compCoarse' }),
                h('feTurbulence', { ns:'svg', type:'fractalNoise', baseFrequency:'0.8', numOctaves:'1', stitchTiles:'noStitch', result:'noise', 'data-id':'noise' }),
                h('feComposite', { ns:'svg', in:'sharpFinal', in2:'noise', operator:'arithmetic', k2:'1', k3:'0', result:'grain', 'data-id':'grain' }),
                h('feColorMatrix', { ns:'svg', in:'grain', type:'matrix', values:'1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0', result:'luma', 'data-id':'luma' }),
                h('feColorMatrix', { ns:'svg', in:'luma', type:'saturate', values:'1', result:'sat', 'data-id':'sat' }),
                h('feComponentTransfer', { ns:'svg', in:'sat', result:'gamma' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':'gamma' }))),
                h('feComponentTransfer', { ns:'svg', in:'gamma', result:'out' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'linear', slope:'1', 'data-id':`ct-${c}` })))
            ];
            const svg = h('svg', { id, style: 'display:none;width:0;height:0;position:absolute;' },
                h('filter', { ns:'svg', id: `${id}-f`, x:'-20%', y:'-20%', width:'140%', height:'140%', 'color-interpolation-filters':'sRGB' }, chain)
            );
            (doc.body || doc.documentElement).appendChild(svg);
            return svg;
        };

        const buildImageSvg = (doc, id) => {
            const chain = [
                h('feComponentTransfer', { ns:'svg', in:'SourceGraphic', result:'clarity' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':'clarity' }))),
                h('feGaussianBlur', { ns:'svg', in:'clarity', stdDeviation:'0', result:'blurFine', 'data-id':'blurFine' }),
                h('feComposite', { ns:'svg', in:'clarity', in2:'blurFine', operator:'arithmetic', k2:'1', k3:'0', result:'sharpFine', 'data-id':'compFine' }),
                h('feGaussianBlur', { ns:'svg', in:'sharpFine', stdDeviation:'0', result:'blurCoarse', 'data-id':'blurCoarse' }),
                h('feComposite', { ns:'svg', in:'sharpFine', in2:'blurCoarse', operator:'arithmetic', k2:'1', k3:'0', result:'sharpFinal', 'data-id':'compCoarse' }),
                h('feComponentTransfer', { ns:'svg', in:'sharpFinal', result:'out' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'linear', slope:'1', 'data-id':`ct-${c}` })))
            ];
            const svg = h('svg', { id, style: 'display:none;width:0;height:0;position:absolute;' },
                h('filter', { ns:'svg', id: `${id}-f`, x:'-20%', y:'-20%', width:'140%', height:'140%', 'color-interpolation-filters':'sRGB' }, chain)
            );
            (doc.body || doc.documentElement).appendChild(svg);
            return svg;
        };

        const ensure = (doc, kind) => {
            let pack = ctxMap.get(doc);
            if (!pack) { pack = {}; ctxMap.set(doc, pack); }
            if (pack[kind]?.svg?.isConnected) return pack[kind];

            const svgId = `vsc-f-${INSTANCE}-${kind}`;
            let svg = doc.getElementById(svgId);
            if (!svg) svg = (kind === 'v') ? buildVideoSvg(doc, svgId) : buildImageSvg(doc, svgId);

            pack[kind] = { svg, filterId: `${svgId}-f`, cache: new Map() };
            return pack[kind];
        };

        const setAttr = (ctx, id, attr, val) => {
            let els = ctx.cache.get(id);
            if (!els) { els = ctx.svg.querySelectorAll(`[data-id="${id}"]`); ctx.cache.set(id, els); }
            els.forEach(el => el.setAttribute(attr, val));
        };

        return {
            update: (media, s) => {
                if (!media?.isConnected) return;
                const doc = media.ownerDocument || document;
                const isImg = (media.tagName === 'IMG') || !!s?.isImg;
                const ctx = ensure(doc, isImg ? 'i' : 'v');

                const url = `url(#${ctx.filterId})`;
                if (media.style.filter !== url) {
                    media.style.setProperty('filter', url, 'important');
                    media.style.setProperty('-webkit-filter', url, 'important');
                }

                const sCurve = (x) => x * x * (3 - 2 * x);
                const updateSharpen = (sharp, sharp2) => {
                    const strFine = Math.min(3.0, (sharp2 || 0) * 0.06);
                    const sigmaF = strFine > 0 ? (0.5 - (sCurve(Math.min(1, strFine/3.0)) * 0.3)) : 0;
                    setAttr(ctx, 'blurFine', 'stdDeviation', sigmaF.toFixed(2));
                    const kF = sCurve(Math.min(1, strFine/3.0))*3.5;
                    setAttr(ctx, 'compFine', 'k2', (1 + kF).toFixed(3)); setAttr(ctx, 'compFine', 'k3', (-kF).toFixed(3));

                    const strCoarse = Math.min(3.0, (sharp || 0) * 0.05);
                    const sigmaC = strCoarse > 0 ? (1.5 - (sCurve(Math.min(1, strCoarse/3.0)) * 0.8)) : 0;
                    setAttr(ctx, 'blurCoarse', 'stdDeviation', sigmaC.toFixed(2));
                    const kC = sCurve(Math.min(1, strCoarse/3.0))*2.0;
                    setAttr(ctx, 'compCoarse', 'k2', (1 + kC).toFixed(3)); setAttr(ctx, 'compCoarse', 'k3', (-kC).toFixed(3));
                };

                if (isImg) {
                    const lvl = clamp((s?.level ?? 0), 0, 30);
                    updateSharpen(lvl * 1.6, lvl * 1.2);
                    const t = s?.temp || 0;
                    setAttr(ctx, 'ct-R', 'slope', (1 + (t>0?t*0.003:0) - (t<0?-t*0.005:0)).toFixed(3));
                    setAttr(ctx, 'ct-B', 'slope', (1 - (t>0?t*0.006:0) + (t<0?-t*0:0)).toFixed(3));
                    return;
                }

                updateSharpen(s?.sharp, s?.sharp2);
                if (s.clarity !== undefined) setAttr(ctx, 'clarity', 'tableValues', tables.clarity(s.clarity));

                setAttr(ctx, 'grain', 'k3', ((s.dither||0)/400).toFixed(3));
                setAttr(ctx, 'sat', 'values', ((s.sat||100)/100).toFixed(2));

                const c = ((s.contrast||1) - 1) * 0.9;
                setAttr(ctx, 'luma', 'values', [1+c*0.2, c*0.7, c*0.07, 0, 0,  c*0.2, 1+c*0.7, c*0.07, 0, 0,  c*0.2, c*0.7, 1+c*0.07, 0, 0,  0, 0, 0, 1, 0].join(' '));

                setAttr(ctx, 'gamma', 'tableValues', tables.gamma(s.gamma, s.bright));

                const t = s.temp || 0;
                setAttr(ctx, 'ct-R', 'slope', (1 + (t>0?t*0.003:0) - (t<0?-t*0.005:0)).toFixed(3));
                setAttr(ctx, 'ct-B', 'slope', (1 - (t>0?t*0.006:0) + (t<0?-t*0:0)).toFixed(3));
            }
        };
    });

    // 7. Analyzer (Prevent Duplicate Attach)
    def('Analyzer', () => {
        let worker, canvas, ctx, url, busy = false, lastT = 0, fId = 0;
        const attached = new WeakSet();

        const init = () => {
            if (worker) return; const blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
            url = URL.createObjectURL(blob); worker = new Worker(url);
            worker.onmessage = (e) => { busy = false; if (e.data.fid < fId) return; document.dispatchEvent(new CustomEvent('vsc-ae', { detail: e.data })); };
            const size = IS_LOW_END ? 24 : 32;
            try { canvas = new OffscreenCanvas(size, size); } catch(e) { canvas = document.createElement('canvas'); canvas.width=size; canvas.height=size; }
            ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
        };

        const process = (v) => {
            if (!v || v.paused || document.hidden || busy) return; if (!worker) init();
            const now = performance.now(); if (now - lastT < 200) return; lastT = now;
            try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); const d = ctx.getImageData(0,0,canvas.width,canvas.height); busy=true; worker.postMessage({ buf:d.data.buffer, width:canvas.width, height:canvas.height, fid:++fId, step:IS_MOBILE?2:1 }, [d.data.buffer]); } catch(e){ busy=false; }
        };

        const attach = (v) => {
            if (!v || attached.has(v)) return;
            attached.add(v);
            const loop = () => {
                if (!v.isConnected) return;
                if (!v.paused && !document.hidden) { process(v); if(v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else setTimeout(loop, 250); }
                else setTimeout(loop, 1000);
            };
            if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else setTimeout(loop, 250);
        };
        return { attach };
    });

    // 8. UI Engine
    def('UI', () => {
        const { h } = use('Utils'); const sm = use('Store');
        let container, monitorEl, trigger;

        const SLIDERS = [
            { l:'감마', k:'video.gamma', min:0.5, max:2.5, s:0.05, f:v=>v.toFixed(2) }, { l:'대비', k:'video.contrast', min:0.5, max:2.0, s:0.05, f:v=>v.toFixed(2) },
            { l:'밝기', k:'video.bright', min:-50, max:50, s:1, f:v=>v.toFixed(0) }, { l:'채도', k:'video.sat', min:0, max:200, s:5, f:v=>v.toFixed(0) },
            { l:'윤곽', k:'video.sharp', min:0, max:50, s:1, f:v=>v.toFixed(0) }, { l:'디테일', k:'video.sharp2', min:0, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'명료', k:'video.clarity', min:0, max:50, s:5, f:v=>v.toFixed(0) }, { l:'색온도', k:'video.temp', min:-25, max:25, s:1, f:v=>v.toFixed(0) },
            { l:'그레인', k:'video.dither', min:0, max:100, s:5, f:v=>v.toFixed(0) }
        ];
        const PRESETS_B = [{l:'S',g:1.0,b:2,c:1.0}, {l:'M',g:1.1,b:4,c:1.0}, {l:'L',g:1.2,b:6,c:1.0}, {l:'DS',g:1.0,b:3.6,c:1.02}, {l:'DM',g:1.15,b:7.2,c:1.04}, {l:'DL',g:1.30,b:10.8,c:1.06}];

        const build = () => {
            if (container) return;
            const shadowHost = h('div', { id:`vsc-${Math.random()}`, style:'display:none' });
            const shadow = shadowHost.attachShadow({ mode:'open' });
            // [UI Style 수정본]
const style = `
    .main {
        position: fixed; top: 15%; right: 20px; width: 300px;
        background: rgba(20,20,20,0.95); backdrop-filter: blur(8px);
        color: #eee; padding: 12px; border-radius: 12px;
        z-index: 2147483647; display: flex; flex-direction: column;
        gap: 2px; /* 전체 요소들 사이 간격을 최소화해서 샤프/밝기처럼 붙임 */
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        border: 1px solid rgba(255,255,255,0.1);
        font-family: sans-serif; font-size: 12px;
    }

    /* 상단 버튼들(닫기, 자동, 부스트 / 리셋, Power)을 꽉 차게 배치 */
    .prow {
        display: flex;
        gap: 2px;
        margin: 0;
        width: 100%;
    }

    /* 각 행의 버튼들이 동일한 비율로 틀에 꽉 차도록 설정 */
    .prow .btn, .prow .pbtn {
        flex: 1;
        text-align: center;
        padding: 6px 0;
        margin: 0;
    }

    .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        column-gap: 8px;
        row-gap: 4px; /* 슬라이더 간 위아래 간격도 적절히 좁힘 */
        margin-top: 4px;
    }

    .btn { background: #333; color: #ccc; border: 1px solid #444; cursor: pointer; border-radius: 6px; transition: 0.2s; font-size: 11px; }
    .btn:hover { background: #444; }
    .btn.active { background: #3498db; color: white; border-color: #2980b9; }

    .pbtn { background: #444; border: 1px solid #555; color: #ccc; cursor: pointer; border-radius: 4px; font-size: 11px; }
    .pbtn.active { background: #e67e22; color: white; }

    .slider { display: flex; flex-direction: column; color: #aaa; }
    .slider label { display: flex; justify-content: space-between; margin-bottom: 1px; }
    input[type=range] { width: 100%; accent-color: #3498db; cursor: pointer; margin: 2px 0; }

    .monitor { font-size: 11px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 6px; margin-top: 4px; white-space: pre-wrap; }
    .warn { color: #e74c3c; font-weight: bold; }

    hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 6px 0; }
`;
            const renderS = (cfg) => {
                const valEl = h('span', {}, '0'); const inp = h('input', { type:'range', min:cfg.min, max:cfg.max, step:cfg.s });
                const up = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, up); up(sm.get(cfg.k)); inp.oninput = () => sm.set(cfg.k, Number(inp.value));
                return h('div', { class:'slider' }, h('label', {}, cfg.l, valEl), inp);
            };
            const renderT = (l, k) => {
                const b = h('button', { class:'btn' }, l);
                sm.sub(k, v => b.classList.toggle('active', !!v)); b.classList.toggle('active', !!sm.get(k));
                b.onclick = () => sm.set(k, !sm.get(k)); return b;
            };
            const renderP = (label, items, key, on) => {
                const r = h('div', { class:'prow' }, h('div', {style:'font-size:10px;width:30px'}, label));
                items.forEach(it => {
                    const b = h('button', { class:'pbtn' }, it.l); b.onclick = () => { sm.set(key, it.l); on(it); };
                    sm.sub(key, v => b.classList.toggle('active', v === it.l)); r.append(b);
                });
                const off = h('button', { class:'pbtn' }, 'OFF'); off.onclick = () => { sm.set(key, 'off'); on(null); };
                sm.sub(key, v => off.classList.toggle('active', v === 'off')); r.append(off); return r;
            };

            const closeBtn = h('button', { class:'btn', onclick:(e)=>{ e.stopPropagation(); sm.set('app.uiVisible', false); } }, '✖ 닫기');
            const head = h('div', { class:'prow' }, closeBtn, renderT('🤖 자동', 'video.ae'), renderT('🔊 부스트', 'audio.enabled'));
            const r2 = h('div', { class:'prow' }, h('button', { class:'btn', onclick:()=>sm.batch('video', DEFAULTS.video) }, '↺ 리셋'), h('button', { class:'btn', onclick:()=>sm.set('app.active', !sm.get('app.active')) }, '⚡ Power'));
            sm.sub('app.active', v => r2.lastChild.style.color = v ? '#2ecc71' : '#e74c3c');

            const tabV = h('button', { class:'tab active' }, 'Video'); const tabI = h('button', { class:'tab' }, 'Image');
            const bodyV = h('div', {},
                renderP('샤프', [{l:'S',v1:8,v2:3},{l:'M',v1:15,v2:6},{l:'L',v1:25,v2:10},{l:'XL',v1:35,v2:15}], 'video.presetS', (it)=>sm.batch('video', it?{sharp:it.v1,sharp2:it.v2}:{sharp:0,sharp2:0})),
                renderP('밝기', PRESETS_B, 'video.presetB', (it)=>sm.batch('video', it?{gamma:it.g,bright:it.b,contrast:it.c}:{gamma:1,bright:0,contrast:1})),
                h('hr'),
                h('div', { class:'grid' }, SLIDERS.map(renderS))
            );
            const bodyI = h('div', { style:'display:none' }, h('div', { class:'grid' }, [{ l:'샤프닝', k:'image.level', min:0, max:30, s:1, f:v=>v.toFixed(0) }, { l:'색온도', k:'image.temp', min:-10, max:10, s:1, f:v=>v.toFixed(0) }].map(renderS)));

            const speedRow = h('div', { class:'prow', style:'justify-content:center' });
            [0.5, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 5.0].forEach(s => {
                const b = h('button', { class:'pbtn' }, s+'x'); b.onclick = () => sm.set('playback.rate', s);
                sm.sub('playback.rate', v => b.classList.toggle('active', Math.abs(v-s)<0.01)); speedRow.append(b);
            });

            monitorEl = h('div', { class:'monitor' }, 'Ready');
            const main = h('div', { class:'main' }, h('div', { style:'text-align:center;font-weight:bold;font-size:13px' }, 'VSC v132.106'), head, r2, bodyV, bodyI, h('hr'), speedRow, monitorEl);
            shadow.append(h('style', {}, style), main);
            container = shadowHost;
            (document.body || document.documentElement).appendChild(container);
            sm.sub('app.uiVisible', v => container.style.display = v ? 'block' : 'none');
        };

        trigger = h('div', {
            style: `position:fixed; top:40%; right:0; width:34px; height:34px; background:rgba(0,0,0,0.6); color:#fff; display:flex; justify-content:center; align-items:center; cursor:pointer; z-index:2147483647; border-radius:8px 0 0 8px; font-size:16px; user-select:none; backdrop-filter: blur(4px); transition: right 0.3s;`,
            onclick: () => { if (!container) build(); sm.set('app.uiVisible', !sm.get('app.uiVisible')); }
        }, '⚙️');

        let idleT;
        const wake = () => { trigger.style.right = '0'; clearTimeout(idleT); idleT = setTimeout(()=>trigger.style.right='-45px', 2500); };
        window.addEventListener('mousemove', wake); wake();

        const shouldShowHere = () => {
            if (IS_TOP) return true;
            return !!document.fullscreenElement;
        };

        const appendUI = () => {
            const show = shouldShowHere();
            trigger.style.display = show ? 'flex' : 'none';
            if (!show) { if (!IS_TOP && sm.get('app.uiVisible')) sm.set('app.uiVisible', false); return; }

            const root = document.fullscreenElement || document.body || document.documentElement;
            if (container && container.parentElement !== root) root.appendChild(container);
            if (trigger && trigger.parentElement !== root) root.appendChild(trigger);
        };
        document.addEventListener('fullscreenchange', appendUI); document.addEventListener('webkitfullscreenchange', appendUI); setInterval(appendUI, 800);

        if ('requestIdleCallback' in window) requestIdleCallback(build); else setTimeout(build, 200);

        return { update: (m, act) => { if(monitorEl && container && container.style.display!=='none') { monitorEl.textContent=m; monitorEl.style.color = act?'#4cd137':'#aaa'; } } };
    });

    // 9. Orchestrator
    const sm = use('Store'); const Logic = use('AE'); const FilterLib = use('Filters');
    const UI = use('UI');
    const { getRoots } = use('Utils');
    let lastAuto = { gain: 1.0 };

    document.addEventListener('vsc-ae', (e) => {
        if (!sm.get('video.ae')) return; const { gain, clipFrac } = e.detail;
        lastAuto = e.detail;
        if (sm.get('app.uiVisible')) { const ev = Math.log2(gain).toFixed(2); UI.update(`AE ON | EV: ${ev>0?'+':''}${ev} | Clip: ${(clipFrac*100).toFixed(1)}%`, true); }
        apply();
    });

    function apply() {
        const active = sm.get('app.active'); const vf = sm.get('video');
        const vals = active ? Logic.finalize(Logic.tune(Logic.computeBase(vf, lastAuto), lastAuto.p50?lastAuto:{}), vf) : Logic.computeBase(DEFAULTS.video, {});

        if (!vf.ae && sm.get('app.uiVisible')) UI.update(`Manual Mode\nGamma: ${vf.gamma.toFixed(2)} | Sharp: ${vf.sharp}`, false);

        getRoots().forEach(root => {
            const media = root.querySelectorAll ? root.querySelectorAll('video, img, canvas, iframe') : [];
            media.forEach(el => {
                if (el.tagName === 'IMG' && (el.width < 50)) return;
                if (el.tagName === 'IFRAME') return; // Handled by Store Sync

                FilterLib.update(el, el.tagName==='IMG' ? { ...sm.get('image'), isImg: true } : vals);
                if (el.tagName === 'VIDEO' && vf.ae && !el.paused) use('Analyzer').attach(el);
            });
        });
    }

    const rateUpdate = () => {
        const r = sm.get('playback.rate');
        getRoots().forEach(root => root.querySelectorAll('video').forEach(v => { if(Math.abs(v.playbackRate-r)>0.01) v.playbackRate=r; }));
    };

    sm.sub('video.*', apply); sm.sub('image.*', apply); sm.sub('app.active', apply); sm.sub('playback.rate', rateUpdate);
    sm.sub('audio.*', ()=>use('Utils').getRoots().forEach(r=>r.querySelectorAll('video').forEach(v=>{/*Audio*/})));

    setInterval(() => { if (sm.get('app.active')) { apply(); rateUpdate(); } }, 1000);
    console.log(`[VSC] v132.0.106 Loaded (${IS_TOP?'Master':'Slave'})`);
})();
