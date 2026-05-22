// ==UserScript==
// @name         sbxh / newtoki full bypass
// @namespace    https://sbxh1.com/
// @version      1.2
// @description  광고차단 감지 우회 + 광고 숨김 + 팝업 제거 (AdGuard 룰 통합)
// @match        *://*.sbxh1.com/*
// @match        *://sbxh1.com/*
// @match        *://*.sbxh2.com/*
// @match        *://sbxh2.com/*
// @match        *://*.sbxh3.com/*
// @match        *://sbxh3.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  if (!/^(.*\.)?sbxh\d+\.com$/i.test(location.hostname)) return;
  if (window.self !== window.top) return;

  // ─── 1. fetch 인터셉트: block-check API 가짜 응답 ───
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input
              : input instanceof URL ? input.href
              : input && input.url ? input.url : '';
    if (url.includes('/api/dev-block') || url.includes('/api/me/block-check')) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, blocked: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
    }
    return origFetch.apply(this, arguments);
  };

  // ─── 2. getAttribute spoof: 광고 카운터 무력화 ───
  const origGetAttr = Element.prototype.getAttribute;
  Element.prototype.getAttribute = function (name) {
    if (name === 'data-ab' || name === 'data-br-n') return '0';
    return origGetAttr.apply(this, arguments);
  };

  // ─── 3. getBoundingClientRect spoof: 광고 요소는 정상 크기로 응답 ───
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute && (this.hasAttribute('data-bs') || this.hasAttribute('data-bp') || this.hasAttribute('data-br'))) {
      return { top: 0, left: 0, width: 300, height: 250, bottom: 250, right: 300, x: 0, y: 0, toJSON: () => {} };
    }
    return origRect.apply(this, arguments);
  };

  // ─── 4. getComputedStyle spoof: display/visibility/opacity 정상값 ───
  const origCS = window.getComputedStyle;
  window.getComputedStyle = function (el, pseudo) {
    const cs = origCS.apply(this, arguments);
    if (el && el.hasAttribute && (el.hasAttribute('data-bs') || el.hasAttribute('data-bp') || el.hasAttribute('data-br'))) {
      return new Proxy(cs, {
        get: (t, p) => p === 'display' ? 'block'
                     : p === 'visibility' ? 'visible'
                     : p === 'opacity' ? '1'
                     : t[p]
      });
    }
    return cs;
  };

  // ─── 5. window.stop 무력화 ───
  window.stop = function () {};

  // ─── 6. overflow:hidden 차단 (스크롤 잠금 방지) ───
  const origSetProp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (prop, val, prio) {
    if (prop === 'overflow' && val === 'hidden') return;
    return origSetProp.apply(this, arguments);
  };

  // ─── 7. 차단 표시 쿠키/스토리지 제거 + 저장 차단 ───
  try {
    document.cookie = 'ntk_blk=; Path=/; Max-Age=0; SameSite=Lax; Secure';
    localStorage.removeItem('ntk_blk');
    localStorage.removeItem('ntk_dev_warn');
  } catch (e) {}
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, val) {
    if (key.startsWith('ntk_blk') || key.startsWith('ntk_dev_warn')) return;
    return origSetItem.apply(this, arguments);
  };

  // ─── 8. Number.isFinite 무력화 (DevTools 감지 우회) ───
  try { Number.isFinite = function () { return false; }; } catch (e) {}

  // ─── 9. CSS 주입: 광고 숨김 + 팝업 숨김 ───
  const css = `
    [data-br="1"] {
      max-height: 0 !important;
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    [data-bs="1"] img,
    [data-bp="1"],
    img[src*="i.toonflix.app/board_uploads/"] {
      clip-path: inset(100%) !important;
    }
    [data-pm-ov="1"],
    [aria-label*="배너"] {
      display: none !important;
    }
    html, body {
      overflow: auto !important;
      position: static !important;
    }
  `;
  const inject = () => {
    if (document.getElementById('__sbxh_hide')) return;
    const s = document.createElement('style');
    s.id = '__sbxh_hide';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  inject();
  new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });
})();
