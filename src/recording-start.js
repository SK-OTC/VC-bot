// Starting a recording: the part shared by /start-recording and the scheduled auto-join. Both make a session row first (the
// database allows one live session per voice channel, so two starts at the same moment cannot both win) and then ask GitHub to
// run the recorder. If GitHub refuses, the session is ended so the channel is not left looking busy.
import { createSession, endSession, failStaleSessions } from './recording-store.js';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

/**
 * Makes the session row. { ok: true, id } or { ok: false, conflict: true } when that voice channel is already being recorded (or this
 * occurrence of a scheduled meeting already has a session). `routing` is the named setup's channels (sessionRouting).
 */
export async function openSession(db, { channelId, guildId, startedBy, startChannelId = null, meetingId = null, meetingFireAt = null, routing = null }, nowSec) {
  await failStaleSessions(db, guildId, nowSec);
  const id = newSessionId();
  const made = await createSession(db, { id, channelId, guildId, startedBy, startChannelId, meetingId, meetingFireAt, routing }, nowSec);
  return made.ok ? { ok: true, id } : { ok: false, conflict: true };
}

/** Asks GitHub to run the recorder. { ok: true } or { ok: false, error } (and the session is ended as failed). */
export async function launchSession(db, recorder, { id, channelId }, nowSec) {
  const r = await recorder.dispatch({ channel_id: channelId, session_id: id });
  if (!r.ok) {
    await endSession(db, id, 'failed', `could not start: ${r.error}`, nowSec);
    return { ok: false, error: r.error };
  }
  return { ok: true };
}
