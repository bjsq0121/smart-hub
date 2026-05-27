"""TRX DCA accumulation and profit-taking strategy.

The strategy is designed for smart-hub's FastAPI runtime. It keeps durable
state in Firestore and keeps exchange access behind a broker adapter so tests
can run without live API credentials.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

import requests


STATE_COLLECTION = "settings"
STATE_DOCUMENT = "coin-trx-strategy-state"
TRADE_COLLECTION = "coin_trx_strategy_trades"
MARKET_TRX = "KRW-TRX"
MARKET_USDT = "KRW-USDT"
MIN_ORDER_KRW = 5_000
DEFAULT_UPBIT_PROXY_URL = "http://34.47.98.167:9090/"
DEFAULT_UPBIT_PROXY_SECRET = "smarthub-upbit-proxy-2026"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    if hasattr(value, "timestamp"):
        try:
            return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc)
        except Exception:
            return None
    return None


def dt_to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def calculate_rsi(closes: list[float], period: int = 14) -> float | None:
    """Calculate RSI using Wilder smoothing over closing prices."""
    if len(closes) < period + 1:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for idx in range(1, period + 1):
        delta = closes[idx] - closes[idx - 1]
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    for idx in range(period + 1, len(closes)):
        delta = closes[idx] - closes[idx - 1]
        gain = max(delta, 0.0)
        loss = max(-delta, 0.0)
        avg_gain = ((avg_gain * (period - 1)) + gain) / period
        avg_loss = ((avg_loss * (period - 1)) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


@dataclass
class BalanceSnapshot:
    trx_balance: float
    trx_avg_buy_price: float
    krw_balance: float


@dataclass
class StrategyState:
    no_position_since: datetime | None = None
    last_dca_price: float | None = None
    is_profit_taken: bool = False
    last_error: str | None = None
    updated_at: datetime | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "StrategyState":
        data = data or {}
        last_dca = data.get("lastDcaPrice")
        try:
            last_dca_price = float(last_dca) if last_dca is not None else None
        except (TypeError, ValueError):
            last_dca_price = None
        return cls(
            no_position_since=parse_dt(data.get("noPositionSince")),
            last_dca_price=last_dca_price,
            is_profit_taken=bool(data.get("isProfitTaken", False)),
            last_error=data.get("lastError"),
            updated_at=parse_dt(data.get("updatedAt")),
        )

    def to_firestore_updates(self) -> dict[str, Any]:
        return {
            "noPositionSince": dt_to_iso(self.no_position_since),
            "lastDcaPrice": self.last_dca_price,
            "isProfitTaken": self.is_profit_taken,
            "lastError": self.last_error,
            "updatedAt": dt_to_iso(self.updated_at or utc_now()),
        }


class StrategyStateStore(Protocol):
    def load(self) -> StrategyState:
        ...

    def save(self, state: StrategyState) -> None:
        ...

    def patch(self, updates: dict[str, Any]) -> StrategyState:
        ...


class TradeRecorder(Protocol):
    def record(self, trade: dict[str, Any]) -> None:
        ...


class NullTradeRecorder:
    def record(self, trade: dict[str, Any]) -> None:
        return None


class MemoryTradeRecorder:
    def __init__(self):
        self.trades: list[dict[str, Any]] = []

    def record(self, trade: dict[str, Any]) -> None:
        self.trades.append(dict(trade))


class FirestoreTradeRecorder:
    def __init__(self, db: Any, firestore: Any | None = None):
        self.db = db
        self.firestore = firestore

    def record(self, trade: dict[str, Any]) -> None:
        trade = dict(trade)
        created_at = utc_now()
        trade.setdefault("market", MARKET_TRX)
        trade.setdefault("createdAtIso", dt_to_iso(created_at))
        trade["createdAt"] = self.firestore.SERVER_TIMESTAMP if self.firestore is not None else dt_to_iso(created_at)
        trade_type = str(trade.get("type") or "trade")
        doc_id = f"{trade_type}-{trade.get('uuid')}" if trade.get("uuid") else f"{trade_type}-{int(created_at.timestamp() * 1000)}"
        self.db.collection(TRADE_COLLECTION).document(doc_id).set(trade, merge=True)


class FirestoreTradeBudgetProvider:
    def __init__(self, db: Any, config_provider: Any):
        self.db = db
        self.config_provider = config_provider

    def __call__(self) -> dict[str, Any]:
        cfg = dict(self.config_provider() or {})
        invested_krw = 0.0
        for doc in self.db.collection(TRADE_COLLECTION).stream():
            trade = doc.to_dict() or {}
            trade_type = trade.get("type")
            krw_amount = _safe_float(trade.get("krwAmount"))
            if trade_type == "buy":
                invested_krw += krw_amount
            elif trade_type == "sell":
                invested_krw -= krw_amount
        cfg["currentBotInvestedKRW"] = max(0.0, invested_krw)
        return cfg


class MemoryStrategyStateStore:
    def __init__(self, state: StrategyState | None = None):
        self.state = state or StrategyState()

    def load(self) -> StrategyState:
        return self.state

    def save(self, state: StrategyState) -> None:
        self.state = state

    def patch(self, updates: dict[str, Any]) -> StrategyState:
        current = self.state.to_firestore_updates()
        current.update(updates)
        self.state = StrategyState.from_dict(current)
        return self.state


class FirestoreStrategyStateStore:
    def __init__(self, db: Any, firestore: Any | None = None):
        self.db = db
        self.firestore = firestore

    def _doc_ref(self):
        return self.db.collection(STATE_COLLECTION).document(STATE_DOCUMENT)

    def load(self) -> StrategyState:
        doc = self._doc_ref().get()
        if getattr(doc, "exists", False):
            return StrategyState.from_dict(doc.to_dict() or {})
        return StrategyState()

    def save(self, state: StrategyState) -> None:
        state.updated_at = utc_now()
        data = state.to_firestore_updates()
        if self.firestore is not None:
            data["updatedAt"] = self.firestore.SERVER_TIMESTAMP
        self._doc_ref().set(data, merge=True)

    def patch(self, updates: dict[str, Any]) -> StrategyState:
        updates = dict(updates)
        updates["updatedAt"] = self.firestore.SERVER_TIMESTAMP if self.firestore is not None else dt_to_iso(utc_now())
        self._doc_ref().set(updates, merge=True)
        return self.load()


class Broker(Protocol):
    def get_balance_snapshot(self) -> BalanceSnapshot:
        ...

    def get_current_price(self, market: str) -> float:
        ...

    def get_ohlcv(self, market: str, interval: str, count: int) -> list[dict[str, Any]]:
        ...

    def get_binance_trx_usdt(self) -> float:
        ...

    def market_buy_krw(self, market: str, krw_amount: float) -> dict[str, Any]:
        ...

    def market_sell_volume(self, market: str, volume: float) -> dict[str, Any]:
        ...

    def get_open_orders(self, market: str) -> list[dict[str, Any]]:
        ...

    def cancel_order(self, uuid: str) -> dict[str, Any]:
        ...


class PyUpbitBroker:
    """pyupbit/ccxt backed exchange adapter for production use.

    Public market data uses pyupbit directly. Private Upbit calls go through the
    existing Upbit proxy because production API keys are IP-restricted.
    """

    def __init__(self, access_key: str | None = None, secret_key: str | None = None, pause_seconds: float = 0.2):
        import ccxt
        import pyupbit

        self.pyupbit = pyupbit
        self.proxy_url = os.getenv("UPBIT_PROXY_URL", DEFAULT_UPBIT_PROXY_URL)
        self.proxy_secret = os.getenv("UPBIT_PROXY_SECRET", DEFAULT_UPBIT_PROXY_SECRET)
        self.upbit = pyupbit.Upbit(
            access_key or os.getenv("UPBIT_ACCESS_KEY", ""),
            secret_key or os.getenv("UPBIT_SECRET_KEY", ""),
        )
        self.binance = ccxt.binance({"enableRateLimit": True})
        self.pause_seconds = pause_seconds

    def _pause(self) -> None:
        if self.pause_seconds > 0:
            time.sleep(self.pause_seconds)

    def _upbit_proxy(self, method: str, path: str, query: str = "", data: dict[str, Any] | None = None) -> Any:
        self._pause()
        body: dict[str, Any] = {"method": method, "path": path}
        if query:
            body["query"] = query
        if data:
            body["data"] = data
        resp = requests.post(
            self.proxy_url,
            headers={"Content-Type": "application/json", "X-Proxy-Secret": self.proxy_secret},
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def _ensure_private_response(self, value: Any, expected_type: type, context: str) -> Any:
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(f"{context}: {value.get('error')}")
        if not isinstance(value, expected_type):
            raise RuntimeError(f"{context}: unexpected response {type(value).__name__} {str(value)[:200]}")
        return value

    def get_balance_snapshot(self) -> BalanceSnapshot:
        balances = self._ensure_private_response(
            self._upbit_proxy("GET", "/v1/accounts"),
            list,
            "upbit_accounts_failed",
        )
        trx_balance = 0.0
        trx_avg_buy_price = 0.0
        krw_balance = 0.0
        for row in balances:
            if not isinstance(row, dict):
                raise RuntimeError(f"upbit_accounts_failed: invalid row {type(row).__name__}")
            currency = str(row.get("currency", "")).upper()
            if currency == "KRW":
                krw_balance = float(row.get("balance") or 0)
            if currency == "TRX":
                trx_balance = float(row.get("balance") or 0)
                trx_avg_buy_price = float(row.get("avg_buy_price") or 0)
        return BalanceSnapshot(trx_balance=trx_balance, trx_avg_buy_price=trx_avg_buy_price, krw_balance=krw_balance)

    def get_current_price(self, market: str) -> float:
        self._pause()
        price = self.pyupbit.get_current_price(market)
        if price is None:
            raise RuntimeError(f"{market} current price unavailable")
        return float(price)

    def get_ohlcv(self, market: str, interval: str, count: int) -> list[dict[str, Any]]:
        self._pause()
        frame = self.pyupbit.get_ohlcv(market, interval=interval, count=count)
        if frame is None:
            return []
        records: list[dict[str, Any]] = []
        for _, row in frame.iterrows():
            records.append({"close": float(row["close"])})
        return records

    def get_binance_trx_usdt(self) -> float:
        self._pause()
        ticker = self.binance.fetch_ticker("TRX/USDT")
        price = ticker.get("last") or ticker.get("close")
        if price is None:
            raise RuntimeError("Binance TRX/USDT price unavailable")
        return float(price)

    def market_buy_krw(self, market: str, krw_amount: float) -> dict[str, Any]:
        result = self._upbit_proxy(
            "POST",
            "/v1/orders",
            data={"market": market, "side": "bid", "ord_type": "price", "price": str(int(krw_amount))},
        )
        return self._ensure_private_response(result or {}, dict, "upbit_market_buy_failed")

    def market_sell_volume(self, market: str, volume: float) -> dict[str, Any]:
        result = self._upbit_proxy(
            "POST",
            "/v1/orders",
            data={"market": market, "side": "ask", "ord_type": "market", "volume": str(volume)},
        )
        return self._ensure_private_response(result or {}, dict, "upbit_market_sell_failed")

    def get_open_orders(self, market: str) -> list[dict[str, Any]]:
        orders = self._upbit_proxy("GET", "/v1/orders", query=f"market={market}&state=wait") or []
        orders = self._ensure_private_response(orders, list, "upbit_open_orders_failed")
        return orders if isinstance(orders, list) else [orders]

    def cancel_order(self, uuid: str) -> dict[str, Any]:
        result = self._upbit_proxy("DELETE", "/v1/order", query=f"uuid={uuid}") or {}
        return self._ensure_private_response(result, dict, "upbit_cancel_order_failed")


class LazyPyUpbitBroker:
    """Delay pyupbit/ccxt initialization until a trade loop actually needs it."""

    def __init__(self):
        self._broker: PyUpbitBroker | None = None

    def _get(self) -> PyUpbitBroker:
        if self._broker is None:
            self._broker = PyUpbitBroker()
        return self._broker

    def get_balance_snapshot(self) -> BalanceSnapshot:
        return self._get().get_balance_snapshot()

    def get_current_price(self, market: str) -> float:
        return self._get().get_current_price(market)

    def get_ohlcv(self, market: str, interval: str, count: int) -> list[dict[str, Any]]:
        return self._get().get_ohlcv(market, interval, count)

    def get_binance_trx_usdt(self) -> float:
        return self._get().get_binance_trx_usdt()

    def market_buy_krw(self, market: str, krw_amount: float) -> dict[str, Any]:
        return self._get().market_buy_krw(market, krw_amount)

    def market_sell_volume(self, market: str, volume: float) -> dict[str, Any]:
        return self._get().market_sell_volume(market, volume)

    def get_open_orders(self, market: str) -> list[dict[str, Any]]:
        return self._get().get_open_orders(market)

    def cancel_order(self, uuid: str) -> dict[str, Any]:
        return self._get().cancel_order(uuid)


class TRXDcaStrategy:
    def __init__(
        self,
        *,
        broker: Broker,
        state_store: StrategyStateStore,
        sleep_seconds: int = 60,
        market: str = MARKET_TRX,
        enabled_checker: Any | None = None,
        trade_recorder: TradeRecorder | None = None,
        budget_provider: Any | None = None,
    ):
        self.broker = broker
        self.state_store = state_store
        self.sleep_seconds = sleep_seconds
        self.market = market
        self.enabled_checker = enabled_checker
        self.trade_recorder = trade_recorder or NullTradeRecorder()
        self.budget_provider = budget_provider

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as exc:
                self._record_error(f"strategy_loop_unhandled: {exc}")
            await asyncio.sleep(self.sleep_seconds)

    async def run_once(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or utc_now()
        if self.enabled_checker is not None:
            try:
                if not bool(self.enabled_checker()):
                    return {"action": "disabled"}
            except Exception as exc:
                return self._record_error(f"enabled_check_failed: {exc}", action="error")
        self._cleanup_stale_buy_orders(now)
        state = self.state_store.load()

        try:
            balance = self.broker.get_balance_snapshot()
        except Exception as exc:
            return self._record_error(f"balance_fetch_failed: {exc}", action="error")

        try:
            current_price = self.broker.get_current_price(self.market)
        except Exception as exc:
            return self._record_error(f"trx_price_fetch_failed: {exc}", action="error")

        if balance.trx_balance <= 0:
            return self._handle_no_position(state, balance, current_price, now)

        return self._handle_existing_position(state, balance, current_price, now)

    def _handle_no_position(
        self,
        state: StrategyState,
        balance: BalanceSnapshot,
        current_price: float,
        now: datetime,
    ) -> dict[str, Any]:
        if state.no_position_since is None:
            state.no_position_since = now
            state.last_dca_price = None
            state.is_profit_taken = False
            self.state_store.save(state)

        rsi = self._safe_rsi()
        elapsed = now - (state.no_position_since or now)
        if rsi is not None and rsi <= 30:
            return self._try_buy(balance.krw_balance * 0.10, current_price, "rsi_entry_buy", state)
        if elapsed >= timedelta(hours=24):
            return self._try_buy(balance.krw_balance * 0.03, current_price, "scout_buy", state)
        return {"action": "wait_entry", "rsi": rsi, "noPositionSince": dt_to_iso(state.no_position_since)}

    def _handle_existing_position(
        self,
        state: StrategyState,
        balance: BalanceSnapshot,
        current_price: float,
        now: datetime,
    ) -> dict[str, Any]:
        changed = False
        if state.no_position_since is not None:
            state.no_position_since = None
            changed = True
        if not state.last_dca_price:
            state.last_dca_price = current_price
            changed = True
        if changed:
            self.state_store.save(state)

        if (
            not state.is_profit_taken
            and balance.trx_avg_buy_price > 0
            and current_price >= balance.trx_avg_buy_price * 1.03
        ):
            sell_volume = balance.trx_balance * 0.50
            try:
                result = self.broker.market_sell_volume(self.market, sell_volume)
            except Exception as exc:
                return self._record_error(f"profit_take_failed: {exc}", action="error")
            if not result.get("uuid"):
                return self._record_error(f"profit_take_rejected: {result}", action="error")
            state.is_profit_taken = True
            state.updated_at = now
            state.last_error = None
            self.state_store.save(state)
            self._record_trade(
                {
                    "type": "sell",
                    "reason": "profit_take",
                    "market": self.market,
                    "uuid": result.get("uuid"),
                    "price": current_price,
                    "avgBuyPrice": balance.trx_avg_buy_price,
                    "trxVolume": sell_volume,
                    "krwAmount": sell_volume * current_price,
                    "realizedPnlKRW": (current_price - balance.trx_avg_buy_price) * sell_volume,
                    "realizedPnlPct": ((current_price / balance.trx_avg_buy_price) - 1.0) * 100.0,
                }
            )
            self._log("profit_take", {"price": current_price, "volume": sell_volume, "avg": balance.trx_avg_buy_price})
            return {"action": "profit_take", "price": current_price, "volume": sell_volume}

        if current_price <= float(state.last_dca_price) * 0.98:
            return self._try_buy(balance.krw_balance * 0.10, current_price, "dca_buy", state)

        return {"action": "hold", "price": current_price}

    def _try_buy(
        self,
        krw_amount: float,
        current_price: float,
        action: str,
        state: StrategyState,
    ) -> dict[str, Any]:
        max_total_krw, max_per_order_krw, current_bot_invested_krw = self._budget_limits()
        if max_per_order_krw > 0:
            krw_amount = min(krw_amount, max_per_order_krw)
        if max_total_krw > 0:
            remaining_budget = max_total_krw - max(0.0, current_bot_invested_krw)
            if remaining_budget < MIN_ORDER_KRW:
                return {
                    "action": "buy_skipped_budget_cap",
                    "krw": int(krw_amount),
                    "currentBotInvestedKRW": int(current_bot_invested_krw),
                    "maxTotalKRW": int(max_total_krw),
                }
            krw_amount = min(krw_amount, remaining_budget)
        if krw_amount < MIN_ORDER_KRW:
            return {"action": "buy_skipped_min_order", "krw": int(krw_amount)}
        ok, premium_or_error = self._buy_allowed_by_kimchi(current_price)
        if not ok:
            self._record_error(str(premium_or_error), action="buy_blocked_kimchi")
            return {"action": "buy_blocked_kimchi", "reason": str(premium_or_error)}
        try:
            result = self.broker.market_buy_krw(self.market, krw_amount)
        except Exception as exc:
            return self._record_error(f"{action}_failed: {exc}", action="error")
        if not result.get("uuid"):
            return self._record_error(f"{action}_rejected: {result}", action="error")
        state.no_position_since = None
        state.last_dca_price = current_price
        state.is_profit_taken = False
        state.last_error = None
        state.updated_at = utc_now()
        self.state_store.save(state)
        self._record_trade(
            {
                "type": "buy",
                "reason": action,
                "market": self.market,
                "uuid": result.get("uuid"),
                "price": current_price,
                "krwAmount": int(krw_amount),
                "trxVolume": (float(krw_amount) / current_price) if current_price > 0 else None,
                "kimchiPremiumPct": premium_or_error,
            }
        )
        self._log(action, {"krw": int(krw_amount), "price": current_price, "kimchiPremiumPct": premium_or_error})
        return {"action": action, "krw": int(krw_amount), "price": current_price}

    def _safe_rsi(self) -> float | None:
        try:
            candles = self.broker.get_ohlcv(self.market, interval="minute5", count=100)
            if len(candles) < 100:
                return None
            closes = [float(row["close"]) for row in candles if row.get("close") is not None]
            if len(closes) < 100:
                return None
            return calculate_rsi(closes, period=14)
        except Exception as exc:
            self._record_error(f"rsi_unavailable: {exc}")
            return None

    def _buy_allowed_by_kimchi(self, upbit_trx_krw: float) -> tuple[bool, float | str]:
        try:
            binance_trx_usdt = self.broker.get_binance_trx_usdt()
            upbit_usdt_krw = self.broker.get_current_price(MARKET_USDT)
            if binance_trx_usdt <= 0 or upbit_usdt_krw <= 0:
                raise ValueError("invalid external price")
            premium_pct = ((upbit_trx_krw / (binance_trx_usdt * upbit_usdt_krw)) - 1.0) * 100.0
        except Exception as exc:
            return False, f"kimchi_price_unavailable: {exc}"
        if premium_pct >= 5.0:
            return False, f"kimchi_premium_high: {premium_pct:.2f}%"
        return True, round(premium_pct, 4)

    def _budget_limits(self) -> tuple[float, float, float]:
        if self.budget_provider is None:
            return 0.0, 0.0, 0.0
        try:
            cfg = self.budget_provider() or {}
            return (
                float(cfg.get("maxTotalKRW") or 0),
                float(cfg.get("maxPerSymbolKRW") or 0),
                float(cfg.get("currentBotInvestedKRW") or 0),
            )
        except Exception as exc:
            self._record_error(f"budget_config_unavailable: {exc}")
            return 0.0, 0.0, 0.0

    def _cleanup_stale_buy_orders(self, now: datetime) -> None:
        try:
            orders = self.broker.get_open_orders(self.market)
        except Exception as exc:
            self._record_error(f"open_order_fetch_failed: {exc}")
            return
        for order in orders:
            try:
                if order.get("side") != "bid":
                    continue
                created_at = parse_dt(order.get("created_at") or order.get("createdAt"))
                if not created_at or now - created_at < timedelta(hours=1):
                    continue
                uuid = order.get("uuid")
                if uuid:
                    self.broker.cancel_order(uuid)
                    self._record_trade(
                        {
                            "type": "cancel",
                            "reason": "stale_buy_order",
                            "market": self.market,
                            "uuid": uuid,
                            "orderCreatedAt": dt_to_iso(created_at),
                        }
                    )
                    self._log("cancel_stale_buy", {"uuid": uuid, "createdAt": dt_to_iso(created_at)})
            except Exception as exc:
                self._record_error(f"stale_order_cancel_failed: {exc}")

    def _record_error(self, message: str, action: str = "error") -> dict[str, Any]:
        msg = message[:500]
        print(f"[TRX_STRATEGY][ERROR] {datetime.now().isoformat()} {msg}")
        try:
            state = self.state_store.load()
            state.last_error = msg
            state.updated_at = utc_now()
            self.state_store.save(state)
        except Exception:
            pass
        return {"action": action, "error": msg}

    def _log(self, event: str, detail: dict[str, Any]) -> None:
        print(f"[TRX_STRATEGY][{event}] {datetime.now().isoformat()} {detail}")

    def _record_trade(self, trade: dict[str, Any]) -> None:
        try:
            self.trade_recorder.record(trade)
        except Exception as exc:
            self._log("trade_record_failed", {"error": str(exc)[:300], "trade": trade})


trx_strategy_task: asyncio.Task | None = None


async def start_trx_strategy_loop(
    db: Any,
    firestore: Any | None = None,
    enabled_checker: Any | None = None,
    budget_provider: Any | None = None,
) -> None:
    """Start one background TRX strategy task for the FastAPI process."""
    global trx_strategy_task
    if trx_strategy_task is not None and not trx_strategy_task.done():
        return
    strategy = TRXDcaStrategy(
        broker=LazyPyUpbitBroker(),
        state_store=FirestoreStrategyStateStore(db, firestore),
        trade_recorder=FirestoreTradeRecorder(db, firestore),
        sleep_seconds=60,
        enabled_checker=enabled_checker,
        budget_provider=budget_provider,
    )
    trx_strategy_task = asyncio.create_task(strategy.run_forever())
