// ==UserScript==
// @name         Iframe Logger & Blocker (Violentmonkey용, 개선된 버전)
// @namespace    none
// @version      8.4
// @description  iframe 실시간 탐지+차단, srcdoc+data-* 분석, 화이트리스트, 자식 로그 부모 전달, Shadow DOM 탐색, 로그 UI, 드래그, 자동 숨김, 더블클릭으로 상태 변경
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 설정 값 (로그 UI, iframe 제거 여부)
  const ENABLE_LOG_UI = true;  // 로그 UI 활성화 여부
  const REMOVE_IFRAME = true;  // iframe 제거 여부
  const seen = new WeakSet(); // 이미 처리한 iframe을 추적하는 WeakSet
  const seenSrc = new Set();  // 이미 처리한 src를 추적하는 Set
  let count = 0;  // iframe 탐지 카운트
  let logList = [];  // 로그 항목 저장 배열
  let logContainer, logContent, countDisplay; // 로그 UI 관련 DOM 요소
  let isEnabled = true; // 활성화 상태

  // 글로벌 키워드 화이트리스트 (특정 키워드를 포함하는 iframe은 녹색으로 표시)
  const globalWhitelistKeywords = [
    'captcha', 'challenges',  // 캡챠
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
    '/e/', '/t/', '/v/', // 각종 성인 영상
    '/player',  // https://05.avsee.ru/  https://sextb.date/ US영상
    '7tv000.com', '7mmtv',  // https://7tv000.com/
    'njav',  // https://www.njav.com/
  ];

  // 도메인별 키워드 화이트리스트 (특정 도메인에서 특정 키워드를 포함하는 경우 녹색 처리)
  const whitelistMap = {
    'cdnbuzz.buzz': [''],  // https://av19.live/ (AV19)
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'www.naver.com': ['my.html'],  // 메인에서 로그인 후 메일 클릭시 메일 안보이는거 해결
    'tiktok.com': [''],
  };

  // 회색 화이트리스트 키워드 (회색으로 처리)
  const grayWhitelistKeywords = [
    'extension:',  // 확장프로그램
    'goodTube',  // 유튜브 우회 js (개별적으로 사용중)
    '/js/',  // 필수 js
    'aspx',  // 옥션 페이지 안보이거 해결
    '/vp/',  //쿠팡 - 옵션 선택이 안됨 해결
    '/payment',  // 결제시 사용하는 페이지 (쿠팡)
  ];

  // 회색 화이트리스트 도메인 (회색으로 처리)
  const grayDomainWhitelistMap = {
    //'wikipedia.org': [''],  // 유튜브 우회 js (개별적으로 사용중)
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
      //found = Array.from(root.querySelectorAll('iframe, frame, embed, object, ins, script'));
      found = Array.from(root.querySelectorAll(
      'iframe, frame, embed, object, ins, script, script[type="module"], iframe[srcdoc]'
));
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
    if (!ENABLE_LOG_UI) return;  // 로그 UI가 비활성화되었으면 함수 종료
    // 로그 UI 버튼 생성
    const btn = document.createElement('button');
    btn.textContent = '🛡️';
    btn.title = 'Iframe 로그 토글';
    btn.style.cssText = `
      position:fixed;
      bottom:150px;
      right:10px;
      z-index:99999;
      width:40px;
      height:40px;
      border-radius:50%;
      border:none;
      background:#000;  /* 배경을 검은색으로 고정 */
      color:#fff;
      font-size:20px;
      cursor:pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      left: unset;  /* 화면 중앙이 아닌 원 안에서 위치하도록 */
      top: unset;   /* 원 안에서 위치하도록 */
      transition: background 0.3s; /* 배경 전환 효과 */
    `;
    document.body.appendChild(btn);
    makeDraggable(btn);  // 드래그 가능하게 설정

    // 로그 패널 생성
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:150px;right:50px;width:500px;max-height:400px;background:rgba(0,0,0,0.85);color:white;font-family:monospace;font-size:14px;border-radius:10px;box-shadow:0 0 10px black;display:none;flex-direction:column;overflow:hidden;z-index:99999;';
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

    logContent.style.userSelect = 'text';
    logContent.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    panel.appendChild(header);
    panel.appendChild(logContent);
    document.body.appendChild(panel);

    makeDraggable(panel);

    btn.onclick = () => {
      if (logContainer.style.display === 'none') {
        logContainer.style.display = 'flex';
      } else {
        logContainer.style.display = 'none';
      }
    };

    // 더블클릭으로 활성화/비활성화 상태 토글 (아이콘 변경)
    btn.addEventListener('dblclick', () => {
      isEnabled = !isEnabled;

      // 아이콘 변경
      btn.textContent = isEnabled ? '🛡️' : '🚫';  // 활성화 상태는 방패 아이콘, 비활성화 상태는 금지 아이콘으로 변경

      console.log(isEnabled ? 'Iframe Logger 활성화됨' : 'Iframe Logger 비활성화됨');
    });
    // 스타일 적용 추가 부분
    const style = document.createElement('style');
    style.innerHTML = `
      /* 아이콘만 적용될 수 있도록 구체적인 선택자 사용 */
      button#iframeLoggerBtn {
        background-color: #000 !important;  /* 배경을 검은색으로 고정 */
        color: #fff !important;  /* 아이콘 텍스트 색상 고정 */
      }

      /* :hover 효과를 비활성화 (배경색 변경 안됨) */
      button#iframeLoggerBtn:hover {
        background-color: #000 !important;  /* hover 상태에서도 배경색을 검은색으로 고정 */
      }
    `;
    document.head.appendChild(style); // 이 스타일을 문서의 head에 추가하여 적용
  }
  //}

  // iframe 로그 업데이트 카운트
  function updateCountDisplay() {
    if (countDisplay) countDisplay.textContent = `(${count})`;
  }

  // 부모에서 자식 iframe 로그 받아 처리
  window.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('[CHILD_IFRAME_LOG]')) {
      const url = e.data.slice(18);
      logIframe(null, 'from child', url);
    }
  });

  if (window.top !== window) {
    setTimeout(() => {
      window.parent.postMessage('[CHILD_IFRAME_LOG]' + location.href, '*');
    }, 100);
    return;
  }

  // iframe 로그 생성 및 색상 처리
  function logIframe(iframe, reason = '', srcHint = '') {
    if (!isEnabled) return; // 비활성화 상태에서 iframe 로그 찍지 않음

    // 이미 처리한 iframe은 건너뛰기
    if (seen.has(iframe)) return;
    seen.add(iframe);  // 처리된 iframe을 seen에 추가

    let src = srcHint || iframe?.src || iframe?.getAttribute('src') || '';
    const srcdoc = iframe?.srcdoc || iframe?.getAttribute('srcdoc') || '';
    const dataUrls = extractUrlsFromDataset(iframe);
    const extracted = extractUrlsFromSrcdoc(srcdoc);
    if (!src && extracted.length > 0) src = extracted[0];
    if (!src && dataUrls.length > 0) src = dataUrls[0];

    // src가 이미 처리된 src라면 중복 방지
    if (seenSrc.has(src)) return;
    seenSrc.add(src); // src를 추가하여 중복 방지

    const outer = iframe?.outerHTML?.slice(0, 200).replace(/\s+/g, ' ') || '';
    const combined = [src, ...dataUrls, ...extracted].join(' ');

    const matchedKeywords = [];
    globalWhitelistKeywords.forEach(keyword => {
      if (combined.includes(keyword)) matchedKeywords.push(`Global: ${keyword}`);
    });

    const matchedGrayKeywords = [];
    grayWhitelistKeywords.forEach(keyword => {
      if (combined.includes(keyword)) matchedGrayKeywords.push(`Gray: ${keyword}`);
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

    for (const [host, keywords] of Object.entries(grayDomainWhitelistMap)) {
      if (domain.includes(host)) {
        keywords.forEach(keyword => {
          if (path.includes(keyword)) matchedGrayKeywords.push(`Gray Domain: ${keyword} (host: ${host})`);
        });
      }
    }

    const isWhitelistedIframe = matchedKeywords.length > 0;
    const isGrayListedIframe = matchedGrayKeywords.length > 0;

    let logColor = 'red';
    let keywordText = '';

    if (isWhitelistedIframe) {
      logColor = 'green';
      keywordText = `Matched Keywords: ${matchedKeywords.join(', ')}`;
    } else if (isGrayListedIframe) {
      logColor = 'gray'; // 회색 화이트리스트는 회색으로 표시
      keywordText = `Matched Gray Keywords: ${matchedGrayKeywords.join(', ')}`;
    }

    const info = `[#${++count}] ${reason} ${src || '[No src]'}\n └▶ HTML → ${outer}\n ${keywordText}`;
    console.warn('%c[Iframe Detected]', 'color: red; font-weight: bold;', info);

    // 로그 크기가 100을 초과하면 가장 오래된 로그를 제거
    if (logList.length > 100) {
      logList.shift();  // 가장 오래된 로그를 제거
    }

    if (!isWhitelistedIframe && !isGrayListedIframe && iframe && REMOVE_IFRAME) {
      iframe.remove(); // iframe을 바로 제거
    }

    if (ENABLE_LOG_UI && logContent) {
      logList.push(info);  // 새 로그를 logList에 추가
      const div = document.createElement('div');
      div.style.cssText = `color: ${logColor}; padding: 2px 0; white-space: pre-wrap;`;
      div.textContent = info;
      logContent.appendChild(div);
      if (logContent.children.length > 100) logContent.removeChild(logContent.children[0]);
      updateCountDisplay();
    }
  }

  // 초기 스캔 수행
  function scanAll(reason = 'initialScan') {
    const iframes = getAllIframes();
    iframes.forEach(el => logIframe(el, reason));
  }

  // DOM 변화 감지 (새로 추가된 iframe 감지)
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (['IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'INS', 'SCRIPT'].includes(node.tagName)) {
          logIframe(node, 'MutationObserver add');
        }
      }
    }
  });

  observer.observe(document, { childList: true, subtree: true, attributeFilter: ['src', 'srcdoc'] });

  // 주기적으로 iframe 스캔
  setInterval(() => {
    scanAll('periodicScan');
  }, 500);

  // 문서가 로딩되었을 때 UI 생성 및 초기 스캔
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
