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
 * parsers to return the raw text Postgres already sends over the wire
 * (`timestamp`/`timestamptz` come back as ISO-8601-shaped text by
 * default before node-postgres's own parsing step) — an identity
 * function, not a reformat. This makes runtime behavior finally match
 * what every `Row` interface in this codebase has always declared.
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

types.setTypeParser(TIMESTAMP_OID, (value: string) => value);
types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => value);
