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
    exclude: ['node_modules', '.next', 'fixtures/**'],
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
