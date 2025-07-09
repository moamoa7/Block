// ==UserScript==
// @name         Video Controller Popup with Multi-Video Selector (PC + Mobile Lazy Fix)
// @namespace    Violentmonkey Scripts
// @version      2.8
// @description  여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + 동적 video 탐지 + PC/Mobile fade + data-src lazy fix + 자막 피하기
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  let currentIntervalId = null;
  let videos = [];
  let currentVideo = null;

  // ✅ PC/모바일 분기
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const idleOpacity = isMobile ? '1' : '1';

  function findPlayableVideos() {
    return [...document.querySelectorAll('video')].filter(video => {
      // ✅ data-src 강제 붙이기 (Lazy Load 우회)
      if (!video.src && video.dataset && video.dataset.src) {
        video.src = video.dataset.src;
      }
      const isHidden = video.classList.contains('hidden') || video.offsetParent === null;
      const hasSrc = !!video.currentSrc || !!video.src;
      return !isHidden && hasSrc;
    });
  }

  function fixPlaybackRate(video, rate) {
    video.playbackRate = rate;
    if (currentIntervalId) clearInterval(currentIntervalId);
    currentIntervalId = setInterval(() => {
      if (video.playbackRate !== rate) {
        video.playbackRate = rate;
      }
    }, 250);
  }

  function createPopup() {
    const oldPopup = document.getElementById('video-controller-popup');
    if (oldPopup) oldPopup.remove();

    videos = findPlayableVideos();
    if (videos.length === 0) return;

    currentVideo = videos[0];

    const popup = document.createElement('div');
    popup.id = 'video-controller-popup';

    popup.style.position = 'fixed';
    popup.style.bottom = '0px'; // ✅ 자막 영역 피하도록 하단에 바로 붙임
    popup.style.left = '50%';
    popup.style.transform = 'translateX(-50%)';

    popup.style.background = 'rgba(0,0,0,0.1)';
    popup.style.color = '#fff';
    popup.style.padding = '6px 10px';
    popup.style.borderRadius = '6px';
    popup.style.zIndex = 999999;
    popup.style.display = 'flex';
    popup.style.flexWrap = 'nowrap';
    popup.style.gap = '6px';
    popup.style.alignItems = 'center';
    popup.style.boxShadow = '0 0 10px rgba(0,0,0,0.2)';
    popup.style.transition = 'opacity 0.3s ease';
    popup.style.opacity = idleOpacity;

    // ✅ 영상 선택 셀렉트 박스
    const select = document.createElement('select');
    select.style.marginRight = '8px';
    select.style.fontSize = '16px';
    select.style.borderRadius = '4px';
    select.style.padding = '2px 6px';
    select.style.cursor = 'pointer';
    select.style.width = '45px'; // 고정 너비
    select.style.overflow = 'hidden';
    select.style.textOverflow = 'ellipsis';
    select.style.whiteSpace = 'nowrap';

    videos.forEach((video, i) => {
      const option = document.createElement('option');
      option.value = i;
      let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
      if (label.length > 20) {
        option.textContent = label.slice(0, 20) + '…';
      } else {
        option.textContent = label;
      }
      option.title = label;
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

    function createButton(id, text, onClick) {
      const btn = document.createElement('button');
      btn.id = id;
      btn.textContent = text;
      btn.style.fontSize = '16px';
      btn.style.padding = '2px 6px';
      btn.style.border = '1px solid #fff';
      btn.style.borderRadius = '4px';
      btn.style.backgroundColor = 'rgba(0,0,0,0.1)';
      btn.style.color = '#fff';
      btn.style.cursor = 'pointer';
      btn.style.userSelect = 'none';
      btn.addEventListener('click', onClick);
      return btn;
    }

    const speedVerySlow = createButton('speedVerySlow', '0.1x', () => fixPlaybackRate(currentVideo, 0.1));
    const speedNormal = createButton('speedNormal', '1.00x', () => fixPlaybackRate(currentVideo, 1.0));
    const speedVeryFast = createButton('speedVeryFast', '4.00x', () => fixPlaybackRate(currentVideo, 4.0));

    const back15 = createButton('back15', '《《15s', () => {
      currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 15);
    });
    const forward15 = createButton('forward15', '15s》》', () => {
      currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 15);
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

    [speedVerySlow, speedNormal, speedVeryFast, pip, back15, forward15].forEach(btn => popup.appendChild(btn));

    // ✅ PC hover 이벤트
    if (!isMobile) {
      popup.addEventListener('mouseenter', () => {
        popup.style.opacity = '1';
      });
      popup.addEventListener('mouseleave', () => {
        popup.style.opacity = idleOpacity;
      });
    }

    // ✅ 모바일 터치 이벤트
    if (isMobile) {
      popup.addEventListener('touchstart', () => {
        popup.style.opacity = '1';
        clearTimeout(popup.fadeTimeout);
        popup.fadeTimeout = setTimeout(() => {
          popup.style.opacity = idleOpacity;
        }, 3000);
      });
    }

    document.body.appendChild(popup);
  }

  createPopup();

  // ✅ 동적 video 추가 감지
  const mo = new MutationObserver(() => {
    const newVideos = findPlayableVideos();
    if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
      videos = newVideos;
      createPopup();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // ✅ 함수 후킹 예시 (필요하면)
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
