import test from 'node:test';
import assert from 'node:assert/strict';
import { runDueJobs } from '../src/scheduler.js';
import { autoRecord } from '../src/auto-record.js';
import { insertMeeting, nameKey, replaceJobs } from '../src/store.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000;
const START = T0 + 3600;
const GUILD = '222222222222222222';
const VC = '111111111111111111';
const VC_NO_SETUP = '555555555555555555';
const TEXT = '333333333333333333';
const MEETING_CHANNEL = '999999999999999999';
const link = (guild = GUILD, channel = VC) => `https://discord.com/channels/${guild}/${channel}`;

const channels = {
  [VC]: { type: 2, guildId: GUILD, name: 'Design' },
  [VC_NO_SETUP]: { type: 2, guildId: GUILD, name: 'Other' },
  [TEXT]: { type: 0, guildId: GUILD, name: 'general' },
  '666666666666666666': { type: 2, guildId: '888888888888888888', name: 'Elsewhere' },
  '777777777777777777': { type: 13, guildId: GUILD, name: 'Stage' },
};

function fakeRecorder(result = { ok: true }) {
  const calls = [];
  return { calls, async dispatch(i) { calls.push(i); return result; } };
}

function setup({ recorder = fakeRecorder(), withSetup = [VC, '666666666666666666', '777777777777777777', TEXT] } = {}) {
  const db = createTestDb();
  for (const vc of withSetup) {
    const g = channels[vc]?.guildId ?? GUILD;
    db.sql(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('${vc}', '${g}', 'T', 'a', ${T0}, ${T0})`);
  }
  const discord = createFakeDiscord([], { channels });
  const tick = (nowSec, rec = recorder) => runDueJobs({ db, discord, nowSec, recorder: rec });
  return { db, discord, recorder, tick };
}

async function seed(db, over = {}) {
  const m = { guild_id: GUILD, name: 'Design sync', channel_id: MEETING_CHANNEL, location: link(), timezone: 'UTC', start_at: START, reminder_minutes: 15, repeat: 'none', role_id: null, created_by: 'u1', ...over };
  m.name_key = nameKey(m.name);
  m.id = await insertMeeting(db, m, T0);
  await replaceJobs(db, m, T0);
  return m;
}
const sessions = (db) => db.sql('SELECT * FROM recording_sessions ORDER BY created_at, id');

test('at the start time a meeting whose location is a usable voice channel link starts a recording', async () => {
  const t = setup();
  const m = await seed(t.db);
  await t.tick(START - 900); // the reminder
  assert.equal(t.recorder.calls.length, 0, 'not at reminder time');
  await t.tick(START);
  assert.equal(t.recorder.calls.length, 1);
  const [s] = sessions(t.db);
  assert.deepEqual({ vc: s.voice_channel_id, guild: s.guild_id, by: s.started_by, meeting: s.meeting_id, start: s.start_channel_id, status: s.status }, { vc: VC, guild: GUILD, by: 'scheduled', meeting: m.id, start: MEETING_CHANNEL, status: 'starting' });
  assert.deepEqual(t.recorder.calls[0], { channel_id: VC, session_id: s.id });
  assert.ok(t.discord.posts.some((p) => /is starting now/.test(p.content)), 'the normal start message is still posted');
});

test('other kinds of location do nothing, and the start message still goes out', async () => {
  for (const location of [null, 'Room 4B', 'Voice Lounge', `<#${VC}>`, 'https://meet.google.com/abc-defg-hij', `${link()}/444444444444444444`, link('@me')]) {
    const t = setup();
    await seed(t.db, { location });
    await t.tick(START);
    assert.equal(t.recorder.calls.length, 0, String(location));
    assert.equal(sessions(t.db).length, 0);
    assert.ok(t.discord.posts.some((p) => /is starting now/.test(p.content)), String(location));
  }
});

test('refused when: another server, not allowed with /recording voice-channel, not a voice channel, a stage channel, or the bot cannot see it', async () => {
  const cases = [
    [link('888888888888888888', '666666666666666666'), /another server/],
    [link(GUILD, VC_NO_SETUP), /not allowed with \/recording voice-channel/],
    [link(GUILD, TEXT), /not a voice channel/],
    [link(GUILD, '777777777777777777'), /not a voice channel/],
    [link(GUILD, '121212121212121212'), /not allowed with \/recording voice-channel/], // unknown channel: stops at the setup gate, never reaching Discord
  ];
  for (const [location, why] of cases) {
    const t = setup();
    const m = await seed(t.db, { location });
    const r = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: START, nowSec: START });
    assert.equal(r.started, false, location);
    assert.match(r.reason, why, location);
    assert.equal(t.recorder.calls.length, 0);
    assert.equal(sessions(t.db).length, 0);
  }
  // a set-up channel the bot cannot see
  const hidden = setup({ withSetup: ['121212121212121212'] });
  const m = await seed(hidden.db, { location: link(GUILD, '121212121212121212') });
  const r = await autoRecord({ db: hidden.db, discord: hidden.discord, recorder: hidden.recorder, meeting: m, fireAt: START, nowSec: START });
  assert.match(r.reason, /cannot see that channel/);
});

test('the bot is not sent in again: not when that channel is already being recorded, not when it is recording elsewhere in the server', async () => {
  const same = setup();
  same.db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('live12345678', '${VC}', '${GUILD}', 'u9', 'running', ${START - 60}, ${START - 60})`);
  const m1 = await seed(same.db);
  const r1 = await autoRecord({ db: same.db, discord: same.discord, recorder: same.recorder, meeting: m1, fireAt: START, nowSec: START });
  assert.match(r1.reason, /already being recorded/);
  assert.equal(same.recorder.calls.length, 0);

  const elsewhere = setup({ withSetup: [VC, VC_NO_SETUP] });
  elsewhere.db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('live87654321', '${VC_NO_SETUP}', '${GUILD}', 'u9', 'starting', ${START - 60}, ${START - 60})`);
  const m2 = await seed(elsewhere.db);
  const r2 = await autoRecord({ db: elsewhere.db, discord: elsewhere.discord, recorder: elsewhere.recorder, meeting: m2, fireAt: START, nowSec: START });
  assert.match(r2.reason, /already running in this server/);
  assert.equal(elsewhere.recorder.calls.length, 0);
});

test('a session that is long stale does not block the meeting', async () => {
  const t = setup();
  t.db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('stale1234567', '${VC}', '${GUILD}', 'u9', 'running', ${START - 7 * 3600}, ${START - 7 * 3600})`);
  const m = await seed(t.db);
  const r = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: START, nowSec: START });
  assert.equal(r.started, true);
});

test('the same occurrence is never started twice (a job can be delivered twice), but the next week\'s one is', async () => {
  const t = setup();
  const m = await seed(t.db, { repeat: 'weekly' });
  const first = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: START, nowSec: START });
  assert.equal(first.started, true);
  t.db.sql(`UPDATE recording_sessions SET status = 'done'`); // it finished quickly
  const again = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: START, nowSec: START + 60 });
  assert.equal(again.started, false);
  assert.match(again.reason, /already handled/);
  assert.equal(t.recorder.calls.length, 1);
  const nextWeek = START + 7 * 86_400;
  const next = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: nextWeek, nowSec: nextWeek });
  assert.equal(next.started, true);
});

test('a start job a few minutes late still records; one past the grace period is skipped by the scheduler as before', async () => {
  const late = setup();
  await seed(late.db);
  await late.tick(START + 300);
  assert.equal(late.recorder.calls.length, 1);
  const tooLate = setup();
  await seed(tooLate.db);
  await tooLate.tick(START + 601);
  assert.equal(tooLate.recorder.calls.length, 0);
});

test('GitHub refusing leaves nothing live, and the reminder still goes out', async () => {
  const t = setup({ recorder: fakeRecorder({ ok: false, error: 'GitHub refused' }) });
  await seed(t.db);
  await t.tick(START);
  const [s] = sessions(t.db);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /could not start/);
  assert.ok(t.discord.posts.some((p) => /is starting now/.test(p.content)));
  assert.equal(t.db.sql("SELECT status FROM jobs WHERE kind = 'start'")[0].status, 'sent');
});

test('without recording configured, or when the check itself blows up, the meeting message is unaffected', async () => {
  const t = setup();
  await seed(t.db);
  await runDueJobs({ db: t.db, discord: t.discord, nowSec: START, recorder: null });
  assert.equal(sessions(t.db).length, 0);
  assert.ok(t.discord.posts.some((p) => /is starting now/.test(p.content)));

  const broken = setup();
  await seed(broken.db);
  broken.discord.getChannel = async () => { throw new Error('discord exploded'); };
  const logs = [];
  const real = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await broken.tick(START);
  } finally {
    console.error = real;
  }
  assert.ok(broken.discord.posts.some((p) => /is starting now/.test(p.content)));
  assert.equal(broken.db.sql("SELECT status FROM jobs WHERE kind = 'start'")[0].status, 'sent');
  assert.ok(logs.some((l) => /auto-record meeting 1 failed unexpectedly: Error/.test(l)));
  assert.ok(!logs.join('\n').includes('exploded'), 'the error text is not logged');
});

test('the reminder job never records, and a cancelled meeting never records', async () => {
  const t = setup();
  await seed(t.db);
  await t.tick(START - 900);
  assert.equal(t.recorder.calls.length, 0);
  t.db.sql("UPDATE meetings SET status = 'cancelled'");
  await t.tick(START);
  assert.equal(t.recorder.calls.length, 0);
});
