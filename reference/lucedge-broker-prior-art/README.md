# LuceEdge broker/MT5/cTrader prior art — reference only

Copied from `E:\LuceEdge` (the separate LuceEdge app) on 2026-08-20,
because once the workspace switches to `retrospeq-app` as its own
window, that repo won't be reachable anymore. This is a one-time
snapshot, not a synced copy — it will not update if LuceEdge changes.

## What this is for

Retrospeq's own broker integration (Module 02, not started yet) has to
be built from scratch against the `BrokerAdapter` interface
(`retrospeq-design-system/modules/00-foundation.md` §10.1) — see
`PROGRESS.md`'s 2026-08-19 decision log entry. This folder exists so
that work has real prior art to learn from: LuceEdge already solved
some genuinely hard problems here (the MT5-under-Wine-in-Docker
investigation in particular took real effort — eight distinct issues,
documented in `docs/M2_MT5_Docker_Wine_Investigation.md`), and there's
no reason to rediscover them from zero.

## What NOT to do with this

**Do not copy-paste any of this code into Retrospeq's actual `app/` or
`lib/` directories.** None of it meets Retrospeq's security bar
(AGENTS.md → "Security bar"):

- `app-broker-code/` stores broker credentials behind a single static
  AES key (see the real code, not a paraphrase) — Retrospeq requires
  real envelope encryption with an external KMS master key.
- There is no vendor-agnostic adapter — cTrader (OAuth) and MT5 (this
  Python bridge) are separate, bespoke integrations. Retrospeq must
  never let a vendor-specific type leak past `BrokerAdapter`.
- There is no "attempt a benign trade operation, reject if it
  succeeds" mandatory read-only verification at connect time for MT5.
  This is a hard requirement for Retrospeq, not optional.

Use this folder to understand *problems already solved* (OAuth token
refresh quirks, MT5-under-Wine packaging, sync/backfill patterns), not
as a source to copy from.

## Contents

| Folder | What it is |
|---|---|
| `docs/` | The M2 broker integration spec and the full MT5-under-Docker/Wine investigation writeup |
| `docker-mt5-bridge/` | LuceEdge's production Dockerfile for running MT5 under Wine — the actual proven container setup |
| `scripts/mt5_bridge.py` | The Python bridge process that talks to MT5 and syncs trades |
| `app-broker-code/` | LuceEdge's Next.js UI + server actions for connecting cTrader/MT5 accounts — reference for the *user-facing flow*, not the security implementation |
| `supabase-sql/` | LuceEdge's actual broker-related table schema in the *same* Supabase project Retrospeq's dev/test environment shares (see `docs/adr/0002-shared-dev-supabase-project.md`) — useful to check before naming any new Retrospeq table, the same way the `data_requests` collision was caught |
