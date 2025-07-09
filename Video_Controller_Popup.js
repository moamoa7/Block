// ==UserScript==
// @name         Video Controller Popup (Playable Video Detect + Controls + Iframe Aware)
// @namespace    Violentmonkey Scripts
// @version      1.8
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
      //popup.style.bottom = '0px';
      popup.style.bottom = '10px';
      popup.style.left = '50%';
      popup.style.transform = 'translateX(-50%)';
    } else {
      // 메인 문서면 video 바로 아래에 absolute
      const rect = video.getBoundingClientRect();
      popup.style.position = 'absolute';
      popup.style.top = (window.scrollY + rect.bottom) + 'px';
      popup.style.left = (window.scrollX + rect.left) + 'px';
      popup.style.width = rect.width + 'px';

      // 위치 업데이트 핸들러
      const updatePosition = () => {
        const rect = video.getBoundingClientRect();
        popup.style.top = (window.scrollY + rect.bottom) + 'px';
        popup.style.left = (window.scrollX + rect.left) + 'px';
        popup.style.width = rect.width + 'px';
      };
      window.addEventListener('scroll', updatePosition);
      window.addEventListener('resize', updatePosition);
    }

    // 공통 스타일
    popup.style.background = 'rgba(0,0,0,0)';  //팝업 배경색을 완전 투명
    popup.style.color = '#fff';  //팝업 안에 있는 텍스트 색상(버튼 글자)을 흰색으로 설정
    popup.style.padding = '2px';  //버튼과 팝업 외곽 사이에 2px 간격
    popup.style.borderRadius = '2px';  //팝업 박스의 모서리를 약간 둥글게.
    popup.style.zIndex = 9999;  //다른 모든 요소 위에 떠 있도록 z-index를 크게 설정
    popup.style.display = 'flex';  //버튼들이 가로로 한 줄로 배열됨
    popup.style.flexWrap = 'wrap';  //버튼이 한 줄에 다 안 들어가면 자동으로 다음 줄로 넘어감
    popup.style.overflowX = 'auto';  //가로로 넘칠 경우 가로 스크롤 생김
    popup.style.gap = '2px';  //버튼 간격을 2px

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

    document.body.appendChild(popup);

    // 버튼 기본 투명 & hover
    popup.querySelectorAll('button').forEach(btn => {
      btn.style.fontSize = '12px';
      btn.style.padding = '2px 2px';
      btn.style.opacity = '1';
      btn.style.transition = 'opacity 0.3s ease';
    });

    popup.addEventListener('mouseenter', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
    });

    popup.addEventListener('mouseleave', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '0');
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
    popup.querySelector('#speedNormal').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 1.0);
    };
    popup.querySelector('#speedFast').onclick = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = fixPlaybackRate(video, 2.0);
    };

    // 앞뒤 이동, PIP, 전체화면
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
