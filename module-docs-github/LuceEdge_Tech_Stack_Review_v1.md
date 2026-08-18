# LuceEdge V1 — Best-in-Class Tech Stack Review

*Prepared: May 2026 | Confirmed providers: Vercel + Supabase + Amazon SES | Architecture: PWA, serverless-first*

---

## 1. Verdict up front

**Yes, go serverless — but not "all Vercel Functions."** A pure-Vercel-Functions backend will hit four specific walls baked into your modules:

1. **Background pattern detection** on CSV imports (up to 5 min per Module 5 §6.4) — won't fit Vercel's 60s Hobby / 300s Pro function ceiling cleanly.
2. **Scheduled batch jobs** for AI surfaces (Sunday 11pm UTC weekly, 1st-of-month monthly per Module 13 §4.10) and nightly aggregate recomputes (Module 6 §4.9, 3am user TZ) — Vercel Cron exists but is brittle for fan-out across thousands of users.
3. **Cold-start sensitivity** on pattern detection's <100ms p95 budget (Module 6 §6.2) — first-hit Vercel Functions in India can spike to 1–2s on cold paths.
4. **Pre-trade gate evaluation** which is read-heavy and latency-critical — best served from Supabase's connection-pooled Postgres + Redis, not a fresh cold lambda each time.

### The recommended shape

A **two-tier serverless architecture**, both providers chosen for "scales to zero":

- **Tier 1: Vercel (Next.js full-stack)** — owns the UI, all interactive API routes (trade save, read paths, gate evaluation, AI scorecard on-demand), auth handoff to Supabase, and the public `/learn/*` SSG pages with ISR.
- **Tier 2: Supabase Edge Functions + pg_cron + pg_net** — owns scheduled jobs (AI batch, aggregate recompute, cohort percentiles), CSV-import workers, webhook handlers (Cashfree), and anything that needs to run >10s or on a schedule.

This keeps your developer's "Next.js serverless" instinct correct while solving the four walls above without adding a third service.

**Total V1 monthly run cost at ~1,000 MAU:** ₹500–1,500 (mostly Anthropic API), unchanged from the previous plan.

---

## 2. Why "all Vercel serverless" is *almost* right but not quite

Your developer's instinct is sound: Next.js App Router with Route Handlers (the modern term for "API routes") on Vercel Fluid Compute is the right default for V1. Specifically:

- **Fluid Compute** (Vercel's 2025 evolution of Functions) gives you up to 60s on Hobby and 300s on Pro, with multi-invocation pooling that drastically reduces cold-start cost on I/O-bound work (Claude API calls, Supabase queries). This solves ~80% of your backend needs.
- **No separate FastAPI service.** Your developer's instinct to not run a Python container is correct for V1 — you don't need it. The earlier plan's Railway/FastAPI was load-bearing for pattern detection logic, but TypeScript + the `postgres.js` driver against Supabase handles the same workload at lower latency and zero ops overhead. Pattern detectors are just SQL queries; the host language is incidental.

But four module-specific requirements break the pure model:

### Wall 1: CSV import workers (Module 5)
Module 5 §6.4 says "Pattern detection background job: <5min for ≤1,000 trades." A 1,000-trade import means batched insert + 1,000 detector runs + aggregate recompute. Even on Fluid Compute's 300s Pro ceiling, this is too close to the edge. And on Hobby (60s), it simply doesn't fit.

**Solution:** Push the post-import work into a Supabase Edge Function triggered by a database row insert into `import_jobs` (Module 5 §5.3). Edge Functions on Supabase run on Deno, have a 400s wall-clock limit on the free tier, 150s on a cold start, and have direct, intra-region access to your Postgres. The user gets their "Imported X trades" success state instantly from Vercel; the heavy lifting runs out-of-band.

### Wall 2: Scheduled batch jobs (Modules 6, 12, 13, 18)
You have several recurring jobs that must run reliably:

| Job | Cadence | Source module |
|---|---|---|
| AI weekly summary regen for all Pro users | Sunday 11pm UTC | Module 13 §4.10 |
| AI monthly report regen for all Pro users | 1st of month 1am UTC | Module 13 §4.10 |
| Nightly pattern aggregate recompute (per-user) | 3am user TZ | Module 6 §4.9 |
| Subscription grace-period sweeper | Daily 4am UTC | Module 17 §4.6 |
| Population cohort percentile recompute | Daily 2am IST | Module 12 §5.3 |
| Strategy aggregate batch | Nightly | Module 10 §4.2 |

Vercel Cron is fine for kicking off one HTTP endpoint daily. It's *brittle* for fan-out across N users — if your cron handler tries to loop over 5,000 Pro users and regenerate AI for each, it'll timeout. You'd end up writing a queue-and-resume pattern in user code.

**Solution:** Use **`pg_cron`** inside Supabase (already available on the free tier) to drive these. The cron job INSERTs job rows into an `ai_generation_jobs` table (Module 13 §5.3 already specs this); a Supabase Edge Function picks them up in batches of 50, generates AI per user, marks complete. This pattern is purpose-built for fan-out and gives you natural retry semantics via the job table.

### Wall 3: Cold starts on the pre-save gate
Module 6 §6.2 specifies `evaluate_gate` <100ms p95 for Pro users. On Vercel Functions in India (no Mumbai region — closest is Singapore), cold starts can be 500–1500ms even with Fluid Compute warming.

**Solution:** Make the gate evaluator a **Postgres function** (`evaluate_gate_for_trade(trade_payload jsonb, user_id uuid)`) called from the Vercel Route Handler. The Vercel function becomes a thin pass-through: validate input → call `rpc('evaluate_gate_for_trade', ...)` via supabase-js → return result. Postgres-side evaluation is single-digit milliseconds; even with the round trip from Singapore-Vercel to Mumbai-Supabase, you'll comfortably hit <100ms p95 on warm and ~300ms on cold (acceptable since gates are post-form-submit, not pre-keystroke).

This also gives you **Module 6 §9.5's recommendation** ("in-process detector library") effectively for free — Postgres *is* the process.

### Wall 4: Hard-block lock state (Module 7)
Module 7's 15-minute hard-block lock per pattern needs to survive page reload and device switch. Don't put this in a Vercel function's memory; store it in **Upstash Redis** with a 15-minute TTL key per `(user_id, pattern_slug)`. Reads on every save attempt; expires automatically. Upstash's serverless Redis handles this with HTTP REST calls that work seamlessly from Vercel Functions (no connection-pool drama).

---

## 3. The finalized stack (component-by-component)

### Frontend & app shell

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | RSC for static parts (Learn pages, marketing, settings sub-pages), Server Actions for write paths, Route Handlers for everything else. Native streaming for AI scorecard sentence. |
| Language | **TypeScript strict mode** | Non-negotiable for a journal handling money. `decimal.js` for monetary math (DECIMAL(20,4) on the wire per Module 17 §3.11). |
| Styling | **Tailwind CSS + shadcn/ui (Radix primitives)** | Tailwind is the unambiguous default for utility-first speed. shadcn gives you accessible primitives (focus traps for Module 17 §3.10, ARIA live regions) without lock-in. |
| State (client) | **TanStack Query (v5)** for server state + **Zustand** for ephemeral UI state | TanStack Query for cache invalidation around the "snapshot reads" pattern (Module 1.7). Zustand for things like "the gate modal is open." Skip Redux. |
| Forms | **React Hook Form + Zod** | Zod schemas double as server-side validators (one source of truth for Module 17 §3.4 validation rules). |
| Charts | **Recharts** for equity curves (Module 18), **D3 selectively** for the calendar heatmap and Mirror viz (Module 19) | Recharts for "boring" stat charts. D3 only where Recharts can't (heatmaps, custom matrices). |
| PWA shell | **Serwist** (modern Workbox successor) | Service worker tooling with first-class Next.js 15 support. Handles offline cache, push notification registration. |
| Offline queue | **Dexie.js over IndexedDB** | Module 17's `offline_queue` schema is a perfect Dexie use case. Idempotency keys generated client-side via `crypto.randomUUID()`. |
| Animations | **Framer Motion** (now `motion`) | For the enrichment card swipe (Module 5 §6.5), modal transitions, the haptic-feel spring animations the spec calls for. |
| Date/time | **`date-fns-tz`** | Module 17 §4.4 mandates IANA timezone handling — `date-fns-tz` is the right choice over Moment (deprecated) or Day.js (weaker TZ support). |

### Backend (interactive API)

| Layer | Choice | Why |
|---|---|---|
| API style | **Next.js Route Handlers + Server Actions** | Hosted on Vercel Fluid Compute. Server Actions for trade save / edit / delete (form-tight flows). Route Handlers for `/api/learn/.../personalization` (Module 21 client overlay), AI on-demand generation, etc. |
| DB driver | **`postgres.js`** through Supabase's PgBouncer (transaction mode) | Better connection pooling than `pg` under serverless cold-start patterns. Use Supabase's connection pooler endpoint, not the direct DB URL. |
| ORM | **Drizzle ORM** | Lightweight, SQL-first, plays well with Supabase RLS. Avoid Prisma — its query engine binary is heavyweight in serverless cold starts. |
| Validation | **Zod** (shared with client) | Same schemas. Module 17 §3.12 idempotency-key headers validated here too. |
| Auth | **Supabase Auth (SSR helper)** | The `@supabase/ssr` package for cookie-based sessions in Next.js. Google OAuth + email/password (Module 1 §2.1) both first-class. |
| Authorization | **Postgres Row-Level Security** | Module 16's capability map is enforced *in the database*, not at the route layer. Tier checks become `auth.jwt() -> 'tier' = 'pro'` predicates on RLS policies. This is the single most important architecture decision for security. |
| Idempotency | **Redis-backed cache** (Upstash) with 24h TTL | Module 17 §3.12. `Idempotency-Key` header → check Redis → cached response or proceed. Use Vercel middleware for transparent enforcement. |
| Rate limiting | **`@upstash/ratelimit`** | Module 17 §3.13's rate-limit table maps cleanly to Upstash's sliding-window rate limiter. ~10 lines of middleware. |

### Background workers & schedulers

| Need | Choice | Why |
|---|---|---|
| Scheduled jobs (cron) | **`pg_cron` in Supabase** | Already enabled on Supabase free; no extra service. Cron syntax familiar to your developer. |
| Workers | **Supabase Edge Functions (Deno)** | Run alongside Postgres in same region. 400s wall-clock; HTTP-triggered (by `pg_net` from `pg_cron` or by row-insert webhooks). |
| Job queue | **Postgres tables + `FOR UPDATE SKIP LOCKED`** | The "boring" job-queue pattern. `ai_generation_jobs`, `import_jobs` (Modules 5, 13) become natural queues. No need for SQS, Redis Streams, or BullMQ in V1. |
| Pattern detection trigger on import | **Postgres trigger → `pg_net` POST → Edge Function** | When `import_jobs.status` flips to 'committed', a trigger fires the worker. |
| Pre-save gate evaluation | **Postgres function (PL/pgSQL or SQL)** | Per "Wall 3" above. Stays in-database. Called via `supabase.rpc()`. |

### Data layer

| Component | Choice | Why |
|---|---|---|
| Primary DB | **Supabase Postgres 16+** | All the trade data, aggregates, AI cache. RLS-enforced. PITR enabled (Module 17 §3.11). |
| Monetary types | **`numeric(20,4)`** (Postgres equivalent of DECIMAL(20,4)) | Module 17 §3.11 mandate. Never `float`. |
| Cache | **Upstash Redis** | Pattern aggregate hot cache (Module 6 §4.4, 5-min freshness), idempotency keys, rate-limit counters, hard-block lock state (Module 7). |
| File storage | **Supabase Storage** | CSV uploads (Module 5), shareable scorecard PNGs (Module 13 §2.5). The 1 GB free tier limit is plenty until ~2,000 active users. |
| Search/full-text | **Postgres `tsvector` (built-in)** | Module 4's journal search is over user-owned text fields — Postgres full-text search is more than enough. Skip Algolia/Meilisearch entirely for V1. |
| Vector / pgvector | **Not in V1** | The pgvector extension is available on Supabase if you ever need it (V2 AI coach), but Module 6 detection is pure rule-based per §8 — no vectors needed. |
| Time-series | **Same Postgres** | Aggregates are pre-computed snapshots (Module 1.7); you don't need TimescaleDB or InfluxDB for V1's volumes. Re-evaluate at ~50k MAU. |

### External services

| Need | Choice | Why |
|---|---|---|
| AI | **Anthropic API direct (Claude Haiku 4.5 for short surfaces, Sonnet 4.6 for long)** | Module 13 §9.1's split is correct. Stream the scorecard sentence response from Vercel to the browser (per Module 13 §6.3, <3s target — streaming makes the perceived latency much better). |
| Email transactional | **Amazon SES** | Confirmed. Use **React Email** for templates — same component model as your app, renders to HTML at send time. SES handles delivery; React Email handles authoring. |
| Push notifications | **Firebase Cloud Messaging (FCM)** | Module 14. Free forever; standard PWA push pipeline. |
| Payments | **Cashfree** | India. Module 15 integration. Webhooks via a dedicated Route Handler at `/api/webhooks/cashfree` with idempotency check on `webhook_id`. |
| Error tracking | **Sentry (Developer free tier)** | Module 17 §3.15. Use `@sentry/nextjs` — wraps both client and server. Source-map upload via Vercel build hook. |
| Product analytics | **PostHog (self-hosted on free Cloud tier, EU region)** | Module 17 §7.2's 30+ analytics events demand a real product analytics tool. PostHog free tier (1M events/mo) handles V1 easily; supports session replay, feature flags, and funnels in one product. |
| Logs (server) | **Vercel logs (Hobby/Pro) + Supabase logs + Sentry breadcrumbs** | No need for a separate Datadog/Logtail in V1. Promote to a real log aggregator at ~10k MAU. |

### DevEx & shipping

| Need | Choice | Why |
|---|---|---|
| CI/CD | **Vercel native (Git-based)** | Push to `main` deploys prod; PRs deploy previews. |
| Migrations | **Supabase CLI + SQL migration files in `/supabase/migrations`** | Version-controlled DB schema. `supabase db push` on staging; `supabase migration up` on prod via CI. |
| Type-safe DB | **Generate types via `supabase gen types`** | Auto-generated TypeScript from your Postgres schema. Run in CI; commit on schema changes. |
| Testing | **Vitest** for unit, **Playwright** for E2E, **Testing Library** for components | Vitest is dramatically faster than Jest for monorepo dev loops; Playwright is the unambiguous E2E choice in 2026. |
| Linting / format | **Biome** (replaces ESLint + Prettier) | Single tool, ~10x faster than ESLint+Prettier. Mature enough for V1 in 2026. |
| Pre-commit | **Husky + lint-staged + Biome** | Standard. |
| Env management | **Vercel env vars + `.env.local`** | Separate dev/preview/prod. Never commit secrets. |
| Feature flags | **PostHog feature flags** | Already chosen for analytics; flags come free. Useful for soft-launching paywall surfaces (Module 16). |

---

## 4. The request lifecycle (worked example: "user saves a trade")

This shows how the pieces fit together for the most common write path in the app.

```
1. User taps "Save" in Module 2 Quick Log form (Pro user)
     │
     ▼
2. Browser: Server Action invocation
   - React Hook Form + Zod validates client-side
   - Idempotency-Key header generated via crypto.randomUUID()
   - If offline: Dexie queues to IndexedDB, shows optimistic UI, returns
     │
     ▼
3. Vercel (Fluid Compute, Singapore edge): Server Action handler
   - Re-validates with same Zod schema (server-side)
   - Middleware checks Idempotency-Key against Upstash Redis (24h TTL)
     - If hit: return cached response
     - If miss: proceed
   - Rate-limit check via @upstash/ratelimit (60/min per user)
     │
     ▼
4. Supabase Postgres (Mumbai):
   - RPC call: supabase.rpc('evaluate_gate_for_trade', { payload })
   - PL/pgSQL function reads pattern_definitions, user thresholds, recent trades
   - Returns { gate: 'hard'|'soft'|'none', pattern_name, personalized_stat }
   - p95 latency: <80ms warm, <300ms cold
     │
     ▼
5. Vercel handler:
   - If gate = 'hard': return 423 with lock details → client renders Module 7 modal
   - If gate = 'soft' and user hasn't paused 30s: return 202 → client shows nudge
   - If gate = 'none' or override: proceed to save
     │
     ▼
6. Supabase Postgres:
   - INSERT into trades with NUMERIC(20,4) for prices
   - RLS policy auto-enforced: user_id = auth.uid()
   - Trigger fires: schedule_post_save_work(trade_id)
     - INSERTs into post_save_jobs queue table
     - pg_net.http_post() to Edge Function (fire-and-forget)
     │
     ▼
7. Vercel handler:
   - Cache response in Redis under Idempotency-Key
   - Return 200 with saved trade ID and computed P&L
     │
     ▼
8. Supabase Edge Function (async, doesn't block user):
   - Pulls post_save_job
   - Runs post-hoc pattern tagging (writes trade_pattern_tags)
   - Updates user_pattern_aggregates
   - If Revenge Spiral cleared/fired: updates user_streak_state
   - Marks job complete
     │
     ▼
9. Client (background):
   - Next.js revalidates Today tab via Server Action's revalidatePath()
   - Pattern toast appears (Module 2 §9.14)
```

Notice: **no FastAPI, no Railway, no separate microservice.** The whole flow is Vercel ↔ Supabase, with Upstash for the two things Postgres isn't good at (rate limits and short-TTL locks). Your developer's instinct holds — it's just that "serverless" means "Vercel functions + Supabase functions," not "Vercel functions alone."

---

## 5. What this stack is consciously NOT doing

These are deliberate non-choices, each with the trigger that would change the answer.

| Not chosen | Reason | Trigger to revisit |
|---|---|---|
| FastAPI / Python backend | TypeScript + Postgres functions cover Module 6 detection. No ML in V1 (§8). | ML-based detection in V2; or analyst tooling that needs Python |
| Separate microservice for pattern detection | Module 6 §9.5 recommends in-process; Postgres functions deliver this. | When pattern detection CPU exceeds Postgres limits (~50k MAU) |
| Bedrock for Claude | 5–15% cost premium without compliance benefit. | If DPDP / SEBI requires region-locked AI processing |
| Redis Streams / BullMQ / SQS | `FOR UPDATE SKIP LOCKED` on Postgres tables is sufficient for V1 volumes. | Job throughput >100/sec sustained, or need for delay queues with exact timing |
| TimescaleDB / time-series DB | Aggregates are pre-computed snapshots (design principle 1.7). | Real-time charting over raw trade rows at >100k MAU |
| Algolia / Meilisearch | Postgres tsvector handles user-scoped journal search. | Cross-user search (not in V1 — see §25 of v2 spec) |
| Edge runtime for API routes | Edge has 4 MB code-size limit and limited Node APIs. Drizzle, postgres.js, and the Anthropic SDK all want Node. | Read-only public endpoints (Module 21 Learn personalization could move to Edge for <50ms TTFB) |
| GraphQL | REST + Server Actions are simpler and faster to build. | Mobile app with bandwidth constraints (V2) |
| tRPC | Server Actions cover the type-safety story in App Router. | If non-Next.js client (mobile app) needs typed API |
| Native mobile app (React Native / Expo) | Per V1 spec §25: "Browser extension or desktop app" not in V1; PWA is the target. | V2 |
| Self-hosted everything (Coolify / Dokku) | Ops burden is not a 1-2 dev problem to solve. | When platform bills cross ~₹40k/mo and ops headcount exists |
| Kafka / event streaming | No event-driven cross-service needs in V1. | When you have >3 services with cross-cutting events |

---

## 6. Risk-ranked watch list

Things to actively monitor from week 1:

### Tier 1 (could break V1 launch if unattended)

1. **Vercel function cold starts on India-served Pro gates.** Measure `evaluate_gate` p95 from synthetic checks in Mumbai/Bangalore. If >150ms p95, move the entire gate path to a Supabase Edge Function in Mumbai (skip Vercel for that one endpoint).
2. **Supabase free-tier connection limit** (60 direct, 200 pooled). With Server Actions + serverless, you can burn through connections fast. *Always* use the pooler URL, never the direct one.
3. **Cashfree webhook reliability.** Module 15. Single-source-of-truth pattern: webhook updates `subscriptions` table; everything else reads from there. Idempotency by `webhook_id` (Module 17 §3.12).
4. **PWA service worker update flow.** Stale service workers are a top cause of "ghost bugs" in PWAs. Use Serwist's `skipWaiting` + `clientsClaim` deliberately and test the upgrade path.

### Tier 2 (will cost money or quality if unattended)

5. **Anthropic token budget** (Module 13 §4.8: <₹15/Pro user/month). Add budget alerts in Anthropic console. The Pattern Narrative surface is the highest variable cost — cache aggressively.
6. **Supabase egress** (5 GB/mo free). The CSV import preview at 500 rows × 5 trades = ~50KB; not concerning at V1 volumes. But check after launch.
7. **`pg_cron` reliability for fan-out.** Test the Sunday-night AI batch with 100 synthetic Pro users before any real load.
8. **Drizzle migration drift between local and production schemas.** Enforce migrations-only schema changes; never edit prod schema in the Supabase Studio.

### Tier 3 (good hygiene)

9. Upstash daily command count. Free tier = 500k/day. Cache aggregates on a single key per user, not 8 keys.
10. Sentry quota (5k errors/mo free). Tune Module 17 §4.9 sampling.
11. Bundle size. The Recharts + Framer Motion combo is heavyweight. Lazy-load below-the-fold.

---

## 7. What I'd build differently from the developer's first instinct

Most of "Next.js serverless functions" is right. Two specific nudges:

### Nudge 1: Don't put gate evaluation in a Vercel function
Put it in a Postgres function. Vercel calls `supabase.rpc()`. This is faster *and* satisfies Module 6 §9.5's "in-process detector library" recommendation. The Vercel function becomes a 10-line wrapper.

### Nudge 2: Use Server Actions for writes, Route Handlers for reads
Server Actions in Next.js 15 give you:
- Automatic CSRF protection
- Native form binding
- Built-in `revalidatePath()` for cache invalidation
- No need to design API URLs for write paths

Use them for: trade save, edit, delete, plan submit, dispute submit, settings updates, all the form-driven write flows.

Use Route Handlers for: AI on-demand generation (needs streaming), Cashfree webhooks (external POST), Learn-page personalization overlay (called from static page), service-worker fetch handlers, anything an external system has to call.

### Nudge 3: Server Actions can be slow on cold start — measure before assuming
Server Actions still run on Vercel Functions. Don't put complex business logic *inside* the action — call into Supabase RPC and return. The action body should be: validate → rpc → revalidatePath → return.

---

## 8. Cost reconciliation against the prior plan

| Category | Prior plan | Updated plan | Delta |
|---|---|---|---|
| Frontend host | Vercel Hobby (free → Pro at monetization) | Same | ₹0 |
| Backend runtime | Railway Hobby ($5/mo) + FastAPI | Vercel Fluid Compute + Supabase Edge Functions | **–₹400/mo** (Railway eliminated) |
| Database | Supabase free → Pro | Same | ₹0 |
| Cache | Upstash free | Same | ₹0 |
| Email | (was Resend) → SES | SES | (already accepted) |
| Push | FCM | Same | ₹0 |
| Payments | Cashfree | Same | ₹0 |
| AI | Anthropic direct | Same | ₹0 |
| Errors | Sentry free | Same | ₹0 |
| Product analytics | (not explicit before) | PostHog free tier | ₹0 |

**Net effect: ~₹400/mo cheaper than the prior plan** because Railway and FastAPI come out of the stack entirely. Quality unchanged or better (Postgres-side gate evaluation is *faster* than Railway round trips).

---

## 9. Migration path if/when you do consolidate to AWS

When the time comes (likely 50k+ MAU per the prior analysis):

| Component | AWS landing zone | Difficulty |
|---|---|---|
| Vercel → Amplify Hosting or CloudFront+S3+Lambda@Edge | Amplify is closest match; CloudFront route gives more control | Medium (test PWA SW carefully) |
| Supabase Postgres → RDS | `pg_dump` and restore; the hardest part is rebuilding RLS + Auth | High (auth migration is the hairy bit) |
| Supabase Auth → Cognito | Re-issue all sessions; users re-login once | High |
| Supabase Storage → S3 | Move files; rewrite URL signing | Low |
| Supabase Edge Functions → Lambda | Deno → Node; mostly mechanical | Low |
| Upstash Redis → ElastiCache Serverless (Valkey) | Connection-string swap | Low |
| FCM → SNS | Keep FCM — no reason to swap | N/A |
| Anthropic → Bedrock | Optional even at scale | Optional |

The hardest piece is auth. Plan the consolidation in this order: Storage → Edge Functions → Cache → Database → Hosting → Auth (last, because it touches every user session).

---

## 10. Final stack — one-page summary

**Frontend:** Next.js 15 (App Router, RSC, Server Actions) + TypeScript + Tailwind + shadcn/ui + TanStack Query + Zustand + RHF + Zod + Recharts + Framer Motion + Serwist + Dexie + date-fns-tz

**Backend (interactive):** Vercel Fluid Compute → Drizzle ORM → Supabase Postgres (RLS-enforced) → Upstash Redis (idempotency, rate limit, hard-block locks)

**Backend (async/scheduled):** `pg_cron` → Supabase Edge Functions → Postgres queue tables (`FOR UPDATE SKIP LOCKED`)

**Detection engine:** Postgres functions (PL/pgSQL) called via `supabase.rpc()` — satisfies Module 6 §9.5

**External:** Anthropic API (Haiku 4.5 + Sonnet 4.6 split) · Amazon SES + React Email · FCM · Cashfree · Sentry · PostHog

**Tooling:** Biome + Vitest + Playwright + Husky + Supabase CLI

This is a deliberately small list. Every component earns its place against a specific module requirement. Nothing here is speculative — every choice maps to either an explicit module spec or the cost-quality envelope you set.

---

*End of stack review.*