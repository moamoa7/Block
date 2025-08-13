// ==UserScript==
// @name         VideoSpeed_Control
// @namespace    https.com/
// @version      22.1 (팝업 차단 로직 제거)
// @description  🎞️ [개선판] UI ShadowDOM 격리 + ⚡성능 최적화 + 🔧YouTube 탐지 강화 + ✨미디어 세션 API 연동
// @match        *://*/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        none
// @connect      *
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

    const FeatureFlags = {
        videoControls: true,
        logUI: true,
        enhanceURLDetection: true,
        spaPartialUpdate: true,
        detailedLogging: true,
        logLevel: 'INFO',
        previewFiltering: true,
        iframeProtection: true,
        enforceIframeSandbox: false,
        preventUnloadRedirects: true,
        mediaSessionIntegration: true, // ✨ 신규 기능: 미디어 세션 API 연동 플래그
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
        XMLHttpRequest: {
            open: window.XMLHttpRequest.prototype.open,
            send: window.XMLHttpRequest.prototype.send
        },
        Fetch: window.fetch,
        URL: {
            createObjectURL: window.URL.createObjectURL
        },
        MediaSource: {
            addSourceBuffer: window.MediaSource?.prototype.addSourceBuffer
        },
        WebSocket: window.WebSocket,
        window: {
            open: window.open,
            showModalDialog: window.showModalDialog,
            onbeforeunload: window.onbeforeunload
        }
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
     * 🔧 로직 강화: ConfigManager (Modern GM API 지원 및 비동기 처리)
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
            // 우선순위: localStorage -> GM.* API -> GM_* API -> 기본값
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
                        const val = await this.get(path); // Use async get
                        const parts = path.split('.');
                        let cur = this.opts.config;
                        for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]]; }
                        cur[parts[parts.length - 1]] = val;
                    }
                }
            } catch (e) {}
        }
    }
    const configManager = new ConfigManager({ prefix: '_video_speed_', config: { isMinimized: true, isInitialized: false } });

    /* ============================
     * Live FeatureFlags (console에서 즉시 반영)
     * ============================ */
    (async function enableLiveFeatureFlags(){
        await configManager.init(); // 설정 로드 대기
        const listeners = new Set();
        function notify(k,v){ try{ listeners.forEach(fn=>fn(k,v)); }catch{} }

        const flagsKey = '_feature_flags_cache';
        const initial = Object.assign({}, FeatureFlags, await configManager.get(flagsKey) || {});
        Object.keys(FeatureFlags).forEach(k => { if (k in initial) { FeatureFlags[k] = initial[k]; } });

        const proxy = new Proxy(FeatureFlags, {
            get(t, p){ return Reflect.get(t,p); },
            set(t, p, v){
                const ok = Reflect.set(t,p,v);
                try {
                    // 비동기 set 호출, 하지만 프록시 set은 async가 될 수 없으므로 await하지 않음 (fire and forget)
                    configManager.set(flagsKey, Object.assign({}, t));
                    logManager && logManager.addOnce(`flag_${String(p)}_${String(v)}`, `🧩 FeatureFlag 변경: ${String(p)} = ${String(v)}`, 2500, 'info');
                    notify(String(p), v);
                } catch {}
                return ok;
            }
        });

        window.VSC = Object.assign(window.VSC||{}, {
            flags: proxy,
            setFlag: (k,v)=>{ proxy[k] = v; },
            onFlagChange: (fn)=>{ listeners.add(fn); return ()=>listeners.delete(fn); }
        });
    })();

    /* ============================
     * 유틸: addOnceEventListener, throttle, debounce, copyToClipboard 등
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
            logManager.logErrorWithContext(e, { message: 'addManagedEventListener failed' });
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
                logManager.addOnce(`listeners_cleared_${el.tagName}`, `🎧 Listeners cleaned for removed <${el.tagName}>`, 5000, 'debug');
            }
        } catch (e) {
            logManager.logErrorWithContext(e, { message: 'removeAllManagedEventListeners failed' });
        }
    }

    function throttle(fn, wait) {
        let last = 0, timer = null;
        return function (...args) {
            const now = Date.now();
            if (now - last >= wait) { last = now; fn.apply(this, args); }
            else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, wait - (now - last)); }
        };
    }
    function debounce(fn, wait) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; }
    async function copyToClipboard(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {
            logManager.add('클립보드 API 실패, 폴백 시도', 'warn');
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            ta.focus();
            const successful = document.execCommand('copy');
            document.body.removeChild(ta);
            if (successful) {
                return true;
            }
        } catch (e) {
            logManager.logErrorWithContext(e, { message: 'Textarea 클립보드 복사 실패' });
        }
        return false;
    }

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
            deletePreview(m) { try { previews.delete(m); } catch (e) {} },
            isPreview(m) { try { return previews.has(m); } catch (e) { return false; } },
            addIframe(i) { try { iframes.add(i); } catch (e) {} },
            hasIframe(i) { try { return iframes.has(i); } catch (e) { return false; } },
            deleteIframe(i) { try { iframes.delete(i); } catch (e) {} },
            resetAll() { /* WeakMap은 GC에 맡김 */ }
        };
    })();

    let PROCESSED_DOCUMENTS = new WeakSet();
    const LOGGED_KEYS_WITH_TIMER = new Map();
    const isTopFrame = window.self === window.top;
    const OBSERVER_MAP = new Map();

    /* ============================
     * 💡 아키텍처 개선: UI Manager (Shadow DOM 캡슐화)
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
                :host {
                    pointer-events: none;
                }
                * {
                    pointer-events: auto;
                }
                /* Log Manager UI */
                #vm-log-container { position: fixed; bottom: 0; right: 0; width: 350px; max-height: 30px; z-index: 100; pointer-events: none; background: transparent; color: #fff; font-family: monospace; font-size: 14px; border-top-left-radius: 8px; overflow: hidden; opacity: 0; transition: opacity 0.3s ease, max-height 0.3s ease; box-shadow: none; }
                #vm-log-container:hover { max-height: 200px; }
                #vm-log-copy-btn { position: absolute; top: 0; right: 0; background: #c0392b; color: #fff; border: none; border-bottom-left-radius: 8px; padding: 4px 8px; font-size: 14px; cursor: pointer; z-index: 101; opacity: 0.8; }
                #vm-log-box { max-height: 100%; overflow-y: auto; padding: 8px; padding-top: 25px; user-select: text; text-align: left; background: rgba(30, 30, 30, 0.7); backdrop-filter: blur(2px); border-top-left-radius: 8px; }

                /* Speed Slider UI */
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity .2s, width .3s, background .2s; pointer-events: auto; }
                #vm-speed-slider-container:hover { opacity: 1; background: rgba(0,0,0,0.4); }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 0; accent-color: #e74c3c; }
                #vm-speed-value { color: #f44336; font-weight: bold; font-size: 14px; margin-top: 6px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin:4px 0; }
                .vm-toggle-btn { transition: transform 0.2s ease-in-out; }

                /* Drag Bar UI */
                #vm-time-display { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 102; background: rgba(0,0,0,0.7); color: #fff; padding: 10px 20px; border-radius: 5px; font-size: 1.5rem; display: none; opacity: 1; transition: opacity 0.3s ease-out; pointer-events: none; }

                /* Dynamic Media UI */
                #dynamic-media-url-btn { position: fixed; top: 45px; right: 10px; z-index: 100; background: rgba(0,0,0,0.6); color: #fff; border: none; padding: 6px 8px; border-radius: 6px; display: none; cursor: pointer; transition: background 0.3s; opacity: 1; }
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
     * 로그 모듈 (XSS 안전 및 UI 지연 초기화)
     * ============================ */
    const logManager = (() => {
        let container = null, box = null, history = [], pending = [];
        let dismissTimer = null;
        function showLogContainer() {
            if (!container) return;
            container.style.opacity = '1';
            container.style.pointerEvents = 'auto';
            if (dismissTimer) clearTimeout(dismissTimer);
            dismissTimer = setTimeout(() => {
                container.style.opacity = '0';
                container.style.pointerEvents = 'none';
            }, 10000);
        }
        function safeAdd(msg, level = 'info') {
            const levels = { 'debug': 0, 'info': 1, 'warn': 2, 'error': 3, 'popup': 1 };
            const currentLevel = levels[FeatureFlags.logLevel.toLowerCase()] || 1;
            const msgLevel = levels[level] || 1;
            if (msgLevel < currentLevel) return;

            const icons = { info: 'ℹ️', warn: '⚠️', error: '🔴', allow: '✅', debug: '🔧', stream: '▶️', global: '💥', popup: '🛡️' };
            const full = `[${new Date().toLocaleTimeString()}] ${icons[level] || ''} ${msg}`;
            if (FeatureFlags.detailedLogging) {
                if (console[level] && typeof console[level] === 'function') console[level](full); else console.log(full);
            }

            if (!FeatureFlags.logUI) return;
            if (!isTopFrame) {
                try { window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: full, level, key: msg }, '*'); } catch (e) { }
                return;
            }

            if (!container) {
                initUI();
            }

            if (!box) { pending.push(full); return; }
            history.push(full); if (history.length > 100) history.shift();
            const el = document.createElement('div'); el.textContent = full;
            while(box.childElementCount >= 100) box.removeChild(box.firstChild);
            box.appendChild(el); box.scrollTop = box.scrollHeight;
            showLogContainer();
        }
        function add(msg, lvl = 'info') { safeAdd(msg, lvl); }
        function addOnce(key, msg, delay = 6000, lvl = 'info') {
            const now = Date.now();
            for (const [k, t] of LOGGED_KEYS_WITH_TIMER) if (now - t > delay) LOGGED_KEYS_WITH_TIMER.delete(k);
            if (!LOGGED_KEYS_WITH_TIMER.has(key)) { LOGGED_KEYS_WITH_TIMER.set(key, now); safeAdd(msg, lvl); }
        }
        function initUI() {
            if (!isTopFrame || container) return;
            const shadowRoot = uiManager.getShadowRoot();

            container = document.createElement('div');
            container.id = 'vm-log-container';

            const copyBtn = document.createElement('button');
            copyBtn.id = 'vm-log-copy-btn';
            copyBtn.textContent = '로그 복사';
            copyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await copyToClipboard(history.join('\n'));
                copyBtn.textContent = ok ? '복사 완료' : '복사 실패'; setTimeout(() => copyBtn.textContent = '로그 복사', 1500);
            });

            box = document.createElement('div');
            box.id = 'vm-log-box';

            container.addEventListener('mouseenter', () => container.style.maxHeight = '200px');
            container.addEventListener('mouseleave', () => container.style.maxHeight = '30px');
            container.appendChild(copyBtn); container.appendChild(box);
            shadowRoot.appendChild(container);

            pending.forEach(p => { const e = document.createElement('div'); e.textContent = p; box.appendChild(e); }); pending = [];
        }
        function logMediaContext(media, message, level = 'info') {
            if (!FeatureFlags.detailedLogging || !media) return;
            try {
                const rect = media.getBoundingClientRect();
                const playing = !media.paused;
                const src = media.currentSrc || media.src || 'none';
                const duration = isFinite(media.duration) ? media.duration.toFixed(1) : 'N/A';
                addOnce(`media_${src}_${message}`, `🎬 ${message} | src:${src.substring(0, 50)}... | ${Math.round(rect.width)}x${Math.round(rect.height)} | ${duration}s | ${playing ? '재생중' : '정지'}`, 5000, level);
            } catch (e) {}
        }
        function logIframeContext(iframe, message) {
            if (!FeatureFlags.detailedLogging) return;
            try {
                const src = iframe.src || 'about:blank';
                addOnce(`iframe_${src}_${message}`, `🧩 iframe ${message} | src: ${src}`, 6000, 'info');
            } catch (e) {}
        }
        function logErrorWithContext(err, ctx) {
            if (!FeatureFlags.detailedLogging) return;
            const contextMessage = typeof ctx === 'object' && ctx.message ? ctx.message : (ctx && ctx.tagName ? ctx.tagName : 'N/A');
            const message = `❗ 에러: ${err?.message || err} | 컨텍스트: ${contextMessage}`;
            const stack = err && err.stack ? err.stack : 'No stack trace available';
            addOnce(`err_${Date.now()}`, message, 10000, 'error');
            console.error(`[VideoSpeed_Control Error] ${message}\nContext Object:`, ctx || 'N/A', '\nStack Trace:\n', stack);
        }
        return { init: initUI, add, addOnce, logMediaContext, logIframeContext, logErrorWithContext };
    })();

    /* ============================
     * 전역 에러 핸들링
     * ============================ */
    (function setupGlobalErrorHandlers() {
        if (!isTopFrame) return;
        const errorHandler = (err, context) => {
            try {
                const errMsg = err ? (err.message || String(err)) : 'Unknown error';
                if (errMsg.includes('ResizeObserver loop completed with undelivered notifications')) {
                    return;
                }
                logManager.addOnce(`global_err_${errMsg.substring(0, 50)}`, `💥 전역 에러 감지: ${errMsg}`, 10000, 'global');
                logManager.logErrorWithContext(err, context);
            } catch (e) {
                console.error('[VSC] Global error handler failed:', e);
            }
        };
        addOnceEventListener(window, 'error', event => {
            errorHandler(event.error || event.message, { message: 'Global window.onerror' });
        });
        addOnceEventListener(window, 'unhandledrejection', event => {
            errorHandler(event.reason, { message: 'Unhandled Promise Rejection' });
        });
    })();

    /* ============================
     * 미리보기 감지
     * ============================ */
    const PREVIEW_CONFIG = {
        PATTERNS: [
            /preview/i, /thumb/i, /sprite/i, /teaser/i, /sample/i, /poster/i, /thumbnail/i,
            /teaser_clip/i, /trailers?/i, /trailer_/i, /clip_preview/i,
            /sprite_/i, /sprite-/i, /thumbs?\//i, /thumbsprite/i, /thumb_strip/i,
            /sample_clip/i, /demo(s)?\//i, /clip_sample/i,
            /preroll/i, /pre_roll/i, /ads_preview/i,
            /scene_preview/i, /scenepreview/i, /snapshots?/i,
            /posterframe/i, /poster_frame/i, /cover_preview/i,
            /lowres/i, /low_res/i, /mini_preview/i, /micro_preview/i
        ],
        DURATION_THRESHOLD: 12,
        MIN_PIXEL_AREA: 2000,
        LOG_LEVEL_FOR_SKIP: 'warn'
    };
    function isPreviewURL(url) {
        if (!url || typeof url !== 'string') return false;
        try { const u = url.toLowerCase(); return PREVIEW_CONFIG.PATTERNS.some(p => p.test(u)); } catch (e) { return false; }
    }

    /* ============================
     * YouTube 데이터 직접 요청
     * ============================ */
    const youtubeMediaFinder = (() => {
        function parsePlayerResponse(playerResponse) {
            if (!playerResponse) return [];
            let urls = [];
            try {
                const streamingData = playerResponse.streamingData;
                if (streamingData) {
                    const formats = (streamingData.formats || []).concat(streamingData.adaptiveFormats || []);
                    const extractedUrls = formats
                        .map(fmt => fmt.url || (fmt.signatureCipher && new URLSearchParams(fmt.signatureCipher).get('url')))
                        .filter(Boolean);
                    urls = urls.concat(extractedUrls);
                }
                return [...new Set(urls)];
            } catch (e) {
                logManager.logErrorWithContext(e, { message: 'parsePlayerResponse failed' });
                return [];
            }
        }
        function extractAndParsePlayerResponse(html) {
            if (!html) return [];
            let playerResponse = null;
            try {
                let match = html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s);
                if (match && match[1]) {
                    playerResponse = JSON.parse(match[1]);
                }
                if (!playerResponse) {
                    match = html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
                    if (match && match[1]) {
                        playerResponse = JSON.parse(match[1]);
                    }
                }
                if (!playerResponse) {
                    const cfgMatchAll = html.matchAll(/ytcfg\.set\(({.+?})\);/gs);
                    for (const cfgMatch of cfgMatchAll) {
                        if (cfgMatch && cfgMatch[1]) {
                            const cfg = JSON.parse(cfgMatch[1]);
                            if (cfg && cfg.PLAYER_VARS && cfg.PLAYER_VARS.player_response) {
                                const respData = cfg.PLAYER_VARS.player_response;
                                playerResponse = typeof respData === 'string' ? JSON.parse(respData) : respData;
                                if (playerResponse) break;
                            } else if (cfg && cfg.playerResponse) {
                                playerResponse = cfg.playerResponse;
                                if (playerResponse) break;
                            }
                        }
                    }
                }
            } catch (e) {
                logManager.logErrorWithContext(e, { message: 'extractAndParsePlayerResponse failed' });
                return [];
            }
            return parsePlayerResponse(playerResponse);
        }
        function fetchAndParse() {
            if (typeof GM_xmlhttpRequest !== 'function') {
                logManager.add('GM_xmlhttpRequest를 사용할 수 없어 YT 감지가 제한됩니다.', 'warn');
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: location.href,
                onload: function(response) {
                    try {
                        if (response.status < 200 || response.status >= 300) return;
                        const html = response.responseText;
                        const urls = extractAndParsePlayerResponse(html);
                        urls.forEach(url => {
                            if (url && !networkMonitor.isTracked(url)) {
                                logManager.addOnce(`yt_detect_${url.slice(0, 100)}`, `🎯 [YT] 동적 영상 URL 감지: ${url.slice(0, 100)}...`, 5000, 'info');
                                networkMonitor.trackAndAttach(url, { source: 'youtubeMediaFinder.GM' });
                            }
                        });
                    } catch (e) {
                        logManager.logErrorWithContext(e, { message: 'GM_xmlhttpRequest onload failed' });
                    }
                },
                onerror: function(error) {
                    logManager.logErrorWithContext(error, { message: 'GM_xmlhttpRequest failed' });
                }
            });
        }
        function isYouTubeMediaUrl(url) {
            if (!url || typeof url !== 'string') return false;
            try {
                const u = new URL(url);
                return (u.hostname.endsWith('youtube.com') || u.hostname.endsWith('googlevideo.com')) &&
                       (url.includes('.m3u8') || url.includes('.mpd') || url.includes('videoplayback'));
            } catch {
                return false;
            }
        }
        function scanAndTrack() {
            fetchAndParse();
        }
        return { isYouTubeMediaUrl, scanAndTrack, parsePlayerResponse, extractAndParsePlayerResponse };
    })();

    /* ============================
     * ⚡ 성능 최적화 & 🔧 로직 강화: networkMonitor
     * ============================ */
    const networkMonitor = (() => {
        const VIDEO_URL_CACHE = new Map();
        const BLOB_URL_MAP = new Map();
        const MAX_CACHE_SIZE = 500;
        const CACHE_EXPIRATION_TIME = 3 * 60 * 1000;
        let initialized = false;

        const VIDEO_EXT_REGEX = /\.(mp4|webm|m3u8|mpd|ts|m4s)(\?|#|$)/i;
        const IMAGE_EXT_REGEX = /\.(jpe?g|png|gif|webp|svg)(\?|#|$)/i;
        const MEDIA_SEGMENT_REGEX = /\.(ts|m4s|aac)(\?|#|$)/i;
        const YOUTUBE_URL_REGEX = /youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\//i;
        const VIDEO_MIME_PATTERN = /(video|application\/(dash\+xml|vnd\.apple\.mpegurl|x-mpegURL))/i;
        const ABS_URL_REGEX = /^[a-z][a-z0-9+\-.]*:/i;
        const URL_REGEX = /\bhttps?:\/\/[^\s'"<>]+/gi;
        const YOUTUBE_PLAYER_API_REGEX = /\/youtubei\/v1\/player/i; // 🔧 로직 강화: YouTube 플레이어 API 정규식

        const SKIP_HOSTS = [
            'doubleclick.net','googletagservices.com','googlesyndication.com','adservice.google.com',
            'scorecardresearch.com','facebook.com','google-analytics.com','analytics.google.com',
            'hotjar.com','branch.io','adjust.com','app-measurement.com'
        ];
        function isAdOrBeacon(u){
            try { const h = new URL(u, location.href).hostname; return SKIP_HOSTS.some(s=>h.endsWith(s)); } catch{ return false; }
        }
        function shouldInspectByMime(ct){
            if (!ct) return false;
            ct = ct.toLowerCase();
            return ct.startsWith('video/') ||
                   ct.includes('application/dash+xml') ||
                   ct.includes('application/vnd.apple.mpegurl') ||
                   ct.includes('application/x-mpegurl') ||
                   ct.startsWith('audio/');
        }
        function maybeContainsMediaURL(text){
            return /https?:\/\/[^\s"'<>]+?\.(?:m3u8|mpd|mp4|webm|ts|m4s)(?:[?#][^\s"'<>]*)?/i.test(text);
        }

        // ⚡ 성능 최적화: 텍스트 기반 콘텐츠 타입인지 확인하는 헬퍼
        function isTextBasedContentType(ct){
            if (!ct) return false;
            return /json|text|xml|mpegurl|x-www-form-urlencoded/i.test(ct);
        }

        const isMediaSegment = (url) => {
            if (typeof url !== 'string') return false;
            return MEDIA_SEGMENT_REGEX.test(url);
        };
        const isMediaUrl = (url) => {
            if (typeof url !== 'string') return false;
            if (IMAGE_EXT_REGEX.test(url)) return false;
            return VIDEO_EXT_REGEX.test(url) || YOUTUBE_URL_REGEX.test(url) || youtubeMediaFinder.isYouTubeMediaUrl(url) || url.includes('mime=video') || url.includes('type=video') || url.includes('mime=audio');
        };
        const isMediaMimeType = (mime) => {
            if (typeof mime !== 'string') return false;
            return VIDEO_MIME_PATTERN.test(mime) || mime.includes('audio/');
        };
        const normalizeURL = (url, base) => {
            try {
                if (!ABS_URL_REGEX.test(url)) {
                    return new URL(url, base || location.href).href;
                }
            } catch {}
            return url;
        };
        function cleanupCache() {
            const now = Date.now();
            for (const [url, data] of VIDEO_URL_CACHE.entries()) {
                if (now - data.timestamp > CACHE_EXPIRATION_TIME) {
                    VIDEO_URL_CACHE.delete(url);
                }
            }
        }
        setInterval(cleanupCache, 60 * 1000);

        function extractURLsFromText(text) {
            if (!text) return [];
            const matches = text.match(URL_REGEX);
            return matches ? [...new Set(matches.filter(isMediaUrl))] : [];
        }
        function extractURLsFromBinary(bin) {
            try {
                const ascii = new TextDecoder('utf-8').decode(bin);
                return extractURLsFromText(ascii);
            } catch { return []; }
        }
        function extractURLsFromJSON(obj) {
            let urls = [];
            if (typeof obj === 'string') return extractURLsFromText(obj);
            if (typeof obj === 'object' && obj !== null) {
                for (const key in obj) {
                    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
                    const val = obj[key];
                    if (typeof val === 'string' && val.match(URL_REGEX)) {
                        urls = urls.concat(extractURLsFromText(val));
                    } else if (typeof val === 'object') {
                        urls = urls.concat(extractURLsFromJSON(val));
                    }
                }
            }
            return urls;
        }
        function parseMP4Boxes(buffer) {
            const view = new DataView(buffer);
            let offset = 0;
            const boxes = [];
            while (offset + 8 <= buffer.byteLength) {
                const size = view.getUint32(offset);
                const typeArr = new Uint8Array(buffer, offset + 4, 4);
                const type = String.fromCharCode(...typeArr);
                boxes.push({ size, type });
                if (size === 0) break;
                offset += size;
            }
            return boxes;
        }
        function isHLSPlaylist(text) {
            return text.includes('#EXTM3U') && (text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-TARGETDURATION') || text.includes('#EXT-X-MEDIA'));
        }
        function trackAndAttach(url, ctx = {}) {
            if (!url || typeof url !== 'string') return;
            if (isMediaSegment(url)) {
                logManager.addOnce(`skip_segment_${url}`, `🔧 [Skip:Segment] 미디어 세그먼트 요청 무시: ${url.substring(0,80)}...`, 10000, 'debug');
                return;
            }
            const norm = normalizeURL(url);
            if (VIDEO_URL_CACHE.has(norm)) {
                const cacheEntry = VIDEO_URL_CACHE.get(norm);
                cacheEntry.timestamp = Date.now();
                return;
            }
            if (FeatureFlags.previewFiltering && isPreviewURL(norm)) {
                logManager.addOnce(`skip_preview_${norm}`, `🔴 [Skip:Preview] 미리보기로 판단되어 무시: ${norm}`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                return;
            }
            VIDEO_URL_CACHE.set(norm, { timestamp: Date.now() });
            if (VIDEO_URL_CACHE.size > MAX_CACHE_SIZE) {
                setTimeout(() => {
                    const first = VIDEO_URL_CACHE.keys().next().value;
                    if (first) VIDEO_URL_CACHE.delete(first);
                }, 0);
            }
            const details = [];
            if (ctx.source) details.push(`src:${ctx.source}`);
            if (ctx.rect) details.push(`size:${Math.round(ctx.rect.width)}x${Math.round(ctx.rect.height)}`);
            logManager.addOnce(`early_${norm}`, `🎯 동적 영상 URL 감지: ${norm.substring(0, 80)}... | ${details.join(' | ')}`, 5000, 'info');
            try { if (FeatureFlags.videoControls) dynamicMediaUI && dynamicMediaUI.show(norm); } catch (e) {}
            if (ctx.element && !MediaStateManager.has(ctx.element)) {
                MediaStateManager.set(ctx.element, { trackedUrl: norm, isInitialized: false });
            }
        }
        function parseMPD(xmlText, baseURL) {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(xmlText, 'application/xml');
                if (doc.querySelector('parsererror')) { throw new Error('Invalid XML'); }
                const base = doc.querySelector('BaseURL')?.textContent?.trim();
                const effectiveBase = base ? normalizeURL(base, baseURL) : baseURL;
                doc.querySelectorAll('SegmentTemplate').forEach(st => {
                    const init = st.getAttribute('initialization');
                    const media = st.getAttribute('media');
                    if (init) trackAndAttach(normalizeURL(init, effectiveBase), {source: 'MPD init'});
                    if (media) trackAndAttach(normalizeURL(media, effectiveBase), {source: 'MPD media'});
                });
                doc.querySelectorAll('SegmentList > SegmentURL').forEach(seg => {
                    const media = seg.getAttribute('media');
                    if (media) trackAndAttach(normalizeURL(media, effectiveBase), {source: 'MPD Segment'});
                });
                doc.querySelectorAll('BaseURL').forEach(bu => {
                    const url = bu.textContent?.trim();
                    if (url) trackAndAttach(normalizeURL(url, effectiveBase), {source: 'MPD BaseURL'});
                });
            } catch (e) { logManager.logErrorWithContext(e, { message: 'MPD 파싱 실패', url: baseURL }); }
        }

        function parseM3U8(text, baseURL) {
            const urls = new Set();
            try {
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const l = lines[i].trim();
                    if (!l || l.startsWith('#EXT-X-ENDLIST')) continue;

                    let potentialUrl = null;

                    if (l.startsWith('#EXT-X-STREAM-INF')) {
                        potentialUrl = lines[i + 1]?.trim();
                        if (potentialUrl && !potentialUrl.startsWith('#')) i++;
                    } else if (l.startsWith('#EXT-X-MEDIA')) {
                        const uriMatch = l.match(/URI="([^"]+)"/);
                        if (uriMatch && uriMatch[1]) potentialUrl = uriMatch[1];
                    } else if (l && !l.startsWith('#')) {
                        potentialUrl = l;
                    }

                    if (potentialUrl) {
                        const normalizedUrl = normalizeURL(potentialUrl, baseURL);
                        if (isMediaUrl(normalizedUrl)) {
                            urls.add(normalizedUrl);
                        } else {
                             logManager.addOnce(`ignored_m3u8_seg_${normalizedUrl}`, `🔧 [Skip] M3U8에서 유효하지 않은 세그먼트 무시: ${normalizedUrl}`, 10000, 'debug');
                        }
                    }
                }
                if (urls.size > 0) {
                    logManager.addOnce(`m3u8_parsed_${baseURL}`, `🔍 M3U8 파싱 완료 (${urls.size}개 URL 발견): ${baseURL}`, 5000, 'debug');
                }
            } catch (e) { logManager.logErrorWithContext(e, { message: 'M3U8 파싱 실패', url: baseURL }); }
            return [...urls];
        }

        const handleResponse = async (url, resp) => {
            try {
                if (url && IMAGE_EXT_REGEX.test(url)) return;
                if(!url || isMediaSegment(url) || isAdOrBeacon(url)) return;

                const ct = (resp.headers.get('content-type') || '').toLowerCase();
                const cl = parseInt(resp.headers.get('content-length') || '0', 10);

                // 🔧 로직 강화: YouTube 플레이어 API 응답 특별 처리
                if (YOUTUBE_PLAYER_API_REGEX.test(url)) {
                    logManager.addOnce('yt_player_api_detected', '🎯 [YT] 플레이어 API 요청 감지', 5000, 'debug');
                    const responseData = await resp.clone().json();
                    const urls = youtubeMediaFinder.parsePlayerResponse(responseData);
                    urls.forEach(u => trackAndAttach(u, { source: 'youtube-player-api' }));
                    return;
                }

                if (isMediaUrl(url)) {
                    trackAndAttach(url, { source: 'fetch/xhr' });
                    // ⚡ 성능 최적화: 텍스트 기반 콘텐츠 타입일 때만 파싱 시도
                    if (isTextBasedContentType(ct)) {
                        const text = await resp.clone().text();
                        if (url.endsWith('.mpd') || ct.includes('application/dash+xml')) {
                            parseMPD(text, url);
                        } else if (url.endsWith('.m3u8') || isHLSPlaylist(text)) {
                            const found = parseM3U8(text, url);
                            found.forEach(u => trackAndAttach(u, { source: 'M3U8 SubPlaylist/Track' }));
                        }
                    }
                    return;
                }

                if (shouldInspectByMime(ct)) {
                    if (IMAGE_EXT_REGEX.test(url)) {
                        logManager.addOnce(`skip_image_like_video_${url}`, `🔧 [Skip] 비디오 MIME 타입을 가졌지만 이미지 URL이므로 무시: ${url.substring(0,80)}...`, 10000, 'debug');
                        return;
                    }
                    trackAndAttach(url, { source: 'fetch/xhr mime' });
                    if (isTextBasedContentType(ct)) {
                        const text = await resp.clone().text();
                        if (ct.includes('application/dash+xml')) {
                            parseMPD(text, url);
                        } else if (ct.includes('mpegurl') || isHLSPlaylist(text)) {
                            const found = parseM3U8(text, url);
                            found.forEach(u => trackAndAttach(u, { source: 'M3U8 SubPlaylist/Track' }));
                        }
                    }
                    return;
                }

                // ⚡ 성능 최적화: 텍스트 기반이 유력한 경우에만 내용 스캔 (용량 제한)
                if (cl > 0 && cl < 1_000_000 && isTextBasedContentType(ct)) {
                    const textPeek = await resp.clone().text();
                    if (maybeContainsMediaURL(textPeek)) {
                        extractURLsFromText(textPeek).forEach(u => {
                            if(isMediaUrl(u)) trackAndAttach(u, { source: 'heuristic' });
                        });
                    }
                }
            } catch (e) {
                logManager.logErrorWithContext(e, { message: 'handleResponse optimized failed', url: url });
            }
        };

        function hookXHR() {
            if (!originalMethods.XMLHttpRequest.open || !originalMethods.XMLHttpRequest.send) return;
            window.XMLHttpRequest.prototype.open = function (method, url) {
                if (url && typeof url === 'string') {
                    this._reqUrl = url;
                    if (youtubeMediaFinder.isYouTubeMediaUrl(url)) {
                        trackAndAttach(url, { source: 'xhr.open (yt)' });
                    }
                }
                return originalMethods.XMLHttpRequest.open.apply(this, arguments);
            };
            window.XMLHttpRequest.prototype.send = function (...args) {
                this.addEventListener('load', function () {
                    try {
                        const url = normalizeURL(this._reqUrl);
                        // XHR Response는 타입 구분이 어려우므로, Response 객체를 만들어 일관되게 처리
                        const headers = new Headers();
                        const ct = this.getResponseHeader && this.getResponseHeader('Content-Type');
                        if (ct) headers.set('content-type', ct);
                        const response = new Response(this.response, { headers });
                        handleResponse(url, response);
                    } catch (e) { logManager.logErrorWithContext(e, { message: 'XHR load handler failed' }); }
                });
                return originalMethods.XMLHttpRequest.send.apply(this, args);
            };
        }
        function hookFetch() {
            if (!originalMethods.Fetch) return;
            window.fetch = async function (...args) {
                let reqURL = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
                if (reqURL && isAdOrBeacon(reqURL)) {
                    return originalMethods.Fetch.apply(this, args);
                }
                if (reqURL && youtubeMediaFinder.isYouTubeMediaUrl(reqURL)) {
                    trackAndAttach(reqURL, { source: 'fetch (yt)' });
                }
                try {
                    const res = await originalMethods.Fetch.apply(this, args);
                    handleResponse(reqURL, res.clone());
                    return res;
                } catch (err) {
                    if(!String(err).includes('Failed to fetch')) {
                        logManager.logErrorWithContext(err, { message: 'fetch failed', url: reqURL });
                    }
                    throw err;
                }
            };
        }
        function hookBlob() {
            if (window.MediaSource && originalMethods.MediaSource.addSourceBuffer) {
                MediaSource.prototype.addSourceBuffer = function (mime) {
                    try {
                        logManager.addOnce(`mse_mime_${mime}`, `🧩 MSE MIME 감지: ${mime}`, 5000, 'info');
                        const sourceBuffer = originalMethods.MediaSource.addSourceBuffer.apply(this, arguments);
                        const origAppendBuffer = sourceBuffer.appendBuffer;
                        sourceBuffer.appendBuffer = function(buffer) {
                            try {
                                const boxes = parseMP4Boxes(buffer.buffer || buffer);
                                for (const box of boxes) {
                                    if (box.type === 'ftyp' || box.type === 'moof') {
                                        logManager.addOnce(`mse_dash_${box.type}`, `🧩 DASH 세그먼트 감지: ${box.type}`, 5000, 'info');
                                    }
                                }
                            } catch (e) { logManager.logErrorWithContext(e, { message: 'appendBuffer hook failed' }); }
                            return origAppendBuffer.apply(this, arguments);
                        };
                        return sourceBuffer;
                    } catch (e) {
                        logManager.logErrorWithContext(e, { message: 'addSourceBuffer hook failed' });
                        return originalMethods.MediaSource.addSourceBuffer.apply(this, arguments);
                    }
                };
            }
            if (originalMethods.URL.createObjectURL) {
                URL.createObjectURL = function (obj) {
                    const url = originalMethods.URL.createObjectURL.apply(this, arguments);
                    try {
                        if (obj instanceof MediaSource) {
                            BLOB_URL_MAP.set(url, { type: 'MediaSource' });
                            logManager.addOnce(`blob_ms_${url}`, `🔗 MediaSource Blob: ${url}`, 5000, 'info');
                        } else if (obj instanceof Blob) {
                            BLOB_URL_MAP.set(url, { type: 'Blob' });
                            logManager.addOnce(`blob_blob_${url}`, `🔗 Blob URL: ${url}`, 5000, 'info');
                            if (obj.type.startsWith('video/') || obj.type.includes('mpegurl')) {
                                trackAndAttach(url, { type: 'blob-url' });
                            }
                        }
                    } catch (e) {}
                    return url;
                };
            }
        }
        function hookWebSocket() {
            if (!originalMethods.WebSocket) return;
            window.WebSocket = function(url, protocols) {
                const ws = protocols ? new originalMethods.WebSocket(url, protocols) : new originalMethods.WebSocket(url);
                function tryParseAndTrack(data) {
                    try {
                        if (typeof data === 'string') {
                            let urls = [];
                            try {
                                const json = JSON.parse(data);
                                urls = extractURLsFromJSON(json);
                            } catch { urls = extractURLsFromText(data); }
                            urls.forEach(u => networkMonitor.trackAndAttach(u, { source: 'websocket-message' }));
                        } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
                            const bin = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
                            const urls = extractURLsFromBinary(bin);
                            urls.forEach(u => networkMonitor.trackAndAttach(u, { source: 'websocket-message' }));
                        } else if (data instanceof Blob) {
                            const reader = new FileReader();
                            reader.onload = () => {
                                try {
                                    const bin = new Uint8Array(reader.result);
                                    const urls = extractURLsFromBinary(bin);
                                    urls.forEach(u => networkMonitor.trackAndAttach(u, { source: 'websocket-blob' }));
                                } catch(e) { logManager.logErrorWithContext(e, { message: 'WebSocket Blob 처리 실패' }); }
                            };
                            reader.onerror = () => { logManager.add('WebSocket Blob 읽기 실패', 'warn'); };
                            reader.readAsArrayBuffer(data);
                        }
                    } catch (e) {
                        logManager.logErrorWithContext(e, { message: 'WebSocket 메시지 파싱 실패' });
                    }
                }
                ws.addEventListener('message', event => { tryParseAndTrack(event.data); });
                trackAndAttach(url, { source: 'websocket-connection' });
                return ws;
            };
        }
        function hookElementCreation() {
            if (!originalMethods.Document.createElement) return;

            document.createElement = function(...args) {
                const element = originalMethods.Document.createElement.apply(this, args);
                try {
                    if (args[0] && typeof args[0] === 'string' && args[0].toLowerCase() === 'script') {
                        let srcCache = '';
                        let typeCache = '';
                        Object.defineProperties(element, {
                            'src': {
                                get() { return srcCache; },
                                set(value) {
                                    srcCache = value;
                                    logManager.addOnce(`script_src_set_${value}`, `📜 동적 스크립트 src 설정됨: ${value}`, 5000, 'debug');
                                    if (isMediaUrl(value)) {
                                        trackAndAttach(value, { source: 'dynamic-script-src' });
                                    }
                                    element.setAttribute('src', value);
                                    return true;
                                }
                            },
                            'type': {
                                get() { return typeCache; },
                                set(value) {
                                    typeCache = value;
                                    element.setAttribute('type', value);
                                    return true;
                                }
                            },
                            'textContent': {
                                set(value) {
                                    if (typeCache === 'module') {
                                        logManager.addOnce(`module_script_added`, `📜 동적 모듈 스크립트 감지. 내용 분석 시도.`, 5000, 'debug');
                                        extractURLsFromText(value).forEach(url => {
                                            trackAndAttach(url, { source: 'dynamic-module-inline' });
                                        });
                                    }
                                    element.innerText = value;
                                    return true;
                                }
                            }
                        });
                    }
                } catch (e) {
                    logManager.logErrorWithContext(e, { message: 'hookElementCreation failed' });
                }
                return element;
            };
        }

        return {
            init() {
                if (initialized) return;
                initialized = true;
                if (!FeatureFlags.enhanceURLDetection) return;
                try {
                    hookFetch();
                    hookXHR();
                    hookBlob();
                    hookWebSocket();
                    hookElementCreation();
                    logManager.addOnce('network_monitor_active', '✅ 네트워크 모니터 활성화', 5000, 'info');
                } catch (e) { logManager.logErrorWithContext(e, { message: 'networkMonitor init failed' }); }
            },
            trackAndAttach,
            isMediaUrl,
            getOriginalURL: (url) => BLOB_URL_MAP.get(url) || url,
            isTracked: (url) => VIDEO_URL_CACHE.has(normalizeURL(url)),
            VIDEO_URL_CACHE,
            CACHE_EXPIRATION_TIME,
            resetState: () => { VIDEO_URL_CACHE.clear(); BLOB_URL_MAP.clear(); logManager.add('🔄 네트워크 상태 초기화 완료', 'debug'); }
        };
    })();

    /* ============================
     * ⚡ 성능 최적화: JWPlayer 모니터 (이벤트 기반)
     * ============================ */
    const jwplayerMonitor = (() => {
        let hooked = false;

        function hookJwplayerInstance(jw) {
            if (!jw || typeof jw !== 'function' || jw._vsc_hooked) return;

            const originalJwplayer = jw;
            // jwplayer() 함수 자체를 후킹하여 모든 인스턴스 생성 감지
            window.jwplayer = function(selector) {
                const playerInstance = originalJwplayer.apply(this, arguments);
                if (playerInstance && playerInstance.setup && !playerInstance._vsc_setup_hooked) {
                     logManager.addOnce(`jw_instance_created_${selector}`, `✅ JWPlayer 인스턴스(${selector}) 감지 및 훅 준비`, 5000, 'info');
                    const originalSetup = playerInstance.setup;
                    playerInstance.setup = function(config) {
                        try {
                            if (config && config.playlist) {
                                [].concat(config.playlist).forEach(item => {
                                    const file = item.file || (item.sources && item.sources[0] && item.sources[0].file);
                                    if (file) networkMonitor.trackAndAttach(file, { source: 'jwplayer.setup' });
                                });
                            }
                        } catch(e) { logManager.logErrorWithContext(e, { message: 'JWPlayer setup hook failed' }); }

                        const result = originalSetup.apply(this, arguments);
                        playerInstance.on('ready', () => tryDetect(playerInstance));
                        return result;
                    };
                    playerInstance._vsc_setup_hooked = true;
                }
                return playerInstance;
            };
            window.jwplayer._vsc_hooked = true;
        }

        function tryDetect(player) {
            try {
                const list = player.getPlaylist && player.getPlaylist();
                if (!list || !list.length) return;
                list.forEach(item => {
                    const f = item.file || (item.sources && item.sources[0] && item.sources[0].file);
                    if (f && networkMonitor.isMediaUrl(f)) networkMonitor.trackAndAttach(f, { source: 'jwplayer.getPlaylist' });
                });
            } catch (e) { logManager.logErrorWithContext(e, { message: 'JWPlayer 플레이리스트 감지 실패' }); }
        }

        function init() {
            if (hooked) return;
            hooked = true;

            // 이미 jwplayer가 로드된 경우
            if (window.jwplayer) {
                hookJwplayerInstance(window.jwplayer);
            }

            // jwplayer가 나중에 로드될 경우를 대비해 defineProperty 사용
            let _jwplayer = window.jwplayer;
            try {
                Object.defineProperty(window, 'jwplayer', {
                    get() { return _jwplayer; },
                    set(value) {
                        _jwplayer = value;
                        hookJwplayerInstance(value);
                        logManager.addOnce('jwplayer_detected', '✅ JWPlayer 라이브러리 동적 로드 감지', 5000, 'info');
                    },
                    configurable: true,
                });
            } catch(e) { logManager.logErrorWithContext(e, { message: 'Failed to hook window.jwplayer property' }); }
        }
        return { init };
    })();

    /* ============================
     * mediaFinder (문서/iframe/Shadow DOM 탐색)
     * ============================ */
    const mediaFinder = {
        findInDoc(doc) {
            const out = [];
            if (!doc) return out;
            try {
                doc.querySelectorAll('video, audio').forEach(m => out.push(m));
                doc.querySelectorAll('iframe[src*="youtube.com/embed/"], iframe[src*="youtu.be/"]').forEach(m => {
                    const src = m.src;
                    if (src) networkMonitor.trackAndAttach(src, { source: 'youtube-iframe', element: m });
                });
                if (window.ytplayer && window.ytplayer.config) {
                    try {
                        const playerResponseData = window.ytplayer.config.args?.player_response || window.ytplayer.config.player_response;
                        if (playerResponseData) {
                            const response = typeof playerResponseData === 'string' ? JSON.parse(playerResponseData) : playerResponseData;
                            if (response?.streamingData) {
                                const formats = (response.streamingData.formats || []).concat(response.streamingData.adaptiveFormats || []);
                                formats.forEach(format => {
                                    if (format.url) {
                                        networkMonitor.trackAndAttach(format.url, { source: 'ytplayer.player_response' });
                                    }
                                });
                            }
                        }
                    } catch (e) { /* 초기 스캔 오류는 무시 */ }
                }
                doc.querySelectorAll('div[id*="player"], div[class*="video"], div[class*="vjs-"], .jw-player, .video-container').forEach(c => {
                    if (!c.querySelector('video, audio, iframe') && c.clientWidth > 20 && c.clientHeight > 20) out.push(c);
                });
                doc.querySelectorAll('[data-src],[data-video],[data-url]').forEach(el => {
                    try {
                        const s = el.getAttribute('data-src') || el.getAttribute('data-video') || el.getAttribute('data-url');
                        if (s && networkMonitor.isMediaUrl(s)) networkMonitor.trackAndAttach(s, { source: 'data-attr' });
                    } catch (e) {}
                });

                doc.querySelectorAll('script:not([src])').forEach(sc => {
                    try {
                        const txt = sc.textContent || '';
                        const matches = [...txt.matchAll(/https?:\/\/[^\s'"]+\.(mp4|m3u8|mpd|webm|ts|m4s)/gi)].map(m => m[0]);
                        matches.forEach(u => networkMonitor.trackAndAttach(u, { source: 'inline-script' }));
                    } catch (e) {}
                });

                if (window._shadowDomList_) {
                    window._shadowDomList_.forEach(sr => {
                        try { sr.querySelectorAll && sr.querySelectorAll('video,audio').forEach(m => out.push(m)); } catch (e) {}
                    });
                }
            } catch (e) { logManager.logErrorWithContext(e, { message: 'findInDoc failed' }); }
            return out;
        },
        findAll() {
            const arr = mediaFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try { if (iframe.contentDocument) arr.push(...mediaFinder.findInDoc(iframe.contentDocument)); } catch (e) {}
            });
            return arr;
        },
        findInSubtree(node) {
            if (!node) return [];
            const arr = [];
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') arr.push(node);
            node.querySelectorAll && node.querySelectorAll('video,audio').forEach(m => arr.push(m));
            return arr;
        }
    };

    /* ============================
     * ✨ 신규 기능: 미디어 세션 API 매니저
     * ============================ */
    const mediaSessionManager = (() => {
        function setSession(media) {
            if (!FeatureFlags.mediaSessionIntegration || !('mediaSession' in navigator)) return;

            try {
                const title = document.title || '재생 중인 미디어';
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: title,
                    artist: window.location.hostname,
                    album: 'VideoSpeed_Control',
                });

                navigator.mediaSession.setActionHandler('play', () => media.play());
                navigator.mediaSession.setActionHandler('pause', () => media.pause());
                navigator.mediaSession.setActionHandler('seekbackward', (details) => { media.currentTime = Math.max(0, media.currentTime - (details.seekOffset || 10)); });
                navigator.mediaSession.setActionHandler('seekforward', (details) => { media.currentTime = Math.min(media.duration, media.currentTime + (details.seekOffset || 10)); });

                logManager.addOnce('media_session_set', '✨ 미디어 세션 설정 완료', 5000, 'info');
            } catch (e) {
                logManager.logErrorWithContext(e, { message: '미디어 세션 설정 실패' });
            }
        }

        function clearSession() {
            if (!FeatureFlags.mediaSessionIntegration || !('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.setActionHandler('play', null);
                navigator.mediaSession.setActionHandler('pause', null);
                navigator.mediaSession.setActionHandler('seekbackward', null);
                navigator.mediaSession.setActionHandler('seekforward', null);
            } catch(e) {
                logManager.logErrorWithContext(e, { message: '미디어 세션 해제 실패' });
            }
        }

        return { setSession, clearSession };
    })();

    /* ============================
     * 💡 아키텍처 개선: UI 로직 (Shadow DOM 사용하도록 수정)
     * ============================ */
    const DRAG_CONFIG = { PIXELS_PER_SECOND: 2 };
    const speedSlider = (() => {
        let container = null, inited = false, isMin = true, visible = false, updateTimer;

        async function init() {
            if (inited) return;
            isMin = !!(await configManager.get('isMinimized'));
            inited = true;

            const shadowRoot = uiManager.getShadowRoot();
            container = shadowRoot.getElementById('vm-speed-slider-container');
            if (!container) {
                container = document.createElement('div'); container.id = 'vm-speed-slider-container';
                const reset = document.createElement('button'); reset.className = 'vm-btn'; reset.textContent = '1x';
                const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0'; slider.step = '0.1'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                const val = document.createElement('div'); val.id = 'vm-speed-value'; val.textContent = 'x1.0';
                const toggle = document.createElement('button'); toggle.className = 'vm-btn vm-toggle-btn';

                reset.addEventListener('click', () => { slider.value = '1.0'; applySpeed(1.0); val.textContent = 'x1.0'; });
                slider.addEventListener('input', (e) => { const s = parseFloat(e.target.value); val.textContent = `x${s.toFixed(1)}`; if (updateTimer) clearTimeout(updateTimer); updateTimer = setTimeout(() => applySpeed(s), 100); });
                toggle.addEventListener('click', async () => {
                    isMin = !isMin;
                    await configManager.set('isMinimized', isMin);
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
            const toggleBtn = container.querySelector('.vm-toggle-btn');
            if(toggleBtn) toggleBtn.textContent = isHidden ? '◀' : '▶';
        }

        function applySpeed(speed) {
            try {
                mediaFinder.findAll().forEach(md => {
                    try { if (md.tagName === 'VIDEO' || md.tagName === 'AUDIO') md.playbackRate = speed; } catch (e) {}
                });
            } catch (e) { logManager.logErrorWithContext(e, { message: 'applySpeed failed' }); }
        }

        async function show() { if (!inited) await init(); if (!container) return; container.style.display = 'flex'; visible = true; }
        function hide() { if (!container) return; container.style.display = 'none'; visible = false; }

        function updatePositionAndSize() {
            try {
                const m = mediaFinder.findAll().find(x => x.clientWidth > 0 && x.clientHeight > 0);
                const sliderEl = container && container.querySelector('#vm-speed-slider');
                if (m && sliderEl) { sliderEl.style.height = Math.max(80, m.getBoundingClientRect().height * 0.25) + 'px'; }
            } catch (e) {}
        }
        return { init, show, hide, updatePositionAndSize, isMinimized: () => isMin, container: () => container };
    })();
    const dragBar = (() => {
        let display = null, inited = false, visible = false;
        let state = { dragging: false, isHorizontalDrag: false, startX: 0, startY: 0, accX: 0 };
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
                mediaFinder.findAll().forEach(m => {
                    try {
                        if (!(m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) return;
                        if (!isFinite(m.duration)) return;
                        m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec));
                    } catch (e) {}
                });
            } catch (e) { logManager.logErrorWithContext(e, { message: 'dragBar apply failed' }); }
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
                // Shadow DOM 내부의 UI 요소 클릭 시 드래그 방지
                if (e.composedPath && e.composedPath()[0].shadowRoot) return;

                if(e.button === 2) return;
                if (!mediaFinder.findAll().some(m => m.tagName === 'VIDEO' && !m.paused)) { return; }
                const pos = e.touches ? e.touches[0] : e;
                state.dragging = true; state.startX = pos.clientX; state.startY = pos.clientY; state.accX = 0;
                document.addEventListener('mousemove', onMove, { passive: false, capture: true });
                document.addEventListener('mouseup', onEnd, { passive: false, capture: true });
                document.addEventListener('touchmove', onMove, { passive: false, capture: true });
                document.addEventListener('touchend', onEnd, { passive: false, capture: true });
            } catch (e) { logManager.logErrorWithContext(e, { message: 'dragBar onStart failed' }); }
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
            } catch (e) { logManager.logErrorWithContext(e, { message: 'dragBar onMove failed' }); onEnd(); }
        }
        function onEnd() {
            if (!state.dragging) return;
            apply();
            state.dragging = false; state.accX = 0; state.isHorizontalDrag = false;
            hideDisplay();
            document.body.style.userSelect = ''; document.body.style.touchAction = '';
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onEnd, true);
            document.removeEventListener('touchmove', onMove, true);
            document.removeEventListener('touchend', onEnd, true);
        }
        function init() {
            if (inited) return; inited = true;
            addOnceEventListener(document, 'mousedown', onStart, { passive: false, capture: true });
            addOnceEventListener(document, 'touchstart', onStart, { passive: false, capture: true });
        }
        return { init, show: () => visible && display && (display.style.display = 'block'), hide: hideDisplay, display: () => display };
    })();
    const dynamicMediaUI = (() => {
        let btn, inited = false, visible = false;
        function init() {
            if (inited) return; inited = true;
            const shadowRoot = uiManager.getShadowRoot();
            btn = shadowRoot.getElementById('dynamic-media-url-btn');
            if (!btn) {
                btn = document.createElement('button'); btn.id = 'dynamic-media-url-btn'; btn.textContent = '🎞️ URL';
                shadowRoot.appendChild(btn);
            }
            addOnceEventListener(btn, 'click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const originalText = '🎞️ URL';
                btn.textContent = '복사 중...';
                const allUrls = [];
                const now = Date.now();
                for (const [url, data] of networkMonitor.VIDEO_URL_CACHE.entries()) {
                    if (now - data.timestamp < networkMonitor.CACHE_EXPIRATION_TIME) {
                        allUrls.push(url);
                    }
                }
                if (allUrls.length === 0) {
                    logManager.addOnce('no_url', '⚠️ 감지된 URL 없음', 3000, 'warn');
                    btn.textContent = '⚠️ 없음';
                    setTimeout(() => btn.textContent = originalText, 1500);
                    return;
                }
                const final = allUrls.map(url => networkMonitor.getOriginalURL(url) || url).join('\n');
                const ok = await copyToClipboard(final);
                btn.textContent = ok ? `✅ ${allUrls.length}개 URL 복사 완료` : '❌ 복사 실패';
                if (!ok) {
                    logManager.add('UI에서 클립보드 복사를 시도했으나 실패했습니다.', 'warn');
                }
                setTimeout(() => btn.textContent = originalText, 2500);
            }, true);
        }
        function show() { if (!inited) init(); if (!btn) return; btn.style.display = 'block'; visible = true; }
        function hide() { if (!btn) return; btn.style.display = 'none'; visible = false; }
        return { init, show, hide };
    })();

    /* ============================
     * mediaControls: per-media init/observe
     * ============================ */
    const mediaControls = (() => {
        function observeMediaSources(media) {
            try {
                const st = MediaStateManager.get(media) || {};
                if (st.hasObserver) return;
                MediaStateManager.set(media, Object.assign({}, st, { hasObserver: true }));
                const mo = new MutationObserver(() => {
                    try { media.querySelectorAll && media.querySelectorAll('source').forEach(s => { if (s.src) networkMonitor.trackAndAttach(s.src, { element: media, source: 'source-elem' }); }); } catch (e) { logManager.logErrorWithContext(e, media); }
                });
                mo.observe(media, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
            } catch (e) { logManager.logErrorWithContext(e, media); }
        }
        const updateUIVisibility = throttle(async () => {
            try {
                const hasMedia = mediaFinder.findAll().some(m => m.tagName === 'VIDEO' || m.tagName === 'AUDIO');
                if (hasMedia) {
                    await speedSlider.show();
                    dynamicMediaUI.show();
                } else {
                    speedSlider.hide();
                    dynamicMediaUI.hide();
                }
                const hasPlayingVideo = mediaFinder.findAll().some(m => m.tagName === 'VIDEO' && !m.paused);
                if (hasPlayingVideo) {
                    dragBar.show();
                } else {
                    dragBar.hide();
                }
            } catch (e) { logManager.logErrorWithContext(e, { message: 'updateUIVisibility failed' }); }
        }, 400);
        function initWhenReady(media) {
            if (!media || MediaStateManager.has(media)) return;

            if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
                const src = media.currentSrc || media.src;
                if (src && !networkMonitor.isTracked(src)) {
                    networkMonitor.trackAndAttach(src, { element: media, source: 'media-element-src' });
                }
            }

            MediaStateManager.set(media, { isInitialized: true });
            if ((media.tagName === 'VIDEO' || media.tagName === 'AUDIO')) {
                const src = media.currentSrc || media.src || (media.dataset && media.dataset.src);
                if (src && FeatureFlags.previewFiltering && isPreviewURL(src)) { MediaStateManager.addPreview(media); logManager.addOnce('skip_preview_media_init', `🔴 미리보기로 판단되어 초기화 건너_m: ${src}`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP); return; }
            }
            observeMediaSources(media);
            addManagedEventListener(media, 'loadedmetadata', function () {
                try {
                    if (FeatureFlags.previewFiltering && this.duration > 0 && this.duration < PREVIEW_CONFIG.DURATION_THRESHOLD) { MediaStateManager.addPreview(this); logManager.addOnce('skip_short_media', `🔴 짧은 미디어로 무시: ${this.currentSrc || this.src}`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP); return; }
                } catch (e) {}
                updateUIVisibility();
                logManager.logMediaContext(media, '미디어 로드 완료');
            }, { once: true });
            addManagedEventListener(media, 'play', () => {
                updateUIVisibility();
                logManager.logMediaContext(media, '재생 시작');
                mediaSessionManager.setSession(media); // ✨ 미디어 세션 설정
            }, true);
            addManagedEventListener(media, 'pause', () => {
                updateUIVisibility();
                logManager.logMediaContext(media, '일시정지');
                mediaSessionManager.clearSession(); // ✨ 미디어 세션 해제
            }, true);
            addManagedEventListener(media, 'ended', () => {
                updateUIVisibility();
                logManager.logMediaContext(media, '종료');
                mediaSessionManager.clearSession(); // ✨ 미디어 세션 해제
            }, true);
        }
        function detachUI(media) { try { if (MediaStateManager.has(media)) MediaStateManager.delete(media); } catch (e) {} }
        return { initWhenReady, detachUI, updateUIVisibility };
    })();

    /* ============================
     * SPA/Navigation 모니터
     * ============================ */
    const scanYouTubeDebounced = debounce(() => {
        try {
            if (location.hostname.includes('youtube.com')) {
                logManager.addOnce('yt_scan_debounced', '🔄 [YT] 최적화된 스캔 실행...', 2000, 'debug');
                youtubeMediaFinder.scanAndTrack();
            }
        } catch(e) {
            logManager.logErrorWithContext(e, { message: 'Debounced YouTube scan failed' });
        }
    }, 1000);

    const spaPartialUpdate = (() => {
        function detectChangedRegion(doc) {
            const candidates = doc.querySelectorAll('main, #app, .page-content, [role="main"]');
            if (candidates.length) {
                for (const c of candidates) {
                    try { const r = c.getBoundingClientRect(); if (r.width * r.height > window.innerWidth * window.innerHeight * 0.08) return c; } catch (e) {}
                }
            }
            return doc.body || doc.documentElement;
        }
        function partialUpdate() {
            logManager.addOnce('spa_partial_start', '🟢 SPA 부분 업데이트 시작', 5000, 'info');
            const region = detectChangedRegion(document);
            if (!region) { App.initializeAll(document); return; }
            const medias = mediaFinder.findInSubtree(region);
            medias.forEach(m => { if (!MediaStateManager.has(m)) mediaControls.initWhenReady(m); });
            mediaControls.updateUIVisibility();
            logManager.addOnce('spa_partial_done', `🟢 SPA 부분 업데이트 완료 (미디어 ${medias.length}개)`, 5000, 'info');
        }
        return { partialUpdate };
    })();

    const spaMonitor = (() => {
        let lastURL = location.href;
        let debounceTimer = null;
        let isSpaMonitorInitialized = false;

        function overrideHistory(fnName) {
            const orig = originalMethods.History[fnName];
            history[fnName] = function () { const res = orig.apply(this, arguments); onNavigate(`history.${fnName}`); return res; };
        }
        function onNavigate() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const now = location.href;
                if (now !== lastURL) {
                    if (location.hostname.includes('youtube.com')) {
                        scanYouTubeDebounced();
                    }
                    try {
                        const nowUrl = new URL(now);
                        const prevUrl = new URL(lastURL);

                        if (nowUrl.origin === prevUrl.origin && nowUrl.pathname === prevUrl.pathname) {
                            logManager.addOnce(`spa_nav_same_page`, `🔄 SPA 동일 페이지 이동 감지 (쿼리/해시 변경)`, 5000, 'info');
                            if (FeatureFlags.spaPartialUpdate) {
                                spaPartialUpdate.partialUpdate();
                            }
                        } else {
                            logManager.addOnce(`spa_nav_${now}`, `🔄 SPA 네비게이션: ${lastURL} -> ${now}`, 5000, 'info');
                            if (FeatureFlags.enhanceURLDetection) {
                                networkMonitor.resetState();
                            }
                            PROCESSED_DOCUMENTS = new WeakSet();
                            App.initializeAll(document);
                        }
                    } catch (e) {
                        logManager.logErrorWithContext(e, { message: 'URL 파싱 실패 또는 SPA 탐색 오류', prev: lastURL, next: now });
                        logManager.addOnce(`spa_nav_err_${now}`, `🔄 SPA 네비게이션 (오류로 인한 전체 재초기화)`, 6000, 'error');
                        if (FeatureFlags.enhanceURLDetection) networkMonitor.resetState();
                        PROCESSED_DOCUMENTS = new WeakSet();
                        App.initializeAll(document);
                    }
                    lastURL = now;
                }
            }, 300);
        }
        function init() {
            if (isSpaMonitorInitialized) return;
            isSpaMonitorInitialized = true;
            overrideHistory('pushState');
            overrideHistory('replaceState');
            addOnceEventListener(window, 'popstate', () => onNavigate());
        }
        return { init, onNavigate };
    })();

    /* ============================
     * App: 초기화·통합 MutationObserver
     * ============================ */
    function canAccessIframe(iframe) {
        try {
            if (!FeatureFlags.iframeProtection) return true;
            if (iframe.hasAttribute && iframe.hasAttribute('sandbox')) {
                const s = iframe.getAttribute('sandbox') || '';
                if (!s.includes('allow-same-origin')) return false;
            }
            return !!(iframe.contentDocument || iframe.contentWindow?.document);
        } catch (e) { return false; }
    }

    function showIframeAccessFailureNotice(iframe, message) {
        if (!iframe || !iframe.parentNode) return;
        const noticeId = `vsc-iframe-notice-${iframe.src || Math.random()}`;
        if (document.getElementById(noticeId)) return;

        const notice = document.createElement('div');
        notice.id = noticeId;
        notice.style.cssText = 'color:red; padding:5px; background:#fee; font-size:12px; border:1px solid red; margin-top:4px; text-align: center; opacity: 1; transition: opacity 0.5s ease-out;';
        notice.textContent = `⚠️ ${message}`;
        try {
            iframe.parentNode.insertBefore(notice, iframe.nextSibling);

            setTimeout(() => {
                notice.style.opacity = '0';
                setTimeout(() => {
                    if (notice.parentNode) {
                        notice.parentNode.removeChild(notice);
                    }
                }, 500);
            }, 5000);

        } catch(e) { logManager.logErrorWithContext(e, { message: 'Failed to insert iframe notice' }); }
    }

    const App = (() => {
        let globalScanTimer = null;
        let intersectionObserver;
        const MEDIA_TAGS = 'video, audio, iframe';

        function initIntersectionObserver() {
            if (intersectionObserver) return;
            intersectionObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const video = entry.target;
                        const src = video.src || video.dataset.src || video.poster;
                        if (src && networkMonitor.isMediaUrl(src) && !video.hasAttribute('data-tracked')) {
                            logManager.addOnce(`intersecting_${src}`, `🎥 화면에 보이는 비디오 감지: ${src}`, 5000, 'info');
                            networkMonitor.trackAndAttach(src, { element: video });
                            video.setAttribute('data-tracked', 'true');
                        }
                    }
                });
            }, { threshold: 0.75 });
            logManager.addOnce('intersection_observer_active', '✅ IntersectionObserver 활성화 (Threshold: 0.75)', 5000, 'info');
        }

        function initIframe(iframe) {
            if (!iframe || MediaStateManager.hasIframe(iframe)) return;
            MediaStateManager.addIframe(iframe);

            const maxAttempts = 5;
            const attempt = (n=1) => {
                const src = iframe.src || 'about:blank';
                const rect = iframe.getBoundingClientRect?.() || {width:0,height:0};
                const isVisibleEnough = rect.width * rect.height > 100 * 100;

                const run = () => {
                    if (src && networkMonitor.isMediaUrl(src)) {
                        networkMonitor.trackAndAttach(src, { element: iframe, source: 'iframe.src' });
                        logManager.logIframeContext(iframe, '✅ 영상 URL 감지 (src)');
                        return true;
                    }
                    if (canAccessIframe(iframe)) {
                        const doc = iframe.contentDocument;
                        if (doc && doc.readyState !== 'uninitialized') {
                            initializeAll(doc);
                            logManager.logIframeContext(iframe, `비동기 초기화 성공 (시도 ${n})`);
                            return true;
                        }
                    } else {
                        const message = '보안 정책으로 인해 제어 불가';
                        logManager.addOnce(`blocked_iframe_${src}`, `🔒 iframe ${message}: ${src}`, 6000, 'warn');
                        showIframeAccessFailureNotice(iframe, message);
                        return true;
                    }
                    return false;
                };

                let success = false;
                if (isVisibleEnough) {
                    success = run();
                }

                if (!success && n < maxAttempts) {
                    const backoff = 500 * Math.pow(2, n - 1);
                    setTimeout(() => attempt(n + 1), backoff);
                } else if (!success && n >= maxAttempts) {
                    logManager.logIframeContext(iframe, `초기화 마지막 시도`);
                    run();
                }
            };

            addOnceEventListener(iframe, 'load', debounce(() => attempt(1), 400), true);
            const mo = new MutationObserver(() => debounce(() => attempt(1), 400)());
            mo.observe(iframe, { attributes: true, attributeFilter: ['src', 'srcdoc'] });

            logManager.logIframeContext(iframe, '비동기 초기화 시작 (로드/백오프)');
            setTimeout(() => attempt(1), 600);
        }

        function scanExistingMedia(doc) {
            try {
                const medias = mediaFinder.findInDoc(doc);
                medias.forEach(m => mediaControls.initWhenReady(m));
            } catch (e) { logManager.logErrorWithContext(e, { message: 'scanExistingMedia failed' }); }
        }

        function startUnifiedObserver(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;

            const root = targetDocument.documentElement || targetDocument.body;
            if (!root) return;

            const region = (() => {
                const cand = targetDocument.querySelector('main, #app, .page-content, [role="main"], #content');
                return cand || root;
            })();

            if (OBSERVER_MAP.has(targetDocument)) { OBSERVER_MAP.get(targetDocument).disconnect(); }

            const fastPath = (node) => {
                if (!node || node.nodeType !== 1) return false;
                const tag = node.tagName;
                if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME') return true;
                const cls = (node.className || '') + ' ' + (node.id || '');
                return /video|player|jwplayer|vjs-|ytp-|media|playlist|iframe/i.test(cls);
            };

            const processNode = (n) => {
                if (n.tagName === 'IFRAME') {
                    initIframe(n);
                } else {
                    mediaControls.initWhenReady(n);
                    if (intersectionObserver && !n.hasAttribute('data-vsc-observed')) {
                        intersectionObserver.observe(n);
                        n.setAttribute('data-vsc-observed', 'true');
                    }
                }
            };

            const observer = new MutationObserver(debounce((mutations) => {
                for (const mut of mutations) {
                    if (mut.type === 'childList') {
                        mut.addedNodes.forEach(n => {
                            if (n.nodeType !== 1) return;
                            if (fastPath(n)) {
                                processNode(n);
                            } else if (n.querySelectorAll) {
                                n.querySelectorAll('video, audio, iframe').forEach(processNode);
                            }
                        });
                        mut.removedNodes.forEach(n => {
                            if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO')) {
                                mediaControls.detachUI(n);
                                removeAllManagedEventListeners(n);
                                if (intersectionObserver) intersectionObserver.unobserve(n);
                            }
                        });
                    } else if (mut.type === 'attributes') {
                        const t = mut.target;
                        if (!t || t.nodeType !== 1) continue;
                        if (t.tagName === 'IFRAME' && mut.attributeName === 'src') { MediaStateManager.deleteIframe(t); initIframe(t); }
                        if ((t.tagName === 'VIDEO' || t.tagName === 'AUDIO') && (mut.attributeName === 'src' || mut.attributeName.startsWith('data-'))) {
                            mediaControls.initWhenReady(t);
                            t.removeAttribute('data-tracked');
                        }
                    }
                }
            }, 80));

            observer.observe(region, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src','data-src','data-video','data-url','poster']
            });

            OBSERVER_MAP.set(targetDocument, observer);
            PROCESSED_DOCUMENTS.add(targetDocument);
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 (${targetDocument === document ? '메인' : 'iframe'})`, 5000, 'info');
        }

        function startPeriodicScan() {
            if (globalScanTimer) clearInterval(globalScanTimer);
            const scanTask = () => {
                const allMedia = mediaFinder.findAll();
                allMedia.forEach(m => {
                    mediaControls.initWhenReady(m);
                    if (intersectionObserver && (m.tagName === 'VIDEO' || m.tagName === 'AUDIO') && !m.hasAttribute('data-vsc-observed')) {
                        intersectionObserver.observe(m);
                        m.setAttribute('data-vsc-observed', 'true');
                    }
                });
                if (location.hostname.includes('youtube.com')) {
                    scanYouTubeDebounced();
                }
            };

            scanTask();
            globalScanTimer = setInterval(scanTask, 3000);
        }

        async function initializeAll(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;

            if (targetDocument === document) {
                try {
                    await configManager.init();
                    uiManager.init();
                    logManager.init();
                    logManager.addOnce('script_init_start', '🎉 VideoSpeed_Control 초기화 시작 (v21.0)', 5000, 'info');
                    if (FeatureFlags.spaPartialUpdate) spaMonitor.init();
                    if (FeatureFlags.videoControls) {
                        await speedSlider.init();
                        dragBar.init();
                        dynamicMediaUI.init();
                        jwplayerMonitor.init();
                    }
                    if (FeatureFlags.enhanceURLDetection) networkMonitor.init();
                    if (FeatureFlags.videoControls || FeatureFlags.enhanceURLDetection) initIntersectionObserver();
                } catch (e) { logManager.logErrorWithContext(e, { message: 'Main initialization failed' }); }

                addOnceEventListener(document, 'fullscreenchange', () => {
                    uiManager.moveUiTo(document.fullscreenElement || document.body);
                    speedSlider.updatePositionAndSize();
                });

                if (location.hostname.includes('youtube.com')) {
                    setTimeout(() => scanYouTubeDebounced(), 500);
                }
                startPeriodicScan();
            } else {
                try { if (FeatureFlags.enhanceURLDetection) networkMonitor.init(); } catch (e) {}
            }

            startUnifiedObserver(targetDocument);
            scanExistingMedia(targetDocument);
            targetDocument.querySelectorAll('iframe').forEach(ifr => initIframe(ifr));
            mediaControls.updateUIVisibility();
        }
        return { initializeAll };
    })();

    /* ============================
     * 문서 준비 시 초기화
     * ============================ */
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        App.initializeAll(document);
    } else {
        window.addEventListener('DOMContentLoaded', () => App.initializeAll(document), { once: true });
    }
})();
