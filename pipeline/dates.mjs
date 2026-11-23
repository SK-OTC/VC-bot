// Dates in the summary, worked out in code because models get date arithmetic wrong.
// 1. dateTable: the meeting day and the next seven days, given to the model so it copies dates instead of computing them.
// 2. fixWeekdayDates: a model still writes "Friday 28 November" when that Friday is the 27th. A weekday is what people say
//    out loud ("by Friday"), so the weekday is trusted and the day number is corrected to the nearest date with that weekday.
// All dates are UTC days: the recorder does not know the team's time zone.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86_400_000;

/** Midnight UTC of the day the meeting started (startedAt: anything Date accepts), or null. */
export function meetingDay(startedAt) {
  const t = new Date(startedAt ?? NaN).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const fmt = (d) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** "today = Monday 23 November; tomorrow = Tuesday 24 November; Wednesday 25 November; ..." (8 days), or '' without a date. */
export function dateTable(startedAt) {
  const day = meetingDay(startedAt);
  if (!day) return '';
  const out = [`today = ${fmt(day)}`];
  for (let i = 1; i <= 7; i++) out.push(`${i === 1 ? 'tomorrow = ' : ''}${fmt(new Date(day.getTime() + i * DAY_MS))}`);
  return out.join('; ');
}

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'));
const W = WEEKDAYS.join('|');
const M = MONTHS.join('|');
// "Friday 27 November", "Friday, 27th November 2026" and "Friday, November 27th, 2026"
const DAY_FIRST = new RegExp(`\\b(${W})(,?\\s+)(\\d{1,2})(st|nd|rd|th)?(\\s+)(${M})((?:,?\\s+)\\d{4})?\\b`, 'g');
const MONTH_FIRST = new RegExp(`\\b(${W})(,?\\s+)(${M})(\\s+)(\\d{1,2})(st|nd|rd|th)?((?:,?\\s+)\\d{4})?\\b`, 'g');

/** The date the model meant: its weekday is trusted, and the nearest day (within 3) with that weekday is chosen. */
function correct(weekday, dayNum, monthIdx, yearText, ref) {
  let year = yearText ? Number(yearText.replace(/\D/g, '')) : ref.getUTCFullYear();
  let written = new Date(Date.UTC(year, monthIdx, dayNum));
  if (written.getUTCMonth() !== monthIdx) return null; // "31 November": not a real date, leave it alone
  if (!yearText && written.getTime() < ref.getTime() - 180 * DAY_MS) {
    year += 1; // a December meeting talking about "Monday 4 January"
    written = new Date(Date.UTC(year, monthIdx, dayNum));
  }
  const want = WEEKDAYS.indexOf(weekday);
  if (written.getUTCDay() === want) return null; // already consistent
  for (const delta of [-1, 1, -2, 2, -3, 3]) {
    const d = new Date(written.getTime() + delta * DAY_MS);
    if (d.getUTCDay() === want) return d;
  }
  return null;
}

/**
 * Corrects every "weekday + date" whose weekday and date disagree. Returns { text, fixed } (fixed = how many were corrected).
 * Without a meeting date (or a valid year) nothing changes.
 */
export function fixWeekdayDates(text, startedAt) {
  const ref = meetingDay(startedAt);
  const src = String(text ?? '');
  if (!ref) return { text: src, fixed: 0 };
  let fixed = 0;
  const year = (y, d) => (y ? y.replace(/\d{4}/, String(d.getUTCFullYear())) : '');
  let out = src.replace(DAY_FIRST, (all, wd, sep, num, suf, sp, month, y) => {
    const d = correct(wd, Number(num), MONTHS.indexOf(month), y, ref);
    if (!d) return all;
    fixed++;
    return `${wd}${sep}${d.getUTCDate()}${suf ? ordinal(d.getUTCDate()) : ''}${sp}${MONTHS[d.getUTCMonth()]}${year(y, d)}`;
  });
  out = out.replace(MONTH_FIRST, (all, wd, sep, month, sp, num, suf, y) => {
    const d = correct(wd, Number(num), MONTHS.indexOf(month), y, ref);
    if (!d) return all;
    fixed++;
    return `${wd}${sep}${MONTHS[d.getUTCMonth()]}${sp}${d.getUTCDate()}${suf ? ordinal(d.getUTCDate()) : ''}${year(y, d)}`;
  });
  return { text: out, fixed };
}
