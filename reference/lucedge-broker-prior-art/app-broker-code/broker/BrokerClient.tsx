"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  connectCtraderInitiateAction,
  disconnectConnectionAction,
  syncNowAction,
} from "@/app/broker/actions";
import { Spinner } from "@/components/auth/icons";

type Connection = {
  id: string;
  broker: string;
  account_type: string;
  broker_login: string | null;
  display_label: string;
  status: string;
  last_synced_at: string | null;
  backfill_completed_at: string | null;
  connected_at: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  syncing: "Syncing…",
  needs_reauth: "Needs reconnect",
  error: "Sync error",
  disconnected: "Disconnected",
};

const STATUS_COLOR: Record<string, string> = {
  connecting: "var(--pat-watch)",
  connected: "var(--win)",
  syncing: "var(--brand-blue)",
  needs_reauth: "var(--pat-watch)",
  error: "var(--loss)",
  disconnected: "var(--fg-4)",
};

function formatRelative(iso: string | null) {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });
}

export function BrokerClient({ connections }: { connections: Connection[] }) {
  const [pending, startTransition] = useTransition();
  const [connectError, setConnectError] = useState("");

  const handleConnect = () => {
    setConnectError("");
    startTransition(async () => {
      const result = await connectCtraderInitiateAction();
      if ("error" in result) {
        setConnectError(result.error);
        return;
      }
      window.location.href = result.authorizeUrl;
    });
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        justifyContent: "center",
        padding: "48px 24px",
        background: "var(--surface-0)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>Broker connections</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/broker/connect/mt5" className="btn-secondary">
              Connect MT5 (beta)
            </Link>
            <button
              className="btn-primary"
              onClick={handleConnect}
              disabled={pending}
            >
              {pending && <Spinner />}
              {pending ? "Connecting…" : "Connect cTrader"}
            </button>
          </div>
        </div>

        {connectError && (
          <div style={{ marginBottom: 18, fontSize: 13, color: "var(--loss)" }}>{connectError}</div>
        )}

        {connections.length === 0 ? (
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)", marginBottom: 6 }}>
              No accounts connected yet
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: "19px" }}>
              Connect a broker account and your trades capture themselves — no more copying numbers
              into a spreadsheet after every session.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {connections.map((c) => (
              <ConnectionCard key={c.id} connection={c} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [status, setStatus] = useState(connection.status);

  const syncNow = () => {
    setError("");
    startTransition(async () => {
      const result = await syncNowAction(connection.id);
      if ("error" in result) {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError("");
    startTransition(async () => {
      const result = await disconnectConnectionAction(connection.id);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setStatus("disconnected");
      setConfirmingDisconnect(false);
    });
  };

  const backfilling = status === "connected" && !connection.backfill_completed_at;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{connection.display_label}</div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
            {connection.broker === "ctrader" ? "cTrader" : connection.broker === "mt5" ? "MT5" : connection.broker}
            {connection.broker_login ? ` · ${connection.broker_login}` : ""} ·{" "}
            {connection.account_type === "prop_firm" ? "Prop firm" : connection.account_type === "demo" ? "Demo" : "Live"}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: STATUS_COLOR[status] ?? "var(--fg-3)",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: STATUS_COLOR[status] ?? "var(--fg-4)",
              flexShrink: 0,
            }}
          />
          {STATUS_LABEL[status] ?? status}
        </div>
      </div>

      {backfilling && (
        <div className="mock-banner" style={{ marginTop: 14, marginBottom: 0 }}>
          <div className="ring" />
          <div>
            <div className="b1">Importing your trade history</div>
            <div className="b2">This can take a few minutes for large accounts.</div>
          </div>
        </div>
      )}

      {status !== "disconnected" && (
        <div style={{ marginTop: 14, fontSize: 12, color: "var(--fg-3)" }}>
          Last synced: {formatRelative(connection.last_synced_at)}
        </div>
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--loss)" }}>{error}</div>}

      {status !== "disconnected" && (
        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
          {!confirmingDisconnect ? (
            <>
              <button className="btn-secondary" onClick={syncNow} disabled={pending || status === "syncing"}>
                {(pending || status === "syncing") && <Spinner />}
                {status === "syncing" ? "Syncing…" : "Sync now"}
              </button>
              <button
                className="btn-secondary"
                onClick={() => setConfirmingDisconnect(true)}
                disabled={pending}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: "var(--fg-3)", alignSelf: "center" }}>
                Remove this connection? Your imported trades stay in your journal.
              </span>
              <button className="btn-secondary" onClick={disconnect} disabled={pending}>
                {pending && <Spinner />}
                Confirm
              </button>
              <button
                className="btn-secondary"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={pending}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
