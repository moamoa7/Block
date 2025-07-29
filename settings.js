// ==UserScript==
// @name          새창/새탭 차단기 + iframe 차단 + Vertical Video Speed Slider
// @namespace     https://example.com/
// @version       3.8.5
// @description   새창/새탭 차단기 + iframe 차단 + Vertical Video Speed Slider (새창 열기 감시 문제 해결)
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
  'use strict';

  // ================================
  // [0] 설정: 도메인 화이트리스트
  // ================================

  const WHITELIST = [
    'escrow.auction.co.kr',
  ];

  const IFRAME_WHITELIST = [
    '/recaptcha/',
    'escrow.auction.co.kr',
    '/movie_view',
    '/player',
    '/embed/',
    'player.bunny-frame.online',
    'pcmap.place.naver.com/',
    'supremejav.com',
    '/e/', '/t/', '/v/',
  ];

  const IFRAME_SKIP_DOMAINS = ['auth.openai.com',];

  const hostname = location.hostname;

  console.log('현재 hostname:', hostname);
  console.log('화이트리스트:', WHITELIST);

  const IS_ALLOWED_DOMAIN_FOR_POPUP = WHITELIST.some(domain =>
    hostname.includes(domain) || window.location.href.includes(domain)
  );

  console.log('IS_ALLOWED_DOMAIN_FOR_POPUP 값:', IS_ALLOWED_DOMAIN_FOR_POPUP);

  if (IS_ALLOWED_DOMAIN_FOR_POPUP) {
    console.log(`${hostname}은 팝업 허용 화이트리스트에 포함됨. window.open 재정의를 건너뜀.`);
    // If the domain is whitelisted, do NOT proceed with window.open blocking.
    // However, we still want to run iframe and video speed slider logic.
  } else {
    console.log(`${hostname}은 팝업 허용 화이트리스트에 포함되지 않음. window.open을 차단합니다.`);

    // Store a reference to the original window.open before it's modified
    const originalWindowOpen = window.open;

    // ================================
    // [1] 팝업 차단 및 링크 새탭 열기 방지 (ONLY IF NOT WHITELISTED FOR POPUPS)
    // ================================
    let userClickedLinks = new Set();

    document.addEventListener('click', function (e) {
      const target = e.target;
      const a = target.closest('a');
      if (a && a.href) {
        console.log(`링크 클릭됨: ${a.href}`);
        userClickedLinks.add(a.href);
      }
    });

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
      addLog(`🚫 window.open 차단됨: ${url}`);

      // This part is now simplified, as the outer IS_ALLOWED_DOMAIN_FOR_POPUP check
      // determines if blockOpen is even assigned to window.open.
      // So, if we reach here, it means we are NOT on a whitelisted popup domain.
      // Therefore, we only allow if user explicitly clicked the *exact* URL.
      if (userClickedLinks.has(url)) {
          // This case should ideally not happen if the `javascript:` link is causing issues,
          // as userClickedLinks won't contain the final target URL.
          // This path might be useful for standard a[target="_blank"] clicks.
          console.log(`사용자가 클릭한 링크: ${url} - 허용 (비-화이트리스트 도메인이지만 직접 클릭함)`);
          return originalWindowOpen.apply(window, args);
      }

      console.log(`URL ${url}은 클릭되지 않았거나 화이트리스트 도메인이 아니므로 차단됩니다.`);
      return fakeWindow;
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

    // "javascript:" 링크 차단
    document.addEventListener('click', function (e) {
      const a = e.target.closest('a');
      if (!a) return;

      const url = a.href;

      if (url && url.startsWith("javascript:")) {
        // javascript 링크에서 window.open 사용 시 차단
        if (url.includes('window.open')) {
          addLog(`🚫 javascript 링크 (window.open) 차단됨: ${url}`);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        // 추가로 다른 javascript 링크 처리할 경우
        console.log(`javascript 링크 클릭됨: ${link}`);
        // javascript 링크의 경우 차단 또는 허용하는 로직 추가 가능
        e.preventDefault();  // 예시로 차단 처리
        return;
      }
    }, true);



    // Intermediate clicks and hotkeys to block new tab opening
    document.addEventListener('mousedown', function (e) {
      if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) {
        const a = e.target.closest('a');
        if (a?.target === '_blank') {
          const url = a.href;
          e.preventDefault();
          e.stopImmediatePropagation();
          // Directly call blockOpen to handle this
          blockOpen(url, '_blank');
        }
      }
    }, true);

    // Dynamic link target=_blank blocking
    const origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, ...args) {
      const el = origCreateElement.call(this, tag, ...args);
      if (tag.toLowerCase() === 'a') {
        const origSetAttr = el.setAttribute;
        el.setAttribute = function (name, value) {
          if (name === 'target' && ['_blank', '_new'].includes(value)) {
            const href = el.href;
            if (href.includes('twitter.com')) {
              return origSetAttr.call(this, name, value);
            }
            addLog(`🚫 동적 링크 target 차단됨: ${el.href || el.outerHTML}`);
            return;
          }
          return origSetAttr.call(this, name, value);
        };
      }
      return el;
    };

    // Form target=_blank submission blocking
    document.addEventListener('submit', function (e) {
      const form = e.target;
      if (form?.target === '_blank') {
        e.preventDefault();
        e.stopImmediatePropagation();
        addLog(`🚫 form[target="_blank"] 제출 차단: ${form.action || '(no action)'}`);
      }
    }, true);

    // Background script blocking (still simplistic, consider refining if needed)
    const interceptScript = (script) => {
      if (script.src && script.src.includes("window.open")) {
        addLog(`🚫 배경 스크립트 실행 차단됨: ${script.src}`);
        script.remove();
      }
    };

    const scripts = document.getElementsByTagName("script");
    Array.from(scripts).forEach(interceptScript);
  } // End of window.open blocking scope

  // IFRAME and Video Speed Slider logic runs regardless of popup whitelist
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
    }, 10000);
  }

  if (!IFRAME_SKIP) {
    const iframeObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'IFRAME') {
            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            const lazySrc = node.getAttribute('data-lazy-src');
            if (lazySrc) {
              fullSrc = lazySrc;
            }
            try {
              fullSrc = new URL(fullSrc, location.href).href;
            } catch {}
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
