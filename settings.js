// ==UserScript==
// @name         VideoSpeed_Control (Exclusion)
// @namespace    https://com/
// @version      34.00-ParametricEQ
// @description  🎞️ 전문가 수준의 멀티밴드 파라메트릭 EQ를 도입하여 오디오 품질을 극대화한 최종 버전입니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration and Constants ---
    const CONFIG = {
        DEBUG: false,
        DEBOUNCE_DELAY: 350,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.4', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.4', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        SHARPEN_LEVELS: {
            high:   '0 -1 0 -1 5 -1 0 -1 0',
            medium: '0 -0.5 0 -0.5 3 -0.5 0 -0.5 0',
            low:    '0 -0.125 0 -0.125 1.5 -0.125 0 -0.125 0',
            off:    '0 0 0 0 1 0 0 0 0',
        },
        SITE_METADATA_RULES: {
            'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], },
            'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] },
            'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] },
        },
        FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: ['www.youtube.com', 'm.youtube.com'],
        // --- [수정] 멀티밴드 파라메트릭 EQ 프리셋 ---
        AUDIO_PRESETS: {
            off: { gain: 1, eq: [] },
            speech: { // 'voice' 프리셋
                gain: 1.0,
                eq: [
                    { freq: 100, gain: 3 }, { freq: 250, gain: 2 }, { freq: 500, gain: 1 },
                    { freq: 1000, gain: 0 }, { freq: 2000, gain: 1.5 }, { freq: 4000, gain: 2 },
                    { freq: 8000, gain: 1 }
                ]
            },
            movie: {
                gain: 1.15,
                eq: [
                    { freq: 80, gain: 4 }, { freq: 200, gain: 3 }, { freq: 500, gain: 1 },
                    { freq: 1000, gain: 1 }, { freq: 3000, gain: 2 }, { freq: 6000, gain: 2 },
                    { freq: 10000, gain: 1 }
                ]
            },
            music: {
                gain: 1.05,
                eq: [
                    { freq: 60, gain: 4 }, { freq: 150, gain: 3 }, { freq: 400, gain: 1.5 },
                    { freq: 1000, gain: 0 }, { freq: 3000, gain: 1.5 }, { freq: 6000, gain: 2 },
                    { freq: 12000, gain: 1 }
                ]
            }
        },
        MAX_EQ_BANDS: 7, // 프리셋에서 사용하는 최대 EQ 밴드 수
    };

    // --- Utilities & Guards ---
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path)); }
    if (isExcluded()) { return; }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    const state = {
        activeMedia: new Set(),
        processedMedia: new WeakSet(),
        mediaListenerMap: new WeakMap(),
        isUiVisible: false,
        isMinimized: true,
        currentFilterMode: 'off',
        currentAudioMode: 'off',
        ui: { shadowRoot: null },
        rAF: { pendingSpeedUpdate: false, latestSpeed: 1.0 }
    };

    (function protectConsoleClear() { if (!CONFIG.DEBUG) return; safeExec(() => { if (window.console && console.clear) { const originalClear = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked by VideoSpeed_Control (Debug Mode) ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection'); })();
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const originalAttachShadow = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function (options) { const modifiedOptions = { ...options, mode: 'open' }; const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]); window._shadowDomList_.push(new WeakRef(shadowRoot)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } })); return shadowRoot; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    // --- [수정] 파라메트릭 EQ를 지원하는 새로운 audioManager 모듈 ---
    const audioManager = (() => {
        const isAudioDisabledForSite = CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname);
        let ctx = null;
        let masterGain;
        const eqFilters = [];
        const sourceMap = new WeakMap();

        function ensureContext() {
            if (ctx || isAudioDisabledForSite) return;
            try {
                ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
                masterGain = ctx.createGain();

                let lastNode = masterGain;
                for (let i = 0; i < CONFIG.MAX_EQ_BANDS; i++) {
                    const eqFilter = ctx.createBiquadFilter();
                    eqFilter.type = 'peaking';
                    eqFilters.push(eqFilter);
                    lastNode.connect(eqFilter);
                    lastNode = eqFilter;
                }
                lastNode.connect(ctx.destination);
            } catch(e) {
                if(CONFIG.DEBUG) console.error("[VideoSpeed] AudioContext creation failed:", e);
                ctx = null;
            }
        }

        function connectMedia(media) {
            if (sourceMap.has(media) || !ctx) return;
            if (ctx.state === 'suspended') { ctx.resume().catch(()=>{}); }
            const source = ctx.createMediaElementSource(media);
            // 소스를 마스터 게인 노드에 연결 (EQ 체인은 그 뒤에 있음)
            source.connect(masterGain);
            sourceMap.set(media, { source });
            applyAudioPresetToNodes();
        }

        function applyAudioPresetToNodes() {
            if (!ctx) return;
            const preset = CONFIG.AUDIO_PRESETS[state.currentAudioMode] || CONFIG.AUDIO_PRESETS.off;
            const now = ctx.currentTime;

            masterGain.gain.setValueAtTime(preset.gain, now);

            for (let i = 0; i < eqFilters.length; i++) {
                const band = preset.eq[i];
                const filter = eqFilters[i];
                if (band) {
                    filter.frequency.setValueAtTime(band.freq, now);
                    filter.gain.setValueAtTime(band.gain, now);
                    filter.Q.setValueAtTime(1.41, now); // 기본 Q 값
                } else {
                    filter.gain.setValueAtTime(0, now); // 사용하지 않는 밴드는 비활성화
                }
            }
        }

        function processMedia(media) {
            if (isAudioDisabledForSite) return;
            media.addEventListener('play', () => {
                ensureContext();
                if (!ctx) return;
                connectMedia(media);
            }, { once: true });
        }

        function cleanupMedia(media) {
            if (isAudioDisabledForSite || !ctx) return;
            const rec = sourceMap.get(media);
            if (!rec) return;
            try {
                rec.source.disconnect();
                try {
                    if (rec.source && "mediaElement" in rec.source) {
                        rec.source.mediaElement = null;
                    }
                } catch (e) {}
            } catch (err) {
                if (CONFIG.DEBUG) console.warn("audioManager.cleanupMedia error:", err);
            } finally {
                sourceMap.delete(media);
            }
        }

        function setAudioMode(mode) {
            if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return;
            state.currentAudioMode = mode;
            applyAudioPresetToNodes();
        }

        function resetAudio() { setAudioMode('off'); }

        function suspendContext() {
            if (isAudioDisabledForSite || !ctx) return;
            const anyPlaying = Array.from(state.activeMedia).some(m => !m.paused && !m.ended);
            if (!anyPlaying && ctx.state === 'running') ctx.suspend().catch(()=>{});
        }

        function resumeContext() {
            if (isAudioDisabledForSite || !ctx) return;
            if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
        }

        return {
            processMedia, cleanupMedia, setAudioMode, resetAudio,
            suspendContext, resumeContext, getAudioMode: () => state.currentAudioMode
        };
    })();

    const uiManager = (() => {
        let host;
        function init() { if (host) return; host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX }); state.ui.shadowRoot = host.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = `:host { pointer-events: none; }
            * { pointer-events: auto; }
            #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.5s ease, background 0.2s; }
            #vm-speed-slider-container.touched, #vm-speed-slider-container.menu-visible { opacity: 1; }
            #vm-speed-slider-container.menu-visible { background: rgba(0,0,0,0.4); }
            @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } }
            #vm-speed-slider-container.minimized { width: 50px; }
            #vm-speed-slider-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
            #vm-speed-slider-container .vm-collapsible { display: flex; flex-direction: column; align-items: flex-end; width: 50px; margin-top: 4px; }
            #vm-speed-slider-container.minimized .vm-collapsible { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; }
            .vm-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: 4px; height: 28px; width: 50px; }
            .vm-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 0; margin-right: 5px; background: rgba(20,20,20,0.7); border-radius: 4px; padding: 2px; }
            .vm-control-group.submenu-visible .vm-submenu { display: flex; }
            .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; font-size:12px; }
            .vm-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }
            .vm-submenu .vm-btn { min-width: 24px; font-size: 14px; padding: 2px 4px; margin: 0 2px; }
            .vm-btn-main { font-size: 16px; padding: 2px 4px; width: 30px; height: 100%; }
            .vm-btn.reset, .vm-btn.toggle { font-size: 16px; padding: 0; width: 30px; height: 28px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
            .vm-btn.toggle { margin-top: 4px; }
            #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 60px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; }
            #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); padding-right: 5px; }
            #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }`; state.ui.shadowRoot.appendChild(style); (document.body || document.documentElement).appendChild(host); }
        return { init: () => safeExec(init, 'uiManager.init'), moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } };
    })();

    const filterManager = (() => {
        const isFilterDisabledForSite = CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        let isInitialized = false;
        const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
        function createSvgFiltersAndStyle() { if (document.getElementById('video-enhancer-svg-filters')) return; const settings = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS; const svg = createSvgElement('svg', { id: 'video-enhancer-svg-filters', style: 'display:none' }); const soft = createSvgElement('filter', { id: 'SofteningFilter' }); soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })); const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID }); sharp.appendChild(createSvgElement('feConvolveMatrix', { id: 'dynamic-convolve-matrix', order: '3 3', preserveAlpha: 'true', kernelMatrix: CONFIG.SHARPEN_LEVELS.off, mode: 'multiply' })); const gamma = createSvgElement('filter', { id: 'gamma-filter' }); const gammaTransfer = createSvgElement('feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); gamma.appendChild(gammaTransfer); const linear = createSvgElement('filter', { id: 'linear-adjust-filter' }); const linearTransfer = createSvgElement('feComponentTransfer'); const intercept = settings.SHADOWS_VALUE / 200; const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() }))); linear.appendChild(linearTransfer); svg.append(soft, sharp, gamma, linear); (document.body || document.documentElement).appendChild(svg); const style = document.createElement('style'); style.id = 'video-enhancer-styles'; style.textContent = `video.video-filter-active, iframe.video-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`; (document.head || document.documentElement).appendChild(style); }
        function initialize() { if (isInitialized || isFilterDisabledForSite) return; safeExec(createSvgFiltersAndStyle, 'filter.init'); isInitialized = true; }
        function setSharpenLevel(level = 'off') { if (!isInitialized) return; const matrix = document.getElementById('dynamic-convolve-matrix'); if (matrix) { const newMatrix = CONFIG.SHARPEN_LEVELS[level]; if (matrix.getAttribute('kernelMatrix') !== newMatrix) matrix.setAttribute('kernelMatrix', newMatrix); } }
        function setFilterMode(mode) { if (isFilterDisabledForSite || !isInitialized || !CONFIG.SHARPEN_LEVELS[mode]) return; state.currentFilterMode = mode; for (const video of state.activeMedia) { updateVideoFilterState(video); } }
        function resetFilter() { setFilterMode('off'); }
        return { init: initialize, setFilterMode, getFilterMode: () => state.currentFilterMode, setSharpenLevel, resetFilter, isInitialized: () => isInitialized };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        const createButton = (id, title, text, className = 'vm-btn') => { const btn = document.createElement('button'); if (id) btn.id = id; btn.className = className; btn.title = title; btn.textContent = text; return btn; };
        function init() {
            if (inited) return;
            const shadowRoot = state.ui.shadowRoot; if (!shadowRoot) return;
            const container = document.createElement('div'); container.id = 'vm-speed-slider-container';

            const videoControlGroup = document.createElement('div'); videoControlGroup.className = 'vm-control-group'; videoControlGroup.style.position = 'relative';
            const audioControlGroup = document.createElement('div'); audioControlGroup.className = 'vm-control-group'; audioControlGroup.style.position = 'relative';
            const filterBtnMain = createButton('vm-main-filter-btn', 'Video Filter Settings', '🌞', 'vm-btn vm-btn-main');
            const audioBtnMain = createButton('vm-main-audio-btn', 'Audio Preset Settings', '🎧', 'vm-btn vm-btn-main');
            const filterSubMenu = document.createElement('div'); filterSubMenu.className = 'vm-submenu';
            const audioSubMenu = document.createElement('div'); audioSubMenu.className = 'vm-submenu';

            const filterModes = { H: 'high', M: 'medium', L: 'low', '🚫': 'off' };
            Object.entries(filterModes).forEach(([text, mode]) => { const btn = createButton(null, `Filter: ${mode}`, text); btn.dataset.mode = mode; filterSubMenu.appendChild(btn); });
            // [수정] UI 버튼과 새로운 프리셋 이름(speech, movie, music)을 매칭
            const audioModes = { '🎙️': 'speech', '🎬': 'movie', '🎵': 'music', '🚫': 'off' };
            Object.entries(audioModes).forEach(([text, mode]) => { const btn = createButton(null, `Audio: ${mode}`, text); btn.dataset.mode = mode; audioSubMenu.appendChild(btn); });

            videoControlGroup.append(filterBtnMain, filterSubMenu);
            audioControlGroup.append(audioBtnMain, audioSubMenu);

            const collapsibleWrapper = document.createElement('div'); collapsibleWrapper.className = 'vm-collapsible';
            const resetBtn = createButton(null, 'Reset speed & audio', '1x', 'vm-btn reset');
            const sliderEl = document.createElement('input'); Object.assign(sliderEl, { type: 'range', min: '0.2', max: '4.0', step: '0.2', value: '1.0', id: 'vm-speed-slider' });
            const valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            collapsibleWrapper.append(resetBtn, sliderEl, valueEl);

            const toggleBtn = createButton(null, 'Toggle Speed Controller', '', 'vm-btn toggle');
            container.append(videoControlGroup, audioControlGroup, collapsibleWrapper, toggleBtn);
            shadowRoot.appendChild(container);

            if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) videoControlGroup.style.display = 'none';
            if (CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname)) audioControlGroup.style.display = 'none';

            const controlGroups = [videoControlGroup, audioControlGroup];
            const updateActiveButtons = () => {
                const currentFilter = filterManager.getFilterMode();
                filterSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentFilter));
                filterBtnMain.classList.toggle('active', currentFilter !== 'off');
                const currentAudio = audioManager.getAudioMode();
                audioSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
                audioBtnMain.classList.toggle('active', currentAudio !== 'off');
            };

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

            filterBtnMain.addEventListener('click', () => toggleSubMenu(videoControlGroup));
            audioBtnMain.addEventListener('click', () => toggleSubMenu(audioControlGroup));

            filterSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { filterManager.setFilterMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });
            audioSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { audioManager.setAudioMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });

            const applySpeed = speed => { for (const media of state.activeMedia) if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); };
            const updateValueText = speed => { if (valueEl) valueEl.textContent = `x${speed.toFixed(1)}`; };
            const updateAppearance = () => { if (!container) return; container.classList.toggle('minimized', state.isMinimized); toggleBtn.textContent = state.isMinimized ? '🔻' : '🔺'; if (state.isMinimized) hideAllSubMenus(); };

            resetBtn.addEventListener('click', () => { sliderEl.value = '1.0'; state.rAF.latestSpeed = 1.0; applySpeed(1.0); updateValueText(1.0); audioManager.resetAudio(); filterManager.resetFilter(); updateActiveButtons(); });
            toggleBtn.addEventListener('click', () => { state.isMinimized = !state.isMinimized; updateAppearance(); });

            sliderEl.addEventListener('input', e => {
                const speed = parseFloat(e.target.value);
                updateValueText(speed);
                state.rAF.latestSpeed = speed;
                if (!state.rAF.pendingSpeedUpdate) {
                    state.rAF.pendingSpeedUpdate = true;
                    window.requestAnimationFrame(() => {
                        applySpeed(state.rAF.latestSpeed);
                        state.rAF.pendingSpeedUpdate = false;
                    });
                }
            });

            const endInteraction = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => container.classList.remove('touched'), 3000); };
            const onTouchEnd = () => { endInteraction(); document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd); };
            container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onTouchEnd); document.addEventListener('touchcancel', onTouchEnd); }, { passive: true });
            sliderEl.addEventListener('change', endInteraction, { passive: true });
            sliderEl.addEventListener('blur', endInteraction, { passive: true });

            inited = true; updateAppearance(); updateActiveButtons();
        }
        return { init: () => safeExec(init, 'speedSlider.init'), show: () => { const el = state.ui.shadowRoot?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; }, hide: () => { const el = state.ui.shadowRoot?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; }, isMinimized: () => state.isMinimized };
    })();

    const dragBar = (() => { let display, inited = false; let dragState = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false; function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; } const getEventPosition = e => e.touches ? e.touches[0] : e; const onStart = e => safeExec(() => { if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return; const video = findAssociatedVideo(e.target); if (!video || video.paused || speedSlider.isMinimized() || e.composedPath().some(el => el.id === 'vm-speed-slider-container')) return; const pos = getEventPosition(e); Object.assign(dragState, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'drag.start'); const onMove = e => { if (!dragState.dragging) return; if (e.touches && e.touches.length > 1) return onEnd(); const pos = getEventPosition(e); dragState.currentX = pos.clientX; dragState.currentY = pos.clientY; if (!dragState.directionConfirmed) { const dX = Math.abs(dragState.currentX - dragState.startX); const dY = Math.abs(dragState.currentY - dragState.startY); if (dX > dY + 5) dragState.directionConfirmed = true; else if (dY > dX + 5) return onEnd(); } if (dragState.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); dragState.accX += dragState.currentX - dragState.startX; dragState.startX = dragState.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (dragState.dragging) showDisplay(dragState.accX); rafScheduled = false; }); } } }; const onEnd = () => { if (!dragState.dragging) return; if (dragState.directionConfirmed) applySeek(); Object.assign(dragState, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); }; const applySeek = () => { const delta = Math.round(dragState.accX / 2); if (Math.abs(delta) < 1) return; for (const media of state.activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); }; const showDisplay = pixels => { const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds; if (!display) { const root = state.ui.shadowRoot; if(!root) return; display = document.createElement('div'); display.id = 'vm-time-display'; root.appendChild(display); } const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mins}분 ${secs}초`; display.style.display = 'block'; display.style.opacity = '1'; }; const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } }; return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } }; })();
    const mediaSessionManager = (() => { const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); }; const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; }; const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; }; const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} }; return { setSession: m => { if (!('mediaSession' in navigator)) return; safeExec(() => { const { title, artist } = getMeta(); navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' }); setAction('play', () => m.play()); setAction('pause', () => m.pause()); setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); }); setAction('seekforward', () => { m.currentTime += getSeekTime(m); }); setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }); }, 'mediaSession.set'); }, clearSession: () => { if (!('mediaSession' in navigator) || state.activeMedia.size > 0) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); } }; })();

    let intersectionObserver = null;
    function findAllMedia(doc = document) { const elems = []; safeExec(() => { elems.push(...doc.querySelectorAll('video, audio')); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...root.querySelectorAll('video, audio')); }); if (doc === document) doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) {} }); }); return [...new Set(elems)]; }

    function updateVideoFilterState(video) { if (!filterManager.isInitialized()) return; const isPlaying = !video.paused && !video.ended; const isVisible = video.dataset.isVisible === 'true'; const filterMode = filterManager.getFilterMode(); const shouldHaveFilter = isPlaying && isVisible && filterMode !== 'off'; filterManager.setSharpenLevel(filterMode); video.classList.toggle('video-filter-active', shouldHaveFilter); }
    const mediaEventHandlers = { play: e => { const m = e.target; audioManager.resumeContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); }, pause: e => { const m = e.target; audioManager.suspendContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); }, ended: e => { const m = e.target; detachMediaListeners(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); }, };

    function attachMediaListeners(media) {
        if (!media || state.processedMedia.has(media)) return;
        if (media.tagName === 'VIDEO') { if (!filterManager.isInitialized()) filterManager.init(); }
        audioManager.processMedia(media);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) {
            listeners[evt] = handler;
            media.addEventListener(evt, handler);
        }
        state.mediaListenerMap.set(media, listeners);
        state.processedMedia.add(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.observe(media);
    }

    function detachMediaListeners(media) {
        if (!state.mediaListenerMap.has(media)) return;
        const listeners = state.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) {
            media.removeEventListener(evt, listener);
        }
        audioManager.cleanupMedia(media);
        state.mediaListenerMap.delete(media);
        state.processedMedia.delete(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.unobserve(media);
    }

    const scanForMedia = (isUiUpdateOnly = false) => { const allMedia = findAllMedia(); if (!isUiUpdateOnly) allMedia.forEach(attachMediaListeners); const oldMedia = new Set(state.activeMedia); state.activeMedia.clear(); allMedia.forEach(m => { if (m.isConnected) { state.activeMedia.add(m); oldMedia.delete(m); } }); oldMedia.forEach(detachMediaListeners); allMedia.forEach(m => { if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); } }); const shouldBeVisible = state.activeMedia.size > 0; if (state.isUiVisible !== shouldBeVisible) { state.isUiVisible = shouldBeVisible; if (state.isUiVisible) speedSlider.show(); else speedSlider.hide(); } };

    const debouncedScanTask = debounce(scanForMedia, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) attachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(attachMediaListeners); }); };
    const handleRemovedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) detachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(detachMediaListeners); }); };

    function initialize() {
        console.log('🎉 VideoSpeed_Control (Refactor) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        intersectionObserver = new IntersectionObserver(entries => { entries.forEach(e => { e.target.dataset.isVisible = e.isIntersecting; if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target); }); }, { threshold: 0.1 });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active')); for (const media of state.activeMedia) { audioManager.suspendContext(); } } else { scanForMedia(true); for (const media of state.activeMedia) { audioManager.resumeContext(); } } });
        const mutationObserver = new MutationObserver(mutations => { let changed = false; for (const mut of mutations) { if (mut.type === 'childList') { if (mut.addedNodes.length > 0) { handleAddedNodes(mut.addedNodes); changed = true; } if (mut.removedNodes.length > 0) { handleRemovedNodes(mut.removedNodes); changed = true; } } } if (changed) scheduleIdleTask(() => scanForMedia()); });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function(...args) { let result; try { result = originalPushState.apply(this, args); } finally { scheduleIdleTask(() => scanForMedia()); } return result; };
        window.addEventListener('popstate', () => scheduleIdleTask(() => scanForMedia()));
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));
        window.addEventListener('beforeunload', () => { mutationObserver.disconnect(); intersectionObserver.disconnect(); });
        scanForMedia();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') { initialize(); } else { window.addEventListener('DOMContentLoaded', initialize, { once: true }); }
})();
