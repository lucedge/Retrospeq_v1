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
  // declaration/doc comment, not a call. No real call site exists yet
  // (Module 01's current slices all use `withServiceRoleConnection`
  // instead — see ADR 0006 for why `lib/supabase/service.ts`'s
  // PostgREST-based client can't reach `retrospeq` tables today).
  'lib/supabase/service.ts',
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
