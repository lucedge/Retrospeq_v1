# M2 — MT5 Docker/Wine Scaling Investigation

## Goal

The M2 MT5 beta bridge (`scripts/mt5_bridge.py`) requires a real Windows machine
running a real MT5 terminal — that's a single point of failure and doesn't scale
past a handful of accounts on one developer's laptop. This investigation asks:
**can MT5 be run reliably inside a Linux Docker container (via Wine), so the
bridge can be deployed as cheap, reproducible, horizontally-scalable
infrastructure instead of a dedicated Windows box per worker?**

Answer, as of this investigation: **yes** — proven end-to-end with two real
accounts on two different brokers, logged in through a full
host → RPyC → Wine-hosted Python → MT5-under-Wine → broker chain. It took
fixing eight distinct issues to get there. This document is the full record so
nobody has to rediscover them.

## Environment

- Host: Windows 10, Docker Desktop 27.3.1 (WSL2 backend, Linux containers —
  **native Windows containers are disabled on this Docker Desktop
  installation**; switching failed with `"windows containers have been
  disabled for this installation"`, not investigated further)
- Repo used: [gmag11/MetaTrader5-Docker](https://github.com/gmag11/MetaTrader5-Docker)
  (Debian bookworm base, WineHQ `wine-stable` 11.0.0.0, bundles
  [mt5linux](https://github.com/lucas-campagna/mt5linux) for the Python bridge,
  KasmVNC for browser-based display access)
- MT5 build under test: 6090 (same build used by the native bridge all session)
- MT5 data used: copied wholesale from a native Windows install that had
  already resolved three brokers (`Exness-MT5Real17`, `MetaQuotes-Demo`,
  `KatoPrime-Live`) — see "Prerequisite" below.

### A simpler repo was tried first and abandoned

[tickelton/docker-metatrader](https://github.com/tickelton/docker-metatrader)
(Ubuntu focal + `winehq-devel`) was tried first. Running our real MT5 build
under it produced a genuine, reproducible crash:
`wine: Unhandled page fault on write access to 0000000000000000 ...` — a hard
crash in MT5's own code, not a config issue. Switching to `gmag11`'s repo
(newer Wine-stable channel, more actively maintained, has the actual Python
bridge built in) avoided this entirely. **Do not use the tickelton repo for
this build of MT5.**

## Prerequisite: resolved broker data must already exist

MT5's Python API (`mt5.login()`) cannot discover a broker server it has never
seen before — that only happens via the terminal GUI's "Find your broker"
search (a lookup against MetaQuotes' central directory), which is a separate,
credential-independent step from actually logging in. This was proven earlier
in the session on native Windows: dozens of automated `login()` attempts with
valid credentials never resolved `KatoPrime-Live` until a manual GUI search
was done once.

The good news: that resolved knowledge lives in two files/folders —
`config/servers.dat` and the `Bases/<server-name>/` folder — and **is portable
via plain file copy**, confirmed by direct testing (copied to an isolated
folder, the broker showed up in a fresh terminal's search with zero manual
steps). This is why we could skip broker discovery entirely inside the
container: we copied an already-resolved native install straight in (see
Issue 7 below).

## Issues hit, in the order encountered, and the fix for each

### 1. Docker Desktop can't run Windows containers here
`DockerCli.exe -SwitchDaemon` → `"windows containers have been disabled for
this installation"`. Not resolved — worked around by staying on Linux
containers + Wine instead of native Windows containers.

### 2. No display driver at all (`tickelton` repo, before switching)
Running MT5 with no `DISPLAY` at all: `"Application tried to create a window,
but no driver could be loaded"` — Wine needs *some* display driver to
initialize even for headless automation.
**Fix:** add a virtual framebuffer (`Xvfb`). Not needed at all once we moved
to `gmag11`'s repo, which bundles its own display stack (KasmVNC/Xvnc).

### 3. Hard crash under the `tickelton` repo
`wine: Unhandled page fault on write access to 0000000000000000` — reproducible
crash in MT5's own code under an older WineHQ `-devel` channel build.
**Fix:** abandoned that repo; switched to `gmag11/MetaTrader5-Docker`
(Wine 11 stable, properly channeled). Root cause not fully isolated (could be
the specific Wine build, could be something else) — not worth chasing further
once a working alternative was confirmed.

### 4. Port 3000 collision with the LuceEdge dev server
`docker-compose-windows.yaml` maps the container's VNC web UI to host port
3000 — which was already bound by `npm run dev` (running the whole session).
The container looked like it started fine; the browser just silently showed
the wrong app.
**Fix:** remap to a free host port: `-p 3005:3000` (keep 8001 for the
`mt5linux` RPC port). **Always check for port collisions with whatever else is
running on the host before assuming a container's port mapping is broken.**

### 5. `start.sh` never runs — silent race condition
The container's own init system (openbox autostart) tries to launch
`/Metatrader/start.sh` before the layer is fully ready:
`/config/.config/openbox/autostart: 1: /Metatrader/start.sh: not found`. The
file exists moments later, but autostart never retries.
**Fix:** trigger it manually: `docker exec -u abc mt5 /bin/bash -c "nohup
/bin/bash /Metatrader/start.sh > /tmp/start.log 2>&1 &"` (see Issue 6 for the
required `-u abc`).

### 6. CRLF line endings corrupt the script
`Metatrader/start.sh` was checked out on a Windows machine and copied into the
image with Windows-style `\r\n` line endings, which Linux `bash` chokes on:
`` /Metatrader/start.sh: line 2: $'\r': command not found ``, then a syntax
error on the first function definition.
**Fix:** `sed -i 's/\r$//' Metatrader/start.sh` before building/copying it in.
**This will bite anyone building this image from a Windows checkout — fix the
line endings in the repo (`.gitattributes` with `*.sh text eol=lf`) before
building, not after.**

### 7. Wine refuses to run as the wrong user
Running `start.sh` (or anything wine-related) as `root` via a plain
`docker exec` fails: `"wine: '/config' is not owned by you, refusing to
create a configuration directory there"`. The container's actual runtime user
is `abc` (LinuxServer.io convention, UID 911), which owns `/config`.
**Fix:** always `docker exec -u abc ...` for anything touching the Wine
prefix.

### 8. The real installer hits an anti-debugger dialog
Running the *actual* `mt5setup.exe` under Wine (`wine mt5setup.exe /auto`)
reaches a genuine MetaQuotes anti-tamper check that misfires under Wine's
exception-handling emulation: a dialog reading *"A debugger has been found
running in your system. Please, unload it from memory and restart your
program."* This blocks headlessly — no way to click through it without a real
interactive session, and even then it just blocks the install.
**Fix — the one that actually worked:** don't run the installer under Wine at
all. Instead, `docker cp` an **already-installed, already-working** MT5
folder from a native Windows machine straight into the Wine prefix's expected
location:
```
docker exec mt5 mkdir -p "/config/.wine/drive_c/Program Files"
docker cp "E:\mt5_portable_test\MT5" "mt5:/config/.wine/drive_c/Program Files/MetaTrader 5"
docker exec mt5 chown -R abc:abc "/config/.wine/drive_c/Program Files/MetaTrader 5"
```
This also transplants the already-resolved `Bases/`+`servers.dat` for free —
two problems solved with one copy. The copied install then launches under
Wine with **no crash and no dialog**:
```
docker exec -u abc mt5 wine "/config/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe" /portable
```
(Ownership must be fixed with `chown` first — a `docker cp` from the host
lands as `root:root`, and Wine needs `abc:abc` per Issue 7.)

### 9. `mt5linux`'s current CLI doesn't match `gmag11`'s script
`start.sh` invokes the bridge server as `python3 -m mt5linux --host 0.0.0.0 -p
8001 -w wine python.exe` — but the currently-published `mt5linux` (1.0.11 on
PyPI) doesn't have a `-w`/wine flag at all; its `__main__.py` is now a thin
wrapper around `rpyc.cli.rpyc_classic.ClassicServer`, which only understands
generic RPyC server flags (`--host`, `-p`, `-m`, etc). `gmag11`'s script is
written against an older version of the package.
**Fix:** run the RPyC server *inside* Wine directly, using Wine's own Python,
instead of trying to point a Linux-side invocation "at" Wine:
```
docker exec -u abc mt5 wine python -m mt5linux --host 0.0.0.0 -p 8001
```
This works because whichever Python process runs the RPyC server determines
what's importable inside the session — it has to be Wine's Python so that
`import MetaTrader5` (a Windows-only compiled package) actually resolves.

### 10. `numpy` ABI mismatch inside the RPyC session
Once connected, the client's very first call
(`import MetaTrader5 as mt5`, done implicitly by `mt5linux.MetaTrader5(...)`)
failed:
```
ImportError: numpy.core.multiarray failed to import
  File ".../MetaTrader5/__init__.py", line 257, in <module>
    from ._core import *
```
Confusingly, a bare `wine python -c "import numpy"` succeeded fine standalone
— the failure was specific to `MetaTrader5`'s own compiled `_core` extension
importing numpy internally. `pip install MetaTrader5` had pulled numpy 2.0.2;
MT5's compiled extension was very likely built against numpy 1.x's C-API,
which changed incompatibly in numpy 2.x — a well-known category of breakage
for third-party compiled extensions.
**Fix:** `wine python -m pip install "numpy<2" --force-reinstall` (landed on
1.26.4). Restart the RPyC server after reinstalling. **Pin `numpy<2`
explicitly whenever installing `MetaTrader5` inside Wine — don't let pip pick
the latest.**

### 11. `initialize()` with no `path=` can't find the right terminal
With numpy fixed, `mt5.initialize()` (no arguments) reliably returned
`(False, (-10005, 'IPC timeout'))`. The terminal's own log confirmed it had
started fine under Wine (`"Windows 10 build 19045 on Wine 11.0 Linux ..."`,
MCP subsystem up) but showed **zero** login/network activity — the API call
never actually reached it. This is the same "ambiguous attach" failure mode
hit repeatedly on native Windows earlier in the session whenever more than
one terminal instance could plausibly be the target.
**Fix — the one that finally produced a real login:** pass everything
explicitly in one call, matching the pattern from MT5's own docs, rather than
a bare `initialize()` + separate `login()`:
```python
from mt5linux import MetaTrader5
mt5 = MetaTrader5(host="localhost", port=8001)
mt5.initialize(
    path=r"C:\Program Files\MetaTrader 5\terminal64.exe",
    portable=True,
    login=login,
    password=password,
    server=server,
    timeout=60000,
)
```
This returned `(True, (1, 'Success'))` immediately, with real `account_info()`
data. Confirmed reproducible (ran twice, both succeeded) and confirmed for a
second, non-default broker (`KatoPrime-Live`, the one specifically resolved
earlier in the session), not just a mainstream one (`MetaQuotes-Demo`).

## Verified working end state

Two full, real logins, through the complete chain, both confirmed:

| Account | Server | Result |
|---|---|---|
| `10011928289` | `MetaQuotes-Demo` | ✅ `name='Adi Yaas'`, balance 99997.54 — reproduced twice |
| `40042522` | `KatoPrime-Live` | ✅ `name='Yash Gho'`, balance 4998.4, `company='Kato Prime Limited'` |

Test script used (kept for reference):
`scratchpad/test_docker_login.py` in this session's temp directory — decrypts
real credentials from Supabase via the existing `lib/crypto/credentials.ts`
scheme (reusing `mt5_bridge.py`'s `decrypt_credential`), connects via
`mt5linux.MetaTrader5(host="localhost", port=8001)`, calls `initialize()`
exactly as shown above.

## Multi-instance test — the core scaling assumption, validated

A second, fully independent container (`mt5-2`) was built from the same
image, with its own named volume (fresh Wine prefix — none of the first
container's state was reused) and its own port mapping (`3006:3000`,
`8002:8001`). The same resolved MT5 install was copied in and Python/packages
installed the same way (see the recipe above).

**Result: both containers ran real, independent logins simultaneously, with
zero interference.**

| Container | Account | Server | Result |
|---|---|---|---|
| `mt5` | `10011928289` | `MetaQuotes-Demo` | ✅ re-verified working *while `mt5-2` was also active* |
| `mt5` | `40042522` | `KatoPrime-Live` | ✅ (tested earlier, single-instance) |
| `mt5-2` | `145752898` | `Exness-MT5Real17` | ✅ fresh Wine prefix, own volume/ports, first attempt |

One new issue hit and fixed while setting up the second container:

### 12. A second Wine prefix hits the Mono dialog again, and killing it wrong corrupts the prefix
A brand-new Wine prefix (separate volume = separate `WINEPREFIX`) hits the
exact same Mono auto-install dialog as Issue 8, for the same reason: it's
never booted before. Killing individual processes (`pkill -f terminal64.exe`,
even `pkill -9 -f wine`) does **not** reliably tear down the session — Wine
runs one `wineserver` per prefix, and other processes (`services.exe`,
`explorer.exe`, the stuck dialog) survive because their names/paths don't
match a `wine`-pattern kill, and a *second* `wine` invocation with a
different `WINEDLLOVERRIDES` just attaches to the still-running server
instead of applying the new setting. Force-killing the remaining processes by
PID got rid of the dialog but left the prefix corrupted:
`wine: could not load kernel32.dll, status c0000135` on the next launch —
unrecoverable short of wiping it.
**Fix:** `wineserver -k` to cleanly stop the *entire* session for that prefix
before ever relaunching with different settings — never kill individual
processes. If a prefix does get corrupted, the fastest recovery is `rm -rf
/config/.wine` and start over (re-copy the MT5 install, `chown`, relaunch)
rather than trying to repair it. **Set `WINEDLLOVERRIDES="mscoree=,mshtml="`
on the very first launch of a fresh prefix, not as a fix applied after the
fact** — avoids this whole failure mode.

## Real trade data pulled through the bridge

Login alone isn't the point — the bridge exists to pull trade history. Ran
`history_deals_get()` (the exact call `mt5_bridge.py` already uses) through
the Docker/Wine bridge on `40042522`/`KatoPrime-Live`:

```
history_deals_get() -> 39 deals
  ticket=115702577 symbol= type=2 volume=0.0 profit=5000.0  (balance deposit)
  ticket=115702765 symbol=GBPUSD type=0 volume=0.01 price=1.32886 ...
  ... (37 more GBPUSD trade deals)
```

Matches what the native bridge already found for this account earlier in the
session (38 deals; the 1-deal difference is the balance-adjustment entry
being counted differently, not a data discrepancy). **Confirms the
Docker/Wine bridge is functionally equivalent to the native bridge for actual
trade retrieval, not just login.**

## What is NOT done yet — do not treat this as production-ready

1. **Nothing above is baked into a Dockerfile.** Every fix was applied by hand
   to a *running* container via `docker exec`/`docker cp`. A fresh `docker
   compose build && up` right now would hit every one of these issues again,
   in the same order. The next step is encoding all twelve fixes into a
   proper, from-scratch image build (line-ending fix, correct user, numpy
   pin, resolved-data overlay, `WINEDLLOVERRIDES` set from the first launch,
   and the corrected `mt5linux` invocation all need to become build-time
   steps, not manual patches).
2. ~~Only one instance has been tested~~ — **done**, see above: two fully
   independent containers, three accounts across two brokers, verified
   running simultaneously with no cross-interference.
3. **`mt5_bridge.py` itself hasn't been adapted.** It still does
   `import MetaTrader5 as mt5` directly; using this container in production
   means switching that to the `mt5linux` client pattern shown above.
4. **The broker-resolution pipeline is still manual.** A brand-new broker
   still needs one GUI-driven discovery step somewhere (see "Prerequisite"
   above) before its data can be baked into an image. No automation for this
   was attempted in this investigation (an MQL5-forum-sourced idea —
   automating "Find your broker" with a UI-automation tool like `pywinauto`
   — was suggested but not tried).
5. **Resource/cost sizing under Wine is unknown.** How many concurrent
   Wine+MT5 instances one container host can realistically run (CPU/RAM per
   instance, any Wine-specific overhead versus native) hasn't been measured.
