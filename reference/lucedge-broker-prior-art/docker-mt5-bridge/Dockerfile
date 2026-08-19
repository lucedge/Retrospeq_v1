# LuceEdge MT5 bridge — production image.
#
# Builds on gmag11/metatrader5_vnc (Debian bookworm + WineHQ wine-stable +
# KasmVNC) since that base's Wine setup is already proven working — see
# docs/M2_MT5_Docker_Wine_Investigation.md for why every step below exists.
# Bakes in: a pre-resolved MT5 install (real terminal + already-discovered
# broker servers.dat/Bases — no installer, no discovery step, no Mono
# dialog), and a full Wine-hosted Python environment (MetaTrader5 +
# mt5linux + numpy pinned <2), so containers start fast with nothing to
# download or install at runtime.

FROM gmag11/metatrader5_vnc

USER root

# Bake in the already-resolved MT5 install. This solves three of the twelve
# documented issues in one step: no installer to run (so no anti-debugger
# dialog), no broker discovery needed at runtime (servers.dat/Bases are
# already resolved), and it's baked into the image layer, not a runtime
# docker cp.
COPY ["mt5data/", "/config/.wine/drive_c/Program Files/MetaTrader 5/"]

# Wine refuses to operate as anyone other than the prefix owner (issue 7).
# The base image's runtime user is `abc` (LinuxServer.io convention).
RUN chown -R abc:abc "/config/.wine" 2>/dev/null || true

USER abc
ENV WINEPREFIX=/config/.wine
ENV WINEARCH=win64
# Must be set before Wine's very first boot of this prefix, not applied
# afterward as a fix (issue 8 / issue 12) — a fresh prefix without this
# hits an unclickable "Install Mono?" dialog under headless Xvfb.
ENV WINEDLLOVERRIDES="mscoree=,mshtml="

# Install Python inside Wine and the packages the bridge needs, at build
# time — so a running container never has to download or install anything.
# numpy is pinned <2 explicitly: MetaTrader5's compiled extension was built
# against numpy 1.x's C-API and fails with "numpy.core.multiarray failed to
# import" under numpy 2.x (issue 10) — don't let pip pick the latest.
RUN curl -L "https://www.python.org/ftp/python/3.9.13/python-3.9.13.exe" -o /tmp/python-installer.exe && \
    wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 && \
    rm -f /tmp/python-installer.exe && \
    sleep 3 && \
    wine python -m pip install --no-cache-dir \
        "numpy<2" \
        "MetaTrader5==5.0.36" \
        "mt5linux>=0.1.9" \
        python-dateutil

# Replace the base image's start.sh (has CRLF line endings from being
# checked out on Windows — issue 6 — an outdated mt5linux invocation that
# doesn't work with the currently-published package — issue 9 — and tries
# to install MT5 + Mono at runtime, which we've already baked into the
# image instead).
USER root
COPY start.sh /Metatrader/start.sh
RUN chmod +x /Metatrader/start.sh && chown abc:abc /Metatrader/start.sh
USER abc

# 3000 = KasmVNC web UI (only useful for manual broker-resolution sessions
# on a dedicated "resolver" instance — not needed by production workers).
# 8001 = the mt5linux RPC bridge our own mt5_bridge.py talks to.
EXPOSE 3000 8001
