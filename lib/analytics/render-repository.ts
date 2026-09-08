import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import type { Surface } from './registry-runtime';

/**
 * `retrospeq.analytic_renders` write — Module 05 §4.8's own closing
 * line: "Every successful render writes an analytic_renders row with the
 * exact payload shown." §3.1's own table comment: "Records every render.
 * Makes 'was this ever wrong?' answerable."
 *
 * `service_role` per ADR 0005's pattern: this table is materialised,
 * owner-SELECT-only, no client INSERT policy at all (the migration's own
 * comment) — the same shape `operand_distributions`/`adherence_weekly`
 * already established for Module 04's own materialised tables. Every
 * query below is explicitly scoped to the caller-supplied `userId`,
 * never trusting RLS to narrow it (bypassed here), matching every prior
 * `withServiceRoleConnection` call site's own established discipline.
 *
 * DELIBERATELY the caller's responsibility, not `canRender`'s own: a
 * `canRender() -> true` result is a PERMISSION, not a render — nothing
 * has actually been shown or computed yet at that point. Only the
 * concrete analytic that goes on to compute a real payload and actually
 * display it knows what the "exact payload shown" (§4.8) really is;
 * `canRender` itself has no payload to record. Composable: `if
 * ((await canRender(...)).canRender) { const payload = computeX(...);
 * await recordAnalyticRender(...); render(payload); }` — no real caller
 * exists yet (no analytic is computed in this slice), so this function
 * is exercised directly by this slice's own tests only.
 */
export interface AnalyticRenderRecord {
  userId: string;
  analyticId: string;
  surface: Surface;
  /** The exact computed values shown — §4.8's own "exact payload shown." */
  payload: Record<string, unknown>;
}

export interface AnalyticRenderRow extends AnalyticRenderRecord {
  id: string;
  renderedAt: string; // timestamptz, ISO 8601 UTC
}

export async function recordAnalyticRender(record: AnalyticRenderRecord): Promise<AnalyticRenderRow> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string; rendered_at: string }>(
      `insert into retrospeq.analytic_renders (user_id, analytic_id, surface, payload)
       values ($1, $2, $3, $4::jsonb)
       returning id, rendered_at`,
      [record.userId, record.analyticId, record.surface, JSON.stringify(record.payload)],
    );
    const row = res.rows[0];
    return {
      ...record,
      id: row.id,
      renderedAt: row.rendered_at,
    };
  });
}
