// ==UserScript==
// @name         VideoSpeed_Control (Inactive Filter Optimization)
// @namespace    https://com/
// @version      27.01-Inactive-Filter-Optimization
// @description  🎞️ 화면에 보이지 않거나 비활성 탭의 비디오 필터를 자동으로 꺼서 성능을 최적화합니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 설정 및 유틸리티 ---
    const FeatureFlags = { debug: false };
    const EXCLUSION_KEYWORDS = ['login', 'signin', 'auth', 'captcha', 'signup'];
    const SPECIFIC_EXCLUSIONS = [{ domain: 'avsee.ru', path: '/bbs/login.php' }];
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (FeatureFlags.debug) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; if (SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path))) return true; return false; }
    if (isExcluded()) { console.log(`[VideoSpeed] Skipped on excluded page: ${location.href}`); return; }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    const activeMediaMap = new Map();
    let uiVisible = false;
    safeExec(() => { if (window.console && console.clear) { const o = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection');
    (function hackAttachShadow() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const o = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function () { const a = arguments; if (a[0] && a[0].mode) a[0].mode = 'open'; const r = o.apply(this, a); window._shadowDomList_.push(r); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: r } })); return r; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    // --- 비디오 필터 모듈 (✨ 필터 적용 방식 수정) ---
    const filterManager = (() => {
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        const DESKTOP_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen1', KERNEL_MATRIX: '1 -1 1 -1 -2 -1 1 -1 1', BLUR_STD_DEVIATION: '0.45', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 };
        const MOBILE_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen5', KERNEL_MATRIX: '1 -1 1 -1 -.5 -1 1 -1 1', BLUR_STD_DEVIATION: '0.45', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 };
        const settings = isMobile ? MOBILE_SETTINGS : DESKTOP_SETTINGS;
        let isEnabled = true;

        function createSvgFiltersAndStyle() {
            if (document.getElementById('video-enhancer-svg-filters')) return;
            const svgNs = 'http://www.w3.org/2000/svg'; const svgFilters = document.createElementNS(svgNs, 'svg'); svgFilters.id = 'video-enhancer-svg-filters'; svgFilters.style.display = 'none';
            const softeningFilter = document.createElementNS(svgNs, 'filter'); softeningFilter.id = 'SofteningFilter'; const gaussianBlur = document.createElementNS(svgNs, 'feGaussianBlur'); gaussianBlur.setAttribute('stdDeviation', settings.BLUR_STD_DEVIATION); softeningFilter.appendChild(gaussianBlur); svgFilters.appendChild(softeningFilter);
            const sharpenFilter = document.createElementNS(svgNs, 'filter'); sharpenFilter.id = settings.SHARPEN_ID; const convolveMatrix = document.createElementNS(svgNs, 'feConvolveMatrix'); Object.entries({ order: '3 3', preserveAlpha: 'true', kernelMatrix: settings.KERNEL_MATRIX, mode: 'multiply' }).forEach(([k, v]) => convolveMatrix.setAttribute(k, v)); sharpenFilter.appendChild(convolveMatrix); svgFilters.appendChild(sharpenFilter);
            const gammaFilter = document.createElementNS(svgNs, 'filter'); gammaFilter.id = 'gamma-filter'; const feComponentTransfer = document.createElementNS(svgNs, 'feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => { const feFunc = document.createElementNS(svgNs, `feFunc${ch}`); feFunc.setAttribute('type', 'gamma'); feFunc.setAttribute('exponent', (1 / settings.GAMMA_VALUE).toString()); feComponentTransfer.appendChild(feFunc); }); gammaFilter.appendChild(feComponentTransfer); svgFilters.appendChild(gammaFilter);
            const linearAdjustFilter = document.createElementNS(svgNs, 'filter'); linearAdjustFilter.id = 'linear-adjust-filter'; const linearComponentTransfer = document.createElementNS(svgNs, 'feComponentTransfer'); const shadowIntercept = settings.SHADOWS_VALUE / 200; const highlightSlope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => { const feFunc = document.createElementNS(svgNs, `feFunc${ch}`); feFunc.setAttribute('type', 'linear'); feFunc.setAttribute('slope', highlightSlope.toString()); feFunc.setAttribute('intercept', shadowIntercept.toString()); linearComponentTransfer.appendChild(feFunc); }); linearAdjustFilter.appendChild(linearComponentTransfer); svgFilters.appendChild(linearAdjustFilter);
            (document.body || document.documentElement).appendChild(svgFilters);

            const styleElement = document.createElement('style'); styleElement.id = 'video-enhancer-styles';
            // ✨ 필터 적용 대상을 html 태그가 아닌 개별 비디오의 클래스로 변경
            styleElement.textContent = `
                video.video-filter-active,
                iframe.video-filter-active {
                    filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important;
                }
                .vsc-gpu-accelerated {
                    transform: translateZ(0);
                    will-change: transform;
                }
            `;
            (document.head || document.documentElement).appendChild(styleElement);
        }

        // ✨ 필터 ON/OFF 상태만 관리하도록 updateState 함수 수정
        function updateState() {
            document.documentElement.classList.toggle('video-filter-main-switch-on', isEnabled);
            const button = uiManager.getShadowRoot()?.getElementById('vm-filter-toggle-btn');
            if (button) button.textContent = isEnabled ? '🌞' : '🌚';
            // 실제 필터 적용/제거는 scanTask에서 담당
            scanTask(true);
        }

        return {
            init: () => { safeExec(() => { createSvgFiltersAndStyle(); updateState(); }, 'filterManager.init'); },
            toggle: () => { isEnabled = !isEnabled; updateState(); },
            isEnabled: () => isEnabled,
        };
    })();

    // --- UI 관리 ---
    const uiManager = (() => { /* ... (이전과 동일, 변경 없음) ... */ })();

    const speedSlider = (() => { /* ... (이전과 동일, 변경 없음) ... */ })();

    // --- ✨ 미디어 스캔 및 관리 로직 (대대적 수정) ---
    const mediaListenerMap = new WeakMap();
    let intersectionObserver = null;

    const dragBar = (() => { /* ... (이전과 동일, 변경 없음) ... */ })();
    const mediaSessionManager = (() => { /* ... (이전과 동일, 변경 없음) ... */ })();

    function findAllMedia(doc = document) { /* ... (이전과 동일, 변경 없음) ... */ }

    // ✨ 필터 적용/제거를 담당하는 핵심 함수
    function updateVideoFilterState(video) {
        const isPlaying = !video.paused && !video.ended;
        const isVisible = video.dataset.isVisible === 'true';
        const mainSwitchOn = filterManager.isEnabled();

        // 모든 조건이 만족될 때만 필터 활성화
        const shouldHaveFilter = isPlaying && isVisible && mainSwitchOn;
        video.classList.toggle('video-filter-active', shouldHaveFilter);
    }

    const mediaEventHandlers = {
        play: (media) => {
            updateVideoFilterState(media);
            scanTask(true);
            mediaSessionManager.setSession(media);
        },
        pause: (media) => {
            updateVideoFilterState(media);
            scanTask(true);
            mediaSessionManager.clearSession(media);
        },
        ended: (media) => {
            updateVideoFilterState(media);
            scanTask(true);
            mediaSessionManager.clearSession(media);
        },
    };

    function initMedia(media) {
        if (!media || mediaListenerMap.has(media)) return;
        const listeners = {};
        Object.entries(mediaEventHandlers).forEach(([evt, handler]) => {
            const listener = () => handler(media);
            listeners[evt] = listener;
            media.addEventListener(evt, listener);
        });
        mediaListenerMap.set(media, listeners);

        // ✨ IntersectionObserver로 화면 노출 여부 감시 시작
        if (intersectionObserver) {
            intersectionObserver.observe(media);
        }
    }
    function cleanupMedia(media) {
        if (!mediaListenerMap.has(media)) return;
        const listeners = mediaListenerMap.get(media);
        Object.entries(listeners).forEach(([evt, listener]) => {
            media.removeEventListener(evt, listener);
        });
        mediaListenerMap.delete(media);

        // ✨ 감시 중지
        if (intersectionObserver) {
            intersectionObserver.unobserve(media);
        }
        if (FeatureFlags.debug) console.log('[VideoSpeed] Event listeners cleaned up for removed media element.');
    }
    const scanTask = (isUiUpdateOnly = false) => {
        const allMedia = findAllMedia();
        if (!isUiUpdateOnly) {
            allMedia.forEach(initMedia);
        }
        activeMediaMap.clear();
        allMedia.forEach(m => {
            if (m.isConnected) { activeMediaMap.set(m, {}); }
        });

        // GPU 가속 로직 + 필터 상태 업데이트 로직
        allMedia.forEach(video => {
            if (video.tagName === 'VIDEO') {
                const isPlaying = !video.paused && !video.ended;
                video.classList.toggle('vsc-gpu-accelerated', isPlaying);
                updateVideoFilterState(video); // 모든 비디오 상태 재확인
            }
        });

        const shouldBeVisible = activeMediaMap.size > 0;
        if (uiVisible !== shouldBeVisible) {
            uiVisible = shouldBeVisible;
            uiVisible ? speedSlider.show() : speedSlider.hide();
        }
    };
    const debouncedScanTask = debounce(scanTask, 350);
    function scanAddedNodes(nodes) {
        const mediaElements = [];
        nodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.matches?.('video, audio')) mediaElements.push(node);
            node.querySelectorAll?.('video, audio').forEach(m => mediaElements.push(m));
        });
        if (mediaElements.length > 0) {
            mediaElements.forEach(initMedia);
            scanTask(true);
        }
    }
    function scanRemovedNodes(nodes) {
        nodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.matches?.('video, audio')) {
                cleanupMedia(node);
            }
            node.querySelectorAll?.('video, audio').forEach(cleanupMedia);
        });
    }

    // --- 초기화 ---
    function initialize() {
        console.log('🎉 VideoSpeed_Control (Inactive Filter Optimization) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        filterManager.init();

        // ✨ IntersectionObserver 초기화
        intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                entry.target.dataset.isVisible = entry.isIntersecting;
                updateVideoFilterState(entry.target);
            });
        }, { threshold: 0.1 }); // 10% 이상 보일 때 감지

        // ✨ 탭 활성 상태 감지 리스너 추가
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // 탭이 비활성화되면 모든 비디오 필터 끄기
                document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active'));
            } else {
                // 탭이 다시 활성화되면 상태 재검사
                scanTask(true);
            }
        });

        const observer = new MutationObserver(mutations => {
            const addedNodes = [], removedNodes = [];
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    addedNodes.push(...mutation.addedNodes);
                    removedNodes.push(...mutation.removedNodes);
                }
            }
            if (removedNodes.length > 0) scanRemovedNodes(removedNodes);
            if (addedNodes.length > 0) scanAddedNodes(addedNodes);
            if(addedNodes.length === 0 && removedNodes.length === 0) debouncedScanTask();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function () { originalPushState.apply(this, arguments); scanTask(); };
        window.addEventListener('popstate', () => scanTask());
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));

        window.addEventListener('beforeunload', () => {
            if (observer) observer.disconnect();
            if (intersectionObserver) intersectionObserver.disconnect(); // ✨ Observer 정리
            if (FeatureFlags.debug) console.log('[VideoSpeed] Cleaned up Observers.');
        });

        scanTask();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') { initialize(); } else { window.addEventListener('DOMContentLoaded', initialize, { once: true }); }

})();
