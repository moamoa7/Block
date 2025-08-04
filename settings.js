// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https.com/
// @version       6.2.90 (최적화 및 안정성 강화)
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
        '8dk5q9tp.xyz', 's.amazon-adsystem.com',
    ];

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
    const PROCESSED_NODES = new WeakSet();
    const PROCESSED_IFRAMES = new WeakSet();
    const PROCESSED_DOCUMENTS = new WeakSet();
    const PROCESSED_VIDEOS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const LOGGED_KEYS_WITH_TIMER = new Map();
    const BLOCKED_IFRAME_URLS = new Set();
    let dragBarTimeDisplay = null;
    let speedSliderContainer = null;
    let isInitialLoadFinished = false;

    // --- 공통 변수 ---
    let logBoxRef = null;
    let isLogBoxReady = false;
    let logBoxContainer = null;
    let logContentBox = null;
    let pendingLogs = [];
    let logDismissTimer = null;
    const logHistory = [];

    // 비디오 UI 관련 상태
    const videoUIFlags = {
        speedSliderInitialized: false,
        dragBarInitialized: false,
        isUIBeingUsed: false,
        playbackUpdateTimer: null,
    };
    window.__videoUIInitialized = false;

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
            addLogOnce('init_popup_blocker', '팝업 차단 로직 초기화', 'allow');
            const originalWindowOpen = window.open;
            let userInitiatedAction = false;
            const setUserInitiatedAction = () => {
                userInitiatedAction = true;
                setTimeout(() => { userInitiatedAction = false; }, 500);
            };
            document.addEventListener('click', setUserInitiatedAction, true);
            document.addEventListener('mousedown', setUserInitiatedAction, true);
            document.addEventListener('keydown', setUserInitiatedAction, true);
            const blockOpen = (...args) => {
                const url = args[0] || '(no URL)';
                const logMsg = `window.open 차단 시도 | 현재: ${window.location.href} | 대상: ${url}`;
                addLogOnce('window_open_attempt', logMsg, 'block');
                const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
                if (isForceBlocked) {
                    const forceLogMsg = `강제 차단 패턴에 의해 팝업 차단됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('force_block_popup', forceLogMsg, 'block');
                    return getFakeWindow();
                }
                const currentTime = Date.now();
                const timeSinceVisibilityChange = currentTime - lastVisibilityChangeTime;
                const timeSinceBlur = currentTime - lastBlurTime;
                if (lastVisibilityChangeTime > 0 && timeSinceVisibilityChange < 1000) {
                    const susLogMsg = `탭 비활성화 후 ${timeSinceVisibilityChange}ms 만에 window.open 호출 의심됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('suspicious_visibility_open', susLogMsg, 'warn');
                    console.warn(susLogMsg);
                }
                if (lastBlurTime > 0 && timeSinceBlur < 1000) {
                    const susLogMsg = `탭 블러 후 ${timeSinceBlur}ms 만에 window.open 호출 의심됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('suspicious_blur_open', susLogMsg, 'warn');
                    console.warn(susLogMsg);
                }
                if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                    const allowLogMsg = `사용자 상호작용 감지, window.open 허용 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('user_allowed_open', allowLogMsg, 'allow');
                    const features = (args[2] || '') + ',noopener,noreferrer';
                    return originalWindowOpen.apply(window, [args[0], args[1], features]);
                }
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
                    addLogOnce('window_opener_blocked', 'window.opener 속성 차단됨', 'allow');
                } catch (e) {
                    addLogOnce('window_opener_block_fail', `window.opener 속성 차단 실패: ${e.message}`, 'warn');
                }
            }
            let originalHostnameOnLoad = hostname;
            document.addEventListener('DOMContentLoaded', () => {
                originalHostnameOnLoad = window.location.hostname;
                if (window.name && window.name.length > 0) {
                    addLogOnce('initial_window_name_detected', `초기 window.name 감지됨: ${window.name.substring(0, 50)}...`, 'info');
                    window.name = '';
                    addLogOnce('initial_window_name_reset', '초기 window.name 초기화됨', 'allow');
                }
            });
            const originalPushState = history.pushState;
            history.pushState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            addLogOnce('pushstate_domain_change', `pushState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`, 'info');
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
                            addLogOnce('replacestate_domain_change', `replaceState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`, 'info');
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
                    const logMsg = `자동 다운로드 차단됨 | 현재: ${window.location.href} | 대상: ${a.href}`;
                    addLogOnce('auto_download_blocked', logMsg, 'block');
                }
            }, true);
            window.addEventListener('keydown', e => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 's' || e.key === 'p' || e.key === 'u' || (e.shiftKey && e.key === 'I')) {
                        const logMsg = `단축키 (${e.key}) 차단됨 | 현재: ${window.location.href}`;
                        addLogOnce('hotkey_blocked', logMsg, 'block');
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                }
            }, true);
            window.addEventListener('message', e => {
                const isIgnoredDomain = POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => e.origin.includes(domain));
                if (isIgnoredDomain) return;

                const msgData = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
                if (POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => msgData.includes(pattern))) {
                    return;
                }
                const logKey = `postmessage_log_${e.origin}`;
                addLogOnce(logKey, `postMessage 의심 감지됨 | 현재: ${window.location.href} | 참조: ${e.origin} | 데이터: ${msgData.substring(0, 100)}...`, 'warn');
            }, false);
            if (!isFeatureAllowed('fullscreen')) {
                try {
                    const originalRequestFullscreen = Document.prototype.requestFullscreen;
                    if (originalRequestFullscreen) {
                        Document.prototype.requestFullscreen = new Proxy(originalRequestFullscreen, {
                            apply(target, thisArg, argumentsList) {
                                addLogOnce('auto_fullscreen_blocked', `자동 전체화면 차단 | 현재: ${window.location.href}`, 'block');
                                return Promise.reject('Blocked fullscreen request');
                            }
                        });
                    }
                } catch (e) {
                    // 로그 출력 제거
                }
            }
            if (!isFeatureAllowed('location')) {
                try {
                    Object.defineProperty(window, 'location', {
                        configurable: false,
                        enumerable: true,
                        get: () => location,
                        set: (val) => {
                            const logMsg = `location 이동 차단 시도됨 | 현재: ${window.location.href} | 대상: ${val}`;
                            addLogOnce('location_change_blocked', logMsg, 'block');
                            console.warn(logMsg);
                        }
                    });
                } catch (e) {
                    // 로그 출력 제거
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
                addLogOnce('iframe_logic_skip', `iframe 차단 로직 건너옴 (설정 또는 예외 목록): ${hostname}`, 'info');
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

            if (fullSrc.startsWith('blob:') || fullSrc.startsWith('javascript:')) {
                try { node.remove(); } catch {}
                const logMsg = `의심 iframe 제거됨 (스킴 차단) | 현재: ${window.location.href} | 대상: ${fullSrc}`;
                addLogOnce(`blocked_suspicious_src_${logKeyBase}`, logMsg, 'block');
                return;
            }

            const isForcedBlocked = IFRAME_FORCE_BLOCK_PATTERNS.some(pattern => {
                return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
            });

            if (isForcedBlocked) {
                const logMsg = `iframe 강제 차단됨 (패턴 일치) [id: "${iframeId}", class: "${iframeClasses}"] | 현재: ${window.location.href} | 대상: ${fullSrc}`;
                addLogOnce(`force_blocked_iframe_${logKeyBase}`, logMsg, 'block');
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }

            const logMsg = `iframe 감지됨 (${trigger}) [id: "${iframeId}", class: "${iframeClasses}"] | 현재: ${window.location.href} | 대상: ${fullSrc}`;
            addLogOnce(`iframe_detected_${logKeyBase}`, logMsg, 'block');

            if (!node.hasAttribute('sandbox')) {
                try {
                    node.setAttribute('sandbox', USER_SETTINGS.defaultIframeSandbox);
                    addLogOnce('sandbox_added', `iframe sandbox 속성 자동 추가 | 대상: ${node.src}`, 'allow');
                } catch(e) {
                    addLogOnce(`sandbox_add_fail_${logKeyBase}`, `sandbox 추가 실패: ${e.message}`, 'warn');
                }
            }

            if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
                const b64LogMsg = `Base64 인코딩된 iframe 차단됨 | 현재: ${window.location.href} | 대상: ${node.src.substring(0, 100)}...`;
                addLogOnce(`base64_iframe_blocked_${logKeyBase}`, b64LogMsg, 'block');
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }
            const allowMsg = `iframe 허용됨 (다른 확장 프로그램에 의한 차단 확인 필요) | 현재: ${window.location.href} | 대상: ${fullSrc}`;
            addLogOnce(`iframe_allowed_${logKeyBase}`, allowMsg, 'allow');
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
                                   (parseFloat(style.opacity) < 0.2 || style.visibility === 'hidden' || style.display === 'none') &&
                                   style.pointerEvents !== 'none');

                const suspiciousHandlers = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'];
                const hasSuspiciousHandler = suspiciousHandlers.some(handler => node.hasAttribute(handler));

                if (isSuspect && hasSuspiciousHandler) {
                    node.style.setProperty('display', 'none', 'important');
                    node.setAttribute('data-popupblocker-status', 'removed');

                    const logMsg = `레이어 클릭 덫 의심 감지 및 제거 | 현재: ${window.location.href} | 요소: ${node.outerHTML.substring(0, 50)}...`;
                    addLogOnce('layer_trap_detected', logMsg, 'block');

                    node.addEventListener('click', e => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        addLogOnce('hidden_layer_click_blocked', `숨겨진 레이어 클릭 차단됨 | 현재: ${window.location.href}`, 'block');
                    }, true);
                }
            } catch(e) {
                addLogOnce('layer_trap_check_error', `레이어 트랩 체크 오류: ${e.message}`, 'warn');
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
                 // iframe 내부 접근 실패 로그는 handleIframeLoad에서 처리
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
                        addLogOnce(`video_pointer_event_restore_${videoSource}`, `비디오 포인터 이벤트 복구 | 현재: ${window.location.href} | 대상: ${videoSource}`, 'allow');
                    }
                    if (USER_SETTINGS.enableVideoDebugBorder && !video.classList.contains('my-video-ui-initialized')) {
                        video.classList.add('my-video-ui-initialized');
                        addLogOnce(`video_debug_border_added_${videoSource}`, `비디오 요소에 빨간 테두리 추가됨 | 현재: ${window.location.href} | 대상: ${video.tagName}`, 'info');
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
                    const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDocument) {
                        videos.push(...videoFinder.findInDoc(iframeDocument));
                    }
                } catch (e) {
                    // iframe 접근 실패 로그를 완전히 제거
                }
            });
            return videos;
        }
    };

    // --- 비디오 UI 통합 초기화 함수 ---
    const videoControls = {
        init: () => {
            if (!FeatureFlags.videoControls) return;
            if (!videoUIFlags.speedSliderInitialized) {
                speedSlider.init();
            }
            if (!videoUIFlags.dragBarInitialized) {
                dragBar.init();
            }
        },
        initWhenReady: (video) => {
            if (PROCESSED_VIDEOS.has(video) || !FeatureFlags.videoControls) return;

            const initLogic = () => {
                videoControls.init();
                video.removeEventListener('canplay', initLogic);
            };

            video.addEventListener('canplay', initLogic, { once: true });
        }
    };

    // --- 배속 슬라이더 로직 ---
    const speedSlider = {
        speedSliderContainer: null,
        init: function() {
            if (videoUIFlags.speedSliderInitialized) return;

            const sliderId = 'vm-speed-slider-container';
            const createSliderElements = () => {
                const container = document.createElement('div');
                container.id = sliderId;
                const style = document.createElement('style');
                style.textContent = `
                    #${sliderId} {
                        position: fixed; top: 50%; right: 0; transform: translateY(-50%);
                        background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px 0 0 8px;
                        z-index: 2147483647 !important; display: none; flex-direction: column;
                        align-items: center; width: 50px; height: auto; font-family: sans-serif;
                        pointer-events: auto; opacity: 0.3; transition: opacity 0.3s; user-select: none;
                        box-shadow: 0 0 0px rgba(0,0,0,0.0); will-change: transform, opacity;
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

                slider.addEventListener('input', () => speedSlider.onSliderChange(slider.value));
                slider.addEventListener('change', () => speedSlider.updateSpeed(parseFloat(slider.value || '1.0')));
                resetBtn.addEventListener('click', () => {
                    slider.value = '1.0'; speedSlider.onSliderChange('1.0');
                });
                container.addEventListener('mousedown', () => videoUIFlags.isUIBeingUsed = true, true);
                container.addEventListener('mouseup', () => videoUIFlags.isUIBeingUsed = false, true);
                container.addEventListener('touchstart', () => videoUIFlags.isUIBeingUsed = true, true);
                container.addEventListener('touchend', () => videoUIFlags.isUIBeingUsed = false, true);
                container.appendChild(resetBtn);
                container.appendChild(slider);
                container.appendChild(valueDisplay);
                speedSliderContainer = container; // 변수에 할당
            };
            createSliderElements(); // 요소 생성
            videoUIFlags.speedSliderInitialized = true;
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
            if (!speedSliderContainer) {
                this.init();
            }
            if (!speedSliderContainer.parentNode) {
                document.body.appendChild(speedSliderContainer);
            }

            const targetParent = document.fullscreenElement || document.body;
            if (speedSliderContainer.parentNode !== targetParent) {
                speedSliderContainer.parentNode.removeChild(speedSliderContainer);
                targetParent.appendChild(speedSliderContainer);
            }

            speedSliderContainer.style.display = 'flex';
            this.updatePositionAndSize();
            const slider = document.getElementById('vm-speed-slider');
            this.updateSpeed(slider.value || '1.0');
        },
        hide: function() {
            if (speedSliderContainer) { speedSliderContainer.style.display = 'none'; }
        },
        updatePositionAndSize: function() {
            const video = document.querySelector('video');
            const sliderContainer = speedSliderContainer;
            const slider = document.getElementById('vm-speed-slider');

            if (!video || !sliderContainer || !slider) return;

            sliderContainer.style.position = 'fixed';
            sliderContainer.style.top = '50%';
            sliderContainer.style.right = '0';
            sliderContainer.style.transform = 'translateY(-50%)';

            let newHeight;
            if (isMobile) {
                newHeight = 100;
            } else {
                const minHeight = 100;
                const maxHeight = 300;
                const rect = video.getBoundingClientRect();
                newHeight = rect.height * 0.8;
                newHeight = Math.min(maxHeight, Math.max(minHeight, newHeight));
            }
            slider.style.height = `${newHeight}px`;

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
            return newTimeDisplay;
        },
        show: function() {
            if (!this.dragBarTimeDisplay) {
                this.init();
            }
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
            if (videoUIFlags.dragBarInitialized) return;
            videoUIFlags.dragBarInitialized = true;
            addLogOnce('dragbar_init_success', '✅ 드래그바 기능 초기화 성공');

            const dragState = {
                isDragging: false,
                isHorizontalDrag: false,
                startX: 0,
                startY: 0,
                lastUpdateX: 0,
                currentDragDistanceX: 0,
                totalTimeChange: 0,
                originalPointerEvents: new Map(),
                throttleDelay: 100,
                lastDragTimestamp: Date.now(),
            };

            const DRAG_THRESHOLD = 10;
            const TIME_CHANGE_SENSITIVITY = 2;
            const VERTICAL_DRAG_THRESHOLD = 20;

            let throttleTimer = null;

            const updateTimeDisplay = (timeChange) => {
                if (!dragBarTimeDisplay) {
                    dragBarTimeDisplay = dragBar.createTimeDisplay();
                    const parent = document.fullscreenElement || document.body;
                    parent.appendChild(dragBarTimeDisplay);
                }

                if (timeChange !== 0) {
                    const sign = timeChange > 0 ? '+' : '';
                    dragBarTimeDisplay.textContent = `${sign}${timeChange}초 이동`;
                    dragBarTimeDisplay.style.display = 'block';
                    dragBarTimeDisplay.style.opacity = '1';
                } else {
                    dragBarTimeDisplay.style.opacity = '0';
                    clearTimeout(dragBarTimeDisplay.timer);
                    dragBarTimeDisplay.timer = setTimeout(() => { dragBarTimeDisplay.style.display = 'none'; }, 300);
                }
            };

            const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

            const handleStart = (e) => {
                if (e.button === 2) return;
                // 모바일 핀치 투 줌(두 손가락 터치)일 경우 드래그 기능 중단
                if (e.touches && e.touches.length > 1) {
                    return;
                }
                if (e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;

                const videos = videoFinder.findAll();
                if (videos.length === 0 || videos.every(v => v.paused)) {
                    videoUIFlags.isUIBeingUsed = false;
                    return;
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
            };

            const applyTimeChange = () => {
                const videos = videoFinder.findAll();
                const timeToApply = Math.round(dragState.currentDragDistanceX / TIME_CHANGE_SENSITIVITY);

                if (timeToApply !== 0) {
                    videos.forEach(video => {
                        if (video.duration && !isNaN(video.duration)) {
                            video.currentTime += timeToApply;
                        }
                    });
                    dragState.currentDragDistanceX = 0;
                    updateTimeDisplay(dragState.totalTimeChange);
                }
            };

            const handleMove = (e) => {
                if (!dragState.isDragging) return;
                // 모바일 핀치 투 줌(두 손가락 터치)일 경우 드래그 기능 중단
                if (e.touches && e.touches.length > 1) {
                    handleEnd();
                    return;
                }

                const videos = videoFinder.findAll();
                if (videos.length === 0) {
                    handleEnd();
                    return;
                }

                const pos = getPosition(e);
                const currentX = pos.clientX;
                const currentY = pos.clientY;

                if (!dragState.isHorizontalDrag) {
                    const dragDistanceX = currentX - dragState.startX;
                    const dragDistanceY = currentY - dragState.startY;
                    const isHorizontalMovement = Math.abs(dragDistanceX) > Math.abs(dragDistanceY);
                    const isPastThreshold = Math.abs(dragDistanceX) > DRAG_THRESHOLD || (e.touches && e.touches.length > 1);

                    if (isPastThreshold && isHorizontalMovement) {
                        dragState.isHorizontalDrag = true;
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        document.body.style.userSelect = 'none';
                        videos.forEach(video => {
                            dragState.originalPointerEvents.set(video, video.style.pointerEvents);
                            video.style.pointerEvents = 'none';
                        });
                    } else if (Math.abs(dragDistanceY) > VERTICAL_DRAG_THRESHOLD) {
                        handleEnd();
                        return;
                    } else {
                        return;
                    }
                }

                if (dragState.isHorizontalDrag) {
                    e.preventDefault();
                    e.stopImmediatePropagation();

                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    dragState.totalTimeChange = Math.round( (currentX - dragState.startX) / TIME_CHANGE_SENSITIVITY );

                    updateTimeDisplay(dragState.totalTimeChange);

                    const now = Date.now();
                    const timeSinceLastUpdate = now - dragState.lastDragTimestamp;

                    if (timeSinceLastUpdate > 50) {
                        const dragSpeed = Math.abs(currentX - dragState.lastUpdateX) / timeSinceLastUpdate;
                        dragState.throttleDelay = dragSpeed > 1 ? 150 : 80;
                    }
                    dragState.lastDragTimestamp = now;

                    if (throttleTimer === null) {
                        throttleTimer = setTimeout(() => {
                            applyTimeChange();
                            throttleTimer = null;
                        }, dragState.throttleDelay);
                    }
                    dragState.lastUpdateX = currentX;
                }
            };

            const handleEnd = (e) => {
                if (!dragState.isDragging) return;

                if (throttleTimer) {
                    clearTimeout(throttleTimer);
                    throttleTimer = null;
                    applyTimeChange();
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

            document.addEventListener('mousedown', handleStart, { passive: true, capture: true });
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: true, capture: true });
            document.addEventListener('mouseout', (e) => {
                if (e.relatedTarget === null) {
                    handleEnd();
                }
            }, { passive: true, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: true, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: true, capture: true });
            document.addEventListener('touchcancel', handleEnd, { passive: true, capture: true });

            this.dragBarTimeDisplay = this.createTimeDisplay(); // 요소를 생성하여 변수에 할당
            videoUIFlags.dragBarInitialized = true;
        }
    };

    // throttle 함수 정의
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
                    addLogOnce(`handler_error_${handler.match.toString().substring(0, 20)}`, `핸들러 오류 발생: ${e.message}`, 'warn');
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

        const isUnsafeSrc = POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => iframeSrc.includes(pattern)) ||
                            iframeSrc.startsWith('javascript:');

        if (isUnsafeSrc) {
            return;
        }

        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument && !PROCESSED_DOCUMENTS.has(iframeDocument)) {
                const logMsg = `iframe 로드 감지, 내부 스크립트 실행 시작 | 현재: ${window.location.href} | 대상: ${iframeSrc}`;
                addLogOnce('iframe_load_detected', logMsg, 'info');
                safeInitializeAll(iframeDocument, 'iframe load');
            }
        } catch (e) {
            // iframe 접근 실패 로그를 완전히 제거
        }
    }

    // --- 통합 MutationObserver 로직 (중첩 iframe 재귀 탐색 강화) ---
    function startUnifiedObserver(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) {
            addLogOnce('observer_reinit_prevented', '감시자 초기화 재실행 방지', 'info');
            return;
        }

        const rootElement = targetDocument.documentElement || targetDocument.body;
        if (!rootElement) {
            addLogOnce('observer_activation_failed', `통합 감시자 활성화 실패 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 'warn');
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
                            processNodeAndChildren(targetNode, 'iframe src 변경');
                        }
                        processNodeAndChildren(targetNode, '속성 변경');
                    }
                }
            });
        });

        try {
            observer.observe(rootElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'] });
            PROCESSED_DOCUMENTS.add(targetDocument);
            OBSERVER_MAP.set(targetDocument, observer);
            addLogOnce('observer_active', `통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 'allow');
        } catch(e) {
            addLogOnce('observer_observe_failed', `감시자 연결 실패: ${e.message}`, 'warn');
            return;
        }

        try {
            targetDocument.querySelectorAll('iframe').forEach(iframe => {
                handleIframeLoad(iframe);
            });
        } catch(e) {
            // 재귀 탐색 실패 로그 제거
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
                if (!window.__videoUIInitialized) {
                    window.__videoUIInitialized = true;
                    videoControls.init();
                    addLogOnce('video_ui_init_success', '비디오 UI 감지 및 초기화 완료', 'allow');
                }
                speedSlider.show();
                dragBar.show();
            } else {
                speedSlider.hide();
                dragBar.hide();
            }
        };

        // 기존 setInterval + throttle 조합 대신, 더 안정적인 setInterval만 사용
        setInterval(checkVideos, 1500);
        addLogOnce('video_watcher_started', '비디오 감시 루프 시작', 'allow');
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
                addLogOnce(`spa_navigate_${Date.now()}`, `SPA 라우팅 감지 | URL: ${url}`, 'info');

                OBSERVER_MAP.forEach(observer => observer.disconnect());
                PROCESSED_DOCUMENTS.clear();
                PROCESSED_NODES.clear();
                PROCESSED_IFRAMES.clear();
                PROCESSED_VIDEOS.clear();
                LOGGED_KEYS_WITH_TIMER.clear();
                window.__videoUIInitialized = false;

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
    window.addEventListener('hashchange', () => onNavigate('hashchange'));

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
            addLogOnce('reinit_prevented', '초기화 재실행 방지', 'info');
            return;
        }

        addLogOnce('script_init_start', '스크립트 초기화 시작', 'info');

        if (targetDocument === document) {
            try {
                popupBlocker.init();
            } catch (e) {
                addLogOnce('error_popupBlocker_init', `popupBlocker 초기화 오류: ${e.message}`, 'warn');
            }
            isInitialLoadFinished = true;
        }

        try {
            startUnifiedObserver(targetDocument);
        } catch (e) {
            addLogOnce('error_startUnifiedObserver', `통합 옵저버 시작 오류: ${e.message}`, 'warn');
        }

        try {
            startVideoUIWatcher(targetDocument);
        } catch (e) {
            addLogOnce('error_startVideoUIWatcher', `비디오 UI 감시 시작 오류: ${e.message}`, 'warn');
        }
    }

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initializeAll(document));
    } else {
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
