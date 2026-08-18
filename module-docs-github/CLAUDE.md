# CLAUDE.md — LuceEdge V1 Module Specifications

## What this repo is

This is **not a code repository.** It is the canonical product specification for **LuceEdge V1**, a behavioral-discipline app for retail traders. The deliverables here are Markdown specs — 21 module docs plus four cross-cutting reference docs — that downstream engineering will implement.

Your job in this repo is **spec refactoring**, not code generation. Do not:
- Suggest, scaffold, or write application code.
- Run build/test commands. There is no build.
- Invent acceptance criteria, user stories, or APIs that aren't already implied by the docs or explicitly requested.

You may:
- Rewrite, restructure, or extend module sections when asked.
- Surface cross-module inconsistencies (terminology, ownership, references).
- Propose section additions, but flag them as proposals before writing.

---

## Canonical reference docs (treat as source of truth)

When module text conflicts with these, the cross-cutting docs win. Read them before any non-trivial refactor:

@LuceEdge_V1_Feature_Requirements_v2.md
@LuceEdge_V1_Database_Schema.md
@LuceEdge_Tech_Stack_Review_v1.md
@LuceEdge__Behavioral_Pattern_Detection_Spec_for_Retail_Trader_Discipline.md
@TradeLogAI_AI_and_Insights_Brainstorm.md
@LuceEdge_AWS_Cost_Validation.md

---

## Product fundamentals (DO NOT drift on these)

- **Two tiers:** `Free` and `Pro` (₹399/month). A future `Trader+` tier is referenced in the schema but is **not V1**.
- **Personas:** "Free trader", "Pro trader", "active trader", "new trader", "developer", "analyst (offline)". User stories must use one of these — do not invent new personas.
- **Currency:** ₹ (INR). Money fields are `DECIMAL(20,4)`.
- **Locale:** India. Time zones per-user (IANA), stored UTC.
- **Markets:** Indian equities + F&O. Not US markets.

---

## Fixed terminology — never paraphrase

These terms are load-bearing. Refactor must preserve them exactly.

| Term | Meaning | Do NOT call it |
|---|---|---|
| **Pattern** | One of the 8 V1 behavioral patterns | "behavior", "rule", "anti-pattern" |
| **Gate** | Pre-save check; fires as `none` / `soft` / `hard` | "block", "warning", "guardrail" |
| **Soft gate** | Warning, user can proceed | "warning gate" |
| **Hard gate** | 15-minute lock, can be overridden | "block gate" |
| **Override** | User bypassing a hard gate | "skip", "ignore" |
| **Pattern tag** | Post-hoc label on a trade | "flag", "annotation" |
| **Aggregate** | Per-user-per-pattern rolling stat | "summary", "stat" |
| **R-multiple** | Trade outcome in R units, 1 decimal | "R", "R:R" |
| **Strategy** | User-defined trading playbook entry | "system", "setup" |
| **Streak** | Gamified daily/weekly chain | "run", "stride" |
| **Module N** | Always referenced as `Module N` with the capital M | "module n", "M-N" in prose |

The **8 V1 patterns** (canonical names, case-sensitive):
Revenge Spiral, Stop Removal (Pro), Hold-Time Asymmetry, Averaging Into Pain (Pro), Sizing Discipline (Pro), Off-Playbook Entry, Closing-Bell / Cycle-End Risk (Pro), Theta Gambler (Pro).

---

## Module ownership (cross-module refactor rules)

Each capability has exactly one owning module. When refactoring, **do not duplicate** ownership — link to the owner.

| Capability | Owner |
|---|---|
| Onboarding, auth | Module 1 |
| Trade create | Module 2 |
| Trade read/edit/delete | Module 3 |
| Journal listing | Module 4 |
| CSV import + enrichment | Module 5 |
| Pattern detection engine | Module 6 |
| Pre-trade gates (UX) | Module 7 |
| Today tab | Module 8 |
| Patterns tab | Module 9 |
| Strategies tab | Module 10 |
| Streak / XP / badges | Module 11 |
| Non-AI insights | Module 12 |
| AI surfaces | Module 13 |
| Notifications + email | Module 14 |
| Profile / subscription / settings | Module 15 |
| **Tier enforcement (the API + 4 paywall surfaces)** | Module 16 |
| Offline / error / edge cases | Module 17 |
| Performance analytics | Module 18 |
| Behavioral Mirror | Module 19 |
| Weekly Review Ritual | Module 20 |
| Education / Pattern Library / Glossary | Module 21 |

**Rule:** When a module references another module's capability, format as "(Module N)" or "per Module N §X.Y" — never inline-redefine it.

---

## How to refactor a module

1. **Read the target module fully** before editing. Modules are long but tightly self-consistent.
2. **Preserve the canonical section order** — see `modules/CLAUDE.md` for the section template.
3. **Preserve user-story phrasing** exactly: `#### As a [persona], I want [capability], so that [reason].`
4. **Preserve acceptance-criteria phrasing** exactly: `- Given [precondition], when [action], then [outcome].`
5. **Edit in place** — do not rename headings, renumber sections, or reorder unless explicitly asked.
6. **When the change touches another module's territory**, do not edit that module — list the downstream impact at the end of your response under a "Cross-module impact" heading.
7. **When the change touches the database schema**, flag it. Do not silently change field names; the schema doc is authoritative.

---

## Style conventions

- Headings: ATX style (`#`, `##`, etc.). One H1 per file (the module title).
- Tables: GitHub-flavored Markdown with leading/trailing pipes.
- Code identifiers: backticked (`user_pattern_aggregates`, `evaluate_gate`).
- Emphasis: **bold** for module-internal terms on first use, *italic* for metric names.
- Module references: `Module 6`, `Module 16 §6.1`, never "the patterns module" or "M16".
- Em-dashes (—) for parentheticals — do not replace with hyphens.
- Indian locale conventions: `₹1,23,456` lakhs format in examples; ISO timestamps in spec.

---

## What to ask before editing

If a request is ambiguous on any of the following, ask once and proceed:
- Which module(s) the change applies to.
- Whether the change affects the database schema (Module 16 / schema doc).
- Whether tier behavior changes (Free vs Pro).
- Whether a new user story / acceptance criterion should be added, or an existing one rewritten.

If the request is unambiguous, proceed without asking. Do not over-clarify.

---

## Compound notes (grow this section over time)

Add a line every time a refactor goes wrong, so the mistake doesn't repeat.

- _(seed)_ When a user says "tighten X section," they mean preserve every requirement and reduce wordiness, NOT remove requirements.
- _(seed)_ Pro-only patterns must always be marked with "(Pro)" suffix on first mention in a section.
- _(seed)_ "Pro upsell surfaces appear in 4 specific places only" (V1 doc §12). Do not add upsell language to other surfaces.