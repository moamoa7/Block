// ==UserScript==
// @name          VideoSpeed_Control
// @namespace     https.com/
// @version       17.6 (콘솔 클리어 방지 추가 / 로그내역 위치 수정 / URL 복사 수정)
// @description    🎞️ 비디오 속도 제어 + 🔍 SPA/iframe/ShadowDOM 동적 탐지 + 📋 로그 뷰어 통합
// @match         *://*/*
// @grant         GM_xmlhttpRequest
// @grant         GM_setValue
// @grant         GM_getValue
// @grant         GM_listValues
// @grant         none
// @connect       *
// @run-at        document-start
// ==/UserScript==

(function () {
    'use strict';

     /* ============================
        콘솔 클리어 방지 (추가된 코드)
        ============================ */
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
        설정: 전역 기능 및 제외 도메인
        ============================ */

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
        logLevel: 'INFO', // DEBUG, INFO, WARN, ERROR
        previewFiltering: true,
        popupBlocker: true,
        iframeProtection: true,
        enforceIframeSandbox: false
    };

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) {
        return;
    }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', {
        value: true, writable: false, configurable: true
    });

    /* ============================
        안전한 원시 함수 보관
        ============================ */
    const originalMethods = {
        Element: {
            attachShadow: window.Element.prototype.attachShadow
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
            open: window.open
        }
    };

    /* ============================
        Shadow DOM 강제 open
        ============================ */
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
        ConfigManager (localStorage / GM fallback)
        ============================ */
    class ConfigManager {
        constructor(opts = {}) {
            this.opts = opts;
            this.opts.config = this.opts.config || {};
            this._syncFromGlobal();
        }
        _key(p = '') { return (this.opts.prefix || '_vs_') + p.replace(/\./g, '_'); }
        isLocalUsable() {
            try { localStorage.setItem('__test__', '1'); localStorage.removeItem('__test__'); return true; } catch (e) { return false; }
        }
        isGlobalUsable() {
            return typeof GM_getValue === 'function' && typeof GM_setValue === 'function' && typeof GM_listValues === 'function';
        }
        get(path) {
            if (this.isLocalUsable()) {
                try {
                    const v = localStorage.getItem(this._key(path));
                    if (v !== null) { try { return JSON.parse(v); } catch (e) { return v; } }
                } catch (e) {}
            }
            if (this.isGlobalUsable()) {
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
        set(path, val) {
            if (this.isLocalUsable()) {
                try { localStorage.setItem(this._key(path), typeof val === 'object' ? JSON.stringify(val) : String(val)); } catch (e) {}
            }
            if (this.isGlobalUsable()) {
                try { GM_setValue(this._key(path), val); } catch (e) {}
            }
            const parts = path.split('.');
            let cur = this.opts.config;
            for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]]; }
            cur[parts[parts.length - 1]] = val;
        }
        _syncFromGlobal() {
            if (!this.isGlobalUsable()) return;
            try {
                const keys = GM_listValues();
                keys.forEach(k => {
                    if (k.startsWith(this.opts.prefix || '')) {
                        const path = k.replace(this.opts.prefix, '').replace(/_/g, '.');
                        const val = GM_getValue(k);
                        const parts = path.split('.');
                        let cur = this.opts.config;
                        for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]]; }
                        cur[parts[parts.length - 1]] = val;
                    }
                });
            } catch (e) {}
        }
    }
    const configManager = new ConfigManager({ prefix: '_video_speed_', config: { isMinimized: true, isInitialized: false } });

    /* ============================
        유틸: addOnceEventListener, throttle, debounce, copyToClipboard
        ============================ */
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
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
        try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); return true; } catch (e) { return false; }
    }

    /* ============================
        전역 상태 관리
        ============================ */
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
    const iframeInitAttempts = new WeakMap();

    /* ============================
        로그 모듈 (XSS 안전)
        ============================ */
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
            const levels = { 'debug': 0, 'info': 1, 'warn': 2, 'error': 3 };
            const currentLevel = levels[FeatureFlags.logLevel.toLowerCase()] || 1;
            const msgLevel = levels[level] || 1;
            if (msgLevel < currentLevel) return;

            const icons = { info: 'ℹ️', warn: '⚠️', error: '🔴', allow: '✅', debug: '🔧', stream: '▶️' };
            const full = `[${new Date().toLocaleTimeString()}] ${icons[level] || ''} ${msg}`;
            if (FeatureFlags.detailedLogging) {
                if (console[level]) console[level](full); else console.log(full);
            }
            if (!FeatureFlags.logUI) return;
            if (!isTopFrame) {
                try { window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: full, level, key: msg }, '*'); } catch (e) { }
                return;
            }
            if (!box) { pending.push(full); return; }
            history.push(full); if (history.length > 50) history.shift();
            const el = document.createElement('div'); el.textContent = full; el.style.textAlign = 'left';
            while(box.childElementCount >= 50) box.removeChild(box.firstChild);
            box.appendChild(el); box.scrollTop = box.scrollHeight;
            showLogContainer();
        }
        function add(msg, lvl = 'info') { safeAdd(msg, lvl); }
        function addOnce(key, msg, delay = 5000, lvl = 'info') {
            const now = Date.now();
            for (const [k, t] of LOGGED_KEYS_WITH_TIMER) if (now - t > delay) LOGGED_KEYS_WITH_TIMER.delete(k);
            if (!LOGGED_KEYS_WITH_TIMER.has(key)) { LOGGED_KEYS_WITH_TIMER.set(key, now); safeAdd(msg, lvl); }
        }
        function initUI() {
            if (!FeatureFlags.logUI || !isTopFrame || container) return;
            container = document.createElement('div');
            container.id = 'vm-log-container';
            Object.assign(container.style, {
              position: 'fixed', bottom: '0', right: '0', width: '350px', maxHeight: '30px',
              zIndex: '2147483646', pointerEvents: 'none', background: 'transparent', color: '#fff',
              fontFamily: 'monospace', fontSize: '14px', borderTopLeftRadius: '8px', overflow: 'hidden',
              opacity: '0', transition: 'opacity 0.3s ease', boxShadow: 'none'
          });
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '로그 복사';
            Object.assign(copyBtn.style, { position: 'absolute', top: '0', right: '0', background: 'red', color: '#fff', border: 'none', borderBottomLeftRadius: '8px', padding: '4px 8px', fontSize: '14px', cursor: 'pointer', zIndex: '2147483647', opacity: '0.8' });
            copyBtn.addEventListener('click', async () => {
                const ok = await copyToClipboard(history.join('\n'));
                copyBtn.textContent = ok ? '복사 완료' : '복사 실패'; setTimeout(() => copyBtn.textContent = '로그 복사', 1500);
            });
            box = document.createElement('div');
            Object.assign(box.style, { maxHeight: '100%', overflowY: 'auto', padding: '8px', paddingTop: '25px', userSelect: 'text' });
            container.appendChild(copyBtn); container.appendChild(box);
            if (document.body) document.body.appendChild(container); else window.addEventListener('DOMContentLoaded', () => { if (!document.body.contains(container)) document.body.appendChild(container); });
            pending.forEach(p => { const e = document.createElement('div'); e.textContent = p; box.appendChild(e); }); pending = [];
        }
        function logMediaContext(media, message, level = 'info') {
            if (!FeatureFlags.detailedLogging || !media) return;
            try {
                const rect = media.getBoundingClientRect();
                const playing = !media.paused;
                const src = media.currentSrc || media.src || 'none';
                const duration = isFinite(media.duration) ? media.duration.toFixed(1) : 'N/A';
                addOnce(`media_${src}_${message}`, `🎬 ${message} | src:${src} | ${Math.round(rect.width)}x${Math.round(rect.height)} | ${duration}s | ${playing ? '재생중' : '정지'}`, 5000, level);
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
            const stack = err && err.stack ? err.stack : String(err);
            const contextMessage = typeof ctx === 'object' && ctx.message ? ctx.message : (ctx && ctx.tagName ? ctx.tagName : 'N/A');
            const message = `❗ 에러: ${err?.message || err} | 컨텍스트: ${contextMessage}`;
            addOnce(`err_${Date.now()}`, message, 10000, 'error');
        }
        return { init: initUI, add: add, addOnce, logMediaContext, logIframeContext, logErrorWithContext };
    })();

    /* ============================
        미리보기 감지
        ============================ */
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
        강화형 networkMonitor
        ============================ */
    const networkMonitor = (() => {
        const VIDEO_URL_CACHE = new Map();
        const BLOB_URL_MAP = new Map();
        const MAX_CACHE_SIZE = 500;
        const CACHE_EXPIRATION_TIME = 60 * 1000; // 60초
        let initialized = false;

        const VIDEO_EXT_REGEX = /\.(mp4|webm|m3u8|mpd)(\?|#|$)/i;
        const VIDEO_MIME_PATTERN = /(video|application\/(dash\+xml|vnd\.apple\.mpegurl|x-mpegURL))/i;
        const ABS_URL_REGEX = /^[a-z][a-z0-9+\-.]*:/i;
        const URL_REGEX = /\bhttps?:\/\/[^\s'"<>]+/gi;

        const isMediaUrl = (url) => {
            if (typeof url !== 'string') return false;
            return VIDEO_EXT_REGEX.test(url) || url.includes('videoplayback') || url.includes('mime=video') || url.includes('type=video') || url.includes('mime=audio');
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
            for (const [url, timestamp] of VIDEO_URL_CACHE.entries()) {
                if (now - timestamp > CACHE_EXPIRATION_TIME) {
                    VIDEO_URL_CACHE.delete(url);
                }
            }
        }
        setInterval(cleanupCache, CACHE_EXPIRATION_TIME);

        function extractURLsFromText(text) {
          const matches = text.match(URL_REGEX);
          return matches ? matches : [];
        }
        function extractURLsFromBinary(bin) {
          try {
            const ascii = new TextDecoder('utf-8').decode(bin);
            return extractURLsFromText(ascii);
          } catch {
            return [];
          }
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
            if (!url) return;
            const norm = normalizeURL(url);
            if (FeatureFlags.previewFiltering && isPreviewURL(norm)) {
                logManager.addOnce(`skip_preview_${norm}`, `🔴 [Skip:Preview] 미리보기로 판단되어 무시: ${norm}`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                return;
            }
            if (VIDEO_URL_CACHE.has(norm)) return;
            VIDEO_URL_CACHE.set(norm, Date.now());

            if (VIDEO_URL_CACHE.size > MAX_CACHE_SIZE) {
                setTimeout(() => {
                    const first = VIDEO_URL_CACHE.keys().next().value;
                    if (first) {
                      VIDEO_URL_CACHE.delete(first);
                    }
                }, 0);
            }

            const details = [];
            if (ctx.source) details.push(`src:${ctx.source}`);
            if (ctx.rect) details.push(`size:${Math.round(ctx.rect.width)}x${Math.round(ctx.rect.height)}`);
            logManager.addOnce(`early_${norm}`, `🎯 동적 영상 URL 감지: ${norm} | ${details.join(' | ')}`, 5000, 'info');
            try { dynamicMediaUI && dynamicMediaUI.show(norm); } catch (e) {}
            if (ctx.element && !MediaStateManager.has(ctx.element)) MediaStateManager.set(ctx.element, { trackedUrl: norm, isInitialized: false });
        }

        function parseMPD(xmlText, baseURL) {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(xmlText, 'application/xml');
                if (doc.querySelector('parsererror')) {
                    throw new Error('Invalid XML');
                }

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
            } catch (e) {
                logManager.logErrorWithContext(e, { message: 'MPD 파싱 실패', url: baseURL });
            }
        }

        function parseM3U8(text, baseURL) {
            try {
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const l = lines[i].trim();
                    if (l.startsWith('#EXTINF')) {
                        const segmentURL = lines[i + 1]?.trim();
                        if (!segmentURL) continue;
                        const fullURL = normalizeURL(segmentURL, baseURL);
                        if (/\.(mp4|webm|ts|m3u8|mpd)$/i.test(fullURL)) {
                            trackAndAttach(fullURL, { source: 'M3U8 Segment' });
                        } else {
                            logManager.addOnce(`ignored_m3u8_seg_${fullURL}`, `⚠️ [무시] M3U8에서 영상 확장자가 아닌 세그먼트: ${fullURL}`, 5000, 'warn');
                        }
                        i++;
                    } else if (l && !l.startsWith('#')) {
                        trackAndAttach(normalizeURL(l, baseURL), { source: 'M3U8 sub-playlist' });
                    }
                }
                logManager.addOnce(`m3u8_parsed_${baseURL}`, `🔍 M3U8 파싱 완료: ${baseURL}`, 5000, 'info');
            } catch (e) {
                logManager.logErrorWithContext(e, { message: 'M3U8 파싱 실패', url: baseURL });
            }
        }

        const handleResponse = async (url, resp) => {
            try {
                const ct = resp.headers.get('content-type') || '';
                if (isMediaUrl(url) || isMediaMimeType(ct)) {
                    trackAndAttach(url, { source: 'fetch/xhr' });
                    const text = await resp.clone().text();
                    if (url.endsWith('.mpd') || ct.includes('application/dash+xml')) {
                        parseMPD(text, url);
                    } else if (url.endsWith('.m3u8') || isHLSPlaylist(text)) {
                        parseM3U8(text, url);
                    }
                }
            } catch (e) {
                logManager.logErrorWithContext(e, null);
            }
        };

        function hookXHR() {
            if (!originalMethods.XMLHttpRequest.open || !originalMethods.XMLHttpRequest.send) return;
            window.XMLHttpRequest.prototype.open = function (method, url) { this._reqUrl = url; return originalMethods.XMLHttpRequest.open.apply(this, arguments); };
            window.XMLHttpRequest.prototype.send = function (...args) {
                this.addEventListener('load', function () {
                    try {
                        const url = normalizeURL(this._reqUrl);
                        const ct = this.getResponseHeader && this.getResponseHeader('Content-Type');
                        if (isMediaUrl(url) || isMediaMimeType(ct)) {
                            handleResponse(url, new Response(this.response, { headers: { 'content-type': ct || '' } }));
                        }
                    } catch (e) { logManager.logErrorWithContext(e, null); }
                });
                return originalMethods.XMLHttpRequest.send.apply(this, args);
            };
        }

        function hookFetch() {
            if (!originalMethods.Fetch) return;
            window.fetch = async function (...args) {
                let reqURL = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
                try {
                    const res = await originalMethods.Fetch.apply(this, args);
                    handleResponse(reqURL, res.clone());
                    return res;
                } catch (err) { logManager.logErrorWithContext(err, null); throw err; }
            };
        }

        function hookBlob() {
            if (window.MediaSource && originalMethods.MediaSource.addSourceBuffer) {
                MediaSource.prototype.addSourceBuffer = function (mime) {
                    try {
                        logManager.addOnce(`mse_mime_${mime}`, `🧩 MSE MIME 감지: ${mime}`, 3000, 'info');
                        const sourceBuffer = originalMethods.MediaSource.addSourceBuffer.apply(this, arguments);
                        const origAppendBuffer = sourceBuffer.appendBuffer;
                        sourceBuffer.appendBuffer = function(buffer) {
                          try {
                            const boxes = parseMP4Boxes(buffer.buffer || buffer);
                            for (const box of boxes) {
                              if (box.type === 'ftyp' || box.type === 'moof') {
                                logManager.addOnce(`mse_dash_${box.type}`, `🧩 DASH 세그먼트 감지: ${box.type}`, 3000, 'info');
                                trackAndAttach('mse-dash-segment', { type: 'mse-segment', box: box.type });
                              }
                            }
                          } catch (e) { logManager.logErrorWithContext(e, null); }
                          return origAppendBuffer.apply(this, arguments);
                        };
                        return sourceBuffer;
                    } catch (e) {
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
                            logManager.addOnce(`blob_ms_${url}`, `🔗 MediaSource Blob: ${url}`, 4000, 'info');
                        } else if (obj instanceof Blob) {
                            BLOB_URL_MAP.set(url, { type: 'Blob' });
                            logManager.addOnce(`blob_blob_${url}`, `🔗 Blob URL: ${url}`, 4000, 'info');
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
                let urls = [];
                if (typeof data === 'string') {
                  try {
                    const json = JSON.parse(data);
                    urls = extractURLsFromJSON(json);
                  } catch {
                    urls = extractURLsFromText(data);
                  }
                } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
                  const bin = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
                  urls = extractURLsFromBinary(bin);
                }
                urls.forEach(u => networkMonitor.trackAndAttach(u, { type: 'websocket-message' }));
              } catch {}
            }

            ws.addEventListener('message', event => {
              tryParseAndTrack(event.data);
            });
            trackAndAttach(url, { type: 'websocket-connection' });
            return ws;
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
                    logManager.addOnce('network_monitor_active', '✅ 네트워크 모니터 활성화', 3000, 'info');
                } catch (e) { logManager.logErrorWithContext(e, null); }
            },
            trackAndAttach,
            isMediaUrl,
            getOriginalURL: (url) => BLOB_URL_MAP.get(url) || url,
            VIDEO_URL_CACHE,
            resetState: () => { VIDEO_URL_CACHE.clear(); BLOB_URL_MAP.clear(); }
        };
    })();

    /* ============================
     JWPlayer 모니터
     ============================ */
const jwplayerMonitor = (() => {
    let isHooked = false;

    // 모든 JWPlayer 인스턴스를 찾아 후킹하는 메인 함수
    function hookAllPlayers() {
        if (isHooked) return;

        // jwplayer 전역 객체가 로드될 때까지 기다림
        const waitForJWPlayer = new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                if (window.jwplayer && typeof window.jwplayer === 'function') {
                    clearInterval(interval);
                    resolve(window.jwplayer);
                }
            }, 100);

            setTimeout(() => {
                clearInterval(interval);
                reject('JWPlayer 로딩 실패');
            }, 5000); // 5초 대기
        });

        waitForJWPlayer.then(jw => {
            // 페이지의 모든 잠재적인 JWPlayer 요소를 찾음
            const playerElements = document.querySelectorAll('[id^="jwplayer-"], .jw-player, div[id]');

            playerElements.forEach(playerElement => {
                const playerId = playerElement.id;
                if (playerId) {
                    try {
                        const playerInstance = jw(playerId);
                        if (playerInstance) {
                            // 인스턴스를 성공적으로 찾았으면 후킹 로직 적용
                            const originalSetup = playerInstance.setup;
                            playerInstance.setup = function(config) {
                                const result = originalSetup.apply(this, arguments);
                                setTimeout(() => tryDetect(this), 500);
                                return result;
                            };
                            logManager.addOnce(`jw_hooked_${playerId}`, `✅ JWPlayer(${playerId}) 훅 적용`, 3000, 'info');
                        }
                    } catch (e) {
                        logManager.logErrorWithContext(e, { message: `JWPlayer 인스턴스(${playerId}) 후킹 실패` });
                    }
                }
            });
            isHooked = true;

        }).catch(err => {
            // JWPlayer가 로드되지 않았어도 별도의 경고 메시지는 출력하지 않음
            // 다른 감지 로직이 동영상을 찾을 것이기 때문
        });
    }

    // JWPlayer 인스턴스에서 동영상 URL을 찾음
    function tryDetect(player) {
        try {
            const list = player.getPlaylist && player.getPlaylist();
            if (!list || !list.length) return;
            list.forEach(item => {
                const f = item.file || (item.sources && item.sources[0] && item.sources[0].file);
                if (f && networkMonitor.isMediaUrl(f)) networkMonitor.trackAndAttach(f, { source: 'jwplayer' });
            });
        } catch (e) {
            logManager.logErrorWithContext(e, { message: 'JWPlayer 플레이리스트 감지 실패' });
        }
    }

    return {
        init: () => hookAllPlayers()
    };
})();

    /* ============================
        mediaFinder (문서/iframe/Shadow DOM 탐색)
        ============================ */
    const mediaFinder = {
        findInDoc(doc) {
            const out = [];
            if (!doc) return out;
            try {
                doc.querySelectorAll('video, audio').forEach(m => out.push(m));
                doc.querySelectorAll('div[id*="player"], div[class*="video"], div[class*="vjs-"], .jw-player, .video-container').forEach(c => {
                    if (!c.querySelector('video, audio') && c.clientWidth > 20 && c.clientHeight > 20) out.push(c);
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
            } catch (e) { logManager.logErrorWithContext(e, null); }
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
        UI: speedSlider, dragBar, dynamicMediaUI
        ============================ */
    const DRAG_CONFIG = { PIXELS_PER_SECOND: 2 };

    const speedSlider = (() => {
        let container = null, inited = false, isMin = !!configManager.get('isMinimized'), visible = false, updateTimer;
        function createStyle() {
            if (document.getElementById('vm-speed-slider-style')) return;
            const style = document.createElement('style');
            style.id = 'vm-speed-slider-style';
            style.textContent = `
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px; z-index: 2147483647; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity .2s, width .3s; pointer-events: auto; }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; }
                #vm-speed-value { color: #f44336; font-weight: bold; font-size: 14px; margin-top: 6px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin:4px 0; }
                .vm-toggle-btn { transition: transform 0.2s ease-in-out; }
            `;
            (document.head || document.documentElement).appendChild(style);
        }
        function applySpeed(speed) {
            try {
                mediaFinder.findAll().forEach(md => {
                    try { if (md.tagName === 'VIDEO' || md.tagName === 'AUDIO') md.playbackRate = speed; } catch (e) {}
                });
            } catch (e) { logManager.logErrorWithContext(e, null); }
        }
        function init() {
            if (inited) return; inited = true;
            createStyle();
            container = document.getElementById('vm-speed-slider-container');
            if (!container) {
                container = document.createElement('div'); container.id = 'vm-speed-slider-container';
                const reset = document.createElement('button'); reset.className = 'vm-btn'; reset.textContent = '1x';
                const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0'; slider.step = '0.1'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                const val = document.createElement('div'); val.id = 'vm-speed-value'; val.textContent = 'x1.0';
                const toggle = document.createElement('button'); toggle.className = 'vm-btn vm-toggle-btn'; toggle.textContent = isMin ? '▼' : '▲';
                reset.addEventListener('click', () => { slider.value = '1.0'; applySpeed(1.0); val.textContent = 'x1.0'; });
                slider.addEventListener('input', (e) => { const s = parseFloat(e.target.value); val.textContent = `x${s.toFixed(1)}`; if (updateTimer) clearTimeout(updateTimer); updateTimer = setTimeout(() => applySpeed(s), 100); });
                toggle.addEventListener('click', () => {
                    isMin = !isMin;
                    configManager.set('isMinimized', isMin);
                    container.style.width = isMin ? '30px' : '50px';
                    if(container.querySelector('#vm-speed-slider')) container.querySelector('#vm-speed-slider').style.display = isMin ? 'none' : 'block';
                    if(container.querySelector('#vm-speed-value')) container.querySelector('#vm-speed-value').style.display = isMin ? 'none' : 'block';
                    if(container.querySelector('#vm-speed-reset-btn')) container.querySelector('#vm-speed-reset-btn').style.display = isMin ? 'none' : 'block';
                    const toggleBtn = container.querySelector('#vm-toggle-btn');
                    if(toggleBtn) toggleBtn.textContent = isMin ? '▼' : '▲';
                });
                container.appendChild(reset); container.appendChild(slider); container.appendChild(val); container.appendChild(toggle);
            }
            const appendTo = document.fullscreenElement || document.body;
            if (appendTo && !appendTo.contains(container)) {
                appendTo.appendChild(container);
            }
            if (isMin) {
                container.style.width = '30px';
                if(container.querySelector('#vm-speed-slider')) container.querySelector('#vm-speed-slider').style.display = 'none';
                if(container.querySelector('#vm-speed-value')) container.querySelector('#vm-speed-value').style.display = 'none';
                if(container.querySelector('#vm-speed-reset-btn')) container.querySelector('#vm-speed-reset-btn').style.display = 'none';
                const toggleBtn = container.querySelector('#vm-toggle-btn');
                if(toggleBtn) toggleBtn.textContent = '▼';
            } else {
                container.style.width = '50px';
                if(container.querySelector('#vm-speed-slider')) container.querySelector('#vm-speed-slider').style.display = 'block';
                if(container.querySelector('#vm-speed-value')) container.querySelector('#vm-speed-value').style.display = 'block';
                if(container.querySelector('#vm-speed-reset-btn')) container.querySelector('#vm-speed-reset-btn').style.display = 'block';
                const toggleBtn = container.querySelector('#vm-toggle-btn');
                if(toggleBtn) toggleBtn.textContent = '▲';
            }
        }
        function show() { if (!inited) init(); if (!container) return; container.style.display = 'flex'; visible = true; }
        function hide() { if (!container) return; container.style.display = 'none'; visible = false; }
        function updatePositionAndSize() {
            try {
                const m = mediaFinder.findAll().find(x => x.clientWidth > 0 && x.clientHeight > 0);
                const slider = container && container.querySelector('#vm-speed-slider');
                if (m && slider) { slider.style.height = Math.max(80, m.getBoundingClientRect().height * 0.25) + 'px'; }
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
            } catch (e) { logManager.logErrorWithContext(e, null); }
        }
        const showDisplay = (v) => {
            if (!display) {
                display = document.getElementById('vm-time-display');
                if (!display) {
                    display = document.createElement('div'); display.id = 'vm-time-display';
                    Object.assign(display.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: '2147483647', background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '10px 20px', borderRadius: '5px', fontSize: '1.5rem', display: 'none', opacity: '1', transition: 'opacity 0.3s ease-out' });
                }
            }
            const appendTo = document.fullscreenElement || document.body;
            if (appendTo && !appendTo.contains(display)) {
                appendTo.appendChild(display);
            }
            display.textContent = fmt(v);
            display.style.display = 'block';
            display.style.opacity = '1';
            visible = true;
        };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => display.style.display = 'none', 300); } visible = false; };
        function onStart(e) {
            try {
                if (speedSlider && speedSlider.isMinimized() || e.button === 2) return;
                if(e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;
                if (!mediaFinder.findAll().some(m => m.tagName === 'VIDEO' && !m.paused)) {
                    return;
                }

                const pos = e.touches ? e.touches[0] : e;
                state.dragging = true; state.startX = pos.clientX; state.startY = pos.clientY; state.accX = 0;
                document.addEventListener('mousemove', onMove, { passive: false, capture: true });
                document.addEventListener('mouseup', onEnd, { passive: false, capture: true });
                document.addEventListener('touchmove', onMove, { passive: false, capture: true });
                document.addEventListener('touchend', onEnd, { passive: false, capture: true });
            } catch (e) { logManager.logErrorWithContext(e, null); }
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
                    } else if (Math.abs(dy) > 10) {
                        return onEnd();
                    }
                }
                if (state.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    state.accX += dx;
                    state.startX = pos.clientX;
                    showDisplay(state.accX / (DRAG_CONFIG.PIXELS_PER_SECOND || 2));
                }
            } catch (e) { logManager.logErrorWithContext(e, null); onEnd(); }
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
    let btn, inited = false, visible = false, lastUrl = null;
    function init() {
        if (inited) return; inited = true;
        btn = document.getElementById('dynamic-media-url-btn');
        if (!btn) {
            btn = document.createElement('button'); btn.id = 'dynamic-media-url-btn'; btn.textContent = '🎞️ URL';
            Object.assign(btn.style, { position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647', background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', padding: '6px 8px', borderRadius: '6px', display: 'none', cursor: 'pointer', transition: 'background 0.3s' });
            document.body.appendChild(btn);
        }
        addOnceEventListener(btn, 'click', async (e) => {
            e.preventDefault(); e.stopPropagation();

            const originalText = btn.textContent;
            btn.textContent = '복사 중...';

            // 모든 감지된 URL을 가져와서 배열로 변환
            const allUrls = Array.from(networkMonitor.VIDEO_URL_CACHE.keys());

            if (allUrls.length === 0) {
                logManager.addOnce('no_url', '⚠️ 감지된 URL 없음', 3000, 'warn');
                btn.textContent = '⚠️ 없음';
                setTimeout(() => btn.textContent = originalText, 1500);
                return;
            }

            // 모든 URL을 줄바꿈으로 연결하여 복사
            const final = allUrls.map(url => networkMonitor.getOriginalURL(url) || url).join('\n');
            const ok = await copyToClipboard(final);

            btn.textContent = ok ? `✅ ${allUrls.length}개 URL 복사 완료` : '❌ 복사 실패';
            setTimeout(() => btn.textContent = originalText, 2500);
        }, true);
    }
    function show(url) { if (!inited) init(); if (url) lastUrl = url; if (!btn) return; btn.style.display = 'block'; visible = true; }
    function hide() { if (!btn) return; btn.style.display = 'none'; visible = false; }
    return { init, show, hide };
})();

    /* ============================
        mediaControls: per-media init/observe
        ============================ */
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
        const updateUIVisibility = throttle(() => {
            try {
                const hasMedia = mediaFinder.findAll().some(m => m.tagName === 'VIDEO' || m.tagName === 'AUDIO');
                if (hasMedia) { speedSlider.show(); } else { speedSlider.hide(); }
                const hasPlayingVideo = mediaFinder.findAll().some(m => m.tagName === 'VIDEO' && !m.paused);
                if (hasPlayingVideo) { dragBar.show(); dynamicMediaUI.show(); } else { dragBar.hide(); dynamicMediaUI.hide(); }
            } catch (e) { logManager.logErrorWithContext(e, null); }
        }, 400);

        function initWhenReady(media) {
            if (!media || MediaStateManager.has(media)) return;
            MediaStateManager.set(media, { isInitialized: true });
            if ((media.tagName === 'VIDEO' || media.tagName === 'AUDIO')) {
                const src = media.currentSrc || media.src || (media.dataset && media.dataset.src);
                if (src && FeatureFlags.previewFiltering && isPreviewURL(src)) { MediaStateManager.addPreview(media); logManager.addOnce('skip_preview_media_init', `🔴 미리보기로 판단되어 초기화 건너뜀: ${src}`, 4000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP); return; }
            }
            observeMediaSources(media);
            addOnceEventListener(media, 'loadedmetadata', function () {
                try {
                    if (FeatureFlags.previewFiltering && this.duration > 0 && this.duration < PREVIEW_CONFIG.DURATION_THRESHOLD) { MediaStateManager.addPreview(this); logManager.addOnce('skip_short_media', `🔴 짧은 미디어로 무시: ${this.currentSrc || this.src}`, 4000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP); return; }
                } catch (e) {}
                updateUIVisibility();
                logManager.logMediaContext(media, '미디어 로드 완료');
            }, { once: true });
            addOnceEventListener(media, 'play', () => { updateUIVisibility(); logManager.logMediaContext(media, '재생 시작'); }, true);
            addOnceEventListener(media, 'pause', () => { updateUIVisibility(); logManager.logMediaContext(media, '일시정지'); }, true);
            addOnceEventListener(media, 'ended', () => { updateUIVisibility(); logManager.logMediaContext(media, '종료'); }, true);
        }
        function detachUI(media) { try { if (MediaStateManager.has(media)) MediaStateManager.delete(media); } catch (e) {} }
        return { initWhenReady, detachUI, updateUIVisibility };
    })();

    /* ============================
        SPA: 부분 업데이트 감지
        ============================ */
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
            logManager.addOnce('spa_partial_start', '🟢 SPA 부분 업데이트 시작', 3000, 'info');
            const region = detectChangedRegion(document);
            if (!region) { App.initializeAll(document); return; }
            const medias = mediaFinder.findInSubtree(region);
            medias.forEach(m => { if (!MediaStateManager.has(m)) mediaControls.initWhenReady(m); });
            mediaControls.updateUIVisibility();
            logManager.addOnce('spa_partial_done', `🟢 SPA 부분 업데이트 완료 (미디어 ${medias.length}개)`, 3000, 'info');
        }
        return { partialUpdate };
    })();

    const spaMonitor = (() => {
        let lastURL = location.href;
        let debounceTimer = null;
        function overrideHistory(fnName) {
            const orig = originalMethods.History[fnName];
            history[fnName] = function () { const res = orig.apply(this, arguments); onNavigate(`history.${fnName}`); return res; };
        }
        function onNavigate() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const now = location.href;
                const prev = lastURL;
                if (now !== prev) {
                    const nowUrl = new URL(now);
                    const prevUrl = new URL(prev);
                    if (nowUrl.origin === prevUrl.origin && nowUrl.pathname === prevUrl.pathname) {
                        logManager.addOnce(`spa_nav_same_page`, `🔄 SPA 동일 페이지 이동 감지 (쿼리/해시 변경)`, 4000, 'info');
                    } else {
                         logManager.addOnce(`spa_nav_${now}`, `🔄 SPA 네비게이션: ${prev} -> ${now}`, 4000, 'info');
                    }
                    lastURL = now;
                    if (FeatureFlags.spaPartialUpdate) {
                        spaPartialUpdate.partialUpdate();
                    } else {
                        PROCESSED_DOCUMENTS = new WeakSet(); App.initializeAll(document);
                    }
                }
            }, 200);
        }
        function init() { overrideHistory('pushState'); overrideHistory('replaceState'); addOnceEventListener(window, 'popstate', () => onNavigate()); }
        return { init, onNavigate };
    })();

    /* ============================
        간단한 팝업/새창 차단
        ============================ */
    (function popupBlocker() {
        if (!FeatureFlags.popupBlocker) return;
        try {
            window.open = function (url, target, features) {
                try {
                    logManager.addOnce('blocked_window_open', `🔒 window.open 차단 시도: ${url}`, 3000, 'warn');
                    return null;
                } catch (e) { return originalMethods.window.open.apply(this, arguments); }
            };
            addOnceEventListener(document, 'click', (e) => {
                try {
                    const a = e.target.closest && e.target.closest('a[target="_blank"]');
                    if (a && !a.rel.includes('noopener')) a.rel = (a.rel ? a.rel + ' ' : '') + 'noopener noreferrer';
                } catch (err) {}
            }, true);
            try { Object.defineProperty(window, 'opener', { get: () => null, configurable: true }); } catch (e) {}
        } catch (e) { logManager.logErrorWithContext(e, null); }
    })();

    /* ============================
        App: 초기화·통합 MutationObserver
        ============================ */
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

    function replaceBlockedIframeUI(iframe) {
      if (!iframe || iframe.parentNode === null) return;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'background:#000;color:#fff;text-align:center;padding:10px;border:1px solid red;';
      wrapper.textContent = '⚠️ 차단된 iframe입니다. (스크립트 접근 불가)';
      try {
        iframe.parentNode.replaceChild(wrapper, iframe);
      } catch (e) {
        logManager.logErrorWithContext(e, wrapper);
      }
    }

    function logAndKeepIframe(iframe, message) {
        if (!iframe || iframe.parentNode === null) return;
        logManager.addOnce(`blocked_iframe_${iframe.src}`, `🔒 iframe ${message}: ${iframe.src}`, 6000, 'warn');
    }

    function waitForIframeReady(iframe, timeout = 4000) {
        return new Promise(resolve => {
            try {
                if (iframe.contentDocument?.readyState === 'complete') return resolve(iframe.contentDocument);
            } catch (e) { return resolve(null); }
            const obs = new MutationObserver(() => { try { if (iframe.contentDocument?.readyState === 'complete') { obs.disconnect(); resolve(iframe.contentDocument); } } catch (e) {} });
            try { obs.observe(iframe, { childList: true, subtree: true }); } catch (e) { resolve(null); return; }
            setTimeout(() => { try { obs.disconnect(); } catch (e) {} resolve(null); }, timeout);
        });
    }

    const App = (() => {
        let globalScanTimer = null;

        function initIframe(iframe) {
            if (!iframe) return;
            if (MediaStateManager.hasIframe(iframe)) return;

            const handleIframeProcessing = () => {
                const iframeSrc = iframe.src;
                if (iframeSrc && networkMonitor.isMediaUrl(iframeSrc)) {
                    networkMonitor.trackAndAttach(iframeSrc, { element: iframe, source: 'iframe.src' });
                    logManager.logIframeContext(iframe, '✅ 영상 URL 감지 (src 속성)');
                    MediaStateManager.addIframe(iframe);
                    return;
                }

                if (canAccessIframe(iframe)) {
                    const doc = iframe.contentDocument;
                    if (doc) {
                        const medias = mediaFinder.findInDoc(doc);
                        if (medias.length > 0) {
                            initializeAll(doc);
                            logManager.logIframeContext(iframe, `비동기 초기화 성공 (비디오 ${medias.length}개)`);
                        } else {
                            logManager.logIframeContext(iframe, '비동기 초기화 성공 (비디오 없음)');
                        }
                    }
                } else {
                    const hasVideo = iframe.querySelector('video') || iframe.querySelector('audio');
                    if (hasVideo || iframe.clientWidth > 100) {
                        logAndKeepIframe(iframe, '보안 정책으로 인해 제어 불가능');
                    } else {
                        if (!iframeSrc || iframeSrc.startsWith('about:blank')) {
                           logAndKeepIframe(iframe, 'src가 비어있거나 차단됨');
                        } else {
                           logAndKeepIframe(iframe, '보안 정책으로 인해 제어 불가능');
                        }
                    }
                }
            };

            addOnceEventListener(iframe, 'load', debounce(handleIframeProcessing, 500));
            MediaStateManager.addIframe(iframe);
            logManager.logIframeContext(iframe, '비동기 초기화 시작 (로드 대기)');

            const count = iframeInitAttempts.get(iframe) || 0;
            if (count >= 3) {
              logManager.logIframeContext(iframe, '최대 재시도 횟수 초과. 초기화 포기.');
              return;
            }
            iframeInitAttempts.set(iframe, count + 1);

            setTimeout(() => {
                if (!MediaStateManager.get(iframe)?.isInitialized) {
                    handleIframeProcessing();
                }
            }, 6000);
        }

        function scanExistingMedia(doc) {
          try {
            const medias = mediaFinder.findInDoc(doc);
            medias.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
            medias.forEach(m => {
                try {
                    if (m.dataset && m.dataset.src && !m.src) {
                        const candidate = m.dataset.src;
                        if (FeatureFlags.previewFiltering && isPreviewURL(candidate)) {
                            logManager.addOnce('skip_data_src', `⚠️ data-src 미리보기 스킵: ${candidate}`, 3000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                            return;
                        }
                        m.querySelectorAll && m.querySelectorAll('source').forEach(s => {
                            if (s.src) networkMonitor.trackAndAttach(s.src, { element: m });
                        });
                        const url = m.currentSrc || m.src;
                        if (url && networkMonitor.isMediaUrl(url)) {
                            networkMonitor.trackAndAttach(url, { element: m });
                        }
                    } else {
                        m.querySelectorAll && m.querySelectorAll('source').forEach(s => {
                            if (s.src) networkMonitor.trackAndAttach(s.src, { element: m });
                        });
                        const url = m.currentSrc || m.src;
                        if (url && networkMonitor.isMediaUrl(url)) {
                            networkMonitor.trackAndAttach(url, { element: m });
                        }
                    }
                } catch (e) { logManager.logErrorWithContext(e, m); }
            });
          } catch (e) { logManager.logErrorWithContext(e, null); }
        }

        function processMutations(mutations, targetDocument) {
            for (const mut of mutations) {
                try {
                    if (mut.type === 'childList') {
                        for (const n of mut.addedNodes) {
                            if (n.nodeType !== 1) continue;
                            const tag = n.tagName;
                            if (tag === 'IFRAME') initIframe(n);
                            else if (tag === 'VIDEO' || tag === 'AUDIO') mediaControls.initWhenReady(n);
                            else {
                                n.querySelectorAll && n.querySelectorAll('iframe').forEach(ifr => initIframe(ifr));
                                n.querySelectorAll && n.querySelectorAll('video,audio').forEach(m => mediaControls.initWhenReady(m));
                            }
                        }
                        for (const n of mut.removedNodes) {
                            if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO')) mediaControls.detachUI(n);
                        }
                    } else if (mut.type === 'attributes') {
                        const t = mut.target;
                        if (!t || t.nodeType !== 1) continue;
                        if (t.tagName === 'IFRAME' && mut.attributeName === 'src') { MediaStateManager.deleteIframe(t); initIframe(t); }
                        if ((t.tagName === 'VIDEO' || t.tagName === 'AUDIO') && (mut.attributeName === 'src' || mut.attributeName === 'data-src' || mut.attributeName === 'controls')) {
                            if (t.dataset && t.dataset.src && !t.src) {
                                const candidate = t.dataset.src;
                                if (FeatureFlags.previewFiltering && isPreviewURL(candidate)) logManager.addOnce('skip_data_src_mut', `⚠️ data-src 미리보기 스킵: ${candidate}`, 3000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                                else { t.src = candidate; logManager.addOnce('assign_data_src_mut', `data-src->src: ${candidate}`, 3000, 'info'); }
                            }
                            mediaControls.initWhenReady(t);
                        }
                    }
                } catch (e) { logManager.logErrorWithContext(e, null); }
            }
        }

        function startUnifiedObserver(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            const root = targetDocument.documentElement || targetDocument.body;
            if (!root) return;
            if (OBSERVER_MAP.has(targetDocument)) { try { OBSERVER_MAP.get(targetDocument).observer.disconnect(); } catch (e) {} OBSERVER_MAP.delete(targetDocument); }
            const observer = new MutationObserver(debounce((mutations) => processMutations(mutations, targetDocument), 80));
            observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'controls', 'data-src', 'data-video', 'data-url'] });
            OBSERVER_MAP.set(targetDocument, { observer });
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 (${targetDocument === document ? '메인' : 'iframe'})`, 3000, 'info');
        }

        function startPeriodicScan() {
            if (globalScanTimer) clearInterval(globalScanTimer);
            globalScanTimer = setInterval(() => {
                const allMedia = mediaFinder.findAll();
                allMedia.forEach(m => mediaControls.initWhenReady(m));
            }, 2000);
        }

        function initializeAll(targetDocument = document) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            if (targetDocument === document) {
                try {
                    logManager.init();
                    logManager.addOnce('script_init_start', '🎉 VideoSpeed_Control 초기화 시작', 4000, 'info');
                    if (spaMonitor) spaMonitor.init();
                    if (speedSlider) speedSlider.init();
                    if (dragBar) dragBar.init();
                    if (dynamicMediaUI) dynamicMediaUI.init();
                    if (jwplayerMonitor) jwplayerMonitor.init(window);
                    if (networkMonitor) networkMonitor.init();
                } catch (e) { logManager.logErrorWithContext(e, null); }
                addOnceEventListener(document, 'fullscreenchange', () => {
                    const targetParent = document.fullscreenElement || document.body;
                    if(speedSlider.container() && speedSlider.container().parentNode !== targetParent) {
                        targetParent.appendChild(speedSlider.container());
                    }
                    if(dragBar.display() && dragBar.display().parentNode !== targetParent) {
                        targetParent.appendChild(dragBar.display());
                    }
                    speedSlider.updatePositionAndSize();
                });
                startPeriodicScan();
            } else {
                try { networkMonitor.init(); } catch (e) {}
            }
            startUnifiedObserver(targetDocument);
            scanExistingMedia(targetDocument);
            mediaFinder.findInDoc(targetDocument).forEach(m => mediaControls.initWhenReady(m));
            targetDocument.querySelectorAll && targetDocument.querySelectorAll('iframe').forEach(ifr => initIframe(ifr));
            mediaControls.updateUIVisibility();
        }
        return { initializeAll };
    })();

    /* ============================
        문서 준비 시 초기화
        ============================ */
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        App.initializeAll(document);
    } else {
        window.addEventListener('DOMContentLoaded', () => App.initializeAll(document));
    }
})();
