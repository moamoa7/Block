// ==UserScript==
// @name         딜레이 미터기 (공격적 튜닝)
// @namespace    https://github.com/delay-meter
// @version      4.5.0
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

    const VERSION = typeof GM_info !== 'undefined' ? GM_info.script.version : '4.5.0';

    const TUNING = Object.freeze({
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
        SPIKE_THRESHOLD_MS: 2500,
        SPIKE_COOLDOWN_MS: 1000,
        STALL_THRESHOLD: 3,
        VIDEO_SEARCH_EVERY: 150,
        FRAME_CHECK_EVERY: 50,
        WARMUP_MS: 1500,
        WARMUP_MIN_BUFFER_SEC: 1.0,
        WARMUP_MIN_READY_STATE: 3,
    });

    const IS_CHZZK = location.hostname.includes('chzzk.naver.com');
    const PLATFORM_OFFSET = IS_CHZZK ? 500 : 0;
    const RECOMMENDED_PRESETS = IS_CHZZK ? [2, 3] : [4, 5];

    const DEFAULTS = Object.freeze({
        TARGET_DELAY_MS: IS_CHZZK ? 2000 : 4000,
        IS_ENABLED: true,
    });

    const STORAGE_KEY = 'delay_meter_config_v3';
    const MAX_TARGET_MS = 8000;

    const COLORS = {
        GREEN:  { r: 0x2e, g: 0xcc, b: 0x71 },
        YELLOW: { r: 0xf1, g: 0xc4, b: 0x0f },
        RED:    { r: 0xe7, g: 0x4c, b: 0x3c },
    };

    const DASH_PATTERN = [3, 3];
    const DASH_NONE = [];

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

    /* ── 상태 ── */
    const saved = loadConfig();
    let video = null;
    let lastVideoSrc = '';
    let intervalId = null;
    let isSettingRate = false;
    let lastSetRateTime = 0;
    let currentSmoothedRate = 1.0;
    let dynamicMaxRate = TUNING.MAX_RATE;
    let lastSetRate = -1;
    let lastRateStr = '1.000x';
    let lastRenderedMediaTime = 0;
    let targetDelayMs = saved.targetDelayMs ?? DEFAULTS.TARGET_DELAY_MS;
    let seekThresholdMs = Math.max(targetDelayMs * 2.5, 3000);
    let isEnabled = saved.isEnabled ?? DEFAULTS.IS_ENABLED;
    let prevAvg = 0;
    let lastSeekTime = 0;
    let lastSpikeTime = 0;
    let lastPath = location.pathname;
    let tickGeneration = 0;
    let nextTickTime = 0;
    let lastInterval = TUNING.CHECK_INTERVAL;
    let lastDroppedFrames = 0;
    let lastTotalFrames = 0;
    let hasPlaybackQuality = false;
    let frameCheckCounter = 0;
    let videoSearchCounter = 0;
    let lastCurrentTime = 0;
    let stallCount = 0;
    let wasPaused = false;
    let collapsed = false;
    let skipReason = '';
    let miniFlashUntil = 0;
    let rateProtectTimer = null;
    let stableTickCount = 0;
    let debugVisible = false;
    let els = {};

    /* ── 웜업 상태 ── */
    let warmupStartTime = 0;
    let warmupDone = false;

    /* ── seek AbortController ── */
    let seekAc = null;
    let seekTimeout = null;

    /* ── 링 버퍼 ── */
    class RingBuffer {
        constructor(cap) {
            this.buf = new Float64Array(cap);
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
        get length() { return this.len; }
        get last() { return this.len ? this.buf[(this.idx - 1 + this.cap) % this.cap] : 0; }
        clear() { this.len = 0; this.idx = 0; }
    }

    let delayHistory = new RingBuffer(TUNING.HISTORY_SIZE);
    const graphHistory = new RingBuffer(60);

    /* ── 유틸 ── */
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function pct(value, max, lo = 0, hi = 100) {
        return Math.round(clamp((value / max) * 100, lo, hi)) + '%';
    }

    function lerpRGB(a, b, t) {
        const r = (a.r + (b.r - a.r) * t) | 0;
        const g = (a.g + (b.g - a.g) * t) | 0;
        const bl = (a.b + (b.b - a.b) * t) | 0;
        return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
    }

    function gradient3(ratio) {
        return ratio <= 0.5
            ? lerpRGB(COLORS.GREEN, COLORS.YELLOW, ratio * 2)
            : lerpRGB(COLORS.YELLOW, COLORS.RED, (ratio - 0.5) * 2);
    }

    function createColorCache(toRatio, tolerance) {
        let lastInput = NaN, lastResult = '#2ecc71';
        return (input) => {
            if (Math.abs(input - lastInput) < tolerance) return lastResult;
            lastInput = input;
            const ratio = toRatio(input);
            if (ratio <= 0) return (lastResult = '#2ecc71');
            if (ratio >= 1) return (lastResult = '#e74c3c');
            return (lastResult = gradient3(ratio));
        };
    }

    const computeColor = createColorCache(
        diff => clamp(diff / 2000, 0, 1), 30
    );

    function getRateBarColor(ratio) {
        if (ratio < 0.5) return '#3498db';
        if (ratio < 0.8) return '#f39c12';
        return '#e74c3c';
    }

    function flashStyle(el, prop, value, duration = 600) {
        if (!el?.isConnected) return;
        el.style[prop] = value;
        setTimeout(() => { if (el.isConnected) el.style[prop] = ''; }, duration);
    }

    /* ── blob URL 판별 ── */
    function isBlobSrc(v) {
        const src = v.currentSrc || v.src || '';
        return src.startsWith('blob:');
    }

    /* ── buffered 안전 접근 ── */
    function getBufferEdge(buf) {
        if (!buf || buf.length === 0) return null;
        try {
            const last = buf.length - 1;
            return { start: buf.start(last), end: buf.end(last) };
        } catch (e) {
            console.debug('[딜레이미터] buffered 접근 실패:', e.message);
            return null;
        }
    }

    /* ── 라이브 판별 ── */
    function isLiveStream(v) {
        if (v.duration === Infinity) return true;
        if (Number.isNaN(v.duration) || v.duration === 0) return v.buffered.length > 0;
        if (v.duration >= 1e6) return true;
        if (v.buffered.length > 0) {
            const bufEnd = v.buffered.end(v.buffered.length - 1);
            if (v.duration - bufEnd < 1) return false;
            if (bufEnd > v.currentTime + 1) return true;
        }
        return false;
    }

    /* ── 웜업 판별 ── */
    function isWarmedUp() {
        if (warmupDone) return true;
        const now = performance.now();
        if (now - warmupStartTime < TUNING.WARMUP_MS) return false;
        if (!video || video.readyState < TUNING.WARMUP_MIN_READY_STATE) return false;
        const edge = getBufferEdge(video.buffered);
        if (!edge) return false;
        const bufferedAhead = edge.end - video.currentTime;
        if (bufferedAhead < TUNING.WARMUP_MIN_BUFFER_SEC) return false;
        if (video.paused) return false;
        warmupDone = true;
        console.debug(`[딜레이미터] 웜업 완료 (${(now - warmupStartTime).toFixed(0)}ms, buf:${bufferedAhead.toFixed(2)}s, readyState:${video.readyState})`);
        return true;
    }

    /* ── 프레임 콜백 (rVFC) ── */
    let frameCallbackGen = 0;

    function startFrameCallback(vid) {
        if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
        const gen = ++frameCallbackGen;
        const step = (now, md) => {
            if (gen !== frameCallbackGen) return;
            lastRenderedMediaTime = md.mediaTime;
            vid.requestVideoFrameCallback(step);
        };
        vid.requestVideoFrameCallback(step);
    }

    /* ── 평균 (단일 패스) ── */
    function getStableAverage() {
        const n = delayHistory.length;
        if (n === 0) return 0;
        if (n === 1) return delayHistory.last;

        const buf = delayHistory.buf;
        const cap = delayHistory.cap;
        let pos = ((delayHistory.idx - n) % cap + cap) % cap;

        if (n <= 3) {
            let wSum = 0, wTotal = 0;
            for (let i = 0; i < n; i++) {
                const w = 1 << i;
                wSum += buf[pos] * w;
                wTotal += w;
                if (++pos >= cap) pos = 0;
            }
            return wSum / wTotal;
        }

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
        } catch { /* */ }
        finally {
            queueMicrotask(() => { isSettingRate = false; });
        }
    }

    function getAdaptiveInterval() {
        if (!isEnabled) return 500;
        if (!warmupDone) return 500;
        if (stableTickCount >= 10) return 600;
        if (Math.abs(currentSmoothedRate - 1.0) < 0.005) return 400;
        return TUNING.CHECK_INTERVAL;
    }

    /* ── 외부 배속 변경 감지 ── */
    function onExternalRateChange() {
        if (isSettingRate || performance.now() - lastSetRateTime < 100) return;
        if (!video) return;
        const ext = video.playbackRate;
        if (Math.abs(ext - lastSetRate) < 0.002) return;
        if (isEnabled) {
            console.debug(`[딜레이미터] 외부 배속 변경 감지: ${ext}, 복원 대기`);
            clearTimeout(rateProtectTimer);
            rateProtectTimer = setTimeout(() => {
                if (!video || !isEnabled) return;
                lastSetRate = -1;
                const avg = getStableAverage();
                if (avg > 0) {
                    const desired = computeDesiredRate(avg);
                    currentSmoothedRate = desired;
                    setRate(desired);
                }
            }, 200);
        } else {
            currentSmoothedRate = ext;
            lastSetRate = ext;
            lastRateStr = ext.toFixed(3) + 'x';
        }
    }

    /* ── 프레임 드롭 ── */
    function checkFrameDrops() {
        if (!hasPlaybackQuality) return;
        const q = video.getVideoPlaybackQuality();
        const droppedDelta = q.droppedVideoFrames - lastDroppedFrames;
        const totalDelta = q.totalVideoFrames - lastTotalFrames;
        lastDroppedFrames = q.droppedVideoFrames;
        lastTotalFrames = q.totalVideoFrames;
        if (totalDelta < 10) return;
        const dropRate = droppedDelta / totalDelta;
        const prev = dynamicMaxRate;
        if (dropRate > 0.05 && dynamicMaxRate > 1.08) {
            dynamicMaxRate = Math.max(1.08, dynamicMaxRate - 0.02);
        } else if (dropRate < 0.02 && dynamicMaxRate < TUNING.MAX_RATE) {
            dynamicMaxRate = Math.min(TUNING.MAX_RATE, dynamicMaxRate + 0.015);
        }
        if (prev !== dynamicMaxRate) {
            console.debug(`[딜레이미터] maxRate: ${prev.toFixed(3)} → ${dynamicMaxRate.toFixed(3)} (drop: ${(dropRate * 100).toFixed(1)}%)`);
        }
    }

    /* ── 상태 리셋 ── */
    function resetState() {
        clearTimeout(rateProtectTimer);
        rateProtectTimer = null;
        if (seekAc) { seekAc.abort(); seekAc = null; }
        if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
        lastRenderedMediaTime = 0;
        lastCurrentTime = 0;
        stallCount = 0;
        wasPaused = false;
        currentSmoothedRate = 1.0;
        dynamicMaxRate = TUNING.MAX_RATE;
        lastSetRate = -1;
        lastRateStr = '1.000x';
        lastSpikeTime = 0;
        skipReason = '';
        frameCheckCounter = 0;
        stableTickCount = 0;
        delayHistory.clear();
        warmupDone = false;
        warmupStartTime = performance.now();
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
        startFrameCallback(video);
        resetState();
        try {
            hasPlaybackQuality = typeof v.getVideoPlaybackQuality === 'function' && !!v.getVideoPlaybackQuality();
        } catch {
            hasPlaybackQuality = false;
        }
        if (hasPlaybackQuality) {
            const q = v.getVideoPlaybackQuality();
            lastDroppedFrames = q.droppedVideoFrames;
            lastTotalFrames = q.totalVideoFrames;
        } else {
            lastDroppedFrames = 0;
            lastTotalFrames = 0;
        }
        v.removeEventListener('ratechange', onExternalRateChange);
        v.addEventListener('ratechange', onExternalRateChange);

        if (!v._dmSrcObserved) {
            v._dmSrcObserved = true;
            v.addEventListener('loadstart', () => {
                if (v === video) {
                    const newSrc = v.currentSrc || v.src || '';
                    if (newSrc !== lastVideoSrc && isBlobSrc(v)) {
                        console.debug(`[딜레이미터] src 변경 감지: ${newSrc.slice(0, 40)}...`);
                        lastVideoSrc = newSrc;
                        resetState();
                        startFrameCallback(v);
                    }
                }
            });
        }
        console.debug(`[딜레이미터] video 발견 (blob src: ${src.slice(0, 40)}...)`);
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
        if (seekAc) {
            seekAc.abort();
            seekAc = null;
        }
        if (seekTimeout) {
            clearTimeout(seekTimeout);
            seekTimeout = null;
        }
        seekAc = new AbortController();
        const ac = seekAc;

        const seekTo = Math.max(bufStart, bufEnd - targetDelayMs / 1000);
        video.currentTime = seekTo;

        seekTimeout = setTimeout(() => { seekTimeout = null; if (!ac.signal.aborted) ac.abort(); }, 5000);

        ac.signal.addEventListener('abort', () => {
            if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
        });

        video.addEventListener('seeked', () => {
            if (seekTimeout) { clearTimeout(seekTimeout); seekTimeout = null; }
            if (ac.signal.aborted) return;
            setTimeout(() => {
                if (ac.signal.aborted || !video?.isConnected) return;
                const edge = getBufferEdge(video.buffered);
                if (!edge) return;
                const postDelay = (edge.end - video.currentTime) * 1000;
                if (postDelay > targetDelayMs * 1.5) {
                    video.currentTime = Math.max(edge.start, edge.end - targetDelayMs / 1000);
                }
            }, 50);
        }, { once: true, signal: ac.signal });
    }

    /* ── 상태 표시 ── */
    function getStatusIndicator(avg, rate) {
        const delta = avg - prevAvg;
        prevAvg = avg;
        if (!warmupDone) return ' ⏳';
        if (!isEnabled) return ' ⏹';
        if (Math.abs(rate - 1.0) < 0.005 && Math.abs(avg - targetDelayMs) < TUNING.DEADZONE_MS) return ' ✓';
        if (Math.abs(delta) < 80) return ' →';
        return delta > 0 ? ' ↑' : ' ↓';
    }

    function flashSeekIndicator() {
        flashStyle(els.delayVal, 'textShadow', '0 0 8px #e74c3c', 800);
    }
    function flashToggleState() {
        if (!els.mini) return;
        els.mini.textContent = isEnabled ? 'ON' : 'OFF';
        miniFlashUntil = performance.now() + 600;
        flashStyle(els.mini, 'color', isEnabled ? '#2ecc71' : '#e74c3c');
    }

    /* ── dirty 플래그 기반 display ── */
    const displayApply = Object.create(null);
    const displayState = {};
    const dirtyChannels = new Set();

    function initDisplayApply() {
        displayApply.d    = v => { els.delayVal.textContent = v; };
        displayApply.r    = v => { els.rateVal.textContent = v; };
        displayApply.c    = v => { els.delayVal.style.color = v; els.barFill.style.background = v; };
        displayApply.w    = v => { els.barFill.style.width = v; };
        displayApply.rb   = v => { if (els.rateBar) els.rateBar.style.width = v; };
        displayApply.rbc  = v => { if (els.rateBar) els.rateBar.style.background = v; };
        displayApply.ro   = v => { if (els.rateVal) els.rateVal.style.opacity = v; };
        displayApply.mini = v => { if (els.mini) els.mini.textContent = v; };
        displayApply.dbg  = v => { if (els.debugVal) els.debugVal.textContent = v; };
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
            if (dirtyChannels.has('mini')) displayApply.mini(displayState.mini);
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
        if (!graphCanvas || !graphCtx || !debugVisible) return;
        const n = graphHistory.length;
        if (n < 2) return;

        const w = graphCanvas.width, h = graphCanvas.height;
        graphCtx.clearRect(0, 0, w, h);

        const targetY = h - (targetDelayMs / 8000) * h;
        graphCtx.strokeStyle = 'rgba(255,255,255,.15)';
        graphCtx.setLineDash(DASH_PATTERN);
        graphCtx.beginPath();
        graphCtx.moveTo(0, targetY);
        graphCtx.lineTo(w, targetY);
        graphCtx.stroke();
        graphCtx.setLineDash(DASH_NONE);

        graphCtx.strokeStyle = '#2ecc71';
        graphCtx.lineWidth = 1.5;
        graphCtx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = (i / (graphHistory.cap - 1)) * w;
            const y = h - clamp(graphHistory.at(i) / 8000, 0, 1) * h;
            i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
        }
        graphCtx.stroke();
    }

    /* ── UI 갱신 ── */
    function updateDisplay(avgMs, bufEnd = -1) {
        if (performance.now() >= miniFlashUntil) {
            setDisplay('mini', collapsed ? (avgMs / 1000).toFixed(1) + 's' : '');
        }

        const statusIndicator = getStatusIndicator(avgMs, currentSmoothedRate);

        if (els.panel) {
            const overThreshold = avgMs > targetDelayMs * 2 && isEnabled && warmupDone;
            els.panel.classList.toggle('dm-warning', overThreshold);
            els.panel.title = `딜레이: ${(avgMs / 1000).toFixed(2)}s | 배속: ${lastRateStr} | 목표: ${(targetDelayMs / 1000).toFixed(1)}s`;
        }

        if (collapsed) {
            if (rafId) return;
            rafId = requestAnimationFrame(() => { rafId = null; flushDisplay(); });
            return;
        }

        setDisplay('d', (avgMs / 1000).toFixed(2) + 's' + statusIndicator);
        setDisplay('r', lastRateStr);
        setDisplay('c', computeColor(avgMs - targetDelayMs));
        setDisplay('w', pct(avgMs, 8000, 2, 100));
        setDisplay('ro', isEnabled ? '1' : '0.3');

        const rateRatio = clamp(
            (currentSmoothedRate - TUNING.MIN_RATE) / (TUNING.MAX_RATE - TUNING.MIN_RATE), 0, 1
        );
        setDisplay('rb', Math.round(rateRatio * 100) + '%');
        setDisplay('rbc', getRateBarColor(rateRatio));

        if (debugVisible && els.debugVal) {
            if (!video) {
                setDisplay('dbg', 'video 탐색 중...');
            } else {
                const bEnd = bufEnd >= 0 ? bufEnd.toFixed(2) : '-';
                const q = hasPlaybackQuality ? video.getVideoPlaybackQuality() : null;
                const dropInfo = q ? ` d:${q.droppedVideoFrames}/${q.totalVideoFrames}` : '';
                const skip = skipReason ? ` [${skipReason}]` : '';
                const wu = warmupDone ? '' : ' [WARMUP]';
                setDisplay('dbg', `${video.paused ? '⏸' : '▶'} ct:${video.currentTime.toFixed(2)} buf:${bEnd} sr:${currentSmoothedRate.toFixed(3)} mx:${dynamicMaxRate.toFixed(2)} iv:${getAdaptiveInterval()} st:${stableTickCount}${dropInfo}${skip}${wu}`);
            }
        }

        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            flushDisplay();
            drawGraph();
        });
    }

    /* ── UI 헬퍼 ── */
    function updateToggleBtnUI() {
        if (!els.toggleBtn) return;
        const on = isEnabled;
        els.toggleBtn.textContent = on ? 'ON' : 'OFF';
        Object.assign(els.toggleBtn.style, {
            background: on ? '#2ecc71' : '#555',
            color: on ? '#000' : '#999',
        });
    }
    function updateTargetMark() {
        if (!els.targetMark) return;
        els.targetMark.style.left = pct(targetDelayMs, 8000);
    }

    let presetBtns = [];
    function updatePresetHL() {
        presetBtns.forEach(({ btn, sec }) => {
            const on = Math.abs(targetDelayMs - sec * 1000) < 1;
            btn.style.background = on ? '#2ecc71' : '#333';
            btn.style.color = on ? '#000' : '#ccc';
        });
    }

    function applyTargetDelay(sec) {
        targetDelayMs = clamp(Math.round(sec * 1000), 500, MAX_TARGET_MS);
        seekThresholdMs = Math.max(targetDelayMs * 2.5, 3000);
        delayHistory.clear();
        currentSmoothedRate = 1.0;
        lastSetRate = -1;
        stableTickCount = 0;
        if (warmupDone) setRate(1.0);
        if (els.targetIn) els.targetIn.value = (targetDelayMs / 1000).toFixed(1);
        saveConfig({ targetDelayMs });
        updateTargetMark();
        updatePresetHL();
    }

    /* ── 수동 seek ── */
    function doManualSync() {
        if (!video || !video.buffered.length) return;
        const edge = getBufferEdge(video.buffered);
        if (!edge) return;
        seekToTarget(edge.start, edge.end);
        delayHistory.clear();
        currentSmoothedRate = 1.0;
        setRate(1.0);
        flashSeekIndicator();
    }

    /* ── 핵심 루프 ── */
    function processLiveVideo() {
        const now = performance.now();

        if (!isWarmedUp()) {
            const edge = getBufferEdge(video.buffered);
            if (edge) {
                const rawDelay = (edge.end - video.currentTime) * 1000;
                const delayMs = Math.max(0, rawDelay + PLATFORM_OFFSET);
                updateDisplay(delayMs, edge.end);
            } else {
                updateDisplay(0);
            }
            skipReason = 'WARMUP';
            return;
        }

        skipReason = '';

        if (++frameCheckCounter % TUNING.FRAME_CHECK_EVERY === 0) checkFrameDrops();

        const edge = getBufferEdge(video.buffered);
        if (!edge) { updateDisplay(0); return; }
        const { start: bufStart, end: bufEnd } = edge;

        const useMediaTime = lastRenderedMediaTime > 0
            && Math.abs(lastRenderedMediaTime - video.currentTime) < 1.0;
        const ref = useMediaTime ? lastRenderedMediaTime : video.currentTime;

        const rawDelay = (bufEnd - ref) * 1000;
        if (rawDelay < 0) { updateDisplay(0, bufEnd); return; }
        const delayMs = rawDelay + PLATFORM_OFFSET;

        const ct = video.currentTime;
        if (Math.abs(ct - lastCurrentTime) < 0.001 && !video.paused) stallCount++;
        else stallCount = 0;
        lastCurrentTime = ct;
        if (wasPaused && !video.paused) { wasPaused = false; lastSetRate = -1; }
        wasPaused = video.paused;

        if (isEnabled && delayMs > seekThresholdMs && stallCount < TUNING.STALL_THRESHOLD) {
            if (now - lastSeekTime >= TUNING.SEEK_COOLDOWN_MS) {
                lastSeekTime = now;
                console.debug(`[딜레이미터] SEEK: ${delayMs.toFixed(0)}ms ct:${ct.toFixed(2)}→${Math.max(bufStart, bufEnd - targetDelayMs / 1000).toFixed(2)}`);
                seekToTarget(bufStart, bufEnd);
                delayHistory.clear();
                currentSmoothedRate = 1.0;
                setRate(1.0);
                flashSeekIndicator();
                updateDisplay(targetDelayMs, bufEnd);
                return;
            }
        }

        const lastDelay = delayHistory.last;
        if (lastDelay > 0
            && Math.abs(delayMs - lastDelay) > TUNING.SPIKE_THRESHOLD_MS
            && now - lastSpikeTime >= TUNING.SPIKE_COOLDOWN_MS) {
            skipReason = 'SPIKE';
            lastSpikeTime = now;
            delayHistory.clear();
            currentSmoothedRate = 1.0;
            lastSetRate = -1;
            stableTickCount = 0;
            updateDisplay(delayMs, bufEnd);
            return;
        }

        delayHistory.push(delayMs);
        graphHistory.push(delayMs);
        const avg = isEnabled || currentSmoothedRate !== 1.0 ? getStableAverage() : delayHistory.last;

        if (Math.abs(avg - targetDelayMs) < TUNING.DEADZONE_MS) {
            stableTickCount = Math.min(stableTickCount + 1, 20);
        } else {
            stableTickCount = 0;
        }

        updateDisplay(avg, bufEnd);

        if (!isEnabled) {
            if (currentSmoothedRate !== 1.0) { currentSmoothedRate = 1.0; setRate(1.0); }
            return;
        }
        setRate(smoothRate(computeDesiredRate(avg)));
    }

    function tick() {
        try {
            checkUrlChange();
            if (video && !video.isConnected) {
                video.removeEventListener('ratechange', onExternalRateChange);
                video = null;
            }

            if (!video) {
                if (++videoSearchCounter % TUNING.VIDEO_SEARCH_EVERY === 0) {
                    const v = document.querySelector('video');
                    if (v) onVideoFound(v);
                }
                updateDisplay(0);
                return;
            }
            videoSearchCounter = 0;

            if (!isBlobSrc(video) || !isLiveStream(video)) {
                skipReason = 'VOD/AD';
                if (currentSmoothedRate !== 1.0) { currentSmoothedRate = 1.0; setRate(1.0); }
                updateDisplay(0);
                return;
            }

            processLiveVideo();
        } catch (e) {
            console.warn('[딜레이미터]', e);
        }
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
        if (interval !== lastInterval || nextTickTime === 0) {
            nextTickTime = now + interval;
            lastInterval = interval;
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
    let cssInjected = false;

    function createPanel() {
        if (document.getElementById('dm-panel')) return;
        if (!cssInjected) {
            GM_addStyle(`
                #dm-panel{position:fixed;bottom:20px;right:20px;z-index:10000;
                    background:rgba(12,12,16,.92);backdrop-filter:blur(12px);
                    border:1px solid rgba(255,255,255,.08);border-radius:12px;
                    padding:12px 16px;color:#eee;font-family:'Pretendard',sans-serif;
                    font-size:12px;min-width:210px;box-shadow:0 8px 32px rgba(0,0,0,.6);
                    user-select:none;transition:border-color .3s ease}
                #dm-panel [data-dm="header"]{font-weight:bold;border-bottom:1px solid #333;
                    padding-bottom:6px;margin-bottom:8px;cursor:grab}
                .dm-row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
                .dm-val{font-weight:bold;font-family:'JetBrains Mono',monospace;font-size:15px;
                    transition:opacity .2s ease}
                .dm-bar-bg{position:relative;background:rgba(255,255,255,.08);height:5px;
                    border-radius:3px;margin:4px 0 8px;overflow:visible}
                .dm-bar-clip{overflow:hidden;height:100%;border-radius:3px}
                .dm-bar{height:100%;width:0%;border-radius:3px;
                    transition:width .15s linear,background .2s ease}
                .dm-target-mark{position:absolute;top:-2px;bottom:-2px;width:2px;
                    border-radius:1px;transition:left .3s ease,opacity .3s ease;pointer-events:none;
                    background:#fff;opacity:.6}
                .dm-rate-bar{height:100%;width:0%;border-radius:3px;background:#3498db;
                    transition:width .15s linear,background .2s ease}
                .dm-input{width:45px;background:#1a1a1a;border:1px solid #444;color:#fff;
                    text-align:center;border-radius:4px}
                .dm-btn{cursor:pointer;border:none;border-radius:4px;padding:3px 8px;
                    font-size:11px;font-weight:bold;transition:.1s}
                .dm-btn:active{transform:scale(.95)}
                .dm-presets{display:flex;gap:5px;justify-content:center;margin-top:8px}
                .dm-presets .dm-btn{background:#333;color:#ccc}
                .dm-debug{font-size:9px;color:#666;font-family:monospace;margin-top:8px;
                    border-top:1px solid #2a2a2a;padding-top:5px;word-break:break-all}
                @keyframes dm-pulse{
                    0%,100%{border-color:rgba(231,76,60,.3)}
                    50%{border-color:rgba(231,76,60,.8)}
                }
                #dm-panel.dm-warning{animation:dm-pulse 1s ease-in-out infinite}
            `);
            cssInjected = true;
        }

        const panel = document.createElement('div');
        panel.id = 'dm-panel';
        panel.innerHTML = `
            <div data-dm="header">딜레이 미터기 <span style="font-weight:normal;font-size:10px;opacity:.5">v${VERSION}</span>
                <span data-dm="mini" style="font-size:11px;font-family:monospace;margin-left:6px;font-weight:normal"></span>
                <span data-dm="collapse" style="float:right;cursor:pointer;font-size:10px">▼</span>
            </div>
            <div class="dm-body">
                <div class="dm-row"><span>버퍼</span><span data-dm="delay" class="dm-val">-</span></div>
                <div class="dm-bar-bg">
                    <div class="dm-bar-clip"><div data-dm="bar" class="dm-bar"></div></div>
                    <div data-dm="targetmark" class="dm-target-mark"></div>
                </div>
                <div class="dm-row"><span>배속</span><span data-dm="rate" class="dm-val">1.000x</span></div>
                <div class="dm-bar-bg">
                    <div class="dm-bar-clip"><div data-dm="ratebar" class="dm-rate-bar"></div></div>
                </div>
                <div class="dm-row" style="margin-top:10px">
                    <button data-dm="toggle" class="dm-btn">ON</button>
                    <button data-dm="sync" class="dm-btn" style="background:#2980b9;color:#fff;margin-left:6px">⟳ SYNC</button>
                    <span>목표 <input type="number" data-dm="target" class="dm-input" step="0.5">초</span>
                </div>
                <div class="dm-presets"></div>
                <div class="dm-debug" data-dm="debug"></div>
            </div>`;
        document.body.appendChild(panel);

        const q = s => panel.querySelector(`[data-dm="${s}"]`);
        els = {
            panel: panel,
            delayVal: q('delay'), rateVal: q('rate'), barFill: q('bar'),
            rateBar: q('ratebar'), targetMark: q('targetmark'),
            toggleBtn: q('toggle'), syncBtn: q('sync'), targetIn: q('target'),
            header: q('header'), debugVal: q('debug'), mini: q('mini'),
        };
        els.targetIn.value = (targetDelayMs / 1000).toFixed(1);

        initDisplayApply();

        /* ── 접기/펼치기 ── */
        const collapseBtn = q('collapse');
        const body = panel.querySelector('.dm-body');
        collapsed = loadConfig().collapsed ?? false;
        const applyCollapse = () => {
            body.style.display = collapsed ? 'none' : '';
            collapseBtn.textContent = collapsed ? '▶' : '▼';
        };
        applyCollapse();
        collapseBtn.onclick = e => {
            e.stopPropagation(); collapsed = !collapsed;
            applyCollapse(); saveConfig({ collapsed });
            if (!collapsed) dirtyChannels.clear();
        };

        /* ── 디버그 토글 ── */
        debugVisible = loadConfig().debugVisible ?? false;
        const applyDebug = () => {
            const vis = debugVisible ? '' : 'none';
            els.debugVal.style.display = vis;
            if (graphCanvas) graphCanvas.style.display = vis;
        };
        applyDebug();
        els.header.addEventListener('dblclick', () => {
            debugVisible = !debugVisible; applyDebug(); saveConfig({ debugVisible });
        });

        /* ── ON/OFF ── */
        updateToggleBtnUI();
        els.toggleBtn.onclick = () => {
            isEnabled = !isEnabled;
            if (isEnabled) { currentSmoothedRate = TUNING.HOLD_RATE; lastSetRate = -1; }
            saveConfig({ isEnabled }); updateToggleBtnUI();
            flashToggleState();
        };

        /* ── SYNC 버튼 ── */
        els.syncBtn.onclick = () => doManualSync();

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
        const presetBox = panel.querySelector('.dm-presets');
        presetBtns = PRESETS.map(sec => {
            const btn = Object.assign(document.createElement('button'), {
                className: 'dm-btn',
                textContent: sec + 's',
                onclick: () => applyTargetDelay(sec),
            });
            if (RECOMMENDED_PRESETS.includes(sec)) btn.style.borderBottom = '2px solid #2ecc71';
            presetBox.appendChild(btn);
            return { btn, sec };
        });
        updatePresetHL();

        /* ── 미니 그래프 캔버스 ── */
        graphCanvas = document.createElement('canvas');
        graphCanvas.width = 180;
        graphCanvas.height = 30;
        graphCanvas.style.cssText = 'display:none;margin:6px 0 2px;border-radius:4px;background:rgba(255,255,255,.03)';
        const barBgs = panel.querySelectorAll('.dm-bar-bg');
        barBgs[0].after(graphCanvas);
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

        h.addEventListener('pointerup', () => {
            if (!dragging) return;
            dragging = false;
            h.style.cursor = 'grab';
            saveConfig({ panelX: panel.style.left, panelY: panel.style.top });
        });

        const s = loadConfig();
        if (s.panelX != null) {
            const x = parseInt(s.panelX, 10), y = parseInt(s.panelY, 10);
            if (x >= 0 && x < innerWidth - 50 && y >= 0 && y < innerHeight - 50) {
                Object.assign(panel.style, {
                    left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto'
                });
            }
        }
    }

    function clampPanelPosition() {
        const panel = document.getElementById('dm-panel');
        if (!panel || !panel.style.left) return;
        const x = parseInt(panel.style.left, 10);
        const y = parseInt(panel.style.top, 10);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const maxX = innerWidth - panel.offsetWidth;
        const maxY = innerHeight - panel.offsetHeight;
        if (x > maxX || y > maxY || x < 0 || y < 0) {
            panel.style.left = clamp(x, 0, maxX) + 'px';
            panel.style.top = clamp(y, 0, maxY) + 'px';
        }
    }

    /* ── 단축키 맵 ── */
    const SHORTCUTS = new Map([
        ['KeyD',      { fn: () => els.toggleBtn?.click(),                                           desc: '토글' }],
        ['ArrowUp',   { fn: () => applyTargetDelay(Math.max(0.5, targetDelayMs / 1000 - 0.5)),     desc: '목표 -0.5s' }],
        ['ArrowDown', { fn: () => applyTargetDelay(targetDelayMs / 1000 + 0.5),                     desc: '목표 +0.5s' }],
        ['KeyR',      { fn: () => { resetState(); if (video) setRate(1.0); },                       desc: '상태 리셋' }],
        ['KeyC',      { fn: () => document.querySelector('[data-dm="collapse"]')?.click(),           desc: '접기/펼치기' }],
        ['KeyS',      { fn: () => doManualSync(),                                                    desc: '수동 SYNC' }],
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

        window.addEventListener('popstate', () => checkUrlChange());
        window.addEventListener('resize', clampPanelPosition);

        document.addEventListener('fullscreenchange', () => {
            requestAnimationFrame(() => {
                const panel = document.getElementById('dm-panel');
                if (!panel) return;
                if (document.fullscreenElement) {
                    Object.assign(panel.style, { right: '20px', bottom: '20px', left: 'auto', top: 'auto' });
                } else {
                    const s = loadConfig();
                    if (s.panelX != null) {
                        Object.assign(panel.style, {
                            left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto'
                        });
                    } else {
                        Object.assign(panel.style, { right: '20px', bottom: '20px', left: 'auto', top: 'auto' });
                    }
                    clampPanelPosition();
                }
            });
        });

        document.addEventListener('visibilitychange', () => {
            nextTickTime = 0;
            if (document.visibilityState === 'visible') {
                const needSeek = isEnabled && video?.isConnected && video.buffered.length > 0;
                let seekEdge = null;
                if (needSeek) {
                    seekEdge = getBufferEdge(video.buffered);
                }

                resetState();
                tickGeneration++;
                clearTimeout(intervalId);

                if (seekEdge) {
                    const delay = (seekEdge.end - video.currentTime) * 1000;
                    if (delay > targetDelayMs * 2) {
                        console.debug(`[딜레이미터] 탭 복귀 seek: ${delay.toFixed(0)}ms`);
                        seekToTarget(seekEdge.start, seekEdge.end);
                        flashSeekIndicator();
                    }
                }

                scheduleTick();
            }
        });

        document.addEventListener('keydown', e => {
            if (!e.altKey) return;
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
            const entry = SHORTCUTS.get(e.code);
            if (entry) { e.preventDefault(); entry.fn(); }
        });
    }

    requestAnimationFrame(init);
})();
