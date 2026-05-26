"""Coin operation routes and pure coin strategy helpers."""

from datetime import datetime, timezone, timedelta
import asyncio
import hashlib
import logging as _logging
import time
import uuid
from collections import defaultdict
from types import SimpleNamespace

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel
import requests

from smart_hub.coin_trx_strategy import start_trx_strategy_loop


router = APIRouter(tags=["coin"])
_deps: SimpleNamespace | None = None


def configure(deps: SimpleNamespace) -> None:
    global _deps
    _deps = deps


def deps() -> SimpleNamespace:
    if _deps is None:
        raise RuntimeError("coin routes are not configured")
    return _deps


async def coin_auth(authorization: str = Header(default="")) -> dict:
    return await deps().verify_firebase_token(authorization)


def coin_engine_symbol_config(symbol: str, engine_cfg: dict | None = None) -> dict:
    """Return per-symbol engine config. Symbols are case-insensitive."""
    symbols = ((engine_cfg or {}).get("symbols") or {})
    symbol_upper = (symbol or "").strip().upper().replace("KRW-", "")
    if not symbol_upper or not isinstance(symbols, dict):
        return {}
    matched = symbols.get(symbol_upper)
    return matched if isinstance(matched, dict) else {}


def coin_invest_budget_plan(
    *,
    total_asset: float,
    current_invested: float,
    krw_balance: float,
    max_total: float,
    default_position_size_pct: float,
    default_max_per_symbol: float,
    symbol_cfg: dict | None = None,
) -> dict:
    """Calculate coin entry budget with symbol-level overrides."""
    symbol_cfg = symbol_cfg or {}
    size_multiplier = float(symbol_cfg.get("sizeMultiplier") or 1.0)
    size_multiplier = max(0.1, min(size_multiplier, 5.0))
    position_size_pct = default_position_size_pct * size_multiplier
    budget_by_pct = total_asset * (position_size_pct / 100.0)
    max_per_symbol = float(symbol_cfg.get("maxPerSymbolKRW") or default_max_per_symbol)
    remaining = max_total - current_invested
    invest_krw = int(min(budget_by_pct, max_per_symbol, remaining, krw_balance))
    return {
        "sizeMultiplier": round(size_multiplier, 4),
        "positionSizePct": round(position_size_pct, 4),
        "budgetByPct": int(budget_by_pct),
        "maxPerSymbolKRW": int(max_per_symbol),
        "remainingKRW": int(remaining),
        "investKRW": invest_krw,
    }


def coin_partial_take_profit_plan(
    *,
    current_price: float,
    entry_price: float,
    current_volume: float,
    order: dict,
    symbol_cfg: dict | None = None,
) -> dict:
    """Calculate whether a partial take-profit sell should run."""
    symbol_cfg = symbol_cfg or {}
    threshold_pct = float(symbol_cfg.get("partialTakeProfitPct") or 0)
    ratio = float(symbol_cfg.get("partialTakeProfitRatio") or 0)
    if threshold_pct <= 0 or ratio <= 0 or current_volume <= 0 or entry_price <= 0:
        return {"shouldSell": False}
    if bool(order.get("partialExitDone")):
        return {"shouldSell": False}
    pnl_pct = ((current_price - entry_price) / entry_price) * 100
    if pnl_pct < threshold_pct:
        return {"shouldSell": False, "thresholdPct": threshold_pct, "pnlPct": round(pnl_pct, 4)}
    sell_volume = round(current_volume * min(max(ratio, 0.05), 0.95), 12)
    if sell_volume <= 0:
        return {"shouldSell": False}
    return {
        "shouldSell": True,
        "thresholdPct": threshold_pct,
        "sellRatio": ratio,
        "sellVolume": sell_volume,
        "pnlPct": round(pnl_pct, 4),
    }


def coin_reentry_check(
    *,
    current_price: float,
    symbol_cfg: dict | None = None,
    last_exited_order: dict | None = None,
    daily_reentry_count: int = 0,
) -> tuple[bool, dict]:
    """Check whether a re-entry after a recent exit is allowed."""
    symbol_cfg = symbol_cfg or {}
    if not last_exited_order:
        return True, {"mode": "initial_entry"}
    max_daily = int(symbol_cfg.get("maxDailyReentries") or 0)
    if max_daily > 0 and daily_reentry_count >= max_daily:
        return False, {
            "reason": "reentry_daily_limit",
            "dailyReentryCount": daily_reentry_count,
            "maxDailyReentries": max_daily,
        }
    exit_price = float(last_exited_order.get("exitPrice") or 0)
    dip_pct = float(symbol_cfg.get("reentryDipPct") or 0)
    if exit_price <= 0 or dip_pct <= 0:
        return True, {"mode": "reentry_no_dip_rule"}
    trigger_price = exit_price * (1 - dip_pct / 100.0)
    if current_price <= trigger_price:
        return True, {
            "mode": "reentry",
            "lastExitPrice": exit_price,
            "dipPct": dip_pct,
            "triggerPrice": round(trigger_price, 8),
            "dailyReentryCount": daily_reentry_count,
        }
    return False, {
        "reason": "reentry_price_not_reached",
        "lastExitPrice": exit_price,
        "dipPct": dip_pct,
        "triggerPrice": round(trigger_price, 8),
        "currentPrice": current_price,
    }


def coin_symbol_to_market(symbol: str) -> str:
    """Convert 'BTC' into 'KRW-BTC'."""
    s = (symbol or "").strip().upper()
    if s.startswith("KRW-"):
        return s
    return f"KRW-{s}"


class BacktestRequest(BaseModel):
    market: str = "KRW-BTC"
    startDate: str = ""
    endDate: str = ""
    scoreCutoff: int = 60
    maxHoldMin: int = 1440


@router.post("/api/backtest/run")
async def run_backtest(req: BacktestRequest, user: dict = Depends(coin_auth)):
    """n8n 백테스트 워크플로를 트리거. smart-hub → n8n → 업비트 캔들 → 시뮬레이션 → ingest."""
    try:
        resp = requests.post(
            "https://n8n.banghub.kr/webhook/run-backtest",
            headers={"X-Webhook-Secret": deps().webhook_secret, "Content-Type": "application/json"},
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



class BacktestSweepRequest(BaseModel):
    market: str = "KRW-BTC"
    startDate: str = ""
    endDate: str = ""
    scoreCutoffs: list[int] = [60]
    maxHoldMin: int = 1440


# ── 코인 자동매매 엔진 (업비트) ─────────────────────────────────
coin_autotrade_log = _logging.getLogger("coin_autotrade")

COIN_AUTOTRADE_DEFAULTS: dict = {
    "enabled":                False,
    "maxTotalKRW":            200_000,
    "maxPerSymbolKRW":        100_000,
    "minScore":               50,
    "allowedStages":          ["trade_ready"],
    "allowedSymbols":         ["BTC"],
    "allowedDirections":      ["long"],
    "maxConcurrentPositions": 2,
    "maxDailyLossPct":        -2.0,
    "maxHoldHours":           24,
    "positionSizePct":        10.0,
    "legacySignalTradingEnabled": False,
}
coin_autotrade_config: dict = {**COIN_AUTOTRADE_DEFAULTS}
coin_autotrade_config_ts: float = 0.0
COIN_AUTOTRADE_CACHE_TTL: float = 30.0
COIN_ENGINE_DEFAULTS: dict = {"symbols": {}}
coin_engine_config: dict = {**COIN_ENGINE_DEFAULTS}
coin_engine_config_ts: float = 0.0
COIN_ENGINE_CACHE_TTL: float = 30.0


def load_coin_autotrade_config(force: bool = False) -> dict:
    """Firestore settings/coin-autotrade에서 설정 로드. 30초 캐시."""
    global coin_autotrade_config, coin_autotrade_config_ts
    now = time.time()
    if not force and (now - coin_autotrade_config_ts) < COIN_AUTOTRADE_CACHE_TTL:
        return coin_autotrade_config
    try:
        db = deps().get_firestore()
        doc = db.collection("settings").document("coin-autotrade").get()
        if doc.exists:
            saved = doc.to_dict() or {}
            merged = {**COIN_AUTOTRADE_DEFAULTS, **{k: v for k, v in saved.items() if k in COIN_AUTOTRADE_DEFAULTS}}
            coin_autotrade_config.update(merged)
        else:
            db.collection("settings").document("coin-autotrade").set(COIN_AUTOTRADE_DEFAULTS)
            coin_autotrade_config.update(COIN_AUTOTRADE_DEFAULTS)
        coin_autotrade_config_ts = now
    except Exception as e:
        coin_autotrade_log.warning(f"coin autotrade config 로드 실패 (메모리 캐시 유지): {e}")
    return coin_autotrade_config


def save_coin_autotrade_config(updates: dict):
    """Firestore settings/coin-autotrade 업데이트 + 메모리 캐시 갱신."""
    global coin_autotrade_config_ts
    try:
        db = deps().get_firestore()
        db.collection("settings").document("coin-autotrade").set(updates, merge=True)
    except Exception as e:
        coin_autotrade_log.error(f"coin autotrade config 저장 실패: {e}")
        raise
    coin_autotrade_config.update(updates)
    coin_autotrade_config_ts = time.time()


def load_coin_engine_config(force: bool = False) -> dict:
    """Firestore settings/coin-engine에서 심볼별 전략 설정 로드."""
    global coin_engine_config, coin_engine_config_ts
    now = time.time()
    if not force and (now - coin_engine_config_ts) < COIN_ENGINE_CACHE_TTL:
        return coin_engine_config
    try:
        db = deps().get_firestore()
        doc = db.collection("settings").document("coin-engine").get()
        if doc.exists:
            saved = doc.to_dict() or {}
            merged = {**COIN_ENGINE_DEFAULTS, **saved}
            merged["symbols"] = saved.get("symbols", {}) if isinstance(saved.get("symbols", {}), dict) else {}
            coin_engine_config.clear()
            coin_engine_config.update(merged)
        else:
            coin_engine_config.clear()
            coin_engine_config.update(COIN_ENGINE_DEFAULTS)
        coin_engine_config_ts = now
    except Exception as e:
        coin_autotrade_log.warning(f"coin engine config 로드 실패 (메모리 캐시 유지): {e}")
    return coin_engine_config


# 업비트 API — n8n 서버 프록시 경유 (IP 화이트리스트 우회)
UPBIT_PROXY_URL = "http://34.47.98.167:9090/"
UPBIT_PROXY_SECRET = "smarthub-upbit-proxy-2026"


def upbit_configured() -> bool:
    """프록시 서버 존재 여부로 판단 (로컬 키 불필요)."""
    return True  # 프록시가 키를 보유


def upbit_proxy(method: str, path: str, query: str = "", data: dict | None = None) -> dict | list:
    """n8n 서버의 업비트 프록시를 경유하여 API 호출."""
    body = {"method": method, "path": path}
    if query:
        body["query"] = query
    if data:
        body["data"] = data
    resp = requests.post(
        UPBIT_PROXY_URL,
        headers={"Content-Type": "application/json", "X-Proxy-Secret": UPBIT_PROXY_SECRET},
        json=body,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def upbit_get_accounts() -> list[dict]:
    """GET /v1/accounts — 잔고 조회 (프록시 경유)."""
    return upbit_proxy("GET", "/v1/accounts")


def upbit_get_ticker(market: str) -> dict:
    """GET /v1/ticker — 현재가 조회 (프록시 경유)."""
    data = upbit_proxy("GET", "/v1/ticker", query=f"markets={market}")
    if data and isinstance(data, list):
        return data[0]
    return {}


def upbit_place_order(market: str, side: str, **kwargs) -> dict:
    """POST /v1/orders — 주문 (프록시 경유).

    side: 'bid' (매수) | 'ask' (매도)
    매수(시장가): ord_type='price', price=투입KRW
    매도(시장가): ord_type='market', volume=수량
    """
    body = {"market": market, "side": side, **kwargs}
    return upbit_proxy("POST", "/v1/orders", data=body)


# ── 코인 자동매매 훅 (시그널 수신 시) ───────────────────────────
coin_autotrade_lock = asyncio.Lock()  # C5: 동시 시그널 직렬화


def get_active_coin_autotrade_orders(db) -> list[dict]:
    """coin_autotrade_orders에서 활성 + 재시도 대상 문서 목록 조회."""
    active = []
    for status_val in ("entered", "monitoring", "failed"):
        docs = db.collection("coin_autotrade_orders").where("status", "==", status_val).stream()
        for d in docs:
            rec = d.to_dict() or {}
            rec["_doc_id"] = d.id
            active.append(rec)
    return active


def get_latest_exited_coin_order(db, symbol: str, within_hours: int = 24) -> dict | None:
    """최근 청산된 동일 심볼 주문 1건 조회."""
    symbol_upper = (symbol or "").strip().upper().replace("KRW-", "")
    if not symbol_upper:
        return None
    try:
        docs = list(
            db.collection("coin_autotrade_orders")
            .where("symbol", "==", symbol_upper)
            .where("status", "==", "exited")
            .order_by("exitedAt", direction=deps().firestore.Query.DESCENDING)
            .limit(5)
            .stream()
        )
    except Exception:
        return None
    if not docs:
        return None
    now_kst = datetime.now(timezone(timedelta(hours=9)))
    for d in docs:
        rec = d.to_dict() or {}
        exited_at = rec.get("exitedAt")
        try:
            exited_dt = datetime.fromisoformat(exited_at) if isinstance(exited_at, str) else exited_at
            if exited_dt and exited_dt.tzinfo is None:
                exited_dt = exited_dt.replace(tzinfo=timezone(timedelta(hours=9)))
            if exited_dt and ((now_kst - exited_dt).total_seconds() / 3600) <= within_hours:
                rec["_doc_id"] = d.id
                return rec
        except Exception:
            continue
    return None


def count_coin_reentries_today(db, symbol: str) -> int:
    """오늘 동일 심볼 재진입 횟수 집계."""
    symbol_upper = (symbol or "").strip().upper().replace("KRW-", "")
    if not symbol_upper:
        return 0
    kst = timezone(timedelta(hours=9))
    kst_today = datetime.now(kst).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        docs = list(
            db.collection("coin_autotrade_orders")
            .where("symbol", "==", symbol_upper)
            .where("enteredAt", ">=", kst_today.isoformat())
            .limit(100)
            .stream()
        )
    except Exception:
        return 0
    count = 0
    for d in docs:
        rec = d.to_dict() or {}
        if rec.get("entryKind") == "reentry":
            count += 1
    return count


async def coin_autotrade_on_signal(norm: dict, signal_doc_id: str):
    """코인 signal 수신 후 자동매매 조건 체크 → 업비트 매수 주문."""
    db = deps().get_firestore()
    cfg = load_coin_autotrade_config()
    symbol_raw = norm.get("symbol", "")
    score = norm.get("score", 0)
    direction = norm.get("direction", "")
    stage = norm.get("stage", "")
    stop_loss = norm.get("stopLoss", 0)
    target_price = norm.get("targetPrice", 0) if norm.get("targetPrice") else 0
    entry_price_signal = float(norm.get("entryPrice") or 0)
    engine_cfg = load_coin_engine_config()
    symbol_upper = symbol_raw.strip().upper().replace("KRW-", "")
    symbol_cfg = coin_engine_symbol_config(symbol_upper, engine_cfg)

    # targetPrice 자동 계산: 시그널에 없으면 entryPrice +3% (백테스트 target_reached 평균 기반)
    if not target_price and entry_price_signal > 0:
        target_price = entry_price_signal * 1.03

    def _log_event(kind: str, detail: dict):
        try:
            db.collection("events").document().set({
                "kind": kind,
                **detail,
                "payload": detail,
                "created_at": deps().firestore.SERVER_TIMESTAMP,
            })
        except Exception as e:
            coin_autotrade_log.error(f"event 기록 실패: {e}")

    # 0) signalId 중복 체크 (읽기만 — 마킹은 주문 성공 후)
    if signal_doc_id:
        try:
            proc_ref = db.collection("coin_autotrade_processed").document(signal_doc_id)
            if proc_ref.get().exists:
                coin_autotrade_log.info(f"coin autotrade skip: 이미 처리된 시그널: {signal_doc_id}")
                _log_event("coin_autotrade_skip", {
                    "reason": "duplicate_signal", "symbol": symbol_raw,
                    "signalId": signal_doc_id,
                })
                return
        except Exception as e:
            # W1: fail-closed
            coin_autotrade_log.error(f"coin autotrade: 중복 체크 실패 → skip: {e}")
            _log_event("coin_autotrade_error", {
                "reason": "duplicate_check_failed", "symbol": symbol_raw,
                "signalId": signal_doc_id, "error": str(e),
            })
            return

    # 1) enabled 체크
    if not cfg.get("enabled"):
        return
    if not cfg.get("legacySignalTradingEnabled", False):
        coin_autotrade_log.info("coin autotrade skip: legacy signal trading disabled")
        return

    # 2) 조건 체크
    if stage not in cfg.get("allowedStages", []):
        coin_autotrade_log.info(f"coin autotrade skip: stage={stage} not in {cfg['allowedStages']}")
        return
    if score < cfg.get("minScore", 50):
        coin_autotrade_log.info(f"coin autotrade skip: score={score} < minScore={cfg['minScore']}")
        return
    if direction not in cfg.get("allowedDirections", ["long"]):
        coin_autotrade_log.info(f"coin autotrade skip: direction={direction} not in {cfg['allowedDirections']}")
        return

    # 심볼 허용 목록 (BTC → allowedSymbols에 BTC 있는지)
    if symbol_upper not in [s.upper() for s in cfg.get("allowedSymbols", [])]:
        coin_autotrade_log.info(f"coin autotrade skip: symbol={symbol_upper} not in allowedSymbols")
        return

    market = coin_symbol_to_market(symbol_upper)

    # 3) 해당 종목 미보유 확인 (업비트 잔고)
    try:
        accounts = await asyncio.to_thread(upbit_get_accounts)
    except Exception as e:
        coin_autotrade_log.error(f"coin autotrade error: 잔고 조회 실패: {e}")
        _log_event("coin_autotrade_error", {
            "reason": "account_fetch_failed", "symbol": symbol_raw,
            "signalId": signal_doc_id, "error": str(e),
        })
        return

    for acc in accounts:
        if acc.get("currency", "").upper() == symbol_upper:
            balance_amt = float(acc.get("balance") or 0)
            if balance_amt > 0:
                coin_autotrade_log.info(f"coin autotrade skip: 이미 보유 중: {symbol_upper} ({balance_amt})")
                _log_event("coin_autotrade_skip", {
                    "reason": "already_holding", "symbol": symbol_raw,
                    "signalId": signal_doc_id, "balance": balance_amt,
                })
                return

    # KRW 잔액
    krw_balance = 0.0
    for acc in accounts:
        if acc.get("currency", "").upper() == "KRW":
            krw_balance = float(acc.get("balance") or 0)
            break

    # 4) 동시 포지션 수 확인
    active_orders = await asyncio.to_thread(get_active_coin_autotrade_orders, db)
    max_concurrent = cfg.get("maxConcurrentPositions", 2)
    if len(active_orders) >= max_concurrent:
        coin_autotrade_log.info(f"coin autotrade skip: 동시 포지션 상한 ({len(active_orders)}/{max_concurrent})")
        _log_event("coin_autotrade_skip", {
            "reason": "max_concurrent_positions", "symbol": symbol_raw,
            "signalId": signal_doc_id,
            "currentCount": len(active_orders), "maxConcurrentPositions": max_concurrent,
        })
        return

    # 5) 총 투자 한도 확인
    current_invested = 0.0
    for o in active_orders:
        current_invested += float(o.get("investedKRW") or 0)
    max_total = cfg.get("maxTotalKRW", 200_000)
    remaining = max_total - current_invested
    if remaining <= 0:
        coin_autotrade_log.info(f"coin autotrade skip: 한도 초과 (invested={current_invested}, max={max_total})")
        _log_event("coin_autotrade_skip", {
            "reason": "budget_exceeded", "symbol": symbol_raw,
            "signalId": signal_doc_id,
            "currentInvested": current_invested, "maxTotalKRW": max_total,
        })
        return

    # 6) 일일 손실 한도 확인
    max_daily_loss = cfg.get("maxDailyLossPct", -2.0)
    try:
        kst = timezone(timedelta(hours=9))
        kst_today = datetime.now(kst).replace(hour=0, minute=0, second=0, microsecond=0)
        exited_today = list(
            db.collection("coin_autotrade_orders")
            .where("status", "==", "exited")
            .where("exitedAt", ">=", kst_today.isoformat())
            .limit(100).stream()
        )
        today_pnl_krw = sum(float((d.to_dict() or {}).get("pnlKRW") or 0) for d in exited_today)
        if max_total > 0 and max_daily_loss < 0:
            today_pnl_pct = (today_pnl_krw / max_total) * 100
            if today_pnl_pct <= max_daily_loss:
                coin_autotrade_log.warning(f"coin autotrade skip: 일일 손실 한도 ({today_pnl_pct:.2f}% <= {max_daily_loss}%)")
                _log_event("coin_autotrade_skip", {
                    "reason": "daily_loss_limit", "symbol": symbol_raw,
                    "signalId": signal_doc_id,
                    "todayPnlPct": round(today_pnl_pct, 2), "maxDailyLossPct": max_daily_loss,
                })
                return
    except Exception as e:
        coin_autotrade_log.warning(f"일일 손실 조회 실패 (진행): {e}")

    # 7) 현재가 조회
    try:
        ticker = await asyncio.to_thread(upbit_get_ticker, market)
        current_price = float(ticker.get("trade_price") or 0)
        if current_price <= 0:
            raise ValueError(f"현재가 이상: {current_price}")
    except Exception as e:
        coin_autotrade_log.error(f"coin autotrade error: 현재가 조회 실패: {market}: {e}")
        _log_event("coin_autotrade_error", {
            "reason": "price_fetch_failed", "symbol": symbol_raw,
            "signalId": signal_doc_id, "error": str(e),
        })
        return

    # 7-b) 가격 보호: entryPrice 대비 ±5% 괴리
    if entry_price_signal > 0:
        deviation = abs(current_price - entry_price_signal) / entry_price_signal
        if deviation > 0.05:
            coin_autotrade_log.warning(
                f"coin autotrade skip: 가격 괴리 {deviation:.1%} "
                f"(entry={entry_price_signal}, current={current_price})"
            )
            _log_event("coin_autotrade_skip", {
                "reason": "price_deviation", "symbol": symbol_raw,
                "signalId": signal_doc_id,
                "entryPrice": entry_price_signal, "currentPrice": current_price,
                "deviation": round(deviation, 4),
            })
            return

    # 7-c) 청산 후 눌림 재진입 규칙
    last_exited_order = await asyncio.to_thread(get_latest_exited_coin_order, db, symbol_upper, 24)
    daily_reentry_count = await asyncio.to_thread(count_coin_reentries_today, db, symbol_upper)
    reentry_allowed, reentry_detail = coin_reentry_check(
        current_price=current_price,
        symbol_cfg=symbol_cfg,
        last_exited_order=last_exited_order,
        daily_reentry_count=daily_reentry_count,
    )
    if not reentry_allowed:
        coin_autotrade_log.info(f"coin autotrade skip: 재진입 조건 미충족 {symbol_upper} {reentry_detail}")
        _log_event("coin_autotrade_skip", {
            "symbol": symbol_raw,
            "signalId": signal_doc_id,
            **reentry_detail,
        })
        return
    entry_kind = reentry_detail.get("mode", "initial_entry")

    # 8) 투입 금액 계산
    total_asset = krw_balance + current_invested
    budget_plan = coin_invest_budget_plan(
        total_asset=total_asset,
        current_invested=current_invested,
        krw_balance=krw_balance,
        max_total=max_total,
        default_position_size_pct=cfg.get("positionSizePct", 10.0),
        default_max_per_symbol=cfg.get("maxPerSymbolKRW", 100_000),
        symbol_cfg=symbol_cfg,
    )
    invest_krw = budget_plan["investKRW"]

    if invest_krw < 5000:  # 업비트 최소 주문 5,000원
        coin_autotrade_log.info(f"coin autotrade skip: 투입금 부족 (invest_krw={invest_krw})")
        _log_event("coin_autotrade_skip", {
            "reason": "budget_too_small", "symbol": symbol_raw,
            "signalId": signal_doc_id,
            "investKRW": invest_krw, "krwBalance": krw_balance,
            "sizeMultiplier": budget_plan["sizeMultiplier"],
            "maxPerSymbolKRW": budget_plan["maxPerSymbolKRW"],
        })
        return

    # 9) 주문 전 로깅
    order_detail = {
        "symbol": symbol_raw, "market": market, "side": "bid",
        "investKRW": invest_krw, "currentPrice": current_price,
        "score": score, "stage": stage, "direction": direction,
        "stopLoss": stop_loss, "targetPrice": target_price,
        "signalId": signal_doc_id,
        "entryKind": entry_kind,
        "sizeMultiplier": budget_plan["sizeMultiplier"],
        "symbolMaxPerKRW": budget_plan["maxPerSymbolKRW"],
    }
    coin_autotrade_log.info(f"coin autotrade 매수 주문 시도: {order_detail}")
    _log_event("coin_autotrade_attempt", order_detail)

    # 10) 업비트 시장가 매수 (금액 기반)
    try:
        result = await asyncio.to_thread(
            upbit_place_order, market, "bid",
            ord_type="price", price=str(invest_krw),
        )
    except Exception as e:
        coin_autotrade_log.error(f"coin autotrade error: 주문 전송 실패: {e}")
        _log_event("coin_autotrade_error", {
            **order_detail, "reason": "order_request_failed", "error": str(e),
        })
        return

    order_uuid = result.get("uuid", "")
    if not order_uuid:
        coin_autotrade_log.warning(f"coin autotrade 주문 실패: {result}")
        _log_event("coin_autotrade_error", {
            **order_detail, "reason": "order_rejected", "response": str(result)[:500],
        })
        return

    coin_autotrade_log.info(f"coin autotrade 주문 성공: uuid={order_uuid}")
    _log_event("coin_autotrade_order", {
        **order_detail, "ordUuid": order_uuid,
    })

    # 11-a) processed 마크 (C1: 주문 성공 후에만)
    if signal_doc_id:
        try:
            db.collection("coin_autotrade_processed").document(signal_doc_id).set({
                "signalId": signal_doc_id,
                "symbol": symbol_raw,
                "market": market,
                "ordUuid": order_uuid,
                "processedAt": deps().firestore.SERVER_TIMESTAMP,
            })
        except Exception as e:
            coin_autotrade_log.error(f"processed 마크 실패 (주문은 이미 나감): {e}")

    # 11-b) coin_autotrade_orders 문서 생성
    try:
        order_doc = {
            "signalId":     signal_doc_id,
            "market":       market,
            "symbol":       symbol_upper,
            "side":         "bid",
            "investedKRW":  invest_krw,
            "entryPrice":   current_price,
            "stopLoss":     stop_loss,
            "targetPrice":  target_price,
            "ordUuid":      order_uuid,
            "status":       "entered",
            "entryKind":    entry_kind,
            "reentryFromOrderId": (last_exited_order or {}).get("_doc_id"),
            "enteredAt":    datetime.now(timezone(timedelta(hours=9))).isoformat(),
            "exitedAt":     None,
            "exitOrdUuid":  None,
            "exitPrice":    None,
            "pnlKRW":       None,
            "pnlPct":       None,
            "exitReason":   None,
            "partialExitDone": False,
            "partialExitAt": None,
            "partialExitPrice": None,
            "partialExitVolume": None,
            "partialExitOrdUuid": None,
            "partialTakeProfitPct": symbol_cfg.get("partialTakeProfitPct"),
            "partialTakeProfitRatio": symbol_cfg.get("partialTakeProfitRatio"),
            "reentryDipPct": symbol_cfg.get("reentryDipPct"),
            "maxDailyReentries": symbol_cfg.get("maxDailyReentries"),
            "created_at":   deps().firestore.SERVER_TIMESTAMP,
        }
        db.collection("coin_autotrade_orders").document(signal_doc_id).set(order_doc)
        coin_autotrade_log.info(f"coin_autotrade_orders 문서 생성: {signal_doc_id}")

        # 텔레그램 매수 알림
        try:
            deps().send_telegram(
                f"🪙 [코인 자동매매] 매수\n"
                f"종목: {symbol_upper}\n"
                f"투입: {invest_krw:,}원\n"
                f"가격: {current_price:,.0f}원\n"
                f"시그널: score={score}"
            )
        except Exception as tg_err:
            coin_autotrade_log.warning(f"텔레그램 매수 알림 실패 (무시): {tg_err}")

    except Exception as e:
        # W7: 주문은 나갔는데 문서 실패 → 비상 정지
        coin_autotrade_log.critical(
            f"CRITICAL: 주문 성공({order_uuid}) but coin_autotrade_orders 생성 실패: {e}"
        )
        _log_event("coin_autotrade_critical", {
            **order_detail, "ordUuid": order_uuid,
            "reason": "order_doc_creation_failed", "error": str(e),
        })
        try:
            save_coin_autotrade_config({"enabled": False})
            coin_autotrade_log.critical("코인 자동매매 비활성화됨 (문서 생성 실패 안전장치)")
        except Exception:
            pass


async def safe_coin_autotrade_on_signal(norm: dict, signal_doc_id: str):
    """C4: ensure_future 예외 래퍼 + C5: 동시성 보호."""
    async with coin_autotrade_lock:
        try:
            await coin_autotrade_on_signal(norm, signal_doc_id)
        except Exception as e:
            coin_autotrade_log.error(f"coin autotrade 미처리 예외: {e}", exc_info=True)
            try:
                db = deps().get_firestore()
                db.collection("events").document().set({
                    "kind": "coin_autotrade_unhandled_error",
                    "signalId": signal_doc_id,
                    "symbol": norm.get("symbol", ""),
                    "error": str(e),
                    "errorType": type(e).__name__,
                    "payload": {"signalId": signal_doc_id, "error": str(e)},
                    "created_at": deps().firestore.SERVER_TIMESTAMP,
                })
            except Exception:
                pass


# ── 코인 자동매매 모니터링 루프 (24/7) ──────────────────────────
coin_monitor_task: asyncio.Task | None = None


async def coin_autotrade_monitor_loop():
    """24시간 1분 간격 폴링 — 손절/익절/보유시간 초과/일일손실 청산."""
    coin_autotrade_log.info("coin autotrade monitor loop started")
    while True:
        try:
            db = deps().get_firestore()
            active_orders = await asyncio.to_thread(get_active_coin_autotrade_orders, db)

            if not active_orders:
                await asyncio.sleep(60)
                continue

            cfg = load_coin_autotrade_config()
            engine_cfg = load_coin_engine_config()
            max_hold_hours = cfg.get("maxHoldHours", 24)
            max_daily_loss = cfg.get("maxDailyLossPct", -2.0)
            max_total = cfg.get("maxTotalKRW", 200_000)

            # 일일 손실 체크 (전체 포지션 공통)
            daily_loss_triggered = False
            try:
                kst = timezone(timedelta(hours=9))
                kst_today = datetime.now(kst).replace(hour=0, minute=0, second=0, microsecond=0)
                exited_today = list(
                    db.collection("coin_autotrade_orders")
                    .where("status", "==", "exited")
                    .where("exitedAt", ">=", kst_today.isoformat())
                    .limit(100).stream()
                )
                today_pnl_krw = sum(float((d.to_dict() or {}).get("pnlKRW") or 0) for d in exited_today)
                if max_total > 0 and max_daily_loss < 0:
                    today_pnl_pct = (today_pnl_krw / max_total) * 100
                    if today_pnl_pct <= max_daily_loss:
                        daily_loss_triggered = True
            except Exception as e:
                coin_autotrade_log.warning(f"일일 손실 조회 실패: {e}")

            for order in active_orders:
                doc_id = order.get("_doc_id", "")
                market = order.get("market", "")
                symbol = order.get("symbol", "")
                symbol_cfg = coin_engine_symbol_config(symbol, engine_cfg)
                entry_price = float(order.get("entryPrice") or 0)
                sl = float(order.get("stopLoss") or 0)
                tp = float(order.get("targetPrice") or 0)
                invested_krw = float(order.get("investedKRW") or 0)

                if not market or entry_price <= 0:
                    continue

                # 현재가 조회
                try:
                    ticker = await asyncio.to_thread(upbit_get_ticker, market)
                    current_price = float(ticker.get("trade_price") or 0)
                    if current_price <= 0:
                        continue
                except Exception as e:
                    coin_autotrade_log.warning(f"monitor: 시세 조회 실패 {market}: {e}")
                    continue

                exit_reason = None
                pnl_pct = (current_price - entry_price) / entry_price * 100

                # trailing stop: 고점 대비 하락 시 익절
                peak_price = float(order.get("peakPrice") or entry_price)
                if current_price > peak_price:
                    peak_price = current_price
                    try:
                        db.collection("coin_autotrade_orders").document(doc_id).update({"peakPrice": peak_price})
                    except Exception:
                        pass
                peak_pnl_pct = (peak_price - entry_price) / entry_price * 100

                # 보유 시간 계산 (R7: 안전 파싱)
                entered_at = order.get("enteredAt")
                hold_hours = 0.0
                if entered_at:
                    try:
                        if isinstance(entered_at, str):
                            entry_dt = datetime.fromisoformat(entered_at)
                        elif hasattr(entered_at, "timestamp"):
                            entry_dt = entered_at
                        else:
                            entry_dt = None
                        if entry_dt:
                            kst_now = datetime.now(timezone(timedelta(hours=9)))
                            if entry_dt.tzinfo is None:
                                entry_dt = entry_dt.replace(tzinfo=timezone(timedelta(hours=9)))
                            hold_hours = (kst_now - entry_dt).total_seconds() / 3600
                    except (ValueError, TypeError):
                        hold_hours = 0.0

                order_partial_cfg = {
                    "partialTakeProfitPct": order.get("partialTakeProfitPct", symbol_cfg.get("partialTakeProfitPct")),
                    "partialTakeProfitRatio": order.get("partialTakeProfitRatio", symbol_cfg.get("partialTakeProfitRatio")),
                }

                # 부분익절: +N% 도달 시 일부만 먼저 매도하고, 나머지는 trailing/hold로 관리
                partial_plan = coin_partial_take_profit_plan(
                    current_price=current_price,
                    entry_price=entry_price,
                    current_volume=0.0,  # balance 조회 후 보정
                    order=order,
                    symbol_cfg=order_partial_cfg,
                )
                if partial_plan.get("thresholdPct") and not partial_plan.get("shouldSell"):
                    order["_partialThresholdPct"] = partial_plan["thresholdPct"]
                if partial_plan.get("thresholdPct") and not order.get("partialExitDone"):
                    balance_volume = 0.0
                    try:
                        accs = await asyncio.to_thread(upbit_get_accounts)
                        for acc in accs:
                            if acc.get("currency", "").upper() == symbol.upper():
                                balance_volume = float(acc.get("balance") or 0)
                                break
                    except Exception as e:
                        coin_autotrade_log.warning(f"monitor: 부분익절 잔고 조회 실패 {symbol}: {e}")
                    partial_plan = coin_partial_take_profit_plan(
                        current_price=current_price,
                        entry_price=entry_price,
                        current_volume=balance_volume,
                        order=order,
                        symbol_cfg=order_partial_cfg,
                    )
                    if partial_plan.get("shouldSell"):
                        sell_volume = partial_plan["sellVolume"]
                        try:
                            partial_result = await asyncio.to_thread(
                                upbit_place_order, market, "ask",
                                ord_type="market", volume=str(sell_volume),
                            )
                            partial_uuid = partial_result.get("uuid", "")
                            if partial_uuid:
                                remain_ratio = max(0.0, 1.0 - float(partial_plan["sellRatio"]))
                                db.collection("coin_autotrade_orders").document(doc_id).update({
                                    "status": "monitoring",
                                    "partialExitDone": True,
                                    "partialExitAt": datetime.now(timezone(timedelta(hours=9))).isoformat(),
                                    "partialExitPrice": current_price,
                                    "partialExitVolume": sell_volume,
                                    "partialExitOrdUuid": partial_uuid,
                                    "investedKRW": round(invested_krw * remain_ratio, 2),
                                })
                                db.collection("events").document().set({
                                    "kind": "coin_autotrade_partial_exit",
                                    "symbol": symbol,
                                    "market": market,
                                    "signalId": order.get("signalId", ""),
                                    "price": current_price,
                                    "volume": sell_volume,
                                    "thresholdPct": partial_plan["thresholdPct"],
                                    "payload": {
                                        "symbol": symbol,
                                        "market": market,
                                        "price": current_price,
                                        "volume": sell_volume,
                                        "thresholdPct": partial_plan["thresholdPct"],
                                    },
                                    "created_at": deps().firestore.SERVER_TIMESTAMP,
                                })
                                continue
                        except Exception as e:
                            coin_autotrade_log.error(f"monitor: 부분익절 주문 실패 {market}: {e}")
                            try:
                                db.collection("events").document().set({
                                    "kind": "coin_autotrade_error",
                                    "reason": "partial_exit_order_failed",
                                    "market": market,
                                    "symbol": symbol,
                                    "error": str(e),
                                    "payload": {"reason": "partial_exit_order_failed", "market": market, "symbol": symbol, "error": str(e)},
                                    "created_at": deps().firestore.SERVER_TIMESTAMP,
                                })
                            except Exception:
                                pass

                # 조건 체크 (우선순위: 일일손실 > 손절 > 익절 > trailing stop > 보유시간)
                if daily_loss_triggered:
                    exit_reason = "daily_loss_limit"
                elif sl > 0 and current_price <= sl:
                    exit_reason = "stop_loss"
                elif tp > 0 and current_price >= tp and not order_partial_cfg.get("partialTakeProfitPct"):
                    exit_reason = "take_profit"
                elif peak_pnl_pct >= 1.0 and pnl_pct <= peak_pnl_pct - 0.5:
                    # trailing stop: +1% 이상 갔다가 고점 대비 0.5%p 하락하면 익절
                    exit_reason = "trailing_stop"
                elif max_hold_hours > 0 and hold_hours >= max_hold_hours:
                    exit_reason = "hold_expired"

                if not exit_reason:
                    if order.get("status") == "entered":
                        try:
                            db.collection("coin_autotrade_orders").document(doc_id).update({"status": "monitoring"})
                        except Exception:
                            pass
                    continue

                # 매도 실행 — 업비트 잔고에서 실보유 수량 조회
                coin_autotrade_log.info(
                    f"monitor: 매도 트리거 {market} reason={exit_reason} "
                    f"price={current_price} entry={entry_price} pnl={pnl_pct:.2f}%"
                )

                try:
                    db.collection("coin_autotrade_orders").document(doc_id).update({"status": "exit_triggered"})
                except Exception:
                    pass

                # 보유 수량 조회
                sell_volume = 0.0
                try:
                    accs = await asyncio.to_thread(upbit_get_accounts)
                    for acc in accs:
                        if acc.get("currency", "").upper() == symbol.upper():
                            sell_volume = float(acc.get("balance") or 0)
                            break
                except Exception as e:
                    coin_autotrade_log.error(f"monitor: 잔고 조회 실패 {symbol}: {e}")

                if sell_volume <= 0:
                    coin_autotrade_log.warning(f"monitor: 보유 수량 없음 {symbol} → exited 처리")
                    try:
                        db.collection("coin_autotrade_orders").document(doc_id).update({
                            "status": "exited",
                            "exitedAt": datetime.now(timezone(timedelta(hours=9))).isoformat(),
                            "exitReason": exit_reason,
                            "exitPrice": current_price,
                            "pnlKRW": 0, "pnlPct": 0,
                            "note": "no_balance_found",
                        })
                    except Exception:
                        pass
                    continue

                try:
                    sell_result = await asyncio.to_thread(
                        upbit_place_order, market, "ask",
                        ord_type="market", volume=str(sell_volume),
                    )
                except Exception as e:
                    coin_autotrade_log.error(f"monitor: 매도 주문 전송 실패 {market}: {e}")
                    try:
                        db.collection("coin_autotrade_orders").document(doc_id).update({"status": "failed"})
                        db.collection("events").document().set({
                            "kind": "coin_autotrade_error",
                            "reason": "exit_order_failed",
                            "market": market, "exitReason": exit_reason,
                            "error": str(e),
                            "payload": {"reason": "exit_order_failed", "market": market, "error": str(e)},
                            "created_at": deps().firestore.SERVER_TIMESTAMP,
                        })
                    except Exception:
                        pass
                    continue

                exit_uuid = sell_result.get("uuid", "")
                if exit_uuid:
                    pnl_krw = (current_price - entry_price) * sell_volume
                    try:
                        db.collection("coin_autotrade_orders").document(doc_id).update({
                            "status":      "exited",
                            "exitedAt":    datetime.now(timezone(timedelta(hours=9))).isoformat(),
                            "exitOrdUuid": exit_uuid,
                            "exitPrice":   current_price,
                            "pnlKRW":      round(pnl_krw, 0),
                            "pnlPct":      round(pnl_pct, 4),
                            "exitReason":  exit_reason,
                        })
                    except Exception as e:
                        coin_autotrade_log.error(f"monitor: coin_autotrade_orders 업데이트 실패: {e}")

                    try:
                        db.collection("events").document().set({
                            "kind": "coin_autotrade_exit",
                            "market": market, "symbol": symbol,
                            "exitReason": exit_reason,
                            "exitPrice": current_price, "entryPrice": entry_price,
                            "volume": sell_volume,
                            "pnlKRW": round(pnl_krw, 0), "pnlPct": round(pnl_pct, 4),
                            "signalId": order.get("signalId", ""),
                            "payload": {
                                "market": market, "exitReason": exit_reason,
                                "exitPrice": current_price, "entryPrice": entry_price,
                                "volume": sell_volume,
                                "pnlKRW": round(pnl_krw, 0), "pnlPct": round(pnl_pct, 4),
                            },
                            "created_at": deps().firestore.SERVER_TIMESTAMP,
                        })
                    except Exception:
                        pass
                    coin_autotrade_log.info(
                        f"monitor: 매도 성공 {market} reason={exit_reason} "
                        f"pnl={pnl_krw:+,.0f}원 ({pnl_pct:+.2f}%)"
                    )

                    # 텔레그램 청산 알림
                    try:
                        deps().send_telegram(
                            f"🪙 [코인 자동매매] 청산\n"
                            f"종목: {symbol}\n"
                            f"사유: {exit_reason}\n"
                            f"PnL: {pnl_pct:+.2f}%"
                        )
                    except Exception as tg_err:
                        coin_autotrade_log.warning(f"텔레그램 청산 알림 실패 (무시): {tg_err}")

                else:
                    coin_autotrade_log.warning(f"monitor: 매도 실패 {market}: {sell_result}")
                    try:
                        db.collection("coin_autotrade_orders").document(doc_id).update({"status": "failed"})
                        db.collection("events").document().set({
                            "kind": "coin_autotrade_error",
                            "reason": "exit_order_rejected",
                            "market": market, "exitReason": exit_reason,
                            "response": str(sell_result)[:500],
                            "payload": {"reason": "exit_order_rejected", "market": market},
                            "created_at": deps().firestore.SERVER_TIMESTAMP,
                        })
                    except Exception:
                        pass

                # 일일 손실 트리거 시 enabled=false
                if daily_loss_triggered:
                    try:
                        save_coin_autotrade_config({"enabled": False})
                        coin_autotrade_log.warning("일일 손실 한도 초과 → 코인 자동매매 비활성화")
                        db.collection("events").document().set({
                            "kind": "coin_autotrade_daily_loss_halt",
                            "payload": {"todayPnlPct": today_pnl_pct, "maxDailyLossPct": max_daily_loss},
                            "created_at": deps().firestore.SERVER_TIMESTAMP,
                        })
                    except Exception:
                        pass
                    break  # 전체 매도 완료 후 루프 종료

                await asyncio.sleep(0.1)

        except Exception as e:
            coin_autotrade_log.error(f"coin monitor loop error: {e}")

        await asyncio.sleep(60)


async def coin_autotrade_monitor_watchdog():
    """C2: 코인 모니터링 루프 watchdog — 루프가 죽으면 재시작."""
    global coin_monitor_task
    while True:
        await asyncio.sleep(120)
        if coin_monitor_task is None or coin_monitor_task.done():
            exc = coin_monitor_task.exception() if coin_monitor_task and coin_monitor_task.done() else None
            coin_autotrade_log.critical(f"coin monitor loop DEAD, restarting. exc={exc}")
            try:
                db = deps().get_firestore()
                db.collection("events").document().set({
                    "kind": "coin_autotrade_monitor_restart",
                    "error": str(exc) if exc else "task done unexpectedly",
                    "payload": {"error": str(exc)},
                    "created_at": deps().firestore.SERVER_TIMESTAMP,
                })
            except Exception:
                pass
            coin_monitor_task = asyncio.create_task(coin_autotrade_monitor_loop())


async def start_coin_autotrade_monitor():
    """서버 시작 시 TRX 자체 전략 루프를 생성한다."""
    await start_trx_strategy_loop(
        deps().get_firestore(),
        deps().firestore,
        enabled_checker=lambda: bool(load_coin_autotrade_config().get("enabled")),
    )
    coin_autotrade_log.info("TRX strategy loop created on startup")




@router.get("/api/coin/autotrade/config")
async def api_coin_autotrade_config_get(user: dict = Depends(coin_auth)):
    """Coin autotrade config with dynamic dashboard fields."""
    d = deps()
    d.ensure_admin(user)
    cfg = load_coin_autotrade_config(force=True)
    extra: dict = {}
    try:
        db = d.get_firestore()
        active_orders = get_active_coin_autotrade_orders(db)
        extra["currentInvestedKRW"] = sum(float(o.get("investedKRW") or 0) for o in active_orders)
        extra["activePositionCount"] = len(active_orders)
    except Exception:
        extra["currentInvestedKRW"] = 0
        extra["activePositionCount"] = 0
    try:
        kst = timezone(timedelta(hours=9))
        kst_today = datetime.now(kst).replace(hour=0, minute=0, second=0, microsecond=0)
        exited_today = list(
            db.collection("coin_autotrade_orders")
            .where("status", "==", "exited")
            .where("exitedAt", ">=", kst_today.isoformat())
            .limit(100)
            .stream()
        )
        today_pnl_krw = sum(float((doc.to_dict() or {}).get("pnlKRW") or 0) for doc in exited_today)
        max_total = cfg.get("maxTotalKRW", 200_000)
        extra["todayPnlPct"] = round((today_pnl_krw / max_total) * 100, 2) if max_total > 0 else 0
        extra["todayPnlKRW"] = round(today_pnl_krw, 0)
    except Exception:
        extra["todayPnlPct"] = 0
        extra["todayPnlKRW"] = 0
    extra["upbitConfigured"] = upbit_configured()
    return {**cfg, **extra}


@router.get("/api/coin/trx-strategy/state")
async def api_coin_trx_strategy_state(user: dict = Depends(coin_auth)):
    """Read TRX DCA strategy state for the operations dashboard."""
    d = deps()
    d.ensure_admin(user)
    try:
        doc = d.get_firestore().collection("settings").document("coin-trx-strategy-state").get()
        if not doc.exists:
            return {"ok": True, "state": None}
        state = doc.to_dict() or {}
        for key in ("noPositionSince", "updatedAt"):
            value = state.get(key)
            if hasattr(value, "isoformat"):
                state[key] = value.isoformat()
        return {"ok": True, "state": state}
    except Exception:
        return {"ok": False, "error": "TRX strategy state 조회 실패"}


@router.post("/api/coin/autotrade/config")
async def api_coin_autotrade_config_post(req: Request, user: dict = Depends(coin_auth)):
    """Update coin autotrade config."""
    d = deps()
    d.ensure_admin(user)
    body = await req.json()

    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise HTTPException(400, "enabled must be bool")
        if body["enabled"] and not upbit_configured():
            raise HTTPException(503, "UPBIT_ACCESS_KEY/SECRET_KEY가 설정되지 않았습니다.")
    if "maxTotalKRW" in body:
        v = body["maxTotalKRW"]
        if not isinstance(v, (int, float)) or v < 10000 or v > 5_000_000:
            raise HTTPException(400, "maxTotalKRW must be 10,000~5,000,000")
    if "maxPerSymbolKRW" in body:
        v = body["maxPerSymbolKRW"]
        if not isinstance(v, (int, float)) or v < 5000 or v > 2_000_000:
            raise HTTPException(400, "maxPerSymbolKRW must be 5,000~2,000,000")
    if "minScore" in body:
        v = body["minScore"]
        if not isinstance(v, (int, float)) or v < 1 or v > 100:
            raise HTTPException(400, "minScore must be 1~100")
    if "allowedStages" in body:
        v = body["allowedStages"]
        valid_stages = {"candidate", "trade_ready"}
        if not isinstance(v, list) or not all(s in valid_stages for s in v):
            raise HTTPException(400, f"allowedStages must be subset of {valid_stages}")
    if "allowedSymbols" in body:
        v = body["allowedSymbols"]
        if not isinstance(v, list) or not all(isinstance(s, str) for s in v):
            raise HTTPException(400, "allowedSymbols must be list of strings")
    if "allowedDirections" in body:
        v = body["allowedDirections"]
        valid_dirs = {"long", "short"}
        if not isinstance(v, list) or not all(direction in valid_dirs for direction in v):
            raise HTTPException(400, f"allowedDirections must be subset of {valid_dirs}")
    if "maxConcurrentPositions" in body:
        v = body["maxConcurrentPositions"]
        if not isinstance(v, int) or v < 1 or v > 10:
            raise HTTPException(400, "maxConcurrentPositions must be int 1~10")
    if "maxDailyLossPct" in body:
        v = body["maxDailyLossPct"]
        if not isinstance(v, (int, float)) or v < -50.0 or v > 0:
            raise HTTPException(400, "maxDailyLossPct must be float -50.0~0")
    if "maxHoldHours" in body:
        v = body["maxHoldHours"]
        if not isinstance(v, (int, float)) or v < 1 or v > 168:
            raise HTTPException(400, "maxHoldHours must be 1~168")
    if "positionSizePct" in body:
        v = body["positionSizePct"]
        if not isinstance(v, (int, float)) or v < 1.0 or v > 50.0:
            raise HTTPException(400, "positionSizePct must be 1.0~50.0")

    allowed_keys = {
        "enabled", "maxTotalKRW", "maxPerSymbolKRW", "minScore", "allowedStages",
        "allowedSymbols", "allowedDirections", "maxConcurrentPositions",
        "maxDailyLossPct", "maxHoldHours", "positionSizePct",
    }
    updates = {}
    changed = {}
    current_cfg = load_coin_autotrade_config(force=True)
    for key in allowed_keys:
        if key in body:
            old = current_cfg.get(key)
            updates[key] = body[key]
            changed[key] = {"old": old, "new": body[key]}

    if updates:
        save_coin_autotrade_config(updates)

    if changed:
        try:
            db = d.get_firestore()
            db.collection("events").document().set({
                "kind": "coin_autotrade_config_change",
                "changes": changed,
                "by": user.get("email", ""),
                "payload": {"changes": changed, "by": user.get("email", "")},
                "created_at": d.firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            pass

    return {"ok": True, "config": {**coin_autotrade_config}, "changed": changed}


@router.post("/api/coin/autotrade/kill")
async def api_coin_autotrade_kill(user: dict = Depends(coin_auth)):
    """Emergency-stop coin autotrade."""
    d = deps()
    d.ensure_admin(user)
    was_enabled = load_coin_autotrade_config(force=True).get("enabled", False)
    save_coin_autotrade_config({"enabled": False})

    try:
        db = d.get_firestore()
        db.collection("events").document().set({
            "kind": "coin_autotrade_kill",
            "wasEnabled": was_enabled,
            "by": user.get("email", ""),
            "payload": {
                "wasEnabled": was_enabled,
                "by": user.get("email", ""),
                "timestamp": datetime.now(timezone(timedelta(hours=9))).isoformat(),
            },
            "created_at": d.firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass

    coin_autotrade_log.warning(
        f"COIN AUTOTRADE KILL by {user.get('email', 'unknown')} (was_enabled={was_enabled})"
    )
    return {"ok": True, "enabled": False, "wasEnabled": was_enabled}


@router.get("/api/coin/autotrade/orders")
async def api_coin_autotrade_orders(
    status: str | None = Query(default=None),
    limit: int = Query(default=50, le=200),
    user: dict = Depends(coin_auth),
):
    """List coin autotrade orders."""
    d = deps()
    d.ensure_admin(user)
    try:
        db = d.get_firestore()
        q = db.collection("coin_autotrade_orders").order_by(
            "created_at",
            direction=d.firestore.Query.DESCENDING,
        )
        if status:
            q = db.collection("coin_autotrade_orders").where("status", "==", status).order_by(
                "created_at",
                direction=d.firestore.Query.DESCENDING,
            )
        docs = list(q.limit(limit).stream())
        return {"items": [d.doc_to_dict(doc) for doc in docs]}
    except Exception:
        return {"items": [], "error": "coin_autotrade_orders 조회 실패"}


@router.get("/api/signals")
async def api_signals(
    limit: int = Query(default=50, le=200),
    status: str | None = Query(default=None),
    stage: str | None = Query(default=None),
    user: dict = Depends(coin_auth),
):
    """List recent candidate signals."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("signals").order_by("created_at", direction=d.firestore.Query.DESCENDING)
        try:
            if status:
                q = q.where("status", "==", status)
            if stage:
                q = q.where("stage", "==", stage)
            items = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
        except Exception:
            q = db.collection("signals").order_by("created_at", direction=d.firestore.Query.DESCENDING)
            items = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
            if status:
                items = [item for item in items if item.get("status") == status]
            if stage:
                items = [item for item in items if item.get("stage") == stage]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "signals 조회 실패"}


@router.get("/api/paper-trades")
async def api_paper_trades(
    status: str | None = Query(default="open"),
    limit: int = Query(default=50, le=200),
    user: dict = Depends(coin_auth),
):
    """List active crypto paper trades."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("paper_trades").order_by("created_at", direction=d.firestore.Query.DESCENDING)
        try:
            if status:
                q = q.where("status", "==", status)
            items = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
        except Exception:
            q = db.collection("paper_trades").order_by("created_at", direction=d.firestore.Query.DESCENDING)
            all_items = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
            items = [item for item in all_items if item.get("status") == status] if status else all_items
        return {"items": items}
    except Exception:
        return {"items": [], "error": "paper_trades 조회 실패"}


@router.get("/api/trade-results")
async def api_trade_results(
    limit: int = Query(default=100, le=500),
    source: str | None = Query(default=None),
    after: str | None = Query(default=None),
    before: str | None = Query(default=None),
    strategy_version: str | None = Query(default=None, alias="strategyVersion"),
    user: dict = Depends(coin_auth),
):
    """List recent completed trade results."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=d.firestore.Query.DESCENDING)
        try:
            if source:
                q = q.where("source", "==", source)
            items = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
        except Exception:
            all_items = [
                d.doc_to_dict(doc)
                for doc in db.collection("trade_results")
                .order_by("created_at", direction=d.firestore.Query.DESCENDING)
                .limit(limit)
                .stream()
            ]
            items = [item for item in all_items if item.get("source") == source] if source else all_items
        if after:
            items = [item for item in items if (item.get("occurredAt") or item.get("created_at", "")) >= after]
        if before:
            items = [item for item in items if (item.get("occurredAt") or item.get("created_at", "")) <= before]
        if strategy_version:
            items = [item for item in items if item.get("strategyVersion") == strategy_version]
        return {"items": items}
    except Exception:
        return {"items": [], "error": "trade_results 조회 실패"}


@router.get("/api/performance")
async def api_performance(
    count: int = Query(default=50, le=500),
    source: str | None = Query(default=None),
    symbol: str | None = Query(default=None),
    direction: str | None = Query(default=None),
    after: str | None = Query(default=None),
    before: str | None = Query(default=None),
    excludeSymbols: str | None = Query(default=None),
    strategy_version: str | None = Query(default=None, alias="strategyVersion"),
    user: dict = Depends(coin_auth),
):
    """Performance summary from trade_results."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=d.firestore.Query.DESCENDING)
        try:
            if source:
                q = q.where("source", "==", source)
            results = [d.doc_to_dict(doc) for doc in q.limit(count).stream()]
        except Exception:
            all_docs = [
                d.doc_to_dict(doc)
                for doc in db.collection("trade_results")
                .order_by("created_at", direction=d.firestore.Query.DESCENDING)
                .limit(count)
                .stream()
            ]
            results = [r for r in all_docs if r.get("source") == source] if source else all_docs
        if symbol:
            sym_upper = symbol.upper().replace("/KRW", "").replace("KRW-", "")
            results = [
                r for r in results
                if r.get("symbol", "").upper().replace("/KRW", "").replace("KRW-", "") == sym_upper
            ]
        if direction:
            results = [r for r in results if r.get("direction", "").upper() == direction.upper()]
        if after:
            results = [r for r in results if (r.get("occurredAt") or r.get("created_at", "")) >= after]
        if before:
            results = [r for r in results if (r.get("occurredAt") or r.get("created_at", "")) <= before]
        if excludeSymbols:
            ex_set = {s.strip().upper() for s in excludeSymbols.split(",") if s.strip()}
            results = [
                r for r in results
                if r.get("symbol", "").upper().replace("/KRW", "").replace("KRW-", "") not in ex_set
            ]
        if strategy_version:
            results = [r for r in results if r.get("strategyVersion") == strategy_version]

        overall = d.compute_perf_stats(results)
        long_results = [r for r in results if r.get("direction", "long") == "long"]
        short_results = [r for r in results if r.get("direction") == "short"]
        return {
            **overall,
            "byDirection": {
                "long": d.compute_perf_stats(long_results),
                "short": d.compute_perf_stats(short_results),
            },
        }
    except Exception:
        return {"total": 0, "error": "performance 계산 실패"}


@router.get("/api/performance/by-symbol")
async def api_performance_by_symbol(
    source: str | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(coin_auth),
):
    """Performance comparison grouped by symbol and direction."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=d.firestore.Query.DESCENDING)
        try:
            if source and source != "all":
                q = q.where("source", "==", source)
            results = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
        except Exception:
            all_docs = [
                d.doc_to_dict(doc)
                for doc in db.collection("trade_results")
                .order_by("created_at", direction=d.firestore.Query.DESCENDING)
                .limit(limit)
                .stream()
            ]
            results = [r for r in all_docs if r.get("source") == source] if (source and source != "all") else all_docs

        groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for result in results:
            sym = (result.get("symbol") or "UNKNOWN").upper().replace("/KRW", "").replace("KRW-", "")
            dirn = (result.get("direction") or "long").lower()
            groups[(sym, dirn)].append(result)

        items = []
        for (sym, dirn), trades in groups.items():
            total = len(trades)
            wins_list = [trade for trade in trades if trade.get("result") == "win"]
            losses_list = [trade for trade in trades if trade.get("result") == "loss"]
            wins = len(wins_list)
            losses = len(losses_list)
            win_rate = wins / total if total > 0 else 0
            pnl_values = [trade.get("pnlPercent", 0) for trade in trades]
            avg_pnl = sum(pnl_values) / total if total > 0 else 0
            avg_win = sum(trade.get("pnlPercent", 0) for trade in wins_list) / wins if wins else 0
            avg_loss = sum(abs(trade.get("pnlPercent", 0)) for trade in losses_list) / losses if losses else 0
            expectation = (win_rate * avg_win) - ((1 - win_rate) * avg_loss)

            cumulative = 0.0
            peak = 0.0
            max_dd = 0.0
            for trade in sorted(trades, key=lambda x: x.get("created_at", "")):
                cumulative += trade.get("pnlPercent", 0)
                peak = max(peak, cumulative)
                max_dd = max(max_dd, peak - cumulative)

            if expectation > 0 and win_rate >= 0.40:
                verdict = "검토 가능"
            elif win_rate >= 0.35:
                verdict = "경계"
            else:
                verdict = "보류"

            items.append({
                "symbol": sym,
                "direction": dirn,
                "total": total,
                "wins": wins,
                "losses": losses,
                "winRate": round(win_rate, 4),
                "avgPnlPct": round(avg_pnl, 2),
                "expectation": round(expectation, 2),
                "maxDrawdownPct": round(max_dd, 2),
                "verdict": verdict,
            })

        items.sort(key=lambda x: x["expectation"], reverse=True)
        return {"ok": True, "items": items}
    except Exception:
        return {"ok": False, "items": [], "error": "by-symbol 성과 계산 실패"}


@router.get("/api/trade-results/pnl-series")
async def api_trade_results_pnl_series(
    source: str | None = Query(default=None),
    symbol: str | None = Query(default=None),
    limit: int = Query(default=500, le=1000),
    user: dict = Depends(coin_auth),
):
    """Cumulative PnL series for charting."""
    d = deps()
    try:
        db = d.get_firestore()
        q = db.collection("trade_results").order_by("created_at", direction=d.firestore.Query.ASCENDING)
        try:
            if source and source != "all":
                q = q.where("source", "==", source)
            results = [d.doc_to_dict(doc) for doc in q.limit(limit).stream()]
        except Exception:
            all_docs = [
                d.doc_to_dict(doc)
                for doc in db.collection("trade_results")
                .order_by("created_at", direction=d.firestore.Query.ASCENDING)
                .limit(limit)
                .stream()
            ]
            results = [r for r in all_docs if r.get("source") == source] if (source and source != "all") else all_docs

        if symbol:
            sym_upper = symbol.upper().replace("/KRW", "").replace("KRW-", "")
            results = [
                r for r in results
                if r.get("symbol", "").upper().replace("/KRW", "").replace("KRW-", "") == sym_upper
            ]

        cumulative = 0.0
        series = []
        for result in results:
            pnl = result.get("pnlPercent", 0)
            cumulative += pnl
            date_str = result.get("occurredAt") or result.get("created_at", "")
            if date_str and len(date_str) >= 10:
                date_str = date_str[:10]
            sym = (result.get("symbol") or "").upper().replace("/KRW", "").replace("KRW-", "")
            series.append({
                "date": date_str,
                "pnlPct": round(pnl, 2),
                "cumulativePnlPct": round(cumulative, 2),
                "symbol": sym,
                "result": result.get("result", ""),
            })

        return {"ok": True, "series": series}
    except Exception:
        return {"ok": False, "series": [], "error": "PnL 시계열 생성 실패"}


@router.post("/api/backtest/sweep")
async def run_backtest_sweep(req: BacktestSweepRequest, user: dict = Depends(coin_auth)):
    """Run score cutoff sweep by calling the n8n backtest webhook."""
    d = deps()
    cutoffs = req.scoreCutoffs
    if not cutoffs or len(cutoffs) > 10:
        return {"ok": False, "error": "scoreCutoffs는 1~10개"}

    results = []
    for cutoff in cutoffs:
        try:
            resp = requests.post(
                "https://n8n.banghub.kr/webhook/run-backtest",
                headers={"X-Webhook-Secret": d.webhook_secret, "Content-Type": "application/json"},
                json={
                    "market": req.market,
                    "startDate": req.startDate,
                    "endDate": req.endDate,
                    "scoreCutoff": cutoff,
                    "maxHoldMin": req.maxHoldMin,
                },
                timeout=60,
            )
            try:
                body = resp.json()
            except Exception:
                body = {}
            results.append({"scoreCutoff": cutoff, "ok": resp.status_code < 400, **body})
        except Exception:
            results.append({"scoreCutoff": cutoff, "ok": False, "error": "호출 실패"})

    return {"ok": True, "results": results}


@router.get("/api/coin/engine-config")
async def api_coin_engine_config_get(user: dict = Depends(coin_auth)):
    """Read coin strategy engine config."""
    d = deps()
    d.ensure_admin(user)
    try:
        db = d.get_firestore()
        doc = db.collection("settings").document("coin-engine").get()
        if doc.exists:
            cfg = doc.to_dict()
            for ts_key in ("updated_at",):
                if cfg.get(ts_key) and hasattr(cfg[ts_key], "isoformat"):
                    cfg[ts_key] = cfg[ts_key].isoformat()
            return {"ok": True, "config": cfg}
        return {"ok": True, "config": {"symbols": {}}}
    except Exception:
        return {"ok": False, "error": "engine-config 조회 실패"}


@router.post("/api/coin/engine-config")
async def api_coin_engine_config_post(req: Request, user: dict = Depends(coin_auth)):
    """Update coin strategy engine symbol config."""
    d = deps()
    d.ensure_admin(user)
    body = await req.json()
    symbols = body.get("symbols")
    if not isinstance(symbols, dict):
        raise HTTPException(400, "symbols 필드(object)가 필요합니다")

    valid_statuses = {"live", "research", "excluded"}
    for sym, conf in symbols.items():
        if not isinstance(conf, dict):
            raise HTTPException(400, f"{sym}: 설정은 object여야 합니다")
        if "status" in conf and conf["status"] not in valid_statuses:
            raise HTTPException(400, f"{sym}: status는 live/research/excluded 중 하나")
        if "cutoff" in conf:
            value = conf["cutoff"]
            if not isinstance(value, (int, float)) or value < 0 or value > 100:
                raise HTTPException(400, f"{sym}: cutoff는 0~100")
        if "targetPct" in conf:
            value = conf["targetPct"]
            if not isinstance(value, (int, float)) or value < 0.1 or value > 10:
                raise HTTPException(400, f"{sym}: targetPct는 0.1~10")
        if "minRR" in conf:
            value = conf["minRR"]
            if not isinstance(value, (int, float)) or value < 0.5 or value > 5:
                raise HTTPException(400, f"{sym}: minRR는 0.5~5")
        if "sizeMultiplier" in conf:
            value = conf["sizeMultiplier"]
            if not isinstance(value, (int, float)) or value < 0.1 or value > 5:
                raise HTTPException(400, f"{sym}: sizeMultiplier는 0.1~5")
        if "maxPerSymbolKRW" in conf:
            value = conf["maxPerSymbolKRW"]
            if not isinstance(value, (int, float)) or value < 5_000 or value > 2_000_000:
                raise HTTPException(400, f"{sym}: maxPerSymbolKRW는 5,000~2,000,000")
        if "partialTakeProfitPct" in conf:
            value = conf["partialTakeProfitPct"]
            if not isinstance(value, (int, float)) or value < 0.5 or value > 20:
                raise HTTPException(400, f"{sym}: partialTakeProfitPct는 0.5~20")
        if "partialTakeProfitRatio" in conf:
            value = conf["partialTakeProfitRatio"]
            if not isinstance(value, (int, float)) or value <= 0 or value >= 1:
                raise HTTPException(400, f"{sym}: partialTakeProfitRatio는 0~1 사이")
        if "reentryDipPct" in conf:
            value = conf["reentryDipPct"]
            if not isinstance(value, (int, float)) or value < 0.5 or value > 20:
                raise HTTPException(400, f"{sym}: reentryDipPct는 0.5~20")
        if "maxDailyReentries" in conf:
            value = conf["maxDailyReentries"]
            if not isinstance(value, (int, float)) or value < 0 or value > 10:
                raise HTTPException(400, f"{sym}: maxDailyReentries는 0~10")

    try:
        db = d.get_firestore()
        doc_ref = db.collection("settings").document("coin-engine")
        existing = doc_ref.get()
        old_cfg = existing.to_dict() or {} if existing.exists else {}
        old_symbols = old_cfg.get("symbols", {})
        merged_symbols = {**old_symbols}
        for sym, conf in symbols.items():
            if sym in merged_symbols:
                merged_symbols[sym] = {**merged_symbols[sym], **conf}
            else:
                merged_symbols[sym] = conf

        doc_ref.set({"symbols": merged_symbols, "updated_at": d.firestore.SERVER_TIMESTAMP}, merge=True)
        db.collection("events").add({
            "kind": "coin_config_change",
            "user": user.get("email", ""),
            "changes": symbols,
            "created_at": d.firestore.SERVER_TIMESTAMP,
        })

        return {"ok": True, "config": {"symbols": merged_symbols}}
    except HTTPException:
        raise
    except Exception:
        return {"ok": False, "error": "engine-config 저장 실패"}
