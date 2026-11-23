// /recording setup | voice-channel | list | delete. Named recording setups say where a recording's transcript, summary and "recording
// ready" link go (the Default one also carries the server's save/post switches); voice-channel (in setup-commands.js) says which
// voice channels may be recorded. Also planRecordingSetup, which /new-meeting, /update-meeting and /add-update-preset use to check and
// describe a meeting's choice.
//
// Only people with Manage Server can change setups. Every channel that is newly set is checked against Discord and gets a real
// message when the setup is saved (so a missing permission shows up now, not after a meeting), in the order private, summary, link:
// if one fails, nothing is saved and the more public channels have not been told anything.
import { fail, hasManagePerms, reply } from './replies.js';
import { NEEDS_MANAGE, TEXT_TYPES, channelProblem, cmdRecordingVoiceChannel, removeVoiceChannel, respondLater, voiceChannelLines } from './setup-commands.js';
import { getRecordingSetup, getTranscriptSettings, resolveRouting, saveTranscriptSettings } from './recording-store.js';
import {
  DEFAULT_SETUP_KEY,
  DEFAULT_SETUP_NAME,
  MAX_NAMED_SETUPS,
  MAX_SETUP_NAME,
  countNamedSetups,
  countSetupUsers,
  deleteNamedSetup,
  getDefaultSetup,
  getNamedSetup,
  isDefaultChoice,
  listNamedSetups,
  resolveNamedSetup,
  saveNamedSetup,
  sessionRouting,
} from './named-setups.js';
import { nameKey } from './store.js';
import { plainName } from './messages.js';
import { parseChannelLink } from './voice-link.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const FIELDS = [
  ['private_channel', 'private_channel_id', 'private channel (transcript)'],
  ['summary_channel', 'summary_channel_id', 'summary channel'],
  ['link_channel', 'link_channel_id', 'recording-link channel'],
];

export const ONLY_DISCORD_LOCATION =
  '`recording_setup` only applies when `location` is a Discord voice channel link (`https://discord.com/channels/…`, from "Copy Link" on the voice channel). Leave it out, or set the location to a voice channel link.';

function tidy(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127 ? ' ' : ch;
  return out.replace(/\s+/g, ' ').trim();
}

/** One setup in plain words. `def` is the Default setup, for the fields this one leaves blank. */
export function describeSetup(s, def = null) {
  const isDefault = s.name_key === DEFAULT_SETUP_KEY;
  const inherited = (field) => !isDefault && !s[field] && def?.[field];
  const ch = (field, blank) => (s[field] ? `<#${s[field]}>` : inherited(field) ? `<#${def[field]}> (from Default)` : blank);
  const privateId = s.private_channel_id || (!isDefault && def?.private_channel_id) || null;
  return [
    `**${plainName(s.name)}**${s.builtin ? ' (built in: nothing saved yet)' : ''}`,
    `• Transcript file: ${ch('private_channel_id', 'the channel where the recording is started (for a scheduled meeting: the meeting\'s channel)')}`,
    `• Summary and its link: ${ch('summary_channel_id', 'with the transcript')}`,
    `• Recording-ready link: ${ch('link_channel_id', 'not posted')}`,
    `• Audio: ${s.audio ? (privateId ? `posted in <#${privateId}>` : 'on, but there is no private channel, so it is not kept') : "not posted here (the voice channel's backup channel gets it, if it has one)"}`,
  ].join('\n');
}

const postingOffNote = (settings) =>
  settings.post ? '' : '\nNote: posting is off for the whole server (`/recording setup name:Default post:True` turns it back on), so no channel gets transcripts or summaries (the summary link goes privately to whoever started a recording).';

/** The routing a meeting in `meetingChannelId` would get with this setup, in one short phrase. */
function routeSummary(route) {
  if (!route.post) return 'posting is off for the whole server, so nothing is posted in a channel';
  const at = (id) => (id ? `<#${id}>` : 'nowhere');
  const parts = [`transcript → ${at(route.privateChannelId)}`];
  parts.push(route.summaryChannelId !== route.privateChannelId ? `summary → ${at(route.summaryChannelId)}` : 'summary with the transcript');
  if (route.linkChannelId) parts.push(`recording link → ${at(route.linkChannelId)}`);
  return parts.join(', ');
}

/**
 * Checks and describes a meeting's recording setup choice.
 *   location   the meeting's location (after this command's changes)
 *   requested  the setup name typed now or saved on the preset/meeting (undefined/blank = Default)
 *   typed      true when `requested` was typed in this command (then a non-Discord location is an error, not a note)
 *   channelId  the meeting's channel (where a recording's results go when nothing else is set)
 * Returns { ok: true, store, lines } (store: the setup name to save, or null for Default) or { ok: false, message }.
 */
export async function planRecordingSetup(ctx, { location, requested, typed = false, channelId = null }) {
  const { db, guildId, recorder } = ctx;
  const chosen = requested !== undefined && requested !== null && tidy(requested) !== '';
  const link = parseChannelLink(location);
  const lines = [];
  if (!link) {
    if (typed && chosen) return { ok: false, message: ONLY_DISCORD_LOCATION };
    if (chosen && !isDefaultChoice(requested)) {
      lines.push(`Recording setup: not used. **${plainName(tidy(requested))}** only applies when the location is a Discord voice channel link, so this meeting is not recorded.`);
    }
    return { ok: true, store: null, lines };
  }
  if (link.guildId !== guildId) {
    lines.push('Recording: off. The location links to a channel in another server, so this meeting will not be recorded.');
    return { ok: true, store: null, lines };
  }
  const { setup, fallback } = await resolveNamedSetup(db, guildId, requested);
  const store = fallback || isDefaultChoice(requested) ? null : setup.name;
  if (fallback) lines.push(`Warning: there is no recording setup called **${plainName(fallback.requested)}**, so the **${DEFAULT_SETUP_NAME}** setup will be used.`);
  const vcSetup = await getRecordingSetup(db, link.channelId, guildId);
  if (!recorder) {
    lines.push('Recording: not available (recording is not set up on this bot).');
  } else if (!vcSetup) {
    lines.push(`Recording: <#${link.channelId}> is not set up for recording, so this meeting will **not** be recorded. A server admin can allow it with \`/recording voice-channel\`.`);
  } else {
    const r = sessionRouting(setup);
    const route = resolveRouting({
      settings: await getTranscriptSettings(db, guildId),
      setup: vcSetup,
      session: { start_channel_id: channelId, private_channel_id: r.privateChannelId, summary_channel_id: r.summaryChannelId, link_channel_id: r.linkChannelId, audio_channel_id: r.audioChannelId },
    });
    lines.push(`Recording: starts automatically in <#${link.channelId}> at the meeting time, with the **${plainName(setup.name)}** recording setup (${routeSummary(route)}).`);
  }
  return { ok: true, store, lines };
}

// ---------- /recording ----------

const onOff = (v) => (v ? 'on' : 'off');

/** The server-wide save/post switches in plain words, including what each combination means. */
export function describeSettings(s) {
  const lines = [
    `• Save (whole server): **${onOff(s.save)}**. ${s.save ? 'Transcripts and summaries are kept, with a private web page (and a question box) for each.' : 'Nothing is kept: there is no web page, no question box and no link.'}`,
    `• Post (whole server): **${onOff(s.post)}**. ${s.post ? 'Transcripts and summaries are posted in the channels above.' : 'Nothing is posted in any channel, whatever a recording setup says.'}`,
  ];
  if (!s.post && s.save) {
    lines.push(
      'Because posting is off, the summary and its web link are sent in a private message to the person who started the recording. ' +
        'A recording started from a scheduled meeting has no such person, so nothing is delivered for it (it is still saved).',
    );
  }
  if (s.post && !s.save) lines.push('Because saving is off, the summary is posted in full (there is no web link to carry the rest).');
  return lines.join('\n');
}

export async function cmdRecording(ctx, sub, o) {
  if (!hasManagePerms(ctx.interaction)) return fail(NEEDS_MANAGE);
  if (sub === 'setup') return cmdRecordingSetup(ctx, o);
  if (sub === 'voice-channel') return cmdRecordingVoiceChannel(ctx, o);
  if (sub === 'list') return cmdRecordingList(ctx);
  if (sub === 'delete') return cmdRecordingDelete(ctx, o);
  return fail('Use `/recording setup`, `/recording voice-channel`, `/recording list` or `/recording delete`.');
}

async function cmdRecordingSetup(ctx, o) {
  const { db, discord, nowSec, userId, guildId } = ctx;
  const typed = tidy(o.name);
  if (!typed) return fail('Give the recording setup a name.');
  if (typed.length > MAX_SETUP_NAME) return fail(`The name is too long (max ${MAX_SETUP_NAME} characters).`);
  if (nameKey(typed) === 'none') return fail('"none" cannot be a setup name. Pick another name.');
  const isDefault = nameKey(typed) === DEFAULT_SETUP_KEY;
  const name = isDefault ? DEFAULT_SETUP_NAME : typed;

  const settingsChanging = o.save !== undefined || o.post !== undefined;
  if (settingsChanging && !isDefault) {
    return fail('`save` and `post` apply to the whole server, so they are set on the Default setup: `/recording setup name:Default save:… post:…`. Nothing was saved.');
  }
  const settings = await getTranscriptSettings(db, guildId);
  const nextSettings = { save: o.save === undefined ? settings.save : Boolean(o.save), post: o.post === undefined ? settings.post : Boolean(o.post) };
  if (!nextSettings.save && !nextSettings.post) {
    return fail('Saving and posting cannot both be off: every transcript and summary would be thrown away. Leave at least one on.');
  }

  const existing = await getNamedSetup(db, guildId, name);
  const def = await getDefaultSetup(db, guildId);
  const namedChanging = ['private_channel', 'summary_channel', 'link_channel', 'audio', 'clear'].some((k) => o[k] !== undefined);
  const settingsText = (s) => (isDefault ? `\n${describeSettings(s)}` : postingOffNote(s));
  if (!namedChanging && !settingsChanging && (existing || isDefault)) {
    return reply(describeSetup(existing ?? def, def) + settingsText(settings) + '\nChange it by adding options to this command.', { ephemeral: true });
  }
  if (!namedChanging && settingsChanging) {
    await saveTranscriptSettings(db, guildId, nextSettings, userId, nowSec);
    return reply(`Saved.\n${describeSetup(def)}\n${describeSettings(nextSettings)}`, { ephemeral: true });
  }
  if (!existing && !isDefault && (await countNamedSetups(db, guildId)) >= MAX_NAMED_SETUPS) {
    return fail(`This server already has ${MAX_NAMED_SETUPS} recording setups. Delete one with \`/recording delete name:\` first.`);
  }

  const next = {
    private_channel_id: existing?.private_channel_id ?? null,
    summary_channel_id: existing?.summary_channel_id ?? null,
    link_channel_id: existing?.link_channel_id ?? null,
    audio: existing?.audio ?? 0,
  };
  if (o.clear !== undefined) {
    const which = String(o.clear);
    const cleared = which === 'all' ? FIELDS : FIELDS.filter(([opt]) => opt === which);
    if (!cleared.length) return fail('`clear` must be private_channel, summary_channel, link_channel or all.');
    for (const [opt, col] of cleared) {
      if (o[opt] !== undefined) return fail(`Pick either \`${opt}\` or \`clear:${which}\`, not both.`);
      next[col] = null;
    }
  }
  const fresh = []; // [option, column, id] for channels that are new or changed: these are checked and get a message
  for (const [opt, col] of FIELDS) {
    if (o[opt] === undefined) continue;
    const id = String(o[opt]);
    if (!SNOWFLAKE_RE.test(id)) return fail('One of the channels is not valid. Pick it from the list Discord shows.');
    if (id !== existing?.[col]) fresh.push([opt, col, id]);
    next[col] = id;
  }
  if (o.audio !== undefined) next.audio = o.audio ? 1 : 0;
  // Audio is private: it only ever goes to a channel an admin named as private (this setup's, or the Default's it inherits).
  const effectivePrivate = next.private_channel_id || (!isDefault && def.private_channel_id) || null;
  if (next.audio && !effectivePrivate) {
    return fail('`audio:True` needs a private channel: audio is only ever posted in a channel named as private. Add `private_channel`.');
  }

  const save = async (warnings = []) => {
    const r = await saveNamedSetup(
      db,
      { guildId, name, privateChannelId: next.private_channel_id, summaryChannelId: next.summary_channel_id, linkChannelId: next.link_channel_id, audio: next.audio, createdBy: userId },
      nowSec,
    );
    if (settingsChanging) await saveTranscriptSettings(db, guildId, nextSettings, userId, nowSec);
    const saved = { ...next, name, name_key: nameKey(name) };
    const use = isDefault
      ? '`/start-recording` and meetings that pick no recording setup (or one that no longer exists) use this one.'
      : `Pick it for a meeting with \`recording_setup:${name}\` on \`/new-meeting\` (the location must be a Discord voice channel link). Blank channels come from the Default setup.`;
    return `${r.updated ? 'Updated' : 'Saved'} the recording setup.\n${describeSetup(saved, isDefault ? null : def)}${warnings.map((w) => `\nWarning: ${w}`).join('')}${settingsText(nextSettings)}\n${use}`;
  };
  if (!fresh.length) return reply(await save(), { ephemeral: true });

  return respondLater(ctx, async () => {
    const got = await Promise.all(fresh.map(([, , id]) => discord.getChannel(id)));
    const problems = fresh.map(([, col, id], i) => channelProblem(id, got[i], { types: TEXT_TYPES, label: 'text channel' }, guildId)).filter(Boolean);
    if (problems.length) return `Nothing was saved.\n${problems.map((p) => `• ${p}`).join('\n')}`;
    const warnings = [];
    fresh.forEach(([opt, , id], i) => {
      if (opt === 'private_channel' && !got[i].channel.hiddenFromEveryone) {
        warnings.push(`<#${id}> does not hide itself from @everyone, so it may not be private. Transcripts${next.audio ? ' and audio' : ''} will be posted there.`);
      }
    });
    // Prove the bot can post in each new channel. Private first, the most public last: if one fails, nothing is saved.
    const announce = {
      private_channel: [`View Channel, Send Messages, Attach Files and Read Message History`, `Transcripts${next.audio ? ' and audio' : ''} of meetings that use the **${plainName(name)}** recording setup will be posted in this channel.`],
      summary_channel: ['View Channel and Send Messages', `Summaries of meetings that use the **${plainName(name)}** recording setup will be posted in this channel.`],
      link_channel: ['View Channel and Send Messages', `A link will be posted here when a recording of a meeting that uses the **${plainName(name)}** recording setup is ready (only people who can see its transcript channel can open it).`],
    };
    const order = ['private_channel', 'summary_channel', 'link_channel'];
    for (const [opt, , id] of [...fresh].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))) {
      const [wants, content] = announce[opt];
      const sent = await discord.postMessage(id, { content, allowedMentions: { parse: [] } });
      if (!sent.ok) return `Nothing was saved. I couldn't post in every channel:\n• <#${id}>: I need ${wants}. (Discord said: ${sent.error})`;
    }
    return save(warnings);
  });
}

// Discord rejects messages over 2000 characters: the setups get most of the room, the voice channels the rest.
const LIST_SETUPS_BUDGET = 1150;
const LIST_TOTAL_BUDGET = 1850;

async function cmdRecordingList(ctx) {
  const { db, guildId } = ctx;
  const all = await listNamedSetups(db, guildId);
  const def = all.find((s) => s.name_key === DEFAULT_SETUP_KEY) ?? (await getDefaultSetup(db, guildId));
  const others = all.filter((s) => s.name_key !== DEFAULT_SETUP_KEY);
  const settings = await getTranscriptSettings(db, guildId);
  const blocks = [describeSetup(def), ...others.map((s) => describeSetup(s, def))];
  const shown = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.length + 2 > LIST_SETUPS_BUDGET) break;
    shown.push(b);
    used += b.length + 2;
  }
  const more = blocks.length - shown.length;
  const setupsPart =
    `**Recording setups**\n${shown.join('\n\n')}` +
    (more ? `\n…and ${more} more. Use \`/recording setup name:<name>\` to see one.` : '') +
    (others.length ? '' : '\nNo named setups yet: every recording uses the Default. Add one with `/recording setup`.');
  const settingsPart = `\n\n**Whole server** (change on \`/recording setup name:Default\`): save **${onOff(settings.save)}**, post **${onOff(settings.post)}**.`;
  const vc = await voiceChannelLines(db, guildId, Math.max(200, LIST_TOTAL_BUDGET - setupsPart.length - settingsPart.length - 60));
  const vcPart = vc.total
    ? `\n\n**Voice channels that may be recorded**\n${vc.shown.join('\n')}` + (vc.more ? `\n…and ${vc.more} more. Use \`/recording voice-channel voice_channel:<channel>\` to see one.` : '')
    : '\n\n**Voice channels that may be recorded**\nNone yet. Allow one with `/recording voice-channel`.';
  return reply(setupsPart + settingsPart + vcPart, { ephemeral: true });
}

async function cmdRecordingDelete(ctx, o) {
  const { db, guildId } = ctx;
  const hasName = o.name !== undefined && tidy(o.name) !== '';
  const hasVoice = o.voice_channel !== undefined;
  if (hasName === hasVoice) {
    return fail('Give one of these: `name` (a recording setup to delete) or `voice_channel` (a voice channel that may no longer be recorded).');
  }
  if (hasVoice) return removeVoiceChannel(ctx, o.voice_channel);
  const name = tidy(o.name);
  const s = await getNamedSetup(db, guildId, name);
  if (!s) {
    return fail(isDefaultChoice(name) ? 'The Default setup has nothing saved, so there is nothing to delete.' : `There is no recording setup called **${plainName(name)}**. See \`/recording list\`.`);
  }
  await deleteNamedSetup(db, guildId, s.name);
  if (s.name_key === DEFAULT_SETUP_KEY) {
    return reply('Deleted the saved Default setup. Recordings that use the Default now go to the channel where they are started (the save and post switches are kept).', { ephemeral: true });
  }
  const users = await countSetupUsers(db, guildId, s.name);
  const who = users.meetings || users.presets
    ? ` ${users.meetings} scheduled meeting(s) and ${users.presets} preset(s) still name it: they will use the **Default** setup instead, and each meeting's start message will say so.`
    : '';
  return reply(`Deleted the recording setup **${plainName(s.name)}**.${who}`, { ephemeral: true });
}
