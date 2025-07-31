// ==UserScript==
// @name          새창/새탭 차단기 + iframe 차단 + Vertical Video Speed Slider (통합)
// @namespace     https://example.com/
// @version       4.0.6 // 각 로직 독립성 강화 및 iframe 배속바 재활성화
// @description   새창/새탭 차단기, iframe 차단, Vertical Video Speed Slider를 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
  'use strict';

  // 스크립트가 현재 프레임에서 이미 초기화되었는지 확인 (중복 실행 방지)
  if (window.__MySuperScriptInitialized) return;
  window.__MySuperScriptInitialized = true;

  // ================================
  // [0] 설정: 도메인 화이트리스트 및 차단 패턴
  // ================================

  const WHITELIST = [
    'accounting.auction.co.kr',
    'buy.auction.co.kr',
  ];

  const IFRAME_SKIP_DOMAINS = [];
  const IFRAME_WHITELIST = []; // 현재 iframe 차단 로직에서는 크게 사용되지 않음

  const FORCE_BLOCK_POPUP_PATTERNS = [];

  const hostname = location.hostname;
  const IS_ALLOWED_DOMAIN_FOR_POPUP = WHITELIST.some(domain =>
    hostname.includes(domain) || window.location.href.includes(domain)
  );

  // ================================
  // [1] UI 로깅 시스템
  // ================================
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
      if (entry.parentNode) entry.remove();
      if (!box.children.length) {
        box.style.opacity = '0';
        box.style.pointerEvents = 'none';
      }
    }, 10000);
  }

  createLogBox(); // 스크립트 로드 시점에 로그 박스 생성 시도

  // ================================
  // [2] 새창/새탭 차단 로직
  // ================================
  function initPopupBlocker() {
    const originalWindowOpen = window.open;
    let userInitiatedAction = false;

    const setUserInitiatedAction = () => {
      userInitiatedAction = true;
      setTimeout(() => { userInitiatedAction = false; }, 500);
    };

    // 사용자 상호작용 이벤트 리스너 (캡처링 단계에서 처리)
    document.addEventListener('click', setUserInitiatedAction, true);
    document.addEventListener('mousedown', setUserInitiatedAction, true);
    document.addEventListener('keydown', setUserInitiatedAction, true);

    const fakeWindow = new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'focus') return () => {};
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
      addLog(`🚫 window.open 차단 시도: ${url}`);

      const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
      if (isForceBlocked) {
        addLog(`🔥 강제 차단 패턴에 의해 팝업 차단됨: ${url}`);
        return fakeWindow;
      }

      if (userInitiatedAction) {
        return originalWindowOpen.apply(window, args);
      }
      return fakeWindow;
    };

    if (!IS_ALLOWED_DOMAIN_FOR_POPUP) {
      Object.defineProperty(window, 'open', { get: () => blockOpen, set: () => {}, configurable: false });
      try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.open = blockOpen; } catch {}
      try { if (window.top !== window.self) { window.parent.open = blockOpen; window.top.open = blockOpen; } } catch {}
      Object.freeze(window.open);

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
      window.setTimeout = function (fn, delay, ...args) {
        if (typeof fn === 'function' && fn.toString().includes('window.open')) {
          addLog('🚫 setTimeout 내부의 window.open 차단됨');
          return;
        }
        return origSetTimeout(fn, delay, ...args);
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
    }

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
  }

  // ================================
  // [3] IFRAME 차단 로직
  // ================================
  function initIframeBlocker() {
    const IFRAME_SKIP = IFRAME_SKIP_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );

    const processedIframes = new WeakSet();

    const processIframe = (node, trigger) => {
      if (processedIframes.has(node)) { return; }
      processedIframes.add(node);

      const rawSrc = node.getAttribute('src') || node.src || '';
      let fullSrc = rawSrc;
      const lazySrc = node.getAttribute('data-lazy-src');
      if (lazySrc) { fullSrc = lazySrc; }
      try { fullSrc = new URL(fullSrc, location.href).href; } catch {}

      addLog(`🛑 iframe 감지됨 (${trigger}): ${fullSrc}`);

      if (fullSrc === 'about:blank') {
          addLog(`✅ 'about:blank' iframe 감지됨. 스크립트에서 완전히 무시합니다.`);
          return;
      }

      // iframe 내부 window.open 차단 주입 시도 (DOMContentLoaded 이후)
      node.addEventListener('load', () => {
          if (node.contentWindow && node.contentDocument) {
              node.contentDocument.addEventListener('DOMContentLoaded', () => {
                  try {
                      Object.defineProperty(node.contentWindow, 'open', {
                          get: () => window.open, // 부모의 window.open (재정의된 blockOpen) 사용
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

      // 강제 차단 패턴에 해당하면 차단 및 경고 표시
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
          addLog(`✅ iframe 허용됨 (uBlock Origin에 의한 차단 확인 필요): ${fullSrc}`);
      }
    };

    if (!IFRAME_SKIP) {
        // MutationObserver: DOM에 새로운 iframe이 추가될 때만 감지 (subtree는 필요 없음)
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
            subtree: true // 전체 DOM 트리에서 iframe 추가 감지
        });

        // MutationObserver: 기존 iframe의 'src' 속성 변경 감지
        const iframeSrcObserver = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'src') {
                    if (m.target.tagName === 'IFRAME') {
                        // src 변경된 iframe은 재처리해야 하므로 WeakSet에서 제거 후 재처리
                        processedIframes.delete(m.target);
                        processIframe(m.target, 'src 속성 변경됨');
                    }
                }
            }
        });
        iframeSrcObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['src'],
            subtree: true // iframe의 src 변경은 하위에서도 발생 가능
        });

        // DOMContentLoaded 이후, 이미 존재하는 iframe들에 대해 초기 검사
        document.addEventListener('DOMContentLoaded', () => {
            document.querySelectorAll('iframe').forEach(iframe => {
                processIframe(iframe, '초기 로드');
            });
        });
    }
  }

  // ================================
  // [4] Vertical Video Speed Slider + 최소화 버튼
  // ================================
  function initSpeedSlider() {
    // 이 함수는 메인 프레임이든 iframe이든 스크립트가 로드되는 각 프레임에서 독립적으로 실행됨
    // 따라서 각 프레임은 자신만의 슬라이더를 가지고 자신의 비디오만 제어
    if (window.__vmSpeedSliderInjectedInThisFrame) return; // 현재 프레임에서 이미 주입되었는지 확인
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
        background: rgba(0, 0, 0, 0.5);
        padding: 10px 8px;
        border-radius: 8px 0 0 8px;
        z-index: 2147483647 !important;
        display: none; /* video가 있을 때만 flex로 변경됨 */
        flex-direction: column;
        align-items: center;
        width: 50px;
        height: auto;
        font-family: sans-serif;
        pointer-events: auto;
        opacity: 0.3;
        transition: opacity 0.3s;
        user-select: none;
        box-shadow: 0 0 5px rgba(0,0,0,0.5);
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
      // 현재 프레임의 document에서 video 요소를 찾음
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

    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', append)
      : append();

    new MutationObserver(updateSliderVisibility).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  // ================================
  // 모든 기능 초기화
  // ================================
  // document-start에 실행되어 각 기능을 초기화합니다.
  // 각 기능은 자신의 필요에 따라 DOMContentLoaded를 기다리거나 즉시 실행됩니다.
  initPopupBlocker();
  initIframeBlocker();

  // 배속 슬라이더는 iframe 내부에서도 독립적으로 작동해야 하므로,
  // 스크립트가 로드되는 각 프레임에서 이 함수를 호출합니다.
  initSpeedSlider();

})();
