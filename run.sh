#!/usr/bin/env bash
# One-command setup + start for macOS (and Linux). From this folder:  ./run.sh
# First run installs what's missing (Homebrew on macOS), fetches the Whisper model,
# asks for the Firecrawl API key once, then starts the server and opens the browser.
set -euo pipefail
cd "$(dirname "$0")"

need() { # need <command> <brew formula>
  command -v "$1" >/dev/null && return
  if command -v brew >/dev/null; then
    echo "Installing $2 ..."
    brew install "$2"
  else
    echo "Missing '$1'. Install it with your package manager (e.g. apt install $2) and run again." >&2
    exit 1
  fi
}
need node node
need yt-dlp yt-dlp
need ffmpeg ffmpeg
# Cloud mode (.cloud.json present): this PC does the analysis for the Cloudflare site through a tunnel.
[ -f .cloud.json ] && need cloudflared cloudflared

# Optional: speech-to-text for videos without captions. Failure here only disables the script column.
command -v whisper-cli >/dev/null || { command -v brew >/dev/null && brew install whisper-cpp || echo "whisper-cpp not installed; scripts only from YouTube captions."; }
model="$HOME/.cache/whisper/ggml-small-q5_1.bin"
if [ ! -f "$model" ]; then
  echo "Downloading Whisper model (190MB) ..."
  mkdir -p "$(dirname "$model")"
  curl -fL -o "$model.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin && mv "$model.part" "$model" \
    || echo "Model download failed; continuing without Whisper."
fi

# macOS OCR is compiled from ocr.swift on first use and needs the Xcode command line tools.
if [ "$(uname)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  echo "Tip: run 'xcode-select --install' to enable on-screen text (OCR)."
fi

# Firecrawl: a logged-in `firecrawl` CLI works; otherwise ask for an API key once (saved to .firecrawl-key, git-ignored).
if [ -z "${FIRECRAWL_API_KEY:-}" ] && [ ! -s .firecrawl-key ] && ! command -v firecrawl >/dev/null; then
  read -rp "Firecrawl API key (https://www.firecrawl.dev/app/api-keys): " key
  printf '%s' "$key" > .firecrawl-key
fi

url=http://localhost:${PORT:-5173}
(sleep 2; command -v open >/dev/null && open "$url" || xdg-open "$url" >/dev/null 2>&1 || true) &
exec node server.mjs
