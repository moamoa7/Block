# -*- coding: utf-8 -*-
"""
combined.py
- AdGuard용: combined_filters.txt (전체 규칙 포함, Trusted 체크로 해결)
- 상태 보고서: filter_status.md
"""
import subprocess, sys, re
from datetime import datetime, timezone, timedelta

# ---- 의존성 자동 설치 ----
try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ---- 필터 소스 URL ----
urls = [
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://ublockorigin.github.io/uAssets/filters/badware.txt",
    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
    "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt",
    "https://ublockorigin.github.io/uAssets/filters/unbreak.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt",
    ""https://filters.adtidy.org/windows/filters/2.txt"",
    "https://filters.adtidy.org/windows/filters/11.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
    "https://filters.adtidy.org/windwos/filters/17.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-unified.txt",
    "https://filters.adtidy.org/windows/filters/7.txt",
]

# ---- 소스 이름 추출 ----
def get_source_name(url):
    if "uAssets/filters/" in url:
        return "uBlock Origin - " + url.split("/")[-1]
    if "uAssets/thirdparties/" in url:
        return "uBlock Origin (3rd) - " + url.split("/")[-1]
    if "yokoffing" in url:
        return "yokoffing - " + url.split("/")[-1]
    if "list-kr" in url or "List-KR" in url:
        return "List-KR - unified"
    if "adtidy.org" in url:
        return "AdGuard - " + url.split("/")[-1]
    return url.split("/")[-1]

# ---- 주석 / 메타데이터 판별 ----
_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#", "#@%#")

def is_skip_line(line):
    if not line:
        return True
    if line.startswith("!"):
        return True
    if line.startswith("["):
        return True
    if line.startswith("#") and not line.startswith(_VALID_HASH_PREFIXES):
        return True
    return False

# ---- ABP 전용 비호환 구문 ----
def is_incompatible(line):
    if ":-abp-" in line:
        return True
    return False

# ---- 다운로드 및 수집 ----
source_blocks = []      # (name, url, rules)
results = []

for url in urls:
    name = get_source_name(url)
    rules = []
    try:
        print(f"Downloading: {name}")
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()

        for ln in resp.text.splitlines():
            s = ln.strip()
            if is_skip_line(s):
                continue
            if is_incompatible(s):
                continue
            rules.append(s)

        source_blocks.append((name, url, rules))
        results.append({
            "url": url, "name": name, "status": "OK",
            "code": resp.status_code,
            "rules": len(rules),
        })
        print(f"  -> {len(rules)} rules")

    except requests.exceptions.HTTPError as e:
        results.append({"url": url, "name": name, "status": "HTTP_ERROR",
                        "code": getattr(e.response, "status_code", "N/A"),
                        "rules": 0})
        print(f"  -> HTTP ERROR")
    except requests.exceptions.Timeout:
        results.append({"url": url, "name": name, "status": "TIMEOUT",
                        "code": "N/A", "rules": 0})
        print(f"  -> TIMEOUT")
    except Exception as e:
        results.append({"url": url, "name": name, "status": "ERROR",
                        "code": "N/A", "rules": 0})
        print(f"  -> ERROR: {e}")

# ---- 통계 ----
KST = timezone(timedelta(hours=9))
now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")

total_rules = sum(len(b[2]) for b in source_blocks)
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count

# ========================================
# AdGuard용: combined_adguard.txt (전체 규칙 포함)
# ========================================
adguard_header = (
    f"! Title: My Combined Filter (AdGuard)\n"
    f"! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합\n"
    f"! Expires: 12 hours\n"
    f"! Generated: {now} (KST)\n"
    f"! Total rules: {total_rules}\n"
    f"! Sources: {ok_count}/{len(results)} filter lists OK\n"
    f"! Note: AdGuard 데스크톱 앱에서 커스텀 필터 추가 시 'Trusted' 체크 필요\n"
)

with open("combined_filters.txt", "w", encoding="utf-8") as f:
    f.write(adguard_header)
    for name, url, rules in source_blocks:
        if not rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(rules)}\n")
        f.write(f"! ========================================\n")
        for rule in rules:
            f.write(rule + "\n")

# ========================================
# 상태 보고서: filter_status.md
# ========================================
report = [
    "# Filter Status Report", "",
    f"**Updated:** {now} (KST)", "",
    f"**Sources:** {len(results)} total | ✅ {ok_count} OK | ❌ {fail_count} Failed",
    f"**Total rules:** {total_rules:,}", "",
    "## Source Details", "",
    "| Status | Code | Rules | Source |",
    "|--------|------|-------|--------|",
]
for r in results:
    icon = "✅" if r["status"] == "OK" else "❌"
    report.append(f"| {icon} {r['status']} | {r['code']} | {r['rules']:,} | {r['name']} |")

if fail_count > 0:
    report.append("")
    report.append("## Failed Sources")
    report.append("")
    for r in results:
        if r["status"] != "OK":
            report.append(f"- ❌ **{r['name']}**: {r['status']} ({r['url']})")

with open("filter_status.md", "w", encoding="utf-8") as f:
    f.write("\n".join(report))

# ---- 최종 출력 ----
print("\n" + "=" * 55)
print(f"  Generated: {now} (KST)")
print(f"  Sources: {ok_count}/{len(results)} OK")
print(f"")
print(f"  combined_filters.txt -> {total_rules:,} rules")
print(f"  filter_status.md     -> 상태 보고서")
print(f"=" * 55)
print()
print("📌 AdGuard 데스크톱 앱 사용법:")
print("   1. combined_adguard.txt → 커스텀 필터로 URL 구독")
print("      + 추가할 때 'Trusted' 체크박스 활성화")
