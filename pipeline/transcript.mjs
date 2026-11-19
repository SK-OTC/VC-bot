// Merging every speaker's lines into one readable transcript.

export function hhmmss(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** label -> display name. Two people with the same name become "Sam" and "Sam (2)". */
export function displayNames(speakers) {
  const seen = new Map();
  const out = {};
  for (const s of speakers) {
    const base = (s.name || s.label).replace(/\s+/g, ' ').trim() || s.label;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out[s.label] = n === 1 ? base : `${base} (${n})`;
  }
  return out;
}

/** Sort by start time; join a person's neighbouring segments when the pause between them is short. */
export function mergeLines(lines, { joinGap = 2 } = {}) {
  const sorted = [...lines].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev && !prev.gap && !l.gap && prev.speaker === l.speaker && l.start - prev.end < joinGap) {
      prev.end = Math.max(prev.end, l.end);
      prev.text = `${prev.text} ${l.text}`;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

export function buildHeader({ startedAt, lengthSec, speakers, names, engines, fallbackBatches = 0, failedBatches = 0 }) {
  const when = startedAt ? new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time';
  const who = speakers.map((s) => `${names[s.label]} (${mmss(s.speechSec)} speaking)`).join(', ') || 'nobody detected';
  const engine = [...engines].join(', ') || 'none';
  const lines = [
    'MEETING TRANSCRIPT',
    `Recorded: ${when}, length ${hhmmss(lengthSec)}`,
    `Speakers: ${who}`,
    `Transcribed with: ${engine}${fallbackBatches ? ` (backup engine used for ${fallbackBatches} part(s))` : ''}`,
  ];
  if (failedBatches) lines.push(`WARNING: ${failedBatches} part(s) could not be transcribed. They are marked in the text.`);
  lines.push(
    'Notes: Automatic transcript. Names are Discord names. Errors are likely. Overlapping speech may appear interleaved.',
    'Times are measured from the start of the meeting.',
    '',
  );
  return lines.join('\n');
}

export function formatTranscript({ lines, failures = [], names, offsetSec = 0, header }) {
  const all = [
    ...lines.map((l) => ({ ...l })),
    ...failures.map((f) => ({ speaker: f.speaker, start: f.start, end: f.end, gap: true, text: `[audio from ${hhmmss(Math.max(0, f.start - offsetSec))} to ${hhmmss(Math.max(0, f.end - offsetSec))} could not be transcribed]` })),
  ];
  const merged = mergeLines(all);
  const body = merged.map((l) => `[${hhmmss(Math.max(0, l.start - offsetSec))}] ${names[l.speaker] ?? l.speaker}: ${l.text}`).join('\n');
  return `${header}${body}\n`;
}
