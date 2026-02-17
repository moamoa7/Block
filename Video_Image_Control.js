// ==UserScript==
// @name         Video_Image_Control (v132.141 Hybrid-Pro)
// @namespace    https://github.com/
// @version      132.141.91
// @description  v132.141 UI/Structure + v132.0.91 Advanced AE Logic (Subtitle Protection, LowKey Mode, Smart Skip)
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

    // ==========================================
    // 1. BOOT & CONSTANTS
    // ==========================================
    if (location.href.includes('/cdn-cgi/')) return;
    const VSC_KEY = '__VSC_LOCK__';
    if (window[VSC_KEY]) return;
    window[VSC_KEY] = true;

    const IS_TOP = (window === window.top);
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const VSC_ID = Math.random().toString(36).slice(2);
    const VSC_MSG = 'vsc-ctrl-v1';

    // [Ported from v0.91] Advanced AE Constants
    const MIN_AE = {
        STRENGTH: IS_MOBILE ? 0.24 : 0.28,
        STRENGTH_DARK: IS_MOBILE ? 0.28 : 0.32,
        MID_OK_MIN: IS_MOBILE ? 0.14 : 0.16,
        P98_CLIP: 0.985,
        CLIP_FRAC_LIMIT: 0.004,
        MAX_UP_EV: IS_MOBILE ? 0.14 : 0.18,
        MAX_UP_EV_DARK: IS_MOBILE ? 0.30 : 0.34,
        MAX_UP_EV_EXTRA: IS_MOBILE ? 0.28 : 0.35,
        MAX_DOWN_EV: 0,
        DEAD_OUT: IS_MOBILE ? 0.12 : 0.10, // Hysteresis threshold
        DEAD_IN: 0.04,
        LOWKEY_STDDEV: IS_MOBILE ? 0.20 : 0.24, // Dark scene protection
        LOWKEY_P10: 0.10,
        TAU_UP: 950,
        TAU_DOWN: 900,
        TAU_AGGRESSIVE: 200,
        TARGET_MID_BASE: IS_MOBILE ? 0.26 : 0.30
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

    const M = {};
    const def = (k, fn) => M[k] = fn();
    const use = (k) => M[k];

    // ==========================================
    // 2. UTILS
    // ==========================================
    def('Utils', () => ({
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        median5: (a) => {
            if (a.length === 0) return 0;
            const b = [...a].sort((x, y) => x - y);
            return b[Math.floor(b.length / 2)];
        },
        h: (tag, props = {}, ...children) => {
            const el = (tag === 'svg' || props.ns === 'svg')
                ? document.createElementNS('http://www.w3.org/2000/svg', tag)
                : document.createElement(tag);
            for (const [k, v] of Object.entries(props)) {
                if (k.startsWith('on')) {
                    el.addEventListener(k.slice(2).toLowerCase(), (e) => {
                        if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation();
                        v(e);
                    });
                }
                else if (k === 'style') {
                    if (typeof v === 'string') el.style.cssText = v;
                    else Object.assign(el.style, v);
                }
                else if (k === 'class') el.className = v;
                else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
            }
            children.flat().forEach(c => {
                if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
            });
            return el;
        }
    }));

    // ==========================================
    // 3. REGISTRY (Scan)
    // ==========================================
    def('Registry', () => {
        const videos = new Set();
        const images = new Set();
        const seenElements = new WeakSet();

        const processNode = (node) => {
            if (!node || node.nodeType !== 1 || seenElements.has(node)) return;

            if (node.tagName === 'VIDEO') {
                videos.add(node);
                seenElements.add(node);
            } else if (node.tagName === 'IMG') {
                if (node.width > 50 || node.height > 50 || node.complete === false) {
                    images.add(node);
                    seenElements.add(node);
                }
            }

            const vids = node.querySelectorAll?.('video');
            if (vids) vids.forEach(v => {
                if (!seenElements.has(v)) { videos.add(v); seenElements.add(v); }
            });

            const imgs = node.querySelectorAll?.('img');
            if (imgs) imgs.forEach(i => {
                if (!seenElements.has(i)) { images.add(i); seenElements.add(i); }
            });
        };

        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes.forEach(n => processNode(n));
            }
            window.dispatchEvent(new CustomEvent('vsc-ignite'));
        });

        const start = () => {
            if (document.body) {
                processNode(document.body);
                observer.observe(document.body, { childList: true, subtree: true });
            } else {
                setTimeout(start, 100);
            }
        };
        start();

        try {
            const origAttach = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(init) {
                const sr = origAttach.call(this, init);
                setTimeout(() => {
                    processNode(sr);
                    observer.observe(sr, { childList: true, subtree: true });
                }, 100);
                return sr;
            };
        } catch (e) {}

        return {
            videos,
            images,
            prune: () => {
                for (const v of videos) if (!v.isConnected) videos.delete(v);
                for (const i of images) if (!i.isConnected) images.delete(i);
            }
        };
    });

    // ==========================================
    // 4. STORE
    // ==========================================
    def('Store', () => {
        let state = JSON.parse(JSON.stringify(DEFAULTS));
        const listeners = new Map();
        const LOCAL_ONLY = new Set(['app.uiVisible', 'app.tab', 'video.gain']);

        const emit = (key, val) => {
            listeners.get(key)?.forEach(cb => cb(val));
            const cat = key.split('.')[0];
            listeners.get(cat + '.*')?.forEach(cb => cb(val));
        };

        const broadcast = (payload) => {
            const msg = { ch: VSC_MSG, type: 'state', sender: VSC_ID, payload };
            if (!IS_TOP) window.parent?.postMessage(msg, '*');
            const frames = document.getElementsByTagName('iframe');
            for (let i = 0; i < frames.length; i++) {
                try { frames[i].contentWindow?.postMessage(msg, '*'); } catch(e){}
            }
        };

        window.addEventListener('message', (e) => {
            if (e.data?.ch !== VSC_MSG || e.data.type !== 'state' || e.data.sender === VSC_ID) return;
            const payload = e.data.payload;
            for (const [cat, data] of Object.entries(payload || {})) {
                for (const [key, val] of Object.entries(data || {})) {
                    if (LOCAL_ONLY.has(`${cat}.${key}`)) continue;
                    if (state[cat][key] !== val) {
                        state[cat][key] = val;
                        emit(`${cat}.${key}`, val);
                    }
                }
            }
            window.dispatchEvent(new CustomEvent('vsc-ignite-fast'));
        });

        return {
            get: (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), state),
            set: (path, val) => {
                const [cat, key] = path.split('.');
                if (state[cat][key] === val) return;
                state[cat][key] = val;
                emit(path, val);
                if (!LOCAL_ONLY.has(path)) broadcast({ [cat]: { [key]: val } });
            },
            batch: (cat, obj) => {
                const changed = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (state[cat][k] !== v) {
                        state[cat][k] = v;
                        changed[k] = v;
                        emit(`${cat}.${k}`, v);
                    }
                }
                if (Object.keys(changed).length > 0) broadcast({ [cat]: changed });
            },
            sub: (k, f) => {
                if (!listeners.has(k)) listeners.set(k, []);
                listeners.get(k).push(f);
            }
        };
    });

    // ==========================================
    // 5. AUDIO
    // ==========================================
    def('Audio', () => {
        let ctx, compressor, dry, wet;
        const sm = use('Store');

        const updateMix = () => {
            if (!ctx) return;
            const active = sm.get('app.active');
            const enabled = active && sm.get('audio.enabled');
            const boostDb = sm.get('audio.boost');

            if (ctx.state === 'suspended') ctx.resume();
            const t = ctx.currentTime;

            dry.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.05);
            const boostLinear = Math.pow(10, boostDb / 20);
            wet.gain.setTargetAtTime(enabled ? boostLinear : 0, t, 0.05);
        };

        return {
            attach: (v) => {
                if (!v || v.tagName !== 'VIDEO' || v.__vsc_audio) return;
                try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!ctx) {
                        ctx = new AC();
                        compressor = ctx.createDynamicsCompressor();
                        // v0.91 Audio Settings
                        compressor.threshold.value = -50;
                        compressor.knee.value = 40;
                        compressor.ratio.value = 12;
                        compressor.attack.value = 0;
                        compressor.release.value = 0.25;

                        dry = ctx.createGain();
                        dry.connect(ctx.destination);

                        wet = ctx.createGain();
                        compressor.connect(wet);
                        wet.connect(ctx.destination);
                    }
                    const source = ctx.createMediaElementSource(v);
                    source.connect(dry);
                    source.connect(compressor);
                    v.__vsc_audio = true;
                    updateMix();
                } catch(e) {}
            },
            update: updateMix
        };
    });

    // ==========================================
    // 6. ANALYZER (v0.91 Full Hybrid Logic)
    // ==========================================
    def('Analyzer', () => {
        let worker;
        const { clamp, median5 } = use('Utils');
        const sm = use('Store');

        // Analysis State
        let fId = 0;
        let isRunning = false;
        let curGain = 1.0;
        let aeActive = false;
        let lastStats = { p10: -1, p50: -1, p90: -1, cf: 0.5 };
        let dynamicSkipThreshold = 0;
        let lastApplyT = 0;
        let lastLuma = -1;
        let lowMotionFrames = 0;
        let workerBusy = false;
        let workerLastSent = 0;
        let frameSkipCounter = 0;
        let evAggressiveUntil = 0;

        // [v0.91] Worker Code: Calculates detailed stats including stdDev and clipFracBottom
        const WORKER_CODE = `
            const hist = new Uint16Array(256);
            self.onmessage = function(e) {
                const { fid, buf, width, height, step } = e.data;
                const data = new Uint8ClampedArray(buf);
                hist.fill(0);
                const w = width; const h = height || width;
                let validCount=0, sumR=0, sumG=0, sumB=0, sumLuma=0, sumLumaSq=0, sumMaxMin=0;

                const barH = Math.floor(h * 0.12);
                let startY = 0, endY = h;
                const bottomStart = h - Math.floor(h * 0.20);
                let botClipCount = 0, botTotalCount = 0;

                for (let y = startY; y < endY; y+=step) {
                    const isBottom = y >= bottomStart;
                    for (let x = 0; x < w; x+=step) {
                        const i = (y * w + x) * 4;
                        const r = data[i], g = data[i+1], b = data[i+2];
                        const luma = (r*54 + g*183 + b*19) >> 8;
                        hist[luma]++;
                        validCount++;
                        if (isBottom) {
                            botTotalCount++;
                            if (luma >= 253) botClipCount++;
                        }
                        sumR += r; sumG += g; sumB += b;
                        sumLuma += luma;
                        sumLumaSq += luma * luma;
                        let max = r; if(g>max) max=g; if(b>max) max=b;
                        let min = r; if(g<min) min=g; if(b<min) min=b;
                        sumMaxMin += (max - min);
                    }
                }

                let p10=-1, p50=-1, p90=-1, p98=-1, clipFrac=0, clipFracBottom=0;
                let avgLuma=0, stdDev=0, avgSat=0;

                if (validCount > 0) {
                    const inv = 1 / validCount;
                    avgLuma = (sumLuma * inv) / 255;
                    avgSat = (sumMaxMin * inv) / 255;
                    const meanSq = (sumLumaSq * inv) / (255*255);
                    stdDev = Math.sqrt(Math.max(0, meanSq - (avgLuma * avgLuma)));
                    clipFrac = (hist[253] + hist[254] + hist[255]) * inv;
                    if (botTotalCount > 0) clipFracBottom = botClipCount / botTotalCount;

                    let sum = 0;
                    const t10=validCount*0.1, t50=validCount*0.5, t90=validCount*0.9, t98=validCount*0.98;
                    for(let i=0; i<256; i++) {
                        sum += hist[i];
                        if(p10<0 && sum>=t10) p10=i/255;
                        if(p50<0 && sum>=t50) p50=i/255;
                        if(p90<0 && sum>=t90) p90=i/255;
                        if(p98<0 && sum>=t98) p98=i/255;
                    }
                }
                if(p10<0) p10=0.1; if(p50<0) p50=0.5; if(p90<0) p90=0.9; if(p98<0) p98=0.98;
                self.postMessage({ fid, p10, p50, p90, p98, stdDev, clipFrac, clipFracBottom, validCount, avgSat, avgLuma });
            };
        `;

        const init = () => {
            if (worker) return;
            const blob = new Blob([WORKER_CODE], { type: 'text/javascript' });
            worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => {
                workerBusy = false;
                processResult(e.data);
            };
        };

        // [v0.91] Core Tone Mapping Logic
        const computeAeTuningV2 = (totalGain, stats) => {
            const smooth01 = (t) => t * t * (3 - 2 * t);
            const tg = Math.max(1.0, totalGain || 1.0);
            const ev = Math.log2(tg);
            const ev01 = clamp(ev / 1.6, 0, 1);

            const p90 = clamp(stats.p90 || 0, 0, 1);
            const p50 = clamp(stats.p50 || 0, 0, 1);
            const p10 = clamp(stats.p10 || 0, 0, 1);
            const cf  = clamp(stats.cf  || 0.5, 0, 1);

            const gainGate = smooth01(clamp((tg - 1.05) / 0.35, 0, 1));
            const hiRisk = smooth01(clamp((p90 - 0.86) / 0.10, 0, 1));
            const midErr = clamp((0.58 - 0.05 * ev01) - p50, -0.25, 0.25);
            const darkNeed = smooth01(clamp((0.16 - p10) / 0.14, 0, 1));
            const lowColor = smooth01(clamp((0.34 - cf) / 0.20, 0, 1));

            const kB = IS_MOBILE ? 10.0 : 12.5;
            const kS = IS_MOBILE ? 10.0 : 14.0;
            const kH = IS_MOBILE ?  6.0 :  7.5;
            const kC = IS_MOBILE ? 0.030 : 0.045;
            const kG = IS_MOBILE ? 0.030 : 0.045;
            const kSat = IS_MOBILE ? 1.0 : 1.35;

            return {
                brightness: gainGate * ev01 * kB * midErr * (1 - hiRisk * 0.65),
                shadowLift: gainGate * ev01 * kS * darkNeed * (1 - hiRisk * 0.35),
                highlightRecover: gainGate * ev01 * kH * hiRisk,
                contrastBoost: gainGate * ev01 * kC * (1 - hiRisk) * clamp((p50 - 0.55) / 0.20, -1, 1),
                gammaPull: gainGate * ev01 * kG * clamp(midErr / 0.20, -1, 1) * (1 - hiRisk * 0.7),
                satBoost: gainGate * kSat * lowColor * (1 - hiRisk * 0.6)
            };
        };

        const updateEma = (stats) => {
            const now = performance.now();
            // Simple EMA without time delta for simplicity in this context
            const a = 0.2; // roughly same as v0.91 tau=220 at 60fps
            const s = lastStats;
            s.p90 = (s.p90 < 0) ? stats.p90 : (stats.p90 * a + s.p90 * (1-a));
            s.p50 = (s.p50 < 0) ? stats.p50 : (stats.p50 * a + s.p50 * (1-a));
            s.p10 = (s.p10 < 0) ? stats.p10 : (stats.p10 * a + s.p10 * (1-a));
            s.cf  = (s.cf < 0)  ? stats.avgSat : (stats.avgSat * a + s.cf * (1-a));
            return s;
        };

        const processResult = (data) => {
            const { p10, p50, p90, p98, stdDev, clipFrac, clipFracBottom, validCount, avgSat, avgLuma } = data;
            const now = performance.now();

            // 1. Motion Detection & Dynamic Skipping
            if (lastLuma >= 0) {
                const delta = Math.abs(avgLuma - lastLuma);
                if (delta < 0.003) lowMotionFrames++; else lowMotionFrames = 0;
                if (delta > 0.10) evAggressiveUntil = now + 800; // Cut detection
            }
            lastLuma = avgLuma;

            if (!aeActive && Math.abs(curGain - 1.0) < 0.01 && lowMotionFrames > 30) {
                dynamicSkipThreshold = Math.min(30, dynamicSkipThreshold + 1);
            } else {
                dynamicSkipThreshold = Math.max(0, dynamicSkipThreshold - 2);
            }

            // 2. Safety Checks (v0.91 Logic)
            const minClipPixels = (validCount < 220) ? 2 : 5;
            const dynamicClipLimit = Math.max(MIN_AE.CLIP_FRAC_LIMIT, (validCount > 0 ? minClipPixels / validCount : 0));
            const highlightSmall = clipFrac < dynamicClipLimit * 0.7;

            // Low Key Protection
            const isLowKey = ((stdDev > MIN_AE.LOWKEY_STDDEV && p10 > MIN_AE.LOWKEY_P10) && p50 < 0.20) ||
                             ((p90 > 0.82) && p50 < 0.18);
            const lowContrastDark = (stdDev < 0.06 && p50 < 0.14 && p98 < 0.70);

            // Subtitle Protection
            const subtitleLikely = (clipFracBottom > dynamicClipLimit * 1.5) && (p98 > 0.96) && (p50 < 0.22) && (stdDev > 0.06);
            const clipRisk = ((p98 >= MIN_AE.P98_CLIP && !highlightSmall) || (clipFrac > dynamicClipLimit)) && !subtitleLikely;

            // 3. Target Calculation
            let targetGain = 1.0;
            const effectiveMidMin = (p50 < 0.10 && !IS_MOBILE) ? 0.18 : MIN_AE.MID_OK_MIN;
            const midTooDark = p50 < effectiveMidMin;

            if (clipRisk) {
                targetGain = 1.0;
                aeActive = false;
            } else if (midTooDark && !isLowKey) {
                let allowNudge = (lowContrastDark && p50 < 0.10 && p98 < 0.60);
                const safeCurrent = Math.max(0.02, p50);
                let targetMid = MIN_AE.TARGET_MID_BASE;
                if (p50 < 0.08) targetMid = 0.32;

                let baseEV = Math.log2(targetMid / safeCurrent);
                let maxUp = MIN_AE.MAX_UP_EV;
                const headroomEV = Math.log2(0.98 / Math.max(0.01, p98));

                if (p50 < 0.08 && headroomEV > 0.6 && stdDev < 0.18) maxUp = Math.min(MIN_AE.MAX_UP_EV_EXTRA, headroomEV * 0.75);
                else if (p50 < 0.14 && headroomEV > 0.4) maxUp = Math.min(MIN_AE.MAX_UP_EV_DARK, headroomEV * 0.6);

                let currentAeStr = MIN_AE.STRENGTH;
                if (p50 < 0.08) currentAeStr = MIN_AE.STRENGTH_DARK;

                let rawEV = clamp(baseEV * currentAeStr, MIN_AE.MAX_DOWN_EV, maxUp);

                // Safe Gain Cap
                if (p98 > 0.01) {
                    const maxSafeGain = 0.99 / p98;
                    const maxSafeEV = Math.log2(maxSafeGain);
                    if (rawEV > maxSafeEV) rawEV = Math.min(rawEV, maxSafeEV);
                }

                // Hysteresis (Deadband)
                const th = aeActive ? MIN_AE.DEAD_IN : MIN_AE.DEAD_OUT;
                if (Math.abs(rawEV) < th) {
                    rawEV = 0;
                    aeActive = false;
                } else {
                    aeActive = true;
                }

                rawEV = clamp(rawEV, MIN_AE.MAX_DOWN_EV, maxUp);
                const aggressive = evAggressiveUntil && now < evAggressiveUntil;
                if (!aggressive && stdDev < 0.05) rawEV *= 0.95;

                targetGain = Math.pow(2, rawEV);
            } else {
                aeActive = false;
            }

            // 4. Temporal Smoothing
            const dt = now - lastApplyT;
            lastApplyT = now;
            const currentEV = Math.log2(curGain);
            const targetEV = Math.log2(targetGain);
            const diff = targetEV - currentEV;
            let tau = (diff > 0) ? MIN_AE.TAU_UP : MIN_AE.TAU_DOWN;
            if (evAggressiveUntil && now < evAggressiveUntil) tau = MIN_AE.TAU_AGGRESSIVE;

            const alpha = 1 - Math.exp(-dt / tau);
            const nextEV = currentEV + diff * alpha;
            curGain = Math.pow(2, nextEV);

            if (Math.abs(curGain - 1.0) < 0.01) curGain = 1.0;

            // 5. Advanced Tone Mapping Calculation
            const stats = updateEma({ p90, p50, p10, avgSat });
            const tune = computeAeTuningV2(curGain, stats);

            // 6. Map to v141 Filter Keys
            const res = {
                g: clamp(1.0 - tune.gammaPull, 0.5, 1.5),
                c: clamp(1.0 + tune.contrastBoost, 0.8, 1.4),
                s: clamp(1.0 + tune.satBoost, 1.0, 1.5),
                sh: Math.round(tune.shadowLift),
                hi: Math.round(tune.highlightRecover),
                gain: curGain
            };

            document.dispatchEvent(new CustomEvent('vsc-ae-res', { detail: { ae: res } }));
        };

        const loop = (v) => {
            if (!v.isConnected || !isRunning) return;
            const active = sm.get('app.active') && sm.get('video.ae');
            if (!active) {
                if (curGain !== 1.0) {
                    curGain = 1.0;
                    document.dispatchEvent(new CustomEvent('vsc-ae-res', { detail: { ae: { g:1,c:1,s:1,sh:0,hi:0,gain:1 } } }));
                }
                setTimeout(() => loop(v), 1000);
                return;
            }

            let delay = 80;
            // Dynamic Skip
            if (frameSkipCounter < dynamicSkipThreshold) {
                frameSkipCounter++;
            } else {
                frameSkipCounter = 0;
                if (!workerBusy && !document.hidden && v.readyState >= 2 && !v.paused) {
                    try {
                        const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
                        ctx.drawImage(v, 0, 0, 32, 32);
                        const d = ctx.getImageData(0, 0, 32, 32);
                        workerBusy = true;
                        worker.postMessage({ buf: d.data.buffer, width: 32, height: 32, fid: ++fId, step: 1 }, [d.data.buffer]);
                    } catch(e) { workerBusy = false; }
                }
            }

            if (v.paused) delay = 500;
            else if (dynamicSkipThreshold > 10) delay = 150;

            setTimeout(() => loop(v), delay);
        };

        let canvas;

        return {
            attach: (v) => {
                if (!v || v.__vsc_analyzing) return;
                v.__vsc_analyzing = true;
                init();
                if (!canvas) { canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; }
                isRunning = true;
                loop(v);
            },
            wake: () => { workerBusy = false; evAggressiveUntil = performance.now() + 1000; dynamicSkipThreshold = 0; }
        };
    });

    // ==========================================
    // 7. FILTERS (SVG)
    // ==========================================
    def('Filters', () => {
        const { h, clamp } = use('Utils');
        const ctxMap = new WeakMap();
        const sCurve = (x) => x * x * (3 - 2 * x);

        const generateToneTable = (shadows, highlights, brightness, contrast) => {
            const steps = 64;
            const vals = [];
            const shN = clamp(shadows / 100, -1, 1);
            const hiN = clamp(highlights / 100, -1, 1);
            const bOffset = clamp(brightness / 100, -1, 1) * 0.12;
            const toeThreshold = clamp(0.20 + shN * 0.10, 0.05, 0.40);
            const shoulderThreshold = clamp(0.82 - hiN * 0.06, 0.70, 0.95);

            for (let i = 0; i < steps; i++) {
                let x = i / (steps - 1);
                let y = (x - 0.5) * contrast + 0.5 + bOffset;
                if (shN !== 0 && y < toeThreshold) {
                    const t = clamp(y / Math.max(1e-6, toeThreshold), 0, 1);
                    const ss = t * t * (3 - 2 * t);
                    y = y + Math.sign(shN) * (toeThreshold - y) * (0.18 + 0.22 * Math.abs(shN)) * (1 - ss);
                }
                if (hiN !== 0 && y > shoulderThreshold) {
                    const t = clamp((y - shoulderThreshold) / Math.max(1e-6, (1 - shoulderThreshold)), 0, 1);
                    const ss = t * t * (3 - 2 * t);
                    y = y - Math.sign(hiN) * (0.08 + 0.18 * Math.abs(hiN)) * ss * t;
                }
                vals.push(clamp(y, 0, 1).toFixed(3));
            }
            return vals.join(' ');
        };

        function buildSvg(doc) {
            const baseId = `vsc-f-${VSC_ID}`;
            const svg = h('svg', { ns:'svg', width:'0', height:'0', style:'position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;', 'aria-hidden':'true' });
            const defs = h('defs', { ns:'svg' });
            svg.append(defs);

            const createFilter = (suffix) => {
                const fid = `${baseId}-${suffix}`;
                const filter = h('filter', { ns:'svg', id:fid, x:'-20%', y:'-20%', width:'140%', height:'140%', colorInterpolationFilters:'sRGB' });

                const sat = h('feColorMatrix', { ns:'svg', type:'saturate', values:'1', 'data-id':'sat' });
                const lin = h('feComponentTransfer', { ns:'svg', result:'lin' }, ['R','G','B'].map(c => h(`feFunc${c}`, { ns:'svg', type:'table', tableValues:'0 1', 'data-id':`lin${c}` })));
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

                filter.append(sat, lin, gam, tmp, b1, sh1, b2, sh2, bc, cl, turb, gr);
                defs.append(filter);
                return { fid, lastKey: '', sat, lin, gam, tmp, b1, sh1, b2, sh2, bc, cl, gr };
            };

            const video = createFilter('v');
            const image = createFilter('i');
            (doc.body || doc.documentElement).appendChild(svg);
            return { svg, video, image };
        }

        function updateNodes(nodes, s) {
            const key = `${s.gain}|${s.gamma}|${s.contrast}|${s.bright}|${s.shadows}|${s.highlights}|${s.sat}|${s.sharp}|${s.sharp2}|${s.clarity}|${s.dither}|${s.temp}`;
            if (nodes.lastKey === key) return;
            nodes.lastKey = key;
            const qs = (el, attr, val) => el.setAttribute(attr, val);

            qs(nodes.sat, 'values', ((s.sat / 100) * (s.aeSat || 1.0)).toFixed(2));

            const effSh = (s.shadows || 0) + (s.aeSh || 0);
            const effHi = (s.highlights || 0) + (s.aeHi || 0);
            const effBr = s.bright || 0;
            const effCon = (s.contrast || 1.0) * (s.gain || 1.0);
            const table = generateToneTable(effSh, effHi, effBr, effCon);
            ['R', 'G', 'B'].forEach(c => qs(nodes.lin.querySelector(`[data-id="lin${c}"]`), 'tableValues', table));

            const combinedGamma = (s.gamma || 1.0) * (s.aeGamma || 1.0);
            const exp = (1 / clamp(combinedGamma, 0.2, 3.0)).toFixed(3);
            ['R', 'G', 'B'].forEach(c => qs(nodes.gam.querySelector(`[data-id="gm${c}"]`), 'exponent', exp));

            const t = clamp(s.temp || 0, -25, 25);
            let rs=1, gs=1, bs=1;
            if(t > 0) { rs = 1+t*0.012; gs = 1+t*0.003; bs = 1-t*0.010; }
            else { const k = -t; bs = 1+k*0.012; gs = 1+k*0.003; rs = 1-k*0.010; }
            qs(nodes.tmp.querySelector('[data-id="tpR"]'), 'slope', rs.toFixed(3));
            qs(nodes.tmp.querySelector('[data-id="tpG"]'), 'slope', gs.toFixed(3));
            qs(nodes.tmp.querySelector('[data-id="tpB"]'), 'slope', bs.toFixed(3));

            const v1 = (s.sharp || 0) / 50;
            const sigmaC = v1 > 0 ? (1.5 - (sCurve(Math.min(1, v1)) * 0.8)) : 0;
            const kC = sCurve(Math.min(1, v1)) * 2.0;
            qs(nodes.b1, 'stdDeviation', sigmaC.toFixed(2));
            qs(nodes.sh1, 'k2', (1 + kC).toFixed(3));
            qs(nodes.sh1, 'k3', (-kC).toFixed(3));

            const v2 = (s.sharp2 || 0) / 50;
            const sigmaF = v2 > 0 ? (0.5 - (sCurve(Math.min(1, v2)) * 0.3)) : 0;
            const kF = sCurve(Math.min(1, v2)) * 3.5;
            qs(nodes.b2, 'stdDeviation', sigmaF.toFixed(2));
            qs(nodes.sh2, 'k2', (1 + kF).toFixed(3));
            qs(nodes.sh2, 'k3', (-kF).toFixed(3));

            const clVal = (s.clarity || 0) / 50;
            qs(nodes.bc, 'stdDeviation', clVal > 0 ? '2.2' : '0');
            qs(nodes.cl, 'k2', (1 + clVal).toFixed(3));
            qs(nodes.cl, 'k3', (-clVal).toFixed(3));
            qs(nodes.gr, 'k3', ((s.dither || 0) / 100 * 0.22).toFixed(3));
        }

        return {
            update: (el, s, kind) => {
                const doc = el.ownerDocument || document;
                let ctx = ctxMap.get(doc);
                if (!ctx) { ctx = buildSvg(doc); ctxMap.set(doc, ctx); }
                const nodes = (kind === 'image') ? ctx.image : ctx.video;
                const url = `url(#${nodes.fid})`;
                if (el.style.filter !== url) {
                    el.style.setProperty('filter', url, 'important');
                    el.style.setProperty('-webkit-filter', url, 'important');
                }
                updateNodes(nodes, s);
            },
            clear: (el) => {
                el.style.removeProperty('filter');
                el.style.removeProperty('-webkit-filter');
            }
        };
    });

    // ==========================================
    // 8. UI
    // ==========================================
    def('UI', () => {
        const { h } = use('Utils');
        const sm = use('Store');
        let container, monitorEl, gearTrigger;

        const SLIDERS = [
            { l:'감마', k:'video.gamma', min:0.5, max:2.5, s:0.05, f:v=>v.toFixed(2) },
            { l:'대비', k:'video.contrast', min:0.5, max:2.0, s:0.05, f:v=>v.toFixed(2) },
            { l:'밝기', k:'video.bright', min:-50, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'채도', k:'video.sat', min:0, max:200, s:5, f:v=>v.toFixed(0) },
            { l:'윤곽(V91)', k:'video.sharp', min:0, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'디테일(V91)', k:'video.sharp2', min:0, max:50, s:1, f:v=>v.toFixed(0) },
            { l:'명료', k:'video.clarity', min:0, max:50, s:5, f:v=>v.toFixed(0) },
            { l:'색온도', k:'video.temp', min:-25, max:25, s:1, f:v=>v.toFixed(0) },
            { l:'그레인', k:'video.dither', min:0, max:100, s:5, f:v=>v.toFixed(0) },
            { l:'오디오증폭', k:'audio.boost', min:0, max:12, s:1, f:v=>`+${v}dB` }
        ];

        const PRESETS_B = [
            {txt:'S',g:1.00,b:2,c:1.00,s:100}, {txt:'M',g:1.10,b:4,c:1.00,s:102}, {txt:'L',g:1.20,b:6,c:1.00,s:104},
            {txt:'DS',g:1.00,b:3.6,c:1.02,s:100}, {txt:'DM',g:1.15,b:7.2,c:1.04,s:101}, {txt:'DL',g:1.30,b:10.8,c:1.06,s:102}
        ];

        const build = () => {
            if (container) return;
            const host = h('div', { id:'vsc-host' });
            const shadow = host.attachShadow({ mode:'open' });
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
                @media (max-height: 450px) and (orientation: landscape) { .main { top: 5%; width: 360px; padding: 8px; max-height: 90vh; } .tab { padding: 6px; font-size: 12px; } .grid { row-gap: 4px; } }
            `;

            const renderSlider = (cfg) => {
                const valEl = h('span', { style: 'color:#3498db' }, '0');
                const inp = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.s });
                const update = (v) => { valEl.textContent = cfg.f(Number(v)); inp.value = v; };
                sm.sub(cfg.k, update);
                update(sm.get(cfg.k));
                inp.oninput = () => sm.set(cfg.k, Number(inp.value));
                return h('div', { class: 'slider' }, h('label', {}, cfg.l, valEl), inp);
            };

            const renderPresetRow = (label, items, key, onSelect, offBatch) => {
                const r = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
                items.forEach(it => {
                    const b = h('button', { class: 'pbtn', style: 'flex:1' }, it.l || it.txt);
                    b.onclick = () => { sm.set(key, it.l || it.txt); onSelect(it); };
                    sm.sub(key, v => b.classList.toggle('active', v === (it.l || it.txt)));
                    r.append(b);
                });
                const off = h('button', { class: 'pbtn', style: 'flex:1' }, 'OFF');
                off.onclick = () => { sm.set(key, 'off'); sm.batch('video', offBatch); };
                sm.sub(key, v => off.classList.toggle('active', v === 'off'));
                r.append(off);
                return r;
            };

            const bodyV = h('div', { id: 'p-v' }, [
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => sm.set('app.uiVisible', false) }, '✕ 닫기'),
                    h('button', { id: 'ae-btn', class: 'btn', onclick: () => sm.set('video.ae', !sm.get('video.ae')) }, '🤖 자동'),
                    h('button', { id: 'boost-btn', class: 'btn', onclick: () => sm.set('audio.enabled', !sm.get('audio.enabled')) }, '🔊 부스트')
                ),
                h('div', { class: 'prow' },
                    h('button', { class: 'btn', onclick: () => { sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); } }, '↺ 리셋'),
                    h('button', { id: 'pwr-btn', class: 'btn', onclick: () => sm.set('app.active', !sm.get('app.active')) }, '⚡ Power')
                ),
                renderPresetRow('샤프', [{l:'S',v1:8,v2:3},{l:'M',v1:15,v2:6},{l:'L',v1:25,v2:10},{l:'XL',v1:35,v2:15}], 'video.presetS',
                    (it) => sm.batch('video', { sharp: it.v1, sharp2: it.v2 }), { sharp: 0, sharp2: 0 }),
                renderPresetRow('밝기', PRESETS_B, 'video.presetB',
                    (it) => sm.batch('video', { gamma: it.g, bright: it.b, contrast: it.c, sat: it.s }), { gamma: 1.0, bright: 0, contrast: 1.0, sat: 100 }),
                h('hr'),
                h('div', { class: 'grid' }, SLIDERS.map(renderSlider)),
                h('hr'),
                h('div', { class: 'prow', style: 'justify-content:center;gap:4px;' },
                    [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
                        const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
                        b.onclick = () => sm.set('playback.rate', s);
                        sm.sub('playback.rate', v => b.classList.toggle('active', Math.abs(v - s) < 0.01));
                        return b;
                    })
                )
            ]);

            const bodyI = h('div', { id: 'p-i', style: 'display:none' }, [
                h('div', { class: 'grid' }, [
                    renderSlider({ l: '이미지 윤곽', k: 'image.level', min: 0, max: 50, s: 1, f: v => v.toFixed(0) }),
                    renderSlider({ l: '이미지 색온도', k: 'image.temp', min: -20, max: 20, s: 1, f: v => v.toFixed(0) })
                ])
            ]);

            shadow.append(h('style', {}, style), h('div', { class: 'main' }, [
                h('div', { class: 'tabs' }, [
                    h('button', { id: 't-v', class: 'tab active', onclick: () => sm.set('app.tab', 'video') }, 'VIDEO'),
                    h('button', { id: 't-i', class: 'tab', onclick: () => sm.set('app.tab', 'image') }, 'IMAGE')
                ]),
                bodyV, bodyI, monitorEl = h('div', { class: 'monitor' }, 'Ready (v141 Hybrid-Pro)')
            ]));

            sm.sub('app.tab', v => {
                shadow.getElementById('t-v').classList.toggle('active', v === 'video');
                shadow.getElementById('t-i').classList.toggle('active', v === 'image');
                shadow.getElementById('p-v').style.display = v === 'video' ? 'block' : 'none';
                shadow.getElementById('p-i').style.display = v === 'image' ? 'block' : 'none';
            });
            sm.sub('video.ae', v => shadow.getElementById('ae-btn').classList.toggle('active', !!v));
            sm.sub('audio.enabled', v => shadow.getElementById('boost-btn').classList.toggle('active', !!v));
            sm.sub('app.active', v => shadow.getElementById('pwr-btn').style.color = v ? '#2ecc71' : '#e74c3c');

            container = host;
            (document.body || document.documentElement).appendChild(container);
            sm.sub('app.uiVisible', v => container.style.display = v ? 'block' : 'none');
        };

        gearTrigger = h('div', {
            style: 'position:fixed;top:45%;right:0;width:44px;height:44px;background:rgba(0,0,0,0.7);z-index:2147483647;cursor:pointer;display:none;align-items:center;justify-content:center;border-radius:12px 0 0 12px;color:#fff;font-size:22px;',
            onclick: () => { build(); sm.set('app.uiVisible', !sm.get('app.uiVisible')); }
        }, '⚙️');

        const syncUI = () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            gearTrigger.style.display = (IS_TOP || isFs) ? 'flex' : 'none';
            const root = document.fullscreenElement || document.body || document.documentElement;
            if (root) {
                if (gearTrigger.parentElement !== root) root.appendChild(gearTrigger);
                if (container && container.parentElement !== root) root.appendChild(container);
            }
        };
        setInterval(syncUI, 1000);

        return {
            update: (m, act) => {
                if (monitorEl && container?.style.display !== 'none') {
                    monitorEl.textContent = m;
                    monitorEl.style.color = act ? '#4cd137' : '#aaa';
                }
            }
        };
    });

    // ==========================================
    // 9. ORCHESTRATOR
    // ==========================================
    const sm = use('Store'), Filters = use('Filters'), UI = use('UI'), Audio = use('Audio');
    let currentAE = { g: 1, c: 1, s: 1, sh: 0, hi: 0, gain: 1.0 }, _applyQueued = false;

    function scheduleApply(immediate = false) {
        if (immediate) { apply(); return; }
        if (_applyQueued) return;
        _applyQueued = true;
        requestAnimationFrame(() => { _applyQueued = false; apply(); });
    }

    document.addEventListener('vsc-ae-res', (e) => {
        currentAE = e.detail.ae;
        scheduleApply();
    });

    window.addEventListener('vsc-ignite-fast', () => scheduleApply(true));
    window.addEventListener('vsc-ignite', () => scheduleApply());

    function apply() {
        const vf = sm.get('video'), img = sm.get('image'), active = sm.get('app.active');
        use('Registry').prune();

        let aeGain = 1.0, aeGamma = 1.0, aeCon = 1.0, aeSat = 1.0, aeSh = 0, aeHi = 0;
        if (active && vf.ae) {
            aeGain = currentAE.gain; aeGamma = currentAE.g;
            aeCon = currentAE.c; aeSat = currentAE.s;
            aeSh = currentAE.sh; aeHi = currentAE.hi;
        }

        const vVals = {
            gain: aeGain, gamma: vf.gamma, contrast: vf.contrast, bright: vf.bright, sat: vf.sat,
            shadows: 0, highlights: 0, aeGamma, aeCon, aeSat, aeSh, aeHi,
            sharp: vf.sharp, sharp2: vf.sharp2, clarity: vf.clarity, dither: vf.dither, temp: vf.temp
        };

        const iVals = {
            gain: 1.0, gamma: 1.0, contrast: 1.0, bright: 0, sat: 100,
            sharp: img.level, sharp2: 0, clarity: 0, dither: 0, temp: img.temp
        };

        if (active && vf.ae && sm.get('app.uiVisible')) {
            UI.update(`AE: EV ${Math.log2(aeGain).toFixed(2)} | G:${aeGain.toFixed(2)}`, true);
        }

        if (active && vf.ae) use('Analyzer').wake();

        for (const el of use('Registry').videos) {
            if (!active) {
                Filters.clear(el);
                if (el.__vsc_origRate != null) el.playbackRate = el.__vsc_origRate;
                continue;
            }
            Filters.update(el, vVals, 'video');
            use('Analyzer').attach(el);
            Audio.attach(el);

            const desiredRate = sm.get('playback.rate');
            if (el.__vsc_origRate == null) el.__vsc_origRate = el.playbackRate;
            if (Math.abs(el.playbackRate - desiredRate) > 0.01) el.playbackRate = desiredRate;
        }

        for (const el of use('Registry').images) {
            if (!active) { Filters.clear(el); continue; }
            if (el.width > 50) Filters.update(el, iVals, 'image');
        }

        Audio.update();
    }

    sm.sub('app.active', (v) => { if(v) scheduleApply(true); else apply(); });
    sm.sub('video.*', scheduleApply);
    sm.sub('image.*', scheduleApply);
    sm.sub('audio.*', scheduleApply);
    sm.sub('playback.rate', scheduleApply);

    setInterval(scheduleApply, 5000);
    use('UI');
})();
