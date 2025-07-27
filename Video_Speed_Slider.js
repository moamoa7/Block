// ==UserScript==
// @name         Vertical Video Speed Slider (Fullscreen-safe, 1x Reset Button)
// @namespace    Violentmonkey Scripts
// @version      1.6
// @description  화면 오른쪽에 수직 배속 슬라이더 고정, 전체화면에서도 표시. 1x 버튼 클릭 시 1배속 초기화.
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('vm-speed-slider-container')) return;

  const sliderId = 'vm-speed-slider-container';

  const style = document.createElement('style');
  style.textContent = `
    #${sliderId} {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      background: rgba(0, 0, 0, 0.7);
      padding: 10px 8px;
      border-radius: 8px 0 0 8px;
      z-index: 2147483647 !important;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 70px;
      height: auto;
      font-family: sans-serif;
      pointer-events: auto;
      opacity: 0.3;
      transition: opacity 0.3s;
      user-select: none;
    }
    #${sliderId}:hover {
      opacity: 1;
    }

    #vm-speed-reset-btn {
      background: #444;
      border: none;
      border-radius: 4px;
      color: white;
      font-size: 14px;
      padding: 4px 6px;
      cursor: pointer;
      margin-bottom: 8px;
      user-select: none;
      width: 40px;
      height: 30px;
      line-height: 30px;
      text-align: center;
      font-weight: bold;
    }
    #vm-speed-reset-btn:hover {
      background: #666;
    }

    #vm-speed-slider {
      writing-mode: vertical-rl;
      -webkit-appearance: slider-vertical;
      appearance: slider-vertical;
      width: 30px;
      height: 150px;
      margin: 0 0 10px 0;
      cursor: pointer;
      user-select: none;
    }

    #vm-speed-value {
      color: white;
      font-size: 13px;
      user-select: none;
    }
  `;
  document.head.appendChild(style);

  const container = document.createElement('div');
  container.id = sliderId;

  // 1x 초기화 버튼
  const resetBtn = document.createElement('button');
  resetBtn.id = 'vm-speed-reset-btn';
  resetBtn.textContent = '1x';
  resetBtn.title = '클릭하면 1배속으로 초기화';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.2';
  slider.max = '4';
  slider.step = '0.2';
  slider.value = '1';
  slider.id = 'vm-speed-slider';

  const valueDisplay = document.createElement('div');
  valueDisplay.id = 'vm-speed-value';
  valueDisplay.textContent = 'x1.00';

  container.appendChild(resetBtn);
  container.appendChild(slider);
  container.appendChild(valueDisplay);
  document.body.appendChild(container);

  const updateSpeed = (val) => {
    const speed = parseFloat(val);
    valueDisplay.textContent = `x${speed.toFixed(2)}`;
    document.querySelectorAll('video').forEach(video => {
      video.playbackRate = speed;
    });
  };

  slider.addEventListener('input', () => updateSpeed(slider.value));
  updateSpeed(slider.value);

  resetBtn.addEventListener('click', () => {
    slider.value = '1';
    updateSpeed('1');
  });

  // 전체화면 감지 → 다시 붙이기
  const reattachSlider = () => {
    const fsEl = document.fullscreenElement;
    if (fsEl) {
      fsEl.appendChild(container);
    } else {
      document.body.appendChild(container);
    }
  };

  document.addEventListener('fullscreenchange', reattachSlider);
})();
