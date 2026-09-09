import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Module 05 §7.5 / docs/adr/0021 -- proves the `no-restricted-imports`
 * override in `eslint.config.mjs` (scoped to `lib/analytics/**`) ACTUALLY
 * fires against a real violation, rather than trusting the config's own
 * shape by inspection alone. Per this slice's own dispatch: "a throwaway
 * file that violates the boundary, confirm eslint reports it, then
 * remove the throwaway file."
 *
 * The fixture is written to a REAL location under `lib/analytics/` (not
 * `os.tmpdir()`) because the rule is scoped by a `files: ["lib/analytics
 * /**"]` glob relative to the ESLint config's own root -- a file outside
 * that tree would never be linted against this override at all, which
 * would make this test prove nothing. It is created immediately before
 * each assertion and deleted in a `finally`, so a crash mid-test does not
 * leave a permanently-failing fixture behind in the repo tree (a second
 * safety net beyond the `finally` -- `afterAll` also sweeps the fixture
 * directory unconditionally).
 */

const FIXTURE_DIR = resolve(__dirname, '..', '__eslint_boundary_fixture__');

function withFixture(filename: string, contents: string, run: (path: string) => Promise<void>): Promise<void> {
  const path = join(FIXTURE_DIR, filename);
  return (async () => {
    const parentDir = resolve(path, '..');
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    writeFileSync(
      path,
      `// THROWAWAY FIXTURE -- written and deleted by lib/analytics/__tests__/eslint-boundary.test.ts\n` +
        `// at test runtime, to prove the Module 04/05 ESLint import boundary (docs/adr/0021) actually\n` +
        `// fires. If you are reading this file checked into git, something went wrong -- it should\n` +
        `// never persist past a single test run.\n` +
        contents,
      'utf8',
    );
    try {
      await run(path);
    } finally {
      rmSync(path, { force: true });
    }
  })();
}

describe('Module 04/05 ESLint import boundary (docs/adr/0021)', () => {
  beforeAll(() => {
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterAll(() => {
    // Belt-and-suspenders sweep -- each `withFixture` call already
    // deletes its own file in a `finally`, but a crash between
    // `writeFileSync` and that `finally` (e.g. the process being killed
    // mid-test) would otherwise leave a fixture file checked into a
    // working tree. This never leaves the directory itself behind
    // either way.
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('reports a violation for a file under lib/analytics/ importing @/lib/rules/**', async () => {
    await withFixture(
      '__violation_absolute__.ts',
      `import { getOperand } from '@/lib/rules/operand-catalogue';\nexport const x = getOperand('risk_pct');\n`,
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        expect(results).toHaveLength(1);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).toContain('no-restricted-imports');
        const message = results[0].messages.find((m) => m.ruleId === 'no-restricted-imports');
        expect(message?.message).toMatch(/Analytics code cannot import rule code/);
      },
    );
  });

  it('reports a violation for a file under lib/analytics/ importing lib/rules/** via a relative path', async () => {
    await withFixture(
      '__violation_relative__.ts',
      `import { getOperand } from '../../rules/operand-catalogue';\nexport const x = getOperand('risk_pct');\n`,
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).toContain('no-restricted-imports');
      },
    );
  });

  it('negative control: a legitimate import from @/lib/entitlements/** does NOT trip the boundary rule', async () => {
    await withFixture(
      '__control_legit_import__.ts',
      `import { planAtLeast } from '@/lib/entitlements/plan-rank';\nexport const x = planAtLeast('pro', 'free');\n`,
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).not.toContain('no-restricted-imports');
      },
    );
  });

  it('reports a violation for a file under lib/analytics/ importing lib/rules/** via a relative path nested 4 levels deep (bypass (c), fixed 2026-09-08)', async () => {
    // Prior to 2026-09-08, `no-restricted-imports`'s `patterns` option
    // used a hardcoded literal list capped at `../../../rules` (3
    // levels) -- a real file nested a 4th level (or deeper) under
    // `lib/analytics/` importing via `../../../../rules/...` produced
    // ZERO output (confirmed by an independent tester dispatch, see
    // PROGRESS.md's 2026-09-08 entry, item 3). The rule now uses a
    // single depth-agnostic regex (`(\.\./)+rules(/.*)?`) instead, so
    // this must trip regardless of nesting depth.
    await withFixture(
      join('shadow-harness', '__adv_verify_deep__', 'deeper', 'nested.ts'),
      `import { getOperand } from '../../../../rules/operand-catalogue';\nexport const x = getOperand('risk_pct');\n`,
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).toContain('no-restricted-imports');
      },
    );
  });

  it('reports a violation for a file under lib/analytics/ dynamically import()-ing lib/rules/** (bypass (a), fixed 2026-09-08)', async () => {
    // Prior to 2026-09-08, `no-restricted-imports` never registered an
    // `ImportExpression` visitor at all (confirmed directly against the
    // installed eslint@9.39.5 rule source: only `ImportDeclaration`,
    // `ExportNamedDeclaration`, `ExportAllDeclaration`, and
    // `TSImportEqualsDeclaration` are checked) -- a dynamic
    // `await import('@/lib/rules/...')` produced ZERO output no matter
    // how `patterns` was configured. A second rule,
    // `no-restricted-syntax` with an esquery `ImportExpression` selector,
    // now closes this specifically.
    await withFixture(
      '__violation_dynamic_import__.ts',
      `export async function f() {\n  const m = await import('@/lib/rules/operand-catalogue');\n  return m;\n}\n`,
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).toContain('no-restricted-syntax');
        const message = results[0].messages.find((m) => m.ruleId === 'no-restricted-syntax');
        expect(message?.message).toMatch(/dynamic import\(\)/);
      },
    );
  });

  it('reports a violation for a file under lib/analytics/ dynamically import()-ing lib/rules/** via a quasi-only template literal (backticks, zero substitutions) (gap found by tester 2026-09-08, fixed same day)', async () => {
    // An independent tester dispatch found that the (a) dynamic-import
    // fix above (`ImportExpression[source.value=/pattern/]`) structurally
    // can never match a `TemplateLiteral` source, because a
    // `TemplateLiteral` AST node has no `.value` property at all (only
    // `Literal` nodes do) -- so `await import(\`@/lib/rules/operand-
    // catalogue\`)` (an ordinary backtick string used stylistically
    // instead of quotes, with ZERO `${...}` substitutions) produced ZERO
    // ESLint output despite its full specifier being statically known.
    // A second `no-restricted-syntax` selector, scoped to
    // `TemplateLiteral` sources with `expressions.length === 0` and
    // reading the static string off `quasis[0].value.cooked`, now closes
    // this specific gap. See docs/adr/0021 for the precise distinction
    // from the WITH-substitution case below, which remains open by
    // design.
    await withFixture(
      '__violation_dynamic_import_template_literal__.ts',
      'export async function f() {\n  const m = await import(`@/lib/rules/operand-catalogue`);\n  return m;\n}\n',
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).toContain('no-restricted-syntax');
        const message = results[0].messages.find((m) => m.ruleId === 'no-restricted-syntax');
        expect(message?.message).toMatch(/template-literal specifier/);
      },
    );
  });

  it('does NOT report a violation for a dynamic import() with a template literal that HAS a substitution (e.g. `${x}`) -- genuinely dynamic, not statically matchable, documented as out of reach', async () => {
    // Deliberately the inverse of the case above: once a template
    // literal has a real `${...}` expression, its actual runtime
    // specifier is not known until the code executes, so there is no
    // static string for any lint rule to match against -- this is no
    // different in kind from `import(someVariable)`, which was already
    // understood as unclosable before this fix. This test exists so the
    // suite itself documents the boundary between what the quasi-only
    // fix above covers and what it deliberately does not, rather than
    // leaving that distinction implicit.
    await withFixture(
      '__control_dynamic_import_template_literal_with_substitution__.ts',
      'export async function f(x: string) {\n  const m = await import(`@/lib/rules/${x}`);\n  return m;\n}\n',
      async (path) => {
        const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
        const results = await eslint.lintFiles([path]);
        const ruleIds = results[0].messages.map((m) => m.ruleId);
        expect(ruleIds).not.toContain('no-restricted-syntax');
        expect(ruleIds).not.toContain('no-restricted-imports');
      },
    );
  });

  it('ESLINT-SPECIFIC LIMITATION (b), CLOSED at the overall-boundary level by dependency-cruiser (2026-09-09) -- a re-export indirection through a file OUTSIDE lib/analytics/ still fully defeats ESLint alone, but is now caught by npm run check:import-boundaries', async () => {
    // UPDATED 2026-09-09 (retrospeq-security-reviewer, Module 05
    // detection-engine slice): this test still intentionally asserts the
    // ESLint-level BYPASS SUCCEEDS (zero lint output from
    // no-restricted-imports/no-restricted-syntax) -- that half of the
    // finding is permanently true by construction (see the 'Why this
    // can't be closed by no-restricted-imports / no-restricted-syntax at
    // all' comment below) and is NOT what closes the real risk. The
    // overall Module 04/05 boundary is now closed by a SECOND,
    // complementary tool: .dependency-cruiser.cjs's
    // 'analytics-cannot-reach-rules' rule (to: { reachable: true }),
    // run via 'npm run check:import-boundaries', which resolves the
    // actual transitive module graph (not literal specifier strings) and
    // DOES report this exact re-export shape as a violation -- verified
    // directly by the security-reviewer reconstructing this same fixture
    // shape (lib/analytics/... -> lib/entitlements/.../reexport.ts ->
    // lib/rules/operand-catalogue.ts) and confirming depcruise exits
    // non-zero with the full chain in its output, then a clean run on
    // real lib/analytics/** code. This test therefore no longer documents
    // an ACCEPTED, OPEN gap in the whole boundary system (PROGRESS.md's
    // 2026-09-08 PASS's binding condition -- 'must be closed before
    // Module 05's edge/detection engine slices land real analytic
    // computation' -- fired with this exact slice and is now satisfied);
    // it documents a known, permanent, compensated-for LIMITATION of the
    // ESLint half specifically. If this test ever starts failing (i.e.
    // the re-export chain below starts tripping an ESLint rule), that
    // means the ESLint mechanism changed shape -- update this test AND
    // docs/adr/0021 together. If npm run check:import-boundaries ever
    // stops catching this same shape, THAT is the real regression to
    // treat as a live security gap, not this test.
    //
    // Why this can't be closed by `no-restricted-imports` /
    // `no-restricted-syntax` at all: both are single-file syntactic
    // checks. The intermediate re-export file lives OUTSIDE
    // `lib/analytics/**` (this rule's own `files` glob), so it is never
    // linted against this rule in the first place; and the file INSIDE
    // `lib/analytics/**` only ever imports a literal string that does
    // NOT match the `lib/rules` pattern (it points at the intermediate
    // file), so no pattern-based rule can catch it without following the
    // import graph across files -- which is what a real fix would need
    // (e.g. `dependency-cruiser`), deliberately deferred, see the ADR.
    const REEXPORT_DIR = resolve(__dirname, '..', '..', 'entitlements', '__fixture_boundary_reexport__');
    const reexportPath = join(REEXPORT_DIR, 'reexport.ts');
    const consumerPath = join(FIXTURE_DIR, '__violation_reexport_indirection__.ts');
    if (!existsSync(REEXPORT_DIR)) mkdirSync(REEXPORT_DIR, { recursive: true });
    writeFileSync(
      reexportPath,
      `// THROWAWAY FIXTURE -- written and deleted by lib/analytics/__tests__/eslint-boundary.test.ts\n` +
        `export { getOperand } from '@/lib/rules/operand-catalogue';\n`,
      'utf8',
    );
    try {
      await withFixture(
        '__violation_reexport_indirection__.ts',
        `import { getOperand } from '@/lib/entitlements/__fixture_boundary_reexport__/reexport';\nexport const x = getOperand('risk_pct');\n`,
        async () => {
          const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
          const results = await eslint.lintFiles([consumerPath, reexportPath]);
          const allRuleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
          expect(allRuleIds).not.toContain('no-restricted-imports');
          expect(allRuleIds).not.toContain('no-restricted-syntax');
        },
      );
    } finally {
      rmSync(REEXPORT_DIR, { recursive: true, force: true });
    }
  });

  it('negative control: this slice\'s own real production files under lib/analytics/ do not trip the boundary rule', async () => {
    const eslint = new ESLint({ cwd: resolve(__dirname, '..', '..', '..') });
    const results = await eslint.lintFiles([
      resolve(__dirname, '..', 'registry-runtime.ts'),
      resolve(__dirname, '..', 'registry-runtime-service.ts'),
      resolve(__dirname, '..', 'config-repository.ts'),
      resolve(__dirname, '..', 'cohort-repository.ts'),
      resolve(__dirname, '..', 'suppression-repository.ts'),
      resolve(__dirname, '..', 'account-tier-repository.ts'),
      resolve(__dirname, '..', 'render-repository.ts'),
    ]);
    const allMessages = results.flatMap((r) => r.messages.map((m) => m.ruleId));
    expect(allMessages).not.toContain('no-restricted-imports');
  });
});
