// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/moamoa7/Block
// @version      1.0.2
// @description  uBlock을 못 쓰는 모바일 브라우저용 가벼운 요소 숨김기 — 손가락으로 짚고 탭 한 번에 차단, self-healing
// @author       Claude
// @license       MIT
// @homepage     https://github.com/moamoa7/Block
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;

    const TOOL_ID    = 'picky-tool-root';
    const ROOT_ID    = 'picky-shadow-host';
    const HL_CLASS   = 'picky-hl';
    const SHIELD_ID  = 'picky-shield';
    const HIDE_CLASS = 'picky-hidden-preview';
    const DRAG_THRESHOLD = 6;

    const IS_TOUCH = (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
    const IS_MOBILE = IS_TOUCH && Math.min(window.innerWidth, window.innerHeight) < 768;
    const SHIELD_AIM_OFFSET_Y = IS_TOUCH ? -40 : 0;

    const NO_DRAG_SELECTOR = [
        'input', 'textarea', 'select', 'button', 'a',
        '[contenteditable="true"]',
        '.picky-rec', '.picky-rec *',
        '.picky-modal', '.picky-modal *', '.picky-btn'
    ].join(',');

    const SUPPORTS_HAS = (() => {
        try { document.querySelector(':has(*)'); return true; }
        catch (_) { return false; }
    })();

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const vibrate = (ms = 15) => {
        try { navigator.vibrate?.(ms); } catch (_) {}
    };

    // 너무 광범위한/위험한 셀렉터 차단 방지 가드
    const UNSAFE_SELECTOR_RE = /^(?:\*|html|body|:root|head|\*\s*[>~+]?\s*\*)$/i;
    function isUnsafeSelector(sel) {
        if (!sel || typeof sel !== 'string') return true;
        const trimmed = sel.trim();
        if (!trimmed) return true;
        if (UNSAFE_SELECTOR_RE.test(trimmed)) return true;
        try {
            const n = document.querySelectorAll(trimmed).length;
            if (n > 0 && /^(div|span|p|a|li|ul|section|article|img)$/i.test(trimmed) && n > 200) {
                return true;
            }
        } catch (_) { return true; }
        return false;
    }

    const DUMMY_HREF_VALUES = new Set([
        'javascript:;', 'javascript:void(0)', 'javascript:void(0);',
        '#', '#!', 'about:blank', ''
    ]);

    const ICON_CLOSE   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    const ICON_SET     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.14 12.94a7.96 7.96 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a8.13 8.13 0 00-1.62-.94l-.36-2.54A.5.5 0 0014 2h-4a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.6 8.48a.5.5 0 00.12.64l2.03 1.58a7.96 7.96 0 000 1.88L2.72 14.16a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54A.5.5 0 0010 22h4a.5.5 0 00.5-.42l.36-2.54a8.13 8.13 0 001.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
    const ICON_MIN     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13H5v-2h14v2z"/></svg>';
    const ICON_BLOCK   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a7.95 7.95 0 01-4.9-1.69L18.31 7.1A7.95 7.95 0 0120 12c0 4.41-3.59 8-8 8z"/></svg>';
    const ICON_UP      = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
    const ICON_DOWN    = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
    const ICON_TARGET  = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="2" d="M12 4v3M12 17v3M4 12h3M17 12h3"/></svg>';
    const ICON_EYE     = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>';
    const ICON_CHECK   = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    const ICON_COPY    = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>';

    // ── 규칙 저장/적용 (현재 사이트 단위) ───────────────────────────────
    const Blocker = {
        STYLE_ID: 'picky-block-style',
        KEY_RULES: 'picky_rules_v2',
        KEY_ENABLED: 'picky_enabled',
        KEY_AGG:   'picky_aggressive',

        init() {
            const apply = () => this.enforce();
            if (document.documentElement) apply();
            let timer = null;
            new MutationObserver(() => {
                if (timer) return;
                timer = setTimeout(() => {
                    timer = null;
                    if (this._needsRefresh()) apply();
                }, 200);
            }).observe(document.documentElement, { childList: true, subtree: true });
            setInterval(() => { if (this._needsRefresh()) apply(); }, 4000);
        },

        // 차단 스타일 무결성 점검 (가벼운 self-healing)
        _needsRefresh() {
            if (!document.head) return false;
            const style = document.getElementById(this.STYLE_ID);
            const rules = this.fetch();
            const wantRules = this.isEnabled() && rules.length > 0;
            if (!style && wantRules) return true;
            if (style && !style.isConnected && wantRules) return true;
            if (style && wantRules && !style.textContent) return true;
            return false;
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
            if (!rules || !rules.length) delete all[this.host()];
            else all[this.host()] = rules;
            GM_setValue(this.KEY_RULES, JSON.stringify(all));
            this.enforce();
        },

        append(sel) {
            if (!sel || typeof sel !== 'string') return false;
            const rules = this.fetch();
            if (rules.includes(sel)) return false;
            rules.push(sel);
            this.save(rules);
            return true;
        },

        drop(sel) {
            this.save(this.fetch().filter(r => r !== sel));
        },

        clear() { this.save([]); },

        isEnabled()    { return GM_getValue(this.KEY_ENABLED, true); },
        toggleEnabled(){ GM_setValue(this.KEY_ENABLED, !this.isEnabled()); this.enforce(); },
        isAggressive() { return GM_getValue(this.KEY_AGG, false); },
        toggleAggressive() { GM_setValue(this.KEY_AGG, !this.isAggressive()); this.enforce(); },

        enforce() {
            if (!document.head) return;
            let style = document.getElementById(this.STYLE_ID);
            if (!style || !style.isConnected) {
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
                ? 'display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;width:0!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important;'
                : 'display:none!important;';
            style.textContent = safe.map(s => `${s}{${decl}}`).join('\n');
        },

        getStats() {
            const all = this.fetchAll();
            let total = 0;
            for (const k of Object.keys(all)) total += (all[k] || []).length;
            return { ruleCount: this.fetch().length, totalRules: total };
        }
    };
    Blocker.init();

    // ── 모달 (커스텀 confirm 포함) ──────────────────────────────────────
    class Modal {
        constructor(container) { this.container = container; this.node = null; this._onDismiss = null; this._vv = null; }

        display(title, body, isHtml = false) {
            this.dismiss();
            const wrap = document.createElement('div');
            wrap.className = 'picky-modal';
            wrap.innerHTML = `
                <div class="picky-modal-card">
                    <div class="picky-modal-head">
                        <span class="picky-modal-title">${esc(title)}</span>
                        <button class="picky-modal-x" aria-label="닫기">${ICON_CLOSE}</button>
                    </div>
                    <div class="picky-modal-body"></div>
                </div>`;
            const bodyEl = wrap.querySelector('.picky-modal-body');
            if (isHtml) bodyEl.innerHTML = body; else bodyEl.textContent = body;
            wrap.querySelector('.picky-modal-x').addEventListener('click', () => this.dismiss());
            wrap.addEventListener('click', (e) => { if (e.target === wrap) this.dismiss(); });
            (this.container || document.body).appendChild(wrap);
            requestAnimationFrame(() => wrap.classList.add('visible'));
            this.node = wrap;

            if (window.visualViewport) {
                const card = wrap.querySelector('.picky-modal-card');
                this._vv = () => { if (card) { const vh = window.visualViewport.height; card.style.maxHeight = Math.min(vh - 16, vh * 0.95) + 'px'; } };
                this._vv();
                window.visualViewport.addEventListener('resize', this._vv);
                window.visualViewport.addEventListener('scroll', this._vv);
            }
            return bodyEl;
        }

        confirm(title, message, { okText = '확인', cancelText = '취소', danger = false } = {}) {
            return new Promise((resolve) => {
                const body = this.display(title, '', true);
                body.innerHTML = `
                    <div style="line-height:1.5;margin-bottom:14px;white-space:pre-line;">${esc(message)}</div>
                    <div class="picky-modal-foot" style="justify-content:flex-end;">
                        <button class="picky-btn" data-ref="cancel">${esc(cancelText)}</button>
                        <button class="picky-btn ${danger ? 'picky-btn-danger' : 'picky-btn-primary'}" data-ref="ok">${esc(okText)}</button>
                    </div>`;
                let answered = false;
                const finish = (v) => { if (answered) return; answered = true; this._onDismiss = null; this.dismiss(); resolve(v); };
                body.querySelector('[data-ref="ok"]').addEventListener('click', () => finish(true));
                body.querySelector('[data-ref="cancel"]').addEventListener('click', () => finish(false));
                this._onDismiss = () => { if (!answered) { answered = true; resolve(false); } };
            });
        }

        dismiss() {
            if (!this.node) return;
            const n = this.node;
            n.classList.remove('visible');
            setTimeout(() => n.remove(), 200);
            this.node = null;
            if (this._vv && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._vv);
                window.visualViewport.removeEventListener('scroll', this._vv);
                this._vv = null;
            }
            if (typeof this._onDismiss === 'function') { try { this._onDismiss(); } catch (_) {} this._onDismiss = null; }
        }
    }

    // ── 셀렉터 엔진 (내부적으로 여러 전략 → 최고 점수 1개만 사용) ─────────
    class SelectorStrategies {
        static countMatches(sel, root = document) {
            if (!sel) return 0;
            try { return root.querySelectorAll(sel).length; } catch (_) { return 0; }
        }

        static isMeaningfulClass(cls) {
            if (!cls || typeof cls !== 'string') return false;
            if (cls.length < 2 || cls.length > 40) return false;
            if (cls.startsWith('picky-')) return false;
            if (cls === HL_CLASS) return false;
            if (/^(ember|v-|ng-|re-|css-|sc-|jsx-|emotion-|makeStyles-)/.test(cls)) return false;
            if (/^[a-zA-Z0-9_-]{8,}$/.test(cls) && /[0-9]/.test(cls) && /[A-Z]/.test(cls)) return false;
            const volatile = ['active','focus','hover','selected','disabled','checked','open','closed','expanded','collapsed','loading','transition','animating','v-enter','v-leave','is-active','is-open'];
            if (volatile.some(v => cls.toLowerCase().includes(v))) return false;
            return true;
        }

        static safeClasses(el) {
            if (!el || !el.classList) return [];
            return Array.from(el.classList).filter(c => !c.startsWith('picky-') && c !== HL_CLASS);
        }
        static meaningfulClasses(el) { return this.safeClasses(el).filter(c => this.isMeaningfulClass(c)); }

        static scoreSelector(sel, el) {
            if (!sel) return 0;
            const matches = this.countMatches(sel);
            if (matches === 0) return 0;
            try { if (el && ![...document.querySelectorAll(sel)].includes(el)) return 0; }
            catch (_) { return 0; }

            let perf = 0;
            const last = sel.split(/\s|>|\+|~/).pop().trim();
            if (/^#[\w\\-]+$/.test(last)) perf = 60;
            else if (/^[a-z]+\.[\w\\-]+$/i.test(last)) perf = 50;
            else if (/^\.[\w\\-]+$/.test(last)) perf = 48;
            else if (/\[[a-z-]+="/i.test(last)) perf = 38;
            else if (/^[a-z]+$/i.test(last)) perf = 32;
            else perf = 20;
            if (/:has\(/.test(sel)) perf -= 12;
            if (/:nth-of-type|:nth-child/.test(sel)) perf -= 6;
            if (sel.length <= 35) perf += 10; else if (sel.length >= 100) perf -= 8;
            const comb = (sel.match(/[\s>+~]/g) || []).length;
            if (comb >= 4) perf -= 10; else if (comb >= 2) perf -= 4;
            perf = Math.max(0, perf);

            let acc = 0;
            if (matches === 1) acc = 42;
            else if (matches === 2) acc = 30;
            else if (matches <= 5) acc = 22;
            else if (matches <= 10) acc = 16;
            else if (matches <= 30) acc = 10;
            else acc = 4;

            return Math.max(0, Math.min(100, Math.round(perf + acc)));
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
                return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
            }
            return tag;
        }

                // 사용자가 짚은 el "그 하나만" 정확히 가리키는 셀렉터를 만든다.
        // 점수로 후보를 고르지 않는다. 항상 짚은 요소 우선.
        // 여러 개가 잡히면 클래스 추가 → nth → 부모 경로 순으로 좁혀 단일화한다.
        static best(el) {
            if (!el || !el.tagName) return null;

            // el만 정확히 매치하는지 확인하는 헬퍼
            const onlyHits = (sel) => {
                if (!sel || /picky-/.test(sel)) return false;
                let nodes;
                try { nodes = document.querySelectorAll(sel); } catch (_) { return false; }
                return nodes.length === 1 && nodes[0] === el;
            };
            // el을 포함하면서 매치 개수를 세는 헬퍼 (el이 안 잡히면 0 취급)
            const countIfHits = (sel) => {
                if (!sel || /picky-/.test(sel)) return 0;
                let nodes;
                try { nodes = document.querySelectorAll(sel); } catch (_) { return 0; }
                if (![...nodes].includes(el)) return 0;
                return nodes.length;
            };

            const tag = el.tagName.toLowerCase();
            const id = el.id;
            const classes = this.meaningfulClasses(el);

            // ── 1) ID가 유일하면 그게 가장 깔끔하고 정확하다 ──
            if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
                const idSel = `#${CSS.escape(id)}`;
                if (onlyHits(idSel)) return idSel;
            }

            // ── 2) 의미있는 속성으로 그 하나만 잡히면 사용 ──
            for (const attr of ['data-testid','data-cy','data-test','aria-label','name']) {
                const v = el.getAttribute?.(attr);
                if (!v || v.length > 60) continue;
                const a1 = `[${attr}="${CSS.escape(v)}"]`;
                if (onlyHits(a1)) return a1;
                const a2 = `${tag}${a1}`;
                if (onlyHits(a2)) return a2;
            }

            // ── 3) 가진 클래스를 "전부" 붙인 가장 좁은 형태에서 출발 ──
            // 절대 클래스를 임의로 떨어뜨려 범위를 넓히지 않는다.
            if (classes.length) {
                const allClassSel = `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
                // 이게 그 하나만 잡으면 그대로 사용 (예: a.article.mi)
                if (onlyHits(allClassSel)) return allClassSel;

                // 여전히 여러 개면, 부모 쪽으로 경로를 더해 그 하나로 좁힌다.
                if (countIfHits(allClassSel) > 0) {
                    const narrowed = this._narrowByPath(el, allClassSel, onlyHits);
                    if (narrowed) return narrowed;
                }
            }

            // ── 4) 클래스가 없거나 위에서 못 좁힌 경우: nth 기반 단일 경로 ──
            const nthPath = this._uniqueNthPath(el, onlyHits);
            if (nthPath) return nthPath;

            // ── 5) 더미 링크(광고 클릭) 패턴 — 그래도 단일화 시도 ──
            const anchor = el.tagName === 'A' ? el : el.closest?.('a');
            if (anchor === el) {
                const href = anchor.getAttribute('href');
                if (href && DUMMY_HREF_VALUES.has(href.trim())) {
                    const hSel = `a[href="${CSS.escape(href)}"]`;
                    if (onlyHits(hSel)) return hSel;
                }
            }

            // ── 6) 최후의 보루: 클래스 전체 조합(여러 개 잡히더라도 짚은 의도 보존) ──
            // 여기까지 왔다면 단일화에 실패한 것. 넓히기보다 가진 정보를 최대한 보존한다.
            if (classes.length) {
                return `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
            }
            // 클래스도 없으면 부모 포함 경로라도 반환
            return this._simpleSelectorFor(el);
        }

        // 주어진 베이스 셀렉터(el을 포함하지만 여러 개 매치)를 부모 경로를 덧붙여 단일화
        static _narrowByPath(el, baseSel, onlyHits) {
            // baseSel은 el의 "자기 자신" 부분이라고 가정.
            let cur = el.parentElement;
            let prefix = '';
            let depth = 0;
            while (cur && cur !== document.body && cur !== document.documentElement && depth < 12) {
                const parentSeg = this._simpleSelectorFor(cur);
                // 직계 자식 결합 먼저(더 정확), 안 되면 자손 결합
                for (const comb of [' > ', ' ']) {
                    const candidate = `${parentSeg}${comb}${prefix}${baseSel}`;
                    if (onlyHits(candidate)) return candidate;
                }
                // 부모에 id가 있으면 거기서 끊어 시도
                if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
                    const idSel = `#${CSS.escape(cur.id)}`;
                    for (const comb of [' > ', ' ']) {
                        const candidate = `${idSel}${comb}${prefix}${baseSel}`;
                        if (onlyHits(candidate)) return candidate;
                    }
                }
                // 한 단계 더 깊은 경로 누적
                prefix = `${parentSeg} > ${prefix}`;
                cur = cur.parentElement;
                depth++;
            }
            return null;
        }

        // el을 그 하나만 잡는 nth 기반 경로를 만든다 (클래스가 부실할 때)
        static _uniqueNthPath(el, onlyHits) {
            const segOf = (node) => {
                const t = node.tagName.toLowerCase();
                const cls = this.meaningfulClasses(node);
                let seg = t;
                if (cls.length) seg += `.${CSS.escape(cls[0])}`;
                const parent = node.parentElement;
                if (parent) {
                    const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
                    if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
                }
                return seg;
            };

            const parts = [segOf(el)];
            let cur = el.parentElement, depth = 0;
            while (cur && cur !== document.body && cur !== document.documentElement && depth < 12) {
                // 직계 자식 우선
                const childPath = parts.join(' > ');
                if (onlyHits(childPath)) return childPath;
                const descPath = parts.join(' ');
                if (onlyHits(descPath)) return descPath;

                parts.unshift(segOf(cur));

                // 부모 id로 끊을 수 있으면 시도
                if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
                    const idParts = [`#${CSS.escape(cur.id)}`, ...parts.slice(1)];
                    const idChild = idParts.join(' > ');
                    if (onlyHits(idChild)) return idChild;
                }
                cur = cur.parentElement;
                depth++;
            }
            const finalChild = parts.join(' > ');
            if (onlyHits(finalChild)) return finalChild;
            const finalDesc = parts.join(' ');
            if (onlyHits(finalDesc)) return finalDesc;
            return null;
        }
      }

    // ── 인스펙터 (UI / 선택 / 차단) ─────────────────────────────────────
    class Inspector {
        constructor() {
            this.dom = { host: null, shadow: null, tool: null, shield: null, shieldAim: null, shieldConfirm: null, rec: null, match: null };
            this.state = {
                target: null, selector: '',
                scale: 'icon',
                previewNodes: [], pinnedNodes: [], hiddenNodes: [], hiddenSelector: null,
                iconPos: null, panelPos: null,
                picking: false, lastHoverEl: null, pickCandidate: null,
                _wasFullBeforePick: false
            };
            this.modal = null;
            this._onResize = null;
        }

        resolveParent(el) { return el?.parentElement || null; }
        resolveFirstChild(el) {
            if (!el) return null;
            return Array.from(el.children || []).find(c =>
                c.id !== ROOT_ID && !(c.closest && c.closest(`#${ROOT_ID}`)) && c.id !== SHIELD_ID
            ) || null;
        }

        constructUI() {
            const host = document.createElement('div');
            host.id = ROOT_ID;
            host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;';
            document.documentElement.appendChild(host);
            const shadow = host.attachShadow({ mode: 'open' });
            this.dom.host = host; this.dom.shadow = shadow;

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
            this.attachDrag();
            this.applyPosition();

            this._onResize = () => this.applyPosition();
            window.addEventListener('resize', this._onResize);
            window.addEventListener('orientationchange', this._onResize);
        }

        applyPosition() {
            const tool = this.dom.tool;
            if (!tool) return;
            tool.style.left = tool.style.top = tool.style.right = tool.style.bottom = tool.style.transform = '';
            const w = tool.offsetWidth || (this.state.scale === 'icon' ? 48 : 320);
            const h = tool.offsetHeight || (this.state.scale === 'icon' ? 48 : 260);
            const posKey = this.state.scale === 'icon' ? 'iconPos' : 'panelPos';
            const pos = this.state[posKey];
            if (pos && typeof pos.x === 'number') {
                const c = this.clampPos(pos.x, pos.y, w, h);
                tool.style.left = c.x + 'px'; tool.style.top = c.y + 'px';
                this.state[posKey] = c;
            } else if (this.state.scale === 'icon') {
                tool.style.right = '20px'; tool.style.bottom = '20px';
            } else {
                tool.style.left = '50%'; tool.style.bottom = '20px'; tool.style.transform = 'translateX(-50%)';
            }
        }

        clampPos(x, y, w = 60, h = 60) {
            const vw = window.innerWidth, vh = window.innerHeight;
            return { x: Math.max(0, Math.min(vw - w, x)), y: Math.max(0, Math.min(vh - h, y)) };
        }

        render() {
            const tool = this.dom.tool;
            if (!tool) return;
            if (this.state.scale === 'icon') {
                tool.className = 'picky-tool picky-icon';
                tool.innerHTML = `<button class="picky-icon-btn" data-act="cycleSize" title="Picky 열기" aria-label="Picky 열기">${ICON_TARGET}</button>`;
                this.attachRefs();
                return;
            }
            tool.className = 'picky-tool picky-panel';
            tool.innerHTML = this.getLayout();
            this.attachRefs();
            this.refreshRec();
        }

        getLayout() {
            const enabled = Blocker.isEnabled();
            const agg = Blocker.isAggressive();
            const stats = Blocker.getStats();
            return `
            <div class="picky-head" data-drag="1">
                <span class="picky-title">Picky <small>v4.0</small></span>
                <div class="picky-head-btns">
                    <button class="picky-btn picky-btn-icon" data-act="rules" title="이 사이트 규칙">📋</button>
                    <button class="picky-btn picky-btn-icon" data-act="settings" title="설정">${ICON_SET}</button>
                    <button class="picky-btn picky-btn-icon" data-act="cycleSize" title="아이콘으로 접기">${ICON_MIN}</button>
                </div>
            </div>
            <div class="picky-body">
                <button class="picky-btn picky-btn-primary picky-pick" data-act="startPick">
                    ${ICON_TARGET}<span>요소 선택</span>
                </button>

                <div class="picky-rec" data-ref="rec">
                    <div class="picky-rec-empty">요소를 선택하면 여기에 표시됩니다</div>
                </div>

                <div class="picky-nav">
                    <button class="picky-btn picky-nav-btn" data-act="navUp" title="더 크게 (부모)">
                        ${ICON_UP}<span>더 크게</span>
                    </button>
                    <button class="picky-btn picky-nav-btn" data-act="navDown" title="더 작게 (자식)">
                        ${ICON_DOWN}<span>더 작게</span>
                    </button>
                </div>

                <div class="picky-act">
                    <button class="picky-btn" data-act="toggleHide" data-ref="hideBtn" title="페이지에서 임시로 숨겨 미리보기">
                        ${ICON_EYE}<span data-ref="hideLbl">숨김 미리보기</span>
                    </button>
                    <button class="picky-btn picky-btn-danger picky-block" data-act="block" title="차단">
                        ${ICON_BLOCK}<span>차단</span>
                    </button>
                </div>

                <label class="picky-toggle">
                    <input type="checkbox" data-act="toggleEnabled" ${enabled ? 'checked' : ''}>
                    <span>차단 활성</span>
                    <span class="picky-stat">이 사이트 ${stats.ruleCount}개</span>
                </label>
            </div>`;
        }

        attachRefs() {
            const t = this.dom.tool;
            this.dom.rec = t.querySelector('[data-ref="rec"]');
            t.querySelectorAll('[data-act]').forEach(el => {
                const evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'click';
                el.addEventListener(evt, (e) => { e.stopPropagation(); this.trigger(el.getAttribute('data-act'), el, e); });
            });
        }

        refreshRec() {
            const rec = this.dom.rec;
            if (!rec) return;
            const sel = this.state.selector;
            if (!sel) {
                rec.innerHTML = '<div class="picky-rec-empty">요소를 선택하면 여기에 표시됩니다</div>';
                this._setActionsEnabled(false);
                return;
            }
            const n = SelectorStrategies.countMatches(sel);
            const tag = this.state.target ? this.state.target.tagName.toLowerCase() : '';
            rec.innerHTML = `
                <div class="picky-rec-head">
                    <span class="picky-rec-tag">${esc(tag)}</span>
                    <span class="picky-rec-count">${n}개 일치</span>
                    <button class="picky-btn picky-btn-icon" data-act="copy" title="셀렉터 복사">${ICON_COPY}</button>
                    <button class="picky-btn picky-btn-icon" data-act="edit" title="직접 편집">✎</button>
                </div>
                <div class="picky-rec-sel" title="${esc(sel)}">${esc(sel)}</div>`;
            rec.querySelectorAll('[data-act]').forEach(el => {
                el.addEventListener('click', (e) => { e.stopPropagation(); this.trigger(el.getAttribute('data-act'), el, e); });
            });
            this._setActionsEnabled(true);
            this._syncHideLabel();
        }

        _setActionsEnabled(on) {
            const t = this.dom.tool;
            if (!t) return;
            ['block','toggleHide','navUp','navDown'].forEach(a => {
                const b = t.querySelector(`[data-act="${a}"]`);
                if (b) b.disabled = !on;
            });
        }

        _syncHideLabel() {
            const t = this.dom.tool;
            if (!t) return;
            const btn = t.querySelector('[data-act="toggleHide"]');
            const lbl = t.querySelector('[data-ref="hideLbl"]');
            const hiding = this.state.hiddenSelector && this.state.hiddenSelector === this.state.selector;
            if (btn) btn.classList.toggle('picky-btn-active', !!hiding);
            if (lbl) lbl.textContent = hiding ? '숨김 해제' : '숨김 미리보기';
        }

        // ── 미리보기 (핀 / 숨김) ──────────────────────────────────────
        applyPinned(sel) {
            this.clearPinned();
            if (!sel || this.state.hiddenSelector === sel) return;
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) { return; }
            for (const n of nodes) { if (n.closest && n.closest(`#${ROOT_ID}`)) continue; n.classList.add('picky-hl-pinned'); }
            this.state.pinnedNodes = nodes;
        }
        clearPinned() {
            for (const n of this.state.pinnedNodes) n.classList.remove('picky-hl-pinned');
            this.state.pinnedNodes = [];
        }
        applyHide(sel) {
            this.clearHide();
            if (!sel) return 0;
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (_) { return 0; }
            const applied = [];
            nodes.forEach(n => { if (n.closest && n.closest(`#${ROOT_ID}`)) return; if (n.id === ROOT_ID) return; n.classList.add(HIDE_CLASS); applied.push(n); });
            this.state.hiddenNodes = applied; this.state.hiddenSelector = sel;
            this.clearPinned();
            return applied.length;
        }
        clearHide() {
            for (const n of this.state.hiddenNodes) n.classList.remove(HIDE_CLASS);
            this.state.hiddenNodes = []; this.state.hiddenSelector = null;
        }
        toggleHide(sel) {
            if (!sel) return { hidden: false, count: 0 };
            if (this.state.hiddenSelector === sel) { this.clearHide(); this.applyPinned(sel); return { hidden: false, count: 0 }; }
            return { hidden: true, count: this.applyHide(sel) };
        }

        // ── 선택 ──────────────────────────────────────────────────────
        selectNode(el) {
            if (!el || !el.tagName) return;
            this.clearHide();
            this.clearPinned();
            this.state.target = el;
            this.state.selector = SelectorStrategies.best(el) || '';
            if (this.state.selector) this.applyPinned(this.state.selector);
            this.setFocus(el);
            this.refreshRec();
        }

        setFocus(el) {
            this.dropFocus();
            if (!el) return;
            el.classList.add(HL_CLASS);
            const tracked = [el];
            if (['IMG','IFRAME','VIDEO','EMBED'].includes(el.tagName)) {
                const p = el.parentElement;
                if (p && p !== document.body && p.id !== ROOT_ID && !(p.closest && p.closest(`#${ROOT_ID}`))) {
                    p.classList.add('picky-hl-parent'); tracked.push(p);
                }
            }
            this.state.previewNodes = tracked;
        }
        dropFocus() {
            for (const n of this.state.previewNodes) { n.classList.remove(HL_CLASS); n.classList.remove('picky-hl-parent'); }
            this.state.previewNodes = [];
        }

        // ── 손가락 조준 선택 ───────────────────────────────────────────
        startPicking() {
            if (this.state.picking) return;
            this.clearHide();
            this.state.picking = true;
            this.state.pickCandidate = null;

            if (IS_MOBILE && this.state.scale === 'full') {
                this.state._wasFullBeforePick = true;
                this.state.scale = 'icon';
                this.render(); this.applyPosition();
            }

            const shield = document.createElement('div');
            shield.id = SHIELD_ID;
            shield.style.cssText = 'position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;z-index:2147483645!important;cursor:crosshair!important;background:rgba(0,0,0,0.02)!important;touch-action:none!important;-webkit-tap-highlight-color:transparent!important;margin:0!important;padding:0!important;border:none!important;';
            document.documentElement.appendChild(shield);
            this.dom.shield = shield;

            const aim = document.createElement('div');
            aim.className = 'picky-aim';
            aim.style.cssText = `position:absolute!important;width:0!important;height:0!important;pointer-events:none!important;z-index:2147483646!important;left:-100px!important;top:-100px!important;display:${IS_TOUCH ? 'block' : 'none'}!important;`;
            aim.innerHTML = `<div style="position:absolute;left:-16px;top:-16px;width:32px;height:32px;border:2px solid #ef4444;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,0.6),inset 0 0 0 1px rgba(255,255,255,0.4);"><div style="position:absolute;left:50%;top:-8px;width:2px;height:8px;background:#ef4444;transform:translateX(-50%);"></div><div style="position:absolute;left:-8px;top:50%;width:8px;height:2px;background:#ef4444;transform:translateY(-50%);"></div></div>`;
            shield.appendChild(aim);
            this.dom.shieldAim = aim;

            if (IS_TOUCH) {
                const confirm = document.createElement('div');
                confirm.className = 'picky-shield-confirm';
                confirm.style.cssText = 'position:fixed!important;bottom:16px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(17,24,39,0.98)!important;border:1px solid rgba(255,255,255,0.15)!important;border-radius:12px!important;padding:12px 14px!important;z-index:2147483647!important;max-width:calc(100vw - 24px)!important;width:360px!important;box-shadow:0 8px 24px rgba(0,0,0,0.6)!important;touch-action:manipulation!important;font-family:-apple-system,BlinkMacSystemFont,sans-serif!important;color:#e8eaed!important;box-sizing:border-box!important;';
                confirm.innerHTML = `
                    <div class="picky-shield-msg" style="font-size:12px;color:#e8eaed;margin-bottom:8px;word-break:break-all;line-height:1.4;text-align:center;">손가락으로 요소를 가리키세요 (조준점이 위쪽에 표시됩니다)</div>
                    <div style="display:flex;gap:8px;">
                        <button data-shield="confirm" disabled style="flex:1;min-height:44px;padding:8px 12px;font-size:13px;background:linear-gradient(135deg,#3b82f6,#2563eb);border:none;border-radius:8px;color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:4px;opacity:0.4;">${ICON_CHECK} 이 요소 선택</button>
                        <button data-shield="cancel" style="flex:1;min-height:44px;padding:8px 12px;font-size:13px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e8eaed;display:inline-flex;align-items:center;justify-content:center;gap:4px;">${ICON_CLOSE} 취소</button>
                    </div>`;
                shield.appendChild(confirm);
                this.dom.shieldConfirm = confirm;
                const bC = confirm.querySelector('[data-shield="confirm"]');
                const bX = confirm.querySelector('[data-shield="cancel"]');
                const onC = (e) => { e.preventDefault(); e.stopPropagation(); if (this.state.pickCandidate) { const el = this.state.pickCandidate; this.cleanupHl(); vibrate(25); this.stopPicking(); this.selectNode(el); } };
                const onX = (e) => { e.preventDefault(); e.stopPropagation(); this.stopPicking(); };
                bC.addEventListener('click', onC); bC.addEventListener('pointerup', onC);
                bX.addEventListener('click', onX); bX.addEventListener('pointerup', onX);
            }

            const pickAt = (x, y) => {
                const ax = x, ay = y + SHIELD_AIM_OFFSET_Y;
                const prev = shield.style.pointerEvents;
                shield.style.pointerEvents = 'none';
                let el = null;
                for (const node of document.elementsFromPoint(ax, ay)) {
                    if (!node || node === shield || node.id === SHIELD_ID || node.id === ROOT_ID) continue;
                    if (node.closest && (node.closest(`#${ROOT_ID}`) || node.closest(`#${SHIELD_ID}`))) continue;
                    if (node.tagName === 'HTML') continue;
                    el = node; break;
                }
                shield.style.pointerEvents = prev || 'auto';
                if (!el) return null;
                return this.refineAtPoint(el, ax, ay);
            };

            this._shieldMove = (e) => {
                if (e.target && e.target.closest && e.target.closest('.picky-shield-confirm')) return;
                const el = pickAt(e.clientX, e.clientY);
                if (this.dom.shieldAim) { this.dom.shieldAim.style.left = e.clientX + 'px'; this.dom.shieldAim.style.top = (e.clientY + SHIELD_AIM_OFFSET_Y) + 'px'; }
                if (!el || this.state.lastHoverEl === el) return;
                if (this.state.lastHoverEl) this.state.lastHoverEl.classList.remove('picky-hl-preview');
                el.classList.add('picky-hl-preview');
                this.state.lastHoverEl = el; this.state.pickCandidate = el;
                if (this.dom.shieldConfirm) {
                    const btn = this.dom.shieldConfirm.querySelector('[data-shield="confirm"]');
                    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
                    const msg = this.dom.shieldConfirm.querySelector('.picky-shield-msg');
                    if (msg) {
                        const id = el.id ? `#${el.id}` : '';
                        const cls = SelectorStrategies.meaningfulClasses(el).slice(0, 2).map(c => '.' + c).join('');
                        msg.innerHTML = `<code style="background:rgba(0,0,0,0.4);color:#9ecbff;padding:3px 6px;border-radius:4px;font-size:11px;">${esc(el.tagName.toLowerCase() + id + cls)}</code>`;
                    }
                }
            };

            this._shieldDown = (e) => {
                if (e.target && e.target.closest && e.target.closest('.picky-shield-confirm')) return;
                if (e.cancelable) e.preventDefault();
                e.stopPropagation();
                if (!IS_TOUCH) {
                    let el = pickAt(e.clientX, e.clientY);
                    if (!el) { this.flashToast('요소를 찾지 못했습니다'); return; }
                    if (e.altKey) {
                        const prev = shield.style.pointerEvents;
                        shield.style.pointerEvents = 'none';
                        const stack = document.elementsFromPoint(e.clientX, e.clientY).filter(n => n && n !== shield && !n.closest(`#${ROOT_ID}`) && !n.closest(`#${SHIELD_ID}`));
                        shield.style.pointerEvents = prev || 'auto';
                        if (stack.length) el = stack.reduce((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (ra.width * ra.height || Infinity) <= (rb.width * rb.height || Infinity) ? a : b; });
                    }
                    this.cleanupHl(); this.stopPicking(); this.selectNode(el);
                } else { this._shieldMove(e); }
            };

            this._shieldKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stopPicking(); } };

            shield.addEventListener('pointermove', this._shieldMove, { passive: false });
            shield.addEventListener('pointerdown', this._shieldDown, { passive: false });
            document.addEventListener('keydown', this._shieldKey, true);

            this.flashToast(IS_TOUCH ? '손가락을 움직여 요소를 가리키세요' : '요소 클릭 (Alt+클릭: 가장 작은 요소, ESC: 취소)');
            vibrate(10);
        }

        cleanupHl() {
            if (this.state.lastHoverEl) { this.state.lastHoverEl.classList.remove('picky-hl-preview'); this.state.lastHoverEl = null; }
        }

        stopPicking() {
            if (!this.state.picking) return;
            this.state.picking = false;
            this.state.pickCandidate = null;
            const shield = this.dom.shield;
            if (shield) {
                shield.removeEventListener('pointermove', this._shieldMove);
                shield.removeEventListener('pointerdown', this._shieldDown);
                shield.remove();
                this.dom.shield = this.dom.shieldAim = this.dom.shieldConfirm = null;
            }
            document.removeEventListener('keydown', this._shieldKey, true);
            this.cleanupHl();
            if (this.state._wasFullBeforePick) {
                this.state._wasFullBeforePick = false;
                this.state.scale = 'full';
                this.render(); this.applyPosition();
            }
        }

        refineAtPoint(el, x, y) {
            if (!el) return el;
            if (el.tagName === 'BODY' || el.tagName === 'HTML') {
                const stack = document.elementsFromPoint(x, y).filter(n => n && !n.closest(`#${ROOT_ID}`) && n !== el && n.tagName !== 'BODY' && n.tagName !== 'HTML');
                return stack.length ? stack[0] : el;
            }
            if (el.tagName === 'A') {
                const imgs = el.querySelectorAll(':scope > img, :scope img');
                if (imgs.length === 1) {
                    const ir = imgs[0].getBoundingClientRect();
                    if (x >= ir.left && x <= ir.right && y >= ir.top && y <= ir.bottom) return imgs[0];
                }
            }
            return el;
        }

        cycleSize() {
            if (this.state.scale === 'icon') { this.state.scale = 'full'; this.state.panelPos = null; }
            else {
                this.state.scale = 'icon'; this.state.iconPos = null;
                this.dropFocus(); this.clearPinned(); this.clearHide();
                if (this.state.picking) this.stopPicking();
            }
            this.render(); this.applyPosition();
        }

        async doBlock() {
            const sel = this.state.selector;
            if (!sel) { this.flashToast('선택된 요소가 없습니다'); return; }
            if (isUnsafeSelector(sel)) {
                const ok = await this.modal.confirm('광범위한 셀렉터 경고',
                    `이 셀렉터는 페이지의 매우 많은 요소(또는 전체)를 숨길 수 있습니다.\n\n${sel}\n\n그래도 차단할까요?`,
                    { okText: '차단 강행', cancelText: '취소', danger: true });
                if (!ok) return;
            }
            this.clearHide();
            if (Blocker.append(sel)) { vibrate(20); this.flashToast(`차단됨: ${sel.slice(0, 40)}`); this.render(); }
            else this.flashToast('이미 등록된 규칙입니다');
        }

        trigger(act, el, evt) {
            switch (act) {
                case 'cycleSize': this.cycleSize(); break;
                case 'settings': this.showSettings(); break;
                case 'rules': this.showRules(); break;
                case 'startPick': this.startPicking(); break;
                case 'navUp': { const p = this.resolveParent(this.state.target); if (p && p !== document.body) this.selectNode(p); else this.flashToast('더 상위 요소가 없습니다'); break; }
                case 'navDown': { const c = this.resolveFirstChild(this.state.target); if (c) this.selectNode(c); else this.flashToast('더 하위 요소가 없습니다'); break; }
                case 'block': this.doBlock(); break;
                case 'toggleHide': {
                    const sel = this.state.selector;
                    if (!sel) { this.flashToast('선택된 요소가 없습니다'); break; }
                    const r = this.toggleHide(sel);
                    this.flashToast(r.hidden ? `${r.count}개 요소 숨김 (미리보기)` : '숨김 해제됨');
                    this._syncHideLabel();
                    break;
                }
                case 'copy': { if (this.state.selector) { this.copyText(this.state.selector); this.flashToast('셀렉터 복사됨'); } break; }
                case 'edit': this.editSelector(); break;
                case 'toggleEnabled': Blocker.toggleEnabled(); this.render(); break;
                case 'toggleAggressive': Blocker.toggleAggressive(); break;
            }
        }

        editSelector() {
            const cur = this.state.selector || '';
            const body = this.modal.display('셀렉터 직접 편집', '', true);
            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:6px">추천이 빗나갔을 때만 사용하세요. 수정하면 초록 외곽선으로 미리보기됩니다.</div>
                <textarea class="picky-modal-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(cur)}</textarea>
                <div class="picky-modal-meta" data-ref="prev">일치 0개</div>
                <div class="picky-modal-foot">
                    <button class="picky-btn" data-ref="apply">적용</button>
                    <button class="picky-btn picky-btn-danger" data-ref="blk">차단 추가</button>
                </div>`;
            const ta = body.querySelector('textarea');
            const prev = body.querySelector('[data-ref="prev"]');
            const update = () => { const sel = ta.value.trim(); prev.textContent = `일치 ${SelectorStrategies.countMatches(sel)}개`; this.applyPinned(sel); };
            ta.addEventListener('input', update); update();
            body.querySelector('[data-ref="apply"]').addEventListener('click', () => { this.state.selector = ta.value.trim(); this.refreshRec(); this.modal.dismiss(); });
            body.querySelector('[data-ref="blk"]').addEventListener('click', async () => {
                const v = ta.value.trim(); if (!v) return;
                if (isUnsafeSelector(v)) {
                    const ok = await this.modal.confirm('광범위한 셀렉터 경고', `이 셀렉터는 너무 많은 요소를 숨길 수 있습니다.\n\n${v}\n\n그래도 차단할까요?`, { okText: '차단 강행', cancelText: '취소', danger: true });
                    if (!ok) return;
                }
                this.clearHide();
                if (Blocker.append(v)) { vibrate(20); this.flashToast('차단 규칙 추가됨'); this.render(); }
                this.modal.dismiss();
            });
        }

        showRules() {
            const rules = Blocker.fetch();
            const body = this.modal.display(`이 사이트 규칙 (${rules.length})`, '', true);
            body.innerHTML = `
                <div class="picky-rules-list">
                    ${rules.length ? rules.map((r, i) => `
                        <div class="picky-rule-item">
                            <code title="${esc(r)}">${esc(r)}</code>
                            <button class="picky-btn picky-btn-icon" data-ridx="${i}" title="삭제">${ICON_CLOSE}</button>
                        </div>`).join('') : '<div class="picky-rec-empty">등록된 규칙이 없습니다</div>'}
                </div>
                <div class="picky-modal-foot">
                    ${rules.length ? '<button class="picky-btn picky-btn-danger" data-ref="clear">이 사이트 전체 삭제</button>' : ''}
                </div>`;
            body.querySelectorAll('[data-ridx]').forEach(b => b.addEventListener('click', () => { Blocker.drop(rules[parseInt(b.dataset.ridx)]); this.showRules(); this.render(); }));
            const clr = body.querySelector('[data-ref="clear"]');
            if (clr) clr.addEventListener('click', async () => {
                const ok = await this.modal.confirm('규칙 삭제', '이 사이트의 모든 규칙을 삭제할까요?', { okText: '삭제', danger: true });
                if (ok) { Blocker.clear(); this.render(); this.showRules(); }
            });
        }

        showSettings() {
            const body = this.modal.display('설정', '', true);
            const agg = Blocker.isAggressive();
            const stats = Blocker.getStats();
            body.innerHTML = `
                <div class="picky-settings">
                    <label class="picky-toggle" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                        <input type="checkbox" data-ref="agg" ${agg ? 'checked' : ''}>
                        <span>강화 모드 (끈질긴 광고 강제 제거)</span>
                    </label>
                    <div class="picky-settings-row"><span>전체 규칙</span><span>${stats.totalRules}개 (이 사이트 ${stats.ruleCount}개)</span></div>
                    <div class="picky-settings-row"><button class="picky-btn" data-ref="resetPos">버튼 위치 초기화</button><button class="picky-btn" data-ref="clearPreview">미리보기 정리</button></div>
                    <div class="picky-settings-row"><small style="opacity:0.6;line-height:1.5">요소 선택 → 더 크게/작게로 범위 조절 → 차단. SPA에서 다시 나타나는 요소는 자동으로 재차단됩니다(self-healing).</small></div>
                </div>`;
            body.querySelector('[data-ref="agg"]').addEventListener('change', () => Blocker.toggleAggressive());
            body.querySelector('[data-ref="resetPos"]').addEventListener('click', () => { this.state.iconPos = null; this.state.panelPos = null; this.applyPosition(); this.flashToast('위치 초기화됨'); });
            body.querySelector('[data-ref="clearPreview"]').addEventListener('click', () => { this.clearPinned(); this.clearHide(); this.flashToast('미리보기 정리됨'); this._syncHideLabel(); });
        }

        async copyText(text) {
            try { await navigator.clipboard.writeText(text); }
            catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        }

        flashToast(msg) {
            const t = document.createElement('div');
            t.className = 'picky-toast';
            t.textContent = msg;
            this.dom.shadow.appendChild(t);
            setTimeout(() => t.classList.add('visible'), 10);
            setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 200); }, 1800);
        }

        attachDrag() {
            const tool = this.dom.tool;
            if (!tool) return;
            let sx = 0, sy = 0, sl = 0, st = 0, moved = false, active = false, pid = null;
            const onDown = (e) => {
                if (e.target.closest(NO_DRAG_SELECTOR)) return;
                if (this.state.scale !== 'icon' && !e.target.closest('[data-drag="1"]')) return;
                active = true; moved = false; pid = e.pointerId;
                const r = tool.getBoundingClientRect();
                sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            };
            const onMove = (e) => {
                if (!active) return;
                const dx = e.clientX - sx, dy = e.clientY - sy;
                if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                    moved = true;
                    try { tool.setPointerCapture?.(pid); } catch (_) {}
                    tool.style.transform = ''; tool.style.left = sl + 'px'; tool.style.top = st + 'px'; tool.style.right = 'auto'; tool.style.bottom = 'auto';
                }
                if (moved) {
                    if (e.cancelable) e.preventDefault();
                    const p = this.clampPos(sl + dx, st + dy, tool.offsetWidth, tool.offsetHeight);
                    tool.style.left = p.x + 'px'; tool.style.top = p.y + 'px';
                }
            };
            const onUp = () => {
                if (!active) return; active = false;
                if (moved) { const r = tool.getBoundingClientRect(); const pos = { x: r.left, y: r.top }; if (this.state.scale === 'icon') this.state.iconPos = pos; else this.state.panelPos = pos; }
                try { tool.releasePointerCapture?.(pid); } catch (_) {}
                pid = null; setTimeout(() => { moved = false; }, 50);
            };
            tool.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
            tool.addEventListener('pointerdown', onDown, { passive: true });
            tool.addEventListener('pointermove', onMove, { passive: false });
            tool.addEventListener('pointerup', onUp, { passive: false });
            tool.addEventListener('pointercancel', onUp, { passive: false });
        }

        launch() { this.constructUI(); }
    }

    const PICKY_CSS = `
    :host, * { box-sizing: border-box; }
    .picky-tool { position: fixed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; color: #e8eaed; z-index: 2147483647; -webkit-tap-highlight-color: transparent; }
    .picky-icon { width: 48px; height: 48px; touch-action: none; }
    .picky-icon-btn { width: 100%; height: 100%; min-width: 44px; min-height: 44px; border: none; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #1e40af); color: #fff; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; touch-action: none; }
    .picky-icon-btn:hover { transform: scale(1.06); }

    .picky-panel { width: 320px; max-width: calc(100vw - 16px); background: rgba(28,30,38,0.97); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(8px); overflow: hidden; }
    .picky-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(0,0,0,0.25); cursor: grab; user-select: none; touch-action: none; }
    .picky-head:active { cursor: grabbing; }
    .picky-title { font-weight: 600; font-size: 14px; }
    .picky-title small { opacity: 0.5; font-weight: 400; margin-left: 4px; }
    .picky-head-btns { display: flex; gap: 4px; }
    .picky-body { padding: 12px; }

    .picky-btn { display: inline-flex; align-items: center; gap: 5px; padding: 8px 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #e8eaed; border-radius: 7px; cursor: pointer; font-size: 13px; transition: background 0.15s, border-color 0.15s; touch-action: manipulation; }
    .picky-btn > * { pointer-events: none; }
    .picky-btn:hover { background: rgba(255,255,255,0.15); }
    .picky-btn:active { background: rgba(255,255,255,0.22); }
    .picky-btn:disabled, .picky-btn[disabled] { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
    .picky-btn-icon { padding: 7px; min-width: 34px; min-height: 34px; justify-content: center; }
    .picky-btn-active { background: linear-gradient(135deg, #8b5cf6, #6d28d9); border-color: transparent; color: #fff; }
    .picky-btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); border-color: transparent; color: #fff; justify-content: center; }
    .picky-btn-danger { background: linear-gradient(135deg, #ef4444, #b91c1c); border-color: transparent; color: #fff; justify-content: center; }

    .picky-pick { width: 100%; min-height: 44px; font-size: 14px; margin-bottom: 10px; }

    .picky-rec { background: rgba(0,0,0,0.25); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; min-height: 56px; }
    .picky-rec-empty { opacity: 0.4; font-size: 12px; text-align: center; padding: 12px 0; }
    .picky-rec-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .picky-rec-tag { font-weight: 700; color: #6ee7b7; font-family: ui-monospace, monospace; font-size: 12px; }
    .picky-rec-count { font-size: 11px; opacity: 0.6; flex: 1; }
    .picky-rec-sel { font-family: ui-monospace, monospace; font-size: 12px; color: #9ecbff; word-break: break-all; line-height: 1.4; user-select: text; -webkit-user-select: text; }

    .picky-nav { display: flex; gap: 6px; margin-bottom: 10px; }
    .picky-nav-btn { flex: 1; min-height: 42px; justify-content: center; }

    .picky-act { display: flex; gap: 6px; margin-bottom: 10px; }
    .picky-act .picky-btn { flex: 1; min-height: 44px; }
    .picky-block { flex: 1.2 !important; }

    .picky-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; min-height: 36px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); }
    .picky-toggle input { cursor: pointer; width: 18px; height: 18px; }
    .picky-stat { margin-left: auto; opacity: 0.55; font-size: 11px; }

    .picky-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2147483647; opacity: 0; transition: opacity 0.2s; color: #e8eaed; }
    .picky-modal.visible { opacity: 1; }
    .picky-modal-card { background: #1c1e26; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; max-width: 480px; width: 92%; max-height: 80vh; max-height: 80dvh; overflow: hidden; display: flex; flex-direction: column; }
    .picky-modal-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .picky-modal-title { font-weight: 600; }
    .picky-modal-x { background: transparent; border: none; color: #e8eaed; cursor: pointer; padding: 8px; min-width: 36px; min-height: 36px; display: flex; align-items: center; justify-content: center; }
    .picky-modal-body { padding: 14px; overflow-y: auto; font-size: 13px; flex: 1; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .picky-modal-body code { color: #9ecbff; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px; user-select: text; -webkit-user-select: text; }
    .picky-modal-input { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #9ecbff; font-family: ui-monospace, monospace; font-size: 14px; padding: 10px; border-radius: 6px; margin: 8px 0; resize: vertical; -webkit-text-fill-color: #9ecbff; user-select: text; -webkit-user-select: text; }
    .picky-modal-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    .picky-modal-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .picky-modal-foot .picky-btn { min-height: 38px; }

    .picky-rules-list { max-height: 50vh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .picky-rule-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; background: rgba(255,255,255,0.04); border-radius: 6px; margin-bottom: 5px; }
    .picky-rule-item code { font-size: 11px; color: #9ecbff; word-break: break-all; flex: 1; user-select: text; -webkit-user-select: text; }

    .picky-settings-row { display: flex; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); flex-wrap: wrap; }
    .picky-settings-row:last-child { border-bottom: none; }
    .picky-settings-row .picky-btn { min-height: 38px; }

    .picky-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%) translateY(20px); background: rgba(17,24,39,0.95); color: #fff; padding: 10px 18px; border-radius: 20px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.25s, transform 0.25s; z-index: 2147483647; pointer-events: none; max-width: 90vw; }
    .picky-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

    @media (max-width: 600px) {
        .picky-panel { width: calc(100vw - 16px); max-width: calc(100vw - 16px); }
        .picky-modal-card { width: 95%; max-height: 88vh; max-height: 88dvh; }
        .picky-modal-foot .picky-btn { flex: 1; min-width: 0; }
    }`;

    // ── 페이지(라이트 DOM) 하이라이트/숨김 스타일 ──────────────────────
    const PAGE_CSS = `
        .${HL_CLASS} { outline: 2px solid #ef4444 !important; outline-offset: -2px !important; background: rgba(239,68,68,0.08) !important; }
        .picky-hl-parent { outline: 2px dashed #f59e0b !important; outline-offset: -2px !important; }
        .picky-hl-preview { outline: 2px solid #3b82f6 !important; outline-offset: -2px !important; background: rgba(59,130,246,0.08) !important; }
        .picky-hl-pinned { outline: 2px solid #10b981 !important; outline-offset: -2px !important; background: rgba(16,185,129,0.08) !important; }
        .${HIDE_CLASS} { visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
    `;

    function injectPageCss() {
        const ID = 'picky-page-css';
        let style = document.getElementById(ID);
        if (!style || !style.isConnected) {
            style = document.createElement('style');
            style.id = ID;
            style.textContent = PAGE_CSS;
            (document.head || document.documentElement).appendChild(style);
        }
        return style;
    }

    // 페이지 하이라이트 스타일도 self-healing
    function watchPageCss() {
        injectPageCss();
        let timer = null;
        const obs = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                const s = document.getElementById('picky-page-css');
                if (!s || !s.isConnected || !s.textContent) injectPageCss();
            }, 300);
        });
        if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(() => { const s = document.getElementById('picky-page-css'); if (!s || !s.isConnected || !s.textContent) injectPageCss(); }, 5000);
    }

    // ── 부트스트랩 ───────────────────────────────────────────────────────
    let inspector = null;

    function boot() {
        if (window.__pickyBooted) return;
        window.__pickyBooted = true;

        injectPageCss();
        watchPageCss();
        Blocker.enforce();

        inspector = new Inspector();
        inspector.launch();

        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('Picky 열기/접기', () => inspector && inspector.cycleSize());
                GM_registerMenuCommand('요소 선택 시작', () => { if (!inspector) return; if (inspector.state.scale === 'icon') inspector.cycleSize(); inspector.startPicking(); });
                GM_registerMenuCommand('이 사이트 규칙 보기', () => { if (!inspector) return; if (inspector.state.scale === 'icon') inspector.cycleSize(); inspector.showRules(); });
                GM_registerMenuCommand('차단 활성/비활성 전환', () => { Blocker.toggleEnabled(); if (inspector) inspector.render(); });
            }
        } catch (_) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
        const early = () => { if (document.head) { injectPageCss(); Blocker.enforce(); } else requestAnimationFrame(early); };
        early();
    } else {
        boot();
    }

})();
