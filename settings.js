// ==UserScript==
// @name         Video_Image_Control (with Advanced Audio & Video FX)
// @namespace    https://com/
// @version      95.1
// @description  [v95.1] 익사이터(Exciter) 로직 수정: 과도한 증폭 오류 해결 및 제어력 향상. 마스터링 스위트(Transient Shaper, Multi-stage Limiter) 추가.
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let uiContainer = null, triggerElement = null, speedButtonsContainer = null, titleObserver = null;
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const TARGET_DELAYS = { "youtube.com": 2750, "chzzk.naver.com": 2000, "play.sooplive.co.kr": 2500, "twitch.tv": 2000, "kick.com": 2000 };
    const DEFAULT_TARGET_DELAY = 2000;

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 10 : 2,
        DEFAULT_VIDEO_FILTER_LEVEL_2: isMobile ? 5 : 1,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 10 : 2,
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
        DEFAULT_SPATIAL_AUDIO_ENABLED: false,
        DEFAULT_SPATIAL_AUDIO_DISTANCE: 1.0,
        DEFAULT_SPATIAL_AUDIO_REVERB: 0.1,
        DEFAULT_SPATIAL_AUDIO_SPEED: 0.2,
        DEFAULT_PRE_GAIN_ENABLED: false,
        DEFAULT_PRE_GAIN: 1.0,
        DEFAULT_BASS_BOOST_GAIN: 0,
        DEFAULT_LOUDNESS_EQ_ENABLED: false,
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
        SPEED_PRESETS: [4, 2, 1.5, 1, 0.2], UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'youtube.com', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
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
        SELECT: 'vsc-select'
    };

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
        const host = location.hostname;
        for (const site in TARGET_DELAYS) { if (host.includes(site)) return TARGET_DELAYS[site]; }
        return DEFAULT_TARGET_DELAY;
    }

    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 20 },
            videoFilterLevel2: { name: '기본 영상 디테일', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2, type: 'number', min: 0, max: 20 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 20 }
        };
        function init() { Object.keys(definitions).forEach(key => { settings[key] = definitions[key].default; }); }
        return { init, get: (key) => settings[key], set: (key, value) => { settings[key] = value; }, definitions };
    })();

    settingsManager.init();
    const state = {};
    resetState();
    function resetState() {
        Object.keys(state).forEach(key => delete state[key]);
        const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
        Object.assign(state, {
            activeMedia: new Set(), processedMedia: new WeakSet(), activeImages: new Set(),
            processedImages: new WeakSet(), mediaListenerMap: new WeakMap(),
            currentlyVisibleMedia: null,
            currentVideoFilterLevel: settingsManager.get('videoFilterLevel') || CONFIG.DEFAULT_VIDEO_FILTER_LEVEL,
            currentVideoFilterLevel2: settingsManager.get('videoFilterLevel2') || CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
            currentImageFilterLevel: settingsManager.get('imageFilterLevel') || CONFIG.DEFAULT_IMAGE_FILTER_LEVEL,
            currentVideoGamma: parseFloat(videoDefaults.GAMMA_VALUE),
            currentVideoBlur: parseFloat(videoDefaults.BLUR_STD_DEVIATION),
            currentVideoShadows: parseInt(videoDefaults.SHADOWS_VALUE, 10),
            currentVideoHighlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10),
            currentVideoSaturation: parseInt(videoDefaults.SATURATION_VALUE, 10),
            currentVideoSharpenDirection: CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION,
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
            isSpatialAudioEnabled: CONFIG.DEFAULT_SPATIAL_AUDIO_ENABLED,
            spatialAudioDistance: CONFIG.DEFAULT_SPATIAL_AUDIO_DISTANCE,
            spatialAudioReverb: CONFIG.DEFAULT_SPATIAL_AUDIO_REVERB,
            spatialAudioSpeed: CONFIG.DEFAULT_SPATIAL_AUDIO_SPEED,
            currentStereoPan: CONFIG.DEFAULT_STEREO_PAN,
            isPreGainEnabled: CONFIG.DEFAULT_PRE_GAIN_ENABLED,
            currentPreGain: CONFIG.DEFAULT_PRE_GAIN,
            lastManualPreGain: CONFIG.DEFAULT_PRE_GAIN,
            isAnalyzingLoudness: false,
            isLoudnessEqEnabled: CONFIG.DEFAULT_LOUDNESS_EQ_ENABLED,
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
            ui: { shadowRoot: null, hostElement: null }, delayCheckInterval: null,
            currentPlaybackRate: 1.0, mediaTypesEverFound: { video: false, image: false }, lastUrl: '',
            audioContextWarningShown: false
        });
    }

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };

    function calculateSharpenMatrix(level, direction = '4-way') {
        const p = parseInt(level, 10);
        if (isNaN(p) || p === 0) return '0 0 0 0 1 0 0 0 0';
        const BASE_STRENGTH = 0.25;
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
                const currentHighlights = highlights ?? state.currentVideoHighlights;
                const currentShadows = shadows ?? state.currentVideoShadows;
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

        function setupLoudnessEQ(context) {
            const loudnessLow = context.createBiquadFilter();
            loudnessLow.type = "lowshelf";
            loudnessLow.frequency.value = 100;
            const loudnessHigh = context.createBiquadFilter();
            loudnessHigh.type = "highshelf";
            loudnessHigh.frequency.value = 8000;
            return { loudnessLow, loudnessHigh };
        }

        function updateLoudnessEQ(nodes, volumeLevel) {
            if (!nodes.loudnessLow || !nodes.loudnessHigh) return;
            const boost = (1 - volumeLevel) * 6;
            const context = nodes.context;
            nodes.loudnessLow.gain.linearRampToValueAtTime(boost, context.currentTime + 0.1);
            nodes.loudnessHigh.gain.linearRampToValueAtTime(boost / 2, context.currentTime + 0.1);
        }

        function startLoudnessNormalization(media) {
            const nodes = state.audioContextMap.get(media);
            if (!nodes || state.isAnalyzingLoudness) return;
            const autoVolBtn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
            if (!autoVolBtn) return;
            const originalBtnText = autoVolBtn.textContent;
            state.isAnalyzingLoudness = true;
            updateAutoVolumeButtonStyle();
            const analyser = nodes.analyser;
            const gainNode = nodes.preGain;
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
                if (!media.isConnected || media.paused || !state.isAnalyzingLoudness) {
                    cleanupTimers();
                    if (state.isAnalyzingLoudness) {
                        state.isAnalyzingLoudness = false;
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
                if (!state.isAnalyzingLoudness) {
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
                    let finalGain = state.lastManualPreGain * correctionFactor;
                    finalGain = Math.min(finalGain, MAX_FINAL_GAIN);
                    gainNode.gain.linearRampToValueAtTime(finalGain, nodes.context.currentTime + 0.5);
                    state.currentPreGain = finalGain;
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
                state.isAnalyzingLoudness = false;
                autoVolBtn.textContent = originalBtnText;
                updateAutoVolumeButtonStyle();
            };
            setTimeout(() => {
                if (!state.isAnalyzingLoudness) return;
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
                preGain: context.createGain(),
                masterGain: context.createGain(),
                analyser: context.createAnalyser(),
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
                deesserBand: context.createBiquadFilter(),
                deesserCompressor: context.createDynamicsCompressor(),
                exciterHPF: context.createBiquadFilter(),
                exciter: context.createWaveShaper(),
                exciterPostGain: context.createGain(), // FIX: Added node to control exciter output
                parallelCompressor: context.createDynamicsCompressor(),
                parallelDry: context.createGain(),
                parallelWet: context.createGain(),
                limiter: context.createDynamicsCompressor(),
                masteringTransientShaper: context.createWaveShaper(),
                masteringLimiter1: context.createDynamicsCompressor(),
                masteringLimiter2: context.createDynamicsCompressor(),
                masteringLimiter3: context.createDynamicsCompressor(),
            };

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

            Object.assign(nodes, setupLoudnessEQ(context));
            state.audioContextMap.set(media, nodes);

            nodes.source.connect(nodes.preGain);
            nodes.preGain.connect(nodes.masterGain);
            nodes.masterGain.connect(nodes.analyser);
            nodes.masterGain.connect(nodes.context.destination);

            return nodes;
        }

        function reconnectGraph(media) {
            const nodes = state.audioContextMap.get(media);
            if (!nodes) return;

            safeExec(() => {
                Object.values(nodes).forEach(node => {
                    if (node && typeof node.disconnect === 'function' && node !== nodes.context) {
                        try { node.disconnect(); } catch (e) { /* Ignore */ }
                    }
                });

                if (animationFrameMap.has(media)) cancelAnimationFrame(animationFrameMap.get(media));
                animationFrameMap.delete(media);

                nodes.preGain.gain.value = state.currentPreGain;
                nodes.stereoPanner.pan.value = state.isSpatialAudioEnabled ? 0 : state.currentStereoPan;

                let lastNode = nodes.source.connect(nodes.preGain);

                if (state.isDeesserEnabled) {
                    nodes.deesserBand.type = 'bandpass';
                    nodes.deesserBand.frequency.value = state.deesserFreq;
                    nodes.deesserBand.Q.value = 3;
                    nodes.deesserCompressor.threshold.value = state.deesserThreshold;
                    nodes.deesserCompressor.knee.value = 10;
                    nodes.deesserCompressor.ratio.value = 10;
                    nodes.deesserCompressor.attack.value = 0.005;
                    nodes.deesserCompressor.release.value = 0.1;
                    lastNode.connect(nodes.deesserBand).connect(nodes.deesserCompressor);
                    lastNode = lastNode.connect(nodes.deesserCompressor);
                }

                if (state.isEqEnabled || state.bassBoostGain > 0) {
                    const merger = nodes.merger;
                    lastNode.connect(nodes.band1_SubBass);
                    lastNode.connect(nodes.band2_Bass);
                    lastNode.connect(nodes.band3_Mid);
                    lastNode.connect(nodes.band4_Treble);
                    lastNode.connect(nodes.band5_Presence);

                    let lastSubBassNode = nodes.band1_SubBass;
                    if (state.bassBoostGain > 0) {
                        if (!nodes.bassBoost) {
                            nodes.bassBoost = nodes.context.createBiquadFilter();
                            nodes.bassBoost.type = "peaking";
                        }
                        nodes.bassBoost.frequency.value = state.bassBoostFreq;
                        nodes.bassBoost.Q.value = state.bassBoostQ;
                        nodes.bassBoost.gain.value = state.bassBoostGain;
                        lastSubBassNode = lastSubBassNode.connect(nodes.bassBoost);
                    }

                    if (state.isEqEnabled) {
                        nodes.gain1_SubBass.gain.value = Math.pow(10, state.eqSubBassGain / 20);
                        nodes.gain2_Bass.gain.value = Math.pow(10, state.eqBassGain / 20);
                        nodes.gain3_Mid.gain.value = Math.pow(10, state.eqMidGain / 20);
                        nodes.gain4_Treble.gain.value = Math.pow(10, state.eqTrebleGain / 20);
                        nodes.gain5_Presence.gain.value = Math.pow(10, state.eqPresenceGain / 20);
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

                if (state.isHpfEnabled) {
                    if (!nodes.hpf) nodes.hpf = nodes.context.createBiquadFilter();
                    nodes.hpf.type = 'highpass';
                    nodes.hpf.frequency.value = state.currentHpfHz;
                    lastNode = lastNode.connect(nodes.hpf);
                }

                // [FIX] Exciter logic is now parallel and includes a post-gain to prevent clipping
                if (state.isExciterEnabled && state.exciterAmount > 0 && !state.isMasteringSuiteEnabled) {
                    const exciterSum = nodes.context.createGain();
                    const exciterDry = nodes.context.createGain();
                    const exciterWet = nodes.context.createGain();
                    const exciterPostGain = nodes.exciterPostGain;

                    exciterDry.gain.value = 1.0 - (state.exciterAmount / 200); // Blend more gently
                    exciterWet.gain.value = state.exciterAmount / 100;

                    nodes.exciterHPF.type = 'highpass';
                    nodes.exciterHPF.frequency.value = 5000;
                    nodes.exciter.curve = makeDistortionCurve(state.exciterAmount * 20);
                    nodes.exciter.oversample = '4x';
                    exciterPostGain.gain.value = 0.5; // Tame the output of the waveshaper

                    lastNode.connect(exciterDry).connect(exciterSum); // Dry path
                    lastNode.connect(nodes.exciterHPF)
                           .connect(nodes.exciter)
                           .connect(exciterPostGain) // Control the gain
                           .connect(exciterWet)
                           .connect(exciterSum); // Wet path

                    lastNode = exciterSum;
                }

                if (state.isParallelCompEnabled && state.parallelCompMix > 0) {
                    nodes.parallelCompressor.threshold.value = -30;
                    nodes.parallelCompressor.knee.value = 15;
                    nodes.parallelCompressor.ratio.value = 12;
                    nodes.parallelCompressor.attack.value = 0.003;
                    nodes.parallelCompressor.release.value = 0.1;
                    nodes.parallelDry.gain.value = 1.0 - (state.parallelCompMix / 100);
                    nodes.parallelWet.gain.value = state.parallelCompMix / 100;
                    const parallelSum = nodes.context.createGain();
                    lastNode.connect(nodes.parallelDry).connect(parallelSum);
                    lastNode.connect(nodes.parallelCompressor).connect(nodes.parallelWet).connect(parallelSum);
                    lastNode = parallelSum;
                }

                if (state.isLoudnessEqEnabled) {
                    updateLoudnessEQ(nodes, media.volume);
                    lastNode = lastNode.connect(nodes.loudnessLow).connect(nodes.loudnessHigh);
                }

                if (state.isSpatialAudioEnabled) {
                    if (!nodes.panner) {
                        nodes.panner = nodes.context.createPanner();
                        Object.assign(nodes.panner, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 0, coneOuterGain: 0 });
                    }
                    nodes.panner.refDistance = state.spatialAudioReverb;
                    let angle = 0;
                    const animatePanner = () => {
                        if (!media.isConnected) { animationFrameMap.delete(media); return; }
                        angle += state.spatialAudioSpeed / 100;
                        const x = Math.sin(angle) * state.spatialAudioDistance;
                        const z = Math.cos(angle) * state.spatialAudioDistance;
                        if (nodes.panner.positionX) {
                            nodes.panner.positionX.setValueAtTime(x, nodes.context.currentTime);
                            nodes.panner.positionZ.setValueAtTime(z, nodes.context.currentTime);
                        } else {
                            nodes.panner.setPosition(x, 0, z);
                        }
                        animationFrameMap.set(media, requestAnimationFrame(animatePanner));
                    };
                    animatePanner();
                    lastNode = lastNode.connect(nodes.panner);
                } else if (state.isWideningEnabled) {
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
                    nodes.adaptiveWidthFilter.frequency.value = state.isAdaptiveWidthEnabled ? state.adaptiveWidthFreq : 0;
                    nodes.ms_side_level.connect(nodes.adaptiveWidthFilter).connect(nodes.ms_side_gain);
                    nodes.ms_side_gain.gain.value = state.currentWideningFactor;
                    nodes.ms_decode_invert_Side.gain.value = -1;
                    nodes.ms_mid_level.connect(nodes.ms_decode_L_sum); nodes.ms_side_gain.connect(nodes.ms_decode_L_sum);
                    nodes.ms_mid_level.connect(nodes.ms_decode_R_sum); nodes.ms_side_gain.connect(nodes.ms_decode_invert_Side).connect(nodes.ms_decode_R_sum);
                    nodes.ms_decode_L_sum.connect(nodes.ms_merger, 0, 0);
                    nodes.ms_decode_R_sum.connect(nodes.ms_merger, 0, 1);
                    lastNode = nodes.ms_merger;
                } else {
                    lastNode = lastNode.connect(nodes.stereoPanner);
                }

                if (state.isMasteringSuiteEnabled) {
                    nodes.masteringTransientShaper.curve = makeTransientCurve(state.masteringTransientAmount);
                    nodes.masteringTransientShaper.oversample = '4x';
                    lastNode = lastNode.connect(nodes.masteringTransientShaper);

                    if (state.isExciterEnabled && state.exciterAmount > 0) {
                        const exciterSum = nodes.context.createGain();
                        const exciterDry = nodes.context.createGain();
                        const exciterWet = nodes.context.createGain();
                        const exciterPostGain = nodes.exciterPostGain;

                        exciterDry.gain.value = 1.0 - (state.exciterAmount / 200);
                        exciterWet.gain.value = state.exciterAmount / 100;

                        nodes.exciterHPF.type = 'highpass';
                        nodes.exciterHPF.frequency.value = 5000;
                        nodes.exciter.curve = makeDistortionCurve(state.exciterAmount * 15);
                        nodes.exciter.oversample = '4x';
                        exciterPostGain.gain.value = 0.5;

                        lastNode.connect(exciterDry).connect(exciterSum);
                        lastNode.connect(nodes.exciterHPF)
                               .connect(nodes.exciter)
                               .connect(exciterPostGain)
                               .connect(exciterWet)
                               .connect(exciterSum);
                        lastNode = exciterSum;
                    }

                    const drive = state.masteringDrive;
                    const l1 = nodes.masteringLimiter1;
                    l1.threshold.value = -12 + (drive / 2);
                    l1.knee.value = 5;
                    l1.ratio.value = 4;
                    l1.attack.value = 0.005;
                    l1.release.value = 0.08;

                    const l2 = nodes.masteringLimiter2;
                    l2.threshold.value = -8 + (drive / 2);
                    l2.knee.value = 3;
                    l2.ratio.value = 8;
                    l2.attack.value = 0.003;
                    l2.release.value = 0.05;

                    const l3 = nodes.masteringLimiter3;
                    l3.threshold.value = -2.0;
                    l3.knee.value = 0;
                    l3.ratio.value = 20;
                    l3.attack.value = 0.001;
                    l3.release.value = 0.02;

                    lastNode = lastNode.connect(l1).connect(l2).connect(l3);

                } else {
                    if (state.isLimiterEnabled) {
                        nodes.limiter.threshold.value = -1.5;
                        nodes.limiter.knee.value = 0;
                        nodes.limiter.ratio.value = 20;
                        nodes.limiter.attack.value = 0.001;
                        nodes.limiter.release.value = 0.05;
                        lastNode = lastNode.connect(nodes.limiter);
                    }
                }

                lastNode.connect(nodes.masterGain);
                nodes.masterGain.connect(nodes.analyser);
                nodes.masterGain.connect(nodes.context.destination);

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

            const intervalId = setInterval(() => {
                if (!media.isConnected || nodes.context.state === 'closed' || media.paused) {
                    clearInterval(intervalId);
                    analysisStatusMap.delete(media);
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
                    console.warn('[VSC] 오디오 신호가 감지되지 않았습니다 (CORS 오류 가능성).', media);
                    showWarningMessage('오디오 효과 적용에 실패했습니다. (CORS 보안 정책 가능성)');
                    cleanupForMedia(media);
                }
            }, CHECK_INTERVAL);
        }

        function getOrCreateNodes(media) {
            if (state.audioContextMap.has(media)) {
                return state.audioContextMap.get(media);
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
            const nodes = state.audioContextMap.get(media);
            if (nodes) {
                safeExec(() => {
                    if (nodes.context.state !== 'closed') nodes.context.close();
                }, 'cleanupForMedia');
                state.audioContextMap.delete(media);
            }
        }

        function ensureContextResumed(media) {
            const nodes = getOrCreateNodes(media);
            if (nodes && nodes.context.state === 'suspended') {
                nodes.context.resume().catch(e => {
                    if (!state.audioContextWarningShown) {
                        showWarningMessage('오디오 효과를 위해 UI 버튼을 한 번 클릭해주세요.');
                        state.audioContextWarningShown = true;
                    } console.warn('[VSC] AudioContext resume failed:', e.message);
                });
            }
        }

        return { getOrCreateNodes, cleanupForMedia, ensureContextResumed, reconnectGraph, startLoudnessNormalization };
    })();

    function applyAudioEffectsToMedia() {
        if (!state.audioInitialized) return;
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(media => audioEffectsManager.reconnectGraph(media));
    }

    function initializeAudioEngine() {
        if (state.audioInitialized) return;
        state.audioInitialized = true;
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(media => audioEffectsManager.ensureContextResumed(media));
    }

    function updateAutoVolumeButtonStyle() {
        const btn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
        if (!btn) return;
        btn.classList.toggle('analyzing', state.isAnalyzingLoudness);
    }

    function setPreGainEnabled(enabled) {
        state.isPreGainEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-pregain-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('preGainSlider');
        if (slider) slider.disabled = !enabled;
        const autoVolBtn = state.ui.shadowRoot?.getElementById('vsc-auto-volume-toggle');
        if (autoVolBtn) autoVolBtn.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setWideningEnabled(enabled) {
        state.isWideningEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-widen-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('wideningSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setHpfEnabled(enabled) {
        state.isHpfEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-hpf-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('hpfSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setEqEnabled(enabled) {
        state.isEqEnabled = !!enabled;
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
        state.isDeesserEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-deesser-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        ['deesserThresholdSlider', 'deesserFreqSlider'].forEach(id => {
            const slider = state.ui.shadowRoot?.getElementById(id);
            if (slider) slider.disabled = !enabled;
        });
        applyAudioEffectsToMedia();
    }
    function setExciterEnabled(enabled) {
        state.isExciterEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-exciter-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('exciterAmountSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }
    function setParallelCompEnabled(enabled) {
        state.isParallelCompEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-parallel-comp-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('parallelCompMixSlider');
        if (slider) slider.disabled = !enabled;
        applyAudioEffectsToMedia();
    }

    function setMasteringSuiteEnabled(enabled) {
        state.isMasteringSuiteEnabled = !!enabled;
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
        state.isLimiterEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-limiter-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        applyAudioEffectsToMedia();
    }

    function setSpatialAudioEnabled(enabled) {
        state.isSpatialAudioEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-spatial-audio-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const shadowRoot = state.ui.shadowRoot;
        if (shadowRoot) {
            ['panSlider', 'spatialDistanceSlider', 'spatialReverbSlider', 'spatialSpeedSlider'].forEach(id => {
                const el = shadowRoot.getElementById(id);
                if (el) el.disabled = (id === 'panSlider') ? enabled : !enabled;
            });
        }
        applyAudioEffectsToMedia();
    }

    function setAdaptiveWidthEnabled(enabled) {
        state.isAdaptiveWidthEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-adaptive-width-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        applyAudioEffectsToMedia();
    }

    function setLoudnessEqEnabled(enabled) {
        state.isLoudnessEqEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-loudness-eq-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        applyAudioEffectsToMedia();
    }

    function resetEffectStatesToDefault() {
        setWideningEnabled(CONFIG.DEFAULT_WIDENING_ENABLED);
        setHpfEnabled(CONFIG.DEFAULT_HPF_ENABLED);
        setEqEnabled(CONFIG.DEFAULT_EQ_ENABLED);
        setAdaptiveWidthEnabled(CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED);
        setSpatialAudioEnabled(CONFIG.DEFAULT_SPATIAL_AUDIO_ENABLED);
        setPreGainEnabled(CONFIG.DEFAULT_PRE_GAIN_ENABLED);
        setLoudnessEqEnabled(CONFIG.DEFAULT_LOUDNESS_EQ_ENABLED);
        setDeesserEnabled(CONFIG.DEFAULT_DEESSER_ENABLED);
        setExciterEnabled(CONFIG.DEFAULT_EXCITER_ENABLED);
        setParallelCompEnabled(CONFIG.DEFAULT_PARALLEL_COMP_ENABLED);
        setLimiterEnabled(CONFIG.DEFAULT_LIMITER_ENABLED);
        setMasteringSuiteEnabled(CONFIG.DEFAULT_MASTERING_SUITE_ENABLED);

        state.bassBoostGain = CONFIG.DEFAULT_BASS_BOOST_GAIN;
        const bassSlider = state.ui.shadowRoot?.getElementById('bassBoostSlider');
        if (bassSlider) {
            bassSlider.value = state.bassBoostGain;
            const bassVal = state.ui.shadowRoot?.getElementById('bassBoostSliderVal');
            if (bassVal) bassVal.textContent = `${state.bassBoostGain.toFixed(1)} dB`;
        }
        applyAudioEffectsToMedia();
    }

    function applyAllVideoFilters() {
        if (!filterManager.isInitialized()) return;
        const values = {
            saturation: state.currentVideoSaturation,
            gamma: state.currentVideoGamma,
            blur: state.currentVideoBlur,
            sharpenMatrix1: calculateSharpenMatrix(state.currentVideoFilterLevel, state.currentVideoSharpenDirection),
            sharpenMatrix2: calculateSharpenMatrix(state.currentVideoFilterLevel2, state.currentVideoSharpenDirection),
            shadows: state.currentVideoShadows,
            highlights: state.currentVideoHighlights,
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
            state.currentVideoFilterLevel = finalLevel;
            if (fromUI) settingsManager.set('videoFilterLevel', finalLevel);
        } else {
            state.currentVideoFilterLevel2 = finalLevel;
            if (fromUI) settingsManager.set('videoFilterLevel2', finalLevel);
        }
        applyAllVideoFilters();
        state.activeMedia.forEach(media => { if (media.tagName === 'VIDEO') updateVideoFilterState(media); });
    }

    function setImageFilterLevel(level) {
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!imageFilterManager.isInitialized() && level > 0) imageFilterManager.init();
        const newLevel = parseInt(level, 10);
        state.currentImageFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('imageFilterLevel', state.currentImageFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentImageFilterLevel);
        const imageValues = { sharpenMatrix: newMatrix };
        imageFilterManager.updateFilterValues(imageValues, document);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => imageFilterManager.updateFilterValues(imageValues, root));
        state.activeImages.forEach(image => updateImageFilterState(image));
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
        let wideningSlider, panSlider, hpfSlider, eqSubBassSlider, eqBassSlider, eqMidSlider, eqTrebleSlider, eqPresenceSlider, spatialDistanceSlider, spatialReverbSlider, spatialSpeedSlider, clarityThresholdSlider, preGainSlider, bassBoostSlider;
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
                spatial_enabled: false, spatial_dist: CONFIG.DEFAULT_SPATIAL_AUDIO_DISTANCE, spatial_reverb: CONFIG.DEFAULT_SPATIAL_AUDIO_REVERB, spatial_speed: CONFIG.DEFAULT_SPATIAL_AUDIO_SPEED,
                pan_value: 0,
                preGain_enabled: false, preGain_value: 1.0,
                loudness_enabled: false,
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

            Object.assign(state, {
                isHpfEnabled: final.hpf_enabled, currentHpfHz: final.hpf_hz,
                isEqEnabled: final.eq_enabled,
                eqSubBassGain: final.eq_subBass, eqBassGain: final.eq_bass,
                eqMidGain: final.eq_mid, eqTrebleGain: final.eq_treble,
                eqPresenceGain: final.eq_presence,
                isWideningEnabled: final.widen_enabled, currentWideningFactor: final.widen_factor,
                isAdaptiveWidthEnabled: final.adaptive_enabled,
                isSpatialAudioEnabled: final.spatial_enabled,
                spatialAudioDistance: final.spatial_dist, spatialAudioReverb: final.spatial_reverb, spatialAudioSpeed: final.spatial_speed,
                currentStereoPan: final.pan_value,
                isPreGainEnabled: final.preGain_enabled, currentPreGain: final.preGain_value,
                isLoudnessEqEnabled: final.loudness_enabled,
                bassBoostGain: final.bassBoostGain ?? state.bassBoostGain,
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
            state.lastManualPreGain = state.currentPreGain;

            const allSliders = { hpfSlider, eqSubBassSlider, eqBassSlider, eqMidSlider, eqTrebleSlider, eqPresenceSlider, wideningSlider, panSlider, preGainSlider, bassBoostSlider, spatialDistanceSlider, spatialReverbSlider, spatialSpeedSlider, deesserThresholdSlider, deesserFreqSlider, exciterAmountSlider, parallelCompMixSlider, masteringTransientSlider, masteringDriveSlider };
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

            setHpfEnabled(state.isHpfEnabled); updateSliderUI('hpfSlider', state.currentHpfHz, 'Hz');
            setEqEnabled(state.isEqEnabled);
            updateSliderUI('eqSubBassSlider', state.eqSubBassGain, 'dB');
            updateSliderUI('eqBassSlider', state.eqBassGain, 'dB');
            updateSliderUI('eqMidSlider', state.eqMidGain, 'dB');
            updateSliderUI('eqTrebleSlider', state.eqTrebleGain, 'dB');
            updateSliderUI('eqPresenceSlider', state.eqPresenceGain, 'dB');
            setWideningEnabled(state.isWideningEnabled); updateSliderUI('wideningSlider', state.currentWideningFactor, 'x');
            setAdaptiveWidthEnabled(state.isAdaptiveWidthEnabled);
            setSpatialAudioEnabled(state.isSpatialAudioEnabled);
            updateSliderUI('spatialDistanceSlider', state.spatialAudioDistance, 'm');
            updateSliderUI('spatialReverbSlider', state.spatialAudioReverb, '');
            updateSliderUI('spatialSpeedSlider', state.spatialAudioSpeed, 'x');
            updateSliderUI('panSlider', state.currentStereoPan, '');
            setPreGainEnabled(state.isPreGainEnabled);
            updateSliderUI('preGainSlider', state.currentPreGain, 'x');
            setLoudnessEqEnabled(state.isLoudnessEqEnabled);
            updateSliderUI('bassBoostSlider', state.bassBoostGain, 'dB');
            setDeesserEnabled(state.isDeesserEnabled);
            updateSliderUI('deesserThresholdSlider', state.deesserThreshold, 'dB');
            updateSliderUI('deesserFreqSlider', state.deesserFreq, 'Hz');
            if (deesserFreqSlider) deesserFreqSlider.valueSpan.textContent = `${(state.deesserFreq / 1000).toFixed(1)}kHz`;
            setExciterEnabled(state.isExciterEnabled);
            updateSliderUI('exciterAmountSlider', state.exciterAmount, '%');
            setParallelCompEnabled(state.isParallelCompEnabled);
            updateSliderUI('parallelCompMixSlider', state.parallelCompMix, '%');
            setLimiterEnabled(state.isLimiterEnabled);
            setMasteringSuiteEnabled(state.isMasteringSuiteEnabled);
            updateSliderUI('masteringTransientSlider', state.masteringTransientAmount * 100, '%');
            updateSliderUI('masteringDriveSlider', state.masteringDrive, 'dB');

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

            const { group: imageGroup, subMenu: imageSubMenu } = createControlGroup('vsc-image-controls', '🎨', '이미지 선명도');
            const imageOpts = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 20 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];
            imageSubMenu.appendChild(createSelectControl('이미지 선명도', imageOpts, (val) => setImageFilterLevel(val), 'imageFilterSelect'));

            const { group: videoGroup, subMenu: videoSubMenu } = createControlGroup('vsc-video-controls', '✨', '영상 필터');
            videoSubMenu.style.gap = '10px';
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            const videoSliderUpdate = () => { applyAllVideoFilters(); state.activeMedia.forEach(m => { if (m.tagName === 'VIDEO') updateVideoFilterState(m); }); };
            const videoFilterDef = settingsManager.definitions.videoFilterLevel;
            const sharpenSlider = createSliderControl('샤프 (윤곽)', 'videoSharpenSlider', videoFilterDef.min, videoFilterDef.max, 1, state.currentVideoFilterLevel, '단계');
            sharpenSlider.slider.oninput = () => { const val = parseInt(sharpenSlider.slider.value, 10); setVideoFilterLevel(val, false, 1); sharpenSlider.valueSpan.textContent = `${val}단계`; };
            sharpenSlider.slider.onchange = () => { settingsManager.set('videoFilterLevel', state.currentVideoFilterLevel); };
            const videoFilterDef2 = settingsManager.definitions.videoFilterLevel2;
            const sharpenSlider2 = createSliderControl('샤프 (디테일)', 'videoSharpenSlider2', videoFilterDef2.min, videoFilterDef2.max, 1, state.currentVideoFilterLevel2, '단계');
            sharpenSlider2.slider.oninput = () => { const val = parseInt(sharpenSlider2.slider.value, 10); setVideoFilterLevel(val, false, 2); sharpenSlider2.valueSpan.textContent = `${val}단계`; };
            sharpenSlider2.slider.onchange = () => { settingsManager.set('videoFilterLevel2', state.currentVideoFilterLevel2); };
            const sharpenDirOptions = [{ value: "4-way", text: "4방향 (기본)" }, { value: "8-way", text: "8방향 (강함)" }];
            const sharpenDirControl = createLabeledSelect('샤프 방향', 'videoSharpenDirSelect', sharpenDirOptions, (val) => { state.currentVideoSharpenDirection = val; videoSliderUpdate(); });
            sharpenDirControl.select.value = state.currentVideoSharpenDirection;
            const saturationSlider = createSliderControl('채도', 'videoSaturationSlider', 0, 200, 1, state.currentVideoSaturation, '%');
            saturationSlider.slider.oninput = () => { const val = parseInt(saturationSlider.slider.value, 10); state.currentVideoSaturation = val; saturationSlider.valueSpan.textContent = `${val}%`; videoSliderUpdate(); };
            const gammaSlider = createSliderControl('감마', 'videoGammaSlider', 0.5, 1.5, 0.01, state.currentVideoGamma, '');
            gammaSlider.slider.oninput = () => { const val = parseFloat(gammaSlider.slider.value); state.currentVideoGamma = val; gammaSlider.valueSpan.textContent = val.toFixed(2); videoSliderUpdate(); };
            const blurSlider = createSliderControl('블러', 'videoBlurSlider', 0, 1, 0.05, state.currentVideoBlur, '');
            blurSlider.slider.oninput = () => { const val = parseFloat(blurSlider.slider.value); state.currentVideoBlur = val; blurSlider.valueSpan.textContent = val.toFixed(2); videoSliderUpdate(); };
            const shadowsSlider = createSliderControl('대비', 'videoShadowsSlider', -50, 50, 1, state.currentVideoShadows, '');
            shadowsSlider.slider.oninput = () => { const val = parseInt(shadowsSlider.slider.value, 10); state.currentVideoShadows = val; shadowsSlider.valueSpan.textContent = val; videoSliderUpdate(); };
            const highlightsSlider = createSliderControl('밝기', 'videoHighlightsSlider', -50, 50, 1, state.currentVideoHighlights, '');
            highlightsSlider.slider.oninput = () => { const val = parseInt(highlightsSlider.slider.value, 10); state.currentVideoHighlights = val; highlightsSlider.valueSpan.textContent = val; videoSliderUpdate(); };
            const resetVideoBtn = createButton('vsc-reset-video', '영상 필터 초기화', '초기화', 'vsc-btn');
            resetVideoBtn.style.marginTop = '8px';
            resetVideoBtn.onclick = () => {
                state.currentVideoFilterLevel = CONFIG.DEFAULT_VIDEO_FILTER_LEVEL; state.currentVideoFilterLevel2 = CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2;
                state.currentVideoSharpenDirection = CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION; state.currentVideoSaturation = parseInt(videoDefaults.SATURATION_VALUE, 10);
                state.currentVideoGamma = parseFloat(videoDefaults.GAMMA_VALUE); state.currentVideoBlur = parseFloat(videoDefaults.BLUR_STD_DEVIATION);
                state.currentVideoShadows = parseInt(videoDefaults.SHADOWS_VALUE, 10); state.currentVideoHighlights = parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10);
                sharpenSlider.slider.value = state.currentVideoFilterLevel; sharpenSlider.valueSpan.textContent = `${state.currentVideoFilterLevel}단계`;
                sharpenSlider2.slider.value = state.currentVideoFilterLevel2; sharpenSlider2.valueSpan.textContent = `${state.currentVideoFilterLevel2}단계`;
                sharpenDirControl.select.value = state.currentVideoSharpenDirection; saturationSlider.slider.value = state.currentVideoSaturation;
                saturationSlider.valueSpan.textContent = `${state.currentVideoSaturation}%`; gammaSlider.slider.value = state.currentVideoGamma;
                gammaSlider.valueSpan.textContent = state.currentVideoGamma.toFixed(2); blurSlider.slider.value = state.currentVideoBlur;
                blurSlider.valueSpan.textContent = state.currentVideoBlur.toFixed(2); shadowsSlider.slider.value = state.currentVideoShadows;
                shadowsSlider.valueSpan.textContent = state.currentVideoShadows; highlightsSlider.slider.value = state.currentVideoHighlights;
                highlightsSlider.valueSpan.textContent = state.currentVideoHighlights;
                videoSliderUpdate();
            };
            videoSubMenu.append(sharpenSlider.controlDiv, sharpenSlider2.controlDiv, sharpenDirControl.controlDiv, blurSlider.controlDiv, highlightsSlider.controlDiv, gammaSlider.controlDiv, shadowsSlider.controlDiv, saturationSlider.controlDiv, resetVideoBtn);

            const { group: stereoGroup, subMenu: stereoSubMenu } = createControlGroup('vsc-stereo-controls', '🎧', '사운드 효과');
            const audioGridContainer = document.createElement('div');
            audioGridContainer.className = 'vsc-audio-grid';
            const column1 = document.createElement('div'); column1.className = 'vsc-audio-column';
            const column2 = document.createElement('div'); column2.className = 'vsc-audio-column';
            const column3 = document.createElement('div'); column3.className = 'vsc-audio-column';

            const eqBtn = createButton('vsc-eq-toggle', '5-Band EQ ON/OFF', 'EQ', 'vsc-btn');
            eqBtn.onclick = () => { initializeAudioEngine(); setEqEnabled(!state.isEqEnabled); };
            eqSubBassSlider = createSliderControl('초저음', 'eqSubBassSlider', -12, 12, 1, state.eqSubBassGain, 'dB');
            eqSubBassSlider.slider.oninput = () => { const val = parseFloat(eqSubBassSlider.slider.value); state.eqSubBassGain = val; eqSubBassSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqBassSlider = createSliderControl('저음', 'eqBassSlider', -12, 12, 1, state.eqBassGain, 'dB');
            eqBassSlider.slider.oninput = () => { const val = parseFloat(eqBassSlider.slider.value); state.eqBassGain = val; eqBassSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqMidSlider = createSliderControl('중음', 'eqMidSlider', -12, 12, 1, state.eqMidGain, 'dB');
            eqMidSlider.slider.oninput = () => { const val = parseFloat(eqMidSlider.slider.value); state.eqMidGain = val; eqMidSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqTrebleSlider = createSliderControl('고음', 'eqTrebleSlider', -12, 12, 1, state.eqTrebleGain, 'dB');
            eqTrebleSlider.slider.oninput = () => { const val = parseFloat(eqTrebleSlider.slider.value); state.eqTrebleGain = val; eqTrebleSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            eqPresenceSlider = createSliderControl('초고음', 'eqPresenceSlider', -12, 12, 1, state.eqPresenceGain, 'dB');
            eqPresenceSlider.slider.oninput = () => { const val = parseFloat(eqPresenceSlider.slider.value); state.eqPresenceGain = val; eqPresenceSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            bassBoostSlider = createSliderControl('베이스 부스트', 'bassBoostSlider', 0, 9, 0.5, state.bassBoostGain, 'dB');
            bassBoostSlider.slider.oninput = () => { const val = parseFloat(bassBoostSlider.slider.value); state.bassBoostGain = val; bassBoostSlider.valueSpan.textContent = `${val.toFixed(1)} dB`; applyAudioEffectsToMedia(); };
            const hpfBtn = createButton('vsc-hpf-toggle', 'High-Pass Filter (저음 컷)', 'HPF', 'vsc-btn');
            hpfBtn.onclick = () => { initializeAudioEngine(); setHpfEnabled(!state.isHpfEnabled); };
            hpfSlider = createSliderControl('HPF 주파수', 'hpfSlider', 20, 500, 5, state.currentHpfHz, 'Hz');
            hpfSlider.slider.oninput = () => { const val = parseFloat(hpfSlider.slider.value); state.currentHpfHz = val; hpfSlider.valueSpan.textContent = `${val.toFixed(0)}Hz`; applyAudioEffectsToMedia(); };
            column1.append(eqBtn, eqSubBassSlider.controlDiv, eqBassSlider.controlDiv, eqMidSlider.controlDiv, eqTrebleSlider.controlDiv, eqPresenceSlider.controlDiv, createDivider(), bassBoostSlider.controlDiv, createDivider(), hpfBtn, hpfSlider.controlDiv);

            const deesserBtn = createButton('vsc-deesser-toggle', '디에서 (치찰음 제거)', '디에서', 'vsc-btn');
            deesserBtn.onclick = () => { initializeAudioEngine(); setDeesserEnabled(!state.isDeesserEnabled); };
            deesserThresholdSlider = createSliderControl('강도', 'deesserThresholdSlider', -60, 0, 1, state.deesserThreshold, 'dB');
            deesserThresholdSlider.slider.oninput = () => { const val = parseFloat(deesserThresholdSlider.slider.value); state.deesserThreshold = val; deesserThresholdSlider.valueSpan.textContent = `${val.toFixed(0)}dB`; applyAudioEffectsToMedia(); };
            deesserFreqSlider = createSliderControl('주파수', 'deesserFreqSlider', 4000, 12000, 100, state.deesserFreq, 'Hz');
            deesserFreqSlider.slider.oninput = () => { const val = parseFloat(deesserFreqSlider.slider.value); state.deesserFreq = val; deesserFreqSlider.valueSpan.textContent = `${(val / 1000).toFixed(1)}kHz`; applyAudioEffectsToMedia(); };
            const exciterBtn = createButton('vsc-exciter-toggle', '익사이터 (선명도/광택)', '익사이터', 'vsc-btn');
            exciterBtn.onclick = () => { initializeAudioEngine(); setExciterEnabled(!state.isExciterEnabled); };
            exciterAmountSlider = createSliderControl('강도', 'exciterAmountSlider', 0, 100, 1, state.exciterAmount, '%');
            exciterAmountSlider.slider.oninput = () => { const val = parseFloat(exciterAmountSlider.slider.value); state.exciterAmount = val; exciterAmountSlider.valueSpan.textContent = `${val.toFixed(0)}%`; applyAudioEffectsToMedia(); };
            const parallelCompBtn = createButton('vsc-parallel-comp-toggle', '병렬 압축 (디테일 향상)', '업컴프', 'vsc-btn');
            parallelCompBtn.onclick = () => { initializeAudioEngine(); setParallelCompEnabled(!state.isParallelCompEnabled); };
            parallelCompMixSlider = createSliderControl('믹스', 'parallelCompMixSlider', 0, 100, 1, state.parallelCompMix, '%');
            parallelCompMixSlider.slider.oninput = () => { const val = parseFloat(parallelCompMixSlider.slider.value); state.parallelCompMix = val; parallelCompMixSlider.valueSpan.textContent = `${val.toFixed(0)}%`; applyAudioEffectsToMedia(); };
            column2.append(deesserBtn, deesserThresholdSlider.controlDiv, deesserFreqSlider.controlDiv, createDivider(), exciterBtn, exciterAmountSlider.controlDiv, createDivider(), parallelCompBtn, parallelCompMixSlider.controlDiv);

            const widenBtnGroup = document.createElement('div'); widenBtnGroup.className = 'vsc-button-group';
            const widenBtn = createButton('vsc-widen-toggle', 'Virtualizer ON/OFF', 'Virtualizer', 'vsc-btn');
            widenBtn.onclick = () => { initializeAudioEngine(); setWideningEnabled(!state.isWideningEnabled); };
            const adaptiveWidthBtn = createButton('vsc-adaptive-width-toggle', '저역 폭 제어 ON/OFF', 'Bass Mono', 'vsc-btn');
            adaptiveWidthBtn.onclick = () => { initializeAudioEngine(); setAdaptiveWidthEnabled(!state.isAdaptiveWidthEnabled); };
            widenBtnGroup.append(widenBtn, adaptiveWidthBtn);
            wideningSlider = createSliderControl('강도', 'wideningSlider', 0, 3, 0.1, state.currentWideningFactor, 'x');
            wideningSlider.slider.oninput = () => { const val = parseFloat(wideningSlider.slider.value); state.currentWideningFactor = val; wideningSlider.valueSpan.textContent = `${val.toFixed(1)}x`; applyAudioEffectsToMedia(); };
            panSlider = createSliderControl('Pan (좌우)', 'panSlider', -1, 1, 0.1, state.currentStereoPan, '');
            panSlider.slider.oninput = () => { const val = parseFloat(panSlider.slider.value); state.currentStereoPan = val; panSlider.valueSpan.textContent = val.toFixed(1); applyAudioEffectsToMedia(); };
            const preGainBtnGroup = document.createElement('div'); preGainBtnGroup.className = 'vsc-button-group';
            const preGainBtn = createButton('vsc-pregain-toggle', '볼륨 ON/OFF', '볼륨', 'vsc-btn');
            preGainBtn.onclick = () => { initializeAudioEngine(); setPreGainEnabled(!state.isPreGainEnabled); };
            const autoVolumeBtn = createButton('vsc-auto-volume-toggle', '음량 평준화 (Shift+Click: 초기화)', '자동', 'vsc-btn');
            autoVolumeBtn.onclick = (event) => {
                if (state.isAnalyzingLoudness) { showWarningMessage('이미 음량 분석이 진행 중입니다.'); return; }
                initializeAudioEngine();
                const media = state.currentlyVisibleMedia || Array.from(state.activeMedia)[0];
                if (!media) { showWarningMessage('음량을 분석할 활성 미디어가 없습니다.'); return; }
                const nodes = state.audioContextMap.get(media);
                if (!nodes) return;
                if (event.shiftKey) {
                    nodes.cumulativeLUFS = 0; nodes.lufsSampleCount = 0;
                    state.currentPreGain = state.lastManualPreGain;
                    applyAudioEffectsToMedia();
                    const slider = state.ui.shadowRoot?.getElementById('preGainSlider');
                    if (slider) slider.value = state.currentPreGain;
                    showWarningMessage('음량 평준화 기록을 초기화했습니다.');
                    return;
                }
                if (!state.isPreGainEnabled) { setPreGainEnabled(true); }
                audioEffectsManager.startLoudnessNormalization(media);
            };
            preGainBtnGroup.append(preGainBtn, autoVolumeBtn);
            preGainSlider = createSliderControl('볼륨 크기', 'preGainSlider', 0, 4, 0.1, state.currentPreGain, 'x');
            preGainSlider.slider.oninput = () => {
                const val = parseFloat(preGainSlider.slider.value);
                state.currentPreGain = val; state.lastManualPreGain = val;
                preGainSlider.valueSpan.textContent = `${val.toFixed(1)}x`;
                if (state.isAnalyzingLoudness) { state.isAnalyzingLoudness = false; updateAutoVolumeButtonStyle(); }
                applyAudioEffectsToMedia();
            };
            const loudnessEqBtn = createButton('vsc-loudness-eq-toggle', '라우드니스 EQ (볼륨따라 저/고음 보정)', '라우드니스', 'vsc-btn');
            loudnessEqBtn.onclick = () => { initializeAudioEngine(); setLoudnessEqEnabled(!state.isLoudnessEqEnabled); };
            const masteringSuiteBtn = createButton('vsc-mastering-suite-toggle', '마스터링 스위트 (타격감, 음압)', '마스터링', 'vsc-btn');
            masteringSuiteBtn.onclick = () => { initializeAudioEngine(); setMasteringSuiteEnabled(!state.isMasteringSuiteEnabled); };
            masteringTransientSlider = createSliderControl('타격감', 'masteringTransientSlider', 0, 100, 1, state.masteringTransientAmount * 100, '%');
            masteringTransientSlider.slider.oninput = () => {
                const val = parseFloat(masteringTransientSlider.slider.value);
                state.masteringTransientAmount = val / 100;
                masteringTransientSlider.valueSpan.textContent = `${val.toFixed(0)}%`;
                applyAudioEffectsToMedia();
            };
            masteringDriveSlider = createSliderControl('음압', 'masteringDriveSlider', 0, 12, 0.5, state.masteringDrive, 'dB');
            masteringDriveSlider.slider.oninput = () => {
                const val = parseFloat(masteringDriveSlider.slider.value);
                state.masteringDrive = val;
                masteringDriveSlider.valueSpan.textContent = `${val.toFixed(1)}dB`;
                applyAudioEffectsToMedia();
            };
            column3.append(widenBtnGroup, wideningSlider.controlDiv, panSlider.controlDiv, createDivider(), preGainBtnGroup, preGainSlider.controlDiv, createDivider(), loudnessEqBtn, createDivider(), masteringSuiteBtn, masteringTransientSlider.controlDiv, masteringDriveSlider.controlDiv);

            const bottomControlsContainer = document.createElement('div');
            bottomControlsContainer.style.cssText = `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; border-top: 1px solid #444; padding-top: 8px; grid-column: 1 / -1;`;
            const resetBtn = createButton('vsc-reset-all', '모든 오디오 설정 기본값으로 초기화', '초기화', 'vsc-btn');

            presetMap = {
                'default': {
                    name: '기본값 (모든 효과 꺼짐)'
                },

                'basic_clear': {
                    name: '✔ 기본 개선 (명료)',
                    hpf_enabled: true, hpf_hz: 70,
                    eq_enabled: true, eq_subBass: 0, eq_bass: 0, eq_mid: 1.5, eq_treble: 1.2, eq_presence: 1.5,
                    preGain_enabled: true, preGain_value: 1.0,
                    mastering_suite_enabled: true, mastering_transient: 0.2, mastering_drive: 2,
                },

                // 🎬 영상 콘텐츠 관련 프리셋
                'movie_immersive': {
                    name: '🎬 영화/드라마 (몰입감)',
                    hpf_enabled: true, hpf_hz: 60,
                    eq_enabled: true, eq_subBass: 1, eq_bass: 1, eq_mid: 2, eq_treble: 1.5, eq_presence: 1,
                    widen_enabled: true, widen_factor: 1.4,
                    deesser_enabled: true, deesser_threshold: -32, deesser_freq: 8000,
                    mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 4,
                },

                'action_blockbuster': {
                    name: '💥 액션 블록버스터 (타격감)',
                    hpf_enabled: true, hpf_hz: 50,
                    eq_enabled: true, eq_subBass: 2, eq_bass: 1.5, eq_mid: -1, eq_treble: 1, eq_presence: 2,
                    widen_enabled: true, widen_factor: 1.5,
                    parallel_comp_enabled: true, parallel_comp_mix: 18,
                    mastering_suite_enabled: true, mastering_transient: 0.4, mastering_drive: 5,
                },

                'concert_hall': {
                    name: '🏟️ 라이브 콘서트 (현장감)',
                    hpf_enabled: true, hpf_hz: 60,
                    eq_enabled: true, eq_subBass: 1, eq_bass: 1, eq_mid: 0, eq_treble: 1, eq_presence: 1,
                    widen_enabled: true, widen_factor: 1.4,
                    //spatial_enabled: true, spatial_speed: 0, spatial_dist: 1.2, spatial_reverb: 0.15,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 5,
                },

                // 🎶 음악 관련 프리셋
                'music_dynamic': {
                    name: '🎶 음악 (다이나믹 & 펀치감)',
                    hpf_enabled: true, hpf_hz: 80,
                    eq_enabled: true, eq_subBass: 1.2, eq_bass: 1.2, eq_mid: -1, eq_treble: 1, eq_presence: 2,
                    widen_enabled: true, widen_factor: 1.4,
                    exciter_enabled: true, exciter_amount: 15,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 4,
                },

                'mastering_balanced': {
                    name: '🔥 밸런스 마스터링 (고음질)',
                    hpf_enabled: true, hpf_hz: 45,
                    eq_enabled: true, eq_subBass: 0, eq_bass: 0, eq_mid: 0, eq_treble: 1, eq_presence: 1,
                    widen_enabled: true, widen_factor: 1.25,
                    exciter_enabled: true, exciter_amount: 12,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 3.5,
                },

                // 🗣️ 음성 관련 프리셋
                'vocal_clarity_pro': {
                    name: '🎙️ 목소리 명료 (강의/뉴스/팟캐스트)',
                    hpf_enabled: true, hpf_hz: 110,
                    eq_enabled: true, eq_subBass: -2, eq_bass: -1, eq_mid: 3, eq_treble: 2, eq_presence: 1.5,
                    preGain_enabled: true, preGain_value: 1.2,
                    deesser_enabled: true, deesser_threshold: -32, deesser_freq: 8000,
                    parallel_comp_enabled: true, parallel_comp_mix: 12,
                    mastering_suite_enabled: true, mastering_transient: 0.1, mastering_drive: 1.5,
                },

                // 🎮 게임 관련 프리셋
                'gaming_pro': {
                    name: '🎮 게이밍 (사운드 플레이)',
                    hpf_enabled: true, hpf_hz: 50,
                    eq_enabled: true, eq_subBass: -1, eq_bass: 0, eq_mid: 1.5, eq_treble: 2, eq_presence: 3,
                    widen_enabled: true, widen_factor: 1.5,
                    preGain_enabled: true, preGain_value: 1.2,
                    mastering_suite_enabled: true, mastering_transient: 0.5, mastering_drive: 2.5,
                },
            };



            const presetOptions = Object.entries(presetMap).map(([value, { name }]) => ({ value, text: name }));
            const presetSelect = createSelectControl('프리셋 선택', presetOptions, (val) => { if (val) applyPreset(val); }, 'presetSelect');
            resetBtn.onclick = () => { applyPreset('default'); if(presetSelect) presetSelect.selectedIndex = 0; };
            bottomControlsContainer.append(presetSelect, resetBtn);

            audioGridContainer.append(column1, column2, column3, bottomControlsContainer);
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
                if (shadowRoot.querySelector('#imageFilterSelect')) shadowRoot.querySelector('#imageFilterSelect').value = state.currentImageFilterLevel;
                setWideningEnabled(state.isWideningEnabled);
                setHpfEnabled(state.isHpfEnabled);
                setEqEnabled(state.isEqEnabled);
                setSpatialAudioEnabled(state.isSpatialAudioEnabled);
                setLoudnessEqEnabled(state.isLoudnessEqEnabled);
                updateAutoVolumeButtonStyle();
                setPreGainEnabled(state.isPreGainEnabled);
                setDeesserEnabled(state.isDeesserEnabled);
                setExciterEnabled(state.isExciterEnabled);
                setParallelCompEnabled(state.isParallelCompEnabled);
                setLimiterEnabled(state.isLimiterEnabled);
                setMasteringSuiteEnabled(state.isMasteringSuiteEnabled);
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
        const CHECK_INTERVAL = 500;
        const MIN_RATE = 0.95, MAX_RATE = 1.05, TOLERANCE = 150;
        let localIntersectionObserver;
        let delayMeterClosed = false;
        function isYouTubeLive() { if (!location.href.includes('youtube.com')) return false; try { const b = document.querySelector('.ytp-live-badge'); return b && b.offsetParent !== null && !/스트림이었음|was live/i.test(b.textContent); } catch { return false; } }
        function findVideo() { return state.activeMedia.size > 0 ? Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO') : null; }
        function calculateDelay(v) { if (!v || !v.buffered || v.buffered.length === 0) return null; try { const e = v.buffered.end(v.buffered.length - 1); return Math.max(0, (e - v.currentTime) * 1000); } catch { return null; } }
        function getPlaybackRate(currentAvgDelay) { const t = getTargetDelay(), d = currentAvgDelay - t; if (Math.abs(d) <= TOLERANCE) return 1.0; const n = 1.0 + (d / 6000); return Math.max(MIN_RATE, Math.min(n, MAX_RATE)); }
        function checkAndAdjust() {
            if (!video) video = findVideo();
            if (!video) return;
            const rawDelay = calculateDelay(video);
            if (rawDelay === null) return;

            if (avgDelay === null) {
                avgDelay = rawDelay;
            } else {
                avgDelay = CONFIG.AUTODELAY_EMA_ALPHA * rawDelay + (1 - CONFIG.AUTODELAY_EMA_ALPHA) * avgDelay;
            }

            if (location.href.includes('youtube.com') && !isYouTubeLive()) {
                if (video.playbackRate !== 1.0) safeExec(() => { video.playbackRate = 1.0; state.currentPlaybackRate = 1.0; });
                const infoEl = document.getElementById('vsc-delay-info'); if (infoEl) infoEl.remove();
                return;
            }
            const newRate = getPlaybackRate(avgDelay);
            if (Math.abs(video.playbackRate - newRate) > 0.001) safeExec(() => { video.playbackRate = newRate; state.currentPlaybackRate = newRate; });

            let infoEl = document.getElementById('vsc-delay-info');
            if (avgDelay !== null && !delayMeterClosed) {
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
                    Object.assign(refreshBtn.style, {
                        background: 'none', border: '1px solid white', color: 'white',
                        borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px'
                    });
                    refreshBtn.onclick = () => location.reload();

                    const closeBtn = document.createElement('button');
                    closeBtn.textContent = '✖';
                    closeBtn.title = '닫기';
                    Object.assign(closeBtn.style, {
                        background: 'none', border: '1px solid white', color: 'white',
                        borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px'
                    });
                    closeBtn.onclick = () => {
                        infoEl.remove();
                        delayMeterClosed = true;
                    };

                    infoEl.append(textSpan, refreshBtn, closeBtn);
                    document.body.appendChild(infoEl);
                }
                const textSpan = infoEl.querySelector('#vsc-delay-text');
                if (textSpan) {
                    textSpan.textContent = `딜레이: ${avgDelay.toFixed(0)}ms / 현재: ${rawDelay.toFixed(0)}ms / 배속: ${state.currentPlaybackRate.toFixed(3)}x`;
                }
            }
        }
        function start() {
            if (!CONFIG.LIVE_STREAM_URLS.some(d => location.href.includes(d)) || (location.href.includes('youtube.com') && !isYouTubeLive()) || state.delayCheckInterval) return;
            avgDelay = null; video = findVideo(); if (video) state.currentPlaybackRate = video.playbackRate;
            if (!localIntersectionObserver) {
                localIntersectionObserver = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.target.tagName === 'VIDEO') video = e.target; }), { threshold: 0.5 });
                state.activeMedia.forEach(m => { if (m.tagName === 'VIDEO') localIntersectionObserver.observe(m); });
            }
            state.delayCheckInterval = setInterval(checkAndAdjust, CHECK_INTERVAL);
        }
        function stop() {
            if (state.delayCheckInterval) clearInterval(state.delayCheckInterval); state.delayCheckInterval = null;
            if (localIntersectionObserver) localIntersectionObserver.disconnect(); localIntersectionObserver = null;
            if (video) safeExec(() => { if (video.playbackRate !== 1.0) video.playbackRate = 1.0; video = null; });
            avgDelay = null;
            delayMeterClosed = false;
            const infoEl = document.getElementById('vsc-delay-info'); if (infoEl) infoEl.remove();
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
        const shouldApply = state.currentVideoFilterLevel > 0 ||
            state.currentVideoFilterLevel2 > 0 ||
            Math.abs(state.currentVideoSaturation - 100) > 0.1 ||
            Math.abs(state.currentVideoGamma - 1.0) > 0.001 ||
            state.currentVideoBlur > 0 ||
            state.currentVideoShadows !== 0 ||
            state.currentVideoHighlights !== 0;

        if (video.dataset.isVisible !== 'false' && shouldApply) {
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            const combinedFilterId = `${videoDefaults.SHARPEN_ID}_combined_filter`;
            video.style.setProperty('filter', `url(#${combinedFilterId})`, 'important');
        } else {
            video.style.removeProperty('filter');
        }
    }
    function updateImageFilterState(image) { if (!imageFilterManager.isInitialized()) return; image.classList.toggle('vsc-image-filter-active', image.dataset.isVisible !== 'false' && state.currentImageFilterLevel > 0); }
    function updateActiveSpeedButton(rate) { if (!speedButtonsContainer) return; speedButtonsContainer.querySelectorAll('button').forEach(b => { const br = parseFloat(b.dataset.speed); b.style.boxShadow = Math.abs(br - rate) < 0.01 ? '0 0 5px #3498db, 0 0 10px #3498db inset' : 'none'; }); }

    const mediaEventHandlers = {
        play: e => {
            const m = e.target;
            if (m.tagName === 'VIDEO') updateVideoFilterState(m);
            mediaSessionManager.setSession(m);
        },
        pause: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ratechange: e => { updateActiveSpeedButton(e.target.playbackRate); },
        volumechange: e => {
            if (state.isLoudnessEqEnabled) {
                audioEffectsManager.reconnectGraph(e.target);
            }
        },
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
                        const level = state.currentImageFilterLevel;
                        manager.updateFilterValues({ sharpenMatrix: calculateSharpenMatrix(level) }, root);
                    }
                }, 100);
            }
        }
    }

    function attachMediaListeners(media) {
        if (!media || state.processedMedia.has(media) || !intersectionObserver) return;
        if (media.tagName === 'VIDEO') injectFiltersIntoRoot(media, filterManager);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) { listeners[evt] = handler; media.addEventListener(evt, handler); }
        state.mediaListenerMap.set(media, listeners);
        state.processedMedia.add(media);
        intersectionObserver.observe(media);
    }
    function attachImageListeners(image) {
        if (!image || state.processedImages.has(image) || !intersectionObserver) return;
        injectFiltersIntoRoot(image, imageFilterManager);
        state.processedImages.add(image);
        intersectionObserver.observe(image);
    }
    function detachMediaListeners(media) {
        if (!state.mediaListenerMap.has(media)) return;
        const listeners = state.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) media.removeEventListener(evt, listener);
        state.mediaListenerMap.delete(media);
        if (intersectionObserver) intersectionObserver.unobserve(media);
        audioEffectsManager.cleanupForMedia(media);
    }
    function detachImageListeners(image) {
        if (!state.processedImages.has(image)) return;
        state.processedImages.delete(image);
        if (intersectionObserver) intersectionObserver.unobserve(image);
    }

    const scanAndApply = () => {
        const allMedia = findAllMedia();
        allMedia.forEach(attachMediaListeners);
        const oldMedia = new Set(state.activeMedia);
        state.activeMedia.clear();
        allMedia.forEach(m => { if (m.isConnected) { state.activeMedia.add(m); oldMedia.delete(m); } });
        oldMedia.forEach(detachMediaListeners);

        if (!isMobile) {
            allMedia.forEach(m => {
                if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); }
            });
        }

        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);
        const oldImages = new Set(state.activeImages);
        state.activeImages.clear();
        allImages.forEach(img => { if (img.isConnected) { state.activeImages.add(img); oldImages.delete(img); } });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);
        const root = state.ui?.shadowRoot;
        if (root) {
            const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
            const hasAudio = Array.from(state.activeMedia).some(m => m.tagName === 'AUDIO');
            const hasImage = state.activeImages.size > 0;
            const hasAnyMedia = hasVideo || hasAudio;

            if (speedButtonsContainer && triggerElement) {
                const areControlsVisible = triggerElement.textContent === '🛑';
                speedButtonsContainer.style.display = hasVideo && areControlsVisible ? 'flex' : 'none';
            }

            if (hasVideo) state.mediaTypesEverFound.video = true;
            if (hasImage) state.mediaTypesEverFound.image = true;
            filterManager.toggleStyleSheet(state.mediaTypesEverFound.video);
            imageFilterManager.toggleStyleSheet(state.mediaTypesEverFound.image);
            const setDisplay = (id, visible) => { const el = root.getElementById(id); if (el) el.style.display = visible ? 'flex' : 'none'; };
            setDisplay('vsc-video-controls', hasVideo);
            setDisplay('vsc-image-controls', hasImage);
            setDisplay('vsc-stereo-controls', hasAnyMedia);
        }
    };

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
                    if (state.currentlyVisibleMedia !== newVisibleMedia) {
                        state.currentlyVisibleMedia = newVisibleMedia;
                    }
                }
            }, {
                root: null,
                rootMargin: '0px',
                threshold: [0, 0.25, 0.5, 0.75, 1.0]
            });
        }
    }

    let spaNavigationHandler = null;
    function hookSpaNavigation() {
        if (spaNavigationHandler) return;
        spaNavigationHandler = debounce(() => {
            if (location.href === state.lastUrl) return;

            if (uiContainer) {
                uiContainer.remove();
                uiContainer = null;
                triggerElement = null;
                speedButtonsContainer = null;
            }
            state.activeMedia.forEach(m => audioEffectsManager.cleanupForMedia(m));
            cleanup();
            globalUIManager.getInstance().cleanupGlobalListeners();
            resetState();
            settingsManager.init();
            uiManager.reset();
            speedSlider.reset();

            setTimeout(initializeGlobalUI, 500);
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
        state.lastUrl = location.href;
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

        const initialRate = state.activeMedia.size > 0 ? Array.from(state.activeMedia)[0].playbackRate : 1.0;
        updateActiveSpeedButton(initialRate);

        if (!titleObserver) {
            const titleElement = document.querySelector('head > title');
            if (titleElement) {
                titleObserver = new MutationObserver(() => {
                    const activeVideo = Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO' && !m.paused);
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
                    cursor: 'pointer', userSelect: 'none'
                });

                speedButtonsContainer = document.createElement('div');
                speedButtonsContainer.id = 'vsc-speed-buttons-container';
                Object.assign(speedButtonsContainer.style, { display: 'none', flexDirection: 'column', gap: '5px', alignItems: 'center' });

                CONFIG.SPEED_PRESETS.forEach(speed => {
                    const btn = document.createElement('button');
                    btn.textContent = `${speed}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn';
                    Object.assign(btn.style, {
                        width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)',
                        background: 'rgba(52, 152, 219, 0.5)', color: 'white', border: 'none', borderRadius: 'clamp(4px, 0.8vmin, 6px)',
                        cursor: 'pointer', WebkitTapHighlightColor: 'transparent'
                    });
                    if (speed === 1.0) btn.style.boxShadow = '0 0 5px #3498db, 0 0 10px #3498db inset';
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        const newSpeed = parseFloat(btn.dataset.speed);
                        state.activeMedia.forEach(media => safeExec(() => { media.playbackRate = newSpeed; }));
                        updateActiveSpeedButton(newSpeed);
                        if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
                    };
                    speedButtonsContainer.appendChild(btn);
                });

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
                        const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
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

        const initialMediaCheck = () => {
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

    if (!isExcluded()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initializeGlobalUI, 0));
        } else {
            setTimeout(initializeGlobalUI, 0);
        }
    }
})();
