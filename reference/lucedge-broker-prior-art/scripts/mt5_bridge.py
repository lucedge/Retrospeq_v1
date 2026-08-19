"""
M2 MT5 beta bridge — local sync script, NOT production infrastructure.

Runs on a developer's own machine (a real MT5 terminal must be installed
and reachable here) since Vercel/Supabase cannot talk to MT5 directly —
there is no public API. This script polls Supabase for MT5 connections
that need attention, logs the local terminal into each account in turn
(sequentially — MT5's Python API only supports one active login at a
time), pulls closed-trade history, and pushes it into the same
raw_trades/broker_connections tables the deployed app already reads from.
See docs/M2_MT5_Beta_Bridge.md for the full picture and known limitations.

Setup:
  pip install MetaTrader5 cryptography requests
  Set the four env vars below (same values as the app's .env.local)
  MetaTrader 5 terminal must be installed, logged into any account once,
  and "Allow Algo Trading" enabled (Tools > Options > Expert Advisors)

Run:
  python scripts/mt5_bridge.py
"""

import base64
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not installed. Run: pip install MetaTrader5", file=sys.stderr)
    sys.exit(1)

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ENCRYPTION_KEY_B64 = os.environ.get("BROKER_CREDENTIAL_ENCRYPTION_KEY", "")

if not SUPABASE_URL or not SERVICE_KEY or not ENCRYPTION_KEY_B64:
    print(
        "Missing env vars. Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "
        "and BROKER_CREDENTIAL_ENCRYPTION_KEY (same values as .env.local).",
        file=sys.stderr,
    )
    sys.exit(1)

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

POLL_INTERVAL_SECONDS = 60
# Deliberate pacing between account logins — rapid-fire logins across many
# accounts from one IP has been reported to trigger broker-side soft bans.
LOGIN_PACING_SECONDS = 5
BACKFILL_WINDOW_DAYS = 90
# One retry on a transient IPC-layer login failure, after a short pause. The
# first login() right after a fresh initialize() times out more often than
# later ones in the same batch, apparently before the IPC channel is fully
# warmed up — a single retry clears most of these without masking a real
# credential rejection (which returns a different, non-retried error code).
LOGIN_IPC_RETRY_DELAY_SECONDS = 3


def decrypt_credential(packed_b64: str) -> str:
    """Mirrors lib/crypto/credentials.ts exactly: base64(iv[12] || authTag[16]
    || ciphertext). Python's AESGCM wants ciphertext+tag concatenated (unlike
    Node's separate getAuthTag()), so they're rejoined here."""
    raw = base64.b64decode(packed_b64)
    iv, auth_tag, ciphertext = raw[:12], raw[12:28], raw[28:]
    key = base64.b64decode(ENCRYPTION_KEY_B64)
    plaintext = AESGCM(key).decrypt(iv, ciphertext + auth_tag, None)
    return plaintext.decode("utf-8")


def compute_dedup_hash(connection_id: str, broker_trade_id: str) -> str:
    return hashlib.sha256(f"{connection_id}:{broker_trade_id}".encode()).hexdigest()


def fetch_due_connections():
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/broker_connections",
        headers=HEADERS,
        params={
            "broker": "eq.mt5",
            "status": "in.(connecting,connected,syncing,error)",
            "select": "*",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_credential(connection_id: str):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/broker_credentials",
        headers=HEADERS,
        params={"connection_id": f"eq.{connection_id}", "select": "encrypted_access_token"},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def update_connection(connection_id: str, patch: dict):
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/broker_connections",
        headers=HEADERS,
        params={"id": f"eq.{connection_id}"},
        json=patch,
        timeout=30,
    )


def record_event(connection_id: str, event_type: str, detail: dict | None = None):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/connection_events",
        headers=HEADERS,
        json={"connection_id": connection_id, "event_type": event_type, "detail": detail},
        timeout=30,
    )


def insert_sync_job(connection_id: str, job_type: str) -> str | None:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/sync_jobs",
        headers={**HEADERS, "Prefer": "return=representation"},
        json={"connection_id": connection_id, "type": job_type, "status": "running"},
        timeout=30,
    )
    if not resp.ok:
        return None
    return resp.json()[0]["id"]


def finish_sync_job(job_id: str | None, status: str, trades_fetched: int, trades_new: int, error_code=None):
    if not job_id:
        return
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/sync_jobs",
        headers=HEADERS,
        params={"id": f"eq.{job_id}"},
        json={
            "status": status,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "trades_fetched": trades_fetched,
            "trades_new": trades_new,
            "error_code": error_code,
        },
        timeout=30,
    )


def map_deals_to_raw_trades(deals, connection_id: str) -> list[dict]:
    """Groups deals by position (MT5's own grouping key, same idea as
    cTrader's positionId). MT5 tags each deal's role directly via `entry`
    (DEAL_ENTRY_IN = opening, DEAL_ENTRY_OUT = closing) — cleaner than
    cTrader, which required inferring this from a nested field's presence.
    Only emits a row per closing deal; a position whose opening deal falls
    outside the current fetch window is skipped (same accepted limitation
    as the cTrader path — see docs/M2_Trade_Data_Fields.md)."""
    by_position: dict[int, list] = {}
    for deal in deals:
        by_position.setdefault(deal.position_id, []).append(deal)

    trades = []
    for position_deals in by_position.values():
        position_deals.sort(key=lambda d: d.time_msc)
        opening = [d for d in position_deals if d.entry == mt5.DEAL_ENTRY_IN]
        closing = [d for d in position_deals if d.entry == mt5.DEAL_ENTRY_OUT]
        if not opening:
            continue
        opening_deal = opening[0]

        for deal in closing:
            trades.append(
                {
                    "connection_id": connection_id,
                    "broker_trade_id": str(deal.ticket),
                    "symbol": deal.symbol,  # MT5 gives the real symbol name directly, no lookup needed
                    "side": "buy" if opening_deal.type == mt5.DEAL_TYPE_BUY else "sell",
                    "volume": deal.volume,
                    "open_time": datetime.fromtimestamp(opening_deal.time, tz=timezone.utc).isoformat(),
                    "close_time": datetime.fromtimestamp(deal.time, tz=timezone.utc).isoformat(),
                    "open_price": opening_deal.price,
                    "close_price": deal.price,
                    "fees": deal.commission,
                    "swap": deal.swap,
                    "source": "mt5",
                    "dedup_hash": compute_dedup_hash(connection_id, str(deal.ticket)),
                    "raw_payload": deal._asdict(),
                }
            )
    return trades


def login_with_retry(login: int, password: str, server: str):
    """mt5.login() with one retry on a transient IPC-layer failure (error
    code <= -10000, e.g. IPC timeout). A real credential rejection (e.g.
    -6, RES_E_AUTH_FAILED) is returned as-is with no retry."""
    if mt5.login(login, password=password, server=server):
        return True, None
    error_code, error_detail = mt5.last_error()
    if error_code > -10000:
        return False, (error_code, error_detail)

    time.sleep(LOGIN_IPC_RETRY_DELAY_SECONDS)
    if mt5.login(login, password=password, server=server):
        return True, None
    return False, mt5.last_error()


def process_connection(conn: dict):
    connection_id = conn["id"]
    login = int(conn["broker_account_id"])
    server = conn["mt5_server"]
    is_backfilling = conn.get("backfill_completed_at") is None

    credential = fetch_credential(connection_id)
    if not credential:
        # A connection sitting in a due status (connecting/connected/syncing/
        # error) with no credential row is a data-integrity gap, not a normal
        # transient failure — most likely a disconnect/reconnect that didn't
        # fully complete. Surface it instead of silently no-op'ing forever.
        print(f"[{connection_id}] skipped: no credential row for a connection in status '{conn.get('status')}'", file=sys.stderr)
        return
    investor_password = decrypt_credential(credential["encrypted_access_token"])

    update_connection(connection_id, {"status": "syncing"})

    # mt5.initialize()/shutdown() bracket the whole batch (see run_once) —
    # login() alone is what switches the active account within that one
    # session. Cycling a full initialize()/shutdown() per account was tried
    # first and made mt5.initialize() itself start failing with IPC timeouts
    # partway through a batch on this terminal build; login() switching
    # accounts within one session is the documented multi-account pattern
    # and doesn't hit that.
    authorized, login_err = login_with_retry(login, investor_password, server)
    if not authorized:
        # Capture the error before it can be overwritten by the next
        # account's login() — it previously came back as a stale "Success"
        # instead of the real login failure reason when read too late.
        error_code, error_detail = login_err
        login_error = f"({error_code}, {error_detail!r})"
        # Codes at/below -10000 are MT5's internal/IPC-layer failures
        # (timeout, send/receive, connect) — transient API flakiness, not a
        # real credential rejection (that's -6, RES_E_AUTH_FAILED). Parking
        # those as needs_reauth was actively harmful: needs_reauth is
        # excluded from fetch_due_connections, so a single flaky IPC call
        # permanently stranded an otherwise-fine connection until the trader
        # manually reconnected. Only genuine auth rejections go there now.
        if error_code <= -10000:
            update_connection(connection_id, {"status": "error"})
            record_event(connection_id, "sync_failed", {"message": f"login failed: {login_error}"})
        else:
            update_connection(connection_id, {"status": "needs_reauth"})
            record_event(connection_id, "reauth_required", {"mt5_error": login_error})
        return

    job_id = insert_sync_job(connection_id, "backfill" if is_backfilling else "incremental")
    now = datetime.now(timezone.utc)

    if is_backfilling:
        cursor = conn.get("backfill_cursor")
        to_ts = datetime.fromisoformat(cursor) if cursor else now
        from_ts = to_ts - timedelta(days=BACKFILL_WINDOW_DAYS)
    else:
        last_synced = conn.get("last_synced_at")
        from_ts = datetime.fromisoformat(last_synced) if last_synced else now - timedelta(days=BACKFILL_WINDOW_DAYS)
        to_ts = now

    # mt5.history_deals_get() silently returns zero results for any window
    # whose `to` boundary is at or barely past the true current time — an
    # undocumented quirk confirmed by direct testing (a `to` more than
    # ~1 day in the future reliably works; "now" or +30min reliably
    # doesn't). It also expects naive datetimes, not UTC-aware ones.
    # Padding `to` into the future is always safe — there's no real data
    # beyond "now" regardless of how far the query boundary extends.
    query_from = from_ts.astimezone().replace(tzinfo=None)
    query_to = (to_ts + timedelta(days=2)).astimezone().replace(tzinfo=None)
    deals = mt5.history_deals_get(query_from, query_to)

    if deals is None:
        deals = []
    trade_deals = [d for d in deals if d.type in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)]
    trades = map_deals_to_raw_trades(trade_deals, connection_id)

    trades_new = 0
    if trades:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/raw_trades",
            headers={**HEADERS, "Prefer": "resolution=ignore-duplicates,return=representation"},
            params={"on_conflict": "dedup_hash"},
            data=json.dumps(trades, default=str),
            timeout=30,
        )
        if resp.ok:
            trades_new = len(resp.json())

    patch = {
        "status": "connected",
        "last_synced_at": now.isoformat(),
        "next_sync_at": (now + timedelta(minutes=5)).isoformat(),
    }
    if is_backfilling:
        if (now - from_ts).days >= BACKFILL_WINDOW_DAYS:
            patch["backfill_completed_at"] = now.isoformat()
        else:
            patch["backfill_cursor"] = from_ts.isoformat()
    update_connection(connection_id, patch)

    finish_sync_job(job_id, "completed", len(trade_deals), trades_new)
    print(f"[{connection_id}] synced: {len(trade_deals)} deals fetched, {trades_new} new trades")


def run_once():
    connections = fetch_due_connections()
    if not connections:
        return

    if not mt5.initialize():
        init_error = str(mt5.last_error())
        for conn in connections:
            update_connection(conn["id"], {"status": "error"})
            record_event(conn["id"], "sync_failed", {"message": f"initialize failed: {init_error}"})
        return

    try:
        for conn in connections:
            try:
                process_connection(conn)
            except Exception as exc:  # noqa: BLE001 - one bad connection must not kill the loop
                print(f"[{conn.get('id')}] error: {exc}", file=sys.stderr)
                try:
                    update_connection(conn["id"], {"status": "error"})
                    record_event(conn["id"], "sync_failed", {"message": str(exc)})
                except Exception:
                    pass
            time.sleep(LOGIN_PACING_SECONDS)
    finally:
        mt5.shutdown()


def main():
    print(f"MT5 bridge started. Polling every {POLL_INTERVAL_SECONDS}s.")
    while True:
        try:
            run_once()
        except Exception as exc:  # noqa: BLE001 - keep the loop alive across transient errors
            print(f"loop error: {exc}", file=sys.stderr)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
