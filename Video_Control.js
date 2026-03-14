/* ── Hybrid Filter Engine ────────────────────────────────────── */
  function createFiltersVideoOnly(Utils, vscId) {
    const { h } = Utils, ctxMap = new WeakMap(), __vscBgMemo = new WeakMap();
    const SHADOW_TABLES = {
      1: '0 0.17 0.35 0.52 0.69 0.86 1',
      2: '0 0.15 0.32 0.50 0.67 0.84 1',
      3: '0 0.13 0.29 0.48 0.65 0.82 1',
    };

    function ensureOpaqueBg(video) {
      if (!video || __vscBgMemo.has(video) || !FILTER_FORCE_OPAQUE_BG) return;
      try { const cs = getComputedStyle(video).backgroundColor, isTransparent = !cs || cs === 'transparent' || cs === 'rgba(0, 0, 0, 0)'; if (isTransparent) { __vscBgMemo.set(video, video.style.backgroundColor || ''); video.style.backgroundColor = '#000'; } else { __vscBgMemo.set(video, null); } } catch (_) {}
    }
    function restoreOpaqueBg(video) { if (!video) return; const prev = __vscBgMemo.get(video); if (prev === undefined) return; __vscBgMemo.delete(video); if (prev !== null) video.style.backgroundColor = prev; }

    function buildSvg(root) {
      const fidMain = `vsc-main-${vscId}`, svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const mkFuncRGB = (attrs) => [h('feFuncR', { ns: 'svg', ...attrs }), h('feFuncG', { ns: 'svg', ...attrs }), h('feFuncB', { ns: 'svg', ...attrs })], mainFilter = h('filter', { ns: 'svg', id: fidMain, 'color-interpolation-filters': 'sRGB', x: '-8%', y: '-8%', width: '116%', height: '116%' });
      const blurMicro = h('feGaussianBlur', { ns: 'svg', in: 'SourceGraphic', stdDeviation: '0.22', result: 'bMicro' }), usmMicro = h('feComposite', { ns: 'svg', in: 'SourceGraphic', in2: 'bMicro', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpMicro' }), blurFine = h('feGaussianBlur', { ns: 'svg', in: 'SourceGraphic', stdDeviation: '0.60', result: 'bFine' }), usmFine = h('feComposite', { ns: 'svg', in: 'SourceGraphic', in2: 'bFine', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpFine' }), blend = h('feComposite', { ns: 'svg', in: 'sharpMicro', in2: 'sharpFine', operator: 'arithmetic', k1: '0', k2: '0.55', k3: '0.45', k4: '0', result: 'sharpOut' });
      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' }), shadowToneXfer = h('feComponentTransfer', { ns: 'svg', in: 'sharpOut', result: 'finalOut' }, ...shadowToneFuncs);
      mainFilter.append(blurMicro, usmMicro, blurFine, usmFine, blend, shadowToneXfer); defs.append(mainFilter);
      const tryAppend = () => { const tgt = root.body || root.documentElement || root; if (tgt?.appendChild) { tgt.appendChild(svg); return true; } return false; };
      if (!tryAppend() && root.nodeType === 9) { const mo = new MutationObserver(() => { if (tryAppend()) mo.disconnect(); }); try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {} setTimer(() => mo.disconnect(), 5000); }
      return { fidMain, sharp: { blurMicro, usmMicro, blurFine, usmFine, blend }, color: { shadowToneFuncs }, st: { lastKey: '', blurKey: '', sharpKey: '', shadowKey: '' } };
    }

    function setAttrIfChanged(el, name, value) {
      const strVal = String(value);
      if (el.getAttribute(name) === strVal) return;
      el.setAttribute(name, strVal);
    }

    function updateSharpNodes(nodes, st, s, sharpTotal) {
      if (sharpTotal > 0) {
        const qSharp = Math.max(0, Math.round(Number(s.sharp || 0))), qSharp2 = Math.max(0, Math.round(Number(s.sharp2 || 0))), sigmaScale = Number(s._sigmaScale) || 1.0, microBase = Number(s._microBase) || 0.18, microScale = Number(s._microScale) || (1/120), fineBase = Number(s._fineBase) || 0.32, fineScale = Number(s._fineScale) || (1/24), microAmtCoeffs = s._microAmt || [0.55, 0.10], fineAmtCoeffs = s._fineAmt || [0.20, 0.85], sigMicro = VSC_CLAMP((microBase + qSharp * microScale) * sigmaScale, 0.25, 1.40), sigFine = VSC_CLAMP((fineBase + qSharp2 * fineScale) * sigmaScale, 0.18, 2.00), microAmt = VSC_CLAMP((qSharp * microAmtCoeffs[0] + qSharp2 * microAmtCoeffs[1]) / 45, 0, 1.5), fineAmt = VSC_CLAMP((qSharp * fineAmtCoeffs[0] + qSharp2 * fineAmtCoeffs[1]) / 24, 0, 1.2), totalAmt = microAmt + fineAmt + 1e-6, microWeight = VSC_CLAMP(0.35 + 0.30 * (microAmt / totalAmt), 0.25, 0.70), fineWeight = 1.0 - microWeight, blurKeyNext = `${sigMicro.toFixed(3)}|${sigFine.toFixed(3)}`;
        if (st.blurKey !== blurKeyNext) { st.blurKey = blurKeyNext; setAttrIfChanged(nodes.sharp.blurMicro, 'stdDeviation', sigMicro.toFixed(3)); setAttrIfChanged(nodes.sharp.blurFine, 'stdDeviation', sigFine.toFixed(3)); }
        const sharpKeyNext = `${microAmt.toFixed(5)}|${fineAmt.toFixed(5)}`; if (st.sharpKey !== sharpKeyNext) { st.sharpKey = sharpKeyNext; const mk2 = (1 + microAmt).toFixed(5), mk3 = (-microAmt).toFixed(5), fk2 = (1 + fineAmt).toFixed(5), fk3 = (-fineAmt).toFixed(5), bk2 = microWeight.toFixed(4), bk3 = fineWeight.toFixed(4); setAttrIfChanged(nodes.sharp.usmMicro, 'k2', mk2); setAttrIfChanged(nodes.sharp.usmMicro, 'k3', mk3); setAttrIfChanged(nodes.sharp.usmFine, 'k2', fk2); setAttrIfChanged(nodes.sharp.usmFine, 'k3', fk3); setAttrIfChanged(nodes.sharp.blend, 'k2', bk2); setAttrIfChanged(nodes.sharp.blend, 'k3', bk3); }
      } else { const bypassKey = 'bypass'; if (st.sharpKey !== bypassKey) { st.sharpKey = bypassKey; st.blurKey = bypassKey; setAttrIfChanged(nodes.sharp.blurMicro, 'stdDeviation', '0'); setAttrIfChanged(nodes.sharp.blurFine, 'stdDeviation', '0'); setAttrIfChanged(nodes.sharp.usmMicro, 'k2', 1); setAttrIfChanged(nodes.sharp.usmMicro, 'k3', 0); setAttrIfChanged(nodes.sharp.usmFine, 'k2', 1); setAttrIfChanged(nodes.sharp.usmFine, 'k3', 0); setAttrIfChanged(nodes.sharp.blend, 'k2', 1); setAttrIfChanged(nodes.sharp.blend, 'k3', 0); } }
    }

    function updateColorNodes(nodes, st, shadowParams) {
      if (shadowParams && shadowParams.active) { const level = shadowParams.level || 0, factor = shadowParams.factor !== undefined ? shadowParams.factor : 1.0, shadowKey = `crush_v4|${level}|${factor.toFixed(3)}`; if (st.shadowKey !== shadowKey) { st.shadowKey = shadowKey; const tv = SHADOW_TABLES[level] || SHADOW_TABLES[1]; for (const fn of nodes.color.shadowToneFuncs) setAttrIfChanged(fn, 'tableValues', tv); } } else { const neutralKey = 'shadow_off'; if (st.shadowKey !== neutralKey) { st.shadowKey = neutralKey; for (const fn of nodes.color.shadowToneFuncs) setAttrIfChanged(fn, 'tableValues', '0 1'); } }
    }

    function getSvgUrl(video, s, shadowParams) {
      const sharpTotal = Math.round(Number(s.sharp || 0)) + Math.round(Number(s.sharp2 || 0)), shadowActive = !!(shadowParams && shadowParams.active);
      if (sharpTotal <= 0 && !shadowActive) return null;
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
      const stableKey = `u|${s.sharp}|${s.sharp2}|${(s._sigmaScale||1).toFixed(2)}|sh:${shadowActive ? 'lv' + shadowParams.level : 'off'}`;
      let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }
      if (nodes.st.lastKey !== stableKey) { nodes.st.lastKey = stableKey; updateSharpNodes(nodes, nodes.st, s, sharpTotal); updateColorNodes(nodes, nodes.st, shadowParams); }
      return `url(#${nodes.fidMain})`;
    }

    return {
      invalidateCache: (video) => { try { const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document); const nodes = ctxMap.get(root); if (nodes) { nodes.st.lastKey = ''; nodes.st.blurKey = ''; nodes.st.sharpKey = ''; nodes.st.shadowKey = ''; } } catch (_) {} },
      applyCombined: (video, vVals, shadowParams, precomputedCssFilter) => {
        const st = getVState(video); ensureOpaqueBg(video);
        let finalFilter = precomputedCssFilter ?? buildCssFilterString(vVals);
        const svgUrl = getSvgUrl(video, vVals, shadowParams);
        if (svgUrl) { finalFilter = finalFilter ? `${finalFilter} ${svgUrl}` : svgUrl; }

        if (!finalFilter) {
           restoreOpaqueBg(video);
           if (st.applied) { video.style.removeProperty('transition'); if (st.origFilter != null && st.origFilter !== '') video.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else video.style.removeProperty('filter'); st.applied = false; st.lastFilterUrl = null; st.origFilter = null; st.origFilterPrio = ''; st._lastUsedSvg = undefined; }
           return;
        }
        if (!st.applied) { st.origFilter = video.style.getPropertyValue('filter'); st.origFilterPrio = video.style.getPropertyPriority('filter') || ''; }
        if (st.lastFilterUrl !== finalFilter) {
           const needsSvg = !!svgUrl;
           if (st._lastUsedSvg !== needsSvg) { st._lastUsedSvg = needsSvg; video.style.setProperty('transition', needsSvg ? 'none' : 'filter 0.3s ease', 'important'); }
           video.style.setProperty('filter', finalFilter, 'important'); st.applied = true; st.lastFilterUrl = finalFilter;
        }
      },
      clear: (video) => { const st = getVState(video); if (st.applied) { restoreOpaqueBg(video); video.style.removeProperty('transition'); if (st.origFilter != null && st.origFilter !== '') video.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else video.style.removeProperty('filter'); st.applied = false; st.lastFilterUrl = null; st.origFilter = null; st.origFilterPrio = ''; st._lastUsedSvg = undefined; } }
    };
  }

  function createBackendAdapter(Filters) { return { apply(video, vVals, shadowParams, cssFilter) { Filters.applyCombined(video, vVals, shadowParams, cssFilter); }, clear(video) { Filters.clear(video); } }; }

  /* ── Targeting ───────────────────────────────────────────────── */
  function createTargeting() {
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
    const isInPlayer = (vid) => { if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true; const root = vid.getRootNode(); if (root instanceof ShadowRoot && root.host) return !!root.host.closest(PLAYER_CONTAINER_SELECTORS); return false; };
    function getViewportSnapshot() { const vv = window.visualViewport; if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }

    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      if (videos.size === 0) return { target: null };
      if (videos.size === 1) { const v = videos.values().next().value; return { target: (v?.readyState >= 1) ? v : null }; }
      const now = performance.now(), vp = getViewportSnapshot(); let best = null, bestScore = -Infinity;
      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;
        if (typeof v.checkVisibility === 'function') { try { if (!v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return; } catch (_) {} }
        const st = getVState(v), r = st.rect || v.getBoundingClientRect(), area = (r?.width || 0) * (r?.height || 0), hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);
        if (!hasDecoded && area < 160 * 120) return;
        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;
        if (v.currentTime > 0.2) s += 2.0; s += Math.log2(1 + area / 20000) * 1.1;
        const ptAge = Math.max(0, now - (lastUserPt.t || 0)), userBias = Math.exp(-ptAge / 1800), dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
        s += (2.0 * userBias) / (1 + (dx * dx + dy * dy) / 722500); const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx * cdx + cdy * cdy) / 810000);
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
        if (!v.controls && !isInPlayer(v)) s -= 1.0; if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
        const vSrc = v.currentSrc || v.src || ''; if (vSrc.startsWith('blob:')) s += 1.5;
        if (s > bestScore) { bestScore = s; best = v; }
      };
      for (const v of videos) evalScore(v);
      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget?.isConnected && now < stickyUntil && best && stickyTarget !== best && bestScore < stickyScore + hysteresis) return { target: stickyTarget };
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000; return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  /* ── UI, Zoom ────────────────────────────────────────────────── */
  function showToast(text) { const v = __vscNs.App?.getActiveVideo(), target = v?.parentNode?.isConnected ? v.parentNode : (document.body || document.documentElement); if (!target) return; let t = target.querySelector('.vsc-toast'); if (!t) { t = document.createElement('div'); t.className = 'vsc-toast'; t.style.cssText = 'position:absolute !important;bottom:15% !important;left:50% !important;transform:translateX(-50%) !important;background:rgba(0,0,0,0.82) !important;color:#fff !important;padding:8px 18px !important;border-radius:20px !important;font:600 13.5px/1.3 system-ui,sans-serif !important;z-index:2147483647 !important;pointer-events:none !important;opacity:0 !important;transition:opacity 0.2s ease-in-out !important;backdrop-filter:blur(6px) !important;border:1px solid rgba(255,255,255,0.15) !important;white-space:pre-line !important;letter-spacing:-0.3px !important;'; if (target !== document.body && getComputedStyle(target).position === 'static') target.style.position = 'relative'; target.appendChild(t); } t.textContent = text; t.style.setProperty('opacity', '1', 'important'); clearTimer(t._tid); t._tid = setTimer(() => { if (t) t.style.setProperty('opacity', '0', 'important'); }, 1500); }
  __vscNs.showToast = showToast;
  function seekVideo(video, offset) { const sr = video.seekable; let minT = 0, maxT = video.duration; const isLive = !Number.isFinite(maxT); if (isLive) { if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); } const target = VSC_CLAMP(video.currentTime + offset, minT, maxT - (isLive ? 2.0 : 0.1)); try { video.currentTime = target; } catch (_) {} }
  function execVideoAction(action, val) { const v = __vscNs.App?.getActiveVideo(); if (!v) return; if (action === 'play') v.play().catch(() => {}); else if (action === 'pause') v.pause(); else if (action === 'seek') seekVideo(v, val); }

  function bindElementDrag(el, onMove, onEnd) { const ac = new AbortController(); on(el, 'pointermove', (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); }, { passive: false, signal: ac.signal }); const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); }; const cancel = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(null); }; on(el, 'pointerup', up, { signal: ac.signal }); on(el, 'pointercancel', cancel, { signal: ac.signal }); return () => ac.abort(); }

  function createUI(sm, registry, ApplyReq, Utils, P) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null, hasUserDraggedUI = false; const uiWakeCtrl = new AbortController(), uiUnsubs = []; const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };

    let infoTimer = 0;
    const detachNodesHard = () => { removeSafe(container); removeSafe(gearHost); clearRecurring(infoTimer); infoTimer = 0; if (_clampRafId) { cancelAnimationFrame(_clampRafId); _clampRafId = 0; } };

    const allowUiInThisDoc = () => { const hn = location.hostname, pn = location.pathname; if (hn.includes('netflix.com')) return pn.startsWith('/watch'); if (hn.includes('coupangplay.com')) return pn.startsWith('/play'); return true; };
    const getUiRoot = () => { const fs = document.fullscreenElement; return fs ? (fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement || document.body) : fs) : (document.body || document.documentElement); };
    const setAndHint = (path, value) => { if (!Object.is(sm.get(path), value)) { sm.set(path, value); (path === P.APP_ACT || path === P.APP_APPLY_ALL || path.startsWith('video.')) ? ApplyReq.hard() : ApplyReq.soft(); } };
    function bindReactive(btn, paths, apply) { const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false, destroyed = false; const sync = () => { if (pending || destroyed) return; pending = true; queueMicrotask(() => { pending = false; if (!destroyed && btn?.isConnected !== false) apply(btn, ...pathArr.map(p => sm.get(p))); }); }; pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); return sync; }
    function bindActGate(btn, extraPaths, applyFn) { return bindReactive(btn, [...(Array.isArray(extraPaths) ? extraPaths : []), P.APP_ACT], (el, ...vals) => { const act = vals[vals.length - 1]; el.style.setProperty('opacity', act ? '1' : '0.45', 'important'); el.style.setProperty('cursor', act ? 'pointer' : 'not-allowed', 'important'); el.disabled = !act; if (applyFn) applyFn(el, ...vals); }); }
    const guardedClick = (fn) => (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; fn(e); };

    const applyBtnState = (el, isActive, isEnabled) => {
      el.classList.toggle('active', isActive);
      el.style.setProperty('opacity', isEnabled ? '1' : (isActive ? '0.65' : '0.45'), 'important');
      el.style.setProperty('cursor', isEnabled ? 'pointer' : 'not-allowed', 'important');
      el.disabled = !isEnabled;
    };

    function renderButtonRow({ label, items, key, offValue = 0 }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px !important;width:38px !important;flex-shrink:0 !important;display:flex !important;align-items:center !important;font-weight:600 !important;color:var(--c-dim) !important;' }, label));
      const onChange = (val) => { if (!sm.get(P.APP_ACT)) return; const cur = sm.get(key); if (offValue !== null && cur === val && val !== offValue) setAndHint(key, offValue); else setAndHint(key, val); };
      for (const it of items) { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, it.text); b.onclick = (e) => { e.stopPropagation(); onChange(it.value); }; bindReactive(b, [key, P.APP_ACT], (el, v, act) => applyBtnState(el, v === it.value, act)); row.append(b); }
      if (offValue != null) { const offBtn = h('button', { class: 'pbtn', style: 'flex:0.9 !important;' }, 'OFF'); offBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(key, offValue); }; bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => applyBtnState(el, v === offValue, act)); row.append(offBtn); }
      return row;
    }

    const clampPanelIntoViewport = () => {
      try {
        const mainPanel = container?.shadowRoot?.querySelector('.main');
        if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI || CONFIG.IS_MOBILE) {
          mainPanel.style.removeProperty('left');
          mainPanel.style.removeProperty('transform');
          mainPanel.style.removeProperty('top');
          mainPanel.style.removeProperty('right');
          mainPanel.style.removeProperty('bottom');
          mainPanel.style.setProperty('display', 'block', 'important');
          return;
        }
        const r = mainPanel.getBoundingClientRect();
        const vv = window.visualViewport;
        const vw = vv?.width || window.innerWidth || 0;
        const vh = vv?.height || window.innerHeight || 0;
        const offL = vv?.offsetLeft || 0;
        const offT = vv?.offsetTop || 0;
        if (!vw || !vh) return;
        const left = VSC_CLAMP(r.left, offL + 4, Math.max(offL + 4, offL + vw - (r.width || 280) - 4));
        const top = VSC_CLAMP(r.top, offT + 4, Math.max(offT + 4, offT + vh - (r.height || 400) - 4));
        mainPanel.style.setProperty('right', 'auto', 'important');
        mainPanel.style.setProperty('transform', 'none', 'important');
        mainPanel.style.setProperty('left', `${left}px`, 'important');
        mainPanel.style.setProperty('top', `${top}px`, 'important');
      } catch (_) {}
    };

    const syncVVVars = () => { try { const vv = window.visualViewport, vvTop = vv ? Math.round(vv.offsetTop) : 0, vvH = vv ? Math.round(vv.height) : window.innerHeight, root = document.documentElement; if (root) { root.style.setProperty('--vsc-vv-top', `${vvTop}px`); root.style.setProperty('--vsc-vv-h', `${vvH}px`); } if (container?.isConnected) { container.style.setProperty('--vsc-vv-top', `${vvTop}px`); container.style.setProperty('--vsc-vv-h', `${vvH}px`); } } catch (_) {} };
    syncVVVars(); let _clampRafId = 0; const onLayoutChange = () => { if (_clampRafId) return; _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); }); }; const uiSig = combineSignals(uiWakeCtrl.signal, __globalSig); try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); } } catch (_) {} on(window, 'resize', onLayoutChange, { passive: true, signal: uiSig });
    on(document, 'fullscreenchange', () => { const isFs = !!document.fullscreenElement; if (isFs) { if (container) container._prevUiState = sm.get(P.APP_UI); if (sm.get(P.APP_UI)) sm.set(P.APP_UI, false); } else { if (container && container._prevUiState !== undefined) { sm.set(P.APP_UI, !!container._prevUiState); container._prevUiState = undefined; } } setTimer(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: uiSig });
    const getMainPanel = () => container?.shadowRoot?.querySelector('.main');
    function attachShadowStyles(shadowRoot, cssText) { try { if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') { const sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]; return; } } catch (_) {} const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl); }

    const CSS_VARS = `:host{--bg:rgba(18,18,22,.97);--bg-elevated:rgba(35,35,42,.95);--c:#e8e8ec;--c-dim:#888;--b:1px solid rgba(255,255,255,.12);--btn-bg:rgba(255,255,255,.06);--btn-bg-hover:rgba(255,255,255,.12);--ac:#4a9eff;--ac-video:#a78bfa;--ac-audio:#34d399;--ac-play:#fbbf24;--ac-glow:rgba(74,158,255,.15);--danger:#ff4757;--danger-bg:rgba(255,71,87,.1);--success:#2ed573;--success-bg:rgba(46,213,115,.1);--br:8px;--gap:6px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--vsc-safe-right:max(66px,calc(env(safe-area-inset-right,0px) + 66px))}*,*::before,*::after{box-sizing:border-box}@media(max-width:520px){:host{--vsc-safe-right:max(58px,calc(env(safe-area-inset-right,0px) + 58px))}}@media(max-width:360px){:host{--vsc-safe-right:max(52px,calc(env(safe-area-inset-right,0px) + 52px))}}`;
    const PANEL_CSS = `${CSS_VARS}.main{position:fixed!important;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2))!important;right:var(--vsc-safe-right)!important;transform:translateY(-50%)!important;width:min(320px,calc(100vw - 80px))!important;background:var(--bg)!important;backdrop-filter:blur(12px)!important;color:var(--c)!important;padding:15px!important;border-radius:16px!important;z-index:2147483647!important;border:1px solid rgba(255,255,255,.08)!important;font-family:var(--font)!important;box-shadow:0 16px 64px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.05)!important;overflow-y:auto!important;max-height:min(95vh,calc(var(--vsc-vv-h,100vh) - 20px))!important;-webkit-overflow-scrolling:touch!important;display:none}.main.visible{display:block!important}@media(max-width:520px){.main{width:min(280px,calc(100vw - 72px))!important;max-height:min(85vh,calc(var(--vsc-vv-h,100vh) - 24px))!important;padding:10px 11px 14px!important;border-radius:12px!important;font-size:11.5px!important}.main::-webkit-scrollbar{width:3px!important}.main::-webkit-scrollbar-thumb{background:#666!important;border-radius:10px!important}.prow{gap:3px!important}.btn,.pbtn{min-height:32px!important;font-size:10.5px!important;padding:0 4px!important}.tab{padding:7px 0!important;font-size:10.5px!important}}@media(max-width:360px){.main{width:min(240px,calc(100vw - 64px))!important;padding:8px 8px 12px!important}.btn,.pbtn{min-height:30px!important;font-size:10px!important}.tab{font-size:10px!important}}@media(max-height:480px){.main{max-height:calc(var(--vsc-vv-h,100vh) - 16px)!important}}.btn,.pbtn{border:var(--b)!important;background:var(--btn-bg)!important;color:var(--c)!important;border-radius:var(--br)!important;cursor:pointer!important;font-weight:600!important;font-family:var(--font)!important;transition:background .12s,border-color .12s,color .12s!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:10px 0!important;flex:1!important}.pbtn{padding:0 6px!important;height:36px!important;min-height:36px!important}.btn:hover,.pbtn:hover{background:var(--btn-bg-hover)!important}.btn.active,.pbtn.active{background:var(--ac-glow)!important;border-color:var(--ac)!important;color:var(--ac)!important;box-shadow:0 0 8px rgba(74,158,255,.25)!important}.prow{display:flex!important;gap:var(--gap)!important;align-items:center!important}hr{border:0!important;border-top:1px solid rgba(255,255,255,.14)!important;margin:8px 0!important}`;
    const TAB_CSS = `${PANEL_CSS}.tabs{display:flex!important;border-bottom:2px solid #444!important;margin:0 -15px!important;padding:0 15px!important}.tab{flex:1!important;padding:10px 0!important;text-align:center!important;font-size:12px!important;font-weight:700!important;cursor:pointer!important;color:var(--c-dim)!important;border-bottom:2px solid transparent!important;margin-bottom:-2px!important;transition:color .15s,border-color .15s!important}.tab.active{color:var(--ac)!important;border-bottom-color:var(--ac)!important}.tab-content{display:none!important;flex-direction:column!important;gap:6px!important;padding-top:12px!important}.tab-content.active{display:flex!important}.header{display:flex!important;align-items:center!important;justify-content:space-between!important;cursor:move!important;padding:6px 0 10px!important;border-bottom:1px solid rgba(255,255,255,.06)!important;margin-bottom:6px!important}.header-title{font-size:14px!important;font-weight:700!important}.header-actions{display:flex!important;gap:6px!important}.header-actions .btn{padding:6px 12px!important;font-size:11px!important;min-width:auto!important}.tab-content[data-tab="video"] .pbtn.active{background:rgba(167,139,250,.15)!important;border-color:#a78bfa!important;color:#a78bfa!important;box-shadow:0 0 8px rgba(167,139,250,.2)!important}.tab-content[data-tab="audio"] .pbtn.active,.tab-content[data-tab="audio"] .btn.active{background:rgba(52,211,153,.15)!important;border-color:#34d399!important;color:#34d399!important;box-shadow:0 0 8px rgba(52,211,153,.2)!important}.tab-content[data-tab="play"] .pbtn.active{background:rgba(251,191,36,.15)!important;border-color:#fbbf24!important;color:#fbbf24!important;box-shadow:0 0 8px rgba(251,191,36,.2)!important}.btn-icon{border:none!important;background:transparent!important;width:32px!important;height:32px!important;padding:0!important;display:flex!important;align-items:center!important;justify-content:center!important;border-radius:8px!important;color:var(--c-dim)!important;cursor:pointer!important;font-size:16px!important;transition:background .12s,color .12s!important;flex:none!important}.btn-icon:hover{background:rgba(255,255,255,.1)!important;color:var(--c)!important}@media(max-width:520px){.tabs{margin:0 -11px!important;padding:0 11px!important}.header-title{font-size:12.5px!important}.header-actions .btn{padding:5px 8px!important;font-size:10px!important}.btn-icon{width:28px!important;height:28px!important;font-size:14px!important}.tab-content{gap:4px!important;padding-top:8px!important}hr{margin:5px 0!important}}@media(max-width:360px){.tabs{margin:0 -8px!important;padding:0 8px!important}.header{padding:4px 0 6px!important}.header-title{font-size:11.5px!important}.tab-content{gap:3px!important;padding-top:6px!important}}`;
    const GEAR_CSS = `:host{--danger:#ff4757;--success:#2ed573}.gear{--size:46px;position:fixed!important;top:50%!important;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px))!important;transform:translateY(-50%)!important;width:var(--size)!important;height:var(--size)!important;border-radius:50%!important;background:rgba(25,25,25,.92)!important;backdrop-filter:blur(10px)!important;border:1px solid rgba(255,255,255,.18)!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:center!important;font:700 22px/1 sans-serif!important;cursor:pointer!important;pointer-events:auto!important;z-index:2147483647!important;box-shadow:0 12px 44px rgba(0,0,0,.55)!important;user-select:none!important;transition:transform .12s ease,opacity .3s ease!important;opacity:1!important;-webkit-tap-highlight-color:transparent!important}.gear:not(.open){opacity:0.45!important}.gear.inactive::after{content:''!important;position:absolute!important;top:4px!important;right:4px!important;width:8px!important;height:8px!important;border-radius:50%!important;background:var(--danger)!important}.gear.open::after{content:''!important;position:absolute!important;top:4px!important;right:4px!important;width:8px!important;height:8px!important;border-radius:50%!important;background:var(--success)!important}@media(pointer:coarse){.gear{--size:48px}}@media(max-width:360px){.gear{--size:42px}}`;

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${CONFIG.VSC_ID}`, 'data-vsc-ui': '1', 'data-vsc-id': CONFIG.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, TAB_CSS);

      const pwrBtn = h('button', { class: 'btn' }, 'ON');
      pwrBtn.onclick = () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT));
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.textContent = v ? 'ON' : 'OFF'; el.style.setProperty('color', v ? 'var(--success)' : 'var(--danger)', 'important'); el.style.setProperty('border-color', v ? 'var(--success)' : 'var(--danger)', 'important'); el.style.setProperty('background', v ? 'var(--success-bg)' : 'var(--danger-bg)', 'important'); });

      const closeBtn = h('button', { class: 'btn-icon', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕');
      const resetBtn = h('button', { class: 'btn-icon' }, '↺');
      resetBtn.onclick = guardedClick(() => { sm.batch('video', CONFIG.DEFAULTS.video); sm.batch('audio', CONFIG.DEFAULTS.audio); sm.batch('playback', CONFIG.DEFAULTS.playback); ApplyReq.hard(); showToast('초기화 완료'); });

      const dragHandle = h('div', { class: 'header' }, h('div', { class: 'header-title', style: 'flex:1 !important;' }, `VSC ${CONFIG.DEBUG ? 'v' + __vscNs.__version : ''}`.trim()), h('div', { class: 'header-actions' }, pwrBtn, resetBtn, closeBtn));

      const tabDefs = [{ text: '🎬 Video' }, { text: '🔊 Audio' }, { text: '⏩ Play' }]; const tabBtns = [], tabContents = []; let activeTabIdx = 0;
      const switchTab = (idx) => { activeTabIdx = idx; tabBtns.forEach((b, i) => b.classList.toggle('active', i === idx)); tabContents.forEach((c, i) => c.classList.toggle('active', i === idx)); };
      for (let i = 0; i < tabDefs.length; i++) { const btn = h('div', { class: `tab${i === 0 ? ' active' : ''}` }, tabDefs[i].text); btn.onclick = (e) => { e.stopPropagation(); switchTab(i); }; tabBtns.push(btn); }
      const tabBar = h('div', { class: 'tabs' }, ...tabBtns);

      const utilRow = h('div', { class: 'prow' }, (() => { const pipBtn = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '📌 PiP'); pipBtn.onclick = guardedClick(async () => { const v = __vscNs.App?.getActiveVideo(); if (!v) return; try { if (document.pictureInPictureElement === v) await document.exitPictureInPicture(); else if (v.disablePictureInPicture) showToast('PiP 차단됨'); else await v.requestPictureInPicture(); } catch (_) { showToast('PiP 미지원'); } }); bindActGate(pipBtn, []); return pipBtn; })(), (() => { const capBtn = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '📸 캡처'); capBtn.onclick = guardedClick(() => { const v = __vscNs.App?.getActiveVideo(); if (!v || v.readyState < 2) { showToast('로드 대기 중'); return; } try { if (typeof OffscreenCanvas !== 'undefined') { const canvas = new OffscreenCanvas(v.videoWidth, v.videoHeight); canvas.getContext('2d').drawImage(v, 0, 0); canvas.convertToBlob({ type: 'image/png' }).then(blob => { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `vsc-${Date.now()}.png`; a.click(); setTimer(() => URL.revokeObjectURL(url), 5000); showToast('캡처 완료'); }).catch(() => showToast('캡처 실패')); } else { const canvas = document.createElement('canvas'); canvas.width = v.videoWidth; canvas.height = v.videoHeight; canvas.getContext('2d').drawImage(v, 0, 0); canvas.toBlob(blob => { if(!blob) { showToast('캡처 실패'); return; } const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `vsc-${Date.now()}.png`; a.click(); setTimer(() => URL.revokeObjectURL(url), 5000); showToast('캡처 완료'); }, 'image/png'); } } catch (_) { showToast('보안 제한'); } }); bindActGate(capBtn, []); return capBtn; })());

      const infoLabel = h('div', { style: 'font-size:10.5px !important;color:#aaa !important;padding:8px 10px !important;font-family:monospace !important;text-align:left !important;min-height:40px !important;line-height:1.5 !important;white-space:pre-wrap !important;background:rgba(255,255,255,0.05) !important;border-radius:8px !important;margin:6px 0 !important;letter-spacing:-0.2px !important;' }, '—');
      const updateInfo = () => { const v = __vscNs.App?.getActiveVideo(); if (!v) { infoLabel.textContent = '비디오 없음'; return; } const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0; const ratio = nW && dW ? ((dW * devicePixelRatio) / nW).toFixed(2) : '?'; const line1 = `원본: ${nW} × ${nH}`; const line2 = `출력: ${dW} × ${dH} (${ratio}x)`; infoLabel.textContent = `${line1}\n${line2}`; };
      const infoVisHandler = (vis) => { clearRecurring(infoTimer); if (vis) { updateInfo(); infoTimer = setRecurring(updateInfo, 5000); } };
      sub(P.APP_UI, infoVisHandler);
      if (sm.get(P.APP_UI)) infoVisHandler(true);

      const videoTab = h('div', { class: 'tab-content active', 'data-tab': 'video' },
        renderButtonRow({ label: '선명', key: P.V_PRE_S, offValue: 'off', items: [{ text: 'Soft', value: 'Soft' }, { text: 'Med', value: 'Medium' }, { text: 'Ultra', value: 'Ultra' }, { text: 'MST', value: 'Master' }] }),
        renderButtonRow({ label: '밝기', key: P.V_BRIGHT_LV, offValue: 0, items: [{ text: '1', value: 1 }, { text: '2', value: 2 }, { text: '3', value: 3 }, { text: '4', value: 4 }, { text: '5', value: 5 }] }),
        renderButtonRow({ label: '블랙', key: P.V_SHADOW_MASK, offValue: 0, items: [{ text: '밝게', value: CONFIG.DARK_BAND.LV1 }, { text: '짙게', value: CONFIG.DARK_BAND.LV2 }, { text: '강하게', value: CONFIG.DARK_BAND.LV3 }] }),
        renderButtonRow({ label: '색온', key: P.V_TEMP, offValue: 0, items: [{ text: '야간', value: 35 }, { text: '따뜻', value: 18 }, { text: '맑음', value: -15 }, { text: '냉색', value: -30 }] }),
        infoLabel,
        (() => { const zoomBtn = h('button', { class: 'btn', style: 'width:100% !important;' }, '🔍 줌 토글'); zoomBtn.onclick = guardedClick(() => { const zm = __vscNs.ZoomManager, v = __vscNs.App?.getActiveVideo(); if (!zm || !v) return; if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); } }); bindActGate(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v)); return zoomBtn; })(),
        utilRow
      ); tabContents.push(videoTab);

      const boostToggle = h('button', { class: 'btn', style: 'width:100% !important;' }, '🔊 Audio Mastering'); boostToggle.onclick = guardedClick(() => { __vscNs.AudioWarmup?.(); setAndHint(P.A_EN, !sm.get(P.A_EN)); }); bindActGate(boostToggle, [P.A_EN], (el, aEn) => { el.classList.toggle('active', !!aEn); });
      const boostRow = renderButtonRow({ label: '음량', key: P.A_BST, offValue: 0, items: [{ text: '+3', value: 3 }, { text: '+6', value: 6 }, { text: '+9', value: 9 }, { text: '+12', value: 12 }] }); bindReactive(boostRow, [P.A_EN, P.APP_ACT], (el, aEn, act) => { const on = act && aEn; el.style.setProperty('opacity', on ? '1' : '0.45', 'important'); el.style.setProperty('pointer-events', on ? 'auto' : 'none', 'important'); });
      const audioTab = h('div', { class: 'tab-content', 'data-tab': 'audio' }, boostToggle, boostRow); tabContents.push(audioTab);

      const speedBtns = h('div', { class: 'prow', style: 'flex-wrap:wrap !important;gap:4px !important;' }, ...[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;min-height:36px !important;' }, s + 'x'); b.onclick = guardedClick(() => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }); bindActGate(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01)); return b; }));
      const fineRow = h('div', { class: 'prow', style: 'gap:4px !important;' }, (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '- 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.max(0.1, Math.round((cur - 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); return b; })(), (() => { const lbl = h('div', { style: 'flex:2 !important;text-align:center !important;font-size:13px !important;font-weight:bold !important;line-height:36px !important;' }, '1.00x'); bindReactive(lbl, [P.PB_RATE, P.PB_EN], (el, rate, en) => { const r = Number(rate) || 1.0; el.textContent = en ? `${r.toFixed(2)}x` : '1.00x'; el.style.setProperty('color', en && Math.abs(r - 1.0) > 0.01 ? 'var(--ac)' : '#eee', 'important'); }); return lbl; })(), (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '+ 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.min(16, Math.round((cur + 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); return b; })(), (() => { const b = h('button', { class: 'pbtn', style: 'flex:0.8 !important;' }, 'OFF'); b.onclick = guardedClick(() => { sm.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); }); return b; })());
      const seekRow = h('div', { class: 'prow', style: 'gap:2px !important;' }, ...[{ text: '◀30', val: -30 }, { text: '◀15', val: -15 }, { text: '⏸', action: 'pause' }, { text: '▶', action: 'play' }, { text: '15▶', val: 15 }, { text: '30▶', val: 30 }].map(cfg => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;min-height:34px !important;font-size:11px !important;' }, cfg.text); b.onclick = guardedClick(() => execVideoAction(cfg.action || 'seek', cfg.val)); bindActGate(b, []); return b; }));
      const frameStepRow = h('div', { class: 'prow', style: 'gap:4px !important;' }, (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;font-size:11px !important;' }, '◀ 1f'); b.onclick = guardedClick(() => { const v = __vscNs.App?.getActiveVideo(); if (!v) return; v.pause(); seekVideo(v, -1 / 30); }); bindActGate(b, []); return b; })(), (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;font-size:11px !important;' }, '1f ▶'); b.onclick = guardedClick(() => { const v = __vscNs.App?.getActiveVideo(); if (!v) return; v.pause(); seekVideo(v, 1 / 30); }); bindActGate(b, []); return b; })());
      const timerRow = h('div', { style: 'display:flex !important;gap:6px !important;align-items:center !important;' }, renderButtonRow({ label: '시계', key: P.APP_TIME_EN, offValue: false, items: [{ text: 'ON', value: true }] }));
      const timerPosRow = renderButtonRow({ label: '위치', key: P.APP_TIME_POS, items: [{ text: '좌', value: 0 }, { text: '중', value: 1 }, { text: '우', value: 2 }] });
      const kbRow = renderButtonRow({ label: '단축', key: P.APP_KB_EN, offValue: false, items: [{ text: 'Alt 단축키', value: true }] });
      const playbackTab = h('div', { class: 'tab-content', 'data-tab': 'play' }, speedBtns, fineRow, h('hr'), seekRow, frameStepRow, h('hr'), timerRow, timerPosRow, kbRow); tabContents.push(playbackTab);

      const mainPanel = h('div', { class: 'main' }, dragHandle, tabBar, ...tabContents); shadow.append(mainPanel); if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);

      let stopDrag = null;
      const startPanelDrag = (e) => { if (e.target?.tagName === 'BUTTON') return; if (CONFIG.IS_MOBILE) { if (e.cancelable) e.preventDefault(); const startY = e.clientY; const panelEl = getMainPanel(); try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(dragHandle, (ev) => { const dy = Math.max(0, ev.clientY - startY); if (panelEl) { panelEl.style.setProperty('transform', `translateY(${dy}px)`, 'important'); panelEl.style.setProperty('opacity', `${Math.max(0.3, 1 - dy / 300)}`, 'important'); } }, (ev) => { if (panelEl) { panelEl.style.removeProperty('transform'); panelEl.style.removeProperty('opacity'); } if (ev && ev.clientY - startY > 60) sm.set(P.APP_UI, false); stopDrag = null; }); return; } if (e.cancelable) e.preventDefault(); stopDrag?.(); stopDrag = null; hasUserDraggedUI = true; let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect(); mainPanel.style.setProperty('transform', 'none', 'important'); mainPanel.style.setProperty('top', `${rect.top}px`, 'important'); mainPanel.style.setProperty('right', 'auto', 'important'); mainPanel.style.setProperty('left', `${rect.left}px`, 'important'); try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(dragHandle, (ev) => { const dx = ev.clientX - startX, dy = ev.clientY - startY, pr = mainPanel.getBoundingClientRect(); mainPanel.style.setProperty('left', `${Math.max(0, Math.min(window.innerWidth - pr.width, rect.left + dx))}px`, 'important'); mainPanel.style.setProperty('top', `${Math.max(0, Math.min(window.innerHeight - pr.height, rect.top + dy))}px`, 'important'); }, () => { stopDrag = null; }); };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (gearHost) return; gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial !important;position:fixed !important;inset:0 !important;pointer-events:none !important;z-index:2147483647 !important;isolation:isolate !important;' }); const shadow = gearHost.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, GEAR_CSS);
      let dragThresholdMet = false, stopDrag = null;
      gearBtn = h('button', { class: 'gear' }, h('svg', { ns: 'svg', viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('circle', { ns: 'svg', cx: '12', cy: '12', r: '3' }), h('path', { ns: 'svg', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06-.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }))); shadow.append(gearBtn); if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);
      const wake = () => { if (gearBtn) gearBtn.style.setProperty('opacity', '1', 'important'); clearTimer(fadeTimer); if (!!document.fullscreenElement || CONFIG.IS_MOBILE) return; fadeTimer = setTimer(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.setProperty('opacity', '0.45', 'important'); }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: uiSig }); on(window, 'touchstart', wake, { passive: true, signal: uiSig }); bootWakeTimer = setTimer(wake, 2000);
      const handleGearDrag = (e) => { if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); stopDrag = null; const startY = e.clientY, rect = gearBtn.getBoundingClientRect(); try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {} const currentSession = {}; stopDrag = bindElementDrag(gearBtn, (ev) => { const DRAG_THRESHOLD = CONFIG.IS_MOBILE ? 15 : 10; if (Math.abs(ev.clientY - startY) > DRAG_THRESHOLD) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.setProperty('transition', 'none', 'important'); gearBtn.style.setProperty('transform', 'none', 'important'); gearBtn.style.setProperty('top', `${rect.top}px`, 'important'); } if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) gearBtn.style.setProperty('top', `${Math.max(0, Math.min(window.innerHeight - gearBtn.offsetHeight, rect.top + (ev.clientY - startY)))}px`, 'important'); }, (ev) => { gearBtn.style.transition = ''; if (dragThresholdMet) { setTimer(() => { dragThresholdMet = false; if (stopDrag === currentSession._cleanup) stopDrag = null; }, 100); } else { stopDrag = null; } }); currentSession._cleanup = stopDrag; };
      on(gearBtn, 'pointerdown', handleGearDrag); let lastToggle = 0;
      on(gearBtn, 'pointerup', (e) => {
        if (e.cancelable) e.preventDefault(); e.stopPropagation?.(); if (dragThresholdMet) return; const now = performance.now(); if (now - lastToggle < 300) return; lastToggle = now;
        if (e.altKey) { const pre = sm.get(P.V_PRE_S), brt = sm.get(P.V_BRIGHT_LV), shd = sm.get(P.V_SHADOW_MASK), tmp = sm.get(P.V_TEMP), aEn = sm.get(P.A_EN), aBst = sm.get(P.A_BST), rate = sm.get(P.PB_RATE), pbEn = sm.get(P.PB_EN); const parts = []; if (pre !== 'off') parts.push(`선명:${pre}`); if (brt > 0) parts.push(`밝기:${brt}`); if (shd > 0) parts.push(`블랙:${shd}`); if (tmp !== 0) parts.push(`색온:${tmp}`); if (aEn) parts.push(`Audio+${aBst}dB`); if (pbEn) parts.push(`${Number(rate).toFixed(2)}x`); showToast(parts.length > 0 ? parts.join(' · ') : '기본 설정'); return; }
        setAndHint(P.APP_UI, !sm.get(P.APP_UI));
      }, { passive: false });
      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); }; sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc() || (registry.videos.size === 0 && !sm.get(P.APP_UI))) { detachNodesHard(); return; } ensureGear(); const mainPanel = getMainPanel(); if (sm.get(P.APP_UI)) { build(); const mp = getMainPanel(); if (mp && !mp.classList.contains('visible')) { mp.style.setProperty('display', 'block', 'important'); mp.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { if (mainPanel) { mainPanel.classList.remove('visible'); mainPanel.style.setProperty('display', 'none', 'important'); } } mount(); wakeGear?.(); };
    onPageReady(() => { ensure(); ApplyReq.hard(); });
    return { ensure, destroy: () => { uiUnsubs.forEach(u => u()); uiUnsubs.length = 0; uiWakeCtrl.abort(); clearTimer(fadeTimer); clearTimer(bootWakeTimer); detachNodesHard(); } };
  }
  function createUIFeature(Store, Registry, ApplyReq, Utils, P) { let uiInst = null; return defineFeature({ name: 'ui', phase: PHASE.RENDER, onInit() { uiInst = createUI(Store, Registry, ApplyReq, Utils, P); this.subscribe('video:detected', () => uiInst?.ensure()); this.subscribe('allVideosRemoved', () => uiInst?.ensure()); }, onUpdate() { uiInst?.ensure(); }, onDestroy() { uiInst?.destroy(); } }); }

  /* ── Zoom Manager ────────────────────────────────────────────── */
  function createZoomManager(Store, P) {
    const stateMap = new WeakMap(); let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0; let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 }; const zoomedVideos = new Set(); let activePointerId = null; const zoomAC = new AbortController(), zsig = combineSignals(zoomAC.signal, __globalSig);
    const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origStyle: '' }; stateMap.set(v, st); } return st; };
    const update = (v) => { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active; if (st.scale <= 1) { if (st.zoomed) { v.style.cssText = st.origStyle; st.zoomed = false; } st.scale = 1; st.tx = 0; st.ty = 0; zoomedVideos.delete(v); return; } if (!st.zoomed) { st.origStyle = v.style.cssText; st.zoomed = true; } v.style.cssText = st.origStyle + `; will-change: transform !important; contain: paint !important; backface-visibility: hidden !important; transition: ${panning ? 'none' : 'transform 80ms ease-out'} !important; transform-origin: 0 0 !important; transform: translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)}) !important; cursor: ${panning ? 'grabbing' : 'grab'} !important; z-index: 2147483646 !important; position: relative !important;`; zoomedVideos.add(v); }); };
    function clampPan(v, st) { const r = v.getBoundingClientRect(); if (!r || r.width <= 1 || r.height <= 1) return; const sw = r.width * st.scale, sh = r.height * st.scale; st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75); st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75); }
    const zoomTo = (v, newScale, cx, cy) => { const st = getSt(v), r = v.getBoundingClientRect(); if (!r || r.width <= 1) return; const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale; st.tx = cx - (r.left - st.tx) - ix * newScale; st.ty = cy - (r.top - st.ty) - iy * newScale; st.scale = newScale; update(v); }, resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); }, isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; }, getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let unsubAct = null, unsubZoomEn = null; if (Store?.sub) { const resetAll = () => { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; }; unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) resetAll(); }); unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { resetAll(); zoomedVideos.clear(); } }); }
    function getTargetVideo(e) { if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } } const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null); if (cx != null && cy != null) { const els = document.elementsFromPoint(cx, cy); for (const el of els) { if (el?.tagName === 'VIDEO') return el; } } return __vscNs.App?.getActiveVideo() || null; }
    on(window, 'wheel', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return; const v = getTargetVideo(e); if (!v) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10); if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY); }, { passive: false, capture: true, signal: zsig });
    on(window, 'pointerdown', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale <= 1) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty; try { v.setPointerCapture?.(e.pointerId); } catch (_) {} update(v); }, { capture: true, passive: false, signal: zsig });
    on(window, 'pointermove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const st = getSt(activeVideo); if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e], last = events[events.length - 1] || e; const nextTx = last.clientX - startX, nextTy = last.clientY - startY; if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true; st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo); }, { capture: true, passive: false, signal: zsig });
    function endPointerPan(e) { if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const v = activeVideo, st = getSt(v); try { v.releasePointerCapture?.(e.pointerId); } catch (_) {} if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); } activePointerId = null; isPanning = false; activeVideo = null; update(v); }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig }); on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'dblclick', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v); }, { capture: true, signal: zsig });
    on(window, 'touchstart', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return; const v = getTargetVideo(e); if (!v) return; if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const st = getSt(v); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; pinchState.lastCx = (e.touches[0].clientX + e.touches[1].clientX) / 2; pinchState.lastCy = (e.touches[0].clientY + e.touches[1].clientY) / 2; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchmove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; const st = getSt(activeVideo); if (pinchState.active && e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const dist = getTouchDist(e.touches), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2; let newScale = Math.min(Math.max(1, pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist))), 10); if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; } else { zoomTo(activeVideo, newScale, cx, cy); st.tx += cx - pinchState.lastCx; st.ty += cy - pinchState.lastCy; clampPan(activeVideo, st); update(activeVideo); } pinchState.lastCx = cx; pinchState.lastCy = cy; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchend', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { update(activeVideo); activeVideo = null; } }, { passive: false, capture: true, signal: zsig });
    return { resetZoom, zoomTo, isZoomed, setEnabled: () => {}, pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } }, destroy: () => { safe(() => unsubAct?.()); safe(() => unsubZoomEn?.()); zoomAC.abort(); if (rafId) { cancelAnimationFrame(rafId); rafId = null; } for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; } zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } };
  }
  function createZoomFeature(Store, P) { let zm = null; return defineFeature({ name: 'zoom', phase: PHASE.PROCESS, onInit() { zm = createZoomManager(Store, P); }, onDestroy() { zm?.destroy(); }, methods: { pruneDisconnected: () => zm?.pruneDisconnected(), isZoomed: (v) => zm?.isZoomed(v), zoomTo: (v, s, x, y) => zm?.zoomTo(v, s, x, y), resetZoom: (v) => zm?.resetZoom(v) } }); }

  /* ── Timer Feature (Strict: position:fixed + polling) ────────── */
  function createTimerFeature() {
    let _rafId = 0, _timerEl = null, _lastSecond = -1, _destroyed = false, _lastLayoutKey = '', _lastParent = null;
    let _pollId = 0;
    const getFullscreenElement = () => document.fullscreenElement;
    function createTimerEl() {
      const el = document.createElement('div'); el.className = 'vsc-fs-timer'; el.setAttribute('data-vsc-ui', '1');
      el.style.cssText = ['position:absolute !important', 'z-index:2147483647 !important', 'color:#FFE600 !important', 'font-family:monospace !important', 'font-weight:bold !important', 'pointer-events:none !important', 'user-select:none !important', 'font-variant-numeric:tabular-nums !important', 'letter-spacing:1px !important', '-webkit-text-stroke:1.5px #000 !important', 'paint-order:stroke fill !important', 'transition:opacity 0.2s !important', 'opacity:0.5 !important', 'margin:0 !important', 'padding:0 !important', 'border:none !important', 'display:block !important', 'background:transparent !important', 'box-shadow:none !important', 'text-shadow:none !important'].join(';');
      return el;
    }
    function getTimerParent() { const fs = getFullscreenElement(); if (!fs) return null; if (fs.tagName === 'VIDEO') { const parent = fs.parentElement; if (parent?.isConnected) return parent; return null; } return fs; }
    function restoreParentPos() { if (_lastParent && _lastParent.__vscOrigPos !== undefined) { _lastParent.style.position = _lastParent.__vscOrigPos; delete _lastParent.__vscOrigPos; } _lastParent = null; }
    function ensureTimerAttached() {
      const parent = getTimerParent();
      if (!parent) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); restoreParentPos(); return null; }
      if (_timerEl && _timerEl.parentNode === parent && _timerEl.isConnected) return parent;
      removeSafe(_timerEl); _timerEl = createTimerEl();
      restoreParentPos();
      try { const pos = getComputedStyle(parent).position; if (pos === 'static' || pos === '') { parent.__vscOrigPos = parent.style.position; parent.style.setProperty('position', 'relative', 'important'); } } catch (_) {}
      parent.appendChild(_timerEl); _lastParent = parent; _lastLayoutKey = ''; return parent;
    }
    function tick() {
      _rafId = 0; if (_destroyed) return;
      const store = __vscNs.Store; if (!store) { scheduleNext(); return; }
      const act = store.get('app.active'), timeEn = store.get('app.timeEn'), isFs = !!getFullscreenElement();
      if (!act || !timeEn || !isFs) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); restoreParentPos(); _lastSecond = -1; _lastLayoutKey = ''; return; }
      const activeVideo = __vscNs.App?.getActiveVideo?.();
      if (!activeVideo?.isConnected) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); restoreParentPos(); _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const parent = ensureTimerAttached(); if (!parent) { scheduleNext(); return; }
      const now = new Date(), curSecond = now.getSeconds(), timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(curSecond).padStart(2, '0')}`;
      _timerEl.style.setProperty('display', 'block', 'important'); if (_timerEl.textContent !== timeStr) _timerEl.textContent = timeStr; _lastSecond = curSecond;
      const vRect = activeVideo.getBoundingClientRect(), pRect = parent.getBoundingClientRect(), relTop = vRect.top - pRect.top, relLeft = vRect.left - pRect.left, relRight = vRect.right - pRect.left, vWidth = vRect.width, pos = store.get('app.timePos') ?? 1, layoutKey = `${relLeft | 0},${relTop | 0},${vWidth | 0},${pos}`;
      if (_lastLayoutKey !== layoutKey) {
        _lastLayoutKey = layoutKey; const fontSize = vWidth >= 2500 ? 36 : vWidth >= 1900 ? 30 : vWidth >= 1200 ? 24 : 18, topOffset = vWidth > 1200 ? 16 : 8, edgeMargin = vWidth > 1200 ? 20 : 10;
        _timerEl.style.setProperty('font-size', `${fontSize}px`, 'important'); _timerEl.style.setProperty('top', `${relTop + topOffset}px`, 'important'); _timerEl.style.setProperty('bottom', 'auto', 'important'); _timerEl.style.setProperty('right', 'auto', 'important');
        if (pos === 0) { _timerEl.style.setProperty('left', `${relLeft + edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'none', 'important'); }
        else if (pos === 1) { _timerEl.style.setProperty('left', `${relLeft + vWidth / 2}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-50%)', 'important'); }
        else { _timerEl.style.setProperty('left', `${relRight - edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-100%)', 'important'); }
      }
      scheduleNext();
    }
    function scheduleNext() { if (!_destroyed && !_rafId) _rafId = requestAnimationFrame(tick); }
    function startPolling() { stopPolling(); _pollId = setRecurring(() => { if (_destroyed) { stopPolling(); return; } const store = __vscNs.Store; if (!store) return; const isFs = !!getFullscreenElement(), timeEn = store.get('app.timeEn'), act = store.get('app.active'); if (isFs && timeEn && act && !_rafId) scheduleNext(); }, 1000); }
    function stopPolling() { if (_pollId) { clearRecurring(_pollId); _pollId = 0; } }
    return defineFeature({
      name: 'timer', phase: PHASE.RENDER,
      onInit() { _destroyed = false; this.subscribe('fullscreen:changed', ({ active }) => { if (!active) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); restoreParentPos(); _lastSecond = -1; _lastLayoutKey = ''; } scheduleNext(); }); this.subscribe('settings:changed', ({ path }) => { if (path === 'app.active' || path === 'app.timeEn' || path === 'app.timePos' || path === 'app.*') scheduleNext(); }); this.subscribe('target:changed', () => { if (getFullscreenElement()) { _lastLayoutKey = ''; scheduleNext(); } }); startPolling(); if (getFullscreenElement()) scheduleNext(); },
      onDestroy() { _destroyed = true; stopPolling(); if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; } removeSafe(_timerEl); _timerEl = null; restoreParentPos(); _lastSecond = -1; _lastLayoutKey = ''; }
    });
  }

  /* ── Keyboard Shortcuts Feature ──────────────────────────────── */
  function createKeyboardFeature() {
    return defineFeature({
      name: 'keyboard', phase: PHASE.PROCESS,
      onInit() {
        on(document, 'keydown', (e) => {
          if (!this.getSetting(CONFIG.P.APP_ACT) || !this.getSetting(CONFIG.P.APP_KB_EN)) return;
          const t = e.target; if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return;
          if (!e.altKey || e.ctrlKey || e.metaKey) return;
          const store = __vscNs.Store; if (!store) return;
          let handled = false;
          switch (e.code) {
            case 'KeyS': { const order = ['off', 'Soft', 'Medium', 'Ultra', 'Master'], idx = order.indexOf(store.get(CONFIG.P.V_PRE_S)), next = order[(idx + 1) % order.length]; store.set(CONFIG.P.V_PRE_S, next); __vscNs.showToast?.(`선명: ${next}`); __vscNs.ApplyReq?.hard(); handled = true; break; }
            case 'KeyB': { const cur = store.get(CONFIG.P.V_BRIGHT_LV) || 0, next = (cur + 1) % 6; store.set(CONFIG.P.V_BRIGHT_LV, next); __vscNs.showToast?.(`밝기: ${next || 'OFF'}`); __vscNs.ApplyReq?.hard(); handled = true; break; }
            case 'KeyA': { __vscNs.AudioWarmup?.(); const next = !store.get(CONFIG.P.A_EN); store.set(CONFIG.P.A_EN, next); __vscNs.showToast?.(`Audio: ${next ? 'ON' : 'OFF'}`); __vscNs.ApplyReq?.soft(); handled = true; break; }
            case 'KeyD': { const cur = Number(store.get(CONFIG.P.PB_RATE)) || 1.0, next = Math.min(5.0, Math.round((cur + 0.25) * 100) / 100); store.set(CONFIG.P.PB_RATE, next); store.set(CONFIG.P.PB_EN, true); __vscNs.showToast?.(`${next.toFixed(2)}x`); __vscNs.ApplyReq?.hard(); handled = true; break; }
            case 'KeyF': { const cur = Number(store.get(CONFIG.P.PB_RATE)) || 1.0, next = Math.max(0.25, Math.round((cur - 0.25) * 100) / 100); store.set(CONFIG.P.PB_RATE, next); store.set(CONFIG.P.PB_EN, true); __vscNs.showToast?.(`${next.toFixed(2)}x`); __vscNs.ApplyReq?.hard(); handled = true; break; }
            case 'KeyQ': { const next = !store.get(CONFIG.P.APP_ACT); store.set(CONFIG.P.APP_ACT, next); __vscNs.showToast?.(`Power: ${next ? 'ON' : 'OFF'}`); handled = true; break; }
            case 'KeyG': { store.set(CONFIG.P.APP_UI, !store.get(CONFIG.P.APP_UI)); handled = true; break; }
            case 'Digit1': case 'Digit2': case 'Digit3': {
              const idx = parseInt(e.code.slice(5)) - 1; const slots = store.get(CONFIG.P.APP_SLOTS) || [null, null, null];
              if (e.shiftKey) {
                const snapshot = { presetS: store.get(CONFIG.P.V_PRE_S), brightLevel: store.get(CONFIG.P.V_BRIGHT_LV), shadowBandMask: store.get(CONFIG.P.V_SHADOW_MASK), temp: store.get(CONFIG.P.V_TEMP), audioEnabled: store.get(CONFIG.P.A_EN), boost: store.get(CONFIG.P.A_BST), rate: store.get(CONFIG.P.PB_RATE), pbEnabled: store.get(CONFIG.P.PB_EN) };
                const newSlots = [...slots]; newSlots[idx] = snapshot; store.set(CONFIG.P.APP_SLOTS, newSlots); __vscNs.showToast?.(`슬롯 ${idx + 1} 저장 완료`);
              } else {
                const slot = slots[idx]; if (!slot) { __vscNs.showToast?.(`슬롯 ${idx + 1} 비어있음`); handled = true; break; }
                store.batch('video', { presetS: slot.presetS, brightLevel: slot.brightLevel, shadowBandMask: slot.shadowBandMask, temp: slot.temp }); store.batch('audio', { enabled: slot.audioEnabled, boost: slot.boost }); store.batch('playback', { rate: slot.rate, enabled: slot.pbEnabled }); __vscNs.ApplyReq?.hard(); __vscNs.showToast?.(`슬롯 ${idx + 1} 적용`);
              }
              handled = true; break;
            }
          }
          if (handled) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
        }, { capture: true });
      }
    });
  }

  /* ── App Controller ──────────────────────────────────────────── */
  function createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus }) {
    Store.sub(P.APP_UI, () => Scheduler.request(true)); Store.sub(P.APP_ACT, (onState) => { if (onState) { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } });
    let __activeTarget = null, __lastApplyTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    const emitFs = () => { Bus.emit('fullscreen:changed', { active: !!document.fullscreenElement }); if (document.fullscreenElement) Scheduler.request(true); };
    on(document, 'fullscreenchange', emitFs, { passive: true });

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active, sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscNs.__vscUserSignalRev || 0;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos, userPt = __vscNs.lastUserPt || { x: 0, y: 0, t: 0 };
        let pick = Targeting.pickFastActiveOnly(visible.videos, userPt, wantAudioNow);
        if (!pick?.target) pick = Targeting.pickFastActiveOnly(Registry.videos, userPt, wantAudioNow);
        if (!pick?.target) { try { const list = Array.from(document.querySelectorAll('video')); pick = { target: list.find(v => v?.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v?.readyState >= 2) || null }; } catch (_) {} }

        let nextTarget = pick?.target || __activeTarget;
        if (nextTarget !== __activeTarget) { if (Bus) Bus.emit('target:changed', { video: nextTarget, prev: __activeTarget }); __activeTarget = nextTarget; }
        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (targetChanged) { if (__lastApplyTarget) safe(() => __vscNs.Adapter?.clear(__lastApplyTarget)); if (__activeTarget) safe(() => __vscNs.Filters?.invalidateCache(__activeTarget)); }
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now(), pruneInterval = Registry.videos.size > 20 ? 1500 : (Registry.videos.size > 5 ? 3000 : 5000);
        if (vidsDirty.size > 40 || (now - lastPrune > pruneInterval)) {
          const runPrune = () => { Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); queueMicrotask(() => { if (Registry.videos.size === 0) Bus.emit('allVideosRemoved'); }); };
          if (typeof globalThis.scheduler?.postTask === 'function') globalThis.scheduler.postTask(runPrune, { priority: 'background' }).catch(() => {});
          else setTimer(runPrune, 0);
          lastPrune = now;
        }
        Features.updateAll({ active, force, vidsDirty, pbActive, target: __activeTarget, isApplyAll: !!Store.get(P.APP_APPLY_ALL), desiredRate: Store.get(P.PB_RATE) });
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisHandler = null;
    const startTick = () => {
      stopTick();
      tickVisHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) Scheduler.request(false); };
      document.addEventListener('visibilitychange', tickVisHandler, { passive: true });
      let lastTickSRev = -1, lastTickRRev = -1;
      tickTimer = setRecurring(() => {
        if (!Store.get(P.APP_ACT) || document.hidden) return;
        const sRev = Store.rev(), rRev = Registry.rev();
        if (sRev === lastTickSRev && rRev === lastTickRRev) return;
        lastTickSRev = sRev; lastTickRRev = rRev;
        Scheduler.request(false);
      }, 30000);
    };
    const stopTick = () => { if (tickTimer > 0) { clearRecurring(tickTimer); tickTimer = 0; } if (tickVisHandler) { document.removeEventListener('visibilitychange', tickVisHandler); tickVisHandler = null; } };
    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();
    return Object.freeze({ getActiveVideo: () => __activeTarget, destroy() { stopTick(); safe(() => Features.destroyAll()); safe(() => Registry.destroy?.()); } });
  }

  /* ── Bootstrap ───────────────────────────────────────────────── */
  const Bus = createEventBus(), Utils = createUtils(), Scheduler = createScheduler(16);
  const Store = createLocalStore(CONFIG.DEFAULTS, Scheduler, Bus);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const Registry = createRegistry(Scheduler, Bus), Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }, 150));

  onPageReady(() => {
    for (const delay of [3000, 10000]) { setTimer(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); }, delay); }
    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); if (!__globalSig.aborted) __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('VSC 패널 열기/닫기', () => Store.set(CONFIG.P.APP_UI, !Store.get(CONFIG.P.APP_UI)));
        GM_registerMenuCommand('VSC 전원 토글', () => Store.set(CONFIG.P.APP_ACT, !Store.get(CONFIG.P.APP_ACT)));
        GM_registerMenuCommand('VSC 설정 초기화', () => { Store.batch('video', CONFIG.DEFAULTS.video); Store.batch('audio', CONFIG.DEFAULTS.audio); Store.batch('playback', CONFIG.DEFAULTS.playback); ApplyReq.hard(); __vscNs.showToast?.('초기화 완료'); });
      }
    } catch (_) {}

    const Filters = createFiltersVideoOnly(Utils, CONFIG.VSC_ID); const Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter; __vscNs.Filters = Filters;

    const videoParamsMemo = createVideoParamsMemo(), Features = createFeatureRegistry(Bus);
    Features.register(createPipelineFeature(Store, Registry, Adapter, ApplyReq, Targeting, videoParamsMemo));
    const audioFeat = createAudioFeature(Store); Features.register(audioFeat);
    const zoomFeat = createZoomFeature(Store, CONFIG.P); Features.register(zoomFeat);
    const uiFeat = createUIFeature(Store, Registry, ApplyReq, Utils, CONFIG.P); Features.register(uiFeat);
    Features.register(createTimerFeature());
    Features.register(createKeyboardFeature());

    __vscNs.Features = Features; __vscNs.ZoomManager = zoomFeat; __vscNs.AudioWarmup = audioFeat.warmup;
    __vscNs.AudioSetTarget = (v) => safe(() => Bus.emit('target:changed', { video: v, prev: null }));
    __vscNs.UIEnsure = () => safe(() => uiFeat.update());

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }; __vscNs.__vscUserSignalRev = 0;
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteraction() { const now = performance.now(); if (now - __vscLastUserSignalT < 150) return; __vscLastUserSignalT = now; __vscNs.__vscUserSignalRev = (__vscNs.__vscUserSignalRev + 1) | 0; Scheduler.request(false); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) { on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else updateLastUserPt(...getPt(e), performance.now()); signalUserInteraction(); }, evt === 'keydown' ? undefined : OPT_P); }

    let __VSC_APP__ = null;
    Features.initAll({ bus: Bus, store: Store, getActiveVideo: () => __VSC_APP__?.getActiveVideo() || null });
    __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Features, P: CONFIG.P, Targeting, Bus });
    __vscNs.App = __VSC_APP__; ApplyReq.hard();

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') ApplyReq.hard(); }, OPT_P);
    window.addEventListener('beforeunload', () => __VSC_APP__?.destroy(), { once: true });
  });
}

VSC_MAIN();
})();
