import sys
import asyncio
import concurrent.futures
import os
import re
import json
import requests
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Query, Request, Header, HTTPException, Depends
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()
sys.stdout.reconfigure(encoding="utf-8")

from price_search import _naver_get_lowest_price, _danawa_get_lowest_price

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://banghub.kr", "https://www.banghub.kr",
        "https://smarthub-9cd05.web.app", "https://smarthub-9cd05.firebaseapp.com",
        "http://localhost:8000",
    ],
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ── 보안: Firebase ID 토큰 검증 ──────────────────────────────
import google.auth.transport.requests as _g_requests
from google.oauth2 import id_token as _g_id_token

_FIREBASE_PROJECT_ID = os.getenv("GCP_PROJECT", "smarthub-9cd05")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")


async def verify_firebase_token(authorization: str = Header(default="")) -> dict:
    """Firebase ID 토큰 검증. 인증 필요 API에 Depends로 사용."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="인증이 필요합니다.")
    token = authorization[7:]
    try:
        decoded = _g_id_token.verify_firebase_token(
            token, _g_requests.Request(), audience=_FIREBASE_PROJECT_ID
        )
        return decoded
    except Exception:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")


def verify_webhook_secret(x_webhook_secret: str = Header(default="")):
    """웹훅 시크릿 키 검증. 시크릿 미설정이면 차단."""
    if not WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="웹훅 시크릿이 설정되지 않았습니다.")
    if x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="웹훅 인증 실패.")

NAVER_CLIENT_ID     = os.getenv("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET", "")
MOLIT_API_KEY       = os.getenv("MOLIT_API_KEY", "")
GCP_PROJECT         = os.getenv("GCP_PROJECT", "smarthub-9cd05")
GCP_REGION          = os.getenv("GCP_REGION", "us-central1")
TELEGRAM_TOKEN      = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID    = os.getenv("TELEGRAM_CHAT_ID", "")
KIS_APP_KEY         = os.getenv("KIS_APP_KEY", "")
KIS_APP_SECRET      = os.getenv("KIS_APP_SECRET", "")
KIS_BASE_URL        = "https://openapi.koreainvestment.com:9443"

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
async def ai_news(category: str = Query(default="AI 동향"), user: dict = Depends(verify_firebase_token)):
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

    # 상위 15개 기사에서 제목+본문발췌+링크 추출
    articles_for_ai = unique_items[:15]
    news_text = "\n".join([
        f"{i+1}. 제목: {_strip_html(item.get('title',''))}\n   내용: {_strip_html(item.get('description',''))[:200]}"
        for i, item in enumerate(articles_for_ai)
    ])

    # 원본 링크 맵 (Gemini 응답과 매칭용)
    article_links = [
        {"title": _strip_html(item.get("title", "")),
         "link": item.get("originallink") or item.get("link", ""),
         "description": _strip_html(item.get("description", ""))[:300]}
        for item in articles_for_ai
    ]

    prompt = f"""다음은 [{category}] 관련 최신 뉴스 제목과 본문 발췌입니다.

{news_text}

아래 JSON 형식으로만 응답하세요.
{{"headline":"전체 동향 요약 (2~3문장)","points":[{{"title":"기사 제목 (원문 그대로)","summary":"3~4문장으로 핵심 맥락과 배경을 설명","sentiment":"긍정","index":0}}],"outlook":"향후 전망 2~3문장"}}

규칙:
- points는 정확히 10개. 가장 중요한 기사 10개를 선별.
- index는 입력 기사의 번호(0부터 시작). 원본 기사와 매칭에 사용.
- summary는 단순 제목 반복이 아니라, 기사 내용의 맥락·배경·영향을 3~4문장으로 설명.
- sentiment는 반드시 긍정/부정/중립 중 하나.
- headline과 outlook도 구체적으로 2~3문장씩 작성."""

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
            return {"error": "AI 응답을 처리하지 못했습니다."}
        summary = json.loads(m.group())
        # points에 원본 링크 매칭
        for p in summary.get("points", []):
            idx = p.get("index")
            if idx is not None and 0 <= idx < len(article_links):
                p["link"] = article_links[idx]["link"]
                p["original_title"] = article_links[idx]["title"]
            else:
                # index 없으면 제목으로 매칭 시도
                for al in article_links:
                    if al["title"] and al["title"][:10] in p.get("title", ""):
                        p["link"] = al["link"]
                        p["original_title"] = al["title"]
                        break
        return {"category": category, "summary": summary, "articles": article_links, "article_count": len(unique_items)}

    except Exception as e:
        return {"error": "AI 요약 생성 중 오류가 발생했습니다."}


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


@app.post("/scheduler/ainews", dependencies=[Depends(verify_webhook_secret)])
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


# ── KIS API ──────────────────────────────────────────────
import time as _time

_kis_token_cache = {"token": None, "expires_at": 0}
_stock_cache: dict = {}
STOCK_CACHE_TTL = 1800  # 30분
_KIS_TOKEN_FILE = "/tmp/kis_token.json"


def _save_token_to_file(token: str, expires_at: float):
    """토큰을 파일에 저장 (Cloud Run 콜드스타트 대비)"""
    try:
        with open(_KIS_TOKEN_FILE, "w") as f:
            json.dump({"token": token, "expires_at": expires_at}, f)
    except Exception:
        pass


def _load_token_from_file() -> tuple[str | None, float]:
    """파일에서 토큰 복원"""
    try:
        with open(_KIS_TOKEN_FILE) as f:
            data = json.load(f)
            return data.get("token"), data.get("expires_at", 0)
    except Exception:
        return None, 0


def _get_kis_token() -> str:
    now = _time.time()
    # 1) 메모리 캐시
    if _kis_token_cache["token"] and now < _kis_token_cache["expires_at"] - 60:
        return _kis_token_cache["token"]
    # 2) 파일 캐시 (콜드스타트 복원)
    file_token, file_exp = _load_token_from_file()
    if file_token and now < file_exp - 60:
        _kis_token_cache["token"] = file_token
        _kis_token_cache["expires_at"] = file_exp
        return file_token
    # 3) 신규 발급
    resp = requests.post(
        f"{KIS_BASE_URL}/oauth2/tokenP",
        json={"grant_type": "client_credentials", "appkey": KIS_APP_KEY, "appsecret": KIS_APP_SECRET},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if "access_token" not in data:
        raise ValueError(f"토큰 발급 실패: {data.get('error_description', data)}")
    token = data["access_token"]
    expires_at = now + int(data.get("expires_in", 86400))
    _kis_token_cache["token"] = token
    _kis_token_cache["expires_at"] = expires_at
    _save_token_to_file(token, expires_at)
    return token


def _kis_headers(tr_id: str) -> dict:
    return {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": f"Bearer {_get_kis_token()}",
        "appkey": KIS_APP_KEY,
        "appsecret": KIS_APP_SECRET,
        "tr_id": tr_id,
    }


# 주요 종목 코드 (거래량 상위 API가 장 마감 후 빈 결과를 반환할 때 fallback)
_MAJOR_STOCKS = {
    "KOSPI": [
        ("005930", "삼성전자"), ("000660", "SK하이닉스"), ("373220", "LG에너지솔루션"),
        ("005380", "현대차"), ("000270", "기아"), ("068270", "셀트리온"),
        ("207940", "삼성바이오로직스"), ("005490", "POSCO홀딩스"), ("035420", "NAVER"),
        ("055550", "신한지주"), ("105560", "KB금융"), ("006400", "삼성SDI"),
        ("003670", "포스코퓨처엠"), ("051910", "LG화학"), ("028260", "삼성물산"),
        ("086790", "하나금융지주"), ("034730", "SK"), ("032830", "삼성생명"),
        ("012330", "현대모비스"), ("066570", "LG전자"), ("003550", "LG"),
        ("096770", "SK이노베이션"), ("010130", "고려아연"), ("033780", "KT&G"),
        ("015760", "한국전력"), ("034020", "두산에너빌리티"), ("009150", "삼성전기"),
        ("018260", "삼성에스디에스"), ("000810", "삼성화재"), ("011200", "HMM"),
    ],
    "KOSDAQ": [
        ("247540", "에코프로비엠"), ("091990", "셀트리온헬스케어"), ("196170", "알테오젠"),
        ("068760", "셀트리온제약"), ("041510", "에스엠"), ("263750", "펄어비스"),
        ("112040", "위메이드"), ("035760", "CJ ENM"), ("086520", "에코프로"),
        ("005070", "코스모신소재"), ("099190", "아이센스"), ("145020", "휴젤"),
        ("028300", "HLB"), ("039030", "이오테크닉스"), ("377300", "카카오페이"),
        ("036570", "엔씨소프트"), ("293490", "카카오게임즈"), ("058470", "리노공업"),
        ("323410", "카카오뱅크"), ("357780", "솔브레인"), ("383220", "F&F"),
        ("352820", "하이브"), ("403870", "HPSP"), ("042700", "한미반도체"),
        ("009520", "포스코엠텍"), ("095340", "ISC"), ("222160", "NPX반도체"),
        ("240810", "원익IPS"), ("108320", "LX세미콘"), ("060310", "3S"),
    ],
}


def _fetch_volume_rank(market: str) -> list[dict]:
    mrkt_code = "J" if market.upper() == "KOSPI" else "Q"
    params = {
        "FID_COND_MRKT_DIV_CODE": mrkt_code,
        "FID_COND_SCR_DIV_CODE": "20101",
        "FID_INPUT_ISCD": "0000" if mrkt_code == "J" else "0001",
        "FID_DIV_CLS_CODE": "0",
        "FID_BLNG_CLS_CODE": "0",
        "FID_TRGT_CLS_CODE": "111111111",
        "FID_TRGT_EXLS_CLS_CODE": "000000",
        "FID_INPUT_PRICE_1": "",
        "FID_INPUT_PRICE_2": "",
        "FID_VOL_CNT": "",
        "FID_INPUT_DATE_1": "",
    }
    try:
        resp = requests.get(
            f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank",
            headers=_kis_headers("FHPST01710000"),
            params=params,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("rt_cd") == "0" and data.get("output"):
            return data["output"]
    except Exception:
        pass
    # fallback: 주요 종목 리스트
    return [{"mksc_shrn_iscd": code, "hts_kor_isnm": name}
            for code, name in _MAJOR_STOCKS.get(market.upper(), _MAJOR_STOCKS["KOSPI"])]


def _fetch_stock_detail(stock_code: str) -> dict | None:
    params = {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_INPUT_ISCD": stock_code,
    }
    resp = requests.get(
        f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price",
        headers=_kis_headers("FHKST01010100"),
        params=params,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("rt_cd") != "0":
        return None
    return data.get("output", {})


def _fetch_ohlcv(stock_code: str, days: int = 60) -> list[dict] | None:
    """일봉 OHLCV 데이터 조회 (TR: FHKST03010100)"""
    end_date = datetime.now().strftime("%Y%m%d")
    start_date = (datetime.now() - timedelta(days=days * 2)).strftime("%Y%m%d")
    params = {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_INPUT_ISCD": stock_code,
        "FID_INPUT_DATE_1": start_date,
        "FID_INPUT_DATE_2": end_date,
        "FID_PERIOD_DIV_CODE": "D",
        "FID_ORG_ADJ_PRC": "0",
    }
    try:
        resp = requests.get(
            f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
            headers=_kis_headers("FHKST03010100"),
            params=params,
            timeout=10,
        )
        data = resp.json()
        if data.get("rt_cd") == "0" and data.get("output2"):
            return data["output2"]
    except Exception:
        pass
    return None


# ── 업종별 시세 / 투자자별 매매동향 ──────────────────────────
_sector_cache: dict = {}   # {"data": [...], "ts": float}
_investor_cache: dict = {} # {"data": {...}, "ts": float}
SECTOR_CACHE_TTL_MARKET  = 300   # 장중 5분
SECTOR_CACHE_TTL_OFF     = 1800  # 장외 30분
INVESTOR_CACHE_TTL       = 300   # 5분

# 주요 업종 코드 (KIS 업종코드)
_SECTOR_CODES = {
    "0001": "종합(KOSPI)",
    "2001": "대형주",
    "1001": "음식료품",
    "1002": "섬유의복",
    "1003": "종이목재",
    "1004": "화학",
    "1005": "의약품",
    "1006": "비금속광물",
    "1007": "철강금속",
    "1008": "기계",
    "1009": "전기전자",
    "1010": "의료정밀",
    "1011": "운수장비",
    "1012": "유통업",
    "1013": "전기가스업",
    "1014": "건설업",
    "1015": "운수창고업",
    "1016": "통신업",
    "1017": "금융업",
    "1018": "은행",
    "1019": "증권",
    "1024": "보험",
    "1025": "서비스업",
    "1026": "제조업",
}


def _is_market_hours() -> bool:
    """한국 장중 시간(09:00~15:30) 여부 판단"""
    kst = datetime.now(timezone(timedelta(hours=9)))
    if kst.weekday() >= 5:  # 주말
        return False
    t = kst.hour * 100 + kst.minute
    return 900 <= t <= 1530


def _fetch_sector_index() -> list[dict]:
    """업종별 현재가 시세 조회 (TR: FHPUP02100000)"""
    results = []
    for code, name in _SECTOR_CODES.items():
        try:
            params = {
                "FID_COND_MRKT_DIV_CODE": "U",
                "FID_INPUT_ISCD": code,
            }
            resp = requests.get(
                f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price",
                headers=_kis_headers("FHPUP02100000"),
                params=params,
                timeout=10,
            )
            data = resp.json()
            if data.get("rt_cd") == "0" and data.get("output"):
                out = data["output"]
                results.append({
                    "code": code,
                    "name": name,
                    "bstp_nmix_prpr": out.get("bstp_nmix_prpr", "0"),      # 업종 현재가
                    "bstp_nmix_prdy_vrss": out.get("bstp_nmix_prdy_vrss", "0"),  # 전일대비
                    "bstp_nmix_prdy_ctrt": out.get("bstp_nmix_prdy_ctrt", "0"),  # 등락률
                    "acml_vol": out.get("acml_vol", "0"),                   # 거래량
                    "acml_tr_pbmn": out.get("acml_tr_pbmn", "0"),           # 거래대금
                })
            _time.sleep(0.05)  # API 호출 간격
        except Exception:
            pass
    return results


def _fetch_investor_trend(market: str = "KOSPI") -> dict:
    """투자자별 매매동향 조회 (TR: FHPTJ04400000)

    외국인/기관 순매수 상위 종목을 조회한다.
    KIS API 제한에 따라 전체 시장 투자자별 매매동향을 가져온다.
    """
    mrkt_code = "0001" if market.upper() == "KOSPI" else "1001"
    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")
    result = {"foreign": [], "institution": [], "date": today, "market": market}

    try:
        params = {
            "FID_COND_MRKT_DIV_CODE": "V",
            "FID_INPUT_ISCD": mrkt_code,
            "FID_INPUT_DATE_1": today,
            "FID_INPUT_DATE_2": today,
            "FID_PERIOD_DIV_CODE": "D",
        }
        resp = requests.get(
            f"{KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor",
            headers=_kis_headers("FHPTJ04400000"),
            params=params,
            timeout=10,
        )
        data = resp.json()
        if data.get("rt_cd") == "0" and data.get("output"):
            out = data["output"]
            if isinstance(out, list) and len(out) > 0:
                row = out[0]
                result["summary"] = {
                    "frgn_ntby_qty": row.get("frgn_ntby_qty", "0"),    # 외국인 순매수 수량
                    "frgn_ntby_tr_pbmn": row.get("frgn_ntby_tr_pbmn", "0"),  # 외국인 순매수 금액
                    "orgn_ntby_qty": row.get("orgn_ntby_qty", "0"),    # 기관 순매수 수량
                    "orgn_ntby_tr_pbmn": row.get("orgn_ntby_tr_pbmn", "0"),  # 기관 순매수 금액
                    "prsn_ntby_qty": row.get("prsn_ntby_qty", "0"),    # 개인 순매수 수량
                    "prsn_ntby_tr_pbmn": row.get("prsn_ntby_tr_pbmn", "0"),  # 개인 순매수 금액
                }
            elif isinstance(out, dict):
                result["summary"] = {
                    "frgn_ntby_qty": out.get("frgn_ntby_qty", "0"),
                    "frgn_ntby_tr_pbmn": out.get("frgn_ntby_tr_pbmn", "0"),
                    "orgn_ntby_qty": out.get("orgn_ntby_qty", "0"),
                    "orgn_ntby_tr_pbmn": out.get("orgn_ntby_tr_pbmn", "0"),
                    "prsn_ntby_qty": out.get("prsn_ntby_qty", "0"),
                    "prsn_ntby_tr_pbmn": out.get("prsn_ntby_tr_pbmn", "0"),
                }
    except Exception:
        pass

    # 외국인/기관 순매수 상위 종목 (거래량 상위 목록에서 보강)
    try:
        rank_items = _fetch_volume_rank(market)
        foreign_top = []
        for item in rank_items[:30]:
            code = item.get("mksc_shrn_iscd", "") or item.get("stck_shrn_iscd", "")
            name = item.get("hts_kor_isnm", "")
            if not code:
                continue
            frgn_ntby = item.get("frgn_ntby_qty", "")
            if frgn_ntby:
                try:
                    frgn_val = int(frgn_ntby)
                    foreign_top.append({
                        "symbol": code,
                        "name": name,
                        "netBuy": frgn_val,
                        "price": item.get("stck_prpr", "0"),
                        "change_rate": item.get("prdy_ctrt", "0"),
                    })
                except (ValueError, TypeError):
                    pass
        # 외국인 순매수 상위/하위 각 10개
        foreign_top.sort(key=lambda x: x["netBuy"], reverse=True)
        result["foreignBuy"] = foreign_top[:10]
        result["foreignSell"] = foreign_top[-10:] if len(foreign_top) > 10 else []
    except Exception:
        pass

    return result


def _calc_rsi(closes: list[int], period: int = 14) -> float | None:
    """RSI 계산 (kis-trading/screener.py 로직)"""
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [d if d > 0 else 0 for d in deltas]
    losses = [-d if d < 0 else 0 for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)


def _calc_ma_signal(closes: list[int], short: int = 5, long: int = 20) -> dict:
    """MA 크로스 분석 (kis-trading/screener.py 로직)"""
    result = {"ma5": 0, "ma20": 0, "signal": "데이터부족", "gap": 0}
    if len(closes) < long + 2:
        return result
    ma_short = sum(closes[-short:]) / short
    ma_long = sum(closes[-long:]) / long
    prev_ma_short = sum(closes[-(short + 1):-1]) / short
    result["ma5"] = round(ma_short)
    result["ma20"] = round(ma_long)
    gap = (ma_long - ma_short) / ma_long * 100 if ma_long else 0
    result["gap"] = round(gap, 2)

    if ma_short > ma_long and prev_ma_short <= ma_long:
        result["signal"] = "골든크로스"
    elif ma_short < ma_long and prev_ma_short >= ma_long:
        result["signal"] = "데드크로스"
    elif ma_short > ma_long:
        result["signal"] = "상승추세"
    elif abs(gap) <= 2.0 and ma_short < ma_long and ma_short > prev_ma_short:
        result["signal"] = "크로스임박"
    else:
        result["signal"] = "하락추세"
    return result


def _calc_macd(closes: list[int]) -> dict | None:
    """MACD (12,26,9) 계산"""
    if len(closes) < 35:
        return None

    def ema(data, period):
        k = 2 / (period + 1)
        result = [data[0]]
        for i in range(1, len(data)):
            result.append(data[i] * k + result[-1] * (1 - k))
        return result

    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    macd_line = [ema12[i] - ema26[i] for i in range(len(closes))]
    signal_line = ema(macd_line[25:], 9)  # 26번째부터 signal

    macd_val = round(macd_line[-1], 1)
    signal_val = round(signal_line[-1], 1) if signal_line else 0
    histogram = round(macd_val - signal_val, 1)

    if macd_val > signal_val and macd_line[-2] <= signal_line[-2] if len(signal_line) >= 2 else False:
        trend = "매수신호"
    elif macd_val < signal_val and macd_line[-2] >= signal_line[-2] if len(signal_line) >= 2 else False:
        trend = "매도신호"
    elif histogram > 0:
        trend = "상승모멘텀"
    else:
        trend = "하락모멘텀"

    return {"macd": macd_val, "signal": signal_val, "histogram": histogram, "trend": trend}


def _calc_bollinger(closes: list[int], period: int = 20) -> dict | None:
    """볼린저밴드 (20일, 2표준편차)"""
    if len(closes) < period:
        return None
    recent = closes[-period:]
    mid = sum(recent) / period
    variance = sum((x - mid) ** 2 for x in recent) / period
    std = variance ** 0.5
    upper = round(mid + 2 * std)
    lower = round(mid - 2 * std)
    current = closes[-1]

    # %B: (현재가 - 하단) / (상단 - 하단), 0 이하면 하단 돌파, 1 이상이면 상단 돌파
    width = upper - lower
    pct_b = round((current - lower) / width, 2) if width > 0 else 0.5

    if pct_b <= 0.05:
        position = "하단돌파"
    elif pct_b <= 0.2:
        position = "하단근접"
    elif pct_b >= 0.95:
        position = "상단돌파"
    elif pct_b >= 0.8:
        position = "상단근접"
    else:
        position = "중간"

    return {"upper": upper, "mid": round(mid), "lower": lower, "pct_b": pct_b, "position": position}


def _calc_volume_surge(volumes: list[int]) -> dict:
    """거래량 급증 감지 (최근 5일 평균 vs 20일 평균)"""
    if len(volumes) < 20:
        return {"ratio": 0, "surge": False}
    avg5 = sum(volumes[-5:]) / 5
    avg20 = sum(volumes[-20:]) / 20
    ratio = round(avg5 / avg20, 1) if avg20 > 0 else 0
    return {"ratio": ratio, "surge": ratio >= 2.0}


def _get_technical_indicators(stock_code: str) -> dict:
    """종목의 기술적 지표 종합 조회 (RSI + MA + MACD + 볼린저 + 거래량)"""
    ohlcv = None
    for attempt in range(2):
        ohlcv = _fetch_ohlcv(stock_code, days=60)
        if ohlcv:
            break
        _time.sleep(0.2)
    if not ohlcv:
        return {
            "rsi": None, "ma": {"signal": "데이터없음", "ma5": 0, "ma20": 0, "gap": 0},
            "macd": None, "bollinger": None, "vol_surge": {"ratio": 0, "surge": False},
        }
    sorted_data = sorted(ohlcv, key=lambda x: x.get("stck_bsop_date", ""))
    closes = [int(d.get("stck_clpr", 0)) for d in sorted_data if int(d.get("stck_clpr", 0)) > 0]
    volumes = [int(d.get("acml_vol", 0)) for d in sorted_data if int(d.get("stck_clpr", 0)) > 0]

    rsi = _calc_rsi(closes)
    ma = _calc_ma_signal(closes)
    macd = _calc_macd(closes)
    bollinger = _calc_bollinger(closes)
    vol_surge = _calc_volume_surge(volumes)

    return {"rsi": rsi, "ma": ma, "macd": macd, "bollinger": bollinger, "vol_surge": vol_surge}


def _fetch_and_enrich_stocks(market: str) -> list[dict]:
    cache_key = market.upper()
    now = _time.time()
    if cache_key in _stock_cache and now - _stock_cache[cache_key]["ts"] < STOCK_CACHE_TTL:
        return _stock_cache[cache_key]["items"]

    rank_items = _fetch_volume_rank(market)
    enriched = []
    for item in rank_items:
        code = item.get("mksc_shrn_iscd", "") or item.get("stck_shrn_iscd", "")
        name = item.get("hts_kor_isnm", "") or item.get("stck_shrn_iscd", "")
        if not code:
            continue
        try:
            detail = _fetch_stock_detail(code)
            _time.sleep(0.05)
        except Exception:
            continue
        if not detail:
            continue

        def safe_float(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0

        def safe_int(v):
            try:
                return int(str(v).replace(",", ""))
            except (TypeError, ValueError):
                return 0

        per = safe_float(detail.get("per", 0))
        pbr = safe_float(detail.get("pbr", 0))
        current_price = safe_int(detail.get("stck_prpr", 0))
        change_rate = safe_float(detail.get("prdy_ctrt", 0))
        volume = safe_int(detail.get("acml_vol", 0))
        market_cap = safe_int(detail.get("hts_avls", 0))

        # 기술적 지표 조회 (RSI + MA)
        try:
            tech = _get_technical_indicators(code)
            _time.sleep(0.1)
        except Exception:
            tech = {"rsi": None, "ma": {"signal": "조회실패", "ma5": 0, "ma20": 0, "gap": 0}}

        macd = tech.get("macd") or {}
        boll = tech.get("bollinger") or {}
        vol_s = tech.get("vol_surge") or {}

        enriched.append({
            "stock_code": code,
            "stock_name": name,
            "current_price": current_price,
            "change_rate": change_rate,
            "per": per,
            "pbr": pbr,
            "volume": volume,
            "market_cap": market_cap,
            "rsi": tech["rsi"],
            "ma5": tech["ma"]["ma5"],
            "ma20": tech["ma"]["ma20"],
            "ma_signal": tech["ma"]["signal"],
            "ma_gap": tech["ma"]["gap"],
            "macd": macd.get("histogram", 0),
            "macd_trend": macd.get("trend", "없음"),
            "bb_position": boll.get("position", "없음"),
            "bb_pct_b": boll.get("pct_b", 0.5),
            "vol_ratio": vol_s.get("ratio", 0),
            "vol_surge": vol_s.get("surge", False),
        })

    _stock_cache[cache_key] = {"ts": now, "items": enriched}
    return enriched


@app.get("/stock-recommend")
async def stock_recommend(
    market: str = Query(default="KOSPI"),
    per_min: float = Query(default=0),
    per_max: float = Query(default=20),
    pbr_min: float = Query(default=0),
    pbr_max: float = Query(default=2),
    user: dict = Depends(verify_firebase_token),
):
    if not KIS_APP_KEY or not KIS_APP_SECRET:
        return {"error": "KIS API 키가 설정되지 않았습니다. .env 파일에 KIS_APP_KEY, KIS_APP_SECRET을 입력해주세요."}

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            stocks = await loop.run_in_executor(ex, _fetch_and_enrich_stocks, market)
    except Exception as e:
        return {"error": "KIS API 호출 중 오류가 발생했습니다."}

    filtered = [
        s for s in stocks
        if s["per"] > 0 and per_min <= s["per"] <= per_max
        and s["pbr"] > 0 and pbr_min <= s["pbr"] <= pbr_max
    ]
    filtered.sort(key=lambda x: x["per"])

    return {"market": market, "total": len(filtered), "pool_size": len(stocks), "items": filtered}


@app.get("/api/sector-heatmap")
async def api_sector_heatmap(user: dict = Depends(verify_firebase_token)):
    """업종별 시세 히트맵 데이터. 장중 5분 / 장외 30분 캐시."""
    if not KIS_APP_KEY or not KIS_APP_SECRET:
        return {"error": "KIS API 키가 설정되지 않았습니다."}

    now = _time.time()
    ttl = SECTOR_CACHE_TTL_MARKET if _is_market_hours() else SECTOR_CACHE_TTL_OFF
    if _sector_cache.get("data") and now - _sector_cache.get("ts", 0) < ttl:
        return {
            "sectors": _sector_cache["data"],
            "cached": True,
            "marketOpen": _is_market_hours(),
            "updatedAt": datetime.fromtimestamp(_sector_cache["ts"], tz=timezone(timedelta(hours=9))).isoformat(),
        }

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            sectors = await loop.run_in_executor(ex, _fetch_sector_index)
    except Exception:
        return {"error": "업종 시세 조회 중 오류가 발생했습니다.", "sectors": []}

    _sector_cache["data"] = sectors
    _sector_cache["ts"] = now

    return {
        "sectors": sectors,
        "cached": False,
        "marketOpen": _is_market_hours(),
        "updatedAt": datetime.now(timezone(timedelta(hours=9))).isoformat(),
    }


@app.get("/api/investor-flow")
async def api_investor_flow(
    market: str = Query(default="KOSPI"),
    user: dict = Depends(verify_firebase_token),
):
    """외국인/기관 투자자별 매매동향. 5분 캐시."""
    if not KIS_APP_KEY or not KIS_APP_SECRET:
        return {"error": "KIS API 키가 설정되지 않았습니다."}

    cache_key = f"investor_{market.upper()}"
    now = _time.time()
    cached = _investor_cache.get(cache_key)
    if cached and now - cached.get("ts", 0) < INVESTOR_CACHE_TTL:
        return {
            **cached["data"],
            "cached": True,
            "updatedAt": datetime.fromtimestamp(cached["ts"], tz=timezone(timedelta(hours=9))).isoformat(),
        }

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            trend = await loop.run_in_executor(ex, _fetch_investor_trend, market)
    except Exception:
        return {"error": "투자자별 매매동향 조회 중 오류가 발생했습니다."}

    _investor_cache[cache_key] = {"data": trend, "ts": now}

    return {
        **trend,
        "cached": False,
        "updatedAt": datetime.now(timezone(timedelta(hours=9))).isoformat(),
    }


@app.post("/stock-ai")
async def stock_ai_analyze(items: list[dict], user: dict = Depends(verify_firebase_token)):
    """기술적 지표가 포함된 종목 리스트를 받아 AI 감성분석만 수행"""
    if not items:
        return {"items": []}

    cache_key = "ai:" + ",".join(s.get("stock_code", "") for s in items)
    cached = _stock_cache.get(cache_key)
    if cached and _time.time() - cached["ts"] < STOCK_CACHE_TTL:
        return {"items": cached["items"]}

    try:
        analyzed = await _analyze_stock_sentiment(items)
        _stock_cache[cache_key] = {"ts": _time.time(), "items": analyzed}
        return {"items": analyzed}
    except Exception as e:
        return {"items": items, "error": "AI 분석 중 오류가 발생했습니다."}


async def _analyze_stock_sentiment(stocks: list[dict]) -> list[dict]:
    stock_text = "\n".join([
        f"{s['stock_name']}({s['stock_code']}): 현재가 {s['current_price']:,}원, "
        f"등락률 {s['change_rate']:+.2f}%, PER {s['per']:.1f}, PBR {s['pbr']:.2f}, "
        f"RSI {s.get('rsi') or '없음'}, MA신호 {s.get('ma_signal','없음')}, "
        f"MA간격 {s.get('ma_gap',0):.2f}%, MACD {s.get('macd_trend','없음')}(히스토그램:{s.get('macd',0)}), "
        f"볼린저 {s.get('bb_position','없음')}(%B:{s.get('bb_pct_b',0.5):.2f}), "
        f"거래량비율 {s.get('vol_ratio',0):.1f}배{'(급증!)' if s.get('vol_surge') else ''}"
        for s in stocks
    ])

    prompt = f"""주식 투자 애널리스트로서 다음 종목들을 분석하세요.
기술적 지표(RSI, MA크로스, PER/PBR)와 시장 상황을 종합 판단합니다.

{stock_text}

아래 JSON 배열로만 응답하세요. 종목 순서를 유지하세요.
[{{"code":"종목코드","score":75,"grade":"긍정","decision":"강력매수","confidence":"높음","reason":"2~3문장 분석근거","risk":"리스크요인","signals":["키워드1","키워드2"]}}]

규칙:
- score: 0~100 정수 (투자 매력도). RSI/MA/MACD/볼린저 모두 종합.
- grade: 매우긍정/긍정/중립/부정/매우부정
- decision: 강력매수(score>=65+긍정)/매수고려(score>=55)/관망(score>=40)/매수보류(score<40)
- confidence: 높음/중간/낮음
- reason: 기술적 지표(RSI/MA/MACD/볼린저)와 PER/PBR을 종합한 1~2문장. 50자 이내로 핵심만.
- risk: 주요 리스크 요인 한 문장 (반드시 작성)
- signals: 핵심 키워드 2~3개
- stop_loss: 권장 손절가 (현재가 대비 -3%~-7% 수준, 정수)
- target_price: 권장 목표가 (현재가 대비 +3%~+10% 수준, 정수)

중요: MACD 데드크로스+RSI 과매수+볼린저 상단돌파가 겹치면 반드시 부정적 판단.
중요: 지표가 서로 모순될 때(예: RSI 과매도인데 MA 하락추세) confidence를 '낮음'으로."""

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
                    max_output_tokens=65536,
                    response_mime_type="application/json",
                ),
            )
        )

    raw = response.text.strip()
    import re as _re
    m = _re.search(r'\[.*\]', raw, _re.DOTALL)
    if not m:
        print(f"[sentiment] JSON 배열 미발견: {raw[:200]}")
        return stocks
    try:
        sentiments = json.loads(m.group())
    except json.JSONDecodeError as e:
        print(f"[sentiment] JSON 파싱 실패: {e}, raw: {raw[:300]}")
        return stocks

    # 코드 기준으로 매칭
    sent_map = {item["code"]: item for item in sentiments if "code" in item}
    for s in stocks:
        info = sent_map.get(s["stock_code"], {})
        s["score"] = info.get("score", 50)
        s["grade"] = info.get("grade", "중립")
        s["decision"] = info.get("decision", "관망")
        s["confidence"] = info.get("confidence", "낮음")
        s["reason"] = info.get("reason", "")
        s["risk"] = info.get("risk", "")
        s["signals"] = info.get("signals", [])
        s["stop_loss"] = info.get("stop_loss", 0)
        s["target_price"] = info.get("target_price", 0)

    return stocks


@app.get("/stock-news")
async def stock_news(
    name: str = Query(..., description="종목명"),
    code: str = Query(default="", description="종목코드"),
    user: dict = Depends(verify_firebase_token),
):
    """종목별 뉴스 수집 + Gemini 요약"""
    if not NAVER_CLIENT_ID:
        return {"error": "네이버 API 키가 설정되지 않았습니다."}

    # 뉴스 수집
    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            items = await loop.run_in_executor(ex, _fetch_naver_news, f"{name} 주가", 10)
    except Exception as e:
        return {"error": "뉴스 수집에 실패했습니다."}

    if not items:
        return {"error": f"'{name}' 관련 뉴스를 찾을 수 없습니다."}

    articles = [
        {"title": _strip_html(item.get("title", "")),
         "description": _strip_html(item.get("description", ""))[:200],
         "link": item.get("originallink") or item.get("link", ""),
         "pub_date": item.get("pubDate", "")}
        for item in items
    ]

    # Gemini 요약
    news_text = "\n".join([
        f"{i+1}. {a['title']}\n   {a['description'][:150]}"
        for i, a in enumerate(articles[:8])
    ])

    prompt = f"""주식 투자 애널리스트로서 [{name}({code})] 종목의 최신 뉴스를 분석하세요.

{news_text}

아래 JSON 형식으로만 응답하세요.
{{"headline":"종목의 현재 상황 2~3문장 요약","sentiment_score":75,"sentiment_grade":"긍정","key_issues":[{{"title":"이슈 제목","summary":"2~3문장 설명","impact":"긍정"}}],"outlook":"향후 전망 2~3문장","risk_factors":"주요 리스크 1~2문장"}}

규칙:
- sentiment_score: 0~100 (투자 감성 점수)
- sentiment_grade: 매우긍정/긍정/중립/부정/매우부정
- key_issues: 핵심 이슈 3~5개. impact는 긍정/부정/중립.
- headline, outlook은 구체적으로."""

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
                        temperature=0.2, max_output_tokens=4096,
                        response_mime_type="application/json",
                    ),
                )
            )
        raw = response.text.strip()
        import re as _re
        m = _re.search(r'\{.*\}', raw, _re.DOTALL)
        if m:
            summary = json.loads(m.group())
        else:
            summary = {"headline": "요약 생성 실패", "key_issues": [], "outlook": "", "risk_factors": ""}
    except Exception as e:
        summary = {"headline": f"AI 요약 실패: {str(e)[:50]}", "key_issues": [], "outlook": "", "risk_factors": ""}

    return {"name": name, "code": code, "articles": articles, "summary": summary}


# ── 웹훅: 알림 수신 (n8n 등 외부 서비스 → Firestore) ──────────
from google.cloud import firestore as _firestore

_firestore_client = None


def _get_firestore():
    global _firestore_client
    if _firestore_client is None:
        _firestore_client = _firestore.Client(project=GCP_PROJECT)
    return _firestore_client


class NotifyRequest(BaseModel):
    title: str
    message: str = ""
    type: str = "system"          # crypto | stock | system | custom
    severity: str = "info"        # info | warning | critical
    source: str = "n8n"
    workflow: str = ""
    data: dict = {}


@app.post("/webhook/notify", dependencies=[Depends(verify_webhook_secret)])
async def webhook_notify(req: NotifyRequest):
    """기존 알림 호환 엔드포인트. notifications 에 저장하면서 events/ 에도 미러링하여
    운영 대시보드의 이벤트 로그가 구식 n8n 플로우도 같이 보여주도록 한다."""
    try:
        db = _get_firestore()
        doc_ref = db.collection("notifications").document()
        doc_ref.set({
            "title": req.title,
            "message": req.message,
            "type": req.type,
            "severity": req.severity,
            "source": req.source,
            "workflow": req.workflow,
            "data": req.data,
            "read": False,
            "created_at": _firestore.SERVER_TIMESTAMP,
        })

        # events/ 미러 — 운영 탭 이벤트 로그를 단일 출처로 만들기 위해
        try:
            db.collection("events").document().set({
                "kind":       "event",
                "source":     req.source or "n8n",
                "workflow":   req.workflow,
                "syncStatus": "ok",
                "errorType":  None,
                "occurredAt": None,
                "payload": {
                    "title":    req.title,
                    "message":  req.message,
                    "type":     req.type,
                    "severity": req.severity,
                    "data":     req.data,
                },
                "legacyNotificationId": doc_ref.id,
                "created_at": _firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            pass  # 미러 실패해도 알림 자체는 살린다

        return {"ok": True, "id": doc_ref.id}
    except Exception as e:
        return {"ok": False, "error": "서버 오류가 발생했습니다."}


@app.get("/webhook/notifications")
async def get_notifications(limit: int = Query(default=50), user: dict = Depends(verify_firebase_token)):
    try:
        db = _get_firestore()
        docs = db.collection("notifications").order_by(
            "created_at", direction=_firestore.Query.DESCENDING
        ).limit(limit).stream()
        items = []
        for doc in docs:
            d = doc.to_dict()
            d["id"] = doc.id
            # Firestore Timestamp → ISO string
            if d.get("created_at"):
                d["created_at"] = d["created_at"].isoformat()
            items.append(d)
        return {"items": items}
    except Exception as e:
        return {"items": [], "error": "알림 조회 중 오류가 발생했습니다."}


@app.delete("/webhook/notifications/{noti_id}")
async def delete_notification(noti_id: str, user: dict = Depends(verify_firebase_token)):
    try:
        db = _get_firestore()
        db.collection("notifications").document(noti_id).delete()
        return {"ok": True}
    except Exception:
        return {"ok": False, "error": "삭제에 실패했습니다."}


@app.post("/webhook/notifications/{noti_id}/read")
async def mark_notification_read(noti_id: str, user: dict = Depends(verify_firebase_token)):
    try:
        db = _get_firestore()
        db.collection("notifications").document(noti_id).update({"read": True})
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": "서버 오류가 발생했습니다."}


# ── 운영 대시보드: 통합 ingest + 분리된 컬렉션 ──────────────
#
# Envelope 스키마 (n8n과 합의된 계약):
#   {
#     "kind":       "event" | "balance" | "workflow_run",
#     "source":     "n8n",
#     "workflow":   "balance_v1",
#     "syncStatus": "ok" | "partial" | "failed",
#     "errorType":  null | "auth" | "rate_limit" | "parse" | "network" | "unknown",
#     "occurredAt": "2026-04-12T10:00:00+09:00",   # ISO8601, optional
#     "payload":    { ... kind 별 실제 데이터 ... }
#   }
#
# 컬렉션:
#   events/         — 모든 진입점, append-only
#   balances/       — 잔고 스냅샷 (원가 기준만, marketValue 없음)
#   workflow_runs/  — 워크플로 실행 상태 (운영 탭용)
#
# 모든 ingest는 자동으로 events에 append되고, kind 가 balance|workflow_run 이면
# 해당 컬렉션에도 normalize 후 동시 기록한다.

class IngestEnvelope(BaseModel):
    kind: str                       # event | balance | workflow_run
    source: str = "n8n"
    workflow: str = ""
    syncStatus: str = "ok"          # ok | partial | failed
    errorType: str | None = None
    occurredAt: str | None = None   # ISO8601, 없으면 서버 시간
    payload: dict = {}


_ALLOWED_KINDS = {"event", "balance", "workflow_run", "signal", "paper_trade", "trade_result", "system_status", "stock_signal", "stock_alert", "position_update", "sector_flow"}
_ALLOWED_SYNC = {"ok", "partial", "failed"}


def _normalize_balance(payload: dict) -> dict:
    """잔고 페이로드를 balances/ 컬렉션 스키마로 정규화.

    원가 + 평가금액 병행 표시.

    n8n 계약:
      accountId    — 계좌 식별자
      accountCount — 계좌 수
      cashKRW      — 계좌 KRW 현금 잔고 (미투입분)
      totalCostKRW — 코인 매수 누적 원가 (= sum of perCoin[].invested)
      perCoin[]    — 종목별 (symbol, qty, avgCost, invested, currentPrice)
                     currentPrice 는 선택: 없으면 평가금액 0 → 프론트에서 평가 행 미표시
    """
    per_coin_in = payload.get("perCoin") or payload.get("per_coin") or []
    per_coin = []
    total_market = 0.0
    for c in per_coin_in:
        if not isinstance(c, dict):
            continue
        qty = float(c.get("qty") or c.get("quantity") or 0)
        cur_price = float(c.get("currentPrice") or c.get("current_price") or 0)
        per_coin.append({
            "symbol":       str(c.get("symbol") or c.get("ticker") or "")[:20],
            "qty":          qty,
            "avgCost":      float(c.get("avgCost") or c.get("avg_cost") or 0),
            "invested":     float(c.get("invested") or c.get("investedKRW") or 0),
            "currentPrice": cur_price,
        })
        total_market += cur_price * qty
    cash_krw = float(payload.get("cashKRW") or payload.get("cash_krw") or 0)
    total_cost = float(payload.get("totalCostKRW") or payload.get("total_cost_krw") or 0)
    return {
        "accountId":        str(payload.get("accountId") or payload.get("account_id") or "default"),
        "accountCount":     int(payload.get("accountCount") or payload.get("account_count") or 1),
        "cashKRW":          cash_krw,
        "totalCostKRW":     total_cost,
        "totalMarketValue": round(total_market, 2),  # 0이면 시세 미제공
        "perCoin":          per_coin,
    }


def _normalize_workflow_run(payload: dict, env: IngestEnvelope) -> dict:
    return {
        "workflow":   env.workflow or str(payload.get("workflow") or ""),
        "status":     env.syncStatus,
        "errorType":  env.errorType,
        "startedAt":  payload.get("startedAt") or payload.get("started_at"),
        "finishedAt": payload.get("finishedAt") or payload.get("finished_at"),
        "durationMs": payload.get("durationMs") or payload.get("duration_ms"),
        "eventCount": payload.get("eventCount") or payload.get("event_count") or 0,
        "message":    payload.get("message") or "",
    }


# ── crypto 검증 허브: 신호/paper trade/결과/시스템 정규화 ──

def _normalize_signal(payload: dict) -> dict:
    """후보 신호. n8n이 AI 분석 결과를 보냄."""
    raw_factors = payload.get("factors")
    return {
        "signalId":       str(payload.get("signalId") or payload.get("signal_id") or ""),
        "symbol":         str(payload.get("symbol") or "")[:20],
        "score":          float(payload.get("score") or 0),
        "scoreReason":    str(payload.get("scoreReason") or payload.get("score_reason") or ""),
        "entryPrice":     float(payload.get("entryPrice") or payload.get("entry_price") or 0),
        "stopLoss":       float(payload.get("stopLoss") or payload.get("stop_loss") or 0),
        "direction":      str(payload.get("direction") or "long"),
        "status":         str(payload.get("status") or "candidate"),
        "stage":          str(payload.get("stage") or "candidate"),           # candidate | trade_ready
        "factors":        raw_factors if isinstance(raw_factors, dict) else None,
        "noTradeReason":  str(payload.get("noTradeReason") or payload.get("no_trade_reason") or ""),
        "strategyStatus": str(payload.get("strategyStatus") or payload.get("strategy_status") or ""),
    }


def _normalize_paper_trade(payload: dict) -> dict:
    """검증 중 paper trade 상태 업데이트. n8n이 주기적으로 보냄."""
    return {
        "tradeId":      str(payload.get("tradeId") or payload.get("trade_id") or ""),
        "signalId":     str(payload.get("signalId") or payload.get("signal_id") or ""),
        "symbol":       str(payload.get("symbol") or "")[:20],
        "direction":    str(payload.get("direction") or "long"),
        "entryPrice":   float(payload.get("entryPrice") or payload.get("entry_price") or 0),
        "currentPrice": float(payload.get("currentPrice") or payload.get("current_price") or 0),
        "pnlPercent":   float(payload.get("pnlPercent") or payload.get("pnl_percent") or 0),
        "maxFavorable": float(payload.get("maxFavorable") or payload.get("max_favorable") or 0),
        "maxAdverse":   float(payload.get("maxAdverse") or payload.get("max_adverse") or 0),
        "holdTimeMin":  int(payload.get("holdTimeMin") or payload.get("hold_time_min") or 0),
        "status":       str(payload.get("status") or "open"),
    }


def _normalize_trade_result(payload: dict) -> dict:
    """종료 결과. 실시간(n8n) + 백테스트(backtest) 공용."""
    raw_components = payload.get("components")
    return {
        "tradeId":      str(payload.get("tradeId") or payload.get("trade_id") or ""),
        "signalId":     str(payload.get("signalId") or payload.get("signal_id") or ""),
        "symbol":       str(payload.get("symbol") or "")[:20],
        "direction":    str(payload.get("direction") or "long"),
        "result":       str(payload.get("result") or ""),         # win | loss
        "pnlPercent":   float(payload.get("pnlPercent") or payload.get("pnl_percent") or 0),
        "exitReason":   str(payload.get("exitReason") or payload.get("exit_reason") or ""),
        "exitAt":       payload.get("exitAt") or payload.get("exit_at"),
        "entryAt":      payload.get("entryAt") or payload.get("entry_at"),
        "entryPrice":   float(payload.get("entryPrice") or payload.get("entry_price") or 0),
        "exitPrice":    float(payload.get("exitPrice") or payload.get("exit_price") or 0),
        "holdTimeMin":  int(payload.get("holdTimeMin") or payload.get("hold_time_min") or 0),
        "maxFavorable": float(payload.get("maxFavorable") or payload.get("max_favorable") or 0),
        "maxAdverse":   float(payload.get("maxAdverse") or payload.get("max_adverse") or 0),
        "confidence":   float(payload.get("confidence") or 0),
        "components":   raw_components if isinstance(raw_components, dict) else None,
    }


def _normalize_system_status(payload: dict) -> dict:
    """시스템 상태 업데이트. n8n 또는 모니터링이 보냄."""
    return {
        "status":             str(payload.get("status") or "normal"),  # normal | caution | pause
        "reason":             str(payload.get("reason") or ""),
        "lastSyncFailure":    payload.get("lastSyncFailure") or payload.get("last_sync_failure"),
        "lastCollectFailure": payload.get("lastCollectFailure") or payload.get("last_collect_failure"),
    }


def _normalize_stock_signal(payload: dict, meta: dict) -> dict:
    """주식 시그널. Paperclip 에이전트가 보냄."""
    raw_factors = payload.get("factors")
    return {
        "signalId":      payload.get("signalId") or payload.get("signal_id", ""),
        "symbol":        (payload.get("symbol") or "")[:20],
        "score":         float(payload.get("score", 0)),
        "scoreReason":   payload.get("scoreReason") or payload.get("score_reason", ""),
        "entryPrice":    float(payload.get("entryPrice") or payload.get("entry_price", 0)),
        "stopLoss":      float(payload.get("stopLoss") or payload.get("stop_loss", 0)),
        "targetPrice":   float(payload.get("targetPrice") or payload.get("target_price", 0)),
        "direction":     payload.get("direction", "long"),
        "status":        payload.get("status", "candidate"),
        "stage":         payload.get("stage", "candidate"),
        "market":        "stock",
        "factors":       raw_factors if isinstance(raw_factors, dict) else None,
        "noTradeReason": payload.get("noTradeReason") or payload.get("no_trade_reason", ""),
        **meta,
    }


def _normalize_position_update(payload: dict, meta: dict) -> dict:
    """포지션 업데이트 정규화. 외부 시스템이 주기적으로 보냄."""
    return {
        "signalId": payload.get("signalId", ""),
        "symbol": payload.get("symbol", ""),
        "currentPrice": float(payload.get("currentPrice", 0)),
        "returnPct": float(payload.get("returnPct", 0)),
        "hitTarget": payload.get("hitTarget", False),
        "hitStopLoss": payload.get("hitStopLoss", False),
        "daysHeld": int(payload.get("daysHeld", 0)),
        "maxFavorable": float(payload.get("maxFavorable", 0)),
        "maxAdverse": float(payload.get("maxAdverse", 0)),
        **meta,
    }


def _normalize_sector_flow(payload: dict, meta: dict) -> dict:
    """업종별 시세 + 외국인/기관 매매동향 정규화. n8n 또는 외부 수집기가 보냄."""
    return {
        "sectors":          payload.get("sectors", []),           # [{name, change_pct, volume, ...}]
        "foreignTop":       payload.get("foreignTop", []),       # [{symbol, name, netBuy, ...}]
        "institutionalTop": payload.get("institutionalTop", []),
        "market":           payload.get("market", "kospi"),
        **meta,
    }


@app.post("/webhook/ingest", dependencies=[Depends(verify_webhook_secret)])
async def webhook_ingest(env: IngestEnvelope):
    """통합 진입점. envelope.kind 에 따라 events + (balances|workflow_runs) 에 기록.

    어떤 kind 든 항상 events/ 에 1건 append (append-only 원장).
    추가로 kind 가 balance | workflow_run 이면 정규화된 컬렉션에도 기록.
    """
    if env.kind not in _ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail=f"알 수 없는 kind: {env.kind}")
    if env.syncStatus not in _ALLOWED_SYNC:
        raise HTTPException(status_code=400, detail=f"알 수 없는 syncStatus: {env.syncStatus}")

    try:
        db = _get_firestore()

        # 1) events/ — append-only 원장
        event_doc = db.collection("events").document()
        event_doc.set({
            "kind":       env.kind,
            "source":     env.source,
            "workflow":   env.workflow,
            "syncStatus": env.syncStatus,
            "errorType":  env.errorType,
            "occurredAt": env.occurredAt,
            "payload":    env.payload,
            "created_at": _firestore.SERVER_TIMESTAMP,
        })

        # 2) kind 별 정규화 컬렉션
        balance_id = None
        run_id = None
        if env.kind == "balance":
            norm = _normalize_balance(env.payload)
            ref = db.collection("balances").document()
            ref.set({
                **norm,
                "source":     env.source,
                "workflow":   env.workflow,
                "syncStatus": env.syncStatus,
                "errorType":  env.errorType,
                "occurredAt": env.occurredAt,
                "eventId":    event_doc.id,
                "created_at": _firestore.SERVER_TIMESTAMP,
            })
            balance_id = ref.id
        elif env.kind == "workflow_run":
            norm = _normalize_workflow_run(env.payload, env)
            ref = db.collection("workflow_runs").document()
            ref.set({
                **norm,
                "source":     env.source,
                "occurredAt": env.occurredAt,
                "eventId":    event_doc.id,
                "created_at": _firestore.SERVER_TIMESTAMP,
            })
            run_id = ref.id
        elif env.kind == "signal":
            # market:"stock" 이면 stock_signals 컬렉션으로 라우팅 (kind 오발송 방어)
            if (env.payload.get("market") or "").lower() == "stock":
                meta = {
                    "source": env.source, "workflow": env.workflow,
                    "syncStatus": env.syncStatus, "errorType": env.errorType,
                    "occurredAt": env.occurredAt, "eventId": event_doc.id,
                }
                norm = _normalize_stock_signal(env.payload, meta)
                if not norm["symbol"]:
                    return {"ok": False, "eventId": event_doc.id, "error": "stock signal에 symbol이 비어있습니다."}
                ref = db.collection("stock_signals").document(norm["signalId"] or None)
                ref.set({**norm, "created_at": _firestore.SERVER_TIMESTAMP})
            else:
                norm = _normalize_signal(env.payload)
                if not norm["symbol"]:
                    return {"ok": False, "eventId": event_doc.id, "error": "signal에 symbol이 비어있습니다."}
                ref = db.collection("signals").document()
                ref.set({
                    **norm,
                    "source": env.source, "workflow": env.workflow,
                    "syncStatus": env.syncStatus, "errorType": env.errorType,
                    "occurredAt": env.occurredAt, "eventId": event_doc.id,
                    "created_at": _firestore.SERVER_TIMESTAMP,
                })
        elif env.kind == "paper_trade":
            norm = _normalize_paper_trade(env.payload)
            if not norm["symbol"]:
                return {"ok": False, "eventId": event_doc.id, "error": "paper_trade에 symbol이 비어있습니다."}
            trade_id = norm.get("tradeId") or event_doc.id
            ref = db.collection("paper_trades").document(trade_id)
            existing = ref.get()
            write_data = {
                **norm,
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
                "updated_at": _firestore.SERVER_TIMESTAMP,
            }
            if not existing.exists:
                write_data["created_at"] = _firestore.SERVER_TIMESTAMP
            ref.set(write_data, merge=True)
        elif env.kind == "trade_result":
            norm = _normalize_trade_result(env.payload)
            ref = db.collection("trade_results").document()
            ref.set({
                **norm,
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
                "created_at": _firestore.SERVER_TIMESTAMP,
            })
        elif env.kind == "system_status":
            norm = _normalize_system_status(env.payload)
            ref = db.collection("system_status").document("current")
            ref.set({
                **norm,
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
                "updated_at": _firestore.SERVER_TIMESTAMP,
            })
        elif env.kind == "stock_signal":
            meta = {
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
            }
            norm = _normalize_stock_signal(env.payload, meta)
            if not norm["symbol"]:
                return {"ok": False, "eventId": event_doc.id, "error": "stock_signal에 symbol이 비어있습니다."}
            ref = db.collection("stock_signals").document(norm["signalId"] or None)
            ref.set({**norm, "created_at": _firestore.SERVER_TIMESTAMP})
        elif env.kind == "stock_alert":
            doc = {
                "alertType": env.payload.get("alertType") or env.payload.get("alert_type", "info"),
                "title":     env.payload.get("title", ""),
                "message":   env.payload.get("message", ""),
                "symbol":    (env.payload.get("symbol") or "")[:20],
                "severity":  env.payload.get("severity", "info"),
                "market":    "stock",
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
            }
            ref = db.collection("stock_alerts").document()
            ref.set({**doc, "created_at": _firestore.SERVER_TIMESTAMP})
        elif env.kind == "position_update":
            meta = {
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
            }
            norm = _normalize_position_update(env.payload, meta)
            ref = db.collection("position_updates").document()
            ref.set({**norm, "created_at": _firestore.SERVER_TIMESTAMP})
        elif env.kind == "sector_flow":
            meta = {
                "source": env.source, "workflow": env.workflow,
                "syncStatus": env.syncStatus, "errorType": env.errorType,
                "occurredAt": env.occurredAt, "eventId": event_doc.id,
            }
            norm = _normalize_sector_flow(env.payload, meta)
            ref = db.collection("sector_flows").document()
            ref.set({**norm, "created_at": _firestore.SERVER_TIMESTAMP})

        return {"ok": True, "eventId": event_doc.id, "balanceId": balance_id, "runId": run_id}
    except HTTPException:
        raise
    except Exception:
        return {"ok": False, "error": "ingest 처리 중 오류가 발생했습니다."}


def _doc_to_dict(doc) -> dict:
    d = doc.to_dict() or {}
    d["id"] = doc.id
    for ts_key in ("created_at", "updated_at"):
        if d.get(ts_key) and hasattr(d[ts_key], "isoformat"):
            d[ts_key] = d[ts_key].isoformat()
    return d


@app.get("/api/events")
async def api_events(
    limit: int = Query(default=100, le=500),
    kind: str | None = Query(default=None),
    user: dict = Depends(verify_firebase_token),
):
    """이벤트 로그 (운영 탭의 이벤트 로그 / 리플레이 1차 데이터원)."""
    try:
        db = _get_firestore()
        q = db.collection("events").order_by("created_at", direction=_firestore.Query.DESCENDING)
        if kind:
            q = q.where("kind", "==", kind)
        return {"items": [_doc_to_dict(d) for d in q.limit(limit).stream()]}
    except Exception:
        return {"items": [], "error": "events 조회 실패"}


@app.get("/api/balances/latest")
async def api_balances_latest(user: dict = Depends(verify_firebase_token)):
    """가장 최근 잔고 스냅샷 1건 + 직전 스냅샷 1건 (실시간 카드용)."""
    try:
        db = _get_firestore()
        docs = list(
            db.collection("balances")
              .order_by("created_at", direction=_firestore.Query.DESCENDING)
              .limit(2).stream()
        )
        items = [_doc_to_dict(d) for d in docs]
        return {
            "latest":   items[0] if len(items) >= 1 else None,
            "previous": items[1] if len(items) >= 2 else None,
        }
    except Exception:
        return {"latest": None, "previous": None, "error": "balances 조회 실패"}


@app.post("/api/balances/refresh")
async def refresh_balance(user: dict = Depends(verify_firebase_token)):
    """n8n 잔고 워크플로를 트리거. smart-hub → n8n → 업비트 → ingest → Firestore."""
    import requests as _req
    try:
        resp = _req.post(
            "https://n8n.banghub.kr/webhook/refresh-balance",
            headers={"X-Webhook-Secret": WEBHOOK_SECRET, "Content-Type": "application/json"},
            json={},
            timeout=15,
        )
        try:
            body = resp.json()
        except Exception:
            body = {}
        if resp.status_code >= 400:
            return {"ok": False, "error": body.get("message") or f"n8n 응답 {resp.status_code}"}
        # n8n cooldown 응답: {"error":"cooldown","message":"N초 후 재시도"}
        if body.get("error") == "cooldown":
            return {"ok": False, "cooldown": True, "error": body.get("message", "잠시 후 재시도")}
        return {"ok": True, **body}
    except Exception:
        return {"ok": False, "error": "n8n 워크플로 호출 실패"}


class BacktestRequest(BaseModel):
    market: str = "KRW-BTC"
    startDate: str = ""
    endDate: str = ""
    scoreCutoff: int = 60
    maxHoldMin: int = 1440


@app.post("/api/backtest/run")
async def run_backtest(req: BacktestRequest, user: dict = Depends(verify_firebase_token)):
    """n8n 백테스트 워크플로를 트리거. smart-hub → n8n → 업비트 캔들 → 시뮬레이션 → ingest."""
    import requests as _req
    try:
        resp = _req.post(
            "https://n8n.banghub.kr/webhook/run-backtest",
            headers={"X-Webhook-Secret": WEBHOOK_SECRET, "Content-Type": "application/json"},
            json={
                "market": req.market,
                "startDate": req.startDate,
                "endDate": req.endDate,
                "scoreCutoff": req.scoreCutoff,
                "maxHoldMin": req.maxHoldMin,
            },
            timeout=30,
        )
        try:
            body = resp.json()
        except Exception:
            body = {}
        if resp.status_code >= 400:
            return {"ok": False, "error": body.get("message") or f"n8n 응답 {resp.status_code}"}
        return {"ok": True, **body}
    except Exception:
        return {"ok": False, "error": "백테스트 워크플로 호출 실패"}


@app.get("/api/workflows/status")
async def api_workflows_status(
    limit: int = Query(default=50, le=200),
    user: dict = Depends(verify_firebase_token),
):
    """최근 워크플로 실행 + 워크플로별 마지막 상태 집계 (운영상태 탭용)."""
    try:
        db = _get_firestore()
        docs = list(
            db.collection("workflow_runs")
              .order_by("created_at", direction=_firestore.Query.DESCENDING)
              .limit(limit).stream()
        )
        runs = [_doc_to_dict(d) for d in docs]
        latest_by_wf: dict[str, dict] = {}
        for r in runs:
            wf = r.get("workflow") or "(unknown)"
            if wf not in latest_by_wf:
                latest_by_wf[wf] = r
        return {"runs": runs, "latestByWorkflow": list(latest_by_wf.values())}
    except Exception:
        return {"runs": [], "latestByWorkflow": [], "error": "workflow_runs 조회 실패"}


# ── 주식운영 GET 엔드포인트 ──

@app.get("/api/stock-signals")
async def api_stock_signals(
    limit: int = Query(default=50, le=200),
    stage: str | None = Query(default=None),
    direction: str | None = Query(default=None),
    user: dict = Depends(verify_firebase_token),
):
    """주식 시그널 목록 (최근순). stage/direction 필터."""
    try:
        db = _get_firestore()
        q = db.collection("stock_signals").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if stage:
                q = q.where("stage", "==", stage)
            if direction:
                q = q.where("direction", "==", direction)
            items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
        except Exception:
            q = db.collection("stock_signals").order_by("created_at", direction=_firestore.Query.DESCENDING)
            all_items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
            items = all_items
            if stage:
                items = [i for i in items if i.get("stage") == stage]
            if direction:
                items = [i for i in items if i.get("direction") == direction]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "stock_signals 조회 실패"}


@app.get("/api/stock-alerts")
async def api_stock_alerts(
    limit: int = Query(default=30, le=100),
    severity: str | None = Query(default=None),
    user: dict = Depends(verify_firebase_token),
):
    """주식 알림 목록 (최근순). severity 필터: info | warning | critical."""
    try:
        db = _get_firestore()
        q = db.collection("stock_alerts").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if severity:
                q = q.where("severity", "==", severity)
            items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
        except Exception:
            q = db.collection("stock_alerts").order_by("created_at", direction=_firestore.Query.DESCENDING)
            all_items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
            items = all_items
            if severity:
                items = [i for i in items if i.get("severity") == severity]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "stock_alerts 조회 실패"}


# ── 주식 데이터 정리 (코인 signals → stock_signals 이동) ──

@app.post("/api/admin/migrate-stock-signals", dependencies=[Depends(verify_webhook_secret)])
async def migrate_stock_signals():
    """signals/ 컬렉션에 잘못 들어간 주식 데이터를 stock_signals/로 이동 후 삭제."""
    try:
        db = _get_firestore()
        signals = db.collection("signals").stream()
        moved = 0
        for doc in signals:
            data = doc.to_dict() or {}
            # source=paperclip 이거나 market=stock 이면 주식 데이터
            is_stock = (
                (data.get("market") or "").lower() == "stock"
                or data.get("source") == "paperclip"
            )
            if not is_stock:
                continue
            # stock_signals 로 복사
            sig_id = data.get("signalId") or doc.id
            target = db.collection("stock_signals").document(sig_id)
            write_data = {**data, "market": "stock"}
            if "created_at" not in write_data:
                write_data["created_at"] = _firestore.SERVER_TIMESTAMP
            target.set(write_data)
            # 원본 삭제
            doc.reference.delete()
            moved += 1
        return {"ok": True, "moved": moved}
    except Exception as e:
        return {"ok": False, "error": str(e)}


## clean-stock-data API 제거됨 — 실수로 실제 데이터까지 삭제 방지


# ── crypto 검증 허브 GET 엔드포인트 ──

@app.get("/api/signals")
async def api_signals(
    limit: int = Query(default=50, le=200),
    status: str | None = Query(default=None),
    stage: str | None = Query(default=None),
    user: dict = Depends(verify_firebase_token),
):
    """후보 신호 목록 (최근순). stage 필터: candidate | trade_ready."""
    try:
        db = _get_firestore()
        q = db.collection("signals").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if status:
                q = q.where("status", "==", status)
            if stage:
                q = q.where("stage", "==", stage)
            items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
        except Exception:
            # 복합 인덱스 미생성 시 필터 없이 전체 조회 폴백
            q = db.collection("signals").order_by("created_at", direction=_firestore.Query.DESCENDING)
            all_items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
            items = all_items
            if status:
                items = [i for i in items if i.get("status") == status]
            if stage:
                items = [i for i in items if i.get("stage") == stage]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "signals 조회 실패"}


@app.get("/api/paper-trades")
async def api_paper_trades(
    status: str | None = Query(default="open"),
    limit: int = Query(default=50, le=200),
    user: dict = Depends(verify_firebase_token),
):
    """검증 중 paper trade 목록."""
    try:
        db = _get_firestore()
        q = db.collection("paper_trades").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if status:
                q = q.where("status", "==", status)
            items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
        except Exception:
            # 복합 인덱스 미생성 시 필터 없이 전체 조회 폴백
            q = db.collection("paper_trades").order_by("created_at", direction=_firestore.Query.DESCENDING)
            all_items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
            items = [i for i in all_items if i.get("status") == status] if status else all_items
        return {"items": items}
    except Exception:
        return {"items": [], "error": "paper_trades 조회 실패"}


@app.get("/api/trade-results")
async def api_trade_results(
    limit: int = Query(default=100, le=500),
    source: str | None = Query(default=None),
    after: str | None = Query(default=None),
    before: str | None = Query(default=None),
    user: dict = Depends(verify_firebase_token),
):
    """종료 결과 목록 (최근순). source: n8n|backtest, after/before: ISO8601."""
    try:
        db = _get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if source:
                q = q.where("source", "==", source)
            items = [_doc_to_dict(d) for d in q.limit(limit).stream()]
        except Exception:
            all_items = [_doc_to_dict(d) for d in db.collection("trade_results").order_by("created_at", direction=_firestore.Query.DESCENDING).limit(limit).stream()]
            items = [i for i in all_items if i.get("source") == source] if source else all_items
        if after:
            items = [i for i in items if (i.get("occurredAt") or i.get("created_at", "")) >= after]
        if before:
            items = [i for i in items if (i.get("occurredAt") or i.get("created_at", "")) <= before]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "trade_results 조회 실패"}


def _compute_perf_stats(results: list[dict]) -> dict:
    """trade_results 리스트로 성과 지표 계산."""
    total = len(results)
    if total == 0:
        return {"total": 0, "wins": 0, "losses": 0, "winRate": 0,
                "avgWinPercent": 0, "avgLossPercent": 0, "avgPnlRatio": 0,
                "expectation": 0, "maxConsecutiveLoss": 0, "maxDrawdownPercent": 0}

    wins = [r for r in results if r.get("result") == "win"]
    losses = [r for r in results if r.get("result") == "loss"]
    win_rate = len(wins) / total if total > 0 else 0

    avg_win = sum(r.get("pnlPercent", 0) for r in wins) / len(wins) if wins else 0
    avg_loss = sum(abs(r.get("pnlPercent", 0)) for r in losses) / len(losses) if losses else 0
    avg_pnl_ratio = avg_win / avg_loss if avg_loss > 0 else 0

    expectation = (win_rate * avg_win) - ((1 - win_rate) * avg_loss)

    max_consec = 0
    cur_consec = 0
    for r in results:
        if r.get("result") == "loss":
            cur_consec += 1
            max_consec = max(max_consec, cur_consec)
        else:
            cur_consec = 0

    cum = 0
    peak = 0
    max_dd = 0
    for r in reversed(results):
        cum += r.get("pnlPercent", 0)
        peak = max(peak, cum)
        dd = peak - cum
        max_dd = max(max_dd, dd)

    return {
        "total": total,
        "wins": len(wins),
        "losses": len(losses),
        "winRate": round(win_rate, 4),
        "avgWinPercent": round(avg_win, 2),
        "avgLossPercent": round(avg_loss, 2),
        "avgPnlRatio": round(avg_pnl_ratio, 2),
        "expectation": round(expectation, 2),
        "maxConsecutiveLoss": max_consec,
        "maxDrawdownPercent": round(max_dd, 2),
    }


# ── 주식 시그널 포지션 트래킹 ──────────────────────────────

# 종목명 → 종목코드 역방향 매핑 (KIS API는 코드 필요)
_NAME_TO_CODE: dict[str, str] = {}
for _mkt_stocks in _MAJOR_STOCKS.values():
    for _code, _name in _mkt_stocks:
        _NAME_TO_CODE[_name] = _code


def _resolve_stock_code(symbol: str) -> str | None:
    """시그널의 symbol(종목명 또는 종목코드)을 6자리 종목코드로 변환."""
    if not symbol:
        return None
    # 이미 숫자 6자리면 종목코드로 간주
    stripped = symbol.strip()
    if re.match(r"^\d{6}$", stripped):
        return stripped
    # 종목명으로 역방향 조회
    return _NAME_TO_CODE.get(stripped)


# 포지션 트래킹 캐시 (10분 TTL)
_position_perf_cache: dict = {}
_POSITION_CACHE_TTL = 600  # 10분


def _track_signal_performance(signal: dict) -> dict:
    """개별 주식 시그널의 현재 포지션 성과를 계산.

    KIS API로 현재가/일봉을 조회하여 수익률, 목표/손절 도달 여부,
    최대 유리 이탈(MFE) 등을 계산한다.
    """
    symbol = signal.get("symbol", "")
    stock_code = _resolve_stock_code(symbol)
    entry_price = float(signal.get("entryPrice", 0))
    target_price = float(signal.get("targetPrice", 0))
    stop_loss = float(signal.get("stopLoss", 0))
    direction = signal.get("direction", "long")

    result = {
        "signalId": signal.get("signalId") or signal.get("id", ""),
        "symbol": symbol,
        "stockCode": stock_code,
        "direction": direction,
        "entryPrice": entry_price,
        "targetPrice": target_price,
        "stopLoss": stop_loss,
        "score": signal.get("score", 0),
        "currentPrice": 0,
        "returnPct": 0.0,
        "hitTarget": False,
        "hitStopLoss": False,
        "maxFavorable": 0.0,
        "daysHeld": 0,
        "status": "unknown",
    }

    # 생성일로부터 경과일 계산
    created_at = signal.get("created_at", "")
    if created_at:
        try:
            if isinstance(created_at, str):
                # ISO8601 형식
                created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            elif hasattr(created_at, "isoformat"):
                created_dt = created_at
            else:
                created_dt = None
            if created_dt:
                now_utc = datetime.now(timezone.utc)
                if created_dt.tzinfo is None:
                    created_dt = created_dt.replace(tzinfo=timezone.utc)
                result["daysHeld"] = (now_utc - created_dt).days
        except Exception:
            pass

    if not stock_code or entry_price <= 0:
        result["status"] = "no_data"
        return result

    # 현재가 조회
    try:
        detail = _fetch_stock_detail(stock_code)
        if detail:
            current_price = int(str(detail.get("stck_prpr", "0")).replace(",", ""))
            result["currentPrice"] = current_price
        else:
            result["status"] = "api_error"
            return result
    except Exception:
        result["status"] = "api_error"
        return result

    # 수익률 계산 (방향 고려)
    if entry_price > 0 and current_price > 0:
        if direction == "short":
            result["returnPct"] = round((entry_price - current_price) / entry_price * 100, 2)
        else:
            result["returnPct"] = round((current_price - entry_price) / entry_price * 100, 2)

    # 일봉으로 최대 유리 이탈(MFE) 계산
    try:
        _time.sleep(0.1)  # KIS API 속도제한 방어
        ohlcv = _fetch_ohlcv(stock_code, days=max(result["daysHeld"] + 5, 30))
        if ohlcv:
            # 시그널 생성 이후의 일봉만 필터
            created_str = ""
            if created_at:
                try:
                    if isinstance(created_at, str):
                        created_str = created_at[:10].replace("-", "")
                    elif hasattr(created_at, "strftime"):
                        created_str = created_at.strftime("%Y%m%d")
                except Exception:
                    pass

            highs = []
            lows = []
            for candle in ohlcv:
                stck_bsop_date = candle.get("stck_bsop_date", "")
                if created_str and stck_bsop_date < created_str:
                    continue
                h = int(str(candle.get("stck_hgpr", "0")).replace(",", ""))
                l = int(str(candle.get("stck_lwpr", "0")).replace(",", ""))
                if h > 0:
                    highs.append(h)
                if l > 0:
                    lows.append(l)

            if highs and entry_price > 0:
                if direction == "short":
                    best = min(lows) if lows else entry_price
                    result["maxFavorable"] = round((entry_price - best) / entry_price * 100, 2)
                else:
                    best = max(highs)
                    result["maxFavorable"] = round((best - entry_price) / entry_price * 100, 2)
    except Exception:
        pass  # MFE 계산 실패해도 나머지 결과는 반환

    # 목표가/손절가 도달 여부
    if target_price > 0 and current_price > 0:
        if direction == "short":
            result["hitTarget"] = current_price <= target_price
        else:
            result["hitTarget"] = current_price >= target_price
    if stop_loss > 0 and current_price > 0:
        if direction == "short":
            result["hitStopLoss"] = current_price >= stop_loss
        else:
            result["hitStopLoss"] = current_price <= stop_loss

    # 상태 결정
    if result["hitTarget"]:
        result["status"] = "target_hit"
    elif result["hitStopLoss"]:
        result["status"] = "stop_hit"
    else:
        result["status"] = "pending"

    return result


@app.get("/api/stock-signals/performance")
async def api_stock_signal_performance(user: dict = Depends(verify_firebase_token)):
    """주식 시그널 전체 성과 집계. 10분 캐시."""
    now = _time.time()
    cached = _position_perf_cache.get("aggregate")
    if cached and now - cached["ts"] < _POSITION_CACHE_TTL:
        return cached["data"]

    try:
        db = _get_firestore()
        docs = list(
            db.collection("stock_signals")
              .order_by("created_at", direction=_firestore.Query.DESCENDING)
              .limit(200).stream()
        )
        signals = [_doc_to_dict(d) for d in docs]

        if not signals:
            return {"totalSignals": 0, "error": "시그널이 없습니다."}

        # 각 시그널별 성과 계산 (KIS API 속도제한 고려하여 순차 처리)
        tracked = []
        for sig in signals:
            try:
                perf = _track_signal_performance(sig)
                tracked.append(perf)
                _time.sleep(0.15)  # KIS API 속도제한 방어
            except Exception:
                tracked.append({
                    "signalId": sig.get("signalId") or sig.get("id", ""),
                    "symbol": sig.get("symbol", ""),
                    "status": "error",
                    "returnPct": 0,
                    "hitTarget": False,
                    "hitStopLoss": False,
                })

        # 집계 통계
        total = len(tracked)
        completed = [t for t in tracked if t.get("status") in ("target_hit", "stop_hit")]
        pending = [t for t in tracked if t.get("status") == "pending"]
        hit_target = [t for t in tracked if t.get("hitTarget")]
        hit_stop = [t for t in tracked if t.get("hitStopLoss")]
        valid = [t for t in tracked if t.get("status") not in ("unknown", "no_data", "error")]

        returns = [t["returnPct"] for t in valid]
        win_returns = [t["returnPct"] for t in valid if t["returnPct"] > 0]
        loss_returns = [t["returnPct"] for t in valid if t["returnPct"] < 0]

        avg_return = round(sum(returns) / len(returns), 2) if returns else 0
        avg_win = round(sum(win_returns) / len(win_returns), 2) if win_returns else 0
        avg_loss = round(sum(loss_returns) / len(loss_returns), 2) if loss_returns else 0

        hit_rate = round(len(hit_target) / len(completed), 4) if completed else 0

        best = max(valid, key=lambda t: t["returnPct"]) if valid else None
        worst = min(valid, key=lambda t: t["returnPct"]) if valid else None

        # 점수 구간별 성과 (6-7, 7-8, 8-9, 9-10)
        score_buckets = {"6-7": [], "7-8": [], "8-9": [], "9-10": []}
        for t in valid:
            s = float(t.get("score", 0))
            if 6 <= s < 7:
                score_buckets["6-7"].append(t["returnPct"])
            elif 7 <= s < 8:
                score_buckets["7-8"].append(t["returnPct"])
            elif 8 <= s < 9:
                score_buckets["8-9"].append(t["returnPct"])
            elif 9 <= s <= 10:
                score_buckets["9-10"].append(t["returnPct"])

        perf_by_score = {}
        for bucket, rets in score_buckets.items():
            perf_by_score[bucket] = {
                "count": len(rets),
                "avgReturn": round(sum(rets) / len(rets), 2) if rets else 0,
            }

        # 방향별 성과 (long vs short)
        long_valid = [t for t in valid if t.get("direction") == "long"]
        short_valid = [t for t in valid if t.get("direction") == "short"]
        long_returns = [t["returnPct"] for t in long_valid]
        short_returns = [t["returnPct"] for t in short_valid]

        perf_by_direction = {
            "long": {
                "count": len(long_valid),
                "avgReturn": round(sum(long_returns) / len(long_returns), 2) if long_returns else 0,
                "hitTarget": len([t for t in long_valid if t["hitTarget"]]),
                "hitStopLoss": len([t for t in long_valid if t["hitStopLoss"]]),
            },
            "short": {
                "count": len(short_valid),
                "avgReturn": round(sum(short_returns) / len(short_returns), 2) if short_returns else 0,
                "hitTarget": len([t for t in short_valid if t["hitTarget"]]),
                "hitStopLoss": len([t for t in short_valid if t["hitStopLoss"]]),
            },
        }

        response = {
            "totalSignals": total,
            "hitTarget": len(hit_target),
            "hitStopLoss": len(hit_stop),
            "pendingCount": len(pending),
            "hitRate": hit_rate,
            "avgReturn": avg_return,
            "avgWinReturn": avg_win,
            "avgLossReturn": avg_loss,
            "bestSignal": {
                "signalId": best["signalId"], "symbol": best["symbol"],
                "returnPct": best["returnPct"],
            } if best else None,
            "worstSignal": {
                "signalId": worst["signalId"], "symbol": worst["symbol"],
                "returnPct": worst["returnPct"],
            } if worst else None,
            "performanceByScore": perf_by_score,
            "performanceByDirection": perf_by_direction,
        }

        _position_perf_cache["aggregate"] = {"ts": now, "data": response}
        return response

    except Exception:
        return {"totalSignals": 0, "error": "성과 집계 실패"}


@app.get("/api/stock-signals/{signal_id}/track")
async def api_stock_signal_track(signal_id: str, user: dict = Depends(verify_firebase_token)):
    """개별 주식 시그널 포지션 트래킹. 현재가, 수익률, 목표/손절 상태."""
    try:
        db = _get_firestore()
        doc = db.collection("stock_signals").document(signal_id).get()
        if not doc.exists:
            raise HTTPException(status_code=404, detail="시그널을 찾을 수 없습니다.")
        signal = _doc_to_dict(doc)
        perf = _track_signal_performance(signal)
        return perf
    except HTTPException:
        raise
    except Exception:
        return {"error": "시그널 트래킹 실패"}


@app.get("/api/performance")
async def api_performance(
    count: int = Query(default=50, le=500),
    source: str | None = Query(default=None),
    symbol: str | None = Query(default=None),
    direction: str | None = Query(default=None),
    after: str | None = Query(default=None),
    before: str | None = Query(default=None),
    excludeSymbols: str | None = Query(default=None),   # "SOL,DOGE" 쉼표 구분
    user: dict = Depends(verify_firebase_token),
):
    """성과 요약 — trade_results 기반 서버 계산. source/symbol/direction/기간/제외 필터."""
    try:
        db = _get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=_firestore.Query.DESCENDING)
        try:
            if source:
                q = q.where("source", "==", source)
            results = [_doc_to_dict(d) for d in q.limit(count).stream()]
        except Exception:
            all_docs = [_doc_to_dict(d) for d in db.collection("trade_results").order_by("created_at", direction=_firestore.Query.DESCENDING).limit(count).stream()]
            results = [r for r in all_docs if r.get("source") == source] if source else all_docs
        # 전략 필터 (클라이언트 사이드)
        if symbol:
            sym_upper = symbol.upper().replace("/KRW", "").replace("KRW-", "")
            results = [r for r in results if (r.get("symbol", "").upper().replace("/KRW", "").replace("KRW-", "") == sym_upper)]
        if direction:
            results = [r for r in results if r.get("direction", "").upper() == direction.upper()]
        if after:
            results = [r for r in results if (r.get("occurredAt") or r.get("created_at", "")) >= after]
        if before:
            results = [r for r in results if (r.get("occurredAt") or r.get("created_at", "")) <= before]
        # 제외 전략 격리 (excludeSymbols 파라미터)
        if excludeSymbols:
            ex_set = {s.strip().upper() for s in excludeSymbols.split(",") if s.strip()}
            results = [r for r in results if r.get("symbol", "").upper().replace("/KRW", "").replace("KRW-", "") not in ex_set]

        overall = _compute_perf_stats(results)

        long_results = [r for r in results if r.get("direction", "long") == "long"]
        short_results = [r for r in results if r.get("direction") == "short"]

        return {
            **overall,
            "byDirection": {
                "long": _compute_perf_stats(long_results),
                "short": _compute_perf_stats(short_results),
            },
        }
    except Exception:
        return {"total": 0, "error": "performance 계산 실패"}


@app.get("/api/system-status")
async def api_system_status(user: dict = Depends(verify_firebase_token)):
    """시스템 상태 (current doc) + 최근 잔고 + 워크플로."""
    try:
        db = _get_firestore()
        # 시스템 상태
        status_doc = db.collection("system_status").document("current").get()
        sys_status = status_doc.to_dict() if status_doc.exists else None
        if sys_status and sys_status.get("updated_at") and hasattr(sys_status["updated_at"], "isoformat"):
            sys_status["updated_at"] = sys_status["updated_at"].isoformat()

        # 최근 잔고 1건
        bal_docs = list(
            db.collection("balances")
              .order_by("created_at", direction=_firestore.Query.DESCENDING)
              .limit(1).stream()
        )
        balance = _doc_to_dict(bal_docs[0]) if bal_docs else None

        # 워크플로별 최신 상태
        wf_docs = list(
            db.collection("workflow_runs")
              .order_by("created_at", direction=_firestore.Query.DESCENDING)
              .limit(30).stream()
        )
        latest_by_wf: dict[str, dict] = {}
        for d in wf_docs:
            r = _doc_to_dict(d)
            wf = r.get("workflow") or "(unknown)"
            if wf not in latest_by_wf:
                latest_by_wf[wf] = r

        return {
            "system": sys_status,
            "balance": balance,
            "workflows": list(latest_by_wf.values()),
        }
    except Exception:
        return {"system": None, "balance": None, "workflows": [], "error": "system-status 조회 실패"}


class InviteRequest(BaseModel):
    email: str
    password: str


@app.post("/admin/invite")
async def admin_invite(req: InviteRequest, user: dict = Depends(verify_firebase_token)):
    """관리자가 초대: Firestore 화이트리스트 + Firebase Auth 계정 생성"""
    # admin 확인
    db = _get_firestore()
    admin_doc = db.collection("allowed_emails").document(user.get("email", "")).get()
    if not admin_doc.exists or admin_doc.to_dict().get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자만 초대할 수 있습니다.")

    import firebase_admin
    from firebase_admin import auth as fb_auth
    if not firebase_admin._apps:
        firebase_admin.initialize_app()

    # Firebase Auth 계정 생성 (기존 계정 있으면 삭제 후 재생성 — 선점 방지)
    try:
        fb_auth.create_user(email=req.email, password=req.password)
    except fb_auth.EmailAlreadyExistsError:
        try:
            existing = fb_auth.get_user_by_email(req.email)
            fb_auth.delete_user(existing.uid)
            fb_auth.create_user(email=req.email, password=req.password)
        except Exception as e:
            return {"ok": False, "error": "계정 재설정 실패"}
    except Exception as e:
        return {"ok": False, "error": "계정 생성 실패"}

    # Firestore 화이트리스트 추가
    db.collection("allowed_emails").document(req.email).set({
        "email": req.email,
        "role": "user",
        "added_by": user.get("email", ""),
        "added_at": _firestore.SERVER_TIMESTAMP,
    })
    return {"ok": True, "email": req.email}


def _ensure_admin(user: dict):
    """현재 사용자가 admin인지 확인. 아니면 403."""
    db = _get_firestore()
    doc = db.collection("allowed_emails").document(user.get("email", "")).get()
    if not doc.exists or doc.to_dict().get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자만 사용할 수 있습니다.")


def _init_firebase_admin():
    import firebase_admin
    from firebase_admin import auth as fb_auth
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    return fb_auth


@app.get("/admin/users")
async def admin_users(user: dict = Depends(verify_firebase_token)):
    """관리자: 전체 사용자 목록 (화이트리스트 + 기본 Auth 정보)."""
    _ensure_admin(user)
    db = _get_firestore()
    docs = db.collection("allowed_emails").stream()
    items = []
    for doc in docs:
        d = doc.to_dict()
        added_at = d.get("added_at")
        if added_at and hasattr(added_at, "isoformat"):
            added_at = added_at.isoformat()
        items.append({
            "email":    d.get("email", doc.id),
            "role":     d.get("role", "user"),
            "addedBy":  d.get("added_by", ""),
            "addedAt":  added_at,
        })
    return {"items": items}


class PasswordChangeRequest(BaseModel):
    email: str = ""           # 비어 있으면 본인, 있으면 admin이 대상 지정
    newPassword: str


@app.post("/admin/change-password")
async def admin_change_password(req: PasswordChangeRequest, user: dict = Depends(verify_firebase_token)):
    """비밀번호 변경. 본인이면 누구나, 타인이면 admin만."""
    target_email = req.email.strip().lower() or user.get("email", "")
    is_self = target_email == user.get("email", "")

    if not is_self:
        _ensure_admin(user)

    if not req.newPassword or len(req.newPassword) < 6:
        raise HTTPException(status_code=400, detail="비밀번호는 6자 이상이어야 합니다.")

    fb_auth = _init_firebase_admin()
    try:
        existing = fb_auth.get_user_by_email(target_email)
        fb_auth.update_user(existing.uid, password=req.newPassword)
        return {"ok": True, "email": target_email}
    except Exception:
        return {"ok": False, "error": "비밀번호 변경에 실패했습니다."}


class RoleUpdateRequest(BaseModel):
    email: str
    role: str               # admin | user


@app.post("/admin/update-role")
async def admin_update_role(req: RoleUpdateRequest, user: dict = Depends(verify_firebase_token)):
    """관리자: 사용자 역할 변경."""
    _ensure_admin(user)
    if req.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="role은 admin 또는 user만 가능합니다.")
    if req.email == user.get("email", ""):
        raise HTTPException(status_code=400, detail="자기 자신의 역할은 변경할 수 없습니다.")
    db = _get_firestore()
    doc_ref = db.collection("allowed_emails").document(req.email)
    if not doc_ref.get().exists:
        raise HTTPException(status_code=404, detail="등록되지 않은 사용자입니다.")
    doc_ref.update({"role": req.role})
    return {"ok": True, "email": req.email, "role": req.role}


@app.delete("/admin/user/{email}")
async def admin_delete_user(email: str, user: dict = Depends(verify_firebase_token)):
    """관리자: 사용자 삭제 (Firestore 화이트리스트 + Firebase Auth 계정)."""
    _ensure_admin(user)
    if email == user.get("email", ""):
        raise HTTPException(status_code=400, detail="자기 자신은 삭제할 수 없습니다.")
    db = _get_firestore()
    # Firestore 화이트리스트 삭제
    db.collection("allowed_emails").document(email).delete()
    # Firebase Auth 계정 삭제
    fb_auth = _init_firebase_admin()
    try:
        existing = fb_auth.get_user_by_email(email)
        fb_auth.delete_user(existing.uid)
    except Exception:
        pass  # Auth에 없어도 화이트리스트는 이미 삭제됨
    return {"ok": True, "email": email}


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
        return {"error": "뉴스를 가져오는 중 오류가 발생했습니다."}

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
        return {"error": "API 호출 중 오류가 발생했습니다."}

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
        return {"error": "데이터를 처리하는 중 오류가 발생했습니다."}
