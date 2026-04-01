// ==UserScript==
// @name         Yellow Tint Detector
// @namespace    https://github.com/
// @version      3.0.1
// @description  영상의 노란끼(황조) 실시간 감지 — 아이콘 FAB + 패널 토글 (영상 없을 때 숨김)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    sampleSize:  48,
    intervalMs:  800,
    threshold:   12,
    histLen:     24,
  };

  let timerID    = null;
  let liveVideo  = null;
  let shadowVid  = null;
  let history    = [];
  let panel      = null;
  let fab        = null;
  let fabStyle   = null;
  let panelOpen  = false;
  let lastScore  = 0;
  let lastStatus = 'idle'; // idle | ok | warn | error

  const offscreen = document.createElement('canvas');
  offscreen.width = offscreen.height = CFG.sampleSize;
  const oCtx = offscreen.getContext('2d', { willReadFrequently: true });

  // ── cross-origin 조기 주입 ────────────────────────────────
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

  // ── 샘플링 ───────────────────────────────────────────────
  function sampleRGB(video) {
    try {
      oCtx.drawImage(video, 0, 0, CFG.sampleSize, CFG.sampleSize);
      const px = oCtx.getImageData(0, 0, CFG.sampleSize, CFG.sampleSize).data;
      let r = 0, g = 0, b = 0, n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; b += px[i+2]; }
      r /= n; g /= n; b /= n;
      return { ok: true, r, g, b, score: (r - b) + (g - b) * 0.5 };
    } catch(e) {
      return { ok: false, error: e.name + ': ' + e.message };
    }
  }

  // ── shadow video (CORS fallback) ─────────────────────────
  function makeShadow(src, currentTime) {
    if (shadowVid) { shadowVid.src = ''; shadowVid.remove(); shadowVid = null; }
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true; v.volume = 0;
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.001;top:0;left:0;pointer-events:none';
    document.body.appendChild(v);
    v.src = src;
    v.currentTime = currentTime || 0;
    v.play().catch(() => {});
    shadowVid = v;
    return v;
  }

  // ── FAB 아이콘 상태 업데이트 ─────────────────────────────
  function updateFabState(status, score) {
    if (!fab) return;
    lastStatus = status;
    lastScore = score || 0;

    const icon = fab.querySelector('.ytd-fab-icon');
    const ring = fab.querySelector('.ytd-fab-ring');
    const dot = fab.querySelector('.ytd-fab-dot');
    const scoreEl = fab.querySelector('.ytd-fab-score');

    if (scoreEl) {
      scoreEl.textContent = status === 'idle' ? '' : status === 'error' ? '!' : Math.round(score);
    }

    // 링 색상
    fab.className = 'ytd-fab ytd-fab--' + status;
  }

  // ── FAB 표시/숨김 관리 ───────────────────────────────────
  function updateFabVisibility(hasVideo) {
    if (!fab) return;
    if (hasVideo) {
      if (fab.style.display === 'none') fab.style.display = '';
    } else {
      if (fab.style.display !== 'none') fab.style.display = 'none';
      if (panelOpen) togglePanel(false); // 영상이 없어지면 패널도 닫기
    }
  }

  // ── 분석 tick ────────────────────────────────────────────
  function tick() {
    if (!liveVideo) return;

    let res = sampleRGB(liveVideo);

    if (!res.ok) {
      const src = liveVideo.currentSrc || liveVideo.src;
      if (src && !shadowVid) {
        setStatus('CORS 우회 시도…', false);
        makeShadow(src, liveVideo.currentTime);
      }
      if (shadowVid) {
        shadowVid.currentTime = liveVideo.currentTime;
        res = sampleRGB(shadowVid);
      }
    }

    if (!res.ok) {
      showError('이 사이트는 픽셀 읽기가 차단됩니다\n(' + res.error + ')');
      updateFabState('error', 0);
      return;
    }

    clearError();
    history.push(res);
    if (history.length > CFG.histLen) history.shift();

    // FAB 상태 업데이트 (패널 닫혀있어도 항상)
    updateFabState(res.score > CFG.threshold ? 'warn' : 'ok', res.score);

    // 패널 열려있으면 UI 갱신
    if (panelOpen && panel) {
      renderUI(res);
      drawGraph();
    }
  }

  // ── UI 렌더 ───────────────────────────────────────────────
  function q(id) { return panel && panel.querySelector('#' + id); }

  function renderUI({ r, g, b, score }) {
    const pct = v => (v / 255 * 100).toFixed(1) + '%';
    const rb = q('rb'); if (!rb) return;
    rb.style.width = pct(r); q('rv').textContent = Math.round(r);
    q('gb').style.width = pct(g); q('gv').textContent = Math.round(g);
    q('bb').style.width = pct(b); q('bv').textContent = Math.round(b);
    q('sv').textContent = score.toFixed(1);
    const bd = q('ytd-badge');
    if (score > CFG.threshold) { bd.textContent = '⚠️  노란끼 감지됨'; bd.className = 'warn'; }
    else                       { bd.textContent = '✅  색조 정상';     bd.className = 'ok';   }
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
    history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i+ox), ty(d.score)) : gx.lineTo(tx(i+ox), ty(d.score)));
    const grad = gx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(245,200,66,.28)'); grad.addColorStop(1, 'rgba(245,200,66,.02)');
    gx.lineTo(tx(ox + history.length - 1), H); gx.lineTo(tx(ox), H); gx.closePath();
    gx.fillStyle = grad; gx.fill();

    gx.beginPath();
    history.forEach((d, i) => i === 0 ? gx.moveTo(tx(i+ox), ty(d.score)) : gx.lineTo(tx(i+ox), ty(d.score)));
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
    if (panelOpen) setStatus('분석 중', true);
  }

  // ── 분석 시작/중지 ───────────────────────────────────────
  function startAnalysis(video) {
    stopAnalysis(); liveVideo = video; history = [];
    if (panelOpen) setStatus('분석 중', true);
    timerID = setInterval(tick, CFG.intervalMs);
  }
  function stopAnalysis() {
    if (timerID) { clearInterval(timerID); timerID = null; }
    if (shadowVid) { shadowVid.src = ''; shadowVid.remove(); shadowVid = null; }
    if (panelOpen) setStatus('대기', false);
    updateFabState('idle', 0);
  }

  // ── 영상 목록 ────────────────────────────────────────────
  function refreshVideoList() {
    const sel = q('ytd-sel');
    const videos = [...document.querySelectorAll('video')];

    if (sel) {
      sel.innerHTML = '';
      if (!videos.length) {
        sel.innerHTML = '<option>영상 없음</option>'; stopAnalysis();
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
      // 패널 안 열려있어도 영상 자동 감지
      if (!videos.length) { stopAnalysis(); return; }
      const prev = liveVideo ? videos.indexOf(liveVideo) : -1;
      const idx = prev >= 0 ? prev : 0;
      startAnalysis(videos[idx]);
    }
  }

  // ── FAB 빌드 ─────────────────────────────────────────────
  function buildFab() {
    if (fab) return;

    fabStyle = document.createElement('style');
    fabStyle.id = '__ytd3_fab_style__';
    fabStyle.textContent = `
      .ytd-fab {
        position: fixed; top: 130px; right: 14px; z-index: 2147483647;
        width: 40px; height: 40px; border-radius: 50%;
        background: #15171c; border: 2px solid #2a2d36;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        user-select: none; -webkit-tap-highlight-color: transparent;
      }
      .ytd-fab:hover {
        transform: scale(1.12);
        border-color: #3a3d48;
        box-shadow: 0 6px 24px rgba(0,0,0,0.6);
      }
      .ytd-fab-icon {
        width: 20px; height: 20px; position: relative;
        display: flex; align-items: center; justify-content: center;
      }
      .ytd-fab-icon svg { width: 18px; height: 18px; }
      .ytd-fab-ring {
        position: absolute; top: -4px; left: -4px; right: -4px; bottom: -4px;
        border-radius: 50%; border: 2px solid transparent;
        transition: all 0.4s ease; pointer-events: none;
      }
      .ytd-fab-dot {
        position: absolute; top: -2px; right: -2px;
        width: 10px; height: 10px; border-radius: 50%;
        background: transparent; border: 2px solid #15171c;
        transition: all 0.3s ease; pointer-events: none;
      }
      .ytd-fab-score {
        position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%);
        font: 700 9px/1 monospace; color: #4a5060;
        background: #15171c; padding: 1px 4px; border-radius: 6px;
        border: 1px solid #2a2d36; pointer-events: none;
        transition: all 0.3s ease; min-width: 18px; text-align: center;
      }

      /* idle */
      .ytd-fab--idle { border-color: #2a2d36; }
      .ytd-fab--idle .ytd-fab-icon svg { fill: #4a5060; stroke: #4a5060; }
      .ytd-fab--idle .ytd-fab-dot { background: transparent; }
      .ytd-fab--idle .ytd-fab-score { color: #4a5060; border-color: #2a2d36; }

      /* ok */
      .ytd-fab--ok { border-color: #1a3a22; }
      .ytd-fab--ok .ytd-fab-icon svg { fill: none; stroke: #50d070; }
      .ytd-fab--ok .ytd-fab-ring { border-color: rgba(80,208,112,0.15); }
      .ytd-fab--ok .ytd-fab-dot { background: #50d070; box-shadow: 0 0 6px rgba(80,208,112,0.5); }
      .ytd-fab--ok .ytd-fab-score { color: #50d070; border-color: #1a3a22; }

      /* warn */
      .ytd-fab--warn {
        border-color: #f5c842;
        box-shadow: 0 0 16px rgba(245,200,66,0.25), 0 0 40px rgba(245,200,66,0.08), 0 4px 16px rgba(0,0,0,0.5);
        animation: ytd-fab-pulse 1.8s ease-in-out infinite;
      }
      .ytd-fab--warn .ytd-fab-icon svg { fill: none; stroke: #f5c842; }
      .ytd-fab--warn .ytd-fab-ring {
        border-color: rgba(245,200,66,0.35);
        box-shadow: 0 0 12px rgba(245,200,66,0.15);
        animation: ytd-ring-pulse 1.8s ease-in-out infinite;
      }
      .ytd-fab--warn .ytd-fab-dot {
        background: #f5c842;
        box-shadow: 0 0 8px rgba(245,200,66,0.7);
        animation: ytd-dot-blink 1s ease-in-out infinite;
      }
      .ytd-fab--warn .ytd-fab-score {
        color: #f5c842; border-color: #4a3800;
        background: #1f1a08;
      }

      /* error */
      .ytd-fab--error { border-color: #3a1515; }
      .ytd-fab--error .ytd-fab-icon svg { fill: none; stroke: #e06060; }
      .ytd-fab--error .ytd-fab-dot { background: #e06060; box-shadow: 0 0 6px rgba(224,96,96,0.5); }
      .ytd-fab--error .ytd-fab-score { color: #e06060; border-color: #3a1515; }

      @keyframes ytd-fab-pulse {
        0%, 100% { box-shadow: 0 0 16px rgba(245,200,66,0.25), 0 0 40px rgba(245,200,66,0.08), 0 4px 16px rgba(0,0,0,0.5); }
        50%      { box-shadow: 0 0 24px rgba(245,200,66,0.4),  0 0 60px rgba(245,200,66,0.12), 0 4px 16px rgba(0,0,0,0.5); }
      }
      @keyframes ytd-ring-pulse {
        0%, 100% { transform: scale(1);   opacity: 1; }
        50%      { transform: scale(1.1); opacity: 0.6; }
      }
      @keyframes ytd-dot-blink {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.3; }
      }
    `;
    document.documentElement.appendChild(fabStyle);

    fab = document.createElement('div');
    fab.className = 'ytd-fab ytd-fab--idle';
    fab.style.display = 'none'; // 기본적으로 숨김 처리
    fab.innerHTML = `
      <div class="ytd-fab-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/>
          <line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <div class="ytd-fab-ring"></div>
        <div class="ytd-fab-dot"></div>
      </div>
      <span class="ytd-fab-score"></span>
    `;

    fab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    // 드래그 이동
    let dragging = false, startX = 0, startY = 0, fabX = 0, fabY = 0, moved = false;
    fab.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      const r = fab.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      fabX = r.left; fabY = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      fab.style.left = (fabX + dx) + 'px';
      fab.style.top = (fabY + dy) + 'px';
      fab.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging && !moved) { /* click handled by click listener */ }
      dragging = false;
    });
    fab.addEventListener('click', (e) => {
      if (moved) { e.stopImmediatePropagation(); moved = false; }
    }, true);

    document.documentElement.appendChild(fab);
  }

  // ── 패널 구축 ────────────────────────────────────────────
  function buildPanel() {
    const el = document.createElement('div');
    el.id = '__ytd2__';
    el.innerHTML = `
      <div id="ytd-hdr">
        <span>🔍 Tint Detector</span>
        <div>
          <button id="ytd-refresh" title="재탐색">↺</button>
          <button id="ytd-close"   title="닫기">✕</button>
        </div>
      </div>
      <div id="ytd-badge">초기화 중…</div>
      <div id="ytd-bars">
        <div class="row"><span>R</span><div class="trk"><div id="rb" class="fill" style="background:#e05858"></div></div><span id="rv">—</span></div>
        <div class="row"><span>G</span><div class="trk"><div id="gb" class="fill" style="background:#5ab85a"></div></div><span id="gv">—</span></div>
        <div class="row"><span>B</span><div class="trk"><div id="bb" class="fill" style="background:#5090e0"></div></div><span id="bv">—</span></div>
      </div>
      <div id="ytd-score"><span>Yellow Score</span><b id="sv">—</b></div>
      <canvas id="ytd-gc" width="212" height="52"></canvas>
      <div id="ytd-foot">
        <select id="ytd-sel"></select>
        <span id="ytd-st">대기</span>
      </div>
      <div id="ytd-err"></div>`;
    document.documentElement.appendChild(el);

    const s = document.createElement('style');
    s.id = '__ytd2_style__';
    s.textContent = `
      #__ytd2__{position:fixed;top:70px;right:64px;width:236px;
        background:#101215;color:#ccd0d8;font:11.5px/1.5 monospace;
        border:1px solid #252830;border-radius:10px;
        box-shadow:0 8px 32px #000a;z-index:2147483646;overflow:hidden;
        opacity:0;transform:translateX(12px) scale(0.95);
        transition:opacity 0.25s cubic-bezier(0.16,1,0.3,1),transform 0.3s cubic-bezier(0.34,1.56,0.64,1);
        pointer-events:none;}
      #__ytd2__.open{opacity:1;transform:translateX(0) scale(1);pointer-events:auto;}
      #ytd-hdr{display:flex;align-items:center;justify-content:space-between;
        padding:7px 10px;background:#181b21;border-bottom:1px solid #252830;
        cursor:move;font-size:11px;color:#7a8499;letter-spacing:.05em;}
      #ytd-hdr div{display:flex;gap:3px;}
      #ytd-hdr button{background:none;border:none;color:#4a5060;cursor:pointer;
        font-size:13px;padding:0 3px;line-height:1;}
      #ytd-hdr button:hover{color:#ccd0d8;}
      #ytd-badge{margin:9px 10px 2px;padding:5px 10px;border-radius:6px;
        font-size:11px;font-weight:700;letter-spacing:.04em;text-align:center;
        background:#1a1d24;color:#7a8499;transition:background .25s,color .25s;}
      #ytd-badge.warn{background:#2c1f00;color:#f5c842;}
      #ytd-badge.ok  {background:#0b1f10;color:#50d070;}
      #ytd-badge.err {background:#200a0a;color:#e06060;}
      #ytd-bars{padding:7px 10px 4px;display:flex;flex-direction:column;gap:5px;}
      .row{display:flex;align-items:center;gap:5px;}
      .row>span:first-child{width:10px;font-size:10px;color:#4a5060;}
      .row>span:last-child {width:28px;text-align:right;font-size:10px;color:#7a8499;}
      .trk{flex:1;height:5px;background:#1a1d24;border-radius:3px;overflow:hidden;}
      .fill{height:100%;width:0;border-radius:3px;transition:width .35s;}
      #ytd-score{display:flex;justify-content:space-between;align-items:center;
        padding:5px 10px;border-top:1px solid #1a1d24;margin-top:3px;
        font-size:10px;color:#4a5060;}
      #ytd-score b{font-size:14px;color:#ccd0d8;}
      #ytd-gc{display:block;margin:0 10px 6px;width:calc(100% - 20px);
        background:#0b0d10;border-radius:4px;}
      #ytd-foot{display:flex;align-items:center;justify-content:space-between;
        padding:5px 10px;border-top:1px solid #252830;background:#181b21;}
      #ytd-sel{flex:1;max-width:134px;background:#1a1d24;color:#7a8499;
        border:1px solid #252830;border-radius:4px;font-size:10px;padding:2px 4px;}
      #ytd-st{font-size:10px;color:#4a5060;}
      #ytd-st.on{color:#50d070;animation:ytdblink 1.3s infinite;}
      #ytd-err{padding:0 10px 7px;font-size:10px;color:#c04040;
        word-break:break-all;display:none;line-height:1.45;}
      @keyframes ytdblink{0%,100%{opacity:1}50%{opacity:.3}}`;
    document.documentElement.appendChild(s);
    return el;
  }

  function ensurePanel() {
    if (!panel || !document.documentElement.contains(panel)) {
      panel = buildPanel();
      bindPanelEvents();
    }
  }

  function bindPanelEvents() {
    q('ytd-sel').addEventListener('change', () => {
      const videos = [...document.querySelectorAll('video')];
      const v = videos[+q('ytd-sel').value];
      if (v) startAnalysis(v);
    });
    q('ytd-refresh').addEventListener('click', refreshVideoList);
    q('ytd-close').addEventListener('click', () => { togglePanel(false); });

    // 패널 드래그
    let dragging = false, dx = 0, dy = 0;
    q('ytd-hdr').addEventListener('mousedown', e => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top  = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── 패널 토글 ────────────────────────────────────────────
  function togglePanel(force) {
    ensurePanel();
    panelOpen = force !== undefined ? force : !panelOpen;

    if (panelOpen) {
      panel.classList.add('open');
      // 열릴 때 최신 데이터로 갱신
      refreshVideoList();
      if (history.length > 0) {
        renderUI(history[history.length - 1]);
        drawGraph();
      }
    } else {
      panel.classList.remove('open');
    }
  }

  // ── 자동 영상 감지 (백그라운드) ──────────────────────────
  function autoDetect() {
    const videos = [...document.querySelectorAll('video')];
    updateFabVisibility(videos.length > 0);

    if (videos.length > 0 && !liveVideo) {
      // 가장 큰 영상 자동 선택
      let best = null, bestArea = 0;
      for (const v of videos) {
        const area = (v.clientWidth || 0) * (v.clientHeight || 0);
        if (area > bestArea || (!best && v.readyState > 0)) { best = v; bestArea = area; }
      }
      if (best) startAnalysis(best);
    } else if (videos.length === 0 && liveVideo) {
      stopAnalysis();
      liveVideo = null;
    }
  }

  // ── 시작 ─────────────────────────────────────────────────
  function init() {
    buildFab();
    autoDetect();

    new MutationObserver(() => {
      // DOM 변화가 일어날 때마다 영상을 재감지하여 표시 여부 업데이트
      autoDetect();
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });

    // 주기적으로 영상 변경 감지
    setInterval(() => {
      if (!liveVideo || !liveVideo.isConnected) {
        liveVideo = null;
      }
      autoDetect();
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
