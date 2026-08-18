# Module 00 — Foundation

Cross-cutting concerns shared by every module. Module specs reference this document rather than repeating it. Where a module deviates, it says so explicitly.

**Status:** v1 scope. Broker integration vendor is deliberately unspecified — see §10.

---

## 1. Stack and deployment

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router), PWA | Installable, offline shell, no native app at v1 |
| Hosting | Vercel | Edge for static, Node runtime for API routes |
| Database | Postgres 15+ via Supabase | RLS enabled on every table without exception |
| Auth | Supabase Auth | Email + OAuth (Google). No password auth for trading credentials — see §4 |
| Background jobs | Vercel Cron + queue | See §1.2 |
| Object storage | Supabase Storage | Screenshots attached to Note fields only |
| Secrets | Vercel env + external KMS | Credential encryption keys never live in Supabase |

### 1.1 Free tier constraints — must be resolved before first real user

| Constraint | Impact | Resolution |
|---|---|---|
| Project pauses after ~7 days inactivity | Scheduled sync stops. Breaks "every trade is recorded whether or not you log it." | Paid tier before any external user |
| No point-in-time recovery | A bad migration is unrecoverable | Paid tier; nightly logical backup to separate storage in the interim |
| 500 MB database | ~2–5k users of trade data depending on fill volume | Monitor; partition `fills` first (§8) |
| Connection limits | Serverless functions exhaust direct connections quickly | Use the pooler (transaction mode) for all API routes |

**Free tier is a development-only posture.** Treat every one of the above as a launch blocker.

### 1.2 Background execution

Three job classes with different guarantees:

| Class | Examples | Guarantee |
|---|---|---|
| **Scheduled** | Daily broker sync, auto-confirm sweep, weekly review generation | At-least-once, idempotent, must tolerate re-run |
| **Triggered** | On-demand sync when a screen opens | Best-effort, user-visible failure |
| **Deferred** | Analytics recomputation, shadow analytic runs | May lag; never blocks a user action |

**Every job must be idempotent.** Vercel Cron does not guarantee exactly-once. Use a job ledger keyed on `(job_name, scope_id, period)` with a unique constraint, and no-op on conflict.

---

## 2. Conventions

### 2.1 Identifiers

- All primary keys are UUID v7 (time-ordered, index-friendly).
- External identifiers from brokers are stored as `provider_ref` text, never used as a primary key.
- Analytic ids, operand ids and field ids are **stable strings**, never renamed, never reused (see the analytics registry).

### 2.2 Time

- **All timestamps stored as `timestamptz`, always UTC.**
- Every trade-bearing row also carries `server_day` (a `date`), computed at write time from the account's configured rollover. This is what daily rules and the streak group on. Never derive it at read time — the rollover can change and history must not shift.
- Rollover per account: forex defaults to the broker server day (typically 17:00 New York); crypto defaults to 00:00 UTC; mixed accounts follow forex.

### 2.3 Money and quantities

- Prices and monetary values: `numeric(20,8)`. **Never floating point.**
- R-multiples: `numeric(10,4)`.
- Percentages stored as decimals (`0.014` = 1.4%), formatted at the presentation layer only.
- Every monetary column carries an adjacent `currency` column. Accounts may differ.

### 2.4 Immutability

Three record types are **append-only and never updated after their freeze point**:

| Record | Freeze point |
|---|---|
| `fills` | On write. Broker facts are never edited. |
| `rule_evaluations` | Trade close-out confirmation |
| `findings` (materialised) | Snapshot per computation run |

Corrections are new rows with a supersedes pointer, never in-place edits.

### 2.5 Versioning

Strategies and rules version rather than mutate. Pattern is identical for both:

```
<entity>            -- stable id, current_version_id
<entity>_version    -- immutable body, version_no, created_at
```

Trades hold a pointer to the **version live at entry**. This is load-bearing for adherence honesty.

---

## 3. Multi-tenancy and authorisation

### 3.1 Row Level Security

**Every table has RLS enabled and a policy. No exceptions, including join tables and lookup tables that appear user-agnostic.**

Standard policy shape:

```sql
alter table <t> enable row level security;

create policy <t>_owner on <t>
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Tables reachable only via a parent carry a denormalised `user_id` rather than relying on a join in the policy — join-based policies are a common source of both leaks and slow queries.

### 3.2 Service role

The service role bypasses RLS. It is used only by background jobs and never exposed to the client. Any code path holding the service key must:

- Take an explicit `user_id` parameter and filter on it
- Never accept a `user_id` derived from a request body
- Be listed in a reviewed inventory of service-role call sites

### 3.3 Plan entitlement

Entitlement is checked **server-side on every request**, never inferred from client state. A single `entitlements` service answers `can(user, capability)` where capabilities are named strings (`rules.unlimited`, `strategy.create`, `analytics.judgment`). Analytics have an additional per-analytic plan gate (§5 of the analytics registry).

---

## 4. Security

### 4.1 Broker credentials — the highest-risk asset in the system

**Principles, in priority order:**

1. **Prefer not to hold credentials at all.** If the integration vendor brokers the connection and returns a token scoped to read-only account data, store the token and nothing else.
2. **Investor password only.** MT4/MT5 investor credentials are read-only and cannot place, modify or close orders. **Verify this at connect time** by attempting a benign trade operation and rejecting the credential if it succeeds. A master password must never be accepted, and the UI must say why.
3. **Crypto: read-only API keys with withdrawal disabled.** Verify permissions at connect; reject any key with trade or withdrawal scope.

**Storage — envelope encryption:**

```
plaintext credential
  → encrypted with a per-credential data key (AES-256-GCM)
  → data key encrypted with a master key held in an external KMS
  → ciphertext + wrapped data key + IV + auth tag stored in Postgres
```

- Master key **never** resides in Supabase or in the application database.
- Decryption happens only inside the sync worker, only for the duration of a sync, never in a request path serving a user.
- Credentials are stored in a dedicated table with **no policy allowing client reads at all** — not even by the owner. The client can create and delete, never select.

**Handling rules:**

- Never logged, never included in error messages, never in traces. Add a redaction filter at the logging boundary keyed on the credential table's column names as a defence in depth.
- Never returned by any API, including to the owning user.
- Deleted immediately and irrecoverably on account disconnect.
- Rotation: the user re-enters; there is no vendor-side rotation for MT credentials.

### 4.2 Application security

| Area | Requirement |
|---|---|
| Transport | TLS only. HSTS with preload. |
| Session | Supabase JWT, short-lived access token, refresh rotation |
| CSRF | SameSite=Lax cookies; state-changing routes require the auth header, not cookie alone |
| Input | Validate every payload against a schema at the boundary (Zod). Reject unknown keys. |
| SQL | Parameterised queries only. No dynamic SQL string construction anywhere, including in the analytics engine — see §4.3 |
| Rate limiting | Per-user and per-IP on auth, sync trigger, and any AI endpoint |
| Headers | CSP without `unsafe-inline`, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin` |
| Dependencies | Automated advisory scanning; no unpinned versions in production builds |

### 4.3 The rule expression engine is an injection surface

Rules serialise to `{ operand_id, op, value }` and are evaluated against trade data. **This must never be compiled to SQL or evaluated as code.**

- `operand_id` is validated against the operand catalogue (a static data file). Unknown ids are rejected.
- `op` is validated against a fixed enum per operand type.
- `value` is type-checked and range-checked per operand.
- Evaluation is a pure function over an already-materialised trade fact object. No database access during evaluation, no string interpolation, no `eval`.

The same validator serves the manual builder and, later, the AI writer — one code path, no parallel validation.

### 4.4 Screenshot uploads

Note-type fields accept images. Requirements: content-type sniffing (not trusting the declared type), size cap, EXIF stripping on upload (screenshots can carry location), signed short-lived URLs for read, and storage paths that do not encode user identifiers guessably.

---

## 5. Privacy and data protection

### 5.1 Applicable regimes

| Regime | Applies because | Key obligations |
|---|---|---|
| **GDPR** (EU/EEA) | Serving EU users | Lawful basis, DSAR, erasure, portability, DPA with every processor, transfer mechanism, breach notification within 72h |
| **UK GDPR** | If serving UK | Substantially the same; separate transfer mechanism |
| **US state laws** (CCPA/CPRA, and successors in VA, CO, CT, UT and others) | Serving US users | Notice at collection, opt-out of sale/sharing (we do neither), deletion, access, non-discrimination |
| **DPDP Act 2023** (India) | Operating from India | Notice, consent, purpose limitation, data-principal rights, breach reporting |

**Recommendation:** host in the **EU (Frankfurt)** from day one. Region migration after launch is painful; hosting in the EU satisfies the strictest regime by default and simplifies everything else.

**Transfer note:** an India-based team accessing an EU-hosted database is an international transfer under GDPR. This needs Standard Contractual Clauses plus a transfer impact assessment. It is not optional and it is not solved by hosting location alone.

**Scope decision to confirm:** launching to India + US at v1 and adding EU at v1.1 removes four to six weeks of compliance work from the critical path. The architecture below supports EU either way.

### 5.2 Data classification

| Class | Examples | Handling |
|---|---|---|
| **Credential** | Broker investor password, exchange API key | §4.1. Encrypted, never readable, never logged |
| **Financial** | Fills, positions, P&L, account balance | Encrypted at rest, RLS, never shared, never used for cross-user analytics without aggregation |
| **Behavioural** | Rule evaluations, detections, captures | Same as financial |
| **Account** | Email, name, plan | Standard |
| **Telemetry** | Page views, feature usage, analytic renders | Pseudonymous; retained 24 months |

**No cross-user analytics at v1.** The behaviour detection engine baselines against the trader's own history only (design doc §10a). This is a privacy property as much as a statistical one and it should be stated in the privacy notice.

### 5.3 Lawful basis (GDPR)

| Processing | Basis |
|---|---|
| Account, auth, delivering the service | Contract |
| Broker sync and analytics | Contract — it is the service |
| Product telemetry | Legitimate interest, with opt-out |
| Marketing email | Consent |
| AI features (v1.1) | Contract, with a separate notice about processor involvement |

### 5.4 Data subject rights

Each must be implemented as a real, testable code path, not a manual process:

| Right | Implementation |
|---|---|
| **Access / portability** | Export job producing JSON + CSV of all user-owned rows, delivered by signed URL, within 30 days (target: minutes) |
| **Erasure** | Hard delete of all user rows; credentials destroyed immediately; telemetry pseudonyms unlinked. Cascades defined explicitly per table, never relying on ON DELETE defaults alone |
| **Rectification** | Native — the product already allows editing captures and rules. Broker facts cannot be rectified by design; document this as accuracy of a third-party record |
| **Restriction / objection** | Account-level processing pause: sync stops, analytics stop, data retained |
| **Withdraw consent** | Telemetry opt-out toggle; marketing unsubscribe |

**Erasure has a conflict with immutability (§2.4).** Resolution: immutability is a *product* invariant, not a legal one. Erasure deletes; it does not tombstone. The immutability guarantees apply to the trader's own editing surface, not to data-protection operations.

### 5.5 Retention

| Data | Retention |
|---|---|
| Trade and behavioural data | Life of account + 30 days |
| Credentials | Until disconnect, then immediate |
| Telemetry | 24 months |
| Backups | 35 days, then expiry. Deletion requests are re-applied to any restored backup |
| Audit log | 12 months |

### 5.6 Processors

Maintain a register. At v1 this is at minimum: Vercel, Supabase, the broker integration vendor, the email provider, and (v1.1) the AI provider. Each needs a DPA. The broker vendor is the highest-risk processor in the chain because it touches credentials — its terms need reading before selection, not after.

---

## 6. Error handling

### 6.1 Taxonomy

Every error carries a stable machine code, a user-facing message, and a retry disposition.

```
{ code: "SYNC_CREDENTIAL_REJECTED",
  category: "integration",
  retryable: false,
  user_message: "Your broker rejected these credentials.",
  detail: <never contains the credential> }
```

| Category | Codes | User-facing behaviour |
|---|---|---|
| `validation` | Bad input, schema failure | Inline field error, no toast |
| `entitlement` | Plan limit reached | Explain the limit, offer the upgrade path with the specific number |
| `integration` | Broker unreachable, credential rejected, partial data | Named, actionable, never generic |
| `conflict` | Version mismatch, concurrent edit | Show what changed, offer merge or discard |
| `internal` | Unexpected | Generic message + incident id. Never leak internals |

### 6.2 The silence principle

**When an analytic cannot compute, it renders nothing or renders `find.insufficient` — never a degraded version of itself and never an error.** A trader seeing "unable to calculate win rate" learns the product is unreliable. A trader seeing "not enough data yet — 8 more trades" learns the product is honest. This is a product requirement, not a nicety.

Fail-closed applies identically to the kill-switch config (analytics registry §5): if config cannot be read, the analytic does not run.

### 6.3 Partial sync

The most common real failure. A sync returning some of a day's fills must never be treated as complete.

- Sync results are staged and committed atomically per account per pull.
- A pull carries a coverage window; gaps are recorded and re-requested.
- **A day is never marked closable while a coverage gap exists in it.** Better to delay the streak than to score an incomplete day.

### 6.4 Idempotency

- Fills deduplicate on `(account_id, provider_ref)` with a unique index. Re-importing the same history is a no-op.
- Client mutations carry an idempotency key; replays return the original result.

---

## 7. Observability

### 7.1 Required instrumentation

| Signal | Why |
|---|---|
| **Analytic render log** — id, user, surface, computed values, timestamp | Makes "was this analytic ever wrong?" answerable. Required by the registry. |
| **Sync outcome log** — account, tier, duration, fills returned, gaps, error code | The integration is the largest unknown; this is how it becomes known |
| **Grouping decisions** — block id, signals fired, confidence band, user override | Feeds the split-propensity learning and validates the algorithm |
| **Prompt log** — which review prompts shown, accepted, declined, deferred | The anti-nagging mechanics are only tunable if this exists |
| **Entitlement denials** | Shows where the free tier actually bites |

### 7.2 Audit log

Append-only, for security-relevant events: credential added/removed, plan change, export requested, deletion requested, service-role access to user data.

### 7.3 Alerting

| Condition | Severity |
|---|---|
| Sync failure rate > 5% over 15 min | Page |
| Any credential decryption failure | Page |
| Scheduled job missed | Page |
| Analytic error rate > 1% for any id | Investigate, consider kill switch |
| Shadow analytic diverging from expectation | Investigate |

---

## 8. Performance and scalability

### 8.1 Budgets

| Surface | Budget | Note |
|---|---|---|
| Pre-entry capture screen — interactive | **< 1.5 s** on 4G | Hard requirement. The 10-second capture budget assumes near-instant load |
| Ambient strip data | < 800 ms, stale-while-revalidate | Show cached values immediately, refresh in place |
| Dashboard state resolution | < 500 ms | Single query, precomputed |
| Close-out screen | < 1 s | |
| Weekly review | < 2 s | Precomputed on a schedule, not on demand |
| Rule preview | < 300 ms | Runs over the user's own history; see 8.3 |

### 8.2 Data volumes

Per active trader per year, order of magnitude: 500–5,000 fills, 200–2,000 trades, 2,000–20,000 rule evaluations. Rule evaluations are the largest table and grow as `trades × active_rules`.

Consequences:
- `fills` and `rule_evaluations` partition by month on `server_day` when either exceeds ~10M rows.
- Adherence aggregates are **materialised weekly**, never computed from raw evaluations at read time.
- Findings are materialised per computation run, not recomputed on view.

### 8.3 Rule preview

Preview evaluates a candidate rule against up to the last N trades interactively as a slider moves. Requirements: operate over a **precomputed per-user operand distribution** rather than scanning trades on each keystroke; cap the history window (last 200 trades or 12 months); debounce; compute client-side where the operand distribution is already loaded.

### 8.4 Connection management

Serverless plus Postgres is a known hazard. Use the Supabase transaction-mode pooler for all API routes. Background jobs may hold direct connections but must cap concurrency explicitly.

---

## 9. Testing and quality

### 9.1 Test layers

| Layer | Scope | Bar |
|---|---|---|
| Unit | Pure logic — grouping, rule evaluation, statistical gates, R computation | **90% line coverage on the engines**, 70% overall |
| Property-based | Grouping and rule evaluation invariants (§9.2) | Required for both engines |
| Integration | API routes against a real Postgres with RLS on | Every route, including the denial paths |
| RLS | Every table asserted unreadable cross-user | **100% of tables**, automated, no exceptions |
| E2E | Onboarding, capture→fill→close-out, rule creation, weekly review | Happy path plus one failure per flow |
| Fixture replay | Golden broker histories through the full pipeline | See §9.3 |

### 9.2 Invariants worth property-testing

These are the ones where a subtle bug is silent and corrupting:

- **Grouping:** every fill belongs to exactly one trade; no trade spans a flat point; regrouping is impossible after freeze; grouping is deterministic for identical input.
- **Evaluation:** an evaluation, once frozen, never changes value; a rule created at T never produces evaluations for trades entered before T; adherence denominators only count applicable rules.
- **Money:** sum of fill P&L equals trade P&L; no currency mixing in any aggregate.
- **Statistics:** a finding never surfaces below its sample gate; the `spec.weekday` canary fires at approximately the false-positive rate implied by the correction.

### 9.3 Golden fixtures

A library of anonymised broker histories, each with an expected output, replayed on every build:

| Fixture | Exercises |
|---|---|
| Simple day trades | Baseline |
| Scaled entry, scaled exit | Position rollup, `scale_out_count` |
| Swing position with intraday round trips inside it | The resting-baseline split signal |
| Flip long to short with no flat gap | Block boundary |
| Partial fills, sub-second | Dedup, ordering |
| Overnight and weekend spanning | `server_day` assignment |
| Multi-currency accounts | Currency handling |
| Corrupted / gapped history | Partial sync handling |

**These fixtures are the single most valuable quality asset in the project.** Build them before the grouping engine, not after.

### 9.4 Quality benchmarks

| Metric | Target |
|---|---|
| Grouping accuracy vs human judgment on the fixture set | **≥ 95%** correct without asking |
| Ambiguous-band rate | **< 5%** of trades trigger a question |
| Sync success rate | ≥ 99% of scheduled pulls |
| Analytic correctness | Zero live analytics found misleading in cohort review |
| p95 API latency | < 400 ms |
| Error budget | 99.5% monthly availability |
| Accessibility | WCAG 2.2 AA on all v1 surfaces |

---

## 10. External dependencies

| Dependency | Purpose | Risk | Mitigation |
|---|---|---|---|
| **Broker integration vendor** | MT4/MT5 account data | **Highest.** Per-account pricing, credential custody, availability, and it determines which analytics exist at all | Vendor-agnostic adapter interface (§10.1). Do not let vendor types leak past the adapter |
| Crypto exchange APIs | Direct REST, read-only keys | Per-exchange rate limits and schema drift | One adapter per exchange behind the same interface |
| Supabase | DB, auth, storage | Free-tier limits (§1.1); vendor lock via RLS and auth | Keep business logic out of database functions where practical |
| Vercel | Hosting, cron | Cron granularity and execution limits on lower plans | Queue for anything long-running |
| Economic calendar | Prefill "news nearby" | Data quality, licensing | Optional field; degrade to unset |
| Email provider | Transactional | Low | — |
| AI provider (v1.1) | Chat, narration | Cost, latency, output validity | Metered; validated output only (design doc §12) |

### 10.1 The integration adapter — deliberately unspecified

The vendor is undecided. The **interface is not.** Every module downstream depends on this shape and nothing else:

```
interface BrokerAdapter {
  connect(credential): AccountHandle        // verifies read-only, rejects master credentials
  fetchHistory(handle, since): Fill[]       // T0
  fetchOpenPositions(handle): Position[]    // T0/T1
  snapshotPositions(handle): PositionSnap[] // T1 — enables stop-movement analytics
  capabilities(handle): TierFlags           // declares T0 / T1 / T2 support
}
```

Two consequences to hold:

- **`capabilities()` drives the analytics registry at runtime.** An account whose adapter reports T0-only must not be offered rules over T1 operands, and T1 analytics must be hidden rather than silently never firing.
- **Vendor selection is an open item that gates six analytics, the entire prop-firm surface (v1.1), and the onboarding copy.** Until it lands, build against the interface and the fixture library.

---

## 11. Module map and relationships

```
                    ┌────────────────────────┐
                    │ 01 Identity & Accounts │
                    └───────────┬────────────┘
                                │ accounts, entitlements
                    ┌───────────▼────────────┐
                    │ 02 Trade Ingestion     │◄── BrokerAdapter (§10.1)
                    │    & Model             │
                    └───────────┬────────────┘
                                │ trades, fills, events
              ┌─────────────────┼─────────────────┐
              │                 │                 │
    ┌─────────▼────────┐ ┌──────▼──────────┐ ┌───▼──────────────┐
    │ 03 Field Registry│ │ 04 Rulebook &   │ │ 05 Analytics &   │
    │    & Strategy    │►│    Evaluation   │ │    Findings      │
    └─────────┬────────┘ └──────┬──────────┘ └───┬──────────────┘
              │                 │                 │
              └─────────────────┼─────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │ 06 Review & Graduation │
                    └───────────┬────────────┘
                                │
              ┌─────────────────┴─────────────────┐
    ┌─────────▼────────┐              ┌───────────▼──────────┐
    │ 07 Engagement    │              │ 08 Onboarding        │
    └──────────────────┘              └──────────────────────┘

    Deferred: 09 Prop Firm Rulebooks (v1.1) · 10 AI Layer (v1.1)
```

**Dependency rules:**

- 03 supplies the field registry that 04 writes rules against. A rule can only reference a field that exists — this is enforced in 04 by validating against 03's registry.
- 04 and 05 both read from 02 and **never read from each other**. The edge engine ignores rules; the adherence engine ignores P&L. This separation is load-bearing (design doc §9).
- 06 orchestrates and owns the prompt cap. It is the only module permitted to surface a consequential prompt.
- 07 observes events emitted by 02 and 06; it never gates them.
- 09 extends 04 with a locked, account-scoped rulebook. Designing 04's scope model to accommodate it is a v1 requirement even though 09 ships at v1.1.

---

## 12. Documentation requirements

Each module spec ships with:

- API reference generated from the route schemas (single source of truth: the Zod schemas)
- Migration files, forward-only, reviewed
- An ADR for any decision that deviates from this foundation document
- Runbook entries for its alerting conditions

Project-level, maintained alongside:

- `decision-os-design-decisions.md` — the product decisions these specs implement
- `analytics-registry.md` — the runtime catalogue of what the product may say
- This foundation document
- The eight module specs
- Developer brief, marketing brief, and whole-app flow diagram

**Convention:** when a spec and the design document disagree, the design document is the intent and the spec is wrong until reconciled. When a spec and the code disagree, fix one deliberately — do not let drift accumulate silently.
