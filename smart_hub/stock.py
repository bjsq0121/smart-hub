"""Stock operation routes and small stock-domain primitives."""

import hashlib
import secrets
import time
import asyncio
import concurrent.futures
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel


router = APIRouter(tags=["stock"])
_deps: SimpleNamespace | None = None

PAPER_MAX_QTY_PER_ORDER = 10_000
PAPER_MAX_AMOUNT_PER_ORDER = 100_000_000
PAPER_DAILY_ORDER_COUNT_CAP = 50
PAPER_DAILY_AMOUNT_CAP = 1_000_000_000
PAPER_CONFIRM_TOKEN_TTL = 60

paper_pending_tokens: dict = {}


def configure(deps: SimpleNamespace) -> None:
    global _deps
    _deps = deps


def deps() -> SimpleNamespace:
    if _deps is None:
        raise RuntimeError("stock routes are not configured")
    return _deps


async def stock_auth(authorization: str = Header(default="")) -> dict:
    return await deps().verify_firebase_token(authorization)


class PaperOrderRequest(BaseModel):
    symbol: str
    side: str
    qty: int
    priceType: str = "market"
    limitPrice: float | None = None
    clientNote: str = ""
    confirmToken: str | None = None


def paper_order_hash(
    symbol: str,
    side: str,
    qty: int,
    price_type: str,
    limit_price: float | None,
) -> str:
    raw = f"{symbol}|{side}|{qty}|{price_type}|{limit_price or 0}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def paper_cleanup_tokens() -> None:
    now = time.time()
    expired = [k for k, v in paper_pending_tokens.items() if v["expireAt"] <= now]
    for k in expired:
        paper_pending_tokens.pop(k, None)


def new_paper_confirm_token(
    *,
    symbol: str,
    side: str,
    qty: int,
    price_type: str,
    limit_price: float | None,
    user_email: str,
) -> str:
    paper_cleanup_tokens()
    token = secrets.token_urlsafe(18)
    paper_pending_tokens[token] = {
        "expireAt": time.time() + PAPER_CONFIRM_TOKEN_TTL,
        "orderHash": paper_order_hash(symbol, side, qty, price_type, limit_price),
        "userEmail": user_email,
    }
    return token


def consume_paper_confirm_token(
    *,
    token: str | None,
    symbol: str,
    side: str,
    qty: int,
    price_type: str,
    limit_price: float | None,
    user_email: str,
) -> None:
    if not token:
        raise HTTPException(status_code=400, detail="confirm_token_missing")
    paper_cleanup_tokens()
    pending = paper_pending_tokens.get(token)
    if not pending:
        raise HTTPException(status_code=400, detail="confirm_token_invalid")
    if pending["expireAt"] <= time.time():
        paper_pending_tokens.pop(token, None)
        raise HTTPException(status_code=400, detail="confirm_token_expired")
    if pending["orderHash"] != paper_order_hash(symbol, side, qty, price_type, limit_price):
        raise HTTPException(status_code=400, detail="confirm_token_mismatch")
    if pending["userEmail"] and pending["userEmail"] != user_email:
        raise HTTPException(status_code=403, detail="confirm_token_user_mismatch")
    paper_pending_tokens.pop(token, None)


def paper_validate_order(req: PaperOrderRequest) -> tuple[str, str, int, str, float | None]:
    symbol = (req.symbol or "").strip()
    if not symbol or not symbol.isdigit() or len(symbol) not in (5, 6):
        raise HTTPException(status_code=400, detail="symbol은 5~6자리 숫자 종목코드여야 합니다.")
    side = (req.side or "").strip().lower()
    if side not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="side는 'buy' 또는 'sell'이어야 합니다.")
    try:
        qty = int(req.qty)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="qty는 정수여야 합니다.")
    if qty < 1 or qty > PAPER_MAX_QTY_PER_ORDER:
        raise HTTPException(status_code=400, detail=f"qty는 1 이상 {PAPER_MAX_QTY_PER_ORDER} 이하여야 합니다.")
    price_type = (req.priceType or "market").strip().lower()
    if price_type not in ("market", "limit"):
        raise HTTPException(status_code=400, detail="priceType은 'market' 또는 'limit'이어야 합니다.")
    limit_price = None
    if price_type == "limit":
        if req.limitPrice is None or float(req.limitPrice) <= 0:
            raise HTTPException(status_code=400, detail="limit 주문은 양의 limitPrice가 필요합니다.")
        limit_price = float(req.limitPrice)
    return symbol, side, qty, price_type, limit_price


@router.get("/api/stock/quote")
async def api_stock_quote(
    symbol: str = Query(..., min_length=5, max_length=6),
    user: dict = Depends(stock_auth),
):
    """KIS current quote with memory-cache/stale fallback handled by the app dependency."""
    d = deps()
    d.ensure_admin(user)
    sym = (symbol or "").strip()
    if not sym.isdigit() or len(sym) not in (5, 6):
        raise HTTPException(status_code=400, detail="symbol은 5~6자리 숫자 종목코드여야 합니다.")

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            quote, stale = await loop.run_in_executor(ex, d.fetch_quote, sym)
    except Exception:
        quote, stale = None, False

    if not quote:
        raise HTTPException(status_code=503, detail="quote_fetch_failed")

    kst = datetime.now(timezone(timedelta(hours=9))).isoformat()
    source = quote.get("_source", "fresh")
    cached = source in ("cache", "stale")
    return {
        "ok": True,
        "symbol": sym,
        "name": quote.get("name", ""),
        "price": quote.get("price", 0),
        "prevClose": quote.get("prevClose", 0),
        "changeAmount": quote.get("changeAmount", 0),
        "changePct": quote.get("changePct", 0),
        "open": quote.get("open", 0),
        "high": quote.get("high", 0),
        "low": quote.get("low", 0),
        "volume": quote.get("volume", 0),
        "sector": quote.get("sector", ""),
        "marketHours": d.is_market_hours(),
        "cached": bool(cached),
        "stale": bool(stale),
        "timestamp": kst,
    }


@router.get("/api/stock/account/balance")
async def api_stock_account_balance(user: dict = Depends(stock_auth)):
    """Readonly KIS account cash/evaluation summary."""
    d = deps()
    d.ensure_admin(user)
    if not d.kis_account_configured():
        raise HTTPException(
            status_code=503,
            detail="KIS 계좌 env 미설정 (KIS_ACCOUNT_NO/KIS_ACCOUNT_PROD). Cloud Run에 주입 필요.",
        )
    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            snap = await loop.run_in_executor(ex, d.fetch_kis_account_snapshot, False)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"KIS 잔고 조회 실패: {str(e)[:120]}")
    except Exception:
        raise HTTPException(status_code=502, detail="KIS 잔고 조회 중 예기치 못한 오류.")
    return {
        "ok": True,
        "cached": snap.get("cached", False),
        "updatedAt": snap.get("fetchedAt"),
        "account": snap.get("summary", {}),
    }


@router.get("/api/stock/account/holdings")
async def api_stock_account_holdings(user: dict = Depends(stock_auth)):
    """Readonly KIS holdings list."""
    d = deps()
    d.ensure_admin(user)
    if not d.kis_account_configured():
        raise HTTPException(
            status_code=503,
            detail="KIS 계좌 env 미설정 (KIS_ACCOUNT_NO/KIS_ACCOUNT_PROD). Cloud Run에 주입 필요.",
        )
    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            snap = await loop.run_in_executor(ex, d.fetch_kis_account_snapshot, False)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"KIS 보유종목 조회 실패: {str(e)[:120]}")
    except Exception:
        raise HTTPException(status_code=502, detail="KIS 보유종목 조회 중 예기치 못한 오류.")
    return {
        "ok": True,
        "cached": snap.get("cached", False),
        "updatedAt": snap.get("fetchedAt"),
        "holdings": snap.get("holdings", []),
    }


@router.get("/api/stock/search")
async def api_stock_search(
    q: str = Query(..., min_length=1, max_length=32),
    limit: int = Query(default=10, ge=1, le=20),
    user: dict = Depends(stock_auth),
):
    """Naver autocomplete proxy with memory cache and graceful degrade."""
    d = deps()
    d.ensure_admin(user)
    norm_q = (q or "").strip().lower()[:32]
    if not norm_q:
        raise HTTPException(status_code=400, detail="q must be 1~32 chars")

    now = time.time()
    cached = d.stock_search_cache.get(norm_q)
    if cached and now - cached[0] < d.stock_search_cache_ttl:
        items = cached[1][:limit]
        return {"ok": True, "q": q, "source": "cache", "items": items}

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor() as ex:
            items = await loop.run_in_executor(ex, d.fetch_naver_stock_search, q, 20)
    except Exception:
        items = []

    if not items:
        if cached:
            return {
                "ok": True,
                "q": q,
                "source": "cache_fallback",
                "items": cached[1][:limit],
                "error": "naver_upstream",
            }
        return {"ok": True, "q": q, "source": "fallback", "items": [], "error": "naver_upstream"}

    if len(d.stock_search_cache) >= d.stock_search_cache_max:
        try:
            d.stock_search_cache.pop(next(iter(d.stock_search_cache)))
        except StopIteration:
            pass
    d.stock_search_cache[norm_q] = (now, items)
    for item in items:
        d.remember_symbol_name(item.get("code", ""), item.get("name", ""))

    return {"ok": True, "q": q, "source": "naver", "items": items[:limit]}


@router.get("/api/stock/paper/daily-stats")
async def api_stock_paper_daily_stats(user: dict = Depends(stock_auth)):
    """Daily paper-order usage and caps."""
    d = deps()
    d.ensure_admin(user)
    user_email = (user.get("email") or "").lower()
    kst_now = datetime.now(timezone(timedelta(hours=9)))
    try:
        db = d.get_firestore()
        daily_count, daily_amount = d.paper_today_stats(db, user_email)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"daily_stats_unavailable: {type(e).__name__}",
        )
    remaining_count = max(0, PAPER_DAILY_ORDER_COUNT_CAP - daily_count)
    remaining_amount = max(0.0, PAPER_DAILY_AMOUNT_CAP - daily_amount)
    return {
        "ok": True,
        "date": kst_now.strftime("%Y-%m-%d"),
        "count": daily_count,
        "amountKRW": round(daily_amount, 2),
        "caps": {
            "count": PAPER_DAILY_ORDER_COUNT_CAP,
            "amountKRW": PAPER_DAILY_AMOUNT_CAP,
        },
        "remaining": {
            "count": remaining_count,
            "amountKRW": round(remaining_amount, 2),
        },
        "singleOrder": {
            "maxQty": PAPER_MAX_QTY_PER_ORDER,
            "maxAmountKRW": PAPER_MAX_AMOUNT_PER_ORDER,
        },
        "asOf": kst_now.isoformat(),
    }


@router.post("/api/stock/paper/order/prepare")
async def api_stock_paper_order_prepare(
    req: PaperOrderRequest,
    user: dict = Depends(stock_auth),
):
    """Issue a short-lived confirmation token for a paper order preview."""
    d = deps()
    d.ensure_admin(user)
    symbol, side, qty, price_type, limit_price = paper_validate_order(req)

    current_price = d.paper_stock_price(symbol)
    estimated = limit_price if price_type == "limit" else current_price
    estimated_total = (estimated or 0) * qty

    if estimated_total > PAPER_MAX_AMOUNT_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"단건 주문 한도 초과 (≤ {PAPER_MAX_AMOUNT_PER_ORDER:,}원).",
        )

    name = d.lookup_symbol_name(symbol)
    if not name:
        try:
            for holding in d.kis_account_cache.get("data", {}).get("holdings", []) or []:
                if holding.get("symbol") == symbol:
                    name = holding.get("name", "") or name
                    break
        except Exception:
            pass
    if name:
        d.remember_symbol_name(symbol, name)

    token = new_paper_confirm_token(
        symbol=symbol,
        side=side,
        qty=qty,
        price_type=price_type,
        limit_price=limit_price,
        user_email=(user.get("email") or "").lower(),
    )

    return {
        "ok": True,
        "confirmToken": token,
        "expiresIn": PAPER_CONFIRM_TOKEN_TTL,
        "preview": {
            "symbol": symbol,
            "name": name,
            "side": side,
            "qty": qty,
            "priceType": price_type,
            "limitPrice": limit_price,
            "estimatedFillPrice": estimated,
            "estimatedTotal": estimated_total,
            "marketHours": d.is_market_hours(),
        },
    }


@router.post("/api/stock/paper/order")
async def api_stock_paper_order(
    req: PaperOrderRequest,
    user: dict = Depends(stock_auth),
):
    """Execute a stock paper order and update positions."""
    d = deps()
    d.ensure_admin(user)
    symbol, side, qty, price_type, limit_price = paper_validate_order(req)
    user_email = (user.get("email") or "").lower()

    consume_paper_confirm_token(
        token=req.confirmToken,
        symbol=symbol,
        side=side,
        qty=qty,
        price_type=price_type,
        limit_price=limit_price,
        user_email=user_email,
    )

    market_hours = d.is_market_hours()
    if not market_hours:
        raise HTTPException(status_code=400, detail="market_closed")

    symbol_name = d.lookup_symbol_name(symbol)
    if price_type == "market":
        quote, _stale = d.fetch_quote(symbol)
        if not quote or float(quote.get("price") or 0) <= 0:
            raise HTTPException(status_code=502, detail="price_fetch_failed")
        fill_price = float(quote.get("price") or 0)
        if not symbol_name:
            symbol_name = quote.get("name") or ""
    else:
        fill_price = float(limit_price or 0)
        if not symbol_name:
            quote, _stale = d.fetch_quote(symbol)
            if quote:
                symbol_name = quote.get("name") or ""
    if symbol_name:
        d.remember_symbol_name(symbol, symbol_name)

    order_amount = fill_price * qty
    if order_amount > PAPER_MAX_AMOUNT_PER_ORDER:
        raise HTTPException(status_code=400, detail="order_amount_exceeded")

    db = d.get_firestore()
    try:
        daily_count, daily_amount = d.paper_today_stats(db, user_email)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"daily_limit_query_failed: {type(e).__name__} — firestore.indexes.json 배포 필요",
        )
    if daily_count >= PAPER_DAILY_ORDER_COUNT_CAP:
        raise HTTPException(status_code=400, detail="daily_limit_exceeded")
    if daily_amount + order_amount > PAPER_DAILY_AMOUNT_CAP:
        raise HTTPException(status_code=400, detail="daily_amount_exceeded")

    kst_now = datetime.now(timezone(timedelta(hours=9)))
    trade_id = f"pt_stock_{kst_now.strftime('%Y%m%d_%H%M%S')}_{side}_{symbol}"

    trade_doc = {
        "tradeId": trade_id,
        "symbol": symbol,
        "symbolName": symbol_name or "",
        "side": side,
        "qty": qty,
        "fillPrice": fill_price,
    }
    try:
        txn_result = d.paper_apply_position_txn(db, user_email, trade_doc)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"position_update_failed: {type(e).__name__}")

    occurred_at = kst_now.isoformat()
    pt_ref = db.collection("paper_trades").document(trade_id)
    pt_doc = {
        "tradeId": trade_id,
        "signalId": "",
        "symbol": symbol,
        "symbolName": symbol_name or "",
        "direction": "long",
        "entryPrice": fill_price,
        "currentPrice": fill_price,
        "pnlPercent": 0.0,
        "maxFavorable": 0.0,
        "maxAdverse": 0.0,
        "holdTimeMin": 0,
        "status": "open" if side == "buy" else "closed",
        "assetClass": "stock",
        "side": side,
        "qty": qty,
        "priceType": price_type,
        "limitPrice": limit_price,
        "fillPrice": fill_price,
        "clientNote": (req.clientNote or "")[:500],
        "userEmail": user_email,
        "marketHours": market_hours,
        "source": "smarthub-paper",
        "workflow": "stock-paper-order",
        "syncStatus": "ok",
        "errorType": None,
        "occurredAt": occurred_at,
        "created_at": d.firestore.SERVER_TIMESTAMP,
        "updated_at": d.firestore.SERVER_TIMESTAMP,
    }
    if side == "sell":
        pt_doc["matchedTradeIds"] = txn_result.get("matchedTradeIds", [])
    pt_ref.set(pt_doc)

    try:
        db.collection("events").document().set({
            "kind": "paper_trade",
            "source": "smarthub-paper",
            "workflow": "stock-paper-order",
            "syncStatus": "ok",
            "errorType": None,
            "occurredAt": occurred_at,
            "payload": {k: v for k, v in pt_doc.items() if k not in ("created_at", "updated_at")},
            "created_at": d.firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass

    if side == "sell":
        try:
            avg_entry = float(txn_result.get("avgEntryPrice") or 0)
            realized = float(txn_result.get("realizedPnlKRW") or 0)
            pnl_pct = ((fill_price - avg_entry) / avg_entry * 100.0) if avg_entry > 0 else 0.0
            db.collection("trade_results").document().set({
                "tradeId": trade_id,
                "signalId": "",
                "symbol": symbol,
                "direction": "long",
                "result": "win" if realized > 0 else "loss",
                "pnlPercent": round(pnl_pct, 4),
                "pnlKRW": realized,
                "exitReason": "paper_manual_sell",
                "exitAt": occurred_at,
                "entryAt": None,
                "entryPrice": avg_entry,
                "exitPrice": fill_price,
                "holdTimeMin": 0,
                "maxFavorable": 0.0,
                "maxAdverse": 0.0,
                "confidence": 0.0,
                "components": None,
                "assetClass": "stock",
                "matchedTradeIds": txn_result.get("matchedTradeIds", []),
                "source": "smarthub-paper",
                "workflow": "stock-paper-order",
                "syncStatus": "ok",
                "errorType": None,
                "occurredAt": occurred_at,
                "created_at": d.firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            pass

    return {
        "ok": True,
        "tradeId": trade_id,
        "fillPrice": fill_price,
        "position": txn_result.get("position"),
        "realizedPnlKRW": txn_result.get("realizedPnlKRW", 0.0) if side == "sell" else None,
    }


@router.get("/api/stock/paper/positions")
async def api_stock_paper_positions(user: dict = Depends(stock_auth)):
    """List stock paper positions with current quote enrichment."""
    d = deps()
    d.ensure_admin(user)
    user_email = (user.get("email") or "").lower()
    try:
        db = d.get_firestore()
        positions = []
        for doc in db.collection("paper_positions").stream():
            data = doc.to_dict() or {}
            if (data.get("assetClass") or "") != "stock":
                continue
            if data.get("userEmail") and data.get("userEmail") != user_email:
                continue
            if int(data.get("qty") or 0) <= 0:
                continue
            symbol = data.get("symbol") or doc.id
            avg = float(data.get("avgCost") or 0)
            qty = int(data.get("qty") or 0)
            current = d.paper_stock_price(symbol)
            eval_amt = current * qty
            pnl_krw = (current - avg) * qty if current > 0 else 0.0
            pnl_pct = ((current - avg) / avg * 100.0) if avg > 0 and current > 0 else 0.0
            opened = data.get("openedAt")
            if opened and hasattr(opened, "isoformat"):
                opened = opened.isoformat()
            positions.append({
                "symbol": symbol,
                "name": data.get("name", ""),
                "qty": qty,
                "avgCost": avg,
                "currentPrice": current,
                "evalAmount": round(eval_amt, 2),
                "pnlKRW": round(pnl_krw, 2),
                "pnlPct": round(pnl_pct, 4),
                "openedAt": opened,
            })
        positions.sort(key=lambda x: x["evalAmount"], reverse=True)
        return {"ok": True, "positions": positions}
    except Exception:
        return {"ok": False, "positions": [], "error": "paper_positions 조회 실패"}


@router.get("/api/stock/paper/orders")
async def api_stock_paper_orders(
    limit: int = Query(default=50, le=200),
    side: str | None = Query(default=None),
    symbol: str | None = Query(default=None),
    user: dict = Depends(stock_auth),
):
    """List stock paper orders."""
    d = deps()
    d.ensure_admin(user)
    user_email = (user.get("email") or "").lower()

    def _order_row(data: dict) -> dict:
        sym = data.get("symbol") or ""
        stored_name = data.get("symbolName") or data.get("name") or ""
        sym_name = stored_name or d.lookup_symbol_name(sym) or None
        return {
            "tradeId": data.get("tradeId"),
            "symbol": sym,
            "symbolName": sym_name,
            "side": data.get("side"),
            "qty": data.get("qty"),
            "fillPrice": data.get("fillPrice") or data.get("entryPrice"),
            "priceType": data.get("priceType"),
            "limitPrice": data.get("limitPrice"),
            "status": data.get("status"),
            "clientNote": data.get("clientNote", ""),
            "createdAt": data.get("created_at"),
            "occurredAt": data.get("occurredAt"),
        }

    try:
        db = d.get_firestore()
        q = (
            db.collection("paper_trades")
            .where("userEmail", "==", user_email)
            .order_by("created_at", direction=d.firestore.Query.DESCENDING)
            .limit(limit)
        )
        items = []
        for doc in q.stream():
            data = d.doc_to_dict(doc)
            if (data.get("assetClass") or "") != "stock":
                continue
            if side and data.get("side") != side.lower():
                continue
            if symbol and data.get("symbol") != symbol:
                continue
            items.append(_order_row(data))
        return {"ok": True, "items": items}
    except Exception:
        try:
            db = d.get_firestore()
            q = (
                db.collection("paper_trades")
                .where("assetClass", "==", "stock")
                .order_by("created_at", direction=d.firestore.Query.DESCENDING)
                .limit(limit * 3)
            )
            items = []
            for doc in q.stream():
                data = d.doc_to_dict(doc)
                if (data.get("assetClass") or "") != "stock":
                    continue
                if data.get("userEmail") and data.get("userEmail") != user_email:
                    continue
                if side and data.get("side") != side.lower():
                    continue
                if symbol and data.get("symbol") != symbol:
                    continue
                items.append(_order_row(data))
                if len(items) >= limit:
                    break
            return {"ok": True, "items": items, "indexFallback": True}
        except Exception:
            return {"ok": False, "items": [], "error": "paper_trades 조회 실패"}


@router.get("/api/stock/paper/recent-symbols")
async def api_stock_paper_recent_symbols(
    limit: int = Query(default=10, ge=1, le=30),
    user: dict = Depends(stock_auth),
):
    """List recently traded stock symbols."""
    d = deps()
    d.ensure_admin(user)
    user_email = (user.get("email") or "").lower()
    try:
        db = d.get_firestore()
        fetch_limit = limit * 3
        q = (
            db.collection("paper_trades")
            .where("userEmail", "==", user_email)
            .order_by("created_at", direction=d.firestore.Query.DESCENDING)
            .limit(fetch_limit)
        )
        seen: set = set()
        items: list = []
        for doc in q.stream():
            data = d.doc_to_dict(doc)
            if (data.get("assetClass") or "") != "stock":
                continue
            sym = data.get("symbol") or ""
            if not sym or sym in seen:
                continue
            seen.add(sym)
            stored_name = data.get("symbolName") or data.get("name") or ""
            sym_name = stored_name or d.lookup_symbol_name(sym) or None
            items.append({
                "symbol": sym,
                "symbolName": sym_name,
                "lastTradedAt": data.get("created_at"),
                "side": data.get("side"),
            })
            if len(items) >= limit:
                break
        return {"ok": True, "items": items}
    except Exception:
        return {"ok": True, "items": []}
