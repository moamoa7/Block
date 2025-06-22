// ==UserScript==
// @name         Iframe Logger & Blocker (화이트리스트 색상표시 + 캡챠 중복 방지)
// @namespace    none
// @version      7.7.6
// @description  iframe 로그에 화이트리스트 초록색 표시 + 차단 iframe 빨간색 표시 + 캡챠 중복 방지 + 성공/실패 메시지 제거
// @match        *://*/*
// @grant        none
// ==/UserScript==
(function() {
  'use strict';

  const REMOVE_IFRAME = true;

  // 캡챡 관련 키워드
  const CAPTCHA_KEYWORDS = [
    'recaptcha','challenge-platform','turnstile','captcha','cloudflare'
  ];

  // 전체 화이트리스트 키워드
  const WHITELIST_KW = [
    ...CAPTCHA_KEYWORDS,
    'player.bunny-frame.online','/embed/','/e/','/t/','/v/',
    'dlrstream.com','123123play.com','supremejav.com','goodTubeProxy',
    '7tv000.com','/dplayer','chrome-extension://'
  ];

  const DOMAIN_WHITELIST = {
    'player/': ['avsee.ru'],
    'my.html': ['naver.com'],
    'payment': ['coupang.com']
  };

  let captchaActive = false;
  let captchaDeactivateTimeout = null;
  const captchaIframes = new WeakSet();

  let logContainer, logContent, toggleBtn, countDisplay;
  let count = 0;
  const logList = [];

  function normalizeDomain(h){ return h.replace(/^www\./,'').trim(); }

  function isWhitelisted(url=''){
    try {
      for(let kw of WHITELIST_KW) if(url.includes(kw)) return true;
      let u = new URL(url, location.href), d = normalizeDomain(u.hostname);
      for(let [kw, ds] of Object.entries(DOMAIN_WHITELIST)) {
        if(url.includes(kw) && ds.some(x => d.endsWith(normalizeDomain(x)))) return true;
      }
    } catch {}
    return false;
  }

  function extractUrls(el){
    let urls = [];
    try {
      ['src','srcdoc'].forEach(attr => {
        let v = el.getAttribute(attr);
        if(v && /^https?:\/\//.test(v)) urls.push(v);
      });
      for(let key of Object.keys(el.dataset)) {
        let v = el.dataset[key];
        if(/^https?:\/\//.test(v)) urls.push(v);
      }
    } catch {}
    return urls;
  }

  function createLogUI() {
    toggleBtn = document.createElement('button');
    toggleBtn.textContent = '⭐️';
    toggleBtn.title = 'Iframe 로그 토글';
    Object.assign(toggleBtn.style, {
      position: 'fixed', bottom: '250px', right: '0px',
      width: '25px', height: '25px', borderRadius: '50%',
      border: 'none', background: 'transparent', color: '#fff',
      fontSize: '14px', cursor: 'pointer', zIndex: 2147483647,
      opacity: 0.5 // 반투명하게 설정
    });
    document.body.appendChild(toggleBtn);

    logContainer = document.createElement('div');
    const icon = toggleBtn;  // 로그 아이콘
    const iconHeight = icon.offsetHeight;  // 아이콘의 높이
    const logHeight = 200;  // 로그창의 최대 높이 200px로 설정

    // 아이콘의 위치를 기준으로 로그창의 위치를 계산
    const iconRect = icon.getBoundingClientRect();  // 아이콘 위치 얻기
    const iconTop = iconRect.top;  // 아이콘의 top 위치

    // 로그창이 아이콘을 기준으로 수직으로 균등하게 열리도록 설정
    const logContainerTop = `calc(${iconTop + iconHeight / 2}px - ${logHeight / 2}px)`;  // 아이콘 위치 기준으로 수직 중앙에 맞춤

    Object.assign(logContainer.style, {
      position: 'fixed', right: '20px',
      top: logContainerTop, // 아이콘 기준으로 위치 설정
      width: '500px', height: `${logHeight}px`, background: 'rgba(0,0,0,0.85)',
      color: 'white', fontFamily: 'monospace', fontSize: '13px',
      borderRadius: '10px', boxShadow: '0 0 10px black',
      display: 'none', flexDirection: 'column', overflowY: 'auto',
      zIndex: 2147483647,
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', padding: '6px 10px',
      background: '#000', fontWeight: 'bold', fontSize: '14px'
    });
    const title = document.createElement('span');
    title.textContent = '🛡 Iframe Log View';
    countDisplay = document.createElement('span');
    countDisplay.textContent = '(0)';
    Object.assign(countDisplay.style, { marginLeft: '6px', color: '#ccc', fontSize: '12px' });
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 복사';
    Object.assign(copyBtn.style, {
      fontSize: '12px', background: '#444', color: 'white',
      border: 'none', borderRadius: '5px', padding: '2px 8px', cursor: 'pointer'
    });
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(logList.join('\n'));
      copyBtn.textContent = '복사됨!';
      setTimeout(() => copyBtn.textContent = '📋 복사', 1500);
    };
    const headLeft = document.createElement('div');
    headLeft.append(title, countDisplay);
    header.append(headLeft, copyBtn);

    logContent = document.createElement('div');
    Object.assign(logContent.style, {
      flex: '1', overflowY: 'auto',
      padding: '6px 10px', whiteSpace: 'pre-wrap',
      maxHeight: `${logHeight - header.offsetHeight - 20}px`, // header 제외한 공간에 맞게 설정
    });

    logContainer.append(header, logContent);
    document.body.appendChild(logContainer);

    toggleBtn.onclick = () => {
      logContainer.style.display = logContainer.style.display === 'none' ? 'flex' : 'none'; // 토글 버튼 클릭 시 로그창 보이기/숨기기
    };
  }

  function setCaptchaActive(iframe){
    if(captchaDeactivateTimeout){
      clearTimeout(captchaDeactivateTimeout);
      captchaDeactivateTimeout = null;
    }
    if(!captchaActive) console.log('[Captcha] 캡챡 활성화');
    captchaActive = true;
    if(iframe) captchaIframes.add(iframe);
  }

  function scheduleCaptchaDeactivate(){
    if(captchaDeactivateTimeout) clearTimeout(captchaDeactivateTimeout);
    captchaDeactivateTimeout = setTimeout(() => {
      captchaActive = false;
      captchaIframes.clear();
      console.log('[Captcha] 캡챡 비활성화 완료');
    }, 7000);
  }

  function logIframe(el, reason){
    let urls = extractUrls(el);
    let src = urls[0] || el.src || '[no-src]';
    let outer = el.outerHTML ? el.outerHTML.slice(0, 200).replace(/\s+/g, ' ') : '[no outerHTML]';
    const whitelisted = isWhitelisted(src);

    if(captchaActive && captchaIframes.has(el)) return; // 캡챡 중복 로그 방지

    let info = `[#${++count}] ${reason} ${whitelisted ? '(whitelist) ' : '(blocked) '} ${src}\n └▶️ HTML → ${outer}`;

    if(logContent){
      const div = document.createElement('div');
      div.textContent = info;
      div.style.color = whitelisted ? '#8fbc8f' : '#ff6666'; // 초록 or 빨강
      div.style.padding = '2px 0';
      logContent.appendChild(div);
      if(logContent.children.length > 100) logContent.removeChild(logContent.children[0]);
      countDisplay.textContent = `(${count})`;
      div.scrollIntoView({behavior:'smooth', block:'end'});
    }

    logList.push(info);

    if(!whitelisted && REMOVE_IFRAME){
      el.style.display = 'none';
      el.setAttribute('sandbox', '');
      setTimeout(() => el.remove(), 300);
    }

    if(whitelisted && CAPTCHA_KEYWORDS.some(kw => src.includes(kw))){
      setCaptchaActive(el);
      scheduleCaptchaDeactivate();
    }
  }

  function handle(el, reason){
    logIframe(el, reason);
  }

  function monitor(){
    document.querySelectorAll('iframe,frame,embed,object').forEach(el => handle(el, 'initialScan'));
  }

  // DOM 변경 감시
  new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if(!(n instanceof HTMLElement)) return;
        if(['IFRAME','FRAME','EMBED','OBJECT'].includes(n.tagName)){
          handle(n, 'added');
        }
        if(n.shadowRoot) n.shadowRoot.querySelectorAll('iframe,frame,embed,object').forEach(f => handle(f, 'shadow'));
      });
    });
  }).observe(document, {childList:true, subtree:true});

  // 성공/실패 메시지 제거
  new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if(n.nodeType === 1 && n.innerText && /성공|실패/i.test(n.innerText)){
          n.remove();
        }
      });
    });
  }).observe(document.body, {childList:true, subtree:true});

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', () => {
      createLogUI();
      monitor();
    });
  } else {
    createLogUI();
    monitor();
  }

})();
