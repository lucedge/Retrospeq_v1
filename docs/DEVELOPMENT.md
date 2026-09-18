# Developer guide — moved

This file has been split into `docs/handbook/`, a numbered set where each
page answers one question. It was a 797-line synthesis refreshed at phase
boundaries, and it drifted: it claimed 33 migrations when there were 35,
43 ADRs when there were 46, and described a Supabase arrangement two ADRs
had superseded. Smaller files with single responsibilities are cheap
enough to fix in the slice that invalidated them.

| What you came here for | Where it is now |
|---|---|
| What Retrospeq is, the three objects | [`handbook/01-product-and-domain.md`](handbook/01-product-and-domain.md) |
| Running locally, environment variables | [`handbook/02-getting-started.md`](handbook/02-getting-started.md) |
| Architecture, request path, the auth guard | [`handbook/03-architecture.md`](handbook/03-architecture.md) |
| The module walkthrough (Modules 01–08) | [`handbook/04-module-map.md`](handbook/04-module-map.md) |
| Why `.from()`/`.rpc()` don't work here | [`handbook/05-data-access.md`](handbook/05-data-access.md) |
| The schema, RLS shapes, invariants | [`handbook/06-data-model.md`](handbook/06-data-model.md) |
| Golden fixtures, the grouping engine | [`handbook/07-flows-capture.md`](handbook/07-flows-capture.md) |
| Testing, the scripts, what to run | [`handbook/12-testing.md`](handbook/12-testing.md) |
| The design system, rules that look like bugs | [`handbook/11-frontend.md`](handbook/11-frontend.md) |
| Gotchas worth not rediscovering | spread across the page each one belongs to |

Start at [`docs/README.md`](README.md) for the reading order.

Status — what is built, what is not, what needs a decision — was never
this file's job and still isn't: see `PROGRESS.md`, `docs/infra-gaps.md`
and `NEEDS_YOUR_INPUT.md`.
