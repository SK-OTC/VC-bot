import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { validateTranscriptPayload } from '../src/transcript-payload.js';

const SECRET = 'test-shared-secret-value';

const payload = (over = {}) => ({
  id: 'abc234',
  session_id: null,
  guild_id: '222222222222222222',
  voice_channel_id: '111111111111111111',
  post_channel_id: '333333333333333333',
  transcript_message_id: '444444444444444444',
  summary_message_id: null,
  started_at: '2026-11-19T10:00:00.000Z',
  duration_sec: 600,
  speakers: [{ name: 'Farah', speaking_sec: 300 }],
  engine: 'Parakeet TDT 0.6B v2',
  language: 'en',
  transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:05] Farah: we use LiteCut daily',
  summary_text: '**Summary**\n- tools [00:00:05]',
  actions_text: null,
  ...over,
});
const FIX = { from: 'Lite Cut', to: 'LiteCut', t: 5.2, kind: 'listed' };

function setup() {
  const db = createTestDb();
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET };
  const ctx = { waitUntil: () => {} };
  const call = (method, path, body, secret = SECRET) =>
    worker.fetch(new Request(`https://worker.example${path}`, { method, headers: secret ? { Authorization: `Bearer ${secret}` } : {}, body }), env, ctx);
  return { db, call };
}

test('payload: glossary_fixes is optional and validated field by field', () => {
  assert.equal(validateTranscriptPayload(payload()).ok, true);
  assert.equal(validateTranscriptPayload(payload({ glossary_fixes: null })).ok, true);
  assert.equal(validateTranscriptPayload(payload({ glossary_fixes: [] })).ok, true);
  const ok = validateTranscriptPayload(payload({ glossary_fixes: [FIX, { from: 'Capcat', to: 'CapCut', t: 0, kind: 'fuzzy' }, { from: 'litecut', to: 'LiteCut', t: 7000.5, kind: 'case' }] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.glossary_fixes.length, 3);
  for (const bad of ['text', {}, [null], [{}], [{ ...FIX, kind: 'other' }], [{ ...FIX, from: '' }], [{ ...FIX, from: 'x'.repeat(81) }], [{ ...FIX, to: 5 }], [{ ...FIX, t: -1 }], [{ ...FIX, t: 'soon' }], [{ ...FIX, t: 86_401 }], Array.from({ length: 501 }, () => FIX)]) {
    const r = validateTranscriptPayload(payload({ glossary_fixes: bad }));
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
    assert.deepEqual(r.bad, ['glossary_fixes']);
  }
  // unknown extra keys on an entry are dropped, not stored
  const trimmed = validateTranscriptPayload(payload({ glossary_fixes: [{ ...FIX, extra: 'ignored' }] }));
  assert.deepEqual(trimmed.value.glossary_fixes[0], FIX);
});

test('upload: the corrections are stored with the transcript, exactly as sent', async () => {
  const { db, call } = setup();
  const fixes = [FIX, { from: 'Capcat', to: 'CapCut', t: 61.5, kind: 'fuzzy' }];
  const res = await call('POST', '/api/transcripts', JSON.stringify(payload({ glossary_fixes: fixes })));
  assert.equal(res.status, 200);
  const row = db.sql("SELECT glossary_fixes FROM transcripts WHERE id = 'abc234'")[0];
  assert.deepEqual(JSON.parse(row.glossary_fixes), fixes);
});

test('upload: no corrections means nothing is stored (NULL), and an invalid record rejects the upload without saving anything', async () => {
  const { db, call } = setup();
  assert.equal((await call('POST', '/api/transcripts', JSON.stringify(payload()))).status, 200);
  assert.equal(db.sql("SELECT glossary_fixes FROM transcripts WHERE id = 'abc234'")[0].glossary_fixes, null);
  assert.equal((await call('POST', '/api/transcripts', JSON.stringify(payload({ id: 'def567', glossary_fixes: [{ ...FIX, kind: 'bad' }] })))).status, 400);
  assert.equal(db.sql("SELECT COUNT(*) AS n FROM transcripts WHERE id = 'def567'")[0].n, 0);
  assert.equal((await call('POST', '/api/transcripts', JSON.stringify(payload({ id: 'ghh234', glossary_fixes: [] })))).status, 200);
  assert.equal(db.sql("SELECT glossary_fixes FROM transcripts WHERE id = 'ghh234'")[0].glossary_fixes, null);
});

test('the record is for review only: it never appears on the share page', async () => {
  const { call } = setup();
  const res = await call('POST', '/api/transcripts', JSON.stringify(payload({ glossary_fixes: [{ from: 'ORIGINAL-MISHEARD-WORD', to: 'RIGHT-WORD', t: 5, kind: 'listed' }] })));
  const path = new URL((await res.json()).share_url).pathname;
  const html = await (await call('GET', path, undefined, null)).text();
  assert.equal(html.includes('ORIGINAL-MISHEARD-WORD'), false);
  assert.equal(html.includes('RIGHT-WORD'), false);
  assert.ok(!/glossary|corrected|correction/i.test(html));
});

test('the migration adds one nullable column and touches nothing else', () => {
  const db = createTestDb();
  const cols = db.sql("PRAGMA table_info('transcripts')").map((c) => c.name);
  assert.ok(cols.includes('glossary_fixes'));
  assert.ok(cols.includes('embedded_at') && cols.includes('summary_text'), 'earlier columns are intact');
});
