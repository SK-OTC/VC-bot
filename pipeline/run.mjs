// The whole audio-to-transcript pipeline for one meeting.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureFfmpeg, toWav16kMono, probeDuration, detectSilence } from './ffmpeg.mjs';
import { parseSilence, spansFromSilences, speechSeconds } from './spans.mjs';
import { splitLongSpans, buildBatches, toMeetingTime } from './batches.mjs';
import { extractBatch } from './extract.mjs';
import { cleanSegments } from './cleanup.mjs';
import { buildPrompt } from './glossary.mjs';
import { createGlossaryFixer } from './glossary-fix.mjs';
import { createTimeBudget } from './time-budget.mjs';

// A batch with at least this much detected speech that comes back with NO text is treated as a failed batch (for engines that
// ask for it): a silent result from a model that was given speech is more likely a fault than a quiet meeting.
export const MIN_SPEECH_FOR_EMPTY_FAILURE = 2;

/**
 * speakers: [{ label, files: [paths in order] }]
 * engine / fallbackEngine: objects with .name and .transcribe(file, { prompt, durationSec }). Optional engine flags:
 *   retries (extra tries on a failed batch before the fallback), treatEmptyAsFailure, timeBudgeted, label (for the header).
 * budgetSec: the time budget for an engine flagged timeBudgeted; null for none. now: a clock (tests inject their own).
 * glossary: the team's glossary. It goes to the engine as a prompt (Whisper) AND is applied to the text afterwards, for every engine.
 * Returns { lines, failures, stats }. Times are seconds from the start of the recording.
 * Logs counts and engine names only, never transcript text.
 */
export async function runPipeline({ speakers, engine, fallbackEngine = null, workDir, glossary = '', log = () => {}, opts = {}, budgetSec = null, budgetOpts = {}, now = Date.now, glossaryFixer = null }) {
  const o = { noiseDb: -60, minSilence: 1.5, minSpan: 0.4, pad: 0.25, maxSpeech: 240, dryRun: false, ...opts };
  await ensureFfmpeg();
  const prompt = buildPrompt(glossary);
  const fixer = glossaryFixer ?? createGlossaryFixer(glossary);

  const lines = [];
  const failures = [];
  const stats = {
    speakers: [],
    batches: 0,
    transcribedBatches: 0,
    fallbackBatches: 0,
    failedBatches: 0,
    reroutedBatches: 0, // batches moved to the fallback because the time budget would have been exceeded
    droppedSegments: { empty: 0, noSpeech: 0, repetition: 0, phantom: 0 },
    engines: new Set(),
    labels: {},
    primaryName: engine?.name ?? null,
    fallbackName: fallbackEngine?.name ?? null,
    budget: null, // { reason, speedX, projectedMin } once the time budget moved the work
    glossaryFixes: [], // [{ from, to, t, kind }]: for the uploaded record only, never shown
    lengthSec: 0,
    speechSec: 0,
  };
  const labelOf = (e) => e.label ?? e.name;
  let primaryOff = false; // set when the main engine is unusable (key rejected, daily limit used up, or the worker keeps failing)

  // ---- 1. Find the speech in every speaker's audio first, so the total amount of work is known for the time budget. ----
  const prepared = [];
  for (const sp of speakers) {
    const wav = path.join(workDir, `${sp.label}.wav`);
    await toWav16kMono(sp.files, wav);
    const duration = await probeDuration(wav);
    const silences = parseSilence(await detectSilence(wav, { noiseDb: o.noiseDb, minSilence: o.minSilence }));
    const spans = splitLongSpans(spansFromSilences(silences, duration, { minSpan: o.minSpan, pad: o.pad }), o.maxSpeech);
    const batches = buildBatches(spans, { maxSpeech: o.maxSpeech });
    const speech = speechSeconds(spans);
    stats.lengthSec = Math.max(stats.lengthSec, duration);
    stats.speechSec += speech;
    stats.batches += batches.length;
    stats.speakers.push({ label: sp.label, speechSec: speech, batches: batches.length });
    log(`${sp.label}: ${speech.toFixed(0)} s of speech in ${batches.length} batch(es)`);
    prepared.push({ sp, wav, batches });
  }

  // ---- 2. Transcribe, one batch at a time. ----
  const budget = !o.dryRun && budgetSec && engine?.timeBudgeted ? createTimeBudget({ budgetSec, now, ...budgetOpts }) : null;
  let remainingAudioSec = prepared.reduce((n, p) => n + p.batches.reduce((m, b) => m + b.totalSeconds, 0), 0);

  /** One engine on one batch, with the engine's own retries. Throws the last error. */
  const tryEngine = async (eng, flac, batch, label) => {
    const tries = 1 + (eng.retries ?? 0);
    let last;
    for (let n = 1; n <= tries; n++) {
      try {
        const t0 = now();
        const segs = await eng.transcribe(flac, { prompt, durationSec: batch.totalSeconds });
        if (eng.treatEmptyAsFailure && segs.length === 0 && batch.speechSeconds >= MIN_SPEECH_FOR_EMPTY_FAILURE) {
          throw Object.assign(new Error('no text although speech was detected'), { kind: 'empty' });
        }
        return { segs, wallSec: (now() - t0) / 1000 };
      } catch (e) {
        last = e;
        log(`${label}: ${eng.name} failed (${e.kind || 'error'})${n < tries ? ', trying once more' : ''}`);
        if (e.kind === 'auth' || e.kind === 'rate_limit_exhausted') break; // trying again will not help
      }
    }
    throw last;
  };

  for (const { sp, wav, batches } of prepared) {
    if (!o.dryRun) {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const flac = path.join(workDir, `${sp.label}-b${i}.flac`);
        await extractBatch(wav, batch, flac);
        const label = `${sp.label} batch ${i + 1}`;

        let segments = null;
        let used = null;

        // Time budget: once the projection says the main engine cannot finish in time, everything left goes to the fallback.
        let rerouted = false;
        if (budget && !primaryOff && budget.shouldFallBack(remainingAudioSec)) {
          const d = budget.decision;
          if (!stats.budget) {
            stats.budget = { reason: d.reason, speedX: d.speed ? Math.round(d.speed * 10) / 10 : null, projectedMin: Math.round(d.projectedSec / 60) };
            log(`time budget: ${d.reason} (${stats.budget.speedX ?? '?'}x real time, about ${stats.budget.projectedMin} min projected); the rest goes to ${fallbackEngine ? fallbackEngine.name : 'nobody (no fallback)'}`);
          }
          rerouted = Boolean(fallbackEngine);
        }

        if (!primaryOff && !rerouted) {
          try {
            const r = await tryEngine(engine, flac, batch, label);
            segments = r.segs;
            used = engine;
            if (budget) budget.record(batch.totalSeconds, r.wallSec);
          } catch (e) {
            if (e.kind === 'auth' || e.kind === 'rate_limit_exhausted') primaryOff = true;
          }
        }
        if (!segments && fallbackEngine) {
          try {
            segments = (await tryEngine(fallbackEngine, flac, batch, label)).segs;
            used = fallbackEngine;
            stats.fallbackBatches++;
            if (rerouted) stats.reroutedBatches++;
          } catch {
            log(`${label}: backup engine failed`);
          }
        }

        if (!segments) {
          stats.failedBatches++;
          failures.push({ speaker: sp.label, start: batch.items[0].origStart, end: batch.items[batch.items.length - 1].origEnd });
        } else {
          stats.transcribedBatches++;
          stats.engines.add(used.name);
          stats.labels[used.name] = labelOf(used);
          const { kept, dropped } = cleanSegments(segments);
          for (const k of Object.keys(dropped)) stats.droppedSegments[k] += dropped[k];
          for (const s of kept) {
            const start = toMeetingTime(batch, s.start);
            const end = Math.max(start, toMeetingTime(batch, s.end));
            const fixed = fixer.fix(s.text, { t: start });
            for (const c of fixed.changes) stats.glossaryFixes.push(c);
            lines.push({ speaker: sp.label, start, end, text: fixed.text });
          }
        }
        remainingAudioSec -= batch.totalSeconds;
        await rm(flac, { force: true });
        log(`${sp.label}: batch ${i + 1}/${batches.length} done`);
      }
    }
    await rm(wav, { force: true });
  }
  if (stats.glossaryFixes.length) log(`glossary: ${stats.glossaryFixes.length} correction(s) made`); // the count only
  return { lines, failures, stats };
}
