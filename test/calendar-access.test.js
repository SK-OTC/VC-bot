import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getAccessToken } from '../src/calendar-access.js';
import { getConnection, markDisconnected, saveRefreshToken } from '../src/calendar-connections.js';
import { refreshAccessToken } from '../src/google-oauth.js';
import { createTestDb } from './helpers/d1.js';

const NOW = 1_800_000_000;
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret-value';
const ENC_KEY = randomBytes(32).toString('base64');
const REFRESH = 'fake-refresh-token-abc123';
const ACCESS = 'fake-access-token-xyz789';
const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encKey: ENC_KEY };

/** A fake Google token endpoint that answers from a script, one entry per call. An Error entry means "could not reach Google". */
function fakeGoogle(...script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    const next = script.length ? script.shift() : { status: 200, body: { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function setup() {
  const db = createTestDb();
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: REFRESH, nowSec: NOW });
  const sleeps = [];
  const get = (google, over = {}) =>
    getAccessToken({ db, config, discordUserId: 'u1', teamId: 'g1', nowSec: NOW + 50, fetchImpl: google.fetchImpl, sleep: async (ms) => sleeps.push(ms), ...over });
  return { db, sleeps, get };
}

// Nothing secret may reach the logs, whatever happens.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) console[level] = (...args) => logged.push(args.map(String).join(' '));
test.afterEach(() => {
  const all = logged.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, ENC_KEY]) assert.ok(!all.includes(secret), 'a secret was logged');
});

test('returns a fresh access token, sending Google exactly the refresh-token request, and stores no access token', async () => {
  const { db, get } = await setup();
  const google = fakeGoogle();
  const r = await get(google);
  assert.deepEqual(r, { ok: true, accessToken: ACCESS, expiresInSec: 3599 });

  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(google.calls[0].form, { grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

  // The refresh is noted, and the access token is nowhere in the database.
  const row = await getConnection(db, 'u1');
  assert.equal(row.last_refresh_at, NOW + 50);
  assert.equal(row.last_refresh_result, 'ok');
  const everything = JSON.stringify([db.sql('SELECT * FROM calendar_connections'), db.sql('SELECT * FROM meetings')]);
  assert.ok(!everything.includes(ACCESS));
});

test('an access token is never cached: every call asks Google again', async () => {
  const { get } = await setup();
  const google = fakeGoogle();
  await get(google);
  await get(google);
  assert.equal(google.calls.length, 2);
});

test('not connected, disconnected, or connected for another server: refused with no call to Google', async () => {
  const { db, get } = await setup();
  const google = fakeGoogle();

  const nobody = await get(google, { discordUserId: 'u-nobody' });
  assert.equal(nobody.kind, 'not_connected');

  const otherServer = await get(google, { teamId: 'g2' });
  assert.equal(otherServer.kind, 'wrong_team');
  assert.equal((await get(google, { teamId: undefined })).kind, 'wrong_team');

  await markDisconnected(db, 'u1', 'invalid_grant', NOW);
  assert.equal((await get(google)).kind, 'not_connected');

  assert.equal(google.calls.length, 0);
});

test('one PM can never get another PM\'s token', async () => {
  const { db, get } = await setup();
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u2', teamId: 'g1', googleEmail: 'two@gmail.com', refreshToken: 'second-refresh-token', nowSec: NOW });
  const google = fakeGoogle();
  await get(google, { discordUserId: 'u2' });
  assert.equal(google.calls[0].form.refresh_token, 'second-refresh-token');
  await get(google, { discordUserId: 'u1' });
  assert.equal(google.calls[1].form.refresh_token, REFRESH);
});

test('invalid_grant is not retried, is reported as such, and is recorded without any token', async () => {
  const { db, get, sleeps } = await setup();
  const google = fakeGoogle({ status: 400, body: { error: 'invalid_grant', error_description: `Token has been expired or revoked ${REFRESH}` } });
  const r = await get(google);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'invalid_grant');
  assert.equal(r.retryable, false);
  assert.equal(google.calls.length, 1, 'no retry');
  assert.deepEqual(sleeps, []);
  assert.ok(!r.error.includes(REFRESH));
  assert.equal((await getConnection(db, 'u1')).last_refresh_result, 'invalid_grant');
  // The connection itself is left for the failure path (step 5) to handle.
  assert.equal((await getConnection(db, 'u1')).status, 'connected');
});

test('a temporary problem is retried once after a short pause, and a second attempt that works succeeds', async () => {
  for (const first of [new Error('socket hang up'), { status: 503, body: {} }, { status: 429, body: { error: 'rate_limit_exceeded' } }, { status: 200, body: {} }]) {
    const { get, sleeps } = await setup();
    const google = fakeGoogle(first);
    const r = await get(google);
    assert.equal(r.ok, true, String(first?.status ?? first?.message));
    assert.equal(google.calls.length, 2);
    assert.deepEqual(sleeps, [1000]);
  }
});

test('a temporary problem that persists fails after exactly one retry, marked retryable, with a clear message', async () => {
  const { db, get, sleeps } = await setup();
  const google = fakeGoogle({ status: 503, body: {} }, { status: 503, body: {} });
  const r = await get(google);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'transient');
  assert.equal(r.retryable, true);
  assert.match(r.error, /HTTP 503/);
  assert.equal(google.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.match((await getConnection(db, 'u1')).last_refresh_result, /^error: transient/);
});

test('the bot\'s own client settings being wrong is reported to the admin and not retried', async () => {
  const { get } = await setup();
  const google = fakeGoogle({ status: 401, body: { error: 'invalid_client' } });
  const r = await get(google);
  assert.equal(r.kind, 'config');
  assert.equal(r.retryable, false);
  assert.match(r.error, /admin/);
  assert.equal(google.calls.length, 1);
});

test('an answer without an access token counts as temporary; Google\'s own error text is never passed on', async () => {
  const { get } = await setup();
  const r = await get(fakeGoogle({ status: 200, body: { token_type: 'Bearer' } }, { status: 200, body: {} }));
  assert.equal(r.kind, 'transient');

  const odd = await refreshAccessToken({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH,
    fetchImpl: async () => new Response(JSON.stringify({ error: `bad ${REFRESH} ${CLIENT_SECRET}` }), { status: 400 }),
  });
  assert.equal(odd.kind, 'config');
  assert.ok(!odd.error.includes(REFRESH) && !odd.error.includes(CLIENT_SECRET), 'an unrecognised error code is replaced by "unknown"');
});

test('a stored token that cannot be decrypted (the key changed) is reported clearly with no call to Google', async () => {
  const { db } = await setup();
  const google = fakeGoogle();
  const r = await getAccessToken({ db, config: { ...config, encKey: randomBytes(32).toString('base64') }, discordUserId: 'u1', teamId: 'g1', nowSec: NOW, fetchImpl: google.fetchImpl });
  assert.equal(r.kind, 'decrypt');
  assert.equal(google.calls.length, 0);
  assert.match(r.error, /encryption key/);
});
