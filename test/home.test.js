import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { checkDatabase, homePage } from '../src/home-page.js';

const call = (env = {}, { method = 'GET', path = '/' } = {}) => worker.fetch(new Request(`https://worker.example${path}`, { method }), { DB: createTestDb(), ...env }, { waitUntil() {} });
const rows = (html) => Object.fromEntries([...html.matchAll(/<li><span class="dot (\w+)"[^>]*><\/span><span>([^<]+)<\/span><span class="state">([^<]+)<\/span><\/li>/g)].map((m) => [m[2], { state: m[3], dot: m[1] }]));

test('GET / is the home page: 200, HTML, same shell as the transcript page, no script', async () => {
  const res = await call();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(res.headers.get('Cache-Control'), /no-store/, 'a status page must be fresh');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /<header class="top"><a class="brand" href="\/">VC Bot<\/a><\/header>/);
  assert.match(html, /<div class="layout solo"><main class="note"><div class="article"><h1>VC Bot<\/h1>/);
  assert.match(html, /<h2><span class="hash" aria-hidden="true">#<\/span>Status<\/h2>/);
  assert.ok(!/<script|<img|<iframe/i.test(html));
  assert.ok(html.includes('<a href="/privacy">Privacy policy</a>'));
});

test('status: a working database is Online, and the rows say what is on and what is not set up', async () => {
  const html = await (await call({ BRIDGE_SECRET: 'x'.repeat(30), GITHUB_DISPATCH_TOKEN: 'ghp_x', GITHUB_REPO: 'me/repo', GROQ_API_KEY: 'gsk_x' })).text();
  assert.match(html, /<span class="chip"><span class="dot good" aria-hidden="true"><\/span>Online<\/span>/);
  const r = rows(html);
  assert.deepEqual(r['Commands and reminders'], { state: 'Online', dot: 'good' });
  assert.deepEqual(r.Database, { state: 'OK', dot: 'good' });
  assert.deepEqual(r['Google Calendar sync'], { state: 'On', dot: 'good' });
  assert.deepEqual(r['Recording and summaries'], { state: 'On', dot: 'good' });
  assert.deepEqual(r['Questions about a meeting'], { state: 'On', dot: 'good' });
});

test('status: features that are not configured show "Not set up"', async () => {
  const r = rows(await (await call()).text());
  assert.deepEqual(r['Google Calendar sync'], { state: 'Not set up', dot: 'off' });
  assert.deepEqual(r['Recording and summaries'], { state: 'Not set up', dot: 'off' });
  assert.deepEqual(r['Questions about a meeting'], { state: 'Not set up', dot: 'off' }, 'no AI binding and no Groq key');
  // recording needs both the token and the repository
  assert.equal(rows(await (await call({ GITHUB_DISPATCH_TOKEN: 'ghp_x' })).text())['Recording and summaries'].state, 'Not set up');
  // questions are on with just the Cloudflare AI binding
  assert.equal(rows(await (await call({ AI: { run() {} } })).text())['Questions about a meeting'].state, 'On');
});

test('a broken or missing database is reported as a problem, and the page still loads', async () => {
  const broken = { prepare: () => ({ first: async () => { throw new Error('D1_ERROR: secret detail'); } }) };
  const html = await (await call({ DB: broken })).text();
  assert.match(html, /Problem with the database/);
  assert.deepEqual(rows(html).Database, { state: 'Unavailable', dot: 'bad' });
  assert.ok(!html.includes('secret detail'), 'the error is never shown');
  assert.match(await (await call({ DB: undefined })).text(), /Problem with the database/);
});

test('checkDatabase never hangs: a database that does not answer is reported down after the timeout', async () => {
  const hung = { prepare: () => ({ first: () => new Promise(() => {}) }) };
  const t0 = Date.now();
  assert.deepEqual(await checkDatabase(hung, { timeoutMs: 50 }), { ok: false });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(await checkDatabase(createTestDb()), { ok: true });
});

test('the page never shows a secret, a setting value, a name or a count', async () => {
  const env = { BRIDGE_SECRET: 'bridge-secret-value-123456', GITHUB_DISPATCH_TOKEN: 'ghp_token_value', GITHUB_REPO: 'owner/private-repo', GROQ_API_KEY: 'gsk_key_value', WORKER_SHARED_SECRET: 'shared-secret-value', DISCORD_BOT_TOKEN: 'bot-token-value' };
  const html = await (await call(env)).text();
  for (const v of Object.values(env)) assert.ok(!html.includes(v), v);
  assert.ok(!/\d+ (meetings?|recordings?|transcripts?)/.test(html));
});

test('HEAD works with no body; POST / still goes to Discord\'s signature check, not the home page', async () => {
  const head = await call({}, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await call({ DISCORD_PUBLIC_KEY: 'k', DISCORD_BOT_TOKEN: 't' }, { method: 'POST' });
  assert.equal(post.status, 401);
  assert.equal((await call({}, { path: '/nope' })).status, 405, 'other paths are unchanged');
});

test('homePage prints only fixed text for any status value', () => {
  const odd = homePage({ database: '<b>x</b>', calendar: '<i>', recording: 0, questions: null });
  assert.ok(!odd.includes('<b>x</b>') && !odd.includes('<i>'), 'status values are never printed');
});
