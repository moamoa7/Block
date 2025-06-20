// ==UserScript==
// @name         Iframe Logger & Blocker (Count Display + Fixed Shield Icon + Custom Attrs + Base64 Preview + 100 Logs)
// @namespace    none
// @version      4.0
// @description  Blocks iframes unless whitelisted. Logs iframe real src/HTML/base64 preview. Auto-hide log after 10s. 🛡️ 아이콘 + 차단 수 표시 + data-lazy-src 등 커스텀 속성 지원 + 로그 100개 유지.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;

  const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
  const hostname = location.hostname;

  const whitelist = [
    { keyword: 'recaptcha' },
    { keyword: 'embed' },
    { keyword: 'naver.com/my.html' },
    { keyword: 'cafe.naver.com' },
    { keyword: 'blog.naver.com' },
    { keyword: 'goodTube' },
    { keyword: 'player.bunny-frame.online' },
    { keyword: '/video/' },
    { keyword: '123123play.com' },
    { keyword: '/live' },
    { keyword: '?v=' },
    { keyword: 'channel' },
    { keyword: 'dlrstream.com' },
    { keyword: 'tV' },
    { keyword: 'tv' },
    { keyword: 'lk1.supremejav.com' },
    { keyword: 'avsee.ru/player/' },
    { keyword: '/e/' },
    { keyword: '/t/' },
    { keyword: '/v/' },
    { keyword: '/#' },
    { keyword: '7tv000.com' },
    { keyword: 'cdnbuzz.buzz' },
    { keyword: '/player/' },
    { keyword: '키워드', excludeDomains: ['도메인'] }
  ];

  let seen = new WeakSet();
  let logContainer, logContent, countDisplay;
  let logList = [];
  let count = 0;
  let hideTimeout;

  const SHIELD_EMOJI_URL = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' height='20' viewBox='0 0 24 24' width='20'><text x='0' y='18'>🛡️</text></svg>";

  function getRealSrc(iframe) {
    // data-lazy-src, data-src, data-href, data-real-src 확장 지원
    return iframe.getAttribute('data-lazy-src') ||
           iframe.getAttribute('data-src') ||
           iframe.getAttribute('data-href') ||
           iframe.getAttribute('data-real-src') ||
           iframe.getAttribute('src') || '';
  }

  function isWhitelisted(src) {
    return whitelist.some(({ keyword, excludeDomains = [] }) =>
      src.includes(keyword) &&
      !excludeDomains.some(domain => hostname.includes(domain))
    );
  }

  function base64Preview(text) {
    try {
      return 'data:text/html;base64,' + btoa(unescape(encodeURIComponent(text)));
    } catch {
      return '';
    }
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
      z-index: 2147483647;
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

    const titleWrap = document.createElement('div');
    titleWrap.style.display = 'flex';
    titleWrap.style.alignItems = 'center';
    titleWrap.style.gap = '6px';

    const shieldImg = document.createElement('img');
    shieldImg.src = SHIELD_EMOJI_URL;
    shieldImg.alt = '🛡️';
    shieldImg.style.cssText = `
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      display: inline-block;
    `;

    const titleText = document.createElement('span');
    titleText.textContent = 'Iframe Log View';

    countDisplay = document.createElement('span');
    countDisplay.textContent = '(0)';
    countDisplay.style.cssText = 'font-size: 12px; color: #ccc; margin-left: 4px;';

    titleWrap.appendChild(shieldImg);
    titleWrap.appendChild(titleText);
    titleWrap.appendChild(countDisplay);
    header.appendChild(titleWrap);

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

  function updateCountDisplay() {
    if (countDisplay) {
      countDisplay.textContent = `(${count})`;
    }
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

    const realSrc = getRealSrc(iframe);
    const whitelisted = isWhitelisted(realSrc);
    if (!whitelisted) iframe.style.display = 'none';

    count++;
    let line;
    if (realSrc) {
      line = `[${count}] ${realSrc.slice(0, 200)}`;
    } else {
      const htmlSnippet = iframe.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 500);
      const previewUrl = base64Preview(htmlSnippet);
      line = `[${count}] (no src) iframe content preview`;
    }

    logList.push(line);
    updateCountDisplay();

    if (!isMobile && logContainer) {
      const div = document.createElement('div');
      div.style.cssText = 'color: white; padding: 2px 0;';
      div.textContent = line;

      if (!realSrc) {
        const a = document.createElement('a');
        a.href = base64Preview(iframe.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 500));
        a.target = '_blank';
        a.textContent = ' 🔍 미리보기';
        a.style.color = '#4af';
        a.style.marginLeft = '8px';
        div.appendChild(a);
      }

      logContent.appendChild(div);

      if (logList.length > 100) {
        logList.shift();
        if (logContent.children.length > 100) {
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
