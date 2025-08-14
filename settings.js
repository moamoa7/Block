// ==UserScript==
// @name         VideoSpeed_Control (Light)
// @namespace    https.com/
// @version      23.25 (배속바 모든 영상에 표시로 변경)
// @description  🎞️ [경량화 버전] 동영상 재생 속도 및 시간 제어 기능에만 집중 (안정성 강화)
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
            container.innerHTML = `
                <button class="vm-btn reset" title="Reset speed to 1x">1x</button>
                <input type="range" min="0.2" max="4.0" step="0.2" value="1.0" id="vm-speed-slider">
                <div id="vm-speed-value">x1.0</div>
                <button class="vm-btn toggle" title="Toggle Speed Controller">🔺</button>
            `;
            shadowRoot.appendChild(container);

            sliderEl = container.querySelector('#vm-speed-slider');
            valueEl = container.querySelector('#vm-speed-value');

            container.querySelector('.reset').addEventListener('click', () => {
                sliderEl.value = '1.0';
                applySpeed(1.0);
                updateValueText(1.0);
            });
            sliderEl.addEventListener('input', (e) => {
                const speed = parseFloat(e.target.value);
                applySpeed(speed);
                updateValueText(speed);
            });
            container.querySelector('.toggle').addEventListener('click', () => {
                isMinimized = !isMinimized;
                updateAppearance();
            });

            inited = true;
            updateAppearance();
        }

        const updateValueText = (speed) => valueEl.textContent = `x${speed.toFixed(1)}`;

        const applySpeed = (speed) => {
            activeMediaCache.forEach(m => {
                if (!m.paused && m.playbackRate !== speed) {
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
                if (speedSlider.isMinimized() || (e.composedPath && e.composedPath().some(el => el.id === 'vm-speed-slider-container'))) return;
                if (e.type === 'mousedown' && e.button !== 0) return;
                if (!activeMediaCache.some(m => m.tagName === 'VIDEO' && !m.paused)) return;

                const pos = e.touches ? e.touches[0] : e;
                Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, accX: 0 });

                const options = { passive: false, capture: true };
                document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options);
                document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options);
            }, 'dragBar.onStart');
        }

        function onMove(e) {
            if (!state.dragging) return;
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
                App.cleanupAndReinitialize();
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
        const scanTask = () => safeExec(() => {
            activeMediaCache = findAllMedia();
            activeMediaCache.forEach(mediaControls.initMedia);
            mediaControls.updateUIVisibility();
        }, 'scanTask');

        // [안정성 수정] DOM 전체를 스캔하는 안정적인 방식을 기본으로 사용
        const debouncedScanTask = debounce(scanTask, 250);

        function findAllMedia() {
            const media = [];
            safeExec(() => {
                document.querySelectorAll('video, audio').forEach(m => media.push(m));
                if (window._shadowDomList_) {
                    window._shadowDomList_.forEach(sr => {
                        try { sr.querySelectorAll('video,audio').forEach(m => media.push(m)); } catch (e) {}
                    });
                }
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        if (iframe.contentDocument) {
                            iframe.contentDocument.querySelectorAll('video, audio').forEach(m => media.push(m));
                        }
                    } catch (e) {}
                });
            }, 'findAllMedia');
            return [...new Set(media)];
        }

        function startUnifiedObserver(targetDocument) {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;

            // [안정성 수정] MutationObserver는 이제 안정적인 전체 스캔을 호출합니다.
            const observer = new MutationObserver(debouncedScanTask);
            const observeTarget = targetDocument.body || targetDocument;
            observer.observe(observeTarget, { childList: true, subtree: true });

            OBSERVER_MAP.set(targetDocument, observer);
            PROCESSED_DOCUMENTS.add(targetDocument);
        }

        function initAllDocuments(doc) {
            safeExec(() => {
                startUnifiedObserver(doc);
                doc.querySelectorAll('iframe').forEach(iframe => {
                    try { if (iframe.contentDocument) initAllDocuments(iframe.contentDocument); } catch (e) {}
                    iframe.addEventListener('load', () => {
                        try { if (iframe.contentDocument) initAllDocuments(iframe.contentDocument); } catch (e) {}
                    }, { once: true });
                });
            }, 'initAllDocuments');
        }

        function initialize() {
            console.log('🎉 VideoSpeed_Control (v23.2) Initialized.');
            uiManager.init();
            speedSlider.init();
            dragBar.init();
            if (FeatureFlags.spaPartialUpdate) spaMonitor.init();

            document.addEventListener('fullscreenchange', () => {
                 uiManager.moveUiTo(document.fullscreenElement || document.body);
            });

            // Shadow DOM 추가 시에는 즉시 스캔하여 반응성 유지
            document.addEventListener('addShadowRoot', e => {
                safeExec(() => {
                    const root = e.detail.shadowRoot;
                    root.querySelectorAll('video,audio').forEach(media => {
                        if (!MediaStateManager.has(media)) {
                             activeMediaCache.push(media);
                             mediaControls.initMedia(media);
                        }
                    });
                    mediaControls.updateUIVisibility();
                }, 'addShadowRoot handler');
            });

            initAllDocuments(document);
            scanTask(); // 초기 스캔
        }

        function cleanupAndReinitialize() {
            console.log('[VideoSpeed] SPA Navigation detected. Re-initializing...');
            for (const obs of OBSERVER_MAP.values()) obs.disconnect();
            OBSERVER_MAP.clear();
            PROCESSED_DOCUMENTS = new WeakSet();
            activeMediaCache = activeMediaCache.filter(m => document.contains(m) || (m.ownerDocument && document.contains(m.ownerDocument.documentElement)));

            mediaControls.updateUIVisibility();

            initAllDocuments(document);
            scanTask();
        }

        return { initialize, cleanupAndReinitialize };
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
