// ==UserScript==
// @name         Iframe Logger & Blocker (Violentmonkey용, SPA 강제유지 통합 / 동적최적화)
// @namespace    none
// @version      8.6
// @description  iframe 탐지/차단 + 화이트리스트 + 로그 UI + SPA 강제유지 + 드래그
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ======= 사용자 설정 =======
  const ENABLE_LOG_UI = true;
  const REMOVE_IFRAME_DEFAULT = true;
  const REMOVE_IFRAME = REMOVE_IFRAME_DEFAULT;

  const globalWhitelistKeywords = [
    '/recaptcha/', '/challenge-platform/',  // 캡챠
    '/captcha/',  // 캡챠 (픽팍)
    '/TranslateWebserverUi/',  // 구글 번역
    //'player.bunny-frame.online',  // 티비위키.티비몬.티비핫 플레이어
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
    '/player',  // 티비위키.티비몬.티비핫 플레이어  https://05.avsee.ru/  https://sextb.date/ US영상
    '7tv000.com', '7mmtv',  // https://7tv000.com/
    'njav',  // https://www.njav.com/
    '/stream/',  // https://missvod4.com/
  ];

  const whitelistMap = {
    'chatgpt.com': [''],  // https://chatgpt.com/ 로그인
    'place.naver.com': [''],
    'cdnbuzz.buzz': [''],  // https://av19.live/ (AV19)
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'www.naver.com': ['my.html'],  // 메인에서 로그인 후 메일 클릭시 메일 안보이는거 해결
    'chatgpt.com': [''],  // ChatGPT
    //'tiktok.com': [''],
  };

  const grayWhitelistKeywords = [
    //'extension:',  // 확장프로그램
    'goodTube',  // 유튜브 우회 js (개별적으로 사용중)
    'aspx',  // 옥션 페이지 안보이거 해결
    '/vp/',  //쿠팡 - 옵션 선택이 안됨 해결
    '/payment',  // 결제시 사용하는 페이지 (쿠팡)
    '/board/movie/',  // 디시인사이드 갤러리 동영상 삽입
    //'mp4',  // 영상 기본 파일
  ];

  const grayDomainWhitelistMap = {
    'youtube.com': [''],
    'accounts.youtube.com': [''],
  };

  // ======= 내부 변수 =======
  const ICON_ID = 'iframe-log-icon';
  const PANEL_ID = 'iframe-log-panel';
  let isEnabled = localStorage.getItem('iframeLoggerEnabled') !== 'false';
  let seen = new WeakSet();
  let logList = [], count = 0, logContainer, logContent, countDisplay;

  // ======= 드래그 가능 =======
  function makeDraggable(el) {
    let offsetX, offsetY, isDragging = false;

    const start = (e) => {
      isDragging = true;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      offsetX = x - el.getBoundingClientRect().left;
      offsetY = y - el.getBoundingClientRect().top;

      const move = (e2) => {
        if (!isDragging) return;
        const x2 = e2.touches ? e2.touches[0].clientX : e2.clientX;
        const y2 = e.touches ? e.touches[0].clientY : e.clientY;
        el.style.left = `${x2 - offsetX}px`;
        el.style.top = `${y2 - offsetY}px`;
      };

      const stop = () => { isDragging = false; };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', stop);
      document.addEventListener('touchmove', move);
      document.addEventListener('touchend', stop);
    };

    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start);
  }

  // ======= 아이콘 =======
  function createIcon() {
    if (window.top !== window) {
      return;  // 자식 iframe인 경우 아이콘 생성하지 않음
    }

    if (document.getElementById(ICON_ID)) return;

    const btn = document.createElement('button');
    btn.id = ICON_ID;
    btn.textContent = isEnabled ? '🛡️' : '🚫';
    btn.title = 'Iframe 로그';
    btn.style.cssText = `
      position:fixed; bottom:150px; right:10px; z-index:99999;
      width:45px; height:45px; border-radius:50%;
      border:none; background:#000; color:#fff; font-size:32px;
      display:flex; align-items:center; justify-content:center;
      opacity:0.4; cursor:pointer;
    `;
    btn.onclick = () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      }
    };
    btn.ondblclick = () => {
      isEnabled = !isEnabled;
      localStorage.setItem('iframeLoggerEnabled', isEnabled);
      btn.textContent = isEnabled ? '🛡️' : '🚫';
      console.log('Iframe Logger 활성화:', isEnabled);
    };
    makeDraggable(btn);
    document.body.appendChild(btn);
  }

  // ======= 로그 UI =======
  function createLogUI() {
    if (document.getElementById(PANEL_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #iframe-log-panel {
        font-size: 16px !important;
      }
      #iframe-log-panel * {
        font-size: 16px !important;
      }
      #iframe-log-panel button {
        font-size: 14px !important;
      }
      #iframe-log-panel div {
        //white-space: nowrap; /* 텍스트가 한 줄로 표시되도록 */
        //overflow-x: auto; /* 가로 스크롤 추가 */
        //overflow-y: auto; /* 세로 스크롤 추가 */
        white-space: pre-wrap; /* 줄바꿈 유지 */
        word-wrap: break-word; /* 긴 주소도 줄바꿈을 통해 잘리지 않게 */
        overflow-wrap: break-word;; /* 여유 공간 없을 때 자동 줄바꿈 */
      }
  `;
  document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position:fixed; bottom:150px; right:60px; width:500px; height:400px;
      background:rgba(0,0,0,0.85); color:white; font-family:monospace;
      font-size:16px; border-radius:10px; box-shadow:0 0 10px black;
      display:none; flex-direction:column; text-align:left !important;
      overflow:hidden; z-index:99999; font-weight:bold
    `;
    const header = document.createElement('div');
    header.style = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#000;';
    const title = document.createElement('span');
    title.textContent = '🛡️ Iframe Log';
    countDisplay = document.createElement('span');
    countDisplay.style = 'font-size:12px; color:#ccc; margin-left:6px;';
    countDisplay.textContent = '(0)';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 복사';
    copyBtn.style = 'font-size:12px;background:#444;color:white;border:none;border-radius:5px;padding:2px 8px;cursor:pointer;';
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
    logContent.style = 'overflow-y:auto;flex:1;padding:6px 10px;white-space:pre-wrap;word-wrap:break-word;';
    logContent.style.userSelect = 'text';
    logContent.addEventListener('mousedown', e => e.stopPropagation());

    panel.appendChild(header);
    panel.appendChild(logContent);
    document.body.appendChild(panel);
  }

  function updateCount() {
    if (countDisplay) countDisplay.textContent = `(${count})`;
  }

  // ======= iframe 로깅 =======
  function logIframe(iframe, reason = '') {
    if (!isEnabled || seen.has(iframe)) return;
    seen.add(iframe);

    let src = iframe?.src || iframe?.getAttribute('src') || '';

    // 디버깅용 콘솔 로그 추가
    console.log(`src: ${src}`);  // src가 제대로 추출되는지 확인

    // about:blank 무시 처리
    if (src === 'about:blank') {
      console.log('about:blank iframe detected, skipping...');
      return; // 무시
    }

    if (src.startsWith('chrome-extension://')) {
      return; // 무시하거나 로그 최소화
    }

    if (!src) return;

    const u = new URL(src, location.href);
    const domain = u.hostname, path = u.pathname + u.search;  // path와 search를 구분

    // 추가된 디버깅 로그
    console.log(`domain: ${domain}`);
    console.log(`path: ${path}`);
    console.log(`search: ${u.search}`);

    let color = 'red', keyword = '', matchedDomain = '';

    // 화이트리스트 키워드 매칭 처리
    const matchedKeywords = globalWhitelistKeywords.filter(k => src.includes(k));
    if (matchedKeywords.length > 0) {
      color = 'green';  // 화이트리스트 키워드 매칭 시 색상 변경
      keyword = matchedKeywords.join(', ');  // 매칭된 키워드 저장
    }

    // 그레이리스트 키워드 매칭 처리
    const matchedGray = grayWhitelistKeywords.filter(k => src.includes(k));
    if (matchedGray.length > 0) {
      color = 'gray';  // 그레이리스트 키워드 매칭 시 색상 변경
      keyword = matchedGray.join(', ');  // 매칭된 키워드 저장
    }

    // 화이트리스트 도메인 매칭 처리
    for (const [host, kws] of Object.entries(whitelistMap)) {
      if (domain.includes(host)) {
        matchedDomain = domain;  // 매칭된 도메인 저장
        color = 'green';  // 화이트리스트 도메인 매칭 시 색상 변경
        break;
      }
    }

    // 그레이리스트 도메인 매칭 처리
    for (const [host, kws] of Object.entries(grayDomainWhitelistMap)) {
      if (domain.includes(host)) {
        matchedDomain = domain;  // 매칭된 도메인 저장
        color = 'gray';  // 그레이리스트 도메인 매칭 시 색상 변경
        break;
      }
    }

    //const info = `[#${++count}] ${reason} ${src} (매칭키워드 : ${keyword})`;
    const info = `[#${++count}] ${reason} ${src} (매칭키워드 : ${keyword || matchedDomain || '없음'})`;
    console.warn('%c[Iframe]', `color:${color};font-weight:bold`, info);

    // 로그 리스트에 추가
    logList.push(info);
    if (logList.length > 500) logList.shift();

    // 로그 UI에 출력
    if (logContent) {
      const div = document.createElement('div');
      div.textContent = info;
      div.style = `color:${color}; padding:2px 0;`;
      logContent.appendChild(div);
    }

    updateCount();

    // iframe을 차단하려면
    if (!matchedKeywords.length && !matchedGray.length && REMOVE_IFRAME) {
      setTimeout(() => iframe.remove(), 0);
    }
  }

  function getAllIframes() {
    return Array.from(document.querySelectorAll('iframe, frame, embed, object'));
  }

  // ======= 동적 요소 추적 =======
  setInterval(() => getAllIframes().forEach(iframe => logIframe(iframe, '추가 요소 (1차) \n ▷')), 20);

  const mo = new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.tagName === 'IFRAME') logIframe(n, '동적 추적 \n ▷');
  })));
  mo.observe(document.body, { childList: true, subtree: true });

  // ======= SPA 강제유지 =======
  function keepAlive() {
    if (!document.getElementById(ICON_ID)) createIcon();
    else {
      const icon = document.getElementById(ICON_ID);
      icon.style.display = 'block'; icon.style.zIndex = '99999'; icon.style.opacity = '0.4';
    }
    if (ENABLE_LOG_UI && !document.getElementById(PANEL_ID)) createLogUI();
  }

  setInterval(keepAlive, 20);
  new MutationObserver(keepAlive).observe(document.body, { childList: true, subtree: true });

  createIcon();
  if (ENABLE_LOG_UI) createLogUI();

})();
