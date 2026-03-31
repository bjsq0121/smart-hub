"""
네이버 쇼핑 + 다나와 통합 최저가 검색기
사용법:
  python price_search.py "갤럭시 S24"
  python price_search.py "갤럭시 S24" "아이폰 16 Pro"   # 여러 개
  python price_search.py                                 # 직접 입력 프롬프트
"""

import sys
import re
import os
import concurrent.futures
import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()

# ──────────────────────────────────────────
# 네이버 쇼핑 API
# ──────────────────────────────────────────

NAVER_CLIENT_ID = os.getenv("NAVER_CLIENT_ID")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET")
NAVER_SEARCH_URL = "https://openapi.naver.com/v1/search/shop.json"


def _naver_get_lowest_price(model_name: str) -> dict | None:
    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        raise EnvironmentError(".env에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET을 설정해주세요.")

    headers = {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    }
    # sort=sim(관련도순)으로 가져와 카테고리 필터 적용
    params = {"query": model_name, "display": 20, "sort": "sim"}

    resp = requests.get(NAVER_SEARCH_URL, headers=headers, params=params, timeout=10)
    resp.raise_for_status()

    items = resp.json().get("items", [])
    if not items:
        return None

    def parse_price(item):
        try:
            return int(item.get("lprice", 0))
        except (ValueError, TypeError):
            return 0

    valid = [i for i in items if parse_price(i) > 0]
    if not valid:
        return None

    # 가장 많이 등장하는 category2(중분류)를 주요 카테고리로 판단 후 필터링
    from collections import Counter
    cat_counts = Counter(i.get("category2", "") for i in valid if i.get("category2"))
    if cat_counts:
        main_category = cat_counts.most_common(1)[0][0]
        filtered = [i for i in valid if i.get("category2") == main_category]
    else:
        filtered = valid

    cheapest = min(filtered, key=parse_price)
    lowest_price = parse_price(cheapest)
    title = re.sub(r"<[^>]+>", "", cheapest.get("title", ""))

    return {
        "source": "네이버쇼핑",
        "product_name": title,
        "lowest_price": lowest_price,
        "mall_name": cheapest.get("mallName", ""),
        "link": cheapest.get("link", ""),
        "image": cheapest.get("image", ""),
        "category": main_category if cat_counts else "",
    }


# ──────────────────────────────────────────
# 다나와 Playwright 스크래퍼
# ──────────────────────────────────────────

DANAWA_SEARCH_URL = "https://search.danawa.com/dsearch.php?query={query}"

PRICE_SELECTORS = [
    ".price_sect strong",
    ".low_price strong",
    ".pricelist-lowest strong",
    "span.txt_price",
]
PRODUCT_NAME_SELECTORS = [
    ".prod_name a",
    ".prod_info .prod_name",
    "p.prod_name a",
]
PRODUCT_IMAGE_SELECTORS = [
    "img.img_130",
    "img.img_110",
    ".thumb_wrap img",
    ".prod_thumb img",
    "li.prod_item .thumb a img",
]


def _danawa_get_lowest_price(model_name: str) -> dict | None:
    url = DANAWA_SEARCH_URL.format(query=model_name)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
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
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)

            price_text = None
            for selector in PRICE_SELECTORS:
                try:
                    page.wait_for_selector(selector, timeout=8_000)
                    el = page.query_selector(selector)
                    if el:
                        price_text = el.inner_text().strip()
                        break
                except PlaywrightTimeoutError:
                    continue

            if not price_text:
                page.wait_for_load_state("networkidle", timeout=15_000)
                for selector in PRICE_SELECTORS:
                    el = page.query_selector(selector)
                    if el:
                        price_text = el.inner_text().strip()
                        break

            if not price_text:
                return None

            digits = re.sub(r"[^\d]", "", price_text)
            lowest_price = int(digits) if digits else None
            if not lowest_price:
                return None

            product_name = "알 수 없음"
            for selector in PRODUCT_NAME_SELECTORS:
                el = page.query_selector(selector)
                if el:
                    product_name = el.inner_text().strip()
                    break

            # 이미지 추출
            image = ""
            for selector in PRODUCT_IMAGE_SELECTORS:
                el = page.query_selector(selector)
                if el:
                    src = el.get_attribute("src") or el.get_attribute("data-src") or ""
                    if src and not src.endswith("gif"):
                        image = src if src.startswith("http") else "https:" + src
                        break

            return {
                "source": "다나와",
                "product_name": product_name,
                "lowest_price": lowest_price,
                "mall_name": "",
                "image": image,
                "link": url,
            }

        except Exception:
            return None
        finally:
            context.close()
            browser.close()


# ──────────────────────────────────────────
# 통합 검색 (네이버 + 다나와 병렬 실행)
# ──────────────────────────────────────────

def search_all(model_name: str) -> list[dict]:
    """
    네이버 쇼핑과 다나와를 동시에 조회해 결과 리스트를 반환합니다.
    각 결과는 {"source", "product_name", "lowest_price", "mall_name", "link"} 구조입니다.
    """
    results = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = {
            executor.submit(_naver_get_lowest_price, model_name): "네이버쇼핑",
            executor.submit(_danawa_get_lowest_price, model_name): "다나와",
        }
        for future, source in futures.items():
            try:
                result = future.result()
                if result:
                    results.append(result)
            except Exception as e:
                print(f"  [{source}] 오류: {e}")

    # 가격 오름차순 정렬
    results.sort(key=lambda r: r["lowest_price"])
    return results


def print_results(model_name: str, results: list[dict]):
    print(f"\n{'━'*50}")
    print(f"  검색어: {model_name}")
    print(f"{'━'*50}")

    if not results:
        print("  결과 없음")
        return

    for i, r in enumerate(results):
        tag = " ★ 최저가" if i == 0 else ""
        print(f"\n  [{r['source']}]{tag}")
        print(f"  가격    : {r['lowest_price']:,}원")
        print(f"  상품명  : {r['product_name']}")
        if r["mall_name"]:
            print(f"  판매처  : {r['mall_name']}")
        print(f"  링크    : {r['link']}")

    if len(results) >= 2:
        diff = results[-1]["lowest_price"] - results[0]["lowest_price"]
        print(f"\n  사이트간 가격차: {diff:,}원 ({results[0]['source']}이 더 저렴)")

    print(f"{'━'*50}")


# ──────────────────────────────────────────
# 진입점
# ──────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) > 1:
        models = sys.argv[1:]
    else:
        raw = input("검색할 모델명 입력 (여러 개는 쉼표로 구분): ").strip()
        models = [m.strip() for m in raw.split(",") if m.strip()]

    if not models:
        print("검색어를 입력해주세요.")
        sys.exit(1)

    for model in models:
        results = search_all(model)
        print_results(model, results)
