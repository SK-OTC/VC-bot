// /new-meeting, /update-meeting and /cancel-meeting through the organiser's own Google sign-in, end to end:
// real commands -> the sync queue -> the Google Calendar client -> a fake Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handleInteraction } from '../src/commands.js';
import { runCalendarSync } from '../src/calendar-sync.js';
import { saveRefreshToken, markDisconnected, getConnection } from '../src/calendar-connections.js';
import { saveCalendarAccount } from '../src/store.js';
import { createGoogleCalendarClient } from '../src/google-calendar.js';
import { MEET, ACCESS, createFakeGoogle } from './helpers/google-api.js';
import { createFakeBridge, createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000;
const ENC_KEY = randomBytes(32).toString('base64');
const REFRESH = 'fake-refresh-token-abc123';
const config = { clientId: 'cid', clientSecret: 'csecret', encKey: ENC_KEY, redirectUri: 'https://worker.example/oauth/google/callback' };
const publicGoogle = { clientId: 'cid', redirectUri: 'https://worker.example/oauth/google/callback' };

function setup({ bridge = null, googleOpts, googleEnabled = true } = {}) {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const fake = createFakeGoogle(googleOpts);
  const client = createGoogleCalendarClient({ db, config, fetchImpl: fake.fetchImpl, sleep: async () => {} });
  return {
    db,
    discord,
    fake,
    bridge,
    run: (interaction, nowSec = NOW) =>
      handleInteraction(interaction, { db, discord, bridge, google: googleEnabled ? publicGoogle : null, defer: () => {}, nowSec }),
    sync: (nowSec = NOW) => runCalendarSync({ db, discord, bridge, google: googleEnabled ? client : null, nowSec }),
  };
}

const toOptions = (opts) => Object.entries(opts).map(([name, value]) => ({ name, value, type: typeof value === 'boolean' ? 5 : 3 }));
const cmd = (name, opts = {}, { user = 'u1', guild = 'g1' } = {}) => ({
  type: 2,
  guild_id: guild,
  channel_id: 'c1',
  application_id: 'app1',
  token: `tok-${user}-${Math.random()}`,
  member: { user: { id: user }, permissions: '0' },
  data: { name, options: toOptions(opts) },
});
const newMeeting = (t, opts = {}, who) => t.run(cmd('new-meeting', { name: 'Team Sync', date: '2026-11-25', time: '3pm', ...opts }, who));
const meetingRow = (t) => t.db.sql('SELECT * FROM meetings ORDER BY id')[0];

async function connectGoogle(t, { user = 'u1', guild = 'g1', email = 'pm@gmail.com' } = {}) {
  await saveRefreshToken({ db: t.db, encKey: ENC_KEY, discordUserId: user, teamId: guild, googleEmail: email, refreshToken: REFRESH, nowSec: NOW });
}
async function pm(t, who = {}) {
  await t.run(cmd('set-timezone', { timezone: 'America/Chicago' }, who));
  await connectGoogle(t, who);
  await t.run(cmd('add-team', { team: 'Design', emails: 'a@gmail.com, b@gmail.com' }, who));
}

const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) console[level] = (...args) => logged.push(args.map(String).join(' '));
test.afterEach(() => {
  const all = logged.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, 'csecret', ENC_KEY]) assert.ok(!all.includes(secret), 'a secret was logged');
});

test('/new-meeting: the meeting is put on the PM\'s Google Calendar with the team invited and a Meet link posted', async () => {
  const t = setup();
  await pm(t);
  const r = await newMeeting(t);
  assert.match(r.data.content, /Calendar: will be added to pm@gmail\.com shortly/);
  assert.match(r.data.content, /Meet link is posted/);

  const m = meetingRow(t);
  assert.equal(m.gcal_provider, 'oauth');
  assert.equal(m.gcal_owner_id, 'u1');
  assert.equal(m.gcal_dirty, 1);
  assert.match(m.gcal_event_id, /^v[0-9a-v]{24}$/); // saved before any call to Google

  const s = await t.sync();
  assert.equal(s.created, 1);
  const post = t.fake.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.id, m.gcal_event_id);
  assert.deepEqual(post.body.attendees.map((a) => a.email), ['a@gmail.com', 'b@gmail.com']);
  assert.deepEqual(post.body.extendedProperties.private, { meetingId: String(m.id) });
  assert.equal(post.url.searchParams.get('sendUpdates'), 'all');
  assert.equal(post.url.searchParams.get('conferenceDataVersion'), '1');

  const after = meetingRow(t);
  assert.equal(after.gcal_created, 1);
  assert.equal(after.gcal_dirty, 0);
  assert.equal(after.meet_link, MEET);
  assert.ok(t.discord.posts.some((p) => p.content.includes(MEET)), 'the Meet link is posted in the channel');
  assert.equal(t.discord.followups.length, 1);
  assert.match(t.discord.followups[0].content, /pm@gmail\.com/);
});

test('/new-meeting meet:false: no Meet link is requested or posted', async () => {
  const t = setup();
  await pm(t);
  const r = await newMeeting(t, { meet: false });
  assert.match(r.data.content, /No Google Meet link will be created/);
  await t.sync();
  assert.equal(t.fake.calls[0].body.conferenceData, undefined);
  assert.equal(meetingRow(t).meet_link, null);
  assert.ok(!t.discord.posts.some((p) => p.content.includes('meet.google.com')));
});

test('/update-meeting: a time change patches the SAME event and guests are updated; a reminder-only change does not touch Google', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  await t.sync();
  const eventId = meetingRow(t).gcal_event_id;
  t.fake.calls.length = 0;

  const r = await t.run(cmd('update-meeting', { name: 'Team Sync', time: '4pm', location: 'Room 4' }));
  assert.match(r.data.content, /Google event will be updated shortly/);
  await t.sync();
  assert.deepEqual(t.fake.calls.map((c) => c.method), ['GET', 'PATCH']);
  const patch = t.fake.calls[1];
  assert.equal(decodeURIComponent(patch.url.pathname.split('/events/')[1]), eventId);
  assert.equal(patch.url.searchParams.get('sendUpdates'), 'all');
  assert.equal(patch.url.searchParams.get('conferenceDataVersion'), '1');
  assert.equal(patch.body.location, 'Room 4');
  assert.equal(patch.body.start.dateTime, '2026-11-25T22:00:00.000Z');
  assert.equal(t.fake.events.size, 1);
  assert.equal(meetingRow(t).meet_link, MEET, 'the Meet link is kept');

  t.fake.calls.length = 0;
  await t.run(cmd('update-meeting', { name: 'Team Sync', reminder: '30m' }));
  await t.sync();
  assert.equal(t.fake.calls.length, 0);
});

test('/cancel-meeting: the event is deleted with sendUpdates=all', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  await t.sync();
  const eventId = meetingRow(t).gcal_event_id;
  t.fake.calls.length = 0;

  await t.run(cmd('cancel-meeting', { name: 'Team Sync' }));
  const s = await t.sync();
  assert.equal(s.cancelled, 1);
  assert.equal(t.fake.calls.length, 1);
  assert.equal(t.fake.calls[0].method, 'DELETE');
  assert.equal(decodeURIComponent(t.fake.calls[0].url.pathname.split('/events/')[1]), eventId);
  assert.equal(t.fake.calls[0].url.searchParams.get('sendUpdates'), 'all');
  assert.equal(t.fake.events.get(eventId).status, 'cancelled');
  assert.equal(meetingRow(t).gcal_dirty, 0);
});

test('teams are never mixed: only the guest list of the meeting\'s own server is invited', async () => {
  const t = setup();
  await pm(t);
  // Another server has a team with the SAME name and different guests, owned by someone else.
  await t.run(cmd('add-team', { team: 'Design', emails: 'other-server@gmail.com' }, { user: 'u2', guild: 'g2' }));
  await newMeeting(t);
  await t.sync();
  const attendees = t.fake.calls.find((c) => c.method === 'POST').body.attendees.map((a) => a.email);
  assert.deepEqual(attendees, ['a@gmail.com', 'b@gmail.com']);
});

test('a sign-in made in another server is not used here, and the PM is told why', async () => {
  const t = setup();
  await t.run(cmd('set-timezone', { timezone: 'America/Chicago' }));
  await connectGoogle(t, { guild: 'g2' }); // connected in a different server
  const r = await newMeeting(t, { team: 'none' });
  assert.match(r.data.content, /connected for a different server/);
  assert.equal(meetingRow(t).gcal_owner_id, null);
  assert.equal(meetingRow(t).gcal_dirty, 0);
  assert.equal((await t.sync()).claimed, 0);
  assert.equal(t.fake.calls.length, 0);
});

test('a PM who never connected anything behaves as before: the meeting is made, with a hint, and no error', async () => {
  const t = setup();
  await t.run(cmd('set-timezone', { timezone: 'America/Chicago' }));
  const r = await newMeeting(t);
  assert.match(r.data.content, /Run \/calendar and press Connect first/);
  assert.equal(meetingRow(t).gcal_event_id, null);
  assert.equal(t.fake.calls.length, 0);
});

test('with both connected, the Google sign-in is used; a meeting made through the bridge STAYS on the bridge after the PM also signs in', async () => {
  const bridge = createFakeBridge();
  const t = setup({ bridge });
  await t.run(cmd('set-timezone', { timezone: 'America/Chicago' }));
  await saveCalendarAccount(t.db, 'u1', 'https://script.google.com/macros/s/AAAA/exec', 'script@gmail.com', NOW);

  await newMeeting(t, { name: 'Old', team: 'none' }); // only the bridge is connected
  assert.equal(t.db.sql("SELECT gcal_provider FROM meetings WHERE name = 'Old'")[0].gcal_provider, null);
  await t.sync();
  assert.equal(bridge.calls.length, 1);

  await connectGoogle(t); // now the PM signs in too
  await newMeeting(t, { name: 'New', team: 'none' });
  assert.equal(t.db.sql("SELECT gcal_provider FROM meetings WHERE name = 'New'")[0].gcal_provider, 'oauth');

  await t.run(cmd('update-meeting', { name: 'Old', location: 'Room 9' }));
  await t.sync();
  await t.sync();
  assert.deepEqual(bridge.calls.map((c) => c.action), ['create', 'update'], 'Old keeps using the bridge');
  assert.deepEqual(t.fake.calls.filter((c) => c.method === 'POST').map((c) => c.body.summary), ['New']);
});

test('Google sign-in not set up on this bot: an OAuth meeting is not silently dropped, the failure is explained', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  // Same database, with Google switched off on the bot.
  const s = await runCalendarSync({ db: t.db, discord: t.discord, bridge: null, google: null, nowSec: NOW });
  assert.equal(s.failed, 1);
  assert.match(meetingRow(t).gcal_error, /not set up on this bot/);
  assert.equal(meetingRow(t).gcal_dirty, 0);
});

test('a disconnected PM: the meeting cannot sync, with a clear reason', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  await markDisconnected(t.db, 'u1', 'invalid_grant', NOW);
  await t.sync();
  assert.match(meetingRow(t).gcal_error, /not connected/);
});

test('a temporary Google problem is retried later by the queue, then succeeds, with no duplicate event', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  t.fake.force({ status: 503, body: {} });
  const first = await t.sync();
  assert.equal(first.retried, 1);
  assert.equal(meetingRow(t).gcal_dirty, 1);
  assert.equal(t.fake.events.size, 0);

  const second = await t.sync(NOW + 3600);
  assert.equal(second.created, 1);
  assert.equal(t.fake.events.size, 1);
});

// ---------- the failure path: the PM's Google sign-in stops working ----------

const REVOKED = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
const GUESTS = ['a@gmail.com', 'b@gmail.com'];
const noEmails = (text) => GUESTS.every((g) => !text.includes(g)) && !text.includes('pm@gmail.com') && !/[\w.]+@[\w.]+\.\w+/.test(text);
const linkIn = (text) => /<(https:\/\/[^>]+)>/.exec(text)?.[1];

/** A meeting that is already on the calendar, then access is revoked at Google and the PM changes the meeting. */
async function revokedUpdate(t) {
  await pm(t);
  await newMeeting(t);
  await t.sync();
  t.fake.setTokenReply(REVOKED);
  t.fake.calls.length = 0;
  await t.run(cmd('update-meeting', { name: 'Team Sync', time: '4pm' }));
  return t.sync();
}

test('revoked access on an update: disconnected, token wiped, PM DMed a reconnect link, channel gets an Add-to-Calendar link, bot stays up', async () => {
  const t = setup();
  const s = await revokedUpdate(t);
  assert.equal(s.failed, 1);
  assert.equal(s.signInLost, 1);
  assert.equal(t.fake.calls.length, 0, 'no call to the Calendar API was made');

  // 1. disconnected, token wiped, reason recorded
  const conn = await getConnection(t.db, 'u1');
  assert.equal(conn.status, 'disconnected');
  assert.equal(conn.encrypted_refresh_token, null);
  assert.equal(conn.iv, null);
  assert.equal(conn.last_refresh_result, 'invalid_grant');

  // 2. the PM is DMed a reconnect link made for them and this server, and told the event is out of date
  assert.equal(t.discord.dms.length, 2);
  assert.ok(t.discord.dms.every((d) => d.userId === 'u1'));
  const reconnect = new URL(linkIn(t.discord.dms[0].content));
  assert.equal(reconnect.host, 'accounts.google.com');
  assert.equal(reconnect.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/calendar.events.owned');
  assert.equal(reconnect.searchParams.get('redirect_uri'), config.redirectUri);
  const code = t.db.sql("SELECT * FROM calendar_connect_codes WHERE discord_user_id = 'u1'");
  assert.equal(code.length, 1);
  assert.equal(code[0].team_id, 'g1');
  assert.match(t.discord.dms[1].content, /still shows the old details/);

  // 3. the channel gets a link that adds the meeting to a calendar, with no email address in it
  const post = t.discord.posts.find((p) => /Google Calendar sync is not working/.test(p.content));
  assert.ok(post, 'a notice is posted in the channel');
  assert.equal(post.channelId, 'c1');
  assert.deepEqual(post.allowedMentions, { parse: [] });
  assert.ok(noEmails(post.content), 'no email address in the channel');
  const template = new URL(linkIn(post.content));
  assert.equal(template.origin + template.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(template.searchParams.get('action'), 'TEMPLATE');
  assert.equal(template.searchParams.get('text'), 'Team Sync');
  assert.equal(template.searchParams.get('dates'), '20261125T220000Z/20261125T230000Z'); // the updated 4pm start, one hour
  assert.equal(template.searchParams.get('add'), null);
  assert.match(post.content, /sent a link to reconnect/);

  // 4. the meeting itself is untouched and the queue is clear
  const m = meetingRow(t);
  assert.equal(m.status, 'active');
  assert.equal(m.gcal_dirty, 0);
  assert.match(m.gcal_error, /no longer accepts your saved sign-in/);
  assert.ok(t.db.sql('SELECT * FROM jobs WHERE meeting_id = ?', m.id).length > 0, 'reminders are still scheduled');
  assert.equal((await t.sync()).claimed, 0);
});

test('revoked access on a NEW meeting: the PM gets a link that adds it with the guests invited; the channel link has none', async () => {
  const t = setup({ googleOpts: { tokenReply: REVOKED } });
  await pm(t);
  await newMeeting(t);
  await t.sync();

  assert.equal(t.discord.dms.length, 2);
  const guestLink = new URL(linkIn(t.discord.dms[1].content));
  assert.equal(guestLink.host, 'calendar.google.com');
  assert.deepEqual(guestLink.searchParams.get('add').split(','), GUESTS);
  assert.equal(guestLink.searchParams.get('text'), 'Team Sync');
  assert.match(t.discord.dms[1].content, /do not also let me add it/);

  const post = t.discord.posts.find((p) => /not added to/.test(p.content));
  assert.ok(post);
  assert.ok(noEmails(post.content));
  assert.equal(new URL(linkIn(post.content)).searchParams.get('add'), null);
});

test('two meetings queued when access is revoked: the PM is messaged once, and every channel still gets its link', async () => {
  const t = setup({ googleOpts: { tokenReply: REVOKED } });
  await pm(t);
  await newMeeting(t, { name: 'First' });
  await newMeeting(t, { name: 'Second' });
  const s = await t.sync();
  assert.equal(s.signInLost, 2);
  assert.equal(s.failed, 2);
  assert.equal(t.discord.dms.length, 2, 'one reconnect DM and one guest link, for the first meeting only');
  assert.equal(t.db.sql('SELECT * FROM calendar_connect_codes').length, 1, 'one reconnect link');
  for (const name of ['First', 'Second']) {
    assert.ok(t.discord.posts.some((p) => p.content.includes(name) && /Google Calendar sync is not working/.test(p.content)), `${name} has its channel link`);
  }
  assert.match(t.discord.followups.at(-1).content, /not connected/); // the second meeting's private reply explains

  // A meeting made after the disconnect is simply not added to a calendar (with a hint), rather than failing later.
  const r = await newMeeting(t, { name: 'Third' });
  assert.match(r.data.content, /Run \/calendar and press Connect first/);
  assert.equal(t.db.sql("SELECT gcal_event_id FROM meetings WHERE name = 'Third'")[0].gcal_event_id, null);
});

test('if the DM cannot be delivered, the reconnect link goes in the private reply to their command instead', async () => {
  const t = setup({ googleOpts: { tokenReply: REVOKED } });
  t.discord.sendDirectMessage = async () => ({ ok: false, error: 'HTTP 403: Cannot send messages to this user' });
  await pm(t);
  await newMeeting(t);
  await t.sync();
  const reply = t.discord.followups.at(-1).content;
  assert.match(reply, /stopped working/);
  assert.ok(linkIn(reply).startsWith('https://accounts.google.com/'));
  assert.match(t.discord.posts.at(-1).content, /sent a link to reconnect/);
});

test('if nobody can be told privately, the channel says the organizer must reconnect, and nothing throws', async () => {
  const t = setup({ googleOpts: { tokenReply: REVOKED } });
  t.discord.sendDirectMessage = async () => ({ ok: false, error: 'HTTP 403' });
  await pm(t);
  await newMeeting(t);
  await t.sync(NOW + 20 * 60); // the 15 minute window for a private reply has passed
  const post = t.discord.posts.at(-1);
  assert.match(post.content, /needs to reconnect with `\/calendar`\./);
  assert.equal((await getConnection(t.db, 'u1')).status, 'disconnected');
});

test('revoked access on a cancellation: no calendar link (nothing to add), the PM is told the event may still exist', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  await t.sync();
  t.fake.setTokenReply(REVOKED);
  await t.run(cmd('cancel-meeting', { name: 'Team Sync' }));
  const s = await t.sync();
  assert.equal(s.failed, 1);
  assert.equal(t.discord.dms.length, 1, 'only the reconnect DM');
  assert.ok(!t.discord.posts.some((p) => /calendar\.google\.com\/calendar\/render/.test(p.content)));
  assert.match(t.discord.followups.at(-1).content, /Google event may still exist/);
  assert.equal(meetingRow(t).status, 'cancelled');
});

test('after reconnecting, changing the meeting syncs it again onto the SAME event', async () => {
  const t = setup();
  await revokedUpdate(t);
  const eventId = meetingRow(t).gcal_event_id;

  // The PM signs in again (what /oauth/google/callback does) and access works again.
  t.fake.setTokenReply(null);
  const back = await saveRefreshToken({ db: t.db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: 'a-new-refresh-token', nowSec: NOW + 60 });
  assert.deepEqual(back, { ok: true });

  t.fake.calls.length = 0;
  await t.run(cmd('update-meeting', { name: 'Team Sync', location: 'Room 4' }), NOW + 60);
  const s = await t.sync(NOW + 60);
  assert.equal(s.updated, 1);
  assert.deepEqual(t.fake.calls.map((c) => c.method), ['GET', 'PATCH']);
  assert.equal(decodeURIComponent(t.fake.calls[1].url.pathname.split('/events/')[1]), eventId);
  assert.equal(meetingRow(t).gcal_error, null);
  assert.equal(t.fake.events.size, 1);
});

test('other failures are not treated as a lost sign-in: no disconnect, no DM, no channel link', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  t.fake.force({ status: 400, body: { error: { message: 'Invalid attendee email.', errors: [{ reason: 'invalid' }] } } });
  const s = await t.sync();
  assert.equal(s.failed, 1);
  assert.equal(s.signInLost, undefined);
  assert.equal((await getConnection(t.db, 'u1')).status, 'connected');
  assert.equal(t.discord.dms.length, 0);
  assert.ok(!t.discord.posts.some((p) => /calendar\.google\.com\/calendar\/render/.test(p.content)));
});

// ---------- only the calendar's owner may send changes to Google (H2) ----------

test('an admin who is not the owner cannot make the PM\'s Google account invite people or change the event', async () => {
  const t = setup();
  await pm(t);
  await newMeeting(t);
  await t.sync();
  t.fake.calls.length = 0;
  const asAdmin = (name, opts) => ({ ...cmd(name, opts, { user: 'u2' }), member: { user: { id: 'u2' }, permissions: String(0x8) } });

  await t.run(asAdmin('add-team', { team: 'Outsiders', emails: 'stranger@evil.example' }));
  const r = await t.run(asAdmin('update-meeting', { name: 'Team Sync', team: 'Outsiders', location: 'https://evil.example/login' }));
  assert.match(r.data.content, /on <@u1>'s Google Calendar/);
  await t.sync();
  assert.equal(t.fake.calls.filter((c) => c.method === 'PATCH').length, 0, 'nothing was sent to Google as the PM');
  const m = meetingRow(t);
  assert.equal(m.location, null);
  assert.equal(m.guest_team_key, 'design');
  assert.ok(!JSON.stringify([...t.fake.events.values()]).includes('stranger@evil.example'));
});
