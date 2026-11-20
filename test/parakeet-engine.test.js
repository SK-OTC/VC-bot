import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParakeetEngine, PARAKEET_NAME } from '../pipeline/parakeet.mjs';
import { EngineError } from '../pipeline/groq.mjs';
import { cleanSegments } from '../pipeline/cleanup.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-parakeet-worker.mjs');
const make = (env = {}, over = {}) =>
  new ParakeetEngine({ command: [process.execPath, FAKE], env: { ...process.env, ...env }, startupTimeoutMs: 5000, requestTimeoutMs: () => 3000, ...over });

test('engine: the interface the pipeline expects, with the right name and flags', async () => {
  const e = make();
  assert.equal(e.name, PARAKEET_NAME);
  assert.equal(PARAKEET_NAME, 'Parakeet TDT 0.6B v2');
  assert.equal(typeof e.transcribe, 'function');
  assert.equal(e.retries, 1);
  assert.equal(e.treatEmptyAsFailure, true);
  assert.equal(e.timeBudgeted, true);
  await e.close();
});

test('engine: the model loads once for the whole job, and batches come back as segments', async () => {
  const e = make();
  assert.deepEqual(await e.start(), { ok: true });
  for (let i = 0; i < 3; i++) {
    const segs = await e.transcribe('ok.flac', { prompt: 'IGNORED glossary prompt', durationSec: 12.5 });
    assert.deepEqual(segs.map((s) => s.text), ['hello there everyone', 'second sentence here']);
    assert.equal(segs[0].start, 1);
    assert.deepEqual(Object.keys(segs[0]).sort(), ['end', 'start', 'text']); // no Whisper quality fields
  }
  assert.equal(e.spawnCount, 1, 'one worker process, one model load');
  assert.equal(e.stats.requests, 3);
  assert.equal(e.stats.audioSec, 37.5);
  await e.close();
});

test('engine: it uses all vCPUs by default, passes the model folder, and the prompt is never sent', async () => {
  const sent = [];
  const e = make({ PARAKEET_MODEL_DIR: '/cache/model' });
  assert.equal(e.threads, os.cpus().length);
  await e.start();
  const seen = e._proc;
  const write = seen.stdin.write.bind(seen.stdin);
  seen.stdin.write = (s) => { sent.push(s); return write(s); };
  await e.transcribe('ok.flac', { prompt: 'Names and terms: LiteCut.', durationSec: 5 });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(sent[0])).sort(), ['file', 'id']);
  assert.ok(!sent[0].includes('LiteCut'));
  const custom = make({}, { threads: 3 });
  assert.equal(custom.threads, 3);
  await e.close();
});

test('engine: an empty batch returns an empty list; the pipeline decides whether that is a failure', async () => {
  const e = make();
  assert.deepEqual(await e.transcribe('empty.flac', { durationSec: 5 }), []);
  await e.close();
});

test('engine: a worker that cannot load the model reports why, and transcribing then fails with a clear EngineError', async () => {
  const e = make({ FAKE_START: 'fail' }, { maxRestarts: 0 });
  const r = await e.start();
  assert.equal(r.ok, false);
  assert.match(r.reason, /ImportError/);
  await assert.rejects(e.transcribe('ok.flac'), (err) => err instanceof EngineError && err.kind === 'transient' && /not available/.test(err.message));
  await e.close();
});

test('engine: a missing Python, a worker that exits at once, and a model that never finishes loading are all reported, not thrown', async () => {
  const none = new ParakeetEngine({ command: ['definitely-not-a-real-python-xyz', 'x'], startupTimeoutMs: 3000 });
  const r1 = await none.start();
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /could not start the worker/);

  const dies = make({ FAKE_START: 'die' });
  const r2 = await dies.start();
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /exited while starting/);

  const slow = make({ FAKE_START: 'never-ready' }, { startupTimeoutMs: 300 });
  const r3 = await slow.start();
  assert.deepEqual(r3, { ok: false, reason: 'timed out while loading the model' });
  for (const e of [none, dies, slow]) await e.close();
});

test('engine: stray lines on stdout (a library printing) are ignored', async () => {
  const e = make({ FAKE_START: 'noise' });
  assert.equal((await e.start()).ok, true);
  assert.equal((await e.transcribe('garbage-ok.flac', { durationSec: 5 })).length, 2);
  await e.close();
});

test('engine: an error from the worker becomes an EngineError carrying only a short reason', async () => {
  const e = make();
  await assert.rejects(e.transcribe('error.flac', { durationSec: 5 }), (err) => err instanceof EngineError && err.kind === 'transient' && /^Parakeet failed: /.test(err.message) && err.message.length < 140);
  assert.equal((await e.transcribe('ok.flac', { durationSec: 5 })).length, 2, 'the worker is still usable after an error');
  await e.close();
});

test('engine: if the worker crashes mid-batch that batch fails, the next one restarts it, and restarts are limited', async () => {
  const e = make({}, { maxRestarts: 2 });
  await e.start();
  await assert.rejects(e.transcribe('crash.flac', { durationSec: 5 }), (err) => err instanceof EngineError && /stopped/.test(err.message));
  assert.equal((await e.transcribe('ok.flac', { durationSec: 5 })).length, 2); // restart 1
  assert.equal(e.spawnCount, 2);
  await assert.rejects(e.transcribe('crash.flac'), EngineError);
  assert.equal((await e.transcribe('ok.flac')).length, 2); // restart 2
  await assert.rejects(e.transcribe('crash.flac'), EngineError);
  await assert.rejects(e.transcribe('ok.flac'), (err) => /stopped too many times/.test(err.message)); // no third restart
  assert.equal(e.spawnCount, 3);
  await e.close();
});

test('engine: a hung batch is cut off at the timeout, the worker is replaced, and the next batch works', async () => {
  const e = make({}, { requestTimeoutMs: () => 300 });
  await e.start();
  const t0 = Date.now();
  await assert.rejects(e.transcribe('hang.flac', { durationSec: 5 }), (err) => /took too long/.test(err.message));
  assert.ok(Date.now() - t0 < 2500);
  assert.equal((await e.transcribe('ok.flac', { durationSec: 5 })).length, 2);
  assert.equal(e.spawnCount, 2);
  await e.close();
});

test('engine: the timeout grows with the batch length (more audio, more time)', () => {
  const e = new ParakeetEngine({ command: ['x'] });
  assert.ok(e.requestTimeoutMs(240) > e.requestTimeoutMs(10));
  assert.ok(e.requestTimeoutMs(0) >= 60_000);
});

test('engine: batches are strictly one at a time even when asked for at once, in order', async () => {
  const e = make();
  try {
    await e.start();
    // Record how many batches are pending at the moment each one is sent to the worker. A request is registered just
    // before it is written, so a batch that is alone sees 1 (itself); an overlapping one would see 2 or more.
    const pendingWhenSent = [];
    const write = e._proc.stdin.write.bind(e._proc.stdin);
    e._proc.stdin.write = (s) => { pendingWhenSent.push(e._pending.size); return write(s); };
    const files = ['slow-1.flac', 'slow-2.flac', 'slow-3.flac', 'slow-4.flac'];
    const results = await Promise.all(files.map((f) => e.transcribe(f, { durationSec: 5 })));
    assert.equal(results.length, 4);
    assert.ok(results.every((r) => r.length === 2));
    assert.deepEqual(pendingWhenSent, [1, 1, 1, 1], 'each batch is sent only after the previous one has finished');
    assert.equal(e.stats.requests, 4);
  } finally {
    await e.close(); // always stop the worker, even when an assertion fails, or the test run would never exit
  }
});

test('engine: close() stops the worker, and a closed engine refuses new work with an EngineError', async () => {
  const e = make();
  await e.start();
  const proc = e._proc;
  await e.close();
  assert.ok(proc.killed || proc.exitCode !== null || proc.signalCode !== null);
  await assert.rejects(e.transcribe('ok.flac'), (err) => err instanceof EngineError);
  assert.deepEqual(await e.start(), { ok: false, reason: 'closed' });
  await e.close(); // closing twice is fine
});

test('engine: Parakeet output goes straight through the existing cleanup stage (missing quality fields count as a pass)', async () => {
  const e = make();
  const segs = await e.transcribe('ok.flac', { durationSec: 5 });
  const { kept, dropped } = cleanSegments(segs);
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped, { empty: 0, noSpeech: 0, repetition: 0, phantom: 0 });
  await e.close();
});

// ---------- cleanup for engines with no quality fields (A4) ----------

import { textCompressionRatio } from '../pipeline/cleanup.mjs';

test('cleanup: segments with no quality fields pass every check that needs those fields', () => {
  const segs = [
    { start: 0, end: 4, text: 'We should ship the pricing page on Friday.' },
    { start: 5, end: 7, text: 'Thank you for watching.' }, // a Whisper-style phantom: with no confidence fields it cannot be judged, so it stays
    { start: 8, end: 9, text: 'you' },
  ];
  const { kept, dropped } = cleanSegments(segs);
  assert.equal(kept.length, 3);
  assert.deepEqual(dropped, { empty: 0, noSpeech: 0, repetition: 0, phantom: 0 });
});

test('cleanup: the repeated-phrase check still works without compression_ratio, using the text itself', () => {
  const loop = Array.from({ length: 40 }, () => 'the').join(' ') + ' budget';
  const phrase = Array.from({ length: 15 }, () => 'thank you very much').join(' ');
  const normal = 'So I think we should talk to the design team about the launch plan and then decide who owns the follow up work.';
  assert.ok(textCompressionRatio(loop) > 2.4, `loop ratio ${textCompressionRatio(loop)}`);
  assert.ok(textCompressionRatio(phrase) > 2.4);
  assert.ok(textCompressionRatio(normal) < 2.4, `normal speech ratio ${textCompressionRatio(normal)}`);
  const { kept, dropped } = cleanSegments([
    { start: 0, end: 10, text: loop },
    { start: 10, end: 20, text: phrase },
    { start: 20, end: 30, text: normal },
  ]);
  assert.deepEqual(kept.map((s) => s.text), [normal]);
  assert.equal(dropped.repetition, 2);
});

test('cleanup: short text is never judged by the text ratio, and a real compression_ratio from Whisper still wins', () => {
  assert.equal(textCompressionRatio('yes yes yes yes'), 0);
  assert.equal(textCompressionRatio(''), 0);
  assert.equal(textCompressionRatio(null), 0);
  const loop = Array.from({ length: 40 }, () => 'the').join(' ');
  // Whisper said the ratio is fine (1.0): its own number is trusted over ours
  assert.equal(cleanSegments([{ start: 0, end: 5, text: loop, compression_ratio: 1.0 }]).kept.length, 1);
  // and a high number from Whisper drops short text too
  assert.equal(cleanSegments([{ start: 0, end: 5, text: 'hello there', compression_ratio: 3.5 }]).kept.length, 0);
});
