# TRX DCA Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Firestore-backed TRX DCA and profit-taking strategy loop for smart-hub.

**Architecture:** Add a focused `smart_hub.coin_trx_strategy` module with a strategy class, broker adapter, Firestore state store, and async loop runner. Wire the loop from `smart_hub.coin` startup without moving strategy details back into `app.py`.

**Tech Stack:** FastAPI startup, Google Firestore, pyupbit, ccxt, unittest with fake brokers/stores.

---

### Task 1: Strategy Module And Tests

**Files:**
- Create: `smart_hub/coin_trx_strategy.py`
- Create: `tests/test_coin_trx_strategy.py`
- Modify: `requirements.txt`
- Modify: `Dockerfile`

- [x] Write tests for RSI failure fallback, scout entry after 24 hours, DCA from `lastDcaPrice`, profit-take once per cycle, and kimchi premium buy blocking.
- [x] Implement `TRXDcaStrategy`, `FirestoreStrategyStateStore`, and `PyUpbitBroker`.
- [x] Keep pyupbit/ccxt imports lazy enough that tests can run without live credentials.

### Task 2: Startup Integration

**Files:**
- Modify: `smart_hub/coin.py`
- Modify: `tests/test_stock_autotrade.py`

- [x] Start the TRX strategy loop from the existing coin startup path.
- [x] Assert the coin module exposes the new strategy startup function and keeps app-level coin internals out of `app.py`.

### Task 3: Verification

**Commands:**
- [x] `venv/bin/python -m unittest discover -s tests -v`
- [x] `venv/bin/python -m compileall app.py smart_hub tests`
- [x] Import app and verify route count remains stable with no duplicate routes.
