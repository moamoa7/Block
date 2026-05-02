#!/usr/bin/env python3
import re, requests
from pathlib import Path
from datetime import datetime, timezone

# --- 설정 ---
FILTER_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",
    "https://filters.adtidy.org/windows/filters/2.txt",
    "https://filters.adtidy.org/windows/filters/11.txt",
    "https://filters.adtidy.org/windows/filters/7.txt",
    "https://filters.adtidy.org/windows/filters/224.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
]
EXCLUSION_URLS = [
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]

OUTPUT_DIR = Path("output")
OUT_COMBINED = OUTPUT_DIR / "Block_DNS.txt"
OUT_DOMAINS = OUTPUT_DIR / "Block_Domains.txt"
OUT_HOSTS = OUTPUT_DIR / "Block_Hosts.txt"

def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3:
        return False
    return bool(re.match(
        r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$", d
    ))

def main():
    # 1. 화이트리스트 로드
    white_set = set()
    for url in EXCLUSION_URLS:
        try:
            r = requests.get(url, timeout=30)
            for line in r.text.splitlines():
                m = re.search(r"(?:@@)?\|?\|?([a-z0-9\-\.]+)\^?", line.strip().lower())
                if m:
                    domain = m.group(1)
                    if is_valid_domain(domain):
                        white_set.add(domain)
        except:
            pass

    # 2. 차단 대상 로드
    raw_block_set = set()
    for url in FILTER_URLS:
        try:
            r = requests.get(url, timeout=30)
            for line in r.text.splitlines():
                m = re.match(
                    r"^\|\|([a-z0-9\-\.]+)\^(\$(popup|third-party))?\s*$",
                    line.strip().lower()
                )
                if m:
                    domain = m.group(1)
                    if is_valid_domain(domain):
                        raw_block_set.add(domain)
        except:
            pass

    # 3. 통계 및 필터링
    actually_removed = raw_block_set & white_set
    final_blocks = sorted(raw_block_set - white_set)
    final_whites = sorted(white_set)

    # 4. 출력
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    stats_header = (
        f"! Title: Advanced DNS Filter\n"
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources\n"
        f"! Generated: {ts}\n"
        f"! Expires: 12 hours (update frequency)\n"
        f"! Homepage: https://github.com/moamoa7/Block\n"
        f"!\n"
        f"! [Statistics]\n"
        f"! - Raw Collected   : {len(raw_block_set):,}\n"
        f"! - Removed (Match) : {len(actually_removed):,}\n"
        f"! - Final Block     : {len(final_blocks):,}\n"
        f"! - Total Exception : {len(final_whites):,}\n"
        f"!\n"
    )

    # (1) AdGuard DNS 형식
    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        f.write(stats_header)
        f.write("! === BLOCK RULES ===\n")
        for d in final_blocks:
            f.write(f"||{d}^\n")
        f.write("\n! === EXCEPTION RULES ===\n")
        for d in final_whites:
            f.write(f"@@||{d}^\n")

    # (2) 순수 도메인
    with open(OUT_DOMAINS, "w", encoding="utf-8") as f:
        f.write(stats_header.replace("!", "#"))
        for d in final_blocks:
            f.write(f"{d}\n")

    # (3) 호스트 파일
    with open(OUT_HOSTS, "w", encoding="utf-8") as f:
        f.write(stats_header.replace("!", "#"))
        for d in final_blocks:
            f.write(f"0.0.0.0 {d}\n")

    print("-" * 40)
    print(f"1. 수집된 도메인: {len(raw_block_set):,}")
    print(f"2. 화이트리스트와 겹쳐서 제거됨: {len(actually_removed):,}")
    print(f"3. 최종 차단 도메인 (1-2): {len(final_blocks):,}")
    print(f"4. 전체 예외 규칙 수: {len(final_whites):,}")
    print("-" * 40)
    print(f"결과가 {OUTPUT_DIR} 폴더에 생성되었습니다.")

if __name__ == "__main__":
    main()
