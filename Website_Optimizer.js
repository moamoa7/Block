// ==UserScript==
// @name        Web 성능 종합 최적화 도구상자 (v38.1 God Speed Fix)
// @namespace   http://tampermonkey.net/
// @version     38.1.0-KR-God-Speed-Fix
// @description [Fix] +UI Restore +ImageOptimizer Restore
// @author      KiwiFruit (Architected by User & AI)
// @match       *://*/*
// @exclude     *://weibo.com/*
// @exclude     *://*.weibo.com/*
// @grant       unsafeWindow
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    // [Core] Safe Execution Wrapper
    const safeExec = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
    const rIC = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
    const uWin = unsafeWindow || window;

    // ==========================================
    // 0. Context & Hyper-Adaptive Profiler
    // ==========================================
    const Context = {
        isNight: false,
        batteryLow: false,
        isSlowNetwork: false,
        cpuStressed: false,
        ram: navigator.deviceMemory || 4,
        cores: navigator.hardwareConcurrency || 4,
        score: 10,

        init() {
            let hwScore = (this.ram * 0.5) + (this.cores * 0.5);
            if (hwScore > 10) hwScore = 10;

            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (conn) {
                const updateNet = () => {
                    this.isSlowNetwork = conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType);
                    this.calcScore(hwScore);
                };
                conn.addEventListener('change', updateNet);
                updateNet();
            }
            if (navigator.getBattery) {
                navigator.getBattery().then(bat => {
                    const updateBat = () => {
                        this.batteryLow = bat.level < 0.2 && !bat.charging;
                        this.calcScore(hwScore);
                    };
                    bat.addEventListener('levelchange', updateBat);
                    bat.addEventListener('chargingchange', updateBat);
                    updateBat();
                });
            }
            this.calcScore(hwScore);
            const checkTime = () => { const h = new Date().getHours(); this.isNight = h >= 22 || h < 6; };
            checkTime();
            setInterval(checkTime, 300000);
        },

        calcScore(hwBase) {
            let s = hwBase;
            if (this.batteryLow) s *= 0.7;
            if (this.isSlowNetwork) s *= 0.8;
            if (this.isNight) s *= 0.95;
            this.score = parseFloat(s.toFixed(1));
        }
    };
    Context.init();

    // ==========================================
    // 1. Safety & Critical Checks
    // ==========================================
    const CRITICAL_DOMAINS = ['upbit.com', 'binance.com', 'gov.kr', 'hometax.go.kr', 'nts.go.kr'];
    const CRITICAL_REGEX = /(^|\.)(bank|banking|card|pay|secure-payment|finance)\./i;
    const CRITICAL_PATH = /[\/\?&](login|auth|signin|checkout|billing|payment|cert|verify)($|[\/\?&])/i;

    const isCritical =
        CRITICAL_DOMAINS.some(d => window.location.hostname.endsWith(d)) ||
        CRITICAL_REGEX.test(window.location.hostname) ||
        CRITICAL_PATH.test(window.location.href);

    if (isCritical) {
        uWin.perfx = { status: () => '🔒 Critical Mode (Inactive)', revive: () => {} };
        return;
    }

    // ==========================================
    // 2. State & Config
    // ==========================================
    const SiteBrain = {
        key: `perfx_brain_${window.location.hostname}`,
        data: null,
        load() {
            try { this.data = JSON.parse(localStorage.getItem(this.key)) || { visits: 0, avgFps: 60, crashes: 0 }; }
            catch { this.data = { visits: 0, avgFps: 60, crashes: 0 }; }
            return this.data;
        },
        save() { localStorage.setItem(this.key, JSON.stringify(this.data)); },
        update(fps, crashed) {
            if (!this.data) this.load();
            if (crashed) this.data.crashes++;
            else if (fps > 0) {
                this.data.visits++;
                const weight = this.data.visits < 5 ? 0.5 : 0.8;
                this.data.avgFps = (this.data.avgFps * weight) + (fps * (1 - weight));
            }
            this.save();
        },
        getSuggestion() {
            if (!this.data) this.load();
            if (this.data.crashes > 3) return 'safe';
            if (Context.score < 4 || (this.data.avgFps < 40 && this.data.visits > 2)) return 'lowend';
            return 'default';
        }
    };

    const Env = {
        isMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
        isLowEnd: SiteBrain.getSuggestion() === 'lowend' || Context.score < 4,
        storageKey: `PerfX_v38_${window.location.hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } },
        setOverride(key, val) {
            const data = this.getOverrides(); data[key] = val;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        },
        isMatch(list) { return (list || []).some(d => window.location.hostname.includes(d)); },
        runOnLoad(cb) { if (document.body) return cb(); window.addEventListener('DOMContentLoaded', cb); }
    };

    const SiteLists = {
      streaming: [
            // 글로벌 대장
            'youtube.com', 'twitch.tv', 'netflix.com', 'disneyplus.com', 'tv.apple.com', 'primevideo.com',
            // 국내 대장
            'chzzk.naver.com', 'sooplive.co.kr', 'afreecatv.com', 'tving.com', 'wavve.com', 'coupangplay.com',
            // 매니아 (애니/영화)
            'watcha.com', 'laftel.net',
            // 국내 기타
            'tv.naver.com', 'tv.kakao.com', 'pandalive.co.kr',
        ],
        heavySPA: ['fmkorea.com', 'reddit.com', 'twitter.com', 'instagram.com', 'facebook.com'],
        risky: {
            'sooplive.co.kr': ['CanvasGovernor', 'EventPassivator', 'ShadowPiercer'],
            'afreecatv.com': ['CanvasGovernor', 'EventPassivator'],
            'figma.com': ['CanvasGovernor', 'BackgroundThrottler']
        }
    };

    const Config = (() => {
        const overrides = Env.getOverrides();
        const profile = Env.isLowEnd ? 'lowend' : (Env.isMatch(SiteLists.streaming) ? 'media' : (Env.isMatch(SiteLists.heavySPA) ? 'spa' : 'default'));
        const isLow = profile === 'lowend';

        return {
            profile,
            codecMode: overrides.codecMode ?? 'soft',
            throttle: overrides.throttle ?? true,
            motion: overrides.motion ?? isLow,
            gpu: overrides.gpu ?? (!isLow),
            image: overrides.image ?? (!Context.isSlowNetwork),
            prefetch: overrides.prefetch ?? (!isLow && !Context.isSlowNetwork),
            memory: overrides.memory ?? true,
            privacy: overrides.privacy ?? true,
            swKiller: overrides.swKiller ?? false,
            canvasGov: overrides.canvasGov ?? true,
            debug: overrides.debug === true
        };
    })();

    const State = {
        processedNodes: new WeakSet(),
        blockedCount: 0,
        fps: 60,
        moduleStatus: {}
    };

    // ==========================================
    // 3. Module System with Isolation
    // ==========================================
    class BaseModule {
        constructor() { this.name = this.constructor.name; }
        safeInit() {
            const riskyModules = Object.entries(SiteLists.risky).find(([domain]) => window.location.hostname.includes(domain))?.[1] || [];
            if (riskyModules.includes(this.name)) {
                State.moduleStatus[this.name] = '⏭️ Skipped';
                return;
            }
            try {
                this.init();
                State.moduleStatus[this.name] = '✅ Active';
            } catch (e) {
                State.moduleStatus[this.name] = '❌ Crashed';
                if (Config.debug) console.error(`[PerfX] Module ${this.name} crashed:`, e);
            }
        }
        init() {}
    }

    // ==========================================
    // 4. Optimization Modules
    // ==========================================

    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;

            // [Safety] 화상 회의 / WebRTC 필수 사이트는 건드리지 않음
            const SAFE_ZONES = ['meet.google.com', 'zoom.us', 'discord.com', 'teams.microsoft.com'];
            if (Env.isMatch(SAFE_ZONES)) return;

            const hook = () => {
                if (!uWin.MediaSource || uWin.MediaSource._perfXHooked) return;
                const orig = uWin.MediaSource.isTypeSupported?.bind(uWin.MediaSource);
                if (!orig) return;

                uWin.MediaSource.isTypeSupported = (t) => {
                    // [Opt] 점수가 낮거나(5점 미만) 하드웨어 가속이 꺼져있을 때만 개입
                    const isStressed = Context.score < 5;
                    if (isStressed || Config.codecMode === 'hard') {
                        // AV1, VP9 등 무거운 코덱을 "지원 안 함"으로 속여서 가벼운 H.264를 유도
                        if (t.toLowerCase().includes('av01')) return false;
                        if (t.toLowerCase().match(/vp9|vp09/)) return false;
                    }
                    return orig(t);
                };
                uWin.MediaSource._perfXHooked = true;
            };
            hook();
            if (!uWin.MediaSource) Object.defineProperty(uWin, 'MediaSource', { configurable: true, set: (v) => { delete uWin.MediaSource; uWin.MediaSource = v; hook(); } });
        }
    }

    class MemoryGuardian extends BaseModule {
        constructor() { super(); this.observer = null; }
        init() {
            if (!Config.memory) return;
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const el = entry.target;
                    if (entry.isIntersecting) {
                        el.style.contentVisibility = 'visible';
                        el.style.visibility = 'visible';
                    } else {
                        if (el.offsetHeight > 50) {
                            el.style.containIntrinsicSize = `1px ${el.offsetHeight}px`;
                            el.style.contentVisibility = 'auto';
                            if (Env.isLowEnd) el.style.visibility = 'hidden';
                        }
                    }
                });
            }, { rootMargin: Env.isLowEnd ? '200px 0px' : '400px 0px' });

            const CHUNK_SIZE = Math.max(2, Math.floor(Context.score * 1.5));
            const scan = () => {
                rIC(() => {
                    const candidates = Array.from(document.querySelectorAll('[role="feed"] > *, [role="list"] > *, .infinite-scroll > *'));
                    let i = 0;
                    const chunkProcess = () => {
                        const chunk = candidates.slice(i, i + CHUNK_SIZE);
                        if (chunk.length === 0) return;
                        chunk.forEach(el => {
                            if (State.processedNodes.has(el)) return;
                            if (el.offsetHeight < 80) return;
                            this.observer.observe(el);
                            State.processedNodes.add(el);
                        });
                        i += CHUNK_SIZE;
                        if (i < candidates.length) rIC(chunkProcess);
                    };
                    chunkProcess();
                }, { timeout: 1000 });
            };
            setInterval(scan, 5000);
        }
    }

    class BackgroundThrottler extends BaseModule {
        init() {
            if (!Config.throttle || window !== window.top) return;

            let mutationScore = 0;
            const mo = new MutationObserver(() => { mutationScore += 1; });
            mo.observe(document, { subtree: true, childList: true });
            setInterval(() => { mutationScore = mutationScore * 0.6; if(mutationScore < 0.1) mutationScore = 0; }, 200);

            Env.runOnLoad(() => {
                if (document.querySelector('canvas, video')) return;
                const origRAF = window.requestAnimationFrame.bind(window);
                const rafMap = new Map();
                let rafCounter = 0;
                const HIDDEN_DELAY = Env.isMobile ? 1500 : 1000;

                window.requestAnimationFrame = (callback) => {
                    const isHighMutation = mutationScore > 8;
                    if (document.hidden && !State.audioActive && !isHighMutation) {
                        rafCounter = (rafCounter + 1) % 10000000;
                        const fakeId = rafCounter;
                        const timerId = setTimeout(() => {
                            rafMap.delete(fakeId);
                            try { callback(performance.now()); } catch(e){}
                        }, HIDDEN_DELAY);
                        rafMap.set(fakeId, timerId);
                        return fakeId;
                    }
                    return origRAF(callback);
                };
                const origCAF = window.cancelAnimationFrame.bind(window);
                window.cancelAnimationFrame = (id) => {
                    if (rafMap.has(id)) { clearTimeout(rafMap.get(id)); rafMap.delete(id); }
                    else origCAF(id);
                };
            });
        }
    }

    class CanvasGovernor extends BaseModule {
        constructor() { super(); this.webglCache = new WeakMap(); this.observed = new WeakSet(); }
        init() {
            if (!Config.canvasGov) return;
            Env.runOnLoad(() => {
                const isWebGL = (c) => {
                    if(this.webglCache.has(c)) return this.webglCache.get(c);
                    if (c.dataset?.perfxWebgl === '1') { this.webglCache.set(c, true); return true; }
                    let v = false;
                    try { v = !!(c.getContext && (c.getContext('webgl') || c.getContext('webgl2'))); }
                    catch(e){ v = false; }
                    this.webglCache.set(c, v);
                    return v;
                };
                const obs = new IntersectionObserver(es => es.forEach(e => {
                    if (isWebGL(e.target)) return;
                    if (e.isIntersecting) {
                        e.target.style.visibility = 'visible';
                        e.target.style.pointerEvents = 'auto';
                    } else {
                        e.target.style.visibility = 'hidden';
                        e.target.style.pointerEvents = 'none';
                    }
                }), { threshold: 0.01 });
                const scan = () => document.querySelectorAll('canvas').forEach(c => {
                    if(!this.observed.has(c)) { this.observed.add(c); obs.observe(c); }
                });
                setTimeout(scan, 2000);
            });
        }
    }

    class EventPassivator extends BaseModule {
        init() {
            if (uWin.__perfx_evt_patched) return;
            uWin.__perfx_evt_patched = true;
            try {
                const add = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(t, l, o) {
                    if (['touchstart','touchmove','wheel'].includes(t)) {
                        if (typeof o === 'object' && o.passive === false) return add.call(this, t, l, o);
                        if (typeof o !== 'object') o = { passive: true, capture: !!o };
                        else if (!o.passive) o = { ...o, passive: true };
                    }
                    return add.call(this, t, l, o);
                };
            } catch(e) {}
        }
    }

    class LinkPrefetcher extends BaseModule {
        init() {
            if (!('IntersectionObserver' in window)) return;
            if (!Config.prefetch || Context.isNight || Context.isSlowNetwork || Env.isMobile) return;

            const prefetch = (el) => {
                 if(el._pX) return; el._pX = true;
                 try {
                    const u = new URL(el.href);
                    if(u.origin !== location.origin) return;
                    const l = document.createElement('link'); l.rel='prefetch'; l.href=el.href;
                    document.head.appendChild(l);
                 } catch(e){}
            };
            const obs = new IntersectionObserver(es => es.forEach(e => {
                if(e.isIntersecting) {
                    const el = e.target;
                    el.addEventListener('mouseenter', () => prefetch(el), {once:true, passive:true});
                    obs.unobserve(el);
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

    // [Restored Module]
    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image) return;
            const obs = new IntersectionObserver(es => es.forEach(e => {
                if (e.isIntersecting) {
                    const img = e.target;
                    if (!img.complete) { img.loading = 'eager'; img.decoding = 'async'; }
                    obs.unobserve(img);
                }
            }), { rootMargin: '200px' });
            Env.runOnLoad(() => {
                rIC(() => {
                    const scan = () => document.querySelectorAll('img:not([loading])').forEach(img => {
                        img.loading = 'lazy';
                        obs.observe(img);
                    });
                    scan();
                });
            });
        }
    }

    class BenchmarkEngine extends BaseModule {
        init() {
            if (Env.isLowEnd) return;
            const runBench = (delay) => {
                setTimeout(() => {
                    if (document.hidden || State.moduleStatus['FPSMeter'] === 'Crashed') return;
                    const raf = window.__perfx_nativeRAF;
                    let frames = 0, start = performance.now();
                    const measure = () => {
                        frames++;
                        if (performance.now() - start > 5000) {
                            const avg = (frames / 5) * 1000;
                            if (avg < 40) localStorage.setItem(`perfx_auto_lowend_${window.location.hostname}`, '1');
                            SiteBrain.update(avg, false);
                        } else raf(measure);
                    };
                    raf(measure);
                }, delay);
            };
            if (!sessionStorage.getItem('perfx_bench_done')) {
                runBench(3000);
                sessionStorage.setItem('perfx_bench_done', '1');
            }
        }
    }

    class FpsMeter extends BaseModule {
        init() {
            let frames = 0, last = performance.now();
            const loop = () => {
                frames++;
                const now = performance.now();
                if (now - last >= 1000) { State.fps = frames; frames = 0; last = now; }
                window.__perfx_nativeRAF(loop);
            };
            window.__perfx_nativeRAF(loop);
        }
    }

    // ==========================================
    // 5. UI & Control (SPA Instant Fix)
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

                panel.innerHTML = `
                    <div style="font-weight:bold;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
                        <span>PerfX <span style="color:#aaa;font-size:10px">v38.1 God Fix</span></span>
                        <span style="cursor:pointer;padding:0 5px;" id="perfx-close">✖</span>
                    </div>
                    <div style="background:#111;padding:10px;border-radius:6px;margin-bottom:12px;line-height:1.4">
                        <div style="color:#4CAF50;font-weight:bold">MODE: ${Config.profile.toUpperCase()}</div>
                        <div style="display:flex;justify-content:space-between">
                            <span>FPS: <span style="color:#fff" id="perfx-ui-fps">0</span></span>
                            <span>HW Score: <span style="color:#fb8">${Context.score}</span></span>
                        </div>
                        <div style="font-size:10px;color:#666;margin-top:4px">
                            Blocked: <span id="perfx-ui-block">${State.blockedCount}</span>
                        </div>
                    </div>
                    <div id="perfx-toggles"></div>
                    <div id="perfx-more" style="text-align:center; cursor:pointer; color:#888; font-size:10px; margin-top:8px;">▼ 고급 설정</div>
                    <div id="perfx-advanced" style="display:none; margin-top:8px; border-top:1px solid #444; padding-top:8px;"></div>
                    <div style="margin-top:12px; display:flex; gap:5px;">
                        <div id="perfx-kill-temp" style="flex:1; background:#432; border:1px solid #d84; color:#fb8; text-align:center; padding:6px; border-radius:4px; cursor:pointer; font-size:11px;">일시 중지</div>
                    </div>
                `;

                const createToggle = (lbl, key, parent) => {
                    const d = document.createElement('div');
                    d.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;cursor:pointer;font-size:11px;';
                    const v = Config[key];
                    d.innerHTML = `<span style="color:#ccc">${lbl}</span><span style="color:${v && v!=='off'?'#4f4':'#666'}">${typeof v==='boolean'?(v?'ON':'OFF'):v.toUpperCase()}</span>`;
                    d.onclick = () => { Env.setOverride(key, typeof v==='boolean'?!v:(v==='soft'?'hard':(v==='hard'?'off':'soft'))); d.querySelector('span:last-child').innerText = '저장됨'; };
                    parent.appendChild(d);
                };

                // [Restored Toggles]
                const tCon = panel.querySelector('#perfx-toggles');
                createToggle('🎥 코덱', 'codecMode', tCon);
                createToggle('💤 절전', 'throttle', tCon);
                createToggle('🚀 모션', 'motion', tCon);
                createToggle('👁️ GPU', 'gpu', tCon); // GPU Restored

                const aCon = panel.querySelector('#perfx-advanced');
                createToggle('🖼️ 이미지', 'image', aCon); // Image Restored
                createToggle('🛡️ 보안', 'privacy', aCon);
                createToggle('🧹 메모리', 'memory', aCon);
                createToggle('📡 링크', 'prefetch', aCon); // Prefetch Restored
                createToggle('🎨 캔버스', 'canvasGov', aCon);

                panel.querySelector('#perfx-more').onclick = function() {
                    const hidden = aCon.style.display === 'none';
                    aCon.style.display = hidden ? 'block' : 'none';
                    this.textContent = hidden ? '▲ 접기' : '▼ 고급 설정';
                };

                let loopId;
                const update = () => {
                    if(panel.style.display==='none') return;
                    const el = document.getElementById('perfx-ui-fps');
                    if(el) el.innerText = State.fps;
                    document.getElementById('perfx-ui-block').innerText = State.blockedCount;
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
                panel.querySelector('#perfx-kill-temp').onclick = () => { sessionStorage.setItem('perfx_temp_kill','1'); location.reload(); };

                document.body.appendChild(btn);
                document.body.appendChild(panel);
            };

            Env.runOnLoad(injectUI);

            const hookHistory = (type) => {
                const orig = history[type];
                return function() {
                    const rv = orig.apply(this, arguments);
                    setTimeout(injectUI, 0);
                    setTimeout(injectUI, 500);
                    return rv;
                };
            };
            history.pushState = hookHistory('pushState');
            history.replaceState = hookHistory('replaceState');
            window.addEventListener('popstate', () => { setTimeout(injectUI, 0); });

            setInterval(() => { if (!document.getElementById('perfx-ui-btn') && document.body) injectUI(); }, 2000);
        }
    }

    class CLI extends BaseModule {
        init() {
            uWin.perfx = {
                status: () => console.table({
                    Profile: Config.profile,
                    Score: Context.score,
                    FPS: State.fps,
                    Modules: State.moduleStatus
                }),
                kill: () => {
                    const list = JSON.parse(localStorage.getItem('perfx_disabled_sites') || '[]');
                    if (!list.includes(window.location.hostname)) {
                        list.push(window.location.hostname);
                        localStorage.setItem('perfx_disabled_sites', JSON.stringify(list));
                    }
                    alert('Disabled permenantly.'); location.reload();
                }
            };
        }
    }

    class SWKiller extends BaseModule {
        init() {
            if (!Config.swKiller) return;
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(regs => {
                    regs.forEach(reg => {
                        try {
                            const scope = new URL(reg.scope);
                            if (scope.origin !== location.origin) reg.unregister();
                        } catch(e){}
                    });
                });
            }
        }
    }

    class PrivacySaver extends BaseModule {
        init() {
            if (!Config.privacy) return;
            const TRACKERS = [/google-analytics/, /googletagmanager/, /doubleclick/, /facebook\.com\/tr/, /hotjar/];
            const origBeacon = navigator.sendBeacon;
            if (origBeacon) {
                navigator.sendBeacon = function (url, data) {
                    try {
                        if (TRACKERS.some(r => r.test(url)) && !url.includes('google.com/recaptcha')) {
                            State.blockedCount++;
                            return true;
                        }
                    } catch(e){}
                    return origBeacon.call(this, url, data);
                };
            }
        }
    }

    // ==========================================
    // 6. Init Sequence
    // ==========================================
    const modules = [
        new FpsMeter(),
        new UIController(),
        new CLI(),
        new CodecOptimizer(),
        new EventPassivator(),
        new BackgroundThrottler(),
        new CanvasGovernor(),
        new MemoryGuardian(),
        new LinkPrefetcher(),
        new ImageOptimizer(), // Added back
        new PrivacySaver(),
        new SWKiller(),
        new BenchmarkEngine()
    ];

    modules.forEach(m => m.safeInit());

})();
