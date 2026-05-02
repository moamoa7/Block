#!/usr/bin/env python3
"""AdGuard DNS 통합 필터 추출 스크립트 (차단+예외 통합본)."""

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
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "blocklist_combined.txt" # 통합 필터

WHITELIST_CORE = {"localhost", "localhost.localdomain", "broadcasthost", "local"}
META_FIELDS = ["Title", "Description", "Version", "Last modified", "TimeUpdated"]

# ---------- 함수 ----------
def fetch_data(url: str) -> str:
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"    [!] 로드 실패: {url} ({e})")
        return ""

def extract_dns_domains(text: str) -> set[str]:
    domains = set()
    for line in text.splitlines():
        line = line.strip()
        # 기본 DNS 차단 규칙 ||domain^ 매칭
        m = re.match(r"^\|\|([a-zA-Z0-9\-\.]+)\^(\$popup)?\s*$", line)
        if m:
            d = m.group(1).lower()
            # 유효성 검사 (is_valid_domain 로직 통합)
            if len(d) >= 3 and d not in WHITELIST_CORE and not re.match(r"^\d", d) and "*" not in d:
                if re.match(r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$", d):
                    domains.add(d)
    return domains

def fetch_exclusions(urls: list[str]) -> set[str]:
    excluded = set()
    for url in urls:
        print(f"[*] Fetching exclusion: {url}")
        text = fetch_data(url)
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(("!", "#", "[")): continue
            # @@||domain^ 또는 일반 도메인 추출
            m = re.match(r"^(?:@@)?\|?\|?([a-zA-Z0-9\-\.]+)\^?.*$", line)
            if m: excluded.add(m.group(1).lower())
    return excluded

def generate_output(block_domains: set[str], white_domains: set[str]):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    
    # 순수 차단 목록 (화이트리스트를 아예 제거한 것) - Domains, Hosts용
    final_block_only = sorted(block_domains - white_domains)
    # 화이트리스트 도메인 중 차단 목록에 존재했던 것들만 선별 (통합 AdGuard용)
    active_whitelist = sorted(block_domains.intersection(white_domains))

    header = f"! Title: Combined DNS Filter\n! Generated: {ts}\n! Total Block: {len(final_block_only):,}\n! Total Exception: {len(active_whitelist):,}\n!\n"

    # 1. 통합 AdGuard DNS (차단 규칙 + 예외 규칙)
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header)
        f.write("! --- 차단 규칙 ---\n")
        f.writelines(f"||{d}^\n" for d in final_block_only)
        if active_whitelist:
            f.write("\n! --- 예외(화이트리스트) 규칙 ---\n")
            f.writelines(f"@@||{d}^\n" for d in active_whitelist)

    # 2. Hosts 및 Domains (이 형식들은 @@를 지원 안 하므로 차단 목록만 저장)
    header_hosts = header.replace("! ", "# ").replace("!\n", "#\n")
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts)
        f.writelines(d + "\n" for d in final_block_only)
    
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts)
        f.writelines(f"0.0.0.0 {d}\n" for d in final_block_only)

    print(f"\n[✓] 통합 완료")
    print(f"    → {OUTPUT_ADGUARD_DNS.name} (차단+예외 통합본)")
    print(f"    → {OUTPUT_HOSTS.name} (순수 차단용)")

def main():
    all_raw_domains = set()
    
    print("=" * 50 + "\n 화이트리스트 데이터 수집\n" + "=" * 50)
    dns_exclusions = fetch_exclusions(EXCLUSION_URLS)
    print(f"[*] 총 {len(dns_exclusions):,}개의 제외 규칙 로드됨\n")

    print("=" * 50 + "\n 필터 데이터 수집\n" + "=" * 50)
    for url in FILTER_URLS:
        print(f"[*] Fetching: {url}")
        text = fetch_data(url)
        domains = extract_dns_domains(text)
        all_raw_domains.update(domains)
        print(f"    → 추출된 도메인: {len(domains):,}")

    generate_output(all_raw_domains, dns_exclusions)

if __name__ == "__main__":
    main()
