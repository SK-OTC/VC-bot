import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleInteraction } from '../src/commands.js';
import { handleApi } from '../src/api.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';
import { DEFAULT_TRANSCRIPT_SETTINGS, getTranscriptSettings, resolveTranscriptTarget, saveTranscriptSettings } from '../src/recording-store.js';
import { describeSettings } from '../src/transcript-settings-commands.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const GUILD = '222222222222222222';
const VC = '111111111111111111';
const START = '999999999999999999'; // where /start-recording is typed
const DEST = '444444444444444444'; // a text channel chosen with /transcript-settings
const SETUP_TXT = '333333333333333333'; // an older /setup-recording transcript channel
const VOICE_OTHER = '555555555555555555';
const ADMIN = '700000000000000001';
const MEMBER = '700000000000000002';
const SECRET = 'a-long-shared-secret-for-tests';
const MANAGE = '32';

const channels = { [DEST]: { type: 0, guildId: GUILD, name: 'meeting-notes' }, [VOICE_OTHER]: { type: 2, guildId: GUILD, name: 'Voice' }, [VC]: { type: 2, guildId: GUILD, name: 'Design' } };

function setup({ setupTranscript = null, recorder = { calls: [], async dispatch(i) { this.calls.push(i); return { ok: true }; } } } = {}) {
  const db = createTestDb();
  db.sql(
    `INSERT INTO recording_setups (voice_channel_id, guild_id, name, transcript_channel_id, created_by, created_at, updated_at) VALUES ('${VC}', '${GUILD}', 'Design', ${setupTranscript ? `'${setupTranscript}'` : 'NULL'}, 'admin', ${NOW}, ${NOW})`,
  );
  const discord = createFakeDiscord([], { channels, voice: { [ADMIN]: VC } });
  const run = (interaction) => handleInteraction(interaction, { db, discord, recorder, nowSec: NOW });
  return { db, discord, recorder, run };
}

const slash = (name, opts = {}, { user = ADMIN, perms = MANAGE } = {}) => ({
  type: 2,
  guild_id: GUILD,
  channel_id: START,
  application_id: 'app1',
  token: 'tok',
  member: { user: { id: user }, permissions: perms },
  data: { name, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 })) },
});

const config = async (db, id) =>
  (await handleApi(new Request(`https://w.example/api/sessions/${id}/config`, { headers: { Authorization: `Bearer ${SECRET}` } }), { DB: db, WORKER_SHARED_SECRET: SECRET }, new URL(`https://w.example/api/sessions/${id}/config`), NOW)).json();

// ---------- resolving where results go ----------

test('resolveTranscriptTarget: no options set -> save and post in the channel where recording was started', () => {
  assert.deepEqual(resolveTranscriptTarget({ settings: DEFAULT_TRANSCRIPT_SETTINGS, setup: { transcript_channel_id: null }, session: { start_channel_id: START } }), { save: true, post: true, channelId: START });
});

test('resolveTranscriptTarget: a destination wins; then an older setup transcript channel; then the start channel', () => {
  const session = { start_channel_id: START };
  assert.equal(resolveTranscriptTarget({ settings: { save: true, post: true, destination: DEST }, setup: { transcript_channel_id: SETUP_TXT }, session }).channelId, DEST);
  assert.equal(resolveTranscriptTarget({ settings: { save: true, post: true, destination: null }, setup: { transcript_channel_id: SETUP_TXT }, session }).channelId, SETUP_TXT);
  assert.equal(resolveTranscriptTarget({ settings: { save: true, post: true, destination: null }, setup: { transcript_channel_id: null }, session }).channelId, START);
  assert.equal(resolveTranscriptTarget({ settings: { save: true, post: true, destination: null }, setup: null, session: {} }).channelId, null, 'nowhere to post');
});

test('resolveTranscriptTarget: with posting off nothing is posted, whatever channels are known; save is carried through', () => {
  const r = resolveTranscriptTarget({ settings: { save: true, post: false, destination: DEST }, setup: { transcript_channel_id: SETUP_TXT }, session: { start_channel_id: START } });
  assert.deepEqual(r, { save: true, post: false, channelId: null });
  assert.equal(resolveTranscriptTarget({ settings: { save: false, post: true, destination: null }, setup: null, session: { start_channel_id: START } }).save, false);
});

// ---------- the command ----------

test('/transcript-settings with no options shows the defaults and changes nothing', async () => {
  const t = setup();
  const r = await t.run(slash('transcript-settings'));
  assert.equal((r.data.flags & 64), 64, 'private');
  assert.match(r.data.content, /defaults/);
  assert.match(r.data.content, /Save: \*\*on\*\*/);
  assert.match(r.data.content, /Post: \*\*on\*\*/);
  assert.match(r.data.content, /where `\/start-recording` was used/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);
});

test('/transcript-settings is for people with Manage Server only', async () => {
  const t = setup();
  const r = await t.run(slash('transcript-settings', { post: false }, { user: MEMBER, perms: '0' }));
  assert.match(r.data.content, /Manage Server/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);
});

test('/transcript-settings: saving and posting cannot both be off (the recording would be thrown away)', async () => {
  const t = setup();
  const r = await t.run(slash('transcript-settings', { save: false, post: false }));
  assert.match(r.data.content, /cannot both be off/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);
  // turning one off when the other is already off is refused too
  await t.run(slash('transcript-settings', { save: false }));
  assert.match((await t.run(slash('transcript-settings', { post: false }))).data.content, /cannot both be off/);
  assert.deepEqual(await getTranscriptSettings(t.db, GUILD), { save: false, post: true, destination: null, custom: true });
});

test('/transcript-settings: post off with save on is allowed and says who gets the link', async () => {
  const t = setup();
  const r = await t.run(slash('transcript-settings', { post: false }));
  assert.match(r.data.content, /Saved\./);
  assert.match(r.data.content, /private message to the person who started the recording/);
  assert.match(r.data.content, /scheduled meeting has no such person/);
  assert.deepEqual(await getTranscriptSettings(t.db, GUILD), { save: true, post: false, destination: null, custom: true });
});

test('/transcript-settings: a destination is checked with a real message, and only then saved', async () => {
  const t = setup();
  const r = await t.run(slash('transcript-settings', { destination: DEST }));
  assert.match(r.data.content, /Saved\./);
  assert.deepEqual(t.discord.posts.map((p) => p.channelId), [DEST]);
  assert.equal((await getTranscriptSettings(t.db, GUILD)).destination, DEST);

  const bad = setup();
  const notText = await bad.run(slash('transcript-settings', { destination: VOICE_OTHER }));
  assert.match(notText.data.content, /Nothing was saved/);
  assert.match(notText.data.content, /must be a text channel/);
  const unseen = await bad.run(slash('transcript-settings', { destination: '888888888888888888' }));
  assert.match(unseen.data.content, /View Channel/);
  assert.equal(bad.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);

  const refused = setup();
  refused.discord.postMessage = async () => ({ ok: false, error: 'HTTP 403' });
  assert.match((await refused.run(slash('transcript-settings', { destination: DEST }))).data.content, /Nothing was saved/);
  assert.equal(refused.db.sql('SELECT COUNT(*) AS n FROM transcript_settings')[0].n, 0);
});

test('/transcript-settings: clear_destination goes back to the start channel; destination and clear together are refused', async () => {
  const t = setup();
  await saveTranscriptSettings(t.db, GUILD, { save: true, post: true, destination: DEST }, ADMIN, NOW);
  assert.match((await t.run(slash('transcript-settings', { destination: DEST, clear_destination: true }))).data.content, /either `destination` or `clear_destination`/);
  const r = await t.run(slash('transcript-settings', { clear_destination: true }));
  assert.match(r.data.content, /Saved\./);
  assert.equal((await getTranscriptSettings(t.db, GUILD)).destination, null);
});

test('describeSettings explains save off + post on (summary posted in full, no link)', () => {
  assert.match(describeSettings({ save: false, post: true, destination: null, custom: true }), /posted in full/);
});

// ---------- the settings reach the recorder ----------

test('/start-recording remembers the channel it was typed in, and says where the results will go', async () => {
  const t = setup();
  const r = await t.run(slash('start-recording', {}, { perms: '0' }));
  assert.match(r.data.content, new RegExp(`go to <#${START}> a few minutes after it leaves`));
  const [s] = t.db.sql('SELECT * FROM recording_sessions');
  assert.equal(s.start_channel_id, START);
  assert.equal(s.started_by, ADMIN);

  const withDest = setup();
  await saveTranscriptSettings(withDest.db, GUILD, { save: true, post: true, destination: DEST }, ADMIN, NOW);
  assert.match((await withDest.run(slash('start-recording'))).data.content, new RegExp(`go to <#${DEST}>`));

  const noPost = setup();
  await saveTranscriptSettings(noPost.db, GUILD, { save: true, post: false, destination: null }, ADMIN, NOW);
  assert.match((await noPost.run(slash('start-recording'))).data.content, /Nothing is posted to a channel: the summary link is sent to you in a private message/);
});

test('config endpoint: no options -> the start channel, save and post on; the starter is the one to message', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const [s] = t.db.sql('SELECT id FROM recording_sessions');
  assert.deepEqual(await config(t.db, s.id), {
    voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: START, save: true, post: true, dm_user_id: ADMIN, backup_channel_id: null, glossary: '', language: 'en',
  });
});

test('config endpoint: a destination, an older setup channel, post off and save off each come through', async () => {
  const dest = setup({ setupTranscript: SETUP_TXT });
  await saveTranscriptSettings(dest.db, GUILD, { save: true, post: true, destination: DEST }, ADMIN, NOW);
  await dest.run(slash('start-recording'));
  const [d] = dest.db.sql('SELECT id FROM recording_sessions');
  assert.equal((await config(dest.db, d.id)).transcript_channel_id, DEST);

  const older = setup({ setupTranscript: SETUP_TXT });
  await older.run(slash('start-recording'));
  assert.equal((await config(older.db, older.db.sql('SELECT id FROM recording_sessions')[0].id)).transcript_channel_id, SETUP_TXT, 'existing setups keep working');

  const off = setup();
  await saveTranscriptSettings(off.db, GUILD, { save: true, post: false, destination: DEST }, ADMIN, NOW);
  await off.run(slash('start-recording'));
  const c = await config(off.db, off.db.sql('SELECT id FROM recording_sessions')[0].id);
  assert.deepEqual([c.transcript_channel_id, c.post, c.save, c.dm_user_id], [null, false, true, ADMIN]);

  const noSave = setup();
  await saveTranscriptSettings(noSave.db, GUILD, { save: false, post: true, destination: null }, ADMIN, NOW);
  await noSave.run(slash('start-recording'));
  const n = await config(noSave.db, noSave.db.sql('SELECT id FROM recording_sessions')[0].id);
  assert.deepEqual([n.transcript_channel_id, n.post, n.save], [START, true, false]);
});

test('config endpoint: a scheduled session has nobody to message', async () => {
  const t = setup();
  t.db.sql(`INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('sched1234', '${VC}', '${GUILD}', 'scheduled', 'starting', ${NOW}, ${NOW})`);
  const c = await config(t.db, 'sched1234');
  assert.equal(c.dm_user_id, null);
  assert.equal(c.transcript_channel_id, null, 'no start channel and no destination: the recorder reports it clearly instead of guessing');
});

test('/setup-recording works without a transcript channel (it is optional now)', async () => {
  const t = setup();
  const r = await t.run(slash('setup-recording', { voice_channel: VOICE_OTHER }));
  assert.match(r.data.content, /the channel where each recording is started/);
  const row = t.db.sql(`SELECT * FROM recording_setups WHERE voice_channel_id = '${VOICE_OTHER}'`)[0];
  assert.equal(row.transcript_channel_id, null);
  assert.match((await t.run(slash('recording-settings'))).data.content, /where the recording is started/);
});

// ---------- the migration ----------

test('migration 0012 keeps every existing /setup-recording row and makes the transcript channel optional', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const files = readdirSync(dir).sort();
  const db = new DatabaseSync(':memory:');
  for (const f of files.filter((x) => x < '0012')) db.exec(readFileSync(path.join(dir, f), 'utf8'));
  db.exec(`INSERT INTO recording_setups VALUES ('${VC}', '${GUILD}', 'Design', '${SETUP_TXT}', '${DEST}', 'LiteCut', 'fr', 'admin', 5, 6)`);
  db.exec(readFileSync(path.join(dir, files.find((x) => x.startsWith('0012'))), 'utf8'));
  const row = db.prepare('SELECT * FROM recording_setups').get();
  assert.deepEqual({ ...row }, { voice_channel_id: VC, guild_id: GUILD, name: 'Design', transcript_channel_id: SETUP_TXT, backup_channel_id: DEST, glossary: 'LiteCut', language: 'fr', created_by: 'admin', created_at: 5, updated_at: 6 });
  db.exec(`INSERT INTO recording_setups (voice_channel_id, guild_id, name, created_by, created_at, updated_at) VALUES ('${VOICE_OTHER}', '${GUILD}', 'No transcript channel', 'a', 1, 1)`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recording_setups').get().n, 2);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'recording_setups_by_guild'").get(), 'the guild index is back');
});
