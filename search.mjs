// Search logic shared by the local server (server.mjs) and the Cloudflare Worker (worker.js).
// Only uses fetch/URL/BigInt, so it runs in both. The caller supplies webSearch(query, qdr) -> [{url,title,description}].

// ponytail: unbounded in-memory cache, fine for one person; add LRU/TTL if it runs for weeks.
const cache = new Map();
export const cached = async (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
};

// None of these platforms offers a public content search, so find posts through a web search
// (Firecrawl, site: filter) and play them with each platform's own embed. `re` pulls out the id the embed needs.
export const SOURCES = {
  yt: { site: 'youtube.com/shorts', host: /(^|\.)youtube\.com$/, re: /youtube\.com\/shorts\/([\w-]{11})/ },
  ig: { site: 'instagram.com', host: /(^|\.)instagram\.com$/, re: /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/ },
  tt: { site: 'tiktok.com', host: /(^|\.)tiktok\.com$/, re: /tiktok\.com\/@[\w.-]+\/video\/(\d+)/ },
  pin: { site: 'pinterest.com/pin', host: /(^|\.)pinterest\.[a-z.]+$/, re: /pinterest\.[\w.]+\/pin\/(?:[\w-]*--)?(\d+)/ },
  th: { site: 'threads.com', host: /(^|\.)threads\.(com|net)$/, re: /threads\.(?:com|net)\/(@[\w.]+\/post\/[\w-]+)/ },
};
export const REF_OK = /^@?[\w.\/-]{1,80}$/;
// A link we hand to yt-dlp must really point at that platform (not just contain its path somewhere).
export const linkOk = (src, link) => {
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
export function dateRange(params) {
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
export const withYtDates = (list) => pool(list.filter((v) => v.src === 'yt' && v.date == null), 10, async (v) => (v.date = await ytTime(v.ref).catch(() => null)));
// Run fn over items, at most n at a time (YouTube date lookups: 40 at once gets throttled).
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export async function searchSource(webSearch, src, q, qdr) {
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

export const inRange = (range) => (v) => range.min == null || (v.date != null && v.date >= range.min && v.date <= range.max);

// "all": every source in parallel, interleaved so one platform doesn't bury the rest. A failing source is skipped.
// Results per platform per search. Firecrawl bills by results (measured: 40 results = 8 credits), so 20 halves it.
export const PER_SOURCE = 20;

// Saved searches: the same query+platform+period reuses the stored results instead of spending credits again.
// store = { get(key) -> {at, list} | null, set(key, {at, list}) } — a folder on the PC, a D1 table on Cloudflare.
// ponytail: 3-day freshness is a guess; shorten if results feel stale, lengthen to save more credits.
const SAVED_FOR = 3 * 86_400_000;
async function saved(store, key, fn) {
  if (!store) return fn();
  const hit = await store.get(key).catch(() => null);
  if (hit && Date.now() - hit.at < SAVED_FOR) return hit.list;
  const list = await fn();
  await store.set(key, { at: Date.now(), list }).catch(() => {});
  return list;
}
const getList = (webSearch, store, src, q, qdr) => {
  const key = `${src}:${qdr}:${q.toLowerCase()}`;
  return cached(key, () => saved(store, key, () => searchSource(webSearch, src, q, qdr)));
};

export async function searchAll(webSearch, store, q, range) {
  const settled = await Promise.allSettled(Object.keys(SOURCES).map((s) => getList(webSearch, store, s, q, range.qdr)));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason; // e.g. Firecrawl 429 — show it instead of "0 results"
  if (range.min != null) await withYtDates(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  const lists = settled.map((r) => (r.status === 'fulfilled' ? r.value.filter(inRange(range)) : []));
  const failed = Object.keys(SOURCES).filter((_, i) => settled[i].status === 'rejected');
  const out = [];
  for (let i = 0; i < PER_SOURCE; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return { out, failed };
}


// Firecrawl's REST search (v2). Needs an API key.
export async function firecrawlSearch(key, query, qdr) {
  const r = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit: PER_SOURCE, ...(qdr && { tbs: `qdr:${qdr}` }) }),
  });
  if (r.status === 429) throw new Error('검색 한도를 넘었어요. 1분쯤 뒤에 다시 해보세요.');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `Firecrawl ${r.status}`);
  return j.data?.web || [];
}

// GET /api/search, as { status, body, failed } so both runtimes can wrap it in their own response type.
export async function handleSearch(params, webSearch, store) {
  const q = (params.get('q') || '').trim();
  if (!q) return { status: 400, body: { error: '검색어가 비었어요' } };
  const src = params.get('src');
  const range = dateRange(params);
  if (src === 'all') {
    const { out, failed } = await searchAll(webSearch, store, q, range);
    return { status: 200, body: out, failed };
  }
  if (!SOURCES[src]) return { status: 400, body: { error: 'unknown source' } };
  const list = await getList(webSearch, store, src, q, range.qdr);
  if (range.min != null) await withYtDates(list);
  return { status: 200, body: list.filter(inRange(range)) };
}

// POST /api/save body -> board item, or null if it doesn't point at a real post.
export function newBoardItem({ src, ref, url, title, channel }, id) {
  if (!SOURCES[src] || !REF_OK.test(ref || '') || !linkOk(src, url)) return null;
  return { id, src, ref, url: String(url), title: String(title || ''), channel: String(channel || ''), tags: [], memo: '', created: Date.now() };
}
