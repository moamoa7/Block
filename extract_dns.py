#!/usr/bin/env python3
"""
DNS Block/Allow List Generator (Intersection-based)
- Block list = AdGuard DNS Filter (15.txt) ∩ HaGeZi multi.txt
- Then apply: External Whitelist -> Personal Blocklist -> Personal Whitelist
- Outputs: Block_DNS.txt, Block_Domains.txt, Block_Hosts.txt, Report.txt
"""

import re
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import urlopen, Request

# ==================== Configuration ====================

# Two reference filters - intersection becomes the base block list
PRIMARY_FILTER_URL = "https://filters.adtidy.org/windows/filters/15.txt"
SECONDARY_FILTER_URL = "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/multi.txt"

# External whitelist sources
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

# Personal blocklist (force-add - overrides external whitelist)
PERSONAL_BLOCK_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/block.txt",
]

# Personal whitelist (final override - beats everything)
PERSONAL_WHITE_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]

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
                time.sleep(2 ** attempt)
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
        ("filters/15.txt", "AdGuard DNS Filter"),
        ("adblock/multi.txt", "HaGeZi DNS Blocklist"),
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
    """Extract domains from AdGuard-style block rules: ||domain^"""
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
      - Hosts-style lines:      0.0.0.0 example.com
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
                parts = s.split()
                cand = parts[-1] if parts else ""
                if is_valid_domain(cand):
                    domain = cand

        if domain and is_valid_domain(domain):
            out.add(domain)
    return out


def fetch_filter_set(url: str, label: str, report: list) -> set:
    """Fetch a filter and extract its block domains."""
    result = set()
    try:
        txt = fetch(url)
        total_lines = len(txt.splitlines())
        result = extract_block_domains(txt)
        report.append(f"  [OK]  {short_name(url)}")
        report.append(f"        URL     : {url}")
        report.append(f"        Lines   : {total_lines:,}   Domains: {len(result):,}")
    except Exception as e:
        report.append(f"  [FAIL] {label}: {e}")
        print(f"[WARN] {label} failed: {e}")
    return result


# ==================== Main ====================

def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    report = []
    bar = "=" * 70

    report.append(bar)
    report.append("  Filter Extraction Report (Intersection-based)")
    report.append(f"  Generated: {ts}")
    report.append(bar)

    # --- 1. Fetch Two Reference Filters ---
    report.append("\n[ Reference Filters ]")
    report.append("-" * 70)
    primary_set = fetch_filter_set(PRIMARY_FILTER_URL, "Primary (15.txt)", report)
    secondary_set = fetch_filter_set(SECONDARY_FILTER_URL, "Secondary (HaGeZi)", report)

    # --- 2. Build Base Block List = Intersection ---
    report.append("\n[ Step 1: Build Base Block List (Intersection) ]")
    report.append("-" * 70)
    if primary_set and secondary_set:
        base_block_set = primary_set & secondary_set
        report.append(f"  AdGuard DNS Filter (15.txt) : {len(primary_set):,}")
        report.append(f"  HaGeZi multi.txt            : {len(secondary_set):,}")
        report.append(f"  Intersection (base block)   : {len(base_block_set):,}")
        report.append(f"  15.txt only (excluded)      : {len(primary_set - secondary_set):,}")
        report.append(f"  HaGeZi only (excluded)      : {len(secondary_set - primary_set):,}")
    elif primary_set:
        base_block_set = primary_set
        report.append(f"  [WARN] HaGeZi unavailable - using 15.txt only: {len(base_block_set):,}")
    elif secondary_set:
        base_block_set = secondary_set
        report.append(f"  [WARN] 15.txt unavailable - using HaGeZi only: {len(base_block_set):,}")
    else:
        base_block_set = set()
        report.append("  [ERROR] Both filters unavailable - empty block list")

    # --- 3. External Whitelist ---
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
    report.append(f"\n  Total whitelist domains: {len(white_set):,}")

    # --- 4. Personal Blocklist ---
    personal_block_set = set()
    report.append("\n[ Personal Blocklist (Force-add) ]")
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
    report.append(f"\n  Total personal block: {len(personal_block_set):,}")

    # --- 5. Personal Whitelist ---
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
    report.append(f"\n  Total personal white: {len(personal_white_set):,}")

    # --- 6. Apply Priority Rules ---
    base_count = len(base_block_set)
    working_set = set(base_block_set)  # 작업용 복사본

    # Step 2: Apply external whitelist
    report.append("\n[ Step 2: Apply External Whitelist ]")
    report.append("-" * 70)
    before = len(working_set)
    working_set -= white_set
    white_removed = before - len(working_set)
    report.append(f"  Before              : {before:,}")
    report.append(f"  Removed by whitelist: {white_removed:,}")
    report.append(f"  After               : {len(working_set):,}")

    # Step 3: Force-add personal blocklist
    report.append("\n[ Step 3: Apply Personal Blocklist (force-add) ]")
    report.append("-" * 70)
    forced_black = personal_block_set & white_set
    new_from_personal = personal_block_set - working_set
    working_set |= personal_block_set
    report.append(f"  Personal block size : {len(personal_block_set):,}")
    report.append(f"  New (not in base)   : {len(new_from_personal):,}")
    report.append(f"  Forced black        : {len(forced_black):,}  (overrode whitelist)")
    report.append(f"  Block set after     : {len(working_set):,}")

    # Step 4: Apply personal whitelist (true final override)
    report.append("\n[ Step 4: Apply Personal Whitelist (final override) ]")
    report.append("-" * 70)
    forced_white = personal_white_set & working_set
    final_block_set = working_set - personal_white_set
    final_white_set = (white_set - personal_block_set) | personal_white_set
    report.append(f"  Personal white size : {len(personal_white_set):,}")
    report.append(f"  Forced white        : {len(forced_white):,}  (overrode block)")
    report.append(f"  Final block         : {len(final_block_set):,}")
    report.append(f"  Final exception     : {len(final_white_set):,}")

    # --- 7. Final Summary ---
    report.append("\n[ Final Summary ]")
    report.append("-" * 70)
    report.append(f"  1. Base block (15.txt ∩ HaGeZi)  : {base_count:,}")
    report.append(f"  2. Removed by external whitelist : {white_removed:,}")
    report.append(f"  3. Personal block added          : {len(personal_block_set):,}  "
                  f"(forced black: {len(forced_black):,})")
    report.append(f"  4. Personal white applied        : {len(personal_white_set):,}  "
                  f"(forced white: {len(forced_white):,})")
    report.append(f"  5. Final Block Rules             : {len(final_block_set):,}")
    report.append(f"  6. Final Exception Rules         : {len(final_white_set):,}")

    # --- 8. Write Output Files ---
    OUTPUT_DIR.mkdir(exist_ok=True)

    header = (
        f"! Title: Personal Block/Allow List (DNS)\n"
        f"! Generated: {ts}\n"
        f"! Homepage: https://github.com/moamoa7/adblock\n"
        f"! Method: 15.txt ∩ HaGeZi multi.txt + custom whitelist/blocklist\n"
        f"! Block Rules: {len(final_block_set):,}\n"
        f"! Exception Rules: {len(final_white_set):,}\n"
        f"!\n"
    )

    with open(OUT_COMBINED, "w", encoding="utf-8") as f:
        f.write(header)
        for d in sorted(final_block_set):
            f.write(f"||{d}^\n")
        f.write("\n! === EXCEPTION RULES ===\n")
        for d in sorted(final_white_set):
            f.write(f"@@||{d}^\n")

    with open(OUT_DOMAINS, "w", encoding="utf-8") as f:
        f.write(f"# Generated: {ts}\n")
        f.write(f"# Block Domains: {len(final_block_set):,}\n#\n")
        for d in sorted(final_block_set):
            f.write(f"{d}\n")

    with open(OUT_HOSTS, "w", encoding="utf-8") as f:
        f.write(f"# Generated: {ts}\n")
        f.write(f"# Block Domains: {len(final_block_set):,}\n#\n")
        for d in sorted(final_block_set):
            f.write(f"0.0.0.0 {d}\n")

    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
        f.write("\n")

    print("\n".join(report))
    print(f"\n[DONE] Output files written to: {OUTPUT_DIR.resolve()}")
    print(f"  - {OUT_COMBINED.name}    ({len(final_block_set):,} block + {len(final_white_set):,} except)")
    print(f"  - {OUT_DOMAINS.name}")
    print(f"  - {OUT_HOSTS.name}")
    print(f"  - {OUT_REPORT.name}")


if __name__ == "__main__":
    main()
