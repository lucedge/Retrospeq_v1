import type { AmbientAccountState } from '@/lib/rules/ambient-state';

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §6.1's ambient strip — Slice
 * 10d. Purely presentational (all fetching lives in `ManualEntryScreen.tsx`,
 * matching this repo's own "smart container, dumb view" split wherever one
 * component's state needs to be shared with a sibling, e.g.
 * `GuidedFrontDoor.tsx`'s own card list vs. its own per-card component).
 *
 * **"Facts ambient. Judgments silent."** (§5.9, verbatim.) This renders
 * EXACTLY the three named fact cells §6.1's own reference markup gives —
 * Today / Day P&L / Risk — nothing else. Deliberately does NOT render a
 * per-rule "followed/broken" breakdown: that reads as the JUDGMENT half of
 * §5.9's own fact/judgment table ("unmet trigger conditions, setup
 * quality... Silent until weekly review"), which this screen has no
 * business surfacing pre-emptively. `state.rules` (every governing rule's
 * own live evaluation) still flows through this file's caller
 * (`ManualEntryScreen.tsx`) for the ONE thing §5.9 actually asks a
 * pre-entry screen to do with it — write a `rule_overrides` row the moment
 * the trader proceeds past a visible breach — without ever being rendered
 * as a list of verdicts here.
 *
 * ALWAYS rendered — three cells, every time, regardless of loading/error
 * state (AGENTS.md: "gauges/ambient strip are always visible, never
 * appear-on-threshold"). A brand-new account with zero trades, a $0 day,
 * and no configured risk cap still renders all three cells in their
 * genuine `neutral` state — never omitted, never a fabricated alarm.
 *
 * Tint (`data-state="neutral" | "watch" | "breach"`) is driven entirely by
 * `retrospeq-design-system/brand/css/components.css`'s `.ambient__cell`
 * rules, which encode state through border weight/box-shadow/font-weight
 * only — confirmed by reading that stylesheet directly before writing this
 * component, not assumed: there is no hue swap anywhere in it, and no
 * `--color-success`/`--color-danger` pair exists in this design system by
 * design (AGENTS.md). That CSS did not exist before this slice — `.ambient`/
 * `.ambient__cell`/`.ambient__label`/`.ambient__value` were named in
 * Module 04 §6.1's own reference markup but never implemented anywhere in
 * `retrospeq-design-system/brand/`; added there (and re-synced to
 * `public/brand/css/components.css`) as part of this slice, not invented
 * independently of the spec that already named them.
 */

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function formatTradesToday(value: number): string {
  return value === 0 ? 'No trades yet' : `${ordinal(value)} trade`;
}

/** Signed, one decimal place — matches §6.1's own worked example
 *  ("&minus;2.1%"). `null` only when equity is genuinely unknown
 *  (`docs/adr/0013`) — an honest "Unknown" beats a fabricated 0%. */
function formatSignedPercent(value: number | null): string {
  if (value === null) return 'Unknown';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** §6.1's own worked example: "1.4 / 1.0" (current / cap). `capPct === null`
 *  is itself a real, always-present state ("no cap configured yet" —
 *  `ambient-state.ts`'s own `AmbientRiskVsCap` doc comment), rendered as an
 *  em dash rather than silently dropping the second number. */
function formatRiskVsCap(currentPct: number | null, capPct: number | null): string {
  const currentStr = currentPct === null ? 'Unknown' : currentPct.toFixed(1);
  const capStr = capPct === null ? '—' : capPct.toFixed(1);
  return `${currentStr} / ${capStr}`;
}

export function AmbientStrip({ state, loading }: { state: AmbientAccountState | null; loading: boolean }) {
  const tradesTint = state?.facts.tradesToday.tint ?? 'neutral';
  const pnlTint = state?.facts.dayPnlPct.tint ?? 'neutral';
  const riskTint = state?.facts.riskVsCap.tint ?? 'neutral';

  return (
    <div className="ambient" role="group" aria-label="Account state" aria-busy={loading}>
      <div className="ambient__cell" data-state={tradesTint}>
        <span className="ambient__label">Today</span>
        <span className="ambient__value rq-num">
          {loading || !state ? '…' : formatTradesToday(state.facts.tradesToday.value)}
        </span>
      </div>
      <div className="ambient__cell" data-state={pnlTint}>
        <span className="ambient__label">Day P&amp;L</span>
        <span className="ambient__value rq-num">
          {loading || !state ? '…' : formatSignedPercent(state.facts.dayPnlPct.value)}
        </span>
      </div>
      <div className="ambient__cell" data-state={riskTint}>
        <span className="ambient__label">Risk</span>
        <span className="ambient__value rq-num">
          {loading || !state ? '…' : formatRiskVsCap(state.facts.riskVsCap.currentPct, state.facts.riskVsCap.capPct)}
        </span>
      </div>
    </div>
  );
}
