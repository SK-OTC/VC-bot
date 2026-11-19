// The whole audio-to-transcript pipeline for one meeting.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureFfmpeg, toWav16kMono, probeDuration, detectSilence } from './ffmpeg.mjs';
import { parseSilence, spansFromSilences, speechSeconds } from './spans.mjs';
import { splitLongSpans, buildBatches, toMeetingTime } from './batches.mjs';
import { extractBatch } from './extract.mjs';
import { cleanSegments } from './cleanup.mjs';
import { buildPrompt } from './glossary.mjs';

/**
 * speakers: [{ label, files: [paths in order] }]
 * engine / fallbackEngine: objects with .name and .transcribe(file, { prompt, durationSec })
 * Returns { lines, failures, stats }. Times are seconds from the start of the recording.
 */
export async function runPipeline({ speakers, engine, fallbackEngine = null, workDir, glossary = '', log = () => {}, opts = {} }) {
  const o = { noiseDb: -60, minSilence: 1.5, minSpan: 0.4, pad: 0.25, maxSpeech: 240, dryRun: false, ...opts };
  await ensureFfmpeg();
  const prompt = buildPrompt(glossary);

  const lines = [];
  const failures = [];
  const stats = {
    speakers: [],
    batches: 0,
    transcribedBatches: 0,
    fallbackBatches: 0,
    failedBatches: 0,
    droppedSegments: { empty: 0, noSpeech: 0, repetition: 0, phantom: 0 },
    engines: new Set(),
    lengthSec: 0,
    speechSec: 0,
  };
  let primaryOff = false; // set when the main engine is unusable (key rejected or daily limit used up)

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

    if (!o.dryRun) {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const flac = path.join(workDir, `${sp.label}-b${i}.flac`);
        await extractBatch(wav, batch, flac);

        let segments = null;
        let used = null;
        const attempt = async (eng) => eng.transcribe(flac, { prompt, durationSec: batch.totalSeconds });

        if (!primaryOff) {
          try {
            segments = await attempt(engine);
            used = engine;
          } catch (e) {
            log(`${sp.label} batch ${i + 1}: ${engine.name} failed (${e.kind || 'error'})`);
            if (e.kind === 'auth' || e.kind === 'rate_limit_exhausted') primaryOff = true;
          }
        }
        if (!segments && fallbackEngine) {
          try {
            segments = await attempt(fallbackEngine);
            used = fallbackEngine;
            stats.fallbackBatches++;
          } catch (e) {
            log(`${sp.label} batch ${i + 1}: backup engine failed (${e.kind || 'error'})`);
          }
        }

        if (!segments) {
          stats.failedBatches++;
          failures.push({ speaker: sp.label, start: batch.items[0].origStart, end: batch.items[batch.items.length - 1].origEnd });
        } else {
          stats.transcribedBatches++;
          stats.engines.add(used.name);
          const { kept, dropped } = cleanSegments(segments);
          for (const k of Object.keys(dropped)) stats.droppedSegments[k] += dropped[k];
          for (const s of kept) {
            const start = toMeetingTime(batch, s.start);
            const end = Math.max(start, toMeetingTime(batch, s.end));
            lines.push({ speaker: sp.label, start, end, text: s.text });
          }
        }
        await rm(flac, { force: true });
        log(`${sp.label}: batch ${i + 1}/${batches.length} done`);
      }
    }
    await rm(wav, { force: true });
  }
  return { lines, failures, stats };
}
