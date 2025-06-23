// ==UserScript==
// @name         Iframe Logger & Blocker (Violentmonkey용, 개선된 버전)
// @namespace    none
// @version      8.0
// @description  iframe 실시간 탐지+차단, srcdoc+data-* 분석, 화이트리스트, 자식 로그 부모 전달, Shadow DOM 탐색, 로그 UI, 드래그, 자동 숨김
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const ENABLE_LOG_UI = true;
  const REMOVE_IFRAME = true;
  const seen = new WeakSet();
  const pendingSrcMap = new WeakMap();
  let count = 0;
  let logList = [];
  let logContainer, logContent, countDisplay;

  // 글로벌 키워드 화이트리스트
  const globalWhitelistKeywords = [
    'captcha', 'challenges',  // 캡챠
    'extension:',  // 확장프로그램
    'goodTube',  // 유튜브 우회 js (개별적으로 사용중)
    'player.bunny-frame.online',  // 티비위키.티비몬.티비핫 플레이어
    '/embed/',  // 커뮤니티 등 게시물 동영상 삽입 (유튜브.트위치.인스타 등 - https://poooo.ml/등에도 적용)  쏘걸 등 성인영상
    '/videoembed/', 'player.kick.com', // https://poooo.ml/
    '/messitv/',  // https://messitv8.com/ (메시티비)
    '/goattv/',  // https://goat-v.com/ (고트티비)
    'dlrstream.com',  // https://blacktv88.com/ (블랙티비)
    '/tV',  // https://kktv12.com/ (킹콩티비)  https://bmtv24.com/ (배트맨티비)  https://nolgoga365.com/ (놀고가닷컴)
    'tv/',  // https://www.cool111.com/ (쿨티비)  https://royaltv01.com/ (로얄티비)  https://conan-tv.com/ (코난티비)
    'stream/',  // https://gltv88.com/ (굿라이브티비)  https://missvod4.com/
    'supremejav.com',  // https://supjav.com/
    '/e/', '/t/', '/v/',  // 각종 성인 영상
    '/player',  // https://05.avsee.ru/  https://sextb.date/ US영상
    '7tv000.com', '7mmtv',  // https://7tv000.com/
    'njav',  // https://www.njav.com/
  ];

  // 도메인별 키워드 화이트리스트
  const whitelistMap = {
    'cdnbuzz.buzz': [''],  // https://av19.live/ (AV19)
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'www.naver.com': ['my.html'],  // 메인에서 로그인 후 메일 클릭시 메일 안보이는거 해결
    'tiktok.com': [''],
  };

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

  // 아이콘 드래그 가능하게 만드는 함수 (모바일 지원)
  function makeDraggable(element) {
    let offsetX, offsetY;
    let isDragging = false;

    const startDrag = (event) => {
      isDragging = true;
      const clientX = event.touches ? event.touches[0].clientX : event.clientX;
      const clientY = event.touches ? event.touches[0].clientY : event.clientY;
      offsetX = clientX - element.getBoundingClientRect().left;
      offsetY = clientY - element.getBoundingClientRect().top;

      const moveDrag = (moveEvent) => {
        if (isDragging) {
          const x = (moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX) - offsetX;
          const y = (moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY) - offsetY;
          element.style.left = `${x}px`;
          element.style.top = `${y}px`;
        }
      };

      const stopDrag = () => {
        isDragging = false;
        document.removeEventListener('mousemove', moveDrag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', moveDrag);
        document.removeEventListener('touchend', stopDrag);
      };

      document.addEventListener('mousemove', moveDrag);
      document.addEventListener('mouseup', stopDrag);
      document.addEventListener('touchmove', moveDrag);
      document.addEventListener('touchend', stopDrag);
    };

    element.addEventListener('mousedown', startDrag);
    element.addEventListener('touchstart', startDrag);
  }

  // 로그 UI 생성 및 드래그 기능
  function createLogUI() {
    if (!ENABLE_LOG_UI) return;

    // 버튼을 추가하여 로그 패널을 토글
    const btn = document.createElement('button');
    btn.textContent = '🛡️'; btn.title = 'Iframe 로그 토글';
    btn.style.cssText = `
      position:fixed;
      bottom:10px;
      right:10px;
      z-index:99999;
      width:40px;
      height:40px;
      border-radius:50%;
      border:none;
      background:#222;
      color:#fff;
      font-size:20px;
      cursor:pointer;
      display:block;
    `;
    document.body.appendChild(btn);

    // 버튼을 자유롭게 이동할 수 있게 드래그 기능 추가
    makeDraggable(btn);

    // 패널 스타일 설정
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:60px;right:10px;width:500px;max-height:400px;background:rgba(0,0,0,0.85);color:white;font-family:monospace;font-size:13px;border-radius:10px;box-shadow:0 0 10px black;display:none;flex-direction:column;overflow:hidden;z-index:99999;';
    logContainer = panel;

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

    logContent = document.createElement('div');
    logContent.style.cssText = 'overflow-y:auto;flex:1;padding:6px 10px;white-space:pre-wrap;';

    // 로그 내용 드래그 활성화
    logContent.style.userSelect = 'text';

    // 드래그 이벤트 방지
    logContent.addEventListener('mousedown', (e) => {
      e.stopPropagation(); // 부모 패널로 드래그 이벤트가 전파되지 않도록 막기
    });

    panel.appendChild(header);
    panel.appendChild(logContent);
    document.body.appendChild(panel);

    // 패널을 드래그 가능하게 만듦
    makeDraggable(panel);

    // 버튼 클릭 시 패널을 토글
    btn.onclick = () => {
      if (logContainer.style.display === 'none') {
        logContainer.style.display = 'flex';  // 패널 열기
      } else {
        logContainer.style.display = 'none';  // 패널 닫기
      }
    };
  }

  // 로그 출력
  function updateCountDisplay() {
    if (countDisplay) countDisplay.textContent = `(${count})`;
  }

  // 부모에서 자식 로그 수신
  window.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('[CHILD_IFRAME_LOG]')) {
      const url = e.data.slice(18);
      logIframe(null, 'from child', url);
    }
  });

  // 자식에서 부모로 메시지 보내기
  if (window.top !== window) {
    setTimeout(() => {
      window.parent.postMessage('[CHILD_IFRAME_LOG]' + location.href, '*');
    }, 100);
    return;
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
    const combined = [src, ...dataUrls, ...extracted].join(' ');

    // 체크된 화이트리스트 키워드 추적
    const matchedKeywords = [];
    globalWhitelistKeywords.forEach(keyword => {
      if (combined.includes(keyword)) matchedKeywords.push(`Global: ${keyword}`);
    });

    const u = new URL(src, location.href);
    const domain = u.hostname;
    const path = u.pathname + u.search;
    for (const [host, keywords] of Object.entries(whitelistMap)) {
      if (domain.includes(host)) {
        keywords.forEach(keyword => {
          if (path.includes(keyword)) matchedKeywords.push(`Domain: ${keyword} (host: ${host})`);
        });
      }
    }

    const isWhitelistedIframe = matchedKeywords.length > 0;
    const logColor = isWhitelistedIframe ? 'green' : 'red';
    const keywordText = isWhitelistedIframe ? `Matched Keywords: ${matchedKeywords.join(', ')}` : '';

    const info = `[#${++count}] ${reason} ${src || '[No src]'}\n └▶ HTML → ${outer}\n ${keywordText}`;
    console.warn('%c[Iframe Detected]', 'color: red; font-weight: bold;', info);

    if (!isWhitelistedIframe && iframe && REMOVE_IFRAME) {
      iframe.style.display = 'none';
      iframe.setAttribute('sandbox', '');
      setTimeout(() => iframe.remove(), 500);
    }

    // 로그 UI 업데이트
    if (ENABLE_LOG_UI && logContent) {
      logList.push(info);
      const div = document.createElement('div');
      div.style.cssText = `color: ${logColor}; padding: 2px 0; white-space: pre-wrap;`;
      div.textContent = info;
      logContent.appendChild(div);
      if (logContent.children.length > 100) logContent.removeChild(logContent.children[0]);
      updateCountDisplay();
    }
  }

  // 전체 스캔
  function scanAll(reason = 'initialScan') {
    const iframes = getAllIframes();
    iframes.forEach(el => logIframe(el, reason));
  }

  // MutationObserver로 새 iframe 실시간 감지
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(node.tagName)) {
          logIframe(node, 'MutationObserver add');
        }
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // 주기적으로 iframe을 검사하여 동적 요소 감지 강화
  setInterval(() => {
    scanAll('periodicScan');
  }, 2000);  // 2초마다 iframe 감지

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createLogUI();
      scanAll('initialScan');
    });
  } else {
    createLogUI();
    scanAll('initialScan');
  }

})();
