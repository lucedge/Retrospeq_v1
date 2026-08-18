# Module 21 — Education: Pattern Library & Glossary

## 1. Module Summary

Module 21 is LuceEdge's editorial / educational layer — two co-located content surfaces (a Pattern Library of in-depth pages on each of the 8 V1 behavioral patterns, and a Glossary of every trading and product term used in the app) that share a single `/learn/*` route prefix, IA, and SEO infrastructure. The module exists for two distinct audiences served from the same content. **Audience one** is the open web: prospective users searching "what is a revenge trading spiral" or "what is R-multiple" land on a clean, indexable, statically-rendered page that explains the concept honestly, cites academic research, and ends with a soft CTA to start free at LuceEdge. This is the primary organic-acquisition surface for V1 — the Pattern Library pages are explicitly built as SEO assets and double as the canonical educational reference for journalists, prop-firm desks, and casual readers who may never sign up. **Audience two** is the logged-in user: the same Library and Glossary pages, when accessed from inside the app, are enhanced with a personalization overlay ("You've triggered Revenge Spiral 14 times this quarter; here are your last 3 occurrences") and link laterally into the in-app Patterns tab (Module 9), Settings → Help, and any module that uses a glossary term. The educational text underneath is identical across both audiences; only the personalization overlay is gated. Critically, **all 8 pattern pages — including the 5 patterns that are Pro-only inside the app — are fully public on the web**. The public pages are marketing/SEO assets, not gated content. The Pro tier is what unlocks the *personalized* in-app overlay on the 5 Pro patterns; the educational article itself stays open. This split is deliberate: gating the Library content would tank SEO and contradict the V1 doc's stance that paywalls live in 4 specific surfaces only (Module 16). Success is measured by *organic search traffic to /learn/\* pages* (the SEO funnel), *signup conversion from public-Library footer CTA* (the marketing funnel into Module 1), *in-app Library entry rate from Patterns tab "Learn more" link* (the education-loop engagement), and *glossary tooltip open rate* (a proxy for term-clarity in the rest of the product). The module reads from `pattern_definitions` (Module 6 / Module 9), `user_pattern_aggregates` (Module 6, only for the personalization overlay when logged-in), and the file-based content store at `/content/patterns/*.md` and `/content/glossary/*.md`. It writes nothing — content is editorially authored and version-controlled, not user-generated.

---

## 2. User Stories

### 2.1 Public Pattern Library (Unauthenticated Web)

#### As a prospective trader searching "what is revenge trading", I want to land on a clean, fast-loading public page that explains the pattern in plain English with research citations, so that I trust the source and read the whole thing.
#### As a journalist or analyst researching behavioral trading, I want each pattern page to cite the underlying academic anchor (e.g., Thaler & Johnson 1990) and link to the LuceEdge research PDF, so that I can verify the claims.
#### As a prospective trader reading a public pattern page, I want a soft "detect this in your own trades — start free" CTA in the footer, not a popup or signup wall, so that the read isn't interrupted.
#### As any web visitor, I want all 8 patterns publicly readable (including the 5 that are Pro-only inside the app), so that the educational value is open and the SEO surface is complete.
#### As a search engine crawler, I want each pattern page to expose a `<title>`, meta description, OpenGraph tags, JSON-LD article schema, and a canonical URL, so that the page indexes and shares cleanly.
#### As a web visitor on mobile, I want each Library page to be readable in a single column with comfortable line-length and dark-mode default, so that it feels editorial, not app-y.

### 2.2 Public Glossary (Unauthenticated Web)

#### As a prospective trader searching "what is R-multiple", I want a public Glossary page with a 2–3 sentence definition, the formula, a simple example, and related terms, so that I get an unambiguous answer.
#### As any web visitor, I want every Glossary term page to link to "How LuceEdge uses this" so that I see the term grounded in product context, so that I understand what the product does with it.
#### As any web visitor, I want a Glossary index page at `/learn/glossary` listing all terms alphabetically, so that I can browse the full vocabulary.

### 2.3 In-App Pattern Library (Logged-In)

#### As a logged-in user tapping "Learn more" on a Pattern card in the Patterns tab (Module 9), I want to land on the same Library page the public sees, but with a "Your data" overlay at the top, so that the educational content and my personal data co-exist on one screen.
#### As a logged-in Free user viewing the in-app Library page for one of my 3 free patterns (Revenge Spiral, Hold-Time Asymmetry, Off-Playbook Entry), I want my personalization overlay (count, P&L impact, last 3 occurrences) shown above the educational article, so that I see the pattern in my own data.
#### As a logged-in Free user viewing the in-app Library page for any of the 5 Pro patterns (Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell, Theta Gambler), I want the educational article fully visible, but the personalization overlay shown as a Pro lock badge → "Upgrade to see your data on this pattern" linking to Settings → Subscription, so that the article is never gated and the upsell follows Module 16's locked-pattern conventions.
#### As a logged-in Pro user viewing any in-app Library page, I want the personalization overlay fully populated for all 8 patterns, so that the surface is fully functional.
#### As a logged-in user, I want the Library page to deep-link back to the in-app Patterns tab via "Open in Patterns tab" link, so that I can pivot to the interactive overview after reading.

### 2.4 In-App Glossary (Logged-In)

#### As a logged-in user encountering an unfamiliar term anywhere in the app (e.g., "R-multiple" in a stat card), I want to tap a "?" icon next to the term to see a tooltip with the 2–3 sentence definition and a "Learn more" link, so that I clarify without leaving the screen.
#### As a logged-in user tapping "Learn more" in a glossary tooltip, I want to navigate to the full Glossary page at `/learn/glossary/<slug>`, so that I get the formula, example, and related terms.
#### As a logged-in user, I want a Glossary index accessible from Settings → Help → Glossary, so that I have an entry point even when I'm not next to a "?" icon.

### 2.5 Cross-Linking & Related Content

#### As any reader (public or in-app), I want each Pattern page to list 1–3 related patterns at the bottom, so that I can explore adjacent behavioral concepts.
#### As any reader, I want each Glossary page to list 2–4 related terms, so that I can build vocabulary along a topic.
#### As any reader, I want inline glossary terms inside Pattern Library articles to be auto-linked to their Glossary page, so that I can pivot from "the article uses 'expectancy'" to the Glossary definition in one tap.

### 2.6 Content Authoring & Updates

#### As an editor (LuceEdge content owner), I want each Pattern Library page sourced from a markdown file at `/content/patterns/<slug>.md` with frontmatter (title, slug, tier_in_app, related_patterns, academic_anchor_citation, luce_edge_pdf_url, last_reviewed_at), so that content is editorially controlled and version-tracked in git.
#### As an editor, I want each Glossary term sourced from `/content/glossary/<slug>.md` with similar frontmatter (title, slug, related_terms, in_app_anchors, formula, example), so that I can add or revise terms with a pull request.
#### As an editor, I want a content-build step that regenerates the sitemap and OG images on each content commit, so that publishing is one-step.

### 2.7 Tier Variations

Public pages are identical for all visitors regardless of tier (or absence of an account). The personalization overlay on in-app pages varies by tier per Module 16's capability map (see Section 4).

### 2.8 Mobile vs. Desktop

#### As a mobile reader, I want Library and Glossary pages in a single column with max ~70-character line length, so that long-form reading is comfortable.
#### As a desktop reader, I want a max-width 720px reading column with optional left-rail TOC for the Pattern article, so that I can navigate within the page.

### 2.9 Edge Cases

#### As a logged-in user whose tier downgraded from Pro to Free between page visits, I want the Pro patterns' personalization overlay to revert to the locked Pro-badge state on next page load, so that the tier change is reflected.
#### As an unauthenticated visitor following a deep link `/learn/patterns/stop-removal?source=tweet`, I want to land directly on the article with no auth prompt, so that the SEO/social-share path is never broken by an interstitial.

---

## 3. Acceptance Criteria

### 3.1 Public Pattern Library — Routes & Rendering

- Given an unauthenticated visitor navigates to `/learn/patterns/<slug>` for any of the 8 V1 pattern slugs (revenge-spiral, stop-removal, hold-time-asymmetry, averaging-into-pain, sizing-discipline, off-playbook-entry, closing-bell-risk, theta-gambler), when the page is requested, then the server returns a fully-rendered HTML response (statically generated) within 200ms TTFB and within 1.5s LCP on a fast-3G connection.
- Given any public Pattern Library page, when rendered, then the page contains in order: (1) hero (pattern name + 1-line plain-English definition), (2) one-paragraph plain-English definition, (3) "Research backing" section with link to LuceEdge research PDF and 2–3 academic anchor citations, (4) "Examples" section with 2–3 anonymized illustrative narrative trades, (5) "Fix techniques" section with 4–6 concrete behavioral interventions, (6) "Common variations" section with sub-types, (7) "Related patterns" cross-link section with 1–3 patterns, (8) soft CTA footer "Detect this pattern in your own trades — start free at LuceEdge" linking to Module 1 onboarding (`/?source=learn_patterns_<slug>`).
- Given any public Pattern Library page, when the HTML is served, then the `<head>` contains: `<title>`, meta description, canonical URL, OpenGraph tags (og:title, og:description, og:image, og:url, og:type=article), Twitter card tags, and JSON-LD `Article` schema with author=LuceEdge, datePublished, dateModified.
- Given the page is requested by a search engine crawler (Googlebot, etc.), when served, then NO authentication or signup prompt is rendered; the page content is fully present in the initial HTML response.
- Given a Pattern Library page is requested for an unknown slug, when triggered, then a 404 page is returned (not a redirect to the Library index, to avoid soft-404 SEO penalty).

### 3.2 Public Pattern Library — Index Page

- Given an unauthenticated visitor navigates to `/learn/patterns`, when rendered, then a list of all 8 patterns is shown with name, 1-line definition, and link to the detail page.
- Given the index page, when rendered, then patterns are listed in a stable editorial order (not personalized — the same order for all visitors): Revenge Spiral, Hold-Time Asymmetry, Off-Playbook Entry, Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell Risk, Theta Gambler.

### 3.3 Public Pattern Library — Tier Independence

- Given any of the 5 Pro-in-app patterns (Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell, Theta Gambler), when their public page is requested by anyone (unauthenticated, Free, or Pro), then the full educational article is rendered identically — no lock badge, no paywall, no truncation.
- Given a Pro-in-app pattern's public page, when rendered for an unauthenticated visitor, then no Pro signaling appears anywhere in the article body. (A subtle "Pro feature in-app" note may appear next to the soft footer CTA — see OQ — but the article itself remains gate-free.)

### 3.4 Public Glossary — Routes & Rendering

- Given an unauthenticated visitor navigates to `/learn/glossary/<slug>`, when requested, then a statically-generated page returns within the same SLA as Pattern pages.
- Given any Glossary term page, when rendered, then it contains: (1) term title, (2) 2–3 sentence definition, (3) formula (if applicable; rendered in monospace or KaTeX), (4) simple example, (5) related terms (2–4 cross-links), (6) "How LuceEdge uses this" section linking to the relevant in-app feature/module.
- Given an unauthenticated visitor navigates to `/learn/glossary` (index), when rendered, then all 25–35 V1 terms are listed alphabetically with the term title and a 1-line preview.
- Given any Glossary page, when served, then the `<head>` contains the same SEO metadata package as Pattern pages (title, description, canonical, OG, JSON-LD `DefinedTerm` schema).

### 3.5 In-App Pattern Library — Personalization Overlay (Free, Free Pattern)

- Given a logged-in Free user navigates to `/learn/patterns/revenge-spiral`, `/learn/patterns/hold-time-asymmetry`, or `/learn/patterns/off-playbook-entry` (the 3 free patterns), when rendered, then a "Your data" overlay block appears above the public-article body containing: count last 30 days, P&L impact, last 3 triggered trades (each tappable to trade detail), trend arrow, and a "View in Patterns tab" link to Module 9.
- Given the same user has insufficient data (<30 trades or <3 triggers on the pattern), when rendered, then the overlay shows a graceful fallback ("Activates after 30 trades — X to go" or "No triggers yet — clean") instead of empty fields.

### 3.6 In-App Pattern Library — Personalization Overlay (Free, Pro Pattern)

- Given a logged-in Free user navigates to `/learn/patterns/stop-removal` or any of the 5 Pro patterns, when rendered, then the public educational article body is fully visible — no truncation.
- Given the same scenario, when rendered, then the personalization overlay block above the article is replaced by a Pro lock card containing: pattern name, Pro lock icon (matching Module 16 §6.1 visual standard), single line "Upgrade to see your data on this pattern", and an "Upgrade to Pro" button.
- Given the user taps the Upgrade button, when triggered, then they navigate to Settings → Subscription with `?source=learn_pattern_<slug>` per Module 16 §3.3 / Module 15 §3.5.
- Given the article body, when rendered, then it is identical to the unauthenticated public version (no extra Pro-tier-only paragraphs).

### 3.7 In-App Pattern Library — Personalization Overlay (Pro)

- Given a logged-in Pro user navigates to any of the 8 `/learn/patterns/<slug>` pages, when rendered, then the "Your data" overlay block is fully populated for all 8 patterns identical in structure to the Free-pattern case in 3.5.
- Given a Pro user with <4 weeks of data, when rendered on any pattern, then the overlay shows the same insufficient-data fallback used in 3.5, not a Pro-specific richer state. (Pro-only AI narrative is an in-app Patterns-tab feature — Module 9 — not duplicated on Library pages.)

### 3.8 In-App vs. Public Detection

- Given the page is requested with a valid session cookie (logged-in user), when rendered, then the personalization overlay is fetched from `user_pattern_aggregates` (Module 6) and rendered above the article via client-side hydration on top of the statically-generated article body.
- Given the page is requested without a valid session cookie, when rendered, then no personalization overlay appears and no fetch to user data is made (preserving SSG/CDN cacheability).
- Given the personalization fetch fails (network error), when triggered, then the page degrades gracefully — the public article is fully visible, and a small "Couldn't load your data — refresh to retry" notice appears in the overlay slot.

### 3.9 Public Glossary — In-App Tooltip Integration

- Given any in-app surface containing a glossary-registered term (e.g., "R-multiple" in a Trade Detail stat), when the term is followed by a "?" icon, then tapping the icon opens a tooltip popover with the 2–3 sentence definition and a "Learn more" link.
- Given the user taps "Learn more" in the tooltip, when triggered, then they navigate to `/learn/glossary/<slug>` (preserving session, so the in-app navbar/footer stays present).
- Given the tooltip is open, when the user taps outside it, then it dismisses.

### 3.10 Settings → Help → Glossary

- Given a logged-in user navigates to Settings → Help → Glossary (Module 15 §3.14 Help section), when triggered, then they navigate to `/learn/glossary` (the index).
- Given the user is on the in-app Glossary index, when they tap a term, then they navigate to that term's page.

### 3.11 Cross-Linking

- Given any Pattern Library article body contains an inline glossary term registered in `/content/glossary/`, when rendered, then the term is auto-wrapped in a link to `/learn/glossary/<slug>`.
- Given the "Related patterns" section of any Pattern page, when rendered, then 1–3 cross-links to other `/learn/patterns/<slug>` pages are shown.

### 3.12 Sitemap & SEO Infrastructure

- Given the content build runs (on commit to `/content/`), when complete, then `/sitemap.xml` is regenerated containing entries for: `/learn/patterns` (index), all 8 `/learn/patterns/<slug>`, `/learn/glossary` (index), and all `/learn/glossary/<slug>` pages, each with `<lastmod>` from the markdown frontmatter `last_reviewed_at`.
- Given the sitemap is served, when requested at `/sitemap.xml`, then it returns within 100ms with `Content-Type: application/xml`.
- Given any `/learn/*` page is requested, when served, then the `<link rel="canonical">` is the absolute URL `https://luceedge.com/learn/...` (no query strings, no trailing slash variants).

### 3.13 Performance & Caching

- Given any `/learn/*` page (Library or Glossary), when requested, then it is served from CDN cache with `Cache-Control: public, max-age=3600, s-maxage=86400` (1h browser, 24h edge), invalidated on content rebuild.
- Given a logged-in user requests a Library page, when served, then the static HTML is cached as above; the personalization overlay is fetched separately via authenticated API call (not cached at CDN).

### 3.14 Tier-Change Propagation on Library Pages

- Given a logged-in user upgrades Free → Pro, when they next navigate to a Pro-pattern Library page, then the Pro lock card is replaced by the populated "Your data" overlay (per Module 16 §3.7, 5s propagation tolerance).
- Given a Pro user downgrades to Free, when they next navigate to a Pro-pattern Library page, then the populated overlay is replaced by the Pro lock card.

---

## 4. Business Logic

### 4.1 Rendering Strategy: SSG + Client-Side Personalization

V1 chooses **Static Site Generation (SSG)** for the public Library and Glossary pages over Server-Side Rendering (SSR), for these reasons:

1. **Editorial cadence, not dynamic content.** Pattern and Glossary content changes on the order of days-to-weeks, not per-request. SSR's freshness-per-request cost is unjustified.
2. **CDN cacheability.** SSG output is fully cacheable at the edge (Vercel / Cloudflare / equivalent), giving sub-100ms TTFB globally — essential for SEO and conversion on cold-start visits.
3. **Zero auth surface on the public path.** SSG output contains no user-specific data, so it can be served from a public CDN without leakage risk.

The build pipeline:
1. Markdown files in `/content/patterns/*.md` and `/content/glossary/*.md` are read at build time.
2. Each file is parsed into HTML with frontmatter metadata; OG tags, JSON-LD, sitemap entries are computed.
3. Output: one static HTML file per route, plus a single sitemap.xml.
4. Build runs on every git commit to `/content/` via CI hook.

For logged-in users, **personalization is a client-side overlay** layered on top of the static page:
1. Static HTML loads (instant, from CDN).
2. On hydration, a single authenticated request to `GET /api/learn/patterns/<slug>/personalization` returns the overlay payload (count, P&L, last 3 trades, tier-status).
3. The overlay component renders into a reserved DOM slot above the article body.
4. If unauthenticated (no session cookie), the overlay slot stays empty and the request is never made.

This hybrid (SSG body + client overlay) gets us SEO + speed for the public path AND personalization for logged-in users without two render pipelines.

### 4.2 Locked-Overlay Rendering Rules (Pro Patterns, In-App)

When the personalization API returns for a logged-in user, its response includes a `tier_access` field per Module 16's capability map:

```
GET /api/learn/patterns/stop-removal/personalization
→ {
  "tier_access": "locked",  // user is Free, pattern is Pro
  "lock_reason": "pro_required",
  "upgrade_link": "/profile/subscription?source=learn_pattern_stop-removal",
  "pattern_name": "Stop Removal"
}
```

If `tier_access == "locked"`, the overlay component renders the Pro lock card (Module 16 §6.1 visual standard: lock icon, "Pro" label, single-CTA "Upgrade to Pro"). The article body below is unchanged.

If `tier_access == "unlocked"`, the API response includes the full overlay payload (`count_30d`, `pnl_impact_30d`, `last_3_trades`, `trend_arrow`, `status`).

The capability check is owned by Module 16's `can_user_access(user_id, "pattern:<slug>")`. Module 21 calls Module 16; Module 21 itself encodes no tier rules.

### 4.3 Pattern-to-Tier Mapping (Reference, Owned by Module 16)

| Pattern slug | Free in-app | Pro in-app | Public Library page |
|---|---|---|---|
| revenge-spiral | ✅ overlay | ✅ overlay | ✅ public |
| hold-time-asymmetry | ✅ overlay | ✅ overlay | ✅ public |
| off-playbook-entry | ✅ overlay | ✅ overlay | ✅ public |
| stop-removal | ❌ locked overlay | ✅ overlay | ✅ public |
| averaging-into-pain | ❌ locked overlay | ✅ overlay | ✅ public |
| sizing-discipline | ❌ locked overlay | ✅ overlay | ✅ public |
| closing-bell-risk | ❌ locked overlay | ✅ overlay | ✅ public |
| theta-gambler | ❌ locked overlay | ✅ overlay | ✅ public |

**Critical:** the "public Library page" column is uniformly ✅ for all 8. The article content does not change by tier. Only the overlay above the article changes.

### 4.4 Sitemap Generation

The build step produces `/sitemap.xml` containing:

```xml
<urlset>
  <url>
    <loc>https://luceedge.com/learn/patterns</loc>
    <lastmod>2026-05-05</lastmod>
    <changefreq>monthly</changefreq>
  </url>
  <!-- 8 pattern detail entries -->
  <!-- 1 glossary index entry -->
  <!-- ~25-35 glossary detail entries -->
</urlset>
```

`<lastmod>` is read from each markdown file's `last_reviewed_at` frontmatter field. `<changefreq>` is `monthly` for all `/learn/*` pages (editorial cadence).

The sitemap is served at `/sitemap.xml` and referenced from `/robots.txt`:

```
User-agent: *
Allow: /learn/
Sitemap: https://luceedge.com/sitemap.xml
```

`/robots.txt` allows `/learn/*` and disallows `/api/*`, `/profile/*`, `/today`, `/journal`, `/patterns`, `/strategies` (the in-app surfaces, which are session-gated and should not be indexed).

### 4.5 Canonical URL Handling

Every `/learn/*` page emits exactly one canonical URL:
- `https://luceedge.com/learn/patterns/<slug>` (no trailing slash, no query string, no fragment).
- Query parameters like `?source=` (used for analytics attribution) are ignored by canonical — they do not produce a different canonical.
- Lowercase only; the slug is enforced lowercase at routing.

This prevents SEO duplicate-content penalties when shared links carry attribution params.

### 4.6 OG Image Generation

Each `/learn/*` page emits an OG image at `https://luceedge.com/learn/og/<type>/<slug>.png` (1200×630 PNG). V1 strategy:
- Generate at content-build time (not at request time) using a static template: pattern title + LuceEdge logo + dark background.
- Same template for Library and Glossary; type-tag (Pattern / Glossary) shown in the corner.
- Stored as static assets, served from CDN.

OG image generation strategy is flagged in OQ — alternatives (per-request rendering via `@vercel/og`, manual hand-designed images per pattern) discussed there.

### 4.7 Content Build & Publish Flow

1. Editor edits/creates a markdown file in `/content/patterns/` or `/content/glossary/`.
2. Editor opens a PR; CI runs content lint (frontmatter schema validation, broken-link check, glossary-term-resolution check).
3. PR merged → CI rebuilds the site → static HTML, sitemap, OG images regenerate.
4. CDN edges purge the affected `/learn/*` paths.
5. New content live within ~5 minutes of merge.

### 4.8 Glossary Term Auto-Linking

At build time, a step scans every Pattern Library article body for token matches against the `glossary_terms` registry (term and known aliases). Matches are wrapped in `<a href="/learn/glossary/<slug>">term</a>`. Edge cases:
- Only the first occurrence per article is auto-linked (avoid link spam).
- Terms inside code blocks, headings, or pre-existing links are skipped.
- Editor can suppress auto-linking on a per-occurrence basis with a `{:no-glossary}` markdown attribute.

### 4.9 In-App Linkage Map

The Patterns tab (Module 9) "Learn more" link on each pattern card opens `/learn/patterns/<slug>` in the same session (in-app surface, navbar/footer preserved). The Settings → Help → Glossary entry (Module 15 §3.14) opens `/learn/glossary`. The "?" tooltip is a generic component used wherever a registered glossary term appears; its registry of which terms appear in which modules is `glossary_terms.in_app_anchors[]` (see §5).

---

## 5. Data Model Touches

### 5.1 Content Storage — File-Based Markdown

V1 stores Library and Glossary content as **markdown files in the repo** at:
- `/content/patterns/<slug>.md` (8 files for V1)
- `/content/glossary/<slug>.md` (~25–35 files for V1)

Rationale (vs. a `pattern_library_content` DB table):
1. **Editorial control.** Editors review content via PR. Git history = authoring history.
2. **Version control.** Reverting an edit = reverting a commit.
3. **No CMS dependency for V1.** A CMS adds infra surface; markdown-in-repo is enough at this volume.
4. **Build-time SSG works directly off the filesystem.** No DB-to-HTML render step.

When V2 needs non-engineer authoring (per OQ 9.4), a headless CMS can be layered on; for V1, engineers and the content owner work in markdown.

### 5.2 Pattern Markdown Frontmatter Schema

```yaml
---
title: "Revenge Spiral"
slug: revenge-spiral
short_description: "The behavioral pattern of escalating size and frequency after a loss to recover, leading to compounded loss."
tier_in_app: free  # free | pro
related_patterns: [off-playbook-entry, averaging-into-pain]
academic_anchors:
  - { citation: "Thaler & Johnson 1990 — Break-even effect", url: "https://doi.org/..." }
  - { citation: "Odean 1998 — Disposition effect", url: "https://doi.org/..." }
luce_edge_pdf_url: "https://luceedge.com/research/revenge-spiral.pdf"
last_reviewed_at: 2026-04-15
og_image: revenge-spiral.png
---
```

Body: markdown sections in a fixed order matching §3.1 (definition → research → examples → fix techniques → variations → related). Editor's lint enforces structure.

### 5.3 Glossary Markdown Frontmatter Schema

```yaml
---
title: "R-multiple"
slug: r-multiple
short_definition: "The size of a trade's outcome expressed in units of the initial risk."
formula: "R = (exit_price - entry_price) / (entry_price - stop_price)"
example: "If you risk ₹1,000 and earn ₹3,000, that's a +3R trade."
related_terms: [expectancy, risk, stop-loss, win-rate]
in_app_anchors:
  - module: trade_detail
    surface: stat_card
  - module: dashboard
    surface: r_distribution_chart
how_luceedge_uses_this: "/today (R-multiple distribution chart)"
last_reviewed_at: 2026-04-15
---
```

### 5.4 `glossary_terms` Registry (Build-Generated, In-Memory)

At build time, the content step produces a single in-memory / JSON registry consumed by:
1. The glossary tooltip component (which terms have a "?" icon attached in-app).
2. The auto-link step in §4.8.

```typescript
glossary_terms = [
  {
    slug: "r-multiple",
    title: "R-multiple",
    aliases: ["R", "R multiple"],
    short_definition: "The size of a trade's outcome expressed in units of the initial risk.",
    related_terms: ["expectancy", "risk", "stop-loss", "win-rate"],
    in_app_anchors: [
      { module: "trade_detail", surface: "stat_card" },
      { module: "dashboard",    surface: "r_distribution_chart" }
    ]
  },
  // ~25-35 more...
]
```

This registry is built at compile time and shipped as a static JSON asset to the client. No DB table backs it.

### 5.5 Initial V1 Glossary Term Inventory (Spec Target ~25–35)

Proposed V1 set (final inventory flagged in OQ 9.1):

**Trade-mechanics:** R-multiple, expectancy, win rate, hold time, drawdown, theta, planned trigger price, planned stop loss, planned target, position size.
**Behavioral / patterns:** pattern, conviction, plan-following, revenge trade, off-playbook entry.
**Product surfaces:** soft block, hard block, gate, streak, session (open/mid/close), strategy, scorecard.
**Outcome / stats:** P&L, net P&L, gross P&L, fees & slippage, average loss, average win.

Total: ~30 terms for V1. Final list owned by content team.

### 5.6 Fields Read

From `pattern_definitions` (Module 6/9): name, slug, tier — used to validate that markdown `tier_in_app` matches the source-of-truth.
From `user_pattern_aggregates` (Module 6, in-app overlay only): count_30d, pnl_impact_30d, last_3_trades, trend_arrow, status.
From `users` (Module 16's tier-check API): effective tier — used to gate the overlay.
From `trade_pattern_tags` (Module 6): for the "last 3 trades" links in the overlay.

### 5.7 Fields Written

This module writes nothing. All data is read-only relative to the rest of the app.

### 5.8 New Tables

None. The only "new persistence" is the build-time content registry (markdown files in git).

---

## 6. Interaction & UX Requirements

### 6.1 Public Page Layout — Editorial, Mobile-First, Dark Mode

Public Library and Glossary pages adopt a **clean editorial** layout distinct from the in-app product chrome:
- Top: minimal LuceEdge wordmark logo (left) + "Sign in" link + "Start free" button (right). No app navbar, no tabs — this is a marketing surface.
- Body: max-width 720px reading column, comfortable line-height, generous vertical rhythm.
- Default theme: **dark mode** (matching Module 1 design principle 1.10), with a subtle theme toggle in the footer.
- Typography: serif body for long-form Pattern articles (signals editorial credibility); sans-serif for Glossary (signals reference utility).
- Footer: sitewide links (Terms, Privacy, About) + soft CTA repeated.

### 6.2 In-App Library Entry Points

| Entry point | Surface | Module |
|---|---|---|
| "Learn more" link on each Pattern card | Patterns tab (overview) | Module 9 |
| "Learn more" link on Pattern detail screen header | Patterns tab (detail) | Module 9 |
| "?" tooltip → "Learn more" (any glossary term) | Any module surface | Module 21 (this) |
| Settings → Help → Glossary | Profile (settings sub-page) | Module 15 §3.14 |

When entered from inside the app, the page renders with the in-app navbar/footer preserved (it's still a logged-in surface). When entered from a public link with no session, the editorial chrome from §6.1 is used. The `body` content (the article) is identical in both cases.

### 6.3 Tooltip UX for Glossary Terms

- Icon: small "?" inside a circle, muted (50% opacity), inline-baseline-aligned with the term.
- Tap target: 24×24 px minimum (mobile-friendly).
- Popover: opens on tap (mobile) or hover-with-200ms-delay (desktop). 320px max-width.
- Content: term title, 2–3 sentence definition, "Learn more →" link.
- Dismiss: tap outside (mobile), mouse-out (desktop), or Escape key.
- Animation: 150ms fade + 4px slide-in.
- Accessibility: ARIA `role="button"` on the icon, `aria-describedby` linking to the popover, focus management (popover focuses on open, returns focus on close).

### 6.4 Locked-Overlay UX (Pro Patterns, Logged-In Free)

Per Module 16 §6.1 visual standard:
- Card sits in the overlay slot above the article body.
- Lock icon (muted, not red).
- Pattern name + "Pro" label.
- Single line: "Upgrade to see your data on this pattern."
- Single CTA button: "Upgrade to Pro" (consistent button styling).
- No countdown, no urgency phrasing, no exclamation marks.
- Tap → navigates to Settings → Subscription with `?source=learn_pattern_<slug>`.

Tone: informational, not pushy. The article below remains fully readable; the locked card is a lateral upsell, not a wall.

### 6.5 In-App Personalization Overlay (Unlocked)

For unlocked patterns (Free user on free pattern; Pro user on any pattern):
- Card sits in the overlay slot above the article body.
- Header: "Your data on this pattern".
- Stats row: count last 30 days, P&L impact (₹), trend arrow.
- Last 3 occurrences: compact rows (instrument, P&L, date), tappable to trade detail (Module 3).
- Footer link: "View all in Patterns tab →" (Module 9).
- Insufficient-data fallback: matches Module 9 §3.4 ("Need X more <type> trades to activate. The fix below applies whenever you're ready.").

### 6.6 Latency Targets

| Action | Target |
|---|---|
| Public `/learn/*` TTFB (CDN-cached) | <100ms |
| Public `/learn/*` LCP | <1.5s on fast-3G |
| In-app Library page first paint (article body) | <300ms |
| Personalization overlay populate (after first paint) | <500ms |
| Glossary tooltip open | <100ms |
| Sitemap request | <100ms |

### 6.7 Animation

- Page transitions: fade-only (no slide) — these are reading surfaces, not flow surfaces.
- Personalization overlay hydration: 200ms fade-in once data arrives.
- Glossary tooltip: 150ms fade + slide.
- Locked-card to unlocked-overlay swap (on tier change): 250ms cross-fade.

### 6.8 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | SSG + CDN delivers sub-100ms TTFB for SEO and conversion |
| 1.4 Patterns over events | The Library is the educational backbone of the patterns thesis |
| 1.5 Friction is the intervention | Public pages have no signup wall; in-app upsell only on Pro patterns |
| 1.9 No broker doom | Editorial tone is informational, not alarming; even pattern explanations frame the fix prominently |
| 1.10 Dark mode is the default | Editorial layout defaults dark, matches in-app theme |

### 6.9 Accessibility

- All Library / Glossary pages pass WCAG AA contrast in both themes.
- Heading hierarchy is semantic (`<h1>` for page title, `<h2>` for section, `<h3>` for sub-section).
- All images (including OG previews and any inline illustrative SVGs) have alt text.
- Glossary tooltips are keyboard-navigable (focusable "?" icon; Enter/Space opens popover; Escape closes).
- The "Skip to main content" link appears on every public page for screen readers.

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

**Zero push or email triggers from this module.** Library and Glossary are read surfaces. They do not generate notifications, do not enroll the user in any drip, and do not trigger transactional email.

(Tier-change emails on upgrade — when a user converts via the locked-overlay CTA — are owned by Module 15.)

### 7.2 XP

None. Reading educational content is not gamified in V1 — it would feel coercive to award XP for reading. (Flagged as potential V2 in OQ.)

### 7.3 SEO-Side Side Effects

These are build-time side effects, not runtime:

- **Sitemap regeneration** on every commit to `/content/`. Output written to `/sitemap.xml` and pushed to CDN.
- **OG image generation** per page on content build. Output written to `/learn/og/*.png` and pushed to CDN.
- **CDN purge** on rebuild for all `/learn/*` paths.
- **`robots.txt` static** — does not regenerate, but referenced in sitemap.
- **Search engine ping** (optional, OQ): on sitemap update, optionally ping `https://www.google.com/ping?sitemap=...` to expedite indexing. V1 default: do not ping; rely on Google's organic crawl cadence.

### 7.4 Analytics Events

- `learn_patterns_index_viewed` (with `auth_state` = unauth | free | pro)
- `learn_pattern_page_viewed` (with `pattern_slug`, `auth_state`, `referrer_source`)
- `learn_pattern_research_pdf_clicked` (with `pattern_slug`)
- `learn_pattern_related_pattern_clicked` (with `from_slug`, `to_slug`)
- `learn_pattern_signup_cta_clicked` (with `pattern_slug`, `position` = footer)
- `learn_pattern_overlay_locked_upgrade_clicked` (with `pattern_slug`) — feeds Module 16's paywall analytics
- `learn_pattern_overlay_view_in_patterns_tab_clicked` (with `pattern_slug`)
- `learn_glossary_index_viewed` (with `auth_state`)
- `learn_glossary_term_viewed` (with `term_slug`, `auth_state`, `referrer_source`)
- `learn_glossary_tooltip_opened` (with `term_slug`, `source_module`)
- `learn_glossary_tooltip_learn_more_clicked` (with `term_slug`, `source_module`)
- `sitemap_regenerated` (build-time, count of URLs)

### 7.5 Other Side Effects

- Tier change webhooks (Module 16) invalidate the in-memory cache for the personalization overlay on the next page load. The static article body itself is unaffected.
- Content build pushes to CDN trigger Cloudflare/Vercel cache purge for the affected paths only.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| User comments / community discussion on Library pages | Adds moderation burden + spam/SEO risk; not aligned with V1's editorial tone |
| Embedded video content (pattern explainers, Loom-style walkthroughs) | Production cost; V1 is text-first. Can add in V2 with the same routes |
| Multi-language support (Hindi, regional Indian languages, etc.) | English V1 per locked decision; localization is its own engineering project |
| AI-generated educational content | Library is editorially authored for credibility. AI-generated long-form would dilute trust. (Trader+ V2 may offer per-user AI explanations layered on top.) |
| Printable / PDF export of Library articles | Browser print stylesheet is acceptable; bespoke PDF export adds complexity |
| User-submitted glossary terms or pattern definitions | Editorial-only V1 |
| Personalized "recommended next read" widget on Library pages | Requires recommendation engine; V1 cross-links are static editorial picks |
| A/B testing of public-page copy or CTA placement | Adds complexity; V1 ships one editorial version |
| Bookmarking / save-for-later within Library | Browser bookmarks are sufficient |
| Library-search (full-text search across Library + Glossary) | Browser Cmd-F + sitemap is enough V1; full search is V2 |
| Trader+ in-Library AI commentary ("how this pattern shows up in your data, narrated") | Trader+ V2 feature; Module 13 owns AI surfaces |
| User-shareable Library page snippets ("copy a quote") | Standard browser select-and-share is sufficient |
| Inline interactive demos (e.g., interactive R-multiple calculator on the R-multiple Glossary page) | Static example suffices V1; interactivity is V2 |
| RSS feed for Library updates | Low V1 demand; can add in V2 if SEO/distribution data warrants |
| "Time to read" estimates on Library pages | Editorial polish, not V1 critical |
| AMP / instant-articles variants | Standard SSG is fast enough |

---

## 9. Open Questions

### 9.1 Complete Glossary term inventory

Spec proposes ~25–35 V1 terms (§5.5). The exact final list — including which obscure terms to defer (e.g., "expectancy" yes, "Sharpe" no for V1?) — needs editorial sign-off.

**My view:** Lock the V1 inventory at ~30 terms covering: trade mechanics (10), behavioral / patterns (5), product surfaces (10), outcome / stats (5). Defer pure-finance jargon (Sharpe, Sortino, Kelly, etc.) to V2 unless the in-app product surfaces them.

**Options:**
- A) ~30 terms covering the four buckets in §5.5. *(my recommendation)*
- B) Larger inventory (~50+) including academic finance terms.
- C) Smaller minimum-viable set (~15) — only terms appearing in V1 in-app surfaces.

### 9.2 Content authoring workflow — who writes and edits these?

Markdown-in-repo works for engineer-authored content. But Library articles need editorial voice, research citations, and legal review. Who owns content?

**My view:** Designate a single "Content Owner" (founder or contracted editor) responsible for all 8 Pattern articles + 30 Glossary terms in V1. They draft in markdown locally, open PRs, engineering reviews for technical accuracy. For V1's small surface, a CMS is overhead.

**Options:**
- A) Single Content Owner authoring in markdown, PR-reviewed. *(my recommendation)*
- B) Multi-author (founder + research advisor + product) workflow with editorial calendar.
- C) Outsource initial drafts to a financial-content writer; in-house edits.

### 9.3 SEBI / legal disclaimer requirements for educational trading content in India

**This is the most important OQ — flagging for legal review.** Library articles describe trading patterns and behavioral interventions. SEBI (Securities and Exchange Board of India) regulates investment advice; "education" is generally permitted but the line is fuzzy. Pattern Library articles must avoid:
- Specific buy/sell/hold recommendations (we don't make any — but article copy must be reviewed).
- Performance claims ("LuceEdge users improve by X%") without substantiation.
- Anything that could be construed as investment advisory without registration.

**My view:** Run all 8 Pattern articles through a SEBI-aware Indian securities lawyer before public launch. Add a standard footer disclaimer on every Library and Glossary page: "Educational content only. Not investment advice. LuceEdge is a trading-journal product and is not registered as an investment advisor with SEBI." Anonymized illustrative trades in the "Examples" section must be clearly labeled as illustrative.

**Options:**
- A) Legal review + disclaimer footer on every page. *(my recommendation — required, not optional)*
- B) Disclaimer only, skip pre-launch legal review (unsafe).
- C) Heavy legal review + remove "Examples" sections that include numbers (over-cautious; reduces educational value).

### 9.4 CMS vs. markdown choice

§5.1 chooses markdown-in-repo for V1. Trade-off: scaling beyond 30 terms or adding non-engineer authors makes a CMS attractive.

**My view:** Markdown for V1 (8 patterns + 30 terms is manageable in git). Move to a headless CMS (Contentful, Sanity, Notion-as-CMS) in V2 when content velocity justifies it.

**Options:**
- A) Markdown for V1, CMS for V2. *(my recommendation)*
- B) Headless CMS from V1 (higher infra surface).
- C) Notion-as-CMS via API (mid-weight; lock-in to Notion).

### 9.5 OG image generation strategy

§4.6 chooses build-time PNG generation from a static template. Alternatives: per-request rendering (`@vercel/og`), or hand-designed bespoke images per pattern.

**My view:** Build-time templated PNGs for V1 — fast, free, automated. Hand-designed bespoke OG images for the 8 Pattern pages would be ideal for share appeal but is a 1-day-per-pattern designer cost; revisit in V2 if Library traffic warrants.

**Options:**
- A) Build-time templated PNGs. *(my recommendation)*
- B) Per-request `@vercel/og` rendering (more dynamic but adds runtime cost).
- C) Hand-designed bespoke images (best share appeal; highest cost).

### 9.6 Public page tone — should the 5 Pro-pattern pages signal Pro at all?

Decided in §3.3: the article body has no Pro signaling, but a subtle "Pro feature in-app" note may appear next to the soft footer CTA. Should we signal at all?

**My view:** Subtle one-line in the footer CTA only ("This pattern's personalized detection is a Pro feature inside LuceEdge — start free to try the 3 free patterns first"). Avoid in-body signaling. The article is the marketing — the footer signals tier honestly.

**Options:**
- A) Subtle footer-only Pro note. *(my recommendation)*
- B) No Pro signaling on public pages at all (could be misleading when users sign up and find it locked).
- C) Visible Pro badge on the public page header (hurts SEO-equality between articles; against the "all 8 fully public" spirit).

### 9.7 Auto-link aggressiveness for Glossary terms in Pattern articles

§4.8 chooses first-occurrence-only auto-linking. Could be every-occurrence (more interlinks → SEO benefit) or editor-only (cleaner reading).

**My view:** First-occurrence auto-linked, editor can add more manually if pedagogically useful. Balances readability + SEO interlinking.

**Options:**
- A) First-occurrence auto, editor manual for more. *(my recommendation)*
- B) Every-occurrence auto-linked.
- C) No auto-linking; all interlinks are editor-curated.

---

*End of Module 21 spec.*
