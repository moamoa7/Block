// ==UserScript==
// @name         WebRTC Disabler (global, with allowlist)
// @namespace    local.webrtc.disabler
// @version      1.3
// @description  예외 도메인을 제외한 모든 사이트에서 WebRTC(RTCPeerConnection 등) 차단. iframe 우회 방지 포함.
// @license      MIT
// @match        *://*/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://hcaptcha.com/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://www.recaptcha.net/*
// @exclude      *://recaptcha.net/*
// @run-at       document-start
// @grant        unsafeWindow
// @all-frames   true
// ==/UserScript==

(() => {
    "use strict";
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // ── 설정 ───────────────────────────────────────────────
    // 범용 기본 허용: 널리 쓰이는 정식 화상통화/협업 서비스
    const ALLOW = [
        "discord.com",
        "discordapp.com",
        "discord.gg",
        "meet.google.com",
        "zoom.us",
        "whereby.com",
        "teams.microsoft.com",
        // 원격 데스크톱 / 화면 공유 (브라우저로 쓸 때만)
        "remotedesktop.google.com",   // Chrome 원격 데스크톱
        "parsec.app",                 // Parsec (게임 스트리밍/원격)
        "moonlight-stream.org",       // Moonlight (웹 클라이언트 쓸 경우)
        // 화상통화 / 회의
        "meet.jit.si",                // Jitsi Meet
        "8x8.vc",                     // Jitsi(8x8) 호스팅
        "webex.com",                  // Cisco Webex
        "gather.town",                // Gather (가상 사무실, WebRTC)
        "around.co",                  // Around
        // 협업 / 기타
        "miro.com",                   // 일부 실시간 기능
        "figma.com",                  // 음성/화면공유 기능 사용 시
        // 중계
        "speed10-1.com",
    ];

    // 개인용 추가 허용 (각자 필요에 의해 해제할 도메인)
    const ALLOW_PERSONAL = [

    ];

    // true  = 예외 던지기(엄격, 콘솔 에러 발생 가능)
    // false = 조용히 차단(예외 없이 무력화)
    const THROW_ON_BLOCK = false;
    // ───────────────────────────────────────────────────────

    const host = location.hostname;
    const allowList = ALLOW.concat(ALLOW_PERSONAL);
    const allowed = allowList.some(d => host === d || host.endsWith("." + d));

    if (allowed) {
        console.log("[WebRTC] allowed on", host);
        return;
    }

    // 차단 시 호출되는 함수
    function blocked() {
        if (THROW_ON_BLOCK) throw new Error("WebRTC disabled by WebRTC Disabler");
        return undefined;
    }

    // ── RTCPeerConnection 계열 + 관련 생성자 차단 ─────────────
    const PC_KEYS = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"];
    const EXTRA_KEYS = ["RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"];

    function disableOn(target) {
        if (!target) return;
        PC_KEYS.concat(EXTRA_KEYS).forEach(k => {
            try {
                Object.defineProperty(target, k, {
                    configurable: true,
                    get() { return blocked; },
                    set() {}
                });
            } catch (e) {}
        });
    }

    // 현재 창에 적용
    disableOn(win);

    // ── iframe 우회 방지 ─────────────────────────────────────
    // 사이트가 새 iframe의 contentWindow에서 깨끗한 RTCPeerConnection을
    // 꺼내 쓰는 것을 막는다. iframe이 생성될 때마다 그 안에도 차단을 주입.
    function guardIframe(frame) {
        try {
            const cw = frame.contentWindow;
            if (cw) disableOn(cw);
        } catch (e) {}
        try {
            frame.addEventListener("load", () => {
                try { if (frame.contentWindow) disableOn(frame.contentWindow); } catch (e) {}
            });
        } catch (e) {}
    }

    // 이미 존재하는 iframe 처리
    try {
        document.querySelectorAll("iframe").forEach(guardIframe);
    } catch (e) {}

    // 이후 동적으로 추가되는 iframe 감시
    try {
        const mo = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node && node.tagName === "IFRAME") {
                        guardIframe(node);
                    } else if (node && node.querySelectorAll) {
                        node.querySelectorAll("iframe").forEach(guardIframe);
                    }
                }
            }
        });
        const startObserver = () => {
            if (document.documentElement) {
                mo.observe(document.documentElement, { childList: true, subtree: true });
            }
        };
        startObserver();
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startObserver);
        }
    } catch (e) {}

    console.log("[WebRTC] disabled on", host,
        THROW_ON_BLOCK ? "(throw mode)" : "(silent mode)", "(iframe guard)");
})();
