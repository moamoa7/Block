// ==UserScript==
// @name         Video Controller Popup (Playable Video Detect + Controls + Iframe Aware)
// @namespace    Violentmonkey Scripts
// @version      1.9
// @description  동적 영상 탐지 + 앞뒤 이동 + 배속 + PIP + 전체화면 + 호버시 투명도 + iframe 안/밖 위치 대응
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

    const inIframe = window.self !== window.top;

    if (inIframe) {
      // iframe 안이면 fixed 하단 중앙
      popup.style.position = 'fixed';
      popup.style.bottom = '20px'; // 필요하면 여백 조절
      popup.style.left = '50%';
      popup.style.transform = 'translateX(-50%)';
      document.body.appendChild(popup);
    } else {
      // 메인 문서면 video 바로 위에 absolute + 영상 내부 하단 중앙
      const wrapper = video.parentElement || video;
      wrapper.style.position = 'relative';

      popup.style.position = 'absolute';
      popup.style.bottom = '0px';
      popup.style.left = '50%';
      popup.style.transform = 'translateX(-50%)';
      wrapper.appendChild(popup);
    }

    // 공통 스타일
    popup.style.background = 'rgba(0,0,0,0)';
    popup.style.color = '#fff';
    popup.style.padding = '2px';
    popup.style.borderRadius = '2px';
    popup.style.zIndex = 9999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'wrap';
    popup.style.overflowX = 'auto';
    popup.style.gap = '2px';

    popup.innerHTML = `
      <button id="speedSlow">0.25x</button>
      <button id="speedNormal">1x</button>
      <button id="speedFast">2x</button>
      <button id="back300">《《5m</button>
      <button id="back60">《《1m</button>
      <button id="back10">《《10s</button>
      <button id="playpause">PLAY</button>
      <button id="forward10">10s》》</button>
      <button id="forward60">1m》》</button>
      <button id="forward300">5m》》</button>
      <button id="pip">PIP</button>
      <button id="fullscreen">⛶</button>
    `;

    // 버튼 스타일 및 hover 효과
    popup.querySelectorAll('button').forEach(btn => {
      btn.style.fontSize = '12px';
      btn.style.padding = '2px 4px';
      btn.style.opacity = '1'; // 기본 투명
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

    // 배속 유지
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
    popup.querySelector('#speedFast').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 2.0);
    };

    // 이동, PIP, 전체화면
    popup.querySelector('#back10').onclick = () => { video.currentTime -= 10; };
    popup.querySelector('#back60').onclick = () => { video.currentTime -= 60; };
    popup.querySelector('#back300').onclick = () => { video.currentTime -= 300; };
    popup.querySelector('#forward10').onclick = () => { video.currentTime += 10; };
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
