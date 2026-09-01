import 'server-only';
import type { PoolClient } from 'pg';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 08 (Onboarding & Home) §4 — Slice 08a: the `onboarding_state`
 * data-access layer. `onboarding_state` itself was migrated in this same
 * slice (`supabase/migrations/20260901010000_onboarding_schema.sql`) with
 * a real owner "for all" RLS shape (a genuinely trader-progression-driven
 * row, mutated in place, the same class as Module 04's `rules` table —
 * see that migration's own header for the full reasoning) plus a
 * DB-level `onboarding_state_forbid_stage_regression` trigger enforcing
 * §10.2's own property-test requirement: "Onboarding stage only advances,
 * never regresses."
 *
 * ## Deliberately built with NO caller yet, this slice
 *
 * Per this slice's own dispatch scope ("zero UI, zero dependency on
 * Modules 03/05/06/07"), nothing in `app/` calls `advanceOnboardingStage`
 * yet — the onboarding sequence routing that WOULD call it is a later
 * sub-slice. This is the same "substrate before screens" posture Module
 * 04 Slice 1 already established for `lib/rules/evaluate.ts` (built and
 * fully tested with no caller until Slice 5), not the orphaned-backend
 * gap Module 04 Slice 10e's own "Module 04 scope gap" entry flagged —
 * that gap was a UI that should have existed and silently didn't; this is
 * a documented, deliberate ordering choice logged in PROGRESS.md.
 *
 * ## Forward-only enforcement: BOTH layers, deliberately, matching this
 * repo's own established pattern for exactly this class of invariant
 *
 * 1. **The DB trigger is the real, adversarial-proof backstop** — it
 *    rejects a stage regression even from a raw SQL statement that
 *    bypasses this file entirely (the same posture `rule_versions_forbid_
 *    mutation` and `forbid_frozen_trade_regrouping` already established
 *    in this repo — see the migration's own header).
 * 2. **`advanceOnboardingStage` ALSO pre-checks the ordinal in
 *    application code** before issuing its UPDATE, purely as a fast,
 *    friendly path that avoids a round trip to the DB for the common
 *    misuse case and throws the SAME typed `OnboardingStageRegressionError`
 *    either way. This pre-check is NOT itself race-safe against a
 *    genuinely concurrent second `advanceOnboardingStage` call for the
 *    same user (a classic read-then-write TOCTOU window) — but that race
 *    is caught anyway, because the UPDATE it issues is caught in a
 *    try/catch that maps the trigger's own raised exception (Postgres
 *    errcode 23514, "stage cannot regress") to the identical
 *    `OnboardingStageRegressionError`, giving a caller ONE predictable
 *    error type regardless of which layer actually caught the problem —
 *    the same "map the DB-level guard's failure to the same error the
 *    friendly pre-check already used" pattern Module 04 Slice 10b's
 *    `RuleCreateCapExceededError` established for the free-tier rule cap.
 *
 * ## `retrospeq.profiles.onboarding_stage` reconciliation
 *
 * `20260820010000_profiles.sql`'s own column comment anticipates this
 * exactly: "Free-text stage id, not an enum: Module 08 (Onboarding, not
 * yet built) owns the actual stage vocabulary and may add stages without
 * a migration here." Read plainly, that column was always meant to be a
 * denormalised, fast-read COPY of whatever Module 08's own real state
 * machine says — not a second, independent tracker. `advanceOnboardingStage`
 * therefore updates BOTH `retrospeq.onboarding_state.stage` (authoritative)
 * AND `retrospeq.profiles.onboarding_stage` (denormalised copy) in the
 * SAME transaction, so the two can never drift. This reconciliation is
 * logged in PROGRESS.md's decision log ("onboarding_state.stage vs
 * profiles.onboarding_stage", 2026-09-01) per 00-foundation §12.
 */

export const ONBOARDING_STAGE_ORDER = [
  'created',
  'account_connected',
  'history_imported',
  'rules_calibrated',
  'first_closeout',
  'fields_introduced',
  'complete',
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGE_ORDER)[number];
export type OnboardingPath = 'broker' | 'manual';

/** Returns `stage`'s position in the forward-only sequence — the exact
 *  same mapping `retrospeq.onboarding_stage_ordinal` (the SQL function
 *  the DB trigger uses) encodes, kept in one place per side (SQL owns the
 *  DB-level truth, this owns the app-level fast-path check) rather than a
 *  single shared source, since a SQL function cannot be imported into TS
 *  and vice versa — divergence risk is mitigated by both lists being
 *  derived from the exact same seven values §4 names, and by this file's
 *  own unit tests asserting the two never disagree via the live-DB
 *  ordinal function directly (see `__tests__/onboarding-state-repository
 *  .live.test.ts`). */
export function onboardingStageOrdinal(stage: OnboardingStage): number {
  return ONBOARDING_STAGE_ORDER.indexOf(stage);
}

export class InvalidOnboardingStageError extends Error {
  constructor(readonly stage: string) {
    super(
      `"${stage}" is not a valid onboarding_state.stage — must be one of: ${ONBOARDING_STAGE_ORDER.join(', ')} (Module 08 §4).`,
    );
    this.name = 'InvalidOnboardingStageError';
  }
}

function assertValidStage(stage: string): asserts stage is OnboardingStage {
  if (!(ONBOARDING_STAGE_ORDER as readonly string[]).includes(stage)) {
    throw new InvalidOnboardingStageError(stage);
  }
}

export class OnboardingStateNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`No onboarding_state row for user ${userId} — every user should have one from signup (handle_new_user).`);
    this.name = 'OnboardingStateNotFoundError';
  }
}

/**
 * Thrown when `targetStage` would regress `onboarding_state.stage` —
 * caught either by this file's own fast pre-check, or (on a genuine race)
 * by translating the DB trigger's own raised exception. See this file's
 * own header for why both paths exist and both throw this SAME class.
 */
export class OnboardingStageRegressionError extends Error {
  constructor(
    readonly userId: string,
    readonly fromStage: OnboardingStage,
    readonly toStage: string,
  ) {
    super(
      `onboarding_state: cannot move user ${userId} from stage "${fromStage}" to "${toStage}" — Module 08 §10.2, ` +
        `"Onboarding stage only advances, never regresses."`,
    );
    this.name = 'OnboardingStageRegressionError';
  }
}

export interface OnboardingState {
  userId: string;
  stage: OnboardingStage;
  path: OnboardingPath;
  firstFindingId: string | null;
  firstFindingShownAt: string | null;
  rulesCalibratedAt: string | null;
  fieldsOfferedAt: string | null;
  fieldsDeclinedCount: number;
  updatedAt: string;
}

interface OnboardingStateRow {
  user_id: string;
  stage: string;
  path: string;
  first_finding_id: string | null;
  first_finding_shown_at: string | null;
  rules_calibrated_at: string | null;
  fields_offered_at: string | null;
  fields_declined_count: number;
  updated_at: string;
}

function mapRow(row: OnboardingStateRow): OnboardingState {
  assertValidStage(row.stage);
  return {
    userId: row.user_id,
    stage: row.stage,
    path: row.path as OnboardingPath,
    firstFindingId: row.first_finding_id,
    firstFindingShownAt: row.first_finding_shown_at,
    rulesCalibratedAt: row.rules_calibrated_at,
    fieldsOfferedAt: row.fields_offered_at,
    fieldsDeclinedCount: row.fields_declined_count,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `user_id, stage, path, first_finding_id,
       first_finding_shown_at::text as first_finding_shown_at,
       rules_calibrated_at::text as rules_calibrated_at,
       fields_offered_at::text as fields_offered_at,
       fields_declined_count,
       updated_at::text as updated_at`;

/** Internal helper shared by the standalone read below and
 *  `advanceOnboardingStage`'s own in-transaction pre-check, so a caller
 *  already holding a connection never opens a second one for the same
 *  row. */
async function fetchOnboardingStateWithClient(client: PoolClient, userId: string): Promise<OnboardingState | null> {
  const res = await client.query<OnboardingStateRow>(
    `select ${SELECT_COLUMNS} from retrospeq.onboarding_state where user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Reads the caller's own onboarding_state row, genuinely RLS-enforced
 * (`withUserConnection`). `null` only for a user created before this
 * slice's migration's backfill ran, or a data-integrity bug — every user
 * created via `handle_new_user` from this migration forward has one from
 * the instant `auth.users` gets their row (never a valid "signed up, no
 * onboarding_state yet" state, per this migration's own header).
 */
export async function fetchOnboardingState(userId: string): Promise<OnboardingState | null> {
  return withUserConnection(userId, (client) => fetchOnboardingStateWithClient(client, userId));
}

export interface AdvanceOnboardingStageExtra {
  path?: OnboardingPath;
  /** No FK — see the migration's own header (Module 05 `findings` doesn't
   *  exist yet). Caller-supplied verbatim. */
  firstFindingId?: string;
  /** ISO-8601 timestamp strings, caller-computed — this repository layer
   *  does not decide WHEN each of these should be stamped (that is the
   *  future onboarding-flow UI slice's job); it only persists whatever
   *  the caller supplies, `coalesce`d so an omitted field never clobbers
   *  an already-set one. */
  firstFindingShownAt?: string;
  rulesCalibratedAt?: string;
  fieldsOfferedAt?: string;
  /** Story 1.6: "declining is free and recorded." When `true`, increments
   *  `fields_declined_count` by exactly 1 in the same UPDATE — never
   *  overwrites it with a caller-supplied absolute number, so two
   *  concurrent declines can never silently clobber each other's count
   *  (each is `+1` against whatever the row currently holds, evaluated
   *  atomically by the single UPDATE statement). */
  incrementFieldsDeclinedCount?: boolean;
}

const TRIGGER_REGRESSION_MESSAGE_FRAGMENT = 'stage cannot regress';

/**
 * Moves `userId`'s onboarding_state forward to `targetStage`, optionally
 * stamping any of the fields §4 names. Also keeps
 * `retrospeq.profiles.onboarding_stage` in sync in the SAME transaction —
 * see this file's own header ("profiles.onboarding_stage reconciliation").
 *
 * Idempotent for `targetStage === current stage` (not a regression, a
 * no-op re-assertion — e.g. a retried Server Action after a network
 * blip). Throws `OnboardingStageRegressionError` for a genuine attempt to
 * move backward, `OnboardingStateNotFoundError` if the row doesn't exist
 * at all, `InvalidOnboardingStageError` for a stage string outside §4's
 * own seven values.
 */
export async function advanceOnboardingStage(
  userId: string,
  targetStage: OnboardingStage,
  extra: AdvanceOnboardingStageExtra = {},
): Promise<OnboardingState> {
  assertValidStage(targetStage);

  return withUserConnection(userId, async (client) => {
    // Fast, friendly pre-check -- see this file's own header for why this
    // is NOT the real invariant-enforcing layer (that's the DB trigger,
    // caught below) but is worth doing anyway to avoid a round trip for
    // the common/deliberate-misuse case, and to report a real "not found"
    // separately from a regression.
    const current = await fetchOnboardingStateWithClient(client, userId);
    if (!current) {
      throw new OnboardingStateNotFoundError(userId);
    }
    if (onboardingStageOrdinal(targetStage) < onboardingStageOrdinal(current.stage)) {
      throw new OnboardingStageRegressionError(userId, current.stage, targetStage);
    }

    let res;
    try {
      res = await client.query<OnboardingStateRow>(
        `update retrospeq.onboarding_state
            set stage = $2,
                path = coalesce($3, path),
                first_finding_id = coalesce($4, first_finding_id),
                first_finding_shown_at = coalesce($5::timestamptz, first_finding_shown_at),
                rules_calibrated_at = coalesce($6::timestamptz, rules_calibrated_at),
                fields_offered_at = coalesce($7::timestamptz, fields_offered_at),
                fields_declined_count = fields_declined_count + $8,
                updated_at = now()
          where user_id = $1
          returning ${SELECT_COLUMNS}`,
        [
          userId,
          targetStage,
          extra.path ?? null,
          extra.firstFindingId ?? null,
          extra.firstFindingShownAt ?? null,
          extra.rulesCalibratedAt ?? null,
          extra.fieldsOfferedAt ?? null,
          extra.incrementFieldsDeclinedCount ? 1 : 0,
        ],
      );
    } catch (err) {
      // Translate the DB trigger's own raised exception (a genuine race
      // this pre-check's read-then-write window missed) into the SAME
      // typed error the pre-check above already throws -- one predictable
      // error type for callers regardless of which layer actually caught
      // the regression attempt.
      if (err instanceof Error && err.message.includes(TRIGGER_REGRESSION_MESSAGE_FRAGMENT)) {
        throw new OnboardingStageRegressionError(userId, current.stage, targetStage);
      }
      throw err;
    }

    const row = res.rows[0];
    if (!row) {
      // Structurally shouldn't happen -- the pre-check above just proved
      // the row exists inside this same transaction, and no other
      // statement in this transaction can have deleted it. Kept as a
      // named, loud failure rather than a silent `undefined` return, same
      // "should be impossible, throw anyway" posture `split-join.ts`
      // documents for its own analogous defensive checks.
      throw new OnboardingStateNotFoundError(userId);
    }

    // Keep the denormalised profiles.onboarding_stage copy in sync, same
    // transaction -- see this file's own header.
    await client.query(`update retrospeq.profiles set onboarding_stage = $2 where id = $1`, [userId, targetStage]);

    return mapRow(row);
  });
}

/**
 * Module 08 §5.1/§5.3 -- Slice 08b's shared best-effort wrapper around
 * `advanceOnboardingStage`, for every call site that is a side effect of
 * some OTHER already-successful operation (a broker connect, a completed
 * sync/import, a rule-calibration flow finishing) rather than the trader's
 * own primary request. Matches this repo's established
 * `operand_distributions`/`adherence_weekly`/`unlock_state` posture
 * exactly: a failure here must NEVER turn the real, already-committed
 * operation into a reported failure.
 *
 * A genuine `OnboardingStageRegressionError`/`OnboardingStateNotFoundError`
 * is treated as an EXPECTED, benign no-op here, not a bug to log loudly --
 * for example, connecting a SECOND broker account long after onboarding
 * has already completed legitimately tries to move a `complete`-stage
 * trader "back" to `account_connected`, which this function correctly
 * swallows silently rather than reporting as a failure. Only a genuinely
 * unexpected exception is logged (`docs/runbook.md`'s matching new entry,
 * "onboarding_state advance failing after a connect/import/calibration").
 */
export async function advanceOnboardingStageBestEffort(
  userId: string,
  targetStage: OnboardingStage,
  extra: AdvanceOnboardingStageExtra = {},
): Promise<void> {
  try {
    await advanceOnboardingStage(userId, targetStage, extra);
  } catch (err) {
    if (err instanceof OnboardingStageRegressionError || err instanceof OnboardingStateNotFoundError) {
      return;
    }
    console.error(
      `[onboarding] advanceOnboardingStage(${userId}, "${targetStage}") failed unexpectedly -- onboarding_state ` +
        `will read stale until the next successful call (Module 08 §4; docs/runbook.md "onboarding_state advance ` +
        `failing after a connect/import/calibration"):`,
      err,
    );
  }
}
