import type { MilestoneId } from './events-repository';

/**
 * Module 07 (Engagement) §5.5/§6.1 — one quiet, factual sentence per
 * milestone id. §6.1's own reference markup gives the LITERAL copy for
 * exactly one milestone ("Twelve weeks without missing a close-out.",
 * `12wk_streak`); the other four follow that same register (a plain,
 * past-tense statement of fact, never an exclamation, never "you earned"/
 * "congratulations"/an emoji) — no other copy source names them, so this
 * is a documented judgment call, not a spec quote for those four.
 *
 * Never rendered as a modal, push notification, or full-screen
 * celebration anywhere in this repo (§5.5/§8.4) — the ONLY surface is
 * frame 1.18's inline `<div class="milestone" role="status">` on Home's
 * Clear state (`app/(app)/dashboard/page.tsx`).
 */
const MILESTONE_COPY: Record<MilestoneId, string> = {
  first_closeout: 'Your first day, closed out.',
  first_review: 'Your first review, done.',
  '4wk_streak': 'Four weeks without missing a close-out.',
  '12wk_streak': 'Twelve weeks without missing a close-out.',
  '50_verified_captures': 'Fifty pre-entry captures, verified.',
};

export function copyForMilestone(milestoneId: MilestoneId): string {
  return MILESTONE_COPY[milestoneId];
}
