// ==UserScript==
// @name        Web 성능 종합 최적화 도구상자 (v39.0 MAX Ultra)
// @namespace   http://tampermonkey.net/
// @version     39.0.0-KR-MAX-Ultra
// @description [MAX Ultra] MutationObserver + WebGL 튜닝 + Speculation Rules + GPU 가속
// @author      KiwiFruit (Architected by User & AI)
// @match       *://*/*
// @grant       unsafeWindow
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    const uWin = unsafeWindow || window;
    const rIC = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));

    // ==========================================
    // 0. Trusted Types Policy
    // ==========================================
    let ttPolicy = null;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            ttPolicy = window.trustedTypes.createPolicy('perfXPolicy', {
                createHTML: (string) => string,
            });
        } catch (e) {}
    }
    const safeHTML = (html) => ttPolicy ? ttPolicy.createHTML(html) : html;

    // ==========================================
    // 1. Critical Safety Checks
    // ==========================================
    const CRITICAL_DOMAINS = ['upbit.com', 'binance.com', 'gov.kr', 'hometax.go.kr', 'nts.go.kr'];
    if (CRITICAL_DOMAINS.some(d => window.location.hostname.endsWith(d))) {
        uWin.perfx = { status: () => '🔒 Critical Mode (Inactive)' };
        return;
    }

    // ==========================================
    // 2. Configuration
    // ==========================================
    const Env = {
        storageKey: `PerfX_v39_${window.location.hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } },
        setOverride(key, val) {
            const data = this.getOverrides(); data[key] = val;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        },
        runOnLoad(cb) { if (document.body) return cb(); window.addEventListener('DOMContentLoaded', cb); }
    };

    const Config = (() => {
        const o = Env.getOverrides();
        return {
            codecMode: o.codecMode ?? 'hard',  // 코덱 최적화
            passive: o.passive ?? true,        // 이벤트 패시브 모드
            gpu: o.gpu ?? true,                // WebGL/Canvas 가속
            image: o.image ?? true,            // 이미지 최적화
            prefetch: o.prefetch ?? true,      // 스마트 프리패치
            memory: o.memory ?? false,         // 메모리 가디언 (기본 OFF)
            debug: o.debug === true
        };
    })();

    const State = {
        fps: 60,
        moduleStatus: {}
    };

    // ==========================================
    // 3. Module System
    // ==========================================
    class BaseModule {
        constructor() { this.name = this.constructor.name; }
        safeInit() {
            try { this.init(); State.moduleStatus[this.name] = '✅ Active'; }
            catch (e) { State.moduleStatus[this.name] = '❌ Crashed'; if(Config.debug) console.error(e); }
        }
        init() {}
    }

    // ==========================================
    // 4. Optimization Modules (IMPROVED)
    // ==========================================

    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;
            const SAFE_ZONES = ['meet.google.com', 'zoom.us', 'discord.com', 'teams.microsoft.com', 'webex.com'];
            if (SAFE_ZONES.some(d => window.location.hostname.includes(d))) return;

            const hook = () => {
                if (!uWin.MediaSource || uWin.MediaSource._perfXHooked) return;
                const orig = uWin.MediaSource.isTypeSupported?.bind(uWin.MediaSource);
                if (!orig) return;

                uWin.MediaSource.isTypeSupported = (t) => {
                    if (Config.codecMode === 'hard') {
                        // 4K(AV1/VP9)를 희생하고 1080p(H.264) 하드웨어 가속을 얻음
                        // 만약 4K가 필수라면 UI에서 '코덱'을 끄거나 Soft로 변경해야 함
                        if (t.toLowerCase().includes('av01') || t.toLowerCase().match(/vp9|vp09/)) return false;
                    }
                    return orig(t);
                };
                uWin.MediaSource._perfXHooked = true;
            };
            hook();
            if (!uWin.MediaSource) Object.defineProperty(uWin, 'MediaSource', { configurable: true, set: (v) => { delete uWin.MediaSource; uWin.MediaSource = v; hook(); } });
        }
    }

    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive) return;
            if (uWin.__perfx_evt_patched) return;
            uWin.__perfx_evt_patched = true;
            try {
                const add = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(t, l, o) {
                    if (['touchstart','touchmove','wheel'].includes(t)) {
                        if (typeof o !== 'object') o = { passive: true, capture: !!o };
                        else if (o.passive === undefined) o = { ...o, passive: true };
                    }
                    return add.call(this, t, l, o);
                };
            } catch(e) {}
        }
    }

    // [개선 포인트] GPU 모듈: WebGL 컨텍스트 최적화 + 캔버스 관리
    class GpuBooster extends BaseModule {
        constructor() { super(); this.observed = new WeakSet(); }
        init() {
            if (!Config.gpu) return; // 꺼져있으면 아무것도 안 함 (기본 브라우저 동작)

            // 1. WebGL Context Injection (고성능 강제)
            try {
                const hookContext = (proto) => {
                    const orig = proto.getContext;
                    proto.getContext = function(type, options) {
                        if (type && type.includes('webgl')) {
                            // 고성능 모드 강제 주입
                            options = {
                                ...options,
                                powerPreference: 'high-performance',
                                desynchronized: true, // 반응속도 향상 (화면 찢어짐 가능성 있음)
                                antialias: false,     // 계단현상 감수하고 성능 향상
                                stencil: false,
                                depth: true
                            };
                        }
                        return orig.call(this, type, options);
                    };
                };
                hookContext(HTMLCanvasElement.prototype);
                if (window.OffscreenCanvas) hookContext(OffscreenCanvas.prototype);
            } catch(e) {}

            // 2. Off-screen Canvas Throttling (화면 밖 캔버스 숨기기)
            // (주의: 일부 사이트 레이아웃 깨짐 방지를 위해 visibility만 조절)
            const obs = new IntersectionObserver(es => es.forEach(e => {
                e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
            }), { threshold: 0.01 });

            Env.runOnLoad(() => {
                const scan = () => {
                    rIC(() => {
                        document.querySelectorAll('canvas').forEach(c => {
                            if(!this.observed.has(c)) { this.observed.add(c); obs.observe(c); }
                        });
                    });
                };
                // 여기서는 MutationObserver 대신 3초 간격 스캔 유지 (캔버스는 자주 추가되지 않으므로 MO 오버헤드 방지)
                setInterval(scan, 3000);
            });
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image) return;
            Env.runOnLoad(() => {
                rIC(() => {
                    // 모든 이미지를 즉시 로딩 + 비동기 디코딩으로 전환
                    document.querySelectorAll('img').forEach(img => {
                        if (img.loading === 'lazy') img.loading = 'eager';
                        img.decoding = 'async';
                    });
                });
            });
        }
    }

    // [개선 포인트] Prefetch: Speculation Rules API 활용
    class SmartPrefetcher extends BaseModule {
        init() {
            if (!Config.prefetch) return;

            // 최신 브라우저용 Speculation Rules 지원 확인
            const supportsSpeculation = HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules');

            const injectSpeculation = (url) => {
                if (!supportsSpeculation) {
                    // Fallback: 구형 prefetch
                    const l = document.createElement('link'); l.rel='prefetch'; l.href=url;
                    document.head.appendChild(l);
                    return;
                }
                // New: Speculation Rules (Prerender - 훨씬 강력함)
                const s = document.createElement('script');
                s.type = 'speculationrules';
                s.textContent = JSON.stringify({
                    prerender: [{ source: 'list', urls: [url] }] // prefetch보다 prerender가 더 빠름
                });
                document.head.appendChild(s);
            };

            const obs = new IntersectionObserver(es => es.forEach(e => {
                if(e.isIntersecting) {
                    e.target.addEventListener('mouseenter', () => {
                        if(e.target._pX) return; e.target._pX = true;
                        try {
                           const u = new URL(e.target.href);
                           if(u.origin !== location.origin) return; // 같은 도메인만
                           injectSpeculation(e.target.href);
                        } catch(e){}
                    }, {once:true, passive:true});
                    obs.unobserve(e.target);
                }
            }));

            Env.runOnLoad(() => {
                rIC(() => {
                    const scan = (n) => { if(n.querySelectorAll) n.querySelectorAll('a[href]').forEach(a => obs.observe(a)); };
                    scan(document.body);
                });
            });
        }
    }

    // [개선 포인트] MemoryGuardian: MutationObserver 적용
    class MemoryGuardian extends BaseModule {
        init() {
            if (!Config.memory) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.style.contentVisibility = 'visible';
                    } else if (entry.target.offsetHeight > 50) {
                        entry.target.style.containIntrinsicSize = `1px ${entry.target.offsetHeight}px`;
                        entry.target.style.contentVisibility = 'auto';
                    }
                });
            }, { rootMargin: '800px 0px' });

            const targetSelectors = '[role="feed"] > *, .infinite-scroll > *, ul > li, ol > li';
            const processed = new WeakSet();

            const processNode = (node) => {
                if (node.nodeType === 1 && !processed.has(node) && node.matches && node.matches(targetSelectors)) {
                    processed.add(node);
                    observer.observe(node);
                }
                // 자식 노드까지 검사 (피드 내부에 리스트가 있는 경우)
                if (node.querySelectorAll) {
                    node.querySelectorAll(targetSelectors).forEach(child => {
                        if (!processed.has(child)) {
                            processed.add(child);
                            observer.observe(child);
                        }
                    });
                }
            };

            Env.runOnLoad(() => {
                // 1. 초기 로드된 요소 처리
                document.querySelectorAll(targetSelectors).forEach(processNode);

                // 2. MutationObserver로 실시간 추가 감지 (setInterval 대체)
                const mo = new MutationObserver(mutations => {
                    mutations.forEach(m => {
                        m.addedNodes.forEach(processNode);
                    });
                });

                // document.body 전체를 감시하되, childList만 보므로 부하 적음
                mo.observe(document.body, { childList: true, subtree: true });
            });
        }
    }

    class FpsMeter extends BaseModule {
        init() {
            let frames = 0, last = performance.now();
            const loop = () => {
                frames++;
                const now = performance.now();
                if (now - last >= 1000) { State.fps = frames; frames = 0; last = now; }
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        }
    }

    // ==========================================
    // 5. UI Controller
    // ==========================================
    class UIController extends BaseModule {
        init() {
            const injectUI = () => {
                if (document.getElementById('perfx-ui-btn')) return;

                const btn = document.createElement('div');
                btn.id = 'perfx-ui-btn';
                btn.textContent = '⚡';
                Object.assign(btn.style, {
                    position: 'fixed', bottom: '60px', right: '10px', width: '36px', height: '36px',
                    fontSize: '20px', background: '#333', color: '#FFD700', borderRadius: '50%', zIndex: '2147483647',
                    display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'pointer', opacity: '0.8',
                    boxShadow: '0 4px 10px rgba(0,0,0,0.3)', border: '1px solid #555', transition: 'transform 0.2s', userSelect: 'none'
                });

                const panel = document.createElement('div');
                panel.id = 'perfx-ui-panel';
                Object.assign(panel.style, {
                    position: 'fixed', bottom: '105px', right: '10px', width: '230px', background: 'rgba(20,20,20,0.95)',
                    backdropFilter: 'blur(10px)', color: '#eee', padding: '15px', borderRadius: '12px',
                    fontSize: '12px', zIndex: '2147483647', border: '1px solid #444', fontFamily: 'sans-serif',
                    display: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
                });

                panel.innerHTML = safeHTML(`
                    <div style="font-weight:bold;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
                        <span>PerfX <span style="color:#f90;font-size:10px">v39.0 ULTRA</span></span>
                        <span style="cursor:pointer;padding:0 5px;" id="perfx-close">✖</span>
                    </div>
                    <div style="background:#111;padding:10px;border-radius:6px;margin-bottom:12px;line-height:1.4">
                        <div style="color:#4CAF50;font-weight:bold;margin-bottom:4px">MODE: MAX ULTRA</div>
                        <div style="display:flex;justify-content:space-between;align-items:center">
                            <span style="font-size:14px">FPS: <span style="color:#fff;font-weight:bold" id="perfx-ui-fps">0</span></span>
                            <span style="font-size:10px;color:#888">DOM Boosted</span>
                        </div>
                    </div>
                    <div id="perfx-toggles"></div>
                `);

                const createToggle = (lbl, key, parent) => {
                    const d = document.createElement('div');
                    d.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;cursor:pointer;font-size:11px;';
                    const v = Config[key];
                    const isOn = (v === true || v === 'hard');

                    d.innerHTML = safeHTML(`
                        <span style="color:#ccc">${lbl}</span>
                        <span style="color:${isOn ? '#4f4' : '#666'}">${typeof v==='boolean'?(v?'ON':'OFF'):v.toUpperCase()}</span>
                    `);
                    d.onclick = () => {
                        Env.setOverride(key, typeof v==='boolean'?!v:(v==='soft'?'hard':(v==='hard'?'off':'soft')));
                        location.reload();
                    };
                    parent.appendChild(d);
                };

                const tCon = panel.querySelector('#perfx-toggles');
                createToggle('🎥 하드웨어 가속', 'codecMode', tCon);
                createToggle('🚀 스크롤 부스터', 'passive', tCon);
                createToggle('👁️ GPU 가속+', 'gpu', tCon);
                createToggle('🖼️ 이미지 부스팅', 'image', tCon);
                createToggle('📡 스마트 링크', 'prefetch', tCon); // 이름 변경
                createToggle('🧹 메모리 가디언', 'memory', tCon);

                let loopId;
                const update = () => {
                    if(panel.style.display==='none') return;
                    document.getElementById('perfx-ui-fps').innerText = State.fps;
                    loopId = requestAnimationFrame(update);
                };

                const toggle = (e) => {
                    e?.stopPropagation();
                    const show = panel.style.display === 'none';
                    panel.style.display = show ? 'block' : 'none';
                    if(show) update(); else cancelAnimationFrame(loopId);
                };

                btn.onclick = toggle;
                panel.querySelector('#perfx-close').onclick = toggle;
                document.body.appendChild(btn);
                document.body.appendChild(panel);
            };

            Env.runOnLoad(injectUI);
            // History Hook
            const hookHistory = (type) => {
                const orig = history[type];
                return function() {
                    const rv = orig.apply(this, arguments);
                    setTimeout(injectUI, 0); setTimeout(injectUI, 500);
                    return rv;
                };
            };
            history.pushState = hookHistory('pushState');
            history.replaceState = hookHistory('replaceState');
            window.addEventListener('popstate', () => { setTimeout(injectUI, 0); });
            setInterval(() => { if (!document.getElementById('perfx-ui-btn') && document.body) injectUI(); }, 2000);
        }
    }

    // ==========================================
    // 6. Init
    // ==========================================
    [
        new FpsMeter(), new UIController(), new CodecOptimizer(),
        new EventPassivator(), new GpuBooster(), new MemoryGuardian(),
        new SmartPrefetcher(), new ImageOptimizer()
    ].forEach(m => m.safeInit());

})();
