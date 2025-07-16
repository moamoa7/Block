// ==UserScript==
// @name Video Controller Popup (V4.10.60: Amplification Block Update)
// @namespace Violentmonkey Scripts
// @version 4.10.60_AmpBlockUpdate_Minified_Circular
// @description Optimized video controls with robust popup initialization on video selection, consistent state management during dragging, enhanced scroll handling, improved mobile click recognition, fixed ReferenceError, dynamically blocks amplification based on video src, and increased max playback rate to 16x. Now features a circular icon that expands into the full UI.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
'use strict';
let videos = [], currentVideo = null, popupElement = null, circularIconElement = null,
desiredPlaybackRate = 1.0, desiredVolume = 1.0,
isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
let isManuallyPaused = false;
const videoRateHandlers = new WeakMap();
let popupHideTimer = null;
let circularIconHideTimer = null;
const POPUP_TIMEOUT_MS = 2000;
const CIRCULAR_ICON_TIMEOUT_MS = 2000;
// SITES_FOR_INITIAL_X_ICON: 팝업 UI는 여전히 기능하며, 원형 아이콘만 초기 'X'로 표시됩니다.
const SITES_FOR_INITIAL_X_ICON = ['ppomppu.co.kr', 'reddit.com'];
// isInitialPopupBlocked는 이제 아이콘의 초기 텍스트를 결정하는 데에만 사용됩니다.
const isInitialPopupBlocked = SITES_FOR_INITIAL_X_ICON.some(site => location.hostname.includes(site));
const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));

const isAmplificationBlocked_SRC_LIST = [
    'youtube.com',
    'avsee.ru',
    'fmkorea.com',
    'inven.co.kr',
    'mlbpark.donga.com',
    'etoland.co.kr',
    'ppomppu.co.kr',
    'damoang.net',
    'theqoo.net',
    'ruliweb.com',
    // 'video.twimg.com', // 제거됨
    'twitter.com',
    'x.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'humoruniv.com',
    'slrclub.com',
    'ygosu.com', // 추가됨
    'dcinside.com' // 추가됨
];

let audioCtx = null, gainNode = null, connectedVideo = null;

let ignorePopupEvents = false;
const IGNORE_EVENTS_DURATION = 100;

function isVideoAmplificationBlocked(video) {
    if (!video) return false;
    const videoSrc = (video.currentSrc || video.src || '').toLowerCase();
    const hostname = location.hostname.toLowerCase();
    
    return isAmplificationBlocked_SRC_LIST.some(blockedSrc => 
        videoSrc.includes(blockedSrc) || hostname.includes(blockedSrc)
    );
}

function findAllVideosDeep(root = document) {
const videoElements = new Set();
root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));
root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) findAllVideosDeep(el.shadowRoot).forEach(v => videoElements.add(v)); });
return Array.from(videoElements);
}

function findPlayableVideos() {
const found = findAllVideosDeep();
if (!isLazySrcBlockedSite) found.forEach(v => { if (!v.src && v.dataset && v.dataset.src) v.src = v.dataset.src; });
const playableVideos = found.filter(v => {
const style = window.getComputedStyle(v);
const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
const rect = v.getBoundingClientRect();
const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
return isVisible && isReasonableSize && hasMedia;
});
videos = playableVideos;
return playableVideos;
}

function calculateCenterDistanceScore(video, intersectionRatio) {
const rect = video.getBoundingClientRect();
const viewportHeight = window.innerHeight;
const videoCenterY = rect.top + (rect.height / 2);
const viewportCenterY = viewportHeight / 2;
const distance = Math.abs(videoCenterY - viewportCenterY);
const normalizedDistance = distance / viewportHeight;
const score = intersectionRatio - normalizedDistance;
return score;
}

function calculateIntersectionRatio(video) {
const rect = video.getBoundingClientRect();
const viewportHeight = window.innerHeight, viewportWidth = window.innerWidth;
const intersectionTop = Math.max(0, rect.top);
const intersectionBottom = Math.min(viewportHeight, rect.bottom);
const intersectionLeft = Math.max(0, rect.left);
const intersectionRight = Math.min(viewportWidth, rect.right);
const intersectionHeight = intersectionBottom - intersectionTop;
const intersectionWidth = intersectionRight - intersectionLeft;
const intersectionArea = Math.max(0, intersectionWidth) * Math.max(0, intersectionHeight);
const videoArea = rect.width * rect.height;
return videoArea > 0 ? intersectionArea / videoArea : 0;
}

function checkCurrentVideoVisibility() {
if (!currentVideo) return false;
const rect = currentVideo.getBoundingClientRect();
const style = window.getComputedStyle(currentVideo);
const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || currentVideo.tagName === 'AUDIO' || !currentVideo.paused;
const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO';
return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
}

function selectAndControlVideo(videoToControl) {
if (!videoToControl) {
if (currentVideo) { currentVideo.pause(); currentVideo = null; hideAllPopups(); }
return;
}
videos.forEach(video => {
if (video !== videoToControl && !video.paused) {
video.pause();
}
});
currentVideo = videoToControl;
currentVideo.autoplay = true;
currentVideo.playsInline = true;
currentVideo.muted = false;
console.log('[VCP] Video selected automatically based on prominence. Resetting controls.');
fixPlaybackRate(currentVideo, 1.0);
setAmplifiedVolume(currentVideo, 1.0);
isManuallyPaused = false;
currentVideo.play().catch(e => console.warn("Autoplay/Play on select failed:", e));
updatePopupSliders();
showCircularIcon();
}

function fixPlaybackRate(video, rate) {
if (!video || typeof video.playbackRate === 'undefined') return;
desiredPlaybackRate = rate;
const existingHandler = videoRateHandlers.get(video);
if (existingHandler) video.removeEventListener('ratechange', existingHandler);
const rateChangeHandler = () => {
if (video.playbackRate !== desiredPlaybackRate) video.playbackRate = desiredPlaybackRate;
};
video.playbackRate = rate;
video.addEventListener('ratechange', rateChangeHandler);
videoRateHandlers.set(video, rateChangeHandler);
}

function setupAudioContext(video) {
if (isVideoAmplificationBlocked(video) || !video) return false;
try {
if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
if (audioCtx.state === 'suspended') audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
if (video._audioSourceNode) video._audioSourceNode.disconnect();
if (gainNode) gainNode.disconnect();
video._audioSourceNode = audioCtx.createMediaElementSource(video);
gainNode = audioCtx.createGain();
gainNode.connect(audioCtx.destination);
video.volume = 1.0;
video.muted = false;
connectedVideo = video;
return true;
} catch (e) {
console.error("Failed to setup AudioContext for amplification:", e);
audioCtx = gainNode = connectedVideo = null;
return false;
}
}

function setAmplifiedVolume(video, vol) {
if (!video || typeof video.volume === 'undefined') return;
desiredVolume = vol;
video.muted = false;

if (isVideoAmplificationBlocked(video)) {
    if (video._audioSourceNode) {
        video._audioSourceNode.disconnect();
        video._audioSourceNode = null;
    }
    if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
    }
    if (audioCtx) {
        if (audioCtx.state !== 'closed') audioCtx.close();
        audioCtx = null;
    }
    connectedVideo = null;

    video.volume = Math.min(vol, 1.0);
    desiredVolume = video.volume;

    return;
}

if (vol <= 1) {
    if (gainNode && connectedVideo === video) {
        gainNode.gain.value = 1;
    } else if (audioCtx && audioCtx.state !== 'closed') {
        if (gainNode) gainNode.disconnect();
        if (video._audioSourceNode) video._audioSourceNode.disconnect();
        audioCtx.close();
        audioCtx = gainNode = connectedVideo = null;
    }
    video.volume = vol;
} else {
    if (!audioCtx || connectedVideo !== video || !gainNode) {
        if (!setupAudioContext(video)) {
            video.volume = 1;
            return;
        }
    }
    if (gainNode) {
        video.volume = 1;
        gainNode.gain.value = vol;
    }
}
}

function createCircularIconElement() {
if (circularIconElement) return;
circularIconElement = document.createElement('div');
circularIconElement.id = 'video-controller-circular-icon';
circularIconElement.style.cssText = `position:fixed;width:40px;height:40px;background:rgba(30,30,30,0.9);border:1px solid #444;border-radius:50%;display:flex;justify-content:center;align-items:center;color:white !important;font-size:20px;cursor:pointer;z-index:2147483647;opacity:0;transition:opacity 0.3s;box-shadow:0 2px 8px rgba(0,0,0,0.5);user-select:none;`;
// isInitialPopupBlocked는 이제 아이콘의 초기 텍스트만 결정합니다.
circularIconElement.textContent = isInitialPopupBlocked ? 'X' : '▶';
document.body.appendChild(circularIconElement);
circularIconElement.addEventListener('click', (e) => {
    e.stopPropagation();
    hideCircularIcon(false);
    showPopupTemporarily();
});
circularIconElement.addEventListener('mouseenter', () => resetCircularIconHideTimer(false));
circularIconElement.addEventListener('mouseleave', () => resetCircularIconHideTimer(true));
circularIconElement.addEventListener('touchend', e => {
    e.stopPropagation();
    resetCircularIconHideTimer(false);
    showPopupTemporarily();
});
}

function createPopupElement() {
if (popupElement) return;
popupElement = document.createElement('div');
popupElement.id = 'video-controller-popup';
popupElement.style.cssText = `position:fixed;background:rgba(30,30,30,0.9);border:1px solid #444;border-radius:8px;padding:0;color:white !important;font-family:sans-serif;z-index:2147483647;display:none;opacity:0;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.5);width:230px;overflow:hidden;text-align:center;pointer-events:auto;user-select:none;`;
const dragHandle = document.createElement('div');
dragHandle.id = 'vcp-drag-handle';
dragHandle.textContent = '비디오.오디오 컨트롤러';
dragHandle.style.cssText = `font-weight:bold;margin-bottom:8px;color:#aaa !important;padding:5px;background-color:#2a2a2a;border-bottom:1px solid #444;cursor:grab;border-radius:6px 6px 0 0;user-select:none;`;
popupElement.appendChild(dragHandle);
const contentContainer = document.createElement('div');
contentContainer.style.cssText = 'padding:10px;';
const commonBtnStyle = `background-color:#333;color:white !important;border:1px solid #555;padding:5px 10px;border-radius:4px;cursor:pointer;transition:background-color 0.2s;white-space:nowrap;min-width:80px;text-align:center;user-select:none;`;
const buttonSection = document.createElement('div');
buttonSection.style.cssText = 'display:flex;gap:5px;justify-content:center;align-items:center;margin-bottom:10px;';
const playPauseBtn = document.createElement('button');
playPauseBtn.setAttribute('data-action', 'play-pause');
playPauseBtn.textContent = '재생/멈춤';
playPauseBtn.style.cssText = commonBtnStyle;
const resetBtn = document.createElement('button');
resetBtn.setAttribute('data-action', 'reset-speed-volume');
resetBtn.textContent = '재설정';
resetBtn.style.cssText = commonBtnStyle;
buttonSection.appendChild(playPauseBtn);
buttonSection.appendChild(resetBtn);
contentContainer.appendChild(buttonSection);
const speedSection = document.createElement('div');
speedSection.className = 'vcp-section';
speedSection.style.marginBottom = '10px';
const speedLabel = document.createElement('label');
speedLabel.htmlFor = 'vcp-speed';
speedLabel.style.cssText = 'display:block;margin-bottom:5px;color:white !important;';
const speedDisplay = document.createElement('span');
speedDisplay.id = 'vcp-speed-display';
speedDisplay.textContent = '1.00';
speedLabel.textContent = '배속 조절: ';
speedLabel.appendChild(speedDisplay);
speedLabel.appendChild(document.createTextNode('x'));
const speedInput = document.createElement('input');
speedInput.type = 'range';
speedInput.id = 'vcp-speed';
speedInput.min = '0.0';
speedInput.max = '16.0';
speedInput.step = '0.1';
speedInput.value = '1.0';
speedInput.style.cssText = 'width:100%;cursor:pointer;';
speedSection.appendChild(speedLabel);
speedSection.appendChild(speedInput);
contentContainer.appendChild(speedSection);
const volumeSection = document.createElement('div');
volumeSection.className = 'vcp-section';
volumeSection.style.marginBottom = '10px';
const volumeLabel = document.createElement('label');
volumeLabel.htmlFor = 'vcp-volume';
volumeLabel.style.cssText = 'display:block;margin-bottom:5px;color:white !important;';
const volumeDisplay = document.createElement('span');
volumeDisplay.id = 'vcp-volume-display';
volumeDisplay.textContent = '100';
volumeLabel.textContent = '소리 조절: ';
volumeLabel.appendChild(volumeDisplay);
volumeLabel.appendChild(document.createTextNode('%'));
const volumeInput = document.createElement('input');
volumeInput.type = 'range';
volumeInput.id = 'vcp-volume';
volumeInput.min = '0.0';
const isCurrentHostBlocked = isAmplificationBlocked_SRC_LIST.some(site => location.hostname.includes(site));
volumeInput.max = isCurrentHostBlocked ? '1.0' : '5.0';
volumeInput.step = '0.1';
volumeInput.value = '1.0';
volumeInput.style.cssText = 'width:100%;cursor:pointer;';
volumeSection.appendChild(volumeLabel);
volumeSection.appendChild(volumeInput);
contentContainer.appendChild(volumeSection);
const modeSection = document.createElement('div');
modeSection.className = 'vcp-section';
modeSection.style.marginBottom = '10px';
const pipBtn = document.createElement('button');
pipBtn.setAttribute('data-action', 'pip');
pipBtn.textContent = 'PIP 모드';
pipBtn.style.cssText = `${commonBtnStyle}margin-top:5px;`;
const exitFullscreenBtn = document.createElement('button');
exitFullscreenBtn.setAttribute('data-action', 'exit-fullscreen');
exitFullscreenBtn.textContent = '전체 종료';
exitFullscreenBtn.style.cssText = `${commonBtnStyle}margin-top:5px;`;
modeSection.appendChild(pipBtn);
modeSection.appendChild(exitFullscreenBtn);
contentContainer.appendChild(modeSection);
const statusElement = document.createElement('div');
statusElement.id = 'vcp-status';
statusElement.textContent = 'Status:Ready';
statusElement.style.cssText = 'margin-top:10px;font-size:12px;color:#777 !important;';
contentContainer.appendChild(statusElement);
popupElement.appendChild(contentContainer);
document.body.appendChild(popupElement);
setupPopupEventListeners();
}

function handleButtonClick(action) {
if (!currentVideo) { updateStatus('No video selected.'); return; }
resetPopupHideTimer(true);

switch (action) {
case 'play-pause':
if (currentVideo.paused) {
isManuallyPaused = false;
currentVideo.muted = false;
currentVideo.play().catch(e => console.error("Play failed:", e));
updateStatus('Playing');
} else {
isManuallyPaused = true;
currentVideo.pause();
updateStatus('Paused');
}
break;
case 'reset-speed-volume':
desiredPlaybackRate = 1.0;
fixPlaybackRate(currentVideo, 1.0);
setAmplifiedVolume(currentVideo, 1.0);
currentVideo.muted = false;
updatePopupSliders();
updateStatus('1.0x Speed / 100% Volume');
break;
case 'pip':
if (document.pictureInPictureEnabled && currentVideo.requestPictureInPicture) {
(document.pictureInPictureElement ? document.exitPictureInPicture() : currentVideo.requestPictureInPicture()).catch(e => console.error(e));
updateStatus(document.pictureInPictureElement ? 'Exiting PIP' : 'Entering PIP');
}
break;
case 'exit-fullscreen':
if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
break;
}
}

function setupPopupEventListeners() {
if (!popupElement) return;

popupElement.addEventListener('click', e => {
    if (ignorePopupEvents) { e.stopPropagation(); return; }
    const action = e.target.getAttribute('data-action');
    if (action) handleButtonClick(action);
    else if (e.target.tagName !== 'INPUT') {
        resetPopupHideTimer(true);
    }
}, true);

popupElement.addEventListener('touchend', e => {
    if (ignorePopupEvents) { e.stopPropagation(); return; }
    if (e.target.tagName !== 'INPUT') {
        resetPopupHideTimer(true);
    }
}, true);

const speedInput = popupElement.querySelector('#vcp-speed');
const speedDisplay = popupElement.querySelector('#vcp-speed-display');
speedInput.addEventListener('input', () => {
    if (ignorePopupEvents) { return; }
    resetPopupHideTimer(false);
    const rate = parseFloat(speedInput.value);
    desiredPlaybackRate = rate;
    speedDisplay.textContent = rate.toFixed(2);
    if (currentVideo) { fixPlaybackRate(currentVideo, rate); updateStatus(`Speed: ${rate.toFixed(2)}x`); }
});

const volumeInput = popupElement.querySelector('#vcp-volume');
const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
volumeInput.addEventListener('input', () => {
    if (ignorePopupEvents) return;

    resetPopupHideTimer(false);

    if (currentVideo && isVideoAmplificationBlocked(currentVideo)) {
        volumeInput.max = '1.0';
    } else {
        volumeInput.max = '5.0';
    }

    let vol = parseFloat(volumeInput.value);
    vol = Math.min(vol, parseFloat(volumeInput.max));

    desiredVolume = vol;
    volumeDisplay.textContent = Math.round(vol * 100);

    if (currentVideo) {
        setAmplifiedVolume(currentVideo, vol);
        updateStatus(`Volume: ${Math.round(vol * 100)}%`);
    }
});

const dragHandle = popupElement.querySelector('#vcp-drag-handle');
const startDrag = e => {
if (ignorePopupEvents) { e.stopPropagation(); return; }
if (e.target !== dragHandle) return;
resetPopupHideTimer(false);
isPopupDragging = true;
dragHandle.style.cursor = 'grabbing';
const clientX = e.clientX || (e.touches && e.touches[0].clientX);
const clientY = e.clientY || (e.touches && e.touches[0].clientY);
const rect = popupElement.getBoundingClientRect();
popupDragOffsetX = clientX - rect.left;
popupDragOffsetY = clientY - rect.top;
popupElement.style.position = 'fixed';
popupElement.style.transform = 'none';
document.body.style.userSelect = 'none';
};
const stopDrag = () => {
if (isPopupDragging) {
isPopupDragging = false;
dragHandle.style.cursor = 'grab';
document.body.style.userSelect = '';
resetPopupHideTimer(true);
}
};
const dragPopup = e => {
if (!isPopupDragging) return;
const clientX = e.clientX || (e.touches && e.touches[0].clientX);
const clientY = e.clientY || (e.touches && e.touches[0].clientY);
if (clientX === undefined || clientY === undefined) return;
popupElement.style.left = `${clientX - popupDragOffsetX}px`;
popupElement.style.top = `${clientY - popupDragOffsetY}px`;
};
dragHandle.addEventListener('mousedown', startDrag);
dragHandle.addEventListener('touchstart', startDrag);
document.addEventListener('mousemove', dragPopup);
document.addEventListener('touchmove', dragPopup);
document.addEventListener('mouseup', stopDrag);
document.addEventListener('touchend', stopDrag);
document.addEventListener('mouseleave', stopDrag);
popupElement.addEventListener('mouseleave', () => {if (!isPopupDragging){resetPopupHideTimer(true);}});
popupElement.addEventListener('mouseenter', () => resetPopupHideTimer(false));
popupElement.addEventListener('touchend', e => {
    e.stopPropagation();
    resetPopupHideTimer(true);
});
}

function updateStatus(message) {
const statusElement = popupElement.querySelector('#vcp-status');
if (statusElement) {
statusElement.textContent = `Status:${message}`;
statusElement.style.opacity = 0.75;
setTimeout(() => statusElement.style.opacity = 0, 2000);
}
}

function setPopupVisibility(isVisible) {
if (!popupElement) return;
if (isVisible) {
const styles = {display:'block',opacity:'0.75',visibility:'visible',pointerEvents:'auto',zIndex:'2147483647'};
for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
    ignorePopupEvents = true;
    setTimeout(() => {
        ignorePopupEvents = false;
    }, IGNORE_EVENTS_DURATION);
} else {
// SITES_FOR_INITIAL_X_ICON 여부와 상관없이 팝업을 숨깁니다.
popupElement.style.display = 'none';
popupElement.style.opacity = '0';
popupElement.style.visibility = 'hidden';
}
}

function setCircularIconVisibility(isVisible) {
if (!circularIconElement) return;
if (isVisible) {
circularIconElement.style.setProperty('display', 'flex', 'important');
circularIconElement.style.setProperty('opacity', '0.75', 'important');
circularIconElement.style.setProperty('pointer-events', 'auto', 'important');
} else {
circularIconElement.style.setProperty('display', 'none', 'important');
circularIconElement.style.setProperty('opacity', '0', 'important');
circularIconElement.style.setProperty('pointer-events', 'none', 'important');
}
}

function showPopup() {
if (!currentVideo) {hideAllPopups();return;}
setPopupVisibility(true);
setCircularIconVisibility(false);
resetCircularIconHideTimer(false);
}

function hidePopup() {
setPopupVisibility(false);
resetPopupHideTimer(false);
}

function showCircularIcon() {
if (!currentVideo) {hideAllPopups();return;}
setCircularIconVisibility(true);
setPopupVisibility(false); // 팝업은 숨기고 아이콘만 표시
updatePopupPosition(circularIconElement, currentVideo);
resetCircularIconHideTimer(true);
}

function hideCircularIcon(startNewTimer = true) {
setCircularIconVisibility(false);
if (startNewTimer) {
resetCircularIconHideTimer(true);
} else {
resetCircularIconHideTimer(false);
}
}

function hideAllPopups() {
hidePopup();
hideCircularIcon(false);
}

function resetCircularIconHideTimer(startTimer = true) {
if (circularIconHideTimer) clearTimeout(circularIconHideTimer);
if (startTimer) {
circularIconHideTimer = setTimeout(() => {
hideCircularIcon(false);
}, CIRCULAR_ICON_TIMEOUT_MS);
}
}

function resetPopupHideTimer(startTimer = true) {
if (popupHideTimer) clearTimeout(popupHideTimer);
if (startTimer && !isPopupDragging) {
popupHideTimer = setTimeout(() => {
hidePopup();
}, POPUP_TIMEOUT_MS);
}
}

function showPopupTemporarily() {
if (!currentVideo) {hideAllPopups();return;}
if (popupElement && currentVideo) {
hideCircularIcon(false);
showPopup();
updatePopupPosition(popupElement, currentVideo);
updatePopupSliders();
resetPopupHideTimer(true);
}
}

function updatePopupPosition(elementToPosition, video) {
if (!elementToPosition || !video || isPopupDragging) {
return;
}
const videoRect = video.getBoundingClientRect();
const elementRect = elementToPosition.getBoundingClientRect();
const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;
if (isVideoVisible) {
const viewportX = videoRect.left + (videoRect.width / 2) - (elementRect.width / 2);
const viewportY = videoRect.top + (videoRect.height / 2) - (elementRect.height / 2);
const safeX = Math.max(0, Math.min(viewportX, window.innerWidth - elementRect.width));
const safeY = Math.max(0, Math.min(viewportY, window.innerHeight - elementRect.height));
elementToPosition.style.setProperty('left', `${safeX}px`, 'important');
elementToPosition.style.setProperty('top', `${safeY}px`, 'important');
elementToPosition.style.setProperty('transform', 'none', 'important');
elementToPosition.style.setProperty('position', 'fixed', 'important');
} else {
hideAllPopups();
}
}

function updatePopupSliders() {
if (!popupElement || !currentVideo) return;

const speedInput = popupElement.querySelector('#vcp-speed');
const speedDisplay = popupElement.querySelector('#vcp-speed-display');
const volumeInput = popupElement.querySelector('#vcp-volume');
const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

if (speedInput && speedDisplay) {
    const rate = desiredPlaybackRate;
    speedInput.value = rate.toFixed(2);
    speedDisplay.textContent = rate.toFixed(2);
}

if (volumeInput && volumeDisplay) {
    if (isVideoAmplificationBlocked(currentVideo)) {
        volumeInput.max = '1.0';
    } else {
        volumeInput.max = '5.0';
    }

    let volume = desiredVolume;
    volume = Math.min(volume, parseFloat(volumeInput.max));

    if (!isVideoAmplificationBlocked(currentVideo) && gainNode && connectedVideo === currentVideo) {
        volume = gainNode.gain.value;
    }

    volumeInput.value = volume.toFixed(1);
    volumeDisplay.textContent = Math.round(volume * 100);
}
}

function selectVideoOnDocumentClick(e) {
    if (e && e.target) {
        if ((popupElement && popupElement.contains(e.target)) || (circularIconElement && circularIconElement.contains(e.target))) {
            return;
        }
    }

    updateVideoList(); 
    let bestVideo = null;
    let maxScore = -Infinity;
    videos.forEach(video => {const ratio = calculateIntersectionRatio(video);const score = calculateCenterDistanceScore(video, ratio);if (ratio > 0 && score > maxScore) {maxScore = score;bestVideo = video;}});
    if (bestVideo && maxScore > -0.5) {
        if (currentVideo && currentVideo !== bestVideo) {
            console.log('[VCP] Switching video. Hiding previous popup.');
            currentVideo.pause();hideAllPopups();currentVideo = null;
        }
        if (currentVideo === bestVideo) {
            if (popupElement.style.display === 'none') {
                showCircularIcon();
            } else {
                resetPopupHideTimer(true);
            }
        } else {
            selectAndControlVideo(bestVideo);
        }
    } else {
        if (currentVideo) {
            currentVideo.pause();
        }
        currentVideo = null;
        if (!isPopupDragging) {
            hideAllPopups();
        }
    }
}

let scrollTimeout = null;
function handleScrollEvent() {
if (scrollTimeout) clearTimeout(scrollTimeout);
scrollTimeout = setTimeout(() => {
updateVideoList();
if (currentVideo && !checkCurrentVideoVisibility()) {
console.log('[VCP] Current video scrolled out of view or became invalid. Resetting.');
currentVideo.pause();
currentVideo = null;
if (!isPopupDragging) {
hideAllPopups();
}
}
if (!currentVideo || (popupElement && popupElement.style.display === 'none' && circularIconElement && circularIconElement.style.display === 'none')) {
selectVideoOnDocumentClick(null);
} else if (currentVideo) {
if (popupElement.style.display !== 'none') {
updatePopupPosition(popupElement, currentVideo);
resetPopupHideTimer(true);
} else if (circularIconElement.style.display !== 'none') {
updatePopupPosition(circularIconElement, currentVideo);
resetCircularIconHideTimer(true);
}
}
}, 100);
}

function updateVideoList() {
findPlayableVideos();
if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
console.log('[VCP] Current video no longer valid. Resetting.');
currentVideo = null;
hideAllPopups();
}
}

function setupDOMObserver() {
const observerConfig = { childList: true, subtree: true, attributes: true };
const observerCallback = mutationsList => {
let foundMediaChange = false;
for (const mutation of mutationsList) {
if (mutation.type === 'childList' && (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'))) {
foundMediaChange = true;
break;
} else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
foundMediaChange = true;
break;
}
}
if (foundMediaChange) {
updateVideoList();
}
};
const mutationObserver = new MutationObserver(observerCallback);
mutationObserver.observe(document.body, observerConfig);
}

function setupSPADetection() {
let lastUrl = location.href;
new MutationObserver(() => {
const currentUrl = location.href;
if (currentUrl !== lastUrl) {
console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting popup state.`);
lastUrl = currentUrl;
currentVideo = null;
hideAllPopups();
updateVideoList();
}
}).observe(document, { subtree: true, childList: true });
}

function fixOverflow() {
const overflowFixSites = [
{ domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
];
overflowFixSites.forEach(site => {
if (location.hostname.includes(site.domain)) {
site.selectors.forEach(sel => {
document.querySelectorAll(sel).forEach(el => {
el.style.overflow = 'visible';
});
});
}
});
}

function initialize() {
if (isInitialized) return;
isInitialized = true;
console.log('[VCP] Video Controller Popup script initialized. Version 4.10.60_AmpBlockUpdate_Minified_Circular');
createPopupElement();
createCircularIconElement();
hideAllPopups();

// isInitialPopupBlocked는 이제 아이콘의 초기 텍스트만 설정합니다.
if (isInitialPopupBlocked && circularIconElement) {
    circularIconElement.textContent = 'X';
}

document.addEventListener('fullscreenchange', () => {
const fsEl = document.fullscreenElement;
if (popupElement && circularIconElement) {
if (fsEl) {
fsEl.appendChild(popupElement);
fsEl.appendChild(circularIconElement);
if (popupElement.style.display !== 'none' || isPopupDragging) {
showPopup();
} else {
showCircularIcon();
}
} else {
document.body.appendChild(popupElement);
document.body.appendChild(circularIconElement);
if (popupElement.style.display !== 'none' || isPopupDragging) {
showPopup();
} else {
showCircularIcon();
}
}
}
});
window.addEventListener('resize', () => {
if (popupElement.style.display !== 'none') {
updatePopupPosition(popupElement, currentVideo);
} else if (circularIconElement.style.display !== 'none') {
updatePopupPosition(circularIconElement, currentVideo);
}
});
window.addEventListener('scroll', handleScrollEvent);
updateVideoList();
setupDOMObserver();
setupSPADetection();
fixOverflow();
document.body.addEventListener('click', selectVideoOnDocumentClick, true);
document.body.addEventListener('touchend', selectVideoOnDocumentClick, true);
window.addEventListener('beforeunload', () => {
console.log('[VCP] Page unloading. Clearing current video and removing popup.');
currentVideo = null;
if (popupElement && popupElement.parentNode) {
popupElement.parentNode.removeChild(popupElement);
popupElement = null;
}
if (circularIconElement && circularIconElement.parentNode) {
circularIconElement.parentNode.removeChild(circularIconElement);
circularIconElement = null;
}
});
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
initialize();
} else {
window.addEventListener('DOMContentLoaded', initialize);
}
})();
