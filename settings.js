// ==UserScript==
// @name         VideoSpeed_Control (Light)
// @namespace    https.com/
// @version      22.7 (배속바 기본 : 최소화 재적용, optimized)
// @description  🎞️ [경량화 버전] 동영상 재생 속도 및 시간 제어 기능에만 집중 (CPU/메모리 최적화 적용)
// @match        *://*/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ============================
     * 콘솔 클리어 방지
     * ============================ */
    (function() {
        try {
            if (window.console && console.clear) {
                const originalClear = console.clear;
                console.clear = function() {
                    console.log('--- 🚫 console.clear()가 차단되었습니다. ---');
                };
                Object.defineProperty(console, 'clear', {
                    configurable: false,
                    writable: false,
                    value: console.clear
                });
                console.log('✅ 콘솔 클리어 방지 기능이 활성화되었습니다.');
            }
        } catch (e) {
            console.error('콘솔 클리어 방지 로직에 오류가 발생했습니다:', e);
        }
    })();

    /* ============================
     * 설정: 전역 기능 및 제외 도메인
     * ============================ */
    const NOT_EXCLUSION_DOMAINS = ['avsee.ru'];
    const EXCLUSION_PATHS = ['/bbs/login.php'];

    function isExcluded() {
        try {
            const url = new URL(location.href);
            const host = url.hostname;
            const path = url.pathname;
            const domainMatch = NOT_EXCLUSION_DOMAINS.some(d => host === d || host.endsWith('.' + d));
            if (!domainMatch) return false;
            return EXCLUSION_PATHS.some(p => path.startsWith(p));
        } catch {
            return false;
        }
    }

    if (isExcluded()) {
        console.log(`해당 주소: ${location.href} - 스크립트 비활성화`);
        return;
    }

    // 기능 플래그에서 URL 추적 및 로그 관련 항목 제거
    const FeatureFlags = {
        videoControls: true,
        spaPartialUpdate: true,
        previewFiltering: true,
        iframeProtection: true,
        mediaSessionIntegration: true,
    };

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) {
        return;
    }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', {
        value: true, writable: false, configurable: true
    });

    /* ============================
     * 안전한 원시 함수 보관
     * ============================ */
    const originalMethods = {
        Element: {
            attachShadow: window.Element.prototype.attachShadow
        },
        Document: {
            createElement: document.createElement
        },
        History: {
            pushState: window.history.pushState,
            replaceState: window.history.replaceState
        },
    };

    /* ============================
     * Shadow DOM 강제 open (미디어 탐지를 위한 핵심 기능)
     * ============================ */
    (function hackAttachShadow() {
        if (window._hasHackAttachShadow_) return;
        try {
            window._shadowDomList_ = [];
            window.Element.prototype.attachShadow = function () {
                const arg = arguments;
                if (arg[0] && arg[0].mode) arg[0].mode = 'open';
                const root = originalMethods.Element.attachShadow.apply(this, arg);
                try { window._shadowDomList_.push(root); } catch (e) { }
                document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: root } }));
                return root;
            };
            window._hasHackAttachShadow_ = true;
        } catch (e) { console.error('hackAttachShadow error', e); }
    })();

    /* ============================
     * 설정 관리: ConfigManager (참고: 배속바 최소화 상태 저장은 제거됨)
     * ============================ */
    class ConfigManager {
        constructor(opts = {}) {
            this.opts = opts;
            this.opts.config = this.opts.config || {};
            this.isInitialized = false;
        }

        async init() {
            if (this.isInitialized) return;
            await this._syncFromGlobal();
            this.isInitialized = true;
        }

        _key(p = '') { return (this.opts.prefix || '_vs_') + p.replace(/\./g, '_'); }
        isLocalUsable() {
            try { localStorage.setItem('__test__', '1'); localStorage.removeItem('__test__'); return true; } catch (e) { return false; }
        }

        async get(path) {
            if (this.isLocalUsable()) {
                try {
                    const v = localStorage.getItem(this._key(path));
                    if (v !== null) { try { return JSON.parse(v); } catch (e) { return v; } }
                } catch (e) {}
            }

            if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
                try {
                    const gv = await GM.getValue(this._key(path));
                    if (gv !== undefined) return gv;
                } catch (e) {}
            } else if (typeof GM_getValue === 'function') {
                try {
                    const gv = GM_getValue(this._key(path));
                    if (gv !== undefined) return gv;
                } catch (e) {}
            }

            if (!path) return this.opts.config;
            let cur = this.opts.config;
            const parts = path.split('.');
            for (const p of parts) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[p]; }
            return cur;
        }

        async set(path, val) {
            if (this.isLocalUsable()) {
                try { localStorage.setItem(this._key(path), typeof val === 'object' ? JSON.stringify(val) : String(val)); } catch (e) {}
            }

            if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
                try { await GM.setValue(this._key(path), val); } catch (e) {}
            } else if (typeof GM_setValue === 'function') {
                try { GM_setValue(this._key(path), val); } catch (e) {}
            }

            const parts = path.split('.');
            let cur = this.opts.config;
            for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]]; }
            cur[parts[parts.length - 1]] = val;
        }

        async _syncFromGlobal() {
            if (typeof GM_listValues !== 'function') return;
            try {
                const keys = GM_listValues();
                for (const k of keys) {
                    if (k.startsWith(this.opts.prefix || '')) {
                        const path = k.replace(this.opts.prefix, '').replace(/_/g, '.');
                        const val = await this.get(path);
                        const parts = path.split('.');
                        let cur = this.opts.config;
                        for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]]; }
                        cur[parts[parts.length - 1]] = val;
                    }
                }
            } catch (e) {}
        }
    }
    const configManager = new ConfigManager({ prefix: '_video_speed_', config: { isInitialized: false } });

    /* ============================
     * 유틸 함수
     * ============================ */
    const MANAGED_LISTENERS = new WeakMap();

    function addOnceEventListener(el, ev, handler, options) {
        try {
            if (!el) return;
            if (!el._vm_handlers) el._vm_handlers = new Set();
            const key = `${ev}_${handler.name || handler.toString()}`;
            if (el._vm_handlers.has(key)) return;
            el.addEventListener(ev, handler, options);
            el._vm_handlers.add(key);
        } catch (e) {}
    }

    function addManagedEventListener(el, ev, handler, options) {
        try {
            if (!el) return;
            if (!el._vm_handlers) el._vm_handlers = new Set();
            const key = `${ev}_${handler.name || handler.toString()}`;
            if (el._vm_handlers.has(key)) return;
            el.addEventListener(ev, handler, options);
            el._vm_handlers.add(key);
            if (!MANAGED_LISTENERS.has(el)) {
                MANAGED_LISTENERS.set(el, new Map());
            }
            MANAGED_LISTENERS.get(el).set(key, { ev, handler, options });
        } catch (e) {
            console.error('addManagedEventListener failed:', e);
        }
    }

    function removeAllManagedEventListeners(el) {
        try {
            if (MANAGED_LISTENERS.has(el)) {
                const listeners = MANAGED_LISTENERS.get(el);
                for (const [, { ev, handler, options }] of listeners.entries()) {
                    el.removeEventListener(ev, handler, options);
                }
                MANAGED_LISTENERS.delete(el);
                if (el._vm_handlers) el._vm_handlers.clear();
            }
        } catch (e) {
            console.error('removeAllManagedEventListeners failed:', e);
        }
    }

    function debounce(fn, wait) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; }

    /* ============================
     * 전역 상태 관리
     * ============================ */
    const MediaStateManager = (() => {
        const wm = new WeakMap();
        const previews = new WeakSet();
        const iframes = new WeakSet();
        return {
            has(m) { return wm.has(m); },
            get(m) { return wm.get(m); },
            set(m, v) { wm.set(m, v); return v; },
            delete(m) { try { wm.delete(m); } catch (e){} },
            addPreview(m) { try { previews.add(m); } catch (e) {} },
            isPreview(m) { try { return previews.has(m); } catch (e) { return false; } },
            addIframe(i) { try { iframes.add(i); } catch (e) {} },
            hasIframe(i) { try { return iframes.has(i); } catch (e) { return false; } },
            deleteIframe(i) { try { iframes.delete(i); } catch (e) {} },
        };
    })();

    let PROCESSED_DOCUMENTS = new WeakSet();
    const isTopFrame = window.self === window.top;
    const OBSERVER_MAP = new Map(); // Document -> MutationObserver
    let activeMediaCache = [];

    /* ============================
     * UI 관리: UI Manager
     * ============================ */
    const uiManager = (() => {
        let host, shadowRoot;

        function init() {
            if (host) return;
            host = document.createElement('div');
            host.id = 'vsc-ui-host';
            host.style.position = 'fixed';
            host.style.top = '0';
            host.style.left = '0';
            host.style.width = '100%';
            host.style.height = '100%';
            host.style.pointerEvents = 'none';
            host.style.zIndex = '2147483647';
            shadowRoot = host.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = `
                :host { pointer-events: none; }
                * { pointer-events: auto; }
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity .2s, width .3s, background .2s; pointer-events: auto; }
                #vm-speed-slider-container:hover { opacity: 1; background: rgba(0,0,0,0.0); }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 0; accent-color: #e74c3c; }
                #vm-speed-value { color: #f44336; font-weight: bold; font-size: 14px; margin-top: 6px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin:4px 0; }
                #vm-time-display { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 102; background: rgba(0,0,0,0.7); color: #fff; padding: 10px 20px; border-radius: 5px; font-size: 1.5rem; display: none; opacity: 1; transition: opacity 0.3s ease-out; pointer-events: none; }
            `;
            shadowRoot.appendChild(style);
            (document.body || document.documentElement).appendChild(host);
        }

        function getShadowRoot() {
            if (!shadowRoot) init();
            return shadowRoot;
        }

        function moveUiTo(targetElement) {
            if (host && targetElement && host.parentNode !== targetElement) {
                targetElement.appendChild(host);
            }
        }
        return { init, getShadowRoot, moveUiTo };
    })();

    /* ============================
     * 미리보기 감지
     * ============================ */
    // 재생 시간이 12초보다 짧은 영상에는 속도 조절 UI가 나타나지 않도록
    const PREVIEW_CONFIG = { DURATION_THRESHOLD: 12 };

    /* ============================
     * mediaFinder (DOM 탐색)
     * ============================ */
    const mediaFinder = {
        findInDoc(doc) {
            const out = [];
            if (!doc) return out;
            try {
                doc.querySelectorAll('video, audio').forEach(m => out.push(m));
                if (window._shadowDomList_) {
                    window._shadowDomList_.forEach(sr => {
                        try { sr.querySelectorAll && sr.querySelectorAll('video,audio').forEach(m => out.push(m)); } catch (e) {}
                    });
                }
            } catch (e) { console.error('findInDoc failed:', e); }
            return out;
        },
        findAll() {
            const arr = mediaFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try { if (iframe.contentDocument) arr.push(...mediaFinder.findInDoc(iframe.contentDocument)); } catch (e) {}
            });
            return arr;
        },
    };

    /* ============================
     * 미디어 세션 API 매니저
     * ============================ */
    const mediaSessionManager = (() => {
        function setSession(media) {
            if (!FeatureFlags.mediaSessionIntegration || !('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: document.title || '재생 중인 미디어',
                    artist: window.location.hostname,
                    album: 'VideoSpeed_Control',
                });
                navigator.mediaSession.setActionHandler('play', () => media.play());
                navigator.mediaSession.setActionHandler('pause', () => media.pause());
                navigator.mediaSession.setActionHandler('seekbackward', (details) => { media.currentTime = Math.max(0, media.currentTime - (details.seekOffset || 10)); });
                navigator.mediaSession.setActionHandler('seekforward', (details) => { media.currentTime = Math.min(media.duration, media.currentTime + (details.seekOffset || 10)); });
            } catch (e) {
                console.error('미디어 세션 설정 실패:', e);
            }
        }
        function clearSession() {
            if (!FeatureFlags.mediaSessionIntegration || !('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = null;
                ['play', 'pause', 'seekbackward', 'seekforward'].forEach(h => navigator.mediaSession.setActionHandler(h, null));
            } catch(e) {}
        }
        return { setSession, clearSession };
    })();

    /* ============================
     * UI 모듈 (SpeedSlider, DragBar)
     * ============================ */
    const DRAG_CONFIG = { PIXELS_PER_SECOND: 2 };
    const speedSlider = (() => {
        let container = null, inited = false, isMin = true; // isMin 기본값을 true(최소화)로 설정

        async function init() {
            if (inited) return;
            // [변경] 저장된 최소화 상태를 불러오는 로직 제거. 항상 isMin = true로 시작합니다.
            // isMin = !!(await configManager.get('isMinimized'));
            inited = true;

            const shadowRoot = uiManager.getShadowRoot();
            container = shadowRoot.getElementById('vm-speed-slider-container');
            if (!container) {
                container = document.createElement('div'); container.id = 'vm-speed-slider-container';
                const reset = document.createElement('button'); reset.className = 'vm-btn'; reset.textContent = '1x';
                const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0'; slider.step = '0.1'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                const val = document.createElement('div'); val.id = 'vm-speed-value'; val.textContent = 'x1.0';
                const toggle = document.createElement('button'); toggle.className = 'vm-btn';

                reset.addEventListener('click', () => { slider.value = '1.0'; applySpeed(1.0); val.textContent = 'x1.0'; });
                slider.addEventListener('input', (e) => { const s = parseFloat(e.target.value); val.textContent = `x${s.toFixed(1)}`; applySpeed(s); });

                // [변경] 토글 버튼 클릭 시 상태를 저장하는 로직 제거
                toggle.addEventListener('click', () => {
                    isMin = !isMin;
                    // await configManager.set('isMinimized', isMin);
                    updateAppearance();
                });

                container.appendChild(reset); container.appendChild(slider); container.appendChild(val); container.appendChild(toggle);
                shadowRoot.appendChild(container);
            }
            updateAppearance();
        }

        function updateAppearance() {
            if (!container) return;
            const isHidden = isMin;
            container.style.width = isHidden ? '30px' : '50px';
            [container.querySelector('#vm-speed-slider'), container.querySelector('#vm-speed-value'), container.querySelector('.vm-btn:first-of-type')].forEach(el => {
                if (el) el.style.display = isHidden ? 'none' : 'block';
            });
            const toggleBtn = container.querySelector('.vm-btn:last-of-type');
            if(toggleBtn) toggleBtn.textContent = isHidden ? '🔻' : '🔺';
        }

        function applySpeed(speed) {
            activeMediaCache.forEach(md => {
                try { if (md.tagName === 'VIDEO' || md.tagName === 'AUDIO') md.playbackRate = speed; } catch (e) {}
            });
        }

        async function show() { if (!inited) await init(); if (!container) return; container.style.display = 'flex'; }
        function hide() { if (!container) return; container.style.display = 'none'; }

        return { init, show, hide, isMinimized: () => isMin };
    })();

    const dragBar = (() => {
        let display = null, inited = false, visible = false;
        let state = { dragging: false, isHorizontalDrag: false, startX: 0, startY: 0, accX: 0 };

        // preTouchMove: 초기(패시브) 터치 무브 핸들러 (임계치 도달 전)
        function preTouchMove(e) {
            try {
                if (!state.dragging) return;
                const pos = e.touches ? e.touches[0] : e;
                const dx = pos.clientX - state.startX;
                const dy = pos.clientY - state.startY;
                if (Math.abs(dx) > 10 && Math.abs(dy) < Math.abs(dx)) {
                    // 이제 진짜 드래그로 전환: passive:false onMove 로 교체
                    document.removeEventListener('touchmove', preTouchMove, true);
                    document.addEventListener('touchmove', onMove, { passive: false, capture: true });
                    state.isHorizontalDrag = true;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                } else if (Math.abs(dy) > 10) {
                    // 세로 스크롤로 간주 -> 종료
                    onEnd();
                }
            } catch (err) { console.error('preTouchMove error', err); }
        }

        function fmt(s) {
            const sign = s < 0 ? '-' : '+';
            const a = Math.abs(Math.round(s));
            const mm = Math.floor(a / 60).toString().padStart(2, '0');
            const ss = (a % 60).toString().padStart(2, '0');
            return `${sign}${mm}분${ss}초`;
        }
        function apply() {
            const deltaSec = Math.round(state.accX / (DRAG_CONFIG?.PIXELS_PER_SECOND || 2));
            if (!deltaSec) return;
            try {
                // [개선] DOM 전체 탐색 대신 캐시된 미디어 목록 사용
                activeMediaCache.forEach(m => {
                    try {
                        if (!(m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) return;
                        if (!isFinite(m.duration)) return;
                        m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec));
                    } catch (e) {}
                });
            } catch (e) { console.error('dragBar apply failed:', e); }
        }
        const showDisplay = (v) => {
            if (!display) {
                const shadowRoot = uiManager.getShadowRoot();
                display = shadowRoot.getElementById('vm-time-display');
                if (!display) {
                    display = document.createElement('div'); display.id = 'vm-time-display';
                    shadowRoot.appendChild(display);
                }
            }
            display.textContent = fmt(v);
            display.style.display = 'block';
            display.style.opacity = '1';
            visible = true;
        };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => display.style.display = 'none', 300); } visible = false; };

        function onStart(e) {
            try {
                // [부활한 로직 1] 배속바가 최소화 상태이면 드래그 중단
                if (speedSlider.isMinimized()) {
                    return;
                }

                // [부활한 로직 2] 클릭 경로에 배속바 UI가 포함되면 드래그 중단
                const path = e.composedPath ? e.composedPath() : (e.path || []);
                if (path && path.some(el => el && el.id === 'vm-speed-slider-container')) {
                    return;
                }

                if (e.type === 'mousedown' && e.button === 2) return;
                // [개선] DOM 전체 탐색 대신 캐시된 미디어 목록 사용
                if (!activeMediaCache.some(m => m.tagName === 'VIDEO' && !m.paused)) { return; }

                const pos = e.touches ? e.touches[0] : e;
                state.dragging = true;
                state.startX = pos.clientX;
                state.startY = pos.clientY;
                state.accX = 0;

                if (e.type === 'mousedown') {
                    // 마우스용: 즉시 non-passive move 등록
                    document.addEventListener('mousemove', onMove, { passive: false, capture: true });
                } else if (e.type === 'touchstart') {
                    // 터치용: 초기엔 passive:true 검사 핸들러로 대충 감지 -> 임계치 넘으면 교체
                    document.addEventListener('touchmove', preTouchMove, { passive: true, capture: true });
                }

                document.addEventListener('mouseup', onEnd, { passive: false, capture: true });
                document.addEventListener('touchend', onEnd, { passive: false, capture: true });
            } catch (e) { console.error('dragBar onStart failed:', e); }
        }

        function onMove(e) {
            if (!state.dragging) return;
            try {
                if ((e.touches && e.touches.length > 1) || (e.pointerType === 'touch' && e.pointerId > 1)) return onEnd();
                const pos = e.touches ? e.touches[0] : e;
                const dx = pos.clientX - state.startX;
                const dy = pos.clientY - state.startY;
                if (!state.isHorizontalDrag) {
                    if (Math.abs(dx) > 10 && Math.abs(dy) < Math.abs(dx)) {
                        state.isHorizontalDrag = true;
                        e.preventDefault(); e.stopImmediatePropagation();
                        document.body.style.userSelect = 'none';
                        document.body.style.touchAction = 'none';
                    } else if (Math.abs(dy) > 10) { return onEnd(); }
                }
                if (state.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    state.accX += dx;
                    state.startX = pos.clientX;
                    showDisplay(state.accX / (DRAG_CONFIG.PIXELS_PER_SECOND || 2));
                }
            } catch (e) { console.error('dragBar onMove failed:', e); onEnd(); }
        }
        function onEnd() {
            if (!state.dragging) return;
            apply();
            state.dragging = false; state.accX = 0; state.isHorizontalDrag = false;
            hideDisplay();
            document.body.style.userSelect = ''; document.body.style.touchAction = '';
            // mouse listeners
            document.removeEventListener('mousemove', onMove, true);
            // touch listeners: remove both possible handlers
            document.removeEventListener('touchmove', onMove, true);
            document.removeEventListener('touchmove', preTouchMove, true);
            document.removeEventListener('mouseup', onEnd, true);
            document.removeEventListener('touchend', onEnd, true);
        }
        function init() {
            if (inited) return; inited = true;
            // mousedown with non-passive so we can preventDefault if needed
            addOnceEventListener(document, 'mousedown', onStart, { passive: false, capture: true });
            // touchstart passive true (we will promote to non-passive on demand)
            addOnceEventListener(document, 'touchstart', onStart, { passive: true, capture: true });
        }
        return { init, show: () => visible && display && (display.style.display = 'block'), hide: hideDisplay, display: () => display };
    })();

    /* ============================
     * mediaControls (미디어 요소와 UI 연결)
     * ============================ */
    const mediaControls = (() => {
        const updateUIVisibility = async () => {
            const hasMedia = activeMediaCache.some(m => m.tagName === 'VIDEO' || m.tagName === 'AUDIO');
            if (hasMedia) {
                await speedSlider.show();
            } else {
                speedSlider.hide();
            }
            const hasPlayingVideo = activeMediaCache.some(m => m.tagName === 'VIDEO' && !m.paused);
            if (hasPlayingVideo) dragBar.show(); else dragBar.hide();
        };

        function initWhenReady(media) {
            if (!media || MediaStateManager.has(media)) return;
            MediaStateManager.set(media, { isInitialized: true });

            if (FeatureFlags.previewFiltering && media.duration > 0 && media.duration < PREVIEW_CONFIG.DURATION_THRESHOLD) {
                MediaStateManager.addPreview(media);
                return;
            }

            addManagedEventListener(media, 'loadedmetadata', function () {
                updateUIVisibility();
            }, { once: true });
            addManagedEventListener(media, 'play', () => {
                updateUIVisibility();
                mediaSessionManager.setSession(media);
            }, true);
            addManagedEventListener(media, 'pause', () => {
                updateUIVisibility();
                mediaSessionManager.clearSession();
            }, true);
            addManagedEventListener(media, 'ended', () => {
                updateUIVisibility();
                mediaSessionManager.clearSession();
            }, true);
        }
        function detachUI(media) { if (MediaStateManager.has(media)) MediaStateManager.delete(media); }
        return { initWhenReady, detachUI, updateUIVisibility };
    })();

    /* ============================
     * SPA/Navigation 모니터
     * ============================ */
    const spaMonitor = (() => {
        let lastURL = location.href;
        let isSpaMonitorInitialized = false;

        function cleanupAllDocuments() {
            try {
                for (const [doc, obs] of OBSERVER_MAP.entries()) {
                    try { obs.disconnect(); } catch (e) {}
                }
                OBSERVER_MAP.clear();
                PROCESSED_DOCUMENTS = new WeakSet();
                activeMediaCache = [];
            } catch (e) {}
        }

        function onNavigate() {
            // setTimeout은 수동 debounce 역할
            setTimeout(() => {
                const now = location.href;
                if (now !== lastURL) {
                    cleanupAllDocuments();
                    App.initializeAll(document);
                    lastURL = now;
                }
            }, 300);
        }
        function init() {
            if (isSpaMonitorInitialized) return;
            isSpaMonitorInitialized = true;
            const origPushState = history.pushState;
            history.pushState = function() { origPushState.apply(this, arguments); onNavigate(); };
            const origReplaceState = history.replaceState;
            history.replaceState = function() { origReplaceState.apply(this, arguments); onNavigate(); };
            window.addEventListener('popstate', onNavigate);
        }
        return { init };
    })();

    /* ============================
     * App: 메인 컨트롤러
     * ============================ */
    function scanTask() {
        // 스캔 시점에 최신 미디어 목록 갱신
        activeMediaCache = mediaFinder.findAll();
        activeMediaCache.forEach(m => mediaControls.initWhenReady(m));
        mediaControls.updateUIVisibility();
    }
    const debouncedScanTask = debounce(scanTask, 100);

    // 문서 단위 정리 함수
    function cleanupDocument(targetDocument) {
        try {
            if (!targetDocument) return;
            // disconnect observer for this doc
            const obs = OBSERVER_MAP.get(targetDocument);
            if (obs) {
                try { obs.disconnect(); } catch (e) {}
                OBSERVER_MAP.delete(targetDocument);
            }
            // remove from processed set
            try { PROCESSED_DOCUMENTS.delete(targetDocument); } catch (e) {}
            // if it was an iframe doc, clear media state for its elements
            try {
                const medias = mediaFinder.findInDoc(targetDocument);
                medias.forEach(m => {
                    try {
                        removeAllManagedEventListeners(m);
                        MediaStateManager.delete(m);
                    } catch (e) {}
                });
            } catch (e) {}
            // refresh global cache
            scanTask();
        } catch (e) { console.error('cleanupDocument failed', e); }
    }

    const App = (() => {
        function initIframe(iframe) {
            if (!iframe || MediaStateManager.hasIframe(iframe)) return;
            MediaStateManager.addIframe(iframe);

            const attempt = () => {
                try {
                    if (iframe.contentDocument) {
                        initializeAll(iframe.contentDocument);
                    }
                } catch (e) { /* cross-origin, ignore */ }
            };
            addOnceEventListener(iframe, 'load', debounce(attempt, 400), true);
            attempt();

            // iframe 이 DOM에서 제거되는 것을 감지하여 정리
            // (상위 문서의 observer 콜백에서도 제거를 감지하지만, 여기에 안전장치 추가)
            try {
                const parentDoc = iframe.ownerDocument;
                if (parentDoc) {
                    const remover = new MutationObserver((mutations) => {
                        for (const mu of mutations) {
                            for (const n of mu.removedNodes) {
                                if (n === iframe) {
                                    // iframe 제거 -> 해당 contentDocument 정리
                                    try {
                                        if (iframe.contentDocument) cleanupDocument(iframe.contentDocument);
                                    } catch (e) {}
                                    try { remover.disconnect(); } catch (e) {}
                                }
                            }
                        }
                    });
                    remover.observe(parentDoc, { childList: true, subtree: true });
                }
            } catch (e) {}
        }

        function startUnifiedObserver(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            const observer = new MutationObserver((mutations) => {
                // 변경 감지 시 전체 스캔을 디바운스하여 수행
                let foundRemovedIframeDocs = [];
                for (const mu of mutations) {
                    // 제거된 iframe 있으면 해당 문서 정리
                    for (const n of mu.removedNodes) {
                        if (n && n.tagName === 'IFRAME') {
                            try {
                                if (n.contentDocument) foundRemovedIframeDocs.push(n.contentDocument);
                            } catch (e) {}
                        }
                    }
                }
                if (foundRemovedIframeDocs.length) {
                    foundRemovedIframeDocs.forEach(doc => cleanupDocument(doc));
                }
                debouncedScanTask();
            });
            observer.observe(targetDocument, { childList: true, subtree: true });
            OBSERVER_MAP.set(targetDocument, observer);
            PROCESSED_DOCUMENTS.add(targetDocument);
        }

        async function initializeAll(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;

            if (targetDocument === document) {
                await configManager.init();
                uiManager.init();
                console.log('🎉 VideoSpeed_Control (Lite) 초기화 (optimized)');
                if (FeatureFlags.spaPartialUpdate) spaMonitor.init();
                await speedSlider.init();
                dragBar.init();
                // 주기적 스캔 제거 (안전망 제거)
                // setInterval(scanTask, 5000); // 제거됨
            }

            // fullscreen 변경 시 UI 루트 이동
            addOnceEventListener(document, 'fullscreenchange', () => {
                    uiManager.moveUiTo(document.fullscreenElement || document.body);
                });

            startUnifiedObserver(targetDocument);
            scanTask(); // 초기 스캔
            // 스크립트 실행 시점에 이미 존재하는 iframe 처리
            try {
                targetDocument.querySelectorAll('iframe').forEach(ifr => initIframe(ifr));
            } catch (e) {}
        }
        return { initializeAll };
    })();

    /* 페이지 언로드 시 전체 정리 (모든 문서/iframe observer disconnect) */
    window.addEventListener('unload', () => {
        try {
            for (const [doc, obs] of OBSERVER_MAP.entries()) {
                try { obs.disconnect(); } catch (e) {}
            }
            OBSERVER_MAP.clear();
            PROCESSED_DOCUMENTS = new WeakSet();
            activeMediaCache = [];
        } catch (e) {}
    }, { capture: true });

    /* ============================
     * 스크립트 실행
     * ============================ */
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        App.initializeAll(document);
    } else {
        window.addEventListener('DOMContentLoaded', () => App.initializeAll(document), { once: true });
    }
})();
