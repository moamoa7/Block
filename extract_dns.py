#!/usr/bin/env python3
"""AdGuard/uBlock 필터 리스트에서 DNS 차단용 도메인만 추출하는 스크립트."""

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
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt"
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]

OUTPUT_DIR = Path("output")
OUTPUT_HOSTS = OUTPUT_DIR / "dns_blocklist_hosts.txt"
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "dns_blocklist_adguard.txt"
OUTPUT_DOMAINS = OUTPUT_DIR / "dns_blocklist_domains.txt"

WHITELIST = {"localhost", "localhost.localdomain", "broadcasthost", "local"}
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
                m = re.match(r"^@@?\|?\|?([a-zA-Z0-9\-\.]+)\^?\|?$", line)
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
    if not d or len(d) < 3 or d in WHITELIST:
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
        # ||domain^ 또는 ||domain^$popup 매칭
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
                    exclusion_count: int) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sorted_domains = sorted(domains)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    header_lines = [
        f"! Title: Small DNS Blocklist",
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources",
        f"! Generated: {ts}",
        f"! Total domains: {len(sorted_domains):,}",
        f"! Expires: 12 hours (update frequency)",
        f"! Homepage: https://github.com/moamoa7/Block",
        "!",
        "! ═══════════════════════════════════════════════════════",
        "!  Source Details",
        "! ═══════════════════════════════════════════════════════",
    ]

    for i, src in enumerate(source_results, 1):
        meta = src["metadata"]
        header_lines.append("!")
        header_lines.append(f"! ── Source {i}: {meta.get('Title', 'Unknown')} ──")
        header_lines.append(f"!   URL: {src['url']}")
        header_lines.append(f"!   Status: {src['status']}")
        if src["status"] == "OK":
            if "Description" in meta:
                header_lines.append(f"!   Description: {meta['Description']}")
            if "Version" in meta:
                header_lines.append(f"!   Version: {meta['Version']}")
            lm = meta.get("Last modified") or meta.get("TimeUpdated")
            if lm:
                header_lines.append(f"!   Last modified: {lm}")
            if "Expires" in meta:
                header_lines.append(f"!   Expires: {meta['Expires']}")
            if "Homepage" in meta:
                header_lines.append(f"!   Homepage: {meta['Homepage']}")
            lic = meta.get("License") or meta.get("Licence")
            if lic:
                header_lines.append(f"!   License: {lic}")
            tr = src["total_rules"]
            dc = src["dns_count"]
            ratio = (dc / tr * 100) if tr > 0 else 0
            header_lines.append(f"!   Total rules: {tr:,}")
            header_lines.append(f"!   DNS extracted: {dc:,} ({ratio:.1f}%)")
            header_lines.append(
                f"!   New domains: {src['new_count']:,} | "
                f"Duplicates removed: {src['dup_count']:,}")
        else:
            header_lines.append(f"!   Error: {src['error']}")

    header_lines.extend([
        "!",
        "! ═══════════════════════════════════════════════════════",
        "!  Exclusions (Whitelist)",
        "! ═══════════════════════════════════════════════════════",
        "!   1. AdGuard DNS filter official exclusions + exceptions",
        "!      https://github.com/AdguardTeam/AdGuardSDNSFilter/tree/master/Filters",
        "!   2. anudeepND community whitelist",
        "!      https://github.com/anudeepND/whitelist",
        f"!   Total excluded domains: {exclusion_count:,}",
        "!",
        "! ═══════════════════════════════════════════════════════",
    ])

    header_str = "\n".join(header_lines) + "\n"
    header_hosts = header_str.replace("! ", "# ").replace("!\n", "#\n")

    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts)
        f.writelines(d + "\n" for d in sorted_domains)

    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts)
        f.writelines(f"0.0.0.0 {d}\n" for d in sorted_domains)

    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header_str)
        f.writelines(f"||{d}^\n" for d in sorted_domains)

    print(f"\n[✓] 총 {len(sorted_domains):,}개 도메인 추출 완료")
    print(f"    → {OUTPUT_DOMAINS}")
    print(f"    → {OUTPUT_HOSTS}")
    print(f"    → {OUTPUT_ADGUARD_DNS}")

def main():
    all_domains: set[str] = set()
    source_results: list[dict] = []

    print("=" * 50)
    print(" 화이트리스트 로드")
    print("=" * 50)
    dns_exclusions = fetch_exclusions(EXCLUSION_URLS)
    print(f"\n[*] 총 {len(dns_exclusions):,}개 제외 도메인 로드 완료\n")

    print("=" * 50)
    print(" 필터 리스트 처리")
    print("=" * 50)
    for url in FILTER_URLS:
        try:
            text = fetch_filter(url)
            metadata = parse_metadata(text)
            total_rules = count_total_lines(text)
            domains = extract_dns_domains(text)
            dns_count = len(domains)

            domains -= dns_exclusions

            new_domains = domains - all_domains
            new_count = len(new_domains)
            dup_count = len(domains) - new_count

            all_domains.update(domains)

            source_results.append({
                "url": url,
                "metadata": metadata,
                "status": "OK",
                "total_rules": total_rules,
                "dns_count": dns_count,
                "new_count": new_count,
                "dup_count": dup_count,
                "error": None,
            })

            title = metadata.get("Title", "Unknown")
            ver = metadata.get("Version", "?")
            lm = metadata.get("Last modified") or metadata.get("TimeUpdated", "?")
            print(f"    📋 {title} (v{ver}, {lm})")
            print(f"    → Total {total_rules:,} rules → DNS {dns_count:,}"
                  f" → Excluded {dns_count - len(domains):,}"
                  f" → New {new_count:,} | Dup {dup_count:,}")

        except Exception as e:
            source_results.append({
                "url": url,
                "metadata": {"Title": "Unknown"},
                "status": "FAILED",
                "total_rules": 0,
                "dns_count": 0,
                "new_count": 0,
                "dup_count": 0,
                "error": str(e),
            })
            print(f"    [!] FAILED: {e}")

    print(f"\n[*] 중복 제거 후 총 도메인 수: {len(all_domains):,}")
    generate_output(all_domains, source_results, len(dns_exclusions))

if __name__ == "__main__":
    main()
