// ==UserScript==
// @name         Yellow Tint Detector (with Maximizer & Mobile Zoom)
// @namespace    https://github.com/
// @version      3.9.6
// @description  영상의 노란끼 감지 + 비디오 최대화 + PC/모바일 완벽 지원 줌(Zoom) 기능
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
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

  const CFG = { sampleSize: 48, intervalMs: 1000, threshold: 12, histLen: 24, tempPerScore: 5 };

  let timerID = null, clockTimer = null, liveVideo = null, shadowVid = null;
  let history = [], panel = null, fab = null, maxFab = null, zoomFab = null, fabStyle = null, panelStyle = null;
  let panelOpen = false, lastStatus = 'idle';

  let offscreen, oCtx;
  function resetCanvas() {
    offscreen = document.createElement('canvas');
    offscreen.width = offscreen.height = CFG.sampleSize;
    oCtx = offscreen.getContext('2d', { willReadFrequently: true });
  }
  resetCanvas();

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

  /* ── cross-origin 조기 주입 ──────────────────────────── */
  const injected = new WeakSet();
  function injectCrossOrigin(v) {
    if (injected.has(v)) return; injected.add(v);
    if (!v.src && !v.currentSrc) v.crossOrigin = 'anonymous';
    else if (v.readyState === 0) v.crossOrigin = 'anonymous';
  }
  new MutationObserver(muts => {
    for (const m of muts)
      for (const n of m.addedNodes) {
        if (n.nodeName === 'VIDEO') injectCrossOrigin(n);
        if (n.querySelectorAll) n.querySelectorAll('video').forEach(injectCrossOrigin);
      }
  }).observe(document.documentElement, { childList: true, subtree: true });

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
      return { ok: true, r, g, b, score: (r - b) + (g - b) * 0.5 };
    } catch (e) { resetCanvas(); return { ok: false, error: e.name + ': ' + e.message }; }
  }

  function makeShadow(src, currentTime) {
    killShadow();
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true;
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.001;top:0;left:0;pointer-events:none';
    document.body.appendChild(v);
    v.src = src; v.currentTime = currentTime || 0;
    v.play().catch(() => {}); shadowVid = v; return v;
  }
  function killShadow() { if (!shadowVid) return; shadowVid.src = ''; shadowVid.remove(); shadowVid = null; }
  function scoreToTemp(score) { return score <= 0 ? 0 : -(Math.round(score / CFG.tempPerScore)); }

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
      else { const t = scoreToTemp(score); scoreEl.textContent = t === 0 ? '0' : String(t); }
    }
    fab.className = 'ytd-fab ytd-fab--' + status;
  }

  function setFabVisible(show) {
    if (!fab) return;
    if (show) { 
      if (fab.style.display === 'none') fab.style.display = ''; 
      if (maxFab && maxFab.style.display === 'none') maxFab.style.display = '';
      if (zoomFab && zoomFab.style.display === 'none') zoomFab.style.display = '';
    } else { 
      if (fab.style.display !== 'none') fab.style.display = 'none'; 
      if (maxFab && maxFab.style.display !== 'none') maxFab.style.display = 'none';
      if (zoomFab && zoomFab.style.display !== 'none') zoomFab.style.display = 'none';
      if (panelOpen) togglePanel(false); 
    }
  }

  function getFsRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fs) return document.documentElement;
    return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs;
  }
  function reparent() {
    const target = getFsRoot();
    if (fab && fab.parentNode !== target) try { target.appendChild(fab); } catch (_) {}
    if (maxFab && maxFab.parentNode !== target) try { target.appendChild(maxFab); } catch (_) {}
    if (zoomFab && zoomFab.parentNode !== target) try { target.appendChild(zoomFab); } catch (_) {}
    if (panel && panelOpen && panel.parentNode !== target) try { target.appendChild(panel); } catch (_) {}
  }
  function onFsChange() { reparent(); setTimeout(reparent, 100); }

  /* ── tick ─────────────────────────────────────────────── */
  function tick() {
    if (!liveVideo || !liveVideo.isConnected) {
      liveVideo = null; killShadow(); scheduleDetect(); return;
    }
    let res = sampleRGB(liveVideo);
    if (!res.ok) {
      const src = liveVideo.currentSrc || liveVideo.src;
      if (src && !shadowVid) { if (panelOpen) setStatus('CORS 우회 시도…', false); makeShadow(src, liveVideo.currentTime); }
      if (shadowVid && shadowVid.readyState >= 2) { shadowVid.currentTime = liveVideo.currentTime; res = sampleRGB(shadowVid); }
    }
    if (!res.ok && shadowVid) return;
    if (!res.ok) {
      if (panelOpen) showError('이 사이트는 픽셀 읽기가 차단됩니다\n(' + res.error + ')');
      updateFabState('error', 0); return;
    }
    if (panelOpen) clearError();
    history.push(res); if (history.length > CFG.histLen) history.shift();
    updateFabState(res.score > CFG.threshold ? 'warn' : 'ok', res.score);
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
    if (score > CFG.threshold) { bd.textContent = '⚠️  노란끼 감지됨'; bd.className = 'warn'; }
    else { bd.textContent = '✅  색조 정상'; bd.className = 'ok'; }
    const tempEl = q('ytd-temp');
    if (tempEl) {
      const temp = scoreToTemp(score);
      if (temp === 0) { tempEl.textContent = '권장 색온도 보정: 불필요'; tempEl.className = 'ytd-temp ok'; }
      else { tempEl.textContent = `권장 색온도 보정: ${temp}`; tempEl.className = 'ytd-temp ' + (Math.abs(temp) >= 3 ? 'warn' : 'mild'); }
    }
  }

  function drawGraph() {
    const gc = q('ytd-gc'); if (!gc) return;
    const gx = gc.getContext('2d'), W = gc.width, H = gc.height;
    gx.clearRect(0, 0, W, H); if (history.length < 2) return;
    const scores = history.map(d => d.score);
    const hi = Math.max(CFG.threshold * 2.2, ...scores), lo = Math.min(0, ...scores), rng = hi - lo || 1;
    const ty = s => H - ((s - lo) / rng * (H - 10)) - 5;
    const tx = i => (i / (CFG.histLen - 1)) * W;
    const ox = CFG.histLen - history.length;
    gx.strokeStyle = 'rgba(245,200,66,.2)'; gx.lineWidth = 1; gx.setLineDash([3,4]);
    gx.beginPath(); gx.moveTo(0, ty(CFG.threshold)); gx.lineTo(W, ty(CFG.threshold)); gx.stroke(); gx.setLineDash([]);
    gx.beginPath(); history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i+ox), ty(d.score)) : gx.lineTo(tx(i+ox), ty(d.score)));
    const grad = gx.createLinearGradient(0,0,0,H); grad.addColorStop(0,'rgba(245,200,66,.28)'); grad.addColorStop(1,'rgba(245,200,66,.02)');
    gx.lineTo(tx(ox+history.length-1),H); gx.lineTo(tx(ox),H); gx.closePath(); gx.fillStyle = grad; gx.fill();
    gx.beginPath(); history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i+ox), ty(d.score)) : gx.lineTo(tx(i+ox), ty(d.score)));
    gx.strokeStyle = '#f5c842'; gx.lineWidth = 1.5; gx.stroke();
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
    stopAnalysis(); liveVideo = video; history = [];
    if (panelOpen) setStatus('분석 중', true);
    timerID = setInterval(tick, CFG.intervalMs);
  }
  function stopAnalysis() {
    if (timerID) { clearInterval(timerID); timerID = null; }
    killShadow(); if (panelOpen) setStatus('대기', false);
    updateFabState('idle', 0);
  }

  function refreshVideoList() {
    const sel = q('ytd-sel');
    const videos = getAllVideos();
    if (sel) {
      sel.innerHTML = safeHTML('');
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
    if (hasVid && best !== liveVideo) startAnalysis(best);
    else if (hasVid && !timerID) startAnalysis(best);
    else if (!hasVid && liveVideo) { stopAnalysis(); liveVideo = null; }
  }


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 통합된 Video Maximizer 모듈
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

    function isInIframe() {
      try { return window !== window.top; } catch (_) { return true; }
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

    function backupAndApplyStyle(el, css) {
      if (!savedElementsSet.has(el)) {
        savedElementsSet.add(el);
        savedElementsList.push(el);
        if (!el.__ytd_max_saved) el.__ytd_max_saved = {};
      }
      for (const prop in css) {
        if (!(prop in el.__ytd_max_saved)) {
          el.__ytd_max_saved[prop] = el.style.getPropertyValue(prop);
        }
        el.style.setProperty(prop, css[prop], 'important');
      }
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

    function hideSiblings(el) {
      if (!el.parentNode) return;
      for (const sib of el.parentNode.children) {
        if (sib === el || sib.nodeType !== 1) continue;
        if (sib.tagName === 'SCRIPT' || sib.tagName === 'LINK' || sib.tagName === 'STYLE') continue;
        if (sib.id === '__ytd2__' || sib.classList.contains('ytd-fab')) continue;

        const prevDisplay = sib.style.getPropertyValue('display');
        const prevDisplayPrio = sib.style.getPropertyPriority('display');
        sib.classList.add(HIDE_CLASS);
        sib.style.setProperty('display', 'none', 'important');
        hiddenSiblings.push({ el: sib, prevDisplay, prevDisplayPrio });
      }
    }

    function clearAncestorChain(startEl) {
      let ancestor = startEl.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        ancestor.dataset.ytdMaxAncestor = '1';
        backupAndApplyStyle(ancestor, {
          overflow: 'visible', position: 'static', transform: 'none',
          clip: 'auto', 'clip-path': 'none', contain: 'none'
        });
        ancestor.classList.add(ANCESTOR_CLASS);
        hideSiblings(ancestor);
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
      const guardClass = isIframeMode ? IFRAME_MAX_CLASS : MAX_CLASS;
      classMO = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== 'attributes' || m.attributeName !== 'class' || !active) continue;
          const el = m.target;
          if (el === primaryEl && !el.classList.contains(guardClass)) el.classList.add(guardClass);
          if (el.dataset?.ytdMaxAncestor === '1' && !el.classList.contains(ANCESTOR_CLASS)) el.classList.add(ANCESTOR_CLASS);
        }
      });
      classMO.observe(primaryEl, { attributes: true, attributeFilter: ['class'] });
      let cur = primaryEl.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        classMO.observe(cur, { attributes: true, attributeFilter: ['class'] });
        cur = cur.parentElement;
      }
    }

    function stopClassGuard() {
      if (classMO) { classMO.disconnect(); classMO = null; }
    }

    function doMaximizeDirect(video) {
      targetVideo = video;
      isIframeMode = false;
      savedScrollX = window.scrollX;
      savedScrollY = window.scrollY;

      clearAncestorChain(video);
      lockBody();
      backupAndApplyStyle(video, {});
      video.classList.add(MAX_CLASS);
      hideSiblings(video);
      window.scrollTo(0, 0);

      startClassGuard(video);
      active = true;
      syncBtnUI();
      showOSD('최대화 ON (ESC 복원)', 1200);
    }

    function doMaximizeIframe(iframeEl) {
      targetIframe = iframeEl;
      isIframeMode = true;
      savedScrollX = window.scrollX;
      savedScrollY = window.scrollY;

      clearAncestorChain(iframeEl);
      lockBody();
      backupAndApplyStyle(iframeEl, {});
      iframeEl.classList.add(IFRAME_MAX_CLASS);
      hideSiblings(iframeEl);
      window.scrollTo(0, 0);

      startClassGuard(iframeEl);
      active = true;
      syncBtnUI();
      showOSD('최대화 ON (iframe)', 1200);
      try { iframeEl.contentWindow.postMessage({ __ytd_max: 'apply_inner' }, '*'); } catch (_) {}
    }

    function undoMaximize() {
      if (!active) return;
      stopClassGuard();

      if (isIframeMode && targetIframe) {
        try { targetIframe.contentWindow.postMessage({ __ytd_max: 'undo_inner' }, '*'); } catch (_) {}
        try { targetIframe.contentWindow.postMessage({ __ytd_max: 'state_off' }, '*'); } catch (_) {}
      }

      for (const { el, prevDisplay, prevDisplayPrio } of hiddenSiblings) {
        try {
          el.classList.remove(HIDE_CLASS);
          if (prevDisplay) el.style.setProperty('display', prevDisplay, prevDisplayPrio || '');
          else el.style.removeProperty('display');
        } catch (_) {}
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

      window.scrollTo(savedScrollX, savedScrollY);
      active = false;
      targetVideo = null;
      targetIframe = null;
      isIframeMode = false;
      syncBtnUI();
      showOSD('최대화 OFF', 1200);
    }

    // Inner iframe logic
    let innerMaxActive = false;
    const innerSavedSet = new Set();
    const innerSavedList = [];

    function backupInner(el, css) {
      if (!innerSavedSet.has(el)) { innerSavedSet.add(el); innerSavedList.push(el); if (!el.__ytd_max_saved) el.__ytd_max_saved = {}; }
      for (const prop in css) {
        if (!(prop in el.__ytd_max_saved)) el.__ytd_max_saved[prop] = el.style.getPropertyValue(prop);
        el.style.setProperty(prop, css[prop], 'important');
      }
    }

    function applyInnerMaximize() {
      if (innerMaxActive) return;
      const video = pickBestVideo();
      if (!video) return;
      innerMaxActive = true;

      backupInner(video, {
        width: '100vw', height: '100vh', 'object-fit': 'contain',
        position: 'fixed', top: '0', left: '0', 'z-index': '2147483646',
        background: '#000', margin: '0', padding: '0', border: 'none'
      });

      let ancestor = video.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        backupInner(ancestor, { overflow: 'visible', position: 'static', transform: 'none', clip: 'auto', 'clip-path': 'none', contain: 'none' });
        ancestor = ancestor.parentElement;
      }
      backupInner(document.body, { overflow: 'hidden', margin: '0', padding: '0' });
      if (document.documentElement) backupInner(document.documentElement, { overflow: 'hidden' });
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

      const iframes = document.querySelectorAll('iframe');
      let bestIframe = null, bestArea = 0;
      for (const ifr of iframes) {
        if (!ifr.isConnected) continue;
        const r = ifr.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < 10000) continue;
        if (area > bestArea) { bestArea = area; bestIframe = ifr; }
      }
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

    // ESC 키로 최대화 해제 (단축키 제거 후 유일하게 남긴 키 바인딩)
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (active || delegatedToTop)) {
        undoMaximize();
      }
    }, { capture: true });

    return {
      toggle,
      undoMaximize,
      isActive: () => active || delegatedToTop
    };
  })();
  /* ═════════════════════════════════════════════════════════════════════════ */


  /* ═════════════════════════════════════════════════════════════════════════
     ★ 통합된 Zoomer 모듈 (PC/모바일 터치 완벽 대응 및 Settle Timer 복구)
  ═════════════════════════════════════════════════════════════════════════ */
  const Zoomer = (() => {
    let active = false;
    const states = new WeakMap();
    let activeVideo = null;
    let rafId = null;

    const _savedTouchActions = new WeakMap();
    const __touchBlocked = new WeakSet();

    const TS = Object.freeze({ IDLE: 0, WAIT_PAN: 1, PANNING: 2, PINCHING: 3, PINCH_RELEASED: 4 });
    let touchState = TS.IDLE;
    let settleTimerId = 0;
    const TOUCH_SETTLE_MS = 120;
    const PAN_THRESHOLD_SQ = 64; 

    let isPanning = false;
    let startX = 0, startY = 0, touchOriginX = 0, touchOriginY = 0, activePointerId = null;
    const pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0, elemCx: 0, elemCy: 0 };

    function setTouchState(next) { touchState = next; }
    function startSettleTimer(cb) {
      if (settleTimerId) clearTimeout(settleTimerId);
      settleTimerId = setTimeout(() => { settleTimerId = 0; cb(); }, TOUCH_SETTLE_MS);
    }
    function clearSettleTimer() {
      if (settleTimerId) { clearTimeout(settleTimerId); settleTimerId = 0; }
    }

    function walkParents(el, maxDepth, fn) {
      let p = el.parentElement, d = 0;
      while (p && p !== document.body && p !== document.documentElement && d < maxDepth) {
        fn(p, d); p = p.parentElement; d++;
      }
    }

    function setTouchActionBlocking(v, enable) {
      if (!v) return;
      if (enable) {
        if (!_savedTouchActions.has(v)) _savedTouchActions.set(v, v.style.getPropertyValue('touch-action'));
        v.style.setProperty('touch-action', 'none', 'important');
        v.style.setProperty('-webkit-tap-highlight-color', 'transparent', 'important');
        __touchBlocked.add(v);
        walkParents(v, 3, p => {
          if (!_savedTouchActions.has(p)) _savedTouchActions.set(p, p.style.getPropertyValue('touch-action'));
          p.style.setProperty('touch-action', 'none', 'important');
          p.style.setProperty('-webkit-tap-highlight-color', 'transparent', 'important');
          p.dataset.ytdTouchBlocked = '1';
        });
      } else {
        restoreTouchAction(v);
        __touchBlocked.delete(v);
        walkParents(v, 3, p => {
          if (p.dataset?.ytdTouchBlocked) { restoreTouchAction(p); delete p.dataset.ytdTouchBlocked; }
        });
      }
    }

    function restoreTouchAction(el) {
      if (!el) return;
      const saved = _savedTouchActions.get(el);
      if (saved !== undefined) {
        if (saved) el.style.setProperty('touch-action', saved);
        else el.style.removeProperty('touch-action');
        _savedTouchActions.delete(el);
      } else {
        el.style.removeProperty('touch-action');
      }
      el.style.removeProperty('-webkit-tap-highlight-color');
    }

    function getSt(v) {
      let s = states.get(v);
      if (!s) { 
        s = { scale: 1, tx: 0, ty: 0, zoomed: false, _savedPos: '', _savedZ: '' }; 
        states.set(v, s); 
      }
      return s;
    }

    function clampPan(v, st) {
      try {
        const r = v.getBoundingClientRect();
        const maxTx = Math.max(0, (r.width * st.scale - r.width) / 2 / st.scale);
        const maxTy = Math.max(0, (r.height * st.scale - r.height) / 2 / st.scale);
        st.tx = Math.max(-maxTx, Math.min(maxTx, st.tx));
        st.ty = Math.max(-maxTy, Math.min(maxTy, st.ty));
      } catch (_) {}
    }

    function update(v) {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const st = getSt(v);
        if (st.scale <= 1 && st.zoomed) { reset(v); return; }
        if (st.scale > 1) {
          if (!st.zoomed) {
            st._savedPos = v.style.getPropertyValue('position');
            st._savedZ = v.style.getPropertyValue('z-index');

            v.style.setProperty('position', 'relative', 'important');
            v.style.setProperty('z-index', '999999', 'important');
            st.zoomed = true;
          }
          v.style.setProperty('transform', `scale(${st.scale}) translate(${st.tx}px, ${st.ty}px)`, 'important');
          v.style.setProperty('transform-origin', 'center center', 'important');
          v.style.setProperty('will-change', 'transform', 'important');
        }
      });
    }

    function zoomTo(v, scale) {
      const st = getSt(v);
      st.scale = scale;
      clampPan(v, st);
      update(v);
    }

    function reset(v) {
      const st = getSt(v);
      v.style.removeProperty('transform');
      v.style.removeProperty('transform-origin');
      v.style.removeProperty('will-change');

      if (st._savedPos) v.style.setProperty('position', st._savedPos); 
      else v.style.removeProperty('position');

      if (st._savedZ) v.style.setProperty('z-index', st._savedZ); 
      else v.style.removeProperty('z-index');
      
      st.scale = 1; st.tx = 0; st.ty = 0; st.zoomed = false;
      
      if (!active) setTouchActionBlocking(v, false);
      if (activeVideo === v) { setTouchState(TS.IDLE); clearSettleTimer(); activeVideo = null; }
    }

    function isUiEvent(e) {
      try {
        const path = e.composedPath ? e.composedPath() : [];
        for (let i = 0; i < Math.min(path.length, 8); i++) {
          const n = path[i];
          if (n && n.classList && n.classList.contains('ytd-fab')) return true;
          if (n && n.id === '__ytd2__') return true;
        }
      } catch (_) {}
      return false;
    }

    function getTargetVideo(e) {
      const px = e.touches ? e.touches[0].clientX : e.clientX;
      const py = e.touches ? e.touches[0].clientY : e.clientY;
      let bestVideo = null, bestArea = 0;
      
      const videos = getAllVideos();
      for (const v of videos) {
        if (!v.isConnected) continue;
        try {
          const r = v.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; bestVideo = v; }
          }
        } catch (_) {}
      }
      return bestVideo || pickBestVideo();
    }

    function getTouchDist(ts) {
      const dx = ts[0].clientX - ts[1].clientX, dy = ts[0].clientY - ts[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function getTouchCenter(ts) {
      return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 };
    }

    // --- PC Events ---
    window.addEventListener('wheel', e => {
      if (!active || !e.altKey || isUiEvent(e)) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      st.scale = Math.max(1, Math.min(st.scale * zoomFactor, 10));
      if (st.scale < 1.05) { reset(v); return; }
      clampPan(v, st); update(v);
    }, { passive: false, capture: true });

    window.addEventListener('pointerdown', e => {
      if (!active || !e.altKey || e.pointerType === 'touch' || isUiEvent(e)) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v); if (st.scale <= 1) return;
      e.preventDefault(); e.stopPropagation();
      activeVideo = v; activePointerId = e.pointerId; isPanning = true;
      startX = e.clientX - st.tx; startY = e.clientY - st.ty;
      try { v.setPointerCapture(e.pointerId); } catch(_) {}
    }, { passive: false, capture: true });

    window.addEventListener('pointermove', e => {
      if (!isPanning || !activeVideo || e.pointerId !== activePointerId || e.pointerType === 'touch') return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(activeVideo);
      st.tx = e.clientX - startX; st.ty = e.clientY - startY;
      clampPan(activeVideo, st); update(activeVideo);
    }, { passive: false, capture: true });

    const endPan = (e) => {
      if (!isPanning || e.pointerId !== activePointerId || e.pointerType === 'touch') return;
      isPanning = false;
      try { activeVideo.releasePointerCapture(e.pointerId); } catch(_) {}
      activeVideo = null; activePointerId = null;
    };
    window.addEventListener('pointerup', endPan, { capture: true });
    window.addEventListener('pointercancel', endPan, { capture: true });

    window.addEventListener('dblclick', e => {
      if (!active || !e.altKey || isUiEvent(e)) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) { st.scale = 2.5; clampPan(v, st); update(v); } else { reset(v); }
    }, { capture: true });

    // --- Mobile Events ---
    window.addEventListener('touchstart', e => {
      if (!active || isUiEvent(e)) return;
      const v = getTargetVideo(e); 
      if (!v) return;

      const st = getSt(v);

      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault(); // 스크롤 차단 시작
        clearSettleTimer();
        activeVideo = v;
        isPanning = false;
        pinchState.active = true;
        pinchState.initialDist = getTouchDist(e.touches);
        pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches);
        pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        
        const _rect = v.getBoundingClientRect();
        pinchState.elemCx = _rect.left + _rect.width / 2 - st.scale * st.tx;
        pinchState.elemCy = _rect.top + _rect.height / 2 - st.scale * st.ty;
        setTouchState(TS.PINCHING);
      } else if (e.touches.length === 1 && st.scale > 1) {
        if (e.cancelable) e.preventDefault(); // 확대 상태면 스크롤 차단
        clearSettleTimer();
        activeVideo = v;
        touchOriginX = e.touches[0].clientX; touchOriginY = e.touches[0].clientY;
        startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
        setTouchState(TS.WAIT_PAN);
      }
    }, { passive: false, capture: true });

    window.addEventListener('touchmove', e => {
      if (!active) return;

      // 두 번째 손가락이 나중에 닿았을 때
      if (touchState !== TS.PINCHING && !pinchState.active && e.touches.length === 2) {
        const v = getTargetVideo(e);
        if (v) {
          if (e.cancelable) e.preventDefault();
          clearSettleTimer();
          activeVideo = v;
          pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches);
          pinchState.initialScale = getSt(v).scale;
          const c = getTouchCenter(e.touches);
          pinchState.lastCx = c.x; pinchState.lastCy = c.y;
          const _rect = v.getBoundingClientRect();
          pinchState.elemCx = _rect.left + _rect.width / 2 - getSt(v).scale * getSt(v).tx;
          pinchState.elemCy = _rect.top + _rect.height / 2 - getSt(v).scale * getSt(v).ty;
          setTouchState(TS.PINCHING);
        }
        return;
      }

      if (!activeVideo) return;
      const st = getSt(activeVideo);

      if (touchState === TS.PINCHING && pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches);
        const center = getTouchCenter(e.touches);
        let ns = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist));
        ns = Math.max(1, Math.min(ns, 10));
        
        if (ns < 1.05) {
          if (st.zoomed) { reset(activeVideo); showOSD('줌 1× (리셋)', 800); }
          pinchState.initialDist = getTouchDist(e.touches); 
          pinchState.initialScale = 1.0;
          st.scale = 1; st.tx = 0; st.ty = 0;
        } else {
          const prevScale = st.scale;
          const Cx = pinchState.elemCx, Cy = pinchState.elemCy;
          st.tx = (center.x - Cx) / ns - (pinchState.lastCx - Cx) / prevScale + st.tx;
          st.ty = (center.y - Cy) / ns - (pinchState.lastCy - Cy) / prevScale + st.ty;
          st.scale = ns;
          clampPan(activeVideo, st);
          update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      } else if (touchState === TS.WAIT_PAN && e.touches.length === 1 && st.scale > 1) {
        const dx = e.touches[0].clientX - touchOriginX; 
        const dy = e.touches[0].clientY - touchOriginY;
        if (dx * dx + dy * dy >= PAN_THRESHOLD_SQ) { 
          if (e.cancelable) e.preventDefault(); 
          isPanning = true; 
          setTouchState(TS.PANNING); 
        }
      } else if (touchState === TS.PANNING && isPanning && e.touches.length === 1 && st.scale > 1) {
        if (e.cancelable) e.preventDefault();
        st.tx = e.touches[0].clientX - startX;
        st.ty = e.touches[0].clientY - startY;
        clampPan(activeVideo, st);
        update(activeVideo);
      }
    }, { passive: false, capture: true });

    window.addEventListener('touchend', e => {
      if (!activeVideo) return;
      
      if (touchState === TS.PINCHING && e.touches.length < 2) {
        pinchState.active = false; setTouchState(TS.PINCH_RELEASED);
        const currentScale = activeVideo ? getSt(activeVideo).scale : 1;
        if (e.touches.length === 1 && activeVideo?.isConnected && currentScale > 1) {
          startSettleTimer(() => setTouchState(TS.IDLE));
        } else if (e.touches.length === 0) {
          startSettleTimer(() => {
            setTouchState(TS.IDLE); isPanning = false;
            if (activeVideo && getSt(activeVideo).scale <= 1 && getSt(activeVideo).zoomed) reset(activeVideo);
            activeVideo = null;
          });
        }
        return;
      }
      
      if (touchState === TS.PINCH_RELEASED || touchState === TS.IDLE) {
        if (e.touches.length === 0) { clearSettleTimer(); isPanning = false; setTouchState(TS.IDLE); activeVideo = null; }
        return;
      }
      
      if (e.touches.length === 1 && activeVideo?.isConnected && getSt(activeVideo).scale > 1) {
        touchOriginX = e.touches[0].clientX; touchOriginY = e.touches[0].clientY;
        startX = e.touches[0].clientX - getSt(activeVideo).tx; startY = e.touches[0].clientY - getSt(activeVideo).ty;
        setTouchState(TS.WAIT_PAN);
      } else if (e.touches.length === 0) {
        clearSettleTimer(); isPanning = false; setTouchState(TS.IDLE); activeVideo = null;
      }
    }, { passive: false, capture: true });

    window.addEventListener('touchcancel', () => {
      if (!activeVideo) return; clearSettleTimer();
      isPanning = false; pinchState.active = false; setTouchState(TS.IDLE); activeVideo = null;
    }, { passive: true, capture: true });

    function syncZoomUI() {
      if (zoomFab) {
         zoomFab.style.borderColor = active ? '#50d070' : '#2a2d36';
         const svg = zoomFab.querySelector('svg');
         if (svg) svg.style.stroke = active ? '#50d070' : '#4a5060';
      }
      const btn = document.getElementById('ytd-zoom');
      if (btn) btn.style.color = active ? '#50d070' : '';
    }

    return {
      toggle: () => {
        active = !active;
        const videos = getAllVideos();
        if (active) {
          videos.forEach(v => setTouchActionBlocking(v, true));
        } else {
          videos.forEach(reset);
        }
        syncZoomUI();
        showOSD(active ? '줌 ON' : '줌 OFF', 1200);
        return active;
      },
      isActive: () => active
    };
  })();
  /* ═════════════════════════════════════════════════════════════════════════ */


  /* ── FAB 빌드 (기존 1개에서 3개로 분리: Zoom, Max, Main) ─────────────────────────── */
  function buildFab() {
    if (fab) return;
    fabStyle = document.createElement('style'); fabStyle.id = '__ytd3_fab_style__';
    fabStyle.textContent = `
      .ytd-fab{position:fixed;top:40px;right:5px;z-index:2147483647;opacity:0.5;width:40px;height:40px;border-radius:50%;background:#15171c;border:2px solid #2a2d36;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .35s cubic-bezier(.16,1,.3,1);box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;-webkit-tap-highlight-color:transparent}
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
      .ytd-fab--error{border-color:#3a1515}
      .ytd-fab--error .ytd-fab-icon svg{fill:none;stroke:#e06060}
      .ytd-fab--error .ytd-fab-dot{background:#e06060;box-shadow:0 0 6px rgba(224,96,96,.5)}
      .ytd-fab--error .ytd-fab-score{color:#e06060;border-color:#3a1515}
      .ytd-fab--error .ytd-fab-clock{color:#e06060}
      @keyframes ytd-fab-pulse{0%,100%{box-shadow:0 0 16px rgba(245,200,66,.25),0 0 40px rgba(245,200,66,.08),0 4px 16px rgba(0,0,0,.5)}50%{box-shadow:0 0 24px rgba(245,200,66,.4),0 0 60px rgba(245,200,66,.12),0 4px 16px rgba(0,0,0,.5)}}
      @keyframes ytd-ring-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.1);opacity:.6}}
      @keyframes ytd-dot-blink{0%,100%{opacity:1}50%{opacity:.3}}`;
    document.documentElement.appendChild(fabStyle);

    const svgNS = 'http://www.w3.org/2000/svg';

    // 1. 기존 YTD (메인: 색상 감지 및 패널 열기) FAB (오른쪽 5px)
    fab = document.createElement('div'); fab.className = 'ytd-fab ytd-fab--idle'; fab.style.display = 'none';
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

    // 2. 최대화 (Maximizer) FAB (오른쪽 55px)
    maxFab = document.createElement('div'); 
    maxFab.className = 'ytd-fab ytd-fab--idle'; 
    maxFab.style.display = 'none';
    maxFab.style.right = '55px';
    maxFab.title = "화면 최대화/해제";
    
    const maxIconWrap = document.createElement('div'); maxIconWrap.className = 'ytd-fab-icon';
    const maxSvg = document.createElementNS(svgNS,'svg'); maxSvg.setAttribute('viewBox','0 0 24 24'); maxSvg.setAttribute('fill','none'); maxSvg.setAttribute('stroke-width','2'); maxSvg.setAttribute('stroke-linecap','round'); maxSvg.setAttribute('stroke-linejoin','round');
    const maxPath = document.createElementNS(svgNS, 'path');
    maxPath.setAttribute('d', 'M15,3L21,3L21,9 M9,21L3,21L3,15 M21,3L14,10 M3,21L10,14');
    maxPath.style.stroke = '#4a5060';
    maxSvg.appendChild(maxPath);
    maxIconWrap.appendChild(maxSvg);
    maxFab.appendChild(maxIconWrap);

    // 3. 줌 (Zoom) FAB (오른쪽 105px)
    zoomFab = document.createElement('div'); 
    zoomFab.className = 'ytd-fab ytd-fab--idle'; 
    zoomFab.style.display = 'none';
    zoomFab.style.right = '105px';
    zoomFab.title = "줌 모드 (PC: Alt+Wheel / Mobile: Pinch)";

    const zoomIconWrap = document.createElement('div'); zoomIconWrap.className = 'ytd-fab-icon';
    const zoomSvg = document.createElementNS(svgNS,'svg'); zoomSvg.setAttribute('viewBox','0 0 24 24'); zoomSvg.setAttribute('fill','none'); zoomSvg.setAttribute('stroke-width','2'); zoomSvg.setAttribute('stroke-linecap','round'); zoomSvg.setAttribute('stroke-linejoin','round');
    zoomSvg.style.stroke = '#4a5060'; 
    const zoomCircle = document.createElementNS(svgNS, 'circle');
    zoomCircle.setAttribute('cx', '11'); zoomCircle.setAttribute('cy', '11'); zoomCircle.setAttribute('r', '8');
    const zoomLine = document.createElementNS(svgNS, 'line');
    zoomLine.setAttribute('x1', '21'); zoomLine.setAttribute('y1', '21'); zoomLine.setAttribute('x2', '16.65'); zoomLine.setAttribute('y2', '16.65');
    zoomSvg.appendChild(zoomCircle);
    zoomSvg.appendChild(zoomLine);
    zoomIconWrap.appendChild(zoomSvg);
    zoomFab.appendChild(zoomIconWrap);

    // DOM에 3개의 FAB 추가
    document.documentElement.appendChild(zoomFab);
    document.documentElement.appendChild(maxFab);
    document.documentElement.appendChild(fab);

    // 4. 세 개의 버튼이 같이 이동하도록 드래그 로직 구현
    let dragging=false, moved=false, startX=0, startY=0;
    let fabX=0, fabY=0, maxX=0, maxY=0, zoomX=0, zoomY=0;

    const onDown = (e, targetEl) => {
      if(e.button!==0)return;
      dragging=true; moved=false;
      const rF = fab.getBoundingClientRect();
      const rM = maxFab.getBoundingClientRect();
      const rZ = zoomFab.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      fabX = rF.left; fabY = rF.top;
      maxX = rM.left; maxY = rM.top;
      zoomX = rZ.left; zoomY = rZ.top;
      targetEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if(!dragging)return;
      const dx=e.clientX-startX, dy=e.clientY-startY;
      if(!moved && Math.abs(dx)<4 && Math.abs(dy)<4) return;
      moved = true;
      fab.style.left = (fabX+dx)+'px'; fab.style.top = (fabY+dy)+'px'; fab.style.right = 'auto';
      maxFab.style.left = (maxX+dx)+'px'; maxFab.style.top = (maxY+dy)+'px'; maxFab.style.right = 'auto';
      zoomFab.style.left = (zoomX+dx)+'px'; zoomFab.style.top = (zoomY+dy)+'px'; zoomFab.style.right = 'auto';
    };

    // 기존 (메인) FAB 바인딩
    fab.addEventListener('pointerdown', e => onDown(e, fab));
    fab.addEventListener('pointermove', onMove);
    fab.addEventListener('pointerup', e => {
      if(!dragging)return; dragging=false; fab.releasePointerCapture(e.pointerId);
      if(!moved) togglePanel();
    });

    // 최대화 FAB 바인딩
    maxFab.addEventListener('pointerdown', e => onDown(e, maxFab));
    maxFab.addEventListener('pointermove', onMove);
    maxFab.addEventListener('pointerup', e => {
      if(!dragging)return; dragging=false; maxFab.releasePointerCapture(e.pointerId);
      if(!moved) Maximizer.toggle();
    });

    // 줌 FAB 바인딩
    zoomFab.addEventListener('pointerdown', e => onDown(e, zoomFab));
    zoomFab.addEventListener('pointermove', onMove);
    zoomFab.addEventListener('pointerup', e => {
      if(!dragging)return; dragging=false; zoomFab.releasePointerCapture(e.pointerId);
      if(!moved) Zoomer.toggle();
    });

    startClock();
  }

  /* ── 패널 빌드 ────────────────────────── */
  function buildPanel() {
    const el = document.createElement('div'); el.id = '__ytd2__';
    el.innerHTML = safeHTML(`
      <div id="ytd-hdr">
        <span>🔍 Tint Detector</span>
        <div style="display:flex; gap:6px;">
          <button id="ytd-zoom" title="줌 모드 (PC: Alt+Wheel / Mobile: Pinch)">🔍</button>
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
      <div id="ytd-score"><span>Yellow Score</span><b id="sv">—</b></div>
      <div id="ytd-temp" class="ytd-temp">권장 색온도 보정: —</div>
      <canvas id="ytd-gc" width="216" height="52"></canvas>
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
      .ytd-temp.ok{color:#50d070}.ytd-temp.mild{color:#d4a84a}.ytd-temp.warn{color:#f5c842;background:#2c1f00}
      #ytd-gc{display:block;margin:4px 10px 6px;width:calc(100% - 20px);background:#0b0d10;border-radius:4px}
      #ytd-foot{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-top:1px solid #252830;background:#181b21}
      #ytd-sel{flex:1;max-width:134px;background:#1a1d24;color:#7a8499;border:1px solid #252830;border-radius:4px;font-size:10px;padding:2px 4px}
      #ytd-st{font-size:10px;color:#4a5060}
      #ytd-st.on{color:#50d070;animation:ytdblink 1.3s infinite}
      #ytd-err{padding:0 10px 7px;font-size:10px;color:#c04040;word-break:break-all;display:none;line-height:1.45}
      @keyframes ytdblink{0%,100%{opacity:1}50%{opacity:.3}}
      
      /* Maximizer CSS 추가 */
      .ytd-vmax-max{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;margin:0!important;padding:0!important;border:none!important;transform:none!important;}
      .ytd-vmax-hide{display:none!important;}
      .ytd-vmax-ancestor{overflow:visible!important;position:static!important;transform:none!important;clip:auto!important;clip-path:none!important;contain:none!important;}
      .ytd-vmax-iframe{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;border:none!important;margin:0!important;padding:0!important;}
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
    
    // Zoom 버튼 클릭 이벤트
    q('ytd-zoom').addEventListener('click', () => Zoomer.toggle());
    
    // 최대화 버튼 이벤트
    q('ytd-maximize').addEventListener('click', () => Maximizer.toggle());

    q('ytd-refresh').addEventListener('click', refreshVideoList);
    q('ytd-close').addEventListener('click', () => togglePanel(false));
    
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
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
