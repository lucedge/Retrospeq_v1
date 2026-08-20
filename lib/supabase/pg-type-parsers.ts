import { types } from 'pg';

/**
 * Real bug found and fixed via this slice's mandatory screenshot
 * self-check (2026-08-21), not a code read: `node-postgres`'s default
 * type parsers deserialize Postgres `timestamp`/`timestamptz` columns
 * into JS `Date` objects — but EVERY row-shape interface in this repo
 * (`TradingAccountRow`, `SubscriptionRow`, `DataRequestRow`, etc.) types
 * those same columns as `string`, matching how PostgREST/`supabase-js`
 * actually serialize them (ISO 8601 strings) — the shape this codebase
 * has always assumed, everywhere. This mismatch was silent and dormant
 * until `app/(app)/privacy/page.tsx` tried to render `data_requests
 * .expires_at` directly as JSX text: React throws "Objects are not
 * valid as a React child (found: [object Date])" the first time a
 * timestamptz value is actually non-null and rendered as text — exactly
 * what this screen (uniquely, so far) does for a value with no prior
 * "if truthy" render guard elsewhere in the codebase. Confirmed the same
 * latent risk exists in `app/(app)/accounts/page.tsx`'s `last_sync_at`
 * rendering too — dormant only because no account has ever had a
 * non-null `last_sync_at` yet (Module 02's sync worker doesn't exist).
 *
 * Fix, applied once, globally, rather than patched at each of the many
 * call sites that assume a string: override the two relevant OIDs'
 * parsers to return real ISO-8601 text instead of a `Date` object.
 *
 * **Correction (retrospeq-security-reviewer, 2026-08-21):** the first
 * version of this fix returned Postgres's raw wire text unchanged,
 * claiming it "matches how PostgREST/supabase-js actually serialize"
 * timestamps — that claim was wrong. Postgres's own default `DateStyle`
 * text output is space-separated with a bare (no-colon) UTC offset,
 * e.g. `'2026-08-21 12:00:00+00'`; PostgREST actually emits true
 * ISO-8601, T-separated with a colon in the offset, e.g.
 * `'2026-08-21T12:00:00+00:00'`. Left uncorrected, that gap would have
 * meant a `pg`-sourced timestamp (via `lib/supabase/direct.ts`) and a
 * PostgREST-sourced one (via `lib/supabase/server.ts`) could carry the
 * same instant in two different string shapes — fine for `Date`
 * parsing (both are valid inputs to `new Date(...)`), but a latent bug
 * waiting to happen for any future string-equality comparison, cache
 * key, or export/display path that assumes one canonical shape. Fixed
 * for real by normalizing to true ISO-8601 (below), not just
 * documenting the discrepancy — this now genuinely produces the same
 * text shape either data-access path would.
 *
 * `pg.types.setTypeParser` mutates a process-wide registry, not a
 * per-Pool/per-Client one — importing this module ANYWHERE ensures it
 * for every `pg` connection in the process (`lib/supabase/direct.ts`'s
 * pool, `lib/rate-limit/limiter.ts`'s pool, and any live-DB test's raw
 * `Client`), which is exactly the desired "everywhere, not per-call-site"
 * fix. Imported for its side effect only — no exports.
 */
const TIMESTAMP_OID = 1114; // timestamp without time zone
const TIMESTAMPTZ_OID = 1184; // timestamp with time zone

/**
 * `'2026-08-21 12:00:00.123+00'` -> `'2026-08-21T12:00:00.123+00:00'`.
 * Only reformats — never changes the represented instant (no timezone
 * math, no precision loss): swaps the date/time separator, and pads a
 * bare `+HH`/`-HH` offset (Postgres's default) to `+HH:MM`/`-HH:MM`
 * (true ISO-8601 / what PostgREST emits). A value with no offset at all
 * (plain `timestamp without time zone`) is returned with only the
 * separator swapped, since there's no offset to pad.
 */
function toIsoLikePostgrest(value: string): string {
  const withT = value.replace(' ', 'T');
  return withT.replace(/([+-]\d{2})$/, '$1:00');
}

types.setTypeParser(TIMESTAMP_OID, (value: string) => toIsoLikePostgrest(value));
types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => toIsoLikePostgrest(value));
