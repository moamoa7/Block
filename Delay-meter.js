// ==UserScript==
// @name         딜레이 미터기
// @namespace    https://github.com/moamoa7
// @version      12.4.4
// @description  라이브 방송의 딜레이를 자동 감지·제어
// @author       DelayMeter
// @match        *://*.youtube.com/*
// @match        *://*.twitch.tv/*
// @match        *://chzzk.naver.com/*
// @match        *://*.sooplive.co.kr/*
// @match        *://*.afreecatv.com/*
// @exclude      *://*.youtube.com/live_chat*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ── Trusted Types ── */
  let ttPolicy;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      ttPolicy = window.trustedTypes.createPolicy('dm-html-policy-v12', {
        createHTML: s => s, createScriptURL: s => s
      });
    } catch (e) {
      ttPolicy = window.trustedTypes.defaultPolicy || { createHTML: s => s, createScriptURL: s => s };
    }
  } else {
    ttPolicy = { createHTML: s => s, createScriptURL: s => s };
  }

  /* ── 도메인·플랫폼 감지 ── */
  const HOST = location.hostname.replace(/^www\./, '');
  const STORE_KEY = 'dm_u12_' + HOST;

  const detectPlatform = () => {
    if (HOST.includes('youtube'))                              return 'youtube';
    if (HOST.includes('chzzk'))                                return 'chzzk';
    if (HOST.includes('sooplive') || HOST.includes('afreeca')) return 'soop';
    if (HOST.includes('twitch'))                               return 'twitch';
    return 'default';
  };
  const PLATFORM    = detectPlatform();
  const IS_YOUTUBE  = PLATFORM === 'youtube';

  /* ── 플랫폼별 설정 (기준 타겟 명시 + 나머지 자동 계산) ── */
  const PLATFORM_SETTINGS = {
    youtube: { target: 10 },
    chzzk:   { target: 2 },
    soop:    { target: 4 },
    twitch:  { target: 3 },
    default: { target: 3 },
  };

  const getDef = (p) => {
    const s = PLATFORM_SETTINGS[p] || PLATFORM_SETTINGS.default;
    const t = s.target;
    return {
      target: t,
      // 0.5 단위로 딱 떨어지게 반올림하여 슬라이더 스텝(0.5)과 동기화
      min:    s.min    ?? (Math.round(Math.max(0.5, t * 0.2) * 2) / 2),
      max:    s.max    ?? Math.round(Math.max(10, t * 3)),
      barMax: s.barMax ?? Math.round(Math.max(15, t * 3 + 5)),
      panic:  s.panic  ?? Math.round(Math.max(15, t * 4))
    };
  };

  const PD         = getDef(PLATFORM);
  const DEF_TARGET = PD.target;
  const MIN_TARGET = PD.min;
  const MAX_TARGET = PD.max;
  const BAR_MAX    = PD.barMax;
  const PANIC      = PD.panic;

  const SEEK_CD       = 10000;
  const HYST          = 0.3;
  const STALL_WINDOW  = 30000;
  const STALL_COOLDOWN= 8000;
  const R_NORM = 1.00, R_SOFT = 1.02, R_HIGH = 2.0;

  /* ── Config ── */
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { cfg = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };
  let _saveId = 0, _saveIsIdle = false;
  const saveLazy = () => {
    if ('requestIdleCallback' in window) {
      if (_saveIsIdle) cancelIdleCallback(_saveId); else clearTimeout(_saveId);
      _saveIsIdle = true;
      _saveId = requestIdleCallback(save, { timeout: 1500 });
    } else { _saveIsIdle = false; clearTimeout(_saveId); _saveId = setTimeout(save, 400); }
  };

  /* ── State ── */
  let _vidRef = null;
  const getVid = () => _vidRef?.deref() ?? null;
  const setVid = v => { _vidRef = v ? new WeakRef(v) : null; };

  let enabled = cfg.enabled ?? true;

  /* target 갱신 처리 */
  let target;
  if (cfg._platform === PLATFORM && cfg._lastDef === DEF_TARGET && cfg.target != null) {
    target = cfg.target;
  } else {
    target = DEF_TARGET;
    cfg._platform = PLATFORM;
    cfg._lastDef = DEF_TARGET;
    cfg.target = target;
    saveLazy();
  }

  let lastSeek  = 0;
  let warmupEnd = performance.now() + 4000;
  let gear      = R_NORM;
  let panelOpen = cfg.open ?? false;
  let els       = {};

  const HIST = 60;
  const hist = new Float32Array(HIST);
  let histHead = 0, histLen = 0;
  const histPush = v => { hist[histHead] = v; histHead = (histHead + 1) % HIST; if (histLen < HIST) histLen++; };

  let stallCount = 0, lastStallTime = 0;
  let netQuality = 'good';
  const updateNetQuality = () => {
    const c = navigator.connection;
    if (!c) return;
    if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.downlink < 1) netQuality = 'poor';
    else if (c.effectiveType === '3g' || c.downlink < 3) netQuality = 'fair';
    else netQuality = 'good';
  };
  updateNetQuality();
  if (navigator.connection) navigator.connection.addEventListener('change', updateNetQuality);

  /* ── Utils ── */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const colorOf = (() => {
    const STEPS = 40;
    const G = [0x00,0xE6,0x96], Y = [0xFF,0xD0,0x40], R = [0xFF,0x45,0x55];
    const lut = new Array(STEPS + 1);
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const a = t <= 0.5 ? G : Y, b = t <= 0.5 ? Y : R, u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
      lut[i] = '#' + [0,1,2].map(j => Math.round(a[j] + (b[j] - a[j]) * u).toString(16).padStart(2,'0')).join('');
    }
    return d => {
      const ratio = clamp(d / (DEF_TARGET * 0.5), 0, 1);
      return lut[clamp(Math.round(ratio * STEPS), 0, STEPS)];
    };
  })();

  const hexToRgb = hex => {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  };

  const getBuf = vid => {
    try { const b = vid.buffered; if (!b.length) return -1; return b.end(b.length - 1) - vid.currentTime; }
    catch { return -1; }
  };

  /* ── isLive ── */
  const _liveCache = new WeakMap();
  const isLive = vid => {
    if (!vid) return false;
    if (vid.duration === Infinity || vid.duration >= 1e6) return true;

    if (IS_YOUTUBE) {
      if (location.pathname.includes('/live')) return true;
      try {
        const p = document.querySelector('#movie_player');
        if (p && typeof p.getVideoData === 'function') { const d = p.getVideoData(); if (d && d.isLive) return true; }
        if (p && typeof p.getPlayerResponse === 'function') {
          const r = p.getPlayerResponse(); if (r?.videoDetails?.isLiveContent && r?.videoDetails?.isLive) return true;
        }
      } catch {}
      if (document.querySelector('.ytp-live-badge[disabled]') ||
          document.querySelector('.ytp-live') ||
          document.querySelector('ytd-badge-supported-renderer .badge-style-type-live-now')) return true;
    }

    const cached = _liveCache.get(vid);
    if (cached && performance.now() - cached.ts < 5000) return cached.v;
    let v = false;
    try {
      const s = vid.seekable;
      if (s.length && s.end(s.length - 1) - s.start(0) > 20) {
        const b = vid.buffered;
        if (b.length && Math.abs(b.end(b.length - 1) - s.end(s.length - 1)) < 120) v = true;
      }
    } catch {}
    _liveCache.set(vid, { v, ts: performance.now() });
    return v;
  };

  /* ── Engine ── */
  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:') || src === '') return true;
    if (IS_YOUTUBE) { try { if (v.buffered.length > 0) return true; } catch {} }
    try { if (v.buffered.length && isLive(v)) return true; } catch {}
    return false;
  };

  const getBufferTrend = () => {
    const n = Math.min(histLen, 10); if (n < 3) return 0;
    let sX = 0, sY = 0, sXY = 0, sX2 = 0;
    for (let i = 0; i < n; i++) { const y = hist[(histHead - n + i + HIST) % HIST]; sX += i; sY += y; sXY += i * y; sX2 += i * i; }
    return (n * sXY - sX * sY) / (n * sX2 - sX * sX);
  };

  const seen = new WeakSet();
  const attach = v => {
    if (getVid() === v) return;
    if (!isCandidate(v)) return;
    _liveCache.delete(v);
    setVid(v);
    lastSeek = 0; warmupEnd = performance.now() + 4000; gear = R_NORM;
    stallCount = 0; histLen = 0; histHead = 0;
    if (!seen.has(v)) {
      seen.add(v);
      v.addEventListener('emptied', () => { if (getVid() === v) attach(v); });
      v.addEventListener('loadeddata', () => { if (!getVid() && isCandidate(v)) attach(v); });
      const onStall = () => {
        const now = performance.now();
        if (now - lastStallTime > STALL_WINDOW) stallCount = 0;
        stallCount++; lastStallTime = now;
        if (getVid() === v) { gear = R_NORM; safeRate(v, R_NORM); }
      };
      v.addEventListener('waiting', onStall);
      v.addEventListener('stalled', onStall);
    }
  };

  document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') attach(e.target); }, { capture: true });
  document.addEventListener('playing', e => {
    if (e.target?.tagName === 'VIDEO') { const v = e.target; if (!getVid() || getVid() !== v) { if (isCandidate(v)) attach(v); } }
  }, { capture: true });

  let mo = null, _scanRetry = 0;
  const scan = () => {
    const vids = document.querySelectorAll('video'); if (!vids.length) return;
    let attached = false;
    for (const v of vids) { if (isCandidate(v)) { attach(v); attached = true; break; } }
    if (!attached && _scanRetry < 8) { _scanRetry++; setTimeout(scan, 800 * _scanRetry); }
    else if (attached) _scanRetry = 0;
  };

  const startObserver = () => {
    if (mo) return;
    mo = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') { attach(n); return; }
        if (n.getElementsByTagName) { const v = n.getElementsByTagName('video')[0]; if (v) { attach(v); return; } }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  };

  const safeRate = (vid, r) => { if (!vid || vid.playbackRate === r) return; vid.playbackRate = r; try { vid.preservesPitch = true; } catch {} };
  const doSeek = vid => {
    try {
      const s = vid.seekable;
      if (s.length) vid.currentTime = Math.max(s.start(s.length - 1), s.end(s.length - 1) - target - 1);
      else { const b = vid.buffered, i = b.length - 1; vid.currentTime = Math.max(b.start(i), b.end(i) - target - 1); }
      lastSeek = performance.now();
    } catch {}
  };

  let _prev = { dot:'', txt:'', clr:'', w:'', badge:'', badgeCls:'', net:'' };

  const SPARK_W = 208, SPARK_H = 32;
  const SPARK_WORKER_SRC = `
const HIST=60,W=208,H=32;let ctx,dpr,_pH=-1,_pC='';
const rgb=h=>{const n=parseInt(h.slice(1),16);return\`\${(n>>16)&255},\${(n>>8)&255},\${n&255}\`};
self.onmessage=({data:d})=>{
if(d.type==='init'){ctx=d.canvas.getContext('2d');dpr=d.dpr;return}
if(d.type!=='draw')return;
const{hist,histHead,histLen,color,target}=d;
if(!ctx||histLen<2)return;if(histHead===_pH&&color===_pC)return;_pH=histHead;_pC=color;
ctx.clearRect(0,0,W*dpr,H*dpr);ctx.save();ctx.scale(dpr,dpr);
let mx=target+2;for(let i=0;i<histLen;i++){const v=hist[(histHead-histLen+i+HIST)%HIST];if(v>mx)mx=v}
const pad=2,yR=H-pad*2,xS=W/(HIST-1),tY=H-pad-(target/mx)*yR;
ctx.beginPath();ctx.setLineDash([3,3]);ctx.strokeStyle='rgba(255,255,255,.12)';ctx.lineWidth=1;
ctx.moveTo(0,tY);ctx.lineTo(W,tY);ctx.stroke();ctx.setLineDash([]);
const r=rgb(color),g=ctx.createLinearGradient(0,0,0,H);
g.addColorStop(0,\`rgba(\${r},.20)\`);g.addColorStop(1,\`rgba(\${r},.02)\`);
const dp=()=>{ctx.beginPath();for(let i=0;i<histLen;i++){const v=hist[(histHead-histLen+i+HIST)%HIST],x=i*xS,y=H-pad-(v/mx)*yR;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}};
dp();ctx.lineTo((histLen-1)*xS,H);ctx.lineTo(0,H);ctx.closePath();ctx.fillStyle=g;ctx.fill();
dp();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.stroke();
const lv=hist[(histHead-1+HIST)%HIST],lx=(histLen-1)*xS,ly=H-pad-(lv/mx)*yR;
const gw=ctx.createRadialGradient(lx,ly,0,lx,ly,6);gw.addColorStop(0,\`rgba(\${r},.6)\`);gw.addColorStop(1,\`rgba(\${r},0)\`);
ctx.fillStyle=gw;ctx.fillRect(lx-6,ly-6,12,12);ctx.beginPath();ctx.arc(lx,ly,2.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
ctx.restore()};`;

  let sparkWorker = null, sparkCanvas = null, sparkCtx = null;
  const initSparkCanvas = cvs => {
    const dpr = devicePixelRatio || 1;
    cvs.style.width = SPARK_W + 'px'; cvs.style.height = SPARK_H + 'px';
    cvs.width = SPARK_W * dpr; cvs.height = SPARK_H * dpr;
    if (typeof OffscreenCanvas !== 'undefined' && cvs.transferControlToOffscreen) {
      try {
        const blob = new Blob([SPARK_WORKER_SRC], { type: 'text/javascript' });
        let url = URL.createObjectURL(blob);
        if (ttPolicy?.createScriptURL) url = ttPolicy.createScriptURL(url);
        sparkWorker = new Worker(url); URL.revokeObjectURL(url);
        const off = cvs.transferControlToOffscreen();
        sparkWorker.postMessage({ type: 'init', canvas: off, dpr }, [off]);
        sparkCanvas = null; sparkCtx = null; return;
      } catch { sparkWorker = null; }
    }
    sparkCanvas = cvs; sparkCtx = cvs.getContext('2d');
  };

  const _drawSparkMain = color => {
    if (!sparkCtx || histLen < 2) return;
    const ctx = sparkCtx, dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, SPARK_W * dpr, SPARK_H * dpr); ctx.save(); ctx.scale(dpr, dpr);
    let mx = target + 2;
    for (let i = 0; i < histLen; i++) { const v = hist[(histHead - histLen + i + HIST) % HIST]; if (v > mx) mx = v; }
    const pad = 2, yR = SPARK_H - pad * 2, xS = SPARK_W / (HIST - 1);
    const tY = SPARK_H - pad - (target / mx) * yR;
    ctx.beginPath(); ctx.setLineDash([3,3]); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    ctx.moveTo(0, tY); ctx.lineTo(SPARK_W, tY); ctx.stroke(); ctx.setLineDash([]);
    const rgb = hexToRgb(color), grad = ctx.createLinearGradient(0, 0, 0, SPARK_H);
    grad.addColorStop(0, `rgba(${rgb},.20)`); grad.addColorStop(1, `rgba(${rgb},.02)`);
    const dp = () => { ctx.beginPath(); for (let i = 0; i < histLen; i++) { const v = hist[(histHead - histLen + i + HIST) % HIST], x = i * xS, y = SPARK_H - pad - (v / mx) * yR; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } };
    dp(); ctx.lineTo((histLen - 1) * xS, SPARK_H); ctx.lineTo(0, SPARK_H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    dp(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    const lV = hist[(histHead - 1 + HIST) % HIST], lx = (histLen - 1) * xS, ly = SPARK_H - pad - (lV / mx) * yR;
    const gw = ctx.createRadialGradient(lx, ly, 0, lx, ly, 6);
    gw.addColorStop(0, `rgba(${rgb},.6)`); gw.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gw; ctx.fillRect(lx - 6, ly - 6, 12, 12);
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  };

  const drawSpark = color => {
    if (histLen < 2) return;
    if (sparkWorker) sparkWorker.postMessage({ type: 'draw', hist: hist.slice(), histHead, histLen, color, target });
    else _drawSparkMain(color);
  };

  let pendingRender = false, lastBuf = -1;
  const scheduleRender = () => { if (pendingRender) return; pendingRender = true; requestAnimationFrame(() => { pendingRender = false; render(lastBuf, getVid()); }); };

  const tick = () => {
    const vid = getVid();
    if (vid && !vid.isConnected) { setVid(null); lastBuf = -1; scheduleRender(); return; }
    if (!vid) { scan(); lastBuf = -1; scheduleRender(); return; }
    if (!isCandidate(vid) || vid.readyState < 3) { lastBuf = -1; scheduleRender(); return; }
    if (!isLive(vid)) { if (IS_YOUTUBE) _scanRetry = 0; lastBuf = -1; scheduleRender(); return; }

    const buf = getBuf(vid); lastBuf = buf;
    if (!vid.paused && buf >= 0) histPush(buf);
    scheduleRender();
    if (vid.paused) return;
    if (!enabled) { safeRate(vid, R_NORM); gear = R_NORM; return; }

    const now = performance.now();
    if (now < warmupEnd) return;
    if (buf > PANIC && now - lastSeek > SEEK_CD) { doSeek(vid); return; }
    if (now - lastStallTime < STALL_COOLDOWN) { gear = R_NORM; safeRate(vid, R_NORM); return; }

    const trend = getBufferTrend(), ex = buf - target;
    if (ex > target * 0.5) gear = R_HIGH;
    else if (ex > HYST) {
      if (netQuality === 'poor' || trend < -0.15) gear = R_NORM;
      else gear = R_SOFT;
    } else if (ex < -HYST) gear = R_NORM;
    safeRate(vid, gear);
  };

  const render = (buf, vid) => {
    const sec = buf < 0 ? 0 : buf, diff = sec - target, c = colorOf(diff), speeding = vid && vid.playbackRate > 1;
    if (!panelOpen) {
      if (!els.fab) return;
      const fc = !enabled ? '#555' : speeding ? '#6C9CFF' : c;
      if (fc !== _prev.dot) { _prev.dot = fc; els.fab.style.setProperty('--ac', fc); }
      return;
    }
    const txt = buf < 0 ? '—' : sec.toFixed(1), w = clamp(sec / BAR_MAX * 100, 0, 100).toFixed(1) + '%';
    if (txt !== _prev.txt) { els.val.textContent = txt; _prev.txt = txt; }
    if (c !== _prev.clr)   { els.pn.style.setProperty('--ac', c); _prev.clr = c; }
    if (w !== _prev.w)     { els.bar.style.width = w; _prev.w = w; }

    const now = performance.now(), inRange = sec <= target && sec >= Math.max(0, target - 0.5);
    let bTxt, bCls;
    if (!enabled)                                  { bTxt = 'OFF';     bCls = 'dm-b dm-off'; }
    else if (buf < 0)                              { bTxt = '…';       bCls = 'dm-b dm-off'; }
    else if (now - lastStallTime < STALL_COOLDOWN) { bTxt = '⏸ 대기'; bCls = 'dm-b dm-off'; }
    else if (speeding)                             { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
    else if (inRange)                              { bTxt = '✓ 안정';  bCls = 'dm-b dm-ok'; }
    else                                           { bTxt = '→ 추적';  bCls = 'dm-b dm-acc'; }
    if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
    if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }
    drawSpark(c);
    if (netQuality !== _prev.net && els.netDot) {
      _prev.net = netQuality;
      els.netDot.style.background = netQuality === 'poor' ? '#FF4555' : netQuality === 'fair' ? '#FFD040' : '#00E696';
      els.netTxt.textContent = netQuality === 'poor' ? '불안정' : netQuality === 'fair' ? '보통' : '양호';
    }
  };

  /* ── Build DOM ── */
  const PLATFORM_LABEL = { youtube: 'YouTube', chzzk: 'CHZZK', soop: 'SOOP', twitch: 'Twitch', default: HOST }[PLATFORM];

  const build = () => {
    if (document.getElementById('dm-root')) return;
    GM_addStyle(`
#dm-root{--ac:#00E696;--bg:rgba(12,14,20,.92);--bg2:rgba(255,255,255,.04);--bg3:rgba(255,255,255,.07);--border:rgba(255,255,255,.06);--t1:#f0f0f0;--t2:rgba(255,255,255,.45);--rad:16px;font:12px/1.5 'SF Pro Text',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--t1)}
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:40px;height:40px;border-radius:50%;background:var(--bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1.5px solid var(--ac);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s,transform .15s;contain:strict;box-shadow:0 0 12px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.04)}
#dm-fab:hover{transform:scale(1.08)}#dm-fab:active{transform:scale(.95)}
.dm-dot{width:10px;height:10px;border-radius:50%;background:var(--ac);transition:background .4s;box-shadow:0 0 8px var(--ac)}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 0 var(--ac)}50%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 6px transparent}}
#dm-fab{animation:dm-pulse 2.5s ease-in-out infinite}
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:var(--bg);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--border);border-radius:var(--rad);padding:0;color:var(--t1);width:256px;box-shadow:0 12px 48px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03);user-select:none;opacity:0;transform:translateY(8px) scale(.97);pointer-events:none;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1);contain:layout style paint}
#dm-pn.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.dm-hdr{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;cursor:grab}
.dm-logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--ac),rgba(0,230,150,.5));display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:700;flex-shrink:0}
.dm-title{font-weight:600;font-size:13px;letter-spacing:-.01em}
.dm-host{font-size:9px;color:var(--t2);max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-close{margin-left:auto;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;opacity:.35;transition:opacity .15s,background .15s}
.dm-close:hover{opacity:.9;background:var(--bg3)}
.dm-stat{display:flex;align-items:baseline;gap:4px;padding:0 16px 4px}
.dm-val{font:700 28px/1 'SF Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--ac);transition:color .4s;letter-spacing:-.02em}
.dm-unit{font-size:11px;color:var(--t2);margin-right:4px}
.dm-b{margin-left:auto;font-size:10px;padding:3px 10px;border-radius:20px;font-weight:600;letter-spacing:.01em;transition:all .3s}
.dm-ok{background:rgba(0,230,150,.1);color:#00E696}.dm-acc{background:rgba(108,156,255,.12);color:#6C9CFF}.dm-off{background:var(--bg2);color:#666}
.dm-barwrap{margin:6px 16px 10px;height:3px;border-radius:2px;background:var(--bg2);overflow:hidden}
.dm-bar{height:100%;min-width:2%;border-radius:2px;background:var(--ac);transition:width .5s cubic-bezier(.4,0,.2,1),background .4s;box-shadow:0 0 6px var(--ac)}
.dm-spark{display:block;margin:0 16px 8px;border-radius:8px;background:var(--bg2)}
.dm-sl-wrap{padding:0 16px;margin-bottom:10px}
.dm-sl-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--t2);margin-bottom:4px}
.dm-sl-row{display:flex;align-items:center;gap:10px}
.dm-sl-row input[type=range]{flex:1;height:3px;-webkit-appearance:none;appearance:none;background:var(--bg3);border-radius:2px;outline:none;transition:background .3s}
.dm-sl-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--ac);cursor:pointer;border:2px solid var(--bg);box-shadow:0 0 8px rgba(0,230,150,.3);transition:transform .15s}
.dm-sl-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15)}
.dm-sl-row input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--ac);cursor:pointer;border:2px solid var(--bg);box-shadow:0 0 8px rgba(0,230,150,.3)}
.dm-sv{font:700 13px/1 'SF Mono',ui-monospace,monospace;min-width:42px;text-align:right;color:var(--ac);font-variant-numeric:tabular-nums}
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

    const root = document.createElement('div'); root.id = 'dm-root';

    const html = `<div id="dm-fab"><div class="dm-dot"></div></div>
<div id="dm-pn">
  <div class="dm-hdr">
    <div class="dm-logo">D</div>
    <span class="dm-title">딜레이 미터</span>
    <span class="dm-host" title="${HOST}">${PLATFORM_LABEL}</span>
    <div class="dm-close"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
  </div>
  <div class="dm-stat">
    <span class="dm-val">\u2014</span>
    <span class="dm-unit">초</span>
    <span class="dm-b dm-off">OFF</span>
  </div>
  <div class="dm-barwrap"><div class="dm-bar"></div></div>
  <canvas class="dm-spark" width="208" height="32"></canvas>
  <div class="dm-sl-wrap">
    <div class="dm-sl-labels"><span>저지연 (${MIN_TARGET.toFixed(1)}s)</span><span>안정 (${MAX_TARGET}s)</span></div>
    <div class="dm-sl-row">
      <input type="range" min="${MIN_TARGET}" max="${MAX_TARGET}" step="0.5" value="${target}">
      <div style="display:flex; flex-direction:column; align-items:flex-end;">
        <span class="dm-sv">${target.toFixed(1)}s</span>
        <span style="font-size:8.5px; color:var(--t2); margin-top:2px; letter-spacing:-0.02em;">기본 ${DEF_TARGET}s</span>
      </div>
    </div>
  </div>
  <div class="dm-ft">
    <div class="dm-tog${enabled ? ' on' : ''}"></div>
    <div class="dm-net"><div class="dm-net-dot"></div><span>양호</span></div>
    <span class="dm-ver">v12.4.4</span>
    <span class="dm-key">Alt+D</span>
  </div>
</div>`;

    root.innerHTML = ttPolicy.createHTML(html);
    document.body.appendChild(root);
    const pn = root.querySelector('#dm-pn'), fab = root.querySelector('#dm-fab');
    initSparkCanvas(pn.querySelector('.dm-spark'));

    els = {
      fab, pn,
      val: pn.querySelector('.dm-val'), bar: pn.querySelector('.dm-bar'),
      badge: pn.querySelector('.dm-b'), tog: pn.querySelector('.dm-tog'),
      sl: pn.querySelector('input[type=range]'), sv: pn.querySelector('.dm-sv'),
      hdr: pn.querySelector('.dm-hdr'), x: pn.querySelector('.dm-close'),
      netDot: pn.querySelector('.dm-net-dot'), netTxt: pn.querySelector('.dm-net span'),
    };

    fab.onclick = () => { if (!fab._m) openP(); };
    els.x.onclick = e => { e.stopPropagation(); closeP(); };
    els.tog.onclick = () => { enabled = !enabled; cfg.enabled = enabled; saveLazy(); els.tog.classList.toggle('on', enabled); };

    els.sl.oninput = () => {
      target = parseFloat(els.sl.value);
      els.sv.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
    };

    els.sl.ondblclick = () => {
      target = DEF_TARGET;
      els.sl.value = target;
      els.sv.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
    };

    /* Drag */
    const drag = (el, onEnd) => {
      let ox, oy, moved = false;
      el.onpointerdown = e => { if (e.button) return; moved = false; el._m = false; el.setPointerCapture(e.pointerId); const r = el.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; };
      el.onpointermove = e => { if (!el.hasPointerCapture(e.pointerId)) return; moved = true; el.style.left = clamp(e.clientX - ox, 0, innerWidth - el.offsetWidth) + 'px'; el.style.top = clamp(e.clientY - oy, 0, innerHeight - el.offsetHeight) + 'px'; el.style.right = el.style.bottom = 'auto'; };
      el.onpointerup = e => { if (!el.hasPointerCapture(e.pointerId)) return; el._m = moved; if (moved && onEnd) onEnd(); };
    };
    drag(fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });

    els.hdr.onpointerdown = e => {
      if (e.button || e.target === els.x || els.x.contains(e.target)) return;
      els.hdr.setPointerCapture(e.pointerId);
      const r = pn.getBoundingClientRect(); els.hdr._ox = e.clientX - r.left; els.hdr._oy = e.clientY - r.top; els.hdr._m = false;
    };
    els.hdr.onpointermove = e => { if (!els.hdr.hasPointerCapture(e.pointerId)) return; els.hdr._m = true; pn.style.left = clamp(e.clientX - (els.hdr._ox ?? 0), 0, innerWidth - pn.offsetWidth) + 'px'; pn.style.top = clamp(e.clientY - (els.hdr._oy ?? 0), 0, innerHeight - pn.offsetHeight) + 'px'; pn.style.right = pn.style.bottom = 'auto'; };
    els.hdr.onpointerup = e => { if (!els.hdr.hasPointerCapture(e.pointerId)) return; if (els.hdr._m) { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); } };

    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }
    if (panelOpen) openP(true);
  };

  const openP = (instant) => {
    if (panelOpen && !instant) return;
    panelOpen = true; cfg.open = true; saveLazy();
    els.fab.style.display = 'none'; els.pn.classList.add('open');
    _prev = { dot:'', txt:'', clr:'', w:'', badge:'', badgeCls:'', net:'' };
  };
  const closeP = () => {
    if (!panelOpen) return; panelOpen = false; cfg.open = false; saveLazy();
    const r = els.pn.getBoundingClientRect(); els.pn.classList.remove('open');
    setTimeout(() => {
      if (panelOpen) return; els.fab.style.display = 'flex';
      Object.assign(els.fab.style, { left: clamp(r.right - 24, 0, innerWidth - 40) + 'px', top: clamp(r.top + 6, 0, innerHeight - 40) + 'px', right: 'auto', bottom: 'auto' });
      cfg.dx = els.fab.style.left; cfg.dy = els.fab.style.top; saveLazy();
    }, 260);
    _prev.dot = '';
  };

  const loop = () => { tick(); setTimeout(loop, document.hidden ? 5000 : panelOpen ? 1000 : 3000); };

  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); startObserver(); loop();
  };

  let lastPath = location.pathname + location.search;
  const onNav = () => {
    const cur = location.pathname + location.search; if (cur === lastPath) return; lastPath = cur;
    warmupEnd = performance.now() + 4000; lastSeek = 0; gear = R_NORM; stallCount = 0; _scanRetry = 0;
    setVid(null);
    setTimeout(scan, 500); setTimeout(scan, 1500); setTimeout(scan, 3000);
  };
  if ('navigation' in window) navigation.addEventListener('navigatesuccess', onNav);
  else {
    for (const m of ['pushState', 'replaceState']) { const o = history[m]; history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; }; }
    window.addEventListener('popstate', onNav);
  }

  document.addEventListener('keydown', e => {
    if (!e.altKey || e.code !== 'KeyD' || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const t = document.activeElement?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault(); enabled = !enabled; cfg.enabled = enabled; saveLazy();
    if (els.tog) els.tog.classList.toggle('on', enabled);
  });

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
    const vid = getVid(), buf = vid ? getBuf(vid) : -1;
    const gl = gear > 1.05 ? 'HIGH' : gear > 1 ? 'SOFT' : 'NORM';
    const live = vid ? isLive(vid) : false;
    const dur = vid ? vid.duration : -1;
    const txt = `[${PLATFORM}] target=${target}s | buf=${buf < 0 ? '-' : buf.toFixed(1) + 's'} | ${gl} | ${enabled ? 'ON' : 'OFF'} | net=${netQuality} | stall=${stallCount} | live=${live} | rs=${vid?.readyState ?? -1} | dur=${dur === Infinity ? '∞' : dur?.toFixed(0)}`;
    const t = document.createElement('div'); t.textContent = txt;
    Object.assign(t.style, { position:'fixed',top:'12px',left:'50%',transform:'translateX(-50%)',zIndex:'10001',background:'rgba(12,14,20,.92)',backdropFilter:'blur(12px)',color:'#f0f0f0',padding:'10px 24px',borderRadius:'12px',fontSize:'12px',fontFamily:'monospace',transition:'opacity .4s',border:'1px solid rgba(255,255,255,.06)',boxShadow:'0 8px 32px rgba(0,0,0,.5)',maxWidth:'90vw',wordBreak:'break-all' });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 4000);
  });

  init();
})();
