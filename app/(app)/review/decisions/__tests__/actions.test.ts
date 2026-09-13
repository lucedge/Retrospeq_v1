import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. Mocked-dependency unit test for `app/(app)/review/decisions/
 * actions.ts`, matching this repo's own established pattern
 * (`app/(app)/rules/__tests__/actions.test.ts`) for exercising a Server
 * Action's own orchestration/validation/error-mapping logic without a live
 * DB. Live-DB coverage (real writes, the re-prompt-bug cross-slice check,
 * RLS) lives in the sibling `decisions-integration.live.test.ts`.
 *
 * Security-review fix, 2026-09-13 (PROGRESS.md, "ADR 0040 decision 7's
 * `origin` bypass" — BLOCKING, resolved same day): `acceptGraduationDecision`
 * now calls `createRuleInternal` (`lib/rules/create-rule-internal.ts`)
 * directly, in-process, rather than the public `createRule` Server Action —
 * this file's own mocks/assertions were updated to match (`createRuleMock`
 * renamed `createRuleInternalMock`, mocked at its new module path, asserted
 * with the `(userId, input)` signature `createRuleInternal` actually takes).
 * The doc comments below still say "createRule" in a few places as
 * shorthand for "the create-rule pipeline" — the underlying pipeline itself
 * is unchanged by this fix, only which function/caller may set `origin`.
 *
 * Adversarial focus, per this slice's own review dispatch:
 *   1. rate limit is checked FIRST, before anything else, on all three
 *      exported actions;
 *   2. the Pro-only `graduation` entitlement gate on BOTH the read and
 *      the accept action (a client could call accept directly);
 *   3. a custom (non-drv.*) field's accept writes NOTHING — no createRule
 *      call, no insertRuleFieldUsage, no createFindingRuleLink, no
 *      markPromptAccepted;
 *   4. createRule's own honest rejection (e.g. the free-tier rules.create
 *      cap) is surfaced VERBATIM, not a second synthesised message;
 *   5. defer never calls markPromptAccepted / createRule, and succeeds
 *      idempotently against an already-resolved prompt;
 *   6. the non-positive/null delta_win_rate skip: createFindingRuleLink is
 *      never called, but the rule itself still succeeds;
 *   7. the double-submit / already-accepted replay path never creates a
 *      second rule.
 */

const { getUserMock, createClientMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
}));
const enforceRateLimitMock = vi.hoisted(() => vi.fn());
const getClientIpMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const canForUserMock = vi.hoisted(() => vi.fn());
const retireRuleStateMock = vi.hoisted(() => vi.fn());
const fetchActiveFindingForFieldTupleMock = vi.hoisted(() => vi.fn());
const createFindingRuleLinkMock = vi.hoisted(() => vi.fn());
const insertRuleFieldUsageMock = vi.hoisted(() => vi.fn());
const fetchCurrentReviewIdForDecisionsMock = vi.hoisted(() => vi.fn());
const fetchPendingGraduationPromptsMock = vi.hoisted(() => vi.fn());
const fetchGraduationDecisionCountsMock = vi.hoisted(() => vi.fn());
const fetchPromptByIdMock = vi.hoisted(() => vi.fn());
const markPromptAcceptedMock = vi.hoisted(() => vi.fn());
const markPromptDeferredMock = vi.hoisted(() => vi.fn());
const buildGraduationPromptDetailMock = vi.hoisted(() => vi.fn());
const createRuleInternalMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('@/lib/entitlements/service', () => ({ canForUser: canForUserMock }));
vi.mock('@/lib/rules/severity-lifecycle-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rules/severity-lifecycle-repository')>();
  return { ...actual, retireRuleState: retireRuleStateMock };
});
vi.mock('@/lib/analytics/findings-repository', () => ({
  fetchActiveFindingForFieldTuple: fetchActiveFindingForFieldTupleMock,
}));
vi.mock('@/lib/analytics/decay-engine/repository', () => ({
  createFindingRuleLink: createFindingRuleLinkMock,
}));
vi.mock('@/lib/fields/fields-repository', () => ({
  insertRuleFieldUsage: insertRuleFieldUsageMock,
}));
vi.mock('@/lib/review/decisions/prompts-repository', () => ({
  fetchCurrentReviewIdForDecisions: fetchCurrentReviewIdForDecisionsMock,
  fetchPendingGraduationPrompts: fetchPendingGraduationPromptsMock,
  fetchGraduationDecisionCounts: fetchGraduationDecisionCountsMock,
  fetchPromptById: fetchPromptByIdMock,
  markPromptAccepted: markPromptAcceptedMock,
  markPromptDeferred: markPromptDeferredMock,
}));
vi.mock('@/lib/review/decisions/graduation-evidence-detail', () => ({
  buildGraduationPromptDetail: buildGraduationPromptDetailMock,
}));
// Security review finding, Module 06 Slice 6 (PROGRESS.md, dated
// 2026-09-13, "ADR 0040 decision 7's `origin` bypass" — BLOCKING;
// resolved same day). `acceptGraduationDecision` now calls
// `createRuleInternal` (`lib/rules/create-rule-internal.ts`) directly, not
// the public `createRule` Server Action — see `app/(app)/review/decisions/
// actions.ts`'s own updated import comment for the full reasoning.
vi.mock('@/lib/rules/create-rule-internal', () => ({ createRuleInternal: createRuleInternalMock }));
vi.mock('server-only', () => ({}));

const USER_ID = 'user-slice6-1';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';
const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';

function baseEvidence(fieldId: string) {
  return {
    strategyId: STRATEGY_ID,
    fieldId,
    analyticId: 'find.edge',
    n: 40,
    winRate: 0.7,
    avgR: null,
    baselineN: 20,
    baselineWinRate: 0.4,
    baselineAvgR: null,
    deltaWinRate: 0.3,
    deltaAvgR: null,
  };
}

function pendingPromptRow(fieldId: string, overrides: Partial<{ state: string; payload: unknown }> = {}) {
  return {
    id: PROMPT_ID,
    reviewId: 'review-1',
    kind: 'graduation',
    state: overrides.state ?? 'pending',
    payload: overrides.payload ?? baseEvidence(fieldId),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
  getUserMock.mockResolvedValue({ data: { user: { id: USER_ID } } });
  getClientIpMock.mockResolvedValue('127.0.0.1');
  enforceRateLimitMock.mockResolvedValue(undefined);
  canForUserMock.mockResolvedValue({ allowed: true });
  fetchActiveFindingForFieldTupleMock.mockResolvedValue({
    id: 'finding-1',
    computedAt: '2026-09-01T00:00:00Z',
    analyticId: 'find.edge',
    fieldId: 'drv.risk_pct',
    segment: { op: 'between', value: { min: 0.5, max: 1.0 } },
    n: 40,
    winRate: 0.7,
    avgR: null,
    baselineN: 20,
    baselineWinRate: 0.4,
    baselineAvgR: null,
    deltaWinRate: 0.3,
    deltaAvgR: null,
    confidence: 'confident',
  });
  createRuleInternalMock.mockResolvedValue({
    success: true,
    rule: { id: 'rule-1', operandId: 'risk_pct', op: 'lte', value: 1.0, rendered: 'Never risk more than 1% per trade.', scope: 'strategy', scopeId: STRATEGY_ID, version: 1 },
  });
  insertRuleFieldUsageMock.mockResolvedValue(undefined);
  createFindingRuleLinkMock.mockResolvedValue(undefined);
  markPromptAcceptedMock.mockResolvedValue({ id: PROMPT_ID });
  markPromptDeferredMock.mockResolvedValue({ id: PROMPT_ID });
  fetchPromptByIdMock.mockResolvedValue(pendingPromptRow('drv.risk_pct'));
});

async function importActions() {
  return import('../actions');
}

// ---------------------------------------------------------------------
// Rate limiting — must be checked FIRST, before entitlement/DB reads.
// ---------------------------------------------------------------------

describe('rate limiting is the first check on every exported action', () => {
  it('fetchNextGraduationDecision: rate-limited before canForUser/DB reads ever run', async () => {
    enforceRateLimitMock.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { name: 'RateLimitExceededError' }),
    );
    const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
    enforceRateLimitMock.mockReset().mockRejectedValueOnce(new RateLimitExceededError('reviewDecision', 'ip', 60));
    const { fetchNextGraduationDecision } = await importActions();

    const result = await fetchNextGraduationDecision();

    expect(result.success).toBeUndefined();
    expect((result as { error: { code: string } }).error.code).toBe('REVIEW_DECISION_RATE_LIMITED');
    expect(canForUserMock).not.toHaveBeenCalled();
    expect(fetchCurrentReviewIdForDecisionsMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledWith('reviewDecision', '127.0.0.1', USER_ID);
  });

  it('acceptGraduationDecision: rate-limited before entitlement/prompt lookup/createRule', async () => {
    const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
    enforceRateLimitMock.mockRejectedValueOnce(new RateLimitExceededError('reviewDecision', 'ip', 60));
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('REVIEW_DECISION_RATE_LIMITED');
    expect(canForUserMock).not.toHaveBeenCalled();
    expect(fetchPromptByIdMock).not.toHaveBeenCalled();
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });

  it('deferGraduationDecision: rate-limited before the prompt lookup/write', async () => {
    const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
    enforceRateLimitMock.mockRejectedValueOnce(new RateLimitExceededError('reviewDecision', 'ip', 60));
    const { deferGraduationDecision } = await importActions();

    const result = await deferGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('REVIEW_DECISION_RATE_LIMITED');
    expect(fetchPromptByIdMock).not.toHaveBeenCalled();
    expect(markPromptDeferredMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Entitlement (Pro-only graduation capability) — read AND accept.
// ---------------------------------------------------------------------

describe('graduation entitlement (Pro-only) is checked on both the read and the accept action', () => {
  it('fetchNextGraduationDecision returns plan_required for a free user, without ever reading review_prompts', async () => {
    canForUserMock.mockResolvedValue({ allowed: false });
    const { fetchNextGraduationDecision } = await importActions();

    const result = await fetchNextGraduationDecision();

    expect(result).toEqual({ success: true, status: 'plan_required' });
    expect(fetchCurrentReviewIdForDecisionsMock).not.toHaveBeenCalled();
  });

  it('acceptGraduationDecision rejects a free user directly, even with a valid pending prompt id — closing the "call the action directly" bypass', async () => {
    canForUserMock.mockResolvedValue({ allowed: false });
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('GRADUATION_PLAN_REQUIRED');
    expect(fetchPromptByIdMock).not.toHaveBeenCalled();
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// The honesty boundary — a custom/non-drv.* field writes NOTHING.
// ---------------------------------------------------------------------

describe('a field with no operand-catalogue counterpart rejects honestly and writes nothing', () => {
  it('acceptGraduationDecision on a custom field ("conviction") returns GRADUATION_FIELD_UNSUPPORTED and calls none of createRule/insertRuleFieldUsage/createFindingRuleLink/markPromptAccepted', async () => {
    fetchPromptByIdMock.mockResolvedValue(pendingPromptRow('conviction'));
    fetchActiveFindingForFieldTupleMock.mockResolvedValue({
      id: 'finding-conviction',
      computedAt: '2026-09-01T00:00:00Z',
      analyticId: 'find.edge',
      fieldId: 'conviction',
      segment: { op: 'eq', value: 5 },
      n: 14,
      winRate: 0.71,
      avgR: null,
      baselineN: 10,
      baselineWinRate: 0.42,
      baselineAvgR: null,
      deltaWinRate: 0.29,
      deltaAvgR: null,
      confidence: 'confident',
    });
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error).toEqual({
      code: 'GRADUATION_FIELD_UNSUPPORTED',
      user_message: "This kind of finding can't become a rule yet.",
      retryable: false,
    });
    expect(createRuleInternalMock).not.toHaveBeenCalled();
    expect(insertRuleFieldUsageMock).not.toHaveBeenCalled();
    expect(createFindingRuleLinkMock).not.toHaveBeenCalled();
    expect(markPromptAcceptedMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('the SAME custom-field rejection happens even before the live-finding fetch is trusted — a resolveOperandForField(null) short-circuits without needing a live row at all', async () => {
    fetchPromptByIdMock.mockResolvedValue(pendingPromptRow('drv.session'));
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('GRADUATION_FIELD_UNSUPPORTED');
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Happy path — a supported drv.* field.
// ---------------------------------------------------------------------

describe('acceptGraduationDecision — happy path on a supported field', () => {
  it('creates the rule with origin=graduated, writes field_usages and finding_rule_links, then marks the prompt accepted and revalidates the right paths', async () => {
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.success).toBe(true);
    expect(result.ruleId).toBe('rule-1');
    // `createRuleInternal(userId, input)` — the SECOND argument carries the
    // rule shape; the FIRST is the already-authenticated caller's own
    // `userId`, per the security-review fix (`docs/adr/0040` decision 7's
    // resolution note): `acceptGraduationDecision` now calls the internal
    // function directly, in-process, rather than the public `createRule`
    // Server Action.
    expect(createRuleInternalMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ operandId: 'risk_pct', op: 'lte', value: 1.0, scope: 'strategy', scopeId: STRATEGY_ID, origin: 'graduated' }),
    );
    expect(insertRuleFieldUsageMock).toHaveBeenCalledWith(USER_ID, 'drv.risk_pct', 'rule-1');
    expect(createFindingRuleLinkMock).toHaveBeenCalledWith(USER_ID, 'finding-1', 'rule-1', 0.3, 40);
    expect(markPromptAcceptedMock).toHaveBeenCalledWith(USER_ID, PROMPT_ID, 'rule-1', 'Never risk more than 1% per trade.');
    expect(revalidatePathMock).toHaveBeenCalledWith('/review');
    expect(revalidatePathMock).toHaveBeenCalledWith('/review/decisions');
    expect(revalidatePathMock).toHaveBeenCalledWith('/rules');
  });

  it('skips the finding_rule_links write (with a warning, not a crash) when delta_win_rate is null — the rule itself still succeeds', async () => {
    fetchActiveFindingForFieldTupleMock.mockResolvedValue({
      id: 'finding-1', computedAt: '2026-09-01T00:00:00Z', analyticId: 'find.edge', fieldId: 'drv.risk_pct',
      segment: { op: 'between', value: { min: 0.5, max: 1.0 } }, n: 40, winRate: 0.7, avgR: 0.4,
      baselineN: 20, baselineWinRate: null, baselineAvgR: 0.1, deltaWinRate: null, deltaAvgR: 0.3, confidence: 'confident',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.success).toBe(true);
    expect(createFindingRuleLinkMock).not.toHaveBeenCalled();
    expect(insertRuleFieldUsageMock).toHaveBeenCalled(); // the OTHER secondary write still happens
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('also skips finding_rule_links when delta_win_rate is exactly zero or negative — never writes a fabricated substitute value', async () => {
    fetchActiveFindingForFieldTupleMock.mockResolvedValue({
      id: 'finding-1', computedAt: '2026-09-01T00:00:00Z', analyticId: 'find.edge', fieldId: 'drv.risk_pct',
      segment: { op: 'between', value: { min: 0.5, max: 1.0 } }, n: 40, winRate: 0.7, avgR: null,
      baselineN: 20, baselineWinRate: 0.7, baselineAvgR: null, deltaWinRate: -0.1, deltaAvgR: null, confidence: 'confident',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.success).toBe(true);
    expect(createFindingRuleLinkMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// createRule's own rejections surface VERBATIM — no second gate.
// ---------------------------------------------------------------------

describe('createRule rejections are passed through verbatim, never re-wrapped or duplicated', () => {
  it('the free-tier rules.create cap rejection from createRule is surfaced exactly as createRule produced it', async () => {
    createRuleInternalMock.mockResolvedValue({
      error: { code: 'ENTITLEMENT_LIMIT', user_message: "You've used all 3 of your rules. Upgrade to Pro for unlimited rules.", retryable: false },
    });
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error).toEqual({ code: 'ENTITLEMENT_LIMIT', user_message: "You've used all 3 of your rules. Upgrade to Pro for unlimited rules.", retryable: false });
    // No second, redundant gate: acceptGraduationDecision does not call
    // canForUser('rules.create') itself — only createRule's own internal
    // check produces this rejection.
    expect(canForUserMock).toHaveBeenCalledTimes(1); // the graduation gate only
    expect(canForUserMock).toHaveBeenCalledWith(USER_ID, 'graduation');
    expect(insertRuleFieldUsageMock).not.toHaveBeenCalled();
    expect(markPromptAcceptedMock).not.toHaveBeenCalled();
  });

  it('a tighten-only conflict from createRule is also passed through verbatim, and no secondary writes happen', async () => {
    createRuleInternalMock.mockResolvedValue({
      error: { code: 'RULE_TIGHTEN_ONLY_VIOLATION', user_message: 'Your rulebook already governs "Risk per trade" with a tighter rule.', retryable: false },
    });
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('RULE_TIGHTEN_ONLY_VIOLATION');
    expect(insertRuleFieldUsageMock).not.toHaveBeenCalled();
    expect(createFindingRuleLinkMock).not.toHaveBeenCalled();
    expect(markPromptAcceptedMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Live finding vanished / drifted below confidence.
// ---------------------------------------------------------------------

describe('GRADUATION_FINDING_GONE — the live finding no longer supports acceptance', () => {
  it('returns GRADUATION_FINDING_GONE when no active finding exists for the tuple any more, and writes nothing', async () => {
    fetchActiveFindingForFieldTupleMock.mockResolvedValue(null);
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('GRADUATION_FINDING_GONE');
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });

  it('returns GRADUATION_FINDING_GONE when the live finding has drifted to insufficient confidence', async () => {
    fetchActiveFindingForFieldTupleMock.mockResolvedValue({
      id: 'finding-1', computedAt: '2026-09-01T00:00:00Z', analyticId: 'find.edge', fieldId: 'drv.risk_pct',
      segment: { op: 'between', value: { min: 0.5, max: 1.0 } }, n: 40, winRate: 0.7, avgR: null,
      baselineN: 20, baselineWinRate: 0.4, baselineAvgR: null, deltaWinRate: 0.3, deltaAvgR: null, confidence: 'insufficient',
    });
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('GRADUATION_FINDING_GONE');
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Idempotent replay — double submit against an already-accepted prompt.
// ---------------------------------------------------------------------

describe('idempotent replay — PROMPT_ALREADY_DECIDED', () => {
  it('re-accepting an already-accepted prompt replays the original ruleId/ruleRendered, never calling createRule a second time', async () => {
    fetchPromptByIdMock.mockResolvedValue(
      pendingPromptRow('drv.risk_pct', {
        state: 'accepted',
        payload: { ...baseEvidence('drv.risk_pct'), ruleId: '55555555-5555-4555-8555-555555555555', ruleRendered: 'Never risk more than 1% per trade.' },
      }),
    );
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result).toEqual({ success: true, ruleId: '55555555-5555-4555-8555-555555555555', ruleRendered: 'Never risk more than 1% per trade.' });
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });

  it('a prompt in a terminal state with no recorded ruleId (e.g. declined) returns PROMPT_ALREADY_DECIDED honestly, not a crash', async () => {
    fetchPromptByIdMock.mockResolvedValue(pendingPromptRow('drv.risk_pct', { state: 'declined' }));
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(result.error?.code).toBe('REVIEW_PROMPT_ALREADY_DECIDED');
    expect(createRuleInternalMock).not.toHaveBeenCalled();
  });

  it('a race lost at the final guarded UPDATE (markPromptAccepted returns null) retires the just-created duplicate rule and replays the winner', async () => {
    markPromptAcceptedMock.mockResolvedValue(null);
    fetchPromptByIdMock
      .mockResolvedValueOnce(pendingPromptRow('drv.risk_pct')) // initial read: pending
      .mockResolvedValueOnce(
        pendingPromptRow('drv.risk_pct', {
          state: 'accepted',
          payload: { ...baseEvidence('drv.risk_pct'), ruleId: '66666666-6666-4666-8666-666666666666', ruleRendered: 'Winner rendered.' },
        }),
      ); // re-read after losing the race
    const { acceptGraduationDecision } = await importActions();

    const result = await acceptGraduationDecision(PROMPT_ID);

    expect(retireRuleStateMock).toHaveBeenCalledWith(USER_ID, 'rule-1');
    expect(result).toEqual({ success: true, ruleId: '66666666-6666-4666-8666-666666666666', ruleRendered: 'Winner rendered.' });
  });
});

// ---------------------------------------------------------------------
// Unknown / foreign prompt id, invalid input shape.
// ---------------------------------------------------------------------

describe('input validation and not-found handling', () => {
  it('a non-uuid promptId is rejected before any DB read (accept)', async () => {
    const { acceptGraduationDecision } = await importActions();
    const result = await acceptGraduationDecision('not-a-uuid');
    expect(result.error?.code).toBe('REVIEW_DECISION_INVALID_INPUT');
    expect(fetchPromptByIdMock).not.toHaveBeenCalled();
  });

  it('a non-uuid promptId is rejected before any DB read (defer)', async () => {
    const { deferGraduationDecision } = await importActions();
    const result = await deferGraduationDecision('not-a-uuid');
    expect(result.error?.code).toBe('REVIEW_DECISION_INVALID_INPUT');
    expect(fetchPromptByIdMock).not.toHaveBeenCalled();
  });

  it('a foreign/nonexistent prompt id returns REVIEW_PROMPT_NOT_FOUND for both accept and defer', async () => {
    fetchPromptByIdMock.mockResolvedValue(null);
    const { acceptGraduationDecision, deferGraduationDecision } = await importActions();

    expect((await acceptGraduationDecision(PROMPT_ID)).error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
    expect((await deferGraduationDecision(PROMPT_ID)).error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
  });

  it('a prompt of a different kind (not graduation) is treated as not-found by both actions', async () => {
    fetchPromptByIdMock.mockResolvedValue({ ...pendingPromptRow('drv.risk_pct'), kind: 'relaxation' });
    const { acceptGraduationDecision, deferGraduationDecision } = await importActions();

    expect((await acceptGraduationDecision(PROMPT_ID)).error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
    expect((await deferGraduationDecision(PROMPT_ID)).error?.code).toBe('REVIEW_PROMPT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------
// Defer — §4.5 "no penalty," never touches createRule/markPromptAccepted.
// ---------------------------------------------------------------------

describe('deferGraduationDecision — §4.5 no-penalty defer', () => {
  it('marks the prompt deferred and revalidates, without ever touching createRule/markPromptAccepted', async () => {
    const { deferGraduationDecision } = await importActions();

    const result = await deferGraduationDecision(PROMPT_ID);

    expect(result).toEqual({ success: true });
    expect(markPromptDeferredMock).toHaveBeenCalledWith(USER_ID, PROMPT_ID);
    expect(createRuleInternalMock).not.toHaveBeenCalled();
    expect(markPromptAcceptedMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith('/review');
    expect(revalidatePathMock).toHaveBeenCalledWith('/review/decisions');
  });

  it('deferring an already-resolved prompt is a harmless idempotent success, never an error, and never calls markPromptDeferred again', async () => {
    fetchPromptByIdMock.mockResolvedValue(pendingPromptRow('drv.risk_pct', { state: 'deferred' }));
    const { deferGraduationDecision } = await importActions();

    const result = await deferGraduationDecision(PROMPT_ID);

    expect(result).toEqual({ success: true });
    expect(markPromptDeferredMock).not.toHaveBeenCalled();
  });

  it('does NOT gate on the graduation entitlement — deferring is always allowed regardless of plan (only accept is Pro-gated)', async () => {
    canForUserMock.mockResolvedValue({ allowed: false });
    const { deferGraduationDecision } = await importActions();

    const result = await deferGraduationDecision(PROMPT_ID);

    expect(result).toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------
// fetchNextGraduationDecision — no_review / none_pending / corrupt payload.
// ---------------------------------------------------------------------

describe('fetchNextGraduationDecision — status branches', () => {
  it('no_review when fetchCurrentReviewIdForDecisions returns null', async () => {
    fetchCurrentReviewIdForDecisionsMock.mockResolvedValue(null);
    const { fetchNextGraduationDecision } = await importActions();
    const result = await fetchNextGraduationDecision();
    expect(result).toEqual({ success: true, status: 'no_review' });
  });

  it('none_pending when a review exists but zero pending graduation prompts remain', async () => {
    fetchCurrentReviewIdForDecisionsMock.mockResolvedValue({ reviewId: 'review-1' });
    fetchPendingGraduationPromptsMock.mockResolvedValue([]);
    fetchGraduationDecisionCountsMock.mockResolvedValue({ total: 2, pending: 0 });
    const { fetchNextGraduationDecision } = await importActions();
    const result = await fetchNextGraduationDecision();
    expect(result).toEqual({ success: true, status: 'none_pending' });
  });

  it('a corrupt payload on the earliest pending prompt returns REVIEW_PROMPT_CORRUPT rather than crashing or guessing', async () => {
    fetchCurrentReviewIdForDecisionsMock.mockResolvedValue({ reviewId: 'review-1' });
    fetchPendingGraduationPromptsMock.mockResolvedValue([{ id: PROMPT_ID, rank: 1, payload: { garbage: true } }]);
    fetchGraduationDecisionCountsMock.mockResolvedValue({ total: 1, pending: 1 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchNextGraduationDecision } = await importActions();

    const result = await fetchNextGraduationDecision();

    expect((result as { error: { code: string } }).error.code).toBe('REVIEW_PROMPT_CORRUPT');
    errSpy.mockRestore();
  });

  it('ready: builds the detail via buildGraduationPromptDetail and computes index from total-pending', async () => {
    fetchCurrentReviewIdForDecisionsMock.mockResolvedValue({ reviewId: 'review-1' });
    fetchPendingGraduationPromptsMock.mockResolvedValue([{ id: PROMPT_ID, rank: 1, payload: baseEvidence('drv.risk_pct') }]);
    fetchGraduationDecisionCountsMock.mockResolvedValue({ total: 2, pending: 1 });
    buildGraduationPromptDetailMock.mockResolvedValue({
      promptId: PROMPT_ID, rank: 1, fieldName: 'Risk %', statement: 's', meta: 'm', costLine: 'c', hint: 'h', canAccept: true, blockedReason: null,
    });
    const { fetchNextGraduationDecision } = await importActions();

    const result = await fetchNextGraduationDecision();

    expect(result).toEqual({ success: true, status: 'ready', index: 2, total: 2, detail: expect.objectContaining({ promptId: PROMPT_ID }) });
  });
});
