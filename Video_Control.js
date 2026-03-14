// ==UserScript==
// @name         딜레이 미터기
// @namespace    https://github.com/moamoa7
// @version      6.0.0
// @description  라이브 방송의 딜레이를 자동으로 최적화합니다.
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

    /* ── 플랫폼 ── */
    const IS_CHZZK = location.hostname.includes('chzzk.naver.com');
    const PLATFORM_OFFSET = IS_CHZZK ? 500 : 0;
    const PLATFORM_TAG = IS_CHZZK ? 'CHZZK' : 'SOOP';

    /* ── 슬라이더 → 목표 딜레이 매핑 ──
       슬라이더 0~100
       0   = 최저지연 (1.5초 / 2초)
       50  = 균형     (3초 / 4초)   ← 기본값
       100 = 최안정   (5초 / 6초)
    */
    const SLIDER_TO_MS = IS_CHZZK
        ? { min: 1500, default: 3000, max: 5000 }
        : { min: 2000, default: 4000, max: 6000 };

    function sliderToTargetMs(pct) {
        const t = pct / 100;
        return Math.round(SLIDER_TO_MS.min + (SLIDER_TO_MS.max - SLIDER_TO_MS.min) * t);
    }

    function targetMsToSlider(ms) {
        return Math.round((ms - SLIDER_TO_MS.min) / (SLIDER_TO_MS.max - SLIDER_TO_MS.min) * 100);
    }

    /* ── 튜닝 ── */
    const TUNING = {
        CHECK_INTERVAL: 500,
        BOOST_RATE: 1.03,
        TRIGGER_MARGIN_MS: 1500,
        SETTLE_MARGIN_MS: 300,
        BOOST_MAX_DURATION: 20000,
        BOOST_COOLDOWN: 5000,
        BOOST_MIN_DURATION: 4000,
        CONFIRM_TICKS: 5,
        HISTORY_SIZE: 10,
        SEEK_COOLDOWN_MS: 15000,
        SPIKE_THRESHOLD_MS: 2000,
        SPIKE_COOLDOWN_MS: 2000,
        STALL_RECOVER_COUNT: 100,
        STALL_THRESHOLD: 6,
        FRAME_CHECK_EVERY: 8,
        WARMUP_MS: 5000,
        WARMUP_MIN_BUFFER_SEC: 3.0,
        WARMUP_MIN_READY_STATE: 3,
        RATE_PROTECT_MS: 400,
        AVG_BIAS: 0.7,
        DROP_RATE_THRESHOLD: 0.03,
        MIN_BUFFER_SEC: 2.0,
    };

    function calcSeekThreshold(target) {
        return Math.max(15000, target * 4.0);
    }

    /* ── 유틸 ── */
    const STORAGE_KEY = 'delay_meter_config_v4';
    let _configCache = null;

    function loadConfig() {
        if (_configCache) return _configCache;
        try { _configCache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch { _configCache = {}; }
        return _configCache;
    }

    function saveConfig(patch) {
        _configCache = { ...loadConfig(), ...patch };
        clearTimeout(saveConfig._t);
        saveConfig._t = setTimeout(() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_configCache));
        }, 300);
    }

    window.addEventListener('beforeunload', () => {
        clearTimeout(saveConfig._t);
        if (_configCache) localStorage.setItem(STORAGE_KEY, JSON.stringify(_configCache));
    });

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
        return (diff) => {
            if (diff <= 0) return '#2ecc71';
            const ratio = clamp(diff / 3000, 0, 1);
            return ratio <= 0.5
                ? lerpRGB(G, Y, ratio * 2)
                : lerpRGB(Y, R, (ratio - 0.5) * 2);
        };
    })();

    function flashStyle(el, prop, value, dur = 600) {
        if (!el) return;
        el.style[prop] = value;
        setTimeout(() => { el.style[prop] = ''; }, dur);
    }

    function isBlobSrc(v) { return (v.currentSrc || v.src || '').startsWith('blob:'); }

    const _edge = { start: 0, end: 0 };
    function getBufferEdge(buf) {
        if (!buf?.length) return null;
        const i = buf.length - 1;
        _edge.start = buf.start(i);
        _edge.end = buf.end(i);
        return _edge;
    }

    function isLiveStream(v) {
        const d = v.duration;
        if (d === Infinity || d >= 1e6) return true;
        if (!Number.isFinite(d) || d === 0) return v.buffered.length > 0;
        if (!v.buffered.length) return false;
        const bufEnd = v.buffered.end(v.buffered.length - 1);
        return d - bufEnd >= 1 && bufEnd > v.currentTime + 1;
    }

    /* ── RingBuffer ── */
    class RingBuffer {
        constructor(cap, T = Float64Array) {
            this.buf = new T(cap); this.cap = cap; this.len = 0; this.idx = 0;
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
            let p = ((this.idx - n) % this.cap + this.cap) % this.cap;
            for (let i = 0; i < n; i++) { out[i] = this.buf[p]; if (++p >= this.cap) p = 0; }
            return n;
        }
        get length() { return this.len; }
        get last() { return this.len ? this.buf[(this.idx - 1 + this.cap) % this.cap] : 0; }
        clear() { this.len = 0; this.idx = 0; }
    }

    /* ── 상태 ── */
    let video = null, lastVideoSrc = '', lastVideoIsBlob = false;
    let intervalId, tickGen = 0, nextTickTime = 0;
    let targetDelayMs = loadConfig().targetDelayMs ?? SLIDER_TO_MS.default;
    let seekThresholdMs = calcSeekThreshold(targetDelayMs);
    let isEnabled = loadConfig().isEnabled ?? true;

    let lastSetRateTime = 0, lastSetRate = -1, effectiveRate = 1.0;
    let lastRateStr = '1.000x';
    let lastRenderedMediaTime = 0, lastPresentedFrames = 0, estimatedFps = 30;
    let prevAvg = 0, lastSeekTime = 0, lastSpikeTime = 0;
    let lastCurrentTime = 0, stallCount = 0, wasPaused = false;
    let lastDroppedFrames = 0, lastTotalFrames = 0, hasPlaybackQuality = false;
    let frameCheckCounter = 0;
    let lastPath = location.pathname;

    let boostActive = false, boostStartTime = 0, boostEndTime = 0;
    let triggerConfirmCount = 0, lowBufferCount = 0;
    let seekCount = 0, lastSeekReason = '';

    let warmupStartTime = performance.now();
    let warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    let warmupDone = false;

    let seekAc = null;
    let panelOpen = false, debugVisible = false;
    let hiddenAt = 0, lastDotColor = '', skipReason = '', _cachedDropInfo = '';
    let els = {};

    const delayHistory = new RingBuffer(TUNING.HISTORY_SIZE);
    let graphHistory = null;
    const _graphBuf = new Uint16Array(60);

    let frameCallbackGen = 0;
    const _hasLoadListener = new WeakSet();

    function dmLog(...a) { if (debugVisible) console.debug('[딜레이미터]', ...a); }

    /* ── 웜업 ── */
    function isWarmedUp() {
        if (warmupDone) return true;
        const now = performance.now();
        if (now < warmupEnd) return false;
        if (!video || video.readyState < TUNING.WARMUP_MIN_READY_STATE) return false;
        const e = getBufferEdge(video.buffered);
        if (!e) return false;
        if (e.end - video.currentTime < TUNING.WARMUP_MIN_BUFFER_SEC + PLATFORM_OFFSET / 1000) return false;
        if (video.paused) return false;
        warmupDone = true;
        return true;
    }

    function startFrameCallback(vid) {
        if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
        const gen = ++frameCallbackGen;
        let prev = 0;
        const step = (now, md) => {
            if (gen !== frameCallbackGen) return;
            lastRenderedMediaTime = md.mediaTime;
            if (md.presentedFrames > lastPresentedFrames + 1 && prev > 0) {
                const el = (now - prev) / 1000, fr = md.presentedFrames - lastPresentedFrames;
                if (el > 0) estimatedFps = Math.round(fr / el);
            }
            lastPresentedFrames = md.presentedFrames;
            prev = now;
            vid.requestVideoFrameCallback(step);
        };
        vid.requestVideoFrameCallback(step);
    }

    /* ── 평균 ── */
    function getStableAverage() {
        const n = delayHistory.length;
        if (n <= 1) return delayHistory.last;
        if (n === 2) return (delayHistory.at(0) + delayHistory.at(1)) * 0.5;
        let sum = 0, mn = Infinity, mx = -Infinity, wS = 0, wT = 0;
        for (let i = 0; i < n; i++) {
            const v = delayHistory.at(i); sum += v;
            if (v < mn) mn = v; if (v > mx) mx = v;
            const w = 1 << i; wS += v * w; wT += w;
        }
        const trim = (sum - mn - mx) / (n - 2), wAvg = wS / wT;
        return trim > wAvg
            ? trim * TUNING.AVG_BIAS + wAvg * (1 - TUNING.AVG_BIAS)
            : wAvg * TUNING.AVG_BIAS + trim * (1 - TUNING.AVG_BIAS);
    }

    /* ── 배속 ── */
    function applyRate(rate) {
        if (!video || video.paused) return;
        if (rate !== 1.0 && video.readyState < 3) return;
        const r = Math.round(rate * 1000) / 1000;
        if (r === lastSetRate) return;
        lastSetRateTime = performance.now();
        video.playbackRate = r;
        lastSetRate = r; effectiveRate = r;
        lastRateStr = r === 1.0 ? '1.000x' : r.toFixed(3) + 'x';
    }

    function startBoost(now) {
        if (boostActive) return;
        boostActive = true; boostStartTime = now;
        applyRate(TUNING.BOOST_RATE);
        if (panelOpen) flashStyle(els.delayVal, 'textShadow', '0 0 8px #f39c12', 600);
    }

    function stopBoost(now) {
        if (!boostActive) return;
        boostActive = false; boostEndTime = now; triggerConfirmCount = 0;
        applyRate(1.0);
        if (panelOpen) flashStyle(els.delayVal, 'textShadow', '0 0 8px #2ecc71', 600);
    }

    function softReset() {
        delayHistory.clear(); stopBoost(performance.now());
        triggerConfirmCount = 0; lowBufferCount = 0;
        lastSetRate = -1; lastRateStr = '1.000x';
    }

    function onExternalRateChange() {
        if (performance.now() - lastSetRateTime < TUNING.RATE_PROTECT_MS) return;
        if (!video) return;
        const ext = video.playbackRate;
        if (Math.abs(ext - lastSetRate) < 0.002) return;
        if (boostActive) { boostActive = false; boostEndTime = performance.now(); }
        triggerConfirmCount = 0;
        effectiveRate = ext; lastSetRate = ext;
        lastRateStr = ext.toFixed(3) + 'x';
    }

    function checkFrameDrops() {
        if (!hasPlaybackQuality || !video) return;
        const q = video.getVideoPlaybackQuality();
        const dd = q.droppedVideoFrames - lastDroppedFrames;
        const td = q.totalVideoFrames - lastTotalFrames;
        lastDroppedFrames = q.droppedVideoFrames;
        lastTotalFrames = q.totalVideoFrames;
        if (debugVisible) _cachedDropInfo = ` d:${q.droppedVideoFrames}/${q.totalVideoFrames}`;
        if (td < 10) return;
        if (dd / td > TUNING.DROP_RATE_THRESHOLD && boostActive) {
            stopBoost(performance.now());
            boostEndTime = performance.now() + 8000;
        }
    }

    function resetState() {
        if (seekAc) { seekAc.abort(); seekAc = null; }
        lastRenderedMediaTime = 0; lastCurrentTime = 0; stallCount = 0; wasPaused = false;
        effectiveRate = 1.0; lastSetRate = -1; lastRateStr = '1.000x';
        lastSpikeTime = 0; skipReason = ''; _cachedDropInfo = ''; frameCheckCounter = 0;
        boostActive = false; boostStartTime = 0; boostEndTime = 0;
        triggerConfirmCount = 0; lowBufferCount = 0;
        seekCount = 0; lastSeekReason = '';
        delayHistory.clear();
        warmupDone = false; warmupStartTime = performance.now();
        warmupEnd = warmupStartTime + TUNING.WARMUP_MS;
    }

    /* ── 비디오 연결 ── */
    function attachVideo(v) {
        if (video && video !== v) video.removeEventListener('ratechange', onExternalRateChange);
        video = v; lastVideoSrc = v.currentSrc || v.src || '';
        lastVideoIsBlob = isBlobSrc(v);
        resetState(); startFrameCallback(v);
        const q = v.getVideoPlaybackQuality?.();
        if (q) { hasPlaybackQuality = true; lastDroppedFrames = q.droppedVideoFrames; lastTotalFrames = q.totalVideoFrames; }
        else { hasPlaybackQuality = false; lastDroppedFrames = lastTotalFrames = 0; }
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
                const ns = v.currentSrc || v.src || '';
                if (ns !== lastVideoSrc && isBlobSrc(v)) attachVideo(v);
            });
        }
    }

    let videoObs = null;
    function setupVideoObserver() {
        if (videoObs) return;
        videoObs = new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n.nodeName === 'VIDEO') { onVideoFound(n); if (video) { videoObs.disconnect(); videoObs = null; } return; }
                if (n.nodeType === 1) { const v = n.querySelector?.('video'); if (v) { onVideoFound(v); if (video) { videoObs.disconnect(); videoObs = null; } return; } }
            }
        });
        videoObs.observe(document.body, { childList: true, subtree: true });
    }
    function ensureVideoObserver() { if (!video && !videoObs) setupVideoObserver(); }

    /* ── seek ── */
    function doSeek(bufStart, bufEnd, reason) {
        if (seekAc) seekAc.abort();
        const ac = seekAc = new AbortController();
        const combined = AbortSignal.any([ac.signal, AbortSignal.timeout(5000)]);
        const vid = video;
        const to = Math.max(bufStart, bufEnd - targetDelayMs / 1000);
        seekCount++; lastSeekReason = reason; lastSeekTime = performance.now();
        vid.currentTime = to;
        vid.addEventListener('seeked', () => {
            if (vid !== video || !vid.isConnected) { ac.abort(); return; }
            const ct = setTimeout(() => {
                ac.abort();
                if (vid !== video || !vid.isConnected) return;
                const e = getBufferEdge(vid.buffered);
                if (e && (e.end - vid.currentTime) * 1000 > targetDelayMs * 1.5)
                    vid.currentTime = Math.max(e.start, e.end - targetDelayMs / 1000);
            }, 50);
            combined.addEventListener('abort', () => clearTimeout(ct), { once: true });
        }, { once: true, signal: combined });
    }

    function doManualSync() {
        if (!video || !video.buffered.length) return false;
        const e = getBufferEdge(video.buffered);
        if (!e) return false;
        doSeek(e.start, e.end, 'manual');
        softReset(); applyRate(1.0);
        flashStyle(els.delayVal, 'textShadow', '0 0 8px #3498db', 800);
        return true;
    }

    /* ── 디스플레이 ── */
    const displayApply = Object.create(null);
    const displayState = {};
    const dirty = new Set();
    let rafId = null;

    function initDisplayApply() {
        displayApply.d   = v => { els.delayVal.textContent = v; };
        displayApply.r   = v => { els.rateVal.textContent = v; };
        displayApply.c   = v => { els.delayVal.style.color = v; els.barFill.style.background = v; };
        displayApply.w   = v => { els.barFill.style.width = v; };
        displayApply.rb  = v => { els.rateBar.style.width = v; };
        displayApply.rbc = v => { els.rateBar.style.background = v; };
        displayApply.rc  = v => { els.rateVal.style.color = v || ''; };
        displayApply.dbg = v => { els.debugVal.textContent = v; };
    }

    function setD(k, v) { if (displayState[k] !== v) { displayState[k] = v; dirty.add(k); } }

    function flushDisplay() {
        if (!els.delayVal || dirty.size === 0) return;
        for (const k of dirty) { const fn = displayApply[k]; if (fn) fn(displayState[k]); }
        dirty.clear();
    }

    function getStatusIcon(avg) {
        if (!warmupDone) return ' ⏳';
        if (!isEnabled) return ' ⏹';
        if (boostActive) return ' ⚡';
        if (Math.abs(avg - targetDelayMs) < TUNING.TRIGGER_MARGIN_MS) return ' ✓';
        const d = avg - prevAvg;
        return Math.abs(d) < 80 ? ' →' : (d > 0 ? ' ↑' : ' ↓');
    }

    function updateDot(avgMs) {
        if (panelOpen || !els.dot) return;
        const c = !isEnabled ? '#555' : computeColor(avgMs - targetDelayMs);
        if (c !== lastDotColor) {
            lastDotColor = c;
            els.dot.style.background = c;
            els.dot.style.boxShadow = isEnabled ? `0 0 6px ${c}` : 'none';
        }
        els.dot.classList.toggle('dm-dot-off', !isEnabled);
    }

    function updateDisplay(avgMs, bufEnd = -1) {
        if (!panelOpen) { updateDot(avgMs); return; }
        const si = getStatusIcon(avgMs);
        prevAvg = avgMs;

        setD('d', (avgMs / 1000).toFixed(2) + 's' + si);
        setD('r', lastRateStr);
        setD('c', computeColor(avgMs - targetDelayMs));
        setD('w', pct(avgMs, 8000));

        if (boostActive) { setD('rb', '100%'); setD('rbc', '#f39c12'); setD('rc', '#f39c12'); }
        else { setD('rb', '0%'); setD('rbc', '#3498db'); setD('rc', ''); }

        if (debugVisible && els.debugVal) setD('dbg', buildDebug(bufEnd));

        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = null; flushDisplay();
            if (debugVisible) drawGraph();
        });
    }

    /* ── 그래프 ── */
    let graphCanvas = null, graphCtx = null;

    function drawGraph() {
        if (!graphCanvas || !graphCtx || !graphHistory) return;
        const n = graphHistory.copyTo(_graphBuf);
        if (n < 2) return;
        const w = graphCanvas.width, h = graphCanvas.height;
        graphCtx.clearRect(0, 0, w, h);

        graphCtx.lineWidth = 1;
        graphCtx.setLineDash([3, 3]);
        // target
        const ty = h - (targetDelayMs / 8000) * h;
        graphCtx.strokeStyle = 'rgba(255,255,255,.15)';
        graphCtx.beginPath(); graphCtx.moveTo(0, ty); graphCtx.lineTo(w, ty); graphCtx.stroke();
        // trigger
        const try_ = h - ((targetDelayMs + TUNING.TRIGGER_MARGIN_MS) / 8000) * h;
        graphCtx.strokeStyle = 'rgba(241,196,15,.2)';
        graphCtx.beginPath(); graphCtx.moveTo(0, try_); graphCtx.lineTo(w, try_); graphCtx.stroke();

        graphCtx.setLineDash([]);
        graphCtx.fillStyle = 'rgba(255,255,255,.3)';
        graphCtx.font = '8px system-ui';
        graphCtx.fillText((targetDelayMs / 1000).toFixed(1) + 's', 2, ty - 2);

        graphCtx.lineWidth = 1.5; graphCtx.strokeStyle = '#2ecc71';
        graphCtx.beginPath();
        const xs = w / (graphHistory.cap - 1);
        for (let i = 0; i < n; i++) {
            const x = i * xs, y = h - clamp(_graphBuf[i] / 8000, 0, 1) * h;
            i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
        }
        graphCtx.stroke();
    }

    function buildDebug(bufEnd) {
        if (!video) return '…';
        const now = performance.now();
        const ba = bufEnd >= 0 ? (bufEnd - video.currentTime).toFixed(1) : '-';
        let s = `${video.paused ? '⏸' : '▶'} buf:${ba}s rate:${effectiveRate.toFixed(3)} boost:${boostActive ? 'ON' : 'OFF'}`;
        if (boostActive) s += `(${((now - boostStartTime) / 1000).toFixed(1)}s)`;
        else if (boostEndTime > 0) {
            const cd = Math.max(0, TUNING.BOOST_COOLDOWN - (now - boostEndTime));
            if (cd > 0) s += ` cd:${(cd / 1000).toFixed(1)}`;
        }
        s += ` conf:${triggerConfirmCount}/${TUNING.CONFIRM_TICKS} seek:${seekCount}`;
        if (lastSeekReason) s += `(${lastSeekReason})`;
        s += ` stall:${stallCount} lowBuf:${lowBufferCount} fps:${estimatedFps}`;
        if (_cachedDropInfo) s += _cachedDropInfo;
        if (skipReason) s += ` [${skipReason}]`;
        if (!warmupDone) s += ' [WARMUP]';
        return s;
    }

    /* ── 핵심 루프 ── */
    function processLiveVideo() {
        const now = performance.now();

        if (!isWarmedUp()) {
            const e = getBufferEdge(video.buffered);
            if (e) updateDisplay(Math.max(0, (e.end - video.currentTime) * 1000 + PLATFORM_OFFSET), e.end);
            else updateDisplay(0);
            if (debugVisible) skipReason = 'WARMUP';
            return;
        }

        if (debugVisible) skipReason = '';
        if (++frameCheckCounter % TUNING.FRAME_CHECK_EVERY === 0) checkFrameDrops();

        const edge = getBufferEdge(video.buffered);
        if (!edge) { updateDisplay(0); return; }
        const { start: bufStart, end: bufEnd } = edge;

        const fd = 1 / estimatedFps;
        const useMedia = lastRenderedMediaTime > 0 && Math.abs(lastRenderedMediaTime - video.currentTime) < fd * 3;
        const ref = useMedia ? lastRenderedMediaTime : video.currentTime;
        const raw = (bufEnd - ref) * 1000;
        if (raw < 0) { updateDisplay(0, bufEnd); return; }
        const delayMs = raw + PLATFORM_OFFSET;
        const bufAhead = bufEnd - video.currentTime;

        // 버퍼 부족 → boost 중단
        if (bufAhead < TUNING.MIN_BUFFER_SEC) {
            lowBufferCount++;
            if (boostActive) { stopBoost(now); boostEndTime = now + 8000; }
        } else { lowBufferCount = 0; }

        // 스톨
        const ct = video.currentTime;
        if (Math.abs(ct - lastCurrentTime) < 0.001 && !video.paused) {
            stallCount++;
            if (stallCount >= TUNING.STALL_RECOVER_COUNT && isEnabled) {
                const se = getBufferEdge(video.buffered);
                if (se) { doSeek(se.start, se.end, 'stall'); softReset(); applyRate(1.0); }
                stallCount = 0;
            }
        } else { stallCount = 0; }
        lastCurrentTime = ct;
        if (wasPaused && !video.paused) { wasPaused = false; lastSetRate = -1; }
        wasPaused = video.paused;

        // 자동 seek
        if (isEnabled && delayMs > seekThresholdMs && stallCount < TUNING.STALL_THRESHOLD) {
            if (now - lastSeekTime >= TUNING.SEEK_COOLDOWN_MS) {
                doSeek(bufStart, bufEnd, 'auto');
                softReset(); applyRate(1.0);
                flashStyle(els.delayVal, 'textShadow', '0 0 8px #3498db', 800);
                updateDisplay(targetDelayMs, bufEnd);
                return;
            }
        }

        // 스파이크
        const ld = delayHistory.last;
        if (ld > 0 && Math.abs(delayMs - ld) > TUNING.SPIKE_THRESHOLD_MS && now - lastSpikeTime >= TUNING.SPIKE_COOLDOWN_MS) {
            lastSpikeTime = now;
            updateDisplay(prevAvg > 0 ? prevAvg : targetDelayMs, bufEnd);
            return;
        }

        delayHistory.push(delayMs);
        if (debugVisible && graphHistory) graphHistory.push(delayMs);
        const avg = getStableAverage();
        updateDisplay(avg, bufEnd);

        if (!isEnabled) {
            if (boostActive) stopBoost(now);
            if (effectiveRate !== 1.0) applyRate(1.0);
            return;
        }

        // Burst
        const triggerMs = targetDelayMs + TUNING.TRIGGER_MARGIN_MS;
        const settleMs = targetDelayMs + TUNING.SETTLE_MARGIN_MS;

        if (boostActive) {
            const dur = now - boostStartTime;
            if ((avg <= settleMs && dur >= TUNING.BOOST_MIN_DURATION) || avg < targetDelayMs - 300 || dur >= TUNING.BOOST_MAX_DURATION) {
                stopBoost(now); return;
            }
        } else {
            const cdOk = (now - boostEndTime) >= TUNING.BOOST_COOLDOWN;
            if (avg > triggerMs && cdOk && bufAhead >= TUNING.MIN_BUFFER_SEC + 1.0) triggerConfirmCount++;
            else triggerConfirmCount = 0;
            if (triggerConfirmCount >= TUNING.CONFIRM_TICKS) { triggerConfirmCount = 0; startBoost(now); }
        }
    }

    function tick() {
        if (video && !video.isConnected) {
            video.removeEventListener('ratechange', onExternalRateChange);
            video = null; lastVideoIsBlob = false; ensureVideoObserver();
        }
        if (!video) { const v = document.querySelector('video'); if (v) onVideoFound(v); updateDisplay(0); return; }
        if (!lastVideoIsBlob || !isLiveStream(video)) {
            if (boostActive) stopBoost(performance.now());
            if (effectiveRate !== 1.0) applyRate(1.0);
            updateDisplay(0); return;
        }
        processLiveVideo();
    }

    function scheduleTick() {
        const gen = tickGen, now = performance.now();
        try { tick(); } catch (e) { console.warn('[딜레이미터]', e); }
        if (gen !== tickGen) return;
        if (document.hidden) { nextTickTime = 0; intervalId = setTimeout(scheduleTick, 1000); return; }
        const iv = !isEnabled || !warmupDone ? 700 : TUNING.CHECK_INTERVAL;
        if (nextTickTime === 0) nextTickTime = now + iv;
        else nextTickTime += iv;
        if (nextTickTime - performance.now() < -iv * 2) nextTickTime = performance.now() + iv;
        intervalId = setTimeout(scheduleTick, Math.max(1, nextTickTime - performance.now()));
    }

    /* ── UI ── */
    function createPanel() {
        if (document.getElementById('dm-dot')) return;
        GM_addStyle(`
@layer dm {
#dm-dot{position:fixed;bottom:20px;right:20px;z-index:10000;width:14px;height:14px;border-radius:50%;cursor:pointer;background:#555;transition:background .3s,box-shadow .3s}
@keyframes dm-pulse{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.35);opacity:1}}
#dm-dot:not(.dm-dot-off){animation:dm-pulse 2s ease-in-out infinite}
#dm-dot.dm-dot-off{opacity:.4}
#dm-tip{position:fixed;z-index:10001;background:rgba(0,0,0,.85);color:#eee;font:bold 11px ui-monospace,monospace;padding:3px 7px;border-radius:4px;pointer-events:none;opacity:0;transition:opacity .15s;white-space:nowrap}
#dm-panel{position:fixed;bottom:20px;right:20px;z-index:10000;background:rgba(12,12,16,.92);backdrop-filter:blur(3px);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 16px;color:#eee;font-family:system-ui,sans-serif;font-size:12px;width:220px;box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;display:none}
#dm-panel [data-dm="header"]{font-weight:bold;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:8px;cursor:grab;display:flex;align-items:center;gap:6px}
.dm-row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
.dm-val{font-weight:bold;font-family:ui-monospace,monospace;font-size:15px;font-variant-numeric:tabular-nums}
.dm-bar-bg{position:relative;background:rgba(255,255,255,.08);height:5px;border-radius:3px;margin:4px 0 8px;overflow:visible}
.dm-bar-clip{overflow:hidden;height:100%;border-radius:3px}
.dm-bar{height:100%;width:0%;min-width:2%;border-radius:3px;transition:width .3s ease}
.dm-target-mark{position:absolute;top:-2px;bottom:-2px;width:2px;border-radius:1px;pointer-events:none;background:#fff;opacity:.5;transition:left .3s ease}
.dm-rate-bar{height:100%;width:0%;border-radius:3px;transition:width .3s ease,background .3s ease}
.dm-slider-row{margin:10px 0 4px;display:flex;align-items:center;gap:8px;font-size:11px}
.dm-slider-row input[type=range]{flex:1;height:4px;-webkit-appearance:none;background:rgba(255,255,255,.12);border-radius:2px;outline:none}
.dm-slider-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#2ecc71;cursor:pointer}
.dm-slider-label{min-width:32px;text-align:center;font-family:ui-monospace,monospace;font-size:12px;font-weight:bold}
.dm-btns{display:flex;gap:4px;margin-top:6px}
.dm-btn{cursor:pointer;border:none;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:bold;transition:.1s}
.dm-btn:active{transform:scale(.95)}
.dm-btn-on{background:#2ecc71;color:#000}
.dm-btn-off{background:#555;color:#999}
.dm-btn-sync{background:#2980b9;color:#fff}
#dm-panel.dm-disabled{filter:brightness(0.65)}
.dm-close{margin-left:auto;cursor:pointer;font-size:14px;opacity:.4;padding:0 4px;line-height:1;transition:opacity .15s}
.dm-close:hover{opacity:.9}
.dm-debug{font-size:9px;color:#666;font-family:monospace;margin-top:8px;border-top:1px solid #2a2a2a;padding-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}
.dm-platform{font-size:9px;opacity:.35;margin-left:auto}
}`);

        const dot = document.createElement('div'); dot.id = 'dm-dot'; document.body.appendChild(dot);
        const tip = document.createElement('div'); tip.id = 'dm-tip'; document.body.appendChild(tip);
        const panel = document.createElement('div'); panel.id = 'dm-panel';

        const savedSlider = targetMsToSlider(targetDelayMs);

        panel.innerHTML = `
<div data-dm="header">딜레이 미터기 <span data-dm="ver" style="font-weight:normal;font-size:10px;opacity:.5;display:none">v${GM_info.script.version}</span><span class="dm-close" data-dm="close">✕</span></div>
<div class="dm-row"><span>버퍼</span><span data-dm="delay" class="dm-val" style="cursor:pointer" title="클릭: 동기화">-</span></div>
<div class="dm-bar-bg"><div class="dm-bar-clip"><div data-dm="bar" class="dm-bar"></div></div><div data-dm="targetmark" class="dm-target-mark"></div></div>
<div class="dm-row"><span>배속</span><span data-dm="rate" class="dm-val">1.000x</span></div>
<div class="dm-bar-bg"><div class="dm-bar-clip"><div data-dm="ratebar" class="dm-rate-bar"></div></div></div>
<div class="dm-slider-row"><span style="opacity:.5">저지연</span><input type="range" data-dm="slider" min="0" max="100" value="${savedSlider}"><span style="opacity:.5">안정</span></div>
<div style="text-align:center;margin-bottom:6px"><span data-dm="slabel" class="dm-slider-label">${(targetDelayMs/1000).toFixed(1)}초</span></div>
<div class="dm-btns"><button data-dm="toggle" class="dm-btn">ON</button><button data-dm="sync" class="dm-btn dm-btn-sync" title="Alt+S">⟳ 동기화</button><span class="dm-platform">${PLATFORM_TAG}</span></div>
<div class="dm-debug" data-dm="debug"></div>`;
        document.body.appendChild(panel);

        const map = {};
        for (const el of panel.querySelectorAll('[data-dm]')) map[el.dataset.dm] = el;
        els = {
            panel, dot, tip,
            delayVal: map.delay, rateVal: map.rate, barFill: map.bar,
            rateBar: map.ratebar, targetMark: map.targetmark,
            toggleBtn: map.toggle, syncBtn: map.sync,
            slider: map.slider, sliderLabel: map.slabel,
            header: map.header, debugVal: map.debug, ver: map.ver,
            closeBtn: map.close,
        };

        initDisplayApply();

        // dot tooltip
        dot.addEventListener('pointerenter', () => {
            if (panelOpen) return;
            tip.textContent = isEnabled
                ? `${(prevAvg / 1000).toFixed(1)}s → ${(targetDelayMs / 1000).toFixed(1)}s ${lastRateStr}${boostActive ? ' ⚡' : ''}`
                : 'OFF';
            const r = dot.getBoundingClientRect();
            const tw = tip.offsetWidth;
            tip.style.left = ((r.left - tw - 8 >= 0) ? r.left - tw - 8 : r.right + 8) + 'px';
            tip.style.top = clamp(r.top + r.height / 2 - tip.offsetHeight / 2, 0, innerHeight - tip.offsetHeight) + 'px';
            tip.style.opacity = '1';
        });
        dot.addEventListener('pointerleave', () => { tip.style.opacity = '0'; });

        els.closeBtn.addEventListener('click', e => { e.stopPropagation(); closePanel(); });

        els.delayVal.onclick = () => {
            if (!doManualSync()) flashStyle(els.delayVal, 'textShadow', '0 0 8px #e74c3c', 400);
        };

        // toggle
        updateToggleUI();
        els.toggleBtn.onclick = () => {
            isEnabled = !isEnabled;
            if (!isEnabled) { stopBoost(performance.now()); applyRate(1.0); }
            saveConfig({ isEnabled });
            updateToggleUI();
            flashStyle(els.panel, 'borderColor', isEnabled ? '#2ecc71' : '#e74c3c', 600);
        };

        els.syncBtn.onclick = () => {
            if (!doManualSync()) flashStyle(els.syncBtn, 'background', '#c0392b', 400);
        };

        // slider
        els.slider.addEventListener('input', () => {
            const ms = sliderToTargetMs(parseInt(els.slider.value));
            targetDelayMs = ms;
            seekThresholdMs = calcSeekThreshold(ms);
            els.sliderLabel.textContent = (ms / 1000).toFixed(1) + '초';
            updateTargetMark();
            softReset(); applyRate(1.0);
        });
        els.slider.addEventListener('change', () => {
            saveConfig({ targetDelayMs });
        });

        updateTargetMark();

        // debug
        debugVisible = loadConfig().debugVisible ?? false;
        applyDebug();

        els.header.title = 'Alt+D:토글  Alt+S:동기화  Alt+H:닫기  Alt+G:디버그';

        // graph
        graphCanvas = document.createElement('canvas');
        graphCanvas.width = 190; graphCanvas.height = 28;
        graphCanvas.style.cssText = 'display:none;margin:6px 0 2px;border-radius:4px;background:rgba(255,255,255,.03)';
        els.debugVal.after(graphCanvas);
        graphCtx = graphCanvas.getContext('2d');

        // 초기 상태 복원
        panelOpen = loadConfig().panelOpen ?? false;
        if (panelOpen) { panel.style.display = 'block'; dot.style.display = 'none'; }
        else { panel.style.display = 'none'; dot.style.display = 'block'; }

        makeDraggable(panel);
        makeDotDraggable(dot);
    }

    function updateToggleUI() {
        if (!els.toggleBtn) return;
        els.toggleBtn.textContent = isEnabled ? 'ON' : 'OFF';
        els.toggleBtn.classList.toggle('dm-btn-on', isEnabled);
        els.toggleBtn.classList.toggle('dm-btn-off', !isEnabled);
        if (els.panel) els.panel.classList.toggle('dm-disabled', !isEnabled);
    }

    function updateTargetMark() {
        if (els.targetMark) els.targetMark.style.left = pct(targetDelayMs, 8000);
    }

    function applyDebug() {
        if (!els.debugVal) return;
        const vis = debugVisible ? '' : 'none';
        els.debugVal.style.display = vis;
        if (graphCanvas) graphCanvas.style.display = vis;
        if (els.ver) els.ver.style.display = vis;
        if (debugVisible && !graphHistory) graphHistory = new RingBuffer(60, Uint16Array);
    }

    function openPanel() {
        if (panelOpen) return;
        panelOpen = true; saveConfig({ panelOpen: true });
        els.dot.style.display = 'none'; els.panel.style.display = 'block';
        requestAnimationFrame(() => {
            const r = els.panel.getBoundingClientRect();
            if (r.left < 0) els.panel.style.left = '8px';
            if (r.top < 0) els.panel.style.top = '8px';
            if (r.right > innerWidth) els.panel.style.left = Math.max(0, innerWidth - r.width - 8) + 'px';
            if (r.bottom > innerHeight) els.panel.style.top = Math.max(0, innerHeight - r.height - 8) + 'px';
        });
        lastDotColor = '';
        for (const k in displayState) dirty.add(k);
    }

    function closePanel() {
        if (!panelOpen) return;
        panelOpen = false; saveConfig({ panelOpen: false });
        const r = els.panel.getBoundingClientRect();
        els.panel.style.display = 'none'; els.dot.style.display = 'block';
        const dx = clamp(r.right - 20, 0, innerWidth - 14);
        const dy = clamp(r.top + 6, 0, innerHeight - 14);
        Object.assign(els.dot.style, { left: dx + 'px', top: dy + 'px', right: 'auto', bottom: 'auto' });
        saveConfig({ dotX: dx + 'px', dotY: dy + 'px' });
        lastDotColor = '';
    }

    function togglePanel() { panelOpen ? closePanel() : openPanel(); }

    function makeDraggable(panel) {
        const h = els.header;
        let ox = 0, oy = 0, dragging = false;
        h.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target === els.closeBtn) return;
            dragging = true; h.setPointerCapture(e.pointerId);
            const r = panel.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
            h.style.cursor = 'grabbing';
        });
        h.addEventListener('pointermove', e => {
            if (!dragging) return;
            panel.style.left = clamp(e.clientX - ox, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(e.clientY - oy, 0, innerHeight - panel.offsetHeight) + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
        });
        const end = () => { if (!dragging) return; dragging = false; h.style.cursor = 'grab'; saveConfig({ panelX: panel.style.left, panelY: panel.style.top }); };
        h.addEventListener('pointerup', end); h.addEventListener('lostpointercapture', end);
        const s = loadConfig();
        if (s.panelX != null) {
            const x = parseFloat(s.panelX), y = parseFloat(s.panelY);
            if (x >= 0 && x < innerWidth - 50 && y >= 0 && y < innerHeight - 50)
                Object.assign(panel.style, { left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto' });
        }
    }

    function makeDotDraggable(dot) {
        let ox = 0, oy = 0, dragging = false, moved = false;
        dot.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            dragging = true; moved = false; dot.setPointerCapture(e.pointerId);
            const r = dot.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
        });
        dot.addEventListener('pointermove', e => {
            if (!dragging) return; moved = true;
            dot.style.left = clamp(e.clientX - ox, 0, innerWidth - 14) + 'px';
            dot.style.top = clamp(e.clientY - oy, 0, innerHeight - 14) + 'px';
            dot.style.right = 'auto'; dot.style.bottom = 'auto';
        });
        dot.addEventListener('pointerup', () => { if (!dragging) return; dragging = false; if (moved) saveConfig({ dotX: dot.style.left, dotY: dot.style.top }); });
        dot.addEventListener('click', () => { if (moved) { moved = false; return; } openPanel(); });
        const s = loadConfig();
        if (s.dotX != null) {
            const x = parseFloat(s.dotX), y = parseFloat(s.dotY);
            if (x >= 0 && x < innerWidth - 14 && y >= 0 && y < innerHeight - 14)
                Object.assign(dot.style, { left: s.dotX, top: s.dotY, right: 'auto', bottom: 'auto' });
        }
    }

    function clampPanelPos() {
        if (!els.panel?.style.left) return;
        const p = els.panel, x = parseFloat(p.style.left), y = parseFloat(p.style.top);
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const mx = innerWidth - p.offsetWidth, my = innerHeight - p.offsetHeight;
        if (x > mx || y > my || x < 0 || y < 0) { p.style.left = clamp(x, 0, mx) + 'px'; p.style.top = clamp(y, 0, my) + 'px'; }
    }

    /* ── 단축키 ── */
    const SHORTCUTS = new Map([
        ['KeyD', () => els.toggleBtn?.click()],
        ['KeyH', () => togglePanel()],
        ['KeyS', () => doManualSync()],
        ['KeyG', () => { debugVisible = !debugVisible; applyDebug(); saveConfig({ debugVisible }); }],
        ['KeyR', () => { resetState(); if (video) applyRate(1.0); }],
        ['ArrowUp', () => { els.slider.value = Math.min(100, parseInt(els.slider.value) + 10); els.slider.dispatchEvent(new Event('input')); els.slider.dispatchEvent(new Event('change')); }],
        ['ArrowDown', () => { els.slider.value = Math.max(0, parseInt(els.slider.value) - 10); els.slider.dispatchEvent(new Event('input')); els.slider.dispatchEvent(new Event('change')); }],
    ]);

    /* ── init ── */
    function init() {
        createPanel();
        setupVideoObserver();
        document.addEventListener('play', e => { if (e.target?.tagName === 'VIDEO') onVideoFound(e.target); }, true);
        const v = document.querySelector('video'); if (v) onVideoFound(v);
        scheduleTick();

        if ('navigation' in window) {
            navigation.addEventListener('navigatesuccess', () => { if (location.pathname !== lastPath) { lastPath = location.pathname; resetState(); ensureVideoObserver(); } });
        } else {
            setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; resetState(); ensureVideoObserver(); } }, 1000);
        }

        window.addEventListener('resize', () => { clearTimeout(clampPanelPos._t); clampPanelPos._t = setTimeout(clampPanelPos, 150); });

        document.addEventListener('fullscreenchange', () => {
            requestAnimationFrame(() => {
                if (!els.panel) return;
                const def = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
                if (document.fullscreenElement) Object.assign(els.panel.style, def);
                else {
                    const s = loadConfig();
                    Object.assign(els.panel.style, s.panelX != null ? { left: s.panelX, top: s.panelY, right: 'auto', bottom: 'auto' } : def);
                    clampPanelPos();
                }
            });
        });

        document.addEventListener('visibilitychange', () => {
            nextTickTime = 0; tickGen++; clearTimeout(intervalId);
            if (document.hidden) { hiddenAt = performance.now(); return; }
            const away = performance.now() - hiddenAt;
            resetState();
            if (away > 30000 && isEnabled && video?.isConnected && video.buffered.length > 0) {
                const e = getBufferEdge(video.buffered);
                if (e && (e.end - video.currentTime) * 1000 > seekThresholdMs) {
                    doSeek(e.start, e.end, 'tab'); warmupDone = true;
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
