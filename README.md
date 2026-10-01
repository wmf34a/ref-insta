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

## Cloud (Cloudflare) — open it from anywhere

The site runs on Cloudflare Workers (`worker.js` + D1 for the board), always on, behind one password.
Video analysis still needs ffmpeg / yt-dlp / Whisper, so one PC running `run` does that part: when
`.cloud.json` exists, `server.mjs` opens a Cloudflare quick tunnel and registers it with the Worker
every 5 minutes. With the PC off, search and the board keep working; analysis shows "분석 PC가 꺼져 있어요".

```
phone / any browser ──▶ ref-insta.<account>.workers.dev (Worker: page, search, board in D1)
                                   │  /api/analyze, /api/scenes, /api/upload, /cache/*, /videos/*
                                   ▼
                        *.trycloudflare.com ──▶ PC running server.mjs (token-checked)
```

One-time setup (already done for `ref-insta`):

```sh
npx wrangler d1 create ref-insta            # put the id in wrangler.jsonc
npx wrangler d1 execute ref-insta --remote --file=schema.sql
npx wrangler secret put APP_PASSWORD        # site password (any user name in the login prompt)
npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put ANALYZER_TOKEN      # same value as "token" in .cloud.json
npx wrangler secret put YOUTUBE_API_KEY     # optional: YouTube search with the PC off (YouTube Data API v3, 100 searches/day free)
npx wrangler deploy
```

`.cloud.json` (git-ignored) on the analysis PC:

```json
{ "url": "https://ref-insta.<account>.workers.dev", "token": "<ANALYZER_TOKEN>" }
```

Redeploy after changing `worker.js`, `search.mjs` or `public/`: `npx wrangler deploy`.
Only one PC is the analyzer at a time — the last one to start wins.

## Environment variables

- `FIRECRAWL_API_KEY` — use the Firecrawl REST API instead of the CLI (required on Windows)
- `WHISPER_CLI` — path to `whisper-cli` if it's not on PATH
- `WHISPER_MODEL` — ggml model path (default `~/.cache/whisper/ggml-small-q5_1.bin`)
- `PORT` — default 5173
- `CLOUDFLARED` — path to `cloudflared` if it's not on PATH
- `YOUTUBE_API_KEY` — YouTube Data API key; YouTube search uses it first, then yt-dlp

## Local data (git-ignored)

- `videos/` + `data.json` — uploads and the board
- `cache/` — downloaded videos and analysis results; safe to delete, it refills on demand
