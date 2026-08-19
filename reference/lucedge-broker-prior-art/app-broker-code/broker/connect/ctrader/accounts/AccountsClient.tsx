"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmCtraderConnectionAction } from "@/app/broker/actions";
import { inputSx } from "@/lib/auth/inputSx";
import { Spinner } from "@/components/auth/icons";

type Account = { ctidTraderAccountId: string; traderLogin: string; isLive: boolean };

type Selection = { selected: boolean; accountType: "live" | "demo" | "prop_firm"; label: string };

export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [selections, setSelections] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(
      accounts.map((a) => [
        a.ctidTraderAccountId,
        {
          selected: true,
          accountType: a.isLive ? "live" : "demo",
          label: `cTrader ${a.traderLogin || a.ctidTraderAccountId}`,
        } as Selection,
      ]),
    ),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const update = (id: string, patch: Partial<Selection>) => {
    setSelections((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const selectedCount = Object.values(selections).filter((s) => s.selected).length;

  const submit = async () => {
    setLoading(true);
    setError("");
    const payload = Object.entries(selections)
      .filter(([, s]) => s.selected)
      .map(([ctidTraderAccountId, s]) => ({
        ctidTraderAccountId,
        accountType: s.accountType,
        label: s.label,
      }));
    const result = await confirmCtraderConnectionAction(payload);
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
      <div style={{ width: "100%", maxWidth: 480 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", marginBottom: 8 }}>
          Choose accounts to connect
        </h1>
        <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: "19px", marginBottom: 24 }}>
          We only ever read your trade history — nothing here can place, modify, or close a trade.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {accounts.map((account) => {
            const s = selections[account.ctidTraderAccountId];
            return (
              <div key={account.ctidTraderAccountId} className="card">
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={s.selected}
                    onChange={(e) => update(account.ctidTraderAccountId, { selected: e.target.checked })}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {account.traderLogin ? `Account ${account.traderLogin}` : "Account"}
                      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--fg-3)", fontWeight: 500 }}>
                        {account.isLive ? "Live" : "Demo"}
                      </span>
                    </div>

                    {s.selected && (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <input
                          value={s.label}
                          onChange={(e) => update(account.ctidTraderAccountId, { label: e.target.value })}
                          placeholder="Label"
                          style={inputSx()}
                        />
                        <div style={{ display: "flex", gap: 6 }}>
                          {(["live", "demo", "prop_firm"] as const).map((type) => (
                            <button
                              key={type}
                              type="button"
                              className={`chip ${s.accountType === type ? "on" : ""}`}
                              onClick={() => update(account.ctidTraderAccountId, { accountType: type })}
                            >
                              {type === "prop_firm" ? "Prop firm" : type === "live" ? "Live" : "Demo"}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            );
          })}
        </div>

        {error && <div style={{ marginTop: 14, fontSize: 12, color: "var(--loss)" }}>{error}</div>}

        <button
          className="btn-primary"
          onClick={submit}
          disabled={loading || selectedCount === 0}
          style={{ marginTop: 20, width: "100%", height: 44, justifyContent: "center" }}
        >
          {loading && <Spinner />}
          {loading ? "Connecting…" : `Connect ${selectedCount || ""} account${selectedCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </main>
  );
}
