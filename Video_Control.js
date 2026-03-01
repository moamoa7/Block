function probeWebGLCapability() {
      if (probeWebGLCapability._result !== undefined) return probeWebGLCapability._result;
      const result = { supported: false, tier: 'none', maxTextureSize: 0, failReason: '' };
      try {
        const c = document.createElement('canvas'); c.width = 2; c.height = 2;
        const opts = CONFIG.IS_MOBILE ? undefined : { failIfMajorPerformanceCaveat: true };
        let gl = c.getContext('webgl2', opts) || c.getContext('webgl', opts);
        let hadCaveat = false;
        if (!gl && !CONFIG.IS_MOBILE) {
          gl = c.getContext('webgl2') || c.getContext('webgl');
          hadCaveat = !!gl;
        }
        if (!gl) { result.failReason = 'no-webgl'; }
        else {
          result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          if (CONFIG.IS_MOBILE) {
            if (result.maxTextureSize < 4096) {
              result.failReason = 'low-end-mobile-gpu';
            } else {
              result.supported = true;
              result.tier = result.maxTextureSize >= 8192 ? 'high' : 'medium';
            }
          } else if (hadCaveat) {
            result.supported = true; result.tier = 'low'; result.failReason = 'performance-caveat';
          } else {
            result.supported = true;
            result.tier = (result.maxTextureSize >= 16384) ? 'high' : (result.maxTextureSize >= 8192) ? 'medium' : 'low';
          }
          try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
        }
      } catch (e) { result.failReason = e.message || 'probe-error'; }
      probeWebGLCapability._result = result; return result;
    }

    function resolveRenderMode(storeMode, video, st) {
      if (storeMode === 'svg') return 'svg';
      if (storeMode === 'webgl') return 'webgl';
      const probe = probeWebGLCapability();
      if (!probe.supported) return 'svg';
      if (st) {
        if (st.webglTainted) return 'svg';
        if (st.webglDisabledUntil && performance.now() < st.webglDisabledUntil) return 'svg';
      }
      if (probe.tier === 'low') {
        if (probe.failReason === 'performance-caveat' && probe.maxTextureSize >= 8192) return 'webgl';
        return 'svg';
      }
      return 'webgl';
    }

    function createBackendAdapter(Filters, FiltersGL) {
      let activeContextCount = 0;
      const fallbackTracker = new WeakMap();
      return {
        apply(video, storeMode, vVals) {
          const st = getVState(video); const now = performance.now();
          const effectiveRequestedMode = resolveRenderMode(storeMode, video, st);
          const tracker = fallbackTracker.get(video) || { attempts: 0, lastAttempt: 0 };

          const webglAllowed = (effectiveRequestedMode === 'webgl' && !st.webglTainted && !(st.webglDisabledUntil && now < st.webglDisabledUntil));
          const contextLimitReached = webglAllowed && activeContextCount >= SYS.MAX_CTX;
          const effectiveMode = (webglAllowed && !contextLimitReached) ? 'webgl' : 'svg';

          const prevBackend = st.fxBackend;
          if (effectiveMode === 'webgl') {
              const wasWebGL = (prevBackend === 'webgl');
              if (!wasWebGL) activeContextCount++;

              if (!FiltersGL.apply(video, vVals)) {
                if (!wasWebGL) activeContextCount = Math.max(0, activeContextCount - 1);
                FiltersGL.clear(video);
                tracker.attempts++; tracker.lastAttempt = now;
                if (tracker.attempts >= 3) {
                  const backoffMs = Math.min(30000, 5000 * Math.pow(1.5, tracker.attempts - 3));
                  st.webglDisabledUntil = now + backoffMs;
                }
                fallbackTracker.set(video, tracker);
                Filters.applyUrl(video, Filters.prepareCached(video, vVals));
                st.fxBackend = 'svg';
                return;
              }

              if (tracker.attempts > 0) {
                tracker.attempts = Math.max(0, tracker.attempts - 1);
                fallbackTracker.set(video, tracker);
              }

              if (prevBackend === 'svg') {
                const pipe = FiltersGL.__getPipeline ? FiltersGL.__getPipeline(video) : null;
                if (pipe && !pipe._outputReady) {
                  if (!st._svgDeferredClear) {
                    st._svgDeferredClear = true;
                    const pollClear = () => {
                      if (st.fxBackend !== 'webgl' || !pipe.active) {
                        st._svgDeferredClear = false;
                        return;
                      }
                      if (!pipe._outputReady) {
                        requestAnimationFrame(pollClear);
                        return;
                      }
                      Filters.clear(video);
                      Filters.invalidateCache(video);
                      st._svgDeferredClear = false;
                    };
                    requestAnimationFrame(pollClear);
                  }
                } else {
                  Filters.clear(video);
                  Filters.invalidateCache(video);
                  st._svgDeferredClear = false;
                }
              }
              st.fxBackend = 'webgl';
          } else {
              if (prevBackend === 'webgl') {
                FiltersGL.clear(video);
                activeContextCount = Math.max(0, activeContextCount - 1);
                Filters.invalidateCache(video);
              }
              st._svgDeferredClear = false;
              const svgResult = Filters.prepareCached(video, vVals);
              Filters.applyUrl(video, { url: svgResult.url, changed: (prevBackend === 'webgl') });
              st.fxBackend = 'svg';
          }
        },
        clear(video) {
          const st = getVState(video);
          if (st.fxBackend === 'webgl') { activeContextCount = Math.max(0, activeContextCount - 1); FiltersGL.clear(video); }
          else if (st.fxBackend === 'svg') { Filters.clear(video); }
          st.fxBackend = null;
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

    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null; let hasUserDraggedUI = false;
      const uiWakeCtrl = new AbortController();
      const uiUnsubs = [];
      const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
      const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
      const allowUiInThisDoc = () => { if (registry.videos.size > 0) return true; return !!document.querySelector('video, object, embed'); };

      try {
        CSS.registerProperty({ name: '--__vsc170-vv-top', syntax: '<length>', inherits: true, initialValue: '0px' });
        CSS.registerProperty({ name: '--__vsc170-vv-h', syntax: '<length>', inherits: true, initialValue: '100vh' });
      } catch (_) {}

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
          if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs;
          return fs;
        }
        return document.documentElement || document.body;
      }

      function bindReactive(btn, paths, apply, sm, sub) {
        const pathArr = Array.isArray(paths) ? paths : [paths];
        let pending = false;
        const sync = () => {
          if (pending) return;
          pending = true;
          queueMicrotask(() => {
            pending = false;
            if (btn) apply(btn, ...pathArr.map(p => sm.get(p)));
          });
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
            if (isBitmask) {
              sm.set(key, ((Number(sm.get(key)) | 0) ^ it.value) & 7);
            } else {
              const cur = sm.get(key);
              if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
              else setAndHint(key, it.value);
            }
            ApplyReq.hard();
          };
          bindReactive(b, [key], (el, v) => el.classList.toggle('active', isBitmask ? (((Number(v) | 0) & it.value) !== 0) : v === it.value), sm, sub);
          row.append(b);
        }
        const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
        offBtn.onclick = (e) => { e.stopPropagation(); sm.set(key, isBitmask ? 0 : offValue); ApplyReq.hard(); };
        bindReactive(offBtn, [key], (el, v) => el.classList.toggle('active', isBitmask ? (Number(v)|0) === 0 : v === offValue), sm, sub);
        if (isBitmask || offValue != null) row.append(offBtn);
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
                mainPanel.style.right = '70px';
                mainPanel.style.top = '50%';
                mainPanel.style.transform = 'translateY(-50%)';
              }
            });
            return;
          }
          const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
          const vv = window.visualViewport;
          const vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0);
          const vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
          const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0;
          const offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
          if (!vw || !vh) return;
          const w = r.width || 300, panH = r.height || 400;
          const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8));
          const top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
          if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
          requestAnimationFrame(() => {
            mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
          });
        } catch (_) {}
      };

      const syncVVVars = () => {
        try {
          const root = document.documentElement, vv = window.visualViewport;
          if (!root || !vv) return;
          root.style.setProperty('--__vsc170-vv-top', `${Math.round(vv.offsetTop)}px`);
          root.style.setProperty('--__vsc170-vv-h', `${Math.round(vv.height)}px`);
        } catch (_) {}
      };

      syncVVVars();
      try {
        const vv = window.visualViewport;
        if (vv) {
          on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
          on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
        }
      } catch (_) {}

      const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport);
      on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
      on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
      on(document, 'fullscreenchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });

      const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

      const build = () => {
        if (container) return;

        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
        const style = `:host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--__vsc170-vv-top,0px) + (var(--__vsc170-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:auto;bottom:max(12px,calc(env(safe-area-inset-bottom,0px) + 12px));right:max(12px,calc(env(safe-area-inset-right,0px) + 12px));left:max(12px,calc(env(safe-area-inset-left,0px) + 12px));transform:none;width:auto;max-height:70vh;padding:12px;border-radius:14px}.prow{flex-wrap:wrap}.btn,.pbtn{min-height:38px;font-size:12px}}.header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);

        const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

        const rmBtn = h('button', { class: 'btn fill-active' });
        rmBtn.onclick = (e) => {
          e.stopPropagation();
          const cur = sm.get(P.APP_RENDER_MODE);
          const next = cur === 'auto' ? 'webgl' : (cur === 'webgl' ? 'svg' : 'auto');
          const activeV = window.__VSC_APP__?.getActiveVideo?.();
          if (activeV) {
            const vst = getVState(activeV);
            if (window.__VSC_INTERNAL__?.Adapter) {
              window.__VSC_INTERNAL__.Adapter.clear(activeV);
            }
            if (next !== 'svg') {
              vst.webglTainted = false;
              vst.webglFailCount = 0;
              vst.webglDisabledUntil = 0;
            }
            vst._svgDeferredClear = false;
          }
          sm.set(P.APP_RENDER_MODE, next);
          if (next === 'svg') sm.set(P.APP_HDR_TONEMAP, false);
          ApplyReq.hard();
        };

        bindReactive(rmBtn, [P.APP_RENDER_MODE], (el, v) => {
          const labels = { auto: '🎨 Auto', webgl: '🎨 WebGL Force', svg: '🎨 SVG Force' };
          const colors = { auto: '#2ecc71', webgl: '#ffaa00', svg: '#88ccff' };
          el.textContent = labels[v] || labels.auto;
          el.style.color = colors[v] || colors.auto;
          el.style.borderColor = colors[v] || colors.auto;
          el.style.background = 'var(--btn-bg)';
        }, sm, sub);

        const startAutoBackendWatcher = () => {
          if (!rmBtn.isConnected) return;
          if (sm.get(P.APP_RENDER_MODE) === 'auto') {
            const activeV = window.__VSC_APP__?.getActiveVideo?.();
            if (activeV) {
              const st = getVState(activeV);
              if (st && st.fxBackend) {
                const suffix = st.fxBackend === 'webgl' ? ' (WebGL)' : ' (SVG)';
                const expectedText = `🎨 Auto${suffix}`;
                if (rmBtn.textContent !== expectedText) {
                  rmBtn.textContent = expectedText;
                }
              }
            }
          }
          setTimeout(startAutoBackendWatcher, 500);
        };
        queueMicrotask(startAutoBackendWatcher);

        const hdrBtn = h('button', { class: 'btn' }, '🎬 Rec.2020');
        hdrBtn.onclick = (e) => {
          e.stopPropagation();
          if (CONFIG.IS_MOBILE) {
            hdrBtn.textContent = '모바일 미지원';
            setTimeout(() => { hdrBtn.textContent = '🎬 Rec.2020'; }, 2000);
            return;
          }
          if (!VSC_MEDIA.isHdr) {
            hdrBtn.textContent = '⚠️ HDR 미감지';
            setTimeout(() => { hdrBtn.textContent = '🎬 Rec.2020'; }, 2000);
            return;
          }
          const nextHdr = !sm.get(P.APP_HDR_TONEMAP);
          sm.set(P.APP_HDR_TONEMAP, nextHdr);
          if (nextHdr && sm.get(P.APP_RENDER_MODE) === 'svg') {
            sm.set(P.APP_RENDER_MODE, 'auto');
          }
          ApplyReq.hard();
        };
        bindReactive(hdrBtn, [P.APP_HDR_TONEMAP, P.APP_RENDER_MODE], (el, v, rMode) => {
          el.classList.toggle('active', !!(v && rMode !== 'svg'));
          if (CONFIG.IS_MOBILE) {
            el.style.opacity = '0.3';
            el.style.cursor = 'not-allowed';
            el.title = '모바일 기기 자체 하드웨어 톤맵 사용을 권장합니다.';
          } else {
            el.style.opacity = VSC_MEDIA.isHdr ? '1' : '0.4';
            el.style.cursor = 'pointer';
            el.title = '';
          }
        }, sm, sub);

        const autoSceneBtn = h('button', { class: 'btn', style: 'flex: 1.2;' }, '✨ 자동 씬');
        bindReactive(autoSceneBtn, [P.APP_AUTO_SCENE], (el, v) => el.classList.toggle('active', !!v), sm, sub);
        autoSceneBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); };

        const pipBtn = h('button', { class: 'btn', style: 'flex: 0.9;', onclick: async (e) => { e.stopPropagation(); const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');

        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 0.9;' }, '🔍 줌');
        zoomBtn.onclick = (e) => {
          e.stopPropagation();
          const zm = window.__VSC_INTERNAL__.ZoomManager;
          const v = window.__VSC_APP__?.getActiveVideo();
          if (!zm || !v) return;
          if (zm.isZoomed(v)) {
            zm.resetZoom(v);
            setAndHint(P.APP_ZOOM_EN, false);
          } else {
            const rect = v.getBoundingClientRect();
            zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
            setAndHint(P.APP_ZOOM_EN, true);
          }
        };
        bindReactive(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.5;' }, '🔊 Brickwall (EQ+Dyn)');
        boostBtn.onclick = (e) => {
          e.stopPropagation();
          if (window.__VSC_INTERNAL__?.AudioWarmup) window.__VSC_INTERNAL__.AudioWarmup();
          setAndHint(P.A_EN, !sm.get(P.A_EN));
        };
        bindReactive(boostBtn, [P.A_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 강조');
        dialogueBtn.onclick = (e) => {
          e.stopPropagation();
          if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE));
        };
        bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN], (el, v, aEn) => {
          el.classList.toggle('active', !!(v && aEn));
          el.style.opacity = aEn ? '1' : '0.35';
          el.style.cursor = aEn ? 'pointer' : 'not-allowed';
        }, sm, sub);

        const pwrBtn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
        bindReactive(pwrBtn, [P.APP_ACT], (el, v) => el.style.color = v ? '#2ecc71' : '#e74c3c', sm, sub);

        const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
        advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
        bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

        const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
          renderButtonRow({
            label: '블랙', key: P.V_SHADOW_MASK, isBitmask: true,
            items: [
              { text: '외암', value: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' },
              { text: '중암', value: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' },
              { text: '심암', value: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' }
            ]
          }),
          renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
          renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }),
          h('hr'),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '오디오'));

            const mb = h('button', { class: 'pbtn', style: 'flex:1' }, '🎚️ 멀티밴드');
            mb.onclick = (e) => { e.stopPropagation(); if(sm.get(P.A_EN)) setAndHint(P.A_MULTIBAND, !sm.get(P.A_MULTIBAND)); };
            bindReactive(mb, [P.A_MULTIBAND, P.A_EN], (el, v, aEn) => {
              el.classList.toggle('active', !!(v && aEn));
              el.style.opacity = aEn ? '1' : '0.35';
              el.style.cursor = aEn ? 'pointer' : 'not-allowed';
            }, sm, sub);

            const lf = h('button', { class: 'pbtn', style: 'flex:1' }, '📊 LUFS 정규화');
            lf.onclick = (e) => { e.stopPropagation(); if(sm.get(P.A_EN)) setAndHint(P.A_LUFS, !sm.get(P.A_LUFS)); };
            bindReactive(lf, [P.A_LUFS, P.A_EN], (el, v, aEn) => {
              el.classList.toggle('active', !!(v && aEn));
              el.style.opacity = aEn ? '1' : '0.35';
              el.style.cursor = aEn ? 'pointer' : 'not-allowed';
            }, sm, sub);

            r.append(mb, lf);
            return r;
          })()
        ]);

        bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, hdrBtn ]),
          h('div', { class: 'prow' }, [ autoSceneBtn, pipBtn, zoomBtn ]),
          h('div', { class: 'prow' }, [ boostBtn, dialogueBtn ]),
          h('div', { class: 'prow' }, [
            h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
            pwrBtn,
            h('button', { class: 'btn', onclick: (e) => {
              e.stopPropagation();
              sm.batch('video', DEFAULTS.video);
              sm.batch('audio', DEFAULTS.audio);
              sm.batch('playback', DEFAULTS.playback);
              sm.set(P.APP_AUTO_SCENE, false);
              sm.set(P.APP_HDR_TONEMAP, false);
              ApplyReq.hard();
            } }, '↺ 리셋')
          ]),
          renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
          advToggleBtn,
          advContainer,
          h('hr'),
          h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
            const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
            b.onclick = (e) => { e.stopPropagation(); setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); };
            bindReactive(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => { el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01); }, sm, sub);
            return b;
          }))
        ]);

        const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]);
        shadow.append(mainPanel);

        let stopDrag = null;
        const startPanelDrag = (e) => {
          const pt = (e && e.touches && e.touches[0]) ? e.touches[0] : e;
          if (!pt) return;
          if (e.target && e.target.tagName === 'BUTTON') return;
          if (e.cancelable) e.preventDefault();
          stopDrag?.();
          hasUserDraggedUI = true;
          let startX = pt.clientX, startY = pt.clientY;
          const rect = mainPanel.getBoundingClientRect();

          mainPanel.style.transform = 'none';
          mainPanel.style.top = `${rect.top}px`;
          mainPanel.style.right = 'auto';
          mainPanel.style.left = `${rect.left}px`;

          try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}

          stopDrag = bindElementDrag(dragHandle, (ev) => {
            const mv = (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
            if (!mv) return;
            const dx = mv.clientX - startX, dy = mv.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx));
            let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
            mainPanel.style.left = `${nextLeft}px`;
            mainPanel.style.top = `${nextTop}px`;
          }, () => {
            stopDrag = null;
          });
        };

        on(dragHandle, 'pointerdown', startPanelDrag);
        on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });

        container = host;
        getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
        if (gearHost) { gearHost.style.display = 'block'; return; }
        gearHost = h('div', { 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${CONFIG.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);
        let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear' }, '⚙');
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1';
          clearTimeout(fadeTimer);
          const inFs = !!document.fullscreenElement;
          if (inFs || CONFIG.IS_MOBILE) return;
          fadeTimer = setTimeout(() => {
            if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; }
          }, 2500);
        };
        wakeGear = wake;
        on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
        on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
        bootWakeTimer = setTimeout(wake, 2000);
        const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return;
          dragThresholdMet = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
          stopDrag = bindElementDrag(gearBtn, (ev) => {
            const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
            if (Math.abs(currentY - startY) > 10) {
              if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; }
              if (ev.cancelable) ev.preventDefault();
            }
            if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
        };
        on(gearBtn, 'pointerdown', handleGearDrag);
        let lastToggle = 0, lastTouchAt = 0;
        const onGearActivate = (e) => {
          if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
          const now = performance.now();
          if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
          lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        };
        on(gearBtn, 'touchend', (e) => { lastTouchAt = performance.now(); safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); onGearActivate(e); }, { passive: false });
        on(gearBtn, 'click', (e) => { const now = performance.now(); if (now - lastTouchAt < 800) { safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); return; } onGearActivate(e); }, { passive: false });
        const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };

        sub(P.APP_ACT, syncGear);
        sub(P.APP_UI, syncGear);
        syncGear();
      };

      const mount = () => {
        const root = getUiRoot(); if (!root) return;
        try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {}
        try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {}
      };

      const ensure = () => {
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        ensureGear();
        if (sm.get(P.APP_UI)) { build(); const mainPanel = getMainPanel(); if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } }
        else { const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible'); }
        mount(); safe(() => wakeGear?.());
      };

      onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });
      window.__VSC_UI_Ensure = ensure;
      return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
    }

    function getRateState(v) {
      const st = getVState(v);
      if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0 };
      return st.rateState;
    }

    function markInternalRateChange(v, ms = 300) {
      const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
    }

    const restoreRateOne = (el) => {
      try {
        const st = getRateState(el); if (!st || st.orig == null) return;
        const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
        st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate;
      } catch (_) {}
    };

    function ensureMobileInlinePlaybackHints(video) {
      if (!video || !CONFIG.IS_MOBILE) return;
      safe(() => { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); });
    }

    const onEvictRateVideo = (v) => { safe(() => restoreRateOne(v)); };
    const onEvictVideo = (v) => { if (window.__VSC_INTERNAL__.Adapter) window.__VSC_INTERNAL__.Adapter.clear(v); restoreRateOne(v); };

    const cleanupTouched = (TOUCHED) => {
      const vids = [...TOUCHED.videos]; const rateVids = [...TOUCHED.rateVideos];
      TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
      const immediate = vids.filter(v => v.isConnected && getVState(v).visible);
      const deferred = vids.filter(v => !immediate.includes(v));
      for (const v of immediate) onEvictVideo(v);
      for (const v of rateVids) onEvictRateVideo(v);
      if (deferred.length > 0) {
        const cleanup = (deadline) => {
          while (deferred.length > 0) {
            if (deadline?.timeRemaining && deadline.timeRemaining() < 2) {
              if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 200 });
              else setTimeout(cleanup, 16);
              return;
            }
            const v = deferred.pop();
            if (!v.isConnected) onEvictVideo(v);
          }
        };
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 500 }); else setTimeout(() => { for (const v of deferred) onEvictVideo(v); }, 0);
      }
    };

    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v); if (st.bound) return;
      st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
      const softResetTransientFlags = () => {
        st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.webglFailCount = 0; st.webglDisabledUntil = 0;
        if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; st.webglTainted = false; }
        if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; }
        ApplyReq.hard();
      };
      const combinedSignal = combineSignals(st._ac.signal, __globalSig);
      const opts = { passive: true, signal: combinedSignal };
      const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => {
          const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return;
          const st = getVState(v);
          const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return;
          const store = window.__VSC_INTERNAL__?.Store; if (!store) return;
          const activeVideo = window.__VSC_INTERNAL__?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return;
          const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); }
        }]];
      for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
    };

    let __lastApplyTarget = null;
    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el); Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); if (st._ac) { st._ac.abort(); st._ac = null; } st.bound = false; bindVideoOnce(el, ApplyReq);
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el), rSt = getRateState(el); if (rSt.orig == null) rSt.orig = el.playbackRate;
      if (!Object.is(st.desiredRate, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        const now = performance.now(); rSt._setAttempts = (rSt._setAttempts || 0) + 1;
        if (rSt._setAttempts === 1) { rSt._firstAttemptT = now; } else if (rSt._setAttempts > 5) { if (now - (rSt._firstAttemptT || 0) < 2000) return; rSt._setAttempts = 1; rSt._firstAttemptT = now; }
        st.desiredRate = desiredRate; markInternalRateChange(el, 160); try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAdd(TOUCHED.rateVideos, el);
    }

    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, storeRMode, ApplyReq }) {
      const candidates = new Set();
      for (const set of [dirtyVideos, TOUCHED.videos, TOUCHED.rateVideos, applySet]) {
        for (const v of set) if (v?.tagName === 'VIDEO') candidates.add(v);
      }
      for (const el of candidates) {
        if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el); const visible = (st.visible !== false); const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));
        if (!shouldApply) { 
          if (!st.applied && !st.fxBackend && st.desiredRate === undefined) continue;
          clearVideoRuntimeState(el, Adapter, ApplyReq); 
          continue; 
        }
        if (videoFxOn) { Adapter.apply(el, storeRMode, vVals); touchedAdd(TOUCHED.videos, el); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
        if (pbActive) { applyPlaybackRate(el, desiredRate); } else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
        bindVideoOnce(el, ApplyReq);
      }
      candidates.clear();
    }

    function createVideoParamsMemo(Store, P) {
      const getDetailLevel = (presetKey) => {
        const k = String(presetKey || 'off').toUpperCase().trim();
        if (k === 'XL') return 'xl'; if (k === 'L') return 'l'; if (k === 'M') return 'm'; if (k === 'S') return 's'; return 'off';
      };
      const SHADOW_PARAMS = new Map([[SHADOW_BAND.DEEP, { toe: 3.5, gamma: -0.04, mid: 0 }], [SHADOW_BAND.MID, { toe: 2.0, gamma: 0, mid: -0.08 }], [SHADOW_BAND.OUTER, { toe: 0, gamma: -0.02, mid: -0.15 }]]);
      return {
        get(vfUser, storeRMode, activeVideo) {
          const detailP = PRESETS.detail[vfUser.presetS || 'off']; const gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'];
          const out = { sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0, gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, satF: 1.0, temp: 0, gain: 1.0, mid: 0, toe: 0, shoulder: 0, __qos: 'full', _hdrToneMap: !!Store.get(P.APP_HDR_TONEMAP) };
          const sMask = vfUser.shadowBandMask || 0;
          if (sMask > 0) {
            let toeSum = 0; for (const [bit, params] of SHADOW_PARAMS) { if (sMask & bit) { toeSum += params.toe; out.gamma += params.gamma; out.mid += params.mid; } }
            const combinedAttenuation = 1 - 0.15 * Math.max(0, toeSum - 2.5);
            out.toe = VSC_CLAMP(toeSum * Math.max(0.5, combinedAttenuation), 0, 3.5);
          }
          out.mid = VSC_CLAMP(out.mid, -0.20, 0); const brStep = vfUser.brightStepLevel || 0;
          if (brStep > 0) { out.bright += brStep * 4.0; out.toe = Math.max(0, out.toe - brStep * 0.5); out.gamma *= (1.0 + brStep * 0.03); }
          const { rs, gs, bs } = tempToRgbGain(out.temp); out._rs = rs; out._gs = gs; out._bs = bs; out.__detailLevel = getDetailLevel(vfUser.presetS);
          return out;
        }
      };
    }

    function isNeutralVideoParams(p) {
      return (p.sharp === 0 && p.sharp2 === 0 && p.clarity === 0 && p.gamma === 1.0 && p.bright === 0 && p.contrast === 1.0 && p.satF === 1.0 && p.temp === 0 && p.gain === 1.0 && p.mid === 0 && p.toe === 0 && p.shoulder === 0);
    }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
      Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });
      let __activeTarget = null, __lastAudioTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
      const videoParamsMemo = createVideoParamsMemo(Store, P);

      function updateQualityScale(v) {
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale;
        const now = performance.now();
        if (now - lastQCheck < 2000) return qualityScale;
        lastQCheck = now;
        try {
          const q = v.getVideoPlaybackQuality();
          const dropped = Number(q.droppedVideoFrames || 0);
          const total = Number(q.totalVideoFrames || 0);
          const dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0));
          const dTotal = Math.max(0, total - (__lastQSample.total || 0));
          __lastQSample = { dropped, total };

          if (dTotal < 30) return qualityScale;
          if (total < 300) return qualityScale;

          const ratio = dDropped / dTotal;
          const target = ratio > 0.20 ? 0.65 : (ratio > 0.12 ? 0.85 : 1.0);
          const alpha = target < qualityScale ? 0.15 : 0.12;
          qualityScale = qualityScale * (1 - alpha) + target * alpha;

          if (qualityScale < 0.60) {
            const st = getVState(v);
            if (st && st.fxBackend === 'webgl') {
              st.webglDisabledUntil = now + 8000;
              safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard());
            }
          }
        } catch (_) {}
        return qualityScale;
      }
      Scheduler.registerApply((force) => {
        try {
          const active = !!Store.getCatRef('app').active; if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }
          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;

          const wantAudioNow = !!(Store.get(P.A_EN) && active), storeRMode = Store.get(P.APP_RENDER_MODE) || 'auto';
          const pbActive = active && !!Store.get(P.PB_EN);
          const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__VSC_INTERNAL__.lastUserPt, wantAudioNow);
          let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
          if (nextTarget !== __activeTarget) __activeTarget = nextTarget;

          const targetChanged = __activeTarget !== __lastApplyTarget;
          if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

          const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }
          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; }
          Audio.update();

          const vf0 = Store.getCatRef('video'); let vValsEffective = videoParamsMemo.get(vf0, storeRMode, __activeTarget);
          const autoScene = window.__VSC_INTERNAL__?.AutoScene; const qs = updateQualityScale(__activeTarget);
          if (qs < 0.95) vValsEffective.__qos = 'fast'; else vValsEffective.__qos = 'full';

          const autoSceneVVals = {};
          if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
            const mods = autoScene.getMods();
            if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
              Object.assign(autoSceneVVals, vValsEffective); const uBr = autoSceneVVals.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
              autoSceneVVals.gain = uBr * (1.0 + (mods.br - 1.0) * aSF); autoSceneVVals.contrast = (autoSceneVVals.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF); autoSceneVVals.satF = (autoSceneVVals.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
              const userSharpTotal = (autoSceneVVals.sharp || 0) + (autoSceneVVals.sharp2 || 0) + (autoSceneVVals.clarity || 0);
              const sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5); const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF) * (qs < 0.95 ? Math.sqrt(qs) : 1.0);
              autoSceneVVals.sharp = (autoSceneVVals.sharp || 0) * combinedSharpScale; autoSceneVVals.sharp2 = (autoSceneVVals.sharp2 || 0) * combinedSharpScale; autoSceneVVals.clarity = (autoSceneVVals.clarity || 0) * combinedSharpScale;
              vValsEffective = autoSceneVVals;
            }
          } else if (qs < 0.95) {
            Object.assign(autoSceneVVals, vValsEffective); const qSharp = Math.sqrt(qs); autoSceneVVals.sharp = (autoSceneVVals.sharp || 0) * qSharp; autoSceneVVals.sharp2 = (autoSceneVVals.sharp2 || 0) * qSharp; autoSceneVVals.clarity = (autoSceneVVals.clarity || 0) * qSharp;
            vValsEffective = autoSceneVVals;
          }
          const videoFxOn = !isNeutralVideoParams(vValsEffective); const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), applySet = new Set();
          if (applyToAllVisibleVideos) { for (const v of visible.videos) applySet.add(v); } else if (__activeTarget) { applySet.add(__activeTarget); }

          const desiredRate = Store.get(P.PB_RATE);
          reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, storeRMode, ApplyReq });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) { log.warn('apply crashed:', e); }
      });

      let tickTimer = 0;
      const startTick = () => {
        if (tickTimer) return;
        const tick = () => {
          if (!Store.get(P.APP_ACT) || document.hidden) return;
          Scheduler.request(false);
        };
        tickTimer = setInterval(tick, 12000);
      };
      const stopTick = () => {
        if (!tickTimer) return;
        clearInterval(tickTimer);
        tickTimer = 0;
      };

      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick();
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, getQualityScale() { return qualityScale; }, destroy() { stopTick(); safe(() => UI.destroy?.()); safe(() => { Audio.setTarget(null); Audio.destroy?.(); }); safe(() => __globalHooksAC.abort()); } });
    }

    const Utils = createUtils(); const Scheduler = createScheduler(32); const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
    const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
    window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    function bindNormalizer(keys, schema) {
      const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); };
      keys.forEach(k => Store.sub(k, run));
      run();
    }

    bindNormalizer(ALL_KEYS, ALL_SCHEMA);

    const Registry = createRegistry(Scheduler);
    const Targeting = createTargeting();
    initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

    onPageReady(() => {
      installShadowRootEmitterIfNeeded();
      (function ensureRegistryAfterBodyReady() {
        let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); };
        if (document.body) { runOnce(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
        on(document, 'DOMContentLoaded', runOnce, { once: true });
      })();
      const AutoScene = createAutoSceneManager(Store, P, Scheduler); window.__VSC_INTERNAL__.AutoScene = AutoScene;
      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
      const FiltersGL = createFiltersWebGL(Utils);

      const Adapter = createBackendAdapter(Filters, FiltersGL);
      window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store); window.__VSC_INTERNAL__.AudioWarmup = Audio.warmup;
      let ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager;
      const UI = createUI(Store, Registry, ApplyReq, Utils);

      let __vscLastUserSignalT = 0; window.__VSC_INTERNAL__.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__VSC_INTERNAL__.lastUserPt.x = x; window.__VSC_INTERNAL__.lastUserPt.y = y; window.__VSC_INTERNAL__.lastUserPt.t = t; }
      function signalUserInteractionForRetarget() {
        const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false));
      }
      for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
        on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!window.__VSC_INTERNAL__.lastUserPt || (now - window.__VSC_INTERNAL__.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
      }
      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__; AutoScene.start();

      on(window, 'keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (e.altKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault(); e.stopPropagation();
          safe(() => {
            const st = window.__VSC_INTERNAL__?.Store;
            if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); }
          });
          return;
        }
        if (e.altKey && e.shiftKey && e.code === 'KeyP') {
          const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v);
        }
      }, { capture: true });

      on(document, 'visibilitychange', () => { safe(() => checkAndCleanupClosedPiP()); safe(() => { if (document.visibilityState === 'visible') window.__VSC_INTERNAL__?.ApplyReq?.hard(); }); }, OPT_P);

      on(window, 'beforeunload', () => {
        safe(() => __VSC_APP__?.destroy());
      }, { once: true });
    });
  }
  VSC_MAIN();
})();
// --- PART 4 END ---
