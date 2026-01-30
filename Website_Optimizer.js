// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v18.3 Architect Platinum)
// @namespace    http://tampermonkey.net/
// @version      18.3.0-KR-Architect-Platinum
// @description  Adaptive Memory + Smart Positioning + Codec Reality + Draggable UI
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
    // 0. Safety Check
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
        storageKey: `PerfX_v18_${window.location.hostname}`,
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
    // 2. Configuration
    // ========================
    const SiteLists = {
        // [1] 백그라운드 절전 제외 (영상/AI 답변 끊김 방지) (미디어 정지 안 함 & 절전 안 함)
        noThrottling: [
            // 📡 실시간 방송 / 라이브 스트리밍
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'chzzk.naver.com', 'tv.naver.com', 'tv.kakao.com', 'pandalive.co.kr',

            // 🎬 OTT / 동영상 플랫폼
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'disneyplus.com', 'watcha.com',
            'ok.ru',

            // 🤖 AI 채팅 (실시간 답변 생성 중 끊김 방지)
            'gemini.google.com', 'chatgpt.com', 'claude.ai',

            // 🎵 음악 스트리밍
            'music.youtube.com', 'spotify.com',

            // 기타
           'github.com',
        ],

        // [2] 렌더링/GPU 간섭 제외 (레이아웃 틀어짐 방지)
        noRender: [
            // 사이트 레이아웃 깨짐 방지
            'youtube.com', 'dcinside.com', 'tv.naver.com', 'tvwiki5.net', 'avsee.ru', 'cineaste.co.kr', 'inven.co.kr',
        ],

        // [3] H264코덱 제외 제외
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
    // 3. Systems
    // ========================
    class NavigationHandler {
        static listeners = [];
        static onNavigate(cb) { this.listeners.push(cb); }
        static init() {
            let lastUrl = location.href;
            const check = () => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    NavigationHandler.listeners.forEach(cb => cb());
                }
            };
            const wrap = (type) => {
                const orig = history[type];
                return function () {
                    const res = orig.apply(this, arguments);
                    check();
                    return res;
                };
            };
            history.pushState = wrap('pushState');
            history.replaceState = wrap('replaceState');
            window.addEventListener('popstate', check);
            setInterval(check, 1000);
        }
    }

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
            NavigationHandler.onNavigate(() => { currentPrefetchCount = 0; });
            setInterval(() => { if (currentPrefetchCount > 0) currentPrefetchCount--; }, 60000);

            Env.runOnLoad(() => {
                const obs = new IntersectionObserver(entries => {
                    entries.forEach(e => {
                        if (e.isIntersecting) {
                            const el = e.target;
                            el.addEventListener('mouseenter', () => {
                                if (currentPrefetchCount >= MAX_PREFETCH) return;
                                if (!el.dataset.perfPre) {
                                    try { if (new URL(el.href).origin !== window.location.origin) return; } catch { return; }
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

    // [Platinum] Adaptive Memory Guardian
    class MemoryGuardian extends BaseModule {
        init() {
            if (!Config.memory.enabled) return;
            const LIMIT = Env.isMobile ? 600 : 1200;
            const PURGE = Env.isMobile ? 300 : 600;

            let intervalId = null;
            const run = () => {
                if (!document.body) return;
                const targets = document.querySelectorAll('[role="feed"], [role="log"], [data-testid*="chat"], .chat-scrollable, ul, ol');
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
            };

            const start = (delay) => {
                if (intervalId) clearInterval(intervalId);
                intervalId = setInterval(run, delay);
            };

            // Active: 20s, Hidden: 60s (Battery Saver)
            start(20000);
            document.addEventListener('visibilitychange', () => {
                start(document.hidden ? 60000 : 20000);
            });
        }
    }

    class UIController extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                const btn = document.createElement('div');
                btn.textContent = '⚡';
                const savedPos = JSON.parse(localStorage.getItem('perfx_btn_pos') || '{"bottom":"60px","right":"10px"}');

                Object.assign(btn.style, {
                    position: 'fixed',
                    bottom: savedPos.bottom || 'auto', right: savedPos.right || 'auto',
                    top: savedPos.top || 'auto', left: savedPos.left || 'auto',
                    width: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    height: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    fontSize: Env.isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                    background: '#4a90e2', color: '#FFD700', borderRadius: '50%', zIndex: '999999',
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    boxShadow: '0 3px 8px rgba(0,0,0,0.4)', opacity: '0.8', userSelect: 'none',
                    cursor: 'pointer', touchAction: 'none'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    position: 'fixed', width: '240px',
                    background: 'rgba(25,25,25,0.96)', backdropFilter: 'blur(5px)', borderRadius: '8px',
                    padding: '15px', zIndex: '999999', display: 'none', color: '#eee',
                    fontFamily: 'sans-serif', fontSize: '12px', border: '1px solid #444'
                });

                let isDragging = false;
                let startX, startY, initialLeft, initialTop;
                const onMouseDown = (e) => {
                    if (e.button !== 0 && e.type === 'mousedown') return;
                    isDragging = false;
                    const clientX = e.clientX || e.touches[0].clientX;
                    const clientY = e.clientY || e.touches[0].clientY;
                    const rect = btn.getBoundingClientRect();
                    btn.style.bottom = 'auto'; btn.style.right = 'auto';
                    btn.style.left = rect.left + 'px'; btn.style.top = rect.top + 'px';
                    startX = clientX; startY = clientY; initialLeft = rect.left; initialTop = rect.top;
                    document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMouseMove, {passive: false});
                    document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onMouseUp, {passive: false});
                    if (e.cancelable) e.preventDefault();
                };
                const onMouseMove = (e) => {
                    const clientX = e.clientX || e.touches[0].clientX;
                    const clientY = e.clientY || e.touches[0].clientY;
                    const dx = clientX - startX; const dy = clientY - startY;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
                    if (isDragging) {
                        let newLeft = initialLeft + dx; let newTop = initialTop + dy;
                        const maxLeft = window.innerWidth - btn.offsetWidth;
                        const maxTop = window.innerHeight - btn.offsetHeight;
                        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                        newTop = Math.max(0, Math.min(newTop, maxTop));
                        btn.style.left = newLeft + 'px'; btn.style.top = newTop + 'px';
                        if (e.cancelable) e.preventDefault();
                    }
                };
                const onMouseUp = (e) => {
                    document.removeEventListener(e.type === 'mouseup' ? 'mousemove' : 'touchmove', onMouseMove);
                    document.removeEventListener(e.type === 'mouseup' ? 'mouseup' : 'touchend', onMouseUp);
                    if (isDragging) {
                        localStorage.setItem('perfx_btn_pos', JSON.stringify({top: btn.style.top, left: btn.style.left}));
                        if (panel.style.display === 'block') repositionPanel();
                    } else {
                        togglePanel();
                    }
                };
                btn.addEventListener('mousedown', onMouseDown);
                btn.addEventListener('touchstart', onMouseDown);

                const repositionPanel = () => {
                    // [Platinum] Precise Height Calculation
                    // Temporarily render to get dimensions
                    const wasVisible = panel.style.display !== 'none';
                    if (!wasVisible) {
                        panel.style.visibility = 'hidden';
                        panel.style.display = 'block';
                    }

                    const btnRect = btn.getBoundingClientRect();
                    const panelWidth = panel.offsetWidth || 270;
                    const panelHeight = panel.offsetHeight || 300;

                    if (!wasVisible) {
                        panel.style.display = 'none';
                        panel.style.visibility = '';
                    }

                    let newLeft = btnRect.left - panelWidth - 12;
                    let newTop = btnRect.top;
                    if (newLeft < 10) newLeft = btnRect.right + 12;
                    if (newTop + panelHeight > window.innerHeight) newTop = window.innerHeight - panelHeight - 10;
                    if (newTop < 10) newTop = 10;
                    panel.style.left = newLeft + 'px';
                    panel.style.top = newTop + 'px';
                    panel.style.bottom = 'auto'; panel.style.right = 'auto';
                };

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
                            // [Platinum] Trustworthy HUD
                            monitorBox.textContent = `📺 ${status.res} | 📉 ${status.drop}\n⚙️ Policy: ${status.policy}`;
                            monitorBox.style.color = status.isBad ? '#FF5252' : '#4CAF50';
                        }
                    } else {
                        monitorBox.textContent = status.msg;
                        monitorBox.style.color = '#777';
                    }
                };

                const togglePanel = () => {
                    if (panel.style.display === 'none') {
                        repositionPanel(); // Smart Pos
                        panel.style.display = 'block';
                        updateMonitor();
                        monitorInterval = setInterval(updateMonitor, 1000);
                    } else {
                        panel.style.display = 'none';
                        clearInterval(monitorInterval);
                    }
                };

                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px; display:flex; justify-content:space-between; align-items:center';
                const titleContainer = document.createElement('div');
                const titleMain = document.createElement('b'); titleMain.textContent = 'PerfX ';
                const titleVer = document.createElement('span'); titleVer.textContent = 'v18.3'; titleVer.style.cssText = 'font-size:10px;color:#aaa';
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

    NavigationHandler.init();
    new CodecOptimizer().safeInit();
    new BackgroundThrottler().safeInit();
    [new StyleInjector(), new ImageOptimizer(), new LinkPrefetcher(),
     new PreconnectOptimizer(), new MemoryGuardian(), new DebugOverlay(), new UIController()
    ].forEach(m => m.safeInit());

})();
