# modules/CLAUDE.md — Module Authoring Conventions

This file is loaded automatically by Claude Code when working inside `/modules/`. It defines the **canonical module template** all 21 module docs follow.

For product-level context (terminology, tier model, fixed personas), see the root `CLAUDE.md`.

---

## Canonical section order

Every module follows this section order. Do not reorder, renumber, or rename headings during refactor.

```
# Module N — <Module Name>

## 1. Module Summary
   <One dense paragraph: what it does, what it reads, what it writes,
   what success looks like (metric names italicized), how it relates to other modules.>

## 2. User Stories
### 2.1 <Capability bucket>
   #### As a <persona>, I want <capability>, so that <reason>.
   #### As a <persona>, I want <capability>, so that <reason>.
### 2.2 <Next bucket>
   ...
### 2.N Edge Cases
### 2.N+1 Tier Variations
### 2.N+2 Mobile vs. Desktop          (if applicable)
### 2.N+3 Cross-Module Interactions   (if applicable)

## 3. Acceptance Criteria
### 3.1 <First criteria bucket — typically matches a 2.X user story bucket>
   - Given <precondition>, when <action>, then <outcome>.
   - Given ..., when ..., then ...
### 3.2 ...

## 4. Data Model         (if the module owns or extends tables)
### 4.1 Tables Owned
### 4.2 Tables Read
### 4.3 Tables Written
### 4.4 New Fields / Columns        (if extending an existing table)

## 5. APIs & Contracts   (if the module exposes APIs)
### 5.1 <Endpoint or function signature>

## 6. Interaction & UX Requirements   (if the module has UI)
### 6.1 ...

## 7. Notifications, Emails & Side Effects
### 7.1 Push / Email
### 7.2 XP
### 7.3 Analytics Events
### 7.4 Other Side Effects

## 8. Open Questions (OQ)

## 9. Out of Scope (V1)

## 10. Definition of Done
```

Some modules omit sections that don't apply (e.g., Module 6 is backend-only and has no §6 UX). That's fine — **do not add empty sections** to "complete" the template.

---

## User-story format (load-bearing)

**Exact phrasing:**
```
#### As a <persona>, I want <capability>, so that <reason>.
```

Rules:
- Heading level is always `####` (H4).
- Persona must be one of the canonical set (see root `CLAUDE.md`).
- Sentence must be one line, end with a period.
- "I want" and "so that" are mandatory — no variants ("I'd like", "in order to", etc.).
- No second sentences inside the story. If you need more, put it as a paragraph after.

---

## Acceptance-criteria format (load-bearing)

**Exact phrasing:**
```
- Given <precondition>, when <action>, then <outcome>.
```

Rules:
- Bullet items, not numbered.
- "Given… when… then…" all lowercase keywords.
- One criterion per bullet — no compound criteria joined with "and".
- Implementation-specific values (timeouts, table names, byte limits) belong here, not in §2.

---

## When refactoring user stories

- Adding a story: place it in the most relevant existing 2.X bucket. Only create a new bucket if no fit exists.
- Removing a story: confirm it isn't referenced by any acceptance criterion (search §3) before deleting.
- Rewriting a story: preserve the persona unless the user explicitly changes it.

## When refactoring acceptance criteria

- Each AC bucket (3.X) usually maps 1:1 to a user-story bucket (2.X). Preserve this alignment.
- Numeric thresholds (timeouts, counts) are precise — do not round or paraphrase.

---

## Cross-module references

When a module needs another module's capability, format references like:
- `(Module 6)` — generic
- `per Module 16 §6.1` — specific
- `owned by Module 15` — for ownership clarity

Never:
- Re-define the other module's data structures inline.
- Re-state acceptance criteria that belong to the other module.
- Use lowercase / abbreviated module names ("the patterns module", "M16").

---

## Tables, fields, identifiers

- Table names: `snake_case`, backticked (`user_pattern_aggregates`).
- Field names: `snake_case`, backticked.
- Pattern names in prose: title-case ("Revenge Spiral"), not backticked.
- Pattern slugs in identifiers: `snake_case`, backticked (`revenge_spiral`).
- API function names: `snake_case()`, backticked (`evaluate_gate()`).

---

## "Tier Variations" subsection — required check

Every module that has any tier-conditional behavior must have a §2.N "Tier Variations" subsection listing Free vs Pro differences as user stories. When refactoring, if you add a tier-conditional behavior elsewhere in the module, also add the matching story here.