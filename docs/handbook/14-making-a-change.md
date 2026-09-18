# Making a change

The recipe, start to finish. It is short because most of the judgement
lives in the pages it links to.

## 1. Find where it belongs

[Module map](04-module-map.md) maps spec modules to directories. Changes
usually land in one `lib/` module plus its route. If your change spans
four modules, it is probably two changes.

## 2. Classify it

```bash
npm run classify
```

Prints a risk tier from the files you touched. The tier decides how much
review the change needs — it can be raised by judgement, never lowered.

| Tier | Typical change | What it needs |
|---|---|---|
| 0 | docs, ledger | self-check |
| 1 | markup, CSS, tests | self-check + `npm run verify` |
| 2 | logic in `lib/` | + a tester, + QA on a non-negotiable surface |
| 3 | schema, RLS, auth, credentials, rule engine, entitlements, rate limits, privacy, any `actions.ts` | + a blocking security review, QA in parallel |

## 3. Build it

Follow the contracts: the Server Action shape in
[Frontend](11-frontend.md), the connection helpers in
[Data access](05-data-access.md), and the concurrency pattern that
matches your problem in [Concurrency](10-concurrency.md).

Two habits that prevent most of the defects found here:

- **Never fabricate a number.** If the data is not there, say so. Every
  screen has a designed "not enough data yet" state; a zero standing in
  for unknown is a lie the interface tells confidently.
- **Re-check at the point of the write.** Ownership, entitlement and
  eligibility are all re-verified server-side at write time, however sure
  the caller seems.

## 4. Test it

[Testing](12-testing.md). Assert what the user gets, not how the code
gets there.

## 5. Document it

Documentation is part of the change, not a follow-up:

| You did this | Write this |
|---|---|
| Deviated deliberately from a convention | an ADR in `docs/adr/` |
| Added a condition someone might get paged about | a `docs/runbook.md` entry |
| Added a non-obvious constraint in a migration | an inline comment saying what it protects |
| Coined a term | an entry in [Glossary](15-glossary.md) |
| Added a table | the right ERD in [Data model](06-data-model.md), plus RLS, a policy, an isolation test, and an erasure delete if it is immutable |
| Added a `lib/` module or a route | a row in [Module map](04-module-map.md) |

## 6. Verify

```bash
npm run verify
```

Runs the checks for your tier, scoped to what you touched.

## 7. Commit

Explicit paths, never `git add -A` — a broad add sweeps in whatever else
is in the tree. The pre-commit hook enforces the ledger cap and lints
staged files.

## An example

Adding a field to the weekly review payload:

1. `lib/review/` — the payload assembler and its type. *(Module map)*
2. `npm run classify` → tier 2, logic in `lib/`.
3. The read is already inside a `Promise.all`; add to it rather than
   awaiting separately, and keep the honest branch for when the value is
   absent. *(Data access)*
4. Extend the payload unit test, and the live test if the value comes
   from a query. *(Testing)*
5. No ADR — nothing deviates. No runbook entry — nothing pages.
6. `npm run verify`.
7. `git add lib/review/... app/(app)/review/...` and commit.

## How this actually gets built

This repo is built by agents running the same recipe, with the tiers
deciding which review agents are dispatched. `docs/process.md` explains
that pipeline and `AGENTS.md` is its rulebook. Neither is required
reading to make a change by hand, but they explain why the ledger, the
tiers and the ADR discipline exist.
