// ==UserScript==
// @name         Iframe Ad Blocker with src/HTML preview
// @namespace    https://yourdomain.com
// @version      2.5
// @description  Hide iframe ads with better logging (shows src or outerHTML), floating UI auto-hides in 10s, includes whitelist & draggable panel with double-click drag toggle.
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
      cursor: default;
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
    header.style.color = 'white';

    logContainer.appendChild(closeBtn);
    logContainer.appendChild(header);
    document.body.appendChild(logContainer);

    makeDraggable(logContainer);

    // 🕒 자동으로 로그창 제거 (10초 후)
    setTimeout(() => {
      if (logContainer && document.body.contains(logContainer)) {
        logContainer.remove();
      }
    }, 10000);
  }

  function makeDraggable(element) {
    let offsetX = 0, offsetY = 0;
    let isDragging = false;
    let dragEnabled = false;

    element.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'SPAN') return;
      dragEnabled = !dragEnabled;
      element.style.cursor = dragEnabled ? 'move' : 'default';
    });

    element.addEventListener('mousedown', (e) => {
      if (!dragEnabled) return;
      if (e.target.tagName === 'SPAN') return;
      isDragging = true;

      const rect = element.getBoundingClientRect();
      element.style.left = rect.left + 'px';
      element.style.top = rect.top + 'px';
      element.style.bottom = 'auto';
      element.style.right = 'auto';

      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      element.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        element.style.left = `${e.clientX - offsetX}px`;
        element.style.top = `${e.clientY - offsetY}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        element.style.cursor = dragEnabled ? 'move' : 'default';
      }
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
      logContainer.removeChild(entries[2]); // 헤더와 닫기 버튼 이후 오래된 것 제거
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
