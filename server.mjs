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

// yt-dlp does the YouTube search/caption lookup; execFile (no shell) keeps the query out of shell parsing.
const runJson = (bin, args) =>
  new Promise((ok, fail) =>
    execFile(bin, args, { maxBuffer: 64 << 20, timeout: 60_000 }, (e, out) => (e ? fail(e) : ok(JSON.parse(out)))),
  );
const ytdlp = (args) => runJson('yt-dlp', args);
// ponytail: unbounded in-memory cache, fine for one person; add LRU/TTL if it runs for weeks.
const cache = new Map();
const cached = async (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
};

async function searchYouTube(q) {
  // sp=EgIYAQ== is YouTube's "under 4 minutes" filter — keeps results short-form.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIYAQ%3D%3D`;
  const run = async () => (await ytdlp(['--flat-playlist', '-J', '--playlist-end', '40', url])).entries || [];
  // YouTube sometimes returns a thin first page (seen: 5 vs 21 for the same query); retry once and keep the bigger one.
  let entries = await run();
  if (entries.length < 10) entries = [entries, await run()].sort((a, b) => b.length - a.length)[0];
  return entries
    .filter((e) => e.id && e.duration)
    .map((e) => ({
      yt: e.id,
      title: e.title,
      channel: e.channel,
      duration: e.duration,
      views: e.view_count,
      thumb: e.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }));
}

// Instagram has no public search, so find reels through a web search (Firecrawl) and show them with Instagram's own embed.
async function searchInstagram(q) {
  const j = await runJson('firecrawl', ['search', `site:instagram.com/reel ${q}`, '--limit', '40', '--json']);
  const seen = new Set();
  return (j.data?.web || [])
    .map((r) => {
      const code = /instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p)\/([\w-]+)/.exec(r.url)?.[1];
      // Descriptions look like: '3 likes, 0 comments - c_pop_studio on June 11, 2025: "caption…'
      const m = /^([\d,.KkMm]+) likes?.*? - ([\w.]+) on [^:]+: "?(.*)/.exec(r.description || '');
      return code && { ig: code, title: (m?.[3] || r.title || '').replace(/ - Instagram$/, ''), channel: m?.[2] || '', likes: m?.[1] || '' };
    })
    // The same post often shows up under several URLs; drop repeats by code and by caption.
    .filter((v) => v && !seen.has(v.ig) && !seen.has(v.title) && seen.add(v.ig).add(v.title));
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
        const src = url.searchParams.get('src') === 'ig' ? 'ig' : 'yt';
        return json(res, 200, await cached(src + ':' + q, () => (src === 'ig' ? searchInstagram(q) : searchYouTube(q))));
      }
      if (req.method === 'GET' && p === '/api/script') {
        const id = url.searchParams.get('id') || '';
        if (!/^[\w-]{11}$/.test(id)) return json(res, 400, { error: 'bad id' });
        return json(res, 200, await cached('t:' + id, () => fetchScript(id)));
      }
      if (req.method === 'POST' && p === '/api/save') {
        const { yt, ig, title, channel, thumb } = JSON.parse((await readBody(req)).toString() || '{}');
        const ok = yt ? /^[\w-]{11}$/.test(yt) : /^[\w-]{5,40}$/.test(ig || '');
        if (!ok) return json(res, 400, { error: 'bad id' });
        const list = load();
        const hit = list.find((v) => (yt ? v.yt === yt : v.ig === ig));
        if (hit) return json(res, 200, hit);
        const item = { id: crypto.randomUUID().slice(0, 8), ...(yt ? { yt } : { ig }), title: String(title || ''), channel: String(channel || ''), thumb: String(thumb || ''), tags: [], memo: '', created: Date.now() };
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
