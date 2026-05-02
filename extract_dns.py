#!/usr/bin/env python3
"""AdGuard/uBlock 필터 리스트에서 DNS 차단용 및 제외용 도메인 추출 스크립트."""

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

# 차단 리스트 (Blocklist) 경로
OUTPUT_DOMAINS = OUTPUT_DIR / "blocklist_domains.txt"
OUTPUT_HOSTS = OUTPUT_DIR / "blocklist_hosts.txt"
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "blocklist_adguard.txt"

# 화이트리스트 (Whitelist - 제외된 항목) 경로
WHITELIST_DOMAINS = OUTPUT_DIR / "whitelist_domains.txt"
WHITELIST_HOSTS = OUTPUT_DIR / "whitelist_hosts.txt"
WHITELIST_ADGUARD_DNS = OUTPUT_DIR / "whitelist_adguard.txt"

WHITELIST_CORE = {"localhost", "localhost.localdomain", "broadcasthost", "local"}
META_FIELDS = ["Title", "Description", "Version", "Last modified", "TimeUpdated",
               "Expires", "Homepage", "License", "Licence"]

# ---------- 함수 ----------
def fetch_filter(url: str) -> str:
    print(f"[*] Fetching: {url}")
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.text

def parse_metadata(text: str) -> dict:
    meta = {}
    for line in text.splitlines()[:30]:
        if not line.startswith("!"):
            continue
        content = line[1:].strip()
        for f in META_FIELDS:
            if content.lower().startswith(f.lower() + ":"):
                meta[f] = content[len(f) + 1:].strip()
                break
    return meta

def fetch_exclusions(urls: list[str]) -> set[str]:
    excluded = set()
    for url in urls:
        try:
            print(f"[*] Fetching exclusion: {url}")
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            before = len(excluded)
            for line in resp.text.splitlines():
                line = line.strip()
                if not line or line.startswith(("!", "#", "[")):
                    continue
                m = re.match(r"^(?:@@)?\|?\|?([a-zA-Z0-9\-\.]+)\^?.*$", line)
                if m:
                    excluded.add(m.group(1).lower())
                    continue
                m = re.match(r"^([a-zA-Z0-9][a-zA-Z0-9\-\.]*\.[a-zA-Z]{2,})$", line)
                if m:
                    excluded.add(m.group(1).lower())
            added = len(excluded) - before
            print(f"    → {added}개 도메인 추가 (누적: {len(excluded)}개)")
        except Exception as e:
            print(f"    [!] 제외 목록 로드 실패: {e}")
    return excluded

def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3 or d in WHITELIST_CORE:
        return False
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", d):
        return False
    if "*" in d:
        return False
    return bool(re.match(
        r"^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?"
        r"(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$", d))

def extract_dns_domains(text: str) -> set[str]:
    domains = set()
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^\|\|([a-zA-Z0-9\-\.]+)\^(\$popup)?\s*$", line)
        if not m:
            continue
        d = m.group(1).lower()
        if is_valid_domain(d):
            domains.add(d)
    return domains

def count_total_lines(text: str) -> int:
    count = 0
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith(("!", "[", "#")):
            count += 1
    return count

def generate_output(domains: set[str], source_results: list[dict], 
                    exclusion_count: int, whitelisted_domains: set[str]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sorted_domains = sorted(domains)
    sorted_whitelisted = sorted(whitelisted_domains)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # 1. 차단 리스트용 헤더 작성
    header_lines = [
        f"! Title: Blocklist",
        f"! Generated: {ts}",
        f"! Total domains: {len(sorted_domains):,}",
        "!",
        "! ═══════════════════════════════════════════════════════",
        "!  Source Details",
        "! ═══════════════════════════════════════════════════════",
    ]

    for i, src in enumerate(source_results, 1):
        meta = src["metadata"]
        header_lines.append(f"! Source {i}: {meta.get('Title', 'Unknown')}")
        if src["status"] == "OK":
            header_lines.append(f"!   Extracted: {src['dns_count']:,} | New: {src['new_count']:,}")

    header_str = "\n".join(header_lines) + "\n"
    header_hosts = header_str.replace("! ", "# ").replace("!\n", "#\n")

    # [차단 리스트 저장]
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts); f.writelines(d + "\n" for d in sorted_domains)
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts); f.writelines(f"0.0.0.0 {d}\n" for d in sorted_domains)
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header_str); f.writelines(f"||{d}^\n" for d in sorted_domains)

    # 2. 화이트리스트용 헤더 작성
    wl_header_lines = [
        f"! Title: Whitelist (Excluded Domains)",
        f"! Description: Domains from sources that were excluded by your whitelist",
        f"! Generated: {ts}",
        f"! Total domains: {len(sorted_whitelisted):,}",
        "!",
    ]
    wl_header_str = "\n".join(wl_header_lines) + "\n"
    wl_header_hosts = wl_header_str.replace("! ", "# ").replace("!\n", "#\n")

    # [화이트리스트 저장]
    with open(WHITELIST_DOMAINS, "w") as f:
        f.write(wl_header_hosts); f.writelines(d + "\n" for d in sorted_whitelisted)
    with open(WHITELIST_HOSTS, "w") as f:
        f.write(wl_header_hosts); f.writelines(f"0.0.0.0 {d}\n" for d in sorted_whitelisted)
    with open(WHITELIST_ADGUARD_DNS, "w") as f:
        f.write(wl_header_str)
        f.writelines(f"@@||{d}^\n" for d in sorted_whitelisted) # @@는 허용 규칙

    print(f"\n[✓] 처리 완료 (결과물: {OUTPUT_DIR})")
    print(f"    [Block] {OUTPUT_DOMAINS.name}, {OUTPUT_HOSTS.name}, {OUTPUT_ADGUARD_DNS.name}")
    print(f"    [White] {WHITELIST_DOMAINS.name}, {WHITELIST_HOSTS.name}, {WHITELIST_ADGUARD_DNS.name}")

def main():
    all_domains: set[str] = set()
    all_excluded: set[str] = set()
    source_results: list[dict] = []

    print("=" * 50 + "\n 화이트리스트 로드\n" + "=" * 50)
    dns_exclusions = fetch_exclusions(EXCLUSION_URLS)

    print("\n" + "=" * 50 + "\n 필터 리스트 처리\n" + "=" * 50)
    for url in FILTER_URLS:
        try:
            text = fetch_filter(url)
            metadata = parse_metadata(text)
            domains = extract_dns_domains(text)
            
            # 화이트리스트와 겹치는 도메인 추출 및 누적
            excluded_here = domains.intersection(dns_exclusions)
            all_excluded.update(excluded_here)

            # 차단 목록에서 화이트리스트 제거
            domains -= dns_exclusions

            new_domains = domains - all_domains
            source_results.append({
                "url": url, "metadata": metadata, "status": "OK",
                "dns_count": len(domains), "new_count": len(new_domains)
            })
            all_domains.update(domains)
            print(f"    📋 {metadata.get('Title', 'Unknown')[:30]}... (DNS: {len(domains):,})")

        except Exception as e:
            source_results.append({"url": url, "metadata": {"Title": "Error"}, "status": "FAILED"})
            print(f"    [!] FAILED: {url} ({e})")

    generate_output(all_domains, source_results, len(dns_exclusions), all_excluded)

if __name__ == "__main__":
    main()
