// ==UserScript==
// @name         딜레이 미터기 (공격적 튜닝)
// @namespace    https://github.com/moamoa7
// @version      5.9.3
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
        FRAME_CHECK_EVERY: 50,
        WARMUP_MS: 1500,
        WARMUP_MIN_BUFFER_SEC: 1.0,
        WARMUP_MIN_READY_STATE: 3,
    };

    const IS_CHZZK = location.hostname.includes('chzzk.naver.com');
    const PLATFORM_OFFSET = IS_CHZZK ? 500 : 0;
    const RECOMMENDED_PRESETS = IS_CHZZK ? [1, 2] : [2, 3];

    const STORAGE_KEY = 'delay_meter_config_v3';
    const MAX_TARGET_MS = 8000;
    const DEFAULT_POS = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    const COLLAPSED_KEYS = new Set(['mini', 'mc', 'mb', 'mbd', 'title']);
    const DASH_ON = [3, 3];
    const DASH_OFF = [];
    const SI_WARMUP = ' ⏳', SI_STOP = ' ⏹', SI_OK = ' ✓', SI_FLAT = ' →', SI_UP = ' ↑', SI_DOWN = ' ↓';

    /* ── seek 임계값: 고정 5초 (안정성 확보) ── */
    function calcSeekThreshold(target) {
        return Math.max(5000, target * 2.5);
    }

    /* ── debounce ── */
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

    /* ── 설정 ── */
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

    /* ── 유틸 ── */
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function pct(value, max) {
        return (value <= 0 ? 0 : value >= max ? 100 : (value / max * 100 + 0.5) | 0) + '%';
    }

    function lerpRGB(a, b, t) {
        const r = (a.r + (b.r - a.r) * t) | 0;
        const g = (a.g + (b.g - a.g) * t) | 0;
        const bl = (a.b + (b.b - a.b) * t) | 0;
        return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
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

    /* ── blob URL 판별 ── */
    function isBlobSrc(v) {
        const src = v.currentSrc || v.src || '';
        return src.startsWith('blob:');
    }

    /* ── buffered 안전 접근 ── */
    const _edgeResult = { start: 0, end: 0 };

    function getBufferEdge(buf) {
        if (!buf?.length) return null;
        const last = buf.length - 1;
        _edgeResult.start = buf.start(last);
        _edgeResult.end = buf.end(last);
        return _edgeResult;
    }

    /* ── 라이브 판별 ── */
    function isLiveStream(v) {
        const d = v.duration;
        if (d === Infinity || d >= 1e6) return true;
        if (!Number.isFinite(d) || d === 0) return v.buffered.length > 0;
        if (!v.buffered.length) return false;
        const bufEnd = v.buffered.end(v.buffered.length - 1);
        return d - bufEnd >= 1 && bufEnd > v.currentTime + 1;
    }

    /* ── video src 관찰 WeakSet ── */
    const _observed = new WeakSet();

    /* ── 상태 ── */
    let video = null;
    let lastVideoSrc = '';
    let lastVideoIsBlob = false;
    let intervalId = null;
    let isSettingRate = false;
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
    let collapsed = false;
    let skipReason = '';
    let rateProtectTimer = null;
    let stableTickCount = 0;
    let stableEntryTime = 0;
    let debugVisible = false;
    let _cachedDropInfo = '';
    let hiddenAt = 0;
    let els = {};

    /* ── rVFC 확장: FPS 추정 ── */
    let lastPresentedFrames = 0;
    let estimatedFps = 30;

    /* ── 웜업 상태 ── */
    let warmupStartTime = performance.now();
    let warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    let warmupDone = false;

    /* ── seek AbortController ── */
    let seekAc = null;
    let seekTimeout = null;

    /* ── 디버그 로거 ── */
    function dmLog(...args) {
        if (debugVisible) console.debug('[딜레이미터]', ...args);
    }

    /* ── 링 버퍼 ── */
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

    /* ── 웜업 판별 ── */
    function isWarmedUp() {
        if (warmupDone) return true;
        const now = performance.now();
        if (now < warmupEnd) return false;
        if (!video || video.readyState < TUNING.WARMUP_MIN_READY_STATE) return false;
        const edge = getBufferEdge(video.buffered);
        if (!edge) return false;
        const bufferedAhead = edge.end - video.currentTime;
        if (bufferedAhead < TUNING.WARMUP_MIN_BUFFER_SEC) return false;
        if (video.paused) return false;
        warmupDone = true;
        if (debugVisible) dmLog(`웜업 완료 (${(now - warmupStartTime).toFixed(0)}ms, buf:${bufferedAhead.toFixed(2)}s, readyState:${video.readyState})`);
        return true;
    }

    /* ── 프레임 콜백 (rVFC + FPS 추정) ── */
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

    /* ── 평균 (단일 패스) ── */
    function getStableAverage() {
        const n = delayHistory.length;
        if (n === 0) return 0;
        if (n === 1) return delayHistory.last;
        if (n === 2) return (delayHistory.at(0) + delayHistory.at(1)) * 0.5;

        const buf = delayHistory.buf;
        const cap = delayHistory.cap;
        let pos = ((delayHistory.idx - n) % cap + cap) % cap;

        let sum = 0, min = Infinity, max = -Infinity;
        let wSum = 0, wTotal = 0;
        for (let i = 0; i < n; i++) {
            const v = buf[pos];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            const w = 1 << i;
            wSum += v * w;
            wTotal += w;
            if (++pos >= cap) pos = 0;
        }
        const trimmed = (sum - min - max) / (n - 2);
        const weighted = wSum / wTotal;
        const bigger = Math.max(trimmed, weighted);
        const smaller = Math.min(trimmed, weighted);
        return bigger * TUNING.AVG_BIAS + smaller * (1 - TUNING.AVG_BIAS);
    }

    /* ── 배속 ── */
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
        const alpha = desired > currentSmoothedRate ? TUNING.SMOOTHING_UP : TUNING.SMOOTHING_DOWN;
        currentSmoothedRate += (desired - currentSmoothedRate) * alpha;
        if (currentSmoothedRate < 1.008) currentSmoothedRate = 1.0;
        return clamp(currentSmoothedRate, TUNING.MIN_RATE, dynamicMaxRate);
    }

    function setRate(rate) {
        if (!video || video.paused) return;
        if (rate !== 1.0 && video.readyState < 3) return;
        const rounded = Math.round(rate * 1000) / 1000;
        if (rounded === lastSetRate) return;
        try {
            isSettingRate = true;
            lastSetRateTime = performance.now();
            video.playbackRate = rounded;
            lastSetRate = rounded;
            lastRateStr = rounded.toFixed(3) + 'x';
        } catch {
            lastSetRate = -1;
        } finally {
            isSettingRate = false;
        }
    }

    function getAdaptiveInterval() {
        if (!isEnabled || !warmupDone) return 500;
        if (stableTickCount >= 10) return 600;
        return Math.abs(currentSmoothedRate - 1.0) < 0.005 ? 400 : TUNING.CHECK_INTERVAL;
    }

    /* ── soft reset ── */
    function softReset() {
        delayHistory.clear();
        currentSmoothedRate = 1.0;
        lastSetRate = -1;
        lastRateStr = '1.000x';
        stableTickCount = 0;
        stableEntryTime = 0;
        clearTimeout(rateProtectTimer);
        rateProtectTimer = null;
    }

    /* ── 외부 배속 변경 감지 ── */
    function onExternalRateChange() {
        if (isSettingRate || performance.now() - lastSetRateTime < 100) return;
        if (!video) return;
        const ext = video.playbackRate;
        if (Math.abs(ext - lastSetRate) < 0.002) return;
        if (isEnabled) {
            if (debugVisible) dmLog(`외부 배속 변경 감지: ${ext}, 복원 대기`);
            clearTimeout(rateProtectTimer);
            const vid = video;
            rateProtectTimer = setTimeout(() => {
                if (video !== vid || !isEnabled) return;
                lastSetRate = -1;
                const avg = getStableAverage();
                if (avg > 0) {
                    currentSmoothedRate = computeDesiredRate(avg);
                    setRate(currentSmoothedRate);
                }
            }, 200);
        } else {
            currentSmoothedRate = 1.0;
            lastSetRate = -1;
            lastRateStr = '1.000x';
        }
    }

    /* ── 프레임 드롭 ── */
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
        if (prev !== dynamicMaxRate) {
            if (debugVisible) dmLog(`maxRate: ${prev.toFixed(3)} → ${dynamicMaxRate.toFixed(3)} (drop: ${(dropRate * 100).toFixed(1)}%)`);
        }
    }

    /* ── 상태 리셋 ── */
    function resetState() {
        clearTimeout(rateProtectTimer);
        rateProtectTimer = null;
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

    /* ── 디버그 표시 토글 ── */
    function applyDebug() {
        if (!els.debugVal) return;
        const vis = debugVisible ? '' : 'none';
        els.debugVal.style.display = vis;
        if (graphCanvas) graphCanvas.style.display = vis;
        if (els.ver) els.ver.style.display = vis;
        if (debugVisible && !graphHistory) graphHistory = new RingBuffer(60, Uint16Array);
    }

    /* ── video 관리 ── */
    function onVideoFound(v) {
        if (!isBlobSrc(v)) return;
        const src = v.currentSrc || v.src || '';
        if (video === v && src === lastVideoSrc) return;

        if (video && video !== v) {
            video.removeEventListener('ratechange', onExternalRateChange);
        }
        video = v;
        lastVideoSrc = src;
        lastVideoIsBlob = true;
        resetState();
        startFrameCallback(video);
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

        if (!_observed.has(v)) {
            _observed.add(v);
            v.addEventListener('loadstart', () => {
                if (v === video) {
                    const newSrc = v.currentSrc || v.src || '';
                    if (newSrc !== lastVideoSrc && isBlobSrc(v)) {
                        if (debugVisible) dmLog(`src 변경 감지: ${newSrc.slice(0, 40)}...`);
                        lastVideoSrc = newSrc;
                        lastVideoIsBlob = true;
                        resetState();
                        startFrameCallback(v);
                    }
                }
            });
        }
        if (debugVisible) dmLog(`video 발견 (blob src: ${src.slice(0, 40)}...)`);
    }

    function checkUrlChange() {
        const cur = location.pathname;
        if (cur === lastPath) return;
        lastPath = cur;
        resetState();
    }

    /* ── MutationObserver video 탐색 ── */
    let videoObserver = null;

    function setupVideoObserver() {
        if (videoObserver) return;
        videoObserver = new MutationObserver((mutations) => {
            if (video?.isConnected && isBlobSrc(video)) return;
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeName === 'VIDEO') {
                        onVideoFound(node);
                        return;
                    }
                    if (node.nodeType === 1) {
                        const v = node.querySelector?.('video');
                        if (v) { onVideoFound(v); return; }
                    }
                }
            }
        });
        videoObserver.observe(document.body, { childList: true, subtree: true });
    }

    /* ── seekToTarget ── */
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
            setTimeout(() => {
                if (vid !== video || !vid.isConnected) return;
                const edge = getBufferEdge(vid.buffered);
                if (!edge) return;
                if ((edge.end - vid.currentTime) * 1000 > targetDelayMs * 1.5) {
                    vid.currentTime = Math.max(edge.start, edge.end - targetDelayMs / 1000);
                }
            }, 50);
        }, { once: true, signal: sig });
    }

    /* ── 상태 표시 ── */
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

    function flashToggleState() {
        if (!els.mini) return;
        setDisplay('mini', isEnabled ? 'ON' : 'OFF');
        setDisplay('mc', isEnabled ? '#2ecc71' : '#e74c3c');
        if (!rafId) {
            rafId = requestAnimationFrame(() => { rafId = null; flushDisplay(); });
        }
    }

    /* ── dirty 플래그 기반 display ── */
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
        displayApply.mini  = v => { els.mini.textContent = v; };
        displayApply.mc    = v => { els.mini.style.color = v || ''; };
        displayApply.mb    = v => { els.miniBar.style.background = v; };
        displayApply.mbd   = v => { els.miniBar.style.display = v; };
        displayApply.dbg   = v => { els.debugVal.textContent = v; };
        displayApply.title = v => { els.panel.title = v; };
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
        if (collapsed) {
            for (const key of dirtyChannels) {
                if (COLLAPSED_KEYS.has(key)) {
                    displayApply[key](displayState[key]);
                }
            }
        } else {
            for (const key of dirtyChannels) {
                const fn = displayApply[key];
                if (fn) fn(displayState[key]);
            }
        }
        dirtyChannels.clear();
    }

    /* ── 미니 그래프 ── */
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

    /* ── 디버그 문자열 ── */
    function buildDebugString(bufEnd) {
        if (!video) return 'video 탐색 중...';
        const parts = [
            video.paused ? '⏸' : '▶',
            ' ct:', video.currentTime.toFixed(2),
            ' buf:', bufEnd >= 0 ? bufEnd.toFixed(2) : '-',
            ' sr:', currentSmoothedRate.toFixed(3),
            ' mx:', dynamicMaxRate.toFixed(2),
            ' sk:', (seekThresholdMs / 1000).toFixed(1),
            ' st:', stableTickCount,
            ' fps:', estimatedFps
        ];
        if (stableEntryTime > 0) parts.push(' stab:', ((performance.now() - stableEntryTime) / 1000).toFixed(1));
        const n = delayHistory.length;
        if (n >= 2) {
            const buf = delayHistory.buf, cap = delayHistory.cap;
            let pos = ((delayHistory.idx - n) % cap + cap) % cap, lo = Infinity, hi = -Infinity;
            for (let i = 0; i < n; i++) {
                const v = buf[pos]; if (v < lo) lo = v; if (v > hi) hi = v;
                if (++pos >= cap) pos = 0;
            }
            parts.push(' r:', (lo / 1000).toFixed(1), '-', (hi / 1000).toFixed(1));
        }
        if (_cachedDropInfo) parts.push(_cachedDropInfo);
        if (currentSmoothedRate > 1.001 && prevAvg > targetDelayMs) {
            parts.push(' eta:', ((prevAvg - targetDelayMs) / ((currentSmoothedRate - 1) * 1000)).toFixed(0));
        }
        if (skipReason) parts.push(' [', skipReason, ']');
        if (!warmupDone) parts.push(' [WARMUP]');
        return parts.join('');
    }

    /* ── UI 갱신 ── */
    function updateDisplay(avgMs, bufEnd = -1, now = performance.now()) {
        /* 경고 펄스 */
        setDisplay('warn', avgMs > targetDelayMs * 2 && isEnabled);

        if (collapsed) {
            const delta = avgMs - prevAvg;
            prevAvg = avgMs;
            const color = computeColor(avgMs - targetDelayMs);
            const sec = avgMs / 1000;
            const miniStatus = warmupDone ? (Math.abs(delta) > 80 ? (delta > 0 ? '↑' : '↓') : '') : '⏳';
            const miniRate = currentSmoothedRate > 1.005 ? (' ' + lastRateStr) : '';
            const stabInfo = stableTickCount > 0 ? ` | 안정 ${((performance.now() - stableEntryTime) / 1000).toFixed(0)}s` : '';
            setDisplay('mini', sec.toFixed(1) + 's' + miniStatus + miniRate);
            setDisplay('mc', color);
            setDisplay('mb', color);
            setDisplay('mbd', 'block');
            setDisplay('title', `딜레이: ${sec.toFixed(2)}s | 배속: ${lastRateStr} | 목표: ${(targetDelayMs / 1000).toFixed(1)}s${stabInfo}`);
            if (rafId) return;
            rafId = requestAnimationFrame(() => { rafId = null; flushDisplay(); });
            return;
        }

        const statusIndicator = getStatusIndicator(avgMs, currentSmoothedRate);

        setDisplay('mini', '');
        setDisplay('mbd', 'none');

        setDisplay('d', (avgMs / 1000).toFixed(2) + 's' + statusIndicator);
        setDisplay('r', lastRateStr);
        setDisplay('c', computeColor(avgMs - targetDelayMs));
        setDisplay('w', pct(avgMs, 8000));

        const rateRatio = clamp(
            (currentSmoothedRate - TUNING.MIN_RATE) / (TUNING.MAX_RATE - TUNING.MIN_RATE), 0, 1
        );
        const rateDisplay = Math.round(Math.sqrt(rateRatio) * 100);
        const barColor = getRateBarColor(rateRatio);
        setDisplay('rb', rateDisplay + '%');
        setDisplay('rbc', barColor);
        setDisplay('rc', currentSmoothedRate > 1.005 ? barColor : '');

        /* maxRate 마크 */
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

    /* ── UI 헬퍼 ── */
    function updateToggleBtnUI() {
        if (!els.toggleBtn) return;
        const on = isEnabled;
        els.toggleBtn.textContent = on ? 'ON' : 'OFF';
        els.toggleBtn.style.background = on ? '#2ecc71' : '#555';
        els.toggleBtn.style.color = on ? '#000' : '#999';
        if (els.panel) els.panel.style.filter = on ? '' : 'brightness(0.65)';
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

    /* ── 수동 seek ── */
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

    /* ── 핵심 루프 ── */
    function processLiveVideo() {
        const now = performance.now();

        if (!isWarmedUp()) {
            const edge = getBufferEdge(video.buffered);
            if (edge) {
                const rawDelay = (edge.end - video.currentTime) * 1000;
                const delayMs = Math.max(0, rawDelay + PLATFORM_OFFSET);
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

        const useMediaTime = lastRenderedMediaTime > 0
            && Math.abs(lastRenderedMediaTime - video.currentTime) < 1.0;
        const ref = useMediaTime ? lastRenderedMediaTime : video.currentTime;

        const rawDelay = (bufEnd - ref) * 1000;
        if (rawDelay < 0) { updateDisplay(0, bufEnd, now); return; }
        const delayMs = rawDelay + PLATFORM_OFFSET;

        const ct = video.currentTime;
        if (Math.abs(ct - lastCurrentTime) < 0.001 && !video.paused) stallCount++;
        else stallCount = 0;
        lastCurrentTime = ct;
        if (wasPaused && !video.paused) { wasPaused = false; lastSetRate = -1; }
        wasPaused = video.paused;

        /* spike 필터 (seek 판정보다 선행) */
        const lastDelay = delayHistory.last;
        if (lastDelay > 0
            && Math.abs(delayMs - lastDelay) > TUNING.SPIKE_THRESHOLD_MS
            && now - lastSpikeTime >= TUNING.SPIKE_COOLDOWN_MS) {
            if (debugVisible) skipReason = 'SPIKE';
            lastSpikeTime = now;
            softReset();
            updateDisplay(prevAvg > 0 ? prevAvg : targetDelayMs, bufEnd, now);
            return;
        }

        /* seek 판정 */
        if (isEnabled && delayMs > seekThresholdMs && stallCount < TUNING.STALL_THRESHOLD) {
            if (now - lastSeekTime >= TUNING.SEEK_COOLDOWN_MS) {
                lastSeekTime = now;
                if (debugVisible) dmLog(`SEEK: ${delayMs.toFixed(0)}ms ct:${ct.toFixed(2)}→${Math.max(bufStart, bufEnd - targetDelayMs / 1000).toFixed(2)}`);
                seekToTarget(bufStart, bufEnd);
                softReset();
                setRate(1.0);
                flashSeekIndicator();
                updateDisplay(targetDelayMs, bufEnd, now);
                return;
            }
        }

        delayHistory.push(delayMs);
        if (debugVisible && graphHistory) graphHistory.push(delayMs);
        const avg = isEnabled || currentSmoothedRate !== 1.0 ? getStableAverage() : delayHistory.last;

        if (Math.abs(avg - targetDelayMs) < TUNING.DEADZONE_MS) {
            if (stableTickCount === 0) {
                stableEntryTime = performance.now();
                flashStyle(els.delayVal, 'textShadow', '0 0 8px #2ecc71', 800);
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
        checkUrlChange();
        if (video && !video.isConnected) {
            video.removeEventListener('ratechange', onExternalRateChange);
            video = null;
            lastVideoIsBlob = false;
        }

        if (!video) {
            updateDisplay(0);
            return;
        }

        if (!lastVideoIsBlob || !isLiveStream(video)) {
            if (debugVisible) skipReason = lastVideoIsBlob ? 'VOD/AD' : 'NON-BLOB';
            if (currentSmoothedRate !== 1.0) { currentSmoothedRate = 1.0; setRate(1.0); }
            updateDisplay(0);
            return;
        }

        processLiveVideo();
    }

    /* ── drift 보정 스케줄러 ── */
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
        if (nextTickTime === 0) {
            nextTickTime = now + interval;
        } else {
            nextTickTime += interval;
        }

        const drift = nextTickTime - performance.now();
        if (drift < -interval * 2) {
            nextTickTime = performance.now() + interval;
        }
        intervalId = setTimeout(scheduleTick, Math.max(1, nextTickTime - performance.now()));
    }

    /* ── UI 생성 ── */
    function createPanel() {
        if (document.getElementById('dm-panel')) return;
        GM_addStyle(`
            @layer dm {
                #dm-panel{position:fixed;bottom:20px;right:20px;z-index:10000;
                    background:rgba(12,12,16,.92);backdrop-filter:blur(3px);
                    border:1px solid rgba(255,255,255,.08);border-radius:12px;
                    padding:12px 16px;color:#eee;font-family:system-ui,sans-serif;
                    font-size:12px;min-width:210px;box-shadow:0 4px 16px rgba(0,0,0,.5);
                    user-select:none;contain:layout style;transition:border-color .3s ease}
                #dm-panel.dm-collapsed{padding:6px 10px;min-width:0;border-radius:8px}
                #dm-panel.dm-collapsed [data-dm="header"]{border-bottom:none;padding-bottom:0;margin-bottom:0}
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
                    border-radius:1px;transition:left .3s ease;pointer-events:none;
                    background:#fff;opacity:.6}
                .dm-seek-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease;pointer-events:none;
                    background:#e74c3c;opacity:.4}
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
                .dm-presets .dm-btn.dm-active{background:#1abc9c!important;color:#000!important;font-weight:bold;border-bottom-color:#fff!important}
                .dm-debug{font-size:9px;color:#666;font-family:monospace;margin-top:8px;
                    border-top:1px solid #2a2a2a;padding-top:5px;overflow-wrap:break-word;word-break:normal;
                    max-height:60px;overflow-y:auto}
                .dm-minibar{position:absolute;bottom:0;left:0;right:0;height:2px;
                    border-radius:0 0 11px 11px;display:none}
                @keyframes dm-pulse{
                    0%,100%{border-color:rgba(231,76,60,.3)}
                    50%{border-color:rgba(231,76,60,.8)}
                }
                #dm-panel.dm-warning{animation:dm-pulse 1s ease-in-out infinite}
            }
        `);

        const panel = document.createElement('div');
        panel.id = 'dm-panel';
        panel.innerHTML = `
            <div data-dm="header">딜레이 미터기 <span data-dm="ver" style="font-weight:normal;font-size:10px;opacity:.5;display:none">v${GM_info.script.version}</span>
                <span data-dm="mini" style="font-size:12px;font-family:ui-monospace,monospace;font-weight:normal"></span>
                <span data-dm="collapse" style="margin-left:auto;cursor:pointer;font-size:10px">▼</span>
                <div data-dm="minibar" class="dm-minibar"></div>
            </div>
            <div class="dm-body">
                <div class="dm-row"><span>버퍼</span><span data-dm="delay" class="dm-val" style="cursor:pointer" title="클릭하여 동기화">-</span></div>
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
                    <button data-dm="toggle" class="dm-btn" title="배속 조절 ON/OFF (Alt+D)">ON</button>
                    <button data-dm="sync" class="dm-btn" style="background:#2980b9;color:#fff" title="수동 동기화 (Alt+S)">⟳</button>
                    <span>목표 <input type="number" data-dm="target" class="dm-input" step="0.5" min="0.5" max="8">초</span>
                    <div class="dm-presets" data-dm="presets"></div>
                </div>
                <div class="dm-debug" data-dm="debug"></div>
            </div>`;
        document.body.appendChild(panel);

        const map = {};
        for (const el of panel.querySelectorAll('[data-dm]')) map[el.dataset.dm] = el;
        els = {
            panel: panel,
            delayVal: map.delay, rateVal: map.rate, barFill: map.bar,
            rateBar: map.ratebar, targetMark: map.targetmark, seekMark: map.seekmark,
            maxMark: map.maxmark,
            toggleBtn: map.toggle, syncBtn: map.sync, targetIn: map.target,
            header: map.header, debugVal: map.debug, mini: map.mini,
            ver: map.ver, collapseBtn: map.collapse, miniBar: map.minibar,
        };
        els.targetIn.value = (targetDelayMs / 1000).toFixed(1);

        initDisplayApply();

        /* ── 딜레이 값 클릭 SYNC ── */
        els.delayVal.onclick = () => {
            if (!doManualSync()) {
                flashStyle(els.delayVal, 'textShadow', '0 0 8px #e74c3c', 400);
            }
        };

        /* ── collapsed mini 클릭 SYNC ── */
        els.mini.onclick = () => {
            if (collapsed && !doManualSync()) {
                flashStyle(els.mini, 'textShadow', '0 0 8px #e74c3c', 400);
            }
        };

        /* ── 접기/펼치기 ── */
        const body = panel.querySelector('.dm-body');
        collapsed = loadConfig().collapsed ?? false;
        const applyCollapse = () => {
            body.style.display = collapsed ? 'none' : '';
            els.collapseBtn.textContent = collapsed ? '▶' : '▼';
            panel.classList.toggle('dm-collapsed', collapsed);
        };
        applyCollapse();
        els.collapseBtn.onclick = e => {
            e.stopPropagation(); collapsed = !collapsed;
            applyCollapse(); saveConfig({ collapsed });
            if (!collapsed) {
                setDisplay('mc', '');
                setDisplay('mbd', 'none');
                for (const key in displayState) {
                    if (key[0] !== '_') dirtyChannels.add(key);
                }
            }
        };

        /* ── 디버그 토글 ── */
        debugVisible = loadConfig().debugVisible ?? false;
        applyDebug();
        els.header.addEventListener('dblclick', () => {
            debugVisible = !debugVisible; applyDebug(); saveConfig({ debugVisible });
        });

        /* ── 헤더 단축키 tooltip ── */
        els.header.title = 'Alt+D:토글 Alt+↑↓:목표 Alt+T:목표입력 Alt+R:리셋 Alt+C:접기 Alt+S:싱크 Alt+P:위치초기화 Alt+G:디버그 Alt+I:스냅샷';

        /* ── ON/OFF ── */
        updateToggleBtnUI();
        els.toggleBtn.onclick = () => {
            isEnabled = !isEnabled;
            if (isEnabled) {
                currentSmoothedRate = TUNING.HOLD_RATE;
                lastSetRate = -1;
            } else {
                currentSmoothedRate = 1.0;
                setRate(1.0);
            }
            saveConfig({ isEnabled }); updateToggleBtnUI();
            flashToggleState();
        };

        /* ── SYNC 버튼 ── */
        els.syncBtn.onclick = () => {
            if (!doManualSync()) {
                flashStyle(els.syncBtn, 'background', '#c0392b', 400);
            }
        };

        /* ── 목표 딜레이 입력 ── */
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

        /* ── 프리셋 ── */
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
                btn.title = '이 플랫폼 추천 (우클릭: 적용+동기화)';
            } else {
                btn.title = '우클릭: 적용+동기화';
            }
            presetBox.appendChild(btn);
            return { btn, sec };
        });
        updatePresetHL();

        /* ── 플랫폼 뱃지 ── */
        const badge = document.createElement('span');
        badge.textContent = IS_CHZZK ? 'CHZZK' : 'SOOP';
        badge.style.cssText = 'font-size:9px;opacity:.4;margin-left:4px';
        presetBox.appendChild(badge);

        /* ── 미니 그래프 캔버스 ── */
        graphCanvas = document.createElement('canvas');
        graphCanvas.width = 180;
        graphCanvas.height = 30;
        graphCanvas.style.cssText = 'display:none;margin:6px 0 2px;border-radius:4px;background:rgba(255,255,255,.03)';
        els.debugVal.after(graphCanvas);
        graphCtx = graphCanvas.getContext('2d');
        if (debugVisible) graphCanvas.style.display = '';

        /* ── 드래그 ── */
        makeDraggable(panel);
    }

    function makeDraggable(panel) {
        const h = els.header;
        let ox = 0, oy = 0, dragging = false;

        h.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
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
                Object.assign(panel.style, {
                    left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto'
                });
            }
        }
    }

    function clampPanelPosition() {
        if (!els.panel || !els.panel.style.left) return;
        const panel = els.panel;
        const x = parseFloat(panel.style.left);
        const y = parseFloat(panel.style.top);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const maxX = innerWidth - panel.offsetWidth;
        const maxY = innerHeight - panel.offsetHeight;
        if (x > maxX || y > maxY || x < 0 || y < 0) {
            panel.style.left = clamp(x, 0, maxX) + 'px';
            panel.style.top = clamp(y, 0, maxY) + 'px';
        }
    }

    /* 단축키 */
    const SHORTCUTS = new Map([
        ['KeyD',      () => els.toggleBtn?.click()],
        ['ArrowUp',   () => applyTargetDelay(Math.max(0.5, targetDelayMs / 1000 - 0.5))],
        ['ArrowDown', () => applyTargetDelay(targetDelayMs / 1000 + 0.5)],
        ['KeyT',      () => { if (els.targetIn) { els.targetIn.focus(); els.targetIn.select(); } }],
        ['KeyR',      () => { resetState(); if (video) setRate(1.0); flashStyle(els.delayVal, 'textShadow', '0 0 8px #f39c12', 600); }],
        ['KeyC',      () => els.collapseBtn?.click()],
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
            if (document.hidden) {
                hiddenAt = performance.now();
                return;
            }
            const away = performance.now() - hiddenAt;
            resetState();
            if (away > 3000 && isEnabled && video?.isConnected && video.buffered.length > 0) {
                const edge = getBufferEdge(video.buffered);
                if (edge) {
                    const e = { start: edge.start, end: edge.end };
                    if ((e.end - video.currentTime) * 1000 > targetDelayMs * 1.5) {
                        if (debugVisible) dmLog(`탭 복귀 seek: ${((e.end - video.currentTime) * 1000).toFixed(0)}ms (away: ${(away / 1000).toFixed(1)}s)`);
                        seekToTarget(e.start, e.end);
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
