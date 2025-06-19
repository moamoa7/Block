// ==UserScript==
// @name         Iframe Ad Logger & Blocker
// @namespace    none
// @version      3.3
// @description  Block iframe ads (except whitelist), log all iframes including whitelisted. Fixed white text color. Mobile: block only, no log UI. Auto-hide after 10s.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

  const whitelist = [
    'recaptcha', 'about:blank', '/embed/',
    'naver.com/my.html', 'cafe.naver.com', 'blog.naver.com',
    'goodTube', 'player.bunny-frame.online', '/video/',
    '123123play.com', '/lives', '?v=', 'channel', 'dlrstream.com',
    'tV', 'tv', 'lk1.supremejav.com', 'avsee.ru/player/',
    '/e/', '/t/', '/v/', '/#', '7tv000.com', 'cdnbuzz.buzz',
  ];

  let logContainer, logContent;
  let logList = [];
  let count = 0;
  const seen = new WeakSet();

  function isWhitelisted(src) {
    return whitelist.some(domain => src.includes(domain));
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
      background: rgba(0, 0, 0, 0.85) !important;
      color: white !important;
      font-family: monospace !important;
      font-size: 13px !important;
      border-radius: 10px !important;
      box-shadow: 0 0 15px rgba(0,0,0,0.6) !important;
      display: flex !important;
      flex-direction: column !important;
      z-index: 99999 !important;
      cursor: move;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(0, 0, 0, 0.95) !important;
      padding: 8px 12px;
      font-weight: bold;
      font-size: 14px;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
      color: white !important;
    `;
    header.innerHTML = `<div>🛡️ Iframe Log View</div>`;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 복사';
    copyBtn.style.cssText = `
      font-size: 12px !important;
      background: #444 !important;
      color: white !important;
      border: none !important;
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
      color: white !important;
      user-select: text;
    `;
    logContainer.appendChild(logContent);

    document.body.appendChild(logContainer);
    makeDraggable(logContainer, header);

    setTimeout(() => {
      if (logContainer?.parentElement) logContainer.remove();
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
    const whitelistMatch = isWhitelisted(src);

    if (!whitelistMatch) iframe.style.display = 'none';

    let logText = src ? src.slice(0, 200) : '(no src) ' + iframe.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 200);
    count++;
    const line = `[${count}] ${logText}`;
    logList.push(line);

    if (!isMobile && logContent) {
      const div = document.createElement('div');
      div.textContent = line;
      div.style.cssText = 'color: white !important; padding: 2px 0;';
      logContent.appendChild(div);

      if (logList.length > 50) {
        logList.shift();
        if (logContent.children.length > 50) {
          logContent.removeChild(logContent.children[0]);
        }
      }
    }
  }

  function observeIframes() {
    const scan = () => {
      const iframes = document.getElementsByTagName('iframe');
      for (const iframe of iframes) addLogEntry(iframe);
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('unload', () => observer.disconnect());
  }

  function init() {
    createLogUI();
    observeIframes();
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
