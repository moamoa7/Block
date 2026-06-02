// ==UserScript==
// @name         Pokkok
// @namespace    https://github.com/moamoa7/Block
// @version      1.1.0
// @description  uBlock을 못 쓰는 모바일 브라우저용 가벼운 요소 숨김기 — 손가락으로 짚고 탭 한 번에 차단, 유사 요소 찾기(속성·치수), 차단 동일 미리보기, iframe 박스 선택, :where 차단 엔진, self-healing
// @author       moamoa7
// @license      MIT
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

    const TOOL_ID    = 'pokkok-tool-root';
    const ROOT_ID    = 'pokkok-shadow-host';
    const HL_CLASS   = 'pokkok-hl';
    const SHIELD_ID  = 'pokkok-shield';
    const HIDE_CLASS = 'pokkok-hidden-preview';
    const DRAG_THRESHOLD = 6;

    const IS_TOUCH = (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
    const IS_MOBILE = IS_TOUCH && Math.min(window.innerWidth, window.innerHeight) < 768;
    const SHIELD_AIM_OFFSET_Y = IS_TOUCH ? -40 : 0;

    const NO_DRAG_SELECTOR = [
        'input', 'textarea', 'select', 'button', 'a',
        '[contenteditable="true"]',
        '.pokkok-rec', '.pokkok-rec *',
        '.pokkok-modal-body', '.pokkok-modal-body *', '.pokkok-btn'
    ].join(',');

    const SUPPORTS_ADOPTED = (() => {
        try {
            return ('adoptedStyleSheets' in Document.prototype) &&
                   (typeof CSSStyleSheet !== 'undefined') &&
                   (typeof new CSSStyleSheet().replaceSync === 'function');
        } catch (_) { return false; }
    })();

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const vibrate = (ms = 15) => {
        try { navigator.vibrate?.(ms); } catch (_) {}
    };

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
    const ICON_SIMILAR = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10 0h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm4 0h2v2h-2v-2z"/></svg>';

    // ── 규칙 저장/적용 (현재 사이트 단위) ───────────────────────────────
    // 차단 엔진: :where(...) 로 명시도 0 + adoptedStyleSheets(미지원 시 <style> 폴백)
    const Blocker = {
        STYLE_ID: 'pokkok-block-style',
        KEY_RULES: 'pokkok_rules_v2',
        KEY_ENABLED: 'pokkok_enabled',
        KEY_AGG:   'pokkok_aggressive',
        _sheet: null,
        _sheetText: '',

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

        _needsRefresh() {
            const wantText = this._buildCss();
            if (SUPPORTS_ADOPTED) {
                if (!this._sheet) return !!wantText;
                const attached = (document.adoptedStyleSheets || []).includes(this._sheet);
                if (wantText && !attached) return true;
                if (this._sheetText !== wantText) return true;
                return false;
            }
            if (!document.head) return false;
            const style = document.getElementById(this.STYLE_ID);
            if (wantText) {
                if (!style || !style.isConnected) return true;
                if (style.textContent !== wantText) return true;
            }
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

        replaceAll(obj) {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
            const clean = {};
            for (const k of Object.keys(obj)) {
                if (Array.isArray(obj[k])) {
                    const arr = obj[k].filter(v => typeof v === 'string' && v && !/[{}]/.test(v));
                    if (arr.length) clean[k] = arr;
                }
            }
            GM_setValue(this.KEY_RULES, JSON.stringify(clean));
            this.enforce();
            return true;
        },

        append(sel) {
            if (!sel || typeof sel !== 'string') return false;
            const rules = this.fetch();
            if (rules.includes(sel)) return false;
            rules.push(sel);
            this.save(rules);
            return true;
        },

        appendMany(sels) {
            if (!Array.isArray(sels) || !sels.length) return 0;
            const rules = this.fetch();
            let added = 0;
            for (const s of sels) {
                if (typeof s === 'string' && s && !rules.includes(s)) { rules.push(s); added++; }
            }
            if (added) this.save(rules);
            return added;
        },

        drop(sel) {
            this.save(this.fetch().filter(r => r !== sel));
        },

        clear() { this.save([]); },

        isEnabled()    { return GM_getValue(this.KEY_ENABLED, true); },
        toggleEnabled(){ GM_setValue(this.KEY_ENABLED, !this.isEnabled()); this.enforce(); },
        isAggressive() { return GM_getValue(this.KEY_AGG, false); },
        toggleAggressive() { GM_setValue(this.KEY_AGG, !this.isAggressive()); this.enforce(); },

        _buildCss() {
            if (!this.isEnabled()) return '';
            const rules = this.fetch();
            if (!rules.length) return '';
            const safe = rules.filter(r => {
                if (!r || /[{}]/.test(r)) return false;
                try { document.querySelector(r); return true; }
                catch (_) { return false; }
            });
            if (!safe.length) return '';

            const decl = this.isAggressive()
                ? 'display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;width:0!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important;'
                : 'display:none!important;';

            const inner = safe.join(', ');
            return `:where(${inner}):not(#${ROOT_ID}):not(#${ROOT_ID} *):not(#${SHIELD_ID}):not(#${SHIELD_ID} *){${decl}}`;
        },

        enforce() {
            const css = this._buildCss();

            if (SUPPORTS_ADOPTED) {
                try {
                    if (!this._sheet) this._sheet = new CSSStyleSheet();
                    if (this._sheetText !== css) {
                        this._sheet.replaceSync(css);
                        this._sheetText = css;
                    }
                    const list = document.adoptedStyleSheets || [];
                    const has = list.includes(this._sheet);
                    if (css && !has) {
                        document.adoptedStyleSheets = [...list, this._sheet];
                    } else if (!css && has) {
                        document.adoptedStyleSheets = list.filter(s => s !== this._sheet);
                    }
                    const legacy = document.getElementById(this.STYLE_ID);
                    if (legacy) legacy.remove();
                    return;
                } catch (_) { /* 폴백 */ }
            }

            if (!document.head) return;
            let style = document.getElementById(this.STYLE_ID);
            if (!css) { if (style) style.textContent = ''; this._sheetText = ''; return; }
            if (!style || !style.isConnected) {
                style = document.createElement('style');
                style.id = this.STYLE_ID;
                document.head.appendChild(style);
            }
            if (style.textContent !== css) style.textContent = css;
            this._sheetText = css;
        },

        getStats() {
            const all = this.fetchAll();
            let total = 0;
            for (const k of Object.keys(all)) total += (all[k] || []).length;
            return { ruleCount: this.fetch().length, totalRules: total };
        }
    };
    Blocker.init();

    // ── 모달 (커스텀 confirm + 드래그 이동) ─────────────────────────────
    class Modal {
        constructor(container) { this.container = container; this.node = null; this._onDismiss = null; this._vv = null; this._card = null; this._pos = null; }

        display(title, body, isHtml = false) {
            this.dismiss();
            const wrap = document.createElement('div');
            wrap.className = 'pokkok-modal';
            wrap.innerHTML = `
                <div class="pokkok-modal-card">
                    <div class="pokkok-modal-head" data-modal-drag="1">
                        <span class="pokkok-modal-grip" title="드래그하여 이동">⠿</span>
                        <span class="pokkok-modal-title">${esc(title)}</span>
                        <button class="pokkok-modal-x" aria-label="닫기">${ICON_CLOSE}</button>
                    </div>
                    <div class="pokkok-modal-body"></div>
                </div>`;
            const bodyEl = wrap.querySelector('.pokkok-modal-body');
            if (isHtml) bodyEl.innerHTML = body; else bodyEl.textContent = body;
            wrap.querySelector('.pokkok-modal-x').addEventListener('click', () => this.dismiss());
            wrap.addEventListener('click', (e) => { if (e.target === wrap) this.dismiss(); });
            (this.container || document.body).appendChild(wrap);
            requestAnimationFrame(() => wrap.classList.add('visible'));
            this.node = wrap;
            this._card = wrap.querySelector('.pokkok-modal-card');
            this._pos = null;
            this._attachDrag();

            if (window.visualViewport) {
                const card = this._card;
                this._vv = () => { if (card && !this._pos) { const vh = window.visualViewport.height; card.style.maxHeight = Math.min(vh - 16, vh * 0.95) + 'px'; } };
                this._vv();
                window.visualViewport.addEventListener('resize', this._vv);
                window.visualViewport.addEventListener('scroll', this._vv);
            }
            return bodyEl;
        }

        _attachDrag() {
            const card = this._card;
            const head = this.node.querySelector('[data-modal-drag="1"]');
            if (!card || !head) return;
            let sx = 0, sy = 0, sl = 0, st = 0, moved = false, active = false, pid = null;

            const startFixed = () => {
                const r = card.getBoundingClientRect();
                card.style.position = 'fixed';
                card.style.margin = '0';
                card.style.left = r.left + 'px';
                card.style.top = r.top + 'px';
                this.node.style.alignItems = 'flex-start';
                this.node.style.justifyContent = 'flex-start';
            };
            const clamp = (x, y) => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const w = card.offsetWidth;
                return { x: Math.max(0, Math.min(vw - Math.min(w, vw), x)), y: Math.max(0, Math.min(vh - 40, y)) };
            };
            const onDown = (e) => {
                if (e.target.closest('.pokkok-modal-x')) return;
                active = true; moved = false; pid = e.pointerId;
                const r = card.getBoundingClientRect();
                sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            };
            const onMove = (e) => {
                if (!active) return;
                const dx = e.clientX - sx, dy = e.clientY - sy;
                if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                    moved = true;
                    startFixed();
                    try { head.setPointerCapture?.(pid); } catch (_) {}
                }
                if (moved) {
                    if (e.cancelable) e.preventDefault();
                    const p = clamp(sl + dx, st + dy);
                    card.style.left = p.x + 'px'; card.style.top = p.y + 'px';
                    this._pos = p;
                }
            };
            const onUp = () => {
                if (!active) return; active = false;
                try { head.releasePointerCapture?.(pid); } catch (_) {}
                pid = null; setTimeout(() => { moved = false; }, 50);
            };
            head.addEventListener('pointerdown', onDown, { passive: true });
            head.addEventListener('pointermove', onMove, { passive: false });
            head.addEventListener('pointerup', onUp, { passive: false });
            head.addEventListener('pointercancel', onUp, { passive: false });
        }

        hideShell() { if (this.node) this.node.classList.add('pokkok-modal-shell-hidden'); }
        showShell() { if (this.node) this.node.classList.remove('pokkok-modal-shell-hidden'); }

        confirm(title, message, { okText = '확인', cancelText = '취소', danger = false } = {}) {
            return new Promise((resolve) => {
                const body = this.display(title, '', true);
                body.innerHTML = `
                    <div style="line-height:1.5;margin-bottom:14px;white-space:pre-line;">${esc(message)}</div>
                    <div class="pokkok-modal-foot" style="justify-content:flex-end;">
                        <button class="pokkok-btn" data-ref="cancel">${esc(cancelText)}</button>
                        <button class="pokkok-btn ${danger ? 'pokkok-btn-danger' : 'pokkok-btn-primary'}" data-ref="ok">${esc(okText)}</button>
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
            this.node = null; this._card = null; this._pos = null;
            if (this._vv && window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._vv);
                window.visualViewport.removeEventListener('scroll', this._vv);
                this._vv = null;
            }
            if (typeof this._onDismiss === 'function') { try { this._onDismiss(); } catch (_) {} this._onDismiss = null; }
        }
    }

    // ── 셀렉터 엔진 ──────────────────────────────────────────────────────
    class SelectorStrategies {
        static countMatches(sel, root = document) {
            if (!sel) return 0;
            try { return root.querySelectorAll(sel).length; } catch (_) { return 0; }
        }

        static isDynamicClass(cls) {
            if (/^(ember|v-|ng-|re-|css-|sc-|jsx-|emotion-|makeStyles-)/.test(cls)) return true;
            if (/\d{4,}/.test(cls)) return true;
            if (/[a-f0-9]{6,}/i.test(cls)) return true;
            return false;
        }

        static stableAttrFor(cls) {
            let m = cls.match(/^([a-zA-Z][\w-]*?__[\w-]+?)(?:--|-)([\w-]{3,})$/);
            if (m) return `[class*="${m[1]}"]`;
            m = cls.match(/^([a-zA-Z][\w-]*?)(?:--|-)([\w-]{4,})$/);
            if (m && !/^\d+$/.test(m[2])) return `[class^="${m[1]}"]`;
            m = cls.match(/^([a-zA-Z][\w-]*?__)[\w-]{4,}$/);
            if (m) return `[class^="${m[1]}"]`;
            return null;
        }

        static isMeaningfulClass(cls) {
            if (!cls || typeof cls !== 'string') return false;
            if (cls.length < 2 || cls.length > 40) return false;
            if (cls.startsWith('pokkok-')) return false;
            if (cls === HL_CLASS) return false;
            if (this.isDynamicClass(cls)) return false;
            const volatile = ['active','focus','hover','selected','disabled','checked','open','closed','expanded','collapsed','loading','transition','animating','v-enter','v-leave','is-active','is-open'];
            if (volatile.some(v => cls.toLowerCase().includes(v))) return false;
            return true;
        }

        static safeClasses(el) {
            if (!el || !el.classList) return [];
            return Array.from(el.classList).filter(c => !c.startsWith('pokkok-') && c !== HL_CLASS);
        }
        static meaningfulClasses(el) { return this.safeClasses(el).filter(c => this.isMeaningfulClass(c)); }

        static stableAttrs(el) {
            if (!el || !el.classList) return [];
            const out = [];
            for (const c of this.safeClasses(el)) {
                if (this.isMeaningfulClass(c)) continue;
                if (this.isDynamicClass(c)) {
                    const a = this.stableAttrFor(c);
                    if (a && !out.includes(a)) out.push(a);
                }
            }
            return out;
        }

        static _nthIndex(node) {
            const p = node.parentElement;
            if (!p) return 0;
            const same = Array.from(p.children).filter(c => c.tagName === node.tagName);
            return same.length > 1 ? same.indexOf(node) + 1 : 0;
        }

        static _segOf(node, classDepth = 1, useNth = false) {
            if (!node || !node.tagName) return '';
            const t = node.tagName.toLowerCase();
            const cls = this.meaningfulClasses(node);
            let seg = t;
            for (const c of cls.slice(0, classDepth)) seg += `.${CSS.escape(c)}`;
            if (cls.length < classDepth || cls.length === 0) {
                for (const a of this.stableAttrs(node).slice(0, 2)) seg += a;
            }
            if (useNth) {
                const idx = this._nthIndex(node);
                if (idx) seg += `:nth-of-type(${idx})`;
            }
            return seg;
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
            const attrs = this.stableAttrs(el);
            if (attrs.length) return tag + attrs.slice(0, 2).join('');
            const idx = this._nthIndex(el);
            return idx ? `${tag}:nth-of-type(${idx})` : tag;
        }

        static best(el) {
            if (!el || !el.tagName) return null;

            const onlyHits = (sel) => {
                if (!sel || /pokkok-/.test(sel)) return false;
                let nodes;
                try { nodes = document.querySelectorAll(sel); } catch (_) { return false; }
                return nodes.length === 1 && nodes[0] === el;
            };

            const tag = el.tagName.toLowerCase();
            const id = el.id;
            const classes = this.meaningfulClasses(el);
            const attrs = this.stableAttrs(el);

            if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
                const idSel = `#${CSS.escape(id)}`;
                if (onlyHits(idSel)) return idSel;
            }

            for (const attr of ['data-testid','data-cy','data-test','aria-label','name']) {
                const v = el.getAttribute?.(attr);
                if (!v || v.length > 60) continue;
                const a1 = `[${attr}="${CSS.escape(v)}"]`;
                if (onlyHits(a1)) return a1;
                const a2 = `${tag}${a1}`;
                if (onlyHits(a2)) return a2;
            }

            if (classes.length) {
                for (let d = 1; d <= classes.length; d++) {
                    const combo = classes.slice(0, d).map(c => CSS.escape(c)).join('.');
                    const noTag  = '.' + combo;
                    const withTag = `${tag}.${combo}`;
                    if (onlyHits(noTag))  return noTag;
                    if (onlyHits(withTag)) return withTag;
                }
                const allCombo = classes.map(c => CSS.escape(c)).join('.');
                const nthIdx = this._nthIndex(el);
                if (nthIdx) {
                    const c1 = `.${allCombo}:nth-of-type(${nthIdx})`;
                    if (onlyHits(c1)) return c1;
                    const c2 = `${tag}.${allCombo}:nth-of-type(${nthIdx})`;
                    if (onlyHits(c2)) return c2;
                }
            }

            if (attrs.length) {
                const base = classes.length ? `${tag}.${classes.map(c => CSS.escape(c)).join('.')}` : tag;
                for (let d = 1; d <= attrs.length; d++) {
                    const cand = base + attrs.slice(0, d).join('');
                    if (onlyHits(cand)) return cand;
                }
                const nthIdx = this._nthIndex(el);
                if (nthIdx) {
                    const cand = base + attrs.join('') + `:nth-of-type(${nthIdx})`;
                    if (onlyHits(cand)) return cand;
                }
            }

            if (!classes.length && !attrs.length) {
                const tagNth = this._segOf(el, 0, true);
                if (onlyHits(tagNth)) return tagNth;
            }

            const selfSeg = this._segOf(el, classes.length, true);
            const narrowed = this._narrowByPath(el, selfSeg, onlyHits);
            if (narrowed) return narrowed;

            const anchor = el.tagName === 'A' ? el : el.closest?.('a');
            if (anchor === el) {
                const href = anchor.getAttribute('href');
                if (href && DUMMY_HREF_VALUES.has(href.trim())) {
                    const hSel = `a[href="${CSS.escape(href)}"]`;
                    if (onlyHits(hSel)) return hSel;
                }
            }

            if (classes.length || attrs.length) return this._segOf(el, classes.length, true);
            return this._simpleSelectorFor(el);
        }

        static _narrowByPath(el, selfSeg, onlyHits) {
            const prefixParts = [];
            let cur = el.parentElement;
            let depth = 0;

            while (cur && cur !== document.body && cur !== document.documentElement && depth < 10) {
                if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id) &&
                    this.countMatches(`#${CSS.escape(cur.id)}`) === 1) {
                    const idSel = `#${CSS.escape(cur.id)}`;
                    const tail = [...prefixParts, selfSeg].join(' > ');
                    for (const comb of [' > ', ' ']) {
                        const cand = `${idSel}${comb}${tail}`;
                        if (onlyHits(cand)) return cand;
                    }
                }

                const parentClassCount = this.meaningfulClasses(cur).length;
                const variants = [];
                for (let d = 1; d <= Math.max(parentClassCount, 1); d++) {
                    variants.push(this._segOf(cur, d, false));
                }
                variants.push(this._segOf(cur, parentClassCount, true));

                for (const pSeg of variants) {
                    const tail = [pSeg, ...prefixParts, selfSeg];
                    const childPath = tail.join(' > ');
                    if (onlyHits(childPath)) return childPath;
                }

                prefixParts.unshift(this._segOf(cur, parentClassCount, true));
                cur = cur.parentElement;
                depth++;
            }
            return null;
        }

        // ── 유사 찾기용 헬퍼 ───────────────────────────────────────────
        static urlParts(url) {
            const parts = [];
            try {
                const u = new URL(url, location.href);
                if (u.hostname) parts.push(u.hostname);
                u.pathname.split('/').filter(s => s.length >= 3 && !/^\d+$/.test(s))
                    .forEach(s => parts.push('/' + s + '/'));
            } catch (_) {
                const clean = String(url || '').trim();
                if (clean.length >= 4 && clean.length <= 80) parts.push(clean);
            }
            return parts.slice(0, 5);
        }

        // 자유 텍스트 속성값 → 의미 있는 단어 토막 (불용어 최소 필터)
        static textTokens(v) {
            return String(v || '')
                .split(/[\s,_\-/|·:;.()[\]{}'"]+/)
                .map(s => s.trim())
                .filter(s => s.length >= 2 && s.length <= 24 && !/^\d+$/.test(s))
                .slice(0, 6);
        }

        static similarOptions(el) {
            if (!el || !el.tagName) return [];
            const tag = el.tagName.toLowerCase();
            const opts = [];
            const seen = new Set();
            const push = (o) => {
                const key = o.sel ? 's:' + o.sel : 'd:' + o.dim;
                if (seen.has(key)) return;
                seen.add(key);
                opts.push(o);
            };

            for (const c of this.meaningfulClasses(el)) {
                const sel = `.${CSS.escape(c)}`;
                push({ label: `class · .${c}`, sel, count: this.countMatches(sel) });
            }
            for (const a of this.stableAttrs(el)) {
                push({ label: `class⊃ · ${a}`, sel: a, count: this.countMatches(a) });
            }
            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
                const sel = `#${CSS.escape(el.id)}`;
                push({ label: `id · #${el.id}`, sel, count: this.countMatches(sel) });
            }
            // URL성 속성: 토막 부분매칭
            for (const attr of ['src', 'href', 'data-src', 'data-original', 'poster']) {
                const v = el.getAttribute?.(attr);
                if (!v) continue;
                for (const part of this.urlParts(v)) {
                    const sel = `${tag}[${attr}*="${CSS.escape(part)}"]`;
                    push({ label: `${attr} ⊃ "${part}"`, sel, count: this.countMatches(sel) });
                }
            }
            // 값이 한정적인 탐지 속성: 값 전체 부분매칭
            for (const attr of ['target', 'role', 'type', 'rel']) {
                const v = el.getAttribute?.(attr);
                if (!v) continue;
                const val = v.trim();
                if (!val || val.length > 40) continue;
                const sel = `${tag}[${attr}*="${CSS.escape(val)}"]`;
                push({ label: `${attr} ⊃ "${val}"`, sel, count: this.countMatches(sel) });
            }
            // 자유 텍스트 탐지 속성: 단어 토막마다 부분매칭
            for (const attr of ['alt', 'aria-label', 'title', 'placeholder', 'name']) {
                const v = el.getAttribute?.(attr);
                if (!v) continue;
                for (const tok of this.textTokens(v)) {
                    const sel = `${tag}[${attr}*="${CSS.escape(tok)}"]`;
                    push({ label: `${attr} ⊃ "${tok}"`, sel, count: this.countMatches(sel) });
                }
            }
            const st = el.getAttribute?.('style') || '';
            if (st.trim() && st.trim().length <= 120) {
                const sel = `[style*="${CSS.escape(st.trim())}"]`;
                push({ label: `style 동일`, sel, count: this.countMatches(sel) });
            }
            if (st) {
                const m = st.match(/(?:min-|max-)?(?:width|height)\s*:\s*[^;]+/gi) || [];
                for (let decl of m) {
                    decl = decl.replace(/\s+/g, '').trim();
                    if (decl.length < 5) continue;
                    const sel = `${tag}[style*="${CSS.escape(decl)}"]`;
                    push({ label: `style ⊃ "${decl}"`, sel, count: this.countMatches(sel) });
                }
            }
            if (st) {
                const bg = st.match(/background(?:-image)?\s*:\s*[^;]*url\((['"]?)([^'")]+)\1\)/i);
                if (bg && bg[2]) {
                    for (const part of this.urlParts(bg[2])) {
                        const sel = `${tag}[style*="${CSS.escape(part)}"]`;
                        push({ label: `bg-img ⊃ "${part}"`, sel, count: this.countMatches(sel) });
                    }
                }
            }
            const r = el.getBoundingClientRect();
            const w = Math.round(r.width), h = Math.round(r.height);
            if (h >= 8) push({ label: `높이 ≈ ${h}px`, dim: 'h', count: this.findByDimension(el, 'h').length });
            if (w >= 8) push({ label: `너비 ≈ ${w}px`, dim: 'w', count: this.findByDimension(el, 'w').length });
            if (w >= 8 && h >= 8) push({ label: `크기 ≈ ${w}×${h}`, dim: 'wh', count: this.findByDimension(el, 'wh').length });

            return opts;
        }

        static findByDimension(ref, mode, tol = 0.12) {
            if (!ref) return [];
            const r = ref.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return [];
            const hits = [];
            let scanned = 0;
            const all = document.body ? document.body.querySelectorAll('*') : [];
            for (const el of all) {
                if (++scanned > 6000) break;
                if (el.id === ROOT_ID || el.id === SHIELD_ID) continue;
                if (el.closest && (el.closest(`#${ROOT_ID}`) || el.closest(`#${SHIELD_ID}`))) continue;
                const b = el.getBoundingClientRect();
                if (b.width < 8 || b.height < 8) continue;
                const dw = Math.abs(b.width - r.width) / r.width;
                const dh = Math.abs(b.height - r.height) / r.height;
                const ok = mode === 'h' ? dh <= tol
                         : mode === 'w' ? dw <= tol
                         : (dw <= tol && dh <= tol);
                if (ok) hits.push(el);
            }
            return hits;
        }

        static resolveSimilar(opt, ref) {
            if (!opt) return [];
            if (opt.dim) return this.findByDimension(ref, opt.dim);
            try {
                return Array.from(document.querySelectorAll(opt.sel))
                    .filter(n => n.id !== ROOT_ID && !(n.closest && (n.closest(`#${ROOT_ID}`) || n.closest(`#${SHIELD_ID}`))));
            } catch (_) { return []; }
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
                _wasFullBeforePick: false,
                simSelected: new Set(), simNodes: [], simOpt: null,
                simPreviewBar: null, simPreviewNodes: []
            };
            this.modal = null;
            this._onResize = null;
            this._frozenFrames = null;
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
            host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
            document.documentElement.appendChild(host);
            const shadow = host.attachShadow({ mode: 'open' });
            this.dom.host = host; this.dom.shadow = shadow;

            const tool = document.createElement('div');
            tool.id = TOOL_ID;
            tool.className = 'pokkok-tool pokkok-icon';
            shadow.appendChild(tool);
            this.dom.tool = tool;

            const style = document.createElement('style');
            style.textContent = POKKOK_CSS;
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
                tool.className = 'pokkok-tool pokkok-icon';
                tool.innerHTML = `<button class="pokkok-icon-btn" data-act="cycleSize" title="Pokkok 열기" aria-label="Pokkok 열기">${ICON_TARGET}</button>`;
                this.attachRefs();
                return;
            }
            tool.className = 'pokkok-tool pokkok-panel';
            tool.innerHTML = this.getLayout();
            this.attachRefs();
            this.refreshRec();
        }

        getLayout() {
            const enabled = Blocker.isEnabled();
            const stats = Blocker.getStats();
            return `
            <div class="pokkok-head" data-drag="1">
                <span class="pokkok-title">Pokkok <small>v1.1.0</small></span>
                <div class="pokkok-head-btns">
                    <button class="pokkok-btn pokkok-btn-icon" data-act="rules" title="이 사이트 규칙">📋</button>
                    <button class="pokkok-btn pokkok-btn-icon" data-act="settings" title="설정">${ICON_SET}</button>
                    <button class="pokkok-btn pokkok-btn-icon" data-act="cycleSize" title="아이콘으로 접기">${ICON_MIN}</button>
                </div>
            </div>
            <div class="pokkok-body">
                <button class="pokkok-btn pokkok-btn-primary pokkok-pick" data-act="startPick">
                    ${ICON_TARGET}<span>요소 선택</span>
                </button>

                <div class="pokkok-rec" data-ref="rec">
                    <div class="pokkok-rec-empty">요소를 선택하면 여기에 표시됩니다</div>
                </div>

                <div class="pokkok-nav">
                    <button class="pokkok-btn pokkok-nav-btn" data-act="navUp" title="더 크게 (부모)">
                        ${ICON_UP}<span>더 크게</span>
                    </button>
                    <button class="pokkok-btn pokkok-nav-btn" data-act="navDown" title="더 작게 (자식)">
                        ${ICON_DOWN}<span>더 작게</span>
                    </button>
                </div>

                <button class="pokkok-btn pokkok-similar" data-act="findSimilar" data-ref="simBtn" title="비슷한 속성·치수를 가진 요소 찾기">
                    ${ICON_SIMILAR}<span>유사 요소 찾기</span>
                </button>

                <div class="pokkok-act">
                    <button class="pokkok-btn" data-act="toggleHide" data-ref="hideBtn" title="페이지에서 임시로 숨겨 미리보기">
                        ${ICON_EYE}<span data-ref="hideLbl">숨김 미리보기</span>
                    </button>
                    <button class="pokkok-btn pokkok-btn-danger pokkok-block" data-act="block" title="차단">
                        ${ICON_BLOCK}<span>차단</span>
                    </button>
                </div>

                <label class="pokkok-toggle">
                    <input type="checkbox" data-act="toggleEnabled" ${enabled ? 'checked' : ''}>
                    <span>차단 활성</span>
                    <span class="pokkok-stat">이 사이트 ${stats.ruleCount}개</span>
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
                rec.innerHTML = '<div class="pokkok-rec-empty">요소를 선택하면 여기에 표시됩니다</div>';
                this._setActionsEnabled(false);
                return;
            }
            const n = SelectorStrategies.countMatches(sel);
            const tag = this.state.target ? this.state.target.tagName.toLowerCase() : '';
            rec.innerHTML = `
                <div class="pokkok-rec-head">
                    <span class="pokkok-rec-tag">${esc(tag)}</span>
                    <span class="pokkok-rec-count">${n}개 일치</span>
                    <button class="pokkok-btn pokkok-btn-icon" data-act="copy" title="필터 복사(도메인##셀렉터)">${ICON_COPY}</button>
                    <button class="pokkok-btn pokkok-btn-icon" data-act="edit" title="직접 편집">✎</button>
                </div>
                <div class="pokkok-rec-sel" title="${esc(sel)}">${esc(sel)}</div>`;
            rec.querySelectorAll('[data-act]').forEach(el => {
                el.addEventListener('click', (e) => { e.stopPropagation(); this.trigger(el.getAttribute('data-act'), el, e); });
            });
            this._setActionsEnabled(true);
            this._syncHideLabel();
        }

        _setActionsEnabled(on) {
            const t = this.dom.tool;
            if (!t) return;
            ['block','toggleHide','navUp','navDown','findSimilar'].forEach(a => {
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
            if (btn) btn.classList.toggle('pokkok-btn-active', !!hiding);
            if (lbl) lbl.textContent = hiding ? '숨김 해제' : '숨김 미리보기';
        }

        applyPinned(sel) {
            this.clearPinned();
            if (!sel || this.state.hiddenSelector === sel) return;
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) { return; }
            for (const n of nodes) { if (n.closest && n.closest(`#${ROOT_ID}`)) continue; n.classList.add('pokkok-hl-pinned'); }
            this.state.pinnedNodes = nodes;
        }
        clearPinned() {
            for (const n of this.state.pinnedNodes) n.classList.remove('pokkok-hl-pinned');
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

        selectNode(el) {
            if (!el || !el.tagName) return;
            this.clearHide();
            this.clearPinned();
            this.clearSimHighlight();
            this.state.target = el;
            this.state.selector = SelectorStrategies.best(el) || '';
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
                    p.classList.add('pokkok-hl-parent'); tracked.push(p);
                }
            }
            this.state.previewNodes = tracked;
        }
        dropFocus() {
            for (const n of this.state.previewNodes) { n.classList.remove(HL_CLASS); n.classList.remove('pokkok-hl-parent'); }
            this.state.previewNodes = [];
        }

        clearSimHighlight() {
            for (const n of this.state.simNodes) n.classList.remove('pokkok-hl-sim');
            this.state.simNodes = [];
            this.state.simSelected = new Set();
            this.state.simOpt = null;
            this._clearSimPreview();
        }

        _clearSimPreview() {
            for (const n of this.state.simPreviewNodes) n.classList.remove(HIDE_CLASS);
            this.state.simPreviewNodes = [];
            if (this.state.simPreviewBar) { this.state.simPreviewBar.remove(); this.state.simPreviewBar = null; }
        }

        findSimilar() {
            const ref = this.state.target;
            if (!ref) { this.flashToast('먼저 요소를 선택하세요'); return; }
            this._clearSimPreview();
            const opts = SelectorStrategies.similarOptions(ref);
            this._renderSimOptions(ref, opts);
        }

        _renderSimOptions(ref, opts) {
            const body = this.modal.display('유사 요소 찾기', '', true);
            const rows = opts.length ? opts.map((o, i) => `
                <button class="pokkok-sim-opt" data-i="${i}">
                    <span class="pokkok-sim-lbl">${esc(o.label)}</span>
                    <span class="pokkok-sim-cnt">${o.count}개</span>
                </button>`).join('') : '<div class="pokkok-rec-empty">사용할 수 있는 공통 속성이 없습니다</div>';
            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:8px;line-height:1.5">
                    선택한 요소(<code>${esc(ref.tagName.toLowerCase())}</code>)와 공통점이 있는 요소들을 찾습니다.
                    기준을 누르면 후보가 열립니다. 목록이 길면 스크롤하세요. 치수 기준은 화면에 보이는 크기로 매칭합니다.
                </div>
                <div class="pokkok-sim-opts">${rows}</div>`;
            body.querySelectorAll('.pokkok-sim-opt').forEach(b => {
                b.addEventListener('click', () => {
                    const opt = opts[parseInt(b.dataset.i, 10)];
                    const nodes = SelectorStrategies.resolveSimilar(opt, ref);
                    this._renderSimCandidates(ref, opt, nodes);
                });
            });
        }

        _renderSimCandidates(ref, opt, nodes) {
            this._clearSimPreview();
            for (const n of this.state.simNodes) n.classList.remove('pokkok-hl-sim');
            nodes.forEach((n, i) => { n.classList.add('pokkok-hl-sim'); n.dataset.pokkokSim = i; });
            this.state.simNodes = nodes;
            this.state.simSelected = new Set(nodes.map((_, i) => i));
            this.state.simOpt = opt;

            const saveHint = opt.sel
                ? '전체를 그대로 두면 공통 셀렉터 1개로 저장됩니다(가볍고 self-healing). 일부만 체크하면 그것들만 개별 저장됩니다.'
                : '치수 기준은 CSS로 표현할 수 없어 선택한 요소마다 개별 셀렉터로 저장됩니다.';

            const body = this.modal.display(`후보 ${nodes.length}개`, '', true);
            const itemHtml = nodes.length ? nodes.map((n, i) => {
                const tag = n.tagName.toLowerCase();
                const cls = SelectorStrategies.meaningfulClasses(n).slice(0, 2).map(c => '.' + c).join('');
                const txt = (n.textContent || '').trim().slice(0, 28);
                return `
                <label class="pokkok-sim-item">
                    <input type="checkbox" data-i="${i}" checked>
                    <code>${esc(tag + cls)}</code>
                    <span class="pokkok-sim-txt">${esc(txt)}</span>
                </label>`;
            }).join('') : '<div class="pokkok-rec-empty">일치하는 요소가 없습니다</div>';

            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:6px;line-height:1.5">
                    기준: <code>${esc(opt.label)}</code><br>${esc(saveHint)}
                </div>
                <div class="pokkok-sim-list">${itemHtml}</div>
                <div class="pokkok-modal-foot">
                    <button class="pokkok-btn" data-ref="all">전체 선택</button>
                    <button class="pokkok-btn" data-ref="none">전체 해제</button>
                    <button class="pokkok-btn" data-ref="back">← 기준</button>
                    <button class="pokkok-btn pokkok-btn-primary" data-ref="preview">👁 숨겨서 미리보기</button>
                    <button class="pokkok-btn pokkok-btn-danger" data-ref="blockAll">선택 차단</button>
                </div>`;

            const list = body.querySelector('.pokkok-sim-list');
            const updateSel = () => {
                this.state.simSelected = new Set(
                    Array.from(list.querySelectorAll('input:checked')).map(c => parseInt(c.dataset.i, 10))
                );
            };
            list.querySelectorAll('.pokkok-sim-item').forEach(item => {
                const cb = item.querySelector('input');
                const idx = parseInt(cb.dataset.i, 10);
                item.addEventListener('click', (e) => {
                    if (e.target !== cb) cb.checked = !cb.checked;
                    updateSel();
                    const node = nodes[idx];
                    if (node) {
                        node.classList.add('pokkok-hl-sim-focus');
                        node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                        setTimeout(() => node.classList.remove('pokkok-hl-sim-focus'), 1200);
                    }
                });
            });

            body.querySelector('[data-ref="all"]')?.addEventListener('click', () => {
                list.querySelectorAll('input').forEach(c => c.checked = true); updateSel();
            });
            body.querySelector('[data-ref="none"]')?.addEventListener('click', () => {
                list.querySelectorAll('input').forEach(c => c.checked = false); updateSel();
            });
            body.querySelector('[data-ref="back"]')?.addEventListener('click', () => {
                this.findSimilar();
            });
            body.querySelector('[data-ref="preview"]')?.addEventListener('click', () => {
                this._startSimPreview(opt, nodes);
            });
            body.querySelector('[data-ref="blockAll"]')?.addEventListener('click', () => {
                this._blockSimilarSelected(opt, nodes);
            });
        }

        _startSimPreview(opt, nodes) {
            const picked = Array.from(this.state.simSelected).map(i => nodes[i]).filter(Boolean);
            if (!picked.length) { this.flashToast('선택된 요소가 없습니다'); return; }

            this._clearSimPreview();
            const applied = [];
            for (const n of picked) {
                if (n.closest && n.closest(`#${ROOT_ID}`)) continue;
                n.classList.add(HIDE_CLASS);
                applied.push(n);
            }
            this.state.simPreviewNodes = applied;
            this.modal.hideShell();

            const bar = document.createElement('div');
            bar.className = 'pokkok-sim-prevbar';
            bar.innerHTML = `
                <div class="pokkok-sim-prevbar-msg">${applied.length}개를 숨긴 미리보기 — 실제 차단과 동일한 화면입니다</div>
                <div class="pokkok-sim-prevbar-btns">
                    <button class="pokkok-btn" data-ref="restore">${ICON_EYE}<span>복원</span></button>
                    <button class="pokkok-btn pokkok-btn-danger" data-ref="commit">${ICON_BLOCK}<span>이대로 차단</span></button>
                </div>`;
            this.dom.shadow.appendChild(bar);
            this.state.simPreviewBar = bar;

            bar.querySelector('[data-ref="restore"]').addEventListener('click', () => {
                this._clearSimPreview();
                this.modal.showShell();
            });
            bar.querySelector('[data-ref="commit"]').addEventListener('click', () => {
                this._clearSimPreview();
                this.modal.showShell();
                this._blockSimilarSelected(opt, nodes);
            });
            vibrate(10);
        }

        async _blockSimilarSelected(opt, nodes) {
            const picked = Array.from(this.state.simSelected).map(i => nodes[i]).filter(Boolean);
            if (!picked.length) { this.flashToast('선택된 요소가 없습니다'); return; }

            let sels = [];
            let common = false;

            if (opt.sel && picked.length === nodes.length && nodes.length > 0) {
                sels = [opt.sel];
                common = true;
            } else {
                for (const n of picked) {
                    const s = SelectorStrategies.best(n);
                    if (s && !sels.includes(s)) sels.push(s);
                }
            }

            if (!sels.length) { this.flashToast('셀렉터를 만들지 못했습니다'); return; }

            const unsafe = sels.filter(s => isUnsafeSelector(s));
            if (unsafe.length) {
                const ok = await this.modal.confirm('광범위한 셀렉터 경고',
                    `다음 셀렉터가 매우 넓은 범위를 숨길 수 있습니다.\n\n${unsafe.slice(0,3).join('\n')}\n\n그래도 차단할까요?`,
                    { okText: '차단 강행', cancelText: '취소', danger: true });
                if (!ok) return;
            }

            const added = Blocker.appendMany(sels);
            this.clearSimHighlight();
            vibrate(25);
            this.flashToast(common
                ? `공통 규칙 1개 추가 (${picked.length}개 매칭)`
                : `${added}개 규칙 추가 (요소 ${picked.length}개)`);
            this.render();
            this.modal.dismiss();
        }

        _freezeFrames() {
            this._frozenFrames = [];
            document.querySelectorAll('iframe, frame').forEach(f => {
                if (f.id === ROOT_ID || (f.closest && f.closest(`#${ROOT_ID}`))) return;
                this._frozenFrames.push([f, f.style.getPropertyValue('pointer-events'), f.style.getPropertyPriority('pointer-events')]);
                f.style.setProperty('pointer-events', 'none', 'important');
            });
        }
        _unfreezeFrames() {
            if (!this._frozenFrames) return;
            for (const [f, prev, prio] of this._frozenFrames) {
                f.style.removeProperty('pointer-events');
                if (prev) f.style.setProperty('pointer-events', prev, prio || '');
            }
            this._frozenFrames = null;
        }
        _frameAtPoint(x, y) {
            let best = null, bestArea = Infinity;
            document.querySelectorAll('iframe, frame, embed, object').forEach(f => {
                if (f.id === ROOT_ID || (f.closest && f.closest(`#${ROOT_ID}`))) return;
                const r = f.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) return;
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                    const area = r.width * r.height;
                    if (area < bestArea) { bestArea = area; best = f; }
                }
            });
            return best;
        }

        startPicking() {
            if (this.state.picking) return;
            this.clearHide();
            this.clearSimHighlight();
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

            this._freezeFrames();

            const aim = document.createElement('div');
            aim.className = 'pokkok-aim';
            aim.style.cssText = `position:absolute!important;width:0!important;height:0!important;pointer-events:none!important;z-index:2147483646!important;left:-100px!important;top:-100px!important;display:${IS_TOUCH ? 'block' : 'none'}!important;`;
            aim.innerHTML = `<div style="position:absolute;left:-16px;top:-16px;width:32px;height:32px;border:2px solid #ef4444;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,0.6),inset 0 0 0 1px rgba(255,255,255,0.4);"><div style="position:absolute;left:50%;top:-8px;width:2px;height:8px;background:#ef4444;transform:translateX(-50%);"></div><div style="position:absolute;left:-8px;top:50%;width:8px;height:2px;background:#ef4444;transform:translateY(-50%);"></div></div>`;
            shield.appendChild(aim);
            this.dom.shieldAim = aim;

            if (IS_TOUCH) {
                const confirm = document.createElement('div');
                confirm.className = 'pokkok-shield-confirm';
                confirm.style.cssText = 'position:fixed!important;bottom:16px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(17,24,39,0.98)!important;border:1px solid rgba(255,255,255,0.15)!important;border-radius:12px!important;padding:12px 14px!important;z-index:2147483647!important;max-width:calc(100vw - 24px)!important;width:360px!important;box-shadow:0 8px 24px rgba(0,0,0,0.6)!important;touch-action:manipulation!important;font-family:-apple-system,BlinkMacSystemFont,sans-serif!important;color:#e8eaed!important;box-sizing:border-box!important;';
                confirm.innerHTML = `
                    <div class="pokkok-shield-msg" style="font-size:12px;color:#e8eaed;margin-bottom:8px;word-break:break-all;line-height:1.4;text-align:center;">손가락으로 요소를 가리키세요 (조준점이 위쪽에 표시됩니다)</div>
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

                const frame = this._frameAtPoint(ax, ay);
                if (frame) {
                    if (!el || el === document.body || el.contains(frame)) el = frame;
                }
                if (!el) return null;
                return this.refineAtPoint(el, ax, ay);
            };

            this._shieldMove = (e) => {
                if (e.target && e.target.closest && e.target.closest('.pokkok-shield-confirm')) return;
                const el = pickAt(e.clientX, e.clientY);
                if (this.dom.shieldAim) { this.dom.shieldAim.style.left = e.clientX + 'px'; this.dom.shieldAim.style.top = (e.clientY + SHIELD_AIM_OFFSET_Y) + 'px'; }
                if (!el || this.state.lastHoverEl === el) return;
                if (this.state.lastHoverEl) this.state.lastHoverEl.classList.remove('pokkok-hl-preview');
                el.classList.add('pokkok-hl-preview');
                this.state.lastHoverEl = el; this.state.pickCandidate = el;
                if (this.dom.shieldConfirm) {
                    const btn = this.dom.shieldConfirm.querySelector('[data-shield="confirm"]');
                    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
                    const msg = this.dom.shieldConfirm.querySelector('.pokkok-shield-msg');
                    if (msg) {
                        const id = el.id ? `#${el.id}` : '';
                        const cls = SelectorStrategies.meaningfulClasses(el).slice(0, 2).map(c => '.' + c).join('');
                        msg.innerHTML = `<code style="background:rgba(0,0,0,0.4);color:#9ecbff;padding:3px 6px;border-radius:4px;font-size:11px;">${esc(el.tagName.toLowerCase() + id + cls)}</code>`;
                    }
                }
            };

            this._shieldDown = (e) => {
                if (e.target && e.target.closest && e.target.closest('.pokkok-shield-confirm')) return;
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
            if (this.state.lastHoverEl) { this.state.lastHoverEl.classList.remove('pokkok-hl-preview'); this.state.lastHoverEl = null; }
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
            this._unfreezeFrames();
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
                this.dropFocus(); this.clearPinned(); this.clearHide(); this.clearSimHighlight();
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
                case 'findSimilar': this.findSimilar(); break;
                case 'block': this.doBlock(); break;
                case 'toggleHide': {
                    const sel = this.state.selector;
                    if (!sel) { this.flashToast('선택된 요소가 없습니다'); break; }
                    const r = this.toggleHide(sel);
                    this.flashToast(r.hidden ? `${r.count}개 요소 숨김 (차단 동일 미리보기)` : '숨김 해제됨');
                    this._syncHideLabel();
                    break;
                }
                case 'copy': {
                    if (this.state.selector) {
                        const filter = `${location.hostname}##${this.state.selector}`;
                        this.copyText(filter);
                        this.flashToast('필터 복사됨 (도메인##셀렉터)');
                    }
                    break;
                }
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
                <textarea class="pokkok-modal-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(cur)}</textarea>
                <div class="pokkok-modal-meta" data-ref="prev">일치 0개</div>
                <div class="pokkok-modal-foot">
                    <button class="pokkok-btn" data-ref="apply">적용</button>
                    <button class="pokkok-btn pokkok-btn-danger" data-ref="blk">차단 추가</button>
                </div>`;
            const ta = body.querySelector('textarea');
            const prev = body.querySelector('[data-ref="prev"]');
            const update = () => { const sel = ta.value.trim(); prev.textContent = `일치 ${SelectorStrategies.countMatches(sel)}개`; this.applyPinned(sel); };
            ta.addEventListener('input', update); update();
            body.querySelector('[data-ref="apply"]').addEventListener('click', () => {
                this.state.selector = ta.value.trim();
                this.refreshRec();
                this.applyPinned(this.state.selector);
                this.modal.dismiss();
            });
            body.querySelector('[data-ref="blk"]').addEventListener('click', async () => {
                const v = ta.value.trim(); if (!v) return;
                if (isUnsafeSelector(v)) {
                    const ok = await this.modal.confirm('광범위한 셀렉터 경고', `이 셀렉터는 너무 많은 요소를 숨길 수 있습니다.\n\n${v}\n\n그래도 차단할까요?`, { okText: '차단 강행', cancelText: '취소', danger: true });
                    if (!ok) return;
                }
                this.clearHide();
                this.clearPinned();
                if (Blocker.append(v)) { vibrate(20); this.flashToast('차단 규칙 추가됨'); this.render(); }
                this.modal.dismiss();
            });
        }

        showRules() {
            const rules = Blocker.fetch();
            const body = this.modal.display(`이 사이트 규칙 (${rules.length})`, '', true);
            body.innerHTML = `
                <div class="pokkok-rules-list">
                    ${rules.length ? rules.map((r, i) => `
                        <div class="pokkok-rule-item">
                            <code data-pin="${esc(r)}" title="탭하면 미리보기">${esc(r)}</code>
                            <button class="pokkok-btn pokkok-btn-icon" data-ridx="${i}" title="삭제">${ICON_CLOSE}</button>
                        </div>`).join('') : '<div class="pokkok-rec-empty">등록된 규칙이 없습니다</div>'}
                </div>
                <div class="pokkok-modal-foot">
                    ${rules.length ? '<button class="pokkok-btn pokkok-btn-danger" data-ref="clear">이 사이트 전체 삭제</button>' : ''}
                </div>`;
            body.querySelectorAll('[data-ridx]').forEach(b => b.addEventListener('click', () => { Blocker.drop(rules[parseInt(b.dataset.ridx)]); this.showRules(); this.render(); }));
            body.querySelectorAll('[data-pin]').forEach(c => c.addEventListener('click', () => { this.applyPinned(c.dataset.pin); this.flashToast('미리보기 표시 (초록 외곽선)'); }));
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
            const engine = SUPPORTS_ADOPTED ? 'adoptedStyleSheets (:where)' : '&lt;style&gt; 폴백 (:where)';
            body.innerHTML = `
                <div class="pokkok-settings">
                    <label class="pokkok-toggle" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                        <input type="checkbox" data-ref="agg" ${agg ? 'checked' : ''}>
                        <span>강화 모드 (끈질긴 광고 강제 제거)</span>
                    </label>
                    <div class="pokkok-settings-row"><span>전체 규칙</span><span>${stats.totalRules}개 (이 사이트 ${stats.ruleCount}개)</span></div>
                    <div class="pokkok-settings-row"><span>차단 엔진</span><span style="font-size:11px;opacity:0.7">${engine}</span></div>
                    <div class="pokkok-settings-row"><button class="pokkok-btn" data-ref="resetPos">버튼 위치 초기화</button><button class="pokkok-btn" data-ref="clearPreview">미리보기 정리</button></div>
                    <div class="pokkok-settings-row" style="border-top:1px solid rgba(255,255,255,0.06);"><span style="flex:1;font-weight:600;">규칙 백업</span></div>
                    <div class="pokkok-settings-row"><button class="pokkok-btn" data-ref="exportRules">내보내기</button><button class="pokkok-btn" data-ref="importRules">가져오기</button></div>
                    <div class="pokkok-settings-row" style="border-top:1px solid rgba(255,255,255,0.06);"><small style="opacity:0.6;line-height:1.5">요소 선택 → 더 크게/작게로 범위 조절 → 차단. "유사 요소 찾기"로 class·src·alt·title·치수 등 다양한 기준의 후보를 찾고, "숨겨서 미리보기"로 실제 차단과 동일한 화면을 확인할 수 있습니다(전체 선택 시 공통 셀렉터 1개로 저장). 기준 목록이 길면 스크롤하세요. iframe 광고는 iframe 박스 자체를 선택해 차단하세요. 차단은 :where()로 명시도 0 규칙을 적용해 사이트 스타일과 충돌이 적고, SPA에서 다시 나타나는 요소도 자동 재차단됩니다.</small></div>
                </div>`;
            body.querySelector('[data-ref="agg"]').addEventListener('change', () => Blocker.toggleAggressive());
            body.querySelector('[data-ref="resetPos"]').addEventListener('click', () => { this.state.iconPos = null; this.state.panelPos = null; this.applyPosition(); this.flashToast('위치 초기화됨'); });
            body.querySelector('[data-ref="clearPreview"]').addEventListener('click', () => { this.clearPinned(); this.clearHide(); this.clearSimHighlight(); this.flashToast('미리보기 정리됨'); this._syncHideLabel(); });
            body.querySelector('[data-ref="exportRules"]').addEventListener('click', () => this.exportRules());
            body.querySelector('[data-ref="importRules"]').addEventListener('click', () => this.importRules());
        }

        exportRules() {
            const json = JSON.stringify(Blocker.fetchAll(), null, 2);
            const body = this.modal.display('규칙 내보내기', '', true);
            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:6px">아래 텍스트를 복사해 백업하세요. 다른 기기에서 "가져오기"로 복원할 수 있습니다.</div>
                <textarea class="pokkok-modal-input" rows="8" readonly>${esc(json)}</textarea>
                <div class="pokkok-modal-foot"><button class="pokkok-btn pokkok-btn-primary" data-ref="cp">전체 복사</button></div>`;
            const ta = body.querySelector('textarea');
            body.querySelector('[data-ref="cp"]').addEventListener('click', () => { this.copyText(ta.value); this.flashToast('복사됨'); });
            ta.focus(); ta.select();
        }

        importRules() {
            const body = this.modal.display('규칙 가져오기', '', true);
            body.innerHTML = `
                <div style="opacity:.75;font-size:12px;margin-bottom:6px">백업한 JSON을 붙여넣으세요. 기존 규칙을 모두 덮어씁니다.</div>
                <textarea class="pokkok-modal-input" rows="8" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder='{"example.com":["a.ad"]}'></textarea>
                <div class="pokkok-modal-foot"><button class="pokkok-btn pokkok-btn-danger" data-ref="imp">덮어쓰기 가져오기</button></div>`;
            const ta = body.querySelector('textarea');
            body.querySelector('[data-ref="imp"]').addEventListener('click', async () => {
                let obj;
                try { obj = JSON.parse(ta.value.trim()); }
                catch (_) { this.flashToast('유효하지 않은 JSON입니다'); return; }
                const ok = await this.modal.confirm('가져오기 확인', '기존 규칙을 모두 덮어씁니다. 계속할까요?', { okText: '덮어쓰기', danger: true });
                if (!ok) return;
                if (Blocker.replaceAll(obj)) { this.flashToast('가져오기 완료'); this.render(); this.modal.dismiss(); }
                else this.flashToast('가져올 수 있는 규칙이 없습니다');
            });
        }

        async copyText(text) {
            try { await navigator.clipboard.writeText(text); }
            catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        }

        flashToast(msg) {
            const t = document.createElement('div');
            t.className = 'pokkok-toast';
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

    const POKKOK_CSS = `
    :host, * { box-sizing: border-box; }
    .pokkok-tool { position: fixed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; color: #e8eaed; z-index: 2147483647; -webkit-tap-highlight-color: transparent; }
    .pokkok-icon { width: 48px; height: 48px; touch-action: none; }
    .pokkok-icon-btn { width: 100%; height: 100%; min-width: 44px; min-height: 44px; border: none; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #1e40af); color: #fff; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; touch-action: none; }
    .pokkok-icon-btn:hover { transform: scale(1.06); }

    .pokkok-panel { width: 320px; max-width: calc(100vw - 16px); background: rgba(28,30,38,0.97); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(8px); overflow: hidden; }
    .pokkok-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(0,0,0,0.25); cursor: grab; user-select: none; touch-action: none; }
    .pokkok-head:active { cursor: grabbing; }
    .pokkok-title { font-weight: 600; font-size: 14px; }
    .pokkok-title small { opacity: 0.5; font-weight: 400; margin-left: 4px; }
    .pokkok-head-btns { display: flex; gap: 4px; }
    .pokkok-body { padding: 12px; }

    .pokkok-btn { display: inline-flex; align-items: center; gap: 5px; padding: 8px 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #e8eaed; border-radius: 7px; cursor: pointer; font-size: 13px; transition: background 0.15s, border-color 0.15s; touch-action: manipulation; }
    .pokkok-btn > * { pointer-events: none; }
    .pokkok-btn:hover { background: rgba(255,255,255,0.15); }
    .pokkok-btn:active { background: rgba(255,255,255,0.22); }
    .pokkok-btn:disabled, .pokkok-btn[disabled] { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
    .pokkok-btn-icon { padding: 7px; min-width: 34px; min-height: 34px; justify-content: center; }
    .pokkok-btn-active { background: linear-gradient(135deg, #8b5cf6, #6d28d9); border-color: transparent; color: #fff; }
    .pokkok-btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); border-color: transparent; color: #fff; justify-content: center; }
    .pokkok-btn-danger { background: linear-gradient(135deg, #ef4444, #b91c1c); border-color: transparent; color: #fff; justify-content: center; }

    .pokkok-pick { width: 100%; min-height: 44px; font-size: 14px; margin-bottom: 10px; }

    .pokkok-rec { background: rgba(0,0,0,0.25); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; min-height: 56px; }
    .pokkok-rec-empty { opacity: 0.4; font-size: 12px; text-align: center; padding: 12px 0; }
    .pokkok-rec-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .pokkok-rec-tag { font-weight: 700; color: #6ee7b7; font-family: ui-monospace, monospace; font-size: 12px; }
    .pokkok-rec-count { font-size: 11px; opacity: 0.6; flex: 1; }
    .pokkok-rec-sel { font-family: ui-monospace, monospace; font-size: 12px; color: #9ecbff; word-break: break-all; line-height: 1.4; user-select: text; -webkit-user-select: text; }

    .pokkok-nav { display: flex; gap: 6px; margin-bottom: 10px; }
    .pokkok-nav-btn { flex: 1; min-height: 42px; justify-content: center; }

    .pokkok-similar { width: 100%; min-height: 42px; justify-content: center; margin-bottom: 10px; background: rgba(139,92,246,0.18); border-color: rgba(139,92,246,0.4); }
    .pokkok-similar:hover { background: rgba(139,92,246,0.3); }

    .pokkok-act { display: flex; gap: 6px; margin-bottom: 10px; }
    .pokkok-act .pokkok-btn { flex: 1; min-height: 44px; }
    .pokkok-block { flex: 1.2 !important; }

    .pokkok-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; min-height: 36px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); }
    .pokkok-toggle input { cursor: pointer; width: 18px; height: 18px; }
    .pokkok-stat { margin-left: auto; opacity: 0.55; font-size: 11px; }

    .pokkok-sim-opts { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding-right: 2px; }
    .pokkok-sim-opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 10px 12px; min-height: 44px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; color: #e8eaed; cursor: pointer; font-size: 13px; text-align: left; flex-shrink: 0; }
    .pokkok-sim-opt:hover { background: rgba(139,92,246,0.22); border-color: rgba(139,92,246,0.4); }
    .pokkok-sim-lbl { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; flex: 1; }
    .pokkok-sim-cnt { font-size: 11px; opacity: 0.7; white-space: nowrap; background: rgba(0,0,0,0.3); padding: 2px 7px; border-radius: 10px; }

    .pokkok-sim-list { max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 4px; }
    .pokkok-sim-item { display: flex; align-items: center; gap: 8px; padding: 8px; min-height: 40px; background: rgba(255,255,255,0.04); border-radius: 6px; cursor: pointer; }
    .pokkok-sim-item:hover { background: rgba(255,255,255,0.08); }
    .pokkok-sim-item input { width: 18px; height: 18px; flex-shrink: 0; }
    .pokkok-sim-item code { font-size: 11px; color: #9ecbff; white-space: nowrap; }
    .pokkok-sim-txt { font-size: 11px; opacity: 0.55; word-break: break-all; flex: 1; }

    .pokkok-sim-prevbar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); width: 360px; max-width: calc(100vw - 24px); background: rgba(17,24,39,0.98); border: 1px solid rgba(139,92,246,0.5); border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 28px rgba(0,0,0,0.6); z-index: 2147483647; box-sizing: border-box; }
    .pokkok-sim-prevbar-msg { font-size: 12px; color: #e8eaed; margin-bottom: 10px; text-align: center; line-height: 1.4; }
    .pokkok-sim-prevbar-btns { display: flex; gap: 8px; }
    .pokkok-sim-prevbar-btns .pokkok-btn { flex: 1; min-height: 44px; justify-content: center; }

    .pokkok-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2147483647; opacity: 0; transition: opacity 0.2s; color: #e8eaed; }
    .pokkok-modal.visible { opacity: 1; }
    .pokkok-modal.pokkok-modal-shell-hidden { opacity: 0 !important; pointer-events: none !important; }
    .pokkok-modal-card { background: #1c1e26; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; max-width: 480px; width: 92%; max-height: 80vh; max-height: 80dvh; overflow: hidden; display: flex; flex-direction: column; }
    .pokkok-modal-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: grab; user-select: none; touch-action: none; }
    .pokkok-modal-head:active { cursor: grabbing; }
    .pokkok-modal-grip { opacity: 0.5; font-size: 14px; line-height: 1; cursor: grab; }
    .pokkok-modal-title { font-weight: 600; flex: 1; }
    .pokkok-modal-x { background: transparent; border: none; color: #e8eaed; cursor: pointer; padding: 8px; min-width: 36px; min-height: 36px; display: flex; align-items: center; justify-content: center; }
    .pokkok-modal-body { padding: 14px; overflow-y: auto; font-size: 13px; flex: 1; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .pokkok-modal-body code { color: #9ecbff; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px; user-select: text; -webkit-user-select: text; }
    .pokkok-modal-input { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #9ecbff; font-family: ui-monospace, monospace; font-size: 14px; padding: 10px; border-radius: 6px; margin: 8px 0; resize: vertical; -webkit-text-fill-color: #9ecbff; user-select: text; -webkit-user-select: text; }
    .pokkok-modal-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    .pokkok-modal-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .pokkok-modal-foot .pokkok-btn { min-height: 38px; }

    .pokkok-rules-list { max-height: 50vh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .pokkok-rule-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; background: rgba(255,255,255,0.04); border-radius: 6px; margin-bottom: 5px; }
    .pokkok-rule-item code { font-size: 11px; color: #9ecbff; word-break: break-all; flex: 1; cursor: pointer; user-select: text; -webkit-user-select: text; }

    .pokkok-settings-row { display: flex; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); flex-wrap: wrap; justify-content: space-between; }
    .pokkok-settings-row:last-child { border-bottom: none; }
    .pokkok-settings-row .pokkok-btn { min-height: 38px; }

    .pokkok-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%) translateY(20px); background: rgba(17,24,39,0.95); color: #fff; padding: 10px 18px; border-radius: 20px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.25s, transform 0.25s; z-index: 2147483647; pointer-events: none; max-width: 90vw; }
    .pokkok-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

    @media (max-width: 600px) {
        .pokkok-panel { width: calc(100vw - 16px); max-width: calc(100vw - 16px); }
        .pokkok-modal-card { width: 95%; max-height: 88vh; max-height: 88dvh; }
        .pokkok-modal-foot .pokkok-btn { flex: 1; min-width: 0; }
    }`;

    // ── 페이지(라이트 DOM) 하이라이트/숨김 스타일 ──────────────────────
    // HIDE_CLASS를 display:none으로 통일 → 미리보기 = 실제 차단 화면
    const PAGE_CSS = `
        .${HL_CLASS} { outline: 2px solid #ef4444 !important; outline-offset: -2px !important; background: rgba(239,68,68,0.08) !important; }
        .pokkok-hl-parent { outline: 2px dashed #f59e0b !important; outline-offset: -2px !important; }
        .pokkok-hl-preview { outline: 2px solid #3b82f6 !important; outline-offset: -2px !important; background: rgba(59,130,246,0.08) !important; }
        .pokkok-hl-pinned { outline: 2px solid #10b981 !important; outline-offset: -2px !important; background: rgba(16,185,129,0.08) !important; }
        .pokkok-hl-sim { outline: 3px solid #a855f7 !important; outline-offset: -3px !important; background: rgba(168,85,247,0.22) !important; box-shadow: 0 0 0 2px rgba(255,255,255,0.4), inset 0 0 0 9999px rgba(168,85,247,0.12) !important; }
        .pokkok-hl-sim-focus { outline: 4px solid #facc15 !important; outline-offset: -4px !important; background: rgba(250,204,21,0.3) !important; }
        .${HIDE_CLASS} { display: none !important; }
    `;

    function injectPageCss() {
        const ID = 'pokkok-page-css';
        let style = document.getElementById(ID);
        if (!style || !style.isConnected) {
            style = document.createElement('style');
            style.id = ID;
            style.textContent = PAGE_CSS;
            (document.head || document.documentElement).appendChild(style);
        }
        return style;
    }

    function watchPageCss() {
        injectPageCss();
        let timer = null;
        const obs = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                const s = document.getElementById('pokkok-page-css');
                if (!s || !s.isConnected || !s.textContent) injectPageCss();
            }, 300);
        });
        if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(() => { const s = document.getElementById('pokkok-page-css'); if (!s || !s.isConnected || !s.textContent) injectPageCss(); }, 5000);
    }

    // ── 부트스트랩 ───────────────────────────────────────────────────────
    let inspector = null;

    function boot() {
        if (window.__pokkokBooted) return;
        window.__pokkokBooted = true;

        injectPageCss();
        watchPageCss();
        Blocker.enforce();

        inspector = new Inspector();
        inspector.launch();

        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('Pokkok 열기/접기', () => inspector && inspector.cycleSize());
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
