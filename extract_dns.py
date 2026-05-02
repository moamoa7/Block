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
    # EasyList
    "https://easylist-downloads.adblockplus.org/easylist.txt",
    # AdGuard Japanese
    "https://filters.adtidy.org/windows/filters/7.txt",
    # List-KR (Korean)
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-AdGuard-classic.txt",
    # uBlock filters
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
]

OUTPUT_DIR = Path("output")
OUTPUT_HOSTS = OUTPUT_DIR / "dns_blocklist_hosts.txt"
OUTPUT_ADGUARD_DNS = OUTPUT_DIR / "dns_blocklist_adguard.txt"
OUTPUT_DOMAINS = OUTPUT_DIR / "dns_blocklist_domains.txt"

# 화이트리스트 (오탐 방지)
WHITELIST = {
    "localhost",
    "localhost.localdomain",
    "broadcasthost",
    "local",
}


def fetch_filter(url: str) -> str:
    """필터 리스트를 다운로드합니다."""
    print(f"[*] Fetching: {url}")
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text


def is_valid_domain(domain: str) -> bool:
    """유효한 도메인인지 검증합니다."""
    if not domain or len(domain) < 3:
        return False
    if domain in WHITELIST:
        return False
    # IP 주소 제외
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", domain):
        return False
    # 와일드카드가 포함된 도메인은 DNS에서 처리 불가 (단순 * 제외)
    if "*" in domain:
        return False
    # 유효한 도메인 패턴 검증
    if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$", domain):
        return False
    return True


def extract_dns_domains(text: str) -> set[str]:
    """
    필터 텍스트에서 DNS 레벨 차단 가능한 도메인만 추출합니다.

    DNS 차단 가능 조건:
    1. ||domain.com^ 형태 (전체 도메인 차단)
    2. 경로(/)가 없어야 함 (예: ||domain.com/path^ 는 DNS로 불가)
    3. 특정 옵션만 허용 ($third-party, $all, $document 등)
       - $script, $image, $stylesheet 등 리소스 타입 필터는
         DNS로는 전체 도메인이 차단되므로 주의 필요
    4. 예외 규칙(@@)은 제외
    5. 코스메틱 필터(##, #@#, #?#)는 제외
    6. 주석(!)은 제외
    """

    domains = set()

    # DNS 차단 시 "허용 가능한" 옵션들
    # 이 옵션들은 도메인 전체를 차단해도 의미가 있는 것들
    DNS_SAFE_OPTIONS = {
        "third-party", "3p",
        "all",
        "document", "doc",
        "popup",
        "important",
        # domain= 제한이 있으면 DNS로는 불가하지만, 일단 도메인은 추출
    }

    # DNS에서 처리 불가한 옵션 (리소스 타입 특정)
    # 이런 옵션이 있으면 도메인 전체를 차단하면 오탐이 생길 수 있음
    DNS_UNSAFE_OPTIONS = {
        "script", "stylesheet", "css", "image", "media",
        "xmlhttprequest", "xhr", "websocket",
        "font", "object", "subdocument", "frame",
        "ping", "other",
        "replace",  # content replacement
    }

    for line in text.splitlines():
        line = line.strip()

        # 빈 줄, 주석, 전처리 지시문 스킵
        if not line or line.startswith("!") or line.startswith("[") or line.startswith("#"):
            continue

        # 예외 규칙 (@@) 스킵
        if line.startswith("@@"):
            continue

        # 코스메틱 필터 스킵 (##, #@#, #?#, ##+js 등)
        if "##" in line or "#@#" in line or "#?#" in line:
            # 단, ||domain.com^$option 같은 것에 ## 이 없어야 함
            # 코스메틱 필터는 도메인##selector 형태
            # 네트워크 필터와 구분: || 로 시작하면 네트워크 필터
            if not line.startswith("||"):
                continue

        # ||domain^ 패턴만 매칭
        # ||domain.com^ 또는 ||domain.com^$options
        match = re.match(r"^\|\|([a-zA-Z0-9\-\.\*]+)\^(\$(.+))?$", line)
        if not match:
            continue

        domain = match.group(1).lower()
        options_str = match.group(3)

        # 도메인에 경로가 포함되면 스킵 (이미 regex에서 걸러짐)
        # 와일드카드 도메인 처리
        if domain.startswith("*."):
            # *.example.com → example.com (서브도메인 포함 차단)
            domain = domain[2:]

        if not is_valid_domain(domain):
            continue

        # 옵션 분석
        if options_str:
            options = [o.strip().lower() for o in options_str.split(",")]

            skip = False
            has_domain_restriction = False
            has_unsafe_only = False

            # ~third-party (1p only) 같은 경우는 DNS에서 판단 불가
            for opt in options:
                # 부정 옵션 체크
                if opt.startswith("~"):
                    base_opt = opt[1:]
                    if base_opt in ("third-party", "3p"):
                        # ~third-party = first-party only → DNS로 차단하면 자사 사이트도 차단됨
                        # 보통은 괜찮지만, 광고 전용 도메인인 경우에만 의미 있음
                        pass  # 일단 포함
                    continue

                # domain= 제한이 있으면 특정 사이트에서만 차단해야 함
                # DNS로는 모든 곳에서 차단되므로 오탐 가능성
                if opt.startswith("domain="):
                    has_domain_restriction = True
                    continue

                # redirect, rewrite 등은 DNS에서 불가
                if opt.startswith("redirect") or opt.startswith("rewrite"):
                    skip = True
                    break

                # replace 옵션은 DNS에서 불가
                if opt.startswith("replace="):
                    skip = True
                    break

                # 리소스 타입 특정 옵션만 있으면 주의 필요
                if opt in DNS_UNSAFE_OPTIONS:
                    has_unsafe_only = True

            if skip:
                continue

            # domain= 제한이 있는 규칙은 제외 (DNS는 글로벌 차단)
            if has_domain_restriction:
                continue

            # 안전한 옵션이 하나도 없고, 위험한 옵션만 있으면 제외
            safe_found = any(
                opt in DNS_SAFE_OPTIONS
                for opt in options
                if not opt.startswith("~") and not opt.startswith("domain=")
            )

            # script, image 등 리소스 타입만 지정된 경우
            # → 해당 도메인이 광고 전용이라면 DNS로 차단해도 됨
            # → 보수적 접근: 제외 / 공격적 접근: 포함
            # 여기서는 보수적 접근 (제외)
            if has_unsafe_only and not safe_found:
                continue

        domains.add(domain)

    return domains


def generate_output(domains: set[str]) -> None:
    """다양한 형식으로 출력 파일을 생성합니다."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sorted_domains = sorted(domains)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    header = f"""\
# DNS Blocklist - Auto-generated
# Generated: {timestamp}
# Total domains: {len(sorted_domains)}
# Sources:
#   - EasyList
#   - AdGuard Japanese filter
#   - List-KR (Korean)
#   - uBlock filters
"""

    # 1. 순수 도메인 리스트
    with open(OUTPUT_DOMAINS, "w") as f:
        f.write(header)
        for domain in sorted_domains:
            f.write(f"{domain}\n")

    # 2. hosts 파일 형식 (Pi-hole 등)
    with open(OUTPUT_HOSTS, "w") as f:
        f.write(header)
        for domain in sorted_domains:
            f.write(f"0.0.0.0 {domain}\n")

    # 3. AdGuard Home DNS 필터 형식
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

    for url in FILTER_URLS:
        try:
            text = fetch_filter(url)
            domains = extract_dns_domains(text)
            print(f"    → {len(domains)}개 도메인 추출됨")
            all_domains.update(domains)
        except Exception as e:
            print(f"    [!] 에러: {e}")

    print(f"\n[*] 중복 제거 후 총 도메인 수: {len(all_domains)}")
    generate_output(all_domains)


if __name__ == "__main__":
    main()
