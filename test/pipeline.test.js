import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSilence, spansFromSilences, speechSeconds } from '../pipeline/spans.mjs';
import { splitLongSpans, buildBatches, toMeetingTime, GAP } from '../pipeline/batches.mjs';
import { cleanSegments } from '../pipeline/cleanup.mjs';
import { buildPrompt } from '../pipeline/glossary.mjs';
import { windowWait, RateLimiter } from '../pipeline/limiter.mjs';
import { chunkText, splitMessage, splitSections, summarize } from '../pipeline/summary.mjs';
import { displayNames, mergeLines, hhmmss, formatTranscript } from '../pipeline/transcript.mjs';
import { parseResponse, groqRequest } from '../pipeline/groq.mjs';
import { shouldStop, trackEmpty, recordingNickname, batchAttachments } from '../recorder/stop.mjs';
import { parseSessionConfig } from '../recorder/config.mjs';

test('parseSilence: pairs, and a file that ends in silence', () => {
  const out = parseSilence('silence_start: 2.5\nsilence_end: 6.0 | silence_duration: 3.5\nsilence_start: 9');
  assert.deepEqual(out, [{ start: 2.5, end: 6 }, { start: 9, end: null }]);
});

test('spansFromSilences: speech is the gaps between silences, padded but never overlapping', () => {
  const spans = spansFromSilences([{ start: 2, end: 5 }, { start: 8, end: null }], 10, { pad: 0.25 });
  assert.equal(spans.length, 2);
  assert.equal(spans[0].start, 0);
  assert.ok(Math.abs(spans[0].end - 2.25) < 1e-9);
  assert.ok(Math.abs(spans[1].start - 4.75) < 1e-9);
  assert.ok(Math.abs(spans[1].end - 8.25) < 1e-9);
  assert.ok(spans[0].end <= spans[1].start);
  assert.ok(speechSeconds(spans) > 0);
});

test('splitLongSpans: pieces never exceed the limit and cover the span', () => {
  const out = splitLongSpans([{ start: 10, end: 710 }], 240);
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => p.end - p.start <= 240 + 1e-9));
  assert.equal(out[0].start, 10);
  assert.equal(out[2].end, 710);
});

test('buildBatches + toMeetingTime: times map back to the right place in the meeting', () => {
  const batches = buildBatches([{ start: 100, end: 110 }, { start: 300, end: 305 }], { maxSpeech: 240 });
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(toMeetingTime(b, 2), 102);
  assert.equal(toMeetingTime(b, 10 + GAP + 1), 301);
  assert.equal(toMeetingTime(b, 10.2), 110); // inside the gap: snaps to the end of the span before
});

test('buildBatches: starts a new batch when the speech limit would be exceeded', () => {
  const batches = buildBatches([{ start: 0, end: 200 }, { start: 300, end: 341 }], { maxSpeech: 240 });
  assert.equal(batches.length, 2);
  assert.equal(buildBatches([{ start: 0, end: 200 }, { start: 300, end: 340 }], { maxSpeech: 240 }).length, 1); // exactly at the limit fits
});

test('cleanSegments: drops empty, no-speech, repetition and phantom lines, keeps real speech', () => {
  const { kept, dropped } = cleanSegments([
    { start: 0, end: 2, text: ' ', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1 },
    { start: 2, end: 4, text: 'hmm', avg_logprob: -1.5, no_speech_prob: 0.9, compression_ratio: 1 },
    { start: 4, end: 6, text: 'la la la', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 3 },
    { start: 6, end: 7, text: 'Thanks for watching!', avg_logprob: -0.8, no_speech_prob: 0.4, compression_ratio: 1 },
    { start: 7, end: 9, text: 'We ship on Friday.', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.1 },
  ]);
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped, { empty: 1, noSpeech: 1, repetition: 1, phantom: 1 });
});

test('buildPrompt: respects the caps and handles empty input', () => {
  assert.equal(buildPrompt(''), '');
  const p = buildPrompt('VibeCut, CapCut');
  assert.equal(p, 'Names and terms: VibeCut, CapCut.');
  assert.ok(buildPrompt(Array.from({ length: 500 }, (_, i) => `term${i}`).join(',')).length <= 700);
});

test('windowWait: fits now, or waits until the oldest event leaves the window', () => {
  assert.equal(windowWait([], 1000, 60000, 5, 1), 0);
  const ev = [{ t: 0, units: 3 }, { t: 10000, units: 2 }];
  assert.equal(windowWait(ev, 20000, 60000, 5, 1), 40000);
});

test('RateLimiter: waits instead of exceeding the cap', async () => {
  let now = 0;
  const waits = [];
  const rl = new RateLimiter({ limits: [{ name: 'rpm', windowMs: 1000, cap: 1, units: () => 1 }], now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  await rl.acquire({});
  await rl.acquire({});
  assert.equal(waits.length >= 1, true);
});

test('chunkText: every piece is under the limit and no text is lost', () => {
  const text = Array.from({ length: 400 }, (_, i) => `[00:00:${i % 60}] Sam: line number ${i} with some words`).join('\n');
  const chunks = chunkText(text, 500);
  assert.ok(chunks.every((c) => c.length <= 500 * 3.5));
  assert.equal(chunks.join('\n').split('\n').length, 400);
});

test('splitMessage: long lines are split, not cut off', () => {
  const long = 'x'.repeat(4500);
  const parts = splitMessage(`first\n${long}\nlast`, 1900);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.equal(parts.join('').replace(/\n/g, '').length, 'first'.length + 4500 + 'last'.length);
});

test('splitSections: pulls out the action items block', () => {
  const t = '**Summary**\n- a\n\n**Decisions**\n- b\n\n**Action items**\n- Sam: ship [00:01:00]\n\n**Open questions**\n- none';
  assert.equal(splitSections(t).actions, '- Sam: ship [00:01:00]');
});

test('summarize: short transcript is one request; failures never throw', async () => {
  const calls = [];
  const chat = { requests: 0, complete: async (_system, u) => { calls.push(u); chat.requests++; return '**Summary**\n- ok\n\n**Action items**\n- None recorded'; } };
  const r = await summarize({ transcriptBody: '[00:00:01] Sam: hi', chat });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const bad = await summarize({ transcriptBody: 'x', chat: { complete: async () => { throw Object.assign(new Error('boom'), { kind: 'auth' }); } } });
  assert.equal(bad.ok, false);
  assert.equal((await summarize({ transcriptBody: '  ', chat })).ok, false);
});

test('displayNames: duplicates are numbered, missing names fall back to the label', () => {
  const n = displayNames([{ label: 'speaker-1', name: 'Sam' }, { label: 'speaker-2', name: 'Sam' }, { label: 'speaker-3', name: null }]);
  assert.deepEqual(n, { 'speaker-1': 'Sam', 'speaker-2': 'Sam (2)', 'speaker-3': 'speaker-3' });
});

test('mergeLines + formatTranscript: ordered, joined, offset applied', () => {
  const lines = [
    { speaker: 'a', start: 70, end: 72, text: 'second' },
    { speaker: 'a', start: 65, end: 69, text: 'first' },
    { speaker: 'b', start: 80, end: 82, text: 'other' },
  ];
  const merged = mergeLines(lines);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'first second');
  const out = formatTranscript({ lines, names: { a: 'Ann', b: 'Bo' }, offsetSec: 60, header: 'H\n' });
  assert.equal(out, 'H\n[00:00:05] Ann: first second\n[00:00:20] Bo: other\n');
  assert.equal(hhmmss(3725), '01:02:05');
});

test('parseResponse: segments sorted; plain text becomes one segment; junk is an error', () => {
  assert.equal(parseResponse({ segments: [{ start: 5, end: 6, text: 'b' }, { start: 1, end: 2, text: 'a' }] }, 10)[0].text, 'a');
  assert.equal(parseResponse({ text: 'hi' }, 10)[0].end, 10);
  assert.throws(() => parseResponse({}, 10));
});

test('groqRequest: retries 5xx, honours 429 retry-after, stops on 401', async () => {
  const realFetch = globalThis.fetch;
  try {
    const seq = [new Response('x', { status: 500 }), new Response('x', { status: 429, headers: { 'retry-after': '1' } }), Response.json({ ok: 1 })];
    globalThis.fetch = async () => seq.shift();
    const blocked = [];
    const limiter = { acquire: async () => {}, block: (s) => blocked.push(s) };
    const out = await groqRequest({ path: '/x', apiKey: 'k', buildBody: () => '', limiter, request: {}, sleep: async () => {} });
    assert.deepEqual(out, { ok: 1 });
    assert.deepEqual(blocked, [1]);
    globalThis.fetch = async () => new Response('no', { status: 401 });
    await assert.rejects(() => groqRequest({ path: '/x', apiKey: 'k', buildBody: () => '', limiter, request: {}, sleep: async () => {} }), (e) => e.kind === 'auth');
  } finally {
    globalThis.fetch = realFetch;
  }
});

const SC = { maxMinutes: 150, startWaitMinutes: 15, emptyGraceMinutes: 3, silenceStopMinutes: 20 };
const MIN = 60_000;
test('shouldStop: every rule', () => {
  const base = { now: 0, joinedAt: 0, firstHumanAt: null, humans: 0, emptySince: null, lastSpeechAt: null, stopFlag: false };
  assert.equal(shouldStop({ ...base, now: 14 * MIN }, SC).stop, false);
  assert.deepEqual(shouldStop({ ...base, now: 15 * MIN }, SC).empty, true);
  assert.equal(shouldStop({ ...base, stopFlag: true }, SC).stop, true);
  const live = { ...base, firstHumanAt: 0, humans: 2 };
  assert.equal(shouldStop({ ...live, now: 150 * MIN, lastSpeechAt: 150 * MIN }, SC).stop, true);
  assert.equal(shouldStop({ ...live, humans: 0, emptySince: 0, now: 3 * MIN, lastSpeechAt: 3 * MIN }, SC).stop, true);
  assert.equal(shouldStop({ ...live, humans: 0, emptySince: 0, now: 2 * MIN, lastSpeechAt: 2 * MIN }, SC).stop, false);
  assert.equal(shouldStop({ ...live, now: 20 * MIN }, SC).stop, true);
  assert.equal(shouldStop({ ...live, now: 19 * MIN }, SC).stop, false);
});

test('trackEmpty / recordingNickname / batchAttachments', () => {
  assert.equal(trackEmpty(null, 0, 500), 500);
  assert.equal(trackEmpty(500, 0, 900), 500);
  assert.equal(trackEmpty(500, 1, 900), null);
  assert.equal(recordingNickname('Bot'), '[REC] Bot');
  assert.equal(recordingNickname('[REC] Bot'), '[REC] Bot');
  assert.ok(recordingNickname('x'.repeat(50)).length <= 32);
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, size: 1000 }));
  files.push({ name: 'huge', size: 20_000_000 });
  const { batches, tooBig } = batchAttachments(files);
  assert.deepEqual(batches.map((b) => b.length), [10, 2]);
  assert.deepEqual(tooBig.map((f) => f.name), ['huge']);
});

test('parseSessionConfig: needs a team entry for the channel and rejects bad input', () => {
  const ch = '123456789012345678';
  const ok = { DISCORD_TOKEN: 't', CHANNEL_ID: ch, TEAM_CONFIG: JSON.stringify({ [ch]: { name: 'A', transcriptChannelId: '223456789012345678' } }) };
  const c = parseSessionConfig(ok);
  assert.equal(c.team.transcriptChannelId, '223456789012345678');
  assert.equal(c.maxMinutes, 150);
  assert.throws(() => parseSessionConfig({ ...ok, TEAM_CONFIG: '{}' }), /no entry/);
  assert.throws(() => parseSessionConfig({ ...ok, TEAM_CONFIG: 'nope' }), /valid JSON/);
  assert.throws(() => parseSessionConfig({ ...ok, MAX_MINUTES: '9999' }), /MAX_MINUTES/);
  assert.throws(() => parseSessionConfig({ ...ok, WORKER_URL: 'http://x' }), /https/);
  assert.throws(() => parseSessionConfig({ ...ok, TEAM_CONFIG: 'null' }));
});
