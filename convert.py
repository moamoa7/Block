#!/usr/bin/env python3
#-*- coding: utf-8 -*-

import urllib.request
import datetime
import os

base_URL = 'https://raw.githubusercontent.com/List-KR/List-KR/master/filterslists/'
cdn_URL = 'https://cdn.jsdelivr.net/npm/@list-kr/filterslists@latest/dist/'

# 소스(GitHub) -> 빌드(jsDelivr) 파일명 매핑
sources = {
    'filterslist-uBlockOrigin-classic.txt': 'filterslist-uBlockOrigin-classic.txt',
    'filterslist-uBlockOrigin.txt': 'filterslist-uBlockOrigin.txt',
    'filterslist-uBlockOrigin-unified.txt': 'filterslist-uBlockOrigin-unified.txt',
    'filterslist-AdGuard-classic.txt': 'filterslist-AdGuard-classic.txt',
    'filterslist-AdGuard.txt': 'filterslist-AdGuard.txt',
    'filterslist-AdGuard-unified.txt': 'filterslist-AdGuard-unified.txt',
}

print("Filter update triggered at " + datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
os.makedirs('./dist', exist_ok=True)


def get_header_from_cdn(cdn_filename):
    """jsDelivr 빌드 파일에서 헤더(! 로 시작하는 줄)를 가져옴"""
    url = cdn_URL + cdn_filename
    header = ''
    try:
        with urllib.request.urlopen(url) as response:
            for line in response.read().decode('utf-8').splitlines():
                if line.startswith('! '):
                    header += line + '\n'
                elif line.startswith('!#') or (line and not line.startswith('!')):
                    break
        print(f"  Header fetched from CDN: {cdn_filename}")
    except Exception as e:
        print(f"  Header fetch FAIL: {e}")
    return header


def flatten_filter(source_filename, cdn_filename):
    url = base_URL + source_filename
    print(f"\n===== Processing: {source_filename} =====")

    # 1. 원본 헤더 가져오기
    header = get_header_from_cdn(cdn_filename)

    # 2. 소스 파일에서 include 목록 수집
    with urllib.request.urlopen(url) as response:
        filter_text = response.read().decode('utf-8')

    sub_filters = []
    for line in filter_text.splitlines():
        if line.startswith('!#if') or line.startswith('!#endif'):
            continue
        elif line.startswith('!#include'):
            path = line.split(" ", 1)[1].strip()
            if path not in sub_filters:
                sub_filters.append(path)

    # 3. 서브 필터 병합
    flattened = header + '\n'
    success = 0
    fail = 0

    for sub_filter in sub_filters:
        sub_url = base_URL + sub_filter
        try:
            with urllib.request.urlopen(sub_url) as resp:
                content = resp.read().decode('utf-8')
                flattened += '!\n! Filter: ' + sub_filter + '\n!\n' + content + '\n'
                success += 1
        except Exception as e:
            print(f"  FAIL: {sub_filter} -> {e}")
            fail += 1

    output_name = source_filename.replace('filterslist-', 'flat-')
    output_path = f'./dist/{output_name}'

    with open(output_path, 'w', encoding='UTF-8') as f:
        f.write(flattened)

    print(f"  Done: {success} OK, {fail} FAIL -> {output_path}")


for source, cdn in sources.items():
    flatten_filter(source, cdn)

print("\nAll filters processed.")
