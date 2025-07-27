// ==UserScript==
// @name         새창/새탭 완전 차단기 + 배속 슬라이더 통합
// @namespace    https://example.com/
// @version      3.6.5
// @description  window.open 차단 + 팝업 제거 + iframe 감시 + 동적 video 감지 + 배속 슬라이더
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // -------------------------------
  // 💠 배속바 관련 설정 및 함수
  // -------------------------------
  let speedBarInitialized = false;
  let container, label, input;

  function createSpeedControl() {
    if (speedBarInitialized) return;
    speedBarInitialized = true;

    container = document.createElement('div');
    container.id = 'videoSpeedControl';
    container.style.cssText = `
      position: fixed;
      top: 50%;
      right: 10px;
      transform: translateY(-50%);
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.5);
      padding: 8px;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(4px);
      user-select: none;
    `;

    label = document.createElement('div');
    label.textContent = '1x';
    label.style.cssText = `
      color: white;
      font-size: 14px;
      cursor: pointer;
      user-select: none;
    `;
    label.title = '클릭 시 배속 1배속으로 초기화';
    label.addEventListener('click', () => {
      input.value = '1';
      updateSpeed(1);
    });

    input = document.createElement('input');
    input.type = 'range';
    input.min = '0.1';
    input.max = '5';
    input.step = '0.1';
    input.value = '1';
    input.style.cssText = `
      writing-mode: bt-lr;
      -webkit-appearance: slider-vertical;
      width: 30px;
      height: 150px;
      cursor: pointer;
      user-select: none;
    `;

    input.addEventListener('input', () => {
      const rate = parseFloat(input.value);
      updateSpeed(rate);
    });

    container.appendChild(label);
    container.appendChild(input);

    // 바로 body에 붙이지 말고 DOMContentLoaded에서 붙임
    if (document.readyState !== 'loading') {
      document.body.appendChild(container);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(container));
    }
  }

  function updateSpeed(rate) {
    label.textContent = rate.toFixed(1) + 'x';
    document.querySelectorAll('video').forEach(v => {
      v.playbackRate = rate;
    });
  }

  function updateSpeedBarVisibility() {
    if (!container) return;
    const isIframe = window.top !== window.self;
    const hasVideo = document.querySelectorAll('video').length > 0;

    // iframe 내부면 무조건 보임, 아니면 영상 있을 때만 보임
    container.style.display = (isIframe || hasVideo) ? 'flex' : 'none';
  }

  function checkAndInitSpeedControl() {
    if (!speedBarInitialized) {
      createSpeedControl();
    }
    updateSpeedBarVisibility();
  }

  // DOM 변동 감지로 video 추가/제거 체크
  const observer = new MutationObserver(() => {
    if (!speedBarInitialized) return;
    updateSpeedBarVisibility();
  });

  function initSpeedControlAndObserver() {
    checkAndInitSpeedControl();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState !== 'loading') {
    initSpeedControlAndObserver();
  } else {
    document.addEventListener('DOMContentLoaded', initSpeedControlAndObserver);
  }

  // -------------------------------
  // 🔒 팝업 차단기 기존 로직
  // -------------------------------

  const WHITELIST = ['google.com', 'trand.co.kr', 'aagag.com'];
  const IFRAME_WHITELIST = [
    'challenges.cloudflare.com',
    '/player/',
    '/embed/',
    'video.kakao.com',
    'player.bunny-frame.online',
    'supremejav.com',
    '/e/',
  ];

  const hostname = location.hostname;
  const IS_ALLOWED = WHITELIST.some(domain => hostname === domain || hostname.endsWith('.' + domain));

  function isIframeAllowed(src) {
    try {
      const url = new URL(src, location.href);
      return IFRAME_WHITELIST.some(pattern => url.href.includes(pattern));
    } catch {
      return false;
    }
  }

  function createLogBox() {
    const old = document.getElementById('popupBlockerLogBox');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'popupBlockerLogBox';
    box.style.cssText = `
      position: fixed;
      bottom: 0;
      right: 0;
      max-height: 150px;
      width: 350px;
      background: rgba(30,30,30,0.9);
      color: #fff;
      font-family: monospace;
      font-size: 12px;
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
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  }

  function addLog(msg) {
    const box = document.getElementById('popupBlockerLogBox');
    if (!box) return;
    box.style.opacity = '1';
    box.style.pointerEvents = 'auto';
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;
    setTimeout(() => {
      entry.remove();
      if (!box.children.length) {
        box.style.opacity = '0';
        box.style.pointerEvents = 'none';
      }
    }, 30000);
  }

  function scanAndRemoveOverlays() {
    document.querySelectorAll('div, section, aside, iframe').forEach(el => {
      const style = getComputedStyle(el);
      const isFullScreenOverlay =
        (style.position === 'fixed' || (style.position === 'absolute' && style.top === '0px' && style.left === '0px')) &&
        parseInt(style.zIndex) >= 1000 &&
        el.offsetWidth > window.innerWidth * 0.2 &&
        el.offsetHeight > window.innerHeight * 0.2 &&
        !el.querySelector('video');
      if (isFullScreenOverlay) {
        addLog(`🧹 레이어 팝업 제거됨: ${el.outerHTML.slice(0, 100)}...`);
        el.remove();
      }
    });
  }

  const popupLayerObserver = new MutationObserver(scanAndRemoveOverlays);
  if (document.readyState !== 'loading') scanAndRemoveOverlays();
  else document.addEventListener('DOMContentLoaded', scanAndRemoveOverlays);
  popupLayerObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (!IS_ALLOWED) {
    const fakeWindow = new Proxy({}, {
      get: (_, prop) => {
        addLog(`⚠️ window.open 반환 객체 접근: ${String(prop)}`);
        return fakeWindow;
      },
      apply: () => {
        addLog(`⚠️ window.open 반환 함수 호출`);
        return fakeWindow;
      },
    });

    const blockOpen = (...args) => {
      const url = args[0] || '(no URL)';
      addLog(`🚫 window.open 차단됨: ${url}`);
      return fakeWindow;
    };

    Object.defineProperty(window, 'open', {
      get: () => blockOpen,
      set: () => {},
      configurable: false,
    });

    try { unsafeWindow.open = blockOpen; } catch {}
    try {
      if (window.top !== window.self) {
        window.parent.open = blockOpen;
        window.top.open = blockOpen;
      }
    } catch {}
    Object.freeze(window.open);

    document.addEventListener('click', e => {
      const a = e.target.closest('a[target]');
      if (a && ['_blank', '_new'].includes(a.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 링크 클릭 차단됨: ${a.href}`);
      }
    }, true);

    document.addEventListener('mousedown', e => {
      if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
        const a = e.target.closest('a');
        if (a?.target === '_blank') {
          e.preventDefault();
          e.stopImmediatePropagation();
          addLog(`🛑 중간클릭/단축키 클릭 차단됨: ${a.href}`);
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
            addLog(`🚫 동적 링크 target 차단됨: ${el.href || el.outerHTML}`);
            return;
          }
          return origSetAttr.call(this, name, value);
        };
      }
      return el;
    };

    document.addEventListener('submit', e => {
      const form = e.target;
      if (form?.target === '_blank') {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
      }
    }, true);

    Object.defineProperty(window, 'name', {
      get: () => '',
      set: () => {},
      configurable: false,
    });

    if (navigator.registerProtocolHandler) {
      navigator.registerProtocolHandler = () => {
        addLog('🚫 registerProtocolHandler 차단됨');
      };
    }

    if ('showModalDialog' in window) {
      window.showModalDialog = () => {
        addLog('🚫 showModalDialog 차단됨');
        return null;
      };
    }

    if ('Notification' in window) {
      Notification.requestPermission = () => {
        addLog('🚫 Notification 권한 요청 차단됨');
        return Promise.resolve('denied');
      };
    }

    const iframeObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'IFRAME') {
            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            try {
              fullSrc = new URL(rawSrc, location.href).href;
            } catch {}
            const style = getComputedStyle(node);
            const displayHidden = style.display === 'none';

            if (!isIframeAllowed(fullSrc) || displayHidden) {
              addLog(`🛑 의심 iframe 감지됨 (src: ${fullSrc}, display: ${style.display})`);
              try {
                const warning = document.createElement('div');
                warning.innerHTML = `
                  🚫 차단된 iframe입니다<br>
                  <small style="font-size:10px; color:#eee; user-select:text;">${fullSrc}</small>
                `;
                warning.style.cssText = `
                  color: #fff;
                  background: #d32f2f;
                  padding: 6px 10px;
                  font-size: 12px;
                  font-family: monospace;
                  border-radius: 4px;
                  user-select: text;
                `;
                node.parentNode.replaceChild(warning, node);
                setTimeout(() => warning.remove(), 3000);
              } catch {}
            } else {
              addLog(`✅ iframe 허용됨: ${fullSrc}`);
            }
          }
        }
      }
    });
    iframeObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  createLogBox();
})();
