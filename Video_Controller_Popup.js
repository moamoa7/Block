// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace     Violentmonkey Scripts
// @version       3.91
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
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
  let idleOpacity = isMobile ? '1' : '1';
  const isNetflix = location.hostname.includes('netflix.com');

  // Lazy-src 예외 사이트
  const lazySrcBlacklist = [
    'missav.ws',
    'missav.live',
    'example.net'
  ];
  const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

  // 강제 배속 유지 사이트
  const forcePlaybackRateSites = [
    { domain: 'twitch.tv', interval: 50 },
    { domain: 'tiktok.com', interval: 20 }
  ];

  let forceInterval = 200;
  forcePlaybackRateSites.forEach(site => {
    if (location.hostname.includes(site.domain)) {
      forceInterval = site.interval;
    }
  });

  // overflow visible fix 사이트
  const overflowFixSites = [
    { domain: 'twitch.tv', selector: [
      'div.video-player__container',
      'div.video-player-theatre-mode__player',
      'div.player-theatre-mode'
    ]},
  ];
  const overflowFixTargets = overflowFixSites.filter(site =>
    location.hostname.includes(site.domain)
  );

  function fixOverflow() {
    overflowFixTargets.forEach(site => {
      site.selector.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          el.style.overflow = 'visible';
        });
      });
    });
  }

  function findAllVideosDeep(root = document) {
    const found = [];
    root.querySelectorAll('video').forEach(v => found.push(v));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        found.push(...findAllVideosDeep(el.shadowRoot));
      }
    });
    return found;
  }

  function findPlayableVideos() {
    const found = findAllVideosDeep();
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

  // --- Web Audio API 증폭 관련 변수 및 함수 ---
  let audioCtx = null;
  let gainNode = null;
  let sourceNode = null;
  let connectedVideo = null;

  function setupAudioContext(video) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
    }
    sourceNode = audioCtx.createMediaElementSource(video);
    if (gainNode) {
      try { gainNode.disconnect(); } catch {}
    }
    gainNode = audioCtx.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    connectedVideo = video;
  }

  function setAmplifiedVolume(video, vol) {
    if (vol <= 1) {
      // 증폭 없이 video.volume 사용
      if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
      video.volume = vol;
    } else {
      // 증폭 적용
      if (!audioCtx || !sourceNode || !gainNode || connectedVideo !== video) {
        setupAudioContext(video);
      }
      video.volume = 1;
      gainNode.gain.value = vol;
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
      color: #fff;
      padding: 8px 12px;
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

    // Video select
    const select = document.createElement('select');
    select.style.cssText = `
      margin-right: 8px;
      font-size: 16px;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      max-width: 150px;
      background: #000;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.5);
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
      updateVolumeSelect();
    };
    popup.appendChild(select);

    // Playback buttons
    function createButton(id, text, onClick) {
      const btn = document.createElement('button');
      btn.id = id;
      btn.textContent = text;
      btn.style.cssText = `
        font-size: 16px;
        font-weight: bold;
        padding: 4px 10px;
        border: 1px solid #fff;
        border-radius: 4px;
        background-color: rgba(0,0,0,0.5);
        color: #fff;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      `;
      btn.addEventListener('mouseenter', () => btn.style.backgroundColor = 'rgba(125,125,125,0.8)');
      btn.addEventListener('mouseleave', () => btn.style.backgroundColor = 'rgba(0,0,0,0.5)');
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
      }
    }));
    popup.appendChild(createButton('back15', '《 15s', () => seekVideo(-15)));
    popup.appendChild(createButton('forward15', '15s 》', () => seekVideo(15)));

    // Volume select dropdown
    const volumeSelect = document.createElement('select');
    volumeSelect.style.cssText = `
      margin-left: 8px;
      font-size: 16px;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      background: #000;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.5);
    `;
    const volumeOptions = [
      { label: 'Mute', value: 'muted' },
      { label: '10%', value: 0.1 },
      { label: '20%', value: 0.2 },
      { label: '30%', value: 0.3 },
      { label: '40%', value: 0.4 },
      { label: '50%', value: 0.5 },
      { label: '60%', value: 0.6 },
      { label: '70%', value: 0.7 },
      { label: '80%', value: 0.8 },
      { label: '90%', value: 0.9 },
      { label: '100%', value: 1.0 },
      { label: '150%', value: 1.5 },
      { label: '200%', value: 2.0 },
      { label: '300%', value: 3.0 },
      { label: '400%', value: 4.0 },
      { label: '500%', value: 5.0 },
      { label: '투명', value: 'transparent' },
      { label: '불투명', value: 'opaque' }
    ];
    volumeOptions.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      volumeSelect.appendChild(option);
    });

    function updateVolumeSelect() {
      if (!currentVideo) return;
      if (currentVideo.muted) {
        volumeSelect.value = 'muted';
        if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
      } else {
        let currentGain = 1;
        if (gainNode && connectedVideo === currentVideo) currentGain = gainNode.gain.value;
        let volValue = currentGain > 1 ? currentGain : currentVideo.volume;

        const closest = volumeOptions.reduce((prev, curr) => {
          if (curr.value === 'muted') return prev;
          if (curr.value === 'transparent' || curr.value === 'opaque') return prev;
          return Math.abs(curr.value - volValue) < Math.abs(prev.value - volValue) ? curr : prev;
        });
        volumeSelect.value = closest.value;
      }
    }

    volumeSelect.onchange = () => {
      if (!currentVideo) return;
      const value = volumeSelect.value;
      if (value === 'muted') {
        currentVideo.muted = true;
        if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
      } else if (value === 'transparent' || value === 'opaque') {
        // 투명 / 불투명 처리
        const isTransparent = value === 'transparent';
        idleOpacity = isTransparent ? '0.025' : '1'; // idleOpacity 변경
        if (popupElement) {
          popupElement.style.opacity = idleOpacity; // 팝업 전체 opacity 적용
          const buttons = popupElement.querySelectorAll('button');
          buttons.forEach(btn => {
            btn.style.backgroundColor = isTransparent
              ? 'rgba(0,0,0,0.1)'
              : 'rgba(0,0,0,0.5)';
          });
        }
      } else {
        currentVideo.muted = false;
        const vol = parseFloat(value);
        setAmplifiedVolume(currentVideo, vol);
      }
    };

    updateVolumeSelect();
    popup.appendChild(volumeSelect);

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

  run();
  if (overflowFixTargets.length > 0) {
    fixOverflow();
    setInterval(fixOverflow, 1000);
  }
})();
