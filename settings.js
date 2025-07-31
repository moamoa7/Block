// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https://example.com/
// @version       4.0.25 // ok.ru postMessage 무한 로그 해결
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Speed Slider를 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화, Z-index 클릭 덫 감시 및 자동 이동/Base64 iframe 차단 강화
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
  'use strict';

  if (window.__MySuperScriptInitialized) {
      return;
  }
  window.__MySuperScriptInitialized = true;

  const WHITELIST = [
    'accounting.auction.co.kr',
    'buy.auction.co.kr',
  ];

  const IFRAME_SKIP_DOMAINS = [];
  const FORCE_BLOCK_POPUP_PATTERNS = [];

  // ✅ postMessage 로그 무시할 도메인 및 패턴 추가
  const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
      'ok.ru', // ok.ru 에서 발생하는 동영상 timeupdate 로그 무시
      // 다른 정상적인 통신으로 인해 로그가 과도하게 뜨는 도메인을 여기에 추가할 수 있습니다.
  ];
  const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
      '{"event":"timeupdate"', // timeupdate 이벤트는 일반적으로 안전
  ];


  const hostname = location.hostname;
  const IS_ALLOWED_DOMAIN_FOR_POPUP = WHITELIST.some(domain =>
    hostname.includes(domain) || window.location.href.includes(domain)
  );

  let logBoxRef = null;

  function createLogBox() {
    if (document.getElementById('popupBlockerLogBox')) {
        logBoxRef = document.getElementById('popupBlockerLogBox');
        return;
    }

    const box = document.createElement('div');
    box.id = 'popupBlockerLogBox';
    box.style.cssText = `
      position: fixed;
      bottom: 0;
      right: 0;
      max-height: 250px;
      width: 350px;
      background: rgba(30,30,30,0.9);
      color: #fff;
      font-family: monospace;
      font-size: 14px;
      overflow-y: auto;
      padding: 8px;
      box-shadow: 0 0 8px #000;
      z-index: 9999998;
      border-top-left-radius: 8px;
      user-select: text;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    `;

    const appendToBody = () => {
        if (document.body && !document.body.contains(box)) {
            document.body.appendChild(box);
            logBoxRef = box;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', appendToBody);
    } else {
        appendToBody();
    }
  }

  function addLog(msg) {
    const box = logBoxRef || document.getElementById('popupBlockerLogBox');
    if (!box) {
        console.warn(`[MyScript Log - No Box Yet] ${msg}`);
        return;
    }
    box.style.opacity = '1';
    box.style.pointerEvents = 'auto';
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    entry.style.textAlign = 'left';
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;

    setTimeout(() => {
        if (entry.parentNode) entry.remove();
        if (!box.children.length) {
            box.style.opacity = '0';
            box.style.pointerEvents = 'none';
        }
    }, 10000);
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
      focus: () => {},
      opener: null,
      closed: false,
      blur: () => {},
      close: () => {},
      location: {
          href: "", assign: () => {}, replace: () => {}, reload: () => {},
          toString: () => "", valueOf: () => ""
      },
      alert: () => {}, confirm: () => {}, prompt: () => {},
      postMessage: () => {},
      document: {
          write: () => {}, writeln: () => {},
      },
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

    window.addEventListener('blur', () => {
        lastBlurTime = Date.now();
    });

    window.addEventListener('focus', () => {
        lastBlurTime = 0;
    });

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

      if (userInitiatedAction) {
        addLog(`✅ 사용자 상호작용 감지, window.open 허용: ${url}`);
        const features = (args[2] || '') + ',noopener,noreferrer';
        return originalWindowOpen.apply(window, [args[0], args[1], features]);
      }
      return getFakeWindow();
    };

    if (!IS_ALLOWED_DOMAIN_FOR_POPUP) {
      try {
        Object.defineProperty(window, 'open', { get: () => blockOpen, set: () => {}, configurable: false });
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
            unsafeWindow.open = blockOpen;
        }
        Object.freeze(window.open);
      } catch (e) {
          addLog(`⚠️ window.open 재정의 실패: ${e.message}`);
      }

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
                  console.warn('🕷️ 이벤트 기반 window.open 의심 스택:', stack);
              }
          } catch (err) { /* 스택 접근 실패 시 무시 */ }
      };
      document.addEventListener('click', monitorSuspiciousOpenCall, true);
      document.addEventListener('mousedown', monitorSuspiciousOpenCall, true);

      document.addEventListener('mousedown', function (e) {
        if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
          const a = e.target.closest('a');
          if (a?.target === '_blank') {
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
            if (name === 'target' && ['_blank', '_new'].includes(value)) {
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
        if (form?.target === '_blank') {
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
            if (fnString.includes('window.open')) {
                addLog('🚫 setTimeout 내부의 window.open 차단됨');
                return;
            }
        }
        return origSetTimeout(fn, delay, ...args);
      };

      window.setInterval = function (fn, delay, ...args) {
        if (typeof fn === 'function') {
            const fnString = fn.toString();
            if (fnString.includes('window.open')) {
                addLog('🚫 setInterval 내부의 window.open 차단됨');
                return;
            }
        }
        return origSetInterval(fn, delay, ...args);
      };

      const originalClick = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function () {
          const suspicious = this.tagName === 'A' && this.href && (this.href.includes('ad') || this.href.includes('banner'));
          if (suspicious) {
              addLog(`🚫 JS로 만든 링크 click() 차단: ${this.href}`);
              return;
          }
          return originalClick.call(this);
      };

      const originalSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
          addLog('🚫 JS로 form.submit() 차단');
          return;
      };

      const originalDocumentWrite = document.write;
      const originalDocumentWriteln = document.writeln;

      document.write = document.writeln = function(...args) {
        addLog('🚫 document.write/writeln 호출 감지됨 (광고/피싱 의심) - 차단됨');
        console.warn('🚫 document.write/writeln 호출 감지됨 (차단됨):', ...args);
      };

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

      const originalRequestFullscreen = HTMLElement.prototype.requestFullscreen;
      if (originalRequestFullscreen) {
          HTMLElement.prototype.requestFullscreen = function () {
              if (userInitiatedAction) {
                  addLog('✅ 사용자 상호작용으로 전체화면 진입 허용됨');
                  return originalRequestFullscreen.apply(this, arguments);
              } else {
                  addLog('🚫 사용자 상호작용 없는 전체화면 진입 시도 차단됨');
                  return Promise.reject(new Error('Fullscreen API blocked by script: No user interaction.'));
              }
          };
      }

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
        if (suspectLayer(node)) {
          addLog(`🛑 레이어 클릭 덫 의심 감지 및 숨김 처리: ${node.outerHTML.substring(0, 100)}...`);
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

      document.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          addLog(`🚫 자동 다운로드 차단됨: ${a.href}`);
        }
      }, true);

      const originalAddEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'beforeunload') {
              addLog(`🚫 beforeunload 리스너 추가 시도 감지 및 차단: ${listener.toString().substring(0, 100)}...`);
              return;
          }
          return originalAddEventListener.call(this, type, listener, options);
      };

      window.addEventListener('beforeunload', function(e) {
          addLog('🚫 beforeunload 이벤트 감지 및 강제 차단됨 (스크립트 개입)');
          e.preventDefault();
          e.returnValue = '';
          e.stopImmediatePropagation();
      }, true);

      window.addEventListener('contextmenu', e => {
          addLog('🚫 마우스 우클릭 (contextmenu) 이벤트 차단됨');
          e.preventDefault();
          e.stopImmediatePropagation();
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

      // postMessage 감지 로직 수정 (로그 무시 조건 추가)
      window.addEventListener('message', e => {
          // 로그 무시할 도메인인지 확인
          if (POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => e.origin.includes(domain))) {
              // 메시지 데이터가 특정 패턴을 포함하는지 확인 (예: timeupdate)
              if (typeof e.data === 'string' && POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => e.data.includes(pattern))) {
                  // 이 조건에 해당하면 로그를 출력하지 않고 리턴
                  return;
              }
              if (typeof e.data === 'object' && e.data !== null && e.data.event === 'timeupdate') {
                  return;
              }
          }

          // 기존의 의심 감지 조건 (크로스-오리진 또는 URL 패턴)
          if (e.origin !== window.location.origin ||
              (typeof e.data === 'string' && e.data.includes('http')) ||
              (typeof e.data === 'object' && e.data !== null && 'url' in e.data)) {
              addLog(`⚠️ postMessage 의심 감지됨: Origin=${e.origin}, Data=${JSON.stringify(e.data).substring(0, 100)}...`);
          }
      }, false);

    }
  }

  function initIframeBlocker() {
    const IFRAME_SKIP = IFRAME_SKIP_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );

    const processedIframes = new WeakSet();

    const processIframe = (node, trigger) => {
      if (processedIframes.has(node)) { return; }
      processedIframes.add(node);

      if (node.src?.startsWith('data:text/html;base64,')) {
        addLog(`🚫 Base64 인코딩된 iframe 차단됨: ${node.src.substring(0, 100)}...`);
        node.style.setProperty('display', 'none', 'important');
        node.remove();
        return;
      }

      if (node.src?.startsWith('about:blank')) {
          if (!node.hasAttribute('sandbox')) {
              addLog(`🚫 'about:blank' & sandbox 없는 iframe 차단됨 (스크립트 주입 의심): ${node.outerHTML.substring(0, 100)}...`);
              node.style.setProperty('display', 'none', 'important');
              node.remove();
              return;
          }
          return;
      }

      const rawSrc = node.getAttribute('src') || node.src || '';
      let fullSrc = rawSrc;
      const lazySrc = node.getAttribute('data-lazy-src');
      if (lazySrc) { fullSrc = lazySrc; }
      try { fullSrc = new URL(fullSrc, location.href).href; } catch {}

      addLog(`🛑 iframe 감지됨 (${trigger}): ${fullSrc}`);

      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const isHidden = (node.offsetWidth === 0 && node.offsetHeight === 0) ||
                       (rect.width === 0 && rect.height === 0) ||
                       (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none');

      if (isHidden) {
          addLog(`🚫 숨겨진/0x0 크기 iframe 차단됨: ${fullSrc.substring(0, 100)}...`);
          node.style.setProperty('display', 'none', 'important');
          node.remove();
          return;
      }

      node.addEventListener('load', () => {
          if (node.contentWindow && node.contentDocument) {
              node.contentDocument.addEventListener('DOMContentLoaded', () => {
                  try {
                      const iframeBlockOpen = (...args) => {
                          const url = args[0] || '(no URL)';
                          addLog(`🚫 iframe 내부 window.open 차단 시도: ${url}`);
                          if (window.top && window.top.__MySuperScriptInitialized && typeof window.top.blockOpen === 'function') {
                              addLog('🚫 iframe 내부에서 top.blockOpen 접근 시도 감지, 자체 차단');
                              return getFakeWindow();
                          }
                          return getFakeWindow();
                      };

                      Object.defineProperty(node.contentWindow, 'open', {
                          get: () => iframeBlockOpen,
                          set: () => {},
                          configurable: false
                      });
                      Object.freeze(node.contentWindow.open);
                      addLog(`✅ iframe 내부 window.open 차단 주입 성공 (on DOMContentLoaded): ${fullSrc}`);
                  } catch (e) {
                      addLog(`⚠️ iframe 내부 window.open 차단 주입 실패 (접근 오류): ${e.message}`);
                  }
              }, { once: true });
          }
      }, { once: true });

      const isForceBlockedIframeSrc = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => fullSrc.includes(pattern));
      if (isForceBlockedIframeSrc) {
          addLog(`🛑 강제 차단 패턴에 의해 iframe 차단됨: ${fullSrc}`);
          node.src = 'about:blank';
          node.removeAttribute('srcdoc');
          node.style.cssText += `
              display: none !important; visibility: hidden !important; width: 0px !important;
              height: 0px !important; pointer-events: none !important;
          `;
          try {
              const warning = document.createElement('div');
              warning.innerHTML = `🚫 차단된 iframe입니다<br><small style="font-size:14px; color:#eee; user-select:text;">${fullSrc}</small>`;
              warning.style.cssText = `
                  position: fixed !important; top: ${node.getBoundingClientRect().top}px !important; left: ${node.getBoundingClientRect().left}px !important;
                  width: ${node.getBoundingClientRect().width}px !important; height: ${node.getBoundingClientRect().height}px !important;
                  display: flex !important; flex-direction: column !important; justify-content: center !important; align-items: center !important;
                  color: #fff !important; background: rgba(211, 47, 47, 0.9) !important; padding: 6px 10px !important;
                  font-size: 14px !important; font-family: monospace !important; border-radius: 4px !important;
                  user-select: text !important; word-break: break-all !important; z-index: 2147483647 !important;
                  box-sizing: border-box !important; opacity: 1 !important; pointer-events: auto !important;
              `;
              const removeBtn = document.createElement('button');
              removeBtn.textContent = 'X';
              removeBtn.style.cssText = `position: absolute !important; top: 2px !important; right: 5px !important; background: none !important; border: none !important; color: white !important; cursor: pointer !important; font-weight: bold !important; font-size: 16px !important;`;
              removeBtn.onclick = (e) => { e.stopPropagation(); warning.remove(); addLog(`ℹ️ 사용자 요청으로 차단 메시지 제거: ${fullSrc}`); };
              warning.prepend(removeBtn);
              document.body.appendChild(warning);
              setTimeout(() => { if (warning.parentNode) warning.remove(); addLog(`ℹ️ 자동 제거된 차단 메시지: ${fullSrc}`); }, 10000);
          } catch (e) {
              addLog(`⚠️ 경고 메시지 표시 실패: ${e.message}`);
          }
      } else {
          addLog(`✅ iframe 허용됨 (uBlock Origin과 같은 다른 확장 프로그램에 의한 차단도 확인 필요): ${fullSrc}`);
      }
    };

    if (!IFRAME_SKIP) {
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
  }

  function initSpeedSlider() {
    if (window.__vmSpeedSliderInjectedInThisFrame) return;
    window.__vmSpeedSliderInjectedInThisFrame = true;

    const container = document.createElement('div');
    const sliderId = 'vm-speed-slider-container';
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
        display: none;
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
        writing-mode: vertical-rl; appearance: slider-vertical;
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
    toggleBtn.textContent = '🔽';

    let isMinimized = true;

    slider.style.display = 'none';
    resetBtn.style.display = 'none';
    valueDisplay.style.display = 'none';
    toggleBtn.textContent = '🔼';

    toggleBtn.addEventListener('click', () => {
      isMinimized = !isMinimized;
      slider.style.display = isMinimized ? 'none' : '';
      resetBtn.style.display = isMinimized ? 'none' : '';
      valueDisplay.style.display = isMinimized ? 'none' : '';
      toggleBtn.textContent = isMinimized ? '🔼' : '🔽';
    });

    container.appendChild(resetBtn);
    container.appendChild(slider);
    container.appendChild(valueDisplay);
    container.appendChild(toggleBtn);

    const updateSpeed = (val) => {
      const speed = parseFloat(val);
      valueDisplay.textContent = `x${speed.toFixed(1)}`;
      document.querySelectorAll('video').forEach(video => {
        video.playbackRate = speed;
      });
    };

    slider.addEventListener('input', () => updateSpeed(slider.value));
    resetBtn.addEventListener('click', () => {
      slider.value = '1';
      updateSpeed('1');
    });

    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      if (fsEl) fsEl.appendChild(container);
      else if (document.body && !document.body.contains(container)) document.body.appendChild(container);
    });

    const updateSliderVisibility = () => {
      const hasVideo = document.querySelectorAll('video').length > 0;
      container.style.display = hasVideo ? 'flex' : 'none';
    };

    const append = () => {
      if (document.body && !document.body.contains(container)) {
        document.body.appendChild(container);
      }
      updateSliderVisibility();
      updateSpeed(slider.value);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', append);
    } else {
        append();
    }

    new MutationObserver(updateSliderVisibility).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  initPopupBlocker();
  initIframeBlocker();
  initSpeedSlider();

})();
