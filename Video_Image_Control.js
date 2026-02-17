// ==UserScript==
// @name         Video_Image_Control (v132.0.135 UI-Freeze-Fix)
// @namespace    https://github.com/
// @version      132.0.135
// @description  v132.135: Fix AE Freeze + Silent Background Sync + Registry Performance + V91 Logic
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (location.href.includes('/cdn-cgi/')) return;
    const VSC_KEY = '__VSC_LOCK__'; if (window[VSC_KEY]) return; window[VSC_KEY] = true;

    const IS_TOP = (window === window.top);
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const VSC_ID = Math.random().toString(36).slice(2);
    const VSC_MSG = 'vsc-ctrl-v1';

    const MIN_AE = {
        STRENGTH: IS_MOBILE ? 0.24 : 0.28,
        TAU_UP: 950, TAU_DOWN: 900,
        TARGET_MID_BASE: IS_MOBILE ? 0.26 : 0.30,
        MAX_UP_EV_DARK: IS_MOBILE ? 0.30 : 0.34
    };

    const DEFAULTS = {
        video: { gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, temp: 0, sharp: 0, sharp2: 0, dither: 0, clarity: 0, ae: false, presetS: 'off', presetB: 'brOFF' },
        image: { level: 15, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const M = {}; const def = (k, fn) => M[k] = fn(); const use = (k) => M[k];

    // 1. Utils
    def('Utils', () => ({
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        median5: (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length/2)] || 0; },
        h: (tag, props = {}, ...children) => {
            const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
            for (const [k, v] of Object.entries(props)) {
                if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), (e) => { if(k === 'onclick' && tag === 'button') e.stopPropagation(); v(e); });
                else if (k === 'style') { if(typeof v==='string') el.style.cssText=v; else Object.assign(el.style, v); }
                else if (k === 'class') el.className = v;
                else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
            }
            children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
            return el;
        }
    }));

    // 2. Registry (Optimized Observer)
    def('Registry', () => {
        const videos = new Set(), images = new Set(), seen = new WeakSet();
        const add = (n) => {
            if (!n || n.nodeType !== 1 || seen.has(n)) return;
            if (n.tagName === 'VIDEO') { videos.add(n); seen.add(n); }
            else if (n.tagName === 'IMG') { images.add(n); seen.add(n); }
            else { n.querySelectorAll?.('video').forEach(v => { if(!seen.has(v)){videos.add(v); seen.add(v);} }); n.querySelectorAll?.('img').forEach(i => { if(!seen.has(i)){images.add(i); seen.add(i);} }); }
        };
        const mo = new MutationObserver(ms => { for(const m of ms) m.addedNodes.forEach(add); window.dispatchEvent(new CustomEvent('vsc-ignite')); });
        const init = () => { if(document.body) { add(document.body); mo.observe(document.body, {childList:true, subtree:true}); } else setTimeout(init, 100); };
        init();
        try { const orig = Element.prototype.attachShadow; Element.prototype.attachShadow = function(i){ const sr = orig.call(this,i); add(sr); mo.observe(sr,{childList:true,subtree:true}); return sr; }; } catch(e){}
        return { videos, images, prune: () => { for(const v of videos) if(!v.isConnected) videos.delete(v); for(const i of images) if(!i.isConnected) images.delete(i); } };
    });

    // 3. Store (Silent AE Update - No Loopback)
    def('Store', () => {
        let state = JSON.parse(JSON.stringify(DEFAULTS));
        const listeners = new Map();
        const LOCAL_ONLY = new Set(['app.uiVisible', 'app.tab', 'video.gain']); // gain은 통신에서 제외 (렉 방지)
        
        const emit = (key, val) => { listeners.get(key)?.forEach(cb => cb(val)); const cat = key.split('.')[0]; listeners.get(cat + '.*')?.forEach(cb => cb(val)); };
        const postToFrames = (msg) => {
            msg.sender = VSC_ID;
            if (!IS_TOP) window.parent?.postMessage(msg, '*');
            const frames = document.getElementsByTagName('iframe');
            for (let i = 0; i < frames.length; i++) try { frames[i].contentWindow?.postMessage(msg, '*'); } catch(e){}
        };

        window.addEventListener('message', (e) => {
            if (e.data?.ch !== VSC_MSG || e.data.type !== 'state' || e.data.sender === VSC_ID) return;
            const payload = e.data.payload;
            for (const [cat, data] of Object.entries(payload || {})) {
                for (const [key, val] of Object.entries(data || {})) {
                    if (LOCAL_ONLY.has(`${cat}.${key}`)) continue;
                    if (state[cat][key] !== val) { state[cat][key] = val; emit(`${cat}.${key}`, val); }
                }
            }
            window.dispatchEvent(new CustomEvent('vsc-ignite-fast'));
        });

        return { 
            get: (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), state), 
            set: (path, val) => {
                const [cat, key] = path.split('.'); if (state[cat][key] === val) return;
                state[cat][key] = val; emit(path, val);
                if (!LOCAL_ONLY.has(path)) postToFrames({ ch: VSC_MSG, type:'state', payload: { [cat]: { [key]: val } } });
            },
            batch: (cat, obj) => {
                const changed = {};
                for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; changed[k] = v; emit(`${cat}.${k}`, v); } }
                if (Object.keys(changed).length > 0) postToFrames({ ch: VSC_MSG, type:'state', payload: { [cat]: changed } });
            },
            sub: (k, f) => { if(!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(f); }
        };
    });

    // 4. Audio
    def('Audio', () => {
        let ctx, compressor, dry, wet; const sm = use('Store');
        const updateMix = () => {
            if (!ctx) return; const active = sm.get('app.active'), enabled = active && sm.get('audio.enabled'), boost = sm.get('audio.boost');
            if (ctx.state === 'suspended') ctx.resume(); const t = ctx.currentTime;
            dry.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.05); wet.gain.setTargetAtTime(enabled ? Math.pow(10, boost / 20) : 0, t, 0.05);
        };
        return { attach: (v) => { if (!v || v.tagName !== 'VIDEO' || v.__vsc_audio) return; try { const AC = window.AudioContext || window.webkitAudioContext; if (!ctx) { ctx = new AC(); compressor = ctx.createDynamicsCompressor(); dry = ctx.createGain(); dry.connect(ctx.destination); wet = ctx.createGain(); compressor.connect(wet); wet.connect(ctx.destination); } const source = ctx.createMediaElementSource(v); source.connect(dry); source.connect(compressor); v.__vsc_audio = true; updateMix(); } catch(e) {} }, update: updateMix };
    });

    // 5. Analyzer (Worker Optimization)
    def('Analyzer', () => {
        let worker, canvas, ctx, busy = false, fId = 0, lastApplyT = performance.now(), curGain = 1.0, roiP50 = [];
        const init = () => {
            if (worker) return;
            const blob = new Blob([`self.onmessage=e=>{
                const {buf,w,h,fid}=e.data; const data=new Uint8Array(buf);
                const x0=(w*0.25)|0, x1=(w*0.75)|0, y0=(h*0.25)|0, y1=(h*0.75)|0;
                const hist=new Uint32Array(256); let n=0;
                for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){ const i=(y*w+x)*4; hist[(data[i]*54+data[i+1]*183+data[i+2]*19)>>8]++; n++; }
                let p50=-1, sum=0; for(let i=0;i<256;i++){ sum+=hist[i]; if(p50<0 && sum>=n*0.5) p50=i/255; }
                self.postMessage({fid, p50: p50<0 ? 0.25 : p50});
            };`], { type: 'text/javascript' });
            worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => { 
                busy = false; const now = performance.now();
                roiP50.push(e.data.p50); if(roiP50.length > 5) roiP50.shift();
                const p50m = use('Utils').median5(roiP50);
                const autoEV = use('Utils').clamp(Math.log2(MIN_AE.TARGET_MID_BASE / Math.max(0.02, p50m)) * MIN_AE.STRENGTH, 0, MIN_AE.MAX_UP_EV_DARK);
                const targetGain = Math.pow(2, autoEV);
                const alpha = 1 - Math.exp(-(now - lastApplyT) / (targetGain > curGain ? MIN_AE.TAU_UP : MIN_AE.TAU_DOWN));
                curGain += (targetGain - curGain) * alpha; lastApplyT = now;
                document.dispatchEvent(new CustomEvent('vsc-ae-res', { detail: { gain: curGain } }));
            };
            canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; ctx = canvas.getContext('2d', { alpha: false });
        };
        return { 
            attach: (v) => { if (!v || v.__vsc_attached) return; v.__vsc_attached = true; init(); const loop = () => { if (!v.isConnected) return; if (!v.paused && !document.hidden && !busy && use('Store').get('video.ae') && use('Store').get('app.active')) { try { if (v.readyState >= 2) { ctx.drawImage(v, 0, 0, 32, 32); const d = ctx.getImageData(0,0,32,32); busy=true; worker.postMessage({buf:d.data.buffer, w:32, h:32, fid:++fId}, [d.data.buffer]); } } catch(e) { busy = false; } } setTimeout(loop, 250); }; loop(); },
            wake: () => { busy = false; }
        };
    });

    // 6. Filters
    def('Filters', () => {
        const { h, clamp } = use('Utils'); const ctxMap = new WeakMap();
        const sCurve = (x) => x * x * (3 - 2 * x);
        function buildSvg(doc) {
            const baseId = `vsc-f-${VSC_ID}`;
            const svg = h('svg', { ns:'svg', width:'0', height:'0', style:'position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;', 'aria-hidden':'true' });
            const defs = h('defs', { ns:'svg' }); svg.append(defs);
            const makeFilter = (suffix) => {
                const fid = `${baseId}-${suffix}`;
                const filter = h('filter', { ns:'svg', id:fid, x:'-20%', y:'-20%', width:'140%', height:'140%', colorInterpolationFilters:'sRGB' });
                const sat = h('feColorMatrix', { ns:'svg', type:'saturate', values:'1', 'data-id':'sat' });
                const lin = h('feComponentTransfer', { ns:'svg', result:'lin' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'linear', slope:'1', intercept:'0', 'data-id':`lin${c}` })));
                const gam = h('feComponentTransfer', { ns:'svg', result:'gam' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'gamma', exponent:'1', 'data-id':`gm${c}` })));
                const tmp = h('feComponentTransfer', { ns:'svg', result:'tmp' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'linear', 'data-id':`tp${c}` })));
                const b1 = h('feGaussianBlur', { ns:'svg', in:'tmp', stdDeviation:'0', result:'b1', 'data-id':'b1' });
                const sh1 = h('feComposite', { ns:'svg', in:'tmp', in2:'b1', operator:'arithmetic', k2:'1', 'data-id':'sh1', result:'sh1' });
                const b2 = h('feGaussianBlur', { ns:'svg', in:'sh1', stdDeviation:'0', result:'b2', 'data-id':'b2' });
                const sh2 = h('feComposite', { ns:'svg', in:'sh1', in2:'b2', operator:'arithmetic', k2:'1', 'data-id':'sh2', result:'sh2' });
                const bc = h('feGaussianBlur', { ns:'svg', in:'sh2', stdDeviation:'0', result:'bc', 'data-id':'bc' });
                const cl = h('feComposite', { ns:'svg', in:'sh2', in2:'bc', operator:'arithmetic', k2:'1', 'data-id':'cl', result:'cl' });
                const turb = h('feTurbulence', { ns:'svg', type:'fractalNoise', baseFrequency:'0.85', result:'noise' });
                const gr = h('feComposite', { ns:'svg', in:'cl', in2:'noise', operator:'arithmetic', k2:'1', k3:'0', 'data-id':'gr' });
                filter.append(sat, lin, gam, tmp, b1, sh1, b2, sh2, bc, cl, turb, gr); defs.append(filter);
                return { fid, sat, lin, gam, tmp, b1, sh1, b2, sh2, bc, cl, gr, lastKey:'' };
            };
            const video = makeFilter('v'), image = makeFilter('i'); (doc.body || doc.documentElement).appendChild(svg); return { svg, video, image };
        }
        function updateNodes(nodes, s) {
            const key = `${s.gamma}|${s.contrast}|${s.bright}|${s.sat}|${s.sharp}|${s.sharp2}|${s.clarity}|${s.dither}|${s.temp}`;
            if (nodes.lastKey === key) return; nodes.lastKey = key;
            const qs = (el, attr, val) => el.setAttribute(attr, val);
            qs(nodes.sat, 'values', (s.sat/100).toFixed(2));
            const con = clamp(s.contrast||1.0, 0.5, 2.0), bri = clamp((s.bright||0)/255, -0.25, 0.25), inter = 0.5 - 0.5 * con + bri;
            ['R','G','B'].forEach(c => { const el = nodes.lin.querySelector(`[data-id="lin${c}"]`); qs(el, 'slope', con.toFixed(3)); qs(el, 'intercept', inter.toFixed(4)); });
            const exp = (1 / clamp(s.gamma||1.0, 0.2, 3.0)).toFixed(3);
            ['R','G','B'].forEach(c => qs(nodes.gam.querySelector(`[data-id="gm${c}"]`), 'exponent', exp));
            const t = clamp(s.temp||0, -25, 25); let r=1, g=1, b=1; if(t>0){ r=1+t*0.012; g=1+t*0.003; b=1-t*0.010; } else { const k=-t; b=1+k*0.012; g=1+k*0.003; r=1-k*0.010; }
            qs(nodes.tmp.querySelector('[data-id="tpR"]'), 'slope', r.toFixed(3)); qs(nodes.tmp.querySelector('[data-id="tpG"]'), 'slope', g.toFixed(3)); qs(nodes.tmp.querySelector('[data-id="tpB"]'), 'slope', b.toFixed(3));
            const v1 = (s.sharp||0)/50, sigmaC = v1 > 0 ? (1.5 - (sCurve(Math.min(1, v1)) * 0.8)) : 0, kC = sCurve(Math.min(1, v1)) * 2.0;
            qs(nodes.b1, 'stdDeviation', sigmaC.toFixed(2)); qs(nodes.sh1, 'k2', (1 + kC).toFixed(3)); qs(nodes.sh1, 'k3', (-kC).toFixed(3));
            const v2 = (s.sharp2||0)/50, sigmaF = v2 > 0 ? (0.5 - (sCurve(Math.min(1, v2)) * 0.3)) : 0, kF = sCurve(Math.min(1, v2)) * 3.5;
            qs(nodes.b2, 'stdDeviation', sigmaF.toFixed(2)); qs(nodes.sh2, 'k2', (1 + kF).toFixed(3)); qs(nodes.sh2, 'k3', (-kF).toFixed(3));
            const cl = (s.clarity||0)/50; qs(nodes.bc, 'stdDeviation', cl>0?'2.2':'0'); qs(nodes.cl, 'k2', 1+cl); qs(nodes.cl, 'k3', -cl);
            qs(nodes.gr, 'k3', ((s.dither||0)/100 * 0.22).toFixed(3));
        }
        return { 
            update: (el, s, kind) => {
                const doc = el.ownerDocument || document; let ctx = ctxMap.get(doc); if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
                const nodes = (kind === 'image') ? ctx.image : ctx.video;
                const url = `url(#${nodes.fid})`; if (el.style.filter !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }
                updateNodes(nodes, s);
            },
            clear: (el) => { if (el.style.filter) { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); } }
        };
    });

    // 7. UI Engine
    def('UI', () => {
        const { h } = use('Utils'); const sm = use('Store'); let container, monitorEl, trigger;
        const SLIDERS = [
            { l:'감마', k:'video.gamma', min:0.5, max:2.5, s:0.05, f:v=>v.toFixed(2) }, { l:'대비', k:'video.contrast', min:0.5, max:2.0, s:0.05, f:v=>v.toFixed(2) },
            { l:'밝기', k:'video.bright', min:-50, max:50, s:1, f:v=>v.toFixed(0) }, { l:'채도', k:'video.sat', min:0, max:200, s:5, f:v=>v.toFixed(0) },
            { l:'윤곽', k:'video.sharp', min:0, max:50, s:1, f:v=>v.toFixed(0) }, { l:'디테일', k:'video.sharp2', min:0, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'명료', k:'video.clarity', min:0, max:50, s:5, f:v=>v.toFixed(0) }, { l:'색온도', k:'video.temp', min:-25, max:25, s:1, f:v=>v.toFixed(0) },
            { l:'그레인', k:'video.dither', min:0, max:100, s:5, f:v=>v.toFixed(0) }, { l:'오디오증폭', k:'audio.boost', min:0, max:12, s:1, f:v=>`+${v}dB` }
        ];
        const PRESETS_B = [{txt:'S',g:1.0,b:2,c:1.0,s:100,key:'brS'},{txt:'M',g:1.1,b:4,c:1.0,s:102,key:'brM'},{txt:'L',g:1.2,b:6,c:1.0,s:104,key:'brL'},{txt:'DS',g:1.0,b:3.6,c:1.02,s:100,key:'brDS'},{txt:'DM',g:1.15,b:7.2,c:1.04,s:101,key:'brDM'},{txt:'DL',g:1.30,b:10.8,c:1.06,s:102,key:'brDL'}];

        const build = () => {
            if (container) return; const host = h('div', { id:'vsc-host' }); const shadow = host.attachShadow({ mode:'open' });
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
                @media (max-height: 450px) and (orientation: landscape) { .main { top: 5%; right: 50px; width: 360px; padding: 8px; max-height: 90vh; } .tab { padding: 6px; font-size: 12px; } .grid { row-gap: 4px; } hr { margin: 6px 0; } }
            `;
            const renderS = (cfg) => {
                const valEl = h('span', {style:'color:#3498db'}, '0'); const inp = h('input', { type:'range', min:cfg.min, max:cfg.max, step:cfg.s });
                const up = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, up); up(sm.get(cfg.k)); inp.oninput = (e) => { e.stopPropagation(); sm.set(cfg.k, Number(inp.value)); };
                return h('div', { class:'slider' }, h('label', {}, cfg.l, valEl), inp);
            };
            const renderP = (label, items, key, on) => {
                const r = h('div', { class:'prow' }, h('div', {style:'font-size:11px;width:35px;line-height:34px;font-weight:bold'}, label));
                items.forEach(it => { const b = h('button', { class:'pbtn', style:'flex:1' }, it.l || it.txt); b.onclick = (e) => { e.stopPropagation(); sm.set(key, it.l || it.txt); on(it); }; sm.sub(key, v => b.classList.toggle('active', v === (it.l || it.txt))); r.append(b); });
                const off = h('button', { class:'pbtn', style:'flex:1' }, 'OFF'); off.onclick = (e) => { e.stopPropagation(); sm.set(key, 'off'); on(null); }; 
                sm.sub(key, v => off.classList.toggle('active', v === 'off')); r.append(off); return r;
            };

            const bodyV = h('div', { id:'p-v' }, [
                h('div', { class:'prow' }, h('button', { class:'btn', onclick:()=>sm.set('app.uiVisible', false) }, '✕ 닫기'), h('button', { id:'ae-btn', class:'btn', onclick:()=>sm.set('video.ae', !sm.get('video.ae')) }, '🤖 자동'), h('button', { id:'boost-btn', class:'btn', onclick:()=>sm.set('audio.enabled', !sm.get('audio.enabled')) }, '🔊 부스트')),
                h('div', { class:'prow' }, h('button', { class:'btn', onclick:()=>{ sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); } }, '↺ 리셋'), h('button', { id:'pwr-btn', class:'btn', onclick:()=>sm.set('app.active', !sm.get('app.active')) }, '⚡ Power')),
                renderP('샤프', [{l:'S',v1:8,v2:3},{l:'M',v1:15,v2:6},{l:'L',v1:25,v2:10},{l:'XL',v1:35,v2:15}], 'video.presetS', (it)=>sm.batch('video', {sharp:it?it.v1:0,sharp2:it?it.v2:0})),
                renderP('밝기', PRESETS_B, 'video.presetB', (it)=>sm.batch('video', {gamma:it?it.g:1.0,bright:it?it.b:0,contrast:it?it.c:1.0,sat:it?it.s:100})),
                h('hr'), h('div', { class:'grid' }, SLIDERS.map(renderS)), h('hr'), 
                h('div', { class:'prow', style:'justify-content:center;gap:4px;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class:'pbtn', style:'flex:1;min-height:36px;' }, s+'x'); b.onclick = (e) => { e.stopPropagation(); sm.set('playback.rate', s); }; sm.sub('playback.rate', v => b.classList.toggle('active', Math.abs(v-s)<0.01)); return b; }))
            ]);
            const bodyI = h('div', { id:'p-i', style:'display:none' }, [ h('div', { class:'grid' }, [ renderS({l:'이미지 윤곽', k:'image.level', min:0, max:50, s:1, f:v=>v.toFixed(0)}), renderS({l:'이미지 색온도', k:'image.temp', min:-20, max:20, s:1, f:v=>v.toFixed(0)}) ]) ]);
            shadow.append(h('style', {}, style), h('div', { class:'main' }, [ h('div', { class:'tabs' }, [h('button', { id:'t-v', class:'tab active', onclick:()=>sm.set('app.tab', 'video') }, 'VIDEO'), h('button', { id:'t-i', class:'tab', onclick:()=>sm.set('app.tab', 'image') }, 'IMAGE')]), bodyV, bodyI, monitorEl = h('div', { class:'monitor' }, 'Ready') ]));
            sm.sub('app.tab', v => { shadow.getElementById('t-v').classList.toggle('active', v==='video'); shadow.getElementById('t-i').classList.toggle('active', v==='image'); shadow.getElementById('p-v').style.display = v==='video' ? 'block' : 'none'; shadow.getElementById('p-i').style.display = v==='image' ? 'block' : 'none'; });
            sm.sub('video.ae', v => shadow.getElementById('ae-btn').classList.toggle('active', !!v)); sm.sub('audio.enabled', v => shadow.getElementById('boost-btn').classList.toggle('active', !!v)); sm.sub('app.active', v => shadow.getElementById('pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
            container = host; (document.body || document.documentElement).appendChild(container); sm.sub('app.uiVisible', v => container.style.display = v ? 'block' : 'none');
        };
        trigger = h('div', { style:'position:fixed;top:45%;right:0;width:44px;height:44px;background:rgba(0,0,0,0.7);z-index:2147483647;cursor:pointer;display:none;align-items:center;justify-content:center;border-radius:12px 0 0 12px;color:#fff;font-size:22px;', onclick:()=>{ build(); sm.set('app.uiVisible', !sm.get('app.uiVisible')); } }, '⚙️');
        const syncUI = () => { const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement); trigger.style.display = (IS_TOP || isFs) ? 'flex' : 'none'; const root = document.fullscreenElement || document.body || document.documentElement; if (root) { if (trigger.parentElement !== root) root.appendChild(trigger); if (container && container.parentElement !== root) root.appendChild(container); } };
        setInterval(syncUI, 1000); return { update: (m, act) => { if(monitorEl && container?.style.display!=='none') { monitorEl.textContent=m; monitorEl.style.color = act?'#4cd137':'#aaa'; } } };
    });

    // 8. Orchestrator
    const sm = use('Store'), Filters = use('Filters'), UI = use('UI'), Audio = use('Audio'); let curGain = 1.0, _applyQueued = false;
    function scheduleApply(imm = false) { if (imm) { apply(); return; } if (_applyQueued) return; _applyQueued = true; requestAnimationFrame(() => { _applyQueued = false; apply(); }); }
    document.addEventListener('vsc-ae-res', (e) => { curGain = e.detail.gain; scheduleApply(); });
    window.addEventListener('vsc-ignite-fast', () => scheduleApply(true));
    window.addEventListener('vsc-ignite', () => scheduleApply());

    function apply() {
        const vf = sm.get('video'), img = sm.get('image'), active = sm.get('app.active');
        const R = use('Registry'); R.prune(); const gain = (active && vf.ae) ? curGain : 1.0;
        const vVals = { gamma: use('Utils').clamp(vf.gamma * gain, 0.5, 2.5), contrast: vf.contrast, bright: vf.bright, sat: vf.sat, sharp: vf.sharp, sharp2: vf.sharp2, clarity: vf.clarity, dither: vf.dither, temp: vf.temp };
        const iVals = { gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, sharp: img.level, sharp2: 0, clarity: 0, dither: 0, temp: img.temp };
        if (active && vf.ae && sm.get('app.uiVisible')) UI.update(`AE ON | EV: ${Math.log2(gain).toFixed(2)}`, true);
        if (active && vf.ae) use('Analyzer').wake();
        for (const el of R.videos) { if (!active) { Filters.clear(el); if (el.__vsc_origRate != null) el.playbackRate = el.__vsc_origRate; continue; } Filters.update(el, vVals, 'video'); use('Analyzer').attach(el); Audio.attach(el); if (Math.abs(el.playbackRate - sm.get('playback.rate')) > 0.01) el.playbackRate = sm.get('playback.rate'); }
        for (const el of R.images) { if (!active) { Filters.clear(el); continue; } if (el.width > 50) Filters.update(el, iVals, 'image'); }
        Audio.update();
    }
    sm.sub('app.active', (v) => { if(v) scheduleApply(true); else apply(); });
    sm.sub('video.*', scheduleApply); sm.sub('image.*', scheduleApply); sm.sub('audio.*', scheduleApply); sm.sub('playback.rate', scheduleApply);
    setInterval(scheduleApply, 5000); use('UI');
})();
