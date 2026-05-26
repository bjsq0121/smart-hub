# TRX DCA Strategy Design

## Goal

Replace the n8n-driven coin trading path with a smart-hub-owned TRX strategy loop that can run in FastAPI/Cloud Run and persist strategy state in Firestore.

## Strategy

The bot trades `KRW-TRX` only. It runs every 60 seconds, reads Upbit balances, and uses Firestore document `settings/coin-trx-strategy-state` to persist `noPositionSince`, `lastDcaPrice`, `isProfitTaken`, `lastError`, and `updatedAt`.

When TRX is not held, the bot tracks when the zero-position state began. It buys 10% of KRW cash if 5-minute RSI(14) computed from at least 100 candles is `<= 30`. If RSI cannot be computed, that is treated as "RSI condition not met". If the no-position state lasts 24 hours, it buys a 3% scout position.

When TRX is already held, first-entry logic is skipped. DCA uses `lastDcaPrice`, not average price: the next DCA buy happens only when current price is at least 2% below the last buy reference. Successful first/scout/DCA buys update `lastDcaPrice`; successful DCA resets `isProfitTaken` to `false`.

Profit-taking ignores Binance and kimchi premium. If current Upbit TRX price is at least 3% above Upbit average buy price and `isProfitTaken` is false, the bot sells 50% of held TRX and sets `isProfitTaken` to true. It will not sell again until a later DCA resets that flag.

## Market Safety

Every buy path must pass a kimchi premium filter. The bot compares Upbit `KRW-TRX`, Binance `TRX/USDT`, and Upbit `KRW-USDT`:

`(upbitTrxKrw / (binanceTrxUsdt * upbitUsdtKrw) - 1) * 100`

If any external data is missing or the premium is `>= 5%`, no buy is placed. Sell logic does not use this filter.

## Integration

`smart_hub/coin_trx_strategy.py` owns the strategy engine and a `PyUpbitBroker` adapter. `smart_hub.coin` starts the 60-second strategy loop on application startup after dependencies are configured, but the loop only evaluates trades while the existing `settings/coin-autotrade.enabled` flag is true. Tests use fake brokers and fake Firestore state, so they do not call Upbit or Binance.
