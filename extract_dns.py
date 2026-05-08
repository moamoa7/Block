#!/usr/bin/env python3
"""
DNS Block/Allow List Generator (Intersection-based)
- Block list = AdGuard DNS Filter (15.txt) ∩ HaGeZi's Pro.txt
- Apply: External Whitelist (auto-filtered) → Personal Blocklist → Personal Whitelist
- Outputs:
    Block_DNS.txt  (||domain^)
    White_DNS.txt  (@@||domain^)
    Report.txt
"""

import re
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# ---------- Configuration ----------
PRIMARY_FILTER_URL = "https://filters.adtidy.org/windows/filters/15.txt"
SECONDARY_FILTER_URL = "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.txt"

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
    "https://raw.githubusercontent.com/anudeepND/whitelist/master/domains/whitelist.txt",
    "https://raw.githubusercontent.com/DandelionSprout/AdGuard-Home-Whitelist/master/whitelist.txt",
]

PERSONAL_BLOCK_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/block.txt",
]
PERSONAL_WHITE_URLS = [
    "https://raw.githubusercontent.com/moamoa7/adblock/main/white.txt",
]

OUTPUT_DIR = Path("output")
OUT_BLOCK_DNS = OUTPUT_DIR / "Block_DNS.txt"
OUT_WHITE_DNS = OUTPUT_DIR / "White_DNS.txt"
OUT_REPORT = OUTPUT_DIR / "Report.txt"

# ---------- Tracker Auto-Filter ----------
# 외부 화이트리스트(EXCLUSION_URLS)에 섞여 들어온 광고/추적 도메인을 자동 제거.
# 개인 화이트리스트(PERSONAL_WHITE_URLS)에는 적용하지 않음 — 사용자가 의도적으로 풀어준 항목 보호.

TRACKER_PATTERNS = [
    # 광고 네트워크 / 분석 (정확한 도메인/서브문자열)
    "doubleclick", "googlesyndication", "googleadservices",
    "googletagservices", "google-analytics", "analytics.google",
    "adservice.google",
    "scorecardresearch", "omtrdc", "viglink", "2mdn",
    "adobedtm", "adobetarget",
    # 모바일 추적 SDK
    "appsflyer", "amplitude.com",
    "adjust.com", "adjust.cn", "adjust.io", "adjust.net.in", "adjust.world",
    # 광고 네트워크 (일반)
    "admitad", "adform.", ".adform", "adswizz", "adtechus", "adzerk",
    "ads-twitter", "analytics.twitter", "analytics.pinterest",
    "atdmt.com", "bluekai", "bkrtx", "bndspn",
    "auditude", "avantlink",
    "bdash-tracking", "bigcattracks", "bmtrck",
    "trackmytarget", "auth-analytics", "auth-analytix",
    "awmonitor", "aumtrack", "arttrk",
    # 트래킹 키워드 (도메인 어디든 포함되면 의심)
    ".tracking.", "-tracking.",
    ".tracker.", "-tracker.",
    ".trk.", "-trk.",
    "telemetry.",
    "metrics.",
    # Facebook 픽셀/광고 (본 도메인 제외)
    "pixel.facebook", "connect.facebook.net", "an.facebook.com",
]

# 트래커 키워드와 겹치지만 인프라/필수 도메인은 예외로 보존.
EXCEPTION_KEYWORDS = [
    # 금융/인증
    "bank", "secure", "auth", "login", "account",
    "payment", "checkout", "stripe", "paypal",
    # 보안/CAPTCHA
    "captcha", "recaptcha", "hcaptcha", "awswaf",
    # 인증서/OCSP
    "letsencrypt", "ocsp", "digicert", "sectigo",
    # 인프라/CDN
    "github", "gitlab", "cloudflare", "akamai", "fastly",
    "googleapis", "gstatic", "googleusercontent",
    # OS 연결성
    "msftncsi", "connectivitycheck", "captive", "msftconnecttest",
]


def is_tracker_domain(domain: str) -> bool:
    """외부 화이트리스트에서 트래커로 의심되는 도메인을 판별."""
    d = domain.lower()
    # 예외 키워드가 있으면 트래커가 아님 (인프라 보호)
    if any(kw in d for kw in EXCEPTION_KEYWORDS):
        return False
    # 트래커 키워드가 있으면 트래커
    return any(kw in d for kw in TRACKER_PATTERNS)


# ---------- Helpers ----------
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def is_valid_domain(d: str) -> bool:
    return bool(DOMAIN_RE.match(d.lower()))


def fetch(url: str, retries: int = 3, timeout: int = 30) -> str:
    """간단한 재시도 + UA 헤더 fetch."""
    headers = {"User-Agent": "Mozilla/5.0 (DNS-Blocklist-Generator)"}
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except (URLError, HTTPError, TimeoutError) as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    print(f"[WARN] Failed to fetch {url}: {last_err}")
    return ""


def short_name(url: str) -> str:
    mapping = [
        ("filters/15.txt", "AdGuard DNS Filter (15.txt)"),
        ("hagezi/dns-blocklists", "HaGeZi DNS Pro"),
        ("AdGuardSDNSFilter", "AdGuard SDNS Exclusions"),
        ("HttpsExclusions/master/exclusions/banks", "AdGuard HTTPS Banks"),
        ("HttpsExclusions/master/exclusions/sensitive", "AdGuard HTTPS Sensitive"),
        ("HttpsExclusions/master/exclusions/issues", "AdGuard HTTPS Issues"),
        ("HttpsExclusions/master/exclusions/android", "AdGuard HTTPS Android"),
        ("HttpsExclusions/master/exclusions/firefox", "AdGuard HTTPS Firefox"),
        ("HttpsExclusions/master/exclusions/windows", "AdGuard HTTPS Windows"),
        ("HttpsExclusions/master/exclusions/mac", "AdGuard HTTPS Mac"),
        ("whitelist-referral-native", "HaGeZi Referral Native"),
        ("Discord-Phishing-URLs", "Discord Official Domains"),
        ("anudeepND/whitelist/master/domains/whitelist.txt", "anudeepND Whitelist"),
        ("DandelionSprout/AdGuard-Home-Whitelist", "DandelionSprout AGH Whitelist"),
        ("moamoa7/adblock/main/block", "Personal Blocklist"),
        ("moamoa7/adblock/main/white", "Personal Whitelist"),
    ]
    for key, name in mapping:
        if key in url:
            return name
    return url


def extract_block_domains(text: str) -> set:
    """||domain^ 또는 0.0.0.0 domain 형태에서 도메인 추출."""
    out = set()
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith(("!", "#", "[")):
            continue
        # AdGuard 차단 규칙: ||domain^
        m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", s)
        if m:
            d = m.group(1)
            if is_valid_domain(d):
                out.add(d)
            continue
        # hosts 형식: 0.0.0.0 domain
        parts = s.split()
        if len(parts) >= 2 and parts[0] in ("0.0.0.0", "127.0.0.1"):
            d = parts[1].lower()
            if is_valid_domain(d):
                out.add(d)
            continue
        # 일반 도메인 한 줄
        if len(parts) == 1:
            d = parts[0].lower()
            if is_valid_domain(d):
                out.add(d)
    return out


def extract_whitelist_domains(text: str) -> set:
    """다양한 화이트리스트 형식에서 도메인 추출."""
    out = set()
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith(("!", "#", "[", "//")):
            continue

        # AdGuard 예외 규칙: @@||domain^...
        m = re.match(r"^@@\|\|([a-z0-9\-\.]+)\^", s)
        if m:
            d = m.group(1)
            if is_valid_domain(d):
                out.add(d)
            continue

        # AdGuard SDNS exclusions 형식: ||domain^ (이 파일에서는 화이트리스트로 동작)
        m = re.match(r"^\|\|([a-z0-9\-\.]+)\^", s)
        if m:
            d = m.group(1)
            if is_valid_domain(d):
                out.add(d)
            continue

        # 일반 도메인 (한 줄에 도메인 하나)
        # $app= 같은 modifier 가 붙은 라인은 split[-1] 이 도메인이 아니므로 split[0]만 사용
        first = s.split()[0]
        # $modifier 제거
        first = first.split("$")[0]
        # 주석 제거
        first = first.split("#")[0].strip()
        if is_valid_domain(first.lower()):
            out.add(first.lower())
    return out


def fetch_filter_set(url: str, label: str, report: list) -> set:
    txt = fetch(url)
    s = extract_block_domains(txt)
    report.append(f"[{label}] {len(s):,} domains")
    return s


# ---------- Main ----------
def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    report = []
    report.append(f"DNS Blocklist Build Report")
    report.append(f"Generated: {ts}")
    report.append("=" * 60)

    # 1. 기본 차단 = AdGuard DNS Filter ∩ HaGeZi Pro
    report.append("\n[1] Reference Filters")
    primary_set = fetch_filter_set(PRIMARY_FILTER_URL, "Primary (AdGuard 15.txt)", report)
    secondary_set = fetch_filter_set(SECONDARY_FILTER_URL, "Secondary (HaGeZi Pro)", report)

    if primary_set and secondary_set:
        base_block_set = primary_set & secondary_set
        report.append(f"[Intersection] {len(base_block_set):,} domains")
    else:
        base_block_set = primary_set or secondary_set
        report.append(f"[Fallback - single source] {len(base_block_set):,} domains")

    # 2. 외부 화이트리스트 로드
    report.append("\n[2] External Whitelist Sources")
    white_set = set()
    for url in EXCLUSION_URLS:
        txt = fetch(url)
        domains = extract_whitelist_domains(txt)
        white_set.update(domains)
        report.append(f"  - {short_name(url)}: {len(domains):,} extracted")
    report.append(f"[External Whitelist Total] {len(white_set):,} domains")

    # 2-1. ★ 트래커 자동 필터 (외부 화이트리스트에만 적용)
    before = len(white_set)
    removed_trackers = {d for d in white_set if is_tracker_domain(d)}
    white_set -= removed_trackers
    after = len(white_set)
    report.append(f"\n[Tracker Auto-Filter] Removed {before - after:,} trackers from external whitelist")
    if removed_trackers:
        sample = sorted(removed_trackers)[:30]
        report.append("  Sample removed (first 30):")
        for d in sample:
            report.append(f"    - {d}")
        if len(removed_trackers) > 30:
            report.append(f"    ... and {len(removed_trackers) - 30:,} more")

    # 3. 개인 블록 (강제 추가)
    report.append("\n[3] Personal Blocklist")
    personal_block_set = set()
    for url in PERSONAL_BLOCK_URLS:
        txt = fetch(url)
        d = extract_block_domains(txt)
        personal_block_set.update(d)
        report.append(f"  - {short_name(url)}: {len(d):,} domains")
    report.append(f"[Personal Block Total] {len(personal_block_set):,} domains")

    # 4. 개인 화이트 (최종 우선권 - 필터 적용 안 함)
    report.append("\n[4] Personal Whitelist (no filter applied)")
    personal_white_set = set()
    for url in PERSONAL_WHITE_URLS:
        txt = fetch(url)
        d = extract_whitelist_domains(txt)
        personal_white_set.update(d)
        report.append(f"  - {short_name(url)}: {len(d):,} domains")
    report.append(f"[Personal Whitelist Total] {len(personal_white_set):,} domains")

    # 5. 우선순위 적용
    report.append("\n[5] Apply Priority Rules")
    step1 = base_block_set - white_set
    report.append(f"  Step 1 (base - external whitelist): {len(step1):,}")

    step2 = step1 | personal_block_set
    forced = personal_block_set - step1
    report.append(f"  Step 2 (+ personal block): {len(step2):,}  (forced added: {len(forced):,})")

    final_block_set = step2 - personal_white_set
    overridden = step2 & personal_white_set
    report.append(f"  Step 3 (- personal white): {len(final_block_set):,}  (whitelist override: {len(overridden):,})")

    # 6. 화이트리스트 출력 = 외부 화이트(필터링 후) + 개인 화이트, 단 개인 블록과 충돌하면 제외
    final_white_set = (white_set | personal_white_set) - personal_block_set
    final_white_set |= personal_white_set  # 개인 화이트는 무조건 포함
    report.append(f"\n[6] Final Whitelist: {len(final_white_set):,} domains")

    # 7. 충돌 검증
    conflict = personal_block_set & personal_white_set
    if conflict:
        report.append(f"\n[WARN] block.txt와 white.txt 동시 등록: {len(conflict)}개 (white가 우선)")
        for d in sorted(conflict):
            report.append(f"  - {d}")

    # 8. 파일 출력
    with open(OUT_BLOCK_DNS, "w", encoding="utf-8") as f:
        f.write(f"! Title: Personal Block List (DNS)\n")
        f.write(f"! Homepage: https://github.com/moamoa7/adblock\n")
        f.write(f"! Generated: {ts}\n")
        f.write(f"! Method: (AdGuard DNS ∩ HaGeZi Pro) - ExtWhite + PersonalBlock - PersonalWhite\n")
        f.write(f"! Block Rules: {len(final_block_set):,}\n!\n")
        for d in sorted(final_block_set):
            f.write(f"||{d}^\n")

    with open(OUT_WHITE_DNS, "w", encoding="utf-8") as f:
        f.write(f"! Title: Personal Allow List (DNS)\n")
        f.write(f"! Homepage: https://github.com/moamoa7/adblock\n")
        f.write(f"! Generated: {ts}\n")
        f.write(f"! Method: External Whitelist (tracker-filtered) + Personal Whitelist - Personal Block\n")
        f.write(f"! Exception Rules: {len(final_white_set):,}\n!\n")
        for d in sorted(final_white_set):
            f.write(f"@@||{d}^\n")

    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(report))

    print("[DONE] Files written to", OUTPUT_DIR.resolve())
    print(f"  Block_DNS.txt : {len(final_block_set):,} rules")
    print(f"  White_DNS.txt : {len(final_white_set):,} rules")
    print(f"  Report.txt    : {len(report)} lines")


if __name__ == "__main__":
    main()
