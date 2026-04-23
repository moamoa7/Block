# -*- coding: utf-8 -*-
import subprocess
import sys
import re
from datetime import datetime, timezone, timedelta

# ==================== 의존성 설치 ====================
try:
    import requests
except ImportError:
    print("requests 설치 중...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ==================== 필터 URL 목록 ====================
urls = [
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://ublockorigin.github.io/uAssets/filters/badware.txt",
    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
    "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt",
    "https://ublockorigin.github.io/uAssets/filters/unbreak.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt",
    "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
    "https://raw.githubusercontent.com/yokoffing/filterlists/main/block_third_party_fonts.txt",
    "https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/filterslist-uBlockOrigin-unified.txt",
    "https://filters.adtidy.org/extension/ublock/filters/7.txt",
]

# ==================== 주석/메타데이터 판별 ====================
_VALID_HASH_PREFIXES = ("##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#")

def is_comment_line(line: str) -> bool:
    """주석이나 메타데이터인지 판별"""
    if line.startswith('!'):
        return True
    if line.startswith('['):
        return True
    if line.startswith('#') and not line.startswith(_VALID_HASH_PREFIXES):
        return True
    return False

# ==================== 필터 다운로드 및 병합 ====================
rules = set()
failed = []

for url in urls:
    try:
        print(f"다운로드 중: {url}")
        response = requests.get(url, timeout=15)
        response.raise_for_status()

        count = 0
        for line in response.text.splitlines():
            stripped = line.strip()
            if stripped and not is_comment_line(stripped):
                rules.add(stripped)
                count += 1

        print(f"  -> {count}개 규칙 수집")

    except Exception as e:
        print(f"  -> 실패: {e}")
        failed.append(url)

# ==================== 헤더 생성 ====================
tz_utc9 = timezone(timedelta(hours=9))  # KST
timestamp = datetime.now(tz_utc9).strftime("%Y-%m-%d %H:%M:%S")

header = f"""! Title: My Combined Filter
! Description: uBlock Origin + EasyList + EasyPrivacy + 기타 필터 통합
! Generated: {timestamp} (KST)
! Total unique rules: {len(rules)}
! Sources: {len(urls)} filter lists
"""

# ==================== 파일 출력 ====================
output_file = "combined_filters.txt"

with open(output_file, "w", encoding="utf-8") as f:
    f.write(header)
    for rule in sorted(rules):
        f.write(rule + "\n")

# ==================== 결과 출력 ====================
print(f"\n{'='*50}")
print(f"완료! -> {output_file}")
print(f"총 고유 규칙 수: {len(rules):,}")
print(f"생성 시각: {timestamp} (KST)")
if failed:
    print(f"실패한 URL ({len(failed)}개):")
    for u in failed:
        print(f"  - {u}")
