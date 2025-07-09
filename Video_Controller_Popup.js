// ==UserScript==
// @name         Video Controller Popup (Fixed Bottom Center to Video)
// @namespace    Violentmonkey Scripts
// @version      2.1
// @description  모든 영상에 영상 화면 하단 중앙 고정 팝업 + 앞뒤 이동 + 배속 + PIP + iframe 대응 + 안정화 (PLAY/STOP & 전체화면 제거)
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

    // 화면 고정: 영상 하단 중앙 (fixed)
    popup.style.position = 'fixed';
    popup.style.transform = 'translateX(-50%)';

    // 공통 스타일
    popup.style.background = 'rgba(0,0,0,5)';
    popup.style.color = '#fff';
    popup.style.padding = '2px';
    popup.style.borderRadius = '4px';
    popup.style.zIndex = 9999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'nowrap';
    popup.style.overflowX = 'auto';
    popup.style.gap = '4px';

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
      btn.style.padding = '4px 6px';
      btn.style.opacity = '1';
      btn.style.transition = 'opacity 0.3s ease';
      btn.style.border = '1px solid #fff';
      btn.style.borderRadius = '3px';
      btn.style.backgroundColor = 'rgba(0,0,0,0.5)';
      btn.style.color = '#fff';
      btn.style.cursor = 'pointer';
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
    popup.querySelector('#back5').onclick = () => { video.currentTime -= 5; };
    popup.querySelector('#back300').onclick = () => { video.currentTime -= 300; };
    popup.querySelector('#forward5').onclick = () => { video.currentTime += 5; };
    popup.querySelector('#forward300').onclick = () => { video.currentTime += 300; };

    // PIP
    popup.querySelector('#pip').onclick = async () => {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    };

    // 위치 업데이트: 항상 영상 하단 중앙
    function updatePopupPosition() {
      const rect = video.getBoundingClientRect();
      popup.style.top = `${rect.bottom + window.scrollY - 30}px`; // 간격 조절
      popup.style.left = `${rect.left + window.scrollX + rect.width / 2}px`;
    }
    updatePopupPosition();
    window.addEventListener('scroll', updatePopupPosition);
    window.addEventListener('resize', updatePopupPosition);
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
