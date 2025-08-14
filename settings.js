// ==UserScript==
// @name         VideoSpeed_Control (Light - Master Hybrid)
// @namespace    https.com/
// @version      23.25-Patch.12-Overlay-Fix
// @description  🎞️ [최종 완성판] 투명 오버레이가 덮인 비디오 플레이어에서도 드래그 탐색이 가능하도록 로직을 개선한 최종 버전입니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ============================
     * 설정 및 유틸리티
     * ============================ */
    const FeatureFlags = { debug: false };
    const SEEN_MEDIA = new WeakSet();
    let activeMediaCache = [];
    let uiVisible = false;

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (FeatureFlags.debug) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    // 콘솔 클리어 방지
    safeExec(() => {
        if (window.console && console.clear) {
            const originalClear = console.clear;
            console.clear = () => console.log('--- 🚫 console.clear() has been blocked. ---');
            Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear });
        }
    }, 'consoleClearProtection');

    // Shadow DOM 강제 open
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
     * UI 관리 (모든 기능 포함)
     * ============================ */
    const uiManager = (() => {
        let host, shadowRoot;
        function init() {
            if (host) return;
            host = document.createElement('div'); host.id = 'vsc-ui-host';
            Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2147483647' });
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
            moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); }
        };
    })();

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
        const applySpeed = (speed) => activeMediaCache.forEach(m => { if (m.playbackRate !== speed) safeExec(() => { m.playbackRate = speed; }); });
        function updateAppearance() {
            if (!container) return;
            container.classList.toggle('minimized', isMinimized);
            container.querySelector('.toggle').textContent = isMinimized ? '🔻' : '🔺';
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'),
            show: () => { if (container) container.style.display = 'flex'; },
            hide: () => { if (container) container.style.display = 'none'; },
            isMinimized: () => isMinimized
        };
    })();

    const dragBar = (() => {
        let display, inited = false;
        let state = { dragging: false, startX: 0, startY: 0, accX: 0 };
        let lastDelta = 0;

        function onStart(e) {
            safeExec(() => {
                const target = e.target;

                let videoElement = (target?.tagName === 'VIDEO') ? target : target?.parentElement?.querySelector('video');

                if (!videoElement || videoElement.paused) return;

                if (speedSlider.isMinimized() || (e.composedPath && e.composedPath().some(el => el.id === 'vm-speed-slider-container'))) return;
                if (e.type === 'mousedown' && e.button !== 0) return;

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
            activeMediaCache.forEach(m => { if (isFinite(m.duration)) m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec)); });
        }

        function init() {
            if (inited) return;
            document.addEventListener('mousedown', onStart, { capture: true });
            document.addEventListener('touchstart', onStart, { passive: true, capture: true });
            inited = true;
        }

        const showDisplay = (pixels) => {
            const s = Math.round(pixels / 2);
            if (s === lastDelta) return; lastDelta = s;
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

    const mediaSessionManager = (() => {
        const getSeekTime = (rate) => Math.min(Math.max(1, 5 * rate), 15);
        const setSession = (media) => {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                navigator.mediaSession.metadata = new window.MediaMetadata({ title: document.title, artist: location.hostname, album: 'VideoSpeed_Control' });
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
     * 미디어 검색 및 하이브리드 스캔 로직
     * ============================ */
    function findAllMedia(doc = document) {
        const media = [];
        safeExec(() => {
            doc.querySelectorAll('video, audio').forEach(m => media.push(m));
            (window._shadowDomList_ || []).forEach(sr => sr.querySelectorAll('video, audio').forEach(m => media.push(m)));
            if (doc === document) {
                document.querySelectorAll('iframe').forEach(iframe => {
                    try { if (iframe.contentDocument) media.push(...findAllMedia(iframe.contentDocument)); } catch {}
                });
            }
        });
        return [...new Set(media)];
    }

    function initMedia(media) {
        if (!media || SEEN_MEDIA.has(media)) return;
        SEEN_MEDIA.add(media);
        const updateUI = () => scanTask(true);
        media.addEventListener('play', () => { updateUI(); mediaSessionManager.setSession(media); });
        media.addEventListener('pause', () => { updateUI(); mediaSessionManager.clearSession(); });
        media.addEventListener('ended', () => { updateUI(); mediaSessionManager.clearSession(); });
    }

    const scanTask = (isUiUpdateOnly = false) => {
        const allMedia = findAllMedia();
        if (!isUiUpdateOnly) allMedia.forEach(initMedia);
        activeMediaCache = allMedia.filter(m => m.isConnected);
        const shouldBeVisible = activeMediaCache.length > 0;
        if (uiVisible !== shouldBeVisible) {
            uiVisible = shouldBeVisible;
            uiVisible ? speedSlider.show() : speedSlider.hide();
        }
    };

    const debouncedScanTask = debounce(scanTask, 350);

    function scanAddedNodes(nodes) {
        let foundNew = false;
        nodes.forEach(node => {
            if (node.nodeType !== 1) return;
            const mediaElements = [];
            if (node.matches?.('video, audio')) mediaElements.push(node);
            node.querySelectorAll?.('video, audio').forEach(m => mediaElements.push(m));
            if(mediaElements.length > 0) {
                mediaElements.forEach(initMedia);
                foundNew = true;
            }
        });
        if (foundNew) scanTask(true);
    }

    /* ============================
     * 초기화
     * ============================ */
    function initialize() {
        console.log('🎉 VideoSpeed_Control (v23.25-Patch.12.1-Error-Fix) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();

        const observer = new MutationObserver(mutations => {
            const addedNodes = mutations.flatMap(m => (m.type === 'childList' ? [...m.addedNodes] : []));
            if (addedNodes.length > 0) {
                scanAddedNodes(addedNodes);
            } else {
                debouncedScanTask();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener('addShadowRoot', debouncedScanTask);

        const originalPushState = history.pushState;
        history.pushState = function() {
            originalPushState.apply(this, arguments);
            scanTask();
        };
        window.addEventListener('popstate', () => scanTask());

        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));

        scanTask();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize, { once: true });
    }
})();
