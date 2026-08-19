import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function TradesPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/sign-up?mode=signin");
  }

  // RLS scopes this to the signed-in user's own trades automatically (via
  // the connection_id -> broker_connections.user_id chain) — no manual
  // filter needed here.
  const { data: trades } = await supabase
    .from("raw_trades")
    .select("id, symbol, side, volume, open_time, close_time, open_price, close_price, fees, swap, source")
    .order("close_time", { ascending: false });

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
      <div style={{ width: "100%", maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>Imported trades</h1>
          <Link href="/broker" style={{ fontSize: 13, color: "var(--fg-3)" }}>
            ← Broker connections
          </Link>
        </div>
        <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: "19px", marginBottom: 24 }}>
          Raw facts as imported from your broker — no journaling, tagging, or P&amp;L scoring yet.
          That's a separate, not-yet-built part of the app.
        </p>

        {!trades || trades.length === 0 ? (
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No trades imported yet</div>
            <div style={{ fontSize: 13, color: "var(--fg-3)" }}>
              Once a connected broker account syncs, closed trades will show up here.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-1)", color: "var(--fg-3)", textAlign: "left" }}>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Symbol</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Side</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Volume</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Opened</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Closed</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Open price</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Close price</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Fees</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Swap</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid var(--border-1)" }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{t.symbol}</td>
                    <td style={{ padding: "8px 10px", textTransform: "capitalize" }}>{t.side}</td>
                    <td style={{ padding: "8px 10px" }}>{t.volume}</td>
                    <td style={{ padding: "8px 10px", color: "var(--fg-3)" }}>{formatTime(t.open_time)}</td>
                    <td style={{ padding: "8px 10px", color: "var(--fg-3)" }}>{formatTime(t.close_time)}</td>
                    <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)" }}>{t.open_price}</td>
                    <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono)" }}>{t.close_price}</td>
                    <td style={{ padding: "8px 10px", color: "var(--fg-3)" }}>{t.fees}</td>
                    <td style={{ padding: "8px 10px", color: "var(--fg-3)" }}>{t.swap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
