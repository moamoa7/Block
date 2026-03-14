// ==UserScript==
// @name         딜레이 미터기 (안정 튜닝)
// @namespace    https://github.com/moamoa7
// @version      5.16.0
// @description  최소 딜레이를 유지하면서 끊김 없이 안정적으로 배속을 조절합니다.
// @author       DelayMeter
// @match        https://play.sooplive.co.kr/*
// @match        https://chzzk.naver.com/*
// @match        https://*.chzzk.naver.com/*
// @grant        GM_addStyle
// @grant        GM_info
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /*
     *  v5.16 — "Burst" 모델
     *  ─────────────────────
     *  핵심 원칙: playbackRate는 정확히 1.0 또는 고정 BOOST값 둘 중 하나만 사용.
     *  미세 배속(1.003, 1.01 등)은 절대 쓰지 않는다.
     *
     *  1) 평소에는 항상 1.0x (네이티브 디코딩, 끊김 없음)
     *  2) 딜레이가 TRIGGER 이상이면 → BOOST 배속 ON
     *  3) 딜레이가 TARGET 이하로 내려오면 → 즉시 1.0x 복귀
     *  4) BOOST 최대 지속 시간 제한 → 너무 오래 배속하지 않음
     *  5) BOOST 후 쿨다운 → 연속 배속 전환 방지
     */

    const TUNING = {
        CHECK_INTERVAL: 500,

        // ── Burst 모델 핵심 ──
        BOOST_RATE: 1.05,             // 배속 시 사용할 고정 값 (이것만 사용)
        TRIGGER_MARGIN_MS: 500,       // target + 이 값 이상이면 BOOST 시작
        SETTLE_MARGIN_MS: 100,        // target + 이 값 이하면 BOOST 종료
        BOOST_MAX_DURATION: 15000,    // 한 번에 최대 15초까지만 배속
        BOOST_COOLDOWN: 3000,         // BOOST 종료 후 최소 3초 대기
        BOOST_MIN_DURATION: 2000,     // 최소 2초는 유지 (잦은 on/off 방지)

        // ── 기존 유지 ──
        HISTORY_SIZE: 10,
        SEEK_COOLDOWN_MS: 10000,
        SPIKE_THRESHOLD_MS: 2000,
        SPIKE_COOLDOWN_MS: 2000,
        STALL_THRESHOLD: 6,
        STALL_RECOVER_COUNT: 50,
        FRAME_CHECK_EVERY: 8,
        WARMUP_MS: 5000,
        WARMUP_MIN_BUFFER_SEC: 3.0,
        WARMUP_MIN_READY_STATE: 3,
        RATE_PROTECT_MS: 400,
        AVG_BIAS: 0.7,
        DROP_RATE_THRESHOLD: 0.03,
    };

    const IS_CHZZK = location.hostname.includes('chzzk.naver.com');
    const PLATFORM_OFFSET = IS_CHZZK ? 500 : 0;
    const RECOMMENDED_PRESETS = IS_CHZZK ? [1, 2] : [2, 3];

    const STORAGE_KEY = 'delay_meter_config_v3';
    const MAX_TARGET_MS = 8000;
    const DEFAULT_POS = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    const DASH_ON = [3, 3];
    const DASH_OFF = [];
    const SI_WARMUP = ' ⏳', SI_STOP = ' ⏹', SI_OK = ' ✓', SI_FLAT = ' →', SI_UP = ' ↑', SI_DOWN = ' ↓';
    const SI_BOOST = ' ⚡';

    function calcSeekThreshold(target) {
        return Math.max(10000, target * 3.5);
    }

    function debounce(fn, ms) {
        let timer = null;
        const wrapper = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => { timer = null; fn(...args); }, ms);
        };
        wrapper.flush = () => {
            if (timer) { clearTimeout(timer); timer = null; fn(); }
        };
        return wrapper;
    }

    let _configCache = null;

    function loadConfig() {
        if (_configCache) return _configCache;
        try { _configCache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch { _configCache = {}; }
        return _configCache;
    }

    const flushConfigToStorage = debounce(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_configCache));
    }, 300);

    function saveConfig(patch) {
        _configCache = { ...loadConfig(), ...patch };
        flushConfigToStorage();
    }

    window.addEventListener('beforeunload', () => flushConfigToStorage.flush());

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function pct(value, max) {
        return (value <= 0 ? 0 : value >= max ? 100 : (value / max * 100 + 0.5) | 0) + '%';
    }

    function lerpRGB(a, b, t) {
        return '#' + ((1 << 24)
            | (((a.r + (b.r - a.r) * t) & 0xFF) << 16)
            | (((a.g + (b.g - a.g) * t) & 0xFF) << 8)
            | ((a.b + (b.b - a.b) * t) & 0xFF)
        ).toString(16).slice(1);
    }

    const computeColor = (() => {
        const G = { r: 0x2e, g: 0xcc, b: 0x71 };
        const Y = { r: 0xf1, g: 0xc4, b: 0x0f };
        const R = { r: 0xe7, g: 0x4c, b: 0x3c };
        let lastInput = -1, lastResult = '#2ecc71';
        return (diff) => {
            if (diff <= 0) { lastInput = -1; return (lastResult = '#2ecc71'); }
            const rounded = (diff + 25) | 0;
            if (rounded === lastInput) return lastResult;
            lastInput = rounded;
            const ratio = clamp(diff / 2000, 0, 1);
            lastResult = ratio <= 0.5
                ? lerpRGB(G, Y, ratio * 2)
                : lerpRGB(Y, R, (ratio - 0.5) * 2);
            return lastResult;
        };
    })();

    function flashStyle(el, prop, value, duration = 600) {
        if (!el) return;
        el.style[prop] = value;
        setTimeout(() => { el.style[prop] = ''; }, duration);
    }

    function isBlobSrc(v) {
        const src = v.currentSrc || v.src || '';
        return src.startsWith('blob:');
    }

    const _edgeResult = { start: 0, end: 0 };

    function getBufferEdge(buf) {
        if (!buf?.length) return null;
        const last = buf.length - 1;
        _edgeResult.start = buf.start(last);
        _edgeResult.end = buf.end(last);
        return _edgeResult;
    }

    function isLiveStream(v) {
        const d = v.duration;
        if (d === Infinity || d >= 1e6) return true;
        if (!Number.isFinite(d) || d === 0) return v.buffered.length > 0;
        if (!v.buffered.length) return false;
        const bufEnd = v.buffered.end(v.buffered.length - 1);
        return d - bufEnd >= 1 && bufEnd > v.currentTime + 1;
    }

    const _hasLoadListener = new WeakSet();

    let video = null;
    let lastVideoSrc = '';
    let lastVideoIsBlob = false;
    let intervalId = null;
    let lastSetRateTime = 0;
    let lastSetRate = -1;
    let lastRateStr = '1.000x';
    let lastRenderedMediaTime = 0;
    let targetDelayMs = loadConfig().targetDelayMs ?? (IS_CHZZK ? 1500 : 2000);
    let seekThresholdMs = calcSeekThreshold(targetDelayMs);
    let isEnabled = loadConfig().isEnabled ?? true;
    let prevAvg = 0;
    let lastSeekTime = 0;
    let lastSpikeTime = 0;
    let lastPath = location.pathname;
    let tickGeneration = 0;
    let nextTickTime = 0;
    let lastDroppedFrames = 0;
    let lastTotalFrames = 0;
    let hasPlaybackQuality = false;
    let frameCheckCounter = 0;
    let lastCurrentTime = 0;
    let stallCount = 0;
    let wasPaused = false;
    let panelOpen = false;
    let skipReason = '';
    let debugVisible = false;
    let _cachedDropInfo = '';
    let hiddenAt = 0;
    let lastDotColor = '';
    let els = {};

    // ── Burst 상태 ──
    let boostActive = false;          // 현재 배속 중인가
    let boostStartTime = 0;          // 배속 시작 시각
    let boostEndTime = 0;            // 마지막 배속 종료 시각 (쿨다운 계산용)
    let effectiveRate = 1.0;         // 현재 실제 적용 중인 배속

    let lastPresentedFrames = 0;
    let estimatedFps = 30;

    let warmupStartTime = performance.now();
    let warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    let warmupDone = false;

    let seekAc = null;

    function dmLog(...args) {
        if (debugVisible) console.debug('[딜레이미터]', ...args);
    }

    class RingBuffer {
        constructor(cap, ArrayType = Float64Array) {
            this.buf = new ArrayType(cap);
            this.cap = cap;
            this.len = 0;
            this.idx = 0;
        }
        push(v) {
            this.buf[this.idx] = v;
            this.idx = (this.idx + 1) % this.cap;
            if (this.len < this.cap) this.len++;
        }
        at(i) {
            if (i < 0 || i >= this.len) return 0;
            return this.buf[((this.idx - this.len + i) % this.cap + this.cap) % this.cap];
        }
        copyTo(out) {
            const n = this.len;
            let pos = ((this.idx - n) % this.cap + this.cap) % this.cap;
            for (let i = 0; i < n; i++) {
                out[i] = this.buf[pos];
                if (++pos >= this.cap) pos = 0;
            }
            return n;
        }
        minMax() {
            if (!this.len) return [0, 0];
            let lo = Infinity, hi = -Infinity;
            let pos = ((this.idx - this.len) % this.cap + this.cap) % this.cap;
            for (let i = 0; i < this.len; i++) {
                const v = this.buf[pos];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
                if (++pos >= this.cap) pos = 0;
            }
            return [lo, hi];
        }
        get length() { return this.len; }
        get last() { return this.len ? this.buf[(this.idx - 1 + this.cap) % this.cap] : 0; }
        clear() { this.len = 0; this.idx = 0; }
    }

    let delayHistory = new RingBuffer(TUNING.HISTORY_SIZE);
    let graphHistory = null;
    const _graphBuf = new Uint16Array(60);

    function isWarmedUp() {
        if (warmupDone) return true;
        const now = performance.now();
        if (now < warmupEnd) return false;
        if (!video || video.readyState < TUNING.WARMUP_MIN_READY_STATE) return false;
        const edge = getBufferEdge(video.buffered);
        if (!edge) return false;
        const bufferedAhead = edge.end - video.currentTime;
        const minBuffer = TUNING.WARMUP_MIN_BUFFER_SEC + PLATFORM_OFFSET / 1000;
        if (bufferedAhead < minBuffer) return false;
        if (video.paused) return false;
        warmupDone = true;
        if (debugVisible) dmLog(`웜업 완료 (${(now - warmupStartTime).toFixed(0)}ms)`);
        return true;
    }

    let frameCallbackGen = 0;

    function startFrameCallback(vid) {
        if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
        const gen = ++frameCallbackGen;
        let prevTime = 0;
        const step = (now, md) => {
            if (gen !== frameCallbackGen) return;
            lastRenderedMediaTime = md.mediaTime;
            if (md.presentedFrames > lastPresentedFrames + 1 && prevTime > 0) {
                const elapsed = (now - prevTime) / 1000;
                const frames = md.presentedFrames - lastPresentedFrames;
                if (elapsed > 0) estimatedFps = Math.round(frames / elapsed);
            }
            lastPresentedFrames = md.presentedFrames;
            prevTime = now;
            vid.requestVideoFrameCallback(step);
        };
        vid.requestVideoFrameCallback(step);
    }

    function getStableAverage() {
        const n = delayHistory.length;
        if (n <= 1) return delayHistory.last;
        if (n === 2) return (delayHistory.at(0) + delayHistory.at(1)) * 0.5;
        let sum = 0, min = Infinity, max = -Infinity, wSum = 0, wTotal = 0;
        for (let i = 0; i < n; i++) {
            const v = delayHistory.at(i);
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            const w = 1 << i;
            wSum += v * w;
            wTotal += w;
        }
        const trimmed = (sum - min - max) / (n - 2);
        const weighted = wSum / wTotal;
        return trimmed > weighted
            ? trimmed * TUNING.AVG_BIAS + weighted * (1 - TUNING.AVG_BIAS)
            : weighted * TUNING.AVG_BIAS + trimmed * (1 - TUNING.AVG_BIAS);
    }

    /* ── Burst 배속 제어 ── */
    function applyRate(rate) {
        if (!video || video.paused) return;
        if (rate !== 1.0 && video.readyState < 3) return;
        const rounded = Math.round(rate * 1000) / 1000;
        if (rounded === lastSetRate) return;

        lastSetRateTime = performance.now();
        video.playbackRate = rounded;
        lastSetRate = rounded;
        effectiveRate = rounded;
        lastRateStr = rounded === 1.0 ? '1.000x' : rounded.toFixed(3) + 'x';
    }

    function startBoost(now) {
        if (boostActive) return;
        boostActive = true;
        boostStartTime = now;
        applyRate(TUNING.BOOST_RATE);
        if (debugVisible) dmLog('BOOST ON');
        if (panelOpen) flashStyle(els.delayVal, 'textShadow', '0 0 8px #f39c12', 600);
    }

    function stopBoost(now) {
        if (!boostActive) return;
        boostActive = false;
        boostEndTime = now;
        applyRate(1.0);
        if (debugVisible) dmLog(`BOOST OFF (${((now - boostStartTime) / 1000).toFixed(1)}s)`);
        if (panelOpen) flashStyle(els.delayVal, 'textShadow', '0 0 8px #2ecc71', 600);
    }

    function getAdaptiveInterval() {
        if (!isEnabled || !warmupDone) return 700;
        return TUNING.CHECK_INTERVAL;
    }

    function softReset() {
        delayHistory.clear();
        stopBoost(performance.now());
        lastSetRate = -1;
        lastRateStr = '1.000x';
    }

    function onExternalRateChange() {
        if (performance.now() - lastSetRateTime < TUNING.RATE_PROTECT_MS) return;
        if (!video) return;
        const ext = video.playbackRate;
        if (Math.abs(ext - lastSetRate) < 0.002) return;
        if (debugVisible) dmLog(`외부 배속 변경: ${ext}`);
        // 외부에서 바꿨으면 burst 상태 리셋
        if (boostActive) {
            boostActive = false;
            boostEndTime = performance.now();
        }
        effectiveRate = ext;
        lastSetRate = ext;
        lastRateStr = ext.toFixed(3) + 'x';
    }

    function checkFrameDrops() {
        if (!hasPlaybackQuality || !video) return;
        const q = video.getVideoPlaybackQuality();
        const droppedDelta = q.droppedVideoFrames - lastDroppedFrames;
        const totalDelta = q.totalVideoFrames - lastTotalFrames;
        lastDroppedFrames = q.droppedVideoFrames;
        lastTotalFrames = q.totalVideoFrames;
        if (debugVisible) _cachedDropInfo = ` d:${q.droppedVideoFrames}/${q.totalVideoFrames}`;
        if (totalDelta < 10) return;
        const dropRate = droppedDelta / totalDelta;

        // 프레임 드롭이 심하면 boost 즉시 중단
        if (dropRate > TUNING.DROP_RATE_THRESHOLD && boostActive) {
            stopBoost(performance.now());
            // 쿨다운을 길게 줘서 당분간 boost 안 함
            boostEndTime = performance.now() + 5000;
            if (debugVisible) dmLog(`프레임 드롭으로 BOOST 중단 (${(dropRate * 100).toFixed(1)}%)`);
        }
    }

    function resetState() {
        if (seekAc) { seekAc.abort(); seekAc = null; }
        lastRenderedMediaTime = 0;
        lastCurrentTime = 0;
        stallCount = 0;
        wasPaused = false;
        effectiveRate = 1.0;
        lastSetRate = -1;
        lastRateStr = '1.000x';
        lastSpikeTime = 0;
        skipReason = '';
        _cachedDropInfo = '';
        frameCheckCounter = 0;
        boostActive = false;
        boostStartTime = 0;
        boostEndTime = 0;
        delayHistory.clear();
        warmupDone = false;
        warmupStartTime = performance.now();
        warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    }

    function applyDebug() {
        if (!els.debugVal) return;
        const vis = debugVisible ? '' : 'none';
        els.debugVal.style.display = vis;
        if (graphCanvas) graphCanvas.style.display = vis;
        if (els.ver) els.ver.style.display = vis;
        if (debugVisible && !graphHistory) graphHistory = new RingBuffer(60, Uint16Array);
    }

    function attachVideo(v) {
        const src = v.currentSrc || v.src || '';
        if (video && video !== v) {
            video.removeEventListener('ratechange', onExternalRateChange);
        }
        video = v;
        lastVideoSrc = src;
        lastVideoIsBlob = isBlobSrc(v);
        resetState();
        startFrameCallback(v);
        const q = v.getVideoPlaybackQuality?.();
        if (q) {
            hasPlaybackQuality = true;
            lastDroppedFrames = q.droppedVideoFrames;
            lastTotalFrames = q.totalVideoFrames;
        } else {
            hasPlaybackQuality = false;
            lastDroppedFrames = lastTotalFrames = 0;
        }
        v.removeEventListener('ratechange', onExternalRateChange);
        v.addEventListener('ratechange', onExternalRateChange);
    }

    function onVideoFound(v) {
        if (!isBlobSrc(v)) return;
        const src = v.currentSrc || v.src || '';
        if (video === v && src === lastVideoSrc) return;
        attachVideo(v);
        if (!_hasLoadListener.has(v)) {
            _hasLoadListener.add(v);
            v.addEventListener('loadstart', () => {
                if (v !== video) return;
                const newSrc = v.currentSrc || v.src || '';
                if (newSrc !== lastVideoSrc && isBlobSrc(v)) {
                    attachVideo(v);
                }
            });
        }
    }

    let videoObserver = null;

    function setupVideoObserver() {
        if (videoObserver) return;
        videoObserver = new MutationObserver((mutations) => {
            if (video?.isConnected && isBlobSrc(video)) return;
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeName === 'VIDEO') { onVideoFound(node); return; }
                    if (node.nodeType === 1) {
                        const v = node.querySelector?.('video');
                        if (v) { onVideoFound(v); return; }
                    }
                }
            }
        });
        videoObserver.observe(document.body, { childList: true, subtree: true });
    }

    function seekToTarget(bufStart, bufEnd) {
        if (seekAc) seekAc.abort();
        const ac = seekAc = new AbortController();
        const combined = AbortSignal.any([ac.signal, AbortSignal.timeout(5000)]);
        const vid = video;
        const seekTo = Math.max(bufStart, bufEnd - targetDelayMs / 1000);
        vid.currentTime = seekTo;

        vid.addEventListener('seeked', () => {
            if (vid !== video || !vid.isConnected) { ac.abort(); return; }
            if (Math.abs(vid.currentTime - seekTo) > 2) { ac.abort(); return; }
            const correctionTimer = setTimeout(() => {
                ac.abort();
                if (vid !== video || !vid.isConnected) return;
                const edge = getBufferEdge(vid.buffered);
                if (!edge) return;
                if ((edge.end - vid.currentTime) * 1000 > targetDelayMs * 1.5) {
                    vid.currentTime = Math.max(edge.start, edge.end - targetDelayMs / 1000);
                }
            }, 50);
            combined.addEventListener('abort', () => clearTimeout(correctionTimer), { once: true });
        }, { once: true, signal: combined });
    }

    function getStatusIndicator(avg) {
        const delta = avg - prevAvg;
        prevAvg = avg;
        if (!warmupDone) return SI_WARMUP;
        if (!isEnabled) return SI_STOP;
        if (boostActive) return SI_BOOST;
        if (Math.abs(avg - targetDelayMs) < TUNING.TRIGGER_MARGIN_MS) return SI_OK;
        return Math.abs(delta) < 80 ? SI_FLAT : (delta > 0 ? SI_UP : SI_DOWN);
    }

    function flashSeekIndicator() {
        flashStyle(els.delayVal, 'textShadow', '0 0 8px #3498db', 800);
    }

    /* ── display ── */
    const displayApply = Object.create(null);
    const displayState = {};
    const dirtyChannels = new Set();

    function initDisplayApply() {
        displayApply.d     = v => { els.delayVal.textContent = v; };
        displayApply.r     = v => { els.rateVal.textContent = v; };
        displayApply.c     = v => { els.delayVal.style.color = v; els.barFill.style.background = v; };
        displayApply.w     = v => { els.barFill.style.width = v; };
        displayApply.rb    = v => { els.rateBar.style.width = v; };
        displayApply.rbc   = v => { els.rateBar.style.background = v; };
        displayApply.rc    = v => { els.rateVal.style.color = v || ''; };
        displayApply.dbg   = v => { els.debugVal.textContent = v; };
        displayApply.warn  = v => { els.panel.classList.toggle('dm-warning', v); };
    }

    function setDisplay(key, val) {
        if (displayState[key] !== val) {
            displayState[key] = val;
            dirtyChannels.add(key);
        }
    }

    let rafId = null;

    function flushDisplay() {
        if (!els.delayVal || dirtyChannels.size === 0) return;
        for (const key of dirtyChannels) {
            const fn = displayApply[key];
            if (fn) fn(displayState[key]);
        }
        dirtyChannels.clear();
    }

    let graphCanvas = null;
    let graphCtx = null;

    function drawGraph() {
        if (!graphCanvas || !graphCtx || !graphHistory) return;
        const n = graphHistory.copyTo(_graphBuf);
        if (n < 2) return;
        const w = graphCanvas.width, h = graphCanvas.height;
        graphCtx.clearRect(0, 0, w, h);

        // target line
        const targetY = h - (targetDelayMs / 8000) * h;
        graphCtx.lineWidth = 1;
        graphCtx.strokeStyle = 'rgba(255,255,255,.15)';
        graphCtx.setLineDash(DASH_ON);
        graphCtx.beginPath();
        graphCtx.moveTo(0, targetY);
        graphCtx.lineTo(w, targetY);
        graphCtx.stroke();

        // trigger line
        const triggerY = h - ((targetDelayMs + TUNING.TRIGGER_MARGIN_MS) / 8000) * h;
        graphCtx.strokeStyle = 'rgba(241,196,15,.2)';
        graphCtx.beginPath();
        graphCtx.moveTo(0, triggerY);
        graphCtx.lineTo(w, triggerY);
        graphCtx.stroke();

        graphCtx.setLineDash(DASH_OFF);
        graphCtx.fillStyle = 'rgba(255,255,255,.3)';
        graphCtx.font = '8px system-ui';
        graphCtx.fillText((targetDelayMs / 1000).toFixed(1) + 's', 2, targetY - 2);

        graphCtx.lineWidth = 1.5;
        graphCtx.strokeStyle = '#2ecc71';
        graphCtx.beginPath();
        const xScale = w / (graphHistory.cap - 1);
        for (let i = 0; i < n; i++) {
            const x = i * xScale;
            const y = h - clamp(_graphBuf[i] / 8000, 0, 1) * h;
            i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
        }
        graphCtx.stroke();
    }

    function buildDebugString(bufEnd) {
        if (!video) return 'video 탐색 중...';
        const now = performance.now();
        let s = `${video.paused ? '⏸' : '▶'} ct:${video.currentTime.toFixed(2)} buf:${bufEnd >= 0 ? bufEnd.toFixed(2) : '-'} rate:${effectiveRate.toFixed(3)}`;
        s += ` boost:${boostActive ? 'ON' : 'OFF'}`;
        if (boostActive) s += `(${((now - boostStartTime) / 1000).toFixed(1)}s)`;
        if (!boostActive && boostEndTime > 0) {
            const cd = Math.max(0, TUNING.BOOST_COOLDOWN - (now - boostEndTime));
            if (cd > 0) s += ` cd:${(cd / 1000).toFixed(1)}`;
        }
        s += ` trig:${((targetDelayMs + TUNING.TRIGGER_MARGIN_MS) / 1000).toFixed(1)} fps:${estimatedFps}`;
        const n = delayHistory.length;
        if (n >= 2) {
            const [lo, hi] = delayHistory.minMax();
            s += ` r:${(lo / 1000).toFixed(1)}-${(hi / 1000).toFixed(1)}`;
        }
        if (_cachedDropInfo) s += _cachedDropInfo;
        if (skipReason) s += ` [${skipReason}]`;
        if (!warmupDone) s += ' [WARMUP]';
        return s;
    }

    /* ── dot ── */
    function updateDot(avgMs) {
        if (panelOpen || !els.dot) return;
        const color = !isEnabled ? '#555' : computeColor(avgMs - targetDelayMs);
        if (color !== lastDotColor) {
            lastDotColor = color;
            els.dot.style.background = color;
            els.dot.style.boxShadow = isEnabled ? `0 0 6px ${color}` : 'none';
        }
        els.dot.classList.toggle('dm-dot-off', !isEnabled);
    }

    /* ── UI 갱신 ── */
    function updateDisplay(avgMs, bufEnd = -1, now = performance.now()) {
        if (!panelOpen) {
            updateDot(avgMs);
            return;
        }

        setDisplay('warn', avgMs > targetDelayMs * 2 && isEnabled);
        const statusIndicator = getStatusIndicator(avgMs);

        setDisplay('d', (avgMs / 1000).toFixed(2) + 's' + statusIndicator);
        setDisplay('r', lastRateStr);
        setDisplay('c', computeColor(avgMs - targetDelayMs));
        setDisplay('w', pct(avgMs, 8000));

        // 배속 바: boost면 100%, 아니면 0%
        if (boostActive) {
            setDisplay('rb', '100%');
            setDisplay('rbc', '#f39c12');
            setDisplay('rc', '#f39c12');
        } else {
            setDisplay('rb', '0%');
            setDisplay('rbc', '#3498db');
            setDisplay('rc', '');
        }

        if (debugVisible && els.debugVal) {
            setDisplay('dbg', buildDebugString(bufEnd));
        }

        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            flushDisplay();
            if (debugVisible) drawGraph();
        });
    }

    function updateToggleBtnUI() {
        if (!els.toggleBtn) return;
        els.toggleBtn.textContent = isEnabled ? 'ON' : 'OFF';
        els.toggleBtn.classList.toggle('dm-btn-on', isEnabled);
        els.toggleBtn.classList.toggle('dm-btn-off', !isEnabled);
        if (els.panel) els.panel.classList.toggle('dm-disabled', !isEnabled);
    }

    function updateTargetMark() {
        if (els.targetMark) els.targetMark.style.left = pct(targetDelayMs, 8000);
        if (els.seekMark) els.seekMark.style.left = pct(seekThresholdMs, 8000);
        if (els.triggerMark) els.triggerMark.style.left = pct(targetDelayMs + TUNING.TRIGGER_MARGIN_MS, 8000);
    }

    let presetBtns = [];
    function updatePresetHL() {
        for (const { btn, sec } of presetBtns) {
            btn.classList.toggle('dm-active', targetDelayMs === sec * 1000);
        }
    }

    function applyTargetDelay(sec) {
        targetDelayMs = clamp(Math.round(sec * 1000), 500, MAX_TARGET_MS);
        seekThresholdMs = calcSeekThreshold(targetDelayMs);
        softReset();
        applyRate(1.0);
        if (els.targetIn) els.targetIn.value = (targetDelayMs / 1000).toFixed(1);
        saveConfig({ targetDelayMs });
        updateTargetMark();
        updatePresetHL();
    }

    function doManualSync() {
        if (!video || !video.buffered.length) return false;
        const edge = getBufferEdge(video.buffered);
        if (!edge) return false;
        seekToTarget(edge.start, edge.end);
        softReset();
        applyRate(1.0);
        flashSeekIndicator();
        return true;
    }

    /* ── 패널 열기/닫기 ── */
    function openPanel() {
        if (panelOpen) return;
        panelOpen = true;
        saveConfig({ panelOpen: true });
        els.dot.style.display = 'none';
        els.panel.style.display = 'block';
        requestAnimationFrame(() => {
            const rect = els.panel.getBoundingClientRect();
            if (rect.left < 0) els.panel.style.left = '8px';
            if (rect.top < 0) els.panel.style.top = '8px';
            if (rect.right > innerWidth) els.panel.style.left = Math.max(0, innerWidth - rect.width - 8) + 'px';
            if (rect.bottom > innerHeight) els.panel.style.top = Math.max(0, innerHeight - rect.height - 8) + 'px';
        });
        lastDotColor = '';
        for (const key in displayState) dirtyChannels.add(key);
    }

    function closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        saveConfig({ panelOpen: false });
        const panelRect = els.panel.getBoundingClientRect();
        els.panel.style.display = 'none';
        els.dot.style.display = 'block';
        const dotX = clamp(panelRect.right - 20, 0, innerWidth - 14);
        const dotY = clamp(panelRect.top + 6, 0, innerHeight - 14);
        Object.assign(els.dot.style, { left: dotX + 'px', top: dotY + 'px', right: 'auto', bottom: 'auto' });
        saveConfig({ dotX: dotX + 'px', dotY: dotY + 'px' });
        lastDotColor = '';
    }

    function togglePanel() {
        panelOpen ? closePanel() : openPanel();
    }

    /* ── 핵심 루프 ── */
    function processLiveVideo() {
        const now = performance.now();

        if (!isWarmedUp()) {
            const edge = getBufferEdge(video.buffered);
            if (edge) {
                const delayMs = Math.max(0, (edge.end - video.currentTime) * 1000 + PLATFORM_OFFSET);
                updateDisplay(delayMs, edge.end, now);
            } else {
                updateDisplay(0, -1, now);
            }
            if (debugVisible) skipReason = 'WARMUP';
            return;
        }

        if (debugVisible) skipReason = '';
        if (++frameCheckCounter % TUNING.FRAME_CHECK_EVERY === 0) checkFrameDrops();

        const edge = getBufferEdge(video.buffered);
        if (!edge) { updateDisplay(0, -1, now); return; }
        const bufStart = edge.start, bufEnd = edge.end;

        const frameDuration = 1 / estimatedFps;
        const useMediaTime = lastRenderedMediaTime > 0
            && Math.abs(lastRenderedMediaTime - video.currentTime) < frameDuration * 3;
        const ref = useMediaTime ? lastRenderedMediaTime : video.currentTime;
        const rawDelay = (bufEnd - ref) * 1000;
        if (rawDelay < 0) { updateDisplay(0, bufEnd, now); return; }
        const delayMs = rawDelay + PLATFORM_OFFSET;

        /* 스톨 감지 */
        const ct = video.currentTime;
        if (Math.abs(ct - lastCurrentTime) < 0.001 && !video.paused) {
            stallCount++;
            if (stallCount >= TUNING.STALL_RECOVER_COUNT && isEnabled) {
                const stallEdge = getBufferEdge(video.buffered);
                if (stallEdge) {
                    video.currentTime = Math.max(stallEdge.start, stallEdge.end - targetDelayMs / 1000);
                    softReset();
                    applyRate(1.0);
                    if (debugVisible) dmLog(`스톨 복구`);
                    flashSeekIndicator();
                }
                stallCount = 0;
            }
        } else {
            stallCount = 0;
        }
        lastCurrentTime = ct;
        if (wasPaused && !video.paused) { wasPaused = false; lastSetRate = -1; }
        wasPaused = video.paused;

        /* seek 판정 */
        if (isEnabled && delayMs > seekThresholdMs && stallCount < TUNING.STALL_THRESHOLD) {
            if (now - lastSeekTime >= TUNING.SEEK_COOLDOWN_MS) {
                lastSeekTime = now;
                seekToTarget(bufStart, bufEnd);
                softReset();
                applyRate(1.0);
                flashSeekIndicator();
                updateDisplay(targetDelayMs, bufEnd, now);
                return;
            }
        }

        /* 스파이크 감지 */
        const lastDelay = delayHistory.last;
        if (lastDelay > 0
            && Math.abs(delayMs - lastDelay) > TUNING.SPIKE_THRESHOLD_MS
            && now - lastSpikeTime >= TUNING.SPIKE_COOLDOWN_MS) {
            if (debugVisible) skipReason = 'SPIKE';
            lastSpikeTime = now;
            updateDisplay(prevAvg > 0 ? prevAvg : targetDelayMs, bufEnd, now);
            return;
        }

        delayHistory.push(delayMs);
        if (debugVisible && graphHistory) graphHistory.push(delayMs);
        const avg = getStableAverage();

        updateDisplay(avg, bufEnd, now);

        /* ── 비활성화 상태 ── */
        if (!isEnabled) {
            if (boostActive) stopBoost(now);
            if (effectiveRate !== 1.0) applyRate(1.0);
            return;
        }

        /* ── Burst 배속 로직 ── */
        const triggerMs = targetDelayMs + TUNING.TRIGGER_MARGIN_MS;
        const settleMs = targetDelayMs + TUNING.SETTLE_MARGIN_MS;

        if (boostActive) {
            // BOOST 중: 종료 조건 체크
            const boostDuration = now - boostStartTime;

            // 1) 목표 근처까지 내려왔으면 종료 (최소 지속 시간 확보)
            if (avg <= settleMs && boostDuration >= TUNING.BOOST_MIN_DURATION) {
                stopBoost(now);
                return;
            }

            // 2) 최대 지속 시간 초과
            if (boostDuration >= TUNING.BOOST_MAX_DURATION) {
                stopBoost(now);
                if (debugVisible) dmLog('BOOST 최대 시간 초과로 종료');
                return;
            }

            // 3) 딜레이가 오히려 목표 이하로 너무 내려갔으면 즉시 종료
            if (avg < targetDelayMs - 200) {
                stopBoost(now);
                return;
            }

            // 그 외: boost 유지
        } else {
            // BOOST 아닌 상태: 시작 조건 체크
            const cooldownOk = (now - boostEndTime) >= TUNING.BOOST_COOLDOWN;
            const historyEnough = delayHistory.length >= 3;

            if (avg > triggerMs && cooldownOk && historyEnough) {
                // 추가 안전장치: 히스토리의 최근 3개가 모두 trigger 이상일 때만
                const recent3Ok = delayHistory.length >= 3
                    && delayHistory.at(delayHistory.length - 1) > triggerMs
                    && delayHistory.at(delayHistory.length - 2) > triggerMs
                    && delayHistory.at(delayHistory.length - 3) > triggerMs;

                if (recent3Ok) {
                    startBoost(now);
                }
            }
        }
    }

    function tick() {
        if (video && !video.isConnected) {
            video.removeEventListener('ratechange', onExternalRateChange);
            video = null;
            lastVideoIsBlob = false;
        }
        if (!video) { updateDisplay(0); return; }
        if (!lastVideoIsBlob || !isLiveStream(video)) {
            if (debugVisible) skipReason = lastVideoIsBlob ? 'VOD/AD' : 'NON-BLOB';
            if (boostActive) stopBoost(performance.now());
            if (effectiveRate !== 1.0) applyRate(1.0);
            updateDisplay(0);
            return;
        }
        processLiveVideo();
    }

    function scheduleTick() {
        const gen = tickGeneration;
        const now = performance.now();
        try { tick(); } catch (e) { console.warn('[딜레이미터]', e); }
        if (gen !== tickGeneration) return;
        if (document.hidden) {
            nextTickTime = 0;
            intervalId = setTimeout(scheduleTick, 1000);
            return;
        }
        const interval = getAdaptiveInterval();
        if (nextTickTime === 0) nextTickTime = now + interval;
        else nextTickTime += interval;
        const drift = nextTickTime - performance.now();
        if (drift < -interval * 2) nextTickTime = performance.now() + interval;
        intervalId = setTimeout(scheduleTick, Math.max(1, nextTickTime - performance.now()));
    }

    /* ── UI 생성 ── */
    function createPanel() {
        if (document.getElementById('dm-dot')) return;
        GM_addStyle(`
            @layer dm {
                #dm-dot{position:fixed;bottom:20px;right:20px;z-index:10000;
                    width:14px;height:14px;border-radius:50%;cursor:pointer;
                    background:#555;transition:background .3s,box-shadow .3s}
                @keyframes dm-dot-pulse{
                    0%,100%{transform:scale(1);opacity:.85}
                    50%{transform:scale(1.35);opacity:1}
                }
                #dm-dot:not(.dm-dot-off){animation:dm-dot-pulse 2s ease-in-out infinite}
                #dm-dot.dm-dot-off{opacity:.4}
                #dm-dot-tip{position:fixed;z-index:10001;
                    background:rgba(0,0,0,.85);color:#eee;
                    font:bold 11px ui-monospace,monospace;
                    padding:3px 7px;border-radius:4px;
                    pointer-events:none;opacity:0;transition:opacity .15s;
                    white-space:nowrap;contain:layout style}
                #dm-panel{position:fixed;bottom:20px;right:20px;z-index:10000;
                    background:rgba(12,12,16,.92);backdrop-filter:blur(3px);
                    border:1px solid rgba(255,255,255,.08);border-radius:12px;
                    padding:12px 16px;color:#eee;font-family:system-ui,sans-serif;
                    font-size:12px;width:240px;box-shadow:0 4px 16px rgba(0,0,0,.5);
                    user-select:none;contain:layout style;transition:border-color .3s ease;
                    display:none}
                #dm-panel [data-dm="header"]{position:relative;font-weight:bold;
                    border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:8px;
                    cursor:grab;display:flex;align-items:center;gap:6px}
                .dm-row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
                .dm-val{font-weight:bold;font-family:ui-monospace,monospace;font-size:15px;font-variant-numeric:tabular-nums}
                .dm-bar-bg{position:relative;background:rgba(255,255,255,.08);height:5px;
                    border-radius:3px;margin:4px 0 8px;overflow:visible}
                .dm-bar-clip{overflow:hidden;height:100%;border-radius:3px}
                .dm-bar,.dm-rate-bar{transition:width .3s ease}
                .dm-bar{height:100%;width:0%;min-width:2%;border-radius:3px}
                .dm-target-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;background:#fff;opacity:.6}
                .dm-trigger-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;background:#f1c40f;opacity:.3}
                .dm-seek-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;background:#e74c3c;opacity:.4}
                .dm-rate-bar{height:100%;width:0%;border-radius:3px;background:#3498db;
                    transition:width .3s ease,background .3s ease}
                .dm-input{width:45px;background:#1a1a1a;border:1px solid #444;color:#fff;
                    text-align:center;border-radius:4px}
                .dm-input::-webkit-inner-spin-button{display:none}
                .dm-btn{cursor:pointer;border:none;border-radius:4px;padding:3px 8px;
                    font-size:11px;font-weight:bold;transition:.1s}
                .dm-btn:active{transform:scale(.95)}
                .dm-btn-on{background:#2ecc71!important;color:#000!important}
                .dm-btn-off{background:#555!important;color:#999!important}
                #dm-panel.dm-disabled{filter:brightness(0.65)}
                .dm-controls{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
                .dm-presets{display:flex;gap:3px}
                .dm-presets .dm-btn{background:#333;color:#ccc}
                .dm-presets .dm-btn:hover{background:#444}
                .dm-presets .dm-btn.dm-active{background:#1abc9c!important;color:#000!important;
                    font-weight:bold;border-bottom-color:#fff!important}
                .dm-debug{font-size:9px;color:#666;font-family:monospace;margin-top:8px;
                    border-top:1px solid #2a2a2a;padding-top:5px;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                .dm-close{margin-left:auto;cursor:pointer;font-size:14px;opacity:.4;
                    padding:0 4px;line-height:1;transition:opacity .15s}
                .dm-close:hover{opacity:.9}
                @keyframes dm-pulse{
                    0%,100%{border-color:rgba(231,76,60,.3)}
                    50%{border-color:rgba(231,76,60,.8)}
                }
                #dm-panel.dm-warning{animation:dm-pulse 1s ease-in-out infinite}
            }
        `);

        const dot = document.createElement('div');
        dot.id = 'dm-dot';
        document.body.appendChild(dot);

        const dotTip = document.createElement('div');
        dotTip.id = 'dm-dot-tip';
        document.body.appendChild(dotTip);

        const panel = document.createElement('div');
        panel.id = 'dm-panel';
        panel.innerHTML = `
            <div data-dm="header">딜레이 미터기 <span data-dm="ver" style="font-weight:normal;font-size:10px;opacity:.5;display:none">v${GM_info.script.version}</span>
                <span class="dm-close" data-dm="close" title="닫기 (Alt+H)">✕</span>
            </div>
            <div class="dm-row"><span>버퍼</span><span data-dm="delay" class="dm-val" style="cursor:pointer" title="클릭: 동기화">-</span></div>
            <div class="dm-bar-bg">
                <div class="dm-bar-clip"><div data-dm="bar" class="dm-bar"></div></div>
                <div data-dm="targetmark" class="dm-target-mark"></div>
                <div data-dm="triggermark" class="dm-trigger-mark"></div>
                <div data-dm="seekmark" class="dm-seek-mark"></div>
            </div>
            <div class="dm-row"><span>배속</span><span data-dm="rate" class="dm-val">1.000x</span></div>
            <div class="dm-bar-bg">
                <div class="dm-bar-clip"><div data-dm="ratebar" class="dm-rate-bar"></div></div>
            </div>
            <div class="dm-row dm-controls" style="margin-top:10px">
                <button data-dm="toggle" class="dm-btn" title="ON/OFF (Alt+D)">ON</button>
                <button data-dm="sync" class="dm-btn" style="background:#2980b9;color:#fff" title="동기화 (Alt+S)">⟳</button>
                <span>목표 <input type="number" data-dm="target" class="dm-input" step="0.5" min="0.5" max="8">초</span>
                <div class="dm-presets" data-dm="presets"></div>
            </div>
            <div class="dm-debug" data-dm="debug" style="display:none"></div>`;
        document.body.appendChild(panel);

        const map = {};
        for (const el of panel.querySelectorAll('[data-dm]')) map[el.dataset.dm] = el;
        els = {
            panel, dot, dotTip,
            delayVal: map.delay, rateVal: map.rate, barFill: map.bar,
            rateBar: map.ratebar, targetMark: map.targetmark,
            triggerMark: map.triggermark, seekMark: map.seekmark,
            toggleBtn: map.toggle, syncBtn: map.sync, targetIn: map.target,
            header: map.header, debugVal: map.debug, ver: map.ver,
            closeBtn: map.close,
        };
        els.targetIn.value = (targetDelayMs / 1000).toFixed(1);

        initDisplayApply();

        dot.addEventListener('pointerenter', () => {
            if (panelOpen) return;
            dotTip.textContent = isEnabled
                ? `${(prevAvg / 1000).toFixed(1)}s → ${(targetDelayMs / 1000).toFixed(1)}s  ${lastRateStr}${boostActive ? ' ⚡' : ''}`
                : 'OFF';
            const r = dot.getBoundingClientRect();
            const tipW = dotTip.offsetWidth;
            const tipLeft = r.left - tipW - 8;
            dotTip.style.left = (tipLeft >= 0 ? tipLeft : r.right + 8) + 'px';
            dotTip.style.top = clamp(r.top + r.height / 2 - dotTip.offsetHeight / 2, 0, innerHeight - dotTip.offsetHeight) + 'px';
            dotTip.style.opacity = '1';
        });
        dot.addEventListener('pointerleave', () => {
            dotTip.style.opacity = '0';
        });

        els.closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            closePanel();
        });

        els.delayVal.onclick = () => {
            if (!doManualSync()) flashStyle(els.delayVal, 'textShadow', '0 0 8px #e74c3c', 400);
        };

        debugVisible = loadConfig().debugVisible ?? false;
        applyDebug();

        els.header.title = 'Alt+D:토글 Alt+H:닫기 Alt+↑↓:목표 Alt+S:싱크 Alt+G:디버그';

        updateToggleBtnUI();
        els.toggleBtn.onclick = () => {
            isEnabled = !isEnabled;
            if (!isEnabled) { stopBoost(performance.now()); applyRate(1.0); }
            saveConfig({ isEnabled });
            updateToggleBtnUI();
            flashStyle(els.panel, 'borderColor', isEnabled ? '#2ecc71' : '#e74c3c', 600);
        };

        els.syncBtn.onclick = () => {
            if (!doManualSync()) flashStyle(els.syncBtn, 'background', '#c0392b', 400);
        };

        updateTargetMark();
        els.targetIn.onchange = e => {
            let v = parseFloat(e.target.value);
            if (!Number.isFinite(v) || v < 0.5) v = 0.5;
            applyTargetDelay(v);
        };
        els.targetIn.addEventListener('wheel', e => {
            if (document.activeElement !== els.targetIn) return;
            e.preventDefault();
            const cur = parseFloat(els.targetIn.value) || 2;
            applyTargetDelay(Math.max(0.5, cur + (e.deltaY < 0 ? 0.5 : -0.5)));
        }, { passive: false });

        const PRESETS = [1, 2, 3, 4, 5];
        const presetBox = map.presets;
        presetBtns = PRESETS.map(sec => {
            const btn = document.createElement('button');
            btn.className = 'dm-btn';
            btn.textContent = sec + 's';
            btn.onclick = () => applyTargetDelay(sec);
            btn.oncontextmenu = e => {
                e.preventDefault();
                applyTargetDelay(sec);
                if (!doManualSync()) flashStyle(btn, 'background', '#c0392b', 400);
            };
            if (RECOMMENDED_PRESETS.includes(sec)) {
                btn.style.borderBottom = '2px solid #2ecc71';
                btn.title = '추천 (우클릭: 적용+동기화)';
            } else {
                btn.title = '우클릭: 적용+동기화';
            }
            presetBox.appendChild(btn);
            return { btn, sec };
        });
        updatePresetHL();

        const badge = document.createElement('span');
        badge.textContent = IS_CHZZK ? 'CHZZK' : 'SOOP';
        badge.style.cssText = 'font-size:9px;opacity:.4;margin-left:4px';
        presetBox.appendChild(badge);

        graphCanvas = document.createElement('canvas');
        graphCanvas.width = 208;
        graphCanvas.height = 30;
        graphCanvas.style.cssText = 'display:none;margin:6px 0 2px;border-radius:4px;background:rgba(255,255,255,.03)';
        els.debugVal.after(graphCanvas);
        graphCtx = graphCanvas.getContext('2d');

        panelOpen = loadConfig().panelOpen ?? false;
        if (panelOpen) {
            els.panel.style.display = 'block';
            els.dot.style.display = 'none';
        } else {
            els.panel.style.display = 'none';
            els.dot.style.display = 'block';
        }

        makeDraggable(panel);
        makeDotDraggable(dot);
    }

    function makeDraggable(panel) {
        const h = els.header;
        let ox = 0, oy = 0, dragging = false;
        h.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target === els.closeBtn) return;
            dragging = true;
            h.setPointerCapture(e.pointerId);
            const r = panel.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            h.style.cursor = 'grabbing';
        });
        h.addEventListener('pointermove', e => {
            if (!dragging) return;
            panel.style.left = clamp(e.clientX - ox, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(e.clientY - oy, 0, innerHeight - panel.offsetHeight) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            h.style.cursor = 'grab';
            saveConfig({ panelX: panel.style.left, panelY: panel.style.top });
        };
        h.addEventListener('pointerup', endDrag);
        h.addEventListener('lostpointercapture', endDrag);
        const s = loadConfig();
        if (s.panelX != null) {
            const x = parseFloat(s.panelX), y = parseFloat(s.panelY);
            if (x >= 0 && x < innerWidth - 50 && y >= 0 && y < innerHeight - 50) {
                Object.assign(panel.style, { left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto' });
            }
        }
    }

    function makeDotDraggable(dot) {
        let ox = 0, oy = 0, dragging = false, moved = false;
        dot.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            dragging = true;
            moved = false;
            dot.setPointerCapture(e.pointerId);
            const r = dot.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
        });
        dot.addEventListener('pointermove', e => {
            if (!dragging) return;
            moved = true;
            dot.style.left = clamp(e.clientX - ox, 0, innerWidth - 14) + 'px';
            dot.style.top = clamp(e.clientY - oy, 0, innerHeight - 14) + 'px';
            dot.style.right = 'auto';
            dot.style.bottom = 'auto';
        });
        dot.addEventListener('pointerup', () => {
            if (!dragging) return;
            dragging = false;
            if (moved) saveConfig({ dotX: dot.style.left, dotY: dot.style.top });
        });
        dot.addEventListener('click', () => {
            if (moved) { moved = false; return; }
            openPanel();
        });
        const s = loadConfig();
        if (s.dotX != null) {
            const x = parseFloat(s.dotX), y = parseFloat(s.dotY);
            if (x >= 0 && x < innerWidth - 14 && y >= 0 && y < innerHeight - 14) {
                Object.assign(dot.style, { left: s.dotX, top: s.dotY, right: 'auto', bottom: 'auto' });
            }
        }
    }

    function clampPanelPosition() {
        if (!els.panel || !els.panel.style.left) return;
        const panel = els.panel;
        const x = parseFloat(panel.style.left), y = parseFloat(panel.style.top);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const maxX = innerWidth - panel.offsetWidth, maxY = innerHeight - panel.offsetHeight;
        if (x > maxX || y > maxY || x < 0 || y < 0) {
            panel.style.left = clamp(x, 0, maxX) + 'px';
            panel.style.top = clamp(y, 0, maxY) + 'px';
        }
    }

    const SHORTCUTS = new Map([
        ['KeyD',      () => els.toggleBtn?.click()],
        ['KeyH',      () => togglePanel()],
        ['ArrowUp',   () => applyTargetDelay(Math.max(0.5, targetDelayMs / 1000 - 0.5))],
        ['ArrowDown', () => applyTargetDelay(targetDelayMs / 1000 + 0.5)],
        ['KeyT',      () => { if (els.targetIn) { els.targetIn.focus(); els.targetIn.select(); } }],
        ['KeyR',      () => { resetState(); if (video) applyRate(1.0); flashStyle(els.delayVal, 'textShadow', '0 0 8px #f39c12', 600); }],
        ['KeyS',      () => doManualSync()],
        ['KeyP',      () => {
            if (!els.panel) return;
            Object.assign(els.panel.style, DEFAULT_POS);
            saveConfig({ panelX: null, panelY: null });
        }],
        ['KeyG',      () => { debugVisible = !debugVisible; applyDebug(); saveConfig({ debugVisible }); }],
        ['KeyI',      () => {
            if (!video) return;
            const edge = getBufferEdge(video.buffered);
            const hist = [];
            for (let i = 0; i < delayHistory.length; i++) hist.push(delayHistory.at(i).toFixed(0));
            console.table({
                delay: getStableAverage().toFixed(0) + 'ms',
                rate: effectiveRate.toFixed(3),
                target: targetDelayMs,
                boost: boostActive,
                warmup: warmupDone,
                fps: estimatedFps,
                buf: edge ? edge.end.toFixed(2) : '-',
                history: hist.join(','),
                platform: IS_CHZZK ? 'CHZZK' : 'SOOP',
            });
        }],
        ['Digit1',    () => applyTargetDelay(1)],
        ['Digit2',    () => applyTargetDelay(2)],
        ['Digit3',    () => applyTargetDelay(3)],
        ['Digit4',    () => applyTargetDelay(4)],
        ['Digit5',    () => applyTargetDelay(5)],
    ]);

    function init() {
        createPanel();
        setupVideoObserver();
        document.addEventListener('play', e => {
            const v = e.target;
            if (v?.tagName === 'VIDEO') onVideoFound(v);
        }, true);
        const v = document.querySelector('video');
        if (v) onVideoFound(v);
        scheduleTick();

        if ('navigation' in window) {
            navigation.addEventListener('navigatesuccess', () => {
                if (location.pathname !== lastPath) {
                    lastPath = location.pathname;
                    resetState();
                }
            });
        } else {
            setInterval(() => {
                if (location.pathname !== lastPath) {
                    lastPath = location.pathname;
                    resetState();
                }
            }, 1000);
        }

        window.addEventListener('resize', debounce(clampPanelPosition, 150));

        document.addEventListener('fullscreenchange', () => {
            requestAnimationFrame(() => {
                if (!els.panel) return;
                if (document.fullscreenElement) {
                    Object.assign(els.panel.style, DEFAULT_POS);
                } else {
                    const s = loadConfig();
                    Object.assign(els.panel.style,
                        s.panelX != null
                            ? { left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto' }
                            : DEFAULT_POS
                    );
                    clampPanelPosition();
                }
            });
        });

        document.addEventListener('visibilitychange', () => {
            nextTickTime = 0;
            tickGeneration++;
            clearTimeout(intervalId);
            if (document.hidden) { hiddenAt = performance.now(); return; }
            const away = performance.now() - hiddenAt;
            resetState();
            if (away > 3000 && isEnabled && video?.isConnected && video.buffered.length > 0) {
                const edge = getBufferEdge(video.buffered);
                if (edge) {
                    if ((edge.end - video.currentTime) * 1000 > targetDelayMs * 1.5) {
                        seekToTarget(edge.start, edge.end);
                        flashSeekIndicator();
                        warmupDone = true;
                    }
                }
            }
            scheduleTick();
        });

        document.addEventListener('keydown', e => {
            if (!e.altKey) return;
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
            const fn = SHORTCUTS.get(e.code);
            if (fn) { e.preventDefault(); fn(); }
        });
    }

    requestAnimationFrame(init);
})();
