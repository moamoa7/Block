#!/usr/bin/env python3
import re
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import urlopen, Request

# --- 설정 ---
FILTER_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",
    "https://filters.adtidy.org/windows/filters/2.txt",
    "https://filters.adtidy.org/windows/filters/11.txt",
    "https://filters.adtidy.org/windows/filters/7.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/multi.txt",
]
# 외부 화이트리스트 (개인 블록리스트보다 우선순위 낮음)
EXCLUSION_URLS = [
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
    "https://raw.githubusercontent.com/KnightmareVIIVIIXC/AIO-Firebog-Blocklists/refs/heads/main/exclusions/exclusions.txt",
]
# 블록리스트 (외부 화이트리스트보다 우선)
PERSONAL_BLOCK_URLS = [
    "https://raw.githubusercontent.com/sjhgvr/oisd/refs/heads/main/oisd_small.txt",
    "https://raw.githubusercontent.com/moamoa7/adblock/main/block.txt",
]
# 개인 화이트리스트 (최종 - 모든 블록리스트보다 우선)
PERSONAL_WHITE_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]
REFERENCE_URL = "https://filters.adtidy.org/windows/filters/15.txt"

OUTPUT_DIR = Path("output")
OUT_COMBINED = OUTPUT_DIR / "Block_DNS.txt"
OUT_DOMAINS = OUTPUT_DIR / "Block_Domains.txt"
OUT_HOSTS = OUTPUT_DIR / "Block_Hosts.txt"
OUT_REPORT = OUTPUT_DIR / "Report.txt"

def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="ignore")

def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3:
        return False
    return bool(re.match(
        r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$", d
    ))

def short_name(url: str) -> str:
    if "easylist.txt" in url: return "EasyList"
    if "filters/2.txt" in url: return "AdGuard Base"
    if "filters/11.txt" in url: return "AdGuard Mobile"
    if "filters/7.txt" in url: return "AdGuard Japanese"
    if "list-kr" in url: return "List-KR"
    if "uAssets" in url: return "uBlock Filters"
    if "adblock/multi.txt" in url: return "HaGeZi's Normal DNS Blocklist"
    if "oisd_small.txt" in url: return "oisd small"
    if "main/block.txt" in url: return "Personal Blocklist"
    if "exclusions.txt" in url: return "AdGuard DNS Exclusions"
    if "AIO-Firebog-Blocklists" in url: return "AIO-Firebog Exclusions"
    if "white.txt" in url: return "Personal Whitelist"
    if "filters/15.txt" in url: return "AdGuard DNS Filter"
    return url.split("/")[-1]

def extract_block_domains(text: str) -> set:
    """||domain^ 형태에서 도메인 추출 (popup/document 옵션 허용)"""
    out = set()
    for line in text.splitlines():
        m = re.match(
            r"^\|\|([a-z0-9\-\.]+)\^(\$(popup|document)(,(popup|document))?)?\s*$",
            line.strip().lower()
        )
        if m and is_valid_domain(m.group(1)):
            out.add(m.group(1))
    return out

def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    report_lines = []
    report_lines.append(f"{'=' * 60}")
    report_lines.append(f"  Filter Extraction Report")
    report_lines.append(f"  Generated: {ts}")
    report_lines.append(f"{'=' * 60}")

    # 0. 기준 필터 로드
    reference_set = set()
    report_lines.append(f"\n[ Reference Filter ]")
    report_lines.append(f"{'-' * 60}")
    try:
        text = fetch(REFERENCE_URL)
        total_lines = len(text.splitlines())
        for line in text.splitlines():
            stripped = line.strip().lower()
            m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", stripped)
            if m and is_valid_domain(m.group(1)):
                reference_set.add(m.group(1))
        report_lines.append(f"  [OK] AdGuard DNS Filter")
        report_lines.append(f"       URL: {REFERENCE_URL}")
        report_lines.append(f"       Total Lines: {total_lines:,} | Domains: {len(reference_set):,}")
    except Exception as e:
        report_lines.append(f"  [FAIL] AdGuard DNS Filter - {e}")
        print(f"[WARN] 기준 필터 실패: {REFERENCE_URL} ({e})")

    # 1. 외부 화이트리스트 로드
    white_set = set()
    report_lines.append(f"\n[ External Whitelist Sources ]")
    report_lines.append(f"{'-' * 60}")
    for url in EXCLUSION_URLS:
        name = short_name(url)
        try:
            text = fetch(url)
            total_lines = len(text.splitlines())
            count = 0
            for line in text.splitlines():
                m = re.match(r"^\|\|([a-z0-9\-\.]+)\^(\$popup)?\s*$", line.strip().lower())
                if m and is_valid_domain(m.group(1)):
                    white_set.add(m.group(1))
                    count += 1
            report_lines.append(f"  [OK] {name}")
            report_lines.append(f"       URL: {url}")
            report_lines.append(f"       Total Lines: {total_lines:,} | Extracted: {count:,}")
        except Exception as e:
            report_lines.append(f"  [FAIL] {name} - {e}")
            print(f"[WARN] 화이트리스트 실패: {url} ({e})")

    # 2. 일반 차단 필터 로드
    raw_block_set = set()
    filter_domains = {}
    names = []
    report_lines.append(f"\n[ Block Filter Sources ]")
    report_lines.append(f"{'-' * 60}")
    for url in FILTER_URLS:
        name = short_name(url)
        try:
            text = fetch(url)
            total_lines = len(text.splitlines())
            domains_this = extract_block_domains(text)
            raw_block_set.update(domains_this)
            filter_domains[name] = domains_this
            names.append(name)
            report_lines.append(f"  [OK] {name}")
            report_lines.append(f"       URL: {url}")
            report_lines.append(f"       Total Lines: {total_lines:,} | Extracted: {len(domains_this):,}")
        except Exception as e:
            report_lines.append(f"  [FAIL] {name} - {e}")
            print(f"[WARN] 필터 실패: {url} ({e})")

    # 2-1. 개인 블록리스트 로드 (외부 화이트리스트보다 우선)
    personal_block_set = set()
    report_lines.append(f"\n[ Personal Blocklist (Override Whitelist) ]")
    report_lines.append(f"{'-' * 60}")
    for url in PERSONAL_BLOCK_URLS:
        name = short_name(url)
        try:
            text = fetch(url)
            total_lines = len(text.splitlines())
            domains_this = extract_block_domains(text)
            personal_block_set.update(domains_this)
            report_lines.append(f"  [OK] {name}")
            report_lines.append(f"       URL: {url}")
            report_lines.append(f"       Total Lines: {total_lines:,} | Extracted: {len(domains_this):,}")
        except Exception as e:
            report_lines.append(f"  [FAIL] {name} - {e}")
            print(f"[WARN] 개인 블록리스트 실패: {url} ({e})")
    report_lines.append(f"  {'─' * 60}")
    report_lines.append(f"  Total Personal Block (deduplicated): {len(personal_block_set):,}")

    # 2-2. 개인 화이트리스트 로드 (최종 - 모든 블록리스트보다 우선)
    personal_white_set = set()
    report_lines.append(f"\n[ Personal Whitelist (Final Override) ]")
    report_lines.append(f"{'-' * 60}")
    for url in PERSONAL_WHITE_URLS:
        name = short_name(url)
        try:
            text = fetch(url)
            total_lines = len(text.splitlines())
            count = 0
            for line in text.splitlines():
                m = re.match(r"^\|\|([a-z0-9\-\.]+)\^(\$popup)?\s*$", line.strip().lower())
                if m and is_valid_domain(m.group(1)):
                    personal_white_set.add(m.group(1))
                    count += 1
            report_lines.append(f"  [OK] {name}")
            report_lines.append(f"       URL: {url}")
            report_lines.append(f"       Total Lines: {total_lines:,} | Extracted: {count:,}")
        except Exception as e:
            report_lines.append(f"  [FAIL] {name} - {e}")
            print(f"[WARN] 개인 화이트리스트 실패: {url} ({e})")
    report_lines.append(f"  {'─' * 60}")
    report_lines.append(f"  Total Personal White (deduplicated): {len(personal_white_set):,}")

    # 3. 중복 분석 (일반 필터만)
    report_lines.append(f"\n[ Overlap Analysis ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  {'Filter':<32} {'Extracted':>10} {'New':>10} {'Unique':>10}")
    report_lines.append(f"  {'─' * 32} {'─' * 10} {'─' * 10} {'─' * 10}")

    seen = set()
    for name in names:
        domains = filter_domains[name]
        extracted = len(domains)
        new = domains - seen
        new_count = len(new)
        seen.update(domains)
        unique = domains.copy()
        for other_name in names:
            if other_name != name:
                unique -= filter_domains[other_name]
        unique_count = len(unique)
        report_lines.append(f"  {name:<32} {extracted:>10,} {new_count:>10,} {unique_count:>10,}")

    report_lines.append(f"  {'─' * 32} {'─' * 10} {'─' * 10} {'─' * 10}")
    report_lines.append(f"  {'Total (deduplicated)':<32} {len(raw_block_set):>10,}")

    # 4. 기준 필터 검증
    before_ref = len(raw_block_set)
    raw_block_set = raw_block_set & reference_set
    after_ref = len(raw_block_set)
    ref_removed = before_ref - after_ref

    report_lines.append(f"\n[ Reference Filter Validation ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  Reference Domains             : {len(reference_set):,}")
    report_lines.append(f"  Before Validation             : {before_ref:,}")
    report_lines.append(f"  Removed (not in reference)    : {ref_removed:,}")
    report_lines.append(f"  After Validation              : {after_ref:,}")

    # 5. 외부 화이트리스트 제외
    removed_by_white = raw_block_set & white_set
    removed_white_count = len(removed_by_white)
    block_after_white = raw_block_set - white_set

    report_lines.append(f"\n[ External Whitelist Filtering ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  Removed by Whitelist          : {removed_white_count:,}")
    report_lines.append(f"  After Whitelist               : {len(block_after_white):,}")

    # 6. 개인 블록리스트 강제 적용 (외부 화이트리스트 무시)
    forced_to_black = personal_block_set & white_set  # 외부 화이트 → 블랙 전환
    block_after_personal = block_after_white | personal_block_set

    report_lines.append(f"\n[ Personal Blocklist Override ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  Personal Block Domains        : {len(personal_block_set):,}")
    report_lines.append(f"  Forced (White → Black)        : {len(forced_to_black):,}")
    report_lines.append(f"  After Personal Block          : {len(block_after_personal):,}")

    # 7. ★ 개인 화이트리스트 강제 적용 (최종 - 모든 블록 무시) ★
    forced_to_white = block_after_personal & personal_white_set  # 블랙 → 화이트 전환
    final_block_set = block_after_personal - personal_white_set
    # 최종 화이트리스트: 외부 화이트 + 개인 화이트 (단, 개인 블록과 충돌하는 외부 화이트는 제외)
    final_white_set = (white_set - personal_block_set) | personal_white_set

    report_lines.append(f"\n[ Personal Whitelist Final Override ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  Personal White Domains        : {len(personal_white_set):,}")
    report_lines.append(f"  Forced (Black → White)        : {len(forced_to_white):,}")
    report_lines.append(f"  After Personal White          : {len(final_block_set):,}")

    final_blocks = sorted(final_block_set)
    final_whites = sorted(final_white_set)
    final_block_count = len(final_blocks)
    final_white_count = len(final_whites)

    report_lines.append(f"\n[ Final Summary ]")
    report_lines.append(f"{'-' * 60}")
    report_lines.append(f"  Priority: Filter < ExtWhite < PersonalBlock < PersonalWhite")
    report_lines.append(f"  {'─' * 60}")
    report_lines.append(f"  1. Raw Domains Collected      : {before_ref:,}")
    report_lines.append(f"  2. Removed by Reference       : {ref_removed:,}")
    report_lines.append(f"  3. Removed by Ext.Whitelist   : {removed_white_count:,}")
    report_lines.append(f"  4. Personal Block Added       : {len(personal_block_set):,}")
    report_lines.append(f"  5. Forced (White → Black)     : {len(forced_to_black):,}")
    report_lines.append(f"  6. Forced (Black → White)     : {len(forced_to_white):,}")
    report_lines.append(f"  7. Final Block Rules          : {final_block_count:,}")
    report_lines.append(f"  8. Final Exception Rules      : {final_white_count:,}")
    report_lines.append(f"{'=' * 60}")

    # 8. 출력
    OUTPUT_DIR.mkdir(exist_ok=True)

    header = (
        f"! Title: Personal Block/Allow List (DNS)\n"
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources\n"
        f"! Generated: {ts}\n"
        f"! Expires: 12 hours (update frequency)\n"
        f"! Homepage: https://github.com/moamoa7/Block\n"
        f"!\n"
        f"! [Priority]\n"
        f"! Filter < External Whitelist < Personal Blocklist < Personal Whitelist (final)\n"
        f"!\n"
        f"! [Statistics]\n"
        f"! 1. Raw Domains Collected      : {before_ref:,}\n"
        f"! 2. Removed by Reference       : {ref_removed:,}\n"
        f"! 3. Removed by Ext.Whitelist   : {removed_white_count:,}\n"
        f"! 4. Personal Block Added       : {len(personal_block_set):,}\n"
        f"! 5. Forced (White → Black)     : {len(forced_to_black):,}\n"
        f"! 6. Forced (Black → White)     : {len(forced_to_white):,}\n"
        f"! 7. Final Block Rules (||)     : {final_block_count:,}\n"
        f"! 8. Final Exception Rules (@@) : {final_white_count:,}\n"
        f"!\n"
    )

    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("! === BLOCK RULES ===\n")
        f.writelines(f"||{d}^\n" for d in final_blocks)
        f.write("\n! === EXCEPTION RULES ===\n")
        f.writelines(f"@@||{d}^\n" for d in final_whites)

    with open(OUT_DOMAINS, "w", encoding="utf-8") as f:
        f.write(header.replace("!", "#"))
        f.writelines(f"{d}\n" for d in final_blocks)

    with open(OUT_HOSTS, "w", encoding="utf-8") as f:
        f.write(header.replace("!", "#"))
        f.writelines(f"0.0.0.0 {d}\n" for d in final_blocks)

    report_text = "\n".join(report_lines) + "\n"
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write(report_text)

    print(report_text)
    print(f"결과가 {OUTPUT_DIR} 폴더에 생성되었습니다.")

if __name__ == "__main__":
    main()
