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
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-uBlockOrigin-unified.txt",
    "https://filters.adtidy.org/extension/ublock/filters/7.txt",
]

# ==================== 줄 판별 ====================
_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#")

def is_metadata(line: str) -> bool:
    meta_prefixes = (
        '! Title:', '! Last modified:', '! Expires:', '! Description:',
        '! Homepage:', '! License:', '! Licence:', '! Forums:', '! Version:',
    )
    if line.startswith(meta_prefixes):
        return True
    if line.startswith('['):
        return True
    return False

def is_pure_comment(line: str) -> bool:
    if not line:
        return True
    if line.startswith('!#'):
        return False
    if line.startswith('!'):
        return True
    if line.startswith('['):
        return True
    if line.startswith('#') and not line.startswith(_VALID_HASH_PREFIXES):
        return True
    return False

def get_source_name(url: str) -> str:
    if 'uAssets/filters/' in url:
        return "uBlock Origin - " + url.split('/')[-1]
    elif 'uAssets/thirdparties/' in url:
        return "uBlock Origin (3rd) - " + url.split('/')[-1]
    elif 'yokoffing' in url:
        return "yokoffing - " + url.split('/')[-1]
    elif 'list-kr' in url:
        return "List-KR - unified"
    elif 'adtidy.org' in url:
        return "AdGuard - " + url.split('/')[-1]
    else:
        return url.split('/')[-1]

# ==================== 다운로드 및 병합 ====================
source_blocks = []
results = []

for url in urls:
    try:
        print(f"다운로드 중: {url}")
        response = requests.get(url, timeout=15)
        response.raise_for_status()

        source_name = get_source_name(url)
        block_rules = []

        for line in response.text.splitlines():
            stripped = line.strip()
            if not stripped or is_metadata(stripped):
                continue
            if is_pure_comment(stripped):
                continue
            block_rules.append(stripped)

        source_blocks.append((source_name, url, block_rules))
        print(f"  -> {len(block_rules)}개 규칙 수집")
        results.append({
            "url": url,
            "status": "OK",
            "code": response.status_code,
            "rules": len(block_rules),
        })

    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response is not None else "N/A"
        print(f"  -> HTTP 에러: {code}")
        results.append({"url": url, "status": "HTTP_ERROR", "code": code, "rules": 0})

    except requests.exceptions.Timeout:
        print(f"  -> 타임아웃")
        results.append({"url": url, "status": "TIMEOUT", "code": "N/A", "rules": 0})

    except Exception as e:
        print(f"  -> 실패: {e}")
        results.append({"url": url, "status": "ERROR", "code": "N/A", "rules": 0})

# ==================== 타임스탬프 ====================
tz_kst = timezone(timedelta(hours=9))
timestamp = datetime.now(tz_kst).strftime("%Y-%m-%d %H:%M:%S")
total_rules = sum(len(rules) for _, _, rules in source_blocks)

# ==================== 상태 리포트 ====================
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count

report_lines = [
    "# Filter Status Report", "",
    f"Updated: {timestamp} (KST)", "",
    f"Total: {len(results)} sources | OK: {ok_count} | Failed: {fail_count}", "",
    f"Total rules: {total_rules:,}", "",
    "| Status | Code | Rules | URL |",
    "|--------|------|-------|-----|",
]
for r in results:
    icon = "✅" if r["status"] == "OK" else "❌"
    report_lines.append(f"| {icon} {r['status']} | {r['code']} | {r['rules']:,} | {r['url']} |")

if fail_count > 0:
    report_lines += ["", "## ⚠️ Failed Sources", ""]
    for r in results:
        if r["status"] != "OK":
            report_lines.append(f"- **{r['status']}** (code: {r['code']}): {r['url']}")

with open("filter_status.md", "w", encoding="utf-8") as f:
    f.write("\n".join(report_lines) + "\n")

# ==================== 필터 파일 생성 ====================
header = f"""! Title: My Combined Filter
! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합
! Generated: {timestamp} (KST)
! Total rules: {total_rules}
! Sources: {ok_count}/{len(results)} filter lists OK
"""

with open("combined_filters.txt", "w", encoding="utf-8") as f:
    f.write(header)

    for source_name, url, block_rules in source_blocks:
        if not block_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {source_name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(block_rules)}\n")
        f.write(f"! ========================================\n")

        for rule in block_rules:
            f.write(rule + "\n")

# ==================== 결과 출력 ====================
print(f"\n{'='*50}")
print(f"완료! -> combined_filters.txt")
print(f"총 규칙 수: {total_rules:,}")
print(f"성공: {ok_count}/{len(results)}")
if fail_count > 0:
    print(f"\n⚠️  {fail_count}개 소스 실패:")
    for r in results:
        if r["status"] != "OK":
            print(f"  [{r['code']}] {r['url']}")
