# M2 — What a Synced Trade Actually Contains

Reference for what cTrader sends per trade, what LuceEdge stores, and what's
deliberately left out. Based on a real synced trade (BTCUSD, demo account).

## Stored in `raw_trades` (what the app actually uses)

| Column | Example | Source |
|---|---|---|
| `symbol` | `BTCUSD` | Resolved from cTrader's numeric `symbolId` via a separate symbol-list lookup |
| `side` | `sell` | `buy` or `sell` |
| `volume` | `1` | Position size, as cTrader reports it — unit/lot scaling not independently verified yet |
| `open_time` | `2026-07-26T15:14:39.741Z` | Derived from the *opening* fill for this position, not the closing deal's own timestamp |
| `close_time` | `2026-07-26T15:15:16.28Z` | The closing deal's own execution timestamp |
| `open_price` | `64649.6` | From the closing deal's `closePositionDetail.entryPrice` |
| `close_price` | `64648.4` | The closing deal's own `executionPrice` |
| `fees` | `0` | From `closePositionDetail.commission` (scaling assumption: divided by 100 — unverified against a non-zero real value) |
| `swap` | `0` | From `closePositionDetail.swap` (same scaling caveat) |
| `dedup_hash` | (sha256) | `connection_id + broker_trade_id`, prevents re-importing the same trade twice |
| `raw_payload` | (full JSON) | The complete closing-deal record below, kept for reference/reprocessing |

## Full raw API response for the closing deal (what's in `raw_payload`)

```json
{
  "dealId": "326860620",
  "positionId": "279235202",
  "orderId": "311930761",
  "symbolId": "22395",
  "tradeSide": 2,
  "volume": "1",
  "filledVolume": "1",
  "executionPrice": 64648.4,
  "createTimestamp": "1785078916042",
  "executionTimestamp": "1785078916280",
  "dealStatus": 2,
  "commission": "0",
  "closePositionDetail": {
    "entryPrice": 64649.6,
    "grossProfit": "-1",
    "swap": "0",
    "commission": "0",
    "balance": "99999"
  }
}
```

| Field | Meaning |
|---|---|
| `dealId` | Unique ID for this specific fill |
| `positionId` | Links this fill to its opening fill — how `open_time` gets derived |
| `orderId` | The order that produced this fill |
| `symbolId` | Numeric symbol ID (not human-readable on its own) |
| `tradeSide` | `1` = buy, `2` = sell |
| `volume` / `filledVolume` | Requested vs. actually filled size |
| `executionPrice` | Price this specific fill executed at |
| `createTimestamp` / `executionTimestamp` | Order-created vs. actually-filled time |
| `dealStatus` | `2` = filled (also: partially filled, rejected, error, missed) |
| `commission` | Commission on this fill |
| `closePositionDetail` | Only present on a *closing* fill — its presence is how the app knows this deal completes a round-trip, not just opens one |
| `closePositionDetail.entryPrice` | The original open price |
| `closePositionDetail.grossProfit` | cTrader's own P&L calculation for this trade |
| `closePositionDetail.balance` | Account balance immediately after this trade |

## What cTrader offers that isn't captured at all right now

- The **opening deal's** own full record — only its timestamp is used (to compute `open_time`), then it's discarded, not stored
- `marginRate`, `baseToUsdConversionRate`, `moneyDigits`, `utcLastUpdateTimestamp` (on the deal)
- `quoteToDepositConversionRate`, `closedVolume`, `balanceVersion`, `pnlConversionFee` (on `closePositionDetail`)
- Anything beyond closed-deal history — live quotes, open positions, pending orders, account balance/margin/equity, symbol precision/pip size. Out of scope for M2 (read-only closed-trade import only).

## Known unverified assumptions (flagged in code, not yet confirmed against real non-zero data)

1. `fees`/`swap` divided by 100 — this trade had zero for both, so the scaling is untested
2. `volume` stored as cTrader's raw number, no lot-size conversion applied
3. Position-grouping for `open_time` — validated once against a simple single-fill trade; not yet tested against a position with multiple partial closes
