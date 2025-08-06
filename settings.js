// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace      https.com/
// @version        6.3.0 (리팩토링 및 기능 개선)
// @description    🚫 팝업/iframe 차단 + 🎞️ 비디오 속도 제어 UI + 🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합
// @match          *://*/*
// @grant          none
// @run-at         document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 전역 설정 및 기능 플래그 ---
    const FeatureFlags = {
        popupBlocker: true,
        iframeBlocker: true,
        layerTrap: true,
        videoControls: true,
        logUI: true
    };
    const USER_SETTINGS = {
        enableVideoDebugBorder: false,
        defaultIframeSandbox: 'allow-scripts allow-same-origin allow-popups'
    };
    const TrapConfig = {
        allowList: [],
        blockList: [],
        layerTrapPreview: false
    };
    const DRAG_CONFIG = {
        PIXELS_PER_SECOND: 2
    };

    // --- 기능별 상수 및 예외 처리 ---
    const WHITELIST = [
        'challenges.cloudflare.com', 'recaptcha', '/e/',
    ];
    const EXCEPTION_LIST = {
        'supjav.com': ['iframeBlocker'],
    };
    const FORCE_BLOCK_POPUP_PATTERNS = [];
    const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
        'google.com', 'ok.ru', 'twitch.tv', 'accounts.google.com', 'missav.ws'
    ];
    const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
        '{"event":"timeupdate"',
    ];
    const IFRAME_FORCE_BLOCK_PATTERNS = [
        '/ads/', 'adsbygoogle', 'doubleclick', 'adpnut.com',
        'iframead', 'loader.fmkorea.com/_loader/', '/smartpop/',
        '8dkq9tp.xyz', 's.amazon-adsystem.com',
    ];
    const IGNORED_IFRAME_PATTERNS = [
        /e\.mail\.ru/, /youtube\.com\/embed/, /player\.vimeo\.com/,
        /player\.twitch\.tv/, /ok\.ru\/videoembed/, /w\.naver\.com\/v2/,
        /serviceapi\.nmv\.naver\.com/, /pstatic\.net\/movie\/svc\/popup/,
        /html5player\.ru/, /video_player\.js/, /googlesyndication\.com/,
        /adservice\.google\.com/,
    ].map(p => (typeof p === 'string' ? new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : p));

    // --- 스크립트 초기 실행 전 예외 처리 ---
    const hostname = location.hostname;
    const IS_ENTIRE_SCRIPT_ALLOWED = WHITELIST.some(domain =>
        hostname.includes(domain) || window.location.href.includes(domain)
    );
    if (IS_ENTIRE_SCRIPT_ALLOWED) {
        return;
    }
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
    const isTopFrame = window.self === window.top;

    // --- 유틸리티 함수 ---
    const isFeatureAllowed = (featureName) => {
        const exceptions = EXCEPTION_LIST[hostname] || [];
        return !exceptions.includes(featureName);
    };

    const getFakeWindow = () => ({
        focus: () => {}, opener: null, closed: false, blur: () => {}, close: () => {},
        location: { href: "", assign: () => {}, replace: () => {}, reload: () => {}, toString: () => "", valueOf: () => "" },
        alert: () => {}, confirm: () => {}, prompt: () => {}, postMessage: () => {},
        document: { write: () => {}, writeln: () => {} },
    });

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
        let logFilter = ['info', 'warn', 'error', 'block', 'allow'];

        function setFilter(filters) {
            logFilter = filters;
        }

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

        function addLog(msg, level = 'info', category = 'general') {
            if (!logFilter.includes(level) && !logFilter.includes(category)) return;

            const ICONS = { info: 'ℹ️', warn: '⚠️', 'error': '🔴', 'block': '🚫', 'allow': '✅' };
            const fullMsg = `[${new Date().toLocaleTimeString()}] ${ICONS[level] || ''} [${category}] ${msg}`;

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

        function addLogOnce(key, message, delay = 5000, level = 'info', category = 'general') {
            const currentTime = Date.now();
            const lastLogTime = LOGGED_KEYS_WITH_TIMER.get(key);
            if (!lastLogTime || currentTime - lastLogTime > delay) {
                LOGGED_KEYS_WITH_TIMER.set(key, currentTime);
                addLog(message, level, category);
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

        return { init, add: addLog, addOnce: addLogOnce, setFilter };
    })();

    // --- 팝업/광고 차단기 모듈 ---
    const popupBlocker = (() => {
        const originalWindowOpen = window.open;
        let userInitiatedAction = false;
        let lastHostnameOnLoad = location.hostname;

        const setUserInitiatedAction = () => {
            userInitiatedAction = true;
            setTimeout(() => { userInitiatedAction = false; }, 500);
        };

        const blockOpen = (...args) => {
            const url = args[0] || '(no URL)';
            const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
            if (isForceBlocked) {
                logManager.addOnce('popup_force_block', `window.open 강제 차단 | 대상: ${url}`, 5000, 'block');
                return getFakeWindow();
            }
            if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                logManager.addOnce('popup_allow', `window.open 허용됨 (사용자 동작) | 대상: ${url}`, 5000, 'allow');
                const features = (args[2] || '') + ',noopener,noreferrer';
                return originalWindowOpen.apply(window, [args[0], args[1], features]);
            }
            logManager.addOnce('popup_block_detected', `window.open 차단됨 | 대상: ${url}`, 5000, 'block');
            return getFakeWindow();
        };

        const init = () => {
            if (!FeatureFlags.popupBlocker) return;
            logManager.addOnce('init_popup_blocker', '팝업 차단 로직 초기화', 5000, 'info', 'popup');

            document.addEventListener('click', setUserInitiatedAction, true);
            document.addEventListener('mousedown', setUserInitiatedAction, true);
            document.addEventListener('keydown', setUserInitiatedAction, true);

            try {
                if (isFeatureAllowed('windowOpen')) {
                    Object.defineProperty(window, 'open', { get: () => blockOpen, set: () => {}, configurable: true });
                    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) unsafeWindow.open = blockOpen;
                }
                if (isFeatureAllowed('opener')) {
                    Object.defineProperty(window, 'opener', { get: () => null, set: () => {}, configurable: false, writable: false });
                }
            } catch (e) {
                logManager.addOnce('window_prop_redefine_fail', `window.open/opener 재정의 실패: ${e.message}`, 5000, 'warn', 'popup');
            }

            const originalPushState = history.pushState;
            history.pushState = function(...args) {
                if (args[2] && new URL(args[2], window.location.href).hostname !== lastHostnameOnLoad && window.name) window.name = '';
                return originalPushState.apply(this, args);
            };
            const originalReplaceState = history.replaceState;
            history.replaceState = function(...args) {
                if (args[2] && new URL(args[2], window.location.href).hostname !== lastHostnameOnLoad && window.name) window.name = '';
                return originalReplaceState.apply(this, args);
            };

            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    logManager.addOnce('dangerous_file_download_blocked', `위험 파일 다운로드 차단됨 | 대상: ${a.href}`, 5000, 'block', 'security');
                }
            }, true);
        };
        const destroy = () => {
            // Not implemented for this module as it's meant to run once
        };

        return { init, destroy };
    })();

    // --- 네트워크 모니터링 모듈 ---
    const networkMonitor = (() => {
        const originalXHR = XMLHttpRequest.prototype.open;
        const originalFetch = window.fetch;
        let capturedVideoURLs = new Set();
        const blobToOriginalURLMap = new Map();
        const mediaSourceBlobMap = new WeakMap();

        const knownExtensions = ['.m3u8', '.mpd', '.ts', '.mp4', '.webm', '.mov', '.avi', '.flv', '.aac', '.ogg', '.mp3'];
        const isVideoUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.toLowerCase();
            return knownExtensions.some(ext => normalizedUrl.includes(ext)) ||
                   normalizedUrl.includes('mime=video') ||
                   normalizedUrl.includes('video/');
        };

        const isVideoMimeType = (mime) => mime?.includes('video/') || mime?.includes('octet-stream');

        const normalizeURL = (url) => {
            try {
                const u = new URL(url);
                u.searchParams.forEach((_, key) => {
                    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('session') || key.toLowerCase().includes('time')) {
                        u.searchParams.delete(key);
                    }
                });
                return u.toString();
            } catch {
                return url;
            }
        };

        const getOriginalURLIfBlob = (url) => {
            const originalUrl = blobToOriginalURLMap.get(url) || url;
            if (originalUrl.startsWith('blob:') && mediaSourceBlobMap.has(url)) {
                 return mediaSourceBlobMap.get(url)
            }
            return originalUrl;
        };

        const trackAndAttach = (url, sourceType = 'network') => {
            const originalURL = getOriginalURLIfBlob(url);
            const normalizedUrl = normalizeURL(originalURL);
            if (capturedVideoURLs.has(normalizedUrl)) return;
            capturedVideoURLs.add(normalizedUrl);

            logManager.addOnce(`network_detected_${normalizedUrl.substring(0, 50)}`, `🎥 네트워크 영상 URL 감지됨 (${sourceType}) | 원본: ${originalURL}`, 5000, 'info', 'network');

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
            try {
                XMLHttpRequest.prototype.open = function(method, url, ...args) {
                    if (isVideoUrl(url)) trackAndAttach(url, 'xhr');
                    return originalXHR.apply(this, [method, url, ...args]);
                };
            } catch (e) {
                logManager.addOnce('xhr_hook_fail', `⚠️ XHR 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }

            try {
                if (originalFetch) {
                    window.fetch = async function(...args) {
                        const url = args[0] && typeof args[0] === 'object' ? args[0].url : args[0];
                        let res;
                        try {
                            res = await originalFetch.apply(this, args);
                            const clone = res.clone();
                            const contentType = clone.headers.get("content-type");
                            if (isVideoUrl(url) || isVideoMimeType(contentType)) {
                                trackAndAttach(url, 'fetch');
                                clone.blob().then(blob => {
                                    if (blob.type.includes('video') || blob.type.includes('octet-stream')) {
                                        const blobURL = URL.createObjectURL(blob);
                                        blobToOriginalURLMap.set(blobURL, url);
                                    }
                                }).catch(e => {
                                    logManager.addOnce('blob_capture_error_safe', `Blob URL 매핑 중 오류 발생 (무시): ${e.message}`, 5000, 'warn', 'network');
                                });
                            }
                        } catch (e) {
                            logManager.addOnce('fetch_hook_error', `⚠️ Fetch 후킹 중 오류 발생: ${e.message}`, 5000, 'error', 'network');
                            throw e;
                        }
                        return res;
                    };
                }
            } catch (e) {
                logManager.addOnce('fetch_hook_fail', `⚠️ Fetch 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }

            try {
                const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
                if (origAddSourceBuffer) {
                    MediaSource.prototype.addSourceBuffer = function(mimeType) {
                        logManager.addOnce('mse_detected', `🧪 MediaSource.addSourceBuffer 호출됨, MIME: ${mimeType}`, 5000, 'info', 'network');
                        return origAddSourceBuffer.apply(this, [mimeType]);
                    };
                }

                const origEndOfStream = MediaSource.prototype.endOfStream;
                if (origEndOfStream) {
                    MediaSource.prototype.endOfStream = function(...args) {
                        logManager.addOnce('mse_endofstream', `🧪 MediaSource.endOfStream 호출됨`, 5000, 'info', 'network');
                        return origEndOfStream.apply(this, args);
                    };
                }
            } catch (e) {
                logManager.addOnce('mse_hook_fail', `⚠️ MediaSource 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }

            try {
                const origSrcObjDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
                if (origSrcObjDescriptor?.set) {
                    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
                        set(obj) {
                            logManager.addOnce('srcObject_set', `🛰️ video.srcObject 변경 감지`, 5000, 'info', 'network');
                            if (obj) trackAndAttach(obj, 'srcObject');
                            return origSrcObjDescriptor.set.call(this, obj);
                        },
                        get() { return origSrcObjDescriptor.get.call(this); }
                    });
                }
            } catch (e) {
                logManager.addOnce('srcObject_hook_fail', `⚠️ srcObject 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }

            try {
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
            } catch (e) {
                logManager.addOnce('src_hook_fail', `⚠️ src 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }

            try {
                const originalCreateObjectURL = URL.createObjectURL;
                if (originalCreateObjectURL) {
                    URL.createObjectURL = function(obj) {
                        const url = originalCreateObjectURL.call(this, obj);
                        const type = obj instanceof MediaSource ? 'MediaSource' : 'Blob';
                        logManager.addOnce(`createObjectURL_${url}`, `[URL] createObjectURL 호출됨: 타입=${type} URL=${url}`, 5000, 'info', 'network');
                        if (isVideoUrl(url)) trackAndAttach(url, type);
                        return url;
                    };
                }
            } catch (e) {
                logManager.addOnce('createObjectURL_hook_fail', `⚠️ createObjectURL 후킹 실패: ${e.message}`, 5000, 'warn', 'network');
            }
        };

        const destroy = () => {
            // Revert hooks if necessary
        };

        return {
            init: hookPrototypes,
            destroy,
            getOriginalURLIfBlob,
            isVideoUrl,
            trackAndAttach,
            capturedVideoURLs,
            setCapturedVideoURLs: (urls) => { capturedVideoURLs = urls; }
        };
    })();

    // --- layerTrap 모듈 ---
    const layerTrap = (() => {
        const PROCESSED_ELEMENTS = new WeakSet();
        const isTrap = (el) => {
            if (!(el instanceof HTMLElement) || PROCESSED_ELEMENTS.has(el)) return false;
            if (TrapConfig.allowList.some(sel => el.matches(sel))) return false;
            if (TrapConfig.blockList.some(sel => el.matches(sel))) return true;

            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const isLarge = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
            const isFixedOrAbs = style.position === 'fixed' || style.position === 'absolute';
            const zIndex = parseInt(style.zIndex) || 0;
            const hasPointerEvents = style.pointerEvents !== 'none';
            const hasOnClick = el.onclick || el.onpointerdown || (el.onmousedown && hasPointerEvents);
            const isSuspicious = isLarge && isFixedOrAbs && zIndex > 100 && (hasPointerEvents || hasOnClick);
            if (isSuspicious && TrapConfig.layerTrapPreview) highlightTrap(el);
            return isSuspicious;
        };

        const handleTrap = (el) => {
            PROCESSED_ELEMENTS.add(el);
            try {
                el.style.display = 'none';
                logManager.addOnce(`trap_removed_${Date.now()}`, `🧲 레이어 트랩 숨김 | 제거 방식: style.display='none'`, 10000, 'warn', 'adblock');
            } catch (e) {
                logManager.addOnce('layertrap_remove_error', `trap 처리 실패: ${e.message}`, 5000, 'error', 'adblock');
            }
        };

        const highlightTrap = (el) => { /* ... (기존 코드와 동일) ... */ };
        const scan = (doc) => {
            if (!FeatureFlags.layerTrap) return;
            doc.querySelectorAll('body *').forEach(el => {
                if (isTrap(el)) handleTrap(el);
            });
        };
        const init = () => {};
        const destroy = () => {};

        return { init, destroy, check: isTrap, handleTrap, scan };
    })();

    // --- 비디오 탐색 모듈 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            if (!doc || !doc.body || typeof doc.createTreeWalker !== 'function') {
                if (doc && doc.readyState !== 'complete') {
                    return [];
                }
                logManager.addOnce('tree_walker_error', '⚠️ TreeWalker 오류: doc 또는 doc.body가 유효하지 않음', 5000, 'warn', 'video');
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
                logManager.addOnce('tree_walker_error', `⚠️ TreeWalker 오류: ${e.message}`, 5000, 'warn', 'video');
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
                if (area > largestArea && area < window.innerWidth * window.innerHeight * 0.9) {
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
        const VIDEO_STATE = new WeakMap();
        let speedSliderContainer;
        let playbackUpdateTimer;
        let isMinimized = JSON.parse(localStorage.getItem('speedSliderMinimized') || 'true');

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
            videos.forEach(video => {
                if (video.playbackRate !== validSpeed) {
                    video.playbackRate = validSpeed;
                }
            });
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
            const newHeight = video ? Math.min(300, Math.max(100, video.getBoundingClientRect().height * 0.8)) : 150;
            if (slider) slider.style.height = `${newHeight}px`;

            const targetParent = document.fullscreenElement || document.body;
            if (sliderContainer.parentNode !== targetParent) {
                targetParent.appendChild(sliderContainer);
            }
        };
        const destroy = () => {
            if (speedSliderContainer) {
                speedSliderContainer.remove();
                speedSliderContainer = null;
            }
        };

        return { init, destroy, show, hide, updatePositionAndSize, isMinimized: () => isMinimized };
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
                }, 300);
            }
        };

        const applyTimeChange = () => {
            const videos = videoFinder.findAll();
            const timeToApply = Math.round(dragState.totalTimeChange / DRAG_CONFIG.PIXELS_PER_SECOND);

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
                clearTimeout(dragState.recoveryTimer);
                clearTimeout(dragState.throttleTimer);
                dragState.throttleTimer = null;
                updateTimeDisplay(0);

                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                if(document.body) document.body.style.userSelect = '';

                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) {
                logManager.addOnce('drag_cancel_error', `드래그 취소 오류: ${e.message}`, 5000, 'error', 'ui');
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
            clearTimeout(dragState.recoveryTimer);
            dragState.recoveryTimer = setTimeout(cancelDrag, 5000);

            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
        };

        const handleMove = (e) => {
            if (!dragState.isDragging) return;
            try {
                if (e.touches && e.touches.length > 1) return cancelDrag();
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
                    } else if (dy > 10) {
                        return cancelDrag();
                    }
                }

                if (dragState.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    dragState.totalTimeChange = Math.round(dragState.currentDragDistanceX / DRAG_CONFIG.PIXELS_PER_SECOND);
                    updateTimeDisplay(dragState.totalTimeChange);

                    const now = Date.now();
                    if (now - dragState.lastDragTimestamp > 150) {
                        dragState.lastDragTimestamp = now;
                    }
                    dragState.lastUpdateX = currentX;
                }
            } catch(e) {
                logManager.addOnce('drag_move_error', `드래그 이동 오류: ${e.message}`, 5000, 'error', 'ui');
                cancelDrag();
            }
        };

        const handleEnd = () => {
            if (!dragState.isDragging) return;
            try {
                applyTimeChange();
                cancelDrag();
            } catch(e) {
                logManager.addOnce('drag_end_error', `드래그 종료 오류: ${e.message}`, 5000, 'error', 'ui');
                cancelDrag();
            }
        };

        const init = () => {
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
        const destroy = () => {
            document.removeEventListener('mousedown', handleStart, true);
            document.removeEventListener('touchstart', handleStart, true);
            if (dragBarTimeDisplay) {
                dragBarTimeDisplay.remove();
                dragBarTimeDisplay = null;
            }
        };

        return { init, destroy, show, hide, updateTimeDisplay };
    })();

    // --- 동적 비디오 URL 표시 모듈 ---
    const dynamicVideoUI = {
        attach: (targetElement, url) => {
            if (!targetElement) return;
            const existingButton = targetElement.querySelector('.dynamic-video-url-btn');
            if (existingButton) return;

            const button = document.createElement('button');
            button.className = 'dynamic-video-url-btn';
            button.textContent = '🎞️';
            button.title = '비디오 URL 복사';
            button.setAttribute('aria-label', 'Copy video URL');
            Object.assign(button.style, {
                position: 'absolute', top: '5px', right: '5px', zIndex: '2147483647',
                background: 'rgba(0, 0, 0, 0.7)', color: 'white', border: 'none',
                borderRadius: '5px', padding: '5px 10px', cursor: 'pointer',
                pointerEvents: 'auto', display: 'block', transition: 'opacity 0.3s'
            });
            button.style.opacity = '0'; // Initially hidden
            targetElement.addEventListener('mouseenter', () => { button.style.opacity = '1'; });
            targetElement.addEventListener('mouseleave', () => { button.style.opacity = '0'; });

            button.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                const originalUrl = networkMonitor.getOriginalURLIfBlob(url);
                navigator.clipboard.writeText(originalUrl).then(() => {
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
            logManager.add(`✅ 동적 비디오 URL 버튼 생성됨: ${url}`, 'info', 'ui');
        },
        destroy: (targetElement) => {
            const button = targetElement.querySelector('.dynamic-video-url-btn');
            if (button) button.remove();
        }
    };

    // --- 비디오 컨트롤 모듈 ---
    const videoControls = (() => {
        const VIDEO_STATE = new WeakMap();

        const initWhenReady = (video) => {
            if (!video || VIDEO_STATE.has(video)) return;

            const videoData = { isInitialized: false, originalSrc: video.src };
            VIDEO_STATE.set(video, videoData);

            const onLoaded = () => {
                if (videoData.isInitialized) return;
                videoData.isInitialized = true;
                logManager.addOnce(`video_ready_${video.src || 'no-src'}`, `🎬 비디오 준비됨 | src: ${video.src}`, 5000, 'info', 'video');

                if (video.src && networkMonitor.isVideoUrl(video.src)) {
                    networkMonitor.trackAndAttach(video.src, 'video_src_initial');
                }
                const parentContainer = videoFinder.findLargestParent(video);
                if (parentContainer) dynamicVideoUI.attach(parentContainer, video.src);
            };

            if (video.readyState >= 1) {
                onLoaded();
            } else {
                video.addEventListener('loadedmetadata', onLoaded, { once: true });
                video.addEventListener('play', onLoaded, { once: true });
                video.addEventListener('playing', onLoaded, { once: true });
            }
        };

        const destroy = (video) => {
            if (!video || !VIDEO_STATE.has(video)) return;
            VIDEO_STATE.delete(video);
            // clean up any event listeners if needed
        };

        const init = (targetDocument) => {
            videoFinder.findInDoc(targetDocument).forEach(v => {
                try {
                    initWhenReady(v);
                } catch (e) {
                    logManager.addOnce(`video_init_fail_${v.id || 'no-id'}`, `비디오 초기화 실패: ${e.message}`, 5000, 'error', 'video');
                }
            });
        };

        return { init, destroy };
    })();

    // --- Iframe 차단 모듈 ---
    const iframeBlocker = (() => {
        const checkIframe = (iframe) => {
            const iframeSrc = iframe.src || iframe.getAttribute('data-src') || iframe.getAttribute('data-lazy-src') || '';
            const suspiciousKeywords = /ad|banner|tracking/i;
            if (iframe.srcdoc && suspiciousKeywords.test(iframe.srcdoc)) {
                logManager.addOnce('iframe_srcdoc_block', `🚫 srcdoc 기반 광고 iframe 차단됨`, 5000, 'block', 'adblock');
                return true;
            }
            const isAd = IGNORED_IFRAME_PATTERNS.some(p => p.test(iframeSrc)) || IFRAME_FORCE_BLOCK_PATTERNS.some(p => iframeSrc.includes(p));
            return isAd;
        };

        const block = (iframe) => {
            if (!FeatureFlags.iframeBlocker) return;
            const iframeSrc = iframe.src || '';
            const iframeId = iframe.id || 'unknown';

            iframe.src = 'about:blank';
            iframe.style.display = 'none';
            logManager.addOnce(`iframe_block_${iframeId}`, `🚫 iframe 차단됨 | ID: ${iframeId} | src: ${iframeSrc.substring(0, 50)}...`, 5000, 'block', 'adblock');
        };
        const init = () => {};
        const destroy = () => {};

        return { init, destroy, checkIframe, block };
    })();

    // --- SPA 및 MutationObserver 통합 모듈 ---
    const spaMonitor = (() => {
        let lastURL = location.href;
        let urlCheckInterval;

        const onNavigate = (reason = 'URL 변경 감지') => {
            const url = location.href;
            if (url !== lastURL) {
                lastURL = url;
                logManager.addOnce(`spa_navigate_${Date.now()}`, `🔄 ${reason} | URL: ${url}`, 5000, 'info', 'spa');

                PROCESSED_DOCUMENTS.clear();
                PROCESSED_NODES.clear();
                PROCESSED_IFRAMES.clear();
                LOGGED_KEYS_WITH_TIMER.clear();

                OBSERVER_MAP.forEach(observer => observer.disconnect());
                OBSERVER_MAP.clear();

                App.initializeAll(document);
            }
        };

        const init = () => {
            try {
                ['pushState', 'replaceState'].forEach(type => {
                    const orig = history[type];
                    history[type] = function (...args) {
                        try {
                            orig.apply(this, args);
                            onNavigate(`history.${type}`);
                        } catch(e) {
                            logManager.addOnce('history_api_error', `History API 오류: ${e.message}`, 5000, 'error', 'spa');
                        }
                    };
                });
                window.addEventListener('popstate', () => onNavigate('popstate'));

                // 보강된 SPA 감지
                urlCheckInterval = setInterval(() => {
                    if (location.href !== lastURL) {
                        onNavigate('Interval-based URL check');
                    }
                }, 500);

            } catch (e) {
                logManager.addOnce('spa_monitor_init_fail', `SPA 감지 초기화 실패: ${e.message}`, 5000, 'error', 'spa');
            }
        };

        const destroy = () => {
            clearInterval(urlCheckInterval);
            // Unhook history API if possible, but it's tricky
        };

        return { init, destroy, onNavigate };
    })();

    // --- 주요 기능 통합 및 실행 ---
    const App = (() => {
        let videoUIWatcherInterval = null;

        const handleIframeLoad = (iframe) => {
            if (!iframe || PROCESSED_IFRAMES.has(iframe)) {
                return;
            }
            PROCESSED_IFRAMES.add(iframe);

            const iframeSrc = iframe.src || 'about:blank';
            if (IGNORED_IFRAME_PATTERNS.some(p => p.test(iframeSrc))) return;

            const tryInit = (retries = 5, delay = 1000) => {
                if (retries <= 0) {
                    logManager.addOnce(`iframe_access_fail_${iframe.id || 'no-id'}`, `⚠️ iframe 접근 실패 (최대 재시도 횟수 초과) | src: ${iframeSrc}`, 5000, 'warn', 'iframe');
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
                try {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1) {
                                if (node.tagName === 'IFRAME' && !PROCESSED_IFRAMES.has(node)) {
                                    if (iframeBlocker.checkIframe(node)) {
                                        iframeBlocker.block(node);
                                    } else {
                                        handleIframeLoad(node);
                                    }
                                }
                                node.querySelectorAll('iframe').forEach(iframe => {
                                    if (!PROCESSED_IFRAMES.has(iframe)) {
                                        if (iframeBlocker.checkIframe(iframe)) {
                                            iframeBlocker.block(iframe);
                                        } else {
                                            handleIframeLoad(iframe);
                                        }
                                    }
                                });
                                node.querySelectorAll('video').forEach(video => videoControls.initWhenReady(video));
                            }
                        });
                        mutation.removedNodes.forEach(node => {
                            if (node.nodeType === 1 && node.tagName === 'VIDEO' && videoControls.destroy) {
                                videoControls.destroy(node);
                                dynamicVideoUI.destroy(videoFinder.findLargestParent(node));
                            }
                        });
                    } else if (mutation.type === 'attributes') {
                        const targetNode = mutation.target;
                        if (targetNode.nodeType === 1) {
                            if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                                PROCESSED_IFRAMES.delete(targetNode);
                                if (iframeBlocker.checkIframe(targetNode)) {
                                    iframeBlocker.block(targetNode);
                                } else {
                                    handleIframeLoad(targetNode);
                                }
                            }
                            if (FeatureFlags.layerTrap && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
                                if (layerTrap.check(targetNode)) layerTrap.handleTrap(targetNode);
                            }
                            if (targetNode.tagName === 'VIDEO' && (mutation.attributeName === 'src' || mutation.attributeName === 'controls')) {
                                videoControls.initWhenReady(targetNode);
                            }
                        }
                    }
                } catch (e) {
                    logManager.addOnce('mutation_processing_error', `변이 처리 중 오류 발생: ${e.message}`, 5000, 'error', 'system');
                }
            });
        };

        const startUnifiedObserver = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument) || !targetDocument.body) return;
            PROCESSED_DOCUMENTS.add(targetDocument);

            const rootElement = targetDocument.documentElement || targetDocument.body;
            if (!rootElement) return;

            const observer = new MutationObserver(mutations => processMutations(mutations, targetDocument));
            observer.observe(rootElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'style', 'class', 'href', 'controls']
            });

            OBSERVER_MAP.set(targetDocument, observer);
            logManager.addOnce(`observer_active_${targetDocument.URL}`, `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info', 'system');
        };

        const startVideoUIWatcher = (targetDocument = document) => {
            if (!FeatureFlags.videoControls || !isTopFrame) return;
            if (videoUIWatcherInterval) clearInterval(videoUIWatcherInterval);

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

            videoUIWatcherInterval = setInterval(throttle(checkVideos, 1000), 1500);
            logManager.addOnce('video_watcher_started', '✅ 비디오 감시 루프 시작', 5000, 'info', 'video');
        };

        const initializeAll = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작 | 문서: ${targetDocument === document ? '메인' : targetDocument.URL}`, 5000, 'info', 'system');

            if (targetDocument === document) {
                try { popupBlocker.init(); } catch(e) { logManager.addOnce('popup_init_error', `팝업 차단 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }
                try { networkMonitor.init(); } catch(e) { logManager.addOnce('network_init_error', `네트워크 모니터링 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }
                try { spaMonitor.init(); } catch(e) { logManager.addOnce('spa_init_error', `SPA 모니터링 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }
                try { logManager.init(); } catch(e) { console.error('Log UI initialization failed:', e); }

                document.addEventListener('fullscreenchange', () => {
                    speedSlider.updatePositionAndSize();
                    if (!speedSlider.isMinimized()) {
                        dragBar.show();
                    } else {
                        dragBar.hide();
                    }
                });
                try { speedSlider.init(); } catch(e) { logManager.addOnce('slider_init_error', `속도 슬라이더 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }
                try { dragBar.init(); } catch(e) { logManager.addOnce('dragbar_init_error', `드래그 바 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }
            }

            startUnifiedObserver(targetDocument);
            startVideoUIWatcher(targetDocument);

            try { layerTrap.scan(targetDocument); } catch(e) { logManager.addOnce('layertrap_scan_error', `레이어 트랩 스캔 오류: ${e.message}`, 5000, 'error', 'system'); }
            try { videoControls.init(targetDocument); } catch(e) { logManager.addOnce('videocontrols_init_error', `비디오 컨트롤 초기화 오류: ${e.message}`, 5000, 'error', 'system'); }

            targetDocument.querySelectorAll('iframe').forEach(iframe => {
                if (!PROCESSED_IFRAMES.has(iframe)) {
                    if (iframeBlocker.checkIframe(iframe)) {
                        iframeBlocker.block(iframe);
                    } else {
                        handleIframeLoad(iframe);
                    }
                }
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

    // --- 전역 에러 핸들러 ---
    const ORIGINAL_ONERROR = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
        const knownThirdPartyErrors = [
            "OAS_RICH", "NAVER_ADPOST_V2", "PRINT_NAVER_ADPOST_V2", "wcs_do", "list_end_run",
            "jihpv16", "ouis7pv" // Add new patterns as they are found
        ];
        const isThirdParty = knownThirdPartyErrors.some(name => message && typeof message === 'string' && message.includes(`${name}`)) ||
                            (source && typeof source === 'string' && /humoruniv|donga|etoland|inven|ppomppu/.test(source)) ||
                            (message && typeof message === 'string' && (message.includes('Script error.') || message.includes('PartnersCoupang') || message.includes('TSOutstreamVideo')));

        if (isThirdParty) {
            return true;
        }

        const errorMsg = `전역 오류: ${message} at ${source}:${lineno}:${colno}`;
        logManager.addOnce('global_error', errorMsg, 5000, 'error', 'system');

        if (ORIGINAL_ONERROR) {
            return ORIGINAL_ONERROR.apply(this, arguments);
        }
        return false;
    };
    window.onunhandledrejection = event => {
        logManager.addOnce('promise_rejection', `Promise 거부: ${event.reason}`, 5000, 'error', 'system');
    };
})();
