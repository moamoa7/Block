#!/usr/bin/env python3
import re, requests
from pathlib import Path
from datetime import datetime, timezone

# ---------- 설정 ----------
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
OUTPUT_DOMAINS = OUTPUT_DIR / "blocklist_domains.txt"
OUTPUT_HOSTS = OUTPUT_DIR / "blocklist_hosts.txt"
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "blocklist_combined.txt"

WHITELIST_CORE = {"localhost", "localhost.localdomain", "broadcasthost", "local"}

# ---------- 함수 ----------
def fetch_data(url: str) -> str:
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        return r.text
    except Exception:
        return ""

def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3 or d in WHITELIST_CORE: return False
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", d): return False 
    if "*" in d: return False
    return bool(re.match(r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$", d))

def extract_dns_domains(text: str) -> set[str]:
    domains = set()
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^\|\|([a-zA-Z0-9\-\.]+)\^(\$popup)?\s*$", line)
        if m:
            d = m.group(1).lower()
            if is_valid_domain(d): domains.add(d)
    return domains

def fetch_exclusions(urls: list[str]) -> set[str]:
    excluded = set()
    for url in urls:
        text = fetch_data(url)
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(("!", "#", "[")): continue
            m = re.match(r"^(?:@@)?\|?\|?([a-zA-Z0-9\-\.]+)\^?.*$", line)
            if m:
                d = m.group(1).lower()
                if is_valid_domain(d): excluded.add(d)
    return excluded

def generate_output(all_raw_blocks: set[str], dns_exclusions: set[str]):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    
    # [계산 로직]
    # 1. 원본 차단 도메인 중 화이트리스트와 겹치는 도메인들
    removed_by_whitelist = all_raw_blocks.intersection(dns_exclusions)
    # 2. 실제로 차단될 도메인 (원본 - 화이트리스트)
    final_blocks = sorted(all_raw_blocks - dns_exclusions)
    # 3. 통합 필터에 넣을 예외 규칙 (실제 의미 있는 예외들만)
    final_whites = sorted(dns_exclusions)

    header_content = [
        f"! Title: Combined DNS Blocklist",
        f"! Generated: {ts}",
        f"! --------------------------------------------------",
        f"! [Statistics]",
        f"! Raw Domains Collected: {len(all_raw_blocks):,}",
        f"! Domains Removed by Whitelist: {len(removed_by_whitelist):,}",
        f"! Final Block Rules: {len(final_blocks):,}",
        f"! Final Exception Rules (@@): {len(final_whites):,}",
        f"! --------------------------------------------------",
        "!",
    ]
    header_str = "\n".join(header_content) + "\n"
    header_hosts = header_str.replace("! ", "# ").replace("!\n", "#\n")

    # 1. AdGuard 통합형
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header_str)
        f.write("! === BLOCK RULES ===\n")
        f.writelines(f"||{d}^\n" for d in final_blocks)
        f.write("\n! === EXCEPTION RULES ===\n")
        f.writelines(f"@@||{d}^\n" for d in final_whites)

    # 2. Domains/Hosts
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts)
        f.writelines(d + "\n" for d in final_blocks)
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts)
        f.writelines(f"0.0.0.0 {d}\n" for d in final_blocks)

    print(f"\n[✓] 작업 완료 (최종 차단: {len(final_blocks):,}개)")

def main():
    print("[*] 제외 목록(화이트리스트) 로딩 중...")
    dns_exclusions = fetch_exclusions(EXCLUSION_URLS)
    
    print("[*] 필터 소스 수집 중...")
    all_raw_blocks = set()
    for url in FILTER_URLS:
        text = fetch_data(url)
        all_raw_blocks.update(extract_dns_domains(text))

    generate_output(all_raw_blocks, dns_exclusions)

if __name__ == "__main__":
    main()
