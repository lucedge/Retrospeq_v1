# ADR 0043 — Monthly review "edge stability" uses decay-tracking data, not a month-over-month snapshot

**Date:** 2026-09-15 · **Status:** accepted

## Deviation
Frame 4.13 (monthly review) shows edge stability as the same finding compared across months ("Conviction · Jul" vs "Conviction · May"). Module 06 §4.9 asks for "edge stability" over three months. `lib/review/monthly-edge-stability.ts` instead compares each graduated finding's win rate **at graduation** against its **current** value, using Module 05's existing decay-tracking data (`finding_rule_links` + the live decay tuple).

## Why
`findings` rows supersede in place — no per-month historical snapshot of a finding exists anywhere in the schema, so a "July vs May" comparison would have to be reconstructed or invented. The graduation-vs-current pair is the only real two-point comparison the product records, and it answers the same question the panel exists for: is this edge still holding up. Labels say "At graduation" / "Current" (or "Before" / "Last N"), never month names, so nothing is implied that the data can't support.

## Cost
- Only findings that became rules appear; an ungraduated confident finding has no stability row.
- The two points aren't three months apart; they're graduation date and now.
- A real month-over-month view needs finding snapshots (e.g. a `findings_history` row per computation run) — tracked as a follow-up in `docs/infra-gaps.md`, not built.
