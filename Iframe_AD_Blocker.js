// ==UserScript==
// @name         Iframe Ad Blocker with src/HTML preview and copy log (mobile no log)
// @namespace    none
// @version      2.5
// @description  Hide iframe ads with log showing src or outerHTML (200 chars), floating log auto-hides after 10s, copy log included, draggable panel; No log on mobile.
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
    'player.bunny-frame.online',  //  티비위키/티비몬/티비핫 영상 플레이어 주소
    '/video/',  //  https://m66.kotbc2.com/  코티비씨 등
    '123123play.com',  //  https://tvchak152.com/  티비착
    '/live',  //  https://messitv8.com/ 메시티비
    '?v=',  //  https://messitv8.com/ 메시티비 등
    'channel',  //  https://goat-v.com/ 고트티비
    'dlrstream.com',  //  https://blacktv88.com/ 블랙티비
    'tV',  //  https://kktv12.com/  킹콩티비
    'tv',  //  https://www.cool111.com/  쿨티비  등
    'lk1.supremejav.com',  // https://supjav.com/  TV영상
    'avsee.ru/player/',
    '/e/',  // 성인 영상 플레이어 주소
    '/t/',  // 성인 영상 플레이어 주소
    '/v/',  // 성인 영상 플레이어 주소 / 스포츠TV 플레이어 주소
    '/#',  // 성인 영상 플레이어 주소
    '7tv000.com',  // https://7tv000.com/  7MMTV TV영상
    'cdnbuzz.buzz'  // https://av19.live/
  ];

  function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function createLogUI() {
    if (isMobile()) return; // 📱 모바일 환경에서는 로그창 안 뜸

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
      padding: 12px 12px 40px 12px;
      border-radius: 10px;
      box-shadow: 0 0 15px rgba(0,0,0,0.6);
      font-family: monospace;
      line-height: 1.5;
      user-select: text;
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
      user-select: none;
    `;
    closeBtn.onclick = () => logContainer.remove();

    const header = document.createElement('div');
    header.innerHTML = '<b style="font-size:14px;">🛡️ Iframe Ad Block Log</b><hr>';
    header.style.color = 'white';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Log';
    copyBtn.style.cssText = `
      position: absolute;
      bottom: 10px;
      right: 10px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 5px;
      border: none;
      background-color: #555;
      color: white;
    `;
    copyBtn.onclick = () => {
      const logs = Array.from(logContainer.querySelectorAll('.log-item'))
        .map(e => e.textContent)
        .join('\n');
      navigator.clipboard.writeText(logs).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy Log', 1500);
      });
    };

    logContainer.appendChild(closeBtn);
    logContainer.appendChild(header);
    logContainer.appendChild(copyBtn);
    document.body.appendChild(logContainer);

    makeDraggable(logContainer);

    setTimeout(() => {
      if (logContainer && document.body.contains(logContainer)) {
        logContainer.remove();
      }
    }, 10000);
  }

  function makeDraggable(element) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    element.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SPAN') return;
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
        element.style.bottom = 'auto';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      element.style.cursor = 'move';
    });
  }

  function updateLog(iframe, count) {
    if (!logContainer) return;

    let displayText = '';
    if (iframe.src) {
      displayText = iframe.src.slice(0, 200);
    } else {
      displayText = iframe.outerHTML.slice(0, 200).replace(/\n/g, '').replace(/\s+/g, ' ');
    }

    const item = document.createElement('div');
    item.textContent = `[${count}] ${displayText}`;
    item.className = 'log-item';
    item.style.color = 'white';
    logContainer.appendChild(item);

    const entries = logContainer.querySelectorAll('div.log-item');
    if (entries.length > 15) {
      logContainer.removeChild(entries[0]);
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
      updateLog(iframe, blockedCount); // 📄 모바일에서도 차단은 되지만 로그창 안 뜸
    }
  }

  function initialize() {
    createLogUI(); // 모바일이면 UI 안 뜸
    blockIframeAds();

    const observer = new MutationObserver(() => blockIframeAds());
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('unload', () => observer.disconnect());
  }

  if (document.body) {
    initialize();
  } else {
    window.addEventListener('DOMContentLoaded', initialize);
  }
})();
