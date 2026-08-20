import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import type { EncryptedCredential } from './envelope-encryption';
import type { CredentialKind, Platform, TierFlags } from './adapter';

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

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
