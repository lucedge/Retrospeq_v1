import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsconfig.json's "@/*" -> "./*" path alias — needed so tests
  // that import app code by its `@/...` alias (e.g. a route handler
  // importing `@/lib/supabase/server`) resolve the same way the Next.js
  // build itself resolves them.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // The shared dev Supabase project is remote: ~130ms per round trip and
    // ~5s to open a fresh pooled connection. Live tests' own beforeAll/
    // afterAll (seed + erasure-flagged cleanup) routinely exceed Vitest's
    // 10s default, which surfaced as six "Hook timed out" suite failures in
    // the 2026-09-15 phase-end sweep while every test inside them passed.
    hookTimeout: 30_000,
    // Property tests run hundreds of cases and are CPU-bound, so they
    // exceed Vitest's 5s default whenever the machine is busy — which,
    // on a host running several agents plus a dev server, is most of the
    // time. Six such timeouts in one sweep on 2026-09-18 were all
    // load-induced: every one passed when run alone. A slow machine
    // should make a suite slower, not red.
    testTimeout: 20_000,
    include: ['**/*.test.ts'],
    // `analytics-registry-schema.independent-verify.rls.test.ts` is
    // DESTRUCTIVE against the shared dev DB: it drops CHECK constraints and
    // revokes `select ... from authenticated` for the duration of an
    // assertion, so any test file running in parallel with it sees
    // "permission denied" / missing constraints. That produced 20 failures
    // in one `vitest run rls.test` sweep (2026-09-15) and was repeatedly
    // written off as an `analytic_user_suppression` flake. It is excluded
    // here AND named again in `check`/`check:security`'s own --exclude
    // flags (a CLI --exclude REPLACES this list, it does not add to it),
    // then run ALONE by `npm run test:exclusive` — never drop either copy
    // without moving the file's grant/constraint surgery somewhere isolated.
    exclude: [
      'node_modules',
      '.next',
      'fixtures/**',
      'lib/supabase/__tests__/analytics-registry-schema.independent-verify.rls.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 00-foundation §9.1 / AGENTS.md testing bar: 90% line coverage on
      // the engines (grouping, rule, statistics), 70% overall. The
      // shadow harness is infrastructure, not one of the three named
      // engines, but is held to the 90% bar anyway since it is the only
      // code under test right now.
      include: ['lib/**/*.ts'],
      // `types.ts` is type-only (no runtime statements to cover);
      // `index.ts` is a re-export barrel with no logic of its own.
      exclude: [
        'lib/**/__tests__/**',
        'lib/**/*.d.ts',
        'lib/**/types.ts',
        'lib/**/index.ts',
      ],
    },
  },
});
