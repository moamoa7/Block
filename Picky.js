// ==UserScript==
// @name         Picky Advanced (Enhanced)
// @namespace    https://github.com/hooray804/Picky
// @version      3.3.0
// @description  Web Element Inspector & CSS Selector Tool with Ad Block - Enhanced Edition
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

    // 🔧 FIX #12: Only run on top window (no iframes)
    if (window.self !== window.top) return;

    const TOOL_ID = "picky-tool";
    const ROOT_ID = "picky-root";
    const HL_CLASS = "picky-hl";
    const ISO_BODY = "picky-iso-body";
    const ISO_PATH = "picky-iso-path";
    const SHIELD_ID = "picky-shield";
    const DRAG_THRESHOLD = 14;

    // 🔧 FIX #13: Check :has() support once
    const SUPPORTS_HAS = (() => {
        try { return CSS.supports('selector(:has(*))'); }
        catch(e) { return false; }
    })();

    let touchMoved = false;
    let touchStartTarget = null;

    if (document.getElementById(ROOT_ID)) return;

    // === SVG ICONS ===
    const ICON_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    const ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
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

    // =========================================================
    // BLOCKER CLASS (Enhanced)
    // =========================================================
    class Blocker {
        // 🔧 FIX #7: Run at document-start with MutationObserver fallback
        static init() {
            if (document.head) {
                this.enforce();
            } else {
                const obs = new MutationObserver(() => {
                    if (document.head) {
                        this.enforce();
                        obs.disconnect();
                    }
                });
                obs.observe(document.documentElement, { childList: true });
            }
        }

        static fetch() {
            return GM_getValue("picky_blocked_rules", {})[window.location.hostname] || [];
        }

        static fetchAll() {
            return GM_getValue("picky_blocked_rules", {});
        }

        static append(sel) {
            if (!sel || /[{}]/.test(sel)) return false;
            const all = GM_getValue("picky_blocked_rules", {});
            const host = window.location.hostname;
            if (!all[host]) all[host] = [];
            if (all[host].includes(sel)) return false;
            all[host].push(sel);
            GM_setValue("picky_blocked_rules", all);
            // 🔧 FIX #4: Save history for undo
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

        // 🔧 FIX #4: Undo last block
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

        // 🔧 FIX #6: Toggle on/off without deleting
        static isEnabled() {
            return GM_getValue("picky_blocking_enabled", true);
        }
        static toggleEnabled() {
            const cur = this.isEnabled();
            GM_setValue("picky_blocking_enabled", !cur);
            this.enforce();
            return !cur;
        }

        // 🔧 FIX #14: Aggressive blocking option
        static isAggressive() {
            return GM_getValue("picky_aggressive_block", false);
        }
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
                    style.textContent = rules.join(", ") +
                        " { display: none !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important; padding: 0 !important; margin: 0 !important; visibility: hidden !important; }";
                } else {
                    style.textContent = rules.join(", ") + " { display: none !important; }";
                }
            } else if (style) {
                style.remove();
            }
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
            } else {
                alert("저장된 차단 규칙이 없습니다.");
            }
        }

        // 🔧 FIX #3: Statistics
        static getStats() {
            const rules = this.fetch();
            let hidden = 0;
            rules.forEach(sel => {
                try { hidden += document.querySelectorAll(sel).length; } catch(e) {}
            });
            const all = this.fetchAll();
            let totalSites = Object.keys(all).length;
            let totalRules = 0;
            Object.values(all).forEach(arr => totalRules += arr.length);
            return { ruleCount: rules.length, hiddenCount: hidden, totalSites, totalRules };
        }

        // 🔧 FIX #1: Export to JSON
        static exportJSON() {
            const all = this.fetchAll();
            const data = {
                app: "Picky Advanced",
                version: "3.3.0",
                exportDate: new Date().toISOString(),
                rules: all
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `picky-rules-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }

        // 🔧 FIX #2: Export to uBlock format
        static exportUblock() {
            const all = this.fetchAll();
            let text = "! Picky Advanced Export - " + new Date().toISOString() + "\n";
            text += "! Paste into uBlock Origin: Dashboard > My filters\n\n";
            let count = 0;
            Object.keys(all).forEach(host => {
                all[host].forEach(rule => {
                    text += `${host}##${rule}\n`;
                    count++;
                });
            });
            navigator.clipboard.writeText(text).then(() =>
                alert(`${count}개 규칙(${Object.keys(all).length}개 사이트)을 uBlock 형식으로 클립보드에 복사했어요.`)
            ).catch(() => {
                prompt("복사 실패. 수동으로 복사하세요:", text);
            });
        }

        // 🔧 FIX #1: Import from JSON
        static importJSON() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.txt';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
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
                                    merged[host].push(rule);
                                    added++;
                                }
                            });
                        });
                        GM_setValue("picky_blocked_rules", merged);
                        this.enforce();
                        alert(`가져오기 완료!\n${Object.keys(rules).length}개 사이트, ${added}개 신규 규칙 추가됨.`);
                    } catch (err) {
                        alert("파일 형식 오류: " + err.message);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        }
    }

    Blocker.init();

    // =========================================================
    // MODAL CLASS
    // =========================================================
    class Modal {
        constructor(container) {
            this.container = container;
            this.node = null;
        }
        display(title, body, isHtml = false) {
            this.dismiss();
            const o = document.createElement("div");
            o.className = "picky-modal-overlay";
            o.innerHTML = `<div class="picky-modal-content"><div class="picky-modal-header"><span class="picky-modal-title"></span><button class="picky-icon-button" data-action="closeModal">${ICON_CLOSE}</button></div><div class="picky-modal-body"></div></div>`;
            o.querySelector(".picky-modal-title").textContent = title;
            const b = o.querySelector(".picky-modal-body");
            if (isHtml) {
                b.innerHTML = body;
            } else {
                b.innerHTML = "<textarea readonly></textarea>";
                b.querySelector("textarea").textContent = body;
            }
            this.container.appendChild(o);
            this.node = o;
            this.node.addEventListener("click", e => {
                if (e.target.closest('[data-action="closeModal"]') || e.target === this.node) this.dismiss();
            });
            setTimeout(() => this.node.classList.add("visible"), 10);
        }
        dismiss() {
            if (!this.node) return;
            this.node.classList.remove("visible");
            const n = this.node;
            this.node = null;
            setTimeout(() => n?.remove(), 300);
        }
    }

    // =========================================================
    // INSPECTOR CLASS
    // =========================================================
    class Inspector {
        constructor() {
            this.dom = { host: null, shadow: null, tool: null, shield: null, disp: null, match: null, slider: null };
            this.state = {
                target: null, originTarget: null, hierarchy: [],
                queryData: { selector: "", root: document },
                mode: "initial", scale: "full", isCollapsed: true,
                isObscured: false, isQuarantined: false, obscuredNodes: [],
                displayCache: new WeakMap(), hits: 0,
                autoDismiss: GM_getValue("picky_auto_close", true),
                alignment: GM_getValue("picky_alignment", "bottom"),
                isPro: false,
                hoverPreviewNodes: []  // 🔧 FIX #5
            };
            this.config = {
                useId: true, useClasses: true, classCount: 2, useNthOfType: true,
                intelligentMode: true,
                dynamicPrefixes: /^(ember|v-|re-|ng-)/i,
                volatileClasses: new Set(["active","focus","select","js-","ui-","hover","disabled","checked","selected","--is-","_is-","loading","transition","animating","v-enter","v-leave"]),
                reliableAttrs: ["data-testid","data-cy","data-test-id","data-test","name","aria-label","alt","placeholder","type"],
                maxDepth: 8,
                shadowDomSupport: false
            };
            this.overlay = null;
            this.watcher = null;
        }

        resolveParent(t) {
            if (!t) return null;
            if (!this.config.shadowDomSupport) return t.parentElement;
            if (t.parentElement) return t.parentElement;
            const r = t.getRootNode();
            return r instanceof ShadowRoot ? r.host : null;
        }
        resolveChildren(t) {
            if (!t) return [];
            return this.config.shadowDomSupport && t.shadowRoot
                ? Array.from(t.shadowRoot.children)
                : Array.from(t.children);
        }
        pierceShadow(x, y) {
            let el = document.elementFromPoint(x, y);
            while (el && el.shadowRoot) {
                const next = el.shadowRoot.elementFromPoint(x, y);
                if (!next) break;
                el = next;
            }
            return el;
        }

        evaluateCss(t) {
            const e = this.config;
            if (!t || t.nodeType !== 1) return { selector: "", root: document };
            const reservedClasses = [HL_CLASS, ISO_PATH];
            const rootNode = e.shadowDomSupport ? t.getRootNode() : document;
            const n = rootNode === document ? document : rootNode;

            let idState;
            const id = t.id;
            if (!id || /^\d+$/.test(id) || id.indexOf(":") !== -1) idState = "invalid";
            else if (e.dynamicPrefixes.test(id)) idState = "dynamic";
            else idState = "perfect";

            const tg = t.tagName.toLowerCase();
            const chk = (sel, anyMatch = false) => {
                try {
                    const nds = n.querySelectorAll(sel);
                    return (anyMatch && this.state.isPro)
                        ? (nds.length > 0 && Array.from(nds).includes(t))
                        : (nds.length === 1);
                } catch (err) { return false; }
            };

            if (this.state.isPro) {
                const adk = /(ad|banner|sponsor|pop|notice|promot|slot|wing)/i;
                const jnk = /[_-]?(random|[a-f0-9]{6,}|\d{3,})/i;

                if (["iframe","img","script"].includes(tg)) {
                    const src = t.getAttribute("src");
                    if (src && adk.test(src)) {
                        try {
                            const fn = new URL(src, window.location.href).pathname.split("/").pop();
                            if (fn && fn.length > 3) {
                                const sel = `${tg}[src*="${fn.replace(/"/g, '\\"')}"]`;
                                if (chk(sel, true)) return { selector: sel, root: n };
                            }
                        } catch(err) {}
                    }
                }

                if (id && (idState === "dynamic" || adk.test(id))) {
                    if (jnk.test(id)) {
                        const m = id.match(/^(.*?)(ad|banner|sponsor|pop|notice|promot|slot|wing)[a-z_-]*/i);
                        if (m) {
                            const sel = `${tg}[id^="${m[0].replace(/"/g,'\\"')}"]`;
                            if (chk(sel, true)) return { selector: sel, root: n };
                        }
                    }
                    const m2 = id.match(adk);
                    if (m2) {
                        const sel = `${tg}[id*="${m2[0].replace(/"/g,'\\"')}"]`;
                        if (chk(sel, true)) return { selector: sel, root: n };
                    }
                }

                if (t.className && typeof t.className === "string") {
                    const cls = t.className.trim().split(/\s+/).filter(Boolean);
                    for (const c of cls) {
                        if (adk.test(c)) {
                            if (jnk.test(c)) {
                                const m = c.match(/^(.*?)(ad|banner|sponsor|pop|notice|promot|slot|wing)[a-z_-]*/i);
                                if (m) {
                                    const sel = `${tg}[class*="${m[0].replace(/"/g,'\\"')}"]`;
                                    if (chk(sel, true)) return { selector: sel, root: n };
                                }
                            } else {
                                const sel = `${tg}.${CSS.escape(c)}`;
                                if (chk(sel, true)) return { selector: sel, root: n };
                            }
                        }
                    }
                }

                const sty = t.getAttribute("style");
                if (sty && sty.length > 15 && !sty.includes("picky")) {
                    const cSty = sty.replace(/"/g, '\\"').trim();
                    const sel = `${tg}[style="${cSty}"]`;
                    if (chk(sel, true)) return { selector: sel, root: n };
                }

                let bTg = tg;
                if (e.useClasses && t.className && typeof t.className === "string") {
                    const cl = Array.from(t.classList);
                    for (let c of cl) {
                        let m = c.match(/^([a-zA-Z0-9_-]+)(__|--)([a-zA-Z0-9_-]{3,10})$/);
                        if (m) {
                            bTg += `[class*="${CSS.escape(m[1])}${m[2]}"]`;
                            break;
                        } else if (!reservedClasses.includes(c) && !/\d{4,}/.test(c) && !/[a-f0-9]{6,}/i.test(c)) {
                            let iv = false;
                            for (let vol of e.volatileClasses) {
                                if (c.toLowerCase().includes(vol)) { iv = true; break; }
                            }
                            if (!iv) { bTg += `.${CSS.escape(c)}`; break; }
                        }
                    }
                }

                // 🔧 FIX #13: Only use :has() if supported
                if (SUPPORTS_HAS) {
                    const adLnk = t.querySelector('a[href*="/ad/"],a[href*="/ads/"],a[href*="/click/"],a[href*="sponsor"],a[href*="banner"]');
                    if (adLnk) {
                        let adSel = "a";
                        const hr = adLnk.getAttribute("href");
                        const mh = hr.match(/\/(ads?|click|sponsor|banner)[_/]/i);
                        if (mh) adSel += `[href*="${mh[0]}"]`;
                        else adSel += `[href*="${hr.split("?")[0].substring(0, 20)}"]`;
                        const sH = `${bTg}:has(${adSel})`;
                        if (chk(sH, true)) return { selector: sH, root: n };
                    }
                }
            }

            if (e.useId && idState === "perfect") {
                const eId = CSS.escape(id);
                if (chk(`#${eId}`, true)) return { selector: `#${eId}`, root: n };
            }

            for (let k = 0; k < e.reliableAttrs.length; k++) {
                const oA = e.reliableAttrs[k], sA = t.getAttribute(oA);
                if (sA) {
                    const sel = `[${oA}="${sA.replace(/"/g, '\\"')}"]`;
                    if (chk(sel, true)) return { selector: sel, root: n };
                }
            }

            const cFn = (el, includeVolatile = false) => {
                const s = [];
                let a = el, dp = 0;
                while (a && a.tagName && dp < e.maxDepth && (!e.shadowDomSupport || a !== n)) {
                    const tT = a.tagName.toLowerCase();
                    if (tT === "body" || tT === "html") break;
                    let l = tT;
                    if (e.useClasses) {
                        const cl = Array.from(a.classList), cf = [], at = [];
                        for (let cn of cl) {
                            if (reservedClasses.includes(cn)) continue;
                            if (this.state.isPro) {
                                let m = cn.match(/^([a-zA-Z0-9_-]+)(__|--)([a-zA-Z0-9_-]{3,10})$/);
                                if (m) { at.push(`[class*="${CSS.escape(m[1])}${m[2]}"]`); continue; }
                            }
                            if (!cn || /\d{4,}/.test(cn) || /[a-f0-9]{6,}/i.test(cn)) continue;
                            let isV = false;
                            for (let vol of e.volatileClasses) {
                                if (cn.toLowerCase().includes(vol)) { isV = true; break; }
                            }
                            if (!isV || includeVolatile) cf.push(cn);
                        }
                        const nn = cf.slice(0, e.classCount);
                        if (nn.length > 0) l += "." + nn.map(x => CSS.escape(x)).join(".");
                        if (this.state.isPro && at.length > 0) l += at.join("");
                    }
                    if (e.useNthOfType) {
                        const pr = this.resolveParent(a);
                        if (pr) {
                            const sb = this.resolveChildren(pr).filter(x => x.tagName === a.tagName);
                            if (sb.length > 1) {
                                const nth = sb.indexOf(a) + 1;
                                if (nth > 0) l += `:nth-of-type(${nth})`;
                            }
                        }
                    }
                    s.unshift(l);
                    if (e.intelligentMode) {
                        const cs = s.join(" > ");
                        if (chk(cs, true)) return cs;
                    }
                    a = this.resolveParent(a);
                    dp++;
                }
                return s.join(" > ");
            };

            let d = cFn(t, false);
            if (chk(d, true)) return { selector: d, root: n };

            if (e.intelligentMode) {
                if (e.useId && idState === "dynamic") {
                    const eS = `${tg}#${CSS.escape(id)}`;
                    if (chk(eS, true)) return { selector: eS, root: n };
                }
                let iF = cFn(t, true);
                if (chk(iF, true)) return { selector: iF, root: n };
            }
            return { selector: d || cFn(t, true), root: n };
        }

        refreshMetrics() {
            if (!this.state.target) { this.state.hits = 0; return; }
            this.state.queryData = this.evaluateCss(this.state.target);
            const { selector: sel, root: rt } = this.state.queryData;
            if (sel) {
                try { this.state.hits = rt.querySelectorAll(sel).length; }
                catch (er) { this.state.hits = 0; }
                if (this.dom.match) this.dom.match.textContent = `${this.state.hits}개 일치`;
                if (this.dom.disp) {
                    let txt = sel;
                    if (this.config.shadowDomSupport && rt instanceof ShadowRoot) txt += " (in Shadow DOM)";
                    this.dom.disp.textContent = txt;
                }
            } else this.state.hits = 0;
        }

        fetchStylesheet() {
            return `:host{--pk-pri:#007aff;--pk-on-pri:#fff;--pk-pri-cont:#007aff;--pk-on-pri-cont:#fff;--pk-sec-cont:#e9e9eb;--pk-on-sec-cont:#1d1d1f;--pk-surf-var:#f0f0f2;--pk-on-surf-var:#333;--pk-outl:#d1d1d6;--pk-surf:#f9f9f9;--pk-on-surf:#1d1d1f;--pk-succ:#34c759;--pk-err:#ff3b30;--pk-warn:#ff9500;all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;position:fixed;top:0;left:0;z-index:2147483647;width:0;height:0}
            #${TOOL_ID}{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483646;width:calc(100% - 24px);max-width:400px;background:rgba(248,248,248,.75);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.15);border:1px solid rgba(0,0,0,.1);padding:12px;box-sizing:border-box;transition:transform .4s cubic-bezier(.4,0,.2,1),opacity .4s,top .4s,bottom .4s,width .3s,height .3s,border-radius .3s;user-select:none;-webkit-user-select:none;font-size:14px;color:#000}
            #${TOOL_ID}.top{top:-200%;opacity:0}#${TOOL_ID}.bottom{bottom:-200%;opacity:0}
            #${TOOL_ID}.visible.top{top:12px;opacity:1}#${TOOL_ID}.visible.bottom{bottom:12px;opacity:1}
            #${TOOL_ID} .picky-icon-button{display:flex;align-items:center;justify-content:center;background:0 0;border:none;padding:4px;color:var(--pk-on-surf);cursor:pointer;border-radius:50%;transition:background-color .2s}
            #${TOOL_ID} .picky-icon-button:hover{background-color:rgba(0,0,0,.08)}
            #${TOOL_ID} .picky-icon-button svg{width:24px;height:24px;fill:currentColor!important;display:block}
            #${TOOL_ID} .picky-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;color:var(--pk-on-surf)}
            #${TOOL_ID} .picky-header-title{font-size:16px;font-weight:600}
            #${TOOL_ID} .picky-header-actions{display:flex;gap:8px}
            #${TOOL_ID} .picky-selector-box{background-color:var(--pk-surf-var);padding:8px 12px;border-radius:12px;margin-bottom:12px}
            #${TOOL_ID} .picky-selector-box-title{font-size:11px;color:var(--pk-on-surf-var);margin-bottom:4px;display:flex;justify-content:space-between}
            #${TOOL_ID} .picky-selector-display{font-family:'SF Mono','Menlo',monospace;font-size:12px;color:var(--pk-on-surf);word-break:break-all;max-height:7em;overflow-y:auto;cursor:pointer}
            #${TOOL_ID} .picky-selector-display:hover{background-color:rgba(0,0,0,.04);border-radius:4px}
            #${TOOL_ID} .picky-stats-bar{font-size:11px;color:var(--pk-on-surf-var);padding:4px 8px;background:var(--pk-surf-var);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
            #${TOOL_ID} .picky-stats-bar .pk-stat-val{color:var(--pk-pri);font-weight:600}
            #${TOOL_ID} hr{border:none;border-top:1px solid var(--pk-surf-var);margin:10px 0}
            #${TOOL_ID} button{padding:8px 10px;border:none;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;background-color:var(--pk-sec-cont);color:var(--pk-on-sec-cont);transition:background-color .2s,transform .1s;display:flex;align-items:center;justify-content:center;gap:4px}
            #${TOOL_ID} button:active{transform:scale(.96)}
            #${TOOL_ID} button.primary{background-color:var(--pk-pri-cont);color:var(--pk-on-pri-cont)}
            #${TOOL_ID} button.copied{background-color:var(--pk-succ);color:#fff}
            #${TOOL_ID} button.warn{background-color:var(--pk-warn);color:#fff}
            #${TOOL_ID}.minimized{left:auto;right:20px;transform:none;width:28px;height:28px;border-radius:50%;padding:0;cursor:pointer}
            #${TOOL_ID}.minimized .picky-content{display:none}
            #${TOOL_ID} .picky-maximize-button{display:none}
            #${TOOL_ID}.minimized .picky-maximize-button{display:flex;width:100%;height:100%;align-items:center;justify-content:center}
            #${TOOL_ID}.minimal{padding:6px;height:auto}
            #${TOOL_ID}.minimal .picky-content{display:flex;justify-content:space-around;gap:4px}
            #${TOOL_ID}.minimal button{background:0 0}
            #${TOOL_ID}.minimal button:hover{background-color:rgba(0,0,0,.08)}
            #${SHIELD_ID}{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483645;background:transparent;display:none}
            #${TOOL_ID} .picky-setting-title{font-weight:500;font-size:15px;margin:8px 0 4px;color:var(--pk-on-surf)}
            #${TOOL_ID} .picky-setting-item{display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid var(--pk-surf-var);color:var(--pk-on-surf)}
            #${TOOL_ID} .picky-switch{position:relative;display:inline-block;width:44px;height:24px}
            #${TOOL_ID} .picky-switch input{opacity:0;width:0;height:0}
            #${TOOL_ID} .picky-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:var(--pk-outl);transition:.4s;border-radius:24px}
            #${TOOL_ID} .picky-slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background-color:#fff;transition:.4s;border-radius:50%}
            #${TOOL_ID} input:checked+.picky-slider{background-color:var(--pk-pri)}
            #${TOOL_ID} input:checked+.picky-slider:before{transform:translateX(20px)}
            .picky-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:2147483647;backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);opacity:0;transition:opacity .3s}
            .picky-modal-overlay.visible{opacity:1}
            .picky-modal-content{position:fixed;top:50%;left:50%;width:calc(100% - 32px);max-width:600px;max-height:80vh;background-color:var(--pk-surf);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;opacity:0;transform:translate(-50%,-45%);transition:opacity .3s,transform .3s}
            .picky-modal-overlay.visible .picky-modal-content{opacity:1;transform:translate(-50%,-50%)}
            .picky-modal-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pk-outl);flex-shrink:0}
            .picky-modal-title{font-size:16px;font-weight:600;color:var(--pk-on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .picky-modal-body{padding:4px 12px 12px;overflow-y:auto;color:var(--pk-on-surf)}
            .picky-modal-body textarea{width:100%;height:50vh;background:var(--pk-surf-var);border:none;border-radius:8px;color:var(--pk-on-surf);font-family:'SF Mono',monospace;font-size:12px;padding:8px;box-sizing:border-box;resize:vertical}
            .picky-child-list,.picky-cookie-table{list-style:none;padding:0;margin:0;width:100%;border-collapse:collapse}
            .picky-child-list li{padding:10px;border-bottom:1px solid var(--pk-outl);cursor:pointer;transition:background-color .2s;font-family:'SF Mono',monospace;font-size:12px;color:var(--pk-on-surf-var)}
            .picky-child-list li:hover{background-color:var(--pk-surf-var)}
            .picky-cookie-table th,.picky-cookie-table td{padding:8px;text-align:left;border-bottom:1px solid var(--pk-outl);font-size:12px}
            .picky-cookie-table th{color:var(--pk-on-surf);font-weight:600}
            .picky-cookie-table td{color:var(--pk-on-surf-var);word-break:break-all}
            .picky-cookie-table .cookie-actions{display:flex;gap:8px}
            .picky-cookie-table .cookie-actions button{padding:4px 8px;font-size:11px;border-radius:8px;background:var(--pk-sec-cont);color:var(--pk-on-sec-cont);border:none;cursor:pointer}
            .picky-cookie-table .cookie-actions button.delete{background-color:var(--pk-err);color:#fff}
            #picky-nav-slider-container{padding:8px 0}
            #picky-nav-slider{width:100%;-webkit-appearance:none;appearance:none;background:var(--pk-outl);height:5px;border-radius:3px;outline:none;cursor:pointer}
            #picky-nav-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:22px;height:22px;background:var(--pk-pri);border-radius:50%;cursor:pointer}
            #picky-nav-slider::-moz-range-thumb{width:22px;height:22px;background:var(--pk-pri);border-radius:50%;cursor:pointer}
            .picky-code-tabs{display:flex;border-bottom:1px solid var(--pk-outl);margin-bottom:12px}
            .picky-code-tab{padding:8px 16px;cursor:pointer;color:var(--pk-on-surf-var);border-bottom:2px solid transparent}
            .picky-code-tab.active{color:var(--pk-pri);border-bottom-color:var(--pk-pri)}
            .picky-code-panel{display:none}
            .picky-code-panel.active{display:block}
            .picky-code-panel pre{white-space:pre-wrap;word-break:break-all;font-family:'SF Mono',monospace;font-size:12px;padding:8px;background:var(--pk-surf-var);border-radius:8px;max-height:50vh;overflow:auto}
            .picky-ad-suggest-item{display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--pk-outl);cursor:pointer}
            .picky-ad-suggest-item:hover{background:var(--pk-surf-var)}
            .picky-ad-suggest-item input[type=checkbox]{transform:scale(1.3)}
            .picky-ad-suggest-score{background:var(--pk-warn);color:#fff;padding:2px 6px;border-radius:8px;font-size:11px;font-weight:600;min-width:24px;text-align:center}
            .picky-rule-preview-hover{outline:3px solid orange!important;outline-offset:2px!important;background:rgba(255,165,0,.1)!important}`;
        }

        embedGlobalCSS() {
            const e = `.${HL_CLASS}{outline:2px dotted #ff453a!important;outline-offset:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.4)!important;transition:outline .1s,box-shadow .1s}
            html.${ISO_BODY} > body{visibility:hidden!important}
            html.${ISO_BODY} .${ISO_PATH}{visibility:visible!important}
            html.${ISO_BODY} .${ISO_PATH} *{visibility:visible!important}`;
            const a = document.createElement("style");
            a.id = `${TOOL_ID}-global-style`;
            a.textContent = e;
            (document.head || document.documentElement).appendChild(a);
        }

        embedShadowCSS() {
            const e = `.${HL_CLASS}{outline:2px dotted #ff453a!important;outline-offset:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.4)!important}`;
            document.querySelectorAll("*").forEach(el => {
                if (el.shadowRoot && !el.shadowRoot.getElementById(`${TOOL_ID}-hl-style`)) {
                    const o = document.createElement("style");
                    o.id = `${TOOL_ID}-hl-style`;
                    o.textContent = e;
                    el.shadowRoot.appendChild(o);
                }
            });
        }

        constructUI() {
            this.embedGlobalCSS();
            let h = document.getElementById(ROOT_ID);
            if (!h) {
                h = document.createElement("div");
                h.id = ROOT_ID;
                document.documentElement.appendChild(h);
            }
            this.dom.host = h;
            const sh = h.attachShadow({ mode: "open" });
            this.dom.shadow = sh;
            this.overlay = new Modal(sh);
            const s = document.createElement("style");
            s.textContent = this.fetchStylesheet();
            sh.appendChild(s);
            this.dom.tool = document.createElement("div");
            this.dom.tool.id = TOOL_ID;
            this.dom.tool.className = this.state.alignment;
            sh.appendChild(this.dom.tool);
            this.dom.shield = document.createElement("div");
            this.dom.shield.id = SHIELD_ID;
            sh.appendChild(this.dom.shield);
            this.dom.tool.addEventListener("click", this.triggerAction.bind(this));
            this.render();
            setTimeout(() => this.dom.tool.classList.add("visible"), 50);
            this.watcher = new MutationObserver(() => {
                if (!document.documentElement.contains(this.dom.host)) {
                    document.documentElement.appendChild(this.dom.host);
                }
            });
            this.watcher.observe(document.documentElement, { childList: true });
        }

        render() {
            const t = this.dom.tool;
            if (!t) return;
            t.classList.toggle("minimized", this.state.isCollapsed);
            t.classList.toggle("minimal", !this.state.isCollapsed && this.state.scale === "minimal");
            t.classList.remove("full");
            if (!this.state.isCollapsed && this.state.scale === "full") t.classList.add("full");
            this.dom.shield.style.display = (this.state.mode !== "initial" && this.state.mode !== "selected") || this.state.isCollapsed ? "none" : "block";
            let e = "";
            if (this.state.isCollapsed) {
                e = `<button class="picky-maximize-button picky-icon-button" data-action="cycleSize">${ICON_DOT}</button>`;
            } else if (this.state.scale === "minimal") {
                e = `<div class="picky-content">${this.getMinLayout()}</div>`;
            } else {
                e = `<div class="picky-content">${this.getFullLayout()}</div>`;
            }
            t.innerHTML = e;
            if (this.state.mode === "selected") {
                this.attachRefs();
                this.refreshMetrics();
            }
        }

        getFullLayout() {
            if (this.state.mode === "selected") return this.getSelLayout();
            if (this.state.mode === "settings") return this.getSetLayout();
            // 🔧 FIX #3: Stats in initial screen
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            return `<div class="picky-header"><div class="picky-header-title">요소 선택기</div><div class="picky-header-actions"><button class="picky-icon-button" data-action="showSettings" title="설정">${ICON_SETTINGS}</button><button class="picky-icon-button" data-action="close">${ICON_CLOSE}</button></div></div>
            <div class="picky-stats-bar"><span>이 사이트: <span class="pk-stat-val">${stats.ruleCount}</span>개 규칙 / <span class="pk-stat-val">${stats.hiddenCount}</span>개 요소 숨김</span><span>${enabled ? '🟢 ON' : '🔴 OFF'}</span></div>
            <div style="text-align:center; color: var(--pk-on-surf-var); padding: 16px 0;">페이지에서 요소를 탭/클릭하세요...<br><span style="font-size:11px">Ctrl+Shift+P로 토글 / 화살표 키로 탐색</span></div>
            <div class="picky-button-grid" style="grid-template-columns: repeat(3, 1fr); gap: 6px;">
                <button data-action="suggestAds" class="warn">🎯 광고 자동 감지</button>
                <button data-action="toggleBlocking">${enabled ? '⏸ 차단 일시정지' : '▶ 차단 다시 켜기'}</button>
                <button data-action="undoLast">↩ 마지막 차단 취소</button>
            </div>`;
        }

        getSelLayout() {
            const t = this.calcSliderLimits();
            const e = `<div id="picky-nav-slider-container"><label for="picky-nav-slider" style="font-size:11px; color:var(--pk-on-surf-var)">요소 탐색 (상위 ← → 하위)</label><input type="range" id="picky-nav-slider" min="${t.min}" max="${t.max}" value="${t.val}"></div>`;
            return `<div class="picky-header"><div class="picky-header-title">요소 선택됨</div><div class="picky-header-actions">
                <button class="picky-icon-button" data-action="inspectCode" title="연관 코드 보기">${ICON_CODE}</button>
                <button class="picky-icon-button" data-action="showSettings" title="설정">${ICON_SETTINGS}</button>
                <button class="picky-icon-button" data-action="cycleSize" title="모드 전환">${ICON_MIN}</button>
                <button class="picky-icon-button" data-action="close" title="닫기">${ICON_CLOSE}</button></div></div>
            <div class="picky-selector-box">
                <div class="picky-selector-box-title"><span>CSS 선택자 (클릭=직접 편집)</span><span class="picky-match-count"></span></div>
                <div class="picky-selector-display" data-action="editSelector"></div>
            </div>${e}
            <div class="picky-button-grid" style="grid-template-columns: repeat(6, 1fr); margin-top: 10px; gap: 6px;">
                <button data-action="selParent">상위</button>
                <button data-action="selChild">하위</button>
                <button data-action="toggleHide">${this.state.isObscured ? "복원" : "숨김"}</button>
                <button data-action="permanentBlock" style="color:#fff; background-color:var(--pk-err);">차단</button>
                <button data-action="toggleIsolate">${this.state.isQuarantined ? "해제" : "격리"}</button>
                <button data-action="selSimilar">유사</button>
                <button data-action="extractUrl">URL</button>
                <button data-action="extractAttr">속성</button>
                <button data-action="togglePro" class="${this.state.isPro ? 'primary' : ''}">Pro</button>
                <button data-action="copyCSS" class="primary">CSS</button>
                <button data-action="copyRule" class="primary">규칙</button>
                <button data-action="reset">리셋</button>
            </div>`;
        }

        getMinLayout() {
            return `<button class="picky-icon-button" data-action="selParent" title="상위">${ICON_UP}</button>
            <button class="picky-icon-button" data-action="selChild" title="하위">${ICON_DOWN}</button>
            <button class="picky-icon-button" data-action="toggleHide" title="${this.state.isObscured ? "복원" : "숨김"}">${this.state.isObscured ? ICON_EYE : ICON_EYE_OFF}</button>
            <button class="picky-icon-button" data-action="copyCSS" title="CSS">${ICON_COPY}</button>
            <button class="picky-icon-button" data-action="reset" title="초기화">${ICON_RESET}</button>
            <button class="picky-icon-button" data-action="cycleSize" title="전체 모드">${ICON_MAX}</button>`;
        }

        getSetLayout() {
            const t = this.config;
            const e = t.intelligentMode ? 'style="display:none;"' : "";
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            const aggressive = Blocker.isAggressive();
            return `<div class="picky-header"><button class="picky-icon-button" data-action="showSelected">${ICON_BACK}</button><div class="picky-header-title">설정</div><div class="picky-header-actions"><button class="picky-icon-button" data-action="showSelected">${ICON_CLOSE}</button></div></div>
            <div class="picky-stats-bar"><span>전역: <span class="pk-stat-val">${stats.totalSites}</span>사이트 / <span class="pk-stat-val">${stats.totalRules}</span>규칙</span><span>현재 사이트: <span class="pk-stat-val">${stats.ruleCount}</span>개</span></div>
            <div class="picky-setting-item"><span>복사 후 자동 닫기</span><label class="picky-switch"><input type="checkbox" data-action="toggleAutoClose" ${this.state.autoDismiss ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-item"><span>차단 활성화</span><label class="picky-switch"><input type="checkbox" data-action="toggleBlockingSwitch" ${enabled ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-item"><span>공격적 차단 (공간까지 제거)</span><label class="picky-switch"><input type="checkbox" data-action="toggleAggressive" ${aggressive ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-title">선택자 생성 규칙</div>
            <div class="picky-setting-item"><span>지능형 모드</span><label class="picky-switch"><input type="checkbox" data-cfg-key="intelligentMode" ${t.intelligentMode ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-manual-settings" ${e}>
                <div class="picky-setting-item"><span>ID 사용 (#id)</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useId" ${t.useId ? "checked" : ""}><span class="picky-slider"></span></label></div>
                <div class="picky-setting-item"><span>클래스 사용 (.class)</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useClasses" ${t.useClasses ? "checked" : ""}><span class="picky-slider"></span></label></div>
                <div class="picky-setting-item"><span>순서 사용 (:nth-of-type)</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useNthOfType" ${t.useNthOfType ? "checked" : ""}><span class="picky-slider"></span></label></div>
            </div>
            <div class="picky-setting-title">고급 기능</div>
            <div class="picky-setting-item"><span>Shadow DOM 호환성</span><label class="picky-switch"><input type="checkbox" data-cfg-key="shadowDomSupport" ${t.shadowDomSupport ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-title">광고 차단 관리</div>
            <div class="picky-button-grid" style="margin-top:8px; grid-template-columns: 1fr 1fr;">
                <button data-action="showBlockRules">📋 규칙 보기/관리</button>
                <button data-action="resetBlocks" style="background-color: var(--pk-err); color: #fff;">🗑 규칙 초기화</button>
            </div>
            <div class="picky-setting-title">백업 / 가져오기 / 내보내기</div>
            <div class="picky-button-grid" style="margin-top:8px; grid-template-columns: 1fr 1fr 1fr;">
                <button data-action="exportJSON">📤 JSON</button>
                <button data-action="exportUblock">📤 uBlock</button>
                <button data-action="importJSON" class="primary">📥 가져오기</button>
            </div>
            <div class="picky-setting-title">개발자 도구 및 UI</div>
            <div class="picky-button-grid" style="grid-template-columns: repeat(3, 1fr); gap: 6px;">
                <button data-action="showSource" data-type="html">HTML</button>
                <button data-action="showSource" data-type="css">CSS</button>
                <button data-action="showSource" data-type="js">JS</button>
                <button data-action="showCookies">쿠키</button>
                <button data-action="showFp">핑거프린팅</button>
                <button data-action="moveTop">UI 상단</button>
                <button data-action="moveBottom">UI 하단</button>
            </div>`;
        }

        attachRefs() {
            this.dom.disp = this.dom.tool.querySelector(".picky-selector-display");
            this.dom.match = this.dom.tool.querySelector(".picky-match-count");
            this.dom.slider = this.dom.tool.querySelector("#picky-nav-slider");
            if (this.dom.slider) this.dom.slider.addEventListener("input", this.handleSlide.bind(this));
        }

        rebuildTree(t) {
            this.state.hierarchy = [];
            let e = t;
            while (e && e.tagName !== "BODY") {
                this.state.hierarchy.unshift(e);
                e = this.resolveParent(e);
            }
        }

        calcSliderLimits() {
            const t = this.state.hierarchy;
            if (!t.length) return { min: 0, max: 0, val: 0 };
            const e = t.indexOf(this.state.originTarget);
            const i = this.resolveChildren(this.state.originTarget);
            const o = this.state.target === this.state.originTarget
                ? e
                : t.includes(this.state.target)
                    ? t.indexOf(this.state.target)
                    : e + 1 + i.indexOf(this.state.target);
            return { min: 0, max: e + i.length, val: o };
        }

        handleSlide(t) {
            const e = parseInt(t.target.value, 10);
            const i = this.state.hierarchy;
            const o = i.indexOf(this.state.originTarget);
            let s = e <= o ? i[e] : this.resolveChildren(this.state.originTarget)[e - o - 1];
            if (s && s !== this.state.target) {
                this.dropFocus(this.state.target);
                this.state.target = s;
                this.setFocus(this.state.target);
                this.refreshMetrics();
            }
        }

        selectNode(t) {
            if (this.state.isCollapsed) return;
            const e = t.composedPath();
            if (e[0] === this.dom.host || e.includes(this.dom.tool) || (this.overlay.node && e.includes(this.overlay.node))) return;
            const i = e[0] === this.dom.shield ? this.locateActualTarget(t) : e[0];
            if (i) {
                t.preventDefault();
                t.stopImmediatePropagation();
                if (this.state.mode === "initial" || this.state.mode === "selected") {
                    this.dropFocus(this.state.target);
                    this.state.target = i;
                    this.state.originTarget = i;
                    this.rebuildTree(i);
                    this.setFocus(this.state.target);
                    this.state.mode = "selected";
                    if (this.config.shadowDomSupport) this.embedShadowCSS();
                    this.render();
                }
            }
        }

        locateActualTarget(t) {
            const e = t.touches?.[0] || t.changedTouches?.[0] || t;
            const i = this.dom.shield.style.display;
            this.dom.shield.style.display = "none";
            const o = this.config.shadowDomSupport
                ? this.pierceShadow(e.clientX, e.clientY)
                : document.elementFromPoint(e.clientX, e.clientY);
            this.dom.shield.style.display = i;
            return o;
        }

        onTapStart(t) {
            if (t.composedPath().includes(this.dom.tool)) return;
            touchStartTarget = this.locateActualTarget(t);
            touchMoved = false;
        }
        onTapMove(t) {
            if (touchMoved || !touchStartTarget) return;
            const e = t.touches[0];
            const i = touchStartTarget.getBoundingClientRect();
            const o = e.clientX - i.left, s = e.clientY - i.top;
            if (Math.hypot(o, s) > DRAG_THRESHOLD) touchMoved = true;
        }
        onTapEnd(t) {
            if (this.state.isCollapsed) return;
            if (touchMoved || t.composedPath().includes(this.dom.tool)) return;
            const e = this.locateActualTarget(t);
            this.selectNode({
                target: e, composedPath: () => [e],
                preventDefault: t.preventDefault, stopImmediatePropagation: t.stopImmediatePropagation
            });
        }

        triggerAction(t) {
            const e = t.target;
            const i = e.closest("[data-action]");
            const o = e.closest("[data-cfg-key]");
            if (o) {
                const k = o.dataset.cfgKey;
                if (typeof this.config[k] === "boolean") this.config[k] = o.checked;
                if (k === "shadowDomSupport" && o.checked) this.embedShadowCSS();
                if (k === "intelligentMode") {
                    const ms = this.dom.tool.querySelector(".picky-manual-settings");
                    if (ms) ms.style.display = o.checked ? "none" : "block";
                }
                this.refreshMetrics();
                return;
            }
            if (!i) return;
            const s = i.dataset.action;
            const a = i.dataset.type;

            const actions = {
                close: () => this.terminate(false),
                cycleSize: () => {
                    if (this.state.isCollapsed) {
                        this.state.isCollapsed = false;
                        this.state.scale = "full";
                    } else if (this.state.scale === "full") {
                        this.state.scale = "minimal";
                    } else {
                        this.state.isCollapsed = true;
                    }
                    this.render();
                },
                showSettings: () => { this.state.mode = "settings"; this.render(); },
                showSelected: () => { this.state.mode = this.state.target ? "selected" : "initial"; this.render(); },
                reset: () => {
                    this.purge();
                    this.dropFocus(this.state.target);
                    this.state.target = null;
                    this.state.originTarget = null;
                    this.state.hierarchy = [];
                    this.state.mode = "initial";
                    this.state.scale = "full";
                    this.state.isCollapsed = false;
                    this.render();
                },
                selParent: () => {
                    this.purge();
                    const p = this.resolveParent(this.state.target);
                    if (p && p.tagName?.toLowerCase() !== "body" && p.tagName?.toLowerCase() !== "html") {
                        this.dropFocus(this.state.target);
                        this.state.target = p;
                        this.setFocus(this.state.target);
                        if (!this.state.hierarchy.includes(p)) this.rebuildTree(this.state.originTarget);
                        this.refreshMetrics();
                        this.render();
                    }
                },
                selChild: () => this.displayChildOptions(),
                selSimilar: () => {
                    const q = this.evaluateCss(this.state.target);
                    const cleaned = q.selector.replace(/:nth-of-type\(\d+\)/g, "");
                    if (this.dom.disp) this.dom.disp.textContent = cleaned + (q.root instanceof ShadowRoot ? " (in Shadow DOM)" : "");
                    this.refreshMetrics();
                },
                toggleHide: () => {
                    const { selector, root } = this.state.queryData;
                    if (selector) {
                        if (this.state.isObscured) this.revertObscured();
                        else this.execObscure(selector, root);
                        this.render();
                    }
                },
                permanentBlock: () => {
                    const { selector } = this.state.queryData;
                    if (!selector) { alert("선택할 수 없는 요소입니다."); return; }
                    if (confirm(`다음 선택자를 영구 차단하시겠습니까?\n\n${selector}\n\n* "설정 > 규칙 보기"에서 해제 가능`)) {
                        Blocker.append(selector);
                        actions.reset();
                    }
                },
                // 🔧 FIX #4
                undoLast: () => {
                    const last = Blocker.undoLast();
                    if (last) alert(`되돌림:\n${last.selector}\n(${last.host})`);
                    else alert("되돌릴 기록이 없습니다.");
                    this.render();
                },
                // 🔧 FIX #6
                toggleBlocking: () => {
                    const on = Blocker.toggleEnabled();
                    alert(on ? "차단 활성화됨" : "차단 일시정지됨");
                    this.render();
                },
                toggleBlockingSwitch: () => { Blocker.toggleEnabled(); this.render(); },
                // 🔧 FIX #14
                toggleAggressive: () => { Blocker.toggleAggressive(); this.render(); },
                // 🔧 FIX #1, #2
                exportJSON: () => Blocker.exportJSON(),
                exportUblock: () => Blocker.exportUblock(),
                importJSON: () => Blocker.importJSON(),
                // 🔧 FIX #5: Rule list with hover preview
                showBlockRules: () => this.showRulesWithPreview(),
                resetBlocks: () => {
                    if (confirm(`현재 사이트(${window.location.hostname})의 모든 차단 규칙을 삭제하시겠습니까?`)) Blocker.clear();
                },
                togglePro: () => { this.state.isPro = !this.state.isPro; this.refreshMetrics(); this.render(); },
                toggleIsolate: () => this.toggleIsolation(),
                copyCSS: () => this.clip(false),
                copyRule: () => this.clip(true),
                toggleAutoClose: () => {
                    this.state.autoDismiss = e.checked;
                    GM_setValue("picky_auto_close", this.state.autoDismiss);
                },
                moveTop: () => this.shiftUI("top"),
                moveBottom: () => this.shiftUI("bottom"),
                extractUrl: () => this.pullUrl(),
                extractAttr: () => this.pullAttr(),
                inspectCode: () => this.openInspector(),
                showSource: () => this.printSource(a),
                showCookies: () => this.printCookies(),
                showFp: () => this.printFp(),
                // 🔧 FIX #11: Manual selector edit
                editSelector: () => this.editSelector(),
                // 🔧 FIX #9: Auto-detect ads
                suggestAds: () => this.suggestAds()
            };
            if (actions[s]) actions[s]();
        }

        setFocus(t) { t?.classList.add(HL_CLASS); }
        dropFocus(t) { t?.classList.remove(HL_CLASS); }
        purge() {
            this.revertObscured();
            if (this.state.isQuarantined) this.toggleIsolation(true);
        }

        execObscure(sel, root) {
            try {
                this.state.obscuredNodes = Array.from(root.querySelectorAll(sel));
                this.state.obscuredNodes.forEach(el => {
                    if (!this.state.displayCache.has(el)) this.state.displayCache.set(el, el.style.display || "");
                    el.style.display = "none";
                });
                this.state.isObscured = true;
            } catch (e) {}
        }
        revertObscured() {
            this.state.obscuredNodes.forEach(el => {
                if (this.state.displayCache.has(el)) el.style.display = this.state.displayCache.get(el);
            });
            this.state.obscuredNodes = [];
            this.state.isObscured = false;
        }
        toggleIsolation(force = false) {
            this.state.isQuarantined = !force && !this.state.isQuarantined;
            document.querySelectorAll(`.${ISO_PATH}`).forEach(el => el.classList.remove(ISO_PATH));
            if (this.state.isQuarantined && this.state.target) {
                let t = this.state.target;
                while (t) { t.classList.add(ISO_PATH); t = this.resolveParent(t); }
                document.documentElement.classList.add(ISO_BODY);
            } else {
                document.documentElement.classList.remove(ISO_BODY);
            }
            this.render();
        }

        clip(asRule = false) {
            const { selector, root } = this.state.queryData;
            if (!selector) return;
            if (this.config.shadowDomSupport && root instanceof ShadowRoot) {
                alert("Shadow DOM 내부의 선택자는 전역 차단에서 작동하지 않을 수 있습니다.");
            }
            const txt = asRule ? `${window.location.hostname}##${selector}` : selector;
            navigator.clipboard.writeText(txt).then(() => {
                const btn = this.dom.tool.querySelector(asRule ? '[data-action="copyRule"]' : '[data-action="copyCSS"]');
                if (!btn) return;
                const old = btn.innerHTML;
                btn.textContent = "복사 완료!";
                btn.classList.add("copied");
                setTimeout(() => {
                    if (this.state.autoDismiss) this.terminate(false);
                    else { btn.innerHTML = old; btn.classList.remove("copied"); }
                }, 1200);
            }).catch(() => {
                prompt("복사 실패:", txt);
                if (this.state.autoDismiss) this.terminate(false);
            });
        }

        shiftUI(pos) {
            this.state.alignment = pos;
            this.dom.tool.className = `${pos} visible`;
            GM_setValue("picky_alignment", pos);
        }

        pullUrl() {
            let t = this.state.target, e = null;
            for (let i = 0; i < 5 && t; i++) {
                e = t.getAttribute("href") || t.getAttribute("src") || t.getAttribute("data-src") || t.getAttribute("data-original");
                if (e) break;
                const bg = window.getComputedStyle(t).backgroundImage;
                if (bg?.includes("url")) {
                    const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
                    if (m) { e = m[1]; break; }
                }
                t = this.resolveParent(t);
            }
            if (e) prompt("추출된 URL:", new URL(e, window.location.href).href);
            else alert("URL을 찾을 수 없습니다.");
        }

        pullAttr() {
            const a = prompt("추출할 속성 이름 입력 (예: data-id, alt):");
            if (!a) return;
            const v = this.state.target?.getAttribute(a);
            if (v !== null) prompt(`'${a}' 속성 값:`, v);
            else alert(`'${a}' 속성을 찾을 수 없습니다.`);
        }

        displayChildOptions() {
            const ch = this.resolveChildren(this.state.target);
            if (!ch || ch.length === 0) { alert("하위 요소가 없습니다."); return; }
            const items = ch.map((c, i) => `<li data-idx="${i}">${c.tagName.toLowerCase()}${c.id ? `#${esc(c.id)}` : ""}${c.className ? `.${esc(String(c.className).split(" ").filter(Boolean).join("."))}` : ""}</li>`).join("");
            this.overlay.display("하위 요소 선택", `<ul class="picky-child-list">${items}</ul>`, true);
            this.overlay.node.querySelector(".picky-child-list").addEventListener("click", e => {
                const li = e.target.closest("li[data-idx]");
                if (!li) return;
                const idx = parseInt(li.dataset.idx, 10);
                const sel = ch[idx];
                if (sel) {
                    this.dropFocus(this.state.target);
                    this.state.target = sel;
                    this.setFocus(this.state.target);
                    this.refreshMetrics();
                }
                this.overlay.dismiss();
            });
        }

        // 🔧 FIX #5: Rule list with hover preview
        showRulesWithPreview() {
            const renderList = () => {
                const rules = Blocker.fetch();
                if (rules.length === 0) return '<div style="padding:20px;text-align:center;color:var(--pk-on-surf-var);">저장된 차단 규칙이 없습니다.</div>';
                return `<p style="font-size:11px;color:var(--pk-on-surf-var);margin-bottom:10px;">규칙에 마우스를 올리면 해당 요소가 페이지에서 하이라이트됩니다.</p>
                <ul class="picky-child-list" style="max-height:50vh;overflow-y:auto;">
                ${rules.map(r => `<li data-rule-hover="${esc(r)}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                    <span style="word-break:break-all;font-family:monospace;font-size:11px;flex:1;">${esc(r)}</span>
                    <button data-rule="${esc(r)}" style="background-color:var(--pk-err);color:#fff;padding:4px 8px;font-size:11px;border-radius:8px;flex-shrink:0;border:none;cursor:pointer;">삭제</button>
                </li>`).join("")}</ul>`;
            };
            this.overlay.display("현재 차단 규칙 관리", renderList(), true);
            const body = this.overlay.node.querySelector(".picky-modal-body");

            body.addEventListener("mouseover", e => {
                const li = e.target.closest("[data-rule-hover]");
                if (!li) return;
                this.clearRulePreview();
                try {
                    document.querySelectorAll(li.dataset.ruleHover).forEach(el => {
                        el.classList.add("picky-rule-preview-hover");
                        this.state.hoverPreviewNodes.push(el);
                    });
                } catch(err) {}
            });
            body.addEventListener("mouseout", e => {
                if (e.target.closest("[data-rule-hover]")) this.clearRulePreview();
            });
            body.addEventListener("click", e => {
                const btn = e.target.closest("button[data-rule]");
                if (!btn) return;
                const rule = btn.dataset.rule;
                if (confirm(`이 규칙을 삭제하시겠습니까?\n\n${rule}`)) {
                    this.clearRulePreview();
                    Blocker.drop(rule);
                    body.innerHTML = renderList();
                }
            });
        }
        clearRulePreview() {
            this.state.hoverPreviewNodes.forEach(el => el.classList.remove("picky-rule-preview-hover"));
            this.state.hoverPreviewNodes = [];
        }

        // 🔧 FIX #11: Manual selector edit
        editSelector() {
            const current = this.state.queryData.selector;
            if (!current) return;
            const edited = prompt("CSS 선택자 직접 편집:", current);
            if (!edited || edited === current) return;
            try {
                const matches = document.querySelectorAll(edited);
                this.state.queryData.selector = edited;
                this.state.hits = matches.length;
                if (this.dom.disp) this.dom.disp.textContent = edited;
                if (this.dom.match) this.dom.match.textContent = `${matches.length}개 일치`;
                if (matches[0]) {
                    this.dropFocus(this.state.target);
                    this.state.target = matches[0];
                    this.setFocus(this.state.target);
                }
            } catch(e) {
                alert("올바르지 않은 선택자: " + e.message);
            }
        }

        // 🔧 FIX #9: Auto-detect ad-like elements
        suggestAds() {
            const adKw = /(^|[-_])(ad|ads|advert|banner|sponsor|promot|popup|sponsored)([-_]|$|s)/i;
            const candidates = [];
            const stdAdSizes = [[300,250],[728,90],[160,600],[320,50],[300,600],[336,280],[970,250],[468,60]];

            document.querySelectorAll('div, section, iframe, aside, ins').forEach(el => {
                if (!el.offsetParent && el.tagName !== 'IFRAME') return;
                let score = 0;
                const reasons = [];
                const id = (el.id || '').toLowerCase();
                const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                const src = (el.getAttribute('src') || '').toLowerCase();

                if (adKw.test(id)) { score += 5; reasons.push('id'); }
                if (adKw.test(cls)) { score += 4; reasons.push('class'); }
                if (el.tagName === 'IFRAME' && adKw.test(src)) { score += 6; reasons.push('iframe-src'); }
                if (el.tagName === 'INS') { score += 3; reasons.push('<ins>'); }
                if (el.querySelector('a[target="_blank"][href*="click"], a[href*="/ads/"], a[href*="/ad/"]')) { score += 3; reasons.push('ad-link'); }

                const rect = el.getBoundingClientRect();
                if (stdAdSizes.some(([w, h]) => Math.abs(rect.width - w) < 5 && Math.abs(rect.height - h) < 5)) {
                    score += 5; reasons.push('std-ad-size');
                }
                if (rect.width > 0 && rect.height > 0 && score > 0) {
                    candidates.push({ el, score, reasons });
                }
            });

            candidates.sort((a, b) => b.score - a.score);
            const top = candidates.slice(0, 20);

            if (top.length === 0) {
                alert("광고로 의심되는 요소를 찾지 못했어요.");
                return;
            }

            const html = `<p style="font-size:12px;color:var(--pk-on-surf-var);margin-bottom:10px;">아래 요소들이 광고로 의심됩니다. 호버하면 페이지에서 표시되고, 체크 후 차단 버튼을 누르면 영구 차단됩니다.</p>
            <div style="max-height:50vh;overflow-y:auto;">
            ${top.map((c, i) => {
                const sel = this.evaluateCss(c.el).selector;
                const preview = `${c.el.tagName.toLowerCase()}${c.el.id ? '#' + c.el.id : ''}${c.el.className ? '.' + String(c.el.className).split(' ').filter(Boolean).slice(0,2).join('.') : ''}`;
                return `<label class="picky-ad-suggest-item" data-idx="${i}">
                    <input type="checkbox" data-idx="${i}">
                    <span class="picky-ad-suggest-score">${c.score}</span>
                    <span style="flex:1;font-family:monospace;font-size:11px;word-break:break-all;">${esc(preview)}<br><span style="color:var(--pk-on-surf-var);font-size:10px;">${esc(c.reasons.join(', '))}</span></span>
                </label>`;
            }).join("")}</div>
            <div style="display:flex;gap:8px;margin-top:12px;">
                <button data-suggest-action="selectAll" style="flex:1;padding:8px;background:var(--pk-sec-cont);border:none;border-radius:8px;cursor:pointer;">전체 선택</button>
                <button data-suggest-action="blockSelected" style="flex:2;padding:8px;background:var(--pk-err);color:#fff;border:none;border-radius:8px;cursor:pointer;">선택 항목 영구 차단</button>
            </div>`;

            this.overlay.display(`광고 자동 감지 (${top.length}개)`, html, true);
            const body = this.overlay.node.querySelector(".picky-modal-body");

            body.addEventListener("mouseover", e => {
                const lbl = e.target.closest("label[data-idx]");
                if (!lbl) return;
                this.clearRulePreview();
                const item = top[parseInt(lbl.dataset.idx, 10)];
                if (item) {
                    item.el.classList.add("picky-rule-preview-hover");
                    this.state.hoverPreviewNodes.push(item.el);
                    item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
            body.addEventListener("mouseout", e => {
                if (e.target.closest("label[data-idx]")) this.clearRulePreview();
            });
            body.addEventListener("click", e => {
                const btn = e.target.closest("[data-suggest-action]");
                if (!btn) return;
                const act = btn.dataset.suggestAction;
                if (act === "selectAll") {
                    body.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
                } else if (act === "blockSelected") {
                    const selected = Array.from(body.querySelectorAll('input[type=checkbox]:checked'));
                    if (selected.length === 0) { alert("선택된 항목이 없어요."); return; }
                    if (!confirm(`${selected.length}개 요소를 영구 차단하시겠습니까?`)) return;
                    let added = 0;
                    selected.forEach(cb => {
                        const item = top[parseInt(cb.dataset.idx, 10)];
                        if (item) {
                            const sel = this.evaluateCss(item.el).selector;
                            if (sel && Blocker.append(sel)) added++;
                        }
                    });
                    this.clearRulePreview();
                    alert(`${added}개 규칙이 추가되었습니다.`);
                    this.overlay.dismiss();
                    this.render();
                }
            });
        }

        openInspector() {
            if (!this.state.target) return;
            const t = this.state.target;
            const reserved = [HL_CLASS, ISO_PATH];

            const htmlPart = (() => {
                const c = t.cloneNode(true);
                c.classList.remove(...reserved);
                c.querySelectorAll(reserved.map(x => `.${x}`).join(", ")).forEach(el => el.classList.remove(...reserved));
                let raw = c.outerHTML, out = "", depth = 0;
                raw.split(/(?=<)/).forEach(piece => {
                    const trim = piece.trim();
                    if (!trim) return;
                    if (trim.startsWith("</")) depth--;
                    if (depth < 0) depth = 0;
                    out += " ".repeat(depth * 2) + trim + "\n";
                    if (trim.startsWith("<") && !trim.startsWith("</") && !trim.endsWith("/>")) depth++;
                });
                return out.trim();
            })();

            const cssPart = (() => {
                let s = "/* --- 인라인 스타일 --- */\n";
                s += t.style.cssText ? `${this.evaluateCss(t).selector} {\n  ${t.style.cssText.replace(/; /g, ";\n  ")}\n}\n\n` : "없음\n\n";
                s += "/* --- 계산된 스타일 (기본값 제외) --- */\n";
                let cs = "";
                try {
                    const cmp = window.getComputedStyle(t);
                    const def = window.getComputedStyle(document.createElement(t.tagName));
                    const props = new Set();
                    for (let i = 0; i < cmp.length; i++) props.add(cmp[i]);
                    for (const p of Array.from(props).sort()) {
                        const v = cmp.getPropertyValue(p);
                        if (v && v !== def.getPropertyValue(p)) {
                            if (p.startsWith("-")) continue;
                            cs += `  ${p}: ${v};\n`;
                        }
                    }
                } catch(e) {}
                return s + (cs ? `${this.evaluateCss(t).selector} {\n${cs}}\n` : "추가 계산된 스타일 없음\n");
            })();

            const jsPart = (() => {
                let s = "/* --- 인라인 이벤트 핸들러 --- */\n";
                let found = false;
                for (const a of t.attributes) {
                    if (a.name.startsWith("on")) { s += `${a.name}="${a.value}"\n`; found = true; }
                }
                if (!found) s += "없음\n";
                s += "\n/* --- 연관 인라인 스크립트 --- */\n";
                const ids = [t.id, ...Array.from(t.classList).filter(c => !reserved.includes(c))].filter(Boolean);
                let scriptHits = "";
                if (ids.length > 0) {
                    const rx = new RegExp(ids.map(x => CSS.escape(x)).join("|"), "i");
                    document.querySelectorAll("script:not([src])").forEach((sc, i) => {
                        if (rx.test(sc.innerHTML)) scriptHits += `\n// 인라인 스크립트 #${i+1}:\n${sc.innerHTML.substring(0, 1000).trim()}...\n`;
                    });
                }
                s += scriptHits || "없음\n";
                return s;
            })();

            const html = `<div class="picky-code-tabs">
                <div class="picky-code-tab active" data-tab="html">HTML</div>
                <div class="picky-code-tab" data-tab="css">CSS</div>
                <div class="picky-code-tab" data-tab="js">JS</div></div>
                <div class="picky-code-panel active" data-panel="html"><pre>${htmlPart.replace(/</g, "&lt;")}</pre></div>
                <div class="picky-code-panel" data-panel="css"><pre>${cssPart.replace(/</g, "&lt;")}</pre></div>
                <div class="picky-code-panel" data-panel="js"><pre>${jsPart.replace(/</g, "&lt;")}</pre></div>`;

            this.overlay.display("연관 코드 검사기", html, true);
            const m = this.overlay.node;
            m.querySelectorAll(".picky-code-tab").forEach(tab => {
                tab.addEventListener("click", () => {
                    m.querySelector(".picky-code-tab.active").classList.remove("active");
                    m.querySelector(".picky-code-panel.active").classList.remove("active");
                    tab.classList.add("active");
                    m.querySelector(`.picky-code-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
                });
            });
        }

        printSource(type) {
            let title = "", body = "";
            if (type === "html") {
                title = "HTML (현재 DOM)";
                body = document.documentElement.outerHTML;
            } else if (type === "css") {
                title = "CSS (내부 스타일)";
                body = "/* 동일 출처 스타일시트와 인라인 스타일만 표시됩니다. */\n\n";
                Array.from(document.styleSheets).forEach(s => {
                    try {
                        if (s.href && !s.href.startsWith(location.origin)) return;
                        body += `/* --- ${s.href || "Inline"} --- */\n`;
                        Array.from(s.cssRules).forEach(r => body += r.cssText + "\n");
                    } catch(e) {}
                });
            } else if (type === "js") {
                title = "JavaScript";
                body = "/* 페이지에 로드된 스크립트 목록 */\n\n";
                Array.from(document.scripts).forEach(sc => {
                    body += sc.src ? `\n<script src="${sc.src}"><\/script>\n\n` : `\n<script>${sc.innerHTML}<\/script>\n\n`;
                });
            }
            this.overlay.display(title, body);
        }

        printCookies() {
            const getCookies = () => document.cookie.split(";").filter(Boolean).map(c => {
                const p = c.trim().split("=");
                return { name: p[0], value: decodeURIComponent(p.slice(1).join("=")) };
            });
            const render = () => {
                const cks = getCookies();
                if (cks.length === 0) return "표시할 쿠키가 없습니다 (HttpOnly 쿠키는 접근 불가).";
                return `<p style="font-size:11px;color:var(--pk-on-surf-var);margin-bottom:10px;">HttpOnly 플래그가 설정된 쿠키는 보안 정책상 표시되지 않습니다.</p>
                <table class="picky-cookie-table"><thead><tr><th>Name</th><th>Value</th><th>Actions</th></tr></thead><tbody>
                ${cks.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td><td class="cookie-actions">
                    <button data-cookie-name="${esc(c.name)}" data-action="editCookie">수정</button>
                    <button data-cookie-name="${esc(c.name)}" data-action="deleteCookie" class="delete">삭제</button>
                </td></tr>`).join("")}</tbody></table>`;
            };
            this.overlay.display("쿠키 정보", render(), true);
            this.overlay.node.querySelector(".picky-modal-body").addEventListener("click", e => {
                const btn = e.target.closest("button[data-cookie-name]");
                if (!btn) return;
                const name = btn.dataset.cookieName;
                const act = btn.dataset.action;
                if (act === "editCookie") {
                    const cur = getCookies().find(c => c.name === name)?.value || "";
                    const nv = prompt(`'${name}' 쿠키의 새 값:`, cur);
                    if (nv !== null) {
                        document.cookie = `${name}=${encodeURIComponent(nv)};path=/;max-age=31536000`;
                        this.overlay.node.querySelector(".picky-modal-body").innerHTML = render();
                    }
                } else if (act === "deleteCookie") {
                    if (confirm(`'${name}' 쿠키를 삭제하시겠습니까?`)) {
                        document.cookie = `${name}=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                        this.overlay.node.querySelector(".picky-modal-body").innerHTML = render();
                    }
                }
            });
        }

        printFp() {
            let s = "--- 브라우저/시스템 ---\n";
            try {
                s += `User Agent: ${navigator.userAgent}\n언어: ${navigator.language}\n시간대: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n스레드 수: ${navigator.hardwareConcurrency || "N/A"}\n메모리(GB): ${navigator.deviceMemory || "N/A"}\n\n--- 화면 ---\n`;
                s += `해상도: ${screen.width}x${screen.height}\n사용 가능: ${screen.availWidth}x${screen.availHeight}\n색상 깊이: ${screen.colorDepth}\n픽셀 비율: ${devicePixelRatio}\n\n--- 렌더링 ---\n`;
                const gl = document.createElement("canvas").getContext("webgl");
                const dbg = gl.getExtension("WEBGL_debug_renderer_info");
                s += `WebGL 벤더: ${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)}\nWebGL 렌더러: ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}\n\n`;
            } catch(e) {}
            s += "--- 네트워크 (Performance API) ---\n";
            const rs = performance.getEntriesByType("resource");
            s += `${rs.length}개 리소스 요청됨.\n\n`;
            rs.slice(0, 20).forEach(r => { s += `[${r.initiatorType}] ${r.name} (${Math.round(r.duration)}ms)\n`; });
            this.overlay.display("핑거프린팅 정보", s);
        }

        launch() {
            if (!document.documentElement) return;
            this.bindings = {
                selStart: this.onTapStart.bind(this),
                selMove: this.onTapMove.bind(this),
                selEnd: this.onTapEnd.bind(this),
                nodePick: this.selectNode.bind(this)
            };
            this.constructUI();
            document.addEventListener("click", this.bindings.nodePick, { capture: true });
            document.addEventListener("touchstart", this.bindings.selStart, { capture: true, passive: true });
            document.addEventListener("touchmove", this.bindings.selMove, { capture: true, passive: true });
            document.addEventListener("touchend", this.bindings.selEnd, { capture: true });

            // 🔧 FIX #8: Keyboard shortcuts
            this.keyHandler = (e) => {
                if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
                    e.preventDefault();
                    if (this.state.isCollapsed) {
                        this.state.isCollapsed = false;
                        this.state.scale = "full";
                    } else {
                        this.state.isCollapsed = true;
                    }
                    this.render();
                    return;
                }
                if (e.key === 'Escape' && !this.state.isCollapsed) {
                    if (this.overlay.node) { this.overlay.dismiss(); return; }
                    this.state.isCollapsed = true;
                    this.render();
                    return;
                }
                if (this.state.mode === 'selected' && !this.state.isCollapsed
                    && !e.target.closest('input, textarea')) {
                    if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        this.triggerAction({ target: { closest: () => ({ dataset: { action: 'selParent' } }) } });
                    } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        this.triggerAction({ target: { closest: () => ({ dataset: { action: 'selChild' } }) } });
                    }
                }
            };
            window.addEventListener('keydown', this.keyHandler, true);

            // Tampermonkey menu commands
            try {
                GM_registerMenuCommand("🎯 광고 자동 감지", () => {
                    if (this.state.isCollapsed) { this.state.isCollapsed = false; this.render(); }
                    this.suggestAds();
                });
                GM_registerMenuCommand("📤 규칙 내보내기 (JSON)", () => Blocker.exportJSON());
                GM_registerMenuCommand("📥 규칙 가져오기", () => Blocker.importJSON());
                GM_registerMenuCommand("↩ 마지막 차단 취소", () => {
                    const last = Blocker.undoLast();
                    alert(last ? `되돌림: ${last.selector}` : "기록 없음");
                });
                GM_registerMenuCommand("⏯ 차단 토글", () => {
                    const on = Blocker.toggleEnabled();
                    alert(on ? "차단 ON" : "차단 OFF");
                });
            } catch(e) {}
        }

        terminate(purge = true) {
            if (purge) this.purge();
            this.clearRulePreview();
            document.removeEventListener("click", this.bindings.nodePick, { capture: true });
            document.removeEventListener("touchstart", this.bindings.selStart, { capture: true });
            document.removeEventListener("touchmove", this.bindings.selMove, { capture: true });
            document.removeEventListener("touchend", this.bindings.selEnd, { capture: true });
            if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
            this.dom.tool?.classList.remove("visible");
            this.overlay?.dismiss();
            this.watcher?.disconnect();
            setTimeout(() => {
                this.dom.host?.remove();
                document.getElementById(`${TOOL_ID}-global-style`)?.remove();
                document.querySelectorAll("*").forEach(el => {
                    if (el.shadowRoot) {
                        const st = el.shadowRoot.getElementById(`${TOOL_ID}-hl-style`);
                        if (st) st.remove();
                    }
                });
                this.dropFocus(document.querySelector(`.${HL_CLASS}`));
            }, 400);
        }
    }

    // === LAUNCH ===
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new Inspector().launch());
    } else {
        new Inspector().launch();
    }

})();
