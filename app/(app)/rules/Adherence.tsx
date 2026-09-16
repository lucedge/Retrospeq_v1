import type { AdherenceDisplay } from '@/lib/rules/adherence-display';
import type { RuleChangeAnnotation } from '@/lib/rules/rule-change-annotations';

/**
 * Module 04 (Rulebook & Evaluation) §5.6 / §6.1's own reference markup —
 * Slice 10d part 2. Purely presentational (all fetching lives in
 * `page.tsx`, matching this repo's own "smart container/composition layer,
 * dumb view" split — same posture `AmbientStrip.tsx` already established
 * for `ambient-state.ts`'s output).
 *
 * **Two numbers, never blended, never a bare percentage** (AGENTS.md;
 * §5.6, verbatim). This renders EXACTLY §6.1's own three named paragraphs
 * — `.adherence__hard`, `.adherence__soft`, `.adherence__attribution` —
 * nothing else. There is no third, combined "X% adherence" figure anywhere
 * in this component, and no arithmetic here ever divides a hard count by a
 * soft one or vice versa.
 *
 * The hard/soft distinction this screen must communicate ("a risk breach
 * doesn't read like a skipped checkbox," story 3.3) is carried entirely by
 * the CSS this slice added (`retrospeq-design-system/brand/css/
 * components.css`'s `.adherence__hard`/`.adherence__soft` — weight and
 * order only) — this component itself does not decide "hard is more
 * important," it just renders both, hard first, per the reference markup's
 * own ordering.
 */

function pluralize(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

/**
 * Module 06 §4.7's "annotates the adherence timeline" — a quiet,
 * attribution-weight line per changed rule, never a button, never a
 * colour (AGENTS.md; this dispatch's own instruction). Renders nothing
 * at all when `annotations` is empty — an unedited rulebook this week is
 * the common case, not an omission to apologise for.
 */
function RuleChangeAnnotations({ annotations }: { annotations: RuleChangeAnnotation[] }) {
  if (annotations.length === 0) return null;
  return (
    <ul className="adherence__attribution list-none pl-0 flex flex-col gap-1">
      {annotations.map((a) => (
        <li key={a.ruleId + a.date}>
          You changed {a.subjectPhrase}
          {a.change ? (
            <>
              {' '}
              from <span className="rq-num">{a.change.from}</span> to <span className="rq-num">{a.change.to}</span>
            </>
          ) : null}{' '}
          on {a.date}.
        </li>
      ))}
    </ul>
  );
}

export function AdherenceSection({ display, annotations }: { display: AdherenceDisplay; annotations: RuleChangeAnnotation[] }) {
  if (display.status === 'insufficient_history') {
    // A genuine, honest "not enough data yet" state (AGENTS.md) — not an
    // error, and never a fabricated "0 of 0." Reasons this is correct and
    // expected, not exhaustively enumerated to the trader: a brand-new
    // account with no rules yet, a trader who hasn't confirmed a trade this
    // week yet, or (rarely) a best-effort recompute still pending
    // (`docs/runbook.md`, "adherence_weekly recompute failing after a
    // confirmation") — none of these are distinguishable from this read
    // alone, and none of them warrant alarming language.
    return (
      <section className="adherence" aria-labelledby="adh-h">
        <h2 id="adh-h">Adherence</h2>
        {/* Frame 3.5 states WHEN this will fill in, as a calm
            `.finding[data-confidence="insufficient"]` block — the design
            system's own "not enough data yet" surface — rather than a
            loose grey sentence. Same copy as before: it names the real
            condition (a confirmed trade THIS WEEK), not the frame's
            looser "your first confirmed trade". */}
        <div className="finding" data-confidence="insufficient">
          <p className="finding__statement">
            Not enough data yet — this fills in once you&apos;ve confirmed a trade this week.
          </p>
        </div>
        <RuleChangeAnnotations annotations={annotations} />
      </section>
    );
  }

  const { hard, soft, priorSoft, attribution } = display;
  const totalApplicable = hard.total + soft.total;

  return (
    <section className="adherence" aria-labelledby="adh-h">
      <h2 id="adh-h">Adherence</h2>
      <p className="adherence__hard">
        Hard rules:{' '}
        <strong>
          <span className="rq-num">
            {hard.followed} of {hard.total}
          </span>
        </strong>
        .
      </p>
      <p className="adherence__soft">
        Soft:{' '}
        <strong>
          <span className="rq-num">
            {soft.followed} of {soft.total}
          </span>
        </strong>
        {/* "up from X of Y" — omitted entirely (not fabricated as "0 of 0")
            when the prior week has no materialised row of its own, e.g.
            this trader's first week with any active rule. */}
        {priorSoft ? (
          <>
            , up from{' '}
            <span className="rq-num">
              {priorSoft.followed} of {priorSoft.total}
            </span>
          </>
        ) : null}
        .
      </p>
      {attribution ? (
        <p className="adherence__attribution">
          {attribution.rendered ? `"${attribution.rendered}"` : 'A rule'} accounts for{' '}
          <span className="rq-num">
            {attribution.count} of the {attribution.ofBreaks}
          </span>{' '}
          {pluralize(attribution.ofBreaks, attribution.severity === 'hard' ? 'hard break' : 'soft break')}.
        </p>
      ) : totalApplicable > 0 ? (
        // Zero breaks this week is a genuinely good state, still reported
        // plainly — AGENTS.md: "Adherence earns no XP, ever." No
        // celebratory language, no streak-style framing, just the fact.
        <p className="adherence__attribution">No rules were broken this week.</p>
      ) : null}
      <RuleChangeAnnotations annotations={annotations} />
    </section>
  );
}
