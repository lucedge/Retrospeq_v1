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
    include: ['**/*.test.ts'],
    // `analytics-registry-schema.independent-verify.rls.test.ts` is
    // DESTRUCTIVE against the shared dev DB: it drops CHECK constraints and
    // revokes `select ... from authenticated` for the duration of an
    // assertion, so any test file running in parallel with it sees
    // "permission denied" / missing constraints. That produced 20 failures
    // in one `vitest run rls.test` sweep (2026-09-15) and was repeatedly
    // written off as an `analytic_user_suppression` flake. It is excluded
    // here and run ALONE by `npm run test:exclusive`, which `check` and
    // `check:security` both invoke — never delete the exclusion without
    // moving the file's grant/constraint surgery somewhere isolated.
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
