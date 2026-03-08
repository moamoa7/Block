// --- PART 3 START ---

  function createBackendAdapter(Filters) {
    return {
      apply(video, vVals, shadowParams) {
        const svgResult = Filters.prepareCached(video, vVals, shadowParams);
        Filters.applyUrl(video, svgResult);
      },
      clear(video) {
        const st = getVState(video);
        if (st.applied) Filters.clear(video);
      }
    };
  }

  function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); };
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointermove', move, { passive: false, signal: ac.signal });
    on(el, 'pointerup', up, { signal: ac.signal });
    on(el, 'pointercancel', up, { signal: ac.signal });
    return () => { ac.abort(); };
  }

  // ===== UI: 메인에 선명+밝기, 고급에 암부+색온도+시계 =====
  function createUI(sm, registry, ApplyReq, Utils, P) {
    const { h } = Utils;
    let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null;
    let hasUserDraggedUI = false;
    const uiWakeCtrl = new AbortController();
    const uiUnsubs = [];

    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const detachNodesHard = () => {
      try { if (container?.isConnected) container.remove(); } catch (_) {}
      try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {}
    };

    let _allowCache = { v: false, t: 0, lastVideoCount: -1 };
    const ALLOW_TTL_NO_VIDEO = 3000;
    const ALLOW_TTL_HAS_VIDEO = 800;

    const allowUiInThisDoc = () => {
      const now = performance.now();
      const vc = registry.videos.size;
      const ttl = vc > 0 ? ALLOW_TTL_HAS_VIDEO : ALLOW_TTL_NO_VIDEO;
      if (vc === _allowCache.lastVideoCount && (now - _allowCache.t) < ttl) return _allowCache.v;

      let ok = false;
      if (vc > 0) ok = true;
      else {
        try {
          ok = !!document.querySelector('video');
          if (!ok) ok = !!document.querySelector('[class*=player],[id*=player],[data-player]');
        } catch (_) { ok = false; }
      }
      _allowCache = { v: ok, t: now, lastVideoCount: vc };
      return ok;
    };

    safe(() => {
      if (typeof CSS === 'undefined' || !CSS.registerProperty) return;
      for (const prop of [
        { name: '--__vsc171-vv-top', syntax: '<length>', inherits: true, initialValue: '0px' },
        { name: '--__vsc171-vv-h', syntax: '<length>', inherits: true, initialValue: '100vh' }
      ]) { try { CSS.registerProperty(prop); } catch (_) {} }
    });

    function setAndHint(path, value) {
      const prev = sm.get(path);
      const changed = !Object.is(prev, value);
      if (changed) sm.set(path, value);
      (changed ? ApplyReq.hard() : ApplyReq.soft());
    }

    const getUiRoot = () => {
      const fs = document.fullscreenElement || null;
      if (fs) {
        if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body;
        return fs;
      }
      return document.body || document.documentElement;
    };

    function bindReactive(btn, paths, apply, sm, sub) {
      const pathArr = Array.isArray(paths) ? paths : [paths];
      let pending = false;
      const sync = () => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => { pending = false; if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); });
      };
      pathArr.forEach(p => sub(p, sync));
      if (btn) apply(btn, ...pathArr.map(p => sm.get(p)));
      return sync;
    }

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false, isBitmask = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      for (const it of items) {
        const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text);
        b.onclick = (e) => {
          e.stopPropagation();
          if (!sm.get(P.APP_ACT)) return;
          if (isBitmask) {
            sm.set(key, ((Number(sm.get(key)) | 0) ^ it.value) & 7);
          } else {
            const cur = sm.get(key);
            if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
            else setAndHint(key, it.value);
          }
          ApplyReq.hard();
        };
        bindReactive(b, [key, P.APP_ACT], (el, v, act) => {
          const isActive = isBitmask ? (((Number(v) | 0) & it.value) !== 0) : v === it.value;
          el.classList.toggle('active', isActive);
          el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
          el.style.cursor = act ? 'pointer' : 'not-allowed';
          el.disabled = !act;
        }, sm, sub);
        row.append(b);
      }
      if (offValue != null || isBitmask) {
        const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
        offBtn.onclick = (e) => {
          e.stopPropagation();
          if (!sm.get(P.APP_ACT)) return;
          sm.set(key, isBitmask ? 0 : offValue);
          ApplyReq.hard();
        };
        bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => {
          const isActuallyOff = isBitmask ? (Number(v)|0) === 0 : v === offValue;
          el.classList.toggle('active', isActuallyOff);
          el.style.opacity = act ? '1' : (isActuallyOff ? '0.65' : '0.45');
          el.style.cursor = act ? 'pointer' : 'not-allowed';
          el.disabled = !act;
        }, sm, sub);
        row.append(offBtn);
      }
      return row;
    }

    const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));

    const clampPanelIntoViewport = () => {
      try {
        if (!container) return;
        const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main');
        if (!mainPanel || mainPanel.style.display === 'none') return;

        if (!hasUserDraggedUI) {
          mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = '';
          queueMicrotask(() => {
            const r = mainPanel.getBoundingClientRect();
            if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) {
              mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; mainPanel.style.transform = 'translateY(-50%)';
            }
          });
          return;
        }

        const r = mainPanel.getBoundingClientRect();
        if (!r.width && !r.height) return;

        const vv = window.visualViewport, vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0), vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
        const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0, offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;

        if (!vw || !vh) return;
        const w = r.width || 300, panH = r.height || 400;
        const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8)), top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));

        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
      } catch (_) {}
    };

    const syncVVVars = () => {
      try {
        const root = document.documentElement, vv = window.visualViewport;
        if (!root) return;
        if (!vv) { root.style.setProperty('--__vsc171-vv-top', '0px'); root.style.setProperty('--__vsc171-vv-h', `${window.innerHeight}px`); return; }
        root.style.setProperty('--__vsc171-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--__vsc171-vv-h', `${Math.round(vv.height)}px`);
      } catch (_) {}
    };

    syncVVVars();

    let _clampRafId = 0;
    const onLayoutChange = () => {
      if (_clampRafId) return;
      _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); });
    };

    try {
      const vv = window.visualViewport;
      if (vv) {
        on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
        on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
      }
    } catch (_) {}

    on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    on(document, 'fullscreenchange', () => { setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });

    const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

    const __vscSheetCache = new Map();
    function attachShadowStyles(shadowRoot, cssText) {
      try {
        if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') {
          let sheet = __vscSheetCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __vscSheetCache.set(cssText, sheet);
          }
          shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
          return;
        }
      } catch (_) {}
      const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl);
    }

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${getNS()?.CONFIG?.VSC_ID || 'core'}`, 'data-vsc-ui': '1', 'data-vsc-id': getNS()?.CONFIG?.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' });
      const style = `
        @property --__vsc171-vv-top { syntax: "<length>"; inherits: true; initial-value: 0px; }
        @property --__vsc171-vv-h { syntax: "<length>"; inherits: true; initial-value: 100vh; }
        :host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--__vsc171-vv-top,0px) + (var(--__vsc171-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:50%!important;right:70px!important;left:auto!important;transform:translateY(-50%)!important;width:260px!important;max-height:70vh!important;padding:10px;border-radius:12px;overflow-y:auto}.main::-webkit-scrollbar{width:3px}.main::-webkit-scrollbar-thumb{background:#666;border-radius:10px}.prow{gap:3px;flex-wrap:nowrap;justify-content:center}.btn,.pbtn{min-height:34px;font-size:10.5px;padding:4px 1px;letter-spacing:-0.8px;white-space:nowrap}.header{font-size:12px;padding-bottom:5px}} .header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}
      `;
      attachShadowStyles(shadow, style);

      const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

      // ===== 메인: 선명 =====
      const sharpRow = renderButtonRow({
        label: '선명', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true,
        items: [ { text: 'Soft', value: 'Soft', title: '약한 선명화' }, { text: 'Medium', value: 'Medium', title: '중간 선명화' }, { text: 'Ultra', value: 'Ultra', title: '강한 선명화' } ]
      });

      // ===== 메인: 통합 밝기 (0~5) =====
      const brightRow = renderButtonRow({
        label: '밝기', key: P.V_BRIGHT_LV, offValue: 0, toggleActiveToOff: true,
        items: [
          { text: '1', value: 1, title: '약간 밝게' },
          { text: '2', value: 2, title: '밝게' },
          { text: '3', value: 3, title: '많이 밝게' },
          { text: '4', value: 4, title: '강하게 밝게' },
          { text: '5', value: 5, title: '최대 밝기' }
        ]
      });

      const pipBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '📺 PIP');
      pipBtn.onclick = async (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; const v = getNS()?.App?.getActiveVideo(); if(v) await togglePiPFor(v); };
      bindReactive(pipBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 1;' }, '🔍 줌');
      zoomBtn.onclick = (e) => {
        e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
        const zm = getNS()?.ZoomManager; const v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return;
        if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); }
        else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); }
      };
      bindReactive(zoomBtn, [P.APP_ZOOM_EN, P.APP_ACT], (el, v, act) => { el.classList.toggle('active', !!v); el.style.opacity = act ? '1' : (v ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const pwrBtn = h('button', { class: 'btn', style: 'flex: 1;', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); }, sm, sub);

      const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.0; font-weight: 800;' }, '🔊 Audio (Dyn+RMS+Wide)');
      boostBtn.onclick = (e) => {
        e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
        if (getNS()?.AudioWarmup) getNS().AudioWarmup();
        const isCurrentlyOn = sm.get(P.A_EN); const nextState = !isCurrentlyOn;
        sm.batch('audio', { enabled: nextState, stereoWidth: nextState, multiband: true, lufs: true });
        ApplyReq.hard();
      };
      bindReactive(boostBtn, [P.A_EN, P.APP_ACT], (el, aEn, act) => { el.classList.toggle('active', !!aEn); el.style.color = aEn ? 'var(--ac)' : '#eee'; el.style.opacity = act ? '1' : '0.45'; el.disabled = !act; }, sm, sub);

      const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 강조');
      dialogueBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE)); };
      bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN, P.APP_ACT], (el, dOn, aEn, act) => { el.classList.toggle('active', !!dOn); const usable = !!aEn && !!act; el.style.opacity = usable ? '1' : (dOn ? '0.65' : '0.35'); el.style.cursor = usable ? 'pointer' : 'not-allowed'; el.disabled = !usable; }, sm, sub);

      // ===== 고급 설정 토글 =====
      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
      advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
      bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

      // ===== 고급 설정 내용: 암부, 색온도, 시계 =====
      // [요구사항 반영 완료] 직관적인 색온도 UI (+30, +15, -10, -25)
      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
        renderButtonRow({ label: '암부', key: P.V_SHADOW_MASK, offValue: 0, toggleActiveToOff: true, items: [ { text: '1단', value: DARK_BAND.LV1, title: '약한 암부 강화' }, { text: '2단', value: DARK_BAND.LV2, title: '중간 암부 강화' }, { text: '3단', value: DARK_BAND.LV3, title: '강한 암부 강화' } ] }),
        renderButtonRow({ label: '색온', key: P.V_TEMP, offValue: 0, toggleActiveToOff: true, items: [
          { text: '보호', value: 30,  title: '강한 노란끼 (확실한 눈 보호)' },
          { text: '따뜻', value: 15,  title: '부드러운 화면 (일상용)' },
          { text: '맑음', value: -10, title: '깨끗한 화이트 (영화 추천)' },
          { text: '냉색', value: -25, title: '쨍한 파란끼 (애니 추천)' }
        ] }),
        h('hr'),
        renderButtonRow({ label: '시계', key: P.APP_TIME_EN, offValue: false, toggleActiveToOff: true, items: [{ text: '표시 (전체화면)', value: true }] }),
        renderButtonRow({ label: '위치', key: P.APP_TIME_POS, items: [{ text: '좌', value: 0 }, { text: '중', value: 1 }, { text: '우', value: 2 }] }),
        h('hr')
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

      const resetBtn = h('button', { class: 'btn' }, '↺ 리셋');
      resetBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); ApplyReq.hard(); };
      bindReactive(resetBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      // ===== 메인 바디 조립 =====
      const bodyMain = h('div', { id: 'p-main' }, [
        sharpRow, brightRow,
        h('div', { class: 'prow' }, [ pipBtn, zoomBtn, pwrBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 4px;' }, [ boostBtn, dialogueBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 8px;' }, [ h('button', { class: 'btn', style: 'background:#333;', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'), resetBtn ]),
        advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
          b.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); };
          bindReactive(b, [P.PB_RATE, P.PB_EN, P.APP_ACT], (el, rate, en, act) => { const isActive = !!en && Math.abs(Number(rate || 1) - s) < 0.01; el.classList.toggle('active', isActive); el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);
          return b;
        })),
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [
          { text: '◀ 30s', action: 'seek', val: -30 }, { text: '◀ 15s', action: 'seek', val: -15 }, { text: '⏸ 정지', action: 'pause' }, { text: '▶ 재생', action: 'play' }, { text: '15s ▶', action: 'seek', val: 15 }, { text: '30s ▶', action: 'seek', val: 30 }
        ].map(cfg => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text);
          b.onclick = (e) => {
            e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
            const v = getNS()?.App?.getActiveVideo(); if (!v) return;
            if (cfg.action === 'play') { v.play().catch(() => {}); }
            else if (cfg.action === 'pause') { v.pause(); }
            else if (cfg.action === 'seek') {
              const isLive = !Number.isFinite(v.duration); let minT = 0, maxT = v.duration;
              if (isLive || v.duration === Infinity) { const sr = v.seekable; if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
              let target = v.currentTime + cfg.val; if (cfg.val > 0 && target >= maxT) target = maxT - 0.1;
              target = Math.max(minT, Math.min(maxT, target)); try { v.currentTime = target; } catch (_) {}
              let fallbackTimer = 0; const onSeeked = () => { v.removeEventListener('seeked', onSeeked); clearTimeout(fallbackTimer); if (Math.abs(v.currentTime - target) > 5.0) { try { v.currentTime = target; } catch (_) {} } };
              v.addEventListener('seeked', onSeeked, { once: true }); fallbackTimer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); }, 3000);
            }
          };
          bindReactive(b, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);
          return b;
        }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]);
      shadow.append(mainPanel);
      if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);

      let stopDrag = null;
      const startPanelDrag = (e) => {
        if (e.target && e.target.tagName === 'BUTTON') return;
        if (e.cancelable) e.preventDefault();
        stopDrag?.(); hasUserDraggedUI = true;
        let startX = e.clientX, startY = e.clientY;
        const rect = mainPanel.getBoundingClientRect();
        mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`;
        try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(dragHandle, (ev) => {
          const dx = ev.clientX - startX, dy = ev.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
          let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx));
          let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
          mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`;
        }, () => { stopDrag = null; });
      };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
      if (gearHost) { gearHost.style.display = 'block'; return; }
      gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${getNS()?.CONFIG?.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
      attachShadowStyles(shadow, style);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '⚙'); shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);

      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.();
        const startY = e.clientY; const rect = gearBtn.getBoundingClientRect();
        try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(gearBtn, (ev) => {
          const currentY = ev.clientY;
          if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); }
          if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
        }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
      };
      on(gearBtn, 'pointerdown', handleGearDrag);

      let lastToggle = 0;
      const onGearActivate = (e) => {
        if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
        const now = performance.now();
        if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
        lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI));
      };
      on(gearBtn, 'pointerup', (e) => { safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); onGearActivate(e); }, { passive: false });

      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; const gearTarget = document.fullscreenElement || document.body || document.documentElement; try { if (gearHost && gearHost.parentNode !== gearTarget) gearTarget.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== gearTarget) gearTarget.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); const mainPanel = getMainPanel(); if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible'); } mount(); safe(() => wakeGear?.()); };
    onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });
    if (getNS()) getNS().UIEnsure = ensure;
    return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
  }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) { st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0, _backoffLv: 0, _lastBackoffAt: 0 }; }
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) {
    const st = getRateState(v); const now = performance.now();
    st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
  }

  function restoreRateOne(el) {
    try {
      const st = getRateState(el);
      if (!st || st.orig == null) return;
      const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
      st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate;
    } catch (_) {}
  }

  function ensureMobileInlinePlaybackHints(video) {
    if (!video || !getNS()?.CONFIG?.IS_MOBILE) return;
    safe(() => {
      if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
      if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
    });
  }

  function createZoomManager(Store, P) {
    const stateMap = new WeakMap();
    let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    const zoomedVideos = new Set();
    let activePointerId = null;

    const zoomAC = new AbortController();
    const zsig = combineSignals(zoomAC.signal, __globalSig);

    const getSt = (v) => {
      let st = stateMap.get(v);
      if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origStyle: '' }; stateMap.set(v, st); }
      return st;
    };

    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active;
        if (st.scale <= 1) {
          if (st.zoomed) { v.style.cssText = st.origStyle; st.zoomed = false; }
          st.scale = 1; st.tx = 0; st.ty = 0; zoomedVideos.delete(v);
        } else {
          if (!st.zoomed) { st.origStyle = v.style.cssText; st.zoomed = true; }
          const trans = panning ? 'none' : 'transform 0.1s ease-out';
          v.style.cssText = st.origStyle + `; transition: ${trans} !important; transform-origin: 0 0 !important; transform: translate(${st.tx}px, ${st.ty}px) scale(${st.scale}) !important; cursor: ${panning ? 'grabbing' : 'grab'} !important; z-index: 2147483646 !important; position: relative !important;`;
          zoomedVideos.add(v);
        }
      });
    };

    function clampPan(v, st) {
      const r = v.getBoundingClientRect();
      if (!r || r.width <= 1 || r.height <= 1) return;
      const sw = r.width * st.scale, sh = r.height * st.scale;
      st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75);
      st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75);
    }

    const zoomTo = (v, newScale, cx, cy) => {
      const st = getSt(v);
      const r = v.getBoundingClientRect();
      if (!r || r.width <= 1) return;
      const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale;
      st.tx = cx - (r.left - st.tx) - ix * newScale;
      st.ty = cy - (r.top - st.ty) - iy * newScale;
      st.scale = newScale; update(v);
    };

    const resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let unsubAct = null, unsubZoomEn = null;
    if (Store?.sub) {
      unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } });
      unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { for (const v of [...zoomedVideos]) resetZoom(v); zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } });
    }

    function getTargetVideo(e) {
      if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
      const touch = e.touches?.[0];
      const cx = Number.isFinite(e.clientX) ? e.clientX : (touch && Number.isFinite(touch.clientX) ? touch.clientX : null);
      const cy = Number.isFinite(e.clientY) ? e.clientY : (touch && Number.isFinite(touch.clientY) ? touch.clientY : null);
      if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; }
      return __vscNs.App?.getActiveVideo() || null;
    }

    on(window, 'wheel', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v);
      let newScale = Math.min(Math.max(1, st.scale * delta), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'pointerdown', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v); if (st.scale <= 1) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false;
      startX = e.clientX - st.tx; startY = e.clientY - st.ty;
      try { v.setPointerCapture?.(e.pointerId); } catch (_) {}
      update(v);
    }, { capture: true, passive: false, signal: zsig });

    on(window, 'pointermove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const st = getSt(activeVideo);
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const nextTx = e.clientX - startX, nextTy = e.clientY - startY;
      if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
      st.tx = nextTx; st.ty = nextTy;
      clampPan(activeVideo, st); update(activeVideo);
    }, { capture: true, passive: false, signal: zsig });

    function endPointerPan(e) {
      if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const v = activeVideo; const st = getSt(v);
      try { v.releasePointerCapture?.(e.pointerId); } catch (_) {}
      if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activePointerId = null; isPanning = false; activeVideo = null; update(v);
    }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });

    on(window, 'dblclick', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true, signal: zsig });

    on(window, 'touchstart', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
      }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchmove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
        let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; }
        else {
          zoomTo(activeVideo, newScale, center.x, center.y);
          st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
          clampPan(activeVideo, st); update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchend', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return;
      if (e.touches.length < 2) pinchState.active = false;
      if (e.touches.length === 0) { update(activeVideo); activeVideo = null; }
    }, { passive: false, capture: true, signal: zsig });

    return {
      resetZoom, zoomTo, isZoomed, setEnabled: () => {},
      pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } },
      destroy: () => {
        try { unsubAct?.(); } catch(_) {} try { unsubZoomEn?.(); } catch(_) {}
        zoomAC.abort();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; }
        zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null;
      }
    };
  }

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
    const softResetTransientFlags = () => {
      st.audioFailUntil = 0; st.rect = null; st.rectT = 0; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; }
      if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; st.rateState._firstAttemptT = 0; st.rateState._backoffLv = 0; st.rateState._lastBackoffAt = 0; }
      ApplyReq.hard();
    };
    const combinedSignal = combineSignals(st._ac.signal, __globalSig); const opts = { passive: true, signal: combinedSignal };
    const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return; const st = getVState(v); const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return; const store = getNS()?.Store; if (!store) return; const activeVideo = getNS()?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); } }]];
    for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
  };

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el); const now = performance.now();
    if (now < (rSt.suppressSyncUntil || 0)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate;

    const rateMatches = Math.abs(el.playbackRate - desiredRate) < 0.01;
    if (Object.is(st.desiredRate, desiredRate) && rateMatches) {
      if ((rSt._backoffLv | 0) > 0 && (now - (rSt._lastBackoffAt || 0)) > 1200) { rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1); }
      touchedAdd(TOUCHED.rateVideos, el);
      return;
    }

    if (!rSt._firstAttemptT || (now - rSt._firstAttemptT) > 2500) { rSt._firstAttemptT = now; rSt._setAttempts = 0; }
    rSt._setAttempts++;

    if (rSt._setAttempts > 6) {
      const lv = Math.min(((rSt._backoffLv | 0) + 1), 5); rSt._backoffLv = lv; rSt._lastBackoffAt = now;
      const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
      rSt.suppressSyncUntil = now + backoffMs + ((Math.random() * 220) | 0); rSt._setAttempts = 0;
      return;
    }

    st.desiredRate = desiredRate; markInternalRateChange(el, 250);
    try { el.playbackRate = desiredRate; } catch (_) {}

    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
        markInternalRateChange(el, 250);
        try { el.playbackRate = desiredRate; } catch (_) {}
        requestAnimationFrame(() => {
          if (!el.isConnected) return;
          if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
            const n2 = performance.now(); const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
            rSt._backoffLv = lv; rSt._lastBackoffAt = n2;
            const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
            const until = n2 + backoffMs + ((Math.random() * 220) | 0);
            rSt.suppressSyncUntil = Math.max(rSt.suppressSyncUntil || 0, until); rSt._setAttempts = 0;
          } else { if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1); }
        });
      } else { if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1); }
    });
    touchedAdd(TOUCHED.rateVideos, el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, isNeutralParams, isNeutralShadow, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget }) {
    const candidates = scratch; candidates.clear();
    const addV = (v) => { if (v) candidates.add(v); };
    dirtyVideos.forEach(addV); applySet.forEach(addV); TOUCHED.videos.forEach(addV); TOUCHED.rateVideos.forEach(addV);

    const isApplyAll = !!getNS()?.Store?.get('app.applyAll');

    for (const el of candidates) {
      if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
      bindVideoOnce(el, ApplyReq);

      const st = getVState(el);
      const shouldApply = applySet.has(el) && (isApplyAll || st.visible !== false || el === activeTarget || isPiPActiveVideo(el));

      if (!shouldApply) {
        if (!st.applied && st.desiredRate === undefined) continue;
        Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el);
        continue;
      }

      const params = getParamsForVideo(el);
      const vVals = params.video; const shadowVals = params.shadow;
      const videoFxOn = !isNeutralParams(vVals) || !isNeutralShadow(shadowVals);

      if (videoFxOn) { Adapter.apply(el, vVals, shadowVals); touchedAdd(TOUCHED.videos, el); }
      else { Adapter.clear(el); TOUCHED.videos.delete(el); }

      if (pbActive) { applyPlaybackRate(el, desiredRate); }
      else {
        if (st.desiredRate !== undefined) { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
      }
    }
  }

  // ===== videoParamsMemo: 통합 밝기 + 동적 색온도 + [모바일/HiDPI DPR 보정] =====
  function createVideoParamsMemo() {
    function computePreScaling(video) {
      if (!video) return { sharpScale: 1.0, sigmaScale: 1.0, refW: 1920 };
      const nativeW = video.videoWidth || 0, nativeH = video.videoHeight || 0;
      const displayW = video.clientWidth || video.offsetWidth || 0, displayH = video.clientHeight || video.offsetHeight || 0;
      if (nativeW < 16 || displayW < 16) return { sharpScale: 1.0, sigmaScale: 1.0, refW: 1920 };

      const scaleRatioW = displayW / nativeW, scaleRatioH = displayH / Math.max(1, nativeH);
      const scaleRatio = Math.max(scaleRatioW, scaleRatioH);

      let sharpScale;
      if (scaleRatio >= 1.0) { const t = VSC_CLAMP((scaleRatio - 1.0) / 2.0, 0, 1); sharpScale = 1.0 + t * 0.4; }
      else { const t = VSC_CLAMP((1.0 - scaleRatio) / 0.5, 0, 1); sharpScale = 1.0 - t * 0.4; }

      // ===== 모바일 DPR 보정 시작 =====
      const isMobile = CONFIG.IS_MOBILE;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      if (isMobile) {
        // 모바일: DPR이 높을수록 물리 해상도는 충분하므로 샤프닝 대폭 감소
        // 의도: DPR 2 → ×0.55, DPR 3 → ×0.36
        const mobileFactor = VSC_CLAMP(1.1 / dpr, 0.30, 0.70);
        sharpScale *= mobileFactor;
      } else if (dpr >= 1.5) {
        // PC HiDPI (레티나, 윈도우 배율 150% 이상): 약간만 줄임
        // 의도: DPR 2 → ×0.80, DPR 3 → ×0.65
        const hidpiFactor = VSC_CLAMP(1.6 / dpr, 0.65, 0.95);
        sharpScale *= hidpiFactor;
      }
      // ===== 모바일 DPR 보정 끝 =====

      const refW = Math.max(640, Math.min(3840, displayW)); const sigmaScale = Math.sqrt(refW / 1920);
      return { sharpScale, sigmaScale, refW };
    }

    const _preScaleCache = new WeakMap();

    function getPreScaling(video) {
      if (!video) return { sharpScale: 1.0, sigmaScale: 1.0, refW: 1920 };
      const cached = _preScaleCache.get(video);
      const nW = video.videoWidth || 0, nH = video.videoHeight || 0;
      const dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0;
      if (cached && cached._nW === nW && cached._nH === nH && cached._dW === dW && cached._dH === dH) return cached;

      const result = computePreScaling(video);
      result._nW = nW; result._nH = nH; result._dW = dW; result._dH = dH;
      _preScaleCache.set(video, result);
      return result;
    }

    const _cache = new Map();
    const MAX_MEMO = 16;

    return {
      get(vfUser, video) {
        const nW = video?.videoWidth || 0, nH = video?.videoHeight || 0;
        const dW = video?.clientWidth || video?.offsetWidth || 0, dH = video?.clientHeight || video?.offsetHeight || 0;
        const inputKey = [
          vfUser.presetS, vfUser.brightLevel, vfUser.shadowBandMask, vfUser.temp,
          nW, nH, dW, dH
        ].join('|');

        const cached = _cache.get(inputKey); if (cached) return cached;

        const detailP = PRESETS.detail[vfUser.presetS || 'off'];
        const brightP = PRESETS.bright[VSC_CLAMP(vfUser.brightLevel || 0, 0, 5)] || PRESETS.bright[0];
        const ps = getPreScaling(video);

        const userTemp = vfUser.temp || 0;
        const { rs, gs, bs } = tempToRgbGain(userTemp);

        const videoOut = {
          sharp:    Math.round((detailP.sharpAdd  || 0) * ps.sharpScale),
          sharp2:   Math.round((detailP.sharp2Add || 0) * ps.sharpScale),
          satF:     detailP.sat || 1.0,
          gamma:    brightP.gammaF || 1.0,
          bright:   brightP.brightAdd || 0,
          contrast: 1.0,
          temp:     userTemp,
          gain: 1.0, mid: 0, toe: 0, shoulder: 0,
          _sigmaScale: ps.sigmaScale, _refW: ps.refW,
          _rs: rs, _gs: gs, _bs: bs
        };

        const sLevel = VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0;
        let shadowOut = { level: 0, active: false };
        if (sLevel > 0) { shadowOut = { level: sLevel, active: true }; }

        const result = { video: videoOut, shadow: shadowOut };
        if (_cache.size >= MAX_MEMO) _cache.delete(_cache.keys().next().value);
        _cache.set(inputKey, result);
        return result;
      }
    };
  }

  // ===== isNeutral: temp=0이 중립 =====
  function isNeutralVideoParams(p) {
    const near = (a, b, eps = 1e-4) => Math.abs((a || 0) - b) <= eps;
    return (
      (p.sharp|0) === 0 && (p.sharp2|0) === 0 &&
      near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) && near(p.satF, 1.0) &&
      near(p.temp, 0) &&
      near(p._rs, 1.0) && near(p._gs, 1.0) && near(p._bs, 1.0) &&
      near(p.gain, 1.0) && near(p.mid, 0.0) && near(p.toe, 0.0) && near(p.shoulder, 0.0)
    );
  }

  function isNeutralShadowParams(sp) { return !sp || !sp.active; }

  let __vscUserSignalRev = 0;

  // ===== AppController: AutoScene 완전 제거, 직접 파라미터 전달 =====
  function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
    UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });

    let __activeTarget = null, __lastApplyTarget = null, __lastAudioTarget = null;
    let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;
    const videoParamsMemo = createVideoParamsMemo();

    const _applySet = new Set();
    const _scratchCandidates = new Set();

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;
        if (!active) {
          for (const v of TOUCHED.videos) { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); }
          for (const v of TOUCHED.rateVideos) { getVState(v).desiredRate = undefined; restoreRateOne(v); }
          TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
          Audio.update(); __lastAudioTarget = null;
          return;
        }

        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        let pick = Targeting.pickFastActiveOnly(visible.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) { pick = Targeting.pickFastActiveOnly(Registry.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow); }
        if (!pick?.target) {
          let domV = null;
          try {
            const list = Array.from(document.querySelectorAll('video'));
            domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null;
          } catch (_) {}
          pick = { target: domV };
        }

        let nextTarget = pick.target;
        if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; } if (nextTarget !== __activeTarget) __activeTarget = nextTarget;
        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now();
        const dirtySize = vidsDirty.size;
        if (dirtySize > 40 || (now - lastPrune > 2000)) {
          Registry.prune(); getNS()?.ZoomManager?.pruneDisconnected?.(); lastPrune = now;
        }

        const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
        if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; } Audio.update();

        const vf0 = Store.getCatRef('video');

        // AutoScene 제거됨 → 직접 파라미터 전달
        const getParamsForVideo = (el) => videoParamsMemo.get(vf0, el);

        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);
        _applySet.clear();

        if (applyToAllVisibleVideos) { for (const v of Registry.visible.videos) _applySet.add(v); }
        else if (__activeTarget) { _applySet.add(__activeTarget); }

        const desiredRate = Store.get(P.PB_RATE);
        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, getParamsForVideo, isNeutralParams: isNeutralVideoParams, isNeutralShadow: isNeutralShadowParams, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates, activeTarget: __activeTarget });

        UI.ensure();
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisibilityHandler = null;
    const startTick = () => {
      stopTick(); tickVisibilityHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) { Scheduler.request(false); } };
      document.addEventListener('visibilitychange', tickVisibilityHandler, { passive: true });
      tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000);
    };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; if (tickVisibilityHandler) { document.removeEventListener('visibilitychange', tickVisibilityHandler); tickVisibilityHandler = null; } };

    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();

    return Object.freeze({
      getActiveVideo() {
        if (__activeTarget && __activeTarget.isConnected) return __activeTarget;
        let domV = null;
        try {
          const list = Array.from(document.querySelectorAll('video'));
          domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null;
        } catch (_) {}
        if (domV && domV !== __activeTarget) { __activeTarget = domV; queueMicrotask(() => { if (__activeTarget === domV) Scheduler.request(false); }); }
        return domV || __activeTarget || null;
      },
      getQualityScale() { return 1.0; },
      destroy() {
        stopTick();
        safe(() => UI.destroy?.());
        safe(() => { Audio.setTarget(null); Audio.destroy?.(); });
        safe(() => getNS()?.ZoomManager?.destroy?.());
        safe(() => getNS()?.TimerManager?.destroy?.());
        safe(() => Registry.destroy?.());

        safe(() => {
          for (const v of TOUCHED.videos) { try { Adapter.clear(v); } catch(_){} }
          for (const v of TOUCHED.rateVideos) { try { restoreRateOne(v); } catch(_){} }
          TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
        });
      }
    });
  }

  function createTimerManager(Store, P) {
    let timerEl = null;
    let intervalId = null;

    function updateTimer() {
      const act = Store.get(P.APP_ACT);
      const timeEn = Store.get(P.APP_TIME_EN);
      const isFs = !!document.fullscreenElement;

      if (!act || !timeEn || !isFs) {
        if (timerEl) timerEl.style.display = 'none';
        return;
      }

      const activeVideo = getNS()?.App?.getActiveVideo();
      if (!activeVideo || !activeVideo.isConnected) {
        if (timerEl) timerEl.style.display = 'none';
        return;
      }

      const parent = activeVideo.parentNode;
      if (!parent) return;

      if (!timerEl || timerEl.parentNode !== parent) {
        if (timerEl) { try { timerEl.remove(); } catch(_) {} }
        timerEl = document.createElement('div');
        timerEl.className = 'vsc-fs-timer';
        const stroke = getNS()?.getSmoothStroke('#000000');
        timerEl.style.cssText = `
          position: absolute;
          z-index: 2147483647;
          color: #FFE600;
          font-family: 'LXGW WenKai Mono TC', ui-monospace, Consolas, monospace;
          font-weight: bold;
          pointer-events: none;
          user-select: none;
          font-variant-numeric: tabular-nums;
          letter-spacing: 1px;
          ${stroke}
          transition: opacity 0.2s;
          opacity: 0.5;
        `;
        parent.appendChild(timerEl);
      }

      timerEl.style.display = 'block';

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      if (timerEl.textContent !== timeStr) timerEl.textContent = timeStr;

      const vRect = activeVideo.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      const vWidth = vRect.width;

      let dynamicSize = 24;
      if (vWidth >= 2500) dynamicSize = 36;
      else if (vWidth >= 1900) dynamicSize = 30;
      else if (vWidth >= 1200) dynamicSize = 24;
      else dynamicSize = 18;
      timerEl.style.fontSize = `${dynamicSize}px`;

      const topOffset = vWidth > 1200 ? 16 : 8;
      const top = (vRect.top - pRect.top) + topOffset;
      timerEl.style.top = `${top > topOffset ? top : topOffset}px`;

      const pos = Store.get(P.APP_TIME_POS);
      const edgeMargin = vWidth > 1200 ? 20 : 10;

      if (pos === 0) {
        const left = (vRect.left - pRect.left) + edgeMargin;
        timerEl.style.left = `${left > edgeMargin ? left : edgeMargin}px`;
        timerEl.style.right = 'auto';
        timerEl.style.transform = 'none';
      } else if (pos === 1) {
        const left = (vRect.left - pRect.left) + (vRect.width / 2);
        timerEl.style.left = `${left}px`;
        timerEl.style.right = 'auto';
        timerEl.style.transform = 'translateX(-50%)';
      } else {
        const right = (pRect.right - vRect.right) + edgeMargin;
        timerEl.style.right = `${right > edgeMargin ? right : edgeMargin}px`;
        timerEl.style.left = 'auto';
        timerEl.style.transform = 'none';
      }
    }

    intervalId = setInterval(updateTimer, 1000);
    if (typeof __vscNs !== 'undefined' && __vscNs._intervals) __vscNs._intervals.push(intervalId);

    return { destroy: () => { if (intervalId) clearInterval(intervalId); if (timerEl) { try { timerEl.remove(); } catch (_) {} } } };
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(32);
  const Store = createLocalStore(DEFAULTS, Scheduler);

  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const isTop = (window.top === window);

  if (isTop && typeof GM_registerMenuCommand === 'function') {
    const reg = (title, fn) => { const id = GM_registerMenuCommand(title, fn); if (__vscNs._menuIds) __vscNs._menuIds.push(id); };
    reg('🔄 설정 초기화 (Reset All)', () => {
      if(confirm('모든 VSC 설정을 초기화하시겠습니까? (현재 도메인)')) {
        const key = 'vsc_prefs_' + location.hostname;
        if(typeof GM_deleteValue === 'function') GM_deleteValue(key);
        localStorage.removeItem(key); location.reload();
      }
    });
    reg('⚡ Power 토글', () => { Store.set(P.APP_ACT, !Store.get(P.APP_ACT)); ApplyReq.hard(); });
    reg('🔊 Audio 토글', () => { Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); });
    reg('⚙️ UI 열기/닫기', () => { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); });
    reg('🛠️ 디버그 모드 토글', () => {
      const url = new URL(location.href);
      if(url.searchParams.has('vsc_debug')) url.searchParams.delete('vsc_debug'); else url.searchParams.set('vsc_debug', '1');
      location.href = url.toString();
    });
  }

  function bindNormalizer(keys, schema) {
    const run = () => { let changed = normalizeBySchema(Store, schema); if (changed) ApplyReq.hard(); };
    keys.forEach(k => Store.sub(k, run)); run();
  }
  bindNormalizer(ALL_KEYS, ALL_SCHEMA);

  const Registry = createRegistry(Scheduler);
  const Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();
    __vscNs._timers = __vscNs._timers || [];
    const lateRescanDelays = [3000, 10000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => { safe(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); safe(() => getNS()?.UIEnsure?.()); }); }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    // AutoScene 완전 제거됨
    __vscNs.CONFIG = CONFIG; __vscNs.FLAGS = Object.freeze({ ...FLAGS });

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters); __vscNs.Adapter = Adapter;

    const Audio = createAudio(Store);
    __vscNs.AudioWarmup = Audio.warmup;
    __vscNs.AudioSetTarget = (v) => { try { Audio.setTarget(v || null); Audio.update(); } catch (_) {} };

    let ZoomManager = createZoomManager(Store, P); __vscNs.ZoomManager = ZoomManager;
    const UI = createUI(Store, Registry, ApplyReq, Utils, P);
    const TimerManager = createTimerManager(Store, P); __vscNs.TimerManager = TimerManager;

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT< 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false)); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
      on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
    }

    const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
    __vscNs.App = __VSC_APP__;

    if (getFLAGS().SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) {
      const can = typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      if (can) __vscNs._schedAlignRvfc = true;
    }
    Scheduler.setRvfcSource(() => __VSC_APP__.getActiveVideo() || null);

    ApplyReq.hard();

    on(window, 'keydown', async (e) => {
      const isEditableTarget = (el) => { if(!el) return false; const tag = el.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable; };
      if (isEditableTarget(e.target)) return;
      if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); safe(() => { const st = getNS()?.Store; if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); } }); return; }
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        if (!getNS()?.Store?.get(P.APP_ACT)) return;
        e.preventDefault(); e.stopPropagation();
        const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v);
      }
    }, { capture: true });

    on(document, 'visibilitychange', () => { safe(() => checkAndCleanupClosedPiP()); safe(() => { if (document.visibilityState === 'visible') getNS()?.ApplyReq?.hard(); }); }, OPT_P);
    window.addEventListener('beforeunload', () => { safe(() => __VSC_APP__?.destroy()); }, { once: true });
  });

}
VSC_MAIN();
})();
// --- PART 3 END ---
