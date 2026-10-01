// Cloudflare Worker: the always-on half of ref. Serves the page, search (Firecrawl) and the board (D1).
// Analysis, "영상 속 말" search, uploads and their media need ffmpeg/yt-dlp/Whisper, so those requests are
// proxied to the analysis PC (server.mjs), which registers its Cloudflare Tunnel URL here via /api/analyzer.
//
// Secrets: APP_PASSWORD (site login), FIRECRAWL_API_KEY, ANALYZER_TOKEN (shared with the PC's .cloud.json).
import { handleSearch, firecrawlSearch, newBoardItem, fetchStats, SOURCES, REF_OK } from './search.mjs';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// Whole site behind one password (HTTP Basic; any user name). Constant-time-ish compare via hashing.
async function authed(req, env) {
  const m = /^Basic (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m || !env.APP_PASSWORD?.trim()) return false;
  // Browsers send the credentials as UTF-8 (we ask for it in the realm); atob alone would mangle 한글 passwords.
  let raw;
  try {
    raw = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  // Trim both sides: a pasted secret or typed password often carries a stray space/newline.
  const pass = raw.split(':').slice(1).join(':').trim();
  env = { ...env, APP_PASSWORD: env.APP_PASSWORD.trim() };
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(pass), h(env.APP_PASSWORD)]);
  return a.every((x, i) => x === b[i]);
}

const OFFLINE_AFTER = 15 * 60_000; // the PC re-registers every 5 min
async function analyzer(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'analyzer'").first();
  const a = row && JSON.parse(row.v);
  return a && Date.now() - a.seen < OFFLINE_AFTER ? a.url : null;
}

// Forward to the analysis PC, streaming the body both ways (video uploads, range requests for playback).
async function proxy(req, env, path) {
  const base = await analyzer(env);
  if (!base) return json({ error: '분석 PC가 꺼져 있어요. PC에서 ref 를 실행하면 영상 분석이 다시 돼요.' }, 503);
  const headers = new Headers({ 'x-ref-token': env.ANALYZER_TOKEN });
  for (const h of ['range', 'content-type']) if (req.headers.get(h)) headers.set(h, req.headers.get(h));
  const r = await fetch(base + path, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? null : req.body });
  return new Response(r.body, r);
}

const all = async (env) => (await env.DB.prepare('SELECT data FROM items ORDER BY created DESC').all()).results.map((r) => JSON.parse(r.data));
const put = (env, v) => env.DB.prepare('INSERT OR REPLACE INTO items (id, data, created) VALUES (?, ?, ?)').bind(v.id, JSON.stringify(v), v.created).run();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // The PC announcing its tunnel URL. Token-protected instead of password-protected.
    if (m === 'POST' && p === '/api/analyzer') {
      if (!env.ANALYZER_TOKEN || req.headers.get('x-ref-token') !== env.ANALYZER_TOKEN) return json({ error: 'forbidden' }, 403);
      const { url: tunnel } = await req.json();
      if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(tunnel || '')) return json({ error: 'bad url' }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('analyzer', ?)").bind(JSON.stringify({ url: tunnel, seen: Date.now() })).run();
      return json({ ok: true });
    }

    if (!(await authed(req, env))) return new Response('로그인이 필요해요', { status: 401, headers: { 'www-authenticate': 'Basic realm="ref", charset="UTF-8"' } });

    try {
      if (m === 'GET' && p === '/api/status') return json({ analyzer: !!(await analyzer(env)) });
      if (m === 'GET' && p === '/api/search') {
        const store = {
          get: async (k) => { const r = await env.DB.prepare('SELECT v FROM searches WHERE k = ?').bind(k).first(); return r && JSON.parse(r.v); },
          set: (k, v) => env.DB.prepare('INSERT OR REPLACE INTO searches (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run(),
        };
        const r = await handleSearch(url.searchParams, (q, qdr) => firecrawlSearch(env.FIRECRAWL_API_KEY, q, qdr), store);
        return json(r.body, r.status, r.failed ? { 'x-failed': r.failed.join(',') } : {});
      }

      if (m === 'GET' && p === '/api/stats') {
        const src = url.searchParams.get('src');
        const ref = url.searchParams.get('ref') || '';
        if (!SOURCES[src] || !REF_OK.test(ref)) return json({ error: 'bad item' }, 400);
        return json(await fetchStats(src, ref).catch(() => ({})));
      }

      // Board (D1)
      if (m === 'GET' && p === '/api/videos') return json(await all(env));
      if (m === 'POST' && p === '/api/save') {
        const item = newBoardItem(await req.json(), crypto.randomUUID().slice(0, 8));
        if (!item) return json({ error: 'bad item' }, 400);
        const hit = (await all(env)).find((v) => v.src === item.src && v.ref === item.ref);
        if (hit) return json(hit);
        await put(env, item);
        return json(item, 201);
      }
      if (m === 'POST' && p === '/api/upload') {
        // The PC stores the file (and knows it for analysis); the board entry lives here.
        const r = await proxy(req, env, p + url.search);
        if (!r.ok) return r;
        const item = await r.json();
        await put(env, item);
        return json(item, 201);
      }
      const id = /^\/api\/videos\/([\w-]+)$/.exec(p)?.[1];
      if (id) {
        const row = await env.DB.prepare('SELECT data FROM items WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        const v = JSON.parse(row.data);
        if (m === 'PATCH') {
          const { title, tags, memo } = await req.json();
          if (typeof title === 'string') v.title = title;
          if (Array.isArray(tags)) v.tags = tags.map(String).map((t) => t.trim()).filter(Boolean);
          if (typeof memo === 'string') v.memo = memo;
          await put(env, v);
          return json(v);
        }
        if (m === 'DELETE') {
          if (v.file) await proxy(req, env, p).catch(() => {}); // also drop the uploaded file on the PC
          await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }
      }

      // Needs the analysis PC
      if (p === '/api/analyze' || p === '/api/scenes' || p.startsWith('/cache/') || p.startsWith('/videos/')) return proxy(req, env, p + url.search);
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
