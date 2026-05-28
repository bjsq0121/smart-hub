import unittest
from datetime import datetime, timedelta, timezone

from smart_hub.coin_trx_strategy import (
    BalanceSnapshot,
    FirestoreTradeBudgetProvider,
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
        self.limit_buy_orders = []
        self.sell_orders = []
        self.cancelled = []
        self.open_orders = []
        self.order_status = {}
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

    def limit_buy(self, market, price, volume):
        uuid = f"limit-buy-{len(self.limit_buy_orders) + 1}"
        self.limit_buy_orders.append({"market": market, "price": price, "volume": volume})
        self.order_status[uuid] = {"uuid": uuid, "state": "wait", "price": str(price), "volume": str(volume)}
        return {"uuid": uuid}

    def market_sell_volume(self, market, volume):
        self.sell_orders.append({"market": market, "volume": volume})
        return {"uuid": f"sell-{len(self.sell_orders)}"}

    def get_open_orders(self, market):
        return list(self.open_orders)

    def get_order(self, uuid):
        return self.order_status[uuid]

    def cancel_order(self, uuid):
        self.cancelled.append(uuid)
        return {"uuid": uuid}


class FakeDoc:
    def __init__(self, data):
        self.data = data

    def to_dict(self):
        return dict(self.data)


class FakeCollection:
    def __init__(self, rows):
        self.rows = rows

    def stream(self):
        return [FakeDoc(row) for row in self.rows]


class FakeFirestore:
    def __init__(self, rows):
        self.rows = rows

    def collection(self, name):
        return FakeCollection(self.rows)


class TRXDcaStrategyTests(unittest.IsolatedAsyncioTestCase):
    def live_strategy(self, **kwargs):
        kwargs.setdefault("sleep_seconds", 0)
        kwargs.setdefault("dry_run", False)
        kwargs.setdefault("live_trading_enabled", True)
        return TRXDcaStrategy(**kwargs)

    async def test_rsi_failure_counts_as_not_met_and_scout_buys_after_24h(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.candles = []
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=25)))
        strategy = self.live_strategy(broker=broker, state_store=store)

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
        strategy = self.live_strategy(broker=broker, state_store=store, trade_recorder=recorder)

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
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, is_profit_taken=True, profit_take_stage=2))
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 50_000)
        self.assertEqual(store.state.last_dca_price, 97.9)
        self.assertFalse(store.state.is_profit_taken)
        self.assertEqual(store.state.profit_take_stage, 0)

    async def test_dca_respects_total_budget_cap(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=400.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 97.9
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, is_profit_taken=True))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 400_000,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "buy_skipped_budget_cap")
        self.assertEqual(broker.buy_orders, [])
        self.assertTrue(store.state.is_profit_taken)

    async def test_dca_budget_cap_ignores_manual_holding_cost_basis(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=400.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 97.9
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, is_profit_taken=True))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 0,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 50_000)
        self.assertEqual(store.state.last_dca_price, 97.9)
        self.assertFalse(store.state.is_profit_taken)

    async def test_dca_places_three_limit_buys_when_price_is_above_trigger(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=400.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 555.0
        broker.binance_trx_usdt = 0.4
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=556.0, is_profit_taken=True))
        recorder = MemoryTradeRecorder()
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            trade_recorder=recorder,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 0,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_limit_buy_ladder_placed")
        self.assertEqual([o["price"] for o in broker.limit_buy_orders], [552.0, 549.0, 545.0])
        self.assertEqual(sum(int(t["krwAmount"]) for t in recorder.trades), 50_000)
        self.assertEqual(broker.buy_orders, [])
        self.assertEqual(store.state.last_dca_price, 556.0)
        self.assertEqual(store.state.pending_dca_order_uuid, "limit-buy-1")
        self.assertEqual(store.state.pending_dca_order_price, 552.0)
        self.assertEqual([o["uuid"] for o in store.state.pending_dca_orders], ["limit-buy-1", "limit-buy-2", "limit-buy-3"])
        self.assertEqual([o["price"] for o in store.state.pending_dca_orders], [552.0, 549.0, 545.0])
        self.assertEqual([t["type"] for t in recorder.trades], ["buy_order", "buy_order", "buy_order"])
        self.assertEqual([t["reason"] for t in recorder.trades], ["dca_limit_ladder_buy"] * 3)

    async def test_dca_does_not_place_duplicate_limit_buy_when_bid_is_open(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=400.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 555.0
        broker.binance_trx_usdt = 0.4
        broker.open_orders = [{"uuid": "pending-dca", "side": "bid", "created_at": now.isoformat()}]
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=556.0, is_profit_taken=True))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 0,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_limit_buy_ladder_pending")
        self.assertEqual(result["uuid"], "pending-dca")
        self.assertEqual(broker.limit_buy_orders, [])

    async def test_dca_reprices_old_ladder_when_target_prices_move(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=400.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 555.0
        broker.binance_trx_usdt = 0.4
        broker.open_orders = [
            {"uuid": "old-1", "side": "bid", "price": "544", "created_at": (now - timedelta(minutes=11)).isoformat()},
            {"uuid": "old-2", "side": "bid", "price": "546", "created_at": (now - timedelta(minutes=11)).isoformat()},
            {"uuid": "old-3", "side": "bid", "price": "549", "created_at": (now - timedelta(minutes=11)).isoformat()},
        ]
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=556.0, is_profit_taken=True))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 0,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_limit_buy_ladder_placed")
        self.assertEqual(broker.cancelled, ["old-1", "old-2", "old-3"])
        self.assertEqual([o["price"] for o in broker.limit_buy_orders], [552.0, 549.0, 545.0])

    async def test_dynamic_ladder_moves_closer_in_uptrend_and_wider_in_downtrend(self):
        broker = FakeBroker()
        strategy = self.live_strategy(broker=broker, state_store=MemoryStrategyStateStore())

        broker.candles = [{"close": 540.0 + i} for i in range(20)]
        self.assertEqual(strategy._dca_ladder_prices(560.0, 556.0), [558.0, 556.0, 553.0])

        broker.candles = [{"close": 560.0 - i} for i in range(20)]
        self.assertEqual(strategy._dca_ladder_prices(540.0, 556.0), [535.0, 530.0, 523.0])

    async def test_filled_dca_limit_buy_updates_dca_state_without_market_buy(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1100.0, trx_avg_buy_price=540.0, krw_balance=450_000)
        broker.prices["KRW-TRX"] = 543.0
        broker.order_status["limit-buy-1"] = {
            "uuid": "limit-buy-1",
            "state": "done",
            "price": "544",
            "volume": "91.9117647",
        }
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=556.0,
                is_profit_taken=True,
                pending_dca_order_uuid="limit-buy-1",
                pending_dca_order_price=544.0,
                pending_dca_order_krw=50_000,
            )
        )
        recorder = MemoryTradeRecorder()
        strategy = self.live_strategy(broker=broker, state_store=store, trade_recorder=recorder)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "hold")
        self.assertEqual(broker.buy_orders, [])
        self.assertEqual(store.state.last_dca_price, 544.0)
        self.assertFalse(store.state.is_profit_taken)
        self.assertIsNone(store.state.pending_dca_order_uuid)
        self.assertEqual(recorder.trades[0]["type"], "buy")
        self.assertEqual(recorder.trades[0]["reason"], "dca_limit_filled")

    async def test_filled_dca_limit_buy_adds_bot_inventory(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1100.0, trx_avg_buy_price=540.0, krw_balance=450_000)
        broker.prices["KRW-TRX"] = 543.0
        broker.order_status["limit-buy-1"] = {
            "uuid": "limit-buy-1",
            "state": "done",
            "price": "544",
            "volume": "91.9117647",
        }
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=556.0,
                is_profit_taken=True,
                pending_dca_order_uuid="limit-buy-1",
                pending_dca_order_price=544.0,
                pending_dca_order_krw=50_000,
                bot_inventory_trx=10.0,
                bot_inventory_cost_krw=5_000.0,
            )
        )
        strategy = self.live_strategy(broker=broker, state_store=store)

        await strategy.run_once(now=now)

        self.assertAlmostEqual(store.state.bot_inventory_trx, 101.9117647)
        self.assertEqual(store.state.bot_inventory_cost_krw, 55_000.0)

    async def test_existing_manual_holding_seeds_dca_from_current_price(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=120.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 100.0
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=2)))
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "hold")
        self.assertEqual(store.state.last_dca_price, 100.0)
        self.assertIsNone(store.state.no_position_since)
        self.assertEqual(broker.buy_orders, [])

    async def test_profit_take_does_not_sell_existing_manual_holding_without_bot_inventory(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=691.06227524, trx_avg_buy_price=518.50750936, krw_balance=457_000)
        broker.prices["KRW-TRX"] = 552.0
        broker.binance_trx_usdt = 0.4
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=556.0, is_profit_taken=False))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 300_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 0,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_limit_buy_ladder_placed")
        self.assertEqual(broker.sell_orders, [])
        self.assertEqual(store.state.bot_inventory_trx, 0.0)

    async def test_profit_take_sells_in_three_stages_and_ignores_kimchi_failure(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=1000.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 103.1
        broker.fail_kimchi = True
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=100.0,
                is_profit_taken=False,
                bot_inventory_trx=100.0,
                bot_inventory_cost_krw=10_000.0,
            )
        )
        recorder = MemoryTradeRecorder()
        strategy = self.live_strategy(broker=broker, state_store=store, trade_recorder=recorder)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "profit_take_stage_1")
        self.assertEqual(broker.sell_orders[0]["volume"], 20.0)
        self.assertFalse(store.state.is_profit_taken)
        self.assertEqual(store.state.profit_take_stage, 1)
        self.assertAlmostEqual(store.state.bot_inventory_trx, 80.0)
        self.assertAlmostEqual(store.state.bot_inventory_cost_krw, 8_000.0)
        self.assertEqual(recorder.trades[0]["type"], "sell")
        self.assertEqual(recorder.trades[0]["reason"], "profit_take_stage_1")
        self.assertAlmostEqual(recorder.trades[0]["realizedPnlKRW"], 62.0)

        broker.prices["KRW-TRX"] = 102.1
        second = await strategy.run_once(now=now + timedelta(minutes=1))
        self.assertEqual(second["action"], "profit_take_stage_2")
        self.assertEqual(broker.sell_orders[1]["volume"], 20.0)
        self.assertEqual(store.state.profit_take_stage, 2)

        broker.prices["KRW-TRX"] = 103.1
        third = await strategy.run_once(now=now + timedelta(minutes=2))
        self.assertEqual(third["action"], "profit_take_stage_3")
        self.assertEqual(broker.sell_orders[2]["volume"], 15.0)
        self.assertTrue(store.state.is_profit_taken)
        self.assertEqual(store.state.profit_take_stage, 3)
        self.assertAlmostEqual(store.state.bot_inventory_trx, 45.0)

        broker.fail_kimchi = False
        fourth = await strategy.run_once(now=now + timedelta(minutes=3))
        self.assertEqual(fourth["action"], "dca_limit_buy_ladder_placed")
        self.assertEqual(len(broker.sell_orders), 3)

    async def test_high_or_failed_kimchi_blocks_buys(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.prices["KRW-TRX"] = 110.0
        broker.binance_trx_usdt = 0.071
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now - timedelta(hours=25)))
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "buy_blocked_kimchi")
        self.assertEqual(broker.buy_orders, [])

        broker.prices["KRW-TRX"] = 100.0
        broker.fail_kimchi = True
        result = await strategy.run_once(now=now + timedelta(minutes=1))
        self.assertEqual(result["action"], "buy_blocked_kimchi")
        self.assertEqual(broker.buy_orders, [])

    async def test_dry_run_default_does_not_call_broker_order_function(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now))
        strategy = TRXDcaStrategy(broker=broker, state_store=store, sleep_seconds=0)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dry_run_rsi_entry_buy")
        self.assertEqual(broker.buy_orders, [])
        self.assertGreater(store.state.bot_inventory_trx, 0)
        self.assertEqual(store.state.strategy_mode, "ACCUMULATE")

    async def test_live_trading_disabled_blocks_real_order_even_when_dry_run_false(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        store = MemoryStrategyStateStore(StrategyState(no_position_since=now))
        strategy = TRXDcaStrategy(
            broker=broker,
            state_store=store,
            sleep_seconds=0,
            dry_run=False,
            live_trading_enabled=False,
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "live_trading_blocked_rsi_entry_buy")
        self.assertEqual(broker.buy_orders, [])

    async def test_profit_take_updates_profit_reserve_and_buyback_budget(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=100.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 102.0
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=100.0,
                bot_inventory_trx=100.0,
                bot_inventory_cost_krw=10_000.0,
            )
        )
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "profit_take_stage_1")
        self.assertGreater(store.state.profit_reserve_krw, 0)
        self.assertGreater(store.state.buyback_budget_krw, 0)
        self.assertEqual(store.state.last_profit_sell_price, 102.0)
        self.assertEqual(store.state.strategy_mode, "HARVEST")
        self.assertAlmostEqual(store.state.realized_profit_krw, 40.0)
        self.assertAlmostEqual(store.state.total_bot_sell_trx, 20.0)

    async def test_buyback_runs_only_after_profit_sell_pullback(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=80.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 101.3
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=102.0,
                bot_inventory_trx=80.0,
                bot_inventory_cost_krw=8_000.0,
                buyback_budget_krw=10_000.0,
                last_profit_sell_price=102.0,
                is_profit_taken=True,
            )
        )
        strategy = self.live_strategy(broker=broker, state_store=store)

        early = await strategy.run_once(now=now)
        self.assertNotEqual(early["action"], "buyback_buy")
        self.assertEqual(broker.buy_orders, [])

        broker.prices["KRW-TRX"] = 100.9
        ready = await strategy.run_once(now=now + timedelta(minutes=1))
        self.assertEqual(ready["action"], "buyback_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 10_000)
        self.assertEqual(store.state.buyback_budget_krw, 0)

    async def test_crash_market_suspends_dca(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=100.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 96.0
        broker.candles = [{"close": 100.0 - i * 0.25} for i in range(25)]
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, bot_inventory_trx=100.0, bot_inventory_cost_krw=10_000.0))
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "buy_suspended_risk")
        self.assertEqual(broker.buy_orders, [])
        self.assertEqual(store.state.strategy_mode, "DEFENSIVE")

    async def test_high_budget_usage_reduces_dca_amount(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=100.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 97.9
        store = MemoryStrategyStateStore(StrategyState(last_dca_price=100.0, bot_inventory_trx=100.0, bot_inventory_cost_krw=10_000.0))
        strategy = self.live_strategy(
            broker=broker,
            state_store=store,
            budget_provider=lambda: {
                "maxTotalKRW": 200_000,
                "maxPerSymbolKRW": 180_000,
                "currentBotInvestedKRW": 170_000,
            },
        )

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "dca_buy")
        self.assertEqual(broker.buy_orders[0]["krw"], 10_000)

    async def test_profit_take_blocks_when_bot_inventory_exceeds_actual_trx_balance(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.balance = BalanceSnapshot(trx_balance=50.0, trx_avg_buy_price=100.0, krw_balance=500_000)
        broker.prices["KRW-TRX"] = 103.0
        store = MemoryStrategyStateStore(
            StrategyState(
                last_dca_price=100.0,
                bot_inventory_trx=100.0,
                bot_inventory_cost_krw=10_000.0,
            )
        )
        strategy = self.live_strategy(broker=broker, state_store=store)

        result = await strategy.run_once(now=now)

        self.assertEqual(result["action"], "sell_blocked_inventory_mismatch")
        self.assertEqual(broker.sell_orders, [])

    async def test_stale_open_buy_orders_are_cancelled(self):
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        broker = FakeBroker()
        broker.open_orders = [
            {"uuid": "old-buy", "side": "bid", "created_at": (now - timedelta(hours=2)).isoformat()},
            {"uuid": "fresh-buy", "side": "bid", "created_at": (now - timedelta(minutes=5)).isoformat()},
            {"uuid": "old-sell", "side": "ask", "created_at": (now - timedelta(hours=2)).isoformat()},
        ]
        strategy = self.live_strategy(broker=broker, state_store=MemoryStrategyStateStore())

        await strategy.run_once(now=now)

        self.assertEqual(broker.cancelled, ["old-buy"])

    async def test_disabled_strategy_does_not_call_broker(self):
        broker = FakeBroker()
        strategy = self.live_strategy(
            broker=broker,
            state_store=MemoryStrategyStateStore(),
            enabled_checker=lambda: False,
        )

        result = await strategy.run_once()

        self.assertEqual(result["action"], "disabled")
        self.assertEqual(broker.buy_orders, [])
        self.assertEqual(broker.sell_orders, [])

    def test_rsi_calculation_uses_closing_prices(self):
        closes = list(range(1, 120))
        self.assertGreater(calculate_rsi(closes, period=14), 99)

    def test_trade_budget_provider_uses_bot_net_invested_krw(self):
        provider = FirestoreTradeBudgetProvider(
            FakeFirestore(
                [
                    {"type": "buy", "krwAmount": 100_000},
                    {"type": "buy", "krwAmount": 80_000},
                    {"type": "sell", "krwAmount": 120_000},
                    {"type": "cancel", "krwAmount": 999_999},
                ]
            ),
            lambda: {"maxTotalKRW": 300_000, "maxPerSymbolKRW": 180_000},
        )

        cfg = provider()

        self.assertEqual(cfg["maxTotalKRW"], 300_000)
        self.assertEqual(cfg["maxPerSymbolKRW"], 180_000)
        self.assertEqual(cfg["currentBotInvestedKRW"], 60_000)
