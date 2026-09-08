/**
 * Module 03 (Field Registry & Strategy) Slice 03c — field CREATION
 * validation, pure and DB-free, mirroring `strategy-validation.ts`'s own
 * separation exactly: this file knows nothing about Postgres,
 * `withUserConnection`, or entitlements; `fields-repository.ts` is the one
 * place that fetches real rows and wires this pipeline into an actual
 * write. No `server-only` import here for the same reason
 * `strategy-validation.ts` omits one — importable from a future
 * field-editor client component too.
 *
 * Two independent checks live here:
 *
 *   1. §4.1's "pruning rule" — refusing a proposed field that duplicates
 *      one of the 9 seeded `drv.*` derived fields (§3.2).
 *   2. §4.3's per-`data_type` `config` shape validation.
 *
 * Both are read-only functions of their inputs — no field id generation,
 * no DB writes, no entitlement checks. Those live in `fields-repository.ts`.
 */

import type { FieldDataType } from './strategy-validation';

// ---------------------------------------------------------------------
// §4.1 — the pruning rule
// ---------------------------------------------------------------------

/**
 * §4.1, verbatim: "At field creation, the system checks whether the
 * proposed field duplicates a derived one and refuses with an
 * explanation... This is a real guard, not guidance text: traders will
 * otherwise recreate Session, Direction and Day of Week by hand, and then
 * have two incomparable versions of each."
 *
 * **THE JUDGMENT CALL THIS DISPATCH LEFT OPEN — what "duplicates a
 * derived one" means operationally, and why:**
 *
 * The obvious-but-wrong approach is an exact-string match against each
 * derived field's own display NAME ("Session", "Day of week", ...) — a
 * trader who names their own field "Time of Day" instead of "Session"
 * would sail straight past that check and recreate the exact concept
 * §4.1 exists to prevent, since the whole point of the guard is that
 * traders DON'T reliably reach for the system's own vocabulary.
 *
 * The chosen approach instead: a small, CURATED per-derived-field list of
 * known duplicate-name VARIANTS (below), matched against the proposed
 * name after normalization (lowercase, Unicode-diacritic-folded,
 * punctuation collapsed to whitespace, whitespace collapsed and trimmed —
 * so "Session", "session", "SESSION!", and "Session " all normalize
 * identically). This is deliberately NOT:
 *
 *   - A full NLP/embedding-similarity system. With exactly 9 catalogue
 *     entries (§3.2) and a slow-growing, hand-reviewable list, a curated
 *     variant list is proportionate; a real semantic-similarity model
 *     would be solving a problem two orders of magnitude bigger than the
 *     one that actually exists here, for a marginal recall improvement
 *     on names this list doesn't already anticipate.
 *   - A `data_type` match. `data_type` alone is a weak signal (many
 *     unrelated `pick_one` fields exist) and, combined with name
 *     matching, would only ever NARROW the match set — since the goal is
 *     to catch traders recreating a derived CONCEPT under a different
 *     name, over-restricting on an incidental attribute like the type
 *     they happened to pick works against that goal, not for it. The
 *     name-variant list alone is the real signal; `data_type` is not
 *     consulted at all.
 *
 * This is an intentionally conservative (recall-biased-but-bounded, not
 * exhaustive) heuristic: it will not catch every possible rephrasing a
 * trader could invent, but it does catch the specific, named examples §4.1
 * itself calls out ("Session, Direction and Day of Week") plus a handful
 * of the most predictable synonyms for the other six catalogue entries.
 * A future slice with real product usage data (which names actually slip
 * past this list in practice) is the right place to grow it further — not
 * a reason to withhold it now. Every variant list below is a plain,
 * reviewable array; extending it is a one-line change, not a redesign.
 */
interface DerivedFieldDuplicateCatalogueEntry {
  fieldId: string;
  /** The derived field's own display name (`fields.name` for this
   *  catalogue entry, §3.2's own table) — always included as an implicit
   *  variant, so `variants` below only needs to list ADDITIONAL synonyms. */
  canonicalName: string;
  /** §4.1's own worked example: "Session is already recorded
   *  automatically from your entry time -- it will appear in your edge
   *  report without you filling anything in." Every entry below matches
   *  that exact sentence shape for its own field, substituting the
   *  concept name and (where the derived field's own source differs from
   *  a timestamp) the actual source. */
  explanation: string;
  /** Additional known duplicate-name variants beyond `canonicalName`
   *  itself — hand-curated, see this file's own header for the reasoning. */
  variants: string[];
}

const DERIVED_FIELD_DUPLICATE_CATALOGUE: readonly DerivedFieldDuplicateCatalogueEntry[] = [
  {
    fieldId: 'drv.session',
    canonicalName: 'Session',
    explanation:
      'Session is already recorded automatically from your entry time -- it will appear in your edge report without you filling anything in.',
    // 'trade session' is listed explicitly (not just 'trading session') --
    // see this file's own "normalization gap" note below: 'trade' vs
    // 'trading' is a derivational/morphological difference, not a plural
    // or a word-order swap, so the token-sort + plural-strip normalization
    // below does not close it on its own.
    variants: ['time of day', 'trading session', 'market session', 'session time', 'trade session'],
  },
  {
    fieldId: 'drv.day_of_week',
    canonicalName: 'Day of week',
    explanation:
      'Day of week is already recorded automatically from your entry time -- it will appear in your edge report without you filling anything in.',
    variants: ['day', 'weekday', 'dow', 'which day'],
  },
  {
    fieldId: 'drv.direction',
    canonicalName: 'Direction',
    explanation:
      'Direction is already recorded automatically from your first entry fill -- it will appear in your edge report without you filling anything in.',
    variants: ['long or short', 'long/short', 'trade direction', 'side', 'buy or sell'],
  },
  {
    fieldId: 'drv.order_type',
    canonicalName: 'Order type',
    explanation:
      'Order type is already recorded automatically from your broker order record -- it will appear in your edge report without you filling anything in.',
    variants: ['entry type', 'order kind', 'entry order type'],
  },
  {
    fieldId: 'drv.risk_pct',
    canonicalName: 'Risk %',
    explanation:
      'Risk % is already recorded automatically from your trade\'s own numbers -- it will appear in your edge report without you filling anything in.',
    variants: ['risk', 'risk percent', 'risk percentage', 'position risk', 'percent risk', 'risk per trade'],
  },
  {
    fieldId: 'drv.planned_rr',
    canonicalName: 'Planned R:R',
    explanation:
      'Planned R:R is already prefilled automatically from your entry, stop and target -- it will appear in your edge report without you filling anything in from scratch.',
    // 'r:r ratio' is listed explicitly alongside 'r:r' -- appending
    // 'ratio' is a word-INSERTION, not a reordering/pluralization of an
    // existing token, so the normalization pipeline below (which only
    // reorders and de-pluralizes existing tokens, never adds/drops one)
    // does not close it on its own.
    variants: ['planned rr', 'r:r', 'r:r ratio', 'risk reward', 'risk to reward', 'risk reward ratio', 'planned risk reward'],
  },
  {
    fieldId: 'drv.hold_seconds',
    canonicalName: 'Hold time',
    explanation:
      'Hold time is already recorded automatically from your entry and exit fills -- it will appear in your edge report without you filling anything in.',
    variants: ['duration', 'trade duration', 'time in trade', 'hold duration', 'holding period'],
  },
  {
    fieldId: 'drv.instrument',
    canonicalName: 'Instrument',
    explanation:
      'Instrument is already recorded automatically from your fill -- it will appear in your edge report without you filling anything in.',
    variants: ['symbol', 'pair', 'ticker', 'market'],
  },
  {
    fieldId: 'drv.news_nearby',
    canonicalName: 'News nearby',
    explanation:
      'News nearby is already prefilled automatically from the economic calendar -- it will appear in your edge report without you filling anything in from scratch.',
    variants: ['news', 'near news', 'economic news', 'news event nearby'],
  },
];

function normalizeFieldName(name: string): string {
  // NFKD decomposes accented letters into base letter + combining mark;
  // the combining marks themselves are Unicode category Mn (Mark,
  // nonspacing) which `\p{L}`/`\p{N}` already excludes, so the very same
  // `[^\p{L}\p{N}]+` collapse below both strips punctuation/whitespace
  // AND folds diacritics in one pass -- no separate combining-mark regex
  // needed (and safer than hand-typing a literal Unicode combining-range
  // in source).
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // any run of non-letter/non-digit -> one space
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * §4.1 pruning-rule follow-up (found by independent tester verification,
 * 2026-09-04 -- see PROGRESS.md decision log for that date, "Module 03
 * Slice 03c"): the original exact-normalized-string lookup above had ZERO
 * tolerance for word-order reordering or pluralization, even against its
 * OWN curated entries or a derived field's own canonical name -- e.g.
 * "Days of week" (a plain plural of the canonical "Day of week") and
 * "Type of order" (a plain word-order swap of the canonical "Order type")
 * both slipped straight past it. `normalizeForMatch` below closes that
 * narrow class, deliberately bounded to two cheap, explainable steps
 * (NOT a general fuzzy-matching/NLP layer -- see this file's own header
 * for why that's out of scope):
 *
 *   1. **Stopword-strip.** A tiny, fixed set of semantically-empty
 *      connector words (`of`, `the`) is removed from the token list
 *      BEFORE sorting -- this is what makes "Type of order" and
 *      "Order type" compare equal (both reduce to the token set
 *      {order, type}) despite "of" only appearing in one phrasing.
 *      Guarded so a name that normalizes to ONLY stopwords (e.g. the
 *      literal string "of") never collapses to an empty key -- the
 *      original, unfiltered token list is kept in that edge case.
 *   2. **Token-sort.** The (now stopword-stripped) tokens are sorted
 *      alphabetically and rejoined -- this is what makes "Type of
 *      order" and "Order type" compare equal to EACH OTHER once both
 *      reduce to the same token set, regardless of which word came
 *      first in either phrasing.
 *   3. **Conservative plural-strip**, applied per token, BEFORE sorting:
 *      a trailing "s" is removed only when (a) the token is longer than
 *      3 characters and (b) it does not end in "ss" (so a genuine
 *      double-s word like "loss" is never mangled into "los"). This is
 *      what makes "Days of week" reduce to the same token set as the
 *      canonical "Day of week" ("days" -> "day").
 *
 * This pipeline is applied identically to BOTH sides of every comparison
 * -- every curated canonical name/variant (when `NORMALIZED_DUPLICATE_
 * LOOKUP` below is built) and every incoming proposed name (in
 * `checkPruningRule`) -- so the fix closes the gap symmetrically, not
 * just for one direction.
 *
 * Deliberately NOT covered by this pipeline, left as documented,
 * out-of-scope gaps (per the follow-up's own scoping -- these are
 * genuinely novel rephrasings/synonyms, not reordering or pluralization,
 * and belong in a future curated-list growth pass, not a normalization
 * rule): word-insertion/omission ("Buy/Sell" missing "or" from the
 * curated "buy or sell"), synonym substitution ("Trade length" for the
 * curated "trade duration"), and derivational/morphological variants
 * that are not plain plurals ("Trade session" for the curated "trading
 * session" -- "trade" vs "trading" is a verb-form difference, not a
 * plural). The two clearest examples of the latter two categories that
 * this specific follow-up DID want closed ("Trade session" and "R:R
 * Ratio") are instead closed the cheap, existing way this file's own
 * header already establishes -- one extra curated variant string each
 * (`'trade session'` on `drv.session`, `'r:r ratio'` on
 * `drv.planned_rr`, both above) -- rather than stretching this
 * normalization pipeline with a third, riskier rule (e.g. suffix
 * stemming) that could introduce false positives elsewhere in the
 * catalogue.
 */
const FIELD_NAME_MATCH_STOPWORDS: ReadonlySet<string> = new Set(['of', 'the']);

function stripPluralToken(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Exported (Slice 03e, field PROMOTION, §4.5's own "Offer it proactively
 * when a second strategy is created with a similarly named field" /
 * §6.1's own flow diagram) so `fields-repository.ts`'s
 * `findPromotionCandidates` can answer the SAME "is this basically the
 * same field" question this file already answers for the pruning rule,
 * rather than inventing a second, divergent similarity heuristic — this
 * slice's own dispatch instruction, verbatim: "consistency matters here
 * since both are answering a 'is this basically the same field' question."
 * Was previously module-private; behaviour is completely unchanged by
 * exporting it, only its visibility.
 */
export function normalizeForMatch(name: string): string {
  const tokens = normalizeFieldName(name).split(' ').filter(Boolean);
  const withoutStopwords = tokens.filter((t) => !FIELD_NAME_MATCH_STOPWORDS.has(t));
  // Guard: if every token WAS a stopword (e.g. the literal input "of"),
  // filtering would leave an empty key that could wrongly collide with
  // other all-stopword inputs -- fall back to the unfiltered tokens.
  const meaningfulTokens = withoutStopwords.length > 0 ? withoutStopwords : tokens;
  return meaningfulTokens
    .map(stripPluralToken)
    .sort()
    .join(' ');
}

/** Built once at module load — every canonical name and every curated
 *  variant, normalized (see `normalizeForMatch` above), mapped back to
 *  its catalogue entry. */
const NORMALIZED_DUPLICATE_LOOKUP: ReadonlyMap<string, DerivedFieldDuplicateCatalogueEntry> = (() => {
  const map = new Map<string, DerivedFieldDuplicateCatalogueEntry>();
  for (const entry of DERIVED_FIELD_DUPLICATE_CATALOGUE) {
    map.set(normalizeForMatch(entry.canonicalName), entry);
    for (const variant of entry.variants) {
      map.set(normalizeForMatch(variant), entry);
    }
  }
  return map;
})();

/** §9: `FIELD_DUPLICATES_DERIVED` — "Recreating Session, Direction etc. |
 *  Refuse; explain it is already recorded." */
export class FieldDuplicatesDerivedError extends Error {
  readonly code = 'FIELD_DUPLICATES_DERIVED' as const;
  constructor(
    readonly proposedName: string,
    readonly derivedFieldId: string,
    readonly explanation: string,
  ) {
    super(explanation);
    this.name = 'FieldDuplicatesDerivedError';
  }
}

/**
 * §4.1's pruning-rule check. Throws `FieldDuplicatesDerivedError` (with
 * §4.1's own worked-example message pattern, substituted for whichever
 * derived field actually matched) when `proposedName` normalizes to a
 * known duplicate of one of the 9 `drv.*` fields; otherwise returns
 * silently. See this file's own header for the full matching-approach
 * reasoning.
 */
export function checkPruningRule(proposedName: string): void {
  const match = NORMALIZED_DUPLICATE_LOOKUP.get(normalizeForMatch(proposedName));
  if (match) {
    throw new FieldDuplicatesDerivedError(proposedName, match.fieldId, match.explanation);
  }
}

// ---------------------------------------------------------------------
// §4.3 — field type / config shape validation
// ---------------------------------------------------------------------

export interface ProposedFieldConfig {
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

/**
 * Not one of §9's own named error codes (that table is about
 * product-facing AUTHORING failures like duplicating a derived field or a
 * bad capture moment) — this plays the same "should be structurally
 * impossible by the time a real field-editor UI is in front of it"
 * defensive role `strategy-validation.ts`'s own `FieldNotFoundError`/
 * `InvalidCaptureMomentError` play: a malformed `config` for the given
 * `data_type` is a client-bug-shaped input, not a product decision a
 * trader is making, so it gets its own honest, generic code rather than
 * being force-fit into one of §9's table rows.
 */
export class FieldConfigInvalidError extends Error {
  readonly code = 'FIELD_CONFIG_INVALID' as const;
  constructor(
    readonly dataType: FieldDataType,
    readonly reason: string,
  ) {
    super(`Invalid config for data_type "${dataType}": ${reason}`);
    this.name = 'FieldConfigInvalidError';
  }
}

/**
 * §4.3's own type table, applied at write time:
 *
 *   | pick_one / pick_many | `options[]`                       |
 *   | number                | min, max, step, unit              |
 *   | bool                  | --                                 |
 *   | rating                | min, max (default 1-5)            |
 *   | note                  | --                                 |
 *
 * `pick_one`/`pick_many` REQUIRE a non-empty `options[]` of distinct,
 * non-blank strings -- a picker with zero or duplicate options is not a
 * real choice.
 *
 * `number` REQUIRES `min`/`max` (both finite numbers, `min < max` --
 * equal bounds would be a degenerate, unusable range) and `step` (a
 * finite positive number). Requiring bounds at CREATION time, not only
 * when a later strategy-save assigns `pre_entry` (`strategy-validation.ts`'s
 * own `validateCaptureMoments` re-checks boundedness there, independently,
 * for exactly that later moment-specific reason) is a deliberate choice:
 * an unbounded number field would still be legal to CAPTURE with any
 * later non-pre_entry moment, but §4.3's own table lists min/max/step/unit
 * as this type's config shape unconditionally, not conditionally on a
 * moment that doesn't exist yet at field-creation time -- and a bounded
 * number is always safe for `in_trade`/`at_add`/`at_trim`/`post_close`
 * too, so nothing is lost by requiring bounds up front. `unit` is
 * OPTIONAL (a plain descriptive label, not itself a correctness
 * constraint) but must be a non-blank string if supplied.
 *
 * `bool`/`note` take no config per §4.3's own table ("--") -- this
 * function does not reject EXTRA keys on either (permissive, matching
 * this repo's general "don't invent stricter rules than the spec states"
 * posture elsewhere), it simply never looks at `config` for these two
 * types.
 *
 * `rating` config is OPTIONAL -- §4.3: "min, max (default 1-5)". If
 * either is supplied, BOTH must be supplied (a partial override is
 * ambiguous -- which end did the caller mean to keep default?), both must
 * be integers (a rating scale is a whole-number scale), and `min < max`.
 * `createField` (fields-repository.ts) is the one that actually fills in
 * the `{min: 1, max: 5}` default when neither is supplied -- this
 * function only validates what IS supplied, it does not mutate/default
 * anything itself (pure, matching this file's own header).
 */
export function validateFieldConfig(dataType: FieldDataType, config: ProposedFieldConfig): void {
  switch (dataType) {
    case 'pick_one':
    case 'pick_many': {
      if (!config.options || config.options.length === 0) {
        throw new FieldConfigInvalidError(dataType, 'options[] must be a non-empty array.');
      }
      const trimmed = config.options.map((o) => o.trim());
      if (trimmed.some((o) => o.length === 0)) {
        throw new FieldConfigInvalidError(dataType, 'options[] entries must not be blank.');
      }
      if (new Set(trimmed).size !== trimmed.length) {
        throw new FieldConfigInvalidError(dataType, 'options[] entries must be distinct.');
      }
      return;
    }
    case 'number': {
      if (typeof config.min !== 'number' || !Number.isFinite(config.min)) {
        throw new FieldConfigInvalidError(dataType, 'min must be a finite number.');
      }
      if (typeof config.max !== 'number' || !Number.isFinite(config.max)) {
        throw new FieldConfigInvalidError(dataType, 'max must be a finite number.');
      }
      if (config.min >= config.max) {
        throw new FieldConfigInvalidError(dataType, `min (${config.min}) must be less than max (${config.max}).`);
      }
      if (typeof config.step !== 'number' || !Number.isFinite(config.step) || config.step <= 0) {
        throw new FieldConfigInvalidError(dataType, 'step must be a finite number greater than 0.');
      }
      if (config.unit !== undefined && config.unit.trim().length === 0) {
        throw new FieldConfigInvalidError(dataType, 'unit, if supplied, must not be blank.');
      }
      return;
    }
    case 'bool':
    case 'note':
      return;
    case 'rating': {
      const hasMin = config.min !== undefined;
      const hasMax = config.max !== undefined;
      if (!hasMin && !hasMax) return; // both omitted -- caller defaults to 1-5
      if (hasMin !== hasMax) {
        throw new FieldConfigInvalidError(dataType, 'min and max must both be supplied together, or both omitted for the 1-5 default.');
      }
      if (!Number.isInteger(config.min) || !Number.isInteger(config.max)) {
        throw new FieldConfigInvalidError(dataType, 'min and max must be whole numbers.');
      }
      if ((config.min as number) >= (config.max as number)) {
        throw new FieldConfigInvalidError(dataType, `min (${config.min}) must be less than max (${config.max}).`);
      }
      return;
    }
    default: {
      // Exhaustiveness guard -- every FieldDataType member is one of the
      // six cases above; a value reaching here came from outside the
      // type system (e.g. a raw client payload before Zod/type
      // validation ran upstream of this call), so fail loudly rather
      // than silently accepting an unrecognised type.
      const exhaustive: never = dataType;
      throw new FieldConfigInvalidError(exhaustive as FieldDataType, `unrecognised data_type "${String(exhaustive)}".`);
    }
  }
}
