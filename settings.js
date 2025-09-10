// ==UserScript==
// @name         Video_Image_Control (with Advanced Audio & Video FX)
// @namespace    https://com/
// @version      96.3
// @description  딜미터기 개선 (PID 제어 도입 / 동적 EMA (Exponential Moving Average) 적용)
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let uiContainer = null, triggerElement = null, speedButtonsContainer = null, titleObserver = null;
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const TARGET_DELAYS = {"youtube.com": 10000, "play.sooplive.co.kr": 2500, "chzzk.naver.com": 2500 };
    const DEFAULT_TARGET_DELAY = 2000;

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 10 : 4,
        DEFAULT_VIDEO_FILTER_LEVEL_2: isMobile ? 10 : 2,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 10 : 4,
        DEFAULT_WIDENING_ENABLED: false,
        DEFAULT_WIDENING_FACTOR: 1.0,
        DEFAULT_STEREO_PAN: 0,
        DEFAULT_HPF_ENABLED: false,
        EFFECTS_HPF_FREQUENCY: 20,
        DEFAULT_EQ_ENABLED: false,
        DEFAULT_EQ_SUBBASS_GAIN: 0,
        DEFAULT_EQ_BASS_GAIN: 0,
        DEFAULT_EQ_MID_GAIN: 0,
        DEFAULT_EQ_TREBLE_GAIN: 0,
        DEFAULT_EQ_PRESENCE_GAIN: 0,
        DEFAULT_ADAPTIVE_WIDTH_ENABLED: false,
        DEFAULT_ADAPTIVE_WIDTH_FREQ: 150,
        DEFAULT_REVERB_ENABLED: false,
        DEFAULT_REVERB_MIX: 0.3,
        DEFAULT_PRE_GAIN_ENABLED: false,
        DEFAULT_PRE_GAIN: 1.0,
        DEFAULT_BASS_BOOST_GAIN: 0,
        DEFAULT_VIDEO_SHARPEN_DIRECTION: '4-way',
        AUTODELAY_EMA_ALPHA: 0.15,

        DEFAULT_DEESSER_ENABLED: false,
        DEFAULT_DEESSER_THRESHOLD: -30,
        DEFAULT_DEESSER_FREQ: 8000,
        DEFAULT_EXCITER_ENABLED: false,
        DEFAULT_EXCITER_AMOUNT: 0,
        DEFAULT_PARALLEL_COMP_ENABLED: false,
        DEFAULT_PARALLEL_COMP_MIX: 0,
        DEFAULT_LIMITER_ENABLED: false,
        DEFAULT_MASTERING_SUITE_ENABLED: false,

        DEBUG: false, DEBOUNCE_DELAY: 300, THROTTLE_DELAY: 100, MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05, SEEK_TIME_MAX_SEC: 15, IMAGE_MIN_SIZE: 355, VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [2.0, 1.5, 1.2, 1, 0.5, 0.2], UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'youtube.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
        LIVE_JUMP_WHITELIST: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'ok.ru', 'bigo.tv', 'chaturbate.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com', 'challenges.cloudflare.com'],
        SPECIFIC_EXCLUSIONS: [],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 104 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 104 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'] }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] } },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
    };

    const UI_SELECTORS = {
        HOST: 'vsc-ui-host', CONTAINER: 'vsc-container', TRIGGER: 'vsc-trigger-button',
        CONTROL_GROUP: 'vsc-control-group', SUBMENU: 'vsc-submenu', BTN: 'vsc-btn', BTN_MAIN: 'vsc-btn-main',
        SELECT: 'vsc-select',
    };

    const state = {};

    function makeTransientCurve(amount) {
        const samples = 44100;
        const curve = new Float32Array(samples);
        const k = 2 * amount / (1 - amount || 1e-6);
        for (let i = 0; i < samples; i++) {
            const x = i * 2 / samples - 1;
            curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
        }
        return curve;
    }

    function getTargetDelay() {
    for (const site in TARGET_DELAYS) {
        if (location.href.includes(site)) {
            return TARGET_DELAYS[site];
        }
    }
    return DEFAULT_TARGET_DELAY;
}


    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 20 },
            videoFilterLevel2: { name: '기본 영상 디테일', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2, type: 'number', min: 0, max: 20 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 20 },
            autoRefresh: { name: 'CORS 오류 시 자동 새로고침', default: true, type: 'boolean' }
        };
        function init() { Object.keys(definitions).forEach(key => { settings[key] = definitions[key].default; }); }
        return { init, get: (key) => settings[key], set: (key, value) => { settings[key] = value; }, definitions };
    })();
    settingsManager.init();

    function resetState() {
        Object.keys(state).forEach(key => delete state[key]);
        const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;

        Object.assign(state, {
            media: {
                activeMedia: new Set(),
                processedMedia: new WeakSet(),
                activeImages: new Set(),
                processedImages: new WeakSet(),
                mediaListenerMap: new WeakMap(),
                currentlyVisibleMedia: null,
                mediaTypesEverFound: { video: false, image: false },
            },
            videoFilter: {
                currentVideoFilterLevel: settingsManager.get('videoFilterLevel') || CONFIG.DEFAULT_VIDEO_FILTER_LEVEL,
                currentVideoFilterLevel2: settingsManager.get('videoFilterLevel2') || CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
                currentVideoGamma: parseFloat(videoDefaults.GAMMA_VALUE),
                currentVideoBlur: parseFloat(videoDefaults.BLUR_STD_DEVIATION),
                currentVideoShadows: parseInt(videoDefaults.SHADOWS_VALUE, 10),
                currentVideoHighlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10),
                currentVideoSaturation: parseInt(videoDefaults.SATURATION_VALUE, 10),
                currentVideoSharpenDirection: CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION,
            },
            imageFilter: {
                currentImageFilterLevel: settingsManager.get('imageFilterLevel') || CONFIG.DEFAULT_IMAGE_FILTER_LEVEL,
            },
            audio: {
                audioContextMap: new WeakMap(),
                audioInitialized: false,
                isHpfEnabled: CONFIG.DEFAULT_HPF_ENABLED,
                currentHpfHz: CONFIG.EFFECTS_HPF_FREQUENCY,
                isEqEnabled: CONFIG.DEFAULT_EQ_ENABLED,
                eqSubBassGain: CONFIG.DEFAULT_EQ_SUBBASS_GAIN,
                eqBassGain: CONFIG.DEFAULT_EQ_BASS_GAIN,
                eqMidGain: CONFIG.DEFAULT_EQ_MID_GAIN,
                eqTrebleGain: CONFIG.DEFAULT_EQ_TREBLE_GAIN,
                eqPresenceGain: CONFIG.DEFAULT_EQ_PRESENCE_GAIN,
                bassBoostGain: CONFIG.DEFAULT_BASS_BOOST_GAIN,
                bassBoostFreq: 60,
                bassBoostQ: 1.0,
                isWideningEnabled: CONFIG.DEFAULT_WIDENING_ENABLED,
                currentWideningFactor: CONFIG.DEFAULT_WIDENING_FACTOR,
                isAdaptiveWidthEnabled: CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED,
                adaptiveWidthFreq: CONFIG.DEFAULT_ADAPTIVE_WIDTH_FREQ,
                isReverbEnabled: CONFIG.DEFAULT_REVERB_ENABLED,
                reverbMix: CONFIG.DEFAULT_REVERB_MIX,
                currentStereoPan: CONFIG.DEFAULT_STEREO_PAN,
                isPreGainEnabled: CONFIG.DEFAULT_PRE_GAIN_ENABLED,
                currentPreGain: CONFIG.DEFAULT_PRE_GAIN,
                lastManualPreGain: CONFIG.DEFAULT_PRE_GAIN,
                isAnalyzingLoudness: false,
                isDeesserEnabled: CONFIG.DEFAULT_DEESSER_ENABLED,
                deesserThreshold: CONFIG.DEFAULT_DEESSER_THRESHOLD,
                deesserFreq: CONFIG.DEFAULT_DEESSER_FREQ,
                isExciterEnabled: CONFIG.DEFAULT_EXCITER_ENABLED,
                exciterAmount: CONFIG.DEFAULT_EXCITER_AMOUNT,
                isParallelCompEnabled: CONFIG.DEFAULT_PARALLEL_COMP_ENABLED,
                parallelCompMix: CONFIG.DEFAULT_PARALLEL_COMP_MIX,
                isLimiterEnabled: CONFIG.DEFAULT_LIMITER_ENABLED,
                isMasteringSuiteEnabled: CONFIG.DEFAULT_MASTERING_SUITE_ENABLED,
                masteringTransientAmount: 0.2,
                masteringDrive: 0,
            },
            ui: {
                shadowRoot: null,
                hostElement: null,
                delayCheckInterval: null,
                currentPlaybackRate: 1.0,
                lastUrl: '',
                audioContextWarningShown: false
            }
        });
    }
    resetState();

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };

    function calculateSharpenMatrix(level, direction = '4-way') {
        const p = parseInt(level, 10);
        if (isNaN(p) || p === 0) return '0 0 0 0 1 0 0 0 0';
        const BASE_STRENGTH = 0.125;
        const i = 1 + p * BASE_STRENGTH;
        if (direction === '8-way') {
            const o = (1 - i) / 8;
            return `${o} ${o} ${o} ${o} ${i} ${o} ${o} ${o} ${o}`;
        } else {
            const o = (1 - i) / 4;
            return `0 ${o} 0 ${o} ${i} ${o} 0 ${o} 0`;
        }
    }

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() {
        const url = location.href.toLowerCase();
        if (CONFIG.EXCLUSION_KEYWORDS.some(k => url.includes(k))) return true;
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
        return false;
    }
    if (isExcluded()) return; Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (opt) { const m = { ...opt, mode: 'open' }; const s = o.apply(this, [m]); window._shadowDomList_.push(new WeakRef(s)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: s } })); return s; }; window._hasHackAttachShadow_ = true; }); })();

    class SvgFilterManager {
        #isInitialized = false; #styleElement = null; #svgNode = null; #options;
        constructor(options) { this.#options = options; }
        isInitialized() { return this.#isInitialized; }
        getSvgNode() { return this.#svgNode; }
        getStyleNode() { return this.#styleElement; }
        toggleStyleSheet(enable) { if (this.#styleElement) this.#styleElement.media = enable ? 'all' : 'none'; }
        init() {
            if (this.#isInitialized) return;
            safeExec(() => {
                const { svgNode, styleElement } = this.#createElements();
                this.#svgNode = svgNode; this.#styleElement = styleElement;
                (document.head || document.documentElement).appendChild(styleElement);
                (document.body || document.documentElement).appendChild(svgNode);
                this.#isInitialized = true;
            }, `${this.constructor.name}.init`);
        }

        #createElements() {
            const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
            const { settings, svgId, styleId, matrixId, className } = this.#options;
            const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`;

            const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
            const combinedFilter = createSvgElement('filter', { id: combinedFilterId });

            const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", type: "saturate", values: (settings.SATURATION_VALUE / 100).toString(), result: "saturate_out" });
            const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" },
                ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))
            );
            const blur = createSvgElement('feGaussianBlur', { "data-vsc-id": "blur", in: "gamma_out", stdDeviation: settings.BLUR_STD_DEVIATION, result: "blur_out" });

            const sharpen_pass1 = createSvgElement('feConvolveMatrix', {
                id: matrixId + '_pass1', "data-vsc-id": "sharpen_pass1", in: "blur_out", order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', result: "sharpen_out_1"
            });
            const sharpen_pass2 = createSvgElement('feConvolveMatrix', {
                id: matrixId + '_pass2', "data-vsc-id": "sharpen_pass2", in: "sharpen_out_1", order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', result: "sharpen_out_2"
            });

            const linear = createSvgElement('feComponentTransfer', { "data-vsc-id": "linear", in: "sharpen_out_2" },
                ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'linear', slope: (1 + settings.HIGHLIGHTS_VALUE / 100).toString(), intercept: (settings.SHADOWS_VALUE / 200).toString() }))
            );

            combinedFilter.append(saturation, gamma, blur, sharpen_pass1, sharpen_pass2, linear);
            svg.append(combinedFilter);

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .${className} { filter: url(#${combinedFilterId}) !important; }
                .${'vsc-gpu-accelerated'} { transform: translateZ(0); will-change: transform; }
                .vsc-btn.analyzing { box-shadow: 0 0 5px #f39c12, 0 0 10px #f39c12 inset !important; }
            `;

            return { svgNode: svg, styleElement: style };
        }

        updateFilterValues(values, rootNode = document) {
            if (!this.isInitialized()) return;
            const { saturation, gamma, blur, sharpenMatrix1, sharpenMatrix2, shadows, highlights } = values;

            if (saturation !== undefined) {
                rootNode.querySelectorAll(`[data-vsc-id="saturate"]`).forEach(el => el.setAttribute('values', (saturation / 100).toString()));
            }
            if (gamma !== undefined) {
                const exponent = (1 / gamma).toString();
                rootNode.querySelectorAll(`[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB`).forEach(el => el.setAttribute('exponent', exponent));
            }
            if (blur !== undefined) {
                rootNode.querySelectorAll(`[data-vsc-id="blur"]`).forEach(el => el.setAttribute('stdDeviation', blur.toString()));
            }
            if (sharpenMatrix1 !== undefined) {
                const matrixEl1 = rootNode.querySelector(`[data-vsc-id="sharpen_pass1"]`);
                if (matrixEl1 && matrixEl1.getAttribute('kernelMatrix') !== sharpenMatrix1) {
                    matrixEl1.setAttribute('kernelMatrix', sharpenMatrix1);
                }
            }
            if (sharpenMatrix2 !== undefined) {
                const matrixEl2 = rootNode.querySelector(`[data-vsc-id="sharpen_pass2"]`);
                if (matrixEl2 && matrixEl2.getAttribute('kernelMatrix') !== sharpenMatrix2) {
                    matrixEl2.setAttribute('kernelMatrix', sharpenMatrix2);
                }
            }

            if (shadows !== undefined || highlights !== undefined) {
                const currentHighlights = highlights ?? state.videoFilter.currentVideoHighlights;
                const currentShadows = shadows ?? state.videoFilter.currentVideoShadows;
                const slope = (1 + currentHighlights / 100).toString();
                const intercept = (currentShadows / 200).toString();
                rootNode.querySelectorAll(`[data-vsc-id="linear"] feFuncR, [data-vsc-id="linear"] feFuncG, [data-vsc-id="linear"] feFuncB`).forEach(el => {
                    el.setAttribute('slope', slope);
                    el.setAttribute('intercept', intercept);
                });
            }
        }
    }

    const filterManager = new SvgFilterManager({ settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', matrixId: 'vsc-dynamic-convolve-matrix', className: 'vsc-video-filter-active' });
    const imageFilterManager = new SvgFilterManager({ settings: CONFIG.IMAGE_FILTER_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', matrixId: 'vsc-image-convolve-matrix', className: 'vsc-image-filter-active' });

    const audioEffectsManager = (() => {
        const animationFrameMap = new WeakMap();

        function createImpulseResponse(context, duration = 2, decay = 2) {
            const sampleRate = context.sampleRate;
            const length = sampleRate * duration;
            const impulse = context.createBuffer(2, length, sampleRate);
            const impulseL = impulse.getChannelData(0);
            const impulseR = impulse.getChannelData(1);

            for (let i = 0; i < length; i++) {
                impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
                impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
            return impulse;
        }

        function startLoudnessNormalization(media) {
            const nodes = state.audio.audioContextMap.get(media);
            if (!nodes || state.audio.isAnalyzingLoudness) return;
            const autoVolBtn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
            if (!autoVolBtn) return;
            const originalBtnText = autoVolBtn.textContent;
            state.audio.isAnalyzingLoudness = true;
            updateAutoVolumeButtonStyle();
            const analyser = nodes.analyser;
            const gainNode = nodes.masterGain;
            const data = new Float32Array(analyser.fftSize);
            const ANALYSIS_DELAY_MS = 500;
            const ANALYSIS_DURATION_MS = 10000;
            const SAMPLE_INTERVAL_MS = 250;
            const LUFS_GATE_THRESHOLD = -25;
            const targetLUFS = -16.0;
            const MIN_VALID_SAMPLES = 5;
            let currentLufsSamples = [];
            let sampleIntervalId = null;
            let finalizeTimeoutId = null;
            let countdownIntervalId = null;
            const cleanupTimers = () => {
                clearInterval(sampleIntervalId);
                clearTimeout(finalizeTimeoutId);
                clearInterval(countdownIntervalId);
            };
            const collectSample = () => {
                if (!media.isConnected || media.paused || !state.audio.isAnalyzingLoudness) {
                    cleanupTimers();
                    if (state.audio.isAnalyzingLoudness) {
                        state.audio.isAnalyzingLoudness = false;
                        autoVolBtn.textContent = originalBtnText;
                        updateAutoVolumeButtonStyle();
                    }
                    return;
                }
                analyser.getFloatTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) {
                    sum += data[i] * data[i];
                }
                const rms = Math.sqrt(sum / data.length);
                if (rms > 0.001) {
                    const lufs = 20 * Math.log10(rms);
                    if (lufs > LUFS_GATE_THRESHOLD) currentLufsSamples.push(lufs);
                }
            };
            const finalizeAnalysis = () => {
                if (!state.audio.isAnalyzingLoudness) {
                    return;
                }
                cleanupTimers();
                if (currentLufsSamples.length < MIN_VALID_SAMPLES) {
                    console.log('[VSC 음량 평준화] 유효 샘플 부족으로 중단.');
                } else {
                    nodes.cumulativeLUFS = (nodes.cumulativeLUFS || 0) + currentLufsSamples.reduce((sum, v) => sum + v, 0);
                    nodes.lufsSampleCount = (nodes.lufsSampleCount || 0) + currentLufsSamples.length;
                    const averageLUFS = nodes.cumulativeLUFS / nodes.lufsSampleCount;
                    let correctionFactor = Math.pow(10, (targetLUFS - averageLUFS) / 20);
                    correctionFactor = Math.min(1.25, Math.max(0.8, correctionFactor));
                    const MAX_FINAL_GAIN = 2.5;
                    let finalGain = state.audio.lastManualPreGain * correctionFactor;
                    finalGain = Math.min(finalGain, MAX_FINAL_GAIN);
                    gainNode.gain.linearRampToValueAtTime(finalGain, nodes.context.currentTime + 0.5);
                    state.audio.currentPreGain = finalGain;
                    const slider = state.ui.shadowRoot?.getElementById('preGainSlider');
                    const valueSpan = state.ui.shadowRoot?.getElementById('preGainSliderVal');
                    if (slider) slider.value = finalGain;
                    if (valueSpan) valueSpan.textContent = `${finalGain.toFixed(1)}x`;
                    console.log(`[VSC 음량 평준화] 샘플 추가 (총 ${nodes.lufsSampleCount}개). 누적 평균: ${averageLUFS.toFixed(1)} LUFS, 최종 볼륨: ${finalGain.toFixed(2)}x`);
                    if (nodes.lufsSampleCount > 50) {
                        console.log('[VSC 음량 평준화] 누적 샘플이 50개를 초과하여 기록을 초기화합니다.');
                        nodes.cumulativeLUFS = 0;
                        nodes.lufsSampleCount = 0;
                    }
                }
                state.audio.isAnalyzingLoudness = false;
                autoVolBtn.textContent = originalBtnText;
                updateAutoVolumeButtonStyle();
            };
            setTimeout(() => {
                if (!state.audio.isAnalyzingLoudness) return;
                console.log(`[VSC 음량 평준화] ${ANALYSIS_DURATION_MS / 1000}초간 샘플 수집 시작...`);
                sampleIntervalId = setInterval(collectSample, SAMPLE_INTERVAL_MS);
                finalizeTimeoutId = setTimeout(finalizeAnalysis, ANALYSIS_DURATION_MS);
                let timeLeft = Math.floor(ANALYSIS_DURATION_MS / 1000);
                autoVolBtn.textContent = `분석중 ${timeLeft}s`;
                countdownIntervalId = setInterval(() => {
                    timeLeft--;
                    if (timeLeft > 0) {
                        autoVolBtn.textContent = `분석중 ${timeLeft}s`;
                    } else {
                        clearInterval(countdownIntervalId);
                    }
                }, 1000);
            }, ANALYSIS_DELAY_MS);
        }

        function makeDistortionCurve(amount) {
            const k = typeof amount === 'number' ? amount : 50;
            const n_samples = 44100;
            const curve = new Float32Array(n_samples);
            const deg = Math.PI / 180;
            for (let i = 0; i < n_samples; ++i) {
                const x = i * 2 / n_samples - 1;
                curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
            }
            return curve;
        }

        function createAudioGraph(media) {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            let source;
            try {
                media.crossOrigin = "anonymous";
                source = context.createMediaElementSource(media);
            } catch (e) {
                console.error('[VSC] MediaElementSource 생성 실패.', e);
                showWarningMessage('오디오 효과를 적용할 수 없습니다. 페이지를 새로고침 해보세요.');
                context.close(); return null;
            }

            const nodes = {
                context, source,
                stereoPanner: context.createStereoPanner(),
                masterGain: context.createGain(),
                analyser: context.createAnalyser(),
                safetyLimiter: context.createDynamicsCompressor(),
                cumulativeLUFS: 0,
                lufsSampleCount: 0,
                band1_SubBass: context.createBiquadFilter(),
                band2_Bass: context.createBiquadFilter(),
                band3_Mid: context.createBiquadFilter(),
                band4_Treble: context.createBiquadFilter(),
                band5_Presence: context.createBiquadFilter(),
                gain1_SubBass: context.createGain(),
                gain2_Bass: context.createGain(),
                gain3_Mid: context.createGain(),
                gain4_Treble: context.createGain(),
                gain5_Presence: context.createGain(),
                merger: context.createGain(),
                reverbConvolver: context.createConvolver(),
                reverbWetGain: context.createGain(),
                reverbSum: context.createGain(),
                deesserBand: context.createBiquadFilter(),
                deesserCompressor: context.createDynamicsCompressor(),
                exciterHPF: context.createBiquadFilter(),
                exciter: context.createWaveShaper(),
                exciterPostGain: context.createGain(),
                parallelCompressor: context.createDynamicsCompressor(),
                parallelDry: context.createGain(),
                parallelWet: context.createGain(),
                limiter: context.createDynamicsCompressor(),
                masteringTransientShaper: context.createWaveShaper(),
                masteringLimiter1: context.createDynamicsCompressor(),
                masteringLimiter2: context.createDynamicsCompressor(),
                masteringLimiter3: context.createDynamicsCompressor(),
            };

            try {
                nodes.reverbConvolver.buffer = createImpulseResponse(context);
            } catch (e) {
                console.error("[VSC] Failed to create reverb impulse response.", e);
            }

            // Configure the safety limiter (brickwall settings)
            nodes.safetyLimiter.threshold.value = -0.5;
            nodes.safetyLimiter.knee.value = 0;
            nodes.safetyLimiter.ratio.value = 20;
            nodes.safetyLimiter.attack.value = 0.001;
            nodes.safetyLimiter.release.value = 0.05;

            nodes.analyser.fftSize = 2048;
            nodes.band1_SubBass.type = "lowpass";
            nodes.band1_SubBass.frequency.value = 80;
            nodes.band2_Bass.type = "bandpass";
            nodes.band2_Bass.frequency.value = 150;
            nodes.band2_Bass.Q.value = 1;
            nodes.band3_Mid.type = "bandpass";
            nodes.band3_Mid.frequency.value = 1000;
            nodes.band3_Mid.Q.value = 1;
            nodes.band4_Treble.type = "bandpass";
            nodes.band4_Treble.frequency.value = 4000;
            nodes.band4_Treble.Q.value = 1;
            nodes.band5_Presence.type = "highpass";
            nodes.band5_Presence.frequency.value = 8000;

            state.audio.audioContextMap.set(media, nodes);

            nodes.source.connect(nodes.masterGain);
            nodes.masterGain.connect(nodes.safetyLimiter);
            nodes.safetyLimiter.connect(nodes.analyser);
            nodes.safetyLimiter.connect(nodes.context.destination);


            return nodes;
        }

        function reconnectGraph(media) {
            const nodes = state.audio.audioContextMap.get(media);
            if (!nodes) return;

            safeExec(() => {
                // 1. 기존의 모든 오디오 연결 해제
                Object.values(nodes).forEach(node => {
                    if (node && typeof node.disconnect === 'function' && node !== nodes.context) {
                        try { node.disconnect(); } catch (e) { /* Ignore */ }
                    }
                });

                if (animationFrameMap.has(media)) cancelAnimationFrame(animationFrameMap.get(media));
                animationFrameMap.delete(media);

                // UI 슬라이더 값들을 오디오 노드에 적용
                nodes.masterGain.gain.value = state.audio.currentPreGain;
                nodes.stereoPanner.pan.value = state.audio.currentStereoPan;

                // 2. 오디오 처리 시작점 설정: 소스(source)에서 시작
                let lastNode = nodes.source;

                // --- 각종 효과(EQ, 컴프레서 등) 체인 ---
                if (state.audio.isDeesserEnabled) {
                    nodes.deesserBand.type = 'bandpass';
                    nodes.deesserBand.frequency.value = state.audio.deesserFreq;
                    nodes.deesserBand.Q.value = 3;
                    nodes.deesserCompressor.threshold.value = state.audio.deesserThreshold;
                    nodes.deesserCompressor.knee.value = 10;
                    nodes.deesserCompressor.ratio.value = 10;
                    nodes.deesserCompressor.attack.value = 0.005;
                    nodes.deesserCompressor.release.value = 0.1;
                    lastNode.connect(nodes.deesserBand).connect(nodes.deesserCompressor);
                    lastNode = lastNode.connect(nodes.deesserCompressor);
                }

                if (state.audio.isEqEnabled || state.audio.bassBoostGain > 0) {
                    const merger = nodes.merger;
                    lastNode.connect(nodes.band1_SubBass);
                    lastNode.connect(nodes.band2_Bass);
                    lastNode.connect(nodes.band3_Mid);
                    lastNode.connect(nodes.band4_Treble);
                    lastNode.connect(nodes.band5_Presence);

                    let lastSubBassNode = nodes.band1_SubBass;
                    if (state.audio.bassBoostGain > 0) {
                        if (!nodes.bassBoost) {
                            nodes.bassBoost = nodes.context.createBiquadFilter();
                            nodes.bassBoost.type = "peaking";
                        }
                        nodes.bassBoost.frequency.value = state.audio.bassBoostFreq;
                        nodes.bassBoost.Q.value = state.audio.bassBoostQ;
                        nodes.bassBoost.gain.value = state.audio.bassBoostGain;
                        lastSubBassNode = lastSubBassNode.connect(nodes.bassBoost);
                    }

                    if (state.audio.isEqEnabled) {
                        nodes.gain1_SubBass.gain.value = Math.pow(10, state.audio.eqSubBassGain / 20);
                        nodes.gain2_Bass.gain.value = Math.pow(10, state.audio.eqBassGain / 20);
                        nodes.gain3_Mid.gain.value = Math.pow(10, state.audio.eqMidGain / 20);
                        nodes.gain4_Treble.gain.value = Math.pow(10, state.audio.eqTrebleGain / 20);
                        nodes.gain5_Presence.gain.value = Math.pow(10, state.audio.eqPresenceGain / 20);
                    } else {
                        [nodes.gain1_SubBass, nodes.gain2_Bass, nodes.gain3_Mid, nodes.gain4_Treble, nodes.gain5_Presence].forEach(g => g.gain.value = 1);
                    }

                    lastSubBassNode.connect(nodes.gain1_SubBass).connect(merger);
                    nodes.band2_Bass.connect(nodes.gain2_Bass).connect(merger);
                    nodes.band3_Mid.connect(nodes.gain3_Mid).connect(merger);
                    nodes.band4_Treble.connect(nodes.gain4_Treble).connect(merger);
                    nodes.band5_Presence.connect(nodes.gain5_Presence).connect(merger);
                    lastNode = merger;
                }

                if (state.audio.isHpfEnabled) {
                    if (!nodes.hpf) nodes.hpf = nodes.context.createBiquadFilter();
                    nodes.hpf.type = 'highpass';
                    nodes.hpf.frequency.value = state.audio.currentHpfHz;
                    lastNode = lastNode.connect(nodes.hpf);
                }

                if (state.audio.isExciterEnabled && state.audio.exciterAmount > 0) {
                    const exciterSum = nodes.context.createGain();
                    const exciterDry = nodes.context.createGain();
                    const exciterWet = nodes.context.createGain();
                    const exciterPostGain = nodes.exciterPostGain;
                    const wetAmount = state.audio.isMasteringSuiteEnabled ? state.audio.exciterAmount / 150 : state.audio.exciterAmount / 100;
                    exciterDry.gain.value = 1.0 - wetAmount;
                    exciterWet.gain.value = wetAmount;
                    nodes.exciterHPF.type = 'highpass';
                    nodes.exciterHPF.frequency.value = 5000;
                    nodes.exciter.curve = makeDistortionCurve(state.audio.exciterAmount * 15);
                    nodes.exciter.oversample = '4x';
                    exciterPostGain.gain.value = 0.5;
                    lastNode.connect(exciterDry).connect(exciterSum);
                    lastNode.connect(nodes.exciterHPF).connect(nodes.exciter).connect(exciterPostGain).connect(exciterWet).connect(exciterSum);
                    lastNode = exciterSum;
                }

                if (state.audio.isParallelCompEnabled && state.audio.parallelCompMix > 0) {
                    nodes.parallelCompressor.threshold.value = -30;
                    nodes.parallelCompressor.knee.value = 15;
                    nodes.parallelCompressor.ratio.value = 12;
                    nodes.parallelCompressor.attack.value = 0.003;
                    nodes.parallelCompressor.release.value = 0.1;
                    nodes.parallelDry.gain.value = 1.0 - (state.audio.parallelCompMix / 100);
                    nodes.parallelWet.gain.value = state.audio.parallelCompMix / 100;
                    const parallelSum = nodes.context.createGain();
                    lastNode.connect(nodes.parallelDry).connect(parallelSum);
                    lastNode.connect(nodes.parallelCompressor).connect(nodes.parallelWet).connect(parallelSum);
                    lastNode = parallelSum;
                }

                let spatialNode;
                if (state.audio.isWideningEnabled) {
                    if (!nodes.ms_splitter) {
                        Object.assign(nodes, {
                            ms_splitter: nodes.context.createChannelSplitter(2), ms_mid_sum: nodes.context.createGain(),
                            ms_mid_level: nodes.context.createGain(), ms_side_invert_R: nodes.context.createGain(),
                            ms_side_sum: nodes.context.createGain(), ms_side_level: nodes.context.createGain(),
                            ms_side_gain: nodes.context.createGain(), adaptiveWidthFilter: nodes.context.createBiquadFilter(),
                            ms_decode_L_sum: nodes.context.createGain(), ms_decode_invert_Side: nodes.context.createGain(),
                            ms_decode_R_sum: nodes.context.createGain(), ms_merger: nodes.context.createChannelMerger(2)
                        });
                    }
                    lastNode.connect(nodes.ms_splitter);
                    nodes.ms_splitter.connect(nodes.ms_mid_sum, 0); nodes.ms_splitter.connect(nodes.ms_mid_sum, 1);
                    nodes.ms_mid_sum.connect(nodes.ms_mid_level);
                    nodes.ms_splitter.connect(nodes.ms_side_sum, 0);
                    nodes.ms_splitter.connect(nodes.ms_side_invert_R, 1).connect(nodes.ms_side_sum);
                    nodes.ms_side_invert_R.gain.value = -1;
                    nodes.ms_side_sum.connect(nodes.ms_side_level);
                    nodes.ms_mid_level.gain.value = 0.5;
                    nodes.ms_side_level.gain.value = 0.5;
                    nodes.adaptiveWidthFilter.type = 'highpass';
                    nodes.adaptiveWidthFilter.frequency.value = state.audio.isAdaptiveWidthEnabled ? state.audio.adaptiveWidthFreq : 0;
                    nodes.ms_side_level.connect(nodes.adaptiveWidthFilter).connect(nodes.ms_side_gain);
                    nodes.ms_side_gain.gain.value = state.audio.currentWideningFactor;
                    nodes.ms_decode_invert_Side.gain.value = -1;
                    nodes.ms_mid_level.connect(nodes.ms_decode_L_sum); nodes.ms_side_gain.connect(nodes.ms_decode_L_sum);
                    nodes.ms_mid_level.connect(nodes.ms_decode_R_sum); nodes.ms_side_gain.connect(nodes.ms_decode_invert_Side).connect(nodes.ms_decode_R_sum);
                    nodes.ms_decode_L_sum.connect(nodes.ms_merger, 0, 0);
                    nodes.ms_decode_R_sum.connect(nodes.ms_merger, 0, 1);
                    spatialNode = nodes.ms_merger;
                } else {
                    spatialNode = lastNode.connect(nodes.stereoPanner);
                }

                if (state.audio.isReverbEnabled) {
                    nodes.reverbWetGain.gain.value = state.audio.reverbMix;
                    spatialNode.connect(nodes.reverbSum);
                    spatialNode.connect(nodes.reverbConvolver).connect(nodes.reverbWetGain).connect(nodes.reverbSum);
                    lastNode = nodes.reverbSum;
                } else {
                    lastNode = spatialNode;
                }

                // 3. 마스터링 효과 연결
                if (state.audio.isMasteringSuiteEnabled) {
                    nodes.masteringTransientShaper.curve = makeTransientCurve(state.audio.masteringTransientAmount);
                    nodes.masteringTransientShaper.oversample = '4x';
                    lastNode = lastNode.connect(nodes.masteringTransientShaper);

                    const drive = state.audio.masteringDrive;
                    const l1 = nodes.masteringLimiter1;
                    l1.threshold.value = -12 + (drive / 2); l1.knee.value = 5; l1.ratio.value = 4; l1.attack.value = 0.005; l1.release.value = 0.08;
                    const l2 = nodes.masteringLimiter2;
                    l2.threshold.value = -8 + (drive / 2); l2.knee.value = 3; l2.ratio.value = 8; l2.attack.value = 0.003; l2.release.value = 0.05;
                    const l3 = nodes.masteringLimiter3;
                    l3.threshold.value = -2.0; l3.knee.value = 0; l3.ratio.value = 20; l3.attack.value = 0.001; l3.release.value = 0.02;
                    lastNode = lastNode.connect(l1).connect(l2).connect(l3);

                } else {
                    if (state.audio.isLimiterEnabled) {
                        nodes.limiter.threshold.value = -1.5;
                        nodes.limiter.knee.value = 0;
                        nodes.limiter.ratio.value = 20;
                        nodes.limiter.attack.value = 0.001;
                        nodes.limiter.release.value = 0.05;
                        lastNode = lastNode.connect(nodes.limiter);
                    }
                }

                // 4. 최종 볼륨(masterGain)과 안전 리미터를 거쳐 최종 출력
                lastNode.connect(nodes.masterGain);
                nodes.masterGain.connect(nodes.safetyLimiter);
                nodes.safetyLimiter.connect(nodes.analyser);
                nodes.safetyLimiter.connect(nodes.context.destination);

            }, 'reconnectGraph_Final_Fix');
        }

        function checkAudioActivity(media, nodes) {
            if (!media || !nodes || !nodes.analyser) return;
            const analysisStatusMap = new WeakMap();

            const currentStatus = analysisStatusMap.get(media);
            if (currentStatus === 'passed' || currentStatus === 'checking') return;
            analysisStatusMap.set(media, 'checking');

            let attempts = 0;
            const MAX_ATTEMPTS = 8;
            const CHECK_INTERVAL = 350;
            const analyserData = new Uint8Array(nodes.analyser.frequencyBinCount);
            nodes.analyser.fftSize = 256;

            const intervalId = setInterval(async () => {
                if (!media.isConnected || nodes.context.state === 'closed') {
                    clearInterval(intervalId);
                    analysisStatusMap.delete(media);
                    return;
                }
                if (media.paused) {
                    attempts = 0; // Don't count attempts if paused
                    return;
                }

                attempts++;
                nodes.analyser.getByteFrequencyData(analyserData);
                const sum = analyserData.reduce((a, b) => a + b, 0);

                if (sum > 0) {
                    clearInterval(intervalId);
                    analysisStatusMap.set(media, 'passed');
                    return;
                }

                if (attempts >= MAX_ATTEMPTS) {
                    clearInterval(intervalId);
                    analysisStatusMap.set(media, 'failed');
                    if (settingsManager.get('autoRefresh')) {
                        console.warn('[VSC] 오디오 신호 없음 (CORS 의심). 페이지를 새로고침합니다.', media);
                        sessionStorage.setItem('vsc_message', 'CORS 보안 정책으로 오디오 효과 적용에 실패하여 페이지를 새로고침했습니다.');
                        showWarningMessage('CORS 오류 감지. 1.5초 후 오디오 복원을 위해 페이지를 새로고침합니다.');
                        cleanupForMedia(media);
                        setTimeout(() => { location.reload(); }, 1500);
                    } else {
                        console.warn('[VSC] 오디오 신호 없음 (CORS 의심). 자동 새로고침 비활성화됨.', media);
                        showWarningMessage('오디오 효과 적용 실패 (CORS 보안 정책 가능성).');
                    }
                }
            }, CHECK_INTERVAL);
        }

        function getOrCreateNodes(media) {
            if (state.audio.audioContextMap.has(media)) {
                return state.audio.audioContextMap.get(media);
            }
            const newNodes = createAudioGraph(media);
            if (newNodes) checkAudioActivity(media, newNodes);
            return newNodes;
        }

        function cleanupForMedia(media) {
            if (animationFrameMap.has(media)) {
                cancelAnimationFrame(animationFrameMap.get(media));
                animationFrameMap.delete(media);
            }
            const nodes = state.audio.audioContextMap.get(media);
            if (nodes) {
                safeExec(() => {
                    if (nodes.context.state !== 'closed') nodes.context.close();
                }, 'cleanupForMedia');
                state.audio.audioContextMap.delete(media);
            }
        }

        function ensureContextResumed(media) {
            const nodes = getOrCreateNodes(media);
            if (nodes && nodes.context.state === 'suspended') {
                nodes.context.resume().catch(e => {
                    if (!state.ui.audioContextWarningShown) {
                        showWarningMessage('오디오 효과를 위해 UI 버튼을 한 번 클릭해주세요.');
                        state.ui.audioContextWarningShown = true;
                    } console.warn('[VSC] AudioContext resume failed:', e.message);
                });
            }
        }

        return { getOrCreateNodes, cleanupForMedia, ensureContextResumed, reconnectGraph, startLoudnessNormalization };
    })();

    function applyAudioEffectsToMedia() {
        if (!state.audio.audioInitialized) return;
        const mediaToAffect = isMobile && state.media.currentlyVisibleMedia ? [state.media.currentlyVisibleMedia] : Array.from(state.media.activeMedia);
        mediaToAffect.forEach(media => audioEffectsManager.reconnectGraph(media));
    }

    function initializeAudioEngine() {
        if (state.audio.audioInitialized) return;
        state.audio.audioInitialized = true;
        const mediaToAffect = isMobile && state.media.currentlyVisibleMedia ? [state.media.currentlyVisibleMedia] : Array.from(state.media.activeMedia);
        mediaToAffect.forEach(media => audioEffectsManager.ensureContextResumed(media));
    }

    function updateAutoVolumeButtonStyle() {
        const btn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
        if (!btn) return;
        btn.classList.toggle('analyzing', state.audio.isAnalyzingLoudness);
    }

    function setPreGainEnabled(enabled) {
        state.audio.isPreGainEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-pregain-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('preGainSlider');
        if (slider) slider.disabled = !enabled;
        const autoVolBtn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
        if (autoVolBtn) autoVolBtn.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setWideningEnabled(enabled) {
        state.audio.isWideningEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-widen-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('wideningSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setHpfEnabled(enabled) {
        state.audio.isHpfEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-hpf-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('hpfSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setEqEnabled(enabled) {
        state.audio.isEqEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-eq-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const shadowRoot = state.ui.shadowRoot;
        if (shadowRoot) {
            ['eqSubBassSlider', 'eqBassSlider', 'eqMidSlider', 'eqTrebleSlider', 'eqPresenceSlider'].forEach(id => {
                const slider = shadowRoot.getElementById(id);
                if (slider) slider.disabled = !enabled;
            });
        }
        applyAudioEffectsToMedia();
    }

    function setDeesserEnabled(enabled) {
        state.audio.isDeesserEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-deesser-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        ['deesserThresholdSlider', 'deesserFreqSlider'].forEach(id => {
            const slider = state.ui.shadowRoot?.getElementById(id);
            if (slider) slider.disabled = !enabled;
        });
        applyAudioEffectsToMedia();
    }
    function setExciterEnabled(enabled) {
        state.audio.isExciterEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-exciter-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('exciterAmountSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }
    function setParallelCompEnabled(enabled) {
        state.audio.isParallelCompEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-parallel-comp-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('parallelCompMixSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setMasteringSuiteEnabled(enabled) {
        state.audio.isMasteringSuiteEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-mastering-suite-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        ['masteringTransientSlider', 'masteringDriveSlider'].forEach(id => {
            const slider = state.ui.shadowRoot?.getElementById(id);
            if (slider) slider.disabled = !enabled;
        });
        const oldLimiterBtn = state.ui.shadowRoot?.getElementById('vsc-limiter-toggle');
        if (oldLimiterBtn) oldLimiterBtn.disabled = enabled;

        applyAudioEffectsToMedia();
    }

    function setLimiterEnabled(enabled) {
        state.audio.isLimiterEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-limiter-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        applyAudioEffectsToMedia();
    }

    function setReverbEnabled(enabled) {
        state.audio.isReverbEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-reverb-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('reverbMixSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setAdaptiveWidthEnabled(enabled) {
        state.audio.isAdaptiveWidthEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-adaptive-width-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        applyAudioEffectsToMedia();
    }

    function resetEffectStatesToDefault() {
        setWideningEnabled(CONFIG.DEFAULT_WIDENING_ENABLED);
        setHpfEnabled(CONFIG.DEFAULT_HPF_ENABLED);
        setEqEnabled(CONFIG.DEFAULT_EQ_ENABLED);
        setAdaptiveWidthEnabled(CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED);
        setReverbEnabled(CONFIG.DEFAULT_REVERB_ENABLED);
        setPreGainEnabled(CONFIG.DEFAULT_PRE_GAIN_ENABLED);
        setDeesserEnabled(CONFIG.DEFAULT_DEESSER_ENABLED);
        setExciterEnabled(CONFIG.DEFAULT_EXCITER_ENABLED);
        setParallelCompEnabled(CONFIG.DEFAULT_PARALLEL_COMP_ENABLED);
        setLimiterEnabled(CONFIG.DEFAULT_LIMITER_ENABLED);
        setMasteringSuiteEnabled(CONFIG.DEFAULT_MASTERING_SUITE_ENABLED);

        state.audio.bassBoostGain = CONFIG.DEFAULT_BASS_BOOST_GAIN;
        const bassSlider = state.ui.shadowRoot?.getElementById('bassBoostSlider');
        if (bassSlider) {
            bassSlider.value = state.audio.bassBoostGain;
            const bassVal = state.ui.shadowRoot?.getElementById('bassBoostSliderVal');
            if (bassVal) bassVal.textContent = `${state.audio.bassBoostGain.toFixed(1)} dB`;
        }
        applyAudioEffectsToMedia();
    }

    function applyAllVideoFilters() {
        if (!filterManager.isInitialized()) return;
        const values = {
            saturation: state.videoFilter.currentVideoSaturation,
            gamma: state.videoFilter.currentVideoGamma,
            blur: state.videoFilter.currentVideoBlur,
            sharpenMatrix1: calculateSharpenMatrix(state.videoFilter.currentVideoFilterLevel, state.videoFilter.currentVideoSharpenDirection),
            sharpenMatrix2: calculateSharpenMatrix(state.videoFilter.currentVideoFilterLevel2, state.videoFilter.currentVideoSharpenDirection),
            shadows: state.videoFilter.currentVideoShadows,
            highlights: state.videoFilter.currentVideoHighlights,
        };
        filterManager.updateFilterValues(values, document);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => {
            filterManager.updateFilterValues(values, root);
        });
    }

    function setVideoFilterLevel(level, fromUI = false, pass = 1) {
        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!filterManager.isInitialized() && level > 0) filterManager.init();
        const newLevel = parseInt(level, 10);
        const finalLevel = isNaN(newLevel) ? 0 : newLevel;
        if (pass === 1) {
            state.videoFilter.currentVideoFilterLevel = finalLevel;
            if (fromUI) settingsManager.set('videoFilterLevel', finalLevel);
        } else {
            state.videoFilter.currentVideoFilterLevel2 = finalLevel;
            if (fromUI) settingsManager.set('videoFilterLevel2', finalLevel);
        }
        applyAllVideoFilters();
        state.media.activeMedia.forEach(media => { if (media.tagName === 'VIDEO') updateVideoFilterState(media); });
    }

    function setImageFilterLevel(level) {
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!imageFilterManager.isInitialized() && level > 0) imageFilterManager.init();
        const newLevel = parseInt(level, 10);
        state.imageFilter.currentImageFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('imageFilterLevel', state.imageFilter.currentImageFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.imageFilter.currentImageFilterLevel);
        const imageValues = { sharpenMatrix: newMatrix };
        imageFilterManager.updateFilterValues(imageValues, document);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => imageFilterManager.updateFilterValues(imageValues, root));
        state.media.activeImages.forEach(image => updateImageFilterState(image));
    }

    const uiManager = (() => {
        const styleRules = [
            ':host { pointer-events: none; }',
            '* { pointer-events: auto; -webkit-tap-highlight-color: transparent; }',
            `#vsc-container { background: none; padding: clamp(${isMobile ? '4px, 1vmin, 8px' : '6px, 1.2vmin, 10px'}); border-radius: clamp(8px, 1.5vmin, 12px); z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.3s; margin-top: 5px; }`,
            '#vsc-container.touched { opacity: 1; }',
            '@media (hover: hover) { #vsc-container:hover { opacity: 1; } }',
            `.vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: clamp(3px, 0.8vmin, 5px); height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; }`,
            `.vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '4px' : 'clamp(6px, 1vmin, 9px)'}; width: auto; pointer-events: auto !important; }`,
            `#vsc-stereo-controls .vsc-submenu { width: ${isMobile ? '380px' : '520px'}; max-width: 90vw; }`,
            `#vsc-video-controls .vsc-submenu { width: ${isMobile ? '280px' : '320px'}; max-width: 80vw; }`,
            '#vsc-image-controls .vsc-submenu { width: 100px; }',
            '.vsc-control-group.submenu-visible .vsc-submenu { display: flex; }',
            `.vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(${isMobile ? '11px, 1.8vmin, 13px' : '12px, 2vmin, 14px'}); }`,
            '.vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }',
            `.vsc-btn-main { font-size: clamp(${isMobile ? '14px, 2.5vmin, 16px' : '15px, 3vmin, 18px'}); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }`,
            '.vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); width: 100%; box-sizing: border-box; }',
            `.slider-control { display: flex; flex-direction: column; gap: ${isMobile ? '2px' : '4px'}; }`,
            `.slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '12px' : '13px'}; color: white; align-items: center; }`,
            'input[type=range] { width: 100%; margin: 0; }',
            'input[type=range]:disabled, .vsc-select:disabled, .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
            '.vsc-button-group { display: flex; gap: 8px; width: 100%; flex-wrap: wrap; }',
            '.vsc-button-group > .vsc-btn { flex: 1; min-width: 40%; }',
            '#vsc-master-toggle { white-space: nowrap; flex-shrink: 0; width: auto; }',
            '.vsc-bottom-controls { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 8px; border-top: 1px solid #555; padding-top: 8px; }',
            '.vsc-audio-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; width: 100%; }',
            `.vsc-audio-column { display: flex; flex-direction: column; gap: ${isMobile ? '3px' : '8px'}; border-right: 1px solid #444; padding-right: 12px; }`,
            '.vsc-audio-column:last-child { border-right: none; padding-right: 0; }',
            `.vsc-audio-section-divider { border-top: 1px solid #444; margin-top: ${isMobile ? '4px' : '8px'}; padding-top: ${isMobile ? '4px' : '8px'}; }`
        ];
        function init() {
            if (state.ui.hostElement) return;
            const host = document.createElement('div');
            host.id = UI_SELECTORS.HOST;
            host.style.pointerEvents = 'none';
            state.ui.shadowRoot = host.attachShadow({ mode: 'open' });
            state.ui.hostElement = host;
            const style = document.createElement('style');
            style.textContent = styleRules.join('\n');
            state.ui.shadowRoot.appendChild(style);
        }
        return { init: () => safeExec(init, 'uiManager.init'), reset: () => { state.ui.hostElement = null; state.ui.shadowRoot = null; } };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        let wideningSlider, panSlider, hpfSlider, eqSubBassSlider, eqBassSlider, eqMidSlider, eqTrebleSlider, eqPresenceSlider, reverbMixSlider, preGainSlider, bassBoostSlider;
        let deesserThresholdSlider, deesserFreqSlider, exciterAmountSlider, parallelCompMixSlider;
        let masteringTransientSlider, masteringDriveSlider;
        let hideAllSubMenus = () => { };
        const startFadeSequence = () => {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
            if (container) { hideAllSubMenus(); container.classList.remove('touched'); container.style.opacity = '0.3'; }
        };
        const resetFadeTimer = () => {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
            if (container) { clearTimeout(fadeOutTimer); container.style.opacity = ''; container.classList.add('touched'); fadeOutTimer = setTimeout(startFadeSequence, 10000); }
        };

        function getAutoPreGain(gains) {
            const eqBoost = gains.reduce((acc, gain) => acc + Math.max(gain, 0), 0);
            let preGain = 1.0 - eqBoost * 0.05;
            preGain = Math.min(1.0, Math.max(preGain, 0.9));
            return preGain;
        }

        function init() {
            if (inited) return;
            const shadowRoot = state.ui.shadowRoot;
            if (shadowRoot) { const c = document.createElement('div'); c.id = 'vsc-container'; shadowRoot.appendChild(c); inited = true; }
        }

        const applyPreset = (presetType) => {
            initializeAudioEngine();
            const p = presetMap[presetType];
            if (!p) return;

            const defaults = {
                hpf_enabled: false, hpf_hz: CONFIG.EFFECTS_HPF_FREQUENCY,
                eq_enabled: false, eq_subBass: 0, eq_bass: 0, eq_mid: 0, eq_treble: 0, eq_presence: 0,
                widen_enabled: false, widen_factor: 1.0,
                adaptive_enabled: false,
                reverb_enabled: false, reverb_mix: CONFIG.DEFAULT_REVERB_MIX,
                pan_value: 0,
                preGain_enabled: false, preGain_value: 1.0,
                deesser_enabled: false, deesser_threshold: CONFIG.DEFAULT_DEESSER_THRESHOLD, deesser_freq: CONFIG.DEFAULT_DEESSER_FREQ,
                exciter_enabled: false, exciter_amount: 0,
                parallel_comp_enabled: false, parallel_comp_mix: 0,
                limiter_enabled: false,
                mastering_suite_enabled: false, mastering_transient: 0.2, mastering_drive: 0,
            };

            const final = { ...defaults, ...p };

            if (final.preGain_enabled) {
                const autoPreGain = getAutoPreGain([
                    final.eq_subBass ?? 0, final.eq_bass ?? 0, final.eq_mid ?? 0,
                    final.eq_treble ?? 0, final.eq_presence ?? 0
                ]);
                final.preGain_value = (p.preGain_value ?? 1.0) * autoPreGain;
            }

            Object.assign(state.audio, {
                isHpfEnabled: final.hpf_enabled, currentHpfHz: final.hpf_hz,
                isEqEnabled: final.eq_enabled,
                eqSubBassGain: final.eq_subBass, eqBassGain: final.eq_bass,
                eqMidGain: final.eq_mid, eqTrebleGain: final.eq_treble,
                eqPresenceGain: final.eq_presence,
                isWideningEnabled: final.widen_enabled, currentWideningFactor: final.widen_factor,
                isAdaptiveWidthEnabled: final.adaptive_enabled,
                isReverbEnabled: final.reverb_enabled,
                reverbMix: final.reverb_mix,
                currentStereoPan: final.pan_value,
                isPreGainEnabled: final.preGain_enabled, currentPreGain: final.preGain_value,
                bassBoostGain: final.bassBoostGain ?? state.audio.bassBoostGain,
                bassBoostFreq: final.bassBoostFreq ?? 60,
                bassBoostQ: final.bassBoostQ ?? 1.0,
                isDeesserEnabled: final.deesser_enabled, deesserThreshold: final.deesser_threshold, deesserFreq: final.deesser_freq,
                isExciterEnabled: final.exciter_enabled, exciterAmount: final.exciter_amount,
                isParallelCompEnabled: final.parallel_comp_enabled, parallelCompMix: final.parallel_comp_mix,
                isLimiterEnabled: final.limiter_enabled,
                isMasteringSuiteEnabled: final.mastering_suite_enabled,
                masteringTransientAmount: final.mastering_transient,
                masteringDrive: final.mastering_drive,
            });
            state.audio.lastManualPreGain = state.audio.currentPreGain;

            const allSliders = { hpfSlider, eqSubBassSlider, eqBassSlider, eqMidSlider, eqTrebleSlider, eqPresenceSlider, wideningSlider, panSlider, preGainSlider, bassBoostSlider, reverbMixSlider, deesserThresholdSlider, deesserFreqSlider, exciterAmountSlider, parallelCompMixSlider, masteringTransientSlider, masteringDriveSlider };
            const updateSliderUI = (sliderName, value, unit = '') => {
                const s = allSliders[sliderName];
                if (s) {
                    s.slider.value = value;
                    let displayValue = value;
                    if (typeof value === 'number') {
                        if (['x', 'Hz', 'kHz', '%'].includes(unit) || sliderName.includes('pan')) {
                            displayValue = value.toFixed(1);
                        } else if (['dB', '단계'].includes(unit)) {
                            displayValue = value.toFixed(0);
                        } else {
                            displayValue = value.toFixed(2);
                        }
                    }
                    s.valueSpan.textContent = `${displayValue}${unit}`;
                }
            };

            setHpfEnabled(state.audio.isHpfEnabled); updateSliderUI('hpfSlider', state.audio.currentHpfHz, 'Hz');
            setEqEnabled(state.audio.isEqEnabled);
            updateSliderUI('eqSubBassSlider', state.audio.eqSubBassGain, 'dB');
            updateSliderUI('eqBassSlider', state.audio.eqBassGain, 'dB');
            updateSliderUI('eqMidSlider', state.audio.eqMidGain, 'dB');
            updateSliderUI('eqTrebleSlider', state.audio.eqTrebleGain, 'dB');
            updateSliderUI('eqPresenceSlider', state.audio.eqPresenceGain, 'dB');
            setWideningEnabled(state.audio.isWideningEnabled); updateSliderUI('wideningSlider', state.audio.currentWideningFactor, 'x');
            setAdaptiveWidthEnabled(state.audio.isAdaptiveWidthEnabled);
            setReverbEnabled(state.audio.isReverbEnabled);
            updateSliderUI('reverbMixSlider', state.audio.reverbMix, '');
            updateSliderUI('panSlider', state.audio.currentStereoPan, '');
            setPreGainEnabled(state.audio.isPreGainEnabled);
            updateSliderUI('preGainSlider', state.audio.currentPreGain, 'x');
            updateSliderUI('bassBoostSlider', state.audio.bassBoostGain, 'dB');
            setDeesserEnabled(state.audio.isDeesserEnabled);
            updateSliderUI('deesserThresholdSlider', state.audio.deesserThreshold, 'dB');
            updateSliderUI('deesserFreqSlider', state.audio.deesserFreq, 'Hz');
            if (deesserFreqSlider) deesserFreqSlider.valueSpan.textContent = `${(state.audio.deesserFreq / 1000).toFixed(1)}kHz`;
            setExciterEnabled(state.audio.isExciterEnabled);
            updateSliderUI('exciterAmountSlider', state.audio.exciterAmount, '%');
            setParallelCompEnabled(state.audio.isParallelCompEnabled);
            updateSliderUI('parallelCompMixSlider', state.audio.parallelCompMix, '%');
            setLimiterEnabled(state.audio.isLimiterEnabled);
            setMasteringSuiteEnabled(state.audio.isMasteringSuiteEnabled);
            updateSliderUI('masteringTransientSlider', state.audio.masteringTransientAmount * 100, '%');
            updateSliderUI('masteringDriveSlider', state.audio.masteringDrive, 'dB');

            applyAudioEffectsToMedia();
        };

        let presetMap = {};

        function renderControls() {
            const shadowRoot = state.ui.shadowRoot;
            if (!shadowRoot) return;
            const container = shadowRoot.getElementById('vsc-container');
            if (!container || container.dataset.rendered) return;
            while (container.firstChild) container.removeChild(container.firstChild);
            container.dataset.rendered = 'true';

            const createButton = (id, title, text, className = 'vsc-btn') => { const b = document.createElement('button'); if (id) b.id = id; b.className = className; b.title = title; b.textContent = text; return b; };
            const createControlGroup = (id, mainIcon, title) => {
                const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group';
                const mainBtn = createButton(null, title, mainIcon, 'vsc-btn vsc-btn-main');
                const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu';
                group.append(mainBtn, subMenu); return { group, subMenu };
            };
            const createSelectControl = (labelText, options, changeHandler, id, valueProp = 'value', textProp = 'text') => {
                const select = document.createElement('select'); select.className = 'vsc-select'; if (id) select.id = id;
                if (labelText) {
                    const disabledOption = document.createElement('option');
                    disabledOption.value = ""; disabledOption.textContent = labelText; disabledOption.disabled = true; disabledOption.selected = true;
                    select.appendChild(disabledOption);
                }
                options.forEach(opt => { const o = document.createElement('option'); o.value = opt[valueProp]; o.textContent = opt[textProp]; select.appendChild(o); });
                select.onchange = e => { changeHandler(e.target.value); startFadeSequence(); };
                return select;
            };
            const createSliderControl = (label, id, min, max, step, value, unit) => {
                const div = document.createElement('div'); div.className = 'slider-control';
                const labelEl = document.createElement('label'); const span = document.createElement('span');
                span.id = `${id}Val`;
                let displayValue = value;
                if (typeof value === 'number') {
                    if (unit === 'x' || id.includes('pan') || unit === 'kHz') {
                        displayValue = value.toFixed(1);
                    } else if (unit === 'dB' || unit === '단계' || unit === '%' || unit === 'Hz') {
                        displayValue = value.toFixed(0);
                    } else {
                        displayValue = value.toFixed(2);
                    }
                }
                span.textContent = `${displayValue}${unit}`;
                labelEl.textContent = `${label}: `; labelEl.appendChild(span);
                const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step; slider.value = value;
                div.append(labelEl, slider);
                return { controlDiv: div, slider, valueSpan: span };
            };
            const createDivider = () => {
                const div = document.createElement('div');
                div.className = 'vsc-audio-section-divider';
                return div;
            };
            const createLabeledSelect = (labelText, id, options, changeHandler) => {
                const container = document.createElement('div');
                container.className = 'slider-control';
                const labelEl = document.createElement('label');
                labelEl.textContent = `${labelText}: `;
                labelEl.style.justifyContent = 'flex-start';
                labelEl.style.gap = '8px';
                labelEl.style.alignItems = 'center';
                const select = document.createElement('select');
                select.id = id;
                select.className = 'vsc-select';
                select.style.width = 'auto';
                select.style.flexGrow = '1';
                options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.text;
                    select.appendChild(option);
                });
                select.onchange = (e) => {
                    changeHandler(e.target.value);
                    startFadeSequence();
                };
                labelEl.appendChild(select);
                container.appendChild(labelEl);
                return { controlDiv: container, select: select };
            };

            const { group: imageGroup, subMenu: imageSubMenu } = createControlGroup('vsc-image-controls', '🎨', '이미지 필터');
            const imageOpts = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 20 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];
            imageSubMenu.appendChild(createSelectControl('이미지 선명도', imageOpts, (val) => setImageFilterLevel(val), 'imageFilterSelect'));

            const { group: videoGroup, subMenu: videoSubMenu } = createControlGroup('vsc-video-controls', '✨', '영상 필터');
            videoSubMenu.style.gap = '10px';
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            const videoSliderUpdate = () => { applyAllVideoFilters(); state.media.activeMedia.forEach(m => { if (m.tagName === 'VIDEO') updateVideoFilterState(m); }); };
            const videoFilterDef = settingsManager.definitions.videoFilterLevel;
            const sharpenSlider = createSliderControl('샤프 (윤곽)', 'videoSharpenSlider', videoFilterDef.min, videoFilterDef.max, 1, state.videoFilter.currentVideoFilterLevel, '단계');
            sharpenSlider.slider.oninput = () => { const val = parseInt(sharpenSlider.slider.value, 10); setVideoFilterLevel(val, true, 1); sharpenSlider.valueSpan.textContent = `${val}단계`; };
            const videoFilterDef2 = settingsManager.definitions.videoFilterLevel2;
            const sharpenSlider2 = createSliderControl('샤프 (디테일)', 'videoSharpenSlider2', videoFilterDef2.min, videoFilterDef2.max, 1, state.videoFilter.currentVideoFilterLevel2, '단계');
            sharpenSlider2.slider.oninput = () => { const val = parseInt(sharpenSlider2.slider.value, 10); setVideoFilterLevel(val, true, 2); sharpenSlider2.valueSpan.textContent = `${val}단계`; };
            const sharpenDirOptions = [{ value: "4-way", text: "4방향 (기본)" }, { value: "8-way", text: "8방향 (강함)" }];
            const sharpenDirControl = createLabeledSelect('샤프 방향', 'videoSharpenDirSelect', sharpenDirOptions, (val) => { state.videoFilter.currentVideoSharpenDirection = val; videoSliderUpdate(); });
            sharpenDirControl.select.value = state.videoFilter.currentVideoSharpenDirection;
            const saturationSlider = createSliderControl('채도', 'videoSaturationSlider', 0, 200, 1, state.videoFilter.currentVideoSaturation, '%');
            saturationSlider.slider.oninput = () => { const val = parseInt(saturationSlider.slider.value, 10); state.videoFilter.currentVideoSaturation = val; saturationSlider.valueSpan.textContent = `${val}%`; videoSliderUpdate(); };
            const gammaSlider = createSliderControl('감마', 'videoGammaSlider', 0.5, 1.5, 0.01, state.videoFilter.currentVideoGamma, '');
            gammaSlider.slider.oninput = () => { const val = parseFloat(gammaSlider.slider.value); state.videoFilter.currentVideoGamma = val; gammaSlider.valueSpan.textContent = val.toFixed(2); videoSliderUpdate(); };
            const blurSlider = createSliderControl('블러', 'videoBlurSlider', 0, 1, 0.05, state.videoFilter.currentVideoBlur, '');
            blurSlider.slider.oninput = () => { const val = parseFloat(blurSlider.slider.value); state.videoFilter.currentVideoBlur = val; blurSlider.valueSpan.textContent = val.toFixed(2); videoSliderUpdate(); };
            const shadowsSlider = createSliderControl('대비', 'videoShadowsSlider', -50, 50, 1, state.videoFilter.currentVideoShadows, '');
            shadowsSlider.slider.oninput = () => { const val = parseInt(shadowsSlider.slider.value, 10); state.videoFilter.currentVideoShadows = val; shadowsSlider.valueSpan.textContent = val; videoSliderUpdate(); };
            const highlightsSlider = createSliderControl('밝기', 'videoHighlightsSlider', -50, 50, 1, state.videoFilter.currentVideoHighlights, '');
            highlightsSlider.slider.oninput = () => { const val = parseInt(highlightsSlider.slider.value, 10); state.videoFilter.currentVideoHighlights = val; highlightsSlider.valueSpan.textContent = val; videoSliderUpdate(); };
            const resetVideoBtn = createButton('vsc-reset-video', '영상 필터 초기화', '초기화', 'vsc-btn');
            resetVideoBtn.style.marginTop = '8px';
            resetVideoBtn.onclick = () => {
                setVideoFilterLevel(CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, true, 1);
                setVideoFilterLevel(CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2, true, 2);
                state.videoFilter.currentVideoSharpenDirection = CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION; state.videoFilter.currentVideoSaturation = parseInt(videoDefaults.SATURATION_VALUE, 10);
                state.videoFilter.currentVideoGamma = parseFloat(videoDefaults.GAMMA_VALUE); state.videoFilter.currentVideoBlur = parseFloat(videoDefaults.BLUR_STD_DEVIATION);
                state.videoFilter.currentVideoShadows = parseInt(videoDefaults.SHADOWS_VALUE, 10); state.videoFilter.currentVideoHighlights = parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10);
                sharpenSlider.slider.value = state.videoFilter.currentVideoFilterLevel; sharpenSlider.valueSpan.textContent = `${state.videoFilter.currentVideoFilterLevel}단계`;
                sharpenSlider2.slider.value = state.videoFilter.currentVideoFilterLevel2; sharpenSlider2.valueSpan.textContent = `${state.videoFilter.currentVideoFilterLevel2}단계`;
                sharpenDirControl.select.value = state.videoFilter.currentVideoSharpenDirection; saturationSlider.slider.value = state.videoFilter.currentVideoSaturation;
                saturationSlider.valueSpan.textContent = `${state.videoFilter.currentVideoSaturation}%`; gammaSlider.slider.value = state.videoFilter.currentVideoGamma;
                gammaSlider.valueSpan.textContent = state.videoFilter.currentVideoGamma.toFixed(2); blurSlider.slider.value = state.videoFilter.currentVideoBlur;
                blurSlider.valueSpan.textContent = state.videoFilter.currentVideoBlur.toFixed(2); shadowsSlider.slider.value = state.videoFilter.currentVideoShadows;
                shadowsSlider.valueSpan.textContent = state.videoFilter.currentVideoShadows; highlightsSlider.slider.value = state.videoFilter.currentVideoHighlights;
                highlightsSlider.valueSpan.textContent = state.videoFilter.currentVideoHighlights;
                videoSliderUpdate();
            };
            videoSubMenu.append(sharpenSlider.controlDiv, sharpenSlider2.controlDiv, sharpenDirControl.controlDiv, blurSlider.controlDiv, highlightsSlider.controlDiv, gammaSlider.controlDiv, shadowsSlider.controlDiv, saturationSlider.controlDiv, resetVideoBtn);

            const { group: stereoGroup, subMenu: stereoSubMenu } = createControlGroup('vsc-stereo-controls', '🎧', '사운드 필터');
            const audioGridContainer = document.createElement('div');
            audioGridContainer.className = 'vsc-audio-grid';
            const column1 = document.createElement('div'); column1.className = 'vsc-audio-column';
            const column2 = document.createElement('div'); column2.className = 'vsc-audio-column';
            const column3 = document.createElement('div'); column3.className = 'vsc-audio-column';

            const eqBtn = createButton('vsc-eq-toggle', '5-Band EQ ON/OFF', 'EQ', 'vsc-btn');
            eqBtn.onclick = () => { initializeAudioEngine(); setEqEnabled(!state.audio.isEqEnabled); };
            eqSubBassSlider = createSliderControl('초저음', 'eqSubBassSlider', -12, 12, 1, state.audio.eqSubBassGain, 'dB');
            eqSubBassSlider.slider.oninput = () => { const val = parseFloat(eqSubBassSlider.slider.value); state.audio.eqSubBassGain = val; eqSubBassSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqBassSlider = createSliderControl('저음', 'eqBassSlider', -12, 12, 1, state.audio.eqBassGain, 'dB');
            eqBassSlider.slider.oninput = () => { const val = parseFloat(eqBassSlider.slider.value); state.audio.eqBassGain = val; eqBassSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqMidSlider = createSliderControl('중음', 'eqMidSlider', -12, 12, 1, state.audio.eqMidGain, 'dB');
            eqMidSlider.slider.oninput = () => { const val = parseFloat(eqMidSlider.slider.value); state.audio.eqMidGain = val; eqMidSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqTrebleSlider = createSliderControl('고음', 'eqTrebleSlider', -12, 12, 1, state.audio.eqTrebleGain, 'dB');
            eqTrebleSlider.slider.oninput = () => { const val = parseFloat(eqTrebleSlider.slider.value); state.audio.eqTrebleGain = val; eqTrebleSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqPresenceSlider = createSliderControl('초고음', 'eqPresenceSlider', -12, 12, 1, state.audio.eqPresenceGain, 'dB');
            eqPresenceSlider.slider.oninput = () => { const val = parseFloat(eqPresenceSlider.slider.value); state.audio.eqPresenceGain = val; eqPresenceSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            bassBoostSlider = createSliderControl('베이스 부스트', 'bassBoostSlider', 0, 9, 0.5, state.audio.bassBoostGain, 'dB');
            bassBoostSlider.slider.oninput = () => { const val = parseFloat(bassBoostSlider.slider.value); state.audio.bassBoostGain = val; bassBoostSlider.valueSpan.textContent = `${val.toFixed(1)} dB`; applyAudioEffectsToMedia(); };
            const hpfBtn = createButton('vsc-hpf-toggle', 'High-Pass Filter (저음 컷)', 'HPF', 'vsc-btn');
            hpfBtn.onclick = () => { initializeAudioEngine(); setHpfEnabled(!state.audio.isHpfEnabled); };
            hpfSlider = createSliderControl('HPF 주파수', 'hpfSlider', 20, 500, 5, state.audio.currentHpfHz, 'Hz');
            hpfSlider.slider.oninput = () => { const val = parseFloat(hpfSlider.slider.value); state.audio.currentHpfHz = val; hpfSlider.valueSpan.textContent = `${val.toFixed(0)}Hz`; applyAudioEffectsToMedia(); };
            column1.append(eqBtn, eqSubBassSlider.controlDiv, eqBassSlider.controlDiv, eqMidSlider.controlDiv, eqTrebleSlider.controlDiv, eqPresenceSlider.controlDiv, createDivider(), bassBoostSlider.controlDiv, createDivider(), hpfBtn, hpfSlider.controlDiv);

            const deesserBtn = createButton('vsc-deesser-toggle', '디에서 (치찰음 제거)', '디에서', 'vsc-btn');
            deesserBtn.onclick = () => { initializeAudioEngine(); setDeesserEnabled(!state.audio.isDeesserEnabled); };
            deesserThresholdSlider = createSliderControl('강도', 'deesserThresholdSlider', -60, 0, 1, state.audio.deesserThreshold, 'dB');
            deesserThresholdSlider.slider.oninput = () => { const val = parseFloat(deesserThresholdSlider.slider.value); state.audio.deesserThreshold = val; deesserThresholdSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            deesserFreqSlider = createSliderControl('주파수', 'deesserFreqSlider', 4000, 12000, 100, state.audio.deesserFreq, 'Hz');
            deesserFreqSlider.slider.oninput = () => { const val = parseFloat(deesserFreqSlider.slider.value); state.audio.deesserFreq = val; deesserFreqSlider.valueSpan.textContent = `${(val / 1000).toFixed(1)}kHz`; applyAudioEffectsToMedia(); };
            const exciterBtn = createButton('vsc-exciter-toggle', '익사이터 (선명도/광택)', '익사이터', 'vsc-btn');
            exciterBtn.onclick = () => { initializeAudioEngine(); setExciterEnabled(!state.audio.isExciterEnabled); };
            exciterAmountSlider = createSliderControl('강도', 'exciterAmountSlider', 0, 100, 1, state.audio.exciterAmount, '%');
            exciterAmountSlider.slider.oninput = () => { const val = parseFloat(exciterAmountSlider.slider.value); state.audio.exciterAmount = val; exciterAmountSlider.valueSpan.textContent = `${val.toFixed(0)}%`; applyAudioEffectsToMedia(); };
            const parallelCompBtn = createButton('vsc-parallel-comp-toggle', '병렬 압축 (디테일 향상)', '업컴프', 'vsc-btn');
            parallelCompBtn.onclick = () => { initializeAudioEngine(); setParallelCompEnabled(!state.audio.isParallelCompEnabled); };
            parallelCompMixSlider = createSliderControl('믹스', 'parallelCompMixSlider', 0, 100, 1, state.audio.parallelCompMix, '%');
            parallelCompMixSlider.slider.oninput = () => { const val = parseFloat(parallelCompMixSlider.slider.value); state.audio.parallelCompMix = val; parallelCompMixSlider.valueSpan.textContent = `${val.toFixed(0)}%`; applyAudioEffectsToMedia(); };
            column2.append(deesserBtn, deesserThresholdSlider.controlDiv, deesserFreqSlider.controlDiv, createDivider(), exciterBtn, exciterAmountSlider.controlDiv, createDivider(), parallelCompBtn, parallelCompMixSlider.controlDiv);

            const widenBtn = createButton('vsc-widen-toggle', 'Virtualizer ON/OFF', 'Virtualizer', 'vsc-btn');
            widenBtn.onclick = () => { initializeAudioEngine(); setWideningEnabled(!state.audio.isWideningEnabled); };
            const adaptiveWidthBtn = createButton('vsc-adaptive-width-toggle', '저역 폭 제어 ON/OFF', 'Bass Mono', 'vsc-btn');
            adaptiveWidthBtn.onclick = () => { initializeAudioEngine(); setAdaptiveWidthEnabled(!state.audio.isAdaptiveWidthEnabled); };
            wideningSlider = createSliderControl('강도', 'wideningSlider', 0, 3, 0.1, state.audio.currentWideningFactor, 'x');
            wideningSlider.slider.oninput = () => { const val = parseFloat(wideningSlider.slider.value); state.audio.currentWideningFactor = val; wideningSlider.valueSpan.textContent = `${val.toFixed(1)}x`; applyAudioEffectsToMedia(); };
            panSlider = createSliderControl('Pan (좌우)', 'panSlider', -1, 1, 0.1, state.audio.currentStereoPan, '');
            panSlider.slider.oninput = () => { const val = parseFloat(panSlider.slider.value); state.audio.currentStereoPan = val; panSlider.valueSpan.textContent = val.toFixed(1); applyAudioEffectsToMedia(); };
            const reverbBtn = createButton('vsc-reverb-toggle', '리버브 ON/OFF', '리버브', 'vsc-btn');
            reverbBtn.onclick = () => { initializeAudioEngine(); setReverbEnabled(!state.audio.isReverbEnabled); };
            reverbMixSlider = createSliderControl('울림 크기', 'reverbMixSlider', 0, 1, 0.05, state.audio.reverbMix, '');
            reverbMixSlider.slider.oninput = () => { const val = parseFloat(reverbMixSlider.slider.value); state.audio.reverbMix = val; reverbMixSlider.valueSpan.textContent = val.toFixed(2); applyAudioEffectsToMedia(); };
            const preGainBtnGroup = document.createElement('div'); preGainBtnGroup.className = 'vsc-button-group';
            const preGainBtn = createButton('vsc-pregain-toggle', '볼륨 ON/OFF', '볼륨', 'vsc-btn');
            preGainBtn.onclick = () => { initializeAudioEngine(); setPreGainEnabled(!state.audio.isPreGainEnabled); };
            const autoVolumeBtn = createButton('vsc-auto-volume-toggle', '음량 평준화 (Shift+Click: 초기화)', '자동', 'vsc-btn');
            autoVolumeBtn.onclick = (event) => {
                initializeAudioEngine();
                const media = isMobile && state.media.currentlyVisibleMedia ? state.media.currentlyVisibleMedia : Array.from(state.media.activeMedia)[0];
                if (!media) return;
                const nodes = state.audio.audioContextMap.get(media);
                if (event.shiftKey && nodes) {
                    nodes.cumulativeLUFS = 0; nodes.lufsSampleCount = 0;
                    showWarningMessage('음량 평준화 기록을 초기화했습니다.');
                } else if (media && !state.audio.isAnalyzingLoudness) {
                    audioEffectsManager.startLoudnessNormalization(media);
                }
            };
            preGainBtnGroup.append(preGainBtn, autoVolumeBtn);
            preGainSlider = createSliderControl('볼륨 크기', 'preGainSlider', 0, 4, 0.1, state.audio.currentPreGain, 'x');
            preGainSlider.slider.oninput = () => {
                const val = parseFloat(preGainSlider.slider.value);
                state.audio.currentPreGain = val;
                state.audio.lastManualPreGain = val;
                preGainSlider.valueSpan.textContent = `${val.toFixed(1)}x`;
                applyAudioEffectsToMedia();
            };
            column3.append(widenBtn, wideningSlider.controlDiv, adaptiveWidthBtn, panSlider.controlDiv, createDivider(), reverbBtn, reverbMixSlider.controlDiv, createDivider(), preGainBtnGroup, preGainSlider.controlDiv);

            const bottomRow2 = document.createElement('div');
            bottomRow2.className = 'vsc-audio-column';
            bottomRow2.style.cssText = `grid-column: 1 / -1; border-right: none; padding-right: 0; display: flex; flex-direction: row; align-items: center; gap: 12px;`;
            const masteringSuiteBtn = createButton('vsc-mastering-suite-toggle', '마스터링 스위트', '마스터링', 'vsc-btn');
            masteringSuiteBtn.onclick = () => { initializeAudioEngine(); setMasteringSuiteEnabled(!state.audio.isMasteringSuiteEnabled); };
            masteringSuiteBtn.style.flex = '1';

            masteringTransientSlider = createSliderControl('타격감', 'masteringTransientSlider', 0, 100, 1, state.audio.masteringTransientAmount * 100, '%');
            masteringTransientSlider.slider.oninput = () => {
                const val = parseFloat(masteringTransientSlider.slider.value);
                state.audio.masteringTransientAmount = val / 100;
                masteringTransientSlider.valueSpan.textContent = `${val.toFixed(0)}%`;
                applyAudioEffectsToMedia();
            };
            masteringTransientSlider.controlDiv.style.flex = '1';
            masteringDriveSlider = createSliderControl('음압', 'masteringDriveSlider', 0, 12, 0.5, state.audio.masteringDrive, 'dB');
            masteringDriveSlider.slider.oninput = () => {
                const val = parseFloat(masteringDriveSlider.slider.value);
                state.audio.masteringDrive = val;
                masteringDriveSlider.valueSpan.textContent = `${val.toFixed(1)}dB`;
                applyAudioEffectsToMedia();
            };
            masteringDriveSlider.controlDiv.style.flex = '1';
            bottomRow2.append(masteringSuiteBtn, masteringTransientSlider.controlDiv, masteringDriveSlider.controlDiv);

            const bottomControlsContainer = document.createElement('div');
            bottomControlsContainer.style.cssText = `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; border-top: 1px solid #444; padding-top: 8px; grid-column: 1 / -1;`;
            const resetBtn = createButton('vsc-reset-all', '모든 오디오 설정 기본값으로 초기화', '초기화', 'vsc-btn');

            presetMap = {
                'default': { name: '기본값 (모든 효과 꺼짐)' },
                'basic_clear': { name: '✔ 기본 개선 (명료)', hpf_enabled: true, hpf_hz: 70, eq_enabled: true, eq_mid: 2, eq_treble: 1.5, eq_presence: 2, preGain_enabled: true, preGain_value: 1, mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 2, },
                'movie_immersive': { name: '🎬 영화/드라마 (몰입감)', hpf_enabled: true, hpf_hz: 60, eq_enabled: true, eq_subBass: 1, eq_bass: 0.8, eq_mid: 2, eq_treble: 1.3, eq_presence: 1.2, widen_enabled: true, widen_factor: 1.4, deesser_enabled: true, deesser_threshold: -35, parallel_comp_enabled: true, parallel_comp_mix: 15, mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 2.5, },
                'action_blockbuster': { name: '💥 액션 블록버스터 (타격감)', hpf_enabled: true, hpf_hz: 50, eq_enabled: true, eq_subBass: 1.5, eq_bass: 1.2, eq_mid: -2, eq_treble: 1.2, eq_presence: 1.8, widen_enabled: true, widen_factor: 1.5, parallel_comp_enabled: true, parallel_comp_mix: 18, mastering_suite_enabled: true, mastering_transient: 0.5, mastering_drive: 3, },
                'concert_hall': { name: '🏟️ 라이브 콘서트 (현장감)', hpf_enabled: true, hpf_hz: 60, eq_enabled: true, eq_subBass: 1, eq_bass: 1, eq_mid: 0.5, eq_treble: 1, eq_presence: 1.2, widen_enabled: true, widen_factor: 1.3, preGain_enabled: true, preGain_value: 1.2, reverb_enabled: true, reverb_mix: 0.5, mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 2.5, },
                'music_dynamic': { name: '🎶 음악 (다이나믹 & 펀치감)', hpf_enabled: true, hpf_hz: 40, eq_enabled: true, eq_subBass: 1.2, eq_bass: 1.2, eq_mid: 1, eq_treble: 1, eq_presence: 2, widen_enabled: true, widen_factor: 1.3, exciter_enabled: true, exciter_amount: 12, mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 3, },
                'mastering_balanced': { name: '🔥 밸런스 마스터링 (고음질)', hpf_enabled: true, hpf_hz: 45, eq_enabled: true, eq_treble: 1.2, eq_presence: 1, widen_enabled: true, widen_factor: 1.25, exciter_enabled: true, exciter_amount: 10, mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 3.5, },
                'vocal_clarity_pro': { name: '🎙️ 목소리 명료 (강의/뉴스)', hpf_enabled: true, hpf_hz: 110, eq_enabled: true, eq_subBass: -2, eq_bass: -1, eq_mid: 3, eq_treble: 2, eq_presence: 2.5, preGain_enabled: true, preGain_value: 1.2, deesser_enabled: true, deesser_threshold: -35, parallel_comp_enabled: true, parallel_comp_mix: 12, mastering_suite_enabled: true, mastering_transient: 0.1, mastering_drive: 1.5, },
                'gaming_pro': { name: '🎮 게이밍 (사운드 플레이)', hpf_enabled: true, hpf_hz: 50, eq_enabled: true, eq_subBass: -1, eq_mid: 2, eq_treble: 2, eq_presence: 2.5, widen_enabled: true, widen_factor: 1.2, preGain_enabled: true, preGain_value: 1.2, mastering_suite_enabled: true, mastering_transient: 0.5, mastering_drive: 2.5, },
            };
            const presetOptions = Object.entries(presetMap).map(([value, { name }]) => ({ value, text: name }));
            const presetSelect = createSelectControl('프리셋 선택', presetOptions, (val) => { if (val) applyPreset(val); }, 'presetSelect');
            resetBtn.onclick = () => { applyPreset('default'); if (presetSelect) presetSelect.selectedIndex = 0; };
            bottomControlsContainer.append(presetSelect, resetBtn);

            audioGridContainer.append(column1, column2, column3, createDivider(), bottomRow2, bottomControlsContainer);
            stereoSubMenu.append(audioGridContainer);

            container.append(imageGroup, videoGroup, stereoGroup);

            const allGroups = [imageGroup, videoGroup, stereoGroup];
            hideAllSubMenus = () => allGroups.forEach(g => g.classList.remove('submenu-visible'));
            allGroups.forEach(g => g.querySelector('.vsc-btn-main').onclick = (e) => {
                e.stopPropagation();
                if (g.id === 'vsc-stereo-controls') { initializeAudioEngine(); }
                const isOpening = !g.classList.contains('submenu-visible');
                hideAllSubMenus();
                if (isOpening) g.classList.add('submenu-visible');
                resetFadeTimer();
            });

            const updateActiveButtons = () => {
                if (shadowRoot.querySelector('#imageFilterSelect')) shadowRoot.querySelector('#imageFilterSelect').value = state.imageFilter.currentImageFilterLevel;
                setWideningEnabled(state.audio.isWideningEnabled);
                setHpfEnabled(state.audio.isHpfEnabled);
                setEqEnabled(state.audio.isEqEnabled);
                setReverbEnabled(state.audio.isReverbEnabled);
                updateAutoVolumeButtonStyle();
                setPreGainEnabled(state.audio.isPreGainEnabled);
                setDeesserEnabled(state.audio.isDeesserEnabled);
                setExciterEnabled(state.audio.isExciterEnabled);
                setParallelCompEnabled(state.audio.isParallelCompEnabled);
                setLimiterEnabled(state.audio.isLimiterEnabled);
                setMasteringSuiteEnabled(state.audio.isMasteringSuiteEnabled);
            };

            container.addEventListener('pointerdown', resetFadeTimer);
            updateActiveButtons();
        }

        return {
            init: () => safeExec(init, 'speedSlider.init'),
            reset: () => { inited = false; },
            renderControls: () => safeExec(renderControls, 'speedSlider.renderControls'),
            show: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) { el.style.display = 'flex'; resetFadeTimer(); } },
            hide: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) { el.style.display = 'none'; speedSlider.hideSubMenus(); } },
            doFade: startFadeSequence,
            resetFadeTimer: resetFadeTimer,
            hideSubMenus: hideAllSubMenus,
            applyPreset
        };
    })();

    const mediaSessionManager = (() => {
        let inited = false;
        const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); };
        const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; };
        const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; };
        const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) { } };
        function init() { if (inited) return; inited = true; }
        function setSession(m) {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                const { title, artist } = getMeta();
                navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'Video_Image_Control' });
                setAction('play', () => safeExec(() => m.play()));
                setAction('pause', () => safeExec(() => m.pause()));
                setAction('seekbackward', () => safeExec(() => { m.currentTime -= getSeekTime(m); }));
                setAction('seekforward', () => safeExec(() => { m.currentTime += getSeekTime(m); }));
                setAction('seekto', d => safeExec(() => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }));
            }, 'mediaSession.set');
        }
        function clearSession() { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); }
        return { init, setSession, clearSession };
    })();

    const autoDelayManager = (() => {
    let video = null;
    let avgDelay = null;
    const CHECK_INTERVAL = 1000; // 1초마다 체크
    const MIN_RATE = 1, MAX_RATE = 1.2, TOLERANCE = 150;
    let intervalId = null;
    let delayMeterClosed = false;
    let lastDisplayDelay = null;

    // PID 제어 변수
    let pidIntegral = 0;
    let lastError = 0;
    const PID_KP = 0.0002;
    const PID_KI = 0.00001;
    const PID_KD = 0.0001;

    function findVideo() {
        // 화면에 보이는 비디오 중 가장 큰 것을 우선으로 찾음
        const visibleVideos = Array.from(state.media.activeMedia)
            .filter(m => m.tagName === 'VIDEO' && m.dataset.isVisible === 'true');
        if (visibleVideos.length === 0) return null;
        return visibleVideos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    }

    function calculateDelay(v) {
        if (!v) return null;
        if (typeof v.liveLatency === 'number' && v.liveLatency > 0) {
            return v.liveLatency * 1000;
        }
        if (v.buffered && v.buffered.length > 0) {
            try {
                const end = v.buffered.end(v.buffered.length - 1);
                if (v.currentTime > end) return 0;
                return Math.max(0, (end - v.currentTime) * 1000);
            } catch { return null; }
        }
        return null;
    }

    function updateAvgDelay(rawDelay) {
        const alpha = rawDelay > 1000 ? 0.3 : 0.1;
        avgDelay = avgDelay === null ? rawDelay : alpha * rawDelay + (1 - alpha) * avgDelay;
    }

    function getSmoothPlaybackRate(currentDelay, targetDelay) {
        const error = currentDelay - targetDelay;
        pidIntegral += error;
        const derivative = error - lastError;
        lastError = error;
        let rateChange = PID_KP * error + PID_KI * pidIntegral + PID_KD * derivative;
        let newRate = 1 + rateChange;
        return Math.max(MIN_RATE, Math.min(newRate, MAX_RATE));
    }

    function updateDelayUI(rawDelay) {
        if (delayMeterClosed) return;
        let infoEl = document.getElementById('vsc-delay-info');
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.id = 'vsc-delay-info';
            Object.assign(infoEl.style, {
                position: 'fixed', bottom: '100px', right: '10px',
                zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)', color: '#fff',
                padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace',
                fontSize: '10pt', pointerEvents: 'auto', display: 'flex',
                alignItems: 'center', gap: '10px'
            });
            const textSpan = document.createElement('span');
            textSpan.id = 'vsc-delay-text';
            const refreshBtn = document.createElement('button');
            refreshBtn.textContent = '🔄';
            refreshBtn.title = '새로고침';
            Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' });
            refreshBtn.onclick = () => { avgDelay = null; pidIntegral = 0; lastError = 0; textSpan.textContent = '딜레이 리셋 중...'; };
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '✖';
            closeBtn.title = '닫기';
            Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' });
            closeBtn.onclick = () => { infoEl.remove(); delayMeterClosed = true; stop(); };
            infoEl.append(textSpan, refreshBtn, closeBtn);
            document.body.appendChild(infoEl);
        }
        const textSpan = infoEl.querySelector('#vsc-delay-text');
        if (textSpan) {
            if (rawDelay === null) {
                textSpan.textContent = '딜레이 측정 중...';
            } else {
                textSpan.textContent = `딜레이: ${avgDelay?.toFixed(0) || 0}ms / 현재: ${rawDelay?.toFixed(0) || 0}ms / 배속: ${video?.playbackRate?.toFixed(3) || 1.0}x`;
            }
        }
    }

    function checkAndAdjust() {
        video = findVideo();
        if (!video) {
            stop(); // 보이는 비디오가 없으면 정지
            return;
        }

        const rawDelay = calculateDelay(video);

        // UI를 먼저 업데이트 (값이 없으면 "측정 중" 표시)
        updateDelayUI(rawDelay);

        if (rawDelay === null) {
            return; // 딜레이 값을 아직 얻을 수 없으면 배속 조절은 건너뜀
        }

        updateAvgDelay(rawDelay);

        const targetDelay = getTargetDelay();
        const newRate = getSmoothPlaybackRate(avgDelay, targetDelay);
        if (Math.abs(video.playbackRate - newRate) > 0.001) video.playbackRate = newRate;
    }

    function start() {
        if (!CONFIG.LIVE_STREAM_URLS.some(d => location.href.includes(d))) return;
        if (intervalId) return; // 이미 실행 중이면 중복 방지

        // Interval을 즉시 시작하여 UI가 안정적으로 나타나도록 보장
        intervalId = setInterval(checkAndAdjust, CHECK_INTERVAL);
    }

    function stop() {
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
        video = null;
        avgDelay = null;
        lastDisplayDelay = null;
        pidIntegral = 0;
        lastError = 0;
        const infoEl = document.getElementById('vsc-delay-info');
        if (infoEl) infoEl.remove();
        // delayMeterClosed는 닫기 버튼으로만 제어되므로 여기서 초기화하지 않음
    }

    return { start, stop };
})();


    function findAllMedia(doc = document) {
        const elems = new Set();
        const q = 'video, audio';
        const filterFn = m => m.tagName === 'AUDIO' || (m.getBoundingClientRect().width >= CONFIG.VIDEO_MIN_SIZE || m.getBoundingClientRect().height >= CONFIG.VIDEO_MIN_SIZE);
        safeExec(() => {
            doc.querySelectorAll(q).forEach(m => filterFn(m) && elems.add(m));
            (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => {
                try { root.querySelectorAll(q).forEach(m => filterFn(m) && elems.add(m)); } catch (e) { }
            });
            doc.querySelectorAll('iframe').forEach(f => {
                try { if (f.contentDocument) findAllMedia(f.contentDocument).forEach(m => elems.add(m)); } catch (e) { }
            });
        });
        return [...elems];
    }
    function findAllImages(doc = document) {
        const elems = new Set();
        const s = CONFIG.IMAGE_MIN_SIZE;
        const filterFn = i => i.naturalWidth > s && i.naturalHeight > s;
        safeExec(() => {
            doc.querySelectorAll('img').forEach(i => filterFn(i) && elems.add(i));
            (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(r => r.querySelectorAll('img').forEach(i => filterFn(i) && elems.add(i)));
        });
        return [...elems];
    }

    function updateVideoFilterState(video) {
        if (!video || !filterManager.isInitialized()) return;
        const shouldApply = state.videoFilter.currentVideoFilterLevel > 0 ||
            state.videoFilter.currentVideoFilterLevel2 > 0 ||
            Math.abs(state.videoFilter.currentVideoSaturation - 100) > 0.1 ||
            Math.abs(state.videoFilter.currentVideoGamma - 1.0) > 0.001 ||
            state.videoFilter.currentVideoBlur > 0 ||
            state.videoFilter.currentVideoShadows !== 0 ||
            state.videoFilter.currentVideoHighlights !== 0;

        if (video.dataset.isVisible !== 'false' && shouldApply) {
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            const combinedFilterId = `${videoDefaults.SHARPEN_ID}_combined_filter`;
            video.style.setProperty('filter', `url(#${combinedFilterId})`, 'important');
        } else {
            video.style.removeProperty('filter');
        }
    }
    function updateImageFilterState(image) { if (!imageFilterManager.isInitialized()) return; image.classList.toggle('vsc-image-filter-active', image.dataset.isVisible !== 'false' && state.imageFilter.currentImageFilterLevel > 0); }
    function updateActiveSpeedButton(rate) { if (!speedButtonsContainer) return; speedButtonsContainer.querySelectorAll('button').forEach(b => { const br = parseFloat(b.dataset.speed); b.style.boxShadow = Math.abs(br - rate) < 0.01 ? '0 0 5px #3498db, 0 0 10px #3498db inset' : 'none'; }); }

    const mediaEventHandlers = {
        play: e => {
            const m = e.target;
            if (m.tagName === 'VIDEO') updateVideoFilterState(m);
            mediaSessionManager.setSession(m);
        },
        pause: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.media.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.media.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ratechange: e => { updateActiveSpeedButton(e.target.playbackRate); },
        volumechange: () => { /* No longer needed for loudness, but hook kept for future use */ },
    };

    function injectFiltersIntoRoot(element, manager) {
        const root = element.getRootNode();
        const attr = `data-vsc-filters-injected-${manager === filterManager ? 'video' : 'image'}`;
        if (root instanceof ShadowRoot && !root.host.hasAttribute(attr)) {
            const svgNode = manager.getSvgNode();
            const styleNode = manager.getStyleNode();
            if (svgNode && styleNode) {
                const newStyle = styleNode.cloneNode(true);
                root.appendChild(newStyle);
                root.appendChild(svgNode.cloneNode(true));
                root.host.setAttribute(attr, 'true');

                setTimeout(() => {
                    if (element.tagName === 'VIDEO') {
                        applyAllVideoFilters();
                    } else {
                        const level = state.imageFilter.currentImageFilterLevel;
                        manager.updateFilterValues({ sharpenMatrix: calculateSharpenMatrix(level) }, root);
                    }
                }, 100);
            }
        }
    }

    function attachMediaListeners(media) {
        if (!media || state.media.processedMedia.has(media) || !intersectionObserver) return;
        if (media.tagName === 'VIDEO') {
            injectFiltersIntoRoot(media, filterManager);
        }
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) { listeners[evt] = handler; media.addEventListener(evt, handler); }
        state.media.mediaListenerMap.set(media, listeners);
        state.media.processedMedia.add(media);
        intersectionObserver.observe(media);
    }
    function attachImageListeners(image) {
        if (!image || state.media.processedImages.has(image) || !intersectionObserver) return;
        injectFiltersIntoRoot(image, imageFilterManager);
        state.media.processedImages.add(image);
        intersectionObserver.observe(image);
    }
    function detachMediaListeners(media) {
        if (!state.media.mediaListenerMap.has(media)) return;
        const listeners = state.media.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) media.removeEventListener(evt, listener);
        state.media.mediaListenerMap.delete(media);
        if (intersectionObserver) intersectionObserver.unobserve(media);
        audioEffectsManager.cleanupForMedia(media);
    }
    function detachImageListeners(image) {
        if (!state.media.processedImages.has(image)) return;
        state.media.processedImages.delete(image);
        if (intersectionObserver) intersectionObserver.unobserve(image);
    }

    // --- `scanAndApply` Refactoring Start ---

    function processMediaElements() {
        const allMedia = findAllMedia();
        allMedia.forEach(attachMediaListeners);

        const oldMedia = new Set(state.media.activeMedia);
        state.media.activeMedia.clear();
        allMedia.forEach(m => {
            if (m.isConnected) {
                state.media.activeMedia.add(m);
                oldMedia.delete(m);
            }
        });
        oldMedia.forEach(detachMediaListeners);

        if (!isMobile) {
            allMedia.forEach(m => {
                if (m.tagName === 'VIDEO') {
                    m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended);
                    updateVideoFilterState(m);
                }
            });
        }
    }

    function processImageElements() {
        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);

        const oldImages = new Set(state.media.activeImages);
        state.media.activeImages.clear();
        allImages.forEach(img => {
            if (img.isConnected) {
                state.media.activeImages.add(img);
                oldImages.delete(img);
            }
        });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);
    }

    function updateUIVisibility() {
        const root = state.ui?.shadowRoot;
        if (!root) return;

        const hasVideo = Array.from(state.media.activeMedia).some(m => m.tagName === 'VIDEO');
        const hasAudio = Array.from(state.media.activeMedia).some(m => m.tagName === 'AUDIO');
        const hasImage = state.media.activeImages.size > 0;
        const hasAnyMedia = hasVideo || hasAudio;

        if (speedButtonsContainer && triggerElement) {
            const areControlsVisible = triggerElement.textContent === '🛑';
            speedButtonsContainer.style.display = hasVideo && areControlsVisible ? 'flex' : 'none';
        }

        if (hasVideo) state.media.mediaTypesEverFound.video = true;
        if (hasImage) state.media.mediaTypesEverFound.image = true;

        filterManager.toggleStyleSheet(state.media.mediaTypesEverFound.video);
        imageFilterManager.toggleStyleSheet(state.media.mediaTypesEverFound.image);

        const setDisplay = (id, visible) => { const el = root.getElementById(id); if (el) el.style.display = visible ? 'flex' : 'none'; };
        setDisplay('vsc-video-controls', hasVideo);
        setDisplay('vsc-image-controls', hasImage);
        setDisplay('vsc-stereo-controls', hasAnyMedia);
    }

    const scanAndApply = () => {
        processMediaElements();
        processImageElements();
        updateUIVisibility();
    };

    // --- `scanAndApply` Refactoring End ---

    const debouncedScanTask = debounce(scanAndApply, CONFIG.DEBOUNCE_DELAY);
    let mainObserver = null;
    let intersectionObserver = null;
    let isInitialized = false;

    function cleanup() {
        safeExec(() => {
            if (speedSlider) {
                speedSlider.hideSubMenus();
            }
            resetEffectStatesToDefault();

            if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
            if (intersectionObserver) { intersectionObserver.disconnect(); intersectionObserver = null; }
            if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }

            if (idleCallbackId) window.cancelIdleCallback(idleCallbackId);
            const globalUIManagerInstance = globalUIManager.getInstance();
            if (globalUIManagerInstance && globalUIManagerInstance.cleanupAsync) {
                globalUIManagerInstance.cleanupAsync();
            }

            autoDelayManager.stop();
            mediaSessionManager.clearSession();

            setVideoFilterLevel(0);
            setImageFilterLevel(0);
            const allRoots = [document, ...(window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean)];
            allRoots.forEach(root => root.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(el => el.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active', 'vsc-gpu-accelerated')));

            if (state.ui?.hostElement) {
                state.ui.hostElement.remove();
            }
            if (speedButtonsContainer) speedButtonsContainer.style.display = 'none';
            uiManager.reset();
            speedSlider.reset();

            isInitialized = false;
        }, 'cleanup');
    }

    function ensureObservers() {
        if (!mainObserver) {
            mainObserver = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1 && (node.matches('video, audio, img') || node.querySelector('video, audio, img'))) {
                                scheduleIdleTask(scanAndApply);
                                return;
                            }
                        }
                    }
                }
            });
            mainObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        if (!intersectionObserver) {
            intersectionObserver = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    e.target.dataset.isVisible = String(e.isIntersecting);
                    if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target);
                    if (e.target.tagName === 'IMG') updateImageFilterState(e.target);
                });

                if (isMobile) {
                    let mostVisibleEntry = null;
                    let maxRatio = -1;
                    entries.forEach(entry => {
                        if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
                            maxRatio = entry.intersectionRatio;
                            mostVisibleEntry = entry;
                        }
                    });
                    const newVisibleMedia = mostVisibleEntry ? mostVisibleEntry.target : null;
                    if (state.media.currentlyVisibleMedia !== newVisibleMedia) {
                        state.media.currentlyVisibleMedia = newVisibleMedia;
                    }
                }
            }, {
                root: null,
                rootMargin: '0px',
                threshold: [0, 0.5, 1.0]
            });
        }
    }

    let spaNavigationHandler = null;
    function hookSpaNavigation() {
        if (spaNavigationHandler) return;
        spaNavigationHandler = debounce(() => {
            if (location.href === state.ui.lastUrl) return;

            if (uiContainer) {
                uiContainer.remove();
                uiContainer = null;
                triggerElement = null;
                speedButtonsContainer = null;
            }
            state.media.activeMedia.forEach(m => audioEffectsManager.cleanupForMedia(m));
            cleanup();
            globalUIManager.getInstance().cleanupGlobalListeners();
            resetState();
            settingsManager.init();
            uiManager.reset();
            speedSlider.reset();

            // Use setTimeout with 0 delay instead of a fixed 500ms
            setTimeout(initializeGlobalUI, 0);
        }, 500);
        if (!window.vscPatchedHistory) {
            ['pushState', 'replaceState'].forEach(method => {
                const original = history[method];
                if (original) {
                    history[method] = function (...args) {
                        const result = original.apply(this, args);
                        window.dispatchEvent(new Event(`vsc:${method}`));
                        return result;
                    }
                }
            });
            window.vscPatchedHistory = true;
        }
        window.addEventListener('popstate', spaNavigationHandler);
        window.addEventListener('vsc:pushState', spaNavigationHandler);
        window.addEventListener('vsc:replaceState', spaNavigationHandler);
        document.addEventListener('addShadowRoot', debouncedScanTask);
    }

    function start() {
        state.ui.lastUrl = location.href;
        uiManager.init();
        if (uiContainer && state.ui?.hostElement) {
            const mainControlsWrapper = uiContainer.querySelector('#vsc-main-controls-wrapper');
            if (mainControlsWrapper && !mainControlsWrapper.contains(state.ui.hostElement)) {
                mainControlsWrapper.appendChild(state.ui.hostElement);
            }
        }

        filterManager.init();
        imageFilterManager.init();
        speedSlider.init();
        mediaSessionManager.init();
        ensureObservers();
        autoDelayManager.start();

        speedSlider.renderControls();
        speedSlider.show();

        scanAndApply();

        applyAllVideoFilters();
        setImageFilterLevel(settingsManager.get('imageFilterLevel'));

        const initialRate = state.media.activeMedia.size > 0 ? Array.from(state.media.activeMedia)[0].playbackRate : 1.0;
        updateActiveSpeedButton(initialRate);

        if (!titleObserver) {
            const titleElement = document.querySelector('head > title');
            if (titleElement) {
                titleObserver = new MutationObserver(() => {
                    const activeVideo = Array.from(state.media.activeMedia).find(m => m.tagName === 'VIDEO' && !m.paused);
                    if (activeVideo) mediaSessionManager.setSession(activeVideo);
                });
                titleObserver.observe(titleElement, { childList: true });
            }
        }
        isInitialized = true;
    }

    function showWarningMessage(message) {
        let warningEl = document.getElementById('vsc-warning-bar');
        if (warningEl) {
            warningEl.querySelector('span').textContent = message;
            warningEl.style.opacity = '1';
            if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout);
            warningEl.hideTimeout = setTimeout(() => {
                warningEl.style.opacity = '0';
                setTimeout(() => warningEl.remove(), 500);
            }, CONFIG.UI_WARN_TIMEOUT);
            return;
        }
        warningEl = document.createElement('div');
        warningEl.id = 'vsc-warning-bar';
        const messageSpan = document.createElement('span');
        const closeBtn = document.createElement('button');

        Object.assign(warningEl.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px',
            borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex',
            alignItems: 'center', gap: '15px', fontSize: '14px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0',
            transition: 'opacity 0.5s ease-in-out', maxWidth: '90%',
        });
        messageSpan.textContent = message;
        Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' });
        closeBtn.textContent = '×';

        const removeWarning = () => {
            if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout);
            warningEl.style.opacity = '0';
            setTimeout(() => warningEl.remove(), 500);
        };

        closeBtn.onclick = removeWarning;
        warningEl.append(messageSpan, closeBtn);
        document.body.appendChild(warningEl);

        setTimeout(() => (warningEl.style.opacity = '1'), 100);
        warningEl.hideTimeout = setTimeout(removeWarning, CONFIG.UI_WARN_TIMEOUT);
    }

    const globalUIManager = (() => {
        let instance;

        function createInstance() {
            let isDragging = false, wasDragged = false;
            let startPos = { x: 0, y: 0 }, translatePos = { x: 0, y: 0 }, startRect = null;
            let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null;
            let dragAnimationId = null;

            const clampTranslate = () => {
                if (!uiContainer) return;
                const rect = uiContainer.getBoundingClientRect();
                const { innerWidth: pW, innerHeight: pH } = window;
                let nX = translatePos.x, nY = translatePos.y;
                if (rect.left < 0) nX -= rect.left;
                if (rect.top < 0) nY -= rect.top;
                if (rect.right > pW) nX -= (rect.right - pW);
                if (rect.bottom > pH) nY -= (rect.bottom - pH);
                translatePos.x = nX; translatePos.y = nY;
                uiContainer.style.transform = `translateY(-50%) translate(${nX}px, ${nY}px)`;
            };

            function createUIElements() {
                uiContainer = document.createElement('div');
                uiContainer.id = 'vsc-global-container';
                Object.assign(uiContainer.style, {
                    position: 'fixed',
                    top: isMobile ? '40%' : '40%',
                    right: '1vmin',
                    transform: 'translateY(-50%)',
                    zIndex: CONFIG.MAX_Z_INDEX,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    opacity: '1',
                    transition: 'opacity 0.3s',
                    WebkitTapHighlightColor: 'transparent'
                });

                const mainControlsWrapper = document.createElement('div');
                mainControlsWrapper.id = 'vsc-main-controls-wrapper';
                Object.assign(mainControlsWrapper.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0px' });

                triggerElement = document.createElement('div');
                triggerElement.id = UI_SELECTORS.TRIGGER;
                triggerElement.textContent = '⚡';
                Object.assign(triggerElement.style, {
                    width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    background: 'rgba(0,0,0,0.5)',
                    color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                    cursor: 'pointer', userSelect: 'none',
                    transition: 'box-shadow 0.3s ease-in-out'
                });

                speedButtonsContainer = document.createElement('div');
                speedButtonsContainer.id = 'vsc-speed-buttons-container';
                Object.assign(speedButtonsContainer.style, { display: 'none', flexDirection: 'column', gap: '5px', alignItems: 'center' });

                CONFIG.SPEED_PRESETS.forEach(speed => {
                    const btn = document.createElement('button');
                    btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn';
                    Object.assign(btn.style, {
                        width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)',
                        background: 'rgba(52, 152, 219, 0.5)', color: 'white', border: 'none', borderRadius: 'clamp(4px, 0.8vmin, 6px)',
                        cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '0'
                    });
                    if (speed === 1.0) btn.style.boxShadow = '0 0 5px #3498db, 0 0 10px #3498db inset';
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        const newSpeed = parseFloat(btn.dataset.speed);
                        const video = Array.from(state.media.activeMedia).find(m => m.tagName === 'VIDEO');
                        if (video) {
                            video.playbackRate = newSpeed;
                            updateActiveSpeedButton(newSpeed);
                        }
                        if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
                    };
                    speedButtonsContainer.appendChild(btn);
                });

                const isWhitelistedForLiveJump = CONFIG.LIVE_JUMP_WHITELIST.some(d => location.hostname.includes(d));

                if (isWhitelistedForLiveJump) {
                    const liveJumpButton = document.createElement('button');
                    liveJumpButton.id = 'vsc-live-jump-btn';
                    liveJumpButton.textContent = '⚡';
                    liveJumpButton.title = '실시간으로 이동';
                    Object.assign(liveJumpButton.style, {
                        width: 'clamp(28px, 5.5vmin, 36px)', height: 'clamp(28px, 5.5vmin, 36px)', fontSize: 'clamp(16px, 3vmin, 20px)',
                        background: 'rgba(255, 82, 82, 0.5)', color: 'white', border: 'none', borderRadius: '50%',
                        cursor: 'pointer', WebkitTapHighlightColor: 'transparent', marginTop: '5px'
                    });
                    liveJumpButton.onclick = (e) => { e.stopPropagation(); seekToLiveEdge(); };
                    speedButtonsContainer.appendChild(liveJumpButton);
                }

                mainControlsWrapper.appendChild(triggerElement);
                uiContainer.append(mainControlsWrapper, speedButtonsContainer);
                document.body.appendChild(uiContainer);
            }

            function handleTriggerClick() {
                if (wasDragged) return;

                if (!isInitialized) {
                    try {
                        start();
                        triggerElement.textContent = '🛑';
                        triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                    } catch (err) {
                        console.error('[VSC] Failed to initialize.', err);
                        triggerElement.textContent = '⚠️';
                        triggerElement.title = '스크립트 초기화 실패! 콘솔을 확인하세요.';
                        triggerElement.style.backgroundColor = 'rgba(255, 165, 0, 0.5)';
                    }
                } else {
                    const areControlsVisible = triggerElement.textContent === '🛑';
                    if (areControlsVisible) {
                        speedSlider.hide();
                        if (speedButtonsContainer) speedButtonsContainer.style.display = 'none';
                        triggerElement.textContent = '⚡';
                        triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
                    } else {
                        speedSlider.show();
                        const hasVideo = Array.from(state.media.activeMedia).some(m => m.tagName === 'VIDEO');
                        if (speedButtonsContainer && hasVideo) {
                            speedButtonsContainer.style.display = 'flex';
                        }
                        triggerElement.textContent = '🛑';
                        triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                    }
                }
                if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
            }

            function attachDragAndDrop() {
                let lastPos = { x: 0, y: 0 };
                const onDragStart = (e) => {
                    const trueTarget = e.composedPath()[0];
                    if (['BUTTON', 'SELECT', 'INPUT'].includes(trueTarget.tagName.toUpperCase())) return;
                    isDragging = true; wasDragged = false;
                    const pos = e.touches ? e.touches[0] : e;
                    lastPos = { x: pos.clientX, y: pos.clientY };
                    startPos = { x: pos.clientX, y: pos.clientY };
                    startRect = uiContainer.getBoundingClientRect();
                    uiContainer.style.transition = 'none'; uiContainer.style.cursor = 'grabbing';
                    document.body.style.userSelect = 'none';

                    document.addEventListener('mousemove', onDragMove, { passive: false });
                    document.addEventListener('mouseup', onDragEnd, { passive: true });
                    document.addEventListener('touchmove', onDragMove, { passive: false });
                    document.addEventListener('touchend', onDragEnd, { passive: true });
                };
                const onDragMove = (e) => {
                    if (!isDragging) return;
                    e.preventDefault();
                    const pos = e.touches ? e.touches[0] : e;
                    lastPos = { x: pos.clientX, y: pos.clientY };
                    if (!dragAnimationId) {
                        dragAnimationId = requestAnimationFrame(updateDragPosition);
                    }
                };
                const updateDragPosition = () => {
                    if (!isDragging) {
                        dragAnimationId = null;
                        return;
                    }
                    const dX = lastPos.x - startPos.x, dY = lastPos.y - startPos.y;
                    const fX = translatePos.x + dX, fY = translatePos.y + dY;
                    uiContainer.style.transform = `translateY(-50%) translate(${fX}px, ${fY}px)`;
                    if (!wasDragged && (Math.abs(dX) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(dY) > CONFIG.UI_DRAG_THRESHOLD)) wasDragged = true;

                    dragAnimationId = requestAnimationFrame(updateDragPosition);
                };
                const onDragEnd = () => {
                    if (!isDragging) return;
                    if (dragAnimationId) {
                        cancelAnimationFrame(dragAnimationId);
                        dragAnimationId = null;
                    }
                    const transform = uiContainer.style.transform;
                    const matches = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
                    if (matches) { translatePos.x = parseFloat(matches[1]); translatePos.y = parseFloat(matches[2]); }
                    clampTranslate();
                    isDragging = false;
                    uiContainer.style.transition = ''; uiContainer.style.cursor = 'pointer';
                    document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onDragMove);
                    document.removeEventListener('mouseup', onDragEnd);
                    document.removeEventListener('touchmove', onDragMove);
                    document.removeEventListener('touchend', onDragEnd);
                    setTimeout(() => { wasDragged = false; }, 0);
                    if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
                };
                uiContainer.addEventListener('mousedown', onDragStart, { passive: true });
                uiContainer.addEventListener('touchstart', onDragStart, { passive: false });
                const debouncedClamp = debounce(clampTranslate, 100);
                window.addEventListener('resize', debouncedClamp);
                window.addEventListener('orientationchange', debouncedClamp);
            }

            function attachGlobalListeners() {
                if (!visibilityChangeListener) {
                    visibilityChangeListener = () => {
                        if (document.hidden) document.querySelectorAll('.vsc-video-filter-active,.vsc-image-filter-active').forEach(v => v.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active'));
                        else scheduleIdleTask(scanAndApply);
                    };
                    document.addEventListener('visibilitychange', visibilityChangeListener);
                }
                if (!fullscreenChangeListener) {
                    fullscreenChangeListener = () => {
                        const targetRoot = document.fullscreenElement || document.body;
                        if (uiContainer) { targetRoot.appendChild(uiContainer); setTimeout(clampTranslate, 100); }
                    };
                    document.addEventListener('fullscreenchange', fullscreenChangeListener);
                }
                if (!beforeUnloadListener) {
                    beforeUnloadListener = () => { if (uiContainer) uiContainer.remove(); cleanup(); };
                    window.addEventListener('beforeunload', beforeUnloadListener);
                }
            }

            function cleanupGlobalListeners() {
                if (visibilityChangeListener) { document.removeEventListener('visibilitychange', visibilityChangeListener); visibilityChangeListener = null; }
                if (fullscreenChangeListener) { document.removeEventListener('fullscreenchange', fullscreenChangeListener); fullscreenChangeListener = null; }
                if (beforeUnloadListener) { window.removeEventListener('beforeunload', beforeUnloadListener); beforeUnloadListener = null; }
            }

            function cleanupAsync() {
                if (dragAnimationId) {
                    cancelAnimationFrame(dragAnimationId);
                    dragAnimationId = null;
                }
            }

            function init() {
                createUIElements();
                uiContainer.addEventListener('click', (e) => {
                    if (wasDragged) { e.stopPropagation(); return; }
                    if (e.target.id === UI_SELECTORS.TRIGGER) handleTriggerClick();
                });
                attachDragAndDrop();
                attachGlobalListeners();
            }
            return { init, cleanupGlobalListeners, cleanupAsync };
        }
        return {
            getInstance: () => {
                if (!instance) {
                    instance = createInstance();
                }
                return instance;
            }
        };
    })();

    function displayReloadMessage() {
        try {
            const message = sessionStorage.getItem('vsc_message');
            if (message) {
                sessionStorage.removeItem('vsc_message');
                showWarningMessage(message);
            }
        } catch (e) {
            console.error("[VSC] Failed to access sessionStorage for reload message.", e);
        }
    }

    function initializeGlobalUI() {
        if (document.getElementById('vsc-global-container')) return;

        let mediaFound = false;
        let uiMaintenanceInterval = null;

        const ensureUIExists = () => {
            if (mediaFound && !document.getElementById('vsc-global-container')) {
                console.log('[VSC] UI가 존재하지 않아 재생성합니다.');
                globalUIManager.getInstance().init();
                hookSpaNavigation();
            }
        };

        const initialMediaCheck = async () => {
            await settingsManager.init();
            if (findAllMedia().length > 0 || findAllImages().length > 0) {
                mediaFound = true;

                if (!document.getElementById('vsc-global-container')) {
                    globalUIManager.getInstance().init();
                    hookSpaNavigation();
                }

                if (!uiMaintenanceInterval) {
                    uiMaintenanceInterval = setInterval(ensureUIExists, 1000);
                }

                if (mediaObserver) mediaObserver.disconnect();
            }
        };

        displayReloadMessage();

        const mediaObserver = new MutationObserver(debounce(initialMediaCheck, 500));
        mediaObserver.observe(document.body, { childList: true, subtree: true });

        initialMediaCheck();
    }

    const isLive = () => {
        const v = Array.from(state.media.activeMedia).find(m => m.tagName === 'VIDEO');
        if (!v) return false;
        // 이 기능은 허용된 사이트에서만 호출되므로 표준 API를 신뢰할 수 있습니다.
        try {
            if (v.seekable && v.seekable.length > 0) {
                const end = v.seekable.end(v.seekable.length - 1);
                const dist = end - v.currentTime;
                // 버퍼 끝과의 차이가 10초 이내면 실시간으로 간주
                return isFinite(dist) && dist < 10;
            }
            return v.duration === Infinity; // YouTube 같은 스트림을 위한 폴백
        } catch {
            return false;
        }
    };

    function seekToLiveEdge() {
        // 안전 장치: 만약의 경우를 대비해 한번 더 허용 목록 확인
        const isWhitelisted = CONFIG.LIVE_JUMP_WHITELIST.some(d => location.hostname.includes(d));
        if (!isWhitelisted) {
            console.warn('[VSC] 이 사이트에서는 실시간 점프가 지원되지 않습니다.');
            return;
        }

        const v = Array.from(state.media.activeMedia).find(m => m.tagName === 'VIDEO');
        if (!v) return;

        try {
            // 허용된 사이트에서는 seekable 속성이 안정적으로 작동합니다.
            if (v.seekable && v.seekable.length > 0) {
                const liveEdge = v.seekable.end(v.seekable.length - 1);
                if (isFinite(liveEdge)) {
                    v.currentTime = liveEdge - 0.5; // 버퍼링 방지를 위해 살짝 앞으로 당김
                    v.play?.();
                    setTimeout(updateLiveStatusIndicator, 100);
                    console.log('[VSC] seekable 속성을 사용하여 실시간으로 점프했습니다.');
                    return;
                }
            }
            // seekable을 사용할 수 없으면 다른 위험한 시도를 하지 않음
            console.warn('[VSC] 실시간 점프를 위한 seekable 범위를 찾지 못했습니다.');
        } catch (e) {
            console.error('[VSC] 실시간 점프 중 오류 발생:', e);
        }
    }

    function updateLiveStatusIndicator() {
        if (!triggerElement) return;
        const live = isLive();
        triggerElement.style.boxShadow = live ? '0 0 8px 2px #ff0000' : 'none';
    }


    if (!isExcluded()) {
        const onDomReady = () => {
            setTimeout(initializeGlobalUI, 0);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDomReady);
        } else {
            onDomReady();
        }
    }
})();
