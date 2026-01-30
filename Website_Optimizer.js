// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v15.3 Ultimate)
// @namespace    http://tampermonkey.net/
// @version      15.3.0-KR-Ultimate
// @description  H.264/VP9 제어 + CPU/RAM 절약 + CSP Friendly + Smart Prefetch
// @author       KiwiFruit (Architected by AI)
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
    // 0. 환경 감지 및 유틸
    // ========================
    const Env = {
        isMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
        isDataSaver: navigator.connection?.saveData === true, // [New] 데이터 절약 모드 감지
        storageKey: `PerfX_v15_${window.location.hostname}`,
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
    // 1. 도메인 리스트
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

        // [2] 동작 줄이기 제외 (강제 애니메이션 제거 시 UI가 깨지는 곳)
        noMotion: [
            // OTT 프로필 선택 화면 / 영상 안보임 등
            'coupangplay.com', 'wavve.com',
            // 화려한 웹사이트 / AI 효과
            'apple.com', 'gemini.google.com',
            // 일부 애니메이션 효과 안보임
            'etoland.co.kr',
        ],

        // [3] 렌더링/GPU 간섭 제외 (레이아웃 틀어짐 방지)
        noRender: [
            // 채팅창 레이어 깨짐 방지
            'twitch.tv',
            // 사이트 레이아웃 깨짐 방지
            'youtube.com', 'dcinside.com', 'tv.naver.com', 'tvwiki5.net', 'avsee.ru', 'cineaste.co.kr', 'inven.co.kr',
        ],

        disallowCodec: [
            'netflix.com', 'disneyplus.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'watcha.com',
            'meet.google.com', 'discord.com', 'zoom.us'
        ]
    };

    // ========================
    // 2. 설정 (Config)
    // ========================
    const overrides = Env.getOverrides();
    const Config = {
        codecMode: overrides.codecMode || 'soft',
        throttle: { enabled: !Env.isMatch(SiteLists.noThrottling) && overrides.throttle !== false },
        motion: { enabled: !Env.isMatch(SiteLists.noMotion) && overrides.motion !== false },
        gpu: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.gpu !== false },
        image: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.image !== false },
        // [Refine] 데이터 세이버거나 제외 리스트면 끔
        prefetch: { enabled: !Env.isDataSaver && !Env.isMatch(SiteLists.noThrottling) && overrides.prefetch !== false },
        connect: { enabled: overrides.connect !== false },
        memory: { enabled: overrides.memory !== false },
        debug: { enabled: overrides.debug === true }
    };

    if (Env.isMatch(SiteLists.disallowCodec)) Config.codecMode = 'off';

    // ========================
    // 3. 모듈 시스템
    // ========================
    class BaseModule {
        safeInit() { try { this.init(); } catch (e) { console.error(`[PerfX] ${this.constructor.name}`, e); } }
        init() {}
    }

    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;

            const enableHook = () => {
                if (!window.MediaSource) return;
                // [New] 중복 후킹 방지 + 소유권 명시
                if (window.MediaSource._perfXHooked) return;

                const orig = window.MediaSource.isTypeSupported.bind(window.MediaSource);
                const cache = new Map(); // [New] 결과 캐싱 (성능 최적화)

                window.MediaSource.isTypeSupported = (t) => {
                    if (!t) return false;
                    if (cache.has(t)) return cache.get(t); // 캐시 히트

                    const type = t.toLowerCase();
                    let result = true;

                    if (Config.codecMode === 'soft') {
                        if (type.includes('av01')) result = false; // Soft: AV1 차단
                    } else if (Config.codecMode === 'hard') {
                        if (type.match(/vp9|vp09|av01/)) result = false; // Hard: H.264 강제
                    }

                    if (result) result = orig(t); // 브라우저 지원 여부 최종 확인

                    cache.set(t, result); // 결과 저장
                    return result;
                };

                window.MediaSource._perfXHooked = true;
                console.log(`[PerfX] Codec Hooked (${Config.codecMode}) - Cache Enabled`);
            };

            enableHook();
            window.addEventListener('DOMContentLoaded', enableHook);
        }
    }

    class BackgroundThrottler extends BaseModule {
        init() {
            if (!Config.throttle.enabled) return;
            let isThrottled = false;
            const origSetTimeout = window.setTimeout;
            const origRAF = window.requestAnimationFrame;

            // [Refine] Soft-Gate Logic
            const throttledRAF = (cb) => origSetTimeout(() => {
                try { cb(performance.now()); } catch(e) {}
            }, 1000);

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (isThrottled) return;
                    isThrottled = true;
                    document.title = '💤 ' + document.title.replace(/^💤 /, '');
                    window.requestAnimationFrame = throttledRAF;
                } else {
                    if (!isThrottled) return;
                    isThrottled = false;
                    document.title = document.title.replace(/^💤 /, '');
                    window.requestAnimationFrame = origRAF;
                }
            });
        }
    }

    class LinkPrefetcher extends BaseModule {
        init() {
            if (!Config.prefetch.enabled) return;
            Env.runOnLoad(() => {
                const obs = new IntersectionObserver(entries => {
                    entries.forEach(e => {
                        if (e.isIntersecting) {
                            const el = e.target;
                            el.addEventListener('mouseenter', () => {
                                if (!el.dataset.perfPre) {
                                    // [New] 외부 도메인 차단 & 프로토콜 확인
                                    try {
                                        const url = new URL(el.href);
                                        if (url.origin !== window.location.origin) return; // Same-Origin Only
                                    } catch (e) { return; }

                                    const l = document.createElement('link'); l.rel = 'prefetch'; l.href = el.href;
                                    document.head.appendChild(l);
                                    el.dataset.perfPre = '1';
                                }
                            }, {once:true, passive:true});
                            obs.unobserve(el);
                        }
                    });
                });

                // [New] http/https 링크만 탐색
                const scan = (n) => n.querySelectorAll && n.querySelectorAll('a[href^="http"]').forEach(a => obs.observe(a));
                scan(document.body);
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }

    // (나머지 모듈은 v15.2와 동일하되 Stability 유지)
    class StyleInjector extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                let css = '';
                if (Config.motion.enabled) css += `*, *::before, *::after { animation-duration: 0.001s !important; transition-duration: 0.001s !important; scroll-behavior: auto !important; } `;
                if (Config.gpu.enabled) css += `.gpu-acc { transform: translateZ(0); } header, nav, .sticky { transform: translateZ(0); } `;
                if (css) {
                    const style = document.createElement('style');
                    style.textContent = css;
                    document.head.appendChild(style);
                }
            });
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image.enabled) return;
            Env.runOnLoad(() => {
                const apply = (node) => {
                    if (node.tagName === 'IMG' && !node.hasAttribute('loading')) node.loading = 'lazy';
                    if (node.querySelectorAll) node.querySelectorAll('img:not([loading])').forEach(img => img.loading = 'lazy');
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
                    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://' + d; l.crossOrigin = 'anonymous';
                    document.head.appendChild(l);
                });
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
                const targets = document.querySelectorAll('ul, ol, div[class*="chat"], div[class*="list"], div[class*="scroller"]');
                targets.forEach(el => {
                    if (el.matches(':hover, :focus-within')) return;
                    if (el.matches('[role="log"], .virtualized, .react-window')) return;
                    if (el.childElementCount > LIMIT) {
                        for(let i=0; i < el.childElementCount - PURGE; i++) el.firstElementChild?.remove();
                    }
                });
            }, 30000);
        }
    }

    class DebugOverlay extends BaseModule {
        init() {
            if (!Config.debug.enabled) return;
            Env.runOnLoad(() => {
                const hud = document.createElement('div');
                Object.assign(hud.style, {
                    position: 'fixed', top: '10px', left: '10px',
                    background: 'rgba(0,0,0,0.7)', color: '#0f0',
                    padding: '5px 10px', fontSize: '12px', zIndex: '999999',
                    pointerEvents: 'none', borderRadius: '4px', fontFamily: 'monospace',
                    whiteSpace: 'pre-line'
                });
                document.body.appendChild(hud);

                setInterval(() => {
                    const v = document.querySelector('video');
                    if (v) {
                        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
                        const w = v.videoWidth;
                        const h = v.videoHeight;
                        // [Update] 정보 표시 포맷 개선
                        hud.textContent = `📺 ${w}x${h}\n🛡️ Mode: ${Config.codecMode.toUpperCase()}\n📉 Drop: ${q.droppedVideoFrames||0}`;
                        hud.style.display = 'block';
                    } else {
                        hud.style.display = 'none';
                    }
                }, 2000);
            });
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
                    background: '#4a90e2', color: '#FFD700',
                    borderRadius: '50%', zIndex: '999999',
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    cursor: 'pointer', boxShadow: '0 3px 8px rgba(0,0,0,0.4)',
                    opacity: '0.8', userSelect: 'none', touchAction: 'none'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    position: 'fixed', bottom: '70px', right: '20px',
                    width: '240px', background: 'rgba(25,25,25,0.96)',
                    backdropFilter: 'blur(5px)', borderRadius: '8px', padding: '15px',
                    zIndex: '999999', display: 'none', color: '#eee',
                    fontFamily: 'sans-serif', fontSize: '12px', border: '1px solid #444'
                });

                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px; display:flex; justify-content:space-between';
                const titleText = document.createElement('span');
                const titleBold = document.createElement('b');
                titleBold.textContent = 'PerfX ';
                const titleVer = document.createElement('span');
                titleVer.textContent = 'v15.3'; // Version Up
                titleVer.style.cssText = 'font-size:10px;color:#aaa';
                titleText.append(titleBold, titleVer);
                const closeBtn = document.createElement('span');
                closeBtn.textContent = '✖';
                closeBtn.style.cursor = 'pointer';
                closeBtn.onclick = () => panel.style.display = 'none';
                titleRow.append(titleText, closeBtn);
                panel.appendChild(titleRow);

                const addRow = (label, key, val, displayVal, color) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px; align-items:center';
                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = label;
                    const valSpan = document.createElement('span');
                    valSpan.textContent = displayVal;
                    valSpan.style.fontWeight = 'bold';
                    valSpan.style.cursor = 'pointer';
                    valSpan.style.color = color || '#888';
                    valSpan.onclick = () => {
                       if (key === 'codecMode') {
                           const next = val === 'soft' ? 'hard' : (val === 'hard' ? 'off' : 'soft');
                           Env.setOverride(key, next);
                       } else {
                           Env.setOverride(key, !val);
                       }
                       alert('설정 변경됨. 새로고침 후 적용됩니다.');
                    };
                    row.append(labelSpan, valSpan);
                    panel.appendChild(row);
                };

                let codecColor = '#888';
                if (Config.codecMode === 'soft') codecColor = '#4CAF50';
                else if (Config.codecMode === 'hard') codecColor = '#FF9800';

                if (Env.isMatch(SiteLists.disallowCodec)) {
                    addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, 'FORCE OFF', '#E91E63');
                } else {
                    addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, Config.codecMode.toUpperCase(), codecColor);
                }

                addRow('💤 절전 모드', 'throttle', Config.throttle.enabled, Config.throttle.enabled?'ON':'OFF', Config.throttle.enabled?'#4CAF50':'');
                addRow('🚀 모션 제거', 'motion', Config.motion.enabled, Config.motion.enabled?'ON':'OFF', Config.motion.enabled?'#4CAF50':'');
                addRow('👁️ 렌더링/GPU', 'gpu', Config.gpu.enabled, Config.gpu.enabled?'ON':'OFF', Config.gpu.enabled?'#4CAF50':'');
                addRow('🧹 메모리 청소', 'memory', Config.memory.enabled, Config.memory.enabled?'ON':'OFF', Config.memory.enabled?'#4CAF50':'');
                addRow('📟 디버그 HUD', 'debug', Config.debug.enabled, Config.debug.enabled?'ON':'OFF', Config.debug.enabled?'#2196F3':'');

                const infoDiv = document.createElement('div');
                infoDiv.style.cssText = 'font-size:9px; color:#666; margin-top:8px; text-align:right';
                infoDiv.textContent = 'Soft: AV1차단 / Hard: H.264강제';
                panel.appendChild(infoDiv);

                btn.onclick = () => panel.style.display = panel.style.display==='none'?'block':'none';
                document.body.append(btn, panel);
            });
        }
    }

    new CodecOptimizer().safeInit();
    new BackgroundThrottler().safeInit();
    [new StyleInjector(), new ImageOptimizer(), new LinkPrefetcher(),
     new PreconnectOptimizer(), new MemoryGuardian(), new DebugOverlay(), new UIController()
    ].forEach(m => m.safeInit());

})();
