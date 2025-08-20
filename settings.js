// ==UserScript==
// @name         Video_Image_Control
// @namespace    https://com/
// @version      38.1
// @description  UI 변경 - 콤보 상자. 드래그 전용토글 도입 / 필터 동적 계산식으로 변경 / 기타 로직 개선
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =================================================================================
    // 1. 설정 및 상수 (Configuration and Constants)
    // =================================================================================

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 15 : 10,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 10 : 5,
        DEFAULT_AUDIO_PRESET: 'movie',
        DEBUG: false,
        DEBOUNCE_DELAY: 350,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 350,
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.05, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.6', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 105 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: ['www.youtube.com', 'm.youtube.com'],
        AUDIO_PRESETS: { off: { gain: 1, eq: [] }, speech: { gain: 1.1, eq: [{ freq: 100, gain: -2 }, { freq: 250, gain: 1 }, { freq: 500, gain: 3 }, { freq: 1000, gain: 4 }, { freq: 2000, gain: 4.5 }, { freq: 4000, gain: 2 }, { freq: 8000, gain: -1 }] }, movie: { gain: 1.25, eq: [{ freq: 80, gain: 6 }, { freq: 200, gain: 4 }, { freq: 500, gain: 1 }, { freq: 1000, gain: 2 }, { freq: 3000, gain: 3.5 }, { freq: 6000, gain: 5 }, { freq: 10000, gain: 4 }] }, music: { gain: 1.1, eq: [{ freq: 60, gain: 5 }, { freq: 150, gain: 3 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 0.5 }, { freq: 3000, gain: 2.5 }, { freq: 6000, gain: 4 }, { freq: 12000, gain: 3.5 }] } },
        MAX_EQ_BANDS: 7,
    };

    // =================================================================================
    // 2. 전역 상태 관리 (Global State)
    // =================================================================================

    const state = {
        activeMedia: new Set(),
        processedMedia: new WeakSet(),
        activeImages: new Set(),
        processedImages: new WeakSet(),
        mediaListenerMap: new WeakMap(),
        isUiVisible: false,
        isMinimized: true,
        isDragSeekEnabled: false,
        currentVideoFilterLevel: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL || 0,
        currentImageFilterLevel: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL || 0,
        currentAudioMode: CONFIG.DEFAULT_AUDIO_PRESET || 'off',
        ui: { shadowRoot: null },
    };

    // =================================================================================
    // 3. 유틸리티 함수 (Utility Functions)
    // =================================================================================

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };

    function calculateSharpenMatrix(level) {
        const parsedLevel = parseInt(level, 10);
        if (isNaN(parsedLevel) || parsedLevel === 0) return '0 0 0 0 1 0 0 0 0';
        const intensity = 1.0 + (parsedLevel - 1) * (5.0 / 14);
        const off = (1 - intensity) / 4;
        return `0 ${off} 0 ${off} ${intensity} ${off} 0 ${off} 0`;
    }

    // =================================================================================
    // 4. 스크립트 실행 전 확인 (Pre-flight Checks)
    // =================================================================================

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;

    function isExcluded() {
        const url = location.href.toLowerCase();
        const hostname = location.hostname.toLowerCase();
        if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true;
        return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path));
    }

    if (isExcluded()) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    (function openAllShadowRoots() {
        if (window._hasHackAttachShadow_) return;
        safeExec(() => {
            window._shadowDomList_ = window._shadowDomList_ || [];
            const originalAttachShadow = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function (options) {
                const modifiedOptions = { ...options, mode: 'open' };
                const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]);
                window._shadowDomList_.push(new WeakRef(shadowRoot));
                document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } }));
                return shadowRoot;
            };
            window._hasHackAttachShadow_ = true;
        }, 'openAllShadowRoots');
    })();

    // =================================================================================
    // 5. 핵심 모듈 (Core Modules)
    // =================================================================================

    class SvgFilterManager {
        #isInitialized = false;
        #styleElement = null;
        #svgNode = null;
        #options;
        constructor(options) { this.#options = options; }
        getSvgNode() { return this.#svgNode; }
        isInitialized() { return this.#isInitialized; }
        toggleStyleSheet(enable) { if (this.#styleElement) this.#styleElement.media = enable ? 'all' : 'none'; }
        init() {
            if (this.#isInitialized) return;
            safeExec(() => {
                const { svgNode, styleElement } = this.#createElements();
                this.#svgNode = svgNode;
                this.#styleElement = styleElement;
                document.body.appendChild(this.#svgNode);
                document.head.appendChild(this.#styleElement);
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
            const createSvgElement = (tag, attr) => {
                const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
                for (const k in attr) el.setAttribute(k, attr[k]);
                return el;
            };
            const { settings, svgId, styleId, matrixId, className } = this.#options;
            const svg = createSvgElement('svg', { id: svgId, style: 'display:none; position:absolute; width:0; height:0;' });
            const soft = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_soft` });
            soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION }));
            const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID });
            sharp.appendChild(createSvgElement('feConvolveMatrix', { id: matrixId, order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', mode: 'multiply' }));
            const gamma = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_gamma` });
            const gammaTransfer = createSvgElement('feComponentTransfer');
            ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })));
            gamma.appendChild(gammaTransfer);
            const linear = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_linear` });
            const linearTransfer = createSvgElement('feComponentTransfer');
            const intercept = settings.SHADOWS_VALUE / 200;
            const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100);
            ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() })));
            linear.appendChild(linearTransfer);
            svg.append(soft, sharp, gamma, linear);
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .${className} { filter: saturate(${settings.SATURATION_VALUE}%) url(#${gamma.id}) url(#${soft.id}) url(#${sharp.id}) url(#${linear.id}) !important; }
                .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }
            `;
            return { svgNode: svg, styleElement: style };
        }
    }

    const filterManager = new SvgFilterManager({
        settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS,
        svgId: 'vsc-video-svg-filters',
        styleId: 'vsc-video-styles',
        matrixId: 'vsc-dynamic-convolve-matrix',
        className: 'vsc-video-filter-active',
    });

    const imageFilterManager = new SvgFilterManager({
        settings: CONFIG.IMAGE_FILTER_SETTINGS,
        svgId: 'vsc-image-svg-filters',
        styleId: 'vsc-image-styles',
        matrixId: 'vsc-image-convolve-matrix',
        className: 'vsc-image-filter-active',
    });

    function setVideoFilterLevel(level) {
        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname) || !filterManager.isInitialized()) return;
        const newLevel = parseInt(level, 10);
        state.currentVideoFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        const newMatrix = calculateSharpenMatrix(state.currentVideoFilterLevel);
        filterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => filterManager.setSharpenMatrix(newMatrix, root));
        state.activeMedia.forEach(media => {
            if (media.tagName === 'VIDEO') updateVideoFilterState(media);
        });
    }

    function setImageFilterLevel(level) {
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname) || !imageFilterManager.isInitialized()) return;
        const newLevel = parseInt(level, 10);
        state.currentImageFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        const newMatrix = calculateSharpenMatrix(state.currentImageFilterLevel);
        imageFilterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => imageFilterManager.setSharpenMatrix(newMatrix, root));
        state.activeImages.forEach(image => updateImageFilterState(image));
    }

    const audioManager = (() => { const isAudioDisabledForSite = CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname); let ctx = null; let masterGain; const eqFilters = []; const sourceMap = new WeakMap(); function ensureContext() { if (ctx || isAudioDisabledForSite) return; try { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); masterGain = ctx.createGain(); for (let i = 0; i < CONFIG.MAX_EQ_BANDS; i++) { const eqFilter = ctx.createBiquadFilter(); eqFilter.type = 'peaking'; eqFilters.push(eqFilter); if (i > 0) { eqFilters[i - 1].connect(eqFilter); } } if (eqFilters.length > 0) { eqFilters[eqFilters.length - 1].connect(masterGain); } masterGain.connect(ctx.destination); } catch (e) { if (CONFIG.DEBUG) console.error("[VSC] AudioContext creation failed:", e); ctx = null; } } function connectMedia(media) { if (!ctx) return; if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); } let rec = sourceMap.get(media); if (!rec) { const source = ctx.createMediaElementSource(media); rec = { source }; sourceMap.set(media, rec); } try { rec.source.disconnect(); } catch (e) {} const firstNode = eqFilters.length > 0 ? eqFilters[0] : masterGain; rec.source.connect(firstNode); applyAudioPresetToNodes(); } function applyAudioPresetToNodes() { if (!ctx) return; const preset = CONFIG.AUDIO_PRESETS[state.currentAudioMode] || CONFIG.AUDIO_PRESETS.off; const now = ctx.currentTime; const rampTime = 0.05; masterGain.gain.cancelScheduledValues(now); masterGain.gain.linearRampToValueAtTime(preset.gain, now + rampTime); for (let i = 0; i < eqFilters.length; i++) { const band = preset.eq[i]; const filter = eqFilters[i]; filter.gain.cancelScheduledValues(now); filter.frequency.cancelScheduledValues(now); filter.Q.cancelScheduledValues(now); if (band) { filter.frequency.setValueAtTime(band.freq, now); filter.gain.linearRampToValueAtTime(band.gain, now + rampTime); filter.Q.setValueAtTime(1.41, now); } else { filter.frequency.setValueAtTime(1000, now); filter.Q.setValueAtTime(1.41, now); filter.gain.linearRampToValueAtTime(0, now + rampTime); } } } function processMedia(media) { if (isAudioDisabledForSite) return; media.addEventListener('play', () => { ensureContext(); if (!ctx) return; if (!sourceMap.has(media)) { connectMedia(media); } else { resumeContext(); } }); } function cleanupMedia(media) { if (isAudioDisabledForSite || !ctx) return; const rec = sourceMap.get(media); if (!rec) return; try { rec.source.disconnect(); } catch (err) { if (CONFIG.DEBUG) console.warn("audioManager.cleanupMedia error:", err); } } function setAudioMode(mode) { if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return; state.currentAudioMode = mode; applyAudioPresetToNodes(); } return { processMedia, cleanupMedia, setAudioMode, getAudioMode: () => state.currentAudioMode }; })();
    const uiManager = (() => { let host; function init() { if (host) return; host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX }); state.ui.shadowRoot = host.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = `:host { pointer-events: none; } * { pointer-events: auto; } #vsc-container { position: fixed; top: 50%; right: 10px; background: transparent; padding: 6px; border-radius: 8px; z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.5s ease, background 0.2s; transform: translateY(-50%); } #vsc-container.touched, #vsc-container.menu-visible { opacity: 1; } #vsc-container.menu-visible { background: rgba(0,0,0,0.0); } @media (hover: hover) and (pointer: fine) { #vsc-container:hover { opacity: 1; } } #vsc-container.minimized { width: 30px; } #vsc-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; } #vsc-container .vsc-collapsible { display: flex; flex-direction: column; align-items: flex-end; width: auto; margin-top: 4px; gap: 4px; } #vsc-container.minimized .vsc-collapsible { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; } .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: 4px; height: 28px; width: 30px; position: relative; } .vsc-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 0; margin-right: 5px; background: rgba(0,0,0,0.0); border-radius: 4px; padding: 2px; align-items: center; } .vsc-control-group.submenu-visible .vsc-submenu { display: flex; } .vsc-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; font-size:12px; } .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; } .vsc-submenu .vsc-btn { min-width: 24px; font-size: 14px; padding: 2px 4px; margin: 0 2px; } .vsc-btn-main { font-size: 16px; padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; } .vsc-select { background: #444; color: white; border: 1px solid #666; border-radius: 4px; padding: 4px 6px; font-size: 13px; } .vsc-btn.toggle { margin-top: 4px; cursor: grab; } #vsc-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }`; state.ui.shadowRoot.appendChild(style); (document.body || document.documentElement).appendChild(host); } return { init: () => safeExec(init, 'uiManager.init'), moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } }; })();
    const speedSlider = (() => {
    let inited = false, fadeOutTimer;

    const createButton = (id, title, text, className = 'vsc-btn') => {
        const btn = document.createElement('button');
        if (id) btn.id = id;
        btn.className = className;
        btn.title = title;
        btn.textContent = text;
        return btn;
    };

    function init() {
        if (inited) return;
        const shadowRoot = state.ui.shadowRoot;
        if (!shadowRoot) return;

        const container = document.createElement('div');
        container.id = 'vsc-container';

        const createFilterControl = (id, labelText, mainIcon, changeHandler) => {
            const group = document.createElement('div');
            group.id = id;
            group.className = 'vsc-control-group';
            const mainBtn = createButton(null, labelText, mainIcon, 'vsc-btn vsc-btn-main');
            const subMenu = document.createElement('div');
            subMenu.className = 'vsc-submenu';
            const select = document.createElement('select');
            select.className = 'vsc-select';
            const titleOption = document.createElement('option');
            titleOption.value = "";
            titleOption.textContent = labelText;
            titleOption.disabled = true;
            select.appendChild(titleOption);
            const offOption = document.createElement('option');
            offOption.value = '0';
            offOption.textContent = '꺼짐';
            select.appendChild(offOption);
            for (let i = 1; i <= 15; i++) {
                const option = document.createElement('option');
                option.value = i;
                option.textContent = `${i}단계`;
                select.appendChild(option);
            }
            select.addEventListener('change', e => {
                changeHandler(e.target.value);
                setTimeout(() => group.classList.remove('submenu-visible'), 200);
            });
            subMenu.appendChild(select);
            group.append(mainBtn, subMenu);
            return group;
        };

        const videoControlGroup = createFilterControl('vsc-video-controls', '영상 선명도', '🌞', setVideoFilterLevel);
        const imageControlGroup = createFilterControl('vsc-image-controls', '이미지 선명도', '🎨', setImageFilterLevel);

        const audioControlGroup = document.createElement('div');
        audioControlGroup.id = 'vsc-audio-controls';
        audioControlGroup.className = 'vsc-control-group';
        const audioBtnMain = createButton('vsc-audio-btn', '오디오 프리셋', '🎧', 'vsc-btn vsc-btn-main');
        const audioSubMenu = document.createElement('div');
        audioSubMenu.className = 'vsc-submenu';
        const audioModes = { '🎙️': 'speech', '🎬': 'movie', '🎵': 'music', '🚫': 'off' };
        Object.entries(audioModes).forEach(([text, mode]) => {
            const btn = createButton(null, `오디오: ${mode}`, text);
            btn.dataset.mode = mode;
            audioSubMenu.appendChild(btn);
        });
        audioControlGroup.append(audioBtnMain, audioSubMenu);

        const collapsibleWrapper = document.createElement('div');
        collapsibleWrapper.className = 'vsc-collapsible';

        const speedControlContainer = document.createElement('div');
        speedControlContainer.id = 'vsc-speed-controls';
        speedControlContainer.style.display = 'flex';
        speedControlContainer.style.alignItems = 'center';
        speedControlContainer.style.gap = '4px';

        const speedSelect = document.createElement('select');
        speedSelect.className = 'vsc-select';
        const speeds = [0.2, 1, 2, 3, 4];
        speeds.forEach(speed => {
            const option = document.createElement('option');
            option.value = speed;
            option.textContent = `${speed}x`;
            if (speed === 1.0) option.selected = true;
            speedSelect.appendChild(option);
        });
        speedSelect.addEventListener('change', e => {
            const newSpeed = parseFloat(e.target.value);
            for (const media of state.activeMedia) {
                if (media.playbackRate !== newSpeed) safeExec(() => { media.playbackRate = newSpeed; });
            }
        });

        const dragToggleBtn = createButton('vsc-drag-toggle', '', '', 'vsc-btn');
        dragToggleBtn.style.width = '30px';
        dragToggleBtn.style.height = '28px';

        const updateDragToggleBtn = () => {
            if (state.isDragSeekEnabled) {
                dragToggleBtn.textContent = '✋';
                dragToggleBtn.title = '드래그 탐색 끄기';
                dragToggleBtn.classList.add('active');
            } else {
                dragToggleBtn.textContent = '🚫';
                dragToggleBtn.title = '드래그 탐색 켜기';
                dragToggleBtn.classList.remove('active');
            }
        };

        dragToggleBtn.addEventListener('click', () => {
            state.isDragSeekEnabled = !state.isDragSeekEnabled;
            updateDragToggleBtn();
        });

        updateDragToggleBtn(); // 초기 상태 설정

        speedControlContainer.append(speedSelect, dragToggleBtn);
        collapsibleWrapper.appendChild(speedControlContainer);

        const toggleBtn = createButton('vsc-toggle-btn', '컨트롤러 접기/펴기', '', 'vsc-btn toggle');

        container.append(imageControlGroup, videoControlGroup, audioControlGroup, collapsibleWrapper, toggleBtn);
        shadowRoot.appendChild(container);

        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) videoControlGroup.style.display = 'none';
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) imageControlGroup.style.display = 'none';
        if (CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname)) audioControlGroup.style.display = 'none';

        const controlGroups = [videoControlGroup, imageControlGroup, audioControlGroup];
        const hideAllSubMenus = () => {
            controlGroups.forEach(group => group.classList.remove('submenu-visible'));
            container.classList.remove('menu-visible');
        };

        const toggleSubMenu = (groupToShow) => {
            const isOpening = !groupToShow.classList.contains('submenu-visible');
            hideAllSubMenus();
            if (isOpening) {
                groupToShow.classList.add('submenu-visible');
                container.classList.add('menu-visible');
            }
        };

        videoControlGroup.querySelector('.vsc-btn-main').addEventListener('click', () => toggleSubMenu(videoControlGroup));
        imageControlGroup.querySelector('.vsc-btn-main').addEventListener('click', () => toggleSubMenu(imageControlGroup));
        audioBtnMain.addEventListener('click', () => toggleSubMenu(audioControlGroup));

        const updateActiveButtons = () => {
            const videoSelect = shadowRoot.querySelector('#vsc-video-controls select');
            if (videoSelect) {
                videoSelect.value = state.currentVideoFilterLevel;
                if (!videoSelect.querySelector(`[value="${videoSelect.value}"]`)) videoSelect.selectedIndex = 1; // '꺼짐'으로
            }

            const imageSelect = shadowRoot.querySelector('#vsc-image-controls select');
            if(imageSelect) {
                imageSelect.value = state.currentImageFilterLevel;
                if (!imageSelect.querySelector(`[value="${imageSelect.value}"]`)) imageSelect.selectedIndex = 1; // '꺼짐'으로
            }

            const currentAudio = state.currentAudioMode;
            audioSubMenu.querySelectorAll('.vsc-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
            audioBtnMain.classList.toggle('active', currentAudio !== 'off');
        };

        audioSubMenu.addEventListener('click', (e) => {
            if (e.target.matches('.vsc-btn')) {
                audioManager.setAudioMode(e.target.dataset.mode);
                hideAllSubMenus();
                updateActiveButtons();
            }
        });

        const updateAppearance = () => {
            if (!container) return;
            container.classList.toggle('minimized', state.isMinimized);
            toggleBtn.textContent = state.isMinimized ? '🔻' : '🔺';
            if (state.isMinimized) hideAllSubMenus();
        };

        const dragState = { isDragging: false, hasMoved: false, startX: 0, startY: 0, initialTop: 0, initialRight: 0, startEvent: null };
        const DRAG_THRESHOLD = 5;
        toggleBtn.addEventListener('click', (e) => { if (dragState.hasMoved) { e.preventDefault(); e.stopPropagation(); return; } state.isMinimized = !state.isMinimized; updateAppearance(); });
        const onDragStart = (e) => { if (e.target !== toggleBtn) return; e.preventDefault(); e.stopPropagation(); dragState.isDragging = true; dragState.hasMoved = false; dragState.startEvent = e.type; const pos = e.touches ? e.touches[0] : e; dragState.startX = pos.clientX; dragState.startY = pos.clientY; const rect = container.getBoundingClientRect(); dragState.initialTop = rect.top; dragState.initialRight = window.innerWidth - rect.right; toggleBtn.style.cursor = 'grabbing'; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', onDragMove, { passive: false }); document.addEventListener('mouseup', onDragEnd, { passive: false }); document.addEventListener('touchmove', onDragMove, { passive: false }); document.addEventListener('touchend', onDragEnd, { passive: false }); };
        const onDragMove = (e) => { if (!dragState.isDragging) return; const pos = e.touches ? e.touches[0] : e; const totalDeltaX = pos.clientX - dragState.startX; const totalDeltaY = pos.clientY - dragState.startY; if (!dragState.hasMoved && (Math.abs(totalDeltaX) > DRAG_THRESHOLD || Math.abs(totalDeltaY) > DRAG_THRESHOLD)) { dragState.hasMoved = true; container.style.transform = 'none'; } if (dragState.hasMoved) { e.preventDefault(); let newTop = dragState.initialTop + totalDeltaY; let newRight = dragState.initialRight - totalDeltaX; const containerRect = container.getBoundingClientRect(); newTop = Math.max(0, Math.min(window.innerHeight - containerRect.height, newTop)); newRight = Math.max(0, Math.min(window.innerWidth - containerRect.width, newRight)); container.style.top = `${newTop}px`; container.style.right = `${newRight}px`; container.style.left = 'auto'; container.style.bottom = 'auto'; } };
        const onDragEnd = () => { if (!dragState.isDragging) return; if (dragState.startEvent === 'touchstart' && !dragState.hasMoved) { state.isMinimized = !state.isMinimized; updateAppearance(); } dragState.isDragging = false; toggleBtn.style.cursor = 'grab'; document.body.style.userSelect = ''; document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd); document.removeEventListener('touchmove', onDragMove); document.removeEventListener('touchend', onDragEnd); };
        toggleBtn.addEventListener('mousedown', onDragStart);
        toggleBtn.addEventListener('touchstart', onDragStart, { passive: false });

        const endInteraction = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => container.classList.remove('touched'), 3000); };
        const onTouchEnd = () => { endInteraction(); document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd); };
        container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onTouchEnd); document.addEventListener('touchcancel', onTouchEnd); }, { passive: true });

        inited = true;
        updateAppearance();
        updateActiveButtons();
    }

    return {
        init: () => safeExec(init, 'speedSlider.init'),
        show: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) el.style.display = 'flex'; },
        hide: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) el.style.display = 'none'; },
    };
})();
    const dragBar = (() => { let display, inited = false; let dragState = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false; function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; } const getEventPosition = e => e.touches ? e.touches[0] : e; const onStart = e => safeExec(() => { if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return; const video = findAssociatedVideo(e.target); if (!video || !state.isDragSeekEnabled || e.composedPath().some(el => el.id === 'vsc-container')) return; const pos = getEventPosition(e); Object.assign(dragState, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'drag.start'); const onMove = e => { if (!dragState.dragging) return; if (e.touches && e.touches.length > 1) return onEnd(); const pos = getEventPosition(e); dragState.currentX = pos.clientX; dragState.currentY = pos.clientY; if (!dragState.directionConfirmed) { const dX = Math.abs(dragState.currentX - dragState.startX); const dY = Math.abs(dragState.currentY - dragState.startY); if (dX > dY + 5) dragState.directionConfirmed = true; else if (dY > dX + 5) return onEnd(); } if (dragState.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); dragState.accX += dragState.currentX - dragState.startX; dragState.startX = dragState.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (dragState.dragging) showDisplay(dragState.accX); rafScheduled = false; }); } } }; const onEnd = () => { if (!dragState.dragging) return; if (dragState.directionConfirmed) applySeek(); Object.assign(dragState, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); }; const applySeek = () => { const delta = Math.round(dragState.accX / 2); if (Math.abs(delta) < 1) return; for (const media of state.activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); }; const showDisplay = pixels => { const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds; if (!display) { const root = state.ui.shadowRoot; if(!root) return; display = document.createElement('div'); display.id = 'vsc-time-display'; root.appendChild(display); } const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mins}:${secs}`; display.style.display = 'block'; display.style.opacity = '1'; }; const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } }; return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } }; })();
    const mediaSessionManager = (() => { const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); }; const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; }; const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; }; const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} }; return { setSession: m => { if (!('mediaSession' in navigator)) return; safeExec(() => { const { title, artist } = getMeta(); navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' }); setAction('play', () => m.play()); setAction('pause', () => m.pause()); setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); }); setAction('seekforward', () => { m.currentTime += getSeekTime(m); }); setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }); }, 'mediaSession.set'); }, clearSession: () => { if (!('mediaSession' in navigator) || state.activeMedia.size > 0) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); } }; })();

    // =================================================================================
    // 6. 미디어 처리 및 이벤트 핸들링 (Media Handling)
    // =================================================================================

    let intersectionObserver = null;

    function findAllMedia(doc = document) { const elems = []; safeExec(() => { elems.push(...doc.querySelectorAll('video, audio')); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...root.querySelectorAll('video, audio')); }); doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) { /* ignored */ } }); }); return [...new Set(elems)]; }
    function findAllImages(doc = document) { const elems = []; safeExec(() => { const size = CONFIG.IMAGE_MIN_SIZE; const filterFn = img => img.naturalWidth > size && img.naturalHeight > size; elems.push(...Array.from(doc.querySelectorAll('img')).filter(filterFn)); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...Array.from(root.querySelectorAll('img')).filter(filterFn)); }); }); return [...new Set(elems)]; }

    function updateVideoFilterState(video) {
        if (!filterManager.isInitialized()) return;
        const isVisible = video.dataset.isVisible !== 'false';
        const filterLevel = state.currentVideoFilterLevel;
        const shouldHaveFilter = isVisible && filterLevel > 0;
        video.classList.toggle('vsc-video-filter-active', shouldHaveFilter);
    }

    function updateImageFilterState(image) {
        if (!imageFilterManager.isInitialized()) return;
        const isVisible = image.dataset.isVisible !== 'false';
        const filterLevel = state.currentImageFilterLevel;
        const shouldHaveFilter = isVisible && filterLevel > 0;
        image.classList.toggle('vsc-image-filter-active', shouldHaveFilter);
    }

    const mediaEventHandlers = {
        play: e => { const m = e.target; audioManager.resumeContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); },
        pause: e => { const m = e.target; audioManager.suspendContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); },
    };

    function injectFiltersIntoRoot(element, manager) {
        const root = element.getRootNode();
        const injectedAttr = `data-vsc-filters-injected-${manager === filterManager ? 'video' : 'image'}`;
        if (root instanceof ShadowRoot && !root.host.hasAttribute(injectedAttr)) {
            const svgNode = manager.getSvgNode();
            if (svgNode) {
                root.appendChild(svgNode.cloneNode(true));
                root.host.setAttribute(injectedAttr, 'true');
                const level = (element.tagName === 'VIDEO') ? state.currentVideoFilterLevel : state.currentImageFilterLevel;
                manager.setSharpenMatrix(calculateSharpenMatrix(level), root);
            }
        }
    }

    function attachMediaListeners(media) {
        if (!media || state.processedMedia.has(media)) return;
        if (media.tagName === 'VIDEO') {
            injectFiltersIntoRoot(media, filterManager);
        }
        audioManager.processMedia(media);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) {
            listeners[evt] = handler;
            media.addEventListener(evt, handler);
        }
        state.mediaListenerMap.set(media, listeners);
        state.processedMedia.add(media);
        if (intersectionObserver) intersectionObserver.observe(media);
    }

    function attachImageListeners(image) {
        if (!image || state.processedImages.has(image)) return;
        injectFiltersIntoRoot(image, imageFilterManager);
        state.processedImages.add(image);
        if (intersectionObserver) intersectionObserver.observe(image);
    }

    function detachMediaListeners(media) {
        if (!state.mediaListenerMap.has(media)) return;
        const listeners = state.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) { media.removeEventListener(evt, listener); }
        audioManager.cleanupMedia(media);
        state.mediaListenerMap.delete(media);
        state.processedMedia.delete(media);
        if (intersectionObserver) intersectionObserver.unobserve(media);
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
        allMedia.forEach(m => {
            if (m.isConnected) {
                state.activeMedia.add(m);
                oldMedia.delete(m);
            }
        });
        oldMedia.forEach(detachMediaListeners);
        allMedia.forEach(m => {
            if (m.tagName === 'VIDEO') {
                m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended);
                updateVideoFilterState(m);
            }
        });
        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);
        const oldImages = new Set(state.activeImages);
        state.activeImages.clear();
        allImages.forEach(img => {
            if (img.isConnected) {
                state.activeImages.add(img);
                oldImages.delete(img);
            }
        });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);

        const root = state.ui.shadowRoot;
        if (root) {
            const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
            const hasAudio = Array.from(state.activeMedia).some(m => m.tagName === 'AUDIO') || hasVideo;
            const hasImage = state.activeImages.size > 0;
            filterManager.toggleStyleSheet(hasVideo);
            imageFilterManager.toggleStyleSheet(hasImage);
            root.getElementById('vsc-video-controls').style.display = hasVideo ? 'flex' : 'none';
            root.getElementById('vsc-audio-controls').style.display = hasAudio ? 'flex' : 'none';
            root.getElementById('vsc-image-controls').style.display = hasImage ? 'flex' : 'none';
            const shouldShowSpeedControls = hasVideo || hasAudio;
            root.querySelector('.vsc-collapsible').style.display = shouldShowSpeedControls ? 'flex' : 'none';
            root.querySelector('.vsc-btn.toggle').style.display = shouldShowSpeedControls ? 'flex' : 'none';
            const anyMedia = hasVideo || hasAudio || hasImage;
            if (state.isUiVisible !== anyMedia) {
                state.isUiVisible = anyMedia;
                if (state.isUiVisible) speedSlider.show();
                else speedSlider.hide();
            }
        }
    };

    const debouncedScanTask = debounce(scanAndApply, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) attachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(attachMediaListeners); if (n.matches?.('img')) attachImageListeners(n); n.querySelectorAll?.('img').forEach(attachImageListeners); }); };
    const handleRemovedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) detachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(detachMediaListeners); if (n.matches?.('img')) detachImageListeners(n); n.querySelectorAll?.('img').forEach(detachImageListeners); }); };

    // =================================================================================
    // 7. 스크립트 초기화 (Initialization)
    // =================================================================================

    function initialize() {
        console.log('🎉 Video_Image_Control (v38.1) Initialized.');

        filterManager.init();
        imageFilterManager.init();
        uiManager.init();
        speedSlider.init();
        dragBar.init();

        intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(e => {
                e.target.dataset.isVisible = String(e.isIntersecting);
                if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target);
                if (e.target.tagName === 'IMG') updateImageFilterState(e.target);
            });
        }, { threshold: 0.1 });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                document.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(v => v.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active'));
                for (const media of state.activeMedia) {
                    audioManager.suspendContext();
                }
            } else {
                scheduleIdleTask(scanAndApply);
                for (const media of state.activeMedia) {
                    audioManager.resumeContext();
                }
            }
        });

        const mutationObserver = new MutationObserver(mutations => {
            let changed = false;
            for (const mut of mutations) {
                if (mut.type === 'childList') {
                    if (mut.addedNodes.length > 0) { handleAddedNodes(mut.addedNodes); changed = true; }
                    if (mut.removedNodes.length > 0) { handleRemovedNodes(mut.removedNodes); changed = true; }
                }
            }
            if (changed) scheduleIdleTask(scanAndApply);
        });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener('addShadowRoot', debouncedScanTask);

        (function setupSpaNavigationHandler() {
            let lastHref = location.href;
            const onLocationChange = () => {
                if (location.href === lastHref) return;
                lastHref = location.href;
                scheduleIdleTask(scanAndApply);
            };
            ['pushState', 'replaceState'].forEach(method => {
                const original = history[method];
                history[method] = function (...args) {
                    const result = original.apply(this, args);
                    window.dispatchEvent(new Event('locationchange'));
                    return result;
                };
            });
            window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
            window.addEventListener('locationchange', onLocationChange);
        })();

        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));

        window.addEventListener('beforeunload', () => {
            mutationObserver.disconnect();
            if (intersectionObserver) intersectionObserver.disconnect();
        });

        setVideoFilterLevel(state.currentVideoFilterLevel);
        setImageFilterLevel(state.currentImageFilterLevel);

        scheduleIdleTask(scanAndApply);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize, { once: true });
    }
})();
