#!/usr/bin/env bash
# Keep this Mac running as ref's analysis PC: start at login, restart if it dies, don't idle-sleep while running,
# and update yt-dlp every morning (YouTube breaks old versions with "HTTP Error 403").
#   ./scripts/mac-service.sh install | uninstall | status | logs
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
AGENTS=~/Library/LaunchAgents
LOGS=~/Library/Logs/ref
SERVER=com.ref.analyzer
UPDATE=com.ref.ytdlp-update
NODE=$(command -v node)
BREW=$(command -v brew || echo /opt/homebrew/bin/brew)
# launchd starts with a bare PATH: give it Homebrew (yt-dlp, ffmpeg, whisper-cli, cloudflared) and node's folder.
PATHS="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

plist_server() { cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SERVER</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>$ROOT/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.log</string>
</dict></plist>
P
}
plist_update() { cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$UPDATE</string>
  <key>ProgramArguments</key><array><string>$BREW</string><string>upgrade</string><string>yt-dlp</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/ytdlp-update.log</string>
  <key>StandardErrorPath</key><string>$LOGS/ytdlp-update.log</string>
</dict></plist>
P
}

case "${1:-status}" in
  install)
    mkdir -p "$AGENTS" "$LOGS"
    plist_server > "$AGENTS/$SERVER.plist"
    plist_update > "$AGENTS/$UPDATE.plist"
    for l in $SERVER $UPDATE; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"; done
    echo "installed. logs: $LOGS/server.log" ;;
  uninstall)
    for l in $SERVER $UPDATE; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; rm -f "$AGENTS/$l.plist"; done
    echo "removed." ;;
  status)
    launchctl print "gui/$(id -u)/$SERVER" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "not installed" ;;
  logs) tail -n 40 "$LOGS/server.log" ;;
  *) echo "usage: $0 install|uninstall|status|logs"; exit 1 ;;
esac
