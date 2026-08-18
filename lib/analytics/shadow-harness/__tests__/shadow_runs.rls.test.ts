import { describe, it } from 'vitest';

/**
 * 00-foundation §9.1: "RLS — every table asserted unreadable cross-user
 * — 100% of tables, automated, no exceptions." This is that test's slot
 * for `shadow_runs` — deliberately left `skip`, not deleted or faked
 * passing, because there is no live Supabase project for Retrospeq yet
 * (PROGRESS.md "Infra gaps"). AGENTS.md "never fake it": do not mark a
 * test "passing" if it only ran against a stand-in for something real.
 *
 * When a real Supabase project exists, wire this up as:
 *   1. Create two users (A, B) via the service role.
 *   2. Insert a shadow_runs row for A via the service role.
 *   3. As A's authenticated client: SELECT succeeds, sees the row.
 *   4. As B's authenticated client: SELECT returns zero rows for A's row.
 *   5. As B's authenticated client: attempt to UPDATE/DELETE A's row by id
 *      — must affect zero rows (RLS `using` clause, not just app logic).
 *   6. As an anonymous (unauthenticated) client: SELECT returns zero rows.
 */
describe.skip('shadow_runs RLS — requires a live Supabase project (not yet provisioned)', () => {
  it.todo('user A cannot select user B\'s shadow_runs rows');
  it.todo('user B cannot update or delete user A\'s shadow_runs rows');
  it.todo('an anonymous client cannot select any shadow_runs rows');
  it.todo('the service role can read and write across all users (bypasses RLS by design)');
});
