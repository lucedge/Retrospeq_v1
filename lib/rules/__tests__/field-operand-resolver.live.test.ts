import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * ADR 0046 — custom fields as rule operands, live-DB ownership proof.
 *
 * The unit tests (`field-operand-catalogue.test.ts`,
 * `field-operand-resolver.test.ts`) cover parsing and the type→ops
 * mapping with the repository mocked. What can only be proven live is the
 * half the decision is strictest about: "the id must resolve to a field
 * the caller owns … unknown or unowned id is rejected at write and at
 * evaluate." That is an RLS-enforced read, so it is tested against real
 * rows for two real users.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('resolveFieldOperandForRule — ownership and state (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 60_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 120_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  /** One account-kind rating field, the decision's own "conviction" use
   *  case. Single statement — the DB is remote (~112ms per round trip). */
  async function seedConvictionField(userId: string): Promise<string> {
    const fieldId = `acct.${crypto.randomUUID()}`;
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config, state)
       values ($1, $2, 'Conviction', 'account', 'rating', 'captured', '{"min":1,"max":5}'::jsonb, 'active')`,
      [fieldId, userId],
    );
    return fieldId;
  }

  it(
    'resolves the owner\'s own active field, and rejects another user\'s field id outright',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(envBundle, 'fieldop-owner');
      cleanupUserIds.push(owner.id);
      const stranger = await createTestAuthUser(envBundle, 'fieldop-stranger');
      cleanupUserIds.push(stranger.id);

      const ownField = await seedConvictionField(owner.id);
      const strangerField = await seedConvictionField(stranger.id);

      const { resolveFieldOperandForRule } = await import('../field-operand-resolver');
      const { FieldOperandNotFoundError } = await import('../field-operand-catalogue');

      // The owner's own field resolves to a real, typed catalogue entry
      // carrying the field's own bounds — never a guessed shape.
      const entry = await resolveFieldOperandForRule(owner.id, `field:${ownField}`, 'global', null);
      expect(entry.id).toBe(`field:${ownField}`);
      expect(entry.label).toBe('Conviction');
      expect(entry.group).toBe('field');
      expect(entry.bounds).toMatchObject({ min: 1, max: 5 });

      // The stranger's field id, presented by the owner, is rejected —
      // the exact "unowned id" case the decision names. RLS makes it
      // invisible; the resolver turns that into an honest named error.
      await expect(
        resolveFieldOperandForRule(owner.id, `field:${strangerField}`, 'global', null),
      ).rejects.toBeInstanceOf(FieldOperandNotFoundError);

      // A well-formed id for a field nobody owns is rejected the same way.
      await expect(
        resolveFieldOperandForRule(owner.id, `field:acct.${crypto.randomUUID()}`, 'global', null),
      ).rejects.toBeInstanceOf(FieldOperandNotFoundError);
    },
    120_000,
  );

  it(
    'stops resolving a field once it is archived — the authored rule cannot keep evaluating against it',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(envBundle, 'fieldop-archive');
      cleanupUserIds.push(owner.id);
      const fieldId = await seedConvictionField(owner.id);

      const { resolveFieldOperandForRule } = await import('../field-operand-resolver');
      const { FieldOperandNotFoundError } = await import('../field-operand-catalogue');

      // Authorable while active…
      await expect(resolveFieldOperandForRule(owner.id, `field:${fieldId}`, 'global', null)).resolves.toBeTruthy();

      await db.query("update retrospeq.fields set state = 'archived' where id = $1 and user_id = $2", [fieldId, owner.id]);

      // …and refused the moment it is archived. At evaluate time this is
      // what surfaces as a loud anomaly with NO rule_evaluations row,
      // rather than a fabricated evaluation (ADR 0046, freeze path).
      await expect(
        resolveFieldOperandForRule(owner.id, `field:${fieldId}`, 'global', null),
      ).rejects.toBeInstanceOf(FieldOperandNotFoundError);
    },
    120_000,
  );
});
