// ==UserScript==
// @name         딜레이 미터기 (S-Class 다단변속 + 플랫폼 분리)
// @namespace    https://github.com/moamoa7
// @version      9.2.0
// @description  플랫폼을 자동 인식하여 치지직(2초)과 숲(4초)에 최적화된 배속과 설정을 독립적으로 적용합니다.
// @author       DelayMeter
// @match        https://play.sooplive.co.kr/*
// @match        https://chzzk.naver.com/*
// @match        https://*.chzzk.naver.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ═══════════════════════════════════════════
       Platform — 플랫폼 감지 및 상수
       ═══════════════════════════════════════════ */
    const Platform = Object.freeze({
        isSoop: location.hostname.includes('sooplive'),
        get name() { return this.isSoop ? 'SOOP' : '치지직'; },
        get slMin() { return this.isSoop ? 3 : 1; },
        get slMax() { return this.isSoop ? 10 : 8; },
        get slDef() { return this.isSoop ? 4.0 : 2.0; },
        get skey() { return this.isSoop ? 'dm_v9_soop' : 'dm_v9_chzzk'; },
        get barMax() { return this.isSoop ? 15 : 10; }
    });

    /* ═══════════════════════════════════════════
       Config — localStorage 설정 관리
       ═══════════════════════════════════════════ */
    const Config = (() => {
        let cache = null;
        const load = () => {
            if (cache) return cache;
            try { cache = JSON.parse(localStorage.getItem(Platform.skey)) || {}; }
            catch { cache = {}; }
            return cache;
        };
        let timer = 0;
        const persist = () => {
            try { localStorage.setItem(Platform.skey, JSON.stringify(cache)); }
            catch { /* quota exceeded — 무시 */ }
        };
        return {
            get: key => load()[key],
            getAll: () => load(),
            set: patch => { cache = { ...load(), ...patch }; clearTimeout(timer); timer = setTimeout(persist, 300); },
            flush: () => { clearTimeout(timer); if (cache) persist(); }
        };
    })();

    /* ═══════════════════════════════════════════
       Constants — 코어 설정 상수
       ═══════════════════════════════════════════ */
    const KEEP_BUF = 5;
    const PANIC_TIME = 13;
    const SEEK_CD = 10000;
    const CHECK_MS = 1000;
    const CHECK_IDLE = 5000;
    const WARMUP = 4000;
    const RATE_NORMAL = 1.0;
    const RATE_SOFT = 1.05;
    const RATE_HIGH = 1.10;
    const HYST = 0.3;
    const HIST_LEN = 60;

    /* ═══════════════════════════════════════════
       Shared State
       ═══════════════════════════════════════════ */
    const ac = new AbortController();
    const { signal } = ac;

    let vid = null;
    let target = Config.get('target') ?? Platform.slDef;
    let enabled = Config.get('enabled') ?? true;
    let lastSeek = 0, startTime = performance.now();
    let panelOpen = false, lastDot = '';
    let els = {};
    let cachedBuf = -1;
    let currentGear = RATE_NORMAL;
    let prevUIText = '', prevUIColor = '', prevUIWidth = '';
    const history = [];

    /* ═══════════════════════════════════════════
       Utilities
       ═══════════════════════════════════════════ */
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const color = (() => {
        const G = [0x2e, 0xcc, 0x71], Y = [0xf1, 0xc4, 0x0f], R = [0xe7, 0x4c, 0x3c];
        const lerp = (a, b, t) => '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
        const cache = new Map();
        return d => {
            if (d <= 0) return '#2ecc71';
            const key = Math.round(clamp(d / 5, 0, 1) * 20);
            let c = cache.get(key);
            if (c) return c;
            const r = key / 20;
            c = r <= 0.5 ? lerp(G, Y, r * 2) : lerp(Y, R, (r - 0.5) * 2);
            cache.set(key, c);
            return c;
        };
    })();

    const isBlobSrc = v => (v.currentSrc || v.src || '').startsWith('blob:');

    /* ═══════════════════════════════════════════
       VideoTracker — video 요소 탐지/연결
       ═══════════════════════════════════════════ */
    const loaded = new WeakSet();

    const attach = v => {
        vid = v;
        lastSeek = 0;
        startTime = performance.now();
        currentGear = RATE_NORMAL;
    };

    const found = v => {
        if (!isBlobSrc(v)) return;
        if (vid === v) return;
        attach(v);
        if (!loaded.has(v)) {
            loaded.add(v);
            v.addEventListener('emptied', () => {
                if (v === vid) attach(v);
            });
        }
    };

    let obs = null;
    let obsThrottle = 0;
    const startObs = () => {
        if (obs || !document.body) return;
        obs = new MutationObserver(() => {
            const now = performance.now();
            if (now - obsThrottle < 500) return;
            obsThrottle = now;
            const videos = document.querySelectorAll('video');
            for (const v of videos) found(v);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    };

    /* ═══════════════════════════════════════════
       Engine — 버퍼 측정, 기어 결정, seek
       ═══════════════════════════════════════════ */
    const readBuf = () => {
        try {
            if (!vid || !vid.buffered || !vid.buffered.length) return -1;
            return vid.buffered.end(vid.buffered.length - 1) - vid.currentTime;
        } catch { return -1; }
    };

    const isLive = () => {
        if (!vid) return false;
        const d = vid.duration;
        return d === Infinity || d >= 1e6;
    };

    const doSeek = () => {
        try {
            if (!vid?.buffered?.length) return;
            const len = vid.buffered.length;
            const e = vid.buffered.end(len - 1);
            const s = vid.buffered.start(len - 1);
            vid.currentTime = Math.max(s, e - KEEP_BUF);
            lastSeek = performance.now();
        } catch { /* buffered 접근 실패 시 무시 */ }
    };

    const setSpeed = rate => {
        if (vid && vid.playbackRate !== rate) {
            vid.playbackRate = rate;
            if (typeof vid.preservesPitch !== 'undefined') vid.preservesPitch = true;
            else if (typeof vid.mozPreservesPitch !== 'undefined') vid.mozPreservesPitch = true;
        }
    };

    let pendingBuf = -1;
    let rafId = 0;
    const renderFrame = () => { ui(pendingBuf); rafId = 0; };

    const tick = () => {
        if (vid && !vid.isConnected) { vid = null; if (!obs) startObs(); }
        if (!vid) { const v = document.querySelector('video'); if (v) found(v); }

        if (!vid || !isBlobSrc(vid) || vid.readyState < 3) {
            cachedBuf = -1;
            pendingBuf = -1;
            if (!rafId) rafId = requestAnimationFrame(renderFrame);
            return;
        }

        if (vid.paused) {
            cachedBuf = readBuf();
            pendingBuf = cachedBuf;
            if (!rafId) rafId = requestAnimationFrame(renderFrame);
            return;
        }

        cachedBuf = readBuf();
        if (!isLive()) { cachedBuf = -1; pendingBuf = -1; if (!rafId) rafId = requestAnimationFrame(renderFrame); return; }

        if (cachedBuf >= 0) { history.push(cachedBuf); if (history.length > HIST_LEN) history.shift(); }

        pendingBuf = cachedBuf;
        if (!rafId) rafId = requestAnimationFrame(renderFrame);

        if (!enabled) { setSpeed(RATE_NORMAL); currentGear = RATE_NORMAL; return; }
        const now = performance.now();
        if (now - startTime < WARMUP) return;

        /* 비상 탈출 */
        if (cachedBuf > PANIC_TIME && now - lastSeek > SEEK_CD) { doSeek(); return; }

        /* 스마트 다단 변속 — 대칭 히스테리시스 */
        const excess = cachedBuf - target;
        let nextRate;
        if (excess > 5.0) { nextRate = RATE_HIGH; }
        else if (excess > HYST) { nextRate = RATE_SOFT; }
        else if (excess < -HYST) { nextRate = RATE_NORMAL; }
        else { nextRate = currentGear; }
        currentGear = nextRate;
        setSpeed(nextRate);
    };

    /* ═══════════════════════════════════════════
       UI — DOM 생성 및 갱신
       ═══════════════════════════════════════════ */
    const ui = buf => {
        const sec = buf < 0 ? 0 : buf;
        const diff = sec - target;

        if (!panelOpen) {
            if (!els.dot) return;
            const isSpeeding = vid && vid.playbackRate > 1.0;
            const c = !enabled ? '#555' : isSpeeding ? '#3498db' : color(diff);
            if (c !== lastDot) {
                lastDot = c;
                els.dot.style.borderColor = c;
                els.dot.dataset.color = c;
                const inner = els.dot.querySelector('.dm-fab-inner');
                if (inner) inner.style.background = c;
                els.dot.style.boxShadow = enabled ? `0 0 0 0 ${c}` : 'none';
            }
            els.dot.classList.toggle('dm-off', !enabled);
            els.dot.classList.toggle('dm-speed', !!(enabled && vid && vid.playbackRate > 1.0));
            return;
        }

        /* Badge */
        const isTargetRange = sec <= target && sec >= Math.max(0, target - 0.5);
        let badgeText, badgeCls;
        if (!enabled) { badgeText = 'OFF'; badgeCls = 'dm-status-badge dm-off'; }
        else if (buf < 0) { badgeText = '…'; badgeCls = 'dm-status-badge dm-off'; }
        else if (vid && vid.playbackRate > 1.0) { badgeText = '⚡' + vid.playbackRate + 'x'; badgeCls = 'dm-status-badge dm-accel'; }
        else if (isTargetRange) { badgeText = '✓ 안정'; badgeCls = 'dm-status-badge'; }
        else { badgeText = '→ 추적'; badgeCls = 'dm-status-badge dm-accel'; }

        const text = buf < 0 ? '-' : sec.toFixed(1);
        const c = color(diff);
        const w = clamp(sec / Platform.barMax * 100, 0, 100).toFixed(1) + '%';

        if (text !== prevUIText) { els.delay.textContent = text; prevUIText = text; }
        if (c !== prevUIColor) { els.delay.style.color = c; els.bar.style.background = c; prevUIColor = c; }
        if (w !== prevUIWidth) { els.bar.style.width = w; prevUIWidth = w; }
        if (els.badge) { els.badge.textContent = badgeText; els.badge.className = badgeCls; }

        /* Sparkline */
        if (els.graph && history.length > 1) {
            const gw = 208, gh = 28;
            const max = Math.max(...history, target + 2);
            const pts = history.map((v, i) => `${(i / (HIST_LEN - 1)) * gw},${gh - (v / max) * (gh - 4)}`).join(' ');
            const ty = gh - (target / max) * (gh - 4);
            els.graph.innerHTML =
                `<line x1="0" y1="${ty}" x2="${gw}" y2="${ty}" stroke="rgba(46,204,113,.3)" stroke-dasharray="2"/>` +
                `<polyline fill="none" stroke="${c}" stroke-width="1.5" points="${pts}"/>`;
        }
    };

    const togUI = () => {
        if (!els.tog) return;
        els.tog.classList.toggle('dm-on', enabled);
        if (els.p) els.p.classList.toggle('dm-disabled', !enabled);
    };

    const build = () => {
        if (!document.body || document.getElementById('dm-root')) return;

        GM_addStyle(`
#dm-root{--dm-green:#2ecc71;--dm-blue:#3498db;--dm-red:#e74c3c;--dm-yellow:#f1c40f}
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:36px;height:36px;border-radius:50%;background:rgba(12,12,16,.85);border:2px solid var(--dm-green);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .3s,box-shadow .3s;will-change:transform,opacity;contain:strict}
.dm-fab-inner{width:10px;height:10px;border-radius:50%;background:var(--dm-green);transition:background .3s}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 0 0 rgba(46,204,113,.4)}50%{box-shadow:0 0 0 8px rgba(46,204,113,0)}}
#dm-fab:not(.dm-off){animation:dm-pulse 2s ease-in-out infinite}
#dm-fab.dm-speed{border-color:var(--dm-blue)}#dm-fab.dm-speed .dm-fab-inner{background:var(--dm-blue)}
#dm-fab.dm-off{border-color:#555;opacity:.5}#dm-fab.dm-off .dm-fab-inner{background:#555}
#dm-panel{position:fixed;bottom:20px;right:20px;z-index:10000;background:rgba(18,18,24,.95);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px 16px 12px;color:#e0e0e0;font:12px/1.5 system-ui,-apple-system,sans-serif;width:240px;box-shadow:0 8px 32px rgba(0,0,0,.6);user-select:none;display:none}
#dm-panel.dm-disabled{opacity:.55}
.dm-hdr{display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,.06);cursor:grab;font-weight:600;font-size:13px}
.dm-hdr-icon{width:18px;height:18px;border-radius:4px;background:var(--dm-green);display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:bold}
.dm-hdr-close{margin-left:auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;opacity:.4;transition:opacity .15s,background .15s}
.dm-hdr-close:hover{opacity:.9;background:rgba(255,255,255,.08)}
.dm-status{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.dm-status-val{font:bold 22px ui-monospace,'SF Mono',monospace;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.dm-status-unit{font-size:11px;opacity:.5}
.dm-status-badge{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(46,204,113,.15);color:var(--dm-green);font-weight:600}
.dm-status-badge.dm-accel{background:rgba(52,152,219,.15);color:var(--dm-blue)}
.dm-status-badge.dm-off{background:rgba(255,255,255,.06);color:#888}
.dm-bar-wrap{background:rgba(255,255,255,.06);height:4px;border-radius:2px;margin:8px 0 12px;overflow:hidden}
.dm-bar-fill{height:100%;min-width:2%;border-radius:2px;transition:width .4s ease,background .4s ease}
.dm-graph{display:block;margin:0 0 10px}
.dm-slider-wrap{margin:0 0 10px}
.dm-slider-labels{display:flex;justify-content:space-between;font-size:10px;opacity:.35;margin-bottom:4px}
.dm-slider-track{display:flex;align-items:center;gap:8px}
.dm-slider-val{font:bold 13px ui-monospace,monospace;min-width:40px;text-align:center;color:var(--dm-green)}
.dm-slider-track input[type=range]{flex:1;height:4px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,.08);border-radius:2px;outline:none}
.dm-slider-track input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--dm-green);cursor:pointer;transition:transform .1s}
.dm-slider-track input[type=range]::-webkit-slider-thumb:active{transform:scale(1.2)}
.dm-footer{display:flex;align-items:center;gap:8px}
.dm-toggle{position:relative;width:44px;height:24px;border-radius:12px;background:#333;cursor:pointer;transition:background .2s;flex-shrink:0}
.dm-toggle.dm-on{background:var(--dm-green)}
.dm-toggle::after{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}
.dm-toggle.dm-on::after{transform:translateX(20px)}
.dm-footer-info{font-size:10px;opacity:.3}
.dm-footer-shortcut{margin-left:auto;font-size:10px;opacity:.25}`);

        const root = document.createElement('div');
        root.id = 'dm-root';

        const fab = document.createElement('div');
        fab.id = 'dm-fab';
        fab.innerHTML = '<div class="dm-fab-inner"></div>';

        const sv = Math.round((target - Platform.slMin) / (Platform.slMax - Platform.slMin) * 100);

        const panel = document.createElement('div');
        panel.id = 'dm-panel';
        panel.innerHTML =
            `<div class="dm-hdr" data-h>` +
                `<div class="dm-hdr-icon">D</div>` +
                `<span>딜레이 미터기</span>` +
                `<span style="font-size:10px;opacity:.4;font-weight:400">${Platform.name}</span>` +
                `<div class="dm-hdr-close" data-x>` +
                    `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` +
                `</div>` +
            `</div>` +
            `<div class="dm-status">` +
                `<span class="dm-status-val" data-d>-</span>` +
                `<span class="dm-status-unit">초</span>` +
                `<span class="dm-status-badge dm-off" data-badge>OFF</span>` +
            `</div>` +
            `<div class="dm-bar-wrap"><div class="dm-bar-fill" data-b></div></div>` +
            `<svg class="dm-graph" data-graph width="208" height="28" viewBox="0 0 208 28"></svg>` +
            `<div class="dm-slider-wrap">` +
                `<div class="dm-slider-labels"><span>저지연</span><span>안정</span></div>` +
                `<div class="dm-slider-track">` +
                    `<input type="range" data-sl min="0" max="100" value="${sv}">` +
                    `<span class="dm-slider-val" data-sv>${target.toFixed(1)}초</span>` +
                `</div>` +
            `</div>` +
            `<div class="dm-footer">` +
                `<div class="dm-toggle${enabled ? ' dm-on' : ''}" data-t></div>` +
                `<span class="dm-footer-info">v9.2.0</span>` +
                `<span class="dm-footer-shortcut">Alt+D</span>` +
            `</div>`;

        root.appendChild(fab);
        root.appendChild(panel);
        document.body.appendChild(root);

        const $ = s => panel.querySelector(`[data-${s}]`);
        els = { dot: fab, p: panel, delay: $('d'), bar: $('b'), tog: $('t'), sl: $('sl'), sv: $('sv'), hdr: $('h'), x: $('x'), badge: $('badge'), graph: $('graph') };

        fab.onclick = () => { if (!fab._m) openP(); };
        els.x.onclick = e => { e.stopPropagation(); closeP(); };

        togUI();
        els.tog.onclick = () => { enabled = !enabled; Config.set({ enabled }); togUI(); };

        els.sl.oninput = () => {
            target = Platform.slMin + (Platform.slMax - Platform.slMin) * els.sl.value / 100;
            target = Math.round(target * 2) / 2;
            els.sv.textContent = target.toFixed(1) + '초';
            Config.set({ target });
        };

        /* 패널 드래그 */
        let dx, dy, dg = false;
        els.hdr.onpointerdown = e => { if (e.button || e.target === els.x || els.x.contains(e.target)) return; dg = true; els.hdr.setPointerCapture(e.pointerId); const r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; };
        els.hdr.onpointermove = e => { if (!dg) return; panel.style.left = clamp(e.clientX - dx, 0, innerWidth - panel.offsetWidth) + 'px'; panel.style.top = clamp(e.clientY - dy, 0, innerHeight - panel.offsetHeight) + 'px'; panel.style.right = panel.style.bottom = 'auto'; };
        els.hdr.onpointerup = () => { if (!dg) return; dg = false; Config.set({ px: panel.style.left, py: panel.style.top }); };

        /* Dot 드래그 */
        let ddx, ddy, dd = false;
        fab.onpointerdown = e => { if (e.button) return; dd = true; fab._m = false; fab.setPointerCapture(e.pointerId); const r = fab.getBoundingClientRect(); ddx = e.clientX - r.left; ddy = e.clientY - r.top; };
        fab.onpointermove = e => { if (!dd) return; fab._m = true; fab.style.left = clamp(e.clientX - ddx, 0, innerWidth - 36) + 'px'; fab.style.top = clamp(e.clientY - ddy, 0, innerHeight - 36) + 'px'; fab.style.right = fab.style.bottom = 'auto'; };
        fab.onpointerup = () => { if (!dd) return; dd = false; if (fab._m) Config.set({ dx: fab.style.left, dy: fab.style.top }); };

        /* 저장된 위치 복원 */
        const c = Config.getAll();
        if (c.px) { const x = parseFloat(c.px), y = parseFloat(c.py); if (x >= 0 && x < innerWidth - 50 && y >= 0 && y < innerHeight - 50) Object.assign(panel.style, { left: c.px, top: c.py, right: 'auto', bottom: 'auto' }); }
        if (c.dx) { const x = parseFloat(c.dx), y = parseFloat(c.dy); if (x >= 0 && x < innerWidth - 36 && y >= 0 && y < innerHeight - 36) Object.assign(fab.style, { left: c.dx, top: c.dy, right: 'auto', bottom: 'auto' }); }

        panelOpen = Config.get('open') ?? false;
        if (panelOpen) { panel.style.display = 'block'; fab.style.display = 'none'; }
    };

    const openP = () => {
        if (panelOpen) return;
        panelOpen = true;
        Config.set({ open: true });
        els.dot.style.display = 'none';
        els.p.style.display = 'block';
        lastDot = '';
        prevUIText = ''; prevUIColor = ''; prevUIWidth = '';
    };

    const closeP = () => {
        if (!panelOpen) return;
        panelOpen = false;
        Config.set({ open: false });
        const r = els.p.getBoundingClientRect();
        els.p.style.display = 'none';
        els.dot.style.display = 'flex';
        Object.assign(els.dot.style, { left: clamp(r.right - 20, 0, innerWidth - 36) + 'px', top: clamp(r.top + 6, 0, innerHeight - 36) + 'px', right: 'auto', bottom: 'auto' });
        Config.set({ dx: els.dot.style.left, dy: els.dot.style.top });
        lastDot = '';
    };

    /* ═══════════════════════════════════════════
       Main — 초기화 및 스케줄링
       ═══════════════════════════════════════════ */
    const init = () => {
        if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
        build();
        startObs();
        document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') found(e.target); }, { capture: true, signal });
        const v = document.querySelector('video');
        if (v) found(v);
        schedule();
    };

    const schedule = () => {
        try { tick(); } catch (e) { console.warn('[딜레이미터기] tick 오류:', e); }
        setTimeout(schedule, panelOpen ? CHECK_MS : CHECK_IDLE);
    };

    /* SPA 네비게이션 감지 */
    let lastPath = location.pathname;
    const onRouteChange = () => {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        startTime = performance.now();
        lastSeek = 0;
        currentGear = RATE_NORMAL;
        if (!obs) startObs();
    };

    if ('navigation' in window) {
        navigation.addEventListener('navigatesuccess', onRouteChange);
    } else {
        for (const method of ['pushState', 'replaceState']) {
            const orig = history[method];
            history[method] = function (...args) {
                const result = orig.apply(this, args);
                onRouteChange();
                return result;
            };
        }
        window.addEventListener('popstate', onRouteChange, { signal });
    }

    /* 키보드 단축키: Alt+D */
    document.addEventListener('keydown', e => {
        if (e.altKey && e.code === 'KeyD' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
            e.preventDefault();
            enabled = !enabled;
            Config.set({ enabled });
            togUI();
        }
    }, { signal });

    /* 탭 복귀 시 상태 초기화 */
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { startTime = performance.now(); lastSeek = 0; }
    }, { signal });

    /* 전체화면 전환 시 위치 보정 */
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
        if (!els.p || !els.dot) return;
        const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
        if (document.fullscreenElement) {
            Object.assign(els.p.style, def);
            Object.assign(els.dot.style, def);
        } else {
            const c = Config.getAll();
            if (c.px) Object.assign(els.p.style, { left: c.px, top: c.py, right: 'auto', bottom: 'auto' });
            else Object.assign(els.p.style, def);
            if (c.dx) Object.assign(els.dot.style, { left: c.dx, top: c.dy, right: 'auto', bottom: 'auto' });
            else Object.assign(els.dot.style, def);
        }
    }), { signal });

    /* beforeunload — 설정 즉시 저장 */
    window.addEventListener('beforeunload', () => {
        Config.flush();
        ac.abort();
    }, { signal });

    /* GM 메뉴 — 상태 확인 + Toast */
    GM_registerMenuCommand('현재 상태 확인', () => {
        const info = {
            플랫폼: Platform.name,
            현재버퍼: cachedBuf < 0 ? '-' : cachedBuf.toFixed(1) + '초',
            목표: target + '초',
            배속: vid ? vid.playbackRate + 'x' : '-',
            활성: enabled,
            기어: currentGear === RATE_HIGH ? 'HIGH' : currentGear === RATE_SOFT ? 'SOFT' : 'NORMAL'
        };
        console.table(info);
        const toast = document.createElement('div');
        toast.textContent = `버퍼 ${info.현재버퍼} | ${info.기어} | ${enabled ? 'ON' : 'OFF'}`;
        Object.assign(toast.style, { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(0,0,0,.85)', color: '#fff', padding: '8px 20px', borderRadius: '8px', fontSize: '13px', fontFamily: 'system-ui', transition: 'opacity .3s' });
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
    });

    /* ═══ 기동 ═══ */
    init();
})();
