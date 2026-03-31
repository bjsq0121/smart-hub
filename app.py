import sys
import asyncio
import concurrent.futures
import os
import re
import requests
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()
sys.stdout.reconfigure(encoding="utf-8")

from price_search import _naver_get_lowest_price, _danawa_get_lowest_price

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

NAVER_CLIENT_ID     = os.getenv("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET", "")
MOLIT_API_KEY       = os.getenv("MOLIT_API_KEY", "")

CATEGORY_KEYWORDS = {
    "전체":   "오늘 뉴스",
    "정치":   "정치",
    "경제":   "경제",
    "사회":   "사회",
    "문화":   "문화 연예",
    "스포츠": "스포츠",
    "IT":     "IT 과학 기술",
}


class SearchRequest(BaseModel):
    query: str


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).replace("&quot;", '"').replace("&amp;", "&").replace("&#39;", "'").strip()


def _fetch_naver_news(keyword: str, display: int = 30) -> list[dict]:
    url = "https://openapi.naver.com/v1/search/news.json"
    headers = {
        "X-Naver-Client-Id":     NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    }
    params = {"query": keyword, "display": display, "sort": "date"}
    resp = requests.get(url, headers=headers, params=params, timeout=8)
    resp.raise_for_status()
    return resp.json().get("items", [])


@app.get("/", response_class=HTMLResponse)
async def index():
    with open("index.html", encoding="utf-8") as f:
        return f.read()


@app.post("/search")
async def search(req: SearchRequest):
    query = req.query.strip()
    if not query:
        return {"error": "검색어를 입력해주세요."}

    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        naver_future = loop.run_in_executor(executor, _naver_get_lowest_price, query)
        danawa_future = loop.run_in_executor(executor, _danawa_get_lowest_price, query)
        naver_result, danawa_result = await asyncio.gather(
            naver_future, danawa_future, return_exceptions=True
        )

    results = []
    for r in [naver_result, danawa_result]:
        if isinstance(r, Exception) or r is None:
            continue
        results.append(r)

    results.sort(key=lambda r: r["lowest_price"])
    return {"query": query, "results": results}


@app.get("/news")
async def news(
    date: str = Query(default="", description="YYYY-MM-DD"),
    category: str = Query(default="전체"),
):
    if not NAVER_CLIENT_ID:
        return {"error": "네이버 API 키가 설정되지 않았습니다."}

    keyword = CATEGORY_KEYWORDS.get(category, "오늘 뉴스")

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            items = await loop.run_in_executor(ex, _fetch_naver_news, keyword, 50)
    except Exception as e:
        return {"error": f"뉴스를 가져오는 중 오류가 발생했습니다: {e}"}

    # 날짜 필터: pubDate 파싱 후 KST 기준 비교
    kst = timezone(timedelta(hours=9))
    target_date = None
    if date:
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            pass

    news_list = []
    for item in items:
        pub_raw = item.get("pubDate", "")
        try:
            pub_dt = datetime.strptime(pub_raw, "%a, %d %b %Y %H:%M:%S %z").astimezone(kst)
        except Exception:
            pub_dt = None

        if target_date and pub_dt and pub_dt.date() != target_date:
            continue

        news_list.append({
            "title":       _strip_html(item.get("title", "")),
            "description": _strip_html(item.get("description", "")),
            "link":        item.get("originallink") or item.get("link", ""),
            "pub_date":    pub_dt.strftime("%Y-%m-%d %H:%M") if pub_dt else pub_raw,
        })

    return {"date": date or datetime.now(kst).strftime("%Y-%m-%d"), "category": category, "items": news_list}


@app.get("/realestate")
async def realestate(
    lawd_cd: str = Query(..., description="시군구코드 5자리"),
    deal_ymd: str = Query(..., description="계약년월 YYYYMM"),
):
    if not MOLIT_API_KEY:
        return {"error": "국토교통부 API 키가 설정되지 않았습니다. .env 파일에 MOLIT_API_KEY를 입력해주세요."}

    # serviceKey를 params에 넣으면 requests가 이중 인코딩하여 401 발생 → URL에 직접 삽입
    url = (
        f"https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev"
        f"?serviceKey={MOLIT_API_KEY}&pageNo=1&numOfRows=1000&LAWD_CD={lawd_cd}&DEAL_YMD={deal_ymd}"
    )

    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"API 호출 오류: {e}"}

    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(resp.text)

        result_code = root.findtext(".//resultCode", "")
        if result_code not in ("00", "OK", "0000", "000"):
            msg = root.findtext(".//resultMsg", "알 수 없는 오류")
            return {"error": f"API 오류 ({result_code}): {msg}"}

        items = []
        for item in root.findall(".//item"):
            def t(tag): return (item.findtext(tag) or "").strip()
            price_raw = t("거래금액").replace(",", "").replace(" ", "")
            try:
                price = int(price_raw)
            except ValueError:
                price = 0

            items.append({
                "apt_name":   t("아파트"),
                "dong":       t("법정동"),
                "floor":      t("층"),
                "area":       t("전용면적"),
                "price":      price,
                "price_str":  t("거래금액").strip(),
                "year":       t("년"),
                "month":      t("월"),
                "day":        t("일"),
                "build_year": t("건축년도"),
                "deal_type":  t("거래유형"),
            })

        items.sort(key=lambda x: x["price"], reverse=True)
        return {"lawd_cd": lawd_cd, "deal_ymd": deal_ymd, "total": len(items), "items": items}

    except Exception as e:
        return {"error": f"데이터 파싱 오류: {e}"}
