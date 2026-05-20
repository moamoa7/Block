// ==UserScript==
// @name         sbxh adblock-detector bypass v2
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  if (!/^(sbxh\d+\.com)$/i.test(location.hostname)) return;

  // 1) Element.prototype 의 가시성 관련 getter 를 우회
  //    미끼 요소나 배너 요소에 대해 "보이는 것처럼" 응답
  const isLikelyBait = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      const cls = (el.className && el.className.baseVal !== undefined
        ? el.className.baseVal : el.className) || '';
      const id  = el.id || '';
      const al  = el.getAttribute && el.getAttribute('aria-label') || '';
      const hay = (cls + ' ' + id + ' ' + al).toLowerCase();
      return /ad|ads|adsbox|adsbygoogle|banner|배너|sponsor|광고/.test(hay);
    } catch (_) { return false; }
  };

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

  // getBoundingClientRect 도 우회
  try {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const r = orig.call(this);
      if (isLikelyBait(this) && (r.height === 0 || r.width === 0)) {
        return { x:0, y:0, top:0, left:0, right:300, bottom:50,
                 width:300, height:50, toJSON(){return this;} };
      }
      return r;
    };
  } catch (_) {}

  // getComputedStyle 도 우회 (display/visibility 검사 대응)
  try {
    const origGCS = window.getComputedStyle;
    window.getComputedStyle = function (el, pseudo) {
      const s = origGCS.call(this, el, pseudo);
      if (isLikelyBait(el)) {
        return new Proxy(s, {
          get(target, prop) {
            if (prop === 'display' && target.display === 'none') return 'block';
            if (prop === 'visibility' && target.visibility === 'hidden') return 'visible';
            if (prop === 'opacity' && Number(target.opacity) === 0) return '1';
            return target[prop];
          }
        });
      }
      return s;
    };
  } catch (_) {}

  // 2) BlockCheck stamp 강제 제거 + 응답 변조
  const clearStamp = () => {
    try { document.cookie = 'ntk_blk=; Path=/; Max-Age=0'; } catch (_) {}
    try { localStorage.removeItem('ntk_blk'); } catch (_) {}
    try { localStorage.setItem('ntk_blk_ok', String(Date.now())); } catch (_) {}
    try { indexedDB.deleteDatabase('ntk'); } catch (_) {}
  };
  clearStamp();

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/\/api\/(me\/block-check|adblock|ad-detect|detect)/i.test(url)) {
      return Promise.resolve(new Response(
        JSON.stringify({ blocked: false, ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));
    }
    return origFetch.apply(this, arguments);
  };

  // 3) 차단 오버레이 / 광고차단 모달 DOM 제거 + 팝업 모달 제거
  const RE = /광고\s*차단|adblock|미끼|배너\s*숨김|접근이\s*차단/i;

  // 팝업 "오늘 그만보기" 쿠키 자동 세팅 (1년)
  const hidePopupForever = (modalEl) => {
    try {
      // 모달 내부 이미지 src 에서 popup id 를 추정하거나,
      // 그냥 보이는 모든 팝업에 대해 광범위 쿠키를 발급
      const exp = new Date(Date.now() + 365*864e5).toUTCString();
      // 사이트가 popup id 를 우리에게 노출 안하므로,
      // 가장 확실한 방법: 모달 내부의 img src 끝부분이나 link href 를 키로 사용
      const imgs = modalEl.querySelectorAll('img[src]');
      imgs.forEach(img => {
        const m = img.src.match(/([a-f0-9]{8,}|\d{3,})(?:\.[a-z]+)?(?:\?|$)/i);
        if (m) {
          document.cookie = `newtoki_popup_hide_${m[1]}=1; expires=${exp}; path=/; samesite=lax`;
        }
      });
    } catch (_) {}
  };

  const sweep = () => {
    // 차단/광고차단 오버레이
    document.querySelectorAll('div[id^="ntk_blk"], [data-source*="block"]').forEach(n => n.remove());
    document.querySelectorAll('div[role="dialog"]').forEach(n => {
      if (RE.test(n.textContent || '')) n.remove();
    });

    // PopupModal 제거 (data-pm-* 속성으로 안정 식별)
    document.querySelectorAll('[data-pm-ov="1"]').forEach(n => {
      hidePopupForever(n);
      n.remove();
    });

    // body 스크롤 잠금 해제 (모달이 걸어둔 overflow:hidden 풀기)
    if (document.body && document.body.style.overflow === 'hidden') {
      document.body.style.overflow = '';
    }
  };
  new MutationObserver(sweep).observe(document.documentElement, { childList:true, subtree:true });
  document.addEventListener('DOMContentLoaded', sweep);

  // 4) window.stop 무력화
  try { window.stop = function(){}; } catch (_) {}
})();
