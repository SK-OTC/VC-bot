// Turning "where is the silence" into "where did this person speak".

/** Parses ffmpeg's silencedetect output into [{start, end|null}] (end is null if the file ends in silence). */
export function parseSilence(stderr) {
  const out = [];
  let open = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) {
      open = Math.max(0, Number(m[1]));
      continue;
    }
    m = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (m && open !== null) {
      out.push({ start: open, end: Number(m[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: null });
  return out;
}

/**
 * Speech = everything that is not silence. Very short blips are dropped, and each span is widened a
 * little (never into its neighbour) so the first and last word are not clipped.
 */
export function spansFromSilences(silences, duration, { minSpan = 0.4, pad = 0.25 } = {}) {
  const raw = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor + 1e-6) raw.push({ start: cursor, end: Math.min(s.start, duration) });
    cursor = s.end ?? duration;
  }
  if (cursor < duration - 1e-6) raw.push({ start: cursor, end: duration });

  const kept = raw.filter((sp) => sp.end - sp.start >= minSpan);
  const out = [];
  let prevEnd = 0;
  kept.forEach((sp, i) => {
    const start = Math.max(sp.start - pad, prevEnd, 0);
    const nextStart = kept[i + 1] ? kept[i + 1].start : duration;
    const end = Math.min(sp.end + pad, nextStart, duration);
    out.push({ start, end });
    prevEnd = end;
  });
  return out;
}

export function speechSeconds(spans) {
  return spans.reduce((n, s) => n + (s.end - s.start), 0);
}
