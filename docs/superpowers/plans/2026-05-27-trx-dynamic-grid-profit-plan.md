# TRX Dynamic Grid Profit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the TRX bot from fixed 3-step DCA to a dynamic grid with periodic repricing and smaller staged profit taking.

**Architecture:** Keep the strategy in `smart_hub/coin_trx_strategy.py`, extending the existing broker/state/recorder boundaries. Tests in `tests/test_coin_trx_strategy.py` drive dynamic regime selection, ladder repricing, and staged profit-taking behavior.

**Tech Stack:** Python 3.11, FastAPI runtime, Firestore state, Upbit proxy orders, `unittest`.

---

### Task 1: Dynamic Ladder Prices

**Files:**
- Modify: `smart_hub/coin_trx_strategy.py`
- Test: `tests/test_coin_trx_strategy.py`

- [ ] Add tests proving up/range/down regimes produce different ladder prices.
- [ ] Implement a `_market_regime()` helper using recent 5-minute candles.
- [ ] Update `_dca_ladder_prices()` to use regime-specific offsets:
  - up: 0.2%, 0.6%, 1.2%
  - range: 0.4%, 1.0%, 1.8%
  - down: 0.8%, 1.8%, 3.0%
- [ ] Verify DCA tests pass.

### Task 2: Reprice Stale Ladder Orders

**Files:**
- Modify: `smart_hub/coin_trx_strategy.py`
- Test: `tests/test_coin_trx_strategy.py`

- [ ] Add tests proving open bid orders younger than 10 minutes are kept.
- [ ] Add tests proving open bid orders older than 10 minutes are canceled and replaced when desired prices change.
- [ ] Implement repricing inside `_try_place_limit_buy_ladder()`.
- [ ] Verify DCA tests pass.

### Task 3: Staged Profit Taking

**Files:**
- Modify: `smart_hub/coin_trx_strategy.py`
- Test: `tests/test_coin_trx_strategy.py`

- [ ] Add state field `profit_take_stage`.
- [ ] Add tests for +1.2%, +2.0%, and +3.0% staged sells.
- [ ] Replace the current single +3% 50% sell with staged sells:
  - stage 0 at +1.2% sells 30%
  - stage 1 at +2.0% sells 30%
  - stage 2 at +3.0% sells 20%
- [ ] Reset stage after DCA buy fills or market DCA buy.
- [ ] Verify all tests pass.

### Task 4: Docs, Deploy, Live Order Rebuild

**Files:**
- Modify: `README.md`
- Modify: `static/js/coin-ops.js`
- Modify: `public/static/js/coin-ops.js`

- [ ] Update README strategy bullets.
- [ ] Update trade reason labels if new reasons are introduced.
- [ ] Run unit tests, compile checks, and JS syntax checks.
- [ ] Commit and push.
- [ ] Deploy Cloud Run and Firebase Hosting.
- [ ] Cancel current TRX bid ladder and confirm new dynamic ladder orders.
