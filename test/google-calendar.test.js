import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildEventResource, createGoogleCalendarClient } from '../src/google-calendar.js';
import { saveRefreshToken } from '../src/calendar-connections.js';
import { ACCESS, MEET, createFakeGoogle } from './helpers/google-api.js';
import { createTestDb } from './helpers/d1.js';

const NOW = 1_800_000_000;
const ENC_KEY = randomBytes(32).toString('base64');
const REFRESH = 'fake-refresh-token-abc123';
const config = { clientId: 'cid', clientSecret: 'csecret', encKey: ENC_KEY };
const START = Date.UTC(2026, 10, 25, 21, 0, 0) / 1000;

const payload = (over = {}) => ({
  action: 'create',
  eventId: 'v0123456789abcdefghijklmn',
  meetingId: 42,
  title: 'Team Sync',
  startSec: START,
  durationMin: 60,
  timezone: 'America/Chicago',
  repeat: 'none',
  location: 'Room 4',
  description: 'Discord: https://discord.com/channels/g1/c1',
  guests: ['a@gmail.com', 'b@gmail.com'],
  meet: true,
  sendInvites: true,
  ...over,
});

async function setup(googleOpts) {
  const db = createTestDb();
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: REFRESH, nowSec: NOW });
  const google = createFakeGoogle(googleOpts);
  const sleeps = [];
  const client = createGoogleCalendarClient({ db, config, fetchImpl: google.fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  const call = (p, who = {}) => client.call({ ownerId: 'u1', teamId: 'g1', nowSec: NOW, ...who }, p);
  return { db, google, sleeps, call };
}

// Nothing secret may reach the logs.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) console[level] = (...args) => logged.push(args.map(String).join(' '));
test.afterEach(() => {
  const all = logged.splice(0).join('\n');
  for (const secret of [REFRESH, ACCESS, 'csecret', ENC_KEY]) assert.ok(!all.includes(secret), 'a secret was logged');
});

test('create: one insert on the primary calendar with guests invited, Meet requested, and our meeting id tagged on it', async () => {
  const { call, google } = await setup();
  const r = await call(payload());
  assert.deepEqual(r, { ok: true, eventId: 'v0123456789abcdefghijklmn', meetLink: MEET, htmlLink: 'https://calendar.google.com/event?eid=v0123456789abcdefghijklmn', created: true });

  assert.equal(google.calls.length, 1);
  const c = google.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url.origin + c.url.pathname, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
  assert.equal(c.url.searchParams.get('sendUpdates'), 'all');
  assert.equal(c.url.searchParams.get('conferenceDataVersion'), '1');
  assert.equal(c.headers.Authorization, `Bearer ${ACCESS}`);

  assert.equal(c.body.id, 'v0123456789abcdefghijklmn');
  assert.equal(c.body.summary, 'Team Sync');
  assert.equal(c.body.location, 'Room 4');
  assert.deepEqual(c.body.attendees, [{ email: 'a@gmail.com' }, { email: 'b@gmail.com' }]);
  assert.deepEqual(c.body.extendedProperties, { private: { meetingId: '42' } });
  assert.deepEqual(c.body.start, { dateTime: '2026-11-25T21:00:00.000Z', timeZone: 'America/Chicago' });
  assert.deepEqual(c.body.end, { dateTime: '2026-11-25T22:00:00.000Z', timeZone: 'America/Chicago' });
  assert.equal(c.body.guestsCanModify, false);
  assert.equal(c.body.recurrence, undefined);
  assert.equal(c.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.ok(c.body.conferenceData.createRequest.requestId);
});

test('create with meet:false: no Meet is requested, but conferenceDataVersion is still sent', async () => {
  const { call, google } = await setup();
  const r = await call(payload({ meet: false }));
  assert.equal(r.ok, true);
  assert.equal(r.meetLink, '');
  assert.equal(google.calls[0].body.conferenceData, undefined);
  assert.equal(google.calls[0].url.searchParams.get('conferenceDataVersion'), '1');
});

test('every creation attempt uses a new requestId; a weekly meeting becomes a weekly event', async () => {
  const a = buildEventResource(payload({ repeat: 'weekly' }), { isCreate: true });
  const b = buildEventResource(payload(), { isCreate: true });
  assert.notEqual(a.conferenceData.createRequest.requestId, b.conferenceData.createRequest.requestId);
  assert.deepEqual(a.recurrence, ['RRULE:FREQ=WEEKLY']);
});

test('a retry of a create that already went through reads the event back instead of making a second one', async () => {
  const { call, google } = await setup();
  await call(payload());
  const again = await call(payload());
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.meetLink, MEET);
  assert.deepEqual(google.calls.map((c) => c.method), ['POST', 'POST', 'GET']);
  assert.equal(google.events.size, 1);
});

test('an event id that belongs to a deleted event is a clear, final error', async () => {
  const { call } = await setup();
  await call(payload());
  await call(payload({ action: 'cancel' }));
  const r = await call(payload());
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /deleted/);
});

test('a Meet link that is still being made is waited for', async () => {
  const { call, sleeps } = await setup({ pendingMeet: true });
  const r = await call(payload());
  assert.equal(r.meetLink, MEET);
  assert.deepEqual(sleeps, [700]);
});

test('update: reads the event, sends only a patch (no id, no new Meet), keeps guests\' replies when the guest list is unchanged', async () => {
  const { call, google } = await setup();
  await call(payload());
  google.calls.length = 0;

  const r = await call(payload({ action: 'update', title: 'Renamed', startSec: START + 3600 }));
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.deepEqual(google.calls.map((c) => c.method), ['GET', 'PATCH']);
  const patch = google.calls[1];
  assert.equal(patch.url.searchParams.get('sendUpdates'), 'all');
  assert.equal(patch.url.searchParams.get('conferenceDataVersion'), '1');
  assert.equal(patch.body.summary, 'Renamed');
  assert.equal(patch.body.start.dateTime, '2026-11-25T22:00:00.000Z');
  assert.equal(patch.body.id, undefined);
  assert.equal(patch.body.conferenceData, undefined);
  assert.equal(patch.body.attendees, undefined, 'same guests: the list is not sent again');
  assert.equal(google.events.size, 1, 'same event id: no second event');

  google.calls.length = 0;
  await call(payload({ action: 'update', guests: ['a@gmail.com', 'new@gmail.com'] }));
  assert.deepEqual(google.calls[1].body.attendees, [{ email: 'a@gmail.com' }, { email: 'new@gmail.com' }]);
});

test('updating an event that is gone, or was deleted in Google Calendar, is a final error', async () => {
  const { call } = await setup();
  const missing = await call(payload({ action: 'update' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.retryable, false);
  assert.match(missing.error, /not found/);

  await call(payload());
  await call(payload({ action: 'cancel' }));
  const deleted = await call(payload({ action: 'update' }));
  assert.match(deleted.error, /deleted/);
});

test('cancel: deletes with sendUpdates=all, and an event that is already gone counts as done', async () => {
  const { call, google } = await setup();
  await call(payload());
  google.calls.length = 0;
  const r = await call(payload({ action: 'cancel' }));
  assert.deepEqual(r, { ok: true, eventId: 'v0123456789abcdefghijklmn', cancelled: true });
  assert.equal(google.calls[0].method, 'DELETE');
  assert.equal(google.calls[0].url.searchParams.get('sendUpdates'), 'all');

  assert.equal((await call(payload({ action: 'cancel' }))).ok, true, 'already deleted (410)');
  assert.equal((await call(payload({ action: 'cancel', eventId: 'v-never-existed' }))).ok, true, 'never existed (404)');
});

test('Google errors are sorted into "try again later" and "will not work"', async () => {
  const { call, google } = await setup();
  const cases = [
    [{ status: 503, body: {} }, true, /HTTP 503/],
    [{ status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }, true, /HTTP 429/],
    [{ status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }, true, /HTTP 403/],
    [{ status: 401, body: {} }, true, /did not accept the access token/],
    [new Error('socket hang up'), true, /could not reach Google/],
    [{ status: 403, body: { error: { message: 'Google Calendar API has not been used in project 123', errors: [{ reason: 'accessNotConfigured' }] } } }, false, /Calendar API is not turned on/],
    [{ status: 403, body: { error: { errors: [{ reason: 'insufficientPermissions' }] } } }, false, /permission/],
    [{ status: 400, body: { error: { message: 'Invalid attendee email.', errors: [{ reason: 'invalid' }] } } }, false, /Invalid attendee email/],
  ];
  for (const [reply, retryable, pattern] of cases) {
    google.force(reply);
    const r = await call(payload({ eventId: `v${randomBytes(8).toString('hex').slice(0, 20)}` }));
    assert.equal(r.ok, false);
    assert.equal(r.retryable, retryable, String(reply?.status ?? reply?.message));
    assert.match(r.error, pattern);
    assert.ok(!r.error.includes(ACCESS) && !r.error.includes(REFRESH));
  }
});

test('a problem with the Google sign-in itself is passed on with its code and no call to the Calendar API', async () => {
  const bad = await setup({ tokenReply: { status: 400, body: { error: 'invalid_grant' } } });
  const r = await bad.call(payload());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_grant');
  assert.equal(r.retryable, false);
  assert.equal(bad.google.calls.length, 0);

  const { call, google } = await setup();
  const wrongServer = await call(payload(), { teamId: 'g2' });
  assert.equal(wrongServer.code, 'wrong_team');
  const nobody = await call(payload(), { ownerId: 'u-nobody' });
  assert.equal(nobody.code, 'not_connected');
  assert.equal(google.calls.length, 0);
});

test('a bad event is refused before anything is sent to Google', async () => {
  const { call, google } = await setup();
  for (const bad of [{ guests: ['not-an-email'] }, { title: '' }, { title: 'x'.repeat(201) }, { durationMin: 1 }, { timezone: 'Mars/Base' }, { startSec: 0 }, { guests: Array.from({ length: 101 }, (_, i) => `g${i}@example.com`) }]) {
    const r = await call(payload(bad));
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
  }
  assert.equal(google.calls.length, 0);
});

test('a slow Google is cut off with a retryable error', async () => {
  const db = createTestDb();
  await saveRefreshToken({ db, encKey: ENC_KEY, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: REFRESH, nowSec: NOW });
  const hang = (url, init) => {
    if (String(url).includes('oauth2')) return Promise.resolve(new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3599 }), { status: 200 }));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  const client = createGoogleCalendarClient({ db, config, fetchImpl: hang, timeoutMs: 20 });
  const r = await client.call({ ownerId: 'u1', teamId: 'g1', nowSec: NOW }, payload());
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.error, /did not answer/);
});
