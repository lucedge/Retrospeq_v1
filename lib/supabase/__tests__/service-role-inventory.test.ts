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
