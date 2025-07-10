// ==UserScript==
// @name          Video Controller Popup (PC + Mobile + Lazy + Netflix + Twitch Full Fix)
// @namespace     Violentmonkey Scripts
// @version       3.5
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + 동적 탐지 + Lazy data-src + 넷플릭스 seek + Twitch Shadow DOM + overflow/z-index 대응 + Twitch 배속 강제 유지
// @match         *://*/*
// @grant         none
// ==/UserScript==

(function() {
  'use strict';

  let currentIntervalId = null;
  let videos = [];
  let currentVideo = null;
  let popupElement = null;

  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isNetflix = location.hostname.includes('netflix.com');
  const isTwitch = location.hostname.includes('twitch.tv');
  const idleOpacity = isMobile ? '1' : '0.025';

  // ✅ Lazy-src 예외 사이트 배열
  const lazySrcBlacklist = [
    'missav.ws',
    'missav.live',
    'example.net'
  ];
  const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

  function findPlayableVideos() {
    const found = [];

    // ✅ 일반 DOM
    document.querySelectorAll('video').forEach(v => found.push(v));

    // ✅ Shadow DOM (트위치 대응)
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('video').forEach(v => found.push(v));
      }
    });

    // ✅ data-src lazy fix (예외 사이트는 처리하지 않음)
    if (!isLazySrcBlockedSite) {
      found.forEach(v => {
        if (!v.src && v.dataset && v.dataset.src) {
          v.src = v.dataset.src;
        }
      });
    }

    return found.filter(v => !v.classList.contains('hidden'));
  }

  function fixPlaybackRate(video, rate) {
    video.playbackRate = rate;

    if (currentIntervalId) clearInterval(currentIntervalId);

    const forceInterval = isTwitch ? 50 : 200;
    currentIntervalId = setInterval(() => {
      if (video.playbackRate !== rate) {
        video.playbackRate = rate;
      }
    }, forceInterval);
  }

  function seekVideo(seconds) {
    if (isNetflix) {
      try {
        const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
        const sessionId = player.getAllPlayerSessionIds()[0];
        const playerSession = player.getVideoPlayerBySessionId(sessionId);
        const newTime = playerSession.getCurrentTime() + seconds * 1000;
        playerSession.seek(newTime);
      } catch (e) {
        console.warn('Netflix seek error:', e);
        alert('넷플릭스에서는 시간이동이 제한되었거나 실패했습니다.');
      }
    } else if (currentVideo) {
      currentVideo.currentTime = Math.min(
        currentVideo.duration,
        Math.max(0, currentVideo.currentTime + seconds)
      );
    }
  }

  function createPopup() {
    const hostRoot = document.body;

    if (popupElement) popupElement.remove();

    videos = findPlayableVideos();
    if (videos.length === 0) {
      if (currentIntervalId) clearInterval(currentIntervalId);
      currentIntervalId = null;
      currentVideo = null;
      return;
    }

    if (!currentVideo || !videos.includes(currentVideo)) {
      currentVideo = videos[0];
    }

    const popup = document.createElement('div');
    popup.id = 'video-controller-popup';

    popup.style.cssText = `
      position: fixed;
      bottom: 0px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.5);
      //background: rgba(0,0,0,0.1); // 반투명
      //background-color: transparent;
      color: #fff;
      padding: 8px 12px;  // 위쪽과 아래쪽 여백 / 왼쪽과 오른쪽 여백
      border-radius: 8px;
      z-index: 2147483647;
      pointer-events: auto;
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      align-items: center;
      box-shadow: 0 0 15px rgba(0,0,0,0.5);
      transition: opacity 0.3s ease;
      opacity: ${idleOpacity};
    `;
    popupElement = popup;

    const select = document.createElement('select');
    select.style.cssText = `
      margin-right: 8px;
      font-size: 16px;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      max-width: 150px;
      background: #000; /* contrast solid color to avoid white-on-white */
      color: #fff;
      border: 1px solid rgba(255,255,255,0.5);
      text-overflow: ellipsis;
      white-space: nowrap;
    `;

    videos.forEach((video, i) => {
      const option = document.createElement('option');
      option.value = i;
      let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
      if (label.length > 25) label = label.slice(0, 22) + '...';
      option.textContent = label;
      option.title = label;
      if (video === currentVideo) option.selected = true;
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
      btn.style.cssText = `
        font-size: 16px;
        font-weight: bold; /* ✅ 글자 진하게 */
        text-shadow: 0 1px 3px rgba(0,0,0,0.5); /* ✅ 그림자 효과 */
        padding: 4px 10px;
        border: 1px solid #fff;
        border-radius: 4px;
        //background-color: rgba(255,255,255,0.1);
        background-color: rgba(0,0,0,5);
        color: #fff;
        //color: #00ff00; //초록색
        cursor: pointer;
        user-select: none;
        white-space: nowrap; /* ✅ 한 줄 유지 */
      `;
      btn.addEventListener('mouseenter', () => btn.style.backgroundColor = 'rgba(125,125,125,125)');
      btn.addEventListener('mouseleave', () => btn.style.backgroundColor = 'rgba(0,0,0,5)');
      btn.addEventListener('click', onClick);
      return btn;
    }

    popup.appendChild(createButton('slow', '0.2x', () => fixPlaybackRate(currentVideo, 0.2)));
    popup.appendChild(createButton('normal', '1.0x', () => fixPlaybackRate(currentVideo, 1.0)));
    popup.appendChild(createButton('fast', '5.0x', () => fixPlaybackRate(currentVideo, 5.0)));
    popup.appendChild(createButton('pip', '📺 PIP', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await currentVideo.requestPictureInPicture();
        }
      } catch (e) {
        alert('PIP 모드를 지원하지 않거나 실패했습니다.');
        console.error('PIP Error:', e);
      }
    }));
    popup.appendChild(createButton('back15', '《 15s', () => seekVideo(-15)));
    popup.appendChild(createButton('forward15', '15s 》', () => seekVideo(15)));

    if (!isMobile) {
      popup.addEventListener('mouseenter', () => popup.style.opacity = '1');
      popup.addEventListener('mouseleave', () => popup.style.opacity = idleOpacity);
    } else {
      popup.addEventListener('touchstart', () => {
        popup.style.opacity = '1';
        clearTimeout(popup.fadeTimeout);
        popup.fadeTimeout = setTimeout(() => {
          popup.style.opacity = idleOpacity;
        }, 3000);
      });
    }

    hostRoot.appendChild(popup);
  }

  function run() {
    createPopup();
    const mo = new MutationObserver(() => {
      const newVideos = findPlayableVideos();
      if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
        createPopup();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      const newVideos = findPlayableVideos();
      if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
        createPopup();
      }
    }, 2000);
  }

  function fixTwitchOverflow() {
    if (!isTwitch) return;
    const containers = document.querySelectorAll(
      'div.video-player__container, div.video-player-theatre-mode__player, div.player-theatre-mode'
    );
    containers.forEach(container => {
      container.style.overflow = 'visible';
    });
  }

  run();

  if (isTwitch) {
    fixTwitchOverflow();
    setInterval(fixTwitchOverflow, 1000);
  }
})();
