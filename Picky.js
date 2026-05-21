    // =========================================================
    // INSPECTOR CLASS
    // =========================================================
    class Inspector {
        constructor() {
            this.dom = { host: null, shadow: null, tool: null, shield: null, disp: null, match: null, slider: null };
            this.state = {
                target: null, originTarget: null, hierarchy: [],
                queryData: { selector: "", root: document },
                proCandidates: [], proSelectedIdx: -1, proPreviewNodes: [],
                mode: "initial", scale: "full", isCollapsed: true,
                isObscured: false, isQuarantined: false, obscuredNodes: [],
                displayCache: new WeakMap(), hits: 0,
                autoDismiss: GM_getValue("picky_auto_close", true),
                isPro: GM_getValue("picky_pro_mode", false),
                hoverPreviewNodes: [],
                adSelectedNodes: [],
                iconPos: GM_getValue("picky_icon_pos", null),
                panelPos: GM_getValue("picky_panel_pos", null),
                isDragging: false,
                dragDidMove: false,
                dragTarget: null
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
            this.longPressTimer = null;
            this._preciseEvaluator = (el) => this.evaluateCssBasic(el);
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

        evaluateCssBasic(t) {
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
            const chk = sel => {
                try { return n.querySelectorAll(sel).length === 1; } catch(err) { return false; }
            };

            if (e.useId && idState === "perfect") {
                const eId = CSS.escape(id);
                if (chk(`#${eId}`)) return { selector: `#${eId}`, root: n };
            }

            for (const oA of e.reliableAttrs) {
                const sA = t.getAttribute(oA);
                if (sA) {
                    const sel = `[${oA}="${sA.replace(/"/g, '\\"')}"]`;
                    if (chk(sel)) return { selector: sel, root: n };
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
                        const cl = Array.from(a.classList), cf = [];
                        for (const cn of cl) {
                            if (reservedClasses.includes(cn)) continue;
                            if (!cn || /\d{4,}/.test(cn) || /[a-f0-9]{6,}/i.test(cn)) continue;
                            let isV = false;
                            for (const vol of e.volatileClasses) {
                                if (cn.toLowerCase().includes(vol)) { isV = true; break; }
                            }
                            if (!isV || includeVolatile) cf.push(cn);
                        }
                        const nn = cf.slice(0, e.classCount);
                        if (nn.length > 0) l += "." + nn.map(x => CSS.escape(x)).join(".");
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
                        if (chk(cs)) return cs;
                    }
                    a = this.resolveParent(a);
                    dp++;
                }
                return s.join(" > ");
            };

            let d = cFn(t, false);
            if (chk(d)) return { selector: d, root: n };
            if (e.intelligentMode) {
                if (e.useId && idState === "dynamic") {
                    const eS = `${tg}#${CSS.escape(id)}`;
                    if (chk(eS)) return { selector: eS, root: n };
                }
                let iF = cFn(t, true);
                if (chk(iF)) return { selector: iF, root: n };
            }
            return { selector: d || cFn(t, true), root: n };
        }

        evaluateProCandidates(target) {
            if (!target) return [];
            return SelectorStrategies.buildAll(target, this._preciseEvaluator);
        }

        refreshMetrics() {
            if (!this.state.target) { this.state.hits = 0; this.state.proCandidates = []; return; }
            if (this.state.isPro) {
                this.state.proCandidates = this.evaluateProCandidates(this.state.target);
                const picked = this.state.proCandidates.find(c => c.recommended) || this.state.proCandidates[0];
                if (picked) {
                    this.state.queryData = { selector: picked.selector, root: document };
                    this.state.hits = picked.count;
                    this.state.proSelectedIdx = this.state.proCandidates.indexOf(picked);
                } else {
                    this.state.queryData = this.evaluateCssBasic(this.state.target);
                    this.state.hits = this.countMatches(this.state.queryData.selector);
                    this.state.proSelectedIdx = -1;
                }
            } else {
                this.state.queryData = this.evaluateCssBasic(this.state.target);
                this.state.hits = this.countMatches(this.state.queryData.selector);
                this.state.proCandidates = [];
                this.state.proSelectedIdx = -1;
            }
            if (this.dom.match) this.dom.match.textContent = `${this.state.hits}개 일치`;
            if (this.dom.disp) {
                let txt = this.state.queryData.selector;
                if (this.config.shadowDomSupport && this.state.queryData.root instanceof ShadowRoot) txt += " (in Shadow DOM)";
                this.dom.disp.textContent = txt;
            }
        }

        countMatches(sel) {
            if (!sel) return 0;
            try { return document.querySelectorAll(sel).length; } catch(e) { return 0; }
        }

        fetchStylesheet() {
            return `:host{--pk-pri:#007aff;--pk-on-pri:#fff;--pk-pri-cont:#007aff;--pk-on-pri-cont:#fff;--pk-sec-cont:#e9e9eb;--pk-on-sec-cont:#1d1d1f;--pk-surf-var:#f0f0f2;--pk-on-surf-var:#333;--pk-outl:#d1d1d6;--pk-surf:#f9f9f9;--pk-on-surf:#1d1d1f;--pk-succ:#34c759;--pk-err:#ff3b30;--pk-warn:#ff9500;all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;position:fixed;top:0;left:0;z-index:2147483647;width:0;height:0}
            #${TOOL_ID}{position:fixed;z-index:2147483646;width:calc(100% - 24px);max-width:460px;background:rgba(248,248,248,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.1);padding:10px 12px 12px;box-sizing:border-box;transition:opacity .4s;user-select:none;-webkit-user-select:none;font-size:14px;color:#000;opacity:0;max-height:90vh;overflow-y:auto}
            #${TOOL_ID}.visible{opacity:1}
            #${TOOL_ID}.dragging{transition:none!important;opacity:.85;cursor:grabbing!important}
            #${TOOL_ID} .picky-drag-handle{display:flex;align-items:center;justify-content:center;width:100%;height:18px;margin-bottom:4px;cursor:grab;color:var(--pk-on-surf-var);opacity:.4;border-radius:8px;touch-action:none;user-select:none;-webkit-user-select:none}
            #${TOOL_ID} .picky-drag-handle:hover{opacity:.8;background:rgba(0,0,0,.04)}
            #${TOOL_ID} .picky-drag-handle:active{cursor:grabbing}
            #${TOOL_ID} .picky-drag-handle svg{width:20px;height:8px;fill:currentColor!important;display:block;pointer-events:none}
            #${TOOL_ID} .picky-icon-button{display:flex;align-items:center;justify-content:center;background:0 0;border:none;padding:4px;color:var(--pk-on-surf);cursor:pointer;border-radius:50%;transition:background-color .2s}
            #${TOOL_ID} .picky-icon-button:hover{background-color:rgba(0,0,0,.08)}
            #${TOOL_ID} .picky-icon-button svg{width:24px;height:24px;fill:currentColor!important;display:block;pointer-events:none}
            #${TOOL_ID} .picky-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;color:var(--pk-on-surf);flex-wrap:nowrap;gap:6px}
            #${TOOL_ID} .picky-header-title{font-size:16px;font-weight:600;display:flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:0;min-width:0;overflow:hidden;text-overflow:ellipsis}
            #${TOOL_ID} .picky-header-title span{white-space:nowrap;word-break:keep-all}
            #${TOOL_ID} .picky-header-title.clickable{cursor:pointer;padding:2px 8px;border-radius:6px}
            #${TOOL_ID} .picky-header-title.clickable:hover{background:rgba(0,0,0,.06)}
            #${TOOL_ID} .picky-header-actions{display:flex;gap:4px;align-items:center;flex-shrink:0;flex-wrap:nowrap}
            #${TOOL_ID} .picky-selector-box{background-color:var(--pk-surf-var);padding:8px 12px;border-radius:12px;margin-bottom:10px}
            #${TOOL_ID} .picky-selector-box-title{font-size:11px;color:var(--pk-on-surf-var);margin-bottom:4px;display:flex;justify-content:space-between}
            #${TOOL_ID} .picky-selector-display{font-family:'SF Mono','Menlo',monospace;font-size:12px;color:var(--pk-on-surf);word-break:break-all;max-height:7em;overflow-y:auto;cursor:pointer;padding:4px;border-radius:6px;border:1px dashed transparent}
            #${TOOL_ID} .picky-selector-display:hover{background-color:rgba(0,122,255,.08);border-color:var(--pk-pri)}
            #${TOOL_ID} .picky-selector-display::after{content:" ✎";color:var(--pk-pri);opacity:.5;font-size:11px}
            #${TOOL_ID} .picky-stats-bar{font-size:11px;color:var(--pk-on-surf-var);padding:4px 8px;background:var(--pk-surf-var);border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
            #${TOOL_ID} .picky-stats-bar .pk-stat-val{color:var(--pk-pri);font-weight:600}
            #${TOOL_ID} hr{border:none;border-top:1px solid var(--pk-surf-var);margin:8px 0}
            #${TOOL_ID} .picky-btn-group{display:grid;gap:6px;margin-bottom:6px}
            #${TOOL_ID} .picky-btn-group-label{font-size:10px;color:var(--pk-on-surf-var);text-transform:uppercase;letter-spacing:.5px;margin:6px 4px 2px}
            #${TOOL_ID} button{padding:8px 6px;border:none;border-radius:14px;font-size:12px;font-weight:500;cursor:pointer;background-color:var(--pk-sec-cont);color:var(--pk-on-sec-cont);transition:background-color .2s,transform .1s;display:flex;align-items:center;justify-content:center;gap:4px;min-height:34px;white-space:nowrap}
            #${TOOL_ID} button:active{transform:scale(.96)}
            #${TOOL_ID} button.primary{background-color:var(--pk-pri-cont);color:var(--pk-on-pri-cont)}
            #${TOOL_ID} button.copied{background-color:var(--pk-succ);color:#fff}
            #${TOOL_ID} button.warn{background-color:var(--pk-warn);color:#fff}
            #${TOOL_ID} button.danger{background-color:var(--pk-err);color:#fff}
            #${TOOL_ID}.minimized{width:36px!important;height:36px!important;border-radius:50%!important;padding:0!important;cursor:pointer;touch-action:none;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(255,255,255,.95)!important;overflow:hidden;max-width:36px!important;max-height:36px!important}
            #${TOOL_ID}.minimized .picky-content,#${TOOL_ID}.minimized .picky-drag-handle{display:none!important}
            #${TOOL_ID} .picky-maximize-button{display:none}
            #${TOOL_ID}.minimized .picky-maximize-button{display:flex!important;width:100%!important;height:100%!important;align-items:center!important;justify-content:center!important;padding:0!important;margin:0!important;border-radius:50%!important;background:transparent!important}
            #${TOOL_ID}.minimized .picky-maximize-button svg{width:20px!important;height:20px!important;display:block!important;margin:auto!important;fill:#1d1d1f!important;pointer-events:none}
            #${TOOL_ID}.minimized .picky-maximize-button svg circle,#${TOOL_ID}.minimized .picky-maximize-button svg path{fill:#1d1d1f!important}
            #${TOOL_ID}.minimal{padding:6px;height:auto}
            #${TOOL_ID}.minimal .picky-content{display:flex;justify-content:space-around;gap:4px;flex-wrap:wrap}
            #${TOOL_ID}.minimal .picky-drag-handle{height:14px;margin-bottom:2px}
            #${TOOL_ID}.minimal button{background:0 0;min-height:auto;padding:4px}
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
            #${TOOL_ID} .picky-pro-section{background:linear-gradient(135deg,rgba(0,122,255,.08),rgba(52,199,89,.06));border:1px solid rgba(0,122,255,.2);border-radius:12px;padding:8px;margin-bottom:10px}
            #${TOOL_ID} .picky-pro-header{font-size:11px;font-weight:600;color:var(--pk-pri);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
            #${TOOL_ID} .picky-pro-header .picky-pro-hint{font-weight:400;color:var(--pk-on-surf-var);font-size:10px}
            #${TOOL_ID} .picky-candidate-list{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto}
            #${TOOL_ID} .picky-candidate-card{background:rgba(255,255,255,.7);border:1.5px solid var(--pk-outl);border-radius:10px;padding:8px 10px;cursor:pointer;transition:all .15s;position:relative}
            #${TOOL_ID} .picky-candidate-card:hover{background:rgba(255,255,255,.95);border-color:var(--pk-pri);transform:translateY(-1px)}
            #${TOOL_ID} .picky-candidate-card.selected{background:rgba(0,122,255,.12);border-color:var(--pk-pri);border-width:2px;padding:7px 9px}
            #${TOOL_ID} .picky-candidate-card.recommended::after{content:"추천";position:absolute;top:6px;right:8px;background:var(--pk-succ);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px}
            #${TOOL_ID} .picky-cand-top{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
            #${TOOL_ID} .picky-cand-icon{font-size:13px}
            #${TOOL_ID} .picky-cand-label{font-size:12px;font-weight:600;color:var(--pk-on-surf)}
            #${TOOL_ID} .picky-cand-stars{font-size:10px;color:var(--pk-warn);letter-spacing:1px}
            #${TOOL_ID} .picky-cand-count{font-size:10px;color:var(--pk-pri);background:rgba(0,122,255,.1);padding:1px 6px;border-radius:6px;font-weight:600}
            #${TOOL_ID} .picky-cand-count.warn{color:var(--pk-warn);background:rgba(255,149,0,.12)}
            #${TOOL_ID} .picky-cand-count.danger{color:var(--pk-err);background:rgba(255,59,48,.12)}
            #${TOOL_ID} .picky-cand-sel{font-family:'SF Mono','Menlo',monospace;font-size:10.5px;color:var(--pk-on-surf);background:rgba(0,0,0,.04);padding:3px 5px;border-radius:4px;word-break:break-all;margin:3px 0;max-height:4em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
            #${TOOL_ID} .picky-cand-hint{font-size:10.5px;color:var(--pk-on-surf-var);line-height:1.3}
            #${TOOL_ID} .picky-pro-empty{padding:12px;text-align:center;color:var(--pk-on-surf-var);font-size:12px}
            .picky-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:2147483647;backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);opacity:0;transition:opacity .3s}
            .picky-modal-overlay.visible{opacity:1}
            .picky-modal-overlay.picky-ads-modal{background:rgba(0,0,0,.2)!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;pointer-events:none}
            .picky-modal-overlay.picky-ads-modal .picky-modal-content{pointer-events:auto;position:fixed!important;top:12px!important;right:12px!important;left:auto!important;transform:none!important;max-width:380px!important;width:calc(100% - 24px)!important;max-height:calc(100vh - 24px)!important}
            .picky-modal-overlay.picky-ads-modal.visible .picky-modal-content{transform:none!important}
            .picky-modal-overlay.picky-ads-modal .picky-modal-header{position:sticky;top:0;background:var(--pk-surf);z-index:2;border-bottom:1px solid var(--pk-outl)}
            .picky-modal-overlay.picky-ads-modal .picky-modal-header .picky-icon-button{background:var(--pk-err)!important;color:#fff!important;width:36px!important;height:36px!important;border-radius:50%!important;flex-shrink:0;box-shadow:0 2px 6px rgba(255,59,48,.4)}
            .picky-modal-overlay.picky-ads-modal .picky-modal-header .picky-icon-button svg{fill:#fff!important;width:22px!important;height:22px!important}
            .picky-modal-overlay.picky-ads-modal .picky-modal-header .picky-icon-button:hover{background:#cc2e25!important}
            .picky-modal-content{position:fixed;top:50%;left:50%;width:calc(100% - 32px);max-width:600px;max-height:80vh;background-color:var(--pk-surf);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;opacity:0;transform:translate(-50%,-45%);transition:opacity .3s,transform .3s}
            .picky-modal-overlay.visible .picky-modal-content{opacity:1;transform:translate(-50%,-50%)}
            .picky-modal-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pk-outl);flex-shrink:0}
            .picky-modal-title{font-size:16px;font-weight:600;color:var(--pk-on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .picky-modal-body{padding:4px 12px 12px;overflow-y:auto;color:var(--pk-on-surf)}
            .picky-modal-body textarea{width:100%;height:50vh;background:var(--pk-surf-var);border:none;border-radius:8px;color:var(--pk-on-surf);font-family:'SF Mono',monospace;font-size:12px;padding:8px;box-sizing:border-box;resize:vertical}
            .picky-edit-modal textarea{width:100%;min-height:120px;background:var(--pk-surf-var);border:1px solid var(--pk-outl);border-radius:8px;color:var(--pk-on-surf);font-family:'SF Mono',monospace;font-size:13px;padding:10px;box-sizing:border-box;resize:vertical;outline:none}
            .picky-edit-modal textarea:focus{border-color:var(--pk-pri)}
            .picky-edit-modal .picky-match-info{margin:10px 0;padding:8px 12px;background:var(--pk-surf-var);border-radius:8px;font-size:13px;color:var(--pk-on-surf)}
            .picky-edit-modal .picky-match-info.error{background:rgba(255,59,48,.15);color:var(--pk-err)}
            .picky-edit-modal .picky-match-info.ok{background:rgba(52,199,89,.15);color:var(--pk-succ)}
            .picky-edit-modal .picky-edit-actions{display:flex;gap:8px;margin-top:10px}
            .picky-edit-modal .picky-edit-actions button{flex:1;padding:10px;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer}
            .picky-child-list,.picky-cookie-table{list-style:none;padding:0;margin:0;width:100%;border-collapse:collapse}
            .picky-child-list li{padding:10px;border-bottom:1px solid var(--pk-outl);cursor:pointer;transition:background-color .2s;font-family:'SF Mono',monospace;font-size:12px;color:var(--pk-on-surf-var)}
            .picky-child-list li:hover{background-color:var(--pk-surf-var)}
            .picky-cookie-table th,.picky-cookie-table td{padding:8px;text-align:left;border-bottom:1px solid var(--pk-outl);font-size:12px}
            .picky-cookie-table th{color:var(--pk-on-surf);font-weight:600}
            .picky-cookie-table td{color:var(--pk-on-surf-var);word-break:break-all}
            .picky-cookie-table .cookie-actions{display:flex;gap:8px}
            .picky-cookie-table .cookie-actions button{padding:4px 8px;font-size:11px;border-radius:8px;background:var(--pk-sec-cont);color:var(--pk-on-sec-cont);border:none;cursor:pointer}
            .picky-cookie-table .cookie-actions button.delete{background-color:var(--pk-err);color:#fff}
            #picky-nav-slider-container{padding:6px 0;touch-action:pan-x;user-select:none;-webkit-user-select:none}
            #picky-nav-slider{width:100%;-webkit-appearance:none;appearance:none;background:var(--pk-outl);height:5px;border-radius:3px;outline:none;cursor:pointer;touch-action:pan-x}
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
            .picky-rule-preview-hover{outline:3px solid orange!important;outline-offset:2px!important;background:rgba(255,165,0,.15)!important;box-shadow:0 0 0 9999px rgba(0,0,0,.25)!important;scroll-margin:80px!important}
            .picky-ad-selected-mark{outline:3px solid #34c759!important;outline-offset:2px!important;background:rgba(52,199,89,.18)!important;scroll-margin:80px!important}
            .picky-ad-selected-mark.picky-rule-preview-hover{outline:3px solid #ffcc00!important;background:rgba(255,204,0,.2)!important}
            .picky-pro-preview-hover{outline:3px solid #007aff!important;outline-offset:2px!important;background:rgba(0,122,255,.12)!important;box-shadow:0 0 0 9999px rgba(0,0,0,.2)!important;scroll-margin:80px!important}`;
        }

        embedGlobalCSS() {
            const e = `.${HL_CLASS}{outline:2px dotted #ff453a!important;outline-offset:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.4)!important;transition:outline .1s,box-shadow .1s}
            html.${ISO_BODY} > body{visibility:hidden!important}
            html.${ISO_BODY} .${ISO_PATH}{visibility:visible!important}
            html.${ISO_BODY} .${ISO_PATH} *{visibility:visible!important}
            .picky-rule-preview-hover{outline:3px solid orange!important;outline-offset:2px!important;background:rgba(255,165,0,.15)!important;box-shadow:0 0 0 9999px rgba(0,0,0,.25)!important}
            .picky-ad-selected-mark{outline:3px solid #34c759!important;outline-offset:2px!important;background:rgba(52,199,89,.18)!important}
            .picky-ad-selected-mark.picky-rule-preview-hover{outline:3px solid #ffcc00!important;background:rgba(255,204,0,.2)!important}
            .picky-pro-preview-hover{outline:3px solid #007aff!important;outline-offset:2px!important;background:rgba(0,122,255,.12)!important;box-shadow:0 0 0 9999px rgba(0,0,0,.2)!important}`;
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
            sh.appendChild(this.dom.tool);
            this.dom.shield = document.createElement("div");
            this.dom.shield.id = SHIELD_ID;
            sh.appendChild(this.dom.shield);
            this.dom.tool.addEventListener("click", this.triggerAction.bind(this));
            this.render();
            this.applyPosition();
            setTimeout(() => this.dom.tool.classList.add("visible"), 50);
            this.watcher = new MutationObserver(() => {
                if (!document.documentElement.contains(this.dom.host)) {
                    document.documentElement.appendChild(this.dom.host);
                }
            });
            this.watcher.observe(document.documentElement, { childList: true });
            window.addEventListener("resize", () => this.applyPosition());
        }

        applyPosition() {
            const t = this.dom.tool;
            if (!t) return;
            t.style.left = ""; t.style.top = ""; t.style.right = ""; t.style.bottom = ""; t.style.transform = "";
            if (this.state.isCollapsed) {
                if (this.state.iconPos) {
                    const { x, y } = this.clampPos(this.state.iconPos, 36, 36);
                    t.style.left = x + "px"; t.style.top = y + "px";
                } else {
                    t.style.right = "20px"; t.style.bottom = "20px";
                }
            } else {
                if (this.state.panelPos) {
                    requestAnimationFrame(() => {
                        const rect = t.getBoundingClientRect();
                        const { x, y } = this.clampPos(this.state.panelPos, rect.width || 300, rect.height || 200);
                        t.style.left = x + "px"; t.style.top = y + "px";
                    });
                } else {
                    t.style.left = "50%"; t.style.bottom = "12px"; t.style.transform = "translateX(-50%)";
                }
            }
        }

        clampPos(pos, w, h) {
            const maxX = Math.max(0, window.innerWidth - w);
            const maxY = Math.max(0, window.innerHeight - h);
            return { x: Math.max(0, Math.min(pos.x, maxX)), y: Math.max(0, Math.min(pos.y, maxY)) };
        }

        render() {
            const t = this.dom.tool;
            if (!t) return;
            t.classList.toggle("minimized", this.state.isCollapsed);
            t.classList.toggle("minimal", !this.state.isCollapsed && this.state.scale === "minimal");
            t.classList.remove("full");
            if (!this.state.isCollapsed && this.state.scale === "full") t.classList.add("full");
            this.dom.shield.style.display = (this.state.mode !== "initial" && this.state.mode !== "selected") || this.state.isCollapsed ? "none" : "block";

            let dragHandle = "";
            if (!this.state.isCollapsed) dragHandle = `<div class="picky-drag-handle" title="드래그로 이동">${ICON_DRAG}</div>`;

            let e = "";
            if (this.state.isCollapsed) {
                e = `<button class="picky-maximize-button picky-icon-button" data-action="cycleSize" title="Picky 열기 (길게 누르면 광고감지)">${ICON_DOT}</button>`;
            } else if (this.state.scale === "minimal") {
                e = dragHandle + `<div class="picky-content">${this.getMinLayout()}</div>`;
            } else {
                e = dragHandle + `<div class="picky-content">${this.getFullLayout()}</div>`;
            }
            t.innerHTML = e;

            if (this.state.mode === "selected") {
                this.attachRefs();
                this.refreshMetrics();
                if (this.state.isPro) this.renderProCandidates();
            }

            this.attachDragHandlers();
            if (this.state.isCollapsed) this.attachLongPressOnDot();
        }

        renderProCandidates() {
            const container = this.dom.tool.querySelector(".picky-pro-section");
            if (!container) return;
            const list = container.querySelector(".picky-candidate-list");
            if (!list) return;
            const cands = this.state.proCandidates;
            if (!cands.length) {
                list.innerHTML = `<div class="picky-pro-empty">이 요소에 대한 후보를 찾을 수 없어요.</div>`;
                return;
            }
            list.innerHTML = cands.map((c, i) => {
                const stars = SelectorStrategies.scoreToStars(c.score);
                const countClass = c.count === 1 ? "" : c.count > 30 ? "danger" : c.count > 5 ? "warn" : "";
                const selectedClass = (i === this.state.proSelectedIdx) ? " selected" : "";
                const recClass = c.recommended ? " recommended" : "";
                return `<div class="picky-candidate-card${selectedClass}${recClass}" data-cand-idx="${i}" data-action="pickCand">
                    <div class="picky-cand-top">
                        <span class="picky-cand-icon">${c.icon}</span>
                        <span class="picky-cand-label">${esc(c.label)}</span>
                        <span class="picky-cand-stars" title="안정성">${stars}</span>
                        <span class="picky-cand-count ${countClass}">${c.count}개</span>
                    </div>
                    <div class="picky-cand-sel">${esc(c.selector)}</div>
                    <div class="picky-cand-hint">${esc(c.hint)}</div>
                </div>`;
            }).join("");

            list.querySelectorAll(".picky-candidate-card").forEach(card => {
                const idx = parseInt(card.dataset.candIdx, 10);
                card.addEventListener("mouseenter", () => this.previewProCandidate(idx));
                card.addEventListener("mouseleave", () => this.clearProPreview());
                card.addEventListener("touchstart", () => this.previewProCandidate(idx), { passive: true });
            });
        }

        previewProCandidate(idx) {
            this.clearProPreview();
            const c = this.state.proCandidates[idx];
            if (!c) return;
            try {
                const nodes = document.querySelectorAll(c.selector);
                nodes.forEach(el => {
                    el.classList.add("picky-pro-preview-hover");
                    this.state.proPreviewNodes.push(el);
                });
                if (nodes[0]) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch(e) {}
        }
        clearProPreview() {
            this.state.proPreviewNodes.forEach(el => el.classList.remove("picky-pro-preview-hover"));
            this.state.proPreviewNodes = [];
        }

        attachDragHandlers() {
            const t = this.dom.tool;
            if (!t) return;
            const isInteractive = (target) => {
                if (!target || target.nodeType !== 1) return false;
                try { return !!target.closest(NO_DRAG_SELECTOR); } catch(e) { return false; }
            };
            const start = (clientX, clientY) => {
                const rect = t.getBoundingClientRect();
                this.state.isDragging = true;
                this.state.dragOffset = { x: clientX - rect.left, y: clientY - rect.top };
                this.state.dragStart = { x: clientX, y: clientY };
                this.state.dragDidMove = false;
                this.state.dragTarget = this.state.isCollapsed ? "icon" : "panel";
                t.classList.add("dragging");
            };
            const move = (clientX, clientY) => {
                if (!this.state.isDragging) return;
                const dx = Math.abs(clientX - this.state.dragStart.x);
                const dy = Math.abs(clientY - this.state.dragStart.y);
                if (dx > 5 || dy > 5) this.state.dragDidMove = true;
                let nx = clientX - this.state.dragOffset.x;
                let ny = clientY - this.state.dragOffset.y;
                const rect = t.getBoundingClientRect();
                nx = Math.max(0, Math.min(nx, window.innerWidth - rect.width));
                ny = Math.max(0, Math.min(ny, window.innerHeight - rect.height));
                t.style.left = nx + "px"; t.style.top = ny + "px";
                t.style.right = "auto"; t.style.bottom = "auto"; t.style.transform = "none";
            };
            const end = () => {
                if (!this.state.isDragging) return;
                this.state.isDragging = false;
                t.classList.remove("dragging");
                if (this.state.dragDidMove) {
                    const rect = t.getBoundingClientRect();
                    const pos = { x: rect.left, y: rect.top };
                    if (this.state.dragTarget === "icon") {
                        this.state.iconPos = pos; GM_setValue("picky_icon_pos", pos);
                    } else {
                        this.state.panelPos = pos; GM_setValue("picky_panel_pos", pos);
                    }
                }
                this.state.dragTarget = null;
            };
            const onMouseDown = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (!this.state.isCollapsed) {
                    if (!e.target.closest(".picky-drag-handle")) return;
                } else {
                    if (isInteractive(e.target) && !e.target.closest(".picky-maximize-button")) return;
                }
                e.preventDefault();
                start(e.clientX, e.clientY);
                const mm = ev => move(ev.clientX, ev.clientY);
                const mu = ev => {
                    document.removeEventListener("mousemove", mm, true);
                    document.removeEventListener("mouseup", mu, true);
                    end();
                    if (this.state.dragDidMove) { ev.stopPropagation(); ev.preventDefault(); }
                };
                document.addEventListener("mousemove", mm, true);
                document.addEventListener("mouseup", mu, true);
            };
            t.addEventListener("mousedown", onMouseDown);
            const onTouchStart = (e) => {
                if (!this.state.isCollapsed) {
                    if (!e.target.closest(".picky-drag-handle")) return;
                } else {
                    if (isInteractive(e.target) && !e.target.closest(".picky-maximize-button")) return;
                }
                const tt = e.touches[0];
                start(tt.clientX, tt.clientY);
            };
            const onTouchMove = (e) => {
                if (!this.state.isDragging) return;
                e.preventDefault();
                const tt = e.touches[0];
                move(tt.clientX, tt.clientY);
            };
            t.addEventListener("touchstart", onTouchStart, { passive: true });
            t.addEventListener("touchmove", onTouchMove, { passive: false });
            t.addEventListener("touchend", end);
            t.addEventListener("touchcancel", end);
        }

        attachLongPressOnDot() {
            const t = this.dom.tool;
            if (!t) return;
            const cancel = () => { if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } };
            const startLP = () => {
                cancel();
                this.longPressTimer = setTimeout(() => {
                    this.longPressTimer = null;
                    if (this.state.isDragging || this.state.dragDidMove) return;
                    if (navigator.vibrate) try { navigator.vibrate(50); } catch(e) {}
                    if (this.state.isCollapsed) {
                        this.state.isCollapsed = false;
                        this.state.scale = "full";
                        this.render();
                        this.applyPosition();
                    }
                    this.suggestAds();
                }, 600);
            };
            t.addEventListener("mousedown", e => { if (!this.state.isCollapsed) return; startLP(); });
            t.addEventListener("touchstart", e => { if (!this.state.isCollapsed) return; startLP(); }, { passive: true });
            ["mouseup","mouseleave","touchend","touchcancel","touchmove"].forEach(ev => t.addEventListener(ev, cancel));
        }

        getFullLayout() {
            if (this.state.mode === "selected") return this.getSelLayout();
            if (this.state.mode === "settings") return this.getSetLayout();
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            return `<div class="picky-header"><div class="picky-header-title"><span>요소 선택기</span></div><div class="picky-header-actions"><button class="picky-icon-button" data-action="showSettings" title="설정">${ICON_SETTINGS}</button><button class="picky-icon-button" data-action="minimize" title="최소화">${ICON_CLOSE}</button></div></div>
            <div class="picky-stats-bar"><span>이 사이트: <span class="pk-stat-val">${stats.ruleCount}</span>개 규칙 / <span class="pk-stat-val">${stats.hiddenCount}</span>개 숨김</span><span>${enabled ? '🟢 ON' : '🔴 OFF'}</span></div>
            <div style="text-align:center;color:var(--pk-on-surf-var);padding:14px 0;font-size:13px;">페이지에서 요소를 탭/클릭하세요<br><span style="font-size:11px;opacity:.7">Ctrl+Shift+P 토글 / 화살표 키 탐색</span></div>
            <div class="picky-btn-group-label">빠른 작업</div>
            <div class="picky-btn-group" style="grid-template-columns:repeat(3,1fr)">
                <button data-action="suggestAds" class="warn">🎯 자동감지</button>
                <button data-action="toggleBlocking">${enabled ? '⏸ 일시정지' : '▶ 다시 켜기'}</button>
                <button data-action="undoLast">↩ 되돌리기</button>
            </div>`;
        }

        getSelLayout() {
            const t = this.calcSliderLimits();
            const slider = `<div id="picky-nav-slider-container" data-no-drag><label for="picky-nav-slider" style="font-size:11px;color:var(--pk-on-surf-var)">요소 탐색 (← 상위 / 하위 →)</label><input type="range" id="picky-nav-slider" min="${t.min}" max="${t.max}" value="${t.val}" data-no-drag></div>`;

            const proSection = this.state.isPro ? `
            <div class="picky-pro-section">
                <div class="picky-pro-header">
                    <span>⚡ Pro 모드 — 차단 전략 선택</span>
                    <span class="picky-pro-hint">호버로 미리보기 · 카드 클릭으로 선택</span>
                </div>
                <div class="picky-candidate-list"></div>
            </div>` : "";

            return `<div class="picky-header">
                <div class="picky-header-title clickable" data-action="goHome" title="홈으로">${ICON_HOME}<span>요소 선택됨</span></div>
                <div class="picky-header-actions">
                    <button class="picky-icon-button" data-action="suggestAds" title="광고 자동 감지" style="color:var(--pk-warn)">${ICON_TARGET}</button>
                    <button class="picky-icon-button" data-action="inspectCode" title="연관 코드">${ICON_CODE}</button>
                    <button class="picky-icon-button" data-action="showSettings" title="설정">${ICON_SETTINGS}</button>
                    <button class="picky-icon-button" data-action="cycleSize" title="모드 전환">${ICON_MIN}</button>
                    <button class="picky-icon-button" data-action="minimize" title="최소화">${ICON_CLOSE}</button>
                </div></div>
            <div class="picky-selector-box">
                <div class="picky-selector-box-title"><span>${this.state.isPro ? "선택한 차단 규칙" : "CSS 선택자 (탭=직접 편집)"}</span><span class="picky-match-count"></span></div>
                <div class="picky-selector-display" data-action="editSelector"></div>
            </div>
            ${proSection}
            ${slider}
            <div class="picky-btn-group-label">탐색 / 액션</div>
            <div class="picky-btn-group" style="grid-template-columns:repeat(3,1fr)">
                <button data-action="selParent">⬆ 상위</button>
                <button data-action="selChild">⬇ 하위</button>
                <button data-action="selSimilar">≡ 유사</button>
                <button data-action="toggleHide">${this.state.isObscured ? "👁 복원" : "🚫 숨김"}</button>
                <button data-action="toggleIsolate">${this.state.isQuarantined ? "📤 해제" : "📦 격리"}</button>
                <button data-action="permanentBlock" class="danger">⛔ 차단</button>
            </div>
            <div class="picky-btn-group-label">추출 / 복사 / 기타</div>
            <div class="picky-btn-group" style="grid-template-columns:repeat(3,1fr)">
                <button data-action="extractUrl">🔗 URL</button>
                <button data-action="extractAttr">🏷 속성</button>
                <button data-action="togglePro" class="${this.state.isPro ? 'primary' : ''}">${this.state.isPro ? '⚡ Pro ON' : '⚡ Pro'}</button>
                <button data-action="copyCSS" class="primary">📋 CSS</button>
                <button data-action="copyRule" class="primary">📋 규칙</button>
                <button data-action="reset">🔄 리셋</button>
            </div>`;
        }

        getMinLayout() {
            return `<button class="picky-icon-button" data-action="selParent" title="상위">${ICON_UP}</button>
            <button class="picky-icon-button" data-action="selChild" title="하위">${ICON_DOWN}</button>
            <button class="picky-icon-button" data-action="toggleHide" title="${this.state.isObscured ? "복원" : "숨김"}">${this.state.isObscured ? ICON_EYE : ICON_EYE_OFF}</button>
            <button class="picky-icon-button" data-action="suggestAds" title="광고 자동 감지" style="color:var(--pk-warn)">${ICON_TARGET}</button>
            <button class="picky-icon-button" data-action="copyCSS" title="CSS 복사">${ICON_COPY}</button>
            <button class="picky-icon-button" data-action="reset" title="초기화">${ICON_RESET}</button>
            <button class="picky-icon-button" data-action="cycleSize" title="전체 모드">${ICON_MAX}</button>`;
        }

        getSetLayout() {
            const t = this.config;
            const e = t.intelligentMode ? 'style="display:none;"' : "";
            const stats = Blocker.getStats();
            const enabled = Blocker.isEnabled();
            const aggressive = Blocker.isAggressive();
            return `<div class="picky-header"><button class="picky-icon-button" data-action="showSelected">${ICON_BACK}</button><div class="picky-header-title"><span>설정</span></div><div class="picky-header-actions"><button class="picky-icon-button" data-action="showSelected">${ICON_CLOSE}</button></div></div>
            <div class="picky-stats-bar"><span>전역: <span class="pk-stat-val">${stats.totalSites}</span>사이트 / <span class="pk-stat-val">${stats.totalRules}</span>규칙</span><span>현재: <span class="pk-stat-val">${stats.ruleCount}</span>개</span></div>
            <button data-action="suggestAds" class="warn" style="width:100%;padding:12px;margin-bottom:8px;font-size:14px;">🎯 광고 자동 감지 (이 페이지 스캔)</button>
            <div class="picky-setting-item"><span>복사 후 자동 닫기</span><label class="picky-switch"><input type="checkbox" data-action="toggleAutoClose" ${this.state.autoDismiss ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-item"><span>차단 활성화</span><label class="picky-switch"><input type="checkbox" data-action="toggleBlockingSwitch" ${enabled ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-item"><span>공격적 차단 (공간 제거)</span><label class="picky-switch"><input type="checkbox" data-action="toggleAggressive" ${aggressive ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-item"><span>⚡ Pro 모드 (다중 후보)</span><label class="picky-switch"><input type="checkbox" data-action="toggleProSwitch" ${this.state.isPro ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-title">선택자 생성 규칙 (기본 모드)</div>
            <div class="picky-setting-item"><span>지능형 모드</span><label class="picky-switch"><input type="checkbox" data-cfg-key="intelligentMode" ${t.intelligentMode ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-manual-settings" ${e}>
                <div class="picky-setting-item"><span>ID 사용 (#id)</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useId" ${t.useId ? "checked" : ""}><span class="picky-slider"></span></label></div>
                <div class="picky-setting-item"><span>클래스 사용</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useClasses" ${t.useClasses ? "checked" : ""}><span class="picky-slider"></span></label></div>
                <div class="picky-setting-item"><span>순서 사용</span><label class="picky-switch"><input type="checkbox" data-cfg-key="useNthOfType" ${t.useNthOfType ? "checked" : ""}><span class="picky-slider"></span></label></div>
            </div>
            <div class="picky-setting-title">고급</div>
            <div class="picky-setting-item"><span>Shadow DOM 호환</span><label class="picky-switch"><input type="checkbox" data-cfg-key="shadowDomSupport" ${t.shadowDomSupport ? "checked" : ""}><span class="picky-slider"></span></label></div>
            <div class="picky-setting-title">규칙 관리</div>
            <div class="picky-btn-group" style="grid-template-columns:1fr 1fr">
                <button data-action="showBlockRules">📋 규칙 보기</button>
                <button data-action="resetBlocks" class="danger">🗑 규칙 초기화</button>
            </div>
            <div class="picky-setting-title">백업 / 가져오기</div>
            <div class="picky-btn-group" style="grid-template-columns:1fr 1fr 1fr">
                <button data-action="exportJSON">📤 JSON</button>
                <button data-action="exportUblock">📤 uBlock</button>
                <button data-action="importJSON" class="primary">📥 불러오기</button>
            </div>
            <div class="picky-setting-title">개발자 도구 / UI</div>
            <div class="picky-btn-group" style="grid-template-columns:repeat(3,1fr)">
                <button data-action="showSource" data-type="html">HTML</button>
                <button data-action="showSource" data-type="css">CSS</button>
                <button data-action="showSource" data-type="js">JS</button>
                <button data-action="showCookies">🍪 쿠키</button>
                <button data-action="showFp">🔍 FP</button>
                <button data-action="resetIconPos">📍 아이콘위치 초기화</button>
                <button data-action="resetPanelPos">📐 패널위치 초기화</button>
                <button data-action="terminate" class="danger">❌ 완전 종료</button>
            </div>`;
        }

        attachRefs() {
            this.dom.disp = this.dom.tool.querySelector(".picky-selector-display");
            this.dom.match = this.dom.tool.querySelector(".picky-match-count");
            this.dom.slider = this.dom.tool.querySelector("#picky-nav-slider");
            if (this.dom.slider) {
                this.dom.slider.addEventListener("input", this.handleSlide.bind(this));
                const stopBubble = ev => ev.stopPropagation();
                ["mousedown","mousemove","mouseup","touchstart","touchmove","touchend","pointerdown","pointermove","pointerup","click"].forEach(evt => {
                    this.dom.slider.addEventListener(evt, stopBubble, evt.startsWith("touch") ? { passive: true } : false);
                });
            }
            const sliderContainer = this.dom.tool.querySelector("#picky-nav-slider-container");
            if (sliderContainer) {
                const stopBubble = ev => ev.stopPropagation();
                ["mousedown","touchstart","pointerdown"].forEach(evt => {
                    sliderContainer.addEventListener(evt, stopBubble, evt.startsWith("touch") ? { passive: true } : false);
                });
            }
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
                if (this.state.isPro) this.renderProCandidates();
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

        minimizeUI() {
            this.purge();
            this.clearRulePreview();
            this.clearAdSelections();
            this.clearProPreview();
            this.overlay?.dismiss();
            this.dropFocus(this.state.target);
            this.state.target = null;
            this.state.originTarget = null;
            this.state.hierarchy = [];
            this.state.proCandidates = [];
            this.state.mode = "initial";
            this.state.scale = "full";
            this.state.isCollapsed = true;
            this.render();
            this.applyPosition();
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
                minimize: () => this.minimizeUI(),
                terminate: () => {
                    if (confirm("Picky를 완전히 종료할까요? 다시 사용하려면 페이지를 새로고침해야 합니다.")) this.terminate(true);
                },
                cycleSize: () => {
                    if (this.state.isCollapsed) {
                        this.state.isCollapsed = false;
                        this.state.scale = "full";
                        this.render();
                        this.applyPosition();
                    } else if (this.state.scale === "full") {
                        this.state.scale = "minimal";
                        this.render();
                        this.applyPosition();
                    } else {
                        this.minimizeUI();
                    }
                },
                showSettings: () => { this.state.mode = "settings"; this.render(); },
                showSelected: () => { this.state.mode = this.state.target ? "selected" : "initial"; this.render(); },
                goHome: () => {
                    this.purge();
                    this.dropFocus(this.state.target);
                    this.state.target = null;
                    this.state.originTarget = null;
                    this.state.hierarchy = [];
                    this.state.mode = "initial";
                    this.render();
                },
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
                    this.applyPosition();
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
                        if (this.state.isPro) this.renderProCandidates();
                        this.render();
                    }
                },
                selChild: () => this.displayChildOptions(),
                selSimilar: () => {
                    const q = this.evaluateCssBasic(this.state.target);
                    const cleaned = q.selector.replace(/:nth-of-type\(\d+\)/g, "");
                    if (this.dom.disp) this.dom.disp.textContent = cleaned + (q.root instanceof ShadowRoot ? " (in Shadow DOM)" : "");
                    this.state.queryData = { selector: cleaned, root: q.root };
                    this.state.hits = this.countMatches(cleaned);
                    if (this.dom.match) this.dom.match.textContent = `${this.state.hits}개 일치`;
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
                    if (confirm(`다음 선택자를 영구 차단하시겠습니까?\n\n${selector}`)) {
                        Blocker.append(selector);
                        actions.reset();
                    }
                },
                undoLast: () => {
                    const last = Blocker.undoLast();
                    if (last) alert(`되돌림:\n${last.selector}\n(${last.host})`);
                    else alert("되돌릴 기록이 없습니다.");
                    this.render();
                },
                toggleBlocking: () => {
                    const on = Blocker.toggleEnabled();
                    alert(on ? "차단 활성화됨" : "차단 일시정지됨");
                    this.render();
                },
                toggleBlockingSwitch: () => { Blocker.toggleEnabled(); this.render(); },
                toggleAggressive: () => { Blocker.toggleAggressive(); this.render(); },
                toggleProSwitch: () => {
                    this.state.isPro = e.checked;
                    GM_setValue("picky_pro_mode", this.state.isPro);
                    this.render();
                },
                exportJSON: () => Blocker.exportJSON(),
                exportUblock: () => Blocker.exportUblock(),
                importJSON: () => Blocker.importJSON(),
                showBlockRules: () => this.showRulesWithPreview(),
                resetBlocks: () => {
                    if (confirm(`현재 사이트(${window.location.hostname})의 모든 차단 규칙을 삭제하시겠습니까?`)) Blocker.clear();
                },
                togglePro: () => {
                    this.state.isPro = !this.state.isPro;
                    GM_setValue("picky_pro_mode", this.state.isPro);
                    this.refreshMetrics();
                    this.render();
                },
                pickCand: () => {
                    const card = e.closest("[data-cand-idx]");
                    if (!card) return;
                    const idx = parseInt(card.dataset.candIdx, 10);
                    const c = this.state.proCandidates[idx];
                    if (!c) return;
                    this.state.proSelectedIdx = idx;
                    this.state.queryData = { selector: c.selector, root: document };
                    this.state.hits = c.count;
                    if (this.dom.disp) this.dom.disp.textContent = c.selector;
                    if (this.dom.match) this.dom.match.textContent = `${c.count}개 일치`;
                    this.dom.tool.querySelectorAll(".picky-candidate-card").forEach((el, i) => {
                        el.classList.toggle("selected", i === idx);
                    });
                },
                toggleIsolate: () => this.toggleIsolation(),
                copyCSS: () => this.clip(false),
                copyRule: () => this.clip(true),
                toggleAutoClose: () => {
                    this.state.autoDismiss = e.checked;
                    GM_setValue("picky_auto_close", this.state.autoDismiss);
                },
                resetIconPos: () => {
                    this.state.iconPos = null;
                    GM_setValue("picky_icon_pos", null);
                    this.applyPosition();
                    alert("아이콘 위치가 초기화되었습니다 (우측 하단).");
                },
                resetPanelPos: () => {
                    this.state.panelPos = null;
                    GM_setValue("picky_panel_pos", null);
                    this.applyPosition();
                    alert("패널 위치가 초기화되었습니다 (하단 가운데).");
                },
                extractUrl: () => this.pullUrl(),
                extractAttr: () => this.pullAttr(),
                inspectCode: () => this.openInspector(),
                showSource: () => this.printSource(a),
                showCookies: () => this.printCookies(),
                showFp: () => this.printFp(),
                editSelector: () => this.editSelector(),
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
                    if (this.state.autoDismiss) this.minimizeUI();
                    else { btn.innerHTML = old; btn.classList.remove("copied"); }
                }, 1200);
            }).catch(() => {
                prompt("복사 실패:", txt);
                if (this.state.autoDismiss) this.minimizeUI();
            });
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
                    if (this.state.isPro) this.renderProCandidates();
                }
                this.overlay.dismiss();
            });
        }

        showRulesWithPreview() {
            const renderList = () => {
                const rules = Blocker.fetch();
                if (rules.length === 0) return '<div style="padding:20px;text-align:center;color:var(--pk-on-surf-var);">저장된 차단 규칙이 없습니다.</div>';
                return `<p style="font-size:11px;color:var(--pk-on-surf-var);margin-bottom:10px;">규칙에 호버하면 해당 요소가 하이라이트됩니다.</p>
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
            body.addEventListener("mouseout", e => { if (e.target.closest("[data-rule-hover]")) this.clearRulePreview(); });
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
        clearAdSelections() {
            this.state.adSelectedNodes.forEach(el => el.classList.remove("picky-ad-selected-mark"));
            this.state.adSelectedNodes = [];
        }

        editSelector() {
            const current = this.state.queryData.selector;
            if (!current) return;
            const html = `<div class="picky-edit-modal">
                <label style="font-size:12px;color:var(--pk-on-surf-var);">CSS 선택자를 직접 편집하세요:</label>
                <textarea id="picky-edit-textarea" spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>
                <div class="picky-match-info" id="picky-edit-match">검사 중...</div>
                <div class="picky-edit-actions">
                    <button data-edit-action="cancel" style="background:var(--pk-sec-cont);color:var(--pk-on-sec-cont);">취소</button>
                    <button data-edit-action="apply" class="primary" style="background:var(--pk-pri);color:#fff;">적용</button>
                </div>
            </div>`;
            this.overlay.display("선택자 직접 편집", html, true);
            const body = this.overlay.node.querySelector(".picky-modal-body");
            const ta = body.querySelector("#picky-edit-textarea");
            const info = body.querySelector("#picky-edit-match");
            ta.value = current;
            const validate = () => {
                const v = ta.value.trim();
                if (!v) { info.textContent = "선택자가 비어 있습니다."; info.className = "picky-match-info error"; return null; }
                try {
                    const matches = document.querySelectorAll(v);
                    info.textContent = `✓ 유효함 — ${matches.length}개 요소 일치`;
                    info.className = "picky-match-info ok";
                    return { v, matches };
                } catch(err) {
                    info.textContent = "✗ 올바르지 않은 선택자: " + err.message;
                    info.className = "picky-match-info error";
                    return null;
                }
            };
            validate();
            ta.addEventListener("input", validate);
            setTimeout(() => { ta.focus(); ta.select(); }, 100);
            body.addEventListener("click", e => {
                const btn = e.target.closest("[data-edit-action]");
                if (!btn) return;
                if (btn.dataset.editAction === "cancel") { this.overlay.dismiss(); return; }
                if (btn.dataset.editAction === "apply") {
                    const result = validate();
                    if (!result) { alert("올바르지 않은 선택자입니다."); return; }
                    this.state.queryData.selector = result.v;
                    this.state.hits = result.matches.length;
                    if (this.dom.disp) this.dom.disp.textContent = result.v;
                    if (this.dom.match) this.dom.match.textContent = `${result.matches.length}개 일치`;
                    if (result.matches[0]) {
                        this.dropFocus(this.state.target);
                        this.state.target = result.matches[0];
                        this.setFocus(this.state.target);
                    }
                    this.overlay.dismiss();
                }
            });
            ta.addEventListener("keydown", e => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    body.querySelector('[data-edit-action="apply"]').click();
                }
            });
        }

        suggestAds() {
            const adKw = /(^|[-_])(ad|ads|advert|banner|sponsor|promot|popup|sponsored)([-_]|$|s)/i;
            const candidates = [];
            const stdAdSizes = [[300,250],[728,90],[160,600],[320,50],[300,600],[336,280],[970,250],[468,60]];

            document.querySelectorAll('div, section, iframe, aside, ins, img').forEach(el => {
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
                if (el.tagName === 'IMG') {
                    if (AD_NETWORK_HOSTS.some(h => src.includes(h))) { score += 6; reasons.push('img-ad-host'); }
                    if (AD_PATH_PATTERNS.some(p => src.includes(p.kw))) { score += 3; reasons.push('img-ad-path'); }
                }
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
            if (top.length === 0) { alert("광고로 의심되는 요소를 찾지 못했어요."); return; }

            const html = `<p style="font-size:12px;color:var(--pk-on-surf-var);margin-bottom:10px;line-height:1.5;">📌 항목에 <b>호버/터치</b>하면 페이지에서 <span style="color:#ff9500;font-weight:bold;">주황색</span>으로 표시되고 자동 스크롤됩니다.<br>체크하면 <span style="color:#34c759;font-weight:bold;">초록색</span>으로 고정 표시됩니다.<br>❌ 이 창을 닫으려면 <b style="color:#ff3b30;">우측 상단의 빨간 X 버튼</b>을 누르세요.</p>
            <div style="max-height:50vh;overflow-y:auto;">
            ${top.map((c, i) => {
                const preview = `${c.el.tagName.toLowerCase()}${c.el.id ? '#' + c.el.id : ''}${c.el.className ? '.' + String(c.el.className).split(' ').filter(Boolean).slice(0,2).join('.') : ''}`;
                return `<label class="picky-ad-suggest-item" data-idx="${i}">
                    <input type="checkbox" data-idx="${i}">
                    <span class="picky-ad-suggest-score">${c.score}</span>
                    <span style="flex:1;font-family:monospace;font-size:11px;word-break:break-all;">${esc(preview)}<br><span style="color:var(--pk-on-surf-var);font-size:10px;">${esc(c.reasons.join(', '))}</span></span>
                </label>`;
            }).join("")}</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
                <button data-suggest-action="selectAll" style="flex:1;min-width:90px;padding:8px;background:var(--pk-sec-cont);border:none;border-radius:8px;cursor:pointer;">전체 선택</button>
                <button data-suggest-action="clearSel" style="flex:1;min-width:90px;padding:8px;background:var(--pk-sec-cont);border:none;border-radius:8px;cursor:pointer;">선택 해제</button>
                <button data-suggest-action="closeAds" style="flex:1;min-width:90px;padding:8px;background:var(--pk-sec-cont);border:none;border-radius:8px;cursor:pointer;">✖ 닫기</button>
            </div>
            <button data-suggest-action="blockSelected" style="width:100%;padding:10px;margin-top:8px;background:var(--pk-err);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">⛔ 선택 항목 영구 차단</button>`;

            this.overlay.display(`광고 자동 감지 (${top.length}개)`, html, true, "picky-ads-modal");
            const body = this.overlay.node.querySelector(".picky-modal-body");

            const applyCheckMark = (idx, checked) => {
                const item = top[idx];
                if (!item) return;
                if (checked) {
                    if (!item.el.classList.contains("picky-ad-selected-mark")) {
                        item.el.classList.add("picky-ad-selected-mark");
                        this.state.adSelectedNodes.push(item.el);
                    }
                } else {
                    item.el.classList.remove("picky-ad-selected-mark");
                    this.state.adSelectedNodes = this.state.adSelectedNodes.filter(x => x !== item.el);
                }
            };

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
            body.addEventListener("mouseout", e => { if (e.target.closest("label[data-idx]")) this.clearRulePreview(); });
            body.addEventListener("touchstart", e => {
                const lbl = e.target.closest("label[data-idx]");
                if (!lbl) return;
                this.clearRulePreview();
                const item = top[parseInt(lbl.dataset.idx, 10)];
                if (item) {
                    item.el.classList.add("picky-rule-preview-hover");
                    this.state.hoverPreviewNodes.push(item.el);
                    item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, { passive: true });
            body.addEventListener("change", e => {
                const cb = e.target.closest('input[type=checkbox][data-idx]');
                if (!cb) return;
                applyCheckMark(parseInt(cb.dataset.idx, 10), cb.checked);
            });
            body.addEventListener("click", e => {
                const btn = e.target.closest("[data-suggest-action]");
                if (!btn) return;
                const act = btn.dataset.suggestAction;
                if (act === "selectAll") {
                    body.querySelectorAll('input[type=checkbox][data-idx]').forEach(cb => { cb.checked = true; applyCheckMark(parseInt(cb.dataset.idx, 10), true); });
                } else if (act === "clearSel") {
                    body.querySelectorAll('input[type=checkbox][data-idx]').forEach(cb => { cb.checked = false; applyCheckMark(parseInt(cb.dataset.idx, 10), false); });
                } else if (act === "closeAds") {
                    this.overlay.dismiss();
                } else if (act === "blockSelected") {
                    const selected = Array.from(body.querySelectorAll('input[type=checkbox][data-idx]:checked'));
                    if (selected.length === 0) { alert("선택된 항목이 없어요."); return; }
                    if (!confirm(`${selected.length}개 요소를 영구 차단하시겠습니까?`)) return;
                    let added = 0;
                    selected.forEach(cb => {
                        const item = top[parseInt(cb.dataset.idx, 10)];
                        if (item) {
                            const sel = this.evaluateCssBasic(item.el).selector;
                            if (sel && Blocker.append(sel)) added++;
                        }
                    });
                    this.clearRulePreview();
                    this.clearAdSelections();
                    alert(`${added}개 규칙이 추가되었습니다.`);
                    this.overlay.dismiss();
                    this.render();
                }
            });
            const originalDismiss = this.overlay.dismiss.bind(this.overlay);
            this.overlay.dismiss = () => {
                this.clearRulePreview();
                this.clearAdSelections();
                this.overlay.dismiss = originalDismiss;
                originalDismiss();
            };
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
                s += t.style.cssText ? `${this.evaluateCssBasic(t).selector} {\n  ${t.style.cssText.replace(/; /g, ";\n  ")}\n}\n\n` : "없음\n\n";
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
                return s + (cs ? `${this.evaluateCssBasic(t).selector} {\n${cs}}\n` : "추가 계산된 스타일 없음\n");
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
            if (type === "html") { title = "HTML (현재 DOM)"; body = document.documentElement.outerHTML; }
            else if (type === "css") {
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

            this.keyHandler = (e) => {
                if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
                    e.preventDefault();
                    if (this.state.isCollapsed) { this.state.isCollapsed = false; this.state.scale = "full"; }
                    else this.state.isCollapsed = true;
                    this.render();
                    this.applyPosition();
                    return;
                }
                if (e.key === 'Escape' && !this.state.isCollapsed) {
                    if (this.overlay.node) { this.overlay.dismiss(); return; }
                    this.minimizeUI();
                    return;
                }
                if (this.state.mode === 'selected' && !this.state.isCollapsed && !e.target.closest('input, textarea')) {
                    if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        this.triggerAction({ target: { closest: sel => sel === '[data-action]' ? { dataset: { action: 'selParent' } } : null } });
                    } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        this.triggerAction({ target: { closest: sel => sel === '[data-action]' ? { dataset: { action: 'selChild' } } : null } });
                    }
                }
            };
            window.addEventListener('keydown', this.keyHandler, true);

            try {
                GM_registerMenuCommand("🎯 광고 자동 감지", () => {
                    if (this.state.isCollapsed) { this.state.isCollapsed = false; this.render(); this.applyPosition(); }
                    this.suggestAds();
                });
                GM_registerMenuCommand("⚡ Pro 모드 토글", () => {
                    this.state.isPro = !this.state.isPro;
                    GM_setValue("picky_pro_mode", this.state.isPro);
                    alert(this.state.isPro ? "Pro 모드 ON" : "Pro 모드 OFF");
                    this.render();
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
                GM_registerMenuCommand("📍 아이콘 위치 초기화", () => {
                    GM_setValue("picky_icon_pos", null);
                    this.state.iconPos = null;
                    this.applyPosition();
                });
                GM_registerMenuCommand("📐 패널 위치 초기화", () => {
                    GM_setValue("picky_panel_pos", null);
                    this.state.panelPos = null;
                    this.applyPosition();
                });
            } catch(e) {}
        }

        terminate(purge = true) {
            if (purge) this.purge();
            this.clearRulePreview();
            this.clearAdSelections();
            this.clearProPreview();
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new Inspector().launch());
    } else {
        new Inspector().launch();
    }

})();
