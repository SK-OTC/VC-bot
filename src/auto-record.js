// Scheduled auto-join: when a meeting's start time comes, record it if its `location` is a link to a Discord voice channel that
// this bot can use. Called by the scheduler for the meeting's "start" job. Every refusal is a plain reason string (logged by the
// scheduler, never shown to anyone); nothing here throws into the reminder, which is posted regardless.
//
// Checks, in this order (cheapest first):
//   1. recording is configured on this Worker (GITHUB_DISPATCH_TOKEN and GITHUB_REPO)
//   2. the location is a Discord channel link (src/voice-link.js) for THIS meeting's server
//   3. that voice channel has a /setup-recording (the same gate /start-recording applies)
//   4. this occurrence of the meeting has not already been handled (the job can be delivered twice), and nothing is being
//      recorded in the server right now (the recorder cannot join a second channel, and a live recording of this very channel
//      means the bot is already in the call)
//   5. Discord says it is a voice channel in that server which the bot can see
// What this cannot check from the Worker: that the bot may Connect, or that the channel is not full. The recorder checks both when it
// tries to join, and if it cannot, the session ends as failed with that reason.
import { findLiveSessions, findSessionForMeeting, getRecordingSetup, failStaleSessions } from './recording-store.js';
import { launchSession, openSession } from './recording-start.js';
import { parseChannelLink } from './voice-link.js';

const VOICE = 2;

/** Returns { started: true, sessionId } or { started: false, reason }. */
export async function autoRecord({ db, discord, recorder, meeting, fireAt, nowSec }) {
  if (!recorder) return { started: false, reason: 'recording is not set up on this Worker' };

  const link = parseChannelLink(meeting.location);
  if (!link) return { started: false, reason: 'the location is not a Discord channel link' };
  if (link.guildId !== meeting.guild_id) return { started: false, reason: 'the link is for another server' };

  if (!(await getRecordingSetup(db, link.channelId, meeting.guild_id))) return { started: false, reason: 'that voice channel has no /setup-recording' };

  if (await findSessionForMeeting(db, meeting.id, fireAt)) return { started: false, reason: 'this meeting was already handled' };
  await failStaleSessions(db, meeting.guild_id, nowSec);
  const live = await findLiveSessions(db, meeting.guild_id);
  if (live.length) {
    return { started: false, reason: live.some((s) => s.voice_channel_id === link.channelId) ? 'that channel is already being recorded' : 'a recording is already running in this server' };
  }

  const got = await discord.getChannel(link.channelId);
  if (!got.ok) return { started: false, reason: got.status === 403 || got.status === 404 ? 'the bot cannot see that channel' : 'Discord could not be asked about that channel' };
  if (got.channel.type !== VOICE) return { started: false, reason: 'the link is not a voice channel' };
  if (got.channel.guildId !== meeting.guild_id) return { started: false, reason: 'that channel is in another server' };

  // For a scheduled start there is no text channel the command was typed in: the meeting's own channel stands in for it.
  const opened = await openSession(db, { channelId: link.channelId, guildId: meeting.guild_id, startedBy: 'scheduled', startChannelId: meeting.channel_id, meetingId: meeting.id }, nowSec);
  if (!opened.ok) return { started: false, reason: 'that channel is already being recorded' };
  const launched = await launchSession(db, recorder, { id: opened.id, channelId: link.channelId }, nowSec);
  return launched.ok ? { started: true, sessionId: opened.id } : { started: false, reason: `GitHub refused to start the recorder (${launched.error})` };
}
