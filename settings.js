// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https://example.com/
// @version       6.2.31 (최종 안정화)
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Speed Slider, PC/모바일 드래그바로 재생 시간 조절을 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화
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

    const isTopFrame = window.self === window.top;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isFeatureAllowed = (featureName) => {
        const exceptions = EXCEPTION_LIST[hostname] || [];
        return exceptions.includes(featureName);
    };

    // --- 로그 출력 제어용 함수 (중복 방지 로직 포함) ---
    function addLogOnce(key, message, delay = 5000) {
        if (!FeatureFlags.logUI) return;
        const currentTime = Date.now();
        const lastLogTime = LOGGED_KEYS_WITH_TIMER.get(key);

        if (!lastLogTime || currentTime - lastLogTime > delay) {
            LOGGED_KEYS_WITH_TIMER.set(key, currentTime);
            addLog(message);
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
            if (event.data && event.data.type === 'MY_SCRIPT_LOG') {
                addLog(event.data.message);
            }
        });
        createLogBox();
    }

    // --- 팝업/광고 차단기 로직 ---
    const popupBlocker = {
        init: () => {
            if (!FeatureFlags.popupBlocker) return;
            addLogOnce('init_popup_blocker', '✅ 팝업 차단 로직 초기화');
            const originalWindowOpen = window.open;
            let userInitiatedAction = false;
            const setUserInitiatedAction = () => {
                userInitiatedAction = true;
                setTimeout(() => { userInitiatedAction = false; }, 500);
            };
            document.addEventListener('click', setUserInitiatedAction, true);
            document.addEventListener('mousedown', setUserInitiatedAction, true);
            document.addEventListener('keydown', setUserInitiatedAction, true);
            const getFakeWindow = () => ({
                focus: () => {}, opener: null, closed: false, blur: () => {}, close: () => {},
                location: { href: "", assign: () => {}, replace: () => {}, reload: () => {}, toString: () => "", valueOf: () => "" },
                alert: () => {}, confirm: () => {}, prompt: () => {}, postMessage: () => {},
                document: { write: () => {}, writeln: () => {} },
            });
            let lastVisibilityChangeTime = 0;
            let lastBlurTime = 0;
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
                const logMsg = `🚫 window.open 차단 시도 | 현재: ${window.location.href} | 대상: ${url}`;
                addLogOnce('window_open_attempt', logMsg);
                const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
                if (isForceBlocked) {
                    const forceLogMsg = `🔥 강제 차단 패턴에 의해 팝업 차단됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('force_block_popup', forceLogMsg);
                    return getFakeWindow();
                }
                const currentTime = Date.now();
                const timeSinceVisibilityChange = currentTime - lastVisibilityChangeTime;
                const timeSinceBlur = currentTime - lastBlurTime;
                if (lastVisibilityChangeTime > 0 && timeSinceVisibilityChange < 1000) {
                    const susLogMsg = `👁️ 탭 비활성화 후 ${timeSinceVisibilityChange}ms 만에 window.open 호출 의심됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('suspicious_visibility_open', susLogMsg);
                    console.warn(susLogMsg);
                }
                if (lastBlurTime > 0 && timeSinceBlur < 1000) {
                    const susLogMsg = `👁️ 탭 블러 후 ${timeSinceBlur}ms 만에 window.open 호출 의심됨 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('suspicious_blur_open', susLogMsg);
                    console.warn(susLogMsg);
                }
                if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                    const allowLogMsg = `✅ 사용자 상호작용 감지, window.open 허용 | 현재: ${window.location.href} | 대상: ${url}`;
                    addLogOnce('user_allowed_open', allowLogMsg);
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
                    addLogOnce('window_open_redefine_fail', `⚠️ window.open 재정의 실패: ${e.message}`);
                }
            }
            if (!isFeatureAllowed('opener')) {
                try {
                    Object.defineProperty(window, 'opener', {
                        get() { return null; },
                        set() {},
                        configurable: false
                    });
                    addLogOnce('window_opener_blocked', '✅ window.opener 속성 차단됨');
                } catch (e) {
                    addLogOnce('window_opener_block_fail', `⚠️ window.opener 속성 차단 실패: ${e.message}`);
                }
            }
            let originalHostnameOnLoad = hostname;
            document.addEventListener('DOMContentLoaded', () => {
                originalHostnameOnLoad = window.location.hostname;
                if (window.name && window.name.length > 0) {
                    addLogOnce('initial_window_name_detected', `ℹ️ 초기 window.name 감지됨: ${window.name.substring(0, 50)}...`);
                    window.name = '';
                    addLogOnce('initial_window_name_reset', '✅ 초기 window.name 초기화됨');
                }
            });
            const originalPushState = history.pushState;
            history.pushState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            addLogOnce('pushstate_domain_change', `ℹ️ pushState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`);
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
                            addLogOnce('replacestate_domain_change', `ℹ️ replaceState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`);
                            window.name = '';
                        }
                    } catch (e) { /* URL 파싱 오류 무시 */ }
                }
                return originalReplaceState.apply(this, args);
            };
            document.addEventListener('click', function (e) {
                const a = e.target.closest('a');
                if (a && a.href && a.href.startsWith("javascript:") && a.href.includes('window.open')) {
                    const logMsg = `🚫 javascript 링크 (window.open) 차단됨 | 현재: ${window.location.href} | 대상: ${a.href}`;
                    addLogOnce('js_link_open_blocked', logMsg);
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }, true);
            const monitorSuspiciousOpenCall = (e) => {
                try {
                    const stack = new Error().stack;
                    if (stack && stack.includes('open') && (stack.includes('click') || stack.includes('mousedown'))) {
                        const logMsg = `🕷️ 이벤트 기반 window.open 의심 감지: ${e.type} 이벤트 | 현재: ${window.location.href}`;
                        addLogOnce('suspicious_event_open', logMsg);
                        console.warn(logMsg, stack);
                    }
                } catch (err) { /* 스택 접근 실패 시 무시 */ }
                };
            document.addEventListener('click', monitorSuspiciousOpenCall, true);
            document.addEventListener('mousedown', monitorSuspiciousOpenCall, true);
            document.addEventListener('mousedown', function (e) {
                if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
                    const a = e.target.closest('a');
                    if (a?.target === '_blank' && !isFeatureAllowed('windowOpen')) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        blockOpen(a.href, '_blank');
                    }
                }
            }, true);
            const origCreateElement = Document.prototype.createElement;
            Document.prototype.createElement = function (tag, ...args) {
                const el = origCreateElement.call(this, tag, ...args);
                if (tag.toLowerCase() === 'a') {
                    const origSetAttr = el.setAttribute;
                    el.setAttribute = function (name, value) {
                        if (name === 'target' && ['_blank', '_new'].includes(value) && !isFeatureAllowed('windowOpen')) {
                            if (el.href && el.href.includes('twitter.com')) { return origSetAttr.call(this, name, value); }
                            const logMsg = `🚫 동적 링크 target="_blank" 설정 차단됨 | 현재: ${window.location.href} | 대상: ${el.href || el.outerHTML}`;
                            addLogOnce('dynamic_target_blank_blocked', logMsg);
                            return;
                        }
                        return origSetAttr.call(this, name, value);
                    };
                }
                return el;
            };
            const originalClick = HTMLElement.prototype.click;
            HTMLElement.prototype.click = function () {
                if (this.tagName === 'A' && (!this.href || this.href.startsWith('javascript:'))) {
                    const logMsg = `🚫 JS로 만든 링크 click() 탐지 및 차단됨 | 현재: ${window.location.href} | 대상: ${this.href}`;
                    addLogOnce('js_click_link_blocked', logMsg);
                    return;
                }
                return originalClick.call(this);
            };
            const origAttachShadow = Element.prototype.attachShadow;
            if (origAttachShadow) {
                const processedShadowRoots = new WeakSet();
                Element.prototype.attachShadow = function(init) {
                    const shadowRoot = origAttachShadow.call(this, init);
                    if (!processedShadowRoots.has(shadowRoot)) {
                        startUnifiedObserver(shadowRoot);
                        processedShadowRoots.add(shadowRoot);
                    }
                    const origAddEventListener = shadowRoot.addEventListener;
                    shadowRoot.addEventListener = function(type, listener, options) {
                        if (type === 'click') {
                            addLogOnce('shadow_dom_click_listener_detected', `🚨 Shadow DOM 내 클릭 리스너 감지됨 | 현재: ${window.location.href}`);
                            console.warn(`🚨 Shadow DOM 내 클릭 리스너 감지됨 | 현재: ${window.location.href}`, this, type, listener);
                        }
                        return origAddEventListener.call(this, type, listener, options);
                    };
                    return shadowRoot;
                };
            }
            document.addEventListener('click', e => {
                const el = e.target;
                if (!(el instanceof HTMLElement)) return;
                const style = getComputedStyle(el);
                const isHiddenByStyle = (parseFloat(style.opacity) === 0 || style.visibility === 'hidden');
                const isZeroSize = (el.offsetWidth === 0 && el.offsetHeight === 0);
                const rect = el.getBoundingClientRect();
                const isOffscreen = (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight);
                if ((isHiddenByStyle || isZeroSize || isOffscreen) && el.hasAttribute('onclick')) {
                    const logMsg = `🕳️ 의심 클릭 영역 감지됨: ${el.tagName} (${isHiddenByStyle ? '숨김' : ''}${isZeroSize ? '0크기' : ''}${isOffscreen ? '오프스크린' : ''}) | 현재: ${window.location.href}`;
                    addLogOnce('suspicious_hidden_click_area', logMsg);
                    console.warn(logMsg, el);
                }
            }, true);
            const originalExecCommand = Document.prototype.execCommand;
            Document.prototype.execCommand = function(commandId, showUI, value) {
                if (commandId === 'copy') {
                    addLogOnce('exec_command_copy_detected', `📋 document.execCommand('copy') 호출 감지됨 | 현재: ${window.location.href}`);
                    console.warn(`📋 document.execCommand("copy") 호출됨 | 현재: ${window.location.href}`, commandId, showUI, value);
                }
                return originalExecCommand.call(this, commandId, showUI, value);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                const originalWriteText = navigator.clipboard.writeText;
                navigator.clipboard.writeText = async function(data) {
                    addLogOnce('clipboard_writetext_detected', `📋 navigator.clipboard.writeText() 호출 감지됨: ${String(data).slice(0, 50)}... | 현재: ${window.location.href}`);
                    console.warn(`📋 navigator.clipboard.writeText() 호출됨 | 현재: ${window.location.href}`, data);
                    return originalWriteText.call(this, data);
                };
            }
            const originalFocus = window.focus;
            window.focus = function () {
                addLogOnce('window_focus_blocked', `🚫 window.focus() 호출 차단됨 | 현재: ${window.location.href}`);
            };
            const originalBlur = window.blur;
            window.blur = function () {
                addLogOnce('window_blur_detected', `⚠️ window.blur() 호출 감지됨 | 현재: ${window.location.href}`);
                return originalBlur.apply(this, arguments);
            };
            const originalScrollIntoView = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function(...args) {
                const key = `scroll_into_view_${this.tagName}_${this.id || this.className}`;
                const logMsg = `⚠️ scrollIntoView 호출 감지됨: ${this.outerHTML.slice(0, 100).replace(/\n/g, '')}... | 현재: ${window.location.href}`;
                addLogOnce(key, logMsg);
                return originalScrollIntoView.apply(this, args);
            };
            document.addEventListener('DOMContentLoaded', () => {
                const metas = document.querySelectorAll('meta[http-equiv="refresh"]');
                for (const meta of metas) {
                    const content = meta.getAttribute('content') || '';
                    if (content.includes('url=')) {
                        addLogOnce('meta_refresh_blocked', `🚫 meta refresh 리디렉션 차단됨 | 현재: ${window.location.href} | 대상: ${content}`);
                        meta.remove();
                    }
                }
            });
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    const logMsg = `🚫 자동 다운로드 차단됨 | 현재: ${window.location.href} | 대상: ${a.href}`;
                    addLogOnce('auto_download_blocked', logMsg);
                }
            }, true);
            window.addEventListener('keydown', e => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 's' || e.key === 'p' || e.key === 'u' || (e.shiftKey && e.key === 'I')) {
                        const logMsg = `🚫 단축키 (${e.key}) 차단됨 | 현재: ${window.location.href}`;
                        addLogOnce('hotkey_blocked', logMsg);
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                }
            }, true);
            window.addEventListener('message', e => {
                const isTrustedOrigin = POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => e.origin.includes(domain)) || e.origin === window.location.origin;
                if (isTrustedOrigin) return;

                if (typeof e.data === 'string' && POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => e.data.includes(pattern))) {
                    return;
                }
                if (typeof e.data === 'object' && e.data !== null && e.data.event === 'timeupdate') {
                    return;
                }

                const logMsg = `⚠️ postMessage 의심 감지됨 | 현재: ${window.location.href} | 참조: ${e.origin} | 데이터: ${JSON.stringify(e.data).substring(0, 100)}...`;
                addLogOnce('suspicious_postmessage', logMsg);
            }, false);
            if (!isFeatureAllowed('fullscreen')) {
                try {
                    const originalRequestFullscreen = Document.prototype.requestFullscreen;
                    if (originalRequestFullscreen) {
                        Document.prototype.requestFullscreen = new Proxy(originalRequestFullscreen, {
                            apply(target, thisArg, argumentsList) {
                                addLogOnce('auto_fullscreen_blocked', `🛑 자동 전체화면 차단 | 현재: ${window.location.href}`);
                                return Promise.reject('Blocked fullscreen request');
                            }
                        });
                    }
                } catch (e) {
                    addLogOnce('fullscreen_block_fail', `⚠️ requestFullscreen() 차단 실패: ${e.message}`);
                }
            }
            if (!isFeatureAllowed('location')) {
                try {
                    Object.defineProperty(window, 'location', {
                        configurable: false,
                        enumerable: true,
                        get: () => location,
                        set: (val) => {
                            const logMsg = `🛑 location 이동 차단 시도됨 | 현재: ${window.location.href} | 대상: ${val}`;
                            addLogOnce('location_change_blocked', logMsg);
                            console.warn(logMsg);
                        }
                    });
                } catch (e) {
                    addLogOnce('location_block_fail', `⚠️ window.location 차단 실패: ${e.message}`);
                }
            }
        }
    };

    // --- iframe 차단기 로직 ---
    const iframeBlocker = {
        init: (node, trigger) => {
            if (!FeatureFlags.iframeBlocker) return;
            if (isFeatureAllowed('iframeBlocker')) return;

            if (!node.hasAttribute('sandbox')) {
                node.setAttribute('sandbox', USER_SETTINGS.defaultIframeSandbox);
                addLogOnce('sandbox_added', `🛡️ iframe sandbox 속성 자동 추가 | 대상: ${node.src}`);
            }

            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            const lazySrc = node.getAttribute('data-lazy-src');
            if (lazySrc) { fullSrc = lazySrc; }

            if (fullSrc.startsWith('blob:') || fullSrc.startsWith('javascript:')) {
                if (node.parentNode) node.parentNode.removeChild(node);
                const logMsg = `🚫 의심 iframe 제거됨 (스킴 차단) | 현재: ${window.location.href} | 대상: ${fullSrc}`;
                addLogOnce(`blocked_suspicious_src_${fullSrc}`, logMsg);
                return;
            }

            try { fullSrc = new URL(fullSrc, location.href).href; } catch (e) {
                console.warn(`iframe URL 파싱 실패: ${rawSrc}`, e);
            }

            if (PROCESSED_IFRAMES.has(node)) {
                if (node.src !== node.previousSrc) {
                    node.previousSrc = node.src;
                    const logMsg = `🔄 iframe src 변경 감지 | 현재: ${window.location.href} | 대상: ${fullSrc}`;
                    addLogOnce(`iframe_src_change_${fullSrc}`, logMsg);
                }
                return;
            }
            PROCESSED_IFRAMES.add(node);

            const IS_IFRAME_LOGIC_SKIPPED = IFRAME_SKIP_DOMAINS.some(domain => hostname.includes(domain) || window.location.href.includes(domain));
            if (IS_IFRAME_LOGIC_SKIPPED) {
                addLogOnce('iframe_logic_skip', `ℹ️ iframe 차단 로직 건너옴 (설정 또는 예외 목록): ${hostname}`);
                return;
            }

            const iframeId = node.id || '';
            const iframeClasses = node.className || '';
            const parentId = node.parentElement ? node.parentElement.id || '' : '';
            const parentClasses = node.parentElement ? node.parentElement.className || '' : '';

            const isForcedBlocked = IFRAME_FORCE_BLOCK_PATTERNS.some(pattern => {
                return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
            });

            if (isForcedBlocked) {
                const logMsg = `🚫 iframe 강제 차단됨 (패턴 일치) [id: "${iframeId}", class: "${iframeClasses}"] | 현재: ${window.location.href} | 대상: ${fullSrc}`;
                addLogOnce(`force_blocked_iframe_${fullSrc}`, logMsg);
                if (node.parentNode) node.parentNode.removeChild(node);
                return;
            }

            const logMsg = `🛑 iframe 감지됨 (${trigger}) [id: "${iframeId}", class: "${iframeClasses}"] | 현재: ${window.location.href} | 대상: ${fullSrc}`;
            addLogOnce(`iframe_detected_${fullSrc}`, logMsg);

            if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
                const b64LogMsg = `🚫 Base64 인코딩된 iframe 차단됨 | 현재: ${window.location.href} | 대상: ${node.src.substring(0, 100)}...`;
                addLogOnce('base64_iframe_blocked', b64LogMsg);
                if (node.parentNode) node.parentNode.removeChild(node);
                return;
            }
            const allowMsg = `✅ iframe 허용됨 (다른 확장 프로그램에 의한 차단 확인 필요) | 현재: ${window.location.href} | 대상: ${fullSrc}`;
            addLogOnce('iframe_allowed', allowMsg);
        }
    };

    // --- 레이어 클릭 덫 로직 ---
    const layerTrap = {
        processed: new WeakSet(),
        check: (node) => {
            if (!FeatureFlags.layerTrap) return;
            if (!(node instanceof HTMLElement) || layerTrap.processed.has(node)) {
                return;
            }

            const style = getComputedStyle(node);
            const isSuspect = style.position === 'fixed' &&
                parseInt(style.zIndex) > 1000 &&
                parseFloat(style.opacity) < 0.2 &&
                style.pointerEvents !== 'none';

            const suspiciousHandlers = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'];
            const hasSuspiciousHandler = suspiciousHandlers.some(handler => node.hasAttribute(handler));

            if (isSuspect && hasSuspiciousHandler) {
                layerTrap.processed.add(node);
                node.style.setProperty('display', 'none', 'important');
                node.setAttribute('data-popupblocker-status', 'removed');

                const logMsg = `🛑 레이어 클릭 덫 의심 감지 및 제거 | 현재: ${window.location.href} | 요소: ${node.outerHTML.substring(0, 50)}...`;
                addLogOnce('layer_trap_detected', logMsg);

                node.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    addLogOnce('hidden_layer_click_blocked', `🚫 숨겨진 레이어 클릭 차단됨 | 현재: ${window.location.href}`);
                }, true);
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
                addLogOnce('query_selector_all_fail', `⚠️ 'querySelectorAll' 실행 실패: ${e.message}`);
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
                    style = doc.createElement('style');
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
                        addLogOnce(`video_pointer_event_restore_${videoSource}`, `✅ 비디오 포인터 이벤트 복구 | 현재: ${window.location.href} | 대상: ${videoSource}`);
                    }
                    if (USER_SETTINGS.enableVideoDebugBorder && !video.classList.contains('my-video-ui-initialized')) {
                        video.classList.add('my-video-ui-initialized');
                        addLogOnce(`video_debug_border_added_${videoSource}`, `💡 비디오 요소에 빨간 테두리 추가됨 | 현재: ${window.location.href} | 대상: ${video.tagName}`);
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
                    const logMsg = `⚠️ iframe 접근 실패 (Cross-Origin) | 현재: ${window.location.href} | 대상: ${iframe.src}`;
                    addLogOnce(`iframe_access_fail_${iframe.src}`, logMsg);
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
            if (window.__vmSpeedSliderInjectedInThisFrame) return;
            window.__vmSpeedSliderInjectedInThisFrame = true;

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
                        box-shadow: 0 0 5px rgba(0,0,0,0.0); will-change: transform, opacity;
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
                return container;
            };
            this.speedSliderContainer = createSliderElements();
            document.body.appendChild(this.speedSliderContainer);
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
            if (!this.speedSliderContainer) {
                this.init();
            }
            this.speedSliderContainer.style.display = 'flex';
            this.updatePositionAndSize();
            const slider = document.getElementById('vm-speed-slider');
            this.updateSpeed(slider.value || '1.0');
        },
        hide: function() {
            if (this.speedSliderContainer) { this.speedSliderContainer.style.display = 'none'; }
        },
        updatePositionAndSize: function() {
            const video = document.querySelector('video');
            const sliderContainer = this.speedSliderContainer;
            const slider = document.getElementById('vm-speed-slider');

            if (!video || !sliderContainer || !slider) return;

            // 배속바를 뷰포트의 오른쪽 중앙에 고정
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
        }
    };

    // --- 드래그바 로직 ---
    const dragBar = {
        dragBarTimeDisplay: null,
        init: function() {
            if (window.__vmDragBarInjectedInThisFrame) return;
            window.__vmDragBarInjectedInThisFrame = true;

            const timeDisplayId = 'vm-time-display';
            const dragState = {
                isDragging: false,
                isHorizontalDrag: false,
                startX: 0,
                startY: 0,
                lastUpdateX: 0,
                currentDragDistanceX: 0,
                totalTimeChange: 0,
                originalPointerEvents: new WeakMap(),
                throttleDelay: 100,
                lastDragTimestamp: Date.now(),
            };

            const DRAG_THRESHOLD = 10;
            const TIME_CHANGE_SENSITIVITY = 2;
            const VERTICAL_DRAG_THRESHOLD = 20;

            let throttleTimer = null;

            const createTimeDisplay = () => {
                const newTimeDisplay = document.createElement('div');
                newTimeDisplay.id = timeDisplayId;
                newTimeDisplay.style.cssText = `
                    position: fixed !important; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 5px;
                    font-size: 1.5rem; z-index: 2147483647 !important; display: none; pointer-events: none;
                    transition: opacity 0.3s ease-out; opacity: 1; text-align: center; white-space: nowrap;
                    will-change: transform, opacity;
                `;
                return newTimeDisplay;
            };

            const updateTimeDisplay = (timeChange) => {
                if (!this.dragBarTimeDisplay) {
                    this.dragBarTimeDisplay = createTimeDisplay();
                    if (document.body) document.body.appendChild(this.dragBarTimeDisplay);
                }

                if (timeChange !== 0) {
                    const sign = timeChange > 0 ? '+' : '';
                    this.dragBarTimeDisplay.textContent = `${sign}${timeChange}초 이동`;
                    this.dragBarTimeDisplay.style.display = 'block';
                    this.dragBarTimeDisplay.style.opacity = '1';
                } else {
                    this.dragBarTimeDisplay.style.opacity = '0';
                    clearTimeout(this.dragBarTimeDisplay.timer);
                    this.dragBarTimeDisplay.timer = setTimeout(() => { this.dragBarTimeDisplay.style.display = 'none'; }, 300);
                }
            };

            const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

            const handleStart = (e) => {
                if (e.button === 2) return;
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

                dragState.originalPointerEvents = new WeakMap();

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

            videoUIFlags.dragBarInitialized = true;
        }
    };

    // --- 노드 및 자식 노드 처리 ---
    function processNodeAndChildren(node, trigger) {
        if (!node || PROCESSED_NODES.has(node)) return;
        PROCESSED_NODES.add(node);

        if (node.nodeType === 1) {
            if (node.tagName === 'IFRAME') {
                iframeBlocker.init(node, trigger);
                handleIframeLoad(node);
            }
            if (node.tagName === 'VIDEO' && !PROCESSED_VIDEOS.has(node)) {
                videoControls.initWhenReady(node);
                PROCESSED_VIDEOS.add(node);
            }
            layerTrap.check(node);
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
        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument && !PROCESSED_DOCUMENTS.has(iframeDocument)) {
                const logMsg = `▶️ iframe 로드 감지, 내부 스크립트 실행 시작 | 현재: ${window.location.href} | 대상: ${iframe.src}`;
                addLogOnce('iframe_load_detected', logMsg);
                PROCESSED_IFRAMES.add(iframe);
                startUnifiedObserver(iframeDocument);

                const videos = videoFinder.findInDoc(iframeDocument);
                if (videos.length > 0) {
                    videos.forEach(video => videoControls.initWhenReady(video));
                }
            } else if (iframe.src) {
                PROCESSED_IFRAMES.add(iframe);
            }
        } catch (e) {
            const logMsg = `⚠️ iframe 접근 실패 (Cross-Origin) | 현재: ${window.location.href} | 대상: ${iframe.src}`;
            addLogOnce(`iframe_access_fail_${iframe.src}`, logMsg);
            PROCESSED_IFRAMES.add(iframe);
        }
    }

    // --- 통합 MutationObserver 로직 (중첩 iframe 재귀 탐색 강화) ---
    function startUnifiedObserver(targetDocument = document) {
        if (OBSERVER_MAP.has(targetDocument)) return;
        if (!targetDocument.body && !targetDocument.documentElement || PROCESSED_DOCUMENTS.has(targetDocument)) {
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
                        layerTrap.check(targetNode);
                        if (targetNode.tagName === 'VIDEO' && !PROCESSED_VIDEOS.has(targetNode)) {
                            videoControls.initWhenReady(targetNode);
                            PROCESSED_VIDEOS.add(targetNode);
                        }
                    }
                }
            });
        });

        const rootElement = targetDocument.documentElement || targetDocument.body;
        if (rootElement) {
            observer.observe(rootElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'] });
            PROCESSED_DOCUMENTS.add(targetDocument);
            OBSERVER_MAP.set(targetDocument, observer);
            addLogOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`);
        } else {
            addLogOnce('observer_activation_failed', `⚠️ 통합 감시자 활성화 실패 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`);
        }

        try {
            targetDocument.querySelectorAll('iframe').forEach(iframe => {
                if (PROCESSED_IFRAMES.has(iframe)) return;

                iframe.addEventListener('load', () => {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        if (iframeDoc && !PROCESSED_DOCUMENTS.has(iframeDoc)) {
                            PROCESSED_IFRAMES.add(iframe);
                            startUnifiedObserver(iframeDoc);
                        }
                    } catch(e) {
                        if (!PROCESSED_IFRAMES.has(iframe)) {
                            PROCESSED_IFRAMES.add(iframe);
                        }
                    }
                }, { once: true });

                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc && !PROCESSED_DOCUMENTS.has(iframeDoc)) {
                    PROCESSED_IFRAMES.add(iframe);
                    startUnifiedObserver(iframeDoc);
                } else if (!iframeDoc) {
                    if (!PROCESSED_IFRAMES.has(iframe)) {
                        PROCESSED_IFRAMES.add(iframe);
                    }
                }
            });
        } catch(e) {
            addLogOnce('recursive_iframe_scan_fail', `⚠️ iframe 재귀 탐색 실패 (Cross-Origin): ${targetDocument.URL}`);
        }
    }

    // --- 비디오 UI 감지 및 토글을 위한 애니메이션 프레임 루프 ---
    function startVideoUIWatcher() {
        if (!FeatureFlags.videoControls) return;

        function checkVideos() {
            const videos = videoFinder.findAll();
            if (videos.length > 0) {
                speedSlider.show();
            } else {
                speedSlider.hide();
            }
            requestAnimationFrame(checkVideos);
        }

        requestAnimationFrame(checkVideos);
    }

    // --- 범용 SPA 감지 로직 ---
    let lastURL = location.href;

    function onNavigate(reason = 'URL 변경 감지') {
        if (location.href !== lastURL && document.readyState !== 'loading') {
            lastURL = location.href;
            addLogOnce(`spa_navigate_${Date.now()}`, `🔄 ${reason} | URL: ${location.href}`);

            OBSERVER_MAP.forEach(observer => observer.disconnect());
            PROCESSED_DOCUMENTS.clear();
            PROCESSED_NODES.clear();
            PROCESSED_IFRAMES.clear();
            PROCESSED_VIDEOS.clear();
            LOGGED_KEYS_WITH_TIMER.clear();

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initialLoadLogic, { once: true });
            } else {
                initialLoadLogic();
            }
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

    setInterval(() => {
        if (location.href !== lastURL) {
            onNavigate('interval 감지');
        }
    }, 1000);

    const handleFullscreenChange = () => {
        const fsElement = document.fullscreenElement;
        if (fsElement) {
            // 전체화면 진입 시
            if (speedSlider.speedSliderContainer) {
                if (speedSlider.speedSliderContainer.parentNode) {
                    speedSlider.speedSliderContainer.parentNode.removeChild(speedSlider.speedSliderContainer);
                }
                fsElement.appendChild(speedSlider.speedSliderContainer);
            }
            if (dragBar.dragBarTimeDisplay) {
                if (dragBar.dragBarTimeDisplay.parentNode) {
                    dragBar.dragBarTimeDisplay.parentNode.removeChild(dragBar.dragBarTimeDisplay);
                }
                fsElement.appendChild(dragBar.dragBarTimeDisplay);
            }
        } else {
            // 전체화면 해제 시
            if (speedSlider.speedSliderContainer) {
                if (speedSlider.speedSliderContainer.parentNode !== document.body) {
                    if (speedSlider.speedSliderContainer.parentNode) {
                        speedSlider.speedSliderContainer.parentNode.removeChild(speedSlider.speedSliderContainer);
                    }
                    document.body.appendChild(speedSlider.speedSliderContainer);
                }
            }
            if (dragBar.dragBarTimeDisplay) {
                if (dragBar.dragBarTimeDisplay.parentNode !== document.body) {
                    if (dragBar.dragBarTimeDisplay.parentNode) {
                        dragBar.dragBarTimeDisplay.parentNode.removeChild(dragBar.dragBarTimeDisplay);
                    }
                    document.body.appendChild(dragBar.dragBarTimeDisplay);
                }
            }
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

    // --- 초기 실행 함수 ---
    function initialLoadLogic() {
        addLogOnce('script_init_start', '🎉 스크립트 초기화 시작');
        popupBlocker.init();
        startUnifiedObserver(document);
        startVideoUIWatcher();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialLoadLogic);
    } else {
        initialLoadLogic();
    }
})();
