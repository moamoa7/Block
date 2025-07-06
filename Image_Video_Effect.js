// ==UserScript==
// @name         Image and Video Effect
// @namespace    Violentmonkey Scripts
// @version      1.0
// @description  이미지 & 비디오 화질 보정
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start  // 페이지 로드 전에 스타일 적용
// ==/UserScript==

// 화이트리스트 도메인 설정 (여기에 포함된 도메인에서는 이미지 및 비디오에 효과를 적용하지 않음)
const imageWhitelist = [
  'example.com',  // 이미지 화이트리스트 도메인
  'example.com',   // 예시
];

const videoWhitelist = [
  'example.com',  // 비디오 화이트리스트 도메인
  'example.com',   // 예시
];

(function() {
  'use strict';

  const currentHost = window.location.hostname;

  // 이미지 화이트리스트에 포함되지 않은 도메인에서만 이미지 스타일 적용
  if (!imageWhitelist.includes(currentHost)) {
    GM_addStyle(`
      /* 모든 이미지에 초기 투명도 적용 */
      img {
        opacity: 1;  // 이미지의 초기 투명도 설정
        transition: opacity 0.3s ease, filter 0.3s ease !important; /* opacity와 filter의 변화가 동시에 부드럽게 일어남 */
        //filter: brightness(1.0555) contrast(1) saturate(1.0755) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        //-webkit-filter: brightness(1.0555) contrast(1) saturate(1.0755) !important;
        //filter: brightness(1.0375) contrast(1.0250) saturate(0.9875) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        //-webkit-filter: brightness(1.0375) contrast(1.0250) saturate(0.9875) !important;
        //filter: brightness(1.0654) contrast(1.0250) saturate(0.8765) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        //-webkit-filter: brightness(1.0654) contrast(1.0250) saturate(0.8765) !important;
        //filter: brightness(1.1234) contrast(1.0234) saturate(0.7890) !important;  // 밝기 1.1234배, 대비 1.0234배, 채도 0.7890배
        //-webkit-filter: brightness(1.1234) contrast(1.0234) saturate(0.7890) !important;
        filter: brightness(1.0250) contrast(1.0500) saturate(0.9750) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        -webkit-filter: brightness(1.0250) contrast(1.0500) saturate(0.9750) !important;
      }

      /* 마우스를 올리면 불투명하게 변경 */
      img:hover {
        opacity: 1;  // 이미지에 마우스를 올리면 불투명하게 설정
        transition: opacity 0.3s ease, filter 0.3s ease !important; /* opacity와 filter의 변화가 동시에 부드럽게 일어남 */
        filter: brightness(1) contrast(1) saturate(1) !important;  // 밝기 1배, 대비 1배, 채도 1배
        -webkit-filter: brightness(1) contrast(1) saturate(1) !important;
      }
    `);
  }

  // 비디오 화이트리스트에 포함되지 않은 도메인에서만 비디오 스타일 적용
  if (!videoWhitelist.includes(currentHost)) {
    GM_addStyle(`
      /* 모든 비디오의 초기 투명도 설정 및 sharpness 효과 */
      video {
        opacity: 1;  // 비디오는 항상 불투명
        transition: opacity 0.3s ease, filter 0.3s ease !important; /* opacity와 filter의 변화가 동시에 부드럽게 일어남 */
        //filter: brightness(1.0555) contrast(1) saturate(1.1) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        //-webkit-filter: brightness(1.0555) contrast(1) saturate(1.0755) !important;
        //filter: brightness(1.1234) contrast(1.0555) saturate(0.7775) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        //-webkit-filter: brightness(1.1234) contrast(1.0555) saturate(0.7775) !important;
        //filter: brightness(1.1234) contrast(1.0234) saturate(0.7890) !important;  // 밝기 1.3456배, 대비 1.0345배, 채도 0.6789배
        //-webkit-filter: brightness(1.1234) contrast(1.0234) saturate(0.7890) !important;
        //filter: brightness(1.0987) contrast(1.0123) saturate(0.6789) !important;  // 밝기 1.3456배, 대비 1.0345배, 채도 0.6789배
        //-webkit-filter: brightness(1.0987) contrast(1.0234) saturate(0.78990) !important;
        filter: brightness(1.0500) contrast(1.1000) saturate(0.9500) !important;  // 밝기 1.0555배, 대비 1배, 채도 1.0755배
        -webkit-filter: brightness(1.0500) contrast(1.1000) saturate(0.9500) !important;
      }
      /* 마우스를 올리면 필터 리셋 */
      video:hover {
        opacity: 1;  // 비디오는 항상 불투명
        transition: opacity 0.3s ease, filter 0.3s ease !important; /* opacity와 filter의 변화가 동시에 부드럽게 일어남 */
        filter: brightness(1) contrast(1) saturate(1) !important;  // 밝기 1배, 대비 1배, 채도 1배
        -webkit-filter: brightness(1) contrast(1) saturate(1) !important;
      }
    `);
  }

  // 디버깅을 위한 로그
  console.log('Transparent Image and Video with Hover Effect 스크립트 실행됨');
})();
