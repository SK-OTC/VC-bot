import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { addToCalendarLink, channelNotice, disconnectAndNotify, guestLinkMessage, reconnectMessage } from '../src/calendar-failure.js';
import { getConnection, markDisconnected, saveRefreshToken } from '../src/calendar-connections.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = 1_800_000_000;
const START = Date.UTC(2026, 10, 25, 21, 0, 0) / 1000;
const meeting = (over = {}) => ({
  id: 7, name: 'Team Sync', guild_id: '111', channel_id: '222', start_at: START, duration_min: 90,
  timezone: 'America/Chicago', location: 'Room 4', repeat: 'none', ...over,
});
const many = (n) => Array.from({ length: n }, (_, i) => `person${i}@example.com`);

test('the Add-to-Calendar link is a filled-in Google "new event" form', () => {
  const { url, included, total } = addToCalendarLink(meeting(), ['a@x.com', 'b@x.com']);
  const u = new URL(url);
  const p = u.searchParams;
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(p.get('action'), 'TEMPLATE');
  assert.equal(p.get('text'), 'Team Sync');
  assert.equal(p.get('dates'), '20261125T210000Z/20261125T223000Z'); // UTC, 90 minutes
  assert.equal(p.get('location'), 'Room 4');
  assert.equal(p.get('ctz'), 'America/Chicago');
  assert.equal(p.get('details'), 'Discord: https://discord.com/channels/111/222');
  assert.equal(p.get('add'), 'a@x.com,b@x.com');
  assert.equal(p.get('recur'), null);
  assert.deepEqual([included, total], [2, 2]);
});

test('weekly meetings repeat weekly; no guests means no add=; an empty location is left out; a fixed offset zone is sent as UTC', () => {
  const p = new URL(addToCalendarLink(meeting({ repeat: 'weekly', location: null, timezone: '+05:30' }), []).url).searchParams;
  assert.equal(p.get('recur'), 'RRULE:FREQ=WEEKLY');
  assert.equal(p.get('add'), null);
  assert.equal(p.get('location'), null);
  assert.equal(p.get('ctz'), 'UTC');
});

test('a long guest list is cut to fit a Discord message, and the message says how many fit', () => {
  const guests = many(100);
  const link = addToCalendarLink(meeting(), guests, { maxLength: 1200 });
  assert.ok(link.url.length <= 1200);
  assert.ok(link.included > 0 && link.included < 100);
  assert.equal(link.total, 100);
  assert.deepEqual(new URL(link.url).searchParams.get('add').split(','), guests.slice(0, link.included));

  const text = guestLinkMessage(meeting(), link);
  assert.ok(text.length < 2000, `message is ${text.length} characters`);
  assert.match(text, new RegExp(`first ${link.included} of 100 guests`));
  assert.ok(!guestLinkMessage(meeting(), addToCalendarLink(meeting(), many(2))).includes('fit in the link'));
});

test('every message fits in a Discord message, even with the longest allowed name and a very long reconnect link', () => {
  const m = meeting({ name: 'N'.repeat(80), location: 'L'.repeat(200) });
  assert.ok(guestLinkMessage(m, addToCalendarLink(m, many(100))).length < 2000);
  assert.ok(channelNotice(m, 'create', addToCalendarLink(m, []), { organizerTold: false }).length < 2000);
  assert.ok(reconnectMessage(`https://accounts.google.com/o/oauth2/v2/auth?${'x'.repeat(700)}`).length < 2000);
});

test('the channel notice has no email address and no mention, and says who has been told', () => {
  const link = addToCalendarLink(meeting(), []);
  const told = channelNotice(meeting(), 'create', link, { organizerTold: true });
  const notTold = channelNotice(meeting(), 'update', link, { organizerTold: false });
  assert.match(told, /not added to the organizer's calendar/);
  assert.match(told, /sent a link to reconnect/);
  assert.match(notTold, /not updated on the organizer's calendar/);
  assert.match(notTold, /needs to reconnect with `\/calendar`\./);
  for (const text of [told, notTold]) assert.ok(!/@/.test(text));
});

test('markDisconnected only reports a change the first time', async () => {
  const db = createTestDb();
  const encKey = randomBytes(32).toString('base64');
  await saveRefreshToken({ db, encKey, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: 'fake-token', nowSec: NOW });
  assert.equal(await markDisconnected(db, 'u1', 'invalid_grant', NOW + 1), true);
  assert.equal(await markDisconnected(db, 'u1', 'invalid_grant', NOW + 2), false);
  assert.equal(await markDisconnected(db, 'nobody', 'invalid_grant', NOW + 3), false);
  assert.equal((await getConnection(db, 'u1')).last_refresh_at, NOW + 1, 'the second call changed nothing');
});

test('disconnectAndNotify: wipes the token and DMs a fresh link once; without sign-in settings it still disconnects and says how to reconnect', async () => {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const encKey = randomBytes(32).toString('base64');
  await saveRefreshToken({ db, encKey, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@gmail.com', refreshToken: 'fake-token', nowSec: NOW });
  const signIn = { clientId: 'cid', redirectUri: 'https://worker.example/oauth/google/callback' };

  const first = await disconnectAndNotify({ db, discord, signIn, userId: 'u1', teamId: 'g1', nowSec: NOW + 5, extraMessages: ['extra one'] });
  assert.deepEqual([first.transitioned, first.dmSent], [true, true]);
  assert.deepEqual(discord.dms.map((d) => d.content === 'extra one'), [false, true]);
  assert.match(discord.dms[0].content, /accounts\.google\.com/);
  assert.equal((await getConnection(db, 'u1')).encrypted_refresh_token, null);

  const again = await disconnectAndNotify({ db, discord, signIn, userId: 'u1', teamId: 'g1', nowSec: NOW + 6, extraMessages: ['extra one'] });
  assert.deepEqual([again.transitioned, again.dmSent], [false, false]);
  assert.equal(discord.dms.length, 2, 'nothing more was sent');

  await saveRefreshToken({ db, encKey, discordUserId: 'u2', teamId: 'g1', googleEmail: 'two@gmail.com', refreshToken: 'fake-token-2', nowSec: NOW });
  const bare = await disconnectAndNotify({ db, discord, signIn: null, userId: 'u2', teamId: 'g1', nowSec: NOW + 7 });
  assert.equal(bare.dmSent, true);
  assert.match(discord.dms.at(-1).content, /Reconnect by running `\/calendar` in your server\./);
  assert.ok(!discord.dms.at(-1).content.includes('accounts.google.com'));
});
