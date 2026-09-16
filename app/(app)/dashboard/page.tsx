import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getDashboardStateForUser,
  type DashboardOpenPositionSummary,
  type DashboardReviewReadyState,
} from "@/lib/dashboard/dashboard-repository";
import { fetchAdherenceDisplay } from "../rules/actions";
import type {
  AdherenceDisplay,
  AdherenceFraction,
} from "@/lib/rules/adherence-display";
import { fetchEngagementSummaryForUser } from "@/lib/engagement/streak-repository";
import {
  fetchRecentWeekCompletenessForUser,
  type RecentWeekBar,
} from "@/lib/engagement/week-completeness-repository";
import { fetchRecentMilestoneForUser } from "@/lib/engagement/events-repository";
import { copyForMilestone } from "@/lib/engagement/milestone-copy";
import { fetchFieldIntroductionOfferForUser } from "@/lib/onboarding/field-introduction-repository";
import { FieldIntroductionOffer } from "./FieldIntroductionOffer";
import { DashboardGroupingChip } from "./DashboardGroupingChip";
import { weekStartForServerDay } from "@/lib/rules/week-boundary";
import {
  formatAge,
  formatClockTime,
  formatDirection,
  formatRiskPct,
} from "../trades/format";
import {
  formatDayOfWeek,
  formatDirectionLetter,
  rTrackFill,
} from "./format";

/**
 * Module 08 (Onboarding & Home) §7/§8 — the dashboard, all four §7.1
 * states now real: `open` / `closeout` / `review` / `clear`. See
 * `lib/dashboard/dashboard-repository.ts`'s own header for exactly how
 * "review ready" is derived honestly (no scheduler exists) and what
 * `open`'s own card still omits and why (no live current-R, no price
 * feed; conviction dots deferred — a documented, flagged scope gap, not a
 * silent one).
 *
 * **No currency P&L, no equity curve, no win rate, no setup pie chart**
 * anywhere on this screen (§7.2, AGENTS.md's own non-negotiable). No `R`
 * anywhere either — the one place §7's spec shows it (the open position's
 * LIVE "Now" row) is omitted entirely, never a placeholder, per the
 * repository module's own header.
 *
 * **Streak and the Clear-state dots are real, as of this slice.** Streak:
 * `fetchEngagementSummaryForUser`/`fetchRecentWeekCompletenessForUser`
 * (Module 07, already materialised). Adherence dots: hard and soft render
 * as their OWN separate rows (`AdherenceDotRows` below) — hard/soft are
 * never blended into one count, anywhere, no summary-screen exemption
 * (locked design decision, `retrospeq-design-decisions.md` §6; `09-
 * design-system.md` §0; `retrospeq-rules.md` hard rule 10). The quiet
 * "next finding" projection line remains honestly omitted — no source
 * exists anywhere in this repo for it yet (Module 05's findings machinery
 * has no such projection built).
 *
 * **Frame 1.18's milestone line, as of Module 07 Slice 2**: the Clear
 * state also shows the single most-recently-reached milestone from the
 * last 7 days (`fetchRecentMilestoneForUser`), one quiet `role="status"`
 * line, never a modal/push. XP itself is deliberately NOT rendered
 * anywhere on Home (§5.4: "may be shown quietly on a profile screen;
 * nothing depends on it") — out of this slice's own scope entirely.
 *
 * **Frame 1.19's field-introduction offer, Module 08 §5.5**: the Clear
 * state also, independently, may show the "Set up fields" offer
 * (`FieldIntroductionOffer`), framed by a REAL derived finding
 * (`fetchFieldIntroductionOfferForUser` — see that file's own header for
 * exactly what "≥1 derived finding shown" and "not offered in the last 30
 * days" mean here, and for a disclosed, pre-existing reachability gap:
 * the silent default strategy has zero fields, so no finding — derived or
 * otherwise — is ever computed for it without a field attached first).
 * `null` whenever any §5.5 condition fails — never a placeholder offer.
 * This is the ONE `.rq-btn` the Clear state ever shows (it otherwise has
 * none), matching the mockup's own caption: "the offer carries the
 * view's one primary."
 */

const STREAK_STRIP_WEEKS = 12;

/** Hard and soft, each their own `rq-dots` row, never merged — see this
 *  file's own header. The hard row is heavier (`.adherence__hard`, the
 *  same weight `/rulebook`'s own `AdherenceSection` already uses) and
 *  rendered first; it is OMITTED entirely when `hard.total === 0` (no
 *  hard rule has an applicable evaluation this week) rather than shown as
 *  a fabricated "0 of 0" row. Soft always renders (lighter,
 *  `.adherence__soft`). */
function AdherenceDotRows({ display }: { display: AdherenceDisplay }) {
  if (display.status !== "ready") return null;
  const { hard, soft } = display;
  return (
    <>
      {hard.total > 0 ? (
        <AdherenceDotRow
          label="Hard"
          count={hard}
          weightClass="adherence__hard"
        />
      ) : null}
      <AdherenceDotRow
        label="Soft"
        count={soft}
        weightClass="adherence__soft"
      />
    </>
  );
}

function AdherenceDotRow({
  label,
  count,
  weightClass,
}: {
  label: string;
  count: AdherenceFraction;
  weightClass: string;
}) {
  return (
    <div>
      <p className={`rq-label ${weightClass}`}>
        {label} ·{" "}
        <span className="rq-num">
          {count.followed} of {count.total}
        </span>
      </p>
      <div className="rq-dots">
        {Array.from({ length: count.total }, (_, i) => (
          <i key={i} className={i < count.followed ? undefined : "off"} />
        ))}
      </div>
    </div>
  );
}

function StreakStrip({
  streakWeeks,
  bars,
}: {
  streakWeeks: number;
  bars: RecentWeekBar[];
}) {
  return (
    <div>
      <p className="rq-label">
        Logging streak · <span className="rq-num">{streakWeeks}</span>{" "}
        {streakWeeks === 1 ? "week" : "weeks"}
      </p>
      <div className="rq-strip" style={{ ["--rq-strip-h" as string]: "28px" }}>
        {bars.map((bar) => {
          // Height is an honest ratio of THIS week's own materialised
          // counts (§5.2's own formula: days_closed can exceed
          // days_traded on a deliberate-no-trade week, clamped to 100%
          // for the bar itself; a week with no trading at all reads as a
          // real, visible gap, never a fabricated full bar).
          const heightPct = bar.hasActivity
            ? Math.min(100, Math.round((bar.daysClosed / bar.daysTraded) * 100))
            : 30;
          return (
            <i
              key={bar.weekStart}
              style={{ height: `${heightPct}%` }}
              className={bar.hasActivity ? undefined : "gap"}
            />
          );
        })}
      </div>
    </div>
  );
}

function ConsistencyRing({
  daysClosed,
  daysTraded,
}: {
  daysClosed: number;
  daysTraded: number;
}) {
  const ratio = daysTraded > 0 ? Math.min(1, daysClosed / daysTraded) : 0;
  const circumference = 138;
  return (
    <div
      className="rq-card"
      style={{ display: "flex", alignItems: "center", gap: 14 }}
    >
      <div className="rq-ring">
        <svg width="52" height="52">
          <circle
            cx="26"
            cy="26"
            r="22"
            fill="none"
            stroke="var(--rq-mark-dim)"
            strokeWidth="4"
          />
          <circle
            cx="26"
            cy="26"
            r="22"
            fill="none"
            stroke="var(--rq-mark)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <span className="rq-ring__text rq-num">
          {daysClosed}/{daysTraded}
        </span>
      </div>
      <div>
        <p className="rq-label" style={{ margin: "0 0 3px" }}>
          Consistency
        </p>
        <p className="rq-body" style={{ margin: 0 }}>
          {daysTraded === 0
            ? "No trading days yet this period."
            : daysClosed >= daysTraded
              ? "Every day closed out."
              : `${daysClosed} of ${daysTraded} days closed out.`}
        </p>
      </div>
    </div>
  );
}

/**
 * Hard and soft, ALWAYS separate — no summary-screen exemption (see this
 * file's own header). `rq-cmp` compares SOFT this week vs SOFT last week
 * only — the one like-for-like unit `fetchPeriodAdherence`'s own
 * `priorSoft` already provides (comparing a hard+soft blend against a
 * soft-only prior would silently compare non-equivalent units). Hard
 * gets its own plain "Hard rules: N of M." line, no trend claimed for it
 * (no comparable prior figure is computed for hard here), omitted
 * entirely when `hard.total === 0`.
 */
function ReviewAdherenceCmp({ review }: { review: DashboardReviewReadyState }) {
  if (
    review.adherence === null ||
    (review.adherence.hard.total === 0 && review.adherence.soft.total === 0)
  ) {
    return (
      <div>
        <p className="rq-label">Adherence</p>
        <p className="rq-sub">Not enough data yet.</p>
      </div>
    );
  }
  const { hard, soft, priorSoft } = review.adherence;
  const thisPct =
    soft.total > 0 ? Math.round((soft.followed / soft.total) * 100) : 0;
  const lastPct =
    priorSoft && priorSoft.total > 0
      ? Math.round((priorSoft.followed / priorSoft.total) * 100)
      : 0;
  return (
    <div>
      {hard.total > 0 ? (
        <p className="rq-body adherence__hard">
          Hard rules: <span className="rq-num">{hard.followed}</span> of{" "}
          <span className="rq-num">{hard.total}</span>.
        </p>
      ) : null}
      {soft.total > 0 ? (
        <>
          <p className="rq-label adherence__soft">
            Soft ·{" "}
            <span className="rq-num">
              {soft.followed} of {soft.total}
            </span>
            {priorSoft ? (
              <>
                , last week{" "}
                <span className="rq-num">
                  {priorSoft.followed} of {priorSoft.total}
                </span>
              </>
            ) : null}
          </p>
          <div className="rq-cmp">
            <div className="rq-cmp__row hot">
              <span className="rq-cmp__lbl">This week</span>
              <div className="rq-cmp__track">
                <i className="rq-cmp__fill" style={{ width: `${thisPct}%` }} />
              </div>
              <span className="rq-cmp__val rq-num">{soft.followed}</span>
            </div>
            {priorSoft ? (
              <div className="rq-cmp__row">
                <span className="rq-cmp__lbl">Last week</span>
                <div className="rq-cmp__track">
                  <i
                    className="rq-cmp__fill"
                    style={{ width: `${lastPct}%` }}
                  />
                </div>
                <span className="rq-cmp__val rq-num">{priorSoft.followed}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Gauge scale is a documented, deliberate headroom multiplier (2x the
 *  cap) so a trader crossing the cap reads as "the bar moved," not "the
 *  gauge broke" (§7.1's own cap example, "the gauge is always on") —
 *  there is no spec-given formula for exactly where the cap tick sits, so
 *  this picks a fixed, visible headroom rather than clamping the scale to
 *  the cap itself (which would make crossing it unrenderable). */
function RiskGauge({
  riskPct,
  capPct,
}: {
  riskPct: string | null;
  capPct: string;
}) {
  const risk = Number(riskPct);
  const cap = Number(capPct);
  const scaleMax = cap * 2;
  const fillPct =
    Number.isFinite(risk) && scaleMax > 0
      ? Math.min(100, Math.max(0, (risk / scaleMax) * 100))
      : 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="rq-gauge">
        <i className="rq-gauge__fill" style={{ width: `${fillPct}%` }} />
        <i className="rq-gauge__cap" style={{ left: "50%" }} />
      </div>
      <div className="rq-gauge__lbl">
        <span>
          Risk <span className="rq-num">{formatRiskPct(riskPct)}</span>
        </span>
        <span>
          Cap <span className="rq-num">{formatRiskPct(capPct)}</span>
        </span>
      </div>
    </div>
  );
}

function OpenPositionCard({
  position,
  now,
}: {
  position: DashboardOpenPositionSummary;
  now: Date;
}) {
  return (
    <article className="open-position rq-card">
      <div className="open-position__head">
        <span className="instrument">
          {position.instrument} {formatDirection(position.direction)}
        </span>
        <time className="rq-num rq-sub" dateTime={position.openedAt}>
          {formatAge(position.openedAt, now)}
        </time>
      </div>
      {position.riskCapPct ? (
        <RiskGauge riskPct={position.riskPct} capPct={position.riskCapPct} />
      ) : (
        <dl className="open-position__facts">
          <div>
            <dt>Risk</dt>
            <dd className="rq-num">{formatRiskPct(position.riskPct)}</dd>
          </div>
        </dl>
      )}
    </article>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page in
  // this app tree uses for the rare session-expired-mid-render case.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const now = new Date();
  const state = await getDashboardStateForUser(user.id, now);
  const day = formatDayOfWeek(now);

  if (state.kind === "open") {
    const count = state.positions.length;
    return (
      <main className="dash" data-state="open">
        <p className="dash__day">{day}</p>
        <h1 className="dash__headline">
          <span className="rq-num">{count}</span> position
          {count === 1 ? "" : "s"} open.
        </h1>
        {/*
          Not `.dash__trades` (that class's own `> li { display: flex;
          align-items: center }` is the CLOSEOUT row shape below -- a
          horizontal instrument/dir/time lane -- and would lay an
          open-position CARD plus a grouping chip out side-by-side instead
          of stacked). Frames 1.13/1.17 show the card as a plain block; a
          plain flex-column list is the honest generalisation to "more
          than one open position," not a reuse of an unrelated primitive.
        */}
        <ul className="flex flex-col gap-3">
          {state.positions.map((p) => (
            <li key={p.id} className="flex flex-col gap-2">
              <OpenPositionCard position={p} now={now} />
              {/* Frame 1.17 -- ambient, dismissible, never a modal (Module
                  02 §4.3). Renders only for the one confidence band that
                  ever asks -- see `DashboardGroupingChip.tsx`'s own header. */}
              {p.groupingConfidence === "ambiguous" ? (
                <DashboardGroupingChip tradeId={p.id} />
              ) : null}
            </li>
          ))}
        </ul>
        <p className="dash__quiet push">Nothing to do until it closes.</p>
      </main>
    );
  }

  if (state.kind === "closeout") {
    const count = state.trades.length;
    const closeOutHref = state.target
      ? `/trades/close-out?account=${state.target.accountId}&day=${state.target.serverDay}`
      : "/trades/close-out";
    return (
      <main className="dash" data-state="closeout">
        <p className="dash__day">{day}</p>
        <h1 className="dash__headline">
          <span className="rq-num">{count}</span> trade{count === 1 ? "" : "s"}{" "}
          to close out.
        </h1>
        {/* Frame 1.14 -- "the day reads as three marks," `.rq-row` (true
            fixed-width lanes) + the `.rq-rrow` track/fill primitive for a
            real, signed R value per trade -- not `.dash__trades` (a
            different, plain instrument/dir/time row this frame doesn't
            use at all). `t.rMultiple` is real (`trades.r_multiple`,
            computed at close time); `null` renders an honest empty track,
            never a fabricated bar -- see `DashboardTradeSummary`'s own
            header. */}
        <div>
          {/* Chronological, oldest first, matching frame 1.14's own read
              ("the day reads as three marks"). The repository orders
              newest-first for its other callers, so sort a copy here
              rather than change a shared query (qa FAIL, 2026-09-16). */}
          {[...state.trades]
            .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
            .map((t) => {
            const fill = rTrackFill(t.rMultiple);
            return (
              <div className="rq-row" key={t.id}>
                <span className="rq-row__name">{t.instrument}</span>
                <span className="rq-row__meta">
                  {formatDirectionLetter(t.direction)}
                </span>
                <div className="rq-track">
                  {fill ? (
                    <i
                      className="rq-fill"
                      style={
                        // `fill.pct` is 0-100 against the HALF-track (the
                        // zero line sits at 50% of the full track's own
                        // width, per `.rq-track::before`) -- halved here
                        // so a maxed-out 100% never overflows past the
                        // track's own right/left edge.
                        fill.side === "pos"
                          ? { left: "50%", width: `${fill.pct / 2}%` }
                          : { right: "50%", width: `${fill.pct / 2}%` }
                      }
                    />
                  ) : null}
                </div>
                <span className="sr-only">
                  {t.rMultiple === null
                    ? "R not applicable -- the stop was never known."
                    : `${t.rMultiple}R`}
                </span>
                <span className="rq-row__end rq-num">
                  {formatClockTime(t.openedAt)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="push">
          <Link href={closeOutHref} className="rq-btn rq-btn--block">
            Close out the day
          </Link>
          <p
            className="rq-label"
            style={{ textAlign: "center", marginTop: 10 }}
          >
            About thirty seconds
          </p>
        </div>
      </main>
    );
  }

  if (state.kind === "review") {
    const { review } = state;
    return (
      <main className="dash" data-state="review">
        <p className="dash__day">{day}</p>
        <h1 className="dash__headline">Your week is ready to read.</h1>

        <ConsistencyRing
          daysClosed={review.consistency.daysClosed}
          daysTraded={review.consistency.daysTraded}
        />

        <ReviewAdherenceCmp review={review} />

        <div>
          <p className="rq-label">What your trades say</p>
          {review.teaser ? (
            <p className="rq-sub">
              <span className="rq-num">{review.teaser.findingsCount}</span>{" "}
              {review.teaser.findingsCount === 1 ? "finding" : "findings"} ·{" "}
              <b style={{ color: "var(--rq-ink)" }}>
                <span className="rq-num">{review.teaser.pendingDecisions}</span>{" "}
                {review.teaser.pendingDecisions === 1
                  ? "decision"
                  : "decisions"}
              </b>
            </p>
          ) : (
            <p className="rq-sub">Open to see what your trades say.</p>
          )}
        </div>

        <div className="push">
          <Link href="/review" className="rq-btn rq-btn--block">
            Start review
          </Link>
        </div>
      </main>
    );
  }

  // Clear — §7.3: "the hardest state to ship and matters most." An honest
  // "still syncing" note replaces the fabricated-nothing-wrong headline
  // exactly when the underlying reads failed (§12's DASH_STATE_UNRESOLVED),
  // never an error screen.
  const currentWeekStart = weekStartForServerDay(
    now.toISOString().slice(0, 10),
  );
  const [
    adherenceResult,
    engagementSummary,
    recentWeeks,
    recentMilestone,
    fieldIntroductionOffer,
  ] = await Promise.all([
    fetchAdherenceDisplay(),
    fetchEngagementSummaryForUser(user.id),
    fetchRecentWeekCompletenessForUser(
      user.id,
      currentWeekStart,
      STREAK_STRIP_WEEKS,
    ),
    fetchRecentMilestoneForUser(user.id, now),
    fetchFieldIntroductionOfferForUser(user.id, now).catch((err) => {
      // §7.2/§12's own "Home never shows an error" posture, applied to
      // this one additional read too — a failure here degrades to "no
      // offer this render," never an error branch on an otherwise-healthy
      // Clear state.
      console.error(
        "[dashboard] fetchFieldIntroductionOfferForUser failed -- degrading to no offer this render (Module 08 §5.5):",
        err,
      );
      return null;
    }),
  ]);

  return (
    <main className="dash" data-state="clear">
      <p className="dash__day">{day}</p>
      <h1 className="dash__headline">Nothing to close out.</h1>
      {state.syncDegraded ? (
        <p className="dash__sub">Your week is complete through today.</p>
      ) : (
        <p className="dash__sub">Your day is clear.</p>
      )}

      {engagementSummary ? (
        <StreakStrip
          streakWeeks={engagementSummary.streakWeeks}
          bars={recentWeeks}
        />
      ) : (
        <p className="rq-sub">Not enough data yet for a streak.</p>
      )}

      {adherenceResult.success &&
      adherenceResult.display &&
      adherenceResult.display.status === "ready" ? (
        <AdherenceDotRows display={adherenceResult.display} />
      ) : (
        <p
          className="rq-sub"
          role={adherenceResult.success ? undefined : "alert"}
        >
          {adherenceResult.success
            ? "Not enough data yet — this fills in once you’ve confirmed a trade this week."
            : (adherenceResult.error?.user_message ??
              "Adherence is unavailable right now.")}
        </p>
      )}

      {/* Frame 1.18 -- the most recent milestone reached in the last 7
          days, ONE quiet inline line, never a modal, never a push
          (Module 07 §5.5/§6.1/§8.4). `fetchRecentMilestoneForUser` itself
          already gates on the 7-day window; nothing renders when there is
          none -- an honestly empty case, not a placeholder. */}
      {recentMilestone ? (
        <div className="milestone" role="status">
          <p className="milestone__text">
            {copyForMilestone(recentMilestone.milestoneId)}
          </p>
        </div>
      ) : null}

      {/* Frame 1.19 -- the field-introduction offer, ONLY when every §5.5
          condition genuinely clears (never a placeholder). See this file's
          own header and `fetchFieldIntroductionOfferForUser`'s for the
          full eligibility/reachability reasoning. */}
      {fieldIntroductionOffer ? (
        <FieldIntroductionOffer statement={fieldIntroductionOffer.statement} />
      ) : null}

      {/* The quiet "next finding" projection line (§7.3's own worked
          example) stays honestly omitted -- no source in this repo
          computes it yet (Module 05 has no such projection built). Never
          fabricated, per AGENTS.md. */}

      {state.syncDegraded ? (
        <p className="sync push">
          Syncing — this may not reflect your latest activity.
        </p>
      ) : null}
    </main>
  );
}
