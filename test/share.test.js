import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { esc, transcriptPage, SECURITY_HEADERS } from '../src/share-page.js';
import {
  MAX_ACTIVE_PER_TRANSCRIPT, TOKEN_RE, configuredDays, createShareLink, hashToken, newToken, publicOrigin,
} from '../src/share-store.js';
import { uploadTranscript } from '../pipeline/upload.mjs';

const SECRET = 'test-shared-secret-value';
const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const DAY = 86_400;
const GUILD = '222222222222222222';
const POST = '333333333333333333'; // the private transcript channel
const VC = '111111111111111111';
const ALICE = '700000000000000001';

function setup(envExtra = {}) {
  const db = createTestDb();
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET, ...envExtra };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  // The Worker reads the clock itself, so every request runs with a frozen clock to make expiry exact.
  const atTime = async (now, fn) => {
    const realNow = Date.now;
    Date.now = () => now * 1000;
    try {
      const res = await fn();
      await Promise.all(waits.splice(0));
      return res;
    } finally {
      Date.now = realNow;
    }
  };
  const get = (path, { method = 'GET', now = NOW } = {}) =>
    atTime(now, () => worker.fetch(new Request(`https://worker.example${path}`, { method }), env, ctx));
  const upload = (body) =>
    atTime(NOW, () =>
      worker.fetch(
        new Request('https://worker.example/api/transcripts', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) }),
        env,
        ctx,
      ),
    );
  return { db, env, get, upload };
}

const payload = (over = {}) => ({
  id: 'abc234',
  session_id: null,
  guild_id: GUILD,
  voice_channel_id: VC,
  post_channel_id: POST,
  transcript_message_id: '444444444444444444',
  summary_message_id: null,
  started_at: '2026-11-19T10:00:00.000Z',
  duration_sec: 3725,
  speakers: [{ name: 'Alice', speaking_sec: 900 }, { name: 'Sam', speaking_sec: 600 }],
  engine: 'groq whisper-large-v3',
  language: 'en',
  transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:05] Alice: hello everyone\n[00:00:09] Sam: shoes are the topic today',
  summary_text: '**Summary**\n- shoes launch',
  actions_text: '- Sam: buy shoes',
  ...over,
});

async function stored(t, over) {
  const r = await t.upload(payload(over));
  assert.equal(r.status, 200);
  return r.json();
}
const tokenOf = (url) => url.split('/t/')[1];

// ---------- tokens ----------

test('tokens: 43 url-safe characters, never repeat, and only the hash is stored', async () => {
  const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
  assert.equal(tokens.size, 200);
  for (const tk of tokens) assert.match(tk, TOKEN_RE);
  const t = setup();
  const out = await stored(t);
  const token = tokenOf(out.share_url);
  const rows = t.db.sql('SELECT * FROM share_links');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, await hashToken(token));
  assert.ok(!JSON.stringify(rows).includes(token), 'the raw token must not be in the database');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

// ---------- automatic link when a transcript is stored ----------

test('storing a transcript returns a private link that expires after SHARE_LINK_DAYS (default 30)', async () => {
  const t = setup();
  const out = await stored(t);
  assert.match(out.share_url, /^https:\/\/worker\.example\/t\/[A-Za-z0-9_-]{43}$/);
  assert.equal(out.share_expires_at, NOW + 30 * DAY);
  assert.equal(t.db.sql('SELECT created_by FROM share_links')[0].created_by, 'recorder');

  const custom = setup({ SHARE_LINK_DAYS: '7', PUBLIC_URL: 'https://meetings.example.com/ignored/path' });
  const out2 = await stored(custom);
  assert.match(out2.share_url, /^https:\/\/meetings\.example\.com\/t\//);
  assert.equal(out2.share_expires_at, NOW + 7 * DAY);
});

test('SHARE_LINK_DAYS=0 turns the automatic link off; the transcript is still saved', async () => {
  const t = setup({ SHARE_LINK_DAYS: '0' });
  const out = await stored(t);
  assert.equal(out.ok, true);
  assert.equal('share_url' in out, false);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM share_links')[0].n, 0);
});

test('config parsing: bad SHARE_LINK_DAYS falls back to 30; PUBLIC_URL must be https (http only for localhost)', () => {
  assert.equal(configuredDays({}), 30);
  for (const bad of ['abc', '-1', '1.5', '366', '9999']) assert.equal(configuredDays({ SHARE_LINK_DAYS: bad }), 30);
  assert.equal(configuredDays({ SHARE_LINK_DAYS: '0' }), 0);
  assert.equal(configuredDays({ SHARE_LINK_DAYS: '365' }), 365);
  assert.equal(publicOrigin({ PUBLIC_URL: 'https://a.example/x' }, 'https://fallback.example'), 'https://a.example');
  assert.equal(publicOrigin({ PUBLIC_URL: 'http://a.example' }, 'https://fallback.example'), 'https://fallback.example');
  assert.equal(publicOrigin({ PUBLIC_URL: 'javascript:alert(1)' }, 'https://fallback.example'), 'https://fallback.example');
  assert.equal(publicOrigin({ PUBLIC_URL: 'http://localhost:8787' }, 'https://fallback.example'), 'http://localhost:8787');
  assert.equal(publicOrigin({}, 'https://fallback.example'), 'https://fallback.example');
});

test('a failure while making the link never loses the transcript', async () => {
  const t = setup();
  const realPrepare = t.db.prepare;
  t.db.prepare = (sql) => {
    if (/share_links/.test(sql)) throw new Error('boom');
    return realPrepare(sql);
  };
  const out = await stored(t);
  assert.equal(out.ok, true);
  assert.equal('share_url' in out, false);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
});

// ---------- the page ----------

test('a valid link shows summary, action items, speakers and the length, but NOT the transcript', async () => {
  const t = setup();
  const { share_url } = await stored(t);
  const res = await t.get(new URL(share_url).pathname);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const s of ['Meeting summary', '<h2><span class="hash" aria-hidden="true">#</span>Summary</h2>', 'shoes launch', 'buy shoes', 'Alice, Sam', 'Nov 19']) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
  for (const s of ['hello everyone', 'shoes are the topic today', '[00:00:05]']) assert.ok(!html.includes(s), `the transcript must not be on the page: ${s}`);
  assert.ok(!/<form|<textarea/i.test(html), 'no question box when GROQ_API_KEY is not set');
});

test('every page response carries the strict security headers', async () => {
  const t = setup();
  const { share_url } = await stored(t);
  for (const path of [new URL(share_url).pathname, `/t/${'a'.repeat(43)}`, '/t/short', '/t/']) {
    const res = await t.get(path);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (k === 'Content-Type') continue;
      assert.equal(res.headers.get(k), v, `${path}: ${k}`);
    }
  }
  const h = SECURITY_HEADERS;
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
  assert.match(h['Content-Security-Policy'], /script-src 'sha256-[A-Za-z0-9+/]+=*'(;|$)/, 'scripts are allowed only by hash');
  assert.doesNotMatch(h['Content-Security-Policy'], /unsafe-eval|script-src[^;]*(unsafe-inline|\*|https?:)/);
  assert.match(h['X-Robots-Tag'], /noindex/);
  assert.match(h['Cache-Control'], /no-store/);
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['X-Frame-Options'], 'DENY');
});

test('wrong, unknown, expired, revoked and malformed links all give the identical 404 page', async () => {
  const t = setup();
  const { share_url } = await stored(t);
  const goodPath = new URL(share_url).pathname;
  const token = tokenOf(share_url);

  const unknown = await t.get(`/t/${newToken()}`);
  assert.equal(unknown.status, 404);
  const reference = await unknown.text();
  assert.ok(!reference.includes('hello everyone'));
  assert.equal((await t.get(`/t/${newToken()}`, { method: 'POST' })).status, 404); // a POST to a wrong link is the same "no"

  const expired = await t.get(goodPath, { now: NOW + 31 * DAY });
  const malformed = [`/t/${token.slice(0, 42)}`, `/t/${token}x`, `/t/${token}/`, `/t/${token}/extra`, '/t/', `/t/${'!'.repeat(43)}`, `/t/%00`, `/t/${token.toLowerCase()}`];
  for (const p of malformed) {
    const r = await t.get(p);
    assert.equal(r.status, 404, p);
    assert.equal(await r.text(), reference, p);
  }
  assert.equal(expired.status, 404);
  assert.equal(await expired.text(), reference);

  t.db.sql(`UPDATE share_links SET revoked_at = ${NOW}`);
  const revoked = await t.get(goodPath);
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), reference);
});

test('only GET, HEAD and POST are allowed; HEAD works and does not count as a view', async () => {
  const t = setup();
  const { share_url } = await stored(t);
  const path = new URL(share_url).pathname;
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await t.get(path, { method })).status, 405);
  assert.equal((await t.get(path, { method: 'HEAD' })).status, 200);
  assert.equal(t.db.sql('SELECT views FROM share_links')[0].views, 0);
  await t.get(path);
  await t.get(path);
  const row = t.db.sql('SELECT views, last_viewed_at FROM share_links')[0];
  assert.equal(row.views, 2);
  assert.equal(row.last_viewed_at, NOW);
});

test('robots.txt disallows everything except the privacy page', async () => {
  const t = setup();
  const res = await t.get('/robots.txt');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'User-agent: *\nAllow: /privacy\nDisallow: /\n'); // everything except the public privacy page
});

test('HTML injection: names, speech and model output are escaped, and nothing can add a tag', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const t = setup();
  const { share_url } = await stored(t, {
    speakers: [{ name: evil, speaking_sec: 5 }],
    transcript_text: `[00:00:01] ${evil}: ${evil}`,
    summary_text: `**${evil}** and **bold**`,
    actions_text: `- ${evil}`,
  });
  const html = await (await t.get(new URL(share_url).pathname)).text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'names and summary still show, escaped');
  assert.ok(!html.includes('<script>alert'), 'raw <script> must never appear');
  assert.ok(!html.includes('<img'), 'raw <img> must never appear');
  assert.ok(!/<[a-z]+[^>]*\sonerror=/i.test(html), 'no tag may carry an event handler');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  // the only tags in the body are the ones the page itself writes
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const tag of tags) assert.ok(['!doctype', 'html', 'head', 'meta', 'title', 'style', 'body', 'header', 'main', 'aside', 'div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'strong', 'form', 'label', 'textarea', 'button', 'svg', 'circle', 'path', 'rect'].includes(tag), `unexpected tag <${tag}>`);
  assert.ok(!/<a[\s>]/i.test(html) && !/<form/i.test(html) && !/<iframe/i.test(html));
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('a transcript with no summary or speakers still renders; corrupt speaker JSON does not crash it', () => {
  const base = { started_at: NOW, duration_sec: 60, expires_at: NOW + DAY };
  const a = transcriptPage({ ...base, speakers: '[]', summary_text: null, actions_text: null });
  assert.ok(a.includes('Meeting summary') && !a.includes('Summary'));
  assert.ok(transcriptPage({ ...base, speakers: 'not json{', summary_text: null, actions_text: null }).includes('Meeting summary'));
});

test('a database error shows the same plain page and logs no token or text', async () => {
  const t = setup();
  const { share_url } = await stored(t);
  const token = tokenOf(share_url);
  const seen = [];
  const keep = { error: console.error, log: console.log };
  console.error = (...a) => seen.push(a.join(' '));
  console.log = (...a) => seen.push(a.join(' '));
  try {
    t.db.prepare = () => { throw new Error(`boom ${token} hello everyone`); };
    const res = await t.get(`/t/${token}`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('hello'));
  } finally {
    Object.assign(console, keep);
  }
  const all = seen.join('\n');
  assert.ok(!all.includes(token) && !all.includes('hello everyone'));
});

// ---------- expiry, revocation, limits ----------

test('links stop at their expiry time exactly, and old rows are cleaned up', async () => {
  const t = setup({ SHARE_LINK_DAYS: '1' });
  const { share_url } = await stored(t);
  const path = new URL(share_url).pathname;
  assert.equal((await t.get(path, { now: NOW + DAY - 1 })).status, 200);
  assert.equal((await t.get(path, { now: NOW + DAY })).status, 404);
  // creating a link long afterwards deletes the long-expired row
  await createShareLink(t.db, { transcriptId: 'abc234', createdBy: ALICE, days: 1 }, NOW + 60 * DAY);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM share_links')[0].n, 1);
});

test('at most 10 active links per transcript', async () => {
  const t = setup();
  await stored(t);
  for (let i = 0; i < MAX_ACTIVE_PER_TRANSCRIPT - 1; i++) assert.equal((await createShareLink(t.db, { transcriptId: 'abc234', createdBy: ALICE, days: 5 }, NOW)).ok, true);
  const over = await createShareLink(t.db, { transcriptId: 'abc234', createdBy: ALICE, days: 5 }, NOW);
  assert.equal(over.ok, false);
  assert.match(over.reason, /already has 10 active links/);
  t.db.sql(`UPDATE share_links SET revoked_at = ${NOW} WHERE transcript_id = 'abc234'`); // a revoked link no longer counts
  assert.equal((await createShareLink(t.db, { transcriptId: 'abc234', createdBy: ALICE, days: 5 }, NOW)).ok, true);
});

test('deleting a transcript deletes its links', async () => {
  const t = setup();
  await stored(t);
  t.db.sql("DELETE FROM transcripts WHERE id = 'abc234'");
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM share_links')[0].n, 0);
});

test('a link opens only its own transcript', async () => {
  const t = setup();
  const a = await stored(t, { id: 'aaaaaa', summary_text: 'ALPHA-MEETING-TEXT' });
  const b = await stored(t, { id: 'bbbbbb', summary_text: 'BRAVO-MEETING-TEXT' });
  const pa = await (await t.get(new URL(a.share_url).pathname)).text();
  const pb = await (await t.get(new URL(b.share_url).pathname)).text();
  assert.ok(pa.includes('ALPHA') && !pa.includes('BRAVO'));
  assert.ok(pb.includes('BRAVO') && !pb.includes('ALPHA'));
});

// ---------- the recorder side ----------

test('uploadTranscript passes the link back, and ignores a link that is not a web address', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, share_url: 'https://w.example/t/abc', share_expires_at: NOW }), { status: 200 });
    assert.deepEqual(await uploadTranscript({ url: 'https://w.example/api/transcripts', secret: 's', payload: {}, sleep: async () => {} }), { ok: true, shareUrl: 'https://w.example/t/abc', shareExpiresAt: NOW });
    for (const bad of ['javascript:alert(1)', 'ftp://x/y', 'https://has space', 42, null]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, share_url: bad }), { status: 200 });
      assert.deepEqual(await uploadTranscript({ url: 'https://w.example/api/transcripts', secret: 's', payload: {}, sleep: async () => {} }), { ok: true });
    }
    globalThis.fetch = async () => new Response('not json', { status: 200 });
    assert.deepEqual(await uploadTranscript({ url: 'https://w.example/api/transcripts', secret: 's', payload: {}, sleep: async () => {} }), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});
