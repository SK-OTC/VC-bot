// Named recording setups (/recording setup | list | delete), choosing one on /new-meeting, /update-meeting and presets, the
// fallback to the Default setup (always said out loud), the start-time trigger for Discord voice channel locations only, routing,
// and the guards against a second recording or a second set of posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/commands.js';
import { handleApi } from '../src/api.js';
import { runDueJobs } from '../src/scheduler.js';
import { autoRecord } from '../src/auto-record.js';
import { createSession, resolveRouting, DEFAULT_TRANSCRIPT_SETTINGS } from '../src/recording-store.js';
import { BUILTIN_DEFAULT, resolveNamedSetup, saveNamedSetup, sessionRouting, withDefaults } from '../src/named-setups.js';
import { recordingStatusLine } from '../src/messages.js';
import { fetchRemoteTeam } from '../recorder/remote-config.mjs';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = Math.floor(Date.UTC(2026, 10, 22, 12, 0, 0) / 1000);
const GUILD = '222222222222222222';
const OTHER_GUILD = '888888888888888888';
const VC = '111111111111111111'; // allowed with /recording voice-channel
const VC_NO_SETUP = '555555555555555555';
const MEETING_CH = '999999999999999999'; // where the command is typed / reminders go
const PRIV = '301000000000000001'; // a private text channel (hidden from @everyone)
const OPEN = '301000000000000002'; // a text channel everyone can see
const SUMMARY = '301000000000000003';
const LINKS = '301000000000000004';
const ELSEWHERE = '301000000000000005'; // a text channel in another server
const ADMIN = '700000000000000001';
const MEMBER = '700000000000000002';
const MANAGE = '32';
const SECRET = 'a-long-shared-secret-for-tests';
const link = (channel = VC, guild = GUILD) => `https://discord.com/channels/${guild}/${channel}`;

const channels = {
  [VC]: { type: 2, guildId: GUILD, name: 'Sales call' },
  [VC_NO_SETUP]: { type: 2, guildId: GUILD, name: 'Lounge' },
  [MEETING_CH]: { type: 0, guildId: GUILD, name: 'general' },
  [PRIV]: { type: 0, guildId: GUILD, name: 'transcripts', private: true },
  [OPEN]: { type: 0, guildId: GUILD, name: 'open' },
  [SUMMARY]: { type: 0, guildId: GUILD, name: 'summaries' },
  [LINKS]: { type: 5, guildId: GUILD, name: 'recordings' },
  [ELSEWHERE]: { type: 0, guildId: OTHER_GUILD, name: 'not-here' },
};

function fakeRecorder(result = { ok: true }) {
  const calls = [];
  return { calls, async dispatch(i) { calls.push(i); return result; } };
}

function setup({ recorder = fakeRecorder(), script = [] } = {}) {
  const db = createTestDb();
  db.sql(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('${VC}', '${GUILD}', 'Sales', 'a', ${NOW}, ${NOW})`);
  const discord = createFakeDiscord(script, { channels });
  const deferred = [];
  const run = async (interaction, { defer = false } = {}) =>
    handleInteraction(interaction, { db, discord, recorder, nowSec: NOW, defer: defer ? (p) => deferred.push(p) : null });
  const tick = (nowSec) => runDueJobs({ db, discord, nowSec, recorder });
  return { db, discord, recorder, run, tick, deferred };
}

const member = (user, perms) => ({ user: { id: user }, permissions: perms });
const slash = (name, opts = {}, { user = ADMIN, perms = MANAGE } = {}) => ({
  type: 2,
  guild_id: GUILD,
  channel_id: MEETING_CH,
  application_id: 'app1',
  token: 'tok',
  member: member(user, perms),
  data: { name, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 })) },
});
const recording = (sub, opts = {}, who = {}) => {
  const i = slash('recording', {}, who);
  i.data.options = [{ name: sub, type: 1, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 })) }];
  return i;
};
const autocomplete = (command, opts, focused) => ({
  type: 4,
  guild_id: GUILD,
  channel_id: MEETING_CH,
  member: member(ADMIN, MANAGE),
  data: { name: command, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: 3, ...(n === focused ? { focused: true } : {}) })) },
});
const namedRows = (db) => db.sql('SELECT * FROM named_recording_setups ORDER BY name_key');
const meetings = (db) => db.sql('SELECT * FROM meetings ORDER BY id');
const sessions = (db) => db.sql('SELECT * FROM recording_sessions ORDER BY created_at, id');
const TOMORROW = '2026-11-23';
const START = Math.floor(Date.UTC(2026, 10, 23, 15, 0, 0) / 1000);

async function addSetup(db, name, { privateId = null, summaryId = null, linkId = null, audio = false } = {}) {
  await saveNamedSetup(db, { guildId: GUILD, name, privateChannelId: privateId, summaryChannelId: summaryId, linkChannelId: linkId, audio, createdBy: ADMIN }, NOW);
}

/** Runs the deferred part of a reply (the channel checks) and returns the text it would edit the reply to. */
async function settle(t, r) {
  if (r.type !== 5) return r.data.content;
  await Promise.all(t.deferred.splice(0));
  return t.discord.edits.at(-1).content;
}

// ---------- /recording setup ----------

test('/recording setup: only Manage Server; everyone else is refused and nothing is saved', async () => {
  const t = setup();
  const r = await t.run(recording('setup', { name: 'Sales', private_channel: PRIV }, { user: MEMBER, perms: '0' }));
  assert.match(r.data.content, /Manage Server/);
  assert.equal(namedRows(t.db).length, 0);
  assert.match((await t.run(recording('list', {}, { user: MEMBER, perms: '0' }))).data.content, /Manage Server/);
});

test('/recording setup: checks each new channel and posts in it, private first and the most public last, then saves', async () => {
  const t = setup();
  const r = await t.run(recording('setup', { name: 'Sales', private_channel: PRIV, summary_channel: SUMMARY, link_channel: LINKS, audio: true }), { defer: true });
  const text = await settle(t, r);
  assert.match(text, /Saved the recording setup/);
  assert.match(text, new RegExp(`Transcript file: <#${PRIV}>`));
  assert.match(text, new RegExp(`Summary and its link: <#${SUMMARY}>`));
  assert.match(text, new RegExp(`Recording-ready link: <#${LINKS}>`));
  assert.match(text, new RegExp(`Audio: posted in <#${PRIV}>`));
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [PRIV, SUMMARY, LINKS]);
  assert.match(t.discord.posts[0].content, /Transcripts and audio of meetings that use the \*\*Sales\*\* recording setup/);
  assert.ok(!/Warning/.test(text), 'a private channel that hides itself from @everyone gets no warning');
  const [row] = namedRows(t.db);
  assert.deepEqual([row.name, row.private_channel_id, row.summary_channel_id, row.link_channel_id, row.audio], ['Sales', PRIV, SUMMARY, LINKS, 1]);
});

test('/recording setup: a channel the bot cannot see, a voice channel, or one in another server saves nothing and posts nothing', async () => {
  for (const [opts, why] of [
    [{ private_channel: '301000000000000099' }, /can't see/],
    [{ summary_channel: VC }, /must be a text channel/],
    [{ link_channel: ELSEWHERE }, /not in this server/],
  ]) {
    const t = setup();
    const text = await settle(t, await t.run(recording('setup', { name: 'Sales', ...opts }), { defer: true }));
    assert.match(text, /Nothing was saved/);
    assert.match(text, why);
    assert.equal(namedRows(t.db).length, 0);
    assert.equal(t.discord.posts.length, 0);
  }
});

test('/recording setup: if the bot cannot post in one channel, nothing is saved and the more public channels are not told', async () => {
  const t = setup({ script: [{ ok: false, error: 'Missing Access' }] });
  const text = await settle(t, await t.run(recording('setup', { name: 'Sales', private_channel: PRIV, summary_channel: SUMMARY }), { defer: true }));
  assert.match(text, /Nothing was saved/);
  assert.match(text, new RegExp(`<#${PRIV}>: I need View Channel, Send Messages, Attach Files`));
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [PRIV], 'stopped at the first failure');
  assert.equal(namedRows(t.db).length, 0);
});

test('/recording setup: a "private" channel visible to everyone is saved with a visible warning', async () => {
  const t = setup();
  const text = await settle(t, await t.run(recording('setup', { name: 'Sales', private_channel: OPEN }), { defer: true }));
  assert.match(text, /Saved/);
  assert.match(text, new RegExp(`Warning: <#${OPEN}> does not hide itself from @everyone, so it may not be private`));
});

test('/recording setup: audio needs a private channel (its own or the Default\'s); audio never goes to a fallback channel', async () => {
  const t = setup();
  const r = await t.run(recording('setup', { name: 'Sales', summary_channel: SUMMARY, audio: true }));
  assert.match(r.data.content, /`audio:True` needs a private channel/);
  assert.equal(namedRows(t.db).length, 0);
  await addSetup(t.db, 'Default', { privateId: PRIV });
  const ok = await settle(t, await t.run(recording('setup', { name: 'Sales', summary_channel: SUMMARY, audio: true }), { defer: true }));
  assert.match(ok, new RegExp(`Audio: posted in <#${PRIV}>`));
  assert.match(ok, new RegExp(`Transcript file: <#${PRIV}> \\(from Default\\)`));
});

test('/recording setup: just the name shows it; the Default is built in until saved; clear blanks a channel; unchanged channels are not re-posted', async () => {
  const t = setup();
  const shown = await t.run(recording('setup', { name: 'default' }));
  assert.match(shown.data.content, /\*\*Default\*\* \(built in: nothing saved yet\)/);
  assert.equal(namedRows(t.db).length, 0, 'showing saves nothing');

  await settle(t, await t.run(recording('setup', { name: 'Sales', private_channel: PRIV, summary_channel: SUMMARY }), { defer: true }));
  const before = t.discord.posts.length;
  const again = await t.run(recording('setup', { name: 'sales', private_channel: PRIV, clear: 'summary_channel' }));
  assert.equal(again.type, 4, 'nothing new to check, so it answers at once');
  assert.match(again.data.content, /Updated the recording setup/);
  assert.match(again.data.content, /Summary and its link: with the transcript/);
  assert.equal(t.discord.posts.length, before, 'the unchanged private channel is not posted in again');
  assert.equal(namedRows(t.db)[0].summary_channel_id, null);
  assert.match((await t.run(recording('setup', { name: 'Sales', summary_channel: SUMMARY, clear: 'summary_channel' }))).data.content, /not both/);
});

test('/recording setup: at most 25 per server; "none" is not a name', async () => {
  const t = setup();
  for (let i = 0; i < 25; i++) await addSetup(t.db, `Team ${i}`);
  assert.match((await t.run(recording('setup', { name: 'One more', private_channel: PRIV }))).data.content, /already has 25 recording setups/);
  assert.match((await t.run(recording('setup', { name: 'None' }))).data.content, /cannot be a setup name/);
});

test('/recording list and delete: the Default first; deleting says what falls back to Default', async () => {
  const t = setup();
  await addSetup(t.db, 'Default', { privateId: PRIV });
  await addSetup(t.db, 'Sales', { summaryId: SUMMARY });
  const list = (await t.run(recording('list'))).data.content;
  assert.ok(list.indexOf('**Default**') < list.indexOf('**Sales**'));
  assert.match(list, new RegExp(`Transcript file: <#${PRIV}> \\(from Default\\)`), 'blanks are shown as coming from the Default');
  await t.run(slash('new-meeting', { name: 'Pipeline review', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link(), recording_setup: 'Sales' }));
  const del = (await t.run(recording('delete', { name: 'sales' }))).data.content;
  assert.match(del, /Deleted the recording setup \*\*Sales\*\*/);
  assert.match(del, /1 scheduled meeting\(s\) and 0 preset\(s\) still name it: they will use the \*\*Default\*\* setup instead/);
  assert.match((await t.run(recording('delete', { name: 'Sales' }))).data.content, /There is no recording setup called/);
  assert.match((await t.run(recording('delete', { name: 'Default' }))).data.content, /Deleted the saved Default setup/);
  assert.match((await t.run(recording('delete', { name: 'Default' }))).data.content, /nothing saved/);
});

// ---------- choosing a setup on /new-meeting ----------

test('/new-meeting with a Discord voice channel location and a named setup: saved on the meeting and described', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales', { privateId: PRIV, summaryId: SUMMARY, linkId: LINKS });
  const r = await t.run(slash('new-meeting', { name: 'Pipeline review', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link(), recording_setup: 'sales' }));
  assert.match(r.data.content, /Meeting scheduled/);
  assert.match(r.data.content, new RegExp(`Recording: starts automatically in <#${VC}> at the meeting time, with the \\*\\*Sales\\*\\* recording setup \\(transcript → <#${PRIV}>, summary → <#${SUMMARY}>, recording link → <#${LINKS}>\\)`));
  assert.equal(meetings(t.db)[0].recording_setup, 'Sales', 'kept with its real spelling');
});

test('/new-meeting with a Discord location and no setup: the Default is used (stored as blank) and the reply says so', async () => {
  const t = setup();
  const r = await t.run(slash('new-meeting', { name: 'Standup', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link() }));
  assert.match(r.data.content, /with the \*\*Default\*\* recording setup \(transcript → <#999999999999999999>, summary with the transcript\)/);
  assert.equal(meetings(t.db)[0].recording_setup, null);
});

test('/new-meeting with a setup that does not exist: falls back to Default, visibly', async () => {
  const t = setup();
  const r = await t.run(slash('new-meeting', { name: 'Standup', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link(), recording_setup: 'Salse' }));
  assert.match(r.data.content, /Warning: there is no recording setup called \*\*Salse\*\*, so the \*\*Default\*\* setup will be used/);
  assert.match(r.data.content, /with the \*\*Default\*\* recording setup/);
  assert.equal(meetings(t.db)[0].recording_setup, null);
});

test('/new-meeting: recording_setup with a Google Meet or any other location is refused; without it, nothing about recording is said', async () => {
  for (const location of ['https://meet.google.com/abc-defg-hij', 'Room 4B', `<#${VC}>`, `${link()}/444444444444444444`]) {
    const t = setup();
    await addSetup(t.db, 'Sales', { privateId: PRIV });
    const r = await t.run(slash('new-meeting', { name: 'Call', date: TOMORROW, time: '15:00', timezone: 'UTC', location, recording_setup: 'Sales' }));
    assert.match(r.data.content, /only applies when `location` is a Discord voice channel link/, location);
    assert.equal(meetings(t.db).length, 0, location);
    const plain = await t.run(slash('new-meeting', { name: 'Call', date: TOMORROW, time: '15:00', timezone: 'UTC', location }));
    assert.match(plain.data.content, /Meeting scheduled/);
    assert.ok(!/Recording/.test(plain.data.content), `${location}: no recording line`);
  }
});

test('/new-meeting: a voice channel not allowed with /recording voice-channel, or a link to another server, says it will NOT be recorded', async () => {
  const t = setup();
  const r = await t.run(slash('new-meeting', { name: 'A', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link(VC_NO_SETUP) }));
  assert.match(r.data.content, new RegExp(`<#${VC_NO_SETUP}> is not set up for recording, so this meeting will \\*\\*not\\*\\* be recorded`));
  assert.match(r.data.content, /A server admin can allow it with `\/recording voice-channel`/);
  const other = await t.run(slash('new-meeting', { name: 'B', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link('666666666666666666', OTHER_GUILD) }));
  assert.match(other.data.content, /another server, so this meeting will not be recorded/);
});

test('autocomplete offers recording setups only for a Discord voice channel location (typed, or from the preset)', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales');
  await addSetup(t.db, 'Support');
  const names = async (i) => (await t.run(i)).data.choices.map((c) => c.value);
  assert.deepEqual(await names(autocomplete('new-meeting', { name: 'X', location: link(), recording_setup: '' }, 'recording_setup')), ['Default', 'Sales', 'Support']);
  assert.deepEqual(await names(autocomplete('new-meeting', { name: 'X', location: link(), recording_setup: 'sup' }, 'recording_setup')), ['Support']);
  assert.deepEqual(await names(autocomplete('new-meeting', { name: 'X', location: 'https://meet.google.com/abc-defg-hij', recording_setup: '' }, 'recording_setup')), []);
  assert.deepEqual(await names(autocomplete('new-meeting', { name: 'X', recording_setup: '' }, 'recording_setup')), [], 'no location at all');
  await t.run(slash('add-update-preset', { name: 'Weekly sales', location: link() }));
  assert.deepEqual(await names(autocomplete('new-meeting', { name: 'Weekly sales', recording_setup: '' }, 'recording_setup')), ['Default', 'Sales', 'Support'], 'the preset\'s location counts');
  const sub = autocomplete('recording', {}, null);
  sub.data.options = [{ name: 'delete', type: 1, options: [{ name: 'name', value: 'sa', type: 3, focused: true }] }];
  assert.deepEqual(await names(sub), ['Sales']);
});

// ---------- presets ----------

test('a preset stores a recording setup; /new-meeting from it uses that setup', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales', { privateId: PRIV, summaryId: SUMMARY });
  const saved = await t.run(slash('add-update-preset', { name: 'Weekly sales', time: '15:00', location: link(), recording_setup: 'sales' }));
  assert.match(saved.data.content, /Recording setup: \*\*Sales\*\*/);
  assert.equal(t.db.sql('SELECT recording_setup FROM presets')[0].recording_setup, 'Sales');
  assert.match((await t.run(slash('meeting-presets'))).data.content, /recording setup Sales/);
  const r = await t.run(slash('new-meeting', { name: 'Weekly sales', date: TOMORROW, timezone: 'UTC' }));
  assert.match(r.data.content, /with the \*\*Sales\*\* recording setup/);
  assert.equal(meetings(t.db)[0].recording_setup, 'Sales');
});

test('a preset whose setup was deleted, or never existed: the meeting uses Default and the reply says so', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales');
  await t.run(slash('add-update-preset', { name: 'Weekly sales', time: '15:00', location: link(), recording_setup: 'Sales' }));
  await t.run(recording('delete', { name: 'Sales' }));
  const r = await t.run(slash('new-meeting', { name: 'Weekly sales', date: TOMORROW, timezone: 'UTC' }));
  assert.match(r.data.content, /no recording setup called \*\*Sales\*\*, so the \*\*Default\*\* setup will be used/);
  assert.equal(meetings(t.db)[0].recording_setup, null);

  const later = setup();
  const p = await later.run(slash('add-update-preset', { name: 'Future', location: link(), recording_setup: 'Not yet' }));
  assert.match(p.data.content, /no recording setup called \*\*Not yet\*\* yet, so meetings from this preset use the \*\*Default\*\* setup/);
});

test('a preset with a setup scheduled at a Google Meet location: the setup is not used, and the reply says so', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales');
  await t.run(slash('add-update-preset', { name: 'Weekly sales', time: '15:00', location: link(), recording_setup: 'Sales' }));
  const r = await t.run(slash('new-meeting', { name: 'Weekly sales', date: TOMORROW, timezone: 'UTC', location: 'https://meet.google.com/abc-defg-hij' }));
  assert.match(r.data.content, /Recording setup: not used\. \*\*Sales\*\* only applies when the location is a Discord voice channel link/);
  assert.equal(meetings(t.db)[0].recording_setup, null);
});

test('a preset refuses a recording setup for a non-Discord location; "Default" clears it', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales');
  const r = await t.run(slash('add-update-preset', { name: 'Offsite', location: 'Room 4B', recording_setup: 'Sales' }));
  assert.match(r.data.content, /only applies when `location` is a Discord voice channel link/);
  await t.run(slash('add-update-preset', { name: 'Weekly', location: link(), recording_setup: 'Sales' }));
  await t.run(slash('add-update-preset', { name: 'Weekly', recording_setup: 'Default' }));
  assert.equal(t.db.sql("SELECT recording_setup FROM presets WHERE name = 'Weekly'")[0].recording_setup, null);
});

test('/update-meeting: change the setup; moving the meeting to a non-Discord location drops it, visibly', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales');
  await addSetup(t.db, 'Support');
  await t.run(slash('new-meeting', { name: 'Call', date: TOMORROW, time: '15:00', timezone: 'UTC', location: link(), recording_setup: 'Sales' }));
  const r = await t.run(slash('update-meeting', { name: 'Call', recording_setup: 'support' }));
  assert.match(r.data.content, /with the \*\*Support\*\* recording setup/);
  assert.equal(meetings(t.db)[0].recording_setup, 'Support');
  const moved = await t.run(slash('update-meeting', { name: 'Call', location: 'https://meet.google.com/abc-defg-hij' }));
  assert.match(moved.data.content, /Recording setup: not used/);
  assert.equal(meetings(t.db)[0].recording_setup, null);
  assert.match((await t.run(slash('update-meeting', { name: 'Call', recording_setup: 'Sales' }))).data.content, /only applies when `location` is a Discord voice channel link/);
});

// ---------- at the start time ----------

async function scheduled(t, opts) {
  await t.run(slash('new-meeting', { name: 'Pipeline review', date: TOMORROW, time: '15:00', timezone: 'UTC', reminder: '0', location: link(), ...opts }));
  return meetings(t.db).at(-1);
}
const startPosts = (t) => t.discord.posts.filter((p) => /is starting now/.test(p.content ?? ''));

test('at the start: a Discord voice channel meeting records, with the setup\'s channels fixed on the session, and the start message says so', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales', { privateId: PRIV, summaryId: SUMMARY, linkId: LINKS, audio: true });
  await scheduled(t, { recording_setup: 'Sales' });
  await t.tick(START);
  assert.equal(t.recorder.calls.length, 1);
  const [s] = sessions(t.db);
  assert.deepEqual(
    [s.setup_name, s.private_channel_id, s.summary_channel_id, s.link_channel_id, s.audio_channel_id, s.meeting_fire_at],
    ['Sales', PRIV, SUMMARY, LINKS, PRIV, START],
  );
  const [msg] = startPosts(t);
  assert.match(msg.content, new RegExp(`🔴 Recording: the bot is joining <#${VC}> to record and transcribe this meeting \\(recording setup: \\*\\*Sales\\*\\*\\)`));
  assert.ok(!/no longer exists/.test(msg.content));
});

test('at the start: a setup deleted after scheduling falls back to Default, and the start message says so', async () => {
  const t = setup();
  await addSetup(t.db, 'Default', { privateId: PRIV });
  await addSetup(t.db, 'Sales', { summaryId: SUMMARY });
  await scheduled(t, { recording_setup: 'Sales' });
  t.db.sql("DELETE FROM named_recording_setups WHERE name = 'Sales'");
  await t.tick(START);
  const [s] = sessions(t.db);
  assert.deepEqual([s.setup_name, s.private_channel_id, s.summary_channel_id], ['Default', PRIV, null]);
  const [msg] = startPosts(t);
  assert.match(msg.content, /recording setup: \*\*Default\*\*/);
  assert.match(msg.content, /⚠️ The recording setup \*\*Sales\*\* no longer exists, so the \*\*Default\*\* setup is used\./);
});

test('at the start: non-Discord locations never record and add no line; a Discord link that cannot record says why', async () => {
  for (const location of ['https://meet.google.com/abc-defg-hij', 'https://zoom.us/j/123', 'Room 4B']) {
    const t = setup();
    await scheduled(t, { location });
    await t.tick(START);
    assert.equal(t.recorder.calls.length, 0, location);
    const [msg] = startPosts(t);
    assert.ok(!/Recording|recorded/.test(msg.content), location);
  }
  const t = setup();
  await scheduled(t, { location: link(VC_NO_SETUP) });
  await t.tick(START);
  assert.match(startPosts(t)[0].content, new RegExp(`⚠️ Not recorded: <#${VC_NO_SETUP}> is not set up for recording`));
});

test('at the start: GitHub refusing is shown as "not recorded" without its error text', async () => {
  const t = setup({ recorder: fakeRecorder({ ok: false, error: 'HTTP 401 Bad credentials ghp_secret' }) });
  await scheduled(t, {});
  await t.tick(START);
  const [msg] = startPosts(t);
  assert.match(msg.content, /⚠️ Not recorded: the recorder could not be started\./);
  assert.ok(!msg.content.includes('ghp_secret') && !msg.content.includes('401'));
});

test('a start job retried after its message failed does not record twice, and the retried message still says it is recording', async () => {
  const t = setup({ script: [{ ok: true }, { ok: false, retryable: true, error: 'HTTP 500' }] }); // the new-meeting notice, then the first start message
  await scheduled(t, {});
  await t.tick(START);
  assert.equal(t.recorder.calls.length, 1);
  assert.equal(t.db.sql("SELECT status FROM jobs WHERE kind = 'start'")[0].status, 'pending', 'scheduled again');
  await t.tick(START + 120);
  assert.equal(t.recorder.calls.length, 1, 'no second recording');
  assert.equal(sessions(t.db).length, 1);
  const msgs = startPosts(t);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].content, /🔴 Recording: this meeting's recording in <#111111111111111111> has already been started/);
});

test('the database itself refuses a second session for the same meeting occurrence, even on another channel', async () => {
  const t = setup();
  const m = await scheduled(t, {});
  const a = await createSession(t.db, { id: 'occ1aaaa', channelId: VC, guildId: GUILD, startedBy: 'scheduled', meetingId: m.id, meetingFireAt: START }, START);
  t.db.sql("UPDATE recording_sessions SET status = 'done'");
  const b = await createSession(t.db, { id: 'occ2bbbb', channelId: VC_NO_SETUP, guildId: GUILD, startedBy: 'scheduled', meetingId: m.id, meetingFireAt: START }, START);
  assert.deepEqual([a.ok, b.conflict], [true, true]);
  const nextWeek = await createSession(t.db, { id: 'occ3cccc', channelId: VC, guildId: GUILD, startedBy: 'scheduled', meetingId: m.id, meetingFireAt: START + 7 * 86400 }, START);
  assert.equal(nextWeek.ok, true);
  // and autoRecord reports the earlier one instead of trying again
  const r = await autoRecord({ db: t.db, discord: t.discord, recorder: t.recorder, meeting: m, fireAt: START, nowSec: START });
  assert.deepEqual([r.started, r.code, r.alreadyStatus], [false, 'already', 'done']);
});

// ---------- routing and the recorder API ----------

test('resolveRouting: named channels win; blanks fall back as before; a link channel equal to the private one is dropped; posting off wins', () => {
  const settings = DEFAULT_TRANSCRIPT_SETTINGS;
  const vcSetup = { backup_channel_id: '400000000000000001' };
  const base = resolveRouting({ settings, setup: vcSetup, session: { start_channel_id: MEETING_CH } });
  assert.deepEqual([base.privateChannelId, base.summaryChannelId, base.linkChannelId, base.audioChannelId], [MEETING_CH, MEETING_CH, null, '400000000000000001']);
  const named = resolveRouting({ settings, setup: vcSetup, session: { start_channel_id: MEETING_CH, private_channel_id: PRIV, summary_channel_id: SUMMARY, link_channel_id: LINKS, audio_channel_id: PRIV } });
  assert.deepEqual([named.privateChannelId, named.summaryChannelId, named.linkChannelId, named.audioChannelId], [PRIV, SUMMARY, LINKS, PRIV]);
  assert.equal(resolveRouting({ settings, setup: vcSetup, session: { private_channel_id: PRIV, link_channel_id: PRIV } }).linkChannelId, null);
  const off = resolveRouting({ settings: { save: true, post: false }, setup: vcSetup, session: { private_channel_id: PRIV, summary_channel_id: SUMMARY, link_channel_id: LINKS } });
  assert.deepEqual([off.privateChannelId, off.summaryChannelId, off.linkChannelId], [null, null, null]);
});

test('resolveNamedSetup / withDefaults / sessionRouting: Default, named with inherited blanks, missing -> Default with a fallback note', async () => {
  const db = createTestDb();
  assert.deepEqual((await resolveNamedSetup(db, GUILD, null)), { setup: BUILTIN_DEFAULT, fallback: null });
  assert.deepEqual((await resolveNamedSetup(db, GUILD, '  ')).fallback, null, 'blank = Default, no warning');
  await saveNamedSetup(db, { guildId: GUILD, name: 'Default', privateChannelId: PRIV, createdBy: ADMIN }, NOW);
  await saveNamedSetup(db, { guildId: GUILD, name: 'Sales', summaryChannelId: SUMMARY, audio: true, createdBy: ADMIN }, NOW);
  const sales = await resolveNamedSetup(db, GUILD, 'SALES');
  assert.deepEqual([sales.setup.name, sales.setup.private_channel_id, sales.setup.summary_channel_id, sales.fallback], ['Sales', PRIV, SUMMARY, null]);
  assert.deepEqual(sessionRouting(sales.setup), { setupName: 'Sales', privateChannelId: PRIV, summaryChannelId: SUMMARY, linkChannelId: null, audioChannelId: PRIV });
  const gone = await resolveNamedSetup(db, GUILD, 'Marketing');
  assert.deepEqual([gone.setup.name, gone.fallback], ['Default', { requested: 'Marketing' }]);
  assert.equal(sessionRouting({ ...BUILTIN_DEFAULT, audio: 1 }).audioChannelId, null, 'audio without a named private channel is not kept');
  assert.equal(withDefaults({ name_key: 'default', private_channel_id: null }, { private_channel_id: PRIV }).private_channel_id, null, 'the Default does not inherit from itself');
});

test('config endpoint: gives the recorder the session\'s fixed routing; an ended session is refused (409) so a re-run job cannot post again', async () => {
  const t = setup();
  await addSetup(t.db, 'Sales', { privateId: PRIV, summaryId: SUMMARY, linkId: LINKS, audio: true });
  await scheduled(t, { recording_setup: 'Sales' });
  await t.tick(START);
  const [s] = sessions(t.db);
  const call = (id) => handleApi(new Request(`https://w.example/api/sessions/${id}/config`, { headers: { Authorization: `Bearer ${SECRET}` } }), { DB: t.db, WORKER_SHARED_SECRET: SECRET }, new URL(`https://w.example/api/sessions/${id}/config`), START);
  const cfg = await (await call(s.id)).json();
  assert.deepEqual(
    [cfg.transcript_channel_id, cfg.summary_channel_id, cfg.link_channel_id, cfg.audio_channel_id, cfg.setup_name, cfg.dm_user_id],
    [PRIV, SUMMARY, LINKS, PRIV, 'Sales', null],
  );
  // editing the setup mid-meeting does not move this recording's results
  await addSetup(t.db, 'Sales', { privateId: OPEN });
  assert.equal((await (await call(s.id)).json()).transcript_channel_id, PRIV);
  t.db.sql("UPDATE recording_sessions SET status = 'done'");
  assert.equal((await call(s.id)).status, 409);

  const ended = await fetchRemoteTeam(
    { SESSION_ID: s.id, WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: SECRET },
    { fetchImpl: async (url, init) => handleApi(new Request(url, init), { DB: t.db, WORKER_SHARED_SECRET: SECRET }, new URL(url), START) },
  );
  assert.deepEqual([ended.found, ended.ended], [false, true]);
});

test('/start-recording (by hand) uses the Default setup and names its channels', async () => {
  const t = setup();
  await addSetup(t.db, 'Default', { privateId: PRIV, summaryId: SUMMARY });
  const i = slash('start-recording', { channel: VC });
  const r = await t.run(i);
  assert.match(r.data.content, new RegExp(`The transcript goes to <#${PRIV}> and the summary to <#${SUMMARY}>`));
  const [s] = sessions(t.db);
  assert.deepEqual([s.setup_name, s.private_channel_id, s.summary_channel_id], ['Default', PRIV, SUMMARY]);
});

test('recordingStatusLine: nothing for a non-Discord location or a bot without recording; setup names cannot break the formatting', () => {
  assert.equal(recordingStatusLine({ applies: false, code: 'not_link' }), null);
  assert.equal(recordingStatusLine({ applies: true, code: 'no_recorder' }), null);
  assert.match(recordingStatusLine({ applies: true, code: 'started', channelId: VC, setupName: '**Bold** _x_' }), /\\\*\\\*Bold\\\*\\\* \\_x\\_/);
  assert.match(recordingStatusLine({ applies: true, code: 'busy_server', channelId: VC }), /one call at a time/);
});

test('a named private channel that is also the voice channel\'s backup channel: the recorder still accepts the settings, and the audio still goes there', async () => {
  const { parseSessionConfig } = await import('../recorder/config.mjs');
  const t = setup();
  t.db.sql(`UPDATE recording_setups SET backup_channel_id = '${PRIV}' WHERE voice_channel_id = '${VC}'`);
  await addSetup(t.db, 'Sales', { privateId: PRIV });
  await scheduled(t, { recording_setup: 'Sales' });
  await t.tick(START);
  const [s] = sessions(t.db);
  const env = { DISCORD_TOKEN: 't', CHANNEL_ID: VC, SESSION_ID: s.id, WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: SECRET };
  const remote = await fetchRemoteTeam(env, { fetchImpl: async (url, init) => handleApi(new Request(url, init), { DB: t.db, WORKER_SHARED_SECRET: SECRET }, new URL(url), START) });
  assert.equal(remote.found, true);
  const cfg = parseSessionConfig(env, remote.team); // used to throw: "backupChannelId must be a different channel from transcriptChannelId"
  assert.deepEqual([cfg.team.transcriptChannelId, cfg.team.backupChannelId, cfg.team.audioChannelId, cfg.team.setupName], [PRIV, '', PRIV, 'Sales']);
});
