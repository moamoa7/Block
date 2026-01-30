// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v17.9 Architect Platinum)
// @namespace    http://tampermonkey.net/
// @version      17.9.0-KR-Architect-Platinum
// @description  Async Decoding + React-Safe Guardian + Robust RAF + Safety Switches
// @author       KiwiFruit (Architected by AI & User)
// @match        *://*/*
// @exclude      *://weibo.com/*
// @exclude      *://*.weibo.com/*
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ========================
    // 0. Safety Check & Emergency Kill Switch
    // ========================
    if (new URLSearchParams(window.location.search).get('perfx_safe') === '1') {
        console.warn('[PerfX] Safe Mode Activated. Script Disabled.');
        return;
    }

    // ========================
    // 1. Core Utils & Env
    // ========================
    const Env = {
        isMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
        isSlowNetwork: (navigator.connection?.saveData === true) ||
                       ['slow-2g', '2g', '3g'].includes(navigator.connection?.effectiveType),
        storageKey: `PerfX_v17_${window.location.hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } },
        setOverride(key, val) {
            const data = this.getOverrides(); data[key] = val;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        },
        isMatch(list) { return list.some(d => window.location.hostname.includes(d)); },
        runOnLoad(cb) {
            if (document.body) cb();
            else document.addEventListener('DOMContentLoaded', cb);
        }
    };

    // ========================
    // 2. Configuration & Lists
    // ========================
    const SiteLists = {
        noThrottling: [
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'chzzk.naver.com', 'tv.naver.com', 'tv.kakao.com', 'pandalive.co.kr',
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'disneyplus.com', 'watcha.com', 'ok.ru',
            'gemini.google.com', 'chatgpt.com', 'claude.ai',
            'music.youtube.com', 'spotify.com', 'github.com',
        ],
        noRender: [
            'youtube.com', 'dcinside.com', 'tv.naver.com', 'tvwiki5.net', 'avsee.ru', 'cineaste.co.kr', 'inven.co.kr',
        ],
        disallowCodec: [
            'netflix.com', 'disneyplus.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'watcha.com',
            'meet.google.com', 'discord.com', 'zoom.us'
        ]
    };

    const overrides = Env.getOverrides();
    const rawConfig = {
        codecMode: overrides.codecMode || 'soft',
        throttle: { enabled: !Env.isMatch(SiteLists.noThrottling) && overrides.throttle !== false },
        motion: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.motion !== false },
        gpu: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.gpu !== false },
        image: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.image !== false },
        prefetch: { enabled: !Env.isSlowNetwork && !Env.isMatch(SiteLists.noThrottling) && overrides.prefetch !== false },
        prefetchStrategy: overrides.prefetchStrategy || 'prefetch',
        connect: { enabled: overrides.connect !== false },
        memory: { enabled: overrides.memory !== false },
        debug: { enabled: overrides.debug === true }
    };

    if (Env.isMatch(SiteLists.disallowCodec)) rawConfig.codecMode = 'off';
    const Config = Object.freeze(rawConfig);

    // ========================
    // 3. Systems (Toast & Inspector)
    // ========================
    class ToastManager {
        static show(message, type = 'info') {
            const container = document.getElementById('perfx-toast-container') || this.createContainer();
            const toast = document.createElement('div');
            toast.textContent = message;
            Object.assign(toast.style, {
                background: 'rgba(30,30,30,0.95)', color: type === 'warn' ? '#FF5252' : '#fff',
                padding: '12px 20px', marginBottom: '10px', borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: '13px', fontFamily: 'sans-serif',
                opacity: '0', transform: 'translateY(20px)', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                borderLeft: `4px solid ${type === 'warn' ? '#FF5252' : '#4CAF50'}`, backdropFilter: 'blur(4px)'
            });
            container.appendChild(toast);
            requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
            setTimeout(() => {
                toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)';
                setTimeout(() => toast.remove(), 300);
            }, 2500);
        }
        static createContainer() {
            const div = document.createElement('div');
            div.id = 'perfx-toast-container';
            Object.assign(div.style, {
                position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
                zIndex: '1000000', display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none'
            });
            document.body.appendChild(div);
            return div;
        }
    }

    class VideoInspector {
        static getStatus() {
            const v = document.querySelector('video');
            if (!v) return { active: false, msg: 'No Active Video' };

            const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
            const drop = q.droppedVideoFrames || 0;
            const w = v.videoWidth;
            const h = v.videoHeight;

            if (w === 0) return { active: true, loading: true, msg: 'Loading Media...' };

            let policyMsg = 'Unknown';
            if (Config.codecMode === 'hard') policyMsg = 'H.264 Forced';
            else if (Config.codecMode === 'soft') policyMsg = 'VP9 Allowed';
            else policyMsg = 'Native';

            return {
                active: true, loading: false,
                res: `${w}x${h}`,
                drop: drop,
                policy: policyMsg,
                isBad: drop > 10
            };
        }
    }

    // ========================
    // 4. Logic Modules
    // ========================
    class BaseModule {
        safeInit() { try { this.init(); } catch (e) { console.error(`[PerfX] ${this.constructor.name}`, e); } }
        init() {}
    }

    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;
            const enableHook = () => {
                if (!window.MediaSource || window.MediaSource._perfXHooked) return;
                const orig = window.MediaSource.isTypeSupported.bind(window.MediaSource);
                const cache = new Map();
                window.MediaSource.isTypeSupported = (t) => {
                    if (!t) return false;
                    if (cache.has(t)) return cache.get(t);
                    const type = t.toLowerCase();
                    let result = true;
                    if (Config.codecMode === 'soft') { if (type.includes('av01')) result = false; }
                    else if (Config.codecMode === 'hard') { if (type.match(/vp9|vp09|av01/)) result = false; }
                    if (result) result = orig(t);
                    cache.set(t, result);
                    return result;
                };
                window.MediaSource._perfXHooked = true;
                console.log(`[PerfX] Codec Hooked (${Config.codecMode})`);
            };
            enableHook();
            window.addEventListener('DOMContentLoaded', enableHook);
        }
    }

    class BackgroundThrottler extends BaseModule {
        init() {
            if (!Config.throttle.enabled) return;

            const origRAF = window.requestAnimationFrame;
            let isHidden = false;

            // [v18 Plan] RAF Timer Stack protection (interval mode)
            Object.defineProperty(window, 'requestAnimationFrame', {
                configurable: true,
                writable: true,
                value: (callback) => {
                    if (isHidden) {
                        return setTimeout(() => { try { callback(performance.now()); } catch(e){} }, 500);
                    }
                    return origRAF(callback);
                }
            });

            document.addEventListener('visibilitychange', () => {
                isHidden = document.hidden;
                if (isHidden) document.title = '💤 ' + document.title.replace(/^💤 /, '');
                else document.title = document.title.replace(/^💤 /, '');
            });
        }
    }

    class LinkPrefetcher extends BaseModule {
        init() {
            if (!Config.prefetch.enabled) return;
            const usePrerender = Config.prefetchStrategy === 'prerender' &&
                                 (navigator.connection ? navigator.connection.effectiveType === '4g' : true);
            const relType = usePrerender ? 'prerender' : 'prefetch';
            
            const MAX_PREFETCH = 15;
            let currentPrefetchCount = 0;

            setInterval(() => {
                if (currentPrefetchCount > 0) currentPrefetchCount--;
            }, 60000);

            Env.runOnLoad(() => {
                const obs = new IntersectionObserver(entries => {
                    entries.forEach(e => {
                        if (e.isIntersecting) {
                            const el = e.target;
                            el.addEventListener('mouseenter', () => {
                                if (currentPrefetchCount >= MAX_PREFETCH) return;
                                if (!el.dataset.perfPre) {
                                    try {
                                        if (new URL(el.href).origin !== window.location.origin) return;
                                    } catch { return; }

                                    const l = document.createElement('link');
                                    l.rel = relType;
                                    l.href = el.href;
                                    document.head.appendChild(l);
                                    el.dataset.perfPre = '1';
                                    currentPrefetchCount++;
                                }
                            }, {once:true, passive:true});
                            obs.unobserve(el);
                        }
                    });
                });
                const scan = (n) => n.querySelectorAll && n.querySelectorAll('a[href^="http"]').forEach(a => obs.observe(a));
                scan(document.body);
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }

    class MemoryGuardian extends BaseModule {
        init() {
            if (!Config.memory.enabled) return;
            const LIMIT = Env.isMobile ? 600 : 1200;
            const PURGE = Env.isMobile ? 300 : 600;

            setInterval(() => {
                if (!document.body) return;

                const targets = document.querySelectorAll(
                    '[role="feed"], [role="log"], [data-testid*="chat"], .chat-scrollable, ul, ol'
                );

                targets.forEach(el => {
                    if (el.matches(':hover, :focus-within')) return;
                    if (el.matches('.virtualized, .react-window, [data-virtualized]')) return;
                    
                    if (el.id === 'root' || el.id.startsWith('__next') || el.hasAttribute('data-reactroot')) return;
                    if (el.closest('[data-reactroot], [id^="__next"], #root') === el) return;
                    
                    const isReactManaged = Object.keys(el).some(key => key.startsWith('__react') || key.startsWith('_react'));
                    if (isReactManaged) return; 

                    if (el.scrollHeight <= el.clientHeight * 1.5) return;
                    if (el.scrollTop < el.clientHeight) return;

                    if (el.childElementCount > LIMIT) {
                        try {
                            const range = document.createRange();
                            range.setStart(el, 0);
                            range.setEnd(el, el.childElementCount - PURGE);
                            range.deleteContents();
                        } catch(e) {}
                    }
                });
            }, 30000);
        }
    }

    class UIController extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                const btn = document.createElement('div');
                btn.textContent = '⚡';
                Object.assign(btn.style, {
                    position: 'fixed', bottom: '60px', right: '10px',
                    width: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    height: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    fontSize: Env.isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                    background: '#4a90e2', color: '#FFD700', borderRadius: '50%', zIndex: '999999',
                    display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'pointer',
                    boxShadow: '0 3px 8px rgba(0,0,0,0.4)', opacity: '0.8', userSelect: 'none', touchAction: 'none'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    position: 'fixed', bottom: '70px', right: '20px', width: '240px',
                    background: 'rgba(25,25,25,0.96)', backdropFilter: 'blur(5px)', borderRadius: '8px',
                    padding: '15px', zIndex: '999999', display: 'none', color: '#eee',
                    fontFamily: 'sans-serif', fontSize: '12px', border: '1px solid #444'
                });

                const monitorBox = document.createElement('div');
                monitorBox.style.cssText = 'background:#111; border-radius:6px; padding:8px; margin-bottom:12px; border:1px solid #333; text-align:center; font-family:monospace; color:#4CAF50; white-space:pre-line';
                monitorBox.textContent = 'Ready';
                panel.appendChild(monitorBox);

                let monitorInterval = null;
                const updateMonitor = () => {
                    const status = VideoInspector.getStatus();
                    if (status.active) {
                        if (status.loading) {
                            monitorBox.textContent = status.msg;
                            monitorBox.style.color = '#FF9800';
                        } else {
                            monitorBox.textContent = `📺 ${status.res}\n⚙️ ${status.policy}\n📉 Drop: ${status.drop}`;
                            monitorBox.style.color = status.isBad ? '#FF5252' : '#4CAF50';
                        }
                    } else {
                        monitorBox.textContent = status.msg;
                        monitorBox.style.color = '#777';
                    }
                };

                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px; display:flex; justify-content:space-between; align-items:center';
                const titleContainer = document.createElement('div');
                const titleMain = document.createElement('b'); titleMain.textContent = 'PerfX ';
                const titleVer = document.createElement('span'); titleVer.textContent = 'v17.9'; titleVer.style.cssText = 'font-size:10px;color:#aaa';
                titleContainer.append(titleMain, titleVer);
                const closeBtn = document.createElement('span'); closeBtn.textContent = '✖'; closeBtn.style.cursor = 'pointer';
                closeBtn.onclick = () => { panel.style.display = 'none'; if(monitorInterval) clearInterval(monitorInterval); };
                titleRow.append(titleContainer, closeBtn);
                panel.appendChild(titleRow);

                const addRow = (label, key, val, displayVal, color) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px; align-items:center';
                    const labelSpan = document.createElement('span'); labelSpan.textContent = label;
                    const valSpan = document.createElement('span'); valSpan.textContent = displayVal;
                    valSpan.style.fontWeight = 'bold'; valSpan.style.cursor = 'pointer'; valSpan.style.color = color || '#888';
                    valSpan.onclick = () => {
                        if (key === 'codecMode') {
                            const next = val === 'soft' ? 'hard' : (val === 'hard' ? 'off' : 'soft');
                            Env.setOverride(key, next);
                            ToastManager.show(`Codec: ${next.toUpperCase()} (Reload)`, 'info');
                        } else {
                            Env.setOverride(key, !val);
                            ToastManager.show(`${label}: ${!val ? 'ON' : 'OFF'} (Reload)`, !val ? 'info' : 'warn');
                        }
                    };
                    row.append(labelSpan, valSpan);
                    panel.appendChild(row);
                };

                let codecColor = '#888';
                if (Config.codecMode === 'soft') codecColor = '#4CAF50';
                else if (Config.codecMode === 'hard') codecColor = '#FF9800';

                if (Env.isMatch(SiteLists.disallowCodec)) addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, 'FORCE OFF', '#E91E63');
                else addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, Config.codecMode.toUpperCase(), codecColor);

                addRow('💤 절전 모드', 'throttle', Config.throttle.enabled, Config.throttle.enabled?'ON':'OFF', Config.throttle.enabled?'#4CAF50':'');
                addRow('🚀 모션 제거', 'motion', Config.motion.enabled, Config.motion.enabled?'ON':'OFF', Config.motion.enabled?'#4CAF50':'');
                addRow('👁️ 렌더링/GPU', 'gpu', Config.gpu.enabled, Config.gpu.enabled?'ON':'OFF', Config.gpu.enabled?'#4CAF50':'');
                addRow('🧹 메모리 청소', 'memory', Config.memory.enabled, Config.memory.enabled?'ON':'OFF', Config.memory.enabled?'#4CAF50':'');
                addRow('📟 디버그 HUD', 'debug', Config.debug.enabled, Config.debug.enabled?'ON':'OFF', Config.debug.enabled?'#2196F3':'');

                btn.onclick = () => {
                    if (panel.style.display === 'none') {
                        panel.style.display = 'block';
                        updateMonitor();
                        monitorInterval = setInterval(updateMonitor, 1000);
                    } else {
                        panel.style.display = 'none';
                        clearInterval(monitorInterval);
                    }
                };
                document.body.append(btn, panel);
            });
        }
    }

    class StyleInjector extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                let css = '';
                if (Config.motion.enabled) {
                    css += `*:not(input):not(textarea):not(select) { animation-duration: 0.001s !important; transition-duration: 0.001s !important; scroll-behavior: auto !important; } `;
                }
                if (Config.gpu.enabled) css += `.gpu-acc { transform: translateZ(0); } header, nav, .sticky { transform: translateZ(0); } `;
                if (css) { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); }
            });
        }
    }
    
    // [Platinum Feature] Async Image Decoding
    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image.enabled) return;
            Env.runOnLoad(() => {
                const apply = (node) => {
                    if (node.tagName === 'IMG') {
                        if (!node.hasAttribute('loading')) node.loading = 'lazy';
                        if (!node.hasAttribute('decoding')) node.decoding = 'async';
                    }
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img').forEach(img => {
                            if (!img.hasAttribute('loading')) img.loading = 'lazy';
                            if (!img.hasAttribute('decoding')) img.decoding = 'async';
                        });
                    }
                };
                apply(document.body);
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => apply(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }
    class PreconnectOptimizer extends BaseModule {
        init() {
            if (!Config.connect.enabled) return;
            Env.runOnLoad(() => {
                ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'].forEach(d => {
                    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://' + d; l.crossOrigin = 'anonymous'; document.head.appendChild(l);
                });
            });
        }
    }
    class DebugOverlay extends BaseModule {
        init() {
            if (!Config.debug.enabled) return;
            Env.runOnLoad(() => {
                const hud = document.createElement('div');
                Object.assign(hud.style, {
                    position: 'fixed', top: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: '#0f0',
                    padding: '5px 10px', fontSize: '12px', zIndex: '999999', pointerEvents: 'none', borderRadius: '4px', fontFamily: 'monospace', whiteSpace: 'pre-line'
                });
                document.body.appendChild(hud);
                setInterval(() => {
                    const status = VideoInspector.getStatus();
                    if(status.active) {
                        hud.textContent = `📺 ${status.res}\n⚙️ ${status.policy}\n📉 Drop: ${status.drop}`;
                        hud.style.display = 'block';
                    } else hud.style.display = 'none';
                }, 2000);
            });
        }
    }

    new CodecOptimizer().safeInit();
    new BackgroundThrottler().safeInit();
    [new StyleInjector(), new ImageOptimizer(), new LinkPrefetcher(),
     new PreconnectOptimizer(), new MemoryGuardian(), new DebugOverlay(), new UIController()
    ].forEach(m => m.safeInit());

})();
