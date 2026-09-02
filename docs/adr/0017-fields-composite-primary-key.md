# ADR 0017 — `fields.id` is a composite `(user_id, id)` primary key, not a bare global text PK

- **Status:** Accepted
- **Date:** 2026-09-02
- **Deviates from:** Module 03 (Field Registry & Strategy) §3.1's own
  literal DDL (`id text primary key`) — NOT a 00-foundation convention
  directly, though it builds on top of one: 00-foundation §2.1 already
  says "all primary keys are UUID v7," and Module 03 §3.1 already
  deviates from THAT (`id` is a stable string, e.g. `'acct.conviction'`,
  `'str.<uuid>.pd_array'`, `'drv.risk_pct'`) for a documented, sound
  reason — rule/AI authoring needs a stable, human-legible reference a
  UUID doesn't give for free. This ADR is a second, narrower deviation on
  top of that first one: not "should the id be a string" (§3.1 already
  answered that), but "is that string globally unique across every user,
  or scoped to one."
- **Context:** Module 03 field-registry schema slice
  (`supabase/migrations/20260902010000_field_registry_schema.sql`),
  building the `fields` table and §3.2's 9-entry derived-field seed
  catalogue.

## The decision

`fields`' primary key is the composite `(user_id, id)`, not a bare `id`.
Every foreign key that would otherwise reference a lone `fields.id`
(`field_usages.field_id`) is written as a composite
`(user_id, <col>) references fields(user_id, id)` instead.

## Why

§3.1's own literal DDL declares `id text primary key` — one single,
global text primary key shared by every row in the whole table,
regardless of which user owns it. §3.2, in the very same section,
describes the derived-field seed catalogue as inserting the **exact same
literal id string** (`'drv.session'`, `'drv.risk_pct'`, etc.) **for every
user**, at signup, via `handle_new_user`. Those two statements cannot
both be true under a bare global text PK: the moment a SECOND user signs
up, `handle_new_user`'s attempt to insert a row with
`id = 'drv.risk_pct'` for that user collides with the FIRST user's
already-existing row of the same id, and the insert fails outright — not
a rare edge case, a guaranteed failure on literally the second signup
ever, breaking the product for every user after the first.

This was caught before it ever shipped: while writing this migration,
re-reading §3.1 and §3.2 together (not in isolation, the way a
transcription pass might) surfaced the contradiction directly, and it was
verified concretely — 328 real profiles already existed in the shared
dev/test project at the time this migration was applied, all now
correctly carrying their own independent `drv.*` rows with no PK
collision, which a bare global `id text primary key` could never have
allowed past the second one.

`(user_id, id)` resolves the contradiction the way both halves of §3.1/
§3.2 clearly intend: `id` is a stable string **scoped to one user's own
registry**, not a single flat namespace shared by the whole table. This
is consistent with how §3.1's own comment frames the string in the first
place — `'acct.conviction'`, not `'<user-uuid>.acct.conviction'` — the
string was never designed to be self-disambiguating across users; it
relies on SOME surrounding scope to be unique, and the natural scope is
the owning user, exactly the same way `rule_versions`' composite
`(rule_id, version)` primary key scopes `version` to one rule rather than
inventing a globally-unique version number.

## What this costs

- Every foreign key elsewhere in the schema that names a `fields` row
  must carry `user_id` alongside the field id, not just the id alone —
  slightly more verbose DDL (`field_usages.field_id text` plus a
  composite FK, rather than a single-column FK) and, in application code,
  every future query/repository function that looks up a field must pass
  `(userId, fieldId)` as a pair, never `fieldId` alone. This is a real,
  permanent shape constraint on every future Module 03 (and Module 04/05
  cross-referencing) slice, not just a one-time migration detail — worth
  flagging explicitly here so a future slice's own repository code
  doesn't have to re-derive it from first principles or, worse, silently
  assume a bare `id` lookup works and get a wrong/missing row.
- Module 04's own rule-authoring pipeline, if it ever stores a `field_id`
  directly (rather than going through an `operand_id` translation layer —
  see the open naming-overlap question flagged directly in this
  migration's own header comment, not resolved by this ADR), will need
  the same `(user_id, field_id)` pairing discipline. Not building that
  integration is out of this slice's own scope; this ADR exists so the
  slice that DOES build it inherits the right shape from day one instead
  of rediscovering this exact PK-collision class of bug the hard way.

## Alternatives considered and rejected

**Keep the bare global `id text primary key`, and make user-created field
ids (not just derived ones) embed a UUID for unavoidable uniqueness** (as
§3.1's own `'str.<uuid>.pd_array'` example already does for
`strategy_var` fields). Rejected: this still does not fix the derived-field
collision, since §3.2 requires the SAME literal `drv.*` strings for every
user by design (Module 04/05's own future code is meant to reference
`'drv.risk_pct'` directly, not a per-user-randomised variant of it) — the
collision is inherent to "one global namespace, but some ids are
intentionally identical across users," which no amount of UUID-embedding
on the OTHER (non-derived) ids would resolve.

**Give derived fields a different, per-user-unique id shape (e.g.
`'drv.<user-uuid>.risk_pct'`) while leaving the primary key bare-global.**
Rejected: this directly contradicts this slice's own explicit dispatch
instruction ("confirm your migration's seed data uses these EXACT id
strings verbatim, since Module 04/05's own future code will reference
them by these literal ids") and Module 03 §3.2's own literal catalogue
table, which names `drv.risk_pct` etc. with no per-user suffix anywhere.
Inventing a suffix would also mean two different naming conventions for
derived vs. account/strategy_var fields, adding conceptual surface area
for no real benefit once the composite-PK fix already solves the
underlying problem cleanly for every field kind uniformly.

## Consequences

- `fields`' real primary key, everywhere in this codebase from this
  migration forward, is `(user_id, id)`. Any future migration or
  application code that assumes `id` alone is globally unique will be
  wrong and should be caught in review against this ADR.
- `field_usages.field_id` and any other future FK into `fields` must be
  composite, carrying `user_id` alongside the field id — already applied
  in this migration to `field_usages` itself.
- This does NOT change anything about how field ids are DISPLAYED or
  AUTHORED (`'drv.risk_pct'` is still the string a trader, Module 04, or
  Module 05 sees and reasons about) — it only changes how the database
  enforces uniqueness underneath that string. No product-facing behavior
  changes as a result of this ADR.
