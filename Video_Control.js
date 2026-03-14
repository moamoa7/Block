// ==UserScript==
// @name         딜레이 미터기
// @namespace    https://github.com/moamoa7
// @version      7.1.0
// @description  라이브 방송의 딜레이를 자동으로 최적화합니다.
// @author       DelayMeter
// @match        https://play.sooplive.co.kr/*
// @match        https://chzzk.naver.com/*
// @match        https://*.chzzk.naver.com/*
// @grant        GM_addStyle
// @grant        GM_info
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const IS_CHZZK = location.hostname.includes('chzzk.naver.com');
    const P_OFFSET = IS_CHZZK ? 500 : 0;

    const SL_MIN = 1500, SL_MAX = 6000, SL_DEF = IS_CHZZK ? 3000 : 4000;
    const sl2ms = v => Math.round(SL_MIN + (SL_MAX - SL_MIN) * v / 100);
    const ms2sl = ms => Math.round((ms - SL_MIN) / (SL_MAX - SL_MIN) * 100);

    const T = {
        INTERVAL: 500, BOOST: 1.03,
        TRIG: 1500, SETTLE: 300,
        B_MAX: 20000, B_CD: 5000, B_MIN: 4000, B_CONFIRM: 5,
        HIST: 10, SEEK_CD: 15000,
        SPIKE: 2000, SPIKE_CD: 2000,
        STALL_MAX: 100, STALL_TH: 6,
        DROP_TH: 0.03, MIN_BUF: 2.0,
        WARMUP: 5000, WARMUP_BUF: 3.0,
        RATE_PROT: 400,
    };

    const seekTh = t => Math.max(15000, t * 4);
    const SKEY = 'dm_v5';
    let _c = null;
    const cfg = () => _c || (_c = (() => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } })());
    const save = p => { _c = { ...cfg(), ...p }; clearTimeout(save.t); save.t = setTimeout(() => localStorage.setItem(SKEY, JSON.stringify(_c)), 300); };
    window.addEventListener('beforeunload', () => { clearTimeout(save.t); if (_c) localStorage.setItem(SKEY, JSON.stringify(_c)); });

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const color = (() => {
        const G = [0x2e,0xcc,0x71], Y = [0xf1,0xc4,0x0f], R = [0xe7,0x4c,0x3c];
        const lerp = (a, b, t) => '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
        return d => { if (d <= 0) return '#2ecc71'; const r = clamp(d / 3000, 0, 1); return r <= .5 ? lerp(G, Y, r * 2) : lerp(Y, R, (r - .5) * 2); };
    })();

    const isBlobSrc = v => (v.currentSrc || v.src || '').startsWith('blob:');
    const bufEdge = buf => buf?.length ? { s: buf.start(buf.length - 1), e: buf.end(buf.length - 1) } : null;
    const isLive = v => { const d = v.duration; if (d === Infinity || d >= 1e6) return true; if (!Number.isFinite(d) || !d) return v.buffered.length > 0; if (!v.buffered.length) return false; const e = v.buffered.end(v.buffered.length - 1); return d - e >= 1 && e > v.currentTime + 1; };

    let vid = null, vidSrc = '', vidBlob = false;
    let timerId, tickGen = 0, nextTick = 0;
    let target = cfg().target ?? SL_DEF, seekTH = seekTh(target);
    let enabled = cfg().enabled ?? true;

    let setRateT = 0, lastRate = -1, rate = 1.0, rateStr = '1.000x';
    let mediaTime = 0, presFrames = 0, fps = 30;
    let prevAvg = 0, seekT = 0, spikeT = 0;
    let lastCT = 0, stall = 0, paused = false;
    let dropF = 0, totalF = 0, hasPQ = false, fcnt = 0;

    let boosting = false, boostT0 = 0, boostEnd = 0;
    let confirmCnt = 0, lowBuf = 0;

    let warmT0 = performance.now(), warmEnd = warmT0 + T.WARMUP, warmed = false;
    let seekAc = null;
    let panelOpen = false, lastDot = '', els = {};

    const hist = []; hist.max = T.HIST;
    const hPush = v => { hist.push(v); if (hist.length > hist.max) hist.shift(); };
    const hAvg = () => {
        const n = hist.length;
        if (n <= 1) return hist[n - 1] || 0;
        if (n === 2) return (hist[0] + hist[1]) / 2;
        const sorted = [...hist].sort((a, b) => a - b);
        const trim = sorted.slice(1, -1);
        let wS = 0, wT = 0;
        for (let i = 0; i < n; i++) { const w = 1 << i; wS += hist[i] * w; wT += w; }
        const tA = trim.reduce((a, b) => a + b) / trim.length, wA = wS / wT;
        return tA > wA ? tA * .7 + wA * .3 : wA * .7 + tA * .3;
    };

    let fcGen = 0;
    const startFC = v => {
        if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
        const g = ++fcGen; let prev = 0;
        const step = (now, md) => {
            if (g !== fcGen) return;
            mediaTime = md.mediaTime;
            if (md.presentedFrames > presFrames + 1 && prev > 0) { const dt = (now - prev) / 1000, df = md.presentedFrames - presFrames; if (dt > 0) fps = Math.round(df / dt); }
            presFrames = md.presentedFrames; prev = now;
            v.requestVideoFrameCallback(step);
        };
        v.requestVideoFrameCallback(step);
    };

    const setR = r => {
        if (!vid || vid.paused || (r !== 1 && vid.readyState < 3)) return;
        const v = Math.round(r * 1000) / 1000;
        if (v === lastRate) return;
        setRateT = performance.now(); vid.playbackRate = v;
        lastRate = v; rate = v; rateStr = v === 1 ? '1.000x' : v.toFixed(3) + 'x';
    };

    const boostOn = now => { if (boosting) return; boosting = true; boostT0 = now; setR(T.BOOST); };
    const boostOff = now => { if (!boosting) return; boosting = false; boostEnd = now; confirmCnt = 0; setR(1); };
    const soft = () => { hist.length = 0; boostOff(performance.now()); confirmCnt = 0; lowBuf = 0; lastRate = -1; rateStr = '1.000x'; };

    const onExtRate = () => {
        if (performance.now() - setRateT < T.RATE_PROT || !vid) return;
        const x = vid.playbackRate;
        if (Math.abs(x - lastRate) < .002) return;
        if (boosting) { boosting = false; boostEnd = performance.now(); }
        confirmCnt = 0; rate = x; lastRate = x; rateStr = x.toFixed(3) + 'x';
    };

    const checkDrops = () => {
        if (!hasPQ || !vid) return;
        const q = vid.getVideoPlaybackQuality();
        const dd = q.droppedVideoFrames - dropF, td = q.totalVideoFrames - totalF;
        dropF = q.droppedVideoFrames; totalF = q.totalVideoFrames;
        if (td >= 10 && dd / td > T.DROP_TH && boosting) { boostOff(performance.now()); boostEnd = performance.now() + 8000; }
    };

    const reset = () => {
        seekAc?.abort(); seekAc = null;
        mediaTime = 0; lastCT = 0; stall = 0; paused = false;
        rate = 1; lastRate = -1; rateStr = '1.000x'; spikeT = 0;
        fcnt = 0; boosting = false; boostT0 = 0; boostEnd = 0;
        confirmCnt = 0; lowBuf = 0; hist.length = 0;
        warmed = false; warmT0 = performance.now(); warmEnd = warmT0 + T.WARMUP;
    };

    const loaded = new WeakSet();
    const attach = v => {
        if (vid && vid !== v) vid.removeEventListener('ratechange', onExtRate);
        vid = v; vidSrc = v.currentSrc || v.src || ''; vidBlob = isBlobSrc(v);
        reset(); startFC(v);
        const q = v.getVideoPlaybackQuality?.();
        hasPQ = !!q; dropF = q?.droppedVideoFrames || 0; totalF = q?.totalVideoFrames || 0;
        v.removeEventListener('ratechange', onExtRate);
        v.addEventListener('ratechange', onExtRate);
    };

    const found = v => {
        if (!isBlobSrc(v)) return;
        const s = v.currentSrc || v.src || '';
        if (vid === v && s === vidSrc) return;
        attach(v);
        if (!loaded.has(v)) { loaded.add(v); v.addEventListener('loadstart', () => { if (v === vid) { const ns = v.currentSrc || v.src || ''; if (ns !== vidSrc && isBlobSrc(v)) attach(v); } }); }
    };

    let obs = null;
    const startObs = () => {
        if (obs) return;
        obs = new MutationObserver(ms => {
            for (const m of ms) for (const n of m.addedNodes) {
                const v = n.nodeName === 'VIDEO' ? n : n.nodeType === 1 ? n.querySelector?.('video') : null;
                if (v) { found(v); if (vid) { obs.disconnect(); obs = null; } return; }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    };

    const doSeek = (s, e, reason) => {
        seekAc?.abort();
        const ac = seekAc = new AbortController();
        const sig = AbortSignal.any([ac.signal, AbortSignal.timeout(5000)]);
        const to = Math.max(s, e - target / 1000);
        seekT = performance.now();
        vid.currentTime = to;
        vid.addEventListener('seeked', () => {
            if (vid?.isConnected && Math.abs(vid.currentTime - to) <= 2) {
                const t = setTimeout(() => {
                    ac.abort();
                    if (!vid?.isConnected) return;
                    const b = bufEdge(vid.buffered);
                    if (b && (b.e - vid.currentTime) * 1000 > target * 1.5)
                        vid.currentTime = Math.max(b.s, b.e - target / 1000);
                }, 50);
                sig.addEventListener('abort', () => clearTimeout(t), { once: true });
            } else ac.abort();
        }, { once: true, signal: sig });
    };

    const isWarm = () => {
        if (warmed) return true;
        if (performance.now() < warmEnd || !vid || vid.readyState < 3 || vid.paused) return false;
        const b = bufEdge(vid.buffered);
        if (!b || b.e - vid.currentTime < T.WARMUP_BUF + P_OFFSET / 1000) return false;
        return (warmed = true);
    };

    const ui = avgMs => {
        if (!panelOpen) {
            if (!els.dot) return;
            const c = !enabled ? '#555' : color(avgMs - target);
            if (c !== lastDot) { lastDot = c; els.dot.style.background = c; els.dot.style.boxShadow = enabled ? `0 0 6px ${c}` : 'none'; }
            els.dot.classList.toggle('dm-off', !enabled);
            return;
        }
        const si = !warmed ? '⏳' : !enabled ? '⏹' : boosting ? '⚡' : Math.abs(avgMs - target) < T.TRIG ? '✓' : '→';
        els.delay.textContent = (avgMs / 1000).toFixed(2) + 's ' + si;
        els.delay.style.color = color(avgMs - target);
        els.bar.style.width = clamp(avgMs / 8000 * 100, 0, 100) + '%';
        els.bar.style.background = els.delay.style.color;
        els.rate.textContent = rateStr;
        els.rate.style.color = boosting ? '#f39c12' : '';
        els.rbar.style.width = boosting ? '100%' : '0%';
        els.rbar.style.background = boosting ? '#f39c12' : '#3498db';
    };

    const process = () => {
        const now = performance.now();
        if (!isWarm()) { const b = bufEdge(vid.buffered); ui(b ? Math.max(0, (b.e - vid.currentTime) * 1000 + P_OFFSET) : 0); return; }
        if (++fcnt % 8 === 0) checkDrops();
        const b = bufEdge(vid.buffered);
        if (!b) { ui(0); return; }
        const ref = mediaTime > 0 && Math.abs(mediaTime - vid.currentTime) < 3 / fps ? mediaTime : vid.currentTime;
        const raw = (b.e - ref) * 1000;
        if (raw < 0) { ui(0); return; }
        const delay = raw + P_OFFSET, ahead = b.e - vid.currentTime;
        if (ahead < T.MIN_BUF) { lowBuf++; if (boosting) { boostOff(now); boostEnd = now + 8000; } } else lowBuf = 0;
        const ct = vid.currentTime;
        if (Math.abs(ct - lastCT) < .001 && !vid.paused) { stall++; if (stall >= T.STALL_MAX && enabled) { const sb = bufEdge(vid.buffered); if (sb) { doSeek(sb.s, sb.e, 'stall'); soft(); setR(1); } stall = 0; } } else stall = 0;
        lastCT = ct;
        if (paused && !vid.paused) { paused = false; lastRate = -1; } paused = vid.paused;
        if (enabled && delay > seekTH && stall < T.STALL_TH && now - seekT >= T.SEEK_CD) { doSeek(b.s, b.e, 'auto'); soft(); setR(1); ui(target); return; }
        const last = hist[hist.length - 1];
        if (last > 0 && Math.abs(delay - last) > T.SPIKE && now - spikeT >= T.SPIKE_CD) { spikeT = now; ui(prevAvg || target); return; }
        hPush(delay);
        const avg = hAvg(); prevAvg = avg; ui(avg);
        if (!enabled) { if (boosting) boostOff(now); if (rate !== 1) setR(1); return; }
        if (boosting) { const dur = now - boostT0; if ((avg <= target + T.SETTLE && dur >= T.B_MIN) || avg < target - 300 || dur >= T.B_MAX) boostOff(now); }
        else { if (avg > target + T.TRIG && now - boostEnd >= T.B_CD && ahead >= T.MIN_BUF + 1) confirmCnt++; else confirmCnt = 0; if (confirmCnt >= T.B_CONFIRM) { confirmCnt = 0; boostOn(now); } }
    };

    const tick = () => {
        if (vid && !vid.isConnected) { vid.removeEventListener('ratechange', onExtRate); vid = null; vidBlob = false; if (!obs) startObs(); }
        if (!vid) { const v = document.querySelector('video'); if (v) found(v); ui(0); return; }
        if (!vidBlob || !isLive(vid)) { if (boosting) boostOff(performance.now()); if (rate !== 1) setR(1); ui(0); return; }
        process();
    };

    const schedule = () => {
        const g = tickGen, now = performance.now();
        try { tick(); } catch (e) { console.warn('[DM]', e); }
        if (g !== tickGen) return;
        if (document.hidden) { nextTick = 0; timerId = setTimeout(schedule, 1000); return; }
        const iv = !enabled || !warmed ? 700 : T.INTERVAL;
        if (!nextTick) nextTick = now + iv; else nextTick += iv;
        if (nextTick - performance.now() < -iv * 2) nextTick = performance.now() + iv;
        timerId = setTimeout(schedule, Math.max(1, nextTick - performance.now()));
    };

    // ── UI ──
    const build = () => {
        if (document.getElementById('dm-dot')) return;
        GM_addStyle(`
#dm-dot{position:fixed;bottom:20px;right:20px;z-index:10000;width:14px;height:14px;border-radius:50%;cursor:pointer;background:#555;transition:background .3s,box-shadow .3s}
@keyframes dmp{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.35);opacity:1}}
#dm-dot:not(.dm-off){animation:dmp 2s ease-in-out infinite}#dm-dot.dm-off{opacity:.4}
#dm-p{position:fixed;bottom:20px;right:20px;z-index:10000;background:rgba(12,12,16,.92);backdrop-filter:blur(3px);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 16px;color:#eee;font:12px system-ui,sans-serif;width:210px;box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;display:none}
.dh{font-weight:bold;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:8px;cursor:grab;display:flex;align-items:center}
.dr{display:flex;justify-content:space-between;align-items:center;margin:5px 0}
.dv{font:bold 15px ui-monospace,monospace;font-variant-numeric:tabular-nums}
.db{background:rgba(255,255,255,.08);height:5px;border-radius:3px;margin:3px 0 7px;overflow:hidden}
.df{height:100%;min-width:2%;border-radius:3px;transition:width .3s}
.sr{margin:10px 0 2px;display:flex;align-items:center;gap:6px;font-size:11px}
.sr input[type=range]{flex:1;height:4px;-webkit-appearance:none;background:rgba(255,255,255,.12);border-radius:2px;outline:none}
.sr input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#2ecc71;cursor:pointer}
.sl{text-align:center;font:bold 12px ui-monospace,monospace;margin-bottom:4px}
.bt{cursor:pointer;border:none;border-radius:4px;padding:4px 10px;font:bold 11px system-ui;transition:.1s}
.bt:active{transform:scale(.95)}
.bon{background:#2ecc71;color:#000}.boff{background:#555;color:#999}
#dm-p.dis{filter:brightness(.65)}
.x{margin-left:auto;cursor:pointer;font-size:14px;opacity:.4;padding:0 4px}.x:hover{opacity:.9}
.pt{font-size:9px;opacity:.35}`);

        const dot = document.createElement('div'); dot.id = 'dm-dot'; document.body.appendChild(dot);
        const p = document.createElement('div'); p.id = 'dm-p';
        p.innerHTML = `<div class="dh" data-h>딜레이 미터기<span class="x" data-x>✕</span></div>
<div class="dr"><span>버퍼</span><span class="dv" data-d>-</span></div><div class="db"><div class="df" data-b></div></div>
<div class="dr"><span>배속</span><span class="dv" data-r>1.000x</span></div><div class="db"><div class="df" data-rb></div></div>
<div class="sr"><span style="opacity:.5">저지연</span><input type=range data-sl min=0 max=100 value=${ms2sl(target)}><span style="opacity:.5">안정</span></div>
<div class="sl" data-sv>${(target/1000).toFixed(1)}초</div>
<div style="display:flex;align-items:center;gap:6px;margin-top:6px"><button class="bt" data-t>ON</button><span class="pt">${IS_CHZZK?'CHZZK':'SOOP'} v${GM_info.script.version}</span></div>`;
        document.body.appendChild(p);

        const $ = s => p.querySelector(`[data-${s}]`);
        els = { dot, p, delay: $('d'), bar: $('b'), rate: $('r'), rbar: $('rb'), tog: $('t'), sl: $('sl'), sv: $('sv'), hdr: $('h'), x: $('x') };

        dot.onclick = () => { if (!dot._m) openP(); };
        els.x.onclick = e => { e.stopPropagation(); closeP(); };

        const togUI = () => { els.tog.textContent = enabled ? 'ON' : 'OFF'; els.tog.className = 'bt ' + (enabled ? 'bon' : 'boff'); p.classList.toggle('dis', !enabled); };
        togUI();
        els.tog.onclick = () => { enabled = !enabled; if (!enabled) { boostOff(performance.now()); setR(1); } save({ enabled }); togUI(); };

        els.sl.oninput = () => { target = sl2ms(+els.sl.value); seekTH = seekTh(target); els.sv.textContent = (target / 1000).toFixed(1) + '초'; soft(); setR(1); };
        els.sl.onchange = () => save({ target });

        // drag panel
        let dx, dy, dg = false;
        els.hdr.onpointerdown = e => { if (e.button || e.target === els.x) return; dg = true; els.hdr.setPointerCapture(e.pointerId); const r = p.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; };
        els.hdr.onpointermove = e => { if (!dg) return; p.style.left = clamp(e.clientX - dx, 0, innerWidth - p.offsetWidth) + 'px'; p.style.top = clamp(e.clientY - dy, 0, innerHeight - p.offsetHeight) + 'px'; p.style.right = p.style.bottom = 'auto'; };
        els.hdr.onpointerup = () => { if (!dg) return; dg = false; save({ px: p.style.left, py: p.style.top }); };

        // drag dot
        let ddx, ddy, dd = false;
        dot.onpointerdown = e => { if (e.button) return; dd = true; dot._m = false; dot.setPointerCapture(e.pointerId); const r = dot.getBoundingClientRect(); ddx = e.clientX - r.left; ddy = e.clientY - r.top; };
        dot.onpointermove = e => { if (!dd) return; dot._m = true; dot.style.left = clamp(e.clientX - ddx, 0, innerWidth - 14) + 'px'; dot.style.top = clamp(e.clientY - ddy, 0, innerHeight - 14) + 'px'; dot.style.right = dot.style.bottom = 'auto'; };
        dot.onpointerup = () => { if (!dd) return; dd = false; if (dot._m) save({ dx: dot.style.left, dy: dot.style.top }); };

        const c = cfg();
        if (c.px) { const x = parseFloat(c.px), y = parseFloat(c.py); if (x >= 0 && x < innerWidth - 50 && y >= 0 && y < innerHeight - 50) Object.assign(p.style, { left: c.px, top: c.py, right: 'auto', bottom: 'auto' }); }
        if (c.dx) { const x = parseFloat(c.dx), y = parseFloat(c.dy); if (x >= 0 && x < innerWidth - 14 && y >= 0 && y < innerHeight - 14) Object.assign(dot.style, { left: c.dx, top: c.dy, right: 'auto', bottom: 'auto' }); }

        panelOpen = cfg().open ?? false;
        if (panelOpen) { p.style.display = 'block'; dot.style.display = 'none'; }
    };

    const openP = () => { if (panelOpen) return; panelOpen = true; save({ open: true }); els.dot.style.display = 'none'; els.p.style.display = 'block'; lastDot = ''; };
    const closeP = () => { if (!panelOpen) return; panelOpen = false; save({ open: false }); const r = els.p.getBoundingClientRect(); els.p.style.display = 'none'; els.dot.style.display = 'block'; Object.assign(els.dot.style, { left: clamp(r.right - 20, 0, innerWidth - 14) + 'px', top: clamp(r.top + 6, 0, innerHeight - 14) + 'px', right: 'auto', bottom: 'auto' }); save({ dx: els.dot.style.left, dy: els.dot.style.top }); lastDot = ''; };

    const keys = {
        KeyD: () => els.tog?.click(),
        KeyH: () => panelOpen ? closeP() : openP(),
        ArrowUp: () => { els.sl.value = Math.min(100, +els.sl.value + 10); els.sl.dispatchEvent(new Event('input')); els.sl.dispatchEvent(new Event('change')); },
        ArrowDown: () => { els.sl.value = Math.max(0, +els.sl.value - 10); els.sl.dispatchEvent(new Event('input')); els.sl.dispatchEvent(new Event('change')); },
        KeyI: () => { if (!vid) return; const b = bufEdge(vid.buffered); console.table({ delay: (prevAvg / 1000).toFixed(2) + 's', rate: rate.toFixed(3), target, boost: boosting, stall, fps, buf: b ? (b.e - vid.currentTime).toFixed(1) + 's' : '-' }); }
    };

    let lastPath = location.pathname, hiddenAt = 0;

    build(); startObs();
    document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') found(e.target); }, true);
    const v = document.querySelector('video'); if (v) found(v);
    schedule();

    if ('navigation' in window) navigation.addEventListener('navigatesuccess', () => { if (location.pathname !== lastPath) { lastPath = location.pathname; reset(); if (!obs) startObs(); } });
    else setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; reset(); if (!obs) startObs(); } }, 1000);

    document.addEventListener('visibilitychange', () => {
        nextTick = 0; tickGen++; clearTimeout(timerId);
        if (document.hidden) { hiddenAt = performance.now(); return; }
        const away = performance.now() - hiddenAt; reset();
        if (away > 30000 && enabled && vid?.isConnected && vid.buffered.length) { const b = bufEdge(vid.buffered); if (b && (b.e - vid.currentTime) * 1000 > seekTH) { doSeek(b.s, b.e, 'tab'); warmed = true; } }
        schedule();
    });

    document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
        if (!els.p) return;
        const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
        if (document.fullscreenElement) Object.assign(els.p.style, def);
        else { const c = cfg(); Object.assign(els.p.style, c.px ? { left: c.px, top: c.py, right: 'auto', bottom: 'auto' } : def); }
    }));

    document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        const t = document.activeElement?.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
        const fn = keys[e.code]; if (fn) { e.preventDefault(); fn(); }
    });
})();
