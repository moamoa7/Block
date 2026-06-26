// ==UserScript==
// @name         WebRTC Disabler (global, with allowlist)
// @namespace    local.webrtc.disabler
// @version      1.1
// @description  예외 도메인을 제외한 모든 사이트에서 WebRTC(RTCPeerConnection) 차단
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @all-frames   true
// ==/UserScript==

(() => {
    "use strict";
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // ── 설정 ───────────────────────────────────────────────
    // WebRTC를 허용할 도메인 (정상 화상통화 등) — 여기만 예외
    const ALLOW = [
        "discord.com",
        "discordapp.com",
        "discord.gg",
        "meet.google.com",
        "zoom.us",
        "whereby.com",
        "teams.microsoft.com",
        "speed10-1.com",
    ];

    // true  = 예외 던지기(엄격, 콘솔 에러 발생 가능)
    // false = 조용히 차단(예외 없이 무력화)
    const THROW_ON_BLOCK = false;
    // ───────────────────────────────────────────────────────

    const host = location.hostname;
    const allowed = ALLOW.some(d => host === d || host.endsWith("." + d));

    if (allowed) {
        console.log("[WebRTC] allowed on", host);
        return;
    }

    // 차단 시 호출되는 함수
    // - 엄격 모드: 예외를 던짐
    // - 조용한 모드: 예외 없이 undefined 반환(연결 자체가 생성되지 않음)
    function blocked() {
        if (THROW_ON_BLOCK) throw new Error("WebRTC disabled by WebRTC Disabler");
        return undefined;
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

    console.log("[WebRTC] RTCPeerConnection disabled on", host,
        THROW_ON_BLOCK ? "(throw mode)" : "(silent mode)");
})();
