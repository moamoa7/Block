// ==UserScript==
// @name         Yellow Tint Detector
// @namespace    https://github.com/
// @version      3.5.0
// @description  영상의 노란끼(황조) 실시간 감지 — FAB + 시계 + 권장 색온도 + 전체화면 대응
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  /* ── Trusted Types 정책 생성 ─────────────────────────── */
  let ttPolicy = null;
  if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
    try {
      ttPolicy = trustedTypes.createPolicy('ytd-tint-detector', {
        createHTML: (str) => str,
      });
    } catch (_) {
      try {
        ttPolicy = trustedTypes.createPolicy('default', {
          createHTML: (str) => str,
        });
      } catch (__) {}
    }
  }
  function safeHTML(str) {
    return ttPolicy ? ttPolicy.createHTML(str) : str;
  }

  const CFG = {
    sampleSize:  48,
    intervalMs:  1000,   // ★ 1초에 1번
    threshold:   12,
    histLen:     24,
    tempPerScore: 5,
  };

  let timerID    = null;
  let clockTimer = null;
  let liveVideo  = null;
  let shadowVid  = null;
  let history    = [];
  let panel      = null;
  let fab        = null;
  let fabStyle   = null;
  let panelStyle = null;
  let panelOpen  = false;
  let lastStatus = 'idle';

  let offscreen, oCtx;
  function resetCanvas() {
    offscreen = document.createElement('canvas');
    offscreen.width = offscreen.height = CFG.sampleSize;
    oCtx = offscreen.getContext('2d', { willReadFrequently: true });
  }
  resetCanvas();

  /* ── cross-origin 조기 주입 ──────────────────────────── */
  const injected = new WeakSet();
  function injectCrossOrigin(v) {
    if (injected.has(v)) return;
    injected.add(v);
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

  /* ── 샘플링 ─────────────────────────────────────────── */
  function sampleRGB(video) {
    try {
      oCtx.drawImage(video, 0, 0, CFG.sampleSize, CFG.sampleSize);
      const px = oCtx.getImageData(0, 0, CFG.sampleSize, CFG.sampleSize).data;
      let r = 0, g = 0, b = 0, n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; }
      r /= n; g /= n; b /= n;
      return { ok: true, r, g, b, score: (r - b) + (g - b) * 0.5 };
    } catch (e) {
      resetCanvas();
      return { ok: false, error: e.name + ': ' + e.message };
    }
  }

  /* ── shadow video ────────────────────────────────────── */
  function makeShadow(src, currentTime) {
    killShadow();
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.001;top:0;left:0;pointer-events:none';
    document.body.appendChild(v);
    v.src = src;
    v.currentTime = currentTime || 0;
    v.play().catch(() => {});
    shadowVid = v;
    return v;
  }
  function killShadow() {
    if (!shadowVid) return;
    shadowVid.src = ''; shadowVid.remove(); shadowVid = null;
  }

  /* ── 권장 색온도 ─────────────────────────────────────── */
  function scoreToTemp(score) {
    if (score <= 0) return 0;
    return -(Math.round(score / CFG.tempPerScore));
  }

  /* ── 시계 갱신 ───────────────────────────────────────── */
  function updateClock() {
    if (!fab) return;
    const clockEl = fab.querySelector('.ytd-fab-clock');
    if (!clockEl) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hh}:${mm}:${ss}`;
  }

  function startClock() {
    if (clockTimer) return;
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
  }

  /* ── FAB 상태 ────────────────────────────────────────── */
  function updateFabState(status, score) {
    if (!fab) return;
    lastStatus = status;
    const scoreEl = fab.querySelector('.ytd-fab-score');
    if (scoreEl) {
      if (status === 'idle') {
        scoreEl.textContent = '';
      } else if (status === 'error') {
        scoreEl.textContent = '!';
      } else {
        const tempValue = scoreToTemp(score);
        scoreEl.textContent = tempValue === 0 ? '0' : tempValue;
      }
    }
    fab.className = 'ytd-fab ytd-fab--' + status;
  }

  function setFabVisible(show) {
    if (!fab) return;
    if (show) { if (fab.style.display === 'none') fab.style.display = ''; }
    else {
      if (fab.style.display !== 'none') fab.style.display = 'none';
      if (panelOpen) togglePanel(false);
    }
  }

  /* ── 전체화면 대응 ───────────────────────────────────── */
  function getFsRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fs) return document.documentElement;
    return fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement) : fs;
  }

  function reparent() {
    const target = getFsRoot();
    if (fab && fab.parentNode !== target) {
      try { target.appendChild(fab); } catch (_) {}
    }
    if (panel && panelOpen && panel.parentNode !== target) {
      try { target.appendChild(panel); } catch (_) {}
    }
  }

  function onFsChange() {
    reparent();
    setTimeout(reparent, 100);
  }

  /* ── 분석 tick ───────────────────────────────────────── */
  function tick() {
    if (!liveVideo || !liveVideo.isConnected) {
      liveVideo = null;
      killShadow();
      scheduleDetect();
      return;
    }

    let res = sampleRGB(liveVideo);

    if (!res.ok) {
      const src = liveVideo.currentSrc || liveVideo.src;
      if (src && !shadowVid) {
        if (panelOpen) setStatus('CORS 우회 시도…', false);
        makeShadow(src, liveVideo.currentTime);
      }
      if (shadowVid && shadowVid.readyState >= 2) {
        shadowVid.currentTime = liveVideo.currentTime;
        res = sampleRGB(shadowVid);
      }
    }

    if (!res.ok && shadowVid) return;

    if (!res.ok) {
      if (panelOpen) showError('이 사이트는 픽셀 읽기가 차단됩니다\n(' + res.error + ')');
      updateFabState('error', 0);
      return;
    }

    if (panelOpen) clearError();
    history.push(res);
    if (history.length > CFG.histLen) history.shift();

    updateFabState(res.score > CFG.threshold ? 'warn' : 'ok', res.score);

    if (panelOpen && panel) {
      renderUI(res);
      drawGraph();
    }
  }

  /* ── 패널 UI ─────────────────────────────────────────── */
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
    else                       { bd.textContent = '✅  색조 정상';     bd.className = 'ok'; }

    const tempEl = q('ytd-temp');
    if (tempEl) {
      const temp = scoreToTemp(score);
      if (temp === 0) {
        tempEl.textContent = '권장 색온도 보정: 불필요';
        tempEl.className = 'ytd-temp ok';
      } else {
        tempEl.textContent = `권장 색온도 보정: ${temp}`;
        tempEl.className = 'ytd-temp ' + (Math.abs(temp) >= 3 ? 'warn' : 'mild');
      }
    }
  }

  function drawGraph() {
    const gc = q('ytd-gc'); if (!gc) return;
    const gx = gc.getContext('2d');
    const W = gc.width, H = gc.height;
    gx.clearRect(0, 0, W, H);
    if (history.length < 2) return;
    const scores = history.map(d => d.score);
    const hi = Math.max(CFG.threshold * 2.2, ...scores);
    const lo = Math.min(0, ...scores);
    const rng = hi - lo || 1;
    const ty = s => H - ((s - lo) / rng * (H - 10)) - 5;
    const tx = i => (i / (CFG.histLen - 1)) * W;
    const ox = CFG.histLen - history.length;

    gx.strokeStyle = 'rgba(245,200,66,.2)'; gx.lineWidth = 1;
    gx.setLineDash([3, 4]);
    gx.beginPath(); gx.moveTo(0, ty(CFG.threshold)); gx.lineTo(W, ty(CFG.threshold)); gx.stroke();
    gx.setLineDash([]);

    gx.beginPath();
    history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i + ox), ty(d.score)) : gx.lineTo(tx(i + ox), ty(d.score)));
    const grad = gx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(245,200,66,.28)'); grad.addColorStop(1, 'rgba(245,200,66,.02)');
    gx.lineTo(tx(ox + history.length - 1), H); gx.lineTo(tx(ox), H); gx.closePath();
    gx.fillStyle = grad; gx.fill();

    gx.beginPath();
    history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i + ox), ty(d.score)) : gx.lineTo(tx(i + ox), ty(d.score)));
    gx.strokeStyle = '#f5c842'; gx.lineWidth = 1.5; gx.stroke();
  }

  function setStatus(txt, active) {
    const el = q('ytd-st'); if (!el) return;
    el.textContent = txt; el.className = active ? 'on' : '';
  }
  function showError(msg) {
    const el = q('ytd-err'); if (!el) return;
    el.textContent = msg; el.style.display = 'block';
    const bd = q('ytd-badge'); if (bd) { bd.textContent = '❌  픽셀 읽기 실패'; bd.className = 'err'; }
    setStatus('오류', false);
  }
  function clearError() {
    const el = q('ytd-err'); if (el) el.style.display = 'none';
    setStatus('분석 중', true);
  }

  /* ── 분석 시작/중지 ──────────────────────────────────── */
  function startAnalysis(video) {
    stopAnalysis();
    liveVideo = video; history = [];
    if (panelOpen) setStatus('분석 중', true);
    timerID = setInterval(tick, CFG.intervalMs);
  }
  function stopAnalysis() {
    if (timerID) { clearInterval(timerID); timerID = null; }
    killShadow();
    if (panelOpen) setStatus('대기', false);
    updateFabState('idle', 0);
  }

  /* ── 영상 목록 ───────────────────────────────────────── */
  function refreshVideoList() {
    const sel = q('ytd-sel');
    const videos = [...document.querySelectorAll('video')];

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
        opt.textContent = `#${i + 1} ${v.videoWidth || '?'}×${v.videoHeight || '?'} rs=${v.readyState}`;
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

  /* ── 영상 자동 감지 ──────────────────────────────────── */
  let detectTimer = 0;
  function scheduleDetect() {
    if (detectTimer) return;
    detectTimer = setTimeout(() => {
      detectTimer = 0;
      autoDetect();
    }, 300);
  }

  function pickBestVideo() {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return null;
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

  function autoDetect() {
    const best = pickBestVideo();
    const hasVid = !!best;
    setFabVisible(hasVid);

    if (hasVid && !liveVideo) {
      startAnalysis(best);
    } else if (!hasVid && liveVideo) {
      stopAnalysis();
      liveVideo = null;
    }
  }

  /* ── FAB 빌드 ────────────────────────────────────────── */
  function buildFab() {
    if (fab) return;

    fabStyle = document.createElement('style');
    fabStyle.id = '__ytd3_fab_style__';
    fabStyle.textContent = `
      .ytd-fab{position:fixed;top:40px;right:0px;z-index:2147483647;opacity:0.5;
        width:48px;height:62px;border-radius:14px;
        background:#15171c;border:2px solid #2a2d36;
        cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:2px;padding:4px 0 2px;
        transition:all .35s cubic-bezier(.16,1,.3,1);
        box-shadow:0 4px 16px rgba(0,0,0,.5);
        user-select:none;-webkit-tap-highlight-color:transparent}
      .ytd-fab:hover{transform:scale(1.08);border-color:#3a3d48;
        box-shadow:0 6px 24px rgba(0,0,0,.6)}
      .ytd-fab-icon{width:20px;height:20px;position:relative;
        display:flex;align-items:center;justify-content:center}
      .ytd-fab-icon svg{width:18px;height:18px}
      .ytd-fab-ring{position:absolute;top:-4px;left:-4px;right:-4px;bottom:-4px;
        border-radius:50%;border:2px solid transparent;
        transition:all .4s ease;pointer-events:none}
      .ytd-fab-dot{position:absolute;top:-2px;right:-2px;
        width:10px;height:10px;border-radius:50%;
        background:transparent;border:2px solid #15171c;
        transition:all .3s ease;pointer-events:none}
      .ytd-fab-score{
        font:700 9px/1 monospace;color:#4a5060;
        background:#1a1d24;padding:1px 5px;border-radius:6px;
        border:1px solid #2a2d36;pointer-events:none;
        transition:all .3s ease;min-width:24px;text-align:center}
      .ytd-fab-clock{
        font:600 8px/1 monospace;color:#555a68;
        letter-spacing:.5px;pointer-events:none;
        transition:color .3s ease;margin-top:1px}
      .ytd-fab--idle{border-color:#2a2d36}
      .ytd-fab--idle .ytd-fab-icon svg{fill:#4a5060;stroke:#4a5060}
      .ytd-fab--idle .ytd-fab-dot{background:transparent}
      .ytd-fab--idle .ytd-fab-score{color:#4a5060;border-color:#2a2d36}
      .ytd-fab--idle .ytd-fab-clock{color:#3a3d48}
      .ytd-fab--ok{border-color:#1a3a22}
      .ytd-fab--ok .ytd-fab-icon svg{fill:none;stroke:#50d070}
      .ytd-fab--ok .ytd-fab-ring{border-color:rgba(80,208,112,.15)}
      .ytd-fab--ok .ytd-fab-dot{background:#50d070;box-shadow:0 0 6px rgba(80,208,112,.5)}
      .ytd-fab--ok .ytd-fab-score{color:#50d070;border-color:#1a3a22}
      .ytd-fab--ok .ytd-fab-clock{color:#3a6a42}
      .ytd-fab--warn{border-color:#f5c842;
        box-shadow:0 0 16px rgba(245,200,66,.25),0 0 40px rgba(245,200,66,.08),0 4px 16px rgba(0,0,0,.5);
        animation:ytd-fab-pulse 1.8s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-icon svg{fill:none;stroke:#f5c842}
      .ytd-fab--warn .ytd-fab-ring{border-color:rgba(245,200,66,.35);
        box-shadow:0 0 12px rgba(245,200,66,.15);animation:ytd-ring-pulse 1.8s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-dot{background:#f5c842;
        box-shadow:0 0 8px rgba(245,200,66,.7);animation:ytd-dot-blink 1s ease-in-out infinite}
      .ytd-fab--warn .ytd-fab-score{color:#f5c842;border-color:#4a3800;background:#1f1a08}
      .ytd-fab--warn .ytd-fab-clock{color:#8a7030}
      .ytd-fab--error{border-color:#3a1515}
      .ytd-fab--error .ytd-fab-icon svg{fill:none;stroke:#e06060}
      .ytd-fab--error .ytd-fab-dot{background:#e06060;box-shadow:0 0 6px rgba(224,96,96,.5)}
      .ytd-fab--error .ytd-fab-score{color:#e06060;border-color:#3a1515}
      .ytd-fab--error .ytd-fab-clock{color:#6a3030}
      @keyframes ytd-fab-pulse{
        0%,100%{box-shadow:0 0 16px rgba(245,200,66,.25),0 0 40px rgba(245,200,66,.08),0 4px 16px rgba(0,0,0,.5)}
        50%{box-shadow:0 0 24px rgba(245,200,66,.4),0 0 60px rgba(245,200,66,.12),0 4px 16px rgba(0,0,0,.5)}}
      @keyframes ytd-ring-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.1);opacity:.6}}
      @keyframes ytd-dot-blink{0%,100%{opacity:1}50%{opacity:.3}}`;
    document.documentElement.appendChild(fabStyle);

    fab = document.createElement('div');
    fab.className = 'ytd-fab ytd-fab--idle';
    fab.style.display = 'none';

    // 아이콘
    const iconWrap = document.createElement('div');
    iconWrap.className = 'ytd-fab-icon';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '5');
    svg.appendChild(circle);

    const lines = [
      [12,1,12,3],[12,21,12,23],[4.22,4.22,5.64,5.64],
      [18.36,18.36,19.78,19.78],[1,12,3,12],[21,12,23,12],
      [4.22,19.78,5.64,18.36],[18.36,5.64,19.78,4.22]
    ];
    for (const [x1,y1,x2,y2] of lines) {
      const ln = document.createElementNS(svgNS, 'line');
      ln.setAttribute('x1', x1); ln.setAttribute('y1', y1);
      ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
      svg.appendChild(ln);
    }
    iconWrap.appendChild(svg);

    const ring = document.createElement('div');
    ring.className = 'ytd-fab-ring';
    iconWrap.appendChild(ring);

    const dot = document.createElement('div');
    dot.className = 'ytd-fab-dot';
    iconWrap.appendChild(dot);

    fab.appendChild(iconWrap);

    // 스코어
    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'ytd-fab-score';
    fab.appendChild(scoreSpan);

    // ★ 시계
    const clockSpan = document.createElement('span');
    clockSpan.className = 'ytd-fab-clock';
    clockSpan.textContent = '--:--:--';
    fab.appendChild(clockSpan);

    // 드래그 & 클릭
    let dragging = false, moved = false, startX = 0, startY = 0, fabX = 0, fabY = 0;

    fab.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      const r = fab.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      fabX = r.left; fabY = r.top;
      fab.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    fab.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      fab.style.left = (fabX + dx) + 'px';
      fab.style.top = (fabY + dy) + 'px';
      fab.style.right = 'auto';
    });

    fab.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      fab.releasePointerCapture(e.pointerId);
      if (!moved) togglePanel();
    });

    document.documentElement.appendChild(fab);

    // ★ 시계 시작
    startClock();
  }

  /* ── 패널 빌드 ───────────────────────────────────────── */
  function buildPanel() {
    const el = document.createElement('div');
    el.id = '__ytd2__';
    el.innerHTML = safeHTML(`
      <div id="ytd-hdr">
        <span>🔍 Tint Detector</span>
        <div>
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
      <div id="ytd-foot">
        <select id="ytd-sel"></select>
        <span id="ytd-st">대기</span>
      </div>
      <div id="ytd-err"></div>`);

    getFsRoot().appendChild(el);

    panelStyle = document.createElement('style');
    panelStyle.id = '__ytd2_style__';
    panelStyle.textContent = `
      #__ytd2__{position:fixed;top:70px;right:64px;width:236px;
        background:#101215;color:#ccd0d8;font:11.5px/1.5 monospace;
        border:1px solid #252830;border-radius:10px;
        box-shadow:0 8px 32px #000a;z-index:2147483646;overflow:hidden;
        opacity:0;transform:translateX(12px) scale(.95);
        transition:opacity .25s cubic-bezier(.16,1,.3,1),transform .3s cubic-bezier(.34,1.56,.64,1);
        pointer-events:none}
      #__ytd2__.open{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
      #ytd-hdr{display:flex;align-items:center;justify-content:space-between;
        padding:7px 10px;background:#181b21;border-bottom:1px solid #252830;
        cursor:move;font-size:11px;color:#7a8499;letter-spacing:.05em}
      #ytd-hdr div{display:flex;gap:3px}
      #ytd-hdr button{background:none;border:none;color:#4a5060;cursor:pointer;
        font-size:13px;padding:0 3px;line-height:1}
      #ytd-hdr button:hover{color:#ccd0d8}
      #ytd-badge{margin:9px 10px 2px;padding:5px 10px;border-radius:6px;
        font-size:11px;font-weight:700;letter-spacing:.04em;text-align:center;
        background:#1a1d24;color:#7a8499;transition:background .25s,color .25s}
      #ytd-badge.warn{background:#2c1f00;color:#f5c842}
      #ytd-badge.ok{background:#0b1f10;color:#50d070}
      #ytd-badge.err{background:#200a0a;color:#e06060}
      #ytd-bars{padding:7px 10px 4px;display:flex;flex-direction:column;gap:5px}
      .row{display:flex;align-items:center;gap:5px}
      .row>span:first-child{width:10px;font-size:10px;color:#4a5060}
      .row>span:last-child{width:28px;text-align:right;font-size:10px;color:#7a8499}
      .trk{flex:1;height:5px;background:#1a1d24;border-radius:3px;overflow:hidden}
      .fill{height:100%;width:0;border-radius:3px;transition:width .35s}
      #ytd-score{display:flex;justify-content:space-between;align-items:center;
        padding:5px 10px;border-top:1px solid #1a1d24;margin-top:3px;font-size:10px;color:#4a5060}
      #ytd-score b{font-size:14px;color:#ccd0d8}
      .ytd-temp{font-size:11px;font-weight:600;text-align:center;
        padding:4px 10px;margin:2px 10px;border-radius:5px;
        background:#1a1d24;color:#7a8499;transition:all .25s}
      .ytd-temp.ok{color:#50d070}
      .ytd-temp.mild{color:#d4a84a}
      .ytd-temp.warn{color:#f5c842;background:#2c1f00}
      #ytd-gc{display:block;margin:4px 10px 6px;width:calc(100% - 20px);background:#0b0d10;border-radius:4px}
      #ytd-foot{display:flex;align-items:center;justify-content:space-between;
        padding:5px 10px;border-top:1px solid #252830;background:#181b21}
      #ytd-sel{flex:1;max-width:134px;background:#1a1d24;color:#7a8499;
        border:1px solid #252830;border-radius:4px;font-size:10px;padding:2px 4px}
      #ytd-st{font-size:10px;color:#4a5060}
      #ytd-st.on{color:#50d070;animation:ytdblink 1.3s infinite}
      #ytd-err{padding:0 10px 7px;font-size:10px;color:#c04040;
        word-break:break-all;display:none;line-height:1.45}
      @keyframes ytdblink{0%,100%{opacity:1}50%{opacity:.3}}`;
    document.documentElement.appendChild(panelStyle);
    return el;
  }

  function ensurePanel() {
    if (panel && document.documentElement.contains(panel)) return;
    if (panel && getFsRoot().contains(panel)) return;
    panel = buildPanel();
    bindPanelEvents();
  }

  function destroyPanel() {
    if (!panel) return;
    panel.remove(); panel = null;
    if (panelStyle) { panelStyle.remove(); panelStyle = null; }
    panelOpen = false;
  }

  function bindPanelEvents() {
    q('ytd-sel').addEventListener('change', () => {
      const videos = [...document.querySelectorAll('video')];
      const v = videos[+q('ytd-sel').value];
      if (v) startAnalysis(v);
    });
    q('ytd-refresh').addEventListener('click', refreshVideoList);
    q('ytd-close').addEventListener('click', () => togglePanel(false));

    let dragging = false, dx = 0, dy = 0;
    q('ytd-hdr').addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      e.target.setPointerCapture(e.pointerId);
    });
    q('ytd-hdr').addEventListener('pointermove', e => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    q('ytd-hdr').addEventListener('pointerup', () => { dragging = false; });
  }

  /* ── 패널 토글 ───────────────────────────────────────── */
  function togglePanel(force) {
    panelOpen = force !== undefined ? force : !panelOpen;

    if (panelOpen) {
      ensurePanel();
      panel.classList.add('open');
      refreshVideoList();
      if (history.length > 0) {
        renderUI(history[history.length - 1]);
        drawGraph();
      }
    } else {
      if (panel) panel.classList.remove('open');
      setTimeout(() => { if (!panelOpen) destroyPanel(); }, 350);
    }
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
