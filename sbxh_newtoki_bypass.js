// ==UserScript==
// @name         SBXH/뉴토끼 광고·팝업 우회 최종판
// @namespace    violentmonkey.user.script
// @version      4.4
// @description  뉴토끼 (sbxh*.com) 광고 차단 감지/팝업 모달 완벽 우회 — PC+모바일
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /* ============================================================
     * 1. 차단 감지 API 무력화 (fetch)
     * ============================================================ */
    const BLOCK_API = [
        "/api/dev-block",
        "/api/me/block-check",
        "/api/m/ev",
        "/api/block",
        "/api/check",
        "/api/detect",
        "/api/abp"
    ];
    const isBlockApi = (u) =>
        typeof u === "string" && BLOCK_API.some((p) => u.includes(p));

    const fakeOk = () =>
        new Response(
            JSON.stringify({ ok: true, blocked: false, items: [], detected: false }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url =
            typeof input === "string" ? input :
            input instanceof URL ? input.href :
            input?.url || "";
        if (isBlockApi(url)) return Promise.resolve(fakeOk());
        return origFetch.apply(this, arguments);
    };

    /* ============================================================
     * 2. DevTools 감지 + 카운터 토큰 강제 고정 ⭐
     * ============================================================ */
    try {
        Object.defineProperty(window, "__ntkDevtoolsTripped", {
            get: () => false, set: () => {}
        });
    } catch (_) {}
    window.__ntk_ib_ok = 1;
    window.__ntk_ib_loaded = 1;

    // 광고 카운터 토큰(data-ab, data-rb)을 무조건 999로 고정
    const FAKE_COUNT = 999;
    const setupCounters = () => {
        try {
            const html = document.documentElement;
            const ab = html.getAttribute('data-ab');
            const rb = html.getAttribute('data-rb');
            const fix = (key) => {
                if (!key) return;
                try {
                    Object.defineProperty(window, key, {
                        get: () => FAKE_COUNT,
                        set: () => {},
                        configurable: false
                    });
                } catch (_) { window[key] = FAKE_COUNT; }
            };
            fix(ab);
            fix(rb);
            fix('bSeen');
        } catch (_) {}
    };
    if (document.documentElement) setupCounters();

    // debugger 루프 차단
    const origSetInterval = window.setInterval;
    window.setInterval = function (fn, delay, ...rest) {
        try {
            const s = (typeof fn === "function" ? fn.toString() : String(fn));
            if (/debugger|devtools/i.test(s)) return 0;
        } catch (_) {}
        return origSetInterval.call(this, fn, delay, ...rest);
    };

    /* ============================================================
     * 3. Storage / 쿠키 정리
     * ============================================================ */
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
        if (typeof key === "string") {
            if (key.startsWith("ntk_blk_canary_")) return "1";
            if (key === "ntk_blk" || key === "ntk_dev_warn") return null;
        }
        return origGetItem.apply(this, arguments);
    };
    try {
        document.cookie = "ntk_blk=; Path=/; Max-Age=0";
        document.cookie = "ntk_dev_warn=; Path=/; Max-Age=0";
        if (window.indexedDB) indexedDB.deleteDatabase("ntk");
    } catch (_) {}

    /* ============================================================
     * 4. 페이지 동작 정상화
     * ============================================================ */
    window.stop = function () {};
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value) {
        if (name === "overflow" && value === "hidden") return;
        return origSetProp.apply(this, arguments);
    };

    /* ============================================================
     * 5. /init/block.js, /init/fp.js, /init/pid.js + 팝업 모달 차단 ⭐⭐⭐
     * ============================================================ */
    const BLOCK_SCRIPT_RE = /\/init\/(block|fp|pid)\.js|whoas\.xyz/i;
    const BLOCK_IDS = ["init-block", "init-fp", "init-pid"];
    const LEGIT_MODAL_IDS = ["auth-modal", "search-modal"];

    const removeIfPopup = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (LEGIT_MODAL_IDS.includes(el.id)) return;  // 정상 모달은 제외

        try {
            // data-pm-ov 마커
            if (el.hasAttribute && el.hasAttribute('data-pm-ov')) {
                el.remove();
                return;
            }
            // BlockListModal / PopupModal 추정 클래스
            const cls = ((el.className || '') + '').toLowerCase();
            const elId = (el.id || '').toLowerCase();
            if (/block-?list|block-?modal|popup-?modal|popupmodal|blocklistmodal/i.test(cls + ' ' + elId)) {
                el.remove();
            }
        } catch (_) {}
    };

    new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;

                // 5-1. 트래커 스크립트 차단 + 가짜 load 이벤트
                if (node.tagName === "SCRIPT") {
                    const src = node.src || "";
                    const id = node.id || "";
                    if (BLOCK_IDS.includes(id) || BLOCK_SCRIPT_RE.test(src)) {
                        node.type = "javascript/blocked";
                        setTimeout(() => {
                            try {
                                node.dispatchEvent(new Event("load"));
                                if (typeof node.onload === "function")
                                    node.onload(new Event("load"));
                            } catch (_) {}
                        }, 0);
                        continue;
                    }
                }

                // 5-2. 팝업 모달 차단
                removeIfPopup(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll('[data-pm-ov], [class*="block"], [class*="popup"], [class*="Block"], [class*="Popup"]')
                        .forEach(removeIfPopup);
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // script error 이벤트 가로채기 (.catch 트랩 방지)
    window.addEventListener("error", function (e) {
        if (e.target?.tagName === "SCRIPT") {
            const src = e.target.src || "";
            const id = e.target.id || "";
            if (BLOCK_IDS.includes(id) || BLOCK_SCRIPT_RE.test(src)) {
                e.stopImmediatePropagation();
                e.preventDefault();
                return false;
            }
        }
    }, true);

    // script error 리스너 등록 자체 차단
    const origAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (this instanceof HTMLScriptElement && type === "error") {
            const id = this.id || "";
            const src = this.src || "";
            if (BLOCK_IDS.includes(id) || BLOCK_SCRIPT_RE.test(src)) return;
        }
        return origAddEventListener.apply(this, arguments);
    };

    /* ============================================================
     * 6. body 스크롤 락 해제 (팝업이 띄운 overflow:hidden 무력화)
     * ============================================================ */
    const releaseScrollLock = () => {
        try {
            if (document.body) {
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
            }
            document.documentElement.style.overflow = '';
        } catch (_) {}
    };
    const watchScrollLock = () => {
        if (!document.body) {
            requestAnimationFrame(watchScrollLock);
            return;
        }
        new MutationObserver(releaseScrollLock).observe(document.body, {
            attributes: true,
            attributeFilter: ['style', 'class']
        });
    };
    watchScrollLock();

    /* ============================================================
     * 7. 광고 버튼 클릭 차단 (모바일 빈 공백 클릭 방지) ⭐
     * ============================================================ */
    ["click", "mousedown", "touchstart", "pointerdown"].forEach((evt) => {
        document.addEventListener(evt, function (e) {
            const t = e.target?.closest?.('[data-bs="1"], [data-bp="1"], [data-br="1"], [data-pm-ov]');
            if (t) {
                e.stopImmediatePropagation();
                e.preventDefault();
                return false;
            }
        }, true);
    });

})();
