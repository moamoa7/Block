#!/usr/bin/env python3
import re, requests
from pathlib import Path
from datetime import datetime, timezone

# --- 설정 (이전과 동일) ---
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
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "Block_DNS.txt"

# --- 유효성 검사 함수 ---
def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3: return False
    return bool(re.match(r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$", d))

# --- 메인 로직 ---
def main():
    # 1. 화이트리스트 로드 (@@ 규칙들)
    white_set = set()
    for url in EXCLUSION_URLS:
        try:
            r = requests.get(url, timeout=30)
            for line in r.text.splitlines():
                m = re.match(r"^(?:@@)?\|?\|?([a-z0-9\-\.]+)\^?.*$", line.strip().lower())
                if m and is_valid_domain(m.group(1)):
                    white_set.add(m.group(1))
        except: pass

    # 2. 필터 소스 로드 (|| 규칙들)
    raw_block_set = set()
    for url in FILTER_URLS:
        try:
            r = requests.get(url, timeout=30)
            for line in r.text.splitlines():
                m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", line.strip().lower())
                if m and is_valid_domain(m.group(1)):
                    raw_block_set.add(m.group(1))
        except: pass

    # 3. 정확한 통계 계산
    # [A] 수집된 모든 고유 차단 도메인
    total_raw = len(raw_block_set) 
    # [B] 차단 목록에 있었는데 화이트리스트에도 있어서 제거될 도메인
    removed_list = raw_block_set.intersection(white_set)
    removed_count = len(removed_list)
    # [C] 최종적으로 || 규칙으로 들어갈 도메인 (A - B)
    final_blocks = sorted(raw_block_set - white_set)
    final_block_count = len(final_blocks)
    # [D] 최종적으로 @@ 규칙으로 들어갈 도메인 (화이트리스트 전체)
    final_whites = sorted(white_set)
    final_white_count = len(final_whites)

    # 4. 출력
    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(f"! Title: Combined DNS Filter\n")
        f.write(f"! Generated: {ts}\n")
        f.write(f"! [Detailed Statistics]\n")
        f.write(f"! 1. Raw Domains Collected      : {total_raw:,}\n")
        f.write(f"! 2. Removed by Whitelist       : {removed_count:,}\n")
        f.write(f"! 3. Final Block Rules (||)     : {final_block_count:,}\n")
        f.write(f"! 4. Final Exception Rules (@@) : {final_white_count:,}\n")
        f.write(f"!\n! (Calculation: 1 - 2 = 3)\n!\n")
        
        f.write("! === BLOCK RULES ===\n")
        f.writelines(f"||{d}^\n" for d in final_blocks)
        f.write("\n! === EXCEPTION RULES ===\n")
        f.writelines(f"@@||{d}^\n" for d in final_whites)

    print(f"통계: 수집({total_raw}) - 제거({removed_count}) = 최종차단({final_block_count})")

if __name__ == "__main__":
    main()
