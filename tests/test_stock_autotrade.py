import unittest
import importlib
from unittest.mock import patch

from fastapi import HTTPException

import app
import smart_hub.coin as coin_module


class FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class FakeDoc:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return dict(self._data)


class FakeQuery:
    def __init__(self, docs):
        self._docs = list(docs)

    def order_by(self, *args, **kwargs):
        return self

    def where(self, field, op, value):
        if op != "==":
            raise AssertionError(f"unsupported op: {op}")
        return FakeQuery([d for d in self._docs if d.to_dict().get(field) == value])

    def limit(self, n):
        return FakeQuery(self._docs[:n])

    def stream(self):
        return iter(self._docs)


class FakeCollection(FakeQuery):
    pass


class FakeDB:
    def __init__(self, collections):
        self._collections = collections

    def collection(self, name):
        return FakeCollection(self._collections.get(name, []))


class StockAutotradeTests(unittest.IsolatedAsyncioTestCase):
    def test_stock_routes_are_registered_from_stock_module(self):
        stock_module = importlib.import_module("smart_hub.stock")

        self.assertIs(app.stock_router, stock_module.router)
        routes = {
            (getattr(route, "path", ""), tuple(sorted(getattr(route, "methods", []) or []))): route
            for route in stock_module.router.routes
        }
        daily_stats = routes[("/api/stock/paper/daily-stats", ("GET",))]
        quote = routes[("/api/stock/quote", ("GET",))]
        account_balance = routes[("/api/stock/account/balance", ("GET",))]
        account_holdings = routes[("/api/stock/account/holdings", ("GET",))]
        search = routes[("/api/stock/search", ("GET",))]
        order_prepare = routes[("/api/stock/paper/order/prepare", ("POST",))]
        order = routes[("/api/stock/paper/order", ("POST",))]
        positions = routes[("/api/stock/paper/positions", ("GET",))]
        orders = routes[("/api/stock/paper/orders", ("GET",))]
        recent_symbols = routes[("/api/stock/paper/recent-symbols", ("GET",))]
        self.assertEqual(daily_stats.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(quote.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(account_balance.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(account_holdings.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(search.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(order_prepare.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(order.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(positions.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(orders.endpoint.__module__, "smart_hub.stock")
        self.assertEqual(recent_symbols.endpoint.__module__, "smart_hub.stock")

    def test_coin_routes_are_registered_from_coin_module(self):
        coin_module = importlib.import_module("smart_hub.coin")

        self.assertIs(app.coin_router, coin_module.router)
        routes = {
            (getattr(route, "path", ""), tuple(sorted(getattr(route, "methods", []) or []))): route
            for route in coin_module.router.routes
        }
        config_get = routes[("/api/coin/autotrade/config", ("GET",))]
        config_post = routes[("/api/coin/autotrade/config", ("POST",))]
        kill = routes[("/api/coin/autotrade/kill", ("POST",))]
        orders = routes[("/api/coin/autotrade/orders", ("GET",))]
        trx_strategy_state = routes[("/api/coin/trx-strategy/state", ("GET",))]
        trx_strategy_dashboard = routes[("/api/coin/trx-strategy/dashboard", ("GET",))]
        performance = routes[("/api/performance", ("GET",))]
        performance_by_symbol = routes[("/api/performance/by-symbol", ("GET",))]
        pnl_series = routes[("/api/trade-results/pnl-series", ("GET",))]
        backtest_run = routes[("/api/backtest/run", ("POST",))]
        backtest_sweep = routes[("/api/backtest/sweep", ("POST",))]
        engine_config_get = routes[("/api/coin/engine-config", ("GET",))]
        engine_config_post = routes[("/api/coin/engine-config", ("POST",))]
        signals = routes[("/api/signals", ("GET",))]
        paper_trades = routes[("/api/paper-trades", ("GET",))]
        trade_results = routes[("/api/trade-results", ("GET",))]
        self.assertEqual(config_get.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(config_post.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(kill.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(orders.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(trx_strategy_dashboard.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(trx_strategy_state.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(performance.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(performance_by_symbol.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(pnl_series.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(backtest_run.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(backtest_sweep.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(engine_config_get.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(engine_config_post.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(signals.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(paper_trades.endpoint.__module__, "smart_hub.coin")
        self.assertEqual(trade_results.endpoint.__module__, "smart_hub.coin")

    def test_coin_execution_internals_are_not_exported_from_app(self):
        self.assertFalse(hasattr(app, "_upbit_get_accounts"))
        self.assertFalse(hasattr(app, "_coin_engine_symbol_config"))
        self.assertFalse(hasattr(app, "_coin_invest_budget_plan"))
        self.assertFalse(hasattr(app, "_coin_partial_take_profit_plan"))
        self.assertFalse(hasattr(app, "_coin_reentry_check"))
        self.assertTrue(hasattr(coin_module, "upbit_get_accounts"))
        self.assertTrue(hasattr(coin_module, "safe_coin_autotrade_on_signal"))
        self.assertTrue(hasattr(coin_module, "start_coin_autotrade_monitor"))
        self.assertTrue(hasattr(coin_module, "start_trx_strategy_loop"))

    def test_readiness_reports_missing_kis_env(self):
        with patch.multiple(
            app,
            KIS_APP_KEY="",
            KIS_APP_SECRET="",
            KIS_ACCOUNT_NO="",
            KIS_ACCOUNT_PROD="",
        ):
            status = app._stock_autotrade_status_snapshot({"enabled": False})

        self.assertFalse(status["ready"])
        self.assertIn("kis_env_missing", status["blockedReasons"])

    async def test_enable_rejected_when_kis_env_missing(self):
        req = FakeRequest({"enabled": True})
        user = {"email": "admin@example.com"}

        with patch.object(app, "_ensure_admin"), patch.multiple(
            app,
            KIS_APP_KEY="",
            KIS_APP_SECRET="",
            KIS_ACCOUNT_NO="",
            KIS_ACCOUNT_PROD="",
        ):
            with self.assertRaises(HTTPException) as ctx:
                await app.api_autotrade_config_post(req, user)

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("KIS_APP_KEY", str(ctx.exception.detail))

    def test_event_detail_includes_skip_diagnostics(self):
        detail = app._autotrade_event_detail(
            {
                "symbol": "SK하이닉스",
                "symbolCode": "000660",
                "signalId": "sig-1",
                "score": 8.4,
                "stage": "trade_ready",
                "direction": "long",
                "entryPrice": 95000,
            },
            reason="qty_zero",
            budget=100000,
            currentPrice=101000,
            qty=0,
        )

        self.assertEqual(detail["reason"], "qty_zero")
        self.assertEqual(detail["symbolCode"], "000660")
        self.assertEqual(detail["entryPrice"], 95000)
        self.assertEqual(detail["budget"], 100000)
        self.assertEqual(detail["currentPrice"], 101000)
        self.assertEqual(detail["qty"], 0)

    def test_market_closed_skip_detail_flags_trade_ready_policy_violation(self):
        detail = app._market_closed_skip_detail({
            "symbol": "HPSP",
            "stage": "trade_ready",
            "direction": "long",
            "entryPrice": 49000,
        })

        self.assertEqual(detail["reason"], "market_closed")
        self.assertEqual(detail["warning"], "after_hours_trade_ready")
        self.assertEqual(detail["stage"], "trade_ready")

    def test_market_closed_skip_detail_leaves_candidate_without_warning(self):
        detail = app._market_closed_skip_detail({
            "symbol": "ISC",
            "stage": "candidate",
            "direction": "long",
            "entryPrice": 85000,
        })

        self.assertEqual(detail["reason"], "market_closed")
        self.assertNotIn("warning", detail)
        self.assertEqual(detail["stage"], "candidate")

    def test_coin_engine_symbol_config_uses_defaults_without_match(self):
        cfg = coin_module.coin_engine_symbol_config("TRX", {"symbols": {"XRP": {"sizeMultiplier": 1.8}}})
        self.assertEqual(cfg, {})

    def test_coin_engine_symbol_config_matches_uppercase_symbol(self):
        cfg = coin_module.coin_engine_symbol_config("trx", {
            "symbols": {
                "TRX": {"sizeMultiplier": 1.6, "maxPerSymbolKRW": 180000},
            }
        })
        self.assertEqual(cfg["sizeMultiplier"], 1.6)
        self.assertEqual(cfg["maxPerSymbolKRW"], 180000)

    def test_coin_budget_plan_applies_symbol_multiplier_and_cap(self):
        plan = coin_module.coin_invest_budget_plan(
            total_asset=1_000_000,
            current_invested=100_000,
            krw_balance=300_000,
            max_total=500_000,
            default_position_size_pct=10.0,
            default_max_per_symbol=100_000,
            symbol_cfg={"sizeMultiplier": 1.8, "maxPerSymbolKRW": 180_000},
        )
        self.assertEqual(plan["budgetByPct"], 180000)
        self.assertEqual(plan["maxPerSymbolKRW"], 180000)
        self.assertEqual(plan["investKRW"], 180000)

    def test_coin_partial_take_profit_plan_sells_half_once_threshold_hit(self):
        plan = coin_module.coin_partial_take_profit_plan(
            current_price=103.0,
            entry_price=100.0,
            current_volume=10.0,
            order={"partialExitDone": False},
            symbol_cfg={"partialTakeProfitPct": 3.0, "partialTakeProfitRatio": 0.5},
        )
        self.assertTrue(plan["shouldSell"])
        self.assertEqual(plan["sellVolume"], 5.0)
        self.assertEqual(plan["thresholdPct"], 3.0)

    def test_coin_partial_take_profit_plan_skips_when_already_done(self):
        plan = coin_module.coin_partial_take_profit_plan(
            current_price=105.0,
            entry_price=100.0,
            current_volume=10.0,
            order={"partialExitDone": True},
            symbol_cfg={"partialTakeProfitPct": 3.0, "partialTakeProfitRatio": 0.5},
        )
        self.assertFalse(plan["shouldSell"])

    def test_coin_reentry_check_requires_dip_after_recent_exit(self):
        allowed, detail = coin_module.coin_reentry_check(
            current_price=97.0,
            symbol_cfg={"reentryDipPct": 2.5, "maxDailyReentries": 2},
            last_exited_order={"exitPrice": 100.0},
            daily_reentry_count=1,
        )
        self.assertTrue(allowed)
        self.assertEqual(detail["dipPct"], 2.5)

    def test_coin_reentry_check_blocks_without_required_dip(self):
        allowed, detail = coin_module.coin_reentry_check(
            current_price=99.0,
            symbol_cfg={"reentryDipPct": 2.5, "maxDailyReentries": 2},
            last_exited_order={"exitPrice": 100.0},
            daily_reentry_count=1,
        )
        self.assertFalse(allowed)
        self.assertEqual(detail["reason"], "reentry_price_not_reached")

    def test_coin_reentry_check_blocks_when_daily_limit_hit(self):
        allowed, detail = coin_module.coin_reentry_check(
            current_price=97.0,
            symbol_cfg={"reentryDipPct": 2.5, "maxDailyReentries": 2},
            last_exited_order={"exitPrice": 100.0},
            daily_reentry_count=2,
        )
        self.assertFalse(allowed)
        self.assertEqual(detail["reason"], "reentry_daily_limit")

    def test_debug_snapshot_includes_recent_signals_and_events(self):
        db = FakeDB({
            "stock_signals": [
                FakeDoc("sig-1", {
                    "signalId": "sig-1",
                    "symbol": "삼성전자",
                    "symbolCode": "005930",
                    "stage": "trade_ready",
                    "direction": "long",
                    "source": "paperclip",
                }),
            ],
            "events": [
                FakeDoc("skip-1", {
                    "kind": "autotrade_skip",
                    "reason": "market_closed",
                    "signalId": "sig-1",
                    "symbol": "삼성전자",
                }),
                FakeDoc("err-1", {
                    "kind": "autotrade_error",
                    "reason": "price_fetch_failed",
                    "signalId": "sig-2",
                    "symbol": "SK하이닉스",
                }),
            ],
        })

        result = app._stock_autotrade_debug_snapshot(db, limit=5)

        self.assertEqual(result["counts"]["recentSignals"], 1)
        self.assertEqual(result["counts"]["recentSkips"], 1)
        self.assertEqual(result["counts"]["recentErrors"], 1)
        self.assertEqual(result["recentSignals"][0]["source"], "paperclip")
        self.assertEqual(result["recentSkips"][0]["reason"], "market_closed")
        self.assertEqual(result["recentErrors"][0]["reason"], "price_fetch_failed")


if __name__ == "__main__":
    unittest.main()
