// /calendar (status, with its buttons) and the Disconnect Google button for a Google sign-in, end to end through the real commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handleInteraction } from '../src/commands.js';
import { runCalendarSync } from '../src/calendar-sync.js';
import { disconnectGoogle } from '../src/calendar-disconnect.js';
import { getConnection, markDisconnected, readRefreshToken, recordRefresh, saveRefreshToken } from '../src/calendar-connections.js';
import { saveCalendarAccount } from '../src/store.js';
import { createGoogleCalendarClient } from '../src/google-calendar.js';
import { revokeToken } from '../src/google-oauth.js';
import { ACCESS, createFakeGoogle } from './helpers/google-api.js';
import { createFakeBridge, createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000;
const ENC_KEY = randomBytes(32).toString('base64');
const REFRESH = 'fake-refresh-token-abc123';
const config = { clientId: 'cid', clientSecret: 'csecret', encKey: ENC_KEY, redirectUri: 'https://worker.example/oauth/google/callback' };

function setup({ bridge = null, signInConfigured = true, deferred = null } = {}) {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const fake = createFakeGoogle();
  const client = createGoogleCalendarClient({ db, config, fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const google = signInConfigured
    ? {
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        disconnect: (discordUserId, nowSec) => disconnectGoogle({ db, config, discordUserId, nowSec, fetchImpl: fake.fetchImpl }),
      }
    : null;
  return {
    db,
    discord,
    fake,
    run: (interaction, nowSec = NOW) => handleInteraction(interaction, { db, discord, bridge, google, defer: deferred ? (p) => deferred.push(p) : undefined, nowSec }),
    sync: (nowSec = NOW) => runCalendarSync({ db, discord, bridge, google: client, nowSec }),
  };
}

const toOptions = (opts) => Object.entries(opts).map(([name, value]) => ({ name, value, type: typeof value === 'boolean' ? 5 : 3 }));
const cmd = (name, opts = {}, { user = 'u1', guild = 'g1', sub = null } = {}) => ({
  type: 2,
  guild_id: guild,
  channel_id: 'c1',
  application_id: 'app1',
  token: `tok-${user}-${Math.random()}`,
  member: { user: { id: user }, permissions: '0' },
  data: { name, options: sub ? [{ type: 1, name: sub, options: toOptions(opts) }] : toOptions(opts) },
});
// /calendar has no subcommands: calendar('status') is the plain command, every other action is a click on one of its buttons.
const BUTTONS = { connect: 'calendar:connect', disconnect: 'calendar:disconnect-google', 'disconnect-bridge': 'calendar:disconnect-bridge' };
function calendar(action, { user = 'u1', guild = 'g1' } = {}, opts = {}) {
  if (action === 'status') return cmd('calendar', opts, { user, guild });
  return {
    type: 3,
    guild_id: guild,
    channel_id: 'c1',
    application_id: 'app1',
    token: `tok-${user}-${Math.random()}`,
    member: { user: { id: user }, permissions: '0' },
    data: { custom_id: BUTTONS[action], component_type: 2 },
  };
}
const buttonsOf = (r) => (r.data.components ?? []).flatMap((row) => row.components ?? []);
const labels = (r) => buttonsOf(r).map((b) => b.label);
const newMeeting = (t, opts = {}, who) => t.run(cmd('new-meeting', { name: 'Team Sync', date: '2026-11-25', time: '3pm', ...opts }, who));
const text = (r) => r.data.content;

async function connectGoogle(t, { user = 'u1', guild = 'g1', token = REFRESH } = {}) {
  await saveRefreshToken({ db: t.db, encKey: ENC_KEY, discordUserId: user, teamId: guild, googleEmail: `${user}@gmail.com`, refreshToken: token, nowSec: NOW - 5 * 86400 });
}
/** A PM with a connected Google sign-in and a synced meeting. */
async function pmWithMeeting(t, who = {}) {
  await t.run(cmd('set-timezone', { timezone: 'America/Chicago' }, who));
  await connectGoogle(t, who);
  await t.run(cmd('add-team', { team: 'Design', emails: 'a@gmail.com' }, who));
  await newMeeting(t, {}, who);
  await t.sync();
}

const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) console[level] = (...args) => logged.push(args.map(String).join(' '));
test.afterEach(() => {
  const all = logged.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, 'csecret', ENC_KEY]) assert.ok(!all.includes(secret), 'a secret was logged');
});

// ---------- /calendar disconnect ----------

test('disconnect: the token is revoked at Google, the row and any sign-in links are deleted, and the PM is told', async () => {
  const t = setup();
  await pmWithMeeting(t);
  // An unused sign-in link made earlier must not work after disconnecting.
  t.db.sql("INSERT INTO calendar_connect_codes (code, discord_user_id, team_id, expires_at, used) VALUES ('hash', 'u1', 'g1', 9999999999, 0) RETURNING *");

  const r = await t.run(calendar('disconnect'));
  assert.equal(r.type, 7, 'the private /calendar message the button is on is replaced');
  assert.deepEqual(r.data.components, [], 'and its buttons are removed');
  assert.match(text(r), /Disconnected your Google account \*\*u1@gmail\.com\*\*/);
  assert.match(text(r), /revoked the bot's access at Google/);
  assert.match(text(r), /myaccount\.google\.com\/permissions/);

  assert.deepEqual(t.fake.revokes, [REFRESH], 'the stored refresh token itself was revoked');
  assert.equal(t.db.sql('SELECT * FROM calendar_connections').length, 0, 'the row is gone, so the token is gone from the database');
  assert.equal(t.db.sql("SELECT * FROM calendar_connect_codes WHERE discord_user_id = 'u1'").length, 0);
});

test('disconnect: the meetings keep their Google events, are flagged, and nothing queued will sync', async () => {
  const t = setup();
  await pmWithMeeting(t);
  await t.run(cmd('update-meeting', { name: 'Team Sync', time: '4pm' })); // an update is queued
  assert.equal(t.db.sql('SELECT gcal_dirty FROM meetings')[0].gcal_dirty, 1);
  t.fake.calls.length = 0;

  const r = await t.run(calendar('disconnect'));
  assert.match(text(r), /1 upcoming meeting keeps its Google event but will no longer sync/);
  const m = t.db.sql('SELECT * FROM meetings')[0];
  assert.equal(m.status, 'active');
  assert.equal(m.gcal_dirty, 0, 'the queued update was dropped');
  assert.equal(m.gcal_error, 'calendar disconnected by its owner');
  assert.equal((await t.sync()).claimed, 0);
  assert.equal(t.fake.calls.length, 0, 'the calendar was not touched: the event is not deleted');
  assert.equal([...t.fake.events.values()][0].status, 'confirmed');

  // The reply to /upcoming-meetings says why it no longer syncs.
  const list = await t.run(cmd('upcoming-meetings'));
  assert.match(text(list), /calendar disconnected by its owner/);
});

test('after disconnecting: status says so, and the PM can connect again', async () => {
  const t = setup();
  await pmWithMeeting(t);
  await t.run(calendar('disconnect'));
  const status = await t.run(calendar('status'));
  assert.match(text(status), /not connected/);
  assert.deepEqual(labels(status), ['Connect']);
  const again = await t.run(calendar('connect'));
  assert.equal(again.type, 7);
  assert.match(buttonsOf(again)[0].url, /^https:\/\/accounts\.google\.com\//);
  assert.match(text(await t.run(calendar('disconnect'))), /nothing to disconnect/);
});

test('if Google cannot be reached, NOTHING is deleted and the PM is asked to try again; the retry then works', async () => {
  const t = setup();
  await pmWithMeeting(t);
  t.fake.setRevokeReply(new Error('socket hang up'));
  const r = await t.run(calendar('disconnect'));
  assert.match(text(r), /could not reach Google/);
  assert.match(text(r), /Nothing was changed/);
  assert.equal((await getConnection(t.db, 'u1')).status, 'connected');
  assert.equal(await readRefreshToken({ db: t.db, encKey: ENC_KEY, discordUserId: 'u1' }), REFRESH, 'the token is still stored, so it can be revoked later');
  assert.equal(t.db.sql('SELECT gcal_error FROM meetings')[0].gcal_error, null);

  t.fake.setRevokeReply({ status: 503, body: {} });
  assert.match(text(await t.run(calendar('disconnect'))), /Nothing was changed/);

  t.fake.setRevokeReply({ status: 200, body: {} });
  assert.match(text(await t.run(calendar('disconnect'))), /revoked the bot's access/);
  assert.equal(await getConnection(t.db, 'u1'), null);
});

test('Google saying the token was already revoked or expired still disconnects, with an honest message', async () => {
  const t = setup();
  await pmWithMeeting(t);
  t.fake.setRevokeReply({ status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } });
  const r = await t.run(calendar('disconnect'));
  assert.match(text(r), /already ended this sign-in/);
  assert.equal(await getConnection(t.db, 'u1'), null);
});

test('if Google refuses to revoke, the row is still deleted and the PM is told to remove the app themselves', async () => {
  const t = setup();
  await pmWithMeeting(t);
  t.fake.setRevokeReply({ status: 400, body: { error: 'invalid_request' } });
  const r = await t.run(calendar('disconnect'));
  assert.match(text(r), /could not revoke the access at Google/);
  assert.match(text(r), /myaccount\.google\.com\/permissions/);
  assert.equal(await getConnection(t.db, 'u1'), null);
});

test('a sign-in Google had already stopped accepting is cleared without calling Google', async () => {
  const t = setup();
  await pmWithMeeting(t);
  await markDisconnected(t.db, 'u1', 'invalid_grant', NOW);
  const r = await t.run(calendar('disconnect'));
  assert.match(text(r), /already stopped accepting this sign-in/);
  assert.deepEqual(t.fake.revokes, []);
  assert.equal(await getConnection(t.db, 'u1'), null);
});

test('if the stored token cannot be read (key changed) or sign-in is not set up on the bot, the row is deleted and the PM is told to remove access themselves', async () => {
  const wrongKey = setup();
  await pmWithMeeting(wrongKey);
  const out = await disconnectGoogle({ db: wrongKey.db, config: { ...config, encKey: randomBytes(32).toString('base64') }, discordUserId: 'u1', nowSec: NOW, fetchImpl: wrongKey.fake.fetchImpl });
  assert.deepEqual([out.ok, out.revoked], [true, 'manual']);
  assert.deepEqual(wrongKey.fake.revokes, []);
  assert.equal(await getConnection(wrongKey.db, 'u1'), null);

  const notConfigured = setup({ signInConfigured: false });
  await connectGoogle(notConfigured);
  const r = await notConfigured.run(calendar('disconnect'));
  assert.match(text(r), /could not revoke the access at Google/);
  assert.equal(await getConnection(notConfigured.db, 'u1'), null);
});

test('one PM disconnecting never touches another PM', async () => {
  const t = setup();
  await pmWithMeeting(t);
  await connectGoogle(t, { user: 'u2', token: 'second-refresh-token' });
  await t.run(calendar('disconnect', { user: 'u2' }));
  assert.deepEqual(t.fake.revokes, ['second-refresh-token']);
  assert.equal((await getConnection(t.db, 'u1')).status, 'connected');
  assert.equal(t.db.sql('SELECT gcal_error FROM meetings')[0].gcal_error, null);
});

test('with both a Google sign-in and an Apps Script calendar: the first disconnect removes only the sign-in, the second removes the script', async () => {
  const t = setup({ bridge: createFakeBridge() });
  await pmWithMeeting(t);
  await saveCalendarAccount(t.db, 'u1', 'https://script.google.com/macros/s/AAAA/exec', 'script@gmail.com', NOW);
  t.db.sql("INSERT INTO meetings (guild_id, name, name_key, channel_id, timezone, start_at, created_by, created_at, updated_at, gcal_owner_id, gcal_event_id, gcal_provider) VALUES ('g1','Old','old','c1','UTC',9999999999,'u1',1,1,'u1','vold',NULL) RETURNING *");

  const first = await t.run(calendar('disconnect'));
  assert.match(text(first), /Disconnected your Google account/);
  assert.match(text(first), /Run `\/calendar` again and press \*\*Disconnect Apps Script\*\* to remove that one too/);
  assert.equal(t.db.sql("SELECT gcal_error FROM meetings WHERE name = 'Old'")[0].gcal_error, null, 'the script\'s meeting is untouched');
  assert.equal(t.db.sql("SELECT gcal_error FROM meetings WHERE name = 'Team Sync'")[0].gcal_error, 'calendar disconnected by its owner');

  assert.deepEqual(labels(await t.run(calendar('status'))), ['Connect', 'Disconnect Apps Script']);
  const second = await t.run(calendar('disconnect-bridge'));
  assert.match(text(second), /Disconnected script@gmail\.com/);
  assert.equal(t.db.sql("SELECT gcal_error FROM meetings WHERE name = 'Old'")[0].gcal_error, 'calendar disconnected by its owner');
});

test('with nothing connected there is nothing to disconnect; with no calendar feature at all the bot says so', async () => {
  const t = setup();
  assert.match(text(await t.run(calendar('disconnect'))), /nothing to disconnect/);
  const off = setup({ signInConfigured: false });
  assert.match(text(await off.run(calendar('status'))), /not enabled/);
});

test('the slow part runs after Discord is answered, and the result is shown in the same private reply', async () => {
  const deferred = [];
  const t = setup({ deferred });
  await pmWithMeeting(t);
  const r = await t.run(calendar('disconnect'));
  assert.equal(r.type, 6, 'a deferred update: Discord keeps the private message while the bot works');
  await Promise.all(deferred);
  assert.equal(t.discord.edits.length, 1);
  assert.match(t.discord.edits[0].content, /Disconnected your Google account/);
  assert.deepEqual(t.discord.edits[0].components, [], 'the buttons are removed once it is done');
  assert.equal(await getConnection(t.db, 'u1'), null);
});

test('revokeToken: sends only the token, treats invalid_token as done, and never echoes Google\'s text or the token', async () => {
  const seen = [];
  const reply = (status, body) => async (url, init) => {
    seen.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(init.body)), type: init.headers['Content-Type'] });
    return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await revokeToken({ token: REFRESH, fetchImpl: reply(200, {}) }), { ok: true, alreadyInvalid: false });
  assert.deepEqual(seen[0], { url: 'https://oauth2.googleapis.com/revoke', form: { token: REFRESH }, type: 'application/x-www-form-urlencoded' });
  assert.deepEqual(await revokeToken({ token: REFRESH, fetchImpl: reply(400, { error: 'invalid_token' }) }), { ok: true, alreadyInvalid: true });
  const odd = await revokeToken({ token: REFRESH, fetchImpl: reply(400, { error: `bad ${REFRESH}` }) });
  assert.equal(odd.ok, false);
  assert.ok(!odd.error.includes(REFRESH));
  assert.equal((await revokeToken({ token: REFRESH, fetchImpl: reply(500, {}) })).kind, 'transient');
  assert.equal((await revokeToken({ token: REFRESH, fetchImpl: async () => { throw new Error('boom'); } })).kind, 'transient');
});

// ---------- /calendar status ----------

test('status: connected shows the account, when it was connected, that it works, and the synced meetings', async () => {
  const t = setup();
  await pmWithMeeting(t);
  await recordRefresh(t.db, 'u1', 'ok', NOW - 3600);
  const s = text(await t.run(calendar('status')));
  assert.match(s, /Google sign-in: connected\*\* as \*\*u1@gmail\.com\*\*/);
  assert.match(s, new RegExp(`since <t:${NOW - 5 * 86400}:D>`));
  assert.match(s, new RegExp(`working \\(checked <t:${NOW - 3600}:R>\\)`));
  assert.match(s, /used for meetings in this server/);
  assert.match(s, /Upcoming synced meetings: 1\./);
});

test('status: never checked, a temporary problem, another server, and a lost sign-in are each described', async () => {
  const t = setup();
  await connectGoogle(t);
  assert.match(text(await t.run(calendar('status'))), /not checked yet/);

  await recordRefresh(t.db, 'u1', 'error: transient: Google answered HTTP 503', NOW - 60);
  const problem = text(await t.run(calendar('status')));
  assert.match(problem, /had a temporary problem/);
  assert.ok(!problem.includes('503'), 'internal error text is not shown');

  assert.match(text(await t.run(calendar('status'), NOW)), /used for meetings in this server/);
  assert.match(text(await t.run({ ...calendar('status'), guild_id: 'other-server' })), /connected in a different server/);

  await markDisconnected(t.db, 'u1', 'invalid_grant', NOW - 120);
  const lost = text(await t.run(calendar('status')));
  assert.match(lost, /Google sign-in: disconnected\.\*\* It was \*\*u1@gmail\.com\*\*/);
  assert.match(lost, /Press \*\*Reconnect\*\*/);
});

test('status: nothing connected; an Apps Script calendar alone; both are shown together', async () => {
  const t = setup({ bridge: createFakeBridge() });
  assert.match(text(await t.run(calendar('status'))), /not connected/);

  await saveCalendarAccount(t.db, 'u1', 'https://script.google.com/macros/s/AAAA/exec', 'script@gmail.com', NOW);
  const alone = text(await t.run(calendar('status')));
  assert.match(alone, /^\*\*Apps Script calendar: connected\*\* as script@gmail\.com \(since <t:\d+:D>\)\.\nUpcoming synced meetings: 0\./);

  await connectGoogle(t);
  const both = text(await t.run(calendar('status')));
  assert.match(both, /Google sign-in: connected/);
  assert.match(both, /Apps Script calendar: connected\*\* as script@gmail\.com/);
});

test('status shows the buttons that fit each state, and every reply is private', async () => {
  const t = setup({ bridge: createFakeBridge() });
  const status = async (who) => {
    const r = await t.run(calendar('status', who));
    assert.equal(r.type, 4);
    assert.equal(r.data.flags, 64);
    for (const b of buttonsOf(r)) assert.ok(b.custom_id?.startsWith('calendar:'));
    return r;
  };
  const nothing = await status();
  assert.match(text(nothing), /\*\*not connected\*\*\. Press \*\*Connect\*\*/);
  assert.deepEqual(labels(nothing), ['Connect']);
  assert.deepEqual(buttonsOf(nothing).map((b) => b.style), [1]);

  await connectGoogle(t);
  const google = await status();
  assert.deepEqual(labels(google), ['Disconnect Google'], 'no Connect button while connected');
  assert.equal(buttonsOf(google)[0].style, 4);

  await saveCalendarAccount(t.db, 'u1', 'https://script.google.com/macros/s/AAAA/exec', 'script@gmail.com', NOW);
  assert.deepEqual(labels(await status()), ['Disconnect Google', 'Disconnect Apps Script']);

  await markDisconnected(t.db, 'u1', 'invalid_grant', NOW);
  assert.deepEqual(labels(await status()), ['Reconnect', 'Disconnect Google', 'Disconnect Apps Script'], 'a lost sign-in can be reconnected or removed');

  // An Apps Script calendar alone, on a bot without Google sign-in: nothing to connect with a button.
  const bridgeOnly = setup({ bridge: createFakeBridge(), signInConfigured: false });
  await saveCalendarAccount(bridgeOnly.db, 'u1', 'https://script.google.com/macros/s/AAAA/exec', 'script@gmail.com', NOW);
  assert.deepEqual(labels(await bridgeOnly.run(calendar('status'))), ['Disconnect Apps Script']);
  const plain = await bridgeOnly.run(calendar('status', { user: 'u2' }));
  assert.match(text(plain), /Google sign-in is not set up on this bot.*\/calendar url:/);
  assert.deepEqual(labels(plain), []);
});

test('the Connect button: a fresh one-time link each click, refused while already connected or without Google settings', async () => {
  const t = setup();
  const first = await t.run(calendar('connect'));
  assert.equal(first.type, 7);
  const [link] = buttonsOf(first);
  assert.deepEqual([link.type, link.style, link.label], [2, 5, 'Sign in with Google']);
  assert.equal(link.custom_id, undefined, 'a link button has a url, not a custom id');
  assert.ok(link.url.length <= 512);
  assert.match(text(first), /works once, for 10 minutes/);
  const second = await t.run(calendar('connect'));
  assert.notEqual(buttonsOf(second)[0].url, link.url, 'each click makes a new link');

  await connectGoogle(t);
  const already = await t.run(calendar('connect'));
  assert.match(text(already), /already connected.*Disconnect Google/);
  assert.deepEqual(already.data.components, []);

  const off = setup({ signInConfigured: false, bridge: createFakeBridge() });
  const none = await off.run(calendar('connect'));
  assert.match(text(none), /Google sign-in is not set up on this bot/);
  assert.deepEqual(none.data.components, []);
});

test('status and disconnect never show a token, a key or a secret', async () => {
  const t = setup();
  await pmWithMeeting(t);
  const replies = [text(await t.run(calendar('status'))), text(await t.run(calendar('disconnect')))];
  for (const r of replies) for (const secret of [REFRESH, ACCESS, 'csecret', ENC_KEY]) assert.ok(!r.includes(secret));
});
