import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import type {
  AccountHandle,
  BrokerAdapter,
  BrokerCredentialInput,
  CredentialKind,
  Fill,
  Platform,
} from '@/lib/broker/adapter';
import {
  BrokerAuthFailedError,
  BrokerCredentialTooPermissiveError,
  BrokerServerUnknownError,
  BrokerVendorUnavailableError,
} from '@/lib/broker/adapter';
import {
  createKmsMasterKeyProvider,
  decryptCredential,
  KmsNotConfiguredError,
  type MasterKeyProvider,
} from '@/lib/broker/envelope-encryption';
import { deriveBlocks, type BlockDerivationFill, type DerivedBlock, type FillBlockAssignment } from './blocks';
import { groupBlock, type GroupingInputFill } from './grouping';
import { computeTradeFacts, type TradeFactsMember } from './trade-facts';
import { computeServerDay } from './server-day';
import { matchArmEvent, type ArmDirection, type CandidateEntryFill } from './arm-matching';
import { lockPreEntryCaptures } from './trade-captures';

/**
 * Module 02 (Trade Ingestion & Model) §4.1 — the sync pipeline's
 * DB-writing orchestration layer. This is the first slice in Module 02
 * that actually persists `fills`/`blocks`/`trades`/`trade_fills`/
 * `trade_events`/`sync_runs`/`coverage_gaps` rows — everything before this
 * (`blocks.ts`, `grouping.ts`, `trade-facts.ts`) is a pure function over
 * already-materialised data. `runSync` is the glue: one account, one
 * sync attempt, orchestrating §4.1's 11 numbered steps against a real
 * `BrokerAdapter` and the live `retrospeq` schema.
 *
 * Runs as a trusted backend process (a future cron/API-route/UI trigger
 * surface — NOT built in this slice, see the `trigger` param's own doc
 * comment), not a client request — every DB access here goes through
 * `withServiceRoleConnection` (RLS bypassed), and every query is
 * explicitly scoped to the one `accountId`/`userId` this call is about,
 * per ADR 0005's own caveat ("every query inside `fn` MUST filter
 * explicitly on `user_id`/`account_id`") and this slice's own dispatch.
 *
 * ## Judgment calls made reconciling §4.1's prose into executable code
 * (00-foundation §12; flagged for PROGRESS.md's decision log)
 *
 * 1. **Overlap window duration.** §4.1 step 2 says "always overlap the
 *    previous window; dedup makes it free" but names no duration.
 *    `DEFAULT_OVERLAP_MS` below is 6 hours — comfortably inside the
 *    dispatch's own suggested 1-24h range, erring toward more overlap
 *    (safe, per the same "dedup makes it free" reasoning) without being
 *    so large that a daily-cadence sync re-fetches the entire prior day
 *    every time. Overridable via `RunSyncOptions.overlapMs`.
 * 2. **`since` when no prior sync run exists.** Not specified at all by
 *    §4.1 (it only describes the steady-state "last_covered_to - overlap"
 *    case). Read as `trading_accounts.connected_at` (falling back to
 *    `created_at` if somehow null) — the account's OWN "we've been
 *    watching this since" boundary, with no overlap subtraction applied
 *    (there is no prior window to overlap against). This is distinct from
 *    story 1.1's "full available history pulled on connect" — this
 *    function does not itself decide how far back a real adapter's
 *    `fetchHistory` actually reaches; it only decides what `since` value
 *    to REQUEST.
 * 3. **Coverage-gap comparison (step 5, "between window_from and the
 *    earliest returned fill").** Implemented as: if `fills.length === 0`,
 *    NO gap is recorded — a broker genuinely returning zero fills for the
 *    requested window is indistinguishable from "the trader didn't trade"
 *    (honest, expected, per 00-foundation §6.2's silence principle and
 *    story 4.5's "a no-trade day counts") and is NOT this pipeline's job
 *    to second-guess. When at least one fill IS returned, ANY positive gap
 *    (`earliest.filled_at > windowFrom`, no tolerance) is recorded — the
 *    conservative reading, since a real coverage gap silently missed would
 *    corrupt a day's close-out (§9: "block close-out for affected days").
 *    **Also skipped entirely on an account's very FIRST sync ever** (no
 *    prior `sync_runs` row) — a genuine correctness fix found while
 *    testing this file, not just a convenience: `windowFrom` on a first
 *    sync is `trading_accounts.connected_at`, which routinely predates a
 *    brand-new account's first real trade by hours or days. Without this
 *    exclusion, EVERY first sync of EVERY account would falsely report a
 *    gap the moment it found its first fill — a false positive on the
 *    *common* case, not the rare one. There is no established prior
 *    continuity to violate until at least one real sync has completed.
 *    **Flagged as a genuine ambiguity, not a confident reading, for the
 *    steady-state (non-first-sync) case**: the spec's one-line description
 *    doesn't say whether a small, routine gap (e.g. a few seconds of clock
 *    skew between "the window we asked for" and "the first fill that
 *    happens to exist") should also count. This implementation treats ANY
 *    positive gap as reportable — favouring over-flagging (a false-positive
 *    `coverage_gaps` row, reviewable and harmless) over under-flagging (a
 *    missed real gap, which is corrupting) — but a future slice may want a
 *    small tolerance once real broker behaviour is observed.
 * 4. **Block/trade recompute scope (steps 6-9) — the single biggest
 *    scope decision in this file.** §4.1 says "recompute blocks for
 *    touched (account, instrument) spans" and "run grouping for each
 *    unconfirmed block." Taken completely literally, this implies
 *    re-deriving and potentially REWRITING an already-open, unconfirmed
 *    block/trade that gains new fills across a resync boundary (e.g. a
 *    still-building scaled position, synced twice while still open).
 *    Building that safely — matching new fills onto existing trade rows,
 *    or splitting/merging trades in place — is a genuinely large,
 *    separate feature (it has to reconcile with `trades`'s own delete
 *    trigger, which makes any broker-backed trade row permanently
 *    non-deletable regardless of confirmation status, so "recompute" can
 *    never mean "delete and re-derive from scratch" the way the pure
 *    `groupBlock`/`deriveBlocks` functions do in isolation). **This
 *    slice's actual, implemented scope:** an (account, instrument) span
 *    that already has ANY matching `blocks` row (matched by exact
 *    `opened_at` instant) is left COMPLETELY UNTOUCHED — no write of any
 *    kind — regardless of whether it contains a confirmed trade. Only
 *    genuinely BRAND-NEW blocks (no existing row at all) are derived,
 *    grouped, and written. This trivially and unambiguously satisfies the
 *    mandatory "never touch a confirmed trade" invariant (it's not even a
 *    special case — nothing pre-existing is ever touched), at the cost of
 *    not implementing "append new fills to an already-open unconfirmed
 *    block" in THIS slice — deferred, flagged for the decision log, not
 *    silently dropped. When a matched existing block's freshly-recomputed
 *    fill membership includes fills not yet reflected in its stored
 *    trade(s) (a real, detectable condition — computed cheaply from data
 *    already fetched), that's surfaced as a named entry in the returned
 *    `anomalies` array and a `console.warn`, distinguishing
 *    `FILL_LATE_ARRIVAL` (the block has a confirmed trade — §9's own
 *    named error code) from `BLOCK_EXTENSION_DEFERRED` (unconfirmed, just
 *    out of this slice's scope) — never a silent rewrite either way.
 * 5. **`trading_accounts.starting_equity` may be `null`.** See
 *    `docs/adr/0013-trading-accounts-starting-equity-nullable.md` — every
 *    real synced account has this `null` until a future slice sources a
 *    real value, so every trade this pipeline writes today has
 *    `risk_pct`/`initial_risk_pct`/`r_multiple` all `null`. Not a bug.
 *
 * ## Step 8, arm-event matching (§4.5) — implemented this slice
 *
 * `matchPendingArmEvents` (below) runs once per `writeSyncOutcome` call,
 * inside the same transaction as everything else, at the point §4.1's
 * numbered list places it (after blocks/trades are recomputed, before the
 * `sync_runs` row is written). **Judgment call, recorded per
 * 00-foundation §12:** rather than tracking "new entry fills written THIS
 * run" as a separate, narrower set, this function re-evaluates EVERY
 * `arm_events` row for the account still `match_state = 'pending'`
 * against the account's FULL current entry-fill history for that arm's
 * own instrument, every sync. This deliberately conflates §4.1 step 8
 * ("attempt arm-event matching for new entry fills") with the
 * `never_filled` sweep the dispatch left as an open design choice ("a
 * sync-triggered sweep is reasonable for this slice's scope") into ONE
 * pass: cheap (bounded by the account's own pending-arm count, via the
 * `arm_pending` partial index), trivially idempotent (re-evaluating an
 * already-resolved `pending` arm a second time with the same fills
 * produces the same `pending` result, a no-op write), and correct for
 * both original goals — a fill that arrived on a PRIOR sync but was never
 * matched (e.g. the arm was created after that sync already ran) is
 * still found, not just fills that are brand-new this run. See
 * `lib/ingestion/arm-matching.ts`'s own header for the pure decision
 * logic and its judgment calls #1-#5.
 *
 * ## Explicitly deferred (per this slice's own dispatch, not silently
 * dropped)
 *
 * - **Step 10, emitting events to Module 04/Module 07.** Neither module
 *   exists in this repo yet. Also worth noting: per §4.6, the REAL
 *   evaluation-freeze event fires at CONFIRM time, not sync time — the
 *   eventual hook for Module 04 belongs in the (not-yet-built)
 *   confirm/freeze transaction, not here.
 * - **The `trigger` surface itself.** This file only accepts and records
 *   whichever of `'scheduled' | 'on_demand' | 'connect'` a caller passes
 *   (`sync_runs.trigger`'s own vocabulary) — building the actual
 *   cron job / API route / UI button that decides which value to pass and
 *   calls `runSync` is NOT this slice's job.
 */

// ---------------------------------------------------------------------
// Options / result shapes
// ---------------------------------------------------------------------

export type SyncTrigger = 'scheduled' | 'on_demand' | 'connect';
export type SyncStatus = 'ok' | 'partial' | 'failed';

export const DEFAULT_OVERLAP_MS = 6 * 60 * 60 * 1000; // 6h -- see header judgment call #1.

export interface RunSyncOptions {
  trigger: SyncTrigger;
  /** Envelope-encryption master key access, for decrypting the stored
   *  credential of a non-manual account. Defaults to a lazy wrapper around
   *  `createKmsMasterKeyProvider()` (throws `KmsNotConfiguredError` until
   *  a real external KMS exists — see PROGRESS.md "Infra gaps") if not
   *  supplied. Tests inject a fake provider (same pattern as
   *  `lib/broker/__tests__/test-master-key-provider.ts`) to exercise the
   *  real pipeline without a real KMS. Never used at all for a `manual`
   *  account — see the manual short-circuit below. */
  masterKeyProvider?: MasterKeyProvider;
  /** See header judgment call #1. */
  overlapMs?: number;
  /** Testability hook — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface RunSyncSkippedResult {
  skipped: true;
  /** Manual accounts (`platform = 'manual'`) have no credential and no
   *  broker to sync from — Module 02 §4.8's manual-entry flow writes
   *  synthetic fills directly via its own (separate, not-yet-built)
   *  Server Action, never through this pipeline. `runSync` is total: it
   *  never throws for a manual account, it returns this instead, so a
   *  caller looping over every connected account never needs a special
   *  case to avoid crashing on one. */
  reason: 'manual_account';
}

export type SyncErrorCode =
  | 'SYNC_CREDENTIAL_REJECTED' // §9: broker refused the stored credential (auth/server-unknown/too-permissive)
  | 'SYNC_VENDOR_UNAVAILABLE' // §9: adapter/vendor unreachable
  | 'SYNC_KMS_NOT_CONFIGURED' // extension of §9's taxonomy, mirrors connect.ts's CONNECT_KMS_NOT_CONFIGURED -- no real KMS exists yet
  | 'SYNC_NO_CREDENTIAL' // extension of §9's taxonomy -- a non-manual account with no account_credentials row is a data-integrity anomaly, not a normal broker rejection
  | 'SYNC_INTERNAL'; // 00-foundation §6.1's `internal` category -- unrecognised failure

export interface RunSyncResult {
  skipped: false;
  /** `null` only when `status === 'failed'` before any `sync_runs` row
   *  could legitimately record a real window (never — a failed run still
   *  gets a `sync_runs` row per §4.1 step 11, `status = 'failed'`). */
  syncRunId: string;
  status: SyncStatus;
  fillsSeen: number;
  fillsNew: number;
  windowFrom: string;
  windowTo: string;
  errorCode: SyncErrorCode | null;
  coverageGapWritten: boolean;
  blocksCreated: number;
  tradesCreated: number;
  /** Always 0 in this slice — see header judgment call #4. Kept as a
   *  named field (not just omitted) so a future slice that implements
   *  in-place block extension has an obvious place to report it, and so
   *  this result shape doesn't need a breaking change later. */
  tradesUpdated: number;
  /** Human-readable notes for conditions that were detected but
   *  deliberately NOT acted on — see header judgment call #4. Empty array
   *  means none detected, never a sign that detection didn't run. */
  anomalies: string[];
  /** §4.5 arm-event matching outcome counts for this sync run — see the
   *  "Step 8" header section above. Zero across the board when the
   *  account has no `pending` `arm_events` rows at all (not yet built:
   *  the "arm a setup" UI, Module 03/08 territory — this repo has no way
   *  to create one today, so these are 0 in every real sync until that
   *  ships). */
  armEventsMatched: number;
  armEventsAmbiguous: number;
  armEventsNeverFilled: number;
}

export type RunSyncOutcome = RunSyncResult | RunSyncSkippedResult;

/** Thrown internally, mapped to `SYNC_NO_CREDENTIAL` — never escapes `runSync`. */
class SyncNoCredentialError extends Error {
  constructor(accountId: string) {
    super(`runSync: account ${accountId} is not manual but has no account_credentials row.`);
    this.name = 'SyncNoCredentialError';
  }
}

// ---------------------------------------------------------------------
// Pure helpers -- exported for direct unit testing, no DB/adapter I/O.
// ---------------------------------------------------------------------

/** Header judgment calls #1-#2. */
export function computeSyncWindowFrom(
  lastWindowTo: Date | null,
  accountBaseline: Date,
  overlapMs: number,
): Date {
  if (lastWindowTo === null) {
    // First-ever sync for this account -- no prior window to overlap.
    return accountBaseline;
  }
  return new Date(lastWindowTo.getTime() - overlapMs);
}

/** Header judgment call #3. `null` return means "no gap to record." */
export function detectCoverageGap(
  windowFrom: Date,
  earliestFilledAt: Date | null,
): { gapFrom: Date; gapTo: Date } | null {
  if (earliestFilledAt === null) return null;
  if (earliestFilledAt.getTime() > windowFrom.getTime()) {
    return { gapFrom: windowFrom, gapTo: earliestFilledAt };
  }
  return null;
}

/**
 * Module 02 §13: "`raw` ... must be scrubbed of any credential material at
 * write." Real adapter payloads are not expected to carry credentials,
 * but this is a defence-in-depth, never-trust-the-vendor-payload scrub,
 * matching 00-foundation §4.1's "redaction filter at the logging boundary
 * keyed on the credential table's column names" posture applied here to
 * the `fills.raw` write boundary instead. Drops the key entirely (never a
 * redacted placeholder that could be mistaken for a real, safe value).
 */
const CREDENTIAL_LIKE_KEY_FRAGMENTS = ['password', 'secret', 'apikey', 'api_key', 'token', 'credential'];

export function scrubRawPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (CREDENTIAL_LIKE_KEY_FRAGMENTS.some((frag) => lower.includes(frag))) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

/** Maps every adapter/decrypt failure this pipeline recognises to a
 *  `SyncErrorCode`. Never re-throws an adapter's raw message to the
 *  caller as the code -- matches Module 01 §9's "no vendor error string
 *  ever reaches the user" posture, applied here to sync's own error
 *  surface. */
export function classifySyncError(err: unknown): SyncErrorCode {
  if (err instanceof BrokerAuthFailedError) return 'SYNC_CREDENTIAL_REJECTED';
  if (err instanceof BrokerCredentialTooPermissiveError) return 'SYNC_CREDENTIAL_REJECTED';
  if (err instanceof BrokerServerUnknownError) return 'SYNC_CREDENTIAL_REJECTED';
  if (err instanceof BrokerVendorUnavailableError) return 'SYNC_VENDOR_UNAVAILABLE';
  if (err instanceof KmsNotConfiguredError) return 'SYNC_KMS_NOT_CONFIGURED';
  if (err instanceof SyncNoCredentialError) return 'SYNC_NO_CREDENTIAL';
  return 'SYNC_INTERNAL';
}

/**
 * `sync_runs.tier` is constrained to `t0 | t1` (Module 02 §3.1's literal
 * DDL), but `trading_accounts.sync_tier` (Module 01 §3.1) allows `t2`
 * too. Clamping `t2 -> t1` here is a real, narrow inconsistency between
 * the two tables' own spec text -- reported as the LOWER tier is always
 * safe (under-declaring capability, never over-declaring it), never a
 * silent data-loss risk. No fixture or adapter in this repo produces
 * `t2` today, so this is a defensive clamp for a case that hasn't been
 * observed, not a speculative feature.
 */
export function normalizeSyncRunTier(accountSyncTier: string): 't0' | 't1' {
  return accountSyncTier === 't1' || accountSyncTier === 't2' ? 't1' : 't0';
}

function sameInstant(a: string, b: string): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

// ---------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  provider_ref: string | null;
  server: string | null;
  base_currency: string;
  day_rollover: string;
  sync_tier: string;
  starting_equity: string | null;
  connected_at: string | null;
  created_at: string;
}

interface CredentialRow {
  ciphertext: Buffer;
  wrapped_dek: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  kms_key_id: string;
  credential_kind: string;
}

export interface FillDbRow {
  id: string;
  provider_ref: string;
  side: 'buy' | 'sell';
  volume: string;
  price: string;
  filled_at: string;
  stop_at_fill: string | null;
  provider_position_ref: string | null;
  provider_parent_ref: string | null;
  realized_pnl: string | null;
}

// ---------------------------------------------------------------------
// Small, independently-scoped reads (each its own short transaction --
// see header: every query here filters explicitly on the one accountId
// this call is about).
// ---------------------------------------------------------------------

async function loadAccount(accountId: string): Promise<AccountRow | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<AccountRow>(
      `select id, user_id, platform, provider_ref, server, base_currency, day_rollover,
              sync_tier, starting_equity, connected_at, created_at
         from retrospeq.trading_accounts
        where id = $1`,
      [accountId],
    );
    return res.rows[0] ?? null;
  });
}

async function loadLastWindowTo(accountId: string): Promise<Date | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ window_to: string }>(
      `select window_to
         from retrospeq.sync_runs
        where account_id = $1 and status in ('ok', 'partial')
        order by window_to desc
        limit 1`,
      [accountId],
    );
    return res.rows[0] ? new Date(res.rows[0].window_to) : null;
  });
}

async function loadCredential(accountId: string): Promise<CredentialRow | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<CredentialRow>(
      `select ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind
         from retrospeq.account_credentials
        where account_id = $1`,
      [accountId],
    );
    return res.rows[0] ?? null;
  });
}

function lazyKmsMasterKeyProvider(): MasterKeyProvider {
  // Same lazy-evaluation reasoning as app/(app)/accounts/actions.ts's
  // `lazyKmsMasterKeyProvider` -- defers the real (always-throwing, no
  // KMS yet) call until a decrypt is actually attempted, so a caller that
  // never reaches this path (a manual account, or one that fails earlier)
  // never sees a spurious KMS error.
  return {
    wrapDataKey: (dataKey) => createKmsMasterKeyProvider().wrapDataKey(dataKey),
    unwrapDataKey: (wrappedDek, kmsKeyId) => createKmsMasterKeyProvider().unwrapDataKey(wrappedDek, kmsKeyId),
  };
}

async function buildCredentialInput(
  account: AccountRow,
  masterKeyProvider: MasterKeyProvider,
): Promise<BrokerCredentialInput> {
  const credRow = await loadCredential(account.id);
  if (!credRow) {
    throw new SyncNoCredentialError(account.id);
  }
  // Decryption happens only here, inside the sync worker, only for the
  // duration of this call, never in a request path serving a user
  // (00-foundation §4.1's storage principle) -- `plaintext` never leaves
  // this function's stack; it's consumed immediately by `adapter.connect`
  // below and never logged, never persisted, never included in any
  // returned result.
  const plaintext = await decryptCredential(
    {
      ciphertext: credRow.ciphertext,
      wrappedDek: credRow.wrapped_dek,
      iv: credRow.iv,
      authTag: credRow.auth_tag,
      kmsKeyId: credRow.kms_key_id,
    },
    masterKeyProvider,
  );
  return {
    platform: account.platform as Platform,
    server: account.server ?? undefined,
    login: account.provider_ref ?? undefined,
    credential: plaintext,
    credentialKind: credRow.credential_kind as CredentialKind,
  };
}

async function writeFailedSyncRun(
  account: AccountRow,
  trigger: SyncTrigger,
  windowFrom: Date,
  windowTo: Date,
  errorCode: SyncErrorCode,
): Promise<string> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string }>(
      `insert into retrospeq.sync_runs
         (account_id, user_id, tier, trigger, window_from, window_to, fills_seen, fills_new, status, error_code, finished_at)
       values ($1, $2, $3, $4, $5, $6, 0, 0, 'failed', $7, now())
       returning id`,
      [
        account.id,
        account.user_id,
        normalizeSyncRunTier(account.sync_tier),
        trigger,
        windowFrom.toISOString(),
        windowTo.toISOString(),
        errorCode,
      ],
    );
    return res.rows[0].id;
  });
}

// ---------------------------------------------------------------------
// The write phase -- fills insert, coverage-gap detection, block/trade
// recompute, sync_runs row. One transaction (withServiceRoleConnection
// wraps begin/commit -- see lib/supabase/direct.ts), matching §4.1 step
// 3's "stage fills in a transaction."
// ---------------------------------------------------------------------

async function writeSyncOutcome(
  account: AccountRow,
  trigger: SyncTrigger,
  windowFrom: Date,
  windowTo: Date,
  fills: Fill[],
  isFirstSync: boolean,
): Promise<RunSyncResult> {
  return withServiceRoleConnection(async (client) => {
    const fillsSeen = fills.length;

    const insertedRows: { id: string; instrument: string }[] = [];
    for (const f of fills) {
      const serverDay = computeServerDay(f.filled_at, account.day_rollover);
      const scrubbedRaw = scrubRawPayload(f.raw ?? {});
      const res = await client.query<{ id: string; instrument: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day,
            commission, swap, realized_pnl, currency, stop_at_fill, target_at_fill,
            provider_position_ref, provider_parent_ref, close_reason, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (account_id, provider_ref) do nothing
         returning id, instrument`,
        [
          account.user_id,
          account.id,
          f.provider_ref,
          f.instrument,
          f.side,
          f.volume,
          f.price,
          f.filled_at,
          serverDay,
          f.commission,
          f.swap,
          f.realized_pnl,
          f.currency,
          f.stop_at_fill,
          f.target_at_fill,
          f.provider_position_ref,
          f.provider_parent_ref,
          f.close_reason,
          JSON.stringify(scrubbedRaw),
        ],
      );
      if (res.rows[0]) insertedRows.push(res.rows[0]);
    }
    const fillsNew = insertedRows.length;

    // §4.1 step 5 -- header judgment call #3. Skipped entirely on the
    // FIRST sync for this account (`isFirstSync`): there is no
    // established continuity to violate yet -- a brand-new account's
    // first trade legitimately arriving long after `connected_at` is
    // completely normal (nothing to sync before the trader's first real
    // trade), not evidence of a broker returning incomplete data. Without
    // this exclusion, `windowFrom = connected_at` would make EVERY first
    // sync of EVERY account falsely report a "gap" the moment it found
    // its first real fill, incorrectly blocking that day's close-out
    // (§9) on a real account's very first day of activity -- a
    // false-positive on the common case, not the rare one, so this
    // exclusion is a correctness fix to the judgment call, not a
    // convenience.
    let coverageGapWritten = false;
    if (fills.length > 0 && !isFirstSync) {
      const earliest = fills.reduce((min, f) =>
        new Date(f.filled_at).getTime() < new Date(min.filled_at).getTime() ? f : min,
      );
      const gap = detectCoverageGap(windowFrom, new Date(earliest.filled_at));
      if (gap) {
        await client.query(
          `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
           values ($1, $2, $3, $4)`,
          [account.id, account.user_id, gap.gapFrom.toISOString(), gap.gapTo.toISOString()],
        );
        coverageGapWritten = true;
      }
    }

    // §4.1 steps 6-9 -- header judgment call #4. Only instruments that
    // actually received a NEW fill this run are touched, matching §7.2's
    // "re-running sync over an overlapping window changes nothing" -- if
    // every fill this run already existed, there is nothing to recompute.
    const touchedInstruments = [...new Set(insertedRows.map((r) => r.instrument))];
    let blocksCreated = 0;
    let tradesCreated = 0;
    const anomalies: string[] = [];

    for (const instrument of touchedInstruments) {
      const result = await recomputeInstrument(client, account, instrument);
      blocksCreated += result.blocksCreated;
      tradesCreated += result.tradesCreated;
      anomalies.push(...result.anomalies);
    }

    // Step 8 (§4.5 arm-event matching) -- see this file's header section
    // "Step 8, arm-event matching (§4.5) -- implemented this slice" for
    // why this call also subsumes the never_filled sweep.
    const armEventCounts = await matchPendingArmEvents(client, account, windowTo);

    // Step 10 (emit events -> Module 04/Module 07) -- EXPLICITLY DEFERRED,
    // documented no-op: neither module exists in this repo yet. Per §4.6
    // the real evaluation-freeze event belongs to the (not-yet-built)
    // confirm/freeze transaction, not sync time -- noted here so this
    // isn't mistaken for a forgotten wire-up later.

    const status: SyncStatus = coverageGapWritten || anomalies.length > 0 ? 'partial' : 'ok';

    const syncRunRes = await client.query<{ id: string }>(
      `insert into retrospeq.sync_runs
         (account_id, user_id, tier, trigger, window_from, window_to, fills_seen, fills_new, status, error_code, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, now())
       returning id`,
      [
        account.id,
        account.user_id,
        normalizeSyncRunTier(account.sync_tier),
        trigger,
        windowFrom.toISOString(),
        windowTo.toISOString(),
        fillsSeen,
        fillsNew,
        status,
      ],
    );

    return {
      skipped: false,
      syncRunId: syncRunRes.rows[0].id,
      status,
      fillsSeen,
      fillsNew,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      errorCode: null,
      coverageGapWritten,
      blocksCreated,
      tradesCreated,
      tradesUpdated: 0,
      anomalies,
      armEventsMatched: armEventCounts.matched,
      armEventsAmbiguous: armEventCounts.ambiguous,
      armEventsNeverFilled: armEventCounts.neverFilled,
    };
  });
}

interface ArmEventMatchCounts {
  matched: number;
  ambiguous: number;
  neverFilled: number;
}

interface PendingArmEventRow {
  id: string;
  instrument: string;
  direction: string;
  armed_at: string;
  captures: Record<string, unknown> | null;
}

interface CandidateEntryFillRow {
  fill_id: string;
  trade_id: string;
  side: 'buy' | 'sell';
  filled_at: string;
}

/**
 * §4.5's Step 8 -- see this file's header. Re-evaluates every `pending`
 * `arm_events` row for this account against its own instrument's current
 * entry-fill history and writes the resolved `match_state` (`matched` /
 * `ambiguous` / `never_filled`), or leaves it untouched if still
 * genuinely `pending`. On a match, also performs §4.5's pre-entry lock
 * (`lockPreEntryCaptures`). `now` is the caller's own sync-time reference
 * (`windowTo`), never `new Date()` called here directly -- same
 * testability posture as the rest of this file.
 */
async function matchPendingArmEvents(client: PoolClient, account: AccountRow, now: Date): Promise<ArmEventMatchCounts> {
  const counts: ArmEventMatchCounts = { matched: 0, ambiguous: 0, neverFilled: 0 };

  const pendingRes = await client.query<PendingArmEventRow>(
    `select id, instrument, direction, armed_at, captures
       from retrospeq.arm_events
      where account_id = $1 and match_state = 'pending'`,
    [account.id],
  );

  for (const armRow of pendingRes.rows) {
    // Candidate ENTRY fills for this arm's own instrument -- both physical
    // `trade_fills.role = 'entry'` members and ADR-0001 synthetic
    // `trade_events.kind = 'entry'` members (a flip-opened trade's entry
    // is never a `trade_fills` row -- see `grouping.ts`'s `assignRoles`),
    // scoped to this account. Mutually exclusive per member, so no UNION
    // dedup concern.
    const candidatesRes = await client.query<CandidateEntryFillRow>(
      `select f.id as fill_id, t.id as trade_id, f.side, f.filled_at
         from retrospeq.trade_fills tf
         join retrospeq.trades t on t.id = tf.trade_id
         join retrospeq.fills f on f.id = tf.fill_id
        where tf.role = 'entry' and t.account_id = $1 and t.instrument = $2

        union all

       select f.id as fill_id, t.id as trade_id, f.side, f.filled_at
         from retrospeq.trade_events te
         join retrospeq.trades t on t.id = te.trade_id
         join retrospeq.fills f on f.id = te.fill_id
        where te.kind = 'entry' and te.fill_id is not null and t.account_id = $1 and t.instrument = $2`,
      [account.id, armRow.instrument],
    );

    const candidates: CandidateEntryFill[] = candidatesRes.rows.map((r) => ({
      fillId: r.fill_id,
      tradeId: r.trade_id,
      instrument: armRow.instrument,
      side: r.side,
      filledAt: r.filled_at,
    }));

    const result = matchArmEvent(
      { instrument: armRow.instrument, direction: armRow.direction as ArmDirection, armedAt: armRow.armed_at },
      candidates,
      now,
    );

    if (result.state === 'matched') {
      await client.query(`update retrospeq.arm_events set match_state = 'matched', matched_trade_id = $2 where id = $1`, [
        armRow.id,
        result.tradeId,
      ]);
      await lockPreEntryCaptures(client, {
        tradeId: result.tradeId,
        userId: account.user_id,
        captures: armRow.captures ?? {},
      });
      counts.matched += 1;
    } else if (result.state === 'ambiguous') {
      await client.query(`update retrospeq.arm_events set match_state = 'ambiguous', match_candidates = $2 where id = $1`, [
        armRow.id,
        JSON.stringify({ tradeIds: result.candidateTradeIds, fillIds: result.candidateFillIds }),
      ]);
      counts.ambiguous += 1;
    } else if (result.state === 'never_filled') {
      await client.query(`update retrospeq.arm_events set match_state = 'never_filled' where id = $1`, [armRow.id]);
      counts.neverFilled += 1;
    }
    // 'pending' -- no write, judgment call #2 in arm-matching.ts's header.
  }

  return counts;
}

// ---------------------------------------------------------------------
// Shared block/fill-membership state -- factored out (2026-08-22, Module
// 02 Slice 5) so `recomputeInstrument`'s own matched-block anomaly check
// below and `lib/ingestion/confirm.ts`'s freeze-transaction guard (§4.6)
// ask the exact same correctness question against the exact same data,
// not two independently-written, potentially-diverging copies of it.
// `confirm.ts` needs the answer for one specific already-known block (a
// trade about to be confirmed), not the whole instrument's block set, so
// this returns everything both callers need and lets each one decide what
// to do with it (recompute-and-write vs refuse-and-report).
// ---------------------------------------------------------------------

export interface InstrumentBlockState {
  fillRowById: Map<string, FillDbRow>;
  freshBlocks: DerivedBlock[];
  assignments: FillBlockAssignment[];
  existingBlocks: { id: string; opened_at: string }[];
  memberFillIdsByBlockId: Map<string, Set<string>>;
  confirmedBlockIds: Set<string>;
}

/** Fetches every fill for this (account, instrument), re-derives blocks
 *  fresh over the FULL history, and cross-references against what's
 *  currently recorded in `blocks`/`trades`/`trade_fills`/`trade_events` --
 *  the same five queries `recomputeInstrument` always ran inline, now
 *  reusable by any caller that needs to ask "does this block's true
 *  current fill membership agree with what its trade(s) record." */
export async function loadInstrumentBlockState(
  client: PoolClient,
  accountId: string,
  instrument: string,
  dayRollover: string,
): Promise<InstrumentBlockState> {
  const fillRowsRes = await client.query<FillDbRow>(
    `select id, provider_ref, side, volume, price, filled_at, stop_at_fill,
            provider_position_ref, provider_parent_ref, realized_pnl
       from retrospeq.fills
      where account_id = $1 and instrument = $2
      order by filled_at, id`,
    [accountId, instrument],
  );
  const fillRows = fillRowsRes.rows;
  const fillRowById = new Map(fillRows.map((r) => [r.id, r]));

  const blockFills: BlockDerivationFill[] = fillRows.map((r) => ({
    id: r.id,
    accountId,
    instrument,
    side: r.side,
    volume: r.volume,
    filledAt: r.filled_at,
  }));

  const { blocks: freshBlocks, assignments } = deriveBlocks(blockFills, () => dayRollover);

  const existingBlocksRes = await client.query<{ id: string; opened_at: string }>(
    `select id, opened_at from retrospeq.blocks where account_id = $1 and instrument = $2`,
    [accountId, instrument],
  );
  const existingBlocks = existingBlocksRes.rows;

  const existingTradesRes = await client.query<{ id: string; block_id: string; confirmed_at: string | null }>(
    `select id, block_id, confirmed_at from retrospeq.trades where account_id = $1 and instrument = $2`,
    [accountId, instrument],
  );
  const existingTrades = existingTradesRes.rows;
  const existingTradeIds = existingTrades.map((t) => t.id);
  const confirmedBlockIds = new Set(existingTrades.filter((t) => t.confirmed_at !== null).map((t) => t.block_id));

  const memberFillIdsByBlockId = new Map<string, Set<string>>();
  if (existingTradeIds.length > 0) {
    const tfRes = await client.query<{ fill_id: string; block_id: string }>(
      `select tf.fill_id, t.block_id
         from retrospeq.trade_fills tf
         join retrospeq.trades t on t.id = tf.trade_id
        where tf.trade_id = any($1::uuid[])`,
      [existingTradeIds],
    );
    const teRes = await client.query<{ fill_id: string; block_id: string }>(
      `select te.fill_id, t.block_id
         from retrospeq.trade_events te
         join retrospeq.trades t on t.id = te.trade_id
        where te.trade_id = any($1::uuid[]) and te.fill_id is not null`,
      [existingTradeIds],
    );
    for (const row of [...tfRes.rows, ...teRes.rows]) {
      const set = memberFillIdsByBlockId.get(row.block_id) ?? new Set<string>();
      set.add(row.fill_id);
      memberFillIdsByBlockId.set(row.block_id, set);
    }
  }

  return { fillRowById, freshBlocks, assignments, existingBlocks, memberFillIdsByBlockId, confirmedBlockIds };
}

/** Pure: fill ids present in a block's freshly-derived membership but not
 *  yet recorded against it in `trade_fills`/`trade_events`. Shared by
 *  `recomputeInstrument`'s matched-block branch and `confirm.ts`'s guard. */
export function findUnrecordedBlockFills(freshFillIds: readonly string[], recordedFillIds: ReadonlySet<string>): string[] {
  return freshFillIds.filter((id) => !recordedFillIds.has(id));
}

/** Looks up one already-known block (e.g. a `trades.block_id` value)
 *  inside an `InstrumentBlockState` and returns any fill ids its
 *  freshly-derived membership includes that aren't yet recorded against
 *  it. Returns `[]` (never throws) if the block isn't found in this state
 *  at all -- should not happen for a `blockId` sourced from a real
 *  `trades` row on this same (account, instrument), but a freeze-
 *  transaction guard fails closed on "no anomaly detected," not open on a
 *  thrown exception, for a condition that should be structurally
 *  impossible rather than one the guard itself needs to defend against
 *  loudly. */
export function findUnrecordedFillsForBlock(state: InstrumentBlockState, blockId: string): string[] {
  const matched = state.existingBlocks.find((b) => b.id === blockId);
  if (!matched) return [];
  const freshBlockIndex = state.freshBlocks.findIndex((fb) => sameInstant(fb.openedAt, matched.opened_at));
  if (freshBlockIndex === -1) return [];
  const freshFillIds = state.assignments.filter((a) => a.blockIndex === freshBlockIndex).map((a) => a.fillId);
  const recorded = state.memberFillIdsByBlockId.get(blockId) ?? new Set<string>();
  return findUnrecordedBlockFills(freshFillIds, recorded);
}

interface RecomputeInstrumentResult {
  blocksCreated: number;
  tradesCreated: number;
  anomalies: string[];
}

/** §4.1 steps 6-9 for one (account, instrument) span -- see header
 *  judgment call #4 for the exact, deliberately narrow scope this
 *  implements. */
async function recomputeInstrument(
  client: PoolClient,
  account: AccountRow,
  instrument: string,
): Promise<RecomputeInstrumentResult> {
  const anomalies: string[] = [];

  const state = await loadInstrumentBlockState(client, account.id, instrument, account.day_rollover);
  const { fillRowById, freshBlocks, assignments, existingBlocks, memberFillIdsByBlockId, confirmedBlockIds } = state;

  let blocksCreated = 0;
  let tradesCreated = 0;

  for (let blockIndex = 0; blockIndex < freshBlocks.length; blockIndex++) {
    const freshBlock = freshBlocks[blockIndex];
    const freshFillIds = assignments.filter((a) => a.blockIndex === blockIndex).map((a) => a.fillId);
    const matched = existingBlocks.find((b) => sameInstant(b.opened_at, freshBlock.openedAt));

    if (matched) {
      // Header judgment call #4: an already-known block is ALWAYS left
      // untouched by this slice -- no write of any kind, confirmed or not.
      const recorded = memberFillIdsByBlockId.get(matched.id) ?? new Set<string>();
      const unrecorded = findUnrecordedBlockFills(freshFillIds, recorded);
      if (unrecorded.length > 0) {
        const isConfirmed = confirmedBlockIds.has(matched.id);
        const code = isConfirmed ? 'FILL_LATE_ARRIVAL' : 'BLOCK_EXTENSION_DEFERRED';
        const note = `${code}: block ${matched.id} (${instrument}) has ${unrecorded.length} fill(s) not yet reflected in its trade(s) -- left untouched, never silently rewritten (Module 02 §4.1/§9).`;
        anomalies.push(note);
        console.warn(`[sync] ${note}`);
      }
      continue;
    }

    // Brand-new block -- group + write fresh.
    blocksCreated += 1;
    const blockInsertRes = await client.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [account.user_id, account.id, instrument, freshBlock.openedAt, freshBlock.closedAt, freshBlock.serverDay],
    );
    const blockId = blockInsertRes.rows[0].id;

    const groupingFills: GroupingInputFill[] = assignments
      .filter((a) => a.blockIndex === blockIndex)
      .map((a) => {
        const row = fillRowById.get(a.fillId);
        if (!row) throw new Error(`recomputeInstrument: no fill row for assignment fillId ${a.fillId}.`);
        return {
          fillId: a.fillId,
          side: row.side,
          volume: row.volume,
          appliedVolume: a.appliedVolume,
          price: row.price,
          filledAt: row.filled_at,
          stopAtFill: row.stop_at_fill,
          providerPositionRef: row.provider_position_ref,
          providerParentRef: row.provider_parent_ref,
        };
      });

    const groups = groupBlock(groupingFills, { dayRollover: account.day_rollover });

    for (const group of groups) {
      const factsMembers: TradeFactsMember[] = group.members.map((m) => {
        const row = fillRowById.get(m.fillId);
        if (!row) throw new Error(`recomputeInstrument: no fill row for member fillId ${m.fillId}.`);
        return {
          fillId: m.fillId,
          role: m.role,
          side: m.side,
          volume: m.volume,
          price: m.price,
          filledAt: m.filledAt,
          stopAtFill: m.stopAtFill,
          realizedPnl: m.syntheticEntryEvent ? null : (row.realized_pnl ?? null),
          syntheticEntryEvent: m.syntheticEntryEvent,
        };
      });

      const facts = computeTradeFacts(factsMembers, {
        startingEquity: account.starting_equity,
        currency: account.base_currency,
        contractValue: '1',
      });

      const first = group.members[0];
      const last = group.members[group.members.length - 1];
      const openedAt = first.filledAt;
      const closedAt = group.isClosed ? last.filledAt : null;
      const serverDay = computeServerDay(openedAt, account.day_rollover);

      const tradeInsertRes = await client.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, initial_risk_pct, r_multiple,
            realized_pnl, currency, hold_seconds, outcome,
            grouping_confidence, grouping_signals, grouping_source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'auto')
         returning id`,
        [
          account.user_id,
          account.id,
          blockId,
          instrument,
          facts.direction,
          openedAt,
          closedAt,
          serverDay,
          group.isClosed ? 'closed' : 'open',
          facts.entryPriceAvg,
          facts.exitPriceAvg,
          facts.peakVolume,
          facts.initialStop,
          facts.riskPct,
          facts.initialRiskPct,
          facts.rMultiple,
          facts.realizedPnl,
          facts.currency,
          facts.holdSeconds,
          facts.outcome,
          group.confidence,
          JSON.stringify(group.signals),
        ],
      );
      const tradeId = tradeInsertRes.rows[0].id;
      tradesCreated += 1;

      for (const member of group.members) {
        if (member.syntheticEntryEvent) {
          // ADR 0001 -- the flip-opened trade's entry fact is a
          // trade_events row, never a second trade_fills row for the same
          // physical fill.
          await client.query(
            `insert into retrospeq.trade_events
               (user_id, trade_id, fill_id, kind, occurred_at, price, volume, volume_after)
             values ($1, $2, $3, 'entry', $4, $5, $6, $6)`,
            [account.user_id, tradeId, member.fillId, member.filledAt, member.price, member.volume],
          );
        } else {
          await client.query(
            `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role)
             values ($1, $2, $3, $4)`,
            [tradeId, member.fillId, account.user_id, member.role],
          );
        }
      }
    }
  }

  return { blocksCreated, tradesCreated, anomalies };
}

// ---------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------

/**
 * Runs one sync attempt for one account, per Module 02 §4.1. Total for
 * every `trading_accounts.platform` value -- never throws for input this
 * function itself can recognise as a legitimate, expected case (a manual
 * account; a broker/credential/KMS failure, all of which produce a
 * `status: 'failed'` `sync_runs` row instead of a thrown exception). DOES
 * throw for a genuine caller bug (an `accountId` that doesn't reference
 * any real `trading_accounts` row) -- per AGENTS.md, that's not a state
 * this pipeline should silently paper over.
 */
export async function runSync(
  accountId: string,
  adapter: BrokerAdapter,
  options: RunSyncOptions,
): Promise<RunSyncOutcome> {
  const account = await loadAccount(accountId);
  if (!account) {
    throw new Error(
      `runSync: no retrospeq.trading_accounts row for id ${accountId} -- accountId must reference a real, existing account.`,
    );
  }

  if (account.platform === 'manual') {
    // §4.8: manual accounts have no credential and nothing to sync from --
    // this whole sync concept doesn't apply to them. Their fills are
    // written directly by the (separate, not-yet-built) manual-entry
    // Server Action, which per §4.8's own words shares "no parallel code
    // path" with the REST of the pipeline (grouping/facts/etc), just not
    // this sync-orchestration entry point.
    return { skipped: true, reason: 'manual_account' };
  }

  const now = options.now ? options.now() : new Date();
  const overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  const masterKeyProvider = options.masterKeyProvider ?? lazyKmsMasterKeyProvider();

  const lastWindowTo = await loadLastWindowTo(accountId);
  const accountBaseline = account.connected_at ? new Date(account.connected_at) : new Date(account.created_at);
  const windowFrom = computeSyncWindowFrom(lastWindowTo, accountBaseline, overlapMs);
  const windowTo = now;

  let fills: Fill[];
  try {
    const credentialInput = await buildCredentialInput(account, masterKeyProvider);
    const handle: AccountHandle = await adapter.connect(credentialInput);
    fills = await adapter.fetchHistory(handle, windowFrom.toISOString());
  } catch (err) {
    const errorCode = classifySyncError(err);
    const syncRunId = await writeFailedSyncRun(account, options.trigger, windowFrom, windowTo, errorCode);
    return {
      skipped: false,
      syncRunId,
      status: 'failed',
      fillsSeen: 0,
      fillsNew: 0,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      errorCode,
      coverageGapWritten: false,
      blocksCreated: 0,
      tradesCreated: 0,
      tradesUpdated: 0,
      anomalies: [],
      armEventsMatched: 0,
      armEventsAmbiguous: 0,
      armEventsNeverFilled: 0,
    };
  }

  return writeSyncOutcome(account, options.trigger, windowFrom, windowTo, fills, lastWindowTo === null);
}
