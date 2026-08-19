# MT5 Bridge — Docker/Wine Image

Runs the real MT5 terminal under Wine in a Linux container, with a
`mt5linux` bridge exposing the Python API on port `8001`. See
[docs/M2_MT5_Docker_Wine_Investigation.md](../../docs/M2_MT5_Docker_Wine_Investigation.md)
for the full history of why this image is built the way it is — every step
in the `Dockerfile` maps to a specific, documented issue.

## Build prerequisite: `mt5data/`

This directory is **not checked into git** — it's ~1GB of MetaQuotes'
proprietary MT5 binaries plus the resolved broker connection data
(`servers.dat` / `Bases/`), neither of which belongs in source control.

Before building, populate `docker/mt5-bridge/mt5data/` with a working,
already-resolved MT5 install:

1. On a real Windows machine with MT5 installed and at least one account
   successfully connected (so its broker server is resolved — see the
   investigation doc's "Prerequisite" section for why this matters), copy
   the entire install directory:
   ```
   C:\Program Files\MetaTrader 5\   →   docker/mt5-bridge/mt5data/
   ```
2. To support additional brokers, resolve them once via the terminal's own
   *File → Open an Account → search broker* on that same Windows install
   before copying — the resulting `Bases/<broker>/` folder and updated
   `Config/servers.dat` carry over automatically since they're part of the
   same install directory.

## Build

```
docker build -t lucedge/mt5-bridge:v1 docker/mt5-bridge
```

## Run

```
docker run -d --name mt5-worker-1 -p 8001:8001 -p 3000:3000 lucedge/mt5-bridge:v1
```

- Port `8001` — the `mt5linux` RPC bridge (`mt5_bridge.py` talks to this
  instead of importing `MetaTrader5` directly when running against this
  container).
- Port `3000` — KasmVNC web UI. Only useful for occasionally viewing a
  running instance (e.g. to resolve a brand-new broker manually); not
  needed for normal unattended operation.

## Known limitations (see investigation doc for detail)

- Broker discovery for a server not already in the baked-in `mt5data/` still
  requires one manual GUI step, same as native Windows — this image doesn't
  solve that, it just avoids re-doing it per container.
- Not yet wired into `scripts/mt5_bridge.py` — that script still imports
  `MetaTrader5` directly for the native Windows path. Pointing it at this
  container instead means swapping that import for the `mt5linux` client
  pattern shown in the investigation doc.
