// ==UserScript==
// @name         Video Controller Popup with Multi-Video Selector (Fixed Bottom Center + Dynamic Video Support)
// @namespace    Violentmonkey Scripts
// @version      2.4
// @description  여러 영상이 있을 때 팝업 내 영상 선택 + 앞뒤 이동 + 배속 + PIP + 동적 video 탐지 및 함수 후킹 포함
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  let currentIntervalId = null;
  let videos = [];
  let currentVideo = null;

  // 재생 가능한 video 모두 찾기
  function findPlayableVideos() {
    return [...document.querySelectorAll('video')].filter(video => {
      const isHidden = video.classList.contains('hidden') || video.offsetParent === null;
      const hasSrc = !!video.currentSrc || !!video.src;
      return !isHidden && hasSrc;
    });
  }

  // 재생속도 고정
  function fixPlaybackRate(video, rate) {
    video.playbackRate = rate;
    if (currentIntervalId) clearInterval(currentIntervalId);
    currentIntervalId = setInterval(() => {
      if (video.playbackRate !== rate) {
        video.playbackRate = rate;
      }
    }, 250);
  }

  // 팝업 생성 및 UI 업데이트 함수
  function createPopup() {
    // 기존 팝업 있으면 제거
    const oldPopup = document.getElementById('video-controller-popup');
    if (oldPopup) oldPopup.remove();

    videos = findPlayableVideos();
    if (videos.length === 0) return;

    currentVideo = videos[0];

    const popup = document.createElement('div');
    popup.id = 'video-controller-popup';

    popup.style.position = 'fixed';
    popup.style.bottom = '5px';
    popup.style.left = '50%';
    popup.style.transform = 'translateX(-50%)';

    popup.style.background = 'rgba(0,0,0,0.6)';
    popup.style.color = '#fff';
    popup.style.padding = '2px 2px';
    popup.style.borderRadius = '2px';
    popup.style.zIndex = 999999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'nowrap';
    popup.style.gap = '6px';
    popup.style.alignItems = 'center';
    popup.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';

    // 영상 선택 셀렉트 박스
    const select = document.createElement('select');
    select.style.marginRight = '8px';
    select.style.fontSize = '14px';
    select.style.borderRadius = '2px';
    select.style.padding = '2px 2px';
    select.style.cursor = 'pointer';

    videos.forEach((video, i) => {
      const option = document.createElement('option');
      option.value = i;
      // video.src가 길거나 없으면 index 표시
      option.textContent = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
      select.appendChild(option);
    });

    select.onchange = () => {
      if (currentIntervalId) {
        clearInterval(currentIntervalId);
        currentIntervalId = null;
      }
      currentVideo = videos[select.value];
    };

    popup.appendChild(select);

    // 버튼 생성 함수
    function createButton(id, text, onClick) {
      const btn = document.createElement('button');
      btn.id = id;
      btn.textContent = text;
      btn.style.fontSize = '14px';
      btn.style.padding = '2px 2px';
      btn.style.opacity = '1';
      btn.style.transition = 'opacity 0.3s ease';
      btn.style.border = '1px solid #fff';
      btn.style.borderRadius = '2px';
      btn.style.backgroundColor = 'rgba(0,0,0,0.5)';
      btn.style.color = '#fff';
      btn.style.cursor = 'pointer';
      btn.style.userSelect = 'none';
      btn.addEventListener('click', onClick);
      return btn;
    }

    // 버튼들
    const speedSlow = createButton('speedSlow', '0.25x', () => fixPlaybackRate(currentVideo, 0.25));
    const speedNormal = createButton('speedNormal', '1.00x', () => fixPlaybackRate(currentVideo, 1.0));
    const back300 = createButton('back300', '《《5m', () => {
      currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 300);
    });
    const back60 = createButton('back120', '《《1m', () => {
      currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 60);
    });
    const back30 = createButton('back60', '《《30s', () => {
      currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 30);
    });
    const forward30 = createButton('forward60', '30s》》', () => {
      currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 30);
    });
    const forward60 = createButton('forward120', '1m》》', () => {
      currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 60);
    });
    const forward300 = createButton('forward300', '5m》》', () => {
      currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 300);
    });
    const pip = createButton('pip', '📺', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await currentVideo.requestPictureInPicture();
        }
      } catch (e) {
        alert('PIP 모드를 지원하지 않는 브라우저이거나 현재 동작할 수 없습니다.');
      }
    });

    // 버튼들 팝업에 추가
    [speedSlow, speedNormal, back300, back60, back30, pip, forward30, forward60, forward300].forEach(btn => popup.appendChild(btn));

    // 마우스 enter/leave 이벤트
    popup.addEventListener('mouseenter', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
      select.style.opacity = '1';
    });
    popup.addEventListener('mouseleave', () => {
      popup.querySelectorAll('button').forEach(btn => btn.style.opacity = '1');
      select.style.opacity = '1';
    });

    document.body.appendChild(popup);
  }

  // 초기 팝업 생성
  createPopup();

  // MutationObserver로 video 추가/삭제 감지 시 팝업 업데이트
  const mo = new MutationObserver(() => {
    const newVideos = findPlayableVideos();
    // 영상 개수나 영상 src가 바뀌면 팝업 다시 생성
    if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
      videos = newVideos;
      createPopup();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // comment_mp4_expand 함수 후킹 (존재 시)
  if (typeof window.comment_mp4_expand === 'function') {
    const originalCommentMp4Expand = window.comment_mp4_expand;
    window.comment_mp4_expand = function(...args) {
      originalCommentMp4Expand.apply(this, args);
      setTimeout(() => {
        videos = findPlayableVideos();
        createPopup();
      }, 500);
    };
  }

})();
