#!/usr/bin/env python3
#-*- coding: utf-8 -*-

import urllib.request
import datetime
import os

base_URL = 'https://raw.githubusercontent.com/List-KR/List-KR/master/filterslists/'

# 평탄화할 소스 파일 전체 목록
sources = [
    'filterslist-uBlockOrigin-classic.txt',
    'filterslist-uBlockOrigin.txt',
    'filterslist-uBlockOrigin-unified.txt',
    'filterslist-AdGuard-classic.txt',
    'filterslist-AdGuard.txt',
    'filterslist-AdGuard-unified.txt',
]

print("Filter update triggered at " + datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
os.makedirs('./dist', exist_ok=True)


def flatten_filter(source_filename):
    url = base_URL + source_filename
    print(f"\n===== Processing: {source_filename} =====")

    with urllib.request.urlopen(url) as response:
        filter_text = response.read().decode('utf-8')

    sub_filters = []
    for line in filter_text.splitlines():
        if line.startswith('!#if') or line.startswith('!#endif'):
            continue
        elif line.startswith('!#include'):
            path = line.split(" ", 1)[1].strip()
            if path not in sub_filters:  # 중복 제거
                sub_filters.append(path)

    flattened = ''
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

    # 출력 파일명: filterslist-xxx.txt -> flat-xxx.txt
    output_name = source_filename.replace('filterslist-', 'flat-')
    output_path = f'./dist/{output_name}'

    with open(output_path, 'w', encoding='UTF-8') as f:
        f.write(flattened)

    print(f"  Done: {success} OK, {fail} FAIL -> {output_path}")


for source in sources:
    flatten_filter(source)

print("\nAll filters processed.")
