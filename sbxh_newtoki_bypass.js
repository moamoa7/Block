// ==UserScript==
// @name         SBXH/뉴토끼 광고 무력화 v1.0
// @namespace    violentmonkey.user.script
// @version      1.0
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
  "use strict";
  const css = `
    [data-br="1"],[data-bs="1"],[data-bp="1"],[data-brs]{
      filter:blur(15px) grayscale(100%) brightness(0.3)!important;
      opacity:0.10!important;
      pointer-events:none!important;
    }

    [data-pm-ov],.vw-swipe-hint,[class*="backdrop"],[class*="modal-overlay"]{display:none!important;}
    html,body{overflow:auto!important;position:static!important;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // 팝업 차단 (사용자 클릭 후 500ms만 허용)
  let userGesture = false;
  document.addEventListener('click', e => {
    if (e.isTrusted) { userGesture = true; setTimeout(() => userGesture = false, 500); }
  }, true);
  const origOpen = window.open;
  window.open = function(){ return userGesture ? origOpen.apply(this, arguments) : null; };
})();
