/**
 * Module 04/05 isolation boundary -- transitive-import-graph layer.
 *
 * This is the CLOSING half of docs/adr/0021's own documented "residual
 * risk (b)": `eslint.config.mjs`'s `no-restricted-imports`/
 * `no-restricted-syntax` overrides (see the comment block above those
 * rules) are single-file syntactic checks -- they can only ever see the
 * literal specifier string written in a file physically under
 * `lib/analytics/**`. A file under `lib/analytics/**` that imports a
 * RE-EXPORT of `lib/rules/**` code from some third file OUTSIDE
 * `lib/analytics/**` (e.g. `lib/entitlements/reexport.ts` re-exporting
 * `@/lib/rules/operand-catalogue`) defeats both ESLint rules completely,
 * because neither the consuming file's own import specifier nor the
 * re-export file itself (out of ESLint's `files` glob for this override)
 * ever contains the literal string `lib/rules` in a way either rule's
 * `files` glob + pattern combination can see.
 *
 * `dependency-cruiser` closes this because it does not pattern-match
 * literal specifier strings -- it resolves the ACTUAL module graph (same
 * resolution `tsc`/`webpack` would do, including this repo's own
 * `@/*` -> `./*` tsconfig path alias) and can therefore express "no path
 * exists from lib/analytics/** to lib/rules/**", transitively, through
 * any number of intermediate re-export files, not just a direct import.
 *
 * Run via `npm run check:import-boundaries` (see package.json). No CI
 * pipeline exists in this repo yet (no `.github/workflows`) -- same
 * "real mechanism available today, wired the moment CI exists" posture
 * eslint.config.mjs's own boundary comment already documents for the
 * ESLint half; this is not a new exception to that reasoning, it is the
 * other tool completing the same one.
 *
 * Pinned to dependency-cruiser@16.10.4 (not the current 18.2.0 latest)
 * because 17.x/18.x require Node >=20.12/^22 (they import `node:util`'s
 * `styleText`, unavailable on this repo's pinned Node 20.11.0 -- same
 * root cause, same fix shape, as the existing vitest 3.2.7 pin -- see
 * PROGRESS.md's Infra-gaps "Node version is 20.11.0" entry). Revisit
 * this pin at the same time as that one, when Node is upgraded.
 */
module.exports = {
  forbidden: [
    {
      name: 'analytics-cannot-reach-rules',
      comment:
        'Module 05 (Analytics & Findings) may never import Module 04 (Rulebook) code, directly OR transitively through any re-export indirection -- AGENTS.md non-negotiable: "Analytics code cannot import rule code." See docs/adr/0021.',
      severity: 'error',
      from: { path: '^lib/analytics' },
      to: { path: '^lib/rules', reachable: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
