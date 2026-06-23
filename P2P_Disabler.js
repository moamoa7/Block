// ==UserScript==
// @name         P2P Disabler (WebRTC kill, global)
// @namespace    local.p2p.disabler
// @version      1.0
// @description  모든 사이트 WebRTC(P2P) 차단 + 예외 도메인만 허용
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @downloadURL https://update.greasyfork.org/scripts/584108/P2P%20Disabler%20%28WebRTC%20kill%2C%20global%29.user.js
// @updateURL https://update.greasyfork.org/scripts/584108/P2P%20Disabler%20%28WebRTC%20kill%2C%20global%29.meta.js
// ==/UserScript==

(() => {
    "use strict";
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // WebRTC를 허용할 도메인 (정상 화상통화 등) — 여기만 예외
    const ALLOW = [
        "discord.com",
        "discordapp.com",
        "discord.gg",
        "meet.google.com",
        "zoom.us",
        "whereby.com",
        "teams.microsoft.com",
    ];

    const host = location.hostname;
    const allowed = ALLOW.some(d => host === d || host.endsWith("." + d));

    if (allowed) {
        console.log("[P2P] WebRTC allowed on", host);
        return;
    }

    function blocked() {
        throw new Error("WebRTC disabled by P2P Disabler");
    }

    ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"].forEach(k => {
        try {
            Object.defineProperty(win, k, {
                configurable: true,
                get() { return blocked; },
                set() {}
            });
        } catch (e) {}
    });

    console.log("[P2P] RTCPeerConnection disabled on", host);
})();
