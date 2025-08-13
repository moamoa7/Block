// ==UserScript==
// @name        Pop-Up Block (Weaboo) + Whitelist + Blacklist + AutoClose + popupBlocker Module
// @namespace   http://tampermonkey.net/
// @description Max popup blocking with UI preserved + session, keyword, iframe & timer hooking
// @include     *
// @version     4.7.0-integrated
// @author      weaboo (mod+enhanced by ChatGPT)
// @license     aanriski™ - ©weaboo
// @grant       none
// @run-at      document-start
// ==/UserScript==

(function(){

    // ---------------------- 화이트리스트/블랙리스트 ----------------------
    const WHITELIST = ["etoland.co.kr/pages/points.php"];
    const BLACKLIST = [/madurird\.com/i, /22hgc\.com/i];

    function isWhitelisted() {
        const url = location.href.toLowerCase();
        return WHITELIST.some(item => url.includes(item.toLowerCase()));
    }
    function isBlacklisted(url){
        url = (url||location.href).toLowerCase();
        return BLACKLIST.some(re => re.test(url));
    }

    // ---------------------- 기존 UI 유지 함수 ----------------------
    var t,e=2,o=4,n=8,s=16,i=32,r=0,a={a:!0,button:{type:"submit"},input:!0,select:!0,option:!0},l=0,p=window.open,c=window.showModalDialog,d=null,m=0;
    function y(msg,args){ return !!(r & e) && confirm(msg+" ("+Array.prototype.slice.call(args).join(", ")+")"); }
    function u(){ return !(r & o) || Date.now()>l+100; }
    function x(){ return !!(r & n) && "https:"==location.protocol; }
    function w(el){ var v=el.tagName && a[el.tagName.toLowerCase()]; if(v && typeof v==="object") for(var k in v) if(el[k]!=el[k]) return !1; return v; }
    function T(e){ var el=e.target; if(!(e instanceof MouseEvent && (null!=e.button?0!=e.button:1!=e.which))){ while(el.parentElement && !w(el)) el=el.parentElement; t=el; } }
    function f(str){ return String(str).replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g,"\\$1").replace(/\x08/g,"\\x08"); }
    window.addEventListener("mousedown", e=>{l=Date.now();T(e)},true);
    window.addEventListener("click", e=>{l=Date.now();T(e)},true);
    window.addEventListener("change", e=>{l=Date.now();T(e)},true);

    function v(msg,e,o,n){
        var r=document.body.parentElement,a=document.createElement("div");
        a.onclick=()=>false;
        if(d===null)d=parseFloat((r.currentStyle||window.getComputedStyle(r)).marginTop);
        k(a);
        a.style.cssText+="background: InfoBackground;border-bottom:1px solid WindowFrame;box-sizing:border-box;font:small-caption;padding:.5em 1em;position:fixed;left:0;right:0;top:-100%;transition:top .25s;display:flex;align-items:center;justify-content:space-between;white-space:nowrap;z-index:2147483647;border-radius:8px;";
        var l=document.createElement("span");
        l.style.cssText+="cursor:pointer;display:inline-block;margin-left:.75em;line-height:2.1;";
        l.appendChild(document.createTextNode("╳"));
        l.onclick=function(ev){ev.stopPropagation();--m||(r.style.marginTop=d+"px");a.style.top="-"+a.offsetHeight+"px";setTimeout(()=>document.body.removeChild(a),250);return false;};
        a.appendChild(l); a.appendChild(document.createTextNode(" ⛔ "+msg));
        m||(r.style.transition="margin-top .25s");
        document.body.appendChild(a);
        setTimeout(()=>{a.style.top="0px"; m||(r.style.marginTop=(d+a.offsetHeight)+"px"); m++;},0);
        setTimeout(()=>{l.onclick()},n||3000);
    }
    function k(el){if(el.tagName.toLowerCase()!=="button"){el.style.cssText="background:transparent;border:none;border-radius:0";if(el.tagName.toLowerCase()==="a")el.style.cursor="pointer";}else el.style.cursor="auto"; el.style.cssText+="bottom:auto;box-shadow:none;color:WindowText;font:medium serif;letter-spacing:0;line-height:normal;margin:0;opacity:1;outline:none;padding:0;position:static;text-align:left;text-shadow:none;text-transform:none;width:auto;white-space:normal;"}

    // ---------------------- 블랙리스트 접근 차단 ----------------------
    if(isBlacklisted()){
        document.addEventListener("DOMContentLoaded", ()=>{
            v("🚫 Access Blocked: Blacklisted site",null,null,5000);
            document.body.innerHTML="";
        });
        window.stop();
        console.warn("[Pop-Up Blocker] Blacklisted site blocked:", location.href);
        return;
    }

    if(isWhitelisted()){
        console.info("[Pop-Up Blocker] Whitelisted site:", location.hostname);
        return;
    }

    // =========================
    // --- popupBlocker 모듈 통합 ---
    // =========================
    const popupBlocker = (() => {
        const ALLOW_ON_USER_INTERACTION = true;
        const AUTO_CLOSE_DELAY = 300; // ms
        const MAX_POPUPS_PER_SESSION = 5;
        const WHITELIST = ['example.com'];
        const BLACKLIST = ['22hgc.com','badpopup.site'];
        const BLOCKED_KEYWORDS = ['adclick','redirect','tracking','popunder','doubleclick'];
        const MIN_WIDTH=100, MIN_HEIGHT=100;
        let popupCount=0,lastInteractionTime=0;
        const originalOpen=window.open;

        const getDomain=url=>{try{return new URL(url).hostname}catch{return ''}};
        const isUserInitiated=()=>Date.now()-lastInteractionTime<500;
        const isBlockedURL=(url='')=>{
            const domain=getDomain(url);
            const lower=url.toLowerCase();
            if(WHITELIST.some(w=>domain.endsWith(w))) return false;
            if(BLACKLIST.some(b=>domain.endsWith(b))) return true;
            return BLOCKED_KEYWORDS.some(k=>lower.includes(k));
        };
        const isSuspiciousSize=options=>{
            if(!options) return false;
            const win=options.toLowerCase();
            return /width=\d+/.test(win)&&/height=\d+/.test(win)&&(
                parseInt(win.match(/width=(\d+)/)?.[1]||0)<MIN_WIDTH ||
                parseInt(win.match(/height=(\d+)/)?.[1]||0)<MIN_HEIGHT
            );
        };
        const getFakeWindow=()=>({closed:true,close:()=>{},focus:()=>{}});

        const logPopup=(status,reason,url)=>{
            const level=status==='BLOCKED'?'warn':'info';
            logManager?.addOnce?.(`popup_${status.toLowerCase()}_${getDomain(url)}`,`🔗 ${status}: ${reason} | ${getDomain(url)}`,6000,level);
        };

        const overrideOpen=()=>{
            window.open=function(url,name,specs,replace){
                const domain=getDomain(url||'');
                const userClick=isUserInitiated();
                const keywordBlocked=isBlockedURL(url);
                const sizeBlocked=isSuspiciousSize(specs);
                const overLimit=popupCount>=MAX_POPUPS_PER_SESSION;
                const reasons=[];
                if(!userClick) reasons.push('비사용자 이벤트');
                if(keywordBlocked) reasons.push('키워드');
                if(sizeBlocked) reasons.push('작은창');
                if(overLimit) reasons.push('횟수 초과');
                if(reasons.length>0){ logPopup('BLOCKED',reasons.join(','),url); return getFakeWindow(); }
                popupCount++;
                logPopup('ALLOWED','정상 허용',url);
                const popup=originalOpen.call(this,url,name,specs,replace);
                if(popup && AUTO_CLOSE_DELAY>0){ setTimeout(()=>{try{popup.close()}catch{}},AUTO_CLOSE_DELAY);}
                return popup;
            };
        };

        const lockOpen=()=>{
            try{ Object.defineProperty(window,'open',{value:window.open,writable:false,configurable:false,enumerable:true}); } catch(err){ logManager?.addOnce?.('window_open_lock_fail',`⚠️ window.open 보호 실패: ${err.message}`,5000,'warn'); }
        };
        const registerUserEvents=()=>{ const updateTime=()=>{lastInteractionTime=Date.now();}; ['click','keydown','mousedown','touchstart'].forEach(evt=>window.addEventListener(evt,updateTime,true));};
        const blockInIframe=()=>{ if(window.self!==window.top){ window.open=function(url,...rest){ logManager?.addOnce?.(`popup_iframe_block_${Date.now()}`,`🧱 iframe 내 팝업 차단 | ${url||'(빈 URL)'}`,5000,'warn'); return getFakeWindow(); } } };

        const resetCount=()=>{ popupCount=0; };

        const init=()=>{
            if(window.self!==window.top){ blockInIframe(); } 
            else{ registerUserEvents(); overrideOpen(); lockOpen(); }
            logManager?.add?.('popup_blocker_init','✅ popupBlocker 초기화 완료',5000,'debug');
        };

        return {init,resetCount};
    })();

    popupBlocker.init();

    // ---------------------- 기존 후킹 로직 유지 ----------------------
    const originalOpen = window.open;
    window._popupFlag=false;
    window.open=function(){
        let url=arguments[0];
        try{ url=url?new URL(url,location.href).href:""; }catch{ url=""; }
        if(isBlacklisted(url)){ v("🚫 Blocked popup from blacklisted site: "+url); return null; }
        window._popupFlag=true;
        if(!y("Allow popup?",arguments) || !x() && u()){ v("Pop-Up Blocked!",arguments[0],arguments[1],3000); return {}; }
        return originalOpen.apply(this,arguments);
    };
    window.showModalDialog=function(){ v("Blocked modal dialog",arguments[0],null,3000); return {}; };

    // ---------------------- 강화 로직 ----------------------
    try{ Object.defineProperty(window,'opener',{value:null,writable:false}); }catch{}
    ['assign','replace','reload'].forEach(fn=>{
        const orig=location[fn].bind(location);
        location[fn]=function(...args){ console.warn("[Pop-Up Blocker] Blocked location."+fn,args); v("Blocked forced navigation"); };
    });
    document.addEventListener('click', e=>{
        if(!e.isTrusted){ e.stopImmediatePropagation(); e.preventDefault(); v("Blocked synthetic click"); }
        const link=e.target.closest && e.target.closest('a[target="_blank"]');
        if(link){ e.preventDefault(); v("Blocked new tab link"); }
    },true);

    // ---------------------- timer / eval / Function 후킹 ----------------------
    function wrapTimer(orig){ return function(fn,delay,...rest){ if(typeof fn==='function'){ const wrapped=(...args)=>{ window._popupFlag=false; fn.apply(this,args); if(window._popupFlag){ v("Blocked popup from timer"); window._popupFlag=false; } }; return orig(wrapped,delay,...rest); } return orig(fn,delay,...rest); }; }
    window.setTimeout=wrapTimer(window.setTimeout);
    window.setInterval=wrapTimer(window.setInterval);
    const origEval=window.eval;
    window.eval=function(code){ try{ return origEval(code); }catch(e){ console.warn(e); } };
    const origFunction=window.Function;
    window.Function=function(...args){ return origFunction(...args); };

    // ---------------------- iframe 후킹 ----------------------
    function hookIframes(doc){
        doc.querySelectorAll('iframe').forEach(f=>{
            try{ f.contentWindow.open = window.open; f.contentWindow.eval = window.eval; f.contentWindow.Function = window.Function; }catch(e){}
        });
    }
    hookIframes(document);
    new MutationObserver(muts=>{
        muts.forEach(m=>{
            m.addedNodes.forEach(n=>{
                if(n.tagName==="IFRAME") hookIframes(n.contentDocument||n.contentWindow.document||document);
            });
        });
    }).observe(document,{childList:true,subtree:true});

    console.info("[Pop-Up Blocker] Fully integrated max protection active ✅");

})();
