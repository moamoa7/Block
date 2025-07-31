// ==UserScript==
// @name          새창/새탭 차단기 + iframe 차단 (수동) + Vertical Video Speed Slider
// @namespace     https://example.com/
// @version       4.0.0 // 버전 업데이트 (수정 내용 반영)
// @description   새창/새탭 차단기 + iframe 차단 (수동) + about:blank 예외처리 + javascript 예외처리 (uBlock Origin과 완벽 호환) + Vertical Video Speed Slider
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
  'use strict';

  // ================================
  // [0] 설정: 도메인 화이트리스트 및 차단 패턴
  // ================================

  // 새탭/새창 제외할 도메인 (window.open 차단 등도 무시)
  // 여기에 팝업/새 탭 차단을 해제할 도메인을 추가하세요.
  // 이 도메인들은 window.open 및 'javascript:' 링크 차단에서 제외됩니다.
  const WHITELIST = [
    'accounting.auction.co.kr',
    'buy.auction.co.kr',
  ];

  // 프레임 차단 제외할 도메인 (iframe 차단 로직 자체를 건너뛸 도메인)
  const IFRAME_SKIP_DOMAINS = [''];

  // 프레임 차단 제외할 패턴 형식 (도메인 일부만 넣음)
  const IFRAME_WHITELIST = [''];

  // 새탭/새창 무조건 차단 (새 창으로 튀어나오는 도메인 - about:blank 변경 후 메시지 출력) : ublock 에서 안되는 것만 등록 할 것
  // 등록된 '악성 팝업 유발' iframe만 src="about:blank"로 변경하고 완전히 숨김
  // 여기에 추가적으로 차단하고 싶은 도메인/패턴을 추가하세요.
  // 예: '.xyz', 'popup-ads.com', 'redirect-tracker.io'
  const FORCE_BLOCK_POPUP_PATTERNS = [''];

  const hostname = location.hostname;

  console.log('현재 hostname:', hostname);
  console.log('화이트리스트:', WHITELIST);

  const IS_ALLOWED_DOMAIN_FOR_POPUP = WHITELIST.some(domain =>
    hostname.includes(domain) || window.location.href.includes(domain)
  );

  console.log('IS_ALLOWED_DOMAIN_FOR_POPUP 값:', IS_ALLOWED_DOMAIN_FOR_POPUP);

  // Function for adding logs to the UI box
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
    // Remove old logs after 10 seconds
    setTimeout(() => {
      entry.remove();
      if (!box.children.length) {
        box.style.opacity = '0';
        box.style.pointerEvents = 'none';
      }
    }, 10000);
  }

  createLogBox(); // Ensure log box is created early

  // Define blockOpen function outside the if-else block to be accessible by iframe logic
  const originalWindowOpen = window.open;
  let userInitiatedAction = false;

  const setUserInitiatedAction = () => {
    userInitiatedAction = true;
    // 사용자 상호작용 플래그는 짧은 시간만 유효하게 유지 (예: 500ms)
    setTimeout(() => {
      userInitiatedAction = false;
    }, 500);
  };

  // Listen for common user interaction events on the document
  // capture: true 를 사용하여 이벤트 캡처링 단계에서 먼저 처리
  document.addEventListener('click', setUserInitiatedAction, true);
  document.addEventListener('mousedown', setUserInitiatedAction, true);
  document.addEventListener('keydown', setUserInitiatedAction, true);

  const fakeWindow = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'focus') {
        return () => {};
      }
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
    console.log(`Attempting to block URL: ${url}`);
    addLog(`🚫 window.open 차단 시도: ${url}`);

    // 강제 차단 패턴에 있는 URL은 사용자 상호작용과 관계없이 무조건 차단
    const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
    if (isForceBlocked) {
      addLog(`🔥 강제 차단 패턴에 의해 팝업 차단됨: ${url}`);
      return fakeWindow; // 강제 차단
    }

    // 그 다음 사용자 상호작용을 검사합니다.
    if (userInitiatedAction) {
      console.log(`사용자 상호작용 감지됨 (강제 차단 패턴 아님): ${url} - 허용`);
      return originalWindowOpen.apply(window, args);
    }

    console.log(`URL ${url}은 사용자 상호작용 없이 호출되었으므로 차단됩니다.`);
    return fakeWindow;
  };

  // 팝업 허용 화이트리스트에 없는 경우에만 window.open 및 관련 차단 기능 재정의
  if (IS_ALLOWED_DOMAIN_FOR_POPUP) {
    console.log(`${hostname}은 팝업 허용 화이트리스트에 포함됨. 팝업 및 'javascript:' 링크 차단을 건너뜀.`);
  } else {
    console.log(`${hostname}은 팝업 허용 화이트리스트에 포함되지 않음. 팝업 및 'javascript:' 링크를 차단합니다.`);

    // window.open 재정의
    Object.defineProperty(window, 'open', {
      get: () => blockOpen,
      set: () => {},
      configurable: false // 재정의 불가능하게 설정
    });
    // 최상위 및 부모 프레임의 window.open도 재정의 시도 (크로스-오리진 정책에 의해 막힐 수 있음)
    try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.open = blockOpen; } catch {} // Greasemonkey 등 환경
    try {
      if (window.top !== window.self) {
        window.parent.open = blockOpen;
        window.top.open = blockOpen;
      }
    } catch {}
    Object.freeze(window.open); // 동결

    // "javascript:" 링크 차단
    document.addEventListener('click', function (e) {
      const a = e.target.closest('a');
      if (!a) return;

      const url = a.href;

      if (url && url.startsWith("javascript:")) {
        if (url.includes('window.open')) {
          addLog(`🚫 javascript 링크 (window.open) 차단됨: ${url}`);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        // window.open을 포함하지 않는 javascript: 링크는 기본 동작 허용
        console.log(`javascript 링크 클릭됨: ${url}`);
        return;
      }
    }, true); // 캡처링 단계에서 처리

    // 마우스 중간 클릭 및 Ctrl/Meta/Shift 키 조합으로 새 탭 열기 차단
    document.addEventListener('mousedown', function (e) {
      if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) { // 중간 클릭 또는 Ctrl/Meta/Shift 키
        const a = e.target.closest('a');
        if (a?.target === '_blank') { // target="_blank" 링크인 경우
          const url = a.href;
          e.preventDefault(); // 기본 동작(새 탭 열림) 방지
          e.stopImmediatePropagation(); // 이벤트 전파 중단
          // 이후 blockOpen 로직에 따라 처리될 수 있도록 함
          blockOpen(url, '_blank');
        }
      }
    }, true); // 캡처링 단계에서 처리

    // 동적으로 생성되는 target="_blank" 링크 차단
    const origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, ...args) {
      const el = origCreateElement.call(this, tag, ...args);
      if (tag.toLowerCase() === 'a') {
        const origSetAttr = el.setAttribute;
        el.setAttribute = function (name, value) {
          if (name === 'target' && ['_blank', '_new'].includes(value)) {
            const href = el.href;
            if (href && href.includes('twitter.com')) { // twitter.com 링크 예외 처리 (필요시 제거)
              return origSetAttr.call(this, name, value);
            }
            addLog(`🚫 동적 링크 target="_blank" 설정 차단됨: ${el.href || el.outerHTML}`);
            return; // target="_blank" 설정 차단
          }
          return origSetAttr.call(this, name, value);
        };
      }
      return el;
    };

    // form target="_blank" 제출 차단
    document.addEventListener('submit', function (e) {
      const form = e.target;
      if (form?.target === '_blank') {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
      }
    }, true); // 캡처링 단계에서 처리
  } // End of window.open blocking scope

  // ================================
  // IFRAME 차단 및 Vertical Video Speed Slider 로직
  // (팝업 화이트리스트와 관계없이 실행)
  // ================================

  const IFRAME_SKIP = IFRAME_SKIP_DOMAINS.some(domain =>
    hostname === domain || hostname.endsWith('.' + domain)
  );

  // isIframeAllowed 함수는 현재 iframe 차단 로직에서 직접 사용되지 않습니다.
  // 대신 FORCE_BLOCK_POPUP_PATTERNS를 사용하여 uBlock Origin과의 호환성을 높였습니다.
  function isIframeAllowed(src) {
    try {
      const url = new URL(src, location.href);
      return IFRAME_WHITELIST.some(pattern => url.href.includes(pattern));
    } catch {
      return false;
    }
  }

  // iframe 처리 헬퍼 함수
  const processIframe = (node, trigger) => {
    const rawSrc = node.getAttribute('src') || node.src || '';
    let fullSrc = rawSrc;
    const lazySrc = node.getAttribute('data-lazy-src');
    if (lazySrc) {
        fullSrc = lazySrc;
    }
    try {
        fullSrc = new URL(fullSrc, location.href).href;
    } catch {}

    addLog(`🛑 iframe 감지됨 (${trigger}): ${fullSrc}`);
    const style = getComputedStyle(node);
    const display = style.display || '(unknown)';

    // 강제 차단 패턴에 src가 일치하는지 확인
    const isForceBlockedIframeSrc = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => fullSrc.includes(pattern));

    // 1. about:blank 프레임은 무시합니다.
    if (fullSrc === 'about:blank') {
        addLog(`✅ 'about:blank' iframe 감지됨. 스크립트에서 완전히 무시합니다.`);
        return; // about:blank는 여기서 완전히 처리 배제
    }

    // 2. 모든 iframe에 대해 window.open 차단 주입을 시도합니다.
    // 이는 크로스-오리진 정책으로 막힐 수 있지만, 시도하는 것이 안전합니다.
    try {
        node.addEventListener('load', () => {
            if (node.contentWindow) {
              try {
                  Object.defineProperty(node.contentWindow, 'open', {
                      get: () => blockOpen,
                      set: () => {},
                      configurable: false
                  });
                  Object.freeze(node.contentWindow.open);
                  addLog(`✅ iframe 내부 window.open 차단 주입 성공 (on load): ${fullSrc}`);
              } catch (e) {
                  addLog(`⚠️ iframe 내부 window.open 차단 주입 실패 (접근 오류 on load): ${e.message}`);
              }
            }
        }, { once: true });

        if (node.contentWindow && node.contentWindow.document.readyState !== 'loading') {
            Object.defineProperty(node.contentWindow, 'open', {
                get: () => blockOpen,
                set: () => {},
                configurable: false
            });
            Object.freeze(node.contentWindow.open);
            addLog(`✅ iframe 내부 window.open 차단 즉시 주입 성공: ${fullSrc}`);
        }
    } catch (e) {
        addLog(`⚠️ iframe 내부 window.open 차단 시도 실패: ${e.message}`);
    }

    // 3. 이제 오직 '강제 차단 패턴'에 걸리는 iframe만 src를 about:blank로 바꾸고 경고 메시지를 표시합니다.
    // 기존의 'isIframeAllowed' 검사는 제거되어 uBlock Origin이 일반 iframe을 처리할 수 있도록 합니다.
    if (isForceBlockedIframeSrc) {
        addLog(`🛑 강제 차단 패턴에 의해 iframe 차단됨 (src: ${fullSrc}, display: ${display})`);
        node.src = 'about:blank'; // 콘텐츠 로딩 방지를 위해 src를 about:blank로 강제 설정
        node.removeAttribute('srcdoc'); // srcdoc 속성도 제거

        // **!!! 여기부터 수정된 부분 !!!**
        // iframe 자체를 완전히 숨깁니다.
        node.style.cssText += `
            display: none !important;
            visibility: hidden !important;
            width: 0px !important;
            height: 0px !important;
            pointer-events: none !important;
        `;

        // 경고 메시지 표시를 위한 새로운 로직 (iframe을 DOM에서 제거하지 않고 오버레이)
        try {
            const warning = document.createElement('div');
            warning.innerHTML = `
                🚫 차단된 iframe입니다<br>
                <small style="font-size:14px; color:#eee; user-select:text;">${fullSrc}</small>
            `;
            warning.style.cssText = `
                position: fixed !important; /* iframe 위에 겹쳐지도록, 화면에 고정 */
                top: ${node.getBoundingClientRect().top}px !important; /* 원본 iframe 위치 */
                left: ${node.getBoundingClientRect().left}px !important; /* 원본 iframe 위치 */
                width: ${node.getBoundingClientRect().width}px !important; /* 원본 iframe 크기 */
                height: ${node.getBoundingClientRect().height}px !important; /* 원본 iframe 크기 */
                display: flex !important; flex-direction: column !important; justify-content: center !important; align-items: center !important;
                color: #fff !important;
                background: rgba(211, 47, 47, 0.9) !important; /* 빨간색 반투명 배경 */
                padding: 6px 10px !important;
                font-size: 14px !important;
                font-family: monospace !important;
                border-radius: 4px !important;
                user-select: text !important;
                word-break: break-all !important;
                z-index: 2147483647 !important; /* 최상위 z-index */
                box-sizing: border-box !important; /* 패딩이 전체 크기에 포함되도록 */
                opacity: 1 !important; /* 완전 불투명하게 */
                pointer-events: auto !important; /* 경고 메시지 클릭 가능하게 */
            `;

            // 닫기 버튼 추가
            const removeBtn = document.createElement('button');
            removeBtn.textContent = 'X';
            removeBtn.style.cssText = `
                position: absolute !important; top: 2px !important; right: 5px !important; background: none !important; border: none !important; color: white !important; cursor: pointer !important; font-weight: bold !important; font-size: 16px !important;
            `;
            removeBtn.onclick = (e) => {
                e.stopPropagation(); // 버튼 클릭이 다른 곳으로 전파되는 것을 막음
                warning.remove();
                addLog(`ℹ️ 사용자 요청으로 차단 메시지 제거: ${fullSrc}`);
            };
            warning.prepend(removeBtn);

            document.body.appendChild(warning); // body에 추가

            // 10초 후 자동 제거
            setTimeout(() => {
                if (warning.parentNode) {
                    warning.remove();
                    addLog(`ℹ️ 자동 제거된 차단 메시지: ${fullSrc}`);
                }
            }, 10000);

        } catch (e) {
            addLog(`⚠️ 경고 메시지 표시 실패: ${e.message}`);
        }
    } else {
        // uBlock Origin에게 처리를 위임한다는 것을 명확히 함
        addLog(`✅ iframe 허용됨 (uBlock Origin에 의한 차단 확인 필요): ${fullSrc}`);
    }
  };


  if (!IFRAME_SKIP) {
    // MutationObserver를 사용하여 DOM에 iframe이 추가되거나 src 속성이 변경될 때 감지
    const iframeObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'childList') { // 새로운 노드가 추가된 경우
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && node.tagName === 'IFRAME') {
              processIframe(node, 'DOM 추가됨');
            }
          }
        } else if (m.type === 'attributes' && m.attributeName === 'src') { // src 속성이 변경된 경우
          if (m.target.tagName === 'IFRAME') {
            processIframe(m.target, 'src 속성 변경됨');
          }
        }
      }
    });

    // 문서 전체를 관찰
    iframeObserver.observe(document.documentElement, {
      childList: true, // 자식 노드 변경 감지
      subtree: true,    // 모든 하위 노드까지 감지
      attributes: true, // 속성 변경 감지
      attributeFilter: ['src'] // 'src' 속성만 필터링하여 감지
    });
  }

  // ================================
  // Video Speed Slider 기능
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
        background: rgba(0,0,0,0.5); /* Semi-transparent background */
        padding: 10px 8px;
        border-radius: 8px 0 0 8px;
        z-index: 2147483647 !important;
        display: none; /* Initial state, will be 'flex' if video exists */
        flex-direction: column;
        align-items: center;
        width: 50px;
        height: auto;
        font-family: sans-serif;
        pointer-events: auto;
        opacity: 0.3;
        transition: opacity 0.3s;
        user-select: none;
        box-shadow: 0 0 5px rgba(0,0,0,0.5); /* Add a subtle shadow */
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
        background: #555; /* Slider track color */
        border-radius: 5px;
      }
      /* Slider thumb style (for better visibility) */
      #vm-speed-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          background: #f44336; /* Red thumb */
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

    // 초기 상태: 최소화
    slider.style.display = 'none';
    resetBtn.style.display = 'none';
    valueDisplay.style.display = 'none';
    toggleBtn.textContent = '🔼'; // 최소화 시 위쪽 화살표

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

    // 전체 화면 모드 시 슬라이더 위치 조정
    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement;
      if (fsEl) fsEl.appendChild(container); // 전체 화면 요소에 포함
      else if (!document.body.contains(container)) document.body.appendChild(container); // 아니면 body에 포함
    });

    // 동영상 요소 존재 여부에 따라 슬라이더 가시성 업데이트
    const updateSliderVisibility = () => {
      const hasVideo = document.querySelectorAll('video').length > 0;
      container.style.display = hasVideo ? 'flex' : 'none';
    };

    const append = () => {
      if (!document.body.contains(container)) {
        document.body.appendChild(container);
      }
      updateSliderVisibility(); // 초기 가시성 설정
    };

    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', append)
      : append();

    // 동적으로 비디오 요소가 추가되는지 관찰하여 슬라이더 가시성 업데이트
    new MutationObserver(updateSliderVisibility).observe(document.documentElement, {
      childList: true, subtree: true
    });
  }

  // 스크립트 로드 상태에 따라 기능 초기화
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', () => {
        initSpeedSlider();
      })
    : (() => {
        initSpeedSlider();
      })();
})();
