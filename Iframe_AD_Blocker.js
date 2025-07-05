// ==UserScript==
// @name         Iframe Logger & Blocker (Violentmonkey용)
// @namespace    none
// @version      9.1
// @description  iframe 탐지/차단 + 화이트리스트 + 로그 UI + SPA 강제유지 + 드래그 + Visibility 최적화 + SPA 보강 + 중복 방지 강화
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ======= 사용자 설정 =======
  const ENABLE_LOG_UI = true;
  const REMOVE_IFRAME_DEFAULT = true;
  //const REMOVE_IFRAME = REMOVE_IFRAME_DEFAULT;

  const allowedSites = ['auth.openai.com', 'accounts.google.com', 'challenges.cloudflare.com'];
  const REMOVE_IFRAME = allowedSites.includes(location.hostname) ? false : REMOVE_IFRAME_DEFAULT;

  const globalWhitelistKeywords = [
    '/recaptcha/', '/challenge-platform/',  // 캡챠
    '/captcha/',  // 캡챠 (픽팍)
    //'.captcha.',  // 캡챠 (픽팍)
    '?urls=magnet',  // 픽팍으로 토렌트 받을때 필요
    'translate',  // 구글 번역
    //'player.bunny-frame.online',  // 티비위키.티비몬.티비핫 플레이어
    'notion.so',  // https://www.notion.so/ 로그인
    '/embed/',  // 커뮤니티 등 게시물 동영상 삽입 (유튜브.트위치.인스타 등 - https://poooo.ml/등에도 적용)  쏘걸 등 성인영상
    '/embed-widget/', '/widgetembed/',  //https://wonforecast.com/ 초기 환율 안나오는거 해걸
    'twitter.com/widgets/widget_iframe',  // 트위터 게시물
    '_photo',  // 스포츠동아 사진 날라감 방지
    '/videoembed/', 'player.kick.com', // https://poooo.ml/
    '/messitv/',  // https://messitv8.com/ (메시티비)
    '/goattv/',  // https://goat-v.com/ (고트티비)
    'dlrstream.com',  // https://blacktv88.com/ (블랙티비)
    '/tV',  // https://kktv12.com/ (킹콩티비)  https://bmtv24.com/ (배트맨티비)  https://nolgoga365.com/ (놀고가닷컴)
    'tv/',  // https://www.cool111.com/ (쿨티비)  https://royaltv01.com/ (로얄티비)  https://conan-tv.com/ (코난티비)
    '/reystream/',  // https://gltv88.com/ (굿라이브티비)
    'supremejav.com',  // https://supjav.com/
    '/e/', '/t/', '/v/', // 각종 성인 영상
    '/player',  // 티비위키.티비몬.티비핫 플레이어  AVseeTV 영상플레이어  https://sextb.date/ US영상
    '/jwplayer/',  // AVseeTV 게시물 영상
    '7tv000.com', '7mmtv',  // https://7tv000.com/
    'njav',  // https://www.njav.com/
    '/stream/',  // https://missvod4.com/
    'pandalive.co.kr/auth/',  // 판타티비
  ];

  const whitelistMap = {
    'place.naver.com': [''],
    'cdnbuzz.buzz': [''],  // https://av19.live/ (AV19)
    'blog.naver.com': [''],
    'cafe.naver.com': [''],
    'www.naver.com': ['my.html'],  // 메인에서 로그인 후 메일 클릭시 메일 안보이는거 해결
  };

  const grayWhitelistKeywords = [
    //'extension:',  // 확장프로그램
    'goodTube',  // 유튜브 우회 js (개별적으로 사용중)
    'aspx',  // 옥션 페이지 안보이거 해결
    '/vp/',  //쿠팡 - 옵션 선택이 안됨 해결
    '/payment',  // 결제시 사용하는 페이지 (쿠팡)
    '/board/movie/',  // 디시인사이드 갤러리 동영상 삽입
    '/static/js/', '/js/jquery/', // https://supjav.com/ 영상 실행 안되는거 (js)
    'lazyload',  '/ajax/', '/assets/',  // https://fc2ppvdb.com/ 이미지 안나오는거 해결 (js)
    '/cheditor/',  // https://www.ppomppu.co.kr/ - myeditor.config.editorpath를 설정하여 주십시오. 메시지 오류 해결
  ];

  const grayDomainWhitelistMap = {
    //'youtube.com': [''],
    //'accounts.youtube.com': [''],
  };

  // ======= 내부 변수 =======
  const ICON_ID = 'iframe-log-icon';
  const PANEL_ID = 'iframe-log-panel';
  let isEnabled = localStorage.getItem('iframeLoggerEnabled') !== 'false';
  //let seen = new WeakSet();
  let seen = new WeakMap();
  let logList = [], count = 0, logContent, countDisplay;

  if (allowedSites.includes(location.hostname)) {
    console.log(`${location.hostname}은 화이트리스트로 iframe 차단 비활성화`);
    return;
  }

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
        const y2 = e2.touches ? e2.touches[0].clientY : e2.clientY;
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
    if (window.top !== window) return;
    if (document.getElementById(ICON_ID)) return;

    const btn = document.createElement('button');
    btn.id = ICON_ID;
    btn.textContent = isEnabled ? '🛡️' : '🚫';
    btn.title = 'Iframe 로그';
    btn.style.fontFamily = `'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', Arial, sans-serif`;
    btn.style.cssText = `
      position:fixed !important;
      bottom:150px !important;
      right:10px !important;
      z-index:99999 !important;
      width:45px !important;
      height:45px !important;
      border-radius:50% !important;
      border:none !important;
      background:#000 !important;
      color:#fff !important;
      font-size:32px !important;
      cursor:pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      left: unset !important;
      top: unset !important;
      transition: background 0.3s !important;
      opacity: 0.40 !important;
      visibility: visible !important;
      pointer-events: auto !important;
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

    // 로그 UI 전용 스타일 (폰트 크기 강제 지정 및 줄바꿈 보정)
    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} {
        font-size: 16px !important;
      }
      #${PANEL_ID} * {
        font-size: 16px !important;
      }
      #${PANEL_ID} button {
        font-size: 14px !important;
      }
      #${PANEL_ID} div {
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position:fixed; bottom:150px; right:60px; width:500px; height:400px;
      background:rgba(0,0,0,0.85); color:white; font-family:monospace;
      font-size:16px; border-radius:12px; box-shadow:0 0 10px black;
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
    //logContent.style = 'overflow-y:auto;flex:1;padding:6px 10px;white-space:pre-wrap;word-wrap:break-word;';
    logContent.style = 'overflow-y:auto;flex:1;padding:3px 3px;white-space:pre-wrap;word-wrap:break-word; line-height: 1.4;';
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
  // iframe의 src가 동적으로 바뀌어도 중복 처리 여부를 src 기준으로 한번 더 검사
  function logIframe(iframe, reason = '') {
    if (!isEnabled) return;

    const src = iframe?.src || iframe?.getAttribute('src') || '';
    if (!src || src === 'about:blank' || src.startsWith('chrome-extension://')) return;

    const prevSrc = seen.get(iframe);
    if (prevSrc === src) return;  // src가 같으면 이미 처리함

    seen.set(iframe, src);  // iframe별로 현재 src 저장

    const u = new URL(src, location.href);
    const domain = u.hostname, path = u.pathname + u.search;

    let color = 'red', keyword = '', matchedDomain = '';

    // 개선된 if-else 구조로 화이트/그레이 리스트 검사 (첫 매칭시 종료)
    const matchedKeyword = globalWhitelistKeywords.find(k => src.includes(k));
    if (matchedKeyword) {
      color = 'green';
      keyword = matchedKeyword;
    } else {
      const matchedGray = grayWhitelistKeywords.find(k => src.includes(k));
      if (matchedGray) {
        color = 'gray';
        keyword = matchedGray;
      } else {
        for (const host of Object.keys(whitelistMap)) {
          if (domain.includes(host)) {
            color = 'green';
            matchedDomain = domain;
            break;
          }
        }
        if (!matchedDomain) {
          for (const host of Object.keys(grayDomainWhitelistMap)) {
            if (domain.includes(host)) {
              color = 'gray';
              matchedDomain = domain;
              break;
            }
          }
        }
      }
    }

    // 로그 문자열 생성 시 template literal + join 최적화
    //const info = `[#${++count}] ${reason} ${src} (매칭키워드 : ${keyword || matchedDomain || '없음'})`;
    const parts = [`[#${++count}]`, reason, src];
    parts.push(` (매칭키워드 : ${keyword || matchedDomain || '없음'})`);
    const info = parts.join('');
    console.warn('%c[Iframe]', `color:${color};font-weight:bold`, info);

    logList.push(info);
    if (logList.length > 5000) logList.shift();

    if (logContent) {
      const div = document.createElement('div');
      div.textContent = info;
      div.style = `color:${color}; padding:2px 0;`;
      logContent.appendChild(div);
    }

    updateCount();

    if (!keyword && !matchedDomain && REMOVE_IFRAME) {
      setTimeout(() => iframe.remove(), 0);
    }
  }

  function getAllIframes() {
    return Array.from(document.querySelectorAll('iframe, frame, embed, object, script'));
  }

  // ======= 동적 요소 추적 =======
  const mo = new MutationObserver(muts => {
    muts.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (!node.tagName) return;  // 텍스트 노드 등 무시
        const tag = node.tagName.toUpperCase();
        if (['IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'SCRIPT'].includes(tag)) {  // iframe외 추적 대상을 늘림
          //if (['IFRAME'].includes(tag)) {  // 일반적인 페이지에서는 iframe 외 다른 걸로는 많이 안나옴 (유튜브.틱톡 등 제외)
          logIframe(node, '동적 추가 \n ▷');
        }
      });
    });
  });

  function safeObserveBody() {
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true });
    } else {
      new MutationObserver(() => {
        if (document.body) {
          mo.observe(document.body, { childList: true, subtree: true });
        }
      }).observe(document.documentElement, { childList: true });
    }
  }
  safeObserveBody();

  // ======= SPA 강제유지 =======
  function keepAlive() {
    if (!document.body) return;
    if (!document.getElementById(ICON_ID)) createIcon();
    if (ENABLE_LOG_UI && !document.getElementById(PANEL_ID)) createLogUI();
  }

  // DOM 준비 시 UI 초기 생성
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', keepAlive);
  } else {
    keepAlive();
  }

  // ✅ Visibility 상태 기반 최적화 적용
  let intervalActive = true;
  // 브라우저 탭이 활성화 상태가 아니면 setInterval이 멈춤 (탭이 보일 때만 스크립트가 CPU를 사용)
  document.addEventListener('visibilitychange', () => {
    intervalActive = document.visibilityState !== 'hidden';
  });

  // 동적 감지 및 UI 활성화 유지 (백업 역할)
  // 초기 로드 안에서 못 잡은 iframe이나 MutationObserver가 못 잡은 걸 주기적으로 다시 체크하는 안전망
  // 너무 빨리하면 CPU를 계속 태우면서 같은 걸 여러 번 처리 → 낭비 / 너무 느리면 동적 iframe이 화면에 잠시 보였다 사라질 수도 있음.
  //setInterval(() => {
    //if (!intervalActive) return;
    //getAllIframes().forEach(iframe => logIframe(iframe, '초기 스캔 \n ▷'));
  //}, 1000);  // 1초마다 감지 - 최대한 짧게 하면 js 차단수도 많아지지만 js 해제해야할것도 늘어남

  // iframe 탐지 → loop() 로 교체
  // 화면 리프레시마다 (보통 60fps → 약 16.7ms마다 1번) (CPU 부하는 높아짐)
  // 사실상 setInterval(16)과 비슷하지만, 렌더링 직전에 실행되기 때문에 화면 깜박임과 싱크가 잘 맞아 부드러움
  function loop() {
    if (!intervalActive) return;
    getAllIframes().forEach(iframe => logIframe(iframe, '초기 스캔 \n ▷'));
    requestAnimationFrame(loop);  // requestAnimationFrame은 탭이 비활성화되면 자동으로 멈춰서 CPU 낭비를 줄여줌
  }

  // 아이콘/패널이 강제로 제거되거나 SPA로 사라졌을 때 다시 살려주는 역할
  setInterval(() => {
    if (!intervalActive) return;
    keepAlive();
  }, 2000); // 2초마다 UI 유지

  requestAnimationFrame(loop);

  new MutationObserver(keepAlive).observe(document.documentElement, { childList: true, subtree: true });

  // ✅ SPA popstate & pushState 감시 추가 (뒤로가기/앞으로가기 시에도 감지해서 UI/감시 유지)
  //window.addEventListener('popstate', keepAlive);
  //const originalPushState = history.pushState;
  // SPA 내부 링크 이동 시에도 무조건 감지
  //history.pushState = function () {
    //originalPushState.apply(this, arguments);
    //keepAlive();
  //};

  // 한 번만 패치하도록 플래그(window._pushStatePatched)를 사용해서 중복 실행을 방지
  if (!window._pushStatePatched) {
  const originalPushState = history.pushState;
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    keepAlive();
  };
  window._pushStatePatched = true;
  }
  window.addEventListener('popstate', keepAlive);

})();
