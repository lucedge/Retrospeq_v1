# Module 01 — Identity & Accounts

Owns the user, their connected trading accounts, plan entitlements, and the runtime config that gates every analytic. Everything else in the system hangs off this module's `user_id` and `account_id`.

Inherits all conventions from `00-foundation.md`.

---

## 1. Scope

**In:** authentication, user profile, trading account connection lifecycle, credential custody, account settings (rollover, currency, labels), plan and entitlement resolution, kill-switch config service, data-subject-rights operations.

**Out:** anything that reads trade data. This module knows an account exists and how to reach it; it does not know what is in it.

**Deferred to v1.1:** prop-firm labelling on accounts is specced here (the `account_kind` column and the label flow) but the rulebook it enables lives in Module 09.

---

## 2. Stories

### Authentication

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | new trader | to sign up with email or Google | I can start without friction | Account created, verification email sent, onboarding entered. No trading credential requested at this stage |
| 1.2 | returning trader | to stay signed in across sessions | I don't re-auth daily | Refresh token rotation; 30-day idle expiry |
| 1.3 | trader | to reset my password | I can recover access | Time-limited single-use link; all sessions invalidated on reset |
| 1.4 | trader | to see and revoke active sessions | I control access | Device list with last-seen; revoke individually or all |
| 1.5 | security-conscious trader | to enable 2FA | my financial data is protected | TOTP; recovery codes issued once |

### Connecting a trading account

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader | to connect my MT5 account | my trades import automatically | Server, login, investor password. Connection verified before save |
| 2.2 | trader | to be stopped if I paste my master password | I don't expose my account | System attempts a benign trade op; if it succeeds, credential is **rejected and not stored**, with an explanation of investor vs master |
| 2.3 | crypto trader | to connect with a read-only API key | my exchange account is safe | Permissions inspected; keys with trade or withdrawal scope rejected with a named reason |
| 2.4 | trader | to see connection status plainly | I trust the data | One of: connected · syncing · needs attention · disconnected. Never a bare spinner |
| 2.5 | trader | to disconnect an account | I can leave cleanly | Credential destroyed immediately; **imported trade history retained** and clearly stated as retained |
| 2.6 | trader | to connect several accounts | I trade more than one | Multiple accounts per user; each independently synced and labelled |
| 2.7 | trader with no API access | to skip connection | I can still use the product | Manual mode; full product minus auto-import (see Module 02) |
| 2.8 | trader | to know what the app can and cannot see | I understand the trade-off | Capability statement at connect: "read-only · cannot place or close trades · stop movements not visible on this broker" where applicable |

### Account settings

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 3.1 | forex trader | my day to end at the broker rollover | daily rules match my platform | Default from adapter; editable |
| 3.2 | crypto trader | my day to end at 00:00 UTC | it matches my exchange | Default for crypto accounts; editable |
| 3.3 | trader | to name my accounts | I can tell them apart | Free-text label, 40 chars |
| 3.4 | trader | to mark an account as a prop challenge | firm rules apply (v1.1) | `account_kind` set; in v1 this stores the label and surfaces "coming soon" — it does not create a rulebook |

### Plan and entitlement

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 4.1 | free user | to hit a clear limit, not a vague wall | I know what upgrading buys | "You're at 3 of 3 rules. Your history suggests four more." Specific number, from real data |
| 4.2 | subscriber | to manage billing | I stay in control | Portal link; plan change effective immediately on upgrade, at period end on downgrade |
| 4.3 | downgrading user | not to lose data | I can come back | Excess rules **deactivated, never deleted**; reactivate on upgrade. Nothing is destroyed by a downgrade |
| 4.4 | user | my entitlements enforced server-side | limits are real | Every capability check server-side; client state advisory only |

### Rights and privacy

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 5.1 | user | to export everything | I own my data | JSON + CSV bundle by signed URL; target minutes, hard limit 30 days |
| 5.2 | user | to delete my account | I can leave | Hard delete; credentials immediate; 7-day grace with cancel; confirmation email |
| 5.3 | EU user | to exercise GDPR rights | law is respected | Access, erasure, restriction, objection, portability all implemented as code paths |
| 5.4 | user | to opt out of telemetry | I control tracking | Toggle; respected immediately; no dark patterns |

---

## 3. Data model

### 3.1 Tables

```sql
-- Profile extends Supabase auth.users
create table profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  locale            text not null default 'en',
  timezone          text not null default 'UTC',   -- display only, never for day boundaries
  telemetry_opt_out boolean not null default false,
  onboarding_stage  text not null default 'created',
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table trading_accounts (
  id              uuid primary key default uuid_generate_v7(),
  user_id         uuid not null references profiles(id) on delete cascade,
  label           text not null,
  platform        text not null,        -- mt4 | mt5 | ctrader | binance | bybit | manual
  account_kind    text not null default 'personal',  -- personal | prop | demo
  provider_ref    text,                 -- broker-side login/account id, never a PK
  server          text,
  base_currency   char(3) not null,
  day_rollover    text not null,        -- IANA zone + time, e.g. 'America/New_York 17:00'
  sync_tier       text not null default 't0',        -- t0 | t1 | t2, from adapter capabilities()
  capabilities    jsonb not null default '{}',       -- raw capability flags from the adapter
  status          text not null default 'pending',   -- pending|connected|syncing|attention|disconnected
  status_detail   text,                 -- machine code, never a raw vendor error
  last_sync_at    timestamptz,
  connected_at    timestamptz,
  disconnected_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, platform, provider_ref)
);

-- Isolated. No client-readable policy exists for this table at all.
create table account_credentials (
  account_id      uuid primary key references trading_accounts(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  ciphertext      bytea not null,
  wrapped_dek     bytea not null,
  iv              bytea not null,
  auth_tag        bytea not null,
  kms_key_id      text not null,
  credential_kind text not null,        -- investor_password | api_key | vendor_token
  verified_readonly boolean not null,   -- proven at connect time
  rotated_at      timestamptz,
  created_at      timestamptz not null default now()
);

create table subscriptions (
  user_id            uuid primary key references profiles(id) on delete cascade,
  plan               text not null default 'free',   -- free | pro   (trader_plus at v1.1)
  status             text not null default 'active', -- active|past_due|canceled|trialing
  provider_ref       text,
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

-- Runtime gate for every analytic. Config, not code (analytics registry §5).
create table analytic_config (
  analytic_id  text primary key,
  enabled      boolean not null default false,
  min_plan     text not null default 'pro',
  cohort_only  boolean not null default true,
  updated_at   timestamptz not null default now()
);

create table analytic_user_suppression (
  user_id     uuid not null references profiles(id) on delete cascade,
  analytic_id text not null,
  reason      text not null,     -- declined_once | declined_twice | user_hidden
  created_at  timestamptz not null default now(),
  primary key (user_id, analytic_id)
);

create table user_cohorts (
  user_id    uuid not null references profiles(id) on delete cascade,
  cohort     text not null,      -- 'beta_traders'
  created_at timestamptz not null default now(),
  primary key (user_id, cohort)
);

create table audit_log (
  id         uuid primary key default uuid_generate_v7(),
  user_id    uuid references profiles(id) on delete set null,
  actor      text not null,      -- user | system | support
  action     text not null,
  target     text,
  metadata   jsonb not null default '{}',   -- never credentials
  ip_hash    text,
  created_at timestamptz not null default now()
);

create table data_requests (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  kind         text not null,    -- export | erasure | restriction
  status       text not null default 'pending',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  artifact_url text,
  expires_at   timestamptz
);
```

### 3.2 ERD

```
auth.users ──1:1── profiles ──1:N── trading_accounts ──1:1── account_credentials
                      │                     │
                      │                     └──1:N── (fills, trades)          → Module 02
                      │
                      ├──1:1── subscriptions
                      ├──1:N── analytic_user_suppression
                      ├──1:N── user_cohorts
                      ├──1:N── data_requests
                      └──1:N── audit_log

analytic_config ── standalone, keyed by analytic_id (matches the registry)
```

### 3.3 RLS

Every table above carries an owner policy on `user_id`. Two exceptions, both deliberate:

| Table | Policy |
|---|---|
| `account_credentials` | **No select policy for any role except service.** Insert and delete permitted to the owner; select permitted to nobody. The client can create and destroy a credential it can never read back |
| `analytic_config` | Read-only to authenticated users (the client needs to know what is enabled); writes restricted to service role |

`audit_log` is insert-only for the service role and select-only for the owning user.

---

## 4. Business logic

### 4.1 Connection flow

```
1. User submits platform + server + login + credential
2. Validate shape (no network call yet)
3. adapter.connect(credential)
     ├─ auth fails            → CONNECT_AUTH_FAILED, nothing stored
     ├─ auth succeeds         → continue
4. Read-only verification — MANDATORY, no bypass
     ├─ attempt a benign trade operation
     ├─ succeeds              → CONNECT_CREDENTIAL_TOO_PERMISSIVE
     │                          Credential discarded. Not stored. Not logged.
     │                          UI explains investor vs master.
     └─ rejected as expected  → verified_readonly = true
5. adapter.capabilities()     → sync_tier, capabilities jsonb
6. Encrypt (envelope, foundation §4.1) and store
7. Create trading_accounts row, status = connected
8. Default day_rollover from platform class
9. Enqueue initial history import                        → Module 02
10. Audit: account_connected
```

**Step 4 is not optional and has no override.** It is the single strongest security control in the product: it makes it impossible for the system to hold a credential capable of trading.

### 4.2 Sync tier resolution

`capabilities()` returns what the adapter can actually do for this account. That determines:

- Which operands are offered in the rule template library (Module 04)
- Which analytics may run (Module 05, gated against `analytic_config` and account tier)
- What the connect screen tells the user it cannot see

**T1 analytics must be hidden, not silently inert.** A rule the trader writes that can never fire is worse than a rule they were never offered.

### 4.3 Entitlement resolution

```
can(user, capability) =
    plan_capabilities[subscription.plan].includes(capability)
    AND NOT quota_exceeded(user, capability)
```

| Capability | Free | Pro |
|---|---|---|
| `account.connect` | 1 account | unlimited |
| `rules.create` | 3 | unlimited |
| `rules.hard` | 0 (all soft) | up to 6 |
| `strategy.create` | 0 | unlimited |
| `fields.custom` | 0 | unlimited |
| `analytics.derived` | yes | yes |
| `analytics.detection` | **all five** | all five |
| `analytics.judgment` | no | yes |
| `graduation` | no | yes |
| `preview.engine` | **yes** | yes |
| `streak`, `adherence` | yes | yes |

Free caps quantity, not capability (design doc §15). The upgrade prompt is generated from real data, never generic.

### 4.4 Downgrade

Nothing is deleted. Rules beyond the free cap are set `state = 'deactivated_by_plan'`, retaining all history and evaluations. Strategies become read-only. Judgment findings stop rendering but their underlying captures remain. Re-upgrading restores everything with no data loss and no re-entry.

### 4.5 Disconnection vs deletion

| Action | Credential | Trade history | Analytics |
|---|---|---|---|
| Disconnect account | Destroyed immediately | **Retained** | Continue on historical data; no new syncs |
| Delete account (user) | Destroyed | Deleted | Gone |
| Erasure request | Destroyed | Deleted, re-applied to restores | Gone |

The UI must be explicit that disconnecting keeps history, because traders will assume otherwise and hesitate.

### 4.6 Erasure

```
1. data_requests row, kind = erasure, 7-day grace
2. Grace: account restricted (no sync, no analytics), cancellable
3. On execution:
     a. Destroy credentials first
     b. Delete owned rows in FK-safe order (explicit list, not ON DELETE reliance)
     c. Unlink telemetry pseudonyms
     d. Record a tombstone: hash(email), timestamp, request id — no personal data
     e. Register the deletion for replay against any restored backup
4. Confirmation email, then the address itself is purged
```

**Immutability does not survive erasure.** Frozen evaluations and append-only fills are product invariants protecting the trader from themselves; they are not a legal basis for retention.

---

## 5. UI

### 5.1 Elements

**Connect account** — platform picker, server/login/credential fields, a permanent read-only explainer, verification progress with named steps, capability statement on success.

**Account list** — one card per account: label, platform, status chip, last sync, base currency, rollover. Actions: rename, settings, disconnect.

**Status chips** — `connected` neutral, `syncing` neutral with motion, `needs attention` warning with a specific reason and a fix action, `disconnected` muted.

**Plan screen** — current plan, usage against caps as fractions ("3 of 3 rules"), upgrade with the data-derived prompt, billing portal link.

**Privacy screen** — export, delete, telemetry toggle, session list, 2FA.

### 5.2 Reference markup

```html
<!-- Connect a trading account -->
<section class="connect" aria-labelledby="connect-h">
  <h1 id="connect-h">Connect your trading account</h1>

  <p class="explainer">
    We ask for your <strong>investor password</strong> — a read-only credential.
    It cannot place, modify or close trades. If you paste a password that can
    trade, we will reject it.
    <a href="/help/investor-password">How to find it</a>
  </p>

  <form id="connect-form" novalidate>
    <fieldset>
      <legend>Platform</legend>
      <div class="segmented" role="radiogroup" aria-label="Platform">
        <input type="radio" id="p-mt5" name="platform" value="mt5" checked>
        <label for="p-mt5">MetaTrader 5</label>
        <input type="radio" id="p-mt4" name="platform" value="mt4">
        <label for="p-mt4">MetaTrader 4</label>
        <input type="radio" id="p-crypto" name="platform" value="crypto">
        <label for="p-crypto">Crypto exchange</label>
        <input type="radio" id="p-manual" name="platform" value="manual">
        <label for="p-manual">No API — manual</label>
      </div>
    </fieldset>

    <div class="field">
      <label for="server">Broker server</label>
      <input id="server" name="server" autocomplete="off" spellcheck="false"
             aria-describedby="server-hint">
      <p id="server-hint" class="hint">Shown in your terminal under Account.</p>
    </div>

    <div class="field">
      <label for="login">Account number</label>
      <input id="login" name="login" inputmode="numeric" autocomplete="off">
    </div>

    <div class="field">
      <label for="credential">Investor password</label>
      <input id="credential" name="credential" type="password"
             autocomplete="off" data-sensitive="true"
             aria-describedby="cred-hint">
      <p id="cred-hint" class="hint">Read-only. Never your master password.</p>
    </div>

    <button type="submit" class="primary">Connect</button>
  </form>

  <!-- Verification, live region so screen readers follow along -->
  <ol class="verify" role="status" aria-live="polite" hidden>
    <li data-step="auth"      data-state="pending">Reaching your broker</li>
    <li data-step="readonly"  data-state="pending">Confirming the credential is read-only</li>
    <li data-step="caps"      data-state="pending">Checking what data is available</li>
    <li data-step="import"    data-state="pending">Importing your history</li>
  </ol>

  <!-- Rejection: master password detected -->
  <div class="alert alert--warning" role="alert" hidden data-error="CONNECT_CREDENTIAL_TOO_PERMISSIVE">
    <h2>That password can place trades</h2>
    <p>We did not save it. Please use your investor password instead — it gives
       us the same history without the ability to trade.</p>
    <a href="/help/investor-password" class="link">Where to find your investor password</a>
  </div>

  <!-- Success: state capability honestly, including gaps -->
  <div class="capability" role="status" hidden>
    <h2>Connected</h2>
    <ul>
      <li data-cap="history"  data-available="true">Trade history and fills</li>
      <li data-cap="open"     data-available="true">Open positions</li>
      <li data-cap="stopmove" data-available="false">
        Stop-loss changes — not available on this broker
      </li>
    </ul>
  </div>
</section>
```

```html
<!-- Account list -->
<ul class="account-list">
  <li class="account-card" data-status="connected">
    <div class="account-card__head">
      <h3 class="account-card__label">FTMO Challenge</h3>
      <span class="chip chip--neutral" data-status="connected">Connected</span>
    </div>
    <dl class="account-card__meta">
      <div><dt>Platform</dt><dd>MetaTrader 5</dd></div>
      <div><dt>Currency</dt><dd>USD</dd></div>
      <div><dt>Day ends</dt><dd>17:00 New York</dd></div>
      <div><dt>Last sync</dt><dd><time datetime="2026-08-02T09:14:00Z">14 min ago</time></dd></div>
    </dl>
    <div class="account-card__actions">
      <button type="button" data-action="settings">Settings</button>
      <button type="button" data-action="disconnect" class="danger">Disconnect</button>
    </div>
  </li>

  <li class="account-card" data-status="attention">
    <div class="account-card__head">
      <h3 class="account-card__label">IC Markets Live</h3>
      <span class="chip chip--warning" data-status="attention">Needs attention</span>
    </div>
    <p class="account-card__reason" data-code="SYNC_CREDENTIAL_REJECTED">
      Your broker rejected the saved credential. This usually means the password
      changed.
    </p>
    <button type="button" class="primary" data-action="reconnect">Reconnect</button>
  </li>
</ul>
```

```html
<!-- Plan usage: fractions, never a bare percentage -->
<section class="plan" aria-labelledby="plan-h">
  <h1 id="plan-h">Your plan</h1>
  <p class="plan__current">Free</p>

  <ul class="usage">
    <li class="usage__item" data-at-limit="true">
      <span class="usage__label">Rules</span>
      <span class="usage__value"><strong>3</strong> of 3</span>
      <progress value="3" max="3" aria-label="Rules used"></progress>
    </li>
    <li class="usage__item">
      <span class="usage__label">Connected accounts</span>
      <span class="usage__value"><strong>1</strong> of 1</span>
      <progress value="1" max="1" aria-label="Accounts connected"></progress>
    </li>
  </ul>

  <!-- Generated from the user's own history, never generic -->
  <aside class="upgrade-prompt" data-analytic="upgrade.rulecap">
    <p>You're at 3 of 3 rules. Your history suggests four more.</p>
    <button type="button" class="primary">See Pro</button>
  </aside>
</section>
```

### 5.3 Accessibility

Verification steps in an `aria-live="polite"` region; rejection in `role="alert"`; every status chip carries text, never colour alone; the credential field is `type="password"` with `autocomplete="off"`; full keyboard traversal; WCAG 2.2 AA.

---

## 6. Flows

### 6.1 Connection state machine

```
        ┌─────────┐
        │ pending │
        └────┬────┘
             │ connect()
      ┌──────▼──────┐  auth fail    ┌────────────┐
      │ verifying   ├──────────────►│  rejected  │ (nothing stored)
      └──────┬──────┘  too permissive└────────────┘
             │ verified read-only
      ┌──────▼──────┐
      │  connected  │◄──────────────┐
      └──────┬──────┘               │ successful sync
             │ sync starts          │
      ┌──────▼──────┐               │
      │   syncing   ├───────────────┘
      └──────┬──────┘
             │ repeated failure
      ┌──────▼──────┐  user reconnects
      │  attention  ├──────────────► verifying
      └──────┬──────┘
             │ user disconnects
      ┌──────▼────────┐
      │ disconnected  │  credential destroyed, history retained
      └───────────────┘
```

### 6.2 Erasure flow

```
request ──► grace (7d, restricted, cancellable) ──► execute
                                                      │
       credentials destroyed ◄────────────────────────┤
       owned rows deleted in FK order ◄───────────────┤
       telemetry unlinked ◄───────────────────────────┤
       tombstone written ◄────────────────────────────┤
       backup-replay deletion registered ◄────────────┘
                          │
                          ▼
              confirmation email, then address purged
```

---

## 7. Test plan

### 7.1 Unit

- Envelope encryption round-trip; tampered ciphertext fails auth-tag verification
- Entitlement resolution across every plan × capability pair
- Downgrade deactivates without deleting; upgrade restores exactly
- Rollover defaulting per platform class
- Erasure FK ordering produces no orphans

### 7.2 Security tests — mandatory, no exceptions

| Test | Assertion |
|---|---|
| Master credential rejected | Credential capable of trading is never persisted; assert zero rows written |
| Credential unreadable | Owner cannot select from `account_credentials` under RLS; only service role can |
| Cross-user isolation | Every table asserted unreadable by a second user. **100% table coverage, automated** |
| No credential in logs | Grep the full log stream produced by a connect + failed sync run for the test secret |
| No credential in errors | Every error path asserted to exclude credential material |
| Service-role inventory | Test enumerates service-role call sites and fails on an unreviewed addition |
| Token replay | Revoked session cannot act |
| Rate limits | Connect and auth endpoints throttle per user and per IP |

### 7.3 Integration

Connect happy path; auth failure; too-permissive rejection; capability variance (T0-only account hides T1 operands); disconnect retains history; delete removes everything; export completeness against a fixture user.

### 7.4 E2E

Sign-up → connect → first import → dashboard. Free user hits the rule cap and sees the data-derived prompt. Downgrade then upgrade with zero data loss.

---

## 8. Quality benchmarks

| Metric | Target |
|---|---|
| Connect success rate on supported brokers | ≥ 95% |
| Time to connected | < 20 s p95 |
| Master-credential rejection accuracy | **100%** — a false negative is a critical incident |
| Export delivery | < 5 min p95, 30 days hard |
| Erasure completion | < 24 h |
| Auth p95 | < 300 ms |
| Cross-user leak findings | **Zero, ever** |

---

## 9. Error handling

| Code | Cause | User message | Retry |
|---|---|---|---|
| `CONNECT_AUTH_FAILED` | Bad login/password/server | "Your broker didn't accept these details." | Yes |
| `CONNECT_CREDENTIAL_TOO_PERMISSIVE` | Master password supplied | "That password can place trades. We didn't save it." | No — needs different input |
| `CONNECT_SERVER_UNKNOWN` | Server not resolvable | "We couldn't find that server. Check the exact name in your terminal." | Yes |
| `CONNECT_VENDOR_UNAVAILABLE` | Integration down | "We can't reach brokers right now. Your data is safe." | Yes, backoff |
| `CREDENTIAL_DECRYPT_FAILED` | KMS or corruption | "Please reconnect this account." | No — pages on-call |
| `ENTITLEMENT_LIMIT` | Cap reached | Specific: "You're at 3 of 3 rules." | No |
| `EXPORT_IN_PROGRESS` | Duplicate request | "Your export is already being prepared." | No |

**No vendor error string ever reaches the user.** Map to a code, or fall back to `internal` with an incident id.

---

## 10. Dependencies

Supabase Auth, Supabase Postgres, external KMS, broker adapter (`capabilities()` and `connect()` only), billing provider, email provider.

**This module must not import anything from Modules 02–08.** Dependency flows one way.

---

## 11. Performance

| Operation | Budget |
|---|---|
| Auth check (cached JWT) | < 50 ms |
| Entitlement resolution | < 20 ms, cached per request |
| Account list | < 200 ms |
| `analytic_config` read | < 10 ms, cached 60 s, **fails closed** |
| Connect end-to-end | < 20 s p95 (dominated by the vendor) |

Scaling notes: `audit_log` is the fastest-growing table here — partition monthly, archive at 12 months. Entitlements are hot on every request — cache per request, invalidate on subscription webhook. Credential decryption is CPU-bound; confine it to the sync worker and never to a user-facing path.

---

## 12. Relationships

| Module | Direction | Contract |
|---|---|---|
| 02 Ingestion | provides → | `account_id`, decrypted handle (worker only), `sync_tier`, `day_rollover` |
| 04 Rulebook | provides → | entitlement caps; `sync_tier` for operand filtering |
| 05 Analytics | provides → | `analytic_config`, plan, cohort, per-user suppression |
| 07 Engagement | provides → | `user_id` for event attribution |
| 08 Onboarding | provides → | `onboarding_stage` |
| 09 Prop (v1.1) | provides → | `account_kind = 'prop'` as the trigger for a firm rulebook |

---

## 13. Data policy

| Item | Position |
|---|---|
| Lawful basis | Contract for account and connection; legitimate interest for telemetry with opt-out |
| Data location | EU (Frankfurt) recommended from day one |
| Transfers | India-based access to EU-hosted data requires SCCs plus a transfer impact assessment |
| Special categories | None processed |
| Children | Not offered to under-18s; assert at sign-up |
| Retention | Credentials until disconnect; account data life + 30 days; audit 12 months; telemetry 24 months |
| Processors | Vercel, Supabase, broker vendor, billing, email. DPA with each. Broker vendor is highest-risk — read terms before selection |
| Breach | 72-hour GDPR notification path documented in the runbook; credential exposure is automatically a notifiable severity |
| DPO | Not required at current scale; reassess at scale or on adding special-category data |

---

## 14. Documentation

Route reference generated from Zod schemas; forward-only migrations; ADRs for credential custody and hosting region; runbook entries for credential decryption failure, vendor outage and erasure execution; and a user-facing help page on investor vs master passwords — the single most support-generating concept in the product.
