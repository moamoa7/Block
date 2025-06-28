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
  //const REMOVE_IFRAME = true;  // iframe 제거 여부
  const seen = new WeakSet(); // 이미 처리한 iframe을 추적하는 WeakSet
  const seenSrc = new Set();  // 이미 처리한 src를 추적하는 Set
  let count = 0;  // iframe 탐지 카운트
  let logList = [];  // 로그 항목 저장 배열
  let logContainer, logContent, countDisplay; // 로그 UI 관련 DOM 요소

  let currentlyScanning = false;  // scanAll 실행 중인지 여부를 추적
  let seenDuringScan = new Set();  // scanAll 중에 처리한 iframe을 추적

  // iframe 제거 기본값
  const REMOVE_IFRAME_DEFAULT = true;  // iframe 제거 기본값

  // 차단 해제할 사이트들
  const allowedSites = ['example.com', 'example.com'];

  // 현재 사이트가 allowedSites에 포함되면 iframe 차단을 해제
  let REMOVE_IFRAME = allowedSites.includes(window.location.hostname) ? false : REMOVE_IFRAME_DEFAULT;

  // allowedSites 배열에서 현재 사이트가 포함되면 로직 종료
  if (allowedSites.includes(window.location.hostname)) {
      console.log(`${window.location.hostname}에 접속했으므로 로직을 정지합니다.`);
      return;  // 해당 사이트에서 로직 종료
  }

  // 로컬 스토리지에서 값 가져오기
  let isEnabled = localStorage.getItem('iframeLoggerEnabled');

  // 값이 없으면 'true'로 설정하고 저장
  if (isEnabled === null) {
    isEnabled = 'true';  // 기본값을 'true'로 설정
    localStorage.setItem('iframeLoggerEnabled', isEnabled);  // 저장
  }

  // 'true'/'false' 문자열을 boolean으로 변환
  isEnabled = isEnabled === 'true';

  console.log('Iframe Logger 활성화 여부:', isEnabled);  // 활성화 여부 확인

  // 글로벌 키워드 화이트리스트 (특정 키워드를 포함하는 iframe은 녹색으로 표시)
  const globalWhitelistKeywords = [
    '/recaptcha/', '/challenge-platform/',  // 캡챠
    'player.bunny-frame.online',  // 티비위키.티비몬.티비핫 플레이어
    '/embed/',  // 커뮤니티 등 게시물 동영상 삽입 (유튜브.트위치.인스타 등 - https://poooo.ml/등에도 적용)  쏘걸 등 성인영상
    '/videoembed/', 'player.kick.com', // https://poooo.ml/
    '/messitv/',  // https://messitv8.com/ (메시티비)
    '/goattv/',  // https://goat-v.com/ (고트티비)
    'dlrstream.com',  // https://blacktv88.com/ (블랙티비)
    '/tV',  // https://kktv12.com/ (킹콩티비)  https://bmtv24.com/ (배트맨티비)  https://nolgoga365.com/ (놀고가닷컴)
    'tv/',  // https://www.cool111.com/ (쿨티비)  https://royaltv01.com/ (로얄티비)  https://conan-tv.com/ (코난티비)
    '/reystream/',  // https://gltv88.com/ (굿라이브티비)
    'supremejav.com',  // https://supjav.com/
    '/e/', '/t/', '/v/', // 각종 성인 영상
    '/player',  // https://05.avsee.ru/  https://sextb.date/ US영상
    '7tv000.com', '7mmtv',  // https://7tv000.com/
    'njav',  // https://www.njav.com/
    '/stream/',  // https://missvod4.com/
  ];

  // 도메인별 키워드 화이트리스트 (특정 도메인에서 특정 키워드를 포함하는 경우 녹색 처리)
  const whitelistMap = {
    'place.naver.com': [''],
    'cdnbuzz.buzz': [''],  // https://av19.live/ (AV19)
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'www.naver.com': ['my.html'],  // 메인에서 로그인 후 메일 클릭시 메일 안보이는거 해결
    //'tiktok.com': [''],
  };

  // 회색 화이트리스트 키워드 (회색으로 처리)
  const grayWhitelistKeywords = [
    'extension:',  // 확장프로그램
    'goodTube',  // 유튜브 우회 js (개별적으로 사용중)
    'aspx',  // 옥션 페이지 안보이거 해결
    '/vp/',  //쿠팡 - 옵션 선택이 안됨 해결
    '/payment',  // 결제시 사용하는 페이지 (쿠팡)
    '/board/movie/',  // 디시인사이드 갤러리 동영상 삽입
  ];

  // 회색 화이트리스트 도메인 (회색으로 처리)
  const grayDomainWhitelistMap = {
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
      found = Array.from(root.querySelectorAll(
        'iframe, frame, embed, object, ins, script, script[type="module"], iframe[srcdoc]'
      ));
    } catch {}
    console.log('Found iframes:', found); // iframe 탐지 로그 추가
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) {
        found = found.concat(getAllIframes(node.shadowRoot));
      }
    }
    console.log('Total iframes found:', found.length); // 최종적으로 찾은 iframe 갯수
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
    if (document.getElementById('iframe-log-panel')) return;  // 이미 존재하면 함수 종료

    // 로그 UI 버튼 생성
    const btn = document.createElement('button');
    btn.textContent = isEnabled ? '🛡️' : '🚫'; // 상태에 따라 아이콘 설정
    btn.title = 'Iframe 로그 토글';
    btn.style.cssText = `
      position:fixed;
      bottom:150px;
      right:10px;
      z-index:99999;
      width:45px;
      height:45px;
      border-radius:50%;
      border:none;
      background:#000;  /* 배경을 검은색으로 고정 */
      color:#fff;
      font-size:32px !important;  /* 아이콘 크기 증가 */
      cursor:pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      left: unset;  /* 화면 중앙이 아닌 원 안에서 위치하도록 */
      top: unset;   /* 원 안에서 위치하도록 */
      transition: background 0.3s; /* 배경 전환 효과 */
      opacity: 0.40; /* 아이콘 투명도 */
    `;
    document.body.appendChild(btn);
    makeDraggable(btn);  // 드래그 가능하게 설정 (이 부분을 주석처리하면 아이콘 UI 드래그 기능 비활성화)

    // 로그 패널 생성
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:150px;right:60px;width:500px;height:400px;background:rgba(0,0,0,0.85);color:white;font-family:monospace;font-size:16px;border-radius:10px;box-shadow:0 0 10px black;display:none;flex-direction:column;text-align:left !important;overflow:hidden;z-index:99999;';
    panel.id = 'iframe-log-panel';  // 패널에 ID 추가하여 중복 방지
    logContainer = panel;

    // 로그 UI만 스타일을 변경하는 CSS 추가
    const style = document.createElement('style');
    style.textContent = `
      #iframe-log-panel {
        font-size: 16px !important; /* 로그 패널 내에서만 폰트 크기 변경 */
      }
      #iframe-log-panel * {
        font-size: 16px !important; /* 하위 모든 요소에도 적용 */
        //color: white !important;
      }
      #iframe-log-panel button {
        font-size: 16px !important; /* 버튼 크기 조정 */
      }

    `;
    document.head.appendChild(style);  // 스타일을 <head>에 추가하여 적용

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

    // 스크롤 가능하게 설정 (드래그 기능은 비활성화)
    //logContent.style.overflowY = 'auto';  // 세로 스크롤 활성화
    //logContent.style.maxHeight = '300px'; // 로그 내용이 많을 경우 높이 제한
    //logContent.style.userSelect = 'text';  // 텍스트 선택 가능하게 설정
    //logContent.addEventListener('mousedown', (e) => {
      //e.stopPropagation();  // 마우스 다운 시 이벤트 전파 방지
    //});

    logContent.style.userSelect = 'text';
    logContent.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    panel.appendChild(header);
    panel.appendChild(logContent);
    document.body.appendChild(panel);

    //makeDraggable(panel);  // 드래그 가능하게 설정 (이 부분을 주석처리하면 로그내역 드래그 기능 비활성화)

    // 로그 UI 표시/숨기기 버튼 클릭 시 동작
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

      // 상태를 localStorage에 저장
      localStorage.setItem('iframeLoggerEnabled', isEnabled);

      // 아이콘 변경
      btn.textContent = isEnabled ? '🛡️' : '🚫';  // 활성화 상태는 방패 아이콘, 비활성화 상태는 금지 아이콘으로 변경

      console.log('Iframe Logger 활성화 여부:', isEnabled);  // 상태 변경 후 활성화 여부 출력
    });
  }

  // iframe 로그 업데이트 카운트
  function updateCountDisplay() {
    if (countDisplay) countDisplay.textContent = `(${count})`;
  }

  // 부모에서 자식 iframe 로그 받아 처리
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://child-domain.com') {
      console.warn('Invalid origin:', e.origin);
      return;  // 신뢰할 수 없는 도메인에서 온 메시지는 무시
    }
    console.log('Received message from child:', e.data);  // 메시지 내용 확인
    if (typeof e.data === 'string' && e.data.startsWith('[CHILD_IFRAME_LOG]')) {
      const url = e.data.slice(18);
      logIframe(null, 'from child', url);  // 부모에서 자식 iframe 로그 처리
    }
  });

  // 자식 iframe에서 부모로 메시지를 보내는 코드
  if (window.top !== window) {
    setTimeout(() => {
      console.log('Sending message to parent:', location.href);
      window.parent.postMessage('[CHILD_IFRAME_LOG]' + location.href, 'https://parent-domain.com');  // 부모의 정확한 도메인
    }, 0);  // 자식 iframe에서 부모로 메시지 보내는 타이밍
    return;
  }

  // iframe 로그 생성 및 색상 처리
  function logIframe(iframe, reason = '', srcHint = '') {
    if (!isEnabled) return; // 비활성화 상태에서 iframe 로그 찍지 않음

    if (seen.has(iframe)) return;  // 이미 처리한 iframe은 건너뛰기
    seen.add(iframe);  // 처리된 iframe을 seen에 추가

    let src = srcHint || iframe?.src || iframe?.getAttribute('src') || '';
    const srcdoc = iframe?.srcdoc || iframe?.getAttribute('srcdoc') || '';
    const dataUrls = extractUrlsFromDataset(iframe);
    const extracted = extractUrlsFromSrcdoc(srcdoc);

    // src가 비어있을 때 srcdoc이나 data-* 속성을 확인
    if (!src && extracted.length > 0) src = extracted[0];
    if (!src && dataUrls.length > 0) src = dataUrls[0];

    // 'about:blank'일 경우에 대한 처리 추가
    if (src === 'about:blank') {
      console.warn('Detected iframe with about:blank src');
      return;  // 'about:blank'는 처리하지 않음
    }

    // src가 없으면 경고 메시지를 찍고 종료
    if (!src) {
      console.warn('No src found for iframe');
      return;
    }

    // 여기에 src가 제대로 추출된 경우의 로그 추가
    console.log(`Logging iframe with src: ${src}`);  // 로그 추가
    console.log('Detected iframe:', iframe);  // iframe 객체 로그

    const outer = iframe?.outerHTML?.slice(0, 200).replace(/\s+/g, ' ') || '';
    const combined = [src, ...dataUrls, ...extracted].join(' ');

    // 'src'에 직접 할당이 발생할 때를 추적하기 위한 코드 추가
    const origSet = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (origSet && origSet.set) {
        Object.defineProperty(iframe, 'src', {
            set: function(value) {
                logIframe(iframe, reason + ' (direct assign)');  // src 값 할당 시 로깅
                return origSet.set.call(this, value);  // 원래 src 설정 동작 실행
            },
            get: origSet.get, // 기존 getter 유지
            configurable: true,
            enumerable: true
        });
    }

    // 로그 출력 및 처리
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

    const info = `[#${++count}] ${reason} ${src || '[No src]'}\n└▶ ${outer}\n ${keywordText}`;
    console.warn('%c[Iframe Detected]', 'color: red; font-weight: bold;', info);

    // 로그 크기가 100을 초과하면 가장 오래된 로그를 제거
    if (logList.length > 100) {
      logList.shift();  // 가장 오래된 로그를 제거
    }
    // iframe을 완전히 제거하는 방법 (스크립트 실행을 방지하는 방식)
    if (!isWhitelistedIframe && !isGrayListedIframe && iframe && REMOVE_IFRAME) {
      // 로그 출력 후 제거하도록 변경
      try {
        setTimeout(() => {
          iframe.remove(); // iframe을 제거하여 내부 스크립트가 실행되지 않도록 방지
        }, 50);
      } catch (e) {
        console.error('Error removing iframe:', e);  // 오류 발생 시 콘솔에 오류 출력
      }
    }

    if (ENABLE_LOG_UI && logContent) {
      logList.push(info);  // 새 로그를 logList에 추가
      const div = document.createElement('div');
      div.style.cssText = `color: ${logColor}; padding: 2px 0; white-space: pre-wrap;`;
      div.textContent = info;
      logContent.appendChild(div);
      updateCountDisplay();
    }
  }

  // 이미 처리된 iframe을 추적하는 Set
    //const seen = new WeakSet();  // 기존의 `seen`만 사용 (상단에서 정의됨)

    window.onload = function () {
      const iframes = getAllIframes(document);  // 이미 존재하는 iframe을 찾습니다.
      iframes.forEach(iframe => {
        if (!seen.has(iframe)) {  // 이미 처리되지 않은 iframe만 처리
          logIframe(iframe, 'Element added');
          seen.add(iframe);  // 처리된 iframe을 추적
        }
      });
    };

  // 동적 처리: 일정 간격으로 iframe 체크 (setInterval)
  setInterval(() => {
    const iframes = getAllIframes(document);  // 현재 페이지의 모든 iframe을 체크
    iframes.forEach(iframe => {
      logIframe(iframe, 'Periodic check');
    });
  }, 2000); // 2초마다 체크 (더 빠르면 틱톡등에서 오류남)

  // MutationObserver를 사용하여 동적으로 추가되는 iframe 추적
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.tagName === 'IFRAME' && node.src && !seen.has(node)) {
        console.log('New iframe added with src:', node.src);
        logIframe(node, 'Element added');
        seen.add(node);

          // iframe 차단
          node.remove();  // 해당 iframe을 제거
        }
      });
    });
  });

  // observer 설정: body에서 자식 노드의 변경을 추적
  observer.observe(document.body, { childList: true, subtree: true });

  // 로그 UI 생성
  if (ENABLE_LOG_UI) {
    createLogUI();
  }

})();
