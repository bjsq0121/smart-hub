# 2026-05-29 TRX Harvest/Buyback Deploy Handoff

## Current Git State

- Branch: `main`
- Local and remote are aligned: `main...origin/main`
- Latest commit: `768f175 docs: clarify deployed trx runtime commit`
- Runtime change commit: `ff4cf5b feat: add trx harvest buyback safeguards`
- Working tree was clean at `2026-05-29 16:34:02 KST`.

## What Was Implemented

- Added TRX strategy modes:
  - `ACCUMULATE`
  - `HARVEST`
  - `DEFENSIVE`
  - `PAUSED`
- Added harvest/buyback accounting fields:
  - `profitReserveKRW`
  - `buybackBudgetKRW`
  - `lastProfitSellPrice`
  - `lastProfitSellAt`
  - `realizedProfitKRW`
  - `totalBotBuyTRX`
  - `totalBotSellTRX`
  - `accumulationScore`
  - `strategyMode`
  - `riskState`
  - `lastDecisionReason`
- Changed profit taking to sell bot inventory only:
  - Stage 1: +1.2%, sell 20%
  - Stage 2: +2.0%, sell 25%
  - Stage 3: +3.0%, sell 25%
- Added buyback logic:
  - Uses `buybackBudgetKRW`
  - Waits for price to fall about 0.8% below `lastProfitSellPrice`
  - Still requires kimchi premium and risk filters to pass
- Added risk controls:
  - Recent crash blocks new buys
  - High budget usage reduces DCA size
  - Deep bot inventory loss blocks additional buying
  - Bot inventory greater than actual TRX balance blocks selling
- Removed hardcoded Upbit proxy URL/secret from code.
- Added dashboard fields for strategy mode, dry-run/live state, bot inventory, manual protected TRX estimate, profit reserve, buyback budget, realized profit, next buyback price, risk state, and last decision reason.

## Verification Before Deploy

Ran locally:

```bash
python3 -m unittest tests.test_coin_trx_strategy -v
python3 -m compileall smart_hub tests/test_coin_trx_strategy.py
```

Result:

- `tests.test_coin_trx_strategy`: 26 tests passed
- `compileall`: passed

## Deploy State

Cloud Run deploy completed.

- Project: `smarthub-9cd05`
- Region: `asia-northeast3`
- Service: `smart-hub-api`
- Deployed revision: `smart-hub-api-00078-54s`
- Traffic: `100%`
- Service URL check: `https://banghub.kr/` returned HTTP 200
- New revision ERROR log check: no errors at deploy-time check

Commands used to verify:

```bash
gcloud run services describe smart-hub-api \
  --region asia-northeast3 \
  --project smarthub-9cd05 \
  --format='value(status.latestReadyRevisionName,status.traffic[0].percent)'

curl -I https://banghub.kr/
```

## Runtime Safety Configuration

Current Cloud Run env names include:

- `UPBIT_PROXY_URL`
- `UPBIT_PROXY_SECRET`
- `TRX_STRATEGY_DRY_RUN`
- `LIVE_TRADING_ENABLED`
- existing KIS/Naver/MOLIT/Telegram/Upbit API env vars

Important current values:

- `TRX_STRATEGY_DRY_RUN=true`
- `LIVE_TRADING_ENABLED=false`

Meaning:

- The bot can make strategy decisions and record dry-run state.
- Actual Upbit order functions are not called.
- Real trading requires both:
  - `TRX_STRATEGY_DRY_RUN=false`
  - `LIVE_TRADING_ENABLED=true`

Secret Manager:

- `UPBIT_PROXY_SECRET` is connected to secret `upbit-proxy-secret:latest`.
- Cloud Run service account was granted `roles/secretmanager.secretAccessor` for `upbit-proxy-secret`.

## Why TRX Is Not Actually Buying Now

Observed logs show the strategy is deciding to place DCA limit ladders, for example:

```text
[TRX_STRATEGY][dca_limit_ladder_buy] ... {'orders': 3, 'prices': [513, 510, 506], 'krw': 41631}
```

But actual buys are blocked because production was intentionally deployed with:

```text
TRX_STRATEGY_DRY_RUN=true
LIVE_TRADING_ENABLED=false
```

This is the main reason there are no real Upbit buys.

## Known Issue To Fix Next

Dry-run limit orders create fake pending order UUIDs. The next loop tries to reconcile them through the real Upbit proxy, causing repeated logs like:

```text
pending_dca_order_fetch_failed: 404 Client Error: Not Found for url: http://34.47.98.167:9090/
```

Root cause:

- Dry-run order UUIDs are saved into pending DCA state.
- Reconciliation does not currently skip dry-run UUIDs.

Recommended next fix:

- In dry-run mode, either:
  - do not save fake pending orders, or
  - mark them with `dryRun: true` and skip broker reconciliation.
- Add a test before implementation.

## Firebase Deploy Status

Cloud Run deploy succeeded.

Firebase Hosting/Firestore rules deploy did not complete from this machine because Firebase CLI authentication is missing:

```text
Error: Failed to authenticate, have you run firebase login?
```

This does not affect the deployed Cloud Run backend revision. Hosting may still serve cached/static content until Firebase deploy is run from an authenticated environment.

## Useful Resume Commands

```bash
cd /mnt/c/devProject/smart-hub
git status --short --branch
git log --oneline --decorate -5
gcloud run services describe smart-hub-api \
  --region asia-northeast3 \
  --project smarthub-9cd05 \
  --format='value(status.latestReadyRevisionName,status.traffic[0].percent)'
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="smart-hub-api" AND resource.labels.revision_name="smart-hub-api-00078-54s" AND (textPayload:"TRX_STRATEGY" OR jsonPayload.message:"TRX_STRATEGY")' \
  --project smarthub-9cd05 \
  --limit 80 \
  --format='value(timestamp,severity,textPayload)'
```
