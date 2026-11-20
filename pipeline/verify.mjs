// Checks the model's decisions and action items against the transcript, without another model call.
// For each item in the Decisions and Action items sections:
//   1. read its [hh:mm:ss] timestamp and find the transcript lines within 30 seconds of it;
//   2. check that at least two non-trivial words from the item appear in the lines within 60 seconds.
// If either check fails the item is KEPT and "(unverified)" is added to the end of its line. Nothing is ever deleted.

const TS = /\[(\d{1,2}):(\d{2}):(\d{2})\]/;
const TS_ALL = /\[\d{1,2}:\d{2}:\d{2}\]/g;
const LINE = /^\[(\d{1,2}):(\d{2}):(\d{2})\]\s*([^:\n]{1,80}?):\s*(.*)$/;
export const NEAR_SEC = 30; // lines this close to the timestamp must exist
export const WINDOW_SEC = 60; // the item's words must appear in lines this close
export const UNVERIFIED = '(unverified)';

const STOP = new Set(
  'that this with from have will would could should there their them they then than what when where which while about after before into over under also just been being were your yours need needs want wants make made take takes done does doing going gonna some more most much many very only same other another each every still next last first then here task item items unassigned none recorded owner'.split(' '),
);

const seconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** [{ t, speaker, text }] for every "[hh:mm:ss] Name: text" line. */
export function parseTranscriptLines(body) {
  const out = [];
  for (const raw of String(body ?? '').split('\n')) {
    const m = LINE.exec(raw.trim());
    if (m) out.push({ t: seconds(m[1], m[2], m[3]), speaker: m[4].trim(), text: m[5] });
  }
  return out;
}

const normWords = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Two words match when they are equal, or (for longer words) share their first five letters: "sending" matches "send". */
const stem = (w) => (w.length >= 5 ? w.slice(0, 5) : w);

/** The words of an item that are worth checking: 4+ letters, not filler, without the owner's name or the timestamps. */
export function itemWords(line) {
  let text = line.replace(/^\s*[-*•]\s*/, '').replace(TS_ALL, ' ');
  const colon = text.indexOf(':');
  if (colon > 0 && colon <= 40) text = text.slice(colon + 1); // drop "Owner:"
  return [...new Set(normWords(text).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

function checkItem(line, lines) {
  const m = TS.exec(line);
  if (!m) return false; // no timestamp, so it cannot be located in the transcript
  const ts = seconds(m[1], m[2], m[3]);
  if (!lines.some((l) => Math.abs(l.t - ts) <= NEAR_SEC)) return false; // check 1: lines exist near the timestamp
  const words = itemWords(line);
  if (!words.length) return false; // nothing left to compare
  const near = new Set(lines.filter((l) => Math.abs(l.t - ts) <= WINDOW_SEC).flatMap((l) => normWords(l.text).map(stem)));
  const found = words.filter((w) => near.has(stem(w))).length;
  return found >= Math.min(2, words.length); // check 2: at least two of the item's words (or all, if it has only one)
}

const HEADING = /^\*\*(.+?)\*\*\s*$/;
const BULLET = /^\s*[-*•]\s+/;
const NOTHING = /^\s*[-*•]?\s*(none( recorded)?\.?|n\/a|nothing)\s*$/i;

/**
 * summaryText: the model's notes in the four-heading format. Returns { text, checked, flagged }:
 * the same text with " (unverified)" added to items that failed, how many items were checked, and how many failed.
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
        section = h[1].trim().toLowerCase();
        return raw;
      }
      if ((section !== 'decisions' && section !== 'action items') || !BULLET.test(raw) || NOTHING.test(raw)) return raw;
      checked++;
      if (raw.includes(UNVERIFIED) || checkItem(raw, lines)) return raw;
      flagged++;
      return `${raw.trimEnd()} ${UNVERIFIED}`;
    })
    .join('\n');
  return { text: out, checked, flagged };
}
