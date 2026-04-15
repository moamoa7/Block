// ==UserScript==
// @name         Video Tools
// @namespace    https://github.com/moamoa7
// @version      10.1.0
// @description  영상의 노란끼/청색끼 감지 + 비디오 최대화 + 항상 보이는 시계 + 좌우 반전 + 확대/축소
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  if (window.__ytd_booted) return;
  window.__ytd_booted = true;

  /* ── Trusted Types ──────────────────────────────────── */
  let ttPolicy = null;
  if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
    try { ttPolicy = trustedTypes.createPolicy('ytd-tint-detector', { createHTML: s => s }); }
    catch (_) { try { ttPolicy = trustedTypes.createPolicy('default', { createHTML: s => s }); } catch (__) {} }
  }
  function safeHTML(str) { return ttPolicy ? ttPolicy.createHTML(str) : str; }

  const CFG = { sampleSize: 48, intervalMs: 1000, threshold: 12, coldThreshold: -12, histLen: 24, tempPerScore: 5 };

  let timerID = null, clockTimer = null, liveVideo = null, shadowVid = null;
  let history = [], panel = null, fab = null, maxFab = null, mirrorFab = null, zoomFab = null, fabStyle = null, panelStyle = null;
  let panelOpen = false, lastStatus = 'idle';
  let coreStyle = null;

  let offscreen, oCtx;
  function resetCanvas() {
    offscreen = document.createElement('canvas');
    offscreen.width = offscreen.height = CFG.sampleSize;
    oCtx = offscreen.getContext('2d', { willReadFrequently: true });
  }
  resetCanvas();

  /* ── 모바일 / 전체화면 / iframe 판별 ───────────────── */
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function isInIframe() {
    try { return window !== window.top; } catch (_) { return true; }
  }
  function shouldAnalyze() {
    if (!isMobile()) return true;
    return isFullscreen();
  }

  /* ── OSD (On-Screen Display) ───────────────────────── */
  let __osdEl = null, __osdTimerId = 0;
  function showOSD(text, durationMs = 1200) {
    if (!document.body) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const root = fsEl || document.body;
    if (!__osdEl || !__osdEl.isConnected || __osdEl.parentNode !== root) {
      __osdEl?.remove();
      __osdEl = document.createElement('div');
      __osdEl.id = 'ytd-osd';
      __osdEl.style.cssText = [
        'position:fixed', 'top:48px', 'left:50%', 'transform:translateX(-50%) translateY(0)',
        'background:rgba(12, 12, 18, 0.85)', 'backdrop-filter:blur(24px) saturate(200%)',
        'color:rgba(255, 255, 255, 0.95)', 'padding:10px 28px', 'border-radius:14px',
        'border:1px solid rgba(0, 229, 255, 0.15)', 'font:600 13px/1.4 system-ui, -apple-system, sans-serif',
        'z-index:2147483647', 'pointer-events:none', 'opacity:0', 'will-change:opacity, transform',
        'transition:opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'box-shadow:0 8px 32px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 229, 255, 0.08)',
        'letter-spacing:0.3px', 'white-space:pre-line', 'max-width:90vw', 'text-align:center', 'word-break:keep-all'
      ].join(';');
      root.appendChild(__osdEl);
    }
    __osdEl.textContent = text;
    requestAnimationFrame(() => {
      if (!__osdEl) return;
      __osdEl.style.opacity = '1';
      __osdEl.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(__osdTimerId);
    __osdTimerId = setTimeout(() => {
      if (__osdEl) {
        __osdEl.style.opacity = '0';
        __osdEl.style.transform = 'translateX(-50%) translateY(-8px)';
      }
    }, durationMs);
  }

  /* ── 영상 탐색 ───────────────────────────────────────── */
  function findVideosInShadowRoots(root, results, depth) {
    if (depth > 8) return;
    let els;
    try { els = root.querySelectorAll('*'); } catch (_) { return; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.tagName === 'VIDEO') results.push(el);
      if (el.shadowRoot) {
        try {
          const svids = el.shadowRoot.querySelectorAll('video');
          for (let j = 0; j < svids.length; j++) results.push(svids[j]);
          findVideosInShadowRoots(el.shadowRoot, results, depth + 1);
        } catch (_) {}
      }
    }
  }

  function getAllVideos() {
    const set = new Set(document.querySelectorAll('video'));
    const shadowResults = [];
    try { findVideosInShadowRoots(document, shadowResults, 0); } catch (_) {}
    for (const v of shadowResults) set.add(v);
    try {
      const vsc = window.__vsc_internal;
      if (vsc?._activeVideo?.isConnected) set.add(vsc._activeVideo);
    } catch (_) {}
    return [...set];
  }

  function pickBestVideo() {
    const videos = getAllVideos();
    if (!videos.length) return null;
    try {
      const vsc = window.__vsc_internal;
      if (vsc?._activeVideo?.isConnected) {
        const av = vsc._activeVideo;
        if ((av.clientWidth || 0) >= 100 && (av.clientHeight || 0) >= 56) return av;
      }
    } catch (_) {}
    let best = null, bestScore = -1;
    for (const v of videos) {
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      let s = area;
      if (!v.paused && !v.ended) s += 1e7;
      if (v.readyState >= 2) s += 1e5;
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return best;
  }

  /* ── 샘플링 ─────────────────────────────────────────── */
  function sampleRGB(video) {
    try {
      oCtx.drawImage(video, 0, 0, CFG.sampleSize, CFG.sampleSize);
      const px = oCtx.getImageData(0, 0, CFG.sampleSize, CFG.sampleSize).data;
      let r = 0, g = 0, b = 0, n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; }
      r /= n; g /= n; b /= n;
      const rawScore = (r - b) + (g - b) * 0.5;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const score = rawScore * (lum < 40 ? lum / 40 : 1);
      return { ok: true, r, g, b, score };
    } catch (e) { resetCanvas(); return { ok: false, error: e.name + ': ' + e.message }; }
  }

  function makeShadow(src, currentTime) {
    killShadow();
    if (!document.body) return null;
    if (src.startsWith('blob:')) return null;
    const bustUrl = src + (src.includes('?') ? '&' : '?') + '__ytd_cb=' + Date.now();
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true;
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.001;top:0;left:0;pointer-events:none';
    document.body.appendChild(v);
    v.src = bustUrl; v.currentTime = currentTime || 0;
    v.play().catch(() => {}); shadowVid = v; return v;
  }
  function killShadow() { if (!shadowVid) return; shadowVid.src = ''; shadowVid.remove(); shadowVid = null; }

  function scoreToTemp(score) {
    if (Math.abs(score) < 1) return 0;
    return -(Math.round(score / CFG.tempPerScore));
  }

  function classifyTint(score) {
    if (score > CFG.threshold) return 'warm';
    if (score < CFG.coldThreshold) return 'cold';
    return 'ok';
  }

  /* ── 시계 & FAB 상태 ─────────────────────────────────── */
  function updateClock() {
    if (!fab) return;
    const el = fab.querySelector('.ytd-fab-clock'); if (!el) return;
    const now = new Date();
    el.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }
  function startClock() { if (clockTimer) return; updateClock(); clockTimer = setInterval(updateClock, 1000); }

  function updateFabState(status, score) {
    if (!fab) return; lastStatus = status;
    const scoreEl = fab.querySelector('.ytd-fab-score');
    if (scoreEl) {
      if (status === 'idle') scoreEl.textContent = '';
      else if (status === 'error') scoreEl.textContent = '!';
      else if (status === 'ok') scoreEl.textContent = '0';
      else { const t = scoreToTemp(score); scoreEl.textContent = t > 0 ? '+' + t : String(t); }
    }
    fab.className = 'ytd-fab ytd-fab--' + status;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     ★ FAB 동적 위치 계산
  ═════════════════════════════════════════════════════════════════════════ */
  const FAB_START_RIGHT = 5;
  const FAB_GAP = 50;

  function layoutFabs() {
    const ordered = [fab, maxFab, mirrorFab, zoomFab];
    let pos = 0;
    for (const f of ordered) {
      if (!f) continue;
      if (f.style.display === 'none') continue;
      if (f.style.left && f.style.left !== 'auto') continue;
      f.style.right = (FAB_START_RIGHT + FAB_GAP * pos) + 'px';
      pos++;
    }
  }

  function setFabVisible(show) {
    if (!fab) return;
    const mobile = isMobile();
    const showMainFab = show && shouldAnalyze();

    if (showMainFab) {
      if (fab.style.display === 'none') fab.style.display = '';
    } else {
      if (fab.style.display !== 'none') fab.style.display = 'none';
      if (panelOpen) togglePanel(false);
    }

    if (show) {
      if (maxFab) maxFab.style.display = '';
      if (mirrorFab) mirrorFab.style.display = '';
      if (zoomFab) zoomFab.style.display = mobile ? 'none' : '';
    } else {
      if (maxFab) maxFab.style.display = 'none';
      if (mirrorFab) mirrorFab.style.display = 'none';
      if (zoomFab) zoomFab.style.display = 'none';
    }

    layoutFabs();
  }

  function getFsRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fs) return document.documentElement;
    return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs;
  }
  function reparent() {
    const target = getFsRoot();
    const allFabs = [fab, maxFab, mirrorFab, zoomFab];
    for (const f of allFabs) {
      if (f && f.parentNode !== target) try { target.appendChild(f); } catch (_) {}
    }
    if (panel && panelOpen && panel.parentNode !== target) try { target.appendChild(panel); } catch (_) {}
  }
  function onFsChange() {
    reparent();
    setTimeout(reparent, 120);
    setTimeout(() => {
      const allFabs = [fab, maxFab, mirrorFab, zoomFab];
      for (const f of allFabs) {
        if (f && !f.isConnected) document.documentElement.appendChild(f);
      }
    }, 300);

    const best = pickBestVideo();
    setFabVisible(!!best || !!findBestIframe());
    if (shouldAnalyze()) {
      if (best) startAnalysis(best);
    } else {
      stopAnalysis();
    }

    if (!isFullscreen() && Zoom.isActive()) {
      Zoom.reset(true);
    }
  }

  /* ── tick ─────────────────────────────────────────────── */
  let shadowRetries = 0;
  const MAX_SHADOW_RETRIES = 5;

  function tick() {
    if (!shouldAnalyze()) {
      updateFabState('idle', 0);
      return;
    }
    if (!liveVideo || !liveVideo.isConnected) {
      liveVideo = null; stopAnalysis(); scheduleDetect(); return;
    }
    let res = sampleRGB(liveVideo);
    if (!res.ok) {
      const src = liveVideo.currentSrc || liveVideo.src;
      if (src && !shadowVid && !src.startsWith('blob:')) {
        if (panelOpen) setStatus('CORS 우회 시도…', false);
        makeShadow(src, liveVideo.currentTime);
        shadowRetries = 0;
      }
      if (shadowVid && shadowVid.readyState >= 2) { shadowVid.currentTime = liveVideo.currentTime; res = sampleRGB(shadowVid); }
    }
    if (!res.ok && shadowVid) {
      shadowRetries++;
      if (shadowRetries > MAX_SHADOW_RETRIES) {
        killShadow(); shadowRetries = 0;
        if (panelOpen) showError('CORS 우회 실패 — shadow 포기');
        updateFabState('error', 0);
      }
      return;
    }
    if (!res.ok) {
      if (panelOpen) showError('이 사이트는 픽셀 읽기가 차단됩니다\n(' + res.error + ')');
      updateFabState('error', 0); return;
    }
    if (panelOpen) clearError();
    shadowRetries = 0;
    history.push(res); if (history.length > CFG.histLen) history.shift();

    const tint = classifyTint(res.score);
    if (tint === 'warm') updateFabState('warn', res.score);
    else if (tint === 'cold') updateFabState('cold', res.score);
    else updateFabState('ok', res.score);

    if (panelOpen && panel) { renderUI(res); drawGraph(); }
  }

  /* ── 패널 UI 업데이트 ────────────────────────────────── */
  function q(id) { return panel?.querySelector('#' + id); }

  function renderUI({ r, g, b, score }) {
    const pct = v => (v / 255 * 100).toFixed(1) + '%';
    const rb = q('rb'); if (!rb) return;
    rb.style.width = pct(r); q('rv').textContent = Math.round(r);
    q('gb').style.width = pct(g); q('gv').textContent = Math.round(g);
    q('bb').style.width = pct(b); q('bv').textContent = Math.round(b);
    q('sv').textContent = score.toFixed(1);

    const bd = q('ytd-badge');
    const tint = classifyTint(score);
    if (tint === 'warm') { bd.textContent = '⚠️  노란끼 감지됨'; bd.className = 'warn'; }
    else if (tint === 'cold') { bd.textContent = '🧊  청색끼 감지됨'; bd.className = 'cold'; }
    else { bd.textContent = '✅  색조 정상'; bd.className = 'ok'; }

    const tempEl = q('ytd-temp');
    if (tempEl) {
      if (tint === 'ok') {
        tempEl.textContent = '권장 색온도 보정: 불필요';
        tempEl.className = 'ytd-temp ok';
      } else {
        const temp = scoreToTemp(score);
        if (tint === 'warm') {
          tempEl.textContent = `권장 색온도 보정: ${temp} (차갑게)`;
          tempEl.className = 'ytd-temp ' + (Math.abs(temp) >= 3 ? 'warn' : 'mild');
        } else {
          tempEl.textContent = `권장 색온도 보정: +${temp} (따뜻하게)`;
          tempEl.className = 'ytd-temp ' + (Math.abs(temp) >= 3 ? 'cold-warn' : 'cold-mild');
        }
      }
    }
  }

  function drawGraph() {
    const gc = q('ytd-gc'); if (!gc) return;
    const gx = gc.getContext('2d'), W = gc.width, H = gc.height;
    gx.clearRect(0, 0, W, H); if (history.length < 2) return;
    const scores = history.map(d => d.score);
    const maxAbs = Math.max(CFG.threshold * 2.2, Math.abs(CFG.coldThreshold) * 2.2, ...scores.map(s => Math.abs(s)));
    const hi = maxAbs, lo = -maxAbs, rng = hi - lo || 1;
    const ty = s => H - ((s - lo) / rng * (H - 10)) - 5;
    const tx = i => (i / (CFG.histLen - 1)) * W;
    const ox = CFG.histLen - history.length;

    gx.strokeStyle = 'rgba(200,200,200,.12)'; gx.lineWidth = 1; gx.setLineDash([2,3]);
    gx.beginPath(); gx.moveTo(0, ty(0)); gx.lineTo(W, ty(0)); gx.stroke();
    gx.strokeStyle = 'rgba(245,200,66,.2)';
    gx.beginPath(); gx.moveTo(0, ty(CFG.threshold)); gx.lineTo(W, ty(CFG.threshold)); gx.stroke();
    gx.strokeStyle = 'rgba(80,160,240,.2)';
    gx.beginPath(); gx.moveTo(0, ty(CFG.coldThreshold)); gx.lineTo(W, ty(CFG.coldThreshold)); gx.stroke();
    gx.setLineDash([]);

    gx.beginPath();
    history.forEach((d, i) => { const y = ty(Math.max(0, d.score)); i === 0 ? gx.moveTo(tx(i+ox), y) : gx.lineTo(tx(i+ox), y); });
    gx.lineTo(tx(ox+history.length-1), ty(0)); gx.lineTo(tx(ox), ty(0)); gx.closePath();
    const warmGrad = gx.createLinearGradient(0, ty(hi), 0, ty(0));
    warmGrad.addColorStop(0, 'rgba(245,200,66,.28)'); warmGrad.addColorStop(1, 'rgba(245,200,66,.02)');
    gx.fillStyle = warmGrad; gx.fill();

    gx.beginPath();
    history.forEach((d, i) => { const y = ty(Math.min(0, d.score)); i === 0 ? gx.moveTo(tx(i+ox), y) : gx.lineTo(tx(i+ox), y); });
    gx.lineTo(tx(ox+history.length-1), ty(0)); gx.lineTo(tx(ox), ty(0)); gx.closePath();
    const coldGrad = gx.createLinearGradient(0, ty(0), 0, ty(lo));
    coldGrad.addColorStop(0, 'rgba(80,160,240,.02)'); coldGrad.addColorStop(1, 'rgba(80,160,240,.28)');
    gx.fillStyle = coldGrad; gx.fill();

    gx.beginPath(); history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i+ox), ty(d.score)) : gx.lineTo(tx(i+ox), ty(d.score)));
    const lastScore = history[history.length - 1].score;
    const tint = classifyTint(lastScore);
    if (tint === 'warm') gx.strokeStyle = '#f5c842';
    else if (tint === 'cold') gx.strokeStyle = '#50a0f0';
    else gx.strokeStyle = '#50d070';
    gx.lineWidth = 1.5; gx.stroke();
  }

  function setStatus(txt, active) { const el = q('ytd-st'); if (!el) return; el.textContent = txt; el.className = active ? 'on' : ''; }
  function showError(msg) {
    const el = q('ytd-err'); if (!el) return; el.textContent = msg; el.style.display = 'block';
    const bd = q('ytd-badge'); if (bd) { bd.textContent = '❌  픽셀 읽기 실패'; bd.className = 'err'; }
    setStatus('오류', false);
  }
  function clearError() { const el = q('ytd-err'); if (el) el.style.display = 'none'; setStatus('분석 중', true); }

  /* ── 분석 시작/중지 ──────────────────────────────────── */
  function startAnalysis(video) {
    stopAnalysis(); liveVideo = video; history = []; shadowRetries = 0;
    if (panelOpen) setStatus('분석 중', true);
    timerID = setInterval(tick, CFG.intervalMs);
  }
  function stopAnalysis() {
    if (timerID) { clearInterval(timerID); timerID = null; }
    killShadow(); shadowRetries = 0; if (panelOpen) setStatus('대기', false);
    updateFabState('idle', 0);
  }

  function refreshVideoList() {
    const sel = q('ytd-sel');
    const videos = getAllVideos();
    if (sel) {
      sel.textContent = '';
      if (!videos.length) {
        sel.innerHTML = safeHTML('<option>영상 없음</option>');
        stopAnalysis();
        const bd = q('ytd-badge'); if (bd) { bd.textContent = '영상 없음'; bd.className = ''; }
        return;
      }
      videos.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `#${i+1} ${v.videoWidth||'?'}×${v.videoHeight||'?'} rs=${v.readyState}`;
        sel.appendChild(opt);
      });
      const prev = liveVideo ? videos.indexOf(liveVideo) : -1;
      sel.value = prev >= 0 ? prev : 0;
      startAnalysis(videos[+sel.value]);
    } else {
      if (!videos.length) { stopAnalysis(); return; }
      const prev = liveVideo ? videos.indexOf(liveVideo) : -1;
      startAnalysis(videos[prev >= 0 ? prev : 0]);
    }
  }

  /* ── 자동 감지 ───────────────────────────────────────── */
  let detectTimer = 0;
  function scheduleDetect() {
    if (detectTimer) return;
    detectTimer = setTimeout(() => { detectTimer = 0; autoDetect(); }, 300);
  }

  /* ── findBestIframe() — 비디오 src 우선 감지 ── */
  const VIDEO_SRC_RE = /\.(mp4|webm|ogg|m3u8)(\?.*)?$/i;

  function findBestIframe() {
    const iframes = document.querySelectorAll('iframe');
    let bestIframe = null, bestArea = 0;
    for (const ifr of iframes) {
      if (!ifr.isConnected) continue;
      const src = ifr.src || ifr.getAttribute('src') || '';
      if (VIDEO_SRC_RE.test(src)) {
        const r = ifr.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; bestIframe = ifr; }
      }
    }
    if (bestIframe) return bestIframe;
    bestArea = 0;
    for (const ifr of iframes) {
      if (!ifr.isConnected) continue;
      const r = ifr.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 10000) continue;
      if (area > bestArea) { bestArea = area; bestIframe = ifr; }
    }
    return bestIframe;
  }

  function autoDetect() {
    const best = pickBestVideo();
    const hasVid = !!best;
    const hasIframe = !hasVid && !!findBestIframe();
    setFabVisible(hasVid || hasIframe);

    if (!shouldAnalyze()) {
      if (timerID) stopAnalysis();
      liveVideo = best;
      return;
    }

    if (hasVid && best !== liveVideo) startAnalysis(best);
    else if (hasVid && !timerID) startAnalysis(best);
    else if (!hasVid && liveVideo) { stopAnalysis(); liveVideo = null; }
  }


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 통합 Transform 헬퍼
  ═════════════════════════════════════════════════════════════════════════ */
  function applyVideoTransform(video) {
    if (!video) return;
    const parts = [];
    const zs = Zoom.getState();
    if (zs.panX !== 0 || zs.panY !== 0) {
      parts.push(`translate(${zs.panX}px, ${zs.panY}px)`);
    }
    if (zs.scale !== 1) {
      parts.push(`scale(${zs.scale})`);
    }
    if (Mirror.isActive()) {
      parts.push('scaleX(-1)');
    }
    video.style.transform = parts.length ? parts.join(' ') : '';
    video.style.transformOrigin = 'center center';
  }


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 통합된 Video Maximizer 모듈 (v10.1.0)
  ═════════════════════════════════════════════════════════════════════════ */
  const Maximizer = (() => {
    const MAX_CLASS = 'ytd-vmax-max';
    const HIDE_CLASS = 'ytd-vmax-hide';
    const ANCESTOR_CLASS = 'ytd-vmax-ancestor';
    const IFRAME_MAX_CLASS = 'ytd-vmax-iframe';

    let active = false;
    let targetVideo = null;
    let targetIframe = null;
    let isIframeMode = false;
    let delegatedToTop = false;

    const savedElementsSet = new Set();
    const savedElementsList = [];
    let hiddenSiblings = [];
    let savedScrollX = 0, savedScrollY = 0;
    let classMO = null;
    let playerWrapper = null;

    /* ── 비디오 플레이어 컨트롤 판별 ─── */
    function isPlayerControlElement(el) {
      if (!el || el.nodeType !== 1) return false;
      const cn = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
      const id = (el.id || '').toLowerCase();
      const text = cn + ' ' + id;

      const strictKeywords = [
        'player-controls', 'player_controls', 'playercontrols',
        'video-controls', 'video_controls', 'videocontrols',
        'ctrl_bar', 'ctrl-bar', 'ctrlbar',
        'control-bar', 'control_bar', 'controlbar',
        'seekbar', 'seek-bar', 'seek_bar',
        'playbar', 'play-bar', 'play_bar',
        'vod-control', 'vod_control',
        'bottom_ctrl', 'bottom-ctrl',
        'player-bottom', 'player_bottom'
      ];
      for (const kw of strictKeywords) {
        if (text.includes(kw)) return true;
      }

      const role = el.getAttribute('role');
      if (role === 'slider' || role === 'toolbar') return true;

      return false;
    }

    /* ── 플레이어 래퍼 찾기 ────────── */
    function findPlayerWrapper(videoEl) {
      let el = videoEl.parentElement;
      let depth = 0;
      while (el && el !== document.body && el !== document.documentElement && depth < 6) {
        for (const child of el.children) {
          if (child === videoEl) continue;
          if (child.nodeType !== 1) continue;
          if (isPlayerControlElement(child)) return el;
        }
        try {
          const descendants = el.querySelectorAll(
            '[class*="control-bar"], [class*="controlbar"], [class*="seekbar"], ' +
            '[class*="playbar"], [role="slider"], [role="toolbar"]'
          );
          if (descendants.length >= 2) return el;
        } catch (_) {}
        el = el.parentElement;
        depth++;
      }
      return null;
    }

    /* ── iframe용 플레이어 래퍼 ── */
    function findIframePlayerWrapper(iframeEl) {
      let el = iframeEl.parentElement;
      let depth = 0;
      while (el && el !== document.body && el !== document.documentElement && depth < 8) {
        const text = ((el.className && typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '')).toLowerCase();
        const wrapperKeywords = [
          'player', 'htmlplayer', 'video-player', 'video_player',
          'player_area', 'player-area', 'playerarea',
          'player_wrap', 'player-wrap', 'playerwrap',
          'player_content', 'player-content', 'playercontent',
          'float_box', 'float-box', 'floatbox',
          'soop_player', 'soop-player'
        ];
        for (const kw of wrapperKeywords) {
          if (text.includes(kw)) return el;
        }
        el = el.parentElement;
        depth++;
      }
      return null;
    }

    function findIframeForWindow(childWin) {
      try {
        const iframes = document.querySelectorAll('iframe');
        for (const ifr of iframes) {
          try { if (ifr.contentWindow === childWin) return ifr; } catch (_) {}
        }
      } catch (_) {}
      return null;
    }

    function _backupApply(set, list, el, css) {
      if (!set.has(el)) {
        set.add(el); list.push(el);
        if (!el.__ytd_max_saved) el.__ytd_max_saved = {};
      }
      for (const prop in css) {
        if (!(prop in el.__ytd_max_saved)) {
          el.__ytd_max_saved[prop] = el.style.getPropertyValue(prop);
        }
        el.style.setProperty(prop, css[prop], 'important');
      }
    }

    function backupAndApplyStyle(el, css) {
      _backupApply(savedElementsSet, savedElementsList, el, css);
    }

    function restoreStyle(el) {
      if (!el.__ytd_max_saved) return;
      for (const prop in el.__ytd_max_saved) {
        const val = el.__ytd_max_saved[prop];
        if (val) el.style.setProperty(prop, val);
        else el.style.removeProperty(prop);
      }
      delete el.__ytd_max_saved;
    }

    /* ── 형제 숨기기 ── */
    function isOurElement(sib) {
      if (sib.tagName === 'SCRIPT' || sib.tagName === 'LINK' || sib.tagName === 'STYLE') return true;
      if (sib.id === '__ytd2__' || sib.id === 'ytd-osd' || sib.id === '__ytd3_core_style__' ||
          sib.id === '__ytd3_fab_style__' || sib.id === '__ytd2_style__') return true;
      if (sib.classList && sib.classList.contains('ytd-fab')) return true;
      if (sib === fab || sib === maxFab || sib === mirrorFab || sib === zoomFab || sib === panel) return true;
      return false;
    }

    function hideSiblingsOf(el) {
      if (!el.parentNode) return;
      for (const sib of el.parentNode.children) {
        if (sib === el || sib.nodeType !== 1) continue;
        if (isOurElement(sib)) continue;
        sib.classList.add(HIDE_CLASS);
        hiddenSiblings.push({ el: sib });
      }
    }

    /* ── clearAncestorChain() ─────── */
    function clearAncestorChain(startEl) {
      let ancestor = startEl.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        ancestor.dataset.ytdMaxAncestor = '1';
        backupAndApplyStyle(ancestor, {
          overflow: 'visible', position: 'static', transform: 'none',
          clip: 'auto', 'clip-path': 'none', contain: 'none',
          width: '100vw', height: '100vh',
          'max-width': 'none', 'max-height': 'none',
          margin: '0', padding: '0'
        });
        ancestor.classList.add(ANCESTOR_CLASS);
        hideSiblingsOf(ancestor);
        ancestor = ancestor.parentElement;
      }
    }

    function lockBody() {
      backupAndApplyStyle(document.body, { overflow: 'hidden', margin: '0', padding: '0' });
      if (document.documentElement) {
        backupAndApplyStyle(document.documentElement, { overflow: 'hidden' });
      }
    }

    function startClassGuard(primaryEl) {
      if (classMO) { classMO.disconnect(); classMO = null; }
      classMO = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== 'attributes' || m.attributeName !== 'class' || !active) continue;
          const el = m.target;
          if (el.dataset?.ytdMaxAncestor === '1' && !el.classList.contains(ANCESTOR_CLASS)) el.classList.add(ANCESTOR_CLASS);
        }
      });
      let cur = primaryEl.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        classMO.observe(cur, { attributes: true, attributeFilter: ['class'] });
        cur = cur.parentElement;
      }
    }

    function stopClassGuard() {
      if (classMO) { classMO.disconnect(); classMO = null; }
    }

    /* ── video 직접 최대화 ─────────────── */
    function doMaximizeDirect(video) {
      targetVideo = video;
      isIframeMode = false;
      savedScrollX = window.scrollX;
      savedScrollY = window.scrollY;

      playerWrapper = findPlayerWrapper(video);

      if (playerWrapper) {
        clearAncestorChain(playerWrapper);
        lockBody();
        backupAndApplyStyle(playerWrapper, {
          position: 'fixed', top: '0', left: '0',
          width: '100vw', height: '100dvh',
          'z-index': '2147483646', background: '#000',
          margin: '0', padding: '0', overflow: 'hidden'
        });
        backupAndApplyStyle(video, {
          width: '100%', height: '100%',
          'object-fit': 'contain'
        });
        hideSiblingsOf(playerWrapper);
        window.scrollTo(0, 0);
        startClassGuard(playerWrapper);
        applyVideoTransform(video);
      } else {
        clearAncestorChain(video);
        lockBody();
        backupAndApplyStyle(video, {});
        video.classList.add(MAX_CLASS);
        applyVideoTransform(video);
        hideSiblingsOf(video);
        window.scrollTo(0, 0);
        startClassGuard(video);
      }

      active = true;
      syncBtnUI();
      showOSD('최대화 ON (ESC 복원)', 1200);
    }

    /* ── ★ [v10.1.0 핵심 변경] doMaximizeIframe() — 래퍼 내부 형제 보존 ── */
    function doMaximizeIframe(iframeEl) {
      targetIframe = iframeEl;
      isIframeMode = true;
      savedScrollX = window.scrollX;
      savedScrollY = window.scrollY;

      playerWrapper = findIframePlayerWrapper(iframeEl);

      if (playerWrapper && playerWrapper !== document.body && playerWrapper !== document.documentElement) {
        // 래퍼 있음 (sooplive 등): 래퍼 단위 최대화
        clearAncestorChain(playerWrapper);
        lockBody();
        backupAndApplyStyle(playerWrapper, {
          position: 'fixed', top: '0', left: '0',
          width: '100vw', height: '100dvh',
          'z-index': '2147483646', background: '#000',
          margin: '0', padding: '0', overflow: 'hidden'
        });
        backupAndApplyStyle(iframeEl, {
          width: '100%', height: '100%',
          border: 'none', margin: '0', padding: '0'
        });
        // ★ v10.1.0: 래퍼의 형제만 숨기고, 래퍼 내부 형제는 숨기지 않음
        // (컨트롤바 등 iframe과 같은 래퍼 내부 요소 보존)
        hideSiblingsOf(playerWrapper);
        window.scrollTo(0, 0);
        startClassGuard(playerWrapper);
      } else {
        // 래퍼 없음 (fomos.kr 등) — iframe 직접 fixed 최대화
        clearAncestorChain(iframeEl);
        lockBody();
        backupAndApplyStyle(iframeEl, {
          position: 'fixed', top: '0', left: '0',
          width: '100vw', height: '100dvh',
          'z-index': '2147483646', background: '#000',
          border: 'none', margin: '0', padding: '0'
        });
        iframeEl.classList.add(IFRAME_MAX_CLASS);
        hideSiblingsOf(iframeEl);
        window.scrollTo(0, 0);
        startClassGuard(iframeEl);
      }

      active = true;
      syncBtnUI();
      showOSD('최대화 ON (ESC 복원)', 1200);

      // ★ v10.1.0: iframe 내부에는 "소프트" 메시지만 전달
      // position:fixed 를 사용하지 않고 overflow/크기 제약만 해제
      try { iframeEl.contentWindow.postMessage({ __ytd_max: 'apply_inner_soft' }, '*'); } catch (_) {}
    }

    function undoMaximize() {
      if (!active) return;
      stopClassGuard();
      if (isIframeMode && targetIframe) {
        try { targetIframe.contentWindow.postMessage({ __ytd_max: 'undo_inner' }, '*'); } catch (_) {}
        try { targetIframe.contentWindow.postMessage({ __ytd_max: 'state_off' }, '*'); } catch (_) {}
      }
      for (let i = hiddenSiblings.length - 1; i >= 0; i--) {
        const { el } = hiddenSiblings[i];
        try { el.classList.remove(HIDE_CLASS); } catch (_) {}
      }
      hiddenSiblings = [];
      for (let i = savedElementsList.length - 1; i >= 0; i--) {
        const el = savedElementsList[i];
        restoreStyle(el);
        try {
          el.classList.remove(MAX_CLASS, IFRAME_MAX_CLASS, ANCESTOR_CLASS);
          delete el.dataset.ytdMaxAncestor;
        } catch (_) {}
      }
      savedElementsList.length = 0;
      savedElementsSet.clear();
      playerWrapper = null;
      window.scrollTo(savedScrollX, savedScrollY);
      active = false;
      targetVideo = null;
      targetIframe = null;
      isIframeMode = false;
      const vid = pickBestVideo();
      if (vid) applyVideoTransform(vid);
      syncBtnUI();
      showOSD('최대화 OFF', 1200);
    }

    /* ── ★ [v10.1.0] iframe 내부 최대화 — 소프트 모드 추가 ── */
    let innerMaxActive = false;
    const innerSavedSet = new Set();
    const innerSavedList = [];

    function backupInner(el, css) {
      _backupApply(innerSavedSet, innerSavedList, el, css);
    }

    // ★ v10.1.0: 기존 "하드" 내부 최대화 (iframe이 스스로 요청한 경우)
    function applyInnerMaximize() {
      if (innerMaxActive) return;
      const video = pickBestVideo();
      if (!video) return;
      innerMaxActive = true;

      const wrapper = findPlayerWrapper(video);

      if (wrapper) {
        backupInner(wrapper, {
          position: 'fixed', top: '0', left: '0',
          width: '100vw', height: '100dvh',
          'z-index': '2147483646', background: '#000',
          margin: '0', padding: '0', overflow: 'hidden'
        });
        backupInner(video, {
          width: '100%', height: '100%',
          'object-fit': 'contain'
        });
        let ancestor = wrapper.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          backupInner(ancestor, {
            overflow: 'visible', position: 'static', transform: 'none',
            clip: 'auto', 'clip-path': 'none', contain: 'none'
          });
          ancestor = ancestor.parentElement;
        }
      } else {
        backupInner(video, {
          width: '100vw', height: '100dvh', 'object-fit': 'contain',
          position: 'fixed', top: '0', left: '0', 'z-index': '2147483646',
          background: '#000', margin: '0', padding: '0', border: 'none'
        });
        let ancestor = video.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          backupInner(ancestor, {
            overflow: 'visible', position: 'static', transform: 'none',
            clip: 'auto', 'clip-path': 'none', contain: 'none'
          });
          ancestor = ancestor.parentElement;
        }
      }

      backupInner(document.body, { overflow: 'hidden', margin: '0', padding: '0' });
      if (document.documentElement) backupInner(document.documentElement, { overflow: 'hidden' });
    }

    // ★ v10.1.0 신규: "소프트" 내부 최대화 — overflow/크기 제약만 해제, position:fixed 안 씀
    function applyInnerMaximizeSoft() {
      if (innerMaxActive) return;
      innerMaxActive = true;

      // body, html의 overflow만 해제하고 크기 제약만 풀어줌
      // 비디오와 플레이어 래퍼의 position/layout은 건드리지 않음
      // → iframe 내부 컨트롤바가 원래 위치에 그대로 유지됨
      if (document.body) {
        backupInner(document.body, {
          overflow: 'visible',
          'max-width': 'none', 'max-height': 'none'
        });
      }
      if (document.documentElement) {
        backupInner(document.documentElement, {
          overflow: 'visible',
          'max-width': 'none', 'max-height': 'none'
        });
      }

      // 비디오가 있으면 조상의 크기/overflow 제약만 풀어줌
      const video = pickBestVideo();
      if (video) {
        let ancestor = video.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && depth < 10) {
          backupInner(ancestor, {
            overflow: 'visible',
            'max-width': 'none', 'max-height': 'none',
            clip: 'auto', 'clip-path': 'none', contain: 'none'
          });
          ancestor = ancestor.parentElement;
          depth++;
        }
      }
    }

    function undoInnerMaximize() {
      if (!innerMaxActive) return;
      for (let i = innerSavedList.length - 1; i >= 0; i--) restoreStyle(innerSavedList[i]);
      innerSavedList.length = 0; innerSavedSet.clear();
      innerMaxActive = false;
    }

    function toggle() {
      if (isInIframe()) {
        if (delegatedToTop) {
          try { window.top.postMessage({ __ytd_max: 'undo' }, '*'); } catch (_) {}
          delegatedToTop = false;
          return;
        }
        try {
          window.top.postMessage({ __ytd_max: 'request' }, '*');
          delegatedToTop = true;
        } catch (_) {
          const video = pickBestVideo();
          if (video) doMaximizeDirect(video);
        }
        return;
      }
      if (active) { undoMaximize(); return; }
      const video = pickBestVideo();
      if (video) { doMaximizeDirect(video); return; }

      const bestIframe = findBestIframe();
      if (bestIframe) doMaximizeIframe(bestIframe);
      else showOSD('최대화할 비디오를 찾을 수 없습니다.', 1500);
    }

    function handleMessage(e) {
      if (!e.data || typeof e.data !== 'object' || !e.data.__ytd_max) return;
      const cmd = e.data.__ytd_max;
      if (!isInIframe()) {
        if (cmd === 'request') {
          const iframeEl = findIframeForWindow(e.source);
          if (iframeEl) {
            if (active) undoMaximize();
            doMaximizeIframe(iframeEl);
            try { e.source.postMessage({ __ytd_max: 'state_on' }, '*'); } catch (_) {}
          }
        }
        if (cmd === 'undo') { if (active) undoMaximize(); }
        return;
      }
      // ★ v10.1.0: 소프트 모드 메시지 처리
      if (cmd === 'apply_inner_soft') { applyInnerMaximizeSoft(); return; }
      if (cmd === 'apply_inner') { applyInnerMaximize(); return; }
      if (cmd === 'undo_inner') { undoInnerMaximize(); return; }
      if (cmd === 'state_on') { delegatedToTop = true; syncBtnUI(); return; }
      if (cmd === 'state_off') { delegatedToTop = false; syncBtnUI(); return; }
    }

    function syncBtnUI() {
      const isMax = active || delegatedToTop;
      if (maxFab) {
         maxFab.style.borderColor = isMax ? '#50d070' : '#2a2d36';
         const svg = maxFab.querySelector('svg path');
         if (svg) svg.style.stroke = isMax ? '#50d070' : '#4a5060';
      }
      const btn = document.getElementById('ytd-maximize');
      if (btn) btn.style.color = isMax ? '#50d070' : '';
    }

    window.addEventListener('message', handleMessage);

    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (active) {
        undoMaximize();
      } else if (delegatedToTop) {
        try { window.top.postMessage({ __ytd_max: 'undo' }, '*'); } catch (_) {}
        delegatedToTop = false;
        syncBtnUI();
        showOSD('최대화 OFF', 1200);
      }
    }, { capture: true });

    return {
      toggle,
      undoMaximize,
      isActive: () => active || delegatedToTop
    };
  })();


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 좌우 반전 (Mirror) 모듈
  ═════════════════════════════════════════════════════════════════════════ */
  const Mirror = (() => {
    let active = false;

    function on() {
      if (active) return;
      active = true;
      getAllVideos().forEach(v => applyVideoTransform(v));
      syncUI();
      showOSD('좌우 반전 ON', 1200);
    }

    function off() {
      if (!active) return;
      active = false;
      getAllVideos().forEach(v => applyVideoTransform(v));
      syncUI();
      showOSD('좌우 반전 OFF', 1200);
    }

    function toggle() { if (active) off(); else on(); }

    function onNewVideo(video) {
      if (active && video) applyVideoTransform(video);
    }

    function syncUI() {
      if (mirrorFab) {
        mirrorFab.style.borderColor = active ? '#00bcd4' : '#2a2d36';
        const svg = mirrorFab.querySelector('svg');
        if (svg) svg.querySelectorAll('path, polyline, line').forEach(p => p.style.stroke = active ? '#00bcd4' : '#4a5060');
      }
      const btn = document.getElementById('ytd-mirror');
      if (btn) btn.style.color = active ? '#00bcd4' : '';
    }

    return { toggle, on, off, isActive: () => active, onNewVideo, syncUI };
  })();


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 확대/축소 (Zoom) 모듈
  ═════════════════════════════════════════════════════════════════════════ */
  const Zoom = (() => {
    let scale = 1.0;
    let panX = 0, panY = 0;
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let panOriginX = 0, panOriginY = 0;

    const STEPS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
    const MIN_SCALE = 1.0;
    const MAX_SCALE = 5.0;
    const WHEEL_STEP = 0.15;

    function getState() { return { scale, panX, panY }; }

    function clampPan(video) {
      if (!video || scale <= 1.05) { panX = 0; panY = 0; return; }
      const w = video.clientWidth || 640, h = video.clientHeight || 360;
      const maxPanX = (w * scale - w) / 2, maxPanY = (h * scale - h) / 2;
      panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
      panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
    }

    function setScale(newScale, video, silent) {
      if (isMobile()) return;
      const prev = scale;
      scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(newScale * 100) / 100));
      if (scale <= 1.05) { scale = 1.0; panX = 0; panY = 0; }
      else clampPan(video);
      if (video) applyVideoTransform(video);
      syncUI();
      if (!silent && scale !== prev) {
        showOSD(scale === 1 ? '확대: 원본 (100%)' : `확대: ${Math.round(scale * 100)}%`, 1000);
      }
    }

    function reset(silent) {
      const video = pickBestVideo();
      if (scale === 1 && panX === 0 && panY === 0) return;
      scale = 1.0; panX = 0; panY = 0;
      if (video) applyVideoTransform(video);
      syncUI();
      if (!silent) showOSD('확대: 원본 (100%)', 1000);
    }

    function cycleStep() {
      if (isMobile()) return;
      const video = pickBestVideo();
      if (!video) { showOSD('확대/축소: 비디오를 찾을 수 없습니다.', 1500); return; }
      let nextIdx = 0;
      for (let i = 0; i < STEPS.length; i++) {
        if (scale >= STEPS[i] - 0.01) nextIdx = i + 1;
      }
      if (nextIdx >= STEPS.length) nextIdx = 0;
      setScale(STEPS[nextIdx], video);
    }

    function onWheel(e) {
      if (isMobile()) return;
      if (!e.altKey) return;
      const video = pickBestVideo();
      if (!video) return;
      const rect = video.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP;
      setScale(scale + delta, video);
    }

    function onMouseDown(e) {
      if (isMobile()) return;
      if (scale <= 1.05) return;
      if (!e.altKey || e.button !== 0) return;
      const video = pickBestVideo();
      if (!video) return;
      const rect = video.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      if (e.target.closest('.ytd-fab')) return;
      e.preventDefault();
      e.stopPropagation();
      isPanning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panOriginX = panX; panOriginY = panY;
      document.body.style.cursor = 'grabbing';
    }

    function onMouseMove(e) {
      if (!isPanning) return;
      e.preventDefault();
      panX = panOriginX + (e.clientX - panStartX);
      panY = panOriginY + (e.clientY - panStartY);
      const video = pickBestVideo();
      if (video) { clampPan(video); applyVideoTransform(video); }
    }

    function onMouseUp(e) {
      if (!isPanning) return;
      isPanning = false;
      document.body.style.cursor = '';
    }

    function syncUI() {
      const isZoomed = scale > 1.05;
      const color = isZoomed ? '#e040fb' : '#2a2d36';
      const strokeColor = isZoomed ? '#e040fb' : '#4a5060';
      if (zoomFab) {
        zoomFab.style.borderColor = color;
        const svg = zoomFab.querySelector('svg');
        if (svg) svg.querySelectorAll('circle, line, path').forEach(p => p.style.stroke = strokeColor);
        let label = zoomFab.querySelector('.ytd-zoom-label');
        if (!label) {
          label = document.createElement('span');
          label.className = 'ytd-zoom-label';
          label.style.cssText = 'position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);font:900 9px/1 monospace;color:#4a5060;background:#15171c;padding:1px 3px;border-radius:4px;border:1px solid #2a2d36;pointer-events:none;white-space:nowrap;min-width:20px;text-align:center;transition:all .3s ease';
          zoomFab.appendChild(label);
        }
        if (isZoomed) {
          label.textContent = Math.round(scale * 100) + '%';
          label.style.color = '#e040fb';
          label.style.borderColor = '#3a1040';
        } else {
          label.textContent = '';
          label.style.color = '#4a5060';
          label.style.borderColor = '#2a2d36';
        }
      }
      const btn = document.getElementById('ytd-zoom');
      if (btn) btn.style.color = isZoomed ? '#e040fb' : '';
    }

    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && scale > 1.0 && !Maximizer.isActive()) {
        reset();
      }
    }, { capture: true });

    if (!isMobile()) {
      document.addEventListener('wheel', onWheel, { passive: false, capture: true });
      document.addEventListener('mousedown', onMouseDown, { capture: true });
      document.addEventListener('mousemove', onMouseMove, { capture: true });
      document.addEventListener('mouseup', onMouseUp, { capture: true });
    }

    return {
      getState,
      setScale,
      reset,
      cycleStep,
      syncUI,
      isActive: () => scale > 1.05
    };
  })();


  /* ── FAB 빌드 (4개: Zoom, Mirror, Max, Main) ──────── */
  function buildFab() {
    if (fab) return;

    const mobile = isMobile();

    if (!coreStyle || !coreStyle.isConnected) {
      coreStyle?.remove();
      coreStyle = document.createElement('style');
      coreStyle.id = '__ytd3_core_style__';
      coreStyle.textContent = `
  .ytd-vmax-max{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;margin:0!important;padding:0!important;border:none!important;}
  .ytd-vmax-hide{display:none!important;}
  .ytd-vmax-ancestor{overflow:visible!important;position:static!important;transform:none!important;clip:auto!important;clip-path:none!important;contain:none!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;}
  .ytd-vmax-iframe{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;z-index:2147483646!important;border:none!important;margin:0!important;padding:0!important;max-width:100vw!important;max-height:100vh!important;background:#000!important;}
`;
      document.documentElement.appendChild(coreStyle);
    }

    fabStyle = document.createElement('style'); fabStyle.id = '__ytd3_fab_style__';
    fabStyle.textContent = `
      .ytd-fab{position:fixed;top:40px;z-index:2147483647;opacity:0.5;width:40px;height:40px;border-radius:50%;background:#15171c;border:2px solid #2a2d36;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .35s cubic-bezier(.16,1,.3,1);box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;-webkit-tap-highlight-color:transparent}
      @media (hover: hover){.ytd-fab:hover{transform:scale(1.12);border-color:#3a3d48;box-shadow:0 6px 24px rgba(0,0,0,.6)}}
      @media (hover: none){.ytd-fab{opacity:0.25}}
      .ytd-fab-icon{width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center}
      .ytd-fab-icon svg{width:18px;height:18px}
      .ytd-fab-ring{position:absolute;top:-4px;left:-4px;right:-4px;bottom:-4px;border-radius:50%;border:2px solid transparent;transition:all .4s ease;pointer-events:none}
      .ytd-fab-dot{position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;background:transparent;border:2px solid #15171c;transition:all .3s ease;pointer-events:none}
      .ytd-fab-score{position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);font:900 12px/1 monospace;color:#4a5060;background:#15171c;padding:1px 4px;border-radius:6px;border:1px solid #2a2d36;pointer-events:none;transition:all .3s ease;min-width:24px;text-align:center}
      .ytd-fab-clock{position:absolute;bottom:-25px;left:50%;transform:translateX(-50%);font:900 15px/1 monospace;color:#8a94a8;text-shadow:0 1px 4px rgba(0,0,0,0.85);pointer-events:none;white-space:nowrap;transition:color .3s ease}
      .ytd-fab--idle{border-color:#2a2d36}
      .ytd-fab--idle .ytd-fab-icon svg{fill:#4a5060;stroke:#4a5060}
      .ytd-fab--idle .ytd-fab-dot{background:transparent}
      .ytd-fab--idle .ytd-fab-score{color:#4a5060;border-color:#2a2d36}
      .ytd-fab--idle .ytd-fab-clock{color:#8a94a8}
      .ytd-fab--ok{border-color:#1a3a22}
      .ytd-fab--ok .ytd-fab-icon svg{fill:none;stroke:#50d070}
      .ytd-fab--ok .ytd-fab-ring{border-color:rgba(80,208,112,.15)}
      .ytd-fab--ok .ytd-fab-dot{background:#50d070;box-shadow:0 0 6px rgba(80,208,112,.5)}
      .ytd-fab--ok .ytd-fab-score{color:#50d070;border-color:#1a3a22}
      .ytd-fab--ok .ytd-fab-clock{color:#50d070}
      .ytd-fab--warn{border-color:#f5c842;box-shadow:0 0 16px rgba(245,200,66,.25),0 0 40px rgba(245,200,66,.08),0 4px 16px rgba(0,0,0,.5);animation:ytd-fab-pulse 1.8s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-icon svg{fill:none;stroke:#f5c842}
      .ytd-fab--warn .ytd-fab-ring{border-color:rgba(245,200,66,.35);box-shadow:0 0 12px rgba(245,200,66,.15);animation:ytd-ring-pulse 1.8s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-dot{background:#f5c842;box-shadow:0 0 8px rgba(245,200,66,.7);animation:ytd-dot-blink 1s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-score{color:#f5c842;border-color:#4a3800;background:#1f1a08}
      .ytd-fab--warn .ytd-fab-clock{color:#f5c842}
      .ytd-fab--cold{border-color:#50a0f0;box-shadow:0 0 16px rgba(80,160,240,.25),0 0 40px rgba(80,160,240,.08),0 4px 16px rgba(0,0,0,.5);animation:ytd-fab-pulse-cold 1.8s ease-in-out infinite}
      .ytd-fab--cold .ytd-fab-icon svg{fill:none;stroke:#50a0f0}
      .ytd-fab--cold .ytd-fab-ring{border-color:rgba(80,160,240,.35);box-shadow:0 0 12px rgba(80,160,240,.15);animation:ytd-ring-pulse-cold 1.8s ease-in-out infinite}
      .ytd-fab--cold .ytd-fab-dot{background:#50a0f0;box-shadow:0 0 8px rgba(80,160,240,.7);animation:ytd-dot-blink 1s ease-in-out infinite}
      .ytd-fab--cold .ytd-fab-score{color:#50a0f0;border-color:#0a2a4a;background:#081828}
      .ytd-fab--cold .ytd-fab-clock{color:#50a0f0}
      .ytd-fab--error{border-color:#3a1515}
      .ytd-fab--error .ytd-fab-icon svg{fill:none;stroke:#e06060}
      .ytd-fab--error .ytd-fab-dot{background:#e06060;box-shadow:0 0 6px rgba(224,96,96,.5)}
      .ytd-fab--error .ytd-fab-score{color:#e06060;border-color:#3a1515}
      .ytd-fab--error .ytd-fab-clock{color:#e06060}
      @keyframes ytd-fab-pulse{0%,100%{box-shadow:0 0 16px rgba(245,200,66,.25),0 0 40px rgba(245,200,66,.08),0 4px 16px rgba(0,0,0,.5)}50%{box-shadow:0 0 24px rgba(245,200,66,.4),0 0 60px rgba(245,200,66,.12),0 4px 16px rgba(0,0,0,.5)}}
      @keyframes ytd-fab-pulse-cold{0%,100%{box-shadow:0 0 16px rgba(80,160,240,.25),0 0 40px rgba(80,160,240,.08),0 4px 16px rgba(0,0,0,.5)}50%{box-shadow:0 0 24px rgba(80,160,240,.4),0 0 60px rgba(80,160,240,.12),0 4px 16px rgba(0,0,0,.5)}}
      @keyframes ytd-ring-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.1);opacity:.6}}
      @keyframes ytd-ring-pulse-cold{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.1);opacity:.6}}
      @keyframes ytd-dot-blink{0%,100%{opacity:1}50%{opacity:.3}}`;
    document.documentElement.appendChild(fabStyle);

    const svgNS = 'http://www.w3.org/2000/svg';

    fab = document.createElement('div'); fab.className = 'ytd-fab ytd-fab--idle'; fab.style.display = 'none'; fab.style.right = FAB_START_RIGHT + 'px';
    const iconWrap = document.createElement('div'); iconWrap.className = 'ytd-fab-icon';
    const svg = document.createElementNS(svgNS,'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke-width','2'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round');
    const circle = document.createElementNS(svgNS,'circle'); circle.setAttribute('cx','12'); circle.setAttribute('cy','12'); circle.setAttribute('r','5'); svg.appendChild(circle);
    [[12,1,12,3],[12,21,12,23],[4.22,4.22,5.64,5.64],[18.36,18.36,19.78,19.78],[1,12,3,12],[21,12,23,12],[4.22,19.78,5.64,18.36],[18.36,5.64,19.78,4.22]].forEach(([x1,y1,x2,y2])=>{const ln=document.createElementNS(svgNS,'line');ln.setAttribute('x1',x1);ln.setAttribute('y1',y1);ln.setAttribute('x2',x2);ln.setAttribute('y2',y2);svg.appendChild(ln);});
    iconWrap.appendChild(svg);
    iconWrap.appendChild(Object.assign(document.createElement('div'),{className:'ytd-fab-ring'}));
    iconWrap.appendChild(Object.assign(document.createElement('div'),{className:'ytd-fab-dot'}));
    fab.appendChild(iconWrap);
    fab.appendChild(Object.assign(document.createElement('span'),{className:'ytd-fab-score'}));
    const clockSpan = document.createElement('span'); clockSpan.className = 'ytd-fab-clock'; clockSpan.textContent = '--:--'; fab.appendChild(clockSpan);

    maxFab = document.createElement('div'); maxFab.className = 'ytd-fab ytd-fab--idle'; maxFab.style.display = 'none'; maxFab.title = "화면 최대화/해제";
    const maxIconWrap = document.createElement('div'); maxIconWrap.className = 'ytd-fab-icon';
    const maxSvg = document.createElementNS(svgNS,'svg'); maxSvg.setAttribute('viewBox','0 0 24 24'); maxSvg.setAttribute('fill','none'); maxSvg.setAttribute('stroke-width','2'); maxSvg.setAttribute('stroke-linecap','round'); maxSvg.setAttribute('stroke-linejoin','round');
    const maxPath = document.createElementNS(svgNS, 'path');
    maxPath.setAttribute('d', 'M15,3L21,3L21,9 M9,21L3,21L3,15 M21,3L14,10 M3,21L10,14');
    maxPath.style.stroke = '#4a5060';
    maxSvg.appendChild(maxPath); maxIconWrap.appendChild(maxSvg); maxFab.appendChild(maxIconWrap);

    mirrorFab = document.createElement('div'); mirrorFab.className = 'ytd-fab ytd-fab--idle'; mirrorFab.style.display = 'none'; mirrorFab.title = "좌우 반전";
    const mirrorIconWrap = document.createElement('div'); mirrorIconWrap.className = 'ytd-fab-icon';
    const mirrorSvg = document.createElementNS(svgNS,'svg'); mirrorSvg.setAttribute('viewBox','0 0 24 24'); mirrorSvg.setAttribute('fill','none'); mirrorSvg.setAttribute('stroke-width','2'); mirrorSvg.setAttribute('stroke-linecap','round'); mirrorSvg.setAttribute('stroke-linejoin','round');
    const mirrorPath1 = document.createElementNS(svgNS, 'polyline'); mirrorPath1.setAttribute('points', '7,8 3,12 7,16'); mirrorPath1.style.stroke = '#4a5060'; mirrorPath1.style.fill = 'none';
    const mirrorPath2 = document.createElementNS(svgNS, 'polyline'); mirrorPath2.setAttribute('points', '17,8 21,12 17,16'); mirrorPath2.style.stroke = '#4a5060'; mirrorPath2.style.fill = 'none';
    const mirrorLine1 = document.createElementNS(svgNS, 'line'); mirrorLine1.setAttribute('x1','3'); mirrorLine1.setAttribute('y1','12'); mirrorLine1.setAttribute('x2','10'); mirrorLine1.setAttribute('y2','12'); mirrorLine1.style.stroke = '#4a5060';
    const mirrorLine2 = document.createElementNS(svgNS, 'line'); mirrorLine2.setAttribute('x1','14'); mirrorLine2.setAttribute('y1','12'); mirrorLine2.setAttribute('x2','21'); mirrorLine2.setAttribute('y2','12'); mirrorLine2.style.stroke = '#4a5060';
    const mirrorCenter = document.createElementNS(svgNS, 'line'); mirrorCenter.setAttribute('x1','12'); mirrorCenter.setAttribute('y1','5'); mirrorCenter.setAttribute('x2','12'); mirrorCenter.setAttribute('y2','19'); mirrorCenter.setAttribute('stroke-dasharray','2,2'); mirrorCenter.style.stroke = '#4a5060';
    mirrorSvg.appendChild(mirrorPath1); mirrorSvg.appendChild(mirrorPath2); mirrorSvg.appendChild(mirrorLine1); mirrorSvg.appendChild(mirrorLine2); mirrorSvg.appendChild(mirrorCenter);
    mirrorIconWrap.appendChild(mirrorSvg); mirrorFab.appendChild(mirrorIconWrap);

    if (!mobile) {
      zoomFab = document.createElement('div'); zoomFab.className = 'ytd-fab ytd-fab--idle'; zoomFab.style.display = 'none'; zoomFab.title = "확대/축소 (Alt+휠 | 클릭: 단계 순환)";
      const zoomIconWrap = document.createElement('div'); zoomIconWrap.className = 'ytd-fab-icon';
      const zoomSvg = document.createElementNS(svgNS,'svg'); zoomSvg.setAttribute('viewBox','0 0 24 24'); zoomSvg.setAttribute('fill','none'); zoomSvg.setAttribute('stroke-width','2'); zoomSvg.setAttribute('stroke-linecap','round'); zoomSvg.setAttribute('stroke-linejoin','round');
      const zoomCircle = document.createElementNS(svgNS, 'circle'); zoomCircle.setAttribute('cx','11'); zoomCircle.setAttribute('cy','11'); zoomCircle.setAttribute('r','8'); zoomCircle.style.stroke = '#4a5060';
      const zoomLine = document.createElementNS(svgNS, 'line'); zoomLine.setAttribute('x1','21'); zoomLine.setAttribute('y1','21'); zoomLine.setAttribute('x2','16.65'); zoomLine.setAttribute('y2','16.65'); zoomLine.style.stroke = '#4a5060';
      const zp1 = document.createElementNS(svgNS, 'line'); zp1.setAttribute('x1','11'); zp1.setAttribute('y1','8'); zp1.setAttribute('x2','11'); zp1.setAttribute('y2','14'); zp1.style.stroke = '#4a5060';
      const zp2 = document.createElementNS(svgNS, 'line'); zp2.setAttribute('x1','8'); zp2.setAttribute('y1','11'); zp2.setAttribute('x2','14'); zp2.setAttribute('y2','11'); zp2.style.stroke = '#4a5060';
      zoomSvg.appendChild(zoomCircle); zoomSvg.appendChild(zoomLine); zoomSvg.appendChild(zp1); zoomSvg.appendChild(zp2);
      zoomIconWrap.appendChild(zoomSvg); zoomFab.appendChild(zoomIconWrap);
      document.documentElement.appendChild(zoomFab);
    }

    document.documentElement.appendChild(mirrorFab);
    document.documentElement.appendChild(maxFab);
    document.documentElement.appendChild(fab);

    let dragging = false, moved = false, dragStartX = 0, dragStartY = 0;
    const dragOrigins = new Map();

    const activeFabList = () => [fab, maxFab, mirrorFab, zoomFab].filter(Boolean);

    const onDown = (e, targetEl) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragOrigins.clear();
      for (const f of activeFabList()) {
        const r = f.getBoundingClientRect();
        dragOrigins.set(f, { x: r.left, y: r.top });
      }
      targetEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      for (const f of activeFabList()) {
        const o = dragOrigins.get(f);
        if (!o) continue;
        f.style.left = (o.x + dx) + 'px'; f.style.top = (o.y + dy) + 'px'; f.style.right = 'auto';
      }
    };

    const fabActions = new Map([
      [fab,       () => togglePanel()],
      [maxFab,    () => Maximizer.toggle()],
      [mirrorFab, () => Mirror.toggle()],
    ]);
    if (zoomFab) {
      fabActions.set(zoomFab, () => Zoom.cycleStep());
    }

    for (const [btn, action] of fabActions) {
      btn.addEventListener('pointerdown', e => onDown(e, btn));
      btn.addEventListener('pointermove', onMove);
      btn.addEventListener('pointerup', e => {
        if (!dragging) return;
        dragging = false;
        btn.releasePointerCapture(e.pointerId);
        if (!moved) action();
      });
    }

    startClock();
  }

  /* ── 패널 빌드 ────────────────────────── */
  function buildPanel() {
    const el = document.createElement('div'); el.id = '__ytd2__';
    const mobile = isMobile();
    const zoomBtnHTML = mobile ? '' : '<button id="ytd-zoom" title="확대 리셋">🔍</button>';
    el.innerHTML = safeHTML(`
      <div id="ytd-hdr">
        <span>🔍 Tint Detector</span>
        <div style="display:flex; gap:6px;">
          ${zoomBtnHTML}
          <button id="ytd-mirror" title="좌우 반전">↔</button>
          <button id="ytd-maximize" title="최대화/해제">🗖</button>
          <button id="ytd-refresh" title="재탐색">↺</button>
          <button id="ytd-close" title="닫기">✕</button>
        </div>
      </div>
      <div id="ytd-badge">초기화 중…</div>
      <div id="ytd-bars">
        <div class="row"><span>R</span><div class="trk"><div id="rb" class="fill" style="background:#e05858"></div></div><span id="rv">—</span></div>
        <div class="row"><span>G</span><div class="trk"><div id="gb" class="fill" style="background:#5ab85a"></div></div><span id="gv">—</span></div>
        <div class="row"><span>B</span><div class="trk"><div id="bb" class="fill" style="background:#5090e0"></div></div><span id="bv">—</span></div>
      </div>
      <div id="ytd-score"><span>Tint Score</span><b id="sv">—</b></div>
      <div id="ytd-temp" class="ytd-temp">권장 색온도 보정: —</div>
      <canvas id="ytd-gc" width="216" height="64"></canvas>
      <div id="ytd-foot"><select id="ytd-sel"></select><span id="ytd-st">대기</span></div>
      <div id="ytd-err"></div>`);
    getFsRoot().appendChild(el);
    panelStyle = document.createElement('style'); panelStyle.id = '__ytd2_style__';
    panelStyle.textContent = `
      #__ytd2__{position:fixed;top:70px;right:64px;width:236px;background:#101215;color:#ccd0d8;font:11.5px/1.5 monospace;border:1px solid #252830;border-radius:10px;box-shadow:0 8px 32px #000a;z-index:2147483646;overflow:hidden;opacity:0;transform:translateX(12px) scale(.95);transition:opacity .25s cubic-bezier(.16,1,.3,1),transform .3s cubic-bezier(.34,1.56,.64,1);pointer-events:none}
      #__ytd2__.open{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
      #ytd-hdr{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#181b21;border-bottom:1px solid #252830;cursor:move;font-size:11px;color:#7a8499;letter-spacing:.05em}
      #ytd-hdr button{background:none;border:none;color:#4a5060;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;transition:color .2s}
      #ytd-hdr button:hover{color:#ccd0d8}
      #ytd-badge{margin:9px 10px 2px;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-align:center;background:#1a1d24;color:#7a8499;transition:background .25s,color .25s}
      #ytd-badge.warn{background:#2c1f00;color:#f5c842}
      #ytd-badge.cold{background:#0a1a2c;color:#50a0f0}
      #ytd-badge.ok{background:#0b1f10;color:#50d070}
      #ytd-badge.err{background:#200a0a;color:#e06060}
      #ytd-bars{padding:7px 10px 4px;display:flex;flex-direction:column;gap:5px}
      .row{display:flex;align-items:center;gap:5px}
      .row>span:first-child{width:10px;font-size:10px;color:#4a5060}
      .row>span:last-child{width:28px;text-align:right;font-size:10px;color:#7a8499}
      .trk{flex:1;height:5px;background:#1a1d24;border-radius:3px;overflow:hidden}
      .fill{height:100%;width:0;border-radius:3px;transition:width .35s}
      #ytd-score{display:flex;justify-content:space-between;align-items:center;padding:5px 10px;border-top:1px solid #1a1d24;margin-top:3px;font-size:10px;color:#4a5060}
      #ytd-score b{font-size:14px;color:#ccd0d8}
      .ytd-temp{font-size:11px;font-weight:600;text-align:center;padding:4px 10px;margin:2px 10px;border-radius:5px;background:#1a1d24;color:#7a8499;transition:all .25s}
      .ytd-temp.ok{color:#50d070}
      .ytd-temp.mild{color:#d4a84a}
      .ytd-temp.warn{color:#f5c842;background:#2c1f00}
      .ytd-temp.cold-mild{color:#70b0e0}
      .ytd-temp.cold-warn{color:#50a0f0;background:#0a1a2c}
      #ytd-gc{display:block;margin:4px 10px 6px;width:calc(100% - 20px);background:#0b0d10;border-radius:4px}
      #ytd-foot{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-top:1px solid #252830;background:#181b21}
      #ytd-sel{flex:1;max-width:134px;background:#1a1d24;color:#7a8499;border:1px solid #252830;border-radius:4px;font-size:10px;padding:2px 4px}
      #ytd-st{font-size:10px;color:#4a5060}
      #ytd-st.on{color:#50d070;animation:ytdblink 1.3s infinite}
      #ytd-err{padding:0 10px 7px;font-size:10px;color:#c04040;word-break:break-all;display:none;line-height:1.45}
      @keyframes ytdblink{0%,100%{opacity:1}50%{opacity:.3}}
    `;
    document.documentElement.appendChild(panelStyle);
    return el;
  }

  function ensurePanel() {
    if (panel && document.documentElement.contains(panel)) return;
    if (panel && getFsRoot().contains(panel)) return;
    panel = buildPanel(); bindPanelEvents();
  }
  function destroyPanel() { if (!panel) return; panel.remove(); panel = null; if (panelStyle) { panelStyle.remove(); panelStyle = null; } panelOpen = false; }

  function bindPanelEvents() {
    q('ytd-sel').addEventListener('change', () => { const videos = getAllVideos(); const v = videos[+q('ytd-sel').value]; if (v) startAnalysis(v); });
    const zoomBtn = q('ytd-zoom');
    if (zoomBtn) zoomBtn.addEventListener('click', () => Zoom.reset());
    q('ytd-mirror').addEventListener('click', () => Mirror.toggle());
    q('ytd-maximize').addEventListener('click', () => Maximizer.toggle());
    q('ytd-refresh').addEventListener('click', refreshVideoList);
    q('ytd-close').addEventListener('click', () => togglePanel(false));
    Mirror.syncUI();
    Zoom.syncUI();

    let dragging = false, dx = 0, dy = 0;
    q('ytd-hdr').addEventListener('pointerdown', e => { if (e.button !== 0) return; dragging = true; const r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; e.target.setPointerCapture(e.pointerId); });
    q('ytd-hdr').addEventListener('pointermove', e => { if (!dragging) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; });
    q('ytd-hdr').addEventListener('pointerup', () => { dragging = false; });
  }

  function togglePanel(force) {
    panelOpen = force !== undefined ? force : !panelOpen;
    if (panelOpen) { ensurePanel(); panel.classList.add('open'); refreshVideoList(); if (history.length > 0) { renderUI(history[history.length - 1]); drawGraph(); } }
    else { if (panel) panel.classList.remove('open'); setTimeout(() => { if (!panelOpen) destroyPanel(); }, 350); }
  }

  /* ── 시작 ────────────────────────────────────────────── */
  function init() {
    buildFab();
    autoDetect();

    new MutationObserver(() => scheduleDetect())
      .observe(document.body || document.documentElement, { childList: true, subtree: true });

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    setInterval(() => {
      if (liveVideo && !liveVideo.isConnected) { liveVideo = null; }
      autoDetect();
      if (Mirror.isActive()) {
        const best = pickBestVideo();
        if (best) Mirror.onNewVideo(best);
      }
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
