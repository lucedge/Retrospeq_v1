import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §3.1 — Slice 8: the
 * `rule_overrides` DB access layer behind `app/(app)/rules/actions.ts`'s
 * `recordOverride`, plus the read side behind a future UI's override-
 * outcome narrative (§5.9's own worked example: "You've exceeded your risk
 * cap 12 times. Those trades averaged −0.4R against +0.3R for the rest.").
 *
 * `rule_overrides` already has real owner SELECT + INSERT RLS from Slice 1
 * (`supabase/migrations/20260823020000_rulebook_schema.sql`) — append-only,
 * no UPDATE/DELETE policy for any role (verified by that migration's own
 * live RLS test, `rulebook-schema.rls.test.ts`) — so every function here
 * runs under `withUserConnection`, matching `rules-repository.ts`'s/
 * `severity-lifecycle-repository.ts`'s established convention for a real,
 * live, client-driven user action (Slice 1's own PROGRESS.md note: "a live
 * user action," not Module 02's own trusted-backend `rule_evaluations`
 * write).
 *
 * ## `trade_id` nullability — confirmed against the schema, not assumed
 *
 * `rule_overrides.trade_id` is declared nullable with its own inline
 * comment: "an override can occur pre-entry, before any trade row exists
 * yet" (`20260823020000_rulebook_schema.sql`). This matches §7.1's own
 * flow diagram exactly: "entry fill → pre_entry + session rules evaluated
 * (provisional) → breach visible in ambient strip? → trader proceeds →
 * rule_overrides row written" happens BEFORE the trade this breach
 * eventually attaches to necessarily exists as a persisted row for every
 * case — a `session` rule (e.g. a daily-loss-cap breach visible on the
 * ambient strip mid-day, before the trader has even opened their next
 * trade) can be proceeded-past with no trade in flight at all. `tradeId`
 * is therefore genuinely optional here, not a defensive nullable that
 * happens to always be set in practice (contrast `cross-trade-operand-
 * values.ts`'s `excludeTradeId` self-exclusion, which IS always populated
 * in practice for its own callers).
 */

// ---------------------------------------------------------------------
// Reads used by recordOverride's own validation
// ---------------------------------------------------------------------

export interface RuleForOverride {
  ruleId: string;
  state: string;
  currentVersion: number;
  evaluation: 'pre_entry' | 'at_close' | 'session';
}

interface RuleForOverrideRow {
  rule_id: string;
  state: string;
  current_version: number;
  evaluation: 'pre_entry' | 'at_close' | 'session';
}

/** Ownership + current lifecycle/version/evaluation-timing facts —
 *  `null` when the rule doesn't exist or isn't owned by `userId`, matching
 *  `severity-lifecycle-repository.ts`'s `fetchRuleForLifecycle`'s own
 *  null-return convention (a Server Action's own `RULE_NOT_FOUND` handling
 *  shape, not a thrown error). */
export async function fetchRuleForOverride(userId: string, ruleId: string): Promise<RuleForOverride | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RuleForOverrideRow>(
      `select id as rule_id, state, current_version, evaluation
         from retrospeq.rules
        where id = $1 and user_id = $2`,
      [ruleId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ruleId: row.rule_id, state: row.state, currentVersion: row.current_version, evaluation: row.evaluation };
  });
}

// ---------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------

export class RuleOverrideTradeNotOwnedError extends Error {
  constructor(readonly tradeId: string) {
    super(`recordRuleOverride: trade ${tradeId} is not owned by the calling user -- refusing to insert a rule_overrides row citing it.`);
    this.name = 'RuleOverrideTradeNotOwnedError';
  }
}

export interface InsertRuleOverrideInput {
  userId: string;
  ruleId: string;
  ruleVersion: number;
  tradeId: string | null;
  /** The live fact that triggered the breach (e.g. the observed
   *  `daily_loss_pct` at the moment the trader proceeded) — NOT the
   *  rule's own threshold. Mirrors `rule_evaluations.observed`'s own
   *  "the operand value seen" semantics (§3.1), applied to a live,
   *  not-yet-frozen moment instead of a frozen evaluation row. */
  observed: unknown;
}

export interface InsertedRuleOverride {
  id: string;
  occurredAt: string;
}

/**
 * §5.9's "write a `rule_overrides` row" — one INSERT, append-only (no
 * UPDATE path exists anywhere in this file or the schema's own RLS).
 * `ruleVersion` is always the rule's CURRENT version at the moment of the
 * call (the caller — `recordOverride`, the Server Action — sources it from
 * `fetchRuleForOverride`'s own `currentVersion`, never a caller-supplied
 * value) — see this repo's dispatch note on why an override has no
 * "historical version" question the way `rule_evaluations` does: an
 * override is a live, present-tense action describing what the trader saw
 * AT THIS MOMENT, and "this moment" is always the current version by
 * definition (there is no analogue to freeze's "version live at a PAST
 * trade's opened_at" — the override IS happening now).
 *
 * `tradeId`, when non-null, is verified owned by `userId` BEFORE the
 * insert — defense in depth beyond RLS (see this file's own header):
 * `rule_overrides`' own RLS only constrains `user_id`, not the `trade_id`
 * foreign key's own ownership, so nothing would otherwise stop a caller
 * from citing an arbitrary (including another user's) `trade_id` as the FK
 * target of their own override row. Matches `rules-repository.ts`'s own
 * "two independent redundant checks" posture (its own header comment on
 * `fetchCurrentRuleForEdit`'s `WHERE user_id = $2` alongside real RLS).
 */
export async function insertRuleOverride(input: InsertRuleOverrideInput): Promise<InsertedRuleOverride> {
  return withUserConnection(input.userId, async (client) => {
    if (input.tradeId !== null) {
      const owned = await client.query('select 1 from retrospeq.trades where id = $1 and user_id = $2', [
        input.tradeId,
        input.userId,
      ]);
      if ((owned.rowCount ?? 0) !== 1) {
        throw new RuleOverrideTradeNotOwnedError(input.tradeId);
      }
    }

    const res = await client.query<{ id: string; occurred_at: string }>(
      `insert into retrospeq.rule_overrides (user_id, trade_id, rule_id, rule_version, observed)
       values ($1, $2, $3, $4, $5::jsonb)
       returning id, occurred_at::text as occurred_at`,
      [input.userId, input.tradeId, input.ruleId, input.ruleVersion, JSON.stringify(input.observed)],
    );
    const row = res.rows[0];
    return { id: row.id, occurredAt: row.occurred_at };
  });
}

// ---------------------------------------------------------------------
// The override-outcome narrative read — §5.9's worked example
// ---------------------------------------------------------------------

export interface RuleOverrideOutcomeSummary {
  ruleId: string;
  /** Total override EVENTS for this rule (§5.9's "12 times") — every
   *  `rule_overrides` row, whether or not it carries a `trade_id`. */
  overrideCount: number;
  /** How many DISTINCT confirmed trades those overrides ultimately
   *  attached to and have a frozen `r_multiple` to average — always
   *  `<= overrideCount` (an override with no trade, or whose trade never
   *  confirmed / has no `r_multiple` yet, contributes to `overrideCount`
   *  but not here). */
  overriddenTradeCount: number;
  /** `null` when `overriddenTradeCount === 0` — "not enough data yet," not
   *  a fabricated 0. */
  avgRMultipleOverridden: number | null;
  /** The comparison group — see this file's own header just below for the
   *  scoping decision. */
  nonOverriddenTradeCount: number;
  avgRMultipleNonOverridden: number | null;
}

/**
 * §5.9's worked example, verbatim: "You've exceeded your risk cap 12
 * times. Those trades averaged −0.4R against +0.3R for the rest." This
 * function computes exactly those numbers, scoped to ONE rule
 * (`fetchOverrideOutcomeSummary(userId, ruleId)`, per this slice's own
 * dispatch) — narrow and staying inside Module 04's own boundary
 * (`rule_overrides` + `rule_evaluations` + `trades.r_multiple` only, no
 * Module 05 dependency, no general analytics engine).
 *
 * **"The rest" is defined as this SAME rule's own `followed` population**
 * (`rule_evaluations.result = 'followed'` for this `rule_id`), not "every
 * other trade regardless of relevance." A broader "all other trades"
 * comparison would conflate trades this rule never even applied to (wrong
 * instrument scope, predates the rule, different account) with trades
 * where the trader genuinely adhered — an apples-to-oranges comparison
 * the worked example's own "for the rest" phrasing does not require and
 * this file deliberately avoids. Scoping "the rest" to the rule's own
 * frozen adherence data keeps the comparison fair (overridden-and-broken
 * vs. followed, both populations this exact rule actually governed) and
 * keeps this file's only two data sources `rule_overrides`/
 * `rule_evaluations` (plus `trades.r_multiple` for the outcome itself) —
 * never a scan of unrelated trades.
 *
 * Distinct `trade_id`s are used for the overridden side (a `DISTINCT`
 * subquery) — a trader could plausibly proceed past the SAME rule's
 * ambient breach more than once before that trade closes (a `session`
 * rule shown repeatedly through a trading day), and each such moment
 * writes its own `rule_overrides` row; averaging `r_multiple` must not
 * double-count the same trade's own outcome once per override event.
 */
export async function fetchOverrideOutcomeSummary(userId: string, ruleId: string): Promise<RuleOverrideOutcomeSummary> {
  return withUserConnection(userId, async (client) => {
    const [countRes, overriddenRes, followedRes] = await Promise.all([
      client.query<{ count: string }>(
        `select count(*)::text as count
           from retrospeq.rule_overrides
          where user_id = $1 and rule_id = $2`,
        [userId, ruleId],
      ),
      client.query<{ avg_r: string | null; n: string }>(
        `select avg(t.r_multiple)::text as avg_r, count(*)::text as n
           from (
             select distinct trade_id
               from retrospeq.rule_overrides
              where user_id = $1 and rule_id = $2 and trade_id is not null
           ) d
           join retrospeq.trades t on t.id = d.trade_id
          where t.user_id = $1 and t.status = 'confirmed' and t.r_multiple is not null`,
        [userId, ruleId],
      ),
      client.query<{ avg_r: string | null; n: string }>(
        `select avg(t.r_multiple)::text as avg_r, count(*)::text as n
           from retrospeq.rule_evaluations re
           join retrospeq.trades t on t.id = re.trade_id
          where re.user_id = $1 and re.rule_id = $2 and re.result = 'followed'
            and t.user_id = $1 and t.status = 'confirmed' and t.r_multiple is not null`,
        [userId, ruleId],
      ),
    ]);

    const overriddenN = Number(overriddenRes.rows[0]?.n ?? '0');
    const followedN = Number(followedRes.rows[0]?.n ?? '0');

    return {
      ruleId,
      overrideCount: Number(countRes.rows[0]?.count ?? '0'),
      overriddenTradeCount: overriddenN,
      avgRMultipleOverridden: overriddenN > 0 ? Number(overriddenRes.rows[0]!.avg_r) : null,
      nonOverriddenTradeCount: followedN,
      avgRMultipleNonOverridden: followedN > 0 ? Number(followedRes.rows[0]!.avg_r) : null,
    };
  });
}
