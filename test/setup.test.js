import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { handleInteraction } from '../src/commands.js';
import { COMMANDS } from '../src/definitions.js';
import { createDiscordClient } from '../src/discord.js';
import { saveRecordingSetup, getRecordingSetup, MAX_SETUPS_PER_GUILD } from '../src/recording-store.js';
import { saveNamedSetup } from '../src/named-setups.js';
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

const optionsOf = (opts) => Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 }));
const slash = (name, opts = {}, { user = ADMIN, perms = MANAGE, guild = GUILD } = {}) => ({
  type: 2,
  guild_id: guild,
  channel_id: '999999999999999999',
  application_id: 'app1',
  token: 'tok',
  member: { user: { id: user }, permissions: perms },
  data: { name, options: optionsOf(opts) },
});
/** /recording <sub> with options. */
const rec = (sub, opts = {}, who = {}) => {
  const i = slash('recording', {}, who);
  i.data.options = [{ name: sub, type: 1, options: optionsOf(opts) }];
  return i;
};
const allow = (opts, who) => rec('voice-channel', opts, who);
const isPrivate = (r) => (r.data.flags & 64) === 64;
const rows = (db) => db.sql('SELECT * FROM recording_setups ORDER BY voice_channel_id');
const SETUP = { voice_channel: VC };

// ---------- /recording voice-channel ----------

test('voice-channel: saves the settings, checks the channels, proves the backup channel with a real message', async () => {
  const t = setup();
  const r = await t.run(allow({ ...SETUP, backup_channel: BAK, name: 'Design team', language: 'ES', glossary: 'LiteCut,  CapCut\n' }));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, /Allowed recording in/);
  assert.match(r.data.content, new RegExp(`backup <#${BAK}>`));
  assert.match(r.data.content, /\/recording setup name:Default/, 'says where transcripts are decided now');
  const [s] = rows(t.db);
  assert.deepEqual(
    { v: s.voice_channel_id, g: s.guild_id, n: s.name, t: s.transcript_channel_id, b: s.backup_channel_id, gl: s.glossary, l: s.language, by: s.created_by },
    { v: VC, g: GUILD, n: 'Design team', t: null, b: BAK, gl: 'LiteCut, CapCut', l: 'es', by: ADMIN },
  );
  // only the backup channel gets a message (there is no per-voice-channel transcript channel any more), with no mentions allowed
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [BAK]);
  assert.ok(t.discord.posts.every((p) => JSON.stringify(p.allowedMentions) === '{"parse":[]}'));
  assert.match(t.discord.posts[0].content, new RegExp(`<#${VC}>`));
});

test('voice-channel: defaults are the voice channel name, English, no backup, no glossary; nothing is posted', async () => {
  const t = setup();
  await t.run(allow(SETUP));
  const [s] = rows(t.db);
  assert.deepEqual({ n: s.name, b: s.backup_channel_id, gl: s.glossary, l: s.language }, { n: 'Design Sync', b: null, gl: '', l: 'en' });
  assert.equal(t.discord.posts.length, 0);
});

test('/recording: only people with Manage Server (or Administrator) can use any of its subcommands', async () => {
  const t = setup();
  for (const [sub, opts] of [['voice-channel', SETUP], ['setup', { name: 'Default', post: false }], ['list', {}], ['delete', { voice_channel: VC }]]) {
    const denied = await t.run(rec(sub, opts, { user: MEMBER, perms: '0' }));
    assert.ok(isPrivate(denied));
    assert.match(denied.data.content, /Manage Server/, sub);
    const other = await t.run(rec(sub, opts, { user: MEMBER, perms: String(0x400) })); // View Channel only
    assert.match(other.data.content, /Manage Server/, sub);
  }
  assert.equal(rows(t.db).length, 0);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);
  assert.equal(t.discord.posts.length, 0);
  assert.doesNotMatch((await t.run(allow(SETUP, { perms: String(0x8) }))).data.content, /Manage Server/); // Administrator
});

test('voice-channel: running it again changes only what is given and keeps the original creator and date', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, backup_channel: BAK, glossary: 'one', language: 'fr' }, { user: ADMIN }));
  const first = rows(t.db)[0];
  const later = (i) => handleInteraction(i, { db: t.db, discord: t.discord, nowSec: NOW + 500 });
  const r = await later(allow({ voice_channel: VC, name: 'Renamed' }, { user: MEMBER, perms: MANAGE }));
  assert.equal(r.type, 4, 'no new channel to check, so it answers at once');
  assert.match(r.data.content, /Updated recording in/);
  const [s] = rows(t.db);
  assert.equal(rows(t.db).length, 1);
  assert.deepEqual({ n: s.name, b: s.backup_channel_id, gl: s.glossary, l: s.language }, { n: 'Renamed', b: BAK, gl: 'one', l: 'fr' }); // the rest is kept
  assert.equal(s.created_by, ADMIN);
  assert.equal(s.created_at, first.created_at);
  assert.equal(s.updated_at, NOW + 500);
  // changing the language keeps the glossary and the backup channel, and the name
  await later(allow({ voice_channel: VC, language: 'de' }));
  assert.deepEqual((({ name, backup_channel_id, glossary, language }) => ({ name, backup_channel_id, glossary, language }))(rows(t.db)[0]), { name: 'Renamed', backup_channel_id: BAK, glossary: 'one', language: 'de' });
  assert.equal(t.discord.posts.length, 1, 'the unchanged backup channel is not posted in again');
});

test('voice-channel: just the voice channel shows an allowed channel and changes nothing', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, name: 'Design', glossary: 'Foo' }));
  const before = rows(t.db)[0];
  const later = (i) => handleInteraction(i, { db: t.db, discord: t.discord, nowSec: NOW + 900 });
  const r = await later(allow(SETUP));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, /\*\*Design\*\*/);
  assert.match(r.data.content, /glossary: Foo/);
  assert.match(r.data.content, /\/recording delete voice_channel:/);
  assert.deepEqual(rows(t.db)[0], before, 'nothing was rewritten');
});

test('voice-channel: clear removes the backup channel or the glossary; clear with a value is refused', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, backup_channel: BAK, glossary: 'Foo, Bar' }));
  assert.match((await t.run(allow({ ...SETUP, glossary: 'x', clear: 'glossary' }))).data.content, /either `glossary` or `clear:glossary`, not both/);
  assert.match((await t.run(allow({ ...SETUP, backup_channel: BAK, clear: 'backup_channel' }))).data.content, /not both/);
  assert.equal(rows(t.db)[0].glossary, 'Foo, Bar', 'a refused change saves nothing');
  await t.run(allow({ ...SETUP, clear: 'glossary' }));
  assert.deepEqual([rows(t.db)[0].glossary, rows(t.db)[0].backup_channel_id], ['', BAK]);
  const r = await t.run(allow({ ...SETUP, clear: 'backup_channel' }));
  assert.doesNotMatch(r.data.content, /backup </);
  assert.equal(rows(t.db)[0].backup_channel_id, null);
  assert.match((await t.run(allow({ ...SETUP, clear: 'name' }))).data.content, /`clear` must be backup_channel or glossary/);
});

test('voice-channel: input is validated and nothing is saved or posted on a mistake', async () => {
  const t = setup();
  const cases = [
    [{ ...SETUP, backup_channel: VC }, /not the voice channel itself/],
    [{ ...SETUP, language: 'english' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'e' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'e1' }, /2 or 3 letter code/],
    [{ ...SETUP, language: 'en-US' }, /2 or 3 letter code/],
    [{ ...SETUP, glossary: 'x'.repeat(501) }, /glossary.*too long/],
    [{ ...SETUP, name: 'n'.repeat(51) }, /name.*too long/],
    [{ ...SETUP, voice_channel: 'not-an-id' }, /not a valid voice channel/],
    [{ ...SETUP, backup_channel: '123' }, /backup channel is not valid/],
  ];
  for (const [opts, pattern] of cases) {
    const r = await t.run(allow(opts));
    assert.ok(isPrivate(r));
    assert.match(r.data.content, pattern, JSON.stringify(opts).slice(0, 80));
  }
  assert.equal(rows(t.db).length, 0);
  assert.equal(t.discord.posts.length, 0);
});

test('voice-channel: the glossary has control characters removed and spaces collapsed', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, glossary: 'a\u0000b\u0007,\t\n c   d' }));
  assert.equal(rows(t.db)[0].glossary, 'a b , c d'); // control characters become spaces, runs of spaces collapse
});

test('voice-channel: channels the bot cannot see, from another server or of the wrong kind are refused with the reason', async () => {
  const wrongKind = setup({ channels: { ...goodChannels(), [BAK]: { type: 2, guildId: GUILD, name: 'actually voice' } } });
  const r = await wrongKind.run(allow({ ...SETUP, backup_channel: BAK }));
  assert.match(r.data.content, /Nothing was saved/);
  assert.match(r.data.content, new RegExp(`<#${BAK}> must be a text channel`));

  const elsewhere = setup({ channels: { ...goodChannels(), [BAK]: { type: 0, guildId: OTHER_GUILD, name: 'elsewhere' } } });
  assert.match((await elsewhere.run(allow({ ...SETUP, backup_channel: BAK }))).data.content, new RegExp(`<#${BAK}> is not in this server`));

  const blind = setup({ channels: { [VC]: goodChannels()[VC] } }); // the bot can see only the voice channel
  const r2 = await blind.run(allow({ ...SETUP, backup_channel: BAK }));
  assert.match(r2.data.content, new RegExp(`I can't see <#${BAK}>`));
  assert.match(r2.data.content, /View Channel/);

  const textAsVoice = setup();
  assert.match((await textAsVoice.run(allow({ voice_channel: TXT }))).data.content, /must be a voice channel/);
  const unseenVoice = setup({ channels: {} });
  assert.match((await unseenVoice.run(allow(SETUP))).data.content, new RegExp(`I can't see <#${VC}>`));
  for (const x of [wrongKind, elsewhere, blind, textAsVoice, unseenVoice]) {
    assert.equal(rows(x.db).length, 0);
    assert.equal(x.discord.posts.length, 0);
  }
});

test('voice-channel: a Discord lookup that fails for another reason says so and saves nothing', async () => {
  const t = setup();
  t.discord.getChannel = async () => ({ ok: false, status: 500, error: 'HTTP 500' });
  const r = await t.run(allow(SETUP));
  assert.match(r.data.content, /couldn't check/);
  assert.equal(rows(t.db).length, 0);
});

test('voice-channel: a backup channel the bot cannot post in is named with the permissions it needs, and nothing is saved', async () => {
  const t = setup({ script: [{ ok: false, status: 403, error: 'HTTP 403: Missing Permissions (code 50013)' }] });
  const r = await t.run(allow({ ...SETUP, backup_channel: BAK }));
  assert.match(r.data.content, /Nothing was saved/);
  assert.match(r.data.content, new RegExp(`<#${BAK}>: I need View Channel, Send Messages and Attach Files`));
  assert.match(r.data.content, /Missing Permissions/);
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [BAK]);
  assert.equal(rows(t.db).length, 0);
});

test('voice-channel: the limit is 25 per server, but changing an existing one is always allowed', async () => {
  const t = setup();
  for (let i = 0; i < MAX_SETUPS_PER_GUILD; i++) {
    t.db.sql(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('9${String(i).padStart(17, '0')}', '${GUILD}', 'n${i}', 'x', 1, 1)`);
  }
  const over = await t.run(allow(SETUP));
  assert.match(over.data.content, /already allows 25 voice channels/);
  t.db.sql(`UPDATE recording_setups SET voice_channel_id = '${VC}' WHERE name = 'n0'`);
  assert.match((await t.run(allow({ ...SETUP, name: 'changed' }))).data.content, /Updated/);
});

test('voice-channel: with a deferred reply it answers at once and edits the message with the result', async () => {
  const t = setup({ withDefer: true });
  const r = await t.run(allow(SETUP));
  assert.equal(r.type, 5);
  assert.equal(r.data.flags, 64);
  await Promise.all(t.deferred);
  assert.equal(t.discord.edits.length, 1);
  assert.match(t.discord.edits[0].content, /Allowed recording in/);
});

test('a voice channel id is never taken over by another server', async () => {
  const db = createTestDb();
  assert.deepEqual(await saveRecordingSetup(db, { voiceChannelId: VC, guildId: GUILD, name: 'A', createdBy: ADMIN }, NOW), { ok: true, updated: false });
  assert.deepEqual(await saveRecordingSetup(db, { voiceChannelId: VC, guildId: OTHER_GUILD, name: 'Hijack', createdBy: MEMBER }, NOW), { ok: false });
  assert.equal((await getRecordingSetup(db, VC)).name, 'A');
  assert.equal(await getRecordingSetup(db, VC, OTHER_GUILD), null);
});

test('saveRecordingSetup no longer writes the old transcript channel column, and leaves an existing value alone', async () => {
  const db = createTestDb();
  db.sql(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, created_by, created_at, updated_at) VALUES ('${VC}', '${GUILD}', 'Old', '${TXT}', 'a', 1, 1)`);
  await saveRecordingSetup(db, { voiceChannelId: VC, guildId: GUILD, name: 'New', createdBy: ADMIN }, NOW);
  assert.deepEqual([rows(db)[0].name, rows(db)[0].transcript_channel_id], ['New', TXT]);
});

// ---------- /recording list ----------

test('list: the setups, the whole-server save/post line and the voice channels, in one private reply', async () => {
  const t = setup();
  const empty = (await t.run(rec('list'))).data.content;
  assert.match(empty, /\*\*Recording setups\*\*/);
  assert.match(empty, /\*\*Default\*\* \(built in/);
  assert.match(empty, /\*\*Whole server\*\*.*save \*\*on\*\*, post \*\*on\*\*/);
  assert.match(empty, /\*\*Voice channels that may be recorded\*\*\nNone yet/);

  await t.run(allow({ ...SETUP, backup_channel: BAK, name: 'Design', glossary: 'g'.repeat(200) }));
  await t.run(allow({ voice_channel: VC2, name: 'Eng' }));
  await saveNamedSetup(t.db, { guildId: GUILD, name: 'Sales', privateChannelId: TXT, createdBy: ADMIN }, NOW);
  await t.run(rec('setup', { name: 'Default', post: false }));
  const all = await t.run(rec('list'));
  assert.ok(isPrivate(all));
  const text = all.data.content;
  assert.ok(text.indexOf('**Recording setups**') < text.indexOf('**Sales**'));
  assert.ok(text.indexOf('**Sales**') < text.indexOf('**Whole server**'));
  assert.ok(text.indexOf('**Whole server**') < text.indexOf('**Voice channels that may be recorded**'));
  assert.match(text, /save \*\*on\*\*, post \*\*off\*\*/);
  assert.match(text, /\*\*Design\*\*.*backup/s);
  assert.match(text, /\*\*Eng\*\*/);
  assert.ok(text.includes('...'), 'a long glossary is shortened in the list');
  assert.doesNotMatch(text, /more\./, 'a short list is shown in full');
  assert.doesNotMatch((await t.run(rec('list', {}, { guild: OTHER_GUILD }))).data.content, /Design|Sales/); // another server sees nothing
});

test('list: the reply always fits Discord\'s 2000-character limit, even with 25 long setups and 25 long voice channels', async () => {
  const t = setup();
  for (let i = 0; i < MAX_SETUPS_PER_GUILD; i++) {
    t.db.sql(
      `INSERT INTO recording_setups (voice_channel_id, guild_id, name, backup_channel_id, glossary, language, created_by, created_at, updated_at)
       VALUES ('9${String(i).padStart(17, '0')}', '${GUILD}', '${'N'.repeat(50)}', '${BAK}', '${'g'.repeat(500)}', 'en', 'x', 1, 1)`,
    );
    await saveNamedSetup(t.db, { guildId: GUILD, name: `${'S'.repeat(45)} ${String(i).padStart(2, '0')}`, privateChannelId: TXT, summaryChannelId: BAK, linkChannelId: VC2, audio: true, createdBy: ADMIN }, NOW);
  }
  const text = (await t.run(rec('list'))).data.content;
  assert.ok(text.length <= 2000, `reply was ${text.length} characters`);
  assert.match(text, /…and \d+ more\. Use `\/recording setup name:<name>`/);
  assert.match(text, /…and \d+ more\. Use `\/recording voice-channel voice_channel:<channel>`/);
  assert.match(text, /\*\*Whole server\*\*/, 'the save/post line is never cut off');
});

// ---------- /recording delete ----------

test('delete: needs exactly one of name and voice_channel', async () => {
  const t = setup();
  await t.run(allow(SETUP));
  await saveNamedSetup(t.db, { guildId: GUILD, name: 'Sales', privateChannelId: TXT, createdBy: ADMIN }, NOW);
  for (const opts of [{}, { name: 'Sales', voice_channel: VC }, { name: '   ' }]) {
    assert.match((await t.run(rec('delete', opts))).data.content, /Give one of these: `name`.*or `voice_channel`/, JSON.stringify(opts));
  }
  assert.equal(rows(t.db).length, 1);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM named_recording_setups')[0].n, 1, 'nothing was deleted');
  assert.match((await t.run(rec('delete', { name: 'Sales' }))).data.content, /Deleted the recording setup \*\*Sales\*\*/);
  assert.equal(rows(t.db).length, 1, 'deleting a setup leaves the voice channels alone');
});

test('delete voice_channel: removes it, only in its own server, and then /start-recording refuses that channel', async () => {
  const t = setup();
  await t.run(allow(SETUP));
  assert.match((await t.run(rec('delete', { voice_channel: VC }, { guild: OTHER_GUILD }))).data.content, /not allowed to be recorded, so there is nothing to remove/);
  assert.equal(rows(t.db).length, 1);
  assert.match((await t.run(rec('delete', { voice_channel: VC }))).data.content, /can no longer be recorded until it is allowed again/);
  assert.equal(rows(t.db).length, 0);
  assert.match((await t.run(rec('delete', { voice_channel: VC }))).data.content, /nothing to remove/);
  const start = await t.run(slash('start-recording', {}, { user: ADMIN })); // ADMIN is "in" VC
  assert.match(start.data.content, /not set up for recording/);
  assert.match(start.data.content, /\/recording voice-channel/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM recording_sessions')[0].n, 0);
});

test('start-recording: only works for a channel that has been allowed in THIS server', async () => {
  const t = setup();
  assert.match((await t.run(slash('start-recording', {}))).data.content, /not set up for recording yet/);
  await t.run(allow(SETUP));
  assert.doesNotMatch((await t.run(slash('start-recording', {}))).data.content, /not set up/);
  // a setup that belongs to another server does not count
  t.db.sql(`UPDATE recording_setups SET guild_id = '${OTHER_GUILD}'`);
  t.db.sql('DELETE FROM recording_sessions');
  assert.match((await t.run(slash('start-recording', {}))).data.content, /not set up for recording yet/);
});

test('definitions: /recording is the only admin command, limited to Manage Server by default, with the right channel kinds', () => {
  const by = (n) => COMMANDS.find((c) => c.name === n);
  assert.equal(by('recording').default_member_permissions, '32');
  assert.deepEqual(by('recording').contexts, [0]);
  const vc = by('recording').options.find((o) => o.name === 'voice-channel');
  const opts = Object.fromEntries(vc.options.map((o) => [o.name, o]));
  assert.deepEqual(Object.keys(opts), ['voice_channel', 'name', 'backup_channel', 'language', 'glossary', 'clear']);
  assert.deepEqual([opts.voice_channel.required, !!opts.name.required, !!opts.backup_channel.required], [true, false, false]);
  assert.deepEqual(opts.voice_channel.channel_types, [2]);
  assert.deepEqual(opts.backup_channel.channel_types, [0, 5]);
  assert.equal(opts.glossary.max_length, 500);
  assert.ok(!COMMANDS.some((c) => c.name !== 'recording' && c.default_member_permissions), 'other commands stay open to everyone');
});

// ---------- the Worker endpoint the recorder calls ----------

function api(db) {
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET };
  return (method, path, secret = SECRET) =>
    worker.fetch(new Request(`https://w.example${path}`, { method, headers: secret === null ? {} : { Authorization: `Bearer ${secret}` } }), env, { waitUntil() {} });
}
// The session was started from TXT, so with no recording setup channels that is where its transcript goes.
const addSession = (db, id, channel = VC, guild = GUILD, status = 'starting') =>
  db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at, start_channel_id) VALUES ('${id}', '${channel}', '${guild}', 'u', '${status}', ${NOW}, ${NOW}, '${TXT}')`);

test('config endpoint: needs the secret, returns only the session\'s own channel settings, 404 otherwise', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, backup_channel: BAK, name: 'Design', language: 'fr', glossary: 'Foo' }));
  await t.run(allow({ voice_channel: VC2, name: 'Eng' }));
  addSession(t.db, 'sess1234');
  addSession(t.db, 'nosetup1', '666666666666666666');
  addSession(t.db, 'wrongguild', VC, OTHER_GUILD, 'done'); // an ended session, so it does not clash with the live one
  const call = api(t.db);

  const ok = await call('GET', '/api/sessions/sess1234/config');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await ok.json(), {
    voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: TXT, save: true, post: true, dm_user_id: null, backup_channel_id: BAK, glossary: 'Foo', language: 'fr',
    summary_channel_id: null, link_channel_id: null, audio_channel_id: null, setup_name: null,
  });
  for (const secret of [null, 'wrong', '']) assert.equal((await call('GET', '/api/sessions/sess1234/config', secret)).status, 401);
  assert.equal((await call('POST', '/api/sessions/sess1234/config')).status, 405);
  assert.equal((await call('GET', '/api/sessions/unknownid/config')).status, 404);
  assert.equal((await call('GET', '/api/sessions/bad%20id/config')).status, 404);
  assert.equal((await call('GET', '/api/sessions/nosetup1/config')).status, 404); // session for a channel with no setup
  assert.equal((await call('GET', '/api/sessions/wrongguild/config')).status, 409); // an ended session is refused before anything else
  t.db.sql("UPDATE recording_sessions SET status = 'running', voice_channel_id = '121212121212121212' WHERE id = 'wrongguild'");
  t.db.sql("INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('121212121212121212', '" + GUILD + "', 'X', 'a', 1, 1)");
  assert.equal((await call('GET', '/api/sessions/wrongguild/config')).status, 404); // setup belongs to a different server than the session
  const text = await (await call('GET', '/api/sessions/sess1234/config')).text();
  assert.ok(!text.includes(VC2) && !text.includes('Eng'), 'never another channel\'s settings');
});

// ---------- the recorder side ----------

const goodTeam = { voiceChannelId: VC, name: 'Design', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'Foo', language: 'en', summaryChannelId: '', linkChannelId: '', audioChannelId: '', setupName: '' };
const ENV = { DISCORD_TOKEN: 't', CHANNEL_ID: VC };

test('parseSessionConfig: settings from the Worker win; TEAM_CONFIG is only the fallback', () => {
  const fromWorker = parseSessionConfig({ ...ENV, TEAM_CONFIG: 'not even json' }, goodTeam);
  assert.deepEqual(fromWorker.team, { name: 'Design', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'Foo', language: 'en', summaryChannelId: '', linkChannelId: '', audioChannelId: '', setupName: '' });
  const teamConfig = JSON.stringify({ [VC]: { name: 'FromSecret', transcriptChannelId: BAK } });
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }, goodTeam).team.name, 'Design');
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }, null).team.name, 'FromSecret');
  assert.equal(parseSessionConfig({ ...ENV, TEAM_CONFIG: teamConfig }).team.name, 'FromSecret'); // old call style still works
});

test('parseSessionConfig: Worker settings are checked too, and the error tells you how to fix a missing setup', () => {
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, voiceChannelId: VC2 }), /different voice channel/);
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, transcriptChannelId: 'nope' }), /transcriptChannelId/);
  assert.throws(() => parseSessionConfig(ENV, { ...goodTeam, backupChannelId: TXT }), /different channel/);
  assert.throws(() => parseSessionConfig(ENV, null), /\/recording voice-channel.*TEAM_CONFIG has no entry/);
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

test('contract: the recorder\'s fetchRemoteTeam and the Worker agree, end to end from /recording voice-channel', async () => {
  const t = setup();
  await t.run(allow({ ...SETUP, name: 'Design team', glossary: 'LiteCut' }));
  addSession(t.db, 'sess1234');
  const call = api(t.db);
  const fetchImpl = (url, init) => call('GET', new URL(url).pathname, init.headers.Authorization.replace('Bearer ', ''));
  const env = { DISCORD_TOKEN: 't', CHANNEL_ID: VC, SESSION_ID: 'sess1234', WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: SECRET };
  const remote = await fetchRemoteTeam(env, { fetchImpl });
  assert.equal(remote.found, true);
  const cfg = parseSessionConfig(env, remote.team); // no TEAM_CONFIG at all
  assert.deepEqual(cfg.team, { name: 'Design team', transcriptChannelId: TXT, save: true, post: true, dmUserId: '', backupChannelId: '', glossary: 'LiteCut', language: 'en', summaryChannelId: '', linkChannelId: '', audioChannelId: '', setupName: '' });
  assert.equal(cfg.sessionId, 'sess1234');
});

// ---------- Discord client ----------

test('getChannel: parses a channel, reports 403/404 and network errors, sends the bot header', async () => {
  const make = (res) => createDiscordClient({ token: 'tkn', apiBase: 'https://d.example/api', fetchImpl: async (url, init) => { make.seen = { url, init }; return res(); } });
  const ok = make(() => new Response(JSON.stringify({ id: VC, type: 2, guild_id: GUILD, name: 'Design Sync' }), { status: 200 }));
  assert.deepEqual(await ok.getChannel(VC), { ok: true, channel: { id: VC, type: 2, guildId: GUILD, name: 'Design Sync', hiddenFromEveryone: false } });
  assert.equal(make.seen.url, `https://d.example/api/channels/${VC}`);
  assert.equal(make.seen.init.headers.Authorization, 'Bot tkn');
  assert.deepEqual(await make(() => new Response('', { status: 404 })).getChannel(VC), { ok: false, status: 404, error: 'HTTP 404' });
  assert.equal((await make(() => new Response('', { status: 403 })).getChannel(VC)).status, 403);
  assert.equal((await make(() => { throw new Error('offline'); }).getChannel(VC)).ok, false);
  assert.equal((await make(() => new Response('junk', { status: 200 })).getChannel(VC)).ok, false);
  assert.equal((await make(() => new Response(JSON.stringify({ id: VC, type: 1 }), { status: 200 })).getChannel(VC)).channel.guildId, null); // a DM channel has no server
  // A channel whose own permissions deny View Channel to @everyone (the role with the server's id) counts as hidden from everyone.
  const hidden = make(() => new Response(JSON.stringify({ id: TXT, type: 0, guild_id: GUILD, name: 'p', permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(1 << 10) }] }), { status: 200 }));
  assert.equal((await hidden.getChannel(TXT)).channel.hiddenFromEveryone, true);
  const allowed = make(() => new Response(JSON.stringify({ id: TXT, type: 0, guild_id: GUILD, name: 'p', permission_overwrites: [{ id: GUILD, type: 0, allow: String(1 << 10), deny: '0' }, { id: ADMIN, type: 1, allow: '0', deny: String(1 << 10) }] }), { status: 200 }));
  assert.equal((await allowed.getChannel(TXT)).channel.hiddenFromEveryone, false, 'a member overwrite is not @everyone');
});
