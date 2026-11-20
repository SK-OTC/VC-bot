import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, verdict, logSummary, discordReport } from '../feasibility/lib.mjs';

const GOOD = { DISCORD_TOKEN: 'x', CHANNEL_ID: '123456789012345678' };

test('parseConfig: defaults', () => {
  const c = parseConfig(GOOD);
  assert.equal(c.durationSec, 60);
  assert.equal(c.readyTimeoutSec, 30);
  assert.equal(c.minPackets, 100);
  assert.equal(c.postChannelId, '');
});

test('parseConfig: blank strings fall back to defaults (GitHub passes empty inputs)', () => {
  const c = parseConfig({ ...GOOD, DURATION_SEC: '', POST_CHANNEL_ID: '', MIN_PACKETS: '  ' });
  assert.equal(c.durationSec, 60);
  assert.equal(c.minPackets, 100);
});

test('parseConfig: lists every problem at once', () => {
  assert.throws(
    () => parseConfig({ CHANNEL_ID: 'abc', DURATION_SEC: '5', POST_CHANNEL_ID: '12' }),
    (e) =>
      e.message.includes('DISCORD_TOKEN') &&
      e.message.includes('CHANNEL_ID') &&
      e.message.includes('DURATION_SEC') &&
      e.message.includes('POST_CHANNEL_ID'),
  );
});

test('parseConfig: rejects non-integer and out-of-range numbers', () => {
  assert.throws(() => parseConfig({ ...GOOD, DURATION_SEC: '60.5' }), /DURATION_SEC/);
  assert.throws(() => parseConfig({ ...GOOD, DURATION_SEC: '5000' }), /DURATION_SEC/);
  assert.throws(() => parseConfig({ ...GOOD, READY_TIMEOUT_SEC: '1' }), /READY_TIMEOUT_SEC/);
  assert.throws(() => parseConfig({ ...GOOD, MIN_PACKETS: '0' }), /MIN_PACKETS/);
});

test('verdict: never connected is FAIL', () => {
  const v = verdict({ readyMs: null, speakers: [] });
  assert.equal(v.status, 'FAIL');
  assert.match(v.reasons[0], /connected state/);
});

test('verdict: connected but nobody spoke is FAIL', () => {
  const v = verdict({ readyMs: 900, speakers: [] });
  assert.equal(v.status, 'FAIL');
});

test('verdict: healthy single speaker is PASS', () => {
  const v = verdict({ readyMs: 900, speakers: [{ label: 'speaker-1', packets: 1500, speakingEvents: 3, errors: 0 }] });
  assert.equal(v.status, 'PASS');
  assert.deepEqual(v.warnings, []);
});

test('verdict: heard speaking but zero packets is FAIL (silent speaker / decrypt failure)', () => {
  const v = verdict({
    readyMs: 900,
    speakers: [
      { label: 'speaker-1', packets: 1500, speakingEvents: 3, errors: 0 },
      { label: 'speaker-2', packets: 0, speakingEvents: 4, errors: 6 },
    ],
  });
  assert.equal(v.status, 'FAIL');
  assert.match(v.reasons[0], /speaker-2/);
});

test('verdict: very little audio is WARN, not FAIL', () => {
  const v = verdict({ readyMs: 900, speakers: [{ label: 'speaker-1', packets: 40, speakingEvents: 1, errors: 0 }] });
  assert.equal(v.status, 'WARN');
});

test('verdict: errors that recovered are WARN', () => {
  const v = verdict({ readyMs: 900, speakers: [{ label: 'speaker-1', packets: 900, speakingEvents: 2, errors: 2 }] });
  assert.equal(v.status, 'WARN');
  assert.match(v.warnings[0], /kept arriving/);
});

test('logSummary: only anonymous labels, no ids or names', () => {
  const stats = {
    readyMs: 1200,
    speakers: [{ label: 'speaker-1', packets: 500, speakingEvents: 2, errors: 1, errorKinds: { DecryptionFailed: 1 }, parts: 2 }],
  };
  const text = logSummary(stats, verdict(stats));
  assert.match(text, /RESULT: PASS|RESULT: WARN/);
  assert.match(text, /speaker-1/);
  assert.match(text, /DecryptionFailed x1/);
  assert.doesNotMatch(text, /\d{17,}/);
});

test('discordReport: shows names when given, stays under the message limit', () => {
  const stats = { readyMs: 1000, speakers: [{ label: 'speaker-1', packets: 500, speakingEvents: 1, errors: 0 }] };
  const text = discordReport(stats, verdict(stats), { 'speaker-1': 'Alex' });
  assert.match(text, /speaker-1 \(Alex\)/);
  assert.ok(text.length <= 1900);
});
