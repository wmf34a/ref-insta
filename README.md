# ref

Reference finder for short-form content: search YouTube Shorts, Instagram, TikTok, Pinterest and Threads at once, open a post to see its scenes, spoken script and on-screen text, and keep the good ones on a local board.

Zero npm dependencies — `node server.mjs`, then open http://localhost:5173.

## What it needs

| Tool | Used for | Required? |
| --- | --- | --- |
| Node.js 18+ | the server | yes |
| Firecrawl | search (`site:` web search) | yes |
| yt-dlp | downloading a video for analysis, YouTube captions | for analysis |
| ffmpeg / ffprobe | scene cuts, thumbnails, audio | for analysis |
| whisper.cpp + model | script for videos without captions | optional |
| macOS Vision (`ocr.swift`) | on-screen text | macOS only, built automatically |

## macOS

```sh
brew install node yt-dlp ffmpeg whisper-cpp
mkdir -p ~/.cache/whisper
curl -L -o ~/.cache/whisper/ggml-small-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin
# Firecrawl: either log in with its CLI, or set FIRECRAWL_API_KEY (see Windows)
node server.mjs
```

## Windows

In `cmd`, from the repo folder:

```bat
run
```

First run installs Node / yt-dlp / FFmpeg with winget if missing, downloads whisper.cpp and the model into `tools\`, asks for your Firecrawl API key once (saved to `.firecrawl-key`), then starts the server and opens the browser. Later runs just start it.

On Windows the on-screen text (OCR) column stays empty — it uses macOS Vision. Everything else works the same.

## Environment variables

- `FIRECRAWL_API_KEY` — use the Firecrawl REST API instead of the CLI (required on Windows)
- `WHISPER_CLI` — path to `whisper-cli` if it's not on PATH
- `WHISPER_MODEL` — ggml model path (default `~/.cache/whisper/ggml-small-q5_1.bin`)
- `PORT` — default 5173

## Local data (git-ignored)

- `videos/` + `data.json` — uploads and the board
- `cache/` — downloaded videos and analysis results; safe to delete, it refills on demand
