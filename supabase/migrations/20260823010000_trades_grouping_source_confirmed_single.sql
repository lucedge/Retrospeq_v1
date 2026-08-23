-- Module 02 §4.3/§4.7 -- widens trades_grouping_source_check to allow a new
-- grouping_source value, 'user_confirmed_single', for the new
-- resolveAmbiguousGroupingAsSingle() operation (lib/ingestion/split-join.ts).
--
-- Design-ethics fix (retrospeq-qa finding, Module 02 Slice 7b, 2026-08-23):
-- GroupingChip.tsx's ambient "Same trade" / "Separate" pair is a
-- `.rq-btn--equal` pair (AGENTS.md's design-system rule: "no primary/
-- secondary distinction ... the relaxation prompt must not imply a
-- recommendation"). Slice 7b wired "Separate" to a real deep link into
-- SplitControl but left "Same trade" permanently disabled, because no write
-- existed that resolves an ALREADY-correctly-grouped ambiguous trade's own
-- VERDICT to confident_single without also touching trade_fills/trade_events
-- membership -- the only two writes that could do that (splitTrade/
-- joinTrades) both require an explicit boundary/counterpart trade, and
-- neither operates on "no boundary chosen, the grouping was already right."
-- This value backs the missing write, restoring the pair's required
-- symmetry.
--
-- 'user_confirmed_single' is deliberately a NEW, distinct value rather than
-- reusing 'user_split'/'user_join': those two both restructure trade_fills/
-- trade_events membership (splitTrade creates two trades from one, joinTrades
-- merges two into one); this one never touches membership at all, it only
-- resolves grouping_confidence/grouping_signals/ambiguity_resolved_at on a
-- trade whose membership was already correct as-is. Keeping the value
-- distinct preserves that real provenance difference for any future
-- analytics/audit code reading grouping_source (e.g. "how often did the
-- trader confirm the auto-grouping was right, versus actually restructure
-- it").
alter table retrospeq.trades drop constraint trades_grouping_source_check;
alter table retrospeq.trades add constraint trades_grouping_source_check
  check (grouping_source in ('auto', 'user_split', 'user_join', 'user_confirmed_single'));

-- VERIFIED: applied to and confirmed against the live shared dev Supabase
-- project via information_schema.check_constraints / pg_get_constraintdef
-- (constraint definition now lists all four values), plus a direct INSERT
-- probe proving 'user_confirmed_single' is accepted and an out-of-catalogue
-- value is still rejected -- see PROGRESS.md decision log, 2026-08-23.
