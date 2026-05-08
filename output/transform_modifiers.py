import re

# 도메인의 "단어 경계"에 맞춰 매칭하도록 패턴화
# 점(.), 하이픈(-), 시작/끝을 단어 경계로 처리
LOG_WORDS = [
    'log', 'logs', 'logging',
    'telemetry', 'telem',
    'analytics', 'analytic',
    'stats', 'statistic', 'statistics',
    'metrics', 'metric',
    'track', 'tracker', 'tracking',
    'report', 'reports', 'reporting',
    'crash', 'crashes', 'crashlytics',
    'beacon', 'pings', 'collect',
    'event', 'events',
]

AD_WORDS = [
    'ads', 'adserver', 'adservice', 'adsystem', 'adnxs',
    'doubleclick', 'googleads', 'googlesyndication',
    'pop', 'popup', 'popunder',
    'pixel', 'pixels',
    'banner', 'banners',
    'promo', 'promoted',
    'sponsor', 'sponsored',
    'affiliate', 'partner',
    'taboola', 'outbrain', 'criteo',
]

# AD_WORDS 중 단독 'ad'는 너무 위험하므로 제외
# 대신 'ad-', 'ad.', '-ad-', '.ad.', '.ads.' 같은 명확한 패턴만 사용

def extract_domain(rule):
    """||domain.com^ 형태에서 domain.com만 추출"""
    m = re.match(r'^\|\|([a-z0-9\-\.]+)\^', rule.lower())
    return m.group(1) if m else None


def is_word_in_domain(word, domain):
    """
    도메인에서 '단어 경계'를 고려한 매칭.
    'log' 검색 시:
    - logs.netflix.com  → True (시작이 log)
    - applogs.com       → True (-log 또는 .log)
    - blog.com          → False (b가 앞에 붙어 다른 단어)
    """
    # 도메인을 '.' 와 '-' 로 분할해서 각 토큰을 검사
    tokens = re.split(r'[.\-_]', domain)
    
    # 정확히 일치하거나, 토큰이 word로 시작하거나 끝나면 매칭
    for token in tokens:
        if token == word:
            return True
        # 'logs', 'logging' 같은 변형 허용
        if token.startswith(word) and len(token) <= len(word) + 4:
            return True
    return False


def classify_domain(domain):
    """도메인을 LOG / AD / GENERIC 으로 분류"""
    # 1순위: 로그/분석 (앱이 응답을 받아야 함)
    for word in LOG_WORDS:
        if is_word_in_domain(word, domain):
            return 'LOG'
    
    # 2순위: 명확한 광고 (NXDOMAIN 안전)
    for word in AD_WORDS:
        if is_word_in_domain(word, domain):
            return 'AD'
    
    return 'GENERIC'


def transform_filters(input_file, output_file):
    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    transformed = []
    stats = {'LOG': 0, 'AD': 0, 'GENERIC': 0, 'SKIPPED': 0}
    
    for raw_line in lines:
        line = raw_line.rstrip('\n')
        stripped = line.strip()
        
        # 주석/빈 줄/예외규칙(@@)은 그대로
        if not stripped or stripped.startswith(('!', '#', '@@', '[')):
            transformed.append(line)
            continue
        
        # ||domain^ 형식 아니면 스킵
        if not stripped.startswith('||') or not stripped.endswith('^'):
            transformed.append(line)
            stats['SKIPPED'] += 1
            continue
        
        # 이미 modifier 붙어있으면 그대로
        if '$' in stripped:
            transformed.append(line)
            stats['SKIPPED'] += 1
            continue
        
        domain = extract_domain(stripped)
        if not domain:
            transformed.append(line)
            stats['SKIPPED'] += 1
            continue
        
        category = classify_domain(domain)
        
        if category == 'LOG':
            transformed.append(f"{stripped}$empty")
            stats['LOG'] += 1
        elif category == 'AD':
            transformed.append(f"{stripped}$dnsrewrite=NXDOMAIN")
            stats['AD'] += 1
        else:
            transformed.append(line)
            stats['GENERIC'] += 1

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(transformed))
        f.write('\n')

    print(f"변환 완료: {output_file}")
    print(f"  $empty (LOG)      : {stats['LOG']:,}")
    print(f"  $dnsrewrite (AD)  : {stats['AD']:,}")
    print(f"  표준 차단 (GENERIC): {stats['GENERIC']:,}")
    print(f"  스킵              : {stats['SKIPPED']:,}")


if __name__ == "__main__":
    transform_filters('Block_DNS.txt', 'Block_DNS_Modified.txt')
