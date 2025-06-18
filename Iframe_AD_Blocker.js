// ==UserScript==
// @name         Iframe Ad Blocker with src/HTML preview
// @namespace    https://yourdomain.com
// @version      2.5.2
// @description  Hide iframe ads with better logging (shows src or outerHTML), floating UI auto-hides in 10s, includes whitelist & draggable panel. No log on mobile.
// @author       YourName
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let logContainer;
  let blockedCount = 0;

  const whitelist = [
    'recaptcha',  // 캡챠
    'about:blank', // 일부 iframe 문제 해결
    'embed',  // 각종 게시물 임베드
    'naver.com/my.html',  // 네이버 메인홈에서 이메일 안보이는거 해결
    'cafe.naver.com',  // 네이버 카페
    'blog.naver.com',  // 네이버 블로그
    'goodTube',  // 유튜브 우회 스크립트
    'player.bunny-frame.online',  //티비위키/티비몬/티비핫 영상 플레이어 주소
    'lk1.supremejav.com',  // https://supjav.com/  TV영상
    'avsee.ru/player/',
    '/e/',  // 성인 영상 플레이어 주소
    '/t/',  // 성인 영상 플레이어 주소
    '/v/',  // 성인 영상 플레이어 주소
    '/#',  // 성인 영상 플레이어 주소
    '7tv000.com',  // https://7tv000.com/  7MMTV TV영상
    'cdnbuzz.buzz'  // https://av19.live/
  ];

  function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function createLogUI() {
    if (isMobile()) return; // 모바일에서는 로그창 생성 안 함

    logContainer = document.createElement('div');
    logContainer.style.cssText = `
      position: fixed;
      bottom: 10px;
      right: 10px;
      width: 400px;
      max-height: 500px;
      overflow-y: auto;
      z-index: 99999;
      background: rgba(0,0,0,0.85);
      color: white !important;
      font-size: 13px;
      padding: 12px;
      border-radius: 10px;
      box-shadow: 0 0 15px rgba(0,0,0,0.6);
      font-family: monospace;
      line-height: 1.5;
      cursor: move;
    `;

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '❌';
    closeBtn.style.cssText = `
      position: absolute;
      top: 5px;
      right: 10px;
      cursor: pointer;
      font-size: 14px;
      color: white !important;
    `;
    closeBtn.onclick = () => logContainer.remove();

    const header = document.createElement('div');
    header.innerHTML = '<b style="font-size:14px;">🛡️ Iframe Ad Block Log</b><hr>';
    header.style.cursor = 'move';
    header.style.color = 'white';

    logContainer.appendChild(closeBtn);
    logContainer.appendChild(header);
    document.body.appendChild(logContainer);

    makeDraggable(logContainer, header);

    setTimeout(() => {
      if (logContainer && document.body.contains(logContainer)) {
        logContainer.remove();
      }
    }, 10000);
  }

  function makeDraggable(container, handle) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - container.getBoundingClientRect().left;
      offsetY = e.clientY - container.getBoundingClientRect().top;
      container.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        container.style.left = `${e.clientX - offsetX}px`;
        container.style.top = `${e.clientY - offsetY}px`;
        container.style.right = 'auto';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      container.style.cursor = 'move';
    });

    // 더블클릭 시 드래그 시작 트리거
    handle.addEventListener('dblclick', () => {
      handle.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: container.offsetLeft + 5,
        clientY: container.offsetTop + 5
      }));
    });
  }

  function updateLog(iframe, count) {
    if (!logContainer) return;

    const src = iframe.src || '';
    const displayText = src
      ? src.slice(0, 150)
      : iframe.outerHTML.slice(0, 100).replace(/\n/g, '').replace(/\s+/g, ' ');

    const item = document.createElement('div');
    item.textContent = `[${count}] ${displayText}`;
    item.style.color = 'white';
    logContainer.appendChild(item);

    const entries = logContainer.querySelectorAll('div');
    if (entries.length > 11) {
      logContainer.removeChild(entries[2]);
    }
  }

  function blockIframeAds() {
    const iframes = document.getElementsByTagName('iframe');

    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      const src = iframe.src || '';

      if (whitelist.some(domain => src.includes(domain))) continue;
      if (iframe.style.display === 'none') continue;

      iframe.style.display = 'none';
      blockedCount++;
      updateLog(iframe, blockedCount);
    }
  }

  function initialize() {
    createLogUI();
    blockIframeAds();

    const observer = new MutationObserver(() => {
      blockIframeAds();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('unload', () => {
      observer.disconnect();
    });
  }

  if (document.body) {
    initialize();
  } else {
    window.addEventListener('DOMContentLoaded', initialize);
  }
})();
