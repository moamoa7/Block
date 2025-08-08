// ==UserScript==
// @name 			VideoSpeed_Lite_Final
// @namespace 		https.com/
// @version 		13.0.0
// @description 	🎞️ 비디오 속도 제어 UI + 🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합 (최종 최소화 버전)
// @match 			*://*/*
// @grant 			none
// @run-at 			document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 전역 설정 및 기능 플래그 ---
    const FeatureFlags = {
        videoControls: true,
        logUI: true,
    };
    const DRAG_CONFIG = {
        PIXELS_PER_SECOND: 2
    };
    const POLLING_TIMEOUT_MS = 2 * 60 * 1000; // 2분 후 polling 중지

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
        }, 1);
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
            const ICONS = { info: 'ℹ️', warn: '⚠️', 'error': '🔴', 'allow': '✅', 'debug': '🔧' };
            const fullMsg = `[${new Date().toLocaleTimeString()}] ${ICONS[level] || ''} ${msg}`;

            console[level] ? console[level](fullMsg) : console.log(fullMsg);

            if (!FeatureFlags.logUI) return;

            if (!isTopFrame) {
                try {
                    window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: fullMsg, level: level, key: msg }, '*');
                    return;
                } catch (e) {
                    // cross-origin iframe
                }
            }

            addLogToBox(fullMsg);
        }

        function addLogOnce(key, message, delay = 5000, level = 'info') {
            const currentTime = Date.now();
            const lastLogTime = LOGGED_KEYS_WITH_TIMER.get(key);
            if (!lastLogTime || currentTime - lastLogTime > delay) {
                LOGGED_KEYS_WITH_TIMER.set(key, currentTime);
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

        const PROCESSED_MANIFESTS = new Set();
        const TRACKED_VIDEO_EXTENSIONS = ['.m3u8', '.mpd', '.ts', '.mp4', '.webm', '.m4s', '.mov', '.flv', '.avi'];

        const isVideoLikeRequest = (url, mimeType) => {
            if (!url || typeof url !== 'string') return false;
            try {
                const lowerUrl = url.toLowerCase().split('?')[0];
                const hasVideoExtension = TRACKED_VIDEO_EXTENSIONS.some(ext => lowerUrl.endsWith(ext));
                const hasVideoMimeType = mimeType?.startsWith('video/') || mimeType?.includes('application/vnd.apple.mpegurl') || mimeType?.includes('application/dash+xml');
                if (lowerUrl.endsWith('.ts') && mimeType && !mimeType.includes('video/mp2t')) {
                    return false;
                }
                return hasVideoExtension || hasVideoMimeType;
            } catch (e) {
                return false;
            }
        };

        const isVideoUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.toLowerCase();
            return normalizedUrl.includes('mime=video') || isVideoLikeRequest(url, '');
        };

        const isVideoMimeType = (mime) => mime?.includes('video/') || mime?.includes('octet-stream') || mime?.includes('mpegurl') || mime?.includes('mp2t') || mime?.includes('application/dash+xml');

        async function parseMPD(mpdURL) {
            if (PROCESSED_MANIFESTS.has(mpdURL)) return;
            PROCESSED_MANIFESTS.add(mpdURL);
            try {
                const response = await fetch(mpdURL);
                const text = await response.text();
                const parser = new DOMParser();
                const xml = parser.parseFromString(text, "application/xml");
                const baseURLNode = xml.querySelector('BaseURL');
                const baseURL = baseURLNode ? new URL(baseURLNode.textContent.trim(), mpdURL).href : mpdURL.replace(/\/[^/]*$/, '/');
                const representations = xml.querySelectorAll('Representation');
                representations.forEach(rep => {
                    const template = rep.querySelector('SegmentTemplate');
                    if (template) {
                        const media = template.getAttribute('media');
                        const init = template.getAttribute('initialization');
                        const startNumber = parseInt(template.getAttribute('startNumber') || "1");
                        const count = 3;
                        if (init) {
                            trackAndAttach(new URL(init, baseURL).href, 'dash_init');
                        }
                        for (let i = startNumber; i < startNumber + count; i++) {
                            const seg = media.replace('$Number$', i);
                            trackAndAttach(new URL(seg, baseURL).href, 'dash_segment');
                        }
                    }
                });
                logManager.addOnce(`parsed_mpd_${mpdURL}`, `✅ MPD 파싱 완료: ${mpdURL}`, 5000, 'info');
            } catch (err) {
                logManager.addOnce(`parse_mpd_fail_${mpdURL}`, `⚠️ MPD 파싱 실패: ${mpdURL} - ${err.message}`, 5000, 'error');
            }
        }

        async function parseM3U8(m3u8URL, depth = 0) {
            if (depth > 2 || PROCESSED_MANIFESTS.has(m3u8URL)) return;
            PROCESSED_MANIFESTS.add(m3u8URL);
            try {
                const res = await fetch(m3u8URL);
                const text = await res.text();
                const base = m3u8URL.split('/').slice(0, -1).join('/') + '/';
                if (text.includes('#EXT-X-STREAM-INF')) {
                    const subURLs = [...text.matchAll(/^[^#].+\.m3u8$/gm)].map(m => new URL(m[0].trim(), base).href);
                    for (const sub of subURLs) {
                        await parseM3U8(sub, depth + 1);
                    }
                    return;
                }
                const segments = [...text.matchAll(/^[^#][^\r\n]*\.ts$/gm)].map(m => new URL(m[0].trim(), base).href);
                segments.forEach(url => trackAndAttach(url, 'hls_segment'));
                logManager.addOnce(`parsed_m3u8_${m3u8URL}`, `✅ M3U8 파싱 완료 (세그먼트 ${segments.length}개)`, 5000, 'info');
            } catch (err) {
                logManager.addOnce(`parse_m3u8_fail_${m3u8URL}`, `⚠️ M3U8 파싱 실패: ${m3u8URL} - ${err.message}`, 5000, 'error');
            }
        }

        const normalizeURL = (url) => {
            try {
                const urlObj = new URL(url, location.href);
                urlObj.hash = '';
                urlObj.searchParams.forEach((_, key) => {
                    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('session') || key.toLowerCase().includes('time')) {
                        urlObj.searchParams.delete(key);
                    }
                });
                return urlObj.toString();
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

        const reportVideoURL = (url, context = '') => {
            if (!capturedVideoURLs.has(url)) {
                capturedVideoURLs.add(url);
                dynamicVideoUI.attach(document, url);
                logManager.addOnce(`report_url_${url.substring(0, 50)}`, `🎥 URL 감지됨 (${context}) | ${url}`, 5000, 'info');
            }
        }

        const trackAndAttach = (url, sourceType = 'network') => {
            const originalURL = url;
            const normalizedUrl = normalizeURL(originalURL);
            let videoType = '';
            if (normalizedUrl.toLowerCase().endsWith('.m3u8')) {
                lastCapturedM3U8 = normalizedUrl;
                parseM3U8(normalizedUrl);
                videoType = '[HLS]';
            } else if (normalizedUrl.toLowerCase().endsWith('.mpd')) {
                lastCapturedMPD = normalizedUrl;
                parseMPD(normalizedUrl);
                videoType = '[DASH]';
            } else if (normalizedUrl.startsWith('blob:')) {
                videoType = '[BLOB]';
            } else {
                videoType = '[기타]';
            }
            if (capturedVideoURLs.has(normalizedUrl)) return;
            capturedVideoURLs.add(normalizedUrl);
            logManager.addOnce(`network_detected_${normalizedUrl.substring(0, 50)}`, `🎥 ${videoType} 네트워크 영상 URL 감지됨 (${sourceType}) | 원본: ${originalURL}`, 5000, 'info');
            requestIdleCallback(() => {
                const videos = videoFinder.findAll();
                if (videos.length > 0) {
                    videos.forEach(video => {
                        const target = videoFinder.findLargestParent(video);
                        if (target) dynamicVideoUI.attach(target, originalURL);
                    });
                }
            });
        };

        const hookPrototypes = () => {
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this.__pbivs_originalUrl = url;
                if (typeof url === 'string' && url.includes('.m3u8')) {
                    parseM3U8(url);
                }
                return originalOpen.apply(this, [method, url, ...args]);
            };

            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(...sendArgs) {
                this.addEventListener('load', () => {
                    const contentType = this.getResponseHeader('Content-Type');
                    const url = this.__pbivs_originalUrl;
                    if (isVideoLikeRequest(url, contentType) || isVideoMimeType(contentType)) {
                        trackAndAttach(url, 'xhr_load');
                    }
                });
                return originalSend.apply(this, sendArgs);
            };

            if (originalFetch) {
                window.fetch = async function(...args) {
                    const url = args[0] && typeof args[0] === 'object' ? args[0].url : args[0];
                    if (typeof url === 'string' && url.includes('.m3u8')) {
                        parseM3U8(url);
                    }
                    let res;
                    try {
                        res = await originalFetch.apply(this, args);
                        const contentType = res.headers.get("content-type");
                        try {
                            const clone = res.clone();
                            if (isVideoLikeRequest(url, contentType) || isVideoMimeType(contentType)) {
                                trackAndAttach(url, 'fetch');
                                clone.blob().then(blob => {
                                    if (isVideoMimeType(blob.type)) {
                                        const blobURL = URL.createObjectURL(blob);
                                        blobToOriginalURLMap.set(blobURL, url);
                                    }
                                }).catch(e => {
                                    logManager.addOnce('blob_capture_error_safe', `Blob URL 매핑 중 오류 발생 (무시): ${e.message}`, 5000, 'warn');
                                });
                            }
                        } catch (e) {
                            logManager.addOnce('fetch_clone_fail', `⚠️ Fetch 응답 clone 실패: ${e.message}`, 5000, 'warn');
                        }
                    } catch (e) {
                        logManager.addOnce('fetch_hook_error', `⚠️ Fetch 후킹 중 오류 발생: ${e.message}\n${e.stack}`, 5000, 'error');
                        throw e;
                    }
                    return res;
                };
            }

            try {
                const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
                if (originalAddSourceBuffer) {
                    MediaSource.prototype.addSourceBuffer = function (mimeType) {
                        const lower = mimeType.toLowerCase();
                        if (lower.includes('video/mp4') || lower.includes('video/webm') || lower.includes('audio/mp4') || lower.includes('mpegurl') || lower.includes('dash')) {
                            trackAndAttach(`[MSE] ${mimeType}`, 'mse_stream');
                        }
                        return originalAddSourceBuffer.call(this, mimeType);
                    };
                }
            } catch (e) {
                logManager.addOnce('mse_hook_fail', `⚠️ MediaSource 후킹 실패: ${e.message}`, 5000, 'warn');
            }

            const origSrcObjDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
            if (origSrcObjDescriptor?.set) {
                Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
                    set(obj) {
                        logManager.addOnce('srcObject_set', `🛰️ video.srcObject 변경 감지 (스트림) | 복사 기능 제한될 수 있음`, 5000, 'warn');
                        return origSrcObjDescriptor.set.call(this, obj);
                    },
                    get() { return origSrcObjDescriptor.get.call(this); }
                });
            }

            const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
            if (origSrcDescriptor?.set) {
                Object.defineProperty(HTMLMediaElement.prototype, "src", {
                    set(value) {
                        if (value && isVideoUrl(value)) trackAndAttach(value, 'video_src_set');
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
                        mediaSourceBlobMap.set(url, lastCapturedM3U8 || lastCapturedMPD || 'MediaSource');
                        logManager.addOnce(`createObjectURL_mse_${url}`, `[URL] MediaSource에 Blob URL 할당됨: ${url}`, 5000, 'info');
                    } else if (obj instanceof Blob && isVideoMimeType(obj.type)) {
                        blobToOriginalURLMap.set(url, url);
                        logManager.addOnce(`createObjectURL_blob_${url}`, `[URL] 비디오 Blob URL 생성됨: ${url}`, 5000, 'info');
                        trackAndAttach(url, 'createObjectURL');
                    }
                    return url;
                };
            }
        };

        const resetState = () => {
            capturedVideoURLs.clear();
            blobToOriginalURLMap.clear();
            mediaSourceBlobMap.clear();
            lastCapturedM3U8 = null;
            lastCapturedMPD = null;
            PROCESSED_MANIFESTS.clear();
        };

        const init = () => {
            hookPrototypes();
        };

        return {
            init,
            getOriginalURLIfBlob,
            isVideoUrl,
            trackAndAttach,
            reportVideoURL,
            capturedVideoURLs,
            setCapturedVideoURLs: (urls) => { capturedVideoURLs = urls; },
            resetState
        };
    })();

    // --- JWPlayer 모니터링 모듈 추가 ---
    const jwplayerMonitor = (() => {
        let isJWHooked = false;
        let lastItemURL = null;
        let pollingInterval = null;
        let pollingTimeout = null;

        function hookJWPlayerSetup(context = window) {
            if (isJWHooked || typeof context.jwplayer !== 'function') return;
            isJWHooked = true;
            const original = context.jwplayer;
            context.jwplayer = function (...args) {
                const player = original.apply(this, args);
                if (player && typeof player.setup === 'function') {
                    const originalSetup = player.setup;
                    player.setup = function (config) {
                        try {
                            const file = config?.file || config?.playlist?.[0]?.file;
                            if (file) {
                                networkMonitor.reportVideoURL(file, 'jwplayer_setup');
                            }
                        } catch (err) {
                            logManager.addOnce('jw_setup_hook_err', `⚠️ jwplayer.setup 후킹 오류: ${err.message}`, 5000, 'error');
                        }
                        return originalSetup.call(this, config);
                    };
                }
                return player;
            };
        }

        function startPolling(context = window) {
            if (pollingInterval) clearInterval(pollingInterval);
            if (pollingTimeout) clearTimeout(pollingTimeout);
            let pollingActive = true;
            pollingTimeout = setTimeout(() => {
                pollingActive = false;
                if (pollingInterval) clearInterval(pollingInterval);
                logManager.addOnce('jw_polling_timeout', '📴 JWPlayer 폴링 중지됨 (타임아웃)', 5000, 'info');
            }, POLLING_TIMEOUT_MS);
            pollingInterval = setInterval(() => {
                if (!pollingActive) return;
                try {
                    const player = context.jwplayer?.();
                    if (player?.getItem) {
                        const item = player.getItem();
                        const file = item?.file;
                        if (file && file !== lastItemURL) {
                            lastItemURL = file;
                            networkMonitor.reportVideoURL(file, 'jwplayer_polling');
                        }
                    }
                } catch (e) {
                    // cross-origin iframe or player not ready
                }
            }, 2000);
        }

        const resetState = () => {
            lastItemURL = null;
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
            }
            if (pollingTimeout) {
                clearTimeout(pollingTimeout);
                pollingTimeout = null;
            }
            isJWHooked = false;
        };

        return {
            init(context = window) {
                hookJWPlayerSetup(context);
                startPolling(context);
            },
            resetState
        };
    })();

    // --- 비디오 탐색 모듈 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            if (!doc || !doc.body || typeof doc.createTreeWalker !== 'function') {
                if (doc && doc.readyState !== 'complete') {
                    return [];
                }
                logManager.addOnce('tree_walker_error', '⚠️ TreeWalker 오류: doc 또는 doc.body가 유효하지 않음', 5000, 'warn');
                return videos;
            }
            try {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
                    acceptNode: node => node.tagName === 'VIDEO' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
                });
                let currentNode;
                while ((currentNode = walker.nextNode())) {
                    videos.push(currentNode);
                }
            } catch (e) {
                logManager.addOnce('tree_walker_error', `⚠️ TreeWalker 오류: ${e.message}\n${e.stack}`, 5000, 'warn');
            }
            doc.querySelectorAll('div.jw-player, div[id*="player"], div.video-js, div[class*="video-container"], div.vjs-tech').forEach(container => {
                if (!container.querySelector('video') && container.clientWidth > 0 && container.clientHeight > 0) {
                    videos.push(container);
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
                    if (isRelativeOrAbsolute) {
                        return current;
                    }
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
                #vm-speed-slider-container {
                    position: fixed; top: 50%; right: 0; transform: translateY(-50%);
                    background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px;
                    z-index: 2147483647 !important; display: none; flex-direction: column;
                    align-items: center; width: 50px; height: auto; font-family: sans-serif;
                    pointer-events: auto; opacity: 0.3; transition: all 0.3s ease; user-select: none;
                    box-shadow: 0 0 8px rgba(0,0,0,0.0); will-change: transform, opacity, width;
                }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-reset-btn { background: #444; border: none; border-radius: 4px; color: white;
                    font-size: 14px; padding: 4px 6px; cursor: pointer; margin-bottom: 8px;
                    width: 40px; height: 30px; font-weight: bold; }
                #vm-speed-reset-btn:hover { background: #666; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 30px;
                    height: 150px; margin: 0 0 10px 0; cursor: pointer; background: #555;
                    border-radius: 5px; }
                #vm-speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px;
                    height: 20px; background: #f44336; border-radius: 50%; cursor: pointer;
                    border: 1px solid #ddd; }
                #vm-speed-value { color: red; font-size: 18px; font-weight: bold;
                    text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                #vm-toggle-btn { background: #444; border: none; border-radius: 4px;
                    color: white; font-size: 12px; padding: 4px 6px; cursor: pointer;
                    font-weight: bold; width: 40px; height: 30px; margin-top: 8px;
                    transition: transform 0.2s ease-in-out; }
            `;
            if (document.head) {
                document.head.appendChild(style);
            } else if (document.body) {
                document.body.appendChild(style);
            }
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
            if (!document.body) return;
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
                speedSliderContainer.append(resetBtn, slider, valueDisplay, toggleBtn);
                document.body.appendChild(speedSliderContainer);
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
            document.body.appendChild(speedSliderContainer);
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
                if (dragState.throttleTimer) {
                    clearTimeout(dragState.throttleTimer);
                    dragState.throttleTimer = null;
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
            if (speedSlider.isMinimized() || dragState.isDragging || e.button === 2) {
                return;
            }
            if (e.target && e.target.closest('#vm-speed-slider-container, #vm-time-display')) {
                return;
            }
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
                if ((e.touches && e.touches.length > 1) || (e.pointerType === 'touch' && e.pointerId > 1)) {
                    return cancelDrag();
                }
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
                    const now = Date.now();
                    if (now - dragState.lastDragTimestamp > 150) {
                        dragState.lastDragTimestamp = now;
                    }
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
            if (!document.body) return;
            dragBarTimeDisplay = document.getElementById('vm-time-display');
            if (!dragBarTimeDisplay) {
                dragBarTimeDisplay = document.createElement('div');
                dragBarTimeDisplay.id = 'vm-time-display';
                Object.assign(dragBarTimeDisplay.style, {
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    background: 'rgba(0, 0, 0, 0.7)', color: 'white',
                    padding: '10px 20px', borderRadius: '5px',
                    fontSize: '1.5rem', zIndex: '2147483647',
                    display: 'none', pointerEvents: 'none',
                    transition: 'opacity 0.3s ease-out', opacity: '1',
                    textAlign: 'center', whiteSpace: 'nowrap'
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
            if (dragBarTimeDisplay) {
                dragBarTimeDisplay.style.display = 'none';
            }
            if (dragState.isDragging) {
                cancelDrag();
            }
        };

        return { init, show, hide, updateTimeDisplay };
    })();

    // --- 동적 비디오 URL 표시 모듈 ---
    const dynamicVideoUI = {
        attach: (targetElement, url) => {
            if (!targetElement) return;
            let existingButton = targetElement.querySelector('.dynamic-video-url-btn');
            if (!existingButton) {
                const button = document.createElement('button');
                button.className = 'dynamic-video-url-btn';
                button.textContent = '🎞️';
                button.title = '비디오 URL 복사';
                Object.assign(button.style, {
                    position: 'absolute', top: '5px', right: '5px', zIndex: '2147483647',
                    background: 'rgba(0, 0, 0, 0.7)', color: 'white', border: 'none',
                    borderRadius: '5px', padding: '5px 10px', cursor: 'pointer',
                    pointerEvents: 'auto', display: 'block', transition: 'background 0.3s'
                });
                button.onclick = (e) => {
                    e.stopPropagation(); e.preventDefault();
                    const urlToCopy = networkMonitor.getOriginalURLIfBlob(url);
                    if (!urlToCopy || urlToCopy.startsWith('blob:') || urlToCopy.startsWith('[MSE]')) {
                        logManager.addOnce('no_valid_url_to_copy', '⚠️ 복사할 유효한 URL을 찾을 수 없음', 5000, 'warn');
                        return;
                    }
                    navigator.clipboard.writeText(urlToCopy).then(() => {
                        const originalText = button.textContent;
                        button.textContent = '✅ 복사 완료!';
                        button.style.background = 'rgba(40, 167, 69, 0.7)';
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.style.background = 'rgba(0, 0, 0, 0.7)';
                        }, 1500);
                    }).catch(() => {
                        const originalText = button.textContent;
                        button.textContent = '❌ 복사 실패!';
                        button.style.background = 'rgba(220, 53, 69, 0.7)';
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.style.background = 'rgba(0, 0, 0, 0.7)';
                        }, 1500);
                    });
                };
                if (getComputedStyle(targetElement).position === 'static') {
                    targetElement.style.position = 'relative';
                }
                targetElement.appendChild(button);
                logManager.addOnce(`dynamic_ui_${url}`, `✅ 동적 비디오 URL 버튼 생성됨: ${url}`, 5000, 'info');
            }
        }
    };

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
                    networkMonitor.trackAndAttach(video.src, 'video_src_initial');
                }
                if (video.parentElement && video.clientWidth > 0 && video.clientHeight > 0) {
                    const parentContainer = videoFinder.findLargestParent(video);
                    if (parentContainer) dynamicVideoUI.attach(parentContainer, video.src);
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
                    logManager.addOnce(`spa_navigate_${Date.now()}`, `🔄 ${reason} | URL: ${url}`, 5000, 'info');
                    PROCESSED_DOCUMENTS = new WeakSet();
                    PROCESSED_NODES = new WeakSet();
                    PROCESSED_IFRAMES = new WeakSet();
                    LOGGED_KEYS_WITH_TIMER.clear();
                    networkMonitor.resetState();
                    jwplayerMonitor.resetState();
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
        const OBSERVER_MAP = new Map();
        let isInitialized = false;

        const handleIframeLoad = (iframe) => {
            if (!iframe || PROCESSED_IFRAMES.has(iframe)) {
                return;
            }
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
                            node.querySelectorAll('iframe').forEach(iframe => {
                                handleIframeLoad(iframe);
                            });
                            node.querySelectorAll('video').forEach(video => videoControls.initWhenReady(video));
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
            if (OBSERVER_MAP.has(targetDocument)) {
                const existingObserver = OBSERVER_MAP.get(targetDocument);
                if (existingObserver) existingObserver.disconnect();
            }
            const observer = new MutationObserver(mutations => processMutations(mutations, targetDocument));
            observer.observe(rootElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'style', 'class', 'href', 'controls', 'sandbox', 'data-src', 'srcdoc']
            });
            OBSERVER_MAP.set(targetDocument, observer);
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info');
        };

        const startVideoUIWatcher = (targetDocument = document) => {
            if (!FeatureFlags.videoControls) return;
            if (VIDEO_WATCHER_MAP.has(targetDocument)) {
                clearInterval(VIDEO_WATCHER_MAP.get(targetDocument));
            }
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
            };
            const interval = setInterval(throttle(checkVideos, 1000), 1500);
            VIDEO_WATCHER_MAP.set(targetDocument, interval);
            logManager.addOnce('video_watcher_started', `✅ 비디오 감시 루프 시작 | ${targetDocument === document ? '메인' : 'iframe'}`, 5000, 'info');
        };

        const initializeAll = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작 | 문서: ${targetDocument === document ? '메인' : targetDocument.URL}`, 5000, 'info');
            if (targetDocument === document) {
                if(isInitialized) return;
                isInitialized = true;
                logManager.addOnce('network_monitor_status', `✅ [networkMonitor] 활성 (fetch/XHR 후킹)`, 5000, 'debug');
                networkMonitor.init();
                logManager.addOnce('spa_monitor_status', `✅ [spaMonitor] 활성 (History API 후킹)`, 5000, 'debug');
                spaMonitor.init();
                logManager.init();
                document.addEventListener('fullscreenchange', () => {
                    speedSlider.updatePositionAndSize();
                    if (!speedSlider.isMinimized()) {
                        dragBar.show();
                    } else {
                        dragBar.hide();
                    }
                });
                speedSlider.init();
                dragBar.init();
                logManager.addOnce('jwplayer_monitor_status', `✅ [jwplayerMonitor] 활성`, 5000, 'debug');
                jwplayerMonitor.init(window);
            }
            startUnifiedObserver(targetDocument);
            startVideoUIWatcher(targetDocument);
            videoFinder.findInDoc(targetDocument).forEach(video => {
                videoControls.initWhenReady(video);
            });
            targetDocument.querySelectorAll('iframe').forEach(iframe => {
                handleIframeLoad(iframe);
            });
        };

        return {
            initializeAll,
        };

    })();

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            App.initializeAll(document);
        });
    } else {
        App.initializeAll(document);
    }
})();
