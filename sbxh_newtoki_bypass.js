// ==UserScript==
// @name         SBXH 팝업 차단
// @namespace    violentmonkey.user.script
// @version      1.0
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
  "use strict";
  let userGesture = false;
  document.addEventListener('click', e => {
    if (e.isTrusted) { userGesture = true; setTimeout(() => userGesture = false, 500); }
  }, true);
  const origOpen = window.open;
  window.open = function(){ return userGesture ? origOpen.apply(this, arguments) : null; };
})();
