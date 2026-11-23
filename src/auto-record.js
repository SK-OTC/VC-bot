// Scheduled auto-join: when a meeting's start time comes, record it if its `location` is a link to a Discord voice channel that
// this bot can use. Called by the scheduler for the meeting's "start" job. Nothing here throws into the reminder, which is posted
// regardless. Every outcome has a fixed `code` (the start message turns it into a visible line, see recordingStatusLine in
// src/messages.js) and a plain `reason` for the log (fixed phrases: never the location or a channel id).
//
// Only a Discord channel link counts (src/voice-link.js). A Google Meet link, any other website, a place or plain text never records
// and adds nothing to the start message (`applies: false`).
//
// Checks, in this order (cheapest first):
//   1. the location is a Discord channel link, recording is configured on this Worker, and the link is for THIS meeting's server
//   2. this occurrence of the meeting has not already been handled (the job can be delivered twice, and a failed start message is
//      retried): the earlier session is reported instead, and the database refuses a second session for the same occurrence
//   3. that voice channel is allowed with /recording voice-channel (the same gate /start-recording applies)
//   4. nothing is being recorded in the server right now (the recorder cannot join a second channel)
//   5. Discord says it is a voice channel in that server which the bot can see
// Then the meeting's named recording setup is resolved (a missing one falls back to Default, and `fallback` says so) and its
// channels are fixed on the session. What this cannot check from the Worker: that the bot may Connect, or that the channel is not
// full. The recorder checks both when it tries to join, and if it cannot, the session ends as failed with that reason.
import { findLiveSessions, findSessionForMeeting, findSessionForOccurrence, getRecordingSetup, failStaleSessions } from './recording-store.js';
import { launchSession, openSession } from './recording-start.js';
import { resolveNamedSetup, sessionRouting } from './named-setups.js';
import { parseChannelLink } from './voice-link.js';

const VOICE = 2;

const no = (code, reason, extra = {}) => ({ started: false, applies: true, code, reason, ...extra });

/** The earlier session of this occurrence, reported as "already handled" (with whether it is recording). */
const already = (s, channelId) =>
  no('already', 'this meeting was already handled', {
    channelId,
    sessionId: s.id,
    setupName: s.setup_name ?? null,
    alreadyStatus: s.status, // 'starting' | 'running' | 'done' | 'failed'
  });

/**
 * Returns { started: true, applies: true, code: 'started', sessionId, channelId, setupName, fallback } or
 * { started: false, applies, code, reason, ... }. `applies` is false only when the location is not a Discord channel link.
 */
export async function autoRecord({ db, discord, recorder, meeting, fireAt, nowSec }) {
  const link = parseChannelLink(meeting.location);
  if (!link) return { started: false, applies: false, code: 'not_link', reason: 'the location is not a Discord channel link' };
  if (!recorder) return no('no_recorder', 'recording is not set up on this Worker');
  if (link.guildId !== meeting.guild_id) return no('other_server', 'the link is for another server');
  const channelId = link.channelId;

  // A start job delivered twice, or retried because its message failed, must not start a second recording.
  const earlier = (await findSessionForOccurrence(db, meeting.id, fireAt)) ?? (await findSessionForMeeting(db, meeting.id, fireAt));
  if (earlier) return already(earlier, channelId);

  const vcSetup = await getRecordingSetup(db, channelId, meeting.guild_id);
  if (!vcSetup) return no('no_setup', 'that voice channel is not allowed with /recording voice-channel', { channelId });

  await failStaleSessions(db, meeting.guild_id, nowSec);
  const live = await findLiveSessions(db, meeting.guild_id);
  if (live.length) {
    return live.some((s) => s.voice_channel_id === channelId)
      ? no('busy_channel', 'that channel is already being recorded', { channelId })
      : no('busy_server', 'a recording is already running in this server', { channelId });
  }

  const got = await discord.getChannel(channelId);
  if (!got.ok) {
    return got.status === 403 || got.status === 404
      ? no('cannot_see', 'the bot cannot see that channel', { channelId })
      : no('discord_error', 'Discord could not be asked about that channel', { channelId });
  }
  if (got.channel.type !== VOICE) return no('not_voice', 'the link is not a voice channel', { channelId });
  if (got.channel.guildId !== meeting.guild_id) return no('other_server', 'that channel is in another server', { channelId });

  const { setup, fallback } = await resolveNamedSetup(db, meeting.guild_id, meeting.recording_setup);
  const routing = sessionRouting(setup);

  // For a scheduled start there is no text channel the command was typed in: the meeting's own channel stands in for it.
  const opened = await openSession(
    db,
    { channelId, guildId: meeting.guild_id, startedBy: 'scheduled', startChannelId: meeting.channel_id, meetingId: meeting.id, meetingFireAt: fireAt, routing },
    nowSec,
  );
  if (!opened.ok) {
    // Lost a race: either another delivery of this same job made the session first, or the channel became busy.
    const raced = await findSessionForOccurrence(db, meeting.id, fireAt);
    return raced ? already(raced, channelId) : no('busy_channel', 'that channel is already being recorded', { channelId });
  }
  const launched = await launchSession(db, recorder, { id: opened.id, channelId }, nowSec);
  if (!launched.ok) return no('launch_failed', 'GitHub refused to start the recorder', { channelId, sessionId: opened.id, setupName: routing.setupName, fallback });
  return { started: true, applies: true, code: 'started', sessionId: opened.id, channelId, setupName: routing.setupName, fallback };
}
