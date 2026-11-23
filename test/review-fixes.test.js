// Fixes from the 2026-11-23 code review of the /admin editor: each test is the failure the review described.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DIFF_CELLS, changedLines } from '../src/edit-ai.js';
import { QA_CLOUDFLARE_MODELS, answerQuestion } from '../src/ask.js';
import { EDITOR_SCRIPT } from '../src/editor-script.js';
import { createTestDb } from './helpers/d1.js';

// ---------- 1. a huge proposal can no longer exhaust the Worker's memory ----------

test('changedLines: 15,000 one-character lines (the attack) stay within a small table and finish fast', () => {
  const before = 'a\n'.repeat(15_000);
  const after = 'b\n'.repeat(15_000);
  const t0 = Date.now();
  const r = changedLines(before, after);
  assert.ok(Date.now() - t0 < 1000, 'finishes in well under a second');
  assert.equal(r.changed.size, 15_000, 'too big to compare line by line: every line in the differing part is marked');
  assert.equal(r.removed, 0, 'every removed line was replaced by a new one');
});

test('changedLines: matching lines at the start and end are skipped, so a big file with nearby changes is still exact', () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const after = [...lines];
  after[10_000] = 'line 10000, edited';
  after.splice(10_100, 0, 'a new line');
  const r = changedLines(lines.join('\n'), after.join('\n'));
  assert.deepEqual([...r.changed].sort((x, y) => x - y), [10_000, 10_100]);
  assert.equal(r.removed, 0, 'the edited line was replaced in place');
});

test('changedLines: changes far apart in a big file are marked as one region (coarse, but small and fast)', () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const after = [...lines];
  after[10_000] = 'line 10000, edited';
  after[15_000] = 'line 15000, edited';
  assert.ok((5_001 + 1) * (5_001 + 1) > MAX_DIFF_CELLS, 'the differing part (about 5,000 lines) is over the limit');
  const r = changedLines(lines.join('\n'), after.join('\n'));
  assert.equal(r.changed.size, 5_001, 'everything from the first to the last change');
  assert.ok(r.changed.has(10_000) && r.changed.has(15_000) && !r.changed.has(9_999) && !r.changed.has(15_001));
});

test('changedLines: small edits are still exact', () => {
  assert.deepEqual([...changedLines('a\nb\nc\nd', 'a\nB\nc\nd').changed], [1]);
  assert.deepEqual(changedLines('x\na\nb\nc', 'x\nc'), { changed: new Set(), removed: 2 });
});

// ---------- 4. AI edits fit each model's window, with time to finish ----------

function envWith({ aiRun, groq } = {}) {
  const calls = { ai: [], groq: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
      calls.groq.push({ body: JSON.parse(init.body), signal: init.signal });
      return new Response(JSON.stringify({ choices: [{ message: { content: groq ?? 'groq answer' } }] }), { status: 200 });
    }
    return real(url, init);
  };
  const env = {
    DB: createTestDb(),
    GROQ_API_KEY: 'gsk_test',
    AI: {
      async run(model, input) {
        calls.ai.push({ model, input });
        return aiRun ? aiRun(model, input) : { response: 'cloudflare answer', usage: { neurons: 1 } };
      },
    },
  };
  return { env, calls, restore: () => { globalThis.fetch = real; } };
}

test('answerQuestion: a request too big for a model\'s window skips it (Llama 3.3: 24,000 tokens) and the next model answers', async () => {
  const t = envWith();
  try {
    t.env.QA_MODEL_ORDER = 'cloudflare-llama,groq-gpt-oss';
    const big = [{ role: 'user', content: 'x'.repeat(3.5 * 20_000) }]; // about 20,000 tokens
    const r = await answerQuestion(t.env, big, 0, { maxTokens: 9000 });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'groq-gpt-oss');
    assert.equal(t.calls.ai.length, 0, 'Llama was not asked: 20,000 + 9,000 > 24,000');
    // the same request with a short answer fits, so Llama answers
    const r2 = await answerQuestion(t.env, big, 0, { maxTokens: 500 });
    assert.equal(r2.model, 'cloudflare-llama');
    assert.equal(QA_CLOUDFLARE_MODELS['cloudflare-gemma'].context, 256_000);
  } finally {
    t.restore();
  }
});

test('answerQuestion: edit limits reach the models: output size, Groq reasoning effort and its extra tokens; Q&A defaults unchanged', async () => {
  const t = envWith({ aiRun: () => { throw new Error('Internal server error'); } });
  try {
    await answerQuestion(t.env, [{ role: 'user', content: 'q' }], 0, { maxTokens: 2000, timeoutMs: 60_000, groqReasoningEffort: 'low', groqReasoningTokens: 1500 });
    assert.equal(t.calls.ai[0].input.max_tokens, 2000);
    assert.equal(t.calls.groq[0].body.max_completion_tokens, 3500, 'gpt-oss reasons inside its output limit, so it gets 1,500 more');
    assert.equal(t.calls.groq[0].body.reasoning_effort, 'low');
    await answerQuestion(t.env, [{ role: 'user', content: 'q' }], 0);
    assert.equal(t.calls.ai[1].input.max_tokens, 500, 'Q&A keeps its 500-token answers');
    assert.equal(t.calls.groq[1].body.max_completion_tokens, 500);
    assert.equal(t.calls.groq[1].body.reasoning_effort, undefined);
  } finally {
    t.restore();
  }
});

// ---------- 5 and 7. the page script ----------

test('editor script: a refusal (any 4xx) is shown and never retried; only network trouble and server errors are retried', () => {
  assert.match(EDITOR_SCRIPT, /else if \(j\.status >= 400 && j\.status < 500\) setStatus\(j\.error \|\| refusal\(j\.status\), 'bad'\);\n\s*else \{ setStatus\('Not saved yet\. Trying again\.\.\.', 'bad'\); retry\(\); \}/);
  assert.match(EDITOR_SCRIPT, /if \(status === 413\) return 'Not saved: the summary is too long to save/);
  assert.match(EDITOR_SCRIPT, /if \(status === 403\) return 'Not saved: the browser blocked the save/);
});

test('editor script: typing is saved before asking the AI, and leaving with a proposal open (or unsaved text) asks first', () => {
  const ask = EDITOR_SCRIPT.slice(EDITOR_SCRIPT.indexOf('function ask(instruction)'));
  assert.ok(ask.indexOf('if (domToText(notes) !== lastSaved) save();') < ask.indexOf('editable(false)'), 'saved before the notes are locked for the request');
  assert.match(EDITOR_SCRIPT, /if \(saving \|\| previewOpen \|\| domToText\(notes\) !== lastSaved\) \{ e\.preventDefault\(\); e\.returnValue = ''; \}/);
  assert.match(EDITOR_SCRIPT, /function preview\(j\) \{\n\s*previewOpen = true;/);
  assert.match(EDITOR_SCRIPT, /function finish\(kept\) \{\n\s*previewOpen = false;/);
});

// ---------- 6. a save whose reply was lost is not reported as a conflict ----------

test('autosave: resending a save that already went through (its reply was lost) succeeds; different text is still a conflict', async () => {
  const { default: worker } = await import('../src/index.js');
  const db = createTestDb();
  const env = { DB: db, WORKER_SHARED_SECRET: 's' };
  const send = (path, init = {}) => worker.fetch(new Request(`https://w.example${path}`, { redirect: 'manual', ...init }), env, { waitUntil: () => {} });
  const up = await send('/api/transcripts', {
    method: 'POST',
    headers: { Authorization: 'Bearer s' },
    body: JSON.stringify({
      id: 'abc234', session_id: null, guild_id: '222222222222222222', voice_channel_id: '111111111111111111', post_channel_id: '333333333333333333',
      transcript_message_id: '444444444444444444', summary_message_id: null, started_at: new Date().toISOString(), duration_sec: 60,
      speakers: [{ name: 'A', speaking_sec: 30 }], engine: 'x', language: 'en', transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:01] A: hi',
      summary_text: 'Title\n\n**Topic**\n- a point', actions_text: '',
    }),
  });
  const admin = `${new URL((await up.json()).share_url).pathname}/admin`;
  const save = (version, summary) =>
    send(admin, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams({ autosave: '1', version, summary }).toString() });

  assert.deepEqual(await (await save('0', 'my edit')).json(), { ok: true, version: 1 });
  // the reply to that save was lost, so the page sends it again with the version it still holds
  const again = await save('0', 'my edit');
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, version: 1 }, 'the page learns the current version and carries on');
  assert.equal(db.sql("SELECT summary_version FROM transcripts WHERE id = 'abc234'")[0].summary_version, 1, 'nothing written twice');
  // a different text from the old version is a real conflict
  const other = await save('0', 'someone else');
  assert.equal(other.status, 409);
});

// ---------- 8. replacements run in one pass ----------

test('applyReplacements: a rename never feeds into another, and a swap really swaps', async () => {
  const { applyReplacements } = await import('../src/edit-ai.js');
  const chained = applyReplacements('Toma met Thomas.', [
    { find: 'Toma', replace: 'Thomas' },
    { find: 'Thomas', replace: 'Thomas Lee' },
  ]);
  assert.equal(chained.text, 'Thomas met Thomas Lee.', 'the new "Thomas" is not renamed again');
  assert.equal(chained.count, 2);
  const swapped = applyReplacements('Aliyah asked Alisha.', [
    { find: 'Aliyah', replace: 'Alisha' },
    { find: 'Alisha', replace: 'Aliyah' },
  ]);
  assert.equal(swapped.text, 'Alisha asked Aliyah.');
  const longest = applyReplacements('New York and York', [
    { find: 'York', replace: 'Y' },
    { find: 'New York', replace: 'NYC' },
  ]);
  assert.equal(longest.text, 'NYC and Y', 'the longer search text wins where both could match');
  const repeated = applyReplacements('a b', [
    { find: 'a', replace: 'x' },
    { find: 'a', replace: 'y' },
  ]);
  assert.equal(repeated.text, 'x b', 'the same text listed twice: the first wins');
  assert.deepEqual(applyReplacements('a b', [{ find: 'z', replace: 'q' }, { find: 'a', replace: 'c' }]).missing, ['z']);
});

// ---------- 2. the version comes back from the save itself ----------

test('saveSummaryEdit: the new version is returned by the same statement, and a stale version changes nothing', async () => {
  const { saveSummaryEdit } = await import('../src/recording-store.js');
  const db = createTestDb();
  db.sql("INSERT INTO transcripts (id, guild_id, voice_channel_id, post_channel_id, transcript_message_id, started_at, duration_sec, speakers, engine, language, summary_text, created_at) VALUES ('t1', 'g', 'v', 'p', '', 0, 0, '[]', 'x', 'en', 's', 0)");
  const seen = [];
  const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); } };
  assert.deepEqual(await saveSummaryEdit(spy, 't1', 'one', 1, 0), { ok: true, version: 1 });
  assert.equal(seen.length, 1, 'one statement: no separate read that another save could slip in front of');
  assert.match(seen[0], /RETURNING summary_version/);
  assert.deepEqual(await saveSummaryEdit(spy, 't1', 'stale', 2, 0), { ok: false, conflict: true });
  assert.equal(db.sql("SELECT summary_edited AS e FROM transcripts WHERE id = 't1'")[0].e, 'one');
  assert.deepEqual(await saveSummaryEdit(spy, 't1', 'plain form, no version', 3), { ok: true, version: 2 });
});
