"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { connectMt5Action } from "@/app/broker/actions";
import { inputSx } from "@/lib/auth/inputSx";
import { Spinner } from "@/components/auth/icons";

export function Mt5ConnectClient() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [investorPassword, setInvestorPassword] = useState("");
  const [server, setServer] = useState("");
  const [label, setLabel] = useState("");
  const [accountType, setAccountType] = useState<"live" | "demo" | "prop_firm">("demo");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = login.trim() && investorPassword && server.trim();

  const submit = async () => {
    setLoading(true);
    setError("");
    const result = await connectMt5Action({
      login: login.trim(),
      investorPassword,
      server: server.trim(),
      accountType,
      label: label.trim(),
    });
    setLoading(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    router.refresh();
    router.push("/broker");
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
      <div style={{ width: "100%", maxWidth: 420 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", marginBottom: 8 }}>
          Connect MT5 (beta)
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: "19px", marginBottom: 6 }}>
          Use your <strong>investor (read-only) password</strong> — never your trading password.
          It can only read your history, never place or change trades.
        </p>
        <p style={{ fontSize: 12, color: "var(--pat-watch)", lineHeight: "18px", marginBottom: 24 }}>
          Beta notice: this connection is processed on a developer's local machine for testing,
          not production infrastructure. Only use a demo or low-value account for now.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--fg-3)", display: "block", marginBottom: 6 }}>
              Login (account number)
            </label>
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="12345678" style={inputSx()} />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--fg-3)", display: "block", marginBottom: 6 }}>
              Investor password
            </label>
            <input
              type="password"
              value={investorPassword}
              onChange={(e) => setInvestorPassword(e.target.value)}
              style={inputSx()}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--fg-3)", display: "block", marginBottom: 6 }}>Server</label>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="e.g. MetaQuotes-Demo"
              style={inputSx()}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--fg-3)", display: "block", marginBottom: 6 }}>
              Label (optional)
            </label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My MT5 demo" style={inputSx()} />
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {(["live", "demo", "prop_firm"] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={`chip ${accountType === type ? "on" : ""}`}
                onClick={() => setAccountType(type)}
              >
                {type === "prop_firm" ? "Prop firm" : type === "live" ? "Live" : "Demo"}
              </button>
            ))}
          </div>
        </div>

        {error && <div style={{ marginTop: 14, fontSize: 12, color: "var(--loss)" }}>{error}</div>}

        <button
          className="btn-primary"
          onClick={submit}
          disabled={loading || !canSubmit}
          style={{ marginTop: 20, width: "100%", height: 44, justifyContent: "center" }}
        >
          {loading && <Spinner />}
          {loading ? "Saving…" : "Connect"}
        </button>
      </div>
    </main>
  );
}
