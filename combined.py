# -*- coding: utf-8 -*-
import subprocess
import sys
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    print("requests 설치 중...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ==================== 필터 URL 목록 ====================
urls = [
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://ublockorigin.github.io/uAssets/filters/badware.txt",
    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
    "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt",
    "https://ublockorigin.github.io/uAssets/filters/unbreak.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
    "https://raw.githubusercontent.com/yokoffing/filterlists/main/block_third_party_fonts.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-uBlockOrigin-unified.txt",
    "https://filters.adtidy.org/extension/ublock/filters/7.txt",
]

# ==================== 주석/메타데이터 판별 ====================
_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#")

def is_comment_line(line: str) -> bool:
    if line.startswith('!'):
        return True
    if line.startswith('['):
        return True
    if line.startswith('#') and not line.startswith(_VALID_HASH_PREFIXES):
        return True
    return False

def join_continuation_lines(text: str) -> list:
    """
    백슬래시(\\)로 끝나는 줄을 다음 줄과 이어붙인다.
    uBlock Origin의 line continuation 문법 처리.
    """
    raw_lines = text.splitlines()
    joined = []
    buffer = ""

    for line in raw_lines:
        stripped = line.rstrip()
        if stripped.endswith('\\'):
            # 백슬래시 제거하고 다음 줄과 연결
            buffer += stripped[:-1]
        else:
            if buffer:
                buffer += stripped
                joined.append(buffer)
                buffer = ""
            else:
                joined.append(stripped)

    # 마지막 줄이 백슬래시로 끝난 경우 처리
    if buffer:
        joined.append(buffer)

    return joined

# ==================== 필터 다운로드 및 병합 ====================
rules = set()
results = []

for url in urls:
    try:
        print(f"다운로드 중: {url}")
        response = requests.get(url, timeout=15)
        response.raise_for_status()

        # 줄 연속 문법 먼저 처리한 뒤 파싱
        lines = join_continuation_lines(response.text)

        count = 0
        for line in lines:
            stripped = line.strip()
            if stripped and not is_comment_line(stripped):
                rules.add(stripped)
                count += 1

        print(f"  -> {count}개 규칙 수집")
        results.append({
            "url": url,
            "status": "OK",
            "code": response.status_code,
            "rules": count,
        })

    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response is not None else "N/A"
        print(f"  -> HTTP 에러: {code}")
        results.append({
            "url": url,
            "status": "HTTP_ERROR",
            "code": code,
            "rules": 0,
        })

    except requests.exceptions.Timeout:
        print(f"  -> 타임아웃")
        results.append({
            "url": url,
            "status": "TIMEOUT",
            "code": "N/A",
            "rules": 0,
        })

    except Exception as e:
        print(f"  -> 실패: {e}")
        results.append({
            "url": url,
            "status": "ERROR",
            "code": "N/A",
            "rules": 0,
        })

# ==================== 타임스탬프 ====================
tz_kst = timezone(timedelta(hours=9))
timestamp = datetime.now(tz_kst).strftime("%Y-%m-%d %H:%M:%S")

# ==================== 상태 리포트 생성 ====================
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count

report_lines = []
report_lines.append(f"# Filter Status Report")
report_lines.append(f"")
report_lines.append(f"Updated: {timestamp} (KST)")
report_lines.append(f"")
report_lines.append(f"Total: {len(results)} sources | OK: {ok_count} | Failed: {fail_count}")
report_lines.append(f"")
report_lines.append(f"Total unique rules: {len(rules):,}")
report_lines.append(f"")
report_lines.append(f"| Status | Code | Rules | URL |")
report_lines.append(f"|--------|------|-------|-----|")

for r in results:
    icon = "✅" if r["status"] == "OK" else "❌"
    report_lines.append(f"| {icon} {r['status']} | {r['code']} | {r['rules']:,} | {r['url']} |")

if fail_count > 0:
    report_lines.append(f"")
    report_lines.append(f"## ⚠️ Failed Sources")
    report_lines.append(f"")
    for r in results:
        if r["status"] != "OK":
            report_lines.append(f"- **{r['status']}** (code: {r['code']}): {r['url']}")

report_text = "\n".join(report_lines) + "\n"

with open("filter_status.md", "w", encoding="utf-8") as f:
    f.write(report_text)

print(f"\n상태 리포트 저장: filter_status.md")

# ==================== 필터 파일 생성 ====================
header = f"""! Title: My Combined Filter
! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합
! Generated: {timestamp} (KST)
! Total unique rules: {len(rules)}
! Sources: {ok_count}/{len(results)} filter lists OK
"""

with open("combined_filters.txt", "w", encoding="utf-8") as f:
    f.write(header)
    for rule in sorted(rules):
        f.write(rule + "\n")

# ==================== 결과 출력 ====================
print(f"\n{'='*50}")
print(f"완료! -> combined_filters.txt")
print(f"총 고유 규칙 수: {len(rules):,}")
print(f"성공: {ok_count}/{len(results)}")
if fail_count > 0:
    print(f"\n⚠️  {fail_count}개 소스 실패:")
    for r in results:
        if r["status"] != "OK":
            print(f"  [{r['code']}] {r['url']}")
