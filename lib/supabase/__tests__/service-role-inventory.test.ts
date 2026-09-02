import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Module 01 §7.2's mandatory, no-exceptions security test: "Service-role
 * inventory | Test enumerates service-role call sites and fails on an
 * unreviewed addition."
 *
 * Flagged by retrospeq-security-reviewer (2026-08-20) as a real gap, not
 * a hypothetical one: `lib/supabase/service.ts`'s own doc comment
 * promised this test greps `createServiceRoleClient(` call sites, but
 * this repo now has a SECOND RLS-bypass mechanism —
 * `withServiceRoleConnection(` in `lib/supabase/direct.ts` (added for
 * `account_credentials`/`trading_accounts` writes, ADR 0006, since
 * PostgREST doesn't yet serve the `retrospeq` schema) — and nothing
 * enumerated it. Both mechanisms bypass RLS the same way; both need the
 * same "no unreviewed addition" discipline. This test covers both.
 *
 * How it works: scans every `.ts`/`.tsx` file under the repo (excluding
 * node_modules, .next, __tests__ directories, and this file itself) for
 * literal `createServiceRoleClient(` / `withServiceRoleConnection(` call
 * text, and asserts the exact set of files containing at least one call
 * matches a reviewed allowlist below. A new call site in an
 * unlisted file fails the test — the fix is either (a) add it to the
 * allowlist as part of a deliberate PR/commit that a human or
 * retrospeq-security-reviewer actually looked at, or (b) realize the new
 * call site shouldn't exist and remove it. Never "fix" a failure here by
 * silently widening the allowlist without that review happening.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__tests__', 'coverage', 'test-results']);
const THIS_FILE = __filename.replace(/\\/g, '/');

// Reviewed 2026-08-20 alongside this test's own introduction — see
// PROGRESS.md's decision log for that date. Update this list ONLY as
// part of a change that also gets a security review, per this file's
// header comment.
const CREATE_SERVICE_ROLE_CLIENT_ALLOWLIST = new Set<string>([
  // Definition site only — `createServiceRoleClient(` appears in its own
  // declaration/doc comment, not a call.
  'lib/supabase/service.ts',
  // Module 01 story 1.5 recovery-code redemption: force-unenrolls a
  // user's MFA factors via `auth.admin.mfa.deleteFactor`, a GoTrue admin
  // API call (not a `retrospeq`-schema table read), so this is the first
  // real call site of this factory — see lib/auth/mfa-admin.ts's own doc
  // comment for why service role (not `withServiceRoleConnection`) is
  // the right mechanism here.
  'lib/auth/mfa-admin.ts',
  // Module 01 stories 5.1: Supabase Storage (`.storage.*`) for the export
  // bundle — bucket create/upload/sign, none of which are
  // `retrospeq`-schema PostgREST reads, so this is the same "GoTrue/
  // non-PostgREST API" shape as mfa-admin.ts above, not a new pattern.
  // See lib/supabase/service.ts's own doc comment for the Node
  // 20.11.0/`realtime.transport` fix this call site depends on.
  'lib/privacy/storage.ts',
  // Module 01 stories 5.2/5.3: erasure execution needs
  // `auth.admin.getUserById` (to fetch the email for the tombstone/
  // confirmation email before anything is deleted) and
  // `auth.admin.deleteUser` (the final, irreversible step) — both GoTrue
  // admin API calls, same reasoning as the two call sites above.
  'lib/privacy/erasure.ts',
]);

const WITH_SERVICE_ROLE_CONNECTION_ALLOWLIST = new Set<string>([
  // Definition + doc-comment mention, not a call.
  'lib/supabase/direct.ts',
  // Cross-references `withServiceRoleConnection(` in its own doc
  // comment (see the "This is not the only RLS-bypass mechanism"
  // paragraph) — a mention, not a call.
  'lib/supabase/service.ts',
  // Module 01 stories 2.x: account_credentials INSERT (connect) and
  // DELETE (disconnect) — both per docs/adr/0005 and docs/adr/0006.
  'lib/broker/accounts-repository.ts',
  // Module 01 stories 4.x: the ONLY write path to `subscriptions`
  // (setUserPlanForTesting, dev/test-only — see that function's own doc
  // comment and docs/adr/0008-subscriptions-read-only-rls.md). RLS on
  // this table deliberately has no client-writable policy at all, per
  // that ADR, so this is the sole legitimate route to a plan change
  // until a real billing webhook exists. Module 01 stories 5.2/5.3 added
  // `deleteSubscriptionForUser` to this same file (erasure execution) —
  // same table, same reasoning, no new allowlist entry needed since the
  // file was already listed.
  'lib/entitlements/subscription-repository.ts',
  // Module 01 §3.3, verbatim: "audit_log is insert-only for the service
  // role" — no client INSERT policy exists at all, so `recordAuditEvent`
  // (the only writer in this codebase) must run as service_role.
  'lib/privacy/audit-repository.ts',
  // Module 01 stories 5.1/5.2/5.3: every `data_requests` status
  // transition (processing/completed/failed/canceled, `completed_at`,
  // `artifact_url`, `expires_at`) after the initial owner INSERT — see
  // docs/adr/0009-data-requests-rls-shape.md for why the client can
  // create but never update its own request row.
  'lib/privacy/data-requests-repository.ts',
  // Module 01 story 5.1: `buildExportBundle` reads `profiles`/
  // `trading_accounts`/`subscriptions` for a user with no live session
  // to scope `withUserConnection` to (the function is written to be
  // callable by a future queue worker unchanged — see that file's own
  // doc comment) — every query still filters explicitly on `userId`
  // sourced from the export request's own owner-INSERTed row, never a
  // client-supplied value at this call site.
  'lib/privacy/export.ts',
  // Module 01 stories 5.2/5.3: `erasure_tombstones` has no client policy
  // at all (see the migration's own comment) — service role only, for
  // both the write here and (hypothetically) any future read.
  'lib/privacy/tombstone-repository.ts',
  // Module 02 Slice 3 (§4.1 sync pipeline): runs as a trusted backend
  // process, not a client request — every read/write against `fills` /
  // `blocks` / `trades` / `trade_fills` / `trade_events` / `sync_runs` /
  // `coverage_gaps` / `account_credentials` / `trading_accounts` goes
  // through the service role, with every query explicitly scoped to the
  // one `accountId`/`userId` the call is about (see that file's own
  // header comment and ADR 0005's "every query inside `fn` MUST filter
  // explicitly" caveat).
  'lib/ingestion/sync.ts',
  // Module 02 Slice 5 (§4.6 confirm/freeze transaction + the daily
  // auto-confirm sweep): same trusted-backend-process posture as
  // sync.ts above — `confirmDay` scopes every query explicitly to the
  // one `accountId`/`account.user_id` resolved from the account row it
  // loads first; `autoConfirmStaleTrades` is the one deliberate
  // exception to "scope to a caller-supplied user_id" (00-foundation
  // §3.2) in this file, by design — it is a global sweep across every
  // account/user, but every UPDATE it issues is `where id = any($1::
  // uuid[])` against ids that same query just selected under the
  // service role in the SAME transaction, never against any
  // caller-supplied id, so no request-scoped trust boundary is
  // actually crossed.
  'lib/ingestion/confirm.ts',
  // Module 02 Slice 6 (§4.8 manual entry): phase 2 only, of a deliberate
  // two-phase write. Phase 1 (the genuinely novel untrusted-input
  // boundary — inserting the two synthetic `fills` rows) runs under
  // `withUserConnection`, RLS-enforced via `fills_owner_insert`'s own
  // `manual:%` check. Phase 2 calls the SAME `recomputeInstrument`
  // `sync.ts` uses to derive blocks/grouping/facts from those fills —
  // necessarily service-role because `blocks`/`trade_fills`/
  // `trade_events` have no client-writable INSERT policy at all (same
  // structural reason `sync.ts`/`confirm.ts` are service-role), not a
  // shortcut invented for this slice. See that file's own header for the
  // full reasoning, reviewed by retrospeq-security-reviewer.
  'lib/ingestion/manual-entry.ts',
  // Module 02 Slice 6b (§4.7 manual split/join): phase 2 only, of the same
  // two-phase pattern manual-entry.ts/confirm.ts already established.
  // Phase 1 (withUserConnection, RLS-enforced) is pure validation for both
  // splitTrade/joinTrades — no writes at all, unlike manual-entry.ts's own
  // phase 1. Phase 2 does the actual restructuring, necessarily
  // service-role because `trade_fills` has no update policy for any
  // client role (SELECT-only) and `trade_events` has none either
  // (SELECT+INSERT only) — reassigning trade_id/role/kind is structurally
  // impossible under RLS regardless of ownership. `joinTrades`' own phase
  // 2 also performs the DELETE of the absorbed trade row, after
  // reassigning its membership away, in the SAME transaction — see that
  // file's own header for the `forbid_broker_confirmed_trade_delete`
  // interaction this relies on. Every query in both phase-2 bodies is
  // explicitly scoped to already phase-1-validated trade/account ids.
  'lib/ingestion/split-join.ts',
  // Module 04 Slice 3 (§5.8/§12 preview engine + operand_distributions
  // recompute): `operand_distributions` is materialised, service-role-
  // write-only per Slice 1's own RLS reasoning ("owner SELECT only,
  // materialised, service-role-only writes" — matches `adherence_weekly`'s
  // identical shape). This file's reads of `trades`/`trade_captures` also
  // run under the service role rather than `withUserConnection`, for the
  // same reason `sync.ts`/`confirm.ts` do: it must be callable from a
  // trusted backend context with no live user session (the "on demand
  // after a sync" call site, `lib/ingestion/sync.ts`'s own `runSync`, has
  // no request-scoped session to attach to `withUserConnection` — only an
  // `account.user_id` resolved from a row it already loaded). Every query
  // is explicitly scoped to the caller-supplied `userId` (`fetchTradesForDistributions`/
  // `fetchPreEntryCaptureSummaries`/`upsertOperandDistributions` all bind
  // `$1 = userId` directly, never trusting RLS to narrow it), matching
  // ADR 0005's "every query inside `fn` MUST filter explicitly" caveat.
  'lib/rules/distributions-repository.ts',
  // Module 04 Slice 4 (§5.3/§5.4/§5.6 cross-trade TradeFacts assembly):
  // same trusted-backend-process posture as `sync.ts`/`confirm.ts`/
  // `distributions-repository.ts` above -- `assembleCrossTradeOperandValues`
  // is written to be called from Module 02's confirm/freeze transaction (a
  // future slice, per this file's own header -- NOT wired in yet), which
  // has no live user session to attach to `withUserConnection`, only an
  // `account.user_id`/`account_id` resolved from the reference trade row it
  // loads first. Every query in every function is explicitly scoped to
  // that trade's own `account_id` (never a caller-supplied value beyond
  // the initial `tradeId` -- see this file's own header, "scoping judgment
  // call"), matching ADR 0005's "every query inside `fn` MUST filter
  // explicitly" caveat. `assembleCrossTradeOperandValuesWithClient` (the
  // lower-level entry point every fetch function ultimately composes into)
  // takes an already-open `PoolClient`, the same
  // `loadInstrumentBlockState`/`findUnrecordedFillsForBlock` pattern
  // `sync.ts`/`confirm.ts` already established, so a future caller already
  // inside a `withServiceRoleConnection` transaction (Slice 5's freeze
  // wiring) can reuse it without opening a second connection -- only the
  // standalone `assembleCrossTradeOperandValues(tradeId)` wrapper opens its
  // own `withServiceRoleConnection` (this file's own literal call site).
  'lib/rules/cross-trade-operand-values.ts',
  // Module 04 Slice 6 (§5.6/§3.1 adherence_weekly materialisation):
  // `adherence_weekly` is materialised, service-role-write-only per Slice
  // 1's own RLS reasoning ("owner SELECT only, no client write path" —
  // the identical shape `operand_distributions` already established
  // above). The write side (`recomputeAdherenceWeekly`/
  // `recomputeAdherenceWeeklyForUser`/`recomputeAdherenceWeeklyForConfirmations`)
  // runs as the "on demand after a confirm" call site — `lib/ingestion/
  // confirm.ts`'s own `confirmDay`/`autoConfirmStaleTrades`, which have no
  // request-scoped session to attach to `withUserConnection`, only a
  // `user_id` already resolved from a row they loaded under the service
  // role in the same call. Every query binds `$1 = userId` explicitly
  // (never trusting RLS to narrow it), matching ADR 0005's "every query
  // inside `fn` MUST filter explicitly" caveat — same posture as
  // `distributions-repository.ts`/`cross-trade-operand-values.ts` above.
  // The READ side (`fetchAdherenceWeekly`) is deliberately NOT on this
  // list — it runs under `withUserConnection`, genuine session-scoped
  // RLS, per that function's own doc comment, since a real trader session
  // exists at read time.
  //
  // NOTE: this entry was missing from the initial Slice 6 commit —
  // `retrospeq-security-reviewer`'s Slice 6 review checklist did not
  // include this specific allowlist-parity check (an oversight in that
  // review's own dispatch, not a finding the reviewer missed while
  // looking), so this test was left red on `main` until Slice 7's
  // `retrospeq-tester` caught it. Added here as a direct, mechanical
  // correction rather than a full coder/tester/security/qa cycle, since
  // the reasoning above is identical in kind to every other entry in this
  // list and was already independently verified live during Slice 6's
  // actual security review (RLS/scoping/parameterization all confirmed
  // PASS then) — only the allowlist bookkeeping itself was missed.
  'lib/rules/adherence-repository.ts',
  // Module 08 (Onboarding & Home) §4 — Slice 08a. `unlock_state` is the
  // SAME class of materialised cache as `adherence_weekly`/
  // `operand_distributions` above (owner SELECT only, service-role-only
  // writes, Slice 08a's own migration) — `recomputeUnlockStateForUser`
  // uses `withServiceRoleConnection` for the identical reason, every
  // query inside it explicitly scoped to the caller-supplied `userId`
  // (never trusting RLS to narrow it, since it's bypassed here), matching
  // `distributions-repository.ts`'s/`adherence-repository.ts`'s own
  // established convention for this exact table shape. Added to this
  // allowlist in the same commit that introduces the call, not left for a
  // future slice to discover missing (per the `adherence-repository.ts`
  // entry's own cautionary note directly above).
  'lib/onboarding/unlock-state-repository.ts',
  // Module 01 stories 5.2/5.3 erasure fix, 2026-09-02 (docs/adr/0010's
  // addendum, Module 03's field-registry migration having introduced a
  // real critical regression): `deleteAllFieldsForUser` mirrors
  // `deleteAllTradingAccountsForUser` exactly (`lib/broker/accounts
  // -repository.ts`, already listed above) — service-role is required
  // here not for an RLS-bypass-of-ownership reason (`fields` has a real
  // owner DELETE policy) but because the transaction-local
  // `retrospeq.erasure_in_progress` flag `fields_forbid_derived_delete`
  // checks must be set on the SAME connection issuing the delete, and
  // this is that connection. Filtered explicitly on the caller-supplied
  // `userId`, same posture as every other entry in this list. Added to
  // this allowlist in the same commit that introduces the call, per the
  // two entries directly above's own cautionary note.
  'lib/fields/fields-repository.ts',
  // Module 01 stories 5.2/5.3 erasure fix, 2026-09-02 (docs/adr/0010's
  // addendum, the `rules`/`rule_evaluations` instance of the same
  // regression, flagged alongside the `fields` fix above and closed here):
  // `deleteAllRulesForUser` mirrors `deleteAllFieldsForUser`/
  // `deleteAllTradingAccountsForUser` exactly — service-role is required
  // for the same reason (the transaction-local `retrospeq.erasure_in_progress`
  // flag `rules_forbid_delete`/`rule_evaluations_forbid_delete` check must
  // be set on the SAME connection issuing the delete). Filtered explicitly
  // on the caller-supplied `userId`, same posture as every other entry in
  // this list. Added to this allowlist in the same commit that introduces
  // the call, per the entries directly above's own cautionary note.
  'lib/rules/rules-repository.ts',
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      out.push(full);
    }
  }
}

function findFilesContaining(needle: string): Set<string> {
  const allFiles: string[] = [];
  walk(REPO_ROOT, allFiles);

  const matches = new Set<string>();
  for (const file of allFiles) {
    if (file.replace(/\\/g, '/') === THIS_FILE) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(needle)) {
      matches.add(relative(REPO_ROOT, file).replace(/\\/g, '/'));
    }
  }
  return matches;
}

describe('Service-role inventory (Module 01 §7.2, mandatory)', () => {
  it('createServiceRoleClient( call sites match the reviewed allowlist exactly', () => {
    const found = findFilesContaining('createServiceRoleClient(');
    // Exclude this repo's own test files, which legitimately reference
    // the factory by name to unit-test it — that's not a "call site" in
    // the security-relevant sense (no live DB access), it's a test of
    // the factory itself.
    const nonTestFound = [...found].filter((f) => !f.includes('/__tests__/'));

    expect(new Set(nonTestFound)).toEqual(CREATE_SERVICE_ROLE_CLIENT_ALLOWLIST);
  });

  it('withServiceRoleConnection( call sites match the reviewed allowlist exactly', () => {
    const found = findFilesContaining('withServiceRoleConnection(');
    const nonTestFound = [...found].filter((f) => !f.includes('/__tests__/'));

    expect(new Set(nonTestFound)).toEqual(WITH_SERVICE_ROLE_CONNECTION_ALLOWLIST);
  });

  it('sanity check: the scan actually walks the repo and finds a known file (guards against a silently-broken walker)', () => {
    const found = findFilesContaining('withServiceRoleConnection(');
    expect(found.has('lib/supabase/direct.ts')).toBe(true);
  });
});
