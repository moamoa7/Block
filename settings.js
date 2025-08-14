// ==UserScript==
// @name         VideoSpeed_Control (Light - Patched for YouTube & TrustedHTML)
// @namespace    https.com/
// @version      23.25-Patch.4-Stable
// @description  🎞️ [안정성 강화] iframe 중복 관찰 방지, 메모리 자동 정리, 속도 제어 범위 확대, 드래그 탐색 이벤트 조건 강화로 안정성을 최종 개선했습니다.
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
     * 전역 상태 및 캐시
     * ============================ */
    const MediaStateManager = (() => {
        const wm = new WeakMap();
        return {
            has: (m) => wm.has(m),
            get: (m) => wm.get(m),
            set: (m, v) => wm.set(m, v),
            delete: (m) => wm.delete(m),
        };
    })();

    let PROCESSED_DOCUMENTS = new WeakSet();
    const OBSERVER_MAP = new Map();
    let activeMediaCache = [];

    /* ============================
     * UI 관리 (UI Manager)
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
                :host { pointer-events: none; }
                * { pointer-events: auto; }
                #vm-speed-slider-container {
                    position: fixed; top: 50%; right: 0; transform: translateY(-50%);
                    background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100;
                    display: none; flex-direction: column; align-items: center; width: 50px;
                    opacity: 0.3; transition: opacity .2s, width .3s, background .2s;
                }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-slider-container.minimized { width: 30px; }
                #vm-speed-slider, #vm-speed-value, #vm-speed-slider-container .vm-btn.reset {
                    opacity: 1;
                    transform: scaleY(1);
                    transition: opacity 0.2s, transform 0.2s;
                    transform-origin: bottom;
                }
                #vm-speed-slider-container.minimized > :not(.toggle) {
                    opacity: 0;
                    transform: scaleY(0);
                    height: 0; margin: 0; padding: 0;
                }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 4px 0; accent-color: #e74c3c; }
                #vm-speed-value { color: #f44336; font-weight: bold; font-size: 14px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; }
                #vm-time-display {
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
                    z-index: 102; background: rgba(0,0,0,0.7); color: #fff; padding: 10px 20px;
                    border-radius: 5px; font-size: 1.5rem; display: none; opacity: 1;
                    transition: opacity 0.3s ease-out; pointer-events: none;
                }
            `;
            shadowRoot.appendChild(style);
            (document.body || document.documentElement).appendChild(host);
        }

        return {
            init: () => safeExec(init, 'uiManager.init'),
            getShadowRoot: () => {
                if (!shadowRoot) init();
                return shadowRoot;
            },
            moveUiTo: (target) => {
                if (host && target && host.parentNode !== target) {
                    target.appendChild(host);
                }
            }
        };
    })();

    /* ============================
     * 핵심 로직 모듈
     * ============================ */
    const speedSlider = (() => {
        let container, sliderEl, valueEl, inited = false, isMinimized = true;

        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot();
            if (!shadowRoot) return;

            container = document.createElement('div');
            container.id = 'vm-speed-slider-container';

            const resetButton = document.createElement('button');
            resetButton.className = 'vm-btn reset';
            resetButton.title = 'Reset speed to 1x';
            resetButton.textContent = '1x';

            sliderEl = document.createElement('input');
            sliderEl.type = 'range';
            sliderEl.min = '0.2';
            sliderEl.max = '4.0';
            sliderEl.step = '0.2';
            sliderEl.value = '1.0';
            sliderEl.id = 'vm-speed-slider';

            valueEl = document.createElement('div');
            valueEl.id = 'vm-speed-value';
            valueEl.textContent = 'x1.0';

            const toggleButton = document.createElement('button');
            toggleButton.className = 'vm-btn toggle';
            toggleButton.title = 'Toggle Speed Controller';

            container.appendChild(resetButton);
            container.appendChild(sliderEl);
            container.appendChild(valueEl);
            container.appendChild(toggleButton);
            shadowRoot.appendChild(container);

            resetButton.addEventListener('click', () => {
                sliderEl.value = '1.0';
                applySpeed(1.0);
                updateValueText(1.0);
            });
            sliderEl.addEventListener('input', (e) => {
                const speed = parseFloat(e.target.value);
                applySpeed(speed);
                updateValueText(speed);
            });
            toggleButton.addEventListener('click', () => {
                isMinimized = !isMinimized;
                updateAppearance();
            });

            inited = true;
            updateAppearance();
        }

        const updateValueText = (speed) => valueEl.textContent = `x${speed.toFixed(1)}`;

        const applySpeed = (speed) => {
            activeMediaCache.forEach(m => {
                // [개선] 일시정지 여부와 관계없이 속도를 적용하여 사용성 개선
                if (m.playbackRate !== speed) {
                     safeExec(() => { m.playbackRate = speed; });
                }
            });
        };

        function updateAppearance() {
            if (!container) return;
            container.classList.toggle('minimized', isMinimized);
            container.querySelector('.toggle').textContent = isMinimized ? '🔻' : '🔺';
        }

        return {
            init: () => safeExec(init, 'speedSlider.init'),
            show: () => { if (container) container.style.display = 'flex'; },
            hide: () => { if (container) container.style.display = 'none'; },
            isMinimized: () => isMinimized,
        };
    })();

    const dragBar = (() => {
        let display, inited = false;
        let state = { dragging: false, startX: 0, startY: 0, accX: 0 };
        let lastDelta = 0;

        function onStart(e) {
            safeExec(() => {
                const target = e.target;
                // [개선] 이벤트 충돌 방지를 위해 드래그 시작 조건을 대폭 강화
                // 1. 이벤트 발생 지점이 <video> 태그가 아니면 즉시 중단
                if (target?.tagName !== 'VIDEO') return;

                // 2. 재생 중이 아닌 비디오는 무시
                if (target.paused) return;

                // 3. 자체 UI 요소 위에서는 동작하지 않음
                if (speedSlider.isMinimized() || (e.composedPath && e.composedPath().some(el => el.id === 'vm-speed-slider-container'))) return;

                // 4. 마우스 왼쪽 버튼이 아닐 경우 무시
                if (e.type === 'mousedown' && e.button !== 0) return;

                // 모든 조건을 통과하면 드래그 시작
                const pos = e.touches ? e.touches[0] : e;
                Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, accX: 0 });

                const options = { passive: false, capture: true };
                document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options);
                document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options);
            }, 'dragBar.onStart');
        }

        function onMove(e) {
            if (!state.dragging) return;
            // [개선] 의도된 동작이므로 페이지 스크롤 등 다른 기본 동작 방지
            e.preventDefault();
            e.stopImmediatePropagation();

            safeExec(() => {
                const pos = e.touches ? e.touches[0] : e;
                const dx = pos.clientX - state.startX;
                state.accX += dx;
                state.startX = pos.clientX;
                showDisplay(state.accX);
            }, 'dragBar.onMove');
        }

        function onEnd() {
            if (!state.dragging) return;
            safeExec(() => {
                applySeek();
                Object.assign(state, { dragging: false, accX: 0 });
                hideDisplay();
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('touchmove', onMove, true);
                document.removeEventListener('mouseup', onEnd, true);
                document.removeEventListener('touchend', onEnd, true);
            }, 'dragBar.onEnd');
        }

        function applySeek() {
            const deltaSec = Math.round(state.accX / 2);
            if (!deltaSec) return;
            activeMediaCache.forEach(m => {
                 if (isFinite(m.duration)) {
                      m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec));
                 }
            });
        }

        function init() {
            if (inited) return;
            document.addEventListener('mousedown', onStart, { capture: true });
            document.addEventListener('touchstart', onStart, { passive: true, capture: true });
            inited = true;
        }

        const showDisplay = (pixels) => {
            const s = Math.round(pixels / 2);
            if (s === lastDelta) return;
            lastDelta = s;

            if (!display) {
                const shadowRoot = uiManager.getShadowRoot();
                display = document.createElement('div');
                display.id = 'vm-time-display';
                shadowRoot.appendChild(display);
            }
            const sign = s < 0 ? '-' : '+';
            const a = Math.abs(s);
            const mm = Math.floor(a / 60).toString().padStart(2, '0');
            const ss = (a % 60).toString().padStart(2, '0');
            display.textContent = `${sign}${mm}분 ${ss}초`;
            display.style.display = 'block';
            display.style.opacity = '1';
        };
        const hideDisplay = () => {
            if (display) {
                display.style.opacity = '0';
                setTimeout(() => { if (display) display.style.display = 'none'; }, 300);
            }
        };

        return { init: () => safeExec(init, 'dragBar.init') };
    })();

    const getSeekTime = (rate) => {
        const SEEK_MIN = 1, SEEK_MAX = 15, SEEK_BASE = 5;
        return Math.min(Math.max(SEEK_MIN, SEEK_BASE * rate), SEEK_MAX);
    };

    const mediaSessionManager = (() => {
        const setSession = (media) => {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: document.title || 'Controlling Media',
                    artist: window.location.hostname,
                    album: 'VideoSpeed_Control',
                });
                navigator.mediaSession.setActionHandler('play', () => media.play());
                navigator.mediaSession.setActionHandler('pause', () => media.pause());
                navigator.mediaSession.setActionHandler('seekbackward', () => { media.currentTime -= getSeekTime(media.playbackRate); });
                navigator.mediaSession.setActionHandler('seekforward', () => { media.currentTime += getSeekTime(media.playbackRate); });
            }, 'mediaSession.set');
        };
        const clearSession = () => {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                navigator.mediaSession.metadata = null;
                ['play', 'pause', 'seekbackward', 'seekforward'].forEach(h => navigator.mediaSession.setActionHandler(h, null));
            }, 'mediaSession.clear');
        };
        return { setSession, clearSession };
    })();

    /* ============================
     * 메인 컨트롤러 (App)
     * ============================ */
    const mediaControls = (() => {
        const uiState = { hasMedia: null };
        const isPreview = (media) => (media.duration > 0 && media.duration < PREVIEW_CONFIG.DURATION_THRESHOLD);

        function updateUIVisibility() {
            const nonPreviewMedia = activeMediaCache.filter(m => !isPreview(m));
            const newHasMedia = nonPreviewMedia.length > 0;

            if (newHasMedia !== uiState.hasMedia) {
                newHasMedia ? speedSlider.show() : speedSlider.hide();
                uiState.hasMedia = newHasMedia;
            }
        }

        function initMedia(media) {
            if (!media || MediaStateManager.has(media)) return;
            MediaStateManager.set(media, { initialized: true });

            const onStateChange = () => updateUIVisibility();
            media.addEventListener('loadedmetadata', onStateChange, { once: true });
            media.addEventListener('play', () => {
                onStateChange();
                mediaSessionManager.setSession(media);
            });
            media.addEventListener('pause', () => {
                onStateChange();
                mediaSessionManager.clearSession();
            });
            media.addEventListener('ended', () => {
                onStateChange();
                mediaSessionManager.clearSession();
            });
        }
        return { initMedia, updateUIVisibility };
    })();

    const spaMonitor = (() => {
        let lastURL = location.href;
        const onNavigate = debounce(() => {
            if (location.href !== lastURL) {
                lastURL = location.href;
                App.onSpaNavigation();
            }
        }, 200);

        const init = () => {
            const originalPushState = history.pushState;
            history.pushState = function() { originalPushState.apply(this, arguments); onNavigate(); };
            const originalReplaceState = history.replaceState;
            history.replaceState = function() { originalReplaceState.apply(this, arguments); onNavigate(); };
            window.addEventListener('popstate', onNavigate);
        };
        return { init: () => safeExec(init, 'spaMonitor.init') };
    })();

    const App = (() => {
        const SEEN_MEDIA = new WeakSet();
        const OBSERVED_SHADOW_ROOTS = new WeakSet();
        const SEEN_IFRAMES = new WeakSet(); // [개선] iframe 중복 관찰 방지용

        function collectMediaFromNode(node, out) {
            if (!node) return;
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

            if (node instanceof HTMLMediaElement) {
                out.push(node);
            }
            if (node.querySelectorAll) {
                node.querySelectorAll('video, audio').forEach(m => out.push(m));
            }
            if (node.shadowRoot) {
                collectMediaFromNode(node.shadowRoot, out);
            }
        }

        function processMutations(mutations) {
            const newlyFound = [];
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    collectMediaFromNode(node, newlyFound);
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'IFRAME') {
                           observeIframeWithRetry(node);
                        }
                        node.querySelectorAll?.('iframe').forEach(observeIframeWithRetry);
                    }
                });
            }

            if (newlyFound.length > 0) {
                const uniqueNewMedia = [...new Set(newlyFound)].filter(m => !SEEN_MEDIA.has(m));
                if (uniqueNewMedia.length > 0) {
                    uniqueNewMedia.forEach(m => SEEN_MEDIA.add(m));
                    activeMediaCache.push(...uniqueNewMedia);
                    uniqueNewMedia.forEach(mediaControls.initMedia);
                    mediaControls.updateUIVisibility();
                }
            }
        }

        function observeShadowRoot(root) {
            if (!root || OBSERVED_SHADOW_ROOTS.has(root)) return;
            OBSERVED_SHADOW_ROOTS.add(root);

            const observer = new MutationObserver(processMutations);
            observer.observe(root, { childList: true, subtree: true });

            const newlyFound = [];
            collectMediaFromNode(root, newlyFound);
            const uniqueNewMedia = [...new Set(newlyFound)].filter(m => !SEEN_MEDIA.has(m));
            if (uniqueNewMedia.length > 0) {
                uniqueNewMedia.forEach(m => SEEN_MEDIA.add(m));
                activeMediaCache.push(...uniqueNewMedia);
                uniqueNewMedia.forEach(mediaControls.initMedia);
                mediaControls.updateUIVisibility();
            }
        }

        function attachShadowObserversIfAny() {
            if (window._shadowDomList_) {
                window._shadowDomList_.forEach(observeShadowRoot);
            }
        }

        function observeIframeWithRetry(iframe, tries = 0) {
            // [개선] 이미 처리중인 iframe은 재시도하지 않음
            if (!iframe || SEEN_IFRAMES.has(iframe)) return;

            const MAX_TRIES = 20;
            const TRY_DELAY = 100;

            try {
                if (iframe.contentDocument) {
                    SEEN_IFRAMES.add(iframe); // 성공 시점에 등록
                    startUnifiedObserver(iframe.contentDocument);
                    return;
                }
            } catch (_) { /* cross-origin 오류 무시 */ }

            if (tries < MAX_TRIES) {
                setTimeout(() => observeIframeWithRetry(iframe, tries + 1), TRY_DELAY);
            }
        }

        function initialFullScan() {
            safeExec(() => {
                const allMedia = findAllMedia();
                const unique = allMedia.filter(m => !SEEN_MEDIA.has(m));

                unique.forEach(m => SEEN_MEDIA.add(m));
                activeMediaCache = unique.slice();
                unique.forEach(mediaControls.initMedia);
                mediaControls.updateUIVisibility();
            }, 'initialFullScan');
        }

        function findAllMedia() {
            const allMedia = [];
            safeExec(() => {
                collectMediaFromNode(document, allMedia);
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        if (iframe.contentDocument) {
                            collectMediaFromNode(iframe.contentDocument, allMedia);
                        }
                    } catch (e) { /* Cross-origin 오류 무시 */ }
                });
            }, 'findAllMedia');
            return [...new Set(allMedia)];
        }

        function startUnifiedObserver(targetDocument) {
            if (!targetDocument || PROCESSED_DOCUMENTS.has(targetDocument)) return;
            const body = targetDocument.body || targetDocument;
            if (!body) return;

            PROCESSED_DOCUMENTS.add(targetDocument);
            const observer = new MutationObserver(processMutations);
            observer.observe(body, { childList: true, subtree: true });

            OBSERVER_MAP.set(targetDocument, observer);
        }

        function initAllDocuments(doc) {
            safeExec(() => {
                startUnifiedObserver(doc);
                doc.querySelectorAll('iframe').forEach(iframe => {
                    observeIframeWithRetry(iframe);
                    // [개선] SPA에서 src 변경 시 재탐색을 위해 'once' 옵션 제거
                    iframe.addEventListener('load', () => observeIframeWithRetry(iframe));
                });
            }, 'initAllDocuments');
        }

        /**
         * [개선] 주기적으로 DOM과 연결이 끊어진 미디어를 캐시에서 제거합니다.
         */
        function periodicCacheCleanup() {
            const beforeCount = activeMediaCache.length;
            activeMediaCache = activeMediaCache.filter(m => m.isConnected);
            const afterCount = activeMediaCache.length;
            if (beforeCount > afterCount) {
                mediaControls.updateUIVisibility();
            }
        }

        function initialize() {
            console.log('🎉 VideoSpeed_Control (v23.25-Patch.4-Stable) Initialized.');
            uiManager.init();
            speedSlider.init();
            dragBar.init();
            if (FeatureFlags.spaPartialUpdate) spaMonitor.init();

            document.addEventListener('fullscreenchange', () => {
                uiManager.moveUiTo(document.fullscreenElement || document.body);
            });

            document.addEventListener('addShadowRoot', e => {
                safeExec(() => observeShadowRoot(e.detail.shadowRoot), 'addShadowRoot handler');
            });

            attachShadowObserversIfAny();
            initAllDocuments(document);
            initialFullScan();

            // [개선] 5초마다 캐시 정리하여 메모리 누수 방지
            setInterval(periodicCacheCleanup, 5000);
        }

        function onSpaNavigation() {
            console.log('[VideoSpeed] SPA Navigation detected. Performing partial update...');
            safeExec(() => {
                activeMediaCache = activeMediaCache.filter(m => m.isConnected);

                const newlyFound = [];
                collectMediaFromNode(document.body, newlyFound);
                const uniqueNewMedia = [...new Set(newlyFound)].filter(m => !SEEN_MEDIA.has(m));

                if (uniqueNewMedia.length > 0) {
                    uniqueNewMedia.forEach(m => SEEN_MEDIA.add(m));
                    activeMediaCache.push(...uniqueNewMedia);
                    uniqueNewMedia.forEach(mediaControls.initMedia);
                }

                mediaControls.updateUIVisibility();
            }, 'onSpaNavigation');
        }

        return { initialize, onSpaNavigation };
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
