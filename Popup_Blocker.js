// ==UserScript==
// @name        Pop-Up Block (Weaboo) + Whitelist + AutoClose (블랙리스트 제거 버전)
// @namespace   http://tampermonkey.net/
// @description Simple popup window blocker with domain whitelist and auto-close notice (블랙리스트 제거됨)
// @include     *
// @version     4.2.1-no-blacklist
// @author      weaboo (mod by ChatGPT)
// @license     aanriski™ - ©weaboo
// @grant       none
// @run-at      document-start
// ==/UserScript==

(function() {
    // ---------------------- 화이트리스트 설정 ----------------------
    const WHITELIST = [
        "example.com",
        "google.com",
        "youtube.com"
    ];
    function isWhitelisted() {
        return WHITELIST.some(domain => location.hostname.toLowerCase().includes(domain));
    }

    // 블랙리스트 관련 코드 모두 제거됨

    // 화이트리스트면 차단 기능 비활성화
    if (isWhitelisted()) {
        console.info("[Pop-Up Blocker] Whitelisted site:", location.hostname);
        return;
    }

    // 블랙리스트가 없으므로 FORCE_BLOCK 관련 변수 제거

    var t, e = 2, o = 4, n = 8, s = 16, i = 32, r = 0,
        a = { a: !0, button: { type: "submit" }, input: !0, select: !0, option: !0 },
        l = 0, p = window.open, c = window.showModalDialog, d = null, m = 0;

    function y(t, arguments) {
        // FORCE_BLOCK 관련 체크 제거
        return !!(r & e) && function(t, e) {
            return confirm(t + " (" + Array.prototype.slice.apply(arguments).join(", ") + ")")
        }(t, arguments)
    }
    function u() { return !(r & o) || Date.now() > l + 100 }
    function x() { return !!(r & n) && "https:" == location.protocol }
    function w(t) {
        var e = t.tagName && a[t.tagName.toLowerCase()];
        if (e && "object" == typeof e)
            for (var o in e) if (t[o] != t[o]) return !1;
        return e
    }
    function T(e) {
        var o = e.target;
        if (!(e instanceof MouseEvent && (null != e.button ? 0 != e.button : 1 != e.which))) {
            for (; o.parentElement && !w(o);) o = o.parentElement;
            t = o
        }
    }
    function f(t) { return String(t).replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, "\\$1").replace(/\x08/g, "\\x08") }
    window.addEventListener("mousedown", function(t) { l = Date.now(), T(t) }, !0);
    window.addEventListener("click", function(t) { l = Date.now(), T(t) }, !0);
    window.addEventListener("change", function(t) { l = Date.now(), T(t) }, !0);

    var g = new RegExp("^((" + f(location.protocol) + "//" + f(location.host) + ")?(" + f(location.pathname) + ")?)?");

    function h(t) {
        var e = t.replace(g, ""),
            o = (e = e.replace(/#.*$/, "")).match(/\?[^?]+/);
        return o && (o = "?" + o[0].substr(1).split("&").sort().join("&")), e = e.replace(/\?[^?]+/, o || "")
    }

    var b = window.onbeforeunload;

    function v(t, e, o, n, s, i) {
        var r = document.body.parentElement,
            a = document.createElement("div");
        a.onclick = function() { return !1 };
        null === d && (d = parseFloat((r.currentStyle || window.getComputedStyle(r)).marginTop));
        k(a);
        a.style.cssText += "background: InfoBackground !important;border-bottom: 1px solid WindowFrame !important;box-sizing: border-box !important;font: small-caption !important;padding: .5em 1em !important;position: fixed !important;left: 0 !important;right: 0 !important;top: -100% !important;transition: top .25s !important;display: flex !important;align-items: center !important;justify-content: space-between !important;white-space: nowrap !important;z-index: 2147483647 !important;border-radius: 8px !important";
        var l = document.createElement("span");
        function pClose(ev) {
            if (ev) ev.stopPropagation();
            --m || (r.style.cssText += "margin-top: " + d + " !important");
            a.style.cssText += "top: -" + a.offsetHeight + "px !important";
            setTimeout(function() { document.body.removeChild(a) }, 250);
            return !1;
        }
        k(l);
        l.style.cssText += "cursor: pointer !important;display: inline-block !important;font: inherit !important;margin-left: .75em !important;line-height: 2.1 !important";
        l.appendChild(document.createTextNode("╳"));
        l.onclick = pClose;
        a.appendChild(l);
        a.appendChild(document.createTextNode(" ⛔ " + t));
        m || (r.style.cssText += "transition: margin-top .25s !important");
        document.body.appendChild(a);
        a.style.cssText += "top: -" + a.offsetHeight + "px !important";
        setTimeout(function() {
            a.style.cssText += "top: 0 !important";
            m || (r.style.cssText += "margin-top: " + (d + a.offsetHeight) + "px !important");
            m++;
        }, 0);
        if (!n) n = 3000;
        setTimeout(function() { pClose() }, n);
    }

    function k(t) {
        "button" != t.tagName.toLowerCase() ?
            (t.style.cssText = "background: transparent !important;border: none !important;border-radius: 0 !important",
             "a" == t.tagName.toLowerCase() && (t.style.cssText += "cursor: pointer !important")) :
            t.style.cssText += "cursor: auto !important";
        t.style.cssText += "bottom: auto !important;box-shadow: none !important;color: WindowText !important;font: medium serif !important;letter-spacing: 0 !important;line-height: normal !important;margin: 0 !important;opacity: 1 !important;outline: none !important;padding: 0 !important;position: static !important;text-align: left !important;text-shadow: none !important;text-transform: none !important;left: auto !important;right: auto !important;top: auto !important;white-space: normal !important;width: auto !important"
    }

    // onbeforeunload 확인 부분 (FORCE_BLOCK 관련 코드 제거)
    r & i && (window.onbeforeunload = function(t) {
        return x() ? typeof b === "function" ? b.apply(window, arguments) : void 0 : (
            console.warn("You are possibly involuntarily being redirected to another page."),
            (t || window.event).returnValue = "You are possibly involuntarily being redirected to another page. Do you want to leave " + location.href + " or stay?",
            (t || window.event).returnValue
        )
    });

    // 원본 window.open 저장
    const originalOpen = window.open;

    window.open = function() {
        let url = arguments[0];
        try {
            url = url ? new URL(url, location.href).href : "";
        } catch {
            url = "";
        }

        // 블랙리스트 검사 부분 제거

        var tArgs = arguments;
        return !y("Allow popup?", arguments) || !x() && u() ? (
            console.error("Pop-Up Blocker blocked window.open", Array.prototype.slice.apply(arguments)),
            v("Pop-Up Blocked!", arguments[0], arguments[1], 3000, function() {
                console.info("Pop-Up Blocker user clicked window.open", Array.prototype.slice.apply(tArgs));
                originalOpen.apply(window, tArgs);
            }), {}
        ) : (
            console.info("Pop-Up Blocker allowed window.open", Array.prototype.slice.apply(arguments)),
            originalOpen.apply(window, arguments)
        );
    };

    window.showModalDialog = function() {
        // 블랙리스트 차단 관련 제거

        var oargs = arguments;
        return !y("Allow modal dialog?", arguments) || !x() && u() ? (
            console.error("Pop-Up Blocker blocked modal showModalDialog", Array.prototype.slice.apply(arguments)),
            v("Blocked modal dialog", arguments[0], null, 3000, function() {
                console.info("Pop-Up Blocker user clicked window.showModalDialog", Array.prototype.slice.apply(oargs));
                c.apply(window, oargs);
            }), {}
        ) : (
            console.info("Pop-Up Blocker allowed window.showModalDialog", Array.prototype.slice.apply(arguments)),
            c.apply(window, arguments)
        );
    }
})();
