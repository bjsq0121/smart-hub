import sys
import asyncio
import concurrent.futures
import os
import re
import json
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
GCP_PROJECT         = os.getenv("GCP_PROJECT", "smarthub-9cd05")
GCP_REGION          = os.getenv("GCP_REGION", "us-central1")
TELEGRAM_TOKEN      = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID    = os.getenv("TELEGRAM_CHAT_ID", "")

AI_NEWS_KEYWORDS = {
    "AI 동향":   ["인공지능 AI 최신", "ChatGPT LLM 생성형AI", "AI 반도체 엔비디아"],
    "해외 주식": ["나스닥 뉴욕증시 오늘", "미국 주식 S&P500", "해외 주식 투자 전망"],
    "국내 주식": ["코스피 코스닥 오늘", "삼성전자 SK하이닉스 주가", "국내 증시 전망"],
}

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


@app.get("/ai-news")
async def ai_news(category: str = Query(default="AI 동향")):
    if not NAVER_CLIENT_ID:
        return {"error": "네이버 API 키가 설정되지 않았습니다."}

    keywords = AI_NEWS_KEYWORDS.get(category, ["AI 인공지능"])

    # 여러 키워드로 뉴스 수집 후 중복 제거
    all_items = []
    for kw in keywords:
        try:
            items = _fetch_naver_news(kw, display=15)
            all_items.extend(items)
        except Exception:
            pass

    seen, unique_items = set(), []
    for item in all_items:
        title = _strip_html(item.get("title", ""))
        if title and title not in seen:
            seen.add(title)
            unique_items.append(item)

    if not unique_items:
        return {"error": "뉴스를 가져올 수 없습니다."}

    # Gemini 프롬프트 구성 (최대 10개 기사 — 토큰 절약)
    news_text = "\n".join([
        f"{i+1}. {_strip_html(item.get('title',''))}"
        for i, item in enumerate(unique_items[:10])
    ])

    prompt = f"""다음은 [{category}] 관련 최신 뉴스 제목 목록입니다.

{news_text}

아래 JSON 형식으로만 응답하세요. 각 문자열은 한 문장으로 짧게 작성하세요.
{{"headline":"전체동향한문장","points":[{{"title":"이슈제목","summary":"한두문장설명","sentiment":"긍정"}},{{"title":"이슈제목","summary":"한두문장설명","sentiment":"부정"}},{{"title":"이슈제목","summary":"한두문장설명","sentiment":"중립"}}],"outlook":"전망한문장"}}
sentiment는 반드시 긍정/부정/중립 중 하나. points는 정확히 3개."""

    try:
        import vertexai
        from vertexai.generative_models import GenerativeModel, GenerationConfig

        vertexai.init(project=GCP_PROJECT, location=GCP_REGION)
        model = GenerativeModel("gemini-2.5-flash")

        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            response = await loop.run_in_executor(
                ex,
                lambda: model.generate_content(
                    prompt,
                    generation_config=GenerationConfig(
                        temperature=0.2,
                        max_output_tokens=8192,
                        response_mime_type="application/json",
                    ),
                )
            )

        raw = response.text.strip()
        # JSON 블록 추출 (혹시라도 마크다운이 섞인 경우 대비)
        import re as _re
        m = _re.search(r'\{.*\}', raw, _re.DOTALL)
        if not m:
            return {"error": f"JSON 파싱 실패. 원본: {raw[:200]}"}
        summary = json.loads(m.group())
        return {"category": category, "summary": summary, "article_count": len(unique_items)}

    except Exception as e:
        return {"error": f"AI 요약 생성 중 오류: {e}"}


def _send_telegram(message: str):
    """텔레그램 메시지 전송 (MarkdownV2)"""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        raise ValueError("TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID가 설정되지 않았습니다.")
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    resp = requests.post(url, json={
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _format_telegram_message(category: str, summary: dict, article_count: int) -> str:
    """요약 결과를 텔레그램 HTML 메시지로 포맷팅"""
    kst = datetime.now(timezone(timedelta(hours=9)))
    date_str = kst.strftime("%Y년 %m월 %d일 %H:%M")

    sentiment_icon = {"긍정": "📈", "부정": "📉", "중립": "➡️"}
    cat_icon = {"AI 동향": "🧠", "해외 주식": "🌎", "국내 주식": "🇰🇷"}

    icon = cat_icon.get(category, "📰")
    lines = [
        f"{icon} <b>[{category}] AI 뉴스 브리핑</b>",
        f"<i>{date_str} · 분석 기사 {article_count}건</i>",
        "",
        f"📡 <b>{summary.get('headline', '')}</b>",
        "",
    ]

    for p in summary.get("points", []):
        icon_s = sentiment_icon.get(p.get("sentiment", "중립"), "➡️")
        lines.append(f"{icon_s} <b>{p.get('title', '')}</b>")
        lines.append(f"   {p.get('summary', '')}")
        lines.append("")

    lines.append(f"🔭 <b>전망</b>: {summary.get('outlook', '')}")
    lines.append("")
    lines.append("─────────────────")
    lines.append("🤖 <i>Powered by Gemini 2.5 Flash · Smart Hub</i>")

    return "\n".join(lines)


@app.post("/scheduler/ainews")
async def scheduler_ainews():
    """Cloud Scheduler가 호출하는 엔드포인트 — AI 뉴스 요약 후 텔레그램 전송"""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return {"error": "텔레그램 설정이 없습니다."}

    results = []
    for category in AI_NEWS_KEYWORDS.keys():
        # /ai-news 로직 재사용
        news_data = await ai_news(category=category)
        if "error" in news_data:
            results.append({"category": category, "status": "error", "detail": news_data["error"]})
            continue

        msg = _format_telegram_message(category, news_data["summary"], news_data["article_count"])
        try:
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as ex:
                await loop.run_in_executor(ex, lambda m=msg: _send_telegram(m))
            results.append({"category": category, "status": "sent"})
        except Exception as e:
            results.append({"category": category, "status": "error", "detail": str(e)})

    return {"results": results}


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
            price_raw = t("dealAmount").replace(",", "").replace(" ", "")
            try:
                price = int(price_raw)
            except ValueError:
                price = 0

            items.append({
                "apt_name":   t("aptNm"),
                "apt_dong":   t("aptDong"),
                "dong":       t("umdNm"),
                "floor":      t("floor"),
                "area":       t("excluUseAr"),
                "price":      price,
                "price_str":  t("dealAmount").strip(),
                "year":       t("dealYear"),
                "month":      t("dealMonth"),
                "day":        t("dealDay"),
                "build_year": t("buildYear"),
                "deal_type":  t("dealingGbn"),
            })

        items.sort(key=lambda x: x["price"], reverse=True)
        return {"lawd_cd": lawd_cd, "deal_ymd": deal_ymd, "total": len(items), "items": items}

    except Exception as e:
        return {"error": f"데이터 파싱 오류: {e}"}
