# -*- coding: utf-8 -*-
"""
combined.py
- uBlock Origin용: combined_ublock.txt + trusted_ublock.txt
- AdGuard 용:       combined_adguard.txt  (전부 포함, trusted 체크로 해결)
- 상태 보고서:       filter_status.md
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
    "https://filters.adtidy.org/extension/ublock/filters/2.txt",
    "https://filters.adtidy.org/extension/ublock/filters/11.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
    "https://filters.adtidy.org/extension/ublock/filters/17.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-uBlockOrigin-unified.txt",
    "https://filters.adtidy.org/extension/ublock/filters/7.txt",
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

# ---- trusted 전용 규칙 판별 ----
_TRUSTED_SCRIPTLET_NAMES = (
    "trusted-",       # trusted- 로 시작하는 모든 scriptlet
    "rpnt",           # replace-node-text 약어
)

_JS_SCRIPTLET_RE = re.compile(r"#\+js\(([^,)]+)")

def is_trusted_only(line):
    # scriptlet 검사 (##+js(...) 또는 #@#+js(...))
    m = _JS_SCRIPTLET_RE.search(line)
    if m:
        name = m.group(1).strip()
        if any(name == t or name.startswith(t) for t in _TRUSTED_SCRIPTLET_NAMES):
            return True

    # 네트워크 필터 옵션 검사 (줄 전체에서 검색)
    if "$replace=" in line or ",replace=" in line:
        return True
    if "$uritransform=" in line or ",uritransform=" in line:
        return True
    if "$urlskip=" in line or ",urlskip=" in line:
        return True

    return False

# ---- 다운로드 및 분류 ----
source_blocks = []      # (name, url, normal_rules, trusted_rules)
results = []

for url in urls:
    name = get_source_name(url)
    normal_rules = []
    trusted_rules = []
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
            if is_trusted_only(s):
                trusted_rules.append(s)
            else:
                normal_rules.append(s)

        source_blocks.append((name, url, normal_rules, trusted_rules))
        results.append({
            "url": url, "name": name, "status": "OK",
            "code": resp.status_code,
            "normal": len(normal_rules),
            "trusted": len(trusted_rules),
            "total": len(normal_rules) + len(trusted_rules),
        })
        print(f"  -> normal: {len(normal_rules)}, trusted: {len(trusted_rules)}")

    except requests.exceptions.HTTPError as e:
        results.append({"url": url, "name": name, "status": "HTTP_ERROR",
                        "code": getattr(e.response, "status_code", "N/A"),
                        "normal": 0, "trusted": 0, "total": 0})
        print(f"  -> HTTP ERROR")
    except requests.exceptions.Timeout:
        results.append({"url": url, "name": name, "status": "TIMEOUT",
                        "code": "N/A", "normal": 0, "trusted": 0, "total": 0})
        print(f"  -> TIMEOUT")
    except Exception as e:
        results.append({"url": url, "name": name, "status": "ERROR",
                        "code": "N/A", "normal": 0, "trusted": 0, "total": 0})
        print(f"  -> ERROR: {e}")

# ---- 통계 ----
KST = timezone(timedelta(hours=9))
now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")

total_normal = sum(len(b[2]) for b in source_blocks)
total_trusted = sum(len(b[3]) for b in source_blocks)
total_all = total_normal + total_trusted
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count

# ========================================
# 1) uBlock Origin용: combined_ublock.txt (일반 규칙만)
# ========================================
ublock_header = (
    f"! Title: My Combined Filter (uBlock Origin)\n"
    f"! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합 (일반 규칙)\n"
    f"! Expires: 12 hours\n"
    f"! Generated: {now} (KST)\n"
    f"! Total rules: {total_normal}\n"
    f"! Sources: {ok_count}/{len(results)} filter lists OK\n"
    f"! Note: trusted 규칙은 trusted_ublock.txt 에 별도 분리\n"
)

with open("combined_ublock.txt", "w", encoding="utf-8") as f:
    f.write(ublock_header)
    for name, url, normal_rules, trusted_rules in source_blocks:
        if not normal_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(normal_rules)}\n")
        f.write(f"! ========================================\n")
        for rule in normal_rules:
            f.write(rule + "\n")

# ========================================
# 2) uBlock Origin용: trusted_ublock.txt (trusted 규칙만)
# ========================================
trusted_header = (
    f"! Title: My Combined Filter - Trusted Rules (uBlock Origin)\n"
    f"! Description: trusted scriptlet / replace / uritransform / urlskip 규칙\n"
    f"! Generated: {now} (KST)\n"
    f"! Total trusted rules: {total_trusted}\n"
    f"! Usage: uBO 대시보드 → 내 필터에 붙여넣기\n"
    f"!        \"Allow custom filters requiring trust\" 체크 필요\n"
)

with open("trusted_ublock.txt", "w", encoding="utf-8") as f:
    f.write(trusted_header)
    for name, url, normal_rules, trusted_rules in source_blocks:
        if not trusted_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Trusted Rules: {len(trusted_rules)}\n")
        f.write(f"! ========================================\n")
        for rule in trusted_rules:
            f.write(rule + "\n")

# ========================================
# 3) AdGuard용: combined_adguard.txt (전체 규칙 포함)
# ========================================
adguard_header = (
    f"! Title: My Combined Filter (AdGuard)\n"
    f"! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합 (전체)\n"
    f"! Expires: 12 hours\n"
    f"! Generated: {now} (KST)\n"
    f"! Total rules: {total_all}\n"
    f"! Sources: {ok_count}/{len(results)} filter lists OK\n"
    f"! Note: AdGuard 데스크톱 앱에서 커스텀 필터 추가 시 'Trusted' 체크 필요\n"
)

with open("combined_adguard.txt", "w", encoding="utf-8") as f:
    f.write(adguard_header)
    for name, url, normal_rules, trusted_rules in source_blocks:
        all_rules = normal_rules + trusted_rules
        if not all_rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(all_rules)} (normal: {len(normal_rules)}, trusted: {len(trusted_rules)})\n")
        f.write(f"! ========================================\n")
        for rule in all_rules:
            f.write(rule + "\n")

# ========================================
# 4) 상태 보고서: filter_status.md
# ========================================
report = [
    "# Filter Status Report", "",
    f"**Updated:** {now} (KST)", "",
    f"**Sources:** {len(results)} total | ✅ {ok_count} OK | ❌ {fail_count} Failed", "",
    "| File | Rules |",
    "|------|-------|",
    f"| `combined_ublock.txt` | {total_normal:,} (일반 규칙) |",
    f"| `trusted_ublock.txt` | {total_trusted:,} (trusted 규칙) |",
    f"| `combined_adguard.txt` | {total_all:,} (전체) |",
    "",
    "## Source Details", "",
    "| Status | Code | Normal | Trusted | Total | Source |",
    "|--------|------|--------|---------|-------|--------|",
]
for r in results:
    icon = "✅" if r["status"] == "OK" else "❌"
    report.append(
        f"| {icon} {r['status']} | {r['code']} | "
        f"{r['normal']:,} | {r['trusted']:,} | {r['total']:,} | {r['name']} |"
    )

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
print(f"  combined_ublock.txt  -> {total_normal:,} rules (일반)")
print(f"  trusted_ublock.txt   -> {total_trusted:,} rules (trusted)")
print(f"  combined_adguard.txt -> {total_all:,} rules (전체)")
print(f"  filter_status.md     -> 상태 보고서")
print(f"=" * 55)
print()
print("📌 uBlock Origin 사용법:")
print("   1. combined_ublock.txt → URL로 구독")
print("   2. trusted_ublock.txt  → '내 필터'에 붙여넣기")
print("      + 'Allow custom filters requiring trust' 체크")
print()
print("📌 AdGuard 데스크톱 앱 사용법:")
print("   1. combined_adguard.txt → 커스텀 필터로 URL 구독")
print("      + 추가할 때 'Trusted' 체크박스 활성화")
