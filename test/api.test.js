import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { chunkTranscript } from '../src/chunk.js';
import { constantTimeEqual } from '../src/secure.js';
import { saveTranscript } from '../src/recording-store.js';
import { uploadTranscript } from '../pipeline/upload.mjs';

const SECRET = 'test-shared-secret-value';
const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const VC = '111111111111111111';
const GUILD = '222222222222222222';
const POST = '333333333333333333';
const MSG = '444444444444444444';

function setup(extraEnv = {}) {
  const db = createTestDb();
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET, ...extraEnv };
  const ctx = { waitUntil: () => {} };
  const call = (method, path, { body, secret = SECRET, headers = {} } = {}) =>
    worker.fetch(
      new Request(`https://worker.example${path}`, {
        method,
        headers: { ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
      ctx,
    );
  return { db, env, call };
}

const payload = (over = {}) => ({
  id: 'abc234',
  session_id: null,
  guild_id: GUILD,
  voice_channel_id: VC,
  post_channel_id: POST,
  transcript_message_id: MSG,
  summary_message_id: null,
  started_at: '2026-11-19T10:00:00.000Z',
  duration_sec: 3600,
  speakers: [{ name: 'Alice', speaking_sec: 900 }, { name: 'Sam', speaking_sec: 600 }],
  engine: 'groq whisper-large-v3',
  language: 'en',
  transcript_text: 'MEETING TRANSCRIPT\nSpeakers: Alice, Sam\n\n[00:00:05] Alice: hello everyone\n[00:00:09] Sam: shoes are the topic today',
  summary_text: '**Summary**\n- shoes',
  actions_text: '- Sam: buy shoes [00:00:09]',
  ...over,
});

const addSession = (db, id = 'sess1234', status = 'starting', channel = VC) =>
  db
    .prepare('INSERT INTO recording_sessions (id, voice_channel_id, guild_id, started_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, channel, GUILD, 'u1', status, NOW, NOW)
    .run();

// ---------- security: secret, method, configuration ----------

test('constantTimeEqual: equal, different, different length, empty', async () => {
  assert.equal(await constantTimeEqual('abc', 'abc'), true);
  assert.equal(await constantTimeEqual('abc', 'abd'), false);
  assert.equal(await constantTimeEqual('abc', 'abcd'), false);
  assert.equal(await constantTimeEqual('', 'abc'), false);
});

test('both endpoints refuse a missing or wrong secret with 401 and touch nothing', async () => {
  const { call, db } = setup();
  await addSession(db);
  for (const secret of [null, 'wrong', '']) {
    assert.equal((await call('GET', '/api/sessions/sess1234/stop', { secret })).status, 401);
    assert.equal((await call('POST', '/api/transcripts', { secret, body: payload() })).status, 401);
  }
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 0);
  assert.equal(db.sql("SELECT status FROM recording_sessions WHERE id = 'sess1234'")[0].status, 'starting');
});

test('a non-Bearer Authorization header is refused', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/sessions/sess1234/stop', { secret: null, headers: { Authorization: `Basic ${SECRET}` } });
  assert.equal(r.status, 401);
});

test('without WORKER_SHARED_SECRET the API says it is not configured instead of letting anyone in', async () => {
  const { call, env } = setup();
  delete env.WORKER_SHARED_SECRET;
  assert.equal((await call('GET', '/api/sessions/sess1234/stop')).status, 500);
  assert.equal((await call('GET', '/api/sessions/sess1234/stop', { secret: '' })).status, 500);
});

test('wrong HTTP methods and unknown paths', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/sessions/sess1234/stop')).status, 405);
  assert.equal((await call('GET', '/api/transcripts')).status, 405);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('GET', '/')).status, 200); // the existing health check still works
});

test('Discord interactions still need a valid signature (the old path is unchanged)', async () => {
  const { call, env } = setup({ DISCORD_PUBLIC_KEY: '00'.repeat(32), DISCORD_BOT_TOKEN: 'x' });
  const r = await call('POST', '/', { secret: null, body: '{}' });
  assert.equal(r.status, 401);
  assert.ok(env.DB);
});

// ---------- GET /api/sessions/<id>/stop (what recorder/record.mjs polls) ----------

test('stop: unknown or malformed session ids answer {stop:false}', async () => {
  const { call } = setup();
  for (const id of ['nosuchid', 'x', 'bad%20id']) {
    const r = await call('GET', `/api/sessions/${id}/stop`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { stop: false });
  }
});

test('stop: reports the flag, and the first poll marks the session running', async () => {
  const { call, db } = setup();
  await addSession(db);
  assert.deepEqual(await (await call('GET', '/api/sessions/sess1234/stop')).json(), { stop: false });
  assert.equal(db.sql("SELECT status FROM recording_sessions WHERE id = 'sess1234'")[0].status, 'running');
  db.sql("UPDATE recording_sessions SET stop_flag = 1 WHERE id = 'sess1234'");
  const r = await call('GET', '/api/sessions/sess1234/stop');
  assert.deepEqual(await r.json(), { stop: true });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

// ---------- chunking ----------

test('chunkTranscript: nothing is lost, pieces stay under the limit, long lines are split', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}:00] Sam: line ${i} ${'word '.repeat(10)}`);
  const long = 'blah '.repeat(900); // one 4,500-character line
  const text = [...lines, long.trim(), 'last line'].join('\n');
  const chunks = chunkTranscript(text, 1500);
  assert.ok(chunks.every((c) => c.length <= 1500));
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(squash(chunks.join('\n')), squash(text));
  assert.equal(chunkTranscript('').length, 0);
});

// ---------- POST /api/transcripts ----------

test('POST /api/transcripts: stores the transcript, its chunks and the search index', async () => {
  const { call, db } = setup();
  const r = await call('POST', '/api/transcripts', { body: payload() });
  assert.equal(r.status, 200);
  const answer = await r.json();
  assert.deepEqual({ ok: answer.ok, id: answer.id, chunks: answer.chunks }, { ok: true, id: 'abc234', chunks: 1 });
  assert.match(answer.share_url, /^https:\/\/worker\.example\/t\/[A-Za-z0-9_-]{43}$/); // the automatic private link
  const row = db.sql("SELECT * FROM transcripts WHERE id = 'abc234'")[0];
  assert.equal(row.post_channel_id, POST);
  assert.equal(row.started_at, Math.floor(Date.UTC(2026, 10, 19, 10, 0, 0) / 1000));
  assert.deepEqual(JSON.parse(row.speakers), [{ name: 'Alice', speaking_sec: 900 }, { name: 'Sam', speaking_sec: 600 }]);
  assert.equal(row.summary_message_id, null);
  const hits = db.sql("SELECT rowid FROM transcript_chunks_fts WHERE transcript_chunks_fts MATCH 'shoes'");
  assert.equal(hits.length, 1);
});

test('POST: a large transcript is split into many chunks that all reach the database, in order', async () => {
  const { call, db } = setup();
  const text = Array.from({ length: 2000 }, (_, i) => `[01:${String(i % 60).padStart(2, '0')}:00] Sam: sentence number ${i} about pricing`).join('\n');
  const r = await call('POST', '/api/transcripts', { body: payload({ transcript_text: text }) });
  assert.equal(r.status, 200);
  const rows = db.sql("SELECT seq, text FROM transcript_chunks WHERE transcript_id = 'abc234' ORDER BY seq");
  assert.ok(rows.length > 60);
  assert.deepEqual(rows.map((x) => x.seq), rows.map((_, i) => i));
  assert.equal(rows.map((x) => x.text).join('\n'), text);
});

test('POST: a known session is marked done; a session for another channel is refused', async () => {
  const { call, db } = setup();
  await addSession(db, 'sessAAAA', 'running');
  assert.equal((await call('POST', '/api/transcripts', { body: payload({ session_id: 'sessAAAA' }) })).status, 200);
  assert.equal(db.sql("SELECT status FROM recording_sessions WHERE id = 'sessAAAA'")[0].status, 'done');

  await addSession(db, 'sessBBBB', 'running', '999999999999999999'); // a different voice channel
  const bad = await call('POST', '/api/transcripts', { body: payload({ id: 'def567', session_id: 'sessBBBB' }) });
  assert.equal(bad.status, 400);
  assert.equal(db.sql("SELECT COUNT(*) AS n FROM transcripts WHERE id = 'def567'")[0].n, 0);
  assert.equal(db.sql("SELECT status FROM recording_sessions WHERE id = 'sessBBBB'")[0].status, 'running');
});

test('POST: an unknown session id is accepted (a hand-run recorder), the transcript is still stored', async () => {
  const { call, db } = setup();
  assert.equal((await call('POST', '/api/transcripts', { body: payload({ session_id: 'handrun1' }) })).status, 200);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
});

test('POST: a duplicate id answers 409 and changes nothing', async () => {
  const { call, db } = setup();
  assert.equal((await call('POST', '/api/transcripts', { body: payload() })).status, 200);
  const before = db.sql('SELECT COUNT(*) AS n FROM transcript_chunks')[0].n;
  const again = await call('POST', '/api/transcripts', { body: payload({ transcript_text: 'different text entirely' }) });
  assert.equal(again.status, 409);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcript_chunks')[0].n, before);
  assert.match(db.sql("SELECT text FROM transcript_chunks WHERE transcript_id = 'abc234'")[0].text, /shoes/);
});

test('saveTranscript is all-or-nothing: a failure part-way leaves no transcript and no chunks', async () => {
  const { db } = setup();
  const t = { ...payload(), summary_message_id: null, started_at: 1, speakers: [] };
  await saveTranscript(db, t, NOW);
  await assert.rejects(() => saveTranscript(db, { ...t, transcript_text: 'second attempt, same id' }, NOW), /UNIQUE/);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcript_chunks')[0].n, 1);
});

test('POST: invalid input is rejected with field names only, never the transcript text', async () => {
  const { call, db } = setup();
  const secretText = 'TOP-SECRET-WORDS-FROM-THE-MEETING';
  const cases = [
    payload({ id: 'ABCDEF', transcript_text: secretText }),
    payload({ id: 'abc234', guild_id: 'nope', transcript_text: secretText }),
    payload({ started_at: 'yesterday', transcript_text: secretText }),
    payload({ duration_sec: -5, transcript_text: secretText }),
    payload({ speakers: 'sam', transcript_text: secretText }),
    payload({ language: '??', transcript_text: secretText }),
    payload({ transcript_text: '' }),
    payload({ post_channel_id: undefined, transcript_text: secretText }),
  ];
  for (const body of cases) {
    const r = await call('POST', '/api/transcripts', { body });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.ok(!text.includes(secretText));
    assert.ok(Array.isArray(JSON.parse(text).fields));
  }
  assert.equal((await call('POST', '/api/transcripts', { body: 'not json {' })).status, 400);
  assert.equal((await call('POST', '/api/transcripts', { body: '[1,2]' })).status, 400);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 0);
});

test('POST: bodies over about 1 MB get 413 before anything is stored', async () => {
  const { call, db } = setup();
  const big = payload({ transcript_text: 'x'.repeat(1_100_000) });
  assert.equal((await call('POST', '/api/transcripts', { body: big })).status, 413);
  assert.equal((await call('POST', '/api/transcripts', { body: '{}', headers: { 'Content-Length': '999999999' } })).status, 413);
  assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 0);
});

test('nothing is logged that contains transcript text, names or the secret', async () => {
  const { call, db } = setup();
  const seen = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(keep)) console[k] = (...a) => seen.push(a.map(String).join(' '));
  try {
    await call('POST', '/api/transcripts', { body: payload() });
    await call('POST', '/api/transcripts', { body: payload() }); // 409
    await call('POST', '/api/transcripts', { body: payload({ id: 'zzzzzz' }), secret: 'wrong' });
    await call('POST', '/api/transcripts', { body: payload({ guild_id: 'bad' }) });
    // force an internal error: a database that throws
    const broken = { prepare: () => { throw new Error(`boom ${SECRET} hello everyone Alice`.slice(0, 40)); } };
    const r = await worker.fetch(
      new Request('https://worker.example/api/transcripts', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(payload({ id: 'qqqqqq' })) }),
      { DB: broken, WORKER_SHARED_SECRET: SECRET },
      { waitUntil() {} },
    );
    assert.equal(r.status, 500);
    assert.ok(!(await r.text()).includes('hello'));
  } finally {
    Object.assign(console, keep);
  }
  const all = seen.join('\n');
  for (const forbidden of [SECRET, 'hello everyone', 'shoes', 'Alice', 'Sam']) assert.ok(!all.includes(forbidden), `logged: ${forbidden}`);
  assert.ok(db);
});

test('one live recording per voice channel is enforced by the database', async () => {
  const { db } = setup();
  await addSession(db, 'first111', 'starting');
  await assert.rejects(() => addSession(db, 'second22', 'running'), /UNIQUE/);
  db.sql("UPDATE recording_sessions SET status = 'done' WHERE id = 'first111'");
  await addSession(db, 'third333', 'starting'); // allowed once the first is finished
});

// ---------- the recorder's real client talks to this Worker (contract test) ----------

test('contract: pipeline/upload.mjs (what session.mjs uses) and the Worker agree', async () => {
  const { call, db } = setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => call(init.method, new URL(url).pathname, { body: init.body, secret: init.headers.Authorization.replace('Bearer ', '') });
  try {
    // exactly the payload shape recorder/session.mjs builds
    const sessionPayload = {
      id: 'abc234',
      session_id: 'sess1234',
      guild_id: GUILD,
      voice_channel_id: VC,
      post_channel_id: POST,
      transcript_message_id: MSG,
      summary_message_id: MSG,
      started_at: new Date(Date.UTC(2026, 10, 19, 10, 0, 0)).toISOString(),
      duration_sec: 120,
      speakers: [{ name: 'Alice', speaking_sec: 60 }],
      engine: 'groq whisper-large-v3',
      language: 'en',
      transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:01] Alice: hi',
      summary_text: null,
      actions_text: null,
    };
    await addSession(db, 'sess1234', 'running');
    const ok = await uploadTranscript({ url: 'https://worker.example/api/transcripts', secret: SECRET, payload: sessionPayload, sleep: async () => {} });
    assert.equal(ok.ok, true);
    assert.match(ok.shareUrl, /^https:\/\/worker\.example\/t\/[A-Za-z0-9_-]{43}$/); // the automatic private link
    const dup = await uploadTranscript({ url: 'https://worker.example/api/transcripts', secret: SECRET, payload: sessionPayload, sleep: async () => {} });
    assert.equal(dup.conflict, true);
    const denied = await uploadTranscript({ url: 'https://worker.example/api/transcripts', secret: 'nope', payload: { ...sessionPayload, id: 'zzzzzz' }, sleep: async () => {} });
    assert.equal(denied.ok, false);
    assert.equal(db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('contract: recorder/record.mjs stop polling URL and answer shape', async () => {
  const { call, db } = setup();
  await addSession(db, 'sess1234', 'starting');
  db.sql("UPDATE recording_sessions SET stop_flag = 1 WHERE id = 'sess1234'");
  // recorder/record.mjs calls: GET <WORKER_URL>/api/sessions/<encodeURIComponent(id)>/stop with a Bearer header and reads `.stop === true`
  const r = await call('GET', `/api/sessions/${encodeURIComponent('sess1234')}/stop`);
  assert.equal((await r.json()).stop, true);
});
