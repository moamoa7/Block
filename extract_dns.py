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

def main():
    # 1. 화이트리스트 로드
    white_set = set()
    for url in EXCLUSION_URLS:
        try:
            text = fetch(url)
            for line in text.splitlines():
                m = re.match(r"^(?:@@)?\|?\|?([a-z0-9\-\.]+)\^?.*$", line.strip().lower())
                if m and is_valid_domain(m.group(1)):
                    white_set.add(m.group(1))
        except Exception as e:
            print(f"[WARN] 화이트리스트 실패: {url} ({e})")

    # 2. 차단 대상 로드
    raw_block_set = set()
    for url in FILTER_URLS:
        try:
            text = fetch(url)
            for line in text.splitlines():
                m = re.match(
                    r"^\|\|([a-z0-9\-\.]+)\^(\$(popup|third-party))?\s*$",
                    line.strip().lower()
                )
                if m and is_valid_domain(m.group(1)):
                    raw_block_set.add(m.group(1))
        except Exception as e:
            print(f"[WARN] 필터 실패: {url} ({e})")

    # 3. 통계 계산
    removed_list = raw_block_set & white_set
    removed_count = len(removed_list)
    total_raw = len(raw_block_set)
    final_blocks = sorted(raw_block_set - white_set)
    final_block_count = len(final_blocks)
    final_whites = sorted(white_set)
    final_white_count = len(final_whites)

    # 4. 출력
    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    header = (
        f"! Title: Personal DNS Filter\n"
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources\n"
        f"! Generated: {ts}\n"
        f"! Expires: 12 hours (update frequency)\n"
        f"! Homepage: https://github.com/moamoa7/Block\n"
        f"!\n"
        f"! [Statistics]\n"
        f"! 1. Raw Domains Collected      : {total_raw:,}\n"
        f"! 2. Removed by Whitelist       : {removed_count:,}\n"
        f"! 3. Final Block Rules (||)     : {final_block_count:,}\n"
        f"! 4. Final Exception Rules (@@) : {final_white_count:,}\n"
        f"! (Calculation: 1 - 2 = 3)\n"
        f"!\n"
    )

    # (1) AdGuard DNS 형식
    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("! === BLOCK RULES ===\n")
        f.writelines(f"||{d}^\n" for d in final_blocks)
        f.write("\n! === EXCEPTION RULES ===\n")
        f.writelines(f"@@||{d}^\n" for d in final_whites)

    # (2) 순수 도메인
    with open(OUT_DOMAINS, "w", encoding="utf-8") as f:
        f.write(header.replace("!", "#"))
        f.writelines(f"{d}\n" for d in final_blocks)

    # (3) 호스트 파일
    with open(OUT_HOSTS, "w", encoding="utf-8") as f:
        f.write(header.replace("!", "#"))
        f.writelines(f"0.0.0.0 {d}\n" for d in final_blocks)

    print("-" * 40)
    print(f"1. 수집된 도메인      : {total_raw:,}")
    print(f"2. 화이트리스트 제거  : {removed_count:,}")
    print(f"3. 최종 차단 도메인   : {final_block_count:,}")
    print(f"4. 예외 규칙 수       : {final_white_count:,}")
    print("-" * 40)
    print(f"결과가 {OUTPUT_DIR} 폴더에 생성되었습니다.")

if __name__ == "__main__":
    main()
