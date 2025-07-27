// ==UserScript==
// @name         새창/새탭 완전 차단기 + iframe 고급 차단 + 레이어 제거 + 의심 iframe 감시 + 경고 메시지 표시 + Vertical Video Speed Slider
// @namespace    https://example.com/
// @version      3.7.0
// @description  window.open 차단 + 팝업/레이어 제거 + iframe src/스타일 감시 + 허용 문자열 포함 시 예외 + 차단 iframe 경고 메시지 + 자동 사라짐 + 영상 배속 슬라이더(iframe 내부 포함)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ================================
  // [1] 팝업/iframe 차단 + 레이어 제거 + 로그박스
  // ================================

  const WHITELIST = ['google.com', 'trand.co.kr', 'aagag.com'];
  const IFRAME_WHITELIST = [
    'challenges.cloudflare.com',
    '/player/',
    '/embed/',
    'video.kakao.com',
    'player.bunny-frame.online',
    'supremejav.com',
    '/e/', '/v/',
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
    if (document.getElementById('popupBlockerLogBox')) return;
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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(box);
      });
    } else {
      document.body.appendChild(box);
    }
  }

  function addLog(msg) {
    const box = document.getElementById('popupBlockerLogBox');
    if (!box) return;
    box.style.opacity = '1';
    box.style.pointerEvents = 'auto';
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    entry.style.textAlign = 'left';
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

  // 레이어 팝업 제거 (video 포함된 요소는 제외)
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

  const popupLayerObserver = new MutationObserver(() => scanAndRemoveOverlays());
  if (document.readyState !== 'loading') {
    scanAndRemoveOverlays();
  } else {
    document.addEventListener('DOMContentLoaded', scanAndRemoveOverlays);
  }
  popupLayerObserver.observe(document.documentElement, { childList: true, subtree: true });

  // 팝업 차단
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

    // 링크 클릭 차단
    document.addEventListener('click', e => {
      const a = e.target.closest('a[target]');
      if (a && ['_blank', '_new'].includes(a.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 링크 클릭 차단됨: ${a.href}`);
      }
    }, true);

    // 중간클릭, Ctrl/Meta/Shift + 클릭 차단
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

    // 동적 링크 target 변경 차단
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

    // form[target=_blank] 제출 차단
    document.addEventListener('submit', e => {
      const form = e.target;
      if (form?.target === '_blank') {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
      }
    }, true);

    // window.name 초기화 차단
    Object.defineProperty(window, 'name', {
      get: () => '',
      set: () => {},
      configurable: false,
    });

    // 기타 차단: registerProtocolHandler, showModalDialog, Notification 권한 요청
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

    // iframe 감시
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
            const display = style.display || '(unknown)';
            const displayHidden = (display === 'none' || display === 'hidden' || node.hidden);

            if (!isIframeAllowed(fullSrc) || displayHidden) {
              addLog(`🛑 의심 iframe 감지됨 (src: ${fullSrc}, display: ${display})`);
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
                  max-width: 90vw;
                  word-break: break-all;
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

  // ================================
  // [2] Vertical Video Speed Slider (iframe & top window 모두 적용)
  // ================================

  // 슬라이더 실행은 DOM 준비 후, document-end 이후 실행 필요하여
  // document-end 시점과 유사한 방식으로 실행 예약
  function initSpeedSlider() {
    if (window.__vmSpeedSliderInjected) return;
    window.__vmSpeedSliderInjected = true;

    const sliderId = 'vm-speed-slider-container';

    // 중복 DOM 제거 (슬라이더가 이미 있으면 제거)
    const existing = document.getElementById(sliderId);
    if (existing) existing.remove();

    const isIframe = window.top !== window.self;

    const style = document.createElement('style');
    style.textContent = `
      #${sliderId} {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        background: rgba(0, 0, 0, 0.7);
        padding: 10px 8px;
        border-radius: 8px 0 0 8px;
        z-index: 2147483647 !important;
        display: none;
        flex-direction: column;
        align-items: center;
        width: 70px;
        height: auto;
        font-family: sans-serif;
        pointer-events: auto;
        opacity: 0.3;
        transition: opacity 0.3s;
        user-select: none;
      }
      #${sliderId}:hover {
        opacity: 1;
      }

      #vm-speed-reset-btn {
        background: #444;
        border: none;
        border-radius: 4px;
        color: white;
        font-size: 14px;
        padding: 4px 6px;
        cursor: pointer;
        margin-bottom: 8px;
        user-select: none;
        width: 40px;
        height: 30px;
        line-height: 30px;
        text-align: center;
        font-weight: bold;
      }
      #vm-speed-reset-btn:hover {
        background: #666;
      }

      #vm-speed-slider {
        writing-mode: vertical-rl;
        -webkit-appearance: slider-vertical;
        appearance: slider-vertical;
        width: 30px;
        height: 150px;
        margin: 0 0 10px 0;
        cursor: pointer;
        user-select: none;
      }

      #vm-speed-value {
        color: white;
        font-size: 13px;
        user-select: none;
      }
    `;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = sliderId;

    const resetBtn = document.createElement('button');
    resetBtn.id = 'vm-speed-reset-btn';
    resetBtn.textContent = '1x';
    resetBtn.title = '클릭하면 1배속으로 초기화';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.25';
    slider.max = '3';
    slider.step = '0.05';
    slider.value = '1';
    slider.id = 'vm-speed-slider';

    const valueDisplay = document.createElement('div');
    valueDisplay.id = 'vm-speed-value';
    valueDisplay.textContent = 'x1.00';

    container.appendChild(resetBtn);
    container.appendChild(slider);
    container.appendChild(valueDisplay);

    const updateSpeed = (val) => {
      const speed = parseFloat(val);
      valueDisplay.textContent = `x${speed.toFixed(2)}`;
      document.querySelectorAll('video').forEach(video => {
        video.playbackRate = speed;
      });
    };

    slider.addEventListener('input', () => updateSpeed(slider.value));
    resetBtn.addEventListener('click', () => {
      slider.value = '1';
      updateSpeed('1');
    });

    // 전체화면일 때 슬라이더 위치 조정
    const reattachSlider = () => {
      const fsEl = document.fullscreenElement;
      if (fsEl) {
        fsEl.appendChild(container);
      } else {
        if (!document.body.contains(container)) {
          document.body.appendChild(container);
        }
      }
    };
    document.addEventListener('fullscreenchange', reattachSlider);

    // 슬라이더 표시 조건 업데이트
    function updateSliderVisibility() {
      const hasVideo = document.querySelectorAll('video').length > 0;

      // iframe 안이거나 최상위 문서이거나, 영상이 있을 때만 표시
      if ((isIframe && hasVideo) || (!isIframe && hasVideo)) {
        container.style.display = 'flex';
      } else {
        container.style.display = 'none';
      }
    }

    // 초기 DOM에 붙이고 표시 갱신
    function append() {
      if (!document.body.contains(container)) {
        document.body.appendChild(container);
      }
      updateSliderVisibility();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', append);
    } else {
      append();
    }

    // video 추가/제거 감지해 표시 갱신
    const observer = new MutationObserver(() => {
      updateSliderVisibility();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // document-end 시점과 유사하게 실행 예약
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSpeedSlider);
  } else {
    initSpeedSlider();
  }

})();
