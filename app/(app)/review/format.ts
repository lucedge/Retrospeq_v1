/**
 * Module 06 (Review & Graduation) Slice 5 — pure formatting helpers for
 * the `/review` screen, same "no styling decisions live here, just plain
 * text" posture `app/(app)/trades/format.ts` and `app/(app)/dashboard/
 * format.ts` already established for this repo (see docs/adr/0039).
 */

/** "21 July" — a `server_day` (`YYYY-MM-DD`, no time-of-day component)
 *  formatted as a plain calendar label, fixed to UTC for the same reason
 *  `formatDayOfWeek` (`dashboard/format.ts`) is: a `server_day` carries no
 *  timezone of its own to convert from. Locale is `en-GB`, not `en-US`,
 *  the same house-style choice `formatClockTime` (`trades/format.ts`)
 *  makes for day-first / unambiguous output — `en-US` renders
 *  day+month-only fields as "July 21" (month-first) even with no
 *  explicit `{month, day}` order requested, which does not match
 *  §5.1's "Week of 21 July" reference markup. */
function formatServerDayLong(serverDay: string): string {
  const [year, month, day] = serverDay.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** §5.1's own `<p class="review__period">Week of 21 July</p>` for a
 *  single-week period; a `covers_weeks > 1` catch-up review (§4.8) names
 *  both ends of the range instead, since "Week of" would misdescribe a
 *  period spanning more than one week. */
export function formatReviewPeriodLine(periodStart: string, periodEnd: string, coversWeeks: number): string {
  if (coversWeeks <= 1) return `Week of ${formatServerDayLong(periodStart)}`;
  return `${formatServerDayLong(periodStart)} – ${formatServerDayLong(periodEnd)}`;
}

/** §5.1 frame 4.1/4.3/4.4/4.5's `.rq-ring` — days-closed-of-days-traded as
 *  a completeness ring, `dasharray="138"` fixed (the mockup's own r=22
 *  circle: `2 * PI * 22 ≈ 138.2`, never recomputed here). `daysTraded`
 *  and `daysClosed` are already-materialised integers from
 *  `PeriodConsistency` — this is presentation-only arithmetic on numbers
 *  this screen already has, not a new statistic. A zero-trade week
 *  (`daysTraded === 0`) renders a full, un-filled ring (`dashoffset ===
 *  138`), matching frame 4.5's own reference SVG exactly. */
export function ringDashOffset(daysClosed: number, daysTraded: number): number {
  const ratio = daysTraded > 0 ? daysClosed / daysTraded : 0;
  return 138 - Math.round(138 * Math.min(1, Math.max(0, ratio)));
}

/** The ring's own centred label — "5/5" (frame 4.1/4.3), "—" for a
 *  zero-trade week (frame 4.5's own literal text) rather than a
 *  fabricated "0/0". */
export function ringText(daysClosed: number, daysTraded: number): string {
  if (daysTraded === 0) return '—';
  return `${daysClosed}/${daysTraded}`;
}

/** Which direction a fraction moved between two periods — "up"/"down"/
 *  "unchanged", used for the Adherence panel's "up from X of Y" trend
 *  clause (§5.1). Text-only, per AGENTS.md's "direction is geometry ...
 *  never hue" — there is no colour or icon anywhere in this comparison. */
export function fractionTrend(current: { followed: number; total: number }, prior: { followed: number; total: number }): 'up' | 'down' | 'unchanged' {
  if (prior.total === 0) return 'unchanged';
  const currentRatio = current.total === 0 ? 0 : current.followed / current.total;
  const priorRatio = prior.followed / prior.total;
  if (currentRatio > priorRatio) return 'up';
  if (currentRatio < priorRatio) return 'down';
  return 'unchanged';
}

/**
 * Module 06 Part 3 "close" — §5.1's own reference markup: "One line
 * summarising what changed" ("One rule added. Risk cap unchanged."). Built
 * ONLY from `fetchDecidedPromptOutcomes`' already-recorded `accepted` rows
 * (`review-prompts-repository.ts`) — every clause here traces to a real
 * `review_prompts.payload` field this repo actually wrote
 * (`markPromptAccepted`'s `ruleId`/`ruleRendered`,
 * `markPromptRecommitted`'s `resolution: 'recommit'`,
 * `markPromptAdjusted`'s `resolution: 'adjust'`), never a guess at WHICH
 * rule or subject changed — deliberately generic ("N rules added"), not
 * "Risk cap unchanged," since this repo has no way to name a relaxation
 * prompt's own subject rule generically at this call site (AGENTS.md:
 * "never invented"). "Nothing changed." (the exact §5.1 zero-decision
 * copy) when no prompt was ever accepted this review — the normal,
 * unremarkable case for most weeks.
 */
export function renderWeekCloseSummary(outcomes: ReadonlyArray<{ kind: string; payload: unknown }>): string {
  let ruleAdded = 0;
  let ruleChanged = 0;
  let ruleKept = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === 'graduation') {
      ruleAdded += 1;
    } else if (outcome.kind === 'relaxation') {
      const resolution = (outcome.payload as { resolution?: string } | null)?.resolution;
      if (resolution === 'adjust') {
        ruleChanged += 1;
      } else {
        // `resolution === 'recommit'` is the only other real value this
        // repo writes for an accepted relaxation prompt — an unrecognised
        // resolution still reads as "kept," never silently dropped.
        ruleKept += 1;
      }
    }
  }

  // "One rule added." for the single case (§5.1's own literal wording),
  // a plain numeral once there is more than one — both honest counts of
  // what was actually recorded, never a guess at WHICH rule.
  const countWord = (n: number): string => (n === 1 ? 'One' : String(n));

  const clauses: string[] = [];
  if (ruleAdded > 0) clauses.push(`${countWord(ruleAdded)} ${ruleAdded === 1 ? 'rule' : 'rules'} added`);
  if (ruleChanged > 0) clauses.push(`${countWord(ruleChanged)} ${ruleChanged === 1 ? 'rule' : 'rules'} changed`);
  if (ruleKept > 0) clauses.push(`${countWord(ruleKept)} ${ruleKept === 1 ? 'rule' : 'rules'} unchanged`);

  if (clauses.length === 0) return 'Nothing changed.';
  return clauses.join('. ') + '.';
}
