// Zero-dependency reference video library server.
// Videos live in ./videos, metadata in ./data.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const VIDEO_DIR = path.join(ROOT, 'videos');
const DATA = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 5173;
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const STATIC_MIME = { ...MIME, '.jpg': 'image/jpeg' };

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
// ponytail: unbounded in-memory cache, fine for one person; add LRU/TTL if it runs for weeks.
const cache = new Map();
const cached = async (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
};

// None of these platforms offers a public content search, so find posts through a web search
// (Firecrawl, site: filter) and play them with each platform's own embed. `re` pulls out the id the embed needs.
const SOURCES = {
  yt: { site: 'youtube.com/shorts', host: /(^|\.)youtube\.com$/, re: /youtube\.com\/shorts\/([\w-]{11})/ },
  ig: { site: 'instagram.com', host: /(^|\.)instagram\.com$/, re: /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/ },
  tt: { site: 'tiktok.com', host: /(^|\.)tiktok\.com$/, re: /tiktok\.com\/@[\w.-]+\/video\/(\d+)/ },
  pin: { site: 'pinterest.com/pin', host: /(^|\.)pinterest\.[a-z.]+$/, re: /pinterest\.[\w.]+\/pin\/(?:[\w-]*--)?(\d+)/ },
  th: { site: 'threads.com', host: /(^|\.)threads\.(com|net)$/, re: /threads\.(?:com|net)\/(@[\w.]+\/post\/[\w-]+)/ },
};
const REF_OK = /^@?[\w.\/-]{1,80}$/;
// A link we hand to yt-dlp must really point at that platform (not just contain its path somewhere).
const linkOk = (src, link) => {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && SOURCES[src].host.test(u.hostname) && SOURCES[src].re.test(link);
  } catch {
    return false;
  }
};

// Posting-date filter. Firecrawl honours only Google's qdr:w/m/y (a custom cdr: range is ignored), so we
// search with the narrowest qdr that covers the range, then keep posts whose real date falls inside it.
const DAY = 86_400_000;
const PRESETS = { w: 7, m: 31, '90d': 90, '6m': 183, y: 365 };
function dateRange(params) {
  const now = Date.now();
  let min = null;
  let max = null;
  const p = params.get('period');
  if (PRESETS[p]) min = now - PRESETS[p] * DAY;
  else if (p === 'custom') {
    const from = Date.parse(params.get('from'));
    const to = Date.parse(params.get('to'));
    if (!Number.isNaN(from)) min = from;
    if (!Number.isNaN(to)) max = to + DAY - 1; // "to" includes that whole day
  }
  if (min == null && max == null) return { qdr: '', min, max };
  const age = min == null ? Infinity : (now - min) / DAY;
  const qdr = age <= 7 ? 'w' : age <= 31 ? 'm' : age <= 366 ? 'y' : '';
  return { qdr, min: min ?? -Infinity, max: max ?? Infinity };
}

// When was a post published (ms), or null. TikTok ids start with a unix timestamp; Instagram/Threads shortcodes
// are base64 media ids whose top bits are ms since 2011-08-24; YouTube needs one page fetch (cached).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const igTime = (code) => Number(([...code.slice(0, 11)].reduce((n, c) => n * 64n + BigInt(B64.indexOf(c)), 0n) >> 23n) + 1314220021721n);
const ytTime = (id) =>
  cached('date:' + id, async () => {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'ko' } });
    const m = /"publishDate":"([^"]+)"/.exec(await r.text());
    return m ? Date.parse(m[1]) : null;
  });
async function postTime(v) {
  try {
    if (v.src === 'tt') return Number(BigInt(v.ref) >> 32n) * 1000;
    if (v.src === 'ig') return igTime(v.ref);
    if (v.src === 'th') return igTime(v.ref.split('/post/')[1]);
  } catch {}
  return null; // YouTube: see withYtDates. Pinterest ids carry no date.
}
// YouTube dates cost a page fetch each (~1s), so only look them up when a date filter needs them.
const withYtDates = (list) => pool(list.filter((v) => v.src === 'yt' && v.date == null), 10, async (v) => (v.date = await ytTime(v.ref).catch(() => null)));
// Run fn over items, at most n at a time (YouTube date lookups: 40 at once gets throttled).
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// Firecrawl key: FIRECRAWL_API_KEY, or a .firecrawl-key file next to this script (what run.cmd / run.sh write).
// Read on every search so adding the key doesn't need a restart.
const KEY_FILE = path.join(ROOT, '.firecrawl-key');
const firecrawlKey = () => process.env.FIRECRAWL_API_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');

// Firecrawl web search: REST API when a key is known (any OS); otherwise the logged-in `firecrawl` CLI
// (macOS/Linux only — Windows can't spawn its .cmd shim without a shell, and a shell would parse the query).
async function webSearch(query, qdr) {
  const tbs = qdr ? `qdr:${qdr}` : undefined;
  const key = firecrawlKey();
  if (key) {
    const r = await fetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit: 40, ...(tbs && { tbs }) }),
    });
    if (r.status === 429) throw new Error('검색 한도를 넘었어요. 1분쯤 뒤에 다시 해보세요.');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Firecrawl ${r.status}`);
    return j.data?.web || [];
  }
  if (WIN) throw new Error('Firecrawl API 키가 없어요. run 으로 실행하거나 .firecrawl-key 파일에 키를 넣어 주세요.');
  return (await runJson('firecrawl', ['search', query, '--limit', '40', '--json', ...(tbs ? ['--tbs', tbs] : [])])).data?.web || [];
}

async function searchSource(src, q, qdr) {
  const { site, re } = SOURCES[src];
  const hits = await webSearch(`site:${site} ${q}`, qdr);
  const seen = new Set(); // the same post often shows up under several URLs; drop repeats by id and by caption
  const list = hits
    .map((r) => {
      const ref = re.exec(r.url)?.[1];
      // Meta descriptions look like: '3 likes, 0 comments - c_pop_studio on June 11, 2025: "caption…'
      const m = /^([\d,.KkMm]+) likes?.*? - ([\w.]+) on [^:]+: "?(.*)/.exec(r.description || '');
      const title = (m?.[3] || r.title || '').replace(/\s*[-|]\s*(YouTube|Instagram|TikTok|Pinterest|Threads)$/i, '').trim();
      return ref && { src, ref, url: r.url, title, channel: m?.[2] || '', likes: m?.[1] || '' };
    })
    .filter((v) => v && !seen.has(v.ref) && !seen.has(v.title) && seen.add(v.ref).add(v.title));
  await pool(list, 8, async (v) => (v.date = await postTime(v)));
  return list;
}

const inRange = (range) => (v) => range.min == null || (v.date != null && v.date >= range.min && v.date <= range.max);

// "all": every source in parallel, interleaved so one platform doesn't bury the rest. A failing source is skipped.
async function searchAll(q, range) {
  const settled = await Promise.allSettled(Object.keys(SOURCES).map((s) => cached(`${s}:${range.qdr}:${q}`, () => searchSource(s, q, range.qdr))));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason; // e.g. Firecrawl 429 — show it instead of "0 results"
  if (range.min != null) await withYtDates(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  const lists = settled.map((r) => (r.status === 'fulfilled' ? r.value.filter(inRange(range)) : []));
  const failed = Object.keys(SOURCES).filter((_, i) => settled[i].status === 'rejected');
  const out = [];
  for (let i = 0; i < 40; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return { out, failed };
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
      throw new Error('영상을 받지 못했어요. 이미지 게시물이거나 접속이 막힌 사이트일 수 있어요. (' + e.message + ')');
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
// "장면·대사" search: look through every analysis on disk — spoken lines and on-screen text — for all the words.
// ponytail: reads every analysis.json per query; fine for hundreds of videos, add an index if it grows to thousands.
function searchScenes(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !fs.existsSync(CACHE_DIR)) return [];
  const hitAll = (t) => { const l = t.toLowerCase(); return words.every((w) => l.includes(w)); };
  const out = [];
  for (const key of fs.readdirSync(CACHE_DIR)) {
    const f = path.join(CACHE_DIR, key, 'analysis.json');
    if (!fs.existsSync(f)) continue;
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!a.src && !a.boardId) continue; // analysed before titles were stored; can't be opened from here
    const sceneAt = (t) => a.scenes[Math.max(0, a.scenes.findLastIndex((s) => s.start <= t + 0.05))];
    const matches = [
      ...a.script.filter(([, , t]) => hitAll(t)).map(([start, , text]) => ({ kind: 'say', start, text, img: sceneAt(start)?.img })),
      ...a.scenes.filter((s) => s.text && hitAll(s.text)).map((s) => ({ kind: 'screen', start: s.start, text: s.text, img: s.img })),
    ].sort((x, y) => x.start - y.start);
    if (!matches.length && !hitAll(a.title || '')) continue;
    const { src, ref, url, title, channel, boardId } = a;
    out.push({ src, ref, url, title, channel, boardId, matches, thumb: matches[0]?.img || a.scenes[0]?.img });
  }
  return out.sort((x, y) => y.matches.length - x.matches.length);
}

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

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
      }
      if (req.method === 'GET' && p.startsWith('/videos/')) return serveFile(req, res, VIDEO_DIR, decodeURIComponent(p.slice(8)));
      if (req.method === 'GET' && p.startsWith('/cache/')) return serveFile(req, res, CACHE_DIR, decodeURIComponent(p.slice(7)));
      if (req.method === 'GET' && p === '/api/videos') return json(res, 200, load());
      if (req.method === 'GET' && p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json(res, 400, { error: '검색어가 비었어요' });
        const src = url.searchParams.get('src');
        const range = dateRange(url.searchParams);
        if (src === 'all') {
          const { out, failed } = await searchAll(q, range);
          res.setHeader('x-failed', failed.join(','));
          return json(res, 200, out);
        }
        if (!SOURCES[src]) return json(res, 400, { error: 'unknown source' });
        const list = await cached(`${src}:${range.qdr}:${q}`, () => searchSource(src, q, range.qdr));
        if (range.min != null) await withYtDates(list);
        return json(res, 200, list.filter(inRange(range)));
      }
      if (req.method === 'GET' && p === '/api/scenes') return json(res, 200, searchScenes((url.searchParams.get('q') || '').trim()));
      if (req.method === 'GET' && p === '/api/analyze') {
        const id = url.searchParams.get('id');
        if (id) {
          const item = load().find((v) => v.id === id && v.file);
          if (!item) return json(res, 404, { error: 'not found' });
          const meta = { boardId: id, title: item.title };
          return json(res, 200, await cached('a:file:' + id, () => analyze({ key: 'file_' + id, file: path.join(VIDEO_DIR, item.file), meta })));
        }
        const src = url.searchParams.get('src');
        const ref = url.searchParams.get('ref') || '';
        const link = url.searchParams.get('url') || '';
        if (!SOURCES[src] || !REF_OK.test(ref) || !linkOk(src, link)) return json(res, 400, { error: 'bad item' });
        const key = `${src}_${ref.replace(/[^\w-]/g, '_')}`;
        const meta = { src, ref, url: link, title: (url.searchParams.get('title') || '').slice(0, 300), channel: (url.searchParams.get('channel') || '').slice(0, 100) };
        return json(res, 200, await cached('a:' + key, () => analyze({ key, link, ytId: src === 'yt' ? ref : null, meta })));
      }
      if (req.method === 'POST' && p === '/api/save') {
        const { src, ref, url: link, title, channel } = JSON.parse((await readBody(req)).toString() || '{}');
        if (!SOURCES[src] || !REF_OK.test(ref || '') || !linkOk(src, link)) return json(res, 400, { error: 'bad item' });
        const list = load();
        const hit = list.find((v) => v.src === src && v.ref === ref);
        if (hit) return json(res, 200, hit);
        const item = { id: crypto.randomUUID().slice(0, 8), src, ref, url: String(link), title: String(title || ''), channel: String(channel || ''), tags: [], memo: '', created: Date.now() };
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
  .listen(PORT, () => console.log(`ref → http://localhost:${PORT}`));
