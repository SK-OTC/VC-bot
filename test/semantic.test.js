import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createTestDb } from './helpers/d1.js';
import { joinContext, rrf, selectContext } from '../src/ask.js';
import { DEFAULT_EMBEDDING_MODEL, deleteEmbeddings, embedIfDue, embedTranscript, embeddingEnabled, semanticHits } from '../src/semantic.js';

const NOW = Math.floor(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000);
const SECRET = 'test-shared-secret-value';
const GROQ_KEY = 'gsk_test_key_123';

// ---------- fakes ----------

// A toy "embedding model": words from the same idea share a dimension, so "spend" is close to "budget" but shares no
// letters with it. Words it does not know count for nothing. This is what lets the tests tell meaning from keywords.
const CONCEPTS = [
  ['budget', 'spend', 'spending', 'cost', 'price', 'dollars', 'money', 'funding'],
  ['weather', 'lunch', 'parking', 'holidays', 'filler', 'closing'],
  ['launch', 'release', 'ship', 'shipping', 'deadline'],
  ['hire', 'hiring', 'recruit', 'candidate'],
];
const toyVector = (text) => {
  const v = new Array(CONCEPTS.length).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    const i = CONCEPTS.findIndex((group) => group.includes(w));
    if (i >= 0) v[i] += 1;
  }
  return v;
};
const cosine = (a, b) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
};

function fakeAi() {
  return {
    calls: [],
    fail: false,
    malformed: false,
    async run(model, input) {
      this.calls.push({ model, texts: input.text });
      if (this.fail) throw new Error('AI is down SECRET-AI-DETAIL');
      if (this.malformed) return { data: 'not a list of vectors' };
      return { shape: [input.text.length, CONCEPTS.length], data: input.text.map(toyVector) };
    },
  };
}

function fakeVectorize() {
  const store = new Map(); // namespace -> Map(id -> { values, extra })
  return {
    store,
    upserts: [],
    queries: [],
    deletes: [],
    failQuery: false,
    extraMatches: [],
    async upsert(vectors) {
      this.upserts.push(vectors);
      for (const { id, namespace, values, ...extra } of vectors) {
        if (!store.has(namespace)) store.set(namespace, new Map());
        store.get(namespace).set(id, { values, extra });
      }
      return { mutationId: 'm1' };
    },
    async query(vector, options) {
      this.queries.push({ vector, options });
      if (this.failQuery) throw new Error('index is down SECRET-INDEX-DETAIL');
      const ns = store.get(options.namespace) ?? new Map();
      const matches = [...ns].map(([id, { values }]) => ({ id, score: cosine(vector, values) })).filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, options.topK);
      return { matches: [...matches, ...this.extraMatches], count: matches.length };
    },
    async deleteByIds(ids) {
      this.deletes.push(ids);
      for (const ns of store.values()) for (const id of ids) ns.delete(id);
    },
  };
}

function fakeGroq(handler = () => answer('ok')) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
      calls.push({ body: JSON.parse(init.body) });
      return handler(calls.length);
    }
    return real(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const answer = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

function setup({ bindings = true, envExtra = {} } = {}) {
  const db = createTestDb();
  const ai = fakeAi();
  const vec = fakeVectorize();
  const env = { DB: db, WORKER_SHARED_SECRET: SECRET, GROQ_API_KEY: GROQ_KEY, ...(bindings ? { AI: ai, VECTORIZE: vec } : {}), ...envExtra };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const atTime = async (now, fn) => {
    const realNow = Date.now;
    Date.now = () => now * 1000;
    try {
      const res = await fn();
      await Promise.all(waits.splice(0)); // background work (indexing) finishes before the test looks
      return res;
    } finally {
      Date.now = realNow;
    }
  };
  const ask = (path, question, now = NOW) =>
    atTime(now, () =>
      worker.fetch(
        new Request(`https://worker.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: question }).toString() }),
        env,
        ctx,
      ),
    );
  const upload = (over = {}, now = NOW) =>
    atTime(now, async () => {
      const res = await worker.fetch(
        new Request('https://worker.example/api/transcripts', { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(payload(over)) }),
        env,
        ctx,
      );
      assert.equal(res.status, 200);
      return new URL((await res.json()).share_url).pathname;
    });
  return { db, env, ai, vec, ask, upload, atTime };
}

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
  engine: 'groq whisper-large-v3',
  language: 'en',
  transcript_text: longTranscript(),
  summary_text: '**Summary**\n- a long meeting',
  actions_text: null,
  ...over,
});

/** About 100 KB: far over the "send it whole" limit, so retrieval is used. The one fact is in the middle. */
function longTranscript(fact = 'the budget is forty thousand dollars', marker = '') {
  return [
    'MEETING TRANSCRIPT',
    '',
    ...Array.from({ length: 800 }, (_, i) => `[01:${String(i % 60).padStart(2, '0')}:00] Sam: filler sentence number ${i} about the weather and lunch plans`),
    `[02:00:00] Farah: ${fact} ${marker}`,
    ...Array.from({ length: 800 }, (_, i) => `[03:${String(i % 60).padStart(2, '0')}:00] Sam: closing filler ${i} about parking and holidays`),
  ].join('\n');
}
const chunkCount = (db, id) => db.sql('SELECT COUNT(*) AS n FROM transcript_chunks WHERE transcript_id = ?', id)[0].n;
const row = (db, id) => db.sql('SELECT embedded_at, embed_tried_at FROM transcripts WHERE id = ?', id)[0];

// ---------- fusion ----------

test('rrf: a chunk found by both searches beats one found by only one; order inside a list is respected', () => {
  assert.deepEqual(rrf([[1, 2, 3], [3, 9]]).slice(0, 2), [3, 1]);
  assert.deepEqual(rrf([[5, 6], []]), [5, 6]);
  assert.deepEqual(rrf([[], []]), []);
  assert.deepEqual(rrf([[1], [2]]), [1, 2]); // an exact tie keeps the first list's chunk first
});

test('selectContext only accepts real chunk numbers from the meaning search', async () => {
  const t = setup({ bindings: false });
  await t.upload();
  const total = chunkCount(t.db, 'abc234');
  const hostile = [-1, 1.5, '3', null, undefined, NaN, Infinity, total, total + 50, 99999, { seq: 2 }, [2]];
  const pieces = await selectContext(t.db, 'abc234', 'anything', { semantic: hostile });
  assert.ok(pieces.every((p) => Number.isInteger(p.seq) && p.seq >= 0 && p.seq < total));
  assert.ok((await selectContext(t.db, 'abc234', 'x', { semantic: 'not a list' })).length > 0);
});

// ---------- indexing ----------

test('uploading a long transcript indexes it in the background: one namespace per transcript, vectors only', async () => {
  const t = setup();
  await t.upload();
  const n = chunkCount(t.db, 'abc234');
  assert.ok(n > 50, 'the test transcript must be long enough to need two batches');
  const ns = t.vec.store.get('abc234');
  assert.equal(ns.size, n);
  for (let seq = 0; seq < n; seq++) assert.ok(ns.has(`abc234:${seq}`));
  // nothing but id, namespace and values goes to the index: no text, no names, no metadata
  for (const batch of t.vec.upserts) for (const v of batch) assert.deepEqual(Object.keys(v).sort(), ['id', 'namespace', 'values']);
  assert.ok(!JSON.stringify(t.vec.upserts).includes('Farah') && !JSON.stringify(t.vec.upserts).includes('budget'));
  assert.deepEqual(t.ai.calls.map((c) => c.texts.length), [50, n - 50]); // batches of at most 50
  assert.ok(t.ai.calls.every((c) => c.model === DEFAULT_EMBEDDING_MODEL));
  assert.equal(row(t.db, 'abc234').embedded_at, NOW);
});

test('short transcripts are not indexed (they are sent whole), and without the bindings nothing changes', async () => {
  const short = setup();
  await short.upload({ id: 'shrt23', transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:01] Farah: the budget is forty thousand dollars' });
  assert.equal(short.ai.calls.length, 0);
  assert.equal(short.vec.upserts.length, 0);
  assert.equal(row(short.db, 'shrt23').embedded_at, null);

  const bare = setup({ bindings: false });
  await bare.upload();
  assert.equal(row(bare.db, 'abc234').embedded_at, null);
  assert.equal(row(bare.db, 'abc234').embed_tried_at, null);
  assert.equal(embeddingEnabled(bare.env), false);
  assert.equal(embeddingEnabled({ AI: { run() {} } }), false); // both bindings are needed
});

test('the upload is never hurt by an indexing failure, which is logged by type only', async () => {
  const t = setup();
  t.ai.fail = true;
  const seen = [];
  const keep = { error: console.error, log: console.log };
  console.error = (...a) => seen.push(a.join(' '));
  console.log = (...a) => seen.push(a.join(' '));
  try {
    await t.upload(); // asserts a 200 inside
  } finally {
    Object.assign(console, keep);
  }
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM transcripts')[0].n, 1);
  assert.equal(row(t.db, 'abc234').embedded_at, null);
  assert.equal(row(t.db, 'abc234').embed_tried_at, NOW);
  const all = seen.join('\n');
  assert.match(all, /indexing a transcript failed: Error/);
  assert.ok(!all.includes('SECRET-AI-DETAIL') && !all.includes('budget') && !all.includes('abc234'));
});

test('a malformed answer from the embedding model is rejected, nothing half-indexed is marked done', async () => {
  const t = setup();
  t.ai.malformed = true;
  await t.upload();
  assert.equal(row(t.db, 'abc234').embedded_at, null);
  assert.equal(t.vec.upserts.length, 0);
});

test('a failed indexing is retried by a question, but not more than once every 10 minutes, and never twice at once', async () => {
  const t = setup();
  t.ai.fail = true;
  const path = await t.upload();
  const groq = fakeGroq();
  try {
    const afterUpload = t.ai.calls.length;
    await t.ask(path, 'what was said about lunch', NOW + 60); // too soon: no new attempt
    assert.equal(t.ai.calls.length, afterUpload);
    t.ai.fail = false;
    await t.ask(path, 'what was said about lunch', NOW + 601); // due: indexes in the background
    assert.equal(row(t.db, 'abc234').embedded_at, NOW + 601);
    assert.equal(t.vec.store.get('abc234').size, chunkCount(t.db, 'abc234'));
  } finally {
    groq.restore();
  }
  // two requests at the same moment: only one wins the claim, so the transcript is indexed once, not twice
  const racing = setup();
  racing.ai.fail = true;
  await racing.upload(); // fails, leaving it un-indexed and due for a retry
  racing.ai.fail = false;
  const callsBefore = racing.ai.calls.length;
  const results = await Promise.all([embedIfDue(racing.env, 'abc234', NOW + 700), embedIfDue(racing.env, 'abc234', NOW + 700)]);
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal(racing.ai.calls.length - callsBefore, 2); // one indexing = two batches, not four
});

test('embedTranscript: unknown transcript and the delete helper', async () => {
  const t = setup();
  assert.deepEqual(await embedTranscript(t.env, 'nosuch', NOW), { ok: false });
  await t.upload();
  const n = chunkCount(t.db, 'abc234');
  assert.equal(await deleteEmbeddings(t.env, 'abc234', n), n);
  assert.equal(t.vec.store.get('abc234').size, 0);
  assert.equal(await deleteEmbeddings({}, 'abc234', n), 0);
});

// ---------- hybrid retrieval ----------

test('hybrid: a question in different words finds the answer by meaning; keywords alone miss it', async () => {
  const question = 'How much did we spend?'; // "spend" never appears in the meeting; "budget" and "dollars" do
  const groq = fakeGroq();
  try {
    const hybrid = setup();
    const path = await hybrid.upload();
    assert.equal((await hybrid.ask(path, question)).status, 200);
    assert.match(groq.calls[0].body.messages[1].content, /the budget is forty thousand dollars/);
    // the question itself was embedded, and the search was limited to this transcript's namespace
    assert.deepEqual(hybrid.ai.calls.at(-1).texts, [question]);
    assert.equal(hybrid.vec.queries.at(-1).options.namespace, 'abc234');

    const keywordOnly = setup({ bindings: false });
    const path2 = await keywordOnly.upload();
    await keywordOnly.ask(path2, question);
    assert.ok(!groq.calls[1].body.messages[1].content.includes('forty thousand dollars'), 'control: keyword search alone cannot find it');
  } finally {
    groq.restore();
  }
});

test('hybrid: a keyword-only match is still found when the meaning search finds nothing useful', async () => {
  const t = setup();
  const path = await t.upload({ transcript_text: longTranscript('the Zanzibar offsite is on Friday') });
  const groq = fakeGroq();
  try {
    await t.ask(path, 'when is the zanzibar offsite?'); // no concept words, so the toy embedding is empty; BM25 carries it
    assert.match(groq.calls[0].body.messages[1].content, /Zanzibar offsite is on Friday/);
  } finally {
    groq.restore();
  }
});

test('another meeting is never reached: the search names this namespace and foreign or invalid ids are ignored', async () => {
  const t = setup();
  const pathA = await t.upload({ id: 'aaaaaa', transcript_text: longTranscript('the budget is forty thousand dollars') });
  await t.upload({ id: 'bbbbbb', transcript_text: longTranscript('the budget is nine million dollars', 'OTHER-MEETING-SECRET') });
  t.vec.extraMatches = [
    { id: 'bbbbbb:400', score: 0.99 }, // a chunk of the OTHER transcript
    { id: 'aaaaaa:99999', score: 0.98 }, // not a chunk number of this one
    { id: '../../etc:1', score: 0.97 },
    { id: 'aaaaaa:-1', score: 0.96 },
    { id: 'aaaaaa:2.5', score: 0.95 },
    { id: 12345, score: 0.94 },
    null,
  ];
  const groq = fakeGroq();
  try {
    assert.equal((await t.ask(pathA, 'how much did we spend?')).status, 200);
    const sent = groq.calls[0].body.messages[1].content;
    assert.match(sent, /forty thousand dollars/);
    assert.ok(!sent.includes('OTHER-MEETING-SECRET') && !sent.includes('nine million'));
    for (const q of t.vec.queries.filter((x) => x.options.namespace)) assert.ok(['aaaaaa', 'bbbbbb'].includes(q.options.namespace));
    assert.equal(t.vec.queries.at(-1).options.namespace, 'aaaaaa');
  } finally {
    groq.restore();
  }
  // directly: of everything the index returns, only well-formed ids of THIS transcript survive
  const direct = {
    AI: fakeAi(),
    VECTORIZE: { upsert() {}, query: async () => ({ matches: [{ id: 'aaaaaa:5' }, { id: 'bbbbbb:6' }, { id: 'aaaaaa:-1' }, { id: 'aaaaaa:2.5' }, { id: '../x:1' }, { id: 'aaaaaa:5' }, { id: 7 }, null, {}, { id: 'aaaaaa:12' }] }) },
  };
  assert.deepEqual(await semanticHits(direct, 'aaaaaa', 'budget'), [5, 12]); // no duplicates, no other transcript, no junk
  assert.deepEqual(await semanticHits({ AI: direct.AI, VECTORIZE: { upsert() {}, query: async () => 'garbage' } }, 'aaaaaa', 'budget'), []);
});

test('if the meaning search fails, the question is still answered with keywords and nothing leaks', async () => {
  const modes = [
    ['AI down', (t) => { t.ai.fail = true; }],
    ['index down', (t) => { t.vec.failQuery = true; }],
    ['malformed embedding', (t) => { t.ai.malformed = true; }],
  ];
  for (const [label, break_] of modes) {
    const t = setup();
    const path = await t.upload({ transcript_text: longTranscript('the Zanzibar offsite is on Friday') });
    break_(t);
    const seen = [];
    const keep = { error: console.error, log: console.log };
    console.error = (...a) => seen.push(a.join(' '));
    console.log = (...a) => seen.push(a.join(' '));
    const groq = fakeGroq();
    try {
      const res = await t.ask(path, 'when is the zanzibar offsite SECRET-QUESTION-WORDS?');
      const html = await res.text();
      assert.equal(res.status, 200, label);
      assert.match(groq.calls[0].body.messages[1].content, /Zanzibar offsite is on Friday/, label);
      assert.ok(!html.includes('SECRET-AI-DETAIL') && !html.includes('SECRET-INDEX-DETAIL'), label);
    } finally {
      groq.restore();
      Object.assign(console, keep);
    }
    const all = seen.join('\n');
    assert.match(all, /meaning search failed/, label);
    for (const forbidden of ['SECRET-AI-DETAIL', 'SECRET-INDEX-DETAIL', 'SECRET-QUESTION-WORDS', 'Zanzibar', GROQ_KEY]) assert.ok(!all.includes(forbidden), `${label}: logged ${forbidden}`);
  }
});

test('a transcript that was never indexed (stored before this feature) is answered by keywords, then indexed in the background', async () => {
  const t = setup({ bindings: false });
  const path = await t.upload();
  assert.equal(row(t.db, 'abc234').embedded_at, null);
  t.env.AI = t.ai; // the bindings are added later, as after a deploy
  t.env.VECTORIZE = t.vec;
  const groq = fakeGroq();
  try {
    const res = await t.ask(path, 'what is happening here');
    assert.equal(res.status, 200);
    assert.equal(groq.calls.length, 1); // answered straight away, without waiting for the indexing
    assert.equal(row(t.db, 'abc234').embedded_at, NOW); // and it is indexed now
    await t.ask(path, 'how much did we spend?', NOW + 5);
    assert.match(groq.calls[1].body.messages[1].content, /the budget is forty thousand dollars/); // the next question benefits
  } finally {
    groq.restore();
  }
});

test('short meetings never call the embedding model, even when it is available', async () => {
  const t = setup();
  const path = await t.upload({ id: 'shrt23', transcript_text: 'MEETING TRANSCRIPT\n\n[00:00:01] Farah: the budget is forty thousand dollars' });
  const groq = fakeGroq();
  try {
    await t.ask(path, 'how much did we spend?');
    assert.match(groq.calls[0].body.messages[1].content, /forty thousand dollars/);
    assert.equal(t.ai.calls.length, 0);
    assert.equal(t.vec.queries.length, 0);
  } finally {
    groq.restore();
  }
});

test('questions over the limit do not reach the embedding model or the index', async () => {
  const t = setup({ envExtra: { QA_HOURLY_PER_LINK: '1' } });
  const path = await t.upload();
  const groq = fakeGroq();
  try {
    await t.ask(path, 'how much did we spend?');
    const aiBefore = t.ai.calls.length;
    const queriesBefore = t.vec.queries.length;
    assert.equal((await t.ask(path, 'how much did we spend again?')).status, 429);
    assert.equal(t.ai.calls.length, aiBefore);
    assert.equal(t.vec.queries.length, queriesBefore);
  } finally {
    groq.restore();
  }
});

test('joinContext still marks gaps when pieces come from several places', () => {
  assert.equal(joinContext([{ seq: 0, text: 'a' }, { seq: 7, text: 'b' }]), 'a\n[... part of the meeting not shown ...]\nb');
});
