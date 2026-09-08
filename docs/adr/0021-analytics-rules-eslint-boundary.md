# ADR 0021: the Module 04/05 isolation boundary is enforced by an ESLint import restriction, not a CI pipeline (yet)

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings) Slice 05a, 2026-09-08. **Updated 2026-09-08 (same day, coder
follow-up dispatch)** after an independent tester dispatch found three
real, empirically-confirmed bypass routes in the mechanism this ADR
originally described (see PROGRESS.md's 2026-09-08 tester entry, item 3,
for the original find). Two of the three are now closed; the third is a
structural limitation of any single-file syntactic lint rule and is
documented below as accepted residual risk, not silently left
unacknowledged. **Updated again 2026-09-08 (same day, second coder
follow-up)** after a further independent tester re-verification found the
first pass at closing bypass (a) was itself incomplete: it covered a
plain string literal (`import('@/lib/rules/...')`) but not a template
literal with zero substitutions (`` import(`@/lib/rules/...`) ``,
backticks used stylistically with no `${...}` interpolation) — this
document previously and incorrectly claimed that case was already
covered; it was not. A second, dedicated selector now closes it. See the
revised "(a) Dynamic `import()`" subsection below for the precise,
corrected before/after.

## Context

Module 05 §7.5, verbatim: "Assert this module's queries never touch
`rules`, `rule_versions`, `rule_evaluations` or `adherence_weekly`.
**Enforced by a static check on the module's data access layer, run in
CI.** If the edge engine can see adherence, findings become
uninterpretable." AGENTS.md's own non-negotiables list restates this
module-agnostically: "Analytics code cannot import rule code (enforce in
CI, not just review)."

Two constraints collide:

1. This repo has no GitHub Actions workflow (or any CI pipeline) at all
   — confirmed, no `.github/workflows` directory exists anywhere in the
   repo. "Enforced in CI" has nowhere to literally run today.
2. The boundary is genuinely load-bearing *now*, not just once CI
   exists — Module 05's own edge/detection engines are built across
   several future slices, and every one of them is a fresh opportunity
   for a well-meaning `import { fetchRuleRenderedText } from
   '@/lib/rules/rules-repository'` (or similar) to slip in, silently
   coupling a finding's computation to Module 04's own rule/adherence
   state. Once that coupling exists, per §7.5's own reasoning, findings
   become uninterpretable — this is not a lint nicety, it is a
   correctness property of what "finding" is even allowed to mean.

Per AGENTS.md's own repeated "build against the interfaces; flag the
gap, don't fake it" pattern (already applied elsewhere in this repo to
the missing Supabase project, the missing KMS account, and the missing
billing provider): the correct response to "the intended enforcement
mechanism doesn't exist yet" is not to skip enforcement, and not to
invent a fake CI pipeline — it is to build the REAL, available
mechanism that will keep working once CI does exist, without needing to
be re-architected then.

## Decision

Enforce the boundary today via ESLint rules, scoped (in
`eslint.config.mjs`, a flat-config `files`-scoped override) to every
file under `lib/analytics/**`, restricting any import that resolves
into `lib/rules/**` (Module 04's own code). This runs today via the
already-mandatory `eslint .` (`npm run lint`), which every slice in this
build already runs as part of its own "clean build/tsc/eslint"
verification bar — the enforcement is real and already gates every
commit that touches this repo locally, not speculative. It will run in
CI automatically, unchanged, the moment a CI pipeline exists (a separate,
already-tracked infra gap in PROGRESS.md) — `eslint .` in a GitHub
Actions step is the standard, zero-additional-design integration;
nothing about this rule itself needs to be rewritten when that day
comes.

**Originally (2026-09-08, first pass): a single `no-restricted-imports`
rule with a hardcoded `patterns.group` literal list** (`@/lib/rules`,
`@/lib/rules/**`, `../rules`, `../rules/**`, `../../rules`,
`../../rules/**`, `../../../rules`, `../../../rules/**` — i.e. absolute
plus exactly 3 levels of relative nesting). An independent tester
dispatch the same day found three real bypasses this shape has
(detailed in the "Three empirically-confirmed bypasses" section below).
Two are now fixed (as of this same-day coder follow-up); the third is
accepted, documented residual risk.

### Three empirically-confirmed bypasses, and their disposition

**(a) Dynamic `import()` — FIXED.** `no-restricted-imports`, verified
directly against the installed `eslint@9.39.5` rule source
(`node_modules/eslint/lib/rules/no-restricted-imports.js`), only
registers visitors for `ImportDeclaration`, `ExportNamedDeclaration`,
`ExportAllDeclaration`, and `TSImportEqualsDeclaration` — never
`ImportExpression` (the AST node for a dynamic `import(...)` call). No
option on that rule changes this; it is a hardcoded limitation of the
rule's own `create()` function, not a config gap. A file under
`lib/analytics/**` containing `await import('@/lib/rules/operand-
catalogue')` therefore produced zero ESLint output under the original
config.

Fixed by adding a second rule, `no-restricted-syntax`, configured with
an esquery AST selector (`ImportExpression[source.value=/^(@\/lib\/
rules(\/.*)?|(\.\.\/)+rules(\/.*)?)$/]`) that matches an
`ImportExpression` node whose argument is a plain string `Literal`
matching the boundary pattern. Verified against the installed
`esquery@1.7.0` that regex attribute matching (`[attr=/pattern/]`) is
supported syntax before relying on it.

**Correction (2026-09-08, second follow-up):** this document originally
stated, incorrectly, that the selector above also covered "a template
literal with no substitutions," on the theory that esquery's `.value`
attribute lookup simply wouldn't resolve for a genuinely dynamic
specifier. That reasoning was wrong about *why* it wouldn't resolve, and
wrong about the practical consequence. An independent tester dispatch
found the actual behavior empirically: `await import(\`@/lib/rules/
operand-catalogue\`)` — an ordinary backtick string used stylistically
instead of quotes, with ZERO `${...}` interpolations — produced **zero**
ESLint output, confirmed via a direct espree AST dump that a
`TemplateLiteral` node has **no `.value` property at all** (only
`Literal` nodes do). The selector above doesn't skip this case on
purpose — it structurally cannot match it, for any content, quasi-only
or not, because it is testing an attribute path
(`source.value`) that a `TemplateLiteral` node never has. This was a
real, silent gap, not a documented-and-accepted one; it looked closed
because the bypass a tester happened to try first (a plain string) was
in fact covered, and no one had tried the backtick-no-substitution shape
until the follow-up re-verification.

Fixed properly by adding a **second, separate `no-restricted-syntax`
selector**, scoped specifically to `ImportExpression` nodes whose
`source` is a `TemplateLiteral` with `expressions.length === 0` (i.e.
quasi-only — no real interpolation, so its full string content is
statically known at lint time):

```
ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=/^(@\/lib\/rules(\/.*)?|(\.\.\/)+rules(\/.*)?)$/]
```

A zero-expression `TemplateLiteral` always has exactly one `quasis`
entry, and that quasi's static string content lives at
`quasis[0].value.cooked` — this is what the selector reads and matches
against the **same** boundary regex used everywhere else in this
config, so the three mechanisms (`no-restricted-imports`'s `regex`
option, the plain-`Literal` `no-restricted-syntax` selector, and this
new quasi-only-`TemplateLiteral` selector) cannot drift apart into
divergent patterns over time.

This closes the quasi-only template-literal shape of the bypass, but —
now stated precisely, not just gestured at — it still cannot and does
not follow a specifier built from a runtime variable, string
concatenation, or a template literal that genuinely interpolates a
variable (`import(someVariable)`, `` import(`@/lib/rules/${x}`) ``): a
`TemplateLiteral` with `expressions.length > 0` has no single statically
known string value (its `quasis` are only the literal fragments *around*
the interpolation, not the resolved runtime value), so there is nothing
for any static-analysis regex to match against — no static tool can
close this without also tracking dataflow, which is out of scope for a
lint rule and is not claimed to be in scope here. This residual sliver
(the WITH-substitution case specifically, not the quasi-only case) is
accepted as inherent to any static import-boundary check, not specific
to this repo's implementation.

**(c) Relative import deeper than the hardcoded depth list — FIXED.**
The original `patterns.group` list was a fixed, literal enumeration
capped at 3 levels of `../`. A file nested a 4th level deep (or more)
under `lib/analytics/**` importing via `../../../../rules/...` produced
zero output, despite correctly resolving to `lib/rules/`.

Fixed by replacing the literal list with a single `patterns[].regex`
entry — `^(@/lib/rules(/.*)?|(\.\./)+rules(/.*)?)$` — verified
supported by the installed `eslint@9.39.5`'s `no-restricted-imports`
schema (`patterns[].regex`, a `string` compiled to a `RegExp`, mutually
exclusive with `patterns[].group` per the rule's own JSON schema
`oneOf`). The `(\.\./)+` quantifier matches any number of `../`
segments, so this is depth-agnostic by construction rather than
depending on a maintained enumeration that silently stops working past
whatever depth someone happened to hardcode.

Both fixes verified two ways before being accepted: (1) a standalone
Node script running the real ESLint `Linter` API against synthetic
source strings for each case (absolute, several relative depths, and a
genuinely unrelated import as a negative control) before touching the
real config, and (2) real throwaway fixture files written into
`lib/analytics/**` (a dynamic-import file, and a file nested 4 relative
levels deep re-using the real, already-existing `lib/analytics/
shadow-harness/__tests__/` nesting as a template for a genuinely
plausible deeper path), linted via `npx eslint`, confirmed to trip the
expected rule, then deleted with `git status` confirmed clean
afterward. Regression-tested permanently in
`lib/analytics/__tests__/eslint-boundary.test.ts` (new cases added
2026-09-08), which also re-confirms the existing 4 original test cases
(absolute, 2-level relative, negative control, and the negative control
against this slice's own real production files) still pass under the
new config.

**(b) Re-export indirection through a file outside `lib/analytics/**`
— NOT FIXED. Accepted, documented residual risk.** A file OUTSIDE
`lib/analytics/**` (so never covered by this override's own `files`
glob) that does `export { getOperand } from '@/lib/rules/operand-
catalogue'`, followed by a file INSIDE `lib/analytics/**` importing
from that intermediate file instead of `lib/rules` directly, produces
zero output from either `no-restricted-imports` or
`no-restricted-syntax` — neither rule, nor any single-file syntactic
ESLint rule, can close this, because doing so requires following the
import graph across files (does the module this file imports from,
transitively, ever resolve into `lib/rules/**`?), which is categorically
different work from "does this one file's own import specifier
literally match a pattern."

A real fix exists and was evaluated: `dependency-cruiser`, which
performs actual module-graph resolution and explicitly supports
transitive/indirect forbidden-dependency rules (its README's own
canonical example is almost exactly this shape — "module A must not
depend, even transitively, on module B"). It is **not currently a
dependency of this repo** (confirmed via
`node -e "require.resolve('dependency-cruiser')"` throwing). Adding
it was evaluated and deliberately deferred in this same-day follow-up
dispatch rather than added, for two concrete reasons rather than general
caution:

1. This repo's own already-documented, currently-open infra fragility
   (`C:` drive at 0 bytes free; `npm`/`vitest`/`playwright` all already
   require explicit `TEMP`/`TMP`/cache-path overrides to avoid `ENOSPC`,
   per PROGRESS.md's Infra gaps list) makes an unreviewed `npm install`
   of a new dependency and its own transitive tree a real, not
   hypothetical, risk of tripping the identical failure mode this repo
   has already hit twice for unrelated tools.
2. Doing this properly is more than adding the package: it needs its own
   scoped config (a `.dependency-cruiser.{js,cjs}` rule restricting
   `lib/analytics/**` from transitively reaching `lib/rules/**`), a new
   `npm run check:boundaries` (or folded into `npm run lint`) script,
   and its own verification pass (a real cross-file re-export fixture,
   proving the tool catches the exact shape this ADR names) — a
   self-contained but real scope addition, not a one-line change, and
   this follow-up dispatch's brief scoped it as "defer if adding a new
   dependency is out of scope/risky without npm install confirmation,"
   which this is.

This gap is **not silently left undiscovered** in the interim: a
canary test, `'KNOWN RESIDUAL RISK (b), documented not fixed...'` in
`lib/analytics/__tests__/eslint-boundary.test.ts`, builds the exact
re-export-indirection fixture shape described above and asserts the
bypass still succeeds (zero lint output) — i.e. it is a test that is
expected to keep passing while this gap is open, and is meant to be
read/updated together with this ADR section the day someone actually
closes it (a passing canary here is "gap still open as documented," not
"nothing to see"). Recommended next step, whenever picked up: add
`dependency-cruiser` (or equivalent import-graph-aware tooling) scoped
narrowly to this one boundary, in a dispatch that has room to budget
for the `npm install` risk and the config/script work above.

A second boundary was considered and deliberately NOT added: restricting
`lib/analytics/**` from importing `lib/ingestion/**` (Module 02). §1's
own sentence pairs two separate claims — "this module never reads rules
and never reads adherence... The edge engine ignores rules; **the
adherence engine (Module 04) ignores P&L**." The second clause describes
a constraint on MODULE 04's OWN adherence engine (it must not read P&L
data), not a constraint on Module 05. Module 05 §10 names Module 02 as a
real, required dependency ("Module 02 (confirmed trades, events,
captures, arm events)") — the edge engine's entire input is trade
outcome/R-multiple data from `lib/ingestion`, so a blanket
`lib/analytics -> lib/ingestion` import ban would make the module
unbuildable, not safer. If a future slice wants to encode "Module 04
must not read P&L" as a checkable rule, that is a Module-04-scoped
ESLint override (`files: ['lib/rules/**']`, restricting imports of
P&L-bearing `lib/ingestion` exports specifically) — a different rule,
owned by whichever future slice touches Module 04's own boundary, not
this one.

## Consequences

- `lib/analytics/__tests__/eslint-boundary.test.ts` proves both rules
  fire: it writes throwaway fixture files under `lib/analytics/`
  (an absolute `@/lib/rules/...` import, a relative import, a relative
  import nested 4 levels deep, a dynamic `import('@/lib/rules/...')`
  call with a plain string literal, and — added 2026-09-08, second
  follow-up — a dynamic `` import(`@/lib/rules/...`) `` call with a
  quasi-only template literal, plus a paired negative case for the
  WITH-substitution template-literal shape that remains, correctly, an
  open gap), runs ESLint's Node API against each, asserts the expected
  rule (`no-restricted-imports` or `no-restricted-syntax`) reports a
  violation, then deletes each fixture — no fixture ever persists in the
  repo tree, so a normal `eslint .` run is never left red by this test's
  own scaffolding. A further case builds the (b) re-export-indirection
  shape and asserts it is STILL a bypass (a canary for the documented
  residual risk, not a passing control). The same test also lints this
  slice's own real production files under `lib/analytics/` as a negative
  control, proving the rule does not produce a false positive against
  legitimate code.
- Every future Module 05 slice (the edge engine, the detection engine,
  the statistical gates) inherits this restriction automatically —
  nothing about adding new files under `lib/analytics/` requires
  re-registering them with the rule; the `files: ['lib/analytics/**']`
  glob already covers them.
- If a genuinely shared, rule-agnostic utility is needed by both
  modules (e.g. a sync-tier comparator), the fix is to extract it to a
  neutral location neither module "owns" in the Module 04/05 sense
  (this slice's own `lib/broker/sync-tier.ts` is the first instance —
  `lib/broker` is Module 01/02 territory, not Module 04's), never to
  carve an exception into this rule for a specific `lib/rules/` file.
- Once a real CI pipeline exists (tracked separately, PROGRESS.md "Infra
  gaps"), add `npm run lint` (already runs this rule) as a required
  check — no change to this rule itself is needed at that point.
