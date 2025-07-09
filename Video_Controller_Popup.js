// ==UserScript==
// @name         Video Controller Popup (Fixed Bottom Center to Video)
// @namespace    Violentmonkey Scripts
// @version      1.9
// @description  모든 영상에 영상 화면 하단 중앙 고정 팝업 + 앞뒤 이동 + 배속 + PIP + 전체화면 + iframe 대응
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

    // ★ 화면 고정 위치 설정: 영상 화면 하단 중앙
    popup.style.position = 'fixed';
    popup.style.transform = 'translateX(-50%)';

    // 공통 스타일
    popup.style.background = 'rgba(0,0,0,0)';
    popup.style.color = '#fff';
    popup.style.padding = '0px';
    popup.style.borderRadius = '0px';
    popup.style.zIndex = 9999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'nowrap';
    popup.style.overflowX = 'auto';
    popup.style.gap = '0px';

    popup.innerHTML = `
      <button id="pip">PIP</button>
      <button id="speedSlow">0.25x</button>
      <button id="back300">《《5m</button>
      <button id="back60">《《1m</button>
      <button id="playpause">PLAY</button>
      <button id="forward60">1m》》</button>
      <button id="forward300">5m》》</button>
      <button id="speedNormal">1.00x</button>
      <button id="fullscreen">⛶</button>
    `;

    document.body.appendChild(popup);

    // 버튼 스타일
    popup.querySelectorAll('button').forEach(btn => {
      btn.style.fontSize = '12px';
      btn.style.padding = '0px 0px';
      btn.style.opacity = '1';
      btn.style.transition = 'opacity 0.3s ease';
    });

    popup.addEventListener('mouseenter', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
    });

    popup.addEventListener('mouseleave', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
    });

    // 플레이/멈춤 버튼
    const playPauseBtn = popup.querySelector('#playpause');
    playPauseBtn.onclick = () => {
      if (video.paused) {
        video.play();
        playPauseBtn.textContent = 'STOP';
      } else {
        video.pause();
        playPauseBtn.textContent = 'PLAY';
      }
    };
    video.addEventListener('play', () => playPauseBtn.textContent = 'STOP');
    video.addEventListener('pause', () => playPauseBtn.textContent = 'PLAY');

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
    //popup.querySelector('#speedSlow').onclick = () => {
      //if (currentIntervalId) clearInterval(currentIntervalId);
      //currentIntervalId = fixPlaybackRate(video, 0.5);
    //};
    //popup.querySelector('#speedSlow').onclick = () => {
      //if (currentIntervalId) clearInterval(currentIntervalId);
      //currentIntervalId = fixPlaybackRate(video, 1.75);
    //};
    popup.querySelector('#speedNormal').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 1.0);
    };
    //popup.querySelector('#speedFast').onclick = () => {
      //if (currentIntervalId) clearInterval(currentIntervalId);
      //currentIntervalId = fixPlaybackRate(video, 2.0);
    //};

    // 앞뒤 이동, PIP, 전체화면
    //popup.querySelector('#back10').onclick = () => { video.currentTime -= 10; };
    popup.querySelector('#back60').onclick = () => { video.currentTime -= 60; };
    popup.querySelector('#back300').onclick = () => { video.currentTime -= 300; };
    //popup.querySelector('#forward10').onclick = () => { video.currentTime += 10; };
    popup.querySelector('#forward60').onclick = () => { video.currentTime += 60; };
    popup.querySelector('#forward300').onclick = () => { video.currentTime += 300; };
    popup.querySelector('#pip').onclick = async () => {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    };
    popup.querySelector('#fullscreen').onclick = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        video.requestFullscreen();
      }
    };

    // ★ 위치 업데이트: 영상 하단 중앙
    function updatePopupPosition() {
      const rect = video.getBoundingClientRect();
      popup.style.top = `${rect.bottom + -15}px`; // 5px 간격
      popup.style.left = `${rect.left + rect.width / 2}px`;
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
