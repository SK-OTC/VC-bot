// /start-recording and /stop-recording. Starting asks GitHub to run the recorder (the Worker cannot hold a voice
// connection itself); stopping sets the flag the recorder checks every 15 seconds, so it leaves, then transcribes.
import { MessageFlags, ResponseType } from './discord.js';
import { canManageOwner, fail, reply } from './replies.js';
import { endSession, failStaleSessions, findLiveSessions, getRecordingSetup, getTranscriptSettings, requestStop } from './recording-store.js';
import { launchSession, openSession } from './recording-start.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;

export const RECORDING_NOT_ENABLED =
  'Recording is not set up on this bot yet. The bot owner needs to set the `GITHUB_DISPATCH_TOKEN` secret and `GITHUB_REPO` on the Worker (see the README).';

const stillLive = (live) => live.map((s) => `<#${s.voice_channel_id}>`).join(', ');

export async function cmdStartRecording(ctx, o) {
  const { db, nowSec, userId, guildId, discord, recorder, defer, interaction } = ctx;
  if (!recorder) return fail(RECORDING_NOT_ENABLED);

  let channelId = o.channel ? String(o.channel) : null;
  if (!channelId) {
    const where = await discord.getVoiceChannelOf(guildId, userId);
    if (!where.ok) {
      return fail(`I couldn't check which voice channel you are in (${where.error}). Pick the channel with the \`channel\` option.`);
    }
    if (!where.channelId) return fail('Join the voice channel you want recorded first, or pick it with the `channel` option.');
    channelId = where.channelId;
  }
  if (!SNOWFLAKE_RE.test(channelId)) return fail('That does not look like a voice channel. Pick one with the `channel` option.');

  // A voice channel can only be recorded after an admin has said where its transcript goes (/setup-recording). This also
  // stops anyone starting a recording in a channel the team never agreed to record.
  const setup = await getRecordingSetup(db, channelId, guildId);
  if (!setup) {
    return fail(`<#${channelId}> is not set up for recording yet. A server admin can set it up with \`/setup-recording\`.`);
  }

  // The channel where this command was typed is where the transcript goes, unless /transcript-settings or the voice channel's
  // setup names another one (see resolveTranscriptTarget).
  const made = await openSession(db, { channelId, guildId, startedBy: userId, startChannelId: interaction.channel_id ?? null }, nowSec);
  if (made.conflict) {
    return fail(`<#${channelId}> is already being recorded. End that recording with \`/stop-recording\` first.`);
  }
  const id = made.id;
  const settings = await getTranscriptSettings(db, guildId);
  const whereResults = !settings.post
    ? 'Nothing is posted to a channel: the summary link is sent to you in a private message.'
    : settings.destination
      ? `The transcript and summary go to <#${settings.destination}>`
      : setup.transcript_channel_id
        ? `The transcript and summary go to <#${setup.transcript_channel_id}>`
        : `The transcript and summary go to ${interaction.channel_id ? `<#${interaction.channel_id}>` : 'this channel'}`;

  const run = async () => {
    const r = await launchSession(db, recorder, { id, channelId }, nowSec);
    if (!r.ok) return `I couldn't start the recording: ${r.error}.`;
    return (
      `Starting a recording of <#${channelId}>. The bot should join within about a minute (GitHub has to start a machine), ` +
      'rename itself `[REC] …` and post a notice in the channel. Once it is in, talk as usual. ' +
      'It leaves when everyone has left, after a long silence, at the time limit, or when you run `/stop-recording`. ' +
      `${whereResults.replace(/\.$/, '')} a few minutes after it leaves.`
    );
  };

  const { application_id: appId, token } = interaction;
  const priv = (content) => reply(content, { ephemeral: true });
  if (!defer || !appId || !token) return priv(await run().catch((e) => `I couldn't start the recording: ${e?.message ?? e}`));
  defer(
    (async () => {
      let content;
      try {
        content = await run();
      } catch (e) {
        console.error('start-recording failed:', e?.stack ?? e);
        await endSession(db, id, 'failed', 'internal error while starting', nowSec).catch(() => {});
        content = `I couldn't start the recording: unexpected error (${String(e?.message ?? e).slice(0, 200)}).`;
      }
      const res = await discord.editOriginal(appId, token, { content });
      if (!res.ok) console.error(`start-recording: could not edit the reply: ${res.error}`);
    })(),
  );
  return { type: ResponseType.DEFERRED, data: { flags: MessageFlags.EPHEMERAL } };
}

export async function cmdStopRecording(ctx, o) {
  const { db, nowSec, userId, guildId, interaction } = ctx;
  await failStaleSessions(db, guildId, nowSec);
  const channelId = o.channel ? String(o.channel) : null;
  const live = await findLiveSessions(db, guildId, channelId);
  if (!live.length) return fail(channelId ? `Nothing is being recorded in <#${channelId}>.` : 'No recording is running in this server.');
  if (live.length > 1) return fail(`More than one recording is running (${stillLive(live)}). Say which one with the \`channel\` option.`);

  const session = live[0];
  if (!canManageOwner(interaction, session.started_by, userId)) {
    return fail('Only the person who started this recording, or someone with Manage Server, can stop it.');
  }
  const here = `<#${session.voice_channel_id}>`;

  if (o.force) {
    await endSession(db, session.id, 'failed', 'ended by hand with force', nowSec);
    return reply(
      `Cleared the recording of ${here} so it can be started again. If the bot is still in the call, it will stop by itself at its time limit. ` +
        'Use `force` only when the recording is stuck.',
      { ephemeral: true },
    );
  }
  if (session.stop_flag === 1) {
    return reply(
      `${here} is already being stopped. The bot leaves within about 15 seconds, then transcribes (a few minutes). ` +
        'If the bot is still in the call after several minutes, run `/stop-recording force:True` to clear it.',
      { ephemeral: true },
    );
  }
  await requestStop(db, session.id, nowSec);
  const starting = session.status === 'starting';
  return reply(
    `Recording of ${here} is being stopped by <@${userId}>. ` +
      (starting
        ? 'The bot had not joined yet, so it will leave as soon as it does.'
        : 'The bot leaves within about 15 seconds, then the transcript and summary are posted to the team channel after a few minutes.'),
  );
}
