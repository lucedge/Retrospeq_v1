/**
 * Module 03 (Field Registry & Strategy) §4.7's hedge-word detector,
 * extracted out of `trigger-conditions-repository.ts` (which owns the real
 * `trigger_conditions` INSERT and therefore carries `import 'server-only'`)
 * so this ONE pure, DB-free check can be imported directly by a CLIENT
 * component too — the strategy-builder UI (this slice) wants to show the
 * exact same advisory hint live, as the trader types, not only after a
 * round trip to `createTriggerCondition`. Mirrors this repo's own
 * established "pure validation lives in a `server-only`-free file, the
 * repository that writes to Postgres imports it" split
 * (`strategy-validation.ts` / `strategy-repository.ts`,
 * `field-validation.ts` / `fields-repository.ts`) — this is the same
 * pattern applied one file later than it should have been the first time,
 * not a new convention.
 *
 * `trigger-conditions-repository.ts` re-exports `detectHedgeWords` from
 * here unchanged, so every existing import of it (including
 * `trigger-conditions-repository.test.ts`) keeps working without
 * modification — this is a pure extraction, no behaviour change.
 */

/**
 * §4.7's own worked-examples table names four hedge words verbatim inside
 * its reference markup's advisory hint ("good", "strong", "clean",
 * "looks" — §5.2's `<li class="condition" data-hedge="true">... Setup looks
 * clean ...`). Those four are SPEC-MANDATED, not a guess. The remainder
 * below is a documented, deliberate EXTENSION in the same spirit — common
 * hedging/vagueness language a trigger condition should avoid per §4.7's
 * own unambiguity standard ("two traders looking at the same chart would
 * give the same yes or no") — not silently invented as if the spec listed
 * them. Every entry is a single word or a short fixed phrase, matched
 * case-insensitively on a word boundary (`kind of`/`sort of` as two-word
 * phrases, everything else as single words) so this never flags a
 * substring inside an unrelated word (e.g. "strongly" is not "strong" by
 * word-boundary matching, though it arguably should also be flagged — kept
 * simple and precise over clever, matching this repo's own "advisory only,
 * never a false rejection" posture for a check that can never block save).
 */
const SPEC_MANDATED_HEDGE_WORDS = ['good', 'strong', 'clean', 'looks'] as const;
const EXTENDED_HEDGE_WORDS = [
  'usually',
  'sometimes',
  'maybe',
  'probably',
  'generally',
  'typically',
  'pretty',
  'feels',
  'seems',
  'kind of',
  'sort of',
] as const;
const HEDGE_WORDS: readonly string[] = [...SPEC_MANDATED_HEDGE_WORDS, ...EXTENDED_HEDGE_WORDS];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * §4.7: "What the system CAN do is flag conditions containing hedge words
 * ... with a gentle suggestion, non-blocking." Pure, DB-free, and NEVER
 * throws — callers surface the returned list as an advisory hint (§5.2's
 * own reference markup: `<p class="hint hint--advisory">`), never a
 * rejection. Returns the matched hedge words/phrases in the order §4.7's
 * own list is declared above (spec-mandated four first), deduplicated, in
 * lowercase — empty array means "nothing flagged," the overwhelmingly
 * common case for an unambiguous condition.
 */
export function detectHedgeWords(text: string): string[] {
  const found: string[] = [];
  for (const word of HEDGE_WORDS) {
    const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    if (pattern.test(text)) {
      found.push(word);
    }
  }
  return found;
}
