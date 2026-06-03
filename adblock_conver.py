name: Convert adblock list

on:
  schedule:
    - cron: '0 0 * * *'   # 매일 1회 실행 (UTC 기준)
  workflow_dispatch:        # 수동 실행 버튼도 추가

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download and convert
        run: |
          echo "! Title: Converted from Shadowrocket adblockplus.conf" > ublock.txt
          echo "! Updated: $(date -u)" >> ublock.txt
          curl -s https://raw.githubusercontent.com/tkgeeked/adblock-rule-plus/main/adblockplus.conf \
          | grep '^DOMAIN-SUFFIX,' \
          | awk -F',' '{print "||" $2 "^"}' \
          >> ublock.txt

      - name: Commit result
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add ublock.txt
          git commit -m "Update ublock.txt" || echo "No changes"
          git push
