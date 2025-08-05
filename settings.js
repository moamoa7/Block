// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https.com/
// @version       6.2.142 (최종 수정)
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Slider, PC/모바일 드래그바로 재생 시간 조절을 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화
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

    // --- 기능별 상수 및 예외 처리 ---
    const WHITELIST = [
        'challenges.cloudflare.com',
        'recaptcha',
        '/e/',
    ];
    const EXCEPTION_LIST = {
        'supjav.com': ['iframeBlocker'],
    };
    const FORCE_BLOCK_POPUP_PATTERNS = [];
    const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
        'google.com',
        'ok.ru',
        'twitch.tv',
        'accounts.google.com',
        'missav.ws'
    ];
    const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
        '{"event":"timeupdate"',
    ];
    const IFRAME_SKIP_DOMAINS = [];
    const IFRAME_FORCE_BLOCK_PATTERNS = [
        '/ads/', 'adsbygoogle', 'doubleclick', 'adpnut.com',
        'iframead', 'loader.fmkorea.com/_loader/', '/smartpop/',
        '8dkq9tp.xyz', 's.amazon-adsystem.com',
    ];
    const IGNORED_IFRAME_PATTERNS = [
        /e\.mail\.ru/,
        /youtube\.com\/embed/,
        /player\.vimeo\.com/,
        /player\.twitch\.tv/,
        /ok\.ru\/videoembed/,
        /w\.naver\.com\/v2/,
        /serviceapi\.nmv\.naver\.com/,
        /pstatic\.net\/movie\/svc\/popup/,
        /html5player\.ru/,
        /video_player\.js/,
        /googlesyndication\.com/,
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
        value: true,
        writable: false,
        configurable: true
    });

    // --- 전역 상태 및 중복 방지 ---
    let PROCESSED_NODES = new WeakSet();
    let PROCESSED_IFRAMES = new WeakSet();
    let PROCESSED_DOCUMENTS = new WeakSet();
    let PROCESSED_VIDEOS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const LOGGED_KEYS_WITH_TIMER = new Map();
    const BLOCKED_IFRAME_URLS = new Set();
    let dragBarTimeDisplay = null;
    let speedSliderContainer = null;
    let isInitialLoadFinished = false;
    let logBoxRef = null;
    let isLogBoxReady = false;
    let logBoxContainer = null;
    let logContentBox = null;
    let pendingLogs = [];
    let logDismissTimer = null;
    const logHistory = [];

    // 비디오 UI 관련 상태 (각 모듈에서 관리하도록 변경)
    const videoUIFlags = {
        isUIBeingUsed: false,
        isMinimized: true,
    };
    let __videoUIInitialized = false;

    const isTopFrame = window.self === window.top;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isFeatureAllowed = (featureName) => {
        const exceptions = EXCEPTION_LIST[hostname] || [];
        return exceptions.includes(featureName);
    };

    // --- 로그 출력 제어용 함수 (중복 방지 로직 포함) ---
    function addLogOnce(key, message, delay = 5000, level = 'info') {
        if (!FeatureFlags.logUI) return;
        const currentTime = Date.now();
        const lastLogTime = LOGGED_KEYS_WITH_TIMER.get(key);

        if (!lastLogTime || currentTime - lastLogTime > delay) {
            LOGGED_KEYS_WITH_TIMER.set(key, currentTime);
            const ICONS = { info: 'ℹ️', warn: '⚠️', block: '🚫', allow: '✅' };
            const fullMsg = `${ICONS[level] || ''} ${message}`;
            addLog(fullMsg);
        }
    }

    // --- 로그 기능 (출처 정보 추가) ---
    function addLogToBox(msg) {
        if (!logContentBox) return;
        const logText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logHistory.push(logText);
        if (logHistory.length > 50) {
            logHistory.shift();
        }
        logBoxContainer.style.opacity = '1';
        logBoxContainer.style.pointerEvents = 'auto';
        const MAX_LOGS = 50;
        if (logContentBox.childElementCount >= MAX_LOGS) {
            logContentBox.removeChild(logContentBox.firstChild);
        }
        const entry = document.createElement('div');
        entry.textContent = logText;
        entry.style.textAlign = 'left';
        logContentBox.appendChild(entry);
        logContentBox.scrollTop = logContentBox.scrollHeight;
        if (logDismissTimer) {
            clearTimeout(logDismissTimer);
        }
        logDismissTimer = setTimeout(() => {
            logBoxContainer.style.opacity = '0';
            logBoxContainer.style.pointerEvents = 'none';
        }, 10000);
    }
    
    function addLog(msg) {
        if (!FeatureFlags.logUI) return;
        if (!isTopFrame) {
            try {
                window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: msg }, '*');
                return;
            } catch (e) {
                console.warn(`[MyScript Log - iframe error] ${msg}`);
                if (logBoxContainer) {
                    logBoxContainer.style.display = 'none';
                }
            }
        }

        if (isLogBoxReady) {
            addLogToBox(msg);
        } else {
            pendingLogs.push(msg);
            console.warn(`[MyScript Log - Pending/Debug] ${msg}`);
        }
    }

    function createLogBox() {
        if (!isTopFrame || !FeatureFlags.logUI) return;
        if (document.getElementById('popupBlockerLogContainer')) {
            logBoxContainer = document.getElementById('popupBlockerLogContainer');
            logContentBox = document.getElementById('popupBlockerLogBox');
            isLogBoxReady = true;
            return;
        }
        logBoxContainer = document.createElement('div');
        logBoxContainer.id = 'popupBlockerLogContainer';
        logBoxContainer.style.cssText = `
            position: fixed;
            bottom: 0;
            right: 0;
            max-height: 100px;
            width: 350px;
            z-index: 9999998;
            border-top-left-radius: 8px;
            overflow: hidden;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
            box-shadow: 0 0 8px #000;
        `;
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '로그 복사';
        copyBtn.id = 'popupBlockerCopyBtn';
        copyBtn.style.cssText = `
            position: absolute;
            top: 0;
            right: 0;
            background: rgba(50,50,50,0.9);
            color: #fff;
            border: none;
            border-bottom-left-radius: 8px;
            padding: 4px 8px;
            font-size: 12px;
            cursor: pointer;
            z-index: 9999999;
            opacity: 0.8;
        `;
        copyBtn.onclick = () => {
            if (logHistory.length > 0) {
                const logText = logHistory.join('\n');
                navigator.clipboard.writeText(logText)
                    .then(() => {
                        copyBtn.textContent = '복사 완료!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    })
                    .catch(err => {
                        console.error('클립보드 복사 실패:', err);
                        copyBtn.textContent = '복사 실패!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    });
            }
        };
        logBoxContainer.appendChild(copyBtn);
        logContentBox = document.createElement('div');
        logContentBox.id = 'popupBlockerLogBox';
        logContentBox.style.cssText = `
            max-height: 100%;
            width: 100%;
            background: rgba(30,30,30,0.9);
            color: #fff;
            font-family: monospace;
            font-size: 14px;
            overflow-y: auto;
            padding: 8px;
            padding-top: 25px;
            user-select: text;
        `;
        logBoxContainer.appendChild(logContentBox);
        const appendToBody = () => {
            if (document.body && !document.body.contains(logBoxContainer)) {
                document.body.appendChild(logBoxContainer);
                isLogBoxReady = true;
                logBoxRef = logContentBox;
                while (pendingLogs.length > 0) {
                    const pendingMsg = pendingLogs.shift();
                    addLogToBox(pendingMsg);
                }
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', appendToBody);
        } else {
            appendToBody();
        }
    }

    if (isTopFrame && FeatureFlags.logUI) {
        window.addEventListener('message', (event) => {
            const isIgnoredDomain = POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => event.origin.includes(domain));
            if (isIgnoredDomain) return;

            const msgData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
            if (POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => msgData.includes(pattern))) {
                return;
            }
            const logKey = `postmessage_log_${event.origin}`;
            addLogOnce(logKey, `postMessage 의심 감지됨 | 현재: ${window.location.href} | 참조: ${event.origin} | 데이터: ${msgData.substring(0, 100)}...`, 'warn');
        }, false);
        createLogBox();
    }

    // --- 팝업/광고 차단기 로직 ---
    const popupBlocker = {
        init: () => {
            if (!FeatureFlags.popupBlocker) return;
            addLogOnce('init_popup_blocker', '팝업 차단 로직 초기화', 'info');
            const originalWindowOpen = window.open;
            let userInitiatedAction = false;
            let lastVisibilityChangeTime = 0;
            let lastBlurTime = 0;

            addLogOnce('popup_blocker_status', '팝업 차단 로직 활성화', 'info');

            const setUserInitiatedAction = () => {
                userInitiatedAction = true;
                setTimeout(() => { userInitiatedAction = false; }, 500);
            };
            document.addEventListener('click', setUserInitiatedAction, true);
            document.addEventListener('mousedown', setUserInitiatedAction, true);
            document.addEventListener('keydown', setUserInitiatedAction, true);

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    lastVisibilityChangeTime = Date.now();
                } else {
                    lastVisibilityChangeTime = 0;
                }
            });
            window.addEventListener('blur', () => { lastBlurTime = Date.now(); });
            window.addEventListener('focus', () => { lastBlurTime = 0; });

            const blockOpen = (...args) => {
                const url = args[0] || '(no URL)';
                const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
                if (isForceBlocked) {
                    addLogOnce('popup_force_block', `window.open 강제 차단 | 대상: ${url}`, 'block');
                    return getFakeWindow();
                }
                const currentTime = Date.now();
                const timeSinceVisibilityChange = currentTime - lastVisibilityChangeTime;
                const timeSinceBlur = currentTime - lastBlurTime;
                if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                    addLogOnce('popup_allow', `window.open 허용됨 (사용자 동작) | 대상: ${url}`, 'allow');
                    const features = (args[2] || '') + ',noopener,noreferrer';
                    return originalWindowOpen.apply(window, [args[0], args[1], features]);
                }
                addLogOnce('popup_block_detected', `window.open 차단됨 | 대상: ${url}`, 'block');
                return getFakeWindow();
            };
            if (!isFeatureAllowed('windowOpen')) {
                try {
                    const originalOpen = window.open;
                    Object.defineProperty(window, 'open', {
                        get: () => blockOpen,
                        set: () => {},
                        configurable: true
                    });
                    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
                        unsafeWindow.open = blockOpen;
                    }
                } catch (e) {
                    addLogOnce('window_open_redefine_fail', `window.open 재정의 실패: ${e.message}`, 'warn');
                }
            }
            if (!isFeatureAllowed('opener')) {
                try {
                    Object.defineProperty(window, 'opener', {
                        get() { return null; },
                        set() {},
                        configurable: false
                    });
                    addLogOnce('opener_blocked', 'window.opener 속성 차단됨', 'block');
                } catch (e) {
                    addLogOnce('window_opener_block_fail', `window.opener 속성 차단 실패: ${e.message}`, 'warn');
                }
            }
            let originalHostnameOnLoad = hostname;
            document.addEventListener('DOMContentLoaded', () => {
                originalHostnameOnLoad = window.location.hostname;
                if (window.name && window.name.length > 0) {
                    window.name = '';
                    addLogOnce('window_name_cleared', 'window.name 속성 초기화', 'info');
                }
            });
            const originalPushState = history.pushState;
            history.pushState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            window.name = '';
                        }
                    } catch (e) { /* URL 파싱 오류 무시 */ }
                }
                return originalPushState.apply(this, args);
            };
            const originalReplaceState = history.replaceState;
            history.replaceState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            window.name = '';
                        }
                    } catch (e) { /* URL 파싱 오류 무시 */ }
                }
                return originalReplaceState.apply(this, args);
            };
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    addLogOnce('dangerous_file_download_blocked', `위험 파일 다운로드 차단됨 | 대상: ${a.href}`, 'block');
                }
            }, true);
            window.addEventListener('keydown', e => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 's' || e.key === 'p' || e.key === 'u' || (e.shiftKey && e.key === 'I')) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        addLogOnce('developer_tools_shortcut_blocked', `개발자 도구 단축키 차단됨: ${e.key}`, 'block');
                    }
                }
            }, true);
            window.addEventListener('message', (event) => {
                const isIgnoredDomain = POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => event.origin.includes(domain));
                if (isIgnoredDomain) return;

                const msgData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
                if (POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => msgData.includes(pattern))) {
                    return;
                }
                const logKey = `postmessage_log_${event.origin}`;
                addLogOnce(logKey, `postMessage 의심 감지됨 | 현재: ${window.location.href} | 참조: ${event.origin} | 데이터: ${msgData.substring(0, 100)}...`, 'warn');
            }, false);
            if (!isFeatureAllowed('fullscreen')) {
                try {
                    const originalRequestFullscreen = Document.prototype.requestFullscreen;
                    if (originalRequestFullscreen) {
                        Document.prototype.requestFullscreen = new Proxy(originalRequestFullscreen, {
                            apply(target, thisArg, argumentsList) {
                                addLogOnce('fullscreen_request_blocked', '전체 화면 요청 차단됨', 'block');
                                return Promise.reject('Blocked fullscreen request');
                            }
                        });
                    }
                } catch (e) {
                }
            }
            if (!isFeatureAllowed('location')) {
                try {
                    Object.defineProperty(window, 'location', {
                        configurable: false,
                        enumerable: true,
                        get: () => location,
                        set: (val) => {
                            addLogOnce('location_change_blocked', `location 이동 차단 시도됨 | 대상: ${val}`, 'block');
                        }
                    });
                } catch (e) {
                }
            }
        }
    };

    // --- iframe 차단기 로직 ---
    const iframeBlocker = {
        init: (node, trigger) => {
            if (!FeatureFlags.iframeBlocker) return;
            if (isFeatureAllowed('iframeBlocker') || PROCESSED_IFRAMES.has(node)) {
                return;
            }

            PROCESSED_IFRAMES.add(node);
            const IS_IFRAME_LOGIC_SKIPPED = IFRAME_SKIP_DOMAINS.some(domain => hostname.includes(domain) || window.location.href.includes(domain));
            if (IS_IFRAME_LOGIC_SKIPPED) {
                addLogOnce('iframe_skip_domain', `iframe 로직 건너뜀 | 현재 도메인: ${hostname}`, 'info');
                return;
            }

            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            const lazySrc = node.getAttribute('data-lazy-src');
            if (lazySrc) { fullSrc = lazySrc; }
            try { fullSrc = new URL(fullSrc, location.href).href; } catch {}
            const iframeId = node.id || '';
            const iframeClasses = node.className || '';
            const parentId = node.parentElement ? node.parentElement.id || '' : '';
            const parentClasses = node.parentElement ? node.parentElement.className || '' : '';

            let logKeyBase = 'iframe';
            try {
                const urlObj = new URL(fullSrc);
                const pathPrefix = urlObj.pathname.split('/').slice(0, 3).join('/');
                logKeyBase = `${urlObj.hostname}${pathPrefix}`;
            } catch {
                logKeyBase = 'invalid-src-url';
            }

            const logMessage = `iframe 감지됨 (${trigger}) [id: "${iframeId}", class: "${iframeClasses}"] | 현재: ${window.location.href} | 대상: ${fullSrc.length > 80 ? fullSrc.substring(0, 80) + '...' : fullSrc}`;
            addLogOnce(`iframe_detected_${logKeyBase}`, logMessage, 'info');

            if (fullSrc.startsWith('blob:') || fullSrc.startsWith('javascript:')) {
                addLogOnce(`iframe_unsafe_block_${logKeyBase}`, `iframe 즉시 차단 (안전하지 않은 src) | 대상: ${fullSrc}`, 'block');
                try { node.remove(); } catch {}
                return;
            }

            const isForcedBlocked = IFRAME_FORCE_BLOCK_PATTERNS.some(pattern => {
                return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
            });

            if (isForcedBlocked) {
                addLogOnce(`iframe_force_block_${logKeyBase}`, `iframe 강제 차단됨 (광고/위험) | 대상: ${fullSrc}`, 'block');
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }

            if (!node.hasAttribute('sandbox')) {
                try {
                    node.setAttribute('sandbox', USER_SETTINGS.defaultIframeSandbox);
                    addLogOnce(`iframe_sandbox_added_${logKeyBase}`, `iframe sandbox 속성 자동 추가 | 대상: ${fullSrc}`, 'info');
                } catch(e) {
                }
            }

            if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
                addLogOnce(`iframe_base64_block_${logKeyBase}`, `iframe 차단됨 (Base64 src) | 대상: ${fullSrc.substring(0, 50)}...`, 'block');
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }
            addLogOnce(`iframe_allow_${logKeyBase}`, `iframe 허용됨 (다른 확장 프로그램에 의한 차단 확인 필요) | 현재: ${window.location.href} | 대상: ${fullSrc}`, 'allow');
        }
    };

    // --- 레이어 클릭 덫 로직 ---
    const layerTrap = {
        check: (node) => {
            if (!FeatureFlags.layerTrap) return;
            if (!(node instanceof HTMLElement)) {
                return;
            }

            try {
                const style = getComputedStyle(node);
                const isSuspect = (style.position === 'fixed' &&
                                    parseInt(style.zIndex) > 1000 &&
                                    (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') &&
                                    style.pointerEvents !== 'none');

                const suspiciousHandlers = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'];
                const hasSuspiciousHandler = suspiciousHandlers.some(handler => node.hasAttribute(handler));

                if (isSuspect && hasSuspiciousHandler) {
                    node.style.setProperty('display', 'none', 'important');
                    node.setAttribute('data-popupblocker-status', 'removed');
                    addLogOnce('layer_trap_blocked', `클릭 덫으로 의심되는 레이어 차단됨 | Tag: ${node.tagName} | Z-index: ${style.zIndex}`, 'block');
                    node.addEventListener('click', e => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }, true);
                }
            } catch(e) {
            }
        }
    };

    // --- 비디오 탐색 로직 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = new Set();
            try {
                doc.querySelectorAll('video').forEach(v => videos.add(v));
            } catch (e) {
            }

            const potentialVideoContainers = doc.querySelectorAll('div[data-src], div[data-video], div[data-video-id], div[class*="video"], div[id*="player"]');
            potentialVideoContainers.forEach(container => {
                const videoElement = container.querySelector('video');
                if (videoElement) {
                    videos.add(videoElement);
                }
            });

            if (USER_SETTINGS.enableVideoDebugBorder) {
                let style = doc.querySelector('style#video-debug-style');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'video-debug-style';
                    style.textContent = `.my-video-ui-initialized { outline: 2px solid red !important; }`;
                    if (doc.head) {
                        doc.head.appendChild(style);
                    } else if (doc.body) {
                        doc.body.appendChild(style);
                    }
                }
            }

            videos.forEach(video => {
                if (!PROCESSED_VIDEOS.has(video)) {
                    const sources = [...video.querySelectorAll('source')].map(s => s.src).filter(Boolean);
                    const videoSource = video.currentSrc || video.src || sources[0] || '';
                    if (video.style.pointerEvents === 'none') {
                        video.style.setProperty('pointer-events', 'auto', 'important');
                    }
                    if (USER_SETTINGS.enableVideoDebugBorder && !video.classList.contains('my-video-ui-initialized')) {
                        video.classList.add('my-video-ui-initialized');
                    }
                    PROCESSED_VIDEOS.add(video);
                }
            });
            return Array.from(videos);
        },
        findAll: () => {
            let videos = videoFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    // 동일 출처 iframe인 경우에만 접근 시도
                    if (iframe.contentWindow && iframe.contentWindow.location.hostname === location.hostname) {
                        const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                        if (iframeDocument) {
                            videos.push(...videoFinder.findInDoc(iframeDocument));
                        }
                    } else {
                        addLogOnce('iframe_video_access_blocked', `cross-origin iframe 접근 차단됨`, 5000, 'warn');
                    }
                } catch (e) {
                    addLogOnce('iframe_video_access_error', `iframe 접근 오류: ${e.message}`, 5000, 'warn');
                }
            });
            return videos;
        }
    };

    // --- 배속 슬라이더 로직 ---
    const speedSlider = {
        speedSliderContainer: null,
        initialized: false,
        isMinimized: true,
        init: function() {
            if (this.initialized) return;

            const sliderId = 'vm-speed-slider-container';
            
            const createSliderElements = () => {
                const container = document.createElement('div');
                container.id = sliderId;
                container.style.touchAction = 'none';
                container.style.cursor = 'pointer';
                const style = document.createElement('style');
                style.textContent = `
                    #${sliderId} {
                        position: fixed; top: 50%; right: 0; transform: translateY(-50%);
                        background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px;
                        z-index: 2147483647 !important; display: none; flex-direction: column;
                        align-items: center; width: 50px; height: auto; font-family: sans-serif;
                        pointer-events: auto; opacity: 0.3; transition: all 0.3s ease; user-select: none;
                        box-shadow: 0 0 8px rgba(0,0,0,0.0); will-change: transform, opacity, width;
                    }
                    #${sliderId}:hover { opacity: 1; }
                    #vm-speed-reset-btn {
                        background: #444; border: none; border-radius: 4px; color: white;
                        font-size: 14px; padding: 4px 6px; cursor: pointer;
                        margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold;
                    }
                    #vm-speed-reset-btn:hover { background: #666; }
                    #vm-speed-slider {
                        writing-mode: vertical-lr;
                        direction: rtl;
                        width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer;
                        background: #555; border-radius: 5px;
                    }
                    #vm-speed-slider::-webkit-slider-thumb {
                        -webkit-appearance: none; width: 20px; height: 20px; background: #f44336;
                        border-radius: 50%; cursor: pointer; border: 1px solid #ddd;
                    }
                    #vm-speed-slider::-moz-range-thumb {
                        width: 20px; height: 20px; background: #f44336; border-radius: 50%;
                        cursor: pointer; border: 1px solid #ddd;
                    }
                    #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                    #vm-toggle-btn {
                        background: #444; border: none; border-radius: 4px; color: white;
                        font-size: 12px; padding: 4px 6px; cursor: pointer;
                        font-weight: bold; width: 40px; height: 30px; margin-top: 8px;
                    }
                    #vm-toggle-btn:hover { background: #666; }
                `;
                if (document.head) {
                    document.head.appendChild(style);
                } else if (document.body) {
                    document.body.appendChild(style);
                }
                const resetBtn = document.createElement('button');
                resetBtn.id = 'vm-speed-reset-btn';
                resetBtn.textContent = '1x';
                const slider = document.createElement('input');
                slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
                slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                const valueDisplay = document.createElement('div');
                valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';

                slider.addEventListener('input', (e) => {
                    e.stopPropagation();
                    this.onSliderChange(slider.value)
                }, true);
                slider.addEventListener('change', (e) => {
                    e.stopPropagation();
                    this.updateSpeed(parseFloat(slider.value || '1.0'))
                }, true);
                resetBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    slider.value = '1.0'; this.onSliderChange('1.0');
                });

                container.appendChild(resetBtn);
                container.appendChild(slider);
                container.appendChild(valueDisplay);

                const toggleBtn = document.createElement('button');
                toggleBtn.id = 'vm-toggle-btn';
                toggleBtn.textContent = this.isMinimized ? '▲' : '▼';
                toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleMinimize();
                };
                container.appendChild(toggleBtn);

                this.speedSliderContainer = container;
                
                if(this.isMinimized) {
                    container.style.width = '30px';
                    slider.style.display = 'none';
                    valueDisplay.style.display = 'none';
                    resetBtn.style.display = 'none';
                }
            };
            createSliderElements();
            this.initialized = true;
        },
        toggleMinimize: function() {
            const container = this.speedSliderContainer;
            const slider = document.getElementById('vm-speed-slider');
            const valueDisplay = document.getElementById('vm-speed-value');
            const resetBtn = document.getElementById('vm-speed-reset-btn');
            const toggleBtn = document.getElementById('vm-toggle-btn');
        
            this.isMinimized = !this.isMinimized;
        
            if (this.isMinimized) {
                container.style.width = '30px';
                slider.style.display = 'none';
                valueDisplay.style.display = 'none';
                resetBtn.style.display = 'none';
                toggleBtn.textContent = '▲';
                if (typeof dragBar?.hide === 'function') {
                    dragBar.hide();
                }
            } else {
                container.style.width = '50px';
                slider.style.display = 'block';
                valueDisplay.style.display = 'block';
                resetBtn.style.display = 'block';
                toggleBtn.textContent = '▼';
                this.updatePositionAndSize();
                const videos = videoFinder.findAll();
                const isVideoPlaying = videos.some(v => !v.paused);
                if (isVideoPlaying && typeof dragBar?.show === 'function') {
                    dragBar.show();
                }
            }
        },
        updateSpeed: (speed) => {
            const validSpeed = parseFloat(speed);
            if (isNaN(validSpeed)) return;
            const videos = videoFinder.findAll();
            videos.forEach(video => { video.playbackRate = validSpeed; });
        },
        onSliderChange: (val) => {
            const speed = parseFloat(val);
            if (isNaN(speed)) return;
            const valueDisplay = document.getElementById('vm-speed-value');
            if (valueDisplay) { valueDisplay.textContent = `x${speed.toFixed(1)}`; }
            if (videoUIFlags.playbackUpdateTimer) clearTimeout(videoUIFlags.playbackUpdateTimer);
            videoUIFlags.playbackUpdateTimer = setTimeout(() => { speedSlider.updateSpeed(speed); }, 100);
        },
        show: function() {
            if (!this.speedSliderContainer) {
                this.init();
            }
            if (!this.speedSliderContainer) return;

            if (!this.speedSliderContainer.parentNode) {
                document.body.appendChild(this.speedSliderContainer);
            }
            
            const targetParent = document.fullscreenElement || document.body;
            if (this.speedSliderContainer.parentNode !== targetParent) {
                if (this.speedSliderContainer.parentNode) {
                    this.speedSliderContainer.parentNode.removeChild(this.speedSliderContainer);
                }
                targetParent.appendChild(this.speedSliderContainer);
            }
            
            this.speedSliderContainer.style.display = 'flex';
            this.updatePositionAndSize();
            const slider = document.getElementById('vm-speed-slider');
            if (slider) {
                this.updateSpeed(slider.value || '1.0');
            }
        },
        hide: function() {
            if (this.speedSliderContainer) { this.speedSliderContainer.style.display = 'none'; }
        },
        updatePositionAndSize: function() {
            const videos = videoFinder.findAll();
            const video = videos.find(v => v.clientWidth > 0 && v.clientHeight > 0) || null;
            const sliderContainer = this.speedSliderContainer;
            const slider = document.getElementById('vm-speed-slider');

            if (!sliderContainer || !slider) {
                return;
            }

            let newHeight;
            if (video) {
                 if (isMobile) {
                    newHeight = 100;
                } else {
                    const minHeight = 100;
                    const maxHeight = 300;
                    const rect = video.getBoundingClientRect();
                    newHeight = rect.height * 0.8;
                    newHeight = Math.min(maxHeight, Math.max(minHeight, newHeight));
                }
            } else {
                newHeight = 150;
            }
            slider.style.height = `${newHeight}px`;

            sliderContainer.style.position = 'fixed';
            sliderContainer.style.top = '50%';
            sliderContainer.style.right = '0';
            sliderContainer.style.bottom = 'auto';
            sliderContainer.style.left = 'auto';
            sliderContainer.style.transform = 'translateY(-50%)';

            if (document.fullscreenElement) {
                if (sliderContainer.parentNode !== document.fullscreenElement) {
                    document.fullscreenElement.appendChild(sliderContainer);
                }
            } else {
                if (sliderContainer.parentNode !== document.body) {
                    document.body.appendChild(sliderContainer);
                }
            }
            sliderContainer.style.display = 'flex';
        }
    };

    // --- 드래그바 로직 ---
    const dragBar = {
        dragBarTimeDisplay: null,
        initialized: false,
        createTimeDisplay: function() {
            const newTimeDisplay = document.createElement('div');
            newTimeDisplay.id = 'vm-time-display';
            newTimeDisplay.style.cssText = `
                position: fixed !important; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 5px;
                font-size: 1.5rem; z-index: 2147483647 !important; display: none; pointer-events: none;
                transition: opacity 0.3s ease-out; opacity: 1; text-align: center; white-space: nowrap;
                will-change: transform, opacity;
            `;
            newTimeDisplay.style.touchAction = 'none';
            return newTimeDisplay;
        },
        show: function() {
            if (speedSlider.isMinimized) {
                this.hide();
                return;
            }
            
            if (!this.dragBarTimeDisplay) {
                this.init();
            }
            if (!this.dragBarTimeDisplay) return;

            if (!this.dragBarTimeDisplay.parentNode) {
                document.body.appendChild(this.dragBarTimeDisplay);
            }

            const targetParent = document.fullscreenElement || document.body;
            if (this.dragBarTimeDisplay.parentNode !== targetParent) {
                 if (this.dragBarTimeDisplay.parentNode) {
                    this.dragBarTimeDisplay.parentNode.removeChild(this.dragBarTimeDisplay);
                }
                targetParent.appendChild(this.dragBarTimeDisplay);
            }
        },
        hide: function() {
             if (this.dragBarTimeDisplay) {
                 this.dragBarTimeDisplay.style.display = 'none';
             }
        },
        init: function() {
            if (this.initialized) return;
            this.initialized = true;
            
            const dragState = {
                isDragging: false,
                isHorizontalDrag: false,
                startX: 0,
                startY: 0,
                lastUpdateX: 0,
                currentDragDistanceX: 0,
                totalTimeChange: 0,
                originalPointerEvents: new Map(),
                recoveryTimer: null,
                throttleTimer: null,
                lastDragTimestamp: 0,
                throttleDelay: 80,
            };

            const DRAG_THRESHOLD = 10;

            const formatTime = (seconds) => {
                const absSeconds = Math.abs(seconds);
                const sign = seconds < 0 ? '-' : '+';
                const minutes = Math.floor(absSeconds / 60);
                const remainingSeconds = Math.floor(absSeconds % 60);
            
                const paddedMinutes = String(minutes).padStart(2, '0');
                const paddedSeconds = String(remainingSeconds).padStart(2, '0');

                return `${sign}${paddedMinutes}분${paddedSeconds}초`;
            };

            const updateTimeDisplay = (timeChange) => {
                if (!this.dragBarTimeDisplay) {
                    this.dragBarTimeDisplay = this.createTimeDisplay();
                    const parent = document.fullscreenElement || document.body;
                    parent.appendChild(this.dragBarTimeDisplay);
                }
                if (!this.dragBarTimeDisplay) return;
            
                if (timeChange !== 0) {
                    this.dragBarTimeDisplay.textContent = `${formatTime(timeChange)} 이동`;
                    this.dragBarTimeDisplay.style.display = 'block';
                    this.dragBarTimeDisplay.style.opacity = '1';
                } else {
                    this.dragBarTimeDisplay.style.opacity = '0';
                    clearTimeout(this.dragBarTimeDisplay.timer);
                    this.dragBarTimeDisplay.timer = setTimeout(() => {
                        if (this.dragBarTimeDisplay.style.opacity === '0') {
                            this.dragBarTimeDisplay.style.display = 'none';
                        }
                    }, 300);
                }
            };
            
            const cancelDrag = () => {
                if (!dragState.isDragging) return;

                if (dragState.recoveryTimer) {
                    clearTimeout(dragState.recoveryTimer);
                }
                if (dragState.throttleTimer) {
                    clearTimeout(dragState.throttleTimer);
                    dragState.throttleTimer = null;
                }

                updateTimeDisplay(0);

                const videos = videoFinder.findAll();
                videos.forEach(video => {
                    if (dragState.originalPointerEvents.has(video)) {
                        video.style.pointerEvents = dragState.originalPointerEvents.get(video);
                    }
                });

                dragState.originalPointerEvents = new Map();
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                document.body.style.userSelect = '';
                videoUIFlags.isUIBeingUsed = false;
            };

            const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

            const handleStart = (e) => {
                // speedSlider 사용 중이거나 최소화 상태일 경우 dragBar 기능 비활성화
                if(videoUIFlags.isUIBeingUsed || speedSlider.isMinimized) return;

                if (e.button === 2) return;
                if (e.touches && e.touches.length > 1) {
                    return;
                }
                if (e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;

                const videos = videoFinder.findAll();
                if (videos.length === 0 || videos.every(v => v.paused)) {
                    videoUIFlags.isUIBeingUsed = false;
                    return;
                }

                if (!isMobile) {
                    e.preventDefault();
                }

                videoUIFlags.isUIBeingUsed = true;
                dragState.isDragging = true;
                dragState.isHorizontalDrag = false;
                const pos = getPosition(e);
                dragState.startX = pos.clientX;
                dragState.startY = pos.clientY;
                dragState.lastUpdateX = pos.clientX;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;

                dragState.recoveryTimer = setTimeout(cancelDrag, 5000);
            };

            const applyTimeChange = () => {
                const videos = videoFinder.findAll();
                const timeToApply = Math.round(dragState.currentDragDistanceX / 2);

                if (timeToApply !== 0) {
                    videos.forEach(video => {
                        if (video && video.duration && isFinite(video.duration)) {
                            const newTime = Math.min(video.duration, Math.max(0, video.currentTime + timeToApply));
                            video.currentTime = newTime;

                            setTimeout(() => {
                                if (Math.abs(video.currentTime - newTime) > 0.3) {
                                    video.currentTime = newTime;
                                }
                            }, 100);
                        }
                    });
                    dragState.currentDragDistanceX = 0;
                    updateTimeDisplay(dragState.totalTimeChange);
                }
            };

            const handleMove = (e) => {
                if (!dragState.isDragging) return;
                if (e.touches && e.touches.length > 1) {
                    cancelDrag();
                    return;
                }

                const videos = videoFinder.findAll();
                if (videos.length === 0) {
                    cancelDrag();
                    return;
                }

                const pos = getPosition(e);
                const currentX = pos.clientX;
                const currentY = pos.clientY;
                const dx = Math.abs(currentX - dragState.startX);
                const dy = Math.abs(currentY - dragState.startY);

                if (!dragState.isHorizontalDrag) {
                    if (dx > 10 && dy < dx * 1.5) {
                        dragState.isHorizontalDrag = true;
                        if (isMobile) {
                           e.preventDefault();
                           e.stopImmediatePropagation();
                        }
                        document.body.style.userSelect = 'none';
                        videos.forEach(video => {
                            dragState.originalPointerEvents.set(video, video.style.pointerEvents);
                            video.style.pointerEvents = 'none';
                        });
                    } else if (dy > 10) {
                        cancelDrag();
                        return;
                    }
                }

                if (dragState.isHorizontalDrag) {
                    e.preventDefault();
                    e.stopImmediatePropagation();

                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    dragState.totalTimeChange = Math.round( (currentX - dragState.startX) / 2 );

                    updateTimeDisplay(dragState.totalTimeChange);

                    const now = Date.now();
                    const timeSinceLastUpdate = now - dragState.lastDragTimestamp;

                    if (timeSinceLastUpdate > 50) {
                        const dragSpeed = Math.abs(currentX - dragState.lastUpdateX) / timeSinceLastUpdate;
                        dragState.throttleDelay = dragSpeed > 1 ? 150 : 80;
                    }
                    dragState.lastDragTimestamp = now;

                    if (dragState.throttleTimer === null) {
                        dragState.throttleTimer = setTimeout(() => {
                            applyTimeChange();
                            dragState.throttleTimer = null;
                        }, dragState.throttleDelay);
                    }
                    dragState.lastUpdateX = currentX;
                }
            };

            const handleEnd = (e) => {
                if (!dragState.isDragging) return;
                cancelDrag();
            };

            document.addEventListener('mousedown', handleStart, { passive: false, capture: true });
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('mouseout', (e) => {
                if (e.relatedTarget === null) {
                    handleEnd();
                }
            }, { passive: false, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchcancel', handleEnd, { passive: false, capture: true });

            let cancelTimeout;
            const delayedCancelDrag = () => {
              if (dragState.dragging) {
                cancelTimeout = setTimeout(() => {
                  if (dragState.dragging) cancelDrag();
                }, 300);
              }
            };
            window.addEventListener('visibilitychange', () => {
              if (document.hidden) delayedCancelDrag();
              else clearTimeout(cancelTimeout);
            });
            window.addEventListener('blur', delayedCancelDrag);
            window.addEventListener('focus', () => clearTimeout(cancelTimeout));

            this.dragBarTimeDisplay = this.createTimeDisplay();
            this.initialized = true;
        }
    };

    function throttle(func, limit) {
      let inThrottle;
      return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
          func.apply(context, args);
          inThrottle = true;
          setTimeout(() => inThrottle = false, limit);
        }
      };
    }

    // --- 핸들러 테이블 기반 노드 처리 로직 ---
    const handlers = [
        {
            match: (node) => node.tagName === 'IFRAME',
            action: (node, trigger) => iframeBlocker.init(node, trigger)
        },
        {
            match: (node) => node.tagName === 'VIDEO',
            action: (node) => {
                // 비디오 UI는 startVideoUIWatcher에서 통합 관리
            }
        },
        {
            match: (node) => node.nodeType === 1,
            action: (node) => layerTrap.check(node)
        }
    ];

    function processNodeAndChildren(node, trigger) {
        if (!node || PROCESSED_NODES.has(node)) return;
        PROCESSED_NODES.add(node);

        for (const handler of handlers) {
            if (handler.match(node)) {
                try {
                    handler.action(node, trigger);
                } catch (e) {
                }
            }
        }

        if (node.children) {
            for (const child of node.children) {
                processNodeAndChildren(child, trigger);
            }
        }
    }
    
    // --- iframe 로드 및 내부 탐색 처리 ---
    function handleIframeLoad(iframe) {
        if (PROCESSED_IFRAMES.has(iframe)) return;
        PROCESSED_IFRAMES.add(iframe);

        const iframeSrc = iframe.src || iframe.getAttribute('data-lazy-src') || 'about:blank';
        if (IGNORED_IFRAME_PATTERNS.some(p => p.test(iframeSrc))) {
            return;
        }

        try {
            // 동일 출처(Same-Origin)인 경우에만 iframe 내부 문서에 접근
            if (iframe.contentWindow && iframe.contentWindow.location.hostname === location.hostname) {
                const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDocument && !PROCESSED_DOCUMENTS.has(iframeDocument)) {
                    addLogOnce('iframe_load_detected', `ℹ️ iframe 로드 감지, 내부 스크립트 실행 시작 | 현재: ${window.location.href} | 대상: ${iframeSrc}`, 0, 'info');
                    initializeAll(iframeDocument);
                }
            } else {
                addLogOnce('iframe_load_cross_origin', `⚠️ Cross-Origin iframe 접근 시도됨 | 대상: ${iframeSrc}`, 5000, 'warn');
            }
        } catch (e) {
            const logKey = `iframe_access_fail_${iframeSrc}`.substring(0, 50);
            addLogOnce(logKey, `⚠️ Cross-Origin iframe 접근 실패: ${iframeSrc}`, 0, 'warn');
        }
    }

    // --- 통합 MutationObserver 로직 (중첩 iframe 재귀 탐색 강화) ---
    function startUnifiedObserver(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) {
            addLogOnce('observer_reinit_prevented', '✅ 초기화 재실행 방지', 'info');
            return;
        }

        const rootElement = targetDocument.documentElement || targetDocument.body;
        if (!rootElement) {
            addLogOnce('observer_activation_failed', `⚠️ 통합 감시자 활성화 실패 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 'warn');
            return;
        }

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processNodeAndChildren(node, '동적 추가'));
                } else if (mutation.type === 'attributes') {
                    const targetNode = mutation.target;
                    if (targetNode.nodeType === 1) {
                        if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                            PROCESSED_IFRAMES.delete(targetNode);
                            iframeBlocker.init(targetNode, 'iframe src 변경');
                        }
                        if (targetNode.tagName === 'VIDEO' && mutation.attributeName === 'style') {
                             // do something
                        }
                        layerTrap.check(targetNode);
                    }
                }
            });
        });

        try {
            // 성능 최적화를 위해 style, class 변경 감지는 제외
            observer.observe(rootElement, { 
                childList: true, 
                subtree: true, 
                attributes: true, 
                attributeFilter: ['src', 'onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'] 
            });
            PROCESSED_DOCUMENTS.add(targetDocument);
            OBSERVER_MAP.set(targetDocument, observer);
            addLogOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 'info');
        } catch(e) {
            addLogOnce('observer_observe_failed', `⚠️ 감시자 연결 실패: ${e.message}`, 'warn');
            return;
        }

        try {
            targetDocument.querySelectorAll('iframe').forEach(handleIframeLoad);
        } catch(e) {
            const iframeUrl = targetDocument.URL || 'null';
            const logKey = `recursive_iframe_scan_fail_${iframeUrl}`;
            addLogOnce(logKey, `⚠️ iframe 재귀 탐색 실패 (Cross-Origin): ${iframeUrl}`, 'warn');
        }
    }
    
    // --- 비디오 UI 감지 및 토글을 위한 통합 루프 ---
    function startVideoUIWatcher(targetDocument = document) {
        if (!FeatureFlags.videoControls) return;
        
        const checkVideos = () => {
            const videos = videoFinder.findAll();
            let isAnyVideoAvailable = false;

            videos.forEach(video => {
                if (video.readyState >= 1 || (video.clientWidth > 0 && video.clientHeight > 0)) {
                    isAnyVideoAvailable = true;
                }
            });

            if (isAnyVideoAvailable) {
                if (!__videoUIInitialized) {
                    __videoUIInitialized = true;
                    speedSlider.init();
                    dragBar.init();
                    addLogOnce('video_ui_init_success', '✅ 비디오 UI 감지 및 초기화 완료', 'info');
                }
                speedSlider.show();
                // 배속바가 최소화 상태가 아닐 때만 드래그바 표시
                if (!speedSlider.isMinimized) {
                    dragBar.show();
                } else {
                    dragBar.hide();
                }
            } else {
                speedSlider.hide();
                dragBar.hide();
                __videoUIInitialized = false;
            }
        };

        const throttledCheck = throttle(checkVideos, 1000);
        setInterval(throttledCheck, 1500);
        addLogOnce('video_watcher_started', '✅ 비디오 감시 루프 시작', 'info');
    }

    // --- 범용 SPA 감지 로직 ---
    let lastURL = location.href;
    let spaNavigationTimer = null;

    function onNavigate(reason = 'URL 변경 감지') {
        const url = location.href;
        if (url !== lastURL) {
            if (spaNavigationTimer) {
                clearTimeout(spaNavigationTimer);
            }
            spaNavigationTimer = setTimeout(() => {
                lastURL = url;
                addLogOnce(`spa_navigate_${Date.now()}`, `🔄 ${reason} | URL: ${url}`, 'info');

                PROCESSED_DOCUMENTS = new WeakSet();
                PROCESSED_NODES = new WeakSet();
                PROCESSED_IFRAMES = new WeakSet();
                PROCESSED_VIDEOS = new WeakSet();
                LOGGED_KEYS_WITH_TIMER.clear();
                __videoUIInitialized = false;
                
                OBSERVER_MAP.forEach(observer => observer.disconnect());

                initializeAll(document);
            }, 1000);
        }
    }

    ['pushState', 'replaceState'].forEach(type => {
        const orig = history[type];
        history[type] = function (...args) {
            orig.apply(this, args);
            onNavigate(`history.${type}`);
        };
    });

    window.addEventListener('popstate', () => onNavigate('popstate'));
    
    // --- 드래그바 시간 표시가 전체 화면에서 보이지 않는 문제 해결 ---
    const handleFullscreenChange = () => {
        const fsElement = document.fullscreenElement;

        const updateParent = (element) => {
            if (!element) return;
            const targetParent = fsElement || document.body;
            if (element.parentNode !== targetParent) {
                 if (element.parentNode) {
                    element.parentNode.removeChild(element);
                }
                targetParent.appendChild(element);
            }
        };

        if (speedSliderContainer) updateParent(speedSliderContainer);
        if (dragBarTimeDisplay) updateParent(dragBarTimeDisplay);

        if (!fsElement) {
            const forceReflow = () => {
                document.body.style.transform = 'scale(1)';
                document.body.offsetWidth;
                document.body.style.transform = '';
            };
            setTimeout(forceReflow, 100);
            window.dispatchEvent(new Event('resize'));
        }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // --- 단일 초기 실행 함수 ---
    function initializeAll(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) {
            addLogOnce('reinit_prevented', '✅ 초기화 재실행 방지', 'info');
            return;
        }

        PROCESSED_DOCUMENTS.add(targetDocument);
        addLogOnce('script_init_start', `🎉 스크립트 초기화 시작 | 문서: ${targetDocument === document ? '메인' : targetDocument.URL}`, 'info');
        
        if (targetDocument === document) {
            popupBlocker.init();
        }
        
        if (FeatureFlags.videoControls) {
            videoFinder.findAll(targetDocument).forEach(video => {
                if (!PROCESSED_VIDEOS.has(video)) {
                    videoControls.initWhenReady(video);
                }
            });
        }
        
        targetDocument.querySelectorAll('iframe').forEach(handleIframeLoad);

        startUnifiedObserver(targetDocument);
        startVideoUIWatcher(targetDocument);
    }
    
    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            createLogBox();
            initializeAll(document);
        });
    } else {
        createLogBox();
        initializeAll(document);
    }

    // --- utility functions ---
    const getFakeWindow = () => ({
        focus: () => {}, opener: null, closed: false, blur: () => {}, close: () => {},
        location: { href: "", assign: () => {}, replace: () => {}, reload: () => {}, toString: () => "", valueOf: () => "" },
        alert: () => {}, confirm: () => {}, prompt: () => {}, postMessage: () => {},
        document: { write: () => {}, writeln: () => {} },
    });
    
})();
