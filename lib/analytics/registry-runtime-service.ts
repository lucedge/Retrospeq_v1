import 'server-only';
import { getUserPlan } from '@/lib/entitlements/subscription-repository';
import type { Plan } from '@/lib/entitlements/types';
import { getAnalyticConfig } from './config-repository';
import { isUserInCohort } from './cohort-repository';
import { isSuppressed } from './suppression-repository';
import { getAccountSyncTiers } from './account-tier-repository';
import { canRenderPure, type AnalyticConfigLookup, type CanRenderResult, type Surface } from './registry-runtime';

/**
 * Module 05 §4.8 — the orchestration (I/O) half of `canRender`. Wires
 * `registry-runtime.ts`'s pure formula to the real repository reads,
 * mirroring `lib/entitlements/can.ts`'s own "dependency-injected
 * orchestration over a pure resolver" shape (`resolve.ts` there,
 * `registry-runtime.ts` here) — deliberately the same architecture, not
 * a coincidence, since both answer the identical shape of question
 * ("is this user allowed to see this thing right now").
 *
 * THE FAIL-CLOSED CONTRACT — the single most load-bearing property of
 * this whole slice, per §4.8's "if config cannot be read, nothing
 * renders" and §9's `ANALYTIC_CONFIG_UNAVAILABLE` row: this function
 * NEVER throws. Every dependency call is wrapped; ANY failure —
 * `getAnalyticConfig` throwing (a dead connection, a real Postgres
 * error), or any of the three downstream reads throwing — resolves to
 * `{ canRender: false, reason: 'config_unavailable' }`, never a
 * propagated exception a careless caller might catch-and-default-to-true
 * (this slice's own dispatch, verbatim). This is DELIBERATELY BROADER
 * than §4.8's own literal wording ("if CONFIG cannot be read") — a
 * failure while resolving plan/cohort/suppression/tier is just as much a
 * "we do not actually know if this is safe to show" situation as a
 * config-read failure, and §9's own overarching framing ("Silence over
 * wrongness, always") reads naturally as covering all of it, not only
 * the literal config table. Documented here as the deliberate broadening
 * it is, not silently assumed.
 */
export async function canRender(analyticId: string, userId: string, _surface: Surface): Promise<CanRenderResult> {
  // All five reads fire in parallel, not config-then-the-rest (2026-09-17
  // latency slice): the original code paid TWO sequential round trips for
  // the overwhelmingly common `found` case (config alone, then the other
  // four together) purely to skip four reads on the rare `not_found`/
  // `unavailable` path (a misconfigured or not-yet-seeded analytic id,
  // effectively never true in practice, and `getAnalyticConfig` is cached
  // 60s regardless — see that file's own header). Starting every read at
  // once halves this function's own latency on the hot path at the cost
  // of a few wasted reads on the cold one. The fail-closed CONTRACT below
  // is unchanged — only when the reads fire changed, not what a failure
  // resolves to.
  const configPromise = getAnalyticConfig(analyticId, userId).catch(
    (): AnalyticConfigLookup => ({ status: 'unavailable' }),
  );
  const restPromise = Promise.all([
    getUserPlan(userId) as Promise<Plan>,
    isUserInCohort(userId),
    isSuppressed(userId, analyticId),
    getAccountSyncTiers(userId),
  ]);
  // Started unconditionally above so the `not_found`/`unavailable` branch
  // below never leaves `restPromise` unobserved (an unhandled rejection)
  // when it returns without awaiting it.
  restPromise.catch(() => {});

  const configLookup = await configPromise;

  if (configLookup.status !== 'found') {
    // Same short-circuit ANSWER as before — canRenderPure reaches the
    // identical result regardless of the other four values — but the
    // reads themselves are already in flight, not newly triggered here.
    return canRenderPure({
      configLookup,
      userPlan: 'free',
      userInCohort: false,
      suppressed: true,
      accountSyncTiers: [],
    });
  }

  try {
    const [userPlan, userInCohort, suppressed, accountSyncTiers] = await restPromise;
    return canRenderPure({ configLookup, userPlan, userInCohort, suppressed, accountSyncTiers });
  } catch {
    // See this file's own header -- any downstream read failing is
    // treated the same fail-closed way a config-read failure is.
    return { canRender: false, reason: 'config_unavailable' };
  }
}

export type { CanRenderResult, Surface } from './registry-runtime';
