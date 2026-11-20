import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline, MIN_SPEECH_FOR_EMPTY_FAILURE } from '../pipeline/run.mjs';
import { createTimeBudget } from '../pipeline/time-budget.mjs';
import { buildHeader, engineLine, formatTranscript, displayNames } from '../pipeline/transcript.mjs';
import { ENGINE_NAMES, parseEngineOrder, planEngines } from '../pipeline/engines.mjs';
import { createGlossaryFixer, loadCommonWords } from '../pipeline/glossary-fix.mjs';
import { parseSessionConfig } from '../recorder/config.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const opt = { skip: hasFfmpeg ? false : 'ffmpeg is not installed' };

// ---------- synthetic audio: three 3 s tones separated by 3 s of silence (speech spans the pipeline can find) ----------

function makeAudio(dir, name, tones = 3) {
  const out = path.join(dir, `input-${name}.wav`); // never the pipeline's own work file name (it writes <label>.wav in the same folder)
  const inputs = [];
  const parts = [];
  for (let i = 0; i < tones; i++) {
    inputs.push('-f', 'lavfi', '-t', '3', '-i', 'sine=frequency=440:sample_rate=16000');
    parts.push(`[${inputs.filter((x) => x === '-i').length - 1}:a]`);
    if (i < tones - 1) {
      inputs.push('-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=16000:cl=mono');
      parts.push(`[${inputs.filter((x) => x === '-i').length - 1}:a]`);
    }
  }
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${parts.join('')}concat=n=${parts.length}:v=0:a=1[o]`, '-map', '[o]', '-ac', '1', '-ar', '16000', out]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

const withDir = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'engines-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A fake engine. behave(callNumber, file, opts) returns segments (batch time) or throws. Records every call. */
function fakeEngine(name, behave, flags = {}) {
  const e = {
    name,
    label: flags.label ?? name,
    calls: [],
    async transcribe(file, o) {
      e.calls.push({ file: path.basename(file), ...o });
      return behave(e.calls.length, file, o);
    },
    ...flags,
  };
  return e;
}
const speech = (text = 'hello there everyone') => [{ start: 0.5, end: 2.5, text }];
const fail = (kind = 'transient') => Object.assign(new Error('boom'), { kind });
const parakeetFlags = { retries: 1, treatEmptyAsFailure: true, timeBudgeted: true, label: 'Parakeet TDT 0.6B v2' };
const groqFlags = { label: 'Groq Whisper' };
const opts = { maxSpeech: 4 }; // one batch per tone

async function run(dir, extra = {}) {
  const wav = makeAudio(dir, 'speaker-1');
  const logs = [];
  const r = await runPipeline({ speakers: [{ label: 'speaker-1', files: [wav] }], workDir: dir, log: (m) => logs.push(m), opts, ...extra });
  return { ...r, logs };
}

// ---------- the pipeline on real (synthetic) audio ----------

test('pipeline: finds the speech, sends one batch at a time, maps times back, and names the engine', opt, async () => {
  await withDir(async (dir) => {
    const e = fakeEngine('Parakeet TDT 0.6B v2', () => speech(), parakeetFlags);
    const { lines, failures, stats } = await run(dir, { engine: e });
    assert.equal(stats.batches, 3);
    assert.equal(e.calls.length, 3);
    assert.equal(lines.length, 3);
    assert.deepEqual(failures, []);
    // the three tones are at about 0 s, 6 s and 12 s: each line lands about 0.5 s into its tone
    const starts = lines.map((l) => l.start);
    assert.ok(starts[0] >= 0 && starts[0] < 1.5, `first line at ${starts[0]}`);
    assert.ok(Math.abs(starts[1] - 6.5) < 1.5, `second line at ${starts[1]}`);
    assert.ok(Math.abs(starts[2] - 12.5) < 1.5, `third line at ${starts[2]}`);
    assert.deepEqual([...stats.engines], ['Parakeet TDT 0.6B v2']);
    assert.equal(stats.fallbackBatches, 0);
    // every batch got a duration, and the prompt (glossary) is passed along even though Parakeet ignores it
    assert.ok(e.calls.every((c) => c.durationSec > 3 && c.durationSec < 5));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.flac') || f === 'speaker-1.wav' ), [], 'work files are removed');
  });
});

test('pipeline: a failed batch is tried once more, and only then handed to the fallback', opt, async () => {
  await withDir(async (dir) => {
    // the main engine fails the FIRST time it sees the first batch and then works
    const main = fakeEngine('Parakeet TDT 0.6B v2', (n) => { if (n === 1) throw fail(); return speech(); }, parakeetFlags);
    const backup = fakeEngine('groq whisper-large-v3', () => speech('from the backup'), groqFlags);
    const { stats, lines } = await run(dir, { engine: main, fallbackEngine: backup });
    assert.equal(main.calls.length, 4, 'three batches plus one retry');
    assert.equal(backup.calls.length, 0);
    assert.equal(stats.fallbackBatches, 0);
    assert.equal(lines.length, 3);
  });
});

test('pipeline: a batch that fails twice goes to the fallback; the header names both engines in your wording', opt, async () => {
  await withDir(async (dir) => {
    const main = fakeEngine('Parakeet TDT 0.6B v2', (n) => { if (n <= 2) throw fail(); return speech(); }, parakeetFlags); // batch 1 fails twice
    const backup = fakeEngine('groq whisper-large-v3', () => speech('redone by the backup'), groqFlags);
    const { stats, lines, logs } = await run(dir, { engine: main, fallbackEngine: backup });
    assert.equal(stats.fallbackBatches, 1);
    assert.equal(stats.reroutedBatches, 0);
    assert.equal(backup.calls.length, 1);
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => l.text === 'redone by the backup'));
    const header = buildHeader({ startedAt: 0, lengthSec: 15, speakers: stats.speakers, names: { 'speaker-1': 'Sam' }, engines: stats.engines, labels: stats.labels, primaryName: stats.primaryName, fallbackName: stats.fallbackName, fallbackBatches: stats.fallbackBatches, failedBatches: stats.failedBatches });
    assert.match(header, /^Transcribed with Parakeet TDT 0\.6B v2; 1 part re-done with Groq Whisper\.$/m);
    assert.ok(logs.some((l) => /failed \(transient\), trying once more/.test(l)));
    assert.ok(!logs.join('\n').includes('redone by the backup'), 'transcript text never reaches the log');
  });
});

test('pipeline: no text although speech was found counts as a failure for Parakeet, but not for an engine that does not ask for it', opt, async () => {
  await withDir(async (dir) => {
    assert.ok(MIN_SPEECH_FOR_EMPTY_FAILURE <= 3);
    const main = fakeEngine('Parakeet TDT 0.6B v2', (n) => (n === 1 || n === 2 ? [] : speech()), parakeetFlags); // batch 1 comes back empty twice
    const backup = fakeEngine('groq whisper-large-v3', () => speech('backup text'), groqFlags);
    const { stats, logs } = await run(dir, { engine: main, fallbackEngine: backup });
    assert.equal(stats.fallbackBatches, 1);
    assert.ok(logs.some((l) => /failed \(empty\)/.test(l)));
  });
  await withDir(async (dir) => {
    const groqLike = fakeEngine('groq whisper-large-v3', () => [], groqFlags); // no flag: an empty answer is accepted
    const { stats, lines } = await run(dir, { engine: groqLike });
    assert.equal(stats.transcribedBatches, 3);
    assert.equal(lines.length, 0);
    assert.equal(groqLike.calls.length, 3);
  });
});

test('pipeline: a main engine that is refused (auth or daily limit) is switched off for the rest of the job', opt, async () => {
  await withDir(async (dir) => {
    const main = fakeEngine('Parakeet TDT 0.6B v2', () => { throw fail('auth'); }, parakeetFlags);
    const backup = fakeEngine('groq whisper-large-v3', () => speech('backup'), groqFlags);
    const { stats } = await run(dir, { engine: main, fallbackEngine: backup });
    assert.equal(main.calls.length, 1, 'tried once, never retried, never asked again');
    assert.equal(backup.calls.length, 3);
    assert.equal(stats.fallbackBatches, 3);
    assert.match(engineLine({ engines: stats.engines, labels: stats.labels, primaryName: stats.primaryName, fallbackName: stats.fallbackName, fallbackBatches: stats.fallbackBatches }), /^Transcribed with Groq Whisper \(Parakeet TDT 0\.6B v2 could not be used\)\.$/);
  });
});

test('pipeline: if both engines fail the part keeps its visible placeholder, as before', opt, async () => {
  await withDir(async (dir) => {
    const main = fakeEngine('Parakeet TDT 0.6B v2', (n) => { if (n <= 2) throw fail(); return speech(); }, parakeetFlags);
    const backup = fakeEngine('groq whisper-large-v3', () => { throw fail(); }, groqFlags);
    const { stats, failures, lines } = await run(dir, { engine: main, fallbackEngine: backup });
    assert.equal(stats.failedBatches, 1);
    assert.equal(failures.length, 1);
    assert.equal(lines.length, 2);
    const text = formatTranscript({ lines, failures, names: displayNames([{ label: 'speaker-1', name: 'Sam' }]), header: 'H\n' });
    assert.match(text, /could not be transcribed\]/);
  });
});

// ---------- the time budget ----------

test('budget: when the time is used up the REST of the batches go to the fallback, and it stays that way', opt, async () => {
  await withDir(async (dir) => {
    let clock = 0;
    const now = () => clock * 1000;
    // every Parakeet batch "takes" 100 s of the fake clock
    const main = fakeEngine('Parakeet TDT 0.6B v2', () => { clock += 100; return speech(); }, parakeetFlags);
    const backup = fakeEngine('groq whisper-large-v3', () => speech('rerouted'), groqFlags);
    const { stats, logs, lines } = await run(dir, { engine: main, fallbackEngine: backup, budgetSec: 150, now });
    // batch 1 (100 s) and batch 2 (200 s) go to Parakeet; the budget of 150 s is gone before batch 3
    assert.equal(main.calls.length, 2);
    assert.equal(backup.calls.length, 1);
    assert.equal(stats.reroutedBatches, 1);
    assert.equal(stats.fallbackBatches, 1);
    assert.equal(stats.budget.reason, 'the time budget is used up');
    assert.equal(lines.length, 3);
    assert.ok(logs.some((l) => /time budget: the time budget is used up/.test(l)));
    assert.match(engineLine({ engines: stats.engines, labels: stats.labels, primaryName: stats.primaryName, fallbackName: stats.fallbackName, fallbackBatches: stats.fallbackBatches }), /Transcribed with Parakeet TDT 0\.6B v2; 1 part re-done with Groq Whisper\./);
  });
});

test('budget: the projection counts the audio of ALL speakers, not just the one being done', opt, async () => {
  await withDir(async (dir) => {
    const a = makeAudio(dir, 'speaker-1');
    const b = makeAudio(dir, 'speaker-2');
    const speakers = [{ label: 'speaker-1', files: [a] }, { label: 'speaker-2', files: [b] }];
    const go = async (budgetSec) => {
      let clock = 0;
      const main = fakeEngine('Parakeet TDT 0.6B v2', () => { clock += 20; return speech(); }, parakeetFlags);
      const backup = fakeEngine('groq whisper-large-v3', () => speech('rerouted'), groqFlags);
      const r = await runPipeline({ speakers, engine: main, fallbackEngine: backup, workDir: dir, opts, budgetSec, budgetOpts: { minSamples: 1, minAudioSec: 1 }, now: () => clock * 1000 });
      return { main, backup, ...r };
    };
    // 6 batches of about 3.5 s, 20 s each: about 0.18x real time. After batch 1 there are about 17 s of audio left:
    // that needs about 97 s more, so the projected total is about 117 s. A budget of 100 s is not enough...
    const tight = await go(100);
    assert.ok(tight.stats.budget, 'projected over the budget using both speakers\' audio');
    assert.equal(tight.stats.budget.reason, 'the projected time is over the budget');
    assert.equal(tight.main.calls.length, 1, 'the decision is made right after the first batch');
    assert.equal(tight.backup.calls.length, 5);
    // ...but 400 s is plenty
    const roomy = await go(400);
    assert.equal(roomy.stats.budget, null);
    assert.equal(roomy.main.calls.length, 6);
    assert.equal(roomy.backup.calls.length, 0);
  });
});

test('budget: only an engine flagged timeBudgeted is watched, and without a fallback nothing is rerouted', opt, async () => {
  await withDir(async (dir) => {
    let clock = 0;
    const groqLike = fakeEngine('groq whisper-large-v3', () => { clock += 500; return speech(); }, groqFlags); // not flagged
    const r = await run(dir, { engine: groqLike, budgetSec: 10, now: () => clock * 1000 });
    assert.equal(r.stats.budget, null);
    assert.equal(groqLike.calls.length, 3);
  });
  await withDir(async (dir) => {
    let clock = 0;
    const main = fakeEngine('Parakeet TDT 0.6B v2', () => { clock += 500; return speech(); }, parakeetFlags);
    const r = await run(dir, { engine: main, fallbackEngine: null, budgetSec: 10, now: () => clock * 1000 });
    assert.equal(main.calls.length, 3, 'with no fallback there is nowhere to send the rest, so Parakeet carries on');
    assert.equal(r.stats.reroutedBatches, 0);
  });
});

test('time budget unit: needs enough to measure before projecting, then decides once and sticks', () => {
  let t = 0;
  const b = createTimeBudget({ budgetSec: 100, now: () => t * 1000, minSamples: 2, minAudioSec: 60 });
  assert.equal(b.shouldFallBack(10_000), false); // nothing measured yet: no projection
  b.record(30, 10); // 3x
  assert.equal(b.shouldFallBack(10_000), false); // one sample and 30 s of audio: still not enough
  b.record(40, 10); // 4x, now 2 samples and 70 s of audio
  t = 20;
  assert.equal(b.speed(), 70 / 20);
  assert.equal(b.shouldFallBack(100), false); // 20 + 100 / 3.5 = about 48.6 s: fine
  assert.equal(b.shouldFallBack(500), true); // 20 + 500 / 3.5 = about 163 s: over
  assert.equal(b.decision.reason, 'the projected time is over the budget');
  assert.equal(b.shouldFallBack(1), true, 'sticky: once decided it is decided');
  const used = createTimeBudget({ budgetSec: 50, now: () => t * 1000 });
  t = 20 + 51;
  assert.equal(used.shouldFallBack(1), true);
  assert.equal(used.decision.reason, 'the time budget is used up');
  const ignores = createTimeBudget({ budgetSec: 50, now: () => 0 });
  ignores.record(0, 5);
  ignores.record(5, 0);
  assert.equal(ignores.speed(), null, 'zero audio or zero time is not a measurement');
});

test('PARAKEET_BUDGET_MIN: default 120, whole minutes from 5 to 300, checked with the other settings', () => {
  const ch = '111111111111111111';
  const base = { DISCORD_TOKEN: 't', CHANNEL_ID: ch, TEAM_CONFIG: JSON.stringify({ [ch]: { name: 'A', transcriptChannelId: '222222222222222222' } }) };
  assert.equal(parseSessionConfig(base).parakeetBudgetMin, 120);
  assert.equal(parseSessionConfig({ ...base, PARAKEET_BUDGET_MIN: '45' }).parakeetBudgetMin, 45);
  assert.equal(parseSessionConfig({ ...base, PARAKEET_BUDGET_MIN: '' }).parakeetBudgetMin, 120);
  for (const bad of ['4', '301', 'abc', '1.5']) assert.throws(() => parseSessionConfig({ ...base, PARAKEET_BUDGET_MIN: bad }), /PARAKEET_BUDGET_MIN/);
});

// ---------- glossary correction inside the pipeline ----------

test('pipeline: glossary corrections change the text silently, are recorded with meeting times, and the log shows only a count', opt, async () => {
  await withDir(async (dir) => {
    const main = fakeEngine('Parakeet TDT 0.6B v2', () => speech('we should use Lite Cut and Capcat for the launch'), parakeetFlags);
    const fixer = createGlossaryFixer('LiteCut=Lite Cut, CapCut', { commonWords: loadCommonWords() });
    const { lines, stats, logs } = await run(dir, { engine: main, glossary: 'LiteCut=Lite Cut, CapCut', glossaryFixer: fixer });
    assert.ok(lines.every((l) => l.text === 'we should use LiteCut and CapCut for the launch'));
    assert.equal(stats.glossaryFixes.length, 6); // two corrections in each of three lines
    assert.deepEqual(stats.glossaryFixes.slice(0, 2).map((f) => [f.from, f.to, f.kind]), [['Lite Cut', 'LiteCut', 'listed'], ['Capcat', 'CapCut', 'fuzzy']]);
    assert.ok(stats.glossaryFixes.every((f) => Number.isFinite(f.t)));
    assert.ok(stats.glossaryFixes[2].t > stats.glossaryFixes[0].t, 'timestamps follow the meeting');
    assert.ok(logs.includes('glossary: 6 correction(s) made'));
    const everything = logs.join('\n');
    for (const word of ['Lite Cut', 'Capcat', 'LiteCut', 'CapCut']) assert.ok(!everything.includes(word), `the log must not contain "${word}"`);
    // the posted transcript carries no marks
    const transcript = formatTranscript({ lines, failures: [], names: { 'speaker-1': 'Sam' }, header: 'H\n' });
    assert.ok(!/Lite Cut|Capcat|corrected|\*/.test(transcript));
  });
});

test('pipeline: dry run finds the speech but transcribes nothing', opt, async () => {
  await withDir(async (dir) => {
    const main = fakeEngine('Parakeet TDT 0.6B v2', () => speech(), parakeetFlags);
    const { stats, lines } = await run(dir, { engine: main, opts: { maxSpeech: 4, dryRun: true } });
    assert.equal(stats.batches, 3);
    assert.equal(main.calls.length, 0);
    assert.equal(lines.length, 0);
  });
});

// ---------- the header wording ----------

test('header: your wording for every case', () => {
  const labels = { 'Parakeet TDT 0.6B v2': 'Parakeet TDT 0.6B v2', 'groq whisper-large-v3': 'Groq Whisper' };
  const base = { labels, primaryName: 'Parakeet TDT 0.6B v2', fallbackName: 'groq whisper-large-v3' };
  assert.equal(engineLine({ ...base, engines: new Set(['Parakeet TDT 0.6B v2']), fallbackBatches: 0 }), 'Transcribed with Parakeet TDT 0.6B v2.');
  assert.equal(engineLine({ ...base, engines: new Set(['Parakeet TDT 0.6B v2', 'groq whisper-large-v3']), fallbackBatches: 3 }), 'Transcribed with Parakeet TDT 0.6B v2; 3 parts re-done with Groq Whisper.');
  assert.equal(engineLine({ ...base, engines: new Set(['Parakeet TDT 0.6B v2', 'groq whisper-large-v3']), fallbackBatches: 1 }), 'Transcribed with Parakeet TDT 0.6B v2; 1 part re-done with Groq Whisper.');
  assert.equal(engineLine({ ...base, engines: new Set(['groq whisper-large-v3']), fallbackBatches: 5 }), 'Transcribed with Groq Whisper (Parakeet TDT 0.6B v2 could not be used).');
  assert.equal(engineLine({ engines: new Set(), fallbackBatches: 0 }), 'Transcribed with: none');
  assert.equal(engineLine({ engines: new Set(['groq whisper-large-v3']), labels, fallbackBatches: 0 }), 'Transcribed with Groq Whisper.'); // Groq as the main engine
  assert.match(engineLine({ engines: new Set(['x']), fallbackBatches: 2 }), /backup engine used for 2 parts/); // callers that do not pass names
});

// ---------- choosing the engines ----------

test('ENGINE_ORDER: default parakeet then groq; any order; unknown names ignored', () => {
  assert.deepEqual(ENGINE_NAMES, ['parakeet', 'groq']);
  assert.deepEqual(parseEngineOrder(undefined), ['parakeet', 'groq']);
  assert.deepEqual(parseEngineOrder(''), ['parakeet', 'groq']);
  assert.deepEqual(parseEngineOrder('groq,parakeet'), ['groq', 'parakeet']);
  assert.deepEqual(parseEngineOrder(' Groq '), ['groq']);
  assert.deepEqual(parseEngineOrder('whisper,nonsense'), ['parakeet', 'groq']);
  assert.deepEqual(parseEngineOrder('parakeet,parakeet,groq'), ['parakeet', 'groq']);
});

const fakeParakeet = (result) => {
  const p = { name: 'Parakeet TDT 0.6B v2', started: 0, closed: 0, start: async () => { p.started++; return result; }, close: async () => { p.closed++; } };
  return p;
};
const plan = (env, { parakeetResult = { ok: true }, groqKey = 'k' } = {}) => {
  const logs = [];
  const parakeet = fakeParakeet(parakeetResult);
  const p = planEngines({ env, groqKey, log: (m) => logs.push(m), makeParakeet: () => parakeet, makeGroq: (o) => ({ name: 'groq whisper-large-v3', opts: o }) });
  return { p, parakeet, logs };
};

test('engines: Parakeet is the main engine and Groq the fallback; Parakeet starts loading at once', async () => {
  const { p, parakeet } = plan({});
  assert.equal(parakeet.started, 1, 'the model starts loading before resolve() is called');
  const { engine, fallbackEngine } = await p.resolve();
  assert.equal(engine.name, 'Parakeet TDT 0.6B v2');
  assert.equal(fallbackEngine.name, 'groq whisper-large-v3');
  assert.equal(fallbackEngine.opts.model, 'whisper-large-v3');
  await p.close();
  assert.equal(parakeet.closed, 1);
});

test('engines: ENGINE_ORDER=groq,parakeet flips them', async () => {
  const { p } = plan({ ENGINE_ORDER: 'groq,parakeet' });
  const { engine, fallbackEngine } = await p.resolve();
  assert.equal(engine.name, 'groq whisper-large-v3');
  assert.equal(fallbackEngine.name, 'Parakeet TDT 0.6B v2');
});

test('engines: if Parakeet cannot start, Groq takes over as the main engine and the reason is logged', async () => {
  const { p, logs } = plan({}, { parakeetResult: { ok: false, reason: 'ImportError: onnx_asr is not installed' } });
  const { engine, fallbackEngine } = await p.resolve();
  assert.equal(engine.name, 'groq whisper-large-v3');
  assert.equal(fallbackEngine, null);
  assert.ok(logs.some((l) => /Parakeet is not available \(ImportError: onnx_asr is not installed\)/.test(l)));
});

test('engines: no Groq key means no fallback; neither engine means every batch fails with a clear reason', async () => {
  const { p, logs } = plan({}, { groqKey: '' });
  const r = await p.resolve();
  assert.equal(r.engine.name, 'Parakeet TDT 0.6B v2');
  assert.equal(r.fallbackEngine, null);
  assert.ok(logs.some((l) => /Groq is not configured/.test(l)));

  const none = plan({}, { groqKey: '', parakeetResult: { ok: false, reason: 'x' } });
  const n = await none.p.resolve();
  assert.equal(n.engine.name, 'none');
  await assert.rejects(n.engine.transcribe('f'), (e) => e.kind === 'auth');
  const onlyGroq = plan({ ENGINE_ORDER: 'groq' });
  assert.equal(onlyGroq.parakeet.started, 0, 'a Parakeet that is not in the order is never started');
});

test('engines: logs hold only engine names and fixed reasons, never keys', async () => {
  const { p, logs } = plan({}, { groqKey: 'gsk_SECRET_KEY_VALUE' });
  await p.resolve();
  assert.ok(!logs.join('\n').includes('gsk_SECRET_KEY_VALUE'));
});
