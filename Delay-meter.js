// ==UserScript==
// @name         딜레이 자동 제어
// @namespace    https://github.com/moamoa7
// @version      15.4.0
// @description  라이브 방송의 딜레이를 자동 감지·제어 (경량화)
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
  const PLATFORM = [['youtube','youtube'],['chzzk','chzzk'],['sooplive','soop'],['twitch','twitch']]
    .find(([k]) => HOST.includes(k))?.[1] || 'default';
  const IS_YOUTUBE = PLATFORM === 'youtube';
  const PLATFORM_LABEL = { youtube: 'YouTube', chzzk: 'CHZZK', soop: 'SOOP', twitch: 'Twitch', default: HOST }[PLATFORM];

  const PLATFORM_DEFAULTS = {
    youtube: { target: 10, min: 2,   max: 30, barMax: 35 },
    chzzk:   { target: 2,  min: 0.5, max: 10, barMax: 15 },
    soop:    { target: 3,  min: 1,   max: 10, barMax: 15 },
    twitch:  { target: 3,  min: 1,   max: 10, barMax: 15 },
    default: { target: 3,  min: 1,   max: 10, barMax: 15 },
  };
  const PD = PLATFORM_DEFAULTS[PLATFORM] || PLATFORM_DEFAULTS.default;
  const { target: DEF_TARGET, min: MIN_TARGET, max: MAX_TARGET, barMax: BAR_MAX } = PD;

  /* 제어 상수 */
  const STALL_COOLDOWN = 8000;
  const WARMUP_MS = 4000;
  const GEAR_HOLD_MS = 3000;

  /* 기어 (3단계)
   * R_HIGH: 1.50 → 1.30 — 언더슈트 위험 감소, 히스테리시스 밴드까지
   * R_HIGH 유지를 허용하여 따라잡기 속도와 안정성의 균형점 확보 */
  const R_NORM = 1.00;
  const R_MED  = 1.10;
  const R_HIGH = 1.30;

  /* ================================================================
   *  §2. 유틸리티
   * ================================================================ */

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const isHlsSrc = src => /\.m3u8($|\?)/i.test(src);

  const getBuf = vid => {
    const b = vid.buffered;
    if (!b.length) return -1;
    return b.end(b.length - 1) - vid.currentTime;
  };

  /* 색상: 단일 캐시 */
  let _colorKey = -1, _colorVal = '';
  const getColor = diff => {
    const key = Math.round(clamp(diff / (DEF_TARGET * 0.5), 0, 1) * 100);
    if (key === _colorKey) return _colorVal;
    _colorKey = key;
    const ratio = key / 100;
    let r, g, bl;
    if (ratio <= 0.5) {
      const u = ratio * 2;
      r = Math.round(0x00 + 0xFF * u);
      g = Math.round(0xE6 + (0xD0 - 0xE6) * u);
      bl = Math.round(0x96 + (0x40 - 0x96) * u);
    } else {
      const u = (ratio - 0.5) * 2;
      r = 0xFF;
      g = Math.round(0xD0 + (0x45 - 0xD0) * u);
      bl = Math.round(0x40 + (0x55 - 0x40) * u);
    }
    _colorVal = '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
    return _colorVal;
  };

  /* ================================================================
   *  §3. 설정 저장/로드
   * ================================================================ */

  const STORE_KEY = 'dm_u15_' + HOST;
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { cfg = {}; }

  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };
  let _saveId = 0;
  const saveLazy = () => { clearTimeout(_saveId); _saveId = setTimeout(save, 400); };
  const setCfg = (k, v) => { cfg[k] = v; saveLazy(); };

  /* ================================================================
   *  §4. 상태
   * ================================================================ */

  let _vidRef = null;

  const getVid = () => {
    if (_vidRef && !_vidRef.isConnected) {
      _vidRef = null;
      _needScan = true;
      startObserver();
    }
    return _vidRef;
  };
  const setVid = v => { _vidRef = v || null; };

  let enabled = cfg.enabled ?? true;

  let target;
  if (cfg._platform !== PLATFORM || cfg._lastDef !== DEF_TARGET || cfg.target == null) {
    target = DEF_TARGET;
    Object.assign(cfg, { _platform: PLATFORM, _lastDef: DEF_TARGET, target });
    saveLazy();
  } else {
    target = cfg.target;
  }

  let panelOpen = cfg.open ?? false;

  let _hyst = Math.max(0.2, target * 0.1);

  const control = {
    gear: R_NORM,
    lastGearChange: -GEAR_HOLD_MS,
    warmupEnd: 0,
    lastStallTime: 0,
  };

  const live = {
    isCurrent: false,
    falseCount: -1,
  };

  /* ================================================================
   *  §5. 라이브 판정
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
              if (!tr) { tr = { end, dur: d, count: 0 }; tracker.set(vid, tr); }
              else {
                if (end > tr.end + 0.5 || d > tr.dur + 0.5) { tr.count++; tr.end = end; tr.dur = d; }
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
      clearCache: vid => { if (vid) { cache.delete(vid); tracker.delete(vid); } },
    };
  })();

  /* ================================================================
   *  §6. 비디오 감지 · 연결
   * ================================================================ */

  const isCandidate = v => {
    if (!v || v.readyState < 2) return false;
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:') || src === '') return true;
    if (isHlsSrc(src)) return true;
    try { if (v.buffered.length && LiveDetect.check(v)) return true; } catch {}
    return false;
  };

  const safeRate = (vid, r) => {
    if (!vid) return;
    if (Math.abs(vid.playbackRate - r) < 0.005) return;
    vid.playbackRate = r;
    try { vid.preservesPitch = true; } catch {}
  };

  const resetRate = vid => {
    control.gear = R_NORM;
    control.lastGearChange = -GEAR_HOLD_MS;
    if (vid) safeRate(vid, R_NORM);
  };

  const seen = new WeakSet();
  let mo = null, _scanRetry = 0, _needScan = true;
  const stopObserver = () => { if (mo) { mo.disconnect(); mo = null; } };

  const resetControlState = vid => {
    control.gear = R_NORM;
    control.lastGearChange = -GEAR_HOLD_MS;
    control.warmupEnd = performance.now() + WARMUP_MS;
    control.lastStallTime = 0;
    live.isCurrent = false;
    live.falseCount = -1;
    if (vid) safeRate(vid, R_NORM);
  };

  const attach = v => {
    if (getVid() === v) return;
    if (!isCandidate(v)) return;
    LiveDetect.clearCache(v);
    stopObserver();
    setVid(v);
    resetControlState(v);
    _needScan = false;
    if (!seen.has(v)) {
      seen.add(v);
      v.addEventListener('emptied', () => {
        if (getVid() === v) resetControlState(v);
      });
      v.addEventListener('loadeddata', () => {
        LiveDetect.clearCache(v);
        if (!getVid() && isCandidate(v)) attach(v);
      });
      const onStall = () => {
        const now = performance.now();
        control.lastStallTime = now;
        control.lastGearChange = -GEAR_HOLD_MS;
        if (getVid() === v) { control.gear = R_NORM; safeRate(v, R_NORM); }
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
    _needScan = false;
    const vids = document.getElementsByTagName('video');
    if (!vids.length) {
      if (_scanRetry < 15) {
        _needScan = true;
        _scanRetry++;
        setTimeout(scan, 800 * Math.min(_scanRetry, 5));
      }
      return;
    }
    for (let i = 0; i < vids.length; i++) {
      if (isCandidate(vids[i])) { attach(vids[i]); _scanRetry = 0; return; }
    }
    if (_scanRetry < 15) {
      _needScan = true;
      _scanRetry++;
      setTimeout(scan, 2000);
    }
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
   *  §7. 제어 엔진
   *
   *  computeDesiredGear: R_HIGH 강제 강하 없음 — R_HIGH=1.30으로 낮춰
   *  언더슈트 위험을 줄이면서 히스테리시스 밴드까지 유지 허용
   *
   *  applyGear: 긴급 강등(→R_NORM)만 즉시 허용,
   *  일반 단계 강등(R_HIGH→R_MED)은 쿨다운 유지하여 배속 유지 시간 확보
   * ================================================================ */

  const computeDesiredGear = buf => {
    const ex = buf - target;
    if (ex > target * 0.8) return R_HIGH;
    if (ex > target * 0.4) return R_MED;
    if (ex < -_hyst)       return R_NORM;
    /* 히스테리시스 밴드 (-_hyst ≤ ex ≤ target*0.4): 현재 기어 유지
     * R_HIGH도 이 밴드에서 유지됨 — 1.30배속이므로 언더슈트 위험 낮음 */
    return control.gear;
  };

  const applyGear = (vid, desired, now) => {
    if (desired === control.gear) return;
    /* 긴급 강등: R_NORM으로의 복귀만 즉시 허용 (버퍼 급감 대응)
     * 일반 단계 강등(R_HIGH→R_MED)은 쿨다운 적용하여 배속 유지 시간 확보 */
    const isEmergency = desired === R_NORM && control.gear > R_NORM;
    if (!isEmergency && now - control.lastGearChange < GEAR_HOLD_MS) return;
    control.gear = desired;
    control.lastGearChange = now;
    safeRate(vid, control.gear);
  };

  /* ================================================================
   *  §8. 메인 루프
   * ================================================================ */

  let pendingRender = false, lastBuf = -1, lastTickStall = false;
  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; Renderer.update(lastBuf, getVid(), lastTickStall); });
  };

  const tick = () => {
    const vid = getVid();

    /* 비디오 없음 */
    if (!vid) {
      if (_needScan) { scan(); startObserver(); }
      lastBuf = -1;
      scheduleRender(); return;
    }

    /* 준비 안 됨 */
    if (!isCandidate(vid) || vid.readyState < 3) {
      lastBuf = -1;
      if (live.falseCount < 0) live.isCurrent = false;
      scheduleRender(); return;
    }

    /* 라이브 판정 */
    const isLiveNow = LiveDetect.check(vid);
    if (!isLiveNow) {
      if (live.falseCount >= 0) {
        live.falseCount++;
        if (live.falseCount <= 3) {
          if (control.gear !== R_NORM) resetRate(vid);
          scheduleRender();
          return;
        }
      }
      if (IS_YOUTUBE) _scanRetry = 0;
      lastBuf = -1;
      live.isCurrent = false; live.falseCount = -1;
      resetRate(vid);
      scheduleRender(); return;
    }
    live.isCurrent = true; live.falseCount = 0;

    /* 버퍼 측정 */
    const buf = getBuf(vid);
    lastBuf = buf;

    const now = performance.now();
    lastTickStall = (now - control.lastStallTime < STALL_COOLDOWN);

    /* 제어 */
    if (!vid.paused && enabled) {
      if (now >= control.warmupEnd && !lastTickStall) {
        const desired = computeDesiredGear(buf);
        applyGear(vid, desired, now);
      } else if (lastTickStall && control.gear !== R_NORM) {
        resetRate(vid);
      }
    } else if (!enabled) {
      resetRate(vid);
    }

    /* 제어 완료 후 렌더 */
    scheduleRender();
  };

  /* ================================================================
   *  §9. 렌더러
   * ================================================================ */

  let els = {};
  let _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
  let _prevBufRound = -999, _prevBarPct = -1;

  const Renderer = {
    update(buf, vid, isStalled) {
      if (!els.root) return;
      if (!live.isCurrent || !vid) {
        if (els.root.style.display !== 'none') els.root.style.display = 'none';
        return;
      }
      if (els.root.style.display === 'none') els.root.style.display = 'block';

      const sec = buf < 0 ? 0 : buf, diff = sec - target, c = getColor(diff);
      const speeding = vid.playbackRate > 1.005;

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

      let bTxt, bCls;
      if (!enabled)         { bTxt = 'OFF';      bCls = 'dm-b dm-off'; }
      else if (buf < 0)     { bTxt = '…';        bCls = 'dm-b dm-off'; }
      else if (isStalled)   { bTxt = '⏸ 대기';   bCls = 'dm-b dm-off'; }
      else if (speeding)    { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
      else if (sec <= target && sec >= Math.max(0, target - 0.5))
                            { bTxt = '✓ 안정';   bCls = 'dm-b dm-ok'; }
      else                  { bTxt = '→ 추적';   bCls = 'dm-b dm-acc'; }
      if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
      if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }
    },

    invalidate() {
      _prev = { dot: '', clr: '', badge: '', badgeCls: '' };
      _prevBufRound = -999;
      _prevBarPct = -1;
    }
  };

  /* ================================================================
   *  §10. DOM 구축 · 스타일
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
.dm-host{font-size:9px;color:var(--t2);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-close{margin-left:auto;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;opacity:.35;transition:opacity .15s,background .15s}
.dm-close:hover{opacity:.9;background:var(--bg3)}
.dm-stat{display:flex;align-items:baseline;gap:4px;padding:0 16px 4px}
.dm-val{font:700 28px/1 'SF Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--ac);transition:color .4s;letter-spacing:-.02em}
.dm-unit{font-size:11px;color:var(--t2);margin-right:4px}
.dm-b{margin-left:auto;font-size:10px;padding:3px 10px;border-radius:20px;font-weight:600;letter-spacing:.01em;transition:all .3s}
.dm-ok{background:rgba(0,230,150,.1);color:#00E696}.dm-acc{background:rgba(108,156,255,.12);color:#6C9CFF}.dm-off{background:var(--bg2);color:#666}
.dm-barwrap{margin:6px 16px 10px;height:3px;border-radius:2px;background:var(--bg2);overflow:hidden}
.dm-bar{height:100%;min-width:2%;border-radius:2px;background:var(--ac);transition:width .5s cubic-bezier(.4,0,.2,1),background .4s;box-shadow:0 0 6px var(--ac)}
.dm-sl-wrap{padding:0 16px;margin-bottom:14px}
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
  };

  /* 드래그 헬퍼 */
  const makeDrag = (gripEl, moveEl, onEnd) => {
    let ox, oy, moved = false;
    gripEl.onpointerdown = e => {
      if (e.button) return;
      if (gripEl._ignoreTarget && gripEl._ignoreTarget(e.target)) return;
      moved = false; gripEl._m = false;
      gripEl.setPointerCapture(e.pointerId);
      const r = moveEl.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
    };
    gripEl.onpointermove = e => {
      if (!gripEl.hasPointerCapture(e.pointerId)) return;
      moved = true;
      moveEl.style.left = clamp(e.clientX - ox, 0, innerWidth - moveEl.offsetWidth) + 'px';
      moveEl.style.top  = clamp(e.clientY - oy, 0, innerHeight - moveEl.offsetHeight) + 'px';
      moveEl.style.right = moveEl.style.bottom = 'auto';
    };
    const onRelease = e => {
      if (!gripEl.hasPointerCapture(e.pointerId)) return;
      gripEl._m = moved;
      if (moved && onEnd) onEnd();
      moved = false;
    };
    gripEl.onpointerup = onRelease;
    gripEl.onpointercancel = onRelease;
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
    const hdr = el('div', { className: 'dm-hdr' }, [
      el('div', { className: 'dm-logo', textContent: 'D' }),
      el('span', { className: 'dm-title', textContent: '딜레이 미터' }),
      el('span', { className: 'dm-host', title: HOST, textContent: PLATFORM_LABEL }),
      closeBtn
    ]);

    /* 딜레이 표시 */
    const valSpan = el('span', { className: 'dm-val', textContent: '—' });
    const badgeSpan = el('span', { className: 'dm-b dm-off', textContent: 'OFF' });
    const stat = el('div', { className: 'dm-stat' }, [
      valSpan, el('span', { className: 'dm-unit', textContent: '초' }), badgeSpan
    ]);

    /* 바 */
    const barDiv = el('div', { className: 'dm-bar' });
    const barWrap = el('div', { className: 'dm-barwrap' }, [barDiv]);

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

    /* 푸터 */
    const togDiv = el('div', { className: 'dm-tog' + (enabled ? ' on' : '') });
    const ft = el('div', { className: 'dm-ft' }, [
      togDiv,
      el('span', { className: 'dm-ver', textContent: 'v15.4.0' }),
      el('span', { className: 'dm-key', textContent: 'Alt+D' })
    ]);

    /* 조립 */
    pn.append(hdr, stat, barWrap, slWrap, ft);
    root.append(fab, pn);
    document.body.appendChild(root);

    els = { root, fab, pn, val: valSpan, bar: barDiv, badge: badgeSpan, tog: togDiv, sl: slInput, sv: svSpan, hdr, x: closeBtn };

    /* 이벤트 */
    fab.onclick = () => { if (!fab._m) openP(); };
    closeBtn.onclick = e => { e.stopPropagation(); closeP(); };
    togDiv.onclick = () => {
      enabled = !enabled; setCfg('enabled', enabled);
      togDiv.classList.toggle('on', enabled);
    };

    slInput.oninput = () => {
      target = parseFloat(slInput.value);
      _hyst = Math.max(0.2, target * 0.1);
      svSpan.textContent = target.toFixed(1) + 's';
      setCfg('target', target);
    };
    slInput.ondblclick = () => {
      target = DEF_TARGET;
      _hyst = Math.max(0.2, target * 0.1);
      slInput.value = target;
      svSpan.textContent = target.toFixed(1) + 's';
      setCfg('target', target);
    };

    /* FAB 드래그 */
    makeDrag(fab, fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });

    /* 패널 헤더 드래그 */
    hdr._ignoreTarget = t => t === closeBtn || closeBtn.contains(t);
    makeDrag(hdr, pn, () => { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); });

    /* 저장 위치 복원 */
    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }
    if (panelOpen) openP(true);
  };

  /* ================================================================
   *  §11. 패널 열기/닫기
   * ================================================================ */

  const openP = instant => {
    if (panelOpen && !instant) return;
    panelOpen = true; setCfg('open', true);

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
  };

  const closeP = () => {
    if (!panelOpen) return; panelOpen = false; setCfg('open', false);
    const r = els.pn.getBoundingClientRect(); els.pn.classList.remove('open');
    setTimeout(() => {
      if (panelOpen) return; els.fab.style.display = 'flex';
      Object.assign(els.fab.style, { left: clamp(r.right - 24, 0, innerWidth - 40) + 'px', top: clamp(r.top + 6, 0, innerHeight - 40) + 'px', right: 'auto', bottom: 'auto' });
      cfg.dx = els.fab.style.left; cfg.dy = els.fab.style.top; saveLazy();
    }, 260);
    _prev.dot = '';
  };

  /* ================================================================
   *  §12. 초기화 · 메인 루프
   * ================================================================ */

  const getTickInterval = () =>
    document.hidden ? 5000 : (live.isCurrent && enabled && !!getVid()) ? 1000 : 3000;
  const loop = () => { tick(); setTimeout(loop, getTickInterval()); };

  const init = () => {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init, { once: true }); return; }
    build(); scan(); startObserver(); loop();
  };

  /* ================================================================
   *  §13. SPA 네비게이션 대응
   * ================================================================ */

  let lastPath = location.pathname + location.search;
  let _navDebounce = 0;

  const onNav = () => {
    clearTimeout(_navDebounce);
    _navDebounce = setTimeout(() => {
      const cur = location.pathname + location.search;
      if (cur === lastPath) return;
      lastPath = cur;

      const prev = getVid();
      if (prev) safeRate(prev, R_NORM);
      setVid(null);
      resetControlState(null);
      _scanRetry = 0;
      _needScan = true;
      LiveDetect.resetYT();

      setTimeout(scan, 500); setTimeout(scan, 1500);
    }, 100);
  };

  const patchHistory = () => {
    for (const m of ['pushState', 'replaceState']) {
      const o = history[m];
      history[m] = function (...a) { const r = o.apply(this, a); onNav(); return r; };
    }
    window.addEventListener('popstate', onNav);
  };

  patchHistory();
  if ('navigation' in window) {
    try { navigation.addEventListener('navigatesuccess', onNav); } catch {}
  }
  if (IS_YOUTUBE) {
    document.addEventListener('yt-navigate-finish', onNav);
  }

  /* ================================================================
   *  §14. 글로벌 이벤트
   * ================================================================ */

  document.addEventListener('keydown', e => {
    if (!e.altKey || e.code !== 'KeyD' || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const t = document.activeElement?.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault(); enabled = !enabled; setCfg('enabled', enabled);
    if (els.tog) els.tog.classList.toggle('on', enabled);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      control.warmupEnd = performance.now() + WARMUP_MS;
      control.lastGearChange = -GEAR_HOLD_MS;
      const vid = getVid();
      if (vid && control.gear !== R_NORM) {
        control.gear = R_NORM;
        safeRate(vid, R_NORM);
      }
    }
  });

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

  window.addEventListener('beforeunload', save);

  /* ================================================================
   *  §15. 디버그
   * ================================================================ */

  GM_registerMenuCommand('현재 상태', () => {
    const vid = getVid();
    const buf = vid ? getBuf(vid) : -1;
    const gl = control.gear > 1.2 ? 'HIGH' : control.gear > 1 ? 'MED' : 'NORM';
    const txt = `[${PLATFORM}] t=${target}s hyst=${_hyst.toFixed(2)} | buf=${buf < 0 ? '-' : buf.toFixed(3) + 's'} | ${gl} | ${enabled ? 'ON' : 'OFF'} | live=${vid ? LiveDetect.check(vid) : false} | rs=${vid?.readyState ?? -1} | dur=${vid ? (vid.duration === Infinity ? '∞' : vid.duration?.toFixed(1)) : '-'}`;
    const toast = el('div', { textContent: txt, style: { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '10001', background: 'rgba(12,14,20,.92)', backdropFilter: 'blur(12px)', color: '#f0f0f0', padding: '10px 24px', borderRadius: '12px', fontSize: '11px', fontFamily: 'monospace', transition: 'opacity .4s', border: '1px solid rgba(255,255,255,.06)', boxShadow: '0 8px 32px rgba(0,0,0,.5)', maxWidth: '94vw', wordBreak: 'break-all' } });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 5000);
  });

  /* ================================================================
   *  §16. 시작
   * ================================================================ */

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

})();
