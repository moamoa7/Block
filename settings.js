// ==UserScript==
// @name VideoSpeed_Control
// @namespace https.com/
// @version 15.20 (코드 최적화)
// @description 🎞️ 비디오 속도 제어 + 🔍 SPA/iframe 동적 탐지 + 📋 로그 뷰어 통합 (최종 개선판)
// @match *://*/*
// @grant GM_xmlhttpRequest
// @grant none
// @connect *
// @run-at document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 전역 설정 및 기능 플래그 ---
    const FeatureFlags = {
        videoControls: true,
        logUI: true,
        enhanceURLDetection: true,
        spaPartialUpdate: true,
        detailedLogging: true,
        previewFiltering: true,
    };
    const DRAG_CONFIG = {
        PIXELS_PER_SECOND: 2
    };

    // --- 미리보기 정의 및 설정 ---
    const PREVIEW_CONFIG = {
        PATTERNS: [/preview/i, /thumb/i, /sprite/i, /teaser/i, /sample/i, /poster/i, /thumbnail/i],
        DURATION_THRESHOLD: 12,
        MIN_PIXEL_AREA: 2000,
        LOG_LEVEL_FOR_SKIP: 'warn'
    };

    // --- 스크립트 초기 실행 전 예외 처리 ---
    if (window.hasOwnProperty('__MySuperScriptInitialized') && window.__MySuperScriptInitialized) {
        return;
    }
    Object.defineProperty(window, '__MySuperScriptInitialized', {
        value: true, writable: false, configurable: true
    });

    // --- 전역 상태 및 중복 방지 ---
    let PROCESSED_NODES = new WeakSet();
    let PROCESSED_IFRAMES = new WeakSet();
    let PROCESSED_DOCUMENTS = new WeakSet();
    const OBSERVER_MAP = new Map();
    const LOGGED_KEYS_WITH_TIMER = new Map();
    const MEDIA_STATE = new WeakMap();
    const PREVIEW_ELEMENTS = new WeakSet();
    const isTopFrame = window.self === window.top;

    // --- 유틸리티 함수 ---
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // --- 로그 모듈 ---
    const logManager = (() => {
        let logBoxContainer = null;
        let logContentBox = null;
        let logDismissTimer = null;
        const logHistory = [];
        const pendingLogs = [];

        function addLogToBox(msg) {
            if (!logContentBox) {
                pendingLogs.push(msg);
                return;
            }
            logHistory.push(msg);
            if (logHistory.length > 50) logHistory.shift();
            if (logBoxContainer) {
                logBoxContainer.style.opacity = '1';
                logBoxContainer.style.pointerEvents = 'auto';
            }
            const MAX_LOGS = 50;
            if (logContentBox.childElementCount >= MAX_LOGS) {
                logContentBox.removeChild(logContentBox.firstChild);
            }
            const entry = document.createElement('div');
            entry.textContent = msg;
            entry.style.textAlign = 'left';
            logContentBox.appendChild(entry);
            logContentBox.scrollTop = logContentBox.scrollHeight;

            if (logDismissTimer) clearTimeout(logDismissTimer);
            logDismissTimer = setTimeout(() => {
                if (logBoxContainer) {
                    logBoxContainer.style.opacity = '0';
                    logBoxContainer.style.pointerEvents = 'none';
                }
            }, 10000);
        }

        function addLog(msg, level = 'info') {
            const ICONS = { info: 'ℹ️', warn: '⚠️', 'error': '🔴', 'allow': '✅', 'debug': '🔧', 'stream': '▶️' };
            const fullMsg = `[${new Date().toLocaleTimeString()}] ${ICONS[level] || ''} ${msg}`;
            if (console[level]) {
                console[level](fullMsg);
            } else {
                console.log(fullMsg);
            }
            if (!FeatureFlags.logUI) return;
            if (!isTopFrame) {
                try {
                    window.parent.postMessage({ type: 'MY_SCRIPT_LOG', message: fullMsg, level: level, key: msg }, '*');
                    return;
                } catch (e) {}
            }
            addLogToBox(fullMsg);
        }

        function addLogOnce(key, message, delay = 5000, level = 'info') {
            const now = Date.now();
            for (const [k, t] of LOGGED_KEYS_WITH_TIMER) {
                if (now - t > delay) {
                    LOGGED_KEYS_WITH_TIMER.delete(k);
                }
            }
            const lastTime = LOGGED_KEYS_WITH_TIMER.get(key);
            if (!lastTime || now - lastTime > delay) {
                LOGGED_KEYS_WITH_TIMER.set(key, now);
                addLog(message, level);
            }
        }

        function logIframeContext(iframe, message) {
            if (!FeatureFlags.detailedLogging) return;
            let srcInfo = iframe.src || 'about:blank';
            if (iframe.srcdoc) {
                srcInfo += ` [srcdoc: ${iframe.srcdoc.substring(0, 100)}...]`;
            }
            const domain = (() => {
                try {
                    return new URL(iframe.src).hostname;
                } catch {
                    return 'same-origin or blob';
                }
            })();
            const msg = `🧩 iframe ${message} | src: ${srcInfo} | 도메인: ${domain}`;
            addLogOnce(`iframe_log_${message}_${domain}`, msg, 7000, 'info');
        }

        function logMediaContext(media, message, level = 'info') {
            if (!FeatureFlags.detailedLogging || !media) return;
            const rect = media.getBoundingClientRect();
            const playing = !media.paused;
            const src = media.src || media.dataset.src || 'none';
            const duration = isFinite(media.duration) ? media.duration.toFixed(1) : 'N/A';
            const msg = `🎬 ${message} | src: ${src} | 크기: ${Math.round(rect.width)}x${Math.round(rect.height)} | 길이: ${duration}s | 상태: ${playing ? '재생 중' : '일시 정지'}`;
            addLogOnce(`media_log_${message}_${src}`, msg, 5000, level);
        }

        function logSPANavigation(oldURL, newURL, reason) {
            if (!FeatureFlags.detailedLogging) return;
            addLogOnce(
                `spa_nav_${newURL}`,
                `🔄 SPA 네비게이션 감지 | 이전 URL: ${oldURL} | 새로운 URL: ${newURL} | 이유: ${reason}`,
                7000,
                'info'
            );
        }

        function logErrorWithContext(error, contextNode) {
            if (!FeatureFlags.detailedLogging) return;
            const stack = error.stack || '스택 정보 없음';
            let domContext = '';
            if (contextNode) {
                let path = [];
                let node = contextNode;
                for (let i = 0; i < 3 && node && node !== document.body; i++, node = node.parentElement) {
                    path.push(`${node.tagName}${node.id ? '#' + node.id : ''}${node.className ? '.' + node.className.split(' ').join('.') : ''}`);
                }
                domContext = path.reverse().join(' > ');
            }
            const msg = `❗ 에러 발생: ${error.message}\n스택:\n${stack}\nDOM 컨텍스트: ${domContext}`;
            addLogOnce(`error_${Date.now()}`, msg, 10000, 'error');
        }

        function init() {
            if (!isTopFrame || !FeatureFlags.logUI || document.getElementById('popupBlockerLogContainer')) return;
            logBoxContainer = document.createElement('div');
            logBoxContainer.id = 'popupBlockerLogContainer';
            Object.assign(logBoxContainer.style, {
                position: 'fixed', bottom: '0', right: '0', maxHeight: '100px',
                width: '350px', zIndex: '9999998', borderTopLeftRadius: '8px',
                overflow: 'hidden', opacity: '0', pointerEvents: 'none',
                transition: 'opacity 0.3s ease', boxShadow: '0 0 8px #000'
            });
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '로그 복사';
            Object.assign(copyBtn.style, {
                position: 'absolute', top: '0', right: '0', background: 'rgba(50,50,50,0.9)',
                color: '#fff', border: 'none', borderBottomLeftRadius: '8px',
                padding: '4px 8px', fontSize: '12px', cursor: 'pointer', zIndex: '9999999',
                opacity: '0.8'
            });
            copyBtn.onclick = () => {
                if (logHistory.length > 0) {
                    const logText = logHistory.join('\n');
                    navigator.clipboard.writeText(logText).then(() => {
                        copyBtn.textContent = '복사 완료!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    }).catch(() => {
                        copyBtn.textContent = '복사 실패!';
                        setTimeout(() => copyBtn.textContent = '로그 복사', 2000);
                    });
                }
            };
            logBoxContainer.appendChild(copyBtn);
            logContentBox = document.createElement('div');
            logContentBox.id = 'popupBlockerLogBox';
            Object.assign(logContentBox.style, {
                maxHeight: '100%', width: '100%', background: 'rgba(30,30,30,0.9)',
                color: '#fff', fontFamily: 'monospace', fontSize: '14px',
                overflowY: 'auto', padding: '8px', paddingTop: '25px', userSelect: 'text'
            });
            logBoxContainer.appendChild(logContentBox);

            if (document.body) {
                document.body.appendChild(logBoxContainer);
                while (pendingLogs.length > 0) {
                    addLogToBox(pendingLogs.shift());
                }
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    if (document.body && !document.body.contains(logBoxContainer)) {
                        document.body.appendChild(logBoxContainer);
                        while (pendingLogs.length > 0) {
                            addLogToBox(pendingLogs.shift());
                        }
                    }
                });
            }
        }
        return { init, add: addLog, addOnce: addLogOnce, logIframeContext, logMediaContext, logSPANavigation, logErrorWithContext };
    })();

    // --- networkMonitor 모듈 ---
    const networkMonitor = (() => {
        const VIDEO_URL_CACHE = new Set();
        const MIME_CACHE = new Set();
        const HINT_EXTENSIONS = /\.(mp4|m3u8|mpd|webm|ts|m4s|mp3|ogg)(\?|#|$)/i;
        const HINT_MIME = /^video\/|application\/(vnd\.apple\.mpegurl|dash\+xml)/i;

        let _hooked = false;

        function isMediaUrl(url) {
            return HINT_EXTENSIONS.test(url) || url.includes('mime=video') || url.includes('type=video') || url.includes('mime=audio') || url.includes('type=audio');
        }

        function isMediaMimeType(mime) {
            return mime?.includes('video/') || mime?.includes('audio/') || mime?.includes('octet-stream') || mime?.includes('mpegurl') || mime?.includes('mp2t') || mime?.includes('application/dash+xml');
        }

        function normalizeURL(url) {
            try { return new URL(url, location.href).href; } catch { return url; }
        }

        function isPreviewURL(url) {
            if (!url || typeof url !== 'string') return false;
            try {
                const u = url.toLowerCase();
                return PREVIEW_CONFIG.PATTERNS.some(p => p.test(u));
            } catch (e) { return false; }
        }

        function trackAndAttach(url, context = {}) {
            if (!url) return;
            const normUrl = normalizeURL(url);

            if (FeatureFlags.previewFiltering && isPreviewURL(normUrl)) {
                logManager.addOnce(`[Skip:Preview]${normUrl}`, `🔴 [Skip:Preview] URL 필터링에서 미리보기 URL (${normUrl}) 감지, 무시`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                return;
            }

            if (VIDEO_URL_CACHE.has(normUrl)) return;
            VIDEO_URL_CACHE.add(normUrl);

            logManager.addOnce(
                `[EarlyCapture]${normUrl}`,
                `🎯 [EarlyCapture] 동적 영상 URL 감지: ${normUrl} | 소스: ${context.source || 'DOM'}`,
                5000,
                'info'
            );

            dynamicMediaUI.show(normUrl);
        }

        function handleManifestParsing(url, text) {
            if (!text) return;
            const lower = url.toLowerCase();
            if (lower.endsWith('.m3u8') || text.includes('#EXTM3U')) {
                const lines = (text.match(/^[^#][^\r\n]+$/gm) || []).map(l => l.trim());
                lines.forEach(line => {
                    const abs = normalizeURL(line, url);
                    if (isMediaUrl(abs)) {
                        trackAndAttach(abs, { source: 'M3U8 Manifest' });
                    }
                });
            } else if (lower.endsWith('.mpd') || text.includes('<MPD')) {
                const parser = new DOMParser();
                const xml = parser.parseFromString(text, "application/xml");
                const urls = Array.from(xml.querySelectorAll("BaseURL, SegmentTemplate")).map(el => el.textContent.trim() || el.getAttribute('initialization') || el.getAttribute('media')).filter(u => u);
                urls.forEach(u => {
                    const abs = normalizeURL(u, url);
                    if (isMediaUrl(abs)) {
                        trackAndAttach(abs, { source: 'MPD Manifest' });
                    }
                });
            }
        }

        function hookNetwork(win) {
            if (win._nmHooked) return;
            win._nmHooked = true;

            const origFetch = win.fetch;
            if (origFetch) {
                win.fetch = async function(...args) {
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                    if (FeatureFlags.previewFiltering && isPreviewURL(url)) return new Response(null, { status: 200, statusText: 'OK' });
                    const res = await origFetch.apply(this, args);
                    try {
                        const contentType = res.headers.get("content-type");
                        if (isMediaUrl(url) || isMediaMimeType(contentType)) {
                            trackAndAttach(url, { source: 'Fetch' });
                            if (url && (url.toLowerCase().endsWith('.m3u8') || url.toLowerCase().endsWith('.mpd'))) {
                                res.clone().text().then(text => handleManifestParsing(url, text));
                            }
                        }
                    } catch (e) { logManager.logErrorWithContext(e, null); }
                    return res;
                };
            }

            const origOpen = win.XMLHttpRequest.prototype.open;
            const origSend = win.XMLHttpRequest.prototype.send;
            if (origOpen && origSend) {
                win.XMLHttpRequest.prototype.open = function(method, url) {
                    this._nm_url = url;
                    return origOpen.apply(this, arguments);
                };
                win.XMLHttpRequest.prototype.send = function(...sendArgs) {
                    this.addEventListener('load', () => {
                        const url = this._nm_url;
                        try {
                            const contentType = this.getResponseHeader('Content-Type');
                            if (isMediaUrl(url) || isMediaMimeType(contentType)) {
                                trackAndAttach(url, { source: 'XHR' });
                                if (url && (url.toLowerCase().endsWith('.m3u8') || url.toLowerCase().endsWith('.mpd')) && this.response) {
                                    handleManifestParsing(url, this.response);
                                }
                            }
                        } catch(e) { logManager.logErrorWithContext(e, null); }
                    });
                    return origSend.apply(this, sendArgs);
                };
            }
        }

        function hookMediaSource(win) {
            if (!win.MediaSource || win._nmMediaHooked) return;
            win._nmMediaHooked = true;

            const origAddSourceBuffer = win.MediaSource.prototype.addSourceBuffer;
            if (origAddSourceBuffer) {
                win.MediaSource.prototype.addSourceBuffer = function(mime) {
                    try { MIME_CACHE.add(mime); } catch {}
                    return origAddSourceBuffer.apply(this, arguments);
                };
            }

            const proto = win.HTMLMediaElement.prototype;
            const origSrcDesc = Object.getOwnPropertyDescriptor(proto, "src");
            if (origSrcDesc) {
                Object.defineProperty(proto, "src", {
                    set: function(v) {
                        try {
                            const url = normalizeURL(v);
                            if (url.startsWith("blob:") || HINT_EXTENSIONS.test(url)) {
                                trackAndAttach(url, { source: 'video.src setter', element: this });
                            }
                        } catch {}
                        return origSrcDesc.set.call(this, v);
                    },
                    get: origSrcDesc.get,
                    configurable: true
                });
            }
        }

        function init(win = window) {
            if (FeatureFlags.enhanceURLDetection) {
                hookNetwork(win);
                hookMediaSource(win);
            }
        }

        return { init, isMediaUrl, isPreviewURL, VIDEO_URL_CACHE, trackAndAttach };
    })();

    // --- jwplayerMonitor 모듈 ---
    const jwplayerMonitor = (() => {
        let lastItemURL = null;
        let pollTimer = null;
        let isHooked = false;

        const checkPlayer = (player) => {
            try {
                const playlist = player.getPlaylist?.();
                if (!playlist) return;
                playlist.forEach(item => {
                    const fileUrl = item?.file || item?.sources?.[0]?.file;
                    if (fileUrl && fileUrl !== lastItemURL) {
                        lastItemURL = fileUrl;
                        if (networkMonitor && networkMonitor.isMediaUrl(fileUrl)) {
                            logManager.addOnce(`jwplayer_polling_${fileUrl}`, `🎥 JWPlayer 영상 URL 감지됨: ${fileUrl}`, 5000, 'info');
                            networkMonitor.trackAndAttach(fileUrl);
                        }
                    }
                });
            } catch (e) {
                logManager.logErrorWithContext(e, null);
            }
        };

        const hookJWPlayer = (context) => {
            if (isHooked || !context.jwplayer) return;
            isHooked = true;

            const origJW = context.jwplayer;
            context.jwplayer = function (...args) {
                const player = origJW.apply(this, args);
                if (player && typeof player.setup === 'function') {
                    const origSetup = player.setup;
                    player.setup = function (config) {
                        const result = origSetup.call(this, config);
                        setTimeout(() => checkPlayer(this), 500);
                        startPolling(this);
                        return result;
                    };
                }
                return player;
            };
            Object.assign(context.jwplayer, origJW);
            logManager.addOnce('jwplayer_hooked', `✅ JWPlayer 후킹 성공`, 5000, 'info');
        };

        const startPolling = (player) => {
            if (pollTimer) stopPolling();
            pollTimer = setInterval(() => checkPlayer(player), 2000);
            logManager.addOnce('jwplayer_polling_start', `✅ JWPlayer 폴링 시작`, 5000, 'info');
        };

        const stopPolling = () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
                logManager.addOnce('jwplayer_polling_stop', `📴 JWPlayer 폴링 중지`, 5000, 'info');
            }
        };

        const resetState = () => {
            lastItemURL = null;
            stopPolling();
            isHooked = false;
        };

        return { init: hookJWPlayer, resetState };
    })();

    // --- mediaFinder 모듈 ---
    const mediaFinder = {
        findInDoc: (doc) => {
            const medias = [];
            if (!doc || !doc.body) return medias;
            doc.querySelectorAll('video, audio').forEach(m => medias.push(m));
            doc.querySelectorAll('div.jw-player, div[id*="player"], div.video-js, div[class*="video-container"], div.vjs-tech').forEach(container => {
                if (!container.querySelector('video, audio') && container.clientWidth > 0 && container.clientHeight > 0) {
                    medias.push(container);
                }
            });
            doc.querySelectorAll('[data-src], [data-video], [data-url]').forEach(el => {
                const src = el.getAttribute('data-src') || el.getAttribute('data-video') || el.getAttribute('data-url');
                if (src && networkMonitor && networkMonitor.isMediaUrl(src)) {
                    networkMonitor.trackAndAttach(src);
                }
            });
            doc.querySelectorAll('script:not([src])').forEach(script => {
                const text = script.textContent;
                const urls = [...text.matchAll(/https?:\/\/[^\s'"]+\.(mp4|m3u8|mpd|blob:[^\s'"]+)/gi)].map(m => m[0]);
                if (urls.length) {
                    urls.forEach(u => networkMonitor && networkMonitor.trackAndAttach(u));
                }
            });
            return medias;
        },
        findAll: () => {
            let medias = mediaFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDocument) medias.push(...mediaFinder.findInDoc(iframeDocument));
                } catch (e) {}
            });
            return medias;
        },
        findInSubtree: (node) => {
            if (!node) return [];
            const medias = [];
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
                medias.push(node);
            }
            node.querySelectorAll('video, audio').forEach(m => medias.push(m));
            return medias;
        },
    };

    // --- speedSlider 모듈 ---
    const speedSlider = (() => {
        let speedSliderContainer;
        let playbackUpdateTimer;
        let isMinimized = JSON.parse(localStorage.getItem('speedSliderMinimized') || 'true');
        let isInitialized = false;
        let isVisible = false;

        const createSliderElements = () => {
            if (document.getElementById('vm-speed-slider-style')) return;
            const style = document.createElement('style');
            style.id = 'vm-speed-slider-style';
            style.textContent = `
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px; z-index: 2147483647 !important; display: none; flex-direction: column; align-items: center; width: 50px; height: auto; font-family: sans-serif; pointer-events: auto; opacity: 0.3; transition: all 0.3s ease; user-select: none; box-shadow: 0 0 8px rgba(0,0,0,0.0); will-change: transform, opacity, width; }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-reset-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 14px; padding: 4px 6px; cursor: pointer; margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold; }
                #vm-speed-reset-btn:hover { background: #666; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer; background: #555; border-radius: 5px; }
                #vm-speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: #f44336; border-radius: 50%; cursor: pointer; border: 1px solid #ddd; }
                #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                #vm-toggle-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 12px; padding: 4px 6px; cursor: pointer; font-weight: bold; width: 40px; height: 30px; margin-top: 8px; transition: transform 0.2s ease-in-out; }
            `;
            (document.head || document.body).appendChild(style);
        };

        const updateSpeed = (speed) => {
            const validSpeed = parseFloat(speed);
            if (isNaN(validSpeed)) return;
            const medias = mediaFinder.findAll();
            medias.forEach(media => { media.playbackRate = validSpeed; });
        };

        const onSliderChange = (val) => {
            const speed = parseFloat(val);
            if (isNaN(speed)) return;
            if (speedSliderContainer) {
                const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
                if (valueDisplay) valueDisplay.textContent = `x${speed.toFixed(1)}`;
            }
            if (playbackUpdateTimer) clearTimeout(playbackUpdateTimer);
            playbackUpdateTimer = setTimeout(() => updateSpeed(speed), 100);
        };

        const toggleMinimize = () => {
            const container = speedSliderContainer;
            if (!container) return;
            const slider = container.querySelector('#vm-speed-slider');
            const valueDisplay = container.querySelector('#vm-speed-value');
            const resetBtn = container.querySelector('#vm-speed-reset-btn');
            const toggleBtn = container.querySelector('#vm-toggle-btn');
            isMinimized = !isMinimized;
            localStorage.setItem('speedSliderMinimized', isMinimized);
            if (isMinimized) {
                container.style.width = '30px';
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
                if (toggleBtn) toggleBtn.textContent = '▼';
                if (dragBar) dragBar.hide();
            } else {
                container.style.width = '50px';
                if (slider) slider.style.display = 'block';
                if (valueDisplay) valueDisplay.style.display = 'block';
                if (resetBtn) resetBtn.style.display = 'block';
                if (toggleBtn) toggleBtn.textContent = '▲';
                if (speedSlider) speedSlider.updatePositionAndSize();
                const isMediaPlaying = mediaFinder.findAll().some(m => !m.paused);
                if (isMediaPlaying && dragBar) dragBar.show(0);
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            createSliderElements();
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', init);
                return;
            }

            speedSliderContainer = document.getElementById('vm-speed-slider-container');
            if (!speedSliderContainer) {
                speedSliderContainer = document.createElement('div');
                speedSliderContainer.id = 'vm-speed-slider-container';

                const slider = document.createElement('input');
                slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
                slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                slider.addEventListener('input', e => onSliderChange(e.target.value), true);
                slider.addEventListener('change', e => updateSpeed(parseFloat(e.target.value)), true);

                const resetBtn = document.createElement('button');
                resetBtn.id = 'vm-speed-reset-btn'; resetBtn.textContent = '1x';
                resetBtn.addEventListener('click', e => { slider.value = '1.0'; onSliderChange('1.0'); });

                const valueDisplay = document.createElement('div');
                valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';

                const toggleBtn = document.createElement('button');
                toggleBtn.id = 'vm-toggle-btn'; toggleBtn.textContent = isMinimized ? '▼' : '▲';
                toggleBtn.addEventListener('click', toggleMinimize);

                speedSliderContainer.appendChild(resetBtn);
                speedSliderContainer.appendChild(slider);
                speedSliderContainer.appendChild(valueDisplay);
                speedSliderContainer.appendChild(toggleBtn);

                if (document.body && !document.body.contains(speedSliderContainer)) {
                    document.body.appendChild(speedSliderContainer);
                }
            }
            if (isMinimized) {
                speedSliderContainer.style.width = '30px';
                const slider = speedSliderContainer.querySelector('#vm-speed-slider');
                const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
                const resetBtn = speedSliderContainer.querySelector('#vm-speed-reset-btn');
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
            }
        };

        const show = () => {
            if (isVisible) return;
            if (!speedSliderContainer) init();
            if (!speedSliderContainer) return;
            if (!document.body.contains(speedSliderContainer)) {
                document.body.appendChild(speedSliderContainer);
            }
            speedSliderContainer.style.display = 'flex';
            updatePositionAndSize();
            const slider = speedSliderContainer.querySelector('#vm-speed-slider');
            if (slider) updateSpeed(slider.value);
            isVisible = true;
        };
        const hide = () => {
            if (!isVisible) return;
            if (speedSliderContainer) speedSliderContainer.style.display = 'none';
            isVisible = false;
        };

        const updatePositionAndSize = () => {
            const sliderContainer = speedSliderContainer;
            if (!sliderContainer) return;
            const medias = mediaFinder.findAll();
            const media = medias.find(m => m.clientWidth > 0 && m.clientHeight > 0);
            const slider = sliderContainer.querySelector('#vm-speed-slider');
            const newHeight = media ? Math.max(100, media.getBoundingClientRect().height * 0.3) : 100;
            if (slider) slider.style.height = `${newHeight}px`;
            const targetParent = document.fullscreenElement || document.body;
            if (targetParent && sliderContainer.parentNode !== targetParent) {
                targetParent.appendChild(sliderContainer);
            }
        };

        return { init, show, hide, updatePositionAndSize, isMinimized: () => isMinimized };
    })();

    // --- dragBar 모듈 ---
    const dragBar = (() => {
        let dragBarTimeDisplay;
        const dragState = {
            isDragging: false, isHorizontalDrag: false,
            startX: 0, startY: 0, lastUpdateX: 0,
            currentDragDistanceX: 0, totalTimeChange: 0,
            recoveryTimer: null, throttleTimer: null, lastDragTimestamp: 0
        };
        let isInitialized = false;
        let hideTimeout;
        let isVisible = false;

        const formatTime = (seconds) => {
            const absSeconds = Math.abs(seconds);
            const sign = seconds < 0 ? '-' : '+';
            const minutes = Math.floor(absSeconds / 60);
            const remainingSeconds = Math.floor(absSeconds % 60);
            const paddedMinutes = String(minutes).padStart(2, '0');
            const paddedSeconds = String(remainingSeconds).padStart(2, '0');
            return `${sign}${paddedMinutes}분${paddedSeconds}초`;
        };

        const showTimeDisplay = (totalTimeChange) => {
            if (!dragBarTimeDisplay || isNaN(totalTimeChange)) return;
            if (totalTimeChange === 0) {
                hideTimeDisplay();
                return;
            }

            clearTimeout(hideTimeout);
            const targetParent = document.fullscreenElement || document.body;
            if (dragBarTimeDisplay.parentNode !== targetParent) {
                dragBarTimeDisplay.parentNode?.removeChild(dragBarTimeDisplay);
                targetParent.appendChild(dragBarTimeDisplay);
            }

            dragBarTimeDisplay.textContent = formatTime(totalTimeChange);
            dragBarTimeDisplay.style.display = 'block';
            dragBarTimeDisplay.style.opacity = '1';
            isVisible = true;
        };

        const hideTimeDisplay = () => {
            if (!dragBarTimeDisplay || !isVisible) return;
            dragBarTimeDisplay.style.opacity = '0';
            hideTimeout = setTimeout(() => {
                dragBarTimeDisplay.style.display = 'none';
                isVisible = false;
            }, 300);
        };

        const applyTimeChange = () => {
            const medias = mediaFinder.findAll();
            const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
            const timeToApply = Math.round(dragState.totalTimeChange / pixelsPerSecond);
            if (timeToApply !== 0) {
                medias.forEach(media => {
                    if (media && media.duration && isFinite(media.duration)) {
                        const newTime = Math.min(media.duration, Math.max(0, media.currentTime + timeToApply));
                        media.currentTime = newTime;
                    }
                });
            }
        };

        const cancelDrag = () => {
            if (!dragState.isDragging) return;
            try {
                if (dragState.recoveryTimer) {
                    clearTimeout(dragState.recoveryTimer);
                    dragState.recoveryTimer = null;
                }
                hideTimeDisplay();
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                if(document.body) document.body.style.userSelect = '';
                if(document.body) document.body.style.touchAction = '';
                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) {
                logManager.logErrorWithContext(e, null);
            }
        };

        const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;
        const handleStart = (e) => {
            if (!speedSlider || speedSlider.isMinimized() || dragState.isDragging || e.button === 2) return;
            if (e.target && e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;
            const medias = mediaFinder.findAll();
            if (medias.length === 0) return;
            e.stopPropagation();
            dragState.isDragging = true;
            const pos = getPosition(e);
            dragState.startX = pos.clientX;
            dragState.startY = pos.clientY;
            dragState.lastUpdateX = pos.clientX;
            dragState.currentDragDistanceX = 0;
            dragState.totalTimeChange = 0;
            dragState.lastMoveTime = Date.now();
            showTimeDisplay(dragState.totalTimeChange);
            if (dragState.recoveryTimer) clearTimeout(dragState.recoveryTimer);
            dragState.recoveryTimer = setTimeout(cancelDrag, 5000);
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
        };

        const handleMove = (e) => {
            if (!dragState.isDragging) return;
            try {
                if ((e.touches && e.touches.length > 1) || (e.pointerType === 'touch' && e.pointerId > 1)) return cancelDrag();
                const medias = mediaFinder.findAll();
                if (medias.length === 0) return cancelDrag();
                const pos = getPosition(e);
                const currentX = pos.clientX;
                const dx = Math.abs(currentX - dragState.startX);
                if (!dragState.isHorizontalDrag) {
                    const dy = Math.abs(pos.clientY - dragState.startY);
                    if (dx > 10 && dy < dx * 1.5) {
                        dragState.isHorizontalDrag = true;
                        e.preventDefault(); e.stopImmediatePropagation();
                        if(document.body) document.body.style.userSelect = 'none';
                        if(document.body) document.body.style.touchAction = 'none';
                    } else if (dy > 10) {
                        return cancelDrag();
                    }
                }
                if (dragState.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
                    dragState.totalTimeChange = Math.round(dragState.currentDragDistanceX / pixelsPerSecond);
                    showTimeDisplay(dragState.totalTimeChange);
                    dragState.lastUpdateX = currentX;
                }
            } catch(e) {
                logManager.logErrorWithContext(e, e.target);
                cancelDrag();
            }
        };

        const handleEnd = () => {
            if (!dragState.isDragging) return;
            try {
                hideTimeDisplay();
                applyTimeChange();
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                if(document.body) document.body.style.userSelect = '';
                if(document.body) document.body.style.touchAction = '';
                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) {
                logManager.logErrorWithContext(e, null);
                dragState.isDragging = false;
                if(document.body) document.body.style.userSelect = '';
                if(document.body) document.body.style.touchAction = '';
                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', init);
                return;
            }

            dragBarTimeDisplay = document.getElementById('vm-time-display');
            if (!dragBarTimeDisplay) {
                dragBarTimeDisplay = document.createElement('div');
                dragBarTimeDisplay.id = 'vm-time-display';
                Object.assign(dragBarTimeDisplay.style, {
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', background: 'rgba(0, 0, 0, 0.7)',
                    color: 'white', padding: '10px 20px', borderRadius: '5px',
                    fontSize: '1.5rem', zIndex: '2147483647',
                    display: 'none', pointerEvents: 'none', transition: 'opacity 0.3s ease-out',
                    opacity: '1', textAlign: 'center', whiteSpace: 'nowrap'
                });
                document.body.appendChild(dragBarTimeDisplay);
            }
            document.addEventListener('mousedown', handleStart, { passive: false, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: false, capture: true });
            document.addEventListener('mouseout', (e) => { if (e.relatedTarget === null) handleEnd(); }, true);
            document.addEventListener('touchcancel', handleEnd, { passive: false, capture: true });
        };

        return { init, show: showTimeDisplay, hide: hideTimeDisplay, updateTimeDisplay: showTimeDisplay };
    })();

    // --- dynamicMediaUI 모듈 ---
    const dynamicMediaUI = (() => {
      return {
        attach: () => {},
        show: () => {},
        hide: () => {}
      };
    })();

    // --- mediaControls 모듈 ---
    const mediaControls = (() => {
        const observeMediaSources = (media) => {
            if (PROCESSED_NODES.has(media)) return;
            PROCESSED_NODES.add(media);

            const obs = new MutationObserver(() => {
                media.querySelectorAll('source').forEach(srcEl => {
                    if (srcEl.src) {
                        networkMonitor.trackAndAttach(srcEl.src, { element: media });
                    }
                });
            });
            obs.observe(media, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        };

        const updateUIVisibility = throttle(() => {
            const hasMedia = mediaFinder.findAll().some(m => !PREVIEW_ELEMENTS.has(m) && (m.readyState >= 1 || (!m.paused && (m.tagName === 'AUDIO' || (m.clientWidth > 0 && m.clientHeight > 0)))));
            if (hasMedia) {
                if (speedSlider) speedSlider.show();
                if (dragBar && speedSlider && !speedSlider.isMinimized()) dragBar.show(0);
                if (networkMonitor && networkMonitor.VIDEO_URL_CACHE.size > 0) dynamicMediaUI.show([...networkMonitor.VIDEO_URL_CACHE].pop());
            } else {
                if (speedSlider) speedSlider.hide();
                if (dragBar) dragBar.hide();
                if (dynamicMediaUI) dynamicMediaUI.hide();
            }
        }, 500);

        const initWhenReady = (media) => {
            if (!media) return;

            // 미리보기 URL 패턴으로 필터링
            const src = media.currentSrc || media.src || media.dataset.src;
            if (src && networkMonitor.isPreviewURL(src)) {
                PREVIEW_ELEMENTS.add(media);
                logManager.addOnce(`skip_init_by_url_${src}`, `🔴 [Skip:Preview] 미디어 초기화 단계에서 미리보기 URL (${src}) 감지, 초기화 건너뜀`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                return;
            }

            // 미디어 로드 완료 후 길이로 다시 필터링
            media.addEventListener('loadedmetadata', function checkDuration() {
                if (FeatureFlags.previewFiltering && this.duration > 0 && this.duration < PREVIEW_CONFIG.DURATION_THRESHOLD) {
                    PREVIEW_ELEMENTS.add(media);
                    logManager.addOnce(`skip_preview_by_duration_${media.src}`, `🔴 [Skip:Preview] 미디어 로드 완료, 영상 길이가 ${this.duration.toFixed(1)}s 이므로 무시`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                    return;
                }
                this.removeEventListener('loadedmetadata', checkDuration);
            }, { once: true });

            observeMediaSources(media);

            media.addEventListener('play', () => {
                if (PREVIEW_ELEMENTS.has(media)) {
                    PREVIEW_ELEMENTS.delete(media);
                    logManager.addOnce(`promote_from_preview_${media.src}`, `▶️ 미리보기 영상 재생 시작, 정식 미디어로 승격 처리`, 5000, 'info');
                }
                updateUIVisibility();
                logManager.logMediaContext(media, '재생 시작');
            }, true);

            media.addEventListener('pause', () => { updateUIVisibility(); logManager.logMediaContext(media, '일시 정지'); }, true);
            media.addEventListener('ended', () => { updateUIVisibility(); logManager.logMediaContext(media, '종료'); }, true);

            media.addEventListener('loadedmetadata', () => {
                if (!PREVIEW_ELEMENTS.has(media)) {
                    logManager.logMediaContext(media, '미디어 로드 완료', 'info');
                    if (media.src && networkMonitor && networkMonitor.VIDEO_URL_CACHE.has(media.src)) {
                        dynamicMediaUI.show(media.src);
                    }
                    updateUIVisibility();
                }
            }, { once: true });

            if (media.src) networkMonitor.trackAndAttach(media.src, { source: 'Initial media src', element: media });
            dynamicMediaUI.attach(media, src);
        };

        const detachUI = (media) => {
            if (PREVIEW_ELEMENTS.has(media)) {
                PREVIEW_ELEMENTS.delete(media);
            }
            updateUIVisibility();
        };

        return { initWhenReady, detachUI, updateUIVisibility };
    })();

    // --- spaPartialUpdate 모듈 ---
    const spaPartialUpdate = (() => {
        const detectChangedRegion = (doc) => {
            const contentContainers = doc.querySelectorAll('main, div#app, div.page-content');
            if (contentContainers.length > 0) {
                return Array.from(contentContainers).find(c => {
                    const rect = c.getBoundingClientRect();
                    return rect.width * rect.height > window.innerWidth * window.innerHeight * 0.1;
                }) || doc.body;
            }
            return doc.body;
        };

        const partialUpdate = () => {
            logManager.addOnce(`spa_partial_update_start`, `🟢 SPA 부분 업데이트 시작`, 5000, 'info');
            const changedRegion = detectChangedRegion(document);
            if (!changedRegion) {
                App.initializeAll(document);
                return;
            }
            const medias = mediaFinder.findInSubtree(changedRegion);
            medias.forEach(media => {
                if (!PROCESSED_NODES.has(media)) {
                    mediaControls.initWhenReady(media);
                }
            });
            mediaControls.updateUIVisibility();
            logManager.addOnce(
                `spa_partial_update_success`,
                `🟢 SPA 부분 업데이트 완료: 변경 영역 내 미디어 ${medias.length}개 재초기화`,
                5000,
                'info'
            );
        };
        return { partialUpdate };
    })();

    // --- spaMonitor 모듈 ---
    const spaMonitor = (() => {
        let lastURL = location.href;
        let debounceTimer = null;
        const onNavigate = (reason = 'URL 변경 감지') => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const url = location.href;
                if (url !== lastURL) {
                    logManager.logSPANavigation(lastURL, url, reason);
                    lastURL = url;
                    if (FeatureFlags.spaPartialUpdate) {
                        spaPartialUpdate.partialUpdate();
                    } else {
                        logManager.addOnce(`spa_navigate_full_init`, `🔄 전체 페이지 초기화`, 5000, 'warn');
                        PROCESSED_DOCUMENTS = new WeakSet();
                        PROCESSED_NODES = new WeakSet();
                        PROCESSED_IFRAMES = new WeakSet();
                        LOGGED_KEYS_WITH_TIMER.clear();
                        if(jwplayerMonitor) jwplayerMonitor.resetState();
                        OBSERVER_MAP.forEach(observer => observer.disconnect());
                        OBSERVER_MAP.clear();
                        App.initializeAll(document);
                    }
                }
            }, 200);
        };
        const overrideHistoryMethod = (methodName) => {
            const original = history[methodName];
            history[methodName] = function(...args) {
                const result = original.apply(this, args);
                onNavigate(`history.${methodName}`);
                return result;
            };
        };
        const init = () => {
            overrideHistoryMethod('pushState');
            overrideHistoryMethod('replaceState');
            window.addEventListener('popstate', () => onNavigate('popstate'));
        };
        return { init, onNavigate };
    })();

    // --- App 모듈 ---
    const App = (() => {
        const handleIframeLoad = (iframe) => {
            if (!iframe) return;
            let isSameOrigin = false;
            try { if (iframe.contentDocument) isSameOrigin = true; } catch(e) {}
            if (!isSameOrigin) {
                logManager.logIframeContext(iframe, '외부 도메인, 건너뜀');
                return;
            }
            if (PROCESSED_IFRAMES.has(iframe)) return;
            PROCESSED_IFRAMES.add(iframe);
            logManager.logIframeContext(iframe, '초기화 시작');
            let retries = 0;
            const maxRetries = 5;
            let intervalId;
            const tryInit = () => {
                try {
                    const doc = iframe.contentDocument;
                    if (doc && doc.body) {
                        clearInterval(intervalId);
                        initializeAll(doc);
                        logManager.logIframeContext(iframe, '초기화 성공');
                    } else if (++retries >= maxRetries) {
                        clearInterval(intervalId);
                        logManager.logIframeContext(iframe, '초기화 실패 (재시도 초과)');
                    }
                } catch (e) {
                    logManager.logErrorWithContext(e, iframe);
                    if (++retries >= maxRetries) {
                        clearInterval(intervalId);
                        logManager.logIframeContext(iframe, `초기화 오류: ${e.message}`);
                    }
                }
            };
            intervalId = setInterval(tryInit, 1000);
            tryInit();
            try {
                if (iframe.contentWindow && jwplayerMonitor) {
                    jwplayerMonitor.init(iframe.contentWindow);
                }
            } catch (e) { logManager.logErrorWithContext(e, iframe); }
        };

        const scanAndInitMedia = (doc) => {
            const medias = mediaFinder.findInDoc(doc);
            medias.forEach(media => {
                mediaControls.initWhenReady(media);
            });
        };

        const processMutations = (mutations, targetDocument) => {
            mutations.forEach(mutation => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== 1) return;
                        if (node.tagName === 'IFRAME') {
                            handleIframeLoad(node);
                        } else {
                            mediaFinder.findInSubtree(node).forEach(media => mediaControls.initWhenReady(media));
                        }
                    });
                    mutation.removedNodes.forEach(node => {
                        if (node.nodeType === 1 && (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') && mediaControls) {
                            mediaControls.detachUI(node);
                        }
                    });
                } else if (mutation.type === 'attributes') {
                    const targetNode = mutation.target;
                    if (targetNode.nodeType !== 1) return;
                    if (targetNode.tagName === 'IFRAME' && mutation.attributeName === 'src') {
                        PROCESSED_IFRAMES.delete(targetNode);
                        handleIframeLoad(targetNode);
                    }
                    if ((targetNode.tagName === 'VIDEO' || targetNode.tagName === 'AUDIO') && (mutation.attributeName === 'src' || mutation.attributeName === 'data-src')) {
                        if (targetNode.dataset.src && !targetNode.src) {
                             const candidate = targetNode.dataset.src;
                             if (networkMonitor.isPreviewURL(candidate)) {
                                 logManager.addOnce(`skip_assign_data_src_mut`, `⚠️ data-src assignment skipped (preview) | src: ${candidate}`, 5000, PREVIEW_CONFIG.LOG_LEVEL_FOR_SKIP);
                                 return;
                             }
                             targetNode.src = candidate;
                             logManager.addOnce(`data_src_mutation_${candidate}`, `🖼️ DOM 변경 감지, data-src -> src 업데이트: ${candidate}`, 5000, 'info');
                         }
                        mediaControls.initWhenReady(targetNode);
                    }
                }
            });
            mediaControls.updateUIVisibility();
        };

        const startUnifiedObserver = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);
            const rootElement = targetDocument.documentElement || targetDocument.body;
            if (!rootElement) return;
            if (OBSERVER_MAP.has(targetDocument)) {
                OBSERVER_MAP.get(targetDocument).disconnect();
            }
            const observer = new MutationObserver((mutations) => processMutations(mutations, targetDocument));
            observer.observe(rootElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'controls', 'data-src', 'data-video', 'data-url']
            });
            OBSERVER_MAP.set(targetDocument, observer);
            logManager.addOnce('observer_active', `✅ 통합 감시자 활성화 | 대상: ${targetDocument === document ? '메인 프레임' : 'iframe'}`, 5000, 'info');
        };

        const initializeAll = (targetDocument = document) => {
            if (PROCESSED_DOCUMENTS.has(targetDocument)) return;
            PROCESSED_DOCUMENTS.add(targetDocument);

            if (targetDocument === document) {
                logManager.addOnce('script_init_start', `🎉 스크립트 초기화 시작`, 5000, 'info');
                if(spaMonitor) spaMonitor.init();
                if(speedSlider) speedSlider.init();
                if(dragBar) dragBar.init();
                //if(dynamicMediaUI) dynamicMediaUI.init();
                if(jwplayerMonitor) jwplayerMonitor.init(window);
                if(networkMonitor) networkMonitor.init(window);

                document.addEventListener('fullscreenchange', () => {
                    if(speedSlider) speedSlider.updatePositionAndSize();
                    if(dragBar) {
                        const isMediaPlaying = mediaFinder.findAll().some(m => !m.paused);
                        if (isMediaPlaying && !speedSlider.isMinimized()) {
                            dragBar.show(0);
                        } else {
                            dragBar.hide();
                        }
                    }
                });
            } else {
                try {
                    if(networkMonitor) networkMonitor.init(targetDocument.defaultView);
                } catch {}
            }
            startUnifiedObserver(targetDocument);
            scanAndInitMedia(targetDocument);
            targetDocument.querySelectorAll('iframe').forEach(iframe => handleIframeLoad(iframe));
            mediaControls.updateUIVisibility();
        };
        return { initializeAll };
    })();

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        logManager.init();
        App.initializeAll(document);
    } else {
        window.addEventListener('DOMContentLoaded', () => {
            logManager.init();
            App.initializeAll(document);
        });
    }
})();
