---
name: verify
description: Right-sized verification for a Retrospeq change — classify its risk tier, run that tier's deterministic checks, and know which review agents (if any) it needs. Use before committing any slice, or when asked "is this ready".
---

# verify

Every change gets exactly the checks its risk warrants — no more. Tier comes from the files touched (`npm run classify`, exit code = tier); the orchestrator can raise a tier by judgment, never lower it.

| Tier | Touches | Deterministic (`npm run verify`) | Agents |
|---|---|---|---|
| 0 | docs, ledger, `.claude/`, spec modules, config comments | `ledger-check` | none — commit |
| 1 | `.tsx` markup, CSS, copy, tests, e2e specs, brand assets | + tsc, eslint, unit (non-live) | none — coder's own self-check + `npm run e2e:changed` |
| 2 | `lib/` or `app/` logic not in tier 3, scripts | + live-DB unit tests | `retrospeq-tester`; `retrospeq-qa` only if a non-negotiable surface changed (home, review, close-out, rules UI, notifications, analytics↔rules) |
| 3 | migrations, `lib/supabase`, auth, broker/credentials, rule evaluator/catalogue, entitlements, rate-limit, privacy, any `actions.ts` | + `check:security` | `retrospeq-tester` → then `retrospeq-security-reviewer` **and** `retrospeq-qa` in parallel |

Commands (all fast except live/E2E):

```bash
npm run classify            # tier + per-file reasons
npm run verify              # runs the tier's checks; `npm run verify -- 3` forces a tier
npm run check               # tier-1 bundle (tsc + eslint + unit non-live), ~45s
npm run check:live          # live-DB unit tests (needs .env.local)
npm run check:security      # RLS suites + service-role allowlist + import boundary + security-grep
npm run e2e:changed         # 1–3 spec files for the routes touched; `-- --all` for the suite
npm run test:user -- create <label> | delete <id> | cleanup
```

Rules of thumb:
- The **full** E2E suite is a phase-end thing, not a per-slice thing. Targeted specs per slice.
- A gate FAIL goes back to `retrospeq-coder` with the finding verbatim; only the failed gate re-runs.
- Environmental failures (rate limit, shared-DB contention, known broken mailer) are reported as such with evidence, never as a change-caused FAIL and never silently ignored.
- Screenshots are looked at (`Read` the PNG), not just captured.
