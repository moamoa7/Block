// ==UserScript==
// @name         SBXH 광고 클릭 차단 (오버레이)
// @namespace    violentmonkey.user.script
// @version      1.0
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function(){
  "use strict";
  const f = () => {
    document.querySelectorAll('[data-br="1"] button, [data-bs="1"] button').forEach(e => {
      if (!e.querySelector('.x-cv')) {
        e.style.position = "relative";
        const o = document.createElement("div");
        o.className = "x-cv";
        o.style.cssText = "position:absolute;inset:0;background:rgba(20,24,33,0.04);z-index:10;pointer-events:auto;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:rgba(20,24,33,0.08);letter-spacing:1px;";
        o.textContent = "AdGuard";
        e.appendChild(o);
      }
    });
  };
  new MutationObserver(f).observe(document.documentElement, { childList: true, subtree: true });
  f();
})();
