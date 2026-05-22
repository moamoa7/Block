// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/hooray804/Picky
// @version      3.7.0
// @description  요소 선택 기반 광고/요소 차단기 — AdGuard/uBlock 호환 규칙 생성, 전체 규칙 뷰어, 모바일 완전 대응 (터치 픽킹, 동적 viewport, 44px 타겟, 좌표 보정)
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

    const TOOL_ID    = 'picky-tool-root';
    const ROOT_ID    = 'picky-shadow-host';
    const HL_CLASS   = 'picky-hl';
    const ISO_BODY   = 'picky-iso-body';
    const ISO_PATH   = 'picky-iso-path';
    const SHIELD_ID  = 'picky-shield';
    const HIDE_CLASS = 'picky-hidden-preview';
    const DRAG_THRESHOLD = 6;

    // ★ v3.7.0: 모바일 감지
    const IS_TOUCH = (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
    const IS_MOBILE = IS_TOUCH && Math.min(window.innerWidth, window.innerHeight) < 768;

    // ★ v3.7.0: Shield 픽킹 시 조준점 오프셋 (손가락이 가리는 부분 보정)
    const SHIELD_AIM_OFFSET_Y = IS_TOUCH ? -40 : 0;

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

    // ★ v3.7.0: 진동 피드백 (지원하는 모바일에서만)
    const vibrate = (ms = 15) => {
        try { navigator.vibrate?.(ms); } catch (_) {}
    };

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
        'bidswitch.net', 'contextweb.com',
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
    const ICON_GLOBE   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
    const ICON_CHECK   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

    const Blocker = {
        STYLE_ID: 'picky-block-style',
        KEY_RULES: 'picky_rules_v2',
        KEY_HIST:  'picky_history_v1',
        KEY_ENABLED: 'picky_enabled',
        KEY_AGG:   'picky_aggressive',

        async init() {
            const apply = () => this.enforce();
            if (document.documentElement) apply();
            // ★ v3.7.0: 디바운스 적용
            let timer = null;
            new MutationObserver(() => {
                if (timer) return;
                timer = setTimeout(() => {
                    timer = null;
                    if (document.head && !document.getElementById(this.STYLE_ID)) apply();
                }, 200);
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

        saveForHost(host, rules) {
            const all = this.fetchAll();
            if (!rules || !rules.length) {
                delete all[host];
            } else {
                all[host] = rules;
            }
            GM_setValue(this.KEY_RULES, JSON.stringify(all));
            this.enforce();
        },

        dropFromHost(host, sel) {
            const all = this.fetchAll();
            if (!all[host]) return;
            all[host] = all[host].filter(r => r !== sel);
            if (!all[host].length) delete all[host];
            GM_setValue(this.KEY_RULES, JSON.stringify(all));
            this.enforce();
            this.pushHistory({ act: 'del', sel, host, ts: Date.now() });
        },

        clearHost(host) {
            const all = this.fetchAll();
            const removed = all[host] || [];
            delete all[host];
            GM_setValue(this.KEY_RULES, JSON.stringify(all));
            this.enforce();
            for (const sel of removed) {
                this.pushHistory({ act: 'del', sel, host, ts: Date.now() });
            }
        },

        clearAll() {
            const all = this.fetchAll();
            for (const host of Object.keys(all)) {
                for (const sel of (all[host] || [])) {
                    this.pushHistory({ act: 'del', sel, host, ts: Date.now() });
                }
            }
            GM_setValue(this.KEY_RULES, JSON.stringify({}));
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
            if (last.act === 'add') {
                const all = this.fetchAll();
                if (all[last.host]) {
                    all[last.host] = all[last.host].filter(r => r !== last.sel);
                    if (!all[last.host].length) delete all[last.host];
                    GM_setValue(this.KEY_RULES, JSON.stringify(all));
                    this.enforce();
                }
            } else if (last.act === 'del') {
                const all = this.fetchAll();
                if (!all[last.host]) all[last.host] = [];
                if (!all[last.host].includes(last.sel)) {
                    all[last.host].push(last.sel);
                }
                GM_setValue(this.KEY_RULES, JSON.stringify(all));
                this.enforce();
            }
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
                ? 'display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;width:0!important;min-width:0!important;max-width:0!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important;'
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
            if (scope === 'global' || !this.host()) return `##${sel}`;
            return `${this.host()}##${sel}`;
        },

        exportJSON() {
            const data = {
                app: 'Picky Advanced',
                version: '3.7.0',
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
                `! Version: 3.7.0`,
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

    class Modal {
        constructor(container) {
            this.container = container;
            this.node = null;
            this._onDismiss = null;
            this._vvHandler = null;
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

            // ★ v3.7.0: visualViewport로 모달 높이 동적 조정 (가상키보드 대응)
            if (window.visualViewport) {
                const card = wrap.querySelector('.picky-modal-card');
                this._vvHandler = () => {
                    if (!card) return;
                    const vh = window.visualViewport.height;
                    card.style.maxHeight = Math.min(vh - 16, vh * 0.95) + 'px';
                };
                this._vvHandler();
                window.visualViewport.addEventListener('resize', this._vvHandler);
                window.visualViewport.addEventListener('scroll', this._vvHandler);
            }

            return bodyEl;
        }

        dismiss() {
            if (!this.node) return;
            const n = this.node;
            n.classList.remove('visible');
            setTimeout(() => n.remove(), 200);
            this.node = null;

            if (this._vvHandler && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._vvHandler);
                window.visualViewport.removeEventListener('scroll', this._vvHandler);
                this._vvHandler = null;
            }

            if (typeof this._onDismiss === 'function') {
                try { this._onDismiss(); } catch (_) {}
                this._onDismiss = null;
            }
        }
    }

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

        static scoreSelector(sel, el, options = {}) {
            if (!sel) return 0;
            const matches = this.countMatches(sel);
            if (matches === 0) return 0;

            try {
                const list = document.querySelectorAll(sel);
                if (el && ![...list].includes(el)) return 0;
            } catch (_) { return 0; }

            let perfScore = 0;
            const lastSimple = sel.split(/\s|>|\+|~/).pop().trim();

            if (/^#[\w\\-]+$/.test(lastSimple)) perfScore = 60;
            else if (/^#[\w\\-]+(?:\.[\w\\-]+)+$/.test(lastSimple)) perfScore = 58;
            else if (/^[a-z]+\.[\w\\-]+$/i.test(lastSimple)) perfScore = 50;
            else if (/^\.[\w\\-]+$/.test(lastSimple)) perfScore = 48;
            else if (/^\.[\w\\-]+(?:\.[\w\\-]+)+$/.test(lastSimple)) perfScore = 46;
            else if (/\[[a-z-]+="/i.test(lastSimple)) perfScore = 38;
            else if (/\[[a-z-]+\^="/i.test(lastSimple)) perfScore = 34;
            else if (/\[[a-z-]+\$="/i.test(lastSimple)) perfScore = 32;
            else if (/\[[a-z-]+\*="/i.test(lastSimple)) perfScore = 26;
            else if (/^[a-z]+$/i.test(lastSimple)) perfScore = 32;
            else perfScore = 20;

            if (/:has\(/.test(sel)) perfScore -= 12;
            if (/:nth-of-type|:nth-child/.test(sel)) perfScore -= 6;
            if (/:nth-of-type\(\d+\).*:nth-of-type/.test(sel)) perfScore -= 6;

            if (sel.length <= 35) perfScore += 10;
            else if (sel.length <= 60) perfScore += 4;
            else if (sel.length >= 100) perfScore -= 8;

            const combinatorCount = (sel.match(/[\s>+~]/g) || []).length;
            if (combinatorCount >= 4) perfScore -= 10;
            else if (combinatorCount >= 2) perfScore -= 4;

            perfScore = Math.max(0, perfScore);

            let accScore = 0;
            if (matches === 1) accScore = 42;
            else if (matches === 2) accScore = 30;
            else if (matches <= 5) accScore = 22;
            else if (matches <= 10) accScore = 16;
            else if (matches <= 30) accScore = 10;
            else if (matches <= 100) accScore = 5;
            else accScore = 2;

            let intentBonus = 0;
            if (/\[(?:data-ad|data-advertisement)/i.test(sel)) intentBonus += 4;
            if (/aria-label\*?="[^"]*(?:광고|ad|banner)/i.test(sel)) intentBonus += 3;
            if (options.bonus) intentBonus += options.bonus;

            const isExactAttrMatch = /\[(?:src|href|data-[\w-]+|id|name|alt|title|aria-label)="[^"]+"\]/i.test(sel);
            if (isExactAttrMatch && matches === 1) intentBonus += 25;

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

        static _simpleSelectorFor(el) {
            if (!el || !el.tagName) return '';
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
                const idSel = `#${CSS.escape(el.id)}`;
                if (this.countMatches(idSel) === 1) return idSel;
            }
            const tag = el.tagName.toLowerCase();
            const classes = this.meaningfulClasses(el);

            if (classes.length) {
                let sel = `${tag}.${CSS.escape(classes[0])}`;
                if (classes.length >= 2) sel += `.${CSS.escape(classes[1])}`;
                return sel;
            }

            const parent = el.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                if (sameTag.length === 1) return tag;
                const idx = sameTag.indexOf(el) + 1;
                return `${tag}:nth-of-type(${idx})`;
            }
            return tag;
        }

        static uniqueAncestorPath(el) {
            if (!el || !el.tagName) return [];
            const candidates = [];

            const buildPath = (combinator) => {
                const parts = [this._simpleSelectorFor(el)];
                let cur = el.parentElement;
                let depth = 0;
                const maxDepth = 10;

                while (cur && cur !== document.body && cur !== document.documentElement && depth < maxDepth) {
                    const segment = this._simpleSelectorFor(cur);
                    parts.unshift(segment);
                    const sel = parts.join(combinator === '>' ? ' > ' : ' ');
                    const matchCount = this.countMatches(sel);
                    if (matchCount === 1) return sel;
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

            let idAncestor = null;
            let p = el.parentElement;
            let d = 1;
            while (p && p !== document.body && d <= 15) {
                if (p.id && /^[a-zA-Z][\w-]*$/.test(p.id) &&
                    this.countMatches(`#${CSS.escape(p.id)}`) === 1) {
                    idAncestor = p;
                    break;
                }
                p = p.parentElement;
                d++;
            }

            if (idAncestor) {
                const chain = [];
                let cur = el;
                while (cur && cur !== idAncestor) {
                    chain.unshift(cur);
                    cur = cur.parentElement;
                }

                const idSel = `#${CSS.escape(idAncestor.id)}`;
                let buildingPath = idSel;

                {
                    const tailParts = chain.map(node => {
                        const tag = node.tagName.toLowerCase();
                        const classes = this.meaningfulClasses(node);
                        if (classes.length) {
                            let seg = `${tag}.${CSS.escape(classes[0])}`;
                            if (classes.length >= 2) seg += `.${CSS.escape(classes[1])}`;
                            return seg;
                        }
                        return tag;
                    });

                    for (let take = 1; take <= tailParts.length; take++) {
                        const sub = tailParts.slice(tailParts.length - take).join(' > ');
                        const cnt = this.countMatches(sub);
                        if (cnt === 0) continue;
                        try {
                            const matched = document.querySelectorAll(sub);
                            if (![...matched].includes(el)) continue;
                        } catch (_) { continue; }
                        const hasClass = tailParts.slice(tailParts.length - take)
                            .some(p => p.includes('.'));
                        if (!hasClass) continue;
                        candidates.push({
                            sel: sub,
                            hint: cnt === 1
                                ? `최단 유일 경로 (${take}단계)`
                                : `최단 그룹 경로 (${take}단계, ${cnt}개 매치)`
                        });
                        break;
                    }

                    for (let take = 1; take <= tailParts.length; take++) {
                        const sub = tailParts.slice(tailParts.length - take).join(' ');
                        const cnt = this.countMatches(sub);
                        if (cnt === 0) continue;
                        try {
                            const matched = document.querySelectorAll(sub);
                            if (![...matched].includes(el)) continue;
                        } catch (_) { continue; }
                        const hasClass = tailParts.slice(tailParts.length - take)
                            .some(p => p.includes('.'));
                        if (!hasClass) continue;
                        candidates.push({
                            sel: sub,
                            hint: cnt === 1
                                ? `최단 유일 경로 (자손, ${take}단계)`
                                : `최단 그룹 경로 (자손, ${take}단계, ${cnt}개 매치)`
                        });
                        break;
                    }
                }

                for (let i = 0; i < chain.length; i++) {
                    const node = chain[i];
                    const parent = node.parentElement;
                    const tag = node.tagName.toLowerCase();
                    const classes = this.meaningfulClasses(node);
                    const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
                    const nthIdx = sameTagSiblings.indexOf(node) + 1;

                    let segment;
                    if (classes.length) {
                        segment = `${tag}.${CSS.escape(classes[0])}`;
                        if (classes.length >= 2) segment += `.${CSS.escape(classes[1])}`;
                    } else if (sameTagSiblings.length > 1) {
                        segment = `${tag}:nth-of-type(${nthIdx})`;
                    } else {
                        segment = tag;
                    }

                    buildingPath += ` > ${segment}`;
                    const cnt = this.countMatches(buildingPath);

                    if (node === el) {
                        if (cnt === 1) {
                            candidates.push({ sel: buildingPath, hint: `ID 루트 경로 (매치 1개)` });
                        } else if (cnt > 1) {
                            if (classes.length && sameTagSiblings.length > 1) {
                                const refined = buildingPath.replace(
                                    new RegExp(`${tag}\\.${CSS.escape(classes[0]).replace(/\\/g, '\\\\')}(?:\\.[^\\s>]+)?$`),
                                    `${tag}.${CSS.escape(classes[0])}:nth-of-type(${nthIdx})`
                                );
                                if (this.countMatches(refined) === 1) {
                                    candidates.push({ sel: refined, hint: `ID 루트 경로 + 위치 (매치 1개)` });
                                }
                            }
                            if (!classes.length || sameTagSiblings.length > 1) {
                                const nthOnly = buildingPath.replace(/[^>]+$/, ` ${tag}:nth-of-type(${nthIdx})`);
                                if (this.countMatches(nthOnly) === 1) {
                                    candidates.push({ sel: nthOnly, hint: `ID 루트 경로 (형제 위치)` });
                                }
                            }
                        }
                    }
                }

                let forcedPath = idSel;
                let allMeaningful = true;
                for (const node of chain) {
                    const parent = node.parentElement;
                    const tag = node.tagName.toLowerCase();
                    const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
                    const nthIdx = sameTagSiblings.indexOf(node) + 1;
                    const classes = this.meaningfulClasses(node);

                    if (classes.length) {
                        forcedPath += ` > ${tag}.${CSS.escape(classes[0])}`;
                    } else if (sameTagSiblings.length > 1) {
                        forcedPath += ` > ${tag}:nth-of-type(${nthIdx})`;
                        allMeaningful = false;
                    } else {
                        forcedPath += ` > ${tag}`;
                        allMeaningful = false;
                    }
                }

                if (!allMeaningful && this.countMatches(forcedPath) === 1) {
                    candidates.push({ sel: forcedPath, hint: 'ID 루트 + 위치 기반 (uBlock 호환)' });
                }

                const lastTag = el.tagName.toLowerCase();
                const allSameTag = idAncestor.querySelectorAll(lastTag);
                if (allSameTag.length === 1) {
                    candidates.push({ sel: `${idSel} ${lastTag}`, hint: `ID 내 유일한 ${lastTag}` });
                }
            }

            return this._topN(
                candidates,
                { type: 'uniquePath', icon: '🎯', label: '유일 타겟팅 경로' },
                el, 4
            );
        }

        static fullChainWithNth(el) {
            if (!el || !el.tagName) return [];
            const candidates = [];
            const parts = [];
            let cur = el;
            let depth = 0;

            while (cur && cur.tagName && depth < 10) {
                const tag = cur.tagName.toLowerCase();
                if (tag === 'body' || tag === 'html') break;
                let piece = tag;
                const classes = this.meaningfulClasses(cur);
                if (classes.length > 0) piece += '.' + CSS.escape(classes[0]);
                const parent = cur.parentElement;
                if (parent) {
                    const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                    if (sameTag.length > 1) {
                        const nth = sameTag.indexOf(cur) + 1;
                        piece += `:nth-of-type(${nth})`;
                    }
                }
                parts.unshift(piece);

                const chain = parts.join(' > ');
                if (this.countMatches(chain) === 1) {
                    const isEmpty = !el.textContent.trim() && el.children.length === 0;
                    const adSlotHint = /\b(tv|ad|ads|banner|slot|widget|sponsor|promo)\b/i;
                    const looksLikeAdSlot = el.className && adSlotHint.test(el.className);
                    const treatAsEmpty = isEmpty || (el.children.length === 0 && looksLikeAdSlot);

                    candidates.push({
                        sel: chain,
                        hint: '체인 + nth (정확한 요소)',
                        bonus: treatAsEmpty ? 5 : 12
                    });

                    if (parts.length >= 2) {
                        const parentOnly = parts.slice(0, -1).join(' > ');
                        if (this.countMatches(parentOnly) === 1) {
                            candidates.push({
                                sel: parentOnly,
                                hint: '부모 단독 (박스째 숨김, uBlock 호환)',
                                bonus: treatAsEmpty ? 18 : 9
                            });
                        }
                    }
                    break;
                }
                cur = parent;
                depth++;
            }

            if (candidates.length === 0 && parts.length >= 2) {
                for (let cut = parts.length - 1; cut >= 1; cut--) {
                    const upper = parts.slice(0, cut).join(' > ');
                    if (this.countMatches(upper) === 1) {
                        const node = document.querySelector(upper);
                        if (node && node.contains(el)) {
                            candidates.push({
                                sel: upper,
                                hint: `상위 ${parts.length - cut}단계 단독 (박스째 숨김)`,
                                bonus: 14
                            });
                            break;
                        }
                    }
                }
            }

            return this._topN(
                candidates,
                { type: 'fullChain', icon: '🎯', label: '체인 위치 식별 (uBlock 호환)' },
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

            return this._topN(candidates, { type: 'semantic', icon: '🏷️', label: '의미있는 속성' }, el, 2);
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

            if (!candidates.length && this.countMatches(tag) <= 5) {
                candidates.push({ sel: tag, hint: '태그만' });
            }

            return this._topN(candidates, { type: 'shortest', icon: '✨', label: '가장 짧은 셀렉터' }, el, 2);
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

            return this._topN(candidates, { type: 'dummyHref', icon: '🔗', label: '더미 링크 (광고 클릭 패턴)' }, el, 2);
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

            return this._topN(candidates, { type: 'classPattern', icon: '📎', label: '클래스 패턴' }, el, 2);
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

            return this._topN(candidates, { type: 'similarGroup', icon: '👥', label: '유사 그룹' }, el, 2);
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
                    candidates.push({ sel: `#${CSS.escape(id)}`, hint: `광고 키워드 ID: ${id}` });
                }
                for (const c of classes) {
                    if (adKeywords.some(k => c.toLowerCase().includes(k))) {
                        candidates.push({ sel: `.${CSS.escape(c)}`, hint: `광고 키워드 컨테이너: ${c}` });
                    }
                }
                if (containerTags.includes(tag) && classes.length) {
                    candidates.push({ sel: `${tag}.${CSS.escape(classes[0])}`, hint: `시맨틱 컨테이너: ${tag}` });
                }
            }

            return this._topN(candidates, { type: 'container', icon: '🎨', label: '부모 컨테이너' }, el, 2);
        }

        static parentContainerOfBlocked(el) {
            if (!SUPPORTS_HAS) return [];
            if (!el || !el.parentElement) return [];

            const parent = el.parentElement;
            if (parent === document.body || parent === document.documentElement) return [];

            const cls = (parent.className && typeof parent.className === 'string' ? parent.className : '').toLowerCase();
            const id = (parent.id || '').toLowerCase();
            const hint = /ad|banner|promo|sponsor|wrapper|container|thumb|item|card/i;
            if (!hint.test(cls) && !hint.test(id)) return [];

            const candidates = [];
            const parentSimple = this._simpleSelectorFor(parent);
            const childSimple = this._simpleSelectorFor(el);

            if (parentSimple && childSimple) {
                candidates.push({
                    sel: `${parentSimple}:has(> ${childSimple})`,
                    hint: '부모 컨테이너 (빈 공간 제거)'
                });
                candidates.push({
                    sel: `${parentSimple}:has(${childSimple})`,
                    hint: '부모 컨테이너 (자손 포함)'
                });
            }

            return this._topN(candidates, { type: 'parentContainer', icon: '📦', label: '부모 컨테이너 (:has)' }, parent, 2);
        }

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

            candidates.push({ sel: `img[src="${CSS.escape(src)}"]`, hint: '정확한 이미지 URL' });

            if (fileName && fileName.length >= 4 && fileName.length <= 80) {
                candidates.push({ sel: `img[src$="${CSS.escape(fileName)}"]`, hint: `파일명 끝매칭: ${fileName}` });
            }
            if (dirPath && dirPath.length > 3 && dirPath !== '/') {
                candidates.push({ sel: `img[src*="${CSS.escape(dirPath)}"]`, hint: `디렉토리: ${dirPath}` });
            }
            if (url.hostname) {
                candidates.push({ sel: `img[src*="${CSS.escape(url.hostname)}"]`, hint: `호스트: ${url.hostname}` });
            }

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
                    candidates.push({ sel: `a.${CSS.escape(aClasses[0])} > img`, hint: `링크 클래스: .${aClasses[0]}` });
                }
            }

            const imgClasses = this.meaningfulClasses(img);
            if (imgClasses.length) {
                candidates.push({ sel: `img.${CSS.escape(imgClasses[0])}`, hint: `이미지 클래스: .${imgClasses[0]}` });
            }

            const alt = img.getAttribute('alt');
            if (alt && alt.length > 0 && alt.length <= 40) {
                candidates.push({ sel: `img[alt="${CSS.escape(alt)}"]`, hint: `alt="${alt}"` });
            }

            return this._topN(candidates, { type: 'imgAlwaysCss', icon: '🖼️', label: '이미지 CSS 셀렉터' }, img, 4);
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
                candidates.push({ sel: `img[src*="${adHost}"]`, hint: `광고 네트워크: ${adHost}` });
            }
            if (host !== location.hostname && !location.hostname.endsWith(host)) {
                candidates.push({ sel: `img[src*="${host}"]`, hint: `외부 도메인: ${host}` });
            }

            return this._topN(candidates, { type: 'imgSrcDomain', icon: '🖼️', label: '광고 도메인 이미지' }, img, 2);
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
                { sel: `img[width="${matched[0]}"][height="${matched[1]}"]`, hint: `IAB 표준: ${matched[0]}×${matched[1]}` }
            ];
            if (hasExtLink) {
                candidates.push({
                    sel: `a[href] > img[width="${matched[0]}"][height="${matched[1]}"]`,
                    hint: `IAB 크기 + 외부 링크`
                });
            }

            return this._topN(candidates, { type: 'imgStandardSize', icon: '📐', label: '표준 광고 크기' }, img, 2);
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

            return this._topN(candidates, { type: 'imgInAdLink', icon: '🔗', label: '광고 링크 내 이미지' }, img, 2);
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
                    candidates.push({ sel: `img[src*="${file}"]`, hint: `파일명: ${file}` });
                }
            } catch (_) {}

            return this._topN(candidates, { type: 'imgPathPattern', icon: '📦', label: '이미지 경로 패턴' }, img, 2);
        }

        static networkFilter(el) {
            const targets = [];
            const TAG_SRC = ['IMG', 'IFRAME', 'SCRIPT', 'VIDEO', 'AUDIO', 'SOURCE', 'EMBED'];

            if (TAG_SRC.includes(el.tagName)) targets.push(el);
            else {
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
                    type: 'networkFilter', icon: '🌐', label: '네트워크 필터',
                    selector: cssSel, filter, isNetwork: true,
                    matches: this.countMatches(cssSel),
                    score, stars: this.scoreToStars(score), hint
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

                push(`||${host}${path}`, cssExact, `정확 URL 차단: ${fileName || path}`, isAdHost ? 92 : (isExternal ? 80 : 72));
                push(`||${host}^`, cssBase,
                    isAdHost ? `광고 호스트 전체 차단: ${host}` : (isExternal ? `외부 도메인 전체 차단: ${host}` : `자사 도메인 차단: ${host}`),
                    isAdHost ? 95 : (isExternal ? 78 : 50));

                if (dirPath && dirPath.length > 1 && dirPath !== '/') {
                    push(`||${host}${dirPath}*`, `${tagLow}[src*="${dirPath}"]`, `디렉토리 차단: ${dirPath}`,
                        isAdHost ? 88 : (adPathMatch ? 82 : 68));
                }
                if (adPathMatch) {
                    push(`||${host}*${adPathMatch.kw}*`, `${tagLow}[src*="${adPathMatch.kw}"]`,
                        `광고 키워드 와일드카드: ${adPathMatch.kw}`, 85);
                }
                if (isExternal) {
                    const typeOpt = tagLow === 'img' ? '$image'
                                  : tagLow === 'iframe' ? '$subdocument'
                                  : tagLow === 'script' ? '$script' : '';
                    if (typeOpt) {
                        push(`||${host}^${typeOpt}`, cssBase, `${host} (${typeOpt.slice(1)} 한정)`, isAdHost ? 90 : 76);
                    }
                    push(`||${host}^$third-party`, cssBase, `${host} (3rd-party 한정)`, isAdHost ? 88 : 74);
                }
                if (fileName && fileName.length >= 4 && fileName.length <= 50 &&
                    !/^[0-9a-f]{20,}$/i.test(fileName)) {
                    push(`||${host}*/${fileName}`, `${tagLow}[src$="${fileName}"]`, `파일명: ${fileName}`,
                        adPathMatch ? 78 : 62);
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
                candidates.push({ sel: `${tag}:nth-of-type(${myIdx})`, hint: `${myIdx}번째 ${tag}` });
            }

            const parentClasses = this.meaningfulClasses(parent);
            if (parent.parentElement && parentClasses.length) {
                const parentSameTag = Array.from(parent.parentElement.children).filter(c => c.tagName === parent.tagName);
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

            return this._topN(candidates, { type: 'mixedNth', icon: '🧩', label: '혼합 위치 셀렉터' }, el, 2);
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
                    candidates.push({ sel: `${tag}:has(> iframe)`, hint: 'iframe 직접 자식' });
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

            return this._topN(candidates, { type: 'multiCondition', icon: '🔧', label: '다중 조건 조합' }, el, 2);
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
                        candidates.push({ sel: `[aria-label*="${CSS.escape(matched)}"]`, hint: `aria-label에 "${matched}"` });
                        candidates.push({ sel: `${tag}[aria-label*="${CSS.escape(matched)}"]`, hint: `${tag} + aria-label "${matched}"` });
                    } else if (ariaLabel.length <= 30) {
                        candidates.push({ sel: `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`, hint: `aria-label="${ariaLabel}"` });
                    }
                }
                if (role && ['banner', 'complementary', 'advertisement'].includes(role)) {
                    candidates.push({ sel: `[role="${CSS.escape(role)}"]`, hint: `role="${role}"` });
                }
                if (ariaLabelledby) {
                    candidates.push({ sel: `[aria-labelledby="${CSS.escape(ariaLabelledby)}"]`, hint: `aria-labelledby 참조` });
                }
            }

            return this._topN(candidates, { type: 'ariaLabel', icon: '♿', label: 'ARIA / 접근성' }, el, 2);
        }

        static buildAll(el, evaluator) {
            if (!el || !el.tagName) return [];

            const strategies = [
                () => this.semantic(el),
                () => this.shortest(el),
                () => this.fullChainWithNth(el),
                () => this.uniqueAncestorPath(el),
                () => this.dummyHref(el),
                () => this.classPattern(el),
                () => this.precise(el, evaluator),
                () => this.similarGroup(el),
                () => this.container(el),
                () => this.parentContainerOfBlocked(el),
                () => this.networkFilter(el),
                () => this.mixedNth(el),
                () => this.multiCondition(el),
                () => this.ariaLabel(el)
            ];

            if (this.isImageRelated(el)) {
                strategies.push(
                    () => this.imgAlwaysCss(el),
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

            const filtered = results.filter(r => {
                if (/picky-/.test(r.selector)) return false;
                let nodes;
                try { nodes = document.querySelectorAll(r.selector); }
                catch (_) { return false; }
                if (nodes.length === 0) return false;
                const hitsTarget = Array.from(nodes).some(n => n === el || n.contains(el));
                if (!hitsTarget) return false;
                r.matches = nodes.length;
                r.exactMatch = (nodes.length === 1);
                return true;
            });

            const seen = new Set();
            const unique = [];
            for (const r of filtered) {
                const key = `${r.selector}|${r.filter || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(r);
            }

            unique.sort((a, b) => {
                if (a.exactMatch && !b.exactMatch) return -1;
                if (b.exactMatch && !a.exactMatch) return 1;
                const ba = a.bonus ?? 0, bb = b.bonus ?? 0;
                if (ba !== bb) return bb - ba;
                if (b.score !== a.score) return b.score - a.score;
                return a.matches - b.matches;
            });

            if (unique.length) unique[0].recommended = true;
            return unique;
        }

        static toAdGuardRule(candidate, scope = 'host') {
            if (!candidate) return '';
            if (candidate.isNetwork && candidate.filter) return candidate.filter;
            const sel = candidate.selector;
            if (!sel) return '';
            const host = location.hostname || '';
            if (scope === 'global' || !host) return `##${sel}`;
            return `${host}##${sel}`;
        }
    }

    class Inspector {
        constructor() {
            this.dom = {
                host: null, shadow: null, tool: null,
                shield: null, shieldAim: null, shieldConfirm: null,
                disp: null, match: null, slider: null,
                cardsScroll: null
            };
            this.state = {
                target: null, originTarget: null, hierarchy: [],
                queryData: { selector: '', root: document },
                candidates: [], selectedIdx: -1,
                previewNodes: [],
                mode: 'initial',
                scale: 'icon',
                isCollapsed: true,
                hoverPreviewNodes: [],
                pinnedPreviewNodes: [],
                hiddenPreviewNodes: [],
                hiddenSelector: null,
                iconPos: null, panelPos: null,
                picking: false,
                lastHoverEl: null,
                pickCandidate: null,  // ★ v3.7.0: 모바일 픽킹용 후보
                allRulesCollapsed: new Set(),
                allRulesSearch: ''
            };
            this.modal = null;
            this._preciseEvaluator = (el) => this.evaluateCssBasic(el);
            this._onResize = null;
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

            // ★ v3.7.0: 회전/리사이즈 시 위치 보정
            this._onResize = () => {
                this.applyPosition();
            };
            window.addEventListener('resize', this._onResize);
            window.addEventListener('orientationchange', this._onResize);
        }

        // ★ v3.7.0: 저장된 좌표가 화면 밖이면 보정
        applyPosition() {
            const tool = this.dom.tool;
            if (!tool) return;

            tool.style.left = '';
            tool.style.top = '';
            tool.style.right = '';
            tool.style.bottom = '';
            tool.style.transform = '';

            // 강제 reflow로 크기 계산
            const w = tool.offsetWidth || (this.state.scale === 'icon' ? 48 : 380);
            const h = tool.offsetHeight || (this.state.scale === 'icon' ? 48 : 400);

            if (this.state.scale === 'icon') {
                const pos = this.state.iconPos;
                if (pos && typeof pos.x === 'number') {
                    const clamped = this.clampPos(pos.x, pos.y, w, h);
                    tool.style.left = clamped.x + 'px';
                    tool.style.top = clamped.y + 'px';
                    this.state.iconPos = clamped;
                } else {
                    tool.style.right = '20px';
                    tool.style.bottom = '20px';
                }
            } else {
                const pos = this.state.panelPos;
                if (pos && typeof pos.x === 'number') {
                    const clamped = this.clampPos(pos.x, pos.y, w, h);
                    tool.style.left = clamped.x + 'px';
                    tool.style.top = clamped.y + 'px';
                    this.state.panelPos = clamped;
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
            this.restoreSliderState();
        }

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
                <span class="picky-title">Picky <small>v3.7.0</small></span>
                <div class="picky-head-btns">
                    <button class="picky-btn picky-btn-icon" data-act="showAllRules" title="전체 규칙 뷰어">${ICON_GLOBE}</button>
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
                    <button class="picky-btn" data-act="showRules" title="현재 사이트 규칙">📋</button>
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
                <div class="picky-cards-info">총 ${list.length}개 후보 · 점수순 · ${IS_TOUCH ? '탭:선택' : '호버:미리보기 · 클릭:핀'} · 👁:숨김</div>
                ${list.map((c, i) => this.renderCard(c, i)).join('')}
            `;

            wrap.querySelectorAll('.picky-card').forEach(card => {
                const idx = parseInt(card.dataset.idx, 10);
                if (!IS_TOUCH) {
                    card.addEventListener('mouseenter', () => this.previewCandidate(idx));
                    card.addEventListener('mouseleave', () => this.clearPreview());
                }
                card.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    if (e.target.closest('[data-card-act]')) return;
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
                <div class="picky-card-css" title="${IS_TOUCH ? '탭하면 CSS 복사' : '클릭하면 CSS 복사'}" data-card-act="copyCssQuick">
                    <span class="picky-card-css-label">CSS:</span>
                    <span class="picky-card-css-text">${esc(c.selector)}</span>
                    <span class="picky-card-matches">·${c.matches}개</span>
                </div>
                <div class="picky-card-filter-clickable" title="${IS_TOUCH ? '탭하면 필터 복사' : '클릭하면 필터 복사'}" data-card-act="copyFilterQuick">
                    <span class="picky-card-css-label">필터:</span>
                    <span class="picky-card-css-text">${esc(filterText)}</span>
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
                const targetEl = document.querySelector(c.selector);
                const parentEl = targetEl ? targetEl.parentElement : null;
                const parentRectBefore = parentEl ? parentEl.getBoundingClientRect() : null;

                this.clearHidePreview();
                if (Blocker.append(c.selector)) {
                    vibrate(20);
                    this.flashToast(`차단: ${c.selector.slice(0, 50)}`);
                    this.refreshMetrics();
                    this.render();
                    this.checkOrphanSpace(parentEl, parentRectBefore);
                } else {
                    this.flashToast('이미 등록된 규칙');
                }
            } else if (act === 'toggleHide') {
                if (c.isNetwork) return;
                const result = this.toggleHidePreview(c.selector);
                if (result.hidden) {
                    vibrate(15);
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
            } else if (act === 'copyCssQuick') {
                await this.copyText(c.selector);
                this.flashToast('CSS 복사됨: ' + c.selector.slice(0, 40));
            } else if (act === 'copyFilterQuick') {
                const text = SelectorStrategies.toAdGuardRule(c);
                await this.copyText(text);
                this.flashToast('필터 복사됨');
            }
        }

        checkOrphanSpace(parent, rectBefore) {
            if (!parent || !rectBefore) return;
            setTimeout(() => {
                if (!parent.isConnected) return;
                const newRect = parent.getBoundingClientRect();
                const visibleChildren = Array.from(parent.children).filter(c => {
                    const r = c.getBoundingClientRect();
                    return r.width > 1 && r.height > 1;
                });
                if (newRect.height > 30 && visibleChildren.length === 0) {
                    this.showOrphanSpaceToast(parent, newRect);
                }
            }, 150);
        }

        showOrphanSpaceToast(parent, rect) {
            const existing = this.dom.shadow.querySelector('.picky-orphan-toast');
            if (existing) existing.remove();

            const sel = SelectorStrategies._simpleSelectorFor(parent);
            if (!sel) return;

            const toast = document.createElement('div');
            toast.className = 'picky-orphan-toast';
            toast.innerHTML = `
                <div class="picky-orphan-msg">
                    빈 공간(${Math.round(rect.height)}px)이 남았습니다.<br>
                    부모도 함께 차단하시겠습니까?
                </div>
                <div class="picky-orphan-sel">${esc(sel)}</div>
                <div class="picky-orphan-btns">
                    <button class="picky-btn picky-btn-danger" data-orphan="block">⛔ 부모 차단</button>
                    <button class="picky-btn" data-orphan="ignore">무시</button>
                </div>
            `;
            this.dom.shadow.appendChild(toast);
            setTimeout(() => toast.classList.add('visible'), 10);

            const dismiss = () => {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 200);
            };

            toast.querySelector('[data-orphan="block"]').addEventListener('click', () => {
                if (Blocker.append(sel)) {
                    vibrate(20);
                    this.flashToast('부모 컨테이너도 차단됨');
                    this.refreshMetrics();
                }
                dismiss();
            });
            toast.querySelector('[data-orphan="ignore"]').addEventListener('click', dismiss);
            setTimeout(dismiss, 8000);
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
        }

        clearPreview() {
            for (const n of this.state.hoverPreviewNodes) {
                n.classList.remove('picky-hl-preview');
            }
            this.state.hoverPreviewNodes = [];
        }

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
            this.state.hierarchy = [...upChain.reverse(), this.state.originTarget];
            const slider = this.dom.slider;
            if (slider) {
                slider.min = 0;
                slider.max = this.state.hierarchy.length - 1;
                slider.value = this.state.hierarchy.length - 1;
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
            }

            this.refreshMetrics();
            this.renderCandidates();
            this.setFocus(el);

            if (!updateOrigin) {
                const hier = this.state.hierarchy;
                if (this.dom.slider && hier && hier.length) {
                    const i = hier.indexOf(el);
                    if (i >= 0) this.dom.slider.value = i;
                }
            }
        }

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

        // ★★★ v3.7.0: 모바일 완전 대응 Shield 픽킹
        startPicking() {
            if (this.state.picking) return;
            this.clearHidePreview();
            this.state.picking = true;
            this.state.mode = 'picking';
            this.state.pickCandidate = null;

            // 패널을 일시 축소(모바일에서 가림 최소화)
            if (IS_MOBILE && this.state.scale === 'full') {
                this._wasFullBeforePick = true;
                this.state.scale = 'icon';
                this.render();
                this.applyPosition();
            }

            const shield = document.createElement('div');
            shield.id = SHIELD_ID;
            document.documentElement.appendChild(shield);
            this.dom.shield = shield;

            // 조준점 인디케이터 (모바일)
            if (IS_TOUCH) {
                const aim = document.createElement('div');
                aim.className = 'picky-aim';
                aim.innerHTML = '<div class="picky-aim-cross"></div>';
                shield.appendChild(aim);
                this.dom.shieldAim = aim;

                // "이 요소 선택" 확정 버튼
                const confirm = document.createElement('div');
                confirm.className = 'picky-shield-confirm';
                confirm.innerHTML = `
                    <div class="picky-shield-msg">손가락으로 요소를 가리키세요 (조준점이 위쪽으로 표시됩니다)</div>
                    <div class="picky-shield-btns">
                        <button class="picky-btn picky-btn-primary" data-shield="confirm" disabled>${ICON_CHECK} 이 요소 선택</button>
                        <button class="picky-btn" data-shield="cancel">${ICON_CLOSE} 취소</button>
                    </div>
                `;
                shield.appendChild(confirm);
                this.dom.shieldConfirm = confirm;

                confirm.querySelector('[data-shield="confirm"]').addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.state.pickCandidate) {
                        const el = this.state.pickCandidate;
                        this.cleanupShieldHl();
                        vibrate(25);
                        this.selectNode(el, true);
                        this.stopPicking();
                    }
                });
                confirm.querySelector('[data-shield="cancel"]').addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.stopPicking();
                });
            }

            // ★ pointer 이벤트 통합 (마우스/터치/펜 모두 지원)
            const pickAt = (x, y) => {
                shield.style.pointerEvents = 'none';
                if (this.dom.shieldAim) this.dom.shieldAim.style.pointerEvents = 'none';
                if (this.dom.shieldConfirm) this.dom.shieldConfirm.style.pointerEvents = 'none';

                const aimX = x;
                const aimY = y + SHIELD_AIM_OFFSET_Y;  // 모바일은 손가락 위쪽

                let el = document.elementFromPoint(aimX, aimY);

                shield.style.pointerEvents = 'auto';
                if (this.dom.shieldAim) this.dom.shieldAim.style.pointerEvents = 'none';
                if (this.dom.shieldConfirm) this.dom.shieldConfirm.style.pointerEvents = 'auto';

                if (!el || (el.closest && el.closest(`#${ROOT_ID}`))) return null;
                el = this.refineTargetAtPoint(el, aimX, aimY);
                return el;
            };

            this._shieldMove = (e) => {
                const el = pickAt(e.clientX, e.clientY);

                // 조준점 위치 업데이트
                if (this.dom.shieldAim) {
                    const aimX = e.clientX;
                    const aimY = e.clientY + SHIELD_AIM_OFFSET_Y;
                    this.dom.shieldAim.style.left = aimX + 'px';
                    this.dom.shieldAim.style.top = aimY + 'px';
                }

                if (!el) return;
                if (this.state.lastHoverEl === el) return;
                if (this.state.lastHoverEl) {
                    this.state.lastHoverEl.classList.remove('picky-hl-preview');
                }
                el.classList.add('picky-hl-preview');
                this.state.lastHoverEl = el;
                this.state.pickCandidate = el;

                // 모바일: "이 요소 선택" 버튼 활성화 + 정보 갱신
                if (this.dom.shieldConfirm) {
                    const btn = this.dom.shieldConfirm.querySelector('[data-shield="confirm"]');
                    if (btn) btn.disabled = false;
                    const msg = this.dom.shieldConfirm.querySelector('.picky-shield-msg');
                    if (msg) {
                        const tag = el.tagName.toLowerCase();
                        const id = el.id ? `#${el.id}` : '';
                        const cls = SelectorStrategies.meaningfulClasses(el).slice(0, 2).map(c => '.' + c).join('');
                        msg.innerHTML = `<code>${esc(tag + id + cls)}</code>`;
                    }
                }
            };

            this._shieldDown = (e) => {
                // 확정 버튼 영역은 무시
                if (e.target.closest('.picky-shield-confirm')) return;
                if (e.cancelable) e.preventDefault();
                e.stopPropagation();

                // PC: 즉시 선택 / 모바일: pointermove와 동일하게 후보 갱신
                if (!IS_TOUCH) {
                    let el = pickAt(e.clientX, e.clientY);
                    if (!el) { this.stopPicking(); return; }

                    if (e.altKey) {
                        shield.style.pointerEvents = 'none';
                        const stack = document.elementsFromPoint(e.clientX, e.clientY)
                            .filter(n => n && !n.closest(`#${ROOT_ID}`));
                        shield.style.pointerEvents = 'auto';
                        if (stack.length) {
                            el = stack.reduce((a, b) => {
                                const ra = a.getBoundingClientRect();
                                const rb = b.getBoundingClientRect();
                                const areaA = ra.width * ra.height || Infinity;
                                const areaB = rb.width * rb.height || Infinity;
                                return areaA <= areaB ? a : b;
                            });
                        }
                    }
                    this.cleanupShieldHl();
                    this.selectNode(el, true);
                    this.stopPicking();
                } else {
                    // 모바일은 move와 동일하게 처리
                    this._shieldMove(e);
                }
            };

            this._shieldKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.stopPicking();
                }
            };

            shield.addEventListener('pointermove', this._shieldMove, { passive: false });
            shield.addEventListener('pointerdown', this._shieldDown, { passive: false });
            document.addEventListener('keydown', this._shieldKey, true);

            if (IS_TOUCH) {
                this.flashToast('손가락을 화면에서 움직여 요소를 가리키세요');
            } else {
                this.flashToast('요소 클릭 (Alt+클릭: 가장 작은 요소, ESC: 취소)');
            }
            vibrate(10);
        }

        cleanupShieldHl() {
            if (this.state.lastHoverEl) {
                this.state.lastHoverEl.classList.remove('picky-hl-preview');
                this.state.lastHoverEl = null;
            }
        }

        stopPicking() {
            if (!this.state.picking) return;
            this.state.picking = false;
            this.state.mode = 'selected';
            this.state.pickCandidate = null;

            const shield = this.dom.shield;
            if (shield) {
                shield.removeEventListener('pointermove', this._shieldMove);
                shield.removeEventListener('pointerdown', this._shieldDown);
                shield.remove();
                this.dom.shield = null;
                this.dom.shieldAim = null;
                this.dom.shieldConfirm = null;
            }
            document.removeEventListener('keydown', this._shieldKey, true);

            this.cleanupShieldHl();

            // 패널 복원
            if (this._wasFullBeforePick) {
                this._wasFullBeforePick = false;
                this.state.scale = 'full';
                this.render();
                this.applyPosition();
            }
        }

        refineTargetAtPoint(el, x, y) {
            if (!el) return el;
            if (el.tagName === 'BODY' || el.tagName === 'HTML') {
                const stack = document.elementsFromPoint(x, y)
                    .filter(n => n && !n.closest(`#${ROOT_ID}`) && n !== el &&
                                 n.tagName !== 'BODY' && n.tagName !== 'HTML');
                if (stack.length) return stack[0];
                return el;
            }
            if (el.tagName === 'A') {
                const imgs = el.querySelectorAll(':scope > img, :scope img');
                if (imgs.length === 1) {
                    const ir = imgs[0].getBoundingClientRect();
                    if (x >= ir.left && x <= ir.right && y >= ir.top && y <= ir.bottom) {
                        return imgs[0];
                    }
                }
            }
            return el;
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
                if (this.state.picking) this.stopPicking();
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
                    if (this.state.picking) this.stopPicking();
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
                    if (c) this.selectNode(c, true);
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
                            vibrate(20);
                            this.flashToast('차단 규칙 추가');
                            this.refreshMetrics();
                        }
                    }
                    break;
                }
                case 'toggleHideSelected': {
                    const c = this.state.candidates[this.state.selectedIdx];
                    const sel = (c && !c.isNetwork) ? c.selector : this.state.queryData.selector;
                    if (!sel) { this.flashToast('선택된 규칙이 없습니다'); break; }
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
                case 'showAllRules': this.showAllRules(); break;
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
                <textarea class="picky-modal-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(cur)}</textarea>
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
                    vibrate(20);
                    this.flashToast('차단 규칙 추가');
                    this.refreshMetrics();
                }
                this.modal.dismiss();
            });
        }

        showRules() {
            const rules = Blocker.fetch();
            const body = this.modal.display(`현재 사이트 규칙 (${rules.length})`, '', true);
            body.innerHTML = `
                <div class="picky-rules-list">
                    ${rules.length ? rules.map((r, i) => `
                        <div class="picky-rule-item">
                            <code>${esc(r)}</code>
                            <button class="picky-btn picky-btn-icon" data-ridx="${i}" title="삭제">${ICON_CLOSE}</button>
                        </div>`).join('') : '<div class="picky-cards-empty">등록된 규칙이 없습니다</div>'}
                </div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="openAll">🌐 전체 규칙 보기</button>
                    <button class="picky-btn" data-ref="exportFilter">📋 AdGuard 필터 복사</button>
                    <button class="picky-btn" data-ref="exportJson">📥 JSON 내보내기</button>
                    <button class="picky-btn picky-btn-danger" data-ref="clear">현재 사이트 전체 삭제</button>
                </div>`;
            body.querySelectorAll('[data-ridx]').forEach(b => {
                b.addEventListener('click', () => {
                    Blocker.drop(rules[parseInt(b.dataset.ridx)]);
                    this.showRules();
                    this.refreshMetrics();
                });
            });
            body.querySelector('[data-ref="openAll"]').addEventListener('click', () => this.showAllRules());
            body.querySelector('[data-ref="exportFilter"]').addEventListener('click', async () => {
                await Blocker.copyFilterText();
                this.flashToast('AdGuard/uBlock 필터 복사됨');
            });
            body.querySelector('[data-ref="exportJson"]').addEventListener('click', () => Blocker.exportJSON());
            body.querySelector('[data-ref="clear"]').addEventListener('click', () => {
                if (confirm('이 사이트의 모든 규칙을 삭제할까요?')) {
                    Blocker.clear();
                    this.modal.dismiss();
                    this.refreshMetrics();
                }
            });
        }

        showAllRules() {
            const body = this.modal.display('🌐 전체 규칙 뷰어', '', true, 'picky-modal-wide');
            this._renderAllRulesContent(body);
        }

        _renderAllRulesContent(body) {
            const all = Blocker.fetchAll();
            const currentHost = Blocker.host();
            const hosts = Object.keys(all).sort((a, b) => {
                if (a === currentHost) return -1;
                if (b === currentHost) return 1;
                return a.localeCompare(b);
            });

            let totalRules = 0;
            for (const h of hosts) totalRules += (all[h] || []).length;

            const search = (this.state.allRulesSearch || '').toLowerCase().trim();
            const filteredHosts = hosts.filter(host => {
                if (!search) return true;
                if (host.toLowerCase().includes(search)) return true;
                return (all[host] || []).some(r => r.toLowerCase().includes(search));
            });

            const noRules = totalRules === 0;
            const noMatch = !noRules && filteredHosts.length === 0;

            body.innerHTML = `
                <div class="picky-allrules-toolbar">
                    <input type="text" class="picky-allrules-search" placeholder="🔍 사이트/규칙 검색..." value="${esc(this.state.allRulesSearch || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">
                    <span class="picky-allrules-summary">${hosts.length}개 사이트 · ${totalRules}개 규칙</span>
                </div>
                <div class="picky-allrules-list">
                    ${noRules
                        ? '<div class="picky-cards-empty">등록된 규칙이 없습니다</div>'
                        : noMatch
                            ? '<div class="picky-cards-empty">검색 결과가 없습니다</div>'
                            : filteredHosts.map(host => this._renderHostGroup(host, all[host] || [], currentHost, search)).join('')
                    }
                </div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="expandAll">▼ 모두 펼치기</button>
                    <button class="picky-btn" data-ref="collapseAll">▲ 모두 접기</button>
                    <button class="picky-btn" data-ref="exportFilter">📋 AdGuard 필터 복사</button>
                    <button class="picky-btn" data-ref="exportJson">📥 JSON 내보내기</button>
                    <button class="picky-btn picky-btn-danger" data-ref="clearAll">⚠ 전체 삭제</button>
                </div>
            `;

            const searchInput = body.querySelector('.picky-allrules-search');
            searchInput.addEventListener('input', (e) => {
                this.state.allRulesSearch = e.target.value;
                this._renderAllRulesContent(body);
                const newInput = body.querySelector('.picky-allrules-search');
                if (newInput) {
                    newInput.focus();
                    const len = newInput.value.length;
                    newInput.setSelectionRange(len, len);
                }
            });

            body.querySelectorAll('[data-host-toggle]').forEach(h => {
                h.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    const host = h.dataset.hostToggle;
                    if (this.state.allRulesCollapsed.has(host)) {
                        this.state.allRulesCollapsed.delete(host);
                    } else {
                        this.state.allRulesCollapsed.add(host);
                    }
                    this._renderAllRulesContent(body);
                });
            });

            body.querySelectorAll('[data-host-clear]').forEach(b => {
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const host = b.dataset.hostClear;
                    const count = (all[host] || []).length;
                    if (confirm(`"${host}" 의 ${count}개 규칙을 모두 삭제할까요?`)) {
                        Blocker.clearHost(host);
                        this.flashToast(`${host} 규칙 ${count}개 삭제됨`);
                        this._renderAllRulesContent(body);
                        this.refreshMetrics();
                    }
                });
            });

            body.querySelectorAll('[data-host-copy]').forEach(b => {
                b.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const host = b.dataset.hostCopy;
                    const rules = all[host] || [];
                    const text = rules.map(r => host === 'global' ? `##${r}` : `${host}##${r}`).join('\n');
                    await this.copyText(text);
                    this.flashToast(`${host} 규칙 ${rules.length}개 복사됨`);
                });
            });

            body.querySelectorAll('[data-rule-del]').forEach(b => {
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const host = b.dataset.host;
                    const sel = b.dataset.ruleDel;
                    Blocker.dropFromHost(host, sel);
                    this.flashToast('규칙 삭제됨');
                    this._renderAllRulesContent(body);
                    this.refreshMetrics();
                });
            });

            body.querySelectorAll('[data-rule-copy]').forEach(b => {
                b.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const host = b.dataset.host;
                    const sel = b.dataset.ruleCopy;
                    const text = host === 'global' ? `##${sel}` : `${host}##${sel}`;
                    await this.copyText(text);
                    this.flashToast('규칙 복사됨');
                });
            });

            body.querySelector('[data-ref="expandAll"]').addEventListener('click', () => {
                this.state.allRulesCollapsed.clear();
                this._renderAllRulesContent(body);
            });
            body.querySelector('[data-ref="collapseAll"]').addEventListener('click', () => {
                this.state.allRulesCollapsed = new Set(hosts);
                this._renderAllRulesContent(body);
            });
            body.querySelector('[data-ref="exportFilter"]').addEventListener('click', async () => {
                await Blocker.copyFilterText();
                this.flashToast('AdGuard/uBlock 필터 복사됨');
            });
            body.querySelector('[data-ref="exportJson"]').addEventListener('click', () => {
                Blocker.exportJSON();
                this.flashToast('JSON 파일 다운로드');
            });
            body.querySelector('[data-ref="clearAll"]').addEventListener('click', () => {
                if (confirm(`정말 모든 사이트의 ${totalRules}개 규칙을 삭제할까요?`)) {
                    Blocker.clearAll();
                    this.flashToast('모든 규칙 삭제됨');
                    this._renderAllRulesContent(body);
                    this.refreshMetrics();
                }
            });
        }

        _renderHostGroup(host, rules, currentHost, search) {
            const isCurrent = host === currentHost;
            const isCollapsed = this.state.allRulesCollapsed.has(host);

            const visibleRules = search
                ? rules.filter(r => r.toLowerCase().includes(search) || host.toLowerCase().includes(search))
                : rules;

            const highlight = (text) => {
                if (!search) return esc(text);
                const lower = text.toLowerCase();
                const idx = lower.indexOf(search);
                if (idx < 0) return esc(text);
                return esc(text.slice(0, idx)) +
                    `<mark class="picky-search-hl">${esc(text.slice(idx, idx + search.length))}</mark>` +
                    esc(text.slice(idx + search.length));
            };

            return `
                <div class="picky-host-group ${isCurrent ? 'is-current' : ''} ${isCollapsed ? 'is-collapsed' : ''}">
                    <div class="picky-host-header" data-host-toggle="${esc(host)}">
                        <span class="picky-host-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
                        <span class="picky-host-name">${highlight(host)}</span>
                        ${isCurrent ? '<span class="picky-host-current-badge">현재</span>' : ''}
                        <span class="picky-host-count">${rules.length}개${search && visibleRules.length !== rules.length ? ` (${visibleRules.length}개 일치)` : ''}</span>
                        <div class="picky-host-actions">
                            <button class="picky-btn picky-btn-icon" data-host-copy="${esc(host)}" title="이 사이트 규칙 모두 복사">${ICON_COPY}</button>
                            <button class="picky-btn picky-btn-icon picky-btn-danger-icon" data-host-clear="${esc(host)}" title="이 사이트 규칙 전체 삭제">${ICON_CLOSE}</button>
                        </div>
                    </div>
                    ${isCollapsed ? '' : `
                        <div class="picky-host-rules">
                            ${visibleRules.length === 0
                                ? '<div class="picky-host-empty">일치하는 규칙 없음</div>'
                                : visibleRules.map(r => `
                                    <div class="picky-rule-item">
                                        <code title="${esc(r)}">${highlight(r)}</code>
                                        <button class="picky-btn picky-btn-icon" data-rule-copy="${esc(r)}" data-host="${esc(host)}" title="규칙 복사">${ICON_COPY}</button>
                                        <button class="picky-btn picky-btn-icon" data-rule-del="${esc(r)}" data-host="${esc(host)}" title="삭제">${ICON_CLOSE}</button>
                                    </div>
                                `).join('')
                            }
                        </div>
                    `}
                </div>
            `;
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
                        <span>환경</span>
                        <span>${IS_TOUCH ? '📱 터치' : '🖱️ 마우스'} · ${window.innerWidth}×${window.innerHeight}</span>
                    </div>
                    <div class="picky-settings-row">
                        <button class="picky-btn" data-ref="openAll">🌐 전체 규칙 뷰어 열기</button>
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
                            • <b>v3.7.0 모바일 완전 대응</b>: 터치 픽킹(조준점+확정버튼), 동적 viewport, 44px 터치 타겟, 좌표 자동 보정, 회전 대응, 진동 피드백<br>
                            • <b>Shield 픽킹 (터치)</b>: 손가락 위치보다 위쪽을 가리키는 조준점, "이 요소 선택" 버튼으로 확정<br>
                            • <b>Shield 픽킹 (마우스)</b>: 클릭 즉시 선택, Alt+클릭으로 가장 작은 요소 강제 선택<br>
                            • <b>전체 규칙 뷰어</b>: 모든 사이트의 규칙을 그룹화해서 보기 · 검색 · 접기/펼치기<br>
                            • <b>호버 미리보기</b>(노란 점선) / <b>핀 미리보기</b>(초록 외곽선) / <b>숨김 미리보기</b>(👁)<br>
                            • <b>유일 타겟팅 경로</b>(🎯): 매치=1 보장 절대 경로<br>
                            • <b>부모 컨테이너 :has()</b>: 차단 시 빈 공간까지 제거<br>
                            • 정확 매칭 셀렉터(<code>[src="..."]</code>)는 길이와 무관하게 ★★★ 보장
                        </small>
                    </div>
                </div>`;
            body.querySelector('[data-ref="openAll"]').addEventListener('click', () => this.showAllRules());
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
                });
                if (!IS_TOUCH) {
                    item.addEventListener('mouseenter', () => el.classList.add('picky-hl-preview'));
                    item.addEventListener('mouseleave', () => el.classList.remove('picky-hl-preview'));
                }
            });
        }

        // ★★★ v3.7.0: 개선된 드래그 핸들러 (모바일 클릭 충돌 해결)
        attachDragHandlers() {
            const tool = this.dom.tool;
            if (!tool) return;
            let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false, active = false, pointerId = null;

            const onDown = (e) => {
                if (e.target.closest(NO_DRAG_SELECTOR)) return;
                if (this.state.scale !== 'icon' && !e.target.closest('[data-drag="1"]')) return;
                active = true;
                moved = false;
                pointerId = e.pointerId;
                const r = tool.getBoundingClientRect();
                startX = e.clientX; startY = e.clientY;
                startLeft = r.left; startTop = r.top;
                tool.style.transform = '';
                tool.style.left = startLeft + 'px';
                tool.style.top = startTop + 'px';
                tool.style.right = 'auto';
                tool.style.bottom = 'auto';
                // ★ 핵심: pointerdown에서는 preventDefault 하지 않음 → 클릭 이벤트 유지
            };
            const onMove = (e) => {
                if (!active) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                    moved = true;
                    // 드래그 임계값 초과 시점부터 캡처
                    try { tool.setPointerCapture?.(pointerId); } catch (_) {}
                }
                if (moved) {
                    if (e.cancelable) e.preventDefault();
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
                    if (e.cancelable) e.preventDefault();
                }
                try { tool.releasePointerCapture?.(pointerId); } catch (_) {}
                pointerId = null;
            };
            // 드래그 중 click 이벤트 차단 (드래그가 클릭으로 잘못 인식되지 않도록)
            tool.addEventListener('click', (e) => {
                if (moved) {
                    e.stopPropagation();
                    e.preventDefault();
                    moved = false;
                }
            }, true);

            tool.addEventListener('pointerdown', onDown, { passive: true });
            tool.addEventListener('pointermove', onMove, { passive: false });
            tool.addEventListener('pointerup', onUp, { passive: false });
            tool.addEventListener('pointercancel', onUp, { passive: false });
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
            if (this._onResize) {
                window.removeEventListener('resize', this._onResize);
                window.removeEventListener('orientationchange', this._onResize);
                this._onResize = null;
            }
            if (this.dom.host) this.dom.host.remove();
            this.dom = {};
        }
    }

    // ★★★ v3.7.0: 모바일 최적화된 PICKY_CSS
    const PICKY_CSS = `
    :host, * { box-sizing: border-box; }
    .picky-tool {
        position: fixed;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #e8eaed;
        z-index: 2147483647;
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
    }
    .picky-icon { width: 48px; height: 48px; touch-action: none; }
    .picky-icon-btn {
        width: 100%; height: 100%;
        min-width: 44px; min-height: 44px;
        border: none; border-radius: 50%;
        background: linear-gradient(135deg, #3b82f6, #1e40af);
        color: #fff; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        display: flex; align-items: center; justify-content: center;
        touch-action: none;
    }
    .picky-icon-btn:hover { transform: scale(1.06); }

    .picky-panel {
        width: 380px;
        max-width: calc(100vw - 16px);
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
        -webkit-user-select: none;
        touch-action: none;
    }
    .picky-head:active { cursor: grabbing; }
    .picky-title { font-weight: 600; font-size: 14px; }
    .picky-title small { opacity: 0.5; font-weight: 400; margin-left: 4px; }
    .picky-head-btns { display: flex; gap: 4px; }

    .picky-body { padding: 10px 12px 12px; touch-action: auto; }
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
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
    }
    .picky-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-btn:active { background: rgba(255,255,255,0.22); }
    .picky-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .picky-btn-icon { padding: 6px; min-width: 32px; min-height: 32px; justify-content: center; }
    .picky-btn-active {
        background: linear-gradient(135deg, #8b5cf6, #6d28d9);
        border-color: transparent; color: #fff;
    }
    .picky-btn-primary {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        border-color: transparent; justify-content: center;
    }
    .picky-btn-danger {
        background: linear-gradient(135deg, #ef4444, #b91c1c);
        border-color: transparent;
    }
    .picky-btn-danger-icon { color: #fca5a5; }
    .picky-btn-danger-icon:hover { background: rgba(239, 68, 68, 0.2); color: #fff; }

    .picky-disp-wrap {
        background: rgba(0,0,0,0.3);
        border-radius: 6px;
        padding: 8px 10px; margin-bottom: 8px;
    }
    .picky-disp {
        font-family: ui-monospace, "SF Mono", Monaco, monospace;
        font-size: 11px;
        word-break: break-all;
        color: #9ecbff;
        line-height: 1.4;
        max-height: 40px; overflow-y: auto;
        touch-action: pan-y;
        overscroll-behavior: contain;
        user-select: text;
        -webkit-user-select: text;
    }
    .picky-meta {
        display: flex; justify-content: space-between;
        font-size: 10px; opacity: 0.65; margin-top: 4px;
    }

    .picky-nav-row { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
    .picky-slider {
        flex: 1;
        -webkit-appearance: none; appearance: none;
        height: 6px; background: rgba(255,255,255,0.15);
        border-radius: 3px; outline: none;
        touch-action: pan-x;
    }
    .picky-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 22px; height: 22px;
        background: #3b82f6; border-radius: 50%; cursor: pointer;
    }
    .picky-slider::-moz-range-thumb {
        width: 22px; height: 22px;
        background: #3b82f6; border-radius: 50%; cursor: pointer; border: none;
    }

    .picky-cards-scroll {
        max-height: 320px;
        overflow-y: auto; overflow-x: hidden;
        scroll-snap-type: y proximity;
        margin-bottom: 10px;
        border-radius: 8px;
        background: rgba(0,0,0,0.2);
        padding: 6px;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
    }
    .picky-cards-scroll::-webkit-scrollbar { width: 6px; }
    .picky-cards-scroll::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.2); border-radius: 3px;
    }
    .picky-cards-info { font-size: 10px; opacity: 0.55; padding: 4px 6px 8px; text-align: center; }
    .picky-cards-empty { text-align: center; opacity: 0.4; padding: 24px 12px; font-size: 12px; }
    .picky-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 6px;
        scroll-snap-align: start;
        cursor: pointer;
        transition: all 0.15s;
        touch-action: manipulation;
    }
    .picky-card:hover { background: rgba(255,255,255,0.08); border-color: rgba(59, 130, 246, 0.4); }
    .picky-card.is-selected {
        background: rgba(16, 185, 129, 0.18);
        border-color: rgba(16, 185, 129, 0.7);
        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.4);
    }
    .picky-card.is-network { background: rgba(168, 85, 247, 0.08); border-color: rgba(168, 85, 247, 0.3); }
    .picky-card.is-selected.is-network {
        background: rgba(16, 185, 129, 0.18); border-color: rgba(16, 185, 129, 0.7);
    }
    .picky-card.is-hiding {
        background: rgba(139, 92, 246, 0.18);
        border-color: rgba(139, 92, 246, 0.7);
        box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.5);
    }
    .picky-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .picky-card-icon { font-size: 14px; }
    .picky-card-label { font-weight: 600; font-size: 12px; flex: 1; }
    .picky-card-stars { font-size: 10px; color: #fbbf24; letter-spacing: 1px; }
    .picky-badge {
        background: linear-gradient(135deg, #f59e0b, #d97706);
        color: #fff; font-size: 9px; padding: 1px 6px;
        border-radius: 8px; font-weight: 700;
    }
    .picky-card-filter-clickable {
        font-family: ui-monospace, "SF Mono", Monaco, monospace;
        font-size: 11px;
        color: #c4b5fd;
        background: rgba(0,0,0,0.35);
        padding: 5px 7px;
        border-radius: 4px;
        word-break: break-all;
        margin-bottom: 4px;
        line-height: 1.4;
        cursor: copy;
        touch-action: manipulation;
        user-select: text;
        -webkit-user-select: text;
    }
    .picky-card-filter-clickable:hover { background: rgba(139, 92, 246, 0.25); }
    .picky-card-css {
        font-size: 10.5px;
        font-family: ui-monospace, monospace;
        opacity: 0.75;
        margin-bottom: 4px;
        word-break: break-all;
        cursor: copy;
        padding: 3px 5px;
        border-radius: 4px;
        touch-action: manipulation;
        user-select: text;
        -webkit-user-select: text;
    }
    .picky-card-css:hover { background: rgba(59, 130, 246, 0.2); }
    .picky-card-css-label { color: #6ee7b7; margin-right: 4px; }
    .picky-card-css-text { color: #9ecbff; }
    .picky-card-matches { opacity: 0.55; margin-left: 4px; }
    .picky-card-hint { font-size: 10px; opacity: 0.55; margin-bottom: 6px; }
    .picky-card-btns { display: flex; gap: 4px; flex-wrap: wrap; }
    .picky-card-btn {
        flex: 1;
        padding: 6px 6px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.1);
        color: #e8eaed; border-radius: 4px;
        cursor: pointer; font-size: 10.5px;
        min-width: 0; min-height: 32px;
        display: inline-flex; align-items: center; justify-content: center; gap: 3px;
        touch-action: manipulation;
    }
    .picky-card-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-card-btn-block { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.3); }
    .picky-card-btn-block:hover { background: rgba(239, 68, 68, 0.35); }
    .picky-card-btn-hiding {
        background: rgba(139, 92, 246, 0.35);
        border-color: rgba(139, 92, 246, 0.6);
        color: #fff;
    }
    .picky-card-btn-disabled { opacity: 0.35; cursor: not-allowed; }

    .picky-action-row { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .picky-action-row .picky-btn { justify-content: center; min-height: 36px; }
    .picky-action-row .picky-btn-danger { flex: 1; min-width: 70px; }

    .picky-toggle-row {
        display: flex; gap: 12px; font-size: 11px;
        padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);
    }
    .picky-toggle {
        display: inline-flex; align-items: center; gap: 5px;
        cursor: pointer;
        touch-action: manipulation;
        min-height: 32px;
    }
    .picky-toggle input { cursor: pointer; width: 18px; height: 18px; }

    /* ★ v3.7.0: 모달 — 동적 viewport 지원 */
    .picky-modal {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
        opacity: 0; transition: opacity 0.2s;
        color: #e8eaed;
        touch-action: auto;
    }
    .picky-modal.visible { opacity: 1; }
    .picky-modal-card {
        background: #1c1e26;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        max-width: 520px; width: 90%;
        max-height: 80vh;
        max-height: 80dvh;
        overflow: hidden;
        display: flex; flex-direction: column;
        color: #e8eaed;
    }
    .picky-modal-wide .picky-modal-card {
        max-width: 720px;
        width: 95%;
        max-height: 85vh;
        max-height: 85dvh;
    }
    .picky-modal-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .picky-modal-title { font-weight: 600; }
    .picky-modal-x {
        background: transparent; border: none; color: #e8eaed;
        cursor: pointer; padding: 8px;
        min-width: 36px; min-height: 36px;
        display: flex; align-items: center; justify-content: center;
        touch-action: manipulation;
    }
    .picky-modal-body {
        padding: 14px; overflow-y: auto; font-size: 13px;
        color: #e8eaed;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        flex: 1;
    }
    .picky-modal-body code {
        color: #9ecbff;
        background: rgba(0,0,0,0.3);
        padding: 1px 4px;
        border-radius: 3px;
        user-select: text;
        -webkit-user-select: text;
    }
    .picky-modal-body small { color: #c0c4cc; }
    .picky-modal-body b, .picky-modal-body strong { color: #fbbf24; }
    .picky-modal-input {
        width: 100%;
        background: rgba(0,0,0,0.3);
        border: 1px solid rgba(255,255,255,0.1);
        color: #9ecbff;
        font-family: ui-monospace, monospace;
        font-size: 14px;
        padding: 10px; border-radius: 6px;
        margin: 8px 0; resize: vertical;
        -webkit-text-fill-color: #9ecbff;
        touch-action: auto;
        user-select: text;
        -webkit-user-select: text;
    }
    .picky-modal-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    .picky-modal-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .picky-modal-foot .picky-btn { min-height: 36px; }

    .picky-rules-list {
        max-height: 320px; overflow-y: auto;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
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
        user-select: text;
        -webkit-user-select: text;
    }

    /* 전체 규칙 뷰어 */
    .picky-allrules-toolbar {
        display: flex; gap: 8px; align-items: center;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .picky-allrules-search {
        flex: 1;
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.15);
        color: #e8eaed;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 14px;
        outline: none;
        -webkit-text-fill-color: #e8eaed;
        min-height: 36px;
    }
    .picky-allrules-search:focus {
        border-color: rgba(59, 130, 246, 0.6);
        background: rgba(0,0,0,0.5);
    }
    .picky-allrules-summary { font-size: 11px; opacity: 0.65; white-space: nowrap; }
    .picky-allrules-list {
        max-height: 56vh;
        max-height: 56dvh;
        overflow-y: auto;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        padding-right: 4px;
    }
    .picky-host-group {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        margin-bottom: 8px;
        overflow: hidden;
    }
    .picky-host-group.is-current {
        border-color: rgba(16, 185, 129, 0.5);
        background: rgba(16, 185, 129, 0.06);
    }
    .picky-host-header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px;
        background: rgba(0,0,0,0.2);
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        min-height: 44px;
    }
    .picky-host-header:hover { background: rgba(0,0,0,0.35); }
    .picky-host-group.is-current .picky-host-header { background: rgba(16, 185, 129, 0.12); }
    .picky-host-toggle-icon { font-size: 10px; opacity: 0.6; width: 12px; }
    .picky-host-name { font-weight: 600; font-size: 13px; word-break: break-all; flex: 1; }
    .picky-host-current-badge {
        background: linear-gradient(135deg, #10b981, #059669);
        color: #fff; font-size: 9px; padding: 2px 7px;
        border-radius: 8px; font-weight: 700; white-space: nowrap;
    }
    .picky-host-count { font-size: 11px; opacity: 0.6; white-space: nowrap; }
    .picky-host-actions { display: flex; gap: 4px; margin-left: 4px; }
    .picky-host-rules { padding: 8px 10px; background: rgba(0,0,0,0.15); }
    .picky-host-rules .picky-rule-item { background: rgba(255,255,255,0.04); margin-bottom: 4px; }
    .picky-host-rules .picky-rule-item:last-child { margin-bottom: 0; }
    .picky-host-rules .picky-rule-item code { font-size: 10.5px; line-height: 1.4; }
    .picky-host-empty { text-align: center; padding: 12px; opacity: 0.4; font-size: 11px; }
    .picky-search-hl {
        background: rgba(251, 191, 36, 0.4);
        color: #fde68a;
        border-radius: 2px;
        padding: 0 1px;
    }

    .picky-ad-list {
        max-height: 340px; overflow-y: auto;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
    }
    .picky-ad-item {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px;
        background: rgba(255,255,255,0.04);
        border-radius: 5px; margin-bottom: 4px;
        touch-action: manipulation;
        min-height: 44px;
    }
    .picky-ad-item:hover { background: rgba(59,130,246,0.15); }
    .picky-ad-item code { font-size: 11px; color: #9ecbff; user-select: text; -webkit-user-select: text; }

    .picky-settings-row {
        display: flex; gap: 8px; align-items: center;
        padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-wrap: wrap;
    }
    .picky-settings-row:last-child { border-bottom: none; }
    .picky-settings-row .picky-btn { min-height: 36px; }

    .picky-toast {
        position: fixed;
        bottom: 80px; left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: rgba(17, 24, 39, 0.95);
        color: #fff; padding: 10px 18px;
        border-radius: 20px;
        font-size: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        opacity: 0;
        transition: all 0.25s;
        z-index: 2147483647;
        pointer-events: none;
        max-width: 90vw;
    }
    .picky-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

    .picky-orphan-toast {
        position: fixed;
        bottom: 120px; left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: rgba(28, 30, 38, 0.98);
        border: 1px solid rgba(139, 92, 246, 0.6);
        color: #fff;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        opacity: 0;
        transition: all 0.25s;
        z-index: 2147483647;
        max-width: calc(100vw - 32px);
        width: 360px;
    }
    .picky-orphan-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .picky-orphan-msg { margin-bottom: 6px; line-height: 1.4; }
    .picky-orphan-sel {
        font-family: ui-monospace, monospace;
        font-size: 10.5px;
        color: #9ecbff;
        background: rgba(0,0,0,0.3);
        padding: 4px 6px;
        border-radius: 4px;
        margin-bottom: 8px;
        word-break: break-all;
    }
    .picky-orphan-btns { display: flex; gap: 6px; }
    .picky-orphan-btns .picky-btn { flex: 1; justify-content: center; min-height: 36px; }

    /* ★★★ v3.7.0: Shield 픽킹 모바일 UI */
    #${SHIELD_ID} {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483645 !important;
        cursor: crosshair !important;
        background: rgba(0, 0, 0, 0.02) !important;
        pointer-events: auto !important;
        touch-action: none !important;
        -webkit-tap-highlight-color: transparent;
    }
    .picky-aim {
        position: absolute;
        width: 0; height: 0;
        pointer-events: none;
        z-index: 2147483646;
    }
    .picky-aim-cross {
        position: absolute;
        left: -16px; top: -16px;
        width: 32px; height: 32px;
        border: 2px solid #ef4444;
        border-radius: 50%;
        box-shadow: 0 0 0 2px rgba(255,255,255,0.6), inset 0 0 0 1px rgba(255,255,255,0.4);
    }
    .picky-aim-cross::before,
    .picky-aim-cross::after {
        content: '';
        position: absolute;
        background: #ef4444;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.6);
    }
    .picky-aim-cross::before {
        left: 50%; top: -8px;
        width: 2px; height: 8px;
        transform: translateX(-50%);
    }
    .picky-aim-cross::after {
        left: -8px; top: 50%;
        width: 8px; height: 2px;
        transform: translateY(-50%);
    }
    .picky-shield-confirm {
        position: fixed;
        bottom: 16px; left: 50%;
        transform: translateX(-50%);
        background: rgba(17, 24, 39, 0.98);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 12px;
        padding: 12px 14px;
        z-index: 2147483647;
        pointer-events: auto;
        max-width: calc(100vw - 24px);
        width: 360px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        touch-action: manipulation;
    }
    .picky-shield-msg {
        font-size: 12px;
        color: #e8eaed;
        margin-bottom: 8px;
        word-break: break-all;
        line-height: 1.4;
        text-align: center;
    }
    .picky-shield-msg code {
        background: rgba(0,0,0,0.4);
        color: #9ecbff;
        padding: 3px 6px;
        border-radius: 4px;
        font-size: 11px;
    }
    .picky-shield-btns {
        display: flex; gap: 8px;
    }
    .picky-shield-btns .picky-btn {
        flex: 1;
        justify-content: center;
        min-height: 44px;
        font-size: 13px;
        padding: 8px 12px;
    }

    /* ★★★ v3.7.0: 모바일 전용 미디어 쿼리 */
    @media (max-width: 600px) {
        .picky-panel {
            width: calc(100vw - 16px);
            max-width: calc(100vw - 16px);
        }
        .picky-cards-scroll { max-height: 38vh; max-height: 38dvh; }
        .picky-disp { max-height: 60px; }
        .picky-card-css, .picky-card-filter-clickable {
            font-size: 12px; padding: 6px 8px;
        }
        .picky-card-btn { padding: 8px 6px; font-size: 11.5px; min-height: 36px; }
        .picky-action-row .picky-btn { padding: 8px 10px; min-height: 40px; font-size: 13px; }
        .picky-btn-icon { min-width: 40px; min-height: 40px; padding: 8px; }
        .picky-modal-card {
            max-width: calc(100vw - 16px);
            max-height: 90vh;
            max-height: 90dvh;
        }
        .picky-modal-wide .picky-modal-card {
            max-width: 100vw;
            width: 100%;
            height: 100vh;
            height: 100dvh;
            max-height: 100vh;
            max-height: 100dvh;
            border-radius: 0;
        }
        .picky-modal-wide .picky-modal-body { padding: 10px; }
        .picky-allrules-toolbar { flex-direction: column; gap: 6px; align-items: stretch; }
        .picky-allrules-summary { font-size: 10.5px; text-align: right; }
        .picky-host-header { padding: 12px; gap: 8px; min-height: 48px; }
        .picky-host-name { font-size: 13.5px; }
        .picky-modal-wide .picky-modal-foot {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .picky-modal-wide .picky-modal-foot .picky-btn-danger { grid-column: 1 / -1; }
    }
    @media (max-width: 380px) {
        .picky-card-btns { gap: 3px; }
        .picky-card-btn { font-size: 10.5px; padding: 6px 4px; }
        .picky-toggle-row { flex-direction: column; gap: 6px; }
    }
    `;

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
        GM_registerMenuCommand?.('전체 규칙 뷰어 열기', () => {
            if (!inspector) boot();
            if (inspector) {
                if (inspector.state.scale === 'icon') inspector.cycleSize();
                inspector.showAllRules();
            }
        });
        GM_registerMenuCommand?.('규칙 JSON 내보내기', () => Blocker.exportJSON());
        GM_registerMenuCommand?.('AdGuard 필터 복사', async () => { await Blocker.copyFilterText(); });
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
