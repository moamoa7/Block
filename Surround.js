// ==UserScript==
// @name         Global Audio FX: Surround + Reverb (Fixed Toggle)
// @namespace    https://github.com/you/audio-fx
// @version      1.2
// @description  Apply surround & reverb with draggable UI and toggle only FX (not all sound)
// @author       You
// @match        *://*/*
// @license      MIT
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const checkInterval = setInterval(() => {
        const media = document.querySelector("video, audio");
        if (media) {
            clearInterval(checkInterval);
            initAudioFX(media);
        }
    }, 1000);

    function initAudioFX(media) {
        const context = new AudioContext();
        const source = context.createMediaElementSource(media);

        // Split L/R
        const splitter = context.createChannelSplitter(2);
        const merger = context.createChannelMerger(2);
        const leftDelay = context.createDelay();
        const rightDelay = context.createDelay();
        leftDelay.delayTime.value = 0;
        rightDelay.delayTime.value = 0.01;

        // Reverb
        const convolver = context.createConvolver();
        convolver.buffer = createImpulseResponse(context, 2.5, 2.0);

        // Gains
        const dryGain = context.createGain();
        dryGain.gain.value = 1.0; // 항상 켜짐 (원본 소리)
        const fxGain = context.createGain();
        fxGain.gain.value = 1.0;  // 이펙트 토글용
        const reverbGain = context.createGain();
        reverbGain.gain.value = 0.2;

        // 연결
        source.connect(splitter);
        splitter.connect(leftDelay, 0);
        splitter.connect(rightDelay, 1);
        leftDelay.connect(merger, 0, 0);
        rightDelay.connect(merger, 0, 1);

        // Dry path
        source.connect(dryGain).connect(context.destination);

        // Wet path
        merger.connect(fxGain);
        fxGain.connect(dryGain);
        merger.connect(convolver).connect(reverbGain).connect(fxGain);

        createUI(rightDelay, reverbGain, fxGain);
    }

    function createUI(rightDelay, reverbGain, fxGain) {
        const style = document.createElement("style");
        style.textContent = `
        .audio-panel {
            position: fixed; bottom: 20px; left: 20px;
            z-index: 999999; background: rgba(0,0,0,0.6);
            backdrop-filter: blur(10px); padding: 15px 20px;
            border-radius: 16px; color: white;
            font-family: Arial, sans-serif; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            width: 220px; cursor: grab;
        }
        .audio-panel h3 { margin: 0 0 10px; font-size: 16px; text-align: center; }
        .control { margin-bottom: 12px; }
        .control label { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 5px; }
        input[type=range] { width: 100%; }
        .toggle-btn { width: 100%; padding: 6px 0; border: none; border-radius: 8px; background: #4caf50; color: white; font-weight: bold; cursor: pointer; margin-top: 8px; }
        .toggle-btn.off { background: #d32f2f; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement("div");
        panel.className = "audio-panel";
        panel.innerHTML = `
            <h3>Audio FX</h3>
            <div class="control">
                <label>Delay: <span id="delayVal">${(rightDelay.delayTime.value * 1000).toFixed(0)}ms</span></label>
                <input id="delaySlider" type="range" min="0" max="0.03" step="0.001" value="${rightDelay.delayTime.value}">
            </div>
            <div class="control">
                <label>Reverb: <span id="reverbVal">${(reverbGain.gain.value * 100).toFixed(0)}%</span></label>
                <input id="reverbSlider" type="range" min="0" max="1" step="0.01" value="${reverbGain.gain.value}">
            </div>
            <button id="toggleBtn" class="toggle-btn">ON</button>
        `;
        document.body.appendChild(panel);

        const delaySlider = panel.querySelector("#delaySlider");
        const delayVal = panel.querySelector("#delayVal");
        delaySlider.addEventListener("input", () => {
            rightDelay.delayTime.value = parseFloat(delaySlider.value);
            delayVal.textContent = `${(rightDelay.delayTime.value * 1000).toFixed(0)}ms`;
        });

        const reverbSlider = panel.querySelector("#reverbSlider");
        const reverbVal = panel.querySelector("#reverbVal");
        reverbSlider.addEventListener("input", () => {
            reverbGain.gain.value = parseFloat(reverbSlider.value);
            reverbVal.textContent = `${(reverbGain.gain.value * 100).toFixed(0)}%`;
        });

        const toggleBtn = panel.querySelector("#toggleBtn");
        let isOn = true;
        toggleBtn.addEventListener("click", () => {
            isOn = !isOn;
            fxGain.gain.value = isOn ? 1 : 0;
            toggleBtn.textContent = isOn ? "ON" : "OFF";
            toggleBtn.classList.toggle("off", !isOn);
        });

        makeDraggable(panel);
    }

    function makeDraggable(el) {
        let offsetX = 0, offsetY = 0, isDown = false;
        el.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
            isDown = true;
            offsetX = e.clientX - el.offsetLeft;
            offsetY = e.clientY - el.offsetTop;
            el.style.cursor = 'grabbing';
        });
        document.addEventListener('mouseup', () => {
            isDown = false;
            el.style.cursor = 'grab';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            el.style.left = `${e.clientX - offsetX}px`;
            el.style.top = `${e.clientY - offsetY}px`;
            el.style.bottom = 'auto';
        });
    }

    function createImpulseResponse(audioCtx, duration, decay) {
        const rate = audioCtx.sampleRate;
        const length = rate * duration;
        const impulse = audioCtx.createBuffer(2, length, rate);
        for (let i = 0; i < 2; i++) {
            const channelData = impulse.getChannelData(i);
            for (let j = 0; j < length; j++) {
                channelData[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, decay);
            }
        }
        return impulse;
    }
})();
