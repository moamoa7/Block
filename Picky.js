// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/hooray804/Picky
// @version      3.6.0
// @description  Web Element Inspector & Ad Block — Dark UI + Unified Card List + AdGuard/uBlock Export
// @author       hooray804 (modified)
// @license      MPL-2.0
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @homepage     https://github.com/hooray804/Picky
// ==/UserScript==

(function() {
    "use strict";

    const esc = s => String(s).replace(/[&<>'"]/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));

    if (window.self !== window.top) return;

    // ─────────────────────────────────────────────
    // 코어 ID / 클래스 / 상수
    // ─────────────────────────────────────────────
    const TOOL_ID = "picky-tool";
    const ROOT_ID = "picky-root";
    const HL_CLASS = "picky-hl";
    const ISO_BODY = "picky-iso-body";
    const ISO_PATH = "picky-iso-path";
    const SHIELD_ID = "picky-shield";
    const DRAG_THRESHOLD = 14;

    const NO_DRAG_SELECTOR = 'input, button, select, textarea, label, a, ' +
        '#picky-nav-slider, #picky-nav-slider-container, ' +
        '.picky-icon-button, .picky-selector-display, .picky-switch, ' +
        '.picky-slider, [data-no-drag], .picky-modal-content, ' +
        '.picky-ad-suggest-item, .picky-child-list, .picky-cookie-table, ' +
        '.picky-candidate-card, .picky-candidate-list, .picky-card-btn';

    const SUPPORTS_HAS = (() => {
        try { return CSS.supports('selector(:has(*))'); }
        catch(e) { return false; }
    })();

    // ─────────────────────────────────────────────
    // 광고 관련 상수
    // ─────────────────────────────────────────────
    const AD_NETWORK_HOSTS = [
        'doubleclick.net','googlesyndication.com','googleadservices.com','adservice.google',
        'adsystem.com','adnxs.com','adsrvr.org','adsafeprotected.com','moatads.com',
        'taboola.com','outbrain.com','criteo.com','criteo.net','rubiconproject.com',
        'pubmatic.com','openx.net','smartadserver.com','yieldmo.com','indexww.com',
        'mediavine.com','adsensecustomsearchads.com','amazon-adsystem.com','quantserve.com',
        'scorecardresearch.com','dable.io','recopick','exelator','adfit.kakao','ad.doubleclick',
        'fwmrm.net','ad.naver','ads.naver','ad.daum','wcs.naver','2mdn.net',
        'serving-sys.com','tapad.com','bidswitch.net','casalemedia.com','contextweb.com',
        'adform.net','mopub.com','adcolony.com','mediacategory.com','realclick.co.kr'
    ];

    const IAB_AD_SIZES = [
        [728,90],[300,250],[336,280],[160,600],[300,600],[970,250],[970,90],
        [320,50],[320,100],[468,60],[234,60],[250,250],[200,200],[120,600],
        [180,150],[125,125],[88,31],[300,100],[240,400],[580,400]
    ];

    const AD_LINK_PATTERNS = [
        {kw:'doubleclick',       desc:'DoubleClick'},
        {kw:'googlesyndication', desc:'Google Ads'},
        {kw:'googleadservices',  desc:'Google Ad Services'},
        {kw:'/click?',           desc:'클릭 추적'},
        {kw:'/redirect',         desc:'리다이렉트'},
        {kw:'utm_source=ad',     desc:'UTM 광고'},
        {kw:'utm_medium=cpc',    desc:'CPC 캠페인'},
        {kw:'adclick',           desc:'adclick 패턴'},
        {kw:'//ad.',             desc:'ad. 서브도메인'},
        {kw:'//ads.',            desc:'ads. 서브도메인'},
        {kw:'taboola',           desc:'Taboola'},
        {kw:'outbrain',          desc:'Outbrain'},
        {kw:'criteo',            desc:'Criteo'},
        {kw:'/track',            desc:'트래킹'}
    ];

    const AD_PATH_PATTERNS = [
        {kw:'/banner',  desc:'배너 경로'},
        {kw:'/ads/',    desc:'광고 경로'},
        {kw:'/ad/',     desc:'광고 경로'},
        {kw:'/promo',   desc:'프로모션'},
        {kw:'/sponsor', desc:'스폰서'},
        {kw:'adimg',    desc:'광고 이미지'},
        {kw:'banner_',  desc:'banner_ 파일명'},
        {kw:'_ad_',     desc:'광고 키워드'},
        {kw:'-ad-',     desc:'광고 키워드'}
    ];

    // 더미 href 값 (광고 클릭 버튼 시그니처)
    const DUMMY_HREF_VALUES = new Set([
        'javascript:;', 'javascript:void(0)', 'javascript:void(0);',
        'javascript:void 0', 'javascript:', '#', '#!', '#none', 'about:blank'
    ]);

    // ARIA 광고 키워드
    const ARIA_AD_KEYWORDS = [
        '광고', '배너', 'AD', 'ad', 'Ad', 'banner', 'Banner',
        'advertisement', 'sponsor', 'promotion', '프로모션', '스폰서'
    ];

    // 광고 파일 확장자
    const AD_FILE_EXTS = ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg'];

    // 표준 광고 크기 (suggestAds용)
    const STD_AD_SIZES = [[300,250],[728,90],[160,600],[320,50],[300,600],[336,280],[970,250],[468,60]];

    let touchMoved = false;
    let touchStartTarget = null;

    if (document.getElementById(ROOT_ID)) return;

    // ─────────────────────────────────────────────
    // SVG ICONS
    // ─────────────────────────────────────────────
    const ICON_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    const ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94a7.96 7.96 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a8.13 8.13 0 00-1.62-.94l-.36-2.54A.5.5 0 0014 2h-4a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.6 8.48a.5.5 0 00.12.64l2.03 1.58a7.96 7.96 0 000 1.88L2.72 14.16a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54A.5.5 0 0010 22h4a.5.5 0 00.5-.42l.36-2.54a8.13 8.13 0 001.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
    const ICON_MIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>';
    const ICON_MAX = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h18v2H3V3zm0 16h18v2H3v-2zm0-8h18v2H3v-2z"/></svg>';
    const ICON_BACK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z"/></svg>';
    const ICON_COPY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    const ICON_UP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14l-6-6z"/></svg>';
    const ICON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 16l-6-6 1.41-1.41L12 13.17l4.59-4.58L18 10l-6 6z"/></svg>';
    const ICON_EYE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
    const ICON_EYE_OFF = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';
    const ICON_RESET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
    const ICON_CODE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>';
    const ICON_DOT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>';
    const ICON_DRAG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 9H4v2h16V9zM4 15h16v-2H4v2z"/></svg>';
    const ICON_HOME = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>';
    const ICON_TARGET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>';
    const ICON_BLOCK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a7.95 7.95 0 01-4.9-1.69L18.31 7.1A7.95 7.95 0 0120 12c0 4.41-3.59 8-8 8z"/></svg>';
    const ICON_EDIT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

    // ─────────────────────────────────────────────
    // BLOCKER CLASS — 규칙 저장/적용 + AdGuard/uBlock export
    // ─────────────────────────────────────────────
    class Blocker {
        static init() {
            if (document.head) this.enforce();
            else {
                const obs = new MutationObserver(() => {
                    if (document.head) { this.enforce(); obs.disconnect(); }
                });
                obs.observe(document.documentElement, { childList: true });
            }
        }

        static fetch() {
            return GM_getValue("picky_blocked_rules", {})[window.location.hostname] || [];
        }
        static fetchAll() { return GM_getValue("picky_blocked_rules", {}); }

        static append(sel) {
            if (!sel || /[{}]/.test(sel)) return false;
            const all = GM_getValue("picky_blocked_rules", {});
            const host = window.location.hostname;
            if (!all[host]) all[host] = [];
            if (all[host].includes(sel)) return false;
            all[host].push(sel);
            GM_setValue("picky_blocked_rules", all);
            const history = GM_getValue("picky_history", []);
            history.push({ host, selector: sel, time: Date.now() });
            if (history.length > 50) history.shift();
            GM_setValue("picky_history", history);
            this.enforce();
            return true;
        }

        static drop(sel) {
            const all = GM_getValue("picky_blocked_rules", {});
            const host = window.location.hostname;
            if (!all[host]) return false;
            all[host] = all[host].filter(s => s !== sel);
            if (all[host].length === 0) delete all[host];
            GM_setValue("picky_blocked_rules", all);
            this.enforce();
            return true;
        }

        static undoLast() {
            const history = GM_getValue("picky_history", []);
            if (history.length === 0) return null;
            const last = history.pop();
            GM_setValue("picky_history", history);
            const all = GM_getValue("picky_blocked_rules", {});
            if (all[last.host]) {
                all[last.host] = all[last.host].filter(s => s !== last.selector);
                if (all[last.host].length === 0) delete all[last.host];
                GM_setValue("picky_blocked_rules", all);
                this.enforce();
            }
            return last;
        }

        static isEnabled() { return GM_getValue("picky_blocking_enabled", true); }
        static toggleEnabled() {
            const cur = this.isEnabled();
            GM_setValue("picky_blocking_enabled", !cur);
            this.enforce();
            return !cur;
        }
        static isAggressive() { return GM_getValue("picky_aggressive_block", false); }
        static toggleAggressive() {
            const cur = this.isAggressive();
            GM_setValue("picky_aggressive_block", !cur);
            this.enforce();
            return !cur;
        }

        static enforce() {
            const rules = this.fetch();
            const enabled = this.isEnabled();
            const aggressive = this.isAggressive();
            const styleId = "picky-blocker-style";
            let style = document.getElementById(styleId);
            if (rules.length && enabled) {
                if (!style) {
                    style = document.createElement("style");
                    style.id = styleId;
                    (document.head || document.documentElement).appendChild(style);
                }
                if (aggressive) {
                    style.textContent = rules.join(", ") + " { display: none !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important; padding: 0 !important; margin: 0 !important; visibility: hidden !important; }";
                } else {
                    style.textContent = rules.join(", ") + " { display: none !important; }";
                }
            } else if (style) style.remove();
        }

        static clear() {
            const all = GM_getValue("picky_blocked_rules", {});
            const host = window.location.hostname;
            if (all[host]) {
                delete all[host];
                GM_setValue("picky_blocked_rules", all);
                const s = document.getElementById("picky-blocker-style");
                if (s) s.remove();
                alert("이 사이트의 차단 규칙이 초기화되었습니다. 페이지를 새로고침합니다.");
                location.reload();
            } else alert("저장된 차단 규칙이 없습니다.");
        }

        static getStats() {
            const rules = this.fetch();
            let hidden = 0;
            rules.forEach(sel => { try { hidden += document.querySelectorAll(sel).length; } catch(e) {} });
            const all = this.fetchAll();
            let totalSites = Object.keys(all).length, totalRules = 0;
            Object.values(all).forEach(arr => totalRules += arr.length);
            return { ruleCount: rules.length, hiddenCount: hidden, totalSites, totalRules };
        }

        static exportJSON() {
            const all = this.fetchAll();
            const data = { app: "Picky Advanced", version: "3.6.0", exportDate: new Date().toISOString(), rules: all };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `picky-rules-${Date.now()}.json`; a.click();
            URL.revokeObjectURL(url);
        }

        // uBlock Origin 형식 export (host##selector)
        static exportUblock() {
            const all = this.fetchAll();
            let text = "! Picky Advanced uBlock Export - " + new Date().toISOString() + "\n! Paste into uBlock Origin: Dashboard > My filters\n\n";
            let count = 0;
            Object.keys(all).forEach(host => {
                all[host].forEach(rule => { text += `${host}##${rule}\n`; count++; });
            });
            navigator.clipboard.writeText(text).then(() =>
                alert(`${count}개 규칙(${Object.keys(all).length}개 사이트)을 uBlock 형식으로 클립보드에 복사했어요.`)
            ).catch(() => prompt("복사 실패. 수동으로 복사하세요:", text));
        }

        // AdGuard / uBlock 공통 호환 필터 export
        static exportAdGuard() {
            const all = this.fetchAll();
            const lines = [
                '! Title: Picky Advanced AdGuard Export',
                '! Version: 3.6.0',
                `! Generated: ${new Date().toISOString()}`,
                '! Syntax: AdGuard / uBlock Origin compatible cosmetic filters',
                ''
            ];
            let count = 0;
            Object.keys(all).forEach(host => {
                const rules = all[host] || [];
                if (!rules.length) return;
                lines.push(`! ===== ${host} =====`);
                rules.forEach(rule => {
                    lines.push(host === 'global' ? `##${rule}` : `${host}##${rule}`);
                    count++;
                });
                lines.push('');
            });
            const text = lines.join('\n');
            navigator.clipboard.writeText(text).then(() =>
                alert(`${count}개 규칙(${Object.keys(all).length}개 사이트)을 AdGuard/uBlock 호환 필터로 복사했어요.`)
            ).catch(() => prompt("복사 실패. 수동으로 복사하세요:", text));
            return text;
        }

        static importJSON() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.json,.txt';
            input.onchange = (e) => {
                const file = e.target.files[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        const rules = data.rules || data;
                        if (typeof rules !== 'object') throw new Error("Invalid format");
                        const existing = this.fetchAll();
                        const merge = confirm("기존 규칙을 유지하고 병합할까요?\n[확인] = 병합 / [취소] = 덮어쓰기");
                        const merged = merge ? { ...existing } : {};
                        let added = 0;
                        Object.keys(rules).forEach(host => {
                            if (!Array.isArray(rules[host])) return;
                            if (!merged[host]) merged[host] = [];
                            rules[host].forEach(rule => {
                                if (typeof rule === 'string' && !merged[host].includes(rule)) {
                                    merged[host].push(rule); added++;
                                }
                            });
                        });
                        GM_setValue("picky_blocked_rules", merged);
                        this.enforce();
                        alert(`가져오기 완료!\n${Object.keys(rules).length}개 사이트, ${added}개 신규 규칙 추가됨.`);
                    } catch (err) { alert("파일 형식 오류: " + err.message); }
                };
                reader.readAsText(file);
            };
            input.click();
        }
    }

    Blocker.init();

    // === Part 1 끝. Part 2부터 이어집니다 (같은 IIFE 내부). ===

/*** Modal class — 공용 모달 컨테이너 ***/
class Modal {
  constructor(title, bodyHtml, opts={}){
    this.title = title;
    this.bodyHtml = bodyHtml;
    this.opts = Object.assign({width:'520px', onClose:null, buttons:null}, opts);
    this.host = null;
    this.shadow = null;
    this.root = null;
  }
  open(){
    this.host = document.createElement('div');
    this.host.className = 'picky-modal-host';
    this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    this.shadow = this.host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = MODAL_CSS;
    this.shadow.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'picky-modal-overlay';
    overlay.innerHTML = `
      <div class="picky-modal" style="max-width:${this.opts.width};">
        <div class="picky-modal-head">
          <div class="picky-modal-title">${this.title}</div>
          <button class="picky-modal-close" data-act="close" aria-label="닫기">×</button>
        </div>
        <div class="picky-modal-body">${this.bodyHtml}</div>
        ${this.opts.buttons ? `<div class="picky-modal-foot">${this.opts.buttons}</div>` : ''}
      </div>`;
    this.shadow.appendChild(overlay);
    this.root = overlay.querySelector('.picky-modal');

    overlay.addEventListener('click', e=>{
      if(e.target === overlay) this.close();
      if(e.target.dataset && e.target.dataset.act === 'close') this.close();
    });
    document.addEventListener('keydown', this._escHandler = (e)=>{
      if(e.key === 'Escape'){ this.close(); }
    });

    document.body.appendChild(this.host);
    return this;
  }
  body(){ return this.root ? this.root.querySelector('.picky-modal-body') : null; }
  foot(){ return this.root ? this.root.querySelector('.picky-modal-foot') : null; }
  on(selector, ev, handler){
    if(!this.root) return;
    this.root.querySelectorAll(selector).forEach(el=>el.addEventListener(ev, handler));
  }
  close(){
    try{ document.removeEventListener('keydown', this._escHandler); }catch(e){}
    if(this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    this.host = this.shadow = this.root = null;
    if(typeof this.opts.onClose === 'function') this.opts.onClose();
  }
}

// 모달 전용 CSS (다크 테마)
const MODAL_CSS = `
:host,*{box-sizing:border-box;}
.picky-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:13px;color:#e8eaed;backdrop-filter:blur(4px);}
.picky-modal{background:#1c1e26;border:1px solid rgba(255,255,255,0.12);border-radius:14px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);}
.picky-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);}
.picky-modal-title{font-size:15px;font-weight:600;color:#e8eaed;}
.picky-modal-close{background:transparent;border:none;color:#a0a3a8;font-size:22px;cursor:pointer;padding:0 6px;line-height:1;}
.picky-modal-close:hover{color:#e8eaed;}
.picky-modal-body{padding:16px 18px;overflow-y:auto;flex:1;color:#e8eaed;line-height:1.55;}
.picky-modal-body label{color:#e8eaed;}
.picky-modal-body input,.picky-modal-body textarea,.picky-modal-body select{background:#2a2d36;border:1px solid rgba(255,255,255,0.12);color:#e8eaed;border-radius:6px;padding:6px 8px;font-size:13px;width:100%;}
.picky-modal-body input:focus,.picky-modal-body textarea:focus{outline:2px solid #3b82f6;border-color:transparent;}
.picky-modal-body pre,.picky-modal-body code{background:#11131a;color:#cbd5e1;border-radius:6px;padding:8px;font-family:Consolas,Menlo,monospace;font-size:12px;}
.picky-modal-foot{padding:12px 18px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:8px;justify-content:flex-end;background:rgba(255,255,255,0.02);}
.picky-modal-foot button{background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}
.picky-modal-foot button:hover{background:#3a3d46;}
.picky-modal-foot button.primary{background:#3b82f6;border-color:#3b82f6;color:#fff;}
.picky-modal-foot button.primary:hover{background:#2563eb;}
.picky-modal-foot button.danger{background:#dc2626;border-color:#dc2626;color:#fff;}
.picky-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:12px;}
.picky-tab{background:transparent;border:none;color:#a0a3a8;padding:8px 14px;cursor:pointer;border-bottom:2px solid transparent;}
.picky-tab.active{color:#e8eaed;border-bottom-color:#3b82f6;}
.picky-ad-suggest-item{display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);margin-bottom:6px;cursor:pointer;}
.picky-ad-suggest-item:hover{background:rgba(255,255,255,0.04);}
.picky-ad-suggest-item.selected{background:rgba(16,185,129,0.15);border-color:#10b981;}
.picky-ad-suggest-item input[type=checkbox]{width:auto;}
.picky-cookie-table{width:100%;border-collapse:collapse;font-size:12px;}
.picky-cookie-table th,.picky-cookie-table td{border:1px solid rgba(255,255,255,0.08);padding:6px;text-align:left;}
.picky-cookie-table th{background:rgba(255,255,255,0.04);}
.picky-child-list{list-style:none;padding-left:14px;margin:4px 0;}
.picky-child-list li{padding:3px 0;cursor:pointer;color:#cbd5e1;}
.picky-child-list li:hover{color:#3b82f6;}
`;

/*** SelectorStrategies — 15개 전략 통합 클래스 ***/
class SelectorStrategies {
  // ===== Utility methods =====
  static countMatches(sel, root=document){
    if(!sel) return 0;
    try{ return root.querySelectorAll(sel).length; }catch(e){ return 0; }
  }
  static isMeaningfulClass(cls){
    if(!cls || typeof cls !== 'string') return false;
    if(cls.startsWith('picky-')) return false;          // Patch A
    if(/^(active|hover|focus|selected|open|show|hide|disabled)$/i.test(cls)) return false;
    if(/^[a-z]+-[0-9]+$/i.test(cls)) return false;
    if(/^(jsx|css|sc|emotion|mui)-[a-z0-9]+$/i.test(cls)) return false; // CSS-in-JS
    if(cls.length < 2 || cls.length > 50) return false;
    return /^[a-zA-Z_][\w-]*$/.test(cls);
  }
  static safeClasses(el){
    if(!el || !el.classList) return [];
    return Array.from(el.classList).filter(c => !c.startsWith('picky-'));
  }
  static meaningfulClasses(el){
    return this.safeClasses(el).filter(c => this.isMeaningfulClass(c));
  }
  static parentChain(el, maxDepth=4){
    const chain = [];
    let cur = el && el.parentElement;
    let d = 0;
    while(cur && d < maxDepth && cur.tagName !== 'BODY' && cur.tagName !== 'HTML'){
      chain.push(cur);
      cur = cur.parentElement;
      d++;
    }
    return chain;
  }
  static _findImg(el){
    if(!el) return null;
    if(el.tagName === 'IMG') return el;
    return el.querySelector ? el.querySelector('img') : null;
  }
  static _findAnchor(el){
    if(!el) return null;
    if(el.tagName === 'A') return el;
    return el.closest ? el.closest('a') : null;
  }
  static isImageRelated(el){
    if(!el) return false;
    if(el.tagName === 'IMG' || el.tagName === 'IFRAME') return true;
    if(!el.querySelector) return false;
    return !!(el.querySelector('img') || el.querySelector('iframe'));
  }

  // ===== Scoring =====
  static scoreSelector(sel, matchCount, opts={}){
    if(!sel) return 0;
    let score = 50;
    if(matchCount === 1) score += 30;
    else if(matchCount > 1 && matchCount <= 5) score += 15;
    else if(matchCount > 20) score -= 20;
    else if(matchCount === 0) score -= 40;

    if(sel.includes('#')) score += 15;
    if(/\[data-(test|ad|qa)/i.test(sel)) score += 20;
    if(/\[aria-/i.test(sel)) score += 10;
    if(sel.includes(':has(')) score += 8;
    if(sel.includes(':nth-')) score -= 5;
    if(sel.split(' ').length > 4) score -= 8;
    if(sel.length > 200) score -= 15;
    if(opts.bonus) score += opts.bonus;
    return Math.max(0, Math.min(100, score));
  }
  static scoreToStars(score){
    if(score >= 85) return '★★★★★';
    if(score >= 70) return '★★★★☆';
    if(score >= 55) return '★★★☆☆';
    if(score >= 40) return '★★☆☆☆';
    if(score >= 20) return '★☆☆☆☆';
    return '☆☆☆☆☆';
  }

  // ===== 1) semantic =====
  static semantic(el){
    if(!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    const priority = ['data-testid','data-test','data-qa','data-cy','name','aria-label','alt','title','role','data-ad','data-ad-slot'];
    for(const attr of priority){
      const v = el.getAttribute && el.getAttribute(attr);
      if(v && v.length < 80){
        const sel = `${tag}[${attr}="${CSS.escape(v)}"]`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:10});
          return {type:'semantic', icon:'🎯', label:'시맨틱', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`${attr} 속성 기반`};
        }
      }
    }
    return null;
  }

  // ===== 2) shortest =====
  static shortest(el){
    if(!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    // ID
    if(el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !el.id.startsWith('picky-')){
      const sel = `#${CSS.escape(el.id)}`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt, {bonus:15});
        return {type:'shortest', icon:'⚡', label:'최단', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:'ID 기반'};
      }
    }
    // ID + class (Patch C)
    const classes = this.meaningfulClasses(el);
    if(el.id && classes.length){
      const sel = `#${CSS.escape(el.id)}.${CSS.escape(classes[0])}`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt, {bonus:10});
        return {type:'shortest', icon:'⚡', label:'최단', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:'ID+클래스'};
      }
    }
    // class only
    if(classes.length){
      const sel = `${tag}.${CSS.escape(classes[0])}`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt);
        return {type:'shortest', icon:'⚡', label:'최단', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:'클래스 기반'};
      }
    }
    // tag fallback
    const cnt = this.countMatches(tag);
    const score = this.scoreSelector(tag, cnt);
    return {type:'shortest', icon:'⚡', label:'최단', selector:tag, matchCount:cnt, score, stars:this.scoreToStars(score), hint:'태그 기반'};
  }

  // ===== 3) dummyHref (Patch B) =====
  static dummyHref(el){
    const a = this._findAnchor(el);
    if(!a) return null;
    const href = a.getAttribute('href') || '';
    const dummyPatterns = ['javascript:;','javascript:void(0)','#','#!'];
    const isDummy = dummyPatterns.some(p => href.trim() === p) || href.trim() === '';
    if(!isDummy) return null;
    const tag = a.tagName.toLowerCase();
    const classes = this.meaningfulClasses(a);
    let sel = classes.length
      ? `${tag}[href="${href}"].${CSS.escape(classes[0])}`
      : `${tag}[href="${href}"]`;
    const cnt = this.countMatches(sel);
    if(cnt === 0) return null;
    const score = this.scoreSelector(sel, cnt, {bonus:-5});
    return {type:'dummyHref', icon:'🔗', label:'더미링크', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`href="${href}"`};
  }

  // ===== 4) classPattern =====
  static classPattern(el){
    if(!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    const classes = this.meaningfulClasses(el);
    const adKeywords = ['ad','ads','advert','banner','promo','sponsor','popup','overlay'];

    // data-ad-*
    for(const attr of (el.getAttributeNames ? el.getAttributeNames() : [])){
      if(attr.startsWith('data-ad')){
        const sel = `${tag}[${attr}]`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:15});
          return {type:'classPattern', icon:'🎨', label:'클래스패턴', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`${attr} 속성`};
        }
      }
    }
    // ad keyword class
    for(const c of classes){
      const low = c.toLowerCase();
      if(adKeywords.some(k => low.includes(k))){
        const sel = `${tag}.${CSS.escape(c)}`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:12});
          return {type:'classPattern', icon:'🎨', label:'클래스패턴', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`광고 키워드: ${c}`};
        }
      }
    }
    // BEM
    const bem = classes.find(c => /^[a-z]+__[a-z]+(--[a-z]+)?$/i.test(c));
    if(bem){
      const sel = `${tag}.${CSS.escape(bem)}`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt, {bonus:5});
        return {type:'classPattern', icon:'🎨', label:'클래스패턴', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`BEM: ${bem}`};
      }
    }
    return null;
  }

  // ===== 5) precise =====
  static precise(el, evaluator){
    if(!el || typeof evaluator !== 'function') return null;
    try{
      const sel = evaluator(el);
      if(!sel) return null;
      const cnt = this.countMatches(sel);
      const score = this.scoreSelector(sel, cnt, {bonus:8});
      return {type:'precise', icon:'🔍', label:'정밀', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:'평가자 기반'};
    }catch(e){ return null; }
  }

  // ===== 6) similarGroup =====
  static similarGroup(el){
    if(!el || !el.parentElement) return null;
    const tag = el.tagName.toLowerCase();
    const classes = this.meaningfulClasses(el);
    const parent = el.parentElement;
    if(classes.length){
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName && c.classList.contains(classes[0]));
      if(siblings.length >= 2){
        const sel = `${tag}.${CSS.escape(classes[0])}`;
        const cnt = this.countMatches(sel);
        const score = this.scoreSelector(sel, cnt, {bonus:5});
        return {type:'similarGroup', icon:'👥', label:'유사그룹', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`형제 ${siblings.length}개`};
      }
    }
    if(parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id)){
      const sel = `#${CSS.escape(parent.id)} > ${tag}`;
      const cnt = this.countMatches(sel);
      if(cnt >= 2){
        const score = this.scoreSelector(sel, cnt);
        return {type:'similarGroup', icon:'👥', label:'유사그룹', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`부모 ID 자식`};
      }
    }
    return null;
  }

  // ===== 7) container =====
  static container(el){
    if(!el) return null;
    const chain = this.parentChain(el, 4);
    const adKeywords = ['ad','ads','advert','banner','promo','sponsor'];
    const semanticTags = ['aside','header','footer','section','nav'];
    for(const ancestor of chain){
      // ID
      if(ancestor.id && adKeywords.some(k => ancestor.id.toLowerCase().includes(k))){
        const sel = `#${CSS.escape(ancestor.id)}`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:10});
          return {type:'container', icon:'📦', label:'컨테이너', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`광고 ID: ${ancestor.id}`};
        }
      }
      // class
      const cls = this.meaningfulClasses(ancestor).find(c => adKeywords.some(k => c.toLowerCase().includes(k)));
      if(cls){
        const sel = `${ancestor.tagName.toLowerCase()}.${CSS.escape(cls)}`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:8});
          return {type:'container', icon:'📦', label:'컨테이너', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`광고 컨테이너 클래스`};
        }
      }
      // semantic tag
      if(semanticTags.includes(ancestor.tagName.toLowerCase())){
        const aClasses = this.meaningfulClasses(ancestor);
        if(aClasses.length){
          const sel = `${ancestor.tagName.toLowerCase()}.${CSS.escape(aClasses[0])}`;
          const cnt = this.countMatches(sel);
          if(cnt > 0){
            const score = this.scoreSelector(sel, cnt);
            return {type:'container', icon:'📦', label:'컨테이너', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`시맨틱 컨테이너`};
          }
        }
      }
    }
    return null;
  }

  // ===== 8) imgSrcDomain =====
  static imgSrcDomain(el){
    const img = this._findImg(el);
    if(!img) return null;
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if(!src) return null;
    const host = AD_NETWORK_HOSTS.find(h => src.includes(h));
    if(!host) return null;
    const sel = `img[src*="${host}"]`;
    const cnt = this.countMatches(sel);
    const score = this.scoreSelector(sel, cnt, {bonus:15});
    return {type:'imgSrcDomain', icon:'🖼️', label:'광고도메인', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`도메인: ${host}`};
  }

  // ===== 9) imgStandardSize =====
  static imgStandardSize(el){
    const img = this._findImg(el);
    if(!img) return null;
    const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width'))||0;
    const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height'))||0;
    if(!w || !h) return null;
    const match = STD_AD_SIZES.find(([sw,sh]) => Math.abs(sw-w)<=2 && Math.abs(sh-h)<=2);
    if(!match) return null;
    const anchor = this._findAnchor(img);
    let sel;
    if(anchor && anchor.href && !anchor.href.includes(location.hostname)){
      sel = `a[href*="//"]:has(> img[width="${match[0]}"][height="${match[1]}"])`;
    } else {
      sel = `img[width="${match[0]}"][height="${match[1]}"]`;
    }
    const cnt = this.countMatches(sel);
    const score = this.scoreSelector(sel, cnt, {bonus:10});
    return {type:'imgStandardSize', icon:'📐', label:'IAB크기', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`IAB 표준 ${match[0]}×${match[1]}`};
  }

  // ===== 10) imgInAdLink =====
  static imgInAdLink(el){
    const img = this._findImg(el);
    if(!img) return null;
    const a = this._findAnchor(img);
    if(!a) return null;
    const href = a.getAttribute('href') || '';
    const matched = AD_LINK_PATTERNS.find(p => href.includes(p.kw));
    if(!matched) return null;
    const sel = `a[href*="${matched.kw}"]:has(> img)`;
    const cnt = this.countMatches(sel);
    const score = this.scoreSelector(sel, cnt, {bonus:12});
    return {type:'imgInAdLink', icon:'🔗', label:'광고링크', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:matched.desc};
  }

  // ===== 11) imgPathPattern =====
  static imgPathPattern(el){
    const img = this._findImg(el);
    if(!img) return null;
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if(!src) return null;
    const pattern = AD_PATH_PATTERNS.find(p => src.toLowerCase().includes(p.kw));
    if(pattern){
      const sel = `img[src*="${pattern.kw}"]`;
      const cnt = this.countMatches(sel);
      const score = this.scoreSelector(sel, cnt, {bonus:10});
      return {type:'imgPathPattern', icon:'🛣️', label:'경로패턴', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:pattern.desc};
    }
    const ext = AD_FILE_EXTS.find(e => src.toLowerCase().endsWith(e));
    if(ext && /(_ad|banner|promo|sponsor)/i.test(src)){
      const sel = `img[src$="${ext}"]`;
      const cnt = this.countMatches(sel);
      const score = this.scoreSelector(sel, cnt, {bonus:3});
      return {type:'imgPathPattern', icon:'🛣️', label:'경로패턴', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`확장자 ${ext}`};
    }
    return null;
  }

  // ===== 12) networkFilter (NEW) =====
  static networkFilter(el){
    if(!el) return null;
    // 검색 대상 요소
    const targets = ['IMG','IFRAME','SCRIPT','VIDEO'].includes(el.tagName) ? [el]
      : el.querySelectorAll ? Array.from(el.querySelectorAll('img,iframe,script,video')) : [];
    if(!targets.length) return null;

    for(const node of targets){
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if(!src || src.startsWith('data:')) continue;
      let url;
      try{ url = new URL(src, location.href); }catch(e){ continue; }
      const host = url.hostname;
      const path = url.pathname.toLowerCase();

      // (a) 광고 호스트
      const adHost = AD_NETWORK_HOSTS.find(h => host.includes(h));
      if(adHost){
        const filter = `||${adHost}^`;
        return {type:'networkFilter', icon:'🌐', label:'네트워크', selector:'', filter, isNetwork:true, matchCount:1, score:90, stars:'★★★★★', hint:`광고 호스트 ${adHost}`};
      }
      // (b) 광고 경로 패턴
      const pp = AD_PATH_PATTERNS.find(p => path.includes(p.kw));
      if(pp){
        const filter = `||${host}${pp.kw}*`;
        return {type:'networkFilter', icon:'🌐', label:'네트워크', selector:'', filter, isNetwork:true, matchCount:1, score:75, stars:'★★★★☆', hint:`경로: ${pp.desc}`};
      }
      // (c) 외부 도메인 + IAB 크기 (이미지 한정)
      if(node.tagName === 'IMG' && host !== location.hostname){
        const w = node.naturalWidth || parseInt(node.getAttribute('width'))||0;
        const h = node.naturalHeight || parseInt(node.getAttribute('height'))||0;
        if(STD_AD_SIZES.some(([sw,sh]) => Math.abs(sw-w)<=2 && Math.abs(sh-h)<=2)){
          const filter = `||${host}^$image`;
          return {type:'networkFilter', icon:'🌐', label:'네트워크', selector:'', filter, isNetwork:true, matchCount:1, score:70, stars:'★★★★☆', hint:`외부 도메인 ${host} + IAB ${w}×${h}`};
        }
      }
      // (d) 외부 + 광고 확장자
      if(host !== location.hostname){
        const ext = AD_FILE_EXTS.find(e => path.endsWith(e));
        if(ext && /(_ad|banner|promo|sponsor|advert)/i.test(path)){
          const filter = `||${host}${path}`;
          return {type:'networkFilter', icon:'🌐', label:'네트워크', selector:'', filter, isNetwork:true, matchCount:1, score:60, stars:'★★★☆☆', hint:`외부 광고 리소스`};
        }
      }
    }
    return null;
  }

  // ===== 13) mixedNth (NEW) =====
  static mixedNth(el){
    if(!el || !el.parentElement) return null;
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    const classes = this.meaningfulClasses(el);
    const candidates = [];

    // (a) tag.class:nth-of-type(n)
    if(classes.length){
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      const idx = siblings.indexOf(el) + 1;
      if(idx > 0){
        const sel = `${tag}.${CSS.escape(classes[0])}:nth-of-type(${idx})`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:5});
          candidates.push({selector:sel, matchCount:cnt, score, hint:`클래스+nth-of-type(${idx})`});
        }
      }
    }
    // (b) parent#id > tag:nth-of-type(n)
    if(parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id)){
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      const idx = siblings.indexOf(el) + 1;
      const sel = `#${CSS.escape(parent.id)} > ${tag}:nth-of-type(${idx})`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt, {bonus:7});
        candidates.push({selector:sel, matchCount:cnt, score, hint:`부모ID+nth-of-type(${idx})`});
      }
    }
    // (c) tag:nth-child(n)
    const allSiblings = Array.from(parent.children);
    const childIdx = allSiblings.indexOf(el) + 1;
    if(childIdx > 0){
      const sel = `${tag}:nth-child(${childIdx})`;
      const cnt = this.countMatches(sel);
      if(cnt > 0){
        const score = this.scoreSelector(sel, cnt);
        candidates.push({selector:sel, matchCount:cnt, score, hint:`nth-child(${childIdx})`});
      }
    }
    if(!candidates.length) return null;
    candidates.sort((a,b) => b.score - a.score);
    const best = candidates[0];
    return {type:'mixedNth', icon:'🧩', label:'위치복합', selector:best.selector, matchCount:best.matchCount, score:best.score, stars:this.scoreToStars(best.score), hint:best.hint};
  }

  // ===== 14) multiCondition (NEW) =====
  static multiCondition(el){
    if(!el || !el.tagName) return null;
    const tag = el.tagName.toLowerCase();
    const parts = [tag];
    let bonus = 0;
    const hints = [];

    // 인라인 style
    const style = el.getAttribute('style') || '';
    if(/display\s*:\s*(block|inline-block|flex)/i.test(style) && /(width|height)/i.test(style)){
      // 너무 광범위하지 않게 — style 자체는 검색하기 어려우니 스킵, 힌트만 활용
    }
    // :has 자식 광고
    if(el.querySelector){
      if(el.querySelector(':scope > iframe')){
        parts.push(':has(> iframe)');
        bonus += 8;
        hints.push('iframe 자식');
      } else if(el.querySelector(':scope > img[src*="ad"]')){
        parts.push(':has(> img[src*="ad"])');
        bonus += 10;
        hints.push('광고 이미지 자식');
      }
    }
    // 다중 클래스
    const classes = this.meaningfulClasses(el).slice(0,2);
    if(classes.length >= 2){
      parts[0] = `${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`;
      bonus += 5;
      hints.push('다중 클래스');
    } else if(classes.length === 1){
      parts[0] = `${tag}.${CSS.escape(classes[0])}`;
    }
    // 짧은 data-* 속성
    const dataAttr = (el.getAttributeNames ? el.getAttributeNames() : []).find(a => a.startsWith('data-') && a.length < 18 && !a.startsWith('data-picky'));
    if(dataAttr){
      parts.push(`[${dataAttr}]`);
      bonus += 4;
      hints.push(dataAttr);
    }

    if(parts.length < 2 && (parts[0] === tag || !classes.length)) return null;
    const sel = parts.join('');
    const cnt = this.countMatches(sel);
    if(cnt === 0) return null;
    const score = this.scoreSelector(sel, cnt, {bonus});
    return {type:'multiCondition', icon:'🔧', label:'복합조건', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:hints.join(' + ') || '복합'};
  }

  // ===== 15) ariaLabel (NEW) =====
  static ariaLabel(el){
    if(!el) return null;
    const chain = [el, ...this.parentChain(el, 3)];
    for(const node of chain){
      if(!node.getAttribute) continue;
      const aria = node.getAttribute('aria-label');
      const role = node.getAttribute('role');
      const labelledby = node.getAttribute('aria-labelledby');
      const tag = node.tagName.toLowerCase();

      if(aria){
        const isAd = ARIA_AD_KEYWORDS.some(k => aria.toLowerCase().includes(k.toLowerCase()));
        const sel = `${tag}[aria-label*="${CSS.escape(aria.slice(0,30))}"]`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus: isAd ? 15 : 5});
          return {type:'ariaLabel', icon:'♿', label:'ARIA', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`aria-label: "${aria.slice(0,30)}"`};
        }
      }
      if(role && /banner|complementary|advertisement/i.test(role)){
        const sel = `${tag}[role="${role}"]`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:12});
          return {type:'ariaLabel', icon:'♿', label:'ARIA', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`role="${role}"`};
        }
      }
      if(labelledby){
        const sel = `${tag}[aria-labelledby="${CSS.escape(labelledby)}"]`;
        const cnt = this.countMatches(sel);
        if(cnt > 0){
          const score = this.scoreSelector(sel, cnt, {bonus:7});
          return {type:'ariaLabel', icon:'♿', label:'ARIA', selector:sel, matchCount:cnt, score, stars:this.scoreToStars(score), hint:`aria-labelledby`};
        }
      }
    }
    return null;
  }

  // ===== buildAll : 15개 전략 모두 실행 =====
  static buildAll(el, evaluator){
    if(!el) return [];
    const results = [];
    const strategies = [
      () => this.semantic(el),
      () => this.shortest(el),
      () => this.dummyHref(el),
      () => this.classPattern(el),
      () => this.precise(el, evaluator),
      () => this.similarGroup(el),
      () => this.container(el),
      () => this.networkFilter(el),
      () => this.mixedNth(el),
      () => this.multiCondition(el),
      () => this.ariaLabel(el)
    ];
    if(this.isImageRelated(el)){
      strategies.push(
        () => this.imgSrcDomain(el),
        () => this.imgStandardSize(el),
        () => this.imgInAdLink(el),
        () => this.imgPathPattern(el)
      );
    }
    for(const fn of strategies){
      try{
        const r = fn();
        if(r) results.push(r);
      }catch(e){ /* 전략 한 개 실패해도 무시 */ }
    }
    // Patch A: picky-* 셀렉터 제거
    const filtered = results.filter(r => !r.selector || !r.selector.includes('picky-'));
    // 중복 제거 (selector 또는 filter 키 기준)
    const seen = new Set();
    const unique = filtered.filter(r => {
      const key = r.filter || r.selector;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // 점수 내림차순
    unique.sort((a,b) => b.score - a.score);
    if(unique.length) unique[0].recommended = true;
    return unique;
  }

  // ===== toAdGuardRule : 후보 -> AdGuard/uBlock 호환 규칙 문자열 =====
  static toAdGuardRule(candidate, host){
    if(!candidate) return '';
    if(candidate.isNetwork && candidate.filter) return candidate.filter;
    if(!candidate.selector) return '';
    const scope = host || location.hostname;
    if(scope === 'global' || !scope) return `##${candidate.selector}`;
    return `${scope}##${candidate.selector}`;
  }
}
// === Part 2 ends — Part 3 will continue inside the same IIFE ===

/*** Inspector — 메인 컨트롤러 (전반부) ***/
class Inspector {
  constructor(){
    this.dom = {
      host:null, shadow:null, tool:null, shield:null,
      disp:null, match:null, slider:null, cardsScroll:null
    };
    this.state = {
      target:null,
      originTarget:null,
      hierarchy:[],
      queryData:{selector:'', root:document},
      candidates:[],
      selectedIdx:-1,
      previewNodes:[],
      mode:'initial',                                          // initial | inspecting | picking
      scale: GM_getValue('picky_scale','icon'),                // icon(기본) | full
      isCollapsed:true,
      isObscured:false,
      isQuarantined:false,
      obscuredNodes:[],
      displayCache:new WeakMap(),
      hits:0,
      autoDismiss: GM_getValue('picky_auto_close', true),
      hoverPreviewNodes:[],
      adSelectedNodes:[],
      iconPos:  GM_getValue('picky_icon_pos',  null),
      panelPos: GM_getValue('picky_panel_pos', null),
      isDragging:false,
      dragDidMove:false,
      dragTarget:null,                                         // 'icon' | 'panel'
      dragStartX:0, dragStartY:0,
      dragOrigX:0,  dragOrigY:0
    };
    this.config = {
      useId:true, useClasses:true, classCount:2,
      useNthOfType:true, intelligentMode:true,
      maxDepth:8, shadowDomSupport:false
    };
    this.longPressTimer = null;
    this.longPressDuration = 600;
    this._preciseEvaluator = el => this.evaluateCssBasic(el);
  }

  /* ─ 기본 CSS 평가자 (precise 전략용) ─ */
  evaluateCssBasic(el){
    if(!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if(el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !el.id.startsWith('picky-')){
      return `#${CSS.escape(el.id)}`;
    }
    const cls = SelectorStrategies.meaningfulClasses(el);
    if(cls.length){
      const sub = cls.slice(0, this.config.classCount).map(c => `.${CSS.escape(c)}`).join('');
      return `${tag}${sub}`;
    }
    return tag;
  }

  /* ─ UI 구축 (host → shadow → tool) ─ */
  constructUI(){
    // 페이지 CSS 주입 (하이라이트/미리보기)
    injectPageCss();

    // 기존 인스턴스 제거
    const old = document.getElementById(ROOT_ID);
    if(old) old.remove();

    this.dom.host = document.createElement('div');
    this.dom.host.id = ROOT_ID;
    this.dom.host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    this.dom.shadow = this.dom.host.attachShadow({mode:'open'});

    const style = document.createElement('style');
    style.textContent = PICKY_CSS;
    this.dom.shadow.appendChild(style);

    this.dom.tool = document.createElement('div');
    this.dom.tool.id = TOOL_ID;
    this.dom.tool.className = 'picky-tool';
    this.dom.shadow.appendChild(this.dom.tool);

    (document.body || document.documentElement).appendChild(this.dom.host);

    this.render();
    this.applyPosition();
    this.attachGlobalEvents();
  }

  /* ─ 저장된 위치 적용 (아이콘/패널 각각) ─ */
  applyPosition(){
    if(!this.dom.tool) return;
    const tool = this.dom.tool;
    // scale에 따라 다른 위치 키 사용
    if(this.state.scale === 'icon'){
      const pos = this.state.iconPos;
      if(pos && typeof pos.x === 'number' && typeof pos.y === 'number'){
        const {x,y} = this.clampToViewport(pos.x, pos.y, 48, 48);
        tool.style.left = x + 'px';
        tool.style.top  = y + 'px';
        tool.style.right = 'auto';
        tool.style.bottom = 'auto';
      } else {
        tool.style.left = 'auto';
        tool.style.top  = 'auto';
        tool.style.right = '20px';
        tool.style.bottom = '20px';
      }
    } else {
      const pos = this.state.panelPos;
      const w = 360, h = 480;
      if(pos && typeof pos.x === 'number' && typeof pos.y === 'number'){
        const {x,y} = this.clampToViewport(pos.x, pos.y, w, h);
        tool.style.left = x + 'px';
        tool.style.top  = y + 'px';
        tool.style.right = 'auto';
        tool.style.bottom = 'auto';
      } else {
        tool.style.left = 'auto';
        tool.style.top  = 'auto';
        tool.style.right = '20px';
        tool.style.bottom = '20px';
      }
    }
  }

  clampToViewport(x, y, w, h){
    const vw = window.innerWidth, vh = window.innerHeight;
    return {
      x: Math.max(4, Math.min(x, vw - w - 4)),
      y: Math.max(4, Math.min(y, vh - h - 4))
    };
  }

  /* ─ scale 토글 ─ */
  cycleSize(){
    this.state.scale = (this.state.scale === 'icon') ? 'full' : 'icon';
    GM_setValue('picky_scale', this.state.scale);
    if(this.state.scale === 'icon'){
      // 패널 닫을 때 picking/preview 정리
      this.stopPicking();
      this.clearPreview();
    }
    this.render();
    this.applyPosition();
  }

  /* ─ 전역 이벤트 ─ */
  attachGlobalEvents(){
    // 단축키: Ctrl+Shift+P (열기/닫기 토글), ESC (패널 축소)
    if(!this._keyHandler){
      this._keyHandler = (e)=>{
        if(e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')){
          e.preventDefault();
          this.cycleSize();
        } else if(e.key === 'Escape'){
          if(this.state.mode === 'picking'){ this.stopPicking(); }
          else if(this.state.scale === 'full'){ this.cycleSize(); }
        } else if(this.state.scale === 'full' && this.state.candidates.length){
          if(e.key === 'ArrowDown'){ e.preventDefault(); this.navCandidate(1); }
          else if(e.key === 'ArrowUp'){ e.preventDefault(); this.navCandidate(-1); }
        }
      };
      document.addEventListener('keydown', this._keyHandler, true);
    }
    // 리사이즈 시 위치 재클램프
    if(!this._resizeHandler){
      this._resizeHandler = ()=> this.applyPosition();
      window.addEventListener('resize', this._resizeHandler);
    }
  }

  navCandidate(delta){
    const len = this.state.candidates.length;
    if(!len) return;
    let idx = this.state.selectedIdx + delta;
    if(idx < 0) idx = len - 1;
    if(idx >= len) idx = 0;
    this.selectCandidate(idx);
  }

  /* ─ 드래그 처리 (마우스 + 터치, 클릭과 구분) ─ */
  attachDragHandlers(target, kind /* 'icon' | 'panel' */){
    if(!target) return;
    const onDown = (e)=>{
      // 자식 인터랙티브 요소 위에서는 드래그하지 않음
      const tgt = e.target;
      if(tgt && tgt.closest && tgt.closest(NO_DRAG_SELECTOR)) return;
      const point = (e.touches && e.touches[0]) || e;
      this.state.isDragging = false;
      this.state.dragDidMove = false;
      this.state.dragTarget = kind;
      this.state.dragStartX = point.clientX;
      this.state.dragStartY = point.clientY;
      const rect = this.dom.tool.getBoundingClientRect();
      this.state.dragOrigX = rect.left;
      this.state.dragOrigY = rect.top;

      // 롱프레스 (아이콘 전용)
      if(kind === 'icon'){
        this.longPressTimer = setTimeout(()=>{
          if(!this.state.dragDidMove){
            this.suggestAds();        // 광고 자동 탐지 모달
          }
        }, this.longPressDuration);
      }

      const onMove = (ev)=>{
        const p = (ev.touches && ev.touches[0]) || ev;
        const dx = p.clientX - this.state.dragStartX;
        const dy = p.clientY - this.state.dragStartY;
        if(!this.state.dragDidMove && Math.hypot(dx,dy) > DRAG_THRESHOLD){
          this.state.dragDidMove = true;
          this.state.isDragging = true;
          if(this.longPressTimer){ clearTimeout(this.longPressTimer); this.longPressTimer = null; }
        }
        if(this.state.isDragging){
          ev.preventDefault();
          const w = (kind === 'icon') ? 48 : 360;
          const h = (kind === 'icon') ? 48 : 480;
          const {x,y} = this.clampToViewport(this.state.dragOrigX + dx, this.state.dragOrigY + dy, w, h);
          this.dom.tool.style.left = x + 'px';
          this.dom.tool.style.top  = y + 'px';
          this.dom.tool.style.right = 'auto';
          this.dom.tool.style.bottom = 'auto';
        }
      };
      const onUp = ()=>{
        if(this.longPressTimer){ clearTimeout(this.longPressTimer); this.longPressTimer = null; }
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
        document.removeEventListener('touchmove', onMove, true);
        document.removeEventListener('touchend',  onUp,   true);
        if(this.state.isDragging){
          // 위치 저장
          const rect = this.dom.tool.getBoundingClientRect();
          const pos = {x: rect.left, y: rect.top};
          if(kind === 'icon'){
            this.state.iconPos = pos;
            GM_setValue('picky_icon_pos', pos);
          } else {
            this.state.panelPos = pos;
            GM_setValue('picky_panel_pos', pos);
          }
        }
        setTimeout(()=>{ this.state.isDragging = false; }, 0);
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
      document.addEventListener('touchmove', onMove, {capture:true, passive:false});
      document.addEventListener('touchend',  onUp,   true);
    };
    target.addEventListener('mousedown',  onDown);
    target.addEventListener('touchstart', onDown, {passive:true});
  }

  /* ─ launch / terminate ─ */
  launch(){ this.constructUI(); }
  terminate(){
    this.dropFocus && this.dropFocus();
    this.clearPreview && this.clearPreview();
    this.stopPicking && this.stopPicking();
    if(this._keyHandler){ document.removeEventListener('keydown', this._keyHandler, true); this._keyHandler = null; }
    if(this._resizeHandler){ window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if(this.dom.host && this.dom.host.parentNode){ this.dom.host.parentNode.removeChild(this.dom.host); }
    this.dom = {};
  }
}

/*** Picky Shadow DOM 내부 CSS (다크 테마) ***/
const PICKY_CSS = `
:host,*{box-sizing:border-box;}
.picky-tool{
  position:fixed;
  font-family:-apple-system,BlinkMacSystemFont,system-ui,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif;
  font-size:13px;
  color:#e8eaed;
  user-select:none;
  -webkit-tap-highlight-color:transparent;
}

/* ═══ 아이콘 모드 (기본) ═══ */
.picky-tool.scale-icon{
  width:48px;height:48px;
  background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);
  border-radius:50%;
  box-shadow:0 6px 20px rgba(59,130,246,0.45), 0 2px 6px rgba(0,0,0,0.3);
  display:flex;align-items:center;justify-content:center;
  cursor:grab;
  transition:transform 0.15s ease, box-shadow 0.15s ease;
}
.picky-tool.scale-icon:hover{
  transform:scale(1.08);
  box-shadow:0 8px 24px rgba(59,130,246,0.6), 0 3px 8px rgba(0,0,0,0.35);
}
.picky-tool.scale-icon:active{ cursor:grabbing; }
.picky-tool.scale-icon .picky-icon-body{
  width:24px;height:24px;color:#fff;display:flex;align-items:center;justify-content:center;
}
.picky-tool.scale-icon .picky-icon-body svg{ width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2; }
.picky-tool.scale-icon .picky-panel-body{display:none;}

/* ═══ 패널 모드 ═══ */
.picky-tool.scale-full{
  width:360px;
  max-height:520px;
  background:rgba(28,30,38,0.97);
  border:1px solid rgba(255,255,255,0.12);
  border-radius:14px;
  box-shadow:0 20px 60px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.3);
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  display:flex;flex-direction:column;overflow:hidden;
}
.picky-tool.scale-full .picky-icon-body{display:none;}

/* 헤더 */
.picky-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 12px;
  border-bottom:1px solid rgba(255,255,255,0.08);
  cursor:grab;
  background:rgba(255,255,255,0.02);
}
.picky-head:active{cursor:grabbing;}
.picky-head-title{font-size:13px;font-weight:600;color:#e8eaed;display:flex;align-items:center;gap:6px;}
.picky-head-title .picky-dot{width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;}
.picky-head-actions{display:flex;gap:4px;}
.picky-icon-button{
  width:28px;height:28px;
  background:transparent;border:none;border-radius:6px;
  color:#a0a3a8;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:background 0.12s, color 0.12s;
}
.picky-icon-button:hover{background:rgba(255,255,255,0.08);color:#e8eaed;}
.picky-icon-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;}

/* 본문 */
.picky-body{padding:10px 12px;overflow-y:auto;flex:1;}
.picky-section{margin-bottom:10px;}
.picky-section-title{
  font-size:11px;text-transform:uppercase;letter-spacing:0.06em;
  color:#a0a3a8;margin-bottom:6px;font-weight:600;
}

/* 선택자 표시줄 */
.picky-selector-display{
  display:flex;gap:6px;align-items:center;
  padding:7px 9px;
  background:#11131a;
  border:1px solid rgba(255,255,255,0.1);
  border-radius:8px;
  font-family:Consolas,Menlo,monospace;font-size:12px;color:#cbd5e1;
  word-break:break-all;
  min-height:32px;
}
.picky-selector-display.empty{color:#6b7280;font-family:inherit;font-style:italic;}
.picky-match-badge{
  margin-left:auto;flex-shrink:0;
  background:rgba(59,130,246,0.18);color:#93c5fd;
  border-radius:10px;padding:2px 8px;font-size:11px;font-family:inherit;
}

/* 계층 슬라이더 */
.picky-slider-row{display:flex;align-items:center;gap:8px;}
.picky-slider-row input[type=range]{flex:1;accent-color:#3b82f6;}
.picky-slider-label{font-size:11px;color:#a0a3a8;min-width:38px;text-align:right;}

/* 후보 카드 컨테이너 (3개 보임 + 스크롤) */
.picky-candidate-list{
  max-height:240px;
  overflow-y:auto;
  scroll-snap-type:y proximity;
  padding-right:4px;
  margin:0;
  display:flex;flex-direction:column;gap:6px;
}
.picky-candidate-list::-webkit-scrollbar{width:6px;}
.picky-candidate-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px;}
.picky-candidate-list::-webkit-scrollbar-track{background:transparent;}

.picky-candidate-card{
  scroll-snap-align:start;
  background:#23262f;
  border:1px solid rgba(255,255,255,0.08);
  border-radius:10px;
  padding:8px 10px;
  cursor:pointer;
  transition:background 0.12s, border-color 0.12s, transform 0.12s;
  display:flex;flex-direction:column;gap:5px;
}
.picky-candidate-card:hover{background:#2a2e38;border-color:rgba(59,130,246,0.4);}
.picky-candidate-card.selected{background:rgba(59,130,246,0.12);border-color:#3b82f6;}
.picky-candidate-card.recommended{border-color:#10b981;}
.picky-candidate-card.recommended::before{
  content:'⭐ 추천';float:right;font-size:10px;color:#10b981;font-weight:600;
}
.picky-candidate-card.network-card{border-color:rgba(245,158,11,0.4);}

.picky-card-head{display:flex;align-items:center;gap:6px;font-size:12px;}
.picky-card-icon{font-size:14px;}
.picky-card-label{font-weight:600;color:#e8eaed;}
.picky-card-stars{margin-left:auto;color:#fbbf24;font-size:11px;letter-spacing:1px;}
.picky-card-meta{font-size:10px;color:#a0a3a8;}
.picky-card-selector{
  font-family:Consolas,Menlo,monospace;font-size:11px;
  color:#cbd5e1;background:#11131a;
  padding:5px 7px;border-radius:6px;word-break:break-all;
  max-height:48px;overflow:hidden;
}
.picky-card-filter{
  font-family:Consolas,Menlo,monospace;font-size:11px;
  color:#fbbf24;background:rgba(245,158,11,0.08);
  padding:5px 7px;border-radius:6px;word-break:break-all;
}
.picky-card-hint{font-size:10px;color:#9ca3af;font-style:italic;}
.picky-card-actions{display:flex;gap:5px;flex-wrap:wrap;}
.picky-card-btn{
  flex:1;min-width:0;
  background:#2a2d36;border:1px solid rgba(255,255,255,0.12);
  color:#e8eaed;border-radius:6px;
  padding:5px 8px;font-size:11px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:3px;
  transition:background 0.1s;
}
.picky-card-btn:hover{background:#3a3d46;}
.picky-card-btn.block{background:#dc2626;border-color:#dc2626;color:#fff;}
.picky-card-btn.block:hover{background:#b91c1c;}
.picky-card-btn:disabled{opacity:0.4;cursor:not-allowed;}

/* 빈 상태 */
.picky-empty{
  text-align:center;padding:24px 12px;color:#6b7280;font-size:12px;
}
.picky-empty strong{display:block;color:#a0a3a8;margin-bottom:4px;}

/* 풋터 액션 */
.picky-foot{
  padding:8px 12px;
  border-top:1px solid rgba(255,255,255,0.08);
  display:flex;gap:6px;flex-wrap:wrap;
  background:rgba(255,255,255,0.02);
}
.picky-foot button{
  background:#2a2d36;border:1px solid rgba(255,255,255,0.12);
  color:#e8eaed;border-radius:6px;padding:6px 10px;
  font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;
}
.picky-foot button:hover{background:#3a3d46;}
.picky-foot button.primary{background:#3b82f6;border-color:#3b82f6;color:#fff;}
.picky-foot button.primary:hover{background:#2563eb;}

/* 토스트 */
.picky-toast{
  position:absolute;left:50%;bottom:12px;transform:translateX(-50%);
  background:rgba(16,185,129,0.95);color:#fff;
  padding:6px 12px;border-radius:18px;font-size:12px;
  pointer-events:none;opacity:0;transition:opacity 0.18s;
  white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.3);
}
.picky-toast.show{opacity:1;}
.picky-toast.error{background:rgba(220,38,38,0.95);}
`;

/*** 페이지(라이트) CSS — Shadow 바깥 ***/
const PAGE_CSS = `
.${HL_CLASS}{
  outline:3px solid #3b82f6 !important;
  background:rgba(59,130,246,0.12) !important;
  transition:outline-color 0.15s, background 0.15s !important;
}
.picky-hl-preview{
  outline:3px dashed #f59e0b !important;
  background:rgba(245,158,11,0.18) !important;
  outline-offset:2px !important;
  transition:outline 0.12s, background 0.12s !important;
}
.picky-hl-preview-multi{
  outline:2px dashed #f59e0b !important;
  background:rgba(245,158,11,0.08) !important;
  outline-offset:1px !important;
}
.picky-hl-ad-candidate{
  outline:2px dotted #10b981 !important;
  background:rgba(16,185,129,0.08) !important;
}
.picky-hl-ad-selected{
  outline:3px solid #10b981 !important;
  background:rgba(16,185,129,0.18) !important;
}
`;
function injectPageCss(){
  if(document.getElementById('picky-page-css')) return;
  const s = document.createElement('style');
  s.id = 'picky-page-css';
  s.textContent = PAGE_CSS;
  (document.head || document.documentElement).appendChild(s);
}
// === Part 3 ends — Part 4 will continue inside the same IIFE ===

/*** Inspector 클래스 메서드 추가 (중반부) ***/
Object.assign(Inspector.prototype, {

  /* ─ render: scale에 따라 UI 다시 그림 ─ */
  render(){
    if(!this.dom.tool) return;
    const tool = this.dom.tool;
    tool.className = 'picky-tool scale-' + this.state.scale;

    if(this.state.scale === 'icon'){
      tool.innerHTML = `
        <div class="picky-icon-body" title="Picky Advanced (드래그=이동, 클릭=열기, 길게 누르기=광고 자동 탐지)">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16" y1="16" x2="21" y2="21"/></svg>
        </div>`;
      const body = tool.querySelector('.picky-icon-body');
      this.attachDragHandlers(tool, 'icon');
      tool.addEventListener('click', (e)=>{
        if(this.state.isDragging || this.state.dragDidMove) return;
        this.cycleSize();
      });
    } else {
      tool.innerHTML = this.getFullLayout();
      this.attachRefs();
      this.attachDragHandlers(this.dom.tool.querySelector('.picky-head'), 'panel');
      this.bindPanelEvents();
      this.refreshMetrics();
    }
  },

  /* ─ 전체 패널 레이아웃 ─ */
  getFullLayout(){
    return `
      <div class="picky-head" data-drag="1">
        <div class="picky-head-title">
          <span class="picky-dot"></span>
          <span>Picky Advanced</span>
        </div>
        <div class="picky-head-actions">
          <button class="picky-icon-button" data-act="startPick" title="요소 선택 (클릭)">
            <svg viewBox="0 0 24 24"><path d="M3 3l7 18 2-8 8-2z"/></svg>
          </button>
          <button class="picky-icon-button" data-act="suggestAds" title="광고 자동 탐지">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.4 5 5.6.8-4 4 1 5.6L12 14.8 6.9 17.4l1-5.6-4-4L9.6 7z"/></svg>
          </button>
          <button class="picky-icon-button" data-act="showRules" title="차단 규칙 관리">
            <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
          </button>
          <button class="picky-icon-button" data-act="settings" title="설정">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.4-1.9l-.1-.1A2 2 0 1 1 6.9 4.3l.1.1a1.7 1.7 0 0 0 1.9.4H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
          </button>
          <button class="picky-icon-button" data-act="cycleSize" title="축소">
            <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>
          </button>
          <button class="picky-icon-button" data-act="terminate" title="종료">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
          </button>
        </div>
      </div>
      <div class="picky-body">
        <div class="picky-section">
          <div class="picky-section-title">선택된 요소</div>
          <div class="picky-selector-display empty" id="picky-disp">아직 선택된 요소가 없습니다</div>
        </div>
        <div class="picky-section" id="picky-hierarchy-section" style="display:none;">
          <div class="picky-section-title">계층 탐색</div>
          <div class="picky-slider-row">
            <input type="range" id="picky-slider" min="0" max="0" value="0" data-no-drag>
            <span class="picky-slider-label" id="picky-slider-label">0 / 0</span>
          </div>
        </div>
        <div class="picky-section">
          <div class="picky-section-title">셀렉터 후보 <span id="picky-cand-count" style="color:#6b7280;font-weight:400;"></span></div>
          <div class="picky-candidate-list" id="picky-cards" data-no-drag>
            <div class="picky-empty">
              <strong>아직 후보가 없습니다</strong>
              <span>좌측 상단 ▶ 버튼으로 요소를 선택하거나, 별 모양으로 광고를 자동 탐지하세요</span>
            </div>
          </div>
        </div>
      </div>
      <div class="picky-foot">
        <button data-act="editSelector" title="셀렉터 직접 편집">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          편집
        </button>
        <button data-act="toggleEnabled" id="picky-toggle-enabled" title="차단 ON/OFF">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>
          차단 ON
        </button>
        <button data-act="copyAdGuard" title="모든 규칙 AdGuard 형식으로 복사">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          AdGuard 복사
        </button>
      </div>
      <div class="picky-toast" id="picky-toast"></div>
    `;
  },

  attachRefs(){
    const s = this.dom.shadow;
    this.dom.disp        = s.getElementById('picky-disp');
    this.dom.slider      = s.getElementById('picky-slider');
    this.dom.sliderLabel = s.getElementById('picky-slider-label');
    this.dom.cardsScroll = s.getElementById('picky-cards');
    this.dom.candCount   = s.getElementById('picky-cand-count');
    this.dom.hierarchySection = s.getElementById('picky-hierarchy-section');
    this.dom.toast       = s.getElementById('picky-toast');
    this.dom.toggleEnabled = s.getElementById('picky-toggle-enabled');
  },

  bindPanelEvents(){
    const s = this.dom.shadow;
    // 헤더/풋터 액션 버튼
    s.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        this.triggerAction(btn.dataset.act);
      });
    });
    // 계층 슬라이더
    if(this.dom.slider){
      this.dom.slider.addEventListener('input', (e)=>{
        this.handleSlide(parseInt(e.target.value, 10));
      });
    }
  },

  /* ─ 후보 카드 렌더링 ─ */
  renderCandidates(){
    const container = this.dom.cardsScroll;
    if(!container) return;
    const list = this.state.candidates;
    if(this.dom.candCount){
      this.dom.candCount.textContent = list.length ? `(${list.length}개)` : '';
    }
    if(!list.length){
      container.innerHTML = `
        <div class="picky-empty">
          <strong>아직 후보가 없습니다</strong>
          <span>요소를 선택하면 셀렉터 후보가 표시됩니다</span>
        </div>`;
      return;
    }
    container.innerHTML = list.map((c,i) => this.renderCard(c,i)).join('');

    // 카드 클릭/호버
    container.querySelectorAll('.picky-candidate-card').forEach(card => {
      const idx = parseInt(card.dataset.idx, 10);
      card.addEventListener('mouseenter', ()=> this.previewCandidate(idx));
      card.addEventListener('mouseleave', ()=> this.clearPreview());
      card.addEventListener('click', (e)=>{
        if(e.target.closest('.picky-card-btn')) return;
        this.selectCandidate(idx);
      });
    });
    // 카드 버튼 액션
    container.querySelectorAll('.picky-card-btn').forEach(btn => {
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const card = btn.closest('.picky-candidate-card');
        const idx = parseInt(card.dataset.idx, 10);
        this.handleCardAction(btn.dataset.cardAct, idx);
      });
    });
  },

  renderCard(c, i){
    const recommended = c.recommended ? ' recommended' : '';
    const network     = c.isNetwork   ? ' network-card' : '';
    const selected    = (i === this.state.selectedIdx) ? ' selected' : '';
    const filterStr   = SelectorStrategies.toAdGuardRule(c, location.hostname);
    const selectorBlock = c.selector
      ? `<div class="picky-card-selector">${this.escapeHtml(c.selector)}</div>` : '';
    const filterBlock = filterStr
      ? `<div class="picky-card-filter">${this.escapeHtml(filterStr)}</div>` : '';

    const blockBtn = c.isNetwork
      ? `<button class="picky-card-btn" disabled title="네트워크 규칙은 AdGuard에서만 차단 가능">⛔ 차단</button>`
      : `<button class="picky-card-btn block" data-card-act="block" title="이 셀렉터를 영구 차단 (CSS)">⛔ 차단</button>`;
    const copyFilterBtn = filterStr
      ? `<button class="picky-card-btn" data-card-act="copyFilter" title="AdGuard/uBlock 필터 복사">📋 필터</button>` : '';
    const copyCssBtn = c.selector
      ? `<button class="picky-card-btn" data-card-act="copyCss" title="CSS 셀렉터 복사">📋 CSS</button>` : '';

    return `
      <div class="picky-candidate-card${recommended}${network}${selected}" data-idx="${i}">
        <div class="picky-card-head">
          <span class="picky-card-icon">${c.icon || '•'}</span>
          <span class="picky-card-label">${this.escapeHtml(c.label || c.type)}</span>
          <span class="picky-card-stars">${c.stars || ''}</span>
        </div>
        <div class="picky-card-meta">매칭 ${c.matchCount || 0}개 · 점수 ${c.score || 0}${c.hint ? ' · ' + this.escapeHtml(c.hint) : ''}</div>
        ${selectorBlock}
        ${filterBlock}
        <div class="picky-card-actions">
          ${blockBtn}
          ${copyFilterBtn}
          ${copyCssBtn}
        </div>
      </div>`;
  },

  escapeHtml(str){
    if(str == null) return '';
    return String(str).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  },

  /* ─ 카드 액션 처리 ─ */
  async handleCardAction(act, idx){
    const c = this.state.candidates[idx];
    if(!c) return;
    switch(act){
      case 'block':
        if(c.isNetwork){ this.flashToast('네트워크 규칙은 AdGuard 가져오기가 필요합니다', true); return; }
        if(!c.selector){ this.flashToast('셀렉터가 비어있습니다', true); return; }
        if(Blocker.append(c.selector)){
          this.flashToast(`차단됨: ${c.selector.slice(0,40)}`);
          this.refreshMetrics();
          if(this.state.autoDismiss){ setTimeout(()=> this.cycleSize(), 400); }
        } else {
          this.flashToast('이미 존재하거나 차단 불가', true);
        }
        break;
      case 'copyFilter': {
        const txt = SelectorStrategies.toAdGuardRule(c, location.hostname);
        if(!txt){ this.flashToast('필터가 비어있습니다', true); return; }
        await this.copyText(txt);
        this.flashToast('필터 복사됨');
        break;
      }
      case 'copyCss':
        if(!c.selector){ this.flashToast('CSS가 비어있습니다', true); return; }
        await this.copyText(c.selector);
        this.flashToast('CSS 복사됨');
        break;
    }
  },

  async copyText(txt){
    try{
      await navigator.clipboard.writeText(txt);
    }catch(e){
      // fallback
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      try{ document.execCommand('copy'); }catch(_){}
      ta.remove();
    }
  },

  flashToast(msg, isError=false){
    if(!this.dom.toast) return;
    this.dom.toast.textContent = msg;
    this.dom.toast.className = 'picky-toast show' + (isError ? ' error' : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(()=>{
      if(this.dom.toast) this.dom.toast.className = 'picky-toast';
    }, 1600);
  },

  /* ─ 카드 호버 미리보기 ─ */
  previewCandidate(idx){
    this.clearPreview();
    const c = this.state.candidates[idx];
    if(!c || !c.selector) return;
    let nodes;
    try{ nodes = document.querySelectorAll(c.selector); }
    catch(e){ return; }
    if(!nodes.length) return;
    nodes.forEach((n, i)=>{
      if(i === 0) n.classList.add('picky-hl-preview');
      else        n.classList.add('picky-hl-preview-multi');
    });
    this.state.previewNodes = Array.from(nodes);
    // 첫 매치가 뷰포트 밖이면 스크롤
    if(nodes[0] && nodes[0].scrollIntoView){
      const rect = nodes[0].getBoundingClientRect();
      const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
      if(offscreen){
        try{ nodes[0].scrollIntoView({behavior:'smooth', block:'center'}); }catch(_){}
      }
    }
  },

  clearPreview(){
    if(this.state.previewNodes && this.state.previewNodes.length){
      this.state.previewNodes.forEach(n => {
        n.classList.remove('picky-hl-preview');
        n.classList.remove('picky-hl-preview-multi');
      });
    }
    this.state.previewNodes = [];
  },

  /* ─ 카드 선택 (클릭) ─ */
  selectCandidate(idx){
    if(idx < 0 || idx >= this.state.candidates.length) return;
    this.state.selectedIdx = idx;
    const c = this.state.candidates[idx];
    // 선택자 표시줄 갱신
    if(this.dom.disp){
      const txt = c.isNetwork ? c.filter : c.selector;
      this.dom.disp.textContent = txt || '(빈 셀렉터)';
      this.dom.disp.classList.toggle('empty', !txt);
      // 매칭 개수 배지
      const old = this.dom.disp.querySelector('.picky-match-badge');
      if(old) old.remove();
      if(!c.isNetwork && c.selector){
        const badge = document.createElement('span');
        badge.className = 'picky-match-badge';
        badge.textContent = `매칭 ${c.matchCount}개`;
        this.dom.disp.appendChild(badge);
      }
    }
    // 카드 selected 클래스 갱신
    if(this.dom.cardsScroll){
      this.dom.cardsScroll.querySelectorAll('.picky-candidate-card').forEach((el,i)=>{
        el.classList.toggle('selected', i === idx);
      });
      const card = this.dom.cardsScroll.querySelector(`[data-idx="${idx}"]`);
      if(card && card.scrollIntoView){
        try{ card.scrollIntoView({block:'nearest', behavior:'smooth'}); }catch(_){}
      }
    }
  },

  refreshMetrics(){
    if(!this.dom.toggleEnabled) return;
    const enabled = GM_getValue('picky_blocking_enabled', true);
    this.dom.toggleEnabled.innerHTML = enabled
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg> 차단 ON`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg> 차단 OFF`;
  },

  /* ─ 계층 슬라이더 ─ */
  calcHierarchyLimits(el){
    const chain = [];
    let cur = el;
    while(cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML'){
      chain.push(cur);
      cur = cur.parentElement;
    }
    return chain;
  },
  handleSlide(idx){
    const chain = this.state.hierarchy;
    if(!chain || !chain.length) return;
    idx = Math.max(0, Math.min(idx, chain.length - 1));
    const newTarget = chain[idx];
    if(!newTarget) return;
    if(this.dom.sliderLabel){
      this.dom.sliderLabel.textContent = `${idx + 1} / ${chain.length}`;
    }
    this.selectNode(newTarget, false); // origin은 유지
  },

  /* ─ 노드 선택 (전체 흐름의 핵심) ─ */
  selectNode(el, updateOrigin=true){
    if(!el || !el.tagName) return;
    // picky 자체 요소는 무시
    if(el.closest && el.closest('#'+ROOT_ID)) return;

    this.state.target = el;
    if(updateOrigin){
      this.state.originTarget = el;
      this.state.hierarchy = this.calcHierarchyLimits(el);
      if(this.dom.slider){
        this.dom.slider.max = Math.max(0, this.state.hierarchy.length - 1);
        this.dom.slider.value = 0;
      }
      if(this.dom.sliderLabel){
        this.dom.sliderLabel.textContent = `1 / ${this.state.hierarchy.length}`;
      }
      if(this.dom.hierarchySection){
        this.dom.hierarchySection.style.display = this.state.hierarchy.length > 1 ? 'block' : 'none';
      }
    }
    this.setFocus(el);

    // 후보 생성
    const list = SelectorStrategies.buildAll(el, this._preciseEvaluator);
    this.state.candidates = list;
    this.state.selectedIdx = list.length ? 0 : -1;
    this.renderCandidates();
    if(list.length){ this.selectCandidate(0); }
    else if(this.dom.disp){
      this.dom.disp.textContent = '셀렉터를 생성할 수 없습니다';
      this.dom.disp.classList.add('empty');
    }
  },

  setFocus(el){
    this.dropFocus();
    if(!el || !el.classList) return;
    el.classList.add(HL_CLASS);
    this._focusedNode = el;
  },
  dropFocus(){
    if(this._focusedNode && this._focusedNode.classList){
      this._focusedNode.classList.remove(HL_CLASS);
    }
    this._focusedNode = null;
  },

  /* ─ Picking 모드 ─ */
  startPicking(){
    if(this.state.mode === 'picking') return;
    this.state.mode = 'picking';
    document.body.style.cursor = 'crosshair';
    this.flashToast('요소 위에서 클릭하세요 (ESC 취소)');
    this._pickHoverHandler = (e)=>{
      const t = e.target;
      if(!t || (t.closest && t.closest('#'+ROOT_ID))) return;
      // 임시 outline
      if(this._lastHover && this._lastHover.classList){
        this._lastHover.classList.remove('picky-hl-preview');
      }
      if(t.classList){
        t.classList.add('picky-hl-preview');
        this._lastHover = t;
      }
    };
    this._pickClickHandler = (e)=> this.onPickClick(e);
    document.addEventListener('mousemove', this._pickHoverHandler, true);
    document.addEventListener('click', this._pickClickHandler, true);
  },
  stopPicking(){
    if(this.state.mode !== 'picking'){
      // 아무 상태가 아니더라도 핸들러는 정리
    }
    this.state.mode = 'inspecting';
    document.body.style.cursor = '';
    if(this._lastHover && this._lastHover.classList){
      this._lastHover.classList.remove('picky-hl-preview');
    }
    this._lastHover = null;
    if(this._pickHoverHandler) document.removeEventListener('mousemove', this._pickHoverHandler, true);
    if(this._pickClickHandler) document.removeEventListener('click', this._pickClickHandler, true);
    this._pickHoverHandler = this._pickClickHandler = null;
  },
  onPickClick(e){
    const t = e.target;
    if(!t) return;
    if(t.closest && t.closest('#'+ROOT_ID)) return; // Picky 자체 클릭 무시
    e.preventDefault();
    e.stopPropagation();
    this.stopPicking();
    this.selectNode(t, true);
    // 패널이 닫혀있으면 열기
    if(this.state.scale === 'icon'){
      this.cycleSize();
    }
  }

});
// === Part 4 ends — Part 5 will continue inside the same IIFE ===

/*** Inspector 클래스 메서드 추가 (후반부) ***/
Object.assign(Inspector.prototype, {

  /* ─ 액션 디스패처 ─ */
  triggerAction(act){
    switch(act){
      case 'startPick':     this.startPicking(); break;
      case 'suggestAds':    this.suggestAds(); break;
      case 'showRules':     this.showRules(); break;
      case 'settings':      this.showSettings(); break;
      case 'cycleSize':     this.cycleSize(); break;
      case 'terminate':     this.terminate(); break;
      case 'editSelector':  this.editSelector(); break;
      case 'toggleEnabled': {
        const now = Blocker.toggleEnabled();
        this.refreshMetrics();
        this.flashToast(now ? '차단 ON' : '차단 OFF');
        break;
      }
      case 'copyAdGuard':   Blocker.exportAdGuard(); break;
    }
  },

  /* ─ 셀렉터 직접 편집 ─ */
  editSelector(){
    const c = this.state.candidates[this.state.selectedIdx];
    const initial = c ? (c.selector || c.filter || '') : '';
    const modal = new Modal('셀렉터 직접 편집', `
      <p style="margin:0 0 8px;color:#a0a3a8;font-size:12px;">
        CSS 셀렉터 또는 AdGuard 필터(<code>example.com##.ad</code>, <code>||ads.example.com^</code>)를 입력하세요.<br>
        입력 즉시 매칭 개수가 표시됩니다.
      </p>
      <textarea id="picky-edit-input" rows="3" style="font-family:Consolas,monospace;">${this.escapeHtml(initial)}</textarea>
      <div id="picky-edit-status" style="margin-top:8px;font-size:12px;color:#a0a3a8;">대기 중…</div>
    `, {
      width: '500px',
      buttons: `
        <button data-act="close">취소</button>
        <button class="primary" data-edit-act="apply">차단으로 추가</button>
        <button data-edit-act="copy">복사</button>
      `
    }).open();

    const body = modal.body();
    const input = body.querySelector('#picky-edit-input');
    const status = body.querySelector('#picky-edit-status');

    const update = ()=>{
      const v = input.value.trim();
      if(!v){ status.textContent = '비어있음'; status.style.color = '#a0a3a8'; return; }
      // AdGuard 네트워크 규칙
      if(v.startsWith('||') || v.startsWith('@@')){
        status.textContent = '네트워크 필터(AdGuard) — 페이지 차단은 AdGuard 가져오기 필요';
        status.style.color = '#f59e0b';
        return;
      }
      // host##selector 형태
      let pure = v;
      const m = v.match(/^([^#]*?)##(.+)$/);
      if(m) pure = m[2];
      try{
        const n = document.querySelectorAll(pure).length;
        status.textContent = `매칭 ${n}개`;
        status.style.color = n ? '#10b981' : '#dc2626';
      }catch(e){
        status.textContent = '문법 오류: ' + e.message;
        status.style.color = '#dc2626';
      }
    };
    input.addEventListener('input', update);
    update();
    setTimeout(()=> input.focus(), 50);

    modal.on('[data-edit-act]', 'click', async (e)=>{
      const act = e.currentTarget.dataset.editAct;
      const v = input.value.trim();
      if(!v) return;
      if(act === 'copy'){
        await this.copyText(v);
        this.flashToast('복사됨');
        return;
      }
      if(act === 'apply'){
        if(v.startsWith('||') || v.startsWith('@@')){
          this.flashToast('네트워크 규칙은 AdGuard에서만 적용됩니다', true);
          return;
        }
        const m = v.match(/^([^#]*?)##(.+)$/);
        const pure = m ? m[2] : v;
        if(Blocker.append(pure)){
          this.flashToast('차단 규칙으로 추가됨');
          modal.close();
        } else {
          this.flashToast('이미 존재하거나 차단 불가', true);
        }
      }
    });
  },

  /* ─ 광고 자동 탐지 (롱프레스 또는 ⭐ 버튼) ─ */
  suggestAds(){
    const candidates = this._scanAdCandidates();
    if(!candidates.length){
      const m = new Modal('광고 자동 탐지', `
        <div style="padding:12px;text-align:center;color:#a0a3a8;">
          광고로 의심되는 요소를 찾지 못했습니다.<br>
          <small>(IAB 표준 크기·광고 호스트·광고 키워드 기반 탐색)</small>
        </div>
      `, {buttons:`<button data-act="close">닫기</button>`}).open();
      return;
    }

    // 후보 시각화
    candidates.forEach(({el}) => el.classList.add('picky-hl-ad-candidate'));
    this.state.adSelectedNodes = [];

    const rows = candidates.map((c,i) => `
      <div class="picky-ad-suggest-item" data-ad-idx="${i}">
        <input type="checkbox" data-ad-check="${i}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:#e8eaed;font-size:12px;">
            ${c.icon} ${this.escapeHtml(c.reason)} <span style="color:#fbbf24;font-size:11px;">${c.stars}</span>
          </div>
          <div style="font-family:Consolas,monospace;font-size:11px;color:#cbd5e1;background:#11131a;padding:4px 6px;border-radius:4px;margin-top:3px;word-break:break-all;">
            ${this.escapeHtml(c.selector)}
          </div>
          <div style="font-size:10px;color:#9ca3af;margin-top:2px;">매칭 ${c.matchCount}개 · 점수 ${c.score}</div>
        </div>
      </div>
    `).join('');

    const modal = new Modal(`광고 자동 탐지 (${candidates.length}개 발견)`, `
      <div style="margin-bottom:8px;display:flex;gap:6px;">
        <button data-ad-act="selectAll" style="background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">전체 선택</button>
        <button data-ad-act="selectNone" style="background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;">전체 해제</button>
      </div>
      <div style="max-height:360px;overflow-y:auto;">${rows}</div>
    `, {
      width: '560px',
      onClose: ()=>{
        candidates.forEach(({el}) => {
          el.classList.remove('picky-hl-ad-candidate');
          el.classList.remove('picky-hl-ad-selected');
        });
        this.state.adSelectedNodes = [];
      },
      buttons: `
        <button data-act="close">취소</button>
        <button class="primary" data-ad-act="blockSelected">선택 항목 차단</button>
      `
    }).open();

    const body = modal.body();
    // 항목 호버: 페이지 강조
    body.querySelectorAll('.picky-ad-suggest-item').forEach(row => {
      const idx = parseInt(row.dataset.adIdx, 10);
      row.addEventListener('mouseenter', ()=>{
        this.clearPreview();
        try{
          const nodes = document.querySelectorAll(candidates[idx].selector);
          nodes.forEach((n,i)=>{
            if(i===0) n.classList.add('picky-hl-preview');
            else n.classList.add('picky-hl-preview-multi');
          });
          this.state.previewNodes = Array.from(nodes);
          if(nodes[0]){ try{ nodes[0].scrollIntoView({behavior:'smooth',block:'center'}); }catch(_){} }
        }catch(_){}
      });
      row.addEventListener('mouseleave', ()=> this.clearPreview());
    });
    // 체크박스 상태 → 녹색 강조
    body.querySelectorAll('[data-ad-check]').forEach(cb => {
      cb.addEventListener('change', (e)=>{
        const idx = parseInt(e.target.dataset.adCheck, 10);
        const row = body.querySelector(`[data-ad-idx="${idx}"]`);
        row.classList.toggle('selected', e.target.checked);
        const el = candidates[idx].el;
        if(e.target.checked){
          el.classList.remove('picky-hl-ad-candidate');
          el.classList.add('picky-hl-ad-selected');
        } else {
          el.classList.remove('picky-hl-ad-selected');
          el.classList.add('picky-hl-ad-candidate');
        }
      });
    });

    modal.on('[data-ad-act]', 'click', (e)=>{
      const act = e.currentTarget.dataset.adAct;
      const checks = body.querySelectorAll('[data-ad-check]');
      if(act === 'selectAll'){
        checks.forEach(cb => { if(!cb.checked){ cb.checked = true; cb.dispatchEvent(new Event('change')); } });
      } else if(act === 'selectNone'){
        checks.forEach(cb => { if(cb.checked){ cb.checked = false; cb.dispatchEvent(new Event('change')); } });
      } else if(act === 'blockSelected'){
        let added = 0;
        checks.forEach(cb => {
          if(cb.checked){
            const c = candidates[parseInt(cb.dataset.adCheck, 10)];
            if(c && c.selector && Blocker.append(c.selector)) added++;
          }
        });
        modal.close();
        this.flashToast(`${added}개 규칙이 추가되었습니다`);
        this.refreshMetrics();
      }
    });
  },

  /* ─ 광고 후보 스캔 ─ */
  _scanAdCandidates(){
    const results = [];
    const seen = new Set();
    const push = (el, info) => {
      if(!el || seen.has(el)) return;
      if(el.closest && el.closest('#'+ROOT_ID)) return;
      const list = SelectorStrategies.buildAll(el, this._preciseEvaluator);
      if(!list.length) return;
      const best = list[0];
      seen.add(el);
      results.push({
        el,
        selector: best.selector || best.filter,
        matchCount: best.matchCount || 0,
        score: best.score || 0,
        stars: best.stars || '',
        icon: info.icon,
        reason: info.reason
      });
    };

    // 1) IAB 표준 크기 이미지
    document.querySelectorAll('img').forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if(STD_AD_SIZES.some(([sw,sh]) => Math.abs(sw-w)<=2 && Math.abs(sh-h)<=2)){
        push(img, {icon:'📐', reason:`IAB 표준 크기 ${w}×${h}`});
      }
    });
    // 2) 광고 호스트 리소스
    document.querySelectorAll('img,iframe,script').forEach(node => {
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if(!src) return;
      const host = AD_NETWORK_HOSTS.find(h => src.includes(h));
      if(host) push(node, {icon:'🌐', reason:`광고 호스트: ${host}`});
    });
    // 3) 광고 키워드 클래스/ID
    const adRe = /(^|[-_])(ad|ads|advert|banner|promo|sponsor)([-_]|$)/i;
    document.querySelectorAll('[id],[class]').forEach(el => {
      if(el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
      const id = el.id || '';
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      if(adRe.test(id) || adRe.test(cls)){
        push(el, {icon:'🎨', reason:`광고 키워드: ${id || cls.split(/\s+/).find(c=>adRe.test(c)) || ''}`.slice(0,60)});
      }
    });
    // 4) ARIA 광고
    document.querySelectorAll('[aria-label],[role]').forEach(el => {
      const aria = el.getAttribute('aria-label') || '';
      const role = el.getAttribute('role') || '';
      if(ARIA_AD_KEYWORDS.some(k => aria.toLowerCase().includes(k.toLowerCase())) ||
         /banner|advertisement/i.test(role)){
        push(el, {icon:'♿', reason:`ARIA: ${aria || role}`.slice(0,60)});
      }
    });

    // 점수 내림차순, 최대 20개
    results.sort((a,b) => b.score - a.score);
    return results.slice(0, 20);
  },

  /* ─ 차단 규칙 관리 모달 ─ */
  showRules(){
    const all = Blocker.fetchAll();
    const host = location.hostname;
    const hostRules = all[host] || [];
    const stats = Blocker.getStats();

    const ruleRows = hostRules.length
      ? hostRules.map((rule,i)=>`
          <div style="display:flex;gap:6px;align-items:center;padding:6px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;margin-bottom:4px;" data-rule-idx="${i}">
            <code style="flex:1;min-width:0;font-size:11px;color:#cbd5e1;background:#11131a;padding:4px 6px;border-radius:4px;word-break:break-all;">${this.escapeHtml(rule)}</code>
            <button data-rule-act="preview" data-rule="${this.escapeHtml(rule)}" style="background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;">👁</button>
            <button data-rule-act="delete" data-rule="${this.escapeHtml(rule)}" style="background:#dc2626;color:#fff;border:none;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;">삭제</button>
          </div>`).join('')
      : `<div style="text-align:center;padding:20px;color:#a0a3a8;">이 사이트에 저장된 규칙이 없습니다</div>`;

    const modal = new Modal(`차단 규칙 (${host})`, `
      <div style="display:flex;gap:10px;margin-bottom:12px;font-size:12px;color:#a0a3a8;">
        <span>현재 사이트: <strong style="color:#e8eaed;">${stats.ruleCount}개</strong></span>
        <span>숨겨진 요소: <strong style="color:#e8eaed;">${stats.hiddenCount}개</strong></span>
        <span>전체 사이트: <strong style="color:#e8eaed;">${stats.totalSites}개</strong></span>
        <span>전체 규칙: <strong style="color:#e8eaed;">${stats.totalRules}개</strong></span>
      </div>
      <div style="max-height:340px;overflow-y:auto;">${ruleRows}</div>
    `, {
      width: '600px',
      onClose: ()=> this.clearPreview(),
      buttons: `
        <button data-rule-act="undo">↶ 마지막 차단 취소</button>
        <button data-rule-act="exportJson">JSON 내보내기</button>
        <button data-rule-act="exportAdGuard">AdGuard 복사</button>
        <button data-rule-act="import">가져오기</button>
        <button class="danger" data-rule-act="clearSite">이 사이트 초기화</button>
        <button data-act="close">닫기</button>
      `
    }).open();

    const body = modal.body();
    body.querySelectorAll('[data-rule-act="preview"]').forEach(btn => {
      btn.addEventListener('mouseenter', (e)=>{
        const rule = e.currentTarget.dataset.rule;
        this.clearPreview();
        try{
          const nodes = document.querySelectorAll(rule);
          nodes.forEach((n,i)=>{
            if(i===0) n.classList.add('picky-hl-preview');
            else n.classList.add('picky-hl-preview-multi');
          });
          this.state.previewNodes = Array.from(nodes);
        }catch(_){}
      });
      btn.addEventListener('mouseleave', ()=> this.clearPreview());
    });
    body.querySelectorAll('[data-rule-act="delete"]').forEach(btn => {
      btn.addEventListener('click', (e)=>{
        const rule = e.currentTarget.dataset.rule;
        if(Blocker.drop(rule)){
          modal.close();
          this.showRules();
        }
      });
    });
    modal.on('[data-rule-act]', 'click', (e)=>{
      const act = e.currentTarget.dataset.ruleAct;
      switch(act){
        case 'undo': {
          const last = Blocker.undoLast();
          modal.close();
          if(last) this.flashToast(`복구됨: ${last.selector.slice(0,40)}`);
          else this.flashToast('취소할 차단이 없습니다', true);
          this.showRules();
          break;
        }
        case 'exportJson':    Blocker.exportJSON(); break;
        case 'exportAdGuard': Blocker.exportAdGuard(); break;
        case 'import':        Blocker.importJSON(); break;
        case 'clearSite':     Blocker.clear(); break;
      }
    });
  },

  /* ─ 설정 모달 ─ */
  showSettings(){
    const autoClose = GM_getValue('picky_auto_close', true);
    const blocking  = GM_getValue('picky_blocking_enabled', true);
    const aggressive= GM_getValue('picky_aggressive_block', false);
    const intelligent = this.config.intelligentMode;
    const shadow    = this.config.shadowDomSupport;

    const sw = (id,label,val) => `
      <label style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;">
        <span style="color:#e8eaed;font-size:13px;">${label}</span>
        <input type="checkbox" data-setting="${id}" ${val?'checked':''} style="width:auto;">
      </label>`;

    const modal = new Modal('설정', `
      ${sw('autoClose',  '차단 후 자동으로 패널 축소', autoClose)}
      ${sw('blocking',   '차단 활성화', blocking)}
      ${sw('aggressive', '공격적 차단 (display + visibility + size)', aggressive)}
      ${sw('intelligent','지능형 선택자 모드', intelligent)}
      ${sw('shadow',     'Shadow DOM 탐색', shadow)}
      <div style="margin-top:14px;display:flex;gap:6px;flex-wrap:wrap;">
        <button data-setting-act="resetIconPos" style="background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 10px;cursor:pointer;">아이콘 위치 초기화</button>
        <button data-setting-act="resetPanelPos" style="background:#2a2d36;color:#e8eaed;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 10px;cursor:pointer;">패널 위치 초기화</button>
      </div>
    `, {
      width: '440px',
      buttons:`<button data-act="close">닫기</button>`
    }).open();

    modal.on('[data-setting]', 'change', (e)=>{
      const key = e.currentTarget.dataset.setting;
      const val = e.currentTarget.checked;
      switch(key){
        case 'autoClose':  GM_setValue('picky_auto_close', val); this.state.autoDismiss = val; break;
        case 'blocking':   GM_setValue('picky_blocking_enabled', val); Blocker.enforce(); this.refreshMetrics(); break;
        case 'aggressive': GM_setValue('picky_aggressive_block', val); Blocker.enforce(); break;
        case 'intelligent':this.config.intelligentMode = val; break;
        case 'shadow':     this.config.shadowDomSupport = val; break;
      }
    });
    modal.on('[data-setting-act]', 'click', (e)=>{
      const act = e.currentTarget.dataset.settingAct;
      if(act === 'resetIconPos'){
        this.state.iconPos = null; GM_setValue('picky_icon_pos', null);
        this.applyPosition(); this.flashToast('아이콘 위치 초기화됨');
      } else if(act === 'resetPanelPos'){
        this.state.panelPos = null; GM_setValue('picky_panel_pos', null);
        this.applyPosition(); this.flashToast('패널 위치 초기화됨');
      }
    });
  }

});

/*** 부팅 ***/
let inspector = null;
function boot(){
  if(inspector) return;
  injectPageCss();
  inspector = new Inspector();
  inspector.launch();
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot, {once:true});
} else {
  boot();
}

/*** GM 메뉴 ***/
try{
  GM_registerMenuCommand?.('Picky 열기/숨기기', ()=>{
    if(inspector){ inspector.terminate(); inspector = null; }
    else boot();
  });
  GM_registerMenuCommand?.('광고 자동 탐지', ()=>{
    if(!inspector) boot();
    inspector.suggestAds();
  });
  GM_registerMenuCommand?.('차단 규칙 관리', ()=>{
    if(!inspector) boot();
    if(inspector.state.scale === 'icon') inspector.cycleSize();
    inspector.showRules();
  });
  GM_registerMenuCommand?.('마지막 차단 취소', ()=>{
    const last = Blocker.undoLast();
    alert(last ? `복구됨: ${last.selector}` : '취소할 차단이 없습니다');
  });
  GM_registerMenuCommand?.('차단 ON/OFF', ()=>{
    const now = Blocker.toggleEnabled();
    alert('차단이 ' + (now ? 'ON' : 'OFF') + ' 되었습니다');
    if(inspector) inspector.refreshMetrics();
  });
  GM_registerMenuCommand?.('JSON 내보내기', ()=> Blocker.exportJSON());
  GM_registerMenuCommand?.('JSON 가져오기', ()=> Blocker.importJSON());
  GM_registerMenuCommand?.('uBlock 필터 복사', ()=> Blocker.exportUblock());
  GM_registerMenuCommand?.('AdGuard 필터 복사', ()=> Blocker.exportAdGuard());
  GM_registerMenuCommand?.('아이콘 위치 초기화', ()=>{
    GM_setValue('picky_icon_pos', null);
    if(inspector){ inspector.state.iconPos = null; inspector.applyPosition(); }
  });
  GM_registerMenuCommand?.('패널 위치 초기화', ()=>{
    GM_setValue('picky_panel_pos', null);
    if(inspector){ inspector.state.panelPos = null; inspector.applyPosition(); }
  });
}catch(e){ /* GM API 미지원 환경 무시 */ }

})();  // ← 전체 IIFE 종료 (파일 전체에 단 하나만 있어야 함)
