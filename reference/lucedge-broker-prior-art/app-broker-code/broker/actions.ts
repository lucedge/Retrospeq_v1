"use server";

import crypto from "node:crypto";
import { after } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { encryptCredential } from "@/lib/crypto/credentials";
import { buildAuthorizeUrl } from "@/lib/broker/ctrader/oauth";
import { setPendingConnectState, readAndClearPendingAccounts } from "@/lib/broker/ctrader/oauthState";
import { recordConnectionEvent } from "@/lib/broker/events";
import { runSyncTick } from "@/lib/broker/sync";
import { track } from "@/lib/analytics";

const SYNC_NOW_COOLDOWN_MS = 2 * 60 * 1000;

export async function connectCtraderInitiateAction(): Promise<{ error: string } | { authorizeUrl: string }> {
  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "You need to be signed in." };
  }

  const state = crypto.randomBytes(24).toString("hex");
  await setPendingConnectState(state);

  track(userData.user.id, { event: "broker_connect_initiated", properties: { broker: "ctrader" } });

  return { authorizeUrl: buildAuthorizeUrl(state) };
}

/**
 * MT5 beta-only connect path. No OAuth — MT5 has no equivalent, so this
 * stores the investor password directly (encrypted) and the connection
 * starts as "connecting". Unlike cTrader, the deployed app can't itself
 * verify these credentials (no MT5 terminal access from Vercel) — the
 * local bridge script running on a developer machine is what actually
 * attempts login and flips status to connected/error. See
 * docs/M2_MT5_Beta_Bridge.md.
 */
export async function connectMt5Action(params: {
  login: string;
  investorPassword: string;
  server: string;
  accountType: "live" | "demo" | "prop_firm";
  label: string;
}): Promise<{ error: string } | { success: true }> {
  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "You need to be signed in." };
  }
  if (!params.login.trim() || !params.investorPassword || !params.server.trim()) {
    return { error: "Login, investor password, and server are all required." };
  }

  const admin = getAdminSupabase();
  const { data: connection, error } = await admin
    .from("broker_connections")
    .upsert(
      {
        user_id: userData.user.id,
        broker: "mt5",
        account_type: params.accountType,
        broker_account_id: params.login.trim(),
        broker_login: params.login.trim(),
        mt5_server: params.server.trim(),
        display_label: params.label || `MT5 ${params.login.trim()}`,
        status: "connecting",
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        backfill_completed_at: null,
        backfill_cursor: null,
        next_sync_at: null,
      },
      { onConflict: "user_id,broker,broker_account_id" },
    )
    .select("id")
    .single();

  if (error || !connection) {
    console.error("connectMt5Action: failed to upsert broker_connections", error);
    return { error: "Couldn't save this connection. Please try again." };
  }

  // MT5's investor password has no refresh cycle, unlike cTrader's OAuth
  // tokens — encrypted_refresh_token stays an encrypted empty string (not
  // used) purely to satisfy the not-null column without a schema change.
  const { error: credentialError } = await admin.from("broker_credentials").upsert(
    {
      connection_id: connection.id,
      encrypted_access_token: encryptCredential(params.investorPassword),
      encrypted_refresh_token: encryptCredential(""),
      token_expires_at: null,
    },
    { onConflict: "connection_id" },
  );
  if (credentialError) {
    console.error("connectMt5Action: failed to upsert broker_credentials", credentialError);
    return { error: "Couldn't save this connection. Please try again." };
  }

  await recordConnectionEvent({ connectionId: connection.id, eventType: "connected" });
  track(userData.user.id, { event: "broker_connect_succeeded", properties: { broker: "mt5", connection_count: 1 } });

  return { success: true };
}

export async function confirmCtraderConnectionAction(
  selections: { ctidTraderAccountId: string; accountType: "live" | "demo" | "prop_firm"; label: string }[],
): Promise<{ error: string } | { success: true }> {
  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "You need to be signed in." };
  }
  if (selections.length === 0) {
    return { error: "Pick at least one account to connect." };
  }

  const pending = await readAndClearPendingAccounts();
  if (!pending) {
    return { error: "This connection attempt expired. Please try connecting again." };
  }

  const byId = new Map(pending.accounts.map((a) => [a.ctidTraderAccountId, a]));
  const admin = getAdminSupabase();
  const oauthGrantId = crypto.randomUUID();
  const newConnectionIds: string[] = [];

  for (const selection of selections) {
    const account = byId.get(selection.ctidTraderAccountId);
    if (!account) continue;

    // Upsert, not insert: a trader reconnecting an account they previously
    // disconnected hits the same (user_id, broker, broker_account_id) row
    // (disconnect keeps the row so its trade history stays attached) — a
    // plain insert would silently fail the unique constraint here. Backfill
    // state resets on reconnect since this is a fresh connection from the
    // trader's perspective; dedup_hash makes re-importing already-seen
    // trades a safe no-op regardless.
    const { data: connection, error } = await admin
      .from("broker_connections")
      .upsert(
        {
          user_id: userData.user.id,
          broker: "ctrader",
          account_type: selection.accountType,
          broker_account_id: account.ctidTraderAccountId,
          broker_login: account.traderLogin || null,
          oauth_grant_id: oauthGrantId,
          display_label: selection.label || `cTrader ${account.traderLogin || account.ctidTraderAccountId}`,
          status: "connected",
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          backfill_completed_at: null,
          backfill_cursor: null,
          next_sync_at: null,
        },
        { onConflict: "user_id,broker,broker_account_id" },
      )
      .select("id")
      .single();

    if (error || !connection) {
      console.error("confirmCtraderConnectionAction: failed to upsert broker_connections", error);
      continue;
    }

    const { error: credentialError } = await admin.from("broker_credentials").upsert(
      {
        connection_id: connection.id,
        encrypted_access_token: encryptCredential(pending.accessToken),
        encrypted_refresh_token: encryptCredential(pending.refreshToken),
        token_expires_at: pending.expiresAt,
      },
      { onConflict: "connection_id" },
    );
    if (credentialError) {
      console.error("confirmCtraderConnectionAction: failed to upsert broker_credentials", credentialError);
      continue;
    }

    await recordConnectionEvent({ connectionId: connection.id, eventType: "connected" });
    newConnectionIds.push(connection.id);
  }

  if (newConnectionIds.length === 0) {
    return { error: "Couldn't connect those accounts. Please try again." };
  }

  track(userData.user.id, {
    event: "broker_connect_succeeded",
    properties: { broker: "ctrader", connection_count: newConnectionIds.length },
  });
  for (const id of newConnectionIds) {
    track(userData.user.id, { event: "broker_connection_confirmed", properties: { connection_id: id, broker: "ctrader" } });
  }

  // Kick off backfill after the response is sent, so this confirm request
  // never blocks on it (spec §4.2 — backfill must never block the UI).
  after(async () => {
    for (const id of newConnectionIds) {
      track(userData.user!.id, { event: "broker_backfill_started", properties: { connection_id: id } });
      await recordConnectionEvent({ connectionId: id, eventType: "backfill_started" });
      await runSyncTick(id, "backfill");
    }
  });

  return { success: true };
}

export async function disconnectConnectionAction(connectionId: string): Promise<{ error: string } | { success: true }> {
  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "You need to be signed in." };
  }

  const admin = getAdminSupabase();
  const { data: connection } = await admin
    .from("broker_connections")
    .select("id, user_id")
    .eq("id", connectionId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!connection) {
    return { error: "Connection not found." };
  }

  // Deleted, not deactivated — a stored token for an account the trader no
  // longer wants connected is pure liability (spec §8/§13).
  await admin.from("broker_credentials").delete().eq("connection_id", connectionId);
  await admin
    .from("broker_connections")
    .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
    .eq("id", connectionId);
  await recordConnectionEvent({ connectionId, eventType: "disconnected" });

  track(userData.user.id, { event: "broker_disconnected", properties: { connection_id: connectionId } });

  return { success: true };
}

export async function syncNowAction(connectionId: string): Promise<{ error: string } | { success: true }> {
  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "You need to be signed in." };
  }

  const admin = getAdminSupabase();
  const { data: connection } = await admin
    .from("broker_connections")
    .select("id, status")
    .eq("id", connectionId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!connection) {
    return { error: "Connection not found." };
  }
  if (connection.status === "disconnected") {
    return { error: "This connection has been disconnected." };
  }
  if (connection.status === "syncing") {
    return { error: "A sync is already running for this account." };
  }

  const { data: recentJob } = await admin
    .from("sync_jobs")
    .select("started_at")
    .eq("connection_id", connectionId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentJob && Date.now() - new Date(recentJob.started_at).getTime() < SYNC_NOW_COOLDOWN_MS) {
    return { error: "Please wait a moment before syncing again." };
  }

  const result = await runSyncTick(connectionId, "manual");
  if (result.status === "needs_reauth") {
    return { error: "Access expired. Reconnect to keep your trades syncing." };
  }
  if (result.status === "failed") {
    return { error: "Sync has been failing. We'll keep trying — you can also try now." };
  }

  return { success: true };
}
