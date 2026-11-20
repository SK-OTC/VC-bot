import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_SEC, tokensToSegments, tokensToWords, wordsToSegments } from '../pipeline/parakeet-segments.mjs';
import { toMeetingTime } from '../pipeline/batches.mjs';

// A helper: one word per 0.4 s starting at `t0`, as [token, time] pairs with the leading-space word marker.
const say = (text, t0, step = 0.4) => text.split(' ').map((w, i) => [` ${w}`, +(t0 + i * step).toFixed(2)]);

test('tokens -> words: a leading space (or the SentencePiece mark) starts a word, other tokens continue it', () => {
  const tokens = [[' So', 2.08], [' we', 2.32], ["'", 2.48], ['re', 2.56], [' test', 2.72], ['ing', 2.96], [' this', 3.2]];
  const words = tokensToWords(tokens);
  assert.deepEqual(words.map((w) => w.text), ['So', "we're", 'testing', 'this']);
  assert.deepEqual(words.map((w) => w.start), [2.08, 2.32, 2.72, 3.2]);
  // the end is one frame after the word's last token
  assert.ok(Math.abs(words[1].end - (2.56 + FRAME_SEC)) < 1e-9);
  assert.ok(Math.abs(words[2].end - (2.96 + FRAME_SEC)) < 1e-9);
  assert.deepEqual(tokensToWords([['▁Hello', 1], ['▁there', 1.5]]).map((w) => w.text), ['Hello', 'there']);
});

test('tokens -> words: bad input never throws', () => {
  assert.deepEqual(tokensToWords([]), []);
  assert.deepEqual(tokensToWords(null), []);
  assert.deepEqual(tokensToWords(undefined), []);
  assert.deepEqual(tokensToWords([[' a', 'x'], [5, 1], null, [' ', 1], [' b', NaN]]), []);
  // tokens out of order are put in time order
  assert.deepEqual(tokensToWords([[' two', 2], [' one', 1]]).map((w) => w.text), ['one', 'two']);
  // a first token without a leading space still starts a word
  assert.deepEqual(tokensToWords([['hello', 0], [' world', 0.5]]).map((w) => w.text), ['hello', 'world']);
});

test('segments: an empty batch gives no segments', () => {
  assert.deepEqual(tokensToSegments([]), []);
  assert.deepEqual(wordsToSegments([]), []);
});

test('segments: start is the first word\'s start and end is the last word\'s end', () => {
  const segs = tokensToSegments(say('hello there everyone', 5));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].start, 5);
  assert.ok(Math.abs(segs[0].end - (5.8 + FRAME_SEC)) < 1e-9);
  assert.equal(segs[0].text, 'hello there everyone');
});

test('segments: a gap of more than 0.6 s splits; exactly 0.6 s does not', () => {
  // word 1 ends at 0.08; word 2 starts at 0.08 + gap
  const make = (gap) => tokensToSegments([[' one', 0], [' two', 0.08 + gap]]);
  assert.equal(make(0.6).length, 1);
  assert.equal(make(0.61).length, 2);
  assert.equal(make(2).length, 2);
  const segs = tokensToSegments([...say('first part here', 0), ...say('second part here', 10)]);
  assert.deepEqual(segs.map((s) => s.text), ['first part here', 'second part here']);
  assert.equal(segs[1].start, 10);
});

test('segments: a sentence end only splits once the segment is at least 3 s long', () => {
  // 6 words at 0.4 s = about 2.1 s: the full stop does NOT split yet
  const short = tokensToSegments([...say('this is a short one.', 0), ...say('and it goes on', 2.1)]);
  assert.equal(short.length, 1);
  // 10 words at 0.4 s = about 3.7 s: the full stop splits
  const long = tokensToSegments([...say('this sentence is long enough to be closed here.', 0), ...say('then a new sentence starts', 3.7)]);
  assert.equal(long.length, 2);
  assert.match(long[0].text, /here\.$/);
  assert.match(long[1].text, /^then a new/);
  for (const mark of ['!', '?']) {
    const s = tokensToSegments([...say(`this sentence is long enough to be closed here${mark}`, 0), ...say('next', 3.7)]);
    assert.equal(s.length, 2, `a "${mark}" ends a sentence`);
  }
  // an abbreviation-like mid-sentence full stop is only a split when the length allows; a comma never splits
  const comma = tokensToSegments([...say('this sentence is long enough to be closed here,', 0), ...say('then it carries on', 3.7)]);
  assert.equal(comma.length, 1);
});

test('segments: never longer than 15 s, even for one endless run with no pauses or full stops', () => {
  const words = say(Array.from({ length: 120 }, (_, i) => `w${i}`).join(' '), 0, 0.3); // 36 s of continuous speech
  const segs = tokensToSegments(words);
  assert.ok(segs.length >= 3);
  for (const s of segs) assert.ok(s.end - s.start <= 15 + 1e-9, `segment of ${s.end - s.start} s`);
  // nothing is lost or reordered
  assert.equal(segs.map((s) => s.text).join(' ').split(' ').length, 120);
  assert.deepEqual(segs.map((s) => s.start), [...segs.map((s) => s.start)].sort((a, b) => a - b));
  // a segment that would reach 15 s exactly still fits
  const exact = wordsToSegments([{ text: 'a', start: 0, end: 7 }, { text: 'b', start: 7.1, end: 15 }]);
  assert.equal(exact.length, 1);
  const over = wordsToSegments([{ text: 'a', start: 0, end: 7 }, { text: 'b', start: 7.1, end: 15.01 }]);
  assert.equal(over.length, 2);
});

test('segments: times stay relative to the batch, and the existing time mapping puts them in meeting time', () => {
  // a batch of two spans: [100 s .. 110 s] then [300 s .. 305 s] with a 0.4 s gap between them inside the batch
  const batch = { items: [{ origStart: 100, origEnd: 110, len: 10, batchStart: 0 }, { origStart: 300, origEnd: 305, len: 5, batchStart: 10.4 }], speechSeconds: 15, totalSeconds: 15.8 };
  const segs = tokensToSegments([...say('first span words', 2), ...say('second span words', 11)]);
  assert.equal(segs.length, 2);
  assert.equal(toMeetingTime(batch, segs[0].start), 102); // 2 s into the first span
  assert.ok(Math.abs(toMeetingTime(batch, segs[1].start) - 300.6) < 1e-9); // 0.6 s into the second span
});

test('segments: the output has only start, end and text, so the cleanup stage treats the missing quality fields as a pass', () => {
  const [seg] = tokensToSegments(say('hello world', 1));
  assert.deepEqual(Object.keys(seg).sort(), ['end', 'start', 'text']);
});
