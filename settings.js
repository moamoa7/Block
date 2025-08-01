// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https://example.com/
// @version       4.0.100
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Speed Slider를 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화, Z-index 클릭 덫 감시 및 자동 이동/Base64 iframe 차단 강화
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
  'use strict';

  // 🚩 최상단에서 스크립트 전체 실행 여부 결정
  // 스크립트 실행이 문제를 일으키는 도메인을 추가합니다.
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

  if (window.__MySuperScriptInitialized) {
      return;
  }
  window.__MySuperScriptInitialized = true;

  // 🚩 특정 기능만 예외적으로 허용할 도메인 목록
  // { '도메인명': ['예외기능1', '예외기능2'] } 형식으로 추가합니다.
  const EXCEPTION_LIST = {
  };

  // 🚩 iframe 차단 로직을 건너뛸 도메인 목록
  const IFRAME_SKIP_DOMAINS = [
  ];

  // 🚩 iframe 중 특정 조건에 관계없이 항상 허용할 목록 (현재 미사용)
  const IFRAME_WHITELIST = [
  ];

  // 🚩 window.open()을 무조건 차단할 패턴
  const FORCE_BLOCK_POPUP_PATTERNS = [];

  // 🚩 postMessage 로그를 무시할 도메인
  const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
      'ok.ru',
  ];

  // 🚩 postMessage 로그를 무시할 패턴
  const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
      '{"event":"timeupdate"',
  ];

  const isFeatureAllowed = (featureName) => {
    const exceptions = EXCEPTION_LIST[hostname] || [];
    return exceptions.includes(featureName);
  };

  let logBoxRef = null;
  let isLogBoxReady = false;
  let logBoxContainer = null;
  let logContentBox = null;
  let pendingLogs = [];
  let logDismissTimer = null;

  function createLogBox() {
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
        if (logContentBox.textContent.trim()) {
            navigator.clipboard.writeText(logContentBox.textContent.trim())
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

      logBoxContainer.style.opacity = '1';
      logBoxContainer.style.pointerEvents = 'auto';

      const MAX_LOGS = 50;
      if (logContentBox.childElementCount >= MAX_LOGS) {
          logContentBox.removeChild(logContentBox.firstChild);
      }

      const entry = document.createElement('div');
      entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      entry.style.textAlign = 'left';
      logContentBox.appendChild(entry);
      logContentBox.scrollTop = logContentBox.scrollHeight;

      if (logDismissTimer) {
          clearTimeout(logDismissTimer);
      }
      logDismissTimer = setTimeout(() => {
          logBoxContainer.style.opacity = '0';
          logBoxContainer.style.pointerEvents = 'none';
      }, 10000); // 10초 후에 사라짐
  }

  function addLog(msg) {
    if (isLogBoxReady) {
        addLogToBox(msg);
    } else {
        pendingLogs.push(msg);
        console.warn(`[MyScript Log - Pending/Debug] ${msg}`);
    }
  }

  createLogBox();

  function initPopupBlocker() {
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
      if (!a) return;
      const url = a.href;
      if (url && url.startsWith("javascript:") && url.includes('window.open')) {
        addLog(`🚫 javascript 링크 (window.open) 차단됨: ${url}`);
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

    if (!isFeatureAllowed('layerTrap')) {
      const processedLayers = new WeakSet();

      const suspectLayer = node => {
        if (!(node instanceof HTMLElement)) return false;
        const style = getComputedStyle(node);
        return style.position === 'fixed' &&
                parseInt(style.zIndex) > 1000 &&
                parseFloat(style.opacity) < 0.2 &&
                style.pointerEvents !== 'none' &&
                node.hasAttribute('onclick');
      };

      const checkLayerTrap = node => {
        if (processedLayers.has(node)) { return; }

        if (suspectLayer(node)) {
          addLog(`🛑 레이어 클릭 덫 의심 감지 및 숨김 처리: ${node.outerHTML.substring(0, 100)}...`);
          processedLayers.add(node);
          node.style.setProperty('display', 'none', 'important');
          node.addEventListener('click', e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            addLog('🚫 숨겨진 레이어 클릭 차단됨');
          }, true);
        }
      };

      const layerTrapObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1) {
                checkLayerTrap(node);
                node.querySelectorAll('*').forEach(checkLayerTrap);
              }
            });
          } else if (mutation.type === 'attributes') {
            const targetNode = mutation.target;
            if (targetNode.nodeType === 1 && (
                mutation.attributeName === 'style' ||
                mutation.attributeName === 'class' ||
                mutation.attributeName === 'onclick')) {
              checkLayerTrap(targetNode);
            }
          }
        });
      });

      layerTrapObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'onclick']
      });

      document.querySelectorAll('*').forEach(checkLayerTrap);
    }

    document.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 자동 다운로드 차단됨: ${a.href}`);
      }
    }, true);

    if (!isFeatureAllowed('beforeunload')) {
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'beforeunload') {
              console.warn(`[MyScript Debug] 🚫 beforeunload 리스너 추가 시도 감지 및 차단: ${listener.toString().substring(0, 100)}...`);
              addLog(`🚫 beforeunload 리스너 추가 시도 감지 및 차단`);
              return;
          }
          return originalAddEventListener.call(this, type, listener, options);
      };

      window.addEventListener('beforeunload', function(e) {
          console.warn('[MyScript Debug] 🚫 beforeunload 이벤트 감지 및 강제 차단됨 (스크립트 개입)');
          addLog('🚫 beforeunload 이벤트 감지 및 강제 차단됨');
          e.preventDefault();
          e.returnValue = '';
          e.stopImmediatePropagation();
      }, true);
    }


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

    // 🚩 5. requestFullscreen() 자동 호출 감지 및 차단
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

    // 🚩 6. 악성 window.location 리디렉션 차단
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

  function initIframeBlocker() {
    const IS_IFRAME_LOGIC_SKIPPED = IFRAME_SKIP_DOMAINS.some(domain =>
        hostname.includes(domain) || window.location.href.includes(domain)
    );

    if (IS_IFRAME_LOGIC_SKIPPED) {
      addLog(`ℹ️ iframe 차단 로직 건너뜀 (IFRAME_SKIP_DOMAINS에 포함됨): ${hostname}`);
      return;
    }

    const processedIframes = new WeakSet();

    const processIframe = (node, trigger) => {
      if (processedIframes.has(node)) { return; }
      processedIframes.add(node);

      const rawSrc = node.getAttribute('src') || node.src || '';
      let fullSrc = rawSrc;
      const lazySrc = node.getAttribute('data-lazy-src');
      if (lazySrc) { fullSrc = lazySrc; }
      try { fullSrc = new URL(fullSrc, location.href).href; } catch {}

      const iframeId = node.id || '';
      const iframeClasses = node.className || '';
      const parentId = node.parentElement ? node.parentElement.id || '' : '';
      const parentClasses = node.parentElement ? node.parentElement.className || '' : '';

      // 🚩 여기에 강제 iframe 차단 패턴을 추가합니다.
      // uBlock Origin으로 차단되지 않는 광고나 특정 iframe의 패턴을 추가하세요.
      const forceBlockPatterns = [
          'adsbygoogle',
          'google_ads_frame',
          'doubleclick.net',
          // 여기에 차단하고 싶은 iframe 주소의 일부를 추가하세요.
      ];

      const isForcedBlocked = forceBlockPatterns.some(pattern => {
          return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
      });

      if (isForcedBlocked) {
          addLog(`🚫 iframe 강제 차단됨 (패턴 일치) [id: "${iframeId}", class: "${iframeClasses}", parent_id: "${parentId}", parent_class: "${parentClasses}"]: ${fullSrc}`);
          node.remove();
          return;
      }

      addLog(`🛑 iframe 감지됨 (${trigger}) [id: "${iframeId}", class: "${iframeClasses}", parent_id: "${parentId}", parent_class: "${parentClasses}"]: ${fullSrc}`);

      if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
        addLog(`🚫 Base64 인코딩된 iframe 차단됨: ${node.src.substring(0, 100)}...`);
        node.remove();
        return;
      }

      addLog(`✅ iframe 허용됨 (uBlock Origin과 같은 다른 확장 프로그램에 의한 차단도 확인 필요): ${fullSrc}`);
    };

    const iframeAddObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && node.tagName === 'IFRAME') {
                        processIframe(node, 'DOM 추가됨');
                    }
                }
            }
        }
    });
    iframeAddObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    const iframeSrcObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'src') {
                if (m.target.tagName === 'IFRAME') {
                    processedIframes.delete(m.target);
                    processIframe(m.target, 'src 속성 변경됨');
                }
            }
        }
    });
    iframeSrcObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['src'],
        subtree: true
    });

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('iframe').forEach(iframe => {
            processIframe(iframe, '초기 로드');
        });
    });
  }

  // --- 배속 조절기 함수 최종 수정 ---
  function initSpeedSlider() {
    if (window.__vmSpeedSliderInjectedInThisFrame) return;
    window.__vmSpeedSliderInjectedInThisFrame = true;

    const sliderId = 'vm-speed-slider-container';
    let container = document.getElementById(sliderId);
    let playbackUpdateTimer = null;

    const updateVideoSpeed = (speed) => {
        const videoElements = document.querySelectorAll('video');
        if (videoElements.length > 0) {
            videoElements.forEach(video => {
                video.playbackRate = speed;
            });
        }
    };

    const onSliderChange = (val) => {
        const speed = parseFloat(val);
        const valueDisplay = document.getElementById('vm-speed-value');
        if (valueDisplay) {
            valueDisplay.textContent = `x${speed.toFixed(1)}`;
        }

        // 지연 시간을 두어 playbackRate 변경을 안정화
        if (playbackUpdateTimer) clearTimeout(playbackUpdateTimer);
        playbackUpdateTimer = setTimeout(() => {
            updateVideoSpeed(speed);
        }, 100);
    };

    const createSliderElements = () => {
        container = document.createElement('div');
        container.id = sliderId;

        const style = document.createElement('style');
        style.textContent = `
            #${sliderId} {
                position: fixed;
                top: 50%;
                right: 0;
                transform: translateY(-50%);
                background: rgba(0, 0, 0, 0.0);
                padding: 10px 8px;
                border-radius: 8px 0 0 8px;
                z-index: 2147483647 !important;
                display: none; /* 초기 상태는 숨겨져 있음 */
                flex-direction: column;
                align-items: center;
                width: 50px;
                height: auto;
                font-family: sans-serif;
                pointer-events: auto;
                opacity: 0.3;
                transition: opacity 0.3s;
                user-select: none;
                box-shadow: 0 0 5px rgba(0,0,0,0.0);
            }
            #${sliderId}:hover { opacity: 1; }
            #vm-speed-reset-btn {
                background: #444; border: none; border-radius: 4px; color: white;
                font-size: 14px; padding: 4px 6px; cursor: pointer;
                margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold;
            }
            #vm-speed-reset-btn:hover { background: #666; }
            #vm-speed-slider {
                writing-mode: vertical-rl;
                appearance: slider-vertical;
                width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer;
                background: #555;
                border-radius: 5px;
            }
            #vm-speed-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 20px;
                height: 20px;
                background: #f44336;
                border-radius: 50%;
                cursor: pointer;
                border: 1px solid #ddd;
            }
            #vm-speed-slider::-moz-range-thumb {
                width: 20px;
                height: 20px;
                background: #f44336;
                border-radius: 50%;
                cursor: pointer;
                border: 1px solid #ddd;
            }
            #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
            #vm-speed-toggle-btn {
                background: transparent;
                border: none;
                color: white;
                font-size: 18px;
                cursor: pointer;
                margin-top: 4px;
            }
            #vm-speed-toggle-btn:hover { color: #ccc; }
        `;
        document.head.appendChild(style);

        const resetBtn = document.createElement('button');
        resetBtn.id = 'vm-speed-reset-btn';
        resetBtn.textContent = '1x';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0.2';
        slider.max = '4.0';
        slider.step = '0.2';
        slider.value = '1.0';
        slider.id = 'vm-speed-slider';
        const valueDisplay = document.createElement('div');
        valueDisplay.id = 'vm-speed-value';
        valueDisplay.textContent = 'x1.0';
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'vm-speed-toggle-btn';
        toggleBtn.textContent = '🔼';

        let isMinimized = true;

        const updateToggleButton = () => {
            slider.style.display = isMinimized ? 'none' : '';
            resetBtn.style.display = isMinimized ? 'none' : '';
            valueDisplay.style.display = isMinimized ? 'none' : '';
            toggleBtn.textContent = isMinimized ? '🔼' : '🔽';
        };

        toggleBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            updateToggleButton();
        });

        slider.addEventListener('input', () => onSliderChange(slider.value));
        resetBtn.addEventListener('click', () => {
            slider.value = '1.0';
            onSliderChange('1.0');
        });

        container.appendChild(resetBtn);
        container.appendChild(slider);
        container.appendChild(valueDisplay);
        container.appendChild(toggleBtn);

        updateToggleButton();
        return container;
    };

    const checkVideosAndDisplay = () => {
        const videoElements = document.querySelectorAll('video');
        if (videoElements.length > 0) {
            if (!container) {
                container = createSliderElements();
                document.body.appendChild(container);
            }
            container.style.display = 'flex';
            const slider = document.getElementById('vm-speed-slider');
            updateVideoSpeed(slider ? slider.value : '1.0');
        } else {
            if (container) {
                container.style.display = 'none';
            }
        }
    };

    document.addEventListener('fullscreenchange', () => {
        const fsEl = document.fullscreenElement;
        if (fsEl) fsEl.appendChild(container);
        else checkVideosAndDisplay();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkVideosAndDisplay);
    } else {
        checkVideosAndDisplay();
    }

    new MutationObserver(checkVideosAndDisplay).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  initPopupBlocker();
  initIframeBlocker();
  initSpeedSlider();

})();
