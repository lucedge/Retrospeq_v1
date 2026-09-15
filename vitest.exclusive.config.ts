import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Runs only the DESTRUCTIVE schema tests, alone, with no file parallelism.
 * `analytics-registry-schema.independent-verify.rls.test.ts` drops CHECK
 * constraints and revokes `select ... from authenticated` on the shared dev
 * DB for the duration of an assertion, so anything running beside it fails
 * with "permission denied" (20 such failures in one sweep, 2026-09-15 — long
 * mistaken for an `analytic_user_suppression` flake). `vitest.config.ts`
 * excludes it from every normal run; `npm run test:exclusive` uses this
 * config, and `check` / `check:security` both call that script.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['lib/supabase/__tests__/analytics-registry-schema.independent-verify.rls.test.ts'],
    fileParallelism: false,
  },
});
