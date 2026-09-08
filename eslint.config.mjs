import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    // Vendored spec/reference material, not this project's own code -
    // see AGENTS.md "Source of truth" / "Working with the owner".
    "retrospeq-design-system/**",
    "module-docs-github/**",
    "reference/**",
  ]),
  // Module 04/05 isolation boundary -- AGENTS.md's own repo-wide
  // non-negotiable, verbatim: "Analytics code cannot import rule code
  // (enforce in CI, not just review)." Module 05 §7.5: "Assert this
  // module's queries never touch rules, rule_versions, rule_evaluations
  // or adherence_weekly. Enforced by a static check on the module's data
  // access layer, run in CI." No CI pipeline exists in this repo yet
  // (no `.github/workflows`) -- this ESLint rule is the REAL, available
  // mechanism today (`npm run lint` already runs on every slice) and
  // will run unchanged in CI the moment a pipeline exists. Full
  // reasoning, including why a symmetric `lib/analytics -> lib/ingestion`
  // restriction was deliberately NOT added, in
  // docs/adr/0021-analytics-rules-eslint-boundary.md.
  //
  // Two rules, not one -- `no-restricted-imports` (below) only inspects
  // static `ImportDeclaration`/`ExportNamedDeclaration`/
  // `ExportAllDeclaration`/`TSImportEqualsDeclaration` AST nodes (verified
  // directly against the installed eslint@9.39.5 rule source -- it does
  // NOT register an `ImportExpression` visitor at all), so a dynamic
  // `await import('@/lib/rules/...')` produces zero output from it no
  // matter how the `patterns` option is configured. `no-restricted-syntax`
  // (an esquery AST-selector rule, confirmed against the installed
  // esquery@1.7.0 to support regex attribute matching, e.g.
  // `[source.value=/pattern/]`) is the second, separate mechanism that
  // closes that gap -- via TWO selectors, not one: one matches a plain
  // string `Literal` argument, the other matches a quasi-only (zero
  // `${...}` substitutions) `TemplateLiteral` argument, because a
  // `TemplateLiteral` node has no `.value` property at all and so is
  // structurally invisible to the first selector no matter its content
  // (see docs/adr/0021's 2026-09-08 second-follow-up correction for the
  // gap this closed). A template literal WITH a real substitution
  // (`` import(`@/lib/rules/${x}`) ``) remains, correctly, out of reach
  // of either selector -- its specifier isn't known until runtime, so
  // there is nothing static to match. All rules/selectors share the same
  // depth-agnostic regex so a relative import at any nesting depth (not
  // just the previously-hardcoded 3 levels) is caught either way -- see
  // docs/adr/0021 for the full before/after, including the one bypass
  // (re-export indirection through a file outside `lib/analytics/**`)
  // that none of these rules can close, since all are single-file
  // syntactic checks, not import-graph analysis.
  {
    files: ["lib/analytics/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // A single depth-agnostic regex replaces the old hardcoded
              // `../rules` / `../../rules` / `../../../rules` literal
              // list (which silently stopped catching anything nested a
              // 4th level or deeper). `(\.\./)+` matches ANY number of
              // `../` segments, so this closes bypass (c) without needing
              // to guess a maximum nesting depth in advance.
              regex: "^(@/lib/rules(/.*)?|(\\.\\./)+rules(/.*)?)$",
              caseSensitive: true,
              message:
                "Module 05 (Analytics & Findings) may never import Module 04 (Rulebook) code -- AGENTS.md non-negotiable: \"Analytics code cannot import rule code.\" Module 05 spec §1: \"this module never reads rules ... The edge engine ignores rules.\" If both modules genuinely need the same value (e.g. a tier/sync comparison), extract a shared, rule-agnostic utility into neutral territory (see lib/broker/sync-tier.ts) instead of importing lib/rules directly -- see docs/adr/0021.",
            },
          ],
        },
      ],
      // Closes bypass (a): `no-restricted-imports` never sees dynamic
      // `import()` calls. This selector matches an `ImportExpression`
      // whose argument is a plain string literal matching the boundary
      // pattern. It does NOT match a template literal at all -- a
      // `TemplateLiteral` AST node has no `.value` property (only
      // `Literal` nodes do), so esquery's `source.value=/pattern/`
      // attribute lookup structurally never resolves for a template
      // literal, quasi-only or not. That is why a SECOND selector
      // (below) is required for the quasi-only template-literal case --
      // this one alone does not cover it, confirmed by an independent
      // tester dispatch finding `await import(\`@/lib/rules/operand-
      // catalogue\`)` (backticks, zero `${...}` substitutions) produced
      // zero output under this selector alone.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/^(@\\/lib\\/rules(\\/.*)?|(\\.\\.\\/)+rules(\\/.*)?)$/]",
          message:
            "Module 05 (Analytics & Findings) may never import Module 04 (Rulebook) code, including via a dynamic import() -- AGENTS.md non-negotiable: \"Analytics code cannot import rule code.\" See docs/adr/0021.",
        },
        {
          // Closes the quasi-only template-literal gap in the selector
          // above: `import(\`@/lib/rules/operand-catalogue\`)` -- an
          // ordinary backtick string used stylistically instead of
          // quotes, with ZERO `${...}` interpolations. Its full string
          // content is statically known at lint time (unlike a
          // genuinely dynamic template literal with a real
          // substitution), so it CAN be matched -- just not via
          // `.value` like a `Literal`. A `TemplateLiteral` with no
          // expressions has exactly one `quasis` entry, and that
          // quasi's static string content lives at
          // `quasis.0.value.cooked` (equivalently `.raw` here, since
          // the pattern has no escape sequences that would differ
          // between the two). `source.expressions.length=0` restricts
          // this selector to the quasi-only case specifically --
          // template literals WITH substitutions (e.g.
          // `import(\`@/lib/rules/${x}\`)`) have expressions.length > 0
          // and correctly do NOT match here, because their real,
          // runtime-resolved specifier is not statically known and no
          // static lint rule can match against it -- that residual gap
          // is inherent, not specific to this repo, and is not claimed
          // as closed. Same regex as the `Literal` selector above and
          // the `no-restricted-imports` pattern, so all three stay in
          // sync rather than drifting apart.
          selector:
            "ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=/^(@\\/lib\\/rules(\\/.*)?|(\\.\\.\\/)+rules(\\/.*)?)$/]",
          message:
            "Module 05 (Analytics & Findings) may never import Module 04 (Rulebook) code, including via a dynamic import() with a template-literal specifier -- AGENTS.md non-negotiable: \"Analytics code cannot import rule code.\" See docs/adr/0021.",
        },
      ],
    },
  },
]);

export default eslintConfig;
