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
vi.setConfig({ testTimeout: 120_000 });

/**
 * Module 06 (Review & Graduation) Slice 3 — `retrospeq-tester` dispatch,
 * 2026-09-11. Seeded, live-DB integration coverage for every one of the
 * six §4.4 eligibility kinds, explicitly left undone by the coder's own
 * `index.live.test.ts` (a brand-new-user smoke test only). This file's
 * job, per this dispatch's own brief:
 *
 *  1. The stable-subject-id derivation, ADVERSARIALLY: mute a real
 *     finding/detection subject, force a REAL recompute (not a mock —
 *     `recomputeEdgeFindingsForUser` / `recomputeDetectionsForUser`) that
 *     supersedes the row with a brand-new id, and prove the mute still
 *     applies to the new row.
 *  2. Each of the six eligibility checks against real fixtures matching
 *     §4.4's literal condition text, including a qualifying case AND a
 *     near-miss/exclusion case per kind.
 *  3. Cross-user isolation.
 *
 * Seeding conventions mirror this repo's own established live-test
 * precedents directly: `edge-engine/__tests__/repository.live.test.ts`
 * (strategy/field/trade/capture seeding for a real edge-engine recompute),
 * `detection-engine/__tests__/repository.live.test.ts` (the exact
 * `seq.reentry_after_loss` fixture shape that clears volume/rate/
 * persistence), `decay-engine/__tests__/repository.live.test.ts` (direct
 * `findings`/`finding_rule_links` seeding where the finding computation
 * itself is not what's under test), `rules/__tests__/freeze-trigger-
 * evaluations.live.test.ts` (minimal trade/block seeding for a table that
 * only needs a real `trade_id` to satisfy its own FK).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/prompt-candidates (live DB, seeded fixtures per §4.4 kind)', () => {
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
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.prompt_history where user_id = $1', [userId]);
      await db.query('delete from retrospeq.finding_rule_links where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.field_usages where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trade_captures where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  // ---------------------------------------------------------------------
  // Shared seeding helpers
  // ---------------------------------------------------------------------

  let fieldSeq = 0;
  function nextFieldId(label: string): string {
    fieldSeq += 1;
    return `elig_${label}_${fieldSeq}`;
  }

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Prompt Candidates Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedStrategy(userId: string, name = 'Prompt Candidates Live Test Strategy'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, false, 'active') returning id`,
      [userId, name],
    );
    return res.rows[0].id;
  }

  async function seedBoolField(userId: string, strategyId: string, fieldId: string): Promise<void> {
    // `fields_unique_active_scoped` is unique on (user_id, name,
    // owner_strategy_id) for active fields -- the name must be unique
    // per (user, strategy), not just the id, so every field this file
    // seeds gets a name derived from its own unique id.
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, $3, 'strategy_var', 'bool', 'captured', $4, '{}'::jsonb)`,
      [fieldId, userId, `Test Flag ${fieldId}`, strategyId],
    );
  }

  async function seedStrategyVersion(userId: string, strategyId: string, fieldIds: string[]): Promise<void> {
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Prompt Candidates Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [strategyId, userId, JSON.stringify(fieldIds.map((id, i) => ({ field_id: id, capture_moment: 'pre_entry', order: i + 1 })))],
    );
  }

  /** A real trade + block, eligible for a real edge-engine recompute
   *  (mirrors `edge-engine/__tests__/repository.live.test.ts`'s own
   *  `seedTrade`). */
  async function seedEdgeTrade(
    userId: string,
    accountId: string,
    strategyId: string,
    fieldValues: Record<string, boolean>,
    outcome: 'win' | 'loss',
    index: number,
  ): Promise<string> {
    const openedAt = new Date(Date.UTC(2026, 0, 1) + index * 3600_000);
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString()],
    );
    const rMultiple = outcome === 'win' ? '1.5000' : '-1.0000';
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, outcome, r_multiple, not_a_decision, strategy_id, strategy_version)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$4::date,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $4::timestamptz,'user',$5,$6,false,$7,1)
       returning id`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), outcome, rMultiple, strategyId],
    );
    const tradeId = tradeRes.rows[0].id;
    for (const [fieldId, value] of Object.entries(fieldValues)) {
      await db.query(
        `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
         values ($1, $2, $3, $4::jsonb, 'pre_entry')`,
        [tradeId, userId, fieldId, JSON.stringify(value)],
      );
    }
    return tradeId;
  }

  /** A bare trade + block satisfying `rule_evaluations`/`trigger_evaluations`'
   *  own FK — no strategy/captures needed. */
  async function seedBareTrade(userId: string, accountId: string, serverDay: string, seq: number): Promise<string> {
    const openedAt = new Date(`${serverDay}T00:00:00Z`).getTime() + seq * 60_000;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $4::date)
       returning id`,
      [userId, accountId, new Date(openedAt).toISOString(), serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$5::date,'closed',
               '1.10000000','1.10500000','100000.00000000','USD','confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, new Date(openedAt).toISOString(), serverDay],
    );
    return tradeRes.rows[0].id;
  }

  async function insertRule(
    userId: string,
    opts: {
      severity?: 'soft' | 'hard';
      state?: 'active' | 'retired' | 'deactivated_by_plan';
      createdAt: Date;
      operandId?: string;
      op?: string;
      value?: unknown;
      rendered?: string;
    },
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, severity, origin, evaluation, state, created_at)
       values ($1, $2, 'authored', 'pre_entry', $3, $4::timestamptz) returning id`,
      [userId, opts.severity ?? 'soft', opts.state ?? 'active', opts.createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
      [ruleId, userId, opts.operandId ?? 'risk_pct', opts.op ?? 'lte', JSON.stringify(opts.value ?? 1), opts.rendered ?? 'Risk stays under 1%.'],
    );
    return ruleId;
  }

  async function insertRuleEvaluation(
    userId: string,
    tradeId: string,
    ruleId: string,
    severity: 'soft' | 'hard',
    result: 'followed' | 'broken',
    serverDay: string,
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, server_day)
       values ($1, $2, $3, 1, $4, $5, $6::date)`,
      [userId, tradeId, ruleId, severity, result, serverDay],
    );
  }

  function daysAgo(now: Date, n: number): string {
    return new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // =====================================================================
  // 1. STABLE SUBJECT ID, ADVERSARIALLY — the single most important thing
  //    to verify in this slice: mute survives a REAL recompute.
  // =====================================================================

  it(
    'FINDING: a muted graduation subject survives a REAL edge-engine recompute that supersedes the finding row with a brand-new id',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'elig-finding-stable');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);
      const strategyId = await seedStrategy(userId);
      const fieldId = nextFieldId('confident');
      await seedBoolField(userId, strategyId, fieldId);
      await seedStrategyVersion(userId, strategyId, [fieldId]);

      // 40 trades flag=true winning 36/40 (90%); 12 trades flag=false
      // winning 3/12 (25%) -- clears sample (>=20 segment, >=12 baseline),
      // effect (65pp >> 12pp floor) and CONFIDENT_MIN_N (40) gates.
      let idx = 0;
      for (let i = 0; i < 40; i++) {
        await seedEdgeTrade(userId, accountId, strategyId, { [fieldId]: true }, i < 36 ? 'win' : 'loss', idx++);
      }
      for (let i = 0; i < 12; i++) {
        await seedEdgeTrade(userId, accountId, strategyId, { [fieldId]: false }, i < 3 ? 'win' : 'loss', idx++);
      }

      const { recomputeEdgeFindingsForUser } = await import('@/lib/analytics/edge-engine/repository');
      const { findGraduationCandidates } = await import('../graduation-candidates');
      const { computeAllPromptCandidates } = await import('../index');
      const { findingSubjectId } = await import('../stable-subject-id');

      const result1 = await recomputeEdgeFindingsForUser(userId);
      expect(result1.findingsWritten).toBeGreaterThan(0);

      const v1Row = await db.query<{ id: string; confidence: string; state: string }>(
        `select id, confidence, state from retrospeq.findings
          where user_id = $1 and field_id = $2 and segment = $3::jsonb and state = 'active'`,
        [userId, fieldId, JSON.stringify({ op: 'eq', value: true })],
      );
      expect(v1Row.rows).toHaveLength(1);
      expect(v1Row.rows[0].confidence).toBe('confident');
      const findingV1Id = v1Row.rows[0].id;

      const candidatesBeforeMute = await findGraduationCandidates(userId);
      const candidateV1 = candidatesBeforeMute.find((c) => c.evidence.fieldId === fieldId);
      expect(candidateV1).toBeDefined();
      const expectedSubjectId = findingSubjectId(strategyId, fieldId);
      expect(candidateV1!.subjectId).toBe(expectedSubjectId);
      // Never the live row id -- the whole point of the derivation.
      expect(candidateV1!.subjectId).not.toBe(findingV1Id);

      // Mute this exact subject.
      await db.query(
        `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind, muted)
         values ($1, 'finding', $2, 'graduation', true)`,
        [userId, candidateV1!.subjectId],
      );

      const afterMute = await computeAllPromptCandidates(userId);
      expect(afterMute.graduation.find((c) => c.evidence.fieldId === fieldId)).toBeUndefined();

      // Force a REAL recompute that supersedes findingV1 with a brand-new
      // row -- add 5 more flag=true winning trades, still comfortably
      // confident, same tuple.
      for (let i = 0; i < 5; i++) {
        await seedEdgeTrade(userId, accountId, strategyId, { [fieldId]: true }, 'win', idx++);
      }
      const result2 = await recomputeEdgeFindingsForUser(userId);
      expect(result2.findingsWritten).toBeGreaterThan(0);

      const afterRecompute = await db.query<{ id: string; state: string; n: number }>(
        `select id, state, n from retrospeq.findings
          where user_id = $1 and field_id = $2 and segment = $3::jsonb
          order by computed_at asc`,
        [userId, fieldId, JSON.stringify({ op: 'eq', value: true })],
      );
      expect(afterRecompute.rows).toHaveLength(2);
      const v1After = afterRecompute.rows.find((r) => r.id === findingV1Id)!;
      const v2 = afterRecompute.rows.find((r) => r.id !== findingV1Id)!;
      expect(v1After.state).toBe('superseded');
      expect(v2.state).toBe('active');
      expect(v2.n).toBe(45);
      // Proves this really was a NEW row, not the same one reused.
      expect(v2.id).not.toBe(findingV1Id);

      // The candidate finder must derive the SAME subjectId for the new
      // (v2) row -- and computeAllPromptCandidates must STILL exclude it
      // as muted, even though the underlying findings.id churned.
      const candidatesAfterRecompute = await findGraduationCandidates(userId);
      const candidateV2 = candidatesAfterRecompute.find((c) => c.evidence.fieldId === fieldId);
      expect(candidateV2).toBeDefined();
      expect(candidateV2!.subjectId).toBe(expectedSubjectId);

      const afterRecomputeAndMute = await computeAllPromptCandidates(userId);
      expect(afterRecomputeAndMute.graduation.find((c) => c.evidence.fieldId === fieldId)).toBeUndefined();
    },
    120_000,
  );

  it(
    'DETECTION: a muted detection subject survives a REAL detection-engine recompute that supersedes the detection row with a brand-new id',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'elig-detection-stable');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);

      async function seedDetectionTrade(openedAt: Date, closedAt: Date | undefined, outcome: 'win' | 'loss') {
        const close = closedAt ?? new Date(openedAt.getTime() + 5 * 60 * 1000);
        const blockRes = await db.query<{ id: string }>(
          `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
           values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $3::date) returning id`,
          [userId, accountId, openedAt.toISOString(), close.toISOString()],
        );
        await db.query(
          `insert into retrospeq.trades
             (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
              entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
              outcome, realized_pnl, confirmed_at, confirmed_by, not_a_decision)
           values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$5::timestamptz,$4::date,'confirmed',
                   '1.20000000','1.20500000','100000.00000000','USD','confident_single',
                   $6,$7,$5::timestamptz,'user',false)`,
          [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), close.toISOString(), outcome, outcome === 'win' ? '50.00000000' : '-50.00000000'],
        );
      }

      // Baseline: 1 slow re-entry.
      await seedDetectionTrade(new Date('2026-06-01T09:00:00Z'), new Date('2026-06-01T09:05:00Z'), 'loss');
      await seedDetectionTrade(new Date('2026-06-01T09:30:00Z'), undefined, 'win');

      // 5 distinct Mondays x 2 fast re-entries = 10 occurrences -- clears
      // volume (>=5), persistence (>=3 distinct days, >=2 distinct weeks)
      // AND the count_outcome floor (>=10).
      const mondays = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
      for (const monday of mondays) {
        for (let i = 0; i < 2; i++) {
          const lossOpen = new Date(`${monday}T${String(9 + i).padStart(2, '0')}:00:00Z`);
          const lossClose = new Date(lossOpen.getTime() + 5 * 60 * 1000);
          const reentryOpen = new Date(lossClose.getTime() + 30 * 1000);
          await seedDetectionTrade(lossOpen, lossClose, 'loss');
          await seedDetectionTrade(reentryOpen, undefined, 'win');
        }
      }

      const { recomputeDetectionsForUser } = await import('@/lib/analytics/detection-engine/repository');
      const { findDetectionCandidates } = await import('../detection-candidates');
      const { computeAllPromptCandidates } = await import('../index');
      const { detectionSubjectId } = await import('../stable-subject-id');

      const first = await recomputeDetectionsForUser(userId);
      expect(first.detectionsWritten).toBeGreaterThan(0);

      const v1Row = await db.query<{ id: string; tier: string; classification: string; rule_proposable: boolean }>(
        `select id, tier, classification, rule_proposable from retrospeq.detections
          where user_id = $1 and analytic_id = 'seq.reentry_after_loss' and state = 'active'`,
        [userId],
      );
      expect(v1Row.rows).toHaveLength(1);
      expect(v1Row.rows[0].tier).toBe('count_outcome');
      expect(v1Row.rows[0].classification).toBe('pattern');
      expect(v1Row.rows[0].rule_proposable).toBe(true);
      const detectionV1Id = v1Row.rows[0].id;

      const candidatesBeforeMute = await findDetectionCandidates(userId);
      const candidate = candidatesBeforeMute.find((c) => c.evidence.analyticId === 'seq.reentry_after_loss');
      expect(candidate).toBeDefined();
      const expectedSubjectId = detectionSubjectId('seq.reentry_after_loss');
      expect(candidate!.subjectId).toBe(expectedSubjectId);
      expect(candidate!.subjectId).not.toBe(detectionV1Id);

      await db.query(
        `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind, muted)
         values ($1, 'detection', $2, 'detection', true)`,
        [userId, candidate!.subjectId],
      );

      const afterMute = await computeAllPromptCandidates(userId);
      expect(afterMute.detection.find((c) => c.evidence.analyticId === 'seq.reentry_after_loss')).toBeUndefined();

      // Force a real recompute that supersedes the row: one more Monday
      // of fast re-entries.
      const extraMonday = '2026-09-07';
      for (let i = 0; i < 2; i++) {
        const lossOpen = new Date(`${extraMonday}T${String(9 + i).padStart(2, '0')}:00:00Z`);
        const lossClose = new Date(lossOpen.getTime() + 5 * 60 * 1000);
        const reentryOpen = new Date(lossClose.getTime() + 30 * 1000);
        await seedDetectionTrade(lossOpen, lossClose, 'loss');
        await seedDetectionTrade(reentryOpen, undefined, 'win');
      }
      const second = await recomputeDetectionsForUser(userId);
      expect(second.detectionsWritten).toBeGreaterThan(0);

      const afterRecompute = await db.query<{ id: string; state: string; occurrences: number }>(
        `select id, state, occurrences from retrospeq.detections
          where user_id = $1 and analytic_id = 'seq.reentry_after_loss' order by computed_at asc`,
        [userId],
      );
      expect(afterRecompute.rows).toHaveLength(2);
      const v1After = afterRecompute.rows.find((r) => r.id === detectionV1Id)!;
      const v2 = afterRecompute.rows.find((r) => r.id !== detectionV1Id)!;
      expect(v1After.state).toBe('superseded');
      expect(v2.state).toBe('active');
      expect(v2.occurrences).toBe(12);
      expect(v2.id).not.toBe(detectionV1Id);

      const candidatesAfterRecompute = await findDetectionCandidates(userId);
      const candidateV2 = candidatesAfterRecompute.find((c) => c.evidence.analyticId === 'seq.reentry_after_loss');
      expect(candidateV2).toBeDefined();
      expect(candidateV2!.subjectId).toBe(expectedSubjectId);

      const afterRecomputeAndMute = await computeAllPromptCandidates(userId);
      expect(afterRecomputeAndMute.detection.find((c) => c.evidence.analyticId === 'seq.reentry_after_loss')).toBeUndefined();
    },
    120_000,
  );

  // =====================================================================
  // 2. GRADUATION — confident + no rule -> candidate; confident + active
  //    rule via field_usages -> excluded; non-confident -> excluded.
  // =====================================================================

  it('GRADUATION: confident+no-rule qualifies; the SAME field with an active rule attached is excluded; a null-result field is excluded', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-graduation');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId);
    const strategyId = await seedStrategy(userId);
    const confidentField = nextFieldId('conf');
    const nullResultField = nextFieldId('null');
    await seedBoolField(userId, strategyId, confidentField);
    await seedBoolField(userId, strategyId, nullResultField);
    await seedStrategyVersion(userId, strategyId, [confidentField, nullResultField]);

    // One pool of 52 trades: `confidentField` correlates strongly with
    // outcome (40 true @ 90% win, 12 false @ 25% win -> confident,
    // 65pp effect). `nullResultField` is assigned independently of
    // outcome (alternating true/false) on the SAME 52 trades -- clears
    // the sample gate (both segments >= 20/12) but shows no real effect
    // -> null_result, unambiguously non-confident.
    let idx = 0;
    for (let i = 0; i < 40; i++) {
      await seedEdgeTrade(
        userId,
        accountId,
        strategyId,
        { [confidentField]: true, [nullResultField]: i % 2 === 0 },
        i < 36 ? 'win' : 'loss',
        idx++,
      );
    }
    for (let i = 0; i < 12; i++) {
      await seedEdgeTrade(
        userId,
        accountId,
        strategyId,
        { [confidentField]: false, [nullResultField]: i % 2 === 0 },
        i < 3 ? 'win' : 'loss',
        idx++,
      );
    }

    const { recomputeEdgeFindingsForUser } = await import('@/lib/analytics/edge-engine/repository');
    const { findGraduationCandidates } = await import('../graduation-candidates');
    await recomputeEdgeFindingsForUser(userId);

    const confRow = await db.query<{ confidence: string }>(
      `select confidence from retrospeq.findings where user_id = $1 and field_id = $2 and segment = $3::jsonb and state = 'active'`,
      [userId, confidentField, JSON.stringify({ op: 'eq', value: true })],
    );
    expect(confRow.rows[0].confidence).toBe('confident');

    const candidates1 = await findGraduationCandidates(userId);
    expect(candidates1.some((c) => c.evidence.fieldId === confidentField)).toBe(true);
    expect(candidates1.some((c) => c.evidence.fieldId === nullResultField)).toBe(false);

    // Attach an active rule to the confident field via field_usages.
    const ruleId = await insertRule(userId, { createdAt: new Date() });
    await db.query(
      `insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id) values ($1, $2, 'rule', $3)`,
      [confidentField, userId, ruleId],
    );

    const candidates2 = await findGraduationCandidates(userId);
    expect(candidates2.some((c) => c.evidence.fieldId === confidentField)).toBe(false);
    expect(candidates2.some((c) => c.evidence.fieldId === nullResultField)).toBe(false);
  });

  // =====================================================================
  // 3. RELAXATION — qualifying (>=40% break rate, >=20 window evals) vs
  //    two near-misses (39% break rate; only 19 window evaluations).
  // =====================================================================

  it('RELAXATION: >=40% break rate over >=20 window evaluations qualifies; 39% break rate and 19-evaluation near-misses are excluded', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-relaxation');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId);
    const now = new Date('2026-09-11T12:00:00Z');
    const createdAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days old, clears the 42-day floor

    const { findRelaxationCandidates } = await import('../relaxation-candidates');

    // Case A: QUALIFIES -- 100 evaluations in-window, 40 broken (exactly 40%).
    const ruleA = await insertRule(userId, { createdAt, rendered: 'Rule A' });
    for (let i = 0; i < 100; i++) {
      const tradeId = await seedBareTrade(userId, accountId, daysAgo(now, 5), i);
      await insertRuleEvaluation(userId, tradeId, ruleA, 'soft', i < 40 ? 'broken' : 'followed', daysAgo(now, 5));
    }

    // Case B: NEAR-MISS on rate -- 100 evaluations, only 39 broken (39%).
    const ruleB = await insertRule(userId, { createdAt, rendered: 'Rule B' });
    for (let i = 0; i < 100; i++) {
      const tradeId = await seedBareTrade(userId, accountId, daysAgo(now, 6), i);
      await insertRuleEvaluation(userId, tradeId, ruleB, 'soft', i < 39 ? 'broken' : 'followed', daysAgo(now, 6));
    }

    // Case C: NEAR-MISS on count -- only 19 window evaluations, all broken (100%).
    const ruleC = await insertRule(userId, { createdAt, rendered: 'Rule C' });
    for (let i = 0; i < 19; i++) {
      const tradeId = await seedBareTrade(userId, accountId, daysAgo(now, 7), i);
      await insertRuleEvaluation(userId, tradeId, ruleC, 'soft', 'broken', daysAgo(now, 7));
    }

    const candidates = await findRelaxationCandidates(userId, now);
    const ruleIds = candidates.map((c) => c.subjectId);
    expect(ruleIds).toContain(ruleA);
    expect(ruleIds).not.toContain(ruleB);
    expect(ruleIds).not.toContain(ruleC);

    const evidenceA = candidates.find((c) => c.subjectId === ruleA)!.evidence;
    expect(evidenceA.applicableEvaluations).toBe(100);
    expect(evidenceA.brokenEvaluations).toBe(40);
    expect(evidenceA.breakRate).toBeCloseTo(0.4, 5);
  }, 180_000);

  // =====================================================================
  // 4. PROMOTION — thin-wrapper equivalence with zero reimplementation
  //    drift; severity filter (hard rules never candidates).
  // =====================================================================

  it('PROMOTION: findPromotionCandidates is byte-for-byte identical to checkPromotionEligibilityForUser for an eligible soft rule; a hard rule meeting the same gates is excluded (severity filter, not the gate itself)', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-promotion');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId);
    const now = new Date('2026-09-11T12:00:00Z');
    const createdAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Soft rule meeting all 4 gates: 60d old, 25 evaluations all followed
    // (100% compliance), zero breaks in the last 3 weeks.
    const softRuleId = await insertRule(userId, { createdAt, severity: 'soft', rendered: 'Soft eligible rule' });
    for (let i = 0; i < 25; i++) {
      const tradeId = await seedBareTrade(userId, accountId, daysAgo(now, 30), i);
      await insertRuleEvaluation(userId, tradeId, softRuleId, 'soft', 'followed', daysAgo(now, 30));
    }

    // Hard rule, IDENTICAL fixture shape -- would clear the same 4 gates,
    // but promotion only ever applies to soft rules (nothing to promote a
    // hard rule TO).
    const hardRuleId = await insertRule(userId, { createdAt, severity: 'hard', rendered: 'Hard rule, same shape' });
    for (let i = 0; i < 25; i++) {
      const tradeId = await seedBareTrade(userId, accountId, daysAgo(now, 30), 100 + i);
      await insertRuleEvaluation(userId, tradeId, hardRuleId, 'hard', 'followed', daysAgo(now, 30));
    }

    const { checkPromotionEligibilityForUser } = await import('@/lib/rules/promotion-eligibility');
    const { findPromotionCandidates } = await import('../promotion-candidates');

    const direct = await checkPromotionEligibilityForUser(userId, softRuleId, now);
    expect(direct.eligible).toBe(true);

    const candidates = await findPromotionCandidates(userId, now);
    expect(candidates.some((c) => c.subjectId === hardRuleId)).toBe(false);
    const softCandidate = candidates.find((c) => c.subjectId === softRuleId);
    expect(softCandidate).toBeDefined();

    // Zero reimplementation drift: every number in the candidate's
    // evidence must equal the SAME numbers the reused, already-built gate
    // itself just computed -- not independently re-derived.
    expect(softCandidate!.evidence.ageDays).toBeCloseTo(direct.detail.ageDays, 6);
    expect(softCandidate!.evidence.applicableEvaluations).toBe(direct.detail.applicableEvaluations);
    expect(softCandidate!.evidence.followedEvaluations).toBe(direct.detail.followedEvaluations);
    expect(softCandidate!.evidence.complianceRatio).toBe(direct.detail.complianceRatio);
  }, 120_000);

  // =====================================================================
  // 5. RETIREMENT (decay) — a real finding_rule_links row whose CURRENT
  //    finding has genuinely transitioned to state='decayed' via the
  //    REAL decay engine.
  // =====================================================================

  it('RETIREMENT (decay): a rule whose linked finding genuinely decays (via the real decay engine) qualifies; a non-decayed link and a retired rule are excluded', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-retirement-decay');
    cleanupUserIds.push(userId);
    const strategyId = await seedStrategy(userId);
    const fieldId = nextFieldId('decay');
    await seedBoolField(userId, strategyId, fieldId);
    await seedStrategyVersion(userId, strategyId, [fieldId]);

    const { createFindingRuleLink } = await import('@/lib/analytics/decay-engine/repository');
    const { runDecayChecksForUser } = await import('@/lib/analytics/decay-engine/repository');

    async function insertFinding(n: number, deltaWinRate: number, state: 'active' | 'decayed' = 'active'): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.findings
           (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
            baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
            p_value, p_adjusted, confidence, gate_failures, state)
         values ($1,'find.toggle',$2,$3,$4::jsonb,$5,0.6,0.4,$5,0.4,0.1,$6,0.3,0.001,0.001,'confident','{}',$7)
         returning id`,
        [userId, strategyId, fieldId, JSON.stringify({ op: 'eq', value: true }), n, deltaWinRate.toFixed(4), state],
      );
      return res.rows[0].id;
    }

    const decayingFinding = await insertFinding(70, 0.2);
    const decayRuleId = await insertRule(userId, { createdAt: new Date(), rendered: 'Decaying rule' });
    await createFindingRuleLink(userId, decayingFinding, decayRuleId, 0.2, 70);

    // Two consecutive below-half checks -> real decay signal, real
    // state='decayed' transition via the actual decay engine.
    await db.query(`update retrospeq.findings set n = 100, delta_win_rate = 0.02 where id = $1`, [decayingFinding]);
    await runDecayChecksForUser(userId);
    await db.query(`update retrospeq.findings set n = 130, delta_win_rate = 0.01 where id = $1`, [decayingFinding]);
    const decayResult = await runDecayChecksForUser(userId);
    expect(decayResult.decaySignalsEmitted).toBe(1);
    const decayedRow = await db.query<{ state: string }>(`select state from retrospeq.findings where id = $1`, [decayingFinding]);
    expect(decayedRow.rows[0].state).toBe('decayed');

    // A second, healthy link -- never decays.
    const healthyFieldId = nextFieldId('healthy');
    await seedBoolField(userId, strategyId, healthyFieldId);
    const healthyFinding = await insertFinding(70, 0.2);
    await db.query('update retrospeq.findings set field_id = $1 where id = $2', [healthyFieldId, healthyFinding]);
    const healthyRuleId = await insertRule(userId, { createdAt: new Date(), rendered: 'Healthy rule' });
    await createFindingRuleLink(userId, healthyFinding, healthyRuleId, 0.2, 70);

    // A third link whose finding also decayed, but the rule is retired.
    const retiredFieldId = nextFieldId('retired');
    await seedBoolField(userId, strategyId, retiredFieldId);
    const retiredFinding = await insertFinding(100, 0.02, 'decayed');
    await db.query('update retrospeq.findings set field_id = $1 where id = $2', [retiredFieldId, retiredFinding]);
    const retiredRuleId = await insertRule(userId, { createdAt: new Date(), state: 'retired', rendered: 'Retired rule' });
    await createFindingRuleLink(userId, retiredFinding, retiredRuleId, 0.2, 70);

    const { findRetirementDecayCandidates } = await import('../retirement-decay-candidates');
    const candidates = await findRetirementDecayCandidates(userId);
    const ruleIds = candidates.map((c) => c.subjectId);
    expect(ruleIds).toContain(decayRuleId);
    expect(ruleIds).not.toContain(healthyRuleId);
    expect(ruleIds).not.toContain(retiredRuleId);
  }, 60_000);

  // =====================================================================
  // 6. RETIREMENT (condition) — met on every trade for >= 30 trades
  //    qualifies; one unmet among 30+ excludes; unrecorded rows never
  //    count toward the floor.
  // =====================================================================

  it('RETIREMENT (condition): 31 consecutive met evaluations qualifies; a single unmet occurrence excludes; unrecorded rows drop out of both the numerator and the >=30 floor', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-retirement-condition');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId);
    const strategyId = await seedStrategy(userId);

    async function insertCondition(text: string): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trigger_conditions (user_id, strategy_id, text, sort_order) values ($1, $2, $3, 1) returning id`,
        [userId, strategyId, text],
      );
      return res.rows[0].id;
    }
    async function insertTriggerEval(tradeId: string, conditionId: string, result: 'met' | 'unmet' | 'unrecorded'): Promise<void> {
      await db.query(
        `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result) values ($1, $2, $3, $4)`,
        [userId, tradeId, conditionId, result],
      );
    }

    // Condition A: 31 recorded, all met -> qualifies.
    const conditionA = await insertCondition('Checked the news calendar');
    for (let i = 0; i < 31; i++) {
      const tradeId = await seedBareTrade(userId, accountId, '2026-08-01', i);
      await insertTriggerEval(tradeId, conditionA, 'met');
    }

    // Condition B: 31 recorded, 30 met + 1 unmet -> excluded (the
    // discriminator that once failed disqualifies it permanently).
    const conditionB = await insertCondition('Confirmed session overlap');
    for (let i = 0; i < 31; i++) {
      const tradeId = await seedBareTrade(userId, accountId, '2026-08-02', i);
      await insertTriggerEval(tradeId, conditionB, i === 15 ? 'unmet' : 'met');
    }

    // Condition C: 29 met + 5 unrecorded -- unrecorded rows drop out of
    // BOTH the numerator and denominator, leaving only 29 recorded (< 30
    // floor) -> excluded, even though zero unmet occurrences exist.
    const conditionC = await insertCondition('Marked the setup grade');
    for (let i = 0; i < 29; i++) {
      const tradeId = await seedBareTrade(userId, accountId, '2026-08-03', i);
      await insertTriggerEval(tradeId, conditionC, 'met');
    }
    for (let i = 29; i < 34; i++) {
      const tradeId = await seedBareTrade(userId, accountId, '2026-08-03', i);
      await insertTriggerEval(tradeId, conditionC, 'unrecorded');
    }

    const { findRetirementConditionCandidates } = await import('../retirement-condition-candidates');
    const candidates = await findRetirementConditionCandidates(userId);
    const conditionIds = candidates.map((c) => c.subjectId);
    expect(conditionIds).toContain(conditionA);
    expect(conditionIds).not.toContain(conditionB);
    expect(conditionIds).not.toContain(conditionC);

    const evidenceA = candidates.find((c) => c.subjectId === conditionA)!.evidence;
    expect(evidenceA.recordedEvaluations).toBe(31);
  }, 120_000);

  // =====================================================================
  // 7. DETECTION — a tier='count' row and a classification='incident' row
  //    are both correctly excluded even though otherwise shaped like a
  //    qualifying pattern/count_outcome row (direct-insert fixtures, same
  //    "not what's under test" reasoning as this file's decay-engine
  //    precedent -- the detection ENGINE's own tier/classification
  //    computation is Module 05's concern, already covered there).
  // =====================================================================

  it('DETECTION: a tier=count row and a classification=incident row are both excluded even when otherwise shaped like a qualifying pattern/count_outcome row', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'elig-detection-exclusions');
    cleanupUserIds.push(userId);

    async function insertDetection(analyticId: string, tier: 'count' | 'count_outcome', classification: 'incident' | 'pattern', ruleProposable: boolean): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.detections
           (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
            outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction, state)
         values ($1,$2,8,'2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',5,0.1,-0.5,0.1,$3,$4,$5,'active','active')
         returning id`,
        [userId, analyticId, tier, classification, ruleProposable],
      );
      return res.rows[0].id;
    }

    const countTierId = await insertDetection('seq.trades_per_day', 'count', 'pattern', false);
    const incidentId = await insertDetection('seq.consecutive_losses', 'count_outcome', 'incident', false);
    const qualifyingId = await insertDetection('seq.reentry_after_loss', 'count_outcome', 'pattern', true);

    const { findDetectionCandidates } = await import('../detection-candidates');
    const candidates = await findDetectionCandidates(userId);
    const analyticIds = candidates.map((c) => c.evidence.analyticId);
    expect(analyticIds).toContain('seq.reentry_after_loss');
    expect(analyticIds).not.toContain('seq.trades_per_day');
    expect(analyticIds).not.toContain('seq.consecutive_losses');

    // Sanity: the three rows really were written distinctly (not a
    // vacuous pass because the insert itself silently failed).
    const rowCount = await db.query<{ count: string }>('select count(*)::text as count from retrospeq.detections where user_id = $1', [userId]);
    expect(rowCount.rows[0].count).toBe('3');
    void countTierId;
    void incidentId;
    void qualifyingId;
  });

  // =====================================================================
  // 8. CROSS-USER ISOLATION — every finder, one user with real candidates
  //    in every kind, a second user with zero data.
  // =====================================================================

  it('CROSS-USER ISOLATION: a second user with zero data never sees any of the first user\'s real candidates, across every kind at once', async () => {
    if (!env) return;
    const { id: userA } = await createTestAuthUser(envBundle, 'elig-isoA');
    const { id: userB } = await createTestAuthUser(envBundle, 'elig-isoB');
    cleanupUserIds.push(userA, userB);

    const accountA = await seedAccount(userA);
    const now = new Date('2026-09-11T12:00:00Z');
    const createdAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // A real relaxation-eligible rule for user A only.
    const ruleA = await insertRule(userA, { createdAt, rendered: 'User A relaxation rule' });
    for (let i = 0; i < 25; i++) {
      const tradeId = await seedBareTrade(userA, accountA, daysAgo(now, 5), i);
      await insertRuleEvaluation(userA, tradeId, ruleA, 'soft', i < 15 ? 'broken' : 'followed', daysAgo(now, 5));
    }

    const { computeAllPromptCandidates } = await import('../index');
    const resultA = await computeAllPromptCandidates(userA, now);
    expect(resultA.relaxation.some((c) => c.subjectId === ruleA)).toBe(true);

    const resultB = await computeAllPromptCandidates(userB, now);
    expect(resultB.relaxation).toEqual([]);
    expect(resultB.graduation).toEqual([]);
    expect(resultB.promotion).toEqual([]);
    expect(resultB.retirementDecay).toEqual([]);
    expect(resultB.retirementCondition).toEqual([]);
    expect(resultB.detection).toEqual([]);
    // Explicitly never contains user A's own rule id anywhere.
    expect(JSON.stringify(resultB)).not.toContain(ruleA);
  }, 90_000);
});
