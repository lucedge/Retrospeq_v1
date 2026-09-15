import 'server-only';
import type { Platform } from '@/lib/broker/adapter';
import { defaultStrategyNameForPlatform } from '@/lib/broker/platform-defaults';
import { fetchDefaultStrategySeedFieldIds } from '@/lib/fields/fields-repository';
import {
  createStrategy,
  DefaultStrategyAlreadyExistsError,
  fetchStrategiesForUser,
} from '@/lib/fields/strategy-repository';
import type { ProposedStrategyField } from '@/lib/fields/strategy-validation';

/**
 * Module 08 (Onboarding & Home) §5.4 — "Create one strategy automatically,
 * named after the instrument class ('Forex', 'Crypto'), with zero captured
 * fields. Logging works immediately from derived data. The streak starts
 * day one." This is the real wiring closing `docs/infra-gaps.md`'s own
 * `isDefaultStrategy` entry: "Flagged specifically for whoever wires up
 * Module 08's silent default-strategy creation for real ... that future
 * dispatch should add an explicit 'does this user already have ANY
 * strategy?' check before setting `isDefaultStrategy: true`, not rely on
 * the uniqueness index alone." That explicit check now lives at the
 * source, in `lib/fields/strategy-repository.ts`'s `insertStrategyAndVersion`
 * (see that function's own header) — this file is the onboarding-side
 * caller, never the enforcement boundary itself.
 *
 * Deliberately lives in `lib/onboarding/`, importing FROM `lib/fields/`
 * and `lib/broker/` (never the reverse) — Module 08 (onboarding) composes
 * Module 03's strategy-authoring primitives and Module 01/02's
 * platform-naming lookup; neither of those lower-level modules should ever
 * need to know onboarding exists.
 *
 * NO AUTO-CLUSTERING: the ONLY input this function reads from an account
 * is its `platform` column — metadata already known at connect time (the
 * trader picked "MT5" or "Binance" from a list), never anything derived
 * from the CONTENT of imported trades. §5.4's "no auto-created strategies
 * from clustering imported history" is about inventing structure from
 * trade data the trader might not recognise as theirs; naming a strategy
 * after the account type they themselves connected is not that.
 *
 * SEEDED WITH DERIVED/NON-CAPTURED FIELDS, NOT LITERALLY ZERO FIELDS
 * (`docs/infra-gaps.md`, closed by this addition): §5.4 promises "zero
 * CAPTURED fields," never "zero fields" — but the edge engine
 * (`lib/analytics/edge-engine/repository.ts`'s `fetchStrategyFieldSpecs`)
 * only ever computes findings over a strategy's OWN chosen field list, so
 * a version created with `fields: []` can never produce a finding, derived
 * or otherwise, breaking §6's own unlock-ladder promise ("Imported, 0
 * logged -> Derived findings available") for every stock default
 * strategy. `fetchDefaultStrategySeedFieldIds` (`lib/fields/
 * fields-repository.ts`) selects exactly the fields that keep the "zero
 * captured" promise (`kind <> 'strategy_var' and origin <> 'captured'`,
 * see that function's own header) — today, this user's 9 permanent
 * `drv.*` derived rows, always already seeded at signup (`handle_new_user`
 * -> `seed_derived_fields_for_user`) well before this function's first
 * call. `captureMoment: 'post_close'` on every seeded entry is inert
 * metadata for these rows (the edge engine reads only `field_id`,
 * `strategy-validation.ts`'s own `validateCaptureMoments` only imposes
 * real constraints on `captureMoment === 'pre_entry'`) — chosen only to be
 * a schema-valid, always-safe value, never surfaced to the trader (derived
 * fields never appear in any picker or capture flow, §1.1).
 *
 * CALLED FROM (both best-effort, alongside — not inside —
 * `advanceOnboardingStageBestEffort(..., 'history_imported', ...)`, per
 * this slice's own dispatch):
 *   - `lib/ingestion/sync.ts`'s `runSync`, on a real broker account's
 *     first successful sync.
 *   - `app/(app)/accounts/actions.ts`'s `connectManualAccount`, on manual
 *     account creation.
 */
export async function ensureDefaultStrategyForUser(userId: string, platform: Platform): Promise<void> {
  try {
    // Fast, friendly pre-check — correct for the overwhelmingly common
    // case (one sync/connect at a time), but NOT itself race-safe: two
    // genuinely concurrent calls for the same brand-new user (e.g. two
    // accounts syncing at once) could both read zero strategies here
    // before either has written anything. This is a latency/log-noise
    // optimisation only; correctness comes from the atomic check inside
    // `createStrategy` -> `insertStrategyAndVersion` below, which holds a
    // per-user `pg_advisory_xact_lock` and re-verifies "zero pre-existing
    // strategies" INSIDE that lock, atomically with the write.
    const existing = await fetchStrategiesForUser(userId);
    if (existing.length > 0) return; // idempotent: already has one (or more)

    const seedFieldIds = await fetchDefaultStrategySeedFieldIds(userId);
    const seedFields: ProposedStrategyField[] = seedFieldIds.map((fieldId, index) => ({
      fieldId,
      captureMoment: 'post_close',
      order: index,
    }));

    await createStrategy({
      userId,
      name: defaultStrategyNameForPlatform(platform),
      fields: seedFields,
      triggers: [],
      isDefaultStrategy: true,
    });
  } catch (err) {
    if (err instanceof DefaultStrategyAlreadyExistsError) {
      // EXPECTED, benign: either a genuine race with a concurrent call for
      // this same user (the real correctness backstop this file's own
      // header describes), or a trader who already has a real,
      // user-created strategy by the time this runs (e.g. a Pro trader who
      // built one manually before their first sync completed). Matches
      // `advanceOnboardingStageBestEffort`'s own treatment of
      // `OnboardingStageRegressionError` as a silently-swallowed, expected
      // shape rather than a bug.
      return;
    }
    // Never re-thrown -- this must never block a sync or an account
    // creation (this slice's own dispatch instruction), matching
    // `advanceOnboardingStageBestEffort`'s "never turn a genuinely
    // successful [operation] into a reported failure" posture exactly.
    // See docs/runbook.md's matching entry for what this means
    // operationally and how to check for it.
    console.error(
      `[onboarding] ensureDefaultStrategyForUser(${userId}, "${platform}") failed unexpectedly -- this trader has no silent default strategy yet and will have to build one manually (Pro) or wait for the next successful sync/connect to retry this (Module 08 §5.4):`,
      err,
    );
  }
}
