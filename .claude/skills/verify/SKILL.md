---
name: verify
description: Right-sized verification for a Retrospeq change — classify its risk tier, run that tier's deterministic checks, and know which review agents (if any) it needs. Use before committing any slice, or when asked "is this ready".
---

# verify

Every change gets exactly the checks its risk warrants — no more. Tier comes from the files touched (`npm run classify`, exit code = tier); the orchestrator can raise a tier by judgment, never lower it.

| Tier | Touches | `npm run verify` runs (scoped to touched dirs) | E2E | Agents |
|---|---|---|---|---|
| 0 | docs, ledger, `.claude/`, spec modules, config comments | `ledger-check` | none | none — commit |
| 1 | `.tsx` markup, CSS, copy, tests, e2e specs, brand assets | + tsc, eslint on changed files, unit tests **in touched dirs** | none (screenshot self-check only if a screen visibly changed) | none — commit |
| 2 | `lib/` or `app/` logic not in tier 3, scripts | + live-DB tests **in touched dirs** | `npm run e2e:changed` only if a route's *behaviour* changed | `retrospeq-tester`; `retrospeq-qa` only if a non-negotiable surface changed (home, review, close-out, rules UI, notifications, analytics↔rules) |
| 3 | migrations, `lib/supabase`, auth, broker/credentials, rule evaluator/catalogue, entitlements, rate-limit, privacy, any `actions.ts` | + `check:security` | `npm run e2e:changed` | `retrospeq-tester` → then `retrospeq-security-reviewer` **and** `retrospeq-qa` in parallel |
| phase end | — | `npm run check` + `check:live` + `check:security` | `npm run e2e:changed -- --all` | `/code-review`, `retrospeq-docs` |

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
- **Nothing runs the whole suite per change.** Unit/live tests are scoped to the touched directories; E2E runs only for changed routes with a spec, and only from tier 2; full suites (`check`, `check:live`, `--all`) are phase-end only.
- A gate FAIL goes back to `retrospeq-coder` with the finding verbatim; only the failed gate re-runs.
- Environmental failures (rate limit, shared-DB contention, known broken mailer) are reported as such with evidence, never as a change-caused FAIL and never silently ignored.
- Screenshots are looked at (`Read` the PNG), not just captured.
