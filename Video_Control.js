function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); };
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointermove', move, { passive: false, signal: ac.signal });
    on(el, 'pointerup', up, { signal: ac.signal });
    on(el, 'pointercancel', up, { signal: ac.signal });
    return () => { ac.abort(); };
  }

  function createUI(sm, registry, ApplyReq, Utils, P) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null; let hasUserDraggedUI = false;
    const uiWakeCtrl = new AbortController(); const uiUnsubs = [];
    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };

    let _allowCache = { v: false, t: 0, lastVideoCount: -1 };
    const ALLOW_TTL = 1200;

    const allowUiInThisDoc = () => {
      const now = performance.now();
      const vc = registry.videos.size;
      if (vc === _allowCache.lastVideoCount && (now - _allowCache.t) < ALLOW_TTL) return _allowCache.v;

      let ok = false;
      if (vc > 0) ok = true;
      else {
        try {
          ok = !!document.querySelector('video, object, embed, [class*=player], [id*=player], [data-player]');
          if (!ok && getFLAGS()?.UI_EXPENSIVE_SHADOW_PROBE) {
            let seen = 0;
            const walker = document.createTreeWalker(document.documentElement || document.body, NodeFilter.SHOW_ELEMENT);
            let node = walker.nextNode();
            while (node && seen++ < 400) {
              const sr = node.shadowRoot;
              if (sr && sr.querySelector?.('video')) { ok = true; break; }
              node = walker.nextNode();
            }
          }
        } catch (_) { ok = false; }
      }
      _allowCache = { v: ok, t: now, lastVideoCount: vc };
      return ok;
    };

    safe(() => {
      if (typeof CSS === 'undefined' || !CSS.registerProperty) return;
      for (const prop of [ { name: '--__vsc171-vv-top', syntax: '<length>', inherits: true, initialValue: '0px' }, { name: '--__vsc171-vv-h', syntax: '<length>', inherits: true, initialValue: '100vh' } ]) { try { CSS.registerProperty(prop); } catch (_) {} }
    });

    function setAndHint(path, value) { const prev = sm.get(path); const changed = !Object.is(prev, value); if (changed) sm.set(path, value); (changed ? ApplyReq.hard() : ApplyReq.soft()); }
    const getUiRoot = () => { const fs = document.fullscreenElement || null; if (fs) { if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body; return fs; } return document.body || document.documentElement; };

    function bindReactive(btn, paths, apply, sm, sub) {
      const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false;
      const sync = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); }); };
      pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); return sync;
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
      if (isBitmask || offValue != null) row.append(offBtn); return row;
    }

    const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));
    const clampPanelIntoViewport = () => {
      try {
        if (!container) return; const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI) { mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = ''; queueMicrotask(() => { const r = mainPanel.getBoundingClientRect(); if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) { mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; mainPanel.style.transform = 'translateY(-50%)'; } }); return; }
        const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
        const vv = window.visualViewport, vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0), vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
        const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0, offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
        if (!vw || !vh) return;
        const w = r.width || 300, panH = r.height || 400;
        const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8)), top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        requestAnimationFrame(() => { mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`; });
      } catch (_) {}
    };

    const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root) return; if (!vv) { root.style.setProperty('--__vsc171-vv-top', '0px'); root.style.setProperty('--__vsc171-vv-h', `${window.innerHeight}px`); return; } root.style.setProperty('--__vsc171-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--__vsc171-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
    syncVVVars(); try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); } } catch (_) {}
    const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport);
    on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(document, 'fullscreenchange', () => { setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });

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

      const autoSceneRow = h('div', { class: 'prow' }, [
        h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '자동씬'),
        ...['Soft', 'Normal', 'Strong'].map(p => {
          const b = h('button', { class: 'pbtn', style: 'flex:1' }, p);
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            const curEn = sm.get(P.APP_AUTO_SCENE);
            const curPre = sm.get(P.APP_AUTO_SCENE_PRESET);
            if (curEn && curPre === p) setAndHint(P.APP_AUTO_SCENE, false);
            else {
              if (!curEn) setAndHint(P.APP_AUTO_SCENE, true);
              setAndHint(P.APP_AUTO_SCENE_PRESET, p);
            }
          };
          bindReactive(b, [P.APP_AUTO_SCENE, P.APP_AUTO_SCENE_PRESET, P.APP_ACT], (el, en, pre, act) => {
            const isActive = !!en && pre === p;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        }),
        (() => {
          const offBtn = h('button', { class: 'pbtn', style: 'flex:0.8' }, 'OFF');
          offBtn.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            setAndHint(P.APP_AUTO_SCENE, false);
          };
          bindReactive(offBtn, [P.APP_AUTO_SCENE, P.APP_ACT], (el, en, act) => {
            const isActive = !en;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return offBtn;
        })()
      ]);

      const pipBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '📺 PIP');
      pipBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        const v = getNS()?.App?.getActiveVideo(); if(v) await togglePiPFor(v);
      };
      bindReactive(pipBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 1;' }, '🔍 줌');
      zoomBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        const zm = getNS()?.ZoomManager; const v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return;
        if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); }
        else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); }
      };
      bindReactive(zoomBtn, [P.APP_ZOOM_EN, P.APP_ACT], (el, v, act) => {
        el.classList.toggle('active', !!v);
        el.style.opacity = act ? '1' : (v ? '0.65' : '0.45');
        el.style.cursor = act ? 'pointer' : 'not-allowed';
        el.disabled = !act;
      }, sm, sub);

      const pwrBtn = h('button', { class: 'btn', style: 'flex: 1;', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); }, sm, sub);

      const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.5;' }, '🔊 Brickwall (EQ+Dyn)');
      boostBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        if (getNS()?.AudioWarmup) getNS().AudioWarmup();
        setAndHint(P.A_EN, !sm.get(P.A_EN));
      };
      bindReactive(boostBtn, [P.A_EN, P.APP_ACT], (el, aEn, act) => {
        el.classList.toggle('active', !!aEn);
        el.style.opacity = act ? '1' : (aEn ? '0.65' : '0.45');
        el.style.cursor = act ? 'pointer' : 'not-allowed';
        el.disabled = !act;
      }, sm, sub);

      const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 강조');
      dialogueBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE));
      };
      bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN, P.APP_ACT], (el, dOn, aEn, act) => {
        el.classList.toggle('active', !!dOn);
        const usable = !!aEn && !!act;
        el.style.opacity = usable ? '1' : (dOn ? '0.65' : '0.35');
        el.style.cursor = usable ? 'pointer' : 'not-allowed';
        el.disabled = !usable;
      }, sm, sub);

      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
      advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
      bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
        renderButtonRow({ label: '블랙', key: P.V_SHADOW_MASK, isBitmask: true, items: [ { text: '외암', value: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' }, { text: '중암', value: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' }, { text: '심암', value: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' } ] }),
        renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
        renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }), h('hr')
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

      const resetBtn = h('button', { class: 'btn' }, '↺ 리셋');
      resetBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard();
      };
      bindReactive(resetBtn, [P.APP_ACT], (el, act) => {
        el.style.opacity = act ? '1' : '0.45';
        el.style.cursor = act ? 'pointer' : 'not-allowed';
        el.disabled = !act;
      }, sm, sub);

      const bodyMain = h('div', { id: 'p-main' }, [
        autoSceneRow,
        h('div', { class: 'prow' }, [ pipBtn, zoomBtn, pwrBtn ]),
        h('div', { class: 'prow' }, [ boostBtn, dialogueBtn ]),
        h('div', { class: 'prow' }, [
          h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
          resetBtn
        ]),
        renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
        advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true);
          };
          bindReactive(b, [P.PB_RATE, P.PB_EN, P.APP_ACT], (el, rate, en, act) => {
            const isActive = !!en && Math.abs(Number(rate || 1) - s) < 0.01;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        })),

        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [
          { text: '◀ 30s', action: 'seek', val: -30 },
          { text: '◀ 10s', action: 'seek', val: -10 },
          { text: '⏸ 정지', action: 'pause' },
          { text: '▶ 재생', action: 'play' },
          { text: '10s ▶', action: 'seek', val: 10 },
          { text: '30s ▶', action: 'seek', val: 30 }
        ].map(cfg => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text);
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            const v = getNS()?.App?.getActiveVideo(); if (!v) return;
            if (cfg.action === 'play') { v.play().catch(() => {}); }
            else if (cfg.action === 'pause') { v.pause(); }
            else if (cfg.action === 'seek') {
              const isLive = !Number.isFinite(v.duration); let minT = 0, maxT = v.duration;
              if (isLive || v.duration === Infinity) { const sr = v.seekable; if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
              let target = v.currentTime + cfg.val; if (cfg.val > 0 && target >= maxT) target = maxT - 0.1;
              target = Math.max(minT, Math.min(maxT, target)); try { v.currentTime = target; } catch (_) {}

              let fallbackTimer = 0;
              const onSeeked = () => {
                v.removeEventListener('seeked', onSeeked);
                clearTimeout(fallbackTimer);
                if (Math.abs(v.currentTime - target) > 5.0) { try { v.currentTime = target; } catch (_) {} }
              };
              v.addEventListener('seeked', onSeeked, { once: true });
              fallbackTimer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); }, 3000);
            }
          };
          bindReactive(b, [P.APP_ACT], (el, act) => {
            el.style.opacity = act ? '1' : '0.45';
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]); shadow.append(mainPanel);
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
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.();
        const startY = e.clientY;
        const rect = gearBtn.getBoundingClientRect();
        try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(gearBtn, (ev) => {
          const currentY = ev.clientY;
          if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); }
          if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
        }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
      };
      on(gearBtn, 'pointerdown', handleGearDrag); 
      
      // ✅ [개선 3-1] UI 기어 터치/클릭 이벤트 단일화 (Pointer Event)
      let lastToggle = 0;
      const onGearActivate = (e) => { 
        if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; } 
        const now = performance.now(); 
        if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; } 
        lastToggle = now; 
        setAndHint(P.APP_UI, !sm.get(P.APP_UI)); 
      };
      on(gearBtn, 'pointerup', (e) => { 
        safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); 
        onGearActivate(e); 
      }, { passive: false });

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
    if (!st.rateState) {
      st.rateState = {
        orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0,
        _backoffLv: 0, _lastBackoffAt: 0
      };
    }
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }

  function restoreRateOne(el) { try { const st = getRateState(el); if (!st || st.orig == null) return; const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0; st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate; } catch (_) {} }

  function ensureMobileInlinePlaybackHints(video) { if (!video || !getNS()?.CONFIG?.IS_MOBILE) return; safe(() => { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); }); }

  function createZoomManager(Store, P) {
    const stateMap = new WeakMap();
    let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    let touchListenersAttached = false;
    const zoomAC = new AbortController();
    const zsig = combineSignals(zoomAC.signal, __globalSig);
    const zoomedVideos = new Set();

    const getSt = (v) => {
      let st = stateMap.get(v);
      if (!st) {
        st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '', origComputedPosition: '', _cachedPosition: null, _lastTransition: null };
        stateMap.set(v, st);
      }
      return st;
    };

    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active;
        if (st.scale <= 1) {
          if (st.zoomed) {
            v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = '';
            v.style.zIndex = st.origZIndex; v.style.position = st.origPosition;
            v.style.transition = ''; st.zoomed = false; st.origComputedPosition = '';
          }
          st.scale = 1; st.tx = 0; st.ty = 0;
          zoomedVideos.delete(v);
        } else {
          if (!st.zoomed) {
            st.origZIndex = v.style.zIndex; st.origPosition = v.style.position;
            if (!st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
            st.origComputedPosition = st._cachedPosition; st.zoomed = true;
            if (st.origComputedPosition === 'static') v.style.position = 'relative';
          }
          const wantTransition = panning ? 'none' : 'transform 0.1s ease-out';
          if (st._lastTransition !== wantTransition) { v.style.transition = wantTransition; st._lastTransition = wantTransition; }
          v.style.transformOrigin = '0 0';
          v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
          v.style.cursor = panning ? 'grabbing' : 'grab';
          v.style.zIndex = '2147483646';
          zoomedVideos.add(v);
        }
      });
    };

    function clampPan(v, st) {
      const rect = getRectCached(v, performance.now(), 300);
      if (!rect || rect.width <= 1 || rect.height <= 1) return;
      const scaledW = rect.width * st.scale, scaledH = rect.height * st.scale;
      const minVisibleFraction = 0.25;
      const minVisW = rect.width * minVisibleFraction, minVisH = rect.height * minVisibleFraction;
      const maxTx = rect.width - minVisW, minTx = -(scaledW - minVisW - rect.width);
      const maxTy = rect.height - minVisH, minTy = -(scaledH - minVisH - rect.height);
      st.tx = Math.max(Math.min(st.tx, maxTx), minTx);
      st.ty = Math.max(Math.min(st.ty, maxTy), minTy);
    }

    const zoomTo = (v, newScale, clientX, clientY) => {
      const st = getSt(v);
      if (!st.zoomed && !st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
      const rect = getRectCached(v, performance.now(), 150);
      if (!rect || rect.width <= 1 || rect.height <= 1) return;
      const ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale;
      st.tx = clientX - (rect.left - st.tx) - ix * newScale;
      st.ty = clientY - (rect.top - st.ty) - iy * newScale;
      st.scale = newScale;
      update(v);
    };

    const resetZoom = (v) => { if (v) { const st = getSt(v); st.scale = 1; st._cachedPosition = null; st._lastTransition = null; update(v); } };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let unsubAct = null;
    let unsubZoomEn = null;

    if (Store?.sub) {
      unsubAct = Store.sub(P.APP_ACT, (act) => {
        if (!act) {
          for (const v of zoomedVideos) {
            if (!v?.isConnected) { zoomedVideos.delete(v); continue; }
            resetZoom(v);
          }
          isPanning = false; pinchState.active = false; activeVideo = null;
        }
      });
      unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => {
        if (en) {
          if (CONFIG.IS_MOBILE) attachTouchListeners();
        } else {
          for (const v of zoomedVideos) {
            if (!v?.isConnected) { zoomedVideos.delete(v); continue; }
            resetZoom(v);
          }
          zoomedVideos.clear();
          isPanning = false; pinchState.active = false; activeVideo = null;
        }
      });
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
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v);
      let newScale = Math.min(Math.max(1, st.scale * delta), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'mousedown', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (st.scale > 1) {
        e.preventDefault(); e.stopPropagation();
        activeVideo = v; isPanning = true; st.hasPanned = false;
        startX = e.clientX - st.tx; startY = e.clientY - st.ty;
        update(v);
      }
    }, { capture: true, signal: zsig });

    on(window, 'mousemove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!isPanning || !activeVideo) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(activeVideo);
      const dx = e.clientX - startX - st.tx, dy = e.clientY - startY - st.ty;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
      st.tx = e.clientX - startX; st.ty = e.clientY - startY;
      clampPan(activeVideo, st); update(activeVideo);
    }, { capture: true, signal: zsig });

    on(window, 'mouseup', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) { isPanning = false; activeVideo = null; return; }
      if (isPanning) {
        if (activeVideo) {
          const st = getSt(activeVideo);
          if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
          update(activeVideo);
        }
        isPanning = false; activeVideo = null;
      }
    }, { capture: true, signal: zsig });

    on(window, 'dblclick', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true, signal: zsig });

    const touchstartHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
      } else if (e.touches.length === 1 && st.scale > 1) {
        activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
      }
    };

    const touchmoveHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
        let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; isPanning = false; activeVideo = null; }
        else {
          zoomTo(activeVideo, newScale, center.x, center.y);
          st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
          clampPan(activeVideo, st); update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      } else if (isPanning && e.touches.length === 1) {
        if (e.cancelable) e.preventDefault();
        const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
        st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY;
        clampPan(activeVideo, st); update(activeVideo);
      }
    };

    const touchendHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!activeVideo) return;
      if (e.touches.length < 2) pinchState.active = false;
      if (e.touches.length === 0) {
        if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) e.preventDefault();
        isPanning = false; update(activeVideo); activeVideo = null;
      }
    };

    const attachTouchListeners = () => {
      if (touchListenersAttached) return; touchListenersAttached = true;
      on(window, 'touchstart', touchstartHandler, { passive: false, capture: true, signal: zsig });
      on(window, 'touchmove', touchmoveHandler, { passive: false, capture: true, signal: zsig });
      on(window, 'touchend', touchendHandler, { passive: false, capture: true, signal: zsig });
    };

    if (CONFIG.IS_MOBILE) {
      if (Store?.get(P.APP_ZOOM_EN)) attachTouchListeners();
    } else {
      attachTouchListeners();
    }

    return {
      resetZoom, zoomTo, isZoomed, setEnabled: (en) => { if (en) attachTouchListeners(); },
      destroy: () => {
        try { unsubAct?.(); } catch(_) {}
        try { unsubZoomEn?.(); } catch(_) {}
        zoomAC.abort(); touchListenersAttached = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        for (const v of zoomedVideos) {
          if (!v?.isConnected) continue;
          const st = getSt(v);
          if (st && st.zoomed) { v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = ''; v.style.zIndex = st.origZIndex; v.style.position = st.origPosition; v.style.transition = ''; st.zoomed = false; }
        }
        zoomedVideos.clear();
        isPanning = false; pinchState.active = false; activeVideo = null;
      }
    };
  }

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
    const softResetTransientFlags = () => {
      st.audioFailUntil = 0; st.rect = null; st.rectT = 0; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; }
      if (st.rateState) {
        st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; st.rateState._firstAttemptT = 0;
        st.rateState._backoffLv = 0; st.rateState._lastBackoffAt = 0;
      }
      ApplyReq.hard();
    };
    const combinedSignal = combineSignals(st._ac.signal, __globalSig); const opts = { passive: true, signal: combinedSignal };
    const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return; const st = getVState(v); const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return; const store = getNS()?.Store; if (!store) return; const activeVideo = getNS()?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); } }]];
    for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
  };

  let __lastApplyTarget = null;
  function clearVideoRuntimeState(el, Adapter, ApplyReq) { const st = getVState(el); Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); if (st._ac) { st._ac.abort(); st._ac = null; } st.bound = false; bindVideoOnce(el, ApplyReq); }

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el);
    const now = performance.now();

    if (now < (rSt.suppressSyncUntil || 0)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate;

    const rateMatches = Math.abs(el.playbackRate - desiredRate) < 0.01;

    if (Object.is(st.desiredRate, desiredRate) && rateMatches) {
      if ((rSt._backoffLv | 0) > 0 && (now - (rSt._lastBackoffAt || 0)) > 1200) {
        rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
      touchedAdd(TOUCHED.rateVideos, el);
      return;
    }

    if (!rSt._firstAttemptT || (now - rSt._firstAttemptT) > 2500) {
      rSt._firstAttemptT = now;
      rSt._setAttempts = 0;
    }

    rSt._setAttempts++;

    if (rSt._setAttempts > 6) {
      const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
      rSt._backoffLv = lv;
      rSt._lastBackoffAt = now;
      const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
      rSt.suppressSyncUntil = now + backoffMs + ((Math.random() * 220) | 0);
      rSt._setAttempts = 0;
      return;
    }

    st.desiredRate = desiredRate;
    markInternalRateChange(el, 250);

    try { el.playbackRate = desiredRate; } catch (_) {}

    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
        markInternalRateChange(el, 250);
        try { el.playbackRate = desiredRate; } catch (_) {}
        requestAnimationFrame(() => {
          if (!el.isConnected) return;
          if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
            const n2 = performance.now();
            const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
            rSt._backoffLv = lv;
            rSt._lastBackoffAt = n2;
            const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
            const until = n2 + backoffMs + ((Math.random() * 220) | 0);
            rSt.suppressSyncUntil = Math.max(rSt.suppressSyncUntil || 0, until);
            rSt._setAttempts = 0;
          } else {
            if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
          }
        });
      } else {
        if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
    });
    touchedAdd(TOUCHED.rateVideos, el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, scratch }) {
    const candidates = scratch;
    candidates.clear();
    for (const set of [dirtyVideos, TOUCHED.videos, TOUCHED.rateVideos, applySet]) {
      for (const v of set) if (v?.tagName === 'VIDEO') candidates.add(v);
    }
    for (const el of candidates) {
      if (!el.isConnected) {
        Adapter.clear(el);
        restoreRateOne(el);
        TOUCHED.videos.delete(el);
        TOUCHED.rateVideos.delete(el);
        continue;
      }

      const st = getVState(el);
      const visible = (st.visible !== false);
      const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));

      if (!shouldApply) {
        if (!st.applied && !st.fxBackend && st.desiredRate === undefined) continue;
        clearVideoRuntimeState(el, Adapter, ApplyReq);
        continue;
      }

      if (videoFxOn) {
        Adapter.apply(el, vVals);
        touchedAdd(TOUCHED.videos, el);
      } else {
        Adapter.clear(el);
        TOUCHED.videos.delete(el);
      }

      if (pbActive) {
        applyPlaybackRate(el, desiredRate);
      } else {
        st.desiredRate = undefined;
        restoreRateOne(el);
        TOUCHED.rateVideos.delete(el);
      }
      bindVideoOnce(el, ApplyReq);
    }
  }

  function createVideoParamsMemo(Store, P) {
    const getDetailLevel = (presetKey) => { const k = String(presetKey || 'off').toUpperCase().trim(); if (k === 'XL') return 'xl'; if (k === 'L') return 'l'; if (k === 'M') return 'm'; if (k === 'S') return 's'; return 'off'; };
    const SHADOW_PARAMS = new Map([[SHADOW_BAND.DEEP, { toe: 1.2, gamma: -0.04, mid: -0.01 }], [SHADOW_BAND.MID, { toe: 0.7, gamma: -0.02, mid: -0.06 }], [SHADOW_BAND.OUTER, { toe: 0.3, gamma: -0.01, mid: -0.08 }]]);
    return {
      get(vfUser, activeVideo) {
        const detailP = PRESETS.detail[vfUser.presetS || 'off']; const gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'];
        const out = { sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0, satF: detailP.sat || 1.0, gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, temp: 0, gain: 1.0, mid: 0, toe: 0, shoulder: 0 };
        const sMask = vfUser.shadowBandMask || 0;
        if (sMask > 0) {
          let toeSum = 0, gammaSum = 0, midSum = 0; for (const [bit, params] of SHADOW_PARAMS) { if (sMask & bit) { toeSum += params.toe; gammaSum += params.gamma; midSum += params.mid; } }
          const bandCount = ((sMask & 1) + ((sMask >> 1) & 1) + ((sMask >> 2) & 1)); const combinedAttenuation = bandCount > 1 ? Math.pow(0.75, bandCount - 1) : 1.0;
          out.toe = VSC_CLAMP(toeSum * combinedAttenuation, 0, 3.0); out.gamma += gammaSum * combinedAttenuation; out.mid += midSum * combinedAttenuation;
        }
        out.mid = VSC_CLAMP(out.mid, -0.20, 0); const brStep = vfUser.brightStepLevel || 0;
        if (brStep > 0) { out.bright += brStep * 3.5; out.toe = Math.max(0, out.toe * (1.0 - brStep * 0.18)); out.gamma *= (1.0 + brStep * 0.025); }
        const { rs, gs, bs } = tempToRgbGain(out.temp); out._rs = rs; out._gs = gs; out._bs = bs; out.__detailLevel = getDetailLevel(vfUser.presetS); return out;
      }
    };
  }

  function isNeutralVideoParams(p) {
    const near = (a, b, eps = 1e-4) => Math.abs((a || 0) - b) <= eps;
    return (
      (p.sharp|0) === 0 && (p.sharp2|0) === 0 && (p.clarity|0) === 0 &&
      near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) &&
      near(p.satF, 1.0) && near(p.temp, 0.0) && near(p.gain, 1.0) &&
      near(p.mid, 0.0) && near(p.toe, 0.0) && near(p.shoulder, 0.0)
    );
  }

  function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
    UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });
    let __activeTarget = null, __lastAudioTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
    const videoParamsMemo = createVideoParamsMemo(Store, P);

    const _applySet = new Set();
    const _scratchCandidates = new Set();

    function updateQualityScale(v) {
      if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale; const now = performance.now(); if (now - lastQCheck < 2000) return qualityScale; lastQCheck = now;
      try {
        const q = v.getVideoPlaybackQuality(); const dropped = Number(q.droppedVideoFrames || 0), total = Number(q.totalVideoFrames || 0);
        const dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0)), dTotal = Math.max(0, total - (__lastQSample.total || 0)); __lastQSample = { dropped, total };
        if (dTotal < 30 || total < 300) return qualityScale;
        const ratio = dDropped / dTotal, target = ratio > 0.20 ? 0.65 : (ratio > 0.12 ? 0.85 : 1.0), alpha = target < qualityScale ? 0.15 : 0.12; qualityScale = qualityScale * (1 - alpha) + target * alpha;
      } catch (_) {} return qualityScale;
    }

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;

        if (!active) {
          for (const v of TOUCHED.videos) { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); }
          for (const v of TOUCHED.rateVideos) { getVState(v).desiredRate = undefined; restoreRateOne(v); }
          TOUCHED.videos.clear();
          TOUCHED.rateVideos.clear();
          Audio.update();
          __lastAudioTarget = null;
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
        if (dirtySize > 40 || (now - lastPrune > 2000)) { Registry.prune(); lastPrune = now; }

        const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
        if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; } Audio.update();

        const vf0 = Store.getCatRef('video'); let vValsEffective = videoParamsMemo.get(vf0, __activeTarget);
        const autoScene = getNS()?.AutoScene; const qs = updateQualityScale(__activeTarget);
        vValsEffective._qs = qs;

        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        let maxW = 0, maxH = 0;
        if (applyToAllVisibleVideos) {
          for (const v of visible.videos) {
            const stv = getVState(v); const r = stv.rect;
            if (r && r.width > 0 && r.height > 0) { maxW = Math.max(maxW, Math.round(r.width * dpr)); maxH = Math.max(maxH, Math.round(r.height * dpr)); }
          }
        } else if (__activeTarget) {
          const r = getRectCached(__activeTarget, performance.now(), 500);
          if (r && r.width > 0 && r.height > 0) { maxW = Math.round(r.width * dpr); maxH = Math.round(r.height * dpr); }
        }
        if (maxW > 0 && maxH > 0) { vValsEffective._frW = maxW; vValsEffective._frH = maxH; }
        else { delete vValsEffective._frW; delete vValsEffective._frH; }

        const autoSceneVVals = {};
        if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
          const mods = autoScene.getMods();
          if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
            Object.assign(autoSceneVVals, vValsEffective);
            const uBr = autoSceneVVals.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
            autoSceneVVals.gain = uBr * (1.0 + (mods.br - 1.0) * aSF);
            autoSceneVVals.contrast = (autoSceneVVals.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF);
            autoSceneVVals.satF = (autoSceneVVals.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
            const userSharpTotal = (autoSceneVVals.sharp || 0) + (autoSceneVVals.sharp2 || 0) + (autoSceneVVals.clarity || 0), sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5);
            const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF);
            autoSceneVVals.sharp = (autoSceneVVals.sharp || 0) * combinedSharpScale;
            autoSceneVVals.sharp2 = (autoSceneVVals.sharp2 || 0) * combinedSharpScale;
            autoSceneVVals.clarity = (autoSceneVVals.clarity || 0) * combinedSharpScale;
            vValsEffective = autoSceneVVals;
          }
        }

        const videoFxOn = !isNeutralVideoParams(vValsEffective);

        _applySet.clear();
        if (applyToAllVisibleVideos) { for (const v of visible.videos) _applySet.add(v); }
        else if (__activeTarget) _applySet.add(__activeTarget);

        const desiredRate = Store.get(P.PB_RATE);
        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates });

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
        if (domV) { __activeTarget = domV; Scheduler.request(true); }
        return domV;
      },
      getQualityScale() { return qualityScale; },
      destroy() {
        stopTick();
        safe(() => UI.destroy?.());
        safe(() => { Audio.setTarget(null); Audio.destroy?.(); });
        safe(() => getNS()?.AutoScene?.destroy?.());
        safe(() => getNS()?.ZoomManager?.destroy?.());
        safe(() => Registry.destroy?.());
        safe(() => __globalHooksAC.abort());
        safe(() => getNS()?._restorePatchedGlobals?.());
        safe(() => getNS()?._restoreHistory?.());
        safe(() => { (getNS()?._timers || []).forEach(clearTimeout); getNS()._timers = []; });
        safe(() => { try { __shadowRootCallbacks.clear(); } catch (_) {} });

        safe(() => {
          for (const v of TOUCHED.videos) { try { Adapter.clear(v); } catch(_){} }
          for (const v of TOUCHED.rateVideos) { try { restoreRateOne(v); } catch(_){} }
          TOUCHED.videos.clear();
          TOUCHED.rateVideos.clear();
        });
      }
    });
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(32);
  const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  // ✅ [개선 3-2] GM_registerMenuCommand 지원 (기본 유지보수 단축메뉴)
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔄 설정 초기화 (Reset All)', () => {
      if(confirm('모든 VSC 설정을 초기화하시겠습니까? (현재 도메인)')) {
        const key = 'vsc_prefs_' + location.hostname;
        if(typeof GM_deleteValue === 'function') GM_deleteValue(key);
        localStorage.removeItem(key);
        location.reload();
      }
    });
    GM_registerMenuCommand('⚡ Power 토글', () => { Store.set(P.APP_ACT, !Store.get(P.APP_ACT)); ApplyReq.hard(); });
    GM_registerMenuCommand('🎬 AutoScene 토글', () => { Store.set(P.APP_AUTO_SCENE, !Store.get(P.APP_AUTO_SCENE)); ApplyReq.hard(); });
    GM_registerMenuCommand('🔊 Audio 토글', () => { Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); });
    GM_registerMenuCommand('⚙️ UI 열기/닫기', () => { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); });
    GM_registerMenuCommand('🛠️ 디버그 모드 토글', () => {
      const url = new URL(location.href);
      if(url.searchParams.has('vsc_debug')) url.searchParams.delete('vsc_debug');
      else url.searchParams.set('vsc_debug', '1');
      location.href = url.toString();
    });
  }

  function bindNormalizer(keys, schema) { const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); }; keys.forEach(k => Store.sub(k, run)); run(); }
  bindNormalizer(ALL_KEYS, ALL_SCHEMA);

  const Registry = createRegistry(Scheduler);
  const Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();

    __vscNs._timers = __vscNs._timers || [];
    // ✅ [개선 2-2] Rescan 지연 타이머 단축 및 비디오 발견 시 불필요한 스캔 생략 최적화
    const lateRescanDelays = [3000, 10000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => { 
        safe(() => { 
          if (delay > 3000 && Registry.videos.size > 0) return;
          Registry.rescanAll(); Scheduler.request(true); safe(() => getNS()?.UIEnsure?.()); 
        }); 
      }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    const AutoScene = createAutoSceneManager(Store, P, Scheduler); __vscNs.AutoScene = AutoScene;

    __vscNs.CONFIG = CONFIG;
    __vscNs.FLAGS = Object.freeze({ ...FLAGS });

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter;

    const Audio = createAudio(Store); __vscNs.AudioWarmup = Audio.warmup;
    let ZoomManager = createZoomManager(Store, P); __vscNs.ZoomManager = ZoomManager;

    const UI = createUI(Store, Registry, ApplyReq, Utils, P);

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

    AutoScene.start();

    on(window, 'keydown', async (e) => {
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

} // VSC_MAIN 함수의 닫는 중괄호
VSC_MAIN();
})();
