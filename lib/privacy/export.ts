import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { countUnusedRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { RECOVERY_CODE_COUNT } from '@/lib/auth/mfa-recovery-codes';
import {
  EXPORT_TABLE_REGISTRY,
  fetchOwnedRows,
  type OwnedRowsResult,
} from './export-tables';

/**
 * Module 01 story 5.1: "JSON + CSV bundle ... of all user-owned rows"
 * (00-foundation §5.4). Pure-ish bundle-assembly logic, deliberately
 * separated from `export-job.ts`'s I/O orchestration (Storage upload,
 * signed URL, `data_requests` status updates) per this slice's own
 * dispatch: "keep the actual 'assemble the bundle' logic as a separate,
 * callable function that a future queue worker could call unchanged"
 * once this can no longer run synchronously inside a Server Action
 * (§11's "< 5 min p95" budget).
 *
 * COMPLETENESS (2026-09-15 slice, closing the gap PROGRESS.md's own
 * cross-cutting follow-up named: "omits trades/rules"): `profile`,
 * `tradingAccounts`, `subscription`, and `mfa` are the original
 * hand-typed sections, kept exactly as-shaped for backward
 * compatibility. `tables` is new — every OTHER real `retrospeq` table
 * carrying a `user_id` column, driven by `export-tables.ts`'s own
 * `EXPORT_TABLE_REGISTRY`, keyed by table name, each with its rows and
 * a `truncated` flag (see `EXPORT_ROW_LIMIT`'s own header). Credential/
 * security material (`account_credentials`, `mfa_recovery_codes`) and a
 * handful of internal-analytics-engine-only tables are deliberately
 * excluded, each with a written reason — see `EXPORT_EXCLUDED_TABLES`.
 * `export-completeness.live.test.ts` enforces, against the real live
 * schema, that every user-owned table is accounted for one of these
 * three ways — never silently missed the way `trades`/`rules` were
 * before this slice.
 *
 * Runs under `withServiceRoleConnection` with an explicit `userId`
 * filter on every query (00-foundation §3.2) — this is what makes the
 * function callable by a future background worker with no live user
 * session, per the dispatch note above, not because the data itself
 * needs RLS bypassing (every table below has a working owner SELECT
 * policy `withUserConnection` could use instead).
 */

export interface ExportBundle {
  generatedAt: string;
  userId: string;
  profile: {
    displayName: string | null;
    locale: string;
    timezone: string;
    telemetryOptOut: boolean;
    onboardingStage: string;
    createdAt: string;
  } | null;
  tradingAccounts: Array<{
    id: string;
    label: string;
    platform: string;
    accountKind: string;
    baseCurrency: string;
    dayRollover: string;
    syncTier: string;
    status: string;
    connectedAt: string | null;
    disconnectedAt: string | null;
    createdAt: string;
  }>;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null;
  mfa: {
    recoveryCodesRemaining: number;
    recoveryCodesIssued: number;
  };
  /** Every `EXPORT_TABLE_REGISTRY` table, keyed by table name — see this
   *  file's own header and `export-tables.ts` for what's included/
   *  excluded and why. */
  tables: Record<string, OwnedRowsResult>;
}

export async function buildExportBundle(userId: string): Promise<ExportBundle> {
  const profile = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select display_name, locale, timezone, telemetry_opt_out, onboarding_stage, created_at
         from retrospeq.profiles
        where id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });

  const tradingAccounts = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select id, label, platform, account_kind, base_currency, day_rollover,
              sync_tier, status, connected_at, disconnected_at, created_at
         from retrospeq.trading_accounts
        where user_id = $1
        order by created_at asc`,
      [userId],
    );
    return res.rows;
  });

  const subscription = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select plan, status, current_period_end from retrospeq.subscriptions where user_id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });

  // `countUnusedRecoveryCodes` runs under `withUserConnection`, not
  // `withServiceRoleConnection` — safe here because `userId` is always
  // sourced from the export request's own `data_requests.user_id`
  // (itself written by that user's RLS-enforced INSERT), never a
  // client-supplied value at this call site.
  const recoveryCodesRemaining = await countUnusedRecoveryCodes(userId);

  // Every other user-owned table, generic-fetched per `export-tables.ts`'s
  // own registry — one `withServiceRoleConnection` call per table, same
  // explicit `userId` filter posture as every query above (never trusting
  // RLS to narrow it, since it's bypassed here per this file's own header).
  // Run concurrently (`getPool()`'s own `max: 3` bounds how many actually
  // run at once — extra requests simply queue, never exceed the pool) —
  // sequential awaits over 40+ tables would otherwise pay a full
  // round-trip latency per table, one at a time, for no correctness
  // reason (every fetch is independent, no shared transaction needed).
  const tableEntries = await Promise.all(
    EXPORT_TABLE_REGISTRY.map(async (spec) => {
      const result = await withServiceRoleConnection((client) => fetchOwnedRows(client, userId, spec));
      return [spec.table, result] as const;
    }),
  );
  const tables: Record<string, OwnedRowsResult> = Object.fromEntries(tableEntries);

  return {
    generatedAt: new Date().toISOString(),
    userId,
    profile: profile
      ? {
          displayName: profile.display_name,
          locale: profile.locale,
          timezone: profile.timezone,
          telemetryOptOut: profile.telemetry_opt_out,
          onboardingStage: profile.onboarding_stage,
          createdAt: profile.created_at,
        }
      : null,
    tradingAccounts: tradingAccounts.map((a) => ({
      id: a.id,
      label: a.label,
      platform: a.platform,
      accountKind: a.account_kind,
      baseCurrency: a.base_currency,
      dayRollover: a.day_rollover,
      syncTier: a.sync_tier,
      status: a.status,
      connectedAt: a.connected_at,
      disconnectedAt: a.disconnected_at,
      createdAt: a.created_at,
    })),
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
        }
      : null,
    mfa: {
      recoveryCodesRemaining,
      // Only ever 0 or RECOVERY_CODE_COUNT in this codebase today
      // (`replaceRecoveryCodes` always issues a full fresh batch) — not
      // itself queried, since `recoveryCodesRemaining > 0` already
      // implies a full batch exists.
      recoveryCodesIssued: recoveryCodesRemaining > 0 ? RECOVERY_CODE_COUNT : 0,
    },
    tables,
  };
}

/** Kept for backward compatibility and its own direct unit tests
 *  (`export.test.ts`) — the ORIGINAL, trading-accounts-only CSV export,
 *  from before Module 02 (`trades`/`fills`) or this registry
 *  (`export-tables.ts`) existed. **Not** what `export-job.ts` uploads as
 *  `export.csv` any more: that's `export-csv.ts`'s `buildFullExportCsv`,
 *  which covers every `EXPORT_TABLE_REGISTRY` table (trades, fills,
 *  rules/rule_versions/rule_evaluations, strategies/strategy_versions,
 *  fields, etc.) plus this same trading-accounts section, generated from
 *  the registry so it can't silently fall behind the JSON side again —
 *  see that file's own header for the full story (fixes the QA FAIL on
 *  589807c, which correctly found this function alone no longer matched
 *  the "JSON + CSV bundle ... trades, fills, rules, evaluations,
 *  strategies, fields" promise on `/privacy` and the export-ready email). */
export function tradingAccountsToCsv(bundle: ExportBundle): string {
  const headers = [
    'id',
    'label',
    'platform',
    'accountKind',
    'baseCurrency',
    'dayRollover',
    'syncTier',
    'status',
    'connectedAt',
    'disconnectedAt',
    'createdAt',
  ] as const;

  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  for (const account of bundle.tradingAccounts) {
    lines.push(headers.map((h) => escape(account[h])).join(','));
  }
  return lines.join('\n');
}
