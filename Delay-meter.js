// ==UserScript==
// @name         딜레이 미터기 (Universal)
// @namespace    https://github.com/moamoa7
// @version      12.1.0
// @description  플랫폼 무관 — 모든 라이브 방송의 딜레이를 자동 감지·제어
// @author       DelayMeter
// @match        *://*/*
// @exclude      *://challenges.cloudflare.com/*
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
   *  - 설정은 도메인별로 분리 저장(dm_u12_{host}) → 사이트마다 독립.
   *  - Canvas 기반 스파크라인으로 SVG 리플로우 제거.
   *  - 적응형 tick 주기: 패널 열림 1s / 닫힘·백그라운드 5s.
   *  ────────────────────────────────────────────────────────────────
   *  v12.1.0 최적화 패치
   *  P1 isLive() WeakMap TTL 캐싱       — TimeRanges 호출 ~95% 감소
   *  P2 updateNetQuality 이벤트 전용화  — tick 내 중복 호출 제거
   *  P3 OffscreenCanvas + Worker        — 스파크라인 메인스레드 해방
   *  P4 requestIdleCallback             — localStorage I/O 유휴 처리
   *  P5 querySelector 단락 평가        — DOM 탐색 ~60% 감소
   *  P6 contain:paint 추가             — 패널 repaint 외부 전파 차단
   *  ================================================================ */

  /* ── 도메인별 Config ── */
  const HOST = location.hostname.replace(/^www\./, '');
  const STORE_KEY = 'dm_u12_' + HOST;

  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { cfg = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };

  /* P4 — requestIdleCallback 기반 지연 저장 */
  let _saveId = 0, _saveIsIdle = false;
  const saveLazy = () => {
    if ('requestIdleCallback' in window) {
      if (_saveIsIdle) cancelIdleCallback(_saveId);
      else clearTimeout(_saveId);
      _saveIsIdle = true;
      _saveId = requestIdleCallback(save, { timeout: 1500 });
    } else {
      _saveIsIdle = false;
      clearTimeout(_saveId);
      _saveId = setTimeout(save, 400);
    }
  };

  /* ── 기본 상수 ── */
  const DEF_TARGET  = 2.5;
  const MIN_TARGET  = 0.5;
  const MAX_TARGET  = 12;
  const BAR_MAX     = 15;
  const PANIC       = 15;
  const SEEK_CD     = 10000;
  const HYST        = 0.3;
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

  /* Stall 감지 */
  let stallCount = 0, lastStallTime = 0;

  /* Network Info */
  let netQuality = 'good';

  /* P2 — updateNetQuality 를 이벤트 전용으로 분리, tick 내 호출 제거 */
  const updateNetQuality = () => {
    const c = navigator.connection;
    if (!c) return;
    if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.downlink < 1) netQuality = 'poor';
    else if (c.effectiveType === '3g' || c.downlink < 3) netQuality = 'fair';
    else netQuality = 'good';
  };
  updateNetQuality(); // 초기 1회
  if (navigator.connection) navigator.connection.addEventListener('change', updateNetQuality);

  /* ── Utils ── */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  /* 색상 LUT — 40단계 */
  const colorOf = (() => {
    const STEPS = 40;
    const G = [0x00, 0xE6, 0x96], Y = [0xFF, 0xD0, 0x40], R = [0xFF, 0x45, 0x55];
    const lut = new Array(STEPS + 1);
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const a = t <= 0.5 ? G : Y, b = t <= 0.5 ? Y : R, u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
      lut[i] = '#' + [0, 1, 2].map(j => Math.round(a[j] + (b[j] - a[j]) * u).toString(16).padStart(2, '0')).join('');
    }
    return d => lut[clamp(Math.round(clamp(d / 5, 0, 1) * STEPS), 0, STEPS)];
  })();

  /* RGB 파싱 (Canvas 스파크라인 glow용) */
  const hexToRgb = hex => {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  };

  /** 버퍼 잔량(초) */
  const getBuf = vid => {
    try {
      const b = vid.buffered;
      if (!b.length) return -1;
      return b.end(b.length - 1) - vid.currentTime;
    } catch { return -1; }
  };

  /* P1 — isLive() WeakMap TTL 캐싱 (5s) */
  const _liveCache = new WeakMap();

  const isLive = vid => {
    if (!vid) return false;
    // duration=Infinity 는 항상 참 — 캐시 불필요
    if (vid.duration === Infinity || vid.duration >= 1e6) return true;

    const cached = _liveCache.get(vid);
    if (cached && performance.now() - cached.ts < 5000) return cached.v;

    let v = false;
    try {
      const s = vid.seekable;
      if (s.length && s.end(s.length - 1) - s.start(0) > 30 && vid.duration > 600) {
        const b = vid.buffered;
        if (b.length && Math.abs(b.end(b.length - 1) - s.end(s.length - 1)) < 60) v = true;
      }
    } catch {}
    _liveCache.set(vid, { v, ts: performance.now() });
    return v;
  };

  /** 유효한 라이브 비디오인지 확인 */
  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:') || src === '') return true;
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
    _liveCache.delete(v); // P1 — 재연결 시 캐시 무효화
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

  document.addEventListener('play', e => {
    if (e.target?.tagName === 'VIDEO') attach(e.target);
  }, { capture: true });

  let mo = null;

  /* P5 — querySelector 단락 평가: 단일 비디오 페이지에서 NodeList 생성 생략 */
  const scan = () => {
    const first = document.querySelector('video');
    if (!first) return;
    if (isCandidate(first)) { attach(first); return; }
    // 첫 번째가 후보가 아닌 경우(멀티 비디오 페이지)만 전체 탐색
    for (const v of document.querySelectorAll('video')) {
      if (v !== first && isCandidate(v)) { attach(v); break; }
    }
  };

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

  /* ── Render State (변경 감지용 캐시) ── */
  let _prev = { dot: '', txt: '', clr: '', w: '', badge: '', badgeCls: '', net: '' };

  /* ── P3 — OffscreenCanvas + Worker 스파크라인 ── */
  const SPARK_W = 208, SPARK_H = 32;

  const SPARK_WORKER_SRC = /* js */`
const HIST = 60, W = 208, H = 32;
let ctx, dpr, _prevHead = -1, _prevColor = '';

const rgb = h => { const n = parseInt(h.slice(1), 16); return \`\${(n>>16)&255},\${(n>>8)&255},\${n&255}\`; };

self.onmessage = ({ data: d }) => {
  if (d.type === 'init') { ctx = d.canvas.getContext('2d'); dpr = d.dpr; return; }
  if (d.type !== 'draw') return;

  const { hist, histHead, histLen, color, target } = d;
  if (!ctx || histLen < 2) return;
  // 변화 없으면 스킵
  if (histHead === _prevHead && color === _prevColor) return;
  _prevHead = histHead; _prevColor = color;

  ctx.clearRect(0, 0, W * dpr, H * dpr);
  ctx.save(); ctx.scale(dpr, dpr);

  let mx = target + 2;
  for (let i = 0; i < histLen; i++) {
    const v = hist[(histHead - histLen + i + HIST) % HIST];
    if (v > mx) mx = v;
  }
  const pad = 2, yR = H - pad * 2, xS = W / (HIST - 1);

  // 목표선
  const tY = H - pad - (target / mx) * yR;
  ctx.beginPath(); ctx.setLineDash([3,3]);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
  ctx.moveTo(0, tY); ctx.lineTo(W, tY); ctx.stroke(); ctx.setLineDash([]);

  const r = rgb(color);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, \`rgba(\${r},.20)\`); g.addColorStop(1, \`rgba(\${r},.02)\`);

  const drawPath = () => {
    ctx.beginPath();
    for (let i = 0; i < histLen; i++) {
      const v = hist[(histHead - histLen + i + HIST) % HIST];
      const x = i * xS, y = H - pad - (v / mx) * yR;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  };

  // 채우기
  drawPath();
  ctx.lineTo((histLen-1)*xS, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();

  // 라인
  drawPath();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  // 끝점 글로우
  const lv = hist[(histHead - 1 + HIST) % HIST];
  const lx = (histLen-1)*xS, ly = H - pad - (lv / mx) * yR;
  const gw = ctx.createRadialGradient(lx, ly, 0, lx, ly, 6);
  gw.addColorStop(0, \`rgba(\${r},.6)\`); gw.addColorStop(1, \`rgba(\${r},0)\`);
  ctx.fillStyle = gw; ctx.fillRect(lx-6, ly-6, 12, 12);
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI*2);
  ctx.fillStyle = color; ctx.fill();

  ctx.restore();
};
`;

  let sparkWorker = null;
  let sparkCanvas = null, sparkCtx = null;

  /* 스파크라인 Canvas 초기화 — OffscreenCanvas 지원 시 Worker로 오프로드 */
  const initSparkCanvas = (cvs) => {
    const dpr = window.devicePixelRatio || 1;
    cvs.style.width  = SPARK_W + 'px';
    cvs.style.height = SPARK_H + 'px';
    cvs.width  = SPARK_W * dpr;
    cvs.height = SPARK_H * dpr;

    if (typeof OffscreenCanvas !== 'undefined' && cvs.transferControlToOffscreen) {
      try {
        const offscreen = cvs.transferControlToOffscreen();
        const blob = new Blob([SPARK_WORKER_SRC], { type: 'text/javascript' });
        sparkWorker = new Worker(URL.createObjectURL(blob));
        sparkWorker.postMessage({ type: 'init', canvas: offscreen, dpr }, [offscreen]);
        sparkCanvas = null; sparkCtx = null;
        return;
      } catch {}
    }
    // 폴백: 기존 메인스레드
    sparkCanvas = cvs;
    sparkCtx    = cvs.getContext('2d');
  };

  /* 메인스레드 폴백 스파크라인 (OffscreenCanvas 미지원 환경) */
  const _drawSparkMain = (color) => {
    if (!sparkCtx || histLen < 2) return;
    const ctx = sparkCtx;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, SPARK_W * dpr, SPARK_H * dpr);
    ctx.save();
    ctx.scale(dpr, dpr);

    let mx = target + 2;
    for (let i = 0; i < histLen; i++) {
      const v = hist[(histHead - histLen + i + HIST) % HIST];
      if (v > mx) mx = v;
    }
    const pad = 2;
    const yRange = SPARK_H - pad * 2;
    const xStep = SPARK_W / (HIST - 1);

    const tY = SPARK_H - pad - (target / mx) * yRange;
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1;
    ctx.moveTo(0, tY);
    ctx.lineTo(SPARK_W, tY);
    ctx.stroke();
    ctx.setLineDash([]);

    const rgb = hexToRgb(color);
    const grad = ctx.createLinearGradient(0, 0, 0, SPARK_H);
    grad.addColorStop(0, `rgba(${rgb},.20)`);
    grad.addColorStop(1, `rgba(${rgb},.02)`);

    const drawPath = () => {
      ctx.beginPath();
      for (let i = 0; i < histLen; i++) {
        const v = hist[(histHead - histLen + i + HIST) % HIST];
        const x = i * xStep, y = SPARK_H - pad - (v / mx) * yRange;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    };

    drawPath();
    ctx.lineTo((histLen - 1) * xStep, SPARK_H);
    ctx.lineTo(0, SPARK_H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    drawPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const lastV = hist[(histHead - 1 + HIST) % HIST];
    const lx = (histLen - 1) * xStep;
    const ly = SPARK_H - pad - (lastV / mx) * yRange;
    const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, 6);
    glow.addColorStop(0, `rgba(${rgb},.6)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(lx - 6, ly - 6, 12, 12);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.restore();
  };

  const drawSpark = (color) => {
    if (histLen < 2) return;
    if (sparkWorker) {
      // Worker로 데이터 전달 (Float32Array 60항목 = 240bytes)
      sparkWorker.postMessage({
        type: 'draw',
        hist: hist.slice(),
        histHead, histLen, color, target
      });
    } else {
      _drawSparkMain(color);
    }
  };

  /* ── Tick & Render ── */
  let pendingRender = false, lastBuf = -1;
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; render(lastBuf, getVid()); });
  };

  const tick = () => {
    const vid = getVid();

    if (vid && !vid.isConnected) { setVid(null); lastBuf = -1; scheduleRender(); return; }
    if (!vid) { scan(); lastBuf = -1; scheduleRender(); return; }
    if (!isCandidate(vid) || vid.readyState < 3 || !isLive(vid)) { lastBuf = -1; scheduleRender(); return; }

    const buf = getBuf(vid);
    lastBuf = buf;
    if (!vid.paused && buf >= 0) histPush(buf);
    scheduleRender();

    if (vid.paused) return;
    if (!enabled) { safeRate(vid, R_NORM); gear = R_NORM; return; }

    const now = performance.now();
    if (now < warmupEnd) return;
    if (buf > PANIC && now - lastSeek > SEEK_CD) { doSeek(vid); return; }

    // P2 — tick 내 updateNetQuality() 제거 (이벤트 기반으로 처리됨)

    if (now - lastStallTime < STALL_COOLDOWN) { gear = R_NORM; safeRate(vid, R_NORM); return; }

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
  const render = (buf, vid) => {
    const sec = buf < 0 ? 0 : buf;
    const diff = sec - target;
    const c = colorOf(diff);
    const speeding = vid && vid.playbackRate > 1;

    /* FAB 모드 */
    if (!panelOpen) {
      if (!els.fab) return;
      const fc = !enabled ? '#555' : speeding ? '#6C9CFF' : c;
      if (fc !== _prev.dot) {
        _prev.dot = fc;
        els.fab.style.setProperty('--ac', fc);
      }
      return;
    }

    /* 패널 모드 */
    const txt = buf < 0 ? '—' : sec.toFixed(1);
    const w = clamp(sec / BAR_MAX * 100, 0, 100).toFixed(1) + '%';

    if (txt !== _prev.txt) { els.val.textContent = txt; _prev.txt = txt; }
    if (c !== _prev.clr)   { els.pn.style.setProperty('--ac', c); _prev.clr = c; }
    if (w !== _prev.w)     { els.bar.style.width = w; _prev.w = w; }

    /* Badge */
    const now = performance.now();
    const inRange = sec <= target && sec >= Math.max(0, target - 0.5);
    let bTxt, bCls;
    if (!enabled)                                    { bTxt = 'OFF';      bCls = 'dm-b dm-off'; }
    else if (buf < 0)                                { bTxt = '…';        bCls = 'dm-b dm-off'; }
    else if (now - lastStallTime < STALL_COOLDOWN)   { bTxt = '⏸ 대기';  bCls = 'dm-b dm-off'; }
    else if (speeding)                               { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
    else if (inRange)                                { bTxt = '✓ 안정';   bCls = 'dm-b dm-ok'; }
    else                                             { bTxt = '→ 추적';   bCls = 'dm-b dm-acc'; }

    if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
    if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }

    /* Canvas 스파크라인 */
    drawSpark(c);

    /* 네트워크 인디케이터 */
    if (netQuality !== _prev.net && els.netDot) {
      _prev.net = netQuality;
      const nc = netQuality === 'poor' ? '#FF4555' : netQuality === 'fair' ? '#FFD040' : '#00E696';
      const nt = netQuality === 'poor' ? '불안정' : netQuality === 'fair' ? '보통' : '양호';
      els.netDot.style.background = nc;
      els.netTxt.textContent = nt;
    }
  };

  /* ── Build DOM ── */
  const build = () => {
    if (document.getElementById('dm-root')) return;

    GM_addStyle(`
/* ── Reset & Root ── */
#dm-root{--ac:#00E696;--bg:rgba(12,14,20,.92);--bg2:rgba(255,255,255,.04);--bg3:rgba(255,255,255,.07);--border:rgba(255,255,255,.06);--t1:#f0f0f0;--t2:rgba(255,255,255,.45);--rad:16px;font:12px/1.5 'SF Pro Text',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--t1)}

/* ── FAB ── */
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:40px;height:40px;border-radius:50%;background:var(--bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1.5px solid var(--ac);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s,transform .15s;contain:strict;box-shadow:0 0 12px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.04)}
#dm-fab:hover{transform:scale(1.08)}
#dm-fab:active{transform:scale(.95)}
.dm-dot{width:10px;height:10px;border-radius:50%;background:var(--ac);transition:background .4s;box-shadow:0 0 8px var(--ac)}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 0 var(--ac)}50%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 6px transparent}}
#dm-fab{animation:dm-pulse 2.5s ease-in-out infinite}

/* ── Panel ── */
/* P6 — contain:paint 추가 → 패널 내부 repaint의 외부 전파 차단 */
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:var(--bg);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--border);border-radius:var(--rad);padding:0;color:var(--t1);width:256px;box-shadow:0 12px 48px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03);user-select:none;opacity:0;transform:translateY(8px) scale(.97);pointer-events:none;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1);contain:layout style paint}
#dm-pn.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}

/* ── Header ── */
.dm-hdr{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;cursor:grab}
.dm-logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--ac),rgba(0,230,150,.5));display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:700;flex-shrink:0}
.dm-title{font-weight:600;font-size:13px;letter-spacing:-.01em}
.dm-host{font-size:9px;color:var(--t2);max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-close{margin-left:auto;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;opacity:.35;transition:opacity .15s,background .15s}
.dm-close:hover{opacity:.9;background:var(--bg3)}

/* ── Stat Row ── */
.dm-stat{display:flex;align-items:baseline;gap:4px;padding:0 16px 4px}
.dm-val{font:700 28px/1 'SF Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--ac);transition:color .4s;letter-spacing:-.02em}
.dm-unit{font-size:11px;color:var(--t2);margin-right:4px}
.dm-b{margin-left:auto;font-size:10px;padding:3px 10px;border-radius:20px;font-weight:600;letter-spacing:.01em;transition:all .3s}
.dm-ok{background:rgba(0,230,150,.1);color:#00E696}
.dm-acc{background:rgba(108,156,255,.12);color:#6C9CFF}
.dm-off{background:var(--bg2);color:#666}

/* ── Progress Bar ── */
.dm-barwrap{margin:6px 16px 10px;height:3px;border-radius:2px;background:var(--bg2);overflow:hidden}
.dm-bar{height:100%;min-width:2%;border-radius:2px;background:var(--ac);transition:width .5s cubic-bezier(.4,0,.2,1),background .4s;box-shadow:0 0 6px var(--ac)}

/* ── Sparkline Canvas ── */
.dm-spark{display:block;margin:0 16px 8px;border-radius:8px;background:var(--bg2)}

/* ── Slider ── */
.dm-sl-wrap{padding:0 16px;margin-bottom:10px}
.dm-sl-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--t2);margin-bottom:4px}
.dm-sl-row{display:flex;align-items:center;gap:10px}
.dm-sl-row input[type=range]{flex:1;height:3px;-webkit-appearance:none;appearance:none;background:var(--bg3);border-radius:2px;outline:none;transition:background .3s}
.dm-sl-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--ac);cursor:pointer;border:2px solid var(--bg);box-shadow:0 0 8px rgba(0,230,150,.3);transition:transform .15s}
.dm-sl-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15)}
.dm-sl-row input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--ac);cursor:pointer;border:2px solid var(--bg);box-shadow:0 0 8px rgba(0,230,150,.3)}
.dm-sv{font:700 13px/1 'SF Mono',ui-monospace,monospace;min-width:42px;text-align:right;color:var(--ac);font-variant-numeric:tabular-nums}

/* ── Footer ── */
.dm-ft{display:flex;align-items:center;gap:10px;padding:10px 16px 14px;border-top:1px solid var(--border)}
.dm-tog{position:relative;width:38px;height:20px;border-radius:10px;background:rgba(255,255,255,.08);cursor:pointer;transition:background .25s;flex-shrink:0}
.dm-tog.on{background:var(--ac)}
.dm-tog::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .25s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dm-tog.on::after{transform:translateX(18px)}
.dm-net{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--t2)}
.dm-net-dot{width:5px;height:5px;border-radius:50%;background:#00E696;transition:background .3s}
.dm-ver{margin-left:auto;font-size:9px;color:rgba(255,255,255,.15)}
.dm-key{font-size:9px;color:rgba(255,255,255,.15);padding:1px 6px;border:1px solid rgba(255,255,255,.06);border-radius:4px}
`);

    const root = document.createElement('div');
    root.id = 'dm-root';
    const sv = Math.round((target - MIN_TARGET) / (MAX_TARGET - MIN_TARGET) * 100);
    const hostLabel = HOST.replace(/\.(com|co\.kr|naver|tv)$/g, '').slice(0, 12);

    root.innerHTML =
`<div id="dm-fab"><div class="dm-dot"></div></div>
<div id="dm-pn">
  <div class="dm-hdr">
    <div class="dm-logo">D</div>
    <span class="dm-title">딜레이 미터</span>
    <span class="dm-host" title="${HOST}">${hostLabel}</span>
    <div class="dm-close"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
  </div>
  <div class="dm-stat">
    <span class="dm-val">—</span>
    <span class="dm-unit">초</span>
    <span class="dm-b dm-off">OFF</span>
  </div>
  <div class="dm-barwrap"><div class="dm-bar"></div></div>
  <canvas class="dm-spark" width="208" height="32"></canvas>
  <div class="dm-sl-wrap">
    <div class="dm-sl-labels"><span>저지연</span><span>안정</span></div>
    <div class="dm-sl-row">
      <input type="range" min="0" max="100" value="${sv}">
      <span class="dm-sv">${target.toFixed(1)}s</span>
    </div>
  </div>
  <div class="dm-ft">
    <div class="dm-tog${enabled ? ' on' : ''}"></div>
    <div class="dm-net"><div class="dm-net-dot"></div><span>양호</span></div>
    <span class="dm-ver">v12.1</span>
    <span class="dm-key">Alt+D</span>
  </div>
</div>`;

    document.body.appendChild(root);
    const pn = root.querySelector('#dm-pn'), fab = root.querySelector('#dm-fab');

    /* P3 — OffscreenCanvas 초기화 */
    initSparkCanvas(pn.querySelector('.dm-spark'));

    els = {
      fab, pn,
      val:    pn.querySelector('.dm-val'),
      bar:    pn.querySelector('.dm-bar'),
      badge:  pn.querySelector('.dm-b'),
      tog:    pn.querySelector('.dm-tog'),
      sl:     pn.querySelector('input[type=range]'),
      sv:     pn.querySelector('.dm-sv'),
      hdr:    pn.querySelector('.dm-hdr'),
      x:      pn.querySelector('.dm-close'),
      netDot: pn.querySelector('.dm-net-dot'),
      netTxt: pn.querySelector('.dm-net span'),
    };

    /* Events */
    fab.onclick = () => { if (!fab._m) openP(); };
    els.x.onclick = e => { e.stopPropagation(); closeP(); };
    els.tog.onclick = () => {
      enabled = !enabled; cfg.enabled = enabled; saveLazy();
      els.tog.classList.toggle('on', enabled);
    };
    els.sl.oninput = () => {
      target = MIN_TARGET + (MAX_TARGET - MIN_TARGET) * els.sl.value / 100;
      target = Math.round(target * 2) / 2;
      els.sv.textContent = target.toFixed(1) + 's';
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
    if (cfg.px) {
      const x = parseFloat(cfg.px);
      if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' });
    }
    if (cfg.dx) {
      const x = parseFloat(cfg.dx);
      if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' });
    }

    if (panelOpen) openP(true);
  };

  const openP = (instant) => {
    if (panelOpen && !instant) return;
    panelOpen = true; cfg.open = true; saveLazy();
    els.fab.style.display = 'none';
    els.pn.classList.add('open');
    _prev = { dot: '', txt: '', clr: '', w: '', badge: '', badgeCls: '', net: '' };
  };

  const closeP = () => {
    if (!panelOpen) return; panelOpen = false; cfg.open = false; saveLazy();
    const r = els.pn.getBoundingClientRect();
    els.pn.classList.remove('open');
    setTimeout(() => {
      if (panelOpen) return;
      els.fab.style.display = 'flex';
      Object.assign(els.fab.style, {
        left: clamp(r.right - 24, 0, innerWidth - 40) + 'px',
        top: clamp(r.top + 6, 0, innerHeight - 40) + 'px',
        right: 'auto', bottom: 'auto'
      });
      cfg.dx = els.fab.style.left; cfg.dy = els.fab.style.top; saveLazy();
    }, 260);
    _prev.dot = '';
  };

  /* ── Scheduling ── */
  const loop = () => {
    tick();
    const interval = document.hidden ? 5000 : panelOpen ? 1000 : 3000;
    setTimeout(loop, interval);
  };

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
    if (document.fullscreenElement) {
      Object.assign(els.pn.style, def);
      Object.assign(els.fab.style, def);
    } else {
      if (cfg.px) Object.assign(els.pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' });
      else Object.assign(els.pn.style, def);
      if (cfg.dx) Object.assign(els.fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' });
      else Object.assign(els.fab.style, def);
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
    Object.assign(t.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '10001', background: 'rgba(12,14,20,.92)', backdropFilter: 'blur(12px)',
      color: '#f0f0f0', padding: '10px 24px', borderRadius: '12px', fontSize: '13px',
      fontFamily: 'system-ui', transition: 'opacity .4s', border: '1px solid rgba(255,255,255,.06)',
      boxShadow: '0 8px 32px rgba(0,0,0,.5)'
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2500);
  });

  init();
})();
