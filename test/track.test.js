import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { silenceFramesNeeded, AlignedTrack, overlapSeconds } from '../track.mjs';

test('silenceFramesNeeded: no padding for normal 20 ms cadence or small jitter', () => {
  assert.equal(silenceFramesNeeded({ nowMs: 1020, startMs: 0, written: 50 }), 0);
  assert.equal(silenceFramesNeeded({ nowMs: 1000, startMs: 0, written: 48 }), 0); // gap 2 = slack
});

test('silenceFramesNeeded: a 2 s pause is filled', () => {
  assert.equal(silenceFramesNeeded({ nowMs: 3000, startMs: 0, written: 50 }), 100);
});

test('silenceFramesNeeded: never negative when packets arrive in a burst', () => {
  assert.equal(silenceFramesNeeded({ nowMs: 1000, startMs: 0, written: 80 }), 0);
});

test('AlignedTrack: all speakers end up the same length and overlap is measured', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'track-'));
  try {
    const a = new AlignedTrack({ dir, label: 'speaker-1', startMs: 0, maxSeconds: 10 });
    const b = new AlignedTrack({ dir, label: 'speaker-2', startMs: 0, maxSeconds: 10 });
    const pkt = Buffer.from([1, 2, 3, 4]);
    for (let t = 0; t < 1000; t += 20) a.push(pkt, t); // speaks 0-1 s
    for (let t = 500; t < 1500; t += 20) b.push(pkt, t); // speaks 0.5-1.5 s
    a.finish(2000);
    b.finish(2000);
    assert.equal(a.written, 100);
    assert.equal(b.written, 100);
    assert.equal(overlapSeconds([a, b]), 0.5);
    assert.ok(statSync(a.files[0]).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
