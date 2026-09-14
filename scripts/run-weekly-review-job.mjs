#!/usr/bin/env node
// Module 06 §4.10 step 6 / Module 07 §5.6 — the "future cron calls this"
// entry point named by this slice's own dispatch note ("a thin script/
// route-handler-free entry the future cron can call"). It intentionally
// does NOT run the job.
//
// Why not: `lib/review/weekly-job.ts` is TypeScript, imports `server-only`
// guarded modules, and uses this repo's `@/...` path aliases (Next.js's
// own module resolution, not Node's). Every other script in this
// directory (`test-user.mjs`, `security-grep.mjs`, ...) is deliberately
// plain Node + `pg`/`fetch` for exactly this reason — none of them import
// from `lib/`. This repo has no `tsx`/`ts-node`/bundling step wired for
// scripts, and inventing one just for this stub would be exactly the
// kind of "pretend it works" shortcut AGENTS.md's "never fake it" rule
// forbids: a script that silently no-ops or hand-rolls a parallel
// implementation of the job logic would drift from the real one and
// nobody would notice until an email either didn't go out or went out
// twice.
//
// The REAL entry point once a scheduler exists is
// `runWeeklyReviewNotificationJobForAllUsers` (`lib/review/weekly-job.ts`)
// — a future scheduler slice should call it from wherever Next.js code
// can actually run (a Vercel Cron-triggered Route Handler, most likely,
// once a Vercel project exists — `docs/infra-gaps.md`), not from this
// plain-Node script. This file exists only so "the future cron can call
// this" has a real, discoverable, honestly-failing target today instead
// of nothing at all.
console.error(
  '[run-weekly-review-job] Not runnable yet: this repo has no scheduler ' +
    "(docs/infra-gaps.md: no Vercel project, no cron surface) and no TS/ESM " +
    'bundling step for plain-Node scripts to import lib/review/weekly-job.ts ' +
    "through. The real job is lib/review/weekly-job.ts's " +
    '`runWeeklyReviewNotificationJobForAllUsers` — call it from a real ' +
    "Next.js execution context (a future Vercel Cron Route Handler) once one " +
    'exists. This script deliberately refuses rather than faking a working ' +
    'cron target — see this file\'s own header comment.',
);
process.exit(1);
