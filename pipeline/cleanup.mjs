// Removing text a speech model invents on silence or noise. The thresholds are Whisper's own defaults and are only
// a starting point: tune them on your real recordings.
//
// Engines that give no quality fields (Parakeet has no no_speech_prob, avg_logprob or compression_ratio) simply pass the
// checks that need those fields, because a missing number is never "over the limit". The repeated-phrase check still works for
// them: when compression_ratio is missing it is worked out from the text itself, the way Whisper does it (text size divided
// by its zlib-compressed size), so "the the the the ..." and other loops are still dropped.
import { deflateSync } from 'node:zlib';

const MIN_CHARS_FOR_TEXT_RATIO = 30; // very short text compresses badly (a header and a checksum), so it is never judged

/** Whisper's compression ratio, from the text: bytes / zlib-compressed bytes. High means the text repeats itself. */
export function textCompressionRatio(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  if (bytes.length < MIN_CHARS_FOR_TEXT_RATIO) return 0;
  return bytes.length / deflateSync(bytes).length;
}

const PHANTOM = [/^thanks? for watching[.!]?$/i, /^thank you for watching[.!]?$/i, /^subtitles? by\b.*$/i, /^please subscribe\b.*$/i, /^you[.!]?$/i];

export function cleanSegments(segments, overrides = {}) {
  const t = { noSpeech: 0.6, logprob: -1.0, compression: 2.4, phantomMaxSec: 5, ...overrides };
  const kept = [];
  const dropped = { empty: 0, noSpeech: 0, repetition: 0, phantom: 0 };
  for (const s of segments) {
    const text = String(s.text ?? '').trim();
    if (!text) {
      dropped.empty++;
      continue;
    }
    if (s.no_speech_prob > t.noSpeech && s.avg_logprob < t.logprob) {
      dropped.noSpeech++;
      continue;
    }
    const ratio = Number.isFinite(s.compression_ratio) ? s.compression_ratio : textCompressionRatio(text);
    if (ratio > t.compression) {
      dropped.repetition++;
      continue;
    }
    const short = s.end - s.start <= t.phantomMaxSec;
    const unsure = s.avg_logprob < -0.5 || s.no_speech_prob > 0.3;
    if (short && unsure && PHANTOM.some((re) => re.test(text))) {
      dropped.phantom++;
      continue;
    }
    kept.push({ ...s, text });
  }
  return { kept, dropped };
}
