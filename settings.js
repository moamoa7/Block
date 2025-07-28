// ==UserScript==
// @name         새창/새탭 완전 차단기 + iframe 고급 차단 + 레이어 제거 (비활성화) + 의심 iframe 감시 + 경고 메시지 표시 + Vertical Video Speed Slider + 배속바 변경 (최소화 등)
// @namespace    https://example.com/
// @version      3.7.5
// @description  window.open 차단 + 팝업/레이어 제거(비활성화) + iframe src/스타일 감시 + 허용 문자열 포함 시 예외 + 차단 iframe 경고 메시지 + 자동 사라짐 + 영상 배속 슬라이더(iframe 내부 포함)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ================================
  // [0] 설정: 도메인 화이트리스트 / iframe 예외 / iframe 차단 무시
  // ================================

  const WHITELIST = ['escrow.auction.co.kr']; // 전체 스크립트 제외할 도메인 (window.open 차단 등도 무시)
  const IFRAME_WHITELIST = [
    '/recaptcha/',  // 캡챠
    'escrow.auction.co.kr',  // 옥션
    '/movie_view',  // 디시인사이드 동영상
    '/player',  // 티비위키.티비몬.티비핫 플레이어  https://05.avsee.ru/  https://sextb.date/ US영상(player.upn.one)
    '/embed/',  // 커뮤니티 등 게시물 동영상 삽입 (유튜브.트위치.인스타 등 - https://poooo.ml/등에도 적용)  쏘걸 등 성인영상
    'player.bunny-frame.online',  // 티비위키.티비몬.티비핫 플레이어
    'pcmap.place.naver.com/',  // 네이버 지도
    'supremejav.com',  // https://supjav.com/
    '/e/', '/t/', '/v/', // 각종 성인 영상
  ];

  const IFRAME_SKIP_DOMAINS = ['auth.openai.com',]; // iframe 감시 자체를 하지 않을 도메인

  const hostname = location.hostname;

  const IS_ALLOWED = WHITELIST.some(domain =>
    hostname === domain || hostname.endsWith('.' + domain)
  );

  const IFRAME_SKIP = IFRAME_SKIP_DOMAINS.some(domain =>
    hostname === domain || hostname.endsWith('.' + domain)
  );

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
    const append = () => document.body.appendChild(box);
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', append)
      : append();
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

  // ================================
  // [1] 팝업 차단 및 링크 새탭 열기 방지
  // ================================
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
      if (!a) return;
      if (e.isTrusted && e.button === 0) return;
      if (['_blank', '_new'].includes(a.target)) {
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

    // ================================
    // [2] iframe 감시 (차단된 도메인에서만 실행)
    // ================================
    if (!IFRAME_SKIP) {
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
                    <small style="font-size:14px; color:#eee; user-select:text;">${fullSrc}</small>
                  `;
                  warning.style.cssText = `
                    color: #fff;
                    background: #d32f2f;
                    padding: 6px 10px;
                    font-size: 14px;
                    font-family: monospace;
                    border-radius: 4px;
                    user-select: text;
                    max-width: 90vw;
                    word-break: break-all;
                  `;
                  node.parentNode.replaceChild(warning, node);
                  setTimeout(() => warning.remove(), 10000);
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
  }

  createLogBox();

    // ================================
  // [3] Vertical Video Speed Slider + 최소화 버튼
  // ================================
  function initSpeedSlider() {
    if (window.__vmSpeedSliderInjected) return;
    window.__vmSpeedSliderInjected = true;

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
        //background: rgba(0, 0, 0, 0.05);
        background: transparent; /* ← 투명 */
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
      }
      #vm-speed-value { color: red; font-size: 18px; }
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
    slider.max = '4';
    slider.step = '0.2';
    slider.value = '1';
    slider.id = 'vm-speed-slider';

    const valueDisplay = document.createElement('div');
    valueDisplay.id = 'vm-speed-value';
    valueDisplay.textContent = 'x1.00';

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'vm-speed-toggle-btn';
    toggleBtn.textContent = '🔽';

    let isMinimized = true;   // ← 기본값을 최소화로 설정

    // 초기 최소화 상태 적용
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

    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      if (fsEl) fsEl.appendChild(container);
      else if (!document.body.contains(container)) document.body.appendChild(container);
    });

    const updateSliderVisibility = () => {
      const hasVideo = document.querySelectorAll('video').length > 0;
      container.style.display = hasVideo ? 'flex' : 'none';
    };

    const append = () => {
      if (!document.body.contains(container)) {
        document.body.appendChild(container);
      }
      updateSliderVisibility();
    };

    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', append)
      : append();

    new MutationObserver(updateSliderVisibility).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', initSpeedSlider)
    : initSpeedSlider();
})();
