# Flows — capture

How a trade gets into Retrospeq and becomes evidence: connect an account,
sync fills, group them into trades, close out the day, freeze the
evaluations. Everything in [Flows — insight](08-flows-insight.md) reads
what this side produces.

The freeze point in the third flow is the most important line in the
product. Read that section even if you skim the rest.

## Connect an account

```mermaid
sequenceDiagram
  participant U as Trader
  participant A as connectAccount
  participant B as lib/broker
  participant DB as Postgres
  U->>A: platform, server, login, investor password
  A->>A: strict Zod, rate limit, entitlement check
  A->>B: connectTradingAccount(adapter, input, keyProvider)
  B->>B: adapter.connect — auth plus read-only probe
  alt credential can place trades
    B-->>A: BrokerCredentialTooPermissiveError
    A-->>U: rejected, nothing stored, reason explained
  end
  B->>B: re-check verifiedReadonly, never trusted
  B->>B: envelope-encrypt with the KMS master key
  B->>DB: insert trading_accounts (user connection)
  B->>DB: insert account_credentials (service role)
  alt credential write fails
    B->>DB: delete the account row, no orphan
  end
```

**What matters here**

- The read-only probe happens inside `adapter.connect()`, and the result
  is re-checked afterwards. An adapter that forgot to throw still cannot
  get a writable credential stored.
- The database agrees: `account_credentials` carries
  `check (verified_readonly = true)`, so an unverified row is unstorable.
- Credentials are envelope-encrypted with an external KMS master key.
  None is configured today, so `KmsNotConfiguredError` propagates and the
  credentialed path fails loudly rather than falling back to something
  weaker. Manual accounts work end to end.
- The credential write uses the service role because
  `account_credentials` has no client write policy at all (ADR 0005).

## Sync — fills to trades

```mermaid
sequenceDiagram
  participant S as runSync
  participant AD as BrokerAdapter
  participant DB as Postgres
  S->>DB: load account and last sync window
  S->>AD: fetchHistory from lastWindowTo minus 6h overlap
  alt adapter throws
    S->>DB: write a classified failed sync_run
    S-->>S: return failed, never a partial claim
  end
  S->>DB: insert fills, on conflict do nothing
  Note over S,DB: unique account_id + provider_ref, a fill ingests once
  S->>S: detect coverage gaps
  loop each instrument with new fills
    S->>S: deriveBlocks, flat to flat
    S->>S: groupBlock, signals but never price proximity
    S->>S: computeTradeFacts
    S->>DB: upsert trades, trade_fills, trade_events
  end
  S->>S: match pending arm events, lock pre-entry captures
  S->>DB: insert sync_run, ok or partial
```

**Blocks, then trades.** A *block* is a run of fills from flat to flat on
one instrument. Inside a block, the grouping engine decides how many
distinct decisions it represents — one trade, or several. Grouping reads
timing, direction and size relationships; **price proximity is banned**.
That is a non-negotiable, not an oversight: two entries at a similar
price can be entirely unrelated decisions.

When it cannot tell, it says so — `grouping_confidence = 'ambiguous'`,
which blocks close-out until the trader resolves it. Guessing would
silently corrupt every number downstream.

**After the commit** a fan-out runs best-effort: operand distributions,
the edge engine, then decay checks, then detections, then the weekday
canary. Each is independently caught, so none can fail the sync. The
order matters in exactly one place — decay reads freshly written
findings, so it must follow the edge engine.

## Close out, freeze, adherence

This is the one-way door.

```mermaid
sequenceDiagram
  participant U as Trader
  participant A as confirmDayAction
  participant C as confirmDay
  participant DB as Postgres
  U->>A: Day done
  A->>A: session, rate limit, account ownership
  A->>C: confirmDay(accountId, serverDay)
  C->>DB: BEGIN, service role
  C->>C: refuse if an unresolved coverage gap overlaps the day
  C->>C: refuse if any trade is ambiguous
  C->>C: refuse if a block has fills no trade claims
  loop each eligible trade
    C->>DB: update where status closed and confirmed_at is null
    Note over C,DB: atomic check-and-set, rowCount 0 means another call won
    C->>DB: freeze rule_evaluations
    C->>DB: freeze trigger_evaluations
  end
  C->>DB: insert day_closeouts, on conflict do nothing
  C->>DB: COMMIT
  C->>C: post-commit best effort: adherence, unlock, engagement, day_closed
```

**Why freezing matters.** A rule evaluation records what was true *at the
moment the trade was confirmed*, against the rule version live at that
time. It is never recomputed. Edit a rule tomorrow and past adherence
does not move — which is the entire point. A number that changes
retroactively is not a record of behaviour.

Two database triggers enforce it (`forbid_update`, `forbid_delete`), so
even a direct SQL mistake cannot rewrite history. The only way past them
is erasure, which is why erasure has to delete explicitly — see
[Privacy](09-privacy.md).

**Three refusals before anything is written**, checked up front rather
than after a wasted submit: an unresolved coverage gap overlapping the
day, an ambiguous trade, or a block with fills no trade claims. Each
names what to fix.

**Point-in-time rule selection.** Only rule versions live when the trade
*opened* are evaluated — created before it, not yet superseded. A rule
written today does not retroactively judge last week.

**Anomalies never fabricate.** If a rule cannot be evaluated — a corrupt
expression, a field archived after authoring — it is logged loudly and
recorded as an anomaly, and **no row is written**. The trade still
confirms. A missing evaluation is honest; a guessed one is not.

## Where this is tested

- Grouping: golden-fixture replay plus property tests on the invariants.
  Anything touching grouping replays the fixtures.
- Close-out and freeze: `confirm.live.test.ts` and
  `freeze-evaluations.live.test.ts`, against a real database, including
  the concurrent-confirm race.
- Connect: `lib/broker/__tests__/`, with the too-permissive credential
  path asserted explicitly.
