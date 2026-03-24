  /* ─────────────────────────────────────────────
   *  §11  Initialization Sequence
   * ───────────────────────────────────────────── */
  const boot = async () => {
    BOOT.phase = 1;

    /* Worker + IDB (parallel) */
    const wOk = WorkerBridge.init();
    let idbOk = false;
    try { idbOk = await IDB.open(); } catch (_) {}

    /* Load cached network quality */
    if (idbOk) {
      try {
        const cached = await IDB.get('netQuality');
        if (cached?.medianRTT) NET.medianRTT = cached.medianRTT;
      } catch (_) {}
    }

    BOOT.phase = 2;

    /* CSS + Font */
    injectCSS();
    overrideFontDisplay();

    /* Low‑power + Timers */
    setLowPower(DEV_TIER === 'low');
    initTimerThrottle();

    /* Pressure */
    initPressure();

    /* Long‑task / LoAF */
    initLongTask();

    BOOT.phase = 3;

    /* Wait for DOM ready */
    const whenReady = () => new Promise(resolve => {
      if (doc.readyState !== 'loading') resolve();
      else doc.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
    await whenReady();

    /* Scan streaming videos */
    scanForStreamingVideos();

    /* Media IO enrollment */
    doc.querySelectorAll('img, video, audio, iframe').forEach(enrollMediaIO);

    /* content‑visibility */
    if (!SP.isChat && !isStreaming) applyCVAuto();

    /* DisplayLock */
    DisplayLock.scan();

    /* Video frame monitor */
    const monitorNewVideo = initVideoFrameMonitor();

    /* 3rd‑party defer */
    deferThirdParty();

    /* Critical resource fetchPriority */
    if (lcpEl && lcpEl.tagName === 'IMG') lcpEl.fetchPriority = 'high';

    /* Speculation rules */
    postTask(() => injectSpecRules());

    /* Preload budget */
    postTask(() => checkPreloadBudget());

    /* Sticky protection */
    postTask(() => protectStickyElements());

    /* Image format scan */
    postTask(() => ImgFormat.scan());

    /* Reporting Observer */
    initReportingObserver();

    /* Navigation (SPA) */
    initNavigation();

    /* Visibility + BFCache */
    initVisibility();

    /* Data Saver listener */
    initDataSaver();

    /* GC */
    initGC();

    /* NetQuality periodic */
    setInterval(() => NetQuality.measure(), 15000);

    /* MutationObserver */
    const mo = initMutationObserver();

    /* Periodic streaming re‑check */
    setInterval(() => {
      scanForStreamingVideos();
      doc.querySelectorAll('video').forEach(v => {
        enrollMediaIO(v);
        if (monitorNewVideo) monitorNewVideo(v);
      });
    }, 5000);

    BOOT.phase = 4;

    /* ─────────────────────────────────────────────
     *  §12  Diagnostic API
     * ───────────────────────────────────────────── */
    win.__turboOptimizer__ = {
      version    : V,
      device     : { cores: DEV_CORES, mem: DEV_MEM, tier: DEV_TIER, mobile: IS_MOBILE },
      network    : NET,
      tier       : TIER,
      fps        : () => +emaFPS.toFixed(1),
      lowPower   : () => lowPower,
      pressure   : () => pressureState,
      streaming  : () => isStreaming,
      memory     : () => Mem.stats(),
      blobURLs   : () => Mem.blobCount,
      dns        : () => DnsHints.stats(),
      csp        : () => CSP.stats,
      imgFormats : () => ImgFormat.stats,
      lcp        : () => ({ time: lcpTime, el: lcpEl?.tagName || null }),
      displayLock: () => DisplayLock.count,
      netQuality : () => ({ medianRTT: NET.medianRTT, rttSamples: NetQuality.rttCount }),
      trustedTypes: TT.name,
      worker     : () => WorkerBridge.alive,
      idb        : () => IDB.ready,
      offscreenCanvas: () => offscreenCanvasUsed,
      features   : {
        worker      : wOk,
        idb         : idbOk,
        pressure    : typeof PressureObserver === 'function',
        mse         : typeof MediaSource === 'function',
        navigation  : navSupported,
        viewTransition: typeof doc.startViewTransition === 'function',
        loaf        : loafSupported,
        finalization: typeof FinalizationRegistry === 'function',
        reporting   : typeof ReportingObserver === 'function',
        videoFrame  : 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      },
    };

    /* ─────────────────────────────────────────────
     *  §13  Boot Log
     * ───────────────────────────────────────────── */
    const f = win.__turboOptimizer__.features;
    const mode = SP.isChat ? 'Chat' : isStreaming ? 'Stream' : SP.AI ? 'Gen' : 'Feed';
    const cvStatus = SP.isChat ? 'off(chat)' : isStreaming ? 'off(MSE)' : 'IO-based';
    console.log(
      `[TO v${V}] ✅ ${mode}:${SP.name} ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ${NET.ect}/${TIER} ` +
      `S:${TaskCtrl ? 'pT+TC' : typeof scheduler !== 'undefined' ? 'pT' : 'rIC'} ` +
      `TT:${TT.name} ` +
      `W:${f.worker ? '✓' : '✗'} IDB:${f.idb ? '✓' : '✗'} ` +
      `P:${f.pressure ? '✓' : '✗'} MSE:${isStreaming ? '✓(prot)' : f.mse ? '✓' : '✗'} ` +
      `Nav:${f.navigation ? '✓' : '✗'} VT:${f.viewTransition ? '✓' : '✗'} ` +
      `LoAF:${f.loaf ? '✓' : '✗'} FR:${f.finalization ? '✓' : '✗'} ` +
      `CV:${cvStatus} ` +
      HOST
    );

    /* ─────────────────────────────────────────────
     *  §14  Cleanup on Unload
     * ───────────────────────────────────────────── */
    win.addEventListener('unload', () => {
      try {
        unifiedIO.disconnect();
        if (cvIO) cvIO.disconnect();
        mo.disconnect();
      } catch (_) {}
    }, { once: true });
  };

  /* ─────────────────────────────────────────────
   *  §15  Entry Point
   * ───────────────────────────────────────────── */
  boot().catch(err => console.error('[TO] Boot error:', err));

})();
