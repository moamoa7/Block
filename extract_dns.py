#!/usr/bin/env python3
"""
DNS Block/Allow List Generator
- Fetches multiple filter sources and merges them
- Priority: General Filters < External Whitelist < Personal Blocklist < Personal Whitelist
- Validates against AdGuard DNS Filter (reference) when available
- Outputs: Block_DNS.txt, Block_Domains.txt, Block_Hosts.txt, Report.txt
"""

import re
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import urlopen, Request

# ==================== Configuration ====================

# General block filter sources
FILTER_URLS = [
    "https://easylist-downloads.adblockplus.org/easylist.txt",
    "https://filters.adtidy.org/windows/filters/2.txt",     # AdGuard Base
    "https://filters.adtidy.org/windows/filters/11.txt",    # AdGuard Mobile
    "https://filters.adtidy.org/windows/filters/7.txt",     # AdGuard Japanese
    "https://filters.adtidy.org/windows/filters/224.txt",   # AdGuard Chinese
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/multi.txt",
]

# External whitelist sources (curated - trusted only)
EXCLUSION_URLS = [
    "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/banks.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/sensitive.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/issues.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/android.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/firefox.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/windows.txt",
    "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/mac.txt",
    "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/whitelist-referral-native.txt",
    "https://raw.githubusercontent.com/Dogino/Discord-Phishing-URLs/main/official-domains.txt",
]

# Personal blocklist (overrides external whitelist + skips reference validation)
PERSONAL_BLOCK_URLS = [
#    "https://raw.githubusercontent.com/sjhgvr/oisd/refs/heads/main/oisd_small.txt",
    "https://raw.githubusercontent.com/moamoa7/adblock/main/block.txt",
]

# Personal whitelist (final override - beats everything)
PERSONAL_WHITE_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]

# Reference filter for validation (only domains in this set are kept from general filters)
REFERENCE_URL = "https://filters.adtidy.org/windows/filters/15.txt"

# Output paths
OUTPUT_DIR = Path("output")
OUT_COMBINED = OUTPUT_DIR / "Block_DNS.txt"
OUT_DOMAINS = OUTPUT_DIR / "Block_Domains.txt"
OUT_HOSTS = OUTPUT_DIR / "Block_Hosts.txt"
OUT_REPORT = OUTPUT_DIR / "Report.txt"


# ==================== Utility Functions ====================

def fetch(url: str, retries: int = 3, timeout: int = 30) -> str:
    """Fetch URL content with retry and exponential backoff."""
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s, 4s
    raise last_err


_DOMAIN_RE = re.compile(
    r"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$"
)

def is_valid_domain(d: str) -> bool:
    if not d or len(d) < 3 or len(d) > 253:
        return False
    return bool(_DOMAIN_RE.match(d))


def short_name(url: str) -> str:
    mapping = [
        ("easylist.txt", "EasyList"),
        ("filters/2.txt", "AdGuard Base"),
        ("filters/11.txt", "AdGuard Mobile"),
        ("filters/7.txt", "AdGuard Japanese"),
        ("filters/224.txt", "AdGuard Chinese"),
        ("filters/15.txt", "AdGuard DNS Filter"),
        ("list-kr", "List-KR"),
        ("uAssets", "uBlock Filters"),
        ("adblock/multi.txt", "HaGeZi DNS Blocklist"),
 #      ("oisd_small.txt", "oisd small"),
        ("main/block.txt", "Personal Blocklist"),
        ("main/white.txt", "Personal Whitelist"),
        ("AdGuardSDNSFilter", "AdGuard DNS Exclusions"),
        ("HttpsExclusions/master/exclusions/banks.txt", "AdGuard HTTPS - Banks"),
        ("HttpsExclusions/master/exclusions/sensitive.txt", "AdGuard HTTPS - Sensitive"),
        ("HttpsExclusions/master/exclusions/issues.txt", "AdGuard HTTPS - Issues"),
        ("HttpsExclusions/master/exclusions/android.txt", "AdGuard HTTPS - Android"),
        ("HttpsExclusions/master/exclusions/firefox.txt", "AdGuard HTTPS - Firefox"),
        ("HttpsExclusions/master/exclusions/windows.txt", "AdGuard HTTPS - Windows"),
        ("HttpsExclusions/master/exclusions/mac.txt", "AdGuard HTTPS - Mac"),
        ("whitelist-referral-native", "HaGeZi Referral Whitelist (Native)"),
        ("whitelist-referral", "HaGeZi Referral Whitelist"),
        ("Discord-Phishing-URLs", "Discord Official Domains"),
    ]
    for key, name in mapping:
        if key in url:
            return name
    return url.split("/")[-1]


def extract_block_domains(text: str) -> set:
    """Extract domains from AdGuard-style block rules: ||domain^ (with optional $popup/$document)."""
    out = set()
    pat = re.compile(r"^\|\|([a-z0-9\-\.]+)\^(\$(popup|document)(,(popup|document))?)?\s*$")
    for line in text.splitlines():
        s = line.strip().lower()
        if not s or s.startswith(("!", "#", "[")):
            continue
        m = pat.match(s)
        if m and is_valid_domain(m.group(1)):
            out.add(m.group(1))
    return out


def extract_whitelist_domains(text: str) -> set:
    """
    Robust whitelist parser. Handles:
      - AdGuard block rules:    ||domain^
      - AdGuard exception:      @@||domain^
      - Plain domains:          example.com
      - Hosts-style lines:      0.0.0.0 example.com  /  127.0.0.1 example.com
    """
    out = set()
    for line in text.splitlines():
        s = line.strip().lower()
        if not s or s.startswith(("!", "#", "[")):
            continue

        domain = None
        m = re.match(r"^@@\|\|([a-z0-9\-\.]+)\^", s)
        if m:
            domain = m.group(1)
        else:
            m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", s)
            if m:
                domain = m.group(1)
            else:
                # hosts-style or plain domain
                parts = s.split()
                cand = parts[-1] if parts else ""
                if is_valid_domain(cand):
                    domain = cand

        if domain and is_valid_domain(domain):
            out.add(domain)
    return out


# ==================== Main ====================

def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    report = []
    bar = "=" * 70

    report.append(bar)
    report.append("  Filter Extraction Report")
    report.append(f"  Generated: {ts}")
    report.append(bar)

    # --- 0. Reference Filter ---
    reference_set = set()
    report.append("\n[ Reference Filter ]")
    report.append("-" * 70)
    try:
        txt = fetch(REFERENCE_URL)
        total_lines = len(txt.splitlines())
        for line in txt.splitlines():
            m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", line.strip().lower())
            if m and is_valid_domain(m.group(1)):
                reference_set.add(m.group(1))
        report.append(f"  [OK]  {short_name(REFERENCE_URL)}")
        report.append(f"        URL     : {REFERENCE_URL}")
        report.append(f"        Lines   : {total_lines:,}   Domains: {len(reference_set):,}")
    except Exception as e:
        report.append(f"  [FAIL] Reference filter: {e}")
        print(f"[WARN] Reference filter failed: {e}")

    # --- 1. External Whitelist ---
    white_set = set()
    report.append("\n[ External Whitelist Sources ]")
    report.append("-" * 70)
    for url in EXCLUSION_URLS:
        name = short_name(url)
        try:
            txt = fetch(url)
            total = len(txt.splitlines())
            before = len(white_set)
            domains = extract_whitelist_domains(txt)
            white_set.update(domains)
            added = len(white_set) - before
            report.append(f"  [OK]  {name}")
            report.append(f"        URL       : {url}")
            report.append(f"        Lines     : {total:,}   Extracted: {len(domains):,}   New: {added:,}")
        except Exception as e:
            report.append(f"  [FAIL] {name} - {e}")

    report.append(f"\n  Total whitelist domains (deduplicated): {len(white_set):,}")

    # --- 2. General Block Filters ---
    raw_block_set = set()
    filter_domains = {}
    names = []
    report.append("\n[ Block Filter Sources ]")
    report.append("-" * 70)
    for url in FILTER_URLS:
        name = short_name(url)
        try:
            txt = fetch(url)
            total = len(txt.splitlines())
            domains = extract_block_domains(txt)
            before = len(raw_block_set)
            raw_block_set.update(domains)
            new_count = len(raw_block_set) - before
            filter_domains[name] = domains
            names.append(name)
            report.append(f"  [OK]  {name}")
            report.append(f"        URL       : {url}")
            report.append(f"        Lines     : {total:,}   Extracted: {len(domains):,}   New: {new_count:,}")
        except Exception as e:
            report.append(f"  [FAIL] {name} - {e}")

    # --- 3. Personal Blocklist ---
    personal_block_set = set()
    report.append("\n[ Personal Blocklist (Overrides External Whitelist, Skips Reference Validation) ]")
    report.append("-" * 70)
    for url in PERSONAL_BLOCK_URLS:
        name = short_name(url)
        try:
            txt = fetch(url)
            total = len(txt.splitlines())
            ds = extract_block_domains(txt)
            personal_block_set.update(ds)
            report.append(f"  [OK]  {name}")
            report.append(f"        URL       : {url}")
            report.append(f"        Lines     : {total:,}   Extracted: {len(ds):,}")
        except Exception as e:
            report.append(f"  [FAIL] {name} - {e}")
    report.append(f"\n  Total personal block (deduplicated): {len(personal_block_set):,}")

    # --- 4. Personal Whitelist ---
    personal_white_set = set()
    report.append("\n[ Personal Whitelist (Final Override) ]")
    report.append("-" * 70)
    for url in PERSONAL_WHITE_URLS:
        name = short_name(url)
        try:
            txt = fetch(url)
            total = len(txt.splitlines())
            ds = extract_whitelist_domains(txt)
            personal_white_set.update(ds)
            report.append(f"  [OK]  {name}")
            report.append(f"        URL       : {url}")
            report.append(f"        Lines     : {total:,}   Extracted: {len(ds):,}")
        except Exception as e:
            report.append(f"  [FAIL] {name} - {e}")
    report.append(f"\n  Total personal white (deduplicated): {len(personal_white_set):,}")

    # --- 5. Overlap Analysis ---
    report.append("\n[ Overlap Analysis (per filter) ]")
    report.append("-" * 70)
    report.append(f"  {'Filter':<32} {'Extracted':>10} {'New':>10} {'Unique':>10}")
    seen_cum = set()
    for name in names:
        ds = filter_domains.get(name, set())
        # 'New' = not seen by previous filters in iteration order
        new_in_order = ds - seen_cum
        # 'Unique' = domains found ONLY in this filter (not in any other filter)
        others = set()
        for n2, d2 in filter_domains.items():
            if n2 != name:
                others.update(d2)
        unique = ds - others
        report.append(f"  {name:<32} {len(ds):>10,} {len(new_in_order):>10,} {len(unique):>10,}")
        seen_cum.update(ds)

    # --- 6. Apply Priority Rules ---
    raw_collected = len(raw_block_set)

    # 6a. Reference filter validation (skip if reference unavailable)
    report.append("\n[ Reference Filter Validation ]")
    report.append("-" * 70)
    before_ref = len(raw_block_set)
    if reference_set:
        raw_block_set &= reference_set
        ref_removed = before_ref - len(raw_block_set)
        report.append(f"  Before              : {before_ref:,}")
        report.append(f"  Removed (not in ref): {ref_removed:,}")
        report.append(f"  After               : {len(raw_block_set):,}")
    else:
        ref_removed = 0
        report.append("  [SKIPPED] Reference filter unavailable - validation bypassed")
        report.append(f"  Domains kept as-is  : {before_ref:,}")

    # 6b. Remove external whitelist
    before_white = len(raw_block_set)
    raw_block_set -= white_set
    white_removed = before_white - len(raw_block_set)

    # 6c. Force-add personal blocklist (overrides external whitelist, skips reference validation)
    forced_black = personal_block_set & white_set  # domains forced from white -> black
    raw_block_set |= personal_block_set

    # 6d. Apply personal whitelist (TRUE final override - beats personal block too)
    forced_white = personal_white_set & raw_block_set  # domains forced from black -> white
    final_block_set = raw_block_set - personal_white_set
    final_white_set = (white_set - personal_block_set) | personal_white_set


    # --- 7. Final Summary ---
    report.append("\n[ Final Summary ]")
    report.append("-" * 70)
    report.append(f"  1. Raw domains collected           : {raw_collected:,}")
    report.append(f"  2. Removed by reference filter     : {ref_removed:,}")
    report.append(f"  3. Removed by external whitelist   : {white_removed:,}")
    report.append(f"  4. Personal block added            : {len(personal_block_set):,}  "
                  f"(forced black: {len(forced_black):,})")
    report.append(f"  5. Personal white applied          : {len(personal_white_set):,}  "
                  f"(forced white: {len(forced_white):,})")
    report.append(f"  6. Final Block Rules               : {len(final_block_set):,}")
    report.append(f"  7. Final Exception Rules           : {len(final_white_set):,}")

    # --- 8. Write Output Files ---
    OUTPUT_DIR.mkdir(exist_ok=True)

    header = (
        f"! Title: Personal Block/Allow List (DNS)\n"
        f"! Generated: {ts}\n"
        f"! Homepage: https://github.com/moamoa7/adblock\n"
        f"! Block Rules: {len(final_block_set):,}\n"
        f"! Exception Rules: {len(final_white_set):,}\n"
        f"!\n"
    )

    # Block_DNS.txt — AdGuard format with exceptions
    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        f.write(header)
        for d in sorted(final_block_set):
            f.write(f"||{d}^\n")
        f.write("\n! === EXCEPTION RULES ===\n")
        for d in sorted(final_white_set):
            f.write(f"@@||{d}^\n")

    # Block_Domains.txt — plain domain list
    with open(OUT_DOMAINS, "w", encoding="utf-8") as f:
        f.write(f"# Generated: {ts}\n")
        f.write(f"# Block Domains: {len(final_block_set):,}\n#\n")
        for d in sorted(final_block_set):
            f.write(f"{d}\n")

    # Block_Hosts.txt — hosts file format
    with open(OUT_HOSTS, "w", encoding="utf-8") as f:
        f.write(f"# Generated: {ts}\n")
        f.write(f"# Block Domains: {len(final_block_set):,}\n#\n")
        for d in sorted(final_block_set):
            f.write(f"0.0.0.0 {d}\n")

    # Report.txt
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
        f.write("\n")

    # Console output
    print("\n".join(report))
    print(f"\n[DONE] Output files written to: {OUTPUT_DIR.resolve()}")
    print(f"  - {OUT_COMBINED.name}    ({len(final_block_set):,} block + {len(final_white_set):,} except)")
    print(f"  - {OUT_DOMAINS.name}")
    print(f"  - {OUT_HOSTS.name}")
    print(f"  - {OUT_REPORT.name}")


if __name__ == "__main__":
    main()
