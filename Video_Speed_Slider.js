// ==UserScript==
// @name         Vertical Video Speed Slider (Fullscreen-safe, Long Press on Label + Double Click Reset)
// @namespace    Violentmonkey Scripts
// @version      1.5
// @description  화면 오른쪽에 수직 배속 슬라이더 고정, 전체화면에서도 표시. Speed 텍스트 긴 누름과 PC 더블클릭으로 1배속 초기화 기능 포함.
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
      padding: 10px;
      border-radius: 8px 0 0 8px;
      z-index: 2147483647 !important;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 60px;
      height: auto;
      font-family: sans-serif;
      pointer-events: auto;
      opacity: 0.2;
      transition: opacity 0.3s;
      user-select: none;
    }
    #${sliderId}:hover {
      opacity: 1;
    }

    #vm-speed-slider {
      writing-mode: vertical-rl;
      -webkit-appearance: slider-vertical;
      appearance: slider-vertical;
      width: 30px;
      height: 150px;
      margin: 10px 0;
      cursor: pointer;
      user-select: none;
    }

    #vm-speed-value {
      color: white;
      font-size: 13px;
      margin-top: 4px;
      user-select: none;
    }

    #vm-speed-label {
      color: white;
      font-size: 12px;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      margin-bottom: 6px;
      cursor: pointer;
      user-select: none;
    }
  `;
  document.head.appendChild(style);

  const container = document.createElement('div');
  container.id = sliderId;

  const label = document.createElement('div');
  label.id = 'vm-speed-label';
  label.textContent = 'Speed';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.25';
  slider.max = '3';
  slider.step = '0.05';
  slider.value = '1';
  slider.id = 'vm-speed-slider';

  const valueDisplay = document.createElement('div');
  valueDisplay.id = 'vm-speed-value';
  valueDisplay.textContent = 'x1.00';

  container.appendChild(label);
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

  // --- Speed 레이블에 긴 누름(long press)으로 초기화 기능 ---
  let longPressTimer = null;

  label.addEventListener('pointerdown', (e) => {
    longPressTimer = setTimeout(() => {
      slider.value = '1';
      updateSpeed('1');
      if (navigator.vibrate) navigator.vibrate(50);
    }, 600); // 600ms 이상 누르면 초기화
  });

  label.addEventListener('pointermove', (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  label.addEventListener('pointerup', (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  // --- PC용 더블클릭 초기화 (슬라이더 대상) ---
  slider.addEventListener('dblclick', () => {
    slider.value = '1';
    updateSpeed('1');
  });

})();
