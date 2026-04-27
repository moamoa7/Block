# -*- coding: utf-8 -*-
"""
ubo_to_adguard.py
uBlock Origin 필터 → AdGuard 문법 변환
출력:
  - ubo_converted.txt          (변환된 필터)
  - ubo_convert_status.md      (변환 리포트)
"""
import subprocess, sys, os, re, tempfile, shutil
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
    import requests

# ============================================================
# uBO 필터 소스
# ============================================================
UBO_FILTER_URLS = [
    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
    "https://ublockorigin.github.io/uAssets/filters/unbreak.txt",
    "https://ublockorigin.github.io/uAssets/filters/badware.txt",
    "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt",
    "https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt",
]

UBO_FILTER_NAMES = {
    "filters.txt":         "uBlock filters",
    "privacy.txt":         "uBlock filters – Privacy",
    "unbreak.txt":         "uBlock filters – Unbreak",
    "badware.txt":         "uBlock filters – Badware risks",
    "quick-fixes.txt":     "uBlock filters – Quick fixes",
    "resource-abuse.txt":  "uBlock filters – Resource abuse",
}

OUTPUT_FILE = "ubo_converted.txt"
REPORT_FILE = "ubo_convert_status.md"

# ============================================================
# 스크립틀릿 매핑 (uBO → AdGuard)
# ============================================================
SCRIPTLET_MAP = {
    "aopr":    "abort-on-property-read",
    "aopw":    "abort-on-property-write",
    "aeld":    "addEventListener-defuser",
    "aost":    "abort-on-stack-trace",
    "acs":     "abort-current-inline-script",
    "acis":    "abort-current-inline-script",
    "set":     "set-constant",
    "nosiif":  "no-setInterval-if",
    "nostif":  "no-setTimeout-if",
    "nowoif":  "prevent-window-open",
    "ra":      "remove-attr",
    "rc":      "remove-class",
    "rmnt":    "remove-node-text",
    "rpnt":    "replace-node-text",
    "no-fetch-if":                 "prevent-fetch",
    "no-xhr-if":                   "prevent-xhr",
    "nano-sib":                    "nano-setInterval-booster",
    "nano-stb":                    "nano-setTimeout-booster",
    "window.name-defuser":         "window-name-defuser",
    "noeval":                      "noeval",
    "noeval-if":                   "noeval-if",
    "set-cookie":                  "set-cookie",
    "set-local-storage-item":      "set-local-storage-item",
    "set-session-storage-item":    "set-session-storage-item",
    "json-prune":                  "json-prune",
    "json-prune-fetch-response":   "json-prune-fetch-response",
    "json-prune-xhr-response":     "json-prune-xhr-response",
    "xml-prune":                   "xml-prune",
    "href-sanitizer":              "href-sanitizer",
    "disable-newtab-links":        "disable-newtab-links",
    "close-window":                "close-window",
    "call-nothrow":                "call-nothrow",
    "evaldata-prune":              "evaldata-prune",
    "remove-cookie":               "remove-cookie",
    "adjust-setInterval":          "adjust-setInterval",
    "adjust-setTimeout":           "adjust-setTimeout",
    "prevent-addEventListener":    "addEventListener-defuser",
}

# ============================================================
# 리다이렉트 매핑
# ============================================================
REDIRECT_MAP = {
    "1x1.gif":               "1x1-transparent.gif",
    "2x2.png":               "2x2-transparent.png",
    "3x2.png":               "3x2-transparent.png",
    "32x32.png":             "32x32-transparent.png",
    "noopjs":                "noopjs",
    "noopcss":               "noopcss",
    "nooptext":              "nooptext",
    "noop.txt":              "nooptext",
    "noopframe":             "noopframe",
    "noop.html":             "noopframe",
    "noop-1s.mp3":           "noopmp3-0.1s",
    "noopmp3-0.1s":          "noopmp3-0.1s",
    "noop-0.1s.mp3":         "noopmp3-0.1s",
    "noopmp4-1s":            "noopmp4-1s",
    "noop-0.5s.mp4":         "noopmp4-1s",
    "noop-1s.mp4":           "noopmp4-1s",
    "noopvmap-1.0":          "noopvmap-1.0",
    "noopvast-2.0":          "noopvast-2.0",
    "noopvast-3.0":          "noopvast-3.0",
    "noopvast-4.0":          "noopvast-4.0",
    "google-ima.js":         "google-ima3",
    "googlesyndication_adsbygoogle.js": "googlesyndication-adsbygoogle",
    "googletagmanager_gtm.js":         "googletagmanager-gtm",
    "googletagservices_gpt.js":        "googletagservices-gpt",
    "amazon_ads.js":         "amazon-adsystem",
    "amazon_apstag.js":      "amazon-apstag",
    "scorecardresearch_beacon.js": "scorecardresearch-beacon",
    "click2load.html":       "click2load.html",
    "popads.net.js":         "popads-dummy",
    "fuckadblock.js-3.2.0":  "fuckadblock.js-3.2.0",
    "hd-main.js":            "hd-main.js",
}

# ============================================================
# 옵션 축약형
# ============================================================
OPTION_EXPAND = {
    "1p": "first-party", "3p": "third-party",
    "xhr": "xmlhttprequest", "doc": "document",
    "css": "stylesheet", "frame": "subdocument",
    "ghide": "generichide", "ehide": "elemhide",
    "shide": "specifichide",
}

# ============================================================
# 변환 불가 패턴
# ============================================================
UBO_ONLY_PATTERNS = [
    "!#if ", "!#else", "!#endif", "!#include ",
    "##+js(trusted-", "#@#+js(trusted-",
    ":matches-path(", ":matches-attr(",
    "##^",
    ":upward(",
]

_VALID_HASH = (
    "##", "#@#", "#$#", "#$@#", "#?#", "#@?#", "#%#", "#@%#",
    "##+js(", "#@#+js(",
)

_OPT_HINTS = {
    "1p","3p","xhr","doc","ghide","ehide","shide","css","frame",
    "redirect","redirect-rule","important","domain=","denyallow=",
    "script","image","media","popup","font","object","other",
    "first-party","third-party","stylesheet","subdocument",
    "xmlhttprequest","generichide","elemhide","specifichide",
    "match-case","badfilter","all","removeparam","replace=",
    "csp=","permissions=","header=",
}

# ============================================================
# 변환 함수
# ============================================================
def _is_ubo_only(line):
    return any(p in line for p in UBO_ONLY_PATTERNS)

def _convert_scriptlet(line):
    exc = re.match(r'^(.*?)#@#\+js\((.+)\)$', line)
    std = re.match(r'^(.*?)##\+js\((.+)\)$', line)
    if exc:
        domains, inner, sep = exc.group(1), exc.group(2), "#@%#"
    elif std:
        domains, inner, sep = std.group(1), std.group(2), "#%#"
    else:
        return None
    parts = inner.split(",", 1)
    ubo_name = parts[0].strip()
    adg_name = SCRIPTLET_MAP.get(ubo_name, ubo_name)
    if len(parts) > 1 and parts[1].strip():
        args = [a.strip() for a in parts[1].split(",")]
        args_str = ", ".join(f"'{a}'" for a in args)
        return f"{domains}{sep}//scriptlet('{adg_name}', {args_str})"
    return f"{domains}{sep}//scriptlet('{adg_name}')"

def _convert_options(opts):
    out = []
    for p in opts.split(","):
        p = p.strip()
        rm = re.match(r'^(redirect(?:-rule)?)=(.+?)(?::\d+)?$', p)
        if rm:
            out.append(f"{rm.group(1)}={REDIRECT_MAP.get(rm.group(2), rm.group(2))}")
            continue
        neg = "~" if p.startswith("~") else ""
        key = p.lstrip("~")
        out.append(neg + OPTION_EXPAND.get(key, key))
    return ",".join(out)

def _convert_network(line):
    idx = line.rfind("$")
    if idx <= 0:
        return line
    base, opts = line[:idx], line[idx+1:]
    if any(kw in opts.lower() for kw in _OPT_HINTS):
        return base + "$" + _convert_options(opts)
    return line

def convert_rule(line):
    s = line.strip()
    if not s or s.startswith("!") or s.startswith("["):
        return None
    if s.startswith("#") and not any(s.startswith(p) for p in _VALID_HASH):
        return None
    if _is_ubo_only(s):
        return None
    if "##+js(" in s or "#@#+js(" in s:
        return _convert_scriptlet(s)
    if "$" in s:
        return _convert_network(s)
    return s

# ============================================================
# Node.js 변환 (선택적)
# ============================================================
_CONVERTER_JS = """\
const{FilterList}=require('@adguard/tsurlfilter');
const fs=require('fs');
process.stdout.write(new FilterList(fs.readFileSync(process.argv[2],'utf-8')).getContent());
"""

def _check_node():
    node = shutil.which("node")
    if not node:
        return None
    try:
        r = subprocess.run([node, "-e", "require('@adguard/tsurlfilter')"],
                           capture_output=True, timeout=10)
        return node if r.returncode == 0 else None
    except Exception:
        return None

def _try_node(node_cmd, raw):
    try:
        tf = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8')
        tf.write(raw); tf.close()
        sf = tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False, encoding='utf-8')
        sf.write(_CONVERTER_JS); sf.close()
        r = subprocess.run([node_cmd, sf.name, tf.name],
                           capture_output=True, text=True, timeout=120)
        os.unlink(tf.name); os.unlink(sf.name)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout
    except Exception:
        pass
    return None

def _python_convert(raw):
    rules, skipped = [], 0
    for line in raw.splitlines():
        r = convert_rule(line)
        if r is not None:
            rules.append(r)
        elif line.strip() and not line.strip().startswith("!") and not line.strip().startswith("["):
            skipped += 1
    return rules, skipped

# ============================================================
# 메인
# ============================================================
def main():
    KST = timezone(timedelta(hours=9))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")

    node_cmd = _check_node()
    converter_name = "tsurlfilter (Node.js)" if node_cmd else "Python built-in"
    if node_cmd:
        print(f"[INFO] Node.js + @adguard/tsurlfilter → 공식 변환기 사용")
    else:
        print(f"[INFO] Python 내장 변환기 사용")

    all_blocks = []
    all_results = []
    total_converted = 0
    total_skipped = 0

    for url in UBO_FILTER_URLS:
        fname = url.split("/")[-1]
        name = UBO_FILTER_NAMES.get(fname, fname)
        print(f"\n  [{name}]")

        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            raw = resp.text
            raw_count = sum(1 for l in raw.splitlines()
                           if l.strip() and not l.strip().startswith("!"))
            print(f"    원본: {raw_count:,} 라인")
        except Exception as e:
            print(f"    ❌ 다운로드 실패: {e}")
            all_results.append({
                "name": name, "url": url, "status": "FAIL",
                "code": "N/A", "raw": 0, "converted": 0, "skipped": 0,
                "method": "-", "error": str(e),
            })
            continue

        method = "python"
        if node_cmd:
            node_out = _try_node(node_cmd, raw)
            if node_out:
                rules = [l.strip() for l in node_out.splitlines()
                         if l.strip() and not l.strip().startswith("!")
                         and not l.strip().startswith("[")]
                skipped = max(0, raw_count - len(rules))
                method = "node"
            else:
                rules, skipped = _python_convert(raw)
                method = "python(fallback)"
        else:
            rules, skipped = _python_convert(raw)

        total_converted += len(rules)
        total_skipped += skipped
        all_blocks.append((name, url, rules))
        all_results.append({
            "name": name, "url": url, "status": "OK",
            "code": resp.status_code, "raw": raw_count,
            "converted": len(rules), "skipped": skipped,
            "method": method, "error": "",
        })
        print(f"    변환: {len(rules):,}  |  스킵: {skipped:,}  |  방식: {method}")

    # ============================================================
    # ubo_converted.txt 출력
    # ============================================================
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(f"! Title: uBO → AdGuard Converted Filters\n")
        f.write(f"! Description: uBlock Origin 필터를 AdGuard 문법으로 자동 변환\n")
        f.write(f"! Expires: 12 hours\n")
        f.write(f"! Generated: {now} (KST)\n")
        f.write(f"! Converted: {total_converted:,} rules\n")
        f.write(f"! Skipped: {total_skipped:,} rules (uBO-only syntax)\n")
        f.write(f"! Converter: {converter_name}\n")
        f.write(f"! Note: Trusted 체크 필수\n")
        for name, url, rules in all_blocks:
            if not rules:
                continue
            f.write(f"\n! ========================================\n")
            f.write(f"! >>> {name}\n")
            f.write(f"! >>> {url}\n")
            f.write(f"! >>> Rules: {len(rules):,}\n")
            f.write(f"! ========================================\n")
            for rule in rules:
                f.write(rule + "\n")

    # ============================================================
    # ubo_convert_status.md 출력
    # ============================================================
    ok_count = sum(1 for r in all_results if r["status"] == "OK")
    fail_count = len(all_results) - ok_count

    md = [
        "# uBO → AdGuard 변환 리포트", "",
        f"**Updated:** {now} (KST)  ", 
        f"**Converter:** {converter_name}  ",
        f"**Output:** `{OUTPUT_FILE}`  ", "",

        "## Summary", "",
        f"| 항목 | 값 |",
        f"|------|-----|",
        f"| Sources | {len(all_results)} total |",
        f"| ✅ OK | {ok_count} |",
        f"| ❌ Failed | {fail_count} |",
        f"| Converted rules | {total_converted:,} |",
        f"| Skipped rules | {total_skipped:,} |",
        f"| Conversion rate | {total_converted / max(total_converted + total_skipped, 1) * 100:.1f}% |",
        "",

        "## Filter Details", "",
        "| Status | Filter | Raw | Converted | Skipped | Rate | Method |",
        "|--------|--------|-----|-----------|---------|------|--------|",
    ]

    for r in all_results:
        if r["status"] == "OK":
            rate = f"{r['converted'] / max(r['raw'], 1) * 100:.0f}%"
            md.append(
                f"| ✅ OK | {r['name']} | {r['raw']:,} | "
                f"{r['converted']:,} | {r['skipped']:,} | {rate} | {r['method']} |"
            )
        else:
            md.append(
                f"| ❌ FAIL | {r['name']} | - | - | - | - | {r['error']} |"
            )

    # 실패 상세
    if fail_count > 0:
        md += ["", "## Failed Sources", ""]
        for r in all_results:
            if r["status"] != "OK":
                md.append(f"- ❌ **{r['name']}**: `{r['url']}`  ")
                md.append(f"  Error: {r['error']}")

    # 스킵 사유 설명
    md += [
        "", "## Skipped Rules 참고", "",
        "변환이 스킵된 룰은 uBO 전용 문법으로 AdGuard에서 지원하지 않는 것들입니다:", "",
        "| 패턴 | 설명 |",
        "|------|------|",
        "| `!#if` / `!#else` / `!#endif` | 조건부 컴파일 (환경별 분기) |",
        "| `##+js(trusted-...)` | Trusted 스크립틀릿 (uBO 전용) |",
        "| `##^` | HTML 필터링 (AdGuard는 `$$` 문법) |",
        "| `:matches-path()` | URL 경로 매칭 (uBO 전용) |",
        "| `:matches-attr()` | 속성 정규식 매칭 (uBO 전용) |",
        "| `:upward()` | 상위 요소 선택 (uBO 전용) |",
    ]

    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    # ============================================================
    # 콘솔 요약
    # ============================================================
    print("\n" + "=" * 60)
    print(f"  📁 필터:  {OUTPUT_FILE}")
    print(f"  📊 리포트: {REPORT_FILE}")
    print(f"  🕐 시간:  {now} (KST)")
    print(f"  ✅ 변환:  {total_converted:,} rules")
    print(f"  ⏭️  스킵:  {total_skipped:,} rules")
    print(f"  📈 비율:  {total_converted / max(total_converted + total_skipped, 1) * 100:.1f}%")
    print(f"  🔧 방식:  {converter_name}")
    print("=" * 60)
    print(f"\n  {'필터':<35} {'원본':>8} {'변환':>8} {'스킵':>8} {'비율':>6}")
    print("  " + "-" * 70)
    for r in all_results:
        if r["status"] == "OK":
            pct = f"{r['converted'] / max(r['raw'], 1) * 100:.0f}%"
            print(f"  {r['name']:<35} {r['raw']:>8,} {r['converted']:>8,} "
                  f"{r['skipped']:>8,} {pct:>6}")
        else:
            print(f"  {r['name']:<35} {'FAIL':>8}")
    print()

if __name__ == "__main__":
    main()
