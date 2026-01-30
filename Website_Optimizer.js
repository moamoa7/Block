// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v14.5 UI Enhanced)
// @namespace    http://tampermonkey.net/
// @version      14.5.0-KR-UI-Fix
// @description  모든 사이트 H.264 강제 (예외 리스트 제외) + CSP Bypass + 모바일 UI 최적화
// @author       KiwiFruit (Architected by AI)
// @match        *://*/*
// @exclude      *://weibo.com/*
// @exclude      *://*.weibo.com/*
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ========================
    // 1. 도메인 리스트 (Control Tower)
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
            // 채팅창 상단 흐르는 글씨 반복 빠름 해결
            'twitch.tv',
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

        // ★ [4] 코덱 강제 "제외" 리스트 (Blacklist) ★
        // 여기에 적힌 사이트만 H.264 강제를 안 합니다. (나머지는 다 합니다)
        disallowCodec: [
            'netflix.com',       // DRM 오류
            'disneyplus.com',    // DRM 오류
            'tving.com',         // DRM 오류
            'wavve.com',         // DRM 오류
            'coupangplay.com',   // DRM 오류
            'watcha.com',        // DRM 오류
            'meet.google.com',   // 화상회의 (WebRTC) 화면 깨짐 방지
            'discord.com',       // 화상채팅 호환성
            'zoom.us'            // 화상회의 호환성
        ]
    };

    // ========================
    // 2. 환경 설정
    // ========================
    const Env = {
        isMatch(list) { return list.some(d => window.location.hostname.includes(d)); },
        storageKey: `PerfX_Override_${window.location.hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } },
        setOverride(key, val) {
            const data = this.getOverrides(); data[key] = val;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        }
    };

    const overrides = Env.getOverrides();
    const Config = {
        // ★ 로직 변경: "제외 리스트에 없고(!Match)" AND "사용자가 안 껐으면" => 켜짐
        codec: { enabled: !Env.isMatch(SiteLists.disallowCodec) && overrides.codec !== false },

        throttle: { enabled: !Env.isMatch(SiteLists.noThrottling) && overrides.throttle !== false },
        motion: { enabled: !Env.isMatch(SiteLists.noMotion) && overrides.motion !== false },
        gpu: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.gpu !== false },
        image: { enabled: !Env.isMatch(SiteLists.noRender) && overrides.image !== false },
        prefetch: { enabled: !Env.isMatch(SiteLists.noThrottling) && overrides.prefetch !== false },
        connect: { enabled: true && overrides.connect !== false },
        memory: { enabled: overrides.memory !== false }
    };

    // ========================
    // 3. 모듈 시스템
    // ========================
    class BaseModule {
        safeInit() { try { this.init(); } catch (e) { console.error(`[PerfX] ${this.constructor.name}`, e); } }
        init() {}
    }

    class CodecOptimizer extends BaseModule {
        init() {
            if (!Config.codec.enabled) return;
            const mse = window.MediaSource;
            if (!mse || mse._perfXHooked) return;
            const orig = mse.isTypeSupported.bind(mse);
            mse.isTypeSupported = (t) => {
                if (!t) return false;
                // VP9, AV1 코덱을 브라우저가 지원 안 한다고 거짓말함 -> H.264 강제 유도
                if (t.toLowerCase().match(/vp9|vp09|av01/)) return false;
                return orig(t);
            };
            mse._perfXHooked = true;
            console.log('[PerfX] H.264 Enforced (Global Mode)');
        }
    }

    class BackgroundThrottler extends BaseModule {
        init() {
            if (!Config.throttle.enabled) return;
            let isThrottled = false;
            const origSetTimeout = window.setTimeout;
            const origRAF = window.requestAnimationFrame;
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (isThrottled) return;
                    isThrottled = true;
                    document.title = '💤 ' + document.title.replace(/^💤 /, '');
                    window.requestAnimationFrame = (cb) => origSetTimeout(() => { try{cb(performance.now())}catch(e){} }, 1000);
                } else {
                    if (!isThrottled) return;
                    isThrottled = false;
                    document.title = document.title.replace(/^💤 /, '');
                    window.requestAnimationFrame = origRAF;
                }
            });
        }
    }

    class StyleInjector extends BaseModule {
        init() {
            let css = '';
            if (Config.motion.enabled) css += `*, *::before, *::after { animation-duration: 0.001s !important; transition-duration: 0.001s !important; scroll-behavior: auto !important; } `;
            if (Config.gpu.enabled) css += `.gpu-acc { transform: translateZ(0); } header, nav, .sticky { transform: translateZ(0); } `;
            if (css) {
                const style = document.createElement('style');
                style.textContent = css;
                document.head.appendChild(style);
            }
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image.enabled) return;
            const apply = (node) => {
                if (node.tagName === 'IMG' && !node.hasAttribute('loading')) node.loading = 'lazy';
                if (node.querySelectorAll) node.querySelectorAll('img:not([loading])').forEach(img => img.loading = 'lazy');
            };
            apply(document.body);
            new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => apply(n)))).observe(document.body, {childList:true, subtree:true});
        }
    }

    class LinkPrefetcher extends BaseModule {
        init() {
            if (!Config.prefetch.enabled) return;
            const obs = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const el = e.target;
                        el.addEventListener('mouseenter', () => {
                            if (!el.dataset.perfPre) {
                                const l = document.createElement('link'); l.rel = 'prefetch'; l.href = el.href;
                                document.head.appendChild(l);
                                el.dataset.perfPre = '1';
                            }
                        }, {once:true, passive:true});
                        obs.unobserve(el);
                    }
                });
            });
            const scan = (n) => n.querySelectorAll && n.querySelectorAll('a[href^="http"]').forEach(a => obs.observe(a));
            scan(document.body);
            new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(document.body, {childList:true, subtree:true});
        }
    }

    class PreconnectOptimizer extends BaseModule {
        init() {
            if (!Config.connect.enabled) return;
            ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'].forEach(d => {
                const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://' + d; l.crossOrigin = 'anonymous';
                document.head.appendChild(l);
            });
        }
    }

    class MemoryGuardian extends BaseModule {
        init() {
            if (!Config.memory.enabled) return;
            setInterval(() => {
                const targets = document.querySelectorAll('ul, ol, div[class*="chat"], div[class*="list"]');
                targets.forEach(el => {
                    if (el.matches(':hover, :focus-within')) return;
                    if (el.matches('[role="log"], .virtualized, .react-window')) return;
                    if (el.childElementCount > 800) {
                        for(let i=0; i<el.childElementCount-400; i++) el.firstElementChild?.remove();
                    }
                });
            }, 30000);
        }
    }

    // ========================
    // 4. UI 컨트롤러 (업그레이드됨: 반응형 사이즈 적용)
    // ========================
    class UIController extends BaseModule {
        init() {
            // [New] 모바일 환경 감지
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

            const btn = document.createElement('div');
            btn.textContent = '⚡';

            // [Modified] 모바일/PC 반응형 크기 적용 (Video_Image_Control 로직 이식)
            Object.assign(btn.style, {
                position: 'fixed',
                bottom: '60px',
                right: '10px',
                // 아래 3줄이 변경된 부분: clamp 및 vmin을 사용하여 화면 크기에 따라 자동 조절
                width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',

                background: '#4a90e2', // 파랑 배경
                color: '#FFD700',      /* 금색 번개 */
                border: '1px solid #ccc', // (선택사항) 테두리 추가 시 이 줄도 넣으세요
                borderRadius: '50%',
                zIndex: '999999',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                cursor: 'pointer',
                boxShadow: '0 3px 8px rgba(0,0,0,0.4)',
                opacity: '0.8',
                userSelect: 'none', // 터치 시 선택 방지
                touchAction: 'none' // 터치 동작 최적화
            });

            const panel = document.createElement('div');
            Object.assign(panel.style, {
                position: 'fixed',
                bottom: '70px',
                right: '20px',
                width: '240px',
                background: 'rgba(25,25,25,0.96)',
                backdropFilter: 'blur(5px)',
                borderRadius: '8px',
                padding: '15px',
                zIndex: '999999',
                display: 'none',
                color: '#eee',
                fontFamily: 'sans-serif',
                fontSize: '12px',
                border: '1px solid #444'
            });

            const titleRow = document.createElement('div');
            titleRow.style.cssText = 'margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px';
            const titleB = document.createElement('b');
            titleB.textContent = 'PerformanceX ';
            const titleSpan = document.createElement('span');
            titleSpan.textContent = 'Global';
            titleSpan.style.cssText = 'font-size:10px; color:#aaa';
            titleRow.append(titleB, titleSpan);
            panel.appendChild(titleRow);

            const addRow = (label, key, state, reason) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px; align-items:center';

                const labelSpan = document.createElement('span');
                labelSpan.textContent = label;

                const statusBtn = document.createElement('span');
                statusBtn.textContent = state ? 'ON' : 'OFF';
                statusBtn.style.fontWeight = 'bold';
                statusBtn.style.cursor = 'pointer';

                let color = '#888';
                if (state) color = '#4CAF50'; // Green
                else if (reason && reason.includes('리스트')) color = '#E91E63'; // Red
                statusBtn.style.color = color;

                statusBtn.onclick = () => {
                    Env.setOverride(key, !state);
                    alert('설정 변경됨. 새로고침 후 적용됩니다.');
                };

                row.append(labelSpan, statusBtn);
                panel.appendChild(row);
            };

            const getReason = (key, list) => Env.isMatch(list) ? '사이트 보호' : '사용자 OFF';

            // ★ UI 상태 표시 로직 수정됨 (disallowCodec 체크)
            addRow('🎥 코덱 강제', 'codec', Config.codec.enabled, Config.codec.enabled?'':(Env.isMatch(SiteLists.disallowCodec)?'차단 리스트 포함':'사용자 OFF'));

            addRow('💤 절전 모드', 'throttle', Config.throttle.enabled, Config.throttle.enabled?'':getReason('throttle', SiteLists.noThrottling));
            addRow('🚀 모션 제거', 'motion', Config.motion.enabled, Config.motion.enabled?'':getReason('motion', SiteLists.noMotion));
            addRow('👁️ 렌더링/GPU', 'gpu', Config.gpu.enabled, Config.gpu.enabled?'':getReason('gpu', SiteLists.noRender));
            addRow('🖼️ 이미지 지연', 'image', Config.image.enabled, Config.image.enabled?'':getReason('image', SiteLists.noRender));
            addRow('🔗 링크 프리패치', 'prefetch', Config.prefetch.enabled, Config.prefetch.enabled?'':getReason('prefetch', SiteLists.noThrottling));
            addRow('🔌 프리커넥트', 'connect', Config.connect.enabled, '사용자 OFF');
            addRow('🧹 메모리 청소', 'memory', Config.memory.enabled, '사용자 OFF');

            const infoDiv = document.createElement('div');
            infoDiv.style.cssText = 'font-size:10px; color:#777; margin-top:8px';
            infoDiv.textContent = '※ 빨간 OFF는 제외 리스트(disallow)에 의해 꺼진 상태입니다.';
            panel.appendChild(infoDiv);

            btn.onclick = () => panel.style.display = panel.style.display==='none'?'block':'none';
            document.body.append(btn, panel);
        }
    }

    [
        new CodecOptimizer(), new BackgroundThrottler(), new StyleInjector(),
        new ImageOptimizer(), new LinkPrefetcher(), new PreconnectOptimizer(),
        new MemoryGuardian(), new UIController()
    ].forEach(m => m.safeInit());

})();
