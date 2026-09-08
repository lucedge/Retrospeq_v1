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
 * + §4.3's type/config validation) added `createField` — the first
 * real write path into this table from outside RLS's own owner policy
 * (`fields_owner_insert`, `20260902010000_field_registry_schema.sql`,
 * which already forbids `kind = 'derived'` at the RLS layer — `createField`
 * only ever writes `kind = 'account'` or `kind = 'strategy_var'`, so it
 * never even attempts what RLS would reject).
 *
 * Slice 03d (§4.5's field LIFECYCLE — backend only, no UI) adds
 * `renameField`/`archiveField` below, plus documents (rather than builds)
 * two other §4.5 rows this slice's own dispatch explicitly scoped OUT —
 * see the "§4.5 — decisions this slice made explicit, not silently"
 * section further down for the full reasoning on both.
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
 *
 * **BUG FIX (2026-09-08, `retrospeq-tester` independent verification
 * pass):** the constructor parameter carrying the colliding field's own
 * name was originally called `name` — clearly INTENDED, matching every
 * sibling error class in this file (`FieldKindScopeMismatchError.kind`,
 * `FieldRecordNotFoundError.fieldId`), to expose it as a typed data field
 * (`err.name`). It never could: the very next constructor statement,
 * `this.name = 'FieldNameConflictError'` (the ordinary "tag the error
 * class for stack traces" convention every class in this file uses),
 * unconditionally clobbered it — both targeted the SAME property,
 * `Error.prototype.name`. `.message` was unaffected (the real name was
 * already baked into the string passed to `super()` before the
 * collision), which is why no prior test caught this — every existing
 * test only ever asserted `instanceof`/`.message`, never `.name`. Fixed by
 * renaming the parameter to `fieldName` and storing it under a distinct
 * property, `conflictingFieldName` — `this.name` is left alone, still the
 * ordinary `Error.prototype.name` class tag every error in this file sets.
 * Confirmed via grep (`app/`, every test file in this repo) that no
 * caller read `.name` expecting the field name before this fix — no
 * call-site update was needed.
 */
export class FieldNameConflictError extends Error {
  readonly code = 'FIELD_NAME_CONFLICT' as const;
  /** The colliding field's own name, as data — read this, never `.name`
   *  (which is always the fixed string `'FieldNameConflictError'`, the
   *  ordinary Error-class-name convention every class in this file uses). */
  readonly conflictingFieldName: string;
  constructor(
    fieldName: string,
    readonly ownerStrategyId: string | null,
  ) {
    super(
      ownerStrategyId
        ? `A field named "${fieldName}" already exists in this strategy.`
        : `A field named "${fieldName}" already exists.`,
    );
    this.name = 'FieldNameConflictError';
    this.conflictingFieldName = fieldName;
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

// =======================================================================
// Slice 03d — field LIFECYCLE (§4.5): rename, archive. Backend only, per
// this slice's own dispatch — no promotion (§4.4/§6.1, a separate future
// slice), no trigger-condition authoring (§4.7), no field-cap warning
// (§4.8), no UI.
// =======================================================================

/** Every kind a real `retrospeq.fields` row can have, as opposed to
 *  `CreatableFieldKind` above (which is narrower — the two kinds
 *  `createField` is ever asked to WRITE). The lifecycle reads below need
 *  to see `'derived'` too, precisely so they can recognise and reject it. */
type AnyFieldKind = 'derived' | CreatableFieldKind;

/**
 * §9's own error-code table has no row for "the field id a caller supplied
 * doesn't resolve to a real row this user owns" — same "not one of §9's
 * own named codes, plays the defensive existence-check role" posture
 * `StrategyNotFoundError`/`RuleNotFoundError` already establish for their
 * own modules. Named `FieldRecordNotFoundError`, deliberately NOT
 * `FieldNotFoundError` — that exact name is already exported by
 * `strategy-validation.ts` for a DIFFERENT scenario (a field id missing
 * from a caller-supplied validation map during a strategy SAVE, a pure/
 * synchronous check with no DB read at all) — reusing the identical class
 * name here for a DB-backed "no row owned by this user" check would force
 * an import alias on any future file that needs both, for no real benefit.
 * The `code` string (`FIELD_NOT_FOUND`) is intentionally still shared —
 * both really do mean "the field you named could not be found" from an API
 * consumer's point of view, and this repo already shares `code` strings
 * across distinct classes when the CALLER-FACING meaning is genuinely the
 * same (e.g. `StrategyCreateCapExceededError`/`StrategyEntitlementLimitError`
 * both carry `ENTITLEMENT_LIMIT`).
 *
 * Also thrown — deliberately, not distinguished from a genuine
 * nonexistent-id case — for a field owned by a DIFFERENT user, matching
 * `StrategyNotFoundError`'s own "RLS makes cross-user and nonexistent
 * indistinguishable BY DESIGN" posture exactly: never leak "yes that field
 * exists, but it's not yours."
 */
export class FieldRecordNotFoundError extends Error {
  readonly code = 'FIELD_NOT_FOUND' as const;
  constructor(readonly fieldId: string) {
    super(`No field ${fieldId} owned by the calling user.`);
    this.name = 'FieldRecordNotFoundError';
  }
}

/**
 * §3.2, verbatim: derived fields "are never editable, never deletable."
 * The REAL, unbypassable backstop for this is the DB-layer
 * `fields_forbid_derived_update`/`fields_forbid_derived_delete` triggers
 * (`20260902010000_field_registry_schema.sql`) — this error exists purely
 * so `renameField`/`archiveField` can recognise the derived case BEFORE
 * attempting a write the trigger would reject anyway, and throw something
 * honest and typed instead of letting the trigger's own raw Postgres
 * exception (`errcode 23514`, a plpgsql `raise exception` string naming
 * the trigger and the spec section) reach the caller — the same
 * "friendly error over raw DB error" posture `isUniqueViolation`/
 * `FieldNameConflictError` already establish just above in this file. Not
 * one of §9's own named codes for the same reason `FieldKindScopeMismatchError`
 * isn't — a genuinely defensive check, not a product-facing authoring
 * decision a trader is making.
 */
export class FieldDerivedImmutableError extends Error {
  readonly code = 'FIELD_DERIVED_IMMUTABLE' as const;
  constructor(
    readonly fieldId: string,
    readonly attemptedOperation: 'renamed' | 'archived',
  ) {
    super(
      `Field ${fieldId} is a derived field (kind = 'derived') and can never be ${attemptedOperation} — Module 03 §3.2: "never editable, never deletable."`,
    );
    this.name = 'FieldDerivedImmutableError';
  }
}

/**
 * A single dependent naming what references a field about to be archived —
 * §9: `FIELD_IN_USE` — "Delete with dependent rules | Blocking dialog
 * naming each rule." `usedBy` is genuinely either a strategy OR a rule
 * (§3.1's own `field_usages.used_by` — `used_by_id` is polymorphic across
 * the two, no single FK can resolve it, matching that table's own
 * migration-header reasoning), so `label` is resolved per-branch by
 * `fetchFieldUsageDependents` below: a strategy's own `name` for
 * `used_by = 'strategy'`, or a rule's CURRENT rendered sentence
 * (`rule_versions.rendered` at `rules.current_version` — the same
 * "current wording, not a historical snapshot" honest simplification
 * `adherence-display.ts`'s own header already documents for the identical
 * reason: `field_usages` has no `rule_version` pinned, only the live
 * relationship) for `used_by = 'rule'`.
 */
export interface FieldUsageDependent {
  usedBy: 'strategy' | 'rule';
  usedById: string;
  label: string;
}

/** §9: `FIELD_IN_USE`. */
export class FieldInUseError extends Error {
  readonly code = 'FIELD_IN_USE' as const;
  constructor(
    readonly fieldId: string,
    readonly dependents: FieldUsageDependent[],
  ) {
    super(
      `Field ${fieldId} is used by ${dependents.length} ${dependents.length === 1 ? 'dependent' : 'dependents'} and cannot be archived until ` +
        `${dependents.length === 1 ? 'it is' : 'they are'} removed or retired: ${dependents.map((d) => `${d.usedBy}:${d.label}`).join(', ')}.`,
    );
    this.name = 'FieldInUseError';
  }
}

interface FieldLifecycleRow {
  id: string;
  kind: AnyFieldKind;
  state: 'active' | 'archived';
  ownerStrategyId: string | null;
  archivedAt: string | null;
}

/**
 * The single read both `renameField` and `archiveField` open with — the
 * SAME "never trust a client-supplied id without confirming it belongs to
 * the calling userId at the APPLICATION layer too" defense-in-depth this
 * slice's own dispatch calls out (`fetchCurrentStrategyForEdit`'s own
 * established pattern, `strategy-repository.ts`): the explicit
 * `and user_id = $2` predicate below is redundant with RLS's own
 * `fields_owner_select` policy (`withUserConnection` already scopes this
 * connection to `auth.uid() = userId`) but kept anyway, matching every
 * other lifecycle-read in this codebase.
 */
async function fetchFieldForLifecycleOp(userId: string, fieldId: string): Promise<FieldLifecycleRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{
      id: string;
      kind: AnyFieldKind;
      state: 'active' | 'archived';
      owner_strategy_id: string | null;
      archived_at: string | null;
    }>(
      `select id, kind, state, owner_strategy_id, archived_at
         from retrospeq.fields
        where user_id = $1 and id = $2`,
      [userId, fieldId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      ownerStrategyId: row.owner_strategy_id,
      archivedAt: row.archived_at,
    };
  });
}

/**
 * §9's own `FIELD_IN_USE` behaviour, applied generically across BOTH
 * `field_usages.used_by` branches — "naming the rules" (§4.5's own row)
 * plainly also means naming a dependent STRATEGY when that's what exists,
 * since §3.1's own schema already models both under one table, and this
 * slice's own dispatch is explicit that this function must check both even
 * though, in THIS repo TODAY, only `used_by = 'strategy'` rows can ever
 * actually exist (Slice 03b's `createStrategy`/`editStrategy` are the only
 * code that has ever written a `field_usages` row — no Module 04
 * rule-authoring pipeline writes `used_by = 'rule'` rows yet, confirmed by
 * grep of `lib/rules/` for `field_usages` before writing this function).
 * Written so that the day Module 04's rule-authoring pipeline against this
 * registry lands and starts writing `used_by = 'rule'` rows, THIS function
 * needs zero changes — it already resolves both branches correctly.
 *
 * Resolves `retrospeq.rules`/`retrospeq.rule_versions` via a plain
 * schema-qualified SQL JOIN on the SAME `withUserConnection` (RLS-scoped)
 * connection, rather than importing anything from `lib/rules/` — Module 03
 * has no existing `lib/fields -> lib/rules` TypeScript import anywhere in
 * this repo (confirmed by grep before writing this), and AGENTS.md's own
 * non-negotiable list specifically calls out "Analytics code cannot import
 * rule code" as a real, CI-enforced import-boundary rule — this function
 * reads directly at the SQL layer instead of introducing a new
 * cross-module TS dependency for a single two-column read, matching this
 * repo's own precedent of doing exactly this kind of narrow cross-table
 * join at the SQL layer elsewhere (e.g. `adherence-display.ts`'s own
 * `fetchRuleRenderedText` join shape, reused here in spirit, not imported).
 */
async function fetchFieldUsageDependents(userId: string, fieldId: string): Promise<FieldUsageDependent[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{
      used_by: 'strategy' | 'rule';
      used_by_id: string;
      label: string | null;
    }>(
      `select fu.used_by, fu.used_by_id,
              coalesce(s.name, rv.rendered) as label
         from retrospeq.field_usages fu
         left join retrospeq.strategies s
           on fu.used_by = 'strategy' and s.user_id = fu.user_id and s.id = fu.used_by_id
         left join retrospeq.rules r
           on fu.used_by = 'rule' and r.user_id = fu.user_id and r.id = fu.used_by_id
         left join retrospeq.rule_versions rv
           on rv.rule_id = r.id and rv.version = r.current_version
        where fu.user_id = $1 and fu.field_id = $2
        order by fu.created_at asc`,
      [userId, fieldId],
    );
    return res.rows.map((row) => ({
      usedBy: row.used_by,
      usedById: row.used_by_id,
      // Fallback for a theoretically-stale field_usages row whose target
      // was itself removed out from under it by some other path (should be
      // structurally rare given the FK/cascade shape, but never worth
      // rendering `label: null` to a trader) -- names the raw kind + id
      // rather than silently dropping the dependent from the list.
      label: row.label ?? `${row.used_by} ${row.used_by_id}`,
    }));
  });
}

export interface RenamedField {
  fieldId: string;
  name: string;
}

/**
 * §4.5's "Rename a field" row, verbatim: "Safe. Id is stable; the name is
 * display only." Order of checks, same "cheap/pure before expensive/DB"
 * discipline `createField` above already establishes:
 *
 *   1. Name shape (`FieldNameInvalidError`, REUSED from `createField` —
 *      same 40-char §5.2 bound, same "not blank" rule; a rename's own name
 *      input has no reason to be validated any differently than a
 *      creation's).
 *   2. One read (`fetchFieldForLifecycleOp`) resolving BOTH "does this
 *      field exist and belong to this user" (`FieldRecordNotFoundError`)
 *      AND "is it derived" (`FieldDerivedImmutableError`) — deliberately
 *      checked here, before ever attempting the UPDATE, so a derived-field
 *      rename attempt gets this slice's own clean, typed error rather than
 *      `fields_forbid_derived_update`'s raw trigger exception (this
 *      dispatch's own explicit instruction: "surfaces that as a clean
 *      error rather than a raw trigger-exception message reaching the
 *      caller" — confirmed by reading the trigger's own body, see this
 *      file's `FieldDerivedImmutableError` doc comment).
 *   3. §4.1's pruning rule (`FieldDuplicatesDerivedError`, REUSED from
 *      `field-validation.ts`'s `checkPruningRule` — the SAME check
 *      `createField` runs) — this dispatch's own explicit instruction:
 *      "renaming a field TO something that duplicates a derived field's
 *      name should be rejected the same way creating it that way would
 *      be." Applied regardless of the field's OWN current state (active or
 *      archived) — §4.1's guard is about the PROPOSED name, not about
 *      whether the field being renamed happens to be visible today.
 *   4. The write itself — one guarded UPDATE, translating a real
 *      `(user_id, name, owner_strategy_id)` collision into
 *      `FieldNameConflictError` (REUSED from `createField`), never a raw
 *      Postgres error — same `isUniqueViolation` catch this file already
 *      uses for creation.
 *
 * Deliberately does NOT require `state = 'active'` — §4.5's own rename row
 * carries no such restriction, and renaming an ARCHIVED field's captured-
 * history label (§4.5's own "captured history is retained" framing for
 * archive) is a reasonable, harmless operation with no invariant it could
 * violate: the two partial unique indexes (`fields_unique_active_scoped`/
 * `fields_unique_active_unscoped`) are BOTH scoped to `state = 'active'`
 * already, so renaming an archived field can never collide with (or be
 * blocked by) an active one, matching this repo's own migration-header
 * reasoning for why that scoping exists at all.
 *
 * Also deliberately does NOT gate on any entitlement capability. §1: "the
 * entire strategy module is Pro" is enforced at the point a non-derived
 * field can come into existence AT ALL — `createField`'s own
 * `FieldEntitlementLimitError` gate (docs/adr/0019) — a free user
 * structurally has ZERO non-derived fields to rename in the first place
 * (their only fields are the 9 permanent `drv.*` rows, already blocked by
 * the derived check above regardless of plan), so a second entitlement
 * check here would be dead code, never reachable by a real free-plan
 * caller. If a future product decision wants a DOWNGRADED former-Pro
 * user's EXISTING fields to become read-only too (mirroring
 * `editStrategy`'s own re-check on every edit, not just at creation), that
 * is a genuine, currently-open follow-up — flagged here, not silently
 * assumed either way.
 */
export async function renameField(userId: string, fieldId: string, newName: string): Promise<RenamedField> {
  const name = newName.trim();
  if (name.length === 0) {
    throw new FieldNameInvalidError('must not be empty.');
  }
  if (name.length > FIELD_NAME_MAX_LENGTH) {
    throw new FieldNameInvalidError(`must be at most ${FIELD_NAME_MAX_LENGTH} characters, got ${name.length}.`);
  }

  const current = await fetchFieldForLifecycleOp(userId, fieldId);
  if (!current) {
    throw new FieldRecordNotFoundError(fieldId);
  }
  if (current.kind === 'derived') {
    throw new FieldDerivedImmutableError(fieldId, 'renamed');
  }

  checkPruningRule(name);

  try {
    return await withUserConnection(userId, async (client) => {
      const res = await client.query<{ name: string }>(
        `update retrospeq.fields
            set name = $3
          where user_id = $1 and id = $2
          returning name`,
        [userId, fieldId, name],
      );
      if ((res.rowCount ?? 0) !== 1) {
        // Should be structurally rare (the field existed a moment ago in
        // fetchFieldForLifecycleOp's own read) -- a concurrent delete/
        // erasure between that read and this write is the only real path
        // here, matching this repo's "re-derive an honest error rather
        // than assume" posture for a lost race elsewhere.
        throw new FieldRecordNotFoundError(fieldId);
      }
      return { fieldId, name: res.rows[0].name };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FieldNameConflictError(name, current.ownerStrategyId);
    }
    throw err;
  }
}

export interface ArchivedField {
  fieldId: string;
  archivedAt: string;
}

/**
 * §4.5's "Remove a field" row, verbatim: "Blocked if any rule references
 * it, naming the rules. Otherwise archives — captured history is
 * retained." A soft-delete (`state = 'archived'`, `archived_at = now()`),
 * never a DELETE — §4.5's own "captured history is retained" framing means
 * `trade_captures` rows (Module 02) referencing this field id must remain
 * valid FOREVER, which a real DELETE (cascading or otherwise) would break.
 *
 * Order of checks:
 *
 *   1. One read (`fetchFieldForLifecycleOp`) resolving "exists and owned"
 *      (`FieldRecordNotFoundError`) and "is it derived"
 *      (`FieldDerivedImmutableError`, §3.2: "never deletable" — read as
 *      extending to "never archivable" too, since §3.2's own catalogue
 *      table describes every derived field's registry row as permanently
 *      `state = 'active'` by construction: nothing in this repo ever sets
 *      a derived field's `state`, `seed_derived_fields_for_user` only ever
 *      INSERTs with the column default `active`, and
 *      `fields_forbid_derived_update` -- confirmed by reading its own WHERE
 *      clause, `if OLD.kind = 'derived' then raise exception` with NO
 *      exception carved out for a `state`-only change -- rejects EVERY
 *      update to a derived row, `state` included, with no narrower
 *      allowlist the way `strategy_versions_forbid_mutation` carves one
 *      out for `superseded_at`. This is the "safest reading" this
 *      dispatch's own instruction asked for, confirmed against the actual
 *      trigger body rather than assumed).
 *   2. IDEMPOTENT no-op for an already-archived field — returns the
 *      existing `archivedAt` rather than re-running the dependency check
 *      or throwing. A judgment call: §4.5's own archive row describes a
 *      ONE-WAY state transition with no "un-archive" path documented
 *      anywhere in this module's spec, so a second `archiveField` call
 *      against an already-archived field reads as a harmless double-click,
 *      not a meaningful new request that ought to re-validate dependents
 *      that may no longer even be relevant to inspect.
 *   3. Dependency check (`fetchFieldUsageDependents`) — a genuinely
 *      informative PRE-check (not the real backstop, see step 4) so a
 *      rejection can name the actual dependents, matching §4.5's own
 *      "naming the rules" wording and §9's `FIELD_IN_USE` row exactly.
 *   4. The write itself — a guarded UPDATE whose own WHERE clause re-checks
 *      `state = 'active'` AND `not exists (... field_usages ...)`
 *      atomically, PLUS (see "CONCURRENCY FIX" below) a `pg_advisory_xact_
 *      lock` keyed on this field's own id, acquired as the FIRST statement
 *      in the same transaction, immediately before that guarded UPDATE. If
 *      the guarded UPDATE returns zero rows, the dependents are RE-fetched
 *      fresh (not reused from step 3) so a race-loser sees an honest,
 *      CURRENT list rather than a stale pre-race one.
 *
 * **CONCURRENCY FIX (2026-09-08, `retrospeq-tester` independent
 * verification pass, `lib/fields/__tests__/fields-repository.lifecycle.
 * independent-verify.live.test.ts`, "GENUINE two-connection TOCTOU probe"
 * — empirically reproduced against the live DB, not simulated):** the
 * guarded UPDATE's own `not exists (select 1 from field_usages ...)`
 * subquery, ON ITS OWN, does NOT close the race it looks like it closes.
 * `field_usages(user_id, field_id) references fields(user_id, id)` makes a
 * `field_usages` INSERT take a `FOR KEY SHARE` tuple lock on the
 * referenced `fields` row; this UPDATE (touching only `state`/
 * `archived_at`, neither part of `fields`' own primary key) takes a `FOR
 * NO KEY UPDATE` lock — and Postgres's own row-lock conflict matrix does
 * NOT consider those two modes to conflict (checked directly against
 * Postgres's own documented lock-compatibility table, not assumed). So a
 * concurrent, still-UNCOMMITTED `field_usages` insert referencing this
 * field is genuinely invisible to this UPDATE's own `not exists` subquery
 * (READ COMMITTED — a fresh snapshot per statement) — nothing blocks this
 * UPDATE from running, its guard sees "no usages," the archive commits,
 * and the concurrent insert then commits too moments later, leaving
 * `state = 'archived'` AND a live `field_usages` row referencing that same
 * field at the same time. Unlike Slice 7's hard-cap race or Slice 10b's
 * create-cap race (both of which a single guarded UPDATE genuinely DOES
 * close, because both sides there contend for the SAME row/lock), this
 * race's two sides touch DIFFERENT tables with no natural lock contention
 * between them, so no guard on `fields` alone — however written — can see
 * a concurrent write to a DIFFERENT table it isn't locking.
 *
 * Fixed by taking `pg_advisory_xact_lock(hashtext(fieldId))` as the FIRST
 * statement of this function's own write transaction, before the guarded
 * UPDATE runs — `rebuildFieldUsagesForStrategy`
 * (`strategy-repository.ts`, called by `createStrategy`/`editStrategy`
 * before either ever inserts a `field_usages` row) acquires the SAME
 * lock, keyed the SAME way, for every field id it is about to reference,
 * before its own insert. Keyed on the FIELD's own id, deliberately NOT the
 * user id (unlike `promoteRuleSeverity`'s user-keyed lock,
 * `severity-lifecycle-repository.ts` — that race's own invariant, "at most
 * 6 hard rules PER USER," is inherently user-scoped, so contending on the
 * user id is correct there; THIS race's invariant is per-field ("this
 * field is not both archived and referenced"), so two DIFFERENT fields
 * being archived/referenced concurrently — even for the SAME user — share
 * no invariant and must NOT serialize against each other; a user-keyed
 * lock here would add pointless cross-field contention for zero
 * correctness benefit). This is a session-level (here, transaction-scoped)
 * advisory lock, released automatically at this transaction's own COMMIT
 * or ROLLBACK (`withUserConnection` owns both) — no unlock call needed or
 * safe to add manually, matching `promoteRuleSeverity`'s own established
 * precedent for this exact mechanism. Whichever side (this function, or a
 * concurrent `rebuildFieldUsagesForStrategy` call referencing the SAME
 * field) acquires the lock first now genuinely blocks the other until it
 * commits or rolls back; the loser's own next statement (a fresh READ
 * COMMITTED snapshot, taken AFTER the wait) then correctly sees the
 * winner's already-committed result — either this UPDATE's own `not
 * exists` subquery now sees the winning `field_usages` insert and
 * correctly no-ops (falling into the zero-rows branch below, which
 * re-fetches and throws `FieldInUseError`), or `rebuildFieldUsagesForStrategy`'s
 * own post-lock state re-check (its own header comment) sees this field
 * already archived and rejects the insert instead — never both succeeding
 * silently at once, the exact corruption class this fix closes. A hash
 * collision between two different field ids (or between a field id here
 * and an unrelated user id elsewhere, e.g. `promoteRuleSeverity`'s own
 * lock keyspace) would only ever cause harmless extra serialization, never
 * a correctness problem — the guarded UPDATE's own WHERE clause still
 * scopes strictly to `id = $2`.
 *
 * Also deliberately does NOT gate on any entitlement capability — same
 * reasoning as `renameField`'s own header (a free user has no non-derived
 * fields to archive in the first place).
 */
export async function archiveField(userId: string, fieldId: string): Promise<ArchivedField> {
  const current = await fetchFieldForLifecycleOp(userId, fieldId);
  if (!current) {
    throw new FieldRecordNotFoundError(fieldId);
  }
  if (current.kind === 'derived') {
    throw new FieldDerivedImmutableError(fieldId, 'archived');
  }
  if (current.state === 'archived') {
    return { fieldId, archivedAt: current.archivedAt! };
  }

  const dependents = await fetchFieldUsageDependents(userId, fieldId);
  if (dependents.length > 0) {
    throw new FieldInUseError(fieldId, dependents);
  }

  return withUserConnection(userId, async (client) => {
    // Serializes against a concurrent `rebuildFieldUsagesForStrategy` call
    // referencing this SAME field id before the guarded UPDATE below runs
    // — see this function's own header ("CONCURRENCY FIX") for why the
    // guarded UPDATE's `not exists` subquery is not, by itself, race-safe
    // against a different table's concurrent uncommitted write.
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [fieldId]);

    const res = await client.query<{ archived_at: string }>(
      `update retrospeq.fields f
          set state = 'archived', archived_at = now()
        where f.user_id = $1 and f.id = $2 and f.state = 'active'
          and not exists (
            select 1 from retrospeq.field_usages fu
             where fu.user_id = $1 and fu.field_id = $2
          )
        returning f.archived_at`,
      [userId, fieldId],
    );
    if ((res.rowCount ?? 0) !== 1) {
      const freshDependents = await fetchFieldUsageDependents(userId, fieldId);
      if (freshDependents.length > 0) {
        throw new FieldInUseError(fieldId, freshDependents);
      }
      // No dependents now either -- the field itself must have been
      // concurrently archived/deleted between our own reads and this
      // write (the one other branch the guard's WHERE clause can fail on).
      throw new FieldRecordNotFoundError(fieldId);
    }
    return { fieldId, archivedAt: res.rows[0].archived_at };
  });
}

// =======================================================================
// §4.5 — decisions this slice made explicit, not silently, per this
// slice's own dispatch instruction. Neither of the two rows below has any
// function built against it in this file.
// =======================================================================
//
// --- "Change a field's type" -- NOT a mutation, no new function needed ---
//
// §4.5, verbatim: "Not an edit. Creates a new field with a new id.
// Reinterpreting a 1-5 rating as a number retroactively corrupts history."
// This reads as a description of an OUTCOME (a "type change" is really two
// independent, already-buildable operations composed by the CALLER), not a
// spec for a new, single atomic function. `createField` (above, Slice 03c)
// already creates a field with any `dataType`; nothing about "the trader is
// replacing an existing field" changes what that call needs to do.
//
// THE JUDGMENT CALL THIS DISPATCH ASKED TO BE MADE EXPLICITLY, NOT ASSUMED:
// does the OLD field get auto-archived as a side effect of creating its
// "replacement"? Decided: NO -- `createField` and `archiveField` remain two
// separate, independently-callable operations; there is no
// `changeFieldType` wrapper that chains them. Reasoning:
//
//   1. §4.5's own row does not say the old field is archived automatically
//      -- re-read carefully, twice, before writing this comment. It
//      describes what changing a type WOULD corrupt if done in place
//      (motivating "create a new field instead"), not what happens to the
//      OLD field once the new one exists.
//   2. The old field's own captured history remains valid and useful ON
//      ITS OWN TERMS forever (§4.5's "captured history is retained" framing
//      for archive already establishes this is a normal, accepted state
//      for a field to be in) -- silently archiving it as a side effect of
//      an unrelated "create a new field" call is a surprising behaviour a
//      caller did not ask for and this function has no way to make
//      reversible if it guessed wrong.
//   3. A caller that genuinely wants "replace field X with a same-shaped Y
//      under a new type, and retire X" can already express that exactly as
//      two explicit, independent calls: `createField(...)` then, if and
//      only if they also want X gone, `archiveField(userId, X)` -- no
//      information is lost by requiring both, and nothing forces the
//      second call for a caller who wants to keep X capturing IN PARALLEL
//      with the new field (a real, legitimate use case §4.5's own wording
//      does not rule out).
//
// A dedicated `changeFieldType` wrapper would therefore only ever do
// `createField(...)` (optionally followed by `archiveField(...)`) with zero
// real logic of its own beyond composing two already-independently-tested
// functions -- not built, per this slice's own dispatch instruction to
// confirm this reading rather than build an unnecessary wrapper.
//
// --- Add/remove a pick_one/pick_many OPTION -- explicitly DEFERRED ---
//
// §4.5: "Add an option: Safe... Remove an option: Archives the option.
// Existing captures retain it; it stops being offered." DELIBERATELY NOT
// BUILT in this slice -- explicitly deferred, not silently skipped:
//
//   - Adding an option is a `config.options[]` APPEND on an EXISTING field
//     row -- unlike a type change (which creates a brand-new field/id) or
//     archive (a single top-level `state` column), this mutates ONE
//     field's `config` jsonb IN PLACE.
//   - Removing an option needs a genuinely different shape of change than
//     either operation this slice DID build: "existing captures retain it,
//     it stops being offered" means the OPTION ITSELF needs some kind of
//     soft-archive marker WITHIN the `config` jsonb (e.g. a per-option
//     `archived: true` flag, or a parallel `archivedOptions[]` list) --
//     there is no such shape anywhere in this schema today (see the
//     comment on `normalizeFieldConfig` above, near `createField` --
//     `config` is currently a bare `{ options: string[] }` for these two
//     types, per `normalizeFieldConfig`'s own switch above), and designing
//     it well (does removal need its OWN timestamp? does a picker need to
//     distinguish "never offered" from "offered, then archived, then a
//     trader's old capture still shows it"?) is real design work this
//     dispatch's own scope does not cover.
//   - No existing caller in this repo needs it yet (no field-editor UI
//     exists at all, per this slice's own explicit "no UI" scope boundary)
//     -- deferring costs nothing today and avoids guessing a config shape a
//     future field-editor slice would have to either live with or migrate
//     away from.
//
// Flagged here (per this slice's own dispatch instruction, "so it's not
// silently forgotten") as a genuine, currently-unclaimed Module 03 gap --
// the natural home for it is whichever future slice builds the real field-
// editor UI (§5.2's own reference markup already shows a `pick_one`/
// `pick_many` options editor), since option add/remove has no standalone
// product surface without one.
