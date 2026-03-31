import re
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

sys.stdout.reconfigure(encoding="utf-8")

DANAWA_SEARCH_URL = "https://search.danawa.com/dsearch.php?query={query}"

# 가격 요소 선택자 후보 (다나와 DOM 구조 기준)
PRICE_SELECTORS = [
    ".price_sect strong",           # 최저가 메인 표시
    ".low_price strong",            # 최저가 블록
    ".pricelist-lowest strong",     # 가격 리스트 최저가
    "span.txt_price",               # 가격 텍스트
]

PRODUCT_NAME_SELECTORS = [
    ".prod_name a",
    ".prod_info .prod_name",
    "p.prod_name a",
]


def parse_price(text: str) -> int | None:
    """'1,234,000원' 형태의 문자열에서 숫자만 추출"""
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else None


def get_danawa_lowest_price(model_name: str, headless: bool = True) -> dict | None:
    """
    다나와 검색 결과 첫 번째 상품의 최저가를 Playwright로 추출합니다.

    Args:
        model_name: 검색할 모델명
        headless: 브라우저 headless 모드 여부 (디버깅 시 False)

    Returns:
        {
            "model": 검색어,
            "product_name": 상품명,
            "lowest_price": 최저가 (int, 원),
            "source": "danawa",
        }
        실패 시 None
    """
    url = DANAWA_SEARCH_URL.format(query=model_name)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="ko-KR",
        )
        page = context.new_page()

        try:
            print(f"  접속 중: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)

            # 동적 로딩 대기 전략 1: 가격 선택자가 나타날 때까지 순차 시도
            price_text = None
            matched_selector = None

            for selector in PRICE_SELECTORS:
                try:
                    page.wait_for_selector(selector, timeout=8_000)
                    el = page.query_selector(selector)
                    if el:
                        price_text = el.inner_text().strip()
                        matched_selector = selector
                        break
                except PlaywrightTimeoutError:
                    continue

            # 전략 2: 네트워크 idle 후 재시도
            if not price_text:
                page.wait_for_load_state("networkidle", timeout=15_000)
                for selector in PRICE_SELECTORS:
                    el = page.query_selector(selector)
                    if el:
                        price_text = el.inner_text().strip()
                        matched_selector = selector
                        break

            if not price_text:
                print("  [경고] 가격 요소를 찾지 못했습니다.")
                return None

            lowest_price = parse_price(price_text)
            if not lowest_price:
                print(f"  [경고] 가격 파싱 실패: '{price_text}'")
                return None

            # 상품명 추출
            product_name = "알 수 없음"
            for selector in PRODUCT_NAME_SELECTORS:
                el = page.query_selector(selector)
                if el:
                    product_name = el.inner_text().strip()
                    break

            return {
                "model": model_name,
                "product_name": product_name,
                "lowest_price": lowest_price,
                "matched_selector": matched_selector,
                "source": "danawa",
            }

        except PlaywrightTimeoutError:
            print("  [오류] 페이지 로딩 타임아웃")
            return None
        except Exception as e:
            print(f"  [오류] {e}")
            return None
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    # 방법 1: 커맨드라인 인수
    #   python danawa_scraper.py "갤럭시 S24"
    #   python danawa_scraper.py "갤럭시 S24" "아이폰 16 Pro"
    # 방법 2: 인수 없이 실행하면 직접 입력 프롬프트
    if len(sys.argv) > 1:
        models = sys.argv[1:]
    else:
        raw = input("검색할 모델명 입력 (여러 개는 쉼표로 구분): ").strip()
        models = [m.strip() for m in raw.split(",") if m.strip()]

    if not models:
        print("검색어를 입력해주세요.")
        sys.exit(1)

    for model in models:
        print(f"\n[검색] {model}")
        result = get_danawa_lowest_price(model)

        if result:
            print(f"  최저가  : {result['lowest_price']:,}원")
            print(f"  상품명  : {result['product_name']}")
            print(f"  출처    : {result['source']}")
        else:
            print("  결과를 가져오지 못했습니다.")
