import 'server-only';
import type { PoolClient } from 'pg';

/**
 * Module 01 story 5.1's completeness registry — "JSON + CSV bundle ...
 * of all user-owned rows" (00-foundation §5.4), and the module's own
 * E2E line: "export completeness against a fixture user" (§8). Every
 * `retrospeq`-schema table carrying a `user_id` column is either:
 *
 *  1. Listed in `EXPORT_TABLE_REGISTRY` below (generic-fetched into
 *     `ExportBundle.tables[<table>]` by `export.ts`), or
 *  2. Named in `EXPORT_LEGACY_TYPED_TABLES` — already covered by a
 *     hand-typed field on `ExportBundle` that predates this registry
 *     (`tradingAccounts`, `subscription`) and is kept exactly as-is for
 *     backward compatibility rather than duplicated into `tables` too, or
 *  3. Named in `EXPORT_EXCLUDED_TABLES`, with a written reason — never a
 *     silent omission (AGENTS.md "never fake it").
 *
 * `profiles` is a fourth, structural exception: its primary key IS the
 * user id (no `user_id` column of its own), so it can never appear in a
 * live `information_schema.columns` scan for `column_name = 'user_id'`
 * — it is handled by its own hand-typed `ExportBundle.profile` field,
 * unconditionally, and asserted separately by
 * `export-completeness.live.test.ts` rather than folded into this
 * registry's own bookkeeping.
 *
 * `lib/privacy/__tests__/export-completeness.live.test.ts` queries
 * `information_schema.columns` against the real, live shared dev
 * Supabase project and fails if any table falls outside all three of
 * (1)/(2)/(3) above — the exact "same bug class erasure hit twice"
 * mechanism `service-role-inventory.test.ts` already established for
 * `withServiceRoleConnection`/`createServiceRoleClient` call sites,
 * applied here to export coverage instead.
 */

/** Every table name below is a fixed literal from this file, never
 *  interpolated from any caller/user input — safe to inline into SQL
 *  text the same way `lib/supabase/direct.ts`'s `withRole` already
 *  documents for its own fixed `role` literal. */
export interface ExportTableSpec {
  readonly table: string;
  readonly columns: readonly string[];
  /** Columns whose Postgres type is bare `date` (no time-of-day/zone) —
   *  the ONLY column shape this repo's global `pg` type-parser override
   *  (`lib/supabase/pg-type-parsers.ts`) does NOT fix: `timestamp`/
   *  `timestamptz` columns already deserialize to correct ISO-8601
   *  strings process-wide, but bare `date` (OID 1082) still deserializes
   *  to a JS `Date` at local-timezone midnight — the exact `2026-01-01`
   *  -> `2025-12-31T18:30:00.000Z` shift confirmed live while building
   *  this registry. Cast to `::text` in the SELECT list instead, the
   *  same convention `reviews-repository.ts`/`adherence-repository.ts`
   *  already use for every date/timestamp column they read. */
  readonly plainDateColumns: readonly string[];
  /** ORDER BY columns (always `DESC NULLS LAST`), applied before
   *  `EXPORT_ROW_LIMIT` truncates — see that constant's own header for
   *  why every table is bounded. Chosen to be the table's own best
   *  "most recent activity" column where one exists; a handful of
   *  tables with no timestamp of their own (`trade_fills`, most of
   *  `prompt_history`) instead order by their (non-nullable) natural key
   *  columns — arbitrary but fully deterministic, which is all
   *  truncation-safety requires here (no chronological claim is made
   *  for those specific tables). */
  readonly orderBy: readonly string[];
  /** Columns holding genuinely free-form, user-TYPED text (checked
   *  against the real migration DDL, not guessed) — a strategy/field
   *  name, a trigger-condition sentence, a rendered rule sentence. This
   *  is `export-csv.ts`'s own CSV-formula-injection guard input
   *  (prefixes a leading `= + - @` / tab / CR with `'`); deliberately
   *  NOT applied to numeric-as-string columns (e.g. `r_multiple`,
   *  `risk_pct` — Postgres `numeric` comes back from `pg` as a JS
   *  string, and a legitimate negative value like `"-1.5000"` must
   *  never be mangled by a formula-injection guard meant for prose).
   *  Omitted (defaults to `[]`) for the majority of tables, which carry
   *  no free-text column of their own (enums, ids, numbers, jsonb —
   *  jsonb values are JSON-stringified by `export-csv.ts` and so are
   *  self-quoting: `JSON.stringify` of a string always starts with `"`,
   *  never `=`/`+`/`-`/`@`). */
  readonly freeTextColumns?: readonly string[];
}

export const EXPORT_TABLE_REGISTRY: readonly ExportTableSpec[] = [
  {
    table: 'adherence_weekly',
    columns: ['user_id', 'week_start', 'hard_followed', 'hard_total', 'soft_followed', 'soft_total', 'top_break_rule_id', 'top_break_count', 'computed_at'],
    plainDateColumns: ['week_start'],
    orderBy: ['computed_at'],
  },
  {
    table: 'arm_events',
    columns: ['id', 'user_id', 'account_id', 'instrument', 'direction', 'strategy_id', 'strategy_version', 'captures', 'trigger_state', 'armed_at', 'matched_trade_id', 'match_state', 'match_candidates', 'created_at'],
    plainDateColumns: [],
    orderBy: ['armed_at'],
  },
  {
    table: 'audit_log',
    columns: ['id', 'user_id', 'actor', 'action', 'target', 'metadata', 'ip_hash', 'created_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
  },
  {
    table: 'blocks',
    columns: ['id', 'user_id', 'account_id', 'instrument', 'opened_at', 'closed_at', 'server_day', 'created_at'],
    plainDateColumns: ['server_day'],
    orderBy: ['created_at'],
  },
  {
    table: 'coverage_gaps',
    columns: ['id', 'account_id', 'user_id', 'gap_from', 'gap_to', 'resolved_at'],
    plainDateColumns: [],
    orderBy: ['gap_from'],
  },
  {
    table: 'data_requests',
    columns: ['id', 'user_id', 'kind', 'status', 'requested_at', 'completed_at', 'artifact_url', 'expires_at'],
    plainDateColumns: [],
    orderBy: ['requested_at'],
  },
  {
    table: 'day_closeouts',
    columns: ['user_id', 'account_id', 'server_day', 'kind', 'confirmed_at', 'confirmed_by'],
    plainDateColumns: ['server_day'],
    orderBy: ['confirmed_at'],
  },
  {
    table: 'detections',
    columns: ['id', 'user_id', 'analytic_id', 'occurrences', 'window_from', 'window_to', 'distinct_days', 'base_rate', 'outcome_avg_r', 'outcome_baseline_avg_r', 'tier', 'classification', 'state', 'computed_at', 'rule_proposable', 'direction'],
    plainDateColumns: [],
    orderBy: ['computed_at'],
  },
  {
    table: 'engagement_events',
    columns: ['id', 'user_id', 'kind', 'verification_source', 'subject_type', 'subject_id', 'server_day', 'xp', 'occurred_at'],
    plainDateColumns: ['server_day'],
    orderBy: ['occurred_at'],
  },
  {
    table: 'engagement_state',
    columns: ['user_id', 'streak_weeks', 'longest_streak_weeks', 'current_week_start', 'current_week_complete', 'total_xp', 'grace_used_at', 'computed_at'],
    plainDateColumns: ['current_week_start'],
    orderBy: ['computed_at'],
  },
  {
    table: 'field_usages',
    columns: ['field_id', 'user_id', 'used_by', 'used_by_id', 'created_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
  },
  {
    table: 'fields',
    columns: ['id', 'user_id', 'name', 'kind', 'data_type', 'origin', 'owner_strategy_id', 'config', 'min_tier', 'state', 'created_at', 'archived_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
    freeTextColumns: ['name'], // user-typed field label (field_registry_schema.sql: `name text not null`)
  },
  {
    table: 'fills',
    columns: ['id', 'user_id', 'account_id', 'provider_ref', 'instrument', 'side', 'volume', 'price', 'filled_at', 'server_day', 'commission', 'swap', 'realized_pnl', 'currency', 'stop_at_fill', 'target_at_fill', 'provider_position_ref', 'provider_parent_ref', 'close_reason', 'raw', 'imported_at'],
    plainDateColumns: ['server_day'],
    orderBy: ['filled_at'],
  },
  {
    table: 'finding_rule_links',
    columns: ['finding_id', 'rule_id', 'user_id', 'delta_at_graduation', 'trades_at_graduation', 'last_checked_at', 'last_delta', 'consecutive_decay_checks', 'trades_at_last_check'],
    plainDateColumns: [],
    orderBy: ['last_checked_at', 'finding_id'],
  },
  {
    table: 'findings',
    columns: ['id', 'user_id', 'analytic_id', 'strategy_id', 'field_id', 'segment', 'n', 'win_rate', 'avg_r', 'baseline_n', 'baseline_win_rate', 'baseline_avg_r', 'delta_win_rate', 'delta_avg_r', 'p_value', 'p_adjusted', 'confidence', 'gate_failures', 'state', 'computed_at', 'superseded_by'],
    plainDateColumns: [],
    orderBy: ['computed_at'],
  },
  {
    table: 'milestones',
    columns: ['user_id', 'milestone_id', 'reached_at'],
    plainDateColumns: [],
    orderBy: ['reached_at'],
  },
  {
    table: 'onboarding_state',
    columns: ['user_id', 'stage', 'path', 'first_finding_id', 'first_finding_shown_at', 'rules_calibrated_at', 'fields_offered_at', 'fields_declined_count', 'updated_at'],
    plainDateColumns: [],
    orderBy: ['updated_at'],
  },
  {
    table: 'operand_distributions',
    columns: ['user_id', 'operand_id', 'buckets', 'n', 'computed_at'],
    plainDateColumns: [],
    orderBy: ['computed_at'],
  },
  {
    table: 'position_snapshots',
    columns: ['id', 'user_id', 'account_id', 'instrument', 'taken_at', 'volume', 'stop', 'target', 'unrealized'],
    plainDateColumns: [],
    orderBy: ['taken_at'],
  },
  {
    table: 'prompt_history',
    columns: ['user_id', 'subject_type', 'subject_id', 'kind', 'shown_count', 'decline_count', 'last_shown_at', 'muted', 'mute_reason', 'occurrences_at_last_decline'],
    plainDateColumns: [],
    orderBy: ['last_shown_at', 'subject_type', 'subject_id', 'kind'],
  },
  {
    table: 'review_notifications',
    columns: ['id', 'user_id', 'review_id', 'period_start', 'status', 'sent_at', 'error', 'created_at'],
    plainDateColumns: ['period_start'],
    orderBy: ['created_at'],
  },
  {
    table: 'review_prompts',
    columns: ['id', 'user_id', 'review_id', 'kind', 'rank', 'subject_type', 'subject_id', 'payload', 'state', 'decided_at', 'decline_count', 'created_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
  },
  {
    table: 'reviews',
    columns: ['id', 'user_id', 'period_kind', 'period_start', 'period_end', 'covers_weeks', 'read_payload', 'opened_at', 'completed_at', 'computed_at'],
    plainDateColumns: ['period_start', 'period_end'],
    orderBy: ['computed_at'],
  },
  {
    table: 'rule_evaluations',
    columns: ['id', 'user_id', 'trade_id', 'rule_id', 'rule_version', 'severity', 'result', 'reason', 'observed', 'server_day', 'frozen_at'],
    plainDateColumns: ['server_day'],
    orderBy: ['frozen_at'],
  },
  {
    table: 'rule_overrides',
    columns: ['id', 'user_id', 'trade_id', 'rule_id', 'rule_version', 'observed', 'occurred_at'],
    plainDateColumns: [],
    orderBy: ['occurred_at'],
  },
  {
    table: 'rule_versions',
    columns: ['rule_id', 'version', 'user_id', 'operand_id', 'op', 'value', 'rendered', 'created_at', 'superseded_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
    freeTextColumns: ['rendered'], // rendered sentence for display/audit (rulebook_schema.sql: `rendered text not null`)
  },
  {
    table: 'rules',
    columns: ['id', 'user_id', 'current_version', 'scope', 'scope_id', 'severity', 'origin', 'evaluation', 'state', 'source_ref', 'created_at', 'retired_at', 'promoted_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
  },
  {
    table: 'strategies',
    columns: ['id', 'user_id', 'name', 'current_version', 'is_default', 'state', 'created_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
    freeTextColumns: ['name'], // user-typed strategy name
  },
  {
    table: 'strategy_versions',
    columns: ['strategy_id', 'version', 'user_id', 'name', 'fields', 'triggers', 'created_at', 'superseded_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
    freeTextColumns: ['name'], // user-typed strategy name, snapshotted per version
  },
  {
    table: 'sync_runs',
    columns: ['id', 'account_id', 'user_id', 'tier', 'trigger', 'window_from', 'window_to', 'fills_seen', 'fills_new', 'status', 'error_code', 'started_at', 'finished_at'],
    plainDateColumns: [],
    orderBy: ['started_at'],
  },
  {
    table: 'trade_captures',
    columns: ['trade_id', 'user_id', 'field_id', 'value', 'moment', 'captured_late', 'edit_count', 'updated_at'],
    plainDateColumns: [],
    orderBy: ['updated_at'],
  },
  {
    table: 'trade_events',
    columns: ['id', 'user_id', 'trade_id', 'fill_id', 'kind', 'occurred_at', 'price', 'volume', 'volume_after', 'captures', 'created_at'],
    plainDateColumns: [],
    orderBy: ['occurred_at'],
  },
  {
    table: 'trade_fills',
    columns: ['trade_id', 'fill_id', 'user_id', 'role'],
    plainDateColumns: [],
    orderBy: ['trade_id', 'fill_id'],
  },
  {
    table: 'trades',
    columns: ['id', 'user_id', 'account_id', 'block_id', 'instrument', 'direction', 'opened_at', 'closed_at', 'server_day', 'status', 'entry_price_avg', 'exit_price_avg', 'peak_volume', 'initial_stop', 'risk_pct', 'initial_risk_pct', 'r_multiple', 'realized_pnl', 'currency', 'hold_seconds', 'outcome', 'strategy_id', 'strategy_version', 'grouping_confidence', 'grouping_signals', 'grouping_source', 'ambiguity_resolved_at', 'not_a_decision', 'confirmed_at', 'confirmed_by', 'created_at'],
    plainDateColumns: ['server_day'],
    orderBy: ['created_at'],
  },
  {
    table: 'trigger_conditions',
    columns: ['id', 'user_id', 'strategy_id', 'text', 'sort_order', 'state', 'created_at', 'retired_at'],
    plainDateColumns: [],
    orderBy: ['created_at'],
    freeTextColumns: ['text'], // user-typed trigger-condition sentence
  },
  {
    table: 'trigger_evaluations',
    columns: ['id', 'user_id', 'trade_id', 'condition_id', 'result', 'frozen_at'],
    plainDateColumns: [],
    orderBy: ['frozen_at'],
  },
  {
    table: 'unlock_state',
    columns: ['user_id', 'trades_confirmed', 'trades_with_captures', 'weeks_active', 'derived_findings_available', 'judgment_findings_available', 'graduation_available', 'computed_at'],
    plainDateColumns: [],
    orderBy: ['computed_at'],
  },
  {
    table: 'week_completeness',
    columns: ['user_id', 'week_start', 'days_traded', 'days_closed', 'complete', 'grace_applied', 'computed_at'],
    plainDateColumns: ['week_start'],
    orderBy: ['computed_at'],
  },
];

/**
 * Already covered by a hand-typed `ExportBundle` field that predates
 * this registry — kept exactly as-is (not duplicated into
 * `ExportBundle.tables`) for backward compatibility, per this slice's
 * own dispatch ("keep the existing bundle shape backward compatible").
 * Both DO have a real `user_id` column and would otherwise need to
 * appear in `EXPORT_TABLE_REGISTRY` — named here instead so the
 * completeness test can account for them without asserting they're
 * ALSO present under `tables`.
 */
export const EXPORT_LEGACY_TYPED_TABLES: ReadonlySet<string> = new Set([
  'trading_accounts',
  'subscriptions',
]);

/**
 * Every `retrospeq` table with a `user_id` column that is deliberately
 * NEVER exported, with a written reason — AGENTS.md "never fake it,
 * always flag it" applied to an omission instead of an invention.
 */
export const EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  account_credentials:
    'Credential/security material — envelope-encrypted broker credential blobs and KMS key ids ' +
    '(docs/adr/0006). Never readable even by this repo\'s own service-role application code path ' +
    'for any other purpose; exporting it would leak ciphertext + key-id metadata for no user benefit.',
  mfa_recovery_codes:
    'Security material — one-way-hashed recovery codes (`code_hash`), never retrievable even before ' +
    'erasure. `ExportBundle.mfa` already reports the honest, non-reversible fact a trader actually ' +
    'needs (how many codes remain unused), sourced from `countUnusedRecoveryCodes`, not this table\'s raw rows.',
  analytic_renders:
    'Internal analytics audit trail ("makes \'was this ever wrong?\' answerable" — Module 05 §3.1\'s own ' +
    'DDL comment) — records every render for the analytics ENGINE\'s own correctness auditing, not ' +
    'user-facing content of its own. The findings it recorded ARE exported, in full, via `findings`.',
  analytic_user_suppression:
    'Internal analytics-engine bookkeeping — a detection\'s decline-count/cooldown state (Module 05 story ' +
    '2.3: "declined once -> dormant ... declined twice -> permanently muted"), not user-facing content. ' +
    'The user-visible outcome of that state (which detections stopped being offered) is not itself a ' +
    'distinct fact separate from the detections/findings already exported.',
  shadow_runs:
    'Shadow-mode analytics output — Module 05 §4.9\'s own header, verbatim: "Shadow mode output. Never ' +
    'rendered." An internal research harness comparing candidate analytics against real data for THIS ' +
    'PROJECT\'s own evaluation purposes; never shown to the trader in any surface, and not a fact about ' +
    'their trading distinct from what `findings`/`detections` already export.',
  user_cohorts:
    'Internal experiment/beta-cohort assignment bookkeeping (`analytic_config.cohort_only` gating input) ' +
    '— which internal test bucket an account is in, not the trader\'s own trading or decision data.',
};

/** Per-table row bound applied to every `EXPORT_TABLE_REGISTRY` fetch.
 *
 * 00-foundation §11's "< 5 min p95" budget (this function still runs
 * synchronously inside a Server Action, no queue infra exists yet — see
 * `export-job.ts`'s own header) is trivially met at this project's
 * current real data volume (no live sync pipeline has produced anything
 * close to this many rows for any one user/table yet). This bound exists
 * so a future high-volume account (or a heavy table like `fills`/
 * `trade_events`) cannot make a single export request hold an unbounded
 * result set in memory — 00-foundation §8's own "partition `fills` ...
 * once it passes ~10M rows" scaling note is the same class of concern,
 * applied here to one request's memory footprint rather than storage.
 * `ExportBundle.tables[<table>].truncated` is set `true` (never silently
 * dropped) whenever a table actually hits this bound, so the bundle is
 * honest about incompleteness rather than looking complete when it
 * isn't — the true fix (chunked/paginated export) is the same future
 * queue-worker rework `export-job.ts`'s own header already flags as
 * needed once Module 02's real trade volume exists at scale.
 */
export const EXPORT_ROW_LIMIT = 50_000;

export interface OwnedRowsResult {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

/** Fetches every row of `spec.table` owned by `userId`, bounded by
 *  `EXPORT_ROW_LIMIT`, with every `date`-typed column cast to `::text`
 *  (see `ExportTableSpec.plainDateColumns`'s own header). All column/
 *  table names interpolated here come from `EXPORT_TABLE_REGISTRY`
 *  above, a fixed literal array in this file — never from `userId` or
 *  any other caller/request input. */
export async function fetchOwnedRows(
  client: PoolClient,
  userId: string,
  spec: ExportTableSpec,
): Promise<OwnedRowsResult> {
  const selectList = spec.columns
    .map((column) => (spec.plainDateColumns.includes(column) ? `${column}::text as ${column}` : column))
    .join(', ');
  const orderClause = spec.orderBy.map((column) => `${column} desc nulls last`).join(', ');

  const res = await client.query(
    `select ${selectList}
       from retrospeq.${spec.table}
      where user_id = $1
      order by ${orderClause}
      limit $2`,
    [userId, EXPORT_ROW_LIMIT + 1],
  );

  const truncated = res.rows.length > EXPORT_ROW_LIMIT;
  return { rows: truncated ? res.rows.slice(0, EXPORT_ROW_LIMIT) : res.rows, truncated };
}
