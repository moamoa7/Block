// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https://example.com/
// @version       6.1.20 (드래그바 로직 최종 수정)
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Speed Slider, PC/모바일 드래그바로 재생 시간 조절을 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 사용자 설정 ---
    const USER_SETTINGS = {
        enableVideoDebugBorder: false,
        scanInterval: 10000,
    };

    // --- 전역 상태 및 중복 방지 ---
    const PROCESSED_NODES = new WeakSet();
    const PROCESSED_IFRAMES = new WeakSet();
    const PROCESSED_DOCUMENTS = new WeakSet();
    const OBSERVER_MAP = new WeakMap();

    // --- 공통 변수 ---
    let logBoxRef = null;
    let isLogBoxReady = false;
    let logBoxContainer = null;
    let logContentBox = null;
    let pendingLogs = [];
    let logDismissTimer = null;
    const logHistory = [];
    let speedSliderContainer = null;
    let dragBarTimeDisplay = null;
    let isSpeedSliderMinimized = true;

    const videoUIFlags = {
        speedSliderInitialized: false,
        dragBarInitialized: false,
        isUIBeingUsed: false,
        playbackUpdateTimer: null,
    };

    // --- 기능별 설정 및 예외 처리 ---
    const WHITELIST = [
        'challenges.cloudflare.com',
        'recaptcha',
        '/e/',
    ];
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
        configurable: false
    });

    const EXCEPTION_LIST = {
        'supjav.com': ['iframeBlocker'],
    };
    const IFRAME_SKIP_DOMAINS = [];
    const FORCE_BLOCK_POPUP_PATTERNS = [];
    const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
        'google.com',
        'ok.ru',
        'twitch.tv',
    ];
    const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
        '{"event":"timeupdate"',
    ];
    const isTopFrame = window.self === window.top;
    const isFeatureAllowed = (featureName) => {
        const exceptions = EXCEPTION_LIST[hostname] || [];
        return exceptions.includes(featureName);
    };

    // --- 로그 출력 제어용 WeakSet 추가 ---
    const loggedKeys = new Set();

    function addLogOnce(key, message) {
        if (!loggedKeys.has(key)) {
            loggedKeys.add(key);
            addLog(message);
        }
    }

    // --- 로그 기능 ---
    function createLogBox() {
        if (!isTopFrame) return;
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
        if (isTopFrame) {
            if (isLogBoxReady) {
                addLogToBox(msg);
            } else {
                pendingLogs.push(msg);
                console.warn(`[MyScript Log - Pending/Debug] ${msg}`);
            }
        } else {
            try {
                window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: msg }, '*');
            } catch (e) {
                if (logBoxContainer) {
                    logBoxContainer.style.display = 'none';
                }
                console.warn(`[MyScript Log - iframe error] ${msg}`);
            }
        }
    }
    if (isTopFrame) {
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'MY_SCRIPT_LOG') {
                addLog(event.data.message);
            }
        });
        createLogBox();
    }

    // --- 팝업/광고 차단기 로직 ---
    function initPopupBlocker() {
        addLog('✅ 팝업 차단 로직 초기화');
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
            addLog(`🚫 window.open 차단 시도: ${url}`);
            const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
            if (isForceBlocked) {
                addLog(`🔥 강제 차단 패턴에 의해 팝업 차단됨: ${url}`);
                return getFakeWindow();
            }
            const currentTime = Date.now();
            const timeSinceVisibilityChange = currentTime - lastVisibilityChangeTime;
            const timeSinceBlur = currentTime - lastBlurTime;
            if (lastVisibilityChangeTime > 0 && timeSinceVisibilityChange < 1000) {
                addLog(`👁️ 탭 비활성화 후 ${timeSinceVisibilityChange}ms 만에 window.open 호출 의심됨: ${url}`);
                console.warn(`👁️ 탭 비활성화 후 ${timeSinceVisibilityChange}ms 만에 window.open 호출 의심됨: ${url}`);
            }
            if (lastBlurTime > 0 && timeSinceBlur < 1000) {
                addLog(`👁️ 탭 블러 후 ${timeSinceBlur}ms 만에 window.open 호출 의심됨: ${url}`);
                console.warn(`👁️ 탭 블러 후 ${timeSinceBlur}ms 만에 window.open 호출 의심됨: ${url}`);
            }
            if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                addLog(`✅ 사용자 상호작용 감지, window.open 허용: ${url}`);
                const features = (args[2] || '') + ',noopener,noreferrer';
                return originalWindowOpen.apply(window, [args[0], args[1], features]);
            }
            return getFakeWindow();
        };
        if (!isFeatureAllowed('windowOpen')) {
            try {
                Object.defineProperty(window, 'open', { get: () => blockOpen, set: () => {}, configurable: false });
                if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
                    unsafeWindow.open = blockOpen;
                }
                Object.freeze(window.open);
            } catch (e) {
                addLog(`⚠️ window.open 재정의 실패: ${e.message}`);
            }
        }
        if (!isFeatureAllowed('opener')) {
            try {
                Object.defineProperty(window, 'opener', {
                    get() { return null; },
                    set() {},
                    configurable: false
                });
                addLog('✅ window.opener 속성 차단됨');
            } catch (e) {
                addLog(`⚠️ window.opener 속성 차단 실패: ${e.message}`);
            }
        }
        let originalHostnameOnLoad = hostname;
        document.addEventListener('DOMContentLoaded', () => {
            originalHostnameOnLoad = window.location.hostname;
            if (window.name && window.name.length > 0) {
                addLog(`ℹ️ 초기 window.name 감지됨: ${window.name.substring(0, 50)}...`);
                window.name = '';
                addLog('✅ 초기 window.name 초기화됨');
            }
        });
        const originalPushState = history.pushState;
        history.pushState = function(...args) {
            if (args[2] && typeof args[2] === 'string') {
                try {
                    const newUrlHostname = new URL(args[2], window.location.href).hostname;
                    if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                        addLog(`ℹ️ pushState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`);
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
                        addLog(`ℹ️ replaceState로 인한 도메인 변경 (${newUrlHostname}) 감지, window.name 초기화`);
                        window.name = '';
                    }
                } catch (e) { /* URL 파싱 오류 무시 */ }
            }
            return originalReplaceState.apply(this, args);
        };
        document.addEventListener('click', function (e) {
            const a = e.target.closest('a');
            if (a && a.href && a.href.startsWith("javascript:") && a.href.includes('window.open')) {
                addLog(`🚫 javascript 링크 (window.open) 차단됨: ${a.href}`);
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);
        const monitorSuspiciousOpenCall = (e) => {
            try {
                const stack = new Error().stack;
                if (stack && stack.includes('open') && (stack.includes('click') || stack.includes('mousedown'))) {
                    addLog(`🕷️ 이벤트 기반 window.open 의심 감지: ${e.type} 이벤트`);
                    console.warn(`🕷️ 이벤트 기반 window.open 의심 스택:`, stack);
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
                        addLog(`🚫 동적 링크 target="_blank" 설정 차단됨: ${el.href || el.outerHTML}`);
                        return;
                    }
                    return origSetAttr.call(this, name, value);
                };
            }
            return el;
        };
        document.addEventListener('submit', function (e) {
            const form = e.target;
            if (form?.target === '_blank' && !isFeatureAllowed('formSubmit')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
            }
        }, true);
        const origSetTimeout = window.setTimeout;
        const origSetInterval = window.setInterval;
        window.setTimeout = function (fn, delay, ...args) {
            if (typeof fn === 'function') {
                const fnString = fn.toString();
                if (fnString.includes('window.open') && !isFeatureAllowed('windowOpen')) {
                    addLog('🚫 setTimeout 내부의 window.open 차단됨');
                    return;
                }
            }
            return origSetTimeout(fn, delay, ...args);
        };
        window.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function') {
                const fnString = fn.toString();
                if (fnString.includes('window.open') && !isFeatureAllowed('windowOpen')) {
                    addLog('🚫 setInterval 내부의 window.open 차단됨');
                    return;
                }
            }
            return origSetInterval(fn, delay, ...args);
        };
        if (!isFeatureAllowed('windowOpen')) {
            const originalClick = HTMLElement.prototype.click;
            HTMLElement.prototype.click = function () {
                if (this.tagName === 'A' && this.href) {
                    addLog(`🚫 JS로 만든 링크 click() 탐지 및 차단됨: ${this.href}`);
                    return;
                }
                return originalClick.call(this);
            };
        }
        const origAttachShadow = Element.prototype.attachShadow;
        if (origAttachShadow) {
            Element.prototype.attachShadow = function(init) {
                const shadowRoot = origAttachShadow.call(this, init);
                const origAddEventListener = shadowRoot.addEventListener;
                shadowRoot.addEventListener = function(type, listener, options) {
                    if (type === 'click') {
                        addLog('🚨 Shadow DOM 내 클릭 리스너 감지됨');
                        console.warn('🚨 Shadow DOM 내 클릭 리스너 감지됨:', this, type, listener);
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
                addLog(`🕳️ 의심 클릭 영역 감지됨: ${el.tagName} (${isHiddenByStyle ? '숨김' : ''}${isZeroSize ? '0크기' : ''}${isOffscreen ? '오프스크린' : ''})`);
                console.warn('🕳️ 의심 클릭 영역 요소:', el);
            }
        }, true);
        const originalExecCommand = Document.prototype.execCommand;
        Document.prototype.execCommand = function(commandId, showUI, value) {
            if (commandId === 'copy') {
                addLog(`📋 document.execCommand('copy') 호출 감지됨`);
                console.warn('📋 document.execCommand("copy") 호출됨:', commandId, showUI, value);
            }
            return originalExecCommand.call(this, commandId, showUI, value);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            const originalWriteText = navigator.clipboard.writeText;
            navigator.clipboard.writeText = async function(data) {
                addLog(`📋 navigator.clipboard.writeText() 호출 감지됨: ${String(data).slice(0, 50)}...`);
                console.warn('📋 navigator.clipboard.writeText() 호출됨:', data);
                return originalWriteText.call(this, data);
            };
        }
        const originalFocus = window.focus;
        window.focus = function () {
            addLog('🚫 window.focus() 호출 차단됨');
        };
        const originalBlur = window.blur;
        window.blur = function () {
            addLog('⚠️ window.blur() 호출 감지됨');
            return originalBlur.apply(this, arguments);
        };
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function(...args) {
            addLog('⚠️ scrollIntoView 호출 감지됨: ' + this.outerHTML.slice(0, 100).replace(/\n/g, '') + '...');
            return originalScrollIntoView.apply(this, args);
        };
        document.addEventListener('DOMContentLoaded', () => {
            const metas = document.querySelectorAll('meta[http-equiv="refresh"]');
            for (const meta of metas) {
                const content = meta.getAttribute('content') || '';
                if (content.includes('url=')) {
                    addLog(`🚫 meta refresh 리디렉션 차단됨: ${content}`);
                    meta.remove();
                }
            }
        });
        document.addEventListener('click', (e) => {
            const a = e.target.closest('a');
            if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                addLog(`🚫 자동 다운로드 차단됨: ${a.href}`);
            }
        }, true);
        window.addEventListener('keydown', e => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 's' || e.key === 'p' || e.key === 'u' || (e.shiftKey && e.key === 'I')) {
                    addLog(`🚫 단축키 (${e.key}) 차단됨`);
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }
        }, true);
        window.addEventListener('message', e => {
            if (e.origin.includes('challenges.cloudflare.com')) {
                return;
            }
            if (POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => e.origin.includes(domain))) {
                return;
            }
            if (typeof e.data === 'string' && POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => e.data.includes(pattern))) {
                return;
            }
            if (typeof e.data === 'object' && e.data !== null && e.data.event === 'timeupdate') {
                return;
            }
            let isMessageSuspicious = false;
            if (e.origin !== window.location.origin) {
                isMessageSuspicious = true;
            } else if (typeof e.data === 'string' && e.data.includes('http')) {
                isMessageSuspicious = true;
            } else if (typeof e.data === 'object' && e.data !== null && 'url' in e.data) {
                isMessageSuspicious = true;
            }
            if (isMessageSuspicious) {
                addLog(`⚠️ postMessage 의심 감지됨: Origin=${e.origin}, Data=${JSON.stringify(e.data).substring(0, 100)}...`);
            }
        }, false);
        if (!isFeatureAllowed('fullscreen')) {
            try {
                const originalRequestFullscreen = Document.prototype.requestFullscreen;
                if (originalRequestFullscreen) {
                    Document.prototype.requestFullscreen = new Proxy(originalRequestFullscreen, {
                        apply(target, thisArg, argumentsList) {
                            addLog('🛑 자동 전체화면 차단');
                            return Promise.reject('Blocked fullscreen request');
                        }
                    });
                }
            } catch (e) {
                addLog(`⚠️ requestFullscreen() 차단 실패: ${e.message}`);
            }
        }
        if (!isFeatureAllowed('location')) {
            try {
                Object.defineProperty(window, 'location', {
                    configurable: false,
                    enumerable: true,
                    get: () => location,
                    set: (val) => {
                        addLog('🛑 location 이동 차단 시도됨: ' + val);
                        console.warn('🛑 location 이동 차단 시도됨:', val);
                    }
                });
            } catch (e) {
                addLog(`⚠️ window.location 차단 실패: ${e.message}`);
            }
        }
    }

// --- iframe 차단기 로직 ---
function initIframeBlocker(node, trigger) {
    if (PROCESSED_IFRAMES.has(node) || isFeatureAllowed('iframeBlocker')) return;
    PROCESSED_IFRAMES.add(node);
    const IS_IFRAME_LOGIC_SKIPPED = IFRAME_SKIP_DOMAINS.some(domain => hostname.includes(domain) || window.location.href.includes(domain));
    if (IS_IFRAME_LOGIC_SKIPPED) {
          addLogOnce('iframe_logic_skip', `ℹ️ iframe 차단 로직 건너뜀 (설정 또는 예외 목록): ${hostname}`);
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
    const forceBlockPatterns = [
        '/ads/', 'adsbygoogle', 'doubleclick', 'adpnut.com',
        'iframead', 'loader.fmkorea.com/_loader/', '/smartpop/',
        '8dk5q9tp.xyz', 's.amazon-adsystem.com',
    ];
    const isForcedBlocked = forceBlockPatterns.some(pattern => {
        return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
    });

    if (isForcedBlocked) {
        addLog(`🚫 iframe 강제 차단됨 (패턴 일치) [id: "${iframeId}", class: "${iframeClasses}"]: ${fullSrc}`);
        node.remove();
        return;
    }

    addLog(`🛑 iframe 감지됨 (${trigger}) [id: "${iframeId}", class: "${iframeClasses}"]: ${fullSrc}`);
    if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
        addLog(`🚫 Base64 인코딩된 iframe 차단됨: ${node.src.substring(0, 100)}...`);
        node.remove();
        return;
    }
    addLog(`✅ iframe 허용됨 (uBlock Origin과 같은 다른 확장 프로그램에 의한 차단도 확인 필요): ${fullSrc}`);
}

// --- 레이어 클릭 덫 로직 ---
const processedLayerTraps = new WeakSet();
function checkLayerTrap(node) {
    if (!isFeatureAllowed('layerTrap') && node instanceof HTMLElement && !processedLayerTraps.has(node)) {
        const style = getComputedStyle(node);
        const isSuspect = style.position === 'fixed' &&
                          parseInt(style.zIndex) > 1000 &&
                          parseFloat(style.opacity) < 0.2 &&
                          style.pointerEvents !== 'none' &&
                          node.hasAttribute('onclick');

        if (isSuspect) {
            processedLayerTraps.add(node);
            addLog(`🛑 레이어 클릭 덫 의심 감지 및 숨김 처리: ${node.outerHTML.substring(0, 100)}...`);
            node.style.setProperty('display', 'none', 'important');
            node.addEventListener('click', e => {
                e.preventDefault();
                e.stopImmediatePropagation();
                addLog('🚫 숨겨진 레이어 클릭 차단됨');
            }, true);
        }
    }
}

// --- 영상 탐색 로직 (최적화) ---
function findAllVideosInDoc(doc) {
    const videos = new Set();
    try {
        doc.querySelectorAll('video').forEach(v => videos.add(v));
    } catch (e) {
        addLog(`⚠️ 'querySelectorAll' 실행 실패: ${e.message}`);
    }

    const potentialVideoContainers = doc.querySelectorAll('div[data-src], div[data-video], div[data-video-id], div[class*="video"], div[id*="player"]');
    potentialVideoContainers.forEach(container => {
        const videoElement = container.querySelector('video');
        if (videoElement) {
            videos.add(videoElement);
        }
    });

    if (USER_SETTINGS.enableVideoDebugBorder && doc.head) {
        let style = doc.createElement('style');
        style.textContent = `.my-video-ui-initialized { outline: 2px solid red !important; }`;
        doc.head.appendChild(style);
    }
    videos.forEach(video => {
        if (video.style.pointerEvents === 'none') {
            video.style.setProperty('pointer-events', 'auto', 'important');
            addLog(`✅ 비디오 포인터 이벤트 복구: ${video.src || video.currentSrc}`);
        }
        if (USER_SETTINGS.enableVideoDebugBorder && !video.classList.contains('my-video-ui-initialized')) {
            video.classList.add('my-video-ui-initialized');
            addLog(`💡 비디오 요소에 빨간 테두리 추가됨: ${video.tagName}`);
        }
    });
    return Array.from(videos);
}

function findAllVideos() {
    let videos = findAllVideosInDoc(document);
    document.querySelectorAll('iframe').forEach(iframe => {
        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument) {
                videos.push(...findAllVideosInDoc(iframeDocument));
            }
        } catch (e) {
            // iframe 접근 실패 로그가 중복되지 않도록 처리
        }
    });
    return videos;
}

// --- 배속 슬라이더 로직 ---
function initSpeedSlider() {
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
                writing-mode: vertical-rl; appearance: slider-vertical;
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
            #vm-speed-toggle-btn {
                background: transparent; border: none; color: white;
                font-size: 18px; cursor: pointer; margin-top: 4px;
            }
            #vm-speed-toggle-btn:hover { color: #ccc; }
        `;
        document.head.appendChild(style);
        const resetBtn = document.createElement('button');
        resetBtn.id = 'vm-speed-reset-btn';
        resetBtn.textContent = '1x';
        const slider = document.createElement('input');
        slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
        slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
        const valueDisplay = document.createElement('div');
        valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'vm-speed-toggle-btn'; toggleBtn.textContent = '🔼';

        const updateToggleButton = () => {
            const sliderEl = document.getElementById('vm-speed-slider');
            const resetBtnEl = document.getElementById('vm-speed-reset-btn');
            const valueDisplayEl = document.getElementById('vm-speed-value');

            if (sliderEl) sliderEl.style.display = isSpeedSliderMinimized ? 'none' : '';
            if (resetBtnEl) resetBtnEl.style.display = isSpeedSliderMinimized ? 'none' : '';
            if (valueDisplayEl) valueDisplayEl.style.display = isSpeedSliderMinimized ? 'none' : '';
            if (toggleBtn) toggleBtn.textContent = isSpeedSliderMinimized ? '🔼' : '🔽';
        };

        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); isSpeedSliderMinimized = !isSpeedSliderMinimized;
            updateToggleButton();
        });

        slider.addEventListener('input', () => onSliderChange(slider.value));
        resetBtn.addEventListener('click', () => {
            slider.value = '1.0'; onSliderChange('1.0');
        });
        container.addEventListener('mousedown', () => videoUIFlags.isUIBeingUsed = true, true);
        container.addEventListener('mouseup', () => videoUIFlags.isUIBeingUsed = false, true);
        container.addEventListener('touchstart', () => videoUIFlags.isUIBeingUsed = true, true);
        container.addEventListener('touchend', () => videoUIFlags.isUIBeingUsed = false, true);
        container.appendChild(resetBtn); container.appendChild(slider);
        container.appendChild(valueDisplay); container.appendChild(toggleBtn);
        updateToggleButton(); return container;
    };
    const updateVideoSpeed = (speed) => {
        findAllVideos().forEach(video => { video.playbackRate = speed; });
    };
    const onSliderChange = (val) => {
        const speed = parseFloat(val);
        const valueDisplay = document.getElementById('vm-speed-value');
        if (valueDisplay) { valueDisplay.textContent = `x${speed.toFixed(1)}`; }
        if (videoUIFlags.playbackUpdateTimer) clearTimeout(videoUIFlags.playbackUpdateTimer);
        videoUIFlags.playbackUpdateTimer = setTimeout(() => { updateVideoSpeed(speed); }, 100);
    };
    const showSpeedSlider = () => {
        if (!speedSliderContainer) {
            speedSliderContainer = createSliderElements();
            document.body.appendChild(speedSliderContainer);
        }
        speedSliderContainer.style.display = 'flex';
        const slider = document.getElementById('vm-speed-slider');
        updateVideoSpeed(slider ? slider.value : '1.0');
    };
    const hideSpeedSlider = () => {
        if (speedSliderContainer) { speedSliderContainer.style.display = 'none'; }
    };
    const checkVideosAndToggleSlider = () => {
        const videos = findAllVideos();
        if (videos.length > 0) { showSpeedSlider(); } else { hideSpeedSlider(); }
    };
    document.addEventListener('fullscreenchange', () => {
        const fsEl = document.fullscreenElement;
        if (fsEl && speedSliderContainer) fsEl.appendChild(speedSliderContainer);
        else if (document.body && speedSliderContainer) document.body.appendChild(speedSliderContainer);
    });
    checkVideosAndToggleSlider();
    videoUIFlags.speedSliderInitialized = true;
}

// --- 드래그바 로직 (최종 수정) ---
function initDragBar() {
    if (window.__vmDragBarInjectedInThisFrame) return;
    window.__vmDragBarInjectedInThisFrame = true;

    const timeDisplayId = 'vm-time-display';
    const dragState = {
        isDragging: false,
        isHorizontalDrag: false,
        startX: 0,
        startY: 0,
        lastUpdateTime: 0,
        currentDragDistanceX: 0,
        totalTimeChange: 0,
        originalPointerEvents: new WeakMap(),
    };

    const DRAG_THRESHOLD = 10;
    const TIME_CHANGE_SENSITIVITY = 2;
    const VERTICAL_DRAG_THRESHOLD = 20;
    const THROTTLE_DELAY = 100;

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
        if (!dragBarTimeDisplay) {
            dragBarTimeDisplay = createTimeDisplay();
            if (document.body) document.body.appendChild(dragBarTimeDisplay);
        }

        if (timeChange !== 0) {
            const sign = timeChange > 0 ? '+' : '';
            dragBarTimeDisplay.textContent = `${sign}${timeChange}초 이동`;
            dragBarTimeDisplay.style.display = 'block';
            dragBarTimeDisplay.style.opacity = '1';
        } else {
            dragBarTimeDisplay.style.opacity = '0';
            setTimeout(() => { dragBarTimeDisplay.style.display = 'none'; }, 300);
        }
    };

    const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

    const handleStart = (e) => {
        if (e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;
        const videos = findAllVideos();
        if (videos.length === 0 || videos.every(v => v.paused)) return;

        dragState.isDragging = true;
        dragState.isHorizontalDrag = false;
        const pos = getPosition(e);
        dragState.startX = pos.clientX;
        dragState.startY = pos.clientY;
        dragState.currentDragDistanceX = 0;
        dragState.totalTimeChange = 0;

        if (e.button === 2) return;
    };

    const applyTimeChange = () => {
        const videos = findAllVideos();
        const timeToApply = Math.round(dragState.currentDragDistanceX / TIME_CHANGE_SENSITIVITY);

        if (timeToApply !== 0) {
            videos.forEach(video => {
                if (video.duration && !isNaN(video.duration)) {
                    video.currentTime += timeToApply;
                }
            });
            dragState.currentDragDistanceX = 0; // 적용 후 이동 거리 초기화
            updateTimeDisplay(dragState.totalTimeChange); // 최종 누적 시간으로 표시 업데이트
        }
    };

    const handleMove = (e) => {
        if (!dragState.isDragging) return;

        const videos = findAllVideos();
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

            const deltaX = currentX - dragState.lastUpdateTime;
            dragState.currentDragDistanceX += deltaX;
            dragState.totalTimeChange = Math.round( (currentX - dragState.startX) / TIME_CHANGE_SENSITIVITY );

            updateTimeDisplay(dragState.totalTimeChange);

            if (throttleTimer === null) {
                throttleTimer = setTimeout(() => {
                    applyTimeChange();
                    throttleTimer = null;
                }, THROTTLE_DELAY);
            }
            dragState.lastUpdateTime = currentX;
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

        const videos = findAllVideos();
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
    };

    const handleFullscreenChange = () => {
        if (!dragBarTimeDisplay) return;
        const fsElement = document.fullscreenElement;
        if (fsElement) {
            if (dragBarTimeDisplay.parentNode) {
                dragBarTimeDisplay.parentNode.removeChild(dragBarTimeDisplay);
            }
            fsElement.appendChild(dragBarTimeDisplay);
        } else {
            if (dragBarTimeDisplay.parentNode) {
                dragBarTimeDisplay.parentNode.removeChild(dragBarTimeDisplay);
            }
            document.body.appendChild(dragBarTimeDisplay);
            const forceReflow = () => {
                document.body.style.transform = 'scale(1)';
                document.body.offsetWidth;
                document.body.style.transform = '';
            };
            setTimeout(forceReflow, 100);
            window.dispatchEvent(new Event('resize'));
        }
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
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    videoUIFlags.dragBarInitialized = true;
}

// --- 비디오 UI 통합 초기화 함수 추가 ---
function initVideoUI() {
    if (!videoUIFlags.speedSliderInitialized) {
        initSpeedSlider();
    }
    if (!videoUIFlags.dragBarInitialized) {
        initDragBar();
    }
}

// --- 노드 및 자식 노드 처리 ---
function processNodeAndChildren(node, trigger) {
    if (!node || PROCESSED_NODES.has(node)) return;
    PROCESSED_NODES.add(node);

    if (node.nodeType === 1) {
        if (node.tagName === 'IFRAME') {
            initIframeBlocker(node, trigger);
            handleIframeLoad(node);
        }
        if (node.tagName === 'VIDEO') {
            initVideoUI();
        }
        checkLayerTrap(node);
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
            addLog(`▶️ iframe 로드 감지, 내부 스크립트 실행 시작: ${iframe.src}`);
            PROCESSED_IFRAMES.add(iframe);
            startUnifiedObserver(iframeDocument);
            const videos = findAllVideosInDoc(iframeDocument);
            if (videos.length > 0) {
                initVideoUI();
            }
        } else if (iframe.src) {
            addLogOnce('iframe_access_fail', `⚠️ iframe 접근 실패 (Cross-Origin): ${iframe.src}`);
            PROCESSED_IFRAMES.add(iframe);
        }
    } catch (e) {
        addLogOnce('iframe_access_fail', `⚠️ iframe 접근 실패 (Cross-Origin): ${iframe.src}`);
        PROCESSED_IFRAMES.add(iframe);
    }
}

// --- 통합 MutationObserver 로직 (중첩 iframe 재귀 탐색 강화) ---
function startUnifiedObserver(targetDocument = document) {
    if (!targetDocument.body || PROCESSED_DOCUMENTS.has(targetDocument)) {
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
                        initIframeBlocker(targetNode, 'iframe src 변경');
                    }
                    checkLayerTrap(targetNode);
                }
            }
        });
    });

    observer.observe(targetDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'onclick'] });
    PROCESSED_DOCUMENTS.add(targetDocument);
    OBSERVER_MAP.set(targetDocument, observer);
    addLog(`✅ 통합 감시자 활성화 (Target: ${targetDocument === document ? '메인 프레임' : 'iframe'})`);

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
                        addLogOnce('nested_iframe_access_fail', `⚠️ 중첩 iframe 접근 실패 (Cross-Origin): ${iframe.src}`);
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
                    addLogOnce('nested_iframe_access_fail', `⚠️ 중첩 iframe 접근 실패 (Cross-Origin): ${iframe.src}`);
                    PROCESSED_IFRAMES.add(iframe);
                }
            }
        });
    } catch(e) {
        addLogOnce('recursive_iframe_scan_fail', `⚠️ iframe 재귀 탐색 실패 (Cross-Origin): ${targetDocument.URL}`);
    }
}

// --- iframe 초기 스캔 및 주기적 재스캔 ---
function scanAndProcessIframes() {
    document.querySelectorAll('iframe').forEach(iframe => {
        if (!PROCESSED_IFRAMES.has(iframe)) {
            initIframeBlocker(iframe, '재스캔');
            iframe.addEventListener('load', () => handleIframeLoad(iframe), { once: true });
            if (iframe.contentDocument) {
                handleIframeLoad(iframe);
            }
        }
    });
}

// --- 초기 실행 함수 ---
function initialLoadLogic() {
    addLog('🎉 스크립트 초기화 시작');
    initPopupBlocker();

    startUnifiedObserver(document);

    scanAndProcessIframes();
    if (USER_SETTINGS.scanInterval > 0) {
        setInterval(scanAndProcessIframes, USER_SETTINGS.scanInterval);
    }

    if (findAllVideos().length > 0) {
        initVideoUI();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialLoadLogic);
} else {
    initialLoadLogic();
}
})();
