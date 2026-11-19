// /setup-recording, /recording-settings and /remove-recording-setup: where each voice channel's transcript goes.
// This replaces the TEAM_CONFIG GitHub secret. Only people with Manage Server can change anything, every channel is
// checked against Discord when the setup is saved (so a mistake shows up now, not in the middle of a meeting), and
// /start-recording refuses to record a voice channel that has no setup.
import { MessageFlags, ResponseType } from './discord.js';
import { fail, hasManagePerms, reply } from './replies.js';
import { MAX_SETUPS_PER_GUILD, countRecordingSetups, deleteRecordingSetup, getRecordingSetup, listRecordingSetups, saveRecordingSetup } from './recording-store.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const LANGUAGE_RE = /^[a-z]{2,3}$/;
const VOICE = 2;
const TEXT_TYPES = [0, 5]; // text, announcement
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
function respondLater(ctx, run) {
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
        console.error('setup-recording failed:', e?.name ?? 'Error');
        content = `Something went wrong: ${String(e?.message ?? e).slice(0, 200)}`;
      }
      const res = await discord.editOriginal(appId, token, { content });
      if (!res.ok) console.error(`setup-recording: could not edit the reply: ${res.error}`);
    })(),
  );
  return { type: ResponseType.DEFERRED, data: { flags: MessageFlags.EPHEMERAL } };
}

const channelProblem = (id, got, { types, label }, guildId) => {
  if (!got.ok) {
    return got.status === 403 || got.status === 404
      ? `I can't see <#${id}> (${label}). Give the bot **View Channel** there, then run this again.`
      : `I couldn't check <#${id}> (${got.error}). Please try again in a moment.`;
  }
  if (got.channel.guildId !== guildId) return `<#${id}> is not in this server.`;
  if (!types.includes(got.channel.type)) return `<#${id}> must be a ${label}.`;
  return null;
};

export async function cmdSetupRecording(ctx, o) {
  if (!hasManagePerms(ctx.interaction)) return fail(NEEDS_MANAGE);
  const { db, discord, nowSec, userId, guildId } = ctx;

  const voiceId = String(o.voice_channel ?? '');
  const transcriptId = String(o.transcript_channel ?? '');
  const backupId = o.backup_channel ? String(o.backup_channel) : null;
  for (const id of [voiceId, transcriptId, backupId].filter(Boolean)) {
    if (!SNOWFLAKE_RE.test(id)) return fail('One of the channels is not valid. Pick them from the list Discord shows.');
  }
  if (new Set([voiceId, transcriptId, backupId].filter(Boolean)).size !== [voiceId, transcriptId, backupId].filter(Boolean).length) {
    return fail('The voice channel, the transcript channel and the backup channel must all be different channels.');
  }
  const language = o.language === undefined ? 'en' : String(o.language).trim().toLowerCase();
  if (!LANGUAGE_RE.test(language)) return fail('`language` must be a 2 or 3 letter code such as `en`, `es` or `fr`.');
  const glossary = tidy(o.glossary);
  if (glossary.length > MAX_GLOSSARY) return fail(`\`glossary\` is too long (max ${MAX_GLOSSARY} characters).`);
  const typedName = tidy(o.name);
  if (typedName.length > MAX_NAME) return fail(`\`name\` is too long (max ${MAX_NAME} characters).`);

  const existing = await getRecordingSetup(db, voiceId, guildId);
  if (!existing && (await countRecordingSetups(db, guildId)) >= MAX_SETUPS_PER_GUILD) {
    return fail(`This server already has ${MAX_SETUPS_PER_GUILD} recording setups. Remove one with \`/remove-recording-setup\` first.`);
  }

  return respondLater(ctx, async () => {
    const [voice, transcript, backup] = await Promise.all([
      discord.getChannel(voiceId),
      discord.getChannel(transcriptId),
      backupId ? discord.getChannel(backupId) : Promise.resolve(null),
    ]);
    const problems = [
      channelProblem(voiceId, voice, { types: [VOICE], label: 'voice channel' }, guildId),
      channelProblem(transcriptId, transcript, { types: TEXT_TYPES, label: 'text channel' }, guildId),
      backup ? channelProblem(backupId, backup, { types: TEXT_TYPES, label: 'text channel' }, guildId) : null,
    ].filter(Boolean);
    if (problems.length) return `Nothing was saved.\n${problems.map((p) => `• ${p}`).join('\n')}`;

    // A real message proves the bot can see the channel and send there, and tells the team where transcripts will go.
    // The backup channel goes first and the team-facing announcement last: if any post fails, nothing is saved, and the
    // transcript channel has not been told that recording is on.
    const posts = [
      ...(backupId ? [[backupId, 'View Channel, Send Messages and Attach Files', `Audio backups for meetings in <#${voiceId}> will be posted in this channel.`]] : []),
      [transcriptId, 'View Channel, Send Messages, Attach Files and Read Message History', `🔴 Meetings in <#${voiceId}> are now recorded and transcribed. Each transcript and summary will be posted in this channel.`],
    ];
    const blocked = [];
    for (const [id, wants, content] of posts) {
      const sent = await discord.postMessage(id, { content, allowedMentions: { parse: [] } });
      if (!sent.ok) {
        blocked.push(`• ${needsIn(id, wants)} (Discord said: ${sent.error})`);
        break; // stop at the first failure so nothing later is announced
      }
    }
    if (blocked.length) return `Nothing was saved. I couldn't post in every channel:\n${blocked.join('\n')}`;

    const name = typedName || tidy(voice.channel.name).slice(0, MAX_NAME) || 'Meeting';
    const saved = await saveRecordingSetup(
      db,
      { voiceChannelId: voiceId, guildId, name, transcriptChannelId: transcriptId, backupChannelId: backupId, glossary, language, createdBy: userId },
      nowSec,
    );
    if (!saved.ok) return 'That voice channel already belongs to another server, so it cannot be set up here.';
    return (
      `${saved.updated ? 'Updated' : 'Saved'} the recording setup for <#${voiceId}> (**${name}**).\n` +
      `• Transcript and summary: <#${transcriptId}>\n` +
      (backupId ? `• Audio backup: <#${backupId}>\n` : '• Audio backup: none\n') +
      `• Language: ${language}${glossary ? `\n• Glossary: ${glossary}` : ''}\n` +
      `Still to check by hand: the bot needs **View Channel** and **Connect** in <#${voiceId}> and **Change Nickname** in the server. ` +
      'Anyone can now start a recording there with `/start-recording`.'
    );
  });
}

export async function cmdRecordingSettings(ctx, o) {
  if (!hasManagePerms(ctx.interaction)) return fail(NEEDS_MANAGE);
  const { db, guildId } = ctx;
  const line = (s) =>
    `**${s.name}**: <#${s.voice_channel_id}> → <#${s.transcript_channel_id}>` +
    (s.backup_channel_id ? `, backup <#${s.backup_channel_id}>` : '') +
    `, language ${s.language}` +
    (s.glossary ? `, glossary: ${s.glossary.length > 80 ? `${s.glossary.slice(0, 77)}...` : s.glossary}` : '');
  if (o.voice_channel) {
    const s = await getRecordingSetup(db, String(o.voice_channel), guildId);
    return s ? reply(line(s), { ephemeral: true }) : fail(`<#${o.voice_channel}> has no recording setup. Create one with \`/setup-recording\`.`);
  }
  const all = await listRecordingSetups(db, guildId);
  if (!all.length) return reply('No voice channel is set up for recording yet. An admin can set one up with `/setup-recording`.', { ephemeral: true });
  // Discord rejects messages over 2000 characters, and 25 setups with long glossaries can add up to far more.
  const shown = [];
  let used = '**Recording setups**\n'.length;
  for (const s of all) {
    const text = `• ${line(s)}`;
    if (used + text.length + 1 > 1800) break;
    shown.push(text);
    used += text.length + 1;
  }
  const more = all.length - shown.length;
  const tail = more ? `\n…and ${more} more. Use the \`voice_channel\` option to see one.` : '';
  return reply(`**Recording setups**\n${shown.join('\n')}${tail}`, { ephemeral: true });
}

export async function cmdRemoveRecordingSetup(ctx, o) {
  if (!hasManagePerms(ctx.interaction)) return fail(NEEDS_MANAGE);
  const voiceId = String(o.voice_channel ?? '');
  const removed = await deleteRecordingSetup(ctx.db, voiceId, ctx.guildId);
  return removed
    ? reply(`Removed the recording setup for <#${voiceId}>. It can no longer be recorded until it is set up again. A recording already running there is not stopped (use \`/stop-recording\`).`, { ephemeral: true })
    : fail(`<#${voiceId}> has no recording setup.`);
}
