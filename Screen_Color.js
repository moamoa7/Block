// ==UserScript==
// @name         Screen Color Temperature
// @namespace    https://github.com/moamoa7
// @version      1.0.0
// @description  페이지 전체에 색온도 보정을 적용합니다 (기본: -7 쿨톤)
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  if (location.protocol === 'about:' || location.href === 'about:blank') return;
  if (window.__sct_booted) return;
  window.__sct_booted = true;

  /*──────────────────────────────────────────────
    설정
    temp: -50 ~ +50  (음수 = 쿨톤, 양수 = 웜톤)
    기본값: -7
  ──────────────────────────────────────────────*/
  const DEFAULTS = { temp: -7, enabled: true };
  const STORAGE_KEY = 'sct_settings';

  let settings;
  try {
    const saved = GM_getValue(STORAGE_KEY);
    settings = saved ? { ...DEFAULTS, ...JSON.parse(saved) } : { ...DEFAULTS };
  } catch (_) {
    settings = { ...DEFAULTS };
  }

  function save() {
    try { GM_setValue(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  /*──────────────────────────────────────────────
    색온도 → SVG 필터 변환
  ──────────────────────────────────────────────*/
  const CLAMP = (v, min, max) => v < min ? min : v > max ? max : v;

  function tempToRgbGain(temp) {
    const t = CLAMP(temp * 0.02, -1, 1);
    if (Math.abs(t) < 0.001) return { r: 1, g: 1, b: 1 };
    let r = 1 + 0.14 * t;
    let g = 1 - 0.005 * Math.abs(t);
    let b = 1 - 0.14 * t;
    const mx = Math.max(r, g, b);
    return { r: r / mx, g: g / mx, b: b / mx };
  }

  /*──────────────────────────────────────────────
    SVG 필터 삽입 및 적용
  ──────────────────────────────────────────────*/
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FILTER_ID = 'sct-temp-filter';
  let svgEl = null;
  let funcR = null, funcG = null, funcB = null;

  function buildSvg() {
    if (svgEl) return;

    svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('style', 'position:absolute;left:-9999px;width:0;height:0;pointer-events:none;');
    svgEl.setAttribute('aria-hidden', 'true');

    const defs = document.createElementNS(SVG_NS, 'defs');
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', FILTER_ID);
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    const xfer = document.createElementNS(SVG_NS, 'feComponentTransfer');

    funcR = document.createElementNS(SVG_NS, 'feFuncR');
    funcR.setAttribute('type', 'linear'); funcR.setAttribute('slope', '1');
    funcG = document.createElementNS(SVG_NS, 'feFuncG');
    funcG.setAttribute('type', 'linear'); funcG.setAttribute('slope', '1');
    funcB = document.createElementNS(SVG_NS, 'feFuncB');
    funcB.setAttribute('type', 'linear'); funcB.setAttribute('slope', '1');

    xfer.append(funcR, funcG, funcB);
    filter.append(xfer);
    defs.append(filter);
    svgEl.append(defs);
  }

  function ensureSvgInDom() {
    if (!svgEl) buildSvg();
    const target = document.body || document.documentElement;
    if (target && svgEl.parentNode !== target) {
      target.appendChild(svgEl);
    }
  }

  function updateFilter() {
    if (!funcR) return;
    const gain = tempToRgbGain(settings.temp);
    funcR.setAttribute('slope', gain.r.toFixed(6));
    funcG.setAttribute('slope', gain.g.toFixed(6));
    funcB.setAttribute('slope', gain.b.toFixed(6));
  }

  /*──────────────────────────────────────────────
    HTML에 필터 적용/해제
  ──────────────────────────────────────────────*/
  let styleEl = null;

  function applyToPage() {
    if (!settings.enabled || Math.abs(settings.temp) < 0.5) {
      removeFromPage();
      return;
    }

    ensureSvgInDom();
    updateFilter();

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-sct', '1');
      styleEl.textContent = `html { filter: url(#${FILTER_ID}) !important; }`;
    }

    const head = document.head || document.documentElement;
    if (head && styleEl.parentNode !== head) {
      head.appendChild(styleEl);
    }
  }

  function removeFromPage() {
    if (styleEl?.parentNode) styleEl.parentNode.removeChild(styleEl);
  }

  /*──────────────────────────────────────────────
    초기화 및 메뉴 커맨드
  ──────────────────────────────────────────────*/
  function init() {
    buildSvg();
    applyToPage();
  }

  // GM 메뉴
  try {
    GM_registerMenuCommand(`색온도 ON/OFF (현재: ${settings.enabled ? 'ON' : 'OFF'})`, () => {
      settings.enabled = !settings.enabled;
      save();
      applyToPage();
      location.reload();
    });

    GM_registerMenuCommand(`색온도 값 변경 (현재: ${settings.temp})`, () => {
      const input = prompt(`색온도를 입력하세요 (-50 ~ +50)\n음수 = 쿨톤(파란), 양수 = 웜톤(노란)\n현재: ${settings.temp}`, String(settings.temp));
      if (input === null) return;
      const val = parseInt(input, 10);
      if (isNaN(val) || val < -50 || val > 50) {
        alert('범위: -50 ~ +50');
        return;
      }
      settings.temp = val;
      save();
      applyToPage();
    });
  } catch (_) {}

  // 페이지 로드 타이밍에 맞춰 적용
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // body 동적 생성 대응
  const mo = new MutationObserver(() => {
    if (document.body) {
      applyToPage();
      mo.disconnect();
    }
  });
  mo.observe(document.documentElement, { childList: true });
})();
