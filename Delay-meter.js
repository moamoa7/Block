// ==UserScript==
// @name         딜레이 자동 제어
// @namespace    https://github.com/moamoa7
// @version      14.3.0
// @description  라이브 방송의 딜레이를 자동 감지·제어 (외부 배속 방어, 채널별 설정, 연속 조건 필터 추가)
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

  /* ================================================================
   *  §1. 플랫폼 감지 · 상수
   * ================================================================ */

  const HOST = location.hostname.replace(/^www\./, '');
  const PLATFORM = HOST.includes('youtube') ? 'youtube'
    : HOST.includes('chzzk') ? 'chzzk'
    : HOST.includes('sooplive') ? 'soop'
    : HOST.includes('twitch') ? 'twitch' : 'default';
  const IS_YOUTUBE = PLATFORM === 'youtube';
  const PLATFORM_LABEL = { youtube: 'YouTube', chzzk: 'CHZZK', soop: 'SOOP', twitch: 'Twitch', default: HOST }[PLATFORM];

  const PLATFORM_DEFAULTS = {
    youtube: { target: 10, min: 2,   max: 30, barMax: 35, panic: 40 },
    chzzk:   { target: 2,  min: 0.5, max: 10, barMax: 15, panic: 15 },
    soop:    { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
    twitch:  { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
    default: { target: 3,  min: 1,   max: 10, barMax: 15, panic: 15 },
  };
  const PD = PLATFORM_DEFAULTS[PLATFORM] || PLATFORM_DEFAULTS.default;
  const { target: DEF_TARGET, min: MIN_TARGET, max: MAX_TARGET, barMax: BAR_MAX, panic: PANIC } = PD;

  /* 제어 상수 */
  const SEEK_CD = 10000;
  const HYST = 0.3;
  const STALL_WINDOW = 30000;
  const STALL_COOLDOWN = 8000;
  const WARMUP_MS = 4000;
  const CONSECUTIVE_REQUIRED = 3;

  /* 기어 상수 */
  const R_NORM = 1.00;
  const R_SOFT = 1.02;
  const R_MED  = 1.10;
  const R_HIGH = 1.50;

  const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  /* ================================================================
   *  §2. 유틸리티
   * ================================================================ */

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  const isHlsSrc = src => /\.m3u8($|\?)/i.test(src);

  const getBuf = vid => {
    try { const b = vid.buffered; if (!b.length) return -1; return b.end(b.length - 1) - vid.currentTime; }
    catch { return -1; }
  };

  /* 색상 계산 (캐시 포함) */
  const ColorUtil = (() => {
    let _key = -999, _cache = '', _lastHex = '', _lastRgb = '';
    return {
      of(diff) {
        const key = Math.round(clamp(diff / (DEF_TARGET * 0.5), 0, 1) * 200);
        if (key === _key) return _cache;
        _key = key;
        const ratio = key / 200;
        let a0, a1, a2, b0, b1, b2, u;
        if (ratio <= 0.5) { a0=0x00;a1=0xE6;a2=0x96; b0=0xFF;b1=0xD0;b2=0x40; u=ratio*2; }
        else              { a0=0xFF;a1=0xD0;a2=0x40; b0=0xFF;b1=0x45;b2=0x55; u=(ratio-0.5)*2; }
        const r = Math.round(a0+(b0-a0)*u), g = Math.round(a1+(b1-a1)*u), bl = Math.round(a2+(b2-a2)*u);
        _cache = '#' + ((1<<24)|(r<<16)|(g<<8)|bl).toString(16).slice(1);
        return _cache;
      },
      toRgb(hex) {
        if (hex === _lastHex) return _lastRgb;
        _lastHex = hex;
        const n = parseInt(hex.slice(1), 16);
        _lastRgb = `${(n>>16)&255},${(n>>8)&255},${n&255}`;
        return _lastRgb;
      }
    };
  })();

  /* ================================================================
   *  §3. 설정 저장/로드 (Config)
   * ================================================================ */

  const STORE_KEY = 'dm_u14_' + HOST;
  const CHANNEL_STORE_KEY = 'dm_channel_targets_' + HOST;

  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { cfg = {}; }

  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };
  let _saveId = 0;
  const saveLazy = () => { clearTimeout(_saveId); _saveId = setTimeout(save, 400); };

  /* 채널별 목표 딜레이 */
  const ChannelConfig = {
    _getAll() {
      try { return JSON.parse(localStorage.getItem(CHANNEL_STORE_KEY)) || {}; }
      catch { return {}; }
    },
    _saveAll(targets) {
      try { localStorage.setItem(CHANNEL_STORE_KEY, JSON.stringify(targets)); }
      catch {}
    },
    load(chId) {
      if (!chId) return null;
      const v = this._getAll()[chId];
      return (v != null && v >= MIN_TARGET && v <= MAX_TARGET) ? v : null;
    },
    save(chId, val) {
      if (!chId) return;
      const t = this._getAll();
      t[chId] = val;
      this._saveAll(t);
    },
    remove(chId) {
      if (!chId) return;
      const t = this._getAll();
      delete t[chId];
      this._saveAll(t);
    }
  };

  /* 플랫폼별 채널 ID 추출 */
  const getChannelId = () => {
    try {
      const p = location.pathname;
      if (PLATFORM === 'youtube') {
        const m = p.match(/\/@([^\/]+)/) || p.match(/\/channel\/([^\/]+)/) || p.match(/\/c\/([^\/]+)/);
        return m ? m[1] : null;
      }
      if (PLATFORM === 'chzzk') {
        const m = p.match(/\/live\/([^\/]+)/) || p.match(/\/channel\/([^\/]+)/);
        return m ? m[1] : null;
      }
      if (PLATFORM === 'soop') {
        const m = p.match(/\/([^\/]+)\/[^\/]+$/);
        return m ? m[1] : null;
      }
      if (PLATFORM === 'twitch') {
        const m = p.match(/^\/([^\/]+)/);
        return (m && !['directory','videos','settings','subscriptions','inventory','drops','wallet'].includes(m[1])) ? m[1] : null;
      }
    } catch {}
    return null;
  };

  /* ================================================================
   *  §4. 상태 (State)
   * ================================================================ */

  /* --- 비디오 참조 --- */
  let _vidRef = null;
  const getVid = () => { if (_vidRef && !_vidRef.isConnected) _vidRef = null; return _vidRef; };
  const setVid = v => { _vidRef = v || null; };

  /* --- 전역 설정 상태 --- */
  let enabled = cfg.enabled ?? true;
  let currentChannelId = getChannelId();

  const resolveTarget = () => {
    const chT = ChannelConfig.load(currentChannelId);
    if (chT != null) return chT;
    if (cfg._platform === PLATFORM && cfg._lastDef === DEF_TARGET && cfg.target != null) return cfg.target;
    return DEF_TARGET;
  };

  let target = resolveTarget();
  if (cfg._platform !== PLATFORM || cfg._lastDef !== DEF_TARGET) {
    Object.assign(cfg, { _platform: PLATFORM, _lastDef: DEF_TARGET, target });
    saveLazy();
  }

  let panelOpen = cfg.open ?? false;

  /* --- 제어 상태 --- */
  const control = {
    gear: R_NORM,
    intendedRate: R_NORM,
    lastSeek: 0,
    warmupEnd: 0,
    stallCount: 0,
    lastStallTime: 0,
    /* 연속 조건 필터 */
    consUp: 0,
    consDown: 0,
    pendingGear: R_NORM,
    /* 외부 배속 방어 */
    isSettingRate: false,
    rateHandler: null,
  };

  /* --- 라이브 판정 상태 --- */
  const live = {
    isCurrent: false,
    confirmedOnce: false,
    falseCount: 0,
  };

  /* --- 프레임 품질 상태 --- */
  const quality = {
    prevDropped: 0,
    prevTotal: 0,
    dropRate: 0,
    decoderStressed: false,
    update(vid) {
      if (typeof vid.getVideoPlaybackQuality !== 'function') return;
      const q = vid.getVideoPlaybackQuality();
      const dD = q.droppedVideoFrames - this.prevDropped;
      const dT = q.totalVideoFrames - this.prevTotal;
      this.prevDropped = q.droppedVideoFrames;
      this.prevTotal = q.totalVideoFrames;
      if (dT >= 5) this.dropRate = dD / dT;
    },
    reset() {
      this.prevDropped = this.prevTotal = 0;
      this.dropRate = 0;
      this.decoderStressed = false;
    }
  };

  /* ================================================================
   *  §5. 히스토리 링 버퍼
   * ================================================================ */

  const History = (() => {
    const SIZE = 60;
    const data = new Float32Array(SIZE);
    let head = 0, len = 0, max = 0;
    return {
      get length() { return len; },
      get max() { return max; },
      get head() { return head; },
      get SIZE() { return SIZE; },
      data,
      push(v) {
        const wasFull = len === SIZE;
        const oldVal = data[head];
        data[head] = v;
        head = (head + 1) % SIZE;
        if (len < SIZE) len++;
        if (v >= max) { max = v; }
        else if (wasFull && (oldVal >= max || (head & 7) === 0)) {
          max = 0;
          for (let i = 0; i < len; i++) if (data[i] > max) max = data[i];
        }
      },
      reset() { head = 0; len = 0; max = 0; },
      at(i) { return data[(head - len + i + SIZE) % SIZE]; },
    };
  })();

  /* 버퍼 추세 (선형 회귀, 2초 캐시) */
  const Trend = (() => {
    let value = 0, ts = 0;
    return {
      get() {
        const now = performance.now();
        if (now - ts < 2000) return value;
        ts = now;
        const step = rvfc.active ? Math.max(1, Math.floor(History.length / 10)) : 1;
        const maxN = Math.min(History.length, 10 * step);
        if (maxN < 3 * step) { value = 0; return 0; }
        let sX = 0, sY = 0, sXY = 0, sX2 = 0, count = 0;
        for (let i = 0; i < maxN; i += step) {
          const y = History.at(History.length - maxN + i);
          sX += count; sY += y; sXY += count * y; sX2 += count * count;
          count++;
        }
        value = count > 1 ? (count * sXY - sX * sY) / (count * sX2 - sX * sX) : 0;
        return value;
      },
      reset() { value = 0; ts = 0; }
    };
  })();

  /* ================================================================
   *  §6. rVFC (requestVideoFrameCallback)
   * ================================================================ */

  const rvfc = {
    active: false,
    vid: null,
    lastBuf: -1,

    start(vid) {
      if (!HAS_RVFC) return false;
      if (this.vid === vid && this.active) return true;
      this.active = true;
      this.vid = vid;
      const self = this;
      const onFrame = (now, metadata) => {
        if (!self.active || getVid() !== vid || self.vid !== vid) {
          self.active = false; self.vid = null; return;
        }
        try {
          const b = vid.buffered;
          if (b.length > 0) {
            const buf = b.end(b.length - 1) - metadata.mediaTime;
            self.lastBuf = buf;
            if (!vid.paused && buf >= 0) History.push(buf);
          }
        } catch {}
        if (metadata.processingDuration != null) {
          quality.decoderStressed = metadata.processingDuration > 0.033;
        }
        vid.requestVideoFrameCallback(onFrame);
      };
      vid.requestVideoFrameCallback(onFrame);
      return true;
    },

    stop() {
      this.active = false;
      this.vid = null;
      this.lastBuf = -1;
      quality.decoderStressed = false;
    }
  };

  /* ================================================================
   *  §7. 라이브 판정
   * ================================================================ */

  const LiveDetect = (() => {
    const cache = new WeakMap();
    const tracker = new WeakMap();
    let ytPlayerEl = null, ytPlayerTs = 0, ytResult = false, ytTs = 0;

    const getYTPlayer = () => {
      const now = performance.now();
      if (ytPlayerEl && now - ytPlayerTs < 5000) return ytPlayerEl;
      ytPlayerEl = document.getElementById('movie_player');
      ytPlayerTs = now;
      return ytPlayerEl;
    };

    const youtube = vid => {
      if (vid.duration === Infinity || vid.duration >= 1e6) return true;
      if (location.pathname.includes('/live')) return true;
      const now = performance.now();
      const ttl = ytResult ? 3000 : 1000;
      if (now - ytTs < ttl) return ytResult;
      let result = false;
      const p = getYTPlayer();
      if (p) {
        try {
          if (typeof p.getVideoData === 'function') { const d = p.getVideoData(); if (d?.isLive) result = true; }
          if (!result && typeof p.getPlayerResponse === 'function') {
            const r = p.getPlayerResponse();
            if (r?.videoDetails?.isLiveContent && r?.videoDetails?.isLive) result = true;
          }
        } catch {}
      }
      if (!result && document.querySelector('.ytp-live-badge[disabled],.ytp-live,ytd-badge-supported-renderer .badge-style-type-live-now')) {
        result = true;
      }
      ytResult = result; ytTs = now;
      return result;
    };

    const generic = vid => {
      if (vid.duration === Infinity || vid.duration >= 1e6) return true;
      const cached = cache.get(vid);
      if (cached && performance.now() - cached.ts < 3000) return cached.v;
      let v = false;
      const src = vid.currentSrc || vid.src || '';
      if (isHlsSrc(src) && vid.buffered.length > 0) v = true;
      if (!v) {
        try {
          const s = vid.seekable;
          if (s.length > 0) {
            const start = s.start(0), end = s.end(s.length - 1), d = vid.duration;
            if (start > 10) { v = true; }
            else {
              let tr = tracker.get(vid);
              if (!tr) { tr = { end, dur: d, ts: performance.now(), count: 0 }; tracker.set(vid, tr); }
              else {
                if (end > tr.end + 0.5 || d > tr.dur + 0.5) { tr.count++; tr.end = end; tr.dur = d; tr.ts = performance.now(); }
                if (tr.count >= 2) v = true;
              }
            }
            if (!v && (end - start > 20)) {
              const b = vid.buffered;
              if (b.length && Math.abs(b.end(b.length - 1) - end) < 120) v = true;
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
      cache.set(vid, { v, ts: performance.now() });
      return v;
    };

    return {
      check: vid => vid ? (IS_YOUTUBE ? youtube(vid) : generic(vid)) : false,
      resetYT() { ytTs = 0; ytPlayerTs = 0; },
      clearCache: vid => { if (vid) cache.delete(vid); },
    };
  })();

  /* ================================================================
   *  §8. 비디오 후보 판정 · 연결
   * ================================================================ */

  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:') || src === '') return true;
    if (IS_YOUTUBE) { try { if (v.buffered.length > 0) return true; } catch {} }
    if (isHlsSrc(src)) return true;
    try { if (v.buffered.length && LiveDetect.check(v)) return true; } catch {}
    return false;
  };

  /* 외부 배속 리셋 방어 설치 */
  const installRateProtection = vid => {
    if (!vid) return;
    if (control.rateHandler) vid.removeEventListener('ratechange', control.rateHandler, true);
    control.rateHandler = () => {
      if (control.isSettingRate || !vid || !vid.isConnected) return;
      if (enabled && live.isCurrent && Math.abs(vid.playbackRate - control.intendedRate) > 0.005) {
        control.isSettingRate = true;
        vid.playbackRate = control.intendedRate;
        try { vid.preservesPitch = true; } catch {}
        setTimeout(() => { control.isSettingRate = false; }, 50);
      }
    };
    vid.addEventListener('ratechange', control.rateHandler, true);
  };

  const safeRate = (vid, r) => {
    if (!vid || vid.playbackRate === r) return;
    control.isSettingRate = true;
    control.intendedRate = r;
    vid.playbackRate = r;
    try { vid.preservesPitch = true; } catch {}
    setTimeout(() => { control.isSettingRate = false; }, 50);
  };

  /* 비디오 감지·연결 */
  const seen = new WeakSet();
  let mo = null, _scanRetry = 0;
  const stopObserver = () => { if (mo) { mo.disconnect(); mo = null; } };

  const resetControlState = () => {
    control.gear = R_NORM;
    control.intendedRate = R_NORM;
    control.lastSeek = 0;
    control.warmupEnd = performance.now() + WARMUP_MS;
    control.stallCount = 0;
    control.consUp = 0;
    control.consDown = 0;
    control.pendingGear = R_NORM;
    History.reset();
    Trend.reset();
    quality.reset();
    live.isCurrent = false;
    live.confirmedOnce = false;
    live.falseCount = 0;
  };

  const attach = v => {
    if (getVid() === v) return;
    if (!isCandidate(v)) return;
    LiveDetect.clearCache(v);
    rvfc.stop();
    stopObserver();
    setVid(v);
    resetControlState();
    installRateProtection(v);
    if (!seen.has(v)) {
      seen.add(v);
      v.addEventListener('emptied', () => { if (getVid() === v) attach(v); });
      v.addEventListener('loadeddata', () => { if (!getVid() && isCandidate(v)) attach(v); });
      const onStall = () => {
        const now = performance.now();
        if (now - control.lastStallTime > STALL_WINDOW) control.stallCount = 0;
        control.stallCount++; control.lastStallTime = now;
        if (getVid() === v) { control.gear = R_NORM; control.intendedRate = R_NORM; safeRate(v, R_NORM); }
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

  /* ================================================================
   *  §9. 제어 엔진 (기어 결정 · 적용)
   * ================================================================ */

  const computeDesiredGear = (buf, trend) => {
    const ex = buf - target;
    let desired;
    if (ex > target * 0.8)       desired = R_HIGH;
    else if (ex > target * 0.4)  desired = R_MED;
    else if (ex > HYST)          desired = (trend < -0.15) ? R_NORM : R_SOFT;
    else if (ex < -HYST)         desired = R_NORM;
    else                         desired = control.gear;

    if (desired > R_SOFT && (quality.dropRate > 0.05 || quality.decoderStressed)) {
      desired = desired === R_HIGH ? R_MED : R_SOFT;
    }
    return desired;
  };

  const applyGearWithFilter = (vid, desired) => {
    if (desired > control.gear) {
      if (desired === control.pendingGear) control.consUp++;
      else { control.pendingGear = desired; control.consUp = 1; }
      control.consDown = 0;
      if (control.consUp >= CONSECUTIVE_REQUIRED) { control.gear = desired; control.consUp = 0; }
    } else if (desired < control.gear) {
      if (desired === control.pendingGear) control.consDown++;
      else { control.pendingGear = desired; control.consDown = 1; }
      control.consUp = 0;
      if (control.consDown >= CONSECUTIVE_REQUIRED) { control.gear = desired; control.consDown = 0; }
    } else {
      control.consUp = 0;
      control.consDown = 0;
      control.pendingGear = desired;
    }
    safeRate(vid, control.gear);
  };

  const doSeek = vid => {
    try {
      const s = vid.seekable;
      if (s.length) {
        vid.currentTime = Math.max(s.start(s.length - 1), s.end(s.length - 1) - target - 1);
      } else {
        const b = vid.buffered;
        if (!b.length) return;
        const i = b.length - 1;
        vid.currentTime = Math.max(b.start(i), b.end(i) - target - 1);
      }
      control.lastSeek = performance.now();
    } catch {}
  };

  /* ================================================================
   *  §10. 스파크라인 차트
   * ================================================================ */

  const Spark = (() => {
    const W = 208, H = 32;
    let ctx = null, lastHead = -1, lastLen = -1;

    return {
      init(cvs) {
        const dpr = devicePixelRatio || 1;
        cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
        cvs.width = W * dpr; cvs.height = H * dpr;
        ctx = cvs.getContext('2d');
      },
      draw(color) {
        if (!ctx || History.length < 2) return;
        if (History.head === lastHead && History.length === lastLen) return;
        lastHead = History.head; lastLen = History.length;

        const dpr = devicePixelRatio || 1;
        ctx.clearRect(0, 0, W * dpr, H * dpr);
        ctx.save(); ctx.scale(dpr, dpr);

        const mx = Math.max(target + 2, History.max);
        const pad = 2, yR = H - pad * 2, xS = W / (History.SIZE - 1);
        const tY = H - pad - (target / mx) * yR;

        ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
        ctx.moveTo(0, tY); ctx.lineTo(W, tY); ctx.stroke(); ctx.setLineDash([]);

        const rgb = ColorUtil.toRgb(color);
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, `rgba(${rgb},.20)`); grad.addColorStop(1, `rgba(${rgb},.02)`);

        const drawPath = () => {
          ctx.beginPath();
          for (let i = 0; i < History.length; i++) {
            const v = History.at(i);
            const x = i * xS, y = H - pad - (v / mx) * yR;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
        };

        drawPath();
        ctx.lineTo((History.length - 1) * xS, H); ctx.lineTo(0, H); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();

        drawPath();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

        const lV = History.at(History.length - 1);
        const lx = (History.length - 1) * xS;
        const ly = H - pad - (lV / mx) * yR;
        const gw = ctx.createRadialGradient(lx, ly, 0, lx, ly, 6);
        gw.addColorStop(0, `rgba(${rgb},.6)`); gw.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = gw; ctx.fillRect(lx - 6, ly - 6, 12, 12);
        ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        ctx.restore();
      },
      invalidate() { lastHead = -1; lastLen = -1; }
    };
  })();

  /* ================================================================
   *  §11. 메인 루프 (tick)
   * ================================================================ */

  let pendingRender = false, lastBuf = -1;
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; Renderer.update(lastBuf, getVid()); });
  };

  const tick = () => {
    const vid = getVid();

    /* 비디오 없음 */
    if (!vid) {
      scan(); rvfc.stop(); startObserver();
      lastBuf = -1; live.isCurrent = false;
      scheduleRender(); return;
    }

    /* 준비 안 됨 */
    if (!isCandidate(vid) || vid.readyState < 3) {
      lastBuf = -1;
      if (!live.confirmedOnce) live.isCurrent = false;
      scheduleRender(); return;
    }

    /* 라이브 판정 */
    const isLiveNow = LiveDetect.check(vid);
    if (!isLiveNow) {
      if (IS_YOUTUBE) _scanRetry = 0;
      if (live.confirmedOnce) {
        live.falseCount++;
        if (live.falseCount < 3) { scheduleRender(); return; }
      }
      rvfc.stop(); lastBuf = -1;
      live.isCurrent = false; live.confirmedOnce = false; live.falseCount = 0;
      scheduleRender(); return;
    }
    live.isCurrent = true; live.confirmedOnce = true; live.falseCount = 0;

    /* 버퍼 측정 */
    const rvfcRunning = rvfc.start(vid);
    let buf;
    if (rvfcRunning && rvfc.lastBuf >= 0) buf = rvfc.lastBuf;
    else buf = getBuf(vid);
    lastBuf = buf;

    if (!rvfcRunning && !vid.paused && buf >= 0) History.push(buf);
    quality.update(vid);
    scheduleRender();

    /* 제어 */
    if (vid.paused) return;
    if (!enabled) { safeRate(vid, R_NORM); control.gear = R_NORM; return; }

    const now = performance.now();
    if (now < control.warmupEnd) return;
    if (buf > PANIC && now - control.lastSeek > SEEK_CD) { doSeek(vid); return; }
    if (now - control.lastStallTime < STALL_COOLDOWN) {
      control.gear = R_NORM; control.intendedRate = R_NORM;
      safeRate(vid, R_NORM); return;
    }

    const trend = Trend.get();
    const desired = computeDesiredGear(buf, trend);
    applyGearWithFilter(vid, desired);
  };

  /* ================================================================
   *  §12. 렌더러 (UI 갱신)
   * ================================================================ */

  let els = {};
  let _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
  let _prevBufRound = -999, _prevBarPct = -1;

  const Renderer = {
    update(buf, vid) {
      if (!els.root) return;
      if (!live.isCurrent || !vid) {
        if (els.root.style.display !== 'none') els.root.style.display = 'none';
        return;
      }
      if (els.root.style.display === 'none') els.root.style.display = 'block';

      const sec = buf < 0 ? 0 : buf, diff = sec - target, c = ColorUtil.of(diff);
      const speeding = vid && vid.playbackRate > 1;

      /* FAB만 표시 중 */
      if (!panelOpen) {
        if (!els.fab) return;
        const fc = !enabled ? '#555' : speeding ? '#6C9CFF' : c;
        if (fc !== _prev.dot) { _prev.dot = fc; els.fab.style.setProperty('--ac', fc); }
        return;
      }

      /* 패널 표시 중 */
      const bufRound = buf < 0 ? -1 : Math.round(sec * 10);
      if (bufRound !== _prevBufRound) {
        _prevBufRound = bufRound;
        els.val.textContent = buf < 0 ? '—' : (bufRound / 10).toFixed(1);
      }
      if (c !== _prev.clr) { els.pn.style.setProperty('--ac', c); _prev.clr = c; }

      const barPct = Math.round(clamp(sec / BAR_MAX * 100, 0, 100) * 10);
      if (barPct !== _prevBarPct) { _prevBarPct = barPct; els.bar.style.width = (barPct / 10).toFixed(1) + '%'; }

      if (els.chLabel) {
        const chText = currentChannelId || '';
        if (els.chLabel.textContent !== chText) els.chLabel.textContent = chText;
      }

      const now = performance.now(), inRange = sec <= target && sec >= Math.max(0, target - 0.5);
      let bTxt, bCls;
      if (!enabled)                                          { bTxt = 'OFF';      bCls = 'dm-b dm-off'; }
      else if (buf < 0)                                      { bTxt = '…';        bCls = 'dm-b dm-off'; }
      else if (now - control.lastStallTime < STALL_COOLDOWN) { bTxt = '⏸ 대기';   bCls = 'dm-b dm-off'; }
      else if (quality.dropRate > 0.05)                      { bTxt = '⚠ 드롭';   bCls = 'dm-b dm-off'; }
      else if (speeding)                                     { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
      else if (inRange)                                      { bTxt = '✓ 안정';   bCls = 'dm-b dm-ok'; }
      else                                                   { bTxt = '→ 추적';   bCls = 'dm-b dm-acc'; }
      if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
      if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }

      Spark.draw(c);
    },

    invalidate() {
      _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
      _prevBufRound = -999;
      _prevBarPct = -1;
      Spark.invalidate();
    }
  };

  /* ================================================================
   *  §13. DOM 구축 · 스타일
   * ================================================================ */

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

  const injectStyles = () => {
    GM_addStyle(`
#dm-root{--ac:#00E696;--bg:rgba(12,14,20,.92);--bg2:rgba(255,255,255,.04);--bg3:rgba(255,255,255,.07);--border:rgba(255,255,255,.06);--t1:#f0f0f0;--t2:rgba(255,255,255,.45);--rad:16px;font:12px/1.5 'SF Pro Text',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--t1)}
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:40px;height:40px;border-radius:50%;background:var(--bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1.5px solid var(--ac);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s,transform .15s;contain:strict;box-shadow:0 0 12px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.04);will-change:transform,box-shadow}
#dm-fab:hover{transform:scale(1.08)}#dm-fab:active{transform:scale(.95)}
.dm-dot{width:10px;height:10px;border-radius:50%;background:var(--ac);transition:background .4s;box-shadow:0 0 8px var(--ac)}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 0 var(--ac)}50%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 6px transparent}}
#dm-fab{animation:dm-pulse 2.5s ease-in-out infinite}
#dm-pn{position:fixed;bottom:20px;right:20px;z-index:10000;background:var(--bg);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--border);border-radius:var(--rad);padding:0;color:var(--t1);width:256px;box-shadow:0 12px 48px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03);user-select:none;opacity:0;transform:translateY(8px) scale(.97);pointer-events:none;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1);contain:content;will-change:opacity,transform,visibility}
#dm-pn.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;visibility:visible}
#dm-pn:not(.open){visibility:hidden;transition:opacity .25s,transform .25s,visibility 0s .25s}
.dm-hdr{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;cursor:grab}
.dm-logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--ac),rgba(0,230,150,.5));display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:700;flex-shrink:0}
.dm-title{font-weight:600;font-size:13px;letter-spacing:-.01em}
.dm-host{font-size:9px;color:var(--t2);max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-ch{font-size:8px;color:rgba(255,255,255,.3);max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.dm-ch-row{display:flex;align-items:center;justify-content:space-between;padding:0 16px;margin-bottom:8px}
.dm-ch-label{font-size:9px;color:var(--t2)}
.dm-ch-btn{font-size:9px;padding:2px 8px;border-radius:6px;background:var(--bg3);color:var(--t2);cursor:pointer;border:1px solid var(--border);transition:all .15s}
.dm-ch-btn:hover{background:rgba(255,255,255,.1);color:var(--t1)}
.dm-ft{display:flex;align-items:center;gap:10px;padding:10px 16px 14px;border-top:1px solid var(--border)}
.dm-tog{position:relative;width:38px;height:20px;border-radius:10px;background:rgba(255,255,255,.08);cursor:pointer;transition:background .25s;flex-shrink:0}
.dm-tog.on{background:var(--ac)}
.dm-tog::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .25s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dm-tog.on::after{transform:translateX(18px)}
.dm-ver{margin-left:auto;font-size:9px;color:rgba(255,255,255,.15)}
.dm-key{font-size:9px;color:rgba(255,255,255,.15);padding:1px 6px;border:1px solid rgba(255,255,255,.06);border-radius:4px}
`);
  };

  const build = () => {
    if (document.getElementById('dm-root')) return;
    injectStyles();

    const root = el('div', { id: 'dm-root', style: { display: 'none' } });
    const fab = el('div', { id: 'dm-fab' }, [el('div', { className: 'dm-dot' })]);
    const pn = el('div', { id: 'dm-pn' });

    /* 헤더 */
    const closeSvg = svgEl('svg', { width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none' });
    closeSvg.appendChild(svgEl('path', { d: 'M2.5 2.5l7 7', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }));
    closeSvg.appendChild(svgEl('path', { d: 'M9.5 2.5l-7 7', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }));
    const closeBtn = el('div', { className: 'dm-close' }, [closeSvg]);
    const chLabel = el('span', { className: 'dm-ch', title: '', textContent: currentChannelId || '' });
    const hdr = el('div', { className: 'dm-hdr' }, [
      el('div', { className: 'dm-logo', textContent: 'D' }),
      el('span', { className: 'dm-title', textContent: '딜레이 미터' }),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px' } }, [
        el('span', { className: 'dm-host', title: HOST, textContent: PLATFORM_LABEL }),
        chLabel
      ]),
      closeBtn
    ]);

    /* 딜레이 표시 */
    const valSpan = el('span', { className: 'dm-val', textContent: '—' });
    const badgeSpan = el('span', { className: 'dm-b dm-off', textContent: 'OFF' });
    const stat = el('div', { className: 'dm-stat' }, [
      valSpan, el('span', { className: 'dm-unit', textContent: '초' }), badgeSpan
    ]);

    /* 바 · 스파크라인 */
    const barDiv = el('div', { className: 'dm-bar' });
    const barWrap = el('div', { className: 'dm-barwrap' }, [barDiv]);
    const sparkCvs = el('canvas', { className: 'dm-spark', width: '208', height: '32' });

    /* 슬라이더 */
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

    /* 채널별 저장 행 */
    const chSaveBtn = el('span', { className: 'dm-ch-btn', textContent: '채널 저장' });
    const chResetBtn = el('span', { className: 'dm-ch-btn', textContent: '리셋' });
    const chStatusLabel = el('span', { className: 'dm-ch-label', textContent: '' });
    const chRow = el('div', { className: 'dm-ch-row' }, [chStatusLabel, chSaveBtn, chResetBtn]);

    const updateChStatus = () => {
      if (!currentChannelId) {
        chStatusLabel.textContent = '채널 감지 안됨';
        chSaveBtn.style.display = 'none'; chResetBtn.style.display = 'none';
        return;
      }
      const saved = ChannelConfig.load(currentChannelId);
      if (saved != null) {
        chStatusLabel.textContent = `채널: ${saved.toFixed(1)}s`;
        chResetBtn.style.display = '';
      } else {
        chStatusLabel.textContent = '채널: 기본값';
        chResetBtn.style.display = 'none';
      }
      chSaveBtn.style.display = '';
    };

    chSaveBtn.onclick = () => {
      if (!currentChannelId) return;
      ChannelConfig.save(currentChannelId, target);
      updateChStatus();
    };
    chResetBtn.onclick = () => {
      if (!currentChannelId) return;
      ChannelConfig.remove(currentChannelId);
      target = (cfg._platform === PLATFORM && cfg._lastDef === DEF_TARGET && cfg.target != null) ? cfg.target : DEF_TARGET;
      slInput.value = target; svSpan.textContent = target.toFixed(1) + 's';
      updateChStatus();
    };
    updateChStatus();

    /* 하단 푸터 */
    const togDiv = el('div', { className: 'dm-tog' + (enabled ? ' on' : '') });
    const ft = el('div', { className: 'dm-ft' }, [
      togDiv,
      el('span', { className: 'dm-ver', textContent: 'v14.3.0' }),
      el('span', { className: 'dm-key', textContent: 'Alt+D' })
    ]);

    /* 조립 */
    pn.append(hdr, stat, barWrap, sparkCvs, slWrap, chRow, ft);
    root.append(fab, pn);
    document.body.appendChild(root);
    Spark.init(sparkCvs);

    els = { root, fab, pn, val: valSpan, bar: barDiv, badge: badgeSpan, tog: togDiv, sl: slInput, sv: svSpan, hdr, x: closeBtn, chLabel, chRow, chSaveBtn, chResetBtn, chStatusLabel };
    els._updateChStatus = updateChStatus;

    /* ── 이벤트 바인딩 ── */
    fab.onclick = () => { if (!fab._m) openP(); };
    closeBtn.onclick = e => { e.stopPropagation(); closeP(); };
    togDiv.onclick = () => {
      enabled = !enabled; cfg.enabled = enabled; saveLazy();
      togDiv.classList.toggle('on', enabled);
    };

    slInput.oninput = () => {
      target = parseFloat(slInput.value);
      svSpan.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
      control.consUp = 0; control.consDown = 0;
    };
    slInput.ondblclick = () => {
      target = DEF_TARGET; slInput.value = target;
      svSpan.textContent = target.toFixed(1) + 's';
      cfg.target = target; saveLazy();
      control.consUp = 0; control.consDown = 0;
    };

    /* FAB 드래그 */
    const makeDrag = (dragEl, onEnd) => {
      let ox, oy, moved = false;
      dragEl.onpointerdown = e => { if (e.button) return; moved = false; dragEl._m = false; dragEl.setPointerCapture(e.pointerId); const r = dragEl.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; };
      dragEl.onpointermove = e => { if (!dragEl.hasPointerCapture(e.pointerId)) return; moved = true; dragEl.style.left = clamp(e.clientX - ox, 0, innerWidth - dragEl.offsetWidth) + 'px'; dragEl.style.top = clamp(e.clientY - oy, 0, innerHeight - dragEl.offsetHeight) + 'px'; dragEl.style.right = dragEl.style.bottom = 'auto'; };
      dragEl.onpointerup = e => { if (!dragEl.hasPointerCapture(e.pointerId)) return; dragEl._m = moved; if (moved && onEnd) onEnd(); moved = false; };
    };
    makeDrag(fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });

    /* 패널 헤더 드래그 */
    hdr.onpointerdown = e => {
      if (e.button || e.target === closeBtn || closeBtn.contains(e.target)) return;
      hdr.setPointerCapture(e.pointerId);
      const r = pn.getBoundingClientRect(); hdr._ox = e.clientX - r.left; hdr._oy = e.clientY - r.top; hdr._m = false;
    };
    hdr.onpointermove = e => { if (!hdr.hasPointerCapture(e.pointerId)) return; hdr._m = true; pn.style.left = clamp(e.clientX - (hdr._ox ?? 0), 0, innerWidth - pn.offsetWidth) + 'px'; pn.style.top = clamp(e.clientY - (hdr._oy ?? 0), 0, innerHeight - pn.offsetHeight) + 'px'; pn.style.right = pn.style.bottom = 'auto'; };
    hdr.onpointerup = e => { if (!hdr.hasPointerCapture(e.pointerId)) return; if (hdr._m) { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); } };

    /* 저장된 위치 복원 */
    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }
    if (panelOpen) openP(true);
  };

  /* ================================================================
   *  §14. 패널 열기/닫기
   * ================================================================ */

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
    Renderer.invalidate();
    if (els._updateChStatus) els._updateChStatus();
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

  /* ================================================================
   *  §15. 초기화 · 메인 루프 시작
   * ================================================================ */

  const loop = () => { tick(); setTimeout(loop, document.hidden ? 5000 : panelOpen ? 1000 : 3000); };

  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); startObserver(); loop();
  };

  /* ================================================================
   *  §16. SPA 네비게이션 대응
   * ================================================================ */

  let lastPath = location.pathname + location.search;
  let _navDebounce = 0;

  const onNav = () => {
    clearTimeout(_navDebounce);
    _navDebounce = setTimeout(() => {
      const cur = location.pathname + location.search;
      if (cur === lastPath) return;
      lastPath = cur;

      control.warmupEnd = performance.now() + WARMUP_MS;
      control.lastSeek = 0; control.gear = R_NORM; control.intendedRate = R_NORM;
      control.stallCount = 0; control.consUp = 0; control.consDown = 0;
      control.pendingGear = R_NORM;
      _scanRetry = 0;
      rvfc.stop(); setVid(null); quality.reset();
      live.isCurrent = false; live.confirmedOnce = false; live.falseCount = 0;
      LiveDetect.resetYT();

      /* 채널 전환 처리 */
      const newCh = getChannelId();
      if (newCh !== currentChannelId) {
        currentChannelId = newCh;
        const chT = ChannelConfig.load(currentChannelId);
        if (chT != null) target = chT;
        if (els.sl) { els.sl.value = target; els.sv.textContent = target.toFixed(1) + 's'; }
        if (els.chLabel) els.chLabel.textContent = currentChannelId || '';
        if (els._updateChStatus) els._updateChStatus();
      }

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

  /* ================================================================
   *  §17. 글로벌 이벤트 (단축키, 탭, 풀스크린)
   * ================================================================ */

  /* 단축키: Alt+D */
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.code !== 'KeyD' || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const t = document.activeElement?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault(); enabled = !enabled; cfg.enabled = enabled; saveLazy();
    if (els.tog) els.tog.classList.toggle('on', enabled);
  });

  /* 탭 전환 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      control.warmupEnd = performance.now() + WARMUP_MS;
      control.lastSeek = 0;
      control.consUp = 0; control.consDown = 0;
    }
  });

  /* 풀스크린 */
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
    if (!els.pn) return;
    const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    if (document.fullscreenElement) {
      Object.assign(els.pn.style, def); Object.assign(els.fab.style, def);
    } else {
      Object.assign(els.pn.style, cfg.px ? { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' } : def);
      Object.assign(els.fab.style, cfg.dx ? { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' } : def);
    }
  }));

  /* 페이지 떠날 때 저장 */
  window.addEventListener('beforeunload', save);

  /* ================================================================
   *  §18. 디버그
   * ================================================================ */

  GM_registerMenuCommand('현재 상태', () => {
    const vid = getVid();
    const buf = vid ? (rvfc.active && rvfc.lastBuf >= 0 ? rvfc.lastBuf : getBuf(vid)) : -1;
    const gl = control.gear > 1.05 ? (control.gear > 1.2 ? 'HIGH' : 'MED') : control.gear > 1 ? 'SOFT' : 'NORM';
    const src = vid ? (vid.currentSrc || vid.src || '') : '';
    const srcShort = src.length > 30 ? src.slice(0, 15) + '…' + src.slice(-15) : (src || '(empty)');
    const dur = vid ? vid.duration : -1;
    const chId = currentChannelId || '(none)';
    const chT = ChannelConfig.load(currentChannelId);
    const txt = `[${PLATFORM}] t=${target}s | buf=${buf < 0 ? '-' : buf.toFixed(3) + 's'} | ${gl} | ${enabled ? 'ON' : 'OFF'} | live=${vid ? LiveDetect.check(vid) : false} | drop=${(quality.dropRate * 100).toFixed(1)}% | dec=${quality.decoderStressed ? 'STRESS' : 'ok'} | rvfc=${rvfc.active ? 'ON' : 'OFF'} | rs=${vid?.readyState ?? -1} | dur=${dur === Infinity ? '∞' : dur?.toFixed(1)} | ch=${chId} chT=${chT != null ? chT + 's' : 'def'} | cons↑=${control.consUp} ↓=${control.consDown} | rate=${control.intendedRate.toFixed(2)} | src=${srcShort}`;
    const toast = el('div', { textContent: txt, style: { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(12,14,20,.92)', backdropFilter: 'blur(12px)', color: '#f0f0f0', padding: '10px 24px', borderRadius: '12px', fontSize: '11px', fontFamily: 'monospace', transition: 'opacity .4s', border: '1px solid rgba(255,255,255,.06)', boxShadow: '0 8px 32px rgba(0,0,0,.5)', maxWidth: '94vw', wordBreak: 'break-all' } });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 6000);
  });

  /* ================================================================
   *  §19. 시작
   * ================================================================ */

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

})();
