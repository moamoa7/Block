// ==UserScript==
// @name         Iframe Logger & Blocker (Violentmonkey용, SPA 강제유지 통합 / 동적최적화 / document-start)00
// @namespace    none
// @version      8.8
// @description  iframe 탐지/차단 + 화이트리스트 + 로그 UI + SPA 강제유지 + 드래그
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
    '?urls=magnet',  // 픽팍으로 토렌트 받을때 필요
    '/TranslateWebserverUi/',  // 구글 번역
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
    '/player',  // 티비위키.티비몬.티비핫 플레이어  https://05.avsee.ru/  https://sextb.date/ US영상
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
  ];

  const grayDomainWhitelistMap = {
    //'youtube.com': [''],
    //'accounts.youtube.com': [''],
  };

  // ======= 내부 변수 =======
  const ICON_ID = 'iframe-log-icon';
  const PANEL_ID = 'iframe-log-panel';
  let isEnabled = localStorage.getItem('iframeLoggerEnabled') !== 'false';
  let seen = new WeakSet();
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
  function logIframe(iframe, reason = '') {
    if (!isEnabled || seen.has(iframe)) return;
    seen.add(iframe);

    let src = iframe?.src || iframe?.getAttribute('src') || '';
    if (src === 'about:blank' || src.startsWith('chrome-extension://') || !src) return;

    const u = new URL(src, location.href);
    const domain = u.hostname, path = u.pathname + u.search;

    let color = 'red', keyword = '', matchedDomain = '';
    const matchedKeywords = globalWhitelistKeywords.filter(k => src.includes(k));
    if (matchedKeywords.length > 0) { color = 'green'; keyword = matchedKeywords.join(', '); }
    const matchedGray = grayWhitelistKeywords.filter(k => src.includes(k));
    if (matchedGray.length > 0) { color = 'gray'; keyword = matchedGray.join(', '); }
    for (const [host] of Object.entries(whitelistMap)) {
      if (domain.includes(host)) { matchedDomain = domain; color = 'green'; break; }
    }
    for (const [host] of Object.entries(grayDomainWhitelistMap)) {
      if (domain.includes(host)) { matchedDomain = domain; color = 'gray'; break; }
    }

    const info = `[#${++count}] ${reason} ${src} (매칭키워드 : ${keyword || matchedDomain || '없음'})`;
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

    if (!matchedKeywords.length && !matchedGray.length && REMOVE_IFRAME) {
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

  // 동적 감지 및 UI 활성화 유지
  setInterval(() => {
    getAllIframes().forEach(iframe => logIframe(iframe, '초기 스캔 \n ▷'));
  }, 0);

  setInterval(keepAlive, 0);

  new MutationObserver(keepAlive).observe(document.documentElement, { childList: true, subtree: true });

})();
