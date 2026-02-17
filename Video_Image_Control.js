// ==UserScript==
// @name         Video_Image_Control (v132.0.120 Mobile-Large-UI)
// @namespace    https://github.com/
// @version      132.0.120
// @description  v132.120: Fat-Finger Friendly UI + Audio Reset + v91 Engine + Full Sync
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (location.href.includes('/cdn-cgi/')) return;
    const VSC_KEY = '__VSC_LOCK__'; if (window[VSC_KEY]) return; window[VSC_KEY] = true;

    const _shadows = new Set();
    try {
        const origAttach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const sr = origAttach.call(this, init); _shadows.add(sr); return sr;
        };
    } catch (e) {}

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
        video: { gamma: 1.0, contrast: 1.0, bright: 0, sat: 100, shadows: 0, highlights: 0, temp: 0, sharp: 0, sharp2: 0, dither: 0, clarity: 0, ae: false, gain: 1.0, presetS: 'off', presetB: 'off' },
        image: { level: 15, temp: 0 },
        audio: { enabled: false, boost: 6 },
        playback: { rate: 1.0 },
        app: { active: true, uiVisible: false, tab: 'video' }
    };

    const M = {}; const def = (k, fn) => M[k] = fn(); const use = (k) => M[k];

    def('Utils', () => ({
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        median5: (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length/2)] || 0; },
        h: (tag, props = {}, ...children) => {
            const el = (tag === 'svg' || props.ns === 'svg') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
            for (const [k, v] of Object.entries(props)) {
                if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), (e) => { if(k === 'onclick') e.stopPropagation(); v(e); });
                else if (k === 'style') { if(typeof v==='string') el.style.cssText=v; else Object.assign(el.style, v); }
                else if (k === 'class') el.className = v;
                else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
            }
            children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
            return el;
        },
        getRoots: () => {
            const set = new Set([document]); _shadows.forEach(sr => set.add(sr));
            const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) { if (walker.currentNode.shadowRoot) set.add(walker.currentNode.shadowRoot); }
            return [...set];
        }
    }));

    def('Store', () => {
        let state = JSON.parse(JSON.stringify(DEFAULTS));
        const listeners = new Map();
        const LOCAL_ONLY = new Set(['app.uiVisible', 'app.tab']); 
        const SEEN = new Set();
        const emit = (key, val) => { listeners.get(key)?.forEach(cb => cb(val)); const cat = key.split('.')[0]; listeners.get(cat + '.*')?.forEach(cb => cb(val)); };
        window.addEventListener('message', (e) => {
            if (e.data?.ch !== VSC_MSG || e.data.type !== 'state') return;
            if (e.data.mid && SEEN.has(e.data.mid)) return;
            SEEN.add(e.data.mid); if (SEEN.size > 200) SEEN.clear();
            const payload = e.data.payload;
            for (const [cat, data] of Object.entries(payload || {})) {
                for (const [key, val] of Object.entries(data || {})) { if (!LOCAL_ONLY.has(`${cat}.${key}`)) { state[cat][key] = val; emit(`${cat}.${key}`, val); } }
            }
            window.dispatchEvent(new CustomEvent('vsc-ignite'));
        });
        return { 
            get: (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), state), 
            set: (path, val) => {
                const [cat, key] = path.split('.'); if (state[cat][key] === val) return;
                state[cat][key] = val; emit(path, val);
                if (LOCAL_ONLY.has(path)) return;
                const msg = { ch: VSC_MSG, type:'state', payload: { [cat]: { [key]: val } }, mid: `${VSC_ID}:${Date.now()}` };
                if (!IS_TOP) window.parent?.postMessage(msg, '*');
                const frames = document.getElementsByTagName('iframe');
                for (let i = 0; i < frames.length; i++) try { frames[i].contentWindow?.postMessage(msg, '*'); } catch(err){}
            },
            batch: (cat, obj) => { for(const [k,v] of Object.entries(obj)) use('Store').set(`${cat}.${k}`, v); },
            sub: (k, f) => { if(!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(f); },
            state
        };
    });

    def('Audio', () => {
        let ctx, compressor, dry, wet; const sm = use('Store');
        const updateMix = () => {
            if (!ctx) return; const enabled = sm.get('audio.enabled'), boost = sm.get('audio.boost');
            if (ctx.state === 'suspended') ctx.resume(); const t = ctx.currentTime;
            dry.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.05);
            wet.gain.setTargetAtTime(enabled ? Math.pow(10, boost / 20) : 0, t, 0.05);
        };
        return {
            attach: (v) => {
                if (!v || v.tagName !== 'VIDEO' || v.__vsc_audio) return;
                try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!ctx) {
                        ctx = new AC(); compressor = ctx.createDynamicsCompressor();
                        dry = ctx.createGain(); dry.connect(ctx.destination);
                        wet = ctx.createGain(); compressor.connect(wet); wet.connect(ctx.destination);
                    }
                    const source = ctx.createMediaElementSource(v); source.connect(dry); source.connect(compressor);
                    v.__vsc_audio = true; updateMix();
                } catch(e) {}
            },
            update: updateMix
        };
    });

    def('Analyzer', () => {
        let worker, canvas, ctx, busy = false, fId = 0, lastApplyT = performance.now(), curGain = 1.0, roiP50History = [];
        const attached = new WeakSet();
        const init = () => {
            if (worker) return;
            const blob = new Blob([`self.onmessage=e=>{
                const {buf,w,h}=e.data; const data=new Uint8ClampedArray(buf);
                let sumL=0, validCount=0; const hist=new Uint16Array(256);
                for(let i=0; i<data.length; i+=4){ const luma=(data[i]*54+data[i+1]*183+data[i+2]*19)>>8; hist[luma]++; sumL+=luma; validCount++; }
                let p50=-1; let sum=0; for(let i=0; i<256; i++){ sum+=hist[i]; if(p50<0 && sum>=validCount*0.5) p50=i/255; }
                self.postMessage({fid:e.data.fid, p50});
            }`], { type: 'text/javascript' });
            worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => { 
                busy = false; const now = performance.now();
                roiP50History.push(e.data.p50); if(roiP50History.length > 5) roiP50History.shift();
                const p50m = use('Utils').median5(roiP50History);
                const autoEV = use('Utils').clamp(Math.log2(MIN_AE.TARGET_MID_BASE / Math.max(0.02, p50m)) * MIN_AE.STRENGTH, 0, MIN_AE.MAX_UP_EV_DARK);
                const targetGain = Math.pow(2, autoEV);
                const alpha = 1 - Math.exp(-(now - lastApplyT) / (targetGain > curGain ? MIN_AE.TAU_UP : MIN_AE.TAU_DOWN));
                curGain += (targetGain - curGain) * alpha; lastApplyT = now;
                document.dispatchEvent(new CustomEvent('vsc-ae-res', { detail: { gain: curGain } }));
            };
            canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; ctx = canvas.getContext('2d', { alpha: false });
        };
        return { attach: (v) => {
            if (!v || attached.has(v)) return; attached.add(v); init();
            const loop = () => {
                if (!v.isConnected) return;
                if (!v.paused && !document.hidden && !busy && use('Store').get('video.ae')) {
                    try { ctx.drawImage(v, 0, 0, 32, 32); const d = ctx.getImageData(0,0,32,32); busy = true; worker.postMessage({buf: d.data.buffer, w:32, h:32, fid:++fId}, [d.data.buffer]); } catch(e){ busy=false; }
                }
                setTimeout(loop, 250);
            };
            loop();
        }};
    });

    def('Filters', () => {
        const { h } = use('Utils'); const ctxMap = new WeakMap();
        const buildSvg = (doc) => {
            const id = `vsc-f-${VSC_ID}`;
            const svg = h('svg', { style:'display:none;position:absolute;' }, h('filter', { ns:'svg', id:id+'-f', colorInterpolationFilters:'sRGB' }, [
                h('feComponentTransfer', { ns:'svg', result:'c' }, ['R','G','B'].map(i => h(`feFunc${i}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':'cl' }))),
                h('feGaussianBlur', { ns:'svg', in:'c', stdDeviation:'0', 'data-id':'bf', result:'bf' }),
                h('feComposite', { ns:'svg', in:'c', in2:'bf', operator:'arithmetic', k2:'1', k3:'0', 'data-id':'cf', result:'sf' }),
                h('feGaussianBlur', { ns:'svg', in:'sf', stdDeviation:'0', 'data-id':'bc', result:'bc' }),
                h('feComposite', { ns:'svg', in:'sf', in2:'bc', operator:'arithmetic', k2:'1', k3:'0', 'data-id':'cc', result:'s2' }),
                h('feColorMatrix', { ns:'svg', in:'s2', type:'matrix', values:'1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0', 'data-id':'con', result:'s3' }),
                h('feComponentTransfer', { ns:'svg', in:'s3' }, ['R','G','B'].map(i => h(`feFunc${i}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':'gm' }))),
                h('feComponentTransfer', { ns:'svg' }, ['R','G','B'].map(i => h(`feFunc${i}`, { ns:'svg', type:'linear', slope:'1', 'data-id':'tp' })))
            ]));
            (doc.body || doc.documentElement).appendChild(svg); return { svg, filterId: id+'-f' };
        };
        return { update: (el, s) => {
            const doc = el.ownerDocument || document; let ctx = ctxMap.get(doc); if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
            const url = `url(#${ctx.filterId})`; if (el.style.filter !== url) el.style.setProperty('filter', url, 'important');
            const set = (id, attr, val) => ctx.svg.querySelectorAll(`[data-id="${id}"]`).forEach(n => n.setAttribute(attr, val));
            set('gm', 'tableValues', Array.from({length:32}, (_,i)=>Math.pow(i/31, 1/(s.gamma||1)).toFixed(3)).join(' '));
            const sh = (s.sharp || 0) * 0.05; set('cc', 'k2', (1 + sh).toFixed(2)); set('cc', 'k3', (-sh).toFixed(2));
            const c = ((s.contrast || 1.0) - 1.0) * 0.6; set('con', 'values', `${1+c} 0 0 0 0 0 ${1+c} 0 0 0 0 0 ${1+c} 0 0 0 0 0 1 0`);
            const t = s.temp || 0; set('tp', 'slope', (1 + (t>0?t*0.003:0) - (t<0?-t*0.005:0)).toFixed(3));
        }};
    });

    def('UI', () => {
        const { h } = use('Utils'); const sm = use('Store'); let container, monitorEl, trigger;
        const SLIDERS = [
            { l:'감마', k:'video.gamma', min:0.5, max:2.5, s:0.05, f:v=>v.toFixed(2) }, { l:'대비', k:'video.contrast', min:0.5, max:2.0, s:0.05, f:v=>v.toFixed(2) },
            { l:'밝기', k:'video.bright', min:-50, max:50, s:1, f:v=>v.toFixed(0) }, { l:'채도', k:'video.sat', min:0, max:200, s:5, f:v=>v.toFixed(0) },
            { l:'윤곽', k:'video.sharp', min:0, max:50, s:1, f:v=>v.toFixed(0) }, { l:'디테일', k:'video.sharp2', min:0, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'명료', k:'video.clarity', min:0, max:50, s:5, f:v=>v.toFixed(0) }, { l:'색온도', k:'video.temp', min:-25, max:25, s:1, f:v=>v.toFixed(0) },
            { l:'그레인', k:'video.dither', min:0, max:100, s:5, f:v=>v.toFixed(0) },
            { l:'오디오 증폭', k:'audio.boost', min:0, max:12, s:1, f:v=>`+${v}dB` }
        ];
        const build = () => {
            if (container) return; const host = h('div', { id:'vsc-host' }); const shadow = host.attachShadow({ mode:'open' });
            const style = `
                .main { position: fixed; top: 10%; right: 20px; width: 320px; background: rgba(25,25,25,0.96); backdrop-filter: blur(12px); color: #eee; padding: 15px; border-radius: 16px; z-index: 2147483647; border: 1px solid #555; font-family: sans-serif; box-shadow: 0 12px 48px rgba(0,0,0,0.7); }
                .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 2px solid #444; }
                .tab { flex: 1; padding: 12px; background: #222; border: 0; color: #999; cursor: pointer; border-radius: 10px 10px 0 0; font-weight: bold; font-size: 13px; }
                .tab.active { background: #333; color: #3498db; border-bottom: 3px solid #3498db; }
                .prow { display: flex; gap: 4px; width: 100%; margin-bottom: 6px; }
                .btn { flex: 1; background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 10px 6px; cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: bold; transition: 0.2s; }
                .btn.active { background: #3498db; color: white; border-color: #2980b9; box-shadow: 0 0 8px rgba(52,152,219,0.5); }
                .pbtn { background: #444; border: 1px solid #666; color: #eee; cursor: pointer; border-radius: 6px; font-size: 12px; min-height: 34px; font-weight: bold; }
                .pbtn.active { background: #e67e22; color: white; border-color: #d35400; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12px; row-gap: 8px; margin-top: 8px; }
                .slider { display: flex; flex-direction: column; gap: 4px; color: #ccc; }
                .slider label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 500; }
                input[type=range] { width: 100%; accent-color: #3498db; cursor: pointer; height: 24px; margin: 4px 0; }
                .monitor { font-size: 12px; color: #aaa; text-align: center; border-top: 1px solid #444; padding-top: 8px; margin-top: 12px; font-family: monospace; }
                hr { border: 0; border-top: 1px solid #444; width: 100%; margin: 10px 0; }
            `;
            const renderS = (cfg) => {
                const valEl = h('span', {style:'color:#3498db'}, '0'); const inp = h('input', { type:'range', min:cfg.min, max:cfg.max, step:cfg.s });
                const up = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, up); up(sm.get(cfg.k)); inp.oninput = (e) => { e.stopPropagation(); sm.set(cfg.k, Number(inp.value)); };
                return h('div', { class:'slider' }, h('label', {}, cfg.l, valEl), inp);
            };
            const renderP = (label, items, key, on) => {
                const r = h('div', { class:'prow' }, h('div', {style:'font-size:11px;width:35px;line-height:34px;font-weight:bold'}, label));
                items.forEach(it => {
                    const b = h('button', { class:'pbtn', style:'flex:1' }, it.l); b.onclick = (e) => { e.stopPropagation(); sm.set(key, it.l); on(it); };
                    sm.sub(key, v => b.classList.toggle('active', v === it.l)); r.append(b);
                });
                const off = h('button', { class:'pbtn', style:'flex:1' }, 'OFF'); off.onclick = (e) => { e.stopPropagation(); sm.set(key, 'off'); on(null); };
                sm.sub(key, v => off.classList.toggle('active', v === 'off')); r.append(off); return r;
            };
            const head = h('div', { class:'prow' }, 
                h('button', { class:'btn', onclick:()=>sm.set('app.uiVisible', false) }, '✕ 닫기'),
                h('button', { id:'ae-btn', class:'btn', onclick:()=>sm.set('video.ae', !sm.get('video.ae')) }, '🤖 자동'),
                h('button', { id:'boost-btn', class:'btn', onclick:()=>sm.set('audio.enabled', !sm.get('audio.enabled')) }, '🔊 부스트')
            );
            const r2 = h('div', { class:'prow' }, 
                h('button', { class:'btn', onclick:()=>{ sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); } }, '↺ 리셋'), 
                h('button', { id:'pwr-btn', class:'btn', onclick:()=>sm.set('app.active', !sm.get('app.active')) }, '⚡ Power')
            );
            const speedRow = h('div', { class:'prow', style:'justify-content:center;gap:4px;' });
            [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].forEach(s => {
                const b = h('button', { class:'pbtn', style:'flex:1;min-height:36px;' }, s+'x'); b.onclick = (e) => { e.stopPropagation(); sm.set('playback.rate', s); };
                sm.sub('playback.rate', v => b.classList.toggle('active', Math.abs(v-s)<0.01)); speedRow.append(b);
            });
            const bodyV = h('div', { id:'p-v' }, [
                head, r2,
                renderP('샤프', [{l:'S',v1:8,v2:3},{l:'M',v1:15,v2:6},{l:'L',v1:25,v2:10},{l:'XL',v1:35,v2:15}], 'video.presetS', (it)=>sm.batch('video', it?{sharp:it.v1,sharp2:it.v2}:{sharp:0,sharp2:0})),
                renderP('밝기', [{l:'S',g:1.0,b:2,c:1.0}, {l:'M',g:1.1,b:4,c:1.0}, {l:'L',g:1.2,b:6,c:1.0}, {l:'DS',g:1.0,b:3.6,c:1.02}, {l:'DM',g:1.15,b:7.2,c:1.04}, {l:'DL',g:1.30,b:10.8,c:1.06}], 'video.presetB', (it)=>sm.batch('video', it?{gamma:it.g,bright:it.b,contrast:it.c,sat:it.s||100}:{gamma:1,bright:0,contrast:1,sat:100})),
                h('hr'), h('div', { class:'grid' }, SLIDERS.map(renderS)), h('hr'), speedRow
            ]);
            const bodyI = h('div', { id:'p-i', style:'display:none' }, [
                h('div', { class:'grid' }, [
                    renderS({l:'이미지 윤곽', k:'image.level', min:0, max:50, s:1, f:v=>v.toFixed(0)}),
                    renderS({l:'이미지 색온도', k:'image.temp', min:-20, max:20, s:1, f:v=>v.toFixed(0)})
                ])
            ]);
            shadow.append(h('style', {}, style), h('div', { class:'main' }, [
                h('div', { class:'tabs' }, [h('button', { id:'t-v', class:'tab active', onclick:()=>sm.set('app.tab', 'video') }, 'VIDEO'), h('button', { id:'t-i', class:'tab', onclick:()=>sm.set('app.tab', 'image') }, 'IMAGE')]),
                bodyV, bodyI, monitorEl = h('div', { class:'monitor' }, 'Ready (V91 Engine)')
            ]));
            sm.sub('app.tab', v => {
                shadow.getElementById('t-v').classList.toggle('active', v==='video'); shadow.getElementById('t-i').classList.toggle('active', v==='image');
                shadow.getElementById('p-v').style.display = v==='video' ? 'block' : 'none'; shadow.getElementById('p-i').style.display = v==='image' ? 'block' : 'none';
            });
            sm.sub('video.ae', v => shadow.getElementById('ae-btn').classList.toggle('active', !!v));
            sm.sub('audio.enabled', v => shadow.getElementById('boost-btn').classList.toggle('active', !!v));
            sm.sub('app.active', v => shadow.getElementById('pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');
            container = host; (document.body || document.documentElement).appendChild(container);
            sm.sub('app.uiVisible', v => container.style.display = v ? 'block' : 'none');
        };
        trigger = h('div', { 
            style:'position:fixed;top:45%;right:0;width:44px;height:44px;background:rgba(0,0,0,0.7);z-index:2147483647;cursor:pointer;display:none;align-items:center;justify-content:center;border-radius:12px 0 0 12px;color:#fff;font-size:22px;box-shadow: -2px 0 8px rgba(0,0,0,0.5);', 
            onclick:()=>{ build(); sm.set('app.uiVisible', !sm.get('app.uiVisible')); } 
        }, '⚙️');
        const syncUI = () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            const show = IS_TOP || isFs; trigger.style.display = show ? 'flex' : 'none';
            const root = document.fullscreenElement || document.body || document.documentElement;
            if (root && trigger.parentElement !== root) root.appendChild(trigger);
            if (container && container.parentElement !== root) root.appendChild(container);
        };
        setInterval(syncUI, 1000);
        return { update: (m, act) => { if(monitorEl && container?.style.display!=='none') { monitorEl.textContent=m; monitorEl.style.color = act?'#4cd137':'#aaa'; } } };
    });

    const sm = use('Store'), Filters = use('Filters'), UI = use('UI'), Audio = use('Audio'); let curGain = 1.0;
    document.addEventListener('vsc-ae-res', (e) => { curGain = e.detail.gain; apply(); });
    window.addEventListener('vsc-ignite', apply);

    function apply() {
        const vf = sm.get('video'), img = sm.get('image'), active = sm.get('app.active');
        const gain = vf.ae ? curGain : 1.0;
        const vVals = { gamma: use('Utils').clamp(vf.gamma * gain, 0.5, 2.5), contrast: vf.contrast, sharp: vf.sharp, temp: vf.temp };
        if (vf.ae && sm.get('app.uiVisible')) UI.update(`AE ON | EV: ${Math.log2(gain).toFixed(2)}`, true);
        use('Utils').getRoots().forEach(root => {
            root.querySelectorAll?.('video, img').forEach(el => {
                if (el.tagName === 'VIDEO') {
                    Filters.update(el, active ? vVals : DEFAULTS.video); use('Analyzer').attach(el); Audio.attach(el);
                    if (Math.abs(el.playbackRate - sm.get('playback.rate')) > 0.01) el.playbackRate = sm.get('playback.rate');
                } else if (el.tagName === 'IMG' && el.width > 50) {
                    Filters.update(el, active ? { sharp: img.level, temp: img.temp, gamma: 1.0 } : DEFAULTS.video);
                }
            });
        });
        Audio.update();
    }
    sm.sub('video.*', apply); sm.sub('image.*', apply); sm.sub('audio.*', apply); sm.sub('app.active', apply); sm.sub('playback.rate', apply);
    setInterval(apply, 2000); use('UI');
})();
