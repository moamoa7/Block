// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace     Violentmonkey Scripts
// @version       3.99
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match         *://*/*
// @grant         none
// ==/UserScript==

(function() {
  'use strict';

  // --- Core Variables ---
  let currentIntervalId = null;
  let videos = [];
  let currentVideo = null;
  let popupElement = null;

  // --- Environment Flags ---
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isNetflix = location.hostname.includes('netflix.com');

  // --- Configuration ---
  let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '1';

  const lazySrcBlacklist = [
    'missav.ws',
    'missav.live',
    'example.net'
  ];
  const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

  const VALID_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv'];

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

  // Overflow fix
  let customOverflowFixSites = [];
  const defaultOverflowFixSites = [
    { domain: 'twitch.tv', selector: [
      'div.video-player__container',
      'div.video-player-theatre-mode__player',
      'div.player-theatre-mode'
    ]}
  ];

  try {
    const storedSites = localStorage.getItem('vcp_overflowFixSites');
    if (storedSites) {
      const parsedSites = JSON.parse(storedSites);
      if (Array.isArray(parsedSites) && parsedSites.every(item =>
        typeof item === 'object' && typeof item.domain === 'string' &&
        Array.isArray(item.selector))) {
        customOverflowFixSites = parsedSites;
      }
    }
  } catch (e) { console.warn('Video Controller Popup: Invalid overflowFixSites.', e); }

  const overflowFixTargets = customOverflowFixSites.length > 0 ? customOverflowFixSites : defaultOverflowFixSites;

  // --- Utilities ---
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
          try {
            const url = new URL(v.dataset.src, window.location.href);
            if (['http:', 'https:'].includes(url.protocol) &&
                VALID_VIDEO_EXTENSIONS.some(ext => url.pathname.toLowerCase().endsWith(ext))) {
              v.src = v.dataset.src;
            }
          } catch (e) {}
        }
      });
    }
    return found.filter(v => !v.classList.contains('hidden'));
  }

  function fixPlaybackRate(video, rate) {
    if (!video) return;
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
        if (playerSession) {
          const newTime = playerSession.getCurrentTime() + seconds * 1000;
          playerSession.seek(newTime);
        }
      } catch (e) {
        console.warn('Video Controller Popup: Netflix seek error:', e);
      }
    } else if (currentVideo) {
      currentVideo.currentTime = Math.min(
        currentVideo.duration,
        Math.max(0, currentVideo.currentTime + seconds)
      );
    }
  }

  // --- Audio Amplify ---
  let audioCtx = null;
  let gainNode = null;
  let sourceNode = null;
  let connectedVideo = null;

  function cleanupAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch (e) {}
    }
    audioCtx = null; gainNode = null; sourceNode = null; connectedVideo = null;
  }

  function setupAudioContext(video) {
    cleanupAudioContext();
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      sourceNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      connectedVideo = video;
      return true;
    } catch (e) {
      cleanupAudioContext();
      return false;
    }
  }

  function setAmplifiedVolume(video, vol) {
    if (!video) return;
    if (vol <= 1) {
      if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
      video.volume = vol;
    } else {
      if (!audioCtx || connectedVideo !== video) {
        if (!setupAudioContext(video)) {
          video.volume = 1;
          return;
        }
      }
      video.volume = 1;
      if (gainNode) gainNode.gain.value = vol;
    }
  }

  // --- UI ---
  const volumeOptions = [
    { label: 'Mute', value: 'muted' },
    { label: '10%', value: 0.1 }, { label: '50%', value: 0.5 },
    { label: '100%', value: 1.0 }, { label: '150%', value: 1.5 },
    { label: '300%', value: 3.0 }, { label: '500%', value: 5.0 },
    { label: '투명', value: 'transparent' }, { label: '불투명', value: 'opaque' }
  ];

  function updateVolumeSelect() {
    const volumeSelect = popupElement?.querySelector('#volume-select');
    if (!currentVideo || !volumeSelect) return;
    if (currentVideo.muted) {
      volumeSelect.value = 'muted';
    } else {
      let gain = gainNode && connectedVideo === currentVideo ? gainNode.gain.value : 1;
      let eff = currentVideo.volume * gain;
      const closest = volumeOptions.reduce((prev, curr) => {
        if (typeof curr.value !== 'number') return prev;
        return Math.abs(curr.value - eff) < Math.abs(prev.value - eff) ? curr : prev;
      }, { value: 1.0 });
      volumeSelect.value = closest.value;
    }
  }

  function createPopup() {
    const latestVideos = findPlayableVideos();
    if (latestVideos.length === videos.length && latestVideos.every((v, i) => v === videos[i])) return;
    videos = latestVideos;

    if (popupElement) popupElement.remove();
    if (videos.length === 0) {
      if (currentIntervalId) clearInterval(currentIntervalId);
      cleanupAudioContext();
      currentVideo = null;
      return;
    }

    if (!currentVideo || !videos.includes(currentVideo)) currentVideo = videos[0];

    const popup = document.createElement('div');
    popup.style.cssText = `
      position: fixed; bottom:0; left:50%; transform:translateX(-50%);
      background: rgba(0,0,0,0.5); color:#fff; padding:8px 12px; border-radius:8px;
      z-index:2147483647; display:flex; gap:8px; align-items:center;
      box-shadow:0 0 15px rgba(0,0,0,0.5); opacity:${idleOpacity};
      transition: opacity 0.3s ease;
    `;
    popupElement = popup;

    const select = document.createElement('select');
    videos.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `Video ${i + 1}`;
      select.appendChild(o);
    });
    select.onchange = () => {
      if (currentIntervalId) clearInterval(currentIntervalId);
      cleanupAudioContext();
      currentVideo = videos[select.value];
      updateVolumeSelect();
    };
    popup.appendChild(select);

    const btn = (txt, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.onclick = fn;
      b.style = 'padding:2px 6px; cursor:pointer;';
      return b;
    };

    popup.append(
      btn('0.2x', () => fixPlaybackRate(currentVideo, 0.2)),
      btn('1x', () => fixPlaybackRate(currentVideo, 1)),
      btn('5x', () => fixPlaybackRate(currentVideo, 5)),
      btn('《15s', () => seekVideo(-15)),
      btn('15s》', () => seekVideo(15)),
      btn('PIP', async () => {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await currentVideo?.requestPictureInPicture();
      })
    );

    const volumeSelect = document.createElement('select');
    volumeSelect.id = 'volume-select';
    volumeOptions.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label;
      volumeSelect.appendChild(o);
    });
    volumeSelect.onchange = () => {
      if (!currentVideo) return;
      if (volumeSelect.value === 'muted') currentVideo.muted = true;
      else if (volumeSelect.value === 'transparent') {
        idleOpacity = '0.025';
      } else if (volumeSelect.value === 'opaque') {
        idleOpacity = '1';
      } else {
        currentVideo.muted = false;
        setAmplifiedVolume(currentVideo, parseFloat(volumeSelect.value));
      }
      popup.style.opacity = idleOpacity;
    };
    popup.appendChild(volumeSelect);

    if (!isMobile) {
      popup.onmouseenter = () => popup.style.opacity = '1';
      popup.onmouseleave = () => popup.style.opacity = idleOpacity;
    }

    document.body.appendChild(popup);
    updateVolumeSelect();
  }

  // --- Main ---
  const mo = new MutationObserver(() => createPopup());
  mo.observe(document.body, { childList: true, subtree: true });
  setInterval(() => createPopup(), 5000);
  fixOverflow();
  setInterval(fixOverflow, 1000);

  console.log('Video Controller Popup v3.99 loaded.');
})();
