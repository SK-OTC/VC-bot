// /recording voice-channel (and the voice channel half of /recording list and /recording delete): which voice channels may be
// recorded, with their transcript heading, language, glossary and audio backup channel. This replaces the TEAM_CONFIG GitHub secret.
// Only people with Manage Server can change anything, every new channel is checked against Discord when it is saved (so a mistake
// shows up now, not in the middle of a meeting), and /start-recording refuses to record a voice channel that is not allowed here.
// Where the transcript goes is not decided here: that is the recording setup's job (/recording setup).
import { MessageFlags, ResponseType } from './discord.js';
import { fail, reply } from './replies.js';
import { MAX_SETUPS_PER_GUILD, countRecordingSetups, deleteRecordingSetup, getRecordingSetup, listRecordingSetups, saveRecordingSetup } from './recording-store.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const LANGUAGE_RE = /^[a-z]{2,3}$/;
const VOICE = 2;
export const TEXT_TYPES = [0, 5]; // text, announcement
const MAX_NAME = 50;
const MAX_GLOSSARY = 500;

export const NEEDS_MANAGE = 'Only people with the Manage Server permission can change recording settings.';

/** Removes control characters and collapses whitespace. */
function tidy(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127 ? ' ' : ch;
  return out.replace(/\s+/g, ' ').trim();
}

/** What the bot still needs in a channel it could not use, in plain words. */
const needsIn = (id, wants) => `<#${id}>: I need ${wants}.`;

/** Replies at once with a "thinking" placeholder and edits it when `run` finishes (Discord allows 3 seconds to answer). */
export function respondLater(ctx, run) {
  const { defer, discord, interaction } = ctx;
  const { application_id: appId, token } = interaction;
  const priv = (content) => reply(content, { ephemeral: true });
  if (!defer || !appId || !token) return run().then(priv, (e) => priv(`Something went wrong: ${String(e?.message ?? e).slice(0, 200)}`));
  defer(
    (async () => {
      let content;
      try {
        content = await run();
      } catch (e) {
        console.error('recording command failed:', e?.name ?? 'Error');
        content = `Something went wrong: ${String(e?.message ?? e).slice(0, 200)}`;
      }
      const res = await discord.editOriginal(appId, token, { content });
      if (!res.ok) console.error(`recording command: could not edit the reply: ${res.error}`);
    })(),
  );
  return { type: ResponseType.DEFERRED, data: { flags: MessageFlags.EPHEMERAL } };
}

export const channelProblem = (id, got, { types, label }, guildId) => {
  if (!got.ok) {
    return got.status === 403 || got.status === 404
      ? `I can't see <#${id}> (${label}). Give the bot **View Channel** there, then run this again.`
      : `I couldn't check <#${id}> (${got.error}). Please try again in a moment.`;
  }
  if (got.channel.guildId !== guildId) return `<#${id}> is not in this server.`;
  if (!types.includes(got.channel.type)) return `<#${id}> must be a ${label}.`;
  return null;
};

/** One allowed voice channel in one line. */
export function describeVoiceChannel(s) {
  return (
    `**${s.name}**: <#${s.voice_channel_id}>` +
    (s.backup_channel_id ? `, backup <#${s.backup_channel_id}>` : '') +
    `, language ${s.language}` +
    (s.glossary ? `, glossary: ${s.glossary.length > 80 ? `${s.glossary.slice(0, 77)}...` : s.glossary}` : '')
  );
}

/** /recording voice-channel. The caller has already checked Manage Server. */
export async function cmdRecordingVoiceChannel(ctx, o) {
  const { db, discord, nowSec, userId, guildId } = ctx;
  const voiceId = String(o.voice_channel ?? '');
  if (!SNOWFLAKE_RE.test(voiceId)) return fail('That is not a valid voice channel. Pick it from the list Discord shows.');
  const existing = await getRecordingSetup(db, voiceId, guildId);

  const changing = ['name', 'backup_channel', 'language', 'glossary', 'clear'].some((k) => o[k] !== undefined);
  if (existing && !changing) {
    return reply(`${describeVoiceChannel(existing)}\nChange it by adding options to this command. Stop it being recordable with \`/recording delete voice_channel:\`.`, { ephemeral: true });
  }
  if (!existing && (await countRecordingSetups(db, guildId)) >= MAX_SETUPS_PER_GUILD) {
    return fail(`This server already allows ${MAX_SETUPS_PER_GUILD} voice channels to be recorded. Remove one with \`/recording delete voice_channel:\` first.`);
  }

  const clear = o.clear === undefined ? null : String(o.clear);
  if (clear && !['backup_channel', 'glossary'].includes(clear)) return fail('`clear` must be backup_channel or glossary.');
  if (clear && o[clear] !== undefined) return fail(`Pick either \`${clear}\` or \`clear:${clear}\`, not both.`);

  const backupId = clear === 'backup_channel' ? null : o.backup_channel !== undefined ? String(o.backup_channel) : existing?.backup_channel_id ?? null;
  if (backupId && !SNOWFLAKE_RE.test(backupId)) return fail('The backup channel is not valid. Pick it from the list Discord shows.');
  if (backupId && backupId === voiceId) return fail('The backup channel must be a text channel, not the voice channel itself.');
  const language = o.language !== undefined ? String(o.language).trim().toLowerCase() : existing?.language ?? 'en';
  if (!LANGUAGE_RE.test(language)) return fail('`language` must be a 2 or 3 letter code such as `en`, `es` or `fr`.');
  const glossary = clear === 'glossary' ? '' : o.glossary !== undefined ? tidy(o.glossary) : existing?.glossary ?? '';
  if (glossary.length > MAX_GLOSSARY) return fail(`\`glossary\` is too long (max ${MAX_GLOSSARY} characters).`);
  const typedName = tidy(o.name);
  if (typedName.length > MAX_NAME) return fail(`\`name\` is too long (max ${MAX_NAME} characters).`);

  // A backup channel that is new or changed is checked against Discord and gets a real message, like every newly named channel.
  const newBackup = backupId && backupId !== existing?.backup_channel_id ? backupId : null;

  const save = async (voiceName) => {
    const name = typedName || existing?.name || tidy(voiceName).slice(0, MAX_NAME) || 'Meeting';
    const saved = await saveRecordingSetup(db, { voiceChannelId: voiceId, guildId, name, backupChannelId: backupId, glossary, language, createdBy: userId }, nowSec);
    if (!saved.ok) return 'That voice channel already belongs to another server, so it cannot be set up here.';
    const row = { voice_channel_id: voiceId, name, backup_channel_id: backupId, glossary, language };
    return (
      `${saved.updated ? 'Updated' : 'Allowed'} recording in <#${voiceId}>.\n${describeVoiceChannel(row)}\n` +
      'The transcript and summary go where the recording setup says (`/recording setup name:Default` for `/start-recording`).' +
      (saved.updated
        ? ''
        : `\nStill to check by hand: the bot needs **View Channel** and **Connect** in <#${voiceId}> and **Change Nickname** in the server. ` +
          'Anyone can now start a recording there with `/start-recording`.')
    );
  };
  const text = (content) => reply(content, { ephemeral: true });
  if (existing && !newBackup) return text(await save());

  return respondLater(ctx, async () => {
    const [voice, backup] = await Promise.all([
      existing ? Promise.resolve(null) : discord.getChannel(voiceId),
      newBackup ? discord.getChannel(newBackup) : Promise.resolve(null),
    ]);
    const problems = [
      voice ? channelProblem(voiceId, voice, { types: [VOICE], label: 'voice channel' }, guildId) : null,
      backup ? channelProblem(newBackup, backup, { types: TEXT_TYPES, label: 'text channel' }, guildId) : null,
    ].filter(Boolean);
    if (problems.length) return `Nothing was saved.\n${problems.map((p) => `• ${p}`).join('\n')}`;
    // A real message proves the bot can post (and attach files) in the backup channel.
    if (newBackup) {
      const sent = await discord.postMessage(newBackup, { content: `Audio backups for meetings in <#${voiceId}> will be posted in this channel.`, allowedMentions: { parse: [] } });
      if (!sent.ok) return `Nothing was saved. I couldn't post in every channel:\n• ${needsIn(newBackup, 'View Channel, Send Messages and Attach Files')} (Discord said: ${sent.error})`;
    }
    return save(voice?.channel?.name);
  });
}

/** The voice channel half of /recording list: one line per allowed voice channel, cut to fit in `budget` characters. */
export async function voiceChannelLines(db, guildId, budget) {
  const all = await listRecordingSetups(db, guildId);
  const shown = [];
  let used = 0;
  for (const s of all) {
    const line = `• ${describeVoiceChannel(s)}`;
    if (used + line.length + 1 > budget) break;
    shown.push(line);
    used += line.length + 1;
  }
  return { shown, more: all.length - shown.length, total: all.length };
}

/** The voice channel half of /recording delete. */
export async function removeVoiceChannel(ctx, rawId) {
  const voiceId = String(rawId ?? '');
  const removed = SNOWFLAKE_RE.test(voiceId) && (await deleteRecordingSetup(ctx.db, voiceId, ctx.guildId));
  return removed
    ? reply(`<#${voiceId}> can no longer be recorded until it is allowed again with \`/recording voice-channel\`. A recording already running there is not stopped (use \`/stop-recording\`).`, { ephemeral: true })
    : fail(`<#${voiceId}> is not allowed to be recorded, so there is nothing to remove.`);
}
