// Zero-dependency reference video library server.
// Videos live in ./videos, metadata in ./data.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCES, REF_OK, linkOk, cached, firecrawlSearch, firecrawlCredits, creditStatus, handleSearch, newBoardItem, PER_SOURCE, fetchStats, byPopular, youtubeApiSearch, firstOf, analysisKey, matchScenes } from './search.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const VIDEO_DIR = path.join(ROOT, 'videos');
const DATA = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 5173;
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const STATIC_MIME = { ...MIME, '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript' };

fs.mkdirSync(VIDEO_DIR, { recursive: true });

// execFile (no shell) keeps the search query out of shell parsing.
const runJson = (bin, args) =>
  new Promise((ok, fail) =>
    execFile(bin, args, { maxBuffer: 64 << 20, timeout: 60_000 }, (e, out, err) => {
      if (!e) return ok(JSON.parse(out));
      const msg = (err || e.message).trim().split('\n').pop();
      fail(new Error(/429/.test(msg) ? '검색 한도를 넘었어요. 1분쯤 뒤에 다시 해보세요.' : msg));
    }),
  );
const ytdlp = (args) => runJson('yt-dlp', args);
// Firecrawl key: FIRECRAWL_API_KEY, or a .firecrawl-key file next to this script (what run.cmd / run.sh write).
// Read on every search so adding the key doesn't need a restart.
const KEY_FILE = path.join(ROOT, '.firecrawl-key');
const firecrawlKey = () => process.env.FIRECRAWL_API_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');

// Firecrawl web search: REST API when a key is known (any OS); otherwise the logged-in `firecrawl` CLI
// (macOS/Linux only — Windows can't spawn its .cmd shim without a shell, and a shell would parse the query).
async function webSearch(query, qdr) {
  const tbs = qdr ? `qdr:${qdr}` : undefined;
  const key = firecrawlKey();
  if (key) return firecrawlSearch(key, query, qdr);
  if (WIN) throw new Error('Firecrawl API 키가 없어요. run 으로 실행하거나 .firecrawl-key 파일에 키를 넣어 주세요.');
  return (await runJson('firecrawl', ['search', query, '--limit', String(PER_SOURCE), '--json', ...(tbs ? ['--tbs', tbs] : [])])).data?.web || [];
}

// YouTube captions as [startSec, endSec, text].
async function fetchCaptions(id) {
  const j = await ytdlp(['-j', '--skip-download', `https://www.youtube.com/watch?v=${id}`]);
  const subs = j.subtitles || {};
  const auto = j.automatic_captions || {};
  const track = subs.ko || auto.ko || Object.values(subs)[0] || auto.en;
  const url = track?.find((t) => t.ext === 'json3')?.url;
  if (!url) return [];
  const d = await (await fetch(url)).json();
  return (d.events || [])
    .filter((e) => e.segs)
    .map((e) => [e.tStartMs / 1000, (e.tStartMs + (e.dDurationMs || 0)) / 1000, e.segs.map((s) => s.utf8).join('').trim()])
    .filter(([, , t]) => t);
}

// ---- Analysis: download → scene cuts + frame per scene → on-screen text (OCR) → speech (captions or Whisper) ----
const CACHE_DIR = path.join(ROOT, 'cache');
// Resolves stdout+stderr (ffmpeg logs to stderr); `stdoutOnly` for tools that chatter on stderr.
const run = (bin, args, timeout = 300_000, stdoutOnly = false) =>
  new Promise((ok, fail) =>
    execFile(bin, args, { maxBuffer: 64 << 20, timeout }, (e, out, err) =>
      e ? fail(new Error((err || e.message).trim().split('\n').pop())) : ok(stdoutOnly ? out : out + err),
    ),
  );
const has = (bin) => run(WIN ? 'where' : 'which', [bin]).then(() => true, () => false);
const OCR_BIN = path.join(CACHE_DIR, 'ocr');

// On-screen text, one string per image. Uses what the OS already has:
// macOS Vision (ocr.swift, compiled once), Windows' built-in OCR (ocr.ps1), else Tesseract if installed.
async function ocr(files) {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(OCR_BIN)) await run('swiftc', ['-O', path.join(ROOT, 'ocr.swift'), '-o', OCR_BIN]);
    return JSON.parse(await run(OCR_BIN, files).then((o) => o.slice(o.indexOf('['), o.lastIndexOf(']') + 1)));
  }
  if (WIN) {
    // Result goes through a UTF-8 file: Windows PowerShell's stdout uses the console code page and mangles Korean.
    const out = path.join(path.dirname(files[0]), 'ocr.json');
    await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'ocr.ps1'), out, ...files]);
    return JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
  }
  if (!(await has('tesseract'))) return [];
  const texts = [];
  for (const f of files) texts.push((await run('tesseract', [f, 'stdout', '-l', 'kor+eng'], 60_000, true).catch(() => '')).replace(/\s+/g, ' ').trim());
  return texts;
}

// Speech-to-text for videos without captions via whisper.cpp (mac: `brew install whisper-cpp`;
// Windows: whisper-bin-x64.zip from its GitHub releases — put whisper-cli.exe on PATH or set WHISPER_CLI).
// Model: WHISPER_MODEL, or ~/.cache/whisper/ggml-small-q5_1.bin (from huggingface.co/ggerganov/whisper.cpp).
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), '.cache', 'whisper', 'ggml-small-q5_1.bin');
const WHISPER_CLI = process.env.WHISPER_CLI || 'whisper-cli';
async function transcribe(dir) {
  const model = WHISPER_MODEL;
  if (!fs.existsSync(model) || !(fs.existsSync(WHISPER_CLI) || (await has(WHISPER_CLI)))) return null;
  const wav = path.join(dir, 'audio.wav');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 'video.mp4'), '-ar', '16000', '-ac', '1', wav]);
  // Greedy decoding (-bs 1 -bo 1): same Korean transcript as beam search on our samples, about 2x faster.
  const args = ['-m', model, '-l', 'auto', '-sns', '-bs', '1', '-bo', '1', '-t', String(os.cpus().length), '-oj', '-of', path.join(dir, 'whisper'), '-f', wav];
  await run(WHISPER_CLI, args);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'whisper.json'), 'utf8'));
  const lines = (j.transcription || []).map((s) => [s.offsets.from / 1000, s.offsets.to / 1000, s.text.trim()]).filter(([, , t]) => t && !hallucinated(t));
  return dropLoops(lines);
}

// Whisper also loops on music: the same line again and again ("2. 뱃살", "3. 뱃살", …). If one line (ignoring
// digits) makes up 3+ lines and most of the transcript, it's a loop, not speech.
function dropLoops(lines) {
  const norm = (t) => t.replace(/[\d.\s]/g, '');
  const counts = new Map();
  for (const [, , t] of lines) counts.set(norm(t), (counts.get(norm(t)) || 0) + 1);
  return lines.filter(([, , t]) => !(counts.get(norm(t)) >= 3 && counts.get(norm(t)) >= lines.length / 2));
}

// On music-only audio Whisper tends to emit one character repeated, often in a random script. Drop those lines.
// ponytail: heuristic; a VAD model (whisper.cpp --vad) is the real fix if this lets junk through.
function hallucinated(t) {
  if (!/[가-힣A-Za-z0-9♪]/.test(t)) return true;
  const chars = [...t.replace(/\s/g, '')];
  return chars.length > 20 && new Set(chars).size / chars.length < 0.15;
}

// yt-dlp's English errors -> what the person can actually do about it.
function downloadError(msg, link) {
  const site = /instagram/.test(link) ? '인스타그램' : /tiktok/.test(link) ? '틱톡' : /threads/.test(link) ? '스레드' : '이 사이트';
  if (/timed out|Connection|getaddrinfo|Network is unreachable|Unable to download webpage/i.test(msg))
    return `분석 PC에서 ${site}에 접속할 수 없어요. 회사 네트워크처럼 ${site}을 막는 곳일 수 있어요. 집 PC를 분석 PC로 켜면 될 수 있어요.`;
  if (/login|log in|cookies|rate.?limit|empty media|not available|private/i.test(msg))
    return `${site}이 로그인을 요구해서 이 영상은 받을 수 없어요.`;
  if (/no video|There is no video|Unsupported URL|image/i.test(msg)) return '사진 게시물이라 분석할 영상이 없어요.';
  if (/HTTP Error 403|Sign in to confirm|not a bot/i.test(msg))
    return `${site === '이 사이트' ? '유튜브' : site}가 다운로드를 막았어요. 분석 PC에서 ref 를 다시 실행하면(yt-dlp 자동 업데이트) 대부분 해결돼요.`;
  return `영상을 받지 못했어요. (${msg.slice(0, 160)})`;
}

// key: cache folder name; link: page to download with yt-dlp, or file: a local upload; ytId: YouTube id for captions;
// meta: title/src/url etc. kept with the result so the scene & script search can show and open it.
async function analyze({ key, link, file, ytId, meta = {} }) {
  const dir = path.join(CACHE_DIR, key);
  const done = path.join(dir, 'analysis.json');
  if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'video.mp4');

  // Captions don't need the video, so fetch them while it downloads.
  const captions = ytId ? fetchCaptions(ytId).catch(() => []) : Promise.resolve([]);
  if (!fs.existsSync(video) && file) fs.copyFileSync(file, video);
  if (!fs.existsSync(video)) {
    try {
      await run('yt-dlp', ['-q', '--no-playlist', '-f', 'b[ext=mp4][height<=720]/bv*[height<=720]+ba/b', '--merge-output-format', 'mp4', '-o', video, link]);
    } catch (e) {
      throw new Error(downloadError(e.message, link));
    }
  }

  // Pictures (scene cuts → frames → OCR) and sound (captions or Whisper) are independent: run them side by side.
  const visuals = (async () => {
    const duration = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]));
    // One pass: keep the first frame + every frame where the picture changes a lot, log their times, save thumbnails.
    for (const f of fs.readdirSync(dir)) if (/^s\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f));
    const log = await run('ffmpeg', ['-v', 'info', '-y', '-i', video, '-vf', "select='eq(n,0)+gt(scene,0.3)',showinfo,scale=540:-2", '-fps_mode', 'vfr', '-q:v', '4', path.join(dir, 's%03d.jpg')]);
    const starts = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    const imgs = fs.readdirSync(dir).filter((f) => /^s\d+\.jpg$/.test(f)).sort();
    // ponytail: 0.3 scene threshold is a guess; tune if talking-head videos split too little or fast edits too much.
    const scenes = imgs.slice(0, starts.length).map((f, i) => ({ start: starts[i], end: starts[i + 1] ?? duration, img: `/cache/${key}/${f}` }));
    const texts = await ocr(imgs.slice(0, scenes.length).map((f) => path.join(dir, f))).catch(() => []);
    scenes.forEach((s, i) => (s.text = texts[i] || ''));
    return { duration, scenes };
  })();
  const speech = (async () => {
    const c = await captions;
    if (c.length) return { script: c, scriptSource: 'captions' };
    const w = await transcribe(dir).catch(() => null);
    return w?.length ? { script: w, scriptSource: 'whisper' } : { script: [], scriptSource: null };
  })();

  const result = { ...meta, ...(await visuals), ...(await speech), video: `/cache/${key}/video.mp4`, analyzedAt: Date.now() };
  fs.writeFileSync(done, JSON.stringify(result));
  return result;
}
// "영상 속 말" search over every analysis on disk.
// ponytail: reads every analysis.json per query; fine for hundreds of videos, add an index if it grows to thousands.
function searchScenes(q) {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const all = fs.readdirSync(CACHE_DIR)
    .map((key) => path.join(CACHE_DIR, key, 'analysis.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  return matchScenes(all, q);
}

// YouTube Shorts search without Firecrawl: yt-dlp's YouTube search, short videos only (free, ~3-5 s).
// The query is one argv entry after "ytsearch40:", so it can't be read as a yt-dlp option.
async function youtubeFree(q) {
  const j = await ytdlp(['--flat-playlist', '-J', `ytsearch40:${q} shorts`]);
  return (j.entries || [])
    .filter((e) => e.id && e.duration && e.duration <= 180)
    .map((e) => ({ src: 'yt', ref: e.id, url: `https://www.youtube.com/shorts/${e.id}`, title: e.title || '', channel: e.channel || '', views: e.view_count ?? null }))
    .sort(byPopular)
    .slice(0, 20);
}
// With a YouTube Data API key (YOUTUBE_API_KEY) the official search goes first; yt-dlp is the fallback.
const free = { yt: firstOf([process.env.YOUTUBE_API_KEY && ((q, qdr) => youtubeApiSearch(process.env.YOUTUBE_API_KEY, q, qdr)), youtubeFree].filter(Boolean)) };

// Firecrawl balance: REST API with a key, else the logged-in CLI (same shape: remainingCredits, planCredits, billingPeriodEnd).
const readCredits = async () => {
  const key = firecrawlKey();
  if (key) return firecrawlCredits(key);
  const j = await runJson('firecrawl', ['credit-usage', '--json']);
  return j.data || j;
};

// Saved search results on disk (cache/search/<sha1 of key>.json), so they survive restarts.
const SEARCH_DIR = path.join(ROOT, 'cache', 'search');
const searchFile = (key) => path.join(SEARCH_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
const searchStore = {
  get: async (key) => (fs.existsSync(searchFile(key)) ? JSON.parse(fs.readFileSync(searchFile(key), 'utf8')) : null),
  set: async (key, v) => {
    fs.mkdirSync(SEARCH_DIR, { recursive: true });
    fs.writeFileSync(searchFile(key), JSON.stringify(v));
  },
};

const load = () => (fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : []);
const save = (list) => fs.writeFileSync(DATA, JSON.stringify(list, null, 2));

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks))).on('error', fail);
  });

function serveFile(req, res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const type = STATIC_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// ---- Cloud mode: the Cloudflare Worker serves the site; this PC does the analysis behind a Cloudflare Tunnel. ----
// .cloud.json (git-ignored) = { "url": "https://<worker>.workers.dev", "token": "<shared secret>" }.
const CLOUD_FILE = path.join(ROOT, '.cloud.json');
const cloud = fs.existsSync(CLOUD_FILE) ? JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8')) : null;

// Requests that came through the tunnel carry cf-connecting-ip; only the Worker (holding the token) may use them.
const fromTunnel = (req) => 'cf-connecting-ip' in req.headers;
const tokenOk = (req) => cloud && req.headers['x-ref-token'] === cloud.token;

// Copy finished analyses to the Worker (D1), so their timeline and 영상 속 말 search work with this PC off.
// Scene frames go up as small JPEGs (t001.jpg…); the video itself stays here (too big — the player falls back to the embed).
const pushing = new Set();
async function pushAnalysis(key) {
  if (!cloud || pushing.has(key)) return;
  const dir = path.join(CACHE_DIR, key);
  const done = path.join(dir, 'analysis.json');
  if (!fs.existsSync(done) || fs.existsSync(path.join(dir, 'pushed'))) return;
  pushing.add(key);
  try {
    const a = JSON.parse(fs.readFileSync(done, 'utf8'));
    const put = async (p, body, type) => {
      const r = await fetch(cloud.url + p, { method: 'PUT', headers: { 'x-ref-token': cloud.token, 'content-type': type }, body });
      if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    };
    for (const s of a.scenes) {
      const name = path.basename(s.img).replace(/^s/, 't');
      const small = path.join(dir, name);
      if (!fs.existsSync(small)) await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, path.basename(s.img)), '-vf', 'scale=240:-2', '-q:v', '5', small]);
      await put(`/api/media/${key}/${name}`, fs.readFileSync(small), 'image/jpeg');
      s.img = `/m/${key}/${name}`;
    }
    delete a.video;
    await put(`/api/analysis/${key}`, JSON.stringify(a), 'application/json');
    fs.writeFileSync(path.join(dir, 'pushed'), String(Date.now()));
    console.log('클라우드에 분석 저장: ' + key);
  } catch (e) {
    console.log(`클라우드 저장 실패 (${key}): ${e.message}`);
  } finally {
    pushing.delete(key);
  }
}
// Analyses made before (or while offline) go up once at startup, one at a time.
async function pushBacklog() {
  if (!cloud || !fs.existsSync(CACHE_DIR)) return;
  for (const key of fs.readdirSync(CACHE_DIR)) if (/^[\w-]+$/.test(key) && key !== 'search') await pushAnalysis(key);
}

function startTunnel() {
  const bin = process.env.CLOUDFLARED || 'cloudflared';
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', () => console.log('cloudflared 가 없어요. 설치하면 이 PC가 클라우드 사이트의 분석을 맡아요.'));
  let tunnel = null;
  const register = () =>
    fetch(cloud.url + '/api/analyzer', { method: 'POST', headers: { 'x-ref-token': cloud.token, 'content-type': 'application/json' }, body: JSON.stringify({ url: tunnel }) })
      .then((r) => console.log(r.ok ? `분석 PC 등록됨 → ${cloud.url}` : `분석 PC 등록 실패: ${r.status}`))
      .catch((e) => console.log('분석 PC 등록 실패: ' + e.message));
  child.stderr.on('data', (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (m && !tunnel) {
      tunnel = m[0];
      register();
      setInterval(register, 5 * 60_000); // heartbeat: the Worker treats us as offline after 15 min of silence
    }
  });
  // Take the tunnel down with us, whichever way we're stopped (Ctrl+C, kill, closing the terminal).
  process.on('exit', () => child.kill());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit());
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (fromTunnel(req) && !tokenOk(req)) return json(res, 403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
      }
      if (req.method === 'GET' && (p === '/manifest.json' || p === '/sw.js' || p.startsWith('/icons/'))) return serveFile(req, res, path.join(ROOT, 'public'), p.slice(1));
      if (req.method === 'GET' && p.startsWith('/videos/')) return serveFile(req, res, VIDEO_DIR, decodeURIComponent(p.slice(8)));
      if (req.method === 'GET' && p.startsWith('/cache/')) return serveFile(req, res, CACHE_DIR, decodeURIComponent(p.slice(7)));
      if (req.method === 'GET' && p === '/api/videos') return json(res, 200, load());
      if (req.method === 'GET' && p === '/api/status') return json(res, 200, { analyzer: true });
      if (req.method === 'GET' && p === '/api/search') {
        const r = await handleSearch(url.searchParams, webSearch, searchStore, readCredits, free);
        if (r.failed) res.setHeader('x-failed', r.failed.join(','));
        return json(res, r.status, r.body);
      }
      if (req.method === 'GET' && p === '/api/credits') return json(res, 200, await creditStatus(searchStore, readCredits, free));
      // Used by the Cloudflare Worker (through the tunnel) so its YouTube search is free too.
      if (req.method === 'GET' && p === '/api/ytsearch') return json(res, 200, await youtubeFree((url.searchParams.get('q') || '').trim()));
      if (req.method === 'GET' && p === '/api/stats') {
        const src = url.searchParams.get('src');
        const ref = url.searchParams.get('ref') || '';
        if (!SOURCES[src] || !REF_OK.test(ref)) return json(res, 400, { error: 'bad item' });
        return json(res, 200, await fetchStats(src, ref).catch(() => ({})));
      }
      if (req.method === 'GET' && p === '/api/scenes') return json(res, 200, searchScenes((url.searchParams.get('q') || '').trim()));
      if (req.method === 'GET' && p === '/api/analyze') {
        const id = url.searchParams.get('id');
        if (id) {
          const item = load().find((v) => v.id === id && v.file);
          if (!item) return json(res, 404, { error: 'not found' });
          const meta = { boardId: id, title: item.title };
          const a = await cached('a:file:' + id, () => analyze({ key: 'file_' + id, file: path.join(VIDEO_DIR, item.file), meta }));
          pushAnalysis('file_' + id);
          return json(res, 200, a);
        }
        const src = url.searchParams.get('src');
        const ref = url.searchParams.get('ref') || '';
        const link = url.searchParams.get('url') || '';
        if (!SOURCES[src] || !REF_OK.test(ref) || !linkOk(src, link)) return json(res, 400, { error: 'bad item' });
        const key = analysisKey(src, ref);
        const meta = { src, ref, url: link, title: (url.searchParams.get('title') || '').slice(0, 300), channel: (url.searchParams.get('channel') || '').slice(0, 100) };
        const a = await cached('a:' + key, () => analyze({ key, link, ytId: src === 'yt' ? ref : null, meta }));
        pushAnalysis(key);
        return json(res, 200, a);
      }
      if (req.method === 'POST' && p === '/api/save') {
        const item = newBoardItem(JSON.parse((await readBody(req)).toString() || '{}'), crypto.randomUUID().slice(0, 8));
        if (!item) return json(res, 400, { error: 'bad item' });
        const list = load();
        const hit = list.find((v) => v.src === item.src && v.ref === item.ref);
        if (hit) return json(res, 200, hit);
        save([item, ...list]);
        return json(res, 201, item);
      }

      if (req.method === 'POST' && p === '/api/upload') {
        const orig = url.searchParams.get('name') || 'video.mp4';
        const ext = path.extname(orig).toLowerCase();
        if (!MIME[ext]) return json(res, 400, { error: `지원 안 하는 형식: ${ext}` });
        const id = crypto.randomUUID().slice(0, 8);
        fs.writeFileSync(path.join(VIDEO_DIR, id + ext), await readBody(req));
        const item = { id, file: id + ext, title: path.basename(orig, ext), tags: [], memo: '', created: Date.now() };
        save([item, ...load()]);
        return json(res, 201, item);
      }

      const m = /^\/api\/videos\/([\w-]+)$/.exec(p);
      if (m) {
        const list = load();
        const i = list.findIndex((v) => v.id === m[1]);
        if (i < 0) return json(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          const { title, tags, memo } = JSON.parse((await readBody(req)).toString() || '{}');
          if (typeof title === 'string') list[i].title = title;
          if (Array.isArray(tags)) list[i].tags = tags.map(String).map((t) => t.trim()).filter(Boolean);
          if (typeof memo === 'string') list[i].memo = memo;
          save(list);
          return json(res, 200, list[i]);
        }
        if (req.method === 'DELETE') {
          if (list[i].file) fs.rmSync(path.join(VIDEO_DIR, list[i].file), { force: true });
          list.splice(i, 1);
          save(list);
          return json(res, 200, { ok: true });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, () => {
    console.log(`ref → http://localhost:${PORT}`);
    if (cloud) {
      startTunnel();
      pushBacklog();
      setInterval(pushBacklog, 30 * 60_000); // retry anything that failed to upload (network blips, PC was offline)
    }
  });
