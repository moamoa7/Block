// ==UserScript==
// @name         SBXH JS 트랩 우회 (슬림판)
// @namespace    violentmonkey.user.script
// @version      4.1
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /* ---------- 1. 광고 차단 감지 API 무력화 ---------- */
    const BLOCK_API = [
        "/api/dev-block",
        "/api/me/block-check",
        "/api/m/ev"
    ];
    const isBlockApi = (u) =>
        typeof u === "string" && BLOCK_API.some((p) => u.includes(p));

    const fakeOk = () =>
        new Response(JSON.stringify({ ok: true, blocked: false, items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url =
            typeof input === "string" ? input :
            input instanceof URL ? input.href :
            input?.url || "";
        if (isBlockApi(url)) return Promise.resolve(fakeOk());
        return origFetch.apply(this, arguments);
    };

    /* ---------- 2. DevTools 감지 트랩 무력화 ---------- */
    try {
        Object.defineProperty(window, "__ntkDevtoolsTripped", {
            get: () => false,
            set: () => {}
        });
    } catch (_) {}
    window.__ntk_ib_ok = 1;
    window.__ntk_ib_loaded = 1;

    // debugger 루프 차단
    const origSetInterval = window.setInterval;
    window.setInterval = function (fn, delay, ...rest) {
        try {
            const s = (typeof fn === "function" ? fn.toString() : String(fn));
            if (/debugger|devtools/i.test(s)) return 0;
        } catch (_) {}
        return origSetInterval.call(this, fn, delay, ...rest);
    };

    /* ---------- 3. Storage 미끼 응답 ---------- */
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
        if (typeof key === "string") {
            if (key.startsWith("ntk_blk_canary_")) return "1";
            if (key === "ntk_blk" || key === "ntk_dev_warn") return null;
        }
        return origGetItem.apply(this, arguments);
    };

    /* ---------- 4. 쿠키/IndexedDB 청소 ---------- */
    try {
        document.cookie = "ntk_blk=; Path=/; Max-Age=0; SameSite=Lax; Secure";
        document.cookie = "ntk_dev_warn=; Path=/; Max-Age=0; SameSite=Lax; Secure";
        if (window.indexedDB) indexedDB.deleteDatabase("ntk");
    } catch (_) {}

    /* ---------- 5. 페이지 동작 정상화 ---------- */
    // window.stop() 호출로 페이지 강제 중단되는 것 방지
    window.stop = function () {};

    // overflow:hidden 으로 스크롤 잠그는 것 방지
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value) {
        if (name === "overflow" && value === "hidden") return;
        return origSetProp.apply(this, arguments);
    };
})();
