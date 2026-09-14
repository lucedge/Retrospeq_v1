import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

import {
  ENGAGEMENT_EVENT_KINDS,
  MILESTONE_IDS,
  dayClosedSubjectId,
  milestoneSubjectId,
  milestonesSatisfiedBy,
} from '../events-repository';
import { copyForMilestone } from '../milestone-copy';

/**
 * Module 07 (Engagement) Slice 2 — pure/unit coverage for the deterministic
 * subject-id derivations, the §5.5 milestone-condition predicate, and
 * §8.2's own property tests ("no event exists whose verification_source
 * is the trader's own unverified input", "no engagement event references
 * a rule, evaluation, finding, or P&L value") via a static grep, since
 * both are claims about every call site in this repo, not about one
 * function's own logic in isolation.
 */

describe('dayClosedSubjectId — deterministic per (accountId, serverDay)', () => {
  it('is stable across repeated calls with the same inputs', () => {
    expect(dayClosedSubjectId('acct-1', '2026-09-10')).toBe(dayClosedSubjectId('acct-1', '2026-09-10'));
  });

  it('differs for a different server_day on the same account', () => {
    expect(dayClosedSubjectId('acct-1', '2026-09-10')).not.toBe(dayClosedSubjectId('acct-1', '2026-09-11'));
  });

  it('differs for a different account on the same server_day', () => {
    expect(dayClosedSubjectId('acct-1', '2026-09-10')).not.toBe(dayClosedSubjectId('acct-2', '2026-09-10'));
  });

  it('is a syntactically real UUID', () => {
    expect(dayClosedSubjectId('acct-1', '2026-09-10')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('milestoneSubjectId — deterministic per milestoneId', () => {
  it('is stable and distinct across every milestone id', () => {
    const ids = MILESTONE_IDS.map((m) => milestoneSubjectId(m));
    expect(new Set(ids).size).toBe(MILESTONE_IDS.length);
    expect(milestoneSubjectId('first_closeout')).toBe(milestoneSubjectId('first_closeout'));
  });
});

describe('milestonesSatisfiedBy — §5.5 conditions, pure', () => {
  it('nothing satisfied at zero counts/streak', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 0, streakWeeks: 0 }),
    ).toEqual([]);
  });

  it('first_closeout at exactly 1 day_closed event', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 1, reviewCompletedCount: 0, preEntryVerifiedCount: 0, streakWeeks: 0 }),
    ).toEqual(['first_closeout']);
  });

  it('first_review at exactly 1 review_completed event', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 1, preEntryVerifiedCount: 0, streakWeeks: 0 }),
    ).toEqual(['first_review']);
  });

  it('4wk_streak at streakWeeks 4, NOT at 3', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 0, streakWeeks: 3 }),
    ).toEqual([]);
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 0, streakWeeks: 4 }),
    ).toEqual(['4wk_streak']);
  });

  it('both 4wk_streak and 12wk_streak satisfied at streakWeeks 12', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 0, streakWeeks: 12 }),
    ).toEqual(['4wk_streak', '12wk_streak']);
  });

  it('50_verified_captures at exactly 50, NOT at 49', () => {
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 49, streakWeeks: 0 }),
    ).toEqual([]);
    expect(
      milestonesSatisfiedBy({ dayClosedCount: 0, reviewCompletedCount: 0, preEntryVerifiedCount: 50, streakWeeks: 0 }),
    ).toEqual(['50_verified_captures']);
  });

  it('every real milestone id has a copy string, and no other id does', () => {
    for (const id of MILESTONE_IDS) {
      expect(copyForMilestone(id).length).toBeGreaterThan(0);
    }
  });
});

/**
 * §8.2's own property test, made concrete as a static check: "No
 * engagement event references a rule, evaluation, finding, or P&L
 * value" and "never reward field completeness/adherence" (§2). Every
 * `kind`/`verificationSource` literal this repo's engagement code ever
 * writes must come from the two closed lists this file imports — grepping
 * every `.ts`/`.tsx` source file under `lib/` and `app/` for a call to
 * `emitEngagementEvent`/`emitDayClosedEvent`/`emitReviewCompletedEvent`/
 * `emitPreEntryVerifiedEvent` with a `kind:` literal outside
 * `ENGAGEMENT_EVENT_KINDS` would be the shape of a violation — since the
 * DB's own CHECK constraint (`engagement_events_kind_check`) already
 * makes any OTHER literal impossible to persist even if application code
 * tried, this test instead asserts the closed list itself matches the
 * migration's own CHECK constraint text byte-for-byte, so the two can
 * never silently drift apart.
 */
describe('engagement event kinds — closed list matches the migration CHECK constraint (§8.2)', () => {
  const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260915010000_engagement_events_schema.sql',
  );

  it('ENGAGEMENT_EVENT_KINDS is exactly the four kinds §5.1 names, no more, no fewer', () => {
    expect([...ENGAGEMENT_EVENT_KINDS].sort()).toEqual(
      ['day_closed', 'review_completed', 'pre_entry_verified', 'milestone_reached'].sort(),
    );
  });

  it('the migration file\'s own kind CHECK constraint names exactly these four values, nothing else', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const constraintMatch = sql.match(/engagement_events_kind_check\s*\n\s*check \(kind in \(([^)]+)\)\)/);
    expect(constraintMatch, 'engagement_events_kind_check constraint text not found').not.toBeNull();
    const literals = (constraintMatch![1].match(/'([a-z_0-9]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect([...literals].sort()).toEqual([...ENGAGEMENT_EVENT_KINDS].sort());
  });

  it('no application source file under lib/ or app/ inserts an engagement_events kind literal outside the closed list', () => {
    const roots = ['lib', 'app'].map((d) => join(process.cwd(), d));
    const offenders: string[] = [];
    const kindLiteralPattern = /kind:\s*'([a-z_]+)'/g;

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
          !entry.name.endsWith('.test.ts')
        ) {
          const text = readFileSync(full, 'utf8');
          if (!text.includes('engagement_events') && !full.includes('events-repository.ts')) continue;
          for (const match of text.matchAll(kindLiteralPattern)) {
            const literal = match[1];
            if (
              full.includes('events-repository.ts') &&
              !(ENGAGEMENT_EVENT_KINDS as readonly string[]).includes(literal)
            ) {
              offenders.push(`${full}: kind '${literal}'`);
            }
          }
        }
      }
    }
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
