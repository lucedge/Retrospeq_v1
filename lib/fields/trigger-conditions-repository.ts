import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { canForUser } from '@/lib/entitlements/service';
import { TRIGGER_TEXT_MAX_LENGTH, TRIGGER_SOFT_WARNING_THRESHOLD } from './strategy-validation';
import { StrategyEntitlementLimitError, StrategyNotEditableError, StrategyNotFoundError } from './strategy-repository';
import { detectHedgeWords } from './hedge-words';

/**
 * `detectHedgeWords` re-exported unchanged from `./hedge-words` (Module 03
 * strategy-builder UI slice, 2026-09-09) — extracted out of this file so a
 * CLIENT component can import the SAME pure check this repository's own
 * `createTriggerCondition` uses, for a live advisory hint as the trader
 * types, without pulling in this file's `server-only` write path. See
 * `hedge-words.ts`'s own header for the full reasoning. Every existing
 * import of `detectHedgeWords` from THIS file (including this file's own
 * sibling test, `trigger-conditions-repository.test.ts`) keeps working
 * unchanged — this re-export is the only thing that makes that true.
 */
export { detectHedgeWords };

/**
 * Module 03 (Field Registry & Strategy) §4.7 — trigger-condition
 * AUTHORING. The real write path into `retrospeq.trigger_conditions`
 * (Slice 03a's own table, `20260902010000_field_registry_schema.sql`) —
 * every prior Module 03 slice through 03e stayed entirely inside
 * `lib/fields/`; this is the first one that also touches Module 04
 * territory (`lib/rules/freeze-trigger-evaluations.ts`, a sibling file to
 * this one, not imported from here — see that file's own header for why
 * the AUTHORING/EVALUATION split lives across the two modules exactly the
 * way §1's own scope line draws it: "the trigger checklist UI (Module 03
 * authors it, this module evaluates it)").
 *
 * ## Why this is NOT a `rules`/`rule_versions` row — read before "fixing" it
 *
 * §4.7's own opening sentence ("by the boundary test it is a rule...
 * evaluated by Module 04") reads, on a first pass, like an instruction to
 * reuse Module 04's rule-authoring pipeline (`lib/rules/rules-repository.ts`'s
 * `insertRuleAndVersion`/`applyRuleEdit`, its tighten-only/satisfiability/
 * tier/entitlement validation chain). That reading does NOT survive reading
 * Module 04's own spec, specifically §5.2, verbatim: **"Machine-evaluated
 * only. Self-attested statements belong in Module 03 as trigger conditions.
 * This keeps hard adherence entirely derived from data the trader cannot
 * fudge."** A trigger condition is free text with no operand, no operator,
 * no threshold — there is nothing to tighten-only-validate, nothing to
 * satisfiability-check against other rules, no tier to gate. Module 04 §3.1
 * already ships a PURPOSE-BUILT, dedicated table for exactly this
 * (`trigger_evaluations` — `condition_id`, `result: met|unmet|unrecorded`,
 * no `severity`/`operand_id`/`op`/`value` at all), explicitly deferred by
 * Slice 1's own migration header pending this table existing. This file
 * writes to `trigger_conditions`; the freeze-time wiring that turns a
 * trader's self-attested answer into a frozen `trigger_evaluations` row
 * lives in `lib/rules/freeze-trigger-evaluations.ts`. See
 * docs/adr/0022-trigger-conditions-own-evaluation-table.md for the full
 * decision record — this is a genuine cross-module architectural call, not
 * an in-file judgment call, and is documented as one.
 *
 * ## Field-shape parity with `createField` (Slice 03c) — the pattern this
 * file deliberately mirrors
 *
 * A `trigger_conditions` row is created STANDALONE, for an already-existing
 * strategy, exactly the way `createField` creates a standalone `fields` row
 * for an already-existing (or, for `kind = 'account'`, no) strategy — NOT
 * inline as part of `createStrategy`/`editStrategy`'s own transaction. This
 * is forced by the schema itself (`trigger_conditions.strategy_id not null
 * references strategies(user_id, id)` — the strategy row must already
 * exist before a trigger condition can reference it), and matches
 * `strategy-repository.ts`'s own documented header exactly:
 * `ProposedTrigger.conditionId` is "client-supplied ... opaque to this
 * pipeline," meaning a caller creates the REAL `trigger_conditions` row
 * here FIRST (getting back a real `condition_id`), then passes that id
 * into `createStrategy`/`editStrategy`'s own `triggers[]` array so
 * `strategy_versions.triggers` can snapshot it. No change to
 * `strategy-repository.ts`/`strategy-validation.ts` was needed to wire this
 * up — that file's own `ProposedTrigger.conditionId` contract already
 * assumed exactly this calling convention.
 *
 * ## Entitlement — gated the SAME way `editStrategy` gates adding a
 * trigger condition through a strategy edit, not left unguarded
 *
 * §1: "the entire strategy module is Pro." A free user's silent,
 * auto-created default strategy (Module 08) must stay genuinely
 * uneditable, matching docs/adr/0018's own framing for `editStrategy`. If
 * `createTriggerCondition` did NOT check `strategy.create` entitlement
 * itself, a free user could add trigger conditions directly to their
 * default strategy (which they CAN legitimately read/reference, since it
 * is their own strategy) without ever going through `editStrategy`'s own
 * gate — a real bypass of the Pro paywall this file closes by checking the
 * identical capability, with NO default-strategy bypass (unlike
 * `createField`'s sibling entitlement gate on `fields.custom`, which this
 * function does NOT check separately — creating a trigger condition is
 * strategy-authoring, not field-authoring, so it is gated on
 * `strategy.create` alone, matching `editStrategy`'s own precedent exactly,
 * not both capabilities at once).
 */

export class TriggerTextInvalidError extends Error {
  readonly code = 'TRIGGER_TEXT_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Invalid trigger condition text: ${reason}`);
    this.name = 'TriggerTextInvalidError';
  }
}

function validateTriggerConditionText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new TriggerTextInvalidError('must not be empty.');
  }
  if (trimmed.length > TRIGGER_TEXT_MAX_LENGTH) {
    throw new TriggerTextInvalidError(`must be at most ${TRIGGER_TEXT_MAX_LENGTH} characters, got ${trimmed.length}.`);
  }
  return trimmed;
}

interface StrategyAuthRow {
  state: 'active' | 'archived';
}

/**
 * Confirms `strategyId` is a real, owned, EDITABLE strategy before this
 * file ever attempts a write — same "never trust a client-supplied foreign
 * key without an ownership check" defense-in-depth `fields-repository.ts`'s
 * `assertStrategyOwnedByUser` already establishes for field creation,
 * extended here with the SAME `state = 'active'` requirement
 * `editStrategy` itself enforces (`StrategyNotEditableError`) — adding a
 * trigger condition to an archived strategy makes no more sense than
 * editing one.
 */
async function assertStrategyEditable(userId: string, strategyId: string): Promise<void> {
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_SHAPE.test(strategyId)) {
    throw new StrategyNotFoundError(strategyId);
  }
  const row = await withUserConnection(userId, async (client) => {
    const res = await client.query<StrategyAuthRow>(
      `select state from retrospeq.strategies where id = $1 and user_id = $2`,
      [strategyId, userId],
    );
    return res.rows[0] ?? null;
  });
  if (!row) {
    throw new StrategyNotFoundError(strategyId);
  }
  if (row.state !== 'active') {
    throw new StrategyNotEditableError(strategyId, row.state);
  }
}

export interface CreateTriggerConditionInput {
  userId: string;
  strategyId: string;
  text: string;
  /** Caller-supplied display order, matching `ProposedTrigger.order`'s own
   *  caller-supplied convention (`strategy-validation.ts`) — this file does
   *  not infer or auto-increment it. */
  sortOrder: number;
}

export interface CreatedTriggerCondition {
  conditionId: string;
  strategyId: string;
  text: string;
  sortOrder: number;
  /** §4.7's non-blocking advisory — see `detectHedgeWords`'s own header.
   *  Empty when nothing was flagged. */
  hedgeWarnings: string[];
  /** §9: `TRIGGER_TOO_MANY` — true when this strategy now has MORE than 5
   *  active trigger conditions (including this new one). Non-blocking,
   *  informational only, matching `strategy-validation.ts`'s
   *  `TriggerEvaluation.triggerTooMany` shape exactly (this is the
   *  per-condition-creation-time equivalent of that same signal — a
   *  strategy built up one condition at a time via repeated calls to this
   *  function never sees `evaluateTriggers`'s own array-length check run
   *  against its true, currently-active count until a full strategy save,
   *  so this file re-derives it here from the real table instead). */
  tooManyWarning: boolean;
}

/**
 * §4.7's own flow: author a trigger condition for an existing, owned,
 * active, Pro-entitled strategy. Order of checks, same "cheap/pure before
 * expensive/DB" discipline every other Module 03 authoring function in
 * this repo already establishes:
 *
 *   1. Text shape (`TriggerTextInvalidError`) — pure, reuses
 *      `strategy-validation.ts`'s own `TRIGGER_TEXT_MAX_LENGTH` bound so
 *      there is exactly one 120-char limit, not two.
 *   2. Entitlement (`StrategyEntitlementLimitError`) — one DB read
 *      (`canForUser`), same capability `editStrategy` itself gates on, for
 *      the reason this file's own header explains ("closes a real bypass
 *      of the Pro paywall").
 *   3. Strategy exists, owned, active (`StrategyNotFoundError`/
 *      `StrategyNotEditableError`) — one DB read.
 *   4. Hedge-word detection (`detectHedgeWords`) — pure, NEVER blocking,
 *      computed before the write so it can be returned alongside the
 *      created row in one response.
 *   5. The write itself — one INSERT, RLS-enforced
 *      (`trigger_conditions_owner`, §3.1's owner "for all" policy,
 *      `20260902010000_field_registry_schema.sql`), followed by one COUNT
 *      to compute `tooManyWarning` against the real, current active-count
 *      for this strategy.
 */
export async function createTriggerCondition(input: CreateTriggerConditionInput): Promise<CreatedTriggerCondition> {
  const text = validateTriggerConditionText(input.text);

  const entitlement = await canForUser(input.userId, 'strategy.create');
  if (!entitlement.allowed) {
    throw new StrategyEntitlementLimitError(input.userId);
  }

  await assertStrategyEditable(input.userId, input.strategyId);

  const hedgeWarnings = detectHedgeWords(text);

  return withUserConnection(input.userId, async (client) => {
    const insertRes = await client.query<{ id: string }>(
      `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, sort_order)
       values ($1, $2, $3, $4)
       returning id`,
      [input.userId, input.strategyId, text, input.sortOrder],
    );
    const conditionId = insertRes.rows[0].id;

    const countRes = await client.query<{ n: string }>(
      `select count(*)::int as n
         from retrospeq.trigger_conditions
        where user_id = $1 and strategy_id = $2 and state = 'active'`,
      [input.userId, input.strategyId],
    );
    const activeCount = Number(countRes.rows[0]?.n ?? 0);

    return {
      conditionId,
      strategyId: input.strategyId,
      text,
      sortOrder: input.sortOrder,
      hedgeWarnings,
      tooManyWarning: activeCount > TRIGGER_SOFT_WARNING_THRESHOLD,
    };
  });
}
