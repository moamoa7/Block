// ==UserScript==
// @name         Iframe Ad Blocker
// @namespace    none
// @version      2.3
// @description  Hide iframe ads with a floating log UI that auto-hides after 10 seconds. Includes whitelist and draggable panel. No persistent storage used.
// @author       YourName
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let logContainer;
  let blockedCount = 0;

  const whitelist = [
    'recaptcha',  // 로봇 확인용
    'about:blank',  // 일부 프레임 문제 해결
    'embed',  // 각종 프레임 영상 삽입
    'naver.com/my.html',  //네어버 메인 - 이메일 클릭시 안보이는거 해결
    'cafe.naver.com',  // 네이버 카페
    'blog.naver.com',  // 네이버 블로그
    'goodTube',  // 유튜브 우회 스크립트
    'player.bunny-frame.online',  // 티비위키/티비몬/티비핫 플레이어
    'lk1.supremejav.com',  // supjav.com
    'avsee.ru/player/',  // AvseeTV
    '/e/',  // 성인영상 플레이어 주소
    '/t/',  // 성인영상 플레이어 주소
    '/v/'  // 성인영상 플레이어 주소
  ];

  function createLogUI() {
    logContainer = document.createElement('div');
    logContainer.style.cssText = `
      position: fixed;
      top: 10px;
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

    makeDraggable(logContainer);

    // 🕒 Auto-remove after 10 seconds
    setTimeout(() => {
      if (logContainer && document.body.contains(logContainer)) {
        logContainer.remove();
      }
    }, 10000);
  }

  function makeDraggable(element) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    element.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN') return; // avoid dragging by close button
      isDragging = true;
      offsetX = e.clientX - element.getBoundingClientRect().left;
      offsetY = e.clientY - element.getBoundingClientRect().top;
      element.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        element.style.left = `${e.clientX - offsetX}px`;
        element.style.top = `${e.clientY - offsetY}px`;
        element.style.right = 'auto';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      element.style.cursor = 'move';
    });
  }

  function updateLog(src, count) {
    if (!logContainer) return;

    const item = document.createElement('div');
    const srcDisplay = src ? src.slice(0, 150) : '(no src)';
    item.textContent = `[${count}] ${srcDisplay}`;
    item.style.color = 'white';
    logContainer.appendChild(item);

    const entries = logContainer.querySelectorAll('div');
    if (entries.length > 11) {
      logContainer.removeChild(entries[2]); // Remove oldest log entry (preserve header & close)
    }
  }

  function blockIframeAds() {
    const iframes = document.getElementsByTagName('iframe');

    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      const src = iframe.src || '';

      if (whitelist.some(domain => src.includes(domain))) {
        continue;
      }

      if (iframe.style.display === 'none') continue;

      iframe.style.display = 'none';
      blockedCount++;
      updateLog(src, blockedCount);
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
