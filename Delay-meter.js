// ==UserScript==
// @name         딜레이 자동 제어
// @namespace    https://github.com/moamoa7
// @version      16.1.1
// @description  라이브 방송의 딜레이를 자동 감지·제어 (경량화)
// @author       DelayMeter
// @match        *://*.youtube.com/*
// @match        *://*.chzzk.naver.com/*
// @match        *://play.sooplive.com/*
// @match        *://play.sooplive.co.kr/*
// @match        *://*.twitch.tv/*
// @exclude      *://*.youtube.com/live_chat*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.challenges.cloudflare.com/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.recaptcha.net/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   *  §1. 플랫폼 감지 · 상수
   * ================================================================ */

  const SCRIPT_VERSION = typeof GM_info !== 'undefined'
    ? GM_info?.script?.version ?? '16.1.1'
    : '16.1.1';

  const HOST = location.hostname.replace(/^www\./, '');
  const PLATFORM = (() => {
    const map = { youtube: 'youtube', chzzk: 'chzzk', sooplive: 'soop', twitch: 'twitch' };
    for (const [k, v] of Object.entries(map)) if (HOST.includes(k)) return v;
    return 'default';
  })();
  const IS_YOUTUBE = PLATFORM === 'youtube';
  const IS_TWITCH = PLATFORM === 'twitch';
  const IS_CHZZK = PLATFORM === 'chzzk';
  const IS_SOOP = PLATFORM === 'soop';
  const PLATFORM_LABEL = { youtube: 'YouTube', chzzk: 'CHZZK', soop: 'SOOP', twitch: 'Twitch', default: HOST }[PLATFORM];

  const PLATFORM_DEFAULTS = {
    youtube: { target: 10, min: 2,   max: 30, barMax: 35, rHigh: 1.30, stallCooldown: 8000, stallMode: 'full' },
    chzzk:   { target: 1.5,  min: 0.5, max: 10, barMax: 15, rHigh: 1.30, stallCooldown: 3500, stallMode: 'full' },
    soop:    { target: 3,  min: 1,   max: 10, barMax: 15, rHigh: 1.25, stallCooldown: 0, stallMode: 'gentle' },
    twitch:  { target: 3,  min: 1,   max: 10, barMax: 15, rHigh: 1.30, stallCooldown: 0, stallMode: 'gentle' },
    default: { target: 3,  min: 1,   max: 10, barMax: 15, rHigh: 1.30, stallCooldown: 4000, stallMode: 'full' },
  };
  const PD = PLATFORM_DEFAULTS[PLATFORM] || PLATFORM_DEFAULTS.default;
  const { target: DEF_TARGET, min: MIN_TARGET, max: MAX_TARGET, barMax: BAR_MAX } = PD;

  const STALL_COOLDOWN = PD.stallCooldown;
  const STALL_GENTLE = PD.stallMode === 'gentle';
  const WARMUP_MS = 4000;
  const GEAR_HOLD_MS = 3000;

  const R_NORM = 1.00;
  const R_MED  = 1.025;
  const R_HIGH = PD.rHigh;

  /* ================================================================
   *  §2. 유틸리티
   * ================================================================ */

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const isHlsSrc = src => /\.m3u8($|\?)/i.test(src);

  let _colorDenom = DEF_TARGET * 0.5;

  const getBuf = vid => {
    const b = vid.buffered;
    if (!b.length) return -1;
    return b.end(b.length - 1) - vid.currentTime;
  };

  const BUF_WINDOW = 5;
  const _bufRing = new Float64Array(BUF_WINDOW).fill(-1);
  const _bufSort = new Float64Array(BUF_WINDOW);
  let _bufIdx = 0, _bufCount = 0;

  const pushBuf = raw => {
    if (raw < 0) return;
    _bufRing[_bufIdx] = raw;
    _bufIdx = (_bufIdx + 1) % BUF_WINDOW;
    if (_bufCount < BUF_WINDOW) _bufCount++;
  };

  const getSmoothedBuf = raw => {
    if (raw < 0) return raw;
    pushBuf(raw);
    let n = 0;
    for (let i = 0; i < BUF_WINDOW; i++) {
      if (_bufRing[i] >= 0) _bufSort[n++] = _bufRing[i];
    }
    if (n === 0) return raw;
    for (let i = 1; i < n; i++) {
      const v = _bufSort[i];
      let j = i;
      while (j > 0 && _bufSort[j - 1] > v) { _bufSort[j] = _bufSort[j - 1]; j--; }
      _bufSort[j] = v;
    }
    return _bufSort[n >> 1];
  };

  const resetBufRing = () => {
    _bufRing.fill(-1);
    _bufIdx = 0;
    _bufCount = 0;
  };

  let _colorKey = -1, _colorVal = '', _colorDenomCached = -1;
  const getColor = diff => {
    const key = Math.round(clamp(diff / _colorDenom, 0, 1) * 100);
    if (key === _colorKey && _colorDenom === _colorDenomCached) return _colorVal;
    _colorKey = key;
    _colorDenomCached = _colorDenom;
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
   *  §2-A. 버퍼 급변 감지 (광고·소스전환 등 통합 대응)
   * ================================================================ */

  const BufGuard = (() => {
    const SPIKE_THRESH_RATIO = 1.5;
    const STABLE_NEEDED = 3;

    let _lastStable = -1;
    let _holdTicks = 0;
    let _holding = false;

    const check = raw => {
      if (raw < 0) return false;

      const thresh = Math.max(target * SPIKE_THRESH_RATIO, 3);

      if (_lastStable >= 0) {
        const delta = Math.abs(raw - _lastStable);
        if (delta > thresh) {
          _holding = true;
          _holdTicks = 0;
          resetBufRing();
          return true;
        }
      }

      if (_holding) {
        _holdTicks++;
        if (_holdTicks >= STABLE_NEEDED) {
          _holding = false;
          _holdTicks = 0;
          _lastStable = raw;
          return false;
        }
        return true;
      }

      _lastStable = raw;
      return false;
    };

    const reset = () => {
      _lastStable = -1;
      _holdTicks = 0;
      _holding = false;
    };

    const isHolding = () => _holding;

    return { check, reset, isHolding };
  })();

  /* ================================================================
   *  §2-T. 트위치 전용: 리런/VOD 감지
   * ================================================================ */

  const TwitchDetect = (() => {
    let _rerunTs = 0, _rerunResult = false;

    const RERUN_KEYWORDS = /\brerun\b|\b재방송\b|\b리런\b|\b다시\s*보기\b/i;

    const checkRerun = () => {
      const now = performance.now();
      if (now - _rerunTs < 3000) return _rerunResult;
      _rerunTs = now;

      if (/\/videos\/\d+/.test(location.pathname)) {
        _rerunResult = 'vod';
        return _rerunResult;
      }

      const titleEl =
        document.querySelector('[data-a-target="stream-title"]') ||
        document.querySelector('h2[data-a-target]') ||
        document.querySelector('.channel-info-content [title]') ||
        document.querySelector('p[data-a-target="stream-title"]');
      if (titleEl) {
        const title = titleEl.textContent || titleEl.getAttribute('title') || '';
        if (RERUN_KEYWORDS.test(title)) {
          _rerunResult = 'hint';
          return _rerunResult;
        }
      }

      const docTitle = document.title || '';
      if (RERUN_KEYWORDS.test(docTitle)) {
        _rerunResult = 'hint';
        return _rerunResult;
      }

      _rerunResult = false;
      return _rerunResult;
    };

    const resetCache = () => { _rerunTs = 0; _rerunResult = false; };
    return { checkRerun, resetCache };
  })();

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
  const getVid = () => _vidRef;

  const detachVid = () => {
    const prev = _vidRef;
    if (prev) {
      resetRate(prev);
      LiveDetect.clearCache(prev);
    }
    _vidRef = null;
    _needScan = true;
    stopObserver();
    startObserver();
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

  /* ── 히스테리시스 (데드존) ──
   *  target * 0.15 (최소 0.3s).
   *  목표값 근처에서 기어가 불필요하게 전환되는 것을 억제. */
  let _hyst = Math.max(0.3, target * 0.15);

  _colorDenom = target * 0.5;

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

    const twitch = vid => {
      if (/\/videos\/\d+/.test(location.pathname)) return false;
      if (vid.duration === Infinity || vid.duration >= 1e6) return true;
      const cached = cache.get(vid);
      if (cached && performance.now() - cached.ts < 3000) return cached.v;
      let v = false;
      try {
        const s = vid.seekable;
        if (s.length > 0) {
          const start = s.start(0), end = s.end(s.length - 1);
          if (start > 10) { v = true; }
          else {
            let tr = tracker.get(vid);
            if (!tr) { tr = { end, dur: vid.duration, count: 0 }; tracker.set(vid, tr); }
            else {
              if (end > tr.end + 0.5 || vid.duration > tr.dur + 0.5) { tr.count++; tr.end = end; tr.dur = vid.duration; }
              if (tr.count >= 2) v = true;
            }
          }
        }
      } catch {}
      cache.set(vid, { v, ts: performance.now() });
      return v;
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
      cache.set(vid, { v, ts: performance.now() });
      return v;
    };

    return {
      check: vid => vid ? (IS_YOUTUBE ? youtube(vid) : IS_TWITCH ? twitch(vid) : generic(vid)) : false,
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
    if (control.gear === R_NORM) return;
    control.gear = R_NORM;
    control.lastGearChange = -GEAR_HOLD_MS;
    if (vid) safeRate(vid, R_NORM);
  };

  const seen = new WeakSet();
  let mo = null, _scanRetry = 0, _needScan = true;
  const stopObserver = () => { if (mo) { mo.disconnect(); mo = null; } };

  const resetControlState = vid => {
    resetRate(vid);
    control.lastGearChange = -GEAR_HOLD_MS;
    control.warmupEnd = performance.now() + WARMUP_MS;
    control.lastStallTime = 0;
    live.isCurrent = false;
    live.falseCount = -1;
    resetBufRing();
    BufGuard.reset();
    if (IS_TWITCH) TwitchDetect.resetCache();
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
        if (getVid() !== v) return;
        if (STALL_GENTLE) {
          if (control.gear !== R_NORM) { control.gear = R_NORM; safeRate(v, R_NORM); }
        } else {
          const now = performance.now();
          control.lastStallTime = now;
          control.lastGearChange = -GEAR_HOLD_MS;
          control.gear = R_NORM;
          safeRate(v, R_NORM);
        }
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
      if (_scanRetry < 15) { _needScan = true; _scanRetry++; setTimeout(scan, 800 * Math.min(_scanRetry, 5)); }
      return;
    }
    for (let i = 0; i < vids.length; i++) {
      if (isCandidate(vids[i])) { attach(vids[i]); _scanRetry = 0; return; }
    }
    if (_scanRetry < 15) { _needScan = true; _scanRetry++; setTimeout(scan, 2000); }
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
   * ================================================================
   *
   *  v16.1.1 변경:
   *  ─ 데드존 내부에서 MED→NORM 복귀 경로 추가.
   *    ex < _hyst * 0.5 이면 기어와 무관하게 NORM 복귀.
   *    이전 버전에서는 MED 상태로 데드존 진입 시
   *    NORM으로 내려오지 못하는 결함이 있었음.
   */

  const computeDesiredGear = buf => {
    if (buf < 0) return R_NORM;
    const ex = buf - target;

    /* 목표보다 많이 초과 → 고속 */
    if (ex > target * 0.8) return R_HIGH;

    /* 목표보다 적당히 초과 → 중속 */
    if (ex > target * 0.4) return R_MED;

    /* 목표보다 짧음 → 1.0× 유지, 자연 회복에 맡김 */
    if (ex < -_hyst) return R_NORM;

    /* ── 데드존: -_hyst ≤ ex ≤ target*0.4 ──
     *  ex가 데드존 하한에 가까우면(< _hyst * 0.5) 기어와 무관하게 NORM 복귀.
     *  이전에 MED였다가 버퍼가 줄어 데드존에 진입한 경우의 복귀 경로. */
    if (ex < _hyst * 0.5) return R_NORM;

    /* HIGH→MED 한 단계 감속 */
    if (control.gear === R_HIGH) return R_MED;

    /* 그 외: 현재 기어 유지 (NORM이면 NORM, MED이면 MED) */
    return control.gear;
  };

  const applyGear = (vid, desired, now) => {
    if (desired === control.gear) return;
    const isEmergency = desired === R_NORM && control.gear > R_NORM;
    const isBigUpgrade = desired > control.gear && desired === R_HIGH;
    if (!isEmergency && !isBigUpgrade && now - control.lastGearChange < GEAR_HOLD_MS) return;
    control.gear = desired;
    control.lastGearChange = now;
    safeRate(vid, control.gear);
  };

  /* ================================================================
   *  §8. 메인 루프
   * ================================================================ */

  let pendingRender = false, lastBuf = -1, lastTickStall = false;
  let lastTickRerun = false, lastTickGuard = false;

  const scheduleRender = () => {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; Renderer.update(lastBuf, getVid(), lastTickStall, lastTickGuard, lastTickRerun); });
  };

  const tick = () => {
    if (_vidRef && !_vidRef.isConnected) detachVid();

    const vid = getVid();

    if (!vid) {
      if (_needScan) { scan(); startObserver(); }
      lastBuf = -1; lastTickRerun = false; lastTickGuard = false;
      scheduleRender(); return;
    }

    if (!isCandidate(vid) || vid.readyState < 3) {
      lastBuf = -1; lastTickRerun = false; lastTickGuard = false;
      if (live.falseCount < 0) live.isCurrent = false;
      scheduleRender(); return;
    }

    /* 트위치 리런 힌트 감지 (UI 표시용) */
    const rerunStatus = IS_TWITCH ? TwitchDetect.checkRerun() : false;
    lastTickRerun = rerunStatus;

    /* 라이브 판정 */
    const isLiveNow = LiveDetect.check(vid);
    if (!isLiveNow) {
      if (live.isCurrent) {
        live.falseCount = (live.falseCount < 0) ? 1 : live.falseCount + 1;
        if (live.falseCount <= 3) {
          if (control.gear !== R_NORM) resetRate(vid);
          lastBuf = -1;
          scheduleRender(); return;
        }
      }
      if (IS_YOUTUBE) _scanRetry = 0;
      lastBuf = -1; live.isCurrent = false; live.falseCount = -1;
      resetRate(vid); scheduleRender(); return;
    }
    live.isCurrent = true; live.falseCount = 0;

    /* 버퍼 측정 */
    const rawBuf = getBuf(vid);

    /* 버퍼 급변 감지 (광고·소스전환 등 통합 대응) */
    const guarding = BufGuard.check(rawBuf);
    lastTickGuard = guarding;
    if (guarding) {
      if (control.gear !== R_NORM) resetRate(vid);
      lastBuf = rawBuf;
      scheduleRender(); return;
    }

    const buf = getSmoothedBuf(rawBuf);
    lastBuf = buf;

    const now = performance.now();
    lastTickStall = (STALL_COOLDOWN > 0 && now - control.lastStallTime < STALL_COOLDOWN);

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

    scheduleRender();
  };

  /* ================================================================
   *  §9. 렌더러
   * ================================================================ */

  let els = {};
  let _prev = { dot: '', clr: '', badge: '', badgeCls: '', bufRound: -999, barPct: -1 };

  const Renderer = {
    update(buf, vid, isStalled, isGuarding, rerunStatus) {
      if (!els.root) return;
      if (!live.isCurrent || !vid) {
        if (els.root.style.display !== 'none') els.root.style.display = 'none';
        return;
      }
      if (els.root.style.display === 'none') els.root.style.display = 'block';

      const sec = buf < 0 ? 0 : buf, diff = sec - target, c = getColor(diff);
      const speeding = !!vid && vid.playbackRate > 1.005;

      if (!panelOpen) {
        if (!els.fab) return;
        const fc = isGuarding ? '#888' : !enabled ? '#555' : speeding ? '#6C9CFF' : c;
        if (fc !== _prev.dot) { _prev.dot = fc; els.fab.style.setProperty('--ac', fc); }
        return;
      }

      const bufRound = buf < 0 ? -1 : Math.round(sec * 10);
      if (bufRound !== _prev.bufRound) {
        _prev.bufRound = bufRound;
        els.val.textContent = buf < 0 ? '—' : (bufRound / 10).toFixed(1);
      }
      if (c !== _prev.clr) { els.pn.style.setProperty('--ac', c); _prev.clr = c; }

      const barPct = Math.round(clamp(sec / BAR_MAX * 100, 0, 100) * 10);
      if (barPct !== _prev.barPct) { _prev.barPct = barPct; els.bar.style.width = (barPct / 10).toFixed(1) + '%'; }

      /* 배지 텍스트 결정 (우선순위 순) */
      let bTxt, bCls;
      if (isGuarding)       { bTxt = '⏳ 안정화'; bCls = 'dm-b dm-off'; }
      else if (!enabled)    { bTxt = 'OFF';       bCls = 'dm-b dm-off'; }
      else if (buf < 0)     { bTxt = '…';         bCls = 'dm-b dm-off'; }
      else if (isStalled)   { bTxt = '⏸ 대기';    bCls = 'dm-b dm-off'; }
      else if (rerunStatus === 'hint' && speeding)
                            { bTxt = '📼 리런? ⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-warn'; }
      else if (rerunStatus === 'hint')
                            { bTxt = '📼 리런?';   bCls = 'dm-b dm-warn'; }
      else if (speeding)    { bTxt = '⚡' + vid.playbackRate.toFixed(2) + '×'; bCls = 'dm-b dm-acc'; }
      else if (sec <= target && sec >= Math.max(0, target - 0.5))
                            { bTxt = '✓ 안정';    bCls = 'dm-b dm-ok'; }
      else                  { bTxt = '→ 추적';    bCls = 'dm-b dm-acc'; }
      if (bTxt !== _prev.badge)    { els.badge.textContent = bTxt; _prev.badge = bTxt; }
      if (bCls !== _prev.badgeCls) { els.badge.className = bCls;   _prev.badgeCls = bCls; }
    },

    invalidate() {
      _prev = { dot: '', clr: '', badge: '', badgeCls: '', bufRound: -999, barPct: -1 };
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
#dm-fab{position:fixed;bottom:20px;right:20px;z-index:10000;width:40px;height:40px;border-radius:50%;background:var(--bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1.5px solid var(--ac);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s,transform .15s;contain:strict;box-shadow:0 0 12px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.04);will-change:transform}
#dm-fab:hover{transform:scale(1.08)}#dm-fab:active{transform:scale(.95)}
.dm-dot{width:10px;height:10px;border-radius:50%;background:var(--ac);transition:background .4s;box-shadow:0 0 8px var(--ac)}
@keyframes dm-pulse{0%,100%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 0 var(--ac)}50%{box-shadow:0 0 12px rgba(0,0,0,.4),0 0 0 6px transparent}}
#dm-fab{animation:dm-pulse 2.5s ease-in-out 4}
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
.dm-warn{background:rgba(255,180,50,.12);color:#FFB432}
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

    const slInput = el('input', { type: 'range', min: String(MIN_TARGET), max: String(MAX_TARGET), step: '0.5', value: String(target) });
    const svSpan = el('span', { className: 'dm-sv', textContent: target.toFixed(1) + 's' });
    const defLabel = el('span', { textContent: `기본 ${DEF_TARGET}s · 더블클릭 리셋` });
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
      el('span', { className: 'dm-ver', textContent: 'v' + SCRIPT_VERSION }),
      el('span', { className: 'dm-key', textContent: 'Alt+D' })
    ]);

    pn.append(hdr, stat, barWrap, slWrap, ft);
    root.append(fab, pn);
    document.body.appendChild(root);

    els = { root, fab, pn, val: valSpan, bar: barDiv, badge: badgeSpan, tog: togDiv, sl: slInput, sv: svSpan, hdr, x: closeBtn };

    fab.onclick = () => { if (!fab._m) openP(); };
    closeBtn.onclick = e => { e.stopPropagation(); closeP(); };
    togDiv.onclick = () => {
      enabled = !enabled; setCfg('enabled', enabled);
      togDiv.classList.toggle('on', enabled);
    };

    /* 슬라이더 타겟 변경 공통 로직 */
    const applyTarget = t => {
      target = t;
      _hyst = Math.max(0.3, target * 0.15);
      _colorDenom = target * 0.5;
      _colorKey = -1;
      slInput.value = target;
      svSpan.textContent = target.toFixed(1) + 's';
      setCfg('target', target);
      BufGuard.reset();
      resetBufRing();
    };

    slInput.oninput = () => applyTarget(parseFloat(slInput.value));
    slInput.ondblclick = () => {
      applyTarget(DEF_TARGET);
      control.lastGearChange = -GEAR_HOLD_MS;
    };

    makeDrag(fab, fab, () => { cfg.dx = fab.style.left; cfg.dy = fab.style.top; saveLazy(); });
    hdr._ignoreTarget = t => t === closeBtn || closeBtn.contains(t);
    makeDrag(hdr, pn, () => { cfg.px = pn.style.left; cfg.py = pn.style.top; saveLazy(); });

    if (cfg.px) { const x = parseFloat(cfg.px); if (x >= 0 && x < innerWidth - 50) Object.assign(pn.style, { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' }); }
    if (cfg.dx) { const x = parseFloat(cfg.dx); if (x >= 0 && x < innerWidth - 36) Object.assign(fab.style, { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' }); }
    if (panelOpen) openP(true);
  };

  /* ================================================================
   *  §11. 패널 열기/닫기
   * ================================================================ */

  const openP = force => {
    if (panelOpen && !force) return;
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
      setVid(null);
      resetControlState(prev);
      lastBuf = -1; lastTickRerun = false; lastTickGuard = false;
      _scanRetry = 0; _needScan = true;
      LiveDetect.resetYT();
      if (IS_TWITCH) TwitchDetect.resetCache();
      setTimeout(scan, 500);
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
  if ('navigation' in window) { try { navigation.addEventListener('navigatesuccess', onNav); } catch {} }
  if (IS_YOUTUBE) { document.addEventListener('yt-navigate-finish', onNav); }

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
      if (vid && control.gear !== R_NORM) { control.gear = R_NORM; safeRate(vid, R_NORM); }
      resetBufRing(); BufGuard.reset(); tick();
    }
  });

  document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => {
    if (!els.pn) return;
    const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    if (document.fullscreenElement) {
      if (panelOpen) Object.assign(els.pn.style, def);
      else Object.assign(els.fab.style, def);
    } else {
      if (panelOpen) Object.assign(els.pn.style, cfg.px ? { left: cfg.px, top: cfg.py, right: 'auto', bottom: 'auto' } : def);
      else Object.assign(els.fab.style, cfg.dx ? { left: cfg.dx, top: cfg.dy, right: 'auto', bottom: 'auto' } : def);
    }
  }));

  window.addEventListener('beforeunload', save);

  /* ── 브라우저 리사이즈 대응 ── */
  let _resizeId = 0;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeId);
    _resizeId = setTimeout(() => {
      if (!els.pn) return;
      const vw = innerWidth, vh = innerHeight;

      if (panelOpen) {
        const r = els.pn.getBoundingClientRect();
        const nx = clamp(r.left, 0, vw - r.width);
        const ny = clamp(r.top, 0, vh - r.height);
        if (nx !== r.left || ny !== r.top) {
          Object.assign(els.pn.style, { left: nx + 'px', top: ny + 'px', right: 'auto', bottom: 'auto' });
          cfg.px = els.pn.style.left; cfg.py = els.pn.style.top; saveLazy();
        }
      } else if (els.fab) {
        const r = els.fab.getBoundingClientRect();
        const nx = clamp(r.left, 0, vw - r.width);
        const ny = clamp(r.top, 0, vh - r.height);
        if (nx !== r.left || ny !== r.top) {
          Object.assign(els.fab.style, { left: nx + 'px', top: ny + 'px', right: 'auto', bottom: 'auto' });
          cfg.dx = els.fab.style.left; cfg.dy = els.fab.style.top; saveLazy();
        }
      }
    }, 150);
  });

  /* ================================================================
   *  §15. 디버그
   * ================================================================ */

  GM_registerMenuCommand('현재 상태', () => {
    const vid = getVid();
    const rawBuf = vid ? getBuf(vid) : -1;
    const smoothed = lastBuf;
    const gl = control.gear > 1.2 ? 'HIGH' : control.gear > 1 ? 'MED' : 'NORM';
    const rerunInfo = IS_TWITCH ? ` rerun=${TwitchDetect.checkRerun() || 'no'}` : '';
    const guardInfo = ` guard=${BufGuard.isHolding()}`;
    const stallInfo = ` stall=${STALL_GENTLE ? 'gentle' : 'full'}(${STALL_COOLDOWN}ms)`;
    const txt = `[${PLATFORM}] t=${target}s hyst=${_hyst.toFixed(2)} rH=${R_HIGH}${stallInfo} | raw=${rawBuf < 0 ? '-' : rawBuf.toFixed(3) + 's'} med=${smoothed < 0 ? '-' : smoothed.toFixed(3) + 's'} | ${gl}(${control.gear.toFixed(3)}×) | ${enabled ? 'ON' : 'OFF'} | live=${vid ? LiveDetect.check(vid) : false} | rs=${vid?.readyState ?? -1} | dur=${vid ? (vid.duration === Infinity ? '∞' : vid.duration?.toFixed(1)) : '-'}${guardInfo}${rerunInfo}`;
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
