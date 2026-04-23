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

def is_skip_line(line: str) -> bool:
    if not line:
        return True
    if line.startswith('!'):
        return True
    if line.startswith('['):
        return True
    if line.startswith('#') and not line.startswith(_VALID_HASH_PREFIXES):
        return True
    return False

def is_trusted_only(line: str) -> bool:
    """신뢰된 소스에서만 동작하는 규칙인지 판별"""
    # trusted- scriptlet
    if '##+js(trusted-' in line or '#@#+js(trusted-' in line:
        return True
    # $replace=, $uritransform=, $urlskip= 옵션
    if '$' in line:
        # $ 뒤의 옵션 부분에서 확인
        dollar_pos = line.rfind('$')
        options_part = line[dollar_pos:]
        if 'replace=' in options_part:
            return True
        if 'uritransform=' in options_part:
            return True
        if 'urlskip=' in options_part:
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
        normal_rules = []
        trusted_rules = []

        for line in response.text.splitlines():
            stripped = line.strip()
            if is_skip_line(stripped):
                continue
            if is_trusted_only(stripped):
                trusted_rules.append(stripped)
            else:
                normal_rules.append(stripped)

        source_blocks.append((source_name, url, normal_rules, trusted_rules))
        total = len(normal_rules) + len(trusted_rules)
        print(f"  -> {total}개 (일반: {len(normal_rules)}, trusted: {len(trusted_rules)})")
        results.append({
            "url": url,
            "status": "OK",
            "code": response.status_code,
            "rules": total,
            "trusted": len(trusted_rules),
        })

    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response is not None else "N/A"
        print(f"  -> HTTP 에러: {code}")
        results.append({"url": url, "status": "HTTP_ERROR", "code": code, "rules": 0, "trusted": 0})

    except requests.exceptions.Timeout:
        print(f"  -> 타임아웃")
        results.append({"url": url, "status": "TIMEOUT", "code": "N/A", "rules": 0, "trusted": 0})

    except Exception as e:
        print(f"  -> 실패: {e}")
        results.append({"url": url, "status": "ERROR", "code": "N/A", "rules": 0, "trusted": 0})

# ==================== 타임스탬프 ====================
tz_kst = timezone(timedelta(hours=9))
timestamp = datetime.now(tz_kst).strftime("%Y-%m-%d %H:%M:%S")
total_normal = sum(len(n) for _, _, n, _ in source_blocks)
total_trusted = sum(len(t) for _, _, _, t in source_blocks)

# ==================== 상태 리포트 ====================
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count

report_lines = [
    "# Filter Status Report", "",
    f"Updated: {timestamp} (KST)", "",
    f"Total: {len(results)} sources | OK: {ok_count} | Failed: {fail_count}", "",
    f"Normal rules: {total_normal:,} → combined_filters.txt (URL로 구독)", "",
    f"Trusted rules: {total_trusted:,} → trusted_filters.txt (내 필터에 붙여넣기)", "",
    "| Status | Code | Rules | Trusted | URL |",
    "|--------|------|-------|---------|-----|",
]
for r in results:
    icon = "✅" if r["status"] == "OK" else "❌"
    report_lines.append(f"| {icon} {r['status']} | {r['code']} | {r['rules']:,} | {r['trusted']:,} | {r['url']} |")

if fail_count > 0:
    report_lines += ["", "## ⚠️ Failed Sources", ""]
    for r in results:
        if r["status"] != "OK":
            report_lines.append(f"- **{r['status']}** (code: {r['code']}): {r['url']}")

with open("filter_status.md", "w", encoding="utf-8") as f:
    f.write("\n".join(report_lines) + "\n")

# ==================== 일반 필터 파일 ====================
header_normal = f"""! Title: My Combined Filter
! Description: uBlock Origin + EasyList + EasyPrivacy + ListKR + AdGuard Japanese
! Generated: {timestamp} (KST)
! Total rules: {total_normal}
! Sources: {ok_count}/{len(results)} filter lists OK
"""

with open("combined_filters.txt", "w", encoding="utf-8") as f:
    f.write(header_normal)
    for source_name, url, normal_rules, _ in source_blocks:
        if not normal_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {source_name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(normal_rules)}\n")
        f.write(f"! ========================================\n")
        for rule in normal_rules:
            f.write(rule + "\n")

# ==================== trusted 필터 파일 ====================
header_trusted = f"""! Title: My Combined Filter - Trusted Rules
! Description: trusted 전용 규칙 (uBlock Origin "내 필터"에 붙여넣기)
! Generated: {timestamp} (KST)
! Total rules: {total_trusted}
! 포함 대상: trusted- scriptlet, $replace, $uritransform, $urlskip
"""

with open("trusted_filters.txt", "w", encoding="utf-8") as f:
    f.write(header_trusted)
    for source_name, url, _, trusted_rules in source_blocks:
        if not trusted_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {source_name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Trusted Rules: {len(trusted_rules)}\n")
        f.write(f"! ========================================\n")
        for rule in trusted_rules:
            f.write(rule + "\n")

# ==================== 결과 출력 ====================
print(f"\n{'='*50}")
print(f"완료!")
print(f"  combined_filters.txt  -> 일반 규칙: {total_normal:,}")
print(f"  trusted_filters.txt   -> trusted 규칙: {total_trusted:,}")
print(f"성공: {ok_count}/{len(results)}")
if fail_count > 0:
    print(f"\n⚠️  {fail_count}개 소스 실패:")
    for r in results:
        if r["status"] != "OK":
            print(f"  [{r['code']}] {r['url']}")

print(f"\n📌 사용법:")
print(f"  1. combined_filters.txt → uBlock Origin 필터 목록에 URL로 구독")
print(f"  2. trusted_filters.txt  → 내용 복사 → uBlock Origin '내 필터'에 붙여넣기")
