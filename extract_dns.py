#!/usr/bin/env python3
"""
AdGuard/uBlock 필터 리스트에서 DNS 차단용 도메인만 추출하는 스크립트.
GitHub Actions 등으로 자동화 가능.
"""

import re
import requests
from pathlib import Path
from datetime import datetime, timezone

# ─── 설정 ────────────────────────────────────────────────────────
FILTER_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",
    "https://filters.adtidy.org/windows/filters/2.txt",
    "https://filters.adtidy.org/windows/filters/11.txt",
    "https://filters.adtidy.org/windows/filters/7.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
]

# AdGuard DNS filter 공식 제외 목록
EXCLUSION_URLS = [
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exceptions.txt",
]

OUTPUT_DIR = Path("output")
OUTPUT_HOSTS = OUTPUT_DIR / "dns_blocklist_hosts.txt"
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "dns_blocklist_adguard.txt"
OUTPUT_DOMAINS = OUTPUT_DIR / "dns_blocklist_domains.txt"

WHITELIST = {
    "localhost",
    "localhost.localdomain",
    "broadcasthost",
    "local",
}

META_FIELDS = [
    "Title",
    "Description",
    "Version",
    "Last modified",
    "TimeUpdated",
    "Expires",
    "Homepage",
    "License",
    "Licence",
]


def fetch_filter(url: str) -> str:
    print(f"[*] Fetching: {url}")
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_metadata(text: str) -> dict[str, str]:
    """필터 텍스트 상단에서 메타데이터를 파싱합니다."""
    metadata = {}
    for line in text.splitlines()[:30]:
        line = line.strip()
        if not line.startswith("!"):
            continue
        content = line[1:].strip()
        for field in META_FIELDS:
            if content.lower().startswith(field.lower() + ":"):
                value = content[len(field) + 1:].strip()
                metadata[field] = value
                break
    return metadata


def fetch_exclusions(urls: list[str]) -> set[str]:
    """AdGuard DNS filter 공식 제외 목록에서 도메인을 추출합니다."""
    excluded = set()
    for url in urls:
        try:
            print(f"[*] Fetching exclusion: {url}")
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            for line in resp.text.splitlines():
                line = line.strip()
                if not line or line.startswith("!"):
                    continue
                # ||domain.com^ 형태 (exclusions.txt)
                match = re.match(r"^\|\|([a-zA-Z0-9\-\.]+)\^?\|?$", line)
                if match:
                    excluded.add(match.group(1).lower())
                    continue
                # @@||domain.com^| 형태 (exceptions.txt)
                match = re.match(r"^@@\|?\|?([a-zA-Z0-9\-\.]+)\^?\|?$", line)
                if match:
                    excluded.add(match.group(1).lower())
        except Exception as e:
            print(f"    [!] 제외 목록 로드 실패: {e}")
    print(f"    → 총 {len(excluded):,}개 제외 도메인 로드됨\n")
    return excluded


def is_valid_domain(domain: str) -> bool:
    if not domain or len(domain) < 3:
        return False
    if domain in WHITELIST:
        return False
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", domain):
        return False
    if "*" in domain:
        return False
    if not re.match(
        r"^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?"
        r"(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$",
        domain,
    ):
        return False
    return True


def extract_dns_domains(text: str) -> set[str]:
    domains = set()

    DNS_SAFE_OPTIONS = {
        "third-party", "3p",
        "all",
        "document", "doc",
        "popup",
        "important",
    }

    DNS_UNSAFE_OPTIONS = {
        "script", "stylesheet", "css", "image", "media",
        "xmlhttprequest", "xhr", "websocket",
        "font", "object", "subdocument", "frame",
        "ping", "other",
        "replace",
    }

    for line in text.splitlines():
        line = line.strip()

        if not line or line.startswith("!") or line.startswith("[") or line.startswith("#"):
            continue
        if line.startswith("@@"):
            continue
        if "##" in line or "#@#" in line or "#?#" in line:
            if not line.startswith("||"):
                continue

        match = re.match(r"^\|\|([a-zA-Z0-9\-\.\*]+)\^(\$(.+))?$", line)
        if not match:
            continue

        domain = match.group(1).lower()
        options_str = match.group(3)

        if domain.startswith("*."):
            domain = domain[2:]

        if not is_valid_domain(domain):
            continue

        if options_str:
            options = [o.strip().lower() for o in options_str.split(",")]

            skip = False
            has_domain_restriction = False
            has_unsafe_only = False

            for opt in options:
                if opt.startswith("~"):
                    continue
                if opt.startswith("domain="):
                    has_domain_restriction = True
                    continue
                if opt.startswith("redirect") or opt.startswith("rewrite"):
                    skip = True
                    break
                if opt.startswith("replace="):
                    skip = True
                    break
                if opt in DNS_UNSAFE_OPTIONS:
                    has_unsafe_only = True

            if skip:
                continue
            if has_domain_restriction:
                continue

            safe_found = any(
                opt in DNS_SAFE_OPTIONS
                for opt in options
                if not opt.startswith("~") and not opt.startswith("domain=")
            )

            if has_unsafe_only and not safe_found:
                continue

        domains.add(domain)

    return domains


def count_total_lines(text: str) -> int:
    """필터의 전체 유효 규칙 수를 카운트합니다 (주석/빈줄 제외)."""
    count = 0
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("!") and not line.startswith("["):
            count += 1
    return count


def generate_output(
    domains: set[str],
    source_results: list[dict],
    exclusion_count: int,
) -> None:
    """다양한 형식으로 출력 파일을 생성합니다."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sorted_domains = sorted(domains)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # ─── 헤더 생성 ────────────────────────────────────────────────
    header_lines = [
        f"! Title: Small DNS Blocklist",
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources",
        f"! Generated: {timestamp}",
        f"! Total domains: {len(sorted_domains):,}",
        f"! Expires: 12 hours (update frequency)",
        f"! Homepage: https://github.com/moamoa7/Block",
        f"!",
        f"! ═══════════════════════════════════════════════════════",
        f"!  Source Details",
        f"! ═══════════════════════════════════════════════════════",
    ]

    for i, src in enumerate(source_results, 1):
        meta = src["metadata"]
        title = meta.get("Title", "Unknown")
        status = src["status"]
        url = src["url"]

        header_lines.append(f"!")
        header_lines.append(f"! ── Source {i}: {title} ──")
        header_lines.append(f"!   URL: {url}")
        header_lines.append(f"!   Status: {status}")

        if status == "OK":
            if "Description" in meta:
                header_lines.append(f"!   Description: {meta['Description']}")
            if "Version" in meta:
                header_lines.append(f"!   Version: {meta['Version']}")

            last_mod = meta.get("Last modified") or meta.get("TimeUpdated")
            if last_mod:
                header_lines.append(f"!   Last modified: {last_mod}")

            if "Expires" in meta:
                header_lines.append(f"!   Expires: {meta['Expires']}")
            if "Homepage" in meta:
                header_lines.append(f"!   Homepage: {meta['Homepage']}")

            license_val = meta.get("License") or meta.get("Licence")
            if license_val:
                header_lines.append(f"!   License: {license_val}")

            dns_count = src["dns_count"]
            new_count = src["new_count"]
            dup_count = src["dup_count"]
            total_rules = src["total_rules"]
            ratio = (dns_count / total_rules * 100) if total_rules > 0 else 0

            header_lines.append(f"!   Total rules: {total_rules:,}")
            header_lines.append(f"!   DNS extracted: {dns_count:,} ({ratio:.1f}%)")
            header_lines.append(f"!   New domains: {new_count:,} | Duplicates removed: {dup_count:,}")
        else:
            header_lines.append(f"!   Error: {src['error']}")

    header_lines.append(f"!")
    header_lines.append(f"! ── Exclusions ──")
    header_lines.append(f"!   Source: AdGuard DNS filter official exclusions")
    header_lines.append(f"!   URL: https://github.com/AdguardTeam/AdGuardSDNSFilter/tree/master/Filters")
    header_lines.append(f"!   Excluded domains: {exclusion_count:,}")
    header_lines.append(f"!")
    header_lines.append(f"! ═══════════════════════════════════════════════════════")
    header_lines.append(f"!")

    header = "\n".join(header_lines) + "\n"
    header_hosts = header.replace("! ", "# ").replace("!\n", "#\n")

    # 1. 순수 도메인 리스트
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts)
        for domain in sorted_domains:
            f.write(f"{domain}\n")

    # 2. hosts 파일 형식
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts)
        for domain in sorted_domains:
            f.write(f"0.0.0.0 {domain}\n")

    # 3. AdGuard Home DNS 필터 형식
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header)
        for domain in sorted_domains:
            f.write(f"||{domain}^\n")

    print(f"\n[✓] 총 {len(sorted_domains):,}개 도메인 추출 완료")
    print(f"    → {OUTPUT_DOMAINS}")
    print(f"    → {OUTPUT_HOSTS}")
    print(f"    → {OUTPUT_ADGUARD_DNS}")


def main():
    all_domains: set[str] = set()
    source_results: list[dict] = []

    # 제외 목록 먼저 로드
    dns_exclusions = fetch_exclusions(EXCLUSION_URLS)

    for url in FILTER_URLS:
        try:
            text = fetch_filter(url)
            metadata = parse_metadata(text)
            total_rules = count_total_lines(text)
            domains = extract_dns_domains(text)

            # 제외 목록 적용
            domains -= dns_exclusions

            dns_count = len(domains)

            # 이전 소스들과 중복되지 않는 신규 도메인만 계산
            new_domains = domains - all_domains
            new_count = len(new_domains)
            dup_count = dns_count - new_count

            title = metadata.get("Title", "Unknown")
            version = metadata.get("Version", "-")
            last_mod = metadata.get("Last modified") or metadata.get("TimeUpdated", "-")
            ratio = (dns_count / total_rules * 100) if total_rules > 0 else 0

            print(f"    📋 {title}")
            print(f"       Version: {version} | Last modified: {last_mod}")
            print(f"       Total rules: {total_rules:,} → DNS extracted: {dns_count:,} ({ratio:.1f}%)")
            print(f"       New: {new_count:,} | Duplicates: {dup_count:,}")

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

        except Exception as e:
            print(f"    [!] FAILED: {e}")
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

    print(f"\n[*] 총 도메인 수: {len(all_domains):,}")
    generate_output(all_domains, source_results, len(dns_exclusions))


if __name__ == "__main__":
    main()
