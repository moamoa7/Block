// ==UserScript==
// @name         딜레이 미터기 (공격적 튜닝)
// @namespace    https://github.com/moamoa7
// @version      5.11.0
// @description  최소 딜레이를 유지하기 위해 공격적으로 배속을 조절합니다.
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

    const TUNING = {
        CHECK_INTERVAL: 200,
        HISTORY_SIZE: 6,
        MAX_RATE: 1.20,
        MIN_RATE: 1.00,
        DEADZONE_MS: 150,
        SMOOTHING_UP: 0.55,
        SMOOTHING_DOWN: 0.275,
        RATE_FULL_SCALE_MS: 3000,
        RATE_CURVE_EXP: 0.6,
        SEEK_COOLDOWN_MS: 3000,
        HOLD_RATE: 1.02,
        AVG_BIAS: 0.7,
        SPIKE_THRESHOLD_MS: 2000,
        SPIKE_COOLDOWN_MS: 1000,
        STALL_THRESHOLD: 3,
        STALL_RECOVER_COUNT: 15,
        FRAME_CHECK_EVERY: 50,
        WARMUP_MS: 1500,
        WARMUP_MIN_BUFFER_SEC: 1.0,
        WARMUP_MIN_READY_STATE: 3,
        RATE_PROTECT_MS: 300,
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

    function calcSeekThreshold(target) {
        return Math.max(5000, target * 2.5);
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
            if (diff <= 0) return (lastResult = '#2ecc71');
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

    function getRateBarColor(ratio) {
        if (ratio < 0.5) return '#3498db';
        if (ratio < 0.8) return '#f39c12';
        return '#e74c3c';
    }

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
    let intervalId = null;
    let lastSetRateTime = 0;
    let currentSmoothedRate = 1.0;
    let dynamicMaxRate = TUNING.MAX_RATE;
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
    let stableTickCount = 0;
    let stableEntryTime = 0;
    let debugVisible = false;
    let _cachedDropInfo = '';
    let hiddenAt = 0;
    let lastDotColor = '';
    let els = {};

    let lastPresentedFrames = 0;
    let estimatedFps = 30;

    let warmupStartTime = performance.now();
    let warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    let warmupDone = false;

    let seekAc = null;
    let seekTimeout = null;

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

    function computeDesiredRate(avgDelayMs) {
        const error = avgDelayMs - targetDelayMs;
        if (error <= 0) return TUNING.MIN_RATE;
        if (error <= TUNING.DEADZONE_MS) {
            return TUNING.MIN_RATE + (TUNING.HOLD_RATE - TUNING.MIN_RATE) * (error / TUNING.DEADZONE_MS);
        }
        const accelError = error - TUNING.DEADZONE_MS;
        const accelRange = TUNING.RATE_FULL_SCALE_MS - TUNING.DEADZONE_MS;
        const ratio = clamp(accelError / accelRange, 0, 1);
        return TUNING.HOLD_RATE + (TUNING.MAX_RATE - TUNING.HOLD_RATE) * (ratio ** TUNING.RATE_CURVE_EXP);
    }

    function smoothRate(desired) {
        let alpha;
        if (desired > currentSmoothedRate) {
            alpha = TUNING.SMOOTHING_UP;
        } else {
            alpha = stableTickCount > 5 ? TUNING.SMOOTHING_UP : TUNING.SMOOTHING_DOWN;
        }
        currentSmoothedRate += (desired - currentSmoothedRate) * alpha;
        if (currentSmoothedRate < 1.008) currentSmoothedRate = 1.0;
        return clamp(currentSmoothedRate, TUNING.MIN_RATE, dynamicMaxRate);
    }

    function setRate(rate) {
        if (!video || video.paused) return;
        if (rate !== 1.0 && video.readyState < 3) return;
        const rounded = Math.round(rate * 1000) / 1000;
        if (rounded === lastSetRate) return;
        lastSetRateTime = performance.now();
        video.playbackRate = rounded;
        lastSetRate = rounded;
        lastRateStr = rounded.toFixed(3) + 'x';
    }

    function getAdaptiveInterval() {
        if (!isEnabled || !warmupDone) return 500;
        if (stableTickCount >= 10) return 600;
        return Math.abs(currentSmoothedRate - 1.0) < 0.005 ? 400 : TUNING.CHECK_INTERVAL;
    }

    function softReset() {
        delayHistory.clear();
        currentSmoothedRate = 1.0;
        lastSetRate = -1;
        lastRateStr = '1.000x';
        stableTickCount = 0;
        stableEntryTime = 0;
    }

    function onExternalRateChange() {
        if (performance.now() - lastSetRateTime < TUNING.RATE_PROTECT_MS) return;
        if (!video) return;
        const ext = video.playbackRate;
        if (Math.abs(ext - lastSetRate) < 0.002) return;
        if (isEnabled) {
            if (debugVisible) dmLog(`외부 배속 변경: ${ext}`);
            currentSmoothedRate = ext;
            lastSetRate = ext;
            lastRateStr = ext.toFixed(3) + 'x';
        } else {
            currentSmoothedRate = 1.0;
            lastSetRate = -1;
            lastRateStr = '1.000x';
        }
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
        const prev = dynamicMaxRate;
        if (dropRate > 0.05 && dynamicMaxRate > 1.08) {
            dynamicMaxRate = Math.max(1.08, dynamicMaxRate - 0.02);
        } else if (dropRate < 0.02 && dynamicMaxRate < TUNING.MAX_RATE) {
            dynamicMaxRate = Math.min(TUNING.MAX_RATE, dynamicMaxRate + 0.015);
        }
        if (prev !== dynamicMaxRate && debugVisible) {
            dmLog(`maxRate: ${prev.toFixed(3)} → ${dynamicMaxRate.toFixed(3)}`);
        }
    }

    function resetState() {
        if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
        if (seekAc) { seekAc.abort(); seekAc = null; }
        lastRenderedMediaTime = 0;
        lastCurrentTime = 0;
        stallCount = 0;
        wasPaused = false;
        currentSmoothedRate = 1.0;
        dynamicMaxRate = TUNING.MAX_RATE;
        lastSetRate = -1;
        lastRateStr = '1.000x';
        lastSpikeTime = 0;
        if (debugVisible) { skipReason = ''; _cachedDropInfo = ''; }
        frameCheckCounter = 0;
        stableTickCount = 0;
        stableEntryTime = 0;
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
        if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
        const ac = seekAc = new AbortController();
        const sig = ac.signal;
        const vid = video;
        const seekTo = Math.max(bufStart, bufEnd - targetDelayMs / 1000);
        vid.currentTime = seekTo;
        seekTimeout = setTimeout(() => { seekTimeout = null; ac.abort(); }, 5000);
        sig.addEventListener('abort', () => {
            if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
        }, { once: true });
        vid.addEventListener('seeked', () => {
            ac.abort();
            if (vid !== video || !vid.isConnected) return;
            if (Math.abs(vid.currentTime - seekTo) > 2) return;
            const correctionTimer = setTimeout(() => {
                if (sig.aborted || vid !== video || !vid.isConnected) return;
                const edge = getBufferEdge(vid.buffered);
                if (!edge) return;
                if ((edge.end - vid.currentTime) * 1000 > targetDelayMs * 1.5) {
                    vid.currentTime = Math.max(edge.start, edge.end - targetDelayMs / 1000);
                }
            }, 50);
            sig.addEventListener('abort', () => clearTimeout(correctionTimer), { once: true });
        }, { once: true, signal: sig });
    }

    function getStatusIndicator(avg, rate) {
        const delta = avg - prevAvg;
        prevAvg = avg;
        if (!warmupDone) return SI_WARMUP;
        if (!isEnabled) return SI_STOP;
        if (Math.abs(rate - 1.0) < 0.005 && Math.abs(avg - targetDelayMs) < TUNING.DEADZONE_MS) return SI_OK;
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
        displayApply.mx    = v => { els.maxMark.style.left = v; };
        displayApply.mxo   = v => { els.maxMark.style.opacity = v; };
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
        const targetY = h - (targetDelayMs / 8000) * h;
        graphCtx.lineWidth = 1;
        graphCtx.strokeStyle = 'rgba(255,255,255,.15)';
        graphCtx.setLineDash(DASH_ON);
        graphCtx.beginPath();
        graphCtx.moveTo(0, targetY);
        graphCtx.lineTo(w, targetY);
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
        let s = `${video.paused ? '⏸' : '▶'} ct:${video.currentTime.toFixed(2)} buf:${bufEnd >= 0 ? bufEnd.toFixed(2) : '-'} sr:${currentSmoothedRate.toFixed(3)} mx:${dynamicMaxRate.toFixed(2)} sk:${(seekThresholdMs / 1000).toFixed(1)} st:${stableTickCount} fps:${estimatedFps}`;
        if (stableEntryTime > 0) s += ` stab:${((performance.now() - stableEntryTime) / 1000).toFixed(1)}`;
        const n = delayHistory.length;
        if (n >= 2) {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < n; i++) {
                const v = delayHistory.at(i);
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            s += ` r:${(lo / 1000).toFixed(1)}-${(hi / 1000).toFixed(1)}`;
        }
        if (_cachedDropInfo) s += _cachedDropInfo;
        if (currentSmoothedRate > 1.001 && prevAvg > targetDelayMs) {
            s += ` eta:${((prevAvg - targetDelayMs) / ((currentSmoothedRate - 1) * 1000)).toFixed(0)}`;
        }
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
        if (els.dotTip) {
            els.dotTip.textContent = isEnabled
                ? `${(avgMs / 1000).toFixed(1)}s → ${(targetDelayMs / 1000).toFixed(1)}s  ${lastRateStr}`
                : 'OFF';
        }
    }

    /* ── UI 갱신 ── */
    function updateDisplay(avgMs, bufEnd = -1, now = performance.now()) {
        if (!panelOpen) {
            updateDot(avgMs);
            return;
        }

        setDisplay('warn', avgMs > targetDelayMs * 2 && isEnabled);
        const statusIndicator = getStatusIndicator(avgMs, currentSmoothedRate);

        setDisplay('d', (avgMs / 1000).toFixed(2) + 's' + statusIndicator);
        setDisplay('r', lastRateStr);
        setDisplay('c', computeColor(avgMs - targetDelayMs));
        setDisplay('w', pct(avgMs, 8000));

        const rateRatio = clamp(
            (currentSmoothedRate - TUNING.MIN_RATE) / (TUNING.MAX_RATE - TUNING.MIN_RATE), 0, 1
        );
        setDisplay('rb', Math.round(Math.sqrt(rateRatio) * 100) + '%');
        setDisplay('rbc', getRateBarColor(rateRatio));
        setDisplay('rc', currentSmoothedRate > 1.005 ? getRateBarColor(rateRatio) : '');

        if (dynamicMaxRate < TUNING.MAX_RATE) {
            const maxRatio = clamp(
                (dynamicMaxRate - TUNING.MIN_RATE) / (TUNING.MAX_RATE - TUNING.MIN_RATE), 0, 1
            );
            setDisplay('mx', Math.round(maxRatio * 100) + '%');
            setDisplay('mxo', '0.6');
        } else if (displayState.mxo !== '0') {
            setDisplay('mx', '100%');
            setDisplay('mxo', '0');
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
        els.toggleBtn.style.background = isEnabled ? '#2ecc71' : '#555';
        els.toggleBtn.style.color = isEnabled ? '#000' : '#999';
        if (els.panel) els.panel.style.filter = isEnabled ? '' : 'brightness(0.65)';
    }

    function updateTargetMark() {
        if (els.targetMark) els.targetMark.style.left = pct(targetDelayMs, 8000);
        if (els.seekMark) els.seekMark.style.left = pct(seekThresholdMs, 8000);
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
        if (warmupDone) setRate(1.0);
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
        setRate(1.0);
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
        els.panel.style.display = 'none';
        els.dot.style.display = 'block';
        requestAnimationFrame(() => {
            const rect = els.dot.getBoundingClientRect();
            if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
                Object.assign(els.dot.style, { left: '8px', top: '50%', right: 'auto', bottom: 'auto' });
                saveConfig({ dotX: '8px', dotY: '50%' });
            }
        });
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

        const ct = video.currentTime;
        if (Math.abs(ct - lastCurrentTime) < 0.001 && !video.paused) {
            stallCount++;
            if (stallCount >= TUNING.STALL_RECOVER_COUNT && isEnabled) {
                const stallEdge = getBufferEdge(video.buffered);
                if (stallEdge) {
                    video.currentTime = Math.max(stallEdge.start, stallEdge.end - targetDelayMs / 1000);
                    softReset();
                    setRate(1.0);
                    if (debugVisible) dmLog(`스톨 복구: ${stallCount}틱 정체 → bufEnd - target`);
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

        /* seek 판정 (스파이크보다 먼저 평가) */
        if (isEnabled && delayMs > seekThresholdMs && stallCount < TUNING.STALL_THRESHOLD) {
            if (now - lastSeekTime >= TUNING.SEEK_COOLDOWN_MS) {
                lastSeekTime = now;
                seekToTarget(bufStart, bufEnd);
                softReset();
                setRate(1.0);
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
            if (!isEnabled) return;
            setRate(smoothRate(computeDesiredRate(prevAvg > 0 ? prevAvg : targetDelayMs)));
            return;
        }

        delayHistory.push(delayMs);
        if (debugVisible && graphHistory) graphHistory.push(delayMs);
        const avg = isEnabled || currentSmoothedRate !== 1.0 ? getStableAverage() : delayHistory.last;

        if (Math.abs(avg - targetDelayMs) < TUNING.DEADZONE_MS) {
            if (stableTickCount === 0) {
                stableEntryTime = performance.now();
                if (panelOpen) flashStyle(els.delayVal, 'textShadow', '0 0 8px #2ecc71', 800);
            }
            stableTickCount++;
        } else {
            stableTickCount = 0;
            stableEntryTime = 0;
        }

        updateDisplay(avg, bufEnd, now);

        if (!isEnabled) {
            if (currentSmoothedRate !== 1.0) { currentSmoothedRate = 1.0; setRate(1.0); }
            return;
        }
        setRate(smoothRate(computeDesiredRate(avg)));
    }

    function tick() {
        if (video && !video.isConnected) {
            video.removeEventListener('ratechange', onExternalRateChange);
            video = null;
        }
        if (!video) { updateDisplay(0); return; }
        if (!isBlobSrc(video) || !isLiveStream(video)) {
            if (debugVisible) skipReason = isBlobSrc(video) ? 'VOD/AD' : 'NON-BLOB';
            if (currentSmoothedRate !== 1.0) { currentSmoothedRate = 1.0; setRate(1.0); }
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
                .dm-bar,.dm-rate-bar{transition:width .15s linear}
                .dm-bar{height:100%;width:0%;min-width:2%;border-radius:3px}
                .dm-target-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;background:#fff;opacity:.6}
                .dm-seek-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;background:#e74c3c;opacity:.4}
                .dm-maxrate-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease,opacity .3s ease;pointer-events:none;
                    background:#e74c3c;opacity:0}
                .dm-rate-bar{height:100%;width:0%;border-radius:3px;background:#3498db}
                .dm-input{width:45px;background:#1a1a1a;border:1px solid #444;color:#fff;
                    text-align:center;border-radius:4px}
                .dm-input::-webkit-inner-spin-button{display:none}
                .dm-btn{cursor:pointer;border:none;border-radius:4px;padding:3px 8px;
                    font-size:11px;font-weight:bold;transition:.1s}
                .dm-btn:active{transform:scale(.95)}
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

        /* dot */
        const dot = document.createElement('div');
        dot.id = 'dm-dot';
        document.body.appendChild(dot);

        /* dot tooltip */
        const dotTip = document.createElement('div');
        dotTip.id = 'dm-dot-tip';
        document.body.appendChild(dotTip);

        /* panel */
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
                <div data-dm="seekmark" class="dm-seek-mark"></div>
            </div>
            <div class="dm-row"><span>배속</span><span data-dm="rate" class="dm-val">1.000x</span></div>
            <div class="dm-bar-bg">
                <div class="dm-bar-clip"><div data-dm="ratebar" class="dm-rate-bar"></div></div>
                <div data-dm="maxmark" class="dm-maxrate-mark"></div>
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
            rateBar: map.ratebar, targetMark: map.targetmark, seekMark: map.seekmark,
            maxMark: map.maxmark,
            toggleBtn: map.toggle, syncBtn: map.sync, targetIn: map.target,
            header: map.header, debugVal: map.debug, ver: map.ver,
            closeBtn: map.close,
        };
        els.targetIn.value = (targetDelayMs / 1000).toFixed(1);

        initDisplayApply();

        /* dot 클릭 → 패널 열기 (드래그 통합) */
        // openPanel은 makeDotDraggable 내부에서 호출

        /* dot tooltip */
        dot.addEventListener('pointerenter', () => {
            if (panelOpen) return;
            const r = dot.getBoundingClientRect();
            dotTip.style.left = (r.left - dotTip.offsetWidth - 8) + 'px';
            dotTip.style.top = (r.top + r.height / 2 - dotTip.offsetHeight / 2) + 'px';
            dotTip.style.opacity = '1';
        });
        dot.addEventListener('pointerleave', () => {
            dotTip.style.opacity = '0';
        });

        /* ✕ 클릭 → 패널 닫기 */
        els.closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            closePanel();
        });

        /* 딜레이 클릭 → sync */
        els.delayVal.onclick = () => {
            if (!doManualSync()) flashStyle(els.delayVal, 'textShadow', '0 0 8px #e74c3c', 400);
        };

        /* 디버그 */
        debugVisible = loadConfig().debugVisible ?? false;
        applyDebug();

        els.header.title = 'Alt+D:토글 Alt+H:닫기 Alt+↑↓:목표 Alt+S:싱크 Alt+G:디버그';

        updateToggleBtnUI();
        els.toggleBtn.onclick = () => {
            isEnabled = !isEnabled;
            if (isEnabled) { currentSmoothedRate = TUNING.HOLD_RATE; lastSetRate = -1; }
            else { currentSmoothedRate = 1.0; setRate(1.0); }
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

        /* 초기 상태: 저장값 복원 */
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
        ['KeyR',      () => { resetState(); if (video) setRate(1.0); flashStyle(els.delayVal, 'textShadow', '0 0 8px #f39c12', 600); }],
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
                rate: currentSmoothedRate.toFixed(3),
                target: targetDelayMs,
                maxRate: dynamicMaxRate.toFixed(3),
                stable: stableTickCount,
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

        /* Navigation API로 SPA URL 변경 감지 */
        if ('navigation' in window) {
            navigation.addEventListener('navigatesuccess', () => {
                if (location.pathname !== lastPath) {
                    lastPath = location.pathname;
                    resetState();
                }
            });
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
