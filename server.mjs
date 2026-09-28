// Zero-dependency reference video library server.
// Videos live in ./videos, metadata in ./data.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const VIDEO_DIR = path.join(ROOT, 'videos');
const DATA = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 5173;
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };

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
  yt: { site: 'youtube.com/shorts', re: /youtube\.com\/shorts\/([\w-]{11})/ },
  ig: { site: 'instagram.com', re: /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/ },
  tt: { site: 'tiktok.com', re: /tiktok\.com\/@[\w.-]+\/video\/(\d+)/ },
  pin: { site: 'pinterest.com/pin', re: /pinterest\.[\w.]+\/pin\/(?:[\w-]*--)?(\d+)/ },
  th: { site: 'threads.com', re: /threads\.(?:com|net)\/(@[\w.]+\/post\/[\w-]+)/ },
};
const REF_OK = /^@?[\w.\/-]{1,80}$/;

const PERIODS = new Set(['w', 'm', 'y']); // past week / month / year (Google-style qdr filter)

async function searchSource(src, q, period) {
  const { site, re } = SOURCES[src];
  const args = ['search', `site:${site} ${q}`, '--limit', '40', '--json', ...(period ? ['--tbs', `qdr:${period}`] : [])];
  const hits = (await runJson('firecrawl', args)).data?.web || [];
  const seen = new Set(); // the same post often shows up under several URLs; drop repeats by id and by caption
  return hits
    .map((r) => {
      const ref = re.exec(r.url)?.[1];
      // Meta descriptions look like: '3 likes, 0 comments - c_pop_studio on June 11, 2025: "caption…'
      const m = /^([\d,.KkMm]+) likes?.*? - ([\w.]+) on [^:]+: "?(.*)/.exec(r.description || '');
      const title = (m?.[3] || r.title || '').replace(/\s*[-|]\s*(YouTube|Instagram|TikTok|Pinterest|Threads)$/i, '').trim();
      return ref && { src, ref, url: r.url, title, channel: m?.[2] || '', likes: m?.[1] || '' };
    })
    .filter((v) => v && !seen.has(v.ref) && !seen.has(v.title) && seen.add(v.ref).add(v.title));
}

// "all": every source in parallel, interleaved so one platform doesn't bury the rest. A failing source is skipped.
async function searchAll(q, period) {
  const settled = await Promise.allSettled(Object.keys(SOURCES).map((s) => cached(`${s}:${period}:${q}`, () => searchSource(s, q, period))));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason; // e.g. Firecrawl 429 — show it instead of "0 results"
  const lists = settled.map((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = Object.keys(SOURCES).filter((_, i) => settled[i].status === 'rejected');
  const out = [];
  for (let i = 0; i < 40; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return { out, failed };
}

async function fetchScript(id) {
  const j = await ytdlp(['-j', '--skip-download', `https://www.youtube.com/watch?v=${id}`]);
  const subs = j.subtitles || {};
  const auto = j.automatic_captions || {};
  const track = subs.ko || auto.ko || Object.values(subs)[0] || auto.en;
  const url = track?.find((t) => t.ext === 'json3')?.url;
  if (!url) return [];
  const d = await (await fetch(url)).json();
  return (d.events || [])
    .filter((e) => e.segs)
    .map((e) => [Math.floor(e.tStartMs / 1000), e.segs.map((s) => s.utf8).join('').trim()])
    .filter(([, t]) => t);
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

function serveVideo(req, res, name) {
  const file = path.join(VIDEO_DIR, path.basename(name)); // basename blocks ../ traversal
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
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
      if (req.method === 'GET' && p.startsWith('/videos/')) return serveVideo(req, res, decodeURIComponent(p.slice(8)));
      if (req.method === 'GET' && p === '/api/videos') return json(res, 200, load());
      if (req.method === 'GET' && p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json(res, 400, { error: '검색어가 비었어요' });
        const src = url.searchParams.get('src');
        const period = PERIODS.has(url.searchParams.get('period')) ? url.searchParams.get('period') : '';
        if (src === 'all') {
          const { out, failed } = await searchAll(q, period);
          res.setHeader('x-failed', failed.join(','));
          return json(res, 200, out);
        }
        if (!SOURCES[src]) return json(res, 400, { error: 'unknown source' });
        return json(res, 200, await cached(`${src}:${period}:${q}`, () => searchSource(src, q, period)));
      }
      if (req.method === 'GET' && p === '/api/script') {
        const id = url.searchParams.get('id') || '';
        if (!/^[\w-]{11}$/.test(id)) return json(res, 400, { error: 'bad id' });
        return json(res, 200, await cached('t:' + id, () => fetchScript(id)));
      }
      if (req.method === 'POST' && p === '/api/save') {
        const { src, ref, url: link, title, channel } = JSON.parse((await readBody(req)).toString() || '{}');
        if (!SOURCES[src] || !REF_OK.test(ref || '') || !SOURCES[src].re.test(link || '')) return json(res, 400, { error: 'bad item' });
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
