# App Route Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split stock and coin route registration out of `app.py` while preserving every public route path and existing behavior.

**Architecture:** Create a `smart_hub` package with stock and coin router modules. This first slice keeps shared helpers in `app.py` and moves route functions only where dependencies are manageable; if a direct move would create circular imports, register route definitions through domain modules that accept the existing app/dependencies.

**Tech Stack:** FastAPI, Python 3.11, unittest, Firestore client helpers.

---

### Task 1: Add Route Registration Smoke Tests

**Files:**
- Modify: `tests/test_stock_autotrade.py`

- [ ] Add tests that assert representative stock and coin routes remain registered on `app.app`.
- [ ] Run the route tests and verify they fail before extraction if the expected module markers are missing.
- [ ] Keep the tests focused on route presence and importability, not external API calls.

### Task 2: Create Domain Package

**Files:**
- Create: `smart_hub/__init__.py`
- Create: `smart_hub/stock.py`
- Create: `smart_hub/coin.py`

- [ ] Add module docstrings and route registration placeholders.
- [ ] Keep modules dependency-light so imports do not initialize network clients.

### Task 3: Move Stock and Coin Registration Boundaries

**Files:**
- Modify: `app.py`
- Modify: `smart_hub/stock.py`
- Modify: `smart_hub/coin.py`

- [ ] Extract stock route registration into `smart_hub.stock`.
- [ ] Extract coin route registration into `smart_hub.coin`.
- [ ] Preserve existing endpoint names, paths, dependencies, and response behavior.
- [ ] Include routers in `app.py`.

### Task 4: Verify

**Files:**
- No production file changes.

- [ ] Run `venv/bin/python -m unittest discover -s tests -v`.
- [ ] Import the app with `venv/bin/python -c "import app; print(len(app.app.routes))"`.
- [ ] Check `git diff --stat` and confirm unrelated `CLAUDE.md` edits are untouched.
