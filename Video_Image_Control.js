범용 우선(SVG)에서의 “다른 로직”이란?
SVG 필터 체인 내부에서 아래를 추가하는 방식입니다:

영상의 밝기(luma) 를 뽑아서
Shadow 마스크 / Highlight 마스크(부드러운 그라데이션) 를 만들고
원본을 두 갈래로 복제해서
Shadow 쪽에는 Teal tint(청록 기운)
Highlight 쪽에는 Orange tint(주황 기운)
를 각각 적용한 뒤
마스크로 “섀도우 구간/하이라이트 구간에만” 섞어줌 (split-toning)
이렇게 하면 Teal 필터는 확실히 Teal&Orange 느낌이 나고, Film/Anime도 룩 차이가 훨씬 선명해집니다.
그리고 중요한 점: 이 방식은 “SVG/CSS 필터”라서 DRM 포함 영상에서도(대부분의 브라우저/사이트에서) 적용이 되는 쪽입니다. (단, 사이트/브라우저가 필터를 강제로 무력화하는 특수 케이스는 예외)

구현 방향(당신 코드에 어떻게 넣는가)
당신은 지금 체인이 대략:

SourceGraphic → smartDim → sharpen → profileMatrix → saturate → gamma → toneCurve → (noise/dither/blur) → colorTemp

이 구조죠.

여기서 split-toning은 toneCurve 다음, grain/noise 전에 넣는 게 보통 가장 자연스럽습니다.

필터 노드(개념도)
tone_out (현재 toneCurve 결과)
A) luma_to_alpha : luma를 알파로 만든 마스크 소스
shadow_mask (어두운 곳에서 alpha=1)
highlight_mask (밝은 곳에서 alpha=1)
B) shadow_tint_matrix : teal tint 적용한 영상
C) highlight_tint_matrix : orange tint 적용한 영상
D) 마스크로 섞기(원본 + (tint-원본)maskstrength)
“진짜 Teal&Orange”에 가까운 SVG split-toning 핵심 (중요)
단순히 shadowTinted를 shadowMask로 in 해서 더하는 방식만 쓰면 결과가 탁해질 수 있어요.
가장 깔끔한 공식은 보통 이겁니다:

out = base + (tint - base) * mask * strength

SVG에서는 이걸 feComposite operator="arithmetic"(차이 계산) + feComposite operator="in"(마스크 적용) + 다시 arithmetic(더하기)로 구현합니다.

최소 패치 예시(핵심 부분만)
아래는 “어떤 노드를 추가해야 하는지”를 보여주는 예시입니다. (그대로 복붙하면 동작까지 보장하려면, 당신 _createElements()에 맞춰 result/in 이름을 정확히 연결해야 해서 그 부분은 추가 조정이 필요합니다)

1) luma→alpha 마스크 만들기
JavaScript

// tone_out 에서 밝기(luma)를 alpha로 복사
const lumaToAlpha = createSvgElement('feColorMatrix', {
  "data-vsc-id": "luma_to_alpha",
  in: "tone_out",
  type: "matrix",
  values: `
    0 0 0 0 0
    0 0 0 0 0
    0 0 0 0 0
    0.2126 0.7152 0.0722 0 0
  `,
  result: "luma_a"
});
2) shadow/highlight 마스크
JavaScript

// shadow: (1 - luma)^exp
const shadowInv = createSvgElement('feComponentTransfer', {
  "data-vsc-id":"shadow_inv",
  in:"luma_a",
  result:"shadow0"
}, createSvgElement('feFuncA', { type:"linear", slope:"-1", intercept:"1" }));

const shadowMask = createSvgElement('feComponentTransfer', {
  "data-vsc-id":"shadow_mask",
  in:"shadow0",
  result:"shadow_m"
}, createSvgElement('feFuncA', { type:"gamma", exponent:"1.6" }));

// highlight: luma^exp
const highlightMask = createSvgElement('feComponentTransfer', {
  "data-vsc-id":"highlight_mask",
  in:"luma_a",
  result:"highlight_m"
}, createSvgElement('feFuncA', { type:"gamma", exponent:"1.6" }));
3) 틴트(색행렬) + 섞기
JavaScript

// shadow tint / highlight tint (values는 updateFilterValues에서 프로파일별로 바꿈)
const shadowTint = createSvgElement('feColorMatrix', {
  "data-vsc-id":"shadow_tint_matrix",
  in:"tone_out",
  type:"matrix",
  values:"1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0",
  result:"shadow_t"
});

const highlightTint = createSvgElement('feColorMatrix', {
  "data-vsc-id":"highlight_tint_matrix",
  in:"tone_out",
  type:"matrix",
  values:"1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0",
  result:"highlight_t"
});

// diff = tint - base
const shadowDiff = createSvgElement('feComposite', {
  "data-vsc-id":"shadow_diff",
  in:"shadow_t", in2:"tone_out",
  operator:"arithmetic", k1:"0", k2:"1", k3:"-1", k4:"0",
  result:"shadow_diff"
});

// maskedDiff = diff * shadowMask
const shadowMaskedDiff = createSvgElement('feComposite', {
  "data-vsc-id":"shadow_masked_diff",
  in:"shadow_diff", in2:"shadow_m",
  operator:"in",
  result:"shadow_md"
});

// outShadow = base + maskedDiff * shadowStrength  (k3가 strength)
const afterShadow = createSvgElement('feComposite', {
  "data-vsc-id":"after_shadow",
  in:"tone_out", in2:"shadow_md",
  operator:"arithmetic", k1:"0", k2:"1", k3:"0.35", k4:"0",
  result:"after_shadow"
});

// 하이라이트도 동일하게 after_shadow를 base로 한 번 더 적용
프로파일(Film/Teal/Anime)은 뭘로 차이를 내나?
SVG split-toning 방식에서 “룩 차이”는 보통 아래 3개로 만듭니다.

shadowTintMatrix / highlightTintMatrix 값(색 방향)
shadowStrength / highlightStrength (섞는 양)
shadow/highlight 마스크 exponent (경계 부드러움/범위)
예시 컨셉:

Film: 아주 약한 “쿨 섀도 + 웜 하이라이트”, 대비/포화는 절제
Teal: 섀도우를 확실히 청록, 하이라이트를 확실히 오렌지
Anime: split-toning은 약하게/거의 끄고, 채도/감마/콘트라스트로 “선명하고 화사하게”
