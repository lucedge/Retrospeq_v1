import { createClient } from '@supabase/supabase-js';
import type { ShadowRunRecord, ShadowRunRow } from './types';

/**
 * Thrown by `createSupabaseShadowRunRepository()` when the real Supabase
 * project isn't configured. AGENTS.md ("never fake it"): there is no
 * Supabase project for Retrospeq yet (PROGRESS.md "Infra gaps"), so this
 * throws a named error rather than returning a no-op/in-memory stand-in
 * that would let a caller believe persistence happened.
 */
export class ShadowHarnessNotConfiguredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Shadow harness cannot persist to Supabase — missing env var(s): ${missing.join(', ')}. ` +
        'No Supabase project exists yet for Retrospeq (see PROGRESS.md "Infra gaps"). ' +
        'This is a deliberate failure, not a fallback.',
    );
    this.name = 'ShadowHarnessNotConfiguredError';
    this.missing = missing;
  }
}

/** Persistence boundary the harness runs against. Swappable for tests. */
export interface ShadowRunRepository {
  insert(record: ShadowRunRecord): Promise<ShadowRunRow>;
  /** Used by promotion.ts to count distinct accounts an analytic has run on. */
  listByAnalytic(analyticId: string, since?: Date): Promise<ShadowRunRow[]>;
}

const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

/**
 * Real implementation, built against the eventual Supabase project's
 * interface (00-foundation §1.2 "Deferred" job class — this always runs
 * as a background job, never in a request path). Uses the service role
 * per §3.2: takes an explicit `user_id` on every record it's given,
 * never derives one from a request, and is never exposed to the client.
 *
 * Throws `ShadowHarnessNotConfiguredError` immediately if the env vars
 * this repo doesn't have yet are absent — see AGENTS.md's "known infra
 * gaps: build against the interfaces" rule. Importing this module is
 * always safe (no env access at import time); only calling the factory
 * touches `process.env`.
 */
export function createSupabaseShadowRunRepository(): ShadowRunRepository {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new ShadowHarnessNotConfiguredError(missing);
  }

  const client = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  );

  return {
    async insert(record) {
      const { data, error } = await client
        .from('shadow_runs')
        .insert(record)
        .select()
        .single();
      if (error) throw error;
      return data as ShadowRunRow;
    },

    async listByAnalytic(analyticId, since) {
      let query = client.from('shadow_runs').select('*').eq('analytic_id', analyticId);
      if (since) {
        query = query.gte('computed_at', since.toISOString());
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ShadowRunRow[];
    },
  };
}
