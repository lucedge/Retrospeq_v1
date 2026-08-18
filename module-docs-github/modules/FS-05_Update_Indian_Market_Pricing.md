# FS-05 Update Note — Equity Market Pricing (India + US/Global)

> Append this to the existing **FS-05 — Broker API Integration** section in `Future_Scope.md`. It captures why both equity markets are deferred from the Module 2 delayed-price-anchor feature: neither has a free, redistribution-cleared source.

---

### FS-05.1 — Indian Market Data (NSE/BSE/MCX) Pricing

**Surfaced by:** Module 2 Addendum — Delayed Price Anchor.

**Two independent blockers, either of which defers India on its own:**

1. **No service-level market-data key.** Indian broker APIs (Upstox, Zerodha Kite, Angel, etc.) are per-user-OAuth: market data is entitled to an individual logged-in account, not a central service key the backend can poll. There is no way to run one login and fan quotes out to all users.

2. **Exchange licensing prohibits redistribution.** NSE/BSE/MCX quote data is the exchanges' IP, licensed not owned. Caching it in our DB and serving it to users *is* redistribution, which requires a separate paid authorized-vendor agreement (e.g. TrueData, Global Datafeeds) plus exchange approval. Even delayed (15-min) and snapshot data fall under exchange-approved-interval rules.

**Regulatory direction:** SEBI's framework around API-based access is tightening, not loosening (e.g. static-IP mandate effective 1 Apr 2026). This raises the bar for any future Indian-data integration and argues against gray-area free routes (scraping NSE endpoints, Yahoo-Finance-backed wrappers) for a SEBI-adjacent product.

**Future path when India graduates from FS:** integrate either (a) a paid authorized data vendor with an explicit redistribution license, or (b) per-user broker OAuth where each user authorizes their own account and data is shown only to that user (no cross-user cache). Option (b) aligns with the original FS-05 broker-integration framing.

**Until then:** Indian equity/F&O entry/exit prices remain manual entry (Module 2) or CSV import (Module 5). The Module 2 price-anchor chip simply does not render for Indian instruments.

---

### FS-05.2 — US/Global Equity Pricing

**Surfaced by:** Module 2 Addendum — Delayed Price Anchor (same brainstorm).

**Blocker:** US equity market data is regulated by the exchanges, FINRA, and the SEC. Free-tier providers (Finnhub, Alpha Vantage, Twelve Data, etc.) permit *display* / personal / evaluation use, but **commercial redistribution to end users is gated behind paid plans**. Confirmed directly: Finnhub requires a paid plan for commercial licensing. The Module 2 cache-and-serve model ("ingest → our DB → serve per user") is redistribution, so the free tiers do not cover it.

Note this is the same *class* of blocker as NSE/BSE (exchange owns the data, redistribution is separately licensed), differing only in that US data has a legal *paid* path through these same vendors, whereas Indian data needs an authorized-vendor agreement plus exchange approval.

**Future path when US equities graduate from FS:** subscribe to a paid commercial-redistribution tier from one of the existing free-tier vendors (Finnhub paid, Twelve Data paid, etc.) once the user base justifies the cost. No per-user-OAuth complication here — a single paid commercial license covers the central cache.

**Until then:** US/global equity prices remain manual entry (Module 2) or CSV import (Module 5). The price-anchor chip does not render for equity instruments of any region.
