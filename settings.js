// ==UserScript==
// @name         새창/새탭 차단기 + iframe 차단 + Vertical Video Speed Slider
// @namespace    https://example.com/
// @version      3.8.2
// @description  새창/새탭 차단기 + iframe 차단 + Vertical Video Speed Slider (트위터 예외 처리 추가)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ================================
  // [0] 설정: 도메인 화이트리스트
  // ================================

  const WHITELIST = ['escrow.auction.co.kr']; // 새탭/새창 제외할 도메인 (window.open 차단 등도 무시)
  const IFRAME_WHITELIST = [
    '/recaptcha/',  // 캡챠
    'escrow.auction.co.kr',  // 옥션
    '/movie_view',  // 디시인사이드 동영상
    '/player',  // 티비위키.티비몬.티비핫 플레이어
    '/embed/',  // 커뮤니티 등 게시물 동영상 삽입
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
    if (!box) return;  // 로그 박스가 없으면 함수 종료
    box.style.opacity = '1';  // 로그 박스 표시
    box.style.pointerEvents = 'auto';  // 로그 박스 인터랙션 가능하게 설정
    const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;  // 로그 메시지
    entry.style.textAlign = 'left';
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;  // 스크롤을 최신 로그로 이동
    setTimeout(() => {
      entry.remove();
      if (!box.children.length) {
        box.style.opacity = '0';
        box.style.pointerEvents = 'none';  // 로그 박스 숨기기
      }
    }, 10000);  // 10초 후에 로그 삭제
  }

  // ================================
  // [1] 팝업 차단 및 링크 새탭 열기 방지
  // ================================
  let openedWindows = new Set();  // 이미 열린 새 창을 추적하는 변수
  let userClickedLinks = new Set();  // 사용자가 클릭한 링크 추적

  // 사용자가 클릭한 링크만 허용
  document.addEventListener('click', function (e) {
    const target = e.target;

    // 링크 클릭 시
    const a = target.closest('a');
    if (a && a.href) {
      userClickedLinks.add(a.href);  // 클릭한 링크 저장
    }
  });

  // window.open 차단
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

    // 사용자가 클릭한 링크만 새 탭을 열 수 있도록 허용
    if (userClickedLinks.has(url)) {
      openedWindows.add(url);
      return window.open(url, '_blank');
    }

    // 그렇지 않으면 창을 차단하고 닫음
    return fakeWindow;  // window.open 차단
  };

  Object.defineProperty(window, 'open', {
    get: () => blockOpen,
    set: () => {},
    configurable: false
  });
  try { unsafeWindow.open = blockOpen; } catch {}
  try {
    if (window.top !== window.self) {
      window.parent.open = blockOpen;
      window.top.open = blockOpen;
    }
  } catch {}
  Object.freeze(window.open);

  // 이미 열린 새 창 차단
  const detectWindowOpen = (url) => {
    if (openedWindows.has(url)) {
      addLog(`🚫 이미 열린 창/탭 차단: ${url}`);
      return false;
    }
    openedWindows.add(url);
    return true;
  };

  // URL 클릭을 통한 새 탭 차단
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a[target]');
    if (!a) return;
    const url = a.href;

    // 나머지 링크는 기존 차단 로직을 따름
    if (['_blank', '_new'].includes(a.target)) {
      if (!detectWindowOpen(url)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    // "javascript:" 링크 차단
    if (a.href && a.href.startsWith("javascript:")) {
      addLog(`🚫 javascript 링크 차단됨: ${a.href}`);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 중간 클릭과 단축키로 새 탭 열기 차단
  document.addEventListener('mousedown', function (e) {
    if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
      const a = e.target.closest('a');
      if (a?.target === '_blank') {
        const url = a.href;
        if (!detectWindowOpen(url)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    }
  }, true);

  // 동적 링크의 target=_blank 속성 차단
  const origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...args) {
    const el = origCreateElement.call(this, tag, ...args);
    if (tag.toLowerCase() === 'a') {
      const origSetAttr = el.setAttribute;
      el.setAttribute = function (name, value) {
        if (name === 'target' && ['_blank', '_new'].includes(value)) {
          const href = el.href;

        // 트위터와 같은 도메인은 예외 처리 (여기에 추가)
        if (href.includes('twitter.com')) {
          return origSetAttr.call(this, name, value); // 예외 처리된 링크는 허용
        }
          // 나머지 링크는 차단
          addLog(`🚫 동적 링크 target 차단됨: ${el.href || el.outerHTML}`);
          return;
        }
        return origSetAttr.call(this, name, value);
      };
    }
    return el;
  };

  // Form에서 새 탭으로 제출되는 것을 차단
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (form?.target === '_blank') {
      e.preventDefault();
      e.stopImmediatePropagation();
      addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
    }
  }, true);

  // 배경에서 실행되는 스크립트 차단
  const interceptScript = (script) => {
    if (script.src && script.src.includes("window.open")) {
      addLog(`🚫 배경 스크립트 실행 차단됨: ${script.src}`);
      script.remove();
    }
  };

  const scripts = document.getElementsByTagName("script");
  Array.from(scripts).forEach(interceptScript);

  // ================================
  // [2] iframe 감시 (차단된 도메인에서만 실행)
  // ================================
  if (!IFRAME_SKIP) {
    const iframeObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'IFRAME') {
            // lazy load가 적용된 iframe일 경우
            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            // data-lazy-src 속성 처리
            const lazySrc = node.getAttribute('data-lazy-src');
            if (lazySrc) {
              fullSrc = lazySrc;
            }

            try {
              //fullSrc = new URL(rawSrc, location.href).href;
              fullSrc = new URL(fullSrc, location.href).href;
            } catch {}

            // Debug: Log iframe src
            addLog(`🛑 iframe 감지됨: ${fullSrc}`);

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
        background: transparent;
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
