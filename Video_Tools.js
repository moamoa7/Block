// ==UserScript==
// @name         Video Tools
// @namespace    https://github.com/moamoa7
// @version      11.0.0
// @description  비디오 최대화 + 좌우 반전 + 확대/축소
// @match        *://*/*
// @exclude      *://challenges.cloudflare.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/moamoa7/adblock/main/Video_Tools.js
// @downloadURL  https://raw.githubusercontent.com/moamoa7/adblock/main/Video_Tools.js
// ==/UserScript==

(() => {
  'use strict';

  // Cloudflare CDN-CGI 경로도 조기 차단
  if (location.pathname.startsWith('/cdn-cgi/')) return;

  if (window.__ytd_booted) return;
  window.__ytd_booted = true;

  let ttPolicy = null;
  if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
    try { ttPolicy = trustedTypes.createPolicy('ytd-video-tools', { createHTML: s => s }); }
    catch (_) { /* default 정책은 건드리지 않음 — Cloudflare 등 외부 서비스 충돌 방지 */ }
  }
  function safeHTML(str) { return ttPolicy ? ttPolicy.createHTML(str) : str; }

  let liveVideo = null;
  let fab = null, maxFab = null, mirrorFab = null, zoomFab = null, fabStyle = null;
  let coreStyle = null;

  function isMobile() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024); }
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function isInIframe() { try { return window !== window.top; } catch (_) { return true; } }

  let __osdEl = null, __osdTimerId = 0;
  function showOSD(text, durationMs = 1200) { if (!document.body) return; const fsEl = document.fullscreenElement || document.webkitFullscreenElement; const root = fsEl || document.body; if (!__osdEl || !__osdEl.isConnected || __osdEl.parentNode !== root) { __osdEl?.remove(); __osdEl = document.createElement('div'); __osdEl.id = 'ytd-osd'; __osdEl.style.cssText = ['position:fixed','top:48px','left:50%','transform:translateX(-50%) translateY(0)','background:rgba(12,12,18,0.85)','backdrop-filter:blur(24px) saturate(200%)','color:rgba(255,255,255,0.95)','padding:10px 28px','border-radius:14px','border:1px solid rgba(0,229,255,0.15)','font:600 13px/1.4 system-ui,-apple-system,sans-serif','z-index:2147483647','pointer-events:none','opacity:0','will-change:opacity,transform','transition:opacity 0.2s cubic-bezier(0.16,1,0.3,1),transform 0.3s cubic-bezier(0.34,1.56,0.64,1)','box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.08)','letter-spacing:0.3px','white-space:pre-line','max-width:90vw','text-align:center','word-break:keep-all'].join(';'); root.appendChild(__osdEl); } __osdEl.textContent = text; requestAnimationFrame(() => { if (!__osdEl) return; __osdEl.style.opacity = '1'; __osdEl.style.transform = 'translateX(-50%) translateY(0)'; }); clearTimeout(__osdTimerId); __osdTimerId = setTimeout(() => { if (__osdEl) { __osdEl.style.opacity = '0'; __osdEl.style.transform = 'translateX(-50%) translateY(-8px)'; } }, durationMs); }

  function findVideosInShadowRoots(root, results, depth) { if (depth > 8) return; let els; try { els = root.querySelectorAll('*'); } catch (_) { return; } for (let i = 0; i < els.length; i++) { const el = els[i]; if (el.tagName === 'VIDEO') results.push(el); if (el.shadowRoot) { try { const svids = el.shadowRoot.querySelectorAll('video'); for (let j = 0; j < svids.length; j++) results.push(svids[j]); findVideosInShadowRoots(el.shadowRoot, results, depth + 1); } catch (_) {} } } }
  function getAllVideos() { const set = new Set(document.querySelectorAll('video')); const sr = []; try { findVideosInShadowRoots(document, sr, 0); } catch (_) {} for (const v of sr) set.add(v); try { const vsc = window.__vsc_internal; if (vsc?._activeVideo?.isConnected) set.add(vsc._activeVideo); } catch (_) {} return [...set]; }
  function pickBestVideo() { const videos = getAllVideos(); if (!videos.length) return null; try { const vsc = window.__vsc_internal; if (vsc?._activeVideo?.isConnected) { const av = vsc._activeVideo; if ((av.clientWidth||0)>=100 && (av.clientHeight||0)>=56) return av; } } catch (_) {} let best = null, bestScore = -1; for (const v of videos) { const area = (v.clientWidth||0)*(v.clientHeight||0); let s = area; if (!v.paused && !v.ended) s += 1e7; if (v.readyState >= 2) s += 1e5; if (s > bestScore) { bestScore = s; best = v; } } return best; }

  const FAB_START_RIGHT = 5, FAB_GAP = 50;
  function layoutFabs() { const ordered=[maxFab,mirrorFab,zoomFab]; let pos=0; for (const f of ordered) { if (!f) continue; if (f.style.display==='none') continue; if (f.style.left && f.style.left!=='auto') continue; f.style.right=(FAB_START_RIGHT+FAB_GAP*pos)+'px'; pos++; } }
  function setFabVisible(show) { const mobile=isMobile(); const inTop=!isInIframe(); const hasDirectVideo=getAllVideos().length>0; const hideTopFabForIframe=inTop&&!hasDirectVideo; if(show&&!hideTopFabForIframe){if(maxFab)maxFab.style.display='';if(mirrorFab)mirrorFab.style.display='';if(zoomFab)zoomFab.style.display=mobile?'none':'';} else{if(maxFab)maxFab.style.display='none';if(mirrorFab)mirrorFab.style.display='none';if(zoomFab)zoomFab.style.display='none';} layoutFabs(); }

  function getFsRoot() { const fs=document.fullscreenElement||document.webkitFullscreenElement; if(!fs) return document.documentElement; return fs.tagName==='VIDEO'?(fs.parentElement||document.documentElement):fs; }
  function reparent() { const target=getFsRoot(); const allFabs=[maxFab,mirrorFab,zoomFab]; for (const f of allFabs) { if (f&&f.parentNode!==target) try{target.appendChild(f);}catch(_){} } }
  function onFsChange() { reparent(); setTimeout(reparent,120); setTimeout(()=>{const allFabs=[maxFab,mirrorFab,zoomFab];for(const f of allFabs){if(f&&!f.isConnected)document.documentElement.appendChild(f);}},300); const best=pickBestVideo(); setFabVisible(!!best||!!findBestIframe()); if(!isFullscreen()&&Zoom.isActive()){Zoom.reset(true);} }

  let detectTimer=0;
  function scheduleDetect(){if(detectTimer)return;detectTimer=setTimeout(()=>{detectTimer=0;autoDetect();},300);}
  const VIDEO_SRC_RE = /\.(mp4|webm|ogg|m3u8)(\?.*)?$/i;
  function findBestIframe(){const iframes=document.querySelectorAll('iframe');let best=null,bestArea=0;for(const ifr of iframes){if(!ifr.isConnected)continue;const src=ifr.src||ifr.getAttribute('src')||'';if(VIDEO_SRC_RE.test(src)){const r=ifr.getBoundingClientRect();const a=r.width*r.height;if(a>bestArea){bestArea=a;best=ifr;}}}if(best)return best;bestArea=0;for(const ifr of iframes){if(!ifr.isConnected)continue;const r=ifr.getBoundingClientRect();const a=r.width*r.height;if(a<10000)continue;if(a>bestArea){bestArea=a;best=ifr;}}return best;}
  function autoDetect(){const best=pickBestVideo();const hasVid=!!best;const hasIframe=!hasVid&&!!findBestIframe();setFabVisible(hasVid||hasIframe);liveVideo=best;}

  function applyVideoTransform(video){if(!video)return;const parts=[];const zs=Zoom.getState();if(zs.panX!==0||zs.panY!==0)parts.push(`translate(${zs.panX}px, ${zs.panY}px)`);if(zs.scale!==1)parts.push(`scale(${zs.scale})`);if(Mirror.isActive())parts.push('scaleX(-1)');video.style.transform=parts.length?parts.join(' '):'';video.style.transformOrigin='center center';}


  /* ═══════════════════════════════════════════════════════
     ★ Video Maximizer 모듈
     ─────────────────────────────────────────────────────
     항상 video를 body로 이동 + position:fixed.
     어떤 사이트든 video만 뽑아서 화면에 꽉 채움.
     Cloudflare 챌린지 충돌 방지.
  ═══════════════════════════════════════════════════════ */
  const Maximizer = (() => {
    const MAX_CLASS = 'ytd-vmax-max';
    const HIDE_CLASS = 'ytd-vmax-hide';
    const ANCESTOR_CLASS = 'ytd-vmax-ancestor';
    const IFRAME_MAX_CLASS = 'ytd-vmax-iframe';

    let active = false, targetVideo = null, targetIframe = null, isIframeMode = false, delegatedToTop = false;
    const savedElementsSet = new Set(), savedElementsList = [];
    let hiddenSiblings = [], savedScrollX = 0, savedScrollY = 0, classMO = null;

    /* video 이동 복원 정보 */
    let movedVideo = null, movedOrigParent = null, movedOrigNext = null, movedOrigClassName = '';

    function isPlayerControlElement(el) { if (!el||el.nodeType!==1)return false;const cn=(el.className&&typeof el.className==='string')?el.className.toLowerCase():'';const id=(el.id||'').toLowerCase();const text=cn+' '+id;const kws=['player-controls','player_controls','playercontrols','video-controls','video_controls','videocontrols','ctrl_bar','ctrl-bar','ctrlbar','control-bar','control_bar','controlbar','seekbar','seek-bar','seek_bar','playbar','play-bar','play_bar','vod-control','vod_control','bottom_ctrl','bottom-ctrl','player-bottom','player_bottom','play_control','play-control','playcontrol','player_ctrlbox','player-ctrlbox','ctrlbox'];for(const kw of kws){if(text.includes(kw))return true;}const role=el.getAttribute('role');if(role==='slider'||role==='toolbar')return true;return false; }

    function findIframePlayerWrapper(iframeEl) { let el=iframeEl.parentElement;let depth=0;while(el&&el!==document.body&&el!==document.documentElement&&depth<8){const text=((el.className&&typeof el.className==='string'?el.className:'')+' '+(el.id||'')).toLowerCase();const kws=['player','htmlplayer','video-player','video_player','player_area','player-area','playerarea','player_wrap','player-wrap','playerwrap','player_content','player-content','playercontent','float_box','float-box','floatbox','soop_player','soop-player'];for(const kw of kws){if(text.includes(kw))return el;}el=el.parentElement;depth++;}return null; }
    function findIframeForWindow(childWin) { try{const iframes=document.querySelectorAll('iframe');for(const ifr of iframes){try{if(ifr.contentWindow===childWin)return ifr;}catch(_){}}}catch(_){}return null; }

    function _backupApply(set, list, el, css) { if(!set.has(el)){set.add(el);list.push(el);if(!el.__ytd_max_saved)el.__ytd_max_saved={};} for(const prop in css){if(!(prop in el.__ytd_max_saved)){el.__ytd_max_saved[prop]=el.style.getPropertyValue(prop);}el.style.setProperty(prop,css[prop],'important');} }
    function backupAndApplyStyle(el, css) { _backupApply(savedElementsSet, savedElementsList, el, css); }
    function restoreStyle(el) { if(!el.__ytd_max_saved)return;for(const prop in el.__ytd_max_saved){const val=el.__ytd_max_saved[prop];if(val)el.style.setProperty(prop,val);else el.style.removeProperty(prop);}delete el.__ytd_max_saved; }
    function isOurElement(sib) { if(sib.tagName==='SCRIPT'||sib.tagName==='LINK'||sib.tagName==='STYLE')return true;if(sib.id==='ytd-osd'||sib.id==='__ytd3_core_style__'||sib.id==='__ytd3_fab_style__')return true;if(sib.classList&&sib.classList.contains('ytd-fab'))return true;if(sib===maxFab||sib===mirrorFab||sib===zoomFab)return true;return false; }
    function hideSiblingsOf(el) { if(!el.parentNode)return;for(const sib of el.parentNode.children){if(sib===el||sib.nodeType!==1)continue;if(isOurElement(sib))continue;sib.classList.add(HIDE_CLASS);hiddenSiblings.push({el:sib});} }

    function clearAncestorChain(startEl) { let ancestor=startEl.parentElement;while(ancestor&&ancestor!==document.body&&ancestor!==document.documentElement){ancestor.dataset.ytdMaxAncestor='1';backupAndApplyStyle(ancestor,{overflow:'visible',position:'static',transform:'none',clip:'auto','clip-path':'none',contain:'none',width:'100vw',height:'100vh','max-width':'none','max-height':'none',margin:'0',padding:'0'});ancestor.classList.add(ANCESTOR_CLASS);hideSiblingsOf(ancestor);ancestor=ancestor.parentElement;} }
    function lockBody() { backupAndApplyStyle(document.body,{overflow:'hidden',margin:'0',padding:'0'});if(document.documentElement){backupAndApplyStyle(document.documentElement,{overflow:'hidden'});} }
    function startClassGuard(primaryEl) { if(classMO){classMO.disconnect();classMO=null;}classMO=new MutationObserver(muts=>{for(const m of muts){if(m.type!=='attributes'||m.attributeName!=='class'||!active)continue;const el=m.target;if(el.dataset?.ytdMaxAncestor==='1'&&!el.classList.contains(ANCESTOR_CLASS))el.classList.add(ANCESTOR_CLASS);}});let cur=primaryEl.parentElement;while(cur&&cur!==document.body&&cur!==document.documentElement){classMO.observe(cur,{attributes:true,attributeFilter:['class']});cur=cur.parentElement;} }
    function stopClassGuard() { if(classMO){classMO.disconnect();classMO=null;} }

    /* ★ 항상 video를 body로 이동 — wrapper 분기 없음 */
    function doMaximizeDirect(video) {
      targetVideo = video;
      isIframeMode = false;
      savedScrollX = window.scrollX;
      savedScrollY = window.scrollY;

      movedVideo = video;
      movedOrigParent = video.parentElement;
      movedOrigNext = video.nextSibling;
      movedOrigClassName = video.className;

      const wasPlaying = !video.paused;
      const curTime = video.currentTime;

      lockBody();
      video.className = '';
      document.body.appendChild(video);

      backupAndApplyStyle(video, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        'z-index': '2147483646',
        'object-fit': 'contain',
        background: '#000',
        margin: '0',
        padding: '0',
        border: 'none',
        'max-width': 'none',
        'max-height': 'none',
        display: 'block'
      });
      video.classList.add(MAX_CLASS);

      video.currentTime = curTime;
      if (wasPlaying) video.play().catch(() => {});
      applyVideoTransform(video);
      window.scrollTo(0, 0);

      active = true;
      syncBtnUI();
      showOSD('최대화 ON (ESC 복원)', 1200);
    }

    function doMaximizeIframe(iframeEl) { targetIframe=iframeEl;isIframeMode=true;savedScrollX=window.scrollX;savedScrollY=window.scrollY;const playerWrapper=findIframePlayerWrapper(iframeEl);if(playerWrapper&&playerWrapper!==document.body&&playerWrapper!==document.documentElement){clearAncestorChain(playerWrapper);lockBody();backupAndApplyStyle(playerWrapper,{position:'fixed',top:'0',left:'0',width:'100vw',height:'100dvh','z-index':'2147483646',background:'#000',margin:'0',padding:'0',overflow:'hidden'});backupAndApplyStyle(iframeEl,{width:'100%',height:'100%',border:'none',margin:'0',padding:'0'});hideSiblingsOf(playerWrapper);window.scrollTo(0,0);startClassGuard(playerWrapper);}else{clearAncestorChain(iframeEl);lockBody();backupAndApplyStyle(iframeEl,{position:'fixed',top:'0',left:'0',width:'100vw',height:'100dvh','z-index':'2147483646',background:'#000',border:'none',margin:'0',padding:'0'});iframeEl.classList.add(IFRAME_MAX_CLASS);hideSiblingsOf(iframeEl);window.scrollTo(0,0);startClassGuard(iframeEl);}active=true;syncBtnUI();showOSD('최대화 ON (ESC 복원)',1200);try{iframeEl.contentWindow.postMessage({__ytd_max:'apply_inner_soft'},'*');}catch(_){} }

    function undoMaximize() {
      if(!active) return;
      stopClassGuard();
      if(isIframeMode&&targetIframe){try{targetIframe.contentWindow.postMessage({__ytd_max:'undo_inner'},'*');}catch(_){}try{targetIframe.contentWindow.postMessage({__ytd_max:'state_off'},'*');}catch(_){}}

      if (movedVideo) {
        const vid=movedVideo; const wasPlaying=!vid.paused; const curTime=vid.currentTime;
        if(movedOrigNext&&movedOrigNext.parentNode===movedOrigParent){movedOrigParent.insertBefore(vid,movedOrigNext);}else if(movedOrigParent){movedOrigParent.appendChild(vid);}
        vid.className=movedOrigClassName; vid.currentTime=curTime;
        if(wasPlaying)vid.play().catch(()=>{});
        movedVideo=null;movedOrigParent=null;movedOrigNext=null;movedOrigClassName='';
      }

      for(let i=hiddenSiblings.length-1;i>=0;i--){const{el}=hiddenSiblings[i];try{el.classList.remove(HIDE_CLASS);}catch(_){}}hiddenSiblings=[];
      for(let i=savedElementsList.length-1;i>=0;i--){const el=savedElementsList[i];restoreStyle(el);try{el.classList.remove(MAX_CLASS,IFRAME_MAX_CLASS,ANCESTOR_CLASS);delete el.dataset.ytdMaxAncestor;}catch(_){}}
      savedElementsList.length=0;savedElementsSet.clear();
      window.scrollTo(savedScrollX,savedScrollY);active=false;targetVideo=null;targetIframe=null;isIframeMode=false;
      const vid=pickBestVideo();if(vid)applyVideoTransform(vid);syncBtnUI();showOSD('최대화 OFF',1200);
    }

    let innerMaxActive=false;const innerSavedSet=new Set(),innerSavedList=[];
    function backupInner(el,css){_backupApply(innerSavedSet,innerSavedList,el,css);}
    function applyInnerMaximize(){if(innerMaxActive)return;const video=pickBestVideo();if(!video)return;innerMaxActive=true;backupInner(video,{width:'100vw',height:'100dvh','object-fit':'contain',position:'fixed',top:'0',left:'0','z-index':'2147483646',background:'#000',margin:'0',padding:'0',border:'none','max-width':'none','max-height':'none'});let a=video.parentElement;while(a&&a!==document.body&&a!==document.documentElement){backupInner(a,{overflow:'visible',position:'static',transform:'none',clip:'auto','clip-path':'none',contain:'none'});a=a.parentElement;}backupInner(document.body,{overflow:'hidden',margin:'0',padding:'0'});if(document.documentElement)backupInner(document.documentElement,{overflow:'hidden'});}
    function applyInnerMaximizeSoft(){if(innerMaxActive)return;innerMaxActive=true;if(document.body){backupInner(document.body,{overflow:'visible','max-width':'none','max-height':'none'});}if(document.documentElement){backupInner(document.documentElement,{overflow:'visible','max-width':'none','max-height':'none'});}const video=pickBestVideo();if(video){let a=video.parentElement;let d=0;while(a&&a!==document.body&&a!==document.documentElement&&d<10){backupInner(a,{overflow:'visible','max-width':'none','max-height':'none',clip:'auto','clip-path':'none',contain:'none'});a=a.parentElement;d++;}}}
    function undoInnerMaximize(){if(!innerMaxActive)return;for(let i=innerSavedList.length-1;i>=0;i--)restoreStyle(innerSavedList[i]);innerSavedList.length=0;innerSavedSet.clear();innerMaxActive=false;}

    function toggle(){if(isInIframe()){if(delegatedToTop){try{window.top.postMessage({__ytd_max:'undo'},'*');}catch(_){}delegatedToTop=false;return;}try{window.top.postMessage({__ytd_max:'request'},'*');delegatedToTop=true;}catch(_){const video=pickBestVideo();if(video)doMaximizeDirect(video);}return;}if(active){undoMaximize();return;}const video=pickBestVideo();if(video){doMaximizeDirect(video);return;}const bestIframe=findBestIframe();if(bestIframe)doMaximizeIframe(bestIframe);else showOSD('최대화할 비디오를 찾을 수 없습니다.',1500);}

    function handleMessage(e){if(!e.data||typeof e.data!=='object'||!e.data.__ytd_max)return;const cmd=e.data.__ytd_max;if(!isInIframe()){if(cmd==='request'){const iframeEl=findIframeForWindow(e.source);if(iframeEl){if(active)undoMaximize();doMaximizeIframe(iframeEl);try{e.source.postMessage({__ytd_max:'state_on'},'*');}catch(_){}}}if(cmd==='undo'){if(active)undoMaximize();}return;}if(cmd==='apply_inner_soft'){applyInnerMaximizeSoft();return;}if(cmd==='apply_inner'){applyInnerMaximize();return;}if(cmd==='undo_inner'){undoInnerMaximize();return;}if(cmd==='state_on'){delegatedToTop=true;syncBtnUI();return;}if(cmd==='state_off'){delegatedToTop=false;syncBtnUI();return;}}

    function syncBtnUI(){const isMax=active||delegatedToTop;if(maxFab){maxFab.style.borderColor=isMax?'#50d070':'#2a2d36';const svg=maxFab.querySelector('svg path');if(svg)svg.style.stroke=isMax?'#50d070':'#4a5060';}}

    window.addEventListener('message',handleMessage);
    window.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(active){undoMaximize();}else if(delegatedToTop){try{window.top.postMessage({__ytd_max:'undo'},'*');}catch(_){}delegatedToTop=false;syncBtnUI();showOSD('최대화 OFF',1200);}},{capture:true});

    return { toggle, undoMaximize, isActive:()=>active||delegatedToTop };
  })();


  const Mirror=(()=>{let active=false;function on(){if(active)return;active=true;getAllVideos().forEach(v=>applyVideoTransform(v));syncUI();showOSD('좌우 반전 ON',1200);}function off(){if(!active)return;active=false;getAllVideos().forEach(v=>applyVideoTransform(v));syncUI();showOSD('좌우 반전 OFF',1200);}function toggle(){if(active)off();else on();}function onNewVideo(video){if(active&&video)applyVideoTransform(video);}function syncUI(){if(mirrorFab){mirrorFab.style.borderColor=active?'#00bcd4':'#2a2d36';const svg=mirrorFab.querySelector('svg');if(svg)svg.querySelectorAll('path,polyline,line').forEach(p=>p.style.stroke=active?'#00bcd4':'#4a5060');}}return{toggle,on,off,isActive:()=>active,onNewVideo,syncUI};})();

  const Zoom=(()=>{let scale=1.0,panX=0,panY=0,isPanning=false,panStartX=0,panStartY=0,panOriginX=0,panOriginY=0;const STEPS=[1.0,1.25,1.5,2.0,2.5,3.0],MIN_SCALE=1.0,MAX_SCALE=5.0,WHEEL_STEP=0.15;function getState(){return{scale,panX,panY};}function clampPan(video){if(!video||scale<=1.05){panX=0;panY=0;return;}const w=video.clientWidth||640,h=video.clientHeight||360;const mX=(w*scale-w)/2,mY=(h*scale-h)/2;panX=Math.max(-mX,Math.min(mX,panX));panY=Math.max(-mY,Math.min(mY,panY));}function setScale(ns,video,silent){if(isMobile())return;const prev=scale;scale=Math.max(MIN_SCALE,Math.min(MAX_SCALE,Math.round(ns*100)/100));if(scale<=1.05){scale=1.0;panX=0;panY=0;}else clampPan(video);if(video)applyVideoTransform(video);syncUI();if(!silent&&scale!==prev){showOSD(scale===1?'확대: 원본 (100%)':`확대: ${Math.round(scale*100)}%`,1000);}}function reset(silent){const video=pickBestVideo();if(scale===1&&panX===0&&panY===0)return;scale=1.0;panX=0;panY=0;if(video)applyVideoTransform(video);syncUI();if(!silent)showOSD('확대: 원본 (100%)',1000);}function cycleStep(){if(isMobile())return;const video=pickBestVideo();if(!video){showOSD('비디오 없음',1500);return;}let nextIdx=0;for(let i=0;i<STEPS.length;i++){if(scale>=STEPS[i]-0.01)nextIdx=i+1;}if(nextIdx>=STEPS.length)nextIdx=0;setScale(STEPS[nextIdx],video);}function onWheel(e){if(isMobile()||!e.altKey)return;const video=pickBestVideo();if(!video)return;const rect=video.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)return;e.preventDefault();e.stopPropagation();setScale(scale+(e.deltaY>0?-WHEEL_STEP:WHEEL_STEP),video);}function onMouseDown(e){if(isMobile()||scale<=1.05||!e.altKey||e.button!==0)return;const video=pickBestVideo();if(!video)return;const rect=video.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)return;if(e.target.closest('.ytd-fab'))return;e.preventDefault();e.stopPropagation();isPanning=true;panStartX=e.clientX;panStartY=e.clientY;panOriginX=panX;panOriginY=panY;document.body.style.cursor='grabbing';}function onMouseMove(e){if(!isPanning)return;e.preventDefault();panX=panOriginX+(e.clientX-panStartX);panY=panOriginY+(e.clientY-panStartY);const video=pickBestVideo();if(video){clampPan(video);applyVideoTransform(video);}}function onMouseUp(){if(!isPanning)return;isPanning=false;document.body.style.cursor='';}function syncUI(){const isZoomed=scale>1.05;const color=isZoomed?'#e040fb':'#2a2d36';const sc=isZoomed?'#e040fb':'#4a5060';if(zoomFab){zoomFab.style.borderColor=color;const svg=zoomFab.querySelector('svg');if(svg)svg.querySelectorAll('circle,line,path').forEach(p=>p.style.stroke=sc);let label=zoomFab.querySelector('.ytd-zoom-label');if(!label){label=document.createElement('span');label.className='ytd-zoom-label';label.style.cssText='position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);font:900 9px/1 monospace;color:#4a5060;background:#15171c;padding:1px 3px;border-radius:4px;border:1px solid #2a2d36;pointer-events:none;white-space:nowrap;min-width:20px;text-align:center;transition:all .3s ease';zoomFab.appendChild(label);}if(isZoomed){label.textContent=Math.round(scale*100)+'%';label.style.color='#e040fb';label.style.borderColor='#3a1040';}else{label.textContent='';label.style.color='#4a5060';label.style.borderColor='#2a2d36';}}}window.addEventListener('keydown',e=>{if(e.key==='Escape'&&scale>1.0&&!Maximizer.isActive()){reset();}},{capture:true});if(!isMobile()){document.addEventListener('wheel',onWheel,{passive:false,capture:true});document.addEventListener('mousedown',onMouseDown,{capture:true});document.addEventListener('mousemove',onMouseMove,{capture:true});document.addEventListener('mouseup',onMouseUp,{capture:true});}return{getState,setScale,reset,cycleStep,syncUI,isActive:()=>scale>1.05};})();


  /* ── FAB ─────────────────────────── */
  function buildFab(){if(maxFab)return;const mobile=isMobile();if(!coreStyle||!coreStyle.isConnected){coreStyle?.remove();coreStyle=document.createElement('style');coreStyle.id='__ytd3_core_style__';coreStyle.textContent=`.ytd-vmax-max{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;margin:0!important;padding:0!important;border:none!important;max-width:none!important;max-height:none!important;display:block!important;}\n.ytd-vmax-hide{display:none!important;}\n.ytd-vmax-ancestor{overflow:visible!important;position:static!important;transform:none!important;clip:auto!important;clip-path:none!important;contain:none!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;}\n.ytd-vmax-iframe{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;z-index:2147483646!important;border:none!important;margin:0!important;padding:0!important;max-width:100vw!important;max-height:100vh!important;background:#000!important;}`;document.documentElement.appendChild(coreStyle);}fabStyle=document.createElement('style');fabStyle.id='__ytd3_fab_style__';fabStyle.textContent=`.ytd-fab{position:fixed;top:40px;z-index:2147483647;opacity:0.5;width:40px;height:40px;border-radius:50%;background:#15171c;border:2px solid #2a2d36;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .35s cubic-bezier(.16,1,.3,1);box-shadow:0 4px 16px rgba(0,0,0,.5);user-select:none;-webkit-tap-highlight-color:transparent}@media(hover:hover){.ytd-fab:hover{transform:scale(1.12);border-color:#3a3d48;box-shadow:0 6px 24px rgba(0,0,0,.6)}}@media(hover:none){.ytd-fab{opacity:0.25}}.ytd-fab-icon{width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center}.ytd-fab-icon svg{width:18px;height:18px}`;document.documentElement.appendChild(fabStyle);const svgNS='http://www.w3.org/2000/svg';maxFab=document.createElement('div');maxFab.className='ytd-fab ytd-fab--idle';maxFab.style.display='none';maxFab.title="최대화/해제";const mi=document.createElement('div');mi.className='ytd-fab-icon';const ms=document.createElementNS(svgNS,'svg');ms.setAttribute('viewBox','0 0 24 24');ms.setAttribute('fill','none');ms.setAttribute('stroke-width','2');ms.setAttribute('stroke-linecap','round');ms.setAttribute('stroke-linejoin','round');const mp=document.createElementNS(svgNS,'path');mp.setAttribute('d','M15,3L21,3L21,9 M9,21L3,21L3,15 M21,3L14,10 M3,21L10,14');mp.style.stroke='#4a5060';ms.appendChild(mp);mi.appendChild(ms);maxFab.appendChild(mi);mirrorFab=document.createElement('div');mirrorFab.className='ytd-fab ytd-fab--idle';mirrorFab.style.display='none';mirrorFab.title="좌우 반전";const mri=document.createElement('div');mri.className='ytd-fab-icon';const mrs=document.createElementNS(svgNS,'svg');mrs.setAttribute('viewBox','0 0 24 24');mrs.setAttribute('fill','none');mrs.setAttribute('stroke-width','2');mrs.setAttribute('stroke-linecap','round');mrs.setAttribute('stroke-linejoin','round');const mp1=document.createElementNS(svgNS,'polyline');mp1.setAttribute('points','7,8 3,12 7,16');mp1.style.stroke='#4a5060';mp1.style.fill='none';const mp2=document.createElementNS(svgNS,'polyline');mp2.setAttribute('points','17,8 21,12 17,16');mp2.style.stroke='#4a5060';mp2.style.fill='none';const ml1=document.createElementNS(svgNS,'line');ml1.setAttribute('x1','3');ml1.setAttribute('y1','12');ml1.setAttribute('x2','10');ml1.setAttribute('y2','12');ml1.style.stroke='#4a5060';const ml2=document.createElementNS(svgNS,'line');ml2.setAttribute('x1','14');ml2.setAttribute('y1','12');ml2.setAttribute('x2','21');ml2.setAttribute('y2','12');ml2.style.stroke='#4a5060';const mc=document.createElementNS(svgNS,'line');mc.setAttribute('x1','12');mc.setAttribute('y1','5');mc.setAttribute('x2','12');mc.setAttribute('y2','19');mc.setAttribute('stroke-dasharray','2,2');mc.style.stroke='#4a5060';mrs.appendChild(mp1);mrs.appendChild(mp2);mrs.appendChild(ml1);mrs.appendChild(ml2);mrs.appendChild(mc);mri.appendChild(mrs);mirrorFab.appendChild(mri);if(!mobile){zoomFab=document.createElement('div');zoomFab.className='ytd-fab ytd-fab--idle';zoomFab.style.display='none';zoomFab.title="확대/축소";const zi=document.createElement('div');zi.className='ytd-fab-icon';const zs=document.createElementNS(svgNS,'svg');zs.setAttribute('viewBox','0 0 24 24');zs.setAttribute('fill','none');zs.setAttribute('stroke-width','2');zs.setAttribute('stroke-linecap','round');zs.setAttribute('stroke-linejoin','round');const zc=document.createElementNS(svgNS,'circle');zc.setAttribute('cx','11');zc.setAttribute('cy','11');zc.setAttribute('r','8');zc.style.stroke='#4a5060';const zl=document.createElementNS(svgNS,'line');zl.setAttribute('x1','21');zl.setAttribute('y1','21');zl.setAttribute('x2','16.65');zl.setAttribute('y2','16.65');zl.style.stroke='#4a5060';const zp1=document.createElementNS(svgNS,'line');zp1.setAttribute('x1','11');zp1.setAttribute('y1','8');zp1.setAttribute('x2','11');zp1.setAttribute('y2','14');zp1.style.stroke='#4a5060';const zp2=document.createElementNS(svgNS,'line');zp2.setAttribute('x1','8');zp2.setAttribute('y1','11');zp2.setAttribute('x2','14');zp2.setAttribute('y2','11');zp2.style.stroke='#4a5060';zs.appendChild(zc);zs.appendChild(zl);zs.appendChild(zp1);zs.appendChild(zp2);zi.appendChild(zs);zoomFab.appendChild(zi);document.documentElement.appendChild(zoomFab);}document.documentElement.appendChild(mirrorFab);document.documentElement.appendChild(maxFab);let dragging=false,moved=false,dragStartX=0,dragStartY=0;const dragOrigins=new Map();const activeFabList=()=>[maxFab,mirrorFab,zoomFab].filter(Boolean);const onDown=(e,t)=>{if(e.button!==0)return;dragging=true;moved=false;dragStartX=e.clientX;dragStartY=e.clientY;dragOrigins.clear();for(const f of activeFabList()){const r=f.getBoundingClientRect();dragOrigins.set(f,{x:r.left,y:r.top});}t.setPointerCapture(e.pointerId);e.preventDefault();};const onMove=e=>{if(!dragging)return;const dx=e.clientX-dragStartX,dy=e.clientY-dragStartY;if(!moved&&Math.abs(dx)<4&&Math.abs(dy)<4)return;moved=true;for(const f of activeFabList()){const o=dragOrigins.get(f);if(!o)continue;f.style.left=(o.x+dx)+'px';f.style.top=(o.y+dy)+'px';f.style.right='auto';}};const fabActions=new Map([[maxFab,()=>Maximizer.toggle()],[mirrorFab,()=>Mirror.toggle()]]);if(zoomFab)fabActions.set(zoomFab,()=>Zoom.cycleStep());for(const[btn,action]of fabActions){btn.addEventListener('pointerdown',e=>onDown(e,btn));btn.addEventListener('pointermove',onMove);btn.addEventListener('pointerup',e=>{if(!dragging)return;dragging=false;btn.releasePointerCapture(e.pointerId);if(!moved)action();});}}

  function init(){buildFab();autoDetect();new MutationObserver(()=>scheduleDetect()).observe(document.body||document.documentElement,{childList:true,subtree:true});document.addEventListener('fullscreenchange',onFsChange);document.addEventListener('webkitfullscreenchange',onFsChange);setInterval(()=>{if(liveVideo&&!liveVideo.isConnected){liveVideo=null;}autoDetect();if(Mirror.isActive()){const best=pickBestVideo();if(best)Mirror.onNewVideo(best);}},3000);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
