// ==UserScript==
// @name         Mobile Gesture (v67.03.0)
// @namespace    https://github.com/user
// @version      67.03.0
// @description  v67.03.0: 하단 버튼 자막 회피 배치 + fit/rotate 전체화면 전용
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ────── 모바일 체크 ────── */
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobile) return;

  /* ────── 설정 ────── */
  const CFG = {
    minDist: 10,
    longPress: 500,
    rateBase: 2.0,
    senseX: 0.25,
    senseY: 1.0,
    progressBarColor: '#FF6699',
    uiTimeout: 2500,
    maxScale: 8.0,
    senseRate: 0.015
  };

  /* ────── VIP / 무시 셀렉터 ────── */
  const VIP_SELECTORS = [
    '.html5-video-player',       // YouTube
    '.bilibili-player-video',    // Bilibili
    '.dplayer',                  // DPlayer
    '.plyr',                     // Plyr
    '.jwplayer',                 // JWPlayer
    '.video-js',                 // Video.js
    '.mejs__container',          // MediaElement
    'vk-video-player',           // VK
    '.xgplayer',                 // 西瓜播放器
    '#player',
    '.player',
    '[class*="player"]',
    '[class*="video-container"]',
    '[class*="video-wrapper"]'
  ];

  const IGNORE_TOUCH_SELECTORS = [
    '.ytp-chrome-bottom',
    '.bilibili-player-control',
    '.plyr__controls',
    '.jw-controls',
    '.vjs-control-bar',
    '.mejs__controls',
    '[class*="control-bar"]',
    '[class*="controls"]',
    'button', 'a', 'input', 'textarea', 'select',
    '[role="slider"]',
    '[class*="progress"]',
    '[class*="seek"]',
    '[class*="volume"]',
    '[class*="subtitle"]',
    '[class*="caption"]',
    '[class*="danmaku"]',
    '[class*="comment"]'
  ];

  /* ────── 상태 ────── */
  let state = {
    video: null,
    targetP: null,
    uiLayer: null,
    progressBar: null,
    lockShield: null,
    locked: false,
    mode: GM_getValue('gt_mode', 'speed'),  // speed | zoom
    seekMode: GM_getValue('gt_seekMode', 'sec'),  // sec | frame
    seekVal: GM_getValue('gt_seekVal', 10),
    fps: GM_getValue('gt_fps', 30),
    fitIndex: 0,
    fitModes: ['contain', 'cover', 'fill', 'none'],
    rotationDeg: 0,
    // gesture
    startX: 0, startY: 0, startTime: 0,
    isSeeking: false, isRating: false, isPinching: false,
    longTimer: null,
    longFired: false,
    origRate: 1.0,
    // zoom/pan
    scale: 1.0, panX: 0, panY: 0,
    pinchDist0: 0, scale0: 1.0,
    panStartX: 0, panStartY: 0, panX0: 0, panY0: 0,
    // UI
    uiTimer: null,
    speedChanged: false,
    zoomChanged: false,
    orientationLocked: false,
    // buttons
    btnPip: null, btnShot: null, btnRot: null,
    btnSeekMode: null, btnSeekVal: null,
    btnLock: null, btnMode: null,
    btnFit: null, btnResetSpeed: null, btnResetZoom: null
  };

  /* ────── Shadow DOM LRU ────── */
  const shadowRoots = new Map();
  const MAX_SHADOW = 50;
  function registerShadow(host) {
    if (shadowRoots.has(host)) return host.shadowRoot;
    const sr = host.shadowRoot;
    if (!sr) return null;
    if (shadowRoots.size >= MAX_SHADOW) {
      const first = shadowRoots.keys().next().value;
      shadowRoots.delete(first);
    }
    shadowRoots.set(host, sr);
    observeDOM(sr);
    return sr;
  }

  /* ────── DOM 관찰 ────── */
  function observeDOM(root) {
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO') onVideoFound(n);
          else {
            if (n.shadowRoot) registerShadow(n);
            const vids = n.querySelectorAll ? n.querySelectorAll('video') : [];
            vids.forEach(v => onVideoFound(v));
          }
        }
      }
    });
    mo.observe(root, { childList: true, subtree: true });
  }
  observeDOM(document);

  /* ────── 비디오 발견 ────── */
  function onVideoFound(v) {
    if (v._gtReady) return;
    v._gtReady = true;
    v.addEventListener('play', () => trySetup(v), { once: true });
    if (!v.paused) trySetup(v);
  }

  // 초기 스캔
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('video').forEach(v => onVideoFound(v));
  });

  /* ────── findDeepVid: Shadow DOM 깊이 탐색 ────── */
  function findDeepVid(el) {
    if (!el) return null;
    if (el.tagName === 'VIDEO') return el;
    if (el.shadowRoot) {
      const v = el.shadowRoot.querySelector('video');
      if (v) return v;
      for (const child of el.shadowRoot.children) {
        const found = findDeepVid(child);
        if (found) return found;
      }
    }
    for (const child of el.children) {
      const found = findDeepVid(child);
      if (found) return found;
    }
    return null;
  }

  /* ────── elementsFromPoint + Shadow 탐색으로 비디오 식별 ────── */
  function identifyVideoAt(x, y) {
    // 1단계: elementsFromPoint
    const elems = document.elementsFromPoint(x, y);
    for (const el of elems) {
      if (el.tagName === 'VIDEO') return el;
      if (el.shadowRoot) {
        const v = findDeepVid(el);
        if (v) return v;
      }
    }
    // 2단계: rect 기반 히트테스트
    const allVids = document.querySelectorAll('video');
    for (const v of allVids) {
      const r = v.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 &&
          x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return v;
      }
    }
    // Shadow DOM 내부
    for (const [, sr] of shadowRoots) {
      const vids = sr.querySelectorAll('video');
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 &&
            x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return v;
        }
      }
    }
    // 3단계: 가장 큰 비디오
    let best = null, bestArea = 0;
    const collect = (root) => {
      root.querySelectorAll('video').forEach(v => {
        const r = v.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > bestArea) { bestArea = a; best = v; }
      });
    };
    collect(document);
    shadowRoots.forEach(sr => collect(sr));
    return best;
  }

  /* ────── getValidPlayerRoot ────── */
  function getValidPlayerRoot(video) {
    if (video.gtRoot) {
      if (document.contains(video.gtRoot) || video.gtRoot.getRootNode()) return video.gtRoot;
      video.gtRoot = null;
    }
    // VIP 셀렉터
    let el = video;
    for (let i = 0; i < 15 && el; i++) {
      for (const sel of VIP_SELECTORS) {
        try { if (el.matches && el.matches(sel)) { video.gtRoot = el; return el; } } catch(e){}
      }
      el = el.parentElement || (el.getRootNode && el.getRootNode().host);
    }
    // 크기 기반
    el = video.parentElement;
    for (let i = 0; i < 15 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width >= 50 && r.height >= 50) {
        video.gtRoot = el;
        return el;
      }
      el = el.parentElement || (el.getRootNode && el.getRootNode().host);
    }
    video.gtRoot = video.parentElement || video;
    return video.gtRoot;
  }

  /* ────── findUp (Shadow DOM 경유) ────── */
  function findUp(el, sel, maxDepth = 15) {
    let cur = el, d = 0;
    while (cur && d < maxDepth) {
      try { if (cur.matches && cur.matches(sel)) return cur; } catch(e){}
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host);
      d++;
    }
    return null;
  }

  /* ────── composedPath 기반 제외 영역 검사 ────── */
  function isExcludedZone(e) {
    const path = e.composedPath ? e.composedPath() : (e.path || []);
    for (const node of path) {
      if (node === state.uiLayer) return false; // UI 레이어 자체는 허용
      if (node.nodeType !== 1) continue;
      for (const sel of IGNORE_TOUCH_SELECTORS) {
        try { if (node.matches && node.matches(sel)) return true; } catch(e){}
      }
    }
    return false;
  }

  /* ────── 전체화면 감지 ────── */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function getFullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  /* ────── 방향 잠금/해제 ────── */
  function lockOrientation(orient) {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock(orient).catch(() => {});
        state.orientationLocked = true;
      }
    } catch (e) {}
  }
  function unlockOrientation() {
    try {
      if (state.orientationLocked && screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
        state.orientationLocked = false;
      }
    } catch (e) {}
  }

  /* ────── 영상 방향 감지 ────── */
  function detectVideoOrientation(v) {
    const vw = v.videoWidth || v.clientWidth;
    const vh = v.videoHeight || v.clientHeight;
    return vw >= vh ? 'landscape' : 'portrait';
  }

  /* ────── CSS 주입 ────── */
  function injectCSS(root) {
    if (root.querySelector && root.querySelector('#gt-style')) return;
    const style = document.createElement('style');
    style.id = 'gt-style';
    style.textContent = `
      .gt-layer {
        position: absolute; top:0; left:0; width:100%; height:100%;
        pointer-events: none; z-index: 2147483646;
        touch-action: none;
      }
      .gt-layer * { pointer-events: auto; }

      /* ===== 버튼 공통 ===== */
      .gt-btn {
        position: absolute;
        width: 30px; height: 30px;
        background: rgba(0,0,0,0.45);
        border: 1px solid rgba(255,255,255,0.3);
        border-radius: 6px;
        color: #fff; font-size: 16px;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.3s;
        cursor: pointer; user-select: none;
        pointer-events: auto;
        z-index: 2147483647;
      }
      .gt-layer.gt-show .gt-btn { opacity: 0.7; }
      .gt-btn:active { opacity: 1 !important; background: rgba(0,0,0,0.7); }

      /* ===== 일반 모드 배치 ===== */
      /* 왼쪽 상단: PIP, 스크린샷 */
      .gt-pip-btn { top: 40px; left: 10px; }
      .gt-shot-btn { top: calc(40px + 32px); left: 10px; }

      /* 오른쪽 상단: 탐색모드, 탐색값 */
      .gt-seek-mode-btn { top: 40px; right: 10px; }
      .gt-seek-val-btn { top: calc(40px + 32px); right: 10px; }

      /* 오른쪽 하단: 잠금, 모드(속도/줌) */
      .gt-lock-btn { bottom: 48px; right: 10px; }
      .gt-mode-btn { bottom: calc(48px + 32px); right: 10px; }

      /* 하단: 화면비율(1/3), 회전(2/3) — 자막 중앙 회피 */
      .gt-fit-btn { bottom: 32px; left: 33%; transform: translateX(-50%); }
      .gt-reset-speed-btn { bottom: 32px; left: calc(33% - 36px); transform: translateX(-50%); }
      .gt-rotate-btn { bottom: 32px; left: 67%; transform: translateX(-50%); }
      .gt-reset-zoom-btn { bottom: 32px; left: calc(67% + 36px); transform: translateX(-50%); }

      /* ===== 전체화면 모드 ===== */
      .gt-layer.gt-fs .gt-btn {
        width: 38px; height: 38px; font-size: 22px;
        opacity: 0;
      }
      .gt-layer.gt-fs.gt-show .gt-btn { opacity: 0.5; }

      .gt-layer.gt-fs .gt-pip-btn { top: 55px; left: 14px; }
      .gt-layer.gt-fs .gt-shot-btn { top: calc(55px + 42px); left: 14px; }

      .gt-layer.gt-fs .gt-seek-mode-btn { top: 55px; right: 14px; }
      .gt-layer.gt-fs .gt-seek-val-btn { top: calc(55px + 42px); right: 14px; }

      .gt-layer.gt-fs .gt-lock-btn { bottom: 60px; right: 14px; }
      .gt-layer.gt-fs .gt-mode-btn { bottom: calc(60px + 42px); right: 14px; }

      .gt-layer.gt-fs .gt-fit-btn { bottom: 40px; left: 33%; transform: translateX(-50%); }
      .gt-layer.gt-fs .gt-reset-speed-btn { bottom: 40px; left: calc(33% - 48px); transform: translateX(-50%); }
      .gt-layer.gt-fs .gt-rotate-btn { bottom: 40px; left: 67%; transform: translateX(-50%); }
      .gt-layer.gt-fs .gt-reset-zoom-btn { bottom: 40px; left: calc(67% + 48px); transform: translateX(-50%); }

      /* ===== 프로그레스바 ===== */
      .gt-progress-wrap {
        position: absolute; bottom: 0; left: 0; width: 100%; height: 3px;
        background: rgba(255,255,255,0.2);
        z-index: 2147483647;
        opacity: 0; transition: opacity 0.3s;
      }
      .gt-layer.gt-show .gt-progress-wrap { opacity: 1; }
      .gt-progress-bar {
        height: 100%; width: 0%;
        background: ${CFG.progressBarColor};
        transition: width 0.2s linear;
      }

      /* ===== 잠금 실드 ===== */
      .gt-lock-shield {
        position: absolute; top:0; left:0; width:100%; height:100%;
        z-index: 2147483645; display: none;
        touch-action: none;
      }
      .gt-lock-shield.gt-locked { display: block; }

      /* ===== 토스트 ===== */
      .gt-toast {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0,0,0,0.75); color: #fff;
        padding: 8px 18px; border-radius: 8px;
        font-size: 14px; white-space: nowrap;
        z-index: 2147483647;
        opacity: 0; transition: opacity 0.25s;
        pointer-events: none;
      }
      .gt-toast.gt-toast-show { opacity: 1; }

      /* ===== 미니 시크 표시 ===== */
      .gt-seek-display {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0,0,0,0.7); color: #fff;
        padding: 6px 14px; border-radius: 6px;
        font-size: 18px; font-weight: bold;
        z-index: 2147483647; opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
      }
    `;
    (root.head || root.appendChild ? root : document.head).appendChild(style);
  }

  /* ────── UI 생성 ────── */
  function createUI(container) {
    if (container.querySelector && container.querySelector('.gt-layer')) {
      state.uiLayer = container.querySelector('.gt-layer');
      return;
    }

    injectCSS(container.getRootNode ? container.getRootNode() : document);

    const layer = document.createElement('div');
    layer.className = 'gt-layer';

    // 프로그레스바
    const pw = document.createElement('div');
    pw.className = 'gt-progress-wrap';
    const pb = document.createElement('div');
    pb.className = 'gt-progress-bar';
    pw.appendChild(pb);
    layer.appendChild(pw);
    state.progressBar = pb;

    // 잠금 실드
    const shield = document.createElement('div');
    shield.className = 'gt-lock-shield';
    layer.appendChild(shield);
    state.lockShield = shield;

    // 토스트
    const toast = document.createElement('div');
    toast.className = 'gt-toast';
    layer.appendChild(toast);

    // 시크 표시
    const seekDisp = document.createElement('div');
    seekDisp.className = 'gt-seek-display';
    layer.appendChild(seekDisp);

    // 버튼 생성 함수
    function mkBtn(cls, icon, title) {
      const b = document.createElement('div');
      b.className = `gt-btn ${cls}`;
      b.innerHTML = icon;
      b.title = title || '';
      layer.appendChild(b);
      return b;
    }

    // 왼쪽 상단
    state.btnPip  = mkBtn('gt-pip-btn',  '⧉', 'PIP');
    state.btnShot = mkBtn('gt-shot-btn', '📷', 'Screenshot');

    // 오른쪽 상단
    state.btnSeekMode = mkBtn('gt-seek-mode-btn', 'S', 'Seek Mode');
    state.btnSeekVal  = mkBtn('gt-seek-val-btn', '10', 'Seek Value');

    // 오른쪽 하단
    state.btnLock = mkBtn('gt-lock-btn', '🔓', 'Lock');
    state.btnMode = mkBtn('gt-mode-btn', '⚡', 'Mode');

    // 하단 (자막 회피 — 1/3, 2/3 배치)
    state.btnFit        = mkBtn('gt-fit-btn', '⊡', 'Fit');
    state.btnResetSpeed = mkBtn('gt-reset-speed-btn', '1×', 'Reset Speed');
    state.btnRot        = mkBtn('gt-rotate-btn', '↻', 'Rotate');
    state.btnResetZoom  = mkBtn('gt-reset-zoom-btn', '⊙', 'Reset Zoom');

    container.appendChild(layer);
    state.uiLayer = layer;

    // 이벤트 바인딩
    bindButtonEvents();
    updateUIState();
  }

  /* ────── 버튼 이벤트 ────── */
  function bindButtonEvents() {
    const s = state;

    // PIP
    s.btnPip.addEventListener('click', e => {
      e.stopPropagation();
      if (!s.video) return;
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      } else {
        s.video.requestPictureInPicture().catch(() => toast('PIP 지원 불가'));
      }
    });

    // 스크린샷
    s.btnShot.addEventListener('click', e => {
      e.stopPropagation();
      if (!s.video) return;
      try {
        const c = document.createElement('canvas');
        c.width = s.video.videoWidth;
        c.height = s.video.videoHeight;
        c.getContext('2d').drawImage(s.video, 0, 0);
        const a = document.createElement('a');
        a.href = c.toDataURL('image/png');
        a.download = `screenshot_${Date.now()}.png`;
        a.click();
        toast('📷 저장됨');
      } catch (err) {
        toast('스크린샷 실패 (CORS)');
      }
    });

    // 회전
    s.btnRot.addEventListener('click', e => {
      e.stopPropagation();
      if (!isFullscreen()) { toast('전체화면에서만 가능'); return; }
      state.rotationDeg = (state.rotationDeg + 90) % 360;
      if (state.rotationDeg === 0) {
        unlockOrientation();
        toast('회전 초기화');
      } else {
        const orient = (state.rotationDeg % 180 === 0)
          ? detectVideoOrientation(s.video)
          : (detectVideoOrientation(s.video) === 'landscape' ? 'portrait' : 'landscape');
        lockOrientation(orient === 'landscape' ? 'landscape' : 'portrait');
        toast(`↻ ${state.rotationDeg}°`);
      }
      applyTransform();
    });

    // 탐색 모드
    s.btnSeekMode.addEventListener('click', e => {
      e.stopPropagation();
      state.seekMode = state.seekMode === 'sec' ? 'frame' : 'sec';
      GM_setValue('gt_seekMode', state.seekMode);
      s.btnSeekMode.textContent = state.seekMode === 'sec' ? 'S' : 'F';
      updateSeekValDisplay();
      toast(state.seekMode === 'sec' ? '초 단위 탐색' : '프레임 단위 탐색');
    });

    // 탐색 값
    s.btnSeekVal.addEventListener('click', e => {
      e.stopPropagation();
      if (state.seekMode === 'sec') {
        const opts = [3, 5, 10, 15, 30, 60];
        const idx = (opts.indexOf(state.seekVal) + 1) % opts.length;
        state.seekVal = opts[idx];
        GM_setValue('gt_seekVal', state.seekVal);
        toast(`탐색: ${state.seekVal}초`);
      } else {
        const opts = [1, 5, 10, 30];
        const cur = state.fps;
        const idx = (opts.indexOf(cur) + 1) % opts.length;
        // FPS는 고정값 사용
        toast(`FPS: ${state.fps}`);
      }
      updateSeekValDisplay();
    });

    // 잠금
    s.btnLock.addEventListener('click', e => {
      e.stopPropagation();
      state.locked = !state.locked;
      s.btnLock.textContent = state.locked ? '🔒' : '🔓';
      s.lockShield.classList.toggle('gt-locked', state.locked);
      toast(state.locked ? '🔒 잠금' : '🔓 해제');
      if (state.locked) showUI(); // 잠금 시 UI 유지
    });

    // 잠금 실드 더블탭으로 해제
    s.lockShield.addEventListener('dblclick', e => {
      e.stopPropagation();
      state.locked = false;
      s.btnLock.textContent = '🔓';
      s.lockShield.classList.remove('gt-locked');
      toast('🔓 해제');
    });

    // 모드 전환
    s.btnMode.addEventListener('click', e => {
      e.stopPropagation();
      state.mode = state.mode === 'speed' ? 'zoom' : 'speed';
      GM_setValue('gt_mode', state.mode);
      s.btnMode.textContent = state.mode === 'speed' ? '⚡' : '🔍';
      toast(state.mode === 'speed' ? '속도 모드' : '줌 모드');
    });

    // 화면비율
    s.btnFit.addEventListener('click', e => {
      e.stopPropagation();
      if (!isFullscreen()) { toast('전체화면에서만 가능'); return; }
      if (!s.video) return;
      state.fitIndex = (state.fitIndex + 1) % state.fitModes.length;
      const mode = state.fitModes[state.fitIndex];
      s.video.style.objectFit = mode;
      toast(`화면비율: ${mode}`);
    });

    // 속도 리셋
    s.btnResetSpeed.addEventListener('click', e => {
      e.stopPropagation();
      if (!s.video) return;
      s.video.playbackRate = 1.0;
      state.speedChanged = false;
      updateUIState();
      toast('속도 1.0×');
    });

    // 줌 리셋
    s.btnResetZoom.addEventListener('click', e => {
      e.stopPropagation();
      state.scale = 1.0;
      state.panX = 0;
      state.panY = 0;
      state.zoomChanged = false;
      applyTransform();
      updateUIState();
      toast('줌 초기화');
    });
  }

  /* ────── UI 상태 갱신 ────── */
  function updateUIState() {
    const s = state;
    const fs = isFullscreen();

    // 전체화면 클래스
    if (s.uiLayer) {
      s.uiLayer.classList.toggle('gt-fs', fs);
    }

    // 항상 표시
    if (s.btnPip) s.btnPip.style.display = '';
    if (s.btnShot) s.btnShot.style.display = '';
    if (s.btnMode) s.btnMode.style.display = '';
    if (s.btnSeekMode) s.btnSeekMode.style.display = '';
    if (s.btnSeekVal) s.btnSeekVal.style.display = '';
    if (s.btnLock) s.btnLock.style.display = '';

    // 전체화면에서만 표시: 회전, 화면비율
    if (s.btnRot) s.btnRot.style.display = fs ? '' : 'none';
    if (s.btnFit) s.btnFit.style.display = fs ? '' : 'none';

    // 조건부: 속도 리셋
    if (s.btnResetSpeed) s.btnResetSpeed.style.display = s.speedChanged ? '' : 'none';

    // 조건부: 줌 리셋
    if (s.btnResetZoom) s.btnResetZoom.style.display = s.zoomChanged ? '' : 'none';

    // 모드 아이콘
    if (s.btnMode) s.btnMode.textContent = s.mode === 'speed' ? '⚡' : '🔍';

    // 탐색 모드/값
    if (s.btnSeekMode) s.btnSeekMode.textContent = s.seekMode === 'sec' ? 'S' : 'F';
    updateSeekValDisplay();

    // 잠금
    if (s.btnLock) s.btnLock.textContent = s.locked ? '🔒' : '🔓';
  }

  function updateSeekValDisplay() {
    if (!state.btnSeekVal) return;
    if (state.seekMode === 'sec') {
      state.btnSeekVal.textContent = state.seekVal + '';
    } else {
      state.btnSeekVal.textContent = state.fps + 'f';
    }
  }

  /* ────── 토스트 ────── */
  let toastTimer = null;
  function toast(msg) {
    if (!state.uiLayer) return;
    const t = state.uiLayer.querySelector('.gt-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('gt-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('gt-toast-show'), 1500);
  }

  /* ────── UI 표시/숨김 ────── */
  function showUI() {
    if (!state.uiLayer) return;
    state.uiLayer.classList.add('gt-show');
    clearTimeout(state.uiTimer);
    if (!state.locked) {
      state.uiTimer = setTimeout(hideUI, CFG.uiTimeout);
    }
  }
  function hideUI() {
    if (!state.uiLayer) return;
    if (state.locked) return;
    state.uiLayer.classList.remove('gt-show');
  }

  /* ────── 시크 표시 ────── */
  function showSeekDisplay(text) {
    if (!state.uiLayer) return;
    const d = state.uiLayer.querySelector('.gt-seek-display');
    if (!d) return;
    d.textContent = text;
    d.style.opacity = '1';
  }
  function hideSeekDisplay() {
    if (!state.uiLayer) return;
    const d = state.uiLayer.querySelector('.gt-seek-display');
    if (d) d.style.opacity = '0';
  }

  /* ────── 프로그레스바 갱신 ────── */
  function updateProgress() {
    if (!state.video || !state.progressBar) return;
    const v = state.video;
    if (v.duration && isFinite(v.duration)) {
      state.progressBar.style.width = (v.currentTime / v.duration * 100) + '%';
    }
  }

  /* ────── 변환 적용 ────── */
  function applyTransform() {
    if (!state.video) return;
    const s = state;
    const transforms = [];
    if (s.rotationDeg) transforms.push(`rotate(${s.rotationDeg}deg)`);
    if (s.scale !== 1.0) transforms.push(`scale(${s.scale})`);
    if (s.panX || s.panY) transforms.push(`translate(${s.panX}px, ${s.panY}px)`);
    s.video.style.transform = transforms.length ? transforms.join(' ') : '';
    s.video.style.transformOrigin = 'center center';
  }

  /* ────── 시간 포맷 ────── */
  function fmt(sec) {
    const s = Math.abs(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const sign = sec < 0 ? '-' : '';
    return h > 0
      ? `${sign}${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
      : `${sign}${m}:${String(ss).padStart(2,'0')}`;
  }

  /* ────── 핀치 거리 ────── */
  function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ────── 메인 셋업 ────── */
  function trySetup(video) {
    if (video._gtSetup) return;
    video._gtSetup = true;

    // 진행률 갱신
    video.addEventListener('timeupdate', updateProgress);

    // 터치 이벤트를 document에 한 번만 등록
    if (!document._gtTouchReady) {
      document._gtTouchReady = true;
      setupTouchHandlers();
    }
  }

  /* ────── 터치 핸들러 ────── */
  function setupTouchHandlers() {

    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });

    /* ── touchstart ── */
    function onTouchStart(e) {
      // 제외 영역
      if (isExcludedZone(e)) return;

      const t = e.touches[0];
      const video = identifyVideoAt(t.clientX, t.clientY);
      if (!video) return;

      // 비디오 & 컨테이너 설정
      state.video = video;
      state.targetP = getValidPlayerRoot(video);

      // UI 생성 (최초 1회)
      if (!state.uiLayer || !state.targetP.contains(state.uiLayer)) {
        createUI(state.targetP);
      }

      showUI();

      // 잠금 상태면 무시
      if (state.locked) return;

      // 핀치
      if (e.touches.length === 2) {
        e.preventDefault();
        state.isPinching = true;
        state.pinchDist0 = pinchDist(e.touches);
        if (state.mode === 'zoom') {
          state.scale0 = state.scale;
        }
        return;
      }

      if (e.touches.length !== 1) return;

      state.startX = t.clientX;
      state.startY = t.clientY;
      state.startTime = Date.now();
      state.isSeeking = false;
      state.isRating = false;
      state.longFired = false;

      // 롱프레스 타이머
      clearTimeout(state.longTimer);
      state.longTimer = setTimeout(() => {
        state.longFired = true;
        if (!state.video) return;
        state.origRate = state.video.playbackRate;
        state.video.playbackRate = CFG.rateBase;
        toast(`⏩ ${CFG.rateBase}×`);
      }, CFG.longPress);
    }

    /* ── touchmove ── */
    function onTouchMove(e) {
      if (state.locked) return;

      // 핀치
      if (state.isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = pinchDist(e.touches);
        const ratio = dist / state.pinchDist0;
        if (state.mode === 'zoom') {
          state.scale = Math.min(CFG.maxScale, Math.max(0.5, state.scale0 * ratio));
          state.zoomChanged = state.scale !== 1.0;
          applyTransform();
          updateUIState();
        } else {
          // 속도 모드: 핀치로 속도 조절
          let newRate = Math.round(state.origRate * ratio * 20) / 20;
          newRate = Math.min(16, Math.max(0.25, newRate));
          if (state.video) {
            state.video.playbackRate = newRate;
            state.speedChanged = newRate !== 1.0;
            updateUIState();
            toast(`${newRate.toFixed(2)}×`);
          }
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - state.startX;
      const dy = t.clientY - state.startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // 최소 거리
      if (absDx < CFG.minDist && absDy < CFG.minDist) return;

      clearTimeout(state.longTimer);
      if (state.longFired) return;

      // 가로 우세 → 시크
      if (absDx > absDy && absDx > CFG.minDist && !state.isRating) {
        e.preventDefault();
        state.isSeeking = true;
        if (!state.video) return;

        if (state.seekMode === 'sec') {
          const seekAmt = dx * CFG.senseX;
          const target = Math.max(0, Math.min(state.video.duration || 0, state.video.currentTime + seekAmt * 0.1));
          state.video.currentTime = target;
          const diff = target - state.video.currentTime;
          showSeekDisplay(`${fmt(target)} (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}s)`);
        } else {
          const frames = Math.round(dx * 0.1);
          if (frames !== 0) {
            state.video.currentTime += frames / state.fps;
            showSeekDisplay(`${frames > 0 ? '+' : ''}${frames}f`);
          }
        }
        updateProgress();
      }
      // 세로 우세 → 속도 조절 (속도 모드일 때)
      else if (absDy > absDx && absDy > CFG.minDist && !state.isSeeking) {
        if (state.mode !== 'speed') return;
        e.preventDefault();
        state.isRating = true;
        if (!state.video) return;
        let newRate = state.video.playbackRate - dy * CFG.senseRate;
        newRate = Math.min(16, Math.max(0.25, Math.round(newRate * 20) / 20));
        state.video.playbackRate = newRate;
        state.speedChanged = newRate !== 1.0;
        updateUIState();
        toast(`${newRate.toFixed(2)}×`);
      }
    }

    /* ── touchend ── */
    function onTouchEnd(e) {
      clearTimeout(state.longTimer);

      // 핀치 종료
      if (state.isPinching) {
        state.isPinching = false;
        return;
      }

      // 롱프레스 해제
      if (state.longFired) {
        state.longFired = false;
        if (state.video) {
          state.video.playbackRate = state.origRate;
          toast(`▶ ${state.origRate.toFixed(2)}×`);
        }
        return;
      }

      if (state.isSeeking) {
        state.isSeeking = false;
        hideSeekDisplay();
        return;
      }

      if (state.isRating) {
        state.isRating = false;
        return;
      }

      // 탭 처리 (짧은 터치)
      const dt = Date.now() - state.startTime;
      if (dt < 300 && state.video) {
        // 더블탭 감지
        const now = Date.now();
        if (state._lastTap && now - state._lastTap < 350) {
          // 더블탭
          state._lastTap = 0;
          clearTimeout(state._singleTapTimer);
          const rect = state.targetP ? state.targetP.getBoundingClientRect()
                                     : { left: 0, width: window.innerWidth };
          const relX = state.startX - rect.left;
          const third = rect.width / 3;

          if (relX < third) {
            // 왼쪽 더블탭: 되감기
            const amt = state.seekMode === 'sec' ? state.seekVal : (state.fps > 0 ? 30 / state.fps : 1);
            state.video.currentTime = Math.max(0, state.video.currentTime - amt);
            toast(`⏪ -${state.seekMode === 'sec' ? state.seekVal + 's' : '30f'}`);
          } else if (relX > third * 2) {
            // 오른쪽 더블탭: 빨리감기
            const amt = state.seekMode === 'sec' ? state.seekVal : (state.fps > 0 ? 30 / state.fps : 1);
            state.video.currentTime = Math.min(state.video.duration || 9999, state.video.currentTime + amt);
            toast(`⏩ +${state.seekMode === 'sec' ? state.seekVal + 's' : '30f'}`);
          } else {
            // 중앙 더블탭: 전체화면 토글
            toggleFullscreen();
          }
          updateProgress();
        } else {
          state._lastTap = now;
          state._singleTapTimer = setTimeout(() => {
            // 싱글 탭: 재생/일시정지
            if (state.video.paused) {
              state.video.play();
              toast('▶');
            } else {
              state.video.pause();
              toast('⏸');
            }
          }, 350);
        }
      }
    }
  }

  /* ────── 전체화면 토글 ────── */
  function toggleFullscreen() {
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const target = state.targetP || state.video;
      const fn = target.requestFullscreen || target.webkitRequestFullscreen;
      if (fn) fn.call(target);
    }
  }

  /* ────── 전체화면 변경 감지 ────── */
  function onFSChange() {
    const fs = isFullscreen();

    // 비전체화면 복귀 시 변환 초기화
    if (!fs) {
      state.rotationDeg = 0;
      state.fitIndex = 0;
      if (state.video) {
        state.video.style.objectFit = '';
        state.video.style.transform = '';
      }
      unlockOrientation();
    }

    // UI 레이어 이동
    if (fs && state.uiLayer) {
      const fsEl = getFullscreenEl();
      if (fsEl && !fsEl.contains(state.uiLayer)) {
        fsEl.appendChild(state.uiLayer);
      }
    } else if (!fs && state.targetP && state.uiLayer) {
      if (!state.targetP.contains(state.uiLayer)) {
        state.targetP.appendChild(state.uiLayer);
      }
    }

    updateUIState();
    showUI();
  }

  document.addEventListener('fullscreenchange', onFSChange);
  document.addEventListener('webkitfullscreenchange', onFSChange);

  /* ────── GM 메뉴 ────── */
  try {
    GM_registerMenuCommand('🔄 설정 초기화', () => {
      GM_setValue('gt_mode', 'speed');
      GM_setValue('gt_seekMode', 'sec');
      GM_setValue('gt_seekVal', 10);
      GM_setValue('gt_fps', 30);
      location.reload();
    });
  } catch (e) {}

})();
