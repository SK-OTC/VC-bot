import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { EVERY_MINUTE_CRON, KEEPALIVE_CRON, KEEPALIVE_MAX_PER_RUN, runKeepAlive } from '../src/calendar-keepalive.js';
import { getConnection, saveRefreshToken } from '../src/calendar-connections.js';
import { ACCESS, createFakeGoogle } from './helpers/google-api.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const DAY = 86400;
const NOW = 1_800_000_000;
const ENC_KEY = randomBytes(32).toString('base64');
const REFRESH = 'fake-refresh-token-abc123';
const config = { clientId: 'cid', clientSecret: 'csecret', encKey: ENC_KEY, redirectUri: 'https://worker.example/oauth/google/callback' };

async function connect(db, user, { issuedDaysAgo = 3, token = `${REFRESH}-${user}`, guild = 'g1' } = {}) {
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: user, teamId: guild, googleEmail: `${user}@gmail.com`, refreshToken: token, nowSec: NOW - issuedDaysAgo * DAY });
}

/** Google answers by the refresh token it is given: `byToken[token]` is a reply; anything else works. */
function googleByToken(byToken = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    seen.push(form.refresh_token);
    const reply = byToken[form.refresh_token] ?? { status: 200, body: { access_token: ACCESS, expires_in: 3599 } };
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  };
  return { seen, fetchImpl };
}

function setup() {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const lines = [];
  const run = (google, over = {}) => runKeepAlive({ db, discord, config, nowSec: NOW, fetchImpl: google.fetchImpl, sleep: async () => {}, log: (l) => lines.push(l), ...over });
  return { db, discord, lines, run };
}

const allLogs = [];
for (const level of ['log', 'warn', 'error', 'info']) console[level] = (...args) => allLogs.push(args.map(String).join(' '));
test.afterEach(() => {
  const all = allLogs.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, 'csecret', ENC_KEY]) assert.ok(!all.includes(secret), 'a secret was logged');
});

test('one log line per PM with the token age in days and the result; then a summary', async () => {
  const { db, lines, run } = setup();
  await connect(db, 'u1', { issuedDaysAgo: 3 });
  await connect(db, 'u2', { issuedDaysAgo: 40 });
  const summary = await run(googleByToken());

  assert.deepEqual(summary, { checked: 2, ok: 2, revoked: 0, failed: 0, deferred: 0 });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2).sort(), [
    'calendar keep-alive: user=u1 token_age_days=3 result=ok',
    'calendar keep-alive: user=u2 token_age_days=40 result=ok',
  ]);
  assert.equal(lines[2], 'calendar keep-alive: done checked=2 ok=2 revoked=0 failed=0 deferred=0');

  // The result is recorded on each connection, and no access token is stored anywhere.
  for (const u of ['u1', 'u2']) {
    const row = await getConnection(db, u);
    assert.equal(row.last_refresh_at, NOW);
    assert.equal(row.last_refresh_result, 'ok');
    assert.equal(row.status, 'connected');
  }
  assert.ok(!JSON.stringify(db.sql('SELECT * FROM calendar_connections')).includes(ACCESS));
});

test('a revoked sign-in goes down the same path as a meeting that hits it: disconnected, token wiped, PM DMed a fresh link, nobody else affected', async () => {
  const { db, discord, lines, run } = setup();
  await connect(db, 'u1');
  await connect(db, 'u2');
  const google = googleByToken({ [`${REFRESH}-u1`]: { status: 400, body: { error: 'invalid_grant' } } });
  const summary = await run(google);

  assert.deepEqual(summary, { checked: 2, ok: 1, revoked: 1, failed: 0, deferred: 0 });
  assert.ok(lines.includes('calendar keep-alive: user=u1 token_age_days=3 result=invalid_grant disconnected=true reconnect_dm=sent'));
  assert.ok(lines.includes('calendar keep-alive: user=u2 token_age_days=3 result=ok'));

  const u1 = await getConnection(db, 'u1');
  assert.equal(u1.status, 'disconnected');
  assert.equal(u1.encrypted_refresh_token, null);
  assert.equal(u1.last_refresh_result, 'invalid_grant');
  assert.equal((await getConnection(db, 'u2')).status, 'connected');

  assert.equal(discord.dms.length, 1);
  assert.equal(discord.dms[0].userId, 'u1');
  assert.match(discord.dms[0].content, /accounts\.google\.com/);
  assert.equal(discord.posts.length, 0, 'there is no meeting, so nothing is posted in a channel');
});

test('a disconnected PM is skipped, and so is a PM who was already told', async () => {
  const { db, lines, run } = setup();
  await connect(db, 'u1');
  const revoke = googleByToken({ [`${REFRESH}-u1`]: { status: 400, body: { error: 'invalid_grant' } } });
  await run(revoke);
  lines.length = 0;

  const again = googleByToken();
  const summary = await run(again);
  assert.deepEqual(summary, { checked: 0, ok: 0, revoked: 0, failed: 0, deferred: 0 });
  assert.deepEqual(again.seen, []);
  assert.deepEqual(lines, ['calendar keep-alive: done checked=0 ok=0 revoked=0 failed=0 deferred=0']);
});

test('other problems are logged as errors and the PM stays connected and is not messaged', async () => {
  const { db, discord, lines, run } = setup();
  await connect(db, 'u1');
  await connect(db, 'u2');
  const google = googleByToken({ [`${REFRESH}-u1`]: { status: 503, body: {} }, [`${REFRESH}-u2`]: new Error('socket hang up') });
  const summary = await run(google);

  assert.deepEqual(summary, { checked: 2, ok: 0, revoked: 0, failed: 2, deferred: 0 });
  assert.ok(lines.includes('calendar keep-alive: user=u1 token_age_days=3 result=error:transient'));
  assert.ok(lines.includes('calendar keep-alive: user=u2 token_age_days=3 result=error:transient'));
  assert.equal(discord.dms.length, 0);
  for (const u of ['u1', 'u2']) assert.equal((await getConnection(db, u)).status, 'connected');
  assert.match((await getConnection(db, 'u1')).last_refresh_result, /^error: transient/);
});

test('the bot\'s own Google settings being wrong stops the run after one request instead of failing for everyone', async () => {
  const { db, lines, run } = setup();
  for (const u of ['u1', 'u2', 'u3']) await connect(db, u);
  const bad = { status: 401, body: { error: 'invalid_client' } };
  const google = googleByToken({ [`${REFRESH}-u1`]: bad, [`${REFRESH}-u2`]: bad, [`${REFRESH}-u3`]: bad });
  const summary = await run(google);
  assert.equal(google.seen.length, 1);
  assert.deepEqual(summary, { checked: 1, ok: 0, revoked: 0, failed: 1, deferred: 2 });
  assert.ok(lines[0].endsWith('result=error:config'));
});

test('a token that cannot be decrypted is reported and the PM is NOT disconnected', async () => {
  const { db, lines, run } = setup();
  await connect(db, 'u1');
  const google = googleByToken();
  const summary = await run(google, { config: { ...config, encKey: randomBytes(32).toString('base64') } });
  assert.equal(summary.failed, 1);
  assert.ok(lines[0].endsWith('result=error:decrypt'));
  assert.equal(google.seen.length, 0);
  assert.equal((await getConnection(db, 'u1')).status, 'connected');
});

test('at most 10 PMs per run (the Free plan allows 50 outbound requests), the longest-unchecked first; the rest come first next time', async () => {
  const { db, run } = setup();
  for (let i = 1; i <= 13; i++) await connect(db, `u${String(i).padStart(2, '0')}`);
  const first = googleByToken();
  const summary = await run(first);
  assert.equal(KEEPALIVE_MAX_PER_RUN, 10);
  assert.deepEqual([summary.checked, summary.deferred], [10, 3]);
  assert.equal(first.seen.length, 10);

  const second = googleByToken();
  const next = await run(second, { nowSec: NOW + 7 * DAY });
  assert.deepEqual([next.checked, next.deferred], [10, 3]);
  // The three that were deferred (never checked) are done first this time.
  assert.deepEqual(second.seen.slice(0, 3), ['u11', 'u12', 'u13'].map((u) => `${REFRESH}-${u}`));
});

test('a failure for one PM never stops the others, and nothing throws', async () => {
  const { db, run } = setup();
  await connect(db, 'u1');
  await connect(db, 'u2');
  const discord = { sendDirectMessage: async () => { throw new Error('discord exploded'); } };
  const google = googleByToken({ [`${REFRESH}-u1`]: { status: 400, body: { error: 'invalid_grant' } } });
  const summary = await run(google, { discord });
  assert.equal(summary.checked, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
});

// ---------- the Worker entry point ----------

test('wrangler.toml has the every-minute trigger and the weekly trigger, matching the code', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(crons, [EVERY_MINUTE_CRON, KEEPALIVE_CRON]);
  assert.equal(KEEPALIVE_CRON, '0 6 * * 1');
});

test('the weekly cron runs only the keep-alive; the every-minute cron never does', async () => {
  const db = createTestDb();
  await connect(db, 'u1');
  const env = {
    DB: db,
    DISCORD_BOT_TOKEN: 'discord-bot-token-for-tests',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    TOKEN_ENC_KEY: ENC_KEY,
    GOOGLE_REDIRECT_URI: config.redirectUri,
  };
  const google = createFakeGoogle();
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    return google.fetchImpl(url, init);
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  try {
    await worker.scheduled({ cron: KEEPALIVE_CRON }, env, ctx);
    await Promise.all(waits.splice(0));
    assert.equal(google.tokenCalls, 1, 'the weekly trigger refreshed the token');
    assert.ok(allLogs.some((l) => /^calendar keep-alive: user=u1 token_age_days=\d+ result=ok$/.test(l)), 'one line for the PM'); // the Worker uses the real clock, so the age is not exactly 3
    assert.equal((await getConnection(db, 'u1')).last_refresh_result, 'ok');

    allLogs.length = 0;
    await worker.scheduled({ cron: EVERY_MINUTE_CRON }, env, ctx);
    await Promise.all(waits.splice(0));
    assert.equal(google.tokenCalls, 1, 'the every-minute trigger did not refresh anything');
    assert.ok(!allLogs.some((l) => l.includes('keep-alive')));

    // Without Google settings the weekly trigger just says so.
    allLogs.length = 0;
    await worker.scheduled({ cron: KEEPALIVE_CRON }, { ...env, GOOGLE_CLIENT_SECRET: '' }, ctx);
    await Promise.all(waits.splice(0));
    assert.ok(allLogs.some((l) => l.includes('keep-alive skipped')));
    assert.equal(google.tokenCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(fetched.length >= 1);
});
