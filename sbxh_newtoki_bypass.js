// ==UserScript==
// @name         SBXH/뉴토끼 광고·팝업 우회 (v4.5 - React 호환 강화)
// @namespace    violentmonkey.user.script
// @version      4.5
// @include      /^https?:\/\/([^/]+\.)?sbxh\d+\.com\//
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /* ---------- 1. 차단 감지 API 무력화 ---------- */
    const BLOCK_API = ["/api/dev-block", "/api/me/block-check", "/api/m/ev"];
    const isBlockApi = (u) => typeof u === "string" && BLOCK_API.some(p => u.includes(p));
    const fakeOk = () => new Response(
        JSON.stringify({ ok: true, blocked: false, items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const origFetch = window.fetch;
    window.fetch = function (input) {
        const url = typeof input === "string" ? input :
                    input instanceof URL ? input.href : input?.url || "";
        if (isBlockApi(url)) return Promise.resolve(fakeOk());
        return origFetch.apply(this, arguments);
    };

    /* ---------- 2. DevTools / 카운터 토큰 ---------- */
    try {
        Object.defineProperty(window, "__ntkDevtoolsTripped", {
            get: () => false, set: () => {}
        });
    } catch (_) {}
    window.__ntk_ib_ok = 1;
    window.__ntk_ib_loaded = 1;

    const FAKE_COUNT = 999;
    if (document.documentElement) {
        try {
            const html = document.documentElement;
            const ab = html.getAttribute('data-ab');
            const rb = html.getAttribute('data-rb');
            const fix = (key) => {
                if (!key) return;
                try {
                    Object.defineProperty(window, key, {
                        get: () => FAKE_COUNT, set: () => {}, configurable: false
                    });
                } catch (_) { window[key] = FAKE_COUNT; }
            };
            fix(ab); fix(rb); fix('bSeen');
        } catch (_) {}
    }

    /* ---------- 3. Storage ---------- */
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
        if (typeof key === "string") {
            if (key.startsWith("ntk_blk_canary_")) return "1";
            if (key === "ntk_blk" || key === "ntk_dev_warn") return null;
        }
        return origGetItem.apply(this, arguments);
    };

    /* ---------- 4. 광고 박스 "보이는 척" 위장 (차단 감지 통과용) ⭐ ---------- */
    const isAdBox = (e) => !(!e || !e.closest?.('[data-br="1"], [data-bs="1"], [data-bp="1"]'));

    const FAKE_RECT = { 
        top: 0, left: 0, width: 300, height: 250, 
        bottom: 250, right: 300, x: 0, y: 0, 
        toJSON: () => ({}) 
    };

    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
        return isAdBox(this) ? { ...FAKE_RECT } : origGetBoundingClientRect.apply(this, arguments);
    };

    const origGetClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
        return isAdBox(this) ? [{ ...FAKE_RECT }] : origGetClientRects.apply(this, arguments);
    };

    const origGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function (el, pseudo) {
        const style = origGetComputedStyle.apply(this, arguments);
        if (!isAdBox(el)) return style;
        return new Proxy(style, {
            get(target, prop) {
                if (prop === "display") return "block";
                if (prop === "visibility") return "visible";
                if (prop === "opacity") return "1";
                const v = target[prop];
                return typeof v === "function" ? v.bind(target) : v;
            }
        });
    };

    // 이미지 위장
    try {
        const nW = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
        const nH = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
        const cp = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
            get: function () { return isAdBox(this) ? 300 : (nW?.get?.call(this) || 0); },
            configurable: true
        });
        Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
            get: function () { return isAdBox(this) ? 250 : (nH?.get?.call(this) || 0); },
            configurable: true
        });
        Object.defineProperty(HTMLImageElement.prototype, "complete", {
            get: function () { return isAdBox(this) || (cp?.get?.call(this) ?? true); },
            configurable: true
        });
    } catch (_) {}

    /* ---------- 5. 페이지 동작 정상화 ---------- */
    window.stop = function () {};
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value) {
        if (name === "overflow" && value === "hidden") return;
        return origSetProp.apply(this, arguments);
    };

    /* ---------- 6. 쿠키 정리 ---------- */
    try {
        document.cookie = "ntk_blk=; Path=/; Max-Age=0";
        if (window.indexedDB) indexedDB.deleteDatabase("ntk");
    } catch (_) {}

    /* ---------- 7. CSS 강제 숨김 (광고 + 팝업) ---------- */
    const hideCss = `
        [data-br="1"], [data-bs="1"], [data-bp="1"], [data-pm-ov="1"],
        [data-brs] {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
            position: absolute !important;
            width: 0 !important;
            height: 0 !important;
            visibility: hidden !important;
            overflow: hidden !important;
        }
    `;
    const injectStyle = () => {
        if (document.getElementById('__sbxh_hide__')) return;
        const s = document.createElement('style');
        s.id = '__sbxh_hide__';
        s.textContent = hideCss;
        (document.head || document.documentElement).appendChild(s);
    };
    if (document.head) injectStyle();
    else new MutationObserver((_, obs) => {
        if (document.head) { injectStyle(); obs.disconnect(); }
    }).observe(document.documentElement, { childList: true });

    /* ---------- 8. 차단 감지 스크립트 무력화 (React 안전) ---------- */
    const BLOCK_SCRIPT_RE = /\/init\/(block|fp|pid)\.js|whoas\.xyz/i;
    const BLOCK_IDS = ["init-block", "init-fp", "init-pid"];

    new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
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
                    }
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

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

    /* ---------- 9. SPA 네비게이션 → 전체 페이지 이동 강제 ⭐⭐ ---------- */
    // Next.js의 클라이언트 사이드 라우팅 가로채서 일반 페이지 이동으로 변환
    // → React 컴포넌트 재마운트로 인한 removeChild 에러 방지
    document.addEventListener("click", (e) => {
        const a = e.target?.closest?.("a");
        if (!a || !a.href) return;
        
        // 광고 마커 안의 링크는 차단
        if (a.closest('[data-bs="1"], [data-bp="1"], [data-br="1"], [data-pm-ov]')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
        }
        
        // 같은 도메인의 콘텐츠 링크는 전체 페이지 이동으로 강제
        try {
            const url = new URL(a.href, window.location.origin);
            if (url.origin !== window.location.origin) return;  // 외부 링크는 건드리지 않음
            
            const path = url.pathname;
            // 콘텐츠 페이지 패턴
            if (/\/(webtoon|manhwa|novel|comic)\//.test(path) && 
                path !== window.location.pathname) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = a.href;
            }
        } catch (_) {}
    }, true);

    /* ---------- 10. body 스크롤 락 해제 ---------- */
    const releaseScroll = () => {
        try {
            if (document.body) {
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.classList.remove('modal-open', 'no-scroll');
            }
        } catch (_) {}
    };
    const watchScroll = () => {
        if (!document.body) { requestAnimationFrame(watchScroll); return; }
        new MutationObserver(releaseScroll).observe(document.body, {
            attributes: true, attributeFilter: ['style', 'class']
        });
    };
    watchScroll();
})();
