# uBO → AdGuard 변환 리포트

**Updated:** 2026-04-27 14:36:04 (KST)  
**Converter:** Python built-in  
**Output:** `ubo_converted.txt`  

## Summary

| 항목 | 값 |
|------|-----|
| Sources | 6 total |
| ✅ OK | 6 |
| ❌ Failed | 0 |
| Converted rules | 14,986 |
| Skipped rules | 195 |
| Conversion rate | 98.7% |

## Filter Details

| Status | Filter | Raw | Converted | Skipped | Rate | Method |
|--------|--------|-----|-----------|---------|------|--------|
| ✅ OK | uBlock filters | 6,232 | 6,156 | 76 | 99% | python |
| ✅ OK | uBlock filters – Privacy | 1,628 | 1,593 | 35 | 98% | python |
| ✅ OK | uBlock filters – Unbreak | 2,510 | 2,479 | 31 | 99% | python |
| ✅ OK | uBlock filters – Badware risks | 4,457 | 4,455 | 2 | 100% | python |
| ✅ OK | uBlock filters – Quick fixes | 285 | 234 | 51 | 82% | python |
| ✅ OK | uBlock filters – Resource abuse | 69 | 69 | 0 | 100% | python |

## Skipped Rules 참고

변환이 스킵된 룰은 uBO 전용 문법으로 AdGuard에서 지원하지 않는 것들입니다:

| 패턴 | 설명 |
|------|------|
| `!#if` / `!#else` / `!#endif` | 조건부 컴파일 (환경별 분기) |
| `##+js(trusted-...)` | Trusted 스크립틀릿 (uBO 전용) |
| `##^` | HTML 필터링 (AdGuard는 `$$` 문법) |
| `:matches-path()` | URL 경로 매칭 (uBO 전용) |
| `:matches-attr()` | 속성 정규식 매칭 (uBO 전용) |
| `:upward()` | 상위 요소 선택 (uBO 전용) |