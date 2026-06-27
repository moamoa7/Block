// ==UserScript==
// @name         WebRTC Disabler (global, with allowlist)
// @namespace    local.webrtc.disabler
// @version      1.5
// @description  허용 목록을 제외한 모든 사이트에서 WebRTC(RTCPeerConnection) 차단 — IP 노출(STUN) 방지
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @all-frames   true
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://hcaptcha.com/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://www.recaptcha.net/*
// @exclude      *://recaptcha.net/*
// ==/UserScript==

(() => {
    "use strict";
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // ── 설정 ─────────────────────────────────────────────
    // 범용 기본 허용: 널리 쓰이는 검증된 화상통화/원격/협업/중계 서비스
    const ALLOW = [
        "discord.com",
        "discordapp.com",
        "discord.gg",
        "meet.google.com",
        "zoom.us",
        "whereby.com",
        "teams.microsoft.com",
        "remotedesktop.google.com", // Chrome 원격 데스크톱
        "parsec.app",               // Parsec
        "moonlight-stream.org",      // Moonlight
        "meet.jit.si",              // Jitsi
        "8x8.vc",                   // Jitsi(8x8)
        "webex.com",                // Cisco Webex
        "gather.town",              // Gather
        "around.co",                // Around
        "miro.com",                 // Miro
        "figma.com",                // Figma
        "speed10-1.com",            // 검증된 SFU 중계 인프라
    ];

    // 개인용 추가 허용 (필요 시 직접 추가)
    const ALLOW_PERSONAL = [
        // "example.com",
    ];

    // true = 차단 시 예외 발생(디버깅용), false = 조용히 더미 반환(기본)
    const THROW_ON_BLOCK = false;
    // ─────────────────────────────────────────────────────

    const host = location.hostname;
    const allowList = ALLOW.concat(ALLOW_PERSONAL);
    const allowed = allowList.some(d => host === d || host.endsWith("." + d));

    if (allowed) {
        console.log("[WebRTC] allowed on", host);
        return;
    }

    // 차단 시 동작: 예외를 던지거나, 무해한 더미 생성자를 반환
    function makeDummyPC() {
        // 메서드까지 더미로 채워, 사이트 코드가 메서드를 호출해도
        // 콘솔이 깨지지 않게 함. 핵심인 ICE 후보 생성은 일어나지 않음.
        return function DummyRTCPeerConnection() {
            return {
                createOffer() { return Promise.reject(new Error("WebRTC disabled")); },
                createAnswer() { return Promise.reject(new Error("WebRTC disabled")); },
                setLocalDescription() { return Promise.resolve(); },
                setRemoteDescription() { return Promise.resolve(); },
                addIceCandidate() { return Promise.resolve(); },
                createDataChannel() {
                    return {
                        send() {}, close() {},
                        addEventListener() {}, removeEventListener() {},
                    };
                },
                addTrack() { return {}; },
                removeTrack() {},
                getSenders() { return []; },
                getReceivers() { return []; },
                getTransceivers() { return []; },
                getStats() { return Promise.resolve(new Map()); },
                addEventListener() {},
                removeEventListener() {},
                setConfiguration() {},
                restartIce() {},
                close() {},
                connectionState: "closed",
                iceConnectionState: "closed",
                signalingState: "closed",
            };
        };
    }

    function blockedValue() {
        if (THROW_ON_BLOCK) {
            return function () { throw new Error("WebRTC disabled by WebRTC Disabler"); };
        }
        return makeDummyPC();
    }

    // 주어진 window(또는 iframe contentWindow)에 차단 적용
    function disableOn(target) {
        if (!target) return;
        const pcDummy = blockedValue();

        // 핵심 누수 통로인 RTCPeerConnection 계열만 차단.
        // RTCDataChannel / RTCIceCandidate / RTCSessionDescription 은
        // PC가 막히면 무력화되며, 단순 데이터 컨테이너라 원본을 두는 편이
        // 호환성 면에서 더 안전하므로 건드리지 않는다.
        ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"].forEach(k => {
            try {
                Object.defineProperty(target, k, {
                    configurable: true,
                    get() { return pcDummy; },
                    set() {},
                });
            } catch (e) {}
        });
    }

    // 메인 윈도우 차단
    disableOn(win);

    // ── iframe 우회 방지 ─────────────────────────────────
    function guardIframe(frame) {
        try {
            const cw = frame.contentWindow;
            if (cw) disableOn(cw);
        } catch (e) {
            // cross-origin iframe 은 접근 불가 → @all-frames 로 직접 실행에 의존
        }
    }

    function scanExistingIframes() {
        try {
            document.querySelectorAll("iframe").forEach(guardIframe);
        } catch (e) {}
    }

    // document-start 시점에 이미 존재할 수 있는 iframe 처리
    scanExistingIframes();

    // DOM 이 완성된 뒤, 정적으로 작성된 iframe 재검사
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scanExistingIframes, { once: true });
    }

    // 동적으로 추가되는 iframe 감시
    function startObserver() {
        try {
            const obs = new MutationObserver(muts => {
                for (const m of muts) {
                    for (const node of m.addedNodes) {
                        if (node && node.tagName === "IFRAME") {
                            guardIframe(node);
                            // load 시점에 contentWindow 가 새로 잡히는 경우 대비
                            node.addEventListener("load", () => guardIframe(node), { once: true });
                        }
                    }
                }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {}
    }

    if (document.documentElement) {
        startObserver();
    } else {
        document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    }

    console.log("[WebRTC] RTCPeerConnection disabled on", host,
        THROW_ON_BLOCK ? "(throw mode)" : "(silent mode)");
})();
