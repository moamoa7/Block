// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/hooray804/Picky
// @version      3.6.0
// @description  요소 선택 기반 광고/요소 차단기 — AdGuard/uBlock 호환 규칙 생성, 카드 리스트 UI, 이미지·네트워크·ARIA 고급 전략 지원
// @author       hooray804
// @license      MIT
// @homepage     https://github.com/hooray804/Picky
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 프레임 내부에서는 동작 안 함 (최상위 문서에서만)
    if (window.top !== window.self) return;

    // ───────────────────────────────────────────────
    // 코어 ID / 클래스 / 상수
    // ───────────────────────────────────────────────
    const TOOL_ID    = 'picky-tool-root';
    const ROOT_ID    = 'picky-shadow-host';
    const HL_CLASS   = 'picky-hl';
    const ISO_BODY   = 'picky-iso-body';
    const ISO_PATH   = 'picky-iso-path';
    const SHIELD_ID  = 'picky-shield';
    const DRAG_THRESHOLD = 6;

    // 드래그 무시 셀렉터 (UI 요소들)
    const NO_DRAG_SELECTOR = [
        'input', 'textarea', 'select', 'button', 'a',
        '[role="slider"]', '[contenteditable="true"]',
        '.picky-card', '.picky-card *', '.picky-slider',
        '.picky-modal', '.picky-modal *', '.picky-btn',
        '.picky-cards-scroll', '.picky-cards-scroll *'
    ].join(',');

    // :has() 지원 여부
    const SUPPORTS_HAS = (() => {
        try { document.querySelector(':has(*)'); return true; }
        catch (_) { return false; }
    })();

    // 안전한 HTML 이스케이프
    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // ───────────────────────────────────────────────
    // 광고 관련 상수
    // ───────────────────────────────────────────────
    const AD_NETWORK_HOSTS = [
        'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
        'adservice.google.com', 'adservice.google.co.kr', 'adsystem.com',
        'adsrvr.org', 'adnxs.com', 'taboola.com', 'outbrain.com',
        'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com',
        'openx.net', 'casalemedia.com', 'amazon-adsystem.com',
        'moatads.com', 'scorecardresearch.com', '2mdn.net',
        'adform.net', 'smartadserver.com', 'yieldmo.com',
        'mediavine.com', 'adcolony.com', 'mopub.com',
        'adnxs1.com', 'serving-sys.com', 'tapad.com',
        'bidswitch.net', 'casalemedia.com', 'contextweb.com',
        // 한국 광고망
        'dable.io', 'mediacategory.com', 'realclick.co.kr',
        'recopick.com', 'ad.naver.com', 'ader.naver.com',
        'wcs.naver.net', 'ad.daum.net', 'display.ad.daum.net'
    ];

    const IAB_AD_SIZES = [
        [728, 90], [300, 250], [336, 280], [160, 600], [300, 600],
        [970, 250], [970, 90], [320, 50], [320, 100], [468, 60],
        [234, 60], [120, 600], [125, 125], [180, 150], [240, 400],
        [250, 250], [200, 200], [300, 50], [300, 100], [580, 400]
    ];

    const AD_LINK_PATTERNS = [
        { kw: 'doubleclick',     desc: 'DoubleClick' },
        { kw: 'googlesyndication', desc: 'Google Syndication' },
        { kw: 'googleadservices', desc: 'Google Ad Services' },
        { kw: '/click?',         desc: '클릭 추적' },
        { kw: '/redirect',       desc: '리다이렉트' },
        { kw: 'utm_source=ad',   desc: 'UTM 광고' },
        { kw: 'utm_medium=cpc',  desc: 'CPC 캠페인' },
        { kw: 'adclick',         desc: '광고 클릭' },
        { kw: '//ad.',           desc: '광고 서브도메인' },
        { kw: '//ads.',          desc: '광고 서브도메인' },
        { kw: 'taboola',         desc: 'Taboola' },
        { kw: 'outbrain',        desc: 'Outbrain' },
        { kw: 'criteo',          desc: 'Criteo' },
        { kw: '/track',          desc: '트래킹' }
    ];

    const AD_PATH_PATTERNS = [
        { kw: '/banner',  desc: '배너 경로' },
        { kw: '/ads/',    desc: '광고 경로' },
        { kw: '/ad/',     desc: '광고 경로' },
        { kw: '/promo',   desc: '프로모션' },
        { kw: 'adimg',    desc: '광고 이미지' },
        { kw: '/sponsor', desc: '스폰서' },
        { kw: '_ad_',     desc: '광고 키워드' },
        { kw: '-ad-',     desc: '광고 키워드' }
    ];

    // 더미 href 값 (광고 클릭 버튼 패턴)
    const DUMMY_HREF_VALUES = new Set([
        'javascript:;', 'javascript:void(0)', 'javascript:void(0);',
        '#', '#!', 'about:blank', ''
    ]);

    // ARIA 광고 키워드
    const ARIA_AD_KEYWORDS = [
        '광고', '배너', 'AD', 'ad', 'Ad', 'banner', 'Banner',
        'advertisement', 'sponsor', 'promotion', '프로모션', '스폰서'
    ];

    // 이미지 src 같이 광고로 보이는 파일 확장자
    const AD_FILE_EXTS = ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg'];

    // ───────────────────────────────────────────────
    // SVG 아이콘
    // ───────────────────────────────────────────────
    const ICON_CLOSE   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    const ICON_SET     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94a7.96 7.96 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a8.13 8.13 0 00-1.62-.94l-.36-2.54A.5.5 0 0014 2h-4a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.6 8.48a.5.5 0 00.12.64l2.03 1.58a7.96 7.96 0 000 1.88L2.72 14.16a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54A.5.5 0 0010 22h4a.5.5 0 00.5-.42l.36-2.54a8.13 8.13 0 001.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
    const ICON_MIN     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13H5v-2h14v2z"/></svg>';
    const ICON_MAX     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
    const ICON_BACK    = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';
    const ICON_COPY    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>';
    const ICON_BLOCK   = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a7.95 7.95 0 01-4.9-1.69L18.31 7.1A7.95 7.95 0 0120 12c0 4.41-3.59 8-8 8z"/></svg>';
    const ICON_EDIT    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    const ICON_UP      = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
    const ICON_DOWN    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
    const ICON_TARGET  = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="2" d="M12 4v3M12 17v3M4 12h3M17 12h3"/></svg>';
    const ICON_DOT     = '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';
    const ICON_RESET   = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 016 6 6 6 0 01-6 6 6 6 0 01-6-6H4a8 8 0 008 8 8 8 0 008-8 8 8 0 00-8-8z"/></svg>';
    const ICON_CODE    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>';

    // ───────────────────────────────────────────────
    // Blocker — 규칙 저장/적용 + AdGuard/uBlock 내보내기
    // ───────────────────────────────────────────────
    const Blocker = {
        STYLE_ID: 'picky-block-style',
        KEY_RULES: 'picky_rules_v2',
        KEY_HIST:  'picky_history_v1',
        KEY_ENABLED: 'picky_enabled',
        KEY_AGG:   'picky_aggressive',

        async init() {
            // document-start에서 호출 → 가능한 빨리 스타일 주입
            const apply = () => this.enforce();
            if (document.documentElement) apply();
            new MutationObserver(() => {
                if (document.head && !document.getElementById(this.STYLE_ID)) apply();
            }).observe(document.documentElement, { childList: true, subtree: true });
        },

        host() { return location.hostname || 'global'; },

        fetchAll() {
            try { return JSON.parse(GM_getValue(this.KEY_RULES, '{}')) || {}; }
            catch (_) { return {}; }
        },

        fetch() {
            const all = this.fetchAll();
            return Array.isArray(all[this.host()]) ? all[this.host()] : [];
        },

        save(rules) {
            const all = this.fetchAll();
            all[this.host()] = rules;
            GM_setValue(this.KEY_RULES, JSON.stringify(all));
            this.enforce();
        },

        append(sel) {
            if (!sel || typeof sel !== 'string') return false;
            const rules = this.fetch();
            if (rules.includes(sel)) return false;
            rules.push(sel);
            this.save(rules);
            this.pushHistory({ act: 'add', sel, host: this.host(), ts: Date.now() });
            return true;
        },

        drop(sel) {
            const rules = this.fetch().filter(r => r !== sel);
            this.save(rules);
            this.pushHistory({ act: 'del', sel, host: this.host(), ts: Date.now() });
        },

        undoLast() {
            const hist = this.history();
            const last = hist.pop();
            if (!last) return null;
            GM_setValue(this.KEY_HIST, JSON.stringify(hist));
            if (last.act === 'add') this.drop(last.sel);
            else if (last.act === 'del') this.append(last.sel);
            return last;
        },

        history() {
            try { return JSON.parse(GM_getValue(this.KEY_HIST, '[]')) || []; }
            catch (_) { return []; }
        },

        pushHistory(entry) {
            const h = this.history();
            h.push(entry);
            if (h.length > 200) h.shift();
            GM_setValue(this.KEY_HIST, JSON.stringify(h));
        },

        isEnabled()    { return GM_getValue(this.KEY_ENABLED, true); },
        toggleEnabled(){ GM_setValue(this.KEY_ENABLED, !this.isEnabled()); this.enforce(); },
        isAggressive() { return GM_getValue(this.KEY_AGG, false); },
        toggleAggressive() { GM_setValue(this.KEY_AGG, !this.isAggressive()); this.enforce(); },

        enforce() {
            if (!document.head) return;
            let style = document.getElementById(this.STYLE_ID);
            if (!style) {
                style = document.createElement('style');
                style.id = this.STYLE_ID;
                document.head.appendChild(style);
            }
            if (!this.isEnabled()) { style.textContent = ''; return; }
            const rules = this.fetch();
            if (!rules.length) { style.textContent = ''; return; }

            const safe = rules.filter(r => {
                try { document.querySelector(r); return true; }
                catch (_) { return false; }
            });

            const decl = this.isAggressive()
                ? 'display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;opacity:0!important;pointer-events:none!important;'
                : 'display:none!important;';
            style.textContent = safe.map(s => `${s}{${decl}}`).join('\n');
        },

        clear() { this.save([]); },

        getStats() {
            const all = this.fetchAll();
            const sites = Object.keys(all);
            let total = 0;
            for (const k of sites) total += (all[k] || []).length;
            return {
                ruleCount: this.fetch().length,
                totalSites: sites.length,
                totalRules: total
            };
        },

        // AdGuard/uBlock 호환 코스메틱 규칙 (호스트##selector)
        toCosmetic(sel, scope = 'host') {
            if (scope === 'global') return `##${sel}`;
            return `${this.host()}##${sel}`;
        },

        exportJSON() {
            const data = {
                app: 'Picky Advanced',
                version: '3.6.0',
                exportDate: new Date().toISOString(),
                rules: this.fetchAll()
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `picky-rules-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        // AdGuard/uBlock 호환 필터 텍스트 (양쪽 모두 동작하는 공통 문법)
        exportFilterText() {
            const all = this.fetchAll();
            const lines = [
                '! Title: Picky Advanced Export',
                `! Version: 3.6.0`,
                `! Generated: ${new Date().toISOString()}`,
                '! Syntax: AdGuard / uBlock Origin compatible',
                ''
            ];
            for (const host of Object.keys(all)) {
                const rules = all[host] || [];
                if (!rules.length) continue;
                lines.push(`! ===== ${host} =====`);
                for (const r of rules) {
                    lines.push(host === 'global' ? `##${r}` : `${host}##${r}`);
                }
                lines.push('');
            }
            return lines.join('\n');
        },

        async copyFilterText() {
            const text = this.exportFilterText();
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                return true;
            }
        },

        importJSON(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const data = JSON.parse(reader.result);
                        if (!data.rules || typeof data.rules !== 'object')
                            throw new Error('잘못된 형식');
                        const current = this.fetchAll();
                        for (const k of Object.keys(data.rules)) {
                            const incoming = data.rules[k] || [];
                            const cur = current[k] || [];
                            current[k] = Array.from(new Set([...cur, ...incoming]));
                        }
                        GM_setValue(this.KEY_RULES, JSON.stringify(current));
                        this.enforce();
                        resolve(data);
                    } catch (e) { reject(e); }
                };
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }
    };
    Blocker.init();

    // ───────────────────────────────────────────────
    // Modal — 오버레이 다이얼로그
    // ───────────────────────────────────────────────
    class Modal {
        constructor(container) {
            this.container = container;
            this.node = null;
        }

        display(title, body, isHtml = false, extraClass = '') {
            this.dismiss();
            const wrap = document.createElement('div');
            wrap.className = `picky-modal ${extraClass}`.trim();
            wrap.innerHTML = `
                <div class="picky-modal-card">
                    <div class="picky-modal-head">
                        <span class="picky-modal-title">${esc(title)}</span>
                        <button class="picky-modal-x" aria-label="닫기">${ICON_CLOSE}</button>
                    </div>
                    <div class="picky-modal-body"></div>
                </div>`;
            const bodyEl = wrap.querySelector('.picky-modal-body');
            if (isHtml) bodyEl.innerHTML = body;
            else bodyEl.textContent = body;

            wrap.querySelector('.picky-modal-x').addEventListener('click', () => this.dismiss());
            wrap.addEventListener('click', (e) => {
                if (e.target === wrap) this.dismiss();
            });
            (this.container || document.body).appendChild(wrap);
            requestAnimationFrame(() => wrap.classList.add('visible'));
            this.node = wrap;
            return bodyEl;
        }

        dismiss() {
            if (!this.node) return;
            const n = this.node;
            n.classList.remove('visible');
            setTimeout(() => n.remove(), 200);
            this.node = null;
        }
    }

    // 다음 파트로 ───────────────────────────────────
    // Part 2/4: SelectorStrategies 전반부 (유틸 + 기존 6개 + 이미지 4개 + dummyHref)
    // ───────────────────────────────────────────────

    // === Part 1 끝, Part 2~4는 이어서 출력 ===

    // ───────────────────────────────────────────────
    // SelectorStrategies — 셀렉터 생성 전략 집합
    // ───────────────────────────────────────────────
    class SelectorStrategies {

        // ─── 유틸리티 ────────────────────────────
        static countMatches(sel, root = document) {
            if (!sel) return 0;
            try { return root.querySelectorAll(sel).length; }
            catch (_) { return 0; }
        }

        // 클래스명이 의미있는지 (volatile / picky 내부 / 동적생성 클래스 제외)
        static isMeaningfulClass(cls) {
            if (!cls || typeof cls !== 'string') return false;
            if (cls.length < 2 || cls.length > 40) return false;

            // Picky 내부 클래스 차단 (Patch A)
            if (cls.startsWith('picky-')) return false;
            if (cls === HL_CLASS || cls === ISO_PATH || cls === ISO_BODY) return false;

            // 동적 prefix
            if (/^(ember|v-|ng-|re-|css-|sc-|jsx-|emotion-|makeStyles-)/.test(cls)) return false;

            // 해시성 (영문 대문자+숫자 7자 이상)
            if (/^[a-zA-Z0-9_-]{8,}$/.test(cls) && /[0-9]/.test(cls) && /[A-Z]/.test(cls)) return false;

            // 상태성 클래스
            const volatile = ['active','focus','hover','selected','disabled','checked',
                              'open','closed','expanded','collapsed','loading','transition',
                              'animating','v-enter','v-leave','is-active','is-open'];
            if (volatile.some(v => cls.toLowerCase().includes(v))) return false;

            return true;
        }

        // 엘리먼트의 안전한 클래스 배열 (picky 클래스 제거)
        static safeClasses(el) {
            if (!el || !el.classList) return [];
            return Array.from(el.classList).filter(c =>
                !c.startsWith('picky-') &&
                c !== HL_CLASS && c !== ISO_PATH && c !== ISO_BODY
            );
        }

        // 의미 있는 클래스만 추출
        static meaningfulClasses(el) {
            return this.safeClasses(el).filter(c => this.isMeaningfulClass(c));
        }

        // 부모 체인 (최대 깊이)
        static parentChain(el, maxDepth = 5) {
            const chain = [];
            let cur = el?.parentElement;
            while (cur && cur !== document.body && chain.length < maxDepth) {
                chain.push(cur);
                cur = cur.parentElement;
            }
            return chain;
        }

        // 이미지 찾기 (자기 자신 / 자식 / 부모 a의 자식)
        static _findImg(el) {
            if (!el) return null;
            if (el.tagName === 'IMG') return el;
            const inside = el.querySelector?.('img');
            if (inside) return inside;
            const a = el.closest?.('a');
            return a?.querySelector?.('img') || null;
        }

        // 가장 가까운 <a>
        static _findAnchor(el) {
            if (!el) return null;
            if (el.tagName === 'A') return el;
            return el.closest?.('a') || null;
        }

        // 이미지 관련 요소인지
        static isImageRelated(el) {
            return !!this._findImg(el);
        }

        // 셀렉터 점수 (0~100)
        static scoreSelector(sel, el, options = {}) {
            if (!sel) return 0;
            const matches = this.countMatches(sel);
            if (matches === 0) return 0;

            // 실제로 대상 엘리먼트를 포함하는지 검증
            try {
                const list = document.querySelectorAll(sel);
                if (el && ![...list].includes(el)) return 0;
            } catch (_) { return 0; }

            let score = 50;

            // 매치 개수 (적을수록 정확)
            if (matches === 1) score += 25;
            else if (matches <= 3) score += 18;
            else if (matches <= 10) score += 10;
            else if (matches <= 30) score += 4;
            else score -= 5;

            // 셀렉터 길이
            if (sel.length < 30) score += 8;
            else if (sel.length < 60) score += 3;
            else if (sel.length > 120) score -= 8;

            // 보너스
            if (/^#[\w-]+$/.test(sel)) score += 12;                          // 순수 ID
            if (/^#[\w-]+\.[\w-]+/.test(sel)) score += 14;                   // ID+클래스 조합
            if (/\[data-[\w-]+/.test(sel)) score += 10;                      // data 속성
            if (/\[aria-[\w-]+/.test(sel)) score += 8;                       // aria 속성
            if (/:has\(/.test(sel)) score += 6;                              // :has()
            if (/\[(src|href)\*?=/.test(sel)) score += 7;                    // src/href 매칭

            // 페널티
            if (/:nth-of-type\(\d+\).*:nth-of-type/.test(sel)) score -= 8;   // nth 중첩
            if (sel.split('>').length > 4) score -= 10;                      // 깊은 자손 셀렉터
            if (/picky-/.test(sel)) return 0;                                // picky 클래스 완전 배제

            // 사용자 옵션 보너스
            if (options.bonus) score += options.bonus;

            return Math.max(0, Math.min(100, score));
        }

        // 점수 → 별 등급
        static scoreToStars(score) {
            if (score >= 80) return '★★★';
            if (score >= 60) return '★★☆';
            if (score >= 40) return '★☆☆';
            return '☆☆☆';
        }

        // ─── 전략 1: 의미있는 속성 (semantic) ────
        static semantic(el) {
            const priority = [
                'data-testid', 'data-cy', 'data-test-id', 'data-test',
                'data-qa', 'data-role', 'data-component',
                'name', 'aria-label', 'aria-labelledby', 'role',
                'alt', 'title', 'placeholder', 'type'
            ];
            const candidates = [];

            for (const attr of priority) {
                const val = el.getAttribute?.(attr);
                if (!val || val.length > 60) continue;
                const tag = el.tagName.toLowerCase();
                const variants = [
                    `[${attr}="${CSS.escape(val)}"]`,
                    `${tag}[${attr}="${CSS.escape(val)}"]`,
                    val.length > 8 ? `[${attr}*="${CSS.escape(val.slice(0, 8))}"]` : null
                ].filter(Boolean);

                for (const sel of variants) {
                    const score = this.scoreSelector(sel, el);
                    if (score >= 50) candidates.push({ sel, score, attr });
                }
            }

            if (!candidates.length) return null;
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates[0];
            return {
                type: 'semantic',
                icon: '🏷️',
                label: '의미있는 속성',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: `${best.attr} 속성 기반`
            };
        }

        // ─── 전략 2: 가장 짧은 셀렉터 (shortest + ID+class 조합) ──
        static shortest(el) {
            const candidates = [];
            const tag = el.tagName.toLowerCase();
            const id = el.id;
            const classes = this.meaningfulClasses(el);

            // 순수 ID
            if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
                candidates.push(`#${CSS.escape(id)}`);
                // ID + 클래스 조합 (Patch C)
                for (const c of classes.slice(0, 2)) {
                    candidates.push(`#${CSS.escape(id)}.${CSS.escape(c)}`);
                }
                if (classes.length >= 2) {
                    candidates.push(`#${CSS.escape(id)}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`);
                }
            }

            // 클래스만
            for (const c of classes.slice(0, 3)) {
                candidates.push(`.${CSS.escape(c)}`);
                candidates.push(`${tag}.${CSS.escape(c)}`);
            }

            // 다중 클래스
            if (classes.length >= 2) {
                candidates.push(`.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`);
            }

            // 태그만 (마지막 수단)
            if (!candidates.length) candidates.push(tag);

            const scored = candidates
                .map(sel => ({ sel, score: this.scoreSelector(sel, el) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'shortest',
                icon: '✨',
                label: '가장 짧은 셀렉터',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: id ? 'ID 우선' : '클래스 기반'
            };
        }

        // ─── 전략 2b: 더미 href (Patch B) ────────
        static dummyHref(el) {
            const anchor = this._findAnchor(el);
            if (!anchor) return null;
            const href = anchor.getAttribute('href');
            if (!href || !DUMMY_HREF_VALUES.has(href.trim())) return null;

            const candidates = [];
            const parent = anchor.parentElement;

            // 기본: a[href="..."]
            candidates.push(`a[href="${CSS.escape(href)}"]`);

            // ID/클래스 조합
            if (anchor.id && /^[a-zA-Z][\w-]*$/.test(anchor.id)) {
                candidates.push(`a#${CSS.escape(anchor.id)}[href="${CSS.escape(href)}"]`);
            }
            const aClasses = this.meaningfulClasses(anchor);
            for (const c of aClasses.slice(0, 2)) {
                candidates.push(`a.${CSS.escape(c)}[href="${CSS.escape(href)}"]`);
            }

            // 부모 ID 기반 자손 셀렉터
            if (parent?.id && /^[a-zA-Z][\w-]*$/.test(parent.id)) {
                candidates.push(`#${CSS.escape(parent.id)} a[href="${CSS.escape(href)}"]`);
            }

            const scored = candidates
                .map(sel => ({ sel, score: this.scoreSelector(sel, el, { bonus: 6 }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'dummyHref',
                icon: '🔗',
                label: '더미 링크 (광고 클릭 패턴)',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: `href="${href}" 광고 버튼 가능성`
            };
        }

        // ─── 전략 3: 클래스 패턴 (BEM/광고 키워드) ────
        static classPattern(el) {
            const classes = this.meaningfulClasses(el);
            if (!classes.length) return null;

            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement', 'popup', 'overlay'];
            const candidates = [];

            for (const c of classes) {
                const low = c.toLowerCase();
                // 광고 키워드 직접 포함
                if (adKeywords.some(k => low.includes(k))) {
                    candidates.push({ sel: `[class*="${CSS.escape(c)}"]`, hint: '광고 키워드 클래스' });
                    candidates.push({ sel: `.${CSS.escape(c)}`, hint: '광고 키워드 클래스' });
                }

                // BEM 패턴 (block__element 또는 block--modifier)
                const bem = c.match(/^([a-z][\w-]*?)(?:__|--)/i);
                if (bem) {
                    candidates.push({ sel: `[class^="${CSS.escape(bem[1])}"]`, hint: `BEM 블록: ${bem[1]}` });
                }
            }

            // data-ad-* 속성
            for (const attr of el.attributes || []) {
                if (/^data-ad/i.test(attr.name)) {
                    candidates.push({ sel: `[${attr.name}]`, hint: '광고 데이터 속성' });
                }
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'classPattern',
                icon: '📎',
                label: '클래스 패턴',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 전략 4: 정밀 평가 (외부 evaluator) ────
        static precise(el, evaluator) {
            if (typeof evaluator !== 'function') return null;
            let sel;
            try { sel = evaluator(el); } catch (_) { return null; }
            if (!sel || /picky-/.test(sel)) return null;

            const score = this.scoreSelector(sel, el);
            if (!score) return null;
            return {
                type: 'precise',
                icon: '🎯',
                label: '정밀 셀렉터',
                selector: sel,
                matches: this.countMatches(sel),
                score,
                stars: this.scoreToStars(score),
                hint: '평가기 기반'
            };
        }

        // ─── 전략 5: 유사 그룹 (similarGroup) ────
        static similarGroup(el) {
            const parent = el.parentElement;
            if (!parent) return null;
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);

            // 같은 태그의 형제
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length < 2) return null;

            const candidates = [];

            // 공통 클래스 찾기
            for (const c of classes) {
                const sharedCount = siblings.filter(s => s.classList.contains(c)).length;
                if (sharedCount >= 2) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(c)}`,
                        hint: `${sharedCount}개 형제 공유`
                    });
                }
            }

            // 부모 ID + 자식 태그
            if (parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id)) {
                candidates.push({
                    sel: `#${CSS.escape(parent.id)} > ${tag}`,
                    hint: '부모 ID 하의 동일 태그'
                });
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'similarGroup',
                icon: '👥',
                label: '유사 그룹',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 전략 6: 컨테이너 (container) ────────
        static container(el) {
            const chain = this.parentChain(el, 4);
            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement'];
            const containerTags = ['section', 'aside', 'article', 'nav', 'header', 'footer'];

            const candidates = [];

            for (const p of chain) {
                const id = p.id;
                const classes = this.meaningfulClasses(p);
                const tag = p.tagName.toLowerCase();

                // 광고 키워드 ID
                if (id && adKeywords.some(k => id.toLowerCase().includes(k))) {
                    candidates.push({
                        sel: `#${CSS.escape(id)}`,
                        hint: `광고 키워드 ID: ${id}`
                    });
                }

                // 광고 키워드 클래스
                for (const c of classes) {
                    if (adKeywords.some(k => c.toLowerCase().includes(k))) {
                        candidates.push({
                            sel: `.${CSS.escape(c)}`,
                            hint: `광고 키워드 컨테이너: ${c}`
                        });
                    }
                }

                // 시맨틱 컨테이너 태그
                if (containerTags.includes(tag) && classes.length) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(classes[0])}`,
                        hint: `시맨틱 컨테이너: ${tag}`
                    });
                }
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'container',
                icon: '🎨',
                label: '부모 컨테이너',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 이미지 전략 1: src 도메인 ───────────
        static imgSrcDomain(el) {
            const img = this._findImg(el);
            if (!img) return null;
            const src = img.getAttribute('src') || img.src;
            if (!src) return null;

            let host = '';
            try { host = new URL(src, location.href).hostname; }
            catch (_) { return null; }
            if (!host) return null;

            const candidates = [];

            // 광고 호스트 일치
            const adHost = AD_NETWORK_HOSTS.find(h => host.includes(h));
            if (adHost) {
                candidates.push({
                    sel: `img[src*="${adHost}"]`,
                    hint: `광고 네트워크: ${adHost}`,
                    bonus: 12
                });
            }

            // 외부 도메인
            if (host !== location.hostname && !location.hostname.endsWith(host)) {
                candidates.push({
                    sel: `img[src*="${host}"]`,
                    hint: `외부 도메인: ${host}`,
                    bonus: 5
                });
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, img, { bonus: c.bonus }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'imgSrcDomain',
                icon: '🖼️',
                label: '광고 도메인 이미지',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 이미지 전략 2: 표준 광고 크기 ──────
        static imgStandardSize(el) {
            const img = this._findImg(el);
            if (!img) return null;

            const w = parseInt(img.getAttribute('width')) || img.naturalWidth || img.width;
            const h = parseInt(img.getAttribute('height')) || img.naturalHeight || img.height;
            if (!w || !h) return null;

            const matched = IAB_AD_SIZES.find(([sw, sh]) =>
                Math.abs(sw - w) <= 5 && Math.abs(sh - h) <= 5
            );
            if (!matched) return null;

            const anchor = this._findAnchor(img);
            const hasExtLink = anchor && anchor.href &&
                (() => { try { return new URL(anchor.href).hostname !== location.hostname; } catch (_) { return false; } })();

            const candidates = [
                { sel: `img[width="${matched[0]}"][height="${matched[1]}"]`, hint: `IAB 표준: ${matched[0]}×${matched[1]}`, bonus: hasExtLink ? 8 : 0 }
            ];

            if (hasExtLink) {
                candidates.push({
                    sel: `a[href] > img[width="${matched[0]}"][height="${matched[1]}"]`,
                    hint: `IAB 크기 + 외부 링크`,
                    bonus: 12
                });
            }

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, img, { bonus: c.bonus }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'imgStandardSize',
                icon: '📐',
                label: '표준 광고 크기',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 이미지 전략 3: 광고 링크 안의 이미지 ──
        static imgInAdLink(el) {
            const img = this._findImg(el);
            if (!img) return null;
            const anchor = this._findAnchor(img);
            if (!anchor) return null;
            const href = anchor.getAttribute('href') || anchor.href || '';
            if (!href) return null;

            const matched = AD_LINK_PATTERNS.find(p => href.includes(p.kw));
            if (!matched) return null;

            const candidates = [
                { sel: `a[href*="${matched.kw}"] > img`, hint: `${matched.desc}`, bonus: 10 },
                { sel: `a[href*="${matched.kw}"] img`, hint: `${matched.desc} (자손)`, bonus: 6 }
            ];

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, img, { bonus: c.bonus }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'imgInAdLink',
                icon: '🔗',
                label: '광고 링크 내 이미지',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 이미지 전략 4: src 경로 패턴 ────────
        static imgPathPattern(el) {
            const img = this._findImg(el);
            if (!img) return null;
            const src = img.getAttribute('src') || img.src || '';
            if (!src) return null;

            const matched = AD_PATH_PATTERNS.find(p => src.toLowerCase().includes(p.kw));
            if (!matched) return null;

            const candidates = [
                { sel: `img[src*="${matched.kw}"]`, hint: matched.desc, bonus: 6 }
            ];

            // 파일명 추출 (광고 이미지가 특정 파일명을 쓰는 경우)
            try {
                const url = new URL(src, location.href);
                const file = url.pathname.split('/').pop();
                if (file && file.length >= 4 && file.length <= 30 && AD_FILE_EXTS.some(e => file.endsWith(e))) {
                    candidates.push({
                        sel: `img[src*="${file}"]`,
                        hint: `광고 파일명: ${file}`,
                        bonus: 4
                    });
                }
            } catch (_) {}

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, img, { bonus: c.bonus }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'imgPathPattern',
                icon: '📦',
                label: '이미지 경로 패턴',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // 다음 파트로 ───────────────────────────────
        // Part 3/4: 신규 4개 전략 (네트워크/혼합/조합/ARIA) + buildAll + toAdGuardRule
        // ─────────────────────────────────────────

        // ─── 신규 전략 1: 네트워크 필터 (🌐) ─────
        // ||host/path 형식 — AdGuard/uBlock 공통
        // CSS 셀렉터로는 차단 불가, 필터 텍스트 복사 전용
        static networkFilter(el) {
            // 대상이 src를 갖는 미디어/리소스 요소인지 확인
            const targets = [];
            const TAG_SRC = ['IMG', 'IFRAME', 'SCRIPT', 'VIDEO', 'AUDIO', 'SOURCE', 'EMBED'];

            if (TAG_SRC.includes(el.tagName)) {
                targets.push(el);
            } else {
                // 자식 중 src를 가진 요소
                const inner = el.querySelector?.('img[src], iframe[src], video[src], embed[src]');
                if (inner) targets.push(inner);
            }
            if (!targets.length) return null;

            const candidates = [];

            for (const t of targets) {
                const src = t.getAttribute('src') || t.src;
                if (!src) continue;
                let url;
                try { url = new URL(src, location.href); } catch (_) { continue; }
                if (!url.hostname || url.protocol === 'data:' || url.protocol === 'blob:') continue;

                const host = url.hostname;
                const path = url.pathname || '';
                const isAdHost = AD_NETWORK_HOSTS.some(h => host.includes(h));
                const isExternal = host !== location.hostname && !location.hostname.endsWith(host);

                // 광고 호스트는 호스트 전체 차단 우선
                if (isAdHost) {
                    candidates.push({
                        filter: `||${host}^`,
                        cssSel: `img[src*="${host}"], iframe[src*="${host}"]`,
                        hint: `광고 호스트 차단: ${host}`,
                        rawScore: 92
                    });
                }

                // 파일 경로 기반 (광고 파일명/경로 패턴)
                const fileName = path.split('/').pop();
                const adPathMatch = AD_PATH_PATTERNS.find(p => path.toLowerCase().includes(p.kw));
                if (adPathMatch && fileName) {
                    candidates.push({
                        filter: `||${host}${path}`,
                        cssSel: `img[src*="${fileName}"]`,
                        hint: `광고 경로: ${adPathMatch.desc}`,
                        rawScore: 86
                    });
                }

                // 외부 도메인 + 표준 광고 크기
                if (isExternal && t.tagName === 'IMG') {
                    const w = parseInt(t.getAttribute('width')) || t.naturalWidth;
                    const h = parseInt(t.getAttribute('height')) || t.naturalHeight;
                    const matchedSize = IAB_AD_SIZES.find(([sw, sh]) =>
                        Math.abs(sw - w) <= 5 && Math.abs(sh - h) <= 5
                    );
                    if (matchedSize) {
                        candidates.push({
                            filter: `||${host}^$image`,
                            cssSel: `img[src*="${host}"]`,
                            hint: `외부 도메인 + IAB ${matchedSize[0]}×${matchedSize[1]}`,
                            rawScore: 78
                        });
                    }
                }

                // 외부 도메인 + 광고 파일 확장자 (일반)
                if (isExternal && fileName && AD_FILE_EXTS.some(e => fileName.toLowerCase().endsWith(e))) {
                    candidates.push({
                        filter: `||${host}${path}`,
                        cssSel: `${t.tagName.toLowerCase()}[src*="${fileName}"]`,
                        hint: `외부 리소스: ${fileName}`,
                        rawScore: 70
                    });
                }
            }

            if (!candidates.length) return null;
            candidates.sort((a, b) => b.rawScore - a.rawScore);
            const best = candidates[0];

            return {
                type: 'networkFilter',
                icon: '🌐',
                label: '네트워크 필터',
                selector: best.cssSel,           // 참고용 CSS (실제 차단 불가)
                filter: best.filter,             // AdGuard/uBlock 네트워크 규칙
                isNetwork: true,                 // ⛔ 버튼 비활성 플래그
                matches: this.countMatches(best.cssSel),
                score: best.rawScore,
                stars: this.scoreToStars(best.rawScore),
                hint: best.hint
            };
        }

        // ─── 신규 전략 2: 혼합 nth (🧩) ──────────
        // div.main-box:nth-of-type(1) > div.main-head 같은 위치 기반 조합
        static mixedNth(el) {
            const parent = el.parentElement;
            if (!parent) return null;

            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);
            const candidates = [];

            // 자기 자신 위치 계산 (같은 태그 형제 중 몇 번째)
            const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            const myIdx = sameTagSiblings.indexOf(el) + 1;

            // 케이스 1: tag.class:nth-of-type(n)
            if (myIdx > 0 && classes.length && sameTagSiblings.length > 1) {
                candidates.push({
                    sel: `${tag}.${CSS.escape(classes[0])}:nth-of-type(${myIdx})`,
                    hint: `${myIdx}번째 ${tag}.${classes[0]}`
                });
                candidates.push({
                    sel: `${tag}:nth-of-type(${myIdx})`,
                    hint: `${myIdx}번째 ${tag}`
                });
            }

            // 케이스 2: parentTag.parentClass:nth-of-type(n) > tag (계층)
            const parentClasses = this.meaningfulClasses(parent);
            if (parent.parentElement && parentClasses.length) {
                const parentSameTag = Array.from(parent.parentElement.children)
                    .filter(c => c.tagName === parent.tagName);
                const parentIdx = parentSameTag.indexOf(parent) + 1;
                const parentTag = parent.tagName.toLowerCase();

                if (parentIdx > 0 && parentSameTag.length > 1) {
                    candidates.push({
                        sel: `${parentTag}.${CSS.escape(parentClasses[0])}:nth-of-type(${parentIdx}) > ${tag}${classes.length ? '.' + CSS.escape(classes[0]) : ''}`,
                        hint: `${parentIdx}번째 ${parentTag} 안의 ${tag}`
                    });
                }
            }

            // 케이스 3: nth-child
            const allSiblings = Array.from(parent.children);
            const childIdx = allSiblings.indexOf(el) + 1;
            if (childIdx > 0 && allSiblings.length > 1) {
                if (classes.length) {
                    candidates.push({
                        sel: `.${CSS.escape(classes[0])}:nth-child(${childIdx})`,
                        hint: `${childIdx}번째 자식`
                    });
                }
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el, { bonus: 3 }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'mixedNth',
                icon: '🧩',
                label: '혼합 위치 셀렉터',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 신규 전략 3: 다중 조건 조합 (🔧) ────
        // [style*="..."] + .class + :has(> img) 등 AND 결합
        static multiCondition(el) {
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);
            const style = el.getAttribute('style') || '';
            const candidates = [];

            // 조건 1: 인라인 style + 클래스
            if (style && classes.length) {
                // style에서 의미있는 속성 추출
                const stylePatterns = [
                    { kw: 'position:absolute', desc: '절대위치' },
                    { kw: 'position:fixed', desc: '고정위치' },
                    { kw: 'z-index', desc: 'z-index' },
                    { kw: 'display:block', desc: 'block 표시' }
                ];
                for (const sp of stylePatterns) {
                    if (style.replace(/\s/g, '').toLowerCase().includes(sp.kw)) {
                        candidates.push({
                            sel: `${tag}.${CSS.escape(classes[0])}[style*="${sp.kw.split(':')[0]}"]`,
                            hint: `${sp.desc} + 클래스`
                        });
                        break;
                    }
                }
            }

            // 조건 2: :has(> iframe) / :has(> img) — iframe/img 컨테이너
            if (SUPPORTS_HAS) {
                const hasIframe = el.querySelector(':scope > iframe');
                const hasImg = el.querySelector(':scope > img');
                const hasAdImg = hasImg && (() => {
                    const src = hasImg.getAttribute('src') || '';
                    return AD_NETWORK_HOSTS.some(h => src.includes(h)) ||
                           AD_PATH_PATTERNS.some(p => src.toLowerCase().includes(p.kw));
                })();

                if (hasIframe && classes.length) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(classes[0])}:has(> iframe)`,
                        hint: 'iframe 직접 자식'
                    });
                } else if (hasIframe) {
                    candidates.push({
                        sel: `${tag}:has(> iframe)`,
                        hint: 'iframe 직접 자식'
                    });
                }

                if (hasAdImg && classes.length) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(classes[0])}:has(> img[src*="ad"])`,
                        hint: '광고 이미지 컨테이너'
                    });
                }
            }

            // 조건 3: 다중 클래스 + 자식 태그
            if (classes.length >= 2) {
                const childImg = el.querySelector(':scope > img');
                if (childImg && SUPPORTS_HAS) {
                    candidates.push({
                        sel: `.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}:has(> img)`,
                        hint: '다중 클래스 + img'
                    });
                }
                // :has 없는 환경에서도 동작하는 후행 결합자
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`,
                    hint: '다중 클래스'
                });
            }

            // 조건 4: data-* 속성 + 클래스
            const dataAttrs = Array.from(el.attributes || []).filter(a => a.name.startsWith('data-') && a.value.length < 30);
            if (dataAttrs.length && classes.length) {
                const da = dataAttrs[0];
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}[${da.name}="${CSS.escape(da.value)}"]`,
                    hint: `${da.name} 속성 결합`
                });
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el, { bonus: 5 }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'multiCondition',
                icon: '🔧',
                label: '다중 조건 조합',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 신규 전략 4: ARIA / 접근성 (♿) ────
        static ariaLabel(el) {
            // 자기 자신 또는 가장 가까운 조상에서 ARIA 속성 탐색 (최대 3단계)
            const targets = [el];
            let cur = el.parentElement;
            let depth = 0;
            while (cur && depth < 3) { targets.push(cur); cur = cur.parentElement; depth++; }

            const candidates = [];

            for (const t of targets) {
                const tag = t.tagName.toLowerCase();
                const ariaLabel = t.getAttribute('aria-label');
                const role = t.getAttribute('role');
                const ariaLabelledby = t.getAttribute('aria-labelledby');

                // aria-label에 광고 키워드
                if (ariaLabel) {
                    const matched = ARIA_AD_KEYWORDS.find(k => ariaLabel.includes(k));
                    if (matched) {
                        candidates.push({
                            sel: `[aria-label*="${CSS.escape(matched)}"]`,
                            hint: `aria-label에 "${matched}"`,
                            bonus: 12
                        });
                        candidates.push({
                            sel: `${tag}[aria-label*="${CSS.escape(matched)}"]`,
                            hint: `${tag} + aria-label "${matched}"`,
                            bonus: 10
                        });
                    } else if (ariaLabel.length <= 30) {
                        // 광고 키워드 아니어도 짧은 aria-label은 식별성 좋음
                        candidates.push({
                            sel: `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`,
                            hint: `aria-label="${ariaLabel}"`,
                            bonus: 4
                        });
                    }
                }

                // role 기반
                if (role && ['banner', 'complementary', 'advertisement'].includes(role)) {
                    candidates.push({
                        sel: `[role="${CSS.escape(role)}"]`,
                        hint: `role="${role}"`,
                        bonus: 10
                    });
                }

                // aria-labelledby
                if (ariaLabelledby) {
                    candidates.push({
                        sel: `[aria-labelledby="${CSS.escape(ariaLabelledby)}"]`,
                        hint: `aria-labelledby 참조`,
                        bonus: 6
                    });
                }
            }

            if (!candidates.length) return null;

            const scored = candidates
                .map(c => ({ ...c, score: this.scoreSelector(c.sel, el, { bonus: c.bonus }) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (!scored.length) return null;
            const best = scored[0];
            return {
                type: 'ariaLabel',
                icon: '♿',
                label: 'ARIA / 접근성',
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            };
        }

        // ─── 전체 후보 빌드 ──────────────────────
        static buildAll(el, evaluator) {
            if (!el || !el.tagName) return [];

            const strategies = [
                () => this.semantic(el),
                () => this.shortest(el),
                () => this.dummyHref(el),
                () => this.classPattern(el),
                () => this.precise(el, evaluator),
                () => this.similarGroup(el),
                () => this.container(el),
                // 신규 4개
                () => this.networkFilter(el),
                () => this.mixedNth(el),
                () => this.multiCondition(el),
                () => this.ariaLabel(el)
            ];

            // 이미지 관련 요소면 이미지 전략 추가
            if (this.isImageRelated(el)) {
                strategies.push(
                    () => this.imgSrcDomain(el),
                    () => this.imgStandardSize(el),
                    () => this.imgInAdLink(el),
                    () => this.imgPathPattern(el)
                );
            }

            const results = [];
            for (const fn of strategies) {
                try {
                    const r = fn();
                    if (r && r.selector) results.push(r);
                } catch (_) {}
            }

            // picky 셀렉터 완전 제거
            const filtered = results.filter(r => !/picky-/.test(r.selector));

            // 중복 제거 (selector + filter 키 기준)
            const seen = new Set();
            const unique = [];
            for (const r of filtered) {
                const key = `${r.selector}|${r.filter || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(r);
            }

            // 점수 내림차순 정렬
            unique.sort((a, b) => b.score - a.score);

            // 상위 후보에 추천 배지
            if (unique.length) unique[0].recommended = true;

            return unique;
        }

        // ─── AdGuard/uBlock 호환 규칙 변환기 ─────
        // 카드 후보 → 양쪽 모두 사용 가능한 필터 텍스트
        static toAdGuardRule(candidate, scope = 'host') {
            if (!candidate) return '';

            // 네트워크 필터는 그대로 반환
            if (candidate.isNetwork && candidate.filter) {
                return candidate.filter;
            }

            // 코스메틱 규칙: host##selector (호스트 한정) 또는 ##selector (전역)
            const sel = candidate.selector;
            if (!sel) return '';

            const host = location.hostname || '';
            if (scope === 'global' || !host) return `##${sel}`;
            return `${host}##${sel}`;
        }
    }

    // 다음 파트로 ───────────────────────────────
    // Part 4/4: Inspector 클래스 (UI 전체) + CSS 스타일 + 부팅 코드
    // ─────────────────────────────────────────

    // ───────────────────────────────────────────────
    // Inspector — UI / 이벤트 / 카드 리스트 처리
    // ───────────────────────────────────────────────
    class Inspector {
        constructor() {
            this.dom = {
                host: null, shadow: null, tool: null,
                shield: null, disp: null, match: null, slider: null,
                cardsScroll: null
            };
            this.state = {
                target: null, originTarget: null, hierarchy: [],
                queryData: { selector: '', root: document },
                candidates: [],
                selectedIdx: -1,
                previewNodes: [],
                mode: 'initial',         // 'initial' | 'picking' | 'selected'
                scale: 'full',           // 'full' | 'min' | 'icon'
                isCollapsed: true,
                isObscured: false,
                isQuarantined: false,
                obscuredNodes: [],
                displayCache: new WeakMap(),
                hits: 0,
                autoDismiss: GM_getValue('picky_auto_close', true),
                hoverPreviewNodes: [],
                adSelectedNodes: [],
                iconPos: GM_getValue('picky_icon_pos', null),
                panelPos: GM_getValue('picky_panel_pos', null),
                isDragging: false,
                dragDidMove: false,
                dragTarget: null
            };
            this.config = {
                useId: true, useClasses: true, classCount: 2,
                useNthOfType: true,
                intelligentMode: true,
                maxDepth: 8,
                shadowDomSupport: false
            };
            this.overlay = null;
            this.modal = null;
            this.longPressTimer = null;
            this._preciseEvaluator = (el) => this.evaluateCssBasic(el);
        }

        // ─── 기본 평가기 (precise 전략용) ────────
        evaluateCssBasic(el) {
            if (!el || !el.tagName) return '';
            const tag = el.tagName.toLowerCase();
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
            const classes = SelectorStrategies.meaningfulClasses(el);
            if (classes.length) return `${tag}.${CSS.escape(classes[0])}`;
            return tag;
        }

        // ─── 부모/자식 탐색 ─────────────────────
        resolveParent(el) {
            return el?.parentElement || null;
        }
        resolveChildren(el) {
            if (!el) return [];
            return Array.from(el.children || []);
        }

        // ─── UI 구성 ───────────────────────────
        constructUI() {
            // 호스트 + Shadow DOM
            const host = document.createElement('div');
            host.id = ROOT_ID;
            host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
            document.documentElement.appendChild(host);
            const shadow = host.attachShadow({ mode: 'open' });
            this.dom.host = host;
            this.dom.shadow = shadow;

            // 메인 도구
            const tool = document.createElement('div');
            tool.id = TOOL_ID;
            tool.className = 'picky-tool picky-icon';
            shadow.appendChild(tool);
            this.dom.tool = tool;

            // CSS 주입
            const style = document.createElement('style');
            style.textContent = PICKY_CSS;
            shadow.appendChild(style);

            // 모달 컨테이너
            this.modal = new Modal(shadow);

            this.render();
            this.attachDragHandlers();
            this.applyPosition();
        }

        // ─── 위치 적용 ──────────────────────────
        applyPosition() {
            const tool = this.dom.tool;
            if (!tool) return;
            if (this.state.scale === 'icon') {
                const pos = this.state.iconPos;
                if (pos && typeof pos.x === 'number') {
                    tool.style.left = pos.x + 'px';
                    tool.style.top = pos.y + 'px';
                    tool.style.right = 'auto';
                    tool.style.bottom = 'auto';
                } else {
                    tool.style.right = '20px';
                    tool.style.bottom = '20px';
                    tool.style.left = 'auto';
                    tool.style.top = 'auto';
                }
            } else {
                const pos = this.state.panelPos;
                if (pos && typeof pos.x === 'number') {
                    tool.style.left = pos.x + 'px';
                    tool.style.top = pos.y + 'px';
                    tool.style.right = 'auto';
                    tool.style.bottom = 'auto';
                } else {
                    // 기본: 하단 중앙
                    tool.style.left = '50%';
                    tool.style.bottom = '20px';
                    tool.style.transform = 'translateX(-50%)';
                    tool.style.right = 'auto';
                    tool.style.top = 'auto';
                }
            }
        }

        clampPos(x, y, w = 60, h = 60) {
            const vw = window.innerWidth, vh = window.innerHeight;
            return {
                x: Math.max(0, Math.min(vw - w, x)),
                y: Math.max(0, Math.min(vh - h, y))
            };
        }

        // ─── 메인 렌더 ─────────────────────────
        render() {
            const tool = this.dom.tool;
            if (!tool) return;

            if (this.state.scale === 'icon') {
                tool.className = 'picky-tool picky-icon';
                tool.innerHTML = `
                    <button class="picky-icon-btn" data-act="cycleSize" title="Picky 열기" aria-label="Picky 열기">
                        ${ICON_TARGET}
                    </button>`;
                tool.style.transform = '';
                this.attachRefs();
                return;
            }

            tool.className = 'picky-tool picky-panel';
            tool.innerHTML = this.getFullLayout();
            this.attachRefs();
            this.renderCandidates();
        }

        // ─── 패널 레이아웃 ─────────────────────
        getFullLayout() {
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            const agg = Blocker.isAggressive();
            return `
            <div class="picky-head" data-drag="1">
                <span class="picky-title">Picky <small>v3.6.0</small></span>
                <div class="picky-head-btns">
                    <button class="picky-btn picky-btn-icon" data-act="settings" title="설정">${ICON_SET}</button>
                    <button class="picky-btn picky-btn-icon" data-act="cycleSize" title="최소화">${ICON_MIN}</button>
                    <button class="picky-btn picky-btn-icon" data-act="terminate" title="닫기">${ICON_CLOSE}</button>
                </div>
            </div>

            <div class="picky-body">
                <div class="picky-row picky-mode-row">
                    <button class="picky-btn picky-btn-primary" data-act="startPick">
                        ${ICON_TARGET}<span>요소 선택</span>
                    </button>
                    <button class="picky-btn" data-act="suggestAds" title="광고 자동 탐지">
                        🔍 광고 탐지
                    </button>
                </div>

                <div class="picky-disp-wrap">
                    <div class="picky-disp" data-ref="disp">요소를 선택하세요</div>
                    <div class="picky-meta">
                        <span data-ref="match">매치 0개</span>
                        <span class="picky-stats">규칙 ${stats.ruleCount}개 (전체 ${stats.totalRules})</span>
                    </div>
                </div>

                <div class="picky-nav-row">
                    <button class="picky-btn picky-btn-icon" data-act="navUp" title="상위 요소">${ICON_UP}</button>
                    <input type="range" class="picky-slider" data-ref="slider" min="0" max="0" value="0" />
                    <button class="picky-btn picky-btn-icon" data-act="navDown" title="하위 요소">${ICON_DOWN}</button>
                </div>

                <div class="picky-cards-scroll" data-ref="cardsScroll">
                    <div class="picky-cards-empty">요소 선택 후 후보 규칙이 표시됩니다</div>
                </div>

                <div class="picky-action-row">
                    <button class="picky-btn picky-btn-danger" data-act="blockSelected">
                        ${ICON_BLOCK}<span>차단</span>
                    </button>
                    <button class="picky-btn" data-act="copySelected" title="CSS 복사">${ICON_COPY}</button>
                    <button class="picky-btn" data-act="editSelector" title="편집">${ICON_EDIT}</button>
                    <button class="picky-btn" data-act="showRules" title="규칙 목록">📋</button>
                </div>

                <div class="picky-toggle-row">
                    <label class="picky-toggle">
                        <input type="checkbox" data-act="toggleEnabled" ${enabled ? 'checked' : ''}>
                        <span>차단 활성</span>
                    </label>
                    <label class="picky-toggle">
                        <input type="checkbox" data-act="toggleAggressive" ${agg ? 'checked' : ''}>
                        <span>강화 모드</span>
                    </label>
                </div>
            </div>`;
        }

        // ─── DOM 참조 ──────────────────────────
        attachRefs() {
            const t = this.dom.tool;
            this.dom.disp = t.querySelector('[data-ref="disp"]');
            this.dom.match = t.querySelector('[data-ref="match"]');
            this.dom.slider = t.querySelector('[data-ref="slider"]');
            this.dom.cardsScroll = t.querySelector('[data-ref="cardsScroll"]');

            // 액션 바인딩
            t.querySelectorAll('[data-act]').forEach(el => {
                const act = el.getAttribute('data-act');
                const evt = el.tagName === 'INPUT' && el.type === 'checkbox' ? 'change' : 'click';
                el.addEventListener(evt, (e) => {
                    e.stopPropagation();
                    this.triggerAction(act, el, e);
                });
            });

            // 슬라이더
            this.dom.slider?.addEventListener('input', (e) => {
                e.stopPropagation();
                this.handleSlide(parseInt(e.target.value, 10));
            });
            // 슬라이더가 패널 드래그 트리거 못하게
            this.dom.slider?.addEventListener('pointerdown', (e) => e.stopPropagation());
        }

        // ─── 후보 카드 렌더 ────────────────────
        renderCandidates() {
            const wrap = this.dom.cardsScroll;
            if (!wrap) return;
            const list = this.state.candidates;
            if (!list.length) {
                wrap.innerHTML = '<div class="picky-cards-empty">요소 선택 후 후보 규칙이 표시됩니다</div>';
                return;
            }

            wrap.innerHTML = list.map((c, i) => this.renderCard(c, i)).join('');

            // 카드 이벤트
            wrap.querySelectorAll('.picky-card').forEach(card => {
                const idx = parseInt(card.dataset.idx, 10);
                card.addEventListener('mouseenter', () => this.previewCandidate(idx));
                card.addEventListener('mouseleave', () => this.clearPreview());
                card.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    this.selectCandidate(idx);
                });
            });
            wrap.querySelectorAll('.picky-card-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.closest('.picky-card').dataset.idx, 10);
                    const act = btn.dataset.cardAct;
                    this.handleCardAction(act, idx);
                });
            });
        }

        renderCard(c, idx) {
            const isSelected = idx === this.state.selectedIdx;
            const recommended = c.recommended ? '<span class="picky-badge">추천</span>' : '';
            const filterText = SelectorStrategies.toAdGuardRule(c);
            const isNet = c.isNetwork;

            return `
            <div class="picky-card ${isSelected ? 'is-selected' : ''} ${isNet ? 'is-network' : ''}" data-idx="${idx}">
                <div class="picky-card-head">
                    <span class="picky-card-icon">${c.icon || '•'}</span>
                    <span class="picky-card-label">${esc(c.label)}</span>
                    ${recommended}
                    <span class="picky-card-stars" title="${c.score}점">${c.stars || ''}</span>
                </div>
                <div class="picky-card-filter" title="AdGuard/uBlock 호환 규칙">${esc(filterText)}</div>
                <div class="picky-card-css" title="CSS 셀렉터 (참고)">
                    <span class="picky-card-css-label">CSS:</span>
                    <span class="picky-card-css-text">${esc(c.selector)}</span>
                    <span class="picky-card-matches">·${c.matches}개</span>
                </div>
                <div class="picky-card-hint">${esc(c.hint || '')}</div>
                <div class="picky-card-btns">
                    ${isNet
                        ? `<button class="picky-card-btn picky-card-btn-disabled" disabled title="네트워크 필터는 CSS로 차단 불가">⛔ 차단</button>`
                        : `<button class="picky-card-btn picky-card-btn-block" data-card-act="block">⛔ 차단</button>`
                    }
                    <button class="picky-card-btn" data-card-act="copyFilter" title="AdGuard/uBlock 규칙 복사">📋 필터</button>
                    ${isNet ? '' : `<button class="picky-card-btn" data-card-act="copyCss" title="CSS 셀렉터 복사">📋 CSS</button>`}
                </div>
            </div>`;
        }

        // ─── 카드별 액션 ───────────────────────
        async handleCardAction(act, idx) {
            const c = this.state.candidates[idx];
            if (!c) return;

            if (act === 'block') {
                if (c.isNetwork) return;
                if (Blocker.append(c.selector)) {
                    this.flashToast(`차단: ${c.selector.slice(0, 50)}`);
                    this.refreshMetrics();
                    this.render();
                } else {
                    this.flashToast('이미 등록된 규칙');
                }
            } else if (act === 'copyFilter') {
                const text = SelectorStrategies.toAdGuardRule(c);
                await this.copyText(text);
                this.flashToast('필터 규칙 복사됨');
            } else if (act === 'copyCss') {
                await this.copyText(c.selector);
                this.flashToast('CSS 셀렉터 복사됨');
            }
        }

        async copyText(text) {
            try { await navigator.clipboard.writeText(text); }
            catch (_) {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
        }

        flashToast(msg) {
            const t = document.createElement('div');
            t.className = 'picky-toast';
            t.textContent = msg;
            this.dom.shadow.appendChild(t);
            setTimeout(() => t.classList.add('visible'), 10);
            setTimeout(() => {
                t.classList.remove('visible');
                setTimeout(() => t.remove(), 200);
            }, 1800);
        }

        // ─── 후보 미리보기 ─────────────────────
        previewCandidate(idx) {
            this.clearPreview();
            const c = this.state.candidates[idx];
            if (!c || !c.selector) return;
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(c.selector)); }
            catch (_) { return; }
            for (const n of nodes) n.classList.add('picky-hl-preview');
            this.state.hoverPreviewNodes = nodes;
            if (nodes[0]) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        clearPreview() {
            for (const n of this.state.hoverPreviewNodes) n.classList.remove('picky-hl-preview');
            this.state.hoverPreviewNodes = [];
        }

        // ─── 후보 선택 ─────────────────────────
        selectCandidate(idx) {
            this.state.selectedIdx = idx;
            const c = this.state.candidates[idx];
            if (!c) return;
            if (!c.isNetwork) {
                this.state.queryData.selector = c.selector;
            }
            this.refreshMetrics();
            this.renderCandidates();
        }

        // ─── 메트릭 갱신 ──────────────────────
        refreshMetrics() {
            const disp = this.dom.disp;
            const match = this.dom.match;
            const sel = this.state.queryData.selector;
            if (disp) disp.textContent = sel || '요소를 선택하세요';
            if (match) {
                const n = sel ? SelectorStrategies.countMatches(sel) : 0;
                match.textContent = `매치 ${n}개`;
            }

            // 통계 업데이트
            const stats = Blocker.getStats();
            const statsEl = this.dom.tool?.querySelector('.picky-stats');
            if (statsEl) statsEl.textContent = `규칙 ${stats.ruleCount}개 (전체 ${stats.totalRules})`;
        }

        // ─── 슬라이더 (계층 이동) ───────────────
        calcSliderLimits() {
            if (!this.state.originTarget) return;
            // 상위로 가는 경로
            const upChain = [];
            let cur = this.state.originTarget.parentElement;
            while (cur && cur !== document.body) {
                upChain.push(cur);
                cur = cur.parentElement;
                if (upChain.length > 20) break;
            }
            // 하위로 가는 경로 (현재 target에서 첫 자식 따라가기)
            const downChain = [];
            let d = this.state.originTarget;
            while (d.firstElementChild) {
                downChain.push(d.firstElementChild);
                d = d.firstElementChild;
                if (downChain.length > 20) break;
            }
            this.state.hierarchy = [...upChain.reverse(), this.state.originTarget, ...downChain];
            const slider = this.dom.slider;
            if (slider) {
                slider.min = 0;
                slider.max = this.state.hierarchy.length - 1;
                slider.value = upChain.length; // origin 위치
            }
        }

        handleSlide(idx) {
            const node = this.state.hierarchy[idx];
            if (!node) return;
            this.selectNode(node, /*updateOrigin*/ false);
        }

        // ─── 요소 선택 ─────────────────────────
        selectNode(el, updateOrigin = true) {
            if (!el || !el.tagName) return;
            this.state.target = el;
            if (updateOrigin) {
                this.state.originTarget = el;
                this.calcSliderLimits();
            }
            // 후보 생성
            this.state.candidates = SelectorStrategies.buildAll(el, this._preciseEvaluator);
            this.state.selectedIdx = this.state.candidates.findIndex(c => c.recommended);
            if (this.state.selectedIdx >= 0) {
                const rec = this.state.candidates[this.state.selectedIdx];
                if (!rec.isNetwork) this.state.queryData.selector = rec.selector;
            }
            this.refreshMetrics();
            this.renderCandidates();
            // 하이라이트
            this.setFocus(el);
        }

        setFocus(el) {
            this.dropFocus();
            if (!el) return;
            el.classList.add(HL_CLASS);
            this.state.previewNodes = [el];
        }
        dropFocus() {
            for (const n of this.state.previewNodes) n.classList.remove(HL_CLASS);
            this.state.previewNodes = [];
        }

        // ─── 픽킹 모드 ────────────────────────
        startPicking() {
            this.state.mode = 'picking';
            if (!this.overlay) {
                this.overlay = (e) => this.onPickClick(e);
                document.addEventListener('click', this.overlay, true);
            }
            this.flashToast('요소를 클릭하세요 (ESC: 취소)');
            this._escHandler = (e) => { if (e.key === 'Escape') this.stopPicking(); };
            document.addEventListener('keydown', this._escHandler, true);
        }
        stopPicking() {
            this.state.mode = 'selected';
            if (this.overlay) {
                document.removeEventListener('click', this.overlay, true);
                this.overlay = null;
            }
            if (this._escHandler) {
                document.removeEventListener('keydown', this._escHandler, true);
                this._escHandler = null;
            }
        }
        onPickClick(e) {
            const path = e.composedPath ? e.composedPath() : [e.target];
            // Picky UI 클릭은 무시
            if (path.some(n => n?.id === ROOT_ID)) return;
            e.preventDefault();
            e.stopPropagation();
            this.selectNode(e.target, true);
            this.stopPicking();
        }

        // ─── 액션 디스패치 ─────────────────────
        triggerAction(act, el, evt) {
            switch (act) {
                case 'cycleSize': this.cycleSize(); break;
                case 'terminate': this.terminate(); break;
                case 'settings':  this.showSettings(); break;
                case 'startPick': this.startPicking(); break;
                case 'suggestAds': this.suggestAds(); break;
                case 'navUp': {
                    const p = this.resolveParent(this.state.target);
                    if (p) this.selectNode(p, false);
                    break;
                }
                case 'navDown': {
                    const c = this.resolveChildren(this.state.target)[0];
                    if (c) this.selectNode(c, false);
                    break;
                }
                case 'blockSelected': {
                    const c = this.state.candidates[this.state.selectedIdx];
                    if (c) this.handleCardAction('block', this.state.selectedIdx);
                    else if (this.state.queryData.selector) {
                        if (Blocker.append(this.state.queryData.selector)) {
                            this.flashToast('차단 규칙 추가');
                            this.refreshMetrics();
                        }
                    }
                    break;
                }
                case 'copySelected': {
                    const c = this.state.candidates[this.state.selectedIdx];
                    if (c) this.handleCardAction('copyCss', this.state.selectedIdx);
                    else if (this.state.queryData.selector) {
                        this.copyText(this.state.queryData.selector);
                        this.flashToast('CSS 복사됨');
                    }
                    break;
                }
                case 'editSelector': this.editSelector(); break;
                case 'showRules': this.showRules(); break;
                case 'toggleEnabled': Blocker.toggleEnabled(); this.refreshMetrics(); break;
                case 'toggleAggressive': Blocker.toggleAggressive(); break;
            }
        }

        cycleSize() {
            if (this.state.scale === 'icon') this.state.scale = 'full';
            else this.state.scale = 'icon';
            this.render();
            this.applyPosition();
        }

        // ─── 셀렉터 수동 편집 ─────────────────
        editSelector() {
            const cur = this.state.queryData.selector || '';
            const body = this.modal.display('셀렉터 편집', '', true);
            body.innerHTML = `
                <div>아래에서 CSS 셀렉터를 직접 수정하고 [적용]을 누르세요.</div>
                <textarea class="picky-modal-input" rows="3">${esc(cur)}</textarea>
                <div class="picky-modal-meta" data-ref="prev">매치 0개</div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="apply">적용</button>
                    <button class="picky-btn picky-btn-danger" data-ref="blk">차단 추가</button>
                </div>`;
            const ta = body.querySelector('textarea');
            const prev = body.querySelector('[data-ref="prev"]');
            const update = () => {
                const n = SelectorStrategies.countMatches(ta.value);
                prev.textContent = `매치 ${n}개`;
            };
            ta.addEventListener('input', update);
            update();
            body.querySelector('[data-ref="apply"]').addEventListener('click', () => {
                this.state.queryData.selector = ta.value.trim();
                this.refreshMetrics();
                this.modal.dismiss();
            });
            body.querySelector('[data-ref="blk"]').addEventListener('click', () => {
                const v = ta.value.trim();
                if (v && Blocker.append(v)) {
                    this.flashToast('차단 규칙 추가');
                    this.refreshMetrics();
                }
                this.modal.dismiss();
            });
        }

        // ─── 규칙 목록 ─────────────────────────
        showRules() {
            const rules = Blocker.fetch();
            const body = this.modal.display(`차단 규칙 (${rules.length})`, '', true);
            body.innerHTML = `
                <div class="picky-rules-list">
                    ${rules.length ? rules.map((r, i) => `
                        <div class="picky-rule-item">
                            <code>${esc(r)}</code>
                            <button class="picky-btn picky-btn-icon" data-ridx="${i}" title="삭제">${ICON_CLOSE}</button>
                        </div>`).join('') : '<div class="picky-cards-empty">등록된 규칙이 없습니다</div>'}
                </div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="exportFilter">📋 AdGuard 필터 복사</button>
                    <button class="picky-btn" data-ref="exportJson">📥 JSON 내보내기</button>
                    <button class="picky-btn picky-btn-danger" data-ref="clear">전체 삭제</button>
                </div>`;
            body.querySelectorAll('[data-ridx]').forEach(b => {
                b.addEventListener('click', () => {
                    Blocker.drop(rules[parseInt(b.dataset.ridx)]);
                    this.showRules();
                    this.refreshMetrics();
                });
            });
            body.querySelector('[data-ref="exportFilter"]').addEventListener('click', async () => {
                await Blocker.copyFilterText();
                this.flashToast('AdGuard/uBlock 필터 복사됨');
            });
            body.querySelector('[data-ref="exportJson"]').addEventListener('click', () => {
                Blocker.exportJSON();
            });
            body.querySelector('[data-ref="clear"]').addEventListener('click', () => {
                if (confirm('이 사이트의 모든 규칙을 삭제할까요?')) {
                    Blocker.clear();
                    this.modal.dismiss();
                    this.refreshMetrics();
                }
            });
        }

        // ─── 설정 ──────────────────────────────
        showSettings() {
            const body = this.modal.display('설정', '', true);
            const stats = Blocker.getStats();
            body.innerHTML = `
                <div class="picky-settings">
                    <div class="picky-settings-row">
                        <span>전체 통계</span>
                        <span>${stats.totalSites}개 사이트 / ${stats.totalRules}개 규칙</span>
                    </div>
                    <div class="picky-settings-row">
                        <button class="picky-btn" data-ref="resetPos">위치 초기화</button>
                        <button class="picky-btn" data-ref="importJson">📤 JSON 가져오기</button>
                        <input type="file" data-ref="fileIn" accept="application/json" hidden>
                    </div>
                    <div class="picky-settings-row">
                        <button class="picky-btn" data-ref="undo">↶ 마지막 작업 취소</button>
                    </div>
                </div>`;
            body.querySelector('[data-ref="resetPos"]').addEventListener('click', () => {
                GM_setValue('picky_icon_pos', null);
                GM_setValue('picky_panel_pos', null);
                this.state.iconPos = null;
                this.state.panelPos = null;
                this.applyPosition();
                this.flashToast('위치 초기화됨');
            });
            const fileIn = body.querySelector('[data-ref="fileIn"]');
            body.querySelector('[data-ref="importJson"]').addEventListener('click', () => fileIn.click());
            fileIn.addEventListener('change', async (e) => {
                const f = e.target.files[0];
                if (!f) return;
                try {
                    await Blocker.importJSON(f);
                    this.flashToast('가져오기 완료');
                    this.refreshMetrics();
                } catch (err) {
                    this.flashToast('가져오기 실패: ' + err.message);
                }
            });
            body.querySelector('[data-ref="undo"]').addEventListener('click', () => {
                const last = Blocker.undoLast();
                if (last) this.flashToast(`복원: ${last.act} ${last.sel.slice(0, 30)}`);
                this.refreshMetrics();
            });
        }

        // ─── 광고 자동 탐지 ─────────────────────
        suggestAds() {
            const candidates = [];
            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement'];

            // 1) 클래스/ID에 광고 키워드
            document.querySelectorAll('div, section, aside, ins').forEach(el => {
                const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
                const id = (el.id || '').toLowerCase();
                if (adKeywords.some(k => cls.includes(k) || id.includes(k))) {
                    candidates.push(el);
                }
            });

            // 2) 광고 네트워크 호스트 이미지/iframe
            document.querySelectorAll('img[src], iframe[src]').forEach(el => {
                const src = el.getAttribute('src') || '';
                if (AD_NETWORK_HOSTS.some(h => src.includes(h))) candidates.push(el);
            });

            // 3) 표준 광고 크기 이미지
            document.querySelectorAll('img').forEach(el => {
                const w = parseInt(el.getAttribute('width')) || el.naturalWidth;
                const h = parseInt(el.getAttribute('height')) || el.naturalHeight;
                if (IAB_AD_SIZES.some(([sw, sh]) => Math.abs(sw - w) <= 5 && Math.abs(sh - h) <= 5)) {
                    candidates.push(el);
                }
            });

            const unique = Array.from(new Set(candidates));
            if (!unique.length) {
                this.flashToast('광고 후보를 찾지 못했습니다');
                return;
            }
            const body = this.modal.display(`광고 후보 ${unique.length}개`, '', true);
            body.innerHTML = `
                <div class="picky-ad-list">
                    ${unique.slice(0, 50).map((el, i) => {
                        const tag = el.tagName.toLowerCase();
                        const id = el.id ? `#${el.id}` : '';
                        const cls = SelectorStrategies.meaningfulClasses(el).slice(0, 2).map(c => '.' + c).join('');
                        return `
                        <div class="picky-ad-item" data-aidx="${i}">
                            <code>${esc(tag + id + cls)}</code>
                            <div class="picky-ad-btns">
                                <button class="picky-btn picky-btn-icon" data-aact="pick">${ICON_TARGET}</button>
                            </div>
                        </div>`;
                    }).join('')}
                </div>`;
            body.querySelectorAll('[data-aidx]').forEach(item => {
                const i = parseInt(item.dataset.aidx);
                const el = unique[i];
                item.querySelector('[data-aact="pick"]').addEventListener('click', () => {
                    this.modal.dismiss();
                    this.selectNode(el, true);
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                item.addEventListener('mouseenter', () => el.classList.add('picky-hl-preview'));
                item.addEventListener('mouseleave', () => el.classList.remove('picky-hl-preview'));
            });
        }

        // ─── 드래그 핸들링 ─────────────────────
        attachDragHandlers() {
            const tool = this.dom.tool;
            if (!tool) return;
            let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false, active = false;

            const onDown = (e) => {
                if (e.target.closest(NO_DRAG_SELECTOR)) return;
                if (this.state.scale !== 'icon' && !e.target.closest('[data-drag="1"]')) return;
                active = true;
                moved = false;
                const r = tool.getBoundingClientRect();
                startX = e.clientX; startY = e.clientY;
                startLeft = r.left; startTop = r.top;
                tool.style.transform = '';
                tool.style.left = startLeft + 'px';
                tool.style.top = startTop + 'px';
                tool.style.right = 'auto';
                tool.style.bottom = 'auto';
                tool.setPointerCapture?.(e.pointerId);
            };
            const onMove = (e) => {
                if (!active) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
                if (moved) {
                    const w = tool.offsetWidth, h = tool.offsetHeight;
                    const p = this.clampPos(startLeft + dx, startTop + dy, w, h);
                    tool.style.left = p.x + 'px';
                    tool.style.top = p.y + 'px';
                }
            };
            const onUp = (e) => {
                if (!active) return;
                active = false;
                if (moved) {
                    const r = tool.getBoundingClientRect();
                    const pos = { x: r.left, y: r.top };
                    if (this.state.scale === 'icon') {
                        this.state.iconPos = pos;
                        GM_setValue('picky_icon_pos', pos);
                    } else {
                        this.state.panelPos = pos;
                        GM_setValue('picky_panel_pos', pos);
                    }
                    e.stopPropagation();
                    e.preventDefault();
                }
                tool.releasePointerCapture?.(e.pointerId);
            };
            tool.addEventListener('pointerdown', onDown);
            tool.addEventListener('pointermove', onMove);
            tool.addEventListener('pointerup', onUp);
            tool.addEventListener('pointercancel', onUp);
        }

        // ─── 종료 / 부팅 ──────────────────────
        launch() {
            this.constructUI();
        }
        terminate() {
            this.dropFocus();
            this.clearPreview();
            this.stopPicking?.();
            if (this.dom.host) this.dom.host.remove();
            this.dom = {};
        }
    }

    // ───────────────────────────────────────────────
    // Picky CSS (Shadow DOM 내부)
    // ───────────────────────────────────────────────
    const PICKY_CSS = `
    :host, * { box-sizing: border-box; }
    .picky-tool {
        position: fixed;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #e8eaed;
        z-index: 2147483647;
    }
    .picky-icon {
        width: 48px; height: 48px;
        right: 20px; bottom: 20px;
    }
    .picky-icon-btn {
        width: 100%; height: 100%;
        border: none; border-radius: 50%;
        background: linear-gradient(135deg, #3b82f6, #1e40af);
        color: #fff; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        display: flex; align-items: center; justify-content: center;
    }
    .picky-icon-btn:hover { transform: scale(1.06); }

    .picky-panel {
        width: 380px;
        background: rgba(28, 30, 38, 0.97);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,.45);
        backdrop-filter: blur(8px);
        overflow: hidden;
    }
    .picky-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px;
        background: rgba(0,0,0,0.25);
        cursor: grab;
        user-select: none;
    }
    .picky-head:active { cursor: grabbing; }
    .picky-title { font-weight: 600; font-size: 14px; }
    .picky-title small { opacity: 0.5; font-weight: 400; margin-left: 4px; }
    .picky-head-btns { display: flex; gap: 4px; }

    .picky-body { padding: 10px 12px 12px; }
    .picky-row { display: flex; gap: 6px; margin-bottom: 8px; }
    .picky-mode-row .picky-btn-primary { flex: 1; }

    .picky-btn {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
        color: #e8eaed; border-radius: 6px;
        cursor: pointer; font-size: 12px;
        transition: all 0.15s;
    }
    .picky-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-btn-icon { padding: 6px; }
    .picky-btn-primary {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        border-color: transparent; justify-content: center;
    }
    .picky-btn-primary:hover { background: linear-gradient(135deg, #4b8bf6, #3573f6); }
    .picky-btn-danger {
        background: linear-gradient(135deg, #ef4444, #b91c1c);
        border-color: transparent;
    }

    .picky-disp-wrap {
        background: rgba(0,0,0,0.3);
        border-radius: 6px;
        padding: 8px 10px;
        margin-bottom: 8px;
    }
    .picky-disp {
        font-family: ui-monospace, "SF Mono", Monaco, monospace;
        font-size: 11px;
        word-break: break-all;
        color: #9ecbff;
        line-height: 1.4;
        max-height: 40px;
        overflow-y: auto;
    }
    .picky-meta {
        display: flex; justify-content: space-between;
        font-size: 10px; opacity: 0.65;
        margin-top: 4px;
    }

    .picky-nav-row {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 10px;
    }
    .picky-slider {
        flex: 1;
        -webkit-appearance: none; appearance: none;
        height: 4px; background: rgba(255,255,255,0.15);
        border-radius: 2px; outline: none;
    }
    .picky-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 14px; height: 14px;
        background: #3b82f6; border-radius: 50%; cursor: pointer;
    }

    /* 카드 리스트 (스크롤 영역) */
    .picky-cards-scroll {
        max-height: 240px;
        overflow-y: auto;
        overflow-x: hidden;
        scroll-snap-type: y proximity;
        margin-bottom: 10px;
        border-radius: 8px;
        background: rgba(0,0,0,0.2);
        padding: 6px;
    }
    .picky-cards-scroll::-webkit-scrollbar { width: 6px; }
    .picky-cards-scroll::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.2); border-radius: 3px;
    }
    .picky-cards-empty {
        text-align: center; opacity: 0.4;
        padding: 24px 12px; font-size: 12px;
    }
    .picky-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 6px;
        scroll-snap-align: start;
        cursor: pointer;
        transition: all 0.15s;
    }
    .picky-card:hover {
        background: rgba(255,255,255,0.08);
        border-color: rgba(59, 130, 246, 0.4);
    }
    .picky-card.is-selected {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.6);
    }
    .picky-card.is-network {
        background: rgba(168, 85, 247, 0.08);
        border-color: rgba(168, 85, 247, 0.3);
    }
    .picky-card-head {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 4px;
    }
    .picky-card-icon { font-size: 14px; }
    .picky-card-label { font-weight: 600; font-size: 12px; flex: 1; }
    .picky-card-stars {
        font-size: 10px; color: #fbbf24; letter-spacing: 1px;
    }
    .picky-badge {
        background: linear-gradient(135deg, #f59e0b, #d97706);
        color: #fff; font-size: 9px; padding: 1px 6px;
        border-radius: 8px; font-weight: 700;
    }
    .picky-card-filter {
        font-family: ui-monospace, "SF Mono", Monaco, monospace;
        font-size: 11px;
        color: #c4b5fd;
        background: rgba(0,0,0,0.35);
        padding: 5px 7px;
        border-radius: 4px;
        word-break: break-all;
        margin-bottom: 4px;
        line-height: 1.4;
    }
    .picky-card-css {
        font-size: 10.5px;
        font-family: ui-monospace, monospace;
        opacity: 0.75;
        margin-bottom: 4px;
        word-break: break-all;
    }
    .picky-card-css-label { color: #6ee7b7; margin-right: 4px; }
    .picky-card-css-text { color: #9ecbff; }
    .picky-card-matches { opacity: 0.55; margin-left: 4px; }
    .picky-card-hint {
        font-size: 10px; opacity: 0.55; margin-bottom: 6px;
    }
    .picky-card-btns { display: flex; gap: 4px; flex-wrap: wrap; }
    .picky-card-btn {
        flex: 1;
        padding: 4px 6px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
        color: #e8eaed; border-radius: 4px;
        cursor: pointer; font-size: 10.5px;
        min-width: 0;
    }
    .picky-card-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-card-btn-block { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.3); }
    .picky-card-btn-block:hover { background: rgba(239, 68, 68, 0.35); }
    .picky-card-btn-disabled {
        opacity: 0.35; cursor: not-allowed;
    }
    .picky-card-btn-disabled:hover { background: rgba(255,255,255,0.08); }

    .picky-action-row {
        display: flex; gap: 6px; margin-bottom: 8px;
    }
    .picky-action-row .picky-btn-danger { flex: 1; justify-content: center; }

    .picky-toggle-row {
        display: flex; gap: 12px; font-size: 11px;
        padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);
    }
    .picky-toggle {
        display: inline-flex; align-items: center; gap: 5px;
        cursor: pointer;
    }
    .picky-toggle input { cursor: pointer; }

    /* 모달 */
    .picky-modal {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
        opacity: 0; transition: opacity 0.2s;
    }
    .picky-modal.visible { opacity: 1; }
    .picky-modal-card {
        background: #1c1e26;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        max-width: 520px; width: 90%;
        max-height: 80vh; overflow: hidden;
        display: flex; flex-direction: column;
    }
    .picky-modal-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .picky-modal-title { font-weight: 600; }
    .picky-modal-x {
        background: transparent; border: none; color: #e8eaed;
        cursor: pointer; padding: 4px;
    }
    .picky-modal-body {
        padding: 14px;
        overflow-y: auto;
        font-size: 13px;
    }
    .picky-modal-input {
        width: 100%;
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        color: #9ecbff;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        padding: 8px;
        border-radius: 6px;
        margin: 8px 0;
        resize: vertical;
    }
    .picky-modal-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    .picky-modal-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

    .picky-rules-list {
        max-height: 320px; overflow-y: auto;
    }
    .picky-rule-item {
        display: flex; justify-content: space-between; align-items: center;
        gap: 8px; padding: 6px 8px;
        background: rgba(255,255,255,0.04);
        border-radius: 5px; margin-bottom: 4px;
    }
    .picky-rule-item code {
        font-size: 11px; color: #9ecbff;
        word-break: break-all; flex: 1;
    }

    .picky-ad-list { max-height: 340px; overflow-y: auto; }
    .picky-ad-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 8px;
        background: rgba(255,255,255,0.04);
        border-radius: 5px; margin-bottom: 4px;
    }
    .picky-ad-item:hover { background: rgba(59,130,246,0.15); }
    .picky-ad-item code { font-size: 11px; color: #9ecbff; }

    .picky-settings-row {
        display: flex; gap: 8px; align-items: center;
        padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-wrap: wrap;
    }
    .picky-settings-row:last-child { border-bottom: none; }

    /* 토스트 */
    .picky-toast {
        position: fixed;
        bottom: 80px; left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: rgba(17, 24, 39, 0.95);
        color: #fff; padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        opacity: 0;
        transition: all 0.25s;
        z-index: 2147483647;
        pointer-events: none;
    }
    .picky-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
    `;

    // ───────────────────────────────────────────────
    // 페이지 내 글로벌 CSS (하이라이트)
    // ───────────────────────────────────────────────
    const PAGE_CSS = `
    .${HL_CLASS} {
        outline: 2px solid #3b82f6 !important;
        outline-offset: 2px !important;
        background: rgba(59,130,246,0.08) !important;
    }
    .picky-hl-preview {
        outline: 2px dashed #f59e0b !important;
        outline-offset: 2px !important;
    }`;
    const injectPageCss = () => {
        if (document.getElementById('picky-page-css')) return;
        const s = document.createElement('style');
        s.id = 'picky-page-css';
        s.textContent = PAGE_CSS;
        (document.head || document.documentElement).appendChild(s);
    };

    // ───────────────────────────────────────────────
    // 부팅
    // ───────────────────────────────────────────────
    let inspector = null;
    const boot = () => {
        if (inspector) return;
        injectPageCss();
        inspector = new Inspector();
        inspector.launch();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    // 메뉴 명령
    try {
        GM_registerMenuCommand?.('Picky 열기/숨기기', () => {
            if (inspector) { inspector.terminate(); inspector = null; }
            else boot();
        });
        GM_registerMenuCommand?.('규칙 JSON 내보내기', () => Blocker.exportJSON());
        GM_registerMenuCommand?.('AdGuard 필터 복사', async () => {
            await Blocker.copyFilterText();
        });
        GM_registerMenuCommand?.('위치 초기화', () => {
            GM_setValue('picky_icon_pos', null);
            GM_setValue('picky_panel_pos', null);
            if (inspector) inspector.applyPosition();
        });
    } catch (_) {}

})();
