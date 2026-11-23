import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTable, fixWeekdayDates, meetingDay } from '../pipeline/dates.mjs';

const MON_23_NOV = '2026-11-23T17:04:00Z';

test('meetingDay and dateTable: the UTC day and the next seven days, worked out in code', () => {
  assert.equal(meetingDay(MON_23_NOV).toISOString(), '2026-11-23T00:00:00.000Z');
  assert.equal(meetingDay(Date.UTC(2026, 10, 23, 23, 59)).toISOString(), '2026-11-23T00:00:00.000Z');
  assert.equal(meetingDay('nonsense'), null);
  assert.equal(meetingDay(null), null);
  assert.equal(
    dateTable(MON_23_NOV),
    'today = Monday 23 November; tomorrow = Tuesday 24 November; Wednesday 25 November; Thursday 26 November; Friday 27 November; Saturday 28 November; Sunday 29 November; Monday 30 November',
  );
  assert.match(dateTable('2026-12-29T10:00:00Z'), /Thursday 31 December; Friday 1 January; Saturday 2 January; Sunday 3 January; Monday 4 January; Tuesday 5 January$/);
  assert.equal(dateTable(undefined), '');
});

test('fixWeekdayDates: the weekday is trusted and the day corrected (the real mistake: "Friday 28 November" for the 27th)', () => {
  const r = fixWeekdayDates('- Omar: audio mixing by Friday 28 November [00:32:22]\n- Rotation by Thursday 27 November', MON_23_NOV);
  assert.equal(r.text, '- Omar: audio mixing by Friday 27 November [00:32:22]\n- Rotation by Thursday 26 November');
  assert.equal(r.fixed, 2);
});

test('fixWeekdayDates: correct dates, other formats, ordinals, years and month boundaries', () => {
  const ok = 'Next sync Wednesday 25 November; due Friday 27 November';
  assert.deepEqual(fixWeekdayDates(ok, MON_23_NOV), { text: ok, fixed: 0 });
  assert.equal(fixWeekdayDates('Friday, 28th November 2026', MON_23_NOV).text, 'Friday, 27th November 2026');
  assert.equal(fixWeekdayDates('Friday, November 28th, 2026', MON_23_NOV).text, 'Friday, November 27th, 2026');
  assert.equal(fixWeekdayDates('by Tuesday 2 December', MON_23_NOV).text, 'by Tuesday 1 December');
  assert.equal(fixWeekdayDates('Monday 1 December', MON_23_NOV).text, 'Monday 30 November', 'across a month boundary');
  assert.equal(fixWeekdayDates('Sunday 1st December', MON_23_NOV).text, 'Sunday 29th November');
  assert.equal(fixWeekdayDates('kick-off Monday 4 January', '2026-12-29T10:00:00Z').text, 'kick-off Monday 4 January', 'January after a December meeting is next year (Monday 4 January 2027)');
  assert.equal(fixWeekdayDates('kick-off Monday 5 January', '2026-12-29T10:00:00Z').text, 'kick-off Monday 4 January');
});

test('fixWeekdayDates: leaves alone what it cannot be sure of', () => {
  for (const s of ['Friday 31 November', 'by 28 November', 'Friday the 28th', 'friday 28 november', 'Fridays 28 November']) {
    assert.equal(fixWeekdayDates(s, MON_23_NOV).text, s, s);
  }
  assert.deepEqual(fixWeekdayDates('Friday 28 November', null), { text: 'Friday 28 November', fixed: 0 }, 'no meeting date: no change');
  assert.deepEqual(fixWeekdayDates(undefined, MON_23_NOV), { text: '', fixed: 0 });
});
