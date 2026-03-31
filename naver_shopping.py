import os
import requests
from dotenv import load_dotenv

load_dotenv()

NAVER_CLIENT_ID = os.getenv("NAVER_CLIENT_ID")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET")

SEARCH_URL = "https://openapi.naver.com/v1/search/shop.json"


def get_lowest_price(model_name: str, display: int = 10) -> dict | None:
    """
    네이버 쇼핑 검색 API로 특정 모델명의 최저가 상품을 반환합니다.

    Args:
        model_name: 검색할 모델명 (예: "갤럭시 S24", "아이폰 16 Pro")
        display: 검색 결과 수 (최대 100, 기본 10)

    Returns:
        {
            "model": 검색어,
            "lowest_price": 최저가 (int, 원),
            "title": 상품명,
            "link": 상품 링크,
            "image": 이미지 URL,
            "mall_name": 판매처,
        }
        결과가 없으면 None 반환
    """
    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        raise EnvironmentError(
            ".env 파일에 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 설정해주세요."
        )

    headers = {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    }
    params = {
        "query": model_name,
        "display": min(display, 100),
        "sort": "asc",  # 가격 오름차순 → 첫 번째 항목이 최저가
    }

    response = requests.get(SEARCH_URL, headers=headers, params=params, timeout=10)
    response.raise_for_status()

    items = response.json().get("items", [])
    if not items:
        return None

    # lprice(최저가), hprice(최고가) 중 lprice 기준 정렬 후 최솟값 선택
    def parse_price(item):
        try:
            return int(item.get("lprice", 0))
        except (ValueError, TypeError):
            return 0

    cheapest = min(items, key=parse_price)
    lowest_price = parse_price(cheapest)

    if lowest_price == 0:
        return None

    # HTML 태그 제거 (네이버 API는 title에 <b> 태그 포함)
    import re
    title = re.sub(r"<[^>]+>", "", cheapest.get("title", ""))

    return {
        "model": model_name,
        "lowest_price": lowest_price,
        "title": title,
        "link": cheapest.get("link", ""),
        "image": cheapest.get("image", ""),
        "mall_name": cheapest.get("mallName", ""),
    }


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    test_models = ["갤럭시 S24", "아이폰 16 Pro", "LG 그램 16"]

    for model in test_models:
        print(f"\n[검색] {model}")
        try:
            result = get_lowest_price(model)
            if result:
                print(f"  최저가  : {result['lowest_price']:,}원")
                print(f"  상품명  : {result['title']}")
                print(f"  판매처  : {result['mall_name']}")
                print(f"  링크    : {result['link']}")
            else:
                print("  검색 결과 없음")
        except Exception as e:
            print(f"  오류: {e}")
