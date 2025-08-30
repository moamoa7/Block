// ==UserScript==
// @name         Global Audio FX: Surround + Reverb (Draggable UI)
// @namespace    https://github.com/you/audio-fx
// @version      1.0
// @description  Apply surround and reverb to any site's audio/video with draggable UI controls
// @author       You
// @match        *://*/*
// @license      MIT
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Wait until an <audio> or <video> element appears
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

        // --- Surround (Delay) ---
        const splitter = context.createChannelSplitter(2);
        const merger = context.createChannelMerger(2);

        const leftDelay = context.createDelay();
        const rightDelay = context.createDelay();
        leftDelay.delayTime.value = 0;
        rightDelay.delayTime.value = 0.01; // 10ms

        source.connect(splitter);
        splitter.connect(leftDelay, 0);
        splitter.connect(rightDelay, 1);
        leftDelay.connect(merger, 0, 0);
        rightDelay.connect(merger, 0, 1);

        // --- Reverb (Convolver) ---
        const convolver = context.createConvolver();
        convolver.buffer = createImpulseResponse(context, 2.5, 2.0);

        const reverbGain = context.createGain();
        reverbGain.gain.value = 0.2;

        const dryGain = context.createGain();
        dryGain.gain.value = 1.0;

        merger.connect(dryGain).connect(context.destination);
        merger.connect(convolver).connect(reverbGain).connect(context.destination);

        createUI(context, rightDelay, reverbGain);
    }

    function createUI(context, rightDelay, reverbGain) {
        // --- Styles ---
        const style = document.createElement("style");
        style.textContent = `
        .audio-panel {
            position: fixed;
            bottom: 20px;
            left: 20px;
            z-index: 999999;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(10px);
            padding: 15px 20px;
            border-radius: 16px;
            color: white;
            font-family: Arial, sans-serif;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            width: 220px;
            cursor: grab;
        }
        .audio-panel h3 {
            margin: 0 0 10px;
            font-size: 16px;
            text-align: center;
            user-select: none;
        }
        .control {
            margin-bottom: 12px;
        }
        .control label {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            margin-bottom: 5px;
        }
        .control input[type=range] {
            width: 100%;
            -webkit-appearance: none;
            background: transparent;
        }
        .control input[type=range]::-webkit-slider-runnable-track {
            height: 6px;
            background: rgba(255,255,255,0.3);
            border-radius: 3px;
        }
        .control input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            background: white;
            border-radius: 50%;
            margin-top: -4px;
            box-shadow: 0 0 4px rgba(0,0,0,0.4);
        }
        `;
        document.head.appendChild(style);

        // --- Panel UI ---
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
        `;
        document.body.appendChild(panel);

        // --- Slider Events ---
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

        // --- Draggable Panel ---
        makeDraggable(panel);
    }

    // Draggable Helper
    function makeDraggable(el) {
        let offsetX = 0, offsetY = 0, isDown = false;

        el.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'INPUT') return; // 슬라이더 클릭 무시
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
            el.style.bottom = 'auto'; // 자유 이동
        });
    }

    // Simple Impulse Response
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
