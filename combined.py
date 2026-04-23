# -*- coding: utf-8 -*-
"""
combined.py
- AdGuard용: combined_filters.txt (전처리 지시문을 AdGuard 환경 기준으로 평가)
- 상태 보고서: filter_status.md
"""
import subprocess, sys, re
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ============================================================
# AdGuard for Windows 전처리 상수
# ============================================================
ADGUARD_CONSTANTS = {
    "adguard":                True,
    "adguard_app_windows":    True,
    "adguard_app_mac":        False,
    "adguard_app_android":    False,
    "adguard_app_ios":        False,
    "adguard_ext_chromium":   False,
    "adguard_ext_firefox":    False,
    "adguard_ext_edge":       False,
    "adguard_ext_safari":     False,
    "adguard_ext_opera":      False,
    "adguard_ext_android_cb": False,
    "ext_ublock":             False,
    "ext_ubol":               False,
    "ext_abp":                False,
    "ext_devbuild":           False,
    "env_chromium":           False,
    "env_edge":               False,
    "env_firefox":            False,
    "env_mobile":             False,
    "env_safari":             False,
    "env_mv3":                False,
    "cap_html_filtering":     True,
    "cap_user_stylesheet":    True,
    "false":                  False,
}


def _split_outside_parens(expr, operator):
    parts = []
    depth = 0
    current = ""
    i = 0
    while i < len(expr):
        if expr[i] == "(":
            depth += 1
            current += expr[i]
        elif expr[i] == ")":
            depth -= 1
            current += expr[i]
        elif depth == 0 and expr[i:i+len(operator)] == operator:
            parts.append(current)
            current = ""
            i += len(operator)
            continue
        else:
            current += expr[i]
        i += 1
    parts.append(current)
    return parts if len(parts) > 1 else [expr]


def evaluate_condition(cond):
    expr = cond.strip()
    while expr.startswith("(") and expr.endswith(")"):
        inner = expr[1:-1]
        depth = 0
        ok = True
        for ch in inner:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    ok = False
                    break
        if ok and depth == 0:
            expr = inner.strip()
        else:
            break

    parts = _split_outside_parens(expr, "||")
    if len(parts) > 1:
        return any(evaluate_condition(p) for p in parts)

    parts = _split_outside_parens(expr, "&&")
    if len(parts) > 1:
        return all(evaluate_condition(p) for p in parts)

    if expr.startswith("!"):
        return not evaluate_condition(expr[1:])

    return ADGUARD_CONSTANTS.get(expr.strip(), False)


def preprocess_lines(lines):
    result = []
    stack = []
    for line in lines:
        s = line.strip()
        if s.startswith("!#if "):
            condition = s[5:].strip()
            cond_val = evaluate_condition(condition)
            parent_active = all(item[0] for item in stack) if stack else True
            stack.append((cond_val and parent_active, False, cond_val))
            continue
        if s == "!#else":
            if stack:
                active, _, orig_cond = stack[-1]
                parent_active = all(item[0] for item in stack[:-1]) if len(stack) > 1 else True
                stack[-1] = (not orig_cond and parent_active, True, orig_cond)
            continue
        if s == "!#endif":
            if stack:
                stack.pop()
            continue
        if s.startswith("!#include "):
            continue
        is_active = all(item[0] for item in stack) if stack else True
        if is_active:
            result.append(line)
    return result


# ============================================================
# 필터 소스 URL
# ============================================================
urls = [
    # AdGuard 네이티브 필터 (우선순위 상위)
    "https://filters.adtidy.org/windows/filters/2.txt",
    "https://filters.adtidy.org/windows/filters/11.txt",
    "https://filters.adtidy.org/windows/filters/14.txt",
    "https://filters.adtidy.org/windows/filters/17.txt",
    "https://filters.adtidy.org/windows/filters/7.txt",
    # EasyList 계열 (안정적인 미러 사용)
    "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
    # uBlock Origin 필터 (부분 호환)
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://ublockorigin.github.io/uAssets/filters/badware.txt",
    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
    "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt",
    "https://ublockorigin.github.io/uAssets/filters/unbreak.txt",
    # List-KR
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-unified.txt",
]


def get_source_name(url):
    if "uAssets/filters/" in url:
        return "uBlock Origin - " + url.split("/")[-1]
    if "uAssets/thirdparties/" in url:
        return "uBlock Origin (3rd) - " + url.split("/")[-1]
    if "list-kr" in url or "List-KR" in url:
        fname = url.split("/")[-1]
        tag = fname.replace("filterslist-AdGuard-", "").replace(".txt", "")
        return f"List-KR - {tag}"
    if "adtidy.org" in url:
        return "AdGuard - " + url.split("/")[-1]
    if "easylist.to" in url:
        return "EasyList - " + url.split("/")[-1]
    return url.split("/")[-1]


_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#", "#@%#")

def is_skip_line(line):
    if not line:
        return True
    if line.startswith("!"):
        return True
    if line.startswith("["):
        return True
    if line.startswith("#") and not any(line.startswith(p) for p in _VALID_HASH_PREFIXES):
        return True
    return False


def is_incompatible(line):
    if ":-abp-" in line:
        return True
    return False

# ============================================================
# 다운로드 및 수집
# ============================================================
source_blocks = []
results = []

for url in urls:
    name = get_source_name(url)
    rules = []
    try:
        print(f"Downloading: {name}")
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()

        raw_lines = resp.text.splitlines()
        processed = preprocess_lines(raw_lines)

        for ln in processed:
            s = ln.strip()
            if is_skip_line(s):
                continue
            if is_incompatible(s):
                continue
            rules.append(s)

        source_blocks.append((name, url, rules))
        results.append({"url": url, "name": name, "status": "OK",
                        "code": resp.status_code, "rules": len(rules)})
        print(f"  -> {len(rules):,} rules")

    except requests.exceptions.HTTPError as e:
        results.append({"url": url, "name": name, "status": "HTTP_ERROR",
                        "code": getattr(e.response, "status_code", "N/A"), "rules": 0})
        print(f"  -> HTTP ERROR")
    except requests.exceptions.Timeout:
        results.append({"url": url, "name": name, "status": "TIMEOUT",
                        "code": "N/A", "rules": 0})
        print(f"  -> TIMEOUT")
    except Exception as e:
        results.append({"url": url, "name": name, "status": "ERROR",
                        "code": "N/A", "rules": 0})
        print(f"  -> ERROR: {e}")


# ============================================================
# 통계
# ============================================================
KST = timezone(timedelta(hours=9))
now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")

total_rules = sum(len(b[2]) for b in source_blocks)
ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = len(results) - ok_count


# ============================================================
# combined_filters.txt
# ============================================================
# ✅ 수정: \\n → \n (실제 개행문자)
header = (
    f"! Title: My Combined Filter (AdGuard)\n"
    f"! Description: AdGuard + uBlock 필터\n"
    f"! Expires: 12 hours\n"
    f"! Generated: {now} (KST)\n"
    f"! Total rules: {total_rules:,}\n"
    f"! Sources: {ok_count}/{len(results)} filter lists OK\n"
    f"! Preprocessor: AdGuard for Windows 환경으로 !#if 지시문 평가됨\n"
    f"! Note: 필터 추가 시 '신뢰할 수 있는 필터임(Trusted)' 체크 필수\n"
)

with open("combined_filters.txt", "w", encoding="utf-8") as f:
    f.write(header)
    for name, url, rules in source_blocks:
        if not rules:
            continue
        f.write(f"\n! ========================================\n")
        f.write(f"! >>> {name}\n")
        f.write(f"! >>> {url}\n")
        f.write(f"! >>> Rules: {len(rules):,}\n")
        f.write(f"! ========================================\n")
        for rule in rules:
            f.write(rule + "\n")


# ============================================================
# filter_status.md
# ============================================================
report = [
    "# Filter Status Report", "",
    f"**Updated:** {now} (KST)", "",
    f"**Sources:** {len(results)} total | ✅ {ok_count} OK | ❌ {fail_count} Failed",
    f"**Total rules:** {total_rules:,}",
    f"**Preprocessor:** `!#if` directives evaluated for AdGuard for Windows", "",
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
            report.append(f"- ❌ **{r['name']}**: {r['status']} (`{r['url']}`)")

# ✅ 수정: \\n → \n
with open("filter_status.md", "w", encoding="utf-8") as f:
    f.write("\n".join(report))


# ============================================================
# 최종 출력
# ============================================================
# ✅ 수정: \\n → \n
print("\n" + "=" * 60)
print(f"  Generated: {now} (KST)")
print(f"  Preprocessor: AdGuard for Windows")
print(f"  Sources: {ok_count}/{len(results)} OK")
print(f"")
print(f"  combined_filters.txt -> {total_rules:,} rules")
print(f"  filter_status.md     -> 상태 보고서")
print(f"=" * 60)
print()
print("📌 AdGuard Desktop 사용법:")
print("   combined_filters.txt → 커스텀 필터 URL 구독")
print("   + 추가할 때 'Trusted(신뢰할 수 있음)' 체크박스 활성화")
