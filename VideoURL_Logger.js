// ==UserScript==
// @name            VideoURL_Logger
// @namespace       https.com/
// @version         1.1.3
// @description     🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합 (최종 버전)
// @match           *://*/*
// @grant           none
// @run-at          document-start
// ==/UserScript==

(function () {
    'use strict';

    // 스크립트 초기화 방지
    if (window.hasOwnProperty('__VideoURL_Logger_Initialized') && window.__VideoURL_Logger_Initialized) {
        return;
    }
    Object.defineProperty(window, '__VideoURL_Logger_Initialized', { value: true, writable: false, configurable: true });

    // 전역 상태
    const PROCESSED_MAP = new Map();
    const PROCESS_TIMEOUT = 5 * 60 * 1000; // 5분
    const PROCESSED_DOCUMENTS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const LOGGED_KEYS_WITH_TIMER = new Map();
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

    function cleanOldEntries() {
        const now = Date.now();
        for (const [key, time] of PROCESSED_MAP.entries()) {
            if (now - time > PROCESS_TIMEOUT) {
                PROCESSED_MAP.delete(key);
            }
        }
    }

    function isProcessed(node) {
        cleanOldEntries();
        return PROCESSED_MAP.has(node);
    }

    function markProcessed(node) {
        PROCESSED_MAP.set(node, Date.now());
    }

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
            const lastTime = LOGGED_KEYS_WITH_TIMER.get(key);
            if (!lastTime || now - lastTime > delay) {
                LOGGED_KEYS_WITH_TIMER.set(key, now);
                addLog(message, level);
            }
        }

        function init() {
            if (!isTopFrame || document.getElementById('popupBlockerLogContainer')) return;
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
        const parseCache = new Map();
        const PROCESSED_MANIFESTS = new Set();
        const handledMimeTypes = new Set();

        const isVideoLikeRequest = (url) => {
            return /\.(m3u8|mpd|mp4|webm|mov|avi|flv|ts|mkv)(\?|#|$)/i.test(url);
        };
        const isVideoMimeType = (mime) => mime?.includes('video/') || mime?.includes('octet-stream') || mime?.includes('mpegurl') || mime?.includes('mp2t') || mime?.includes('application/dash+xml') || mime?.includes('application/vnd.apple.mpegurl');
        const isVideoUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.toLowerCase();
            return normalizedUrl.includes('mime=video') || isVideoLikeRequest(url);
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

        const trackAndAttach = (url, isManual = false) => {
            const norm = normalizeURL(url);
            if (capturedVideoURLs.has(norm)) return;
            capturedVideoURLs.add(norm);

            window.postMessage({
                source: 'VideoURL_Logger',
                type: 'VIDEO_URL_DETECTED',
                payload: { url: url }
            }, '*');

            if (blobToOriginalURLMap.size > 200) blobToOriginalURLMap.clear();
            if (mediaSourceBlobMap.size > 100) mediaSourceBlobMap.clear();
        };

        async function parseManifest(url, responseText) {
            if (parseCache.has(url)) {
                return parseCache.get(url);
            }

            const parsePromise = new Promise(async (resolve, reject) => {
                let currentUrl = url;
                try {
                    let text = responseText;
                    if (!text) {
                        let res = await originalFetch.call(window, currentUrl);
                        text = await res.text();
                    }

                    if (currentUrl.includes('.m3u8')) {
                        const base = currentUrl.split('/').slice(0, -1).join('/') + '/';
                        const lines = (text.match(/^[^#][^\r\n]+$/gm) || []).map(l => l.trim());
                        for (const line of lines) {
                            const abs = new URL(line, base).href;
                            if (abs.toLowerCase().endsWith('.m3u8')) {
                                try { await parseManifest(abs); } catch(e) {}
                            } else {
                                trackAndAttach(abs);
                            }
                        }
                        lastCapturedM3U8 = currentUrl;
                        logManager.addOnce(`parsed_m3u8_${url}`, `✅ M3U8 파싱 완료: ${url}`, 5000, 'info');
                    } else if (currentUrl.includes('.mpd')) {
                        const parser = new DOMParser();
                        const xml = parser.parseFromString(text, "application/xml");
                        const baseURLNode = xml.querySelector('BaseURL');
                        const baseURL = baseURLNode ? new URL(baseURLNode.textContent.trim(), currentUrl).href : currentUrl.replace(/\/[^/]*$/, '/');
                        const representations = xml.querySelectorAll('Representation');
                        representations.forEach(rep => {
                            const template = rep.querySelector('SegmentTemplate');
                            if (template) {
                                const media = template.getAttribute('media');
                                if (media) trackAndAttach(new URL(media.replace(/\$Number.*$/, ''), baseURL).href);
                            }
                        });
                        lastCapturedMPD = currentUrl;
                        logManager.addOnce(`parsed_mpd_${url}`, `✅ MPD 파싱 완료: ${url}`, 5000, 'info');
                    }
                    PROCESSED_MANIFESTS.add(currentUrl);
                    resolve();
                } catch (err) {
                    logManager.addOnce(`parse_fail_${url}`, `⚠️ 매니페스트 파싱 실패: ${url} - ${err.message}`, 5000, 'error');
                    parseCache.delete(url);
                    reject(err);
                }
            });

            parseCache.set(url, parsePromise);
            return parsePromise;
        }

        const hookPrototypes = () => {
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this.__pbivs_originalUrl = url;
                return origOpen.apply(this, [method, url, ...args]);
            };

            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(...sendArgs) {
                this.addEventListener('load', () => {
                    const contentType = this.getResponseHeader('Content-Type');
                    const url = this.__pbivs_originalUrl;
                    if (this.status >= 200 && this.status < 300) {
                        if (isVideoUrl(url) || isVideoMimeType(contentType)) {
                            logManager.addOnce(`network_detected_xhr_${url.substring(0,50)}`, `🎥 XHR 영상 URL 감지됨: ${url}`, 5000, 'info');
                            trackAndAttach(url);
                            if (url.includes('.m3u8') || url.includes('.mpd')) {
                                try { parseManifest(url, this.responseText); } catch(e) {}
                            }
                        }
                    }
                });
                return origSend.apply(this, sendArgs);
            };

            if (originalFetch) {
                window.fetch = async function(input, init) {
                    const url = typeof input === 'string' ? input : input.url;

                    const res = await originalFetch.call(this, input, init);
                    const resClone = res.clone();

                    const contentType = res.headers.get("content-type");
                    if (res.status >= 200 && res.status < 300) {
                        if (isVideoUrl(url) || isVideoMimeType(contentType)) {
                            logManager.addOnce(`network_detected_fetch_${url.substring(0,50)}`, `🎥 fetch 영상 URL 감지됨: ${url}`, 5000, 'info');
                            trackAndAttach(url);
                            if (url.includes('.m3u8') || url.includes('.mpd')) {
                                try { resClone.text().then(text => parseManifest(url, text)); } catch(e) {}
                            }
                        }
                    }
                    return res;
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

            const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            if (origAddSourceBuffer) {
                MediaSource.prototype.addSourceBuffer = function(mime) {
                    if (isVideoMimeType(mime) && !handledMimeTypes.has(mime)) {
                        logManager.addOnce(`addSourceBuffer_detected_${mime}`, `🛰️ MediaSource에 버퍼 추가됨 | MIME: ${mime}`, 5000, 'info');
                        handledMimeTypes.add(mime);
                    }
                    return origAddSourceBuffer.apply(this, arguments);
                };
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
                            logManager.addOnce(`createObjectURL_mse_${url}`, `[URL] MediaSource에 Blob URL 할당됨 (원본: ${originalUrl})`, 5000, 'info');
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

        const resetState = () => {
            capturedVideoURLs.clear();
            blobToOriginalURLMap.clear();
            mediaSourceBlobMap.clear();
            lastCapturedM3U8 = null;
            lastCapturedMPD = null;
            parseCache.clear();
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
            reportVideoURL: trackAndAttach,
            resetState
        };
    })();

    // --- JWPlayer & Video.js 모니터링 모듈 ---
    const playerMonitor = (() => {
        let isHooked = false;

        const checkPlayer = (player) => {
            try {
                const playlist = player.getPlaylist?.();
                if (!playlist) return;
                playlist.forEach(item => {
                    if (item?.file) {
                        if (networkMonitor.isVideoUrl(item.file)) {
                            logManager.addOnce(`jwplayer_detected_${item.file.substring(0,50)}`, `🎥 JWPlayer URL 감지됨: ${item.file}`, 5000, 'info');
                            networkMonitor.reportVideoURL(item.file);
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
                        return result;
                    };
                }
                return player;
            };
            Object.assign(context.jwplayer, origJW);
            logManager.addOnce('jwplayer_hooked', `✅ JWPlayer 후킹 성공`, 5000, 'info');
            isHooked = true;
        };

        const hookVideoJS = (context) => {
            if (context.videojs) {
                const origVideojs = context.videojs;
                context.videojs = function(...args) {
                    const player = origVideojs.apply(this, args);
                    player.ready(() => {
                        const url = player.currentSrc();
                        if (url && networkMonitor.isVideoUrl(url)) {
                            logManager.addOnce(`videojs_detected_${url.substring(0,50)}`, `🎥 Video.js URL 감지됨: ${url}`, 5000, 'info');
                            networkMonitor.reportVideoURL(url);
                        }
                    });
                    return player;
                };
                logManager.addOnce('videojs_hooked', `✅ Video.js 후킹 성공`, 5000, 'info');
            }
        };

        const init = (context) => {
            hookJWPlayer(context);
            hookVideoJS(context);
        };

        return { init };
    })();

    // --- 비디오 탐색 모듈 (UI 부착용) ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            if (!doc || !doc.body) return videos;
            doc.querySelectorAll('video').forEach(v => videos.push(v));
            doc.querySelectorAll('div.jw-player, div[id*="player"], div.video-js, div[class*="video-container"]').forEach(container => {
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
                    if (isRelativeOrAbsolute) return current;
                    largestArea = area;
                    largestElement = current;
                }
                current = current.parentElement;
            }
            return largestElement;
        }
    };

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
                        setTimeout(() => { button.textContent = originalText; button.style.background = 'rgba(0, 0, 0, 0.7)'; }, 1500);
                    }).catch(() => {
                        const originalText = button.textContent;
                        button.textContent = '❌ 복사 실패!';
                        button.style.background = 'rgba(220, 53, 69, 0.7)';
                        setTimeout(() => { button.textContent = originalText; button.style.background = 'rgba(0, 0, 0, 0.7)'; }, 1500);
                    });
                };
                if (getComputedStyle(targetElement).position === 'static') {
                    targetElement.style.position = 'relative';
                }
                targetElement.appendChild(button);
                logManager.addOnce(`dynamic_ui_${url}`, `✅ 동적 비디오 URL 버튼 생성됨: ${url}`, 5000, 'info');
                observeUI(targetElement, url);
            }
        }
    };

    // --- 비디오 컨트롤 모듈 ---
    const videoControls = (() => {
        const initWhenReady = (video) => {
            if (isProcessed(video)) return;
            markProcessed(video);

            const videoLoaded = () => {
                logManager.addOnce(`video_ready_${video.src || 'no-src'}`, `🎬 비디오 준비됨 | src: ${video.src}`, 5000, 'info');
                if (video.src && networkMonitor.isVideoUrl(video.src)) {
                    networkMonitor.trackAndAttach(video.src);
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
        return { initWhenReady };
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
                    PROCESSED_DOCUMENTS.clear();
                    PROCESSED_MAP.clear();
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

    // --- UI 유지 관리 옵저버 ---
    function observeUI(targetElement, url) {
        if (!targetElement) return;
        const observer = new MutationObserver(mutations => {
            let btn = targetElement.querySelector('.dynamic-video-url-btn');
            if (!btn && targetElement.isConnected) {
                dynamicVideoUI.attach(targetElement, url);
                logManager.addOnce(`ui_recreated_${url}`, `🔄 동적 버튼 재생성 | URL: ${url}`, 5000, 'warn');
            }
        });
        observer.observe(targetElement, { childList: true, subtree: false });
    }

    // --- 주요 기능 통합 및 실행 ---
    const App = (() => {
        let isInitialized = false;

        const handleIframeLoad = (iframe) => {
            if (isProcessed(iframe)) return;
            markProcessed(iframe);

            try {
                if (iframe.contentWindow) {
                    playerMonitor.init(iframe.contentWindow);
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
                        }
                    });
                } else if (mutation.type === 'attributes') {
                    const targetNode = mutation.target;
                    if (targetNode.nodeType === 1) {
                        if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                            PROCESSED_MAP.delete(targetNode);
                            handleIframeLoad(targetNode);
                        }
                        if (targetNode.tagName === 'VIDEO' && mutation.attributeName === 'src') {
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
                attributeFilter: ['src', 'style', 'class', 'href', 'controls', 'sandbox', 'data-src', 'srcdoc']
            });
            OBSERVER_MAP.set(targetDocument, observer);
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info');
        };

        const initializeAll = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작`, 5000, 'info');
            if (targetDocument === document) {
                if (isInitialized) return;
                isInitialized = true;
                logManager.init();
                logManager.addOnce('network_monitor_status', `✅ [networkMonitor] 활성`, 5000, 'debug');
                networkMonitor.init();
                logManager.addOnce('spa_monitor_status', `✅ [spaMonitor] 활성`, 5000, 'debug');
                spaMonitor.init();
                logManager.addOnce('player_monitor_status', `✅ [playerMonitor] 활성`, 5000, 'debug');
                playerMonitor.init(window);
            }
            startUnifiedObserver(targetDocument);
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
            App.initializeAll(document);
        });
    } else {
        App.initializeAll(document);
    }
})();
