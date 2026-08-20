import 'server-only';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import type { EncryptedCredential } from './envelope-encryption';
import type { CredentialKind, Platform, TierFlags } from './adapter';
import { ACCOUNT_KINDS, type AccountKind } from './platform-defaults';

// Re-exported so existing server-side call sites can keep importing
// these from this file — `platform-defaults.ts` is the actual source of
// truth (see that file's own comment on why: client-bundle safety).
export { ACCOUNT_KINDS };
export type { AccountKind };

/**
 * Read/write access to `retrospeq.trading_accounts` /
 * `retrospeq.account_credentials` for Module 01 stories 2.x's connect
 * screen, account list, and disconnect flow. Everything here goes
 * through `lib/supabase/direct.ts` (docs/adr/0006), never
 * `lib/supabase/server.ts`/`service.ts` — see that ADR for why.
 *
 * Kept as its own module (not inlined into `app/(app)/accounts/actions.ts`)
 * so the SQL has one home, and so tests can mock this repository instead
 * of a live Postgres connection — see `app/(app)/accounts/__tests__/actions.test.ts`.
 */

export interface TradingAccountRow {
  id: string;
  label: string;
  platform: string;
  account_kind: string;
  provider_ref: string | null;
  server: string | null;
  base_currency: string;
  day_rollover: string;
  sync_tier: string;
  status: string;
  status_detail: string | null;
  last_sync_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  created_at: string;
}

const TRADING_ACCOUNT_COLUMNS = `
  id, label, platform, account_kind, provider_ref, server, base_currency,
  day_rollover, sync_tier, status, status_detail, last_sync_at,
  connected_at, disconnected_at, created_at
`;

/** Story 2.6: "Multiple accounts per user; each independently synced and
 *  labelled" — newest first, so a just-connected account is the first
 *  card the trader sees. */
export async function listTradingAccounts(userId: string): Promise<TradingAccountRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradingAccountRow>(
      `select ${TRADING_ACCOUNT_COLUMNS}
         from retrospeq.trading_accounts
        where user_id = $1
        order by created_at desc`,
      [userId],
    );
    return res.rows;
  });
}

export interface InsertTradingAccountInput {
  userId: string;
  label: string;
  platform: Platform;
  providerRef: string | null;
  server: string | null;
  baseCurrency: string;
  dayRollover: string;
  capabilities: TierFlags | Record<string, unknown>;
}

/** Thrown when the (user_id, platform, provider_ref) unique constraint
 *  fires — story 2.6's "each independently" implies distinct broker-side
 *  accounts, not the same one connected twice. */
export class DuplicateAccountError extends Error {
  constructor() {
    super('This account is already connected.');
    this.name = 'DuplicateAccountError';
  }
}

/**
 * Module 01 §4.1 steps 7-8: create the `trading_accounts` row,
 * `status = 'connected'`. Runs under `withUserConnection` — RLS's own
 * owner policy is a real, enforced backstop here (not just an
 * application-layer filter), unlike `account_credentials` below.
 */
export async function insertTradingAccount(
  input: InsertTradingAccountInput,
): Promise<{ id: string }> {
  try {
    return await withUserConnection(input.userId, async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into retrospeq.trading_accounts
           (user_id, label, platform, provider_ref, server, base_currency,
            day_rollover, sync_tier, capabilities, status, connected_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'connected', now())
         returning id`,
        [
          input.userId,
          input.label,
          input.platform,
          input.providerRef,
          input.server,
          input.baseCurrency,
          input.dayRollover,
          (input.capabilities as TierFlags).tier ?? 't0',
          JSON.stringify(input.capabilities),
        ],
      );
      return res.rows[0];
    });
  } catch (err) {
    // Postgres unique_violation — see `trading_accounts_user_id_platform_provider_ref_key`
    // in supabase/migrations/20260820040000_trading_accounts.sql.
    if (isUniqueViolation(err)) throw new DuplicateAccountError();
    throw err;
  }
}

/** Compensating delete for an `insertTradingAccount` whose paired
 *  `insertAccountCredential` failed — see `app/(app)/accounts/actions.ts`'s
 *  `connectAccount` doc comment for why this, and not a single
 *  cross-role transaction, is the chosen orphan-handling strategy. */
export async function deleteTradingAccount(userId: string, accountId: string): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query('delete from retrospeq.trading_accounts where id = $1 and user_id = $2', [
      accountId,
      userId,
    ]);
  });
}

export interface InsertAccountCredentialInput {
  accountId: string;
  userId: string;
  credentialKind: CredentialKind;
  encrypted: EncryptedCredential;
}

/**
 * Module 01 §4.1 step 6's storage half, per ADR 0005 (and ADR 0006 for
 * *how* the service-role bypass is reached). Deliberately no
 * `RETURNING` — see ADR 0005's own note that `RETURNING` requires the
 * same row-visibility check a SELECT policy would, and none exists for
 * this table on purpose. `verified_readonly` is always `true`: a
 * `ConnectSuccess` from `lib/broker/connect.ts` cannot exist otherwise
 * (its own type says so), and the table's own check constraint
 * (`account_credentials_must_be_verified_readonly`) would reject
 * anything else as a second backstop.
 */
export async function insertAccountCredential(
  input: InsertAccountCredentialInput,
): Promise<void> {
  await withServiceRoleConnection(async (client: PoolClient) => {
    await client.query(
      `insert into retrospeq.account_credentials
         (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [
        input.accountId,
        input.userId,
        input.encrypted.ciphertext,
        input.encrypted.wrappedDek,
        input.encrypted.iv,
        input.encrypted.authTag,
        input.encrypted.kmsKeyId,
        input.credentialKind,
      ],
    );
  });
}

/**
 * Module 01 story 2.5: "Credential destroyed immediately; imported trade
 * history retained." Only ever call this after confirming, from the
 * caller's own authenticated session, that `accountId` belongs to
 * `userId` (see `disconnectAccount` in app/(app)/accounts/actions.ts) —
 * this function itself cannot check that (RLS is bypassed here by
 * design, per ADR 0005) so it takes `userId` only to keep the same
 * "never accept an unscoped service-role write" shape as every other
 * call in this file, even though the query below is intentionally
 * `account_id`-only (a credential row has no independent existence once
 * ownership of its parent account has already been verified upstream).
 */
export async function deleteAccountCredential(accountId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query('delete from retrospeq.account_credentials where account_id = $1', [
      accountId,
    ]);
  });
}

/** Application-layer ownership check ADR 0005 requires before the
 *  service-role credential delete — via `trading_accounts`, which *does*
 *  have working RLS-scoped reads (unlike `account_credentials`). */
export async function isAccountOwnedByUser(userId: string, accountId: string): Promise<boolean> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query('select 1 from retrospeq.trading_accounts where id = $1', [
      accountId,
    ]);
    return (res.rowCount ?? 0) > 0;
  });
}

/** Module 01 §4.5: disconnect keeps status/history, only credential + status change. */
export async function markAccountDisconnected(userId: string, accountId: string): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query(
      `update retrospeq.trading_accounts
          set status = 'disconnected', disconnected_at = now()
        where id = $1 and user_id = $2`,
      [accountId, userId],
    );
  });
}

// ---------------------------------------------------------------------
// Module 01 §2 stories 3.1-3.4 — "Account settings" (rename, rollover,
// prop-challenge label). Editing the same three columns story 2.x's
// connect flow defaults (`lib/broker/platform-defaults.ts`), not new
// schema — see supabase/migrations/20260820040000_trading_accounts.sql's
// column comments for the source of truth on each column's shape.
// ---------------------------------------------------------------------

/**
 * `day_rollover`'s real, existing shape in this repo — there are two
 * literal formats already in live use (not invented for this slice),
 * confirmed by grepping `fixtures/golden/*\/input.json`,
 * `lib/broker/platform-defaults.ts`, and the live-DB RLS tests before
 * writing this regex:
 *   1. `'<IANA zone> HH:MM'` — e.g. `'America/New_York 17:00'`,
 *      `'UTC 00:00'` (forex/broker-class default, story 3.1).
 *   2. `'HH:MM:SS UTC'` — e.g. `'00:00:00 UTC'`, `'22:00:00 UTC'`
 *      (crypto default and every golden fixture's crypto account,
 *      story 3.2's literal "00:00 UTC" spelled with seconds throughout
 *      the fixture library — matched here, not "corrected" to a third
 *      shape this slice would be inventing on its own).
 * Validating against both, rather than picking one, is what "don't
 * invent a new format" means in practice here: either shape already
 * exists in real data this app has to keep reading.
 */
const IANA_ZONE_TIME = /^[A-Za-z_]+(?:\/[A-Za-z_]+){0,2} (?:[01]\d|2[0-3]):[0-5]\d$/;
const UTC_SECONDS_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d UTC$/;

export const dayRolloverSchema = z
  .string()
  .refine((v) => IANA_ZONE_TIME.test(v) || UTC_SECONDS_TIME.test(v), {
    message: "Enter a rollover like 'America/New_York 17:00' or '00:00:00 UTC'.",
  });

/** Story 3.3: "Free-text label, 40 chars." `.trim()` before the length
 *  check so trailing whitespace can't be used to sneak past the cap. */
export const updateTradingAccountSettingsInputSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, 'Label is required.')
    .max(40, 'Label must be 40 characters or fewer.'),
  dayRollover: dayRolloverSchema,
  accountKind: z.enum(ACCOUNT_KINDS),
});
export type UpdateTradingAccountSettingsInput = z.infer<
  typeof updateTradingAccountSettingsInputSchema
>;

/** Read one account scoped to the caller — used by the settings screen
 *  to prefill current values and to distinguish "not found / not yours"
 *  from every other state before rendering a form. RLS-enforced the same
 *  way as `listTradingAccounts`. */
export async function getTradingAccount(
  userId: string,
  accountId: string,
): Promise<TradingAccountRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradingAccountRow>(
      `select ${TRADING_ACCOUNT_COLUMNS}
         from retrospeq.trading_accounts
        where id = $1 and user_id = $2`,
      [accountId, userId],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Stories 3.1-3.4: update `label`/`day_rollover`/`account_kind` for one
 * account. `where id = $4 and user_id = $5` scopes the write to the
 * caller even before RLS's own identical `trading_accounts_owner`
 * policy re-checks it — this table (unlike `account_credentials`) has a
 * real owner `SELECT` policy, so `returning` works here the same way it
 * does in `insertTradingAccount` (ADR 0005's `RETURNING` caveat is
 * specific to `account_credentials`'s no-select-policy shape, not this
 * table). Returns `null` if the row doesn't exist or isn't owned by
 * `userId` — the caller maps that to a "not found" response, same
 * pattern as `isAccountOwnedByUser` elsewhere in this file.
 */
export async function updateTradingAccountSettings(
  userId: string,
  accountId: string,
  input: UpdateTradingAccountSettingsInput,
): Promise<TradingAccountRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradingAccountRow>(
      `update retrospeq.trading_accounts
          set label = $1, day_rollover = $2, account_kind = $3
        where id = $4 and user_id = $5
        returning ${TRADING_ACCOUNT_COLUMNS}`,
      [input.label, input.dayRollover, input.accountKind, accountId, userId],
    );
    return res.rows[0] ?? null;
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------
// Module 01 stories 5.2/5.3 — erasure execution (lib/privacy/erasure.ts).
// §4.6 step 3a: "Destroy credentials first" — user-wide, not the
// single-`accountId` shape `deleteAccountCredential` above needs for a
// normal disconnect. Both go through `withServiceRoleConnection` per ADR
// 0005 (no client SELECT/UPDATE policy exists for `account_credentials`
// at all), filtered explicitly on `user_id` sourced from the caller's own
// authenticated session — never accept it from anywhere else
// (00-foundation §3.2).
// ---------------------------------------------------------------------

/** Erasure step 3a: destroys every credential this user owns, across all
 *  their accounts, in one statement — the FIRST thing erasure execution
 *  does, before any other owned row is touched. */
export async function deleteAllAccountCredentialsForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query('delete from retrospeq.account_credentials where user_id = $1', [userId]);
  });
}

/** Erasure step 3b (part of the explicit FK-safe delete list, see
 *  docs/adr/0010-erasure-explicit-delete-order.md) — deletes every
 *  trading account this user owns. Must run AFTER
 *  `deleteAllAccountCredentialsForUser`, not rely on
 *  `account_credentials(account_id) references trading_accounts(id) on
 *  delete cascade` to do it implicitly — the ADR explains why the
 *  explicit order matters even though the cascade would eventually reach
 *  the same end state. */
export async function deleteAllTradingAccountsForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
  });
}
