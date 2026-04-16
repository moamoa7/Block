#!/usr/bin/env python3
#-*- coding: utf-8 -*-

import urllib.request
import datetime
import os

base_URL = 'https://raw.githubusercontent.com/List-KR/List-KR/master/filterslists/'

# 각 소스 파일별 헤더 정보
headers = {
    'filterslist-uBlockOrigin-classic.txt': {
        'title': 'List-KR classic filters list (uBlock Origin)',
        'description': 'uBlock Origin용 List-KR 클래식 필터 리스트입니다.',
    },
    'filterslist-uBlockOrigin.txt': {
        'title': 'List-KR filters list (uBlock Origin)',
        'description': 'uBlock Origin용 List-KR 필터 리스트입니다.',
    },
    'filterslist-uBlockOrigin-unified.txt': {
        'title': 'List-KR unified filters list (uBlock Origin)',
        'description': 'uBlock Origin용 List-KR 통합 필터 리스트입니다. 한국어권 및 국제 웹 페이지 및 앱에 있는 광고, 트래커, 방해 요소와 안티 애드블록을 차단합니다.',
    },
    'filterslist-AdGuard-classic.txt': {
        'title': 'List-KR classic filters list (AdGuard)',
        'description': 'AdGuard용 List-KR 클래식 필터 리스트입니다.',
    },
    'filterslist-AdGuard.txt': {
        'title': 'List-KR filters list (AdGuard)',
        'description': 'AdGuard용 List-KR 필터 리스트입니다.',
    },
    'filterslist-AdGuard-unified.txt': {
        'title': 'List-KR unified filters list (AdGuard)',
        'description': 'AdGuard용 List-KR 통합 필터 리스트입니다. 한국어권 및 국제 웹 페이지 및 앱에 있는 광고, 트래커, 방해 요소와 안티 애드블록을 차단합니다.',
    },
}

sources = list(headers.keys())

print("Filter update triggered at " + datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
os.makedirs('./dist', exist_ok=True)


def make_header(source_filename):
    info = headers[source_filename]
    now = datetime.datetime.utcnow()
    version = now.strftime('%Y.%m%d%H.0')
    return (
        f"! Title: {info['title']}\n"
        f"! Description: {info['description']}\n"
        f"! Version: {version}\n"
        f"! Expires: 1 day (update frequency)\n"
        f"! Homepage: https://github.com/List-KR/List-KR\n"
        f"! Licence: https://github.com/List-KR/List-KR/blob/master/LICENSE\n"
    )


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
            if path not in sub_filters:
                sub_filters.append(path)

    flattened = make_header(source_filename) + '\n'
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


for source in sources:
    flatten_filter(source)

print("\nAll filters processed.")
