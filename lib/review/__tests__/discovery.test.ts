import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { rankDiscoveryItems, type DiscoveryDetectionInput } from '../discovery';

/**
 * Module 04 (Rulebook & Evaluation) §6.1 story 1.3 / inventory row 3.10 —
 * Slice 10c's ranking/selection unit tests, against `rankDiscoveryItems`'s
 * pure filter+rank only (no DB) — same "mirror `detection-candidates.
 * test.ts`'s established pattern" posture that file's own header already
 * uses for the sibling Module 06 gate. `resolveDetectionRuleProposal`
 * itself is NOT mocked here — the two real, currently-mapped v1 analytics
 * (`seq.reentry_after_loss` -> `time_since_last_loss`,
 * `seq.consecutive_losses` -> `consecutive_losses`, see `detection-
 * operand-map.ts`) are used directly, so these tests exercise the SAME
 * mapping production actually resolves, not a stand-in.
 */

function detection(overrides: Partial<DiscoveryDetectionInput> = {}): DiscoveryDetectionInput {
  return {
    analyticId: 'seq.reentry_after_loss',
    occurrences: 11,
    ruleProposable: true,
    ...overrides,
  };
}

const REENTRY_OPERAND_ID = 'time_since_last_loss';
const STREAK_OPERAND_ID = 'consecutive_losses';

describe('rankDiscoveryItems', () => {
  it('returns an empty list when there are no detections at all (honest empty state, no invented items)', () => {
    const items = rankDiscoveryItems([], new Set(), new Set());
    expect(items).toEqual([]);
  });

  it('skips a detection with no honest operand mapping (e.g. seq.trades_per_day resolves null today)', () => {
    const items = rankDiscoveryItems(
      [detection({ analyticId: 'seq.trades_per_day', occurrences: 9 })],
      new Set(['trades_today']),
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it('skips a detection whose analytic is not rule_proposable, even with a real mapped operand', () => {
    const items = rankDiscoveryItems(
      [detection({ ruleProposable: false })],
      new Set([REENTRY_OPERAND_ID]),
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it('skips a resolvable operand this trader is not offered today (unauthorable / tier-gated out)', () => {
    const items = rankDiscoveryItems(
      [detection()],
      new Set(), // editableOperandIds empty -- nothing is offerable
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it('skips an operand already governed by an active global rule', () => {
    const items = rankDiscoveryItems(
      [detection()],
      new Set([REENTRY_OPERAND_ID]),
      new Set([REENTRY_OPERAND_ID]), // already in the rulebook
    );
    expect(items).toEqual([]);
  });

  it('surfaces a real, authorable, ungoverned detection with its own operand label and evidence', () => {
    const items = rankDiscoveryItems(
      [detection({ occurrences: 14 })],
      new Set([REENTRY_OPERAND_ID]),
      new Set(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      analyticId: 'seq.reentry_after_loss',
      operandId: REENTRY_OPERAND_ID,
      label: 'Cool-off after a loss',
      evidence: '14 times',
      seedValue: 2, // ceil(REENTRY_THRESHOLD_SECONDS=90 / 60) minutes
    });
  });

  it('uses singular "1 time" for a single occurrence, never "1 times"', () => {
    const items = rankDiscoveryItems(
      [detection({ occurrences: 1 })],
      new Set([REENTRY_OPERAND_ID]),
      new Set(),
    );
    expect(items[0].evidence).toBe('1 time');
  });

  it('ranks by occurrences descending', () => {
    const items = rankDiscoveryItems(
      [
        detection({ occurrences: 6 }),
        detection({ analyticId: 'seq.consecutive_losses', occurrences: 20 }),
      ],
      new Set([REENTRY_OPERAND_ID, STREAK_OPERAND_ID]),
      new Set(),
    );
    expect(items.map((i) => i.analyticId)).toEqual(['seq.consecutive_losses', 'seq.reentry_after_loss']);
  });

  it('tie-breaks equal occurrences by analyticId, deterministically', () => {
    const items = rankDiscoveryItems(
      [
        detection({ occurrences: 10 }),
        detection({ analyticId: 'seq.consecutive_losses', occurrences: 10 }),
      ],
      new Set([REENTRY_OPERAND_ID, STREAK_OPERAND_ID]),
      new Set(),
    );
    // 'seq.consecutive_losses' < 'seq.reentry_after_loss' alphabetically
    expect(items.map((i) => i.analyticId)).toEqual(['seq.consecutive_losses', 'seq.reentry_after_loss']);
  });

  it('mixes skip and surface correctly across several detections in one pass', () => {
    const items = rankDiscoveryItems(
      [
        detection({ occurrences: 14 }), // surfaces
        detection({ analyticId: 'seq.consecutive_losses', occurrences: 20 }), // governed, skipped
        detection({ analyticId: 'seq.daily_loss_breach', occurrences: 8 }), // no mapping, skipped
        detection({ analyticId: 'risk.spread', occurrences: 5, ruleProposable: false }), // not proposable, skipped
      ],
      new Set([REENTRY_OPERAND_ID, STREAK_OPERAND_ID]),
      new Set([STREAK_OPERAND_ID]),
    );
    expect(items.map((i) => i.analyticId)).toEqual(['seq.reentry_after_loss']);
  });
});
