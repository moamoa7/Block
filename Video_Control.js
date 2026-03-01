function createFiltersWebGL(Utils) {
      const pipelines = new WeakMap();
      const tq = (v, st) => Math.round(v / st) * st;
      function compileShaderChecked(gl, type, source) { const shader = gl.createShader(type); if (!shader) throw new Error('gl.createShader failed'); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const info = gl.getShaderInfoLog(shader) || 'unknown error'; gl.deleteShader(shader); throw new Error(`Shader compile failed (${type}): ${info}`); } return shader; }
      function linkProgramChecked(gl, vs, fs) { const program = gl.createProgram(); if (!program) throw new Error('gl.createProgram failed'); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const info = gl.getProgramInfoLog(program) || 'unknown error'; gl.deleteProgram(program); throw new Error(`Program link failed: ${info}`); } return program; }

      function buildToneLUT256(toe, mid, shoulder, gain = 1.0) {
        const curve = computeToneCurve(256, VSC_CLAMP(toe / TOE_DIVISOR, -1, 1), VSC_CLAMP(mid, -1, 1), VSC_CLAMP(shoulder / 16, -1, 1), gain);
        const out = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) { const v = (curve[i] * 255 + 0.5) | 0, o = i * 4; out[o] = out[o+1] = out[o+2] = v; out[o+3] = 255; } return out;
      }

      const GL2_HDR = `#version 300 es\nprecision highp float;\nin vec2 vTexCoord;\nout vec4 outColor;\n#define TEX texture\n`;
      const GL1_HDR = `precision highp float;\nvarying vec2 vTexCoord;\n#define outColor gl_FragColor\n#define TEX texture2D\n`;
      const UNI_BLOCK = `uniform sampler2D uVideoTex;uniform sampler2D uToneTex;uniform vec4 uParams;uniform vec4 uParams2;uniform vec3 uRGBGain;uniform float uHDRToneMap;\n`;
      const hdr = (gl2) => (gl2 ? GL2_HDR : GL1_HDR) + UNI_BLOCK;

      const glslHDR = `
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
const mat3 M709to2020 = mat3(0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.0880, 0.8956);
vec3 reinhardToneMap(vec3 c, float wp) { return c * (1.0 + c / (wp * wp)) / (1.0 + c); }
vec3 linearToPQ(vec3 c) {
  vec3 Ym = pow(clamp(c / 10000.0, 0.0, 1.0), vec3(0.1593017578125));
  return pow((0.8359375 + 18.8515625 * Ym) / (1.0 + 18.6875 * Ym), vec3(78.84375));
}
vec3 applyHDRToneMap(vec3 color, float hdrEn) {
  if (hdrEn < 0.5) return color;
  return linearToPQ(reinhardToneMap(M709to2020 * srgbToLinear(color) * 200.0, 400.0));
}`;

      const glslCommon = `
const vec3 LUMA=vec3(0.2126,0.7152,0.0722);
float tone1(float y){return TEX(uToneTex,vec2(y*(255./256.)+(.5/256.),.5)).r;}
vec3 softClip(vec3 c,float knee){vec3 x=max(c-1.,vec3(0.));return c-(x*x)/(x+vec3(knee));}
vec3 applyGrading(vec3 color){
float y=dot(color,LUMA),y2=tone1(clamp(y,0.,1.)),ratio=y2/max(1e-4,y);color*=ratio;
color=(color-.5)*uParams.y+.5;
color=color*uParams.x+(uParams2.x/1000.);
if(uParams.w!=1.)color=pow(max(color,vec3(0.)),vec3(1./uParams.w));
float luma=dot(color,LUMA),hiLuma=clamp((luma-.72)/.28,0.,1.),satReduce=hiLuma*hiLuma*(3.-2.*hiLuma),currentSat=uParams.z*(1.-.05*satReduce);
color=luma+(color-luma)*currentSat;
color*=uRGBGain;
return clamp(softClip(color,.18),0.,1.);
}`;

      function buildFsColorOnly({ gl2 }) { return hdr(gl2) + glslHDR + glslCommon + `void main(){vec3 color=TEX(uVideoTex,vTexCoord).rgb;vec3 graded=applyGrading(color);outColor=vec4(applyHDRToneMap(graded,uHDRToneMap),1.);}`; }
      function buildFsSharpen({ gl2 }) { return hdr(gl2) + `uniform vec2 uResolution;uniform vec3 uSharpParams;\n` + glslHDR + glslCommon + `vec3 satMix(vec3 c,float sat){float l=dot(c,LUMA);return vec3(l)+(c-vec3(l))*sat;}vec3 rcasSharpen(sampler2D tex,vec2 uv,vec2 texel,float sharpAmount){vec3 b=TEX(tex,uv+vec2(0.,-texel.y)).rgb,d=TEX(tex,uv+vec2(-texel.x,0.)).rgb,e=TEX(tex,uv).rgb,f=TEX(tex,uv+vec2(texel.x,0.)).rgb,h=TEX(tex,uv+vec2(0.,texel.y)).rgb;vec3 mn=min(b,min(d,min(e,min(f,h)))),mx=max(b,max(d,max(e,max(f,h))));if(uParams2.z<.5){vec3 a=TEX(tex,uv+vec2(-texel.x,-texel.y)).rgb,c=TEX(tex,uv+vec2(texel.x,-texel.y)).rgb,g=TEX(tex,uv+vec2(-texel.x,texel.y)).rgb,i=TEX(tex,uv+vec2(texel.x,texel.y)).rgb;mn=min(mn,min(a,min(c,min(g,i))));mx=max(mx,max(a,max(c,max(g,i))));}float aAmt=clamp(sharpAmount,0.,1.),peak=-1./mix(9.,3.6,aAmt);vec3 hitMin=mn/(4.*mx+1e-4),hitMax=(peak-mx)/(4.*mn+peak);float lobe=max(-.1875,min(max(max(hitMin.r,hitMax.r),max(max(hitMin.g,hitMax.g),max(hitMin.b,hitMax.b))),0.));float edgeLuma=abs(dot(b-e,LUMA))+abs(dot(d-e,LUMA))+abs(dot(f-e,LUMA))+abs(dot(h-e,LUMA)),edgeDamp=1.-smoothstep(.05,.25,edgeLuma*.25);lobe*=mix(1.,edgeDamp,clamp(uSharpParams.z,0.,1.));return(lobe*(b+d+f+h)+e)/(4.*lobe+1.);}void main(){vec2 texel=1./uResolution;vec3 color=TEX(uVideoTex,vTexCoord).rgb;float sharpAmount=uParams2.y;if(sharpAmount>0.){color=rcasSharpen(uVideoTex,vTexCoord,texel,sharpAmount);vec3 d0=satMix(color,uSharpParams.x);color=mix(color,d0,uSharpParams.y);}vec3 graded=applyGrading(color);outColor=vec4(applyHDRToneMap(graded,uHDRToneMap),1.);}`; }
      function buildShaderSources(gl) { const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext); return { vs: isGL2 ? `#version 300 es\nin vec2 aPosition;\nin vec2 aTexCoord;\nout vec2 vTexCoord;\nvoid main(){\n gl_Position=vec4(aPosition,0.,1.);\n vTexCoord=aTexCoord;\n}` : `attribute vec2 aPosition;attribute vec2 aTexCoord;varying vec2 vTexCoord;void main(){gl_Position=vec4(aPosition,0.,1.);vTexCoord=aTexCoord;}`, fsColorOnly: buildFsColorOnly({ gl2: isGL2 }), fsSharpen: buildFsSharpen({ gl2: isGL2 }) }; }

      function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
      function getSharpProfile(vVals, rawW, rawH, isHdr) {
        const s1 = Number(vVals.sharp || 0), s2 = Number(vVals.sharp2 || 0), cl = Number(vVals.clarity || 0); if (s1 <= 0.01 && s2 <= 0.01 && cl <= 0.01) return { amount: 0.0, tapMode: 1.0, desatSat: 1.0, biasMix: 0.0, edgeDampMix: 0.4 };
        let level = 'S'; const isXL = (s1 >= 18 && s2 >= 16 && cl >= 24); if (isXL) level = 'XL'; else if (s1 >= 14 && (s2 >= 10 || cl >= 14)) level = 'L'; else if (s1 >= 10 && (s2 >= 6  || cl >= 8 )) level = 'M';
        const rawPx = rawW * rawH, pxScale = Math.sqrt(Math.max(1, rawPx) / (1280 * 720)), hiResN = clamp01((pxScale - 1.0) / 1.7), n1 = clamp01(s1 / 18.0), n2 = clamp01(s2 / 16.0), n3 = clamp01(cl / 24.0); let base = clamp01((0.58 * n1) + (0.28 * n2) + (0.24 * n3));
        let scale = 1.0, cap = 1.0, desatSat = 0.88, biasMix = 0.40, edgeDampMix = 0.33;
        if (level === 'S') { scale = 0.78; cap = 0.55; desatSat = 0.90; biasMix = 0.30; edgeDampMix = 0.38; } else if (level === 'M') { scale = 0.92; cap = 0.68; desatSat = 0.88; biasMix = 0.38; edgeDampMix = 0.33; } else if (level === 'L') { scale = 1.08; cap = 0.80; desatSat = 0.86; biasMix = 0.46; edgeDampMix = 0.28; } else { scale = 1.26; cap = 0.92; desatSat = 0.84; biasMix = 0.60; edgeDampMix = 0.22; }
        let amount = clamp01(base * scale); if (amount > cap) amount = cap; amount *= (1.0 - 0.25 * hiResN); if (rawPx >= 3840 * 2160) amount *= 0.80; if (isHdr) amount *= 0.92;
        return { amount, tapMode: ((rawPx >= (2560 * 1440) && amount < 0.80) || (amount < 0.12)) ? 1.0 : 0.0, desatSat, biasMix, edgeDampMix };
      }

      class WebGLPipeline {
        constructor() {
          this.canvas = null; this.gl = null; this.activeProgramKind = ''; this.videoTexture = null; this.video = null; this.active = false; this.vVals = null; this.originalParent = null; this._videoHidden = false; this._prevVideoOpacity = ''; this._prevVideoVisibility = ''; this.disabledUntil = 0; this._loopToken = 0; this._loopRunning = false; this._isGL2 = false; this._styleDirty = true; this._styleObs = null; this._lastStyleSyncT = 0; this._initialStyleSynced = false; this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; this.toneTexture = null; this._toneKey = ''; this._outputReady = false; this._timerId = 0; this._rvfcId = 0; this._rafId = 0; this._lastRawW = 0; this._lastRawH = 0; this._contextLostCount = 0; this._suspended = false; this._lastRenderT = 0; this._idleCheckTimer = 0; this._styleSyncTimer = 0; this._gpuTierEma = 0; this._paramsDirty = false;
          this._onContextLost = (e) => { e.preventDefault(); const now = performance.now(); this._contextLostCount = (this._contextLostCount || 0) + 1; this.disabledUntil = now + Math.min(30000, 3000 * Math.pow(1.5, this._contextLostCount)); this.active = false; this._loopToken++; this._loopRunning = false; if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; } try { if (this.canvas) this.canvas.style.opacity = '0'; } catch (_) {} try { const st = this.video ? getVState(this.video) : null; if (st) st.webglDisabledUntil = now + SYS.WFC; } catch (_) {} safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); };
          this._onContextRestored = () => {
            try {
              this._loopToken++; this._loopRunning = false;
              if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; }
              if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
              if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') {
                try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {}
                this._rvfcId = 0;
              }
              this.disposeGLResources({ keepCanvasListeners: true });
              if (this.initGLResourcesOnExistingCanvas()) {
                if (this.video) {
                  this.active = true; this._outputReady = false;
                  this.canvas.style.opacity = '0';
                  this.startRenderLoop();
                }
              } else {
                if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; }
                if (this.canvas?.parentNode) this.canvas.style.opacity = '0';
                this.disabledUntil = performance.now() + 5000;
                safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard());
              }
            } catch (_) {
              if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; }
              this.disabledUntil = performance.now() + 5000;
              safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard());
            }
          };
        }
        ensureCanvas() { if (this.canvas) return; this.canvas = document.createElement('canvas'); this.canvas.style.cssText = `position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;display:block!important;pointer-events:none!important;margin:0!important;padding:0!important;contain:strict!important;will-change:transform,opacity!important;opacity:0!important;`; this.canvas.addEventListener('webglcontextlost', this._onContextLost, { passive: false }); this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, OPT_P); }
        _bindProgramHandles(program, key) { const gl = this.gl; gl.useProgram(program); const handles = { program, uResolution: gl.getUniformLocation(program, 'uResolution'), uVideoTex: gl.getUniformLocation(program, 'uVideoTex'), uToneTex: gl.getUniformLocation(program, 'uToneTex'), uParams: gl.getUniformLocation(program, 'uParams'), uParams2: gl.getUniformLocation(program, 'uParams2'), uRGBGain: gl.getUniformLocation(program, 'uRGBGain'), uSharpParams: gl.getUniformLocation(program, 'uSharpParams'), uHDRToneMap: gl.getUniformLocation(program, 'uHDRToneMap'), aPosition: gl.getAttribLocation(program, 'aPosition'), aTexCoord: gl.getAttribLocation(program, 'aTexCoord') }; if (handles.uVideoTex) gl.uniform1i(handles.uVideoTex, 0); if (handles.uToneTex) gl.uniform1i(handles.uToneTex, 1); this[`handles_${key}`] = handles; }
        initGLResourcesOnExistingCanvas() {
          this.ensureCanvas(); let gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }); this._isGL2 = !!gl; if (!gl) gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }); if (!gl) return false; this.gl = gl;
          try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); } catch (_) {}
          const src = buildShaderSources(gl);
          try {
            const vs = compileShaderChecked(gl, gl.VERTEX_SHADER, src.vs), fsColor = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsColorOnly), fsSharp = compileShaderChecked(gl, gl.FRAGMENT_SHADER, src.fsSharpen);
            const programColor = linkProgramChecked(gl, vs, fsColor), programSharp = linkProgramChecked(gl, vs, fsSharp); gl.deleteShader(vs); gl.deleteShader(fsColor); gl.deleteShader(fsSharp);
            this._bindProgramHandles(programColor, 'color'); this._bindProgramHandles(programSharp, 'sharp'); this.activeProgramKind = '';
            const vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]); const tCoords = new Float32Array([0,0, 1,0, 0,1, 1,1]);
            this.vBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); this.tBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.bufferData(gl.ARRAY_BUFFER, tCoords, gl.STATIC_DRAW);
            this.videoTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            this.toneTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            const id = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { const o = i * 4; id[o] = id[o+1] = id[o+2] = i; id[o+3] = 255; } gl.texImage2D(gl.TEXTURE_2D, 0, this._isGL2 ? gl.RGBA8 : gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, id);
            this._toneKey = '';
            return true;
          } catch (err) { log.warn('WebGL Init Error:', err.message); this.disposeGLResources(); return false; }
        }
        suspendContext() {
          if (!this.gl) return;
          this._loopToken++; this._loopRunning = false;
          if (this._videoHidden && this.video) { this.video.style.opacity = this._prevVideoOpacity; this.video.style.visibility = this._prevVideoVisibility; this._videoHidden = false; }
          if (this.canvas) this.canvas.style.opacity = '0';
          this.disposeGLResources({ keepCanvasListeners: true });
          this._suspended = true; log.debug('WebGL context suspended for idle video');
        }
        resumeContext() {
          if (!this._suspended) return true;
          this._suspended = false; this._paramsDirty = true; this._toneKey = ''; this.activeProgramKind = '';
          if (!this.initGLResourcesOnExistingCanvas()) { this.disabledUntil = performance.now() + 5000; return false; }
          this._outputReady = false; this.canvas.style.opacity = '0'; this.startRenderLoop();
          return true;
        }
        startIdleWatch() {
          if (this._idleCheckTimer) return;
          this._idleCheckTimer = setInterval(() => {
            if (!this.active) { this.stopIdleWatch(); return; }
            if (performance.now() - this._lastRenderT > 10000) this.suspendContext();
          }, 5000);
        }
        stopIdleWatch() { if (this._idleCheckTimer) { clearInterval(this._idleCheckTimer); this._idleCheckTimer = 0; } }
        init() { return this.initGLResourcesOnExistingCanvas(); }
        attachToVideo(video) {
          if (this._suspended) { this.video = video; if (!this.resumeContext()) return false; }
          else if (!this.active && !this.init()) return false;
          this.video = video; this.originalParent = video.parentNode; this._videoHidden = false; this._outputReady = false; this._paramsDirty = true; this._toneKey = ''; this.activeProgramKind = ''; this.canvas.style.opacity = '0';
          if (this.originalParent) { const cs = window.getComputedStyle(this.originalParent); if (cs.position === 'static') { this._parentPrevPosition = this.originalParent.style.position || ''; this.originalParent.style.position = 'relative'; this._parentStylePatched = true; this._patchedParent = this.originalParent; } if (video.nextSibling) this.originalParent.insertBefore(this.canvas, video.nextSibling); else this.originalParent.appendChild(this.canvas); }
          if (this._styleObs) this._styleObs.disconnect(); this._styleObs = new MutationObserver(() => { this._styleDirty = true; }); try { this._styleObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) {}
          try { video.addEventListener('transitionend', () => { this._styleDirty = true; }, OPT_P); } catch (_) {}
          this._styleDirty = true;
          if (this._styleSyncTimer) clearInterval(this._styleSyncTimer);
          this._styleSyncTimer = setInterval(() => { if (!this.active || !this.video || !this.canvas) return; this._syncStylesDeferred(); }, 600);
          this.active = true; this.startRenderLoop(); this.startIdleWatch(); return true;
        }
        updateParams(vVals) { this.vVals = vVals; this._paramsDirty = true; }
        _syncStylesDeferred() {
          if (!this._styleDirty) return;
          this._styleDirty = false;
          requestAnimationFrame(() => {
            if (!this.canvas || !this.video) return;
            const vs = window.getComputedStyle(this.video), cs = this.canvas.style;
            if (cs.objectFit !== vs.objectFit) cs.objectFit = vs.objectFit || 'contain';
            if (cs.objectPosition !== vs.objectPosition) cs.objectPosition = vs.objectPosition;
            const tr = vs.transform, nextTr = (tr && tr !== 'none') ? tr : '';
            if (cs.transform !== nextTr) { cs.transform = nextTr; cs.transformOrigin = vs.transformOrigin || ''; }
            if (!this._initialStyleSynced) {
              this._initialStyleSynced = true;
              cs.borderRadius = vs.borderRadius || ''; cs.clipPath = vs.clipPath || ''; cs.webkitClipPath = vs.webkitClipPath || ''; cs.mixBlendMode = vs.mixBlendMode || ''; cs.isolation = vs.isolation || '';
            }
            const vz = vs.zIndex; let zi = '1'; if (vz && vz !== 'auto') { const n = parseInt(vz, 10); if (Number.isFinite(n)) { zi = String(Math.min(n + 1, 2147483646)); } } if (cs.zIndex !== zi) cs.zIndex = zi;
          });
        }
        render() {
          if (!this.active || !this.gl || !this.video || !this.vVals) return; const gl = this.gl, video = this.video, now = performance.now(); if (now < this.disabledUntil) return;
          const st = getVState(video); if (st.webglDisabledUntil && now < st.webglDisabledUntil) return; if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
          this._lastRenderT = now;
          if (this.canvas.parentNode !== video.parentNode && video.parentNode) { this.originalParent = video.parentNode; const p = video.parentNode; if (video.nextSibling) p.insertBefore(this.canvas, video.nextSibling); else p.appendChild(this.canvas); }
          let rawW = video.videoWidth, rawH = video.videoHeight; const dpr = Math.min(window.devicePixelRatio || 1, 2), displayW = video.clientWidth * dpr, displayH = video.clientHeight * dpr;
          const qs = window.__VSC_INTERNAL__?.App?.getQualityScale?.() || 1.0;
          if (!this._gpuTierEma) this._gpuTierEma = 2160;
          const rawTier = (qs > 0.9) ? 2160 : (qs > 0.7) ? 1440 : 1080;
          this._gpuTierEma += (rawTier - this._gpuTierEma) * 0.15;
          const gpuTier = Math.round(this._gpuTierEma / 120) * 120;
          const MAX_W = Math.min(3840, Math.max(displayW, 640)), MAX_H = Math.min(gpuTier, Math.max(displayH, 360));
          let w = rawW, h = rawH; if (w > MAX_W || h > MAX_H) { const scale = Math.min(MAX_W / w, MAX_H / h); w = Math.round(w * scale); h = Math.round(h * scale); }
          const isHdr = VSC_MEDIA.isHdr, prof = getSharpProfile(this.vVals, rawW, rawH, isHdr), useSharpen = prof.amount > 0.0, kind = useSharpen ? 'sharp' : 'color', H = useSharpen ? this.handles_sharp : this.handles_color;
          let programChanged = false; const paramsDirty = this._paramsDirty; this._paramsDirty = false; if (this.activeProgramKind !== kind) { this.activeProgramKind = kind; programChanged = true; gl.useProgram(H.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.vBuf); gl.enableVertexAttribArray(H.aPosition); gl.vertexAttribPointer(H.aPosition, 2, gl.FLOAT, false, 0, 0); gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf); gl.enableVertexAttribArray(H.aTexCoord); gl.vertexAttribPointer(H.aTexCoord, 2, gl.FLOAT, false, 0, 0); }
          const resized = (this.canvas.width !== w || this.canvas.height !== h); if (resized) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
          if ((resized || programChanged || paramsDirty || this._lastRawW !== rawW || this._lastRawH !== rawH) && H.uResolution) { gl.uniform2f(H.uResolution, rawW, rawH); this._lastRawW = rawW; this._lastRawH = rawH; }
          const rs = this.vVals._rs ?? 1, gs = this.vVals._gs ?? 1, bs = this.vVals._bs ?? 1; if (H.uParams) gl.uniform4f(H.uParams, this.vVals.gain || 1.0, this.vVals.contrast || 1.0, this.vVals.satF || 1.0, this.vVals.gamma || 1.0);
          const hiReduce = isHdr ? 0.82 : 0.88; if (H.uParams2) gl.uniform4f(H.uParams2, this.vVals.bright || 0.0, useSharpen ? prof.amount : 0.0, prof.tapMode, hiReduce);
          if (H.uRGBGain) gl.uniform3f(H.uRGBGain, rs, gs, bs); if (useSharpen && H.uSharpParams) gl.uniform3f(H.uSharpParams, prof.desatSat, prof.biasMix, prof.edgeDampMix);
          const hdrToneMap = (this.vVals._hdrToneMap && isHdr) ? 1.0 : 0.0; if (H.uHDRToneMap !== undefined && H.uHDRToneMap !== null) gl.uniform1f(H.uHDRToneMap, hdrToneMap);
          const toe = this.vVals.toe || 0, mid = this.vVals.mid || 0, shoulder = this.vVals.shoulder || 0, toneKey = `${tq(toe, 0.2)}|${tq(mid, 0.02)}|${tq(shoulder, 0.2)}|${tq(this.vVals.gain || 1, 0.06)}`;
          if (paramsDirty) this._toneKey = '';
          if (this._toneKey !== toneKey && this.toneTexture) { this._toneKey = toneKey; const lut = buildToneLUT256(toe, mid, shoulder, this.vVals.gain || 1.0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut); }
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTexture);
          try {
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            try {
              if (this._isGL2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
              else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            } catch (_) {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); st.webglFailCount = 0;
            if (!this._outputReady) { this._outputReady = true; if (!this._videoHidden) { this._prevVideoOpacity = video.style.opacity; this._prevVideoVisibility = video.style.visibility; video.style.setProperty('opacity', '0.001', 'important'); this._videoHidden = true; } this.canvas.style.opacity = '1'; }
          } catch (err) {
            st.webglFailCount = (st.webglFailCount || 0) + 1; if (CONFIG.DEBUG) log.warn('WebGL render failure:', err);
            const msg = String(err?.message || err || ''), looksTaint = /SecurityError|cross.origin|cross-origin|taint|insecure|Tainted|origin/i.test(msg);
            if (st.webglFailCount >= SYS.WFT) { st.webglFailCount = 0; if (looksTaint) { st.webglTainted = true; log.warn('WebGL tainted/CORS-like failure → fallback to SVG'); } else { if (st) st.webglDisabledUntil = now + SYS.WFC; log.warn('WebGL transient failure → cooldown then retry'); } safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); }
          }
        }
        startRenderLoop() { if (this._loopRunning) return; this._loopRunning = true; const token = ++this._loopToken; const loopFn = (now, meta) => { if (token !== this._loopToken || !this.active || !this.video) { this._loopRunning = false; return; } this.render(); this.scheduleNextFrame(loopFn); }; this.scheduleNextFrame(loopFn); }
        scheduleNextFrame(loopFn) {
          const pausedOrHidden = !!(document.hidden || this.video?.paused); if (pausedOrHidden) { this._timerId = setTimeout(() => { this._timerId = 0; loopFn(performance.now(), null); }, 220); return; }
          if (this.video && typeof this.video.requestVideoFrameCallback === 'function') { this._rvfcId = this.video.requestVideoFrameCallback(loopFn); return; }
          this._rafId = requestAnimationFrame(loopFn);
        }
        disposeGLResources(opts = {}) {
          const { keepCanvasListeners = false } = opts; const gl = this.gl;
          if (gl) { try { if (this.videoTexture) { gl.deleteTexture(this.videoTexture); this.videoTexture = null; } if (this.toneTexture) { gl.deleteTexture(this.toneTexture); this.toneTexture = null; } if (this.vBuf) { gl.deleteBuffer(this.vBuf); this.vBuf = null; } if (this.tBuf) { gl.deleteBuffer(this.tBuf); this.tBuf = null; } if (this.handles_color?.program) gl.deleteProgram(this.handles_color.program); if (this.handles_sharp?.program) gl.deleteProgram(this.handles_sharp.program); } catch (_) {} }
          if (!keepCanvasListeners && this.canvas) { try { this.canvas.removeEventListener('webglcontextlost', this._onContextLost); this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored); } catch (_) {} }
          this.gl = null; this.activeProgramKind = '';
        }
        shutdown() {
          this.stopIdleWatch();
          if (this._styleSyncTimer) { clearInterval(this._styleSyncTimer); this._styleSyncTimer = 0; }
          this.active = false; this._loopToken++; this._loopRunning = false; if (this._timerId) { clearTimeout(this._timerId); this._timerId = 0; } if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
          if (this.video && this._rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') { try { this.video.cancelVideoFrameCallback(this._rvfcId); } catch (_) {} this._rvfcId = 0; }
          if (this._styleObs) { this._styleObs.disconnect(); this._styleObs = null; }
          const videoRef = this.video; const prevOpacity = this._prevVideoOpacity; const prevVisibility = this._prevVideoVisibility; const wasHidden = this._videoHidden;
          this._videoHidden = false;
          try { if (this.canvas && this.canvas.parentNode) { this.canvas.remove(); } } catch (_) {}
          if (this._parentStylePatched && this._patchedParent) { try { this._patchedParent.style.position = this._parentPrevPosition; } catch (_) {} this._parentStylePatched = false; this._parentPrevPosition = ''; this._patchedParent = null; }
          this.disposeGLResources();
          if (wasHidden && videoRef) { videoRef.style.opacity = prevOpacity; videoRef.style.visibility = prevVisibility; }
        }
      }
      return { apply: (el, vVals) => { let pipe = pipelines.get(el); if (!pipe) { pipe = new WebGLPipeline(); pipelines.set(el, pipe); } if (!pipe.active || pipe.video !== el || !pipe.gl) { if (!pipe.attachToVideo(el)) { pipelines.delete(el); return false; } pipe._paramsDirty = true; pipe._toneKey = ''; pipe.activeProgramKind = ''; } pipe.updateParams(vVals); return true; }, clear: (el) => { const pipe = pipelines.get(el); if (pipe) { pipe.shutdown(); pipelines.delete(el); } }, __getPipeline: (el) => pipelines.get(el) || null };
    }

    function probeWebGLCapability() {
      if (probeWebGLCapability._result !== undefined) return probeWebGLCapability._result;
      const result = { supported: false, tier: 'none', maxTextureSize: 0, failReason: '' };
      try {
        const c = document.createElement('canvas'); c.width = 2; c.height = 2;
        const opts = CONFIG.IS_MOBILE ? undefined : { failIfMajorPerformanceCaveat: true };
        let gl = c.getContext('webgl2', opts) || c.getContext('webgl', opts);
        let hadCaveat = false;
        if (!gl && !CONFIG.IS_MOBILE) {
          gl = c.getContext('webgl2') || c.getContext('webgl');
          hadCaveat = !!gl;
        }
        if (!gl) { result.failReason = 'no-webgl'; }
        else {
          result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          if (CONFIG.IS_MOBILE) {
            if (result.maxTextureSize < 4096) {
              result.failReason = 'low-end-mobile-gpu';
            } else {
              result.supported = true;
              result.tier = result.maxTextureSize >= 8192 ? 'high' : 'medium';
            }
          } else if (hadCaveat) {
            result.supported = true; result.tier = 'low'; result.failReason = 'performance-caveat';
          } else {
            result.supported = true;
            result.tier = (result.maxTextureSize >= 16384) ? 'high' : (result.maxTextureSize >= 8192) ? 'medium' : 'low';
          }
          try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
        }
      } catch (e) { result.failReason = e.message || 'probe-error'; }
      probeWebGLCapability._result = result; return result;
    }

    function resolveRenderMode(storeMode, video) {
      if (storeMode === 'svg') return 'svg';
      if (storeMode === 'webgl') return 'webgl';
      const probe = probeWebGLCapability();
      if (!probe.supported) return 'svg';
      if (video) {
        const st = getVState(video);
        if (st.webglTainted) return 'svg';
        if (st.webglDisabledUntil && performance.now() < st.webglDisabledUntil) return 'svg';
      }
      if (probe.tier === 'low') {
        if (probe.failReason === 'performance-caveat' && probe.maxTextureSize >= 8192) return 'webgl';
        return 'svg';
      }
      return 'webgl';
    }

    function createBackendAdapter(Filters, FiltersGL) {
      let activeContextCount = 0;
      const fallbackTracker = new WeakMap();
      return {
        apply(video, storeMode, vVals) {
          const st = getVState(video); const now = performance.now();
          const effectiveRequestedMode = resolveRenderMode(storeMode, video);
          const tracker = fallbackTracker.get(video) || { attempts: 0, lastAttempt: 0 };

          const webglAllowed = (effectiveRequestedMode === 'webgl' && !st.webglTainted && !(st.webglDisabledUntil && now < st.webglDisabledUntil));
          const contextLimitReached = webglAllowed && activeContextCount >= SYS.MAX_CTX;
          const effectiveMode = (webglAllowed && !contextLimitReached) ? 'webgl' : 'svg';

          const prevBackend = st.fxBackend;
          if (effectiveMode === 'webgl') {
              const wasWebGL = (prevBackend === 'webgl');
              if (!wasWebGL) activeContextCount++;

              if (!FiltersGL.apply(video, vVals)) {
                if (!wasWebGL) activeContextCount = Math.max(0, activeContextCount - 1);
                FiltersGL.clear(video);
                tracker.attempts++; tracker.lastAttempt = now;
                if (tracker.attempts >= 3) {
                  const backoffMs = Math.min(30000, 5000 * Math.pow(1.5, tracker.attempts - 3));
                  st.webglDisabledUntil = now + backoffMs;
                }
                fallbackTracker.set(video, tracker);
                Filters.applyUrl(video, Filters.prepareCached(video, vVals));
                st.fxBackend = 'svg';
                return;
              }

              if (tracker.attempts > 0) {
                tracker.attempts = Math.max(0, tracker.attempts - 1);
                fallbackTracker.set(video, tracker);
              }

              if (prevBackend === 'svg') {
                const pipe = FiltersGL.__getPipeline ? FiltersGL.__getPipeline(video) : null;
                if (pipe && !pipe._outputReady) {
                  if (!st._svgDeferredClear) {
                    st._svgDeferredClear = true;
                    const pollClear = () => {
                      if (st.fxBackend !== 'webgl' || !pipe.active) {
                        st._svgDeferredClear = false;
                        return;
                      }
                      if (!pipe._outputReady) {
                        requestAnimationFrame(pollClear);
                        return;
                      }
                      Filters.clear(video);
                      Filters.invalidateCache(video);
                      st._svgDeferredClear = false;
                    };
                    requestAnimationFrame(pollClear);
                  }
                } else {
                  Filters.clear(video);
                  Filters.invalidateCache(video);
                  st._svgDeferredClear = false;
                }
              }
              st.fxBackend = 'webgl';
          } else {
              if (prevBackend === 'webgl') {
                FiltersGL.clear(video);
                activeContextCount = Math.max(0, activeContextCount - 1);
                Filters.invalidateCache(video);
              }
              st._svgDeferredClear = false;
              const svgResult = Filters.prepareCached(video, vVals);
              Filters.applyUrl(video, { url: svgResult.url, changed: (prevBackend === 'webgl') });
              st.fxBackend = 'svg';
          }
        },
        clear(video) {
          const st = getVState(video);
          if (st.fxBackend === 'webgl') { activeContextCount = Math.max(0, activeContextCount - 1); FiltersGL.clear(video); }
          else if (st.fxBackend === 'svg') { Filters.clear(video); }
          st.fxBackend = null;
        }
      };
    }

    function bindElementDrag(el, onMove, onEnd) {
      const ac = new AbortController();
      const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); };
      const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
      on(el, 'pointermove', move, { passive: false, signal: ac.signal });
      on(el, 'pointerup', up, { signal: ac.signal });
      on(el, 'pointercancel', up, { signal: ac.signal });
      return () => { ac.abort(); };
    }

    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null; let hasUserDraggedUI = false;
      const uiWakeCtrl = new AbortController();
      const uiUnsubs = [];
      const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
      const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); } catch (_) {} try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
      const allowUiInThisDoc = () => { if (registry.videos.size > 0) return true; return !!document.querySelector('video, object, embed'); };

      function setAndHint(path, value) {
        const prev = sm.get(path);
        const changed = !Object.is(prev, value);
        if (changed) sm.set(path, value);
        (changed ? ApplyReq.hard() : ApplyReq.soft());
      }

      const getUiRoot = () => {
        const fs = document.fullscreenElement || null;
        if (fs) {
          if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body;
          if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs;
          return fs;
        }
        return document.documentElement || document.body;
      }

      function bindReactive(btn, paths, apply, sm, sub) {
        const pathArr = Array.isArray(paths) ? paths : [paths];
        const sync = () => { if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); };
        pathArr.forEach(p => sub(p, sync)); sync(); return sync;
      }

      function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false, isBitmask = false }) {
        const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
        for (const it of items) {
          const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text);
          b.onclick = (e) => {
            e.stopPropagation();
            if (isBitmask) {
              sm.set(key, ShadowMask.toggle(sm.get(key), it.value));
            } else {
              const cur = sm.get(key);
              if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
              else setAndHint(key, it.value);
            }
            ApplyReq.hard();
          };
          bindReactive(b, [key], (el, v) => el.classList.toggle('active', isBitmask ? ShadowMask.has(v, it.value) : v === it.value), sm, sub);
          row.append(b);
        }
        const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
        offBtn.onclick = (e) => { e.stopPropagation(); sm.set(key, isBitmask ? 0 : offValue); ApplyReq.hard(); };
        bindReactive(offBtn, [key], (el, v) => el.classList.toggle('active', isBitmask ? (Number(v)|0) === 0 : v === offValue), sm, sub);
        if (isBitmask || offValue != null) row.append(offBtn);
        return row;
      }

      const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));

      const clampPanelIntoViewport = () => {
        try {
          if (!container) return;
          const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main');
          if (!mainPanel || mainPanel.style.display === 'none') return;
          if (!hasUserDraggedUI) {
            mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = '';
            queueMicrotask(() => {
              const r = mainPanel.getBoundingClientRect();
              if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) {
                mainPanel.style.right = '70px';
                mainPanel.style.top = '50%';
                mainPanel.style.transform = 'translateY(-50%)';
              }
            });
            return;
          }
          const r = mainPanel.getBoundingClientRect(); if (!r.width && !r.height) return;
          const vv = window.visualViewport;
          const vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0);
          const vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
          const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0;
          const offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
          if (!vw || !vh) return;
          const w = r.width || 300, panH = r.height || 400;
          const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8));
          const top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));
          if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
          requestAnimationFrame(() => {
            mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
          });
        } catch (_) {}
      };

      const syncVVVars = () => {
        try {
          const root = document.documentElement, vv = window.visualViewport;
          if (!root || !vv) return;
          root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`);
          root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`);
        } catch (_) {}
      };

      syncVVVars();
      try {
        const vv = window.visualViewport;
        if (vv) {
          on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal });
          on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiWakeCtrl.signal });
        }
      } catch (_) {}

      const onLayoutChange = () => queueMicrotask(clampPanelIntoViewport);
      on(window, 'resize', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });
      on(window, 'orientationchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });
      on(document, 'fullscreenchange', onLayoutChange, { passive: true, signal: uiWakeCtrl.signal });

      const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

      const build = () => {
        if (container) return;

        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' }), shadow = host.attachShadow({ mode: 'open' });
        const style = `:host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:auto;bottom:max(12px,calc(env(safe-area-inset-bottom,0px) + 12px));right:max(12px,calc(env(safe-area-inset-right,0px) + 12px));left:max(12px,calc(env(safe-area-inset-left,0px) + 12px));transform:none;width:auto;max-height:70vh;padding:12px;border-radius:14px}.prow{flex-wrap:wrap}.btn,.pbtn{min-height:38px;font-size:12px}}.header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);

        const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

        const rmBtn = h('button', { id: 'rm-btn', class: 'btn fill-active' });
        rmBtn.onclick = (e) => {
          e.stopPropagation();
          const cur = sm.get(P.APP_RENDER_MODE);
          const next = cur === 'auto' ? 'webgl' : (cur === 'webgl' ? 'svg' : 'auto');
          const activeV = window.__VSC_APP__?.getActiveVideo?.();
          if (activeV) {
            const vst = getVState(activeV);
            if (window.__VSC_INTERNAL__?.Adapter) {
              window.__VSC_INTERNAL__.Adapter.clear(activeV);
            }
            if (next !== 'svg') {
              vst.webglTainted = false;
              vst.webglFailCount = 0;
              vst.webglDisabledUntil = 0;
            }
            vst._svgDeferredClear = false;
          }
          sm.set(P.APP_RENDER_MODE, next);
          if (next === 'svg') sm.set(P.APP_HDR_TONEMAP, false);
          ApplyReq.hard();
        };
        bindReactive(rmBtn, [P.APP_RENDER_MODE], (el, v) => {
          const labels = { auto: '🎨 Auto', webgl: '🎨 WebGL', svg: '🎨 SVG' };
          const colors = { auto: '#2ecc71', webgl: '#ffaa00', svg: '#88ccff' };
          el.textContent = labels[v] || labels.auto;
          el.style.color = colors[v] || colors.auto;
          el.style.borderColor = colors[v] || colors.auto;
          el.style.background = 'var(--btn-bg)';
        }, sm, sub);

        const hdrBtn = h('button', { class: 'btn' }, '🎬 Rec.2020');
        hdrBtn.onclick = (e) => {
          e.stopPropagation();
          if (CONFIG.IS_MOBILE) {
            hdrBtn.textContent = '모바일 미지원';
            setTimeout(() => { hdrBtn.textContent = '🎬 Rec.2020'; }, 2000);
            return;
          }
          if (!VSC_MEDIA.isHdr) {
            hdrBtn.textContent = '⚠️ HDR 미감지';
            setTimeout(() => { hdrBtn.textContent = '🎬 Rec.2020'; }, 2000);
            return;
          }
          const nextHdr = !sm.get(P.APP_HDR_TONEMAP);
          sm.set(P.APP_HDR_TONEMAP, nextHdr);
          if (nextHdr && sm.get(P.APP_RENDER_MODE) === 'svg') {
            sm.set(P.APP_RENDER_MODE, 'auto');
          }
          ApplyReq.hard();
        };
        bindReactive(hdrBtn, [P.APP_HDR_TONEMAP, P.APP_RENDER_MODE], (el, v, rMode) => {
          el.classList.toggle('active', !!(v && rMode !== 'svg'));
          if (CONFIG.IS_MOBILE) {
            el.style.opacity = '0.3';
            el.style.cursor = 'not-allowed';
            el.title = '모바일 기기 자체 하드웨어 톤맵 사용을 권장합니다.';
          } else {
            el.style.opacity = VSC_MEDIA.isHdr ? '1' : '0.4';
            el.style.cursor = 'pointer';
            el.title = '';
          }
        }, sm, sub);

        const autoSceneBtn = h('button', { class: 'btn', style: 'flex: 1.2;' }, '✨ 자동 씬');
        bindReactive(autoSceneBtn, [P.APP_AUTO_SCENE], (el, v) => el.classList.toggle('active', !!v), sm, sub);
        autoSceneBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); };

        const pipBtn = h('button', { class: 'btn', style: 'flex: 0.9;', onclick: async (e) => { e.stopPropagation(); const v = window.__VSC_APP__?.getActiveVideo(); if(v) await togglePiPFor(v); } }, '📺 PIP');

        const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 0.9;' }, '🔍 줌');
        zoomBtn.onclick = (e) => {
          e.stopPropagation();
          const zm = window.__VSC_INTERNAL__.ZoomManager;
          const v = window.__VSC_APP__?.getActiveVideo();
          if (!zm || !v) return;
          if (zm.isZoomed(v)) {
            zm.resetZoom(v);
            setAndHint(P.APP_ZOOM_EN, false);
          } else {
            const rect = v.getBoundingClientRect();
            zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
            setAndHint(P.APP_ZOOM_EN, true);
          }
        };
        bindReactive(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.5;' }, '🔊 Brickwall (EQ+Dyn)');
        boostBtn.onclick = (e) => {
          e.stopPropagation();
          if (window.__VSC_INTERNAL__?.AudioWarmup) window.__VSC_INTERNAL__.AudioWarmup();
          setAndHint(P.A_EN, !sm.get(P.A_EN));
        };
        bindReactive(boostBtn, [P.A_EN], (el, v) => el.classList.toggle('active', !!v), sm, sub);

        const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 AI');
        dialogueBtn.onclick = (e) => {
          e.stopPropagation();
          if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE));
        };
        bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN], (el, v, aEn) => {
          el.classList.toggle('active', !!(v && aEn));
          el.style.opacity = aEn ? '1' : '0.35';
          el.style.cursor = aEn ? 'pointer' : 'not-allowed';
        }, sm, sub);

        const pwrBtn = h('button', { id: 'pwr-btn', class: 'btn', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
        bindReactive(pwrBtn, [P.APP_ACT], (el, v) => el.style.color = v ? '#2ecc71' : '#e74c3c', sm, sub);

        const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
        advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
        bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

        const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
          renderButtonRow({
            label: '블랙', key: P.V_SHADOW_MASK, isBitmask: true,
            items: [
              { text: '외암', value: SHADOW_BAND.OUTER, title: '옅은 암부 진하게 (중간톤 대비 향상)' },
              { text: '중암', value: SHADOW_BAND.MID, title: '가운데 암부 진하게 (무게감 증가)' },
              { text: '심암', value: SHADOW_BAND.DEEP, title: '가장 진한 블랙 (들뜬 블랙 제거)' }
            ]
          }),
          renderButtonRow({ label: '복구', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
          renderButtonRow({ label: '밝기', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }),
          h('hr'),
          (() => {
            const r = h('div', { class: 'prow' });
            r.append(h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '오디오'));

            const mb = h('button', { class: 'pbtn', style: 'flex:1' }, '🎚️ 멀티밴드');
            mb.onclick = (e) => { e.stopPropagation(); if(sm.get(P.A_EN)) setAndHint(P.A_MULTIBAND, !sm.get(P.A_MULTIBAND)); };
            bindReactive(mb, [P.A_MULTIBAND, P.A_EN], (el, v, aEn) => {
              el.classList.toggle('active', !!(v && aEn));
              el.style.opacity = aEn ? '1' : '0.35';
              el.style.cursor = aEn ? 'pointer' : 'not-allowed';
            }, sm, sub);

            const lf = h('button', { class: 'pbtn', style: 'flex:1' }, '📊 LUFS 정규화');
            lf.onclick = (e) => { e.stopPropagation(); if(sm.get(P.A_EN)) setAndHint(P.A_LUFS, !sm.get(P.A_LUFS)); };
            bindReactive(lf, [P.A_LUFS, P.A_EN], (el, v, aEn) => {
              el.classList.toggle('active', !!(v && aEn));
              el.style.opacity = aEn ? '1' : '0.35';
              el.style.cursor = aEn ? 'pointer' : 'not-allowed';
            }, sm, sub);

            r.append(mb, lf);
            return r;
          })()
        ]);

        bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

        const bodyMain = h('div', { id: 'p-main' }, [
          h('div', { class: 'prow' }, [ rmBtn, hdrBtn ]),
          h('div', { class: 'prow' }, [ autoSceneBtn, pipBtn, zoomBtn ]),
          h('div', { class: 'prow' }, [ boostBtn, dialogueBtn ]),
          h('div', { class: 'prow' }, [
            h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
            pwrBtn,
            h('button', { class: 'btn', onclick: (e) => {
              e.stopPropagation();
              sm.batch('video', DEFAULTS.video);
              sm.batch('audio', DEFAULTS.audio);
              sm.batch('playback', DEFAULTS.playback);
              sm.set(P.APP_AUTO_SCENE, false);
              sm.set(P.APP_HDR_TONEMAP, false);
              ApplyReq.hard();
            } }, '↺ 리셋')
          ]),
          renderButtonRow({ label: '샤프', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: k, value: k })) }),
          advToggleBtn,
          advContainer,
          h('hr'),
          h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
            const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
            b.onclick = (e) => { e.stopPropagation(); setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); };
            bindReactive(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => { el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01); }, sm, sub);
            return b;
          }))
        ]);

        const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]);
        shadow.append(mainPanel);

        let stopDrag = null;
        const startPanelDrag = (e) => {
          const pt = (e && e.touches && e.touches[0]) ? e.touches[0] : e;
          if (!pt) return;
          if (e.target && e.target.tagName === 'BUTTON') return;
          if (e.cancelable) e.preventDefault();
          stopDrag?.();
          hasUserDraggedUI = true;
          let startX = pt.clientX, startY = pt.clientY;
          const rect = mainPanel.getBoundingClientRect();

          mainPanel.style.transform = 'none';
          mainPanel.style.top = `${rect.top}px`;
          mainPanel.style.right = 'auto';
          mainPanel.style.left = `${rect.left}px`;

          try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}

          stopDrag = bindElementDrag(dragHandle, (ev) => {
            const mv = (ev && ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
            if (!mv) return;
            const dx = mv.clientX - startX, dy = mv.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx));
            let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
            mainPanel.style.left = `${nextLeft}px`;
            mainPanel.style.top = `${nextTop}px`;
          }, () => {
            stopDrag = null;
          });
        };

        on(dragHandle, 'pointerdown', startPanelDrag);
        on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });

        container = host;
        getUiRoot().appendChild(container);
      };

      const ensureGear = () => {
        if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
        if (gearHost) { gearHost.style.display = 'block'; return; }
        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${CONFIG.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
        const styleEl = document.createElement('style');
        styleEl.textContent = style;
        shadow.appendChild(styleEl);
        let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear' }, '⚙');
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1';
          clearTimeout(fadeTimer);
          const inFs = !!document.fullscreenElement;
          if (inFs || CONFIG.IS_MOBILE) return;
          fadeTimer = setTimeout(() => {
            if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; }
          }, 2500);
        };
        wakeGear = wake;
        on(window, 'mousemove', wake, { passive: true, signal: uiWakeCtrl.signal });
        on(window, 'touchstart', wake, { passive: true, signal: uiWakeCtrl.signal });
        bootWakeTimer = setTimeout(wake, 2000);
        const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return;
          dragThresholdMet = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
          stopDrag = bindElementDrag(gearBtn, (ev) => {
            const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
            if (Math.abs(currentY - startY) > 10) {
              if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; }
              if (ev.cancelable) ev.preventDefault();
            }
            if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
        };
        on(gearBtn, 'pointerdown', handleGearDrag);
        let lastToggle = 0, lastTouchAt = 0;
        const onGearActivate = (e) => {
          if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
          const now = performance.now();
          if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
          lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        };
        on(gearBtn, 'touchend', (e) => { lastTouchAt = performance.now(); safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); onGearActivate(e); }, { passive: false });
        on(gearBtn, 'click', (e) => { const now = performance.now(); if (now - lastTouchAt < 800) { safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); return; } onGearActivate(e); }, { passive: false });
        const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };

        sub(P.APP_ACT, syncGear);
        sub(P.APP_UI, syncGear);
        syncGear();
      };

      const mount = () => {
        const root = getUiRoot(); if (!root) return;
        try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {}
        try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {}
      };

      const ensure = () => {
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        ensureGear();
        if (sm.get(P.APP_UI)) { build(); const mainPanel = getMainPanel(); if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } }
        else { const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible'); }
        mount(); safe(() => wakeGear?.());
      };

      onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });
      window.__VSC_UI_Ensure = ensure;
      return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
    }

    function getRateState(v) {
      const st = getVState(v);
      if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0 };
      return st.rateState;
    }

    function markInternalRateChange(v, ms = 300) {
      const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
    }

    const restoreRateOne = (el) => {
      try {
        const st = getRateState(el); if (!st || st.orig == null) return;
        const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
        st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate;
      } catch (_) {}
    };

    function ensureMobileInlinePlaybackHints(video) {
      if (!video || !CONFIG.IS_MOBILE) return;
      safe(() => { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); });
    }

    const onEvictRateVideo = (v) => { safe(() => restoreRateOne(v)); };
    const onEvictVideo = (v) => { if (window.__VSC_INTERNAL__.Adapter) window.__VSC_INTERNAL__.Adapter.clear(v); restoreRateOne(v); };

    const cleanupTouched = (TOUCHED) => {
      const vids = [...TOUCHED.videos]; const rateVids = [...TOUCHED.rateVideos];
      TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
      const immediate = vids.filter(v => v.isConnected && getVState(v).visible);
      const deferred = vids.filter(v => !immediate.includes(v));
      for (const v of immediate) onEvictVideo(v);
      for (const v of rateVids) onEvictRateVideo(v);
      if (deferred.length > 0) {
        const cleanup = (deadline) => {
          while (deferred.length > 0) {
            if (deadline?.timeRemaining && deadline.timeRemaining() < 2) {
              if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 200 });
              else setTimeout(cleanup, 16);
              return;
            }
            const v = deferred.pop();
            if (!v.isConnected) onEvictVideo(v);
          }
        };
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(cleanup, { timeout: 500 }); else setTimeout(() => { for (const v of deferred) onEvictVideo(v); }, 0);
      }
    };

    const bindVideoOnce = (v, ApplyReq) => {
      const st = getVState(v); if (st.bound) return;
      st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
      const softResetTransientFlags = () => {
        st.audioFailUntil = 0; st.rect = null; st.rectT = 0; st.webglFailCount = 0; st.webglDisabledUntil = 0;
        if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; st.webglTainted = false; }
        if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; }
        ApplyReq.hard();
      };
      const combinedSignal = combineSignals(st._ac.signal, __globalSig);
      const opts = { passive: true, signal: combinedSignal };
      const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => {
          const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return;
          const st = getVState(v);
          const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return;
          if (rSt.orig != null) rSt.orig = v.playbackRate;
          const store = window.__VSC_INTERNAL__?.Store; if (!store) return;
          const activeVideo = window.__VSC_INTERNAL__?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return;
          const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); }
        }]];
      for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
    };

    let __lastApplyTarget = null;
    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el); Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); if (st._ac) { st._ac.abort(); st._ac = null; } st.bound = false; bindVideoOnce(el, ApplyReq);
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el), rSt = getRateState(el); if (rSt.orig == null) rSt.orig = el.playbackRate;
      if (!Object.is(st.desiredRate, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        const now = performance.now(); rSt._setAttempts = (rSt._setAttempts || 0) + 1;
        if (rSt._setAttempts === 1) { rSt._firstAttemptT = now; } else if (rSt._setAttempts > 5) { if (now - (rSt._firstAttemptT || 0) < 2000) return; rSt._setAttempts = 1; rSt._firstAttemptT = now; }
        st.desiredRate = desiredRate; markInternalRateChange(el, 160); try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }

    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn, desiredRate, pbActive, Adapter, storeRMode, ApplyReq }) {
      const candidates = new Set();
      for (const set of [dirtyVideos, TOUCHED.videos, TOUCHED.rateVideos, applySet]) {
        for (const v of set) if (v?.tagName === 'VIDEO') candidates.add(v);
      }
      for (const el of candidates) {
        if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
        const st = getVState(el); const visible = (st.visible !== false); const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el));
        if (!shouldApply) { clearVideoRuntimeState(el, Adapter, ApplyReq); continue; }
        if (videoFxOn) { Adapter.apply(el, storeRMode, vVals); touchedAddLimited(TOUCHED.videos, el, onEvictVideo); } else { Adapter.clear(el); TOUCHED.videos.delete(el); }
        if (pbActive) { applyPlaybackRate(el, desiredRate); } else { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
        bindVideoOnce(el, ApplyReq);
      }
    }

    function createVideoParamsMemo(Store, P) {
      const getDetailLevel = (presetKey) => {
        const k = String(presetKey || 'off').toUpperCase().trim();
        if (k === 'XL') return 'xl'; if (k === 'L') return 'l'; if (k === 'M') return 'm'; if (k === 'S') return 's'; return 'off';
      };
      const SHADOW_PARAMS = new Map([[SHADOW_BAND.DEEP, { toe: 3.5, gamma: -0.04, mid: 0 }], [SHADOW_BAND.MID, { toe: 2.0, gamma: 0, mid: -0.08 }], [SHADOW_BAND.OUTER, { toe: 0, gamma: -0.02, mid: -0.15 }]]);
      return {
        get(vfUser, storeRMode, activeVideo) {
          const detailP = PRESETS.detail[vfUser.presetS || 'off']; const gradeP = PRESETS.grade[vfUser.presetB || 'brOFF'];
          const out = { sharp: detailP.sharpAdd || 0, sharp2: detailP.sharp2Add || 0, clarity: detailP.clarityAdd || 0, gamma: gradeP.gammaF || 1.0, bright: gradeP.brightAdd || 0, contrast: 1.0, satF: 1.0, temp: 0, gain: 1.0, mid: 0, toe: 0, shoulder: 0, __qos: 'full', _hdrToneMap: !!Store.get(P.APP_HDR_TONEMAP) };
          const sMask = vfUser.shadowBandMask || 0;
          if (sMask > 0) {
            let toeSum = 0; for (const [bit, params] of SHADOW_PARAMS) { if (sMask & bit) { toeSum += params.toe; out.gamma += params.gamma; out.mid += params.mid; } }
            const combinedAttenuation = 1 - 0.15 * Math.max(0, toeSum - 2.5);
            out.toe = VSC_CLAMP(toeSum * Math.max(0.5, combinedAttenuation), 0, 3.5);
          }
          out.mid = VSC_CLAMP(out.mid, -0.20, 0); const brStep = vfUser.brightStepLevel || 0;
          if (brStep > 0) { out.bright += brStep * 4.0; out.toe = Math.max(0, out.toe - brStep * 0.5); out.gamma *= (1.0 + brStep * 0.03); }
          const { rs, gs, bs } = tempToRgbGain(out.temp); out._rs = rs; out._gs = gs; out._bs = bs; out.__detailLevel = getDetailLevel(vfUser.presetS);
          return out;
        }
      };
    }

    function isNeutralVideoParams(p) {
      return (p.sharp === 0 && p.sharp2 === 0 && p.clarity === 0 && p.gamma === 1.0 && p.bright === 0 && p.contrast === 1.0 && p.satF === 1.0 && p.temp === 0 && p.gain === 1.0 && p.mid === 0 && p.toe === 0 && p.shoulder === 0);
    }

    function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
      UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
      Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });
      let __activeTarget = null, __lastAudioTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0, qualityScale = 1.0, lastQCheck = 0, __lastQSample = { dropped: 0, total: 0 };
      const videoParamsMemo = createVideoParamsMemo(Store, P);
      function updateQualityScale(v) {
        if (!v || typeof v.getVideoPlaybackQuality !== 'function') return qualityScale;
        const now = performance.now(); if (now - lastQCheck < 1000) return qualityScale; lastQCheck = now;
        try {
          const q = v.getVideoPlaybackQuality(); const dropped = Number(q.droppedVideoFrames || 0), total = Number(q.totalVideoFrames || 0);
          const dDropped = Math.max(0, dropped - (__lastQSample.dropped || 0)), dTotal = Math.max(0, total - (__lastQSample.total || 0));
          __lastQSample = { dropped, total }; const denom = (dTotal > 0) ? dTotal : total, numer = (dTotal > 0) ? dDropped : dropped;
          const ratio = denom > 0 ? (numer / denom) : 0; const target = ratio > 0.08 ? 0.65 : (ratio > 0.04 ? 0.80 : 1.0);
          const alpha = target < qualityScale ? 0.35 : 0.25; qualityScale = qualityScale * (1 - alpha) + target * alpha;

          if (ratio > 0.08) {
            const st = getVState(v);
            if (st && st.fxBackend === 'webgl') { st.webglDisabledUntil = now + 4000; safe(() => window.__VSC_INTERNAL__?.ApplyReq?.hard()); }
          }
        } catch (_) {}
        return qualityScale;
      }
      Scheduler.registerApply((force) => {
        try {
          const active = !!Store.getCatRef('app').active; if (!active) { cleanupTouched(TOUCHED); Audio.update(); return; }
          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;

          const wantAudioNow = !!(Store.get(P.A_EN) && active), storeRMode = Store.get(P.APP_RENDER_MODE) || 'auto';
          const pbActive = active && !!Store.get(P.PB_EN);
          const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
          const pick = Targeting.pickFastActiveOnly(visible.videos, window.__lastUserPt, wantAudioNow);
          let nextTarget = pick.target; if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; }
          if (nextTarget !== __activeTarget) __activeTarget = nextTarget;

          const targetChanged = __activeTarget !== __lastApplyTarget;
          if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

          const now = performance.now(); if (now - lastPrune > 2000) { Registry.prune(); lastPrune = now; }
          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; }
          Audio.update();

          const vf0 = Store.getCatRef('video'); let vValsEffective = videoParamsMemo.get(vf0, storeRMode, __activeTarget);
          const autoScene = window.__VSC_INTERNAL__?.AutoScene; const qs = updateQualityScale(__activeTarget);
          if (qs < 0.95) vValsEffective.__qos = 'fast'; else vValsEffective.__qos = 'full';

          if (autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
            const mods = autoScene.getMods();
            if (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0) {
              vValsEffective = { ...vValsEffective }; const uBr = vValsEffective.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
              vValsEffective.gain = uBr * (1.0 + (mods.br - 1.0) * aSF); vValsEffective.contrast = (vValsEffective.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF); vValsEffective.satF = (vValsEffective.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
              const userSharpTotal = (vValsEffective.sharp || 0) + (vValsEffective.sharp2 || 0) + (vValsEffective.clarity || 0);
              const sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5); const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF) * (qs < 0.95 ? Math.sqrt(qs) : 1.0);
              vValsEffective.sharp = (vValsEffective.sharp || 0) * combinedSharpScale; vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * combinedSharpScale; vValsEffective.clarity = (vValsEffective.clarity || 0) * combinedSharpScale;
            }
          } else if (qs < 0.95) { vValsEffective = { ...vValsEffective }; const qSharp = Math.sqrt(qs); vValsEffective.sharp = (vValsEffective.sharp || 0) * qSharp; vValsEffective.sharp2 = (vValsEffective.sharp2 || 0) * qSharp; vValsEffective.clarity = (vValsEffective.clarity || 0) * qSharp; }
          const videoFxOn = !isNeutralVideoParams(vValsEffective); const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL), applySet = new Set();
          if (applyToAllVisibleVideos) { for (const v of visible.videos) applySet.add(v); } else if (__activeTarget) { applySet.add(__activeTarget); }

          const desiredRate = Store.get(P.PB_RATE);
          reconcileVideoEffects({ applySet, dirtyVideos: vidsDirty, vVals: vValsEffective, videoFxOn, desiredRate, pbActive, Adapter, storeRMode, ApplyReq });
          if (force || vidsDirty.size) UI.ensure();
        } catch (e) { log.warn('apply crashed:', e); }
      });
      let tickTimer = 0;
      const startTick = () => { if (tickTimer) return; tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 12000); };
      const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick();
      return Object.freeze({ getActiveVideo() { return __activeTarget || null; }, getQualityScale() { return qualityScale; }, destroy() { stopTick(); safe(() => UI.destroy?.()); safe(() => { Audio.setTarget(null); Audio.destroy?.(); }); safe(() => __globalHooksAC.abort()); } });
    }

    const Utils = createUtils(); const Scheduler = createScheduler(32); const Store = createLocalStore(DEFAULTS, Scheduler, Utils);
    const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
    window.__VSC_INTERNAL__.Store = Store; window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

    function bindNormalizer(keys, schema) {
      const run = () => { if (normalizeBySchema(Store, schema)) ApplyReq.hard(); };
      keys.forEach(k => Store.sub(k, run));
      run();
    }

    bindNormalizer(ALL_KEYS, ALL_SCHEMA);

    const Registry = createRegistry(Scheduler);
    const Targeting = createTargeting();
    initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

    onPageReady(() => {
      installShadowRootEmitterIfNeeded();
      (function ensureRegistryAfterBodyReady() {
        let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); };
        if (document.body) { runOnce(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
        on(document, 'DOMContentLoaded', runOnce, { once: true });
      })();
      const AutoScene = createAutoSceneManager(Store, P, Scheduler); window.__VSC_INTERNAL__.AutoScene = AutoScene;
      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FULL: 3840 * 2160, SVG_MAX_PIX_FAST: 3840 * 2160 });
      const FiltersGL = createFiltersWebGL(Utils);

      const Adapter = createBackendAdapter(Filters, FiltersGL);
      window.__VSC_INTERNAL__.Adapter = Adapter;

      const Audio = createAudio(Store); window.__VSC_INTERNAL__.AudioWarmup = Audio.warmup;
      let ZoomManager = createZoomManager(); window.__VSC_INTERNAL__.ZoomManager = ZoomManager;
      const UI = createUI(Store, Registry, ApplyReq, Utils);

      let __vscLastUserSignalT = 0; window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) { window.__lastUserPt.x = x; window.__lastUserPt.y = y; window.__lastUserPt.t = t; }
      function signalUserInteractionForRetarget() {
        const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false));
      }
      for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
        on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
      }
      const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
      window.__VSC_APP__ = __VSC_APP__; window.__VSC_INTERNAL__.App = __VSC_APP__; AutoScene.start();

      on(window, 'keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        if (e.altKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault(); e.stopPropagation();
          safe(() => {
            const st = window.__VSC_INTERNAL__?.Store;
            if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); }
          });
          return;
        }
        if (e.altKey && e.shiftKey && e.code === 'KeyP') {
          const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v);
        }
      }, { capture: true });

      on(document, 'visibilitychange', () => { safe(() => checkAndCleanupClosedPiP()); safe(() => { if (document.visibilityState === 'visible') window.__VSC_INTERNAL__?.ApplyReq?.hard(); }); }, OPT_P);
    });
  }
  VSC_MAIN();
})();
