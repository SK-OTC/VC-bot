// Packing speech spans into batches for the transcription service, and mapping times back.

export const GAP = 0.4; // seconds of silence between spans inside a batch

/** A span longer than maxLen is cut into equal pieces no longer than maxLen. */
export function splitLongSpans(spans, maxLen = 240) {
  const out = [];
  for (const s of spans) {
    const len = s.end - s.start;
    if (len <= maxLen) {
      out.push({ ...s });
      continue;
    }
    const n = Math.ceil(len / maxLen);
    const piece = len / n;
    for (let i = 0; i < n; i++) out.push({ start: s.start + i * piece, end: i === n - 1 ? s.end : s.start + (i + 1) * piece });
  }
  return out;
}

/**
 * Packs spans (in order) into batches of up to maxSpeech seconds of speech.
 * Each item remembers where it sits inside the batch (batchStart) and where it came from (origStart).
 */
export function buildBatches(spans, { maxSpeech = 240, gap = GAP } = {}) {
  const batches = [];
  let cur = null;
  for (const sp of spans) {
    const len = sp.end - sp.start;
    if (!cur || (cur.speech + len > maxSpeech && cur.items.length > 0)) {
      cur = { items: [], speech: 0, cursor: 0 };
      batches.push(cur);
    }
    cur.items.push({ origStart: sp.start, origEnd: sp.end, len, batchStart: cur.cursor });
    cur.cursor += len + gap;
    cur.speech += len;
  }
  return batches.map((b) => ({ items: b.items, speechSeconds: b.speech, totalSeconds: b.cursor }));
}

/** Converts a time inside a batch back to a time in the meeting. Times in a gap snap to the end of the span before it. */
export function toMeetingTime(batch, t) {
  const items = batch.items;
  let idx = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].batchStart <= t) idx = i;
    else break;
  }
  const it = items[idx];
  const offset = Math.min(Math.max(t - it.batchStart, 0), it.len);
  return it.origStart + offset;
}
