import unittest
from datetime import datetime, timedelta, timezone

from smart_hub.coin_trx_strategy import (
    BalanceSnapshot,
    MemoryTradeRecorder,
    MemoryStrategyStateStore,
    StrategyState,
    TRXDcaStrategy,
    calculate_rsi,
)


class FakeBroker:
    def __init__(self):
        self.balance = BalanceSnapshot(trx_balance=0.0, trx_avg_buy_price=0.0, krw_balance=1_000_000)
        self.prices = {"KRW-TRX": 100.0, "KRW-USDT": 1400.0}
        self.binance_trx_usdt = 0.071
        self.candles = [{"close": 100.0 - (i * 0.1)} for i in range(100)]
        self.buy_orders = []
        self.sell_orders = []
        self.cancelled = []
        self.open_orders = []
        self.fail_kimchi = False

    def get_balance_snapshot(self):
        return self.balance

    def get_current_price(self, market):
        return self.prices[market]

    def get_ohlcv(self, market, interval, count):
        return self.candles[:count]

    def get_binance_trx_usdt(self):
        if self.fail_kimchi:
            raise RuntimeError("binance down")
        return self.binance_trx_usdt

    def market_buy_krw(self, market, krw_amount):
        self.buy_orders.append({"market": market, "krw": krw_amount})
        return {"uuid": f"buy-{len(self.buy_orders)}"}

    def market_sell_volume(self, market, volume):
        self.sell_orders.append({"market": market, "volume": volume})
        return {"uuid": f"sell-{len(self.sell_orders)}"}

    def get_open_orders(self, market):
        return list(self.open_orders)

    def cancel_order(self, uuid):
        self.cancelled.append(uuid)
        return {"uuid": uuid}


class TRXDcaStrategyTests(unittest.IsolatedAsyncioTestCase):
    async def test_rsi_failure_counts_as_not_met_and_scout_buys_after_24h(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.candles = []
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=25)))
        strategy = TRXDcaStrategy(broker=broker, state_store=store, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "scout_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 30_000)
        self.assertEqual(store.state.last_dca_price, 100.0)
        self.assertFalse(store.state.is_profit_taken)

    async def test_rsi_entry_buys_ten_percent_when_not_holding(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now))
        recorder = MemoryTradeRecorder()
        strategy = TRXDcaStrategy(broker=broker, state_store=store, trade_recorder=recorder, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "rsi_entry_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 100_000)
        self.assertEqual(recorder.trades[0]["type"], "buy")
        self.assertEqual(recorder.trades[0]["reason"], "rsi_entry_buy")
        self.assertEqual(recorder.trades[0]["trxVolume"], 1000.0)

    async def test_dca_uses_last_dca_price_and_resets_profit_flag(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 97.9
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, is_profit_taken=True))
        strategy = TRXDcaStrategy(broker=broker, state_store=store, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 50_000)
        self.assertEqual(store.state.last_dca_price, 97.9)
        self.assertFalse(store.state.is_profit_taken)

    async def test_existing_manual_holding_seeds_dca_from_current_price(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=120.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 100.0
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=2)))
        strategy = TRXDcaStrategy(broker=broker, state_store=store, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "hold")
        self.assertEqual(store.state.last_dca_price, 100.0)
        self.assertIsNone(store.state.no_position_since)
        self.assertEqual(broker.buy_orders, [])

    async def test_profit_take_sells_half_once_and_ignores_kimchi_failure(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 103.1
        broker.fail_kimchi = True
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, is_profit_taken=False))
        recorder = MemoryTradeRecorder()
        strategy = TRXDcaStrategy(broker=broker, state_store=store, trade_recorder=recorder, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "profit_take")
        self.assertEqual(broker.sell_orders[0]["volume"], 500.0)
        self.assertTrue(store.state.is_profit_taken)
        self.assertEqual(recorder.trades[0]["type"], "sell")
        self.assertEqual(recorder.trades[0]["reason"], "profit_take")
        self.assertAlmostEqual(recorder.trades[0]["realizedPnlKRW"], 1550.0)

        second = await strategy.run_once(now=now + timedelta(minutes=1))
        self.assertEqual(second["action"], "hold")
        self.assertEqual(len(broker.sell_orders), 1)

    async def test_high_or_failed_kimchi_blocks_buys(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.prices["KRW-TRX"] = 110.0
        broker.binance_trx_usdt = 0.071
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=25)))
        strategy = TRXDcaStrategy(broker=broker, state_store=store, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "buy_blocked_kimchi")
        self.assertEqual(broker.buy_orders, [])

        broker.prices["KRW-TRX"] = 100.0
        broker.fail_kimchi = True
        result = await strategy.run_once(now=now + timedelta(minutes=1))
        self.assertEqual(result["action"], "buy_blocked_kimchi")
        self.assertEqual(broker.buy_orders, [])

    async def test_stale_open_buy_orders_are_cancelled(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.open_orders = [
            {"uuid": "old-buy", "side": "bid", "created_at": (now - timedelta(hours=2)).isoformat()},
            {"uuid": "fresh-buy", "side": "bid", "created_at": (now - timedelta(minutes=5)).isoformat()},
            {"uuid": "old-sell", "side": "ask", "created_at": (now - timedelta(hours=2)).isoformat()},
        ]
        strategy = TRXDcaStrategy(broker=broker, state_store=MemoryStrategyStateStore(), sleep_seconds=0)

        await strategy.run_once(now=now)

        self.assertEqual(broker.cancelled, ["old-buy"])

    async def test_disabled_strategy_does_not_call_broker(self):
        broker = FakeBroker()
        strategy = TRXDcaStrategy(
            broker=broker,
            state_store=MemoryStrategyStateStore(),
            sleep_seconds=0,
            enabled_checker=lambda: False,
        )

        result = await strategy.run_once()

        self.assertEqual(result["action"], "disabled")
        self.assertEqual(broker.buy_orders, [])
        self.assertEqual(broker.sell_orders, [])

    def test_rsi_calculation_uses_closing_prices(self):
        closes = list(range(1, 120))
        self.assertGreater(calculate_rsi(closes, period=14), 99)
