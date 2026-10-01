// Cloudflare Worker: the always-on half of ref. Serves the page, search (Firecrawl) and the board (D1).
// Analysis, "영상 속 말" search, uploads and their media need ffmpeg/yt-dlp/Whisper, so those requests are
// proxied to the analysis PC (server.mjs), which registers its Cloudflare Tunnel URL here via /api/analyzer.
//
// Secrets: APP_PASSWORD (site login), FIRECRAWL_API_KEY, ANALYZER_TOKEN (shared with the PC's .cloud.json).
import { handleSearch, firecrawlSearch, firecrawlCredits, creditStatus, newBoardItem, fetchStats, youtubeApiSearch, firstOf, analysisKey, matchScenes, SOURCES, REF_OK } from './search.mjs';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// ---- Sign-in ----
// With Google configured (GOOGLE_CLIENT_ID/SECRET, SESSION_SECRET) people sign in with Google; a signed cookie keeps
// them in for 30 days. Who may enter:
//   ALLOWED_EMAILS set  -> only those accounts.
//   not set             -> any Google account (the link is only shared with the team); BLOCKED_EMAILS shuts people out.
// Everyone who signs in is recorded in the users table. Without Google config: the old shared password (APP_PASSWORD).
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (env) => crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const googleOn = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
const emails = (list) => (list || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const mayEnter = (env, email) => (env.ALLOWED_EMAILS ? emails(env.ALLOWED_EMAILS).includes(email) : !emails(env.BLOCKED_EMAILS).includes(email));
// How many people share the daily search budget: the allowlist, or everyone who has signed in so far.
const peopleCount = async (env) =>
  env.ALLOWED_EMAILS ? emails(env.ALLOWED_EMAILS).length : (await env.DB.prepare('SELECT count(*) AS n FROM users').first())?.n || 1;
const cookie = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.get('cookie') || '')?.[1];

async function makeSession(env, user) {
  const body = b64url(enc.encode(JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 86400e3 })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  return `${body}.${sig}`;
}
async function readSession(env, req) {
  const [body, sig] = (cookie(req, 'ref_session') || '').split('.');
  if (!body || !sig) return null;
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), enc.encode(body)))) return null;
  const s = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  // Re-check on every request, so removing/blocking an email locks that person out right away.
  if (!(s.exp > Date.now() && mayEnter(env, s.email))) return null;
  const row = await env.DB.prepare('SELECT blocked FROM users WHERE email = ?').bind(s.email).first();
  return row?.blocked ? null : s;
}

// Who is asking: { email, name, picture } with Google, { email: 'shared' } with the old password, or null.
async function currentUser(req, env) {
  if (googleOn(env)) return readSession(env, req);
  return (await passwordOk(req, env)) ? { email: 'shared', name: '' } : null;
}

async function passwordOk(req, env) {
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
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const [a, b] = await Promise.all([h(pass), h(env.APP_PASSWORD.trim())]);
  return a.every((x, i) => x === b[i]);
}

const page = (title, body) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f5f6f8;color:#17181c;font:15px/1.6 -apple-system,"Pretendard",system-ui,sans-serif}
@media(prefers-color-scheme:dark){body{background:#0f1012;color:#eceef2}.box{background:#18191c!important;border-color:#2a2c31!important}}
.box{background:#fff;border:1px solid #e6e8ec;border-radius:18px;padding:36px 32px;max-width:360px;width:calc(100% - 32px);text-align:center}
h1{margin:0 0 6px;font-size:26px;letter-spacing:-.6px}h1 span{color:#2f5bff}p{color:#7a7d86;margin:0 0 22px}
a.g{display:flex;gap:10px;align-items:center;justify-content:center;padding:11px 16px;border:1px solid #dadce0;border-radius:12px;background:#fff;color:#1f1f1f;text-decoration:none;font-weight:600}
a.s{display:inline-block;margin-top:14px;color:#7a7d86;font-size:13px}</style><div class="box">${body}</div>`,
    // no-store: going "back" to this page must ask the server again (signed in → the app), not show a stale copy.
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
// Google refuses sign-in inside app browsers (카카오톡 etc. → "disallowed_useragent"), so say how to get out first.
const loginPage = (msg = '운영진 계정으로 들어와 주세요.', ua = '') => {
  if (/KAKAOTALK/i.test(ua))
    return page('ref 로그인', `<h1>re<span>f</span></h1><p>카카오톡 안에서는 구글 로그인이 막혀 있어요.<br>아래 버튼으로 바깥 브라우저에서 열어 주세요.</p>
      <a class="g" href="#" id="ext">다른 브라우저로 열기</a>
      <p style="font-size:13px;margin-top:14px">안 되면 오른쪽 아래 ⋯ → <b>다른 브라우저로 열기</b>를 눌러 주세요.</p>
      <script>document.getElementById('ext').href='kakaotalk://web/openExternal?url='+encodeURIComponent(location.origin)</script>`);
  if (/NAVER\(|Instagram|FBAN|FBAV|Line\//i.test(ua))
    return page('ref 로그인', `<h1>re<span>f</span></h1><p>앱 안의 브라우저에서는 구글 로그인이 막혀 있어요.<br>메뉴에서 <b>외부 브라우저로 열기</b>를 눌러 주세요.</p>`);
  // replace(): the login page leaves no history entry, so "back" from the app can't land on it.
  // On load / when restored from the back-forward cache, already signed in -> straight into the app.
  return page('ref 로그인', `<h1>re<span>f</span></h1><p>${msg}</p><a class="g" href="/auth/login" onclick="location.replace(this.href);return false">${GOOGLE_G}Google 계정으로 로그인</a>
    <script>
      const check = () => fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' }).then((r) => { if (r.ok) location.replace('/'); }).catch(() => {});
      check(); addEventListener('pageshow', (e) => { if (e.persisted) check(); });
    </script>`);
};

// /auth/* routes. Returns a Response, or null if the path isn't one of them.
async function authRoutes(req, env, url) {
  const p = url.pathname;
  if (!p.startsWith('/auth/') || !googleOn(env)) return null;
  const redirect = `${url.origin}/auth/callback`;
  const secure = 'HttpOnly; Secure; SameSite=Lax; Path=/';
  if (p === '/auth/login') {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const to = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
    });
    return new Response(null, { status: 302, headers: { location: to, 'set-cookie': `ref_state=${state}; Max-Age=600; ${secure}` } });
  }
  if (p === '/auth/callback') {
    const state = url.searchParams.get('state');
    if (!state || state !== cookie(req, 'ref_state')) return loginPage('로그인이 만료됐어요. 다시 시도해 주세요.');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) return loginPage('구글 로그인에 실패했어요. 다시 시도해 주세요.');
    // The id_token came straight from Google's token endpoint over TLS, so its claims can be trusted as-is.
    const c = JSON.parse(new TextDecoder().decode(fromB64url(tok.id_token.split('.')[1])));
    const email = String(c.email || '').toLowerCase();
    if (!c.email_verified || !mayEnter(env, email))
      return page('ref', `<h1>re<span>f</span></h1><p>${email.replace(/[<>&"]/g, '')} 계정은 들어올 수 없어요.<br>운영자에게 문의해 주세요.</p><a class="g" href="/auth/login">다른 계정으로 로그인</a>`);
    const known = await env.DB.prepare('SELECT blocked FROM users WHERE email = ?').bind(email).first();
    if (known?.blocked) return page('ref', `<h1>re<span>f</span></h1><p>이 계정은 이용이 중지됐어요.<br>운영자에게 문의해 주세요.</p>`);
    if (!known) {
      await env.DB.prepare('INSERT OR IGNORE INTO users (email, name, at) VALUES (?, ?, ?)').bind(email, String(c.name || ''), Date.now()).run();
      await telegram(env, `🔔 ref 새 로그인\n${c.name || ''} (${email})\n모르는 사람이면 관리 화면에서 차단하세요: ${url.origin}/#admin`).catch(() => {});
    }
    const session = await makeSession(env, { email, name: c.name || email, picture: c.picture || '' });
    return new Response(null, { status: 302, headers: [['location', '/'], ['cache-control', 'no-store'], ['set-cookie', `ref_session=${session}; Max-Age=${SESSION_DAYS * 86400}; ${secure}`], ['set-cookie', `ref_state=; Max-Age=0; ${secure}`]] });
  }
  if (p === '/auth/logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `ref_session=; Max-Age=0; ${secure}` } });
  return null;
}

// ---- Admin + Telegram alerts ----
// Admins: ADMIN_EMAILS, or else whoever signed in first (the owner, who shares the link).
async function isAdmin(env, email) {
  if (env.ADMIN_EMAILS) return emails(env.ADMIN_EMAILS).includes(email);
  const first = await env.DB.prepare('SELECT email FROM users ORDER BY at LIMIT 1').first();
  return first?.email === email;
}
// TELEGRAM_BOT_TOKEN (from @BotFather) + the chat to post to (found by /api/admin/telegram after you message the bot).
async function telegram(env, text) {
  const chat = env.TELEGRAM_BOT_TOKEN && (await env.DB.prepare("SELECT v FROM kv WHERE k = 'telegram_chat'").first())?.v;
  if (!chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }),
  });
  return r.ok;
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

    // The PC copying a finished analysis (JSON + small scene frames) here. Token-protected.
    const up = /^\/api\/(analysis|media)\/([\w-]{1,120})(?:\/(t\d{3}\.jpg))?$/.exec(p);
    if (m === 'PUT' && up) {
      if (!env.ANALYZER_TOKEN || req.headers.get('x-ref-token') !== env.ANALYZER_TOKEN) return json({ error: 'forbidden' }, 403);
      const [, kind, key, file] = up;
      if (kind === 'analysis' && !file) {
        await env.DB.prepare('INSERT OR REPLACE INTO analyses (k, v, at) VALUES (?, ?, ?)').bind(key, await req.text(), Date.now()).run();
        return json({ ok: true });
      }
      if (kind === 'media' && file) {
        const data = await req.arrayBuffer();
        if (data.byteLength > 1_000_000) return json({ error: 'too big' }, 413);
        await env.DB.prepare('INSERT OR REPLACE INTO media (k, type, data) VALUES (?, ?, ?)').bind(`${key}/${file}`, 'image/jpeg', data).run();
        return json({ ok: true });
      }
      return json({ error: 'bad path' }, 400);
    }

    // Install bits are fetched by the browser without cookies (manifest, icons, service worker): serve them to anyone.
    if (m === 'GET' && (p === '/manifest.json' || p === '/sw.js' || /^\/icons\/[\w-]+\.png$/.test(p))) return env.ASSETS.fetch(req);
    const authResp = await authRoutes(req, env, url);
    if (authResp) return authResp;
    const user = await currentUser(req, env);
    if (!user) {
      if (!googleOn(env)) return new Response('로그인이 필요해요', { status: 401, headers: { 'www-authenticate': 'Basic realm="ref", charset="UTF-8"' } });
      return p.startsWith('/api/') ? json({ error: '로그인이 필요해요' }, 401) : loginPage(undefined, req.headers.get('user-agent') || '');
    }
    const people = googleOn(env) ? await peopleCount(env) : 1;
    const who = googleOn(env) ? user.email : undefined;

    try {
      if (m === 'GET' && p === '/api/status') return json({ analyzer: !!(await analyzer(env)) });
      const store = {
        get: async (k) => { const r = await env.DB.prepare('SELECT v FROM searches WHERE k = ?').bind(k).first(); return r && JSON.parse(r.v); },
        set: (k, v) => env.DB.prepare('INSERT OR REPLACE INTO searches (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run(),
      };
      const readCredits = () => firecrawlCredits(env.FIRECRAWL_API_KEY);
      // YouTube without credits: the YouTube Data API (works with the PC off; 100 searches/day), then the PC's
      // yt-dlp if it's on. Only if both fail does YouTube go through Firecrawl.
      const pc = (p === '/api/search' || p === '/api/credits') && (await analyzer(env));
      const ytFree = [
        env.YOUTUBE_API_KEY && ((q, qdr) => youtubeApiSearch(env.YOUTUBE_API_KEY, q, qdr)),
        pc && (async (q) => {
          const r = await fetch(`${pc}/api/ytsearch?q=${encodeURIComponent(q)}`, { headers: { 'x-ref-token': env.ANALYZER_TOKEN } });
          if (!r.ok) throw new Error('PC search failed');
          return r.json();
        }),
      ].filter(Boolean);
      const free = ytFree.length ? { yt: firstOf(ytFree) } : undefined;
      const admin = googleOn(env) && (await isAdmin(env, user.email));
      if (m === 'GET' && p === '/api/me') return json({ email: user.email, name: user.name, picture: user.picture || '', google: googleOn(env), admin });
      if (p.startsWith('/api/admin/')) {
        if (!admin) return json({ error: '관리자만 쓸 수 있어요' }, 403);
        if (m === 'GET' && p === '/api/admin/users') {
          const rows = (await env.DB.prepare('SELECT email, name, at, blocked FROM users ORDER BY at').all()).results;
          const chat = await env.DB.prepare("SELECT v FROM kv WHERE k = 'telegram_chat'").first();
          return json({ users: rows, me: user.email, telegram: { token: !!env.TELEGRAM_BOT_TOKEN, linked: !!chat } });
        }
        if (m === 'POST' && p === '/api/admin/block') {
          const { email, blocked } = await req.json();
          if (email === user.email) return json({ error: '자기 자신은 차단할 수 없어요' }, 400);
          await env.DB.prepare('UPDATE users SET blocked = ? WHERE email = ?').bind(blocked ? 1 : 0, String(email)).run();
          return json({ ok: true });
        }
        if (m === 'POST' && p === '/api/admin/telegram') {
          // Link the chat that last messaged the bot, then send a test message there.
          if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN 이 아직 없어요' }, 400);
          const u = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`)).json();
          const chat = (u.result || []).map((x) => x.message?.chat?.id).filter(Boolean).pop();
          if (!chat) return json({ error: '봇에게 먼저 아무 메시지나 보내 주세요' }, 400);
          await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('telegram_chat', ?)").bind(String(chat)).run();
          const ok = await telegram(env, '✅ ref 알림이 연결됐어요. 새로운 사람이 처음 로그인하면 여기로 알려드릴게요.');
          return json({ ok });
        }
        return json({ error: 'not found' }, 404);
      }
      if (m === 'GET' && p === '/api/credits') return json(await creditStatus(store, readCredits, free, who, people));
      if (m === 'GET' && p === '/api/search') {
        const r = await handleSearch(url.searchParams, (q, qdr) => firecrawlSearch(env.FIRECRAWL_API_KEY, q, qdr), store, readCredits, free, who, people);
        return json(r.body, r.status, r.failed ? { 'x-failed': r.failed.join(',') } : {});
      }

      if (m === 'GET' && p === '/api/stats') {
        const src = url.searchParams.get('src');
        const ref = url.searchParams.get('ref') || '';
        if (!SOURCES[src] || !REF_OK.test(ref)) return json({ error: 'bad item' }, 400);
        return json(await fetchStats(src, ref).catch(() => ({})));
      }

      // Board (D1)
      // Each account has its own scrapbook (owner = email). The shared-password mode keeps one common board.
      const mine = (v) => !googleOn(env) || v.owner === user.email;
      if (m === 'GET' && p === '/api/videos') return json((await all(env)).filter(mine));
      if (m === 'POST' && p === '/api/save') {
        const item = newBoardItem(await req.json(), crypto.randomUUID().slice(0, 8));
        if (!item) return json({ error: 'bad item' }, 400);
        item.owner = user.email;
        const hit = (await all(env)).find((v) => mine(v) && v.src === item.src && v.ref === item.ref);
        if (hit) return json(hit);
        await put(env, item);
        return json(item, 201);
      }
      if (m === 'POST' && p === '/api/upload') {
        // The PC stores the file (and knows it for analysis); the board entry lives here.
        const r = await proxy(req, env, p + url.search);
        if (!r.ok) return r;
        const item = await r.json();
        item.owner = user.email;
        await put(env, item);
        return json(item, 201);
      }
      const id = /^\/api\/videos\/([\w-]+)$/.exec(p)?.[1];
      if (id) {
        const row = await env.DB.prepare('SELECT data FROM items WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        const v = JSON.parse(row.data);
        if (!mine(v)) return json({ error: 'not found' }, 404);
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

      // Saved analyses (copied here by the PC) answer without the PC; a new analysis still needs it.
      if (m === 'GET' && p === '/api/analyze') {
        const sp = url.searchParams;
        const key = sp.get('id') ? 'file_' + sp.get('id') : SOURCES[sp.get('src')] && REF_OK.test(sp.get('ref') || '') ? analysisKey(sp.get('src'), sp.get('ref')) : null;
        const row = key && (await env.DB.prepare('SELECT v FROM analyses WHERE k = ?').bind(key).first());
        if (row) {
          const a = JSON.parse(row.v);
          if (await analyzer(env)) a.video = `/cache/${key}/video.mp4`; // PC on: play its exact copy (scene clicks seek)
          return json(a);
        }
        return proxy(req, env, p + url.search);
      }
      if (m === 'GET' && p === '/api/scenes') {
        const rows = (await env.DB.prepare('SELECT v FROM analyses').all()).results;
        return json(matchScenes(rows.map((r) => JSON.parse(r.v)), (url.searchParams.get('q') || '').trim()));
      }
      const media = /^\/m\/([\w-]{1,120}\/t\d{3}\.jpg)$/.exec(p);
      if (m === 'GET' && media) {
        const row = await env.DB.prepare('SELECT type, data FROM media WHERE k = ?').bind(media[1]).first();
        if (!row) return new Response('not found', { status: 404 });
        // D1 hands BLOBs back as a plain array of bytes; wrap it or the response body comes out empty.
        return new Response(new Uint8Array(row.data), { headers: { 'content-type': row.type, 'cache-control': 'private, max-age=31536000, immutable' } });
      }

      // Needs the analysis PC
      if (p.startsWith('/cache/') || p.startsWith('/videos/')) return proxy(req, env, p + url.search);
      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      const asset = await env.ASSETS.fetch(req);
      const res = new Response(asset.body, asset);
      if ((res.headers.get('content-type') || '').includes('text/html')) res.headers.set('cache-control', 'no-store');
      return res;
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
