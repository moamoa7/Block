// ==UserScript==
// @name         딜레이 미터기 (S-Class Lite)
// @namespace    https://github.com/moamoa7
// @version      10.0.0
// @description  치지직(2초)/숲(4초) 최적화 라이브 딜레이 제어. 경량 리팩터.
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

  /* ── Platform ── */
  const SOOP = location.hostname.includes('sooplive');
  const P = {
    name: SOOP ? 'SOOP' : '치지직',
    min: SOOP ? 3 : 1, max: SOOP ? 10 : 8,
    def: SOOP ? 4.0 : 2.0, barMax: SOOP ? 15 : 10,
    key: SOOP ? 'dm_v10_soop' : 'dm_v10_chzzk'
  };

  /* ── Config ── */
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(P.key)) || {}; } catch { cfg = {}; }
  const save = () => { try { localStorage.setItem(P.key, JSON.stringify(cfg)); } catch {} };
  let saveTimer = 0;
  const saveLazy = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

  /* ── State ── */
  let vid = null, enabled = cfg.enabled ?? true, target = cfg.target ?? P.def;
  let lastSeek = 0, warmupEnd = performance.now() + 4000, gear = 1.0;
  let panelOpen = cfg.open ?? false, els = {};
  const HIST = 60;
  const hist = new Float32Array(HIST);
  let histHead = 0, histLen = 0;
  const histPush = v => { hist[histHead] = v; histHead = (histHead + 1) % HIST; if (histLen < HIST) histLen++; };

  /* ── Constants ── */
  const PANIC = 13, SEEK_CD = 10000, HYST = 0.3;
  const R_NORM = 1.0, R_SOFT = 1.05, R_HIGH = 1.10;

  /* ── Utils ── */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const colorOf = (() => {
    const G = [0x2e, 0xcc, 0x71], Y = [0xf1, 0xc4, 0x0f], R = [0xe7, 0x4c, 0x3c];
    const lut = new Array(21);
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const a = t <= 0.5 ? G : Y, b = t <= 0.5 ? Y : R, u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
      lut[i] = '#' + [0, 1, 2].map(j => Math.round(a[j] + (b[j] - a[j]) * u).toString(16).padStart(2, '0')).join('');
    }
    return d => lut[clamp(Math.round(clamp(d / 5, 0, 1) * 20), 0, 20)];
  })();

  const getBuf = () => {
    try { const b = vid.buffered; return b.length ? b.end(b.length - 1) - vid.currentTime : -1; }
    catch { return -1; }
  };

  const isLive = () => vid && (vid.duration === Infinity || vid.duration >= 1e6);
  const isBlob = v => (v.currentSrc || v.src || '').startsWith('blob:');

  /* ── Video tracking ── */
  const seen = new WeakSet();
  const attach = v => {
    if (!isBlob(v) || vid === v) return;
    vid = v; lastSeek = 0; warmupEnd = performance.now() + 4000; gear = R_NORM;
    if (!seen.has(v)) { seen.add(v); v.addEventListener('emptied', () => { if (vid === v) attach(v); }); }
  };

  document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') attach(e.target); }, { capture: true });

  // 초기 + 주기적 스캔 (MutationObserver 대체)
  const scan = () => { const v = document.querySelector('video'); if (v) attach(v); };

  /* ── Engine ── */
  const setRate = r => {
    if (!vid || vid.playbackRate === r) return;
    vid.playbackRate = r;
    try { vid.preservesPitch = true; } catch {}
  };

  const doSeek = () => {
    try {
      const b = vid.buffered, i = b.length - 1;
      vid.currentTime = Math.max(b.start(i), b.end(i) - 5);
      lastSeek = performance.now();
    } catch {}
  };

  const tick = () => {
    if (vid && !vid.isConnected) vid = null;
    if (!vid) { scan(); render(-1); return; }
    if (!isBlob(vid) || vid.readyState < 3 || !isLive()) { render(-1); return; }

    const buf = getBuf();
    if (vid.paused) { render(buf); return; }
    if (buf >= 0) histPush(buf);
    render(buf);

    if (!enabled) { setRate(R_NORM); gear = R_NORM; return; }
    if (performance.now() < warmupEnd) return;

    // 비상 seek
    if (buf > PANIC && performance.now() - lastSeek > SEEK_CD) { doSeek(); return; }

    // 다단 변속
    const ex = buf - target;
    gear = ex > 5 ? R_HIGH : ex > HYST ? R_SOFT : ex < -HYST ? R_NORM : gear;
    setRate(gear);
  };

  /* ── UI Render ── */
  let prevDot = '', prevTxt = '', prevClr = '', prevW = '';

  const render = buf => {
    const sec = buf < 0 ? 0 : buf;
    const diff = sec - target;
    const c = colorOf(diff);
    const speeding = vid && vid.playbackRate > 1;

    if (!panelOpen) {
      if (!els.fab) return;
      const fc = !enabled ? '#555' : speeding ? '#3498db' : c;
      if (fc !== prevDot) {
        prevDot = fc;
        els.fab.style.borderColor = fc;
        els.inner.style.background = fc;
        els.fab.style.animation = enabled ? '' : 'none';
      }
      return;
    }

    // Panel update
    const txt = buf < 0 ? '-' : sec.toFixed(1);
    const w = clamp(sec / P.barMax * 100, 0, 100).toFixed(1) + '%';

    if (txt !== prevTxt) { els.val.textContent = txt; prevTxt = txt; }
    if (c !== prevClr) { els.val.style.color = c; els.bar.style.background = c; prevClr = c; }
    if (w !== prevW) { els.bar.style.width = w; prevW = w; }

    // Badge
    const inRange = sec <= target && sec >= Math.max(0, target - 0.5);
    if (!enabled) { els.badge.textContent = 'OFF'; els.badge.className = 'dm-b dm-b-off'; }
    else if (buf < 0) { els.badge.textContent = '…'; els.badge.className = 'dm-b dm-b-off'; }
    else if (speeding) { els.badge.textContent = '⚡' + vid.playbackRate + 'x'; els.badge.className = 'dm-b dm-b-acc'; }
    else if (inRange) { els.badge.textContent = '✓ 안정'; els.badge.className = 'dm-b'; }
    else { els.badge.textContent = '→ 추적'; els.badge.className = 'dm-b dm-b-acc'; }

    // Sparkline — DOM 재사용
    if (histLen > 1 && els.line && els.tline) {
      const gw = 208, gh = 28;
      let mx = target + 2;
      for (let i = 0; i < histLen; i++) { const v = hist[(histHead - histLen + i + HIST) % HIST]; if (v > mx) mx = v; }
      let pts = '';
      for (let i = 0; i < histLen; i++) {
        const v = hist[(histHead - histLen + i + HIST) % HIST];
        if (i > 0) pts += ' ';
        pts += ((i / (HIST - 1)) * gw).toFixed(1) + ',' + (gh - (v / mx) * (gh - 4)).toFixed(1);
      }
      els.line.setAttribute('points', pts);
      els.line.setAttribute('stroke', c);
      els.tline.setAttribute('y1', gh - (target / mx) * (gh - 4));
      els.tline.setAttribute('y2', gh - (target / mx) * (gh - 4));
    }
  };

  /* ── Build DOM ── */
  const build = () => {
    if (document.getElementById('dm-r')) return;

    GM_addStyle(`
#dm-r{--g:#2ecc71;--b:#3498db}
#dm-f{position:fixed;bottom:20px;right:20px;z-index:10000;width:36px;height:36px;border-radius:50%;background:rgba(12,12,16,.85);border:2px solid var(--g);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .3s;contain:strict}
.dm-i{width:10px;height:10px;border-radius:50%;background:var(--g);transition:background .3s}
@keyframes dm-p{0%,100%{box-shadow:0 0 0 0 rgba(46,204,113,.4)}50%{box-shadow:0 0 0 8px rgba(46,204,113,0)}}
#dm-f{animation:dm-p 2s ease-in-out infinite}
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:rgba(18,18,24,.95);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px 16px 12px;color:#e0e0e0;font:12px/1.5 system-ui,sans-serif;width:240px;box-shadow:0 8px 32px rgba(0,0,0,.6);user-select:none;display:none}
.dm-h{display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,.06);cursor:grab;font-weight:600;font-size:13px}
.dm-x{margin-left:auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;opacity:.4;transition:opacity .15s}
.dm-x:hover{opacity:.9;background:rgba(255,255,255,.08)}
.dm-s{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.dm-v{font:bold 22px ui-monospace,'SF Mono',monospace;font-variant-numeric:tabular-nums}
.dm-u{font-size:11px;opacity:.5}
.dm-b{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(46,204,113,.15);color:var(--g);font-weight:600}
.dm-b-acc{background:rgba(52,152,219,.15);color:var(--b)}
.dm-b-off{background:rgba(255,255,255,.06);color:#888}
.dm-bw{background:rgba(255,255,255,.06);height:4px;border-radius:2px;margin:8px 0 12px;overflow:hidden}
.dm-bf{height:100%;min-width:2%;border-radius:2px;transition:width .4s,background .4s}
.dm-g{display:block;margin:0 0 10px}
.dm-sl{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.dm-sl input{flex:1;height:4px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,.08);border-radius:2px;outline:none}
.dm-sl input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--g);cursor:pointer}
.dm-sv{font:bold 13px ui-monospace,monospace;min-width:40px;text-align:center;color:var(--g)}
.dm-ft{display:flex;align-items:center;gap:8px}
.dm-t{position:relative;width:44px;height:24px;border-radius:12px;background:#333;cursor:pointer;transition:background .2s;flex-shrink:0}
.dm-t.on{background:var(--g)}
.dm-t::after{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}
.dm-t.on::after{transform:translateX(20px)}`);

    const d = document.createElement('div'); d.id = 'dm-r';
    const sv = Math.round((target - P.min) / (P.max - P.min) * 100);

    d.innerHTML =
`<div id="dm-f"><div class="dm-i"></div></div>
<div id="dm-pn">
<div class="dm-h"><div style="width:18px;height:18px;border-radius:4px;background:var(--g);display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:bold">D</div>
<span>딜레이 미터기</span><span style="font-size:10px;opacity:.4;font-weight:400">${P.name}</span>
<div class="dm-x"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div></div>
<div class="dm-s"><span class="dm-v">-</span><span class="dm-u">초</span><span class="dm-b dm-b-off">OFF</span></div>
<div class="dm-bw"><div class="dm-bf"></div></div>
<svg class="dm-g" width="208" height="28" viewBox="0 0 208 28">
<line class="dm-tl" x1="0" y1="14" x2="208" y2="14" stroke="rgba(46,204,113,.3)" stroke-dasharray="2"/>
<polyline class="dm-ln" fill="none" stroke-width="1.5" points="0,28"/>
</svg>
<div style="display:flex;justify-content:space-between;font-size:10px;opacity:.35;margin-bottom:4px"><span>저지연</span><span>안정</span></div>
<div class="dm-sl"><input type="range" min="0" max="100" value="${sv}"><span class="dm-sv">${target.toFixed(1)}초</span></div>
<div class="dm-ft"><div class="dm-t${enabled ? ' on' : ''}"></div><span style="font-size:10px;opacity:.3">v10</span><span style="margin-left:auto;font-size:10px;opacity:.25">Alt+D</span></div>
</div>`;

    document.body.appendChild(d);
    const pn = d.querySelector('#dm-pn'), fab = d.querySelector('#dm-f');
    els = {
      fab, inner: fab.querySelector('.dm-i'), pn,
      val: pn.querySelector('.dm-v'), bar: pn.querySelector('.dm-bf'),
      badge: pn.querySelector('.dm-b'), line: pn.querySelector('.dm-ln'),
      tline: pn.querySelector('.dm-tl'), tog: pn.querySelector('.dm-t'),
      sl: pn.querySelector('input'), sv: pn.querySelector('.dm-sv'),
      hdr: pn.querySelector('.dm-h'), x: pn.querySelector('.dm-x')
    };

    // Events
    fab.onclick = () => { if (!fab._m) openP(); };
    els.x.onclick = e => { e.stopPropagation(); closeP(); };
    els.tog.onclick = () => { enabled = !enabled; cfg.enabled = enabled; saveLazy(); els.tog.classList.toggle('on', enabled); };
    els.sl.oninput = () => {
      target = P.min + (P.max - P.min) * els.sl.value / 100;
      target = Math.round(target * 2) / 2;
      els.sv.textContent = target.toFixed(1) + '초';
      cfg.target = target; saveLazy();
    };

    // Drag — 공용 헬퍼
    const drag = (el, onEnd) => {
      let ox, oy, moved = false;
      el.onpointerdown = e => {
        if (e.button) return; moved = false; el.setPointerCapture(e.pointerId);
        const r = el.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
      };
      el.onpointermove = e => {
        if (!el.hasPointerCapture(e.pointerId)) return; moved = true;
        el.style.left = clamp(e.clientX - ox, 0, innerWidth - el.offsetWidth) + 'px';
        el.style.top = clamp(e.clientY - oy, 0, innerHeight - el.offsetHeight) + 'px';
        el.style.right = el.style.bottom = 'auto';
      };
      el.onpointerup = e => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        el._m = moved;
        if (moved && onEnd) onEnd();
      };
    };
    drag(fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });
    drag(els.hdr, () => { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); });
    // 헤더 드래그 → 패널 이동
    const origMove = els.hdr.onpointermove;
    els.hdr.onpointermove = e => {
      if (!els.hdr.hasPointerCapture(e.pointerId)) return;
      els.hdr._m = true;
      pn.style.left = clamp(e.clientX - (els.hdr._ox ?? 0), 0, innerWidth - pn.offsetWidth) + 'px';
      pn.style.top = clamp(e.clientY - (els.hdr._oy ?? 0), 0, innerHeight - pn.offsetHeight) + 'px';
      pn.style.right = pn.style.bottom = 'auto';
    };
    const origDown = els.hdr.onpointerdown;
    els.hdr.onpointerdown = e => {
      if (e.button || e.target === els.x || els.x.contains(e.target)) return;
      els.hdr.setPointerCapture(e.pointerId);
      const r = pn.getBoundingClientRect();
      els.hdr._ox = e.clientX - r.left; els.hdr._oy = e.clientY - r.top; els.hdr._m = false;
    };
    els.hdr.onpointerup = e => {
      if (!els.hdr.hasPointerCapture(e.pointerId)) return;
      if (els.hdr._m) { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); }
    };

    // 저장된 위치 복원
    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }

    if (panelOpen) { pn.style.display = 'block'; fab.style.display = 'none'; }
  };

  const openP = () => {
    if (panelOpen) return; panelOpen = true; cfg.open = true; saveLazy();
    els.fab.style.display = 'none'; els.pn.style.display = 'block';
    prevDot = ''; prevTxt = ''; prevClr = ''; prevW = '';
  };
  const closeP = () => {
    if (!panelOpen) return; panelOpen = false; cfg.open = false; saveLazy();
    const r = els.pn.getBoundingClientRect();
    els.pn.style.display = 'none'; els.fab.style.display = 'flex';
    Object.assign(els.fab.style, {
      left: clamp(r.right - 20, 0, innerWidth - 36) + 'px',
      top: clamp(r.top + 6, 0, innerHeight - 36) + 'px',
      right: 'auto', bottom: 'auto'
    });
    cfg.dx = els.fab.style.left; cfg.dy = els.fab.style.top; saveLazy();
    prevDot = '';
  };

  /* ── Scheduling ── */
  let timerId = 0;
  const loop = () => {
    tick();
    timerId = setTimeout(loop, panelOpen ? 1000 : 5000);
  };

  /* ── Init ── */
  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); loop();
  };

  /* ── SPA navigation ── */
  let lastPath = location.pathname;
  const onNav = () => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname; warmupEnd = performance.now() + 4000; lastSeek = 0; gear = R_NORM;
  };
  if ('navigation' in window) navigation.addEventListener('navigatesuccess', onNav);
  else {
    for (const m of ['pushState', 'replaceState']) { const o = history[m]; history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; }; }
    window.addEventListener('popstate', onNav);
  }

  /* ── Keyboard ── */
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.code !== 'KeyD' || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const t = document.activeElement?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault(); enabled = !enabled; cfg.enabled = enabled; saveLazy();
    if (els.tog) els.tog.classList.toggle('on', enabled);
  });

  /* ── Visibility & Fullscreen ── */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { warmupEnd = performance.now() + 4000; lastSeek = 0; } });
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
    if (!els.pn) return;
    const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    if (document.fullscreenElement) { Object.assign(els.pn.style, def); Object.assign(els.fab.style, def); }
    else {
      if (cfg.px) Object.assign(els.pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); else Object.assign(els.pn.style, def);
      if (cfg.dx) Object.assign(els.fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); else Object.assign(els.fab.style, def);
    }
  }));

  window.addEventListener('beforeunload', save);

  GM_registerMenuCommand('현재 상태', () => {
    const buf = vid ? getBuf() : -1;
    const txt = `버퍼 ${buf < 0 ? '-' : buf.toFixed(1) + '초'} | ${gear > 1.05 ? 'HIGH' : gear > 1 ? 'SOFT' : 'NORM'} | ${enabled ? 'ON' : 'OFF'}`;
    const t = document.createElement('div');
    t.textContent = txt;
    Object.assign(t.style, { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(0,0,0,.85)', color: '#fff', padding: '8px 20px', borderRadius: '8px', fontSize: '13px', fontFamily: 'system-ui', transition: 'opacity .3s' });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2000);
  });

  init();
})();
