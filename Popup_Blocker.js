// ==UserScript==
// @name        Pop-Up Block (Weaboo) + Whitelist + AutoClose (강화판, UI 유지)
// @namespace   http://tampermonkey.net/
// @description Popup blocker with whitelist, auto-close UI + extended protection (UI preserved)
// @include     *
// @version     4.3.0-enhanced
// @author      weaboo (mod+enhanced by ChatGPT)
// @license     aanriski™ - ©weaboo
// @grant       none
// @run-at      document-start
// ==/UserScript==

(function() {
    // ---------------------- 화이트리스트 설정 ----------------------
    const WHITELIST = [
        "etoland.co.kr/pages/points.php",
    ];
    function isWhitelisted() {
        const currentURL = location.href.toLowerCase();
        return WHITELIST.some(item => currentURL.includes(item.toLowerCase()));
    }

    if (isWhitelisted()) {
        console.info("[Pop-Up Blocker] Whitelisted site:", location.hostname);
        return;
    }

    // ---------------------- 원래 변수/로직 ----------------------
    var t, e = 2, o = 4, n = 8, s = 16, i = 32, r = 0,
        a = { a: !0, button: { type: "submit" }, input: !0, select: !0, option: !0 },
        l = 0, p = window.open, c = window.showModalDialog, d = null, m = 0;

    function y(t, arguments) {
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

    // ---------------------- window.open 후킹 ----------------------
    const originalOpen = window.open;
    window._popupFlag = false;
    window.open = function() {
        window._popupFlag = true;
        let url = arguments[0];
        try { url = url ? new URL(url, location.href).href : ""; } catch { url = ""; }
        if (!y("Allow popup?", arguments) || !x() && u()) {
            console.error("Pop-Up Blocker blocked window.open", Array.prototype.slice.apply(arguments));
            v("Pop-Up Blocked!", arguments[0], arguments[1], 3000);
            return {};
        }
        return originalOpen.apply(window, arguments);
    };

    // ---------------------- showModalDialog 후킹 ----------------------
    window.showModalDialog = function() {
        var oargs = arguments;
        console.error("Pop-Up Blocker blocked modal showModalDialog", Array.prototype.slice.apply(arguments));
        v("Blocked modal dialog", arguments[0], null, 3000);
        return {};
    };

    // =========================
    // ⬇⬇⬇ 강화 로직 추가 부분 ⬇⬇⬇
    // =========================

    // opener 무효화
    try { Object.defineProperty(window, 'opener', { value: null, writable: false }); } catch {}

    // location.* 차단
    ['assign', 'replace', 'reload'].forEach(fn => {
        const orig = location[fn].bind(location);
        location[fn] = function(...args) {
            console.warn("[Pop-Up Blocker] Blocked location." + fn, args);
            v("Blocked forced navigation");
        };
    });

    // synthetic click 차단
    document.addEventListener('click', e => {
        if (!e.isTrusted) {
            e.stopImmediatePropagation();
            e.preventDefault();
            console.warn("[Pop-Up Blocker] Blocked synthetic click");
            v("Blocked synthetic click");
        }
    }, true);

    // target=_blank 차단
    document.addEventListener('click', e => {
        const link = e.target.closest && e.target.closest('a[target="_blank"]');
        if (link) {
            e.preventDefault();
            console.warn("[Pop-Up Blocker] Blocked target=_blank:", link.href);
            v("Blocked new tab link");
        }
    }, true);

    // setTimeout / setInterval 팝업 차단
    function wrapTimer(orig) {
        return function(fn, delay, ...rest) {
            if (typeof fn === 'function') {
                const wrapped = (...args) => {
                    window._popupFlag = false;
                    fn.apply(this, args);
                    if (window._popupFlag) {
                        console.warn("[Pop-Up Blocker] Blocked popup from timer");
                        v("Blocked popup from timer");
                        window._popupFlag = false;
                    }
                };
                return orig(wrapped, delay, ...rest);
            }
            return orig(fn, delay, ...rest);
        };
    }
    window.setTimeout = wrapTimer(window.setTimeout);
    window.setInterval = wrapTimer(window.setInterval);

    console.info("[Pop-Up Blocker] Enhanced protection active (UI preserved)");
})();
