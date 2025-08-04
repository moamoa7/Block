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
