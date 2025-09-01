// ==UserScript==
// @name         Video_Image_Control (with Advanced Audio FX)
// @namespace    https://com/
// @version      73.3
// @description  모바일 환경에서 현재 비디오에 오디오 효과가 적용되지 않던 문제 해결
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let uiContainer = null, triggerElement = null, speedButtonsContainer = null, titleObserver = null;

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const TARGET_DELAYS = {
        "youtube.com": 2750, "chzzk.naver.com": 2000, "play.sooplive.co.kr": 2000,
        "twitch.tv": 2000, "kick.com": 2000,
    };
    const DEFAULT_TARGET_DELAY = 2000;

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 3 : 1,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 3 : 1,
        // 오디오 설정
        DEFAULT_WIDENING_ENABLED: false,
        DEFAULT_WIDENING_FACTOR: 1.0,
        DEFAULT_STEREO_PAN: 0,
        // 3D 위치 음향 (Positional Audio) 설정
        DEFAULT_3D_ENABLED: false,
        DEFAULT_3D_POS_X: 0,
        DEFAULT_3D_POS_Y: 0,
        DEFAULT_3D_POS_Z: -1,
        // 내장 리버브 설정
        DEFAULT_REVERB_ENABLED: false,
        DEFAULT_REVERB_MIX: 0.2,
        DEFAULT_REVERB_LENGTH: 1.5,
        // 공용 이펙트 설정
        EFFECTS_HPF_FREQUENCY: 120,
        // Advanced FX Settings
        DEFAULT_EQ_ENABLED: false,
        DEFAULT_EQ_LOW_GAIN: 0,
        DEFAULT_EQ_MID_GAIN: 0,
        DEFAULT_EQ_HIGH_GAIN: 0,
        DEFAULT_COMPRESSOR_ENABLED: false,
        DEFAULT_COMPRESSOR_THRESHOLD: -24,
        DEFAULT_ADAPTIVE_WIDTH_ENABLED: false,
        DEFAULT_ADAPTIVE_WIDTH_FREQ: 150,

        DEBUG: false, DEBOUNCE_DELAY: 300, THROTTLE_DELAY: 100, MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05, SEEK_TIME_MAX_SEC: 15, IMAGE_MIN_SIZE: 355, VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [4, 2, 1.5, 1, 0.2], UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'youtube.com', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com', 'challenges.cloudflare.com'],
        SPECIFIC_EXCLUSIONS: [],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 115 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.2', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 115 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0.3', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
    };

    const UI_SELECTORS = {
        HOST: 'vsc-ui-host', CONTAINER: 'vsc-container', TRIGGER: 'vsc-trigger-button',
        CONTROL_GROUP: 'vsc-control-group', SUBMENU: 'vsc-submenu', BTN: 'vsc-btn', BTN_MAIN: 'vsc-btn-main',
        SELECT: 'vsc-select'
    };

    function getTargetDelay() {
        const host = location.hostname;
        for (const site in TARGET_DELAYS) { if (host.includes(site)) return TARGET_DELAYS[site]; }
        return DEFAULT_TARGET_DELAY;
    }

    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 5 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 5 }
        };
        function init() { Object.keys(definitions).forEach(key => { settings[key] = definitions[key].default; }); }
        return { init, get: (key) => settings[key], set: (key, value) => { settings[key] = value; }, definitions };
    })();

    settingsManager.init();
    const state = {};
    resetState();
    function resetState() {
        Object.keys(state).forEach(key => delete state[key]);
        Object.assign(state, {
            activeMedia: new Set(), processedMedia: new WeakSet(), activeImages: new Set(),
            processedImages: new WeakSet(), mediaListenerMap: new WeakMap(),
            currentlyVisibleMedia: null,
            currentVideoFilterLevel: settingsManager.get('videoFilterLevel') || 0,
            currentImageFilterLevel: settingsManager.get('imageFilterLevel') || 0,
            isWideningEnabled: CONFIG.DEFAULT_WIDENING_ENABLED,
            audioContextMap: new WeakMap(),
            currentWideningFactor: CONFIG.DEFAULT_WIDENING_FACTOR,
            currentHpfHz: CONFIG.EFFECTS_HPF_FREQUENCY,
            currentStereoPan: CONFIG.DEFAULT_STEREO_PAN,
            is3dEnabled: CONFIG.DEFAULT_3D_ENABLED,
            current3dPosX: CONFIG.DEFAULT_3D_POS_X,
            current3dPosY: CONFIG.DEFAULT_3D_POS_Y,
            current3dPosZ: CONFIG.DEFAULT_3D_POS_Z,
            isReverbEnabled: CONFIG.DEFAULT_REVERB_ENABLED,
            currentReverbMix: CONFIG.DEFAULT_REVERB_MIX,
            currentReverbLength: CONFIG.DEFAULT_REVERB_LENGTH,
            isEqEnabled: CONFIG.DEFAULT_EQ_ENABLED,
            eqLowGain: CONFIG.DEFAULT_EQ_LOW_GAIN,
            eqMidGain: CONFIG.DEFAULT_EQ_MID_GAIN,
            eqHighGain: CONFIG.DEFAULT_EQ_HIGH_GAIN,
            isCompressorEnabled: CONFIG.DEFAULT_COMPRESSOR_ENABLED,
            compressorThreshold: CONFIG.DEFAULT_COMPRESSOR_THRESHOLD,
            isAdaptiveWidthEnabled: CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED,
            adaptiveWidthFreq: CONFIG.DEFAULT_ADAPTIVE_WIDTH_FREQ,
            ui: { shadowRoot: null, hostElement: null }, delayCheckInterval: null,
            currentPlaybackRate: 1.0, mediaTypesEverFound: { video: false, image: false }, lastUrl: '',
            audioContextWarningShown: false
        });
    }

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    function calculateSharpenMatrix(level) { const p = parseInt(level, 10); if (isNaN(p) || p === 0) return '0 0 0 0 1 0 0 0 0'; const i = 1 + (p - 0.5) * 1.25; const o = (1 - i) / 4; return `0 ${o} 0 ${o} ${i} ${o} 0 ${o} 0`; }

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
        setSharpenMatrix(matrix, rootNode = document) {
            if (!this.isInitialized()) return;
            const matrixEl = rootNode.getElementById(this.#options.matrixId);
            if (matrixEl && matrixEl.getAttribute('kernelMatrix') !== matrix) {
                matrixEl.setAttribute('kernelMatrix', matrix);
            }
        }
        #createElements() {
            const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
            const { settings, svgId, styleId, matrixId, className } = this.#options;
            const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
            const filters = [
                { id: `${settings.SHARPEN_ID}_soft`, children: [createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })] },
                { id: settings.SHARPEN_ID, children: [createSvgElement('feConvolveMatrix', { id: matrixId, order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0' })] },
                { id: `${settings.SHARPEN_ID}_gamma`, children: [createSvgElement('feComponentTransfer', {}, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))) ] },
                { id: `${settings.SHARPEN_ID}_linear`, children: [createSvgElement('feComponentTransfer', {}, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'linear', slope: (1 + settings.HIGHLIGHTS_VALUE / 100).toString(), intercept: (settings.SHADOWS_VALUE / 200).toString() }))) ] }
            ];
            svg.append(...filters.map(f => createSvgElement('filter', { id: f.id }, ...f.children)));
            const style = document.createElement('style'); style.id = styleId;
            style.textContent = `.${className}{filter:saturate(${settings.SATURATION_VALUE}%) url(#${filters[2].id}) url(#${filters[0].id}) url(#${filters[1].id}) url(#${filters[3].id})!important;}.${'vsc-gpu-accelerated'}{transform:translateZ(0);will-change:transform;}`;
            return { svgNode: svg, styleElement: style };
        }
    }
    const filterManager = new SvgFilterManager({ settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', matrixId: 'vsc-dynamic-convolve-matrix', className: 'vsc-video-filter-active' });
    const imageFilterManager = new SvgFilterManager({ settings: CONFIG.IMAGE_FILTER_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', matrixId: 'vsc-image-convolve-matrix', className: 'vsc-image-filter-active' });

    const stereoWideningManager = (() => {
        function createSyntheticReverb(context, duration, decay) {
            const sampleRate = context.sampleRate;
            const length = sampleRate * duration;
            const buffer = context.createBuffer(2, length, sampleRate);
            for (let channel = 0; channel < 2; channel++) {
                const channelData = buffer.getChannelData(channel);
                for (let i = 0; i < length; i++) {
                    channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
                }
            }
            return buffer;
        }

        const setParamWithFade = (audioParam, targetValue, duration = 0.05) => {
            if (!audioParam || !isFinite(targetValue)) return;
            const ctx = audioParam.context;
            if (!ctx || ctx.state === 'closed') return;
            audioParam.cancelScheduledValues(ctx.currentTime);
            audioParam.linearRampToValueAtTime(targetValue, ctx.currentTime + duration);
        };

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

            const nodes = { context, source,
                eqLow: context.createBiquadFilter(), eqMid: context.createBiquadFilter(), eqHigh: context.createBiquadFilter(),
                compressor: context.createDynamicsCompressor(),
                ms_splitter: context.createChannelSplitter(2), ms_mid_sum: context.createGain(),
                ms_mid_level: context.createGain(), ms_side_invert_R: context.createGain(), ms_side_sum: context.createGain(),
                ms_side_level: context.createGain(), ms_side_gain: context.createGain(), adaptiveWidthFilter: context.createBiquadFilter(),
                ms_decode_L_sum: context.createGain(), ms_decode_invert_Side: context.createGain(), ms_decode_R_sum: context.createGain(), ms_merger: context.createChannelMerger(2),
                hpfWiden: context.createBiquadFilter(), panner3d: context.createPanner(),
                convolver: context.createConvolver(), wetGainReverb: context.createGain(),
                stereoPanner: context.createStereoPanner(), analyser: context.createAnalyser(), analyserData: null };

            state.audioContextMap.set(media, nodes);
            reconnectGraph(media);
            return nodes;
        }

        function reconnectGraph(media) {
            const nodes = state.audioContextMap.get(media);
            if (!nodes) return;

            safeExec(() => {
                const allNodes = Object.values(nodes);
                for(const node of allNodes) {
                    if (node && typeof node.disconnect === 'function' && node !== nodes.context) {
                        try { node.disconnect(); } catch(e) {}
                    }
                }

                nodes.eqLow.type = 'lowshelf'; nodes.eqLow.frequency.value = 150; nodes.eqLow.gain.value = state.eqLowGain;
                nodes.eqMid.type = 'peaking'; nodes.eqMid.frequency.value = 1000; nodes.eqMid.Q.value = 1; nodes.eqMid.gain.value = state.eqMidGain;
                nodes.eqHigh.type = 'highshelf'; nodes.eqHigh.frequency.value = 5000; nodes.eqHigh.gain.value = state.eqHighGain;
                nodes.compressor.threshold.value = state.compressorThreshold; nodes.compressor.knee.value = 10; nodes.compressor.ratio.value = 4; nodes.compressor.attack.value = 0.01; nodes.compressor.release.value = 0.1;
                Object.assign(nodes.panner3d, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1 });
                nodes.panner3d.positionX.value = state.current3dPosX; nodes.panner3d.positionY.value = state.current3dPosY; nodes.panner3d.positionZ.value = state.current3dPosZ;
                nodes.stereoPanner.pan.value = state.currentStereoPan;

                const finalDestination = state.isCompressorEnabled ? nodes.compressor : nodes.context.destination;
                if (state.isCompressorEnabled) nodes.compressor.connect(nodes.context.destination);

                let lastNodeInChain = nodes.source;
                if (state.isEqEnabled) {
                    nodes.eqLow.connect(nodes.eqMid).connect(nodes.eqHigh);
                    lastNodeInChain.connect(nodes.eqLow);
                    lastNodeInChain = nodes.eqHigh;
                }
                lastNodeInChain.connect(nodes.stereoPanner);
                lastNodeInChain = nodes.stereoPanner;

                let positionalPathOutput = lastNodeInChain;
                if (state.isWideningEnabled) {
                    nodes.ms_mid_level.gain.value = 0.5;
                    nodes.ms_side_invert_R.gain.value = -1;
                    nodes.ms_side_level.gain.value = 0.5;
                    lastNodeInChain.connect(nodes.ms_splitter);
                    nodes.ms_splitter.connect(nodes.ms_mid_sum, 0); nodes.ms_splitter.connect(nodes.ms_mid_sum, 1);
                    nodes.ms_mid_sum.connect(nodes.ms_mid_level);
                    nodes.ms_splitter.connect(nodes.ms_side_sum, 0); nodes.ms_splitter.connect(nodes.ms_side_invert_R, 1);
                    nodes.ms_side_invert_R.connect(nodes.ms_side_sum);
                    nodes.ms_side_sum.connect(nodes.ms_side_level);
                    nodes.adaptiveWidthFilter.type = 'highpass';
                    nodes.adaptiveWidthFilter.frequency.value = state.isAdaptiveWidthEnabled ? state.adaptiveWidthFreq : 0;
                    nodes.ms_side_level.connect(nodes.adaptiveWidthFilter).connect(nodes.ms_side_gain);
                    nodes.ms_side_gain.gain.value = state.currentWideningFactor;
                    nodes.ms_decode_invert_Side.gain.value = -1;
                    nodes.ms_mid_level.connect(nodes.ms_decode_L_sum); nodes.ms_side_gain.connect(nodes.ms_decode_L_sum);
                    nodes.ms_mid_level.connect(nodes.ms_decode_R_sum); nodes.ms_side_gain.connect(nodes.ms_decode_invert_Side);
                    nodes.ms_decode_invert_Side.connect(nodes.ms_decode_R_sum);
                    nodes.ms_decode_L_sum.connect(nodes.ms_merger, 0, 0);
                    nodes.ms_decode_R_sum.connect(nodes.ms_merger, 0, 1);
                    nodes.hpfWiden.type = 'highpass';
                    nodes.hpfWiden.frequency.value = state.currentHpfHz;
                    positionalPathOutput = nodes.ms_merger.connect(nodes.hpfWiden);
                } else if (state.is3dEnabled) {
                    positionalPathOutput = lastNodeInChain.connect(nodes.panner3d);
                }

                const mainSignalOutput = positionalPathOutput;
                mainSignalOutput.connect(finalDestination);

                if (state.isReverbEnabled) {
                    try {
                        nodes.convolver.buffer = createSyntheticReverb(nodes.context, state.currentReverbLength, 2.5);
                        mainSignalOutput.connect(nodes.convolver);
                        nodes.wetGainReverb.gain.value = state.currentReverbMix;
                        nodes.convolver.connect(nodes.wetGainReverb).connect(finalDestination);
                    } catch (e) { console.error("Reverb creation failed:", e); }
                }

                nodes.stereoPanner.connect(nodes.analyser);
                nodes.analyser.fftSize = 256;
                nodes.analyserData = new Uint8Array(nodes.analyser.frequencyBinCount);
            }, 'reconnectGraph');
        }

        function getOrCreateNodes(media) {
            if (state.audioContextMap.has(media)) return state.audioContextMap.get(media);
            try {
                if (media.HAVE_CURRENT_DATA) return createAudioGraph(media);
                media.addEventListener('canplay', () => !state.audioContextMap.has(media) && createAudioGraph(media), { once: true });
            } catch (e) { console.error('[VSC] 오디오 그래프 생성 실패:', e); showWarningMessage('오디오 그래프 생성에 실패했습니다. 콘솔을 확인하세요.'); }
            return null;
        }

        function cleanupForMedia(media) {
            const nodes = state.audioContextMap.get(media);
            if (nodes) {
                safeExec(() => {
                    nodes.source.disconnect();
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

        return {
            getOrCreateNodes, setParamWithFade, reconnectGraph, createSyntheticReverb,
            updatePannerPosition: (m, x, y, z) => {
                const n = getOrCreateNodes(m);
                if (n?.panner3d) {
                    setParamWithFade(n.panner3d.positionX, x); setParamWithFade(n.panner3d.positionY, y); setParamWithFade(n.panner3d.positionZ, z);
                }
            },
            cleanupForMedia, ensureContextResumed,
        };
    })();

    function activateAudioContexts() {
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(media => stereoWideningManager.ensureContextResumed(media));
    }

    function applyAudioEffectsToMedia(mediaSet) {
        mediaSet.forEach(media => stereoWideningManager.reconnectGraph(media));
    }

    function disconnectAudioEffectsFromMedia(mediaSet) {
        mediaSet.forEach(media => stereoWideningManager.reconnectGraph(media));
    }

    function setWideningEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.isWideningEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-widen-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const slider = state.ui.shadowRoot?.getElementById('wideningSlider');
        if (slider) slider.disabled = !enabled;
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function set3dEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.is3dEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-3d-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const shadowRoot = state.ui.shadowRoot;
        if (shadowRoot) {
            ['pannerXSlider', 'pannerYSlider', 'pannerZSlider'].forEach(id => {
                const slider = shadowRoot.getElementById(id);
                if (slider) slider.disabled = !enabled;
            });
        }
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function setReverbEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.isReverbEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-reverb-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const shadowRoot = state.ui.shadowRoot;
        if (shadowRoot) {
            ['reverbSlider', 'reverbLengthSlider'].forEach(id => {
                const el = shadowRoot.getElementById(id);
                if (el) el.disabled = !enabled;
            });
        }
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function setEqEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.isEqEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-eq-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function setCompressorEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.isCompressorEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-compressor-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function setAdaptiveWidthEnabled(enabled) {
        if (enabled) activateAudioContexts();
        state.isAdaptiveWidthEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-adaptive-width-toggle');
        if (btn) btn.classList.toggle('active', enabled);
        const mediaToAffect = isMobile && state.currentlyVisibleMedia ? [state.currentlyVisibleMedia] : Array.from(state.activeMedia);
        mediaToAffect.forEach(stereoWideningManager.reconnectGraph);
    }

    function resetEffectStatesToDefault() {
        setWideningEnabled(CONFIG.DEFAULT_WIDENING_ENABLED);
        set3dEnabled(CONFIG.DEFAULT_3D_ENABLED);
        setReverbEnabled(CONFIG.DEFAULT_REVERB_ENABLED);
        setEqEnabled(CONFIG.DEFAULT_EQ_ENABLED);
        setCompressorEnabled(CONFIG.DEFAULT_COMPRESSOR_ENABLED);
        setAdaptiveWidthEnabled(CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED);
    }

    function setVideoFilterLevel(level) {
        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!filterManager.isInitialized() && level > 0) filterManager.init();
        const newLevel = parseInt(level, 10);
        state.currentVideoFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('videoFilterLevel', state.currentVideoFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentVideoFilterLevel);
        filterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => filterManager.setSharpenMatrix(newMatrix, root));
        state.activeMedia.forEach(media => { if (media.tagName === 'VIDEO') updateVideoFilterState(media); });
    }

    function setImageFilterLevel(level) {
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!imageFilterManager.isInitialized() && level > 0) imageFilterManager.init();
        const newLevel = parseInt(level, 10);
        state.currentImageFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('imageFilterLevel', state.currentImageFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentImageFilterLevel);
        imageFilterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => imageFilterManager.setSharpenMatrix(newMatrix, root));
        state.activeImages.forEach(image => updateImageFilterState(image));
    }

    const uiManager = (() => {
        const styleRules = [
            ':host { pointer-events: none; }',
            '* { pointer-events: auto; -webkit-tap-highlight-color: transparent; }',
            '#vsc-container { background: none; padding: clamp(6px, 1.2vmin, 10px); border-radius: clamp(8px, 1.5vmin, 12px); z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.3s; margin-top: 5px; }',
            '#vsc-container.touched { opacity: 1; }',
            '@media (hover: hover) { #vsc-container:hover { opacity: 1; } }',
            '.vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: clamp(3px, 0.8vmin, 5px); height: clamp(26px, 5.5vmin, 32px); width: clamp(28px, 6vmin, 34px); position: relative; }',
            '.vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(8px, 1.5vmin, 12px); gap: clamp(8px, 1.5vmin, 12px); width: auto; pointer-events: auto !important; }',
            '#vsc-stereo-controls .vsc-submenu { width: 450px; }',
            '#vsc-video-controls .vsc-submenu, #vsc-image-controls .vsc-submenu { width: 100px; }',
            '.vsc-control-group.submenu-visible .vsc-submenu { display: flex; }',
            '.vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(12px, 2vmin, 14px); }',
            '.vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }',
            '.vsc-btn-main { font-size: clamp(15px, 3vmin, 18px); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
            '.vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); }',
            '.slider-control { display: flex; flex-direction: column; gap: 5px; }',
            '.slider-control label { display: flex; justify-content: space-between; font-size: 13px; color: white; }',
            'input[type=range] { width: 100%; margin: 0; }',
            'input[type=range]:disabled, .vsc-select:disabled { opacity: 0.5; cursor: not-allowed; }',
            '.vsc-button-group { display: flex; gap: 8px; width: 100%; }',
            '.vsc-button-group > .vsc-btn { flex: 1; }',
            '.vsc-grid-container { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; }',
            '.vsc-grid-left, .vsc-grid-right { display: flex; flex-direction: column; gap: 10px; }',
            '.vsc-bottom-controls { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 8px; }',
            '.vsc-3d-sound-section { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid #555; padding-top: 10px; margin-top: 10px; }',
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
        let pannerXSlider, pannerYSlider, pannerZSlider, reverbSlider, reverbLengthSlider;
        let hideAllSubMenus = () => { };
        const startFadeSequence = () => {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
            if (container) { hideAllSubMenus(); container.classList.remove('touched'); container.style.opacity = '0.3'; }
        };
        const resetFadeTimer = () => {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
            if (container) { clearTimeout(fadeOutTimer); container.style.opacity = ''; container.classList.add('touched'); fadeOutTimer = setTimeout(startFadeSequence, 10000); }
        };
        function init() {
            if (inited) return;
            const shadowRoot = state.ui.shadowRoot;
            if (shadowRoot) { const c = document.createElement('div'); c.id = 'vsc-container'; shadowRoot.appendChild(c); inited = true; }
        }
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
                const select = document.createElement('select'); select.className = 'vsc-select'; if(id) select.id = id;
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
                span.id = `${id}Val`; span.textContent = `${value}${unit}`;
                labelEl.textContent = `${label}: `; labelEl.appendChild(span);
                const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step; slider.value = value;
                div.append(labelEl, slider);
                return { controlDiv: div, slider, valueSpan: span };
            };

            const videoOpts = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 5 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];
            const imageOpts = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 5 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];
            const { group: imageGroup, subMenu: imageSubMenu } = createControlGroup('vsc-image-controls', '🎨', '이미지 선명도');
            imageSubMenu.appendChild(createSelectControl('이미지 선명도', imageOpts, setImageFilterLevel, 'imageFilterSelect'));
            const { group: videoGroup, subMenu: videoSubMenu } = createControlGroup('vsc-video-controls', '✨', '영상 선명도');
            videoSubMenu.appendChild(createSelectControl('영상 선명도', videoOpts, setVideoFilterLevel, 'videoFilterSelect'));
            const { group: stereoGroup, subMenu: stereoSubMenu } = createControlGroup('vsc-stereo-controls', '🎧', '3D 사운드 & 리버브');

            const gridContainer = document.createElement('div'); gridContainer.className = 'vsc-grid-container';
            const gridLeft = document.createElement('div'); gridLeft.className = 'vsc-grid-left';
            const gridRight = document.createElement('div'); gridRight.className = 'vsc-grid-right';

            const btnGroup1 = document.createElement('div'); btnGroup1.className = 'vsc-button-group';
            const widenBtn = createButton('vsc-widen-toggle', '스테레오 확장 ON/OFF', '확장', 'vsc-btn');
            const panner3dBtn = createButton('vsc-3d-toggle', '3D 위치 음향 ON/OFF', '3D 위치', 'vsc-btn');
            widenBtn.onclick = () => setWideningEnabled(!state.isWideningEnabled);
            panner3dBtn.onclick = () => set3dEnabled(!state.is3dEnabled);
            btnGroup1.append(widenBtn, panner3dBtn);

            const wideningSlider = createSliderControl('스테레오 확장', 'wideningSlider', 0, 3, 0.1, state.currentWideningFactor, 'x');
            wideningSlider.slider.oninput = () => {
                const val = parseFloat(wideningSlider.slider.value);
                state.currentWideningFactor = val;
                wideningSlider.valueSpan.textContent = `${val.toFixed(1)}x`;
                Array.from(state.activeMedia).forEach(m => {
                    const nodes = stereoWideningManager.getOrCreateNodes(m);
                    if (nodes?.ms_side_gain) stereoWideningManager.setParamWithFade(nodes.ms_side_gain.gain, val);
                });
            };
            const panSlider = createSliderControl('Pan (좌우)', 'panSlider', -1, 1, 0.1, state.currentStereoPan, '');
            panSlider.slider.oninput = () => {
                const val = parseFloat(panSlider.slider.value);
                state.currentStereoPan = val;
                panSlider.valueSpan.textContent = val.toFixed(1);
                Array.from(state.activeMedia).forEach(m => {
                    const nodes = stereoWideningManager.getOrCreateNodes(m);
                    if (nodes) stereoWideningManager.setParamWithFade(nodes.stereoPanner.pan, val);
                });
            };
            const hpfSlider = createSliderControl('HPF', 'hpfSlider', 50, 500, 10, state.currentHpfHz, 'Hz');
            hpfSlider.slider.oninput = () => {
                const val = parseFloat(hpfSlider.slider.value);
                state.currentHpfHz = val;
                hpfSlider.valueSpan.textContent = `${val}Hz`;
                Array.from(state.activeMedia).forEach(media => {
                    const nodes = state.audioContextMap.get(media);
                    if (nodes?.hpfWiden) stereoWideningManager.setParamWithFade(nodes.hpfWiden.frequency, val);
                });
            };
            gridLeft.append(wideningSlider.controlDiv, panSlider.controlDiv, hpfSlider.controlDiv);

            const sound3dSection = document.createElement('div'); sound3dSection.className = 'vsc-3d-sound-section';
            pannerXSlider = createSliderControl('X (좌우)', 'pannerXSlider', -10, 10, 0.1, state.current3dPosX, '');
            pannerYSlider = createSliderControl('Y (상하)', 'pannerYSlider', -10, 10, 0.1, state.current3dPosY, '');
            pannerZSlider = createSliderControl('Z (앞뒤)', 'pannerZSlider', -10, 10, 0.1, state.current3dPosZ, '');

            const update3dPosition = () => {
                Array.from(state.activeMedia).forEach(m => stereoWideningManager.updatePannerPosition(m, state.current3dPosX, state.current3dPosY, state.current3dPosZ));
            };
            pannerXSlider.slider.oninput = () => { state.current3dPosX = parseFloat(pannerXSlider.slider.value); pannerXSlider.valueSpan.textContent = state.current3dPosX.toFixed(1); update3dPosition(); };
            pannerYSlider.slider.oninput = () => { state.current3dPosY = parseFloat(pannerYSlider.slider.value); pannerYSlider.valueSpan.textContent = state.current3dPosY.toFixed(1); update3dPosition(); };
            pannerZSlider.slider.oninput = () => { state.current3dPosZ = parseFloat(pannerZSlider.slider.value); pannerZSlider.valueSpan.textContent = state.current3dPosZ.toFixed(1); update3dPosition(); };

            const reverbBtn = createButton('vsc-reverb-toggle', '리버브 ON/OFF', '리버브', 'vsc-btn');
            reverbBtn.onclick = () => setReverbEnabled(!state.isReverbEnabled);

            reverbSlider = createSliderControl('잔향 혼합', 'reverbSlider', 0, 1, 0.05, state.currentReverbMix, '');
            reverbSlider.slider.oninput = () => {
                const val = parseFloat(reverbSlider.slider.value);
                state.currentReverbMix = val;
                reverbSlider.valueSpan.textContent = val.toFixed(2);
                Array.from(state.activeMedia).forEach(m => {
                    const nodes = stereoWideningManager.getOrCreateNodes(m);
                    if (nodes?.wetGainReverb) stereoWideningManager.setParamWithFade(nodes.wetGainReverb.gain, val);
                });
            };

            reverbLengthSlider = createSliderControl('잔향 길이', 'reverbLengthSlider', 0.1, 4, 0.1, state.currentReverbLength, 's');
            reverbLengthSlider.slider.oninput = debounce(() => {
                const val = parseFloat(reverbLengthSlider.slider.value);
                state.currentReverbLength = val;
                reverbLengthSlider.valueSpan.textContent = `${val.toFixed(1)}s`;
                Array.from(state.activeMedia).forEach(stereoWideningManager.reconnectGraph);
            }, 100);


            sound3dSection.append(pannerXSlider.controlDiv, pannerYSlider.controlDiv, pannerZSlider.controlDiv, reverbBtn, reverbSlider.controlDiv, reverbLengthSlider.controlDiv);
            gridLeft.append(sound3dSection);

            const btnGroup3 = document.createElement('div'); btnGroup3.className = 'vsc-button-group';
            const eqBtn = createButton('vsc-eq-toggle', '3-Band EQ ON/OFF', 'EQ', 'vsc-btn');
            const compBtn = createButton('vsc-compressor-toggle', 'Compressor ON/OFF', 'Comp', 'vsc-btn');
            const adaptiveWidthBtn = createButton('vsc-adaptive-width-toggle', '저역 폭 제어 ON/OFF', 'Bass Mono', 'vsc-btn');
            eqBtn.onclick = () => setEqEnabled(!state.isEqEnabled);
            compBtn.onclick = () => setCompressorEnabled(!state.isCompressorEnabled);
            adaptiveWidthBtn.onclick = () => setAdaptiveWidthEnabled(!state.isAdaptiveWidthEnabled);
            btnGroup3.append(eqBtn, compBtn, adaptiveWidthBtn);

            const eqLowSlider = createSliderControl('EQ 저음', 'eqLowSlider', -12, 12, 1, state.eqLowGain, 'dB');
            eqLowSlider.slider.oninput = () => {
                const val = parseFloat(eqLowSlider.slider.value); state.eqLowGain = val; eqLowSlider.valueSpan.textContent = `${val.toFixed(0)}dB`;
                Array.from(state.activeMedia).forEach(m => { const n = stereoWideningManager.getOrCreateNodes(m); if (n) stereoWideningManager.setParamWithFade(n.eqLow.gain, val); });
            };
            const eqMidSlider = createSliderControl('EQ 중음', 'eqMidSlider', -12, 12, 1, state.eqMidGain, 'dB');
            eqMidSlider.slider.oninput = () => {
                const val = parseFloat(eqMidSlider.slider.value); state.eqMidGain = val; eqMidSlider.valueSpan.textContent = `${val.toFixed(0)}dB`;
                Array.from(state.activeMedia).forEach(m => { const n = stereoWideningManager.getOrCreateNodes(m); if (n) stereoWideningManager.setParamWithFade(n.eqMid.gain, val); });
            };
            const eqHighSlider = createSliderControl('EQ 고음', 'eqHighSlider', -12, 12, 1, state.eqHighGain, 'dB');
            eqHighSlider.slider.oninput = () => {
                const val = parseFloat(eqHighSlider.slider.value); state.eqHighGain = val; eqHighSlider.valueSpan.textContent = `${val.toFixed(0)}dB`;
                Array.from(state.activeMedia).forEach(m => { const n = stereoWideningManager.getOrCreateNodes(m); if (n) stereoWideningManager.setParamWithFade(n.eqHigh.gain, val); });
            };
            const compThresholdSlider = createSliderControl('컴프레서 Threshold', 'compThresholdSlider', -60, 0, 1, state.compressorThreshold, 'dB');
            compThresholdSlider.slider.oninput = () => {
                const val = parseFloat(compThresholdSlider.slider.value); state.compressorThreshold = val; compThresholdSlider.valueSpan.textContent = `${val.toFixed(0)}dB`;
                Array.from(state.activeMedia).forEach(m => { const n = stereoWideningManager.getOrCreateNodes(m); if (n) stereoWideningManager.setParamWithFade(n.compressor.threshold, val); });
            };
            gridRight.append(btnGroup3, eqLowSlider.controlDiv, eqMidSlider.controlDiv, eqHighSlider.controlDiv, compThresholdSlider.controlDiv);

            const bottomControls = document.createElement('div'); bottomControls.className = 'vsc-bottom-controls';
            const resetBtn = createButton('vsc-stereo-reset', '기본값으로 초기화', '기본값', 'vsc-btn');
            bottomControls.append(resetBtn);

            resetBtn.onclick = () => {
                const defaults = {
                    widening: CONFIG.DEFAULT_WIDENING_FACTOR, hpf: CONFIG.EFFECTS_HPF_FREQUENCY, pan: CONFIG.DEFAULT_STEREO_PAN,
                    reverbMix: CONFIG.DEFAULT_REVERB_MIX, reverbLen: CONFIG.DEFAULT_REVERB_LENGTH,
                    posX: CONFIG.DEFAULT_3D_POS_X, posY: CONFIG.DEFAULT_3D_POS_Y, posZ: CONFIG.DEFAULT_3D_POS_Z,
                    eqLow: CONFIG.DEFAULT_EQ_LOW_GAIN, eqMid: CONFIG.DEFAULT_EQ_MID_GAIN, eqHigh: CONFIG.DEFAULT_EQ_HIGH_GAIN,
                    compThreshold: CONFIG.DEFAULT_COMPRESSOR_THRESHOLD,
                };
                Object.assign(state, {
                    currentWideningFactor: defaults.widening, currentHpfHz: defaults.hpf, currentStereoPan: defaults.pan,
                    currentReverbMix: defaults.reverbMix, currentReverbLength: defaults.reverbLen,
                    current3dPosX: defaults.posX, current3dPosY: defaults.posY, current3dPosZ: defaults.posZ,
                    eqLowGain: defaults.eqLow, eqMidGain: defaults.eqMid, eqHighGain: defaults.eqHigh, compressorThreshold: defaults.compThreshold,
                });
                wideningSlider.slider.value = defaults.widening; wideningSlider.valueSpan.textContent = `${defaults.widening.toFixed(1)}x`;
                hpfSlider.slider.value = defaults.hpf; hpfSlider.valueSpan.textContent = `${defaults.hpf}Hz`;
                panSlider.slider.value = defaults.pan; panSlider.valueSpan.textContent = defaults.pan.toFixed(1);
                reverbSlider.slider.value = defaults.reverbMix; reverbSlider.valueSpan.textContent = defaults.reverbMix.toFixed(2);
                reverbLengthSlider.slider.value = defaults.reverbLen; reverbLengthSlider.valueSpan.textContent = `${defaults.reverbLen.toFixed(1)}s`;
                pannerXSlider.slider.value = defaults.posX; pannerXSlider.valueSpan.textContent = defaults.posX.toFixed(1);
                pannerYSlider.slider.value = defaults.posY; pannerYSlider.valueSpan.textContent = defaults.posY.toFixed(1);
                pannerZSlider.slider.value = defaults.posZ; pannerZSlider.valueSpan.textContent = defaults.posZ.toFixed(1);
                eqLowSlider.slider.value = defaults.eqLow; eqLowSlider.valueSpan.textContent = `${defaults.eqLow}dB`;
                eqMidSlider.slider.value = defaults.eqMid; eqMidSlider.valueSpan.textContent = `${defaults.eqMid}dB`;
                eqHighSlider.slider.value = defaults.eqHigh; eqHighSlider.valueSpan.textContent = `${defaults.eqHigh}dB`;
                compThresholdSlider.slider.value = defaults.compThreshold; compThresholdSlider.valueSpan.textContent = `${defaults.compThreshold}dB`;

                resetEffectStatesToDefault();
            };

            gridContainer.append(gridLeft, gridRight);
            stereoSubMenu.append(btnGroup1, gridContainer, bottomControls);
            container.append(imageGroup, videoGroup, stereoGroup);

            const allGroups = [imageGroup, videoGroup, stereoGroup];
            hideAllSubMenus = () => allGroups.forEach(g => g.classList.remove('submenu-visible'));
            allGroups.forEach(g => g.querySelector('.vsc-btn-main').onclick = (e) => {
                e.stopPropagation();
                const isOpening = !g.classList.contains('submenu-visible');
                hideAllSubMenus();
                if (isOpening) g.classList.add('submenu-visible');
                resetFadeTimer();
            });

            const updateActiveButtons = () => {
                shadowRoot.querySelector('#imageFilterSelect').value = state.currentImageFilterLevel;
                shadowRoot.querySelector('#videoFilterSelect').value = state.currentVideoFilterLevel;
                setWideningEnabled(state.isWideningEnabled);
                set3dEnabled(state.is3dEnabled);
                setReverbEnabled(state.isReverbEnabled);
                setEqEnabled(state.isEqEnabled);
                setCompressorEnabled(state.isCompressorEnabled);
                setAdaptiveWidthEnabled(state.isAdaptiveWidthEnabled);
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
            hideSubMenus: hideAllSubMenus
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
        const DELAY_HISTORY_SIZE = 30;
        let delayHistory = [];
        const CHECK_INTERVAL = 500;
        const MIN_RATE = 0.95, MAX_RATE = 1.05, TOLERANCE = 150;
        let localIntersectionObserver;
        function isYouTubeLive() { if (!location.href.includes('youtube.com')) return false; try { const b = document.querySelector('.ytp-live-badge'); return b && b.offsetParent !== null && !/스트림이었음|was live/i.test(b.textContent); } catch { return false; } }
        function findVideo() { return state.activeMedia.size > 0 ? Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO') : null; }
        function calculateDelay(v) { if (!v || !v.buffered || v.buffered.length === 0) return null; try { const e = v.buffered.end(v.buffered.length - 1); return Math.max(0, (e - v.currentTime) * 1000); } catch { return null; } }
        function getPlaybackRate(avgDelay) { const t = getTargetDelay(), d = avgDelay - t; if (Math.abs(d) <= TOLERANCE) return 1.0; const n = 1.0 + (d / 12000); return Math.max(MIN_RATE, Math.min(n, MAX_RATE)); }
        function checkAndAdjust() {
            if (!video) video = findVideo();
            if (!video) return;
            const rawDelay = calculateDelay(video);
            if (rawDelay === null) return;
            delayHistory.push(rawDelay); if (delayHistory.length > DELAY_HISTORY_SIZE) delayHistory.shift();
            const avgDelay = delayHistory.reduce((a, b) => a + b, 0) / delayHistory.length;
            if (!avgDelay) return;
            if (location.href.includes('youtube.com') && !isYouTubeLive()) {
                if (video.playbackRate !== 1.0) safeExec(() => { video.playbackRate = 1.0; state.currentPlaybackRate = 1.0; });
                const infoEl = document.getElementById('vsc-delay-info'); if (infoEl) infoEl.remove();
                return;
            }
            const newRate = getPlaybackRate(avgDelay);
            if (Math.abs(video.playbackRate - newRate) > 0.001) safeExec(() => { video.playbackRate = newRate; state.currentPlaybackRate = newRate; });
            let infoEl = document.getElementById('vsc-delay-info');
            if (delayHistory.length >= 5) {
                if (!infoEl) {
                    infoEl = document.createElement('div'); infoEl.id = 'vsc-delay-info';
                    Object.assign(infoEl.style, { position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'none' });
                    document.body.appendChild(infoEl);
                }
                infoEl.textContent = `딜레이: ${avgDelay.toFixed(0)}ms / 현재: ${rawDelay.toFixed(0)}ms / 배속: ${state.currentPlaybackRate.toFixed(3)}x`;
            }
        }
        function start() {
            if (!CONFIG.LIVE_STREAM_URLS.some(d => location.href.includes(d)) || (location.href.includes('youtube.com') && !isYouTubeLive()) || state.delayCheckInterval) return;
            delayHistory = []; video = findVideo(); if (video) state.currentPlaybackRate = video.playbackRate;
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
            delayHistory = [];
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
    function updateVideoFilterState(video) { if (!filterManager.isInitialized()) return; video.classList.toggle('vsc-video-filter-active', video.dataset.isVisible !== 'false' && state.currentVideoFilterLevel > 0); }
    function updateImageFilterState(image) { if (!imageFilterManager.isInitialized()) return; image.classList.toggle('vsc-image-filter-active', image.dataset.isVisible !== 'false' && state.currentImageFilterLevel > 0); }
    function updateActiveSpeedButton(rate) { if (!speedButtonsContainer) return; speedButtonsContainer.querySelectorAll('button').forEach(b => { const br = parseFloat(b.dataset.speed); b.style.boxShadow = Math.abs(br - rate) < 0.01 ? '0 0 5px #3498db, 0 0 10px #3498db inset' : 'none'; }); }

    const mediaEventHandlers = {
        play: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); },
        pause: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).every(med => med.paused)) mediaSessionManager.clearSession(); },
        ratechange: e => { updateActiveSpeedButton(e.target.playbackRate); },
    };

    function injectFiltersIntoRoot(element, manager) {
        const root = element.getRootNode();
        const attr = `data-vsc-filters-injected-${manager === filterManager ? 'video' : 'image'}`;
        if (root instanceof ShadowRoot && !root.host.hasAttribute(attr)) {
            const svgNode = manager.getSvgNode();
            if (svgNode) {
                root.appendChild(svgNode.cloneNode(true)); root.host.setAttribute(attr, 'true');
                const level = (element.tagName === 'VIDEO') ? state.currentVideoFilterLevel : state.currentImageFilterLevel;
                manager.setSharpenMatrix(calculateSharpenMatrix(level), root);
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
        stereoWideningManager.cleanupForMedia(media);
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
                if (mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
                    scheduleIdleTask(() => scanAndApply());
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
                        // [FIX] Restore logic to disconnect old and apply to new visible media on mobile.
                        if (state.currentlyVisibleMedia) {
                           stereoWideningManager.reconnectGraph(state.currentlyVisibleMedia);
                        }
                        state.currentlyVisibleMedia = newVisibleMedia;
                        if (state.currentlyVisibleMedia) {
                           stereoWideningManager.reconnectGraph(state.currentlyVisibleMedia);
                        }
                    }
                }
            }, {
                root: null,
                rootMargin: '0px',
                threshold: Array.from({ length: 101 }, (_, i) => i / 100)
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
            state.activeMedia.forEach(m => stereoWideningManager.cleanupForMedia(m));
            cleanup();
            globalUIManager.cleanupGlobalListeners();
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

        setVideoFilterLevel(settingsManager.get('videoFilterLevel'));
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
            return;
        }
        warningEl = document.createElement('div');
        warningEl.id = 'vsc-warning-bar';
        const messageSpan = document.createElement('span');
        const closeBtn = document.createElement('button');
        let hideTimeout;
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
        const removeWarning = () => { clearTimeout(hideTimeout); warningEl.style.opacity = '0'; setTimeout(() => warningEl.remove(), 500); };
        closeBtn.onclick = removeWarning;
        warningEl.append(messageSpan, closeBtn);
        document.body.appendChild(warningEl);
        setTimeout(() => (warningEl.style.opacity = '1'), 100);
        hideTimeout = setTimeout(removeWarning, CONFIG.UI_WARN_TIMEOUT);
    }

    const globalUIManager = (() => {
        let isDragging = false, wasDragged = false;
        let startPos = { x: 0, y: 0 }, translatePos = { x: 0, y: 0 }, startRect = null;
        let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null;

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
                position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%)',
                zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '5px',
                opacity: '1', transition: 'opacity 0.3s', WebkitTapHighlightColor: 'transparent'
            });

            const mainControlsWrapper = document.createElement('div');
            mainControlsWrapper.id = 'vsc-main-controls-wrapper';
            Object.assign(mainControlsWrapper.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0px' });

            triggerElement = document.createElement('div');
            triggerElement.id = UI_SELECTORS.TRIGGER;
            triggerElement.textContent = '⚡';
            Object.assign(triggerElement.style, {
                width: 'clamp(32px, 7vmin, 44px)', height: 'clamp(32px, 7vmin, 44px)', background: 'rgba(0,0,0,0.5)',
                color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'clamp(20px, 4vmin, 26px)', cursor: 'pointer', userSelect: 'none'
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
            const onDragStart = (e) => {
                const trueTarget = e.composedPath()[0];
                if (['BUTTON', 'SELECT', 'INPUT'].includes(trueTarget.tagName.toUpperCase())) return;
                isDragging = true; wasDragged = false;
                const pos = e.touches ? e.touches[0] : e;
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
                const dX = pos.clientX - startPos.x, dY = pos.clientY - startPos.y;
                let nL = startRect.left + dX, nT = startRect.top + dY;
                const pW = window.innerWidth, pH = window.innerHeight;
                nL = Math.max(0, Math.min(nL, pW - startRect.width));
                nT = Math.max(0, Math.min(nT, pH - startRect.height));
                const fX = translatePos.x + (nL - startRect.left), fY = translatePos.y + (nT - startRect.top);
                uiContainer.style.transform = `translateY(-50%) translate(${fX}px, ${fY}px)`;
                if (!wasDragged && (Math.abs(dX) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(dY) > CONFIG.UI_DRAG_THRESHOLD)) wasDragged = true;
            };
            const onDragEnd = () => {
                if (!isDragging) return;
                const transform = uiContainer.style.transform;
                const matches = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
                if (matches) { translatePos.x = parseFloat(matches[1]); translatePos.y = parseFloat(matches[2]); }
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

        function init() {
            createUIElements();
            uiContainer.addEventListener('click', (e) => {
                if (wasDragged) { e.stopPropagation(); return; }
                if (e.target.id === UI_SELECTORS.TRIGGER) handleTriggerClick();
            });
            attachDragAndDrop();
            attachGlobalListeners();
        }

        return { init, cleanupGlobalListeners };
    })();

    function initializeGlobalUI() {
        if (document.getElementById('vsc-global-container')) return;
        const initialMediaCheck = () => {
            if (findAllMedia().length > 0 || findAllImages().length > 0) {
                if (!document.getElementById('vsc-global-container')) {
                    globalUIManager.init();
                    hookSpaNavigation();
                }
                if (mediaObserver) mediaObserver.disconnect();
            }
        };
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
