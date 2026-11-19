// Removing text Whisper invents on silence or noise. The thresholds are Whisper's own defaults and are only
// a starting point: tune them on your real recordings.

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
    if (s.compression_ratio > t.compression) {
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
