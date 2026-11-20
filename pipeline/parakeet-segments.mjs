// From Parakeet's output to the segments the rest of the pipeline expects.
// Parakeet TDT returns TOKENS with the time each one STARTS (a multiple of 0.08 s: one encoder frame). It gives no
// word boundaries, no end times and none of Whisper's quality fields (no_speech_prob, avg_logprob, compression_ratio).
//   1. tokens -> words: a token that starts with a space (or the SentencePiece mark "▁") begins a new word;
//      the others continue the current word.
//   2. words -> segments: consecutive words are grouped until a gap of more than 0.6 s, a sentence end once the
//      segment is at least 3 s long, or 15 s. Start = first word's start, end = last word's end.
// All times are relative to the batch file; the pipeline's existing time mapping turns them into meeting time.

export const FRAME_SEC = 0.08; // one TDT frame: the only information about how long a token lasts
export const GAP_SEC = 0.6;
export const SENTENCE_MIN_SEC = 3;
export const MAX_SEGMENT_SEC = 15;

const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/** tokens: [[text, startSec], ...] -> [{ text, start, end }]. End is estimated: one frame after the word's last token. */
export function tokensToWords(tokens) {
  const words = [];
  const clean = (Array.isArray(tokens) ? tokens : [])
    .filter((t) => Array.isArray(t) && typeof t[0] === 'string' && Number.isFinite(Number(t[1])))
    .map(([text, t]) => [text, Number(t)])
    .sort((a, b) => a[1] - b[1]);
  for (const [raw, t] of clean) {
    const startsWord = /^[ ▁]/.test(raw);
    const piece = raw.replace(/^[ ▁]+/, '');
    if (!piece) continue; // a lone word marker carries no text
    if (!words.length || startsWord) {
      words.push({ text: piece, start: t, end: t + FRAME_SEC });
    } else {
      const w = words[words.length - 1];
      w.text += piece;
      w.end = Math.max(w.end, t + FRAME_SEC);
    }
  }
  return words;
}

/** words -> [{ start, end, text }] using the three break rules above. An empty list gives an empty list. */
export function wordsToSegments(words, { gapSec = GAP_SEC, sentenceMinSec = SENTENCE_MIN_SEC, maxSec = MAX_SEGMENT_SEC } = {}) {
  const segments = [];
  let cur = [];
  const close = () => {
    if (!cur.length) return;
    segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const length = prev.end - cur[0].start;
      if (w.start - prev.end > gapSec) close(); // a pause
      else if (SENTENCE_END.test(prev.text) && length >= sentenceMinSec) close(); // a finished sentence in a long enough segment
      else if (w.end - cur[0].start > maxSec) close(); // never longer than maxSec
    }
    cur.push(w);
  }
  close();
  return segments;
}

export const tokensToSegments = (tokens, opts) => wordsToSegments(tokensToWords(tokens), opts);
