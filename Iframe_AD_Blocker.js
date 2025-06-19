// ==UserScript==
// @name         Iframe Logger & Blocker (Auto-hide Repeats)
// @namespace    none
// @version      3.7.1
// @description  Blocks iframes unless whitelisted. Logs all iframe src/HTML up to 200 chars. Sticky, draggable UI shown only on desktop. Auto-hide log panel 10s after last log.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window) return; // 프레임 내부 실행 방지

  const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

  const whitelist = [
    'recaptcha',  // 캡챠
    'about:blank', // 일부 iframe 문제 해결
    'embed',  // 각종 게시물 임베드
    'naver.com/my.html',  // 네이버 메인홈에서 이메일 안보이는거 해결
    'cafe.naver.com',  // 네이버 카페ㅁ
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
    'cdnbuzz.buzz',  // https://av19.live/
    '/player/'  // https://avpingyou19.com/ 핑유걸 등
  ];

  let seen = new WeakSet();
  let logContainer, logContent;
  let logList = [];
  let count = 0;
  let hideTimeout;

  function isWhitelisted(src) {
    return whitelist.some(keyword => src.includes(keyword));
  }

  function createLogUI() {
    if (isMobile) return;

    logContainer = document.createElement('div');
    logContainer.style.cssText = `
      position: fixed;
      bottom: 10px;
      right: 10px;
      width: 500px;
      max-height: 500px;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      font-family: monospace;
      font-size: 13px;
      border-radius: 10px;
      box-shadow: 0 0 15px rgba(0,0,0,0.6);
      display: flex;
      flex-direction: column;
      z-index: 99999;
      cursor: move;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(0, 0, 0, 0.95);
      padding: 8px 12px;
      font-weight: bold;
      font-size: 14px;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
      user-select: none;
      color: white;
    `;
    header.innerHTML = `<div>🛡️ Iframe Log View</div>`;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 복사';
    copyBtn.style.cssText = `
      font-size: 12px;
      background: #444;
      color: white;
      border: none;
      border-radius: 5px;
      padding: 4px 8px;
      cursor: pointer;
    `;
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(logList.join('\n')).then(() => {
        copyBtn.textContent = '복사됨!';
        setTimeout(() => copyBtn.textContent = '📋 복사', 1500);
      });
    };

    header.appendChild(copyBtn);
    logContainer.appendChild(header);

    logContent = document.createElement('div');
    logContent.style.cssText = `
      overflow-y: auto;
      flex: 1 1 auto;
      padding: 8px 12px;
      color: white;
    `;
    logContainer.appendChild(logContent);

    document.body.appendChild(logContainer);
    makeDraggable(logContainer, header);
  }

  function showLogUI() {
    if (!logContainer) return;
    logContainer.style.display = 'flex';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (logContainer) {
        logContainer.style.display = 'none';
      }
    }, 10000);
  }

  function makeDraggable(element, handle) {
    let isDragging = false, offsetX = 0, offsetY = 0;
    handle.style.cursor = 'grab';

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - element.getBoundingClientRect().left;
      offsetY = e.clientY - element.getBoundingClientRect().top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        element.style.left = `${e.clientX - offsetX}px`;
        element.style.top = `${e.clientY - offsetY}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.style.position = 'fixed';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      handle.style.cursor = 'grab';
    });
  }

  function addLogEntry(iframe) {
    if (seen.has(iframe)) return;
    seen.add(iframe);

    const src = iframe.src || '';
    const whitelisted = isWhitelisted(src);

    // 차단은 whitelist 외에서만
    if (!whitelisted) iframe.style.display = 'none';

    let text = src
      ? src.slice(0, 200)
      : '(no src) ' + iframe.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 200);

    count++;
    const line = `[${count}] ${text}`;
    logList.push(line);

    if (!isMobile && logContainer) {
      const div = document.createElement('div');
      div.textContent = line;
      div.style.cssText = 'color: white; padding: 2px 0;';
      logContent.appendChild(div);

      if (logList.length > 50) {
        logList.shift();
        if (logContent.children.length > 50) {
          logContent.removeChild(logContent.children[0]);
        }
      }

      showLogUI();
    }
  }

  function scanIframes() {
    const iframes = document.getElementsByTagName('iframe');
    for (const iframe of iframes) {
      addLogEntry(iframe);
    }
  }

  function init() {
    createLogUI();
    scanIframes();

    const observer = new MutationObserver(scanIframes);
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('unload', () => observer.disconnect());
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
