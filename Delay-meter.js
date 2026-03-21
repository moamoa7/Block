// ==UserScript==
// @name         딜레이 미터기 (Universal)
// @namespace    https://github.com/moamoa7
// @version      11.0.0
// @description  플랫폼 무관 — 모든 라이브 방송의 딜레이를 자동 감지·제어
// @author       DelayMeter
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   *  § 0. 설계 원칙
   *  ────────────────────────────────────────────────────────────────
   *  - 플랫폼 분기 제거: <video> + blob:/MediaSource + Infinity 조합
   *    으로 라이브 여부를 판정한다.
   *  - 유튜브는 blob: 없이 MediaSource 를 사용하므로 src 체크 대신
   *    buffered + duration 기반으로 판정한다.
   *  - 설정은 도메인별로 분리 저장(dm_u11_{host}) → 사이트마다 독립.
   *  ================================================================ */

  /* ── 도메인별 Config ── */
  const HOST = location.hostname.replace(/^www\./, '');
  const STORE_KEY = 'dm_u11_' + HOST;

  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { cfg = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };
  let saveTimer = 0;
  const saveLazy = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

  /* ── 기본 상수 ── */
  const DEF_TARGET  = 2.0;   // 기본 목표 딜레이(초)
  const MIN_TARGET  = 0.5;
  const MAX_TARGET  = 12;
  const BAR_MAX     = 15;
  const PANIC       = 15;    // 이 이상이면 비상 seek
  const SEEK_CD     = 10000; // seek 쿨다운(ms)
  const HYST        = 0.3;   // 히스테리시스(초)
  const STALL_WINDOW   = 30000;
  const STALL_COOLDOWN = 8000;

  const R_NORM = 1.00;
  const R_SOFT = 1.05;
  const R_HIGH = 1.10;

  /* ── State ── */
  let _vidRef = null;
  const getVid = () => _vidRef?.deref() ?? null;
  const setVid = v => { _vidRef = v ? new WeakRef(v) : null; };

  let enabled   = cfg.enabled ?? true;
  let target    = cfg.target  ?? DEF_TARGET;
  let lastSeek  = 0;
  let warmupEnd = performance.now() + 4000;
  let gear      = R_NORM;
  let panelOpen = cfg.open ?? false;
  let els       = {};

  /* 히스토리 (sparkline) */
  const HIST = 60;
  const hist = new Float32Array(HIST);
  let histHead = 0, histLen = 0;
  const histPush = v => { hist[histHead] = v; histHead = (histHead + 1) % HIST; if (histLen < HIST) histLen++; };
  const _ptsBuf = [];

  /* Stall 감지 */
  let stallCount = 0, lastStallTime = 0;

  /* Network Info */
  let netQuality = 'good';
  const updateNetQuality = () => {
    const c = navigator.connection;
    if (!c) return;
    if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.downlink < 1) netQuality = 'poor';
    else if (c.effectiveType === '3g' || c.downlink < 3) netQuality = 'fair';
    else netQuality = 'good';
  };
  if (navigator.connection) navigator.connection.addEventListener('change', updateNetQuality);

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

  /** 버퍼 잔량(초). 라이브가 아니거나 계산 불가 시 -1 */
  const getBuf = vid => {
    try {
      const b = vid.buffered;
      if (!b.length) return -1;
      return b.end(b.length - 1) - vid.currentTime;
    } catch { return -1; }
  };

  /**
   * 라이브 판정 — 플랫폼 무관
   *  1) duration === Infinity  (대부분의 HLS/DASH 라이브)
   *  2) duration 매우 큼 (일부 구현체)
   *  3) YouTube 등: MediaSource 연결 + seekable 범위 존재 + 끝점이 계속 증가
   */
  const isLive = vid => {
    if (!vid) return false;
    if (vid.duration === Infinity || vid.duration >= 1e6) return true;
    // YouTube 라이브: duration 유한하지만 seekable.end 가 지속 증가
    try {
      const s = vid.seekable;
      if (s.length && s.end(s.length - 1) - s.start(0) > 30 && vid.duration > 600) {
        // 버퍼 끝이 seekable 끝에 가까우면 라이브로 간주
        const b = vid.buffered;
        if (b.length && Math.abs(b.end(b.length - 1) - s.end(s.length - 1)) < 60) return true;
      }
    } catch {}
    return false;
  };

  /**
   * 유효한 라이브 비디오인지 확인
   *  - blob: src → HLS.js / DASH.js 기반 (치지직, 숲, 트위치 등)
   *  - MediaSource 연결 → YouTube, 일부 DASH
   *  - 최소 readyState 3 (HAVE_FUTURE_DATA)
   */
  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    // blob: 또는 빈 src(MediaSource attach) 모두 허용
    if (src.startsWith('blob:') || src === '') return true;
    // 일부 플랫폼은 직접 URL 을 넣되 MSE 로 전환
    // → buffered 가 있고 라이브이면 허용
    try { if (v.buffered.length && isLive(v)) return true; } catch {}
    return false;
  };

  /* 버퍼 트렌드 (선형 회귀 기울기) */
  const getBufferTrend = () => {
    const n = Math.min(histLen, 10);
    if (n < 3) return 0;
    let sX = 0, sY = 0, sXY = 0, sX2 = 0;
    for (let i = 0; i < n; i++) {
      const y = hist[(histHead - n + i + HIST) % HIST];
      sX += i; sY += y; sXY += i * y; sX2 += i * i;
    }
    return (n * sXY - sX * sY) / (n * sX2 - sX * sX);
  };

  /* ── Video Tracking ── */
  const seen = new WeakSet();

  const attach = v => {
    if (getVid() === v) return;
    if (!isCandidate(v)) return;
    setVid(v);
    lastSeek = 0; warmupEnd = performance.now() + 4000; gear = R_NORM;
    stallCount = 0; histLen = 0; histHead = 0;

    if (!seen.has(v)) {
      seen.add(v);
      v.addEventListener('emptied', () => { if (getVid() === v) attach(v); });

      const onStall = () => {
        const now = performance.now();
        if (now - lastStallTime > STALL_WINDOW) stallCount = 0;
        stallCount++;
        lastStallTime = now;
        if (getVid() === v) { gear = R_NORM; safeRate(v, R_NORM); }
      };
      v.addEventListener('waiting', onStall);
      v.addEventListener('stalled', onStall);
    }
  };

  /* play 이벤트 캡처 — 가장 보편적 */
  document.addEventListener('play', e => {
    if (e.target?.tagName === 'VIDEO') attach(e.target);
  }, { capture: true });

  /* MutationObserver */
  const scan = () => {
    for (const v of document.querySelectorAll('video')) {
      if (isCandidate(v)) { attach(v); break; }
    }
  };

  let mo = null;
  const startObserver = () => {
    if (mo) return;
    mo = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') { attach(n); return; }
        if (n.getElementsByTagName) {
          const v = n.getElementsByTagName('video')[0];
          if (v) { attach(v); return; }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  };

  /* ── Engine ── */
  const safeRate = (vid, r) => {
    if (!vid || vid.playbackRate === r) return;
    vid.playbackRate = r;
    try { vid.preservesPitch = true; } catch {}
  };

  const doSeek = vid => {
    try {
      // seekable 기반 seek (YouTube 호환)
      const s = vid.seekable;
      if (s.length) {
        vid.currentTime = Math.max(s.start(s.length - 1), s.end(s.length - 1) - target - 1);
      } else {
        const b = vid.buffered, i = b.length - 1;
        vid.currentTime = Math.max(b.start(i), b.end(i) - target - 1);
      }
      lastSeek = performance.now();
    } catch {}
  };

  /* rAF 렌더링 */
  let pendingRender = false, lastBuf = -1;
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; render(lastBuf, getVid()); });
  };

  const tick = () => {
    const vid = getVid();

    /* 비디오 없거나 분리됨 */
    if (vid && !vid.isConnected) { setVid(null); lastBuf = -1; scheduleRender(); return; }
    if (!vid) {
      // 주기적 재스캔 — SPA 전환 등 대응
      scan();
      lastBuf = -1; scheduleRender(); return;
    }
    if (!isCandidate(vid) || vid.readyState < 3 || !isLive(vid)) {
      lastBuf = -1; scheduleRender(); return;
    }

    const buf = getBuf(vid);
    lastBuf = buf;
    if (!vid.paused && buf >= 0) histPush(buf);
    scheduleRender();

    if (vid.paused) return;
    if (!enabled) { safeRate(vid, R_NORM); gear = R_NORM; return; }

    const now = performance.now();
    if (now < warmupEnd) return;

    /* 비상 seek */
    if (buf > PANIC && now - lastSeek > SEEK_CD) { doSeek(vid); return; }

    updateNetQuality();

    /* stall 쿨다운 */
    if (now - lastStallTime < STALL_COOLDOWN) {
      gear = R_NORM; safeRate(vid, R_NORM); return;
    }

    /* 적응형 변속 */
    const trend = getBufferTrend();
    const ex = buf - target;

    if (ex > 5) {
      gear = R_HIGH;
    } else if (ex > HYST) {
      if (netQuality === 'poor' || trend < -0.15) gear = R_NORM;
      else if (netQuality === 'fair' || trend < -0.05 || stallCount >= 2) gear = R_SOFT;
      else gear = R_SOFT;
    } else if (ex < -HYST) {
      gear = R_NORM;
    }

    safeRate(vid, gear);
  };

  /* ── UI Render ── */
  let prevDot = '', prevTxt = '', prevClr = '', prevW = '';

  const render = (buf, vid) => {
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

    const txt = buf < 0 ? '-' : sec.toFixed(1);
    const w = clamp(sec / BAR_MAX * 100, 0, 100).toFixed(1) + '%';

    if (txt !== prevTxt) { els.val.textContent = txt; prevTxt = txt; }
    if (c !== prevClr)   { els.val.style.color = c; els.bar.style.background = c; prevClr = c; }
    if (w !== prevW)     { els.bar.style.width = w; prevW = w; }

    /* Badge */
    const inRange = sec <= target && sec >= Math.max(0, target - 0.5);
    if (!enabled) { els.badge.textContent = 'OFF'; els.badge.className = 'dm-b dm-b-off'; }
    else if (buf < 0) { els.badge.textContent = '…'; els.badge.className = 'dm-b dm-b-off'; }
    else if (performance.now() - lastStallTime < STALL_COOLDOWN) { els.badge.textContent = '⏸ 대기'; els.badge.className = 'dm-b dm-b-off'; }
    else if (speeding) { els.badge.textContent = '⚡' + vid.playbackRate.toFixed(2) + 'x'; els.badge.className = 'dm-b dm-b-acc'; }
    else if (inRange) { els.badge.textContent = '✓ 안정'; els.badge.className = 'dm-b'; }
    else { els.badge.textContent = '→ 추적'; els.badge.className = 'dm-b dm-b-acc'; }

    /* Sparkline */
    if (histLen > 1 && els.line && els.tline) {
      const gw = 208, gh = 28;
      let mx = target + 2;
      for (let i = 0; i < histLen; i++) {
        const v = hist[(histHead - histLen + i + HIST) % HIST];
        if (v > mx) mx = v;
      }
      _ptsBuf.length = histLen;
      const invMx = 1 / mx, xScale = gw / (HIST - 1), yRange = gh - 4;
      for (let i = 0; i < histLen; i++) {
        const v = hist[(histHead - histLen + i + HIST) % HIST];
        _ptsBuf[i] = `${(i * xScale).toFixed(1)},${(gh - v * invMx * yRange).toFixed(1)}`;
      }
      els.line.setAttribute('points', _ptsBuf.join(' '));
      els.line.setAttribute('stroke', c);
      const tY = gh - target * invMx * yRange;
      els.tline.setAttribute('y1', tY);
      els.tline.setAttribute('y2', tY);
    }

    /* 네트워크 인디케이터 */
    if (els.netInd) {
      const nt = netQuality === 'poor' ? '불안정' : netQuality === 'fair' ? '보통' : '양호';
      if (els.netInd._last !== netQuality) {
        els.netInd._last = netQuality;
        const nc = netQuality === 'poor' ? '#e74c3c' : netQuality === 'fair' ? '#f1c40f' : '#2ecc71';
        els.netInd.style.color = nc;
        els.netInd.textContent = '📶 ' + nt;
      }
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
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:rgba(18,18,24,.95);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:14px 16px 12px;color:#e0e0e0;font:12px/1.5 system-ui,sans-serif;width:240px;box-shadow:0 8px 32px rgba(0,0,0,.6);user-select:none;display:none;contain:layout style}
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
.dm-t.on::after{transform:translateX(20px)}
.dm-ni{font-size:10px;opacity:.6;transition:color .3s}
.dm-host{font-size:9px;opacity:.25;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`);

    const d = document.createElement('div'); d.id = 'dm-r';
    const sv = Math.round((target - MIN_TARGET) / (MAX_TARGET - MIN_TARGET) * 100);
    const hostLabel = HOST.replace(/\.(com|co\.kr|naver|tv)$/g, '').slice(0, 12);

    d.innerHTML =
`<div id="dm-f"><div class="dm-i"></div></div>
<div id="dm-pn">
<div class="dm-h"><div style="width:18px;height:18px;border-radius:4px;background:var(--g);display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:bold">D</div>
<span>딜레이 미터기</span><span class="dm-host" title="${HOST}">${hostLabel}</span>
<div class="dm-x"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div></div>
<div class="dm-s"><span class="dm-v">-</span><span class="dm-u">초</span><span class="dm-b dm-b-off">OFF</span></div>
<div class="dm-bw"><div class="dm-bf"></div></div>
<svg class="dm-g" width="208" height="28" viewBox="0 0 208 28">
<line class="dm-tl" x1="0" y1="14" x2="208" y2="14" stroke="rgba(46,204,113,.3)" stroke-dasharray="2"/>
<polyline class="dm-ln" fill="none" stroke-width="1.5" points="0,28"/>
</svg>
<div style="display:flex;justify-content:space-between;font-size:10px;opacity:.35;margin-bottom:4px"><span>저지연</span><span>안정</span></div>
<div class="dm-sl"><input type="range" min="0" max="100" value="${sv}"><span class="dm-sv">${target.toFixed(1)}초</span></div>
<div class="dm-ft"><div class="dm-t${enabled ? ' on' : ''}"></div><span class="dm-ni">📶 양호</span><span style="font-size:10px;opacity:.3">v11.0</span><span style="margin-left:auto;font-size:10px;opacity:.25">Alt+D</span></div>
</div>`;

    document.body.appendChild(d);
    const pn = d.querySelector('#dm-pn'), fab = d.querySelector('#dm-f');
    els = {
      fab, inner: fab.querySelector('.dm-i'), pn,
      val: pn.querySelector('.dm-v'), bar: pn.querySelector('.dm-bf'),
      badge: pn.querySelector('.dm-b'), line: pn.querySelector('.dm-ln'),
      tline: pn.querySelector('.dm-tl'), tog: pn.querySelector('.dm-t'),
      sl: pn.querySelector('input'), sv: pn.querySelector('.dm-sv'),
      hdr: pn.querySelector('.dm-h'), x: pn.querySelector('.dm-x'),
      netInd: pn.querySelector('.dm-ni')
    };

    /* Events */
    fab.onclick = () => { if (!fab._m) openP(); };
    els.x.onclick = e => { e.stopPropagation(); closeP(); };
    els.tog.onclick = () => { enabled = !enabled; cfg.enabled = enabled; saveLazy(); els.tog.classList.toggle('on', enabled); };
    els.sl.oninput = () => {
      target = MIN_TARGET + (MAX_TARGET - MIN_TARGET) * els.sl.value / 100;
      target = Math.round(target * 2) / 2;
      els.sv.textContent = target.toFixed(1) + '초';
      cfg.target = target; saveLazy();
    };

    /* Drag — FAB */
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

    /* Drag — Panel header */
    els.hdr.onpointerdown = e => {
      if (e.button || e.target === els.x || els.x.contains(e.target)) return;
      els.hdr.setPointerCapture(e.pointerId);
      const r = pn.getBoundingClientRect();
      els.hdr._ox = e.clientX - r.left; els.hdr._oy = e.clientY - r.top; els.hdr._m = false;
    };
    els.hdr.onpointermove = e => {
      if (!els.hdr.hasPointerCapture(e.pointerId)) return;
      els.hdr._m = true;
      pn.style.left = clamp(e.clientX - (els.hdr._ox ?? 0), 0, innerWidth - pn.offsetWidth) + 'px';
      pn.style.top = clamp(e.clientY - (els.hdr._oy ?? 0), 0, innerHeight - pn.offsetHeight) + 'px';
      pn.style.right = pn.style.bottom = 'auto';
    };
    els.hdr.onpointerup = e => {
      if (!els.hdr.hasPointerCapture(e.pointerId)) return;
      if (els.hdr._m) { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); }
    };

    /* 위치 복원 */
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
  const loop = () => { tick(); setTimeout(loop, panelOpen ? 1000 : 5000); };

  /* ── Init ── */
  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); startObserver(); loop();
  };

  /* ── SPA navigation ── */
  let lastPath = location.pathname + location.search;
  const onNav = () => {
    const cur = location.pathname + location.search;
    if (cur === lastPath) return;
    lastPath = cur;
    warmupEnd = performance.now() + 4000; lastSeek = 0; gear = R_NORM; stallCount = 0;
    // SPA 전환 시 비디오 재탐색
    setTimeout(scan, 500);
  };
  if ('navigation' in window) navigation.addEventListener('navigatesuccess', onNav);
  else {
    for (const m of ['pushState', 'replaceState']) {
      const o = history[m];
      history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; };
    }
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { warmupEnd = performance.now() + 4000; lastSeek = 0; }
  });
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

  /* ── GM Menu ── */
  GM_registerMenuCommand('현재 상태', () => {
    const vid = getVid();
    const buf = vid ? getBuf(vid) : -1;
    const gearLabel = gear > 1.05 ? 'HIGH' : gear > 1 ? 'SOFT' : 'NORM';
    const live = vid ? isLive(vid) : false;
    const txt = `[${HOST}] 버퍼 ${buf < 0 ? '-' : buf.toFixed(1) + '초'} | ${gearLabel} | ${enabled ? 'ON' : 'OFF'} | Net: ${netQuality} | stall: ${stallCount} | live: ${live}`;
    const t = document.createElement('div');
    t.textContent = txt;
    Object.assign(t.style, { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(0,0,0,.85)', color: '#fff', padding: '8px 20px', borderRadius: '8px', fontSize: '13px', fontFamily: 'system-ui', transition: 'opacity .3s' });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2500);
  });

  init();
})();
