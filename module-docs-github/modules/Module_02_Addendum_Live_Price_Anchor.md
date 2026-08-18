# Module 2 — Addendum: Delayed Price Anchor (Chip Pre-Fill)

> **Status:** Approved for V1 — **crypto and forex only**. Indian equity/F&O and US/global equities are out of scope (no free redistribution-cleared source) — see FS-05.
> **Parent module:** Module 2 — Trade Entry (Quick Log + Plan-a-Trade)
> **New table:** `instrument_prices`
> **Depends on:** `instruments` (M02), the price-poller worker (new infra, this addendum)

---

## A6. Summary & Rationale

A new best-effort price cache lets the trade form offer a one-tap "use this price" chip that pre-fills `entry_price` / `exit_price` (Quick Log) and `planned_trigger_price` / `planned_stop_loss` / `planned_target` (Plan-a-Trade) with a recent market price. The goal is **effort reduction, not authority**: the chip gives the user a starting number so they don't dial a price from zero, and they edit normally from there.

Three decisions frame the entire design and should not be relitigated without revisiting the brainstorm that produced them:

1. **The price is an anchor, not a default.** It is presented as a tappable suggestion, never silently written into the field. This sidesteps the "subtly wrong default over a real fill" failure mode — the user always performs an explicit tap and then edits, so a few ticks of staleness is expected and harmless.
2. **15-minute staleness is acceptable.** This was the explicit freshness requirement. It removes any need for WebSockets, tick-level polling, or tight rate-limit choreography, and it keeps the data in a more permissive licensing category than realtime.
3. **Only legally-cacheable markets are covered: crypto and forex.** Both have free sources whose terms permit caching delayed/public data and polling from a central server. Two markets were evaluated and **excluded** because no free source permits redistribution to end users: **Indian equity/F&O** (NSE/BSE data is exchange-licensed; redistribution requires a paid authorized-vendor agreement) and **US/global equities** (US exchange data is exchange/FINRA/SEC-regulated; free-tier providers such as Finnhub, Alpha Vantage, Twelve Data permit display/personal use but gate commercial redistribution behind paid plans — confirmed against Finnhub's terms). The "ingest → our DB → serve per user" pattern *is* redistribution, so both equity markets are deferred to FS-05.

The chip is **purely additive**. When no fresh price is available (unsupported instrument, stale cache, India, custom instrument, network failure), the chip simply does not render and the price field behaves exactly as it does today. There is no separate broken state to design.

### Why the scroller / digit-stepper was not built in V1

A tactile price scroller was considered and deferred. A raw price spinner cannot serve crypto + forex because price magnitude spans ~6 orders of magnitude (a forex pip at 0.0001 vs a BTC dollar at ~$67,000); no single tick size works. A per-digit anchored stepper solves the magnitude problem but is net-new mobile-gesture UI on the most-used screen, and its advantage only materializes when the anchor is *close* to the target — which is true in Plan-a-Trade but not in post-trade Quick Log (where the live anchor may be hours away from the actual fill). The chip captures ~90% of the effort reduction at ~10% of the build cost and zero new gesture risk. The stepper is parked pending telemetry (see A6.6).

---

## A6.1 User Stories

#### As an active trader logging a crypto or forex trade, I want a one-tap chip showing the recent market price, so that I start from a real number instead of typing from zero.
#### As an active trader, I want the chip to be clearly a suggestion I tap to use — not a value silently filled in — so that I never accidentally record the market price instead of my actual fill.
#### As an active trader, I want to freely edit the price after tapping the chip, so that I can correct it to my exact fill.
#### As a Pro trader planning a trade, I want the current price as a one-tap anchor for my trigger, stop, and target, so that I can set levels relative to where the market is right now.
#### As an active trader on an instrument we can't price (Indian equity/F&O, a custom instrument, or a thinly-covered symbol), I want the form to behave exactly as before with no chip, so that the absence of a price is never a blocker or an error.
#### As an active trader, I want to see roughly how fresh the price is, so that I know whether to trust it as a close anchor or just a rough magnitude hint.

---

## A6.2 Acceptance Criteria

### A6.2.1 Chip Rendering

- Given an instrument is selected whose `asset_class` is Crypto or Forex **and** a non-stale `instrument_prices` row exists for it, when the price field is focused or rendered, then a chip appears above the field reading "Use ~{price} {quote_currency}".
- Given the same conditions, when the chip renders, then a secondary freshness label shows the price age in human terms (e.g. "live · 2 min ago", "delayed · 12 min ago").
- Given an instrument's `asset_class` is Equity/F&O with an Indian `exchange` (NSE/BSE/MCX), when the field renders, then **no chip appears** regardless of cache state.
- Given the selected instrument is a custom instrument (`is_custom_instrument = true`), when the field renders, then no chip appears.
- Given no `instrument_prices` row exists for the instrument, or the newest row is stale (see A6.4), when the field renders, then no chip appears.

### A6.2.2 Chip Interaction

- Given the chip is visible, when the user taps it, then the displayed price is written into the focused price field and the field becomes immediately editable with the value selected/highlighted for easy overwrite.
- Given the user has tapped the chip and then edits the value, when they edit, then the chip does not re-overwrite their input (tapping is a one-shot fill, not a binding).
- Given the chip was tapped, when the resulting value is saved on the trade, then a flag `entry_price_from_anchor` / `exit_price_from_anchor` (or the plan-field equivalent) is recorded for telemetry (see A6.6). This flag is **not** user-visible and has no behavioral effect.
- Given the user never taps the chip and types manually, when saved, then the anchor flag is false.

### A6.2.3 Quick Log vs Plan-a-Trade

- Given Quick Log, when the chip is shown, then it is available on both `entry_price` and `exit_price` fields (each independently uses the same single cached price as its anchor).
- Given Plan-a-Trade, when the chip is shown, then it is available on `planned_trigger_price`, `planned_stop_loss`, and `planned_target`.
- In Quick Log, the freshness label copy leans toward "rough magnitude" framing because the trade may have closed hours ago; in Plan-a-Trade it leans toward "current price" framing because the user is planning against the live market. (Copy details in A6.5.)

---

## A6.3 Architecture — Price Poller & Cache

### A6.3.1 Pattern

A scheduled server-side worker polls free market-data sources on an interval matched to the 15-minute freshness target, and upserts the latest price per instrument into `instrument_prices`. The trade form reads the single latest cached row per instrument; it never calls a third-party API directly, and the client never calls one (avoids exposing keys and avoids client-side rate-limit bans).

This is consistent with the existing tech-stack stance that aggregates are pre-computed snapshots rather than live time-series — a single "latest price per instrument" cache, not a tick store. It does **not** introduce TimescaleDB or a time-series DB; that remains a >100k-MAU consideration per the tech-stack review.

### A6.3.1a Latency budget — how fresh the anchor actually is

Displayed price age is the sum of three stages, not just the polling interval. The realistic floor for this architecture is far inside the 15-minute acceptability ceiling:

| Stage | Crypto (Binance) | Forex (ECB-backed endpoint) |
|---|---|---|
| 1. Source freshness | ~0s (sub-second at source) | ~60s on aggregator endpoints; **up to 24h if using raw ECB reference rates** (published once daily ~16:00 CET) — so use a per-minute aggregator, not raw ECB |
| 2. Polling interval (we control) | every 10–15s, **one batched call** for the whole watchlist (`/ticker/price` returns all symbols at once) | every 60s, one call returns all pairs |
| 3. Read staleness (user opens form between polls) | avg ½ interval, peak = full interval | avg ½ interval, peak = full interval |
| **Typical age shown** | **10–30 seconds** | **1–2 minutes** |

Because both sources return the entire watchlist in a single batched request, tightening the polling interval is essentially free — it does not scale request count with symbol count. Crypto can credibly be labeled "live · seconds ago"; forex "live · ~1 min ago".

**What polling cannot do:** react to a price *between* polls. This is irrelevant for a pre-fill anchor (the user starts from the number and edits), but it is the reason true sub-second live P&L on open positions — explicitly out of V1 scope — would require a Binance **WebSocket** subscription, a different worker design. That is the documented upgrade path, not a tighter poll.

**Infra caveat:** "every 10s" assumes a warm worker. Serverless/cron schedulers that floor at a 1-minute minimum interval will set the real floor, not the rate limit. Confirm the scheduler's minimum interval at implementation; if it floors at 60s, crypto age becomes ~30–60s, still an order of magnitude inside the ceiling.

### A6.3.2 Watchlist derivation (critical for staying under free limits)

The worker does **not** poll entire exchanges. It polls only the set of instruments users actually touch:

- The distinct set of `instrument_id` across (a) trades created or edited in the last N days, (b) any `pending` planned trades, and (c) instruments marked `is_popular = true` for the covered asset classes.
- This keeps the watchlist in the tens-to-low-hundreds of symbols rather than thousands, which keeps every source comfortably inside free rate limits even with conservative polling.

### A6.3.3 Source mapping by market

| Market | Source posture | Notes |
|---|---|---|
| Crypto (spot + perps) | **Binance** public endpoints — no key, no account, no per-call charge for market data. Poll from server with backoff. Kraken public REST as backup. | Most permissive; caching last-price is fine. Weight-based limit (~1200/min/IP); escalating IP bans on abuse → always server-side with backoff, never from client. |
| Forex | **ECB-backed free FX endpoint** (no key, no signup, no credit card). | "Price" is an aggregated rate refreshed ~per-minute at best, not an exchange last-trade — fine for a 15-min anchor. **Do not use fastFOREX** — its terms forbid redistribution and prohibit trading use. Confirm the chosen endpoint's clause permits caching/display. |
| US/global equities | **None — excluded for V1.** | Free providers (Finnhub, Alpha Vantage, Twelve Data) permit display/personal use but gate commercial redistribution behind paid plans (confirmed against Finnhub). The cache-and-serve model is redistribution. See FS-05. |
| Indian equity/F&O (NSE/BSE/MCX) | **None — excluded.** | Exchange-licensed; redistribution prohibited without paid authorized-vendor agreement. SEBI framework tightening (static-IP mandate effective Apr 2026). See FS-05. |

> **Engineering note:** exact free-tier limits and redistribution clauses change frequently. The forex endpoint should be re-verified against current terms at implementation time, not assumed from this doc. Binance public market-data access is stable but confirm the no-key endpoints haven't changed.

### A6.3.3a Instrument seeding — populating the `instruments` table (ALL markets)

**Seeding the instrument list and mapping it to a price source are two separate jobs.** The `instruments` table must cover *every* asset class because Module 2's autocomplete search (§3.3) serves all of them — a user trading NSE equity still needs "RELIANCE" to autocomplete even though it will never get a price chip. Only crypto and forex additionally get a price mapping.

Critically, an instrument **master/reference list is a different licensing category than quote data.** Importing the *fact* that a symbol trades (name, ticker, lot size, expiry, tick size, exchange) is permitted from sources that prohibit redistributing live *quotes*. Broker instrument-master dumps make this explicit: they are import-ready CSV/JSON files generated once daily, and the `last_price` field is deliberately zeroed/static — the metadata is freely importable, the live price is the licensed part. So we seed names everywhere; we only attach price mappings where quote redistribution is also cleared.

| Market | Seeding source for the instrument list | Gets price mapping? |
|---|---|---|
| Crypto | Binance `exchangeInfo` (full tradable symbol universe, keyless). Seed popular pairs. | **Yes** — mapping comes for free since the list came from the price source itself. |
| Forex | The FX endpoint's currency/pairs list (keyless). Seed major + common pairs. | **Yes** — same: list and price come from the same source. |
| US/global equities | A keyless reference/listing source (exchange-published listed-company lists, or a static seed file of common tickers). | **No** — name only; no `instrument_source_map` row → chip never renders (see A6.2.1). |
| Indian equity/F&O | Exchange-published equity/F&O lists, **or** a static seed file. **Avoid broker masters (Kite/Upstox/Groww) as the central seed source** — they sit behind per-user OAuth and cannot be pulled from a keyless central job. | **No** — name only; no mapping row → no chip. |

**Refresh cadence:** crypto/forex symbol lists refresh on the same worker that polls prices (cheap). Equity/F&O master lists refresh on a slow cadence (daily or weekly) since listings change rarely; F&O contracts expire and roll, so the F&O seed needs a periodic refresh to add new expiries and retire dead ones — but this is a background reference job, unrelated to the price worker.

### A6.3.3b Source-symbol mapping — the translation layer

The `instruments` table stores a human `instrument_name`; each price source uses its own symbol format (`BTC`/`Bitcoin`/`XBT` → Binance `BTCUSDT`; `EUR/USD` → FX endpoint `EUR` against base `USD`). There is no natural shared key, so string-matching `instrument_name` against a source will miss most instruments. A dedicated mapping table is the translator (schema in A6.7).

The worker loop becomes: read watchlist (`instrument_id`s) → look up each `source_symbol` via `instrument_source_map` → batch-fetch from source → write `instrument_prices` keyed by `instrument_id`. The user's free-text never touches the source.

**Three buckets of instrument:**

1. **Seeded + mapped** (popular crypto/forex): mapping row exists → chip works. This is most of the trade volume, since trading concentrates in a few dozen liquid instruments.
2. **Mappable but not seeded** (an altcoin Binance lists but we didn't pre-load): handled by **lazy mapping** (A6.3.3c).
3. **Unmappable** (custom instruments, all equities/F&O, anything no source recognizes): no mapping row → no chip → manual entry. This is the graceful-degradation path already specified, and it correctly covers every Indian and US/global equity by construction.

### A6.3.3c Lazy mapping — grow the universe toward real usage

When the watchlist contains an `instrument_id` with no `instrument_source_map` row **and** its asset class is a priced market (crypto/forex), the worker attempts a one-time resolution:

- Normalize the `instrument_name` (uppercase, strip separators `/ - space`, apply a small alias table for known synonyms: `XBT→BTC`, `BITCOIN→BTC`, etc.).
- Match the normalized form against the source's symbol list (already cached from seeding).
- On a confident match, create the `instrument_source_map` row so the chip works from the next poll onward.
- On no match, record a "no-map" marker (with a TTL so it's retried later, in case the symbol is added) and leave the chip hidden.

This makes the priced-instrument universe grow on demand toward exactly what users trade, instead of pre-loading thousands of symbols. The alias/normalization table is small and bounded (~a dozen well-known synonyms); it is the difference between lazy mapping resolving ~90% vs ~60% of attempts, so it is worth maintaining even though it is tiny.

### A6.3.4 Failure posture

Every failure mode degrades to "no chip, manual entry":
- Source API down or rate-limited → last good cached row ages out → becomes stale → chip hidden.
- Worker not run / cold cache → no row → chip hidden.
- Instrument not in watchlist → no row → chip hidden.

The feature can fail entirely and the trade form still works exactly as it does today.

---

## A6.4 Staleness Definition

- A row is **fresh** if `now - fetched_at ≤ 15 minutes` (configurable per source; crypto may use a tighter window, equities a looser one bounded by the source's own delay).
- A row is **stale** otherwise. Stale rows are retained (for debugging and as a last-known reference) but **never** surfaced as a chip.
- `is_stale` is derived at read time from `fetched_at`, not stored as mutable state, to avoid a second write path.

---

## A6.5 Copy

- Chip label: `Use ~{price} {quote}` — the `~` signals "approximate / starting point," reinforcing anchor-not-authority.
- Freshness label (Plan-a-Trade): `current · {age}` (e.g. "current · 3 min ago").
- Freshness label (Quick Log): `market now · {age}` — deliberately *not* "your price," to avoid implying the anchor equals the fill.
- No chip state: nothing renders (no "price unavailable" message — silence is the correct UX for an additive convenience).

---

## A6.6 Telemetry (to earn the stepper, or kill the feature)

The anchor flags (A6.2.2) drive the decision on whether to later build the per-digit stepper:

- **Tap rate:** % of eligible price fields where the chip was tapped. Low → the feature isn't valued; consider removing.
- **Post-tap edit distance:** how far the saved value ends up from the anchor after the user edits.
  - Consistently *small* edits → users are fine-tuning a close anchor → strong signal to invest in a tactile stepper (likely Plan-a-Trade first, where the anchor is closest).
  - Consistently *large* edits, or frequent clear-and-retype → the anchor is a poor starting point for that flow/market → do **not** build the stepper there.
- **By flow and asset class:** Plan-a-Trade is expected to show smaller edit distances than Quick Log; crypto vs forex may differ. Slice accordingly before any stepper investment.

---

## A6.7 New Schema

### `instrument_prices`

Latest-price cache. One logical "current" row per `(instrument_id, source)`; the worker upserts rather than appending unboundedly (or appends with a retention job — implementation choice, but the read path always takes the newest non-stale row).

```
instrument_prices
──────────────────────────────────────────────────────────────────
id                              UUID            PK, DEFAULT gen_random_uuid()
instrument_id                   UUID            NOT NULL, FK → instruments(id)
source                          VARCHAR(30)     NOT NULL   -- e.g. 'binance','forex_x','equity_x'
last_price                      NUMERIC(20,8)   NOT NULL
quote_currency                  VARCHAR(10)     NOT NULL   -- e.g. 'USD','USDT'
fetched_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
──────────────────────────────────────────────────────────────────
UNIQUE (instrument_id, source)          -- if upsert-in-place model
INDEX  (instrument_id, fetched_at DESC) -- read path: newest per instrument
```

### `instrument_source_map`

Translation layer between `instruments` and each price source (A6.3.3b). Only crypto/forex instruments have rows here; the absence of a row is what makes the chip not render for equities and custom instruments.

```
instrument_source_map
──────────────────────────────────────────────────────────────────
id                              UUID            PK, DEFAULT gen_random_uuid()
instrument_id                   UUID            NOT NULL, FK → instruments(id)
source                          VARCHAR(30)     NOT NULL   -- 'binance','forex_ecb'
source_symbol                   VARCHAR(40)     NOT NULL   -- 'BTCUSDT','EUR'
quote_currency                  VARCHAR(10)     NOT NULL   -- 'USDT','USD'
is_active                       BOOLEAN         NOT NULL, DEFAULT TRUE
mapped_via                      VARCHAR(10)     NOT NULL, DEFAULT 'seed' -- 'seed' | 'lazy'
created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
──────────────────────────────────────────────────────────────────
UNIQUE (source, source_symbol)
INDEX  (instrument_id)
```

> A lightweight "no-map" marker (lazy resolution that failed, with a retry TTL — A6.3.3c) can be a nullable `unmapped_retry_after TIMESTAMPTZ` column here or a tiny separate table; implementation choice.

### `instruments` — seeding columns (optional but recommended)

The existing `instruments` table already has `instrument_name`, `asset_class`, `is_popular`, `lot_size`, `exchange`. Seeding from broker/exchange masters (A6.3.3a) populates richer metadata that the F&O form fields and dedup logic benefit from. If not already present, consider adding:
- `trading_symbol`   VARCHAR(40)  NULLABLE  -- canonical exchange ticker (e.g. 'RELIANCE','BTCUSDT')
- `tick_size`        NUMERIC(20,8) NULLABLE
- `expiry_date`      DATE          NULLABLE  -- F&O contracts
- `strike_price`     NUMERIC(20,4) NULLABLE  -- F&O options
- `instrument_type`  VARCHAR(10)   NULLABLE  -- 'EQ','FUT','CE','PE'
- `seed_source`      VARCHAR(30)   NULLABLE  -- provenance: which master list seeded this row
- `last_seeded_at`   TIMESTAMPTZ   NULLABLE  -- for the slow refresh job

> These are reference-data fields with no live-price content, so they carry none of the quote-redistribution restriction.

> Decimal precision `NUMERIC(20,8)` covers both high-priced equities and small-tick forex/crypto. (Trade-record prices stay at `NUMERIC(20,4)` per existing schema; the cache uses wider scale because forex/crypto need more decimals than recorded fills.)

### Trade-record additions (telemetry flags)

On `trades`:
- `entry_price_from_anchor`  BOOLEAN  NOT NULL DEFAULT FALSE
- `exit_price_from_anchor`   BOOLEAN  NOT NULL DEFAULT FALSE

On `planned_trades`:
- `trigger_from_anchor`      BOOLEAN  NOT NULL DEFAULT FALSE
- `stop_from_anchor`         BOOLEAN  NOT NULL DEFAULT FALSE
- `target_from_anchor`       BOOLEAN  NOT NULL DEFAULT FALSE

---

## A6.8 Out of Scope (this addendum)

- Indian equity/F&O and US/global equities pricing of any kind → **FS-05** (no free redistribution-cleared source for either).
- Live / realtime (sub-15-min) pricing, WebSocket streams → not required by the freshness decision.
- Live unrealized P&L on open positions → not a V1 job for this data.
- The per-digit tactile stepper → parked behind A6.6 telemetry.
- Using cached prices for pattern detection or any computation that writes to the trade record beyond the user-confirmed price → the cache is presentation-only.
