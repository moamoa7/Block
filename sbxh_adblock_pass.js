// ==UserScript==
// @name         sbxh / newtoki anti-adblock & popup bypass
// @namespace    https://sbxh1.com/
// @version      3.0
// @description  광고차단 감지 우회 + 팝업 자동 닫기 + 차단 stamp 자동 정리
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  if (!/^(sbxh\d+\.com)$/i.test(location.hostname)) return;

  // ─────────────────────────────────────────────────────────────
  // 1) 미끼 / 배너 요소 식별
  //    - 사이트가 명시적으로 단 data-* 속성을 1순위로 사용 (정확)
  //    - 휴리스틱은 속성 안 단 요소 대비 fallback
  // ─────────────────────────────────────────────────────────────
  const isLikelyBait = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.hasAttribute('data-adblock-bait')) return true;
      if (el.hasAttribute('data-adblock-root')) return true;
      if (el.getAttribute('data-br') === '1') return true;
      const cls = (el.className && el.className.baseVal !== undefined
        ? el.className.baseVal : el.className) || '';
      const id  = el.id || '';
      const al  = (el.getAttribute && el.getAttribute('aria-label')) || '';
      const hay = (cls + ' ' + id + ' ' + al).toLowerCase();
      return /ad|ads|adsbox|adsbygoogle|banner|배너|sponsor|광고/.test(hay);
    } catch (_) { return false; }
  };

  // ─────────────────────────────────────────────────────────────
  // 2) 가시성 관련 getter 패치 — "보이는 척" 응답
  // ─────────────────────────────────────────────────────────────
  const patch = (proto, prop, fakeValue) => {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.get) return;
    const orig = desc.get;
    Object.defineProperty(proto, prop, {
      configurable: true,
      get: function () {
        try {
          if (isLikelyBait(this)) {
            const v = orig.call(this);
            return (v === 0 || v == null) ? fakeValue : v;
          }
        } catch (_) {}
        return orig.call(this);
      }
    });
  };

  try { patch(HTMLElement.prototype, 'offsetHeight', 50); } catch (_) {}
  try { patch(HTMLElement.prototype, 'offsetWidth',  300); } catch (_) {}
  try { patch(HTMLElement.prototype, 'clientHeight', 50); } catch (_) {}
  try { patch(HTMLElement.prototype, 'clientWidth',  300); } catch (_) {}

  try {
    const od = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    if (od && od.get) {
      const orig = od.get;
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get: function () {
          if (isLikelyBait(this)) {
            const v = orig.call(this);
            return v || document.body;
          }
          return orig.call(this);
        }
      });
    }
  } catch (_) {}

  try {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const r = orig.call(this);
      if (isLikelyBait(this) && (r.height === 0 || r.width === 0)) {
        return { x:0, y:0, top:0, left:0, right:300, bottom:50,
                 width:300, height:50, toJSON(){ return this; } };
      }
      return r;
    };
  } catch (_) {}

  try {
    const origGCS = window.getComputedStyle;
    window.getComputedStyle = function (el, pseudo) {
      const s = origGCS.call(this, el, pseudo);
      if (isLikelyBait(el)) {
        return new Proxy(s, {
          get(target, prop) {
            if (prop === 'display'    && target.display    === 'none')   return 'block';
            if (prop === 'visibility' && target.visibility === 'hidden') return 'visible';
            if (prop === 'opacity'    && Number(target.opacity) === 0)   return '1';
            return target[prop];
          }
        });
      }
      return s;
    };
  } catch (_) {}

  // ─────────────────────────────────────────────────────────────
  // 3) 차단 stamp 강제 제거 (기존 24h 차단 자동 해제)
  // ─────────────────────────────────────────────────────────────
  const clearStamp = () => {
    try { document.cookie = 'ntk_blk=; Path=/; Max-Age=0'; } catch (_) {}
    try { localStorage.removeItem('ntk_blk'); } catch (_) {}
    try { localStorage.setItem('ntk_blk_ok', String(Date.now())); } catch (_) {}
    try { indexedDB.deleteDatabase('ntk'); } catch (_) {}
  };
  clearStamp();

  // ─────────────────────────────────────────────────────────────
  // 4) 서버 보고 API 무력화
  //    - block-check : 영구차단 stamp 발급 방지
  //    - dev-block   : F12 실수로 인한 영구차단 방지
  //    - adblock / detect 류 : 광고차단 보고 차단
  // ─────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href
      : (input && input.url) || '';
    if (/\/api\/(me\/block-check|adblock|ad-detect|detect|dev-block)/i.test(url)) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, blocked: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
    }
    return origFetch.apply(this, arguments);
  };

  // ─────────────────────────────────────────────────────────────
  // 5) 모달 / 팝업 DOM 사후 정리
  // ─────────────────────────────────────────────────────────────
  const RE = /광고\s*차단|adblock|미끼|배너\s*숨김|접근이\s*차단/i;

  const hidePopupForever = (modalEl) => {
    try {
      const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
      modalEl.querySelectorAll('img[src]').forEach(img => {
        const m = img.src.match(/([a-f0-9]{8,}|\d{3,})(?:\.[a-z]+)?(?:\?|$)/i);
        if (m) {
          document.cookie =
            `newtoki_popup_hide_${m[1]}=1; expires=${exp}; path=/; samesite=lax`;
        }
      });
    } catch (_) {}
  };

  const sweep = () => {
    // 차단 / 광고차단 오버레이
    document.querySelectorAll('div[id^="ntk_blk"], [data-source*="block"]')
      .forEach(n => n.remove());
    document.querySelectorAll('div[role="dialog"]').forEach(n => {
      if (RE.test(n.textContent || '')) n.remove();
    });

    // PopupModal — data-pm-* 속성으로 안정 식별
    document.querySelectorAll('[data-pm-ov="1"]').forEach(n => {
      hidePopupForever(n);
      n.remove();
    });

    // body 스크롤 잠금 해제
    if (document.body && document.body.style.overflow === 'hidden') {
      document.body.style.overflow = '';
    }
  };

  new MutationObserver(sweep)
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', sweep);

  // ─────────────────────────────────────────────────────────────
  // 6) window.stop 무력화 (BlockCheck가 페이지 로딩 중단 못하게)
  // ─────────────────────────────────────────────────────────────
  try { window.stop = function () {}; } catch (_) {}
})();
