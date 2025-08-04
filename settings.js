// ==UserScript==
// @name          PopupBlocker_Iframe_VideoSpeed
// @namespace     https.com/
// @version       6.2.109 (이벤트 충돌 방지 로직 보강)
// @description   새창/새탭 차단기, iframe 수동 차단, Vertical Video Slider, PC/모바일 드래그바로 재생 시간 조절을 하나의 스크립트에서 각 로직이 독립적으로 동작하도록 최적화
// @match         *://*/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 전역 설정 및 기능 플래그 ---
    const FeatureFlags = {
        popupBlocker: true,
        iframeBlocker: true,
        layerTrap: true,
        videoControls: true,
    };
    const USER_SETTINGS = {
        enableVideoDebugBorder: false,
        defaultIframeSandbox: 'allow-scripts allow-same-origin allow-popups'
    };

    // --- 기능별 상수 및 예외 처리 ---
    const WHITELIST = [
        'challenges.cloudflare.com',
        'recaptcha',
        '/e/',
    ];
    const EXCEPTION_LIST = {
        'supjav.com': ['iframeBlocker'],
    };
    const FORCE_BLOCK_POPUP_PATTERNS = [];
    const POSTMESSAGE_LOG_IGNORE_DOMAINS = [
        'google.com',
        'ok.ru',
        'twitch.tv',
        'accounts.google.com',
        'missav.ws'
    ];
    const POSTMESSAGE_LOG_IGNORE_PATTERNS = [
        '{"event":"timeupdate"',
    ];
    const IFRAME_SKIP_DOMAINS = [];
    const IFRAME_FORCE_BLOCK_PATTERNS = [
        '/ads/', 'adsbygoogle', 'doubleclick', 'adpnut.com',
        'iframead', 'loader.fmkorea.com/_loader/', '/smartpop/',
        '8dkq9tp.xyz', 's.amazon-adsystem.com',
    ];

    // --- 스크립트 초기 실행 전 예외 처리 ---
    const hostname = location.hostname;
    const IS_ENTIRE_SCRIPT_ALLOWED = WHITELIST.some(domain =>
        hostname.includes(domain) || window.location.href.includes(domain)
    );
    if (IS_ENTIRE_SCRIPT_ALLOWED) {
        return;
    }
    if (window.hasOwnProperty('__MySuperScriptInitialized') && window.__MySuperScriptInitialized) {
        return;
    }
    Object.defineProperty(window, '__MySuperScriptInitialized', {
        value: true,
        writable: false,
        configurable: true
    });

    // --- 전역 상태 및 중복 방지 ---
    const PROCESSED_NODES = new WeakSet();
    const PROCESSED_IFRAMES = new WeakSet();
    const PROCESSED_DOCUMENTS = new WeakSet();
    const PROCESSED_VIDEOS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const BLOCKED_IFRAME_URLS = new Set();
    let isInitialLoadFinished = false;
    let dragBarTimeDisplay = null;
    let speedSliderContainer = null;

    // 비디오 UI 관련 상태
    const videoUIFlags = {
        speedSliderInitialized: false,
        dragBarInitialized: false,
        isUIBeingUsed: false,
        playbackUpdateTimer: null,
    };
    window.__videoUIInitialized = false;

    const isTopFrame = window.self === window.top;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isFeatureAllowed = (featureName) => {
        const exceptions = EXCEPTION_LIST[hostname] || [];
        return exceptions.includes(featureName);
    };

    // --- 팝업/광고 차단기 로직 ---
    const popupBlocker = {
        init: () => {
            if (!FeatureFlags.popupBlocker) return;
            const originalWindowOpen = window.open;
            let userInitiatedAction = false;
            let lastVisibilityChangeTime = 0;
            let lastBlurTime = 0;

            const setUserInitiatedAction = () => {
                userInitiatedAction = true;
                setTimeout(() => { userInitiatedAction = false; }, 500);
            };
            document.addEventListener('click', setUserInitiatedAction, true);
            document.addEventListener('mousedown', setUserInitiatedAction, true);
            document.addEventListener('keydown', setUserInitiatedAction, true);

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    lastVisibilityChangeTime = Date.now();
                } else {
                    lastVisibilityChangeTime = 0;
                }
            });
            window.addEventListener('blur', () => { lastBlurTime = Date.now(); });
            window.addEventListener('focus', () => { lastBlurTime = 0; });

            const blockOpen = (...args) => {
                const url = args[0] || '(no URL)';
                const isForceBlocked = FORCE_BLOCK_POPUP_PATTERNS.some(pattern => url.includes(pattern));
                if (isForceBlocked) {
                    return getFakeWindow();
                }
                const currentTime = Date.now();
                const timeSinceVisibilityChange = currentTime - lastVisibilityChangeTime;
                const timeSinceBlur = currentTime - lastBlurTime;
                if (userInitiatedAction || isFeatureAllowed('windowOpen')) {
                    const features = (args[2] || '') + ',noopener,noreferrer';
                    return originalWindowOpen.apply(window, [args[0], args[1], features]);
                }
                return getFakeWindow();
            };
            if (!isFeatureAllowed('windowOpen')) {
                try {
                    const originalOpen = window.open;
                    Object.defineProperty(window, 'open', {
                        get: () => blockOpen,
                        set: () => {},
                        configurable: true
                    });
                    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
                        unsafeWindow.open = blockOpen;
                    }
                } catch (e) {
                }
            }
            if (!isFeatureAllowed('opener')) {
                try {
                    Object.defineProperty(window, 'opener', {
                        get() { return null; },
                        set() {},
                        configurable: false
                    });
                } catch (e) {
                }
            }
            let originalHostnameOnLoad = hostname;
            document.addEventListener('DOMContentLoaded', () => {
                originalHostnameOnLoad = window.location.hostname;
                if (window.name && window.name.length > 0) {
                    window.name = '';
                }
            });
            const originalPushState = history.pushState;
            history.pushState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            window.name = '';
                        }
                    } catch (e) { /* URL 파싱 오류 무시 */ }
                }
                return originalPushState.apply(this, args);
            };
            const originalReplaceState = history.replaceState;
            history.replaceState = function(...args) {
                if (args[2] && typeof args[2] === 'string') {
                    try {
                        const newUrlHostname = new URL(args[2], window.location.href).hostname;
                        if (newUrlHostname !== originalHostnameOnLoad && window.name) {
                            window.name = '';
                        }
                    } catch (e) { /* URL 파싱 오류 무시 */ }
                }
                return originalReplaceState.apply(this, args);
            };
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a?.download && a.href && /\.(exe|apk|bat|scr|zip|msi|cmd|com)/i.test(a.href)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }, true);
            window.addEventListener('keydown', e => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 's' || e.key === 'p' || e.key === 'u' || (e.shiftKey && e.key === 'I')) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                }
            }, true);
            window.addEventListener('message', (event) => {
                const isIgnoredDomain = POSTMESSAGE_LOG_IGNORE_DOMAINS.some(domain => event.origin.includes(domain));
                if (isIgnoredDomain) return;

                const msgData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
                if (POSTMESSAGE_LOG_IGNORE_PATTERNS.some(pattern => msgData.includes(pattern))) {
                    return;
                }
            }, false);
            if (!isFeatureAllowed('fullscreen')) {
                try {
                    const originalRequestFullscreen = Document.prototype.requestFullscreen;
                    if (originalRequestFullscreen) {
                        Document.prototype.requestFullscreen = new Proxy(originalRequestFullscreen, {
                            apply(target, thisArg, argumentsList) {
                                return Promise.reject('Blocked fullscreen request');
                            }
                        });
                    }
                } catch (e) {
                }
            }
            if (!isFeatureAllowed('location')) {
                try {
                    Object.defineProperty(window, 'location', {
                        configurable: false,
                        enumerable: true,
                        get: () => location,
                        set: (val) => {
                            console.warn(`location 이동 차단 시도됨 | 현재: ${window.location.href} | 대상: ${val}`);
                        }
                    });
                } catch (e) {
                }
            }
        }
    };

    // --- iframe 차단기 로직 ---
    const iframeBlocker = {
        init: (node, trigger) => {
            if (!FeatureFlags.iframeBlocker) return;
            if (isFeatureAllowed('iframeBlocker') || PROCESSED_IFRAMES.has(node)) {
                return;
            }

            PROCESSED_IFRAMES.add(node);
            const IS_IFRAME_LOGIC_SKIPPED = IFRAME_SKIP_DOMAINS.some(domain => hostname.includes(domain) || window.location.href.includes(domain));
            if (IS_IFRAME_LOGIC_SKIPPED) {
                return;
            }

            const rawSrc = node.getAttribute('src') || node.src || '';
            let fullSrc = rawSrc;
            const lazySrc = node.getAttribute('data-lazy-src');
            if (lazySrc) { fullSrc = lazySrc; }
            try { fullSrc = new URL(fullSrc, location.href).href; } catch {}
            const iframeId = node.id || '';
            const iframeClasses = node.className || '';
            const parentId = node.parentElement ? node.parentElement.id || '' : '';
            const parentClasses = node.parentElement ? node.parentElement.className || '' : '';

            let logKeyBase = 'iframe';
            try {
                const urlObj = new URL(fullSrc);
                const pathPrefix = urlObj.pathname.split('/').slice(0, 3).join('/');
                logKeyBase = `${urlObj.hostname}${pathPrefix}`;
            } catch {
                logKeyBase = 'invalid-src-url';
            }

            if (fullSrc.startsWith('blob:') || fullSrc.startsWith('javascript:')) {
                try { node.remove(); } catch {}
                return;
            }

            const isForcedBlocked = IFRAME_FORCE_BLOCK_PATTERNS.some(pattern => {
                return fullSrc.includes(pattern) || iframeId.includes(pattern) || iframeClasses.includes(pattern) || parentId.includes(pattern) || parentClasses.includes(pattern);
            });

            if (isForcedBlocked) {
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }

            if (!node.hasAttribute('sandbox')) {
                try {
                    node.setAttribute('sandbox', USER_SETTINGS.defaultIframeSandbox);
                } catch(e) {
                }
            }

            if (node.src?.startsWith('data:text/html;base64,') && !isFeatureAllowed('iframeBase64')) {
                try { if (node.parentNode) node.parentNode.removeChild(node); } catch {}
                return;
            }
        }
    };

    // --- 레이어 클릭 덫 로직 ---
    const layerTrap = {
        check: (node) => {
            if (!FeatureFlags.layerTrap) return;
            if (!(node instanceof HTMLElement)) {
                return;
            }

            try {
                const style = getComputedStyle(node);
                const isSuspect = (style.position === 'fixed' &&
                                   parseInt(style.zIndex) > 1000 &&
                                   (parseFloat(style.opacity) < 0.2 || style.visibility === 'hidden' || style.display === 'none') &&
                                   style.pointerEvents !== 'none');

                const suspiciousHandlers = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'];
                const hasSuspiciousHandler = suspiciousHandlers.some(handler => node.hasAttribute(handler));

                if (isSuspect && hasSuspiciousHandler) {
                    node.style.setProperty('display', 'none', 'important');
                    node.setAttribute('data-popupblocker-status', 'removed');

                    node.addEventListener('click', e => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }, true);
                }
            } catch(e) {
            }
        }
    };

    // --- 비디오 탐색 로직 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = new Set();
            try {
                doc.querySelectorAll('video').forEach(v => videos.add(v));
            } catch (e) {
            }

            const potentialVideoContainers = doc.querySelectorAll('div[data-src], div[data-video], div[data-video-id], div[class*="video"], div[id*="player"]');
            potentialVideoContainers.forEach(container => {
                const videoElement = container.querySelector('video');
                if (videoElement) {
                    videos.add(videoElement);
                }
            });

            if (USER_SETTINGS.enableVideoDebugBorder) {
                let style = doc.querySelector('style#video-debug-style');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'video-debug-style';
                    style.textContent = `.my-video-ui-initialized { outline: 2px solid red !important; }`;
                    if (doc.head) {
                        doc.head.appendChild(style);
                    } else if (doc.body) {
                        doc.body.appendChild(style);
                    }
                }
            }

            videos.forEach(video => {
                if (!PROCESSED_VIDEOS.has(video)) {
                    const sources = [...video.querySelectorAll('source')].map(s => s.src).filter(Boolean);
                    const videoSource = video.currentSrc || video.src || sources[0] || '';
                    if (video.style.pointerEvents === 'none') {
                        video.style.setProperty('pointer-events', 'auto', 'important');
                    }
                    if (USER_SETTINGS.enableVideoDebugBorder && !video.classList.contains('my-video-ui-initialized')) {
                        video.classList.add('my-video-ui-initialized');
                    }
                    PROCESSED_VIDEOS.add(video);
                }
            });
            return Array.from(videos);
        },
        findAll: () => {
            let videos = videoFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDocument) {
                        videos.push(...videoFinder.findInDoc(iframeDocument));
                    }
                } catch (e) {
                }
            });
            return videos;
        }
    };

    // --- 비디오 UI 통합 초기화 함수 ---
    const videoControls = {
        init: () => {
            if (!FeatureFlags.videoControls) return;
            if (!videoUIFlags.speedSliderInitialized) {
                speedSlider.init();
            }
            if (!videoUIFlags.dragBarInitialized) {
                dragBar.init();
            }
        },
        initWhenReady: (video) => {
            if (PROCESSED_VIDEOS.has(video) || !FeatureFlags.videoControls) return;

            const initLogic = () => {
                videoControls.init();
                video.removeEventListener('canplay', initLogic);
            };

            video.addEventListener('canplay', initLogic, { once: true });
        }
    };

    // --- 배속 슬라이더 로직 ---
    const speedSlider = {
        speedSliderContainer: null,
        init: function() {
            if (videoUIFlags.speedSliderInitialized) return;

            const sliderId = 'vm-speed-slider-container';
            const createSliderElements = () => {
                const container = document.createElement('div');
                container.id = sliderId;
                container.style.touchAction = 'none'; // 터치 액션 차단
                const style = document.createElement('style');
                style.textContent = `
                    #${sliderId} {
                        position: fixed; top: 50%; right: 0; transform: translateY(-50%);
                        background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px 0 0 8px;
                        z-index: 2147483647 !important; display: none; flex-direction: column;
                        align-items: center; width: 50px; height: auto; font-family: sans-serif;
                        pointer-events: auto; opacity: 0.3; transition: opacity 0.3s; user-select: none;
                        box-shadow: 0 0 0px rgba(0,0,0,0.0); will-change: transform, opacity;
                    }
                    #${sliderId}:hover { opacity: 1; }
                    #vm-speed-reset-btn {
                        background: #444; border: none; border-radius: 4px; color: white;
                        font-size: 14px; padding: 4px 6px; cursor: pointer;
                        margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold;
                    }
                    #vm-speed-reset-btn:hover { background: #666; }
                    #vm-speed-slider {
                        writing-mode: vertical-lr;
                        direction: rtl;
                        width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer;
                        background: #555; border-radius: 5px;
                    }
                    #vm-speed-slider::-webkit-slider-thumb {
                        -webkit-appearance: none; width: 20px; height: 20px; background: #f44336;
                        border-radius: 50%; cursor: pointer; border: 1px solid #ddd;
                    }
                    #vm-speed-slider::-moz-range-thumb {
                        width: 20px; height: 20px; background: #f44336; border-radius: 50%;
                        cursor: pointer; border: 1px solid #ddd;
                    }
                    #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                `;
                if (document.head) {
                    document.head.appendChild(style);
                } else if (document.body) {
                    document.body.appendChild(style);
                }
                const resetBtn = document.createElement('button');
                resetBtn.id = 'vm-speed-reset-btn';
                resetBtn.textContent = '1x';
                const slider = document.createElement('input');
                slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
                slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                const valueDisplay = document.createElement('div');
                valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';

                slider.addEventListener('input', () => this.onSliderChange(slider.value));
                slider.addEventListener('change', () => this.updateSpeed(parseFloat(slider.value || '1.0')));
                resetBtn.addEventListener('click', () => {
                    slider.value = '1.0'; this.onSliderChange('1.0');
                });
                container.addEventListener('mousedown', () => videoUIFlags.isUIBeingUsed = true, true);
                container.addEventListener('mouseup', () => videoUIFlags.isUIBeingUsed = false, true);
                container.addEventListener('touchstart', () => videoUIFlags.isUIBeingUsed = true, true);
                container.addEventListener('touchend', () => videoUIFlags.isUIBeingUsed = false, true);
                container.appendChild(resetBtn);
                container.appendChild(slider);
                container.appendChild(valueDisplay);
                this.speedSliderContainer = container; // 변수에 할당
            };
            createSliderElements(); // 요소 생성
            videoUIFlags.speedSliderInitialized = true;
        },
        updateSpeed: (speed) => {
            const validSpeed = parseFloat(speed);
            if (isNaN(validSpeed)) return;
            const videos = videoFinder.findAll();
            videos.forEach(video => { video.playbackRate = validSpeed; });
        },
        onSliderChange: (val) => {
            const speed = parseFloat(val);
            if (isNaN(speed)) return;
            const valueDisplay = document.getElementById('vm-speed-value');
            if (valueDisplay) { valueDisplay.textContent = `x${speed.toFixed(1)}`; }
            if (videoUIFlags.playbackUpdateTimer) clearTimeout(videoUIFlags.playbackUpdateTimer);
            videoUIFlags.playbackUpdateTimer = setTimeout(() => { speedSlider.updateSpeed(speed); }, 100);
        },
        show: function() {
            if (!this.speedSliderContainer) {
                this.init();
            }
            if (!this.speedSliderContainer) return;

            if (!this.speedSliderContainer.parentNode) {
                document.body.appendChild(this.speedSliderContainer);
            }

            const targetParent = document.fullscreenElement || document.body;
            if (this.speedSliderContainer.parentNode !== targetParent) {
                this.speedSliderContainer.parentNode.removeChild(this.speedSliderContainer);
                targetParent.appendChild(this.speedSliderContainer);
            }

            this.speedSliderContainer.style.display = 'flex';
            this.updatePositionAndSize();
            const slider = document.getElementById('vm-speed-slider');
            this.updateSpeed(slider.value || '1.0');
        },
        hide: function() {
            if (this.speedSliderContainer) { this.speedSliderContainer.style.display = 'none'; }
        },
        updatePositionAndSize: function() {
            const video = document.querySelector('video');
            const sliderContainer = this.speedSliderContainer;
            const slider = document.getElementById('vm-speed-slider');

            if (!video || !sliderContainer || !slider) return;

            sliderContainer.style.position = 'fixed';
            sliderContainer.style.top = '50%';
            sliderContainer.style.right = '0';
            sliderContainer.style.transform = 'translateY(-50%)';

            let newHeight;
            if (isMobile) {
                newHeight = 100;
            } else {
                const minHeight = 100;
                const maxHeight = 300;
                const rect = video.getBoundingClientRect();
                newHeight = rect.height * 0.8;
                newHeight = Math.min(maxHeight, Math.max(minHeight, newHeight));
            }
            slider.style.height = `${newHeight}px`;

            if (document.fullscreenElement) {
                if (sliderContainer.parentNode !== document.fullscreenElement) {
                    document.fullscreenElement.appendChild(sliderContainer);
                }
            } else {
                if (sliderContainer.parentNode !== document.body) {
                    document.body.appendChild(sliderContainer);
                }
            }
            sliderContainer.style.display = 'flex';
        }
    };

    // --- 드래그바 로직 ---
    const dragBar = {
        dragBarTimeDisplay: null,
        createTimeDisplay: function() {
            const newTimeDisplay = document.createElement('div');
            newTimeDisplay.id = 'vm-time-display';
            newTimeDisplay.style.cssText = `
                position: fixed !important; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 5px;
                font-size: 1.5rem; z-index: 2147483647 !important; display: none; pointer-events: none;
                transition: opacity 0.3s ease-out; opacity: 1; text-align: center; white-space: nowrap;
                will-change: transform, opacity;
            `;
            newTimeDisplay.style.touchAction = 'none'; // 터치 액션 차단
            return newTimeDisplay;
        },
        show: function() {
            if (!this.dragBarTimeDisplay) {
                this.init();
            }
            if (!this.dragBarTimeDisplay) return;

            if (!this.dragBarTimeDisplay.parentNode) {
                document.body.appendChild(this.dragBarTimeDisplay);
            }

            const targetParent = document.fullscreenElement || document.body;
            if (this.dragBarTimeDisplay.parentNode !== targetParent) {
                 if (this.dragBarTimeDisplay.parentNode) {
                    this.dragBarTimeDisplay.parentNode.removeChild(this.dragBarTimeDisplay);
                }
                targetParent.appendChild(this.dragBarTimeDisplay);
            }
        },
        hide: function() {
             if (this.dragBarTimeDisplay) {
                 this.dragBarTimeDisplay.style.display = 'none';
             }
        },
        init: function() {
            if (videoUIFlags.dragBarInitialized) return;
            videoUIFlags.dragBarInitialized = true;
            
            const dragState = {
                isDragging: false,
                isHorizontalDrag: false,
                startX: 0,
                startY: 0,
                lastUpdateX: 0,
                currentDragDistanceX: 0,
                totalTimeChange: 0,
                originalPointerEvents: new Map(),
                recoveryTimer: null,
                throttleTimer: null,
                lastDragTimestamp: 0,
                throttleDelay: 80,
            };

            const DRAG_THRESHOLD = 10;
            const TIME_CHANGE_SENSITIVITY = 2;
            const VERTICAL_DRAG_THRESHOLD = 20;

            const formatTime = (seconds) => {
                const absSeconds = Math.abs(seconds);
                const sign = seconds < 0 ? '-' : '+';
                const minutes = Math.floor(absSeconds / 60);
                const remainingSeconds = Math.floor(absSeconds % 60);
            
                const paddedMinutes = String(minutes).padStart(2, '0');
                const paddedSeconds = String(remainingSeconds).padStart(2, '0');

                return `${sign}${paddedMinutes}분${paddedSeconds}초`;
            };

            const updateTimeDisplay = (timeChange) => {
                if (!this.dragBarTimeDisplay) {
                    this.dragBarTimeDisplay = this.createTimeDisplay();
                    const parent = document.fullscreenElement || document.body;
                    parent.appendChild(this.dragBarTimeDisplay);
                }
                if (!this.dragBarTimeDisplay) return;
            
                if (timeChange !== 0) {
                    this.dragBarTimeDisplay.textContent = `${formatTime(timeChange)} 이동`;
                    this.dragBarTimeDisplay.style.display = 'block';
                    this.dragBarTimeDisplay.style.opacity = '1';
                } else {
                    this.dragBarTimeDisplay.style.opacity = '0';
                    clearTimeout(this.dragBarTimeDisplay.timer);
                    this.dragBarTimeDisplay.timer = setTimeout(() => {
                        if (this.dragBarTimeDisplay.style.opacity === '0') {
                            this.dragBarTimeDisplay.style.display = 'none';
                        }
                    }, 300);
                }
            };
            
            const cancelDrag = () => {
                if (!dragState.isDragging) return;

                if (dragState.recoveryTimer) {
                    clearTimeout(dragState.recoveryTimer);
                }
                if (dragState.throttleTimer) {
                    clearTimeout(dragState.throttleTimer);
                    dragState.throttleTimer = null;
                }

                updateTimeDisplay(0);

                const videos = videoFinder.findAll();
                videos.forEach(video => {
                    if (dragState.originalPointerEvents.has(video)) {
                        video.style.pointerEvents = dragState.originalPointerEvents.get(video);
                    }
                });

                dragState.originalPointerEvents = new Map();
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                document.body.style.userSelect = '';
                videoUIFlags.isUIBeingUsed = false;
            };

            const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;

            const handleStart = (e) => {
                if (e.button === 2) return;
                if (e.touches && e.touches.length > 1) {
                    return;
                }
                if (e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;

                const videos = videoFinder.findAll();
                if (videos.length === 0 || videos.every(v => v.paused)) {
                    videoUIFlags.isUIBeingUsed = false;
                    return;
                }

                videoUIFlags.isUIBeingUsed = true;
                dragState.isDragging = true;
                dragState.isHorizontalDrag = false;
                const pos = getPosition(e);
                dragState.startX = pos.clientX;
                dragState.startY = pos.clientY;
                dragState.lastUpdateX = pos.clientX;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;

                dragState.recoveryTimer = setTimeout(cancelDrag, 5000);
            };

            const applyTimeChange = () => {
                const videos = videoFinder.findAll();
                const timeToApply = Math.round(dragState.currentDragDistanceX / 2);

                if (timeToApply !== 0) {
                    videos.forEach(video => {
                        if (video && video.duration && isFinite(video.duration)) {
                            const newTime = Math.min(video.duration, Math.max(0, video.currentTime + timeToApply));
                            video.currentTime = newTime;

                            setTimeout(() => {
                                if (Math.abs(video.currentTime - newTime) > 0.3) {
                                    video.currentTime = newTime;
                                }
                            }, 100);
                        }
                    });
                    dragState.currentDragDistanceX = 0;
                    updateTimeDisplay(dragState.totalTimeChange);
                }
            };

            const handleMove = (e) => {
                if (!dragState.isDragging) return;
                if (e.touches && e.touches.length > 1) {
                    cancelDrag();
                    return;
                }

                const videos = videoFinder.findAll();
                if (videos.length === 0) {
                    cancelDrag();
                    return;
                }

                const pos = getPosition(e);
                const currentX = pos.clientX;
                const currentY = pos.clientY;
                const dx = Math.abs(currentX - dragState.startX);
                const dy = Math.abs(currentY - dragState.startY);

                if (!dragState.isHorizontalDrag) {
                    if (dx > 10 && dy < dx * 1.5) {
                        dragState.isHorizontalDrag = true;
                        if (isMobile) {
                           e.preventDefault();
                           e.stopImmediatePropagation();
                        }
                        document.body.style.userSelect = 'none';
                        videos.forEach(video => {
                            dragState.originalPointerEvents.set(video, video.style.pointerEvents);
                            video.style.pointerEvents = 'none';
                        });
                    } else if (dy > 10) {
                        cancelDrag();
                        return;
                    }
                }

                if (dragState.isHorizontalDrag) {
                    e.preventDefault();
                    e.stopImmediatePropagation();

                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    dragState.totalTimeChange = Math.round( (currentX - dragState.startX) / 2 );

                    updateTimeDisplay(dragState.totalTimeChange);

                    const now = Date.now();
                    const timeSinceLastUpdate = now - dragState.lastDragTimestamp;

                    if (timeSinceLastUpdate > 50) {
                        const dragSpeed = Math.abs(currentX - dragState.lastUpdateX) / timeSinceLastUpdate;
                        dragState.throttleDelay = dragSpeed > 1 ? 150 : 80;
                    }
                    dragState.lastDragTimestamp = now;

                    if (dragState.throttleTimer === null) {
                        dragState.throttleTimer = setTimeout(() => {
                            applyTimeChange();
                            dragState.throttleTimer = null;
                        }, dragState.throttleDelay);
                    }
                    dragState.lastUpdateX = currentX;
                }
            };

            const handleEnd = (e) => {
                if (!dragState.isDragging) return;
                cancelDrag();
            };

            // 드래그 관련 이벤트 리스너 등록
            document.addEventListener('mousedown', handleStart, { passive: false, capture: true });
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('mouseout', (e) => {
                if (e.relatedTarget === null) {
                    handleEnd();
                }
            }, { passive: false, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchcancel', handleEnd, { passive: false, capture: true });

            // 탭 변경/포커스 상실 시 드래그 상태 강제 복구 (지연 처리)
            let cancelTimeout;
            const delayedCancelDrag = () => {
              if (dragState.dragging) {
                cancelTimeout = setTimeout(() => {
                  if (dragState.dragging) cancelDrag();
                }, 300);
              }
            };
            window.addEventListener('visibilitychange', () => {
              if (document.hidden) delayedCancelDrag();
              else clearTimeout(cancelTimeout);
            });
            window.addEventListener('blur', delayedCancelDrag);
            window.addEventListener('focus', () => clearTimeout(cancelTimeout));

            this.dragBarTimeDisplay = this.createTimeDisplay();
            videoUIFlags.dragBarInitialized = true;
        }
    };
    
    // throttle 함수 정의
    function throttle(func, limit) {
      let inThrottle;
      return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
          func.apply(context, args);
          inThrottle = true;
          setTimeout(() => inThrottle = false, limit);
        }
      };
    }

    // --- 핸들러 테이블 기반 노드 처리 로직 ---
    const handlers = [
        {
            match: (node) => node.tagName === 'IFRAME',
            action: (node, trigger) => iframeBlocker.init(node, trigger)
        },
        {
            match: (node) => node.tagName === 'VIDEO',
            action: (node) => {
                // 비디오 UI는 startVideoUIWatcher에서 통합 관리
            }
        },
        {
            match: (node) => node.nodeType === 1,
            action: (node) => layerTrap.check(node)
        }
    ];

    function processNodeAndChildren(node, trigger) {
        if (!node || PROCESSED_NODES.has(node)) return;
        PROCESSED_NODES.add(node);

        for (const handler of handlers) {
            if (handler.match(node)) {
                try {
                    handler.action(node, trigger);
                } catch (e) {
                }
            }
        }

        if (node.children) {
            for (const child of node.children) {
                processNodeAndChildren(child, trigger);
            }
        }
    }

    // --- iframe 로드 및 내부 탐색 처리 ---
    function handleIframeLoad(iframe) {
        if (PROCESSED_IFRAMES.has(iframe)) return;
        PROCESSED_IFRAMES.add(iframe);

        const iframeSrc = iframe.src || iframe.getAttribute('data-lazy-src') || 'about:blank';

        const isUnsafeSrc = iframeSrc.startsWith('javascript:');

        if (isUnsafeSrc) {
            return;
        }

        try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDocument && !PROCESSED_DOCUMENTS.has(iframeDocument)) {
                safeInitializeAll(iframeDocument, 'iframe load');
            }
        } catch (e) {
        }
    }

    // --- 통합 MutationObserver 로직 (중첩 iframe 재귀 탐색 강화) ---
    function startUnifiedObserver(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) {
            return;
        }

        const rootElement = targetDocument.documentElement || targetDocument.body;
        if (!rootElement) {
            return;
        }

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processNodeAndChildren(node, '동적 추가'));
                } else if (mutation.type === 'attributes') {
                    const targetNode = mutation.target;
                    if (targetNode.nodeType === 1) {
                        if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                            PROCESSED_IFRAMES.delete(targetNode);
                            processNodeAndChildren(targetNode, 'iframe src 변경');
                        }
                        processNodeAndChildren(targetNode, '속성 변경');
                    }
                }
            });
        });

        try {
            observer.observe(rootElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart'] });
            PROCESSED_DOCUMENTS.add(targetDocument);
            OBSERVER_MAP.set(targetDocument, observer);
        } catch(e) {
        }

        try {
            targetDocument.querySelectorAll('iframe').forEach(iframe => {
                handleIframeLoad(iframe);
            });
        } catch(e) {
        }
    }

    // --- 비디오 UI 감지 및 토글을 위한 통합 루프 ---
    function startVideoUIWatcher(targetDocument = document) {
        if (!FeatureFlags.videoControls) return;

        const checkVideos = () => {
            const videos = videoFinder.findAll();
            let isAnyVideoAvailable = false;

            videos.forEach(video => {
                if (video.readyState >= 1 || (video.clientWidth > 0 && video.clientHeight > 0)) {
                    isAnyVideoAvailable = true;
                }
            });

            if (isAnyVideoAvailable) {
                if (!window.__videoUIInitialized) {
                    window.__videoUIInitialized = true;
                    videoControls.init();
                }
                speedSlider.show();
                dragBar.show();
            } else {
                speedSlider.hide();
                dragBar.hide();
            }
        };

        setInterval(checkVideos, 1500);

        // 스크립트 로딩 직후 첫 번째 검사를 즉시 실행
        checkVideos();
    }

    // --- 범용 SPA 감지 로직 ---
    let lastURL = location.href;
    let spaNavigationTimer = null;

    function onNavigate(reason = 'URL 변경 감지') {
        const url = location.href;
        if (url !== lastURL) {
            if (spaNavigationTimer) {
                clearTimeout(spaNavigationTimer);
            }
            spaNavigationTimer = setTimeout(() => {
                lastURL = url;

                OBSERVER_MAP.forEach(observer => observer.disconnect());
                PROCESSED_DOCUMENTS.clear();
                PROCESSED_NODES.clear();
                PROCESSED_IFRAMES.clear();
                PROCESSED_VIDEOS.clear();
                window.__videoUIInitialized = false;

                initializeAll(document);
            }, 1000);
        }
    }

    ['pushState', 'replaceState'].forEach(type => {
        const orig = history[type];
        history[type] = function (...args) {
            orig.apply(this, args);
            onNavigate(`history.${type}`);
        };
    });

    window.addEventListener('popstate', () => onNavigate('popstate'));
    window.addEventListener('hashchange', () => onNavigate('hashchange'));

    // --- 드래그바 시간 표시가 전체 화면에서 보이지 않는 문제 해결 ---
    const handleFullscreenChange = () => {
        const fsElement = document.fullscreenElement;

        const updateParent = (element) => {
            if (!element) return;
            const targetParent = fsElement || document.body;
            if (element.parentNode !== targetParent) {
                if (element.parentNode) {
                    element.parentNode.removeChild(element);
                }
                targetParent.appendChild(element);
            }
        };

        if (speedSliderContainer) updateParent(speedSliderContainer);
        if (dragBarTimeDisplay) updateParent(dragBarTimeDisplay);

        if (!fsElement) {
            const forceReflow = () => {
                document.body.style.transform = 'scale(1)';
                document.body.offsetWidth;
                document.body.style.transform = '';
            };
            setTimeout(forceReflow, 100);
            window.dispatchEvent(new Event('resize'));
        }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // --- 단일 초기 실행 함수 ---
    function initializeAll(targetDocument = document) {
        if (PROCESSED_DOCUMENTS.has(targetDocument)) {
            return;
        }

        if (targetDocument === document) {
            try {
                popupBlocker.init();
            } catch (e) {
            }
            isInitialLoadFinished = true;
        }

        try {
            startUnifiedObserver(targetDocument);
        } catch (e) {
        }

        try {
            startVideoUIWatcher(targetDocument);
        } catch (e) {
        }
    }

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initializeAll(document));
    } else {
        initializeAll(document);
    }

    // --- utility functions ---
    const getFakeWindow = () => ({
        focus: () => {}, opener: null, closed: false, blur: () => {}, close: () => {},
        location: { href: "", assign: () => {}, replace: () => {}, reload: () => {}, toString: () => "", valueOf: () => "" },
        alert: () => {}, confirm: () => {}, prompt: () => {}, postMessage: () => {},
        document: { write: () => {}, writeln: () => {} },
    });
    
})();
