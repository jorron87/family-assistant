#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
mkdir -p "$HOME/.local/share/familien-kiosk"
until curl -fsS --max-time 5 http://127.0.0.1:4318/health >/dev/null; do sleep 3; done
exec chromium --ozone-platform=x11 --touch-events=enabled --disable-features=Translate --kiosk --no-first-run --noerrdialogs --disable-session-crashed-bubble --user-data-dir="$HOME/.local/share/familien-kiosk" 'http://127.0.0.1:4318/?kiosk=1'
