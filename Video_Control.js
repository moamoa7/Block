// ==UserScript==
// @name         딜레이 미터기
// @namespace    https://github.com/moamoa7
// @version      8.2.0
// @description  라이브 방송의 딜레이를 자동으로 최적화합니다.
// @author       DelayMeter
// @match        https://play.sooplive.co.kr/*
// @match        https://chzzk.naver.com/*
// @match        https://*.chzzk.naver.com/*
// @grant        GM_addStyle
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SKEY = 'dm_v6';
    const SL_MIN = 2, SL_MAX = 8, SL_DEF = 4;
    const KEEP_BUF = 3;
    const SEEK_MARGIN = 3;
    const SEEK_CD = 10000;
    const CHECK_MS = 2000;
    const CHECK_IDLE = 5000;
    const WARMUP = 5000;

    let _c = null;
    const cfg = () => _c || (_c = (() => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } })());
    const save = p => { _c = { ...cfg(), ...p }; clearTimeout(save.t); save.t = setTimeout(() => localStorage.setItem(SKEY, JSON.stringify(_c)), 300); };
    window.addEventListener('beforeunload', () => { clearTimeout(save.t); if (_c) localStorage.setItem(SKEY, JSON.stringify(_c)); });

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const color = (() => {
        const G = [0x2e,0xcc,0x71], Y = [0xf1,0xc4,0x0f], R = [0xe7,0x4c,0x3c];
        const lerp = (a, b, t) => '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
        return d => { if (d <= 0) return '#2ecc71'; const r = clamp(d / 5, 0, 1); return r <= .5 ? lerp(G, Y, r * 2) : lerp(Y, R, (r - .5) * 2); };
    })();

    const isBlobSrc = v => (v.currentSrc || v.src || '').startsWith('blob:');

    let vid = null, vidSrc = '';
    let target = cfg().target ?? SL_DEF;
    let enabled = cfg().enabled ?? true;
    let lastSeek = 0, startTime = performance.now();
    let panelOpen = false, lastDot = '', els = {};
    let debug = cfg().debug ?? false;
    let cachedBuf = -1;

    const loaded = new WeakSet();
    const attach = v => { vid = v; vidSrc = v.currentSrc || v.src || ''; lastSeek = 0; startTime = performance.now(); };
    const found = v => {
        if (!isBlobSrc(v)) return;
        const s = v.currentSrc || v.src || '';
        if (vid === v && s === vidSrc) return;
        attach(v);
        if (!loaded.has(v)) {
            loaded.add(v);
            v.addEventListener('loadstart', () => {
                if (v === vid && isBlobSrc(v)) {
                    const ns = v.currentSrc || v.src || '';
                    if (ns !== vidSrc) attach(v);
                }
            });
        }
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

    /* ── 버퍼 읽기: 한 틱에 딱 한 번 ── */
    const readBuf = () => {
        if (!vid || !vid.buffered.length) return -1;
        const e = vid.buffered.end(vid.buffered.length - 1);
        return e - vid.currentTime;
    };

    const isLive = () => {
        if (!vid) return false;
        const d = vid.duration;
        if (d === Infinity || d >= 1e6) return true;
        if (!Number.isFinite(d) || !d) return cachedBuf > 0;
        return false;
    };

    const doSeek = () => {
        if (!vid?.buffered.length) return;
        const e = vid.buffered.end(vid.buffered.length - 1);
        const s = vid.buffered.start(vid.buffered.length - 1);
        vid.currentTime = Math.max(s, e - KEEP_BUF);
        lastSeek = performance.now();
        if (debug) console.debug(`[DM] seek → buf=${(e - vid.currentTime).toFixed(1)}s 남김`);
    };

    const tick = () => {
        if (vid && !vid.isConnected) { vid = null; if (!obs) startObs(); }
        if (!vid) { const v = document.querySelector('video'); if (v) found(v); }
        if (!vid || !isBlobSrc(vid) || vid.paused) { cachedBuf = -1; ui(-1); return; }

        /* buffered 접근은 여기서 딱 1회 */
        cachedBuf = readBuf();

        if (!isLive()) { cachedBuf = -1; ui(-1); return; }

        ui(cachedBuf);

        if (!enabled) return;

        const now = performance.now();
        if (now - startTime < WARMUP) return;

        if (cachedBuf > target + SEEK_MARGIN && now - lastSeek > SEEK_CD) {
            if (debug) console.debug(`[DM] 버퍼 ${cachedBuf.toFixed(1)}s > ${target}+${SEEK_MARGIN}s → seek`);
            doSeek();
        }
    };

    const ui = buf => {
        const sec = buf < 0 ? 0 : buf;
        const diff = sec - target;

        if (!panelOpen) {
            if (!els.dot) return;
            const c = !enabled ? '#555' : color(diff);
            if (c !== lastDot) { lastDot = c; els.dot.style.background = c; els.dot.style.boxShadow = enabled ? `0 0 6px ${c}` : 'none'; }
            els.dot.classList.toggle('dm-off', !enabled);
            return;
        }

        const si = !enabled ? '⏹' : buf < 0 ? '…' : Math.abs(diff) < SEEK_MARGIN ? '✓' : '→';
        els.delay.textContent = buf < 0 ? '-' : sec.toFixed(1) + '초 ' + si;
        els.delay.style.color = color(diff);
        els.bar.style.width = clamp(sec / 15 * 100, 0, 100) + '%';
        els.bar.style.background = els.delay.style.color;
    };

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
.bt:active{transform:scale(.95)}.bon{background:#2ecc71;color:#000}.boff{background:#555;color:#999}
#dm-p.dis{filter:brightness(.65)}
.x{margin-left:auto;cursor:pointer;font-size:14px;opacity:.4;padding:0 4px}.x:hover{opacity:.9}
.pt{font-size:9px;opacity:.35}`);

        const dot = document.createElement('div'); dot.id = 'dm-dot'; document.body.appendChild(dot);
        const p = document.createElement('div'); p.id = 'dm-p';
        const sv = Math.round((target - SL_MIN) / (SL_MAX - SL_MIN) * 100);
        p.innerHTML = `<div class="dh" data-h>딜레이 미터기<span class="x" data-x>✕</span></div>
<div class="dr"><span>버퍼</span><span class="dv" data-d>-</span></div><div class="db"><div class="df" data-b></div></div>
<div class="sr"><span style="opacity:.5">저지연</span><input type=range data-sl min=0 max=100 value=${sv}><span style="opacity:.5">안정</span></div>
<div class="sl" data-sv>${target.toFixed(1)}초</div>
<div style="display:flex;align-items:center;gap:6px;margin-top:6px"><button class="bt" data-t>ON</button><span class="pt">v${GM_info.script.version}</span></div>`;
        document.body.appendChild(p);

        const $ = s => p.querySelector(`[data-${s}]`);
        els = { dot, p, delay: $('d'), bar: $('b'), tog: $('t'), sl: $('sl'), sv: $('sv'), hdr: $('h'), x: $('x') };

        dot.onclick = () => { if (!dot._m) openP(); };
        els.x.onclick = e => { e.stopPropagation(); closeP(); };

        const togUI = () => { els.tog.textContent = enabled ? 'ON' : 'OFF'; els.tog.className = 'bt ' + (enabled ? 'bon' : 'boff'); p.classList.toggle('dis', !enabled); };
        togUI();
        els.tog.onclick = () => { enabled = !enabled; save({ enabled }); togUI(); };

        els.sl.oninput = () => {
            target = SL_MIN + (SL_MAX - SL_MIN) * els.sl.value / 100;
            target = Math.round(target * 2) / 2;
            els.sv.textContent = target.toFixed(1) + '초';
        };
        els.sl.onchange = () => save({ target });

        let dx, dy, dg = false;
        els.hdr.onpointerdown = e => { if (e.button || e.target === els.x) return; dg = true; els.hdr.setPointerCapture(e.pointerId); const r = p.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; };
        els.hdr.onpointermove = e => { if (!dg) return; p.style.left = clamp(e.clientX - dx, 0, innerWidth - p.offsetWidth) + 'px'; p.style.top = clamp(e.clientY - dy, 0, innerHeight - p.offsetHeight) + 'px'; p.style.right = p.style.bottom = 'auto'; };
        els.hdr.onpointerup = () => { if (!dg) return; dg = false; save({ px: p.style.left, py: p.style.top }); };

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

    GM_registerMenuCommand('디버그 모드 토글', () => {
        debug = !debug; save({ debug });
        console.log(`[DM] 디버그 ${debug ? 'ON' : 'OFF'}`);
    });

    GM_registerMenuCommand('현재 상태', () => {
        console.table({
            버퍼: cachedBuf < 0 ? '-' : cachedBuf.toFixed(1) + '초',
            목표: target + '초',
            활성: enabled,
            seek임계: (target + SEEK_MARGIN) + '초',
            seek후남김: KEEP_BUF + '초',
        });
    });

    /* ── init ── */
    build(); startObs();
    document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') found(e.target); }, true);
    const v = document.querySelector('video'); if (v) found(v);

    /* adaptive setTimeout 루프 */
    const schedule = () => {
        tick();
        setTimeout(schedule, panelOpen ? CHECK_MS : CHECK_IDLE);
    };
    schedule();

    let lastPath = location.pathname;
    if ('navigation' in window) navigation.addEventListener('navigatesuccess', () => { if (location.pathname !== lastPath) { lastPath = location.pathname; startTime = performance.now(); lastSeek = 0; if (!obs) startObs(); } });
    else setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; startTime = performance.now(); lastSeek = 0; if (!obs) startObs(); } }, 2000);

    document.addEventListener('visibilitychange', () => { if (!document.hidden) { startTime = performance.now(); lastSeek = 0; } });
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
        if (!els.p) return;
        const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
        if (document.fullscreenElement) Object.assign(els.p.style, def);
        else { const c = cfg(); Object.assign(els.p.style, c.px ? { left: c.px, top: c.py, right: 'auto', bottom: 'auto' } : def); }
    }));
})();
