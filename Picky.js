// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/hooray804/Picky
// @version      3.6.5
// @description  요소 선택 기반 광고/요소 차단기 — AdGuard/uBlock 호환 규칙 생성, 카드 리스트 UI, 실시간 미리보기 + 숨김 토글 + 유일 타겟팅 경로
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
    const HIDE_CLASS = 'picky-hidden-preview';
    const DRAG_THRESHOLD = 6;

    const NO_DRAG_SELECTOR = [
        'input', 'textarea', 'select', 'button', 'a',
        '[role="slider"]', '[contenteditable="true"]',
        '.picky-card', '.picky-card *', '.picky-slider',
        '.picky-modal', '.picky-modal *', '.picky-btn',
        '.picky-cards-scroll', '.picky-cards-scroll *'
    ].join(',');

    const SUPPORTS_HAS = (() => {
        try { document.querySelector(':has(*)'); return true; }
        catch (_) { return false; }
    })();

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
        { kw: 'doubleclick',       desc: 'DoubleClick' },
        { kw: 'googlesyndication', desc: 'Google Syndication' },
        { kw: 'googleadservices',  desc: 'Google Ad Services' },
        { kw: '/click?',           desc: '클릭 추적' },
        { kw: '/redirect',         desc: '리다이렉트' },
        { kw: 'utm_source=ad',     desc: 'UTM 광고' },
        { kw: 'utm_medium=cpc',    desc: 'CPC 캠페인' },
        { kw: 'adclick',           desc: '광고 클릭' },
        { kw: '//ad.',             desc: '광고 서브도메인' },
        { kw: '//ads.',            desc: '광고 서브도메인' },
        { kw: 'taboola',           desc: 'Taboola' },
        { kw: 'outbrain',          desc: 'Outbrain' },
        { kw: 'criteo',            desc: 'Criteo' },
        { kw: '/track',            desc: '트래킹' }
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

    const DUMMY_HREF_VALUES = new Set([
        'javascript:;', 'javascript:void(0)', 'javascript:void(0);',
        '#', '#!', 'about:blank', ''
    ]);

    const ARIA_AD_KEYWORDS = [
        '광고', '배너', 'AD', 'ad', 'Ad', 'banner', 'Banner',
        'advertisement', 'sponsor', 'promotion', '프로모션', '스폰서'
    ];

    const AD_FILE_EXTS = ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg'];

    // ───────────────────────────────────────────────
    // SVG 아이콘
    // ───────────────────────────────────────────────
    const ICON_CLOSE   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    const ICON_SET     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94a7.96 7.96 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a8.13 8.13 0 00-1.62-.94l-.36-2.54A.5.5 0 0014 2h-4a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.6 8.48a.5.5 0 00.12.64l2.03 1.58a7.96 7.96 0 000 1.88L2.72 14.16a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54A.5.5 0 0010 22h4a.5.5 0 00.5-.42l.36-2.54a8.13 8.13 0 001.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
    const ICON_MIN     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13H5v-2h14v2z"/></svg>';
    const ICON_COPY    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>';
    const ICON_BLOCK   = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a7.95 7.95 0 01-4.9-1.69L18.31 7.1A7.95 7.95 0 0120 12c0 4.41-3.59 8-8 8z"/></svg>';
    const ICON_EDIT    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    const ICON_UP      = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
    const ICON_DOWN    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
    const ICON_TARGET  = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="2" d="M12 4v3M12 17v3M4 12h3M17 12h3"/></svg>';
    const ICON_EYE     = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>';
    const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';

    // ───────────────────────────────────────────────
    // Blocker
    // ───────────────────────────────────────────────
    const Blocker = {
        STYLE_ID: 'picky-block-style',
        KEY_RULES: 'picky_rules_v2',
        KEY_HIST:  'picky_history_v1',
        KEY_ENABLED: 'picky_enabled',
        KEY_AGG:   'picky_aggressive',

        async init() {
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

        toCosmetic(sel, scope = 'host') {
            if (scope === 'global') return `##${sel}`;
            return `${this.host()}##${sel}`;
        },

        exportJSON() {
            const data = {
                app: 'Picky Advanced',
                version: '3.6.5',
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

        exportFilterText() {
            const all = this.fetchAll();
            const lines = [
                '! Title: Picky Advanced Export',
                `! Version: 3.6.5`,
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
    // Modal
    // ───────────────────────────────────────────────
    class Modal {
        constructor(container) {
            this.container = container;
            this.node = null;
            this._onDismiss = null;
        }

        display(title, body, isHtml = false, extraClass = '', onDismiss = null) {
            this.dismiss();
            this._onDismiss = onDismiss;
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
            if (typeof this._onDismiss === 'function') {
                try { this._onDismiss(); } catch (_) {}
                this._onDismiss = null;
            }
        }
    }

    // ───────────────────────────────────────────────
    // SelectorStrategies
    // ───────────────────────────────────────────────
    class SelectorStrategies {

        static countMatches(sel, root = document) {
            if (!sel) return 0;
            try { return root.querySelectorAll(sel).length; }
            catch (_) { return 0; }
        }

        static isMeaningfulClass(cls) {
            if (!cls || typeof cls !== 'string') return false;
            if (cls.length < 2 || cls.length > 40) return false;
            if (cls.startsWith('picky-')) return false;
            if (cls === HL_CLASS || cls === ISO_PATH || cls === ISO_BODY) return false;
            if (/^(ember|v-|ng-|re-|css-|sc-|jsx-|emotion-|makeStyles-)/.test(cls)) return false;
            if (/^[a-zA-Z0-9_-]{8,}$/.test(cls) && /[0-9]/.test(cls) && /[A-Z]/.test(cls)) return false;
            const volatile = ['active','focus','hover','selected','disabled','checked',
                              'open','closed','expanded','collapsed','loading','transition',
                              'animating','v-enter','v-leave','is-active','is-open'];
            if (volatile.some(v => cls.toLowerCase().includes(v))) return false;
            return true;
        }

        static safeClasses(el) {
            if (!el || !el.classList) return [];
            return Array.from(el.classList).filter(c =>
                !c.startsWith('picky-') &&
                c !== HL_CLASS && c !== ISO_PATH && c !== ISO_BODY
            );
        }

        static meaningfulClasses(el) {
            return this.safeClasses(el).filter(c => this.isMeaningfulClass(c));
        }

        static parentChain(el, maxDepth = 5) {
            const chain = [];
            let cur = el?.parentElement;
            while (cur && cur !== document.body && chain.length < maxDepth) {
                chain.push(cur);
                cur = cur.parentElement;
            }
            return chain;
        }

        static _findImg(el) {
            if (!el) return null;
            if (el.tagName === 'IMG') return el;
            const inside = el.querySelector?.('img');
            if (inside) return inside;
            const a = el.closest?.('a');
            return a?.querySelector?.('img') || null;
        }

        static _findAnchor(el) {
            if (!el) return null;
            if (el.tagName === 'A') return el;
            return el.closest?.('a') || null;
        }

        static isImageRelated(el) {
            return !!this._findImg(el);
        }

        // ── 점수 산정: 성능 + 정확도 + 의도 보너스 ─────────
        static scoreSelector(sel, el, options = {}) {
            if (!sel) return 0;
            const matches = this.countMatches(sel);
            if (matches === 0) return 0;

            try {
                const list = document.querySelectorAll(sel);
                if (el && ![...list].includes(el)) return 0;
            } catch (_) { return 0; }

            // (A) 성능 점수 (최대 60점)
            let perfScore = 0;
            const lastSimple = sel.split(/\s|>|\+|~/).pop().trim();

            if (/^#[\w\\-]+$/.test(lastSimple)) {
                perfScore = 60;
            } else if (/^#[\w\\-]+(?:\.[\w\\-]+)+$/.test(lastSimple)) {
                perfScore = 58;
            } else if (/^[a-z]+\.[\w\\-]+$/i.test(lastSimple)) {
                perfScore = 50;
            } else if (/^\.[\w\\-]+$/.test(lastSimple)) {
                perfScore = 48;
            } else if (/^\.[\w\\-]+(?:\.[\w\\-]+)+$/.test(lastSimple)) {
                perfScore = 46;
            } else if (/\[[a-z-]+="/i.test(lastSimple)) {
                perfScore = 38;
            } else if (/\[[a-z-]+\^="/i.test(lastSimple)) {
                perfScore = 34;
            } else if (/\[[a-z-]+\$="/i.test(lastSimple)) {
                perfScore = 32;
            } else if (/\[[a-z-]+\*="/i.test(lastSimple)) {
                perfScore = 26;
            } else if (/^[a-z]+$/i.test(lastSimple)) {
                perfScore = 32;
            } else {
                perfScore = 20;
            }

            if (/:has\(/.test(sel)) perfScore -= 12;
            if (/:nth-of-type|:nth-child/.test(sel)) perfScore -= 6;
            if (/:nth-of-type\(\d+\).*:nth-of-type/.test(sel)) perfScore -= 6;

            const combinatorCount = (sel.match(/[\s>+~]/g) || []).length;
            if (combinatorCount >= 4) perfScore -= 10;
            else if (combinatorCount >= 2) perfScore -= 4;

            perfScore = Math.max(0, perfScore);

            // (B) 정확도 점수 (최대 42점) — 매치=1을 강하게 우대
            let accScore = 0;
            if (matches === 1) accScore = 42;       // ★★★ 보장
            else if (matches === 2) accScore = 30;
            else if (matches <= 5) accScore = 22;
            else if (matches <= 10) accScore = 16;
            else if (matches <= 30) accScore = 10;
            else if (matches <= 100) accScore = 5;
            else accScore = 2;

            // (C) 의도 보너스
            let intentBonus = 0;
            if (/\[(?:data-ad|data-advertisement)/i.test(sel)) intentBonus += 4;
            if (/aria-label\*?="[^"]*(?:광고|ad|banner)/i.test(sel)) intentBonus += 3;
            if (options.bonus) intentBonus += options.bonus;

            const total = perfScore + accScore + intentBonus;
            return Math.max(0, Math.min(100, Math.round(total)));
        }

        static scoreToStars(score) {
            if (score >= 85) return '★★★';
            if (score >= 65) return '★★☆';
            if (score >= 40) return '★☆☆';
            return '☆☆☆';
        }

        static _topN(candidates, baseInfo, el, n = 2) {
            if (!candidates || !candidates.length) return [];
            const scored = candidates
                .map(c => ({
                    ...c,
                    score: this.scoreSelector(c.sel, el, { bonus: c.bonus || 0 })
                }))
                .filter(x => x.score > 0);

            const seen = new Set();
            const dedup = [];
            for (const s of scored.sort((a, b) => b.score - a.score)) {
                if (seen.has(s.sel)) continue;
                seen.add(s.sel);
                dedup.push(s);
                if (dedup.length >= n) break;
            }

            return dedup.map(best => ({
                type: baseInfo.type,
                icon: baseInfo.icon,
                label: baseInfo.label,
                selector: best.sel,
                matches: this.countMatches(best.sel),
                score: best.score,
                stars: this.scoreToStars(best.score),
                hint: best.hint
            }));
        }

        // ── 한 요소를 표현하는 짧은 simple selector 생성 ──
        static _simpleSelectorFor(el) {
            if (!el || !el.tagName) return '';
            // ID가 안정적이고 유일하면 ID 우선
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
                const idSel = `#${CSS.escape(el.id)}`;
                if (this.countMatches(idSel) === 1) return idSel;
            }
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);

            // tag + 의미있는 클래스 1~2개
            if (classes.length) {
                let sel = `${tag}.${CSS.escape(classes[0])}`;
                if (classes.length >= 2) {
                    sel += `.${CSS.escape(classes[1])}`;
                }
                return sel;
            }

            // 형제 중 위치
            const parent = el.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                if (sameTag.length === 1) return tag;
                const idx = sameTag.indexOf(el) + 1;
                return `${tag}:nth-of-type(${idx})`;
            }
            return tag;
        }

        // ★ 신규: 부모 체인을 거슬러 올라가며 매치=1이 될 때까지 셀렉터 확장
        static uniqueAncestorPath(el) {
            if (!el || !el.tagName) return [];

            const candidates = [];

            const buildPath = (combinator) => {
                const parts = [this._simpleSelectorFor(el)];
                let cur = el.parentElement;
                let depth = 0;
                const maxDepth = 8;

                while (cur && cur !== document.body && cur !== document.documentElement && depth < maxDepth) {
                    const segment = this._simpleSelectorFor(cur);
                    parts.unshift(segment);
                    const sel = parts.join(combinator === '>' ? ' > ' : ' ');
                    const matchCount = this.countMatches(sel);
                    if (matchCount === 1) {
                        return sel;
                    }
                    // 유일한 ID 부모 만나면 거기서 멈춤
                    if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id) &&
                        this.countMatches(`#${CSS.escape(cur.id)}`) === 1) {
                        return sel;
                    }
                    cur = cur.parentElement;
                    depth++;
                }
                return parts.join(combinator === '>' ? ' > ' : ' ');
            };

            try {
                const descPath = buildPath(' ');
                if (descPath && this.countMatches(descPath) >= 1) {
                    candidates.push({ sel: descPath, hint: '유일 경로 (자손)' });
                }
            } catch (_) {}

            try {
                const childPath = buildPath('>');
                if (childPath && this.countMatches(childPath) >= 1) {
                    candidates.push({ sel: childPath, hint: '유일 경로 (직계 자식)' });
                }
            } catch (_) {}

            // ID 부모 안에서의 짧은 경로
            let p = el.parentElement;
            while (p && p !== document.body) {
                if (p.id && /^[a-zA-Z][\w-]*$/.test(p.id) &&
                    this.countMatches(`#${CSS.escape(p.id)}`) === 1) {
                    const tag = el.tagName.toLowerCase();
                    const allSameTag = p.querySelectorAll(tag);
                    const idx = Array.from(allSameTag).indexOf(el) + 1;
                    if (idx > 0) {
                        if (allSameTag.length === 1) {
                            candidates.push({
                                sel: `#${CSS.escape(p.id)} ${tag}`,
                                hint: `ID 내 유일한 ${tag}`
                            });
                        } else {
                            candidates.push({
                                sel: `#${CSS.escape(p.id)} ${tag}:nth-of-type(${idx})`,
                                hint: `ID 내 ${idx}번째 ${tag}`
                            });
                        }
                    }
                    const classes = this.meaningfulClasses(el);
                    if (classes.length) {
                        candidates.push({
                            sel: `#${CSS.escape(p.id)} ${tag}.${CSS.escape(classes[0])}`,
                            hint: `ID 내 ${tag}.${classes[0]}`
                        });
                    }
                    break;
                }
                p = p.parentElement;
            }

            return this._topN(
                candidates,
                { type: 'uniquePath', icon: '🎯', label: '유일 타겟팅 경로' },
                el, 3
            );
        }

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
                    { sel: `[${attr}="${CSS.escape(val)}"]`, hint: `${attr} 정확 일치` },
                    { sel: `${tag}[${attr}="${CSS.escape(val)}"]`, hint: `${tag} + ${attr}` },
                    val.length > 8
                        ? { sel: `[${attr}*="${CSS.escape(val.slice(0, 8))}"]`, hint: `${attr} 부분 일치` }
                        : null
                ].filter(Boolean);
                candidates.push(...variants);
            }

            return this._topN(
                candidates,
                { type: 'semantic', icon: '🏷️', label: '의미있는 속성' },
                el, 2
            );
        }

        static shortest(el) {
            const candidates = [];
            const tag = el.tagName.toLowerCase();
            const id = el.id;
            const classes = this.meaningfulClasses(el);

            if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
                candidates.push({ sel: `#${CSS.escape(id)}`, hint: 'ID 단독' });
                for (const c of classes.slice(0, 2)) {
                    candidates.push({ sel: `#${CSS.escape(id)}.${CSS.escape(c)}`, hint: 'ID + 클래스' });
                }
                if (classes.length >= 2) {
                    candidates.push({
                        sel: `#${CSS.escape(id)}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`,
                        hint: 'ID + 다중 클래스'
                    });
                }
            }

            for (const c of classes.slice(0, 3)) {
                candidates.push({ sel: `.${CSS.escape(c)}`, hint: '클래스 단독' });
                candidates.push({ sel: `${tag}.${CSS.escape(c)}`, hint: `${tag} + 클래스` });
            }

            if (classes.length >= 2) {
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`,
                    hint: '다중 클래스'
                });
            }

            if (!candidates.length) candidates.push({ sel: tag, hint: '태그만' });

            return this._topN(
                candidates,
                { type: 'shortest', icon: '✨', label: '가장 짧은 셀렉터' },
                el, 2
            );
        }

        static dummyHref(el) {
            const anchor = this._findAnchor(el);
            if (!anchor) return [];
            const href = anchor.getAttribute('href');
            if (!href || !DUMMY_HREF_VALUES.has(href.trim())) return [];

            const candidates = [];
            const parent = anchor.parentElement;

            candidates.push({ sel: `a[href="${CSS.escape(href)}"]`, hint: `더미 href="${href}"` });

            if (anchor.id && /^[a-zA-Z][\w-]*$/.test(anchor.id)) {
                candidates.push({
                    sel: `a#${CSS.escape(anchor.id)}[href="${CSS.escape(href)}"]`,
                    hint: 'ID + 더미 href'
                });
            }
            const aClasses = this.meaningfulClasses(anchor);
            for (const c of aClasses.slice(0, 2)) {
                candidates.push({
                    sel: `a.${CSS.escape(c)}[href="${CSS.escape(href)}"]`,
                    hint: '클래스 + 더미 href'
                });
            }

            if (parent?.id && /^[a-zA-Z][\w-]*$/.test(parent.id)) {
                candidates.push({
                    sel: `#${CSS.escape(parent.id)} a[href="${CSS.escape(href)}"]`,
                    hint: '부모 ID 내 더미 href'
                });
            }

            return this._topN(
                candidates,
                { type: 'dummyHref', icon: '🔗', label: '더미 링크 (광고 클릭 패턴)' },
                el, 2
            );
        }

        static classPattern(el) {
            const classes = this.meaningfulClasses(el);
            const candidates = [];
            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement', 'popup', 'overlay'];

            for (const c of classes) {
                const low = c.toLowerCase();
                if (adKeywords.some(k => low.includes(k))) {
                    candidates.push({ sel: `[class*="${CSS.escape(c)}"]`, hint: `광고 키워드 부분일치: ${c}` });
                    candidates.push({ sel: `.${CSS.escape(c)}`, hint: `광고 키워드 클래스: ${c}` });
                }
                const bem = c.match(/^([a-z][\w-]*?)(?:__|--)/i);
                if (bem) {
                    candidates.push({ sel: `[class^="${CSS.escape(bem[1])}"]`, hint: `BEM 블록: ${bem[1]}` });
                }
            }

            for (const attr of el.attributes || []) {
                if (/^data-ad/i.test(attr.name)) {
                    candidates.push({ sel: `[${attr.name}]`, hint: `광고 데이터 속성: ${attr.name}`, bonus: 4 });
                }
            }

            return this._topN(
                candidates,
                { type: 'classPattern', icon: '📎', label: '클래스 패턴' },
                el, 2
            );
        }

        static precise(el, evaluator) {
            if (typeof evaluator !== 'function') return [];
            let sel;
            try { sel = evaluator(el); } catch (_) { return []; }
            if (!sel || /picky-/.test(sel)) return [];

            const score = this.scoreSelector(sel, el);
            if (!score) return [];
            return [{
                type: 'precise',
                icon: '🎯',
                label: '정밀 셀렉터',
                selector: sel,
                matches: this.countMatches(sel),
                score,
                stars: this.scoreToStars(score),
                hint: '평가기 기반'
            }];
        }

        static similarGroup(el) {
            const parent = el.parentElement;
            if (!parent) return [];
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);

            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length < 2) return [];

            const candidates = [];
            for (const c of classes) {
                const sharedCount = siblings.filter(s => s.classList.contains(c)).length;
                if (sharedCount >= 2) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(c)}`,
                        hint: `${sharedCount}개 형제 공유: ${c}`
                    });
                }
            }
            if (parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id)) {
                candidates.push({
                    sel: `#${CSS.escape(parent.id)} > ${tag}`,
                    hint: '부모 ID 하의 동일 태그'
                });
            }

            return this._topN(
                candidates,
                { type: 'similarGroup', icon: '👥', label: '유사 그룹' },
                el, 2
            );
        }

        static container(el) {
            const chain = this.parentChain(el, 4);
            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement'];
            const containerTags = ['section', 'aside', 'article', 'nav', 'header', 'footer'];

            const candidates = [];

            for (const p of chain) {
                const id = p.id;
                const classes = this.meaningfulClasses(p);
                const tag = p.tagName.toLowerCase();

                if (id && adKeywords.some(k => id.toLowerCase().includes(k))) {
                    candidates.push({
                        sel: `#${CSS.escape(id)}`,
                        hint: `광고 키워드 ID: ${id}`
                    });
                }
                for (const c of classes) {
                    if (adKeywords.some(k => c.toLowerCase().includes(k))) {
                        candidates.push({
                            sel: `.${CSS.escape(c)}`,
                            hint: `광고 키워드 컨테이너: ${c}`
                        });
                    }
                }
                if (containerTags.includes(tag) && classes.length) {
                    candidates.push({
                        sel: `${tag}.${CSS.escape(classes[0])}`,
                        hint: `시맨틱 컨테이너: ${tag}`
                    });
                }
            }

            return this._topN(
                candidates,
                { type: 'container', icon: '🎨', label: '부모 컨테이너' },
                el, 2
            );
        }

        // ★ 신규: 이미지/미디어가 있으면 광고 여부와 무관하게 항상 CSS 후보 생성
        static imgAlwaysCss(el) {
            const img = this._findImg(el);
            if (!img) return [];
            const src = img.getAttribute('src') || img.src || '';
            if (!src || src.startsWith('data:') || src.startsWith('blob:')) return [];

            let url;
            try { url = new URL(src, location.href); } catch (_) { return []; }

            const candidates = [];
            const fileName = url.pathname.split('/').pop() || '';
            const dirPath = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);

            // 1) 정확한 src 매칭 — 가장 정확
            candidates.push({
                sel: `img[src="${CSS.escape(src)}"]`,
                hint: '정확한 이미지 URL'
            });

            // 2) 파일명 끝매칭
            if (fileName && fileName.length >= 4 && fileName.length <= 80) {
                candidates.push({
                    sel: `img[src$="${CSS.escape(fileName)}"]`,
                    hint: `파일명 끝매칭: ${fileName}`
                });
            }

            // 3) 디렉토리 부분매칭
            if (dirPath && dirPath.length > 3 && dirPath !== '/') {
                candidates.push({
                    sel: `img[src*="${CSS.escape(dirPath)}"]`,
                    hint: `디렉토리: ${dirPath}`
                });
            }

            // 4) 호스트 부분매칭
            if (url.hostname) {
                candidates.push({
                    sel: `img[src*="${CSS.escape(url.hostname)}"]`,
                    hint: `호스트: ${url.hostname}`
                });
            }

            // 5) 부모 <a>가 있으면 a > img 조합
            const anchor = this._findAnchor(img);
            if (anchor) {
                const href = anchor.getAttribute('href') || '';
                if (href && !DUMMY_HREF_VALUES.has(href.trim())) {
                    try {
                        const aUrl = new URL(href, location.href);
                        if (aUrl.hostname) {
                            candidates.push({
                                sel: `a[href*="${CSS.escape(aUrl.hostname)}"] > img`,
                                hint: `링크 호스트: ${aUrl.hostname}`
                            });
                        }
                    } catch (_) {}
                }
                const aClasses = this.meaningfulClasses(anchor);
                if (aClasses.length) {
                    candidates.push({
                        sel: `a.${CSS.escape(aClasses[0])} > img`,
                        hint: `링크 클래스: .${aClasses[0]}`
                    });
                }
            }

            // 6) 이미지 자체의 의미있는 클래스
            const imgClasses = this.meaningfulClasses(img);
            if (imgClasses.length) {
                candidates.push({
                    sel: `img.${CSS.escape(imgClasses[0])}`,
                    hint: `이미지 클래스: .${imgClasses[0]}`
                });
            }

            // 7) alt 속성
            const alt = img.getAttribute('alt');
            if (alt && alt.length > 0 && alt.length <= 40) {
                candidates.push({
                    sel: `img[alt="${CSS.escape(alt)}"]`,
                    hint: `alt="${alt}"`
                });
            }

            return this._topN(
                candidates,
                { type: 'imgAlwaysCss', icon: '🖼️', label: '이미지 CSS 셀렉터' },
                img, 4
            );
        }

        static imgSrcDomain(el) {
            const img = this._findImg(el);
            if (!img) return [];
            const src = img.getAttribute('src') || img.src;
            if (!src) return [];

            let host = '';
            try { host = new URL(src, location.href).hostname; }
            catch (_) { return []; }
            if (!host) return [];

            const candidates = [];
            const adHost = AD_NETWORK_HOSTS.find(h => host.includes(h));
            if (adHost) {
                candidates.push({
                    sel: `img[src*="${adHost}"]`,
                    hint: `광고 네트워크: ${adHost}`
                });
            }
            if (host !== location.hostname && !location.hostname.endsWith(host)) {
                candidates.push({
                    sel: `img[src*="${host}"]`,
                    hint: `외부 도메인: ${host}`
                });
            }

            return this._topN(
                candidates,
                { type: 'imgSrcDomain', icon: '🖼️', label: '광고 도메인 이미지' },
                img, 2
            );
        }

        static imgStandardSize(el) {
            const img = this._findImg(el);
            if (!img) return [];

            const w = parseInt(img.getAttribute('width')) || img.naturalWidth || img.width;
            const h = parseInt(img.getAttribute('height')) || img.naturalHeight || img.height;
            if (!w || !h) return [];

            const matched = IAB_AD_SIZES.find(([sw, sh]) =>
                Math.abs(sw - w) <= 5 && Math.abs(sh - h) <= 5
            );
            if (!matched) return [];

            const anchor = this._findAnchor(img);
            const hasExtLink = anchor && anchor.href &&
                (() => { try { return new URL(anchor.href).hostname !== location.hostname; } catch (_) { return false; } })();

            const candidates = [
                {
                    sel: `img[width="${matched[0]}"][height="${matched[1]}"]`,
                    hint: `IAB 표준: ${matched[0]}×${matched[1]}`
                }
            ];

            if (hasExtLink) {
                candidates.push({
                    sel: `a[href] > img[width="${matched[0]}"][height="${matched[1]}"]`,
                    hint: `IAB 크기 + 외부 링크`
                });
            }

            return this._topN(
                candidates,
                { type: 'imgStandardSize', icon: '📐', label: '표준 광고 크기' },
                img, 2
            );
        }

        static imgInAdLink(el) {
            const img = this._findImg(el);
            if (!img) return [];
            const anchor = this._findAnchor(img);
            if (!anchor) return [];
            const href = anchor.getAttribute('href') || anchor.href || '';
            if (!href) return [];

            const matched = AD_LINK_PATTERNS.find(p => href.includes(p.kw));
            if (!matched) return [];

            const candidates = [
                { sel: `a[href*="${matched.kw}"] > img`, hint: matched.desc },
                { sel: `a[href*="${matched.kw}"] img`, hint: `${matched.desc} (자손)` }
            ];

            return this._topN(
                candidates,
                { type: 'imgInAdLink', icon: '🔗', label: '광고 링크 내 이미지' },
                img, 2
            );
        }

        static imgPathPattern(el) {
            const img = this._findImg(el);
            if (!img) return [];
            const src = img.getAttribute('src') || img.src || '';
            if (!src) return [];

            const matched = AD_PATH_PATTERNS.find(p => src.toLowerCase().includes(p.kw));
            const candidates = [];
            if (matched) {
                candidates.push({ sel: `img[src*="${matched.kw}"]`, hint: matched.desc });
            }
            try {
                const url = new URL(src, location.href);
                const file = url.pathname.split('/').pop();
                if (file && file.length >= 4 && file.length <= 30 && AD_FILE_EXTS.some(e => file.endsWith(e))) {
                    candidates.push({
                        sel: `img[src*="${file}"]`,
                        hint: `파일명: ${file}`
                    });
                }
            } catch (_) {}

            return this._topN(
                candidates,
                { type: 'imgPathPattern', icon: '📦', label: '이미지 경로 패턴' },
                img, 2
            );
        }

        static networkFilter(el) {
            const targets = [];
            const TAG_SRC = ['IMG', 'IFRAME', 'SCRIPT', 'VIDEO', 'AUDIO', 'SOURCE', 'EMBED'];

            if (TAG_SRC.includes(el.tagName)) {
                targets.push(el);
            } else {
                const inner = el.querySelector?.('img[src], iframe[src], video[src], embed[src], script[src]');
                if (inner) targets.push(inner);
            }
            if (!targets.length) return [];

            const out = [];
            const seen = new Set();

            const push = (filter, cssSel, hint, score) => {
                if (!filter || seen.has(filter)) return;
                seen.add(filter);
                out.push({
                    type: 'networkFilter',
                    icon: '🌐',
                    label: '네트워크 필터',
                    selector: cssSel,
                    filter,
                    isNetwork: true,
                    matches: this.countMatches(cssSel),
                    score,
                    stars: this.scoreToStars(score),
                    hint
                });
            };

            for (const t of targets) {
                const src = t.getAttribute('src') || t.src;
                if (!src) continue;

                let url;
                try { url = new URL(src, location.href); } catch (_) { continue; }
                if (!url.hostname) continue;
                if (url.protocol === 'data:' || url.protocol === 'blob:') continue;

                const host = url.hostname;
                const path = url.pathname || '';
                const fileName = path.split('/').pop() || '';
                const dirPath = path.substring(0, path.lastIndexOf('/') + 1);
                const tagLow = t.tagName.toLowerCase();
                const cssBase = `${tagLow}[src*="${host}"]`;
                const cssExact = `${tagLow}[src="${CSS.escape(src)}"]`;

                const isAdHost = AD_NETWORK_HOSTS.some(h => host.includes(h));
                const isExternal = host !== location.hostname && !location.hostname.endsWith(host);
                const adPathMatch = AD_PATH_PATTERNS.find(p => path.toLowerCase().includes(p.kw));

                push(
                    `||${host}${path}`,
                    cssExact,
                    `정확 URL 차단: ${fileName || path}`,
                    isAdHost ? 92 : (isExternal ? 80 : 72)
                );

                push(
                    `||${host}^`,
                    cssBase,
                    isAdHost
                        ? `광고 호스트 전체 차단: ${host}`
                        : (isExternal ? `외부 도메인 전체 차단: ${host}` : `자사 도메인 차단: ${host}`),
                    isAdHost ? 95 : (isExternal ? 78 : 50)
                );

                if (dirPath && dirPath.length > 1 && dirPath !== '/') {
                    push(
                        `||${host}${dirPath}*`,
                        `${tagLow}[src*="${dirPath}"]`,
                        `디렉토리 차단: ${dirPath}`,
                        isAdHost ? 88 : (adPathMatch ? 82 : 68)
                    );
                }

                if (adPathMatch) {
                    push(
                        `||${host}*${adPathMatch.kw}*`,
                        `${tagLow}[src*="${adPathMatch.kw}"]`,
                        `광고 키워드 와일드카드: ${adPathMatch.kw}`,
                        85
                    );
                }

                if (isExternal) {
                    const typeOpt = tagLow === 'img' ? '$image'
                                  : tagLow === 'iframe' ? '$subdocument'
                                  : tagLow === 'script' ? '$script'
                                  : '';
                    if (typeOpt) {
                        push(
                            `||${host}^${typeOpt}`,
                            cssBase,
                            `${host} (${typeOpt.slice(1)} 한정)`,
                            isAdHost ? 90 : 76
                        );
                    }
                    push(
                        `||${host}^$third-party`,
                        cssBase,
                        `${host} (3rd-party 한정)`,
                        isAdHost ? 88 : 74
                    );
                }

                if (fileName && fileName.length >= 4 && fileName.length <= 50 &&
                    !/^[0-9a-f]{20,}$/i.test(fileName)) {
                    push(
                        `||${host}*/${fileName}`,
                        `${tagLow}[src$="${fileName}"]`,
                        `파일명: ${fileName}`,
                        adPathMatch ? 78 : 62
                    );
                }
            }

            return out.sort((a, b) => b.score - a.score);
        }

        static mixedNth(el) {
            const parent = el.parentElement;
            if (!parent) return [];

            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);
            const candidates = [];

            const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            const myIdx = sameTagSiblings.indexOf(el) + 1;

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

            const allSiblings = Array.from(parent.children);
            const childIdx = allSiblings.indexOf(el) + 1;
            if (childIdx > 0 && allSiblings.length > 1 && classes.length) {
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}:nth-child(${childIdx})`,
                    hint: `${childIdx}번째 자식`
                });
            }

            return this._topN(
                candidates,
                { type: 'mixedNth', icon: '🧩', label: '혼합 위치 셀렉터' },
                el, 2
            );
        }

        static multiCondition(el) {
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);
            const style = el.getAttribute('style') || '';
            const candidates = [];

            if (style && classes.length) {
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
                        hint: 'iframe 직접 자식 + 클래스'
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

            if (classes.length >= 2) {
                if (SUPPORTS_HAS) {
                    const childImg = el.querySelector(':scope > img');
                    if (childImg) {
                        candidates.push({
                            sel: `.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}:has(> img)`,
                            hint: '다중 클래스 + img'
                        });
                    }
                }
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`,
                    hint: '다중 클래스 (호환 모드)'
                });
            }

            const dataAttrs = Array.from(el.attributes || []).filter(a => a.name.startsWith('data-') && a.value.length < 30);
            if (dataAttrs.length && classes.length) {
                const da = dataAttrs[0];
                candidates.push({
                    sel: `.${CSS.escape(classes[0])}[${da.name}="${CSS.escape(da.value)}"]`,
                    hint: `${da.name} 속성 결합`
                });
            }

            return this._topN(
                candidates,
                { type: 'multiCondition', icon: '🔧', label: '다중 조건 조합' },
                el, 2
            );
        }

        static ariaLabel(el) {
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

                if (ariaLabel) {
                    const matched = ARIA_AD_KEYWORDS.find(k => ariaLabel.includes(k));
                    if (matched) {
                        candidates.push({
                            sel: `[aria-label*="${CSS.escape(matched)}"]`,
                            hint: `aria-label에 "${matched}"`
                        });
                        candidates.push({
                            sel: `${tag}[aria-label*="${CSS.escape(matched)}"]`,
                            hint: `${tag} + aria-label "${matched}"`
                        });
                    } else if (ariaLabel.length <= 30) {
                        candidates.push({
                            sel: `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`,
                            hint: `aria-label="${ariaLabel}"`
                        });
                    }
                }

                if (role && ['banner', 'complementary', 'advertisement'].includes(role)) {
                    candidates.push({
                        sel: `[role="${CSS.escape(role)}"]`,
                        hint: `role="${role}"`
                    });
                }

                if (ariaLabelledby) {
                    candidates.push({
                        sel: `[aria-labelledby="${CSS.escape(ariaLabelledby)}"]`,
                        hint: `aria-labelledby 참조`
                    });
                }
            }

            return this._topN(
                candidates,
                { type: 'ariaLabel', icon: '♿', label: 'ARIA / 접근성' },
                el, 2
            );
        }

        static buildAll(el, evaluator) {
            if (!el || !el.tagName) return [];

            const strategies = [
                () => this.semantic(el),
                () => this.shortest(el),
                () => this.uniqueAncestorPath(el),    // ★ 매치=1 보장 경로
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

            if (this.isImageRelated(el)) {
                strategies.push(
                    () => this.imgAlwaysCss(el),       // ★ 항상 이미지 CSS 후보
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
                    if (!r) continue;
                    if (Array.isArray(r)) {
                        for (const item of r) if (item?.selector) results.push(item);
                    } else if (r.selector) {
                        results.push(r);
                    }
                } catch (_) {}
            }

            const filtered = results.filter(r => !/picky-/.test(r.selector));

            const seen = new Set();
            const unique = [];
            for (const r of filtered) {
                const key = `${r.selector}|${r.filter || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(r);
            }

            unique.sort((a, b) => b.score - a.score);

            if (unique.length) unique[0].recommended = true;

            return unique;
        }

        static toAdGuardRule(candidate, scope = 'host') {
            if (!candidate) return '';
            if (candidate.isNetwork && candidate.filter) {
                return candidate.filter;
            }
            const sel = candidate.selector;
            if (!sel) return '';
            const host = location.hostname || '';
            if (scope === 'global' || !host) return `##${sel}`;
            return `${host}##${sel}`;
        }
    }

    // ───────────────────────────────────────────────
    // Inspector
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
                mode: 'initial',
                scale: 'icon',
                isCollapsed: true,
                isObscured: false,
                isQuarantined: false,
                obscuredNodes: [],
                displayCache: new WeakMap(),
                hits: 0,
                autoDismiss: GM_getValue('picky_auto_close', true),
                hoverPreviewNodes: [],
                pinnedPreviewNodes: [],
                hiddenPreviewNodes: [],
                hiddenSelector: null,
                adSelectedNodes: [],
                iconPos: null,
                panelPos: null,
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

        evaluateCssBasic(el) {
            if (!el || !el.tagName) return '';
            const tag = el.tagName.toLowerCase();
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
            const classes = SelectorStrategies.meaningfulClasses(el);
            if (classes.length) return `${tag}.${CSS.escape(classes[0])}`;
            return tag;
        }

        resolveParent(el) { return el?.parentElement || null; }
        resolveChildren(el) {
            if (!el) return [];
            return Array.from(el.children || []);
        }

        constructUI() {
            const host = document.createElement('div');
            host.id = ROOT_ID;
            host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
            document.documentElement.appendChild(host);
            const shadow = host.attachShadow({ mode: 'open' });
            this.dom.host = host;
            this.dom.shadow = shadow;

            const tool = document.createElement('div');
            tool.id = TOOL_ID;
            tool.className = 'picky-tool picky-icon';
            shadow.appendChild(tool);
            this.dom.tool = tool;

            const style = document.createElement('style');
            style.textContent = PICKY_CSS;
            shadow.appendChild(style);

            this.modal = new Modal(shadow);

            this.render();
            this.attachDragHandlers();
            this.applyPosition();
        }

        applyPosition() {
            const tool = this.dom.tool;
            if (!tool) return;

            tool.style.left = '';
            tool.style.top = '';
            tool.style.right = '';
            tool.style.bottom = '';
            tool.style.transform = '';

            if (this.state.scale === 'icon') {
                const pos = this.state.iconPos;
                if (pos && typeof pos.x === 'number') {
                    tool.style.left = pos.x + 'px';
                    tool.style.top = pos.y + 'px';
                } else {
                    tool.style.right = '20px';
                    tool.style.bottom = '20px';
                }
            } else {
                const pos = this.state.panelPos;
                if (pos && typeof pos.x === 'number') {
                    tool.style.left = pos.x + 'px';
                    tool.style.top = pos.y + 'px';
                } else {
                    tool.style.left = '50%';
                    tool.style.bottom = '20px';
                    tool.style.transform = 'translateX(-50%)';
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

        render() {
            const tool = this.dom.tool;
            if (!tool) return;

            if (this.state.scale === 'icon') {
                tool.className = 'picky-tool picky-icon';
                tool.innerHTML = `
                    <button class="picky-icon-btn" data-act="cycleSize" title="Picky 열기" aria-label="Picky 열기">
                        ${ICON_TARGET}
                    </button>`;
                this.attachRefs();
                return;
            }

            tool.className = 'picky-tool picky-panel';
            tool.innerHTML = this.getFullLayout();
            this.attachRefs();
            this.renderCandidates();
            this.restoreSliderState();   // ★ 슬라이더 max/value 복원
        }

        // ★ render() 후에도 슬라이더(상위/하위)가 유지되도록 복원
        restoreSliderState() {
            const slider = this.dom.slider;
            if (!slider) return;
            const hier = this.state.hierarchy;
            if (!hier || !hier.length) return;
            slider.min = 0;
            slider.max = hier.length - 1;
            const curIdx = hier.indexOf(this.state.target);
            slider.value = curIdx >= 0 ? curIdx : 0;
        }

        getFullLayout() {
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            const agg = Blocker.isAggressive();
            const hidingNow = this.state.hiddenPreviewNodes.length > 0;
            return `
            <div class="picky-head" data-drag="1">
                <span class="picky-title">Picky <small>v3.6.5</small></span>
                <div class="picky-head-btns">
                    <button class="picky-btn picky-btn-icon" data-act="settings" title="설정">${ICON_SET}</button>
                    <button class="picky-btn picky-btn-icon" data-act="cycleSize" title="최소화">${ICON_MIN}</button>
                    <button class="picky-btn picky-btn-icon" data-act="terminate" title="아이콘으로 접기">${ICON_CLOSE}</button>
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
                    <button class="picky-btn ${hidingNow ? 'picky-btn-active' : ''}" data-act="toggleHideSelected" title="선택한 규칙으로 페이지에서 숨김 미리보기">
                        ${hidingNow ? ICON_EYE_OFF : ICON_EYE}<span>${hidingNow ? '복구' : '숨김'}</span>
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

        attachRefs() {
            const t = this.dom.tool;
            this.dom.disp = t.querySelector('[data-ref="disp"]');
            this.dom.match = t.querySelector('[data-ref="match"]');
            this.dom.slider = t.querySelector('[data-ref="slider"]');
            this.dom.cardsScroll = t.querySelector('[data-ref="cardsScroll"]');

            t.querySelectorAll('[data-act]').forEach(el => {
                const act = el.getAttribute('data-act');
                const evt = el.tagName === 'INPUT' && el.type === 'checkbox' ? 'change' : 'click';
                el.addEventListener(evt, (e) => {
                    e.stopPropagation();
                    this.triggerAction(act, el, e);
                });
            });

            this.dom.slider?.addEventListener('input', (e) => {
                e.stopPropagation();
                this.handleSlide(parseInt(e.target.value, 10));
            });
            this.dom.slider?.addEventListener('pointerdown', (e) => e.stopPropagation());
        }

        renderCandidates() {
            const wrap = this.dom.cardsScroll;
            if (!wrap) return;
            const list = this.state.candidates;
            if (!list.length) {
                wrap.innerHTML = '<div class="picky-cards-empty">요소 선택 후 후보 규칙이 표시됩니다</div>';
                return;
            }

            wrap.innerHTML = `
                <div class="picky-cards-info">총 ${list.length}개 후보 · 점수순 · 호버:미리보기 · 클릭:핀 · 👁:숨김 토글</div>
                ${list.map((c, i) => this.renderCard(c, i)).join('')}
            `;

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
            const isHidingThis = this.state.hiddenSelector === c.selector;

            return `
            <div class="picky-card ${isSelected ? 'is-selected' : ''} ${isNet ? 'is-network' : ''} ${isHidingThis ? 'is-hiding' : ''}" data-idx="${idx}">
                <div class="picky-card-head">
                    <span class="picky-card-icon">${c.icon || '•'}</span>
                    <span class="picky-card-label">${esc(c.label)}</span>
                    ${recommended}
                    <span class="picky-card-stars" title="${c.score}점 (성능+정확도)">${c.stars || ''}</span>
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
                    ${isNet
                        ? `<button class="picky-card-btn picky-card-btn-disabled" disabled title="네트워크 필터는 페이지 숨김 미리보기 불가">${ICON_EYE} 숨김</button>`
                        : `<button class="picky-card-btn ${isHidingThis ? 'picky-card-btn-hiding' : ''}" data-card-act="toggleHide" title="${isHidingThis ? '숨김 해제' : '이 규칙으로 페이지에서 숨김 미리보기'}">${isHidingThis ? ICON_EYE_OFF + ' 복구' : ICON_EYE + ' 숨김'}</button>`
                    }
                    <button class="picky-card-btn" data-card-act="copyFilter" title="AdGuard/uBlock 규칙 복사">📋 필터</button>
                    ${isNet ? '' : `<button class="picky-card-btn" data-card-act="copyCss" title="CSS 셀렉터 복사">📋 CSS</button>`}
                </div>
            </div>`;
        }

        async handleCardAction(act, idx) {
            const c = this.state.candidates[idx];
            if (!c) return;

            if (act === 'block') {
                if (c.isNetwork) return;
                this.clearHidePreview();
                if (Blocker.append(c.selector)) {
                    this.flashToast(`차단: ${c.selector.slice(0, 50)}`);
                    this.refreshMetrics();
                    this.render();
                } else {
                    this.flashToast('이미 등록된 규칙');
                }
            } else if (act === 'toggleHide') {
                if (c.isNetwork) return;
                const result = this.toggleHidePreview(c.selector);
                if (result.hidden) {
                    this.flashToast(`${result.count}개 요소 숨김 (미리보기)`);
                } else {
                    this.flashToast('숨김 해제됨');
                }
                this.renderCandidates();
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

        // ── 호버 미리보기 (점선 outline) ───────────────────
        previewCandidate(idx) {
            this.clearPreview();
            if (idx === this.state.selectedIdx) return;
            const c = this.state.candidates[idx];
            if (!c || !c.selector) return;
            if (this.state.hiddenSelector === c.selector) return;

            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(c.selector)); }
            catch (_) { return; }
            for (const n of nodes) {
                if (n.closest && n.closest(`#${ROOT_ID}`)) continue;
                n.classList.add('picky-hl-preview');
            }
            this.state.hoverPreviewNodes = nodes;
            if (nodes[0]) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        clearPreview() {
            for (const n of this.state.hoverPreviewNodes) {
                n.classList.remove('picky-hl-preview');
            }
            this.state.hoverPreviewNodes = [];
        }

        // ── 핀 미리보기 (카드 선택 시 지속) ────────────────
        applyPinnedPreview(selector) {
            this.clearPinnedPreview();
            if (!selector) return;
            if (this.state.hiddenSelector === selector) return;

            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(selector)); }
            catch (_) { return; }
            for (const n of nodes) {
                if (n.closest && n.closest(`#${ROOT_ID}`)) continue;
                n.classList.add('picky-hl-pinned');
            }
            this.state.pinnedPreviewNodes = nodes;
        }

        clearPinnedPreview() {
            for (const n of this.state.pinnedPreviewNodes) {
                n.classList.remove('picky-hl-pinned');
                n.classList.remove('picky-hl-preview');
            }
            this.state.pinnedPreviewNodes = [];
        }

        // ── 숨김 토글 미리보기 (display:none) ─────────────
        applyHidePreview(selector) {
            this.clearHidePreview();
            if (!selector) return 0;

            let nodes;
            try { nodes = document.querySelectorAll(selector); }
            catch (_) { return 0; }

            const applied = [];
            nodes.forEach(n => {
                if (n.closest && n.closest(`#${ROOT_ID}`)) return;
                if (n.id === ROOT_ID) return;
                n.classList.add(HIDE_CLASS);
                applied.push(n);
            });
            this.state.hiddenPreviewNodes = applied;
            this.state.hiddenSelector = selector;

            this.clearPreview();
            this.clearPinnedPreview();

            return applied.length;
        }

        clearHidePreview() {
            for (const n of this.state.hiddenPreviewNodes) {
                n.classList.remove(HIDE_CLASS);
            }
            this.state.hiddenPreviewNodes = [];
            this.state.hiddenSelector = null;
        }

        toggleHidePreview(selector) {
            if (!selector) return { hidden: false, count: 0 };
            if (this.state.hiddenSelector === selector) {
                this.clearHidePreview();
                const cur = this.state.candidates[this.state.selectedIdx];
                if (cur && cur.selector === selector) {
                    this.applyPinnedPreview(selector);
                }
                return { hidden: false, count: 0 };
            } else {
                const count = this.applyHidePreview(selector);
                return { hidden: true, count };
            }
        }

        selectCandidate(idx) {
            this.state.selectedIdx = idx;
            const c = this.state.candidates[idx];
            if (!c) return;
            this.state.queryData.selector = c.selector;

            if (this.state.hiddenSelector !== c.selector) {
                this.applyPinnedPreview(c.selector);
                if (this.state.pinnedPreviewNodes[0]) {
                    this.state.pinnedPreviewNodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            this.refreshMetrics();
            this.renderCandidates();
        }

        refreshMetrics() {
            const disp = this.dom.disp;
            const match = this.dom.match;
            const sel = this.state.queryData.selector;
            if (disp) disp.textContent = sel || '요소를 선택하세요';
            if (match) {
                const n = sel ? SelectorStrategies.countMatches(sel) : 0;
                match.textContent = `매치 ${n}개`;
            }

            const stats = Blocker.getStats();
            const statsEl = this.dom.tool?.querySelector('.picky-stats');
            if (statsEl) statsEl.textContent = `규칙 ${stats.ruleCount}개 (전체 ${stats.totalRules})`;
        }

        calcSliderLimits() {
            if (!this.state.originTarget) return;
            const upChain = [];
            let cur = this.state.originTarget.parentElement;
            while (cur && cur !== document.body) {
                upChain.push(cur);
                cur = cur.parentElement;
                if (upChain.length > 20) break;
            }
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
                slider.value = upChain.length;
            }
        }

        handleSlide(idx) {
            const node = this.state.hierarchy[idx];
            if (!node) return;
            this.selectNode(node, false);
        }

        selectNode(el, updateOrigin = true) {
            if (!el || !el.tagName) return;
            this.clearHidePreview();
            this.clearPinnedPreview();

            this.state.target = el;
            if (updateOrigin) {
                this.state.originTarget = el;
                this.calcSliderLimits();
            }
            this.state.candidates = SelectorStrategies.buildAll(el, this._preciseEvaluator);

            let idx = this.state.candidates.findIndex(c => c.recommended);
            if (idx < 0 && this.state.candidates.length) idx = 0;
            this.state.selectedIdx = idx;

            if (idx >= 0) {
                const pick = this.state.candidates[idx];
                this.state.queryData.selector = pick.selector;
                this.applyPinnedPreview(pick.selector);
            } else {
                this.state.queryData.selector = '';
            }

            this.refreshMetrics();
            this.renderCandidates();
            this.setFocus(el);

            // 슬라이더 위치도 새 target에 맞게 갱신
            const hier = this.state.hierarchy;
            if (this.dom.slider && hier && hier.length) {
                const i = hier.indexOf(el);
                if (i >= 0) this.dom.slider.value = i;
            }
        }

        // ★ 이미지처럼 inline 요소는 outline이 잘 안 보이므로 부모도 같이 표시
        setFocus(el) {
            this.dropFocus();
            if (!el) return;
            el.classList.add(HL_CLASS);
            const tracked = [el];

            if (el.tagName === 'IMG' || el.tagName === 'IFRAME' ||
                el.tagName === 'VIDEO' || el.tagName === 'EMBED') {
                const parent = el.parentElement;
                if (parent && parent !== document.body && parent.id !== ROOT_ID &&
                    !(parent.closest && parent.closest(`#${ROOT_ID}`))) {
                    parent.classList.add('picky-hl-parent');
                    tracked.push(parent);
                }
            }
            this.state.previewNodes = tracked;
        }

        dropFocus() {
            for (const n of this.state.previewNodes) {
                n.classList.remove(HL_CLASS);
                n.classList.remove('picky-hl-parent');
            }
            this.state.previewNodes = [];
        }

        startPicking() {
            this.clearHidePreview();
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
            if (path.some(n => n?.id === ROOT_ID)) return;
            e.preventDefault();
            e.stopPropagation();
            this.selectNode(e.target, true);
            this.stopPicking();
        }

        cycleSize() {
            if (this.state.scale === 'icon') {
                this.state.scale = 'full';
                this.state.panelPos = null;
            } else {
                this.state.scale = 'icon';
                this.state.iconPos = null;
                this.dropFocus();
                this.clearPreview();
                this.clearPinnedPreview();
                this.clearHidePreview();
                if (this.state.mode === 'picking') this.stopPicking();
            }
            this.render();
            this.applyPosition();
        }

        triggerAction(act, el, evt) {
            switch (act) {
                case 'cycleSize': this.cycleSize(); break;
                case 'terminate':
                    this.state.scale = 'icon';
                    this.state.iconPos = null;
                    this.dropFocus();
                    this.clearPreview();
                    this.clearPinnedPreview();
                    this.clearHidePreview();
                    if (this.state.mode === 'picking') this.stopPicking();
                    this.render();
                    this.applyPosition();
                    break;
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
                    if (c && !c.isNetwork) {
                        this.handleCardAction('block', this.state.selectedIdx);
                    } else if (c && c.isNetwork) {
                        this.flashToast('네트워크 필터는 차단할 수 없습니다 (필터 복사 사용)');
                    } else if (this.state.queryData.selector) {
                        this.clearHidePreview();
                        if (Blocker.append(this.state.queryData.selector)) {
                            this.flashToast('차단 규칙 추가');
                            this.refreshMetrics();
                        }
                    }
                    break;
                }
                case 'toggleHideSelected': {
                    const c = this.state.candidates[this.state.selectedIdx];
                    const sel = (c && !c.isNetwork) ? c.selector : this.state.queryData.selector;
                    if (!sel) {
                        this.flashToast('선택된 규칙이 없습니다');
                        break;
                    }
                    if (c && c.isNetwork) {
                        this.flashToast('네트워크 필터는 페이지 숨김 미리보기 불가');
                        break;
                    }
                    const r = this.toggleHidePreview(sel);
                    this.flashToast(r.hidden ? `${r.count}개 요소 숨김 (미리보기)` : '숨김 해제됨');
                    this.render();
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

        editSelector() {
            const cur = this.state.queryData.selector || '';
            const body = this.modal.display('셀렉터 편집 (실시간 미리보기 / 숨김 토글)', '', true);
            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:6px">
                    셀렉터를 수정하면 페이지에 핀(초록 외곽선) 미리보기가 즉시 표시됩니다.<br>
                    👁 숨김을 누르면 해당 요소를 페이지에서 일시 숨겨 차단 후 모습을 확인할 수 있습니다.
                </div>
                <textarea class="picky-modal-input" rows="3">${esc(cur)}</textarea>
                <div class="picky-modal-meta" data-ref="prev">매치 0개</div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="apply">적용</button>
                    <button class="picky-btn" data-ref="hide">👁 숨김 토글</button>
                    <button class="picky-btn picky-btn-danger" data-ref="blk">차단 추가</button>
                </div>`;
            const ta = body.querySelector('textarea');
            const prev = body.querySelector('[data-ref="prev"]');
            const hideBtn = body.querySelector('[data-ref="hide"]');

            const updatePreview = () => {
                const sel = ta.value.trim();
                const n = SelectorStrategies.countMatches(sel);
                prev.textContent = `매치 ${n}개${this.state.hiddenSelector === sel ? ' · 숨김 중' : ''}`;
                if (this.state.hiddenSelector !== sel) {
                    this.applyPinnedPreview(sel);
                }
                hideBtn.textContent = (this.state.hiddenSelector === sel) ? '↩ 숨김 해제' : '👁 숨김 토글';
            };
            ta.addEventListener('input', updatePreview);
            updatePreview();

            body.querySelector('[data-ref="apply"]').addEventListener('click', () => {
                this.state.queryData.selector = ta.value.trim();
                this.refreshMetrics();
                this.modal.dismiss();
            });
            hideBtn.addEventListener('click', () => {
                const sel = ta.value.trim();
                if (!sel) return;
                const r = this.toggleHidePreview(sel);
                this.flashToast(r.hidden ? `${r.count}개 요소 숨김` : '숨김 해제됨');
                updatePreview();
                this.render();
            });
            body.querySelector('[data-ref="blk"]').addEventListener('click', () => {
                const v = ta.value.trim();
                this.clearHidePreview();
                if (v && Blocker.append(v)) {
                    this.flashToast('차단 규칙 추가');
                    this.refreshMetrics();
                }
                this.modal.dismiss();
            });
        }

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
                        <button class="picky-btn" data-ref="clearPreview">미리보기 지우기</button>
                        <button class="picky-btn" data-ref="clearHide">숨김 미리보기 해제</button>
                    </div>
                    <div class="picky-settings-row">
                        <small style="opacity:0.6">
                            • <b>호버 미리보기</b>(노란 점선): 카드에 마우스를 올리면 영역 표시<br>
                            • <b>핀 미리보기</b>(초록 외곽선): 카드 클릭 시 영역 고정 표시<br>
                            • <b>숨김 미리보기</b>(👁): 차단 시 페이지가 어떻게 보일지 즉시 확인 (display:none)<br>
                            • <b>유일 타겟팅 경로</b>(🎯): 매치=1 보장 절대 경로 — uBlock의 정확한 한 요소 차단과 동일<br>
                            • 별점: 성능(매칭 속도) + 정확도(매치 개수). ★★★는 가장 빠르고 정확.
                        </small>
                    </div>
                </div>`;
            body.querySelector('[data-ref="resetPos"]').addEventListener('click', () => {
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
            body.querySelector('[data-ref="clearPreview"]').addEventListener('click', () => {
                this.clearPinnedPreview();
                this.clearPreview();
                this.flashToast('미리보기 지움');
            });
            body.querySelector('[data-ref="clearHide"]').addEventListener('click', () => {
                this.clearHidePreview();
                this.flashToast('숨김 미리보기 해제됨');
                this.render();
            });
        }

        suggestAds() {
            const candidates = [];
            const adKeywords = ['ad', 'ads', 'banner', 'sponsor', 'promo', 'advertisement'];

            document.querySelectorAll('div, section, aside, ins').forEach(el => {
                const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
                const id = (el.id || '').toLowerCase();
                if (adKeywords.some(k => cls.includes(k) || id.includes(k))) {
                    candidates.push(el);
                }
            });

            document.querySelectorAll('img[src], iframe[src]').forEach(el => {
                const src = el.getAttribute('src') || '';
                if (AD_NETWORK_HOSTS.some(h => src.includes(h))) candidates.push(el);
            });

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
                    } else {
                        this.state.panelPos = pos;
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

        launch() {
            this.constructUI();
        }
        terminate() {
            this.dropFocus();
            this.clearPreview();
            this.clearPinnedPreview();
            this.clearHidePreview();
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
        max-width: calc(100vw - 24px);
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
    .picky-btn-active {
        background: linear-gradient(135deg, #8b5cf6, #6d28d9);
        border-color: transparent;
        color: #fff;
    }
    .picky-btn-active:hover { background: linear-gradient(135deg, #a78bfa, #7c3aed); }
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

    .picky-cards-scroll {
        max-height: 320px;
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
    .picky-cards-info {
        font-size: 10px; opacity: 0.55;
        padding: 4px 6px 8px; text-align: center;
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
        background: rgba(16, 185, 129, 0.18);
        border-color: rgba(16, 185, 129, 0.7);
        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.4);
    }
    .picky-card.is-network {
        background: rgba(168, 85, 247, 0.08);
        border-color: rgba(168, 85, 247, 0.3);
    }
    .picky-card.is-selected.is-network {
        background: rgba(16, 185, 129, 0.18);
        border-color: rgba(16, 185, 129, 0.7);
    }
    .picky-card.is-hiding {
        background: rgba(139, 92, 246, 0.18);
        border-color: rgba(139, 92, 246, 0.7);
        box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.5);
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
        display: inline-flex; align-items: center; justify-content: center; gap: 3px;
    }
    .picky-card-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-card-btn-block { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.3); }
    .picky-card-btn-block:hover { background: rgba(239, 68, 68, 0.35); }
    .picky-card-btn-hiding {
        background: rgba(139, 92, 246, 0.35);
        border-color: rgba(139, 92, 246, 0.6);
        color: #fff;
    }
    .picky-card-btn-disabled {
        opacity: 0.35; cursor: not-allowed;
    }
    .picky-card-btn-disabled:hover { background: rgba(255,255,255,0.08); }

    .picky-action-row {
        display: flex; gap: 6px; margin-bottom: 8px;
        flex-wrap: wrap;
    }
    .picky-action-row .picky-btn-danger { flex: 1; justify-content: center; min-width: 70px; }
    .picky-action-row .picky-btn { justify-content: center; }

    .picky-toggle-row {
        display: flex; gap: 12px; font-size: 11px;
        padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);
    }
    .picky-toggle {
        display: inline-flex; align-items: center; gap: 5px;
        cursor: pointer;
    }
    .picky-toggle input { cursor: pointer; }

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
    // 페이지 글로벌 CSS (하이라이트 + 숨김 미리보기)
    // ★ 강화: outline 두께/명도 키워서 이미지에서도 잘 보이게
    // ───────────────────────────────────────────────
    const PAGE_CSS = `
    .${HL_CLASS} {
        outline: 3px solid #3b82f6 !important;
        outline-offset: 1px !important;
        background: rgba(59,130,246,0.15) !important;
        box-shadow: 0 0 0 1px rgba(59,130,246,0.8) !important;
    }
    .picky-hl-parent {
        outline: 2px dashed #60a5fa !important;
        outline-offset: 0 !important;
    }
    .picky-hl-preview {
        outline: 3px dashed #f59e0b !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 1px rgba(245,158,11,0.6) !important;
    }
    .picky-hl-pinned {
        outline: 4px solid #10b981 !important;
        outline-offset: 2px !important;
        background: rgba(16, 185, 129, 0.15) !important;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.5), 0 0 12px rgba(16,185,129,0.4) !important;
    }
    .picky-hl-pinned.picky-hl-preview {
        outline: 4px solid #10b981 !important;
    }
    /* 숨김 토글 미리보기: 차단 시 모습 그대로 시뮬레이션 */
    .${HIDE_CLASS} {
        display: none !important;
    }`;
    const injectPageCss = () => {
        if (document.getElementById('picky-page-css')) return;
        const s = document.createElement('style');
        s.id = 'picky-page-css';
        s.textContent = PAGE_CSS;
        (document.head || document.documentElement).appendChild(s);
    };

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
            if (inspector) {
                inspector.state.iconPos = null;
                inspector.state.panelPos = null;
                inspector.applyPosition();
            }
        });
        GM_registerMenuCommand?.('숨김 미리보기 해제', () => {
            if (inspector) {
                inspector.clearHidePreview();
                inspector.render?.();
            }
        });
    } catch (_) {}

})();
