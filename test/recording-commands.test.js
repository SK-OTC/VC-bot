import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/commands.js';
import { createRecorderDispatcher } from '../src/github.js';
import { createDiscordClient } from '../src/discord.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';
import { reportFinish } from '../recorder/report.mjs';
import worker from '../src/index.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const GUILD = '222222222222222222';
const VC1 = '111111111111111111';
const VC2 = '555555555555555555';
const ALICE = '700000000000000001';
const BOB = '700000000000000002';

/** A fake recorder dispatcher that remembers every dispatch. */
function fakeRecorder(result = { ok: true }) {
  const calls = [];
  return { calls, async dispatch(inputs) { calls.push(inputs); return result; } };
}

function setup({ recorder = fakeRecorder(), voice = { [ALICE]: VC1 }, withDefer = false } = {}) {
  const db = createTestDb();
  const discord = createFakeDiscord([], { voice });
  const deferred = [];
  let now = NOW;
  const run = (interaction) =>
    handleInteraction(interaction, { db, discord, recorder, nowSec: now, defer: withDefer ? (p) => deferred.push(p) : null });
  return { db, discord, recorder, run, deferred, setNow: (n) => { now = n; } };
}

const slash = (name, opts = {}, { user = ALICE, perms = '0' } = {}) => ({
  type: 2,
  guild_id: GUILD,
  channel_id: '999999999999999999',
  application_id: 'app1',
  token: 'tok',
  member: { user: { id: user }, permissions: perms },
  data: { name, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: typeof v === 'boolean' ? 5 : 3 })) },
});
const isPrivate = (r) => (r.data.flags & 64) === 64;
const sessions = (db) => db.sql('SELECT * FROM recording_sessions ORDER BY created_at, id');

// ---------- /start-recording ----------

test('start: uses the voice channel you are in, saves a session, dispatches the workflow with its id', async () => {
  const t = setup();
  const r = await t.run(slash('start-recording'));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, new RegExp(`<#${VC1}>`));
  assert.equal(t.recorder.calls.length, 1);
  const [s] = sessions(t.db);
  assert.equal(s.voice_channel_id, VC1);
  assert.equal(s.guild_id, GUILD);
  assert.equal(s.started_by, ALICE);
  assert.equal(s.status, 'starting');
  assert.match(s.id, /^[a-z0-9]{12}$/);
  assert.deepEqual(t.recorder.calls[0], { channel_id: VC1, session_id: s.id });
});

test('start: an explicit channel wins over where you are', async () => {
  const t = setup();
  await t.run(slash('start-recording', { channel: VC2 }));
  assert.equal(sessions(t.db)[0].voice_channel_id, VC2);
  assert.equal(t.recorder.calls[0].channel_id, VC2);
});

test('start: not in a voice channel and none picked -> asks, creates nothing', async () => {
  const t = setup();
  const r = await t.run(slash('start-recording', {}, { user: BOB }));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, /Join the voice channel/);
  assert.equal(sessions(t.db).length, 0);
  assert.equal(t.recorder.calls.length, 0);
});

test('start: a failed voice-state lookup says so and still lets you pick the channel', async () => {
  const t = setup({ voice: { [ALICE]: 'error' } });
  const r = await t.run(slash('start-recording'));
  assert.match(r.data.content, /couldn't check/);
  assert.match(r.data.content, /`channel` option/);
  assert.equal(sessions(t.db).length, 0);
});

test('start: not configured (no GitHub token) -> clear message, nothing saved', async () => {
  const t = setup({ recorder: null });
  const r = await t.run(slash('start-recording'));
  assert.ok(isPrivate(r));
  assert.match(r.data.content, /GITHUB_DISPATCH_TOKEN/);
  assert.equal(sessions(t.db).length, 0);
});

test('start: a channel that is already being recorded is refused, and no second job is started', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const again = await t.run(slash('start-recording', {}, { user: ALICE }));
  assert.match(again.data.content, /already being recorded/);
  assert.equal(t.recorder.calls.length, 1);
  assert.equal(sessions(t.db).length, 1);
});

test('start: two different channels can be recorded at once', async () => {
  const t = setup();
  await t.run(slash('start-recording', { channel: VC1 }));
  await t.run(slash('start-recording', { channel: VC2 }));
  assert.equal(sessions(t.db).length, 2);
});

test('start: if GitHub refuses, the session is marked failed (so the channel is free) and the reason is shown', async () => {
  const t = setup({ recorder: fakeRecorder({ ok: false, error: 'GitHub rejected the token (GITHUB_DISPATCH_TOKEN is wrong or expired)' }) });
  const r = await t.run(slash('start-recording'));
  assert.match(r.data.content, /couldn't start the recording: GitHub rejected the token/);
  const [s] = sessions(t.db);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /could not start/);
  t.recorder.dispatch = async () => ({ ok: true });
  await t.run(slash('start-recording')); // the channel is free again
  assert.equal(sessions(t.db).filter((x) => x.status === 'starting').length, 1);
});

test('start: with a deferred reply, answers at once and edits the message when GitHub has answered', async () => {
  const t = setup({ withDefer: true });
  const r = await t.run(slash('start-recording'));
  assert.equal(r.type, 5);
  assert.equal(r.data.flags, 64); // the "thinking..." placeholder is private
  assert.equal(t.deferred.length, 1);
  await Promise.all(t.deferred);
  assert.equal(t.discord.edits.length, 1);
  assert.match(t.discord.edits[0].content, /Starting a recording/);
  assert.equal(t.recorder.calls.length, 1);
});

test('start: an old stuck session (job never reported in) no longer blocks the channel', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  assert.match((await t.run(slash('start-recording'))).data.content, /already being recorded/);
  t.setNow(NOW + 21 * 60); // 21 minutes later and still 'starting'
  const r = await t.run(slash('start-recording'));
  assert.doesNotMatch(r.data.content, /already being recorded/);
  assert.deepEqual(sessions(t.db).map((s) => s.status).sort(), ['failed', 'starting']);
});

test('start: a running session is not treated as stale after 3 hours, only after 6', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  t.db.sql("UPDATE recording_sessions SET status = 'running'");
  t.setNow(NOW + 3 * 3600);
  assert.match((await t.run(slash('start-recording'))).data.content, /already being recorded/);
  t.setNow(NOW + 6 * 3600 + 60);
  assert.doesNotMatch((await t.run(slash('start-recording'))).data.content, /already being recorded/);
});

// ---------- /stop-recording ----------

test('stop: sets the flag the recorder polls, and says so publicly', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const r = await t.run(slash('stop-recording'));
  assert.ok(!isPrivate(r));
  assert.match(r.data.content, new RegExp(`<@${ALICE}>`));
  assert.deepEqual(r.data.allowed_mentions, { parse: [] }); // names the person without pinging them
  assert.equal(sessions(t.db)[0].stop_flag, 1);
});

test('stop: end to end with the recorder API: the poll sees stop:true', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const id = sessions(t.db)[0].id;
  const env = { DB: t.db, WORKER_SHARED_SECRET: 's3cret-value' };
  const poll = async () =>
    (await (await worker.fetch(new Request(`https://w.example/api/sessions/${id}/stop`, { headers: { Authorization: 'Bearer s3cret-value' } }), env, { waitUntil() {} })).json()).stop;
  assert.equal(await poll(), false);
  await t.run(slash('stop-recording'));
  assert.equal(await poll(), true);
});

test('stop: nothing running, several running, and wrong person', async () => {
  const t = setup();
  assert.match((await t.run(slash('stop-recording'))).data.content, /No recording is running/);
  assert.match((await t.run(slash('stop-recording', { channel: VC1 }))).data.content, /Nothing is being recorded/);

  await t.run(slash('start-recording', { channel: VC1 }));
  await t.run(slash('start-recording', { channel: VC2 }));
  const many = await t.run(slash('stop-recording'));
  assert.match(many.data.content, /More than one/);
  assert.equal(sessions(t.db).filter((s) => s.stop_flag === 1).length, 0);

  const wrong = await t.run(slash('stop-recording', { channel: VC1 }, { user: BOB }));
  assert.ok(isPrivate(wrong));
  assert.match(wrong.data.content, /Only the person who started/);
  assert.equal(sessions(t.db).filter((s) => s.stop_flag === 1).length, 0);

  const ok = await t.run(slash('stop-recording', { channel: VC1 }));
  assert.ok(!isPrivate(ok));
  assert.deepEqual(sessions(t.db).map((s) => s.stop_flag), [1, 0]);
});

test('stop: someone with Manage Server can stop another person\'s recording', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const r = await t.run(slash('stop-recording', {}, { user: BOB, perms: String(0x20) }));
  assert.ok(!isPrivate(r));
  assert.equal(sessions(t.db)[0].stop_flag, 1);
});

test('stop: asking twice says it is already stopping; force clears a stuck session so the channel can be reused', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  await t.run(slash('stop-recording'));
  const twice = await t.run(slash('stop-recording'));
  assert.ok(isPrivate(twice));
  assert.match(twice.data.content, /already being stopped/);
  assert.match(twice.data.content, /force/);

  const forced = await t.run(slash('stop-recording', { force: true }));
  assert.match(forced.data.content, /Cleared/);
  assert.equal(sessions(t.db)[0].status, 'failed');
  await t.run(slash('start-recording'));
  assert.equal(sessions(t.db).length, 2);
});

test('stop: before the bot has joined (status starting) it tells you the bot will leave when it does', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  assert.match((await t.run(slash('stop-recording'))).data.content, /had not joined yet/);
});

test('stop: a recording started by the scheduler needs Manage Server', async () => {
  const t = setup();
  t.db.sql(
    `INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES ('sched1234', '${VC1}', '${GUILD}', 'scheduled', 'running', ${NOW}, ${NOW})`,
  );
  assert.match((await t.run(slash('stop-recording'))).data.content, /Only the person who started/);
  assert.ok(!isPrivate(await t.run(slash('stop-recording', {}, { perms: String(0x8) }))));
});

test('both commands are server-only', async () => {
  const t = setup();
  for (const name of ['start-recording', 'stop-recording']) {
    const dm = { type: 2, user: { id: ALICE }, data: { name, options: [] } };
    assert.match((await t.run(dm)).data.content, /inside a server/);
  }
});

// ---------- the recorder reports that it ended: POST /api/sessions/<id>/finish ----------

function api(db) {
  const env = { DB: db, WORKER_SHARED_SECRET: 's3cret-value' };
  return (method, path, body, secret = 's3cret-value') =>
    worker.fetch(new Request(`https://w.example${path}`, { method, headers: { Authorization: `Bearer ${secret}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
}

test('finish: marks a live session done or failed, ignores ended and unknown ones, validates input', async () => {
  const t = setup();
  const call = api(t.db);
  await t.run(slash('start-recording', { channel: VC1 }));
  await t.run(slash('start-recording', { channel: VC2 }));
  const [a, b] = sessions(t.db).map((s) => s.id);

  assert.equal((await call('POST', `/api/sessions/${a}/finish`, { status: 'done' })).status, 200);
  assert.equal((await call('POST', `/api/sessions/${b}/finish`, { status: 'failed', error: 'x'.repeat(1000) })).status, 200);
  let rows = sessions(t.db);
  assert.deepEqual(rows.map((s) => s.status), ['done', 'failed']);
  assert.ok(rows[1].error.length <= 300);

  await call('POST', `/api/sessions/${a}/finish`, { status: 'failed' }); // already ended: unchanged
  assert.equal(sessions(t.db)[0].status, 'done');

  assert.equal((await call('POST', '/api/sessions/nosuchid1/finish', { status: 'done' })).status, 200);
  assert.equal((await call('POST', `/api/sessions/${a}/finish`, { status: 'bogus' })).status, 400);
  assert.equal((await call('POST', `/api/sessions/${a}/finish`, undefined)).status, 400);
  assert.equal((await call('GET', `/api/sessions/${a}/finish`)).status, 405);
  assert.equal((await call('POST', `/api/sessions/${a}/finish`, { status: 'done' }, 'wrong')).status, 401);

  // the channel is free again for a new recording
  await t.run(slash('start-recording', { channel: VC1 }));
  assert.equal(sessions(t.db).filter((s) => s.status === 'starting').length, 1);
  rows = null;
});

test('contract: recorder/report.mjs talks to the Worker and frees the channel', async () => {
  const t = setup();
  await t.run(slash('start-recording'));
  const id = sessions(t.db)[0].id;
  const call = api(t.db);
  const fetchImpl = (url, init) => call(init.method, new URL(url).pathname, JSON.parse(init.body), init.headers.Authorization.replace('Bearer ', ''));
  const env = { SESSION_ID: id, WORKER_URL: 'https://w.example/', WORKER_SHARED_SECRET: 's3cret-value' };
  assert.equal(await reportFinish(env, 'done', 'no speech captured', { fetchImpl }), true);
  assert.equal(sessions(t.db)[0].status, 'done');
});

test('reportFinish: never throws and does nothing without a session or Worker settings', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true }; };
  assert.equal(await reportFinish({}, 'done', '', { fetchImpl }), false);
  assert.equal(await reportFinish({ SESSION_ID: 'abcd1234', WORKER_URL: 'http://insecure.example', WORKER_SHARED_SECRET: 's' }, 'done', '', { fetchImpl }), false);
  assert.equal(await reportFinish({ SESSION_ID: 'bad id!', WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: 's' }, 'done', '', { fetchImpl }), false);
  assert.equal(called, 0);
  const boom = async () => { throw new Error('network down'); };
  assert.equal(await reportFinish({ SESSION_ID: 'abcd1234', WORKER_URL: 'https://w.example', WORKER_SHARED_SECRET: 's' }, 'failed', 'x', { fetchImpl: boom }), false);
});

// ---------- the GitHub dispatcher ----------

test('dispatcher: not configured without a token, a valid owner/repo or a sane branch name', () => {
  assert.equal(createRecorderDispatcher({ token: '', repo: 'a/b' }), null);
  assert.equal(createRecorderDispatcher({ token: 't', repo: '' }), null);
  assert.equal(createRecorderDispatcher({ token: 't', repo: 'not a repo' }), null);
  assert.equal(createRecorderDispatcher({ token: 't', repo: 'a/b/../c' }), null);
  assert.equal(createRecorderDispatcher({ token: 't', repo: 'a/b', ref: 'main; rm -rf' }), null);
  assert.ok(createRecorderDispatcher({ token: 't', repo: 'SK-OTC/VC-bot' }));
});

test('dispatcher: sends the exact workflow_dispatch request GitHub expects', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); };
  const d = createRecorderDispatcher({ token: 'ghp_secret', repo: 'SK-OTC/VC-bot', ref: 'main', fetchImpl });
  assert.deepEqual(await d.dispatch({ channel_id: VC1, session_id: 'abc123def456', max_minutes: '' }), { ok: true });
  assert.equal(seen.url, 'https://api.github.com/repos/SK-OTC/VC-bot/actions/workflows/record.yml/dispatches');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer ghp_secret');
  assert.ok(seen.init.headers['User-Agent']); // GitHub rejects requests without one
  assert.deepEqual(JSON.parse(seen.init.body), { ref: 'main', inputs: { channel_id: VC1, session_id: 'abc123def456' } }); // empty inputs are left out
});

test('dispatcher: each failure has a plain-English reason and never contains the token', async () => {
  const reasons = { 401: /rejected the token/, 403: /Actions: Read and write/, 404: /repository or workflow/, 422: /workflow file must exist/, 500: /HTTP 500/ };
  for (const [status, pattern] of Object.entries(reasons)) {
    const d = createRecorderDispatcher({ token: 'ghp_secret', repo: 'a/b', fetchImpl: async () => new Response('{"message":"ghp_secret leaked?"}', { status: Number(status) }) });
    const r = await d.dispatch({ channel_id: VC1, session_id: 'abc123def456' });
    assert.equal(r.ok, false);
    assert.match(r.error, pattern);
    assert.ok(!r.error.includes('ghp_secret'));
  }
  const down = createRecorderDispatcher({ token: 'ghp_secret', repo: 'a/b', fetchImpl: async () => { throw new Error('ENOTFOUND ghp_secret'); } });
  const r = await down.dispatch({ channel_id: VC1, session_id: 'abc123def456' });
  assert.match(r.error, /could not reach GitHub/);
  assert.ok(!r.error.includes('ghp_secret'));
});

// ---------- Discord voice-state lookup ----------

test('getVoiceChannelOf: in a channel, in none (404), and errors', async () => {
  const make = (res) => createDiscordClient({ token: 'tkn', apiBase: 'https://d.example/api', fetchImpl: async (url, init) => { make.seen = { url, init }; return res(); } });
  const inVc = make(() => new Response(JSON.stringify({ channel_id: VC1 }), { status: 200 }));
  assert.deepEqual(await inVc.getVoiceChannelOf(GUILD, ALICE), { ok: true, channelId: VC1 });
  assert.equal(make.seen.url, `https://d.example/api/guilds/${GUILD}/voice-states/${ALICE}`);
  assert.equal(make.seen.init.headers.Authorization, 'Bot tkn');
  assert.deepEqual(await make(() => new Response('{"code":10065}', { status: 404 })).getVoiceChannelOf(GUILD, ALICE), { ok: true, channelId: null });
  assert.deepEqual(await make(() => new Response('', { status: 500 })).getVoiceChannelOf(GUILD, ALICE), { ok: false, error: 'HTTP 500' });
  assert.equal((await make(() => { throw new Error('offline'); }).getVoiceChannelOf(GUILD, ALICE)).ok, false);
});

// ---------- wiring in the Worker entry point ----------

test('worker: without GITHUB_DISPATCH_TOKEN the commands exist but say recording is not set up', async () => {
  const t = setup({ recorder: createRecorderDispatcher({ token: '', repo: 'SK-OTC/VC-bot' }) });
  assert.match((await t.run(slash('start-recording'))).data.content, /not set up/);
});
