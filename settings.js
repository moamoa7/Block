// ==UserScript==
// @name         VideoSpeed_Control (Light - Patched for YouTube & TrustedHTML)
// @namespace    https.com/
// @version      23.25-Patch.9-Hybrid-Stable
// @description  🎞️ [최종 안정화] 모든 최적화 로직을 제거하고, 초기 버전(Patch.2)의 안정적인 전체 재스캔 방식으로 회귀. 찾은 미디어만 재처리하지 않도록 수정하여 안정성과 효율성을 모두 확보했습니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ============================
     * 설정: 전역 기능 및 제외 도메인
     * ============================ */
    const FeatureFlags = {
        debug: false,
        videoControls: true,
        spaPartialUpdate: true,
        previewFiltering: true,
        iframeProtection: true,
        mediaSessionIntegration: true,
    };

    const NOT_EXCLUSION_DOMAINS = ['avsee.ru'];
    const EXCLUSION_PATHS = ['/bbs/login.php'];
    const PREVIEW_CONFIG = { DURATION_THRESHOLD: 0 };

    /* ============================
     * 유틸리티 함수
     * ============================ */
    function safeExec(fn, label = '') {
        try {
            fn();
        } catch (e) {
            if (FeatureFlags.debug) {
                console.error(`[VideoSpeed] Error in ${label}:`, e);
            }
        }
    }

    function debounce(fn, wait) {
        let t;
        return function (...a) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, a), wait);
        };
    }

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', {
        value: true, writable: false, configurable: true
    });

    function isExcluded() {
        let excluded = false;
        safeExec(() => {
            const url = new URL(location.href);
            const host = url.hostname;
            const path = url.pathname;
            const domainMatch = NOT_EXCLUSION_DOMAINS.some(d => host === d || host.endsWith('.' + d));
            if (domainMatch && EXCLUSION_PATHS.some(p => path.startsWith(p))) {
                excluded = true;
            }
        }, 'isExcluded');
        return excluded;
    }

    if (isExcluded()) {
        console.log(`[VideoSpeed] Disabled on ${location.href}`);
        return;
    }

    /* ============================
     * 콘솔 클리어 방지
     * ============================ */
    safeExec(() => {
        if (window.console && console.clear) {
            const originalClear = console.clear;
            console.clear = () => console.log('--- 🚫 console.clear() has been blocked. ---');
            Object.defineProperty(console, 'clear', {
                configurable: false,
                writable: false,
                value: console.clear
            });
        }
    }, 'consoleClearProtection');

    /* ============================
     * Shadow DOM 강제 open
     * ============================ */
    (function hackAttachShadow() {
        if (window._hasHackAttachShadow_) return;
        safeExec(() => {
            window._shadowDomList_ = window._shadowDomList_ || [];
            const originalAttachShadow = window.Element.prototype.attachShadow;
            window.Element.prototype.attachShadow = function () {
                const args = arguments;
                if (args[0] && args[0].mode) args[0].mode = 'open';
                const root = originalAttachShadow.apply(this, args);
                window._shadowDomList_.push(root);
                document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: root } }));
                return root;
            };
            window._hasHackAttachShadow_ = true;
        }, 'hackAttachShadow');
    })();

    /* ============================
     * UI 관리 (UI Manager) - 변경 없음
     * ============================ */
    const uiManager = (() => {
        let host, shadowRoot;

        function init() {
            if (host) return;
            host = document.createElement('div');
            host.id = 'vsc-ui-host';
            Object.assign(host.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                pointerEvents: 'none', zIndex: '2147483647'
            });
            shadowRoot = host.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = `
                :host { pointer-events: none; } * { pointer-events: auto; }
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity .2s, width .3s, background .2s; }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-slider-container.minimized { width: 30px; }
                #vm-speed-slider, #vm-speed-value, #vm-speed-slider-container .vm-btn.reset { opacity: 1; transform: scaleY(1); transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
                #vm-speed-slider-container.minimized > :not(.toggle) { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 4px 0; accent-color: #e74c3c; }
                #vm-speed-value { color: #f44336; font-weight: bold; font-size: 14px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; }
                #vm-time-display { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 102; background: rgba(0,0,0,0.7); color: #fff; padding: 10px 20px; border-radius: 5px; font-size: 1.5rem; display: none; opacity: 1; transition: opacity 0.3s ease-out; pointer-events: none; }
            `;
            shadowRoot.appendChild(style);
            (document.body || document.documentElement).appendChild(host);
        }

        return {
            init: () => safeExec(init, 'uiManager.init'),
            getShadowRoot: () => (shadowRoot || init(), shadowRoot),
            moveUiTo: (target) => {
                if (host && target && host.parentNode !== target) target.appendChild(host);
            }
        };
    })();

    /* ============================
     * 핵심 로직 모듈 - 변경 없음
     * ============================ */
    const speedSlider = (() => {
        let container, sliderEl, valueEl, inited = false, isMinimized = true;

        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot();
            if (!shadowRoot) return;

            container = document.createElement('div'); container.id = 'vm-speed-slider-container';
            const resetButton = document.createElement('button'); resetButton.className = 'vm-btn reset'; resetButton.title = 'Reset speed to 1x'; resetButton.textContent = '1x';
            sliderEl = document.createElement('input'); sliderEl.type = 'range'; sliderEl.min = '0.2'; sliderEl.max = '4.0'; sliderEl.step = '0.2'; sliderEl.value = '1.0'; sliderEl.id = 'vm-speed-slider';
            valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            const toggleButton = document.createElement('button'); toggleButton.className = 'vm-btn toggle'; toggleButton.title = 'Toggle Speed Controller';

            container.append(resetButton, sliderEl, valueEl, toggleButton);
            shadowRoot.appendChild(container);

            resetButton.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); });
            sliderEl.addEventListener('input', (e) => { const speed = parseFloat(e.target.value); applySpeed(speed); updateValueText(speed); });
            toggleButton.addEventListener('click', () => { isMinimized = !isMinimized; updateAppearance(); });

            inited = true;
            updateAppearance();
        }

        const updateValueText = (speed) => valueEl && (valueEl.textContent = `x${speed.toFixed(1)}`);
        const applySpeed = (speed) => App.getMediaCache().forEach(m => { if (!m.paused && m.playbackRate !== speed) safeExec(() => { m.playbackRate = speed; }); });
        function updateAppearance() {
            if (!container) return;
            container.classList.toggle('minimized', isMinimized);
            container.querySelector('.toggle').textContent = isMinimized ? '🔻' : '🔺';
        }

        return {
            init: () => safeExec(init, 'speedSlider.init'),
            show: () => { if (container) container.style.display = 'flex'; },
            hide: () => { if (container) container.style.display = 'none'; },
        };
    })();

    /* ============================
     * 메인 컨트롤러 (App) - 핵심 변경 사항 적용
     * ============================ */
    const App = (() => {
        const SEEN_MEDIA = new WeakSet(); // [핵심 최적화] 처리한 미디어를 기억하여 반복 작업을 방지
        let activeMediaCache = [];
        let uiVisible = false;

        function findAllMedia(doc) {
            const media = [];
            safeExec(() => {
                const root = doc || document;
                root.querySelectorAll('video, audio').forEach(m => media.push(m));

                // Shadow DOM 내부 검색
                const shadowRoots = doc ? (doc.querySelectorAll ? Array.from(doc.querySelectorAll('*')).map(el => el.shadowRoot).filter(Boolean) : []) : (window._shadowDomList_ || []);
                shadowRoots.forEach(sr => {
                    sr.querySelectorAll('video, audio').forEach(m => media.push(m));
                });

                // Iframe 내부 검색
                if (!doc) { // 최상위 문서에서만 iframe 검색
                    document.querySelectorAll('iframe').forEach(iframe => {
                        try {
                            if (iframe.contentDocument) {
                                media.push(...findAllMedia(iframe.contentDocument));
                            }
                        } catch (e) { /* cross-origin 무시 */ }
                    });
                }
            });
            return [...new Set(media)];
        }

        function initMedia(media) {
            if (!media || SEEN_MEDIA.has(media)) return;
            SEEN_MEDIA.add(media); // 한 번 처리한 미디어는 기억

            const updateUI = () => scanTask(true);
            media.addEventListener('play', updateUI);
            media.addEventListener('pause', updateUI);
            media.addEventListener('ended', updateUI);
            media.addEventListener('loadstart', updateUI);
        }

        const scanTask = (isUiUpdateOnly = false) => {
            const allMedia = findAllMedia();

            if (!isUiUpdateOnly) {
                allMedia.forEach(initMedia);
            }

            activeMediaCache = allMedia.filter(m => m.isConnected);
            const shouldBeVisible = activeMediaCache.length > 0;

            if (uiVisible !== shouldBeVisible) {
                uiVisible = shouldBeVisible;
                uiVisible ? speedSlider.show() : speedSlider.hide();
            }
        };

        const debouncedScanTask = debounce(scanTask, 300);

        function initialize() {
            console.log('🎉 VideoSpeed_Control (v23.25-Patch.9-Hybrid-Stable) Initialized.');
            uiManager.init();
            speedSlider.init();

            // 모든 DOM 변경 시, 안정적으로 전체 재스캔 (단, debounce로 성능 제어)
            const observer = new MutationObserver(debouncedScanTask);
            observer.observe(document, { childList: true, subtree: true });

            document.addEventListener('addShadowRoot', debouncedScanTask);

            // 최초 실행
            scanTask();
        }

        return {
            initialize,
            getMediaCache: () => activeMediaCache,
        };
    })();

    /* ============================
     * 스크립트 실행
     * ============================ */
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        App.initialize();
    } else {
        window.addEventListener('DOMContentLoaded', App.initialize, { once: true });
    }
})();
