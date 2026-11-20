import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { handleInteraction } from '../src/commands.js';
import { COMMANDS } from '../src/definitions.js';
import { createDiscordClient } from '../src/discord.js';
import { saveRecordingSetup, getRecordingSetup, MAX_SETUPS_PER_GUILD } from '../src/recording-store.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';
import { parseSessionConfig } from '../recorder/config.mjs';
import { fetchRemoteTeam } from '../recorder/remote-config.mjs';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const SECRET = 'test-shared-secret-value';
const GUILD = '222222222222222222';
const OTHER_GUILD = '888888888888888888';
const VC = '111111111111111111';
const VC2 = '555555555555555555';
const TXT = '333333333333333333';
const BAK = '444444444444444444';
const ADMIN = '700000000000000001';
const MEMBER = '700000000000000002';
const MANAGE = String(0x20);

const goodChannels = () => ({
  [VC]: { type: 2, guildId: GUILD, name: 'Design Sync' },
  [VC2]: { type: 2, guildId: GUILD, name: 'Eng Standup' },
  [TXT]: { type: 0, guildId: GUILD, name: 'transcripts' },
  [BAK]: { type: 5, guildId: GUILD, name: 'backups' },
});

function setup({ channels = goodChannels(), script = [], withDefer = false, recorder = { async dispatch() { return { ok: true }; } } } = {}) {
  const db = createTestDb();
  const discord = createFakeDiscord(script, { channels, voice: { [ADMIN]: VC } });
  const deferred = [];
  const run = (interaction) =>
    handleInteraction(interaction, { db, discord, recorder, nowSec: NOW, defer: withDefer ? (p) => deferred.push(p) : null });
  return { db, discord, run, deferred };
}

const slash = (name, opts = {}, { user = ADMIN, perms = MANAGE, guild = GUILD } = {}) => ({
  type: 2,
  guild_id: guild,
  channel_id: '999999999999999999',
  application_id: 'app1',
  token: 'tok',
  member: { user: { id: user }, permissions: perms },
  data: { name, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: 3 })) },
});
const isPrivate = (r) => (r.data.flags & 64) === 64;
const rows = (db) => db.sql('SELECT * FROM recording_setups ORDER BY voice_channel_id');
const SETUP = { voice_channel: VC, transcript_channel: TXT };

// ---------- /setup-recording ----------

test('setup: saves the settings, checks the channels, posts a confirmation where transcripts will go', async () => {
  const t = setup();
  const r = await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK, name: 'Design team', language: 'ES', glossary: 'LiteCut,  CapCut\n' }));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, /Saved the recording setup/);
  assert.match(r.data.content, new RegExp(`<#${TXT}>`));
  const [s] = rows(t.db);
  assert.deepEqual(
    { v: s.voice_channel_id, g: s.guild_id, n: s.name, t: s.transcript_channel_id, b: s.backup_channel_id, gl: s.glossary, l: s.language, by: s.created_by },
    { v: VC, g: GUILD, n: 'Design team', t: TXT, b: BAK, gl: 'LiteCut, CapCut', l: 'es', by: ADMIN },
  );
  // a real message went to each channel, with no mentions allowed
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [BAK, TXT]); // the team-facing announcement goes last
  assert.ok(t.discord.posts.every((p) => JSON.stringify(p.allowedMentions) === '{"parse":[]}'));
  assert.match(t.discord.posts[0].content, new RegExp(`<#${VC}>`));
});

test('setup: defaults are the voice channel name, English, no backup, no glossary', async () => {
  const t = setup();
  await t.run(slash('setup-recording', SETUP));
  const [s] = rows(t.db);
  assert.deepEqual({ n: s.name, b: s.backup_channel_id, gl: s.glossary, l: s.language }, { n: 'Design Sync', b: null, gl: '', l: 'en' });
  assert.equal(t.discord.posts.length, 1);
});

test('setup: only people with Manage Server (or Administrator) can use any of the three commands', async () => {
  const t = setup();
  for (const [name, opts] of [['setup-recording', SETUP], ['recording-settings', {}], ['remove-recording-setup', { voice_channel: VC }]]) {
    const denied = await t.run(slash(name, opts, { user: MEMBER, perms: '0' }));
    assert.ok(isPrivate(denied));
    assert.match(denied.data.content, /Manage Server/);
    const other = await t.run(slash(name, opts, { user: MEMBER, perms: String(0x400) })); // View Channel only
    assert.match(other.data.content, /Manage Server/);
  }
  assert.equal(rows(t.db).length, 0);
  assert.equal(t.discord.posts.length, 0);
  assert.doesNotMatch((await t.run(slash('setup-recording', SETUP, { perms: String(0x8) }))).data.content, /Manage Server/); // Administrator
});

test('setup: running it again updates the setup and keeps the original creator and date', async () => {
  const t = setup();
  await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK, glossary: 'one' }, { user: ADMIN }));
  const first = rows(t.db)[0];
  const t2 = { ...t };
  t2.run = (i) => handleInteraction(i, { db: t.db, discord: t.discord, nowSec: NOW + 500 });
  const r = await t2.run(slash('setup-recording', { voice_channel: VC, transcript_channel: TXT, name: 'Renamed' }, { user: MEMBER, perms: MANAGE }));
  assert.match(r.data.content, /Updated the recording setup/);
  const [s] = rows(t.db);
  assert.equal(rows(t.db).length, 1);
  assert.deepEqual({ n: s.name, b: s.backup_channel_id, gl: s.glossary }, { n: 'Renamed', b: null, gl: '' }); // omitted options reset to defaults
  assert.equal(s.created_by, ADMIN);
  assert.equal(s.created_at, first.created_at);
  assert.equal(s.updated_at, NOW + 500);
});

test('setup: input is validated and nothing is saved or posted on a mistake', async () => {
  const t = setup();
  const cases = [
    [{ ...SETUP, transcript_channel: VC }, /must all be different/],
    [{ ...SETUP, backup_channel: TXT }, /must all be different/],
    [{ ...SETUP, backup_channel: VC }, /must all be different/],
    [{ ...SETUP, language: 'english' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'e' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'e1' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'en-US' }, /2 or 3 letter code/],
    [{ ...SETUP, glossary: 'x'.repeat(501) }, /glossary.*too long/],
    [{ ...SETUP, name: 'n'.repeat(51) }, /name.*too long/],
    [{ ...SETUP, voice_channel: 'not-an-id' }, /not valid/],
    [{ ...SETUP, transcript_channel: '123' }, /not valid/],
  ];
  for (const [opts, pattern] of cases) {
    const r = await t.run(slash('setup-recording', opts));
    assert.ok(isPrivate(r));
    assert.match(r.data.content, pattern, JSON.stringify(opts).slice(0, 80));
  }
  assert.equal(rows(t.db).length, 0);
  assert.equal(t.discord.posts.length, 0);
});

test('setup: the glossary has control characters removed and spaces collapsed', async () => {
  const t = setup();
  await t.run(slash('setup-recording', { ...SETUP, glossary: 'a\u0000b\u0007,\t\n c   d' }));
  assert.equal(rows(t.db)[0].glossary, 'a b , c d'); // control characters become spaces, runs of spaces collapse
});

test('setup: channels the bot cannot see, from another server or of the wrong kind are refused with the reason', async () => {
  const channels = {
    ...goodChannels(),
    [TXT]: { type: 2, guildId: GUILD, name: 'actually voice' }, // wrong kind
    [BAK]: { type: 0, guildId: OTHER_GUILD, name: 'elsewhere' }, // another server
  };
  const t = setup({ channels });
  const r = await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK }));
  assert.match(r.data.content, /Nothing was saved/);
  assert.match(r.data.content, new RegExp(`<#${TXT}> must be a text channel`));
  assert.match(r.data.content, new RegExp(`<#${BAK}> is not in this server`));

  const blind = setup({ channels: { [VC]: goodChannels()[VC] } }); // the bot can see only the voice channel
  const r2 = await blind.run(slash('setup-recording', SETUP));
  assert.match(r2.data.content, new RegExp(`I can't see <#${TXT}>`));
  assert.match(r2.data.content, /View Channel/);

  const textAsVoice = setup();
  const r3 = await textAsVoice.run(slash('setup-recording', { voice_channel: TXT, transcript_channel: VC }));
  assert.match(r3.data.content, /must be a voice channel/);
  for (const x of [t, blind, textAsVoice]) {
    assert.equal(rows(x.db).length, 0);
    assert.equal(x.discord.posts.length, 0);
  }
});

test('setup: a Discord lookup that fails for another reason says so and saves nothing', async () => {
  const t = setup();
  t.discord.getChannel = async () => ({ ok: false, status: 500, error: 'HTTP 500' });
  const r = await t.run(slash('setup-recording', SETUP));
  assert.match(r.data.content, /couldn't check/);
  assert.equal(rows(t.db).length, 0);
});

test('setup: if the bot cannot post in a channel it names the permissions it needs and saves nothing', async () => {
  const t = setup({ script: [{ ok: false, status: 403, error: 'HTTP 403: Missing Permissions (code 50013)' }] });
  const r = await t.run(slash('setup-recording', SETUP)); // no backup channel: the transcript channel is the first (and only) post
  assert.match(r.data.content, /Nothing was saved/);
  assert.match(r.data.content, new RegExp(`<#${TXT}>: I need View Channel, Send Messages, Attach Files and Read Message History`));
  assert.match(r.data.content, /Missing Permissions/);
  assert.equal(rows(t.db).length, 0);
});

test('setup: a backup channel the bot cannot post in must not leave a "recording is on" message in the transcript channel', async () => {
  // The first post (the backup channel) fails. Before the fix the transcript channel had already been announced to.
  const t = setup({ script: [{ ok: false, status: 403, error: 'HTTP 403: Missing Permissions (code 50013)' }] });
  const r = await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK }));
  assert.match(r.data.content, /Nothing was saved/);
  assert.match(r.data.content, new RegExp(`<#${BAK}>: I need View Channel, Send Messages and Attach Files`));
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [BAK]); // nothing was sent to the transcript channel
  assert.equal(rows(t.db).length, 0);
});

test('settings: the reply always fits Discord\'s 2000-character limit, even with 25 long setups', async () => {
  const t = setup();
  for (let i = 0; i < MAX_SETUPS_PER_GUILD; i++) {
    t.db.sql(
      `INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, backup_channel_id, glossary, language, created_by, created_at, updated_at)
       VALUES ('9${String(i).padStart(17, '0')}', '${GUILD}', '${'N'.repeat(50)}', '${TXT}', '${BAK}', '${'g'.repeat(300)}', 'en', 'x', 1, 1)`,
    );
  }
  const r = await t.run(slash('recording-settings'));
  assert.ok(r.data.content.length <= 2000, `reply was ${r.data.content.length} characters`);
  assert.match(r.data.content, /…and \d+ more/);
  assert.match(r.data.content, /`voice_channel` option/);
  // a short list is shown in full with no "more" line
  const few = setup();
  await few.run(slash('setup-recording', SETUP));
  assert.doesNotMatch((await few.run(slash('recording-settings'))).data.content, /more\./);
});

test('setup: the limit is 25 per server, but changing an existing one is always allowed', async () => {
  const t = setup();
  for (let i = 0; i < MAX_SETUPS_PER_GUILD; i++) {
    t.db.sql(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, created_by, created_at, updated_at) VALUES ('9${String(i).padStart(17, '0')}', '${GUILD}', 'n${i}', '${TXT}', 'x', 1, 1)`);
  }
  const over = await t.run(slash('setup-recording', SETUP));
  assert.match(over.data.content, /already has 25 recording setups/);
  t.db.sql(`UPDATE recording_setups SET voice_channel_id = '${VC}' WHERE name = 'n0'`);
  assert.match((await t.run(slash('setup-recording', { ...SETUP, name: 'changed' }))).data.content, /Updated/);
});

test('setup: with a deferred reply it answers at once and edits the message with the result', async () => {
  const t = setup({ withDefer: true });
  const r = await t.run(slash('setup-recording', SETUP));
  assert.equal(r.type, 5);
  assert.equal(r.data.flags, 64);
  await Promise.all(t.deferred);
  assert.equal(t.discord.edits.length, 1);
  assert.match(t.discord.edits[0].content, /Saved the recording setup/);
});

test('a voice channel id is never taken over by another server', async () => {
  const db = createTestDb();
  assert.deepEqual(await saveRecordingSetup(db, { voiceChannelId: VC, guildId: GUILD, name: 'A', transcriptChannelId: TXT, createdBy: ADMIN }, NOW), { ok: true, updated: false });
  assert.deepEqual(await saveRecordingSetup(db, { voiceChannelId: VC, guildId: OTHER_GUILD, name: 'Hijack', transcriptChannelId: BAK, createdBy: MEMBER }, NOW), { ok: false });
  assert.equal((await getRecordingSetup(db, VC)).name, 'A');
  assert.equal(await getRecordingSetup(db, VC, OTHER_GUILD), null);
});

// ---------- /recording-settings and /remove-recording-setup ----------

test('settings: lists the setups, shows one, and says when there are none', async () => {
  const t = setup();
  assert.match((await t.run(slash('recording-settings'))).data.content, /No voice channel is set up/);
  await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK, name: 'Design', glossary: 'g'.repeat(200) }));
  await t.run(slash('setup-recording', { voice_channel: VC2, transcript_channel: TXT, name: 'Eng' }));
  const all = await t.run(slash('recording-settings'));
  assert.ok(isPrivate(all));
  assert.match(all.data.content, /\*\*Design\*\*.*backup/s);
  assert.match(all.data.content, /\*\*Eng\*\*/);
  assert.ok(all.data.content.includes('...'), 'a long glossary is shortened in the list');
  assert.match((await t.run(slash('recording-settings', { voice_channel: VC2 }))).data.content, /\*\*Eng\*\*/);
  assert.match((await t.run(slash('recording-settings', { voice_channel: '666666666666666666' }))).data.content, /no recording setup/);
  assert.doesNotMatch((await t.run(slash('recording-settings', {}, { guild: OTHER_GUILD }))).data.content, /Design/); // another server sees nothing
});

test('remove: deletes the setup, only in its own server, and then /start-recording refuses that channel', async () => {
  const t = setup();
  await t.run(slash('setup-recording', SETUP));
  assert.match((await t.run(slash('remove-recording-setup', { voice_channel: VC }, { guild: OTHER_GUILD }))).data.content, /no recording setup/);
  assert.equal(rows(t.db).length, 1);
  assert.match((await t.run(slash('remove-recording-setup', { voice_channel: VC }))).data.content, /Removed the recording setup/);
  assert.equal(rows(t.db).length, 0);
  assert.match((await t.run(slash('remove-recording-setup', { voice_channel: VC }))).data.content, /no recording setup/);
  const start = await t.run(slash('start-recording', {}, { user: ADMIN })); // ADMIN is "in" VC
  assert.match(start.data.content, /not set up for recording/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM recording_sessions')[0].n, 0);
});

test('start-recording: only works for a channel that has been set up in THIS server', async () => {
  const t = setup();
  assert.match((await t.run(slash('start-recording', {}))).data.content, /not set up for recording yet/);
  await t.run(slash('setup-recording', SETUP));
  assert.doesNotMatch((await t.run(slash('start-recording', {}))).data.content, /not set up/);
  // a setup that belongs to another server does not count
  t.db.sql(`UPDATE recording_setups SET guild_id = '${OTHER_GUILD}'`);
  t.db.sql('DELETE FROM recording_sessions');
  assert.match((await t.run(slash('start-recording', {}))).data.content, /not set up for recording yet/);
});

test('definitions: the four admin commands are limited to Manage Server by default, with the right channel kinds', () => {
  const by = (n) => COMMANDS.find((c) => c.name === n);
  for (const n of ['setup-recording', 'recording-settings', 'remove-recording-setup', 'transcript-settings']) {
    assert.equal(by(n).default_member_permissions, '32', n);
    assert.deepEqual(by(n).contexts, [0], n);
  }
  const opts = Object.fromEntries(by('setup-recording').options.map((o) => [o.name, o]));
  assert.deepEqual(Object.keys(opts), ['voice_channel', 'transcript_channel', 'name', 'backup_channel', 'language', 'glossary']);
  assert.deepEqual([opts.voice_channel.required, !!opts.transcript_channel.required, !!opts.name.required], [true, false, false]); // the transcript channel is optional now
  assert.deepEqual(opts.voice_channel.channel_types, [2]);
  assert.deepEqual(opts.transcript_channel.channel_types, [0, 5]);
  assert.deepEqual(opts.backup_channel.channel_types, [0, 5]);
  assert.equal(opts.glossary.max_length, 500);
  assert.ok(!COMMANDS.some((c) => !['setup-recording', 'recording-settings', 'remove-recording-setup', 'transcript-settings'].includes(c.name) && c.default_member_permissions), 'other commands stay open to everyone');
});

// ---------- the Worker endpoint the recorder calls ----------

function api(db) {
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET };
  return (method, path, secret = SECRET) =>
    worker.fetch(new Request(`https://w.example${path}`, { method, headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } }), env, { waitUntil() {} });
}
const addSession = (db, id, channel = VC, guild = GUILD, status = 'starting') =>
  db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('${id}', '${channel}', '${guild}', 'u', '${status}', ${NOW}, ${NOW})`);

test('config endpoint: needs the secret, returns only the session\'s own channel settings, 404 otherwise', async () => {
  const t = setup();
  await t.run(slash('setup-recording', { ...SETUP, backup_channel: BAK, name: 'Design', language: 'fr', glossary: 'Foo' }));
  await t.run(slash('setup-recording', { voice_channel: VC2, transcript_channel: BAK, name: 'Eng' }));
  addSession(t.db, 'sess1234');
  addSession(t.db, 'nosetup1', '666666666666666666');
  addSession(t.db, 'wrongguild', VC, OTHER_GUILD, 'done'); // an ended session, so it does not clash with the live one
  const call = api(t.db);

  const ok = await call('GET', '/api/sessions/sess1234/config');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await ok.json(), {
    voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: TXT, save: true, post: true, dm_user_id: null, backup_channel_id: BAK, glossary: 'Foo', language: 'fr',
  });
  for (const secret of [null, 'wrong', '']) assert.equal((await call('GET', '/api/sessions/sess1234/config', secret)).status, 401);
  assert.equal((await call('POST', '/api/sessions/sess1234/config')).status, 405);
  assert.equal((await call('GET', '/api/sessions/unknownid/config')).status, 404);
  assert.equal((await call('GET', '/api/sessions/bad%20id/config')).status, 404);
  assert.equal((await call('GET', '/api/sessions/nosetup1/config')).status, 404); // session for a channel with no setup
  assert.equal((await call('GET', '/api/sessions/wrongguild/config')).status, 404); // setup belongs to a different server than the session
  const text = await (await call('GET', '/api/sessions/sess1234/config')).text();
  assert.ok(!text.includes(VC2) && !text.includes('Eng'), 'never another channel\'s settings');
});

// ---------- the recorder side ----------

const goodTeam = { voiceChannelId: VC, name: 'Design', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'Foo', language: 'en' };
const ENV = { DISCORD_TOKEN: 't', CHANNEL_ID: VC };

test('parseSessionConfig: settings from the Worker win; TEAM_CONFIG is only the fallback', () => {
  const fromWorker = parseSessionConfig({ ...ENV, TEAM_CONFIG: 'not even json' }, goodTeam);
  assert.deepEqual(fromWorker.team, { name: 'Design', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'Foo', language: 'en' });
  const teamConfig = JSON.stringify({ [VC]: { name: 'FromSecret', transcriptChannelId: BAK } });
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }, goodTeam).team.name, 'Design');
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }, null).team.name, 'FromSecret');
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }).team.name, 'FromSecret'); // old call style still works
});

test('parseSessionConfig: Worker settings are checked too, and the error tells you how to fix a missing setup', () => {
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, voiceChannelId: VC2 }), /different voice channel/);
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, transcriptChannelId: 'nope' }), /transcriptChannelId/);
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, backupChannelId: TXT }), /different channel/);
  assert.throws(() => parseSessionConfig(ENV, null), /\/setup-recording.*TEAM_CONFIG has no entry/);
});

test('fetchRemoteTeam: found, not started by the Worker, 404, bad secret', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return new Response(JSON.stringify({ voice_channel_id: VC, name: 'Design', transcript_channel_id: TXT, backup_channel_id: null, glossary: 'Foo', language: 'en' }), { status: 200 });
  };
  const env = { SESSION_ID: 'sess1234', WORKER_URL: 'https://w.example/', WORKER_SHARED_SECRET: SECRET };
  assert.deepEqual(await fetchRemoteTeam(env, { fetchImpl }), { found: true, team: goodTeam });
  assert.equal(seen.url, 'https://w.example/api/sessions/sess1234/config');
  assert.equal(seen.auth, `Bearer ${SECRET}`);

  const never = async () => { throw new Error('must not be called'); };
  for (const bad of [{}, { ...env, SESSION_ID: '' }, { ...env, WORKER_URL: 'http://insecure.example' }, { ...env, WORKER_SHARED_SECRET: '' }, { ...env, SESSION_ID: 'bad id!' }]) {
    const r = await fetchRemoteTeam(bad, { fetchImpl: never });
    assert.equal(r.found, false);
    assert.match(r.reason, /not started by the Worker/);
  }
  assert.match((await fetchRemoteTeam(env, { fetchImpl: async () => new Response('{}', { status: 404 }) })).reason, /no setup for this voice channel/);
  assert.match((await fetchRemoteTeam(env, { fetchImpl: async () => new Response('{}', { status: 401 }) })).reason, /rejected WORKER_SHARED_SECRET/);
});

test('fetchRemoteTeam: retries a flaky Worker, gives up politely, never throws, and a 404 is not retried', async () => {
  const env = { SESSION_ID: 'sess1234', WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: SECRET };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw new Error('network down');
    if (n === 2) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ voice_channel_id: VC, name: 'D', transcript_channel_id: TXT }), { status: 200 });
  };
  assert.equal((await fetchRemoteTeam(env, { fetchImpl: flaky, sleep })).found, true);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [1500, 3000]);

  const down = await fetchRemoteTeam(env, { fetchImpl: async () => { throw new Error('x'); }, sleep });
  assert.deepEqual(down, { found: false, reason: 'the Worker could not be reached' });
  assert.match((await fetchRemoteTeam(env, { fetchImpl: async () => new Response('', { status: 500 }), sleep })).reason, /HTTP 500/);
  assert.equal((await fetchRemoteTeam(env, { fetchImpl: async () => new Response('not json', { status: 200 }), sleep })).found, false);
  let calls = 0;
  await fetchRemoteTeam(env, { fetchImpl: async () => { calls++; return new Response('', { status: 404 }); }, sleep });
  assert.equal(calls, 1);
});

test('contract: the recorder\'s fetchRemoteTeam and the Worker agree, end to end from /setup-recording', async () => {
  const t = setup();
  await t.run(slash('setup-recording', { ...SETUP, name: 'Design team', glossary: 'LiteCut' }));
  addSession(t.db, 'sess1234');
  const call = api(t.db);
  const fetchImpl = (url, init) => call('GET', new URL(url).pathname, init.headers.Authorization.replace('Bearer ', ''));
  const env = { DISCORD_TOKEN: 't', CHANNEL_ID: VC, SESSION_ID: 'sess1234', WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: SECRET };
  const remote = await fetchRemoteTeam(env, { fetchImpl });
  assert.equal(remote.found, true);
  const cfg = parseSessionConfig(env, remote.team); // no TEAM_CONFIG at all
  assert.deepEqual(cfg.team, { name: 'Design team', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'LiteCut', language: 'en' });
  assert.equal(cfg.sessionId, 'sess1234');
});

// ---------- Discord client ----------

test('getChannel: parses a channel, reports 403/404 and network errors, sends the bot header', async () => {
  const make = (res) => createDiscordClient({ token: 'tkn', apiBase: 'https://d.example/api', fetchImpl: async (url, init) => { make.seen = { url, init }; return res(); } });
  const ok = make(() => new Response(JSON.stringify({ id: VC, type: 2, guild_id: GUILD, name: 'Design Sync' }), { status: 200 }));
  assert.deepEqual(await ok.getChannel(VC), { ok: true, channel: { id: VC, type: 2, guildId: GUILD, name: 'Design Sync' } });
  assert.equal(make.seen.url, `https://d.example/api/channels/${VC}`);
  assert.equal(make.seen.init.headers.Authorization, 'Bot tkn');
  assert.deepEqual(await make(() => new Response('', { status: 404 })).getChannel(VC), { ok: false, status: 404, error: 'HTTP 404' });
  assert.equal((await make(() => new Response('', { status: 403 })).getChannel(VC)).status, 403);
  assert.equal((await make(() => { throw new Error('offline'); }).getChannel(VC)).ok, false);
  assert.equal((await make(() => new Response('junk', { status: 200 })).getChannel(VC)).ok, false);
  assert.equal((await make(() => new Response(JSON.stringify({ id: VC, type: 1 }), { status: 200 })).getChannel(VC)).channel.guildId, null); // a DM channel has no server
});
