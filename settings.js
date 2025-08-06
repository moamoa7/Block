// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https.com/
// @version       6.2.207
// @description   🚫 팝업/iframe 차단 + 🎞️ 비디오 속도 제어 UI + 🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합
// @match         *://*/*
// @grant         none
// @run-at        document-start
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
    const VIDEO_STATE = new WeakMap();
    const VIDEO_URL_CACHE = new Set();
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

        function addLogToBox(msg) {
            if (!logContentBox) {
                pendingLogs.push(msg);
                return;
            }
            logHistory.push(msg);
            if (logHistory.length > 50) logHistory.shift();

            logBoxContainer.style.opacity = '1';
            logBoxContainer.style.pointerEvents = 'auto';

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
            const ICONS = { info: 'ℹ️', warn: '⚠️', 'error': '🔴', 'block': '🚫', 'allow': '✅' };
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
            logBoxContainer.style.cssText = `
                position: fixed; bottom: 0; right: 0; max-height: 100px;
                width: 350px; z-index: 9999998; border-top-left-radius: 8px;
                overflow: hidden; opacity: 0; pointer-events: none;
                transition: opacity 0.3s ease; box-shadow: 0 0 8px #000;
            `;
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '로그 복사';
            copyBtn.style.cssText = `
                position: absolute; top: 0; right: 0; background: rgba(50,50,50,0.9);
                color: #fff; border: none; border-bottom-left-radius: 8px;
                padding: 4px 8px; font-size: 12px; cursor: pointer; z-index: 9999999;
                opacity: 0.8;
            `;
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
            logContentBox.style.cssText = `
                max-height: 100%; width: 100%; background: rgba(30,30,30,0.9);
                color: #fff; font-family: monospace; font-size: 14px;
                overflow-y: auto; padding: 8px; padding-top: 25px; user-select: text;
            `;
            logBoxContainer.appendChild(logContentBox);

            document.body.appendChild(logBoxContainer);
            while (pendingLogs.length > 0) {
                addLogToBox(pendingLogs.shift());
            }
        }

        return { init, add: addLog, addOnce: addLogOnce };
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
            logManager.addOnce('init_popup_blocker', '팝업 차단 로직 초기화', 5000, 'info');

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
                logManager.addOnce('window_prop_redefine_fail', `window.open/opener 재정의 실패: ${e.message}`, 5000, 'warn');
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
                    logManager.addOnce('dangerous_file_download_blocked', `위험 파일 다운로드 차단됨 | 대상: ${a.href}`, 5000, 'block');
                }
            }, true);
        };

        return { init };
    })();

    // --- 네트워크 모니터링 모듈 ---
    const networkMonitor = (() => {
        const originalXHR = XMLHttpRequest.prototype.open;
        const originalFetch = window.fetch;
        const originalCreateObjectURL = URL.createObjectURL;
        const blobToOriginalURLMap = new Map();

        const knownExtensions = ['.m3u8', '.mpd', '.ts', '.mp4', '.webm', '.mov', '.avi', '.flv', '.aac', '.ogg', '.mp3'];
        const isVideoUrl = (url) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.toLowerCase();
            return knownExtensions.some(ext => normalizedUrl.includes(ext)) ||
                   normalizedUrl.includes('mime=video') ||
                   normalizedUrl.includes('video/');
        };

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
            return blobToOriginalURLMap.get(url) || url;
        };

        const trackAndAttach = (url, sourceType = 'network') => {
            const originalURL = getOriginalURLIfBlob(url);
            const normalizedUrl = normalizeURL(originalURL);
            if (VIDEO_URL_CACHE.has(normalizedUrl)) return;
            VIDEO_URL_CACHE.add(normalizedUrl);

            logManager.addOnce(`network_detected_${normalizedUrl.substring(0, 50)}`, `🎥 네트워크 영상 URL 감지됨 (${sourceType}) | 원본: ${originalURL}`, 5000, 'info');

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
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                if (isVideoUrl(url)) trackAndAttach(url, 'xhr');
                return originalXHR.apply(this, [method, url, ...args]);
            };

            if (originalFetch) {
                window.fetch = async function(input, init) {
                    const res = await originalFetch.apply(this, arguments);
                    let url = typeof input === 'string' ? input : (input.url || '');
                    if (isVideoUrl(url)) {
                        trackAndAttach(url, 'fetch');
                        const clone = res.clone();
                        clone.blob().then(blob => {
                          const blobURL = URL.createObjectURL(blob);
                          blobToOriginalURLMap.set(blobURL, url);
                        }).catch(e => logManager.addOnce('blob_capture_error', `Blob URL 매핑 실패: ${e.message}`, 5000, 'warn'));
                    }
                    return res;
                };
            }

            const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            if (origAddSourceBuffer) {
                MediaSource.prototype.addSourceBuffer = function(mimeType) {
                    logManager.addOnce('mse_detected', `🧪 MediaSource.addSourceBuffer 호출됨, MIME: ${mimeType}`, 5000, 'info');
                    return origAddSourceBuffer.apply(this, [mimeType]);
                };
            }

            const origEndOfStream = MediaSource.prototype.endOfStream;
            if (origEndOfStream) {
                MediaSource.prototype.endOfStream = function(...args) {
                    logManager.addOnce('mse_endofstream', `🧪 MediaSource.endOfStream 호출됨`, 5000, 'info');
                    return origEndOfStream.apply(this, args);
                };
            }

            const origSrcObjDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
            if (origSrcObjDescriptor?.set) {
                Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
                    set(obj) {
                        logManager.addOnce('srcObject_set', `🛰️ video.srcObject 변경 감지`, 5000, 'info');
                        if (obj) trackAndAttach(obj, 'srcObject');
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

            const origCreateObjectURL = URL.createObjectURL;
            if (origCreateObjectURL) {
                URL.createObjectURL = function(obj) {
                    const url = origCreateObjectURL.call(this, obj);
                    const type = obj instanceof MediaSource ? 'MediaSource' : 'Blob';
                    logManager.addOnce(`createObjectURL_${url}`, `[URL] createObjectURL 호출됨: 타입=${type} URL=${url}`, 5000, 'info');
                    if (isVideoUrl(url)) trackAndAttach(url, type);
                    return url;
                };
            }
        };

        return { init: hookPrototypes, getOriginalURLIfBlob };
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
                logManager.addOnce(`trap_removed_${Date.now()}`, `🧲 레이어 트랩 숨김 | 제거 방식: style.display='none'`, 10000, 'warn');
            } catch (e) {
                logManager.addOnce('layertrap_remove_error', `trap 처리 실패: ${e.message}`, 5000, 'error');
            }
        };

        const highlightTrap = (el) => { /* ... (기존 코드와 동일) ... */ };
        const scan = (doc) => doc.querySelectorAll('body *').forEach(el => {
            if (isTrap(el)) handleTrap(el);
        });

        return { check: isTrap, handleTrap, scan };
    })();

    // --- 비디오 탐색 모듈 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            try {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
                    acceptNode: node => node.tagName === 'VIDEO' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
                });
                let currentNode;
                while ((currentNode = walker.nextNode())) {
                    videos.push(currentNode);
                }
            } catch (e) {
                logManager.addOnce('tree_walker_error', `TreeWalker 오류: ${e.message}`, 5000, 'warn');
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
                if (toggleBtn) toggleBtn.textContent = '▼'; // 최소화 버튼은 아래 방향 화살표
                dragBar.hide();
            } else {
                container.style.width = '50px';
                if (slider) slider.style.display = 'block';
                if (valueDisplay) valueDisplay.style.display = 'block';
                if (resetBtn) resetBtn.style.display = 'block';
                if (toggleBtn) toggleBtn.textContent = '▲'; // 최대화 버튼은 위 방향 화살표
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
                document.body.style.userSelect = '';

                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) {
                logManager.addOnce('drag_cancel_error', `드래그 취소 오류: ${e.message}`, 5000, 'error');
            }
        };

        const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

        const handleStart = (e) => {
            if (speedSlider.isMinimized() || dragState.isDragging || e.button === 2) {
                return;
            }
            if (e.target.closest('#vm-speed-slider-container, #vm-time-display')) {
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
                        document.body.style.userSelect = 'none';
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
                        // applyTimeChange();
                        dragState.lastDragTimestamp = now;
                    }
                    dragState.lastUpdateX = currentX;
                }
            } catch(e) {
                logManager.addOnce('drag_move_error', `드래그 이동 오류: ${e.message}`, 5000, 'error');
                cancelDrag();
            }
        };

        const handleEnd = () => {
            if (!dragState.isDragging) return;
            try {
                applyTimeChange();
                cancelDrag();
            } catch(e) {
                logManager.addOnce('drag_end_error', `드래그 종료 오류: ${e.message}`, 5000, 'error');
                cancelDrag();
            }
        };

        const init = () => {
            if (!document.body) return;
            dragBarTimeDisplay = document.getElementById('vm-time-display');
            if (!dragBarTimeDisplay) {
                dragBarTimeDisplay = document.createElement('div');
                dragBarTimeDisplay.id = 'vm-time-display';
                dragBarTimeDisplay.style.cssText = `
                    position: fixed !important; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 5px;
                    font-size: 1.5rem; z-index: 2147483647 !important; display: none; pointer-events: none;
                    transition: opacity 0.3s ease-out; opacity: 1; text-align: center; white-space: nowrap;
                `;
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
            if (dragBarTimeDisplay.parentNode !== targetParent) {
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
            const existingButton = targetElement.querySelector('.dynamic-video-url-btn');
            if (existingButton) return;

            const button = document.createElement('button');
            button.className = 'dynamic-video-url-btn';
            button.textContent = '🎞️';
            Object.assign(button.style, {
                position: 'absolute', top: '5px', right: '5px', zIndex: '2147483647',
                background: 'rgba(0, 0, 0, 0.7)', color: 'white', border: 'none',
                borderRadius: '5px', padding: '5px 10px', cursor: 'pointer',
                pointerEvents: 'auto', display: 'block'
            });

            button.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                const originalUrl = networkMonitor.getOriginalURLIfBlob(url);
                navigator.clipboard.writeText(originalUrl).then(() => {
                    const originalText = button.textContent;
                    button.textContent = 'URL 복사됨!';
                    setTimeout(() => button.textContent = originalText, 2000);
                });
            };
            if (getComputedStyle(targetElement).position === 'static') {
                targetElement.style.position = 'relative';
            }
            targetElement.appendChild(button);
            logManager.add(`✅ 동적 비디오 URL 버튼 생성됨: ${url}`, 'info');
        }
    };

    // --- Iframe 차단 모듈 ---
    const iframeBlocker = (() => {
        const checkIframe = (iframe) => {
            const iframeSrc = iframe.src || iframe.getAttribute('data-src') || iframe.getAttribute('data-lazy-src') || '';
            const isAd = IGNORED_IFRAME_PATTERNS.some(p => p.test(iframeSrc)) || IFRAME_FORCE_BLOCK_PATTERNS.some(p => iframeSrc.includes(p));
            return isAd;
        };

        const init = (iframe, trigger) => {
            if (!FeatureFlags.iframeBlocker || PROCESSED_IFRAMES.has(iframe)) return;
            PROCESSED_IFRAMES.add(iframe);
            const iframeSrc = iframe.src || '';

            if (checkIframe(iframe)) {
                iframe.src = 'about:blank';
                iframe.style.display = 'none';
                logManager.addOnce(`iframe_block_${iframeSrc.substring(0, 50)}`, `🚫 iframe 차단됨 | 원본: ${iframeSrc}`, 5000, 'block');
                return;
            }

            handleIframeLoad(iframe);
        };
        return { init };
    })();

    // --- SPA 및 MutationObserver 통합 모듈 ---
    let mutationQueue = [];
    let mutationTimer = null;
    let videoUIWatcherInterval = null;
    let lastURL = location.href;

    const processMutations = (mutations) => {
        mutations.forEach(mutation => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.tagName === 'IFRAME') {
                            iframeBlocker.init(node, '동적 추가');
                        }
                        if (node.tagName === 'VIDEO') {
                            videoControls.initWhenReady(node);
                        }
                        if (FeatureFlags.layerTrap && layerTrap.check(node)) {
                            layerTrap.handleTrap(node);
                        }
                    }
                });
                mutation.removedNodes.forEach(node => {
                    if (node.tagName === 'VIDEO' && VIDEO_STATE.has(node)) {
                        videoControls.detachUI(node);
                    }
                    if (node.tagName === 'DIV' && node.querySelector('.dynamic-video-url-btn')) {
                        const btn = node.querySelector('.dynamic-video-url-btn');
                        if (btn) btn.remove();
                    }
                });
            } else if (mutation.type === 'attributes') {
                const targetNode = mutation.target;
                if (targetNode.nodeType === 1) {
                    if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                        PROCESSED_IFRAMES.delete(targetNode);
                        iframeBlocker.init(targetNode, 'iframe src 변경');
                    }
                }
            }
        });
    };

    function startUnifiedObserver(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
        const rootElement = targetDocument.documentElement || targetDocument.body;
        if (!rootElement) return;

        const observer = new MutationObserver(mutations => {
            mutationQueue.push(...mutations);
            if (mutationTimer) clearTimeout(mutationTimer);
            mutationTimer = setTimeout(() => {
                processMutations(mutationQueue);
                mutationQueue = [];
            }, 100);
        });

        observer.observe(rootElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['src', 'style', 'class', 'href'] });
        PROCESSED_DOCUMENTS.add(targetDocument);
        OBSERVER_MAP.set(targetDocument, observer);
        logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info');

        targetDocument.querySelectorAll('iframe').forEach(iframe => {
            handleIframeLoad(iframe);
        });
    }

    function handleIframeLoad(iframe) {
        if (PROCESSED_IFRAMES.has(iframe)) return;
        PROCESSED_IFRAMES.add(iframe);
        const iframeSrc = iframe.src || 'about:blank';
        if (IGNORED_IFRAME_PATTERNS.some(p => p.test(iframeSrc))) return;

        try {
            if (iframe.contentWindow && iframe.contentWindow.location && iframe.contentWindow.location.hostname === location.hostname) {
                const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDocument && !PROCESSED_DOCUMENTS.has(iframeDocument)) {
                    initializeAll(iframeDocument);
                }
            } else {
                logManager.addOnce(`iframe_load_cross_origin_${iframe.id || 'no-id'}`, `⚠️ Cross-Origin iframe 접근 시도됨 | 대상: ${iframeSrc}`, 5000, 'warn');
            }
        } catch (e) {
            logManager.addOnce(`iframe_access_fail_${iframe.id || 'no-id'}`, `⚠️ iframe 접근 오류 (Cross-Origin)`, 5000, 'warn');
        }
    }

    // --- 비디오 컨트롤러 모듈 ---
    const videoControls = {
        initWhenReady: (video) => {
            if (VIDEO_STATE.has(video)) return;
            const tryInit = () => {
                if (!video.isConnected) {
                    VIDEO_STATE.delete(video);
                    return;
                }
                if (video.readyState >= 1) {
                    videoControls.attachUI(video);
                } else {
                    setTimeout(tryInit, 300);
                }
            };
            VIDEO_STATE.set(video, { initialized: true });
            tryInit();
        },
        attachUI: (video) => {
            if (VIDEO_STATE.get(video).uiAttached) return;
            const state = VIDEO_STATE.get(video);
            state.uiAttached = true;
            if (speedSlider) speedSlider.show();
            if (dragBar && !speedSlider.isMinimized()) dragBar.show();
            logManager.addOnce('video_ui_init_success', '✅ 비디오 UI 감지 및 초기화 완료', 5000, 'info');

            video.addEventListener('loadedmetadata', speedSlider.updatePositionAndSize);
            video.addEventListener('durationchange', () => dragBar.updateTimeDisplay(0));
            if ('ResizeObserver' in window) {
                const observer = new ResizeObserver(speedSlider.updatePositionAndSize);
                observer.observe(video);
                state.observer = observer;
            }
            VIDEO_STATE.set(video, state);
        },
        detachUI: (video) => {
            const state = VIDEO_STATE.get(video);
            if (state?.observer) state.observer.disconnect();
            VIDEO_STATE.delete(video);
        }
    };

    // --- 비디오 UI 감지 루프 (보조) ---
    function startVideoUIWatcher(targetDocument = document) {
        if (!FeatureFlags.videoControls) return;
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
        logManager.addOnce('video_watcher_started', '✅ 비디오 감시 루프 시작', 5000, 'info');
    }

    // --- SPA 감지 로직 ---
    function onNavigate(reason = 'URL 변경 감지') {
        const url = location.href;
        if (url !== lastURL) {
            lastURL = url;
            logManager.addOnce(`spa_navigate_${Date.now()}`, `🔄 ${reason} | URL: ${url}`, 5000, 'info');
            PROCESSED_DOCUMENTS.clear();
            PROCESSED_NODES.clear();
            PROCESSED_IFRAMES.clear();
            LOGGED_KEYS_WITH_TIMER.clear();
            OBSERVER_MAP.forEach(observer => observer.disconnect());
            initializeAll(document);
        }
    }
    window.addEventListener('popstate', () => onNavigate('popstate'));

    // --- 단일 초기 실행 함수 ---
    function initializeAll(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
        PROCESSED_DOCUMENTS.add(targetDocument);
        logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작 | 문서: ${targetDocument === document ? '메인' : targetDocument.URL}`, 5000, 'info');

        if (targetDocument === document) {
            popupBlocker.init();
            networkMonitor.init();
            document.addEventListener('fullscreenchange', speedSlider.updatePositionAndSize);
            document.addEventListener('fullscreenchange', () => {
                if (!speedSlider.isMinimized()) {
                    dragBar.show();
                } else {
                    dragBar.hide();
                }
            });
        }

        startUnifiedObserver(targetDocument);
        startVideoUIWatcher(targetDocument);
        layerTrap.scan(targetDocument);
        videoFinder.findInDoc(targetDocument).forEach(video => {
            videoControls.initWhenReady(video);
        });
    }

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            logManager.init();
            initializeAll(document);
        });
    } else {
        logManager.init();
        initializeAll(document);
    }

    // --- 전역 에러 핸들러 ---
    const ORIGINAL_ONERROR = window.onerror;
    window.onerror = (message, source) => {
        if (source && typeof source === 'string' && source.includes('supjav.php')) {
            return true;
        }
        if (message && typeof message === 'string' && (message.includes('PartnersCoupang') || message.includes('TSOutstreamVideo'))) {
            return true;
        }
        logManager.addOnce('global_error', `전역 오류: ${message} at ${source}`, 5000, 'error');
        if (ORIGINAL_ONERROR) {
            return ORIGINAL_ONERROR.apply(this, arguments);
        }
        return false;
    };
    window.onunhandledrejection = event => {
        logManager.addOnce('promise_rejection', `Promise 거부: ${event.reason}`, 5000, 'error');
    };
})();
