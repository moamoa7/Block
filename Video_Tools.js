// ==UserScript==
// @name         Video Tools
// @namespace    https://github.com/moamoa7
// @version      11.0.0
// @description  영상의 노란끼/청색끼 감지 + 항상 보이는 시계 + 좌우 반전 + 확대/축소
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
  let history = [], panel = null, fab = null, mirrorFab = null, zoomFab = null, fabStyle = null, panelStyle = null;
  let panelOpen = false, lastStatus = 'idle';

  let offscreen, oCtx;
  function resetCanvas() {
    offscreen = document.createElement('canvas');
    offscreen.width = offscreen.height = CFG.sampleSize;
    oCtx = offscreen.getContext('2d', { willReadFrequently: true });
  }
  resetCanvas();

  /* ── 모바일 / 전체화면 판별 ─────────────────────────── */
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
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

  /* ── FAB 위치 ───────────────────────────────────────── */
  const FAB_START_RIGHT = 5;
  const FAB_GAP = 50;

  function layoutFabs() {
    const ordered = [fab, mirrorFab, zoomFab];
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
      if (mirrorFab) mirrorFab.style.display = '';
      if (zoomFab) zoomFab.style.display = mobile ? 'none' : '';
    } else {
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
    const allFabs = [fab, mirrorFab, zoomFab];
    for (const f of allFabs) {
      if (f && f.parentNode !== target) try { target.appendChild(f); } catch (_) {}
    }
    if (panel && panelOpen && panel.parentNode !== target) try { target.appendChild(panel); } catch (_) {}
  }
  function onFsChange() {
    reparent();
    setTimeout(reparent, 120);
    setTimeout(() => {
      const allFabs = [fab, mirrorFab, zoomFab];
      for (const f of allFabs) {
        if (f && !f.isConnected) document.documentElement.appendChild(f);
      }
    }, 300);

    const best = pickBestVideo();
    setFabVisible(!!best);
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

  function autoDetect() {
    const best = pickBestVideo();
    const hasVid = !!best;
    setFabVisible(hasVid);

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

    function onMouseUp() {
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
      if (e.key === 'Escape' && scale > 1.0) {
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


  /* ── FAB 빌드 (3개: Zoom, Mirror, Main) ────────────── */
  function buildFab() {
    if (fab) return;

    const mobile = isMobile();

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
    document.documentElement.appendChild(fab);

    let dragging = false, moved = false, dragStartX = 0, dragStartY = 0;
    const dragOrigins = new Map();

    const activeFabList = () => [fab, mirrorFab, zoomFab].filter(Boolean);

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
