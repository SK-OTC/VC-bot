// The server-wide save/post switches (now on /recording setup name:Default), where a recording's results go once the old
// /transcript-settings destination and the per-voice-channel transcript channel are gone, and the migrations that moved them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleInteraction } from '../src/commands.js';
import { handleApi } from '../src/api.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';
import { DEFAULT_TRANSCRIPT_SETTINGS, getTranscriptSettings, resolveRouting, resolveTranscriptTarget, saveTranscriptSettings } from '../src/recording-store.js';
import { saveNamedSetup } from '../src/named-setups.js';
import { describeSettings } from '../src/named-setup-commands.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const GUILD = '222222222222222222';
const VC = '111111111111111111';
const START = '999999999999999999'; // where /start-recording is typed
const DEST = '444444444444444444'; // a private text channel (the Default setup's private channel)
const OLD_TXT = '333333333333333333'; // an old per-voice-channel transcript channel, no longer used
const VOICE_OTHER = '555555555555555555';
const ADMIN = '700000000000000001';
const MEMBER = '700000000000000002';
const SECRET = 'a-long-shared-secret-for-tests';
const MANAGE = '32';

const channels = { [DEST]: { type: 0, guildId: GUILD, name: 'meeting-notes', private: true }, [VOICE_OTHER]: { type: 2, guildId: GUILD, name: 'Voice' }, [VC]: { type: 2, guildId: GUILD, name: 'Design' } };

function setup({ oldTranscript = null, recorder = { calls: [], async dispatch(i) { this.calls.push(i); return { ok: true }; } } } = {}) {
  const db = createTestDb();
  db.sql(
    `INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, created_by, created_at, updated_at) VALUES ('${VC}', '${GUILD}', 'Design', ${oldTranscript ? `'${oldTranscript}'` : 'NULL'}, 'admin', ${NOW}, ${NOW})`,
  );
  const discord = createFakeDiscord([], { channels, voice: { [ADMIN]: VC } });
  const run = (interaction) => handleInteraction(interaction, { db, discord, recorder, nowSec: NOW });
  return { db, discord, recorder, run };
}

const optionsOf = (opts) => Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 }));
const slash = (name, opts = {}, { user = ADMIN, perms = MANAGE } = {}) => ({
  type: 2,
  guild_id: GUILD,
  channel_id: START,
  application_id: 'app1',
  token: 'tok',
  member: { user: { id: user }, permissions: perms },
  data: { name, options: optionsOf(opts) },
});
const setupCmd = (opts = {}, who = {}) => {
  const i = slash('recording', {}, who);
  i.data.options = [{ name: 'setup', type: 1, options: optionsOf(opts) }];
  return i;
};
const defaults = (opts = {}, who) => setupCmd({ name: 'Default', ...opts }, who);
const settingsRows = (db) => db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n;
const namedRows = (db) => db.sql('SELECT * FROM named_recording_setups ORDER BY name_key');
const setDefaultPrivate = (db, id) => saveNamedSetup(db, { guildId: GUILD, name: 'Default', privateChannelId: id, createdBy: ADMIN }, NOW);

const config = async (db, id) =>
  (await handleApi(new Request(`https://w.example/api/sessions/${id}/config`, { headers: { Authorization: `Bearer ${SECRET}` } }), { DB: db, WORKER_SHARED_SECRET: SECRET }, new URL(`https://w.example/api/sessions/${id}/config`), NOW)).json();

// ---------- resolving where results go ----------

test('resolveTranscriptTarget: save and post in the channel where recording was started; nowhere when there is none', () => {
  assert.deepEqual(resolveTranscriptTarget({ settings: DEFAULT_TRANSCRIPT_SETTINGS, session: { start_channel_id: START } }), { save: true, post: true, channelId: START });
  assert.equal(resolveTranscriptTarget({ settings: DEFAULT_TRANSCRIPT_SETTINGS, session: {} }).channelId, null, 'nowhere to post');
  assert.equal(resolveTranscriptTarget({ settings: DEFAULT_TRANSCRIPT_SETTINGS, session: null }).channelId, null);
});

test('routing ignores a leftover destination and an old per-voice-channel transcript channel', () => {
  const settings = { save: true, post: true, destination: DEST }; // a stale field, as an older caller might still pass
  const setup = { transcript_channel_id: OLD_TXT, backup_channel_id: null };
  assert.equal(resolveTranscriptTarget({ settings, setup, session: { start_channel_id: START } }).channelId, START);
  assert.equal(resolveRouting({ settings, setup, session: { start_channel_id: START } }).privateChannelId, START);
  // the recording setup's private channel (fixed on the session when it started) is what wins
  assert.equal(resolveRouting({ settings, setup, session: { start_channel_id: START, private_channel_id: DEST } }).privateChannelId, DEST);
});

test('resolveTranscriptTarget: with posting off nothing is posted, whatever channels are known; save is carried through', () => {
  const r = resolveTranscriptTarget({ settings: { save: true, post: false }, session: { start_channel_id: START } });
  assert.deepEqual(r, { save: true, post: false, channelId: null });
  assert.equal(resolveTranscriptTarget({ settings: { save: false, post: true }, session: { start_channel_id: START } }).save, false);
  assert.equal(resolveRouting({ settings: { save: true, post: false }, setup: null, session: { start_channel_id: START, private_channel_id: DEST } }).privateChannelId, null);
});

// ---------- save / post on /recording setup name:Default ----------

test('/recording setup name:Default with no options shows the save/post switches and changes nothing', async () => {
  const t = setup();
  const r = await t.run(defaults());
  assert.equal(r.data.flags & 64, 64, 'private');
  assert.match(r.data.content, /Save \(whole server\): \*\*on\*\*/);
  assert.match(r.data.content, /Post \(whole server\): \*\*on\*\*/);
  assert.match(r.data.content, /Transcript file: the channel where the recording is started/);
  assert.equal(settingsRows(t.db), 0);
  assert.equal(namedRows(t.db).length, 0);
});

test('save/post are for people with Manage Server only', async () => {
  const t = setup();
  const r = await t.run(defaults({ post: false }, { user: MEMBER, perms: '0' }));
  assert.match(r.data.content, /Manage Server/);
  assert.equal(settingsRows(t.db), 0);
});

test('save/post on a setup other than Default are refused, and nothing is saved', async () => {
  const t = setup();
  await saveNamedSetup(t.db, { guildId: GUILD, name: 'Sales', createdBy: ADMIN }, NOW);
  for (const opts of [{ post: false }, { save: false }, { save: true, private_channel: DEST }]) {
    const r = await t.run(setupCmd({ name: 'Sales', ...opts }));
    assert.match(r.data.content, /apply to the whole server, so they are set on the Default setup/, JSON.stringify(opts));
  }
  assert.match((await t.run(setupCmd({ name: 'Brand new', post: false }))).data.content, /whole server/);
  assert.equal(settingsRows(t.db), 0);
  assert.deepEqual(namedRows(t.db).map((s) => [s.name, s.private_channel_id]), [['Sales', null]], 'no setup was created or changed');
  assert.equal(t.discord.posts.length, 0);
});

test('saving and posting cannot both be off (the recordings would be thrown away)', async () => {
  const t = setup();
  const r = await t.run(defaults({ save: false, post: false }));
  assert.match(r.data.content, /cannot both be off/);
  assert.equal(settingsRows(t.db), 0);
  // turning one off when the other is already off is refused too
  await t.run(defaults({ save: false }));
  assert.match((await t.run(defaults({ post: false }))).data.content, /cannot both be off/);
  assert.deepEqual(await getTranscriptSettings(t.db, GUILD), { save: false, post: true, custom: true });
  // ...also when it comes with a channel change: nothing is posted or saved
  assert.match((await t.run(defaults({ post: false, private_channel: DEST }))).data.content, /cannot both be off/);
  assert.equal(t.discord.posts.length, 0);
  assert.equal(namedRows(t.db).length, 0);
});

test('post off with save on is allowed, says who gets the link, and does not create a saved Default setup', async () => {
  const t = setup();
  const r = await t.run(defaults({ post: false }));
  assert.match(r.data.content, /Saved\./);
  assert.match(r.data.content, /private message to the person who started the recording/);
  assert.match(r.data.content, /scheduled meeting has no such person/);
  assert.deepEqual(await getTranscriptSettings(t.db, GUILD), { save: true, post: false, custom: true });
  assert.equal(namedRows(t.db).length, 0, 'the Default stays built in');
  assert.match((await t.run(defaults())).data.content, /built in: nothing saved yet/);
  // the switch is written with no destination
  assert.equal(t.db.sql('SELECT destination_channel_id FROM transcript_settings')[0].destination_channel_id, null);
});

test('save/post together with a channel on Default: the channel is checked first, then both are saved', async () => {
  const t = setup();
  const r = await t.run(defaults({ private_channel: DEST, save: false }));
  assert.match(r.data.content, /Saved the recording setup/);
  assert.match(r.data.content, /Save \(whole server\): \*\*off\*\*/);
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [DEST]);
  assert.equal(namedRows(t.db)[0].private_channel_id, DEST);
  assert.deepEqual(await getTranscriptSettings(t.db, GUILD), { save: false, post: true, custom: true });

  const refused = setup();
  refused.discord.postMessage = async () => ({ ok: false, error: 'HTTP 403' });
  assert.match((await refused.run(defaults({ private_channel: DEST, post: false }))).data.content, /Nothing was saved/);
  assert.equal(settingsRows(refused.db), 0, 'a failed channel check saves neither the setup nor the switches');
  assert.equal(namedRows(refused.db).length, 0);
});

test('a named setup shows a note when posting is off for the whole server', async () => {
  const t = setup();
  await saveNamedSetup(t.db, { guildId: GUILD, name: 'Sales', createdBy: ADMIN }, NOW);
  await saveTranscriptSettings(t.db, GUILD, { save: true, post: false }, ADMIN, NOW);
  assert.match((await t.run(setupCmd({ name: 'Sales' }))).data.content, /posting is off for the whole server/);
});

test('describeSettings explains save off + post on (summary posted in full, no link)', () => {
  assert.match(describeSettings({ save: false, post: true }), /posted in full/);
  assert.doesNotMatch(describeSettings({ save: true, post: true }), /private message|posted in full/);
});

// ---------- the settings reach the recorder ----------

test('/start-recording remembers the channel it was typed in, and says where the results will go', async () => {
  const t = setup();
  const r = await t.run(slash('start-recording', {}, { perms: '0' }));
  assert.match(r.data.content, new RegExp(`go to <#${START}> a few minutes after it leaves`));
  const [s] = t.db.sql('SELECT * FROM recording_sessions');
  assert.equal(s.start_channel_id, START);
  assert.equal(s.started_by, ADMIN);

  const withDefault = setup();
  await setDefaultPrivate(withDefault.db, DEST);
  assert.match((await withDefault.run(slash('start-recording'))).data.content, new RegExp(`go to <#${DEST}>`));

  const old = setup({ oldTranscript: OLD_TXT });
  await saveTranscriptSettings(old.db, GUILD, { save: true, post: true }, ADMIN, NOW);
  old.db.sql(`UPDATE transcript_settings SET destination_channel_id = '${DEST}'`); // a leftover value no longer read
  assert.match((await old.run(slash('start-recording'))).data.content, new RegExp(`go to <#${START}>`));

  const noPost = setup();
  await saveTranscriptSettings(noPost.db, GUILD, { save: true, post: false }, ADMIN, NOW);
  assert.match((await noPost.run(slash('start-recording'))).data.content, /Nothing is posted to a channel: the summary link is sent to you in a private message/);
});

test('config endpoint: no options -> the start channel, save and post on; the starter is the one to message', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const [s] = t.db.sql('SELECT id FROM recording_sessions');
  assert.deepEqual(await config(t.db, s.id), {
    voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: START, save: true, post: true, dm_user_id: ADMIN, backup_channel_id: null, glossary: '', language: 'en',
    summary_channel_id: null, link_channel_id: null, audio_channel_id: null, setup_name: 'Default', // /start-recording uses the Default setup
  });
});

test('config endpoint: the Default private channel, post off and save off each come through; old channels are ignored', async () => {
  const dest = setup({ oldTranscript: OLD_TXT });
  await setDefaultPrivate(dest.db, DEST);
  await dest.run(slash('start-recording'));
  assert.equal((await config(dest.db, dest.db.sql('SELECT id FROM recording_sessions')[0].id)).transcript_channel_id, DEST);

  const older = setup({ oldTranscript: OLD_TXT });
  older.db.sql(`INSERT INTO transcript_settings (guild_id, save, post, destination_channel_id, updated_by, updated_at) VALUES ('${GUILD}', 1, 1, '${DEST}', 'a', 1)`);
  await older.run(slash('start-recording'));
  assert.equal((await config(older.db, older.db.sql('SELECT id FROM recording_sessions')[0].id)).transcript_channel_id, START, 'neither old channel is read any more');

  const off = setup();
  await setDefaultPrivate(off.db, DEST);
  await saveTranscriptSettings(off.db, GUILD, { save: true, post: false }, ADMIN, NOW);
  await off.run(slash('start-recording'));
  const c = await config(off.db, off.db.sql('SELECT id FROM recording_sessions')[0].id);
  assert.deepEqual([c.transcript_channel_id, c.post, c.save, c.dm_user_id], [null, false, true, ADMIN]);

  const noSave = setup();
  await saveTranscriptSettings(noSave.db, GUILD, { save: false, post: true }, ADMIN, NOW);
  await noSave.run(slash('start-recording'));
  const n = await config(noSave.db, noSave.db.sql('SELECT id FROM recording_sessions')[0].id);
  assert.deepEqual([n.transcript_channel_id, n.post, n.save], [START, true, false]);
});

test('config endpoint: a scheduled session has nobody to message', async () => {
  const t = setup();
  t.db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('sched1234', '${VC}', '${GUILD}', 'scheduled', 'starting', ${NOW}, ${NOW})`);
  const c = await config(t.db, 'sched1234');
  assert.equal(c.dm_user_id, null);
  assert.equal(c.transcript_channel_id, null, 'no start channel and no private channel: the recorder reports it clearly instead of guessing');
});

// ---------- the migrations ----------

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrationFiles = readdirSync(migrationsDir).sort();
const migrateBefore = (db, prefix) => {
  for (const f of migrationFiles.filter((x) => x < prefix)) db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
};
const migrate = (db, prefix) => db.exec(readFileSync(path.join(migrationsDir, migrationFiles.find((x) => x.startsWith(prefix))), 'utf8'));

test('migration 0012 keeps every existing /setup-recording row and makes the transcript channel optional', () => {
  const db = new DatabaseSync(':memory:');
  migrateBefore(db, '0012');
  db.exec(`INSERT INTO recording_setups VALUES ('${VC}', '${GUILD}', 'Design', '${OLD_TXT}', '${DEST}', 'LiteCut', 'fr', 'admin', 5, 6)`);
  migrate(db, '0012');
  const row = db.prepare('SELECT * FROM recording_setups').get();
  assert.deepEqual({ ...row }, { voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: OLD_TXT, backup_channel_id: DEST, glossary: 'LiteCut', language: 'fr', created_by: 'admin', created_at: 5, updated_at: 6 });
  db.exec(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('${VOICE_OTHER}', '${GUILD}', 'No transcript channel', 'a', 1, 1)`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recording_setups').get().n, 2);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'recording_setups_by_guild'").get(), 'the guild index is back');
});

test('migration 0017 moves the destination into the Default setup, keeps live recordings on course, and never widens audio', () => {
  const db = new DatabaseSync(':memory:');
  migrateBefore(db, '0017');
  const G1 = '210000000000000001'; // destination, no Default row
  const G2 = '210000000000000002'; // destination, a Default that already names a private channel
  const G3 = '210000000000000003'; // destination, a Default without a private channel
  const G4 = '210000000000000004'; // no transcript settings at all, an old per-voice-channel transcript channel
  const [D1, D2, D3, P2, S3, T4, OWN] = ['3100000000000000a1', '3100000000000000a2', '3100000000000000a3', '3100000000000000b2', '3100000000000000c3', '3100000000000000d4', '3100000000000000e1'];
  const ts = (g, d, save = 1, post = 1) => db.exec(`INSERT INTO transcript_settings (guild_id, save, post, destination_channel_id, updated_by, updated_at) VALUES ('${g}', ${save}, ${post}, '${d}', 'admin-${g.slice(-1)}', 77)`);
  ts(G1, D1, 1, 0);
  ts(G2, D2);
  ts(G3, D3);
  const named = (g, name, { priv = null, summary = null, audio = 0 } = {}) =>
    db.exec(`INSERT INTO named_recording_setups (guild_id, name, name_key, private_channel_id, summary_channel_id, link_channel_id, audio, created_by, created_at, updated_at)
             VALUES ('${g}', '${name}', '${name.toLowerCase()}', ${priv ? `'${priv}'` : 'NULL'}, ${summary ? `'${summary}'` : 'NULL'}, NULL, ${audio}, 'a', 5, 6)`);
  named(G1, 'Sales', { audio: 1 }); // audio on, no private channel of its own, and G1's Default had none: audio must stay unposted
  named(G1, 'Own', { priv: OWN, audio: 1 }); // its own private channel: untouched
  named(G2, 'Default', { priv: P2 });
  named(G2, 'Ops', { audio: 1 }); // already posted audio in the Default's private channel before: untouched
  named(G3, 'Default', { summary: S3 });
  const vc = (id, g, transcript = null) =>
    db.exec(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, created_by, created_at, updated_at) VALUES ('${id}', '${g}', 'Room', ${transcript ? `'${transcript}'` : 'NULL'}, 'a', 1, 1)`);
  vc('400000000000000001', G1, T4);
  vc('400000000000000002', G4, T4);
  vc('400000000000000003', G4);
  vc('400000000000000004', G1);
  const session = (id, voice, g, status, priv = null) =>
    db.exec(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at, private_channel_id) VALUES ('${id}', '${voice}', '${g}', 'u', '${status}', 1, 1, ${priv ? `'${priv}'` : 'NULL'})`);
  session('live1', '400000000000000001', G1, 'running'); // destination beats the old voice channel transcript channel, as before
  session('live4', '400000000000000002', G4, 'starting'); // no destination: the old voice channel transcript channel
  session('live4b', '400000000000000003', G4, 'running'); // nothing to keep: stays null (the start channel)
  session('kept', '400000000000000004', G1, 'running', OWN); // already routed: untouched
  session('ended', '400000000000000001', G1, 'done'); // ended: untouched

  migrate(db, '0017');
  const rows = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  const setups = Object.fromEntries(rows('SELECT * FROM named_recording_setups').map((r) => [`${r.guild_id.slice(-1)}:${r.name}`, r]));

  const def1 = setups['1:Default'];
  assert.ok(def1, 'G1 gets a saved Default');
  assert.deepEqual([def1.name_key, def1.private_channel_id, def1.summary_channel_id, def1.link_channel_id, def1.audio, def1.created_by, def1.created_at], ['default', D1, null, null, 0, 'admin-1', 77]);
  assert.equal(setups['2:Default'].private_channel_id, P2, 'a Default that already named a channel keeps it (it already won)');
  assert.deepEqual([setups['3:Default'].private_channel_id, setups['3:Default'].summary_channel_id], [D3, S3]);
  assert.equal(rows(`SELECT * FROM named_recording_setups WHERE guild_id = '${G4}'`).length, 0, 'nothing is made for a server without a destination');

  assert.equal(setups['1:Sales'].audio, 0, 'audio is not switched on into a channel nobody named as private');
  assert.equal(setups['1:Own'].audio, 1);
  assert.equal(setups['2:Ops'].audio, 1);

  const ts2 = rows('SELECT guild_id, save, post, destination_channel_id FROM transcript_settings ORDER BY guild_id');
  assert.deepEqual(ts2.map((r) => [r.save, r.post, r.destination_channel_id]), [[1, 0, null], [1, 1, null], [1, 1, null]], 'save/post kept, destination cleared');

  const s = Object.fromEntries(rows('SELECT id, private_channel_id FROM recording_sessions').map((r) => [r.id, r.private_channel_id]));
  assert.deepEqual(s, { live1: D1, live4: T4, live4b: null, kept: OWN, ended: null });
});
