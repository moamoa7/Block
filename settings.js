// ==UserScript==
// @name 			    VideoSpeed_Lite_Final_Unified_v22
// @namespace 		https.com/
// @version 		  15.0
// @description 	🎞️ 비디오 속도 제어 UI + 🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합 (네트워크/API/DOM 후킹 강화 버전)
// @match 			  *://*/*
// @grant 			  GM_xmlhttpRequest
// @grant 			  none
// @connect 		  *
// @run-at 			  document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 전역 설정 및 기능 플래그 ---
    const FeatureFlags = {
        videoControls: true,
        logUI: true,
        enhanceURLDetection: true,
    };
    const DRAG_CONFIG = {
        PIXELS_PER_SECOND: 2
    };
    const POLLING_TIMEOUT_MS = 2 * 60 * 1000;

    // --- 스크립트 초기 실행 전 예외 처리 ---
    if (window.hasOwnProperty('__MySuperScriptInitialized') && window.__MySuperScriptInitialized) {
        return;
    }
    Object.defineProperty(window, '__MySuperScriptInitialized', {
        value: true, writable: false, configurable: true
    });

    // --- 전역 상태 및 중복 방지 ---
    let PROCESSED_NODES = new WeakSet();
    let PROCESSED_IFRAMES = new WeakSet();
    let PROCESSED_DOCUMENTS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const LOGGED_KEYS_WITH_TIMER = new Map();
    const VIDEO_STATE = new WeakMap();
    const VIDEO_URL_CACHE = new Set();
    const isTopFrame = window.self === window.top;

    // --- 유틸리티 함수 ---
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    const requestIdleCallback = window.requestIdleCallback || function (cb) {
        const start = Date.now();
        return setTimeout(() => {
            cb({
                didTimeout: false,
                timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
            });
        }, 16);
    };

    // --- 로그 모듈 ---
    const logManager = (() => {
        let logBoxContainer = null;
        let logContentBox = null;
        let logDismissTimer = null;
        const logHistory = [];
        const pendingLogs = [];

        function addLogToBox(msg) {
            if (!logContentBox) {
                pendingLogs.push(msg);
                return;
            }
            logHistory.push(msg);
            if (logHistory.length > 50) logHistory.shift();
            if (logBoxContainer) {
                logBoxContainer.style.opacity = '1';
                logBoxContainer.style.pointerEvents = 'auto';
            }
            const MAX_LOGS = 50;
            if (logContentBox.childElementCount >= MAX_LOGS) {
                logContentBox.removeChild(logContentBox.firstChild);
            }
            const entry = document.createElement('div');
            entry.textContent = msg;
            entry.style.textAlign = 'left';
            logContentBox.appendChild(entry);
            logContentBox.scrollTop = logContentBox.scrollHeight;

            if (logDismissTimer) clearTimeout(logDismissTimer);
            logDismissTimer = setTimeout(() => {
                if (logBoxContainer) {
                    logBoxContainer.style.opacity = '0';
                    logBoxContainer.style.pointerEvents = 'none';
                }
            }, 10000);
        }

        function addLog(msg, level = 'info') {
            const ICONS = { info: 'ℹ️', warn: '⚠️', 'error': '🔴', 'allow': '✅', 'debug': '🔧', 'stream': '▶️' };
            const fullMsg = `[${new Date().toLocaleTimeString()}] ${ICONS[level] || ''} ${msg}`;
            console[level] ? console[level](fullMsg) : console.log(fullMsg);
            if (!FeatureFlags.logUI) return;
            if (!isTopFrame) {
                try {
                    window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: fullMsg, level: level, key: msg }, '*');
                    return;
                } catch (e) {}
            }
            addLogToBox(fullMsg);
        }

        function addLogOnce(key, message, delay = 5000, level = 'info') {
            const now = Date.now();
            for (const [k, t] of LOGGED_KEYS_WITH_TIMER) {
                if (now - t > delay) {
                    LOGGED_KEYS_WITH_TIMER.delete(k);
                }
            }
            const lastTime = LOGGED_KEYS_WITH_TIMER.get(key);
            if (!lastTime || now - lastTime > delay) {
                LOGGED_KEYS_WITH_TIMER.set(key, now);
                addLog(message, level);
            }
        }

        function init() {
            if (!isTopFrame || !FeatureFlags.logUI || document.getElementById('popupBlockerLogContainer')) return;
            logBoxContainer = document.createElement('div');
            logBoxContainer.id = 'popupBlockerLogContainer';
            Object.assign(logBoxContainer.style, {
                position: 'fixed', bottom: '0', right: '0', maxHeight: '100px',
                width: '350px', zIndex: '9999998', borderTopLeftRadius: '8px',
                overflow: 'hidden', opacity: '0', pointerEvents: 'none',
                transition: 'opacity 0.3s ease', boxShadow: '0 0 8px #000'
            });
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '로그 복사';
            Object.assign(copyBtn.style, {
                position: 'absolute', top: '0', right: '0', background: 'rgba(50,50,50,0.9)',
                color: '#fff', border: 'none', borderBottomLeftRadius: '8px',
                padding: '4px 8px', fontSize: '12px', cursor: 'pointer', zIndex: '9999999',
                opacity: '0.8'
            });
            copyBtn.onclick = () => {
                if (logHistory.length > 0) {
                    const logText = logHistory.join('\n');
                    navigator.clipboard.writeText(logText).then(() => {
                        copyBtn.textContent = '복사 완료!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    }).catch(() => {
                        copyBtn.textContent = '복사 실패!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    });
                }
            };
            logBoxContainer.appendChild(copyBtn);
            logContentBox = document.createElement('div');
            logContentBox.id = 'popupBlockerLogBox';
            Object.assign(logContentBox.style, {
                maxHeight: '100%', width: '100%', background: 'rgba(30,30,30,0.9)',
                color: '#fff', fontFamily: 'monospace', fontSize: '14px',
                overflowY: 'auto', padding: '8px', paddingTop: '25px', userSelect: 'text'
            });
            logBoxContainer.appendChild(logContentBox);

            if (document.body) {
                document.body.appendChild(logBoxContainer);
                while (pendingLogs.length > 0) {
                    addLogToBox(pendingLogs.shift());
                }
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    if (document.body && !document.body.contains(logBoxContainer)) {
                        document.body.appendChild(logBoxContainer);
                        while (pendingLogs.length > 0) {
                            addLogToBox(pendingLogs.shift());
                        }
                    }
                });
            }
        }
        return { init, add: addLog, addOnce: addLogOnce };
    })();

    // --- 네트워크 모니터링 모듈 ---
    const networkMonitor = (() => {
        const originalXHR = XMLHttpRequest.prototype.open;
        const originalFetch = window.fetch;
        let capturedVideoURLs = new Set();
        const blobToOriginalURLMap = new Map();
        const mediaSourceBlobMap = new Map();
        let lastCapturedM3U8 = null;
        let lastCapturedMPD = null;
        const TRACKED_VIDEO_EXTENSIONS = ['.m3u8', '.mpd', '.ts', '.mp4', '.webm', '.m4s', '.mov', '.flv', '.avi'];

        const isVideoLikeRequest = (url) => {
            return /\.(m3u8|mpd|mp4|webm|mov|avi|flv|ts|m4s)(\?|#|$)/i.test(url);
        };
        const isVideoMimeType = (mime) => mime?.includes('video/') || mime?.includes('octet-stream') || mime?.includes('mpegurl') || mime?.includes('mp2t') || mime?.includes('application/dash+xml');
        const isVideoUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.toLowerCase();
            return normalizedUrl.includes('mime=video') || isVideoLikeRequest(url) || normalizedUrl.startsWith('blob:') && blobToOriginalURLMap.has(normalizedUrl);
        };
        const normalizeURL = (url) => {
            try {
                const u = new URL(url, location.href);
                u.hash = '';
                return u.toString();
            } catch {
                return url;
            }
        };

        const getOriginalURLIfBlob = (url) => {
            const originalUrl = blobToOriginalURLMap.get(url) || url;
            if (originalUrl.startsWith('blob:')) {
                const mappedUrl = mediaSourceBlobMap.get(url);
                if (mappedUrl && mappedUrl !== 'MediaSource') {
                    return mappedUrl;
                }
                return lastCapturedM3U8 || lastCapturedMPD || url;
            }
            return originalUrl;
        };

        const trackAndAttach = (url) => {
            const norm = normalizeURL(url);
            if (capturedVideoURLs.has(norm)) return;
            capturedVideoURLs.add(norm);

            logManager.addOnce(`network_url_detected_${norm.substring(0,50)}`, `💻 영상 URL 감지됨: ${norm}`, 5000, 'info');

            if (blobToOriginalURLMap.size > 200) blobToOriginalURLMap.clear();
            if (mediaSourceBlobMap.size > 100) mediaSourceBlobMap.clear();
        };

        const fetchTextCrossOrigin = (url, callback) => {
            // GM_xmlhttpRequest가 지원되는지 확인
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    headers: {
                        "User-Agent": navigator.userAgent,
                        "Accept": "*/*"
                    },
                    onload: function (res) {
                        if (res.status >= 200 && res.status < 300) {
                            callback(null, res.responseText);
                        } else {
                            callback(new Error(`HTTP Error ${res.status}`));
                        }
                    },
                    onerror: function () {
                        callback(new Error("Network Error"));
                    }
                });
            } else {
                // GM_xmlhttpRequest가 지원되지 않는 경우, 기존 fetch() 사용
                fetch(url)
                    .then(res => {
                        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
                        return res.text();
                    })
                    .then(text => callback(null, text))
                    .catch(err => callback(err));
            }
        };

        async function parseMPD(url) {
            if (VIDEO_URL_CACHE.has(url)) return;
            VIDEO_URL_CACHE.add(url);

            fetchTextCrossOrigin(url, (err, text) => {
                if (err) {
                    logManager.addOnce(`mpd_parse_fail_${url.substring(0,50)}`, `⚠️ MPD 파싱 실패: ${url} - ${err.message}`, 5000, 'error');
                    return;
                }

                if (!text.includes("<MPD")) {
                    logManager.addOnce(`mpd_parse_fail_no_tag_${url.substring(0,50)}`, `⚠️ MPD 파싱 실패 (MPD 태그 없음): ${url}`, 5000, 'warn');
                    return;
                }

                try {
                    const parser = new DOMParser();
                    const xml = parser.parseFromString(text, "application/xml");

                    const baseURLs = Array.from(xml.getElementsByTagName("BaseURL"))
                        .map(el => el.textContent.trim());
                    const base = baseURLs[0] ? new URL(baseURLs[0], url).href : url;

                    const segmentTemplates = Array.from(xml.getElementsByTagName("SegmentTemplate"));
                    const segmentBases = Array.from(xml.getElementsByTagName("SegmentBase"));
                    const representations = Array.from(xml.getElementsByTagName("Representation"));

                    logManager.addOnce(`mpd_parse_success_${url.substring(0,50)}`, `ℹ️ ✅ MPD 파싱 완료: ${url}`, 5000, 'info');
                    lastCapturedMPD = url;

                    // ✅ SegmentTemplate
                    for (const template of segmentTemplates) {
                        const media = template.getAttribute("media");
                        const init = template.getAttribute("initialization");
                        const startNumber = parseInt(template.getAttribute("startNumber") || "1", 10);
                        if (init) {
                            const initURL = new URL(init, base).href;
                            if (!VIDEO_URL_CACHE.has(initURL)) {
                                VIDEO_URL_CACHE.add(initURL);
                                logManager.addOnce(`mpd_init_${initURL.substring(0,50)}`, `🔰 MPD 초기화 세그먼트: ${initURL}`, 5000, 'stream');
                                trackAndAttach(initURL);
                            }
                        }
                        if (media?.includes("$Number$")) {
                            for (let i = startNumber; i < startNumber + 3; i++) {
                                const seg = media.replace("$Number$", i);
                                const segURL = new URL(seg, base).href;
                                if (!VIDEO_URL_CACHE.has(segURL)) {
                                    VIDEO_URL_CACHE.add(segURL);
                                    logManager.addOnce(`mpd_seg_${segURL.substring(0,50)}`, `▶️ MPD 예측 세그먼트: ${segURL}`, 5000, 'stream');
                                    trackAndAttach(segURL);
                                }
                            }
                        }
                    }
                    // ✅ SegmentBase (e.g. YouTube)
                    for (const baseTag of segmentBases) {
                        const indexRange = baseTag.getAttribute("indexRange");
                        if (indexRange) {
                            for (const rep of representations) {
                                const baseURLTag = rep.getElementsByTagName("BaseURL")[0];
                                if (baseURLTag) {
                                    const mediaURL = new URL(baseURLTag.textContent.trim(), url).href;
                                    if (!VIDEO_URL_CACHE.has(mediaURL)) {
                                        VIDEO_URL_CACHE.add(mediaURL);
                                        logManager.addOnce(`mpd_base_${mediaURL.substring(0,50)}`, `▶️ SegmentBase 미디어 URL: ${mediaURL}`, 5000, 'stream');
                                        trackAndAttach(mediaURL);
                                    }
                                }
                            }
                        }
                    }
                } catch (err) {
                    logManager.addOnce(`parse_mpd_fail_dom_${url.substring(0,50)}`, `⚠️ MPD DOM 파싱 실패: ${url} - ${err.message}`, 5000, 'error');
                }
            });
        }

        async function parseM3U8(url, depth = 0) {
            if (depth > 2 || VIDEO_URL_CACHE.has(url)) return;
            VIDEO_URL_CACHE.add(url);

            fetchTextCrossOrigin(url, (err, text) => {
                if (err) {
                    logManager.addOnce(`m3u8_parse_fail_${url.substring(0,50)}`, `⚠️ M3U8 파싱 실패: ${url} - ${err.message}`, 5000, 'error');
                    return;
                }

                if (!text.includes('#EXTM3U')) {
                    logManager.addOnce(`m3u8_parse_fail_header_${url.substring(0,50)}`, `⚠️ M3U8 파싱 실패 (헤더 누락): ${url}`, 5000, 'warn');
                    return;
                }

                const isMaster = text.includes('#EXT-X-STREAM-INF');
                if (isMaster) {
                    logManager.addOnce(`m3u8_master_${url.substring(0,50)}`, `ℹ️ ✅ M3U8 Master 감지: ${url}`, 5000, 'info');
                } else {
                    logManager.addOnce(`m3u8_variant_${url.substring(0,50)}`, `ℹ️ ✅ M3U8 Variant 감지: ${url}`, 5000, 'info');
                }
                if (depth === 0) lastCapturedM3U8 = url;

                const base = url.split('/').slice(0, -1).join('/') + '/';
                const lines = (text.match(/^[^#][^\r\n]+$/gm) || []).map(l => l.trim());

                for (const line of lines) {
                    const abs = new URL(line, base).href;
                    if (abs.toLowerCase().endsWith('.m3u8')) {
                        parseM3U8(abs, depth + 1);
                    } else if (isMediaSegmentURL(abs)) {
                        if (!VIDEO_URL_CACHE.has(abs)) {
                            VIDEO_URL_CACHE.add(abs);
                            logManager.addOnce(`m3u8_seg_${abs.substring(0,50)}`, `▶️ M3U8 세그먼트: ${abs}`, 5000, 'stream');
                            trackAndAttach(abs);
                        }
                    }
                }
            });
        }

        const isMediaSegmentURL = (url) => {
            return /\.(ts|mp4|m4s|webm)(\?|#|$)/i.test(url);
        }

        async function parseJSONResponse(url, responseClone) {
            try {
                const json = await responseClone.json();
                const urls = [];
                function recursiveSearch(obj) {
                    if (typeof obj === 'string' && isVideoLikeRequest(obj)) {
                        urls.push(obj);
                    } else if (typeof obj === 'object' && obj !== null) {
                        for (const key in obj) {
                            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                                recursiveSearch(obj[key]);
                            }
                        }
                    }
                }
                recursiveSearch(json);
                if (urls.length) {
                    logManager.addOnce(`api_json_urls_${url.substring(0,50)}`, `🔎 API 응답(JSON) 내 영상 URL 발견: ${urls.join(', ')}`, 5000, 'info');
                    urls.forEach(trackAndAttach);
                }
            } catch (e) {
                // JSON 파싱 오류는 무시
            }
        }

        async function handleStreamManifest(url, contentType = "") {
            if (VIDEO_URL_CACHE.has(url)) return;
            const lower = url.toLowerCase();
            if (lower.endsWith(".m3u8") || contentType?.includes("application/vnd.apple.mpegurl")) {
                parseM3U8(url);
            } else if (lower.endsWith(".mpd") || contentType?.includes("application/dash+xml")) {
                parseMPD(url);
            }
        }

        const hookPrototypes = () => {
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this.__pbivs_originalUrl = url;
                if (url) {
                    handleStreamManifest(url);
                }
                return origOpen.apply(this, [method, url, ...args]);
            };

            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(...sendArgs) {
                this.addEventListener('load', () => {
                    const contentType = this.getResponseHeader('Content-Type');
                    const url = this.__pbivs_originalUrl;
                    if (url && (isVideoUrl(url) || isVideoMimeType(contentType))) {
                        logManager.addOnce(`network_detected_xhr_${url.substring(0,50)}`, `🎥 XHR 영상 URL 감지됨: ${url}`, 5000, 'info');
                        trackAndAttach(url);
                    }
                });
                return origSend.apply(this, sendArgs);
            };

            if (originalFetch) {
                window.fetch = async function(input, init) {
                    const url = typeof input === 'string' ? input : input.url;
                    if (url) {
                        await handleStreamManifest(url);
                    }
                    const res = await originalFetch.call(this, input, init);
                    const resClone = res.clone();
                    const contentType = res.headers.get("content-type");
                    if (isVideoUrl(url) || isVideoMimeType(contentType)) {
                        logManager.addOnce(`network_detected_fetch_${url.substring(0,50)}`, `🎥 fetch 영상 URL 감지됨: ${url}`, 5000, 'info');
                        trackAndAttach(url);
                    }
                    if (contentType?.includes('application/json')) {
                        parseJSONResponse(url, resClone);
                    }
                    // handleStreamManifest는 이제 비동기 fetch가 아닌 동기식 GM_xmlhttpRequest를 사용
                    // 따라서 이 부분에서 다시 호출할 필요 없음
                    return res;
                };
            }

            // MediaSource 후킹 (addSourceBuffer)
            const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            if (originalAddSourceBuffer) {
                MediaSource.prototype.addSourceBuffer = function(mimeType) {
                    logManager.addOnce(`mse_add_source_buffer`, `🛰️ MediaSource.addSourceBuffer 호출됨 | MIME: ${mimeType}`, 5000, 'debug');
                    return originalAddSourceBuffer.apply(this, arguments);
                };
            }

            const origSrcObjDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
            if (origSrcObjDescriptor?.set) {
                Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
                    set(obj) {
                        if (obj instanceof MediaSource) {
                            const originalUrl = mediaSourceBlobMap.get(obj);
                            if (originalUrl) {
                                trackAndAttach(originalUrl);
                                logManager.addOnce('srcObject_stream_detected', `🛰️ srcObject 스트림 감지됨 (원본: ${originalUrl})`, 5000, 'info');
                            }
                        }
                        return origSrcObjDescriptor.set.call(this, obj);
                    },
                    get() { return origSrcObjDescriptor.get.call(this); }
                });
            }

            const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
            if (origSrcDescriptor?.set) {
                Object.defineProperty(HTMLMediaElement.prototype, "src", {
                    set(value) {
                        if (value && isVideoUrl(value)) {
                            logManager.addOnce(`video_src_set_${value.substring(0,50)}`, `🎥 video.src 변경 감지: ${value}`, 5000, 'info');
                            trackAndAttach(value);
                        }
                        return origSrcDescriptor.set.call(this, value);
                    },
                    get() { return origSrcDescriptor.get.call(this); }
                });
            }

            const originalCreateObjectURL = URL.createObjectURL;
            if (originalCreateObjectURL) {
                URL.createObjectURL = function(obj) {
                    const url = originalCreateObjectURL.call(this, obj);
                    if (obj instanceof MediaSource) {
                        if (lastCapturedM3U8 || lastCapturedMPD) {
                            const originalUrl = lastCapturedM3U8 || lastCapturedMPD;
                            mediaSourceBlobMap.set(obj, originalUrl);
                            logManager.addOnce('createObjectURL_mse_${url}', `[URL] MediaSource에 Blob URL 할당됨 (원본: ${originalUrl})`, 5000, 'info');
                        }
                    } else if (obj instanceof Blob && isVideoMimeType(obj.type)) {
                        blobToOriginalURLMap.set(url, url);
                        logManager.addOnce(`createObjectURL_blob_${url}`, `[URL] 비디오 Blob URL 생성됨: ${url}`, 5000, 'info');
                        trackAndAttach(url);
                    }
                    return url;
                };
            }
        };

        const hookDecoders = () => {
            const originalAtob = window.atob;
            if (originalAtob) {
                window.atob = function(str) {
                    const decoded = originalAtob.apply(this, arguments);
                    if (typeof decoded === 'string' && isVideoLikeRequest(decoded)) {
                        logManager.addOnce(`atob_decoded_${decoded.substring(0,50)}`, `🔑 atob()로 복호화된 영상 URL 감지: ${decoded}`, 5000, 'info');
                        trackAndAttach(decoded);
                    }
                    return decoded;
                };
            }

            const originalDecodeURIComponent = window.decodeURIComponent;
            if (originalDecodeURIComponent) {
                window.decodeURIComponent = function(str) {
                    const decoded = originalDecodeURIComponent.apply(this, arguments);
                    if (typeof decoded === 'string' && isVideoLikeRequest(decoded)) {
                        logManager.addOnce(`decode_uri_component_${decoded.substring(0,50)}`, `🔑 decodeURIComponent()로 복호화된 영상 URL 감지: ${decoded}`, 5000, 'info');
                        trackAndAttach(decoded);
                    }
                    return decoded;
                };
            }
        };

        const resetState = () => {
            capturedVideoURLs.clear();
            blobToOriginalURLMap.clear();
            mediaSourceBlobMap.clear();
            lastCapturedM3U8 = null;
            lastCapturedMPD = null;
            VIDEO_URL_CACHE.clear();
        };

        const init = () => {
            if (FeatureFlags.enhanceURLDetection) {
                hookPrototypes();
                hookDecoders();
            }
        };

        return {
            init,
            getOriginalURLIfBlob,
            isVideoUrl,
            trackAndAttach,
            reportVideoURL: trackAndAttach,
            resetState
        };
    })();

    // --- JWPlayer 모니터링 모듈 추가 ---
    const jwplayerMonitor = (() => {
        let lastItemURL = null;
        let pollTimer = null;
        let isHooked = false;

        const checkPlayer = (player) => {
            try {
                const playlist = player.getPlaylist?.();
                if (!playlist) return;
                playlist.forEach(item => {
                    const fileUrl = item?.file || item?.sources?.[0]?.file;
                    if (fileUrl && fileUrl !== lastItemURL) {
                        lastItemURL = fileUrl;
                        if (networkMonitor.isVideoUrl(fileUrl)) {
                            logManager.addOnce(`jwplayer_polling_${fileUrl.substring(0,50)}`, `🎥 JWPlayer 영상 URL 감지됨: ${fileUrl}`, 5000, 'info');
                            networkMonitor.reportVideoURL(fileUrl);
                        }
                    }
                });
            } catch (e) {}
        };

        const hookJWPlayer = (context) => {
            if (isHooked || !context.jwplayer) return;
            const origJW = context.jwplayer;
            context.jwplayer = function (...args) {
                const player = origJW.apply(this, args);
                if (player && typeof player.setup === 'function') {
                    const origSetup = player.setup;
                    player.setup = function (config) {
                        const result = origSetup.call(this, config);
                        setTimeout(() => checkPlayer(this), 500);
                        startPolling(this);
                        return result;
                    };
                }
                return player;
            };
            Object.assign(context.jwplayer, origJW);
            isHooked = true;
            logManager.addOnce('jwplayer_hooked', `✅ JWPlayer 후킹 성공`, 5000, 'info');
        };

        const startPolling = (player) => {
            if (pollTimer) stopPolling();
            pollTimer = setInterval(() => checkPlayer(player), 2000);
            logManager.addOnce('jwplayer_polling_start', `✅ JWPlayer 폴링 시작`, 5000, 'info');
        };

        const stopPolling = () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
                logManager.addOnce('jwplayer_polling_stop', `📴 JWPlayer 폴링 중지`, 5000, 'info');
            }
        };

        const resetState = () => {
            lastItemURL = null;
            stopPolling();
            isHooked = false;
        };

        return { init: hookJWPlayer, resetState };
    })();

    // --- 비디오 탐색 모듈 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            if (!doc || !doc.body) return videos;
            doc.querySelectorAll('video').forEach(v => videos.push(v));
            doc.querySelectorAll('div.jw-player, div[id*="player"], div.video-js, div[class*="video-container"], div.vjs-tech').forEach(container => {
                if (!container.querySelector('video') && container.clientWidth > 0 && container.clientHeight > 0) {
                    videos.push(container);
                }
            });
            doc.querySelectorAll('[data-src], [data-video], [data-url]').forEach(el => {
                const src = el.getAttribute('data-src') || el.getAttribute('data-video') || el.getAttribute('data-url');
                if (src && networkMonitor.isVideoUrl(src)) {
                    logManager.addOnce(`dom_data_url_${src.substring(0,50)}`, `🔍 DOM 데이터 속성에서 URL 감지: ${src}`, 5000, 'info');
                    networkMonitor.trackAndAttach(src);
                }
            });
            doc.querySelectorAll('script:not([src])').forEach(script => {
                const text = script.textContent;
                const urls = [...text.matchAll(/https?:\/\/[^\s'"]+\.(mp4|m3u8|mpd|blob:[^\s'"]+)/gi)].map(m => m[0]);
                if (urls.length) {
                    logManager.addOnce(`inline_script_urls_${urls[0].substring(0,50)}`, `🔍 인라인 스크립트에서 URL 감지: ${urls.join(', ')}`, 5000, 'info');
                    urls.forEach(networkMonitor.trackAndAttach);
                }
            });
            return videos;
        },
        findAll: () => {
            let videos = videoFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDocument) videos.push(...videoFinder.findInDoc(iframeDocument));
                } catch (e) {}
            });
            return videos;
        },
        findLargestParent: (element) => {
            let largestElement = element;
            let largestArea = 0;
            let current = element;
            while (current && current !== document.body) {
                const rect = current.getBoundingClientRect();
                const area = rect.width * rect.height;
                const style = window.getComputedStyle(current);
                const isRelativeOrAbsolute = style.position === 'relative' || style.position === 'absolute';
                if (area > largestArea && area < window.innerWidth * window.innerHeight * 0.9) {
                    if (isRelativeOrAbsolute) return current;
                    largestArea = area;
                    largestElement = current;
                }
                current = current.parentElement;
            }
            return largestElement;
        }
    };

    // --- 비디오 UI 모듈 (슬라이더) ---
    const speedSlider = (() => {
        let speedSliderContainer;
        let playbackUpdateTimer;
        let isMinimized = JSON.parse(localStorage.getItem('speedSliderMinimized') || 'true');
        let isInitialized = false;

        const createSliderElements = () => {
            if (document.getElementById('vm-speed-slider-style')) return;
            const style = document.createElement('style');
            style.id = 'vm-speed-slider-style';
            style.textContent = `
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px; z-index: 2147483647 !important; display: none; flex-direction: column; align-items: center; width: 50px; height: auto; font-family: sans-serif; pointer-events: auto; opacity: 0.3; transition: all 0.3s ease; user-select: none; box-shadow: 0 0 8px rgba(0,0,0,0.0); will-change: transform, opacity, width; }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-reset-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 14px; padding: 4px 6px; cursor: pointer; margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold; }
                #vm-speed-reset-btn:hover { background: #666; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer; background: #555; border-radius: 5px; }
                #vm-speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: #f44336; border-radius: 50%; cursor: pointer; border: 1px solid #ddd; }
                #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                #vm-toggle-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 12px; padding: 4px 6px; cursor: pointer; font-weight: bold; width: 40px; height: 30px; margin-top: 8px; transition: transform 0.2s ease-in-out; }
            `;
            (document.head || document.body).appendChild(style);
        };

        const updateSpeed = (speed) => {
            const validSpeed = parseFloat(speed);
            if (isNaN(validSpeed)) return;
            const videos = videoFinder.findAll();
            videos.forEach(video => { video.playbackRate = validSpeed; });
        };

        const onSliderChange = (val) => {
            const speed = parseFloat(val);
            if (isNaN(speed)) return;
            const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
            if (valueDisplay) valueDisplay.textContent = `x${speed.toFixed(1)}`;
            if (playbackUpdateTimer) clearTimeout(playbackUpdateTimer);
            playbackUpdateTimer = setTimeout(() => updateSpeed(speed), 100);
        };

        const toggleMinimize = () => {
            const container = speedSliderContainer;
            if (!container) return;
            const slider = container.querySelector('#vm-speed-slider');
            const valueDisplay = container.querySelector('#vm-speed-value');
            const resetBtn = container.querySelector('#vm-speed-reset-btn');
            const toggleBtn = container.querySelector('#vm-toggle-btn');
            isMinimized = !isMinimized;
            localStorage.setItem('speedSliderMinimized', isMinimized);
            if (isMinimized) {
                container.style.width = '30px';
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
                if (toggleBtn) toggleBtn.textContent = '▼';
                dragBar.hide();
            } else {
                container.style.width = '50px';
                if (slider) slider.style.display = 'block';
                if (valueDisplay) valueDisplay.style.display = 'block';
                if (resetBtn) resetBtn.style.display = 'block';
                if (toggleBtn) toggleBtn.textContent = '▲';
                speedSlider.updatePositionAndSize();
                const isVideoPlaying = videoFinder.findAll().some(v => !v.paused);
                if (isVideoPlaying) dragBar.show();
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            createSliderElements();
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', init);
                return;
            }

            speedSliderContainer = document.getElementById('vm-speed-slider-container');
            if (!speedSliderContainer) {
                speedSliderContainer = document.createElement('div');
                speedSliderContainer.id = 'vm-speed-slider-container';

                const slider = document.createElement('input');
                slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
                slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                slider.addEventListener('input', e => onSliderChange(e.target.value), true);
                slider.addEventListener('change', e => updateSpeed(parseFloat(e.target.value)), true);

                const resetBtn = document.createElement('button');
                resetBtn.id = 'vm-speed-reset-btn'; resetBtn.textContent = '1x';
                resetBtn.addEventListener('click', e => { slider.value = '1.0'; onSliderChange('1.0'); });

                const valueDisplay = document.createElement('div');
                valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';

                const toggleBtn = document.createElement('button');
                toggleBtn.id = 'vm-toggle-btn'; toggleBtn.textContent = isMinimized ? '▼' : '▲';
                toggleBtn.addEventListener('click', toggleMinimize);

                speedSliderContainer.appendChild(resetBtn);
                speedSliderContainer.appendChild(slider);
                speedSliderContainer.appendChild(valueDisplay);
                speedSliderContainer.appendChild(toggleBtn);

                if (document.body && !document.body.contains(speedSliderContainer)) {
                    document.body.appendChild(speedSliderContainer);
                }
            }
            if (isMinimized) {
                speedSliderContainer.style.width = '30px';
                const slider = speedSliderContainer.querySelector('#vm-speed-slider');
                const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
                const resetBtn = speedSliderContainer.querySelector('#vm-speed-reset-btn');
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
            }
        };

        const show = () => {
            if (!speedSliderContainer) init();
            if (!speedSliderContainer) return;
            if (!document.body.contains(speedSliderContainer)) {
                document.body.appendChild(speedSliderContainer);
            }
            speedSliderContainer.style.display = 'flex';
            updatePositionAndSize();
            const slider = speedSliderContainer.querySelector('#vm-speed-slider');
            if (slider) updateSpeed(slider.value);
        };
        const hide = () => {
            if (speedSliderContainer) speedSliderContainer.style.display = 'none';
        };

        const updatePositionAndSize = () => {
            const sliderContainer = speedSliderContainer;
            if (!sliderContainer) return;
            const videos = videoFinder.findAll();
            const video = videos.find(v => v.clientWidth > 0 && v.clientHeight > 0);
            const slider = sliderContainer.querySelector('#vm-speed-slider');
            const newHeight = video ? Math.max(100, video.getBoundingClientRect().height * 0.3) : 100;
            if (slider) slider.style.height = `${newHeight}px`;
            const targetParent = document.fullscreenElement || document.body;
            if (sliderContainer.parentNode !== targetParent) {
                targetParent.appendChild(sliderContainer);
            }
        };

        return { init, show, hide, updatePositionAndSize, isMinimized: () => isMinimized };
    })();

    // --- 비디오 UI 모듈 (드래그 바) ---
    const dragBar = (() => {
        let dragBarTimeDisplay;
        const dragState = {
            isDragging: false, isHorizontalDrag: false,
            startX: 0, startY: 0, lastUpdateX: 0,
            currentDragDistanceX: 0, totalTimeChange: 0,
            recoveryTimer: null, throttleTimer: null, lastDragTimestamp: 0
        };
        let isInitialized = false;

        const formatTime = (seconds) => {
            const absSeconds = Math.abs(seconds);
            const sign = seconds < 0 ? '-' : '+';
            const minutes = Math.floor(absSeconds / 60);
            const remainingSeconds = Math.floor(absSeconds % 60);
            const paddedMinutes = String(minutes).padStart(2, '0');
            const paddedSeconds = String(remainingSeconds).padStart(2, '0');
            return `${sign}${paddedMinutes}분${paddedSeconds}초`;
        };

        const updateTimeDisplay = (totalTimeChange) => {
            if (!dragBarTimeDisplay) return;
            if (totalTimeChange !== 0) {
                dragBarTimeDisplay.textContent = formatTime(totalTimeChange);
                dragBarTimeDisplay.style.display = 'block';
                dragBarTimeDisplay.style.opacity = '1';
            } else {
                dragBarTimeDisplay.style.opacity = '0';
                if (dragBarTimeDisplay.timer) clearTimeout(dragBarTimeDisplay.timer);
                dragBarTimeDisplay.timer = setTimeout(() => {
                    if (dragBarTimeDisplay.style.opacity === '0') {
                        dragBarTimeDisplay.style.display = 'none';
                    }
                    dragBarTimeDisplay.timer = null;
                }, 300);
            }
        };

        const applyTimeChange = () => {
            const videos = videoFinder.findAll();
            const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
            const timeToApply = Math.round(dragState.totalTimeChange / pixelsPerSecond);
            if (timeToApply !== 0) {
                videos.forEach(video => {
                    if (video && video.duration && isFinite(video.duration)) {
                        const newTime = Math.min(video.duration, Math.max(0, video.currentTime + timeToApply));
                        video.currentTime = newTime;
                    }
                });
            }
        };

        const cancelDrag = () => {
            if (!dragState.isDragging) return;
            try {
                if (dragState.recoveryTimer) {
                    clearTimeout(dragState.recoveryTimer);
                    dragState.recoveryTimer = null;
                }
                updateTimeDisplay(0);
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                if(document.body) document.body.style.userSelect = '';
                if(document.body) document.body.style.touchAction = '';
                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) {
                logManager.addOnce('drag_cancel_error', `드래그 취소 오류: ${e.message}\n${e.stack}`, 5000, 'error');
            }
        };

        const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;
        const handleStart = (e) => {
            if (speedSlider.isMinimized() || dragState.isDragging || e.button === 2) return;
            if (e.target && e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;
            const videos = videoFinder.findAll();
            if (videos.length === 0) return;
            e.stopPropagation();
            dragState.isDragging = true;
            const pos = getPosition(e);
            dragState.startX = pos.clientX;
            dragState.startY = pos.clientY;
            dragState.lastUpdateX = pos.clientX;
            dragState.currentDragDistanceX = 0;
            dragState.totalTimeChange = 0;
            dragState.lastMoveTime = Date.now();
            updateTimeDisplay(dragState.totalTimeChange);
            if (dragState.recoveryTimer) clearTimeout(dragState.recoveryTimer);
            dragState.recoveryTimer = setTimeout(cancelDrag, 5000);
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
        };

        const handleMove = (e) => {
            if (!dragState.isDragging) return;
            try {
                if ((e.touches && e.touches.length > 1) || (e.pointerType === 'touch' && e.pointerId > 1)) return cancelDrag();
                const videos = videoFinder.findAll();
                if (videos.length === 0) return cancelDrag();
                const pos = getPosition(e);
                const currentX = pos.clientX;
                const dx = Math.abs(currentX - dragState.startX);
                if (!dragState.isHorizontalDrag) {
                    const dy = Math.abs(pos.clientY - dragState.startY);
                    if (dx > 10 && dy < dx * 1.5) {
                        dragState.isHorizontalDrag = true;
                        e.preventDefault(); e.stopImmediatePropagation();
                        if(document.body) document.body.style.userSelect = 'none';
                        if(document.body) document.body.style.touchAction = 'none';
                    } else if (dy > 10) {
                        return cancelDrag();
                    }
                }
                if (dragState.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
                    dragState.totalTimeChange = Math.round(dragState.currentDragDistanceX / pixelsPerSecond);
                    updateTimeDisplay(dragState.totalTimeChange);
                    dragState.lastUpdateX = currentX;
                }
            } catch(e) {
                logManager.addOnce('drag_move_error', `드래그 이동 오류: ${e.message}\n${e.stack}`, 5000, 'error');
                cancelDrag();
            }
        };

        const handleEnd = () => {
            if (!dragState.isDragging) return;
            try {
                applyTimeChange();
                cancelDrag();
            } catch(e) {
                logManager.addOnce('drag_end_error', `드래그 종료 오류: ${e.message}\n${e.stack}`, 5000, 'error');
                cancelDrag();
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', init);
                return;
            }

            dragBarTimeDisplay = document.getElementById('vm-time-display');
            if (!dragBarTimeDisplay) {
                dragBarTimeDisplay = document.createElement('div');
                dragBarTimeDisplay.id = 'vm-time-display';
                Object.assign(dragBarTimeDisplay.style, {
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', background: 'rgba(0, 0, 0, 0.7)',
                    color: 'white', padding: '10px 20px', borderRadius: '5px',
                    fontSize: '1.5rem', zIndex: '2147483647',
                    display: 'none', pointerEvents: 'none', transition: 'opacity 0.3s ease-out',
                    opacity: '1', textAlign: 'center', whiteSpace: 'nowrap'
                });
                document.body.appendChild(dragBarTimeDisplay);
            }
            document.addEventListener('mousedown', handleStart, { passive: false, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: false, capture: true });
            document.addEventListener('mouseout', (e) => { if (e.relatedTarget === null) handleEnd(); }, true);
            document.addEventListener('touchcancel', handleEnd, { passive: false, capture: true });
        };

        const show = () => {
            if (!dragBarTimeDisplay) init();
            if (!dragBarTimeDisplay) return;
            const targetParent = document.fullscreenElement || document.body;
            if (targetParent && dragBarTimeDisplay.parentNode !== targetParent) {
                targetParent.appendChild(dragBarTimeDisplay);
            }
            dragBarTimeDisplay.style.display = 'block';
        };

        const hide = () => {
            if (dragBarTimeDisplay) dragBarTimeDisplay.style.display = 'none';
            if (dragState.isDragging) cancelDrag();
        };
        return { init, show, hide, updateTimeDisplay };
    })();

    // --- 동적 비디오 URL 표시 모듈 ---
    const dynamicVideoUI = (() => {
        let button;
        let isInitialized = false;

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', init);
                return;
            }

            button = document.createElement('button');
            button.id = 'dynamic-video-url-btn';
            button.textContent = '🎞️ URL';
            button.title = '비디오 URL 복사';
            Object.assign(button.style, {
                position: 'fixed',
                top: '10px',
                right: '10px',
                zIndex: '2147483647',
                background: 'rgba(0, 0, 0, 0.0)',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                padding: '5px 10px',
                cursor: 'pointer',
                pointerEvents: 'auto',
                display: 'none',
                transition: 'background 0.3s'
            });
            if (document.body && !document.body.contains(button)) {
                document.body.appendChild(button);
            }

            button.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();

                const urlToCopy = networkMonitor.getOriginalURLIfBlob([...VIDEO_URL_CACHE].pop());
                logManager.add(`[URL] 복사 시도: ${urlToCopy || 'URL 없음'}`, 'info');

                if (!urlToCopy || urlToCopy.startsWith('blob:')) {
                    logManager.add('⚠️ 원본 URL을 찾을 수 없습니다.', 'warn');
                    const originalText = button.textContent;
                    button.textContent = '⚠️ 원본 URL을 찾을 수 없습니다.';
                    button.style.background = 'rgba(255, 193, 7, 0.7)';
                    setTimeout(() => {
                        button.textContent = originalText;
                        button.style.background = 'rgba(0, 0, 0, 0.0)';
                    }, 1500);
                    return;
                }

                navigator.clipboard.writeText(urlToCopy).then(() => {
                    const originalText = button.textContent;
                    button.textContent = '✅ 복사 완료!';
                    button.style.background = 'rgba(40, 167, 69, 0.7)';
                    setTimeout(() => { button.textContent = originalText; button.style.background = 'rgba(0, 0, 0, 0.7)'; }, 1500);
                }).catch(() => {
                    const originalText = button.textContent;
                    button.textContent = '❌ 복사 실패!';
                    button.style.background = 'rgba(220, 53, 69, 0.7)';
                    setTimeout(() => { button.textContent = originalText; button.style.background = 'rgba(0, 0, 0, 0.7)'; }, 1500);
                });
            };
        };

        const show = (url) => {
            if (!isInitialized) init();
            if (!button) return;
        };

        const hide = () => {
            if (button) button.style.display = 'none';
        }

        return { init, show, hide };
    })();

    // --- 비디오 컨트롤 모듈 ---
    const videoControls = (() => {
        const initWhenReady = (video) => {
            if (!video || PROCESSED_NODES.has(video)) return;
            PROCESSED_NODES.add(video);
            const videoLoaded = () => {
                const videoData = VIDEO_STATE.get(video) || { originalSrc: video.src, hasControls: video.hasAttribute('controls') };
                VIDEO_STATE.set(video, videoData);
                logManager.addOnce(`video_ready_${videoData.originalSrc || 'no-src'}`, `🎬 비디오 준비됨 | src: ${videoData.originalSrc}`, 5000, 'info');
                if (video.src && networkMonitor.isVideoUrl(video.src)) {
                    networkMonitor.trackAndAttach(video.src);
                }
                if (video.parentElement && video.clientWidth > 0 && video.clientHeight > 0) {
                    const parentContainer = videoFinder.findLargestParent(video);
                }
            };
            if (video.readyState >= 1) {
                videoLoaded();
            } else {
                video.addEventListener('loadedmetadata', videoLoaded, { once: true });
                video.addEventListener('play', videoLoaded, { once: true });
                video.addEventListener('playing', videoLoaded, { once: true });
            }
        };
        const detachUI = (video) => {
            const videoData = VIDEO_STATE.get(video);
            if (videoData) {
                VIDEO_STATE.delete(video);
            }
        };
        return { initWhenReady, detachUI };
    })();

    // --- SPA 및 MutationObserver 통합 모듈 ---
    const spaMonitor = (() => {
        let lastURL = location.href;
        let debounceTimer = null;
        const onNavigate = (reason = 'URL 변경 감지') => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const url = location.href;
                if (url !== lastURL) {
                    lastURL = url;
                    logManager.addOnce(`spa_navigate`, `🔄 ${reason} | URL: ${url}`, 5000, 'info');
                    PROCESSED_DOCUMENTS = new WeakSet();
                    PROCESSED_NODES = new WeakSet();
                    PROCESSED_IFRAMES = new WeakSet();
                    LOGGED_KEYS_WITH_TIMER.clear();
                    networkMonitor.resetState();
                    OBSERVER_MAP.forEach(observer => observer.disconnect());
                    OBSERVER_MAP.clear();
                    App.initializeAll(document);
                }
            }, 200);
        };
        const overrideHistoryMethod = (methodName) => {
            const original = history[methodName];
            history[methodName] = function(...args) {
                const result = original.apply(this, args);
                onNavigate(`history.${methodName}`);
                return result;
            };
        };
        const init = () => {
            overrideHistoryMethod('pushState');
            overrideHistoryMethod('replaceState');
            window.addEventListener('popstate', () => onNavigate('popstate'));
        };
        return { init, onNavigate };
    })();

    // --- 주요 기능 통합 및 실행 ---
    const App = (() => {
        const VIDEO_WATCHER_MAP = new Map();

        const handleIframeLoad = (iframe) => {
            if (!iframe || PROCESSED_IFRAMES.has(iframe)) return;
            PROCESSED_IFRAMES.add(iframe);
            try {
                if (iframe.contentWindow) {
                    jwplayerMonitor.init(iframe.contentWindow);
                }
            } catch (e) {}

            const iframeSrc = iframe.src || 'about:blank';
            const tryInit = (retries = 5, delay = 1000) => {
                if (retries <= 0) {
                    logManager.addOnce(`iframe_access_fail_${iframe.id || 'no-id'}`, `⚠️ iframe 접근 실패 (최대 재시도 초과) | src: ${iframeSrc}`, 5000, 'warn');
                    return;
                }
                try {
                    const doc = iframe.contentDocument;
                    if (doc && doc.body) {
                        initializeAll(doc);
                    } else {
                        setTimeout(() => tryInit(retries - 1, delay), delay);
                    }
                } catch (e) {
                    setTimeout(() => tryInit(retries - 1, delay), delay);
                }
            };
            iframe.addEventListener('load', () => tryInit(), { once: true });
            tryInit(1);
        };

        const processMutations = (mutations, targetDocument) => {
            mutations.forEach(mutation => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            if (node.tagName === 'IFRAME') {
                                handleIframeLoad(node);
                            }
                            node.querySelectorAll('iframe').forEach(iframe => handleIframeLoad(iframe));
                            node.querySelectorAll('video').forEach(video => videoControls.initWhenReady(video));
                            if (node.hasAttribute && (node.hasAttribute('data-src') || node.hasAttribute('data-video'))) {
                                const src = node.getAttribute('data-src') || node.getAttribute('data-video') || node.getAttribute('data-url');
                                if (src && networkMonitor.isVideoUrl(src)) {
                                    networkMonitor.trackAndAttach(src);
                                }
                            }
                        }
                    });
                    mutation.removedNodes.forEach(node => {
                        if (node.nodeType === 1 && node.tagName === 'VIDEO' && VIDEO_STATE.has(node)) {
                            videoControls.detachUI(node);
                        }
                    });
                } else if (mutation.type === 'attributes') {
                    const targetNode = mutation.target;
                    if (targetNode.nodeType === 1) {
                        if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                            PROCESSED_IFRAMES.delete(targetNode);
                            handleIframeLoad(targetNode);
                        }
                        if (targetNode.tagName === 'VIDEO' && (mutation.attributeName === 'src' || mutation.attributeName === 'controls')) {
                            videoControls.initWhenReady(targetNode);
                        }
                    }
                }
            });
        };

        const startUnifiedObserver = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            const rootElement = targetDocument.documentElement || targetDocument.body;
            if (!rootElement) return;
            if (OBSERVER_MAP.has(targetDocument)) OBSERVER_MAP.get(targetDocument).disconnect();
            const observer = new MutationObserver(mutations => processMutations(mutations, targetDocument));
            observer.observe(rootElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'style', 'class', 'href', 'controls', 'sandbox', 'data-src', 'srcdoc', 'data-video', 'data-url']
            });
            OBSERVER_MAP.set(targetDocument, observer);
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info');
        };

        const startVideoUIWatcher = (targetDocument = document) => {
            if (!FeatureFlags.videoControls) return;
            if (VIDEO_WATCHER_MAP.has(targetDocument)) clearInterval(VIDEO_WATCHER_MAP.get(targetDocument));
            const checkVideos = () => {
                const videos = videoFinder.findAll(targetDocument);
                const isAnyVideoAvailable = videos.some(v => v.readyState >= 1 || (v.clientWidth > 0 && v.clientHeight > 0));

                if (isAnyVideoAvailable) {
                    if (speedSlider) speedSlider.show();
                    if (dragBar && !speedSlider.isMinimized()) dragBar.show();
                } else {
                    if (speedSlider) speedSlider.hide();
                    if (dragBar) dragBar.hide();
                }
                dynamicVideoUI.hide();
            };
            const interval = setInterval(throttle(checkVideos, 1000), 1500);
            VIDEO_WATCHER_MAP.set(targetDocument, interval);
            logManager.addOnce('video_watcher_started', `✅ 비디오 감시 루프 시작`, 5000, 'info');
        };

        const initializeAll = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작`, 5000, 'info');
            if (targetDocument === document) {
                networkMonitor.init();
                spaMonitor.init();
                document.addEventListener('fullscreenchange', () => {
                    speedSlider.updatePositionAndSize();
                    if (!speedSlider.isMinimized()) dragBar.show();
                    else dragBar.hide();
                });
                speedSlider.init();
                dragBar.init();
                dynamicVideoUI.init();
                jwplayerMonitor.init(window);
            }
            startUnifiedObserver(targetDocument);
            startVideoUIWatcher(targetDocument);
            videoFinder.findInDoc(targetDocument).forEach(video => videoControls.initWhenReady(video));
            targetDocument.querySelectorAll('iframe').forEach(iframe => handleIframeLoad(iframe));
        };

        return {
            initializeAll,
        };
    })();

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            logManager.init();
            App.initializeAll(document);
        });
    } else {
        logManager.init();
        App.initializeAll(document);
    }
})();
