// ==UserScript==
// @name         SBXH/뉴토끼 광고 차단 (슬림판)
// @namespace    violentmonkey.user.script
// @version      6.0
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /* CSS: 광고 흐리게 + 클릭 차단 + 팝업 오버레이 숨김 + 스크롤 잠금 해제 */
    const css = `
        [data-br="1"], [data-bs="1"], [data-bp="1"], [data-brs] {
            filter: blur(15px) grayscale(100%) brightness(0.3) !important;
            opacity: 0.10 !important;
            pointer-events: none !important;
        }
        [data-pm-ov],
        [class*="backdrop"], [class*="Backdrop"],
        [class*="modal-overlay"], [class*="ModalOverlay"] {
            display: none !important;
        }
        html, body {
            overflow: auto !important;
            position: static !important;
        }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    /* 팝업 새 창 차단 (사용자 직접 클릭만 허용) */
    let userGesture = false;
    document.addEventListener('click', (e) => {
        if (e.isTrusted) {
            userGesture = true;
            setTimeout(() => userGesture = false, 500);
        }
    }, true);

    const origOpen = window.open;
    window.open = function () {
        if (!userGesture) return null;
        return origOpen.apply(this, arguments);
    };
})();
