import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { computeAllPromptCandidates } from '../index';
import { findGraduationCandidates } from '../graduation-candidates';
import { findRelaxationCandidates } from '../relaxation-candidates';
import { findPromotionCandidates } from '../promotion-candidates';
import { findRetirementDecayCandidates } from '../retirement-decay-candidates';
import { findRetirementConditionCandidates } from '../retirement-condition-candidates';
import { findDetectionCandidates } from '../detection-candidates';
import { fetchMutedSubjectKeys } from '../prompt-history-repository';

vi.mock('server-only', () => ({}));

/**
 * Module 06 (Review & Graduation) Slice 3 — a self-check smoke test
 * against the real shared dev Supabase project, per this repo's own
 * "coder self-verifies before handoff" convention. NOT the full seeded
 * integration suite (boundary values, real graduated rules + decayed
 * findings, real trigger-condition histories, real muted subjects) — that
 * is `retrospeq-tester`'s job per this slice's own dispatch instruction.
 *
 * What THIS file proves, against the real live schema (not a mock): every
 * one of the six finders' raw SQL is syntactically valid (a wrong column
 * name or a bad join only ever surfaces at real query execution time, and
 * a mocked-client unit test can never catch that), every finder runs
 * cleanly under real RLS (`withUserConnection`) for a brand-new user with
 * zero data, and every finder honestly returns an EMPTY array rather than
 * throwing or fabricating a candidate — "not enough data yet" is the
 * correct state for a fresh user (AGENTS.md non-negotiable), asserted here
 * for every single kind at once.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/prompt-candidates (live DB, brand-new user)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every finder runs without throwing and returns an empty array for a brand-new user', async () => {
    const user = await createTestAuthUser(envBundle, 'prompt-candidates-smoke');
    cleanupUserIds.push(user.id);

    await expect(findGraduationCandidates(user.id)).resolves.toEqual([]);
    await expect(findRelaxationCandidates(user.id)).resolves.toEqual([]);
    await expect(findPromotionCandidates(user.id)).resolves.toEqual([]);
    await expect(findRetirementDecayCandidates(user.id)).resolves.toEqual([]);
    await expect(findRetirementConditionCandidates(user.id)).resolves.toEqual([]);
    await expect(findDetectionCandidates(user.id)).resolves.toEqual([]);
    await expect(fetchMutedSubjectKeys(user.id)).resolves.toEqual(new Set());
  }, 30_000);

  it('computeAllPromptCandidates composes all six finders into one honest, empty result', async () => {
    const user = await createTestAuthUser(envBundle, 'prompt-candidates-smoke-composed');
    cleanupUserIds.push(user.id);

    const result = await computeAllPromptCandidates(user.id);
    expect(result).toEqual({
      graduation: [],
      relaxation: [],
      promotion: [],
      retirementDecay: [],
      retirementCondition: [],
      detection: [],
    });
  }, 30_000);
});
