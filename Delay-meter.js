// ==UserScript==
// @name         딜레이 미터
// @namespace    https://github.com/moamoa7
// @version      14.2.0
// @description  라이브 방송의 딜레이를 자동 감지·제어
// @author       DelayMeter
// @match        *://*.youtube.com/*
// @match        *://*.chzzk.naver.com/*
// @match        *://*.sooplive.com/*
// @match        *://*.sooplive.co.kr/*
// @match        *://*.twitch.tv/*
// @exclude      *://*.youtube.com/live_chat*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.challenges.cloudflare.com/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.recaptcha.net/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ── 도메인·플랫폼 감지 ── */
  const HOST = location.hostname.replace(/^www\./, '');
  const PLATFORM = HOST.includes('youtube') ? 'youtube'
    : HOST.includes('chzzk') ? 'chzzk'
    : HOST.includes('sooplive') ? 'soop'
    : HOST.includes('twitch') ? 'twitch' : 'default';
  const IS_YOUTUBE = PLATFORM === 'youtube';
  const STORE_KEY  = 'dm_u14_' + HOST;

  /* ── 플랫폼별 설정 (사전 계산) ── */
  const PS = {
    youtube: { target: 10, min: 2,   max: 30, barMax: 35, panic: 40 },
    chzzk:   { target: 2,  min: 0.5, max: 10, barMax: 15, panic: 15 },
    soop:    { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
    twitch:  { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
    default: { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
  };
  const PD = PS[PLATFORM] || PS.default;
  const { target: DEF_TARGET, min: MIN_TARGET, max: MAX_TARGET, barMax: BAR_MAX, panic: PANIC } = PD;

  const SEEK_CD = 10000, HYST = 0.3, STALL_WINDOW = 30000, STALL_COOLDOWN = 8000, WARMUP_MS = 4000;
  const R_NORM = 1.00, R_SOFT = 1.02, R_MED = 1.10, R_HIGH = 1.50;
  const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  /* ── Config ── */
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { cfg = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };
  let _saveId = 0;
  const saveLazy = () => { clearTimeout(_saveId); _saveId = setTimeout(save, 400); };

  /* ── State ── */
  let _vidRef = null;
  const getVid = () => { if (_vidRef && !_vidRef.isConnected) _vidRef = null; return _vidRef; };
  const setVid = v => { _vidRef = v || null; };

  let enabled = cfg.enabled ?? true;
  let target;
  if (cfg._platform === PLATFORM && cfg._lastDef === DEF_TARGET && cfg.target != null) {
    target = cfg.target;
  } else {
    target = DEF_TARGET;
    Object.assign(cfg, { _platform: PLATFORM, _lastDef: DEF_TARGET, target });
    saveLazy();
  }

  let lastSeek = 0, warmupEnd = 0, gear = R_NORM, panelOpen = cfg.open ?? false, els = {};
  let stallCount = 0, lastStallTime = 0;
  let _isCurrentlyLive = false, _liveConfirmedOnce = false, _liveFalseCount = 0;

  /* ── 히스토리 링 버퍼 ── */
  const HIST = 60;
  const hist = new Float32Array(HIST);
  let histHead = 0, histLen = 0, histMax = 0;
  const histPush = v => {
    const wasFull = histLen === HIST;
    const oldVal = hist[histHead];
    hist[histHead] = v;
    histHead = (histHead + 1) % HIST;
    if (histLen < HIST) histLen++;

    if (v >= histMax) {
      histMax = v;
    } else if (wasFull && (oldVal >= histMax || (histHead & 7) === 0)) {
      histMax = 0;
      for (let i = 0; i < histLen; i++) if (hist[i] > histMax) histMax = hist[i];
    }
  };

  /* ── 프레임 품질 모니터링 ── */
  let _prevDropped = 0, _prevTotal = 0, _dropRate = 0;
  const updateDropRate = vid => {
    if (typeof vid.getVideoPlaybackQuality !== 'function') return;
    const q = vid.getVideoPlaybackQuality();
    const dD = q.droppedVideoFrames - _prevDropped;
    const dT = q.totalVideoFrames - _prevTotal;
    _prevDropped = q.droppedVideoFrames;
    _prevTotal = q.totalVideoFrames;
    if (dT >= 5) _dropRate = dD / dT;
  };
  const resetDropRate = () => { _prevDropped = _prevTotal = 0; _dropRate = 0; };

  /* ── 디코더 스트레스 ── */
  let _decoderStressed = false;

  /* ── Utils ── */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  let _colorOfKey = -999, _colorOfCache = '';
  const colorOf = d => {
    const key = Math.round(clamp(d / (DEF_TARGET * 0.5), 0, 1) * 200);
    if (key === _colorOfKey) return _colorOfCache;
    _colorOfKey = key;
    const ratio = key / 200;
    let a0, a1, a2, b0, b1, b2, u;
    if (ratio <= 0.5) { a0=0x00;a1=0xE6;a2=0x96; b0=0xFF;b1=0xD0;b2=0x40; u=ratio*2; }
    else              { a0=0xFF;a1=0xD0;a2=0x40; b0=0xFF;b1=0x45;b2=0x55; u=(ratio-0.5)*2; }
    const r = Math.round(a0+(b0-a0)*u), g = Math.round(a1+(b1-a1)*u), bl = Math.round(a2+(b2-a2)*u);
    _colorOfCache = '#' + ((1<<24)|(r<<16)|(g<<8)|bl).toString(16).slice(1);
    return _colorOfCache;
  };

  let _lastHex = '', _lastRgbStr = '';
  const hexToRgb = hex => {
    if (hex === _lastHex) return _lastRgbStr;
    _lastHex = hex;
    const n = parseInt(hex.slice(1), 16);
    _lastRgbStr = `${(n>>16)&255},${(n>>8)&255},${n&255}`;
    return _lastRgbStr;
  };

  const getBuf = vid => {
    try { const b = vid.buffered; if (!b.length) return -1; return b.end(b.length-1) - vid.currentTime; }
    catch { return -1; }
  };
  const isHlsSrc = src => /\.m3u8($|\?)/i.test(src);

  /* ── 라이브 판정 ── */
  const _liveCache = new WeakMap();
  const _liveTracker = new WeakMap();
  let _ytPlayerEl = null, _ytPlayerTs = 0, _ytLiveResult = false, _ytLiveTs = 0;

  const getYTPlayer = () => {
    const now = performance.now();
    if (_ytPlayerEl && now - _ytPlayerTs < 5000) return _ytPlayerEl;
    _ytPlayerEl = document.getElementById('movie_player');
    _ytPlayerTs = now;
    return _ytPlayerEl;
  };

  const isLiveYouTube = vid => {
    if (vid.duration === Infinity || vid.duration >= 1e6) return true;
    if (location.pathname.includes('/live')) return true;

    const now = performance.now();
    const ttl = _ytLiveResult ? 3000 : 1000;
    if (now - _ytLiveTs < ttl) return _ytLiveResult;

    let result = false;
    const p = getYTPlayer();
    if (p) {
      try {
        if (typeof p.getVideoData === 'function') {
          const d = p.getVideoData();
          if (d?.isLive) result = true;
        }
        if (!result && typeof p.getPlayerResponse === 'function') {
          const r = p.getPlayerResponse();
          if (r?.videoDetails?.isLiveContent && r?.videoDetails?.isLive) result = true;
        }
      } catch {}
    }
    // API 실패 시에만 DOM 폴백
    if (!result) {
      if (document.querySelector('.ytp-live-badge[disabled],.ytp-live,ytd-badge-supported-renderer .badge-style-type-live-now')) {
        result = true;
      }
    }
    _ytLiveResult = result;
    _ytLiveTs = now;
    return result;
  };

  const isLiveGeneric = vid => {
    if (vid.duration === Infinity || vid.duration >= 1e6) return true;

    const cached = _liveCache.get(vid);
    if (cached && performance.now() - cached.ts < 3000) return cached.v;

    let v = false;
    const src = vid.currentSrc || vid.src || '';

    if (isHlsSrc(src) && vid.buffered.length > 0) v = true;

    if (!v) {
      try {
        const s = vid.seekable;
        if (s.length > 0) {
          const start = s.start(0), end = s.end(s.length-1), d = vid.duration;
          if (start > 10) { v = true; }
          else {
            let tr = _liveTracker.get(vid);
            if (!tr) { tr = { end, dur: d, ts: performance.now(), count: 0 }; _liveTracker.set(vid, tr); }
            else {
              if (end > tr.end + 0.5 || d > tr.dur + 0.5) { tr.count++; tr.end = end; tr.dur = d; tr.ts = performance.now(); }
              if (tr.count >= 2) v = true;
            }
          }
          if (!v && (end - start > 20)) {
            const b = vid.buffered;
            if (b.length && Math.abs(b.end(b.length-1) - end) < 120) v = true;
          }
        }
      } catch {}
    }

    if (!v && vid.buffered.length > 0) {
      const d = vid.duration;
      if (d > 0 && isFinite(d) && vid.currentTime > 0) {
        if (d - vid.currentTime < 60 && isHlsSrc(src)) v = true;
      }
    }

    _liveCache.set(vid, { v, ts: performance.now() });
    return v;
  };

  const isLive = vid => vid ? (IS_YOUTUBE ? isLiveYouTube(vid) : isLiveGeneric(vid)) : false;

  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:') || src === '') return true;
    if (IS_YOUTUBE) { try { if (v.buffered.length > 0) return true; } catch {} }
    if (isHlsSrc(src)) return true;
    try { if (v.buffered.length && isLive(v)) return true; } catch {}
    return false;
  };

  let _trendValue = 0, _trendTs = 0;
  const getBufferTrend = () => {
    const now = performance.now();
    if (now - _trendTs < 2000) return _trendValue;
    _trendTs = now;

    const step = _rvfcActive ? Math.max(1, Math.floor(histLen / 10)) : 1;
    const maxN = Math.min(histLen, 10 * step);
    if (maxN < 3 * step) { _trendValue = 0; return 0; }

    let sX = 0, sY = 0, sXY = 0, sX2 = 0, count = 0;
    for (let i = 0; i < maxN; i += step) {
      const y = hist[(histHead - maxN + i + HIST) % HIST];
      sX += count; sY += y; sXY += count * y; sX2 += count * count;
      count++;
    }
    _trendValue = count > 1 ? (count * sXY - sX * sY) / (count * sX2 - sX * sX) : 0;
    return _trendValue;
  };

  /* ── rVFC ── */
  let _rvfcActive = false, _rvfcVid = null, _lastFrameBuf = -1;

  const startRVFC = vid => {
    if (!HAS_RVFC) return false;
    if (_rvfcVid === vid && _rvfcActive) return true;
    _rvfcActive = true;
    _rvfcVid = vid;
    const onFrame = (now, metadata) => {
      if (!_rvfcActive || getVid() !== vid || _rvfcVid !== vid) { _rvfcActive = false; _rvfcVid = null; return; }
      try {
        const b = vid.buffered;
        if (b.length > 0) {
          const buf = b.end(b.length-1) - metadata.mediaTime;
          _lastFrameBuf = buf;
          if (!vid.paused && buf >= 0) histPush(buf);
        }
      } catch {}
      if (metadata.processingDuration != null) _decoderStressed = metadata.processingDuration > 0.033;
      vid.requestVideoFrameCallback(onFrame);
    };
    vid.requestVideoFrameCallback(onFrame);
    return true;
  };

  const stopRVFC = () => { _rvfcActive = false; _rvfcVid = null; _lastFrameBuf = -1; _decoderStressed = false; };

  /* ── Video 감지·연결 ── */
  const seen = new WeakSet();
  const attach = v => {
    if (getVid() === v) return;
    if (!isCandidate(v)) return;
    _liveCache.delete(v);
    stopRVFC();
    stopObserver();
    setVid(v);
    lastSeek = 0;
    warmupEnd = performance.now() + WARMUP_MS; // 버그 수정: 워밍업 적용
    gear = R_NORM;
    stallCount = 0;
    histLen = 0; histHead = 0; histMax = 0;
    resetDropRate();
    _isCurrentlyLive = false;
    _liveConfirmedOnce = false;
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

  for (const evt of ['play', 'playing']) {
    document.addEventListener(evt, e => {
      if (e.target?.tagName === 'VIDEO') attach(e.target);
    }, { capture: true });
  }

  let mo = null, _scanRetry = 0;
  const stopObserver = () => { if (mo) { mo.disconnect(); mo = null; } };

  const scan = () => {
    const vids = document.getElementsByTagName('video');
    if (!vids.length) {
      if (_scanRetry < 15) { _scanRetry++; setTimeout(scan, 800 * Math.min(_scanRetry, 5)); }
      return;
    }
    for (let i = 0; i < vids.length; i++) {
      if (isCandidate(vids[i])) { attach(vids[i]); _scanRetry = 0; return; }
    }
    if (_scanRetry < 15) { _scanRetry++; setTimeout(scan, 2000); }
  };

  const startObserver = () => {
    if (mo || !document.body) return;
    mo = new MutationObserver(muts => {
      if (getVid()) { stopObserver(); return; }
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') { attach(n); return; }
        if (n.childElementCount > 0) { const v = n.querySelector('video'); if (v) { attach(v); return; } }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  };

  /* ── 제어 ── */
  const safeRate = (vid, r) => {
    if (!vid || vid.playbackRate === r) return;
    vid.playbackRate = r;
    try { vid.preservesPitch = true; } catch {}
  };

  const doSeek = vid => {
    try {
      const s = vid.seekable;
      if (s.length) {
        vid.currentTime = Math.max(s.start(s.length-1), s.end(s.length-1) - target - 1);
      } else {
        const b = vid.buffered;
        if (!b.length) return;
        const i = b.length - 1;
        vid.currentTime = Math.max(b.start(i), b.end(i) - target - 1);
      }
      lastSeek = performance.now();
    } catch {}
  };

  /* ── 스파크라인 ── */
  const SPARK_W = 208, SPARK_H = 32;
  let sparkCtx = null, _sparkLastHead = -1, _sparkLastLen = -1;

  const initSparkCanvas = cvs => {
    const dpr = devicePixelRatio || 1;
    cvs.style.width = SPARK_W + 'px'; cvs.style.height = SPARK_H + 'px';
    cvs.width = SPARK_W * dpr; cvs.height = SPARK_H * dpr;
    sparkCtx = cvs.getContext('2d');
  };

  const drawSpark = color => {
    if (!sparkCtx || histLen < 2) return;
    if (histHead === _sparkLastHead && histLen === _sparkLastLen) return;
    _sparkLastHead = histHead; _sparkLastLen = histLen;

    const ctx = sparkCtx, dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, SPARK_W * dpr, SPARK_H * dpr);
    ctx.save(); ctx.scale(dpr, dpr);

    const mx = Math.max(target + 2, histMax);
    const pad = 2, yR = SPARK_H - pad * 2, xS = SPARK_W / (HIST - 1);
    const tY = SPARK_H - pad - (target / mx) * yR;

    ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    ctx.moveTo(0, tY); ctx.lineTo(SPARK_W, tY); ctx.stroke(); ctx.setLineDash([]);

    const rgb = hexToRgb(color), grad = ctx.createLinearGradient(0, 0, 0, SPARK_H);
    grad.addColorStop(0, `rgba(${rgb},.20)`); grad.addColorStop(1, `rgba(${rgb},.02)`);

    const dp = () => {
      ctx.beginPath();
      for (let i = 0; i < histLen; i++) {
        const v = hist[(histHead - histLen + i + HIST) % HIST];
        const x = i * xS, y = SPARK_H - pad - (v / mx) * yR;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    };
    dp(); ctx.lineTo((histLen-1)*xS, SPARK_H); ctx.lineTo(0, SPARK_H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    dp(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

    const lV = hist[(histHead-1+HIST) % HIST], lx = (histLen-1)*xS, ly = SPARK_H - pad - (lV / mx) * yR;
    const gw = ctx.createRadialGradient(lx, ly, 0, lx, ly, 6);
    gw.addColorStop(0, `rgba(${rgb},.6)`); gw.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gw; ctx.fillRect(lx-6, ly-6, 12, 12);
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI*2); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  };

  /* ── 메인 루프 ── */
  let pendingRender = false, lastBuf = -1;
  const scheduleRender = () => { if (pendingRender) return; pendingRender = true; requestAnimationFrame(() => { pendingRender = false; render(lastBuf, getVid()); }); };

  const tick = () => {
    const vid = getVid();
    if (!vid) {
      scan(); stopRVFC(); startObserver();
      lastBuf = -1; _isCurrentlyLive = false;
      scheduleRender(); return;
    }
    if (!isCandidate(vid) || vid.readyState < 3) {
      lastBuf = -1;
      if (!_liveConfirmedOnce) _isCurrentlyLive = false;
      scheduleRender(); return;
    }

    const live = isLive(vid);
    if (!live) {
      if (IS_YOUTUBE) _scanRetry = 0;
      if (_liveConfirmedOnce) {
        _liveFalseCount++;
        if (_liveFalseCount < 3) { scheduleRender(); return; }
      }
      stopRVFC(); lastBuf = -1;
      _isCurrentlyLive = false; _liveConfirmedOnce = false; _liveFalseCount = 0;
      scheduleRender(); return;
    }
    _isCurrentlyLive = true; _liveConfirmedOnce = true; _liveFalseCount = 0;

    const rvfcRunning = startRVFC(vid);
    let buf;
    if (rvfcRunning && _lastFrameBuf >= 0) buf = _lastFrameBuf;
    else buf = getBuf(vid);
    lastBuf = buf;

    if (!rvfcRunning && !vid.paused && buf >= 0) histPush(buf);
    updateDropRate(vid);
    scheduleRender();

    if (vid.paused) return;
    if (!enabled) { safeRate(vid, R_NORM); gear = R_NORM; return; }

    const now = performance.now();
    if (now < warmupEnd) return;
    if (buf > PANIC && now - lastSeek > SEEK_CD) { doSeek(vid); return; }
    if (now - lastStallTime < STALL_COOLDOWN) { gear = R_NORM; safeRate(vid, R_NORM); return; }

    const trend = getBufferTrend(), ex = buf - target;

    if (ex > target * 0.8)       gear = R_HIGH;
    else if (ex > target * 0.4)  gear = R_MED;
    else if (ex > HYST) {
      gear = trend < -0.15 ? R_NORM : R_SOFT;
    }
    else if (ex < -HYST)         gear = R_NORM;

    if (gear > R_SOFT && (_dropRate > 0.05 || _decoderStressed)) {
      gear = gear === R_HIGH ? R_MED : R_SOFT;
    }

    safeRate(vid, gear);
  };

  /* ── 렌더 ── */
  let _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
  let _prevBufRound = -999, _prevBarPct = -1;

  const render = (buf, vid) => {
    if (!els.root) return;
    if (!_isCurrentlyLive || !vid) {
      if (els.root.style.display !== 'none') els.root.style.display = 'none';
      return;
    }
    if (els.root.style.display === 'none') els.root.style.display = 'block';

    const sec = buf < 0 ? 0 : buf, diff = sec - target, c = colorOf(diff);
    const speeding = vid && vid.playbackRate > 1;

    if (!panelOpen) {
      if (!els.fab) return;
      const fc = !enabled ? '#555' : speeding ? '#6C9CFF' : c;
      if (fc !== _prev.dot) { _prev.dot = fc; els.fab.style.setProperty('--ac', fc); }
      return;
    }

    const bufRound = buf < 0 ? -1 : Math.round(sec * 10);
    if (bufRound !== _prevBufRound) {
      _prevBufRound = bufRound;
      els.val.textContent = buf < 0 ? '—' : (bufRound / 10).toFixed(1);
    }
    if (c !== _prev.clr) { els.pn.style.setProperty('--ac', c); _prev.clr = c; }

    const barPct = Math.round(clamp(sec / BAR_MAX * 100, 0, 100) * 10);
    if (barPct !== _prevBarPct) {
      _prevBarPct = barPct;
      els.bar.style.width = (barPct / 10).toFixed(1) + '%';
    }

    const now = performance.now(), inRange = sec <= target && sec >= Math.max(0, target - 0.5);
    let bTxt, bCls;
    if (!enabled)                                  { bTxt = 'OFF';       bCls = 'dm-b dm-off'; }
    else if (buf < 0)                              { bTxt = '…';         bCls = 'dm-b dm-off'; }
    else if (now - lastStallTime < STALL_COOLDOWN) { bTxt = '⏸ 대기';    bCls = 'dm-b dm-off'; }
    else if (_dropRate > 0.05)                     { bTxt = '⚠ 드롭';    bCls = 'dm-b dm-off'; }
    else if (speeding)                             { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
    else if (inRange)                              { bTxt = '✓ 안정';    bCls = 'dm-b dm-ok'; }
    else                                           { bTxt = '→ 추적';    bCls = 'dm-b dm-acc'; }
    if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
    if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }

    drawSpark(c);
  };

  /* ── DOM 구축 ── */
  const PLATFORM_LABEL = { youtube: 'YouTube', chzzk: 'CHZZK', soop: 'SOOP', twitch: 'Twitch', default: HOST }[PLATFORM];

  const el = (tag, attrs, children) => {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'className') e.className = v;
      else if (k === 'textContent') e.textContent = v;
      else e.setAttribute(k, v);
    }
    if (children) for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  };

  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  const build = () => {
    if (document.getElementById('dm-root')) return;
    GM_addStyle(`
#dm-root{--ac:#00E696;--bg:rgba(12,14,20,.92);--bg2:rgba(255,255,255,.04);--bg3:rgba(255,255,255,.07);--border:rgba(255,255,255,.06);--t1:#f0f0f0;--t2:rgba(255,255,255,.45);--rad:16px;font:12px/1.5 'SF Pro Text',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--t1)}
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:40px;height:40px;border-radius:50%;background:var(--bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1.5px solid var(--ac);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s,transform .15s;contain:strict;box-shadow:0 0 12px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.04);will-change:transform,box-shadow}
#dm-fab:hover{transform:scale(1.08)}#dm-fab:active{transform:scale(.95)}
.dm-dot{width:10px;height:10px;border-radius:50%;background:var(--ac);transition:background .4s;box-shadow:0 0 8px var(--ac)}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 0 var(--ac)}50%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 6px transparent}}
#dm-fab{animation:dm-pulse 2.5s ease-in-out infinite}
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:var(--bg);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--border);border-radius:var(--rad);padding:0;color:var(--t1);width:256px;box-shadow:0 12px 48px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03);user-select:none;opacity:0;transform:translateY(8px) scale(.97);pointer-events:none;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1);contain:content;will-change:opacity,transform,visibility}
#dm-pn.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;visibility:visible}
#dm-pn:not(.open){visibility:hidden;transition:opacity .25s,transform .25s,visibility 0s .25s}.dm-hdr{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;cursor:grab}
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
.dm-ver{margin-left:auto;font-size:9px;color:rgba(255,255,255,.15)}
.dm-key{font-size:9px;color:rgba(255,255,255,.15);padding:1px 6px;border:1px solid rgba(255,255,255,.06);border-radius:4px}
`);

    const root = el('div', { id: 'dm-root', style: { display: 'none' } });
    const fab = el('div', { id: 'dm-fab' }, [el('div', { className: 'dm-dot' })]);
    const pn = el('div', { id: 'dm-pn' });

    const closeSvg = svgEl('svg', { width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none' });
    closeSvg.appendChild(svgEl('path', { d: 'M2.5 2.5l7 7', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }));
    closeSvg.appendChild(svgEl('path', { d: 'M9.5 2.5l-7 7', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }));
    const closeBtn = el('div', { className: 'dm-close' }, [closeSvg]);
    const hdr = el('div', { className: 'dm-hdr' }, [
      el('div', { className: 'dm-logo', textContent: 'D' }),
      el('span', { className: 'dm-title', textContent: '딜레이 미터' }),
      el('span', { className: 'dm-host', title: HOST, textContent: PLATFORM_LABEL }),
      closeBtn
    ]);

    const valSpan = el('span', { className: 'dm-val', textContent: '—' });
    const badgeSpan = el('span', { className: 'dm-b dm-off', textContent: 'OFF' });
    const stat = el('div', { className: 'dm-stat' }, [
      valSpan, el('span', { className: 'dm-unit', textContent: '초' }), badgeSpan
    ]);

    const barDiv = el('div', { className: 'dm-bar' });
    const barWrap = el('div', { className: 'dm-barwrap' }, [barDiv]);
    const sparkCvs = el('canvas', { className: 'dm-spark', width: '208', height: '32' });

    const slInput = el('input', { type: 'range', min: String(MIN_TARGET), max: String(MAX_TARGET), step: '0.5', value: String(target) });
    const svSpan = el('span', { className: 'dm-sv', textContent: target.toFixed(1) + 's' });
    const defLabel = el('span', { textContent: `기본 ${DEF_TARGET}s` });
    defLabel.style.cssText = 'font-size:8.5px;color:var(--t2);margin-top:2px;letter-spacing:-0.02em';
    const slWrap = el('div', { className: 'dm-sl-wrap' }, [
      el('div', { className: 'dm-sl-labels' }, [
        el('span', { textContent: `저지연 (${MIN_TARGET.toFixed(1)}s)` }),
        el('span', { textContent: `안정 (${MAX_TARGET}s)` })
      ]),
      el('div', { className: 'dm-sl-row' }, [
        slInput,
        el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' } }, [svSpan, defLabel])
      ])
    ]);

    const togDiv = el('div', { className: 'dm-tog' + (enabled ? ' on' : '') });
    const ft = el('div', { className: 'dm-ft' }, [
      togDiv,
      el('span', { className: 'dm-ver', textContent: 'v14.2.0' }),
      el('span', { className: 'dm-key', textContent: 'Alt+D' })
    ]);

    pn.append(hdr, stat, barWrap, sparkCvs, slWrap, ft);
    root.append(fab, pn);
    document.body.appendChild(root);

    initSparkCanvas(sparkCvs);

    els = { root, fab, pn, val: valSpan, bar: barDiv, badge: badgeSpan, tog: togDiv, sl: slInput, sv: svSpan, hdr, x: closeBtn };

    fab.onclick = () => { if (!fab._m) openP(); };
    closeBtn.onclick = e => { e.stopPropagation(); closeP(); };
    togDiv.onclick = () => { enabled = !enabled; cfg.enabled = enabled; saveLazy(); togDiv.classList.toggle('on', enabled); };

    slInput.oninput = () => {
      target = parseFloat(slInput.value);
      svSpan.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
    };
    slInput.ondblclick = () => {
      target = DEF_TARGET; slInput.value = target;
      svSpan.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
    };

    const drag = (dragEl, onEnd) => {
      let ox, oy, moved = false;
      dragEl.onpointerdown = e => { if (e.button) return; moved = false; dragEl._m = false; dragEl.setPointerCapture(e.pointerId); const r = dragEl.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; };
      dragEl.onpointermove = e => { if (!dragEl.hasPointerCapture(e.pointerId)) return; moved = true; dragEl.style.left = clamp(e.clientX - ox, 0, innerWidth - dragEl.offsetWidth) + 'px'; dragEl.style.top = clamp(e.clientY - oy, 0, innerHeight - dragEl.offsetHeight) + 'px'; dragEl.style.right = dragEl.style.bottom = 'auto'; };
      dragEl.onpointerup = e => { if (!dragEl.hasPointerCapture(e.pointerId)) return; dragEl._m = moved; if (moved && onEnd) onEnd(); moved = false; };
    };
    drag(fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });

    hdr.onpointerdown = e => {
      if (e.button || e.target === closeBtn || closeBtn.contains(e.target)) return;
      hdr.setPointerCapture(e.pointerId);
      const r = pn.getBoundingClientRect(); hdr._ox = e.clientX - r.left; hdr._oy = e.clientY - r.top; hdr._m = false;
    };
    hdr.onpointermove = e => { if (!hdr.hasPointerCapture(e.pointerId)) return; hdr._m = true; pn.style.left = clamp(e.clientX - (hdr._ox ?? 0), 0, innerWidth - pn.offsetWidth) + 'px'; pn.style.top = clamp(e.clientY - (hdr._oy ?? 0), 0, innerHeight - pn.offsetHeight) + 'px'; pn.style.right = pn.style.bottom = 'auto'; };
    hdr.onpointerup = e => { if (!hdr.hasPointerCapture(e.pointerId)) return; if (hdr._m) { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); } };

    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }
    if (panelOpen) openP(true);
  };

  const openP = instant => {
    if (panelOpen && !instant) return;
    panelOpen = true; cfg.open = true; saveLazy();

    if (!cfg.px && els.fab?.style.display !== 'none') {
      const r = els.fab.getBoundingClientRect();
      if (r.width > 0) {
        Object.assign(els.pn.style, {
          left: clamp(r.right - 256 + 24, 0, innerWidth - 256) + 'px',
          top: clamp(r.top - 6, 0, innerHeight - 180) + 'px',
          right: 'auto', bottom: 'auto'
        });
        cfg.px = els.pn.style.left; cfg.py = els.pn.style.top;
      }
    }

    els.fab.style.display = 'none'; els.pn.classList.add('open');
    _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
    _prevBufRound = -999; _prevBarPct = -1;
    _sparkLastHead = -1; _sparkLastLen = -1;
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

  /* ── 메인 루프 시작 ── */
  const loop = () => { tick(); setTimeout(loop, document.hidden ? 5000 : panelOpen ? 1000 : 3000); };

  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); startObserver(); loop();
  };

  /* ── SPA 네비게이션 ── */
  let lastPath = location.pathname + location.search;
  let _navDebounce = 0;
  const onNav = () => {
    clearTimeout(_navDebounce);
    _navDebounce = setTimeout(() => {
      const cur = location.pathname + location.search;
      if (cur === lastPath) return;
      lastPath = cur;
      warmupEnd = performance.now() + WARMUP_MS;
      lastSeek = 0; gear = R_NORM; stallCount = 0; _scanRetry = 0;
      stopRVFC(); setVid(null); resetDropRate();
      _isCurrentlyLive = false; _liveConfirmedOnce = false; _liveFalseCount = 0;
      _ytLiveTs = 0; _ytPlayerTs = 0;
      setTimeout(scan, 500); setTimeout(scan, 1500);
    }, 100);
  };

  if ('navigation' in window) {
    try { navigation.addEventListener('navigatesuccess', onNav); }
    catch {
      for (const m of ['pushState', 'replaceState']) { const o = history[m]; history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; }; }
      window.addEventListener('popstate', onNav);
    }
  } else {
    for (const m of ['pushState', 'replaceState']) { const o = history[m]; history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; }; }
    window.addEventListener('popstate', onNav);
  }

  /* ── 단축키 ── */
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.code !== 'KeyD' || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const t = document.activeElement?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault(); enabled = !enabled; cfg.enabled = enabled; saveLazy();
    if (els.tog) els.tog.classList.toggle('on', enabled);
  });

  /* ── 탭·풀스크린 ── */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { warmupEnd = performance.now() + WARMUP_MS; lastSeek = 0; } });
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
    if (!els.pn) return;
    const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    if (document.fullscreenElement) { Object.assign(els.pn.style, def); Object.assign(els.fab.style, def); }
    else {
      Object.assign(els.pn.style, cfg.px ? { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' } : def);
      Object.assign(els.fab.style, cfg.dx ? { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' } : def);
    }
  }));
  window.addEventListener('beforeunload', save);

  /* ── 디버그 ── */
  GM_registerMenuCommand('현재 상태', () => {
    const vid = getVid(), buf = vid ? (_rvfcActive && _lastFrameBuf >= 0 ? _lastFrameBuf : getBuf(vid)) : -1;
    const gl = gear > 1.05 ? (gear > 1.2 ? 'HIGH' : 'MED') : gear > 1 ? 'SOFT' : 'NORM';
    const src = vid ? (vid.currentSrc || vid.src || '') : '';
    const srcShort = src.length > 30 ? src.slice(0, 15) + '…' + src.slice(-15) : (src || '(empty)');
    const dur = vid ? vid.duration : -1;
    const txt = `[${PLATFORM}] t=${target}s | buf=${buf < 0 ? '-' : buf.toFixed(3) + 's'} | ${gl} | ${enabled ? 'ON' : 'OFF'} | live=${vid ? isLive(vid) : false} | drop=${(_dropRate * 100).toFixed(1)}% | dec=${_decoderStressed ? 'STRESS' : 'ok'} | rvfc=${_rvfcActive ? 'ON' : 'OFF'} | rs=${vid?.readyState ?? -1} | dur=${dur === Infinity ? '∞' : dur?.toFixed(1)} | src=${srcShort}`;
    const t = el('div', { textContent: txt, style: { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(12,14,20,.92)', backdropFilter: 'blur(12px)', color: '#f0f0f0', padding: '10px 24px', borderRadius: '12px', fontSize: '11px', fontFamily: 'monospace', transition: 'opacity .4s', border: '1px solid rgba(255,255,255,.06)', boxShadow: '0 8px 32px rgba(0,0,0,.5)', maxWidth: '94vw', wordBreak: 'break-all' } });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 6000);
  });

  /* ── 초기화 ── */
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
