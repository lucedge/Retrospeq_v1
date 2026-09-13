/**
 * Performance tab — Module 08 §7.2/§7.5: "Currency lives in the
 * Performance tab, entered deliberately." The tab exists because the
 * four-tab shell is fixed by spec; the screen itself (instrument.html
 * screen 17: cumulative R, realised currency, R distribution, by setup)
 * is NOT built yet — tracked in PROGRESS.md's UI phase.
 *
 * Says so plainly instead of rendering placeholder charts or invented
 * numbers (AGENTS.md "never fake it").
 */
export default function PerformancePage() {
  return (
    <section aria-labelledby="performance-h" className="flex flex-col gap-2">
      <h1 id="performance-h" className="rq-h1">
        Performance
      </h1>
      <p className="rq-sub">This screen isn’t built yet.</p>
      <p className="rq-sub">
        When it is, this is the one place currency appears: cumulative R, realised result, and how your trades
        are distributed.
      </p>
    </section>
  );
}
