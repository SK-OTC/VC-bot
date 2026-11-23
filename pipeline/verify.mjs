// Checks the model's next steps (and, in notes written before 2026-11-23, decisions and action items) against the
// transcript, without another model call. For each item in the Next steps, Action items and Decisions sections:
//   1. read its timestamp and find the transcript lines within 30 seconds of it;
//   2. check that at least two non-trivial words from the item appear in the lines within 60 seconds.
// If either check fails the item is KEPT and "(unverified)" is added to the end of its line. Nothing is ever deleted.
// The prompt asks for exactly [hh:mm:ss], but models also write [mm:ss] and ranges such as [00:24:06-00:24:30]; those are read
// too (a range by its start), so a correct item is not marked unverified for its timestamp's format.

const TS_TAIL = '(?:\\s*[-‐‑‒–—]\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?\\]';
const TS = new RegExp(`\\[(\\d{1,2}):(\\d{2})(?::(\\d{2}))?${TS_TAIL}`);
const TS_ALL = new RegExp(`\\[\\d{1,2}:\\d{2}(?::\\d{2})?${TS_TAIL}`, 'g');
const CHECKED_SECTIONS = new Set(['next steps', 'action items', 'decisions']);
const LINE = /^\[(\d{1,2}):(\d{2}):(\d{2})\]\s*([^:\n]{1,80}?):\s*(.*)$/;
export const NEAR_SEC = 30; // lines this close to the timestamp must exist
export const WINDOW_SEC = 60; // the item's words must appear in lines this close
export const UNVERIFIED = '(unverified)';

const STOP = new Set(
  'that this with from have will would could should there their them they then than what when where which while about after before into over under also just been being were your yours need needs want wants make made take takes done does doing going gonna some more most much many very only same other another each every still next last first then here task item items unassigned none recorded owner'.split(' '),
);

// Words that may count towards a match but cannot be the only evidence: dates and generic work words. "Complete the
// rotation task by Friday" must not pass just because "complete" and "Friday" were said nearby.
const GENERIC = new Set(
  'today tomorrow tonight week weekend monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december complete completed finish finished start started work working update updates meeting meetings discuss check review send share talk follow team'.split(' ').map((w) => stem(w)),
);

// Short words that are too common to count as evidence even when written in capitals ("Add", "Fix", "THE").
const SHORT_STOP = new Set('the and for but not all any can may get set use put let see ask add fix run new old one two out own via per its our who how why yes'.split(' '));

const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);
// A spoken line lasts until the next line starts, but no longer than its words take to say (about 2.5 a second, at least
// 5 seconds): a two-minute explanation that starts at 00:24:06 still covers 00:24:38, while a short remark followed by a
// silence does not stretch over the silence.
const WORDS_PER_SEC = 2.5;

/** [{ t, end, speaker, text }] for every "[hh:mm:ss] Name: text" line. */
export function parseTranscriptLines(body) {
  const out = [];
  for (const raw of String(body ?? '').split('\n')) {
    const m = LINE.exec(raw.trim());
    if (m) out.push({ t: seconds(m[1], m[2], m[3]), speaker: m[4].trim(), text: m[5] });
  }
  for (let i = 0; i < out.length; i++) {
    const said = out[i].t + Math.max(5, out[i].text.split(/\s+/).filter(Boolean).length / WORDS_PER_SEC);
    const next = out.slice(i + 1).find((l) => l.t > out[i].t)?.t ?? Infinity;
    out[i].end = Math.min(said, next);
  }
  return out;
}

/** Seconds from a timestamp to a line: 0 while the line is being said. */
const distance = (ts, l) => (ts < l.t ? l.t - ts : ts > l.end ? ts - l.end : 0);

const normWords = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * A light stem so word forms match: "tests"/"testing", "completed"/"complete", "planned"/"plan", "rotation"/"rotate".
 * Strips one ending (-ies, -ing, -ions, -ion, -ed, -s), then a final "e" and a doubled last letter, keeping at least
 * 3 letters, and compares at most the first 6 letters.
 */
export function stem(word) {
  let w = String(word).toLowerCase();
  if (w.length <= 3) return w;
  const cut = (n) => (w.length - n >= 3 ? w.slice(0, -n) : w);
  if (w.endsWith('ies')) w = w.length - 3 >= 3 ? `${w.slice(0, -3)}y` : w;
  else if (w.endsWith('ing')) w = cut(3);
  else if (w.endsWith('ions')) w = cut(4);
  else if (w.endsWith('ion')) w = cut(3);
  else if (w.endsWith('ed')) w = cut(2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = cut(1);
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  if (w.length > 3 && w.at(-1) === w.at(-2) && !/[aeiou]/.test(w.at(-1))) w = w.slice(0, -1);
  return w.slice(0, 6);
}

/**
 * The words of an item that are worth checking, without the owner's name or the timestamps: words of 4+ letters that
 * are not filler, plus short words that are clearly names or acronyms (written "Raj" or "PR", "FPS"), which carry meaning.
 */
export function itemWords(line) {
  let text = line.replace(/^\s*[-*•]\s*/, '').replace(TS_ALL, ' ');
  const colon = text.indexOf(':');
  if (colon > 0 && colon <= 40) text = text.slice(colon + 1); // drop "Owner:"
  const out = [];
  for (const raw of String(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    const w = raw.toLowerCase();
    if (/^\d+$/.test(w)) continue;
    const named = (/^\p{Lu}{2,3}$/u.test(raw) || /^\p{Lu}\p{Ll}{2}$/u.test(raw)) && !SHORT_STOP.has(w); // "PR", "FPS", "Raj"
    if ((w.length >= 4 && !STOP.has(w)) || named) out.push(w);
  }
  return [...new Set(out)];
}

function checkItem(line, lines) {
  const m = TS.exec(line);
  if (!m) return false; // no timestamp, so it cannot be located in the transcript
  const ts = m[3] === undefined ? seconds(0, m[1], m[2]) : seconds(m[1], m[2], m[3]); // [mm:ss] or [hh:mm:ss]
  if (!lines.some((l) => distance(ts, l) <= NEAR_SEC)) return false; // check 1: something was being said near the timestamp
  const words = itemWords(line);
  if (!words.length) return false; // nothing left to compare
  const near = new Set(lines.filter((l) => distance(ts, l) <= WINDOW_SEC).flatMap((l) => normWords(l.text).map(stem)));
  const found = words.filter((w) => near.has(stem(w)));
  // check 2: at least two of the item's words (or all, if it has only one), and at least one of them specific
  return found.length >= Math.min(2, words.length) && found.some((w) => !GENERIC.has(stem(w)));
}

// "**Next steps**", "**Next steps**:" or "## Next steps"
const HEADING = /^(?:\*\*(.+?)\*\*:?|#{1,4}\s+(.+?))\s*$/;
const BULLET = /^\s*[-*•]\s+/;
// "- None recorded", and also "- Unassigned: none recorded"
const NOTHING = /^\s*[-*•]?\s*(?:[^:\n]{1,40}:\s*)?(none( recorded)?\.?|n\/a|nothing)\s*$/i;

/**
 * summaryText: the model's notes. Returns { text, checked, flagged }: the same text with " (unverified)" added to items
 * that failed, how many items were checked, and how many failed.
 */
export function verifySummary({ summaryText, transcriptBody }) {
  const lines = parseTranscriptLines(transcriptBody);
  let section = '';
  let checked = 0;
  let flagged = 0;
  const out = String(summaryText ?? '')
    .split('\n')
    .map((raw) => {
      const h = HEADING.exec(raw.trim());
      if (h) {
        section = (h[1] ?? h[2]).trim().replace(/:$/, '').toLowerCase();
        return raw;
      }
      if (!CHECKED_SECTIONS.has(section) || !BULLET.test(raw) || NOTHING.test(raw)) return raw;
      checked++;
      if (raw.includes(UNVERIFIED) || checkItem(raw, lines)) return raw;
      flagged++;
      return `${raw.trimEnd()} ${UNVERIFIED}`;
    })
    .join('\n');
  return { text: out, checked, flagged };
}
