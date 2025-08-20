// ==UserScript==
// @name        Eruda (최종본 v6) - @resource 방식
// @namespace   My-Eruda-Script-Final
// @match       *://*/*
// @resource    eruda_js https://cdn.jsdelivr.net/npm/eruda/eruda.min.js
// @grant       GM_getResourceText
// @version     6.0
// @author      Me
// @description @resource를 사용해 CSP를 우회하고 안정적으로 Eruda를 로드합니다.
// @run-at      document-start
// @all-frames  true
// ==/UserScript==

(function() {
    'use strict';
    if (window.eruda) return;

    // @resource로 저장된 Eruda 코드를 텍스트로 불러옵니다.
    const erudaCode = GM_getResourceText('eruda_js');

    // 불러온 코드를 현재 페이지에서 실행합니다.
    // new Function()은 eval()보다 약간 더 안전한 실행 방식입니다.
    new Function(erudaCode)();

    // 이제 eruda 객체를 사용할 수 있으므로 초기화합니다.
    eruda.init();
})();
