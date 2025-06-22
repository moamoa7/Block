// ==UserScript==
// @name         Iframe Logger & Blocker (최신 통합판 for Violentmonkey)
// @namespace    none
// @version      7.0
// @description  iframe 실시간 탐지+차단, srcdoc+data-* 분석, 화이트리스트, 자식 로그 부모 전달, Shadow DOM 탐색, 로그 UI, 드래그, 자동 숨김
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const ENABLE_LOG_UI = true;
  const REMOVE_IFRAME = true;
  const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

  const seen = new WeakSet();
  const pendingSrcMap = new WeakMap();
  let count = 0;
  let logList = [];
  let logContainer, logContent, countDisplay, hideTimeout;

  // 글로벌 키워드 화이트리스트
  const globalWhitelistKeywords = [
    'recaptcha', 'cloudflare.com', 'player.bunny-frame.online', 'naver.com',
    '/embed/', '/e/', '/t/', 'dlrstream.com', '123123play.com', 'supremejav.com',
    'goodTubeProxy',
  ];

  // 도메인별 키워드 화이트리스트
  const whitelistMap = {
    'supjav.com': ['supremejav.com'],
    'avsee.ru': ['player/'],
    '7tv000.com': [''],
    'cdnbuzz.buzz': [''],
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'naver.com': ['my.html'],
  };

  function isWhitelisted(url = '') {
    try {
      // 글로벌 키워드 체크
      for (const keyword of globalWhitelistKeywords) {
        if (url.includes(keyword)) return true;
      }
      // 도메인별 키워드 체크
      const u = new URL(url, location.href);
      const domain = u.hostname;
      const path = u.pathname + u.search;
      for (const [host, keywords] of Object.entries(whitelistMap)) {
        if (domain.includes(host)) {
          if (keywords.length === 0 || keywords.some(k => path.includes(k))) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  }

  // srcdoc에서 src/href URL 추출
  function extractUrlsFromSrcdoc(srcdoc = '') {
    const urls = [];
    try {
      const temp = document.createElement('div');
      temp.innerHTML = srcdoc;
      const tags = temp.querySelectorAll('[src], [href]');
      tags.forEach(el => {
        const val = el.getAttribute('src') || el.getAttribute('href');
        if (val) urls.push(val);
      });
    } catch {}
    return urls;
  }

  // data-* 속성에서 URL 추출
  function extractUrlsFromDataset(el) {
    const urls = [];
    try {
      for (const key of Object.keys(el.dataset)) {
        const val = el.dataset[key];
        if (val && /^https?:\/\//.test(val)) {
          urls.push(val);
        }
      }
    } catch {}
    return urls;
  }

  // Shadow DOM 포함 모든 iframe/frame/embed/object 수집
  function getAllIframes(root = document) {
    let found = [];
    try {
      found = Array.from(root.querySelectorAll('iframe,frame,embed,object'));
    } catch {}
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) {
        found = found.concat(getAllIframes(node.shadowRoot));
      }
    }
    return found;
  }

  // 로그 UI 생성 및 드래그 기능
  function createLogUI() {
    if (!ENABLE_LOG_UI || isMobile) return;

    // 버튼을 추가하여 로그 패널을 토글
    const btn = document.createElement('button');
    btn.textContent = '🛡️'; btn.title = 'Iframe 로그 토글';
    btn.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;width:40px;height:40px;border-radius:50%;border:none;background:#222;color:#fff;font-size:20px;cursor:pointer;';
    document.body.appendChild(btn);

    // 패널 스타일 설정
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:60px;right:10px;width:500px;max-height:400px;background:rgba(0,0,0,0.85);color:white;font-family:monospace;font-size:13px;border-radius:10px;box-shadow:0 0 10px black;display:none;flex-direction:column;overflow:hidden;z-index:99999;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#000;font-weight:bold;font-size:14px;';
    const title = document.createElement('span'); title.textContent = '🛡️ Iframe Log View';

    countDisplay = document.createElement('span');
    countDisplay.style.cssText = 'font-size:12px;color:#ccc;margin-left:6px;';
    countDisplay.textContent = '(0)';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 복사';
    copyBtn.style.cssText = 'font-size:12px;background:#444;color:white;border:none;border-radius:5px;padding:2px 8px;cursor:pointer;';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(logList.join('\n')).then(() => {
        copyBtn.textContent = '복사됨!';
        setTimeout(() => copyBtn.textContent = '📋 복사', 1500);
      });
    };

    const left = document.createElement('div');
    left.appendChild(title);
    left.appendChild(countDisplay);
    header.appendChild(left);
    header.appendChild(copyBtn);

    // 로그 콘텐츠 영역 설정
    logContent = document.createElement('div');
    logContent.style.cssText = 'overflow-y:auto;flex:1;padding:6px 10px;white-space:pre-wrap;';
    panel.appendChild(header);
    panel.appendChild(logContent);
    document.body.appendChild(panel);

    // 버튼 클릭 시 패널을 토글
    btn.onclick = () => panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  }

  function showLogUI() {
    if (!logContainer) return;
    logContainer.style.display = 'flex';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      logContainer.style.display = 'none';
    }, 10000);
  }

  function updateCountDisplay() {
    if (countDisplay) countDisplay.textContent = `(${count})`;
  }

  // iframe 로그 및 차단 처리
  function logIframe(iframe, reason = '', srcHint = '') {
    let src = srcHint || iframe?.src || iframe?.getAttribute('src') || '';
    const srcdoc = iframe?.srcdoc || iframe?.getAttribute('srcdoc') || '';
    const dataUrls = extractUrlsFromDataset(iframe);
    const extracted = extractUrlsFromSrcdoc(srcdoc);
    if (!src && extracted.length > 0) src = extracted[0];
    if (!src && dataUrls.length > 0) src = dataUrls[0];

    const outer = iframe?.outerHTML?.slice(0, 200).replace(/\s+/g, ' ') || '';
    const info = `[#${++count}] ${reason} ${src || '[No src]'}\n └▶ HTML → ${outer}`;
    console.warn('%c[Iframe Detected]', 'color: red; font-weight: bold;', info);

    // 합친 문자열로 화이트리스트 체크
    const combined = [src, ...dataUrls, ...extracted].join(' ');
    const isWhitelistedIframe = isWhitelisted(combined);

    // 로그 색상 설정 (녹색: 화이트리스트, 빨간색: 차단됨)
    const logColor = isWhitelistedIframe ? 'green' : 'red';

    if (!isWhitelistedIframe && iframe && REMOVE_IFRAME) {
      iframe.style.display = 'none';
      iframe.setAttribute('sandbox', '');
      setTimeout(() => iframe.remove(), 500);
    }

    if (ENABLE_LOG_UI && !isMobile && logContent) {
      logList.push(info);
      const div = document.createElement('div');
      div.style.cssText = `color: ${logColor}; padding: 2px 0; white-space: pre-wrap;`;
      div.textContent = info;
      logContent.appendChild(div);
      if (logContent.children.length > 100) logContent.removeChild(logContent.children[0]);
      updateCountDisplay();
      showLogUI();
    }
  }

  // iframe 중복 방지 및 지연 src 처리
  function handleIframe(el, reason) {
    if (seen.has(el)) return;
    seen.add(el);
    if (!el.src && !el.getAttribute('src')) {
      pendingSrcMap.set(el, reason);
    } else {
      logIframe(el, reason);
    }
  }

  // 지연 src가 생기는 iframe 감시 반복
  function monitorDeferredIframes() {
    pendingSrcMap.forEach((reason, el) => {
      if (el.src || el.getAttribute('src')) {
        logIframe(el, reason + ' (late src)');
        pendingSrcMap.delete(el);
      }
    });
    requestAnimationFrame(monitorDeferredIframes);
  }

  // Shadow DOM 포함 모든 iframe 스캔
  function scanAll(reason = 'initialScan') {
    const iframes = getAllIframes();
    iframes.forEach(el => handleIframe(el, reason));
  }

  // 자식 프레임이면 부모에 로그 메시지 전달
  if (window.top !== window) {
    setTimeout(() => {
      window.parent.postMessage('[CHILD_IFRAME_LOG]' + location.href, '*');
    }, 100);
    return;
  }

  // 부모 프레임에서 자식 프레임 로그 수신
  window.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('[CHILD_IFRAME_LOG]')) {
      const url = e.data.slice(18);
      logIframe(null, 'from child', url);
    }
  });

  // createElement 후 iframe 추적
  const originalCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const el = originalCreate.apply(this, args);
    if (["iframe", "frame", "embed", "object"].includes(String(args[0]).toLowerCase())) {
      setTimeout(() => handleIframe(el, 'createElement'), 10);
    }
    return el;
  };

  // appendChild 후 iframe 추적
  const originalAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (child) {
    const result = originalAppend.call(this, child);
    if (child instanceof HTMLElement && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(child.tagName)) {
      setTimeout(() => handleIframe(child, 'appendChild'), 10);
    }
    return result;
  };

  // setAttribute로 src 변경시 추적
  const originalSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (["src", "srcdoc", "data-src", "data-lazy-src", "data-href", "data-real-src"].includes(name.toLowerCase()) &&
        this.tagName && ['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(this.tagName)) {
      setTimeout(() => handleIframe(this, `setAttribute:${name}`), 10);
    }
    return originalSetAttr.apply(this, arguments);
  };

  // iframe.src 직접 할당 감지
  const originalSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  if (originalSrc?.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      set(value) {
        setTimeout(() => handleIframe(this, 'src= (direct assign)'), 10);
        return originalSrc.set.call(this, value);
      },
      get: originalSrc.get,
      configurable: true,
      enumerable: true
    });
  }

  // MutationObserver로 새 iframe 실시간 감지
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(node.tagName)) {
          handleIframe(node, 'MutationObserver add');
        }
        // ShadowRoot 안의 iframe도 탐색
        if (node.shadowRoot) {
          const nestedIframes = getAllIframes(node.shadowRoot);
          nestedIframes.forEach(f => handleIframe(f, 'MutationObserver shadowRoot'));
        }
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // 페이지 로드 후 전체 스캔 및 지연 src 모니터링 시작
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (ENABLE_LOG_UI) createLogUI();
      scanAll('initialScan');
      monitorDeferredIframes();
    });
  } else {
    if (ENABLE_LOG_UI) createLogUI();
    scanAll('initialScan');
    monitorDeferredIframes();
  }
})();
