// Pure helpers for the voice-recording feasibility test.
// Nothing here talks to Discord, so it can be unit-tested offline.

const ID_RE = /^\d{17,20}$/;

function intOr(value, fallback) {
  const s = String(value ?? '').trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

/** Reads settings from environment variables. Throws one clear error listing every problem. */
export function parseConfig(env) {
  const problems = [];

  const token = String(env.DISCORD_TOKEN ?? '').trim();
  if (!token) problems.push('DISCORD_TOKEN is missing');

  const channelId = String(env.CHANNEL_ID ?? '').trim();
  if (!ID_RE.test(channelId)) problems.push('CHANNEL_ID must be a voice channel ID (17-20 digits)');

  const postChannelId = String(env.POST_CHANNEL_ID ?? '').trim();
  if (postChannelId && !ID_RE.test(postChannelId)) {
    problems.push('POST_CHANNEL_ID must be a text channel ID (17-20 digits) or left empty');
  }

  const durationSec = intOr(env.DURATION_SEC, 60);
  if (!(durationSec >= 10 && durationSec <= 1800)) problems.push('DURATION_SEC must be a whole number from 10 to 1800');

  const readyTimeoutSec = intOr(env.READY_TIMEOUT_SEC, 30);
  if (!(readyTimeoutSec >= 5 && readyTimeoutSec <= 120)) problems.push('READY_TIMEOUT_SEC must be a whole number from 5 to 120');

  // Opus frames are 20 ms, so 50 packets = 1 second of audio.
  const minPackets = intOr(env.MIN_PACKETS, 100);
  if (!(minPackets >= 1)) problems.push('MIN_PACKETS must be a whole number of 1 or more');

  if (problems.length) throw new Error(problems.join('; '));
  return { token, channelId, postChannelId, durationSec, readyTimeoutSec, minPackets };
}

/**
 * Decides pass / warn / fail from what the run observed.
 * stats = { readyMs: number|null, speakers: [{ label, packets, speakingEvents, errors }] }
 */
export function verdict(stats, minPackets = 100) {
  const reasons = [];
  const warnings = [];

  if (stats.readyMs == null) {
    return {
      status: 'FAIL',
      reasons: ['Never reached the connected state. The voice connection could not be set up (network blocked, or the library could not finish the encryption handshake).'],
      warnings,
    };
  }

  const speakers = stats.speakers ?? [];
  if (speakers.length === 0) {
    return {
      status: 'FAIL',
      reasons: ['Connected, but no speaker was detected. Either nobody spoke during the test, or Discord did not report anyone speaking.'],
      warnings,
    };
  }

  for (const s of speakers) {
    if (s.packets === 0) {
      reasons.push(`${s.label} was detected speaking (${s.speakingEvents} times) but no audio came through. This is the silent-speaker failure.`);
    } else if (s.packets < minPackets) {
      warnings.push(`${s.label} produced only ${s.packets} packets (about ${(s.packets / 50).toFixed(1)} s of audio). Speak longer for a clear result.`);
    }
    if (s.errors > 0 && s.packets > 0) {
      warnings.push(`${s.label} had ${s.errors} stream error(s) but audio kept arriving after them.`);
    }
  }

  if (reasons.length) return { status: 'FAIL', reasons, warnings };
  return { status: warnings.length ? 'WARN' : 'PASS', reasons, warnings };
}

/** An Opus "silence" frame (what Discord itself sends at the end of speech). */
export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const FRAME_MS = 20;
const GAP_TOLERANCE_FRAMES = 3; // ignore network jitter up to 60 ms

/**
 * How many silence frames to insert before the next real packet so the track stays on the wall clock.
 * Discord sends nothing while someone is quiet, and lost/undecryptable packets leave holes. If we just
 * append packets back to back, those holes disappear: audio comes out sped up, choppy and garbled, and
 * two speakers' tracks no longer line up. `written` counts frames already in the file (audio + silence).
 */
export function silenceFramesNeeded(written, nowMs, trackStartMs) {
  const target = Math.floor((nowMs - trackStartMs) / FRAME_MS);
  const gap = target - written;
  return gap > GAP_TOLERANCE_FRAMES ? gap - 1 : 0;
}

function secs(packets) {
  return (packets / 50).toFixed(1);
}

/** Log-safe summary. Uses speaker-1, speaker-2 labels only: public repo logs are public. */
export function logSummary(stats, v) {
  const lines = [];
  lines.push(`RESULT: ${v.status}`);
  lines.push(`connected: ${stats.readyMs == null ? 'NO' : `yes, in ${(stats.readyMs / 1000).toFixed(1)} s`}`);
  for (const s of stats.speakers ?? []) {
    const kinds = Object.entries(s.errorKinds ?? {}).map(([k, n]) => `${k} x${n}`).join(', ');
    lines.push(
      `${s.label}: ${s.packets} packets (~${secs(s.packets)} s), spoke ${s.speakingEvents}x, ` +
        `${s.errors} stream errors${kinds ? ` [${kinds}]` : ''}, ${s.parts} file part(s)`,
    );
  }
  for (const r of v.reasons) lines.push(`FAIL: ${r}`);
  for (const w of v.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

/** Message posted to the private test channel. May use real names, since the channel is private. */
export function discordReport(stats, v, names = {}) {
  const lines = [`**Voice recording test: ${v.status}**`];
  lines.push(stats.readyMs == null ? 'Connected: no' : `Connected: yes, in ${(stats.readyMs / 1000).toFixed(1)} s`);
  for (const s of stats.speakers ?? []) {
    const who = names[s.label] ? `${s.label} (${names[s.label]})` : s.label;
    lines.push(`- ${who}: ${s.packets} packets, about ${secs(s.packets)} s of audio, ${s.errors} stream errors`);
  }
  for (const r of v.reasons) lines.push(`Failed: ${r}`);
  for (const w of v.warnings) lines.push(`Note: ${w}`);
  lines.push('Listen to the attached clips to confirm they are clear and belong to the right person.');
  return lines.join('\n').slice(0, 1900);
}
