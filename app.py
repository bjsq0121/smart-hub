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
