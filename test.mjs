// Self-check for the logic that's easy to break: run `node test.mjs` (no network; Google/Telegram/Firecrawl/YouTube faked).
// Covers search.mjs (ranking, dates, budget, YouTube API parsing) and worker.js (sign-in, admin, per-account
// scrapbook, Telegram commands) on an in-memory SQLite standing in for D1.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as s from './search.mjs';
import worker from './worker.js';

const realFetch = globalThis.fetch;
let fake = () => null; // per-test fetch override: return a Response to intercept, null to fall through
globalThis.fetch = async (u, o) => (await fake(String(u), o)) ?? realFetch(u, o);
const ok = (name) => console.log('ok -', name);

// ---- search.mjs ----
{
  for (const [x, n] of [['1.8천', 1800], ['3만', 30000], ['1,234', 1234], ['12K', 12000], [408600, 408600], ['', null], [null, null]]) assert.equal(s.parseCount(x), n);
  const order = [{ t: 'ig', likes: '500' }, { t: 'tt', views: 1000, shares: 5 }, { t: 'yt', views: 1000, shares: 9 }, { t: 'pin', saves: 30 }, { t: 'yt2', views: 50000 }, { t: 'th' }]
    .sort(s.byPopular).map((v) => v.t);
  assert.deepEqual(order, ['yt2', 'yt', 'tt', 'ig', 'pin', 'th']);
  ok('ranking: views > shares > likes > saves, unknown last');

  assert.equal(s.dateRange(new URLSearchParams({ period: 'w' })).qdr, 'w');
  assert.equal(s.dateRange(new URLSearchParams({})).min, null);
  const r = s.dateRange(new URLSearchParams({ period: 'custom', from: '2026-07-01', to: '2026-07-31' }));
  assert.ok(r.max - r.min > 30 * 864e5 && ['m', 'y', ''].includes(r.qdr));
  ok('date ranges');

  assert.ok(s.newBoardItem({ src: 'yt', ref: 'abcdefghijk', url: 'https://www.youtube.com/shorts/abcdefghijk' }, 'x'));
  assert.equal(s.newBoardItem({ src: 'yt', ref: 'abcdefghijk', url: 'https://evil.com/?youtube.com/shorts/abcdefghijk' }, 'x'), null);
  ok('board items only for real platform links');

  // daily budget: 24 credits left, 2 days -> 12/day, 3 people -> 4 each
  const mem = new Map();
  const store = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => mem.set(k, v) };
  let left = 24;
  const read = async () => ({ remainingCredits: left, planCredits: 1000, billingPeriodEnd: new Date(Date.now() + 2 * 864e5 - 1000).toISOString() });
  const web = async () => ((left -= 2), []);
  const run = async (who, q) => (await s.handleSearch(new URLSearchParams({ q, src: 'tt' }), web, store, read, undefined, who, 3)).status;
  assert.equal((await s.creditStatus(store, read, undefined, 'a', 3)).share, 4);
  assert.deepEqual([await run('a', 'q1'), await run('a', 'q2'), await run('a', 'q3')], [200, 200, 429]);
  assert.equal(await run('b', 'q4'), 200);
  assert.equal(await run('a', 'q1'), 200); // saved search: free
  ok('daily budget, per-person share, saved searches free');

  fake = (u) => (u.includes('/search?')
    ? new Response(JSON.stringify({ items: [
      { id: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'A &amp; B&#39;s', channelTitle: 'c', publishedAt: '2026-09-01T00:00:00Z' } },
      { id: { videoId: 'bbbbbbbbbbb' }, snippet: { title: 'long', channelTitle: 'c', publishedAt: '2026-08-01T00:00:00Z' } },
      { id: { videoId: 'ccccccccccc' }, snippet: { title: 'C', channelTitle: 'c', publishedAt: '2026-07-01T00:00:00Z' } }] }))
    : u.includes('/videos?') ? new Response(JSON.stringify({ items: [
      { id: 'aaaaaaaaaaa', statistics: { viewCount: '100' }, contentDetails: { duration: 'PT45S' } },
      { id: 'bbbbbbbbbbb', statistics: { viewCount: '999999' }, contentDetails: { duration: 'PT3M30S' } },
      { id: 'ccccccccccc', statistics: { viewCount: '5000' }, contentDetails: { duration: 'PT1M' } }] })) : null);
  const yt = await s.youtubeApiSearch('k', 'q', 'm');
  assert.deepEqual(yt.map((v) => v.ref), ['ccccccccccc', 'aaaaaaaaaaa']); // >3 min dropped, most viewed first
  assert.equal(yt[1].title, "A & B's");
  assert.deepEqual(await s.firstOf([async () => { throw new Error('x'); }, async () => ['fallback']])('q'), ['fallback']);
  fake = () => null;
  ok('YouTube API search: shorts only, ranked, titles decoded; fallback chain');
}

// ---- worker.js on an in-memory D1 ----
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const stmt = (sql, a = []) => ({ bind: (...x) => stmt(sql, x), first: async () => db.prepare(sql).get(...a) ?? null, all: async () => ({ results: db.prepare(sql).all(...a) }), run: async () => db.prepare(sql).run(...a) });
const env = { DB: { prepare: (sql) => stmt(sql) }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', SESSION_SECRET: 'sess', TELEGRAM_BOT_TOKEN: 'tok', FIRECRAWL_API_KEY: 'fc',
  ASSETS: { fetch: async () => new Response('app') } };
const sent = [];
let claims;
fake = (u, o) => {
  if (u.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ id_token: ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.') }));
  if (u.includes('/getUpdates')) return new Response(JSON.stringify({ result: [{ message: { chat: { id: 42 } } }] }));
  if (u.includes('/sendMessage')) return sent.push(JSON.parse(o.body)), new Response('{"ok":true}');
  if (u.includes('/setWebhook') || u.includes('/deleteWebhook')) return new Response('{"ok":true}');
  if (u.includes('credit-usage')) return new Response(JSON.stringify({ data: { remainingCredits: 180, planCredits: 1000, billingPeriodEnd: new Date(Date.now() + 6 * 864e5).toISOString() } }));
  return null;
};
const call = (path, { cookie, method = 'GET', body, headers = {} } = {}) =>
  worker.fetch(new Request('https://ref.test' + path, { method, headers: { ...(cookie && { cookie: `ref_session=${cookie}` }), 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) }), env);
async function login(email, popup = false) {
  claims = { email, email_verified: true, name: email.split('@')[0] };
  const r1 = await call('/auth/login' + (popup ? '?popup=1' : ''));
  const state = /ref_state=([^;]+)/.exec(r1.headers.get('set-cookie'))[1];
  const r = await worker.fetch(new Request(`https://ref.test/auth/callback?code=c&state=${state}`, { headers: { cookie: `ref_state=${state}` } }), env);
  return { session: (r.headers.getSetCookie().join(';').match(/ref_session=([^;]+)/) || [])[1] || null, r, body: popup ? await r.text() : '' };
}
{
  assert.match(await (await call('/')).text(), /Google 계정으로 로그인/);
  assert.equal((await call('/api/videos')).status, 401);
  assert.equal((await call('/manifest.json')).status, 200); // install files without login
  const owner = (await login('owner@gmail.com')).session;
  const popup = await login('owner@gmail.com', true);
  assert.ok(popup.session && popup.body.includes("postMessage('ref-login'"));
  assert.equal((await call('/api/me', { cookie: owner.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')) })).status, 401); // tampered
  ok('sign-in (same tab + popup), login page, tamper-proof cookie');

  assert.equal((await (await call('/api/admin/telegram', { cookie: owner, method: 'POST' })).json()).ok, true);
  const guest = (await login('guest@gmail.com')).session;
  assert.match(sent.at(-1).text, /새 로그인/);
  assert.equal((await (await call('/api/me', { cookie: owner })).json()).admin, true);
  assert.equal((await call('/api/admin/users', { cookie: guest })).status, 403);
  ok('admin = first user; new sign-in alert; guests kept out of admin');

  const item = { src: 'yt', ref: 'abcdefghijk', url: 'https://www.youtube.com/shorts/abcdefghijk', title: 't' };
  const saved = await (await call('/api/save', { cookie: owner, method: 'POST', body: item })).json();
  assert.equal((await (await call('/api/videos', { cookie: guest })).json()).length, 0);
  assert.equal((await call('/api/videos/' + saved.id, { cookie: guest, method: 'DELETE' })).status, 404);
  ok('scrapbook per account');

  await call('/api/admin/block', { cookie: owner, method: 'POST', body: { email: 'guest@gmail.com', blocked: true } });
  assert.equal((await call('/api/me', { cookie: guest })).status, 401);
  assert.equal((await login('guest@gmail.com')).session, null);
  assert.equal((await call('/api/admin/block', { cookie: owner, method: 'POST', body: { email: 'owner@gmail.com', blocked: true } })).status, 400);
  ok('blocking (instant, also on re-login; not yourself)');

  const secret = crypto.createHash('sha256').update('tok|sess').digest('hex').slice(0, 48);
  const tg = (text, chat = 42, sec = secret) => call('/api/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': sec }, body: { message: { text, chat: { id: chat } } } });
  assert.equal((await tg('최근 기록', 42, 'nope')).status, 403);
  const n = sent.length;
  await tg('최근 기록', 99);
  assert.equal(sent.length, n); // other chats are ignored
  await tg('최근 기록');
  assert.match(sent.at(-1).text, /최근 기록[\s\S]*guest@gmail.com[\s\S]*\[차단\]/);
  await tg('검색량');
  assert.match(sent.at(-1).text, /오늘 검색량[\s\S]*1인당/);
  ok('Telegram commands: secret checked, linked chat only, 최근 기록 / 검색량');
}
globalThis.fetch = realFetch;
console.log('all passed');
