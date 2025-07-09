// ==UserScript==
// @name         Video Controller Popup (Fixed Bottom Center Always Visible)
// @namespace    Violentmonkey Scripts
// @version      2.2
// @description  영상 상관없이 화면 하단 중앙에 고정 팝업 + 앞뒤 이동 + 배속 + PIP + iframe 대응 (스크롤 따라다님)
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  function findPlayableVideo() {
    const videos = [...document.querySelectorAll('video')];
    for (const video of videos) {
      const isHidden = video.classList.contains('hidden') || video.offsetParent === null;
      const hasSrc = !!video.currentSrc || !!video.src;
      if (!isHidden && hasSrc) {
        return video;
      }
    }
    return null;
  }

  function createPopup(video) {
    if (document.getElementById('video-controller-popup')) return;

    const popup = document.createElement('div');
    popup.id = 'video-controller-popup';

    // 화면 고정: 브라우저 뷰포트 하단 중앙 (fixed)
    popup.style.position = 'fixed';
    popup.style.bottom = '5px';
    popup.style.left = '50%';
    popup.style.transform = 'translateX(-50%)';

    // 공통 스타일
    popup.style.background = 'rgba(0,0,0,0.6)';
    popup.style.color = '#fff';
    popup.style.padding = '6px 10px';
    popup.style.borderRadius = '6px';
    popup.style.zIndex = 999999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'nowrap';
    popup.style.gap = '6px';
    popup.style.boxShadow = '0 0 10px rgba(0,0,0,0.7)';

    popup.innerHTML = `
      <button id="speedSlow">0.25x</button>
      <button id="speedNormal">1.00x</button>
      <button id="back300">《《5m</button>
      <button id="back5">《《5s</button>
      <button id="forward5">5s》》</button>
      <button id="forward300">5m》》</button>
      <button id="pip">PIP</button>
    `;

    document.body.appendChild(popup);

    // 버튼 스타일
    popup.querySelectorAll('button').forEach(btn => {
      btn.style.fontSize = '14px';
      btn.style.padding = '4px 8px';
      btn.style.opacity = '1';
      btn.style.transition = 'opacity 0.3s ease';
      btn.style.border = '1px solid #fff';
      btn.style.borderRadius = '4px';
      btn.style.backgroundColor = 'rgba(0,0,0,0.7)';
      btn.style.color = '#fff';
      btn.style.cursor = 'pointer';
      btn.style.userSelect = 'none';
    });

    popup.addEventListener('mouseenter', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
    });

    popup.addEventListener('mouseleave', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
    });

    // 재생 속도 고정
    let currentIntervalId = null;
    function fixPlaybackRate(video, rate) {
      video.playbackRate = rate;
      const intervalId = setInterval(() => {
        if (video.playbackRate !== rate) {
          video.playbackRate = rate;
        }
      }, 250);
      return intervalId;
    }

    popup.querySelector('#speedSlow').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 0.25);
    };
    popup.querySelector('#speedNormal').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 1.0);
    };

    // 앞뒤 이동
    popup.querySelector('#back5').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 5); };
    popup.querySelector('#back300').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 300); };
    popup.querySelector('#forward5').onclick = () => { video.currentTime = Math.min(video.duration, video.currentTime + 5); };
    popup.querySelector('#forward300').onclick = () => { video.currentTime = Math.min(video.duration, video.currentTime + 300); };

    // PIP
    popup.querySelector('#pip').onclick = async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (e) {
        alert('PIP 모드를 지원하지 않는 브라우저이거나 현재 동작할 수 없습니다.');
      }
    };
  }

  function init() {
    const video = findPlayableVideo();
    if (video) {
      createPopup(video);
    }
  }

  init();

  const mo = new MutationObserver(() => {
    if (!document.getElementById('video-controller-popup')) {
      init();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

})();
