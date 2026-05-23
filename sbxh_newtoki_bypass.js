// ==UserScript==
// @name         SBXH/뉴토끼 광고차단 우회 (정교판) v7.0
// @namespace    violentmonkey.user.script
// @version      7.0
// @description  AdGuard 스크립틀릿을 uBlock+유저스크립트로 포팅
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /* ===== 1. toString 위장 시스템 ===== */
    const fnMap = new WeakMap();
    const origToString = Function.prototype.toString;
    Function.prototype.toString = function () {
        return fnMap.has(this) ? fnMap.get(this) : origToString.apply(this, arguments);
    };
    fnMap.set(Function.prototype.toString, "function toString() { [native code] }");

    const disguise = (fn, name, type = "func") => {
        let str = `function ${name}() { [native code] }`;
        if (type === "get") str = `function get ${name}() { [native code] }`;
        else if (type === "set") str = `function set ${name}() { [native code] }`;
        fnMap.set(fn, str);
        return fn;
    };

    /* ===== 2. Function 생성자 후킹 (debugger 차단) ===== */
    const OrigFunction = window.Function;
    const FakeFunction = function (...args) {
        if (args.length > 0 && typeof args[args.length - 1] === "string"
            && args[args.length - 1].includes("debugger")) {
            return function () {};
        }
        return Reflect.construct(OrigFunction, args, new.target || OrigFunction);
    };
    FakeFunction.prototype = OrigFunction.prototype;
    disguise(FakeFunction, "Function");
    window.Function = FakeFunction;
    Object.defineProperty(Function.prototype, "constructor", {
        value: FakeFunction, configurable: true, writable: true
    });

    /* ===== 3. addEventListener 선택적 차단 ===== */
    const wrapAddEventListener = (target, prop) => {
        const orig = target[prop];
        target[prop] = disguise(function (type, listener, opts) {
            if (typeof listener === "function") {
                const code = origToString.call(listener);
                if (type === "keydown" && (code.includes("F12") || code.includes("Ctrl+Shift"))) return;
                if (type === "contextmenu" && (code.includes("isContentEditable") || code.includes("board"))) return;
                if (type === "dragstart" && code.includes("IMG")) return;
                if (type === "click" && code.includes("auto:formatters")) return;
            }
            return orig.apply(this, arguments);
        }, "addEventListener");
    };
    wrapAddEventListener(Window.prototype, "addEventListener");
    wrapAddEventListener(Document.prototype, "addEventListener");
    wrapAddEventListener(Element.prototype, "addEventListener");

    /* ===== 4. fetch 가로채기 ===== */
    const origFetch = window.fetch;
    window.fetch = disguise(function (input, init) {
        const url = typeof input === "string" ? input
                  : input instanceof URL ? input.href
                  : input && input.url ? input.url : "";
        if (url.includes("/api/dev-block") ||
            url.includes("/api/me/block-check") ||
            url.includes("/api/m/ev") ||
            url.includes("/api/ad/challenge") ||
            url.includes("/api/ad/ack")) {
            return Promise.resolve(new Response(JSON.stringify({
                ok: true, blocked: false, items: [],
                challenge: { scope: "", token: "", canaryUrl: "" }
            }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return origFetch.apply(this, arguments);
    }, "fetch");

    /* ===== 5. Storage 스푸핑 ===== */
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = disguise(function (key) {
        if (typeof key === "string") {
            if (key.startsWith("ntk_blk_canary_")) return "1";
            if (key === "ntk_blk" || key === "ntk_dev_warn") return null;
        }
        return origGetItem.apply(this, arguments);
    }, "getItem");

    /* ===== 6. 광고 요소 크기/스타일 위장 (300x250) ===== */
    const isAdBox = (el) => !!(el && el.closest?.('[data-br="1"], [data-bs="1"], [data-bp="1"]'));

    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = disguise(function () {
        return isAdBox(this)
            ? DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 250 })
            : origRect.apply(this, arguments);
    }, "getBoundingClientRect");

    const origClientRects = HTMLElement.prototype.getClientRects;
    HTMLElement.prototype.getClientRects = disguise(function () {
        return isAdBox(this)
            ? [DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 250 })]
            : origClientRects.apply(this, arguments);
    }, "getClientRects");

    const origComputedStyle = window.getComputedStyle;
    window.getComputedStyle = disguise(function (el, pseudo) {
        const style = origComputedStyle.apply(this, arguments);
        if (isAdBox(el)) {
            return new Proxy(style, {
                get: (target, prop) => {
                    if (prop === "display") return "block";
                    if (prop === "visibility") return "visible";
                    if (prop === "opacity") return "1";
                    return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
                }
            });
        }
        return style;
    }, "getComputedStyle");

    /* ===== 7. 이미지 속성 위장 ===== */
    try {
        const protoImg = HTMLImageElement.prototype;
        const dNW = Object.getOwnPropertyDescriptor(protoImg, "naturalWidth");
        const dNH = Object.getOwnPropertyDescriptor(protoImg, "naturalHeight");
        const dCM = Object.getOwnPropertyDescriptor(protoImg, "complete");
        const dSrc = Object.getOwnPropertyDescriptor(protoImg, "src");

        Object.defineProperty(protoImg, "naturalWidth", {
            get: disguise(function () {
                return isAdBox(this) ? 300 : (dNW && dNW.get ? dNW.get.call(this) : 0);
            }, "naturalWidth", "get"),
            configurable: true
        });
        Object.defineProperty(protoImg, "naturalHeight", {
            get: disguise(function () {
                return isAdBox(this) ? 250 : (dNH && dNH.get ? dNH.get.call(this) : 0);
            }, "naturalHeight", "get"),
            configurable: true
        });
        Object.defineProperty(protoImg, "complete", {
            get: disguise(function () {
                return isAdBox(this) || !(dCM && dCM.get) || dCM.get.call(this);
            }, "complete", "get"),
            configurable: true
        });

        if (dSrc && dSrc.set) {
            const setSrc = disguise(function (value) {
                dSrc.set.call(this, value);
                if (!this.isConnected && typeof value === "string" && value.startsWith("http")) {
                    setTimeout(() => {
                        try {
                            if (typeof this.onload === "function") this.onload({ type: "load" });
                            this.dispatchEvent(new Event("load"));
                        } catch (e) {}
                    }, 50);
                }
            }, "src", "set");
            const getSrc = disguise(dSrc.get, "src", "get");
            Object.defineProperty(protoImg, "src", {
                get: getSrc, set: setSrc, configurable: true
            });
        }
    } catch (e) {}

    /* ===== 8. window.stop 무력화 ===== */
    window.stop = disguise(function () {}, "stop");

    /* ===== 9. overflow:hidden 차단 ===== */
    const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = disguise(function (name, value, priority) {
        if (name === "overflow" && value === "hidden") return;
        return origSetProperty.apply(this, arguments);
    }, "setProperty");

    /* ===== 10. 쿠키/IndexedDB 정리 ===== */
    try {
        document.cookie = "ntk_blk=; Path=/; Max-Age=0; SameSite=Lax; Secure";
        if (window.indexedDB) indexedDB.deleteDatabase("ntk");
    } catch (e) {}

        /* ===== 11. 광고 숨김 + 팝업 차단 (z-index 기반) ===== */
    const adStyle = document.createElement("style");
    adStyle.textContent = `
        [data-br="1"], [data-bs="1"], [data-bp="1"] {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
            position: absolute !important;
            width: 0 !important;
            height: 0 !important;
        }
        [data-pm-ov], [data-pm-ov="1"] {
            display: none !important;
        }
        html, body {
            overflow: auto !important;
            position: static !important;
        }
    `;
    if (document.head) document.head.appendChild(adStyle);
    else new MutationObserver((_, obs) => {
        if (document.head) { document.head.appendChild(adStyle); obs.disconnect(); }
    }).observe(document.documentElement, { childList: true });

    /* ===== 11-2. 팝업 새 창 차단 ===== */
    let userGesture = false;
    document.addEventListener("click", (e) => {
        if (e.isTrusted) {
            userGesture = true;
            setTimeout(() => userGesture = false, 500);
        }
    }, true);
    const origOpen = window.open;
    window.open = disguise(function () {
        if (!userGesture) return null;
        return origOpen.apply(this, arguments);
    }, "open");

    /* ===== 11-3. 큰 fixed 요소 자동 제거 (랜덤 클래스 대응) ===== */
    const isLegitModal = (el) => {
        const id = el.id || "";
        if (id === "auth-modal" || id === "search-modal") return true;
        // 헤더/네비게이션 보호
        if (el.tagName === "HEADER" || el.tagName === "NAV") return true;
        if (el.closest && el.closest("header, nav")) return true;
        return false;
    };

    const killPopup = (el) => {
        if (!el || el.nodeType !== 1 || isLegitModal(el)) return;
        try {
            const s = getComputedStyle(el);
            // fixed/absolute + 높은 z-index + 큰 사이즈 = 팝업
            if ((s.position === "fixed" || s.position === "absolute")
                && parseInt(s.zIndex) >= 100) {
                const rect = el.getBoundingClientRect();
                // 화면의 30% 이상 차지하는 요소
                if (rect.width >= window.innerWidth * 0.3 &&
                    rect.height >= window.innerHeight * 0.3) {
                    el.remove();
                    return true;
                }
            }
        } catch (e) {}
        return false;
    };

    const releaseLock = () => {
        try {
            if (document.body) {
                document.body.style.overflow = "";
                document.body.style.position = "";
                document.body.classList.forEach(c => {
                    if (/modal|lock|no-?scroll|overflow/i.test(c)) {
                        document.body.classList.remove(c);
                    }
                });
            }
            document.documentElement.style.overflow = "";
        } catch (e) {}
    };

    const scanAndKill = () => {
        document.querySelectorAll("div, section, aside, dialog").forEach(killPopup);
        releaseLock();
    };

    const startObs = () => {
        // 새 요소 추가 감시
        new MutationObserver((muts) => {
            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 추가 직후 + 100ms 후 두 번 검사 (CSS 적용 시간 대기)
                    killPopup(node);
                    setTimeout(() => killPopup(node), 100);
                    if (node.querySelectorAll) {
                        node.querySelectorAll("div, section, aside, dialog").forEach(killPopup);
                        setTimeout(() => {
                            node.querySelectorAll("div, section, aside, dialog").forEach(killPopup);
                        }, 100);
                    }
                }
            }
            releaseLock();
        }).observe(document.documentElement, { childList: true, subtree: true });

        // body 속성 변경 감시
        if (document.body) {
            new MutationObserver(releaseLock).observe(document.body, {
                attributes: true, attributeFilter: ["style", "class"]
            });
        }

        // 주기적 스캔 (놓친 팝업 잡기)
        setInterval(scanAndKill, 1000);

        // 초기 스캔
        scanAndKill();
    };

    if (document.body) startObs();
    else document.addEventListener("DOMContentLoaded", startObs);


    /* ===== 12. 차단 감지 플래그 ===== */
    window.__nt_buildIdGuardInstalled = true;
    window.__ntk_ib_ok = 1;
    window.__ntk_ib_loaded = 1;
    Object.defineProperty(window, "__ntkDevtoolsTripped", {
        get: disguise(() => false, "__ntkDevtoolsTripped", "get"),
        set: disguise(() => {}, "__ntkDevtoolsTripped", "set"),
        configurable: true
    });

    /* ===== 13. SPA 우회 (풀 페이지 리로드) ===== */
    document.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (a && a.href && a.href.includes("/")) {
            const path = new URL(a.href, window.location.origin).pathname;
            if (path !== window.location.pathname) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = a.href;
            }
        } else if (a && a.href && !a.target) {
            const u = new URL(a.href, window.location.origin);
            if (u.origin === window.location.origin && u.pathname !== window.location.pathname) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = a.href;
            }
        }
    }, true);

})();
