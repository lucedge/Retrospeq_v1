import 'server-only';
import type { PoolClient } from 'pg';
import { withUserConnection } from '@/lib/supabase/direct';
import { canForUser } from '@/lib/entitlements/service';
import {
  countCapturedFields,
  evaluateTriggers,
  validateCaptureMoments,
  validateStrategyName,
  type FieldDataType,
  type FieldDefinitionForValidation,
  type FieldKind,
  type ProposedStrategyField,
  type ProposedTrigger,
} from './strategy-validation';

/**
 * Module 03 (Field Registry & Strategy) §4.6's strategy authoring
 * pipeline — the DB access layer behind a future `app/(app)/strategies/
 * actions.ts` Server Action (not built in this slice; see this file's own
 * dispatch, "backend only — no UI, no field-creation flow, no
 * trigger-condition authoring UI yet"). Every table this file touches
 * (`strategies`, `strategy_versions`, `field_usages`, `fields`) already
 * has real, working owner RLS from Slice 03a
 * (`supabase/migrations/20260902010000_field_registry_schema.sql`) — so
 * every function here runs under `withUserConnection`, genuinely
 * RLS-enforced against the caller's own session, matching
 * `lib/rules/rules-repository.ts`'s own established posture for `rules`/
 * `rule_versions` exactly.
 *
 * STRUCTURALLY MIRRORS `rules-repository.ts`'s `insertRuleAndVersion` /
 * `applyRuleEdit`, per this slice's own explicit dispatch instruction —
 * an `expectedVersion` parameter, a guarded UPDATE that only succeeds if
 * the version still matches, a named conflict error otherwise. This
 * matters doubly here: an independent verification pass found and fixed a
 * REAL optimistic-concurrency bug in Module 04's OWN rule-editing UI this
 * same build session (Slice 10f) — the exact failure mode was a caller
 * passing a freshly-re-derived version instead of the one it actually
 * held. `applyStrategyEditVersion` below takes `expectedVersion` as a
 * caller-supplied parameter and never re-derives it internally, exactly
 * to avoid repeating that mistake.
 *
 * TRIGGER CONDITIONS, EXPLICITLY OUT OF SCOPE: `createStrategy`/
 * `editStrategy` accept a `triggers[]` array (§4.6's own flow step,
 * "validate ... trigger text") and persist it as an OPAQUE JSONB snapshot
 * on `strategy_versions.triggers` (§3.1's own
 * `[{condition_id, text, order}]` shape) — but this file never reads from
 * or writes to the separate `retrospeq.trigger_conditions` TABLE. That
 * table's own authoring pipeline (the real text/hedge-word-detection UI,
 * §4.7) is a future slice's job; this slice only count-validates and
 * length-bounds the array text (`strategy-validation.ts`'s
 * `evaluateTriggers`), per §9's "TRIGGER_TOO_MANY | > 5 conditions | Soft
 * warning, not blocking."
 *
 * ENTITLEMENT GATE — §1: "the entire strategy module is Pro. Free users
 * have one silent, auto-created strategy with zero captured fields
 * (Module 08)." There is no dedicated Server Action layer yet for this
 * module (unlike `rules-repository.ts`, whose EARLY `canForUser`
 * pre-check lives in `app/(app)/rules/actions.ts`, a file this module
 * doesn't have), so `createStrategy`/`editStrategy` below fold BOTH the
 * early friendly pre-check AND the low-level atomic write into this one
 * file — `insertStrategyAndVersion`/`applyStrategyEditVersion` are the
 * low-level, guarded-SQL primitives (mirroring `insertRuleAndVersion`/
 * `applyRuleEdit` exactly); `createStrategy`/`editStrategy` are the
 * higher-level orchestrators a future Server Action would otherwise be
 * the one calling `canForUser` from. A future actions.ts layer is free to
 * call the low-level functions directly instead, if it wants its own
 * early pre-check closer to the UI boundary — nothing here assumes it
 * won't.
 *
 * Free users get `strategy.create`'s cap of exactly 0
 * (`lib/entitlements/capability-table.ts`) — a PLAN exclusion per
 * `resolve.ts`, not a quota that happens to be full — so a free user can
 * never successfully call `createStrategy`/`editStrategy` for a
 * user-initiated strategy. The ONE exception is Module 08's own future
 * "silent, auto-created" default strategy (§1, §8's own onboarding flow):
 * `createStrategy(..., { isDefaultStrategy: true })` BYPASSES the
 * entitlement check entirely, because that row is created BY THE SYSTEM,
 * not by a user-initiated "create a strategy" action this capability is
 * meant to gate. `editStrategy` has no equivalent bypass — see
 * `docs/adr/0018-strategy-edit-reuses-strategy-create-entitlement.md` for
 * why edit reuses the SAME capability as create (there is no dedicated
 * `strategy.edit` capability in Module 01 §4.3's table) and why that
 * means a free user's default strategy stays genuinely un-editable, at
 * "zero captured fields," exactly matching §1's own framing, until they
 * upgrade.
 */

// ---------------------------------------------------------------------
// §3.1's own literal JSONB shape for `strategy_versions.fields`/
// `triggers` is snake_case (`[{field_id, capture_moment, order}]`,
// `[{condition_id, text, order}]`) — a genuine, deliberate exception to
// this codebase's own camelCase TypeScript convention, kept because this
// JSON is a stored, spec-documented ON-DISK SHAPE a future Module 04/05
// slice may read directly (§3.1's own ERD: `trades.strategy_id +
// strategy_version -> strategy_versions`), not merely an internal
// implementation detail free to rename. Every function in this file
// works with camelCase `ProposedStrategyField`/`ProposedTrigger` objects
// (matching this repo's TS convention everywhere else); these two
// serialize/deserialize pairs are the ONLY place the snake_case-on-disk
// shape is materialized, so a future reader of this file's own business
// logic never has to think about the distinction.
// ---------------------------------------------------------------------

interface SerializedFieldEntry {
  field_id: string;
  capture_moment: ProposedStrategyField['captureMoment'];
  order: number;
}

interface SerializedTriggerEntry {
  condition_id: string;
  text: string;
  order: number;
}

function serializeFields(fields: ProposedStrategyField[]): SerializedFieldEntry[] {
  return fields.map((f) => ({ field_id: f.fieldId, capture_moment: f.captureMoment, order: f.order }));
}

function deserializeFields(raw: SerializedFieldEntry[]): ProposedStrategyField[] {
  return raw.map((r) => ({ fieldId: r.field_id, captureMoment: r.capture_moment, order: r.order }));
}

function serializeTriggers(triggers: ProposedTrigger[]): SerializedTriggerEntry[] {
  return triggers.map((t) => ({ condition_id: t.conditionId, text: t.text, order: t.order }));
}

function deserializeTriggers(raw: SerializedTriggerEntry[]): ProposedTrigger[] {
  return raw.map((r) => ({ conditionId: r.condition_id, text: r.text, order: r.order }));
}

// ---------------------------------------------------------------------
// Field definition lookups — the real read behind §4.4's capture-moment
// validation ("a real lookup against the fields table's own data_type/
// config for every field referenced in the strategy's proposed fields[]
// array").
// ---------------------------------------------------------------------

interface FieldDefinitionRow {
  id: string;
  kind: FieldKind;
  data_type: FieldDataType;
  config: FieldDefinitionForValidation['config'] | null;
}

/**
 * Every ACTIVE field this user owns among `fieldIds`, keyed by id — any
 * `kind` (`derived`, `account`, `strategy_var`), since §4.4's
 * capture-moment rule is a function of `data_type`/`config`, not `kind`.
 * A field id in `fieldIds` with no corresponding entry in the returned
 * map either doesn't exist for this user or is `state = 'archived'` —
 * `strategy-validation.ts`'s `validateCaptureMoments` treats either case
 * as `FieldNotFoundError`, never a silent pass-through.
 */
export async function fetchFieldDefinitionsByIds(
  userId: string,
  fieldIds: string[],
): Promise<Map<string, FieldDefinitionForValidation>> {
  if (fieldIds.length === 0) return new Map();
  const uniqueIds = Array.from(new Set(fieldIds));
  return withUserConnection(userId, async (client) => {
    const res = await client.query<FieldDefinitionRow>(
      `select id, kind, data_type, config
         from retrospeq.fields
        where user_id = $1 and id = any($2::text[]) and state = 'active'`,
      [userId, uniqueIds],
    );
    const map = new Map<string, FieldDefinitionForValidation>();
    for (const row of res.rows) {
      map.set(row.id, { fieldId: row.id, kind: row.kind, dataType: row.data_type, config: row.config ?? {} });
    }
    return map;
  });
}

// ---------------------------------------------------------------------
// field_usages — the shared rebuild helper §4.6 names explicitly
// ("rebuild field_usages for this strategy") — used by BOTH create
// (fresh insert, nothing to delete) and edit (delete-then-reinsert, per
// §4.6's own literal wording, not a partial UPDATE).
// ---------------------------------------------------------------------

async function rebuildFieldUsagesForStrategy(
  client: PoolClient,
  userId: string,
  strategyId: string,
  fieldIds: string[],
): Promise<void> {
  await client.query(
    `delete from retrospeq.field_usages
      where user_id = $1 and used_by = 'strategy' and used_by_id = $2`,
    [userId, strategyId],
  );
  const uniqueIds = Array.from(new Set(fieldIds));
  if (uniqueIds.length === 0) return;
  await client.query(
    `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
     select unnest($1::text[]), $2, 'strategy', $3`,
    [uniqueIds, userId, strategyId],
  );
}

// ---------------------------------------------------------------------
// Shared errors
// ---------------------------------------------------------------------

/** §9: `ENTITLEMENT_LIMIT` — "Free user creating a strategy | Specific
 *  upgrade path." Also thrown by `editStrategy` per docs/adr/0018. */
export class StrategyEntitlementLimitError extends Error {
  readonly code = 'ENTITLEMENT_LIMIT' as const;
  constructor(readonly userId: string) {
    super(
      `User ${userId} is not entitled to create/edit a strategy on their current plan (Module 03 §1: "the entire strategy module is Pro").`,
    );
    this.name = 'StrategyEntitlementLimitError';
  }
}

export class StrategyNotFoundError extends Error {
  readonly code = 'STRATEGY_NOT_FOUND' as const;
  constructor(readonly strategyId: string) {
    super(`No strategy ${strategyId} owned by the calling user.`);
    this.name = 'StrategyNotFoundError';
  }
}

export class StrategyNotEditableError extends Error {
  readonly code = 'STRATEGY_NOT_EDITABLE' as const;
  constructor(
    readonly strategyId: string,
    readonly state: string,
  ) {
    super(`Strategy ${strategyId} has state "${state}" — only an 'active' strategy may be edited.`);
    this.name = 'StrategyNotEditableError';
  }
}

/** §9: `STRATEGY_VERSION_CONFLICT` — "Concurrent edit | Show what
 *  changed; offer merge or discard." Thrown when
 *  `applyStrategyEditVersion`'s own guarded supersede UPDATE loses the
 *  concurrency race — see that function's own header. */
export class StrategyEditConflictError extends Error {
  readonly code = 'STRATEGY_VERSION_CONFLICT' as const;
  constructor(
    readonly strategyId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Strategy ${strategyId}'s version ${expectedVersion} was already superseded by a concurrent edit before this edit's own guarded UPDATE ran.`,
    );
    this.name = 'StrategyEditConflictError';
  }
}

/**
 * Thrown when `insertStrategyAndVersion`'s own guarded INSERT (see that
 * function's header) returns zero rows for a NON-default strategy — the
 * caller's active, non-default strategy count reached `capLimit` between
 * `createStrategy`'s own earlier, non-atomic `canForUser` pre-check and
 * this guarded write actually running. Mapped to the same `ENTITLEMENT_LIMIT`
 * shape the early pre-check already returns, matching
 * `RuleCreateCapExceededError`'s own precedent exactly.
 */
export class StrategyCreateCapExceededError extends Error {
  readonly code = 'ENTITLEMENT_LIMIT' as const;
  constructor(
    readonly userId: string,
    readonly capLimit: number | null,
  ) {
    super(
      `User ${userId} already has ${capLimit ?? 'unlimited'} (or more) active, non-default strategies -- insertStrategyAndVersion's own guarded INSERT rejected this new strategy rather than exceeding the cap.`,
    );
    this.name = 'StrategyCreateCapExceededError';
  }
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface StrategyVersionSnapshot {
  strategyId: string;
  name: string;
  isDefault: boolean;
  state: 'active' | 'archived';
  currentVersion: number;
  fields: ProposedStrategyField[];
  triggers: ProposedTrigger[];
}

interface StrategyVersionSnapshotRow {
  strategy_id: string;
  name: string;
  is_default: boolean;
  state: 'active' | 'archived';
  current_version: number;
  /** Raw, on-disk snake_case shape — see this file's own header on
   *  `serializeFields`/`deserializeFields` for why. */
  fields: SerializedFieldEntry[];
  triggers: SerializedTriggerEntry[];
}

/**
 * The strategy's current (non-superseded) version, scoped to the
 * caller's own session via `withUserConnection` — real RLS, not merely an
 * application-layer `WHERE user_id = $1` (which this query still also
 * carries, defense-in-depth, matching `fetchCurrentRuleForEdit`'s own
 * posture). This is the read a caller needs BEFORE editing, so it holds
 * the real `currentVersion` to pass back into `editStrategy` as
 * `expectedVersion` — never re-derived internally, per this file's own
 * header on the Slice 10f lesson.
 */
export async function fetchCurrentStrategyForEdit(
  userId: string,
  strategyId: string,
): Promise<StrategyVersionSnapshot | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<StrategyVersionSnapshotRow>(
      `select s.id as strategy_id, s.name, s.is_default, s.state, s.current_version,
              sv.fields, sv.triggers
         from retrospeq.strategies s
         join retrospeq.strategy_versions sv on sv.strategy_id = s.id and sv.version = s.current_version
        where s.id = $1 and s.user_id = $2`,
      [strategyId, userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      strategyId: row.strategy_id,
      name: row.name,
      isDefault: row.is_default,
      state: row.state,
      currentVersion: row.current_version,
      fields: deserializeFields(row.fields),
      triggers: deserializeTriggers(row.triggers),
    };
  });
}

// ---------------------------------------------------------------------
// createStrategy's low-level, atomic write
// ---------------------------------------------------------------------

export interface InsertStrategyInput {
  userId: string;
  name: string;
  fields: ProposedStrategyField[];
  triggers: ProposedTrigger[];
  /** Module 08's own future silent-default-strategy bypass — see this
   *  file's own header. */
  isDefaultStrategy: boolean;
  /** The caller's OWN `strategy.create` entitlement cap
   *  (`canForUser(userId, 'strategy.create').limit`), never re-derived or
   *  hardcoded here — matching `InsertRuleInput.capLimit`'s own
   *  convention exactly. Ignored entirely when `isDefaultStrategy` is
   *  true. */
  capLimit: number | null;
}

export interface InsertedStrategy {
  strategyId: string;
  version: number;
}

/**
 * §4.6's "insert strategy_versions (version = current + 1)" applied to
 * the FIRST version (`= 1`), one transaction: (a) a guarded INSERT into
 * `strategies` — `pg_advisory_xact_lock(hashtext(user_id))` first (the
 * SAME concurrency-fix technique `insertRuleAndVersion`'s own header
 * documents in full, "CONCURRENCY FIX (2026-08-29)"), then a correlated
 * `count(*)` guard folded into the INSERT's own WHERE clause so the cap
 * check and the write are atomic, not two separate round trips; (b) the
 * `strategy_versions` row for version 1; (c) `field_usages` rebuilt for
 * this brand-new strategy (nothing to delete yet, but reuses the same
 * shared helper `applyStrategyEditVersion` uses, rather than a parallel
 * insert-only version of it).
 *
 * The guarded INSERT's WHERE clause has TWO independent escape hatches,
 * either of which lets the row through: `$3 = true` (this IS Module 08's
 * own default-strategy bypass — the cap never applies to it, regardless
 * of `capLimit`'s value) OR `$4::int is null or (correlated count) <
 * $4` (the normal cap-guard, identical shape to `insertRuleAndVersion`'s
 * own `$5::int is null or (...) < $5`). `strategies_one_default_per_user`
 * (`20260902020000_strategy_default_uniqueness.sql`) is the separate,
 * DB-level backstop against a SECOND default ever being created — this
 * function's own bypass only concerns the QUANTITY cap, not uniqueness.
 */
export async function insertStrategyAndVersion(input: InsertStrategyInput): Promise<InsertedStrategy> {
  return withUserConnection(input.userId, async (client) => {
    // Serializes concurrent creates for the SAME user before the
    // count-guarded INSERT below runs — identical technique and
    // reasoning to `insertRuleAndVersion`'s own first statement.
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [input.userId]);

    const strategyRes = await client.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       select $1, $2, 1, $3, 'active'
        where $3 = true or $4::int is null or (
          select count(*)
            from retrospeq.strategies s2
           where s2.user_id = $1
             and s2.state = 'active'
             and s2.is_default = false
        ) < $4
       returning id`,
      [input.userId, input.name, input.isDefaultStrategy, input.capLimit],
    );
    if ((strategyRes.rowCount ?? 0) !== 1) {
      if (input.isDefaultStrategy) {
        // `$3 = true` always satisfies the guard's WHERE clause on its
        // own -- zero rows here despite that is a different failure
        // entirely (e.g. `strategies_one_default_per_user` rejecting a
        // second default, which raises a real unique-violation exception
        // rather than returning zero rows) -- should be structurally
        // impossible to reach this branch, matching this repo's
        // "should be structurally impossible" throw convention elsewhere.
        throw new Error(
          `insertStrategyAndVersion: the guarded INSERT for a default strategy (userId=${input.userId}) affected ${strategyRes.rowCount} rows -- structurally impossible given "$3 = true" always satisfies the guard's WHERE clause; investigate.`,
        );
      }
      throw new StrategyCreateCapExceededError(input.userId, input.capLimit);
    }
    const strategyId = strategyRes.rows[0].id;

    await client.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, $3, $4::jsonb, $5::jsonb)`,
      [strategyId, input.userId, input.name, JSON.stringify(serializeFields(input.fields)), JSON.stringify(serializeTriggers(input.triggers))],
    );

    await rebuildFieldUsagesForStrategy(
      client,
      input.userId,
      strategyId,
      input.fields.map((f) => f.fieldId),
    );

    return { strategyId, version: 1 };
  });
}

// ---------------------------------------------------------------------
// createStrategy — the higher-level orchestrator: validation pipeline +
// entitlement pre-check + the atomic write above.
// ---------------------------------------------------------------------

export interface CreateStrategyInput {
  userId: string;
  name: string;
  fields: ProposedStrategyField[];
  triggers: ProposedTrigger[];
  /** Defaults to `false`. Set to `true` ONLY by Module 08's own future
   *  onboarding flow, creating a free user's silent default strategy —
   *  see this file's own header. */
  isDefaultStrategy?: boolean;
}

export interface CreateStrategyResult {
  strategyId: string;
  version: number;
  /** §9: `TRIGGER_TOO_MANY` — non-blocking, informational. */
  triggerCountWarning: boolean;
  /** §4.8's field-cap warning input — informational only; this slice does
   *  not build the warning UI itself (see `strategy-validation.ts`'s own
   *  `countCapturedFields` header). */
  capturedFieldCount: number;
}

export async function createStrategy(input: CreateStrategyInput): Promise<CreateStrategyResult> {
  const isDefaultStrategy = input.isDefaultStrategy ?? false;

  validateStrategyName(input.name);
  const triggerEvaluation = evaluateTriggers(input.triggers);

  const fieldIds = input.fields.map((f) => f.fieldId);
  const fieldDefs = await fetchFieldDefinitionsByIds(input.userId, fieldIds);
  validateCaptureMoments(input.fields, fieldDefs);
  const capturedFieldCount = countCapturedFields(input.fields, fieldDefs);

  let capLimit: number | null = null;
  if (!isDefaultStrategy) {
    // Early, non-atomic pre-check for a fast, friendly ENTITLEMENT_LIMIT
    // in the common (non-racing) case -- same
    // `insertRuleAndVersion`/`createRule` split `rules-repository.ts`'s
    // own header documents: this is NOT the invariant-enforcing backstop,
    // `insertStrategyAndVersion`'s own guarded INSERT is. Module 08's own
    // future silent-default creation bypasses this call ENTIRELY
    // (isDefaultStrategy = true) -- see this file's header for why that
    // bypass is correct, not a loophole.
    const entitlement = await canForUser(input.userId, 'strategy.create');
    if (!entitlement.allowed) {
      throw new StrategyEntitlementLimitError(input.userId);
    }
    capLimit = entitlement.limit;
  }

  const inserted = await insertStrategyAndVersion({
    userId: input.userId,
    name: input.name,
    fields: input.fields,
    triggers: input.triggers,
    isDefaultStrategy,
    capLimit,
  });

  return {
    strategyId: inserted.strategyId,
    version: inserted.version,
    triggerCountWarning: triggerEvaluation.triggerTooMany,
    capturedFieldCount,
  };
}

// ---------------------------------------------------------------------
// editStrategy's low-level, atomic write
// ---------------------------------------------------------------------

/**
 * §4.6's exact flow, one transaction:
 *
 *   (a) UPDATE the current `strategy_versions` row's `superseded_at` —
 *       the ONE mutation `strategy_versions_forbid_mutation`
 *       (`20260902010000_field_registry_schema.sql`) permits, null ->
 *       now(), never back. GUARDED (`where strategy_id = $1 and
 *       version = $2 and superseded_at is null`) — the exact same
 *       atomic-conditional-UPDATE-then-rowCount-check pattern
 *       `applyRuleEdit` already established for `rule_versions`. A
 *       concurrent `editStrategy` call that already superseded THIS
 *       version before this UPDATE's own row lock is acquired makes
 *       `rowCount !== 1` here, and this function aborts the whole
 *       transaction (ROLLBACK, via `withUserConnection`'s own catch —
 *       nothing from (b)/(c)/(d) below is ever committed) rather than
 *       silently proceeding against a stale precondition.
 *   (b) INSERT the new `strategy_versions` row, `version = expectedVersion
 *       + 1`. `strategy_versions_current_unique` (the partial unique
 *       index on `(strategy_id) where superseded_at is null`) guarantees
 *       this is the only non-superseded row for this strategy the instant
 *       it commits.
 *   (c) UPDATE `strategies.current_version` (and `strategies.name`, kept
 *       in sync with the version snapshot's own name) — guarded the same
 *       way (`and current_version = $3`) as an extra, defensive check;
 *       given (a)'s guard already serialises concurrent editors on the
 *       same row via Postgres's own row lock, this should never itself
 *       lose a race that (a) didn't already catch — kept as
 *       belt-and-suspenders, matching `applyRuleEdit`'s own posture.
 *   (d) `field_usages` REBUILT for this strategy (delete-then-reinsert,
 *       per §4.6's own literal wording "rebuild field_usages for this
 *       strategy" — not a partial UPDATE), via the same
 *       `rebuildFieldUsagesForStrategy` helper `insertStrategyAndVersion`
 *       uses.
 */
export async function applyStrategyEditVersion(
  userId: string,
  strategyId: string,
  expectedVersion: number,
  name: string,
  fields: ProposedStrategyField[],
  triggers: ProposedTrigger[],
): Promise<{ newVersion: number }> {
  return withUserConnection(userId, async (client) => {
    const supersedeRes = await client.query(
      `update retrospeq.strategy_versions
          set superseded_at = now()
        where strategy_id = $1 and version = $2 and superseded_at is null`,
      [strategyId, expectedVersion],
    );
    if ((supersedeRes.rowCount ?? 0) !== 1) {
      throw new StrategyEditConflictError(strategyId, expectedVersion);
    }

    const newVersion = expectedVersion + 1;
    await client.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [strategyId, newVersion, userId, name, JSON.stringify(serializeFields(fields)), JSON.stringify(serializeTriggers(triggers))],
    );

    const strategiesUpdateRes = await client.query(
      `update retrospeq.strategies
          set current_version = $2, name = $4
        where id = $1 and current_version = $3`,
      [strategyId, newVersion, expectedVersion, name],
    );
    if ((strategiesUpdateRes.rowCount ?? 0) !== 1) {
      throw new Error(
        `applyStrategyEditVersion: expected exactly one retrospeq.strategies row for id ${strategyId} at current_version ${expectedVersion}, affected ${strategiesUpdateRes.rowCount} -- should be structurally impossible given the guarded supersede UPDATE above already succeeded.`,
      );
    }

    await rebuildFieldUsagesForStrategy(
      client,
      userId,
      strategyId,
      fields.map((f) => f.fieldId),
    );

    return { newVersion };
  });
}

// ---------------------------------------------------------------------
// editStrategy — the higher-level orchestrator.
// ---------------------------------------------------------------------

export interface EditStrategyInput {
  userId: string;
  strategyId: string;
  /** The version the caller last read (from `fetchCurrentStrategyForEdit`)
   *  — REQUIRED, never re-derived internally. See this file's own header
   *  on the Slice 10f lesson this is deliberately built to avoid
   *  repeating. */
  expectedVersion: number;
  name: string;
  fields: ProposedStrategyField[];
  triggers: ProposedTrigger[];
}

export interface EditStrategyResult {
  newVersion: number;
  triggerCountWarning: boolean;
  capturedFieldCount: number;
}

export async function editStrategy(input: EditStrategyInput): Promise<EditStrategyResult> {
  const current = await fetchCurrentStrategyForEdit(input.userId, input.strategyId);
  if (!current) {
    throw new StrategyNotFoundError(input.strategyId);
  }
  if (current.state !== 'active') {
    throw new StrategyNotEditableError(input.strategyId, current.state);
  }

  // §1: "the entire strategy module is Pro" — there is no separate
  // `strategy.edit` capability in Module 01 §4.3's own capability table,
  // and `strategy.create`'s own cap shape (free: 0, pro: null — never a
  // finite nonzero number) makes it a pure per-plan boolean gate in
  // practice, not a real quota. Reused here for EDIT rather than adding a
  // new capability the table doesn't define — see docs/adr/0018 for the
  // full reasoning and what it costs. A free user's own silent default
  // strategy (created via `createStrategy(..., { isDefaultStrategy: true })`,
  // which bypasses this same capability entirely) is therefore genuinely
  // un-editable until the user upgrades — exactly matching §1's "zero
  // captured fields" framing: it stays exactly as Module 08 created it.
  const entitlement = await canForUser(input.userId, 'strategy.create');
  if (!entitlement.allowed) {
    throw new StrategyEntitlementLimitError(input.userId);
  }

  validateStrategyName(input.name);
  const triggerEvaluation = evaluateTriggers(input.triggers);

  const fieldIds = input.fields.map((f) => f.fieldId);
  const fieldDefs = await fetchFieldDefinitionsByIds(input.userId, fieldIds);
  validateCaptureMoments(input.fields, fieldDefs);
  const capturedFieldCount = countCapturedFields(input.fields, fieldDefs);

  const result = await applyStrategyEditVersion(
    input.userId,
    input.strategyId,
    input.expectedVersion,
    input.name,
    input.fields,
    input.triggers,
  );

  return {
    newVersion: result.newVersion,
    triggerCountWarning: triggerEvaluation.triggerTooMany,
    capturedFieldCount,
  };
}
