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
    "https://filters.adtidy.org/windows/filters/7.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
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

# ─── 메타데이터 파싱에 사용할 필드들 ─────────────────────────────
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
    for line in text.splitlines()[:30]:  # 상단 30줄만 확인
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


def generate_output(domains: set[str], all_metadata: list[dict[str, str]]) -> None:
    """다양한 형식으로 출력 파일을 생성합니다."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sorted_domains = sorted(domains)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # ─── 헤더 생성 (소스별 메타데이터 포함) ───────────────────────
    header_lines = [
        f"! Title: DNS Blocklist - Auto-generated",
        f"! Description: Extracted DNS-level blocking domains from multiple filter sources",
        f"! Generated: {timestamp}",
        f"! Total domains: {len(sorted_domains)}",
        f"! Expires: 12 hours (update frequency)",
        f"! Homepage: https://github.com/moamoa7/Block",
        f"!",
    ]

    for i, meta in enumerate(all_metadata, 1):
        title = meta.get("Title", "Unknown")
        header_lines.append(f"! ── Source {i}: {title} ──")

        if "Description" in meta:
            header_lines.append(f"!   Description: {meta['Description']}")
        if "Version" in meta:
            header_lines.append(f"!   Version: {meta['Version']}")

        # Last modified / TimeUpdated 통합
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

        header_lines.append(f"!")

    header = "\n".join(header_lines) + "\n"

    # hosts 형식은 #을 주석으로 사용
    header_hosts = header.replace("! ", "# ").replace("!\n", "#\n")

    # 1. 순수 도메인 리스트
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header_hosts)
        for domain in sorted_domains:
            f.write(f"{domain}\n")

    # 2. hosts 파일 형식 (Pi-hole 등)
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header_hosts)
        for domain in sorted_domains:
            f.write(f"0.0.0.0 {domain}\n")

    # 3. AdGuard Home DNS 필터 형식 (! 주석 그대로 사용)
    with open(OUTPUT_ADGUARD_DNS, "w") as f:
        f.write(header)
        for domain in sorted_domains:
            f.write(f"||{domain}^\n")

    print(f"\n[✓] 총 {len(sorted_domains)}개 도메인 추출 완료")
    print(f"    → {OUTPUT_DOMAINS}")
    print(f"    → {OUTPUT_HOSTS}")
    print(f"    → {OUTPUT_ADGUARD_DNS}")


def main():
    all_domains: set[str] = set()
    all_metadata: list[dict[str, str]] = []

    for url in FILTER_URLS:
        try:
            text = fetch_filter(url)
            metadata = parse_metadata(text)
            all_metadata.append(metadata)

            title = metadata.get("Title", "Unknown")
            version = metadata.get("Version", "?")
            last_mod = metadata.get("Last modified") or metadata.get("TimeUpdated", "?")
            print(f"    📋 {title} (v{version}, {last_mod})")

            domains = extract_dns_domains(text)
            print(f"    → {len(domains)}개 도메인 추출됨")
            all_domains.update(domains)
        except Exception as e:
            print(f"    [!] 에러: {e}")
            all_metadata.append({"Title": f"Error: {url}"})

    print(f"\n[*] 중복 제거 후 총 도메인 수: {len(all_domains)}")
    generate_output(all_domains, all_metadata)


if __name__ == "__main__":
    main()
