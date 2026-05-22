// ==UserScript==
// @name         sbxh / newtoki ad hide + popup kill
// @namespace    https://sbxh1.com/
// @version      1.1
// @description  광고차단 감지 우회 + 광고 시각적 숨김 + 차단 팝업 제거
// @match        *://*.sbxh1.com/*
// @match        *://sbxh1.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  if (!/^(.*\.)?sbxh\d+\.com$/i.test(location.hostname)) return;
  if (window.self !== window.top) return;

  // ───────────────────────────────────────────────
  // 1. 광고 숨김 CSS + 팝업/오버레이 숨김 CSS 주입
  // ───────────────────────────────────────────────
  const css = `
    /* 광고 배너 컨테이너 압축 (DOM은 유지하여 감지 통과) */
    [data-br="1"] {
      max-height: 0 !important;
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    /* 광고 이미지 시각적 차단 (computed style은 정상값 유지) */
    [data-bs="1"] img,
    [data-bp="1"],
    img[src*="i.toonflix.app/board_uploads/"] {
      clip-path: inset(100%) !important;
    }
    /* 광고차단 감지 팝업/오버레이 숨김 */
    [data-pm-ov="1"],
    [data-ab-popup],
    [data-adblock-popup],
    [data-adblock-modal],
    [class*="adblock-modal"],
    [class*="AdBlockModal"],
    [id*="adblock-popup"],
    [id*="adblockModal"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
    /* 팝업이 body 스크롤을 잠그는 경우 해제 */
    html, body {
      overflow: auto !important;
      position: static !important;
    }
  `;

  const inject = () => {
    if (document.getElementById('__sbxh_hide')) return;
    const style = document.createElement('style');
    style.id = '__sbxh_hide';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  inject();
  new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });

  // ───────────────────────────────────────────────
  // 2. 팝업 노드 자동 제거 + body 스크롤 잠금 해제
  // ───────────────────────────────────────────────
  const POPUP_SELECTORS = [
    '[data-pm-ov="1"]',
    '[data-ab-popup]',
    '[data-adblock-popup]',
    '[data-adblock-modal]',
    '[class*="adblock-modal"]',
    '[class*="AdBlockModal"]',
    '[id*="adblock-popup"]',
    '[id*="adblockModal"]'
  ].join(',');

  const killPopups = () => {
    try {
      document.querySelectorAll(POPUP_SELECTORS).forEach(el => el.remove());
      // body/html이 스크롤 잠금 상태면 풀기
      const root = document.documentElement;
      const body = document.body;
      if (body) {
        if (body.style.overflow === 'hidden') body.style.overflow = '';
        if (body.style.position === 'fixed') body.style.position = '';
        body.classList.remove('no-scroll', 'modal-open', 'scroll-lock', 'overflow-hidden');
      }
      if (root) {
        if (root.style.overflow === 'hidden') root.style.overflow = '';
        root.classList.remove('no-scroll', 'modal-open', 'scroll-lock', 'overflow-hidden');
      }
    } catch (e) {}
  };

  // DOM 변화 감시 → 팝업이 추가되는 즉시 제거
  new MutationObserver(killPopups).observe(document.documentElement, { childList: true, subtree: true });

  // 보험용 주기적 정리 (감시가 놓치는 경우 대비)
  setInterval(killPopups, 500);

  // ───────────────────────────────────────────────
  // 3. 차단 표시 쿠키/스토리지 제거
  // ───────────────────────────────────────────────
  const clearBlockMarks = () => {
    try {
      // 쿠키
      document.cookie.split(';').forEach(c => {
        const name = c.split('=')[0].trim();
        if (/block|adblock|ntk_blk|ab_/i.test(name)) {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
      });
      // localStorage / sessionStorage
      ['localStorage', 'sessionStorage'].forEach(s => {
        const store = window[s];
        if (!store) return;
        Object.keys(store).forEach(k => {
          if (/block|adblock|ntk_blk|ab_/i.test(k)) store.removeItem(k);
        });
      });
    } catch (e) {}
  };
  clearBlockMarks();
  document.addEventListener('DOMContentLoaded', clearBlockMarks);
})();
