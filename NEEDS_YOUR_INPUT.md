# Needs your input

If this file has no entries below the line, **nothing needs you right
now** — agents are unblocked and working. If an entry appears, it
means an agent hit something only you can resolve (a real account, a
credential, a genuine product-decision gap) and stopped rather than
faking it. See `AGENTS.md` → "When something needs the owner" for the
rule this file exists to enforce.

Check this file (not `PROGRESS.md`'s prose) when you want a fast, glanceable
answer to "does anything need me right now."

---

## Transactional email is broken on the shared dev/test Supabase project

**What's needed:** Check the Supabase dashboard (Authentication → Email
Templates / SMTP Settings) for the shared dev/test project
(`vbuzudbipftgsuosreuy`, per `docs/adr/0002-shared-dev-supabase-project.md`)
— `signUp()` and `resetPasswordForEmail()` both return a `500
unexpected_failure` (surfaces in this app as `AuthRetryableFetchError` →
mapped to `AUTH_MAILER_UNAVAILABLE`, "We couldn't send that email right
now"). Confirmed directly and repeatedly (2026-08-20, both
retrospeq-tester and this orchestrator session, independently, hours
apart) against a real signup with a fresh email each time — not a
one-off blip. Likely cause: no custom SMTP configured, combined with
Supabase's built-in test mailer being disabled/exhausted/misconfigured
on this project — but that's a guess; only dashboard access can confirm.

**Why an agent can't fix this:** no API or DB permission controls a
Supabase project's mailer configuration — it's dashboard-only.

**What's stalled:** 3 of 5 Module 01 email-dependent E2E tests
(`e2e/auth.spec.ts` — signup happy path, signup-with-existing-email,
password-reset no-enumeration) cannot complete the "check your email"
step and fail at that assertion. This does **not** block marking Module
01's auth slice (stories 1.1-1.3) done: the underlying logic for all
three flows is fully verified other ways — 100% branch coverage on
`mapAuthError` including this exact failure mode
(`lib/auth/__tests__/errors.test.ts`), the other 2 E2E tests pass
(invalid-credentials, reset-password/confirm render), and RLS/unit
coverage is comprehensive. It does mean nobody has watched a real
confirmation or reset email actually arrive yet.

**What was built in the meantime:** nothing stubbed — the code paths are
real and correctly mapped; this is purely an external service check.

---

## This machine's C: drive is completely full (0 bytes free) — ESCALATED 2026-08-23: the workaround has stopped reliably working

**What's needed:** Free up space on C:. This has been flagged since
2026-08-21 as "intermittent, has a workaround" — as of today (2026-08-23,
mid Module 04 Slice 1's test/review pass) **the established workaround
(`TEMP`/`TMP`/`TMPDIR` pointed at `E:\tmp_vitest`) is no longer
sufficient**: a full `npx vitest run` now fails outright partway through
with a bare Node-level `There is not enough space on the disk.` error
(not even a redirectable `ENOSPC` this time — confirmed via both the Bash
tool and PowerShell directly, same failure both ways), after passing only
2 of several test files in a scoped run. `C:` is still reading literal
0 bytes free (`Get-PSDrive C` → `Free: 0`) despite the project's own
temp/cache usage being redirected to `E:` (which itself has 27GB free,
confirmed not the bottleneck). Checked for anything safely cleanable
directly: `C:\Users\hp\AppData\Local\Temp` (~0.55GB), the npm cache
(~1.46GB), and this session's own harness scratch dir (~0.01GB) are all
small — none of them account for the drive being full, meaning the bulk
of whatever is consuming 277GB is elsewhere on this machine, outside
anything an agent should be guessing at deleting.

**Why an agent can't fix this:** this is a general Windows disk-space
problem, not specific to this repo — cleaning it safely needs someone who
knows what else is on this machine. The project itself already lives
entirely on E: (`E:\LuceEdge\retrospeq-app`) and its own npm cache/tmp
were already redirected to `E:` early in this build (PROGRESS.md decision
log, 2026-08-19) specifically because of this same underlying constraint.

**What's stalled, concretely, as of this escalation:** a full-suite
`npx vitest run` piped through a Bash/PowerShell pipeline (e.g. `| tail`,
`| Select-Object -Last N`) started failing mid-run with a bare
`There is not enough space on the disk.` — not even a redirectable
`ENOSPC`, both via the Bash tool and PowerShell directly. This turned out
to be the terminal pipeline's OWN output-capture buffering exhausting C:
(observed: the actual test process kept running and passing tests in the
background — visible partial output before the crash — it's specifically
piping vitest's live output through another process that fails, not
vitest itself).

**Workaround found and confirmed working, 2026-08-23** — redirect ALL
output directly to a file on `E:` with PowerShell's `*>` (not a pipe),
then read that file separately with a file-reading tool instead of the
terminal:
```powershell
$env:TEMP = "E:\tmp_vitest"; $env:TMP = "E:\tmp_vitest"; $env:TMPDIR = "E:/tmp_vitest"
npx vitest run *> "E:\tmp_vitest\full-run.log"
```
then read `E:\tmp_vitest\full-run.log` directly (e.g. via the `Read`
tool, or `wc -l`/`Read` with an offset for a long file) rather than
piping through `tail`/`Select-Object` — confirmed this gets a full,
genuine 1047/13/0 result with zero disk errors, right after the same
command failed when piped. **Any agent hitting the same
"not enough space on the disk" wall should use this pattern, not
conclude the suite can't be run.** Every OTHER workflow this session
(build, lint, tsc, git) continued working normally throughout — this is
specifically a terminal-pipe-buffering issue on top of the standing
C:-full problem, not a new category of blocker, and it does NOT currently
block the mandatory "run the full suite" verification step once the
file-redirect workaround is used.

---

## This machine's virtual memory is too tight for `npm run build` to complete reliably — confirmed a persistent pattern, not a one-off, worth a durable fix

**What's needed:** A decision from you on the durable fix — most likely
increasing this machine's page file size (Windows: System Properties →
Advanced → Performance Settings → Advanced → Virtual Memory), since the
commit-charge ceiling (physical RAM + page file) is what's actually
running out, not physical RAM alone (physical free has stayed in the
5-6GB range throughout every occurrence; it's `FreeVirtualMemory` —
commit headroom — that drops to 1.3-2GB right before each crash). This
requires either you making the change directly, or explicitly telling an
agent it's authorized to change it (a page-file resize is a system-wide
Windows setting, not a project file, and increasing it does not require
a reboot to take effect for future growth — shrinking would, growing
generally doesn't — but it's still a machine-wide change no agent should
make unilaterally on your personal machine without being told to).

**Why an agent can't fix this alone:** it's a Windows system setting
outside the repo, and while an agent *could* technically drive the
Control Panel dialog, doing so without being asked crosses from "project
autonomy" into "changing settings on your machine" — exactly the kind of
thing this file exists to surface rather than silently do.

**What's stalled, concretely:** `npm run build` (the full production
build, specifically Next.js's "Collecting page data"/"Generating static
pages" worker-pool phase) has now failed with the identical
`STATUS_ACCESS_VIOLATION` (`0xC0000005`) signature **at least five
separate times** across this build session (first noticed mid-Module-04,
recurring through Module 04's later slices, and reproduced again
directly by this orchestrator on 2026-09-01 at the very start of Module
08 — `FreeVirtualMemory` was 1,720MB immediately before that run, and the
build failed at the exact same phase). The pattern is now well
understood, not mysterious: TypeScript compilation itself (`tsc
--noEmit`, and the build's own earlier "Finished TypeScript" step)
completes successfully every single time; it's specifically the
static-page-generation worker pool afterward that needs more committable
memory than is available at that moment. On at least two occasions,
killing leftover orphaned `node`/`next dev`/Playwright processes left
running by an earlier agent's session (never cleaned up before that
session ended) recovered enough headroom (~700MB-1GB) for the *exact
same* build to then pass cleanly with zero code changes — so process
hygiene helps, but does not fully explain this most recent occurrence,
where no orphaned processes were found and the build still failed.

**What this does NOT block**: any code has still been fully verified via
`tsc --noEmit` (which reliably completes and has never itself been the
source of a false pass) plus `eslint .` plus the full non-live and
live-DB test suites — none of these ever hit this failure mode, only the
production build's later phase does. No slice has been marked "done" on
the strength of a build that didn't actually complete; every PROGRESS.md
entry hitting this has said so honestly ("build-unverified-for-infra-
reasons," never claimed as a pass). This is slowing down full-confidence
verification, not silently letting anything through unverified.

**What's been done in the meantime**: every agent hitting this is now
expected to (1) check memory before building, (2) check for and kill
their own leftover dev-server/test-runner processes first, (3) retry
once after doing so, and (4) if it still fails, report it honestly as
infra-unverified rather than either blocking indefinitely or falsely
claiming a pass. This keeps work moving but is a recurring tax on every
slice that touches a UI surface, and five occurrences means it will keep
recurring at this build's current dispatch volume unless the underlying
ceiling is raised.

---

_(`SUPABASE_DB_URL` was supplied 2026-08-20 and connection/migration verification is done, see PROGRESS.md decision log. The `retrospeq` schema is real.)_

One still-open, non-blocking item whenever convenient: the "Exposed schemas" dashboard toggle (Project Settings → API → add `retrospeq`) — only needed for the app's own client-side/REST access at runtime (e.g. `.from()`/`.rpc()` calls), not for anything happening right now. `lib/rate-limit/limiter.ts` (added 2026-08-20) works around this by using a direct Postgres connection instead, so this is not blocking that either.
