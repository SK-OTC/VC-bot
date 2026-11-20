// /transcript-settings: what happens to a finished recording, per server. Separate from /start-recording.
//   save         keep the transcript and summary in the bot's database (this is what the private web page, its question box and
//                the /admin editing use)
//   post         send the transcript file and the summary into a Discord text channel
//   destination  the text channel to post in (default: the channel where the recording was started)
// With nothing set, a server saves AND posts, in the channel where the recording was started.
// Not allowed: save off + post off (the recording would be thrown away).
import { fail, hasManagePerms, reply } from './replies.js';
import { NEEDS_MANAGE, TEXT_TYPES, channelProblem, respondLater } from './setup-commands.js';
import { getTranscriptSettings, saveTranscriptSettings } from './recording-store.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;

const onOff = (v) => (v ? 'on' : 'off');

/** Plain-words description of the settings, including what each combination means. */
export function describeSettings(s) {
  const lines = [
    '**Transcript settings for this server**' + (s.custom ? '' : ' (defaults: nothing has been changed)'),
    `• Save: **${onOff(s.save)}**. ${s.save ? 'The transcript and summary are kept in the database, with a private web page (and a question box) for each.' : 'Nothing is kept: there is no web page, no question box and no link.'}`,
    `• Post: **${onOff(s.post)}**. ${s.post ? 'The transcript file and the summary are posted in a channel.' : 'Nothing is posted in a channel.'}`,
    s.post
      ? `• Where: ${s.destination ? `<#${s.destination}>` : 'the channel where `/start-recording` was used (or the transcript channel of that voice channel\'s `/setup-recording`, if it has one)'}`
      : '• Where: not used while posting is off',
  ];
  if (!s.post && s.save) {
    lines.push(
      'Because posting is off, the summary and its web link are sent in a private message to the person who started the recording. ' +
        'A recording started from a scheduled meeting has no such person, so nothing is delivered for it (it is still saved).',
    );
  }
  if (s.post && !s.save) lines.push('Because saving is off, the summary is posted in full in the channel (there is no web link to carry the rest).');
  return lines.join('\n');
}

export async function cmdTranscriptSettings(ctx, o) {
  if (!hasManagePerms(ctx.interaction)) return fail(NEEDS_MANAGE);
  const { db, discord, nowSec, userId, guildId } = ctx;
  const current = await getTranscriptSettings(db, guildId);

  const changing = ['save', 'post', 'destination', 'clear_destination'].some((k) => o[k] !== undefined);
  if (!changing) return reply(describeSettings(current), { ephemeral: true });

  if (o.destination && o.clear_destination) return fail('Pick either `destination` or `clear_destination`, not both.');
  const next = {
    save: o.save === undefined ? current.save : Boolean(o.save),
    post: o.post === undefined ? current.post : Boolean(o.post),
    destination: o.clear_destination ? null : o.destination ? String(o.destination) : current.destination,
  };
  if (next.destination && !SNOWFLAKE_RE.test(next.destination)) return fail('That does not look like a channel. Pick one from the list Discord shows.');
  if (!next.save && !next.post) {
    return fail('Saving and posting cannot both be off: the transcript and summary would be thrown away. Leave at least one on.');
  }

  const done = async () => {
    await saveTranscriptSettings(db, guildId, next, userId, nowSec);
    return `Saved.\n${describeSettings({ ...next, custom: true })}`;
  };
  // A new destination is proven now, with a real message, so a mistake shows up here and not after a meeting.
  if (next.post && o.destination) {
    return respondLater(ctx, async () => {
      const got = await discord.getChannel(next.destination);
      const problem = channelProblem(next.destination, got, { types: TEXT_TYPES, label: 'text channel' }, guildId);
      if (problem) return `Nothing was saved.\n• ${problem}`;
      const sent = await discord.postMessage(next.destination, { content: 'Transcripts and summaries of recordings in this server will be posted in this channel.', allowedMentions: { parse: [] } });
      if (!sent.ok) return `Nothing was saved.\n• <#${next.destination}>: I need View Channel, Send Messages, Attach Files and Read Message History. (Discord said: ${sent.error})`;
      return done();
    });
  }
  return reply(await done(), { ephemeral: true });
}
