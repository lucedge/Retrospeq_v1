import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import { canForUser } from '@/lib/entitlements/service';
import { checkPruningRule, validateFieldConfig, type ProposedFieldConfig } from './field-validation';
import { StrategyNotFoundError } from './strategy-repository';
import type { FieldDataType } from './strategy-validation';

/**
 * Module 03 (Field Registry & Strategy) §3.1's `retrospeq.fields` table.
 * Started (Slice 03a's own erasure-fix dispatch) with just
 * `deleteAllFieldsForUser`; Slice 03c (field CREATION, §4.1's pruning rule
 * + §4.3's type/config validation) adds `createField` below — the first
 * real write path into this table from outside RLS's own owner policy
 * (`fields_owner_insert`, `20260902010000_field_registry_schema.sql`,
 * which already forbids `kind = 'derived'` at the RLS layer — `createField`
 * only ever writes `kind = 'account'` or `kind = 'strategy_var'`, so it
 * never even attempts what RLS would reject).
 */

/**
 * Erasure step 3b (part of the explicit FK-safe delete list, see
 * docs/adr/0010-erasure-explicit-delete-order.md) — deletes every `fields`
 * row this user owns, including their 9 permanent `drv.*` derived rows
 * every real user has (seeded at signup by
 * `retrospeq.seed_derived_fields_for_user`,
 * `20260902010000_field_registry_schema.sql`).
 *
 * **Why this needs the exact same `retrospeq.erasure_in_progress` escape
 * hatch as `deleteAllTradingAccountsForUser`, and why a mechanism that
 * already exists in this codebase could not simply be reused as-is:**
 * `fields` has a `BEFORE DELETE` trigger, `fields_forbid_derived_delete`
 * (same migration), that rejects deleting any `kind = 'derived'` row
 * unless `retrospeq.erasure_in_progress` reads `'true'` on the SAME
 * database connection/transaction that issued the DELETE. Before this
 * function existed, `executeErasure` never explicitly deleted `fields` at
 * all — it relied on `retrospeq.fields.user_id references
 * retrospeq.profiles(id) on delete cascade` firing automatically as a
 * side effect of the final `supabase.auth.admin.deleteUser(userId)` call.
 * That call runs through Supabase GoTrue (the auth server), which
 * performs its OWN internal cascade using ITS OWN, completely separate
 * Postgres connection — not this app's own `pg` connection pool. GoTrue's
 * connection has NEVER set `retrospeq.erasure_in_progress`, because that
 * flag is set via `select set_config('retrospeq.erasure_in_progress',
 * 'true', true)` — the third argument `true` makes it TRANSACTION-LOCAL
 * (`SET LOCAL` semantics) to whatever specific connection/transaction
 * issued it. A flag set on THIS app's own connection is structurally
 * invisible to a DIFFERENT connection GoTrue opens on its own — there is
 * no way to make a transaction-local GUC "reach" a different connection.
 * So every real erasure was silently failing at the very last step: every
 * user has 9 permanent `drv.*` rows (seeded at signup), GoTrue's own
 * cascade hit `fields_forbid_derived_delete` on the way down with the
 * flag unset on its own connection, and the whole `deleteUser` call
 * failed — meaning the account, its email, and its `auth.users` row were
 * NEVER actually purged, for every single user, ever, since this
 * migration shipped.
 *
 * The fix is the same one `deleteAllTradingAccountsForUser` already
 * established for `trading_accounts`/`trades`'s own identical problem
 * (`forbid_broker_confirmed_trade_delete`): delete `fields` EXPLICITLY,
 * on THIS app's own connection, with `erasure_in_progress` set LOCAL to
 * that SAME transaction, BEFORE `auth.admin.deleteUser()` ever runs — so
 * by the time GoTrue's own cascade fires later, every `fields` row this
 * user owned (derived and otherwise) is ALREADY GONE (deleted explicitly,
 * on a connection where the flag genuinely applied), and there is nothing
 * left for GoTrue's cascade to hit the trigger on. `set_config`'s third
 * argument (`true`) means this never lingers past this one
 * `withServiceRoleConnection` call, so the trigger's protection is fully
 * intact for every other write path (an ordinary client delete attempt,
 * which never sets this flag, is still rejected exactly as before).
 *
 * Deleting `fields` here also cascade-deletes every `retrospeq.field_usages`
 * row this user owns (`field_usages(user_id, field_id) references
 * fields(user_id, id) on delete cascade`, same migration) — `field_usages`
 * has no `BEFORE DELETE` trigger of its own (verified: this migration and
 * every other one in this repo were grepped for `before delete` triggers
 * before writing this function — `trades`, `rule_evaluations`, and `rules`
 * are the only other tables with one, none of them touched by this
 * function), so no separate explicit delete is needed for it.
 * `strategies`/`strategy_versions`/`trigger_conditions` are, likewise,
 * deliberately NOT given their own explicit pre-delete here: none of them
 * have a `BEFORE DELETE` trigger either (same grep), so GoTrue's own
 * cascade from `profiles` reaches them safely with nothing to block it —
 * matching this repo's own "existing cascades are kept as a defense-in-
 * depth backstop, explicit deletes are only for tables that genuinely
 * need one" posture (docs/adr/0010).
 */
export async function deleteAllFieldsForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
    await client.query('delete from retrospeq.fields where user_id = $1', [userId]);
  });
}

// =======================================================================
// Slice 03c — field CREATION (§4.1's pruning rule + §4.3's type/config
// validation). Backend only, per this slice's own dispatch — no rename/
// archive/type-change/promotion (§4.5, a future slice), no field picker/
// editor UI.
// =======================================================================

/** §5.2's own reference markup: `<input id="f-name" ... maxlength="40" ...>`
 *  — reused here as a real write-time bound, matching
 *  `strategy-validation.ts`'s own precedent of promoting a reference-markup
 *  `maxlength` into an enforced server-side constraint. */
const FIELD_NAME_MAX_LENGTH = 40;

/** A field this repository is ever asked to CREATE is always one of these
 *  two kinds — `kind = 'derived'` rows are exclusively system-seeded
 *  (§3.2, `seed_derived_fields_for_user`) and RLS's own
 *  `fields_owner_insert` policy already forbids a client-authenticated
 *  INSERT of one; this repository never even attempts it. */
export type CreatableFieldKind = 'account' | 'strategy_var';

export class FieldNameInvalidError extends Error {
  readonly code = 'FIELD_NAME_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Invalid field name: ${reason}`);
    this.name = 'FieldNameInvalidError';
  }
}

/**
 * Not one of §9's own named error codes — §4.2's own kind table
 * (`derived`/`account`/`strategy_var`) and §3.1's own schema comment
 * ("owner_strategy_id: non-null only when kind = 'strategy_var'") define
 * a real invariant this function enforces BEFORE it would otherwise
 * surface as a raw `fields_owner_strategy_matches_kind` CHECK-constraint
 * violation (`20260902010000_field_registry_schema.sql`) — same
 * "structurally impossible by the time a real UI exists, but the DB
 * constraint is the real backstop underneath this friendly check" posture
 * this repository's sibling `strategy-validation.ts` already establishes
 * for its own defensive error classes.
 */
export class FieldKindScopeMismatchError extends Error {
  readonly code = 'FIELD_KIND_SCOPE_MISMATCH' as const;
  constructor(
    readonly kind: CreatableFieldKind,
    readonly ownerStrategyId: string | null,
  ) {
    super(
      kind === 'strategy_var'
        ? 'A strategy_var field must be created with a real ownerStrategyId (§4.2: "that strategy only").'
        : `An account field must not have an ownerStrategyId (got "${ownerStrategyId}") — account fields are global to every strategy (§4.2).`,
    );
    this.name = 'FieldKindScopeMismatchError';
  }
}

/** §9: `ENTITLEMENT_LIMIT` — the free tier ("0" on `fields.custom`, see
 *  `docs/adr/0019`) attempting to create any custom field. */
export class FieldEntitlementLimitError extends Error {
  readonly code = 'ENTITLEMENT_LIMIT' as const;
  constructor(readonly userId: string) {
    super(
      `User ${userId} is not entitled to create a custom field on their current plan (Module 03 §1: the entire strategy module -- captured fields included -- is Pro; docs/adr/0019).`,
    );
    this.name = 'FieldEntitlementLimitError';
  }
}

/**
 * Thrown when the write-time INSERT collides with one of the two live
 * partial unique indexes `fields_unique_active_scoped`/
 * `fields_unique_active_unscoped`
 * (`20260902010000_field_registry_schema.sql`) — i.e. a genuine
 * `(user_id, name, owner_strategy_id)` collision among ACTIVE fields
 * (§7.2's own property-test requirement, verbatim). Not one of §9's own
 * named codes (that table doesn't have a row for this specific
 * DB-enforced case) but follows the exact same "translate a raw Postgres
 * constraint violation into an honest, typed application error" posture
 * `lib/broker/accounts-repository.ts`'s own `DuplicateAccountError` /
 * `isUniqueViolation` already establish for `trading_accounts` — a caller
 * of `createField` never sees a raw `error: duplicate key value violates
 * unique constraint "fields_unique_active_scoped"` string.
 */
export class FieldNameConflictError extends Error {
  readonly code = 'FIELD_NAME_CONFLICT' as const;
  constructor(
    readonly name: string,
    readonly ownerStrategyId: string | null,
  ) {
    super(
      ownerStrategyId
        ? `A field named "${name}" already exists in this strategy.`
        : `A field named "${name}" already exists.`,
    );
    this.name = 'FieldNameConflictError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** RFC-4122-shaped UUID check (any version/variant, not just v7) — used
 *  ONLY to short-circuit an obviously-malformed `ownerStrategyId` into the
 *  same friendly `StrategyNotFoundError` a genuinely-nonexistent-but-
 *  well-formed id already produces below, rather than letting a malformed
 *  string reach Postgres and surface as a raw `invalid input syntax for
 *  type uuid` error instead. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defense in depth against a client-supplied `ownerStrategyId` that does
 * not genuinely belong to the calling user — per this slice's own
 * dispatch, matching this repo's standing "never trust a client-supplied
 * foreign key without an ownership check" convention (flagged more than
 * once this session, including on `field_usages` itself by Slice 03b's
 * own security review). Runs under `withUserConnection` — RLS's own
 * `strategies_owner` policy already means this SELECT can only ever
 * return a row the calling user owns, so a cross-user id and a genuinely
 * nonexistent id are indistinguishable here BY DESIGN (both resolve to
 * `StrategyNotFoundError`, never leaking "yes that strategy exists, but
 * it's not yours"). The composite FK on `fields.owner_strategy_id`
 * (`foreign key (user_id, owner_strategy_id) references strategies
 * (user_id, id)`) is the real, unbypassable DB-layer backstop underneath
 * this — this check exists purely to turn what would otherwise be a raw
 * FK-violation error into an honest, typed one, the same "friendly error
 * over raw DB error" posture `isUniqueViolation`/`FieldNameConflictError`
 * establish just above.
 */
async function assertStrategyOwnedByUser(userId: string, strategyId: string): Promise<void> {
  if (!UUID_SHAPE.test(strategyId)) {
    throw new StrategyNotFoundError(strategyId);
  }
  const owned = await withUserConnection(userId, async (client) => {
    const res = await client.query('select 1 from retrospeq.strategies where id = $1 and user_id = $2', [strategyId, userId]);
    return (res.rowCount ?? 0) > 0;
  });
  if (!owned) {
    throw new StrategyNotFoundError(strategyId);
  }
}

/**
 * §4.3's own type table applied to what actually gets STORED, not just
 * what was validated — `validateFieldConfig` (already run before this is
 * called) only checks the shape of what the caller supplied; this
 * function decides the canonical on-disk `config` for each type:
 *
 *   - `pick_one`/`pick_many`: options trimmed (validated non-blank/
 *     distinct already, this only normalizes incidental whitespace).
 *   - `number`: stored exactly as validated (min/max/step required,
 *     unit passed through as-is or omitted).
 *   - `rating`: §4.3, verbatim "min, max (default 1-5)" — if the caller
 *     omitted both (the only combination `validateFieldConfig` allows
 *     besides supplying both), the default is filled in HERE, not left
 *     implicit in the stored row — a future reader of a `rating` field's
 *     own `config` should never have to know "no min/max present" means
 *     1-5, the row itself should just say so.
 *   - `bool`/`note`: §4.3, "--" — always stored as `{}`, discarding
 *     whatever the (permissively-validated, see `validateFieldConfig`'s
 *     own header) caller-supplied config contained, since neither type
 *     has any real config to keep.
 */
function normalizeFieldConfig(dataType: FieldDataType, config: ProposedFieldConfig): ProposedFieldConfig {
  switch (dataType) {
    case 'pick_one':
    case 'pick_many':
      return { options: (config.options ?? []).map((o) => o.trim()) };
    case 'number':
      return { min: config.min, max: config.max, step: config.step, ...(config.unit !== undefined ? { unit: config.unit } : {}) };
    case 'rating':
      return config.min === undefined ? { min: 1, max: 5 } : { min: config.min, max: config.max };
    case 'bool':
    case 'note':
      return {};
  }
}

export interface CreateFieldInput {
  userId: string;
  name: string;
  kind: CreatableFieldKind;
  dataType: FieldDataType;
  config: ProposedFieldConfig;
  /** Required (a real, owned strategy id) when `kind = 'strategy_var'`;
   *  must be `null` when `kind = 'account'` — §4.2's own kind table. */
  ownerStrategyId: string | null;
}

export interface CreatedField {
  fieldId: string;
  userId: string;
  name: string;
  kind: CreatableFieldKind;
  dataType: FieldDataType;
  config: ProposedFieldConfig;
  ownerStrategyId: string | null;
}

/**
 * §6.1's own flow, applied: `new field -> duplicates a derived field? ->
 * refuse -> scope: this strategy only -> kind = strategy_var / scope: all
 * strategies -> kind = account`. This function is the single entry point
 * for BOTH kinds (the caller supplies `kind` directly, matching the flow
 * diagram's own "scope" branch rather than this function re-deriving it).
 *
 * Order of checks, each one deliberately BEFORE the next so a caller
 * never pays for a later check's cost (a real DB round trip) when an
 * earlier, pure/cheap check would already have rejected the request:
 *
 *   1. Name shape (`FieldNameInvalidError`) — pure.
 *   2. Kind/`ownerStrategyId` consistency (`FieldKindScopeMismatchError`)
 *      — pure, §4.2/§3.1's own invariant, checked here before the DB's
 *      own `fields_owner_strategy_matches_kind` CHECK constraint would.
 *   3. §4.1's pruning rule (`FieldDuplicatesDerivedError`) — pure,
 *      `field-validation.ts`'s `checkPruningRule`.
 *   4. §4.3's config shape (`FieldConfigInvalidError`) — pure,
 *      `field-validation.ts`'s `validateFieldConfig`.
 *   5. Entitlement (`FieldEntitlementLimitError`, §1 / `docs/adr/0019`) —
 *      one DB read (`canForUser`).
 *   6. `strategy_var`-only: the referenced strategy is genuinely owned by
 *      this user (`StrategyNotFoundError`) — one more DB read, only paid
 *      when `kind = 'strategy_var'` (an `account` field never needs it).
 *   7. The write itself — one INSERT, RLS-enforced
 *      (`fields_owner_insert`), id generated server-side (see this
 *      function's own header comment on the id scheme, immediately
 *      below), translating a real `(user_id, name, owner_strategy_id)`
 *      collision into `FieldNameConflictError` rather than a raw
 *      Postgres error.
 *
 * **Field id generation scheme — a genuine judgment call, documented per
 * this slice's own dispatch instruction (the spec's own `'str.<uuid>.
 * pd_array'` in §3.1 is explicitly an illustrative EXAMPLE, not a
 * mandated format — confirmed by re-reading §3.1's own comment, which
 * introduces it with "stable string:" followed by two representative
 * examples, not a format grammar):**
 *
 * `kind = 'account'` -> `'acct.' || uuidv7`. `kind = 'strategy_var'` ->
 * `'str.' || uuidv7`. Both generated server-side, in SQL, via the same
 * `retrospeq.uuid_generate_v7()` function every other UUID-shaped primary
 * key in this schema already uses (`20260819020000_shadow_harness.sql`) —
 * not the `uuidv7` npm package, so id generation stays inside the same
 * transaction as the write with no extra round trip and no risk of a
 * client-clock-skewed timestamp component.
 *
 * Deliberately does NOT slugify the trader-supplied `name` into the id
 * (unlike the spec's own illustrative `'str.<uuid>.pd_array'` example,
 * whose trailing segment reads as a name-derived slug), for three
 * concrete reasons:
 *
 *   1. §4.5, verbatim: "Rename a field: Safe. Id is stable; the name is
 *      display only." A name-derived id segment would increasingly
 *      mismatch the field's own CURRENT name after every rename (a future
 *      slice's own job, not built here) — an avoidable, permanent footgun
 *      for a value that must stay stable "forever once created" (this
 *      slice's own dispatch instruction).
 *   2. Slugifying arbitrary user input can COLLIDE — two different
 *      literal names ("PD Array" vs "PD-Array") can slugify to the same
 *      token, which would surface as a raw primary-key violation on the
 *      SECOND insert even though the real uniqueness constraint (on
 *      `name`, not on any slug) had no problem with either name
 *      individually — directly undermining this same function's own
 *      `FieldNameConflictError` promise of a clean, honest, PREDICTABLE
 *      collision error tied to the actual `name` collision, not an
 *      incidental slug collision the trader has no way to anticipate.
 *   3. A pure UUIDv7 needs zero sanitization of arbitrary Unicode/emoji a
 *      free-text `name` field permits — no slug-generation edge cases
 *      (empty slug from an all-punctuation name, non-Latin scripts, etc.)
 *      to reason about at all.
 *
 * Also deliberately does NOT embed `ownerStrategyId` in a `strategy_var`
 * field's own id string (again unlike the spec's own illustrative
 * example, whose leading `<uuid>` segment reads as the OWNING strategy's
 * id) — §4.5's own promotion row is explicit that promoting a
 * `strategy_var` to `account` keeps "the same field id" while setting
 * `owner_strategy_id` NULL; baking the pre-promotion strategy id into the
 * id string would leave a permanently stale, misleading artifact
 * post-promotion (an id starting `str.<some-strategy-uuid>.` on a field
 * that is no longer strategy-scoped at all). `owner_strategy_id` itself is
 * already the real, live, correctly-updatable source of truth for that
 * relationship — repeating it inside an otherwise-immutable id string
 * adds a second, eventually-wrong copy of the same fact for no benefit.
 */
export async function createField(input: CreateFieldInput): Promise<CreatedField> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new FieldNameInvalidError('must not be empty.');
  }
  if (name.length > FIELD_NAME_MAX_LENGTH) {
    throw new FieldNameInvalidError(`must be at most ${FIELD_NAME_MAX_LENGTH} characters, got ${name.length}.`);
  }

  if (input.kind === 'strategy_var' && !input.ownerStrategyId) {
    throw new FieldKindScopeMismatchError(input.kind, input.ownerStrategyId);
  }
  if (input.kind === 'account' && input.ownerStrategyId !== null) {
    throw new FieldKindScopeMismatchError(input.kind, input.ownerStrategyId);
  }

  checkPruningRule(name);
  validateFieldConfig(input.dataType, input.config);
  const finalConfig = normalizeFieldConfig(input.dataType, input.config);

  const entitlement = await canForUser(input.userId, 'fields.custom');
  if (!entitlement.allowed) {
    throw new FieldEntitlementLimitError(input.userId);
  }

  if (input.kind === 'strategy_var') {
    await assertStrategyOwnedByUser(input.userId, input.ownerStrategyId!);
  }

  try {
    return await withUserConnection(input.userId, async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
         select (case when $3 = 'account' then 'acct.' else 'str.' end) || retrospeq.uuid_generate_v7()::text,
                $1, $2, $3, $4, 'captured', $5, $6::jsonb
         returning id`,
        [input.userId, name, input.kind, input.dataType, input.ownerStrategyId, JSON.stringify(finalConfig)],
      );
      const fieldId = res.rows[0].id;
      return {
        fieldId,
        userId: input.userId,
        name,
        kind: input.kind,
        dataType: input.dataType,
        config: finalConfig,
        ownerStrategyId: input.ownerStrategyId,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FieldNameConflictError(name, input.ownerStrategyId);
    }
    throw err;
  }
}
