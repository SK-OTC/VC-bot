import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handleInteraction } from '../src/commands.js';
import { handleHttp } from '../src/http.js';
import { handleGoogleCallback } from '../src/calendar-oauth-http.js';
import { createConnectCode, getConnection, readRefreshToken, saveRefreshToken } from '../src/calendar-connections.js';
import { GOOGLE_SCOPES, buildAuthUrl, googleConfig, publicGoogleConfig } from '../src/google-oauth.js';
import { createFakeBridge, createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = 1_800_000_000;
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret-value';
const ENC_KEY = randomBytes(32).toString('base64');
const REDIRECT = 'https://worker.example/oauth/google/callback';
const REFRESH = 'fake-refresh-token-abc123';
const ACCESS = 'fake-access-token-xyz789';
const CAL = 'https://www.googleapis.com/auth/calendar.events.owned';

const envFor = (db, over = {}) => ({
  DB: db,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  TOKEN_ENC_KEY: ENC_KEY,
  GOOGLE_REDIRECT_URI: REDIRECT,
  ...over,
});

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idToken = (claims = {}) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: NOW + 3600, email: 'pm@gmail.com', email_verified: true, ...claims })}.sig`;

/** A fake Google token endpoint. `reply` is the JSON body (or a function of the request). */
function fakeGoogle({ status = 200, reply, throws } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    if (throws) throw new Error('boom');
    const body = typeof reply === 'function' ? reply(calls.at(-1)) : reply ?? { access_token: ACCESS, refresh_token: REFRESH, scope: `openid email ${CAL}`, id_token: idToken() };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function setup(envOver) {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const env = envFor(db, envOver);
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const callback = async (state, { google = fakeGoogle(), extra = '', now = NOW } = {}) => {
    const url = new URL(`https://worker.example/oauth/google/callback?${state ? `state=${state}&` : ''}code=gcode-123${extra}`);
    const res = await handleGoogleCallback(new Request(url), env, ctx, url, now, { fetchImpl: google.fetchImpl, discord });
    await Promise.all(pending.splice(0));
    return { res, html: await res.text(), google };
  };
  const connect = (opts = {}) =>
    handleInteraction(
      {
        type: 2,
        guild_id: 'g1',
        channel_id: 'c1',
        application_id: 'app1',
        token: 'tok',
        member: { user: { id: 'u1' }, permissions: '0' },
        data: { name: 'calendar', options: [{ type: 1, name: 'connect', options: opts.url ? [{ name: 'url', type: 3, value: opts.url }] : [] }] },
      },
      { db, discord, bridge: opts.bridge ?? null, google: opts.google === undefined ? publicGoogleConfig(env) : opts.google, nowSec: NOW },
    );
  return { db, discord, env, callback, connect };
}

const linkIn = (reply) => /<(https:\/\/accounts\.google\.com[^>]+)>/.exec(reply.data.content)?.[1];
const stateOf = (reply) => new URL(linkIn(reply)).searchParams.get('state');

// Nothing secret may reach the logs, whatever happens.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  console[level] = (...args) => logged.push(args.map(String).join(' '));
}
test.afterEach(() => {
  const all = logged.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, ENC_KEY, 'gcode-123']) assert.ok(!all.includes(secret), 'a secret was logged');
});

// ---------- /calendar connect ----------

test('/calendar connect replies privately with a Google link that asks for exactly the allowed scopes', async () => {
  const { connect, db } = setup();
  const reply = await connect();
  assert.equal(reply.data.flags, 64, 'ephemeral');
  const u = new URL(linkIn(reply));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = u.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), REDIRECT);
  assert.equal(p.get('scope'), `openid email ${CAL}`);
  assert.deepEqual(GOOGLE_SCOPES, ['openid', 'email', CAL]);
  assert.match(p.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.get('include_granted_scopes'), null);

  // The code is tied to this person and server, and only its hash is stored.
  const row = db.sql('SELECT * FROM calendar_connect_codes')[0];
  assert.equal(row.discord_user_id, 'u1');
  assert.equal(row.team_id, 'g1');
  assert.equal(row.expires_at, NOW + 600);
  assert.equal(row.used, 0);
  assert.notEqual(row.code, p.get('state'));
});

test('asking for a new link cancels the older one', async () => {
  const { connect, callback } = setup();
  const first = stateOf(await connect());
  const second = stateOf(await connect());
  assert.notEqual(first, second);
  assert.equal((await callback(first)).res.status, 400);
  assert.equal((await callback(second)).res.status, 200);
});

test('a PM who is already connected is told to disconnect first, and no link is made', async () => {
  const { connect, db } = setup();
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: REFRESH, nowSec: NOW });
  const reply = await connect();
  assert.match(reply.data.content, /already connected/);
  assert.match(reply.data.content, /\/calendar disconnect/);
  assert.ok(!linkIn(reply));
  assert.equal(db.sql('SELECT * FROM calendar_connect_codes').length, 0);
});

test('without the Google settings the command says so; with a url it still uses the Apps Script bridge', async () => {
  const { connect } = setup();
  const off = await connect({ google: null });
  assert.match(off.data.content, /not set up/);
  const legacy = await connect({ url: 'https://script.google.com/macros/s/AAAA/exec', bridge: createFakeBridge(), google: null });
  assert.match(legacy.data.content, /Connected as pm@gmail\.com/);
});

test('googleConfig needs all four settings and a valid key; the command only ever sees the public part', () => {
  const full = envFor(null);
  assert.ok(googleConfig(full));
  assert.deepEqual(publicGoogleConfig(full), { clientId: CLIENT_ID, redirectUri: REDIRECT });
  for (const missing of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENC_KEY', 'GOOGLE_REDIRECT_URI']) {
    assert.equal(googleConfig({ ...full, [missing]: '' }), null, missing);
  }
  assert.equal(googleConfig({ ...full, TOKEN_ENC_KEY: 'short' }), null);
  assert.ok(!JSON.stringify(publicGoogleConfig(full)).includes(CLIENT_SECRET));
  assert.equal(buildAuthUrl({ clientId: 'c', redirectUri: 'https://x/y', state: 's' }).includes('client_secret'), false);
});

// ---------- the callback ----------

test('happy path: the code is exchanged, the refresh token is stored encrypted, the PM is told', async () => {
  const { connect, callback, db, discord, env } = setup();
  const { res, html, google } = await callback(stateOf(await connect()));

  assert.equal(res.status, 200);
  assert.match(html, /pm@gmail\.com/);
  assert.ok(!html.includes(REFRESH) && !html.includes(ACCESS));
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');

  // What was sent to Google.
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(google.calls[0].form, { grant_type: 'authorization_code', code: 'gcode-123', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT });

  // What was stored.
  const row = await getConnection(db, 'u1');
  assert.equal(row.status, 'connected');
  assert.equal(row.team_id, 'g1');
  assert.equal(row.google_email, 'pm@gmail.com');
  assert.equal(row.token_issued_at, NOW);
  const raw = JSON.stringify(db.sql('SELECT * FROM calendar_connections'));
  assert.ok(!raw.includes(REFRESH) && !raw.includes(ACCESS));
  assert.equal(await readRefreshToken({ db, encKey: env.TOKEN_ENC_KEY, discordUserId: 'u1' }), REFRESH);

  // The PM is told in a DM.
  assert.equal(discord.dms.length, 1);
  assert.equal(discord.dms[0].userId, 'u1');
  assert.match(discord.dms[0].content, /pm@gmail\.com/);
});

test('a failed confirmation DM does not undo the connection', async () => {
  const { connect, callback, db, discord } = setup();
  discord.sendDirectMessage = async () => ({ ok: false, error: 'HTTP 403: Cannot send messages to this user' });
  const { res } = await callback(stateOf(await connect()));
  assert.equal(res.status, 200);
  assert.equal((await getConnection(db, 'u1')).status, 'connected');
});

test('the sign-in link works once: a replay, an expired link, an unknown state and a missing state are all refused', async () => {
  const { connect, callback } = setup();
  const state = stateOf(await connect());
  assert.equal((await callback(state)).res.status, 200);
  const replay = await callback(state);
  assert.equal(replay.res.status, 400);
  assert.equal(replay.google.calls.length, 0, 'no call to Google for a used link');
});

test('an expired link is refused without calling Google', async () => {
  const { connect, callback } = setup();
  const state = stateOf(await connect());
  const { res, google } = await callback(state, { now: NOW + 601 });
  assert.equal(res.status, 400);
  assert.equal(google.calls.length, 0);
});

test('unknown, malformed and missing state values are refused without calling Google', async () => {
  const { callback } = setup();
  for (const state of ['A'.repeat(43), 'short', '', "' OR 1=1 --"]) {
    const { res, google } = await callback(state);
    assert.equal(res.status, 400, state);
    assert.equal(google.calls.length, 0);
  }
});

test('refusing on the Google page uses up the link and connects nothing', async () => {
  const { connect, callback, db } = setup();
  const state = stateOf(await connect());
  const url = new URL(`https://worker.example/oauth/google/callback?state=${state}&error=access_denied`);
  const env = envFor(db);
  const res = await handleGoogleCallback(new Request(url), env, {}, url, NOW, { fetchImpl: fakeGoogle().fetchImpl });
  assert.match(await res.text(), /did not approve/);
  assert.equal(await getConnection(db, 'u1'), null);
  assert.equal((await callback(state)).res.status, 400);
});

test('Google gives no refresh token: a friendly message about myaccount.google.com/permissions, nothing stored', async () => {
  const { connect, callback, db } = setup();
  const google = fakeGoogle({ reply: { access_token: ACCESS, scope: `openid email ${CAL}`, id_token: idToken() } });
  const { res, html } = await callback(stateOf(await connect()), { google });
  assert.equal(res.status, 400);
  assert.match(html, /myaccount\.google\.com\/permissions/);
  assert.equal(await getConnection(db, 'u1'), null);
});

test('the calendar permission box was not ticked: refused, nothing stored', async () => {
  const { connect, callback, db } = setup();
  const google = fakeGoogle({ reply: { access_token: ACCESS, refresh_token: REFRESH, scope: 'openid email', id_token: idToken() } });
  const { res, html } = await callback(stateOf(await connect()), { google });
  assert.equal(res.status, 400);
  assert.match(html, /not granted/);
  assert.equal(await getConnection(db, 'u1'), null);
});

test('an identity token meant for another app, or from another issuer, or unverified, is refused', async () => {
  for (const claims of [{ aud: 'someone-elses-client' }, { iss: 'https://evil.example' }, { email_verified: false }, { exp: NOW - 1 }, { email: '' }]) {
    const { connect, callback, db } = setup();
    const google = fakeGoogle({ reply: { access_token: ACCESS, refresh_token: REFRESH, scope: `openid email ${CAL}`, id_token: idToken(claims) } });
    const { res } = await callback(stateOf(await connect()), { google });
    assert.equal(res.status, 400, JSON.stringify(claims));
    assert.equal(await getConnection(db, 'u1'), null);
  }
});

test('Google rejecting the code or being unreachable gives a clear page and stores nothing', async () => {
  for (const [google, status, pattern] of [
    [fakeGoogle({ status: 400, reply: { error: 'invalid_grant', error_description: `bad code gcode-123 ${REFRESH}` } }), 400, /invalid_grant/],
    [fakeGoogle({ status: 503, reply: {} }), 502, /HTTP 503/],
    [fakeGoogle({ throws: true }), 502, /could not reach Google/],
  ]) {
    const { connect, callback, db } = setup();
    const { res, html } = await callback(stateOf(await connect()), { google });
    assert.equal(res.status, status);
    assert.match(html, pattern);
    assert.ok(!html.includes('gcode-123') && !html.includes(REFRESH), "Google's own error text is never shown");
    assert.equal(await getConnection(db, 'u1'), null);
  }
});

test('already connected by the time the callback runs: Google is not asked for another token and the stored one is untouched', async () => {
  const { connect, callback, db, env } = setup();
  const state = stateOf(await connect());
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'first@gmail.com', refreshToken: 'the-first-token', nowSec: NOW });
  const { res, html, google } = await callback(state);
  assert.equal(res.status, 409);
  assert.match(html, /\/calendar disconnect/);
  assert.equal(google.calls.length, 0);
  assert.equal(await readRefreshToken({ db, encKey: env.TOKEN_ENC_KEY, discordUserId: 'u1' }), 'the-first-token');
  assert.equal((await getConnection(db, 'u1')).google_email, 'first@gmail.com');
});

test('the code belongs to one person and one server: another user cannot use it, and the row records its server', async () => {
  const { callback, db } = setup();
  const code = await createConnectCode(db, { discordUserId: 'u7', teamId: 'serverA', nowSec: NOW });
  const { res } = await callback(code);
  assert.equal(res.status, 200);
  assert.equal(await getConnection(db, 'u1'), null);
  const row = await getConnection(db, 'u7');
  assert.equal(row.team_id, 'serverA');
});

test('the route only answers GET and HEAD, and is reachable through the normal HTTP router', async () => {
  const { env, db } = setup();
  const post = new Request('https://worker.example/oauth/google/callback', { method: 'POST' });
  assert.equal((await handleHttp(post, env, {}, NOW)).status, 405);
  const get = new Request('https://worker.example/oauth/google/callback?state=nope&code=x');
  const res = await handleHttp(get, env, {}, NOW);
  assert.equal(res.status, 400);
  assert.ok(db);
});

test('with the Google settings missing, the callback says it is not set up and touches nothing', async () => {
  const db = createTestDb();
  const url = new URL('https://worker.example/oauth/google/callback?state=x&code=y');
  const res = await handleGoogleCallback(new Request(url), { DB: db }, {}, url, NOW);
  assert.equal(res.status, 503);
});
