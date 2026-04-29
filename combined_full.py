# -*- coding: utf-8 -*-
"""
combined.py
- PC용:     combined_pc_full.txt
- 모바일용: combined_mobile_full.txt
- 상태 보고서: filter_status_full.md
"""
import subprocess, sys
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ============================================================
# 필터 소스 URL
# ============================================================
ADGUARD_PC_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",  # EasyList
    "https://filters.adtidy.org/windows/filters/3.txt",         # Tracking Protection
    "https://filters.adtidy.org/windows/filters/4.txt",         # Social Media
    "https://filters.adtidy.org/windows/filters/7.txt",         # Japanese
    "https://filters.adtidy.org/windows/filters/18.txt",        # Cookie Notices
    "https://filters.adtidy.org/windows/filters/19.txt",        # Popups
    "https://filters.adtidy.org/windows/filters/20.txt",        # Mobile App Banners
    "https://filters.adtidy.org/windows/filters/21.txt",        # Other Annoyances
    "https://filters.adtidy.org/windows/filters/22.txt",        # Widgets
    "https://filters.adtidy.org/windows/filters/208.txt",       # Online Malicious URL
    "https://filters.adtidy.org/windows/filters/224.txt",       # Chinese
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
]

ADGUARD_MOBILE_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",          # EasyList
    "https://filters.adtidy.org/android/filters/3_optimized.txt",       # Tracking Protection
    "https://filters.adtidy.org/android/filters/4_optimized.txt",       # Social Media
    "https://filters.adtidy.org/android/filters/7_optimized.txt",       # Japanese
    "https://filters.adtidy.org/android/filters/18_optimized.txt",      # Cookie Notices
    "https://filters.adtidy.org/android/filters/19_optimized.txt",      # Popups
    "https://filters.adtidy.org/android/filters/20_optimized.txt",      # Mobile App Banners
    "https://filters.adtidy.org/android/filters/21_optimized.txt",      # Other Annoyances
    "https://filters.adtidy.org/android/filters/22_optimized.txt",      # Widgets
    "https://filters.adtidy.org/android/filters/208_optimized.txt",     # Online Malicious URL
    "https://filters.adtidy.org/android/filters/224_optimized.txt",     # Chinese
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
]

# ============================================================
# 소스 이름
# ============================================================
FILTER_NAMES = {
    "easylist.txt":      "EasyList",
    "3.txt":             "AdGuard Tracking Protection filter",
    "3_optimized.txt":   "AdGuard Tracking Protection filter",
    "4.txt":             "AdGuard Social Media filter",
    "4_optimized.txt":   "AdGuard Social Media filter",
    "7.txt":             "AdGuard Japanese filter",
    "7_optimized.txt":   "AdGuard Japanese filter",
    "18.txt":            "AdGuard Cookie Notices filter",
    "18_optimized.txt":  "AdGuard Cookie Notices filter",
    "19.txt":            "AdGuard Popups filter",
    "19_optimized.txt":  "AdGuard Popups filter",
    "20.txt":            "AdGuard Mobile App Banners filter",
    "20_optimized.txt":  "AdGuard Mobile App Banners filter",
    "21.txt":            "AdGuard Other Annoyances filter",
    "21_optimized.txt":  "AdGuard Other Annoyances filter",
    "22.txt":            "AdGuard Widgets filter",
    "22_optimized.txt":  "AdGuard Widgets filter",
    "208.txt":           "Online Malicious URL Blocklist",
    "208_optimized.txt": "Online Malicious URL Blocklist",
    "224.txt":           "AdGuard Chinese filter",
    "224_optimized.txt": "AdGuard Chinese filter",
    "filterslist-AdGuard-classic.txt": "List-KR Classic filter list",
}

def get_source_name(url):
    fid = url.split("/")[-1]
    return FILTER_NAMES.get(fid, "Unknown - " + fid)

# ============================================================
# 필터링 함수 (주석/빈줄 제거)
# ============================================================
_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#", "#@%#")

def is_skip_line(line):
    if not line: return True
    if line.startswith("!"): return True
    if line.startswith("["): return True
    if line.startswith("#") and not any(line.startswith(p) for p in _VALID_HASH_PREFIXES):
        return True
    return False

# ============================================================
# 다운로드 함수
# ============================================================
def download_filters(urls):
    source_blocks, results = [], []
    for url in urls:
        name = get_source_name(url)
        rules = []
        try:
            print(f"  Downloading: {name}")
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            for ln in resp.text.splitlines():
                s = ln.strip()
                if is_skip_line(s):
                    continue
                rules.append(s)
            source_blocks.append((name, url, rules))
            results.append({"url": url, "name": name, "status": "OK",
                            "code": resp.status_code, "rules": len(rules)})
            print(f"    -> {len(rules):,} rules")
        except requests.exceptions.HTTPError as e:
            results.append({"url": url, "name": name, "status": "HTTP_ERROR",
                            "code": getattr(e.response, "status_code", "N/A"), "rules": 0})
            print(f"    -> HTTP ERROR")
        except requests.exceptions.Timeout:
            results.append({"url": url, "name": name, "status": "TIMEOUT",
                            "code": "N/A", "rules": 0})
            print(f"    -> TIMEOUT")
        except Exception as e:
            results.append({"url": url, "name": name, "status": "ERROR",
                            "code": "N/A", "rules": 0})
            print(f"    -> ERROR: {e}")
    return source_blocks, results

# ============================================================
# 파일 출력 함수 (중복 제거 포함)
# ============================================================
def write_filter_file(filename, source_blocks, results, platform_label, now):
    seen = set()
    unique_blocks = []
    for name, url, rules in source_blocks:
        unique_rules = []
        for r in rules:
            if r not in seen:
                seen.add(r)
                unique_rules.append(r)
        unique_blocks.append((name, url, unique_rules))

    total = sum(len(b[2]) for b in unique_blocks)
    ok = sum(1 for r in results if r["status"] == "OK")
    header = (
        f"! Title: My Combined Filter ({platform_label})\n"
        f"! Description: EasyList + AdGuard 보조 필터 통합\n"
        f"! Expires: 12 hours\n"
        f"! Generated: {now} (KST)\n"
        f"! Total rules: {total:,}\n"
        f"! Sources: {ok}/{len(results)} filter lists OK\n"
        f"! Note: 필터 추가 시 'Trusted' 체크 필수\n"
    )
    with open(filename, "w", encoding="utf-8") as f:
        f.write(header)
        for name, url, rules in unique_blocks:
            if not rules:
                continue
            f.write(f"\n! ========================================\n")
            f.write(f"! >>> {name}\n")
            f.write(f"! >>> {url}\n")
            f.write(f"! >>> Rules: {len(rules):,}\n")
            f.write(f"! ========================================\n")
            for rule in rules:
                f.write(rule + "\n")
    return total, ok

# ============================================================
# 메인 실행
# ============================================================
KST = timezone(timedelta(hours=9))
now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")

print("\n=== PC 필터 컴파일 ===")
pc_blocks, pc_results = download_filters(ADGUARD_PC_URLS)

print("\n=== 모바일 필터 컴파일 ===")
mob_blocks, mob_results = download_filters(ADGUARD_MOBILE_URLS)

pc_total, pc_ok = write_filter_file(
    "combined_pc_full.txt", pc_blocks, pc_results, "AdGuard PC", now)
mob_total, mob_ok = write_filter_file(
    "combined_mobile_full.txt", mob_blocks, mob_results, "AdGuard Mobile", now)

# ============================================================
# filter_status_full.md
# ============================================================
all_results = [("PC", pc_results), ("Mobile", mob_results)]
report = [
    "# Filter Status Report", "",
    f"**Updated:** {now} (KST)", "",
]
for platform, results in all_results:
    ok = sum(1 for r in results if r["status"] == "OK")
    fail = len(results) - ok
    total = sum(r["rules"] for r in results)
    report += [
        f"## {platform}",
        f"**Sources:** {len(results)} total | ✅ {ok} OK | ❌ {fail} Failed",
        f"**Total rules:** {total:,}", "",
        "| Status | Code | Rules | Source |",
        "|--------|------|-------|--------|",
    ]
    for r in results:
        icon = "✅" if r["status"] == "OK" else "❌"
        report.append(f"| {icon} {r['status']} | {r['code']} | {r['rules']:,} | {r['name']} |")
    if fail > 0:
        report.append("")
        report.append("### Failed Sources")
        for r in results:
            if r["status"] != "OK":
                report.append(f"- ❌ **{r['name']}**: {r['status']} (`{r['url']}`)")
    report.append("")

with open("filter_status_full.md", "w", encoding="utf-8") as f:
    f.write("\n".join(report))

# ============================================================
# 최종 출력
# ============================================================
print("\n" + "=" * 60)
print(f"  Generated: {now} (KST)")
print(f"  PC     : combined_pc_full.txt     -> {pc_total:,} rules")
print(f"  Mobile : combined_mobile_full.txt -> {mob_total:,} rules")
print(f"  filter_status_full.md -> 상태 보고서")
print("=" * 60)
print()
print("📌 AdGuard 사용법:")
print("   PC     -> combined_pc_full.txt 구독")
print("   Mobile -> combined_mobile_full.txt 구독")
print("   + 추가할 때 'Trusted(신뢰할 수 있음)' 체크박스 활성화")
