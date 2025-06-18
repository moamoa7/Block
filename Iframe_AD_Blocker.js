// ==UserScript==
// @name         Iframe Ad Blocker with src/HTML preview
// @namespace    https://yourdomain.com
// @version      2.6
// @description  Hide iframe ads with better logging (shows src or outerHTML), floating UI auto-hides in 10s, includes whitelist & draggable panel. Logs disabled on mobile, blocking active always.
// @author       YourName
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let logContainer;
  let blockedCount = 0;

  const whitelist = [
    'recaptcha',
    'about:blank',
    'embed',
    'naver.com/my.html',
    'cafe.naver.com',
    'blog.naver.com',
    'goodTube',
    'player.bunny-frame.online',
    'lk1.supremejav.com',
    'avsee.ru/player/',
    '/e/',
    '/t/',
    '/v/',
    'cdnbuzz.buzz'  // https://av19.live/
  ];

  function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

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

    setTimeout(() => {
      if (logContainer && document.body.contains(logContainer)) {
        logContainer.remove();
      }
    }, 10000);
  }

  function makeDraggable(element) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    element.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN') return;
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

      if (whitelist.some(domain => src.includes(domain))) {
        continue;
      }

      if (iframe.style.display === 'none') continue;

      iframe.style.display = 'none';
      blockedCount++;

      if (!isMobile()) {
        updateLog(iframe, blockedCount);
      }
    }
  }

  function initialize() {
    if (!isMobile()) {
      createLogUI();
    }
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
