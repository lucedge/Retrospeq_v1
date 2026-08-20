/**
 * The `BrokerAdapter` interface — 00-foundation §10.1, "deliberately
 * unspecified" vendor, fixed interface. Every downstream module (sync
 * worker, Module 02's ingestion pipeline, the connect flow in
 * `lib/broker/connect.ts`) depends on this shape and nothing else.
 * AGENTS.md's security bar: "No vendor type may leak past the
 * `BrokerAdapter` interface into any downstream module" — nothing in
 * this file, or any module that imports it, may reference a
 * vendor-specific type (an MT5 SDK type, a cTrader OAuth response
 * shape, etc). A real adapter implementation is free to use those
 * internally; it must translate to these shapes at its own boundary.
 *
 * No real vendor exists yet (PROGRESS.md "Infra gaps" — broker
 * integration vendor undecided). This file is buildable and testable
 * today because it's an interface plus a deterministic fixture
 * implementation (`fixture-adapter.ts`) — see that file's own header for
 * why it is explicitly NOT a stand-in for a real vendor.
 */

// ---------------------------------------------------------------------
// Shared field types
// ---------------------------------------------------------------------

/**
 * Numeric quantities cross this boundary as decimal strings, never
 * `number` — 00-foundation §2.3 ("Prices and monetary values ...
 * Never floating point") applies at the adapter boundary too, not just
 * in Postgres. The eventual write path (Module 02) parses these into
 * `numeric(20,8)` columns without ever round-tripping through an IEEE
 * float. `raw` payloads carry the vendor's own representation for
 * forensics only (`fills.raw` per Module 02 §3.1) and must never be
 * read by any code outside the adapter that produced it.
 */
export type DecimalString = string;

/** ISO-8601 timestamp string, always UTC (00-foundation §2.2). */
export type IsoTimestamp = string;

export type Platform = 'mt4' | 'mt5' | 'ctrader' | 'binance' | 'bybit' | 'manual';

export type CredentialKind = 'investor_password' | 'api_key' | 'vendor_token';

export type FillSide = 'buy' | 'sell';

export type CloseReason = 'sl' | 'tp' | 'manual' | 'so' | 'unknown';

/** Sync tier per 00-foundation §10.1 / analytics-registry §3: what the
 *  adapter can actually pull for this account. */
export type SyncTier = 't0' | 't1' | 't2';

// ---------------------------------------------------------------------
// Credential input (step 1-2 of the connect flow, Module 01 §4.1)
// ---------------------------------------------------------------------

export interface BrokerCredentialInput {
  platform: Platform;
  /** Broker server name, e.g. "ICMarketsSC-Live02". Absent for
   *  exchange-style adapters (crypto) and manual accounts. */
  server?: string;
  /** Account number / login. Absent for API-key-style adapters. */
  login?: string;
  /** The secret itself — investor password or API key. Never logged,
   *  never included in an error, never persisted in plaintext anywhere
   *  (00-foundation §4.1 "Handling rules"). */
  credential: string;
  credentialKind: CredentialKind;
}

// ---------------------------------------------------------------------
// AccountHandle — opaque, adapter-defined, never inspected by callers
// ---------------------------------------------------------------------

/**
 * Returned by `connect()`. Deliberately opaque beyond these three
 * fields — a real adapter is free to carry an internal session token,
 * SDK connection object, etc, but nothing beyond this shape may be
 * relied upon outside the adapter itself (that would be exactly the
 * "vendor type leaking past the interface" AGENTS.md forbids).
 *
 * `verifiedReadonly` is the load-bearing field: the connect flow
 * (`lib/broker/connect.ts`) refuses to proceed to encryption/storage
 * unless this is `true`, as a defence-in-depth backstop even though a
 * conforming adapter should never return a handle at all for a
 * too-permissive credential (see `connect()`'s doc comment below).
 */
export interface AccountHandle {
  /** The adapter implementation's own identifier, e.g. 'fixture'. Never
   *  a vendor SDK object — a plain string label for logging/debugging. */
  readonly adapterId: string;
  /** Broker-side login/account id. Stored as `trading_accounts.provider_ref`
   *  — never used as a primary key (00-foundation §2.1). */
  readonly providerAccountRef: string;
  /** Proven at connect time (Module 01 §4.1 step 4). Always `true` on a
   *  handle that reached the caller; a `BrokerAdapter.connect()` that
   *  detects a too-permissive credential must reject via
   *  `BrokerCredentialTooPermissiveError`, never return a handle with
   *  this set to `false`. */
  readonly verifiedReadonly: boolean;
}

// ---------------------------------------------------------------------
// Fill / Position / PositionSnap — shapes matching Module 02 §3.1's
// `fills` / `position_snapshots` tables, minus write-time-only columns
// (id, user_id, account_id, server_day, imported_at) that this module
// (01) never computes — those are assigned at Module 02's write path.
// Mirrors fixtures/golden/*/input.json's modeling of
// `BrokerAdapter.fetchHistory` output (see that README).
// ---------------------------------------------------------------------

export interface Fill {
  provider_ref: string;
  instrument: string;
  side: FillSide;
  volume: DecimalString;
  price: DecimalString;
  filled_at: IsoTimestamp;
  commission: DecimalString;
  swap: DecimalString;
  realized_pnl: DecimalString | null;
  currency: string; // char(3)
  stop_at_fill: DecimalString | null;
  target_at_fill: DecimalString | null;
  provider_position_ref: string | null;
  provider_parent_ref: string | null;
  close_reason: CloseReason | null;
  raw: Record<string, unknown>;
}

/** An open position as reported by the broker right now (T0/T1 per
 *  00-foundation §10.1). Distinct from the eventual `trades` row Module
 *  02 derives — this is the broker's own view, before grouping. */
export interface Position {
  provider_position_ref: string;
  instrument: string;
  side: FillSide;
  volume: DecimalString;
  avg_price: DecimalString;
  opened_at: IsoTimestamp;
  unrealized_pnl: DecimalString | null;
  currency: string;
  stop: DecimalString | null;
  target: DecimalString | null;
  raw: Record<string, unknown>;
}

/** T1-only. Matches Module 02 §3.1's `position_snapshots` table shape,
 *  minus write-time-only columns (id, user_id, account_id). */
export interface PositionSnap {
  instrument: string;
  taken_at: IsoTimestamp;
  volume: DecimalString;
  stop: DecimalString | null;
  target: DecimalString | null;
  unrealized: DecimalString | null;
}

/** Declares what this account's adapter connection can actually do —
 *  drives sync_tier / capabilities on `trading_accounts` and, downstream,
 *  which operands Module 04 offers and which analytics Module 05 may run
 *  (00-foundation §10.1's two "consequences to hold"). */
export interface TierFlags {
  tier: SyncTier;
  history: boolean; // fetchHistory available
  openPositions: boolean; // fetchOpenPositions available
  positionSnapshots: boolean; // snapshotPositions available (T1+)
  liveSession: boolean; // T2
}

// ---------------------------------------------------------------------
// Error taxonomy — thrown by `connect()`, mapped 1:1 by
// `lib/broker/connect.ts` to Module 01 §9's error codes. Every
// conforming `BrokerAdapter` implementation MUST throw one of these
// (never a generic Error) for these specific, expected failure modes,
// so the connect flow's mapping stays total and no vendor-specific
// error string ever reaches the user (Module 01 §9: "No vendor error
// string ever reaches the user").
// ---------------------------------------------------------------------

/** `CONNECT_AUTH_FAILED` — bad login/password/server. */
export class BrokerAuthFailedError extends Error {
  constructor(message = 'Broker authentication failed.') {
    super(message);
    this.name = 'BrokerAuthFailedError';
  }
}

/**
 * `CONNECT_CREDENTIAL_TOO_PERMISSIVE` — Module 01 §4.1 step 4, "the
 * single strongest security control in the product." Thrown when the
 * benign-trade-operation probe an adapter's `connect()` attempts
 * internally succeeds (it should always fail for a true read-only
 * credential). Step 4 is mandatory and has no override — every
 * `BrokerAdapter.connect()` implementation MUST perform this probe
 * before ever returning a handle, not just before storage; there is no
 * separate adapter method for it because the interface (00-foundation
 * §10.1) fixes `connect()`'s own doc comment as "verifies read-only,
 * rejects master credentials" — the check is part of what `connect()`
 * means, not an optional follow-up step a caller might skip.
 *
 * The message on this error must never include the credential itself —
 * enforced by construction: this class never accepts the credential
 * value as a constructor argument.
 */
export class BrokerCredentialTooPermissiveError extends Error {
  constructor(message = 'Credential is capable of trading, not read-only.') {
    super(message);
    this.name = 'BrokerCredentialTooPermissiveError';
  }
}

/** `CONNECT_SERVER_UNKNOWN` — server name not resolvable. */
export class BrokerServerUnknownError extends Error {
  constructor(message = 'Broker server not found.') {
    super(message);
    this.name = 'BrokerServerUnknownError';
  }
}

/** `CONNECT_VENDOR_UNAVAILABLE` — the integration vendor itself is down. */
export class BrokerVendorUnavailableError extends Error {
  constructor(message = 'Broker integration unavailable.') {
    super(message);
    this.name = 'BrokerVendorUnavailableError';
  }
}

// ---------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------

export interface BrokerAdapter {
  /**
   * Authenticates AND performs the mandatory read-only verification
   * (Module 01 §4.1 steps 3-4) in one call. Must reject (throw
   * `BrokerCredentialTooPermissiveError`) rather than return a handle
   * for any credential capable of placing, modifying or closing trades.
   * Never returns a handle with `verifiedReadonly: false`.
   */
  connect(credential: BrokerCredentialInput): Promise<AccountHandle>;
  /** T0. Full available history since `since` (inclusive-ish; the
   *  caller is expected to overlap windows and dedup — Module 02 §4.1). */
  fetchHistory(handle: AccountHandle, since: IsoTimestamp): Promise<Fill[]>;
  /** T0/T1. */
  fetchOpenPositions(handle: AccountHandle): Promise<Position[]>;
  /** T1 — enables stop-movement analytics. */
  snapshotPositions(handle: AccountHandle): Promise<PositionSnap[]>;
  /** Declares T0 / T1 / T2 support for this specific account connection. */
  capabilities(handle: AccountHandle): Promise<TierFlags>;
}
