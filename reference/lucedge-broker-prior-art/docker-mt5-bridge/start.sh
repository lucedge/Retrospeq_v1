#!/bin/bash
# Production startup for the LuceEdge MT5 bridge container.
#
# MT5 itself and its Python environment are baked into the image at build
# time (see Dockerfile) so this only has to launch already-installed things —
# no downloads, no installers, fast container start.
#
# See docs/M2_MT5_Docker_Wine_Investigation.md in the LuceEdge repo for the
# full history of why this script looks the way it does (each design choice
# here maps to a specific issue documented there).

export WINEPREFIX=/config/.wine
export WINEARCH=win64
# Disables Wine's Mono/Gecko auto-install prompt. Must be set before the
# very first wine invocation in a fresh prefix, not applied as a later fix —
# see Issue 8 / Issue 12 in the investigation doc.
export WINEDLLOVERRIDES="mscoree=,mshtml="

mt5file='/config/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe'
mt5server_port="8001"

show_message() {
    echo "$1"
}

if [ ! -e "$mt5file" ]; then
    show_message "[FATAL] $mt5file not found. The image build did not bake in the MT5 install correctly."
    exit 1
fi

show_message "[1/3] Starting MetaTrader 5..."
wine "$mt5file" /portable &

# Give the terminal a real moment to finish booting before anything tries to
# attach to it — every IPC-timeout issue hit during testing traced back to
# attaching too early or too ambiguously, never to the terminal being
# fundamentally broken.
sleep 15

# The mt5linux bridge server MUST run inside Wine's own Python, not a
# Linux-side invocation pointed "at" wine — the currently-published
# mt5linux (1.0.11) has no such flag, and only Wine's Python has the real
# MetaTrader5 package importable. See Issue 9.
show_message "[2/3] Starting the mt5linux bridge server on port $mt5server_port..."
wine python -m mt5linux --host 0.0.0.0 -p "$mt5server_port" &

sleep 8

if ss -tuln | grep ":$mt5server_port" > /dev/null; then
    show_message "[3/3] mt5linux bridge is running on port $mt5server_port."
else
    show_message "[3/3] FAILED to start mt5linux bridge on port $mt5server_port."
fi

# Keep this process (and the container) alive.
wait
